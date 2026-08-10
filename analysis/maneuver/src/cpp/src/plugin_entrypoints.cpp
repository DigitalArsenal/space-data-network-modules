#include "maneuver/plugin_runtime.h"

#include "space_data_module_invoke.h"

#include <cstdint>
#include <string>

/**
 * THE INVOKE ENTRY POINT.
 *
 * Two things left this file when the module moved onto the SDK compiler lane:
 *
 *   - `plugin_get_manifest_flatbuffer` / `_size`. They used to return a
 *     generated `plugin_manifest_bytes.h` produced by a repo script — a
 *     hand-maintained mirror of the manifest that could drift from
 *     plugin-manifest.json between builds. The SDK now generates and links
 *     those exports itself from the SAME manifest object it validates and
 *     stamps into the wasm custom section, so there is exactly one manifest and
 *     no copy to keep in step.
 *   - The `EMSCRIPTEN_KEEPALIVE` decoration and the emscripten header. Exports
 *     are declared to the linker by the SDK's `-Wl,--export=` list, which is
 *     derived from the manifest's method ids.
 *
 * What did NOT change is the invoke CONTRACT: a `request` input frame carrying
 * a UTF-8 JSON envelope, a `response` output frame carrying a UTF-8 JSON
 * object, and a non-zero return with `plugin_set_error` on refusal. The
 * frame-acceptance regression the sensor-model rebuild hit
 * (`closed-modules-sensor-model-invoke-contract`) is guarded here by
 * `plugin_find_input_index` rather than a hand-rolled scan, and by the recorded
 * real-artifact response fixtures the consumer tests replay.
 */

extern "C" {

int invoke(void) {
    plugin_reset_output_state();

    const int32_t index = plugin_find_input_index("request", 0);
    const plugin_input_frame_t* frame =
        index < 0 ? nullptr : plugin_get_input_frame(static_cast<uint32_t>(index));
    if (frame == nullptr || frame->payload == nullptr) {
        plugin_set_error("missing-request-input", "Input port \"request\" is required.");
        return 1;
    }

    const maneuver::PluginInvokeResult result = maneuver::invoke_json_request(
        std::string_view(reinterpret_cast<const char*>(frame->payload),
                         frame->payload_length));

    if (!result.ok) {
        // The structured refusal. `result.json` is ALSO emitted so a caller that
        // reads the response frame rather than the status gets the same
        // diagnosis: an {error, errorCode} object, never a trap and never an
        // empty frame.
        plugin_set_error(result.error_code.c_str(), result.error_message.c_str());
        const auto* payload = reinterpret_cast<const uint8_t*>(result.json.data());
        plugin_push_output("response", nullptr, nullptr, payload,
                           static_cast<uint32_t>(result.json.size()));
        return 1;
    }

    const auto* payload = reinterpret_cast<const uint8_t*>(result.json.data());
    if (plugin_push_output("response", nullptr, nullptr, payload,
                           static_cast<uint32_t>(result.json.size())) < 0) {
        plugin_set_error("emit-failed", "Failed to emit response frame.");
        return 1;
    }

    return 0;
}

}  // extern "C"
