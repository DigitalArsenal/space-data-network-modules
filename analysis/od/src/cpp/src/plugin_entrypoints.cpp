#include "od/plugin_runtime.h"

#include "plugin_manifest_bytes.h"
#include "space_data_module_invoke.h"

#include <cstdint>
#include <string>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

namespace {

const plugin_input_frame_t* find_input_frame(const char* port_id) {
    const auto count = plugin_get_input_count();
    for (uint32_t index = 0; index < count; ++index) {
        const auto* frame = plugin_get_input_frame(index);
        if (frame && frame->port_id && std::string(frame->port_id) == port_id) {
            return frame;
        }
    }
    return nullptr;
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
const uint8_t* plugin_get_manifest_flatbuffer(void) {
    return od_plugin_manifest_bytes;
}

EMSCRIPTEN_KEEPALIVE
uint32_t plugin_get_manifest_flatbuffer_size(void) {
    return od_plugin_manifest_bytes_len;
}

EMSCRIPTEN_KEEPALIVE
int fit(void) {
    plugin_reset_output_state();

    // Optional "options" frame (labeling / fit-config / scoring). In a baked flow
    // these live in node CONFIG; the port is kept for the command surface.
    const auto* options_frame = find_input_frame("options");
    const std::string_view options_json =
        options_frame && options_frame->payload
            ? std::string_view(
                  reinterpret_cast<const char*>(options_frame->payload),
                  options_frame->payload_length)
            : std::string_view{};

    // ── FlatBuffer flow path (aligned-binary) ──────────────────────────────────
    // The "oem" input port carries an SDS $OEM FlatBuffer. Fit the SAME core the
    // text path fits and emit an SDS $OMM FlatBuffer on the "omm" output port as
    // ALIGNED_BINARY. No JSON at this data hop.
    const auto* oem_frame = find_input_frame("oem");
    if (oem_frame && oem_frame->payload && oem_frame->payload_length > 0) {
        const auto fb = od::fit_ephemeris_fb(oem_frame->payload,
                                             oem_frame->payload_length, options_json);
        if (!fb.ok) {
            plugin_set_error(fb.error_code.c_str(), fb.error_message.c_str());
            return 1;
        }
        if (plugin_push_output_ex(
                "omm", "OMM.fbs", "$OMM",
                PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, "OMM",
                /*fixed_string_length=*/0, /*required_alignment=*/8,
                fb.omm.data(), static_cast<uint32_t>(fb.omm.size())) < 0) {
            plugin_set_error("emit-failed", "Failed to emit $OMM frame.");
            return 1;
        }
        if (fb.ocm.empty() || plugin_push_output_ex(
                "ocm", "OCM.fbs", "$OCM",
                PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, "OCM",
                0, 8, fb.ocm.data(), static_cast<uint32_t>(fb.ocm.size())) < 0) {
            plugin_set_error("emit-failed", "Failed to emit $OCM frame.");
            return 1;
        }
        return 0;
    }

    // ── Text command path (back-compat: SpaceX MEME text or CCSDS OEM KVN) ──────
    // The "meme" port carries the ephemeris payload for any supported text format;
    // the format is selected data-level via the "options" inputFormat field, or
    // auto-detected. The port id is kept for ABI stability.
    const auto* frame = find_input_frame("meme");
    if (!frame || !frame->payload) {
        plugin_set_error("missing-input",
                         "Input port \"oem\" ($OEM FlatBuffer) or \"meme\" (text) is required.");
        return 1;
    }

    const auto result = od::fit_ephemeris_payload(
        std::string_view(
            reinterpret_cast<const char*>(frame->payload),
            frame->payload_length),
        options_json);

    if (!result.ok) {
        plugin_set_error(result.error_code.c_str(), result.error_message.c_str());
        return 1;
    }

    const auto* payload =
        reinterpret_cast<const uint8_t*>(result.json.data());
    if (plugin_push_output("result", nullptr, nullptr, payload,
                           static_cast<uint32_t>(result.json.size())) < 0) {
        plugin_set_error("emit-failed", "Failed to emit result frame.");
        return 1;
    }

    return 0;
}

}  // extern "C"
