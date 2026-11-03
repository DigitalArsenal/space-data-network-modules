#include "HttpRequest_generated.h"
#include "HttpResponse_generated.h"
#include "IngestRequest_generated.h"
#include "TimerTick_generated.h"
#include "space_data_module_invoke.h"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <ctime>
#include <map>
#include <set>
#include <stdexcept>
namespace {
namespace R = sdn::runtime;
using J = nlohmann::json;
const char *paths[] = {"json/rtsw/rtsw_mag_1m",
                       "json/rtsw/rtsw_wind_1m",
                       "json/rtsw/rtsw_ephemerides_1h",
                       "products/geospace/propagated-solar-wind-1-hour",
                       "json/planetary_k_index_1m",
                       "products/noaa-planetary-k-index-forecast",
                       "json/goes/primary/xrays-7-day",
                       "json/goes/primary/integral-protons-7-day",
                       "json/goes/primary/integral-electrons-7-day",
                       "products/alerts",
                       "json/goes/primary/xray-flares-7-day"};
std::string url(int i) {
  return std::string("https://services.swpc.noaa.gov/") + paths[i] + ".json";
}
std::string name(int i) {
  std::string s = paths[i];
  return s.substr(s.rfind('/') + 1);
}
std::string failure;
#define require(b, s)                                                          \
  do {                                                                         \
    if (!(b)) {                                                                \
      failure = (s);                                                           \
      return {};                                                               \
    }                                                                          \
  } while (0)
std::string str(const J &j, const char *k) {
  if (!j.contains(k) || j[k].is_null())
    return "";
  if (j[k].is_string())
    return j[k].get<std::string>();
  if (j[k].is_number_integer())
    return j[k].dump();
  failure = "Expected source string/integer token";
  return "";
}
double number(const J &v) {
  if (v.is_null())
    return NAN;
  if (v.is_boolean())
    return v.get<bool>() ? 1 : 0;
  if (v.is_number()) {
    double d = v.get<double>();
    require(std::isfinite(d), "Nonfinite number");
    return d;
  }
  if (v.is_string()) {
    std::string s = v.get<std::string>();
    char *end = nullptr;
    double d = std::strtod(s.c_str(), &end);
    require(end == s.c_str() + s.size() && end != s.c_str() && std::isfinite(d),
            "Invalid number");
    return d;
  }
  failure = "Invalid number type";
  return NAN;
}
std::string utc(std::string s) {
  require(s.size() >= 19, "Invalid UTC timestamp");
  s[10] = 'T';
  if (s.back() != 'Z')
    s += 'Z';
  return s;
}
int64_t epoch(std::string s) {
  s = utc(s);
  int y, m, d, h, mi;
  double sec;
  require(std::sscanf(s.c_str(), "%d-%d-%dT%d:%d:%lf", &y, &m, &d, &h, &mi,
                      &sec) == 6,
          "Invalid timestamp");
  require(y >= 1970 && m >= 1 && m <= 12 && d >= 1 && d <= 31 && h >= 0 &&
              h < 24 && mi >= 0 && mi < 60 && sec >= 0 && sec < 60,
          "Timestamp range");
  const int mdays[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  require(d <= mdays[m - 1] +
                   (m == 2 && y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)),
          "Invalid calendar date");
  int yy = y - (m <= 2), era = yy / 400;
  unsigned yo = yy - era * 400,
           doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  int64_t days =
      int64_t(era) * 146097 + yo * 365 + yo / 4 - yo / 100 + doy - 719468;
  return days * 86400000 + h * 3600000 + mi * 60000 + std::llround(sec * 1000);
}
std::string iso(uint64_t ms) {
  time_t sec = ms / 1000;
  std::tm t = *std::gmtime(&sec);
  char b[40];
  std::strftime(b, sizeof(b), "%Y-%m-%dT%H:%M:%S", &t);
  char frac[8];
  std::snprintf(frac, sizeof(frac), ".%03uZ", unsigned(ms % 1000));
  return std::string(b) + frac;
}
struct Source {
  int id;
  std::string body, digest, retrieved;
  J rows;
};
std::unique_ptr<PVNT> provenance(const Source &s) {
  auto p = std::make_unique<PVNT>();
  p->SOURCE_ID = "noaa-swpc-rt";
  p->SOURCE_KIND = pvnSourceKind::Observation;
  p->ORIGINATOR = "NOAA Space Weather Prediction Center";
  p->PROVIDER_ID = "space-weather";
  p->PRODUCER = "swpc-realtime/0.2.0";
  p->LICENSE_CLASS = pvnLicenseClass::Reproducible;
  p->LICENSE_ID = "public-domain";
  p->LINEAGE = url(s.id);
  return p;
}
template <class T> void lineage(T &r, const Source &s) {
  r.PROVENANCE = provenance(s);
  r.SOURCE_DIGEST = s.digest;
  r.SOURCE_CID = "f01551220" + s.digest;
  r.RETRIEVED_AT = s.retrieved;
}
Source read(int id, const R::HttpResponse *h) {
  require(h->STATUS() == 200 && h->BODY() && h->BODY()->size() > 0 &&
              h->BODY()->size() <= 16777216,
          "Require complete HTTP 200 body <=16 MiB");
  require(h->RETRIEVED_MS() > 0, "Missing retrieval time");
  Source s{id};
  s.body.assign(reinterpret_cast<const char *>(h->BODY()->data()),
                h->BODY()->size());
  s.digest = ephem::sha256_hex(reinterpret_cast<const uint8_t *>(s.body.data()),
                               s.body.size());
  s.retrieved = iso(h->RETRIEVED_MS());
  s.rows = J::parse(s.body, nullptr, false);
  require(s.rows.is_array() && !s.rows.empty(), "Expected nonempty array");
  if (s.rows[0].is_array()) {
    auto header = s.rows[0];
    J rows = J::array();
    for (size_t i = 1; i < s.rows.size(); i++) {
      require(s.rows[i].is_array() && s.rows[i].size() == header.size(),
              "Table width");
      J row = J::object();
      for (size_t k = 0; k < header.size(); k++) {
        require(header[k].is_string(), "Invalid table header");
        auto key = header[k].get<std::string>();
        require(!row.contains(key), "Duplicate table column");
        row[key] = s.rows[i][k];
      }
      rows.push_back(row);
    }
    s.rows = rows;
  }
  return s;
}
struct Quantity {
  swsQuantity kind = swsQuantity::Unspecified;
  std::string unit;
};
Quantity quantity(int id, std::string k) {
  if (k == "bt")
    return {swsQuantity::ImfMagnitude, "nT"};
  if (k == "bx" || k.rfind("bx_", 0) == 0)
    return {swsQuantity::ImfX, "nT"};
  if (k == "by" || k.rfind("by_", 0) == 0)
    return {swsQuantity::ImfY, "nT"};
  if (k == "bz" || k.rfind("bz_", 0) == 0)
    return {swsQuantity::ImfZ, "nT"};
  if (k.rfind("phi_", 0) == 0)
    return {swsQuantity::ImfLongitude, "deg"};
  if (k.rfind("theta_", 0) == 0)
    return {swsQuantity::ImfLatitude, "deg"};
  if (k == "speed" || k == "proton_speed")
    return {swsQuantity::ProtonSpeed, "km/s"};
  if (k == "density" || k == "proton_density")
    return {swsQuantity::ProtonDensity, "cm^-3"};
  if (k == "temperature" || k == "proton_temperature")
    return {swsQuantity::ProtonTemperature, "K"};
  if (k == "alpha_speed")
    return {swsQuantity::AlphaSpeed, "km/s"};
  if (k == "alpha_density")
    return {swsQuantity::AlphaDensity, "cm^-3"};
  if (k == "alpha_temperature")
    return {swsQuantity::AlphaTemperature, "K"};
  if (k == "vx" || k.rfind("proton_vx_", 0) == 0)
    return {swsQuantity::ProtonVelocityX, "km/s"};
  if (k == "vy" || k.rfind("proton_vy_", 0) == 0)
    return {swsQuantity::ProtonVelocityY, "km/s"};
  if (k == "vz" || k.rfind("proton_vz_", 0) == 0)
    return {swsQuantity::ProtonVelocityZ, "km/s"};
  if (k.rfind("alpha_v", 0) == 0 || k.rfind("vx_", 0) == 0 ||
      k.rfind("vy_", 0) == 0 || k.rfind("vz_", 0) == 0)
    return {swsQuantity::Unspecified, "km/s"};
  if (k.rfind("x_", 0) == 0 || k.rfind("y_", 0) == 0 || k.rfind("z_", 0) == 0)
    return {swsQuantity::Unspecified, "km"};
  if (k == "estimated_kp" || (id == 5 && k == "kp"))
    return {swsQuantity::Kp, "1"};
  if (k == "flux" && id == 6)
    return {swsQuantity::XrayFlux, "W/m^2"};
  if (k == "observed_flux" && id == 6)
    return {swsQuantity::XrayFluxUncorrected, "W/m^2"};
  if (k == "flux" && id == 7)
    return {swsQuantity::ProtonIntegralFlux, "cm^-2 s^-1 sr^-1"};
  if (k == "flux" && id == 8)
    return {swsQuantity::ElectronIntegralFlux, "cm^-2 s^-1 sr^-1"};
  failure = "Unmapped quantity: " + k;
  return {};
}
bool auxiliary(const std::string &k) {
  return k == "active" || k == "range" || k == "scale" || k == "sensitivity" ||
         k == "manual_mode" || k == "overall_quality" || k == "cadence" ||
         k == "kp_index" || k == "electron_correction" ||
         k == "electron_contaminaton" ||
         k.find("sample_size") != std::string::npos || k.rfind("max_", 0) == 0;
}
using Stream = std::vector<uint8_t>;
void append(Stream &out, const flatbuffers::FlatBufferBuilder &b) {
  out.insert(out.end(), b.GetBufferPointer(),
             b.GetBufferPointer() + b.GetSize());
}
bool series(const Source &s, Stream &out, uint64_t &count) {
  std::map<std::string, std::vector<J>> groups;
  for (const auto &r : s.rows) {
    require(r.is_object() && r.contains("time_tag"), "Missing time_tag");
    auto t = str(r, "time_tag");
    epoch(t);
    groups[str(r, "source") + "|" + str(r, "satellite") + "|" +
           str(r, "energy") + "|" + t.substr(0, 10)]
        .push_back(r);
  }
  for (auto &[key, rows] : groups) {
    std::stable_sort(rows.begin(), rows.end(), [](const J &a, const J &b) {
      return epoch(str(a, "time_tag")) < epoch(str(b, "time_tag"));
    });
    std::set<std::string> fields, flags, tokens;
    for (const auto &r : rows)
      for (auto it = r.begin(); it != r.end(); ++it) {
        const auto &k = it.key();
        if (k == "time_tag" || k == "source" || k == "satellite" ||
            k == "energy" || k == "propagated_time_tag" || k == "observed" ||
            k == "noaa_scale")
          continue;
        if (k == "kp" && s.id == 4) {
          tokens.insert(str(r, "kp"));
          continue;
        }
        if (auxiliary(k))
          flags.insert(k);
        else {
          quantity(s.id, k);
          fields.insert(k);
        }
      }
    for (const auto &field : fields) {
      SWST v;
      lineage(v, s);
      v.SERIES_ID = name(s.id) + "/" + key + "/" + field;
      v.QUANTITY_NAME = field;
      auto q = quantity(s.id, field);
      v.QUANTITY = q.kind;
      v.UNITS = q.unit;
      v.STATUS =
          s.id == 4 ? swsValueStatus::Estimated : swsValueStatus::RealTime;
      v.LOCATION = s.id <= 2   ? swsLocation::AtSpacecraft
                   : s.id == 3 ? swsLocation::PropagatedToEarth
                   : s.id <= 5 ? swsLocation::GroundNetwork
                               : swsLocation::EarthOrbit;
      auto platform = str(rows[0], "source");
      if (platform.empty() && rows[0].contains("satellite"))
        platform = str(rows[0], "satellite");
      if (!platform.empty())
        v.PLATFORMS = {platform};
      v.CADENCE_S = s.id == 2 ? 3600 : s.id == 5 ? 10800 : s.id >= 7 ? 300 : 60;
      v.SAMPLE_CONVENTION = swsSampleConvention::Unspecified;
      if (field.size() > 4 && (field.substr(field.size() - 4) == "_gse" ||
                               field.substr(field.size() - 4) == "_gsm" ||
                               field.substr(field.size() - 4) == "_gci")) {
        v.REFERENCE_FRAME = std::make_unique<RFMT>();
        auto frame = field.substr(field.size() - 3);
        std::transform(frame.begin(), frame.end(), frame.begin(), ::toupper);
        v.REFERENCE_FRAME->NAME = frame;
      }
      std::string energy = str(rows[0], "energy");
      if (s.id == 6) {
        double lo, hi;
        require(std::sscanf(energy.c_str(), "%lf-%lfnm", &lo, &hi) == 2,
                "Unknown X-ray band");
        v.PASSBAND_MIN_NM = lo;
        v.PASSBAND_MAX_NM = hi;
      }
      if (s.id == 7 || s.id == 8) {
        double e;
        require(std::sscanf(energy.c_str(), ">=%lf MeV", &e) == 1,
                "Unknown particle band");
        v.ENERGY_MIN_MEV = e;
      }
      // Exact categorical kp tokens are a one-hot flag column. No conversion of
      // thirds is guessed.
      for (const auto &f : flags)
        v.FLAG_NAMES.push_back(f);
      for (const auto &t : tokens)
        v.FLAG_NAMES.push_back("kp=" + t);
      for (const auto &r : rows) {
        auto t = epoch(str(r, "time_tag"));
        require(v.EPOCHS_MS.empty() || t >= v.EPOCHS_MS.back(),
                "Unsorted series epoch");
        v.EPOCHS_MS.push_back(t);
        require(r.contains(field), "Missing quantity column");
        v.VALUES.push_back(number(r[field]));
        if (r.contains("active")) {
          require(r["active"].is_boolean(), "Invalid active flag");
          v.ACTIVE.push_back(r["active"].get<bool>());
        }
        if (r.contains("overall_quality") && !r["overall_quality"].is_null())
          v.QUALITY.push_back(int(number(r["overall_quality"])));
        std::string samples = field.rfind("alpha_", 0) == 0
                                  ? "alpha_sample_size"
                              : s.id == 1 ? "proton_sample_size"
                                          : "sample_size";
        if (r.contains(samples) && !r[samples].is_null())
          v.SAMPLE_COUNTS.push_back(uint32_t(number(r[samples])));
        if (s.id == 3)
          v.PROPAGATED_EPOCHS_MS.push_back(
              epoch(str(r, "propagated_time_tag")));
        if (s.id == 5) {
          auto status = str(r, "observed");
          require(status == "observed" || status == "estimated" ||
                      status == "predicted",
                  "Unknown Kp status");
          v.SAMPLE_STATUS.push_back(
              status == "observed"    ? swsValueStatus::Nowcast
              : status == "estimated" ? swsValueStatus::Estimated
                                      : swsValueStatus::Predicted);
          auto scale = str(r, "noaa_scale");
          require(scale.empty() || (scale.size() == 2 && scale[0] == 'G' &&
                                    scale[1] >= '1' && scale[1] <= '5'),
                  "Unknown NOAA scale");
          v.NOAA_SCALE_KIND = swsNoaaScale::Geomagnetic;
          v.NOAA_SCALE_LEVELS.push_back(scale.empty() ? 0 : scale[1] - '0');
        }
      }
      // NOAA solar radiation scale: >=10 MeV integral proton flux, pfu.
      if (s.id == 7 && v.ENERGY_MIN_MEV == 10) {
        v.NOAA_SCALE_KIND = swsNoaaScale::SolarRadiation;
        for (double x : v.VALUES) {
          uint8_t level = 0;
          for (double threshold : {10., 100., 1000., 10000., 100000.})
            if (x >= threshold)
              ++level;
          v.NOAA_SCALE_LEVELS.push_back(level);
        }
      }
      if (v.QUALITY.size() != rows.size())
        v.QUALITY.clear();
      if (v.SAMPLE_COUNTS.size() != rows.size())
        v.SAMPLE_COUNTS.clear();
      for (const auto &f : flags)
        for (const auto &r : rows) {
          require(r.contains(f), "Missing flag column");
          v.FLAG_VALUES.push_back(number(r[f]));
        }
      for (const auto &t : tokens)
        for (const auto &r : rows)
          v.FLAG_VALUES.push_back(str(r, "kp") == t ? 1 : 0);
      flatbuffers::FlatBufferBuilder b;
      FinishSizePrefixedSWSBuffer(b, SWS::Pack(b, &v));
      append(out, b);
      ++count;
    }
  }
  return true;
}
std::string line(const std::string &text, const std::string &label) {
  auto p = text.find(label);
  if (p == std::string::npos)
    return "";
  p += label.size();
  while (p < text.size() && text[p] == ' ')
    p++;
  return text.substr(p, text.find_first_of("\r\n", p) - p);
}
std::string alertTime(const std::string &message, const std::string &label) {
  auto text = line(message, label);
  if (text.empty())
    return "";
  int y, d, hm;
  char mon[4] = {};
  if (std::sscanf(text.c_str(), "%d %3s %d %d UTC", &y, mon, &d, &hm) != 4)
    return "";
  auto at = std::string("JanFebMarAprMayJunJulAugSepOctNovDec").find(mon);
  if (at == std::string::npos)
    return "";
  char b[32];
  std::snprintf(b, sizeof(b), "%04d-%02u-%02dT%02d:%02d:00Z", y,
                unsigned(at / 3 + 1), d, hm / 100, hm % 100);
  epoch(b);
  return b;
}
bool alerts(const Source &s, Stream &out, uint64_t &count) {
  for (const auto &r : s.rows) {
    SWAT v;
    lineage(v, s);
    v.PRODUCT_ID = str(r, "product_id");
    v.ISSUED_AT = utc(str(r, "issue_datetime"));
    epoch(v.ISSUED_AT);
    v.MESSAGE = str(r, "message");
    require(!v.PRODUCT_ID.empty() && !v.MESSAGE.empty(),
            "Missing alert identity/text");
    v.MESSAGE_CODE = line(v.MESSAGE, "Space Weather Message Code:");
    v.SERIAL_NUMBER = line(v.MESSAGE, "Serial Number:");
    v.BEGIN_TIME = alertTime(v.MESSAGE, "Begin Time:");
    v.END_TIME = alertTime(v.MESSAGE, "End Time:");
    v.VALID_FROM = alertTime(v.MESSAGE, "Valid From:");
    v.VALID_TO = alertTime(v.MESSAGE, "Valid To:");
    for (const char *label :
         {"Continuation of Serial Number:", "Extension to Serial Number:",
          "Cancel Serial Number:"}) {
      auto ref = line(v.MESSAGE, label);
      if (!ref.empty())
        v.REFERS_TO_SERIAL = ref;
    }
    auto scale = line(v.MESSAGE, "NOAA Scale:");
    if (scale.empty())
      scale = line(v.MESSAGE, "Noaa Scale:");
    if (scale.size() >= 2 && scale[1] >= '1' && scale[1] <= '5') {
      v.SCALE_FAMILY = scale[0] == 'G'   ? swaScaleFamily::Geomagnetic
                       : scale[0] == 'S' ? swaScaleFamily::SolarRadiation
                       : scale[0] == 'R' ? swaScaleFamily::RadioBlackout
                                         : swaScaleFamily::None;
      if (v.SCALE_FAMILY != swaScaleFamily::None)
        v.SCALE_LEVEL = scale[1] - '0';
    }
    if (v.MESSAGE.find("CANCEL") != std::string::npos)
      v.KIND = swaMessageKind::Cancellation;
    else if (v.MESSAGE.find("WARNING:") != std::string::npos)
      v.KIND = swaMessageKind::Warning;
    else if (v.MESSAGE.find("WATCH:") != std::string::npos)
      v.KIND = swaMessageKind::Watch;
    else if (v.MESSAGE.find("ALERT:") != std::string::npos)
      v.KIND = swaMessageKind::Alert;
    else if (v.MESSAGE.find("SUMMARY:") != std::string::npos)
      v.KIND = swaMessageKind::Summary;
    flatbuffers::FlatBufferBuilder b;
    FinishSizePrefixedSWABuffer(b, SWA::Pack(b, &v));
    append(out, b);
    ++count;
  }
  return true;
}
// Preserve every source field in SDS 1.274.0; time_tag is retained in EVENT_ID.
bool flares(const Source &s, Stream &out, uint64_t &count) {
  for (const auto &r : s.rows) {
    require(r.is_object(), "Invalid flare row");
    const std::set<std::string> fields = {
        "time_tag",           "begin_time", "begin_class", "max_time",
        "max_class",          "max_xrlong", "max_ratio",   "max_ratio_time",
        "current_int_xrlong", "end_time",   "end_class",   "satellite"};
    require(r.size() == fields.size(), "Unexpected flare source fields");
    for (const auto &field : fields)
      require(r.contains(field), "Missing flare source field: " + field);
    SFET v;
    lineage(v, s);
    v.EVENT_ID = str(r, "satellite") + "/" + str(r, "time_tag");
    v.PRODUCT = name(s.id);
    v.PLATFORM = str(r, "satellite");
    v.EVENT_KIND = sfeEventKind::XRAY;
    v.BEGIN_TIME = str(r, "begin_time");
    v.PEAK_TIME = str(r, "max_time");
    v.END_TIME = str(r, "end_time");
    v.XRAY_CLASS = str(r, "max_class");
    v.PEAK_FLUX_W_M2 = number(r.at("max_xrlong"));
    v.INTEGRATED_FLUX_J_M2 = number(r.at("current_int_xrlong"));
    v.PASSBAND_MIN_NM = .1;
    v.PASSBAND_MAX_NM = .8;
    v.BEGIN_XRAY_CLASS = str(r, "begin_class");
    v.END_XRAY_CLASS = str(r, "end_class");
    v.PEAK_RATIO = number(r.at("max_ratio"));
    v.PEAK_RATIO_TIME = str(r, "max_ratio_time");
    flatbuffers::FlatBufferBuilder b;
    FinishSizePrefixedSFEBuffer(b, SFE::Pack(b, &v));
    append(out, b);
    ++count;
  }
  return true;
}
int push(const char *p, const char *schema, const char *id, const char *root,
         const flatbuffers::FlatBufferBuilder &b) {
  return plugin_push_output_ex(p, schema, id,
                               PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0,
                               0, b.GetBufferPointer(), b.GetSize());
}
int plan(int begin, int end) {
  require(plugin_get_input_count() == 1, "Exactly one tick");
  auto f = plugin_get_input_frame(0);
  flatbuffers::Verifier v(f->payload, f->payload_length);
  require(R::VerifyTimerTickBuffer(v), "Expected TICK");
  for (int i = begin; i < end; i++) {
    R::HttpRequestT r;
    r.METHOD = "GET";
    r.URL = url(i);
    r.TIMEOUT_MS = 90000;
    r.MAX_BYTES = 16777216;
    auto h = std::make_unique<R::HeaderT>();
    h->NAME = "if-modified-since";
    h->VALUE = "Thu, 01 Jan 1970 00:00:00 GMT";
    r.HEADERS.push_back(std::move(h));
    flatbuffers::FlatBufferBuilder b;
    R::FinishHttpRequestBuffer(b, R::HttpRequest::Pack(b, &r));
    require(push("request", "HttpRequest.fbs", "HREQ", "HttpRequest", b) >= 0,
            "Emit request");
  }
  return 0;
}
int parse(int begin, int end, const char *code) {
  require(plugin_get_input_count() == unsigned(end - begin),
          "Incomplete source batch");
  std::map<int, Source> sources;
  for (uint32_t i = 0; i < plugin_get_input_count(); i++) {
    auto f = plugin_get_input_frame(i);
    require(f && f->payload && f->payload_length <= 16842752,
            "Invalid response size");
    flatbuffers::Verifier v(f->payload, f->payload_length);
    require(R::VerifyHttpResponseBuffer(v), "Expected HRSP");
    auto h = R::GetHttpResponse(f->payload);
    int id = -1;
    for (int k = begin; k < end; k++)
      if (h->URL() && h->URL()->str() == url(k))
        id = k;
    require(id >= 0 && !sources.count(id), "Unknown/duplicate source");
    sources.emplace(id, read(id, h));
    if (!failure.empty())
      return 1;
  }
  Stream stream;
  uint64_t count = 0;
  std::string hashes;
  for (const auto &[i, s] : sources) {
    hashes += s.digest;
    if (i < 9)
      series(s, stream, count);
    else if (i == 9)
      alerts(s, stream, count);
    else
      flares(s, stream, count);
    if (!failure.empty())
      return 1;
  }
  R::IngestRequestT m;
  m.SCHEMA = std::string(code) + ".fbs";
  m.RECONCILE = R::reconcileMode_Current;
  m.TAGS = std::make_unique<R::SourceTagsT>();
  auto &t = *m.TAGS;
  t.PROVIDER_ID = "space-weather";
  t.SOURCE_NAME = "noaa-swpc-rt";
  t.BATCH_ID = ephem::sha256_hex(
      reinterpret_cast<const uint8_t *>(hashes.data()), hashes.size());
  t.SOURCE_URL = url(begin);
  t.LICENSE = "public-domain";
  t.LICENSE_URL = "https://www.weather.gov/disclaimer";
  t.CITATION = "NOAA Space Weather Prediction Center";
  m.PROVENANCE = std::make_unique<R::ProvenanceT>();
  m.PROVENANCE->PARSER = "swpc-realtime";
  m.PROVENANCE->PARSER_VERSION = "0.2.0";
  m.PROVENANCE->NORMALIZED_COUNT = count;
  m.PROVENANCE->SCHEMAS = {m.SCHEMA};
  m.PROVENANCE->SCHEMA_COUNTS = {count};
  flatbuffers::FlatBufferBuilder b;
  R::FinishIngestRequestBuffer(b, R::IngestRequest::Pack(b, &m));
  require(push("meta", "IngestRequest.fbs", "INGQ", "IngestRequest", b) >= 0,
          "Emit meta");
  std::string id = "$" + std::string(code);
  require(plugin_push_output_ex("records", m.SCHEMA.c_str(), id.c_str(),
                                PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, code, 0,
                                0, stream.data(), stream.size()) >= 0,
          "Emit records");
  return 0;
}
template <class F> int guard(F f) {
  plugin_reset_output_state();
  failure.clear();
  int rc = f();
  if (!failure.empty()) {
    plugin_reset_output_state();
    plugin_set_error("swpc-source", failure.c_str());
    return 1;
  }
  return rc;
}
} // namespace
extern "C" int plan_sws() {
  return guard([] { return plan(0, 9); });
}
extern "C" int plan_sfe() {
  return guard([] { return plan(10, 11); });
}
extern "C" int plan_swa() {
  return guard([] { return plan(9, 10); });
}
extern "C" int parse_sws() {
  return guard([] { return parse(0, 9, "SWS"); });
}
extern "C" int parse_swa() {
  return guard([] { return parse(9, 10, "SWA"); });
}
extern "C" int parse_sfe() {
  return guard([] { return parse(10, 11, "SFE"); });
}
