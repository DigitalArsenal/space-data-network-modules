/*
 * analysis/od THREADED guest-link ENTRY translation unit (SDN OD-Flow).
 *
 * The multi-thread flow-node entry: it consumes 1..N SDS $OEM frames — one per
 * operator object — across PER-PROVIDER input ports (oem_starlink / oem_glonass /
 * oem_intelsat / oem_cpf / oem_iss, plus a generic "oem" for untagged edges),
 * fans them across std::thread workers via od::run_batch_fit (the BOUNDED
 * work-stealing pool), and emits, per fitted object, aligned-binary $OMM (+ $OCM
 * covariance + $OBD run-result) on the "omm"/"ocm"/"obd" output ports.
 *
 * PER-PROVIDER ATTRIBUTION (in-wasm, no fit/builder change, RMS-parity untouched):
 * the provider identity is derived from the INPUT PORT each $OEM arrived on
 * (per-edge identity, resolved at compose time in the $PLG), carried per-object
 * (parallel to the batch, by input order), and emitted as a CID-KEYED PROVENANCE
 * SIDECAR on the "provenance" output port: one frame per emitted record,
 *   [u32le cid_len][cid][u32le provider_len][provider][u32le source_name_len][source_name]
 * where cid = the SAME CIDv1(raw,sha2-256) the flatsql-store derives over the
 * record bytes (common/sds_cid.hpp). The store maps cid -> {provider,source_name}
 * (order-independent, no SDS parsing) to fill its provider/source_name columns.
 * Because provenance is a SIDECAR, the fitted $OMM/$OCM/$OBD bytes are byte-for-
 * byte unchanged — the RMS-parity gate is unaffected.
 *
 * This is the ONLY TU whose strong method symbol is renamed by the SDK guest-link
 * convention (-Dfit=<prefix>fit). The emit/consume ABI stays UNDEFINED here and is
 * resolved at bake. Ephemeris ($OEM) is in-memory only; nothing is stored.
 */

#include "space_data_module_invoke.h"
#include "od_batch_fit.hpp"
#include "sds_cid.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace {

// Per-provider input port -> provider registry token (source_name). The generic
// "oem" port stays untagged (empty token; the store falls back to node CONFIG).
struct ProviderPort { const char* port; const char* token; };
const ProviderPort kProviderPorts[] = {
    {"oem_starlink", "spacex-starlink"},
    {"oem_glonass", "glonass"},
    {"oem_intelsat", "intelsat"},
    {"oem_cpf", "cpf"},
    {"oem_iss", "iss"},
    {"oem", ""},
};

void put_u32le(std::vector<uint8_t>& v, uint32_t n) {
  v.push_back(n & 0xff); v.push_back((n >> 8) & 0xff); v.push_back((n >> 16) & 0xff); v.push_back((n >> 24) & 0xff);
}
void put_str(std::vector<uint8_t>& v, const std::string& s) {
  put_u32le(v, static_cast<uint32_t>(s.size())); v.insert(v.end(), s.begin(), s.end());
}

// Emit one CID-keyed provenance frame for a just-pushed record.
int32_t emit_provenance(const std::vector<uint8_t>& record, const std::string& provider) {
  if (record.empty()) return 0;
  const std::string cid = sdn_cid::cid_v1_raw_sha256(record.data(), record.size());
  std::vector<uint8_t> f;
  put_str(f, cid);
  put_str(f, provider);   // provider_id == source_name (registry token)
  put_str(f, provider);
  return plugin_push_output_ex(
      "provenance", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr,
      /*fixed_string_length=*/0, /*required_alignment=*/1, f.data(), static_cast<uint32_t>(f.size()));
}

}  // namespace

extern "C" int fit(void) {
  plugin_reset_output_state();

  // Collect every $OEM frame across the per-provider ports (+ generic "oem"),
  // tagging each object with its provider token (parallel to the batch).
  std::vector<od::BatchObject> objs;
  std::vector<std::string> providers;
  for (const ProviderPort& pp : kProviderPorts) {
    for (uint32_t ordinal = 0;; ++ordinal) {
      int32_t idx = plugin_find_input_index(pp.port, ordinal);
      if (idx < 0) break;
      const plugin_input_frame_t* f = plugin_get_input_frame(static_cast<uint32_t>(idx));
      if (f == nullptr || f->payload == nullptr || f->payload_length == 0) continue;
      objs.push_back(od::BatchObject{
          std::vector<uint8_t>(f->payload, f->payload + f->payload_length)});
      providers.push_back(pp.token);
    }
  }
  if (objs.empty()) {
    plugin_set_error("missing-input", "at least one $OEM frame required on an oem* port");
    return 1;
  }

  // Thread the fits (bounded work-stealing pool; deterministic, results by input
  // order so results[i] <-> objs[i] <-> providers[i]).
  od::BatchRunStats stats{};
  std::vector<od::BatchResult> results = od::run_batch_fit(objs, 0, &stats);

  int32_t last_rc = 0;
  for (size_t i = 0; i < results.size(); ++i) {
    const od::BatchResult& r = results[i];
    if (!r.ok || r.omm.empty()) continue;  // honest skip — never a wrong record
    const std::string& provider = i < providers.size() ? providers[i] : std::string();

    int32_t rc = plugin_push_output_ex(
        "omm", "OMM.fbs", "$OMM", PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, "OMM",
        0, 8, r.omm.data(), static_cast<uint32_t>(r.omm.size()));
    if (rc < 0) return rc;
    last_rc = emit_provenance(r.omm, provider);
    if (last_rc < 0) return last_rc;

    if (!r.ocm.empty()) {
      last_rc = plugin_push_output_ex("ocm", "OCM.fbs", "$OCM", PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,
                                      "OCM", 0, 8, r.ocm.data(), static_cast<uint32_t>(r.ocm.size()));
      if (last_rc < 0) return last_rc;
      last_rc = emit_provenance(r.ocm, provider);
      if (last_rc < 0) return last_rc;
    }
    if (!r.obd.empty()) {
      last_rc = plugin_push_output_ex("obd", "OBD.fbs", "$OBD", PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,
                                      "OBD", 0, 8, r.obd.data(), static_cast<uint32_t>(r.obd.size()));
      if (last_rc < 0) return last_rc;
      last_rc = emit_provenance(r.obd, provider);
      if (last_rc < 0) return last_rc;
    }
  }
  return 0;
}
