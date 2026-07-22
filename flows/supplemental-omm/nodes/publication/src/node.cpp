#include "space_data_module_invoke.h"

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

namespace {

constexpr const char* kFsbSchemaName = "FSB.fbs";
constexpr const char* kFsbFileIdentifier = "$FSB";
constexpr const char* kFsbRootType = "FSB";
constexpr uint32_t kFsbAlignedSize = 1'048'744;
constexpr uint16_t kFsbAlignment = 8;
constexpr std::string_view kPublicationSource = "supplemental-omm";

struct PublicationRecord {
  std::string standard;
  std::vector<uint8_t> bytes;
};

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
                         PublicationRecord* record) {
  if (!record || file_identifier.size() != 4 || file_identifier[0] != '$') {
    return false;
  }
  for (size_t index = 1; index < file_identifier.size(); ++index) {
    if (file_identifier[index] < 'A' || file_identifier[index] > 'Z') {
      return false;
    }
  }
  const std::string standard(file_identifier.substr(1));
  if (schema_name != standard) return false;
  record->standard = standard;
  return true;
}

bool complete_record_stream(flatSqlByteStreamKind kind, uint32_t sequence,
                            bool final, uint64_t total_bytes,
                            uint64_t record_count, size_t data_size) {
  return kind == flatSqlByteStreamKind_RECORD_STREAM && sequence == 0 &&
         final && record_count == 1 && data_size > 0 &&
         total_bytes == data_size;
}

bool decode_publication_record(const plugin_input_frame_t* frame,
                               PublicationRecord* record) {
  if (!frame || !record || !frame->payload || frame->payload_length == 0 ||
      !frame->file_identifier ||
      std::strcmp(frame->file_identifier, kFsbFileIdentifier) != 0) {
    return false;
  }
  if (frame->wire_format == PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER) {
    flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!VerifyFSBBuffer(verifier)) return false;
    const FSB* stream = GetFSB(frame->payload);
    if (!stream->SCHEMA_NAME() || !stream->FILE_IDENTIFIER() ||
        !stream->DATA() ||
        !complete_record_stream(
            stream->KIND(), stream->CHUNK_SEQUENCE(), stream->FINAL(),
            stream->TOTAL_BYTES(), stream->RECORD_COUNT(),
            stream->DATA()->size()) ||
        !set_record_identity(stream->SCHEMA_NAME()->string_view(),
                             stream->FILE_IDENTIFIER()->string_view(), record)) {
      return false;
    }
    record->bytes.assign(stream->DATA()->begin(), stream->DATA()->end());
    return true;
  }
  if (frame->wire_format == PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY) {
    if (frame->payload_length != kFsbAlignedSize ||
        frame->byte_length != kFsbAlignedSize ||
        frame->required_alignment != kFsbAlignment ||
        reinterpret_cast<uintptr_t>(frame->payload) % kFsbAlignment != 0) {
      return false;
    }
    const auto* stream =
        reinterpret_cast<const Aligned::FSB*>(frame->payload);
    if (!stream->has_SCHEMA_NAME() || !stream->has_FILE_IDENTIFIER() ||
        !stream->has_DATA() ||
        !complete_record_stream(
            stream->KIND, stream->CHUNK_SEQUENCE, stream->FINAL,
            stream->TOTAL_BYTES, stream->RECORD_COUNT, stream->DATA.size()) ||
        !set_record_identity(stream->SCHEMA_NAME.str(),
                             stream->FILE_IDENTIFIER.str(), record)) {
      return false;
    }
    record->bytes.assign(stream->DATA.values,
                         stream->DATA.values + stream->DATA.size());
    return true;
  }
  return false;
}

}  // namespace

extern "C" int publish_records(void) {
  plugin_reset_output_state();
  uint32_t published = 0;
  for (uint32_t index = 0; index < plugin_get_input_count(); ++index) {
    const plugin_input_frame_t* frame = plugin_get_input_frame(index);
    if (!frame || !frame->payload || frame->payload_length == 0 ||
        !frame->port_id || std::strcmp(frame->port_id, "records") != 0) {
      continue;
    }
    PublicationRecord record;
    if (!decode_publication_record(frame, &record)) {
      plugin_set_error(
          "publication-type",
          "publication requires one complete typed SDS record in $FSB");
      return 400;
    }
    // A hostcall may reuse the direct-invoke request arena. Preserve the exact
    // immutable frame bytes before crossing that boundary so publication and
    // the receipt cannot observe a stale/overwritten input view.
    const std::vector<uint8_t> records(
        frame->payload, frame->payload + frame->payload_length);
    if (!publish(record.standard, record.bytes.data(),
                 static_cast<uint32_t>(record.bytes.size()))) {
      plugin_set_error("publication-unavailable", "pubsub.publish failed");
      return 502;
    }

    const bool aligned =
        frame->wire_format == PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY;
    const int32_t output = plugin_push_output_typed(
        "published", kFsbSchemaName, kFsbFileIdentifier, frame->wire_format,
        kFsbRootType, 0, aligned ? kFsbAlignedSize : 0,
        aligned ? kFsbAlignment : 0, records.data(),
        static_cast<uint32_t>(records.size()));
    if (output < 0) {
      plugin_set_error("publication-output", "unable to emit publication receipt");
      return 500;
    }
    ++published;
  }
  if (published == 0) {
    plugin_set_error("publication-empty", "no publication records were supplied");
    return 400;
  }
  return 0;
}
