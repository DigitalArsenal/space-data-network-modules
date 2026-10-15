#include "license_client_api.h"

#ifdef TIME_UTC
#undef TIME_UTC
#endif

#include "ENC_generated.h"
#include "LCH_generated.h"
#include "LGR_generated.h"
#include "LPF_generated.h"
#include "PLG_generated.h"
#include "REC_generated.h"

#include <flatbuffers/encryption.h>
#include <flatbuffers/flatbuffers.h>

#include <cryptopp/aes.h>
#include <cryptopp/eccrypto.h>
#include <cryptopp/gcm.h>
#include <cryptopp/hkdf.h>
#include <cryptopp/hmac.h>
#include <cryptopp/integer.h>
#include <cryptopp/oids.h>
#include <cryptopp/secblock.h>
#include <cryptopp/sha.h>
#include <cryptopp/xed25519.h>

#include <array>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "licensing_hostcalls.hpp"

namespace {

constexpr size_t kDekBytes = 32;
constexpr size_t kAesKeyBytes = 32;
constexpr size_t kGcmIvBytes = 12;
constexpr size_t kGcmTagBytes = 16;

constexpr int32_t kClientMalformed = -1;
constexpr int32_t kClientCryptoError = -5;
constexpr int32_t kClientInternalError = -7;
constexpr int32_t kClientInvalidSignature = -17;

constexpr const char* kModuleDeliveryProtocolId =
    "/space-data-network/module-delivery/1.0.0";
constexpr uint16_t kKmfKeyBytesFieldId = 4;
constexpr const char* kGrantPayloadContext =
    "space-data-network/module-delivery/grant/v1";

struct ClientGrantSession {
  std::array<uint8_t, 32> ephemeral_private_key{};
};


std::mutex g_client_grant_session_mutex;
std::unordered_map<std::string, ClientGrantSession> g_client_grant_sessions;

void secure_zero(void* ptr, size_t len) {
  if (!ptr || len == 0) {
    return;
  }
  volatile auto* bytes = static_cast<volatile uint8_t*>(ptr);
  for (size_t i = 0; i < len; ++i) {
    bytes[i] = 0;
  }
}

int64_t now_ms() {
  return licensing_host::now_ms();
}

bool fill_random_bytes(uint8_t* bytes, size_t len) {
  return licensing_host::random_bytes(bytes, len);
}

bool protocol_request(
    std::string_view target,
    std::string_view protocol_id,
    const uint8_t* payload,
    size_t payload_len,
    std::vector<uint8_t>* response_out) {
  return licensing_host::protocol_request(
      target, protocol_id, payload, payload_len, response_out);
}

bool ipfs_cat(
    std::string_view cid,
    std::vector<uint8_t>* response_out) {
  return licensing_host::ipfs_cat(cid, response_out);
}

uint32_t read_u32_le(const uint8_t* ptr) {
  uint32_t value = 0;
  value |= static_cast<uint32_t>(ptr[0]);
  value |= static_cast<uint32_t>(ptr[1]) << 8;
  value |= static_cast<uint32_t>(ptr[2]) << 16;
  value |= static_cast<uint32_t>(ptr[3]) << 24;
  return value;
}

bool aes_gcm_decrypt(
    const uint8_t* input,
    size_t input_len,
    const uint8_t key[kAesKeyBytes],
    std::vector<uint8_t>* plaintext_out) {
  if (!input || !plaintext_out || input_len < kGcmIvBytes + kGcmTagBytes) {
    return false;
  }
  const uint8_t* iv = input;
  const size_t ciphertext_len = input_len - kGcmIvBytes - kGcmTagBytes;
  const uint8_t* ciphertext = input + kGcmIvBytes;
  const uint8_t* tag = input + kGcmIvBytes + ciphertext_len;

  plaintext_out->assign(ciphertext_len, 0);
  CryptoPP::GCM<CryptoPP::AES>::Decryption dec;
  dec.SetKeyWithIV(key, kAesKeyBytes, iv, kGcmIvBytes);
  dec.SpecifyDataLengths(0, ciphertext_len, 0);
  dec.ProcessData(plaintext_out->data(), ciphertext, ciphertext_len);
  if (!dec.TruncatedVerify(tag, kGcmTagBytes)) {
    secure_zero(plaintext_out->data(), plaintext_out->size());
    plaintext_out->clear();
    return false;
  }
  return true;
}

bool parse_signed_payload(
    const uint8_t* signed_content,
    size_t signed_content_len,
    const uint8_t** content_ptr_out,
    size_t* content_len_out,
    const uint8_t** signature_ptr_out) {
  if (!signed_content || !content_ptr_out || !content_len_out || !signature_ptr_out ||
      signed_content_len < 68) {
    return false;
  }
  const uint32_t content_len = read_u32_le(signed_content + signed_content_len - 4);
  if (static_cast<size_t>(content_len) + 64 + 4 != signed_content_len) {
    return false;
  }
  *content_ptr_out = signed_content;
  *content_len_out = content_len;
  *signature_ptr_out = signed_content + content_len;
  return true;
}

bool ed25519_verify_detached(
    const uint8_t* message,
    size_t message_len,
    const uint8_t* public_key,
    size_t public_key_len,
    const uint8_t* signature,
    size_t signature_len,
    bool* valid_out) {
  if (!message || !public_key || !signature || !valid_out ||
      public_key_len != 32 || signature_len != 64) {
    return false;
  }
  return licensing_host::ed25519_verify(
      message, message_len, public_key, public_key_len, signature, signature_len, valid_out);
}

bool verify_signed_payload(
    const uint8_t* signed_content,
    size_t signed_content_len,
    const uint8_t* public_key,
    size_t public_key_len,
    bool* valid_out,
    const uint8_t** content_ptr_out,
    size_t* content_len_out) {
  if (!public_key || public_key_len != 32 || !valid_out) {
    return false;
  }
  const uint8_t* content_ptr = nullptr;
  const uint8_t* signature_ptr = nullptr;
  size_t content_len = 0;
  if (!parse_signed_payload(
          signed_content,
          signed_content_len,
          &content_ptr,
          &content_len,
          &signature_ptr)) {
    return false;
  }
  if (!ed25519_verify_detached(
          content_ptr,
          content_len,
          public_key,
          public_key_len,
          signature_ptr,
          64,
          valid_out)) {
    return false;
  }
  if (content_ptr_out) {
    *content_ptr_out = content_ptr;
  }
  if (content_len_out) {
    *content_len_out = content_len;
  }
  return true;
}

class HostRng : public CryptoPP::RandomNumberGenerator {
 public:
  void GenerateBlock(CryptoPP::byte* output, size_t size) override {
    if (!fill_random_bytes(output, size)) {
      throw std::runtime_error("host random generation failed");
    }
  }

