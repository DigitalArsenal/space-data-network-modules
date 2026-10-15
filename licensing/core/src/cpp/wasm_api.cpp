#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

// The licensing module's method entry points on the typed contracts (1.0). The SDK's generated invoke glue
// (generated/typed/plugin_invoke_glue.cpp) checks every input and output frame against the manifest's port type; each
// port carries one SDS FlatBuffer type. Key material never travels on a port: it is read as raw secret frames through
// secrets.get, by the IDs this module's config (plugin.getConfig) names.

#include "key_server_api.h"
#include "license_client_api.h"
#include "licensing_hostcalls.hpp"
#include "plugin_manifest_bytes.h"
#include "space_data_module_invoke.h"

#include "FIL_generated.h"
#include "KMF_generated.h"
#include "PLG_generated.h"

#include <array>
#include <cstdint>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

namespace {

constexpr size_t kKeyBytes = 32;

struct PortType {
  const char* schema_name;
  const char* file_identifier;
  const char* root_type_name;
};
constexpr PortType kLCF{"LCF.fbs", "$LCF", "LCF"};
constexpr PortType kPLG{"PLG.fbs", "$PLG", "PLG"};
constexpr PortType kLCH{"LCH.fbs", "$LCH", "LCH"};
constexpr PortType kLGR{"LGR.fbs", "$LGR", "LGR"};
constexpr PortType kFIL{"FIL.fbs", "$FIL", "FIL"};

void secure_zero(void* ptr, size_t len) {
  volatile uint8_t* p = static_cast<volatile uint8_t*>(ptr);
  for (size_t i = 0; i < len; ++i) p[i] = 0;
}

const plugin_input_frame_t* find_input_frame(const char* port_id) {
  const int32_t index = plugin_find_input_index(port_id, 0);
  if (index < 0) return nullptr;
  const auto* frame = plugin_get_input_frame(static_cast<uint32_t>(index));
  return frame && frame->payload && frame->payload_length > 0 ? frame : nullptr;
}

int fail(const char* code, const char* message) {
  plugin_set_error(code, message);
  return 1;
}

int require_input(const char* port_id, const plugin_input_frame_t** frame_out, const char* code, const char* message) {
  const auto* frame = find_input_frame(port_id);
  if (!frame) return fail(code, message);
  *frame_out = frame;
  return 0;
}

int emit(const char* port_id, const PortType& type, const std::vector<uint8_t>& payload) {
  if (payload.empty()) return 0;
  if (payload.size() < 8 || !flatbuffers::BufferHasIdentifier(payload.data(), type.file_identifier)) {
    return fail("emit-failed", "The module built a record that is not the port's declared type.");
  }
  if (plugin_push_output_ex(port_id, type.schema_name, type.file_identifier,
                            PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, type.root_type_name, 0, 0,
                            payload.data(), static_cast<uint32_t>(payload.size())) < 0) {
    return fail("emit-failed", "The output frame was refused.");
  }
  return 0;
}

// The CONTENT of a $FIL frame (a view into the frame); false when the frame is not a verified $FIL with content.
bool fil_content(const plugin_input_frame_t* frame, const uint8_t** data_out, uint32_t* len_out) {
  if (!frame || !frame->payload) return false;
  flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyFILBuffer(verifier)) return false;
  const auto* file = GetFIL(frame->payload);
  if (!file || !file->CONTENT() || file->CONTENT()->size() == 0) return false;
  *data_out = file->CONTENT()->data();
  *len_out = static_cast<uint32_t>(file->CONTENT()->size());
  return true;
}

// A $FIL carrying `content` verbatim (KIND File, SIZE, CONTENT).
std::vector<uint8_t> build_fil(const std::vector<uint8_t>& content) {
  flatbuffers::FlatBufferBuilder builder(content.size() + 128);
  const auto content_offset = builder.CreateVector(content);
  FILBuilder fil(builder);
  fil.add_KIND(filEntryKind::File);
  fil.add_SIZE(static_cast<uint64_t>(content.size()));
  fil.add_CONTENT(content_offset);
  FinishFILBuffer(builder, fil.Finish());
  return {builder.GetBufferPointer(), builder.GetBufferPointer() + builder.GetSize()};
}

