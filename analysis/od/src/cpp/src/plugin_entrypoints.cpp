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

    const auto* frame = find_input_frame("meme");
    if (!frame || !frame->payload) {
        plugin_set_error("missing-meme-input", "Input port \"meme\" is required.");
        return 1;
    }
    const auto* options_frame = find_input_frame("options");
    const std::string_view options_json =
        options_frame && options_frame->payload
            ? std::string_view(
                  reinterpret_cast<const char*>(options_frame->payload),
                  options_frame->payload_length)
            : std::string_view{};

    const auto result = od::fit_meme_payload(
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
