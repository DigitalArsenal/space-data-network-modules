/*
 * analysis/od THREADED guest-link ENTRY translation unit (SDN OD-Flow).
 *
 * The multi-thread flow-node entry: it consumes 1..N SDS $OEM frames on the
 * "oem" input port (one per operator object), fans them across std::thread
 * workers via od::run_batch_fit (the BOUNDED work-stealing pool — the SAME core
 * the standalone module.wasm threads under WasmEdge), and emits, per fitted
 * object, an aligned-binary SDS $OMM (+ $OCM covariance + $OBD run-result) on the
 * "omm"/"ocm"/"obd" output ports. A batch of one degenerates to a single fit, so
 * this entry is a drop-in superset of the single-object `fit`.
 *
 * This is the ONLY TU whose strong method symbol is renamed by the SDK guest-link
 * convention (-Dfit=<prefix>fit, prefix sdm_guest_<hex(pluginId)[:24]>_) so a
 * baked flow resolves analysis/od's `fit` entry uniquely. Every other OD TU keeps
 * its natural symbols; the emit/consume ABI (plugin_push_output_ex,
 * plugin_get_input_frame, plugin_find_input_index, plugin_reset_output_state,
 * plugin_set_error) stays UNDEFINED here and is resolved at bake/link time against
 * the flow-runtime shim — the aligned-binary $PIV ABI contract.
 *
 * Ephemeris ($OEM) is held in memory only for the duration of the fit; nothing is
 * stored by this node. RMS parity is preserved: run_batch_fit is deterministic
 * (results indexed by input order), so a fit's $OMM/$OBD bytes are identical
 * whether one worker or many run it.
 */

#include "space_data_module_invoke.h"
#include "od_batch_fit.hpp"

#include <cstdint>
#include <vector>

extern "C" int fit(void) {
  plugin_reset_output_state();

  // Collect every $OEM frame on the "oem" port (ordinal 0..N-1) into the batch.
  std::vector<od::BatchObject> objs;
  for (uint32_t ordinal = 0;; ++ordinal) {
    int32_t idx = plugin_find_input_index("oem", ordinal);
    if (idx < 0) break;
    const plugin_input_frame_t *f = plugin_get_input_frame(static_cast<uint32_t>(idx));
    if (f == nullptr || f->payload == nullptr || f->payload_length == 0) {
      continue;  // empty frame: honest skip, keeps ordinals aligned to real inputs
    }
    objs.push_back(od::BatchObject{
        std::vector<uint8_t>(f->payload, f->payload + f->payload_length)});
  }
  if (objs.empty()) {
    plugin_set_error("missing-input", "oem port required (>=1 $OEM frame)");
    return 1;
  }

  // Thread the fits: 0 => od::run_batch_fit uses std::thread::hardware_concurrency,
  // clamped to the object count (bounded work-stealing pool, not one-per-object).
  od::BatchRunStats stats{};
  std::vector<od::BatchResult> results = od::run_batch_fit(objs, 0, &stats);

  // Emit records per fitted object. A failed/unfittable object emits nothing
  // (honest skip) — never a wrong record. $OMM is required; $OCM/$OBD ride along.
  int32_t last_rc = 0;
  for (const od::BatchResult &r : results) {
    if (!r.ok || r.omm.empty()) {
      continue;
    }
    int32_t rc = plugin_push_output_ex(
        "omm", "OMM.fbs", "$OMM", PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, "OMM",
        /*fixed_string_length=*/0, /*required_alignment=*/8,
        r.omm.data(), static_cast<uint32_t>(r.omm.size()));
    if (rc < 0) {
      return rc;
    }
    if (!r.ocm.empty()) {
      last_rc = plugin_push_output_ex(
          "ocm", "OCM.fbs", "$OCM", PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, "OCM",
          0, 8, r.ocm.data(), static_cast<uint32_t>(r.ocm.size()));
      if (last_rc < 0) {
        return last_rc;
      }
    }
    if (!r.obd.empty()) {
      last_rc = plugin_push_output_ex(
          "obd", "OBD.fbs", "$OBD", PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, "OBD",
          0, 8, r.obd.data(), static_cast<uint32_t>(r.obd.size()));
      if (last_rc < 0) {
        return last_rc;
      }
    }
  }
  return 0;
}
