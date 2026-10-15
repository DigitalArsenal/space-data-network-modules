/*
 * data-source/open-meteo - hourly point forecasts from Open-Meteo as $WXF (typed contracts 1.0).
 *
 *   plan_forecast  : "tick" TimerTick (TICK; payload not read; the adapter's prepare_scheduled forwards it, or a direct
 *                    invoke sends one) -> node CONFIG open_meteo_forecast.* (plugin.getConfig) -> ONE "request"
 *                    HttpRequest (HREQ, GET) whose CONTEXT is the plan: ONE size-prefixed $WXF header record (no
 *                    samples) - FIELD_ID / DATASET_ID the source name "forecast/<lat>,<lon>", GRID the requested 1x1
 *                    location, SOURCE_URL the canonical request URL (it names the variables, forecast days and access
 *                    tier), MODEL_ID, ORIGIN_ID, TIME_BASIS ValidTimeOnly, MEMBER_KIND Unspecified, LICENSE_CLASS /
 *                    LICENSE_URL / CITATION, PRODUCER_PEER_ID (node CONFIG open_meteo_producer_peer_id).
 *   parse_forecast : ONE "response" HttpResponse (HRSP; the request's CONTEXT echoed; RETRIEVED_MS the host's retrieval
 *                    time) -> the plan re-derived from CONTEXT.SOURCE_URL and required to be canonical -> "records" the
 *                    size-prefixed $WXF stream (one 1x1 field per variable and UTC hour), "meta" ONE IngestRequest
 *                    (INGQ) for hostcap/storage-ingest, "report" FlowNotice (FNTC): Info (COUNT records, AT_MS
 *                    retrieval) and Missing (COUNT missing samples) when any. The producer peer id is the plan's
 *                    PRODUCER_PEER_ID (plan_forecast stamps node CONFIG open_meteo_producer_peer_id; the adapter's
 *                    receipt carried the same value before). No host call: parse is a pure transform.
 *
 * The only host call is plan_forecast's builtin plugin.getConfig (SDS $PIV, typedHostcall.hpp; no capability). The upstream
 * response body is Open-Meteo's JSON - a foreign wire format parsed here; nothing module-to-module is JSON.
 */
#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "HttpRequest_generated.h"
#include "HttpResponse_generated.h"
#include "IngestRequest_generated.h"
#include "FlowNotice_generated.h"
#include <cmath>
#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <map>
#include <set>

#include <string>
#include <string_view>
#include <vector>

