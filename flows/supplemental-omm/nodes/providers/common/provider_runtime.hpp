#include "space_data_module_invoke.h"

#include <algorithm>
#include <cctype>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

#include <flatbuffers/flatbuffers.h>

extern "C" {

__attribute__((import_module("space_data_module_host"), import_name("call")))
int32_t sdm_host_call(const char* operation_ptr, int32_t operation_len,
                      const char* payload_ptr, int32_t payload_len);
__attribute__((import_module("space_data_module_host"), import_name("response_len")))
int32_t sdm_host_response_len(void);
__attribute__((import_module("space_data_module_host"), import_name("read_response")))
int32_t sdm_host_read_response(char* dst_ptr, int32_t dst_len);
__attribute__((import_module("space_data_module_host"), import_name("clear_response")))
int32_t sdm_host_clear_response(void);
__attribute__((import_module("space_data_module_host"), import_name("last_status_code")))
int32_t sdm_host_last_status_code(void);

}  // extern "C"

namespace provider_node {

constexpr const char* kFsbSchemaName = "FSB.fbs";
constexpr const char* kFsbFileIdentifier = "$FSB";
constexpr const char* kFsbRootType = "FSB";
constexpr uint32_t kFsbAlignedSize = 1'048'744;
constexpr uint32_t kFsbDataCapacity = 1'048'576;
constexpr uint16_t kFsbAlignment = 8;
constexpr uint32_t kOutputChunkBytes = kFsbDataCapacity;
constexpr uint32_t kMaxOutputFramesPerInvocation = 64;
constexpr uint32_t kMaxResponseBytes =
    kMaxOutputFramesPerInvocation * kOutputChunkBytes;

struct HttpResult {
  int64_t status = 0;
  std::vector<uint8_t> body;
};

struct FetchUnit {
  std::string url;
  HttpResult response;
};

uint64_t g_next_request_id = 0;
bool g_aligned_output_requested = false;
alignas(8) Aligned::FSB g_aligned_output{};

void append_u32le(std::vector<uint8_t>* output, uint32_t value) {
  output->push_back(static_cast<uint8_t>(value));
  output->push_back(static_cast<uint8_t>(value >> 8));
  output->push_back(static_cast<uint8_t>(value >> 16));
  output->push_back(static_cast<uint8_t>(value >> 24));
}

uint32_t read_u32le(const uint8_t* value) {
  return static_cast<uint32_t>(value[0]) |
         (static_cast<uint32_t>(value[1]) << 8) |
         (static_cast<uint32_t>(value[2]) << 16) |
         (static_cast<uint32_t>(value[3]) << 24);
}

std::string json_escape(std::string_view value) {
  std::string output;
  output.reserve(value.size() + 16);
  for (const unsigned char c : value) {
    switch (c) {
      case '"': output += "\\\""; break;
      case '\\': output += "\\\\"; break;
      case '\b': output += "\\b"; break;
      case '\f': output += "\\f"; break;
      case '\n': output += "\\n"; break;
      case '\r': output += "\\r"; break;
      case '\t': output += "\\t"; break;
      default:
        if (c >= 0x20) output.push_back(static_cast<char>(c));
        break;
    }
  }
  return output;
}

size_t skip_ws(std::string_view json, size_t cursor) {
  while (cursor < json.size() &&
         (json[cursor] == ' ' || json[cursor] == '\t' ||
          json[cursor] == '\r' || json[cursor] == '\n')) {
    ++cursor;
  }
  return cursor;
}

size_t json_value_position(std::string_view json, std::string_view key) {
  const std::string marker = "\"" + std::string(key) + "\"";
  const size_t key_position = json.find(marker);
  if (key_position == std::string_view::npos) return key_position;
  const size_t colon = json.find(':', key_position + marker.size());
  if (colon == std::string_view::npos) return colon;
  return skip_ws(json, colon + 1);
}

bool json_int64(std::string_view json, std::string_view key, int64_t* output) {
  size_t cursor = json_value_position(json, key);
  if (cursor == std::string_view::npos || !output) return false;
  bool negative = false;
  if (cursor < json.size() && json[cursor] == '-') {
    negative = true;
    ++cursor;
  }
  if (cursor >= json.size() || !std::isdigit(static_cast<unsigned char>(json[cursor]))) {
    return false;
  }
  int64_t value = 0;
  while (cursor < json.size() &&
         std::isdigit(static_cast<unsigned char>(json[cursor]))) {
    value = value * 10 + static_cast<int64_t>(json[cursor] - '0');
    ++cursor;
  }
  *output = negative ? -value : value;
  return true;
}

bool json_string(std::string_view json, std::string_view key, std::string* output) {
  size_t cursor = json_value_position(json, key);
  if (cursor == std::string_view::npos || !output || cursor >= json.size() ||
      json[cursor] != '"') {
    return false;
  }
  ++cursor;
  std::string value;
  while (cursor < json.size()) {
    const char c = json[cursor++];
    if (c == '"') {
      *output = std::move(value);
      return true;
    }
    if (c != '\\' || cursor >= json.size()) {
      value.push_back(c);
      continue;
    }
    const char escaped = json[cursor++];
    switch (escaped) {
      case 'b': value.push_back('\b'); break;
      case 'f': value.push_back('\f'); break;
      case 'n': value.push_back('\n'); break;
      case 'r': value.push_back('\r'); break;
      case 't': value.push_back('\t'); break;
      case '"': value.push_back('"'); break;
      case '\\': value.push_back('\\'); break;
      case '/': value.push_back('/'); break;
      case 'u': {
        if (cursor + 4 > json.size()) return false;
        uint32_t codepoint = 0;
        for (int index = 0; index < 4; ++index) {
          const char digit = json[cursor++];
          codepoint <<= 4;
          if (digit >= '0' && digit <= '9') codepoint |= digit - '0';
          else if (digit >= 'a' && digit <= 'f') codepoint |= digit - 'a' + 10;
          else if (digit >= 'A' && digit <= 'F') codepoint |= digit - 'A' + 10;
          else return false;
        }
        if (codepoint <= 0x7f) value.push_back(static_cast<char>(codepoint));
        else if (codepoint <= 0x7ff) {
          value.push_back(static_cast<char>(0xc0 | (codepoint >> 6)));
          value.push_back(static_cast<char>(0x80 | (codepoint & 0x3f)));
        } else {
          value.push_back(static_cast<char>(0xe0 | (codepoint >> 12)));
          value.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3f)));
          value.push_back(static_cast<char>(0x80 | (codepoint & 0x3f)));
        }
        break;
      }
      default: return false;
    }
  }
  return false;
}

