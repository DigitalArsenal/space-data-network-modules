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
#include <vector>

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

extern "C" void __wasm_call_ctors(void);

extern "C" {

EMSCRIPTEN_KEEPALIVE
void _initialize(void) {
    static bool initialized = false;
    if (!initialized) {
        initialized = true;
        __wasm_call_ctors();
    }
}

EMSCRIPTEN_KEEPALIVE
const uint8_t *plugin_get_manifest_flatbuffer(void) {
    return protection_key_server_plugin_manifest_bytes;
}

EMSCRIPTEN_KEEPALIVE
uint32_t plugin_get_manifest_flatbuffer_size(void) {
    return protection_key_server_plugin_manifest_bytes_len;
}

EMSCRIPTEN_KEEPALIVE
int protection_key_server_configure_runtime(void) {
    plugin_reset_output_state();
    const auto *config_frame = find_input_frame("config");
    if (!config_frame || !config_frame->payload) {
        plugin_set_error("missing-config-input", "Input port \"config\" is required.");
        return 1;
    }

    std::vector<uint8_t> result;
    const int32_t status = key_server_configure_runtime(
        config_frame->payload,
        config_frame->payload_length,
        result);
    if (status != 0) {
        plugin_set_error("configure-failed", "Failed to configure key server runtime.");
        return status;
    }

    if (!result.empty() &&
        plugin_push_output("status", nullptr, nullptr, result.data(),
                           static_cast<uint32_t>(result.size())) < 0) {
        plugin_set_error("emit-failed", "Failed to emit configuration status.");
        return 1;
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int protection_key_server_get_public_key(void) {
    plugin_reset_output_state();

    std::vector<uint8_t> result;
    const int32_t status = key_server_get_public_key(result);
    if (status != 0) {
        plugin_set_error("not-initialized", "Key server is not initialized.");
        return status;
    }
    if (plugin_push_output("response", nullptr, "OBPK", result.data(),
                           static_cast<uint32_t>(result.size())) < 0) {
        plugin_set_error("emit-failed", "Failed to emit public key response.");
        return 1;
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int protection_key_server_request_challenge(void) {
    plugin_reset_output_state();

    std::vector<uint8_t> result;
    const auto *request_frame = find_input_frame("request");
    const uint8_t* payload = request_frame ? request_frame->payload : nullptr;
    const uint32_t payload_length = request_frame ? request_frame->payload_length : 0;

    const int32_t status = key_server_request_challenge(payload, payload_length, result);
    if (status != 0 && result.empty()) {
        plugin_set_error("challenge-failed", "Failed to issue challenge.");
        return status;
    }
    if (!result.empty() &&
        plugin_push_output("response", nullptr, nullptr, result.data(),
                           static_cast<uint32_t>(result.size())) < 0) {
        plugin_set_error("emit-failed", "Failed to emit challenge response.");
        return 1;
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int protection_key_server_handle_key_request(void) {
    plugin_reset_output_state();

    const auto *request_frame = find_input_frame("request");
    if (!request_frame || !request_frame->payload) {
        plugin_set_error("missing-request-input", "Input port \"request\" is required.");
        return 1;
    }

    std::vector<uint8_t> result;
    const int32_t status = key_server_handle_key_request(
        request_frame->payload,
        request_frame->payload_length,
        result);
    if (status != 0 && result.empty()) {
        plugin_set_error("broker-failed", "Failed to handle key-broker request.");
        return status;
    }
    if (!result.empty() &&
        plugin_push_output("response", nullptr, "OBKS", result.data(),
                           static_cast<uint32_t>(result.size())) < 0) {
        plugin_set_error("emit-failed", "Failed to emit key-broker response.");
        return 1;
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int protection_key_server_check_key_rotation(void) {
    plugin_reset_output_state();

    std::vector<uint8_t> result;
    const int32_t status = key_server_check_key_rotation(result);
    if (status != 0) {
        plugin_set_error("rotation-check-failed", "Failed to evaluate key rotation state.");
        return status;
    }
    if (!result.empty() &&
        plugin_push_output("status", nullptr, nullptr, result.data(),
                           static_cast<uint32_t>(result.size())) < 0) {
        plugin_set_error("emit-failed", "Failed to emit rotation status.");
        return 1;
    }
    return 0;
}

}  // extern "C"
