#include "key_server_api.h"

#ifdef TIME_UTC
#undef TIME_UTC
#endif

#include "KeyBrokerRequest_generated.h"
#include "KeyBrokerResponse_generated.h"
#include "ENC_generated.h"
#include "LCF_generated.h"
#include "LCH_generated.h"
#include "LGR_generated.h"
#include "LPF_generated.h"
#include "PLG_generated.h"
#include "PublicKeyResponse_generated.h"
#include "REC_generated.h"

#include "epm_authorize.h"  // shared isomorphic EPM verify + xpub gate (common/epm)

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

#include "../../../../../common/sdm_hostcall_wire.hpp"
#include "keyslotClient.hpp"

namespace {

constexpr uint8_t kProtocolVersion = 3;
constexpr size_t kChallengeIdBytes = 16;
// Max age (seconds) of a re-sent EPM's SIGNATURE_TIMESTAMP accepted at grant time.
constexpr int64_t kEpmMaxAgeSeconds = 300;
constexpr size_t kChallengeTokenRawBytes = 32;
constexpr size_t kChallengeTokenHexBytes = kChallengeTokenRawBytes * 2;
constexpr size_t kProofBytes = 32;
constexpr size_t kDekBytes = 32;
constexpr size_t kAesKeyBytes = 32;
constexpr size_t kGcmIvBytes = 12;
constexpr size_t kGcmTagBytes = 16;
constexpr size_t kSaltBytes = 32;
constexpr size_t kClientPublicKeyBytes = 65;
constexpr size_t kRequestPlaintextBytes = 12;
constexpr size_t kResponsePlaintextBytes = 46;
constexpr size_t kRequestHeaderBytes =
    4 + 4 + kChallengeIdBytes + kProofBytes + kClientPublicKeyBytes + kSaltBytes + 2;
constexpr size_t kResponseHeaderBytes = 38;
constexpr int64_t kDefaultMaxSkewMs = 5LL * 60LL * 1000LL;
constexpr int64_t kDefaultChallengeTtlMs = 60LL * 1000LL;
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

struct PendingChallenge {
  uint32_t key_version = 1;
  int64_t expires_at_ms = 0;
  std::array<uint8_t, kChallengeTokenHexBytes> token{};
  std::string publication_key{};
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
CryptoPP::SecByteBlock g_server_private;
CryptoPP::SecByteBlock g_server_public;
std::array<uint8_t, kDekBytes> g_dek{};
int64_t g_expires_at_ms = 0;
int64_t g_max_skew_ms = kDefaultMaxSkewMs;
int64_t g_challenge_ttl_ms = kDefaultChallengeTtlMs;
uint32_t g_active_key_version = 1;
std::string g_provider_peer_id = "provider.orbpro.test";
// NOTE: there is deliberately no g_provider_signing_seed. The provider's
// ed25519 seed lives host-side in the keyslot named by
// g_provider_signing_slot_id; it never enters guest memory. Grant/challenge
// signing goes through sdm_keyslot::keyslot_sign (a keyslot.sign hostcall)
// instead of a local ed25519 sign over a cached seed.
std::array<uint8_t, 32> g_provider_signing_public{};
std::string g_provider_signing_slot_id{};
std::string g_provider_wrapping_slot_id{};
std::vector<uint8_t> g_capability_token{};

std::mutex g_challenge_mutex;
std::unordered_map<std::string, PendingChallenge> g_pending_challenges;

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

size_t skip_json_whitespace(std::string_view text, size_t cursor) {
  while (cursor < text.size()) {
    const char c = text[cursor];
    if (c != ' ' && c != '\t' && c != '\n' && c != '\r') {
      break;
    }
    ++cursor;
  }
  return cursor;
}

bool extract_json_bool_field(
    std::string_view text,
    std::string_view field,
    bool* value_out) {
  if (!value_out) {
    return false;
  }
  const std::string marker = "\"" + std::string(field) + "\"";
  const size_t field_pos = text.find(marker);
  if (field_pos == std::string_view::npos) {
    return false;
  }
  const size_t colon_pos = text.find(':', field_pos + marker.size());
  if (colon_pos == std::string_view::npos) {
    return false;
  }
  size_t cursor = skip_json_whitespace(text, colon_pos + 1);
  if (text.compare(cursor, 4, "true") == 0) {
    *value_out = true;
    return true;
  }
  if (text.compare(cursor, 5, "false") == 0) {
    *value_out = false;
    return true;
  }
  return false;
}

bool extract_json_string_field(
    std::string_view text,
    std::string_view field,
    std::string* value_out) {
  if (!value_out) {
    return false;
  }
  const std::string marker = "\"" + std::string(field) + "\"";
  const size_t field_pos = text.find(marker);
  if (field_pos == std::string_view::npos) {
    return false;
  }
  const size_t colon_pos = text.find(':', field_pos + marker.size());
  if (colon_pos == std::string_view::npos) {
    return false;
  }
  size_t cursor = skip_json_whitespace(text, colon_pos + 1);
  if (cursor >= text.size() || text[cursor] != '"') {
    return false;
  }
  ++cursor;

  std::string out;
  while (cursor < text.size()) {
    const char c = text[cursor++];
    if (c == '"') {
      *value_out = out;
      return true;
    }
    if (c == '\\') {
      if (cursor >= text.size()) {
        return false;
      }
      const char escaped = text[cursor++];
      switch (escaped) {
        case '"':
        case '\\':
        case '/':
          out.push_back(escaped);
          break;
        case 'b':
          out.push_back('\b');
          break;
        case 'f':
          out.push_back('\f');
          break;
        case 'n':
          out.push_back('\n');
          break;
        case 'r':
          out.push_back('\r');
          break;
        case 't':
          out.push_back('\t');
          break;
        default:
          return false;
      }
      continue;
    }
    out.push_back(c);
  }
  return false;
}

bool extract_json_int64_field(
    std::string_view text,
    std::string_view field,
    int64_t* value_out) {
  if (!value_out) {
    return false;
  }
  const std::string marker = "\"" + std::string(field) + "\"";
  const size_t field_pos = text.find(marker);
  if (field_pos == std::string_view::npos) {
    return false;
  }
  const size_t colon_pos = text.find(':', field_pos + marker.size());
  if (colon_pos == std::string_view::npos) {
    return false;
  }
  size_t cursor = skip_json_whitespace(text, colon_pos + 1);
  bool negative = false;
  if (cursor < text.size() && text[cursor] == '-') {
    negative = true;
    ++cursor;
  }
  if (cursor >= text.size() || text[cursor] < '0' || text[cursor] > '9') {
    return false;
  }
  int64_t parsed = 0;
  while (cursor < text.size()) {
    const char c = text[cursor];
    if (c < '0' || c > '9') {
      break;
    }
    parsed = parsed * 10 + static_cast<int64_t>(c - '0');
    ++cursor;
  }
  *value_out = negative ? -parsed : parsed;
  return true;
}

int decode_base64_char(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  if (c == '=') return -2;
  return -1;
}

bool decode_base64_bytes(std::string_view text, std::vector<uint8_t>* bytes_out) {
  if (!bytes_out) {
    return false;
  }
  bytes_out->clear();
  uint32_t accumulator = 0;
  int bits_collected = 0;
  bool padding_seen = false;
  for (char c : text) {
    if (c == ' ' || c == '\n' || c == '\r' || c == '\t') {
      continue;
    }
    const int decoded = decode_base64_char(c);
    if (decoded == -1) {
      return false;
    }
    if (decoded == -2) {
      padding_seen = true;
      continue;
    }
    if (padding_seen) {
      return false;
    }
    accumulator = (accumulator << 6) | static_cast<uint32_t>(decoded);
    bits_collected += 6;
    if (bits_collected >= 8) {
      bits_collected -= 8;
      bytes_out->push_back(
          static_cast<uint8_t>((accumulator >> bits_collected) & 0xffu));
    }
  }
  return true;
}

int decode_hex_char(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

bool decode_hex_bytes(std::string_view text, uint8_t* output, size_t output_len) {
  if (!output || text.size() != output_len * 2) {
    return false;
  }
  for (size_t i = 0; i < output_len; ++i) {
    const int hi = decode_hex_char(text[i * 2]);
    const int lo = decode_hex_char(text[i * 2 + 1]);
    if (hi < 0 || lo < 0) {
      return false;
    }
    output[i] = static_cast<uint8_t>((hi << 4) | lo);
  }
  return true;
}

std::string encode_hex_bytes(const uint8_t* bytes, size_t size) {
  static constexpr char kDigits[] = "0123456789abcdef";
  std::string output(size * 2, '\0');
  for (size_t i = 0; i < size; ++i) {
    output[i * 2] = kDigits[(bytes[i] >> 4) & 0x0f];
    output[i * 2 + 1] = kDigits[bytes[i] & 0x0f];
  }
  return output;
}

std::string escape_json_string(std::string_view value) {
  std::string escaped;
  escaped.reserve(value.size());
  for (const char c : value) {
    switch (c) {
      case '"':
        escaped += "\\\"";
        break;
      case '\\':
        escaped += "\\\\";
        break;
      case '\b':
        escaped += "\\b";
        break;
      case '\f':
        escaped += "\\f";
        break;
      case '\n':
        escaped += "\\n";
        break;
      case '\r':
        escaped += "\\r";
        break;
      case '\t':
        escaped += "\\t";
        break;
      default:
        escaped.push_back(c);
        break;
    }
  }
  return escaped;
}

bool ipfs_add_bytes(
    const uint8_t* payload,
    size_t payload_len,
    std::string* cid_out) {
  if (!cid_out) {
    return false;
  }
  sdm_hostcall::Response response;
  if (!sdm_hostcall::call(
          "ipfs.add",
          "{\"content\":{\"$bin\":0}}",
          {{payload, payload_len}},
          &response)) {
    return false;
  }
  return extract_json_string_field(response.meta, "Hash", cid_out) ||
         extract_json_string_field(response.meta, "cid", cid_out);
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
  sdm_hostcall::Response response;
  int64_t value = 0;
  if (!sdm_hostcall::call("clock.now", "{}", {}, &response)) {
    return 0;
  }
  if (!sdm_hostcall::find_json_int64(response.meta, "result", &value)) {
    return 0;
  }
  return value;
}

bool fill_random_bytes(uint8_t* bytes, size_t len) {
  if (!bytes) {
    return false;
  }
  if (len == 0) {
    return true;
  }
  const std::string meta = "{\"length\":" + std::to_string(len) + "}";
  sdm_hostcall::Response response;
  if (!sdm_hostcall::call("random.bytes", meta, {}, &response)) {
    return false;
  }
  std::vector<uint8_t> random_bytes;
  if (!sdm_hostcall::get_result_bytes(response, &random_bytes) ||
      random_bytes.size() != len) {
    secure_zero(random_bytes.data(), random_bytes.size());
    return false;
  }
  std::memcpy(bytes, random_bytes.data(), len);
  secure_zero(random_bytes.data(), random_bytes.size());
  return true;
}

uint16_t read_u16_be(const uint8_t* ptr) {
  return static_cast<uint16_t>(
      (static_cast<uint16_t>(ptr[0]) << 8) | static_cast<uint16_t>(ptr[1]));
}

void write_u16_be(uint8_t* ptr, uint16_t value) {
  ptr[0] = static_cast<uint8_t>((value >> 8) & 0xff);
  ptr[1] = static_cast<uint8_t>(value & 0xff);
}

uint32_t read_u32_le(const uint8_t* ptr) {
  uint32_t value = 0;
  value |= static_cast<uint32_t>(ptr[0]);
  value |= static_cast<uint32_t>(ptr[1]) << 8;
  value |= static_cast<uint32_t>(ptr[2]) << 16;
  value |= static_cast<uint32_t>(ptr[3]) << 24;
  return value;
}

void write_u32_le(uint8_t* ptr, uint32_t value) {
  ptr[0] = static_cast<uint8_t>(value & 0xff);
  ptr[1] = static_cast<uint8_t>((value >> 8) & 0xff);
  ptr[2] = static_cast<uint8_t>((value >> 16) & 0xff);
  ptr[3] = static_cast<uint8_t>((value >> 24) & 0xff);
}

uint64_t read_u64_le(const uint8_t* ptr) {
  uint64_t value = 0;
  for (int i = 0; i < 8; ++i) {
    value |= (static_cast<uint64_t>(ptr[i]) << static_cast<uint64_t>(i * 8));
  }
  return value;
}

void write_u64_le(uint8_t* ptr, uint64_t value) {
  for (int i = 0; i < 8; ++i) {
    ptr[i] = static_cast<uint8_t>((value >> static_cast<uint64_t>(i * 8)) & 0xff);
  }
}

CryptoPP::ECDH<CryptoPP::ECP>::Domain& ecdh_domain_p256() {
  static CryptoPP::ECDH<CryptoPP::ECP>::Domain domain(CryptoPP::ASN1::secp256r1());
  return domain;
}

bool derive_public_key_from_private(
    const uint8_t* private_key,
    size_t private_key_len,
    CryptoPP::SecByteBlock* derived_private_key,
    CryptoPP::SecByteBlock* derived_public_key) {
  if (!private_key || !derived_private_key || !derived_public_key) {
    return false;
  }

  auto& domain = ecdh_domain_p256();
  const auto& params = domain.GetGroupParameters();
  if (private_key_len != domain.PrivateKeyLength()) {
    return false;
  }

  CryptoPP::Integer private_exponent(
      private_key,
      private_key_len,
      CryptoPP::Integer::UNSIGNED,
      CryptoPP::BIG_ENDIAN_ORDER);
  if (private_exponent <= CryptoPP::Integer::Zero() ||
      private_exponent >= params.GetSubgroupOrder()) {
    return false;
  }

  const CryptoPP::ECP::Point public_point =
      params.GetCurve().Multiply(private_exponent, params.GetSubgroupGenerator());
  if (public_point.identity || !params.GetCurve().VerifyPoint(public_point)) {
    return false;
  }

  derived_private_key->CleanNew(domain.PrivateKeyLength());
  std::memcpy(derived_private_key->BytePtr(), private_key, private_key_len);

  derived_public_key->CleanNew(kClientPublicKeyBytes);
  params.GetCurve().EncodePoint(derived_public_key->BytePtr(), public_point, false);
  return true;
}

bool generate_random_server_keypair(
    CryptoPP::SecByteBlock* private_key_out,
    CryptoPP::SecByteBlock* public_key_out) {
  if (!private_key_out || !public_key_out) {
    return false;
  }
  std::vector<uint8_t> candidate(ecdh_domain_p256().PrivateKeyLength(), 0);
  for (size_t attempt = 0; attempt < 64; ++attempt) {
    if (!fill_random_bytes(candidate.data(), candidate.size())) {
      secure_zero(candidate.data(), candidate.size());
      return false;
    }
    if (derive_public_key_from_private(
            candidate.data(), candidate.size(), private_key_out, public_key_out)) {
      secure_zero(candidate.data(), candidate.size());
      return true;
    }
  }
  secure_zero(candidate.data(), candidate.size());
  return false;
}

bool derive_hkdf_key(
    const uint8_t* shared,
    size_t shared_len,
    const uint8_t* salt,
    size_t salt_len,
    const char* info,
    uint8_t out_key[kAesKeyBytes]) {
  CryptoPP::HKDF<CryptoPP::SHA256> hkdf;
  hkdf.DeriveKey(
      out_key,
      kAesKeyBytes,
      shared,
      shared_len,
      salt,
      salt_len,
      reinterpret_cast<const uint8_t*>(info),
      std::strlen(info));
  return true;
}

bool aes_gcm_encrypt(
    const uint8_t* plaintext,
    size_t plaintext_len,
    const uint8_t key[kAesKeyBytes],
    std::vector<uint8_t>* output) {
  if (!output) {
    return false;
  }
  output->assign(kGcmIvBytes + plaintext_len + kGcmTagBytes, 0);
  uint8_t* iv = output->data();
  uint8_t* ciphertext = output->data() + kGcmIvBytes;
  uint8_t* tag = output->data() + kGcmIvBytes + plaintext_len;
  if (!fill_random_bytes(iv, kGcmIvBytes)) {
    secure_zero(output->data(), output->size());
    output->clear();
    return false;
  }

  CryptoPP::GCM<CryptoPP::AES>::Encryption enc;
  enc.SetKeyWithIV(key, kAesKeyBytes, iv, kGcmIvBytes);
  enc.SpecifyDataLengths(0, plaintext_len, 0);
  enc.ProcessData(ciphertext, plaintext, plaintext_len);
  enc.TruncatedFinal(tag, kGcmTagBytes);
  return true;
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

bool constant_time_equals(const uint8_t* a, const uint8_t* b, size_t len) {
  if (!a || !b) {
    return false;
  }
  uint8_t diff = 0;
  for (size_t i = 0; i < len; ++i) {
    diff |= static_cast<uint8_t>(a[i] ^ b[i]);
  }
  return diff == 0;
}

void cleanup_pending_challenges_locked(int64_t now) {
  for (auto it = g_pending_challenges.begin(); it != g_pending_challenges.end();) {
    if (it->second.expires_at_ms <= now) {
      secure_zero(it->second.token.data(), it->second.token.size());
      it = g_pending_challenges.erase(it);
    } else {
      ++it;
    }
  }
}

void clear_pending_challenges() {
  std::lock_guard<std::mutex> lock(g_challenge_mutex);
  for (auto& entry : g_pending_challenges) {
    secure_zero(entry.second.token.data(), entry.second.token.size());
  }
  g_pending_challenges.clear();
}

int32_t consume_challenge(
    const uint8_t* challenge_id,
    uint32_t key_version,
    const uint8_t* client_public_key,
    const uint8_t* request_salt,
    const uint8_t* request_blob,
    size_t request_blob_len,
    const uint8_t* challenge_proof,
    std::string* publication_key_out) {
  const std::string challenge_id_hex = encode_hex_bytes(challenge_id, kChallengeIdBytes);
  PendingChallenge challenge{};
  const int64_t now = now_ms();

  {
    std::lock_guard<std::mutex> lock(g_challenge_mutex);
    cleanup_pending_challenges_locked(now);
    const auto it = g_pending_challenges.find(challenge_id_hex);
    if (it == g_pending_challenges.end()) {
      return kServerChallengeInvalid;
    }
    challenge = it->second;
    secure_zero(it->second.token.data(), it->second.token.size());
    g_pending_challenges.erase(it);
  }

  if (challenge.expires_at_ms <= now) {
    secure_zero(challenge.token.data(), challenge.token.size());
    return kServerChallengeExpired;
  }
  if (challenge.key_version != key_version) {
    secure_zero(challenge.token.data(), challenge.token.size());
    return kServerVersionNotFound;
  }

  uint8_t key_version_le[4] = {0};
  write_u32_le(key_version_le, key_version);
  uint8_t blob_hash[CryptoPP::SHA256::DIGESTSIZE] = {0};
  CryptoPP::SHA256 sha256;
  sha256.Update(request_blob, request_blob_len);
  sha256.Final(blob_hash);

  std::array<uint8_t, kProofBytes> expected_proof{};
  CryptoPP::HMAC<CryptoPP::SHA256> hmac(
      challenge.token.data(),
      challenge.token.size());
  hmac.Update(challenge_id, kChallengeIdBytes);
  hmac.Update(key_version_le, sizeof(key_version_le));
  hmac.Update(client_public_key, kClientPublicKeyBytes);
  hmac.Update(request_salt, kSaltBytes);
  hmac.Update(blob_hash, sizeof(blob_hash));
  hmac.Final(expected_proof.data());

  const bool proof_match =
      constant_time_equals(expected_proof.data(), challenge_proof, kProofBytes);
  secure_zero(expected_proof.data(), expected_proof.size());
  secure_zero(blob_hash, sizeof(blob_hash));
  if (proof_match && publication_key_out) {
    *publication_key_out = challenge.publication_key;
  }
  secure_zero(challenge.token.data(), challenge.token.size());
  return proof_match ? kServerOk : kServerChallengeInvalid;
}

bool parse_positive_json_u32(
    std::string_view text,
    std::string_view field,
    uint32_t fallback,
    uint32_t* value_out) {
  if (!value_out) {
    return false;
  }
  int64_t parsed = 0;
  if (!extract_json_int64_field(text, field, &parsed)) {
    *value_out = fallback;
    return true;
  }
  if (parsed <= 0 || parsed > static_cast<int64_t>(UINT32_MAX)) {
    return false;
  }
  *value_out = static_cast<uint32_t>(parsed);
  return true;
}

std::vector<uint8_t> build_public_key_response_bytes() {
  flatbuffers::FlatBufferBuilder builder(128);
  const auto public_key = builder.CreateVector(
      g_server_public.BytePtr(), static_cast<flatbuffers::uoffset_t>(g_server_public.size()));
  const auto root = orbpro::keybroker::CreatePublicKeyResponse(builder, public_key);
  orbpro::keybroker::FinishPublicKeyResponseBuffer(builder, root);
  return std::vector<uint8_t>(
      builder.GetBufferPointer(),
      builder.GetBufferPointer() + builder.GetSize());
}

std::vector<uint8_t> build_key_broker_response_bytes(
    uint32_t status,
    const std::vector<uint8_t>& packet) {
  flatbuffers::FlatBufferBuilder builder(
      static_cast<flatbuffers::uoffset_t>(packet.size() + 128));
  flatbuffers::Offset<flatbuffers::Vector<uint8_t>> packet_offset;
  if (!packet.empty()) {
    packet_offset = builder.CreateVector(
        packet.data(),
        static_cast<flatbuffers::uoffset_t>(packet.size()));
  }
  const auto root = orbpro::keybroker::CreateKeyBrokerResponse(
      builder,
      status,
      packet_offset);
  orbpro::keybroker::FinishKeyBrokerResponseBuffer(builder, root);
  return std::vector<uint8_t>(
      builder.GetBufferPointer(),
      builder.GetBufferPointer() + builder.GetSize());
}

void build_challenge_error_json(int32_t error, std::vector<uint8_t>* response_out) {
  if (!response_out) {
    return;
  }
  const std::string json = "{\"error\":" + std::to_string(error) + "}";
  response_out->assign(json.begin(), json.end());
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

void clear_pending_grants() {
  std::lock_guard<std::mutex> lock(g_pending_grant_mutex);
  for (auto& entry : g_pending_grants) {
    secure_zero(
        entry.second.requester_signing_pubkey.data(),
        entry.second.requester_signing_pubkey.size());
    secure_zero(
        entry.second.requester_ephemeral_pubkey.data(),
        entry.second.requester_ephemeral_pubkey.size());
    secure_zero(
        entry.second.challenge_nonce.data(),
        entry.second.challenge_nonce.size());
  }
  g_pending_grants.clear();
}

bool ed25519_public_key_from_seed(
    const uint8_t* seed,
    size_t seed_len,
    std::array<uint8_t, 32>* public_key_out) {
  if (!seed || !public_key_out || seed_len != 32) {
    return false;
  }
  std::vector<uint8_t> public_key_bytes;
  sdm_hostcall::Response response;
  if (!sdm_hostcall::call(
          "crypto.ed25519.publicKeyFromSeed",
          "{\"seed\":{\"$bin\":0}}",
          {{seed, seed_len}},
          &response) ||
      !sdm_hostcall::get_result_bytes(response, &public_key_bytes) ||
      public_key_bytes.size() != public_key_out->size()) {
    return false;
  }
  std::memcpy(
      public_key_out->data(),
      public_key_bytes.data(),
      public_key_out->size());
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
  sdm_hostcall::Response response;
  if (!sdm_hostcall::call(
          "crypto.ed25519.verify",
          "{\"message\":{\"$bin\":0},\"signature\":{\"$bin\":1},\"publicKey\":{\"$bin\":2}}",
          {{message, message_len},
           {signature, signature_len},
           {public_key, public_key_len}},
          &response)) {
    return false;
  }
  return sdm_hostcall::find_json_bool(response.meta, "result", valid_out);
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
  sdm_hostcall::Response response;
  if (!sdm_hostcall::call(
          "crypto.secp256k1.verify",
          "{\"message\":{\"$bin\":0},\"signature\":{\"$bin\":1},\"publicKey\":{\"$bin\":2}}",
          {{message, message_len},
           {signature, signature_len},
           {public_key, public_key_len}},
          &response)) {
    return false;
  }
  return sdm_hostcall::find_json_bool(response.meta, "result", valid_out);
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
  // use (see sdm_keyslot::keyslot_sign), never through a locally-held seed.
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

bool parse_runtime_config_sds(
    std::string_view json,
    std::array<uint8_t, 32>* provider_signing_seed_out,
    std::array<uint8_t, 32>* provider_signing_public_out,
    std::string* provider_peer_id_out,
    std::vector<uint8_t>* capability_token_out) {
  if (!provider_signing_seed_out || !provider_signing_public_out ||
      !provider_peer_id_out || !capability_token_out) {
    return false;
  }

  std::string signing_seed_hex;
  if (!extract_json_string_field(json, "providerSigningSeedHex", &signing_seed_hex) ||
      !decode_hex_bytes(
          signing_seed_hex,
          provider_signing_seed_out->data(),
          provider_signing_seed_out->size())) {
    return false;
  }
  if (!ed25519_public_key_from_seed(
          provider_signing_seed_out->data(),
          provider_signing_seed_out->size(),
          provider_signing_public_out)) {
    return false;
  }

  std::string provider_peer_id;
  if (!extract_json_string_field(json, "providerPeerId", &provider_peer_id) ||
      provider_peer_id.empty()) {
    return false;
  }
  *provider_peer_id_out = provider_peer_id;

  std::string capability_token_base64;
  if (extract_json_string_field(json, "capabilityTokenBase64", &capability_token_base64) &&
      !capability_token_base64.empty()) {
    if (!decode_base64_bytes(capability_token_base64, capability_token_out)) {
      return false;
    }
  } else {
    capability_token_out->clear();
  }
  return true;
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

bool parse_runtime_config(
    std::string_view json,
    CryptoPP::SecByteBlock* private_key_out,
    CryptoPP::SecByteBlock* public_key_out,
    std::array<uint8_t, kDekBytes>* dek_out,
    int64_t* expires_at_ms_out,
    int64_t* max_skew_ms_out,
    int64_t* challenge_ttl_ms_out,
    uint32_t* key_version_out) {
  if (!private_key_out || !public_key_out || !dek_out || !expires_at_ms_out ||
      !max_skew_ms_out || !challenge_ttl_ms_out || !key_version_out) {
    return false;
  }

  std::string private_key_hex;
  const bool has_private_key =
      extract_json_string_field(json, "privateKeyHex", &private_key_hex) &&
      !private_key_hex.empty();
  bool generate_random_key = !has_private_key;
  extract_json_bool_field(json, "generateRandomKey", &generate_random_key);

  if (has_private_key) {
    std::array<uint8_t, 32> private_bytes{};
    if (!decode_hex_bytes(private_key_hex, private_bytes.data(), private_bytes.size()) ||
        !derive_public_key_from_private(
            private_bytes.data(), private_bytes.size(), private_key_out, public_key_out)) {
      secure_zero(private_bytes.data(), private_bytes.size());
      return false;
    }
    secure_zero(private_bytes.data(), private_bytes.size());
  } else if (!generate_random_key ||
             !generate_random_server_keypair(private_key_out, public_key_out)) {
    return false;
  }

  std::string dek_hex;
  const bool has_dek =
      extract_json_string_field(json, "dekHex", &dek_hex) && !dek_hex.empty();
  bool generate_random_dek = !has_dek;
  extract_json_bool_field(json, "generateRandomDek", &generate_random_dek);
  if (has_dek) {
    if (!decode_hex_bytes(dek_hex, dek_out->data(), dek_out->size())) {
      return false;
    }
  } else if (!generate_random_dek || !fill_random_bytes(dek_out->data(), dek_out->size())) {
    return false;
  }

  int64_t expires_at_ms = now_ms() + 24LL * 60LL * 60LL * 1000LL;
  extract_json_int64_field(json, "expiresAtMs", &expires_at_ms);
  *expires_at_ms_out = expires_at_ms;

  int64_t max_skew_ms = kDefaultMaxSkewMs;
  extract_json_int64_field(json, "maxClockSkewMs", &max_skew_ms);
  *max_skew_ms_out = max_skew_ms > 0 ? max_skew_ms : kDefaultMaxSkewMs;

  int64_t challenge_ttl_ms = kDefaultChallengeTtlMs;
  extract_json_int64_field(json, "challengeTtlMs", &challenge_ttl_ms);
  *challenge_ttl_ms_out =
      challenge_ttl_ms > 0 ? challenge_ttl_ms : kDefaultChallengeTtlMs;

  uint32_t key_version = 1;
  if (!parse_positive_json_u32(json, "activeKeyVersion", 1, &key_version)) {
    return false;
  }
  *key_version_out = key_version;
  return true;
}

int32_t handle_key_packet(
    const uint8_t* request_packet,
    size_t request_packet_len,
    std::vector<uint8_t>* response_packet_out) {
  if (!response_packet_out) {
    return kServerInternalError;
  }
  response_packet_out->clear();
  if (!g_initialized) {
    return kServerNotInitialized;
  }
  if (!request_packet || request_packet_len < kRequestHeaderBytes) {
    return kServerMalformed;
  }
  if (request_packet[0] != kProtocolVersion || request_packet[1] != 2) {
    return kServerMalformed;
  }

  const uint32_t requested_key_version = read_u32_le(request_packet + 4);
  if (requested_key_version == 0) {
    return kServerMalformed;
  }

  const uint8_t* client_public_key = request_packet + 56;
  const uint8_t* request_salt = request_packet + 56 + kClientPublicKeyBytes;
  const uint16_t request_blob_len =
      read_u16_be(request_packet + 56 + kClientPublicKeyBytes + kSaltBytes);
  if (request_blob_len < kGcmIvBytes + kGcmTagBytes ||
      request_packet_len != kRequestHeaderBytes + request_blob_len) {
    return kServerMalformed;
  }
  const uint8_t* request_blob = request_packet + kRequestHeaderBytes;

  std::string publication_key;
  const int32_t challenge_status = consume_challenge(
      request_packet + 8,
      requested_key_version,
      client_public_key,
      request_salt,
      request_blob,
      request_blob_len,
      request_packet + 24,
      &publication_key);
  if (challenge_status != kServerOk) {
    return challenge_status;
  }
  if (requested_key_version != g_active_key_version) {
    return kServerVersionNotFound;
  }

  ModulePublication publication{};
  if (!load_publication(publication_key, &publication)) {
    return kServerVersionNotFound;
  }

  auto& domain = ecdh_domain_p256();
  CryptoPP::SecByteBlock shared_secret(domain.AgreedValueLength());
  if (!domain.Agree(
          shared_secret.BytePtr(), g_server_private.BytePtr(), client_public_key)) {
    secure_zero(shared_secret.BytePtr(), shared_secret.size());
    return kServerCryptoError;
  }

  uint8_t request_key[kAesKeyBytes] = {0};
  if (!derive_hkdf_key(
          shared_secret.BytePtr(),
          shared_secret.size(),
          request_salt,
          kSaltBytes,
          "orbpro:kek:req:v3",
          request_key)) {
    secure_zero(shared_secret.BytePtr(), shared_secret.size());
    return kServerCryptoError;
  }

  std::vector<uint8_t> request_plaintext;
  if (!aes_gcm_decrypt(request_blob, request_blob_len, request_key, &request_plaintext)) {
    secure_zero(shared_secret.BytePtr(), shared_secret.size());
    secure_zero(request_key, sizeof(request_key));
    return kServerCryptoError;
  }
  if (request_plaintext.size() != kRequestPlaintextBytes ||
      request_plaintext[0] != kProtocolVersion) {
    secure_zero(shared_secret.BytePtr(), shared_secret.size());
    secure_zero(request_key, sizeof(request_key));
    secure_zero(request_plaintext.data(), request_plaintext.size());
    return kServerMalformed;
  }

  const int64_t timestamp_ms =
      static_cast<int64_t>(read_u64_le(request_plaintext.data() + 4));
  const int64_t now = now_ms();
  const int64_t skew = now - timestamp_ms;
  if (skew > g_max_skew_ms || skew < -g_max_skew_ms) {
    secure_zero(shared_secret.BytePtr(), shared_secret.size());
    secure_zero(request_key, sizeof(request_key));
    secure_zero(request_plaintext.data(), request_plaintext.size());
    return kServerClockSkew;
  }
  if (g_expires_at_ms > 0 && now > g_expires_at_ms) {
    secure_zero(shared_secret.BytePtr(), shared_secret.size());
    secure_zero(request_key, sizeof(request_key));
    secure_zero(request_plaintext.data(), request_plaintext.size());
    return kServerLicenseExpired;
  }

  std::array<uint8_t, kResponsePlaintextBytes> response_plaintext{};
  response_plaintext[0] = kProtocolVersion;
  response_plaintext[1] = 0;
  write_u32_le(response_plaintext.data() + 2, requested_key_version);
  write_u64_le(
      response_plaintext.data() + 6,
      static_cast<uint64_t>(g_expires_at_ms > 0 ? g_expires_at_ms : 0));
  std::memcpy(
      response_plaintext.data() + 14,
      publication.content_key.data(),
      publication.content_key.size());

  uint8_t response_salt[kSaltBytes] = {0};
  if (!fill_random_bytes(response_salt, sizeof(response_salt))) {
    secure_zero(shared_secret.BytePtr(), shared_secret.size());
    secure_zero(request_key, sizeof(request_key));
    secure_zero(request_plaintext.data(), request_plaintext.size());
    secure_zero(response_plaintext.data(), response_plaintext.size());
    return kServerCryptoError;
  }

  uint8_t response_key[kAesKeyBytes] = {0};
  if (!derive_hkdf_key(
          shared_secret.BytePtr(),
          shared_secret.size(),
          response_salt,
          sizeof(response_salt),
          "orbpro:kek:resp:v3",
          response_key)) {
    secure_zero(shared_secret.BytePtr(), shared_secret.size());
    secure_zero(request_key, sizeof(request_key));
    secure_zero(request_plaintext.data(), request_plaintext.size());
    secure_zero(response_plaintext.data(), response_plaintext.size());
    return kServerCryptoError;
  }

  std::vector<uint8_t> response_blob;
  if (!aes_gcm_encrypt(
          response_plaintext.data(),
          response_plaintext.size(),
          response_key,
          &response_blob)) {
    secure_zero(shared_secret.BytePtr(), shared_secret.size());
    secure_zero(request_key, sizeof(request_key));
    secure_zero(response_key, sizeof(response_key));
    secure_zero(request_plaintext.data(), request_plaintext.size());
    secure_zero(response_plaintext.data(), response_plaintext.size());
    return kServerCryptoError;
  }

  response_packet_out->assign(kResponseHeaderBytes + response_blob.size(), 0);
  (*response_packet_out)[0] = kProtocolVersion;
  (*response_packet_out)[1] = 0;
  (*response_packet_out)[2] = 0;
  (*response_packet_out)[3] = 0;
  std::memcpy(response_packet_out->data() + 4, response_salt, sizeof(response_salt));
  write_u16_be(response_packet_out->data() + 36, static_cast<uint16_t>(response_blob.size()));
  std::memcpy(response_packet_out->data() + kResponseHeaderBytes,
              response_blob.data(),
              response_blob.size());

  secure_zero(shared_secret.BytePtr(), shared_secret.size());
  secure_zero(request_key, sizeof(request_key));
  secure_zero(response_key, sizeof(response_key));
  secure_zero(response_salt, sizeof(response_salt));
  secure_zero_publication(&publication);
  secure_zero(request_plaintext.data(), request_plaintext.size());
  secure_zero(response_plaintext.data(), response_plaintext.size());
  secure_zero(response_blob.data(), response_blob.size());
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

  clear_pending_challenges();
  clear_pending_grants();
  clear_publications();

  secure_zero(g_dek.data(), g_dek.size());
  g_server_private = CryptoPP::SecByteBlock();
  g_server_public = CryptoPP::SecByteBlock();
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

int32_t key_server_get_public_key(std::vector<uint8_t>& response_out) {
  if (!g_initialized || g_server_public.size() != kClientPublicKeyBytes) {
    return kServerNotInitialized;
  }
  response_out = build_public_key_response_bytes();
  return 0;
}

int32_t key_server_request_challenge(
    const uint8_t* request,
    uint32_t request_len,
    std::vector<uint8_t>& response_out) {
  response_out.clear();
  if (!g_initialized) {
    build_challenge_error_json(kServerNotInitialized, &response_out);
    return 0;
  }

  uint32_t requested_version = g_active_key_version;
  std::string module_id;
  std::string module_version;
  if (request && request_len > 0) {
    const std::string_view request_text(
        reinterpret_cast<const char*>(request),
        static_cast<size_t>(request_len));
    if (!parse_positive_json_u32(
            request_text, "keyVersion", g_active_key_version, &requested_version)) {
      build_challenge_error_json(kServerMalformed, &response_out);
      return 0;
    }
    if (!extract_json_string_field(request_text, "moduleId", &module_id) ||
        module_id.empty()) {
      build_challenge_error_json(kServerMalformed, &response_out);
      return 0;
    }
    extract_json_string_field(request_text, "moduleVersion", &module_version);
  } else {
    build_challenge_error_json(kServerMalformed, &response_out);
    return 0;
  }

  const std::string publication_key = make_publication_key(module_id, module_version);
  {
    std::lock_guard<std::mutex> lock(g_publication_mutex);
    if (g_publications.find(publication_key) == g_publications.end()) {
      build_challenge_error_json(kServerVersionNotFound, &response_out);
      return 0;
    }
  }

  const int64_t now = now_ms();
  std::array<uint8_t, kChallengeIdBytes> challenge_id{};
  std::array<uint8_t, kChallengeTokenRawBytes> challenge_token_raw{};
  if (!fill_random_bytes(challenge_id.data(), challenge_id.size()) ||
      !fill_random_bytes(challenge_token_raw.data(), challenge_token_raw.size())) {
    secure_zero(challenge_id.data(), challenge_id.size());
    secure_zero(challenge_token_raw.data(), challenge_token_raw.size());
    build_challenge_error_json(kServerCryptoError, &response_out);
    return 0;
  }

  PendingChallenge challenge{};
  challenge.key_version = requested_version;
  challenge.expires_at_ms = now + g_challenge_ttl_ms;
  challenge.publication_key = publication_key;
  const std::string challenge_token =
      encode_hex_bytes(challenge_token_raw.data(), challenge_token_raw.size());
  std::memcpy(challenge.token.data(), challenge_token.data(), challenge_token.size());

  const std::string challenge_id_hex = encode_hex_bytes(challenge_id.data(), challenge_id.size());
  {
    std::lock_guard<std::mutex> lock(g_challenge_mutex);
    cleanup_pending_challenges_locked(now);
    if (g_pending_challenges.size() >= 10000) {
      secure_zero(challenge_id.data(), challenge_id.size());
      secure_zero(challenge_token_raw.data(), challenge_token_raw.size());
      secure_zero(challenge.token.data(), challenge.token.size());
      build_challenge_error_json(kServerChallengeRateLimited, &response_out);
      return 0;
    }
    g_pending_challenges.emplace(challenge_id_hex, challenge);
  }

  const std::string json =
      "{\"version\":3,\"protocolVersion\":3,\"challengeId\":\"" + challenge_id_hex +
      "\",\"challengeToken\":\"" + challenge_token + "\",\"keyVersion\":" +
      std::to_string(requested_version) + ",\"expiresAtMs\":" +
      std::to_string(challenge.expires_at_ms) + "}";
  response_out.assign(json.begin(), json.end());

  secure_zero(challenge_id.data(), challenge_id.size());
  secure_zero(challenge_token_raw.data(), challenge_token_raw.size());
  secure_zero(challenge.token.data(), challenge.token.size());
  return 0;
}

int32_t key_server_handle_key_request(
    const uint8_t* request,
    uint32_t request_len,
    std::vector<uint8_t>& response_out) {
  response_out.clear();

  uint32_t status = static_cast<uint32_t>(kServerMalformed);
  std::vector<uint8_t> response_packet;

  if (request && request_len > 0) {
    flatbuffers::Verifier verifier(request, request_len);
    if (orbpro::keybroker::VerifyKeyBrokerRequestBuffer(verifier)) {
      const auto* envelope = orbpro::keybroker::GetKeyBrokerRequest(request);
      const auto* packet = envelope->packet();
      if (packet && packet->size() > 0) {
        status = static_cast<uint32_t>(handle_key_packet(
            packet->data(),
            packet->size(),
            &response_packet));
      }
    }
  }

  response_out = build_key_broker_response_bytes(status, response_packet);
  secure_zero(response_packet.data(), response_packet.size());
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

    // PKI xpub allowlist: early membership filter on the claimed xpub. The
    // cryptographic binding of that xpub to the requester's proven ed25519 signing
    // key (via the re-sent EPM) is verified at proof time below.
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

    {
      std::lock_guard<std::mutex> lock(g_pending_grant_mutex);
      g_pending_grants[request_id] = std::move(pending);
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
  {
    std::lock_guard<std::mutex> lock(g_pending_grant_mutex);
    const auto it = g_pending_grants.find(proof->REQUEST_ID()->str());
    if (it == g_pending_grants.end()) {
      return kServerChallengeInvalid;
    }
    pending = it->second;
    g_pending_grants.erase(it);
  }

  if (proof->SIGNING_PUBKEY()->size() != 32 ||
      proof->REQUESTER_EPHEMERAL_PUBKEY()->size() != 32 ||
      proof->CHALLENGE_NONCE()->size() != pending.challenge_nonce.size() ||
      proof->SIGNATURE()->size() != 64) {
    return kServerMalformed;
  }
  if (pending.expires_at_ms <= static_cast<uint64_t>(now_ms())) {
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
  // xpub (cross-curve attestation), and that xpub must equal the allowlisted one.
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
  }

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
    secure_zero_publication(&publication);
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
  if (!sdm_keyslot::keyslot_sign(
          g_provider_signing_slot_id,
          grant_response_bytes.data(),
          grant_response_bytes.size(),
          &provider_signature) ||
      provider_signature.size() != kProviderSignatureBytes) {
    secure_zero_publication(&publication);
    secure_zero(provider_signature.data(), provider_signature.size());
    return kServerCryptoError;
  }
  if (!replace_lgr_provider_signature(
          &grant_response_bytes,
          provider_signature.data(),
          provider_signature.size())) {
    secure_zero_publication(&publication);
    secure_zero(provider_signature.data(), provider_signature.size());
    return kServerCryptoError;
  }
  response_out.assign(grant_response_bytes.begin(), grant_response_bytes.end());
  secure_zero_publication(&publication);
  secure_zero(provider_signature.data(), provider_signature.size());
  return 0;
}
