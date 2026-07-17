/*
 * analysis/od guest-link ENTRY translation unit (SDN OD-Flow, Phase 1a/1b).
 *
 * This is the ONLY TU whose strong method symbol is renamed by the SDK
 * guest-link convention (-Dfit=<prefix>fit, prefix sdm_guest_<hex(pluginId)[:24]>_)
 * so a baked flow can resolve analysis/od's `fit` entry uniquely among all the
 * modules linked into one runtime.wasm. Every other OD TU (od_lib + sgp4_lib)
 * keeps its natural symbols; only this entry is prefixed.
 *
 * It consumes an SDS $OEM frame on the "oem" input port, fits supplemental-GP
 * mean elements via od::fit_ephemeris_fb (defined in plugin_runtime.o, which
 * lives in od_lib), and emits the resulting SDS $OMM FlatBuffer on the "omm"
 * output port as ALIGNED_BINARY. The emit/consume ABI (plugin_push_output_ex,
 * plugin_get_input_frame, plugin_find_input_index, plugin_reset_output_state,
 * plugin_set_error) stays UNDEFINED here and is resolved at bake/link time
 * against the flow-runtime shim — exactly the aligned-binary $PIV ABI contract.
 *
 * Ephemeris is held in memory only for the duration of the fit; nothing is
 * stored by this node.
 */

#include "space_data_module_invoke.h"
#include "od/plugin_runtime.h"

#include <cstdint>
#include <string_view>

extern "C" int fit(void) {
  plugin_reset_output_state();

  int32_t idx = plugin_find_input_index("oem", 0);
  if (idx < 0) {
    plugin_set_error("missing-input", "oem port required");
    return 1;
  }
  const plugin_input_frame_t *f = plugin_get_input_frame((uint32_t)idx);
  if (f == 0 || f->payload == 0 || f->payload_length == 0) {
    plugin_set_error("missing-input", "empty oem frame");
    return 1;
  }

  // $OEM in -> fit -> $OMM out. Options empty: identity/labels ride in the $OEM
  // (CAT NORAD/OBJECT_ID) or, in a flow, in node CONFIG (not this hop).
  od::PluginFitFBResult r =
      od::fit_ephemeris_fb(f->payload, f->payload_length, std::string_view{});
  if (!r.ok) {
    plugin_set_error(r.error_code.c_str(), r.error_message.c_str());
    return 1;
  }

  // r.omm is a size-prefixed SDS $OMM FlatBuffer; push it as one aligned-binary
  // frame (align 8). foundation/omm-json.encode consumes exactly this shape.
  int32_t rc = plugin_push_output_ex(
      "omm", "OMM.fbs", "$OMM",
      PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, "OMM",
      /*fixed_string_length=*/0, /*required_alignment=*/8,
      r.omm.data(), (uint32_t)r.omm.size());
  if (rc != 0) {
    return rc;
  }

  // r.obd is a size-prefixed SDS $OBD FlatBuffer (the OD run result: WRMS,
  // iterations, method) from the SAME fit; push it on the "obd" output port. A
  // flow may wire it to a store node or leave it unwired (dropped). Same
  // aligned-binary shape as $OMM.
  if (!r.obd.empty()) {
    rc = plugin_push_output_ex(
        "obd", "OBD.fbs", "$OBD",
        PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, "OBD",
        /*fixed_string_length=*/0, /*required_alignment=*/8,
        r.obd.data(), (uint32_t)r.obd.size());
  }
  return rc;
}
