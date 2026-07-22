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
constexpr uint32_t kFsbDataCapacity = 1'048'576;
constexpr uint16_t kFsbAlignment = 8;
constexpr const char* kFsoFileIdentifier = "$FSO";
constexpr uint32_t kFsoAlignedSize = 361'648;
constexpr const char* kDssSchemaName = "DSS.fbs";
constexpr const char* kDssFileIdentifier = "$DSS";

enum class RouteKind {
  kProvider,
  kProviderProgress,
  kOd,
  kStore,
};

struct RouteState {
  const char* input_port;
  const char* output_port;
  RouteKind kind;
  uint64_t events = 0;
  uint64_t records = 0;
  uint64_t total_records = 0;
  uint64_t bytes = 0;
  uint64_t successes = 0;
  uint64_t failures = 0;
  int8_t status = 0;
  std::string error;
};

RouteState g_routes[] = {
    {"provider-starlink-progress", "provider-starlink.dss",
     RouteKind::kProviderProgress},
    {"provider-glonass", "provider-glonass.dss", RouteKind::kProvider},
    {"provider-intelsat", "provider-intelsat.dss", RouteKind::kProvider},
    {"provider-cpf", "provider-cpf.dss", RouteKind::kProvider},
    {"provider-iss", "provider-iss.dss", RouteKind::kProvider},
    {"od", "od.dss", RouteKind::kOd},
    {"store", "store.dss", RouteKind::kStore},
};
constexpr size_t kRouteCount = sizeof(g_routes) / sizeof(g_routes[0]);
alignas(8) Aligned::FSB g_aligned_status{};

std::string visible_error(const RouteState& route) {
  if (route.kind != RouteKind::kOd || route.failures == 0) {
    return route.error;
  }
  std::string summary = std::to_string(route.failures);
  summary.append(route.failures == 1 ? " OD failure: " : " OD failures: ");
  summary.append(route.error);
  return summary;
}

