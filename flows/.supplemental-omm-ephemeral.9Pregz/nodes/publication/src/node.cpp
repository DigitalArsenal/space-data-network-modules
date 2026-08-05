#include "space_data_module_invoke.h"

#include <cstdint>
#include <cstring>
#include <limits>
#include <map>
#include <string>
#include <string_view>
#include <utility>
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

namespace {

constexpr const char* kFsbSchemaName = "FSB.fbs";
constexpr const char* kFsbFileIdentifier = "$FSB";
constexpr const char* kFsbRootType = "FSB";
constexpr uint32_t kFsbAlignedSize = 1'048'744;
constexpr uint16_t kFsbAlignment = 8;
constexpr size_t kFsbDataCapacity = 1'048'576;
constexpr size_t kMaxCanonicalFsbBytes = kFsbDataCapacity + 4'096;
constexpr uint64_t kMaxPublicationStreamBytes = 128u * 1024u * 1024u;
constexpr uint64_t kMaxPublicationRecords = 100'000;
constexpr size_t kMaxPendingPublicationStreams = 4'096;
constexpr uint64_t kMaxPendingPublicationBytes = 320u * 1024u * 1024u;
constexpr std::string_view kPublicationSource = "supplemental-omm";

struct PublicationReceipt {
  uint32_t wire_format = PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER;
  std::vector<uint8_t> bytes;
};

struct PublicationChunk {
  uint64_t request_id = 0;
  flatSqlByteStreamKind kind = flatSqlByteStreamKind_UNSPECIFIED;
  uint32_t sequence = 0;
  bool final = false;
  uint64_t total_bytes = 0;
  uint64_t record_count = 0;
  uint32_t wire_format = PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER;
  std::string schema_name;
  std::string file_identifier;
  std::string standard;
  std::vector<uint8_t> data;
  bool has_sha256 = false;
  std::vector<uint8_t> sha256;
  PublicationReceipt receipt;
};

struct PublicationStream {
  uint64_t total_bytes = 0;
  uint64_t record_count = 0;
  uint64_t next_sequence = 0;
  uint32_t wire_format = PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER;
  std::string schema_name;
  std::string file_identifier;
  std::string standard;
  bool has_sha256 = false;
  std::vector<uint8_t> sha256;
  std::vector<uint8_t> data;
  std::vector<PublicationReceipt> receipts;
  uint64_t retained_bytes = 0;
};

std::map<uint64_t, PublicationStream> g_streams;
uint64_t g_pending_stream_bytes = 0;

void release_pending_bytes(uint64_t released) {
  g_pending_stream_bytes =
      released > g_pending_stream_bytes ? 0 : g_pending_stream_bytes - released;
}

void erase_pending_stream(
    std::map<uint64_t, PublicationStream>::iterator stream) {
  if (stream == g_streams.end()) return;
  release_pending_bytes(stream->second.retained_bytes);
  g_streams.erase(stream);
}

bool reserve_pending_bytes(uint64_t required, uint64_t protected_request_id) {
  while (g_pending_stream_bytes > kMaxPendingPublicationBytes ||
         required > kMaxPendingPublicationBytes - g_pending_stream_bytes) {
    auto victim = g_streams.begin();
    if (victim != g_streams.end() &&
        victim->first == protected_request_id) {
      ++victim;
    }
    if (victim == g_streams.end()) return false;
    erase_pending_stream(victim);
  }
  return true;
}

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

void sha256_compress(const uint8_t block[64], uint32_t state[8]) {
  static const uint32_t constants[64] = {
      0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u,
      0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
      0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
      0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
      0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
      0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
      0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u,
      0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
      0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
      0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
      0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u,
      0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
      0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u,
      0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
      0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
      0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u};
  const auto rotate_right = [](uint32_t value, uint32_t amount) {
    return (value >> amount) | (value << (32 - amount));
  };
  uint32_t words[64];
  for (int index = 0; index < 16; ++index) {
    words[index] = (static_cast<uint32_t>(block[index * 4]) << 24) |
                   (static_cast<uint32_t>(block[index * 4 + 1]) << 16) |
                   (static_cast<uint32_t>(block[index * 4 + 2]) << 8) |
                   static_cast<uint32_t>(block[index * 4 + 3]);
  }
  for (int index = 16; index < 64; ++index) {
    const uint32_t sigma0 = rotate_right(words[index - 15], 7) ^
                            rotate_right(words[index - 15], 18) ^
                            (words[index - 15] >> 3);
    const uint32_t sigma1 = rotate_right(words[index - 2], 17) ^
                            rotate_right(words[index - 2], 19) ^
                            (words[index - 2] >> 10);
    words[index] = words[index - 16] + sigma0 + words[index - 7] + sigma1;
  }
  uint32_t a = state[0];
  uint32_t b = state[1];
  uint32_t c = state[2];
  uint32_t d = state[3];
  uint32_t e = state[4];
  uint32_t f = state[5];
  uint32_t g = state[6];
  uint32_t h = state[7];
  for (int index = 0; index < 64; ++index) {
    const uint32_t sum1 =
        rotate_right(e, 6) ^ rotate_right(e, 11) ^ rotate_right(e, 25);
    const uint32_t choose = (e & f) ^ (~e & g);
    const uint32_t temp1 =
        h + sum1 + choose + constants[index] + words[index];
    const uint32_t sum0 =
        rotate_right(a, 2) ^ rotate_right(a, 13) ^ rotate_right(a, 22);
    const uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
    const uint32_t temp2 = sum0 + majority;
    h = g;
    g = f;
    f = e;
    e = d + temp1;
    d = c;
    c = b;
    b = a;
    a = temp1 + temp2;
  }
  state[0] += a;
  state[1] += b;
  state[2] += c;
  state[3] += d;
  state[4] += e;
  state[5] += f;
  state[6] += g;
  state[7] += h;
}

void sha256_raw(const uint8_t* data, size_t length, uint8_t output[32]) {
  uint32_t state[8] = {0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u,
                       0xa54ff53au, 0x510e527fu, 0x9b05688cu,
                       0x1f83d9abu, 0x5be0cd19u};
  size_t offset = 0;
  while (length - offset >= 64) {
    sha256_compress(data + offset, state);
    offset += 64;
  }
  uint8_t final_blocks[128] = {};
  const size_t remainder = length - offset;
  if (remainder > 0) std::memcpy(final_blocks, data + offset, remainder);
  final_blocks[remainder] = 0x80;
  const size_t final_size = remainder < 56 ? 64 : 128;
  const uint64_t bit_length = static_cast<uint64_t>(length) * 8u;
  for (int index = 0; index < 8; ++index) {
    final_blocks[final_size - 1 - index] =
        static_cast<uint8_t>(bit_length >> (index * 8));
  }
  sha256_compress(final_blocks, state);
  if (final_size == 128) sha256_compress(final_blocks + 64, state);
  for (int index = 0; index < 8; ++index) {
    output[index * 4] = static_cast<uint8_t>(state[index] >> 24);
    output[index * 4 + 1] = static_cast<uint8_t>(state[index] >> 16);
    output[index * 4 + 2] = static_cast<uint8_t>(state[index] >> 8);
    output[index * 4 + 3] = static_cast<uint8_t>(state[index]);
  }
}

bool response_ok(const std::vector<uint8_t>& response) {
  if (response.size() < 8) return false;
  const uint32_t meta_length = read_u32le(response.data());
  if (meta_length > response.size() - 8) return false;
  const std::string_view meta(
      reinterpret_cast<const char*>(response.data() + 4), meta_length);
  return meta.find("\"ok\":true") != std::string_view::npos;
}

std::vector<uint8_t> publication_request(std::string_view standard,
                                         const uint8_t* payload,
                                         uint32_t payload_length) {
  std::string meta = "{\"source\":\"";
  meta.append(kPublicationSource);
  meta.append("\",\"standard\":\"");
  meta.append(standard);
  meta.append("\",\"data\":{\"$bin\":0}}");
  std::vector<uint8_t> request;
  request.reserve(12 + meta.size() + payload_length);
  append_u32le(&request, static_cast<uint32_t>(meta.size()));
  request.insert(request.end(), meta.begin(), meta.end());
  append_u32le(&request, 1);
  append_u32le(&request, payload_length);
  request.insert(request.end(), payload, payload + payload_length);
  return request;
}

bool publish(std::string_view standard, const uint8_t* payload,
             uint32_t payload_length) {
  sdm_host_clear_response();
  const std::vector<uint8_t> request =
      publication_request(standard, payload, payload_length);
  if (request.size() >
      static_cast<size_t>(std::numeric_limits<int32_t>::max())) {
    return false;
  }
  constexpr std::string_view operation = "pubsub.publish";
  const int32_t call_result = sdm_host_call(
      operation.data(), static_cast<int32_t>(operation.size()),
      reinterpret_cast<const char*>(request.data()),
      static_cast<int32_t>(request.size()));
  const int32_t status = sdm_host_last_status_code();
  const int32_t response_length = sdm_host_response_len();
  if (response_length < 8) {
    sdm_host_clear_response();
    return false;
  }
  std::vector<uint8_t> response(static_cast<size_t>(response_length));
  const int32_t copied = sdm_host_read_response(
      reinterpret_cast<char*>(response.data()), response_length);
  sdm_host_clear_response();
  return call_result == 0 && status == 0 && copied == response_length &&
         response_ok(response);
}

bool set_record_identity(std::string_view schema_name,
                         std::string_view file_identifier,
                         std::string* standard) {
  if (!standard || file_identifier.size() != 4 ||
      file_identifier[0] != '$') {
    return false;
  }
  for (size_t index = 1; index < file_identifier.size(); ++index) {
    if (file_identifier[index] < 'A' || file_identifier[index] > 'Z') {
      return false;
    }
  }
  const std::string decoded(file_identifier.substr(1));
  if (schema_name != decoded) return false;
  *standard = decoded;
  return true;
}

bool validate_publication_chunk(PublicationChunk* chunk, std::string* error) {
  if (chunk->kind != flatSqlByteStreamKind_RECORD_STREAM) {
    *error = "publication requires an FSB RECORD_STREAM";
    return false;
  }
  if (chunk->total_bytes == 0 || chunk->record_count == 0 ||
      chunk->data.empty()) {
    *error = "publication requires non-empty stream data and RECORD_COUNT";
    return false;
  }
  if (chunk->data.size() > kFsbDataCapacity) {
    *error = "publication FSB chunk exceeds its bounded DATA capacity";
    return false;
  }
  if (chunk->total_bytes > kMaxPublicationStreamBytes ||
      chunk->total_bytes > std::numeric_limits<size_t>::max()) {
    *error = "publication stream exceeds the bounded guest address space";
    return false;
  }
  if (chunk->record_count > kMaxPublicationRecords) {
    *error = "publication stream exceeds the bounded record count";
    return false;
  }
  if (chunk->has_sha256 && chunk->sha256.size() != 32) {
    *error = "publication SHA256 must be absent or exactly 32 bytes";
    return false;
  }
  const bool legacy_single_record =
      chunk->record_count == 1 && chunk->sequence == 0 && chunk->final &&
      chunk->total_bytes == chunk->data.size();
  if (!legacy_single_record && !chunk->has_sha256) {
    *error = "publication aggregated streams require SHA256";
    return false;
  }
  if (!set_record_identity(chunk->schema_name, chunk->file_identifier,
                           &chunk->standard)) {
    *error = "publication stream has an invalid SDS schema identity";
    return false;
  }
  return true;
}

bool decode_publication_chunk(const plugin_input_frame_t* frame,
                              PublicationChunk* chunk, std::string* error) {
  if (!frame || !chunk || !error || !frame->payload ||
      frame->payload_length == 0 ||
      !frame->schema_name ||
      std::strcmp(frame->schema_name, kFsbSchemaName) != 0 ||
      !frame->file_identifier ||
      std::strcmp(frame->file_identifier, kFsbFileIdentifier) != 0 ||
      !frame->root_type_name ||
      std::strcmp(frame->root_type_name, kFsbRootType) != 0) {
    if (error) *error = "publication requires a typed $FSB input frame";
    return false;
  }
  chunk->wire_format = frame->wire_format;
  if (frame->wire_format == PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER) {
    if (frame->payload_length > kMaxCanonicalFsbBytes) {
      *error = "publication canonical FSB frame exceeds its bounded size";
      return false;
    }
    flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!VerifyFSBBuffer(verifier)) {
      *error = "publication received an invalid canonical FSB chunk";
      return false;
    }
    const FSB* stream = GetFSB(frame->payload);
    if (!stream->SCHEMA_NAME() || !stream->FILE_IDENTIFIER() ||
        !stream->DATA()) {
      *error = "publication FSB chunk is missing typed stream metadata";
      return false;
    }
    if (stream->SCHEMA_NAME()->size() > 64 ||
        stream->FILE_IDENTIFIER()->size() > 4 ||
        stream->DATA()->size() > kFsbDataCapacity ||
        (stream->SHA256() && stream->SHA256()->size() != 32)) {
      *error = "publication canonical FSB vector length exceeds its bounds";
      return false;
    }
    chunk->request_id = stream->REQUEST_ID();
    chunk->kind = stream->KIND();
    chunk->sequence = stream->CHUNK_SEQUENCE();
    chunk->final = stream->FINAL();
    chunk->total_bytes = stream->TOTAL_BYTES();
    chunk->record_count = stream->RECORD_COUNT();
    chunk->schema_name = stream->SCHEMA_NAME()->str();
    chunk->file_identifier = stream->FILE_IDENTIFIER()->str();
    chunk->data.assign(stream->DATA()->begin(), stream->DATA()->end());
    if (stream->SHA256()) {
      chunk->has_sha256 = true;
      chunk->sha256.assign(stream->SHA256()->begin(), stream->SHA256()->end());
    }
  } else if (frame->wire_format ==
             PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY) {
    if (frame->payload_length != kFsbAlignedSize ||
        frame->byte_length != kFsbAlignedSize ||
        frame->required_alignment != kFsbAlignment ||
        reinterpret_cast<uintptr_t>(frame->payload) % kFsbAlignment != 0) {
      *error = "publication received invalid aligned FSB bounds or alignment";
      return false;
    }
    const auto* stream =
        reinterpret_cast<const Aligned::FSB*>(frame->payload);
    if (!stream->has_SCHEMA_NAME() || !stream->has_FILE_IDENTIFIER() ||
        !stream->has_DATA()) {
      *error = "publication aligned FSB chunk is missing typed metadata";
      return false;
    }
    if (stream->SCHEMA_NAME.length > sizeof(stream->SCHEMA_NAME.data) ||
        stream->FILE_IDENTIFIER.length >
            sizeof(stream->FILE_IDENTIFIER.data) ||
        stream->DATA.length > kFsbDataCapacity ||
        (stream->has_SHA256() && stream->SHA256.length != 32)) {
      *error = "publication aligned FSB vector length exceeds its bounds";
      return false;
    }
    chunk->request_id = stream->REQUEST_ID;
    chunk->kind = stream->KIND;
    chunk->sequence = stream->CHUNK_SEQUENCE;
    chunk->final = stream->FINAL;
    chunk->total_bytes = stream->TOTAL_BYTES;
    chunk->record_count = stream->RECORD_COUNT;
    chunk->schema_name = stream->SCHEMA_NAME.str();
    chunk->file_identifier = stream->FILE_IDENTIFIER.str();
    chunk->data.assign(stream->DATA.values,
                       stream->DATA.values + stream->DATA.size());
    if (stream->has_SHA256()) {
      chunk->has_sha256 = true;
      chunk->sha256.assign(stream->SHA256.values,
                           stream->SHA256.values + stream->SHA256.size());
    }
  } else {
    *error = "publication received an unsupported FSB wire format";
    return false;
  }
  chunk->receipt.wire_format = frame->wire_format;
  chunk->receipt.bytes.assign(frame->payload,
                              frame->payload + frame->payload_length);
  return validate_publication_chunk(chunk, error);
}