std::vector<uint8_t> base64_decode(std::string_view input) {
  int8_t table[256];
  std::memset(table, -1, sizeof(table));
  constexpr char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (int index = 0; index < 64; ++index) {
    table[static_cast<uint8_t>(alphabet[index])] = static_cast<int8_t>(index);
  }
  std::vector<uint8_t> output;
  int value = 0;
  int bits = -8;
  for (const unsigned char c : input) {
    if (c == '=') break;
    if (table[c] < 0) continue;
    value = (value << 6) | table[c];
    bits += 6;
    if (bits >= 0) {
      output.push_back(static_cast<uint8_t>((value >> bits) & 0xff));
      bits -= 8;
    }
  }
  return output;
}

bool parse_envelope(const std::vector<uint8_t>& envelope, std::string* meta,
                    std::vector<std::vector<uint8_t>>* segments) {
  if (!meta || !segments || envelope.size() < 8) return false;
  size_t cursor = 0;
  const uint32_t meta_length = read_u32le(envelope.data());
  cursor += 4;
  if (meta_length > envelope.size() - cursor - 4) return false;
  meta->assign(reinterpret_cast<const char*>(envelope.data() + cursor), meta_length);
  cursor += meta_length;
  const uint32_t segment_count = read_u32le(envelope.data() + cursor);
  cursor += 4;
  segments->clear();
  segments->reserve(segment_count);
  for (uint32_t index = 0; index < segment_count; ++index) {
    if (cursor + 4 > envelope.size()) return false;
    const uint32_t length = read_u32le(envelope.data() + cursor);
    cursor += 4;
    if (length > envelope.size() - cursor) return false;
    segments->emplace_back(
        envelope.begin() + static_cast<std::ptrdiff_t>(cursor),
        envelope.begin() + static_cast<std::ptrdiff_t>(cursor + length));
    cursor += length;
  }
  return cursor == envelope.size();
}

