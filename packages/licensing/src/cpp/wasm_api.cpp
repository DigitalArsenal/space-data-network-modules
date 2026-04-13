#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

#include "key_server_api.h"
#include "KMF_generated.h"
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

int emit_output(
    const char* port_id,
    const char* file_identifier,
    std::vector<uint8_t>& payload,
    const char* error_code,
    const char* error_message) {
    if (!payload.empty() &&
        plugin_push_output(
            port_id,
            nullptr,
            file_identifier,
            payload.data(),
            static_cast<uint32_t>(payload.size())) < 0) {
        plugin_set_error(error_code, error_message);
        return 1;
    }
    return 0;
}

int require_input(
    const char* port_id,
    const plugin_input_frame_t** frame_out,
    const char* error_code,
    const char* error_message) {
    const auto* frame = find_input_frame(port_id);
    if (!frame || !frame->payload) {
        plugin_set_error(error_code, error_message);
        return 1;
    }
    *frame_out = frame;
    return 0;
}

int extract_kmf_bytes(
    const plugin_input_frame_t* frame,
    keyMaterialRole expected_role,
    keyMaterialAlgorithm expected_algorithm,
    keyMaterialEncoding expected_encoding,
    std::vector<uint8_t>* bytes_out,
    const char* error_code,
    const char* error_message) {
    if (!frame || !frame->payload || !bytes_out) {
        plugin_set_error(error_code, error_message);
        return 1;
    }

    flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!VerifyKMFBuffer(verifier)) {
        plugin_set_error(error_code, error_message);
        return 1;
    }

    const auto* key_material = GetKMF(frame->payload);
    if (!key_material || !key_material->KEY_BYTES()) {
        plugin_set_error(error_code, error_message);
        return 1;
    }
    if (expected_role != keyMaterialRole::Unknown &&
        key_material->ROLE() != expected_role) {
        plugin_set_error(error_code, error_message);
        return 1;
    }
    if (expected_algorithm != keyMaterialAlgorithm::Unknown &&
        key_material->ALGORITHM() != expected_algorithm) {
        plugin_set_error(error_code, error_message);
        return 1;
    }
    if (expected_encoding != keyMaterialEncoding::Unknown &&
        key_material->ENCODING() != expected_encoding) {
        plugin_set_error(error_code, error_message);
        return 1;
    }

    bytes_out->assign(
        key_material->KEY_BYTES()->begin(),
        key_material->KEY_BYTES()->end());
    return 0;
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
    return licensing_plugin_manifest_bytes;
}

EMSCRIPTEN_KEEPALIVE
uint32_t plugin_get_manifest_flatbuffer_size(void) {
    return licensing_plugin_manifest_bytes_len;
}

EMSCRIPTEN_KEEPALIVE
int licensing_server_configure_runtime(void) {
    plugin_reset_output_state();

    const plugin_input_frame_t* config_frame = nullptr;
    if (require_input(
            "config",
            &config_frame,
            "missing-config-input",
            "Input port \"config\" is required.") != 0) {
        return 1;
    }

    std::vector<uint8_t> status_bytes;
    const int32_t status = key_server_configure_runtime(
        config_frame->payload,
        config_frame->payload_length,
        status_bytes);
    if (status != 0) {
        plugin_set_error("configure-failed", "Failed to configure licensing runtime.");
        return status;
    }
    return emit_output(
        "status",
        "$LCF",
        status_bytes,
        "emit-failed",
        "Failed to emit configuration status.");
}

EMSCRIPTEN_KEEPALIVE
int licensing_server_publish_module(void) {
    plugin_reset_output_state();

    const plugin_input_frame_t* descriptor_frame = nullptr;
    if (require_input(
            "module_descriptor",
            &descriptor_frame,
            "missing-module-descriptor-input",
            "Input port \"module_descriptor\" is required.") != 0) {
        return 1;
    }

    const plugin_input_frame_t* protected_content_frame = nullptr;
    if (require_input(
            "protected_content",
            &protected_content_frame,
            "missing-protected-content-input",
            "Input port \"protected_content\" is required.") != 0) {
        return 1;
    }

    const plugin_input_frame_t* content_key_frame = nullptr;
    if (require_input(
            "content_key",
            &content_key_frame,
            "missing-content-key-input",
            "Input port \"content_key\" is required.") != 0) {
        return 1;
    }

    std::vector<uint8_t> content_key_bytes;
    if (extract_kmf_bytes(
            content_key_frame,
            keyMaterialRole::PublicationContent,
            keyMaterialAlgorithm::Aes256Gcm,
            keyMaterialEncoding::RawBytes,
            &content_key_bytes,
            "invalid-content-key-input",
            "Input port \"content_key\" must carry a $KMF publication content key.") != 0) {
        return 1;
    }

    std::vector<uint8_t> response;
    const int32_t status = key_server_publish_module(
        descriptor_frame->payload,
        descriptor_frame->payload_length,
        protected_content_frame->payload,
        protected_content_frame->payload_length,
        content_key_bytes.data(),
        static_cast<uint32_t>(content_key_bytes.size()),
        response);
    if (status != 0) {
        plugin_set_error("publish-failed", "Failed to publish protected module.");
        return status;
    }
    return emit_output(
        "response",
        "$PLG",
        response,
        "emit-failed",
        "Failed to emit published module descriptor.");
}