bool verify_stream_checksum(const PublicationStream& stream) {
  if (!stream.has_sha256) return true;
  uint8_t digest[32];
  sha256_raw(stream.data.data(), stream.data.size(), digest);
  return std::memcmp(digest, stream.sha256.data(), sizeof(digest)) == 0;
}

bool append_publication_chunk(PublicationChunk chunk,
                              PublicationStream* completed,
                              bool* is_complete, std::string* error) {
  *is_complete = false;
  auto found = g_streams.find(chunk.request_id);
  if (chunk.sequence == 0) {
    if (found != g_streams.end()) {
      erase_pending_stream(found);
      *error = "publication stream repeated sequence zero before completion";
      return false;
    }
    if (g_streams.size() >= kMaxPendingPublicationStreams) {
      erase_pending_stream(g_streams.begin());
    }
    PublicationStream stream;
    stream.total_bytes = chunk.total_bytes;
    stream.record_count = chunk.record_count;
    stream.wire_format = chunk.wire_format;
    stream.schema_name = chunk.schema_name;
    stream.file_identifier = chunk.file_identifier;
    stream.standard = chunk.standard;
    stream.has_sha256 = chunk.has_sha256;
    stream.sha256 = chunk.sha256;
    found = g_streams.emplace(chunk.request_id, std::move(stream)).first;
  }
  if (found == g_streams.end()) {
    *error = "publication stream arrived without sequence zero";
    return false;
  }

  PublicationStream& stream = found->second;
  if (static_cast<uint64_t>(chunk.sequence) != stream.next_sequence ||
      chunk.total_bytes != stream.total_bytes ||
      chunk.record_count != stream.record_count ||
      chunk.wire_format != stream.wire_format ||
      chunk.schema_name != stream.schema_name ||
      chunk.file_identifier != stream.file_identifier ||
      chunk.standard != stream.standard ||
      chunk.has_sha256 != stream.has_sha256 || chunk.sha256 != stream.sha256) {
    erase_pending_stream(found);
    *error = "publication stream chunk metadata or ordering mismatch";
    return false;
  }
  const size_t total_bytes = static_cast<size_t>(stream.total_bytes);
  if (stream.data.size() > total_bytes ||
      chunk.data.size() > total_bytes - stream.data.size()) {
    erase_pending_stream(found);
    *error = "publication stream chunks exceed TOTAL_BYTES";
    return false;
  }
  const uint64_t retained_bytes =
      static_cast<uint64_t>(chunk.data.size()) +
      static_cast<uint64_t>(chunk.receipt.bytes.size());
  if (!reserve_pending_bytes(retained_bytes, chunk.request_id)) {
    erase_pending_stream(found);
    *error = "publication stream alone exceeds the retained-byte limit";
    return false;
  }
  stream.data.insert(stream.data.end(), chunk.data.begin(), chunk.data.end());
  stream.receipts.push_back(std::move(chunk.receipt));
  stream.retained_bytes += retained_bytes;
  g_pending_stream_bytes += retained_bytes;
  ++stream.next_sequence;

  if (!chunk.final) {
    if (stream.data.size() == total_bytes ||
        chunk.sequence == std::numeric_limits<uint32_t>::max()) {
      erase_pending_stream(found);
      *error = "publication stream reached its bound without FINAL";
      return false;
    }
    return true;
  }
  if (stream.data.size() != total_bytes || !verify_stream_checksum(stream)) {
    erase_pending_stream(found);
    *error = "publication final length or SHA256 mismatch";
    return false;
  }
  const uint64_t completed_retained_bytes = stream.retained_bytes;
  *completed = std::move(stream);
  release_pending_bytes(completed_retained_bytes);
  g_streams.erase(found);
  *is_complete = true;
  return true;
}