std::vector<uint8_t> build_dss(const RouteState& route) {
  flatbuffers::FlatBufferBuilder builder(256);
  const bool od_route = route.kind == RouteKind::kOd;
  const uint64_t synced_rows = od_route ? route.successes : route.records;
  const uint64_t total_rows =
      od_route ? route.events
               : (route.kind == RouteKind::kProviderProgress
                      ? route.total_records
                      : route.records);
  const uint64_t missing_rows =
      od_route ? route.failures
               : (route.kind == RouteKind::kProviderProgress
                      ? route.total_records - route.records
                      : 0);
  const std::string error_message = visible_error(route);
  const auto error = error_message.empty()
                         ? flatbuffers::Offset<flatbuffers::String>()
                         : builder.CreateString(error_message);
  const auto table_start = builder.StartTable();
  builder.AddElement<int8_t>(4, route.status, 0);  // STATUS
  builder.AddElement<uint64_t>(6, synced_rows, 0);  // SYNCED_ROWS
  builder.AddElement<uint64_t>(8, total_rows, 0);  // TOTAL_ROWS
  builder.AddElement<uint64_t>(10, synced_rows, 0);  // LOCAL_ROWS
  builder.AddElement<uint64_t>(14, missing_rows, 0);  // MISSING_ROWS
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

struct ProgressEvent {
  int8_t status = 0;
  uint64_t synced_rows = 0;
  uint64_t total_rows = 0;
  uint64_t downloaded_bytes = 0;
};

bool decode_progress_dss(const uint8_t* bytes, uint32_t length,
                         ProgressEvent* event) {
  if (!event || !bytes || length < sizeof(uint32_t)) return false;
  const uint32_t declared_size =
      static_cast<uint32_t>(bytes[0]) |
      (static_cast<uint32_t>(bytes[1]) << 8) |
      (static_cast<uint32_t>(bytes[2]) << 16) |
      (static_cast<uint32_t>(bytes[3]) << 24);
  if (declared_size != length - sizeof(uint32_t)) return false;
  flatbuffers::Verifier verifier(bytes, length);
  if (!VerifySizePrefixedDSSBuffer(verifier)) return false;
  const DSS* progress = GetSizePrefixedDSS(bytes);
  const int8_t status = static_cast<int8_t>(progress->STATUS());
  const uint64_t synced_rows = progress->SYNCED_ROWS();
  const uint64_t total_rows = progress->TOTAL_ROWS();
  const uint64_t local_rows = progress->LOCAL_ROWS();
  const uint64_t missing_rows = progress->MISSING_ROWS();
  const uint64_t cached_bytes = progress->CACHED_BYTES();
  const uint64_t downloaded_bytes = progress->DOWNLOADED_BYTES();
  if ((status != dssSyncState_SYNCING && status != dssSyncState_SYNCED) ||
      total_rows == 0 || synced_rows > total_rows ||
      local_rows != synced_rows || missing_rows != total_rows - synced_rows ||
      cached_bytes != downloaded_bytes ||
      (status == dssSyncState_SYNCED && synced_rows != total_rows) ||
      (status == dssSyncState_SYNCING && synced_rows == total_rows)) {
    return false;
  }
  event->status = status;
  event->synced_rows = synced_rows;
  event->total_rows = total_rows;
  event->downloaded_bytes = downloaded_bytes;
  return true;
}

bool consume_provider_progress(const plugin_input_frame_t* frame,
                               RouteState* route) {
  if (!route || !frame || !frame->payload || frame->payload_length == 0 ||
      !frame->file_identifier ||
      std::strcmp(frame->file_identifier, kFsbFileIdentifier) != 0) {
    return false;
  }
  const uint8_t* data = nullptr;
  uint32_t data_length = 0;
  if (frame->wire_format == PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY) {
    if (frame->payload_length != kFsbAlignedSize ||
        reinterpret_cast<uintptr_t>(frame->payload) % alignof(Aligned::FSB) !=
            0) {
      return false;
    }
    const auto* stream = reinterpret_cast<const Aligned::FSB*>(frame->payload);
    if (!stream->FINAL || stream->CHUNK_SEQUENCE != 0 ||
        stream->RECORD_COUNT != 1 || !stream->has_SCHEMA_NAME() ||
        stream->SCHEMA_NAME.str() != kDssSchemaName ||
        !stream->has_FILE_IDENTIFIER() ||
        stream->FILE_IDENTIFIER.str() != kDssFileIdentifier ||
        !stream->has_DATA() || stream->DATA.length == 0 ||
        stream->DATA.length > kFsbDataCapacity ||
        stream->TOTAL_BYTES != stream->DATA.length) {
      return false;
    }
    data = stream->DATA.values;
    data_length = stream->DATA.length;
  } else if (frame->wire_format == PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER) {
    flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!VerifyFSBBuffer(verifier)) return false;
    const FSB* stream = GetFSB(frame->payload);
    if (!stream->FINAL() || stream->CHUNK_SEQUENCE() != 0 ||
        stream->RECORD_COUNT() != 1 || !stream->SCHEMA_NAME() ||
        stream->SCHEMA_NAME()->str() != kDssSchemaName ||
        !stream->FILE_IDENTIFIER() ||
        stream->FILE_IDENTIFIER()->str() != kDssFileIdentifier ||
        !stream->DATA() || stream->DATA()->empty() ||
        stream->DATA()->size() > kFsbDataCapacity ||
        stream->TOTAL_BYTES() != stream->DATA()->size()) {
      return false;
    }
    data = stream->DATA()->data();
    data_length = stream->DATA()->size();
  } else {
    return false;
  }
  ProgressEvent event;
  if (!decode_progress_dss(data, data_length, &event)) return false;
  ++route->events;
  route->records = event.synced_rows;
  route->total_records = event.total_rows;
  route->bytes = event.downloaded_bytes;
  route->status = event.status;
  route->error.clear();
  return true;
}

struct FsoEvent {
  uint8_t operation = 0;
  uint8_t status = 0;
  uint64_t affected_records = 0;
  uint64_t result_bytes = 0;
  std::string error_code;
  std::string message;
};

