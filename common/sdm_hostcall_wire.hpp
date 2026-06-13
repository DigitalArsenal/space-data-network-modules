// Shared module-side implementation of the binary hostcall wire format.
//
// Mirrors space-data-module-sdk/src/host/hostcallWire.js. Requests and
// responses cross the host<->module boundary as binary envelopes
// (little-endian):
//
//   u32 metaLength
//   u8[metaLength]   meta JSON (UTF-8)
//   u32 segmentCount
//   repeat segmentCount times:
//     u32 segmentLength
//     u8[segmentLength] segment bytes
//
// Binary values inside the meta JSON are `{"$bin": <segmentIndex>}`
// references into the segment table; bytes never round-trip through base64.
// Request meta = params object. Response meta = {"ok":true,"result":...} or
// {"ok":false,"error":{...}}.

#ifndef SDM_HOSTCALL_WIRE_HPP
#define SDM_HOSTCALL_WIRE_HPP

#include <cstdint>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

extern "C" __attribute__((import_module("space_data_module_host"), import_name("call")))
int32_t sdm_host_call(const char* operation_ptr, int32_t operation_len,
                      const char* payload_ptr, int32_t payload_len);

extern "C" __attribute__((import_module("space_data_module_host"), import_name("response_len")))
int32_t sdm_host_response_len(void);

extern "C" __attribute__((import_module("space_data_module_host"), import_name("read_response")))
int32_t sdm_host_read_response(char* dst_ptr, int32_t dst_len);

extern "C" __attribute__((import_module("space_data_module_host"), import_name("clear_response")))
int32_t sdm_host_clear_response(void);

extern "C" __attribute__((import_module("space_data_module_host"), import_name("last_status_code")))
int32_t sdm_host_last_status_code(void);