bool validate_publication_records(const PublicationStream& stream,
                                  std::string* error) {
  if (stream.record_count == 1 && !stream.has_sha256) return true;
  if (stream.record_count > stream.data.size() / 5) {
    *error = "publication RECORD_COUNT exceeds the bounded record stream";
    return false;
  }
  size_t offset = 0;
  uint64_t record_index = 0;
  while (record_index < stream.record_count) {
    if (stream.data.size() - offset < sizeof(uint32_t)) {
      *error = "publication record stream ended before its size prefix";
      return false;
    }
    const uint32_t payload_length = read_u32le(stream.data.data() + offset);
    if (payload_length == 0 ||
        static_cast<size_t>(payload_length) >
            stream.data.size() - offset - sizeof(uint32_t)) {
      *error = "publication record stream has an invalid size prefix";
      return false;
    }
    const size_t record_length = sizeof(uint32_t) + payload_length;
    offset += record_length;
    ++record_index;
  }
  if (offset != stream.data.size()) {
    *error = "publication RECORD_COUNT does not consume the exact stream";
    return false;
  }
  return true;
}

bool publish_publication_records(const PublicationStream& stream) {
  if (stream.record_count == 1 && !stream.has_sha256) {
    return publish(stream.standard, stream.data.data(),
                   static_cast<uint32_t>(stream.data.size()));
  }
  size_t offset = 0;
  for (uint64_t record_index = 0; record_index < stream.record_count;
       ++record_index) {
    const size_t record_length =
        sizeof(uint32_t) + read_u32le(stream.data.data() + offset);
    if (!publish(stream.standard, stream.data.data() + offset,
                 static_cast<uint32_t>(record_length))) {
      return false;
    }
    offset += record_length;
  }
  return true;
}

