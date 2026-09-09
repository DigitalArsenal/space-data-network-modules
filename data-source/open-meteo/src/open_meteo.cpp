#include "space_data_module_invoke.h"
#include <cmath>
#include <chrono>
#include <algorithm>
#include <cstring>
#include <limits>
#include <set>

#include <string>
#include <vector>

using Json = nlohmann::json;
namespace {
constexpr size_t maxBytes = 4 * 1024 * 1024;
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
const char* error = "Invalid Open-Meteo input.";
#define NEED(condition, message) do { if (!(condition)) { error=message; return false; } } while (0)
#define CHECK(condition, message) do { if (!(condition)) return fail(message); } while (0)
const Variable* variable(const std::string& name) {
  for (const auto& v:variables) if (name==v.name) return &v;
  return nullptr;
}
const plugin_input_frame_t* frame(const char* port) {
  const plugin_input_frame_t* found=nullptr;
  for (uint32_t i=0;i<plugin_get_input_count();++i) {
    const auto* f=plugin_get_input_frame(i);
    if (!f || !f->port_id || !f->payload || !f->payload_length || f->payload_length>maxBytes) return nullptr;
    if (std::strcmp(f->port_id,port)==0) { if (found) return nullptr; found=f; }
  }
  return found;
}
Json json(const char* port) {
  const auto* f=frame(port);
  return f ? Json::parse(f->payload,f->payload+f->payload_length,nullptr,false) : Json();
}
int output(const char* port, const Json& value) {
  const auto text=value.dump();
  return plugin_push_output_ex(port, nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,
    nullptr, 0, 1, reinterpret_cast<const uint8_t*>(text.data()), text.size());
}
double number(const Json& object, const char* key) {
  return object.is_object() && object.contains(key) && object[key].is_number()
    ? object[key].get<double>() : std::numeric_limits<double>::quiet_NaN();
}
bool bounded(double value,double low,double high) { return std::isfinite(value) && value>=low && value<=high; }
bool text(const Json& object,const char* key) { return object.is_object() && object.contains(key) && object[key].is_string(); }
std::string location(double value) {
  // JSON's round-trippable decimal format is URL-safe for finite numbers.
  return Json(value).dump();
}
bool plan(const Json& config, Json& job) {
  NEED(config.is_object(), "Configuration must be an object.");
  const auto lat=number(config, "latitude"), lon=number(config, "longitude");
  NEED(bounded(lat,-90,90) && bounded(lon,-180,180), "Latitude or longitude is invalid.");
  NEED(!config.contains("forecast_days") || config["forecast_days"].is_number_integer(), "forecast_days must be an integer.");
  const auto rawDays=config.contains("forecast_days") ? number(config,"forecast_days") : 3;
  NEED(bounded(rawDays,1,16), "forecast_days must be between 1 and 16.");
  const int days=static_cast<int>(rawDays);
  NEED(days>=1 && days<=16, "forecast_days must be between 1 and 16.");
  NEED(text(config,"access"), "Choose API access explicitly.");
  const auto access=config["access"].get<std::string>();
  NEED(access=="noncommercial" || access=="customer", "Choose noncommercial or customer API access explicitly.");
  const std::string base=access=="customer" ? "https://customer-api.open-meteo.com/v1/forecast" : "https://api.open-meteo.com/v1/forecast";
  const auto selected=config.value("variables", Json::array({"temperature_2m","relative_humidity_2m","cloud_cover","wind_speed_10m","pressure_msl","precipitation"}));
  NEED(selected.is_array() && !selected.empty() && selected.size()<=sizeof(variables)/sizeof(variables[0]), "Select between one and eight hourly variables.");
  std::set<std::string> unique;
  std::string hourly;
  for (const auto& entry : selected) {
    NEED(entry.is_string(), "Variable name must be a string.");
    const auto name=entry.get<std::string>(); NEED(variable(name), "Unsupported hourly variable.");
    NEED(unique.insert(name).second, "Duplicate hourly variable.");
    if (!hourly.empty()) hourly += ',';
    hourly += name;
  }
  // A single best_match series may combine models and runs. Do not name it
  // as one deterministic model run or manufacture an initialisation epoch.
  const auto url=base+"?latitude="+location(lat)+"&longitude="+location(lon)+
    "&hourly="+hourly+"&forecast_days="+std::to_string(days)+
    "&models=best_match&timezone=GMT&timeformat=unixtime&temperature_unit=celsius&wind_speed_unit=ms&precipitation_unit=mm";
  job = {{"source_url",url},{"latitude",lat},{"longitude",lon},{"variables",selected},
    {"forecast_days",days},{"access",access},{"provider_id","open-meteo"},
    {"source_name","forecast/"+location(lat)+","+location(lon)}, {"model_id","open-meteo:best_match"}};
  return true;
}
int fail(const char* message) { plugin_set_error("invalid-open-meteo-input", message); return 1; }
}

