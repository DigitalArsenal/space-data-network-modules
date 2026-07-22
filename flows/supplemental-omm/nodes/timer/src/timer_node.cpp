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

constexpr uint64_t kHourMillis = 3'600'000;
constexpr uint64_t kInitialWakeupDelayMillis = 30'000;
constexpr const char* kTimerToken = "supplemental-omm-hourly";
constexpr const char* kFsbSchemaName = "FSB.fbs";
constexpr const char* kFsbFileIdentifier = "$FSB";
constexpr const char* kFsbRootType = "FSB";
constexpr uint32_t kFsbAlignedSize = 1'048'744;
constexpr uint16_t kFsbAlignment = 8;

bool g_initialized = false;
uint64_t g_next_due_ms = 0;
uint64_t g_tick_sequence = 0;
alignas(8) Aligned::FSB g_aligned_tick{};

void append_u32le(std::vector<uint8_t>* output, uint32_t value) {
  output->push_back(static_cast<uint8_t>(value));
  output->push_back(static_cast<uint8_t>(value >> 8));
  output->push_back(static_cast<uint8_t>(value >> 16));
  output->push_back(static_cast<uint8_t>(value >> 24));
}

void append_u64le(std::vector<uint8_t>* output, uint64_t value) {
  for (unsigned shift = 0; shift < 64; shift += 8) {
    output->push_back(static_cast<uint8_t>(value >> shift));
  }
}

uint32_t read_u32le(const uint8_t* value) {
  return static_cast<uint32_t>(value[0]) |
         (static_cast<uint32_t>(value[1]) << 8) |
         (static_cast<uint32_t>(value[2]) << 16) |
         (static_cast<uint32_t>(value[3]) << 24);
}

size_t find_json_value(std::string_view json, std::string_view key) {
  const std::string marker = "\"" + std::string(key) + "\"";
  const size_t key_position = json.find(marker);
  if (key_position == std::string_view::npos) return key_position;
  const size_t colon = json.find(':', key_position + marker.size());
  if (colon == std::string_view::npos) return colon;
  size_t cursor = colon + 1;
  while (cursor < json.size() &&
         (json[cursor] == ' ' || json[cursor] == '\t' ||
          json[cursor] == '\n' || json[cursor] == '\r')) {
    ++cursor;
  }
  return cursor;
}

bool json_bool(std::string_view json, std::string_view key, bool* output) {
  const size_t cursor = find_json_value(json, key);
  if (cursor == std::string_view::npos || !output) return false;
  if (json.compare(cursor, 4, "true") == 0) {
    *output = true;
    return true;
  }
  if (json.compare(cursor, 5, "false") == 0) {
    *output = false;
    return true;
  }
  return false;
}

bool json_u64(std::string_view json, std::string_view key, uint64_t* output) {
  size_t cursor = find_json_value(json, key);
  if (cursor == std::string_view::npos || !output || cursor >= json.size() ||
      json[cursor] < '0' || json[cursor] > '9') {
    return false;
  }
  uint64_t value = 0;
  while (cursor < json.size() && json[cursor] >= '0' && json[cursor] <= '9') {
    value = value * 10 + static_cast<uint64_t>(json[cursor] - '0');
    ++cursor;
  }
  *output = value;
  return true;
}

std::vector<uint8_t> envelope(std::string_view meta) {
  std::vector<uint8_t> bytes;
  bytes.reserve(8 + meta.size());
  append_u32le(&bytes, static_cast<uint32_t>(meta.size()));
  bytes.insert(bytes.end(), meta.begin(), meta.end());
  append_u32le(&bytes, 0);
  return bytes;
}

bool hostcall(std::string_view operation, std::string_view params,
              std::string* response_meta) {
  if (!response_meta) return false;
  sdm_host_clear_response();
  const std::vector<uint8_t> request = envelope(params);
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
  if (call_result != 0 || status != 0 || copied != response_length) return false;
  const uint32_t meta_length = read_u32le(response.data());
  if (meta_length > response.size() - 8) return false;
  response_meta->assign(
      reinterpret_cast<const char*>(response.data() + 4), meta_length);
  bool ok = false;
  return json_bool(*response_meta, "ok", &ok) && ok;
}

uint64_t next_hour_after(uint64_t now_ms) {
  return (now_ms / kHourMillis + 1) * kHourMillis;
}

uint32_t requested_output_wire_format() {
  const int32_t input_index = plugin_find_input_index("wakeup", 0);
  if (input_index < 0) return PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER;
  const plugin_input_frame_t* input =
      plugin_get_input_frame(static_cast<uint32_t>(input_index));
  return input &&
                 input->wire_format == PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY
             ? PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY
             : PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER;
}

std::vector<uint8_t> encode_tick(uint64_t now_ms, uint64_t scheduled_ms,
                                 uint64_t next_ms, uint64_t sequence,
                                 uint32_t missed_count) {
  std::vector<uint8_t> bytes;
  bytes.reserve(36);
  append_u64le(&bytes, now_ms);
  append_u64le(&bytes, scheduled_ms);
  append_u64le(&bytes, next_ms);
  append_u64le(&bytes, sequence);
  append_u32le(&bytes, missed_count);
  return bytes;
}

