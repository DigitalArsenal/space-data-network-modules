/*
 * hostcap/flatsql-store (SDN OD-Flow WRITE lane — the in-wasm FlatSQL store).
 *
 * The composed-WASM store terminal for the supplemental-OMM OD flow. Every store
 * decision happens IN WASM; the host is a byte-mover (no Go sink).
 *
 * PERSISTENCE: FlatSQL's only persistable substrate is the FlatBuffer ARENA (via
 * flatsql ingest); schema-declared tables are read-only vtabs. So per record: derive
 * the per-SDS-type route from the file_identifier at rec+8 ($OMM/$OCM/$OBD ->
 * sds_omm/sds_ocm/sds_obd + wrapper id SOMM/SOCM/SOBD), compute CIDv1, build a
 * wrapper FlatBuffer and INGEST it (flatsql.ingest_record). Content-addressed dedup
 * is a read-only SELECT COUNT via flatsql.exec_envelope.
 *
 * PER-PROVIDER ATTRIBUTION: the OD node emits, per record, a CID-KEYED PROVENANCE
 * SIDECAR on the "provenance" input port:
 *   [u32le cid_len][cid][u32le provider_len][provider][u32le source_name_len][source_name]
 * This node maps cid -> {provider, source_name} (order-independent, no SDS parsing)
 * and writes those columns for the matching record; absent -> node CONFIG fallback.
 *
 * PULLED_AT: an OPTIONAL "trigger" input frame carries the fire wall-clock time
 * ([u64le unix_ms]) — host-supplied trigger metadata (a capability read, not
 * orchestration; the store has no clock). Written into the wrapper's pulled_at.
 *
 * INPUT PORTS ($OMM/$OCM/$OBD only — NEVER $OEM):
 *   "records"    : 1..N size-prefixed SDS records (aligned-binary).
 *   "provenance" : 0..N cid-keyed provenance frames (see above).
 *   "config"     : OPTIONAL default provenance [u32 provider][u32 source_name][u32 batch_id].
 *   "trigger"    : OPTIONAL [u64le unix_ms] fire timestamp.
 * OUTPUT "result": 4-byte little-endian ingested-count (aligned-binary).
 */

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include "flatbuffers/flatbuffers.h"
#include "sds_cid.hpp"
#include "space_data_module_invoke.h"

// The FlatSQL host trampolines (byte-movers over THIS module's memory; the engine
// is a SEPARATE flatsqlrt runtime). Declared for the deploy node's bake+load+$PLG:
//   module "flatsql", name "ingest_record": int64_t(u32 buf_ptr, u32 buf_len)
//     Ingest one wrapper FlatBuffer into the arena. >=0 ok, <0 err. The wrapper's
//     file_identifier (SOMM/SOCM/SOBD) selects the arena table.
//   module "flatsql", name "exec_envelope":  int64_t(u32 env_ptr, u32 env_len)
//     Execute one statement envelope [u32 sql_len][sql][u32 param_count][TLV...]
//     (tag 4=TEXT, 5=BYTES). For the read-only `SELECT COUNT(*) WHERE cid=?`
//     dedup, returns the COUNT scalar (>0 => already stored, skip).
extern "C" {
__attribute__((import_module("flatsql"), import_name("ingest_record")))
int64_t flatsql_ingest_record(uint32_t buf_ptr, uint32_t buf_len);
__attribute__((import_module("flatsql"), import_name("exec_envelope")))
int64_t flatsql_exec_envelope(uint32_t env_ptr, uint32_t env_len);
}