extern "C" int plan_forecast() {
    CHECK(plugin_get_input_count()==1, "Exactly one configuration frame is required.");
    Json job; CHECK(plan(json("config"),job),error);
    const Json request={{"method","GET"},{"url",job["source_url"]},{"timeoutMs",20000},{"maxBytes",maxBytes},{"responseWire","raw-body-v1"}};
    if (output("request",request)<0 || output("job",job)<0) return 1;
    return 0;
}

int normalize_forecast(const Json& job,const Json& receipt,const plugin_input_frame_t* response) {
    Json expected; CHECK(plan(job,expected),error);
    CHECK(job==expected, "Job differs from its canonical forecast plan.");
    const auto retrieved=number(receipt, "retrieved_at_ms");
    CHECK(bounded(retrieved,1,9007199254740991.0), "Invalid retrieval epoch.");
    CHECK(std::floor(retrieved)==retrieved, "Retrieval epoch must be integer UTC milliseconds.");
    CHECK(text(receipt,"producer_peer_id"), "Producer peer ID missing.");
    const auto peer=receipt["producer_peer_id"].get<std::string>();
    CHECK(!peer.empty() && peer.size()<=128, "An authenticated producer peer ID is required.");
    CHECK(response && response->payload_length>8 && std::memcmp(response->payload,"$HRB",4)==0, "Expected a raw-body-v1 HTTP response.");
    const auto* p=response->payload;
    const uint32_t status=uint32_t(p[4]) | uint32_t(p[5])<<8 | uint32_t(p[6])<<16 | uint32_t(p[7])<<24;
    CHECK(status==200, "Open-Meteo HTTP request did not succeed; preserve the previous dataset.");
    const auto source=Json::parse(p+8,p+response->payload_length,nullptr,false);
    CHECK(source.is_object() && !source.contains("error"), "Open-Meteo returned an error response.");
    const auto lat=number(source,"latitude"), lon=number(source,"longitude");
    CHECK(bounded(lat,-90,90) && bounded(lon,-180,180), "Invalid response coordinates.");
    CHECK(source.contains("utc_offset_seconds") && source["utc_offset_seconds"]==0, "Response must use UTC.");
    CHECK(source.contains("hourly") && source["hourly"].is_object() && source.contains("hourly_units") && source["hourly_units"].is_object(), "Hourly fields missing.");
    const auto& hours=source["hourly"]; const auto& units=source["hourly_units"];
    CHECK(units.contains("time") && units["time"]=="unixtime", "Expected Unix seconds from the upstream API.");
    CHECK(hours.contains("time"), "Hourly times missing.");
    const auto& times=hours["time"];
    CHECK(times.is_array() && !times.empty() && times.size()==size_t(job["forecast_days"].get<int>()*24), "Hourly time array must cover every requested day.");
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
    for (const auto& selected:job["variables"]) {
      const auto& v=*variable(selected.get<std::string>());
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
        const auto field=b.CreateString(job["source_name"].get<std::string>()+"/"+v.name+"/"+std::to_string(epochs[i]));
        const auto model=b.CreateString("open-meteo:best_match"), name=b.CreateString(v.name), unit=b.CreateString(v.unit);
        const auto origin=b.CreateString("open-meteo.com"), dataset=b.CreateString(job["source_name"].get<std::string>());
        const auto url=b.CreateString(job["source_url"].get<std::string>()), producer=b.CreateString(peer);
        const auto licence=b.CreateString("https://creativecommons.org/licenses/by/4.0/");
        const auto citation=b.CreateString("Weather data by Open-Meteo (https://open-meteo.com/), CC BY 4.0. Units converted to SDS WXF units; forecast data, not observations.");
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
    const Json meta={{"schema","WXF.fbs"},{"batch_id",ephem::sha256_hex(p+8,response->payload_length-8)},{"provider_id","open-meteo"},{"source_name",job["source_name"]},
      {"source_url",job["source_url"]},{"source_peer",peer},{"reconcile","current"},
      {"origin_id","open-meteo.com"},{"origin_name","Open-Meteo"},{"dataset_id",job["source_name"]},
      {"license","CC-BY-4.0"},{"license_url","https://creativecommons.org/licenses/by/4.0/"},
      {"citation","Weather data by Open-Meteo (https://open-meteo.com/), CC BY 4.0; units converted to SDS WXF units."}};
    if (output("meta",meta)<0 || output("report",{{"records",count},{"missing",missing},{"retrieved_at_ms",retrieved}})<0) return 1;
    return plugin_push_output_ex("records","WXF.fbs","$WXF",PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"WXF",0,0,stream.data(),stream.size())<0 ? 1:0;
}

extern "C" int parse_forecast() {
  CHECK(plugin_get_input_count()==3, "Exactly one job, response and receipt frame are required.");
  return normalize_forecast(json("job"),json("receipt"),frame("response"));
}
