/*
 * hostcap/flatsql-store (SDN OD-Flow WRITE lane — the in-wasm FlatSQL store).
 *
 * The composed-WASM store terminal for the supplemental-OMM OD flow. It replaces
 * the repudiated Go storage sink (storage.ingest_with_source -> sdnstore.Store,
 * which did SDS type derivation + record decode + per-record store IN GO). Every
 * store decision happens IN WASM.
 *
 * PERSISTENCE MODEL (empirically pinned by the deploy leg): FlatSQL's ONLY
 * persistable substrate is the FlatBuffer ARENA, populated via flatsql ingest.
 * The schema-declared tables (sds_omm/sds_ocm/sds_obd) are READ-ONLY vtabs over
 * that arena — a SQL INSERT into them errors ("may not be modified") and native
 * CREATE TABLE rows never reach ExportData (0-byte snapshots). So the store
 * TERMINAL is an ARENA INGEST, not a SQL INSERT:
 *   1. Per record, build a wrapper FlatBuffer matching the kubo-declared table
 *        table sds_<t> { cid:string(key); provider:string; source_name:string;
 *                        batch_id:string; data:[ubyte]; }
 *      (data = the raw $OMM/$OCM/$OBD record bytes; provenance from the config
 *      port), stamped with a STORE-LOCAL file_identifier SOMM/SOCM/SOBD (distinct
 *      from the real SDS ids so a raw record can never be mis-routed as a
 *      wrapper), and ingest it via flatsql.ingest_record.
 *   2. DEDUP is in-wasm (the arena index is PRIMARY KEY(key,sequence) and does
 *      NOT reject duplicate ingests): before ingesting, pre-check with a READ-ONLY
 *      SELECT COUNT(*) over the vtab via flatsql.exec_envelope and skip when the
 *      cid is already present — preserving INSERT-OR-IGNORE (content-addressed)
 *      semantics exactly.
 *
 * ALL record semantics (per-SDS-type routing from the file_identifier, CID,
 * wrapper build, provenance) stay in C++. The two host trampolines are pure
 * byte-movers over THIS module's memory. No sdm_host_call (no Go sink), no
 * storage.* hostcalls, no fs calls (the engine snapshots the arena via opaque
 * ExportData through the host fs connector — not this node's concern).
 *
 * INPUT PORTS (carry ONLY $OMM/$OCM/$OBD — NEVER $OEM):
 *   "records" : 1..N size-prefixed SDS records ($OMM/$OCM/$OBD, aligned-binary).
 *   "config"  : OPTIONAL provenance (aligned binary, no JSON):
 *               [u32le provider_len][provider][u32le source_name_len][source_name]
 *               [u32le batch_id_len][batch_id]. Absent => empty provenance.
 * OUTPUT:
 *   "result"  : 4-byte little-endian ingested-count (aligned-binary).
 */

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "flatbuffers/flatbuffers.h"
#include "space_data_module_invoke.h"

// ── FlatSQL host trampolines (host-provided at LOAD; declared for the deploy
// node's bake+load+$PLG — pointers are into THIS module's memory, the host is a
// dumb byte-mover, NO engine-memory-crossing). The FlatSQL engine is a SEPARATE
// flatsqlrt runtime — NOT linked into this module.
//
//   module "flatsql", name "ingest_record":
//     int64_t ingest_record(uint32_t buf_ptr, uint32_t buf_len)
//       Ingest one wrapper FlatBuffer (buf_ptr/buf_len in this module's memory)
//       into the flow's linked FlatSQL arena. >= 0 ok, < 0 error. THIS is the
//       persistable path (arena -> ExportData). The buffer's file_identifier
//       (SOMM/SOCM/SOBD) selects the target arena table.
//
//   module "flatsql", name "exec_envelope":
//     int64_t exec_envelope(uint32_t env_ptr, uint32_t env_len)
//       Execute one statement envelope (this module's memory) on the flow's
//       linked DB. Envelope (aligned-binary, no JSON):
//         [u32le sql_len][sql bytes][u32le param_count]
//         param_count x [u8 tag][u32le size][bytes]  (tag 4=TEXT, 5=BYTES)
//       DEDUP CONTRACT: for the scalar `SELECT COUNT(*) ... WHERE cid = ?`
//       read-only query over the arena vtab, the host returns the COUNT scalar
//       (>= 0). This node treats > 0 as "already stored" and skips the ingest.
//       (For DML the same call would return rows-affected; here it is used only
//       for the read-only COUNT pre-check.)
extern "C" {
__attribute__((import_module("flatsql"), import_name("ingest_record")))
int64_t flatsql_ingest_record(uint32_t buf_ptr, uint32_t buf_len);
__attribute__((import_module("flatsql"), import_name("exec_envelope")))
int64_t flatsql_exec_envelope(uint32_t env_ptr, uint32_t env_len);
}