int push_canonical_tick(const std::vector<uint8_t>& tick, uint64_t sequence) {
  flatbuffers::FlatBufferBuilder builder(128);
  const auto schema_name = builder.CreateString("supplemental-omm.timer.tick.v1");
  const auto data = builder.CreateVector(tick);
  FSBBuilder fsb(builder);
  fsb.add_REQUEST_ID(sequence);
  fsb.add_KIND(flatSqlByteStreamKind_UNSPECIFIED);
  fsb.add_FINAL(true);
  fsb.add_TOTAL_BYTES(tick.size());
  fsb.add_RECORD_COUNT(1);
  fsb.add_SCHEMA_NAME(schema_name);
  fsb.add_DATA(data);
  const auto root = fsb.Finish();
  FinishFSBBuffer(builder, root);
  return plugin_push_output_typed(
      "tick", kFsbSchemaName, kFsbFileIdentifier,
      PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, kFsbRootType, 0, 0, 0,
      builder.GetBufferPointer(), static_cast<uint32_t>(builder.GetSize()));
}

int push_aligned_tick(const std::vector<uint8_t>& tick, uint64_t sequence) {
  std::memset(&g_aligned_tick, 0, sizeof(g_aligned_tick));
  g_aligned_tick.REQUEST_ID = sequence;
  g_aligned_tick.KIND = flatSqlByteStreamKind_UNSPECIFIED;
  g_aligned_tick.FINAL = true;
  g_aligned_tick.TOTAL_BYTES = tick.size();
  g_aligned_tick.RECORD_COUNT = 1;
  g_aligned_tick.SCHEMA_NAME.set("supplemental-omm.timer.tick.v1");
  g_aligned_tick.set_has_SCHEMA_NAME(true);
  g_aligned_tick.DATA.set_length(static_cast<uint32_t>(tick.size()));
  std::memcpy(g_aligned_tick.DATA.values, tick.data(), tick.size());
  g_aligned_tick.set_has_DATA(true);
  return plugin_push_output_typed(
      "tick", kFsbSchemaName, kFsbFileIdentifier,
      PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, kFsbRootType, 0,
      kFsbAlignedSize, kFsbAlignment,
      reinterpret_cast<const uint8_t*>(&g_aligned_tick), kFsbAlignedSize);
}

}  // namespace

extern "C" int on_wakeup(void) {
  std::string clock_response;
  if (!hostcall("clock.now", "{}", &clock_response)) {
    plugin_set_error("clock-unavailable", "clock.now failed");
    return 502;
  }
  uint64_t now_ms = 0;
  if (!json_u64(clock_response, "result", &now_ms)) {
    plugin_set_error("invalid-clock-response", "clock.now returned no integer result");
    return 502;
  }

  // The parent runtime represents both lifecycle activation and later generic
  // wakeups with the same opaque wakeup port.  Treat the first invocation of a
  // fresh signed timer instance as installation bootstrap regardless of frame
  // shape, then let the host's generic timer delivery re-enter this node after
  // the grace period.  Policy remains entirely inside this WASM node.
  if (!g_initialized) {
    g_initialized = true;
    g_next_due_ms = now_ms + kInitialWakeupDelayMillis;
    const std::string timer_request =
        std::string("{\"at_unix_ms\":") + std::to_string(g_next_due_ms) +
        ",\"token\":\"" + kTimerToken + "\"}";
    std::string timer_response;
    if (!hostcall("timers.arm", timer_request, &timer_response)) {
      plugin_set_error("timer-unavailable", "timers.arm failed");
      return 502;
    }
    return 0;
  }

  const bool fire = !g_initialized || now_ms >= g_next_due_ms;
  uint64_t scheduled_ms = now_ms;
  uint32_t missed_count = 0;
  if (fire) {
    if (g_initialized) {
      scheduled_ms = g_next_due_ms;
      missed_count = static_cast<uint32_t>((now_ms - g_next_due_ms) / kHourMillis);
    }
    g_initialized = true;
    g_next_due_ms = next_hour_after(now_ms);
  }

  const std::string timer_request =
      std::string("{\"at_unix_ms\":") + std::to_string(g_next_due_ms) +
      ",\"token\":\"" + kTimerToken + "\"}";
  std::string timer_response;
  if (!hostcall("timers.arm", timer_request, &timer_response)) {
    plugin_set_error("timer-unavailable", "timers.arm failed");
    return 502;
  }
  if (!fire) return 0;

  ++g_tick_sequence;
  const std::vector<uint8_t> tick = encode_tick(
      now_ms, scheduled_ms, g_next_due_ms, g_tick_sequence, missed_count);
  const int output =
      requested_output_wire_format() == PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY
          ? push_aligned_tick(tick, g_tick_sequence)
          : push_canonical_tick(tick, g_tick_sequence);
  if (output < 0) {
    plugin_set_error("tick-output-failed", "unable to emit timer tick");
    return 500;
  }
  return 0;
}