EMSCRIPTEN_KEEPALIVE
int licensing_server_handle_message(void) {
    plugin_reset_output_state();

    const plugin_input_frame_t* request_frame = nullptr;
    if (require_input(
            "request",
            &request_frame,
            "missing-request-input",
            "Input port \"request\" is required.") != 0) {
        return 1;
    }

    std::vector<uint8_t> response;
    const int32_t status = key_server_handle_message(
        request_frame->payload,
        request_frame->payload_length,
        response);
    if (status != 0) {
        plugin_set_error("server-handle-failed", "Failed to handle licensing delivery message.");
        return status;
    }
    return emit_output(
        "response",
        nullptr,
        response,
        "emit-failed",
        "Failed to emit licensing delivery response.");
}

EMSCRIPTEN_KEEPALIVE
int licensing_client_request_grant(void) {
    plugin_reset_output_state();

    const plugin_input_frame_t* request_frame = nullptr;
    if (require_input(
            "request",
            &request_frame,
            "missing-request-input",
            "Input port \"request\" is required.") != 0) {
        return 1;
    }

    const plugin_input_frame_t* signing_key_frame = nullptr;
    if (require_input(
            "requester_signing_key",
            &signing_key_frame,
            "missing-requester-signing-key-input",
            "Input port \"requester_signing_key\" is required.") != 0) {
        return 1;
    }

    std::vector<uint8_t> requester_signing_key_bytes;
    if (extract_kmf_bytes(
            signing_key_frame,
            keyMaterialRole::RequesterSigning,
            keyMaterialAlgorithm::Ed25519Seed,
            keyMaterialEncoding::Seed32,
            &requester_signing_key_bytes,
            "invalid-requester-signing-key-input",
            "Input port \"requester_signing_key\" must carry a $KMF requester signing seed.") != 0) {
        return 1;
    }

    std::vector<uint8_t> response;
    const int32_t status = license_client_request_grant(
        request_frame->payload,
        request_frame->payload_length,
        requester_signing_key_bytes.data(),
        static_cast<uint32_t>(requester_signing_key_bytes.size()),
        response);
    if (status != 0) {
        plugin_set_error("grant-request-failed", "Failed to request licensing grant.");
        return status;
    }
    return emit_output(
        "response",
        "$LGR",
        response,
        "emit-failed",
        "Failed to emit grant request response.");
}

EMSCRIPTEN_KEEPALIVE
int licensing_client_fetch_and_decrypt(void) {
    plugin_reset_output_state();

    const auto* grant_response = find_input_frame("grant_response");
    const auto* protected_content = find_input_frame("protected_content");
    if (!grant_response || !grant_response->payload) {
        plugin_set_error(
            "missing-input",
            "Input port \"grant_response\" is required.");
        return 1;
    }

    std::vector<uint8_t> plaintext;
    const int32_t status = license_client_fetch_and_decrypt(
        grant_response->payload,
        grant_response->payload_length,
        protected_content ? protected_content->payload : nullptr,
        protected_content ? protected_content->payload_length : 0,
        plaintext);
    if (status != 0) {
        plugin_set_error("decrypt-failed", "Failed to decrypt fetched content.");
        return status;
    }
    return emit_output(
        "plaintext",
        nullptr,
        plaintext,
        "emit-failed",
        "Failed to emit plaintext.");
}

EMSCRIPTEN_KEEPALIVE
int licensing_decrypt_and_verify(void) {
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

    std::vector<uint8_t> dek_bytes;
    if (extract_kmf_bytes(
            dek,
            keyMaterialRole::DecryptKey,
            keyMaterialAlgorithm::Aes256Gcm,
            keyMaterialEncoding::RawBytes,
            &dek_bytes,
            "invalid-dek-input",
            "Input port \"dek\" must carry a $KMF decrypt key.") != 0) {
        return 1;
    }

    std::vector<uint8_t> signer_key_bytes;
    if (extract_kmf_bytes(
            signer_key,
            keyMaterialRole::VerificationKey,
            keyMaterialAlgorithm::Ed25519Public,
            keyMaterialEncoding::PublicKey32,
            &signer_key_bytes,
            "invalid-signer-key-input",
            "Input port \"signer_key\" must carry a $KMF verification key.") != 0) {
        return 1;
    }

    std::vector<uint8_t> plaintext;
    const int32_t status = license_client_decrypt_and_verify(
        protected_content->payload,
        protected_content->payload_length,
        dek_bytes.data(),
        static_cast<uint32_t>(dek_bytes.size()),
        signer_key_bytes.data(),
        static_cast<uint32_t>(signer_key_bytes.size()),
        plaintext);
    if (status != 0) {
        plugin_set_error("decrypt-verify-failed", "Failed to decrypt and verify content.");
        return status;
    }
    return emit_output(
        "plaintext",
        nullptr,
        plaintext,
        "emit-failed",
        "Failed to emit plaintext.");
}

}  // extern "C"