bool binary_field_index(std::string_view meta, std::string_view key,
                        size_t* output) {
  size_t cursor = json_value_position(meta, key);
  if (cursor == std::string_view::npos || !output || cursor >= meta.size() ||
      meta[cursor] != '{') {
    return false;
  }
  const size_t bin = meta.find("\"$bin\"", cursor + 1);
  if (bin == std::string_view::npos) return false;
  cursor = meta.find(':', bin + 6);
  if (cursor == std::string_view::npos) return false;
  cursor = skip_ws(meta, cursor + 1);
  if (cursor >= meta.size() || !std::isdigit(static_cast<unsigned char>(meta[cursor]))) {
    return false;
  }
  size_t value = 0;
  while (cursor < meta.size() &&
         std::isdigit(static_cast<unsigned char>(meta[cursor]))) {
    value = value * 10 + static_cast<size_t>(meta[cursor] - '0');
    ++cursor;
  }
  *output = value;
  return true;
}

HttpResult http_get(std::string_view url) {
  HttpResult result;
  const std::string params =
      "{\"method\":\"GET\",\"url\":\"" + json_escape(url) +
      "\",\"responseType\":\"bytes\",\"max_bytes\":" +
      std::to_string(kMaxResponseBytes) + "}";
  std::vector<uint8_t> request;
  request.reserve(params.size() + 8);
  append_u32le(&request, static_cast<uint32_t>(params.size()));
  request.insert(request.end(), params.begin(), params.end());
  append_u32le(&request, 0);

  sdm_host_clear_response();
  constexpr std::string_view operation = "http.request";
  const int32_t call_result = sdm_host_call(
      operation.data(), static_cast<int32_t>(operation.size()),
      reinterpret_cast<const char*>(request.data()),
      static_cast<int32_t>(request.size()));
  const int32_t status_code = sdm_host_last_status_code();
  const int32_t response_length = sdm_host_response_len();
  if (call_result != 0 || status_code != 0 || response_length < 8) {
    sdm_host_clear_response();
    return result;
  }
  std::vector<uint8_t> response(static_cast<size_t>(response_length));
  const int32_t copied = sdm_host_read_response(
      reinterpret_cast<char*>(response.data()), response_length);
  sdm_host_clear_response();
  if (copied != response_length) return result;

  std::string meta;
  std::vector<std::vector<uint8_t>> segments;
  if (!parse_envelope(response, &meta, &segments) ||
      meta.find("\"ok\":true") == std::string::npos ||
      !json_int64(meta, "status", &result.status)) {
    result.status = 0;
    return result;
  }
  size_t segment_index = 0;
  if (binary_field_index(meta, "body", &segment_index)) {
    if (segment_index < segments.size()) result.body = std::move(segments[segment_index]);
    return result;
  }
  std::string body;
  if (!json_string(meta, "body", &body)) return result;
  std::string encoding;
  json_string(meta, "body_encoding", &encoding);
  if (encoding == "base64") result.body = base64_decode(body);
  else result.body.assign(body.begin(), body.end());
  return result;
}