  void IncorporateEntropy(const CryptoPP::byte*, size_t) override {}
};

bool ed25519_public_key_from_seed(
    const uint8_t* seed,
    size_t seed_len,
    std::array<uint8_t, 32>* public_key_out) {
  if (!seed || !public_key_out || seed_len != 32) {
    return false;
  }
  return licensing_host::ed25519_public_key_from_seed(
      seed, seed_len, public_key_out->data(), public_key_out->size());
}

bool ed25519_sign_detached(
    const uint8_t* message,
    size_t message_len,
    const uint8_t* seed,
    size_t seed_len,
    const uint8_t* public_key,
    size_t public_key_len,
    std::array<uint8_t, 64>* signature_out) {
  if (!message || !seed || !public_key || !signature_out ||
      seed_len != 32 || public_key_len != 32) {
    return false;
  }
  return licensing_host::ed25519_sign(
      message, message_len, seed, seed_len, signature_out->data(), signature_out->size());
}

bool generate_x25519_keypair(
    std::array<uint8_t, 32>* private_key_out,
    std::array<uint8_t, 32>* public_key_out) {
  if (!private_key_out || !public_key_out) {
    return false;
  }
  try {
    HostRng rng;
    CryptoPP::x25519 x25519_scheme;
    x25519_scheme.GeneratePrivateKey(rng, private_key_out->data());
    x25519_scheme.GeneratePublicKey(
        rng,
        private_key_out->data(),
        public_key_out->data());
    return true;
  } catch (...) {
    secure_zero(private_key_out->data(), private_key_out->size());
    secure_zero(public_key_out->data(), public_key_out->size());
    return false;
  }
}

bool store_client_grant_session(
    std::string_view request_id,
    const std::array<uint8_t, 32>& ephemeral_private_key) {
  if (request_id.empty()) {
    return false;
  }
  std::lock_guard<std::mutex> lock(g_client_grant_session_mutex);
  auto [it, inserted] = g_client_grant_sessions.emplace(
      std::string(request_id),
      ClientGrantSession{ephemeral_private_key});
  if (!inserted) {
    secure_zero(
        it->second.ephemeral_private_key.data(),
        it->second.ephemeral_private_key.size());
    it->second.ephemeral_private_key = ephemeral_private_key;
  }
  return true;
}

bool take_client_grant_session(
    std::string_view request_id,
    ClientGrantSession* session_out) {
  if (!session_out || request_id.empty()) {
    return false;
  }
  std::lock_guard<std::mutex> lock(g_client_grant_session_mutex);
  const auto it = g_client_grant_sessions.find(std::string(request_id));
  if (it == g_client_grant_sessions.end()) {
    return false;
  }
  *session_out = it->second;
  g_client_grant_sessions.erase(it);
  return true;
}

std::vector<uint8_t> build_lch_bytes(
    licensingChallengeMessageType message_type,
    licensingChallengeRole role,
    std::string_view request_id,
    std::string_view module_id,
    std::string_view module_version,
    std::string_view requester_peer_id,
    std::string_view requester_xpub,
    const uint8_t* requester_signing_pubkey,
    size_t requester_signing_pubkey_len,
    const uint8_t* requester_ephemeral_pubkey,
    size_t requester_ephemeral_pubkey_len,
    std::string_view requested_domain,
    uint64_t requested_timeout_ms,
    uint64_t requested_at_ms,
    const uint8_t* challenge_nonce,
    size_t challenge_nonce_len,
    uint64_t expires_at_ms,
    std::string_view provider_peer_id,
    std::string_view error_code,
    std::string_view error_message) {
  flatbuffers::FlatBufferBuilder builder(512);
  const auto request_id_offset = builder.CreateString(request_id.data(), request_id.size());
  const auto module_id_offset = builder.CreateString(module_id.data(), module_id.size());
  const auto module_version_offset =
      module_version.empty() ? 0 : builder.CreateString(module_version.data(), module_version.size());
  const auto requester_peer_id_offset =
      requester_peer_id.empty() ? 0 : builder.CreateString(requester_peer_id.data(), requester_peer_id.size());
  const auto requester_xpub_offset =
      requester_xpub.empty() ? 0 : builder.CreateString(requester_xpub.data(), requester_xpub.size());
  const auto requester_signing_pubkey_offset =
      requester_signing_pubkey_len == 0 ? 0 : builder.CreateVector(requester_signing_pubkey, requester_signing_pubkey_len);
  const auto requester_ephemeral_pubkey_offset =
      requester_ephemeral_pubkey_len == 0 ? 0 : builder.CreateVector(requester_ephemeral_pubkey, requester_ephemeral_pubkey_len);
  const auto requested_domain_offset =
      requested_domain.empty() ? 0 : builder.CreateString(requested_domain.data(), requested_domain.size());
  const auto challenge_nonce_offset =
      challenge_nonce_len == 0 ? 0 : builder.CreateVector(challenge_nonce, challenge_nonce_len);
  const auto provider_peer_id_offset =
      provider_peer_id.empty() ? 0 : builder.CreateString(provider_peer_id.data(), provider_peer_id.size());
  const auto error_code_offset =
      error_code.empty() ? 0 : builder.CreateString(error_code.data(), error_code.size());
  const auto error_message_offset =
      error_message.empty() ? 0 : builder.CreateString(error_message.data(), error_message.size());
  const auto root = CreateLCH(
      builder,
      message_type,
      role,
      request_id_offset,
      module_id_offset,
      module_version_offset,
      requester_peer_id_offset,
      requester_xpub_offset,
      requester_signing_pubkey_offset,
      requester_ephemeral_pubkey_offset,
      requested_domain_offset,
      requested_timeout_ms,
      requested_at_ms,
      challenge_nonce_offset,
      expires_at_ms,
      provider_peer_id_offset,
      error_code_offset,
      error_message_offset);
  FinishLCHBuffer(builder, root);
  return std::vector<uint8_t>(
      builder.GetBufferPointer(),
      builder.GetBufferPointer() + builder.GetSize());
}

std::vector<uint8_t> build_lpf_bytes(
    std::string_view request_id,
    std::string_view module_id,
    std::string_view module_version,
    std::string_view requester_peer_id,
    std::string_view requester_xpub,
    std::string_view requested_domain,
    uint64_t requested_timeout_ms,
    const uint8_t* requester_ephemeral_pubkey,
    size_t requester_ephemeral_pubkey_len,
    const uint8_t* challenge_nonce,
    size_t challenge_nonce_len,
    uint64_t challenge_expires_at,
    std::string_view provider_peer_id,
    const uint8_t* signature,
    size_t signature_len,
    const uint8_t* signing_pubkey,
    size_t signing_pubkey_len,
    uint64_t timestamp_ms) {
  flatbuffers::FlatBufferBuilder builder(512);
  const auto request_id_offset = builder.CreateString(request_id.data(), request_id.size());
  const auto module_id_offset = builder.CreateString(module_id.data(), module_id.size());
  const auto module_version_offset =
      module_version.empty() ? 0 : builder.CreateString(module_version.data(), module_version.size());
  const auto requester_peer_id_offset =
      requester_peer_id.empty() ? 0 : builder.CreateString(requester_peer_id.data(), requester_peer_id.size());
  const auto requester_xpub_offset =
      requester_xpub.empty() ? 0 : builder.CreateString(requester_xpub.data(), requester_xpub.size());
  const auto requested_domain_offset =
      requested_domain.empty() ? 0 : builder.CreateString(requested_domain.data(), requested_domain.size());
  const auto requester_ephemeral_pubkey_offset =
      requester_ephemeral_pubkey_len == 0 ? 0 : builder.CreateVector(requester_ephemeral_pubkey, requester_ephemeral_pubkey_len);
  const auto challenge_nonce_offset =
      challenge_nonce_len == 0 ? 0 : builder.CreateVector(challenge_nonce, challenge_nonce_len);
  const auto provider_peer_id_offset =
      provider_peer_id.empty() ? 0 : builder.CreateString(provider_peer_id.data(), provider_peer_id.size());
  const auto signature_offset =
      signature_len == 0 ? 0 : builder.CreateVector(signature, signature_len);
  const auto signing_pubkey_offset =
      signing_pubkey_len == 0 ? 0 : builder.CreateVector(signing_pubkey, signing_pubkey_len);
  const auto root = CreateLPF(
      builder,
      licensingProofMessageType::ProofRequest,
      request_id_offset,
      module_id_offset,
      module_version_offset,
      requester_peer_id_offset,
      requester_xpub_offset,
      requested_domain_offset,
      requested_timeout_ms,
      requester_ephemeral_pubkey_offset,
      challenge_nonce_offset,
      challenge_expires_at,
      provider_peer_id_offset,
      signature_offset,
      signing_pubkey_offset,
      timestamp_ms,
      0,
      0);
  FinishLPFBuffer(builder, root);
  return std::vector<uint8_t>(
      builder.GetBufferPointer(),
      builder.GetBufferPointer() + builder.GetSize());
}

bool grant_is_success(const LGR* grant) {
  return grant &&
         grant->MESSAGE_TYPE() == licensingGrantMessageType::Granted &&
         grant->WRAPPED_CONTENT_KEY_HEADER() != nullptr &&
         grant->WRAPPED_CONTENT_KEY_PAYLOAD() != nullptr &&
         grant->MODULE_DESCRIPTOR() != nullptr;
}

}  // namespace

