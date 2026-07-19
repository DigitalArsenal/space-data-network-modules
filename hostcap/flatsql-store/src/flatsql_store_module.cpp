/*
 * hostcap/flatsql-store (SDN OD-Flow WRITE lane — the in-wasm FlatSQL store).
 *
 * The composed-WASM store terminal for the supplemental-OMM OD flow. It replaces
 * the repudiated Go storage sink (storage.ingest_with_source -> sdnstore.Store,
 * which did SDS type derivation + record decode + per-record store IN GO). Here
 * every store decision happens IN WASM: the node reads the fitted result frames,
 * derives the SDS type from each record's FlatBuffer file_identifier in C++, and
 * INSERTs per-record into the FlatSQL engine over the flow-runtime's linked-engine
 * interface (flow_runtime.cpp SDN_FLATSQL_LINKED: the flatsql engine is a separate
 * wasm instance imported via import_module("flatsql"), driven under the held lock;
 * the engine's DB persists through the host's generic filesystem connector — NOT
 * a Go store). No Go orchestration, no SDS-aware Go decode, no per-record Go loop.
 *
 * INPUT PORTS (by construction carry ONLY $OMM/$OCM/$OBD — NEVER $OEM; the flow's
 * $OEM is transient and never reaches here, and a mis-wired $OEM record's file id
 * "$OEM" matches no table and is skipped):
 *   "records" : 1..N size-prefixed SDS records ($OMM/$OCM/$OBD, aligned-binary).
 *   "config"  : OPTIONAL provenance from node CONFIG (aligned binary, no JSON):
 *               [u32le provider_len][provider][u32le source_name_len][source_name]
 *               [u32le batch_id_len][batch_id]. Absent => NULL provenance columns.
 * OUTPUT:
 *   "result"  : a 4-byte little-endian inserted-count (aligned-binary), for
 *               downstream chaining / run telemetry.
 *
 * FlatBuffers/aligned-binary only, no JSON at any data hop. No caps: every record
 * on the port is stored.
 */

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"

// ── The FlatSQL store trampoline (single minimal import) ──────────────────────
// The FlatSQL engine is a SEPARATE flatsqlrt runtime — NOT linked into this
// module. The composition spike proved the host trampoline reads the statement
// envelope DIRECTLY from THIS module's (the reactor's) shared memory via the
// calling frame and marshals it into the engine's high-level API — so this node
// needs NO engine-memory-crossing (no malloc/poke/peek into engine memory) and
// NO Go-side type/table derivation. ALL record semantics stay in wasm here (per-
// SDS-type table from the file_identifier, provenance columns, the typed INSERT
// SQL + params); the host stays a pure byte-mover. No sdm_host_call (no Go sink),
// no fs calls (the engine persists via opaque ExportData snapshots — not this
// node's concern).
//
// IMPORT SURFACE (declared for the deploy node — the ONLY trampoline to wire):
//   module "flatsql", name "exec_envelope":
//     int64_t exec_envelope(uint32_t env_ptr, uint32_t env_len)
//   env_ptr/env_len point into THIS module's memory. The envelope is one SQL
//   statement + its bound params, aligned-binary (no JSON):
//     [u32le sql_len][sql_len bytes UTF-8 SQL]
//     [u32le param_count]
//     param_count x TLV param: [u8 tag][u32le size][size bytes]
//       tag: 4 = TEXT (UTF-8), 5 = BYTES (BLOB)  (== flatsql_capi ParamTag)
//   The host executes it on the flow's linked FlatSQL DB via the engine's
//   QueryRawFlatBufferStream and returns: >= 0 rows affected on success, < 0 on
//   error. The store peeks NOTHING back except this scalar.
extern "C" __attribute__((import_module("flatsql"), import_name("exec_envelope")))
int64_t flatsql_exec_envelope(uint32_t env_ptr, uint32_t env_len);