bool read_config_bytes(std::vector<uint8_t>* output) {
  if (!output) return false;
  // Canonical FSB is the durable/inter-runtime fallback. An aligned config
  // frame proves that this invocation is on a compatible same-arena route.
  g_aligned_output_requested = false;
  output->clear();
  const int32_t input_index = plugin_find_input_index("config", 0);
  if (input_index < 0) return true;
  const plugin_input_frame_t* frame =
      plugin_get_input_frame(static_cast<uint32_t>(input_index));
  if (!frame || !frame->payload || !frame->file_identifier ||
      std::strcmp(frame->file_identifier, kFsbFileIdentifier) != 0) {
    return false;
  }
  if (frame->wire_format == PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER) {
    flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!VerifyFSBBuffer(verifier)) return false;
    const FSB* fsb = GetFSB(frame->payload);
    if (!fsb || !fsb->DATA()) return true;
    output->assign(fsb->DATA()->begin(), fsb->DATA()->end());
    return true;
  }
  if (frame->wire_format != PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY ||
      frame->payload_length != kFsbAlignedSize ||
      frame->byte_length != kFsbAlignedSize ||
      frame->required_alignment != kFsbAlignment ||
      reinterpret_cast<uintptr_t>(frame->payload) % kFsbAlignment != 0) {
    return false;
  }
  const auto* fsb = reinterpret_cast<const Aligned::FSB*>(frame->payload);
  if (!fsb->has_DATA() || fsb->DATA.length > kFsbDataCapacity) return false;
  g_aligned_output_requested = true;
  output->assign(fsb->DATA.values, fsb->DATA.values + fsb->DATA.length);
  return true;
}

bool read_config_json(std::string* output) {
  if (!output) return false;
  std::vector<uint8_t> bytes;
  if (!read_config_bytes(&bytes)) return false;
  const auto first = std::find_if(bytes.begin(), bytes.end(), [](uint8_t value) {
    return value != ' ' && value != '\t' && value != '\r' && value != '\n';
  });
  if (first == bytes.end() || *first != '{') {
    output->clear();
    return true;
  }
  output->assign(bytes.begin(), bytes.end());
  return true;
}

void sha256(const uint8_t* data, size_t length, uint8_t output[32]) {
  static constexpr uint32_t constants[64] = {
      0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
      0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
      0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
      0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
      0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
      0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
      0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
      0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u};
  uint32_t hash[8] = {0x6a09e667u,0xbb67ae85u,0x3c6ef372u,0xa54ff53au,
                      0x510e527fu,0x9b05688cu,0x1f83d9abu,0x5be0cd19u};
  std::vector<uint8_t> message(data, data + length);
  const uint64_t bit_length = static_cast<uint64_t>(length) * 8;
  message.push_back(0x80);
  while (message.size() % 64 != 56) message.push_back(0);
  for (int index = 7; index >= 0; --index) {
    message.push_back(static_cast<uint8_t>(bit_length >> (index * 8)));
  }
  const auto rotate = [](uint32_t value, uint32_t amount) {
    return (value >> amount) | (value << (32 - amount));
  };
  for (size_t offset = 0; offset < message.size(); offset += 64) {
    uint32_t words[64];
    for (int index = 0; index < 16; ++index) {
      words[index] =
          (static_cast<uint32_t>(message[offset + index * 4]) << 24) |
          (static_cast<uint32_t>(message[offset + index * 4 + 1]) << 16) |
          (static_cast<uint32_t>(message[offset + index * 4 + 2]) << 8) |
          static_cast<uint32_t>(message[offset + index * 4 + 3]);
    }
    for (int index = 16; index < 64; ++index) {
      const uint32_t s0 = rotate(words[index - 15], 7) ^
                          rotate(words[index - 15], 18) ^
                          (words[index - 15] >> 3);
      const uint32_t s1 = rotate(words[index - 2], 17) ^
                          rotate(words[index - 2], 19) ^
                          (words[index - 2] >> 10);
      words[index] = words[index - 16] + s0 + words[index - 7] + s1;
    }
    uint32_t a = hash[0], b = hash[1], c = hash[2], d = hash[3];
    uint32_t e = hash[4], f = hash[5], g = hash[6], h = hash[7];
    for (int index = 0; index < 64; ++index) {
      const uint32_t upper = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const uint32_t choose = (e & f) ^ (~e & g);
      const uint32_t first = h + upper + choose + constants[index] + words[index];
      const uint32_t lower = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
      const uint32_t second = lower + majority;
      h = g; g = f; f = e; e = d + first; d = c; c = b; b = a; a = first + second;
    }
    hash[0] += a; hash[1] += b; hash[2] += c; hash[3] += d;
    hash[4] += e; hash[5] += f; hash[6] += g; hash[7] += h;
  }
  for (int index = 0; index < 8; ++index) {
    output[index * 4] = static_cast<uint8_t>(hash[index] >> 24);
    output[index * 4 + 1] = static_cast<uint8_t>(hash[index] >> 16);
    output[index * 4 + 2] = static_cast<uint8_t>(hash[index] >> 8);
    output[index * 4 + 3] = static_cast<uint8_t>(hash[index]);
  }
}