bool emit_receipt(const PublicationReceipt& receipt) {
  const bool aligned =
      receipt.wire_format == PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY;
  return plugin_push_output_typed(
             "published", kFsbSchemaName, kFsbFileIdentifier,
             receipt.wire_format, kFsbRootType, 0,
             aligned ? kFsbAlignedSize : 0, aligned ? kFsbAlignment : 0,
             receipt.bytes.data(),
             static_cast<uint32_t>(receipt.bytes.size())) >= 0;
}

}  // namespace

extern "C" int publish_records(void) {
  plugin_reset_output_state();
  uint32_t accepted = 0;
  for (uint32_t index = 0; index < plugin_get_input_count(); ++index) {
    const plugin_input_frame_t* frame = plugin_get_input_frame(index);
    if (!frame || !frame->port_id ||
        std::strcmp(frame->port_id, "records") != 0) {
      continue;
    }
    PublicationChunk chunk;
    std::string error;
    if (!decode_publication_chunk(frame, &chunk, &error)) {
      plugin_set_error("publication-type", error.c_str());
      return 400;
    }
    ++accepted;

    PublicationStream completed;
    bool is_complete = false;
    if (!append_publication_chunk(std::move(chunk), &completed, &is_complete,
                                  &error)) {
      plugin_set_error("publication-stream", error.c_str());
      return 400;
    }
    if (!is_complete) continue;

    if (!validate_publication_records(completed, &error)) {
      plugin_set_error("publication-records", error.c_str());
      return 400;
    }
    if (!publish_publication_records(completed)) {
      plugin_set_error("publication-unavailable", "pubsub.publish failed");
      return 502;
    }
    // Publish every exact record before emitting any receipt. Hostcalls may
    // reuse the direct-invoke request arena, so each immutable input FSB was
    // copied into the assembly before crossing that boundary.
    for (const PublicationReceipt& receipt : completed.receipts) {
      if (receipt.bytes.size() > std::numeric_limits<uint32_t>::max() ||
          !emit_receipt(receipt)) {
        plugin_set_error("publication-output",
                         "unable to emit publication receipt");
        return 500;
      }
    }
  }
  if (accepted == 0) {
    plugin_set_error("publication-empty", "no publication records were supplied");
    return 400;
  }
  return 0;
}
