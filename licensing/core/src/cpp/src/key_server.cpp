#include "key_server_api.h"

#ifdef TIME_UTC
#undef TIME_UTC
#endif

#include "ENC_generated.h"
#include "LCF_generated.h"
#include "LCH_generated.h"
#include "LGR_generated.h"
#include "LPF_generated.h"
#include "PLG_generated.h"
#include "REC_generated.h"

#include "epm_authorize.h"  // shared isomorphic EPM verify + xpub gate (common/epm)
#include "grant_quota.h"

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

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "licensing_hostcalls.hpp"

namespace {

// Max age (seconds) of a re-sent EPM's SIGNATURE_TIMESTAMP accepted at grant time.
constexpr int64_t kEpmMaxAgeSeconds = 300;
constexpr size_t kDekBytes = 32;
constexpr int64_t kDefaultMaxSkewMs = 5LL * 60LL * 1000LL;
constexpr int64_t kDefaultChallengeTtlMs = 60LL * 1000LL;
// Grant handshakes waiting for their proof ($LCH answered, $LPF not yet in).
// Each lives at most CHALLENGE_TTL_MS (30 s on the node), and an honest console
// has at most ~25 open at once, so 512 is some twenty consoles opening in the
// same instant. An entry keeps the re-sent $EPM, which the node caps (with the
// whole request) at 16 KiB, so a full table holds at most ~8.5 MiB of the
// module's fixed 32 MiB.
constexpr size_t kMaxPendingGrants = 512;
constexpr const char* kProviderBusyReason = "provider_busy";
constexpr size_t kEncNonceBytes = 12;
constexpr size_t kRecipientKeyIdBytes = 8;
constexpr size_t kProviderSignatureBytes = 64;
constexpr uint16_t kKmfKeyBytesFieldId = 4;
constexpr const char* kGrantPayloadContext =
    "space-data-network/module-delivery/grant/v1";

enum ServerStatus : int32_t {
  kServerOk = 0,
  kServerMalformed = 1,
  kServerClockSkew = 3,
  kServerCryptoError = 5,
  kServerNotInitialized = 6,
  kServerInternalError = 7,
  kServerLicenseExpired = 8,
  kServerVersionNotFound = 9,
  kServerChallengeInvalid = 11,
  kServerChallengeExpired = 12,
  kServerChallengeReplay = 13,
  kServerChallengeRateLimited = 14,
  kServerUnauthorized = 15,
};

struct ModulePublication {
  PLGT descriptor{};
  std::vector<uint8_t> descriptor_bytes{};
  std::array<uint8_t, kDekBytes> content_key{};
  keyMaterialRole content_key_role = keyMaterialRole::PublicationContent;
  keyMaterialAlgorithm content_key_algorithm = keyMaterialAlgorithm::Aes256Gcm;
};

struct PendingGrantMessage {
  std::string request_id{};
  std::string publication_key{};
  std::string module_id{};
  std::string module_version{};
  std::string requester_peer_id{};
  std::string requester_xpub{};
  std::string requested_domain{};
  uint64_t requested_timeout_ms = 0;
  uint64_t requested_at_ms = 0;
  std::string provider_peer_id{};
  std::array<uint8_t, 32> requester_signing_pubkey{};
  std::array<uint8_t, 32> requester_ephemeral_pubkey{};
  std::array<uint8_t, 32> challenge_nonce{};
  uint64_t expires_at_ms = 0;
  std::vector<uint8_t> challenge_bytes{};
  std::vector<uint8_t> requester_epm{};  // re-sent $EPM; xpub binding verified at proof time
};

bool g_initialized = false;
int64_t g_expires_at_ms = 0;
int64_t g_max_skew_ms = kDefaultMaxSkewMs;
int64_t g_challenge_ttl_ms = kDefaultChallengeTtlMs;
uint32_t g_active_key_version = 1;
std::string g_provider_peer_id = "provider.orbpro.test";
// NOTE: there is deliberately no g_provider_signing_seed. The provider's
// ed25519 seed lives host-side in the keyslot named by
// g_provider_signing_slot_id; it never enters guest memory. Grant/challenge
// signing goes through licensing_host::keyslot_sign (a typed keyslot.sign hostcall)
// instead of a local ed25519 sign over a cached seed.
std::array<uint8_t, 32> g_provider_signing_public{};
std::string g_provider_signing_slot_id{};
std::string g_provider_wrapping_slot_id{};
std::vector<uint8_t> g_capability_token{};


std::mutex g_publication_mutex;
std::unordered_map<std::string, ModulePublication> g_publications;

std::mutex g_pending_grant_mutex;
std::unordered_map<std::string, PendingGrantMessage> g_pending_grants;

void secure_zero(void* ptr, size_t len) {
  if (!ptr || len == 0) {
    return;
  }
  volatile auto* bytes = static_cast<volatile uint8_t*>(ptr);
  for (size_t i = 0; i < len; ++i) {
    bytes[i] = 0;
  }
}

std::string make_publication_key(
    std::string_view module_id,
    std::string_view module_version) {
  return std::string(module_id) + "\n" + std::string(module_version);
}

void secure_zero_publication(ModulePublication* publication) {
  if (!publication) {
    return;
  }
  secure_zero(publication->content_key.data(), publication->content_key.size());
}

void clear_publications() {
  std::lock_guard<std::mutex> lock(g_publication_mutex);
  for (auto& entry : g_publications) {
    secure_zero_publication(&entry.second);
  }
  g_publications.clear();
}

bool load_publication(
    std::string_view publication_key,
    ModulePublication* publication_out) {
  if (!publication_out) {
    return false;
  }
  std::lock_guard<std::mutex> lock(g_publication_mutex);
  const auto it = g_publications.find(std::string(publication_key));
  if (it == g_publications.end()) {
    return false;
  }
  *publication_out = it->second;
  return true;
}

bool ipfs_add_bytes(
    const uint8_t* payload,
    size_t payload_len,
    std::string* cid_out) {
  return licensing_host::ipfs_add(payload, payload_len, cid_out);
}

std::vector<uint8_t> sha256_bytes(const uint8_t* payload, size_t payload_len) {
  std::vector<uint8_t> digest(CryptoPP::SHA256::DIGESTSIZE, 0);
  CryptoPP::SHA256 sha256;
  if (payload_len > 0) {
    sha256.Update(payload, payload_len);
  }
  sha256.Final(digest.data());
  return digest;
}

std::vector<uint8_t> build_plg_bytes(const PLGT& descriptor) {
  flatbuffers::FlatBufferBuilder builder(1024);
  const auto root = CreatePLG(builder, &descriptor);
  FinishPLGBuffer(builder, root);
  return std::vector<uint8_t>(
      builder.GetBufferPointer(),
      builder.GetBufferPointer() + builder.GetSize());
}

int64_t now_ms() {
  return licensing_host::now_ms();
}

bool fill_random_bytes(uint8_t* bytes, size_t len) {
  return licensing_host::random_bytes(bytes, len);
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

void secure_zero_pending_grant(PendingGrantMessage* pending) {
  secure_zero(
      pending->requester_signing_pubkey.data(),
      pending->requester_signing_pubkey.size());
  secure_zero(
      pending->requester_ephemeral_pubkey.data(),
      pending->requester_ephemeral_pubkey.size());
  secure_zero(pending->challenge_nonce.data(), pending->challenge_nonce.size());
}

void clear_pending_grants() {
  std::lock_guard<std::mutex> lock(g_pending_grant_mutex);
  for (auto& entry : g_pending_grants) {
    secure_zero_pending_grant(&entry.second);
  }
  g_pending_grants.clear();
}

// Drop handshakes whose challenge has expired: their proof is refused anyway.
void cleanup_pending_grants_locked(int64_t now) {
  for (auto it = g_pending_grants.begin(); it != g_pending_grants.end();) {
    if (it->second.expires_at_ms <= static_cast<uint64_t>(now)) {
      secure_zero_pending_grant(&it->second);
      it = g_pending_grants.erase(it);
    } else {
      ++it;
    }
  }
}

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

// secp256k1 ECDSA verify over the canonical EPM content. The host op does the
// sha256(message) + DER-verify internally (contract: op "crypto.secp256k1.verify",
// inputs {message, signature, publicKey}), mirroring the ed25519 host call. The
// signature is DER (variable length) and the public key is a SEC1 point (33-byte
// compressed or 65-byte uncompressed).
bool secp256k1_verify_detached(
    const uint8_t* message,
    size_t message_len,
    const uint8_t* public_key,
    size_t public_key_len,
    const uint8_t* signature,
    size_t signature_len,
    bool* valid_out) {
  if (!message || !public_key || !signature || !valid_out ||
      (public_key_len != 33 && public_key_len != 65) || signature_len == 0) {
    return false;
  }
  return licensing_host::secp256k1_verify(
      message, message_len, public_key, public_key_len, signature, signature_len, valid_out);
}

// Module-delivery xpub gate: verify a re-sent $EPM (shared isomorphic common code)
// and decide membership against the per-module allowlist. The ed25519 verify is the
// module's host call, so the same gate logic runs in the browser and on wasmedge.
// Wired into the grant flow once the message carries the EPM (LCH.REQUESTER_EPM)
// and the per-module allowlist arrives (PLG.ALLOWED_XPUBS).
[[maybe_unused]] sdn::epm::AuthorizeResult authorize_requester_epm(
    const uint8_t* epm_bytes,
    size_t epm_len,
    const uint8_t* proven_signing_pubkey,
    const std::vector<std::string>& allowed_xpubs,
    int64_t now_unix,
    int64_t max_age_seconds,
    const std::string& requested_domain) {
  const sdn::epm::Ed25519Verify verify =
      [](const uint8_t* m, size_t ml, const uint8_t* s, size_t sl, const uint8_t* p) -> bool {
        bool valid = false;
        return ed25519_verify_detached(m, ml, p, 32, s, sl, &valid) && valid;
      };
  const sdn::epm::Secp256k1Verify verify_secp256k1 =
      [](const uint8_t* m, size_t ml, const uint8_t* s, size_t sl,
         const uint8_t* p, size_t pl) -> bool {
        bool valid = false;
        return secp256k1_verify_detached(m, ml, p, pl, s, sl, &valid) && valid;
      };
  return sdn::epm::AuthorizeModuleRequest(
      epm_bytes, epm_len, proven_signing_pubkey, allowed_xpubs, now_unix, max_age_seconds,
      verify, verify_secp256k1, requested_domain);
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

bool parse_runtime_config_lcf(
    const uint8_t* config_bytes,
    uint32_t config_len,
    std::array<uint8_t, 32>* provider_signing_public_out,
    std::string* provider_signing_slot_id_out,
    std::string* provider_wrapping_slot_id_out,
    std::string* provider_peer_id_out,
    std::vector<uint8_t>* capability_token_out,
    int64_t* expires_at_ms_out,
    int64_t* max_skew_ms_out,
    int64_t* challenge_ttl_ms_out,
    uint32_t* key_version_out) {
  if (!config_bytes || config_len == 0 ||
      !provider_signing_public_out ||
      !provider_signing_slot_id_out || !provider_wrapping_slot_id_out ||
      !provider_peer_id_out || !capability_token_out ||
      !expires_at_ms_out || !max_skew_ms_out ||
      !challenge_ttl_ms_out || !key_version_out) {
    return false;
  }

  flatbuffers::Verifier verifier(config_bytes, config_len);
  if (!VerifyLCFBuffer(verifier)) {
    return false;
  }
  const auto* config = GetLCF(config_bytes);
  if (!config ||
      config->MESSAGE_TYPE() != licensingConfigMessageType::Configure ||
      config->ROLE() != licensingConfigRole::Provider ||
      !config->PROVIDER_PEER_ID() ||
      !config->PROVIDER_SIGNING_KEY() ||
      !config->PROVIDER_SIGNING_KEY()->SLOT_ID()) {
    return false;
  }

  const auto* signing_key = config->PROVIDER_SIGNING_KEY();
  const std::string signing_slot_id = signing_key->SLOT_ID()->str();
  if (signing_slot_id.empty()) {
    return false;
  }

  // The provider's ed25519 seed lives host-side in this slot; grant and
  // challenge signing goes through a keyslot.sign hostcall at the point of
  // use (see licensing_host::keyslot_sign), never through a locally-held seed.
  // The public key can therefore only be learned here when the host
  // includes it inline in PROVIDER_SIGNING_KEY.PUBLIC_KEY — leave it
  // zeroed when absent rather than failing configuration, since
  // keyslot.sign itself does not depend on the guest knowing the public
  // key.
  provider_signing_public_out->fill(0);
  if (signing_key->PUBLIC_KEY() &&
      signing_key->PUBLIC_KEY()->size() == provider_signing_public_out->size()) {
    std::memcpy(
        provider_signing_public_out->data(),
        signing_key->PUBLIC_KEY()->data(),
        provider_signing_public_out->size());
  }

  *provider_signing_slot_id_out = signing_slot_id;
  *provider_wrapping_slot_id_out =
      config->PROVIDER_WRAPPING_KEY() && config->PROVIDER_WRAPPING_KEY()->SLOT_ID()
          ? config->PROVIDER_WRAPPING_KEY()->SLOT_ID()->str()
          : std::string();
  *provider_peer_id_out = config->PROVIDER_PEER_ID()->str();
  if (config->CAPABILITY_TOKEN()) {
    capability_token_out->assign(
        config->CAPABILITY_TOKEN()->begin(),
        config->CAPABILITY_TOKEN()->end());
  } else {
    capability_token_out->clear();
  }
  *expires_at_ms_out = static_cast<int64_t>(config->EXPIRES_AT());
  *max_skew_ms_out =
      config->MAX_CLOCK_SKEW_MS() > 0
          ? static_cast<int64_t>(config->MAX_CLOCK_SKEW_MS())
          : kDefaultMaxSkewMs;
  *challenge_ttl_ms_out =
      config->CHALLENGE_TTL_MS() > 0
          ? static_cast<int64_t>(config->CHALLENGE_TTL_MS())
          : kDefaultChallengeTtlMs;
  *key_version_out =
      config->ACTIVE_KEY_VERSION() > 0 ? config->ACTIVE_KEY_VERSION() : 1u;
  return !provider_peer_id_out->empty();
}

std::vector<uint8_t> build_lcf_status_bytes(
    bool needs_rotation,
    std::string_view status_code = {},
    std::string_view status_message = {}) {
  flatbuffers::FlatBufferBuilder builder(512);

  auto signing_key_ref = std::make_unique<KRFT>();
  signing_key_ref->KEY_ID = "licensing.provider.signing";
  signing_key_ref->SLOT_ID = g_provider_signing_slot_id;
  signing_key_ref->ROLE = keyReferenceRole::ProviderSigning;
  signing_key_ref->ALGORITHM = keyReferenceAlgorithm::Ed25519Seed;
  signing_key_ref->PUBLIC_KEY.assign(
      g_provider_signing_public.begin(),
      g_provider_signing_public.end());
  signing_key_ref->VERSION = g_active_key_version;
  signing_key_ref->EXPIRES_AT = g_expires_at_ms > 0 ? static_cast<uint64_t>(g_expires_at_ms) : 0;
  signing_key_ref->HOST_MANAGED = true;

  std::unique_ptr<KRFT> wrapping_key_ref{};
  if (!g_provider_wrapping_slot_id.empty()) {
    wrapping_key_ref = std::make_unique<KRFT>();
    wrapping_key_ref->KEY_ID = "licensing.provider.wrapping";
    wrapping_key_ref->SLOT_ID = g_provider_wrapping_slot_id;
    wrapping_key_ref->ROLE = keyReferenceRole::ProviderWrapping;
    wrapping_key_ref->ALGORITHM = keyReferenceAlgorithm::X25519Private;
    wrapping_key_ref->VERSION = g_active_key_version;
    wrapping_key_ref->EXPIRES_AT =
        g_expires_at_ms > 0 ? static_cast<uint64_t>(g_expires_at_ms) : 0;
    wrapping_key_ref->HOST_MANAGED = true;
  }

  LCFT status{};
  status.MESSAGE_TYPE = licensingConfigMessageType::Status;
  status.ROLE = licensingConfigRole::Provider;
  status.PROVIDER_PEER_ID = g_provider_peer_id;
  status.PROVIDER_SIGNING_KEY = std::move(signing_key_ref);
  status.PROVIDER_WRAPPING_KEY = std::move(wrapping_key_ref);
  status.ACTIVE_KEY_VERSION = g_active_key_version;
  status.EXPIRES_AT = g_expires_at_ms > 0 ? static_cast<uint64_t>(g_expires_at_ms) : 0;
  status.MAX_CLOCK_SKEW_MS = g_max_skew_ms > 0 ? static_cast<uint64_t>(g_max_skew_ms) : 0;
  status.CHALLENGE_TTL_MS =
      g_challenge_ttl_ms > 0 ? static_cast<uint64_t>(g_challenge_ttl_ms) : 0;
  status.CAPABILITY_TOKEN = g_capability_token;
  status.INITIALIZED = g_initialized;
  status.NEEDS_ROTATION = needs_rotation;
  status.STATUS_CODE = std::string(status_code);
  status.STATUS_MESSAGE = std::string(status_message);

  const auto root = CreateLCF(builder, &status);
  FinishLCFBuffer(builder, root);
  return std::vector<uint8_t>(
      builder.GetBufferPointer(),
      builder.GetBufferPointer() + builder.GetSize());
}

struct WrappedGrantPayload {
  std::array<uint8_t, flatbuffers::kX25519PublicKeySize>
      provider_ephemeral_public_key{};
  std::array<uint8_t, kEncNonceBytes> nonce_start{};
  std::array<uint8_t, kRecipientKeyIdBytes> recipient_key_id{};
  std::vector<uint8_t> payload{};
};

::flatbuffers::Offset<ENC> build_enc_offset(
    ::flatbuffers::FlatBufferBuilder& builder,
    const WrappedGrantPayload& wrapped) {
  const auto provider_ephemeral_pubkey_offset = builder.CreateVector(
      wrapped.provider_ephemeral_public_key.data(),
      wrapped.provider_ephemeral_public_key.size());
  const auto nonce_start_offset = builder.CreateVector(
      wrapped.nonce_start.data(),
      wrapped.nonce_start.size());
  const auto recipient_key_id_offset = builder.CreateVector(
      wrapped.recipient_key_id.data(),
      wrapped.recipient_key_id.size());
  const auto context_offset = builder.CreateString(kGrantPayloadContext);
  const auto root_type_offset = builder.CreateString("REC");
  return CreateENC(
      builder,
      1,
      KeyExchange::X25519,
      SymmetricAlgo::AES_256_CTR,
      KDF::HKDF_SHA256,
      provider_ephemeral_pubkey_offset,
      nonce_start_offset,
      recipient_key_id_offset,
      context_offset,
      0,
      root_type_offset,
      0);
}

bool derive_recipient_key_id(
    const uint8_t* requester_ephemeral_pubkey,
    size_t requester_ephemeral_pubkey_len,
    std::array<uint8_t, kRecipientKeyIdBytes>* recipient_key_id_out) {
  if (!requester_ephemeral_pubkey || requester_ephemeral_pubkey_len != 32 ||
      !recipient_key_id_out) {
    return false;
  }
  std::array<uint8_t, 32> recipient_hash{};
  flatbuffers::Sha256Hash(
      requester_ephemeral_pubkey,
      requester_ephemeral_pubkey_len,
      recipient_hash.data());
  std::copy_n(
      recipient_hash.begin(),
      recipient_key_id_out->size(),
      recipient_key_id_out->begin());
  secure_zero(recipient_hash.data(), recipient_hash.size());
  return true;
}

bool build_wrapped_content_key_payload(
    std::string_view content_key_id,
    uint64_t expires_at_ms,
    keyMaterialRole content_key_role,
    keyMaterialAlgorithm content_key_algorithm,
    const uint8_t* content_key,
    size_t content_key_len,
    std::vector<uint8_t>* payload_out) {
  if (!content_key || content_key_len != 32 || !payload_out) {
    return false;
  }

  ::flatbuffers::FlatBufferBuilder builder(512);
  const auto key_id_offset =
      content_key_id.empty()
          ? 0
          : builder.CreateString(content_key_id.data(), content_key_id.size());
  const auto key_bytes_offset = builder.CreateVector(content_key, content_key_len);
  const auto kmf_offset = CreateKMF(
      builder,
      key_id_offset,
      content_key_role,
      content_key_algorithm,
      keyMaterialEncoding::RawBytes,
      key_bytes_offset,
      0,
      expires_at_ms);
  const auto standard_offset = builder.CreateString("KMF");
  const auto record_offset = CreateRecord(
      builder,
      RecordType::KMF,
      kmf_offset.Union(),
      standard_offset);
  const std::array<::flatbuffers::Offset<Record>, 1> records = {record_offset};
  const auto version_offset = builder.CreateString("1.0");
  const auto records_offset = builder.CreateVector(records.data(), records.size());
  const auto rec_offset = CreateREC(builder, version_offset, records_offset);
  FinishRECBuffer(builder, rec_offset);
  payload_out->assign(
      builder.GetBufferPointer(),
      builder.GetBufferPointer() + builder.GetSize());
  return true;
}

std::vector<uint8_t> build_lgr_granted_bytes(
    std::string_view request_id,
    std::string_view module_id,
    std::string_view module_version,
    std::string_view requester_peer_id,
    std::string_view requester_xpub,
    std::string_view requested_domain,
    uint64_t requested_timeout_ms,
    uint64_t expires_at_ms,
    std::string_view required_scope,
    const std::vector<uint8_t>& capability_token,
    const PLGT& descriptor,
    const WrappedGrantPayload& wrapped,
    const std::array<uint8_t, 32>& provider_signing_public,
    const uint8_t* provider_signature,
    size_t provider_signature_len) {
  flatbuffers::FlatBufferBuilder builder(2048);
  const auto request_id_offset =
      builder.CreateString(request_id.data(), request_id.size());
  const auto module_id_offset =
      builder.CreateString(module_id.data(), module_id.size());
  const auto module_version_offset =
      module_version.empty()
          ? 0
          : builder.CreateString(module_version.data(), module_version.size());
  const auto requester_peer_id_offset =
      requester_peer_id.empty()
          ? 0
          : builder.CreateString(requester_peer_id.data(), requester_peer_id.size());
  const auto requester_xpub_offset =
      requester_xpub.empty()
          ? 0
          : builder.CreateString(requester_xpub.data(), requester_xpub.size());
  const auto requested_domain_offset =
      requested_domain.empty()
          ? 0
          : builder.CreateString(requested_domain.data(), requested_domain.size());
  const auto granted_domain_offset =
      requested_domain.empty()
          ? 0
          : builder.CreateString(requested_domain.data(), requested_domain.size());
  const auto required_scope_offset =
      required_scope.empty()
          ? 0
          : builder.CreateString(required_scope.data(), required_scope.size());
  const auto grant_status_offset = builder.CreateString("granted");
  const auto capability_token_offset =
      capability_token.empty()
          ? 0
          : builder.CreateVector(capability_token.data(), capability_token.size());
  const auto descriptor_offset = CreatePLG(builder, &descriptor);
  const auto wrapped_header_offset = build_enc_offset(builder, wrapped);
  const auto wrapped_payload_offset =
      wrapped.payload.empty()
          ? 0
          : builder.CreateVector(wrapped.payload.data(), wrapped.payload.size());
  const auto verifier_pubkey_offset = builder.CreateVector(
      provider_signing_public.data(),
      provider_signing_public.size());
  const auto provider_signature_offset =
      provider_signature_len == 0 || !provider_signature
          ? 0
          : builder.CreateVector(provider_signature, provider_signature_len);

  const auto root = CreateLGR(
      builder,
      licensingGrantMessageType::Granted,
      request_id_offset,
      module_id_offset,
      module_version_offset,
      requester_peer_id_offset,
      requester_xpub_offset,
      requested_domain_offset,
      requested_timeout_ms,
      granted_domain_offset,
      requested_timeout_ms,
      expires_at_ms,
      required_scope_offset,
      grant_status_offset,
      0,
      capability_token_offset,
      descriptor_offset,
      wrapped_header_offset,
      wrapped_payload_offset,
      verifier_pubkey_offset,
      provider_signature_offset);
  FinishLGRBuffer(builder, root);
  return std::vector<uint8_t>(
      builder.GetBufferPointer(),
      builder.GetBufferPointer() + builder.GetSize());
}

bool replace_lgr_provider_signature(
    std::vector<uint8_t>* grant_bytes,
    const uint8_t* provider_signature,
    size_t provider_signature_len) {
  if (!grant_bytes || !provider_signature ||
      provider_signature_len != kProviderSignatureBytes ||
      grant_bytes->empty()) {
    return false;
  }
  flatbuffers::Verifier verifier(grant_bytes->data(), grant_bytes->size());
  if (!VerifyLGRBuffer(verifier)) {
    return false;
  }
  auto* grant = flatbuffers::GetMutableRoot<LGR>(grant_bytes->data());
  if (!grant) {
    return false;
  }
  const auto* signature_vector = grant->PROVIDER_SIGNATURE();
  if (!signature_vector ||
      signature_vector->size() != provider_signature_len) {
    return false;
  }
  std::memcpy(
      const_cast<uint8_t*>(signature_vector->Data()),
      provider_signature,
      provider_signature_len);
  return true;
}

std::vector<uint8_t> build_lgr_denied_bytes(
    std::string_view request_id,
    std::string_view module_id,
    std::string_view module_version,
    std::string_view requester_peer_id,
    std::string_view requester_xpub,
    std::string_view requested_domain,
    uint64_t requested_timeout_ms,
    uint64_t expires_at_ms,
    std::string_view required_scope,
    std::string_view denial_reason,
    const std::array<uint8_t, 32>& provider_signing_public) {
  flatbuffers::FlatBufferBuilder builder(512);
  const auto request_id_offset =
      builder.CreateString(request_id.data(), request_id.size());
  const auto module_id_offset =
      builder.CreateString(module_id.data(), module_id.size());
  const auto module_version_offset =
      module_version.empty()
          ? 0
          : builder.CreateString(module_version.data(), module_version.size());
  const auto requester_peer_id_offset =
      requester_peer_id.empty()
          ? 0
          : builder.CreateString(requester_peer_id.data(), requester_peer_id.size());
  const auto requester_xpub_offset =
      requester_xpub.empty()
          ? 0
          : builder.CreateString(requester_xpub.data(), requester_xpub.size());
  const auto requested_domain_offset =
      requested_domain.empty()
          ? 0
          : builder.CreateString(requested_domain.data(), requested_domain.size());
  const auto required_scope_offset =
      required_scope.empty()
          ? 0
          : builder.CreateString(required_scope.data(), required_scope.size());
  const auto grant_status_offset = builder.CreateString("denied");
  const auto denial_reason_offset =
      denial_reason.empty()
          ? 0
          : builder.CreateString(denial_reason.data(), denial_reason.size());
  const auto verifier_pubkey_offset = builder.CreateVector(
      provider_signing_public.data(),
      provider_signing_public.size());
  const auto root = CreateLGR(
      builder,
      licensingGrantMessageType::Denied,
      request_id_offset,
      module_id_offset,
      module_version_offset,
      requester_peer_id_offset,
      requester_xpub_offset,
      requested_domain_offset,
      requested_timeout_ms,
      0,
      0,
      expires_at_ms,
      required_scope_offset,
      grant_status_offset,
      denial_reason_offset,
      0,
      0,
      0,
      0,
      verifier_pubkey_offset,
      0);
  FinishLGRBuffer(builder, root);
  return std::vector<uint8_t>(
      builder.GetBufferPointer(),
      builder.GetBufferPointer() + builder.GetSize());
}

bool wrap_content_key_for_requester(
    const uint8_t* requester_ephemeral_pubkey,
    size_t requester_ephemeral_pubkey_len,
    std::string_view content_key_id,
    uint64_t expires_at_ms,
    keyMaterialRole content_key_role,
    keyMaterialAlgorithm content_key_algorithm,
    const uint8_t* content_key,
    size_t content_key_len,
    WrappedGrantPayload* wrapped_out) {
  if (!requester_ephemeral_pubkey || requester_ephemeral_pubkey_len != 32 ||
      !content_key || content_key_len != 32 || !wrapped_out) {
    return false;
  }

  try {
    if (!derive_recipient_key_id(
            requester_ephemeral_pubkey,
            requester_ephemeral_pubkey_len,
            &wrapped_out->recipient_key_id)) {
      return false;
    }

    if (!build_wrapped_content_key_payload(
            content_key_id,
            expires_at_ms,
            content_key_role,
            content_key_algorithm,
            content_key,
            content_key_len,
            &wrapped_out->payload)) {
      return false;
    }

    HostRng rng;
    rng.GenerateBlock(wrapped_out->nonce_start.data(), wrapped_out->nonce_start.size());

    CryptoPP::x25519 x25519_scheme;
    std::array<uint8_t, flatbuffers::kX25519PrivateKeySize> provider_ephemeral_private{};
    std::array<uint8_t, flatbuffers::kX25519PublicKeySize> provider_ephemeral_public{};
    x25519_scheme.GeneratePrivateKey(rng, provider_ephemeral_private.data());
    x25519_scheme.GeneratePublicKey(
        rng,
        provider_ephemeral_private.data(),
        provider_ephemeral_public.data());
    std::copy_n(
        provider_ephemeral_public.begin(),
        wrapped_out->provider_ephemeral_public_key.size(),
        wrapped_out->provider_ephemeral_public_key.begin());

    std::array<uint8_t, flatbuffers::kX25519SharedSecretSize> shared_secret{};
    if (!x25519_scheme.Agree(
            shared_secret.data(),
            provider_ephemeral_private.data(),
            requester_ephemeral_pubkey)) {
      secure_zero(provider_ephemeral_private.data(), provider_ephemeral_private.size());
      secure_zero(shared_secret.data(), shared_secret.size());
      return false;
    }

    std::array<uint8_t, flatbuffers::kEncryptionKeySize> symmetric_key{};
    flatbuffers::DeriveSymmetricKey(
        shared_secret.data(),
        shared_secret.size(),
        reinterpret_cast<const uint8_t*>(kGrantPayloadContext),
        std::strlen(kGrantPayloadContext),
        symmetric_key.data());

    auto* rec = const_cast<REC*>(GetREC(wrapped_out->payload.data()));
    if (!rec || !rec->RECORDS() || rec->RECORDS()->size() != 1) {
      secure_zero(shared_secret.data(), shared_secret.size());
      secure_zero(symmetric_key.data(), symmetric_key.size());
      return false;
    }
    const auto* record = rec->RECORDS()->Get(0);
    const auto* kmf = record ? record->value_as_KMF() : nullptr;
    auto* key_bytes = kmf
        ? const_cast<::flatbuffers::Vector<uint8_t>*>(kmf->KEY_BYTES())
        : nullptr;
    if (!key_bytes || key_bytes->size() != content_key_len) {
      secure_zero(shared_secret.data(), shared_secret.size());
      secure_zero(symmetric_key.data(), symmetric_key.size());
      return false;
    }

    flatbuffers::EncryptionContext encryption_ctx(
        symmetric_key.data(), symmetric_key.size());
    flatbuffers::EncryptVector(
        const_cast<uint8_t*>(key_bytes->Data()),
        1,
        key_bytes->size(),
        encryption_ctx,
        kKmfKeyBytesFieldId,
        0);

    secure_zero(provider_ephemeral_private.data(), provider_ephemeral_private.size());
    secure_zero(shared_secret.data(), shared_secret.size());
    secure_zero(symmetric_key.data(), symmetric_key.size());
    return true;
  } catch (...) {
    wrapped_out->payload.clear();
    return false;
  }
}

// The $LGR grant for an authorised request: the content key wrapped to the
// requester's session X25519 key, signed by the provider's host-held key.
int32_t build_signed_grant(
    const PendingGrantMessage& pending,
    const ModulePublication& publication,
    std::vector<uint8_t>* grant_out) {
  WrappedGrantPayload wrapped{};
  if (!wrap_content_key_for_requester(
          pending.requester_ephemeral_pubkey.data(),
          pending.requester_ephemeral_pubkey.size(),
          publication.descriptor.KEY_ID,
          pending.expires_at_ms,
          publication.content_key_role,
          publication.content_key_algorithm,
          publication.content_key.data(),
          publication.content_key.size(),
          &wrapped)) {
    return kServerCryptoError;
  }
  std::array<uint8_t, kProviderSignatureBytes> zero_provider_signature{};
  std::vector<uint8_t> grant_response_bytes = build_lgr_granted_bytes(
      pending.request_id,
      pending.module_id,
      pending.module_version,
      pending.requester_peer_id,
      pending.requester_xpub,
      pending.requested_domain,
      pending.requested_timeout_ms,
      pending.expires_at_ms,
      publication.descriptor.REQUIRED_SCOPE,
      g_capability_token,
      publication.descriptor,
      wrapped,
      g_provider_signing_public,
      zero_provider_signature.data(),
      zero_provider_signature.size());
  // The provider's ed25519 seed never enters guest memory: the host signs
  // the grant on the module's behalf (keyslot.sign) and returns only the
  // resulting signature.
  std::vector<uint8_t> provider_signature;
  const bool signed_ok =
      licensing_host::keyslot_sign(
          g_provider_signing_slot_id,
          grant_response_bytes.data(),
          grant_response_bytes.size(),
          &provider_signature) &&
      provider_signature.size() == kProviderSignatureBytes &&
      replace_lgr_provider_signature(
          &grant_response_bytes,
          provider_signature.data(),
          provider_signature.size());
  secure_zero(provider_signature.data(), provider_signature.size());
  if (!signed_ok) {
    return kServerCryptoError;
  }
  *grant_out = std::move(grant_response_bytes);
  return kServerOk;
}

}  // namespace

int32_t key_server_configure_runtime(
    const uint8_t* config_bytes,
    uint32_t config_len,
    std::vector<uint8_t>& status_out) {
  status_out.clear();

  int64_t next_max_skew_ms = kDefaultMaxSkewMs;
  int64_t next_challenge_ttl_ms = kDefaultChallengeTtlMs;
  int64_t next_expires_at_ms = 0;
  uint32_t next_key_version = 1;
  std::array<uint8_t, 32> next_provider_signing_public{};
  std::string next_provider_signing_slot_id{};
  std::string next_provider_wrapping_slot_id{};
  std::string next_provider_peer_id{};
  std::vector<uint8_t> next_capability_token{};

  if (!parse_runtime_config_lcf(
          config_bytes,
          config_len,
          &next_provider_signing_public,
          &next_provider_signing_slot_id,
          &next_provider_wrapping_slot_id,
          &next_provider_peer_id,
          &next_capability_token,
          &next_expires_at_ms,
          &next_max_skew_ms,
          &next_challenge_ttl_ms,
          &next_key_version)) {
    secure_zero(
        next_provider_signing_public.data(),
        next_provider_signing_public.size());
    return kServerMalformed;
  }

  clear_pending_grants();
  clear_publications();

  g_expires_at_ms = next_expires_at_ms;
  g_max_skew_ms = next_max_skew_ms;
  g_challenge_ttl_ms = next_challenge_ttl_ms;
  g_active_key_version = next_key_version;
  g_provider_peer_id = next_provider_peer_id;
  g_provider_signing_slot_id = next_provider_signing_slot_id;
  g_provider_wrapping_slot_id = next_provider_wrapping_slot_id;
  secure_zero(g_provider_signing_public.data(), g_provider_signing_public.size());
  g_provider_signing_public = next_provider_signing_public;
  g_capability_token = std::move(next_capability_token);
  g_initialized = true;

  status_out = build_lcf_status_bytes(false);
  return 0;
}

int32_t key_server_publish_module(
    const uint8_t* descriptor_bytes,
    uint32_t descriptor_len,
    const uint8_t* protected_content,
    uint32_t protected_content_len,
    const uint8_t* content_key,
    uint32_t content_key_len,
    keyMaterialRole content_key_role,
    keyMaterialAlgorithm content_key_algorithm,
    std::vector<uint8_t>& response_out) {
  response_out.clear();
  if (!g_initialized) {
    return kServerNotInitialized;
  }
  if (!descriptor_bytes || descriptor_len == 0 ||
      !protected_content || protected_content_len == 0 ||
      !content_key || content_key_len != kDekBytes) {
    return kServerMalformed;
  }

  flatbuffers::Verifier verifier(descriptor_bytes, descriptor_len);
  if (!VerifyPLGBuffer(verifier)) {
    return kServerMalformed;
  }
  const auto* descriptor_root = GetPLG(descriptor_bytes);
  if (!descriptor_root || !descriptor_root->PLUGIN_ID() || !descriptor_root->VERSION()) {
    return kServerMalformed;
  }

  std::unique_ptr<PLGT> descriptor_native(descriptor_root->UnPack());
  if (!descriptor_native || descriptor_native->PLUGIN_ID.empty() ||
      descriptor_native->VERSION.empty()) {
    return kServerMalformed;
  }

  std::string cid;
  if (!ipfs_add_bytes(protected_content, protected_content_len, &cid) || cid.empty()) {
    return kServerInternalError;
  }

  const auto encrypted_hash = sha256_bytes(protected_content, protected_content_len);
  descriptor_native->WASM_CID = cid;
  descriptor_native->ENCRYPTED_WASM_HASH = encrypted_hash;
  descriptor_native->ENCRYPTED_WASM_SIZE =
      static_cast<uint64_t>(protected_content_len);
  descriptor_native->ENCRYPTED = true;
  if (descriptor_native->KEY_ID.empty()) {
    descriptor_native->KEY_ID =
        descriptor_native->PLUGIN_ID + ":" + descriptor_native->VERSION;
  }
  if (descriptor_native->UPDATED_AT == 0) {
    descriptor_native->UPDATED_AT = static_cast<uint64_t>(now_ms());
  }
  if (descriptor_native->CREATED_AT == 0) {
    descriptor_native->CREATED_AT = descriptor_native->UPDATED_AT;
  }

  ModulePublication publication{};
  publication.descriptor = *descriptor_native;
  publication.descriptor_bytes = build_plg_bytes(publication.descriptor);
  std::memcpy(
      publication.content_key.data(),
      content_key,
      publication.content_key.size());
  publication.content_key_role = content_key_role;
  publication.content_key_algorithm = content_key_algorithm;

  {
    std::lock_guard<std::mutex> lock(g_publication_mutex);
    const std::string publication_key = make_publication_key(
        publication.descriptor.PLUGIN_ID,
        publication.descriptor.VERSION);
    auto [it, inserted] =
        g_publications.emplace(publication_key, std::move(publication));
    if (!inserted) {
      secure_zero_publication(&it->second);
      it->second = std::move(publication);
    }
    response_out = it->second.descriptor_bytes;
  }

  return 0;
}

int32_t key_server_check_key_rotation(std::vector<uint8_t>& status_out) {
  const int64_t now = now_ms();
  const bool needs_rotation =
      !g_initialized || (g_expires_at_ms > 0 && now >= g_expires_at_ms);
  status_out = build_lcf_status_bytes(
      needs_rotation,
      needs_rotation ? std::string_view("rotation-needed") : std::string_view(),
      needs_rotation ? std::string_view("Licensing runtime key material requires rotation.") : std::string_view());
  return 0;
}

int32_t key_server_handle_message(
    const uint8_t* request,
    uint32_t request_len,
    std::vector<uint8_t>& response_out) {
  response_out.clear();
  if (!g_initialized || !request || request_len == 0) {
    return kServerMalformed;
  }

  flatbuffers::Verifier verifier(request, request_len);
  if (VerifyLCHBuffer(verifier)) {
    const auto* challenge_request = GetLCH(request);
    if (!challenge_request ||
        challenge_request->MESSAGE_TYPE() != licensingChallengeMessageType::Request ||
        challenge_request->ROLE() != licensingChallengeRole::Requester ||
        !challenge_request->REQUEST_ID() ||
        !challenge_request->MODULE_ID() ||
        !challenge_request->REQUESTED_DOMAIN() ||
        !challenge_request->PROVIDER_PEER_ID() ||
        !challenge_request->REQUESTER_SIGNING_PUBKEY() ||
        challenge_request->REQUESTER_SIGNING_PUBKEY()->size() != 32 ||
        !challenge_request->REQUESTER_EPHEMERAL_PUBKEY() ||
        challenge_request->REQUESTER_EPHEMERAL_PUBKEY()->size() != 32) {
      response_out = build_lch_bytes(
          licensingChallengeMessageType::Error,
          licensingChallengeRole::Provider,
          challenge_request && challenge_request->REQUEST_ID()
              ? challenge_request->REQUEST_ID()->string_view()
              : std::string_view(),
          challenge_request && challenge_request->MODULE_ID()
              ? challenge_request->MODULE_ID()->string_view()
              : std::string_view(),
          challenge_request && challenge_request->MODULE_VERSION()
              ? challenge_request->MODULE_VERSION()->string_view()
              : std::string_view(),
          challenge_request && challenge_request->REQUESTER_PEER_ID()
              ? challenge_request->REQUESTER_PEER_ID()->string_view()
              : std::string_view(),
          challenge_request && challenge_request->REQUESTER_XPUB()
              ? challenge_request->REQUESTER_XPUB()->string_view()
              : std::string_view(),
          nullptr,
          0,
          nullptr,
          0,
          challenge_request && challenge_request->REQUESTED_DOMAIN()
              ? challenge_request->REQUESTED_DOMAIN()->string_view()
              : std::string_view(),
          challenge_request ? challenge_request->REQUESTED_TIMEOUT_MS() : 0,
          challenge_request ? challenge_request->REQUESTED_AT() : 0,
          nullptr,
          0,
          0,
          g_provider_peer_id,
          "invalid_request",
          "challenge request missing required fields");
      return 0;
    }

    const std::string request_id = challenge_request->REQUEST_ID()->str();
    const std::string module_id = challenge_request->MODULE_ID()->str();
    const std::string module_version =
        challenge_request->MODULE_VERSION()
            ? challenge_request->MODULE_VERSION()->str()
            : std::string();
    const std::string requester_peer_id =
        challenge_request->REQUESTER_PEER_ID()
            ? challenge_request->REQUESTER_PEER_ID()->str()
            : std::string();
    const std::string requester_xpub =
        challenge_request->REQUESTER_XPUB()
            ? challenge_request->REQUESTER_XPUB()->str()
            : std::string();
    const std::string requested_domain =
        challenge_request->REQUESTED_DOMAIN()->str();
    const uint64_t requested_timeout_ms =
        challenge_request->REQUESTED_TIMEOUT_MS();
    const uint64_t requested_at_ms =
        challenge_request->REQUESTED_AT() != 0
            ? challenge_request->REQUESTED_AT()
            : static_cast<uint64_t>(now_ms());
    const std::string provider_peer_id =
        challenge_request->PROVIDER_PEER_ID()->str();

    if (provider_peer_id != g_provider_peer_id) {
      response_out = build_lch_bytes(
          licensingChallengeMessageType::Error,
          licensingChallengeRole::Provider,
          request_id,
          module_id,
          module_version,
          requester_peer_id,
          requester_xpub,
          nullptr,
          0,
          nullptr,
          0,
          requested_domain,
          requested_timeout_ms,
          requested_at_ms,
          nullptr,
          0,
          0,
          g_provider_peer_id,
          "provider_mismatch",
          "requested provider peer id does not match this provider");
      return 0;
    }

    const std::string publication_key = make_publication_key(module_id, module_version);
    ModulePublication publication{};
    if (!load_publication(publication_key, &publication)) {
      response_out = build_lch_bytes(
          licensingChallengeMessageType::Error,
          licensingChallengeRole::Provider,
          request_id,
          module_id,
          module_version,
          requester_peer_id,
          requester_xpub,
          nullptr,
          0,
          nullptr,
          0,
          requested_domain,
          requested_timeout_ms,
          requested_at_ms,
          nullptr,
          0,
          0,
          g_provider_peer_id,
          "module_not_found",
          "requested module publication was not found");
      return 0;
    }

    // PKI xpub allowlist: early membership filter on the claimed xpub ("*" admits
    // any non-empty one). The cryptographic binding of that xpub to the
    // requester's proven ed25519 signing key (via the re-sent EPM) is verified at
    // proof time below.
    if (!sdn::epm::XpubAllowed(publication.descriptor.ALLOWED_XPUBS, requester_xpub)) {
      secure_zero_publication(&publication);
      response_out = build_lch_bytes(
          licensingChallengeMessageType::Error,
          licensingChallengeRole::Provider,
          request_id,
          module_id,
          module_version,
          requester_peer_id,
          requester_xpub,
          nullptr,
          0,
          nullptr,
          0,
          requested_domain,
          requested_timeout_ms,
          requested_at_ms,
          nullptr,
          0,
          0,
          g_provider_peer_id,
          "xpub_not_allowed",
          "requester xpub is not allowed for this module");
      return 0;
    }
    if (publication.descriptor.MAX_GRANT_TIMEOUT_MS != 0 &&
        requested_timeout_ms > publication.descriptor.MAX_GRANT_TIMEOUT_MS) {
      secure_zero_publication(&publication);
      response_out = build_lch_bytes(
          licensingChallengeMessageType::Error,
          licensingChallengeRole::Provider,
          request_id,
          module_id,
          module_version,
          requester_peer_id,
          requester_xpub,
          nullptr,
          0,
          nullptr,
          0,
          requested_domain,
          requested_timeout_ms,
          requested_at_ms,
          nullptr,
          0,
          0,
          g_provider_peer_id,
          "timeout_exceeds_policy",
          "requested timeout exceeds the publication policy");
      return 0;
    }

    const int64_t now = now_ms();
    if (requested_at_ms + static_cast<uint64_t>(g_max_skew_ms) < static_cast<uint64_t>(now) ||
        requested_at_ms > static_cast<uint64_t>(now + g_max_skew_ms)) {
      secure_zero_publication(&publication);
      response_out = build_lch_bytes(
          licensingChallengeMessageType::Error,
          licensingChallengeRole::Provider,
          request_id,
          module_id,
          module_version,
          requester_peer_id,
          requester_xpub,
          nullptr,
          0,
          nullptr,
          0,
          requested_domain,
          requested_timeout_ms,
          requested_at_ms,
          nullptr,
          0,
          0,
          g_provider_peer_id,
          "invalid_timestamp",
          "requested timestamp is outside the allowed skew");
      return 0;
    }

    std::array<uint8_t, 32> challenge_nonce{};
    if (!fill_random_bytes(challenge_nonce.data(), challenge_nonce.size())) {
      secure_zero_publication(&publication);
      return kServerCryptoError;
    }
    const uint64_t expires_at_ms =
        static_cast<uint64_t>(now + g_challenge_ttl_ms);
    response_out = build_lch_bytes(
        licensingChallengeMessageType::Response,
        licensingChallengeRole::Provider,
        request_id,
        module_id,
        module_version,
        requester_peer_id,
        requester_xpub,
        challenge_request->REQUESTER_SIGNING_PUBKEY()->Data(),
        challenge_request->REQUESTER_SIGNING_PUBKEY()->size(),
        challenge_request->REQUESTER_EPHEMERAL_PUBKEY()->Data(),
        challenge_request->REQUESTER_EPHEMERAL_PUBKEY()->size(),
        requested_domain,
        requested_timeout_ms,
        requested_at_ms,
        challenge_nonce.data(),
        challenge_nonce.size(),
        expires_at_ms,
        g_provider_peer_id,
        {},
        {});

    PendingGrantMessage pending{};
    pending.request_id = request_id;
    pending.publication_key = publication_key;
    pending.module_id = module_id;
    pending.module_version = module_version;
    pending.requester_peer_id = requester_peer_id;
    pending.requester_xpub = requester_xpub;
    pending.requested_domain = requested_domain;
    pending.requested_timeout_ms = requested_timeout_ms;
    pending.requested_at_ms = requested_at_ms;
    pending.provider_peer_id = g_provider_peer_id;
    if (const auto* epm = challenge_request->REQUESTER_EPM()) {
      pending.requester_epm.assign(epm->Data(), epm->Data() + epm->size());
    }
    std::memcpy(
        pending.requester_signing_pubkey.data(),
        challenge_request->REQUESTER_SIGNING_PUBKEY()->Data(),
        pending.requester_signing_pubkey.size());
    std::memcpy(
        pending.requester_ephemeral_pubkey.data(),
        challenge_request->REQUESTER_EPHEMERAL_PUBKEY()->Data(),
        pending.requester_ephemeral_pubkey.size());
    std::memcpy(
        pending.challenge_nonce.data(),
        challenge_nonce.data(),
        pending.challenge_nonce.size());
    pending.expires_at_ms = expires_at_ms;
    pending.challenge_bytes = response_out;

    // Bounded: expired handshakes go first, and when the table is still full
    // the NEW request is refused (provider_busy) rather than an older one
    // evicted, so a flood of unanswered requests cannot strand a requester
    // whose handshake is still live.
    bool admitted = false;
    {
      std::lock_guard<std::mutex> lock(g_pending_grant_mutex);
      cleanup_pending_grants_locked(now);
      if (g_pending_grants.size() < kMaxPendingGrants ||
          g_pending_grants.count(request_id) > 0) {
        g_pending_grants[request_id] = std::move(pending);
        admitted = true;
      }
    }
    if (!admitted) {
      secure_zero_pending_grant(&pending);
      response_out = build_lch_bytes(
          licensingChallengeMessageType::Error,
          licensingChallengeRole::Provider,
          request_id,
          module_id,
          module_version,
          requester_peer_id,
          requester_xpub,
          nullptr,
          0,
          nullptr,
          0,
          requested_domain,
          requested_timeout_ms,
          requested_at_ms,
          nullptr,
          0,
          0,
          g_provider_peer_id,
          kProviderBusyReason,
          "too many grant handshakes are open; retry shortly");
    }
    secure_zero_publication(&publication);
    return 0;
  }

  flatbuffers::Verifier proof_verifier(request, request_len);
  if (!VerifyLPFBuffer(proof_verifier)) {
    return kServerMalformed;
  }

  const auto* proof = GetLPF(request);
  if (!proof || proof->MESSAGE_TYPE() != licensingProofMessageType::ProofRequest ||
      !proof->REQUEST_ID() || !proof->MODULE_ID() || !proof->SIGNATURE() ||
      !proof->SIGNING_PUBKEY() || !proof->CHALLENGE_NONCE() ||
      !proof->REQUESTER_EPHEMERAL_PUBKEY()) {
    return kServerMalformed;
  }

  PendingGrantMessage pending{};
  bool pending_found = false;
  const int64_t proof_received_ms = now_ms();
  {
    std::lock_guard<std::mutex> lock(g_pending_grant_mutex);
    const auto it = g_pending_grants.find(proof->REQUEST_ID()->str());
    if (it != g_pending_grants.end()) {
      pending = it->second;
      secure_zero_pending_grant(&it->second);
      g_pending_grants.erase(it);
      pending_found = true;
    }
    cleanup_pending_grants_locked(proof_received_ms);
  }
  if (!pending_found) {
    return kServerChallengeInvalid;
  }

  if (proof->SIGNING_PUBKEY()->size() != 32 ||
      proof->REQUESTER_EPHEMERAL_PUBKEY()->size() != 32 ||
      proof->CHALLENGE_NONCE()->size() != pending.challenge_nonce.size() ||
      proof->SIGNATURE()->size() != 64) {
    return kServerMalformed;
  }
  if (pending.expires_at_ms <= static_cast<uint64_t>(proof_received_ms)) {
    return kServerChallengeExpired;
  }
  if (proof->MODULE_ID()->str() != pending.module_id ||
      (proof->MODULE_VERSION() ? proof->MODULE_VERSION()->str() : std::string()) != pending.module_version ||
      (proof->REQUESTER_PEER_ID() ? proof->REQUESTER_PEER_ID()->str() : std::string()) != pending.requester_peer_id ||
      (proof->REQUESTER_XPUB() ? proof->REQUESTER_XPUB()->str() : std::string()) != pending.requester_xpub ||
      (proof->REQUESTED_DOMAIN() ? proof->REQUESTED_DOMAIN()->str() : std::string()) != pending.requested_domain ||
      proof->REQUESTED_TIMEOUT_MS() != pending.requested_timeout_ms ||
      (proof->PROVIDER_PEER_ID() ? proof->PROVIDER_PEER_ID()->str() : std::string()) != pending.provider_peer_id ||
      std::memcmp(
          proof->SIGNING_PUBKEY()->Data(),
          pending.requester_signing_pubkey.data(),
          pending.requester_signing_pubkey.size()) != 0 ||
      std::memcmp(
          proof->REQUESTER_EPHEMERAL_PUBKEY()->Data(),
          pending.requester_ephemeral_pubkey.data(),
          pending.requester_ephemeral_pubkey.size()) != 0 ||
      std::memcmp(
          proof->CHALLENGE_NONCE()->Data(),
          pending.challenge_nonce.data(),
          pending.challenge_nonce.size()) != 0) {
    return kServerChallengeInvalid;
  }
  bool proof_valid = false;
  if (!ed25519_verify_detached(
          pending.challenge_bytes.data(),
          pending.challenge_bytes.size(),
          pending.requester_signing_pubkey.data(),
          pending.requester_signing_pubkey.size(),
          proof->SIGNATURE()->Data(),
          proof->SIGNATURE()->size(),
          &proof_valid) ||
      !proof_valid) {
    return kServerChallengeInvalid;
  }

  ModulePublication publication{};
  if (!load_publication(pending.publication_key, &publication)) {
    return kServerVersionNotFound;
  }

  // Authoritative PKI gate: when the module declares an xpub allowlist, the re-sent
  // EPM must verify and bind the now-proven ed25519 signing key to the requester's
  // xpub (cross-curve attestation), the account key must have authorised that
  // session key, and the xpub must be listed. An allowlist of "*" waives only the
  // listing: any account that passes the rest is granted, still encrypted to its
  // own session key, and the bound xpub must still equal the claimed one.
  std::string proven_xpub;
  if (!publication.descriptor.ALLOWED_XPUBS.empty()) {
    const sdn::epm::AuthorizeResult gate = authorize_requester_epm(
        pending.requester_epm.data(),
        pending.requester_epm.size(),
        pending.requester_signing_pubkey.data(),
        publication.descriptor.ALLOWED_XPUBS,
        now_ms() / 1000,
        kEpmMaxAgeSeconds,
        pending.requested_domain);
    if (!gate.ok || gate.xpub != pending.requester_xpub) {
      secure_zero_publication(&publication);
      return kServerUnauthorized;
    }
    proven_xpub = gate.xpub;
  }

  // Per-account quota (grant_quota.h), on the account just proven, so nobody
  // can spend another account's quota, and before the key wrap and the host's
  // signature, which a refusal does not need. A module without an allowlist
  // proves no account and leases nothing, so it has nothing to count.
  const int64_t admitted_at_ms = now_ms();
  if (!proven_xpub.empty() &&
      !licensing::AdmitGrant(proven_xpub, pending.module_id, admitted_at_ms)) {
    response_out = build_lgr_denied_bytes(
        pending.request_id,
        pending.module_id,
        pending.module_version,
        pending.requester_peer_id,
        pending.requester_xpub,
        pending.requested_domain,
        pending.requested_timeout_ms,
        0,
        publication.descriptor.REQUIRED_SCOPE,
        licensing::kGrantRateLimitedReason,
        g_provider_signing_public);
    secure_zero_publication(&publication);
    return 0;
  }

  const int32_t status = build_signed_grant(pending, publication, &response_out);
  secure_zero_publication(&publication);
  if (status != kServerOk && !proven_xpub.empty()) {
    licensing::RefundGrant(proven_xpub, pending.module_id, admitted_at_ms);
  }
  return status;
}
