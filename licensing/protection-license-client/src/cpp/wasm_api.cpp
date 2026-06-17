#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

#include "license_client_api.h"
#include "plugin_manifest_bytes.h"
#include "space_data_module_invoke.h"

#include <cstdint>
#include <cstring>
#include <vector>

namespace {

const plugin_input_frame_t* find_input_frame(const char* port_id) {
    const uint32_t count = plugin_get_input_count();
    for (uint32_t i = 0; i < count; ++i) {
        const auto* frame = plugin_get_input_frame(i);
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
const uint8_t* plugin_get_manifest_flatbuffer(void) {
    return protection_license_client_plugin_manifest_bytes;
}

EMSCRIPTEN_KEEPALIVE
uint32_t plugin_get_manifest_flatbuffer_size(void) {
    return protection_license_client_plugin_manifest_bytes_len;
}

EMSCRIPTEN_KEEPALIVE
int protection_license_client_get_dek(void) {
    plugin_reset_output_state();

    const auto* request_frame = find_input_frame("request");
    if (!request_frame || !request_frame->payload) {
        plugin_set_error("missing-request-input", "Input port \"request\" is required.");
        return 1;
    }

    std::vector<uint8_t> response;
    const int32_t status = license_client_get_dek(
        request_frame->payload,
        request_frame->payload_length,
        response);
    if (status != 0) {
        plugin_set_error("dek-request-failed", "Failed to retrieve DEK.");
        return status;
    }
    if (plugin_push_output("response", nullptr, nullptr, response.data(),
                           static_cast<uint32_t>(response.size())) < 0) {
        plugin_set_error("emit-failed", "Failed to emit DEK response.");
        return 1;
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int protection_license_client_decrypt(void) {
    plugin_reset_output_state();

    const auto* ciphertext = find_input_frame("ciphertext");
    const auto* key = find_input_frame("key");
    if (!ciphertext || !ciphertext->payload || !key || !key->payload) {
        plugin_set_error("missing-input", "Input ports \"ciphertext\" and \"key\" are required.");
        return 1;
    }

    std::vector<uint8_t> plaintext;
    const int32_t status = license_client_decrypt(
        ciphertext->payload,
        ciphertext->payload_length,
        key->payload,
        key->payload_length,
        plaintext);
    if (status != 0) {
        plugin_set_error("decrypt-failed", "Failed to decrypt protected content.");
        return status;
    }
    if (plugin_push_output("plaintext", nullptr, nullptr, plaintext.data(),
                           static_cast<uint32_t>(plaintext.size())) < 0) {
        plugin_set_error("emit-failed", "Failed to emit plaintext.");
        return 1;
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int protection_license_client_verify(void) {
    plugin_reset_output_state();

    const auto* signed_content = find_input_frame("signed_content");
    const auto* public_key = find_input_frame("public_key");
    if (!signed_content || !signed_content->payload || !public_key || !public_key->payload) {
        plugin_set_error("missing-input", "Input ports \"signed_content\" and \"public_key\" are required.");
        return 1;
    }

    std::vector<uint8_t> result_json;
    const int32_t status = license_client_verify(
        signed_content->payload,
        signed_content->payload_length,
        public_key->payload,
        public_key->payload_length,
        result_json);
    if (status != 0) {
        plugin_set_error("verify-failed", "Failed to verify signed content.");
        return status;
    }
    if (plugin_push_output("result", nullptr, nullptr, result_json.data(),
                           static_cast<uint32_t>(result_json.size())) < 0) {
        plugin_set_error("emit-failed", "Failed to emit verification result.");
        return 1;
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int protection_license_client_decrypt_and_verify(void) {
    plugin_reset_output_state();

    const auto* protected_content = find_input_frame("protected_content");
    const auto* dek = find_input_frame("dek");
    const auto* signer_key = find_input_frame("signer_key");
    if (!protected_content || !protected_content->payload ||
        !dek || !dek->payload ||
        !signer_key || !signer_key->payload) {
        plugin_set_error(
            "missing-input",
            "Input ports \"protected_content\", \"dek\", and \"signer_key\" are required.");
        return 1;
    }

    std::vector<uint8_t> plaintext;
    const int32_t status = license_client_decrypt_and_verify(
        protected_content->payload,
        protected_content->payload_length,
        dek->payload,
        dek->payload_length,
        signer_key->payload,
        signer_key->payload_length,
        plaintext);
    if (status != 0) {
        plugin_set_error("decrypt-verify-failed", "Failed to decrypt and verify content.");
        return status;
    }
    if (plugin_push_output("plaintext", nullptr, nullptr, plaintext.data(),
                           static_cast<uint32_t>(plaintext.size())) < 0) {
        plugin_set_error("emit-failed", "Failed to emit plaintext.");
        return 1;
    }
    return 0;
}

int get_dek(void) {
    return protection_license_client_get_dek();
}

int decrypt(void) {
    return protection_license_client_decrypt();
}

int verify(void) {
    return protection_license_client_verify();
}

int decrypt_and_verify(void) {
    return protection_license_client_decrypt_and_verify();
}

}  // extern "C"