using Json = nlohmann::json;
namespace {
namespace A = sdn::runtime::Aligned;
namespace R = sdn::runtime;
constexpr size_t maxBytes = 4 * 1024 * 1024;
constexpr const char* kLicenseUrl = "https://creativecommons.org/licenses/by/4.0/";
constexpr const char* kRecordCitation = "Weather data by Open-Meteo (https://open-meteo.com/), CC BY 4.0. Units converted to SDS WXF units; forecast data, not observations.";
constexpr const char* kBatchCitation = "Weather data by Open-Meteo (https://open-meteo.com/), CC BY 4.0; units converted to SDS WXF units.";
constexpr const char* kNoncommercial = "https://api.open-meteo.com/v1/forecast";
constexpr const char* kCustomer = "https://customer-api.open-meteo.com/v1/forecast";
struct Variable {
  const char *name, *inputUnit, *unit;
  wxfVariable kind;
  wxfLevelKind level;
  double height, scale, offset, minimum, maximum;
  bool accumulated;
};
// Source: https://open-meteo.com/en/docs (hourly variable definitions).
// WXF units are fixed by the canonical SDS IDL, not by display preferences.
constexpr Variable variables[] = {
  {"temperature_2m", "°C", "K", wxfVariable_Temperature2m, wxfLevelKind_HeightAboveGround, 2, 1, 273.15, -150, 100, false},
  {"dew_point_2m", "°C", "K", wxfVariable_DewpointTemperature2m, wxfLevelKind_HeightAboveGround, 2, 1, 273.15, -150, 100, false},
  {"relative_humidity_2m", "%", "1", wxfVariable_RelativeHumidity, wxfLevelKind_HeightAboveGround, 2, .01, 0, 0, 100, false},
  {"cloud_cover", "%", "1", wxfVariable_TotalCloudCover, wxfLevelKind_EntireAtmosphere, 0, .01, 0, 0, 100, false},
  {"wind_speed_10m", "m/s", "m/s", wxfVariable_WindSpeed10m, wxfLevelKind_HeightAboveGround, 10, 1, 0, 0, 250, false},
  {"pressure_msl", "hPa", "Pa", wxfVariable_MeanSeaLevelPressure, wxfLevelKind_MeanSeaLevel, 0, 100, 0, 1, 1200, false},
  {"surface_pressure", "hPa", "Pa", wxfVariable_SurfacePressure, wxfLevelKind_Surface, 0, 100, 0, 1, 1200, false},
  {"precipitation", "mm", "m", wxfVariable_TotalPrecipitation, wxfLevelKind_Surface, 0, .001, 0, 0, 5000, true}
};
const char* defaultVariables[] = {"temperature_2m","relative_humidity_2m","cloud_cover","wind_speed_10m","pressure_msl","precipitation"};
const char* error = "Invalid Open-Meteo input.";
#define NEED(condition, message) do { if (!(condition)) { error=message; return false; } } while (0)
#define CHECK(condition, message) do { if (!(condition)) return fail(message); } while (0)
int fail(const char* message) { plugin_set_error("invalid-open-meteo-input", message); return 1; }
const Variable* variable(const std::string& name) {
  for (const auto& v:variables) if (name==v.name) return &v;
  return nullptr;
}
// The single frame on `port`; nullptr when absent, repeated, empty or over budget.
const plugin_input_frame_t* frame(const char* port, size_t budget) {
  const plugin_input_frame_t* found=nullptr;
  for (uint32_t i=0;i<plugin_get_input_count();++i) {
    const auto* f=plugin_get_input_frame(i);
    if (!f || !f->port_id || !f->payload || !f->payload_length || f->payload_length>budget) return nullptr;
    if (std::strcmp(f->port_id,port)==0) { if (found) return nullptr; found=f; }
  }
  return found;
}
double number(const Json& object, const char* key) {
  return object.is_object() && object.contains(key) && object[key].is_number()
    ? object[key].get<double>() : std::numeric_limits<double>::quiet_NaN();
}
bool bounded(double value,double low,double high) { return std::isfinite(value) && value>=low && value<=high; }
std::string location(double value) {
  // JSON's round-trippable decimal format is URL-safe for finite numbers.
  return Json(value).dump();
}

// ---------------------------------------------------------------------------
// Node CONFIG: plugin.getConfig answers with one ModuleConfig FlatBuffer (MCFG) on raw "config", read in place through
// sdm_piv::get_config() (nested values by dotted path: "open_meteo_forecast.latitude").
// ---------------------------------------------------------------------------
// The forecast plan: location, variables, days and access tier.
struct Plan { double lat=0, lon=0; std::vector<std::string> selected; int days=3; std::string access; };
struct Planned { std::string url, sourceName; };

bool canonical(const Plan& plan, Planned& out) {
  NEED(bounded(plan.lat,-90,90) && bounded(plan.lon,-180,180), "Latitude or longitude is invalid.");
  NEED(plan.days>=1 && plan.days<=16, "forecast_days must be between 1 and 16.");
  NEED(!plan.access.empty(), "Choose API access explicitly.");
  NEED(plan.access=="noncommercial" || plan.access=="customer", "Choose noncommercial or customer API access explicitly.");
  NEED(!plan.selected.empty() && plan.selected.size()<=sizeof(variables)/sizeof(variables[0]), "Select between one and eight hourly variables.");
  std::set<std::string> unique;
  std::string hourly;
  for (const auto& name : plan.selected) {
    NEED(variable(name), "Unsupported hourly variable.");
    NEED(unique.insert(name).second, "Duplicate hourly variable.");
    if (!hourly.empty()) hourly += ',';
    hourly += name;
  }
  // A single best_match series may combine models and runs. Do not name it
  // as one deterministic model run or manufacture an initialisation epoch.
  out.url=std::string(plan.access=="customer" ? kCustomer : kNoncommercial)+"?latitude="+location(plan.lat)+"&longitude="+location(plan.lon)+
    "&hourly="+hourly+"&forecast_days="+std::to_string(plan.days)+
    "&models=best_match&timezone=GMT&timeformat=unixtime&temperature_unit=celsius&wind_speed_unit=ms&precipitation_unit=mm";
  out.sourceName="forecast/"+location(plan.lat)+","+location(plan.lon);
  return true;
}

// The plan from node CONFIG open_meteo_forecast.* (a nested table, read by dotted path).
bool planFromConfig(const sdm_piv::Config& c, Plan& plan) {
  using K=R::configValueKind;
  const std::string p="open_meteo_forecast.";
  bool any=c.kind("open_meteo_forecast")==K::configValueKind_TableList && c.tables("open_meteo_forecast")>0;
  for (const char* key:{"latitude","longitude","forecast_days","access","variables"}) any=any || c.has(p+key);
  NEED(any, "Configuration must be an object.");
  NEED(c.has(p+"latitude") && c.has(p+"longitude") && c.kind(p+"latitude")==K::configValueKind_Number && c.kind(p+"longitude")==K::configValueKind_Number, "Latitude or longitude is invalid.");
  plan.lat=c.number(p+"latitude"); plan.lon=c.number(p+"longitude");
  if (c.has(p+"forecast_days")) {
    const double d=c.number(p+"forecast_days", std::numeric_limits<double>::quiet_NaN());
    NEED(c.kind(p+"forecast_days")==K::configValueKind_Number && std::isfinite(d) && std::floor(d)==d, "forecast_days must be an integer.");
    NEED(bounded(d,1,16), "forecast_days must be between 1 and 16.");
    plan.days=static_cast<int>(d);
  }
  NEED(c.has(p+"access") && c.kind(p+"access")==K::configValueKind_String, "Choose API access explicitly.");
  plan.access=std::string(c.string(p+"access"));
  const std::string vars=p+"variables";
  NEED(c.numbers(vars).empty() && c.tables(vars)==0, "Variable name must be a string.");
  for (std::string_view v:c.strings(vars)) plan.selected.emplace_back(v);
  if (plan.selected.empty()) {
    for (const char* name:defaultVariables) plan.selected.push_back(name);
  }
  return true;
}

// The plan back from a canonical request URL (its query names every choice).
bool planFromUrl(const std::string& url, Plan& plan) {
  std::string query;
  if (url.compare(0,std::strlen(kCustomer),kCustomer)==0) { plan.access="customer"; query=url.substr(std::strlen(kCustomer)); }
  else if (url.compare(0,std::strlen(kNoncommercial),kNoncommercial)==0) { plan.access="noncommercial"; query=url.substr(std::strlen(kNoncommercial)); }
  else NEED(false, "Plan differs from its canonical forecast plan.");
  NEED(!query.empty() && query[0]=='?', "Plan differs from its canonical forecast plan.");
  std::map<std::string,std::string> params;
  size_t at=1;
  while (at<=query.size()) {
    size_t end=query.find('&',at); if (end==std::string::npos) end=query.size();
    const std::string pair=query.substr(at,end-at);
    const size_t eq=pair.find('=');
    if (eq!=std::string::npos) params[pair.substr(0,eq)]=pair.substr(eq+1);
    at=end+1;
  }
  const auto num=[&](const char* key, double* out) {
    const auto it=params.find(key); if (it==params.end() || it->second.empty()) return false;
    char* stop=nullptr; *out=std::strtod(it->second.c_str(),&stop); return *stop=='\0';
  };
  double days=0;
  NEED(num("latitude",&plan.lat) && num("longitude",&plan.lon) && num("forecast_days",&days), "Plan differs from its canonical forecast plan.");
  NEED(bounded(days,1,16) && std::floor(days)==days, "forecast_days must be between 1 and 16.");
  plan.days=static_cast<int>(days);
  std::string hourly=params["hourly"];
  size_t from=0;
  while (from<=hourly.size() && !hourly.empty()) {
    size_t comma=hourly.find(',',from); if (comma==std::string::npos) comma=hourly.size();
    plan.selected.push_back(hourly.substr(from,comma-from));
    from=comma+1;
  }
  return true;
}

// The plan as ONE size-prefixed $WXF header record: the request's CONTEXT.
std::vector<uint8_t> planContext(const Plan& plan, const Planned& planned, const std::string& peer) {
  flatbuffers::FlatBufferBuilder b(1024);
  const auto field=b.CreateString(planned.sourceName), model=b.CreateString("open-meteo:best_match");
  const auto origin=b.CreateString("open-meteo.com"), dataset=b.CreateString(planned.sourceName), url=b.CreateString(planned.url);
  const auto licence=b.CreateString(kLicenseUrl), citation=b.CreateString(kRecordCitation);
  const auto producer=peer.empty() ? 0 : b.CreateString(peer);
  WXFGridBuilder gridBuilder(b);
  gridBuilder.add_LAT0(plan.lat); gridBuilder.add_LON0(plan.lon); gridBuilder.add_NLAT(1); gridBuilder.add_NLON(1);
  const auto grid=gridBuilder.Finish();
  WXFBuilder record(b);
  record.add_FIELD_ID(field); record.add_MODEL_ID(model); record.add_MODEL_CLASS(wxfModelClass_Other);
  record.add_TIME_BASIS(wxfTimeBasis_ValidTimeOnly); record.add_MEMBER_KIND(wxfMemberKind_Unspecified);
  record.add_GRID(grid); record.add_ORIGIN_ID(origin); record.add_DATASET_ID(dataset); record.add_SOURCE_URL(url);
  record.add_LICENSE_CLASS(wxfLicenseClass_OpenAttribution); record.add_LICENSE_URL(licence); record.add_CITATION(citation);
  if (!peer.empty()) record.add_PRODUCER_PEER_ID(producer);
  b.FinishSizePrefixed(record.Finish(),"$WXF");
  return std::vector<uint8_t>(b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize());
}
bool same(const flatbuffers::String* s, const std::string& want) { return s && s->str()==want; }

int pushNotice(R::flowNoticeKind kind, const std::string& source, const std::string& batch, uint64_t count, const char* reason, uint64_t at) {
  flatbuffers::FlatBufferBuilder b(512);
  R::FinishFlowNoticeBuffer(b, R::CreateFlowNoticeDirect(b, kind, "WXF.fbs", "open-meteo", source.c_str(), batch.empty()?nullptr:batch.c_str(), count, reason, nullptr, at));
  return plugin_push_output_ex("report","FlowNotice.fbs",R::FlowNoticeIdentifier(),PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"FlowNotice",0,0,b.GetBufferPointer(),b.GetSize());
}
}  // namespace

