// flows/supplemental-omm status node (typed contracts 1.0: FlatBuffers only).
//
//   record_event  in   provider-starlink | provider-glonass | provider-intelsat | provider-cpf | provider-iss
//                        SDS $OEM: each ephemeris a source handed the OD node
//                      provider-starlink-notice   FlowNotice (FNTC) from the Starlink source (objects it could not get)
//                      od                         FlowNotice from the OD node: Info fitted, Skipped unfittable/fit-failed
//                      store                      IngestResult (INGR) from the flow's storage-ingest nodes
//                out   <route>.dss                one SDS $DSS snapshot of each route an invocation touched
//
// The routes are the APP status board's (app/ui): five provider lanes, the OD lane and the store lane. A provider
// lane counts the ephemerides (TOTAL/SYNCED rows = their states) and their bytes; the Starlink lane also counts the
// objects its source could not get (MISSING rows, ERROR the last reason). The OD lane counts objects: SYNCED the fitted
// ones, MISSING the refused ones, and keeps the last refusal visible while later fits succeed. The store lane counts
// the records stored; a refused batch is an ERROR until the next stored one. An invocation is applied whole or not at
// all: a frame that is not its port's type refuses it and changes nothing.

#include "space_data_module_invoke.h"

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include <flatbuffers/flatbuffers.h>

#include "DSS_generated.h"
#include "FlowNotice_generated.h"
#include "IngestResult_generated.h"
#include "OEM_generated.h"

namespace {

namespace R = sdn::runtime;

enum class RouteKind { kProvider, kOd, kStore };

struct RouteState {
  const char* output_port;
  RouteKind kind;
  uint64_t events = 0;
  uint64_t records = 0;
  uint64_t bytes = 0;
  uint64_t successes = 0;
  uint64_t failures = 0;
  uint64_t missing = 0;
  dssSyncState status = dssSyncState::IDLE;
  std::string error;
};

RouteState g_routes[] = {
    {"provider-starlink.dss", RouteKind::kProvider},
    {"provider-glonass.dss", RouteKind::kProvider},
    {"provider-intelsat.dss", RouteKind::kProvider},
    {"provider-cpf.dss", RouteKind::kProvider},
    {"provider-iss.dss", RouteKind::kProvider},
    {"od.dss", RouteKind::kOd},
    {"store.dss", RouteKind::kStore},
};
constexpr size_t kRouteCount = sizeof(g_routes) / sizeof(g_routes[0]);
constexpr size_t kStarlink = 0, kOd = 5, kStore = 6;

struct InputPort {
  const char* port_id;
  size_t route;
  enum { kOem, kNotice, kResult } type;
};
constexpr InputPort kInputs[] = {
    {"provider-starlink", 0, InputPort::kOem},
    {"provider-glonass", 1, InputPort::kOem},
    {"provider-intelsat", 2, InputPort::kOem},
    {"provider-cpf", 3, InputPort::kOem},
    {"provider-iss", 4, InputPort::kOem},
    {"provider-starlink-notice", kStarlink, InputPort::kNotice},
    {"od", kOd, InputPort::kNotice},
    {"store", kStore, InputPort::kResult},
};

std::string first_item(const R::FlowNotice& notice) {
  std::string text = notice.REASON() ? notice.REASON()->str() : std::string();
  if (notice.ITEMS() && notice.ITEMS()->size() > 0 && notice.ITEMS()->Get(0)) {
    if (!text.empty()) text += ": ";
    text += notice.ITEMS()->Get(0)->str();
  }
  return text;
}

bool consume_oem(const plugin_input_frame_t* frame, RouteState* route) {
  flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!OEMBufferHasIdentifier(frame->payload) || !VerifyOEMBuffer(verifier)) return false;
  uint64_t states = 0;
  if (const auto* blocks = GetOEM(frame->payload)->EPHEMERIS_DATA_BLOCK()) {
    for (const ephemerisDataBlock* block : *blocks) {
      if (!block) continue;
      if (block->EPHEMERIS_DATA_LINES()) states += block->EPHEMERIS_DATA_LINES()->size();
      else if (block->EPHEMERIS_DATA()) states += block->EPHEMERIS_DATA()->size() / (block->STATE_VECTOR_SIZE() == 3 ? 3 : 6);
    }
  }
  ++route->events;
  route->records += states;
  route->bytes += frame->payload_length;
  route->status = dssSyncState::SYNCING;
  return true;
}

const R::FlowNotice* notice_of(const plugin_input_frame_t* frame) {
  flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!R::FlowNoticeBufferHasIdentifier(frame->payload) || !R::VerifyFlowNoticeBuffer(verifier)) return nullptr;
  return R::GetFlowNotice(frame->payload);
}

bool consume_provider_notice(const plugin_input_frame_t* frame, RouteState* route) {
  const R::FlowNotice* notice = notice_of(frame);
  if (!notice) return false;
  ++route->events;
  if (notice->KIND() == R::flowNoticeKind_Missing) {
    route->missing += notice->COUNT();
    route->error = first_item(*notice);
    route->status = dssSyncState::ERROR;
  }
  return true;
}