int32_t license_client_request_grant(
    const uint8_t* request_bytes,
    uint32_t request_len,
    const uint8_t* requester_signing_seed,
    uint32_t requester_signing_seed_len,
    std::vector<uint8_t>& response_out) {
  response_out.clear();
  if (!request_bytes || request_len == 0 ||
      !requester_signing_seed || requester_signing_seed_len != 32) {
    return kClientMalformed;
  }

  flatbuffers::Verifier verifier(request_bytes, request_len);
  if (!VerifyLCHBuffer(verifier)) {
    return kClientMalformed;
  }
  const auto* request = GetLCH(request_bytes);
  if (!request ||
      request->MESSAGE_TYPE() != licensingChallengeMessageType::Request ||
      request->ROLE() != licensingChallengeRole::Requester ||
      !request->REQUEST_ID() ||
      !request->MODULE_ID() ||
      !request->REQUESTED_DOMAIN() ||
      !request->PROVIDER_PEER_ID()) {
    return kClientMalformed;
  }

  const std::string request_id = request->REQUEST_ID()->str();
  const std::string module_id = request->MODULE_ID()->str();
  const std::string module_version =
      request->MODULE_VERSION() ? request->MODULE_VERSION()->str() : std::string();
  const std::string requester_peer_id =
      request->REQUESTER_PEER_ID() ? request->REQUESTER_PEER_ID()->str() : std::string();
  const std::string requester_xpub =
      request->REQUESTER_XPUB() ? request->REQUESTER_XPUB()->str() : std::string();
  const std::string requester_domain = request->REQUESTED_DOMAIN()->str();
  const uint64_t requested_timeout_ms = request->REQUESTED_TIMEOUT_MS();
  const uint64_t requested_at_ms =
      request->REQUESTED_AT() != 0 ? request->REQUESTED_AT() : static_cast<uint64_t>(now_ms());
  const std::string provider_peer_id = request->PROVIDER_PEER_ID()->str();

  if (request_id.empty() || module_id.empty() || requester_domain.empty() ||
      provider_peer_id.empty() || requested_timeout_ms == 0) {
    return kClientMalformed;
  }

  std::array<uint8_t, 32> requester_signing_pubkey{};
  if (!ed25519_public_key_from_seed(
          requester_signing_seed,
          requester_signing_seed_len,
          &requester_signing_pubkey)) {
    return kClientCryptoError;
  }

  std::array<uint8_t, 32> requester_ephemeral_private{};
  std::array<uint8_t, 32> requester_ephemeral_public{};
  if (!generate_x25519_keypair(
          &requester_ephemeral_private,
          &requester_ephemeral_public)) {
    return kClientCryptoError;
  }

  const std::vector<uint8_t> outbound_request = build_lch_bytes(
      licensingChallengeMessageType::Request,
      licensingChallengeRole::Requester,
      request_id,
      module_id,
      module_version,
      requester_peer_id,
      requester_xpub,
      requester_signing_pubkey.data(),
      requester_signing_pubkey.size(),
      requester_ephemeral_public.data(),
      requester_ephemeral_public.size(),
      requester_domain,
      requested_timeout_ms,
      requested_at_ms,
      nullptr,
      0,
      0,
      provider_peer_id,
      {},
      {});

  std::vector<uint8_t> challenge_bytes;
  if (!protocol_request(
          provider_peer_id,
          kModuleDeliveryProtocolId,
          outbound_request.data(),
          outbound_request.size(),
          &challenge_bytes)) {
    secure_zero(
        requester_ephemeral_private.data(),
        requester_ephemeral_private.size());
    return kClientInternalError;
  }

  flatbuffers::Verifier challenge_verifier(
      challenge_bytes.data(),
      challenge_bytes.size());
  if (!VerifyLCHBuffer(challenge_verifier)) {
    secure_zero(
        requester_ephemeral_private.data(),
        requester_ephemeral_private.size());
    return kClientMalformed;
  }
  const auto* challenge = GetLCH(challenge_bytes.data());
  if (!challenge ||
      !challenge->REQUEST_ID() ||
      !challenge->MODULE_ID() ||
      challenge->REQUEST_ID()->str() != request_id ||
      challenge->MODULE_ID()->str() != module_id) {
    secure_zero(
        requester_ephemeral_private.data(),
        requester_ephemeral_private.size());
    return kClientMalformed;
  }
  if (challenge->MESSAGE_TYPE() == licensingChallengeMessageType::Error) {
    secure_zero(
        requester_ephemeral_private.data(),
        requester_ephemeral_private.size());
    response_out.assign(challenge_bytes.begin(), challenge_bytes.end());
    return 0;
  }
  if (challenge->MESSAGE_TYPE() != licensingChallengeMessageType::Response ||
      challenge->ROLE() != licensingChallengeRole::Provider ||
      !challenge->CHALLENGE_NONCE()) {
    secure_zero(
        requester_ephemeral_private.data(),
        requester_ephemeral_private.size());
    return kClientMalformed;
  }

  std::array<uint8_t, 64> signature{};
  if (!ed25519_sign_detached(
          challenge_bytes.data(),
          challenge_bytes.size(),
          requester_signing_seed,
          requester_signing_seed_len,
          requester_signing_pubkey.data(),
          requester_signing_pubkey.size(),
          &signature)) {
    secure_zero(
        requester_ephemeral_private.data(),
        requester_ephemeral_private.size());
    return kClientCryptoError;
  }

  const auto* challenge_nonce = challenge->CHALLENGE_NONCE();
  const std::vector<uint8_t> proof_bytes = build_lpf_bytes(
      request_id,
      module_id,
      module_version,
      requester_peer_id,
      requester_xpub,
      requester_domain,
      requested_timeout_ms,
      requester_ephemeral_public.data(),
      requester_ephemeral_public.size(),
      challenge_nonce ? challenge_nonce->Data() : nullptr,
      challenge_nonce ? challenge_nonce->size() : 0,
      challenge->EXPIRES_AT(),
      provider_peer_id,
      signature.data(),
      signature.size(),
      requester_signing_pubkey.data(),
      requester_signing_pubkey.size(),
      static_cast<uint64_t>(now_ms()));

  std::vector<uint8_t> grant_bytes;
  if (!protocol_request(
          provider_peer_id,
          kModuleDeliveryProtocolId,
          proof_bytes.data(),
          proof_bytes.size(),
          &grant_bytes)) {
    secure_zero(
        requester_ephemeral_private.data(),
        requester_ephemeral_private.size());
    return kClientInternalError;
  }

  flatbuffers::Verifier grant_verifier(grant_bytes.data(), grant_bytes.size());
  if (!VerifyLGRBuffer(grant_verifier)) {
    secure_zero(
        requester_ephemeral_private.data(),
        requester_ephemeral_private.size());
    return kClientMalformed;
  }
  const auto* grant = GetLGR(grant_bytes.data());
  if (!grant || !grant->REQUEST_ID() ||
      grant->REQUEST_ID()->str() != request_id) {
    secure_zero(
        requester_ephemeral_private.data(),
        requester_ephemeral_private.size());
    return kClientMalformed;
  }

  if (grant_is_success(grant) &&
      !store_client_grant_session(request_id, requester_ephemeral_private)) {
    secure_zero(
        requester_ephemeral_private.data(),
        requester_ephemeral_private.size());
    return kClientInternalError;
  }

  secure_zero(signature.data(), signature.size());
  secure_zero(
      requester_ephemeral_private.data(),
      requester_ephemeral_private.size());
  response_out.assign(grant_bytes.begin(), grant_bytes.end());
  return 0;
}