namespace {

// ── minimal SHA-256 + CIDv1(raw, sha2-256) for the record content id ──────────
// Byte-identical to the CID the store's read side / PNMs reference
// (common/provider_source.hpp::cid_v1_raw_sha256), inlined to avoid the SDK
// keyslot dependency in this thin store TU.
void sha256_raw(const uint8_t* data, size_t len, uint8_t out[32]) {
  static const uint32_t K[64] = {
      0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
      0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
      0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
      0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
      0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
      0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
      0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
      0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u};
  uint32_t h[8] = {0x6a09e667u,0xbb67ae85u,0x3c6ef372u,0xa54ff53au,0x510e527fu,0x9b05688cu,0x1f83d9abu,0x5be0cd19u};
  std::vector<uint8_t> msg(data, data + len);
  uint64_t bl = static_cast<uint64_t>(len) * 8u;
  msg.push_back(0x80);
  while (msg.size() % 64 != 56) msg.push_back(0);
  for (int i = 7; i >= 0; --i) msg.push_back(static_cast<uint8_t>((bl >> (i * 8)) & 0xff));
  auto rotr = [](uint32_t x, uint32_t n) { return (x >> n) | (x << (32 - n)); };
  for (size_t off = 0; off < msg.size(); off += 64) {
    uint32_t w[64];
    for (int i = 0; i < 16; ++i)
      w[i] = (uint32_t(msg[off+i*4])<<24)|(uint32_t(msg[off+i*4+1])<<16)|(uint32_t(msg[off+i*4+2])<<8)|uint32_t(msg[off+i*4+3]);
    for (int i = 16; i < 64; ++i) {
      uint32_t s0 = rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>3);
      uint32_t s1 = rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>10);
      w[i] = w[i-16]+s0+w[i-7]+s1;
    }
    uint32_t a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
    for (int i = 0; i < 64; ++i) {
      uint32_t S1=rotr(e,6)^rotr(e,11)^rotr(e,25), ch=(e&f)^(~e&g);
      uint32_t t1=hh+S1+ch+K[i]+w[i];
      uint32_t S0=rotr(a,2)^rotr(a,13)^rotr(a,22), maj=(a&b)^(a&c)^(b&c);
      uint32_t t2=S0+maj;
      hh=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2;
    }
    h[0]+=a;h[1]+=b;h[2]+=c;h[3]+=d;h[4]+=e;h[5]+=f;h[6]+=g;h[7]+=hh;
  }
  for (int i = 0; i < 8; ++i) {
    out[i*4]=uint8_t((h[i]>>24)&0xff); out[i*4+1]=uint8_t((h[i]>>16)&0xff);
    out[i*4+2]=uint8_t((h[i]>>8)&0xff); out[i*4+3]=uint8_t(h[i]&0xff);
  }
}

std::string base32_lower_nopad(const uint8_t* data, size_t len) {
  static const char* alpha = "abcdefghijklmnopqrstuvwxyz234567";
  std::string out;
  int buffer = 0, bits = 0;
  for (size_t i = 0; i < len; ++i) {
    buffer = (buffer << 8) | data[i];
    bits += 8;
    while (bits >= 5) { bits -= 5; out.push_back(alpha[(buffer >> bits) & 0x1f]); }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out.push_back(alpha[(buffer << (5 - bits)) & 0x1f]);
  return out;
}

std::string cid_v1_raw_sha256(const uint8_t* data, size_t len) {
  uint8_t digest[32];
  sha256_raw(data, len, digest);
  uint8_t frame[36] = {0x01, 0x55, 0x12, 0x20};
  for (int i = 0; i < 32; ++i) frame[4 + i] = digest[i];
  return std::string("b") + base32_lower_nopad(frame, sizeof(frame));
}

// ── param TLV (matches flatsql_capi.cpp decodeParamsNoThrow) ───────────────────
void tlv_u32(std::vector<uint8_t>& t, uint32_t n) {
  t.push_back(n & 0xff); t.push_back((n >> 8) & 0xff); t.push_back((n >> 16) & 0xff); t.push_back((n >> 24) & 0xff);
}
void tlv_string(std::vector<uint8_t>& t, const std::string& s) {
  t.push_back(4 /*PARAM_STRING*/); tlv_u32(t, static_cast<uint32_t>(s.size())); t.insert(t.end(), s.begin(), s.end());
}
void tlv_bytes(std::vector<uint8_t>& t, const uint8_t* p, uint32_t n) {
  t.push_back(5 /*PARAM_BYTES*/); tlv_u32(t, n); t.insert(t.end(), p, p + n);
}

uint32_t rd_u32le(const uint8_t* p) {
  return uint32_t(p[0]) | (uint32_t(p[1]) << 8) | (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24);
}

// Map the SDS file_identifier at record[8..12] (size-prefixed FlatBuffer) to its
// per-SDS-type table. $OEM (or anything else) => nullptr => skipped, so ephemeris
// is structurally unstorable even if mis-wired.
const char* table_for_record(const uint8_t* rec, uint32_t len) {
  if (len < 12) return nullptr;
  if (std::memcmp(rec + 8, "$OMM", 4) == 0) return "sds_omm";
  if (std::memcmp(rec + 8, "$OCM", 4) == 0) return "sds_ocm";
  if (std::memcmp(rec + 8, "$OBD", 4) == 0) return "sds_obd";
  return nullptr;
}

// Build the aligned-binary statement envelope ([u32 sql_len][sql][u32
// param_count][params TLV]) in THIS module's memory and execute it via the single
// host trampoline. Returns rows affected (>= 0) or a negative engine/host error.
int64_t run_sql(const std::string& sql, const std::vector<uint8_t>& params_tlv,
                uint32_t param_count) {
  std::vector<uint8_t> env;
  env.reserve(4 + sql.size() + 4 + params_tlv.size());
  tlv_u32(env, static_cast<uint32_t>(sql.size()));
  env.insert(env.end(), sql.begin(), sql.end());
  tlv_u32(env, param_count);
  env.insert(env.end(), params_tlv.begin(), params_tlv.end());
  return flatsql_exec_envelope(static_cast<uint32_t>(reinterpret_cast<uintptr_t>(env.data())),
                               static_cast<uint32_t>(env.size()));
}

struct Provenance { std::string provider, source_name, batch_id; };

Provenance read_provenance() {
  Provenance p;
  const int32_t ci = plugin_find_input_index("config", 0);
  if (ci < 0) return p;
  const plugin_input_frame_t* f = plugin_get_input_frame(static_cast<uint32_t>(ci));
  if (!f || !f->payload || f->payload_length < 4) return p;
  const uint8_t* d = f->payload;
  uint32_t n = f->payload_length, off = 0;
  auto take = [&](std::string& dst) {
    if (off + 4 > n) return;
    uint32_t l = rd_u32le(d + off); off += 4;
    if (off + l > n) { off = n; return; }
    dst.assign(reinterpret_cast<const char*>(d + off), l); off += l;
  };
  take(p.provider); take(p.source_name); take(p.batch_id);
  return p;
}

}  // namespace