using RecordCounter = uint64_t (*)(const std::vector<uint8_t>&);

uint64_t count_records_isomorphic(const std::vector<uint8_t>& bytes,
                                  RecordCounter counter) {
  if (!counter) return 0;
  return counter(bytes);
}

int emit_complete_response(const std::vector<uint8_t>& bytes,
                           std::string_view native_schema,
                           std::string_view native_identifier,
                           RecordCounter count_records) {
  if (bytes.empty()) return -1;
  if (g_aligned_output_requested &&
      (native_schema.size() > 64 || native_identifier.size() > 4)) {
    return -1;
  }
  uint8_t digest[32];
  sha256(bytes.data(), bytes.size(), digest);
  const uint64_t request_id = ++g_next_request_id;
  const uint64_t records = count_records_isomorphic(bytes, count_records);
  uint32_t sequence = 0;
  const size_t chunk_bytes =
      g_aligned_output_requested ? kFsbDataCapacity : kOutputChunkBytes;
  for (size_t offset = 0; offset < bytes.size(); offset += chunk_bytes) {
    const size_t length = std::min(chunk_bytes, bytes.size() - offset);
    const bool final = offset + length == bytes.size();
    int32_t pushed = -1;
    if (g_aligned_output_requested) {
      std::memset(&g_aligned_output, 0, sizeof(g_aligned_output));
      g_aligned_output.REQUEST_ID = request_id;
      g_aligned_output.KIND = flatSqlByteStreamKind_RECORD_STREAM;
      g_aligned_output.CHUNK_SEQUENCE = sequence;
      g_aligned_output.FINAL = final;
      g_aligned_output.TOTAL_BYTES = bytes.size();
      g_aligned_output.RECORD_COUNT = final ? records : 0;
      g_aligned_output.SCHEMA_NAME.set(std::string(native_schema));
      g_aligned_output.set_has_SCHEMA_NAME(true);
      g_aligned_output.FILE_IDENTIFIER.set(std::string(native_identifier));
      g_aligned_output.set_has_FILE_IDENTIFIER(true);
      g_aligned_output.DATA.set_length(static_cast<uint32_t>(length));
      std::memcpy(g_aligned_output.DATA.values, bytes.data() + offset, length);
      g_aligned_output.set_has_DATA(true);
      g_aligned_output.SHA256.set_length(sizeof(digest));
      std::memcpy(g_aligned_output.SHA256.values, digest, sizeof(digest));
      g_aligned_output.set_has_SHA256(true);
      pushed = plugin_push_output_typed(
          "oem", kFsbSchemaName, kFsbFileIdentifier,
          PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, kFsbRootType, 0,
          kFsbAlignedSize, kFsbAlignment,
          reinterpret_cast<const uint8_t*>(&g_aligned_output), kFsbAlignedSize);
    } else {
      flatbuffers::FlatBufferBuilder builder(length + 512);
      const auto schema_name =
          builder.CreateString(native_schema.data(), native_schema.size());
      const auto file_identifier =
          builder.CreateString(native_identifier.data(), native_identifier.size());
      const auto data = builder.CreateVector(bytes.data() + offset, length);
      const auto hash = builder.CreateVector(digest, sizeof(digest));
      FSBBuilder stream(builder);
      stream.add_REQUEST_ID(request_id);
      stream.add_KIND(flatSqlByteStreamKind_RECORD_STREAM);
      stream.add_CHUNK_SEQUENCE(sequence);
      stream.add_FINAL(final);
      stream.add_TOTAL_BYTES(bytes.size());
      stream.add_RECORD_COUNT(final ? records : 0);
      stream.add_SCHEMA_NAME(schema_name);
      stream.add_FILE_IDENTIFIER(file_identifier);
      stream.add_DATA(data);
      stream.add_SHA256(hash);
      const auto root = stream.Finish();
      FinishFSBBuffer(builder, root);
      pushed = plugin_push_output_typed(
          "oem", kFsbSchemaName, kFsbFileIdentifier,
          PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, kFsbRootType, 0, 0, 0,
          builder.GetBufferPointer(), static_cast<uint32_t>(builder.GetSize()));
    }
    if (pushed < 0) return pushed;
    ++sequence;
  }
  return static_cast<int>(sequence);
}