extern "C" int plan_forecast() {
    for (uint32_t i=0;i<plugin_get_input_count();++i) {
      const auto* f=plugin_get_input_frame(i);
      CHECK(f && f->port_id && std::strcmp(f->port_id,"tick")==0, "plan_forecast takes only the timer tick.");
    }
    CHECK(plugin_get_input_count()<=1, "Exactly one timer tick per plan.");
    Plan plan; Planned planned;
    const sdm_piv::Config config=sdm_piv::get_config();
    CHECK(planFromConfig(config,plan) && canonical(plan,planned),error);
    // The producer peer id (node CONFIG open_meteo_producer_peer_id) rides the plan, so parse_forecast needs no host.
    const auto context=planContext(plan,planned,config.kind("open_meteo_producer_peer_id")==R::configValueKind_String ? std::string(config.string("open_meteo_producer_peer_id")) : std::string());
    flatbuffers::FlatBufferBuilder b(2048);
    R::FinishHttpRequestBuffer(b, R::CreateHttpRequestDirect(b, "GET", planned.url.c_str(), nullptr, nullptr, 20000, maxBytes, &context));
    return plugin_push_output_ex("request","HttpRequest.fbs",R::HttpRequestIdentifier(),PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"HttpRequest",0,0,b.GetBufferPointer(),b.GetSize())<0 ? 1:0;
}