extern "C" {

int store(void) {
  plugin_reset_output_state();

  const Provenance prov = read_provenance();

  // Per-SDS-type tables (idempotent). Content-addressed PK => re-store is a no-op.
  // A negative return on the first DDL means the engine trampoline is unavailable
  // (bake/load did not wire the flatsql.exec_envelope trampoline / flow DB).
  static const char* const kCreate[3] = {
      "CREATE TABLE IF NOT EXISTS sds_omm (cid TEXT PRIMARY KEY, provider TEXT, source_name TEXT, batch_id TEXT, data BLOB)",
      "CREATE TABLE IF NOT EXISTS sds_ocm (cid TEXT PRIMARY KEY, provider TEXT, source_name TEXT, batch_id TEXT, data BLOB)",
      "CREATE TABLE IF NOT EXISTS sds_obd (cid TEXT PRIMARY KEY, provider TEXT, source_name TEXT, batch_id TEXT, data BLOB)"};
  for (int i = 0; i < 3; ++i) {
    std::vector<uint8_t> none;
    if (run_sql(kCreate[i], none, 0) < 0) {
      plugin_set_error("flatsql-ddl-failed",
                       "CREATE TABLE via flatsql.exec_envelope failed (engine trampoline "
                       "unavailable or DDL error).");
      return 2;
    }
  }

  uint32_t inserted = 0;
  for (uint32_t ordinal = 0;; ++ordinal) {
    const int32_t idx = plugin_find_input_index("records", ordinal);
    if (idx < 0) break;
    const plugin_input_frame_t* f = plugin_get_input_frame(static_cast<uint32_t>(idx));
    if (!f || !f->payload || f->payload_length == 0) continue;

    const char* table = table_for_record(f->payload, f->payload_length);
    if (table == nullptr) continue;  // not $OMM/$OCM/$OBD ($OEM never stored) — skip

    const std::string cid = cid_v1_raw_sha256(f->payload, f->payload_length);

    std::string sql = std::string("INSERT OR IGNORE INTO ") + table +
                      " (cid, provider, source_name, batch_id, data) VALUES (?,?,?,?,?)";
    std::vector<uint8_t> tlv;
    tlv_string(tlv, cid);
    tlv_string(tlv, prov.provider);
    tlv_string(tlv, prov.source_name);
    tlv_string(tlv, prov.batch_id);
    tlv_bytes(tlv, f->payload, f->payload_length);
    if (run_sql(sql, tlv, 5) < 0) {
      plugin_set_error("flatsql-insert-failed",
                       "INSERT via flatsql.exec_envelope failed.");
      return 3;
    }
    ++inserted;
  }

  uint8_t count_le[4];
  count_le[0] = inserted & 0xff; count_le[1] = (inserted >> 8) & 0xff;
  count_le[2] = (inserted >> 16) & 0xff; count_le[3] = (inserted >> 24) & 0xff;
  const int32_t pushed = plugin_push_output_ex(
      "result", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 4,
      count_le, 4);
  return pushed < 0 ? 4 : 0;
}

}  // extern "C"