uint32_t output_frame_count(size_t byte_length) {
  if (byte_length == 0) return 0;
  return static_cast<uint32_t>(
      (byte_length + kOutputChunkBytes - 1) / kOutputChunkBytes);
}

bool validate_fetches(const std::vector<FetchUnit>& units) {
  return !units.empty() &&
         std::all_of(units.begin(), units.end(), [](const FetchUnit& unit) {
           return unit.response.status == 200 && !unit.response.body.empty();
         });
}

std::string join_url(std::string_view base, std::string_view child) {
  if (!base.empty() && base.back() == '/') return std::string(base) + std::string(child);
  return std::string(base) + "/" + std::string(child);
}

std::vector<std::string_view> lines(const std::vector<uint8_t>& bytes) {
  const std::string_view text(reinterpret_cast<const char*>(bytes.data()), bytes.size());
  std::vector<std::string_view> output;
  size_t cursor = 0;
  while (cursor <= text.size()) {
    const size_t newline = text.find('\n', cursor);
    size_t end = newline == std::string_view::npos ? text.size() : newline;
    if (end > cursor && text[end - 1] == '\r') --end;
    output.emplace_back(text.data() + cursor, end - cursor);
    if (newline == std::string_view::npos) break;
    cursor = newline + 1;
  }
  return output;
}

bool filename_delimiter(char value) {
  return value == ' ' || value == '\t' || value == '\r' || value == '\n' ||
         value == '"' || value == '\'' || value == '<' || value == '>' ||
         value == '=' || value == '/';
}

std::string select_newest_filename(const std::vector<uint8_t>& listing,
                                   std::string_view required,
                                   std::string_view second_required = {}) {
  const std::string text(listing.begin(), listing.end());
  std::string newest;
  size_t cursor = 0;
  while (true) {
    const size_t match = text.find(required, cursor);
    if (match == std::string::npos) break;
    size_t begin = match;
    while (begin > 0 && !filename_delimiter(text[begin - 1])) --begin;
    size_t end = match + required.size();
    while (end < text.size() && !filename_delimiter(text[end])) ++end;
    const std::string candidate = text.substr(begin, end - begin);
    if ((second_required.empty() || candidate.find(second_required) != std::string::npos) &&
        candidate > newest) {
      newest = candidate;
    }
    cursor = match + required.size();
  }
  return newest;
}

}  // namespace provider_node