bool consume_od_notice(const plugin_input_frame_t* frame, RouteState* route) {
  const R::FlowNotice* notice = notice_of(frame);
  if (!notice) return false;
  ++route->events;
  if (notice->KIND() == R::flowNoticeKind_Info) {
    ++route->successes;
    route->records += notice->COUNT();
    if (route->failures == 0) route->status = dssSyncState::SYNCED;
  } else if (notice->KIND() == R::flowNoticeKind_Skipped || notice->KIND() == R::flowNoticeKind_Missing) {
    ++route->failures;
    route->status = dssSyncState::ERROR;
    route->error = first_item(*notice);
  }
  return true;
}

bool consume_store_result(const plugin_input_frame_t* frame, RouteState* route) {
  flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!R::IngestResultBufferHasIdentifier(frame->payload) || !R::VerifyIngestResultBuffer(verifier)) return false;
  const R::IngestResult* result = R::GetIngestResult(frame->payload);
  ++route->events;
  if (result->REFUSED() && result->REFUSED()->size() > 0) {
    ++route->failures;
    route->status = dssSyncState::ERROR;
    route->error = (result->SCHEMA() ? result->SCHEMA()->str() + ": " : std::string()) + result->REFUSED()->str();
    return true;
  }
  ++route->successes;
  route->records += result->INSERTED();
  route->status = dssSyncState::SYNCED;
  route->error.clear();  // a store failure is not sticky
  return true;
}

std::vector<uint8_t> build_dss(const RouteState& route) {
  flatbuffers::FlatBufferBuilder builder(256);
  uint64_t synced = route.records, total = route.records, missing = route.missing;
  std::string error = route.error;
  if (route.kind == RouteKind::kOd) {
    synced = route.successes;
    total = route.successes + route.failures;
    missing = route.failures;
    if (route.failures > 0) {
      error = std::to_string(route.failures) + (route.failures == 1 ? " OD failure: " : " OD failures: ") + error;
    }
  } else if (route.kind == RouteKind::kProvider) {
    total = route.records + route.missing;
  }
  const auto error_offset = error.empty() ? flatbuffers::Offset<flatbuffers::String>() : builder.CreateString(error);
  DSSBuilder dss(builder);
  dss.add_STATUS(route.status);
  dss.add_SYNCED_ROWS(synced);
  dss.add_TOTAL_ROWS(total);
  dss.add_LOCAL_ROWS(synced);
  dss.add_MISSING_ROWS(missing);
  dss.add_CACHED_BYTES(route.bytes);
  dss.add_DOWNLOADED_BYTES(route.bytes);
  if (!error.empty()) dss.add_ERROR(error_offset);
  FinishDSSBuffer(builder, dss.Finish());
  return std::vector<uint8_t>(builder.GetBufferPointer(), builder.GetBufferPointer() + builder.GetSize());
}

}  // namespace

extern "C" int record_event(void) {
  plugin_reset_output_state();
  std::vector<RouteState> staged(g_routes, g_routes + kRouteCount);
  bool touched[kRouteCount] = {};
  for (uint32_t index = 0; index < plugin_get_input_count(); ++index) {
    const plugin_input_frame_t* frame = plugin_get_input_frame(index);
    if (!frame || !frame->port_id) continue;
    const InputPort* input = nullptr;
    for (const InputPort& candidate : kInputs) {
      if (std::strcmp(frame->port_id, candidate.port_id) == 0) input = &candidate;
    }
    if (!input) continue;
    bool accepted = false;
    if (frame->payload && frame->payload_length >= 8) {
      RouteState* route = &staged[input->route];
      if (input->type == InputPort::kOem) accepted = consume_oem(frame, route);
      else if (input->type == InputPort::kResult) accepted = consume_store_result(frame, route);
      else if (input->route == kOd) accepted = consume_od_notice(frame, route);
      else accepted = consume_provider_notice(frame, route);
    }
    if (!accepted) {
      const std::string message = std::string("\"") + input->port_id + "\" takes " +
                                  (input->type == InputPort::kOem      ? "an SDS $OEM"
                                   : input->type == InputPort::kResult ? "an IngestResult (INGR)"
                                                                       : "a FlowNotice (FNTC)");
      plugin_set_error("status-event", message.c_str());
      return 400;
    }
    touched[input->route] = true;
  }
  bool emitted = false;
  for (size_t route = 0; route < kRouteCount; ++route) {
    if (!touched[route]) continue;
    const std::vector<uint8_t> dss = build_dss(staged[route]);
    if (plugin_push_output_ex(staged[route].output_port, "DSS.fbs", DSSIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                              "DSS", 0, 0, dss.data(), static_cast<uint32_t>(dss.size())) < 0) {
      plugin_set_error("status-output", "unable to emit a status snapshot");
      return 500;
    }
    emitted = true;
  }
  if (!emitted) {
    plugin_set_error("status-empty", "no status event was supplied");
    return 400;
  }
  for (size_t route = 0; route < kRouteCount; ++route) {
    if (touched[route]) g_routes[route] = staged[route];
  }
  return 0;
}
