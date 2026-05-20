#include "license_client_api.h"

#ifdef TIME_UTC
#undef TIME_UTC
#endif

#include "KeyBrokerRequest_generated.h"
#include "KeyBrokerResponse_generated.h"
#include "ENC_generated.h"
#include "LCH_generated.h"
#include "LGR_generated.h"
#include "LPF_generated.h"
#include "PLG_generated.h"
#include "PublicKeyResponse_generated.h"
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

extern "C" __attribute__((import_module("space_data_module_host"), import_name("call_json")))
int32_t space_data_module_host_call_json(const char* operation_ptr, int32_t operation_len,
                           const char* payload_ptr, int32_t payload_len);

extern "C" __attribute__((import_module("space_data_module_host"), import_name("response_len")))
int32_t space_data_module_host_response_len(void);

extern "C" __attribute__((import_module("space_data_module_host"), import_name("read_response")))
int32_t space_data_module_host_read_response(char* dst_ptr, int32_t dst_len);

extern "C" __attribute__((import_module("space_data_module_host"), import_name("clear_response")))
int32_t space_data_module_host_clear_response(void);

extern "C" __attribute__((import_module("space_data_module_host"), import_name("last_status_code")))
int32_t space_data_module_host_last_status_code(void);

namespace {

constexpr uint8_t kProtocolVersion = 3;
constexpr size_t kDekBytes = 32;
constexpr size_t kAesKeyBytes = 32;
constexpr size_t kGcmIvBytes = 12;
constexpr size_t kGcmTagBytes = 16;
constexpr size_t kSaltBytes = 32;
constexpr size_t kChallengeIdBytes = 16;
constexpr size_t kChallengeProofBytes = 32;
constexpr size_t kPublicKeyBytes = 65;
constexpr size_t kRequestPlaintextBytes = 12;
constexpr size_t kRequestHeaderBytes =
    4 + 4 + kChallengeIdBytes + kChallengeProofBytes + kPublicKeyBytes + kSaltBytes + 2;
constexpr size_t kResponseResultBytes = 44;
constexpr size_t kResponseHeaderBytes = 38;

constexpr int32_t kClientOk = 0;
constexpr int32_t kClientMalformed = -1;
constexpr int32_t kClientCryptoError = -5;
constexpr int32_t kClientInternalError = -7;
constexpr int32_t kClientInvalidSignature = -17;

constexpr const char* kPublicKeyProtocolId = "/orbpro/public-key/1.0.0";
constexpr const char* kChallengeProtocolId = "/orbpro/challenge/1.0.0";
constexpr const char* kKeyBrokerProtocolId = "/orbpro/key-broker/1.0.0";
constexpr const char* kModuleDeliveryProtocolId =
    "/space-data-network/module-delivery/1.0.0";
constexpr uint16_t kKmfKeyBytesFieldId = 4;
constexpr const char* kGrantPayloadContext =
    "space-data-network/module-delivery/grant/v1";

struct ClientSession {
  std::array<uint8_t, 32> shared_secret{};
};

struct ClientGrantSession {
  std::array<uint8_t, 32> ephemeral_private_key{};
};

std::mutex g_client_session_mutex;
std::unordered_map<uint32_t, ClientSession> g_client_sessions;
uint32_t g_next_session_id = 1;

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

std::string encode_base64_bytes(const uint8_t* bytes, size_t size) {
  static constexpr char kAlphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string output;
  output.reserve(((size + 2) / 3) * 4);
  size_t cursor = 0;
  while (cursor + 3 <= size) {
    const uint32_t block =
        (static_cast<uint32_t>(bytes[cursor]) << 16) |
        (static_cast<uint32_t>(bytes[cursor + 1]) << 8) |
        static_cast<uint32_t>(bytes[cursor + 2]);
    output.push_back(kAlphabet[(block >> 18) & 0x3f]);
    output.push_back(kAlphabet[(block >> 12) & 0x3f]);
    output.push_back(kAlphabet[(block >> 6) & 0x3f]);
    output.push_back(kAlphabet[block & 0x3f]);
    cursor += 3;
  }
  const size_t remaining = size - cursor;
  if (remaining == 1) {
    const uint32_t block = static_cast<uint32_t>(bytes[cursor]) << 16;
    output.push_back(kAlphabet[(block >> 18) & 0x3f]);
    output.push_back(kAlphabet[(block >> 12) & 0x3f]);
    output.push_back('=');
    output.push_back('=');
  } else if (remaining == 2) {
    const uint32_t block =
        (static_cast<uint32_t>(bytes[cursor]) << 16) |
        (static_cast<uint32_t>(bytes[cursor + 1]) << 8);
    output.push_back(kAlphabet[(block >> 18) & 0x3f]);
    output.push_back(kAlphabet[(block >> 12) & 0x3f]);
    output.push_back(kAlphabet[(block >> 6) & 0x3f]);
    output.push_back('=');
  }
  return output;
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

bool read_host_json_response(std::string* response_out) {
  if (!response_out) {
    return false;
  }
  const int32_t response_len = space_data_module_host_response_len();
  if (response_len < 0) {
    space_data_module_host_clear_response();
    return false;
  }
  std::string response(static_cast<size_t>(response_len), '\0');
  const int32_t copied =
      response_len > 0 ? space_data_module_host_read_response(response.data(), response_len) : 0;
  space_data_module_host_clear_response();
  if (copied != response_len) {
    return false;
  }
  *response_out = response;
  return true;
}

bool call_host_json(
    std::string_view operation,
    std::string_view payload,
    std::string* response_out) {
  const int32_t rc = space_data_module_host_call_json(
      operation.data(),
      static_cast<int32_t>(operation.size()),
      payload.empty() ? nullptr : payload.data(),
      static_cast<int32_t>(payload.size()));
  const int32_t status = space_data_module_host_last_status_code();
  if (!read_host_json_response(response_out)) {
    return false;
  }
  bool ok = false;
  return rc == 0 && status == 0 &&
         extract_json_bool_field(*response_out, "ok", &ok) && ok;
}

bool call_host_json_ok(
    std::string_view operation,
    std::string_view payload,
    std::string* response_out) {
  return call_host_json(operation, payload, response_out);
}

bool call_host_json_bool_result(
    std::string_view operation,
    std::string_view payload,
    bool* value_out) {
  if (!value_out) {
    return false;
  }
  std::string response;
  if (!call_host_json_ok(operation, payload, &response)) {
    return false;
  }
  return extract_json_bool_field(response, "result", value_out);
}

bool call_host_json_bytes(
    std::string_view operation,
    std::string_view payload,
    std::vector<uint8_t>* bytes_out) {
  if (!bytes_out) {
    return false;
  }
  std::string response;
  if (!call_host_json_ok(operation, payload, &response)) {
    return false;
  }
  std::string base64;
  if (!extract_json_string_field(response, "result", &base64) &&
      !extract_json_string_field(response, "base64", &base64)) {
    return false;
  }
  return decode_base64_bytes(base64, bytes_out);
}

int64_t now_ms() {
  std::string response;
  int64_t value = 0;
  if (!call_host_json_ok("clock.now", "{}", &response)) {
    return 0;
  }
  if (!extract_json_int64_field(response, "result", &value)) {
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
  const std::string payload = "{\"length\":" + std::to_string(len) + "}";
  std::string response;
  if (!call_host_json_ok("random.bytes", payload, &response)) {
    return false;
  }
  std::string base64;
  if (!extract_json_string_field(response, "base64", &base64)) {
    return false;
  }
  std::vector<uint8_t> random_bytes;
  if (!decode_base64_bytes(base64, &random_bytes) || random_bytes.size() != len) {
    secure_zero(random_bytes.data(), random_bytes.size());
    return false;
  }
  std::memcpy(bytes, random_bytes.data(), len);
  secure_zero(random_bytes.data(), random_bytes.size());
  return true;
}

bool protocol_request(
    std::string_view target,
    std::string_view protocol_id,
    const uint8_t* payload,
    size_t payload_len,
    std::vector<uint8_t>* response_out) {
  if (!response_out) {
    return false;
  }
  const std::string payload_base64 = encode_base64_bytes(payload, payload_len);
  const std::string request_json =
      "{\"target\":\"" + escape_json_string(target) + "\",\"protocolId\":\"" +
      escape_json_string(protocol_id) + "\",\"payloadBase64\":\"" + payload_base64 + "\"}";
  std::string response;
  if (!call_host_json_ok("protocol.request", request_json, &response)) {
    return false;
  }
  std::string base64;
  if (!extract_json_string_field(response, "base64", &base64)) {
    response_out->clear();
    return true;
  }
  return decode_base64_bytes(base64, response_out);
}

bool ipfs_cat(
    std::string_view cid,
    std::vector<uint8_t>* response_out) {
  if (!response_out) {
    return false;
  }
  const std::string request_json =
      "{\"cid\":\"" + escape_json_string(cid) + "\"}";
  std::string response;
  if (!call_host_json_ok("ipfs.cat", request_json, &response)) {
    return false;
  }
  std::string base64;
  if (!extract_json_string_field(response, "base64", &base64)) {
    response_out->clear();
    return false;
  }
  return decode_base64_bytes(base64, response_out);
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

  derived_public_key->CleanNew(kPublicKeyBytes);
  params.GetCurve().EncodePoint(derived_public_key->BytePtr(), public_point, false);
  return true;
}

bool generate_ephemeral_keypair(
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

bool compute_challenge_proof(
    const uint8_t* challenge_id,
    uint32_t key_version,
    const uint8_t* client_public_key,
    const uint8_t* request_salt,
    const uint8_t* request_blob,
    size_t request_blob_len,
    const uint8_t* challenge_token,
    size_t challenge_token_len,
    uint8_t proof_out[kChallengeProofBytes]) {
  if (!challenge_id || !client_public_key || !request_salt || !request_blob ||
      !challenge_token || challenge_token_len == 0 || !proof_out) {
    return false;
  }

  uint8_t key_version_le[4] = {0};
  write_u32_le(key_version_le, key_version);

  uint8_t blob_hash[CryptoPP::SHA256::DIGESTSIZE] = {0};
  CryptoPP::SHA256 sha256;
  sha256.Update(request_blob, request_blob_len);
  sha256.Final(blob_hash);

  CryptoPP::HMAC<CryptoPP::SHA256> hmac(challenge_token, challenge_token_len);
  hmac.Update(challenge_id, kChallengeIdBytes);
  hmac.Update(key_version_le, sizeof(key_version_le));
  hmac.Update(client_public_key, kPublicKeyBytes);
  hmac.Update(request_salt, kSaltBytes);
  hmac.Update(blob_hash, sizeof(blob_hash));
  hmac.Final(proof_out);

  secure_zero(blob_hash, sizeof(blob_hash));
  return true;
}

bool store_client_session(const std::array<uint8_t, 32>& shared_secret, uint32_t* session_id_out) {
  if (!session_id_out) {
    return false;
  }
  std::lock_guard<std::mutex> lock(g_client_session_mutex);
  uint32_t session_id = g_next_session_id++;
  if (session_id == 0) {
    session_id = g_next_session_id++;
  }
  g_client_sessions.emplace(session_id, ClientSession{shared_secret});
  *session_id_out = session_id;
  return true;
}

bool take_client_session(uint32_t session_id, ClientSession* session_out) {
  if (!session_out) {
    return false;
  }
  std::lock_guard<std::mutex> lock(g_client_session_mutex);
  const auto it = g_client_sessions.find(session_id);
  if (it == g_client_sessions.end()) {
    return false;
  }
  *session_out = it->second;
  g_client_sessions.erase(it);
  return true;
}

void destroy_client_session(uint32_t session_id) {
  std::lock_guard<std::mutex> lock(g_client_session_mutex);
  const auto it = g_client_sessions.find(session_id);
  if (it != g_client_sessions.end()) {
    secure_zero(it->second.shared_secret.data(), it->second.shared_secret.size());
    g_client_sessions.erase(it);
  }
}

int32_t begin_dek_session(
    const uint8_t* server_public_key,
    uint32_t key_version,
    const uint8_t* challenge_id,
    size_t challenge_id_len,
    const uint8_t* challenge_token,
    size_t challenge_token_len,
    uint32_t* session_id_out,
    std::vector<uint8_t>* output_packet_out) {
  if (!server_public_key || !challenge_id || challenge_id_len != kChallengeIdBytes ||
      !session_id_out || !output_packet_out || key_version == 0 ||
      challenge_token_len == 0) {
    return kClientMalformed;
  }

  CryptoPP::SecByteBlock client_private;
  CryptoPP::SecByteBlock client_public;
  if (!generate_ephemeral_keypair(&client_private, &client_public) ||
      client_public.size() != kPublicKeyBytes) {
    return kClientCryptoError;
  }

  auto& domain = ecdh_domain_p256();
  std::array<uint8_t, 32> shared_secret{};
  if (!domain.Agree(shared_secret.data(), client_private.BytePtr(), server_public_key)) {
    secure_zero(client_private.BytePtr(), client_private.size());
    secure_zero(client_public.BytePtr(), client_public.size());
    secure_zero(shared_secret.data(), shared_secret.size());
    return kClientCryptoError;
  }

  uint8_t request_salt[kSaltBytes] = {0};
  if (!fill_random_bytes(request_salt, sizeof(request_salt))) {
    secure_zero(client_private.BytePtr(), client_private.size());
    secure_zero(client_public.BytePtr(), client_public.size());
    secure_zero(shared_secret.data(), shared_secret.size());
    return kClientCryptoError;
  }

  uint8_t request_key[kAesKeyBytes] = {0};
  if (!derive_hkdf_key(
          shared_secret.data(),
          shared_secret.size(),
          request_salt,
          sizeof(request_salt),
          "orbpro:kek:req:v3",
          request_key)) {
    secure_zero(client_private.BytePtr(), client_private.size());
    secure_zero(client_public.BytePtr(), client_public.size());
    secure_zero(shared_secret.data(), shared_secret.size());
    secure_zero(request_salt, sizeof(request_salt));
    return kClientCryptoError;
  }

  uint8_t request_plaintext[kRequestPlaintextBytes] = {0};
  request_plaintext[0] = kProtocolVersion;
  write_u64_le(request_plaintext + 4, static_cast<uint64_t>(now_ms()));

  std::vector<uint8_t> request_blob;
  if (!aes_gcm_encrypt(
          request_plaintext,
          sizeof(request_plaintext),
          request_key,
          &request_blob)) {
    secure_zero(client_private.BytePtr(), client_private.size());
    secure_zero(client_public.BytePtr(), client_public.size());
    secure_zero(shared_secret.data(), shared_secret.size());
    secure_zero(request_salt, sizeof(request_salt));
    secure_zero(request_key, sizeof(request_key));
    secure_zero(request_plaintext, sizeof(request_plaintext));
    return kClientCryptoError;
  }

  uint8_t proof[kChallengeProofBytes] = {0};
  if (!compute_challenge_proof(
          challenge_id,
          key_version,
          client_public.BytePtr(),
          request_salt,
          request_blob.data(),
          request_blob.size(),
          challenge_token,
          challenge_token_len,
          proof)) {
    secure_zero(client_private.BytePtr(), client_private.size());
    secure_zero(client_public.BytePtr(), client_public.size());
    secure_zero(shared_secret.data(), shared_secret.size());
    secure_zero(request_salt, sizeof(request_salt));
    secure_zero(request_key, sizeof(request_key));
    secure_zero(request_plaintext, sizeof(request_plaintext));
    secure_zero(request_blob.data(), request_blob.size());
    return kClientCryptoError;
  }

  output_packet_out->assign(kRequestHeaderBytes + request_blob.size(), 0);
  (*output_packet_out)[0] = kProtocolVersion;
  (*output_packet_out)[1] = 2;
  (*output_packet_out)[2] = 0;
  (*output_packet_out)[3] = 0;
  write_u32_le(output_packet_out->data() + 4, key_version);
  std::memcpy(output_packet_out->data() + 8, challenge_id, kChallengeIdBytes);
  std::memcpy(output_packet_out->data() + 24, proof, kChallengeProofBytes);
  std::memcpy(output_packet_out->data() + 56, client_public.BytePtr(), client_public.size());
  std::memcpy(output_packet_out->data() + 56 + kPublicKeyBytes, request_salt, sizeof(request_salt));
  write_u16_be(
      output_packet_out->data() + 56 + kPublicKeyBytes + kSaltBytes,
      static_cast<uint16_t>(request_blob.size()));
  std::memcpy(output_packet_out->data() + kRequestHeaderBytes, request_blob.data(), request_blob.size());

  if (!store_client_session(shared_secret, session_id_out)) {
    secure_zero(client_private.BytePtr(), client_private.size());
    secure_zero(client_public.BytePtr(), client_public.size());
    secure_zero(shared_secret.data(), shared_secret.size());
    secure_zero(request_salt, sizeof(request_salt));
    secure_zero(request_key, sizeof(request_key));
    secure_zero(request_plaintext, sizeof(request_plaintext));
    secure_zero(proof, sizeof(proof));
    secure_zero(request_blob.data(), request_blob.size());
    return kClientInternalError;
  }

  secure_zero(client_private.BytePtr(), client_private.size());
  secure_zero(client_public.BytePtr(), client_public.size());
  secure_zero(shared_secret.data(), shared_secret.size());
  secure_zero(request_salt, sizeof(request_salt));
  secure_zero(request_key, sizeof(request_key));
  secure_zero(request_plaintext, sizeof(request_plaintext));
  secure_zero(proof, sizeof(proof));
  secure_zero(request_blob.data(), request_blob.size());
  return kClientOk;
}

int32_t finish_dek_session(
    uint32_t session_id,
    const uint8_t* response_packet,
    size_t response_packet_len,
    uint32_t expected_key_version,
    std::vector<uint8_t>* result_out) {
  if (!response_packet || !result_out || expected_key_version == 0) {
    destroy_client_session(session_id);
    return kClientMalformed;
  }

  ClientSession session{};
  if (!take_client_session(session_id, &session)) {
    return kClientInternalError;
  }

  if (response_packet_len < kResponseHeaderBytes || response_packet[0] != kProtocolVersion ||
      response_packet[1] != 0) {
    secure_zero(session.shared_secret.data(), session.shared_secret.size());
    return kClientMalformed;
  }

  const uint8_t* response_salt = response_packet + 4;
  const uint16_t response_blob_len = read_u16_be(response_packet + 36);
  if (response_blob_len < kGcmIvBytes + kGcmTagBytes ||
      response_packet_len < kResponseHeaderBytes + response_blob_len) {
    secure_zero(session.shared_secret.data(), session.shared_secret.size());
    return kClientMalformed;
  }

  uint8_t response_key[kAesKeyBytes] = {0};
  if (!derive_hkdf_key(
          session.shared_secret.data(),
          session.shared_secret.size(),
          response_salt,
          kSaltBytes,
          "orbpro:kek:resp:v3",
          response_key)) {
    secure_zero(session.shared_secret.data(), session.shared_secret.size());
    return kClientCryptoError;
  }

  std::vector<uint8_t> plaintext;
  if (!aes_gcm_decrypt(
          response_packet + kResponseHeaderBytes,
          response_blob_len,
          response_key,
          &plaintext)) {
    secure_zero(response_key, sizeof(response_key));
    secure_zero(session.shared_secret.data(), session.shared_secret.size());
    return kClientMalformed;
  }

  if (plaintext.size() != 46 || plaintext[0] != kProtocolVersion || plaintext[1] != 0) {
    secure_zero(response_key, sizeof(response_key));
    secure_zero(session.shared_secret.data(), session.shared_secret.size());
    secure_zero(plaintext.data(), plaintext.size());
    return kClientMalformed;
  }

  const uint32_t served_key_version = read_u32_le(plaintext.data() + 2);
  if (served_key_version != expected_key_version) {
    secure_zero(response_key, sizeof(response_key));
    secure_zero(session.shared_secret.data(), session.shared_secret.size());
    secure_zero(plaintext.data(), plaintext.size());
    return kClientMalformed;
  }

  result_out->assign(kResponseResultBytes, 0);
  write_u32_le(result_out->data(), served_key_version);
  write_u64_le(result_out->data() + 4, read_u64_le(plaintext.data() + 6));
  std::memcpy(result_out->data() + 12, plaintext.data() + 14, 32);

  secure_zero(response_key, sizeof(response_key));
  secure_zero(session.shared_secret.data(), session.shared_secret.size());
  secure_zero(plaintext.data(), plaintext.size());
  return kClientOk;
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
  const std::string request_json =
      "{\"message\":\"" + encode_base64_bytes(message, message_len) +
      "\",\"signature\":\"" + encode_base64_bytes(signature, signature_len) +
      "\",\"publicKey\":\"" + encode_base64_bytes(public_key, public_key_len) + "\"}";
  return call_host_json_bool_result(
      "crypto.ed25519.verify", request_json, valid_out);
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
  std::vector<uint8_t> public_key_bytes;
  const std::string request_json =
      "{\"seed\":\"" + encode_base64_bytes(seed, seed_len) + "\"}";
  if (!call_host_json_bytes(
          "crypto.ed25519.publicKeyFromSeed",
          request_json,
          &public_key_bytes) ||
      public_key_bytes.size() != public_key_out->size()) {
    return false;
  }
  std::memcpy(
      public_key_out->data(),
      public_key_bytes.data(),
      public_key_out->size());
  return true;
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
  std::vector<uint8_t> signature_bytes;
  const std::string request_json =
      "{\"message\":\"" + encode_base64_bytes(message, message_len) +
      "\",\"seed\":\"" + encode_base64_bytes(seed, seed_len) + "\"}";
  if (!call_host_json_bytes(
          "crypto.ed25519.sign", request_json, &signature_bytes) ||
      signature_bytes.size() != signature_out->size()) {
    return false;
  }
  std::memcpy(
      signature_out->data(),
      signature_bytes.data(),
      signature_out->size());
  return true;
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

int32_t license_client_get_dek(
    const uint8_t* request_json,
    uint32_t request_len,
    std::vector<uint8_t>& response_out) {
  response_out.clear();
  std::string_view request_text(
      reinterpret_cast<const char*>(request_json),
      static_cast<size_t>(request_len));

  std::string target;
  extract_json_string_field(request_text, "target", &target);
  std::string module_id;
  if (!extract_json_string_field(request_text, "moduleId", &module_id) ||
      module_id.empty()) {
    return kClientMalformed;
  }
  std::string module_version;
  extract_json_string_field(request_text, "moduleVersion", &module_version);
  uint32_t requested_key_version = 1;
  int64_t parsed_key_version = 0;
  if (extract_json_int64_field(request_text, "keyVersion", &parsed_key_version)) {
    if (parsed_key_version <= 0 || parsed_key_version > static_cast<int64_t>(UINT32_MAX)) {
      return kClientMalformed;
    }
    requested_key_version = static_cast<uint32_t>(parsed_key_version);
  }

  std::vector<uint8_t> public_key_response;
  if (!protocol_request(
          target, kPublicKeyProtocolId, nullptr, 0, &public_key_response)) {
    return kClientInternalError;
  }
  flatbuffers::Verifier public_key_verifier(
      public_key_response.data(), public_key_response.size());
  if (!orbpro::keybroker::VerifyPublicKeyResponseBuffer(public_key_verifier)) {
    return kClientMalformed;
  }
  const auto* public_key_root =
      orbpro::keybroker::GetPublicKeyResponse(public_key_response.data());
  const auto* server_public_key = public_key_root->public_key();
  if (!server_public_key || server_public_key->size() != kPublicKeyBytes) {
    return kClientMalformed;
  }

  const std::string challenge_request_json =
      "{\"moduleId\":\"" + escape_json_string(module_id) +
      "\",\"moduleVersion\":\"" + escape_json_string(module_version) +
      "\",\"keyVersion\":" + std::to_string(requested_key_version) + "}";
  std::vector<uint8_t> challenge_response;
  if (!protocol_request(
          target,
          kChallengeProtocolId,
          reinterpret_cast<const uint8_t*>(challenge_request_json.data()),
          challenge_request_json.size(),
          &challenge_response)) {
    return kClientInternalError;
  }

  const std::string_view challenge_text(
      reinterpret_cast<const char*>(challenge_response.data()),
      challenge_response.size());
  int64_t challenge_error = 0;
  if (extract_json_int64_field(challenge_text, "error", &challenge_error) &&
      challenge_error != 0) {
    return static_cast<int32_t>(challenge_error);
  }

  std::string challenge_id_hex;
  std::string challenge_token;
  int64_t challenge_key_version_value = requested_key_version;
  if (!extract_json_string_field(challenge_text, "challengeId", &challenge_id_hex) ||
      !extract_json_string_field(challenge_text, "challengeToken", &challenge_token) ||
      !extract_json_int64_field(challenge_text, "keyVersion", &challenge_key_version_value) ||
      challenge_key_version_value <= 0 ||
      challenge_key_version_value > static_cast<int64_t>(UINT32_MAX)) {
    return kClientMalformed;
  }

  std::array<uint8_t, kChallengeIdBytes> challenge_id{};
  if (!decode_hex_bytes(challenge_id_hex, challenge_id.data(), challenge_id.size())) {
    secure_zero(challenge_id.data(), challenge_id.size());
    return kClientMalformed;
  }

  uint32_t session_id = 0;
  std::vector<uint8_t> request_packet;
  const int32_t begin_status = begin_dek_session(
      server_public_key->data(),
      static_cast<uint32_t>(challenge_key_version_value),
      challenge_id.data(),
      challenge_id.size(),
      reinterpret_cast<const uint8_t*>(challenge_token.data()),
      challenge_token.size(),
      &session_id,
      &request_packet);
  secure_zero(challenge_id.data(), challenge_id.size());
  if (begin_status != 0) {
    return begin_status;
  }

  flatbuffers::FlatBufferBuilder request_builder(
      static_cast<flatbuffers::uoffset_t>(request_packet.size() + 128));
  const auto request_vector = request_builder.CreateVector(
      request_packet.data(), static_cast<flatbuffers::uoffset_t>(request_packet.size()));
  const auto request_root =
      orbpro::keybroker::CreateKeyBrokerRequest(request_builder, request_vector);
  orbpro::keybroker::FinishKeyBrokerRequestBuffer(request_builder, request_root);

  std::vector<uint8_t> broker_response_bytes;
  if (!protocol_request(
          target,
          kKeyBrokerProtocolId,
          request_builder.GetBufferPointer(),
          request_builder.GetSize(),
          &broker_response_bytes)) {
    destroy_client_session(session_id);
    secure_zero(request_packet.data(), request_packet.size());
    return kClientInternalError;
  }
  secure_zero(request_packet.data(), request_packet.size());

  flatbuffers::Verifier broker_verifier(
      broker_response_bytes.data(), broker_response_bytes.size());
  if (!orbpro::keybroker::VerifyKeyBrokerResponseBuffer(broker_verifier)) {
    destroy_client_session(session_id);
    return kClientMalformed;
  }
  const auto* broker_root =
      orbpro::keybroker::GetKeyBrokerResponse(broker_response_bytes.data());
  if (broker_root->status() != 0) {
    destroy_client_session(session_id);
    return static_cast<int32_t>(broker_root->status());
  }
  const auto* broker_packet = broker_root->packet();
  if (!broker_packet || broker_packet->size() == 0) {
    destroy_client_session(session_id);
    return kClientMalformed;
  }

  std::vector<uint8_t> session_result;
  const int32_t finish_status = finish_dek_session(
      session_id,
      broker_packet->data(),
      broker_packet->size(),
      static_cast<uint32_t>(challenge_key_version_value),
      &session_result);
  if (finish_status != 0 || session_result.size() != kResponseResultBytes) {
    secure_zero(session_result.data(), session_result.size());
    return finish_status != 0 ? finish_status : kClientMalformed;
  }

  const uint32_t served_key_version = read_u32_le(session_result.data());
  const uint64_t expires_at_ms = read_u64_le(session_result.data() + 4);
  const std::string dek_base64 = encode_base64_bytes(session_result.data() + 12, 32);
  const std::string response_json =
      "{\"keyVersion\":" + std::to_string(served_key_version) +
      ",\"expiresAtMs\":" + std::to_string(expires_at_ms) +
      ",\"dekBase64\":\"" + dek_base64 + "\"}";
  response_out.assign(response_json.begin(), response_json.end());
  secure_zero(session_result.data(), session_result.size());
  return 0;
}

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

int32_t license_client_verify(
    const uint8_t* signed_content,
    uint32_t signed_content_len,
    const uint8_t* public_key,
    uint32_t public_key_len,
    std::vector<uint8_t>& result_json_out) {
  bool valid = false;
  const uint8_t* content_ptr = nullptr;
  size_t content_len = 0;
  if (!verify_signed_payload(
          signed_content,
          signed_content_len,
          public_key,
          public_key_len,
          &valid,
          &content_ptr,
          &content_len)) {
    return kClientMalformed;
  }
  const std::string result_json =
      std::string("{\"valid\":") + (valid ? "true" : "false") +
      ",\"contentLength\":" + std::to_string(content_len) + "}";
  result_json_out.assign(result_json.begin(), result_json.end());
  return 0;
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
