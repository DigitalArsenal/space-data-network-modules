/*
 * data-source/open-meteo/host-adapter - the Open-Meteo flow's scheduling gate (typed contracts 1.0).
 *
 *   prepare_scheduled : "tick" TimerTick (TICK) -> node CONFIG (plugin.getConfig): open_meteo_enabled must be true
 *                       (else "status" FlowNotice Skipped "disabled"); open_meteo_producer_peer_id must be set and
 *                       open_meteo_forecast.access must be "noncommercial" (scheduled customer access needs a credential
 *                       adapter: refused, no request is sent) -> the tick forwarded verbatim on "tick" to open-meteo
 *                       plan_forecast, which reads the forecast plan from the same node CONFIG.
 *   receipt_scheduled : "response" HttpResponse (HRSP) -> a 304 becomes "status" FlowNotice Unchanged (the current batch
 *                       stays, nothing is republished); anything else is forwarded verbatim on "response" to open-meteo
 *                       parse_forecast (which takes RETRIEVED_MS from the response and the producer peer id from CONFIG).
 *
 * The only host call is the builtin plugin.getConfig (SDS $PIV, typedHostcall.hpp). No JSON. The SDS $WXF header is
 * inlined by build.mjs (the 304 notice names the plan's source from the echoed CONTEXT).
 */
#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "HttpResponse_generated.h"
#include "FlowNotice_generated.h"
#include "TimerTick_generated.h"
#include <cstdint>
#include <cstring>
#include <string>
namespace {
namespace A = sdn::runtime::Aligned;
namespace R = sdn::runtime;
constexpr size_t maxBytes=4*1024*1024;
int fail(const char* message) {plugin_set_error("open-meteo-host-adapter",message);return 1;}
#define CHECK(condition,message) do {if(!(condition)) return fail(message);} while(0)

// plugin.getConfig: one ModuleConfig FlatBuffer (MCFG) on raw "config", read in place (sdm_piv::get_config(); nested
// values by dotted path). ok() is false when the host has none.
bool enabled(const sdm_piv::Config& c) { return c.kind("open_meteo_enabled")==R::configValueKind_Bool && c.boolean("open_meteo_enabled"); }
bool producer(const sdm_piv::Config& c) { return c.has("open_meteo_producer_peer_id") && c.kind("open_meteo_producer_peer_id")==R::configValueKind_String && !c.string("open_meteo_producer_peer_id").empty(); }

// The single frame on `port` when it is the invocation's only frame.
const plugin_input_frame_t* only(const char* port) {
  if (plugin_get_input_count()!=1) return nullptr;
  const auto* f=plugin_get_input_frame(0);
  return f && f->port_id && std::strcmp(f->port_id,port)==0 && f->payload && f->payload_length && f->payload_length<=maxBytes+64*1024 ? f : nullptr;
}
int notice(R::flowNoticeKind kind, const char* source, const char* reason) {
  flatbuffers::FlatBufferBuilder b(256);
  R::FinishFlowNoticeBuffer(b, R::CreateFlowNoticeDirect(b, kind, "WXF.fbs", "open-meteo", source, nullptr, 0, reason));
  return plugin_push_output_ex("status","FlowNotice.fbs",R::FlowNoticeIdentifier(),PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"FlowNotice",0,0,b.GetBufferPointer(),b.GetSize())<0?1:0;
}
}  // namespace

extern "C" int prepare_scheduled() {
  const auto* tick=only("tick");
  CHECK(tick,"Exactly one timer tick is required.");
  flatbuffers::Verifier verifier(tick->payload,tick->payload_length);
  CHECK(R::VerifyTimerTickBuffer(verifier),"The tick is not a TimerTick (TICK).");
  const sdm_piv::Config cfg=sdm_piv::get_config();
  CHECK(cfg.ok(),"Host configuration unavailable.");
  if(!enabled(cfg)) return notice(R::flowNoticeKind_Skipped,nullptr,"disabled");
  CHECK(producer(cfg),"Producer peer ID is required before fetching.");
  CHECK(cfg.has("open_meteo_forecast.access"),"Forecast configuration missing.");
  CHECK(cfg.kind("open_meteo_forecast.access")==R::configValueKind_String && cfg.string("open_meteo_forecast.access")=="noncommercial","Scheduled customer API access requires a credential adapter; no request was sent.");
  return plugin_push_output_ex("tick","TimerTick.fbs",R::TimerTickIdentifier(),PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"TimerTick",0,0,tick->payload,tick->payload_length)<0?1:0;
}

extern "C" int receipt_scheduled() {
  const auto* response=only("response");
  CHECK(response,"Exactly one HTTP response is required.");
  flatbuffers::Verifier verifier(response->payload,response->payload_length);
  CHECK(R::VerifyHttpResponseBuffer(verifier),"The response is not an HttpResponse (HRSP).");
  const sdm_piv::Config cfg=sdm_piv::get_config();
  CHECK(enabled(cfg) && producer(cfg),"Producer configuration missing or disabled.");
  const auto* http=R::GetHttpResponse(response->payload);
  if(http->STATUS()==304) {
    // The plan's source name, when the echoed CONTEXT is a $WXF header (FIELD_ID).
    std::string source;
    if(const auto* ctx=http->CONTEXT(); ctx && ctx->size()>8) {
      flatbuffers::Verifier v(ctx->data(),ctx->size());
      if(VerifySizePrefixedWXFBuffer(v) && GetSizePrefixedWXF(ctx->data())->FIELD_ID()) source=GetSizePrefixedWXF(ctx->data())->FIELD_ID()->str();
    }
    return notice(R::flowNoticeKind_Unchanged,source.empty()?nullptr:source.c_str(),"not-modified");
  }
  return plugin_push_output_ex("response","HttpResponse.fbs",R::HttpResponseIdentifier(),PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"HttpResponse",0,0,response->payload,response->payload_length)<0?1:0;
}
