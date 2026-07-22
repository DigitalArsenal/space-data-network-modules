#include "space_data_module_invoke.h"

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include <flatbuffers/flatbuffers.h>

namespace {

constexpr const char* kFsbSchemaName = "FSB.fbs";
constexpr const char* kFsbFileIdentifier = "$FSB";
constexpr const char* kFsbRootType = "FSB";
constexpr uint32_t kFsbAlignedSize = 1'048'744;
constexpr uint16_t kFsbAlignment = 8;
constexpr const char* kFsoFileIdentifier = "$FSO";
constexpr uint32_t kFsoAlignedSize = 361'648;

struct RouteState {
  const char* input_port;
  const char* output_port;
  uint64_t events = 0;
  uint64_t records = 0;
  uint64_t bytes = 0;
  int8_t status = 0;
  std::string error;
};

RouteState g_routes[] = {
    {"provider-starlink", "provider-starlink.dss"},
    {"provider-glonass", "provider-glonass.dss"},
    {"provider-intelsat", "provider-intelsat.dss"},
    {"provider-cpf", "provider-cpf.dss"},
    {"provider-iss", "provider-iss.dss"},
    {"store", "store.dss"},
};
constexpr size_t kRouteCount = sizeof(g_routes) / sizeof(g_routes[0]);
alignas(8) Aligned::FSB g_aligned_status{};

std::vector<uint8_t> build_dss(const RouteState& route) {
  flatbuffers::FlatBufferBuilder builder(256);
  const auto error = route.error.empty()
                         ? flatbuffers::Offset<flatbuffers::String>()
                         : builder.CreateString(route.error);
  const auto table_start = builder.StartTable();
  builder.AddElement<int8_t>(4, route.status, 0);  // STATUS
  builder.AddElement<uint64_t>(6, route.records, 0);  // SYNCED_ROWS
  builder.AddElement<uint64_t>(8, route.records, 0);  // TOTAL_ROWS
  builder.AddElement<uint64_t>(10, route.records, 0);  // LOCAL_ROWS
  builder.AddElement<uint64_t>(16, route.bytes, 0);  // CACHED_BYTES
  builder.AddElement<uint64_t>(20, route.bytes, 0);  // DOWNLOADED_BYTES
  if (!error.IsNull()) builder.AddOffset(70, error);  // ERROR
  const auto table_end = builder.EndTable(table_start);
  builder.FinishSizePrefixed(flatbuffers::Offset<void>(table_end), "$DSS");
  return std::vector<uint8_t>(builder.GetBufferPointer(),
                              builder.GetBufferPointer() + builder.GetSize());
}

bool consume_provider_event(const plugin_input_frame_t* frame,
                            RouteState* route) {
  if (!route || !frame || !frame->payload || frame->payload_length == 0 ||
      !frame->file_identifier ||
      std::strcmp(frame->file_identifier, kFsbFileIdentifier) != 0) {
    return false;
  }
  if (frame->wire_format == PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY) {
    if (frame->payload_length != kFsbAlignedSize) return false;
    const auto* stream =
        reinterpret_cast<const Aligned::FSB*>(frame->payload);
    ++route->events;
    route->records += stream->RECORD_COUNT;
    route->bytes += stream->DATA.size();
    route->status = 1;
    return true;
  }
  flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyFSBBuffer(verifier)) return false;
  const FSB* stream = GetFSB(frame->payload);
  ++route->events;
  route->records += stream->RECORD_COUNT();
  route->bytes += stream->DATA() ? stream->DATA()->size() : 0;
  route->status = 1;
  return true;
}

void apply_store_status(RouteState* route, uint8_t status,
                        const std::string& error_code,
                        const std::string& message) {
  if (status == 1 || status == 4) route->status = 2;
  else if (status == 2 || status == 3) route->status = 1;
  else route->status = 4;
  route->error.clear();
  if (route->status != 4) return;
  route->error = error_code;
  if (!message.empty()) {
    if (!route->error.empty()) route->error.append(": ");
    route->error.append(message);
  }
  if (route->error.empty()) route->error = "FlatSQL operation failed";
}

bool consume_store_event(const plugin_input_frame_t* frame, RouteState* route) {
  if (!route || !frame || !frame->payload || frame->payload_length == 0 ||
      !frame->file_identifier ||
      std::strcmp(frame->file_identifier, kFsoFileIdentifier) != 0) {
    return false;
  }
  if (frame->wire_format == PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY) {
    if (frame->payload_length != kFsoAlignedSize) return false;
    const auto* status =
        reinterpret_cast<const Aligned::FSO*>(frame->payload);
    ++route->events;
    route->records += status->AFFECTED_RECORDS;
    route->bytes += status->RESULT_BYTES;
    const std::string error_code =
        status->has_ERROR_CODE() ? status->ERROR_CODE.str() : std::string();
    const std::string message = status->has_MESSAGE()
                                    ? std::string(
                                          reinterpret_cast<const char*>(
                                              status->MESSAGE.values),
                                          status->MESSAGE.size())
                                    : std::string();
    apply_store_status(route, status->STATUS, error_code, message);
    return true;
  }
  flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyFSOBuffer(verifier)) return false;
  const FSO* status = GetFSO(frame->payload);
  ++route->events;
  route->records += status->AFFECTED_RECORDS();
  route->bytes += status->RESULT_BYTES();
  const std::string error_code = status->ERROR_CODE()
                                     ? status->ERROR_CODE()->str()
                                     : std::string();
  const std::string message =
      status->MESSAGE()
          ? std::string(reinterpret_cast<const char*>(status->MESSAGE()->data()),
                        status->MESSAGE()->size())
          : std::string();
  apply_store_status(route, status->STATUS(), error_code, message);
  return true;
}

