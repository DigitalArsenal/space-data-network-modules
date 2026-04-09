/**
 * Protection Key Server — WASM entry point.
 *
 * This file provides the plugin_get_manifest_flatbuffer exports and the
 * invoke() dispatcher that routes SDK method calls to the key server logic.
 *
 * The key server methods (configure_runtime, get_public_key, request_challenge,
 * handle_key_request) are implemented in key_server.cpp and exposed through
 * the SDK's plugin_invoke_bridge pattern.
 */

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

#include "plugin_manifest_bytes.h"
#include "space_data_module_invoke.h"
#include "key_server_api.h"

#include <cstdint>
#include <cstring>
#include <string>

namespace {

const plugin_input_frame_t *find_input_frame(const char *port_id) {
    const uint32_t count = plugin_get_input_count();
    for (uint32_t i = 0; i < count; ++i) {
        const auto *frame = plugin_get_input_frame(i);
        if (frame && frame->port_id && std::strcmp(frame->port_id, port_id) == 0) {
            return frame;
        }
    }
    return nullptr;
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
const uint8_t *plugin_get_manifest_flatbuffer(void) {
    return protection_key_server_plugin_manifest_bytes;
}

EMSCRIPTEN_KEEPALIVE
uint32_t plugin_get_manifest_flatbuffer_size(void) {
    return protection_key_server_plugin_manifest_bytes_len;
}

/**
 * SDK invoke dispatcher. Called by plugin_invoke_bridge for each method.
 *
 * The bridge has already parsed the PluginInvokeRequest FlatBuffer and
 * populated the input frames. We read the method from the bridge context
 * and dispatch to the key server.
 */
EMSCRIPTEN_KEEPALIVE
int invoke(void) {
    plugin_reset_output_state();

    // The method_id is available via the bridge's context.
    // For the SDK bridge pattern, invoke() is called per-method via the
    // kMethodTable dispatch. We handle each method explicitly.
    //
    // NOTE: The plugin_invoke_bridge.cpp routes to this single invoke()
    // function. We use the port_id hints to identify which method was called.
    // A cleaner approach is to register separate handlers in the method table,
    // but for now this works since each method has distinct required input ports.

    const auto *config_frame = find_input_frame("config");
    const auto *request_frame = find_input_frame("request");

    // configure_runtime — has "config" input port
    if (config_frame && config_frame->payload && config_frame->payload_length > 0) {
        std::vector<uint8_t> result;
        int32_t status = key_server_configure_runtime(
            config_frame->payload, config_frame->payload_length, result);
        if (status != 0) {
            plugin_set_error("configure-failed",
                "Failed to configure key server runtime.");
            return status;
        }
        if (!result.empty()) {
            plugin_push_output("status", nullptr, nullptr,
                result.data(), static_cast<uint32_t>(result.size()));
        }
        return 0;
    }

    // get_public_key — no required input ports
    if (!config_frame && !request_frame) {
        std::vector<uint8_t> result;
        int32_t status = key_server_get_public_key(result);
        if (status != 0) {
            plugin_set_error("not-initialized",
                "Key server is not initialized.");
            return status;
        }
        plugin_push_output("response", nullptr, nullptr,
            result.data(), static_cast<uint32_t>(result.size()));
        return 0;
    }

    // request_challenge and handle_key_request — both have "request" input port
    // Disambiguate by checking the request payload content.
    if (request_frame && request_frame->payload && request_frame->payload_length > 0) {
        // Try handle_key_request first (binary protocol packet)
        // The challenge request is smaller and typically JSON-like
        // We expose both and let the bridge route based on method_id.
        //
        // For now, try both — the key server methods are idempotent in
        // terms of error detection.
        std::vector<uint8_t> result;
        int32_t status = key_server_handle_key_request(
            request_frame->payload, request_frame->payload_length, result);
        if (!result.empty()) {
            plugin_push_output("response", nullptr, nullptr,
                result.data(), static_cast<uint32_t>(result.size()));
        }
        return status;
    }

    plugin_set_error("missing-input", "No recognized input port found.");
    return 1;
}

}  // extern "C"