// A 32-byte secret by the ID config `key` names.
int read_config_secret(const char* key, std::array<uint8_t, kKeyBytes>* out, const char* code) {
  std::string config_error;
  const std::string id = licensing_host::config_string(key, &config_error);
  if (!config_error.empty()) return fail(code, "plugin.getConfig failed; the secret's ID is read from the module config.");
  if (id.empty()) return fail(code, "The module config names no secret ID for this key.");
  if (!licensing_host::secret(id, out->data(), out->size())) {
    return fail(code, "secrets.get did not answer a 32-byte secret for the configured ID.");
  }
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

// config $LCF -> status $LCF
int server_configure_runtime(void) {
  plugin_reset_output_state();
  const plugin_input_frame_t* config_frame = nullptr;
  if (require_input("config", &config_frame, "missing-config-input", "Input port \"config\" is required.") != 0) {
    return 1;
  }
  std::vector<uint8_t> status_bytes;
  const int32_t status = key_server_configure_runtime(config_frame->payload, config_frame->payload_length, status_bytes);
  if (status != 0) {
    plugin_set_error("configure-failed", "Failed to configure licensing runtime.");
    return status;
  }
  return emit("status", kLCF, status_bytes);
}

// module_descriptor $PLG + protected_content $FIL -> response $PLG. The content key is the secret config
// content_keys names for the descriptor's KEY_ID (PLUGIN_ID:VERSION when the descriptor names none).
int server_publish_module(void) {
  plugin_reset_output_state();
  const plugin_input_frame_t* descriptor_frame = nullptr;
  if (require_input("module_descriptor", &descriptor_frame, "missing-module-descriptor-input",
                    "Input port \"module_descriptor\" is required.") != 0) {
    return 1;
  }
  const plugin_input_frame_t* content_frame = nullptr;
  if (require_input("protected_content", &content_frame, "missing-protected-content-input",
                    "Input port \"protected_content\" is required.") != 0) {
    return 1;
  }
  const uint8_t* content = nullptr;
  uint32_t content_len = 0;
  if (!fil_content(content_frame, &content, &content_len)) {
    return fail("invalid-protected-content-input", "Input port \"protected_content\" must carry a $FIL with CONTENT.");
  }

  flatbuffers::Verifier verifier(descriptor_frame->payload, descriptor_frame->payload_length);
  if (!VerifyPLGBuffer(verifier)) {
    return fail("invalid-module-descriptor-input", "Input port \"module_descriptor\" must carry a $PLG.");
  }
  const auto* descriptor = GetPLG(descriptor_frame->payload);
  if (!descriptor || !descriptor->PLUGIN_ID() || !descriptor->VERSION()) {
    return fail("invalid-module-descriptor-input", "The $PLG must name PLUGIN_ID and VERSION.");
  }
  const std::string key_id = descriptor->KEY_ID() && descriptor->KEY_ID()->size() > 0
                                 ? descriptor->KEY_ID()->str()
                                 : descriptor->PLUGIN_ID()->str() + ":" + descriptor->VERSION()->str();

  std::string secret_id;
  std::string algorithm;
  std::string config_error;
  if (!licensing_host::content_key_entry(key_id, &secret_id, &algorithm, &config_error)) {
    return fail("invalid-content-key", "The module config content_keys names no secret for this descriptor's KEY_ID.");
  }
  keyMaterialRole role;
  keyMaterialAlgorithm key_algorithm;
  if (algorithm == "aes-256-gcm") {
    role = keyMaterialRole::PublicationContent;
    key_algorithm = keyMaterialAlgorithm::Aes256Gcm;
  } else if (algorithm == "x25519") {
    role = keyMaterialRole::DecryptKey;
    key_algorithm = keyMaterialAlgorithm::X25519Private;
  } else {
    return fail("invalid-content-key", "content_keys algorithm must be \"aes-256-gcm\" or \"x25519\".");
  }
  std::array<uint8_t, kKeyBytes> content_key{};
  if (!licensing_host::secret(secret_id, content_key.data(), content_key.size())) {
    return fail("invalid-content-key", "secrets.get did not answer a 32-byte content key for the configured ID.");
  }

  std::vector<uint8_t> response;
  const int32_t status = key_server_publish_module(
      descriptor_frame->payload, descriptor_frame->payload_length, content, content_len,
      content_key.data(), static_cast<uint32_t>(content_key.size()), role, key_algorithm, response);
  secure_zero(content_key.data(), content_key.size());
  if (status != 0) {
    plugin_set_error("publish-failed", "Failed to publish protected module.");
    return status;
  }
  return emit("response", kPLG, response);
}

// request $LCH -> challenge $LCH, or proof $LPF -> grant $LGR (an $LCH error answer goes on "challenge").
int server_handle_message(void) {
  plugin_reset_output_state();
  const auto* request = find_input_frame("request");
  const auto* proof = find_input_frame("proof");
  if ((request == nullptr) == (proof == nullptr)) {
    return fail("missing-request-input", "Exactly one of input ports \"request\" ($LCH) and \"proof\" ($LPF) is required.");
  }
  const auto* frame = request ? request : proof;
  const char* expected = request ? "$LCH" : "$LPF";
  if (frame->payload_length < 8 || !flatbuffers::BufferHasIdentifier(frame->payload, expected)) {
    return fail("invalid-request-input", "The input record is not its port's declared type.");
  }
  std::vector<uint8_t> response;
  const int32_t status = key_server_handle_message(frame->payload, frame->payload_length, response);
  if (status != 0) {
    plugin_set_error("server-handle-failed", "Failed to handle licensing delivery message.");
    return status;
  }
  if (response.size() >= 8 && flatbuffers::BufferHasIdentifier(response.data(), "$LGR")) {
    return emit("grant", kLGR, response);
  }
  return emit("challenge", kLCH, response);
}

// request $LCH -> response $LGR, signed with the requester seed config requester_signing_secret_id names.
int client_request_grant(void) {
  plugin_reset_output_state();
  const plugin_input_frame_t* request_frame = nullptr;
  if (require_input("request", &request_frame, "missing-request-input", "Input port \"request\" is required.") != 0) {
    return 1;
  }
  std::array<uint8_t, kKeyBytes> seed{};
  if (read_config_secret("requester_signing_secret_id", &seed, "invalid-requester-signing-key") != 0) {
    return 1;
  }
  std::vector<uint8_t> response;
  const int32_t status = license_client_request_grant(
      request_frame->payload, request_frame->payload_length, seed.data(), static_cast<uint32_t>(seed.size()), response);
  secure_zero(seed.data(), seed.size());
  if (status != 0) {
    plugin_set_error("grant-request-failed", "Failed to request licensing grant.");
    return status;
  }
  return emit("response", kLGR, response);
}

// grant_response $LGR (+ protected_content $FIL, else ipfs.cat of the granted CID) -> plaintext $FIL.
int client_fetch_and_decrypt(void) {
  plugin_reset_output_state();
  const plugin_input_frame_t* grant_frame = nullptr;
  if (require_input("grant_response", &grant_frame, "missing-input", "Input port \"grant_response\" is required.") != 0) {
    return 1;
  }
  const uint8_t* content = nullptr;
  uint32_t content_len = 0;
  if (const auto* content_frame = find_input_frame("protected_content")) {
    if (!fil_content(content_frame, &content, &content_len)) {
      return fail("invalid-protected-content-input", "Input port \"protected_content\" must carry a $FIL with CONTENT.");
    }
  }
  std::vector<uint8_t> plaintext;
  const int32_t status = license_client_fetch_and_decrypt(
      grant_frame->payload, grant_frame->payload_length, content, content_len, plaintext);
  if (status != 0) {
    plugin_set_error("decrypt-failed", "Failed to decrypt fetched content.");
    return status;
  }
  if (plaintext.empty()) return 0;
  const auto file = build_fil(plaintext);
  secure_zero(plaintext.data(), plaintext.size());
  return emit("plaintext", kFIL, file);
}

// protected_content $FIL + signer_key $KMF -> plaintext $FIL; the DEK is the secret config dek_secret_id names.
int decrypt_and_verify(void) {
  plugin_reset_output_state();
  const plugin_input_frame_t* content_frame = nullptr;
  const plugin_input_frame_t* signer_frame = nullptr;
  if (require_input("protected_content", &content_frame, "missing-input", "Input port \"protected_content\" is required.") != 0 ||
      require_input("signer_key", &signer_frame, "missing-input", "Input port \"signer_key\" is required.") != 0) {
    return 1;
  }
  const uint8_t* content = nullptr;
  uint32_t content_len = 0;
  if (!fil_content(content_frame, &content, &content_len)) {
    return fail("invalid-protected-content-input", "Input port \"protected_content\" must carry a $FIL with CONTENT.");
  }

  flatbuffers::Verifier verifier(signer_frame->payload, signer_frame->payload_length);
  if (!VerifyKMFBuffer(verifier)) {
    return fail("invalid-signer-key-input", "Input port \"signer_key\" must carry a $KMF verification key.");
  }
  const auto* signer = GetKMF(signer_frame->payload);
  if (!signer || !signer->KEY_BYTES() || signer->ROLE() != keyMaterialRole::VerificationKey ||
      signer->ALGORITHM() != keyMaterialAlgorithm::Ed25519Public ||
      signer->ENCODING() != keyMaterialEncoding::PublicKey32) {
    return fail("invalid-signer-key-input", "Input port \"signer_key\" must carry a $KMF verification key.");
  }
  std::vector<uint8_t> signer_key(signer->KEY_BYTES()->begin(), signer->KEY_BYTES()->end());

  std::array<uint8_t, kKeyBytes> dek{};
  if (read_config_secret("dek_secret_id", &dek, "invalid-dek") != 0) {
    return 1;
  }
  std::vector<uint8_t> plaintext;
  const int32_t status = license_client_decrypt_and_verify(
      content, content_len, dek.data(), static_cast<uint32_t>(dek.size()), signer_key.data(),
      static_cast<uint32_t>(signer_key.size()), plaintext);
  secure_zero(dek.data(), dek.size());
  if (status != 0) {
    plugin_set_error("decrypt-verify-failed", "Failed to decrypt and verify content.");
    return status;
  }
  if (plaintext.empty()) return 0;
  const auto file = build_fil(plaintext);
  secure_zero(plaintext.data(), plaintext.size());
  return emit("plaintext", kFIL, file);
}

}  // extern "C"
