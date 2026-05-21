#include "atmosphere/plugin_runtime.h"

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

const plugin_input_frame_t* find_frame(const char* port_id) {
    const auto count = plugin_get_input_count();
    for (uint32_t index = 0; index < count; ++index) {
        const auto* frame = plugin_get_input_frame(index);
        if (frame && frame->port_id && std::string(frame->port_id) == port_id) {
            return frame;
        }
    }
    return nullptr;
}

const plugin_input_frame_t* find_request_frame() {
    return find_frame("request");
}

int emit_json_response(const char* port_id, const atmosphere::PluginInvokeResult& result) {
    if (!result.ok) {
        plugin_set_error(result.error_code.c_str(), result.error_message.c_str());
        return 1;
    }

    const auto* payload = reinterpret_cast<const uint8_t*>(result.json.data());
    if (plugin_push_output(port_id, nullptr, nullptr, payload,
                           static_cast<uint32_t>(result.json.size())) < 0) {
        plugin_set_error("emit-failed", "Failed to emit response frame.");
        return 1;
    }

    return 0;
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
const uint8_t* plugin_get_manifest_flatbuffer(void) {
    return atmosphere_plugin_manifest_bytes;
}

EMSCRIPTEN_KEEPALIVE
uint32_t plugin_get_manifest_flatbuffer_size(void) {
    return atmosphere_plugin_manifest_bytes_len;
}

EMSCRIPTEN_KEEPALIVE
int invoke(void) {
    plugin_reset_output_state();

    const auto* frame = find_request_frame();
    if (!frame || !frame->payload) {
        plugin_set_error("missing-request-input", "Input port \"request\" is required.");
        return 1;
    }

    const auto result = atmosphere::invoke_json_request(
        std::string_view(
            reinterpret_cast<const char*>(frame->payload),
            frame->payload_length));

    return emit_json_response("response", result);
}

EMSCRIPTEN_KEEPALIVE
int query_atmosphere_state_batch(void) {
    plugin_reset_output_state();

    const auto* frame = find_frame("atmosphere");
    if (!frame || !frame->payload) {
        plugin_set_error("missing-atmosphere-input", "Input port \"atmosphere\" is required.");
        return 1;
    }

    const std::string request =
        std::string("{\"operation\":\"queryAtmosphereStateBatch\",\"params\":") +
        std::string(reinterpret_cast<const char*>(frame->payload), frame->payload_length) +
        "}";
    const auto result = atmosphere::invoke_json_request(request);

    return emit_json_response("states", result);
}

}  // extern "C"