namespace {

using sdn_cid::cid_v1_raw_sha256;

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
uint64_t rd_u64le(const uint8_t* p) {
  uint64_t v = 0;
  for (int i = 0; i < 8; ++i) v |= uint64_t(p[i]) << (8 * i);
  return v;
}

struct Route { const char* table; const char* wrapper_fid; };
Route route_for_record(const uint8_t* rec, uint32_t len) {
  if (len < 12) return {nullptr, nullptr};
  if (std::memcmp(rec + 8, "$OMM", 4) == 0) return {"sds_omm", "SOMM"};
  if (std::memcmp(rec + 8, "$OCM", 4) == 0) return {"sds_ocm", "SOCM"};
  if (std::memcmp(rec + 8, "$OBD", 4) == 0) return {"sds_obd", "SOBD"};
  return {nullptr, nullptr};
}

struct Provenance { std::string provider, source_name, batch_id; };

// Default provenance (fallback) from the "config" port.
Provenance read_config_provenance() {
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

// CID-keyed provenance map from the "provenance" port frames.
std::map<std::string, std::pair<std::string, std::string>> read_provenance_map() {
  std::map<std::string, std::pair<std::string, std::string>> m;
  for (uint32_t ordinal = 0;; ++ordinal) {
    const int32_t idx = plugin_find_input_index("provenance", ordinal);
    if (idx < 0) break;
    const plugin_input_frame_t* f = plugin_get_input_frame(static_cast<uint32_t>(idx));
    if (!f || !f->payload || f->payload_length < 12) continue;
    const uint8_t* d = f->payload;
    uint32_t n = f->payload_length, off = 0;
    std::string cid, provider, source;
    auto take = [&](std::string& dst) -> bool {
      if (off + 4 > n) return false;
      uint32_t l = rd_u32le(d + off); off += 4;
      if (off + l > n) return false;
      dst.assign(reinterpret_cast<const char*>(d + off), l); off += l;
      return true;
    };
    if (take(cid) && take(provider) && take(source) && !cid.empty()) {
      m[cid] = {provider, source};
    }
  }
  return m;
}

// Optional fire timestamp (unix ms) from the "trigger" port (host trigger metadata).
uint64_t read_pulled_at() {
  const int32_t ti = plugin_find_input_index("trigger", 0);
  if (ti < 0) return 0;
  const plugin_input_frame_t* f = plugin_get_input_frame(static_cast<uint32_t>(ti));
  if (!f || !f->payload || f->payload_length < 8) return 0;
  return rd_u64le(f->payload);
}

// Wrapper FlatBuffer for the kubo-declared table. Field order == schema (voffset):
//   0 cid(key) 4 ; 1 provider 6 ; 2 source_name 8 ; 3 batch_id 10 ; 4 data 12 ;
//   5 pulled_at:long 14
std::vector<uint8_t> build_wrapper_fb(const char* file_id, const std::string& cid,
                                      const std::string& provider, const std::string& source_name,
                                      const std::string& batch_id, uint64_t pulled_at,
                                      const uint8_t* data, uint32_t data_len) {
  flatbuffers::FlatBufferBuilder fbb(data_len + 256);
  auto cid_o = fbb.CreateString(cid);
  auto provider_o = fbb.CreateString(provider);
  auto source_o = fbb.CreateString(source_name);
  auto batch_o = fbb.CreateString(batch_id);
  auto data_o = fbb.CreateVector(data, static_cast<size_t>(data_len));
  const flatbuffers::uoffset_t start = fbb.StartTable();
  fbb.AddOffset(4, cid_o);
  fbb.AddOffset(6, provider_o);
  fbb.AddOffset(8, source_o);
  fbb.AddOffset(10, batch_o);
  fbb.AddOffset(12, data_o);
  fbb.AddElement<int64_t>(14, static_cast<int64_t>(pulled_at), 0);
  const flatbuffers::uoffset_t table = fbb.EndTable(start);
  fbb.Finish(flatbuffers::Offset<void>(table), file_id);
  const uint8_t* p = fbb.GetBufferPointer();
  return std::vector<uint8_t>(p, p + fbb.GetSize());
}

// Read-only dedup pre-check: COUNT the cid in the arena vtab.
int64_t cid_present(const char* table, const std::string& cid) {
  std::string sql = std::string("SELECT COUNT(*) FROM ") + table + " WHERE cid = ?";
  std::vector<uint8_t> params;
  tlv_string(params, cid);
  std::vector<uint8_t> env;
  tlv_u32(env, static_cast<uint32_t>(sql.size()));
  env.insert(env.end(), sql.begin(), sql.end());
  tlv_u32(env, 1);
  env.insert(env.end(), params.begin(), params.end());
  return flatsql_exec_envelope(static_cast<uint32_t>(reinterpret_cast<uintptr_t>(env.data())),
                               static_cast<uint32_t>(env.size()));
}

}  // namespace

extern "C" {

int store(void) {
  plugin_reset_output_state();

  const Provenance cfg = read_config_provenance();
  const auto prov_map = read_provenance_map();
  const uint64_t pulled_at = read_pulled_at();

  // Pass 1: collect valid records + a PER-FIRE-UNIQUE batch_id = CIDv1 over the
  // ordered concatenation of every valid record's own CID (deterministic, in-wasm).
  struct Rec { const uint8_t* ptr; uint32_t len; std::string cid; Route route; };
  std::vector<Rec> recs;
  std::vector<uint8_t> cid_concat;
  for (uint32_t ordinal = 0;; ++ordinal) {
    const int32_t idx = plugin_find_input_index("records", ordinal);
    if (idx < 0) break;
    const plugin_input_frame_t* f = plugin_get_input_frame(static_cast<uint32_t>(idx));
    if (!f || !f->payload || f->payload_length == 0) continue;
    const Route r = route_for_record(f->payload, f->payload_length);
    if (r.table == nullptr) continue;  // not $OMM/$OCM/$OBD ($OEM never stored) — skip
    std::string cid = cid_v1_raw_sha256(f->payload, f->payload_length);
    cid_concat.insert(cid_concat.end(), cid.begin(), cid.end());
    recs.push_back(Rec{f->payload, f->payload_length, std::move(cid), r});
  }
  const std::string batch_id =
      cid_concat.empty() ? cfg.batch_id : cid_v1_raw_sha256(cid_concat.data(), cid_concat.size());

  uint32_t ingested = 0;
  for (const Rec& rec : recs) {
    const int64_t present = cid_present(rec.route.table, rec.cid);
    if (present < 0) {
      plugin_set_error("flatsql-dedup-failed",
                       "cid dedup SELECT via flatsql.exec_envelope failed.");
      return 2;
    }
    if (present > 0) continue;  // content-addressed dedup

    // Per-record provider/source_name: cid-keyed provenance sidecar; else config.
    std::string provider = cfg.provider, source_name = cfg.source_name;
    auto it = prov_map.find(rec.cid);
    if (it != prov_map.end()) {
      if (!it->second.first.empty()) provider = it->second.first;
      if (!it->second.second.empty()) source_name = it->second.second;
    }

    const std::vector<uint8_t> wrapper =
        build_wrapper_fb(rec.route.wrapper_fid, rec.cid, provider, source_name, batch_id,
                         pulled_at, rec.ptr, rec.len);
    const int64_t rc = flatsql_ingest_record(
        static_cast<uint32_t>(reinterpret_cast<uintptr_t>(wrapper.data())),
        static_cast<uint32_t>(wrapper.size()));
    if (rc < 0) {
      plugin_set_error("flatsql-ingest-failed", "arena ingest via flatsql.ingest_record failed.");
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