int32_t license_client_fetch_and_decrypt(
    const uint8_t* grant_response_bytes,
    uint32_t grant_response_len,
    const uint8_t* protected_content,
    uint32_t protected_content_len,
    std::vector<uint8_t>& plaintext_out) {
  plaintext_out.clear();
  if (!grant_response_bytes || grant_response_len == 0) {
    return kClientMalformed;
  }

  flatbuffers::Verifier verifier(grant_response_bytes, grant_response_len);
  if (!VerifyLGRBuffer(verifier)) {
    return kClientMalformed;
  }
  const auto* grant = GetLGR(grant_response_bytes);
  if (!grant_is_success(grant) || !grant->REQUEST_ID()) {
    return kClientMalformed;
  }

  ClientGrantSession session{};
  if (!take_client_grant_session(grant->REQUEST_ID()->string_view(), &session)) {
    return kClientInternalError;
  }

  const auto* wrapped_header = grant->WRAPPED_CONTENT_KEY_HEADER();
  const auto* wrapped_payload = grant->WRAPPED_CONTENT_KEY_PAYLOAD();
  const auto* descriptor = grant->MODULE_DESCRIPTOR();
  if (!wrapped_header || !wrapped_payload || !descriptor || !descriptor->WASM_CID() ||
      !wrapped_header->EPHEMERAL_PUBLIC_KEY() ||
      !wrapped_header->CONTEXT() ||
      !wrapped_header->ROOT_TYPE() ||
      wrapped_payload->size() == 0) {
    secure_zero(session.ephemeral_private_key.data(), session.ephemeral_private_key.size());
    return kClientMalformed;
  }
  if (wrapped_header->KEY_EXCHANGE() != KeyExchange::X25519 ||
      wrapped_header->SYMMETRIC() != SymmetricAlgo::AES_256_CTR ||
      wrapped_header->KEY_DERIVATION() != KDF::HKDF_SHA256 ||
      wrapped_header->ROOT_TYPE()->string_view() != "REC") {
    secure_zero(session.ephemeral_private_key.data(), session.ephemeral_private_key.size());
    return kClientMalformed;
  }

  std::vector<uint8_t> encrypted_content;
  if (protected_content && protected_content_len > 0) {
    encrypted_content.assign(
        protected_content,
        protected_content + protected_content_len);
  } else {
    if (!ipfs_cat(descriptor->WASM_CID()->string_view(), &encrypted_content)) {
      secure_zero(session.ephemeral_private_key.data(), session.ephemeral_private_key.size());
      return kClientInternalError;
    }
  }

  std::array<uint8_t, flatbuffers::kX25519SharedSecretSize> shared_secret{};
  if (!flatbuffers::X25519SharedSecret(
          session.ephemeral_private_key.data(),
          wrapped_header->EPHEMERAL_PUBLIC_KEY()->Data(),
          shared_secret.data())) {
    secure_zero(session.ephemeral_private_key.data(), session.ephemeral_private_key.size());
    secure_zero(shared_secret.data(), shared_secret.size());
    return kClientCryptoError;
  }

  std::array<uint8_t, flatbuffers::kEncryptionKeySize> payload_key{};
  const std::string_view context =
      wrapped_header->CONTEXT()->string_view().empty()
          ? std::string_view(kGrantPayloadContext)
          : wrapped_header->CONTEXT()->string_view();
  flatbuffers::DeriveSymmetricKey(
      shared_secret.data(),
      shared_secret.size(),
      reinterpret_cast<const uint8_t*>(context.data()),
      context.size(),
      payload_key.data());

  std::vector<uint8_t> decrypted_payload(
      wrapped_payload->begin(),
      wrapped_payload->end());
  flatbuffers::Verifier payload_verifier(
      decrypted_payload.data(),
      decrypted_payload.size());
  if (!VerifyRECBuffer(payload_verifier)) {
    secure_zero(session.ephemeral_private_key.data(), session.ephemeral_private_key.size());
    secure_zero(shared_secret.data(), shared_secret.size());
    secure_zero(payload_key.data(), payload_key.size());
    return kClientMalformed;
  }

  auto* rec = const_cast<REC*>(GetREC(decrypted_payload.data()));
  if (!rec || !rec->RECORDS() || rec->RECORDS()->size() != 1) {
    secure_zero(session.ephemeral_private_key.data(), session.ephemeral_private_key.size());
    secure_zero(shared_secret.data(), shared_secret.size());
    secure_zero(payload_key.data(), payload_key.size());
    return kClientMalformed;
  }
  const auto* record = rec->RECORDS()->Get(0);
  const auto* kmf = record ? record->value_as_KMF() : nullptr;
  auto* key_bytes = kmf
      ? const_cast<::flatbuffers::Vector<uint8_t>*>(kmf->KEY_BYTES())
      : nullptr;
  if (!kmf || !key_bytes || key_bytes->size() != kDekBytes) {
    secure_zero(session.ephemeral_private_key.data(), session.ephemeral_private_key.size());
    secure_zero(shared_secret.data(), shared_secret.size());
    secure_zero(payload_key.data(), payload_key.size());
    return kClientMalformed;
  }

  flatbuffers::EncryptionContext encryption_ctx(payload_key.data(), payload_key.size());
  flatbuffers::EncryptVector(
      const_cast<uint8_t*>(key_bytes->Data()),
      1,
      key_bytes->size(),
      encryption_ctx,
      kKmfKeyBytesFieldId,
      0);
  std::vector<uint8_t> content_key(key_bytes->begin(), key_bytes->end());

  const int32_t decrypt_status = license_client_decrypt(
      encrypted_content.data(),
      static_cast<uint32_t>(encrypted_content.size()),
      content_key.data(),
      static_cast<uint32_t>(content_key.size()),
      plaintext_out);
  secure_zero(session.ephemeral_private_key.data(), session.ephemeral_private_key.size());
  secure_zero(shared_secret.data(), shared_secret.size());
  secure_zero(payload_key.data(), payload_key.size());
  secure_zero(content_key.data(), content_key.size());
  secure_zero(decrypted_payload.data(), decrypted_payload.size());
  return decrypt_status;
}