namespace sdm_hostcall {

struct Segment {
  const uint8_t* data;
  size_t size;
};

struct Response {
  std::string meta;
  std::vector<std::vector<uint8_t>> segments;
};

inline void wire_append_u32_le(std::vector<uint8_t>* out, uint32_t value) {
  out->push_back(static_cast<uint8_t>(value & 0xffu));
  out->push_back(static_cast<uint8_t>((value >> 8) & 0xffu));
  out->push_back(static_cast<uint8_t>((value >> 16) & 0xffu));
  out->push_back(static_cast<uint8_t>((value >> 24) & 0xffu));
}

inline uint32_t wire_read_u32_le(const uint8_t* ptr) {
  return static_cast<uint32_t>(ptr[0]) |
         (static_cast<uint32_t>(ptr[1]) << 8) |
         (static_cast<uint32_t>(ptr[2]) << 16) |
         (static_cast<uint32_t>(ptr[3]) << 24);
}

// Build a request/response envelope from a meta JSON document plus raw
// binary segments.
inline std::vector<uint8_t> build_envelope(
    std::string_view meta_json,
    const std::vector<Segment>& segments) {
  size_t total = 4 + meta_json.size() + 4;
  for (const Segment& segment : segments) {
    total += 4 + segment.size;
  }
  std::vector<uint8_t> bytes;
  bytes.reserve(total);
  wire_append_u32_le(&bytes, static_cast<uint32_t>(meta_json.size()));
  bytes.insert(bytes.end(), meta_json.begin(), meta_json.end());
  wire_append_u32_le(&bytes, static_cast<uint32_t>(segments.size()));
  for (const Segment& segment : segments) {
    wire_append_u32_le(&bytes, static_cast<uint32_t>(segment.size));
    if (segment.size > 0 && segment.data != nullptr) {
      bytes.insert(bytes.end(), segment.data, segment.data + segment.size);
    }
  }
  return bytes;
}

// Parse an envelope into meta JSON + owned segment byte vectors.
inline bool parse_envelope(const uint8_t* bytes, size_t len, Response* out) {
  if (!bytes || !out || len < 8) {
    return false;
  }
  size_t offset = 0;
  const uint32_t meta_len = wire_read_u32_le(bytes + offset);
  offset += 4;
  if (offset + meta_len + 4 > len) {
    return false;
  }
  out->meta.assign(reinterpret_cast<const char*>(bytes + offset), meta_len);
  offset += meta_len;
  const uint32_t segment_count = wire_read_u32_le(bytes + offset);
  offset += 4;
  out->segments.clear();
  out->segments.reserve(segment_count);
  for (uint32_t index = 0; index < segment_count; ++index) {
    if (offset + 4 > len) {
      return false;
    }
    const uint32_t segment_len = wire_read_u32_le(bytes + offset);
    offset += 4;
    if (offset + segment_len > len) {
      return false;
    }
    out->segments.emplace_back(bytes + offset, bytes + offset + segment_len);
    offset += segment_len;
  }
  return true;
}

// Read the host response buffer, clear it, and parse it as an envelope.
inline bool read_response_envelope(Response* out) {
  if (!out) {
    return false;
  }
  const int32_t response_len = sdm_host_response_len();
  if (response_len < 0) {
    sdm_host_clear_response();
    return false;
  }
  std::vector<uint8_t> buffer(static_cast<size_t>(response_len), 0);
  const int32_t copied =
      response_len > 0
          ? sdm_host_read_response(reinterpret_cast<char*>(buffer.data()), response_len)
          : 0;
  sdm_host_clear_response();
  if (copied != response_len) {
    return false;
  }
  return parse_envelope(buffer.data(), buffer.size(), out);
}

inline size_t skip_json_ws(std::string_view text, size_t cursor) {
  while (cursor < text.size()) {
    const char c = text[cursor];
    if (c != ' ' && c != '\t' && c != '\n' && c != '\r') {
      break;
    }
    ++cursor;
  }
  return cursor;
}

// Locate the value position for `"key":` in a (whitespace-free or not) JSON
// document, find-key style; returns npos when absent.
inline size_t find_json_value(std::string_view text, std::string_view key) {
  const std::string marker = "\"" + std::string(key) + "\"";
  const size_t field_pos = text.find(marker);
  if (field_pos == std::string_view::npos) {
    return std::string_view::npos;
  }
  const size_t colon_pos = text.find(':', field_pos + marker.size());
  if (colon_pos == std::string_view::npos) {
    return std::string_view::npos;
  }
  return skip_json_ws(text, colon_pos + 1);
}

inline bool find_json_bool(std::string_view text, std::string_view key, bool* value_out) {
  if (!value_out) {
    return false;
  }
  const size_t cursor = find_json_value(text, key);
  if (cursor == std::string_view::npos) {
    return false;
  }
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

inline bool find_json_int64(std::string_view text, std::string_view key, int64_t* value_out) {
  if (!value_out) {
    return false;
  }
  size_t cursor = find_json_value(text, key);
  if (cursor == std::string_view::npos) {
    return false;
  }
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

// True when the value for `key` is JSON null.
inline bool json_value_is_null(std::string_view text, std::string_view key) {
  const size_t cursor = find_json_value(text, key);
  return cursor != std::string_view::npos && text.compare(cursor, 4, "null") == 0;
}

// Find a `"key":{"$bin":N}` binary reference and return the segment index.
inline bool find_bin_ref(std::string_view text, std::string_view key, size_t* index_out) {
  if (!index_out) {
    return false;
  }
  size_t cursor = find_json_value(text, key);
  if (cursor == std::string_view::npos || cursor >= text.size() || text[cursor] != '{') {
    return false;
  }
  cursor = skip_json_ws(text, cursor + 1);
  constexpr std::string_view kBinKey = "\"$bin\"";
  if (text.compare(cursor, kBinKey.size(), kBinKey) != 0) {
    return false;
  }
  cursor = skip_json_ws(text, cursor + kBinKey.size());
  if (cursor >= text.size() || text[cursor] != ':') {
    return false;
  }
  cursor = skip_json_ws(text, cursor + 1);
  if (cursor >= text.size() || text[cursor] < '0' || text[cursor] > '9') {
    return false;
  }
  size_t parsed = 0;
  while (cursor < text.size() && text[cursor] >= '0' && text[cursor] <= '9') {
    parsed = parsed * 10 + static_cast<size_t>(text[cursor] - '0');
    ++cursor;
  }
  cursor = skip_json_ws(text, cursor);
  if (cursor >= text.size() || text[cursor] != '}') {
    return false;
  }
  *index_out = parsed;
  return true;
}

// Success check for a response envelope meta: {"ok":true,...}.
inline bool meta_ok(std::string_view meta) {
  bool ok = false;
  return find_json_bool(meta, "ok", &ok) && ok;
}

// Perform a hostcall: build the request envelope, invoke `call`, then read,
// clear, and parse the response envelope. Returns true only when the call
// returned rc==0, the host status code is 0, and the response meta carries
// "ok":true.
inline bool call(
    std::string_view operation,
    std::string_view meta_json,
    const std::vector<Segment>& segments,
    Response* response_out) {
  if (!response_out) {
    return false;
  }
  const std::vector<uint8_t> envelope = build_envelope(meta_json, segments);
  const int32_t rc = sdm_host_call(
      operation.data(),
      static_cast<int32_t>(operation.size()),
      reinterpret_cast<const char*>(envelope.data()),
      static_cast<int32_t>(envelope.size()));
  const int32_t status = sdm_host_last_status_code();
  if (!read_response_envelope(response_out)) {
    return false;
  }
  return rc == 0 && status == 0 && meta_ok(response_out->meta);
}

// Fetch the segment referenced by `"key":{"$bin":N}` in the response meta.
inline bool get_segment_for_key(
    const Response& response,
    std::string_view key,
    std::vector<uint8_t>* bytes_out) {
  if (!bytes_out) {
    return false;
  }
  size_t index = 0;
  if (!find_bin_ref(response.meta, key, &index) || index >= response.segments.size()) {
    return false;
  }
  *bytes_out = response.segments[index];
  return true;
}

// Fetch the bytes for a `result` that must be a binary segment.
inline bool get_result_bytes(const Response& response, std::vector<uint8_t>* bytes_out) {
  return get_segment_for_key(response, "result", bytes_out);
}

// Fetch the bytes for a `result` that may be null (-> empty bytes, success).
inline bool get_result_bytes_or_empty(
    const Response& response,
    std::vector<uint8_t>* bytes_out) {
  if (!bytes_out) {
    return false;
  }
  if (json_value_is_null(response.meta, "result")) {
    bytes_out->clear();
    return true;
  }
  return get_result_bytes(response, bytes_out);
}

}  // namespace sdm_hostcall

#endif  // SDM_HOSTCALL_WIRE_HPP