int push_canonical_status(const RouteState& route,
                          const std::vector<uint8_t>& dss) {
  flatbuffers::FlatBufferBuilder builder(512);
  const auto schema_name = builder.CreateString("DSS.fbs");
  const auto file_identifier = builder.CreateString("$DSS");
  const auto data = builder.CreateVector(dss);
  FSBBuilder fsb(builder);
  fsb.add_REQUEST_ID(route.events);
  fsb.add_KIND(flatSqlByteStreamKind_UNSPECIFIED);
  fsb.add_FINAL(true);
  fsb.add_TOTAL_BYTES(dss.size());
  fsb.add_RECORD_COUNT(1);
  fsb.add_SCHEMA_NAME(schema_name);
  fsb.add_FILE_IDENTIFIER(file_identifier);
  fsb.add_DATA(data);
  const auto root = fsb.Finish();
  FinishFSBBuffer(builder, root);
  return plugin_push_output_typed(
      route.output_port, kFsbSchemaName, kFsbFileIdentifier,
      PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, kFsbRootType, 0, 0, 0,
      builder.GetBufferPointer(), static_cast<uint32_t>(builder.GetSize()));
}

int push_aligned_status(const RouteState& route,
                        const std::vector<uint8_t>& dss) {
  std::memset(&g_aligned_status, 0, sizeof(g_aligned_status));
  g_aligned_status.REQUEST_ID = route.events;
  g_aligned_status.KIND = flatSqlByteStreamKind_UNSPECIFIED;
  g_aligned_status.FINAL = true;
  g_aligned_status.TOTAL_BYTES = dss.size();
  g_aligned_status.RECORD_COUNT = 1;
  g_aligned_status.SCHEMA_NAME.set("DSS.fbs");
  g_aligned_status.set_has_SCHEMA_NAME(true);
  g_aligned_status.FILE_IDENTIFIER.set("$DSS");
  g_aligned_status.set_has_FILE_IDENTIFIER(true);
  g_aligned_status.DATA.set_length(static_cast<uint32_t>(dss.size()));
  std::memcpy(g_aligned_status.DATA.values, dss.data(), dss.size());
  g_aligned_status.set_has_DATA(true);
  return plugin_push_output_typed(
      route.output_port, kFsbSchemaName, kFsbFileIdentifier,
      PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, kFsbRootType, 0,
      kFsbAlignedSize, kFsbAlignment,
      reinterpret_cast<const uint8_t*>(&g_aligned_status), kFsbAlignedSize);
}

}  // namespace

extern "C" int record_event(void) {
  plugin_reset_output_state();
  bool touched[kRouteCount] = {};
  bool aligned_output[kRouteCount] = {};
  for (uint32_t index = 0; index < plugin_get_input_count(); ++index) {
    const plugin_input_frame_t* frame = plugin_get_input_frame(index);
    if (!frame || !frame->port_id) continue;
    size_t route_index = kRouteCount;
    for (size_t candidate = 0; candidate < kRouteCount; ++candidate) {
      if (std::strcmp(frame->port_id, g_routes[candidate].input_port) == 0) {
        route_index = candidate;
        break;
      }
    }
    if (route_index == kRouteCount) continue;
    const bool accepted = route_index == kRouteCount - 1
                              ? consume_store_event(frame, &g_routes[route_index])
                              : consume_provider_event(frame, &g_routes[route_index]);
    if (!accepted) {
      plugin_set_error(
          "status-event",
          "status requires typed provider $FSB or FlatSQL $FSO events");
      return 400;
    }
    aligned_output[route_index] =
        frame->wire_format == PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY;
    touched[route_index] = true;
  }
  bool emitted = false;
  for (size_t route_index = 0; route_index < kRouteCount; ++route_index) {
    if (!touched[route_index]) continue;
    const RouteState& route = g_routes[route_index];
    const std::vector<uint8_t> dss = build_dss(route);
    const int32_t output = aligned_output[route_index]
                               ? push_aligned_status(route, dss)
                               : push_canonical_status(route, dss);
    if (output < 0) {
      plugin_set_error("status-output", "unable to emit status snapshot");
      return 500;
    }
    emitted = true;
  }
  if (!emitted) {
    plugin_set_error("status-empty", "no status event was supplied");
    return 400;
  }
  return 0;
}