int32_t license_client_fetch_protected_content(
    const uint8_t* descriptor_bytes,
    uint32_t descriptor_len,
    std::vector<uint8_t>& protected_content_out) {
  protected_content_out.clear();
  if (!descriptor_bytes || descriptor_len == 0) {
    return kClientMalformed;
  }

  flatbuffers::Verifier verifier(descriptor_bytes, descriptor_len);
  if (!VerifyPLGBuffer(verifier)) {
    return kClientMalformed;
  }
  const auto* descriptor = GetPLG(descriptor_bytes);
  if (!descriptor || !descriptor->WASM_CID()) {
    return kClientMalformed;
  }
  const std::string_view cid = descriptor->WASM_CID()->string_view();
  if (cid.empty()) {
    return kClientMalformed;
  }
  if (!ipfs_cat(cid, &protected_content_out) || protected_content_out.empty()) {
    return kClientInternalError;
  }
  return 0;
}

int32_t license_client_decrypt(
    const uint8_t* ciphertext,
    uint32_t ciphertext_len,
    const uint8_t* key,
    uint32_t key_len,
    std::vector<uint8_t>& plaintext_out) {
  if (!ciphertext || !key || key_len != 32) {
    return kClientMalformed;
  }
  return aes_gcm_decrypt(ciphertext, ciphertext_len, key, &plaintext_out)
             ? 0
             : kClientCryptoError;
}

int32_t license_client_decrypt_and_verify(
    const uint8_t* protected_content,
    uint32_t protected_content_len,
    const uint8_t* dek,
    uint32_t dek_len,
    const uint8_t* signer_key,
    uint32_t signer_key_len,
    std::vector<uint8_t>& plaintext_out) {
  if (!protected_content || !dek || !signer_key || dek_len != 32 || signer_key_len != 32) {
    return kClientMalformed;
  }

  std::vector<uint8_t> signed_content;
  if (!aes_gcm_decrypt(protected_content, protected_content_len, dek, &signed_content)) {
    return kClientCryptoError;
  }

  bool valid = false;
  const uint8_t* content_ptr = nullptr;
  size_t content_len = 0;
  if (!verify_signed_payload(
          signed_content.data(),
          signed_content.size(),
          signer_key,
          signer_key_len,
          &valid,
          &content_ptr,
          &content_len)) {
    secure_zero(signed_content.data(), signed_content.size());
    return kClientMalformed;
  }
  if (!valid) {
    secure_zero(signed_content.data(), signed_content.size());
    return kClientInvalidSignature;
  }

  plaintext_out.assign(content_ptr, content_ptr + content_len);
  secure_zero(signed_content.data(), signed_content.size());
  return 0;
}
