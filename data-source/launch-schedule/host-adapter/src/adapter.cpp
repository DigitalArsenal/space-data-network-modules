/*
 * data-source/launch-schedule/host-adapter - the launch notices flow's scheduling gate (typed contracts 1.0).
 *
 *   prepare_scheduled : "tick" TimerTick (TICK) -> node CONFIG (plugin.getConfig): launch_schedule_enabled must be true
 *                       (else "status" FlowNotice Skipped "disabled"); launch_schedule_producer_peer_id must be set and
 *                       launch_schedule_source.access must be "anonymous" (a keyed registry tier needs a credential
 *                       adapter: refused, no request is sent) -> the tick forwarded verbatim on "tick" to launch-schedule
 *                       plan_launches, which reads the plan from the same node CONFIG.
 *   receipt_scheduled : "response" HttpResponse (HRSP) -> node CONFIG must still be enabled with a producer; a 304
 *                       becomes "status" FlowNotice Unchanged (the stored notices are neither replaced nor republished);
 *                       anything else is forwarded verbatim on "response" to launch-schedule parse_launches (which takes
 *                       RETRIEVED_MS from the response and the producer peer id from the plan in CONTEXT).
 *
 * The only host call is the builtin plugin.getConfig (SDS $PIV, typedHostcall.hpp). No JSON.
 */
#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "HttpResponse_generated.h"
#include "FlowNotice_generated.h"
#include "TimerTick_generated.h"
#include <cstdint>
#include <cstring>
#include <map>
#include <string>
namespace {
namespace A = sdn::runtime::Aligned;
namespace R = sdn::runtime;
constexpr size_t maxBytes=4*1024*1024;
int fail(const char* message) {plugin_set_error("launch-schedule-host-adapter",message);return 1;}
#define CHECK(condition,message) do {if(!(condition)) return fail(message);} while(0)

// plugin.getConfig: one ModuleConfig (MCFG) FlatBuffer on raw "config", read in place (nested objects are TableLists,
// reached by dotted paths). ok() is false when the host has none.
using Config = sdm_piv::Config;
const sdn::runtime::ConfigEntry* entry(const Config& c, const char* key) { return c.entry(key); }
bool isString(const sdn::runtime::ConfigEntry* e) { return e && e->KIND()==sdn::runtime::configValueKind_String; }
std::string textOf(const sdn::runtime::ConfigEntry* e) { return isString(e) && e->STRING_VALUE() ? e->STRING_VALUE()->str() : std::string(); }
bool enabled(const Config& c) { const auto* e=entry(c,"launch_schedule_enabled"); return e && e->KIND()==sdn::runtime::configValueKind_Bool && e->BOOL_VALUE(); }
bool producerText(const Config& c) { return isString(entry(c,"launch_schedule_producer_peer_id")); }
bool hasSource(const Config& c) {
  for (size_t i=0,n=c.tables("launch_schedule_source"); i<n; i++) if (c.table("launch_schedule_source",i).size()) return true;
  return false;
}

// The single frame on `port` when it is the invocation's only frame.
const plugin_input_frame_t* only(const char* port) {
  if (plugin_get_input_count()!=1) return nullptr;
  const auto* f=plugin_get_input_frame(0);
  return f && f->port_id && std::strcmp(f->port_id,port)==0 && f->payload && f->payload_length && f->payload_length<=maxBytes+64*1024 ? f : nullptr;
}
int notice(R::flowNoticeKind kind, const char* reason) {
  flatbuffers::FlatBufferBuilder b(256);
  R::FinishFlowNoticeBuffer(b, R::CreateFlowNoticeDirect(b, kind, "LDM.fbs", "launch-schedule", "upcoming", nullptr, 0, reason));
  return plugin_push_output_ex("status","FlowNotice.fbs",R::FlowNoticeIdentifier(),PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"FlowNotice",0,0,b.GetBufferPointer(),b.GetSize())<0?1:0;
}
}  // namespace

extern "C" int prepare_scheduled() {
  const auto* tick=only("tick");
  CHECK(tick,"Exactly one timer tick is required.");
  flatbuffers::Verifier verifier(tick->payload,tick->payload_length);
  CHECK(R::VerifyTimerTickBuffer(verifier),"The tick is not a TimerTick (TICK).");
  const Config cfg=sdm_piv::get_config();
  CHECK(cfg.ok(),"Host configuration unavailable.");
  if(!enabled(cfg)) return notice(R::flowNoticeKind_Skipped,"disabled");
  const auto* peer=entry(cfg,"launch_schedule_producer_peer_id");
  CHECK(!textOf(peer).empty(),"Producer peer ID is required before fetching.");
  CHECK(hasSource(cfg),"Launch registry configuration missing.");
  const auto* access=entry(cfg,"launch_schedule_source.access");
  CHECK(textOf(access)=="anonymous","A keyed registry tier requires a credential adapter; no request was sent.");
  return plugin_push_output_ex("tick","TimerTick.fbs",R::TimerTickIdentifier(),PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"TimerTick",0,0,tick->payload,tick->payload_length)<0?1:0;
}

extern "C" int receipt_scheduled() {
  const auto* response=only("response");
  CHECK(response,"Exactly one HTTP response is required.");
  flatbuffers::Verifier verifier(response->payload,response->payload_length);
  CHECK(R::VerifyHttpResponseBuffer(verifier),"The response is not an HttpResponse (HRSP).");
  const Config cfg=sdm_piv::get_config();
  CHECK(enabled(cfg) && producerText(cfg),"Producer configuration missing or disabled.");
  if(R::GetHttpResponse(response->payload)->STATUS()==304) return notice(R::flowNoticeKind_Unchanged,"not-modified");
  return plugin_push_output_ex("response","HttpResponse.fbs",R::HttpResponseIdentifier(),PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"HttpResponse",0,0,response->payload,response->payload_length)<0?1:0;
}