namespace {

// ── minimal SHA-256 + CIDv1(raw, sha2-256) for the record content id ──────────
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

// ── statement-envelope TLV (matches flatsql_capi.cpp decodeParamsNoThrow) ─────
void tlv_u32(std::vector<uint8_t>& t, uint32_t n) {
  t.push_back(n & 0xff); t.push_back((n >> 8) & 0xff); t.push_back((n >> 16) & 0xff); t.push_back((n >> 24) & 0xff);
}
void tlv_string(std::vector<uint8_t>& t, const std::string& s) {
  t.push_back(4 /*PARAM_STRING*/); tlv_u32(t, static_cast<uint32_t>(s.size())); t.insert(t.end(), s.begin(), s.end());
}

uint32_t rd_u32le(const uint8_t* p) {
  return uint32_t(p[0]) | (uint32_t(p[1]) << 8) | (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24);
}

// Route the record by its SDS file_identifier at rec[8..12] (size-prefixed
// FlatBuffer). table = the arena vtab to dedup-query; wrapper_fid = the
// store-local wrapper file_identifier to ingest. $OEM / anything else => skipped.
struct Route { const char* table; const char* wrapper_fid; };
Route route_for_record(const uint8_t* rec, uint32_t len) {
  if (len < 12) return {nullptr, nullptr};
  if (std::memcmp(rec + 8, "$OMM", 4) == 0) return {"sds_omm", "SOMM"};
  if (std::memcmp(rec + 8, "$OCM", 4) == 0) return {"sds_ocm", "SOCM"};
  if (std::memcmp(rec + 8, "$OBD", 4) == 0) return {"sds_obd", "SOBD"};
  return {nullptr, nullptr};
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

// Build the wrapper FlatBuffer for the kubo-declared table. Field order (and thus
// vtable slot -> voffset) MUST match the schema EXACTLY:
//   0 cid (key)  voffset 4 ; 1 provider  6 ; 2 source_name  8 ;
//   3 batch_id   10        ; 4 data ([ubyte])  12
// Stamped with the store-local file_identifier (SOMM/SOCM/SOBD).
std::vector<uint8_t> build_wrapper_fb(const char* file_id, const std::string& cid,
                                      const Provenance& prov, const uint8_t* data, uint32_t data_len) {
  flatbuffers::FlatBufferBuilder fbb(data_len + 256);
  auto cid_o = fbb.CreateString(cid);
  auto provider_o = fbb.CreateString(prov.provider);
  auto source_o = fbb.CreateString(prov.source_name);
  auto batch_o = fbb.CreateString(prov.batch_id);
  auto data_o = fbb.CreateVector(data, static_cast<size_t>(data_len));  // [ubyte]
  const flatbuffers::uoffset_t start = fbb.StartTable();
  fbb.AddOffset(4, cid_o);        // cid (key)
  fbb.AddOffset(6, provider_o);   // provider
  fbb.AddOffset(8, source_o);     // source_name
  fbb.AddOffset(10, batch_o);     // batch_id
  fbb.AddOffset(12, data_o);      // data
  const flatbuffers::uoffset_t table = fbb.EndTable(start);
  fbb.Finish(flatbuffers::Offset<void>(table), file_id);
  const uint8_t* p = fbb.GetBufferPointer();
  return std::vector<uint8_t>(p, p + fbb.GetSize());
}

// Read-only dedup pre-check: COUNT the cid in the arena vtab. Returns >0 when
// already stored, 0 when absent, <0 on engine/host error.
int64_t cid_present(const char* table, const std::string& cid) {
  std::string sql = std::string("SELECT COUNT(*) FROM ") + table + " WHERE cid = ?";
  std::vector<uint8_t> params;
  tlv_string(params, cid);
  std::vector<uint8_t> env;
  tlv_u32(env, static_cast<uint32_t>(sql.size()));
  env.insert(env.end(), sql.begin(), sql.end());
  tlv_u32(env, 1);  // param_count
  env.insert(env.end(), params.begin(), params.end());
  return flatsql_exec_envelope(static_cast<uint32_t>(reinterpret_cast<uintptr_t>(env.data())),
                               static_cast<uint32_t>(env.size()));
}

}  // namespace

extern "C" {

int store(void) {
  plugin_reset_output_state();

  const Provenance prov = read_provenance();

  uint32_t ingested = 0;
  for (uint32_t ordinal = 0;; ++ordinal) {
    const int32_t idx = plugin_find_input_index("records", ordinal);
    if (idx < 0) break;
    const plugin_input_frame_t* f = plugin_get_input_frame(static_cast<uint32_t>(idx));
    if (!f || !f->payload || f->payload_length == 0) continue;

    const Route r = route_for_record(f->payload, f->payload_length);
    if (r.table == nullptr) continue;  // not $OMM/$OCM/$OBD ($OEM never stored) — skip

    const std::string cid = cid_v1_raw_sha256(f->payload, f->payload_length);

    const int64_t present = cid_present(r.table, cid);
    if (present < 0) {
      plugin_set_error("flatsql-dedup-failed",
                       "cid dedup SELECT via flatsql.exec_envelope failed (engine "
                       "trampoline unavailable or query error).");
      return 2;
    }
    if (present > 0) continue;  // content-addressed dedup: already stored (INSERT OR IGNORE)

    const std::vector<uint8_t> wrapper =
        build_wrapper_fb(r.wrapper_fid, cid, prov, f->payload, f->payload_length);
    const int64_t rc = flatsql_ingest_record(
        static_cast<uint32_t>(reinterpret_cast<uintptr_t>(wrapper.data())),
        static_cast<uint32_t>(wrapper.size()));
    if (rc < 0) {
      plugin_set_error("flatsql-ingest-failed",
                       "arena ingest via flatsql.ingest_record failed.");
      return 3;
    }
    ++ingested;
  }

  uint8_t count_le[4];
  count_le[0] = ingested & 0xff; count_le[1] = (ingested >> 8) & 0xff;
  count_le[2] = (ingested >> 16) & 0xff; count_le[3] = (ingested >> 24) & 0xff;
  const int32_t pushed = plugin_push_output_ex(
      "result", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 4,
      count_le, 4);
  return pushed < 0 ? 4 : 0;
}

}  // extern "C"
