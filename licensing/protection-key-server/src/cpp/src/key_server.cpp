#include "key_server_api.h"

#include "xpub_auth.h"

#include "KeyBrokerRequest_generated.h"
#include "KeyBrokerResponse_generated.h"
#include "PublicKeyResponse_generated.h"

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

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "../../../../../common/sdm_hostcall_wire.hpp"

namespace {

constexpr uint8_t kProtocolVersion = 3;
constexpr size_t kChallengeIdBytes = 16;
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
};

struct PendingChallenge {
  uint32_t key_version = 1;
  int64_t expires_at_ms = 0;
  std::array<uint8_t, kChallengeTokenHexBytes> token{};
};

bool g_initialized = false;
CryptoPP::SecByteBlock g_server_private;
CryptoPP::SecByteBlock g_server_public;
std::array<uint8_t, kDekBytes> g_dek{};
int64_t g_expires_at_ms = 0;
int64_t g_max_skew_ms = kDefaultMaxSkewMs;
int64_t g_challenge_ttl_ms = kDefaultChallengeTtlMs;
uint32_t g_active_key_version = 1;

std::mutex g_challenge_mutex;
std::unordered_map<std::string, PendingChallenge> g_pending_challenges;

void secure_zero(void* ptr, size_t len) {
  if (!ptr || len == 0) {
    return;
  }
  volatile auto* bytes = static_cast<volatile uint8_t*>(ptr);
  for (size_t i = 0; i < len; ++i) {
    bytes[i] = 0;
  }
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
    const uint8_t* challenge_proof) {
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

  const int32_t challenge_status = consume_challenge(
      request_packet + 8,
      requested_key_version,
      client_public_key,
      request_salt,
      request_blob,
      request_blob_len,
      request_packet + 24);
  if (challenge_status != kServerOk) {
    return challenge_status;
  }
  if (requested_key_version != g_active_key_version) {
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
  std::memcpy(response_plaintext.data() + 14, g_dek.data(), g_dek.size());

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
  secure_zero(request_plaintext.data(), request_plaintext.size());
  secure_zero(response_plaintext.data(), response_plaintext.size());
  secure_zero(response_blob.data(), response_blob.size());
  return kServerOk;
}

}  // namespace

int32_t key_server_configure_runtime(
    const uint8_t* config_json,
    uint32_t config_len,
    std::vector<uint8_t>& status_out) {
  const std::string_view config_text(
      reinterpret_cast<const char*>(config_json),
      static_cast<size_t>(config_len));

  CryptoPP::SecByteBlock next_private;
  CryptoPP::SecByteBlock next_public;
  std::array<uint8_t, kDekBytes> next_dek{};
  int64_t next_expires_at_ms = 0;
  int64_t next_max_skew_ms = kDefaultMaxSkewMs;
  int64_t next_challenge_ttl_ms = kDefaultChallengeTtlMs;
  uint32_t next_key_version = 1;

  if (!parse_runtime_config(
          config_text,
          &next_private,
          &next_public,
          &next_dek,
          &next_expires_at_ms,
          &next_max_skew_ms,
          &next_challenge_ttl_ms,
          &next_key_version)) {
    secure_zero(next_dek.data(), next_dek.size());
    return kServerMalformed;
  }

  clear_pending_challenges();

  secure_zero(g_dek.data(), g_dek.size());
  g_server_private = next_private;
  g_server_public = next_public;
  g_dek = next_dek;
  g_expires_at_ms = next_expires_at_ms;
  g_max_skew_ms = next_max_skew_ms;
  g_challenge_ttl_ms = next_challenge_ttl_ms;
  g_active_key_version = next_key_version;
  g_initialized = true;

  const std::string json =
      "{\"ok\":true,\"keyVersion\":" + std::to_string(g_active_key_version) +
      ",\"expiresAtMs\":" + std::to_string(g_expires_at_ms) +
      ",\"publicKeyHex\":\"" +
      encode_hex_bytes(g_server_public.BytePtr(), g_server_public.size()) + "\"}";
  status_out.assign(json.begin(), json.end());
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
  if (request && request_len > 0) {
    const std::string_view request_text(
        reinterpret_cast<const char*>(request),
        static_cast<size_t>(request_len));
    if (!parse_positive_json_u32(
            request_text, "keyVersion", g_active_key_version, &requested_version)) {
      build_challenge_error_json(kServerMalformed, &response_out);
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
  const std::string json =
      std::string("{\"initialized\":") + (g_initialized ? "true" : "false") +
      ",\"keyVersion\":" + std::to_string(g_active_key_version) +
      ",\"expiresAtMs\":" + std::to_string(g_expires_at_ms) +
      ",\"needsRotation\":" + (needs_rotation ? "true" : "false") + "}";
  status_out.assign(json.begin(), json.end());
  return 0;
}