extern "C" int parse_forecast() {
    CHECK(plugin_get_input_count()==1, "Exactly one response frame is required.");
    const auto* f=frame("response", maxBytes+64*1024);
    CHECK(f, "Expected one HttpResponse on \"response\".");
    flatbuffers::Verifier verifier(f->payload,f->payload_length);
    CHECK(R::VerifyHttpResponseBuffer(verifier), "Expected an HttpResponse (HRSP).");
    const auto* http=R::GetHttpResponse(f->payload);
    // The plan rides the request's CONTEXT; it must be the canonical plan of its own URL.
    const auto* ctx=http->CONTEXT();
    CHECK(ctx && ctx->size()>8, "The response carries no forecast plan (CONTEXT).");
    flatbuffers::Verifier ctxVerifier(ctx->data(),ctx->size());
    CHECK(VerifySizePrefixedWXFBuffer(ctxVerifier), "The forecast plan (CONTEXT) is not a size-prefixed $WXF record.");
    const auto* job=GetSizePrefixedWXF(ctx->data());
    CHECK(job->SOURCE_URL(), "Plan differs from its canonical forecast plan.");
    Plan plan; Planned planned;
    CHECK(planFromUrl(job->SOURCE_URL()->str(),plan) && canonical(plan,planned), error);
    CHECK(planned.url==job->SOURCE_URL()->str() && same(job->FIELD_ID(),planned.sourceName) && same(job->DATASET_ID(),planned.sourceName) &&
          job->GRID() && job->GRID()->LAT0()==plan.lat && job->GRID()->LON0()==plan.lon, "Job differs from its canonical forecast plan.");
    CHECK(job->PRODUCER_PEER_ID(), "Producer peer ID missing.");
    const std::string peer=job->PRODUCER_PEER_ID()->str();
    CHECK(!peer.empty() && peer.size()<=128, "An authenticated producer peer ID is required.");
    const double retrieved=static_cast<double>(http->RETRIEVED_MS());
    CHECK(bounded(retrieved,1,9007199254740991.0), "Invalid retrieval epoch.");
    CHECK(http->STATUS()==200, "Open-Meteo HTTP request did not succeed; preserve the previous dataset.");
    const uint8_t* body=http->BODY() ? http->BODY()->data() : nullptr;
    const size_t bodyLength=http->BODY() ? http->BODY()->size() : 0;
    CHECK(bodyLength>0 && bodyLength<=maxBytes, "Open-Meteo returned an empty or oversized body.");
    const auto source=Json::parse(body,body+bodyLength,nullptr,false);
    CHECK(source.is_object() && !source.contains("error"), "Open-Meteo returned an error response.");
    const auto lat=number(source,"latitude"), lon=number(source,"longitude");
    CHECK(bounded(lat,-90,90) && bounded(lon,-180,180), "Invalid response coordinates.");
    CHECK(source.contains("utc_offset_seconds") && source["utc_offset_seconds"]==0, "Response must use UTC.");
    CHECK(source.contains("hourly") && source["hourly"].is_object() && source.contains("hourly_units") && source["hourly_units"].is_object(), "Hourly fields missing.");
    const auto& hours=source["hourly"]; const auto& units=source["hourly_units"];
    CHECK(units.contains("time") && units["time"]=="unixtime", "Expected Unix seconds from the upstream API.");
    CHECK(hours.contains("time"), "Hourly times missing.");
    const auto& times=hours["time"];
    CHECK(times.is_array() && !times.empty() && times.size()==size_t(plan.days*24), "Hourly time array must cover every requested day.");
    std::vector<uint64_t> epochs;
    for (const auto& entry:times) {
      CHECK(entry.is_number_integer(), "Hourly times must be integer Unix seconds.");
      CHECK(bounded(entry.get<double>(),1,9007199254740.0), "Timestamp out of range.");
      const int64_t seconds=entry.get<int64_t>();
      CHECK(seconds>0 && seconds<=9007199254740LL, "Hourly timestamp outside the supported range.");
      const uint64_t epoch=uint64_t(seconds)*1000;
      CHECK(epochs.empty() || epoch==epochs.back()+3600000, "Hourly times must be continuous and strictly increasing.");
      epochs.push_back(epoch);
    }
    // /v1/forecast with timezone=GMT starts at 00:00 today. Reject stale
    // cached editions instead of presenting an old forecast as a new pull.
    CHECK(epochs.front()==uint64_t(retrieved/86400000)*86400000, "Forecast does not start on the retrieval date in UTC.");
    std::vector<uint8_t> stream;
    size_t missing=0, count=0;
    for (const auto& selected:plan.selected) {
      const auto& v=*variable(selected);
      CHECK(units.contains(v.name) && units[v.name]==v.inputUnit, "Unexpected source units; conversion was refused.");
      CHECK(hours.contains(v.name), "Requested variable missing.");
      const auto& samples=hours[v.name];
      CHECK(samples.is_array() && samples.size()==epochs.size(), "A requested variable is missing samples.");
      for (size_t i=0; i<epochs.size(); ++i) {
        const bool absent=samples[i].is_null();
        double value=std::numeric_limits<double>::quiet_NaN();
        if (!absent) {
          CHECK(samples[i].is_number(), "Weather sample is not numeric or null.");
          const double raw=samples[i].get<double>();
          CHECK(std::isfinite(raw) && raw>=v.minimum && raw<=v.maximum, "Weather sample outside physical sanity bounds.");
          value=raw*v.scale+v.offset;
        } else ++missing;
        flatbuffers::FlatBufferBuilder b(1024);
        const auto field=b.CreateString(planned.sourceName+"/"+v.name+"/"+std::to_string(epochs[i]));
        const auto model=b.CreateString("open-meteo:best_match"), name=b.CreateString(v.name), unit=b.CreateString(v.unit);
        const auto origin=b.CreateString("open-meteo.com"), dataset=b.CreateString(planned.sourceName);
        const auto url=b.CreateString(planned.url), producer=b.CreateString(peer);
        const auto licence=b.CreateString(kLicenseUrl);
        const auto citation=b.CreateString(kRecordCitation);
        WXFGridBuilder gridBuilder(b);
        gridBuilder.add_LAT0(lat); gridBuilder.add_LON0(lon); gridBuilder.add_NLAT(1); gridBuilder.add_NLON(1);
        const auto grid=gridBuilder.Finish();
        const float sample=static_cast<float>(value);
        const auto values=b.CreateVector(&sample,1);
        WXFBuilder record(b);
        record.add_FIELD_ID(field); record.add_MODEL_ID(model); record.add_MODEL_CLASS(wxfModelClass_Other);
        record.add_TIME_BASIS(wxfTimeBasis_ValidTimeOnly); record.add_VALID_TIME_MS(epochs[i]);
        record.add_MEMBER_KIND(wxfMemberKind_Unspecified);
        record.add_VARIABLE(v.kind); record.add_VARIABLE_NAME(name); record.add_UNITS(unit);
        record.add_LEVEL_KIND(v.level); record.add_LEVEL_VALUE(v.height);
        record.add_TEMPORAL_KIND(v.accumulated ? wxfTemporalKind_Accumulated : wxfTemporalKind_Instantaneous);
        if (v.accumulated) record.add_ACCUMULATION_HOURS(1);
        record.add_GRID(grid); record.add_VALUES(values); record.add_MISSING_COUNT(absent ? 1:0);
        // NaN statistics for an entirely missing field; never an invented zero.
        record.add_VALUE_MIN(sample); record.add_VALUE_MAX(sample);
        record.add_ORIGIN_ID(origin); record.add_DATASET_ID(dataset); record.add_SOURCE_URL(url);
        record.add_RETRIEVED_AT(static_cast<uint64_t>(retrieved));
        record.add_LICENSE_CLASS(wxfLicenseClass_OpenAttribution); record.add_LICENSE_URL(licence);
        record.add_CITATION(citation); record.add_PRODUCER_PEER_ID(producer);
        b.FinishSizePrefixed(record.Finish(),"$WXF");
        CHECK(stream.size()+b.GetSize()<=16*1024*1024, "Output exceeds its byte budget.");
        stream.insert(stream.end(),b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize()); ++count;
      }
    }
    // Emit only after the complete response is validated, so invalid tails
    // cannot replace a good dataset with a partially parsed forecast.
    // The batch id is the SHA-256 of the response body, as before.
    const std::string batch=ephem::sha256_hex(body,bodyLength);
    flatbuffers::FlatBufferBuilder m(1024);
    const auto tags=R::CreateSourceTagsDirect(m, "open-meteo", planned.sourceName.c_str(), batch.c_str(), planned.url.c_str(), nullptr,
                                              peer.c_str(), "CC-BY-4.0", kLicenseUrl, kBatchCitation);
    R::FinishIngestRequestBuffer(m, R::CreateIngestRequestDirect(m, "WXF.fbs", tags, R::reconcileMode_Current));
    if (plugin_push_output_ex("meta","IngestRequest.fbs",R::IngestRequestIdentifier(),PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"IngestRequest",0,0,m.GetBufferPointer(),m.GetSize())<0) return 1;
    if (pushNotice(R::flowNoticeKind_Info,planned.sourceName,batch,count,"normalized",static_cast<uint64_t>(retrieved))<0) return 1;
    if (missing && pushNotice(R::flowNoticeKind_Missing,planned.sourceName,batch,missing,"missing upstream samples (NaN)",static_cast<uint64_t>(retrieved))<0) return 1;
    return plugin_push_output_ex("records","WXF.fbs","$WXF",PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"WXF",0,0,stream.data(),stream.size())<0 ? 1:0;
}