bool decode_fso_event(const plugin_input_frame_t* frame, FsoEvent* event) {
  if (!event || !frame || !frame->payload || frame->payload_length == 0 ||
      !frame->file_identifier ||
      std::strcmp(frame->file_identifier, kFsoFileIdentifier) != 0) {
    return false;
  }
  if (frame->wire_format == PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY) {
    if (frame->payload_length != kFsoAlignedSize ||
        reinterpret_cast<uintptr_t>(frame->payload) % alignof(Aligned::FSO) !=
            0) {
      return false;
    }
    const auto* operation =
        reinterpret_cast<const Aligned::FSO*>(frame->payload);
    if ((operation->has_ERROR_CODE() && operation->ERROR_CODE.length > 128) ||
        (operation->has_MESSAGE() && operation->MESSAGE.length > 4096)) {
      return false;
    }
    event->operation = static_cast<uint8_t>(operation->OPERATION);
    event->status = operation->STATUS;
    event->affected_records = operation->AFFECTED_RECORDS;
    event->result_bytes = operation->RESULT_BYTES;
    event->error_code = operation->has_ERROR_CODE()
                            ? operation->ERROR_CODE.str()
                            : std::string();
    event->message =
        operation->has_MESSAGE()
            ? std::string(
                  reinterpret_cast<const char*>(operation->MESSAGE.values),
                  operation->MESSAGE.length)
            : std::string();
    return true;
  }
  if (frame->wire_format != PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER) {
    return false;
  }
  flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyFSOBuffer(verifier)) return false;
  const FSO* operation = GetFSO(frame->payload);
  if ((operation->ERROR_CODE() && operation->ERROR_CODE()->size() > 128) ||
      (operation->MESSAGE() && operation->MESSAGE()->size() > 4096)) {
    return false;
  }
  event->operation = static_cast<uint8_t>(operation->OPERATION());
  event->status = operation->STATUS();
  event->affected_records = operation->AFFECTED_RECORDS();
  event->result_bytes = operation->RESULT_BYTES();
  event->error_code = operation->ERROR_CODE()
                          ? operation->ERROR_CODE()->str()
                          : std::string();
  event->message = operation->MESSAGE()
                       ? std::string(reinterpret_cast<const char*>(
                                         operation->MESSAGE()->data()),
                                     operation->MESSAGE()->size())
                       : std::string();
  return true;
}

std::string operation_error(const FsoEvent& event, const char* fallback) {
  std::string error = event.error_code;
  if (!event.message.empty()) {
    if (!error.empty()) error.append(": ");
    error.append(event.message);
  }
  if (error.empty()) error = fallback;
  return error;
}

void apply_store_status(RouteState* route, const FsoEvent& event) {
  if (event.status == 1 || event.status == 4) route->status = 2;
  else if (event.status == 2 || event.status == 3) route->status = 1;
  else route->status = 4;
  route->error.clear();
  if (route->status != 4) return;
  route->error = operation_error(event, "FlatSQL operation failed");
}

bool consume_store_event(const plugin_input_frame_t* frame, RouteState* route) {
  if (!route) return false;
  FsoEvent event;
  if (!decode_fso_event(frame, &event)) return false;
  if (event.operation > static_cast<uint8_t>(flatSqlNodeOperation_RELOAD) ||
      event.status < 1 || event.status > 10) {
    return false;
  }
  ++route->events;
  route->records += event.affected_records;
  route->bytes += event.result_bytes;
  apply_store_status(route, event);
  return true;
}

bool consume_od_event(const plugin_input_frame_t* frame, RouteState* route) {
  if (!route) return false;
  FsoEvent event;
  if (!decode_fso_event(frame, &event)) return false;
  if (event.operation != static_cast<uint8_t>(flatSqlNodeOperation_NONE) ||
      event.status < 1 || event.status > 10) {
    return false;
  }
  ++route->events;
  if (event.status >= 1 && event.status <= 4) {
    ++route->successes;
    route->records += event.affected_records;
    route->bytes += event.result_bytes;
    if (route->failures == 0) {
      route->status = event.status == 2 || event.status == 3 ? 1 : 2;
    }
    return true;
  }
  ++route->failures;
  route->status = 4;
  route->error = operation_error(event, "OD fit failed");
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
  if (dss.size() > kFsbDataCapacity) return -1;
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
  std::vector<RouteState> staged_routes(g_routes, g_routes + kRouteCount);
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
    bool accepted = false;
    switch (staged_routes[route_index].kind) {
      case RouteKind::kProvider:
        accepted = consume_provider_event(frame, &staged_routes[route_index]);
        break;
      case RouteKind::kProviderProgress:
        accepted =
            consume_provider_progress(frame, &staged_routes[route_index]);
        break;
      case RouteKind::kOd:
        accepted = consume_od_event(frame, &staged_routes[route_index]);
        break;
      case RouteKind::kStore:
        accepted = consume_store_event(frame, &staged_routes[route_index]);
        break;
    }
    if (!accepted) {
      plugin_set_error(
          "status-event",
          "status requires provider $FSB, Starlink $DSS-in-$FSB progress, or operation $FSO events");
      return 400;
    }
    aligned_output[route_index] =
        frame->wire_format == PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY;
    touched[route_index] = true;
  }
  bool emitted = false;
  for (size_t route_index = 0; route_index < kRouteCount; ++route_index) {
    if (!touched[route_index]) continue;
    const RouteState& route = staged_routes[route_index];
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
  for (size_t route_index = 0; route_index < kRouteCount; ++route_index) {
    if (touched[route_index]) g_routes[route_index] = staged_routes[route_index];
  }
  return 0;
}
