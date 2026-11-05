// data-source/space-infrastructure: worldwide space-surveillance and missile-warning sensor sites as SDS $SIT, and the sensors at them as $SNR.
//
//   plan_sources    a timer tick -> the HTTP GETs of the roster (src/roster.json): the Wikidata entities (wbgetentities, 40 per request),
//                   the MediaWiki extracts (and page coordinates) of the Wikipedia articles, one Overpass request for the OpenStreetMap
//                   elements the roster names by id
//   build_infrastructure  the HttpResponse (HRSP) of every request -> $SIT sites and $SNR sensors (size-prefixed streams), one $PVN per
//                   source system, FlowNotice reports (counts, refusals)
//
// UNKNOWN IS ABSENT. A site's position is read from the source document of the run (a Wikidata P625 claim, a MediaWiki page coordinate or an
// OSM element) and is checked against the other sources the roster names for the same place; a site whose position cannot be read or whose
// sources disagree by more than the roster's tolerance is not published, and the reason is reported. Every other value is a Claim: a verbatim
// quote that must occur in the fetched document of the run and the number in it. A stale quote stops that value, not the run. A positive
// quantity with no source is 0, a signed one NaN, an enum UNSPECIFIED, a table absent. Nothing is computed from a value that has no source;
// a computed value says so in NOTES.
//
// Typed contracts 1.0 (FlatBuffers only). Errors are flags (an invoke error code and message), never exceptions. The module has no network
// imports; the host executes the requests. Configuration: producer_peer_id (String, required), from plugin.getConfig through the typed $PIV bridge.
#include <HttpRequest_generated.h>
#include <HttpResponse_generated.h>
#include <TimerTick_generated.h>
#include <FlowNotice_generated.h>
#include <IngestRequest_generated.h>
#include <typedHostcall.hpp>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <functional>
#include <limits>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

namespace R = sdn::runtime;
namespace T = sensortext;
using Json = nlohmann::json;

namespace {

constexpr const char* kProvider = "space-infrastructure";
constexpr const char* kPluginId = "com.digitalarsenal.data-source.space-infrastructure";
constexpr const char* kVersion = "0.1.0";
constexpr size_t kMaxResponses = 200, kMaxBody = 16u * 1024u * 1024u, kMaxRecordBytes = 8191;
constexpr double kPi = 3.14159265358979323846, kEarthKm = 6371.0088;
constexpr double kNan = std::numeric_limits<double>::quiet_NaN();

constexpr const char* kWikiApi = "https://en.wikipedia.org/w/api.php?action=query&prop=revisions%7Cextracts%7Ccoordinates&rvprop=ids%7Ctimestamp&rvslots=main&explaintext=1&exsectionformat=plain&colimit=50&coprimary=all&format=json&redirects=1&titles=";
constexpr const char* kWikidataApi = "https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims%7Clabels%7Cdescriptions%7Cinfo&languages=en&ids=";
constexpr const char* kOverpass = "https://overpass-api.de/api/interpreter?data=";

struct Source {
  const char* id;          // PVN SOURCE_ID
  const char* name;        // SOURCE in a record's provenance
  const char* originator;
  const char* host_url;
  pvnLicenseClass klass;
  const char* license_id;  // SPDX
  const char* license;     // OPPProvenance LICENSE, verbatim terms
  const char* attribution;
};
const Source kWikidata = {"wikidata", "Wikidata", "Wikidata contributors", "https://www.wikidata.org/", pvnLicenseClass::Reproducible, "CC0-1.0",
                          "CC0-1.0 (Wikidata: structured data in the main, Property and Lexeme namespaces is available under the Creative Commons CC0 License)", "Wikidata contributors, Wikidata, CC0 1.0"};
const Source kWikipedia = {"wikipedia-extracts", "Wikipedia", "Wikipedia contributors", "https://en.wikipedia.org/", pvnLicenseClass::ShareAlike, "CC-BY-SA-4.0",
                           "CC-BY-SA-4.0", "Wikipedia contributors, Wikipedia, the free encyclopedia, CC BY-SA 4.0"};
const Source kOsm = {"openstreetmap", "OpenStreetMap", "OpenStreetMap contributors", "https://www.openstreetmap.org/", pvnLicenseClass::ShareAlike, "ODbL-1.0",
                     "ODbL-1.0 (Open Data Commons Open Database License; https://www.openstreetmap.org/copyright)", "(c) OpenStreetMap contributors, ODbL 1.0"};

int fail(const char* code, const std::string& message) {
  plugin_set_error(code, message.c_str());
  return 1;
}

std::string url_encode(const std::string& s) {
  static const char* hex = "0123456789ABCDEF";
  std::string out;
  for (unsigned char c : s) {
    if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') out += static_cast<char>(c);
    else { out += '%'; out += hex[c >> 4]; out += hex[c & 15]; }
  }
  return out;
}

std::string rfc3339_ms(uint64_t ms) { return sdn_time::format_iso_micro(static_cast<int64_t>(ms) * 1000).substr(0, 23) + "Z"; }

int push(const char* port, const char* schema, const char* identifier, const char* root, const uint8_t* data, size_t size) {
  return plugin_push_output_ex(port, schema, identifier, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0, data, size);
}

std::vector<const plugin_input_frame_t*> frames(const char* port) {
  std::vector<const plugin_input_frame_t*> result;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* f = plugin_get_input_frame(i);
    if (f && f->port_id && std::strcmp(f->port_id, port) == 0) result.push_back(f);
  }
  return result;
}

std::string clip(const std::string& s, size_t n) { return s.size() <= n ? s : s.substr(0, n) + "..."; }

// ---- The roster (src/roster.json, embedded by build.mjs as roster_data.hpp).
struct Claim {
  std::string f, doc, q, n, name, des, desq, e;
  double s = 1, v = kNan;
  int i = 0;
};

Claim read_claim(const Json& j) {
  Claim c;
  c.f = j.value("f", std::string());
  c.doc = j.value("doc", std::string());
  c.q = j.value("q", std::string());
  c.n = j.value("n", std::string());
  c.name = j.value("name", std::string());
  c.des = j.value("des", std::string());
  c.desq = j.value("desq", std::string());
  c.e = j.value("e", std::string());
  c.s = j.value("s", 1.0);
  c.i = j.value("i", 0);
  if (j.contains("v") && j["v"].is_number()) c.v = j["v"].get<double>();
  return c;
}

std::vector<Claim> read_claims(const Json& j, const char* key) {
  std::vector<Claim> out;
  if (j.contains(key) && j[key].is_array()) for (const auto& c : j[key]) out.push_back(read_claim(c));
  return out;
}

// ---- Documents of the run.
struct Doc {
  bool ok = false;
  std::string error, body, text, sha256, version;
  uint64_t retrieved_ms = 0;
  const Source* source = nullptr;
  std::string record_id, url;
};

struct Position {
  bool ok = false;
  double lat = 0, lon = 0, precision_deg = 0;
  std::string doc, field, source_record, source_url, note;
};

struct Element {
  std::string key;  // n123, w456, r789
  double lat = 0, lon = 0;
  bool has_position = false;
  std::map<std::string, std::string> tags;
};

struct WikiPage {
  std::string title, extract, revid, timestamp;
  bool has_coordinates = false;  // a primary coordinate
  double lat = 0, lon = 0;
  std::vector<std::pair<double, double>> all;  // every coordinate tag of the page, in page order
};

bool read_wiki(const std::string& body, WikiPage* w) {
  const Json j = Json::parse(body, nullptr, false);
  if (j.is_discarded() || !j.contains("query") || !j["query"].contains("pages") || !j["query"]["pages"].is_object() || j["query"]["pages"].size() != 1) return false;
  const Json& page = j["query"]["pages"].begin().value();
  if (!page.is_object() || !page.contains("extract") || !page["extract"].is_string() || !page.contains("revisions") || !page["revisions"].is_array() || page["revisions"].empty()) return false;
  w->title = page.value("title", std::string());
  w->extract = T::collapse(page["extract"].get<std::string>());
  w->revid = std::to_string(page["revisions"][0].value("revid", 0LL));
  w->timestamp = page["revisions"][0].value("timestamp", std::string());
  if (page.contains("coordinates") && page["coordinates"].is_array()) {
    for (const auto& c : page["coordinates"]) {
      if (!c.contains("lat") || !c.contains("lon") || !c["lat"].is_number() || !c["lon"].is_number() || c.value("globe", std::string("earth")) != "earth") continue;
      w->all.push_back({c["lat"].get<double>(), c["lon"].get<double>()});
      if (c.contains("primary") && !w->has_coordinates) { w->has_coordinates = true; w->lat = c["lat"].get<double>(); w->lon = c["lon"].get<double>(); }
    }
  }
  return !w->extract.empty() && w->revid != "0";
}

double haversine_km(double lat1, double lon1, double lat2, double lon2) {
  const double r = kPi / 180.0;
  const double dlat = (lat2 - lat1) * r, dlon = (lon2 - lon1) * r;
  const double a = std::sin(dlat / 2) * std::sin(dlat / 2) + std::cos(lat1 * r) * std::cos(lat2 * r) * std::sin(dlon / 2) * std::sin(dlon / 2);
  return 2 * kEarthKm * std::asin(std::min(1.0, std::sqrt(a)));
}

std::string fixed(double v, int digits) {
  char buf[48];
  std::snprintf(buf, sizeof(buf), "%.*f", digits, v);
  return buf;
}

// ---- Enum names from the roster.
SensorType sensor_type_of(const std::string& name, bool* ok) {
  for (int i = 0; i <= static_cast<int>(SensorType::UNSPECIFIED); ++i) {
    const char* n = EnumNameSensorType(static_cast<SensorType>(i));
    if (n && name == n) { *ok = true; return static_cast<SensorType>(i); }
  }
  *ok = false;
  return SensorType::UNSPECIFIED;
}
snrEmissionMode emission_of_name(const std::string& name, bool* ok) {
  for (int i = 0; i <= 2; ++i) if (name == EnumNamesnrEmissionMode(static_cast<snrEmissionMode>(i))) { *ok = true; return static_cast<snrEmissionMode>(i); }
  *ok = false;
  return snrEmissionMode::UNSPECIFIED;
}
snrBandDirection direction_of_name(const std::string& name, bool* ok) {
  for (int i = 0; i <= 3; ++i) if (name == EnumNamesnrBandDirection(static_cast<snrBandDirection>(i))) { *ok = true; return static_cast<snrBandDirection>(i); }
  *ok = false;
  return snrBandDirection::UNSPECIFIED;
}
snrPointingMode pointing_of_name(const std::string& name, bool* ok) {
  for (int i = 0; i <= 4; ++i) if (name == EnumNamesnrPointingMode(static_cast<snrPointingMode>(i))) { *ok = true; return static_cast<snrPointingMode>(i); }
  *ok = false;
  return snrPointingMode::UNSPECIFIED;
}
SiteType site_type_of(const std::string& name, bool* ok) {
  for (int i = 0; i <= static_cast<int>(SiteType::SURFACE_FEATURE); ++i) if (name == EnumNameSiteType(static_cast<SiteType>(i))) { *ok = true; return static_cast<SiteType>(i); }
  *ok = false;
  return SiteType::OTHER;
}
siteLifecycleStatus lifecycle_of_name(const std::string& name, bool* ok) {
  for (int i = 0; i <= static_cast<int>(siteLifecycleStatus::UNVERIFIED); ++i) if (name == EnumNamesiteLifecycleStatus(static_cast<siteLifecycleStatus>(i))) { *ok = true; return static_cast<siteLifecycleStatus>(i); }
  *ok = false;
  return siteLifecycleStatus::UNSPECIFIED;
}

snrEmissionMode emission_by_type(SensorType t) {
  switch (t) {
    case SensorType::RADAR_PULSE: case SensorType::RADAR_DOPPLER: case SensorType::RADAR_CW: case SensorType::RADAR_AESA: case SensorType::RADAR_PESA:
    case SensorType::LASER_DESIGNATOR: case SensorType::LASER_RANGEFINDER: case SensorType::SONAR_ACTIVE: case SensorType::SAR: case SensorType::ALTIMETER:
    case SensorType::SCATTEROMETER: case SensorType::LIDAR: case SensorType::PHASED_ARRAY_EARLY_WARNING:
      return snrEmissionMode::ACTIVE;
    case SensorType::IR_SEARCH: case SensorType::IR_IMAGING: case SensorType::EO_TV: case SensorType::EO_LLLTV: case SensorType::RWR: case SensorType::MAW:
    case SensorType::SONAR_PASSIVE: case SensorType::ACOUSTIC: case SensorType::OPTICAL_TELESCOPE: case SensorType::MULTISPECTRAL_IMAGER:
    case SensorType::HYPERSPECTRAL_IMAGER: case SensorType::RADIOMETER: case SensorType::PASSIVE_RF_ESM: case SensorType::SIGINT:
      return snrEmissionMode::PASSIVE;
    default:
      return snrEmissionMode::UNSPECIFIED;
  }
}

// ---- Claims, verified against the documents of the run.
struct Verified {
  double value = kNan;
  std::string quote, doc;
};

struct Run {
  std::map<std::string, Doc> docs;           // by document key (wp:Title, wd:Q1, osm:n1)
  std::map<std::string, Element> elements;   // by osm key
  std::map<std::string, Json> entities;      // by QID
  std::map<std::string, WikiPage> pages;     // by title
  std::vector<std::string> missing;          // reports
  size_t verified = 0, refused = 0;
  std::set<std::string> used_sources;        // per record scratch
};

bool verify(Run& run, const Claim& c, const std::string& context, Verified* out) {
  const auto it = run.docs.find(c.doc);
  if (it == run.docs.end() || !it->second.ok) {
    ++run.refused;
    run.missing.push_back(context + ": document " + c.doc + " unavailable");
    return false;
  }
  const std::string quote = T::collapse(c.q);
  if (quote.empty() || it->second.text.find(quote) == std::string::npos) {
    ++run.refused;
    run.missing.push_back(context + ": quote not found in " + c.doc + ": " + clip(c.q, 100));
    return false;
  }
  out->quote = quote;
  out->doc = c.doc;
  if (!c.n.empty()) {
    double v = 0;
    if (quote.find(c.n) == std::string::npos || !T::read_number(c.n, &v, nullptr)) {
      ++run.refused;
      run.missing.push_back(context + ": number " + c.n + " is not in its quote: " + clip(c.q, 100));
      return false;
    }
    out->value = v * c.s;
  } else {
    out->value = c.v;
  }
  ++run.verified;
  return true;
}

// ---- Provenance builders.
using OppProvenance = std::unique_ptr<OPPProvenanceT>;

OppProvenance opp(const Doc& d, const std::string& notes) {
  auto p = std::make_unique<OPPProvenanceT>();
  p->SOURCE = d.source->name;
  p->SOURCE_RECORD_ID = d.record_id;
  p->SOURCE_URL = d.url;
  p->RETRIEVED_AT = rfc3339_ms(d.retrieved_ms);
  p->SOURCE_VERSION = d.version;
  p->METHOD = oppDeterminationMethod::UNSPECIFIED;  // the source publishes the value without stating how it was obtained
  p->LICENSE = d.source->license;
  p->ATTRIBUTION = d.source->attribution;
  p->SOURCE_SHA256 = d.sha256;
  p->NOTES = notes;
  return p;
}

std::unique_ptr<PVNT> pvn_of(const Doc& d) {
  auto p = std::make_unique<PVNT>();
  p->SOURCE_ID = d.source->id;
  p->SOURCE_KIND = pvnSourceKind::Reference;
  p->ORIGINATOR = d.source->originator;
  p->PROVIDER_ID = kProvider;
  p->PRODUCER = std::string(kPluginId) + " " + kVersion;
  p->LICENSE_CLASS = d.source->klass;
  p->LICENSE_ID = d.source->license_id;
  p->LINEAGE = d.source->id;
  p->SOURCE_URL = d.url;
  p->SOURCE_VERSION = d.version;
  p->RETRIEVED_AT = rfc3339_ms(d.retrieved_ms);
  p->SOURCE_SHA256 = d.sha256;
  return p;
}

std::unique_ptr<SITCitationT> citation(const Doc& d, const std::string& field) {
  auto c = std::make_unique<SITCitationT>();
  c->PROVENANCE = pvn_of(d);
  c->SOURCE_RECORD_ID = d.record_id;
  c->SOURCE_URL = d.url;
  c->SOURCE_VERSION = d.version;
  c->SOURCE_FIELD = field;
  c->RETRIEVED_AT = rfc3339_ms(d.retrieved_ms);
  return c;
}

// A record-level PVN: the strictest of the sources the record used (the licence ids joined), the newest retrieval.
std::unique_ptr<PVNT> record_pvn(const std::vector<const Doc*>& used) {
  auto p = std::make_unique<PVNT>();
  p->SOURCE_KIND = pvnSourceKind::Reference;
  p->PROVIDER_ID = kProvider;
  p->PRODUCER = std::string(kPluginId) + " " + kVersion;
  std::set<std::string> ids, originators, licenses;
  uint64_t latest = 0;
  pvnLicenseClass klass = pvnLicenseClass::Reproducible;
  for (const Doc* d : used) {
    if (!ids.insert(d->source->id).second) { latest = std::max(latest, d->retrieved_ms); continue; }
    originators.insert(d->source->originator);
    licenses.insert(d->source->license_id);
    latest = std::max(latest, d->retrieved_ms);
    if (d->source->klass == pvnLicenseClass::ShareAlike) klass = pvnLicenseClass::ShareAlike;
  }
  auto join = [](const std::set<std::string>& s, const char* sep) { std::string out; for (const auto& x : s) out += (out.empty() ? "" : sep) + x; return out; };
  p->SOURCE_ID = join(ids, "+");
  p->ORIGINATOR = join(originators, "; ");
  p->LICENSE_CLASS = klass;
  p->LICENSE_ID = join(licenses, " AND ");
  p->LINEAGE = join(ids, "+");
  p->RETRIEVED_AT = rfc3339_ms(latest);
  return p;
}

// ---- Wikidata: P625 of an entity.
bool wikidata_position(const Json& entity, Position* p) {
  if (!entity.contains("claims") || !entity["claims"].contains("P625") || !entity["claims"]["P625"].is_array()) return false;
  const Json* best = nullptr;
  for (const auto& c : entity["claims"]["P625"]) {
    if (!c.contains("mainsnak") || !c["mainsnak"].contains("datavalue")) continue;
    const std::string rank = c.value("rank", std::string("normal"));
    if (rank == "deprecated") continue;
    if (!best || rank == "preferred") best = &c;
  }
  if (!best) return false;
  const Json& v = (*best)["mainsnak"]["datavalue"]["value"];
  if (!v.is_object() || !v.contains("latitude") || !v.contains("longitude") || v.value("globe", std::string()) != "http://www.wikidata.org/entity/Q2") return false;
  p->lat = v["latitude"].get<double>();
  p->lon = v["longitude"].get<double>();
  p->precision_deg = v.contains("precision") && v["precision"].is_number() ? v["precision"].get<double>() : 0;
  return true;
}

bool wikidata_quantity(const Json& entity, const char* property, double* value) {
  if (!entity.contains("claims") || !entity["claims"].contains(property) || !entity["claims"][property].is_array()) return false;
  for (const auto& c : entity["claims"][property]) {
    if (!c.contains("mainsnak") || !c["mainsnak"].contains("datavalue") || c.value("rank", std::string("normal")) == "deprecated") continue;
    const Json& v = c["mainsnak"]["datavalue"]["value"];
    if (!v.is_object() || !v.contains("amount") || !v["amount"].is_string()) continue;
    if (v.value("unit", std::string()) != "http://www.wikidata.org/entity/Q11573") continue;  // metre
    char* end = nullptr;
    *value = std::strtod(v["amount"].get<std::string>().c_str(), &end);
    return end && *end == '\0' && std::isfinite(*value);
  }
  return false;
}

// Degrees from a coordinate written in a quote: "43\xC2\xB049\xE2\x80\xB234\xE2\x80\xB3N 41\xC2\xB020\xE2\x80\xB235\xE2\x80\xB3E" or "43.7169171\xC2\xB0N 41.2316883\xC2\xB0E". The first N/S group is the latitude, the first E/W group the longitude.
bool parse_coordinates(const std::string& s, double* lat, double* lon) {
  bool have_lat = false, have_lon = false;
  size_t i = 0;
  while (i < s.size()) {
    if (!std::isdigit(static_cast<unsigned char>(s[i]))) { ++i; continue; }
    double comp[3] = {0, 0, 0};
    int n = 0;
    size_t j = i;
    bool group = false;
    char hemi = 0;
    while (j < s.size() && n < 3) {
      std::string num;
      size_t k = j;
      while (k < s.size() && (std::isdigit(static_cast<unsigned char>(s[k])) || s[k] == '.')) num += s[k++];
      if (num.empty()) break;
      comp[n++] = std::strtod(num.c_str(), nullptr);
      j = k;
      if (s.compare(j, 2, "\xC2\xB0") == 0) j += 2;
      else if (s.compare(j, 3, "\xE2\x80\xB2") == 0 || s.compare(j, 3, "\xE2\x80\xB3") == 0) j += 3;
      else if (j < s.size() && (s[j] == '\'' || s[j] == '"')) j += 1;
      while (j < s.size() && s[j] == ' ') ++j;
      if (j < s.size() && (s[j] == 'N' || s[j] == 'S' || s[j] == 'E' || s[j] == 'W')) { group = true; hemi = s[j]; ++j; break; }
    }
    if (!group) { while (i < s.size() && (std::isdigit(static_cast<unsigned char>(s[i])) || s[i] == '.')) ++i; continue; }
    double value = comp[0] + comp[1] / 60.0 + comp[2] / 3600.0;
    if (hemi == 'S' || hemi == 'W') value = -value;
    if ((hemi == 'N' || hemi == 'S') && !have_lat) { *lat = value; have_lat = true; }
    else if ((hemi == 'E' || hemi == 'W') && !have_lon) { *lon = value; have_lon = true; }
    i = j;
  }
  return have_lat && have_lon && std::fabs(*lat) <= 90 && std::fabs(*lon) <= 180;
}

// ---- The roster, read once.
struct SensorRoster {
  std::string id, name;
  std::vector<Claim> claims;
};
struct CheckRoster { std::string src, ref, q; double km = 0; };
struct PlatformRoster { std::string id, name, ctr; std::vector<Claim> claims; };
struct SiteRoster {
  std::string id, name, abbreviation, ctr, site_type, wikidata, enwiki, osm, network_name, lifecycle;
  std::string pos_src, pos_ref, pos_denotes, pos_q, near_src, near_ref;
  double near_km = 0;
  std::vector<CheckRoster> checks;
  std::vector<Claim> identity;  // operator, kind, network, established, status: the f says which
  std::vector<SensorRoster> sensors;
  std::string status_value, status_date;
};

}  // namespace

namespace {

std::vector<PlatformRoster> g_platforms;

std::vector<SiteRoster> read_roster(std::string* error) {
  std::vector<SiteRoster> sites;
  const Json j = Json::parse(kRosterJson, nullptr, false);
  if (j.is_discarded() || !j.contains("sites") || !j["sites"].is_array()) { *error = "the compiled roster is not valid JSON"; return sites; }
  g_platforms.clear();
  if (j.contains("platforms") && j["platforms"].is_array()) {
    for (const auto& x : j["platforms"]) {
      PlatformRoster pr;
      pr.id = x.value("id", std::string());
      pr.name = x.value("name", std::string());
      pr.ctr = x.value("ctr", std::string());
      pr.claims = read_claims(x, "claims");
      g_platforms.push_back(std::move(pr));
    }
  }
  for (const auto& s : j["sites"]) {
    SiteRoster r;
    r.id = s.value("id", std::string());
    r.name = s.value("name", std::string());
    r.abbreviation = s.value("abbr", std::string());
    r.ctr = s.value("ctr", std::string());
    r.site_type = s.value("siteType", std::string("OBSERVATION_STATION"));
    if (s.contains("refs")) {
      r.wikidata = s["refs"].value("wikidata", std::string());
      r.enwiki = s["refs"].value("enwiki", std::string());
      r.osm = s["refs"].value("osm", std::string());
    }
    if (s.contains("pos")) { r.pos_src = s["pos"].value("src", std::string()); r.pos_ref = s["pos"].value("ref", std::string()); r.pos_denotes = s["pos"].value("denotes", std::string()); r.pos_q = s["pos"].value("q", std::string());
      if (s["pos"].contains("near")) { r.near_src = s["pos"]["near"].value("src", std::string()); r.near_ref = s["pos"]["near"].value("ref", std::string()); r.near_km = s["pos"]["near"].value("km", 0.0); } }
    if (s.contains("checks") && s["checks"].is_array()) for (const auto& c : s["checks"]) r.checks.push_back({c.value("src", std::string()), c.value("ref", std::string()), c.value("q", std::string()), c.value("km", 0.0)});
    r.identity = read_claims(s, "claims");
    if (s.contains("sensors") && s["sensors"].is_array()) {
      for (const auto& x : s["sensors"]) {
        SensorRoster sr;
        sr.id = x.value("id", std::string());
        sr.name = x.value("name", std::string());
        sr.claims = read_claims(x, "claims");
        r.sensors.push_back(std::move(sr));
      }
    }
    if (r.id.empty() || r.name.empty() || r.pos_src.empty() || r.pos_ref.empty()) { *error = "a roster site lacks id, name or position: " + r.id; return sites; }
    sites.push_back(std::move(r));
  }
  return sites;
}

std::string wiki_doc(const std::string& title) { return "wp:" + title; }
std::string wd_doc(const std::string& qid) { return "wd:" + qid; }
std::string osm_doc(const std::string& key) { return "osm:" + key; }

// "wp:Title" -> Title; "osm:w123" -> w123.
std::string after_colon(const std::string& doc) { const size_t c = doc.find(':'); return c == std::string::npos ? doc : doc.substr(c + 1); }

std::string wiki_url(const std::string& title) { return kWikiApi + url_encode(title); }

// The documents the roster needs: a set of keys.
void need_docs(const std::vector<SiteRoster>& sites, std::set<std::string>* keys) {
  for (const auto& p : g_platforms) for (const auto& c : p.claims) if (!c.doc.empty()) keys->insert(c.doc);
  auto add_ref = [&](const std::string& src, const std::string& ref) {
    if (ref.empty()) return;
    if (src == "wikidata") keys->insert(wd_doc(ref));
    else if (src == "wikipedia") keys->insert(wiki_doc(ref));
    else if (src == "osm") keys->insert(osm_doc(ref));
    else if (src == "text") keys->insert(ref);
  };
  for (const auto& s : sites) {
    add_ref(s.pos_src == "wikipedia-near" ? "wikipedia" : s.pos_src, s.pos_ref);
    add_ref(s.near_src, s.near_ref);
    for (const auto& c : s.checks) add_ref(c.src, c.ref);
    add_ref("wikidata", s.wikidata);
    add_ref("wikipedia", s.enwiki);
    add_ref("osm", s.osm);
    for (const auto& c : s.identity) if (!c.doc.empty()) keys->insert(c.doc);
    for (const auto& x : s.sensors) for (const auto& c : x.claims) if (!c.doc.empty()) keys->insert(c.doc);
  }
}

// Overpass request for the OSM keys (n123/w456/r789).
std::string overpass_url(const std::vector<std::string>& osm_keys) {
  std::string nodes, ways, rels;
  for (const auto& k : osm_keys) {
    std::string* list = k[0] == 'n' ? &nodes : k[0] == 'w' ? &ways : &rels;
    *list += (list->empty() ? "" : ",") + k.substr(1);
  }
  std::string q = "[out:json][timeout:90];(";
  if (!nodes.empty()) q += "node(id:" + nodes + ");";
  if (!ways.empty()) q += "way(id:" + ways + ");";
  if (!rels.empty()) q += "relation(id:" + rels + ");";
  q += ");out tags center;";
  return kOverpass + url_encode(q);
}

struct Plan {
  std::vector<std::string> wikidata_urls, wiki_urls;
  std::string osm_url;
  std::vector<std::string> wikidata_ids, osm_keys, titles;
};

Plan plan_of(const std::set<std::string>& keys) {
  Plan p;
  for (const auto& k : keys) {
    if (k.compare(0, 3, "wd:") == 0) p.wikidata_ids.push_back(k.substr(3));
    else if (k.compare(0, 3, "wp:") == 0) p.titles.push_back(k.substr(3));
    else if (k.compare(0, 4, "osm:") == 0) p.osm_keys.push_back(k.substr(4));
  }
  for (size_t i = 0; i < p.wikidata_ids.size(); i += 40) {
    std::string ids;
    for (size_t j = i; j < std::min(p.wikidata_ids.size(), i + 40); ++j) ids += (ids.empty() ? "" : "%7C") + p.wikidata_ids[j];
    p.wikidata_urls.push_back(kWikidataApi + ids);
  }
  for (const auto& t : p.titles) p.wiki_urls.push_back(wiki_url(t));
  if (!p.osm_keys.empty()) p.osm_url = overpass_url(p.osm_keys);
  return p;
}

// ---- The spec of one sensor, from its verified claims.
struct InfraBand { std::string name, designation; double low = 0, high = 0, centre = 0, width = 0; bool named = false, derived = false; snrBandDirection direction = snrBandDirection::UNSPECIFIED; std::string doc; };
struct Spec {
  SensorType type = SensorType::UNSPECIFIED;
  snrEmissionMode emission = snrEmissionMode::UNSPECIFIED;
  std::vector<InfraBand> bands;
  double rf_bandwidth = 0, rf_power = 0, beam_az = 0, beam_el = 0, gain = kNan, prf = 0, cone = 0, max_range = 0;
  double bore_az = kNan, bore_el = kNan, az_min = kNan, az_max = kNan, el_min = kNan, el_max = kNan, aperture = 0, focal = 0, limiting = kNan;
  snrPointingMode pointing = snrPointingMode::UNSPECIFIED;
  bool has_cone = false;
  std::vector<std::pair<std::string, std::string>> quotes;  // (doc, quote), in order, no repeats
  std::set<std::string> docs_mount, docs_rf, docs_optical, docs_fov, docs_all;
  size_t verified = 0, refused = 0;
};

void keep_quote(Spec* s, const std::string& doc, const std::string& q) {
  for (const auto& e : s->quotes) if (e.first == doc && e.second == q) return;
  s->quotes.push_back({doc, q});
}

InfraBand& band_at(Spec* s, int i) {
  if (i < 0) i = 0;
  while (static_cast<int>(s->bands.size()) <= i) s->bands.emplace_back();
  return s->bands[i];
}

void apply_claims(Run& run, const std::string& context, const std::vector<Claim>& claims, Spec* s) {
  for (const auto& c : claims) {
    Verified v;
    if (!verify(run, c, context, &v)) { ++s->refused; continue; }
    ++s->verified;
    keep_quote(s, v.doc, v.quote);
    s->docs_all.insert(v.doc);
    bool ok = true;
    const std::string& f = c.f;
    if (f == "type") { s->type = sensor_type_of(c.e, &ok); }
    else if (f == "emission") { s->emission = emission_of_name(c.e, &ok); }
    else if (f == "band") {
      InfraBand& b = band_at(s, c.i);
      b.name = c.name; b.named = true; b.doc = v.doc;
      if (!c.des.empty()) {
        // des is an $RFB rfBandDesignation spelling; desq is the exact words of the quote that state it ("L-band", "ultra high frequency (UHF)").
        static const char* allowed[] = {"UHF", "L", "S", "C", "X", "KU", "K", "KA", "V", "W", "Q", "EHF", "VHF", "HF", "MF", "LF", "VLF", "SHF", "OTHER"};
        bool known = false;
        for (const char* a : allowed) known = known || c.des == a;
        if (known && !c.desq.empty() && v.quote.find(T::collapse(c.desq)) != std::string::npos) b.designation = c.des;
        else ok = false;
      }
      if (!c.e.empty()) b.direction = direction_of_name(c.e, &ok);
    }
    else if (f == "band_low_hz") band_at(s, c.i).low = v.value;
    else if (f == "band_high_hz") band_at(s, c.i).high = v.value;
    else if (f == "band_center_hz") band_at(s, c.i).centre = v.value;
    else if (f == "band_width_hz") band_at(s, c.i).width = v.value;
    else if (f == "rf_bandwidth_hz") { s->rf_bandwidth = v.value; s->docs_rf.insert(v.doc); }
    else if (f == "peak_power_w") { s->rf_power = v.value; s->docs_rf.insert(v.doc); }
    else if (f == "beamwidth_az_deg") { s->beam_az = v.value; s->docs_rf.insert(v.doc); }
    else if (f == "beamwidth_el_deg") { s->beam_el = v.value; s->docs_rf.insert(v.doc); }
    else if (f == "gain_dbi") { s->gain = v.value; s->docs_rf.insert(v.doc); }
    else if (f == "prf_hz") { s->prf = v.value; s->docs_rf.insert(v.doc); }
    else if (f == "boresight_az_deg") { s->bore_az = v.value; s->docs_mount.insert(v.doc); }
    else if (f == "boresight_el_deg") { s->bore_el = v.value; s->docs_mount.insert(v.doc); }
    else if (f == "az_limit_min_deg") { s->az_min = v.value; s->docs_mount.insert(v.doc); }
    else if (f == "az_limit_max_deg") { s->az_max = v.value; s->docs_mount.insert(v.doc); }
    else if (f == "el_limit_min_deg") { s->el_min = v.value; s->docs_mount.insert(v.doc); }
    else if (f == "el_limit_max_deg") { s->el_max = v.value; s->docs_mount.insert(v.doc); }
    else if (f == "pointing") { s->pointing = pointing_of_name(c.e, &ok); s->docs_mount.insert(v.doc); }
    else if (f == "cone_half_angle_deg") { s->cone = v.value; s->has_cone = true; s->docs_fov.insert(v.doc); }
    else if (f == "max_range_m") { s->max_range = v.value; s->docs_fov.insert(v.doc); }
    else if (f == "aperture_m") { s->aperture = v.value; s->docs_optical.insert(v.doc); }
    else if (f == "focal_length_m") { s->focal = v.value; s->docs_optical.insert(v.doc); }
    else if (f == "note") { /* a verified quote kept in NOTES; no structured field */ }
    else if (f == "limiting_magnitude") { s->limiting = v.value; s->docs_optical.insert(v.doc); }
    else ok = false;
    if (!ok) { ++run.refused; run.missing.push_back(context + ": claim field/value not understood: " + f + " " + c.e); --run.verified; }
  }
  for (auto& b : s->bands) {
    if (b.low > 0 && b.high >= b.low) continue;
    if (b.centre > 0 && b.width > 0) { b.low = b.centre - b.width / 2; b.high = b.centre + b.width / 2; b.derived = true; }
    else if (b.centre > 0) b.low = b.high = b.centre;
  }
}

constexpr double kC = 299792458.0;

bool pack_snr(SNRT& s, const Spec& spec, const Doc& primary, const std::map<std::string, const Doc*>& by_doc, std::string* error, std::vector<uint8_t>* bytes) {
  s.TYPE = spec.type;
  s.EMISSION = spec.emission != snrEmissionMode::UNSPECIFIED ? spec.emission : emission_by_type(spec.type);
  for (const auto& b : spec.bands) {
    auto band = std::make_unique<SNRSpectralBandT>();
    band->NAME = b.name;
    band->DESIGNATION = b.designation;
    band->FREQ_LOW_HZ = b.low;
    band->FREQ_HIGH_HZ = b.high;
    band->DIRECTION = b.direction != snrBandDirection::UNSPECIFIED ? b.direction : (s.EMISSION == snrEmissionMode::PASSIVE ? snrBandDirection::RECEIVE : snrBandDirection::UNSPECIFIED);
    if (!b.doc.empty() && b.doc != "wp:" + primary.record_id) {
      const auto it = by_doc.find(b.doc);
      if (it != by_doc.end() && it->second != &primary) band->PROVENANCE = opp(*it->second, "InfraBand read from the quote in NOTES.");
    }
    s.SPECTRAL_BANDS.push_back(std::move(band));
  }
  (void)kC;
  auto section_prov = [&](const std::set<std::string>& docs) -> OppProvenance {
    if (docs.empty()) return nullptr;
    const std::string first = *docs.begin();
    const auto it = by_doc.find(first);
    if (it == by_doc.end() || it->second == &primary) return nullptr;
    return opp(*it->second, "Values read from the quotes in NOTES.");
  };
  if (spec.has_cone) {
    auto fov = std::make_unique<SCVSensorShapeContractT>();
    if (spec.has_cone) { fov->SHAPE_KIND = scvSensorShapeKind::CONIC; fov->OUTER_HALF_ANGLE_DEG = spec.cone; }
    fov->MAX_RANGE_M = spec.max_range;
    s.FIELD_OF_VIEW = std::move(fov);
    s.FIELD_OF_VIEW_PROVENANCE = section_prov(spec.docs_fov);
  }
  const bool mount = !std::isnan(spec.bore_az) || !std::isnan(spec.bore_el) || !std::isnan(spec.az_min) || !std::isnan(spec.az_max) || !std::isnan(spec.el_min) || !std::isnan(spec.el_max) ||
                     spec.pointing != snrPointingMode::UNSPECIFIED;
  if (mount) {
    auto m = std::make_unique<SNRMountingT>();
    m->FRAME = snrMountingFrame::LOCAL_ENU;
    m->BORESIGHT_AZIMUTH_DEG = spec.bore_az;
    m->BORESIGHT_ELEVATION_DEG = spec.bore_el;
    m->AZIMUTH_LIMIT_MIN_DEG = spec.az_min;
    m->AZIMUTH_LIMIT_MAX_DEG = spec.az_max;
    m->ELEVATION_LIMIT_MIN_DEG = spec.el_min;
    m->ELEVATION_LIMIT_MAX_DEG = spec.el_max;
    m->POINTING = spec.pointing;
    m->PROVENANCE = section_prov(spec.docs_mount);
    s.MOUNTING = std::move(m);
  }
  if (spec.rf_bandwidth > 0 || spec.rf_power > 0 || spec.beam_az > 0 || spec.beam_el > 0 || !std::isnan(spec.gain) || spec.prf > 0) {
    auto rf = std::make_unique<SNRRfParametersT>();
    rf->PEAK_POWER_W = spec.rf_power;
    rf->BANDWIDTH_HZ = spec.rf_bandwidth;
    rf->BEAMWIDTH_AZIMUTH_DEG = spec.beam_az;
    rf->BEAMWIDTH_ELEVATION_DEG = spec.beam_el;
    rf->ANTENNA_GAIN_DBI = spec.gain;
    rf->PRF_HZ = spec.prf;
    rf->PROVENANCE = section_prov(spec.docs_rf);
    s.RF = std::move(rf);
  }
  if (spec.aperture > 0 || spec.focal > 0 || !std::isnan(spec.limiting)) {
    auto o = std::make_unique<SNROpticalParametersT>();
    o->APERTURE_M = spec.aperture;
    o->FOCAL_LENGTH_M = spec.focal;
    o->LIMITING_MAGNITUDE = spec.limiting;
    o->PROVENANCE = section_prov(spec.docs_optical);
    s.OPTICAL = std::move(o);
  }
  flatbuffers::FlatBufferBuilder b(2048);
  FinishSizePrefixedSNRBuffer(b, SNR::Pack(b, &s));
  if (b.GetSize() > kMaxRecordBytes) return *error = s.SENSOR_ID + " is " + std::to_string(b.GetSize()) + " bytes, over the 8 KiB record bound", false;
  bytes->assign(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
  return true;
}

struct Lane {
  std::vector<uint8_t> stream;
  size_t count = 0;
  std::map<std::string, size_t> by_key;
  std::vector<std::pair<std::string, std::string>> attributes;  // id -> sha256 of the record: a diff between two weeks is a diff of this list
  uint64_t retrieved_ms = 0;
  std::set<std::string> licenses;
  bool share_alike = false;
};

void add(Lane* lane, const std::vector<uint8_t>& bytes, const std::string& id, const std::string& key, uint64_t retrieved_ms, const std::vector<const Doc*>& used) {
  lane->stream.insert(lane->stream.end(), bytes.begin(), bytes.end());
  ++lane->count;
  ++lane->by_key[key];
  lane->attributes.push_back({id, ephem::sha256_hex(bytes.data(), bytes.size())});
  lane->retrieved_ms = std::max(lane->retrieved_ms, retrieved_ms);
  for (const Doc* d : used) { lane->licenses.insert(d->source->license_id); if (d->source->klass == pvnLicenseClass::ShareAlike) lane->share_alike = true; }
}

int push_meta(const char* port, const char* schema, const char* schema_name, const char* source_name, const Lane& lane, const std::string& peer, R::reconcileMode reconcile) {
  const std::string sha = ephem::sha256_hex(lane.stream.data(), lane.stream.size());
  std::string licenses;
  for (const auto& l : lane.licenses) licenses += (licenses.empty() ? "" : " AND ") + l;
  R::IngestRequestT m;
  m.SCHEMA = schema;
  m.RECONCILE = reconcile;
  m.TAGS = std::make_unique<R::SourceTagsT>();
  auto& tags = *m.TAGS;
  tags.PROVIDER_ID = kProvider;
  tags.SOURCE_NAME = source_name;
  tags.BATCH_ID = sha;
  tags.SOURCE_URL = "https://www.wikidata.org/";
  tags.SOURCE_PEER = peer;
  tags.LICENSE = licenses;
  tags.LICENSE_URL = "https://creativecommons.org/licenses/by-sa/4.0/";
  tags.SHARE_ALIKE = lane.share_alike;
  tags.CITATION = "Wikidata contributors (CC0 1.0); Wikipedia contributors (CC BY-SA 4.0); (c) OpenStreetMap contributors (ODbL 1.0)";
  m.PROVENANCE = std::make_unique<R::ProvenanceT>();
  auto& p = *m.PROVENANCE;
  p.SOURCE_URL = "https://www.wikidata.org/";
  p.HTTP_STATUS = 200;
  p.RETRIEVED_MS = lane.retrieved_ms;
  p.PARSER = kProvider;
  p.PARSER_VERSION = kVersion;
  p.NORMALIZED_SHA256 = sha;
  p.NORMALIZED_COUNT = lane.count;
  p.SCHEMAS = {schema_name};
  p.SCHEMA_COUNTS = {lane.count};
  for (const auto& entry : lane.attributes) {
    auto a = std::make_unique<R::HeaderT>();
    a->NAME = entry.first;
    a->VALUE = entry.second;
    p.ATTRIBUTES.push_back(std::move(a));
  }
  flatbuffers::FlatBufferBuilder b(4096);
  R::FinishIngestRequestBuffer(b, R::IngestRequest::Pack(b, &m));
  return push(port, "IngestRequest.fbs", "INGQ", "IngestRequest", b.GetBufferPointer(), b.GetSize());
}

int push_notice(R::flowNoticeKind kind, const char* reason, uint64_t count, const std::vector<std::string>& items, uint64_t at) {
  R::FlowNoticeT n;
  n.KIND = kind;
  n.SCHEMA = "SIT.fbs";
  n.PROVIDER_ID = kProvider;
  n.SOURCE_NAME = kProvider;
  n.REASON = reason;
  n.COUNT = count;
  n.ITEMS = items;
  n.AT_MS = at;
  flatbuffers::FlatBufferBuilder b(2048);
  R::FinishFlowNoticeBuffer(b, R::FlowNotice::Pack(b, &n));
  return push("notice", "FlowNotice.fbs", "FNTC", "FlowNotice", b.GetBufferPointer(), b.GetSize());
}

int push_pvn(const Source& s, const std::string& version, uint64_t retrieved_ms, uint64_t bytes) {
  PVNT p;
  p.SOURCE_ID = s.id;
  p.SOURCE_KIND = pvnSourceKind::Reference;
  p.ORIGINATOR = s.originator;
  p.PROVIDER_ID = kProvider;
  p.PRODUCER = std::string(kPluginId) + " " + kVersion;
  p.LICENSE_CLASS = s.klass;
  p.LICENSE_ID = s.license_id;
  p.LINEAGE = s.id;
  p.SOURCE_URL = s.host_url;
  p.SOURCE_VERSION = version;
  p.RETRIEVED_AT = rfc3339_ms(retrieved_ms);
  p.SOURCE_BYTES = bytes;
  flatbuffers::FlatBufferBuilder b(512);
  FinishPVNBuffer(b, CreatePVN(b, &p));
  return push("provenance", "PVN.fbs", "$PVN", "PVN", b.GetBufferPointer(), b.GetSize());
}

}  // namespace

extern "C" int plan_sources(void) {
  const auto ticks = frames("tick");
  if (ticks.size() != 1 || !ticks[0]->payload) return fail("missing-tick", "plan_sources requires one TimerTick on 'tick'.");
  flatbuffers::Verifier verifier(ticks[0]->payload, ticks[0]->payload_length);
  if (!R::VerifyTimerTickBuffer(verifier)) return fail("invalid-tick", "The tick frame is not a TimerTick (TICK).");
  std::string error;
  const auto sites = read_roster(&error);
  if (!error.empty()) return fail("invalid-roster", error);
  std::set<std::string> keys;
  need_docs(sites, &keys);
  const Plan plan = plan_of(keys);
  std::vector<std::string> urls = plan.wikidata_urls;
  urls.insert(urls.end(), plan.wiki_urls.begin(), plan.wiki_urls.end());
  if (!plan.osm_url.empty()) urls.push_back(plan.osm_url);
  if (urls.size() > kMaxResponses) return fail("too-many-requests", "The roster plans more than 200 requests.");
  for (const auto& url : urls) {
    R::HttpRequestT request;
    request.METHOD = "GET";
    request.URL = url;
    request.TIMEOUT_MS = 90000;
    request.MAX_BYTES = kMaxBody;
    flatbuffers::FlatBufferBuilder b(512 + url.size());
    R::FinishHttpRequestBuffer(b, R::HttpRequest::Pack(b, &request));
    if (push("request", "HttpRequest.fbs", "HREQ", "HttpRequest", b.GetBufferPointer(), b.GetSize()) < 0) return fail("output-failed", "A request could not be written.");
  }
  return 0;
}

extern "C" int build_infrastructure(void) {
  const auto host_config = sdm_piv::get_config();
  if (!host_config.ok()) return fail("invalid-config", "The node configuration could not be read.");
  if (host_config.kind("producer_peer_id") != R::configValueKind_String || host_config.string("producer_peer_id").empty()) return fail("missing-producer-peer-id", "producer_peer_id (String) is required.");
  const std::string peer(host_config.string("producer_peer_id"));
  std::string error;
  const auto sites = read_roster(&error);
  if (!error.empty()) return fail("invalid-roster", error);

  // The responses, by URL.
  std::map<std::string, Doc> responses;
  const auto inputs = frames("response");
  if (inputs.empty() || inputs.size() > kMaxResponses) return fail("invalid-responses", "build_infrastructure takes 1 to 200 HttpResponse frames on 'response'.");
  for (const auto* f : inputs) {
    if (!f->payload || f->payload_length < 8) return fail("invalid-http-response", "An empty response frame.");
    flatbuffers::Verifier v(f->payload, f->payload_length, 64, 1000000, false);
    if (!R::VerifyHttpResponseBuffer(v)) return fail("invalid-http-response", "A response frame is not an HttpResponse (HRSP).");
    const auto* r = R::GetHttpResponse(f->payload);
    const std::string url = r->URL() ? r->URL()->str() : std::string();
    Doc d;
    d.url = url;
    d.retrieved_ms = r->RETRIEVED_MS();
    if (r->ERROR() && r->ERROR()->size()) d.error = "transport: " + r->ERROR()->str();
    else if (r->STATUS() != 200) d.error = "HTTP " + std::to_string(r->STATUS());
    else if (!r->BODY() || r->BODY()->size() == 0 || r->BODY()->size() > kMaxBody) d.error = "empty or oversize body";
    else {
      d.ok = true;
      d.body.assign(reinterpret_cast<const char*>(r->BODY()->data()), r->BODY()->size());
      d.sha256 = ephem::sha256_hex(r->BODY()->data(), r->BODY()->size());
    }
    responses[url] = std::move(d);
  }

  Run run;
  std::set<std::string> keys;
  need_docs(sites, &keys);
  const Plan plan = plan_of(keys);
  uint64_t latest[3] = {0, 0, 0};
  uint64_t bytes[3] = {0, 0, 0};
  std::string version[3];
  // A batch is the lane's whole current set only when every planned request was answered and readable: a transient outage of one source
  // must not retire the records that depend on it. Otherwise the batch only adds what changed (Duplicates).
  size_t fetch_failures = 0;
  auto take = [&](const std::string& url, const char* what) -> Doc* {
    const auto it = responses.find(url);
    if (it == responses.end()) { ++fetch_failures; run.missing.push_back(std::string(what) + " not fetched: " + clip(url, 160)); return nullptr; }
    if (!it->second.ok) { ++fetch_failures; run.missing.push_back(std::string(what) + " " + it->second.error + ": " + clip(url, 160)); return nullptr; }
    return &it->second;
  };

  // Wikidata: every entity of every chunk.
  size_t entities_read = 0;
  for (const auto& url : plan.wikidata_urls) {
    Doc* d = take(url, "Wikidata");
    if (!d) continue;
    const Json j = Json::parse(d->body, nullptr, false);
    if (j.is_discarded() || !j.contains("entities") || !j["entities"].is_object()) { ++fetch_failures; run.missing.push_back("Wikidata response is not wbgetentities JSON: " + clip(url, 120)); continue; }
    latest[0] = std::max(latest[0], d->retrieved_ms);
    bytes[0] += d->body.size();
    for (auto it = j["entities"].begin(); it != j["entities"].end(); ++it) {
      const std::string qid = it.key();
      if (it.value().contains("missing")) { run.missing.push_back("Wikidata " + qid + " is missing"); continue; }
      run.entities[qid] = it.value();
      ++entities_read;
      Doc e;
      e.ok = true;
      e.source = &kWikidata;
      e.record_id = qid;
      e.url = "https://www.wikidata.org/wiki/Special:EntityData/" + qid + ".json";
      e.retrieved_ms = d->retrieved_ms;
      e.sha256 = d->sha256;  // the chunk the entity was read from
      e.version = std::to_string(it.value().value("lastrevid", 0LL));
      const Json& labels = it.value().contains("labels") ? it.value()["labels"] : Json::object();
      const Json& descriptions = it.value().contains("descriptions") ? it.value()["descriptions"] : Json::object();
      std::string text;
      if (labels.contains("en")) text += "label=" + labels["en"].value("value", std::string()) + " ";
      if (descriptions.contains("en")) text += "description=" + descriptions["en"].value("value", std::string());
      e.text = T::collapse(text);
      version[0] = e.version;
      run.docs[wd_doc(qid)] = std::move(e);
    }
  }
  // Wikipedia: one page per title.
  size_t pages_read = 0;
  for (const auto& title : plan.titles) {
    Doc* d = take(wiki_url(title), "Wikipedia");
    if (!d) continue;
    WikiPage w;
    if (!read_wiki(d->body, &w)) { ++fetch_failures; run.missing.push_back("Wikipedia " + title + " is not a readable extract"); continue; }
    run.pages[title] = w;
    ++pages_read;
    latest[1] = std::max(latest[1], d->retrieved_ms);
    bytes[1] += d->body.size();
    version[1] = w.timestamp;
    Doc e;
    e.ok = true;
    e.source = &kWikipedia;
    e.record_id = title;
    e.url = "https://en.wikipedia.org/w/index.php?oldid=" + w.revid;
    e.retrieved_ms = d->retrieved_ms;
    e.sha256 = d->sha256;
    e.version = w.revid;
    e.text = w.extract;
    run.docs[wiki_doc(title)] = std::move(e);
  }
  // OpenStreetMap: the elements named by id.
  size_t elements_read = 0;
  if (!plan.osm_url.empty()) {
    Doc* d = take(plan.osm_url, "OpenStreetMap");
    if (d) {
      const Json j = Json::parse(d->body, nullptr, false);
      if (j.is_discarded() || !j.contains("elements") || !j["elements"].is_array()) { ++fetch_failures; run.missing.push_back("OpenStreetMap response is not Overpass JSON"); }
      else {
        latest[2] = d->retrieved_ms;
        bytes[2] = d->body.size();
        version[2] = j.contains("osm3s") ? j["osm3s"].value("timestamp_osm_base", std::string()) : std::string();
        for (const auto& el : j["elements"]) {
          const std::string type = el.value("type", std::string());
          const std::string key = std::string(type == "node" ? "n" : type == "way" ? "w" : "r") + std::to_string(el.value("id", 0LL));
          Element element;
          element.key = key;
          if (el.contains("lat") && el.contains("lon")) { element.lat = el["lat"].get<double>(); element.lon = el["lon"].get<double>(); element.has_position = true; }
          else if (el.contains("center")) { element.lat = el["center"].value("lat", 0.0); element.lon = el["center"].value("lon", 0.0); element.has_position = true; }
          if (el.contains("tags") && el["tags"].is_object()) for (auto it = el["tags"].begin(); it != el["tags"].end(); ++it) if (it.value().is_string()) element.tags[it.key()] = it.value().get<std::string>();
          run.elements[key] = element;
          ++elements_read;
          Doc e;
          e.ok = true;
          e.source = &kOsm;
          e.record_id = std::string(type) + "/" + std::to_string(el.value("id", 0LL));
          e.url = "https://www.openstreetmap.org/" + e.record_id;
          e.retrieved_ms = d->retrieved_ms;
          e.sha256 = d->sha256;
          e.version = version[2];
          std::string text;
          for (const auto& t : element.tags) text += t.first + "=" + t.second + "\n";
          e.text = T::collapse(text);
          run.docs[osm_doc(key)] = std::move(e);
        }
      }
    }
  }

  Lane site_lane, sensor_lane;
  size_t sites_refused = 0, sensors_refused = 0, positions_corroborated = 0, positions_single = 0;
  std::map<std::string, size_t> sites_by_country, sensors_by_country, sensors_by_type;
  std::map<std::string, size_t> sites_by_position_source;

  for (const auto& site : sites) {
    const std::string context = "site " + site.id;
    // Position.
    Position pos;
    const Doc* pos_doc = nullptr;
    std::function<bool(const std::string&, const std::string&, const std::string&, Position*, const Doc**)> resolve = [&](const std::string& src, const std::string& ref, const std::string& q, Position* out, const Doc** doc) -> bool {
      if (src == "wikidata") {
        const auto it = run.entities.find(ref);
        const auto d = run.docs.find(wd_doc(ref));
        if (it == run.entities.end() || d == run.docs.end()) return false;
        if (!wikidata_position(it->second, out)) { run.missing.push_back(context + ": Wikidata " + ref + " has no usable P625"); return false; }
        out->field = "P625"; *doc = &d->second;
        return true;
      }
      if (src == "wikipedia-near") {
        // The page tags several places; the one within near_km of the anchor (another source's position of the named town) is the site's.
        const auto it = run.pages.find(ref);
        const auto d = run.docs.find(wiki_doc(ref));
        if (it == run.pages.end() || d == run.docs.end()) return false;
        Position anchor;
        const Doc* anchor_doc = nullptr;
        if (!resolve(site.near_src, site.near_ref, std::string(), &anchor, &anchor_doc)) { run.missing.push_back(context + ": the anchor " + site.near_src + " " + site.near_ref + " is not readable"); return false; }
        int found = 0;
        for (const auto& c : it->second.all) {
          if (haversine_km(anchor.lat, anchor.lon, c.first, c.second) <= site.near_km) { ++found; out->lat = c.first; out->lon = c.second; }
        }
        if (found != 1) { run.missing.push_back(context + ": " + std::to_string(found) + " coordinate tags of " + ref + " lie within " + fixed(site.near_km, 0) + " km of " + site.near_src + " " + site.near_ref + " (exactly one is required)"); return false; }
        out->field = "coordinates"; *doc = &d->second;
        return true;
      }
      if (src == "wikipedia") {
        const auto it = run.pages.find(ref);
        const auto d = run.docs.find(wiki_doc(ref));
        if (it == run.pages.end() || d == run.docs.end()) return false;
        if (!it->second.has_coordinates) { run.missing.push_back(context + ": Wikipedia " + ref + " has no page coordinates"); return false; }
        out->lat = it->second.lat; out->lon = it->second.lon; out->field = "coordinates"; *doc = &d->second;
        return true;
      }
      if (src == "text") {
        // ref is a document key (wp:Title); q is the coordinate as the article writes it, which must occur in the article's text.
        const auto d = run.docs.find(ref);
        if (d == run.docs.end() || !d->second.ok) return false;
        if (d->second.text.find(T::collapse(q)) == std::string::npos) { run.missing.push_back(context + ": the coordinate text is not in " + ref + ": " + clip(q, 80)); return false; }
        if (!parse_coordinates(q, &out->lat, &out->lon)) { run.missing.push_back(context + ": the coordinate text is not readable: " + clip(q, 80)); return false; }
        out->field = "description"; *doc = &d->second;
        return true;
      }
      if (src == "osm") {
        const auto it = run.elements.find(ref);
        const auto d = run.docs.find(osm_doc(ref));
        if (it == run.elements.end() || d == run.docs.end()) { run.missing.push_back(context + ": OSM element " + ref + " not returned"); return false; }
        if (!it->second.has_position) return false;
        out->lat = it->second.lat; out->lon = it->second.lon; out->field = "osm:center"; *doc = &d->second;
        return true;
      }
      return false;
    };
    if (!resolve(site.pos_src, site.pos_ref, site.pos_q, &pos, &pos_doc) || !pos_doc) {
      ++sites_refused;
      run.missing.push_back(context + ": position not readable from " + site.pos_src + " " + site.pos_ref + "; the site and its sensors are not published");
      continue;
    }
    // Cross-checks against the other sources the roster names for the same place.
    std::vector<std::string> check_notes;
    bool disagree = false;
    size_t agreeing = 0;
    std::vector<const Doc*> used = {pos_doc};
    for (const auto& check : site.checks) {
      Position other;
      const Doc* other_doc = nullptr;
      if (!resolve(check.src, check.ref, check.q, &other, &other_doc) || !other_doc) { check_notes.push_back(check.src + " " + check.ref + " not readable"); continue; }
      const double km = haversine_km(pos.lat, pos.lon, other.lat, other.lon);
      if (km > check.km) {
        disagree = true;
        run.missing.push_back(context + ": " + check.src + " " + check.ref + " is " + fixed(km, 2) + " km from " + site.pos_src + " " + site.pos_ref + " (tolerance " + fixed(check.km, 2) + " km); the site and its sensors are not published");
        break;
      }
      ++agreeing;
      used.push_back(other_doc);
      check_notes.push_back(check.src + " " + check.ref + " " + fixed(km, 2) + " km");
    }
    if (disagree) { ++sites_refused; continue; }
    if (agreeing > 0) ++positions_corroborated; else ++positions_single;

    // The site's identity claims: operator (any number), kind, network, established, status.
    Spec identity_scratch;
    SITT s;
    s.ID = "sdn-infra:" + site.id;
    s.NAME = site.name;
    s.ABBREVIATION = site.abbreviation;
    bool ok = true;
    s.SITE_TYPE = site_type_of(site.site_type, &ok);
    if (!ok) { ++sites_refused; run.missing.push_back(context + ": unknown siteType " + site.site_type); continue; }
    s.CTR_ID = site.ctr;
    s.LATITUDE = static_cast<float>(pos.lat);
    s.LONGITUDE = static_cast<float>(pos.lon);
    s.SOURCE = kProvider;
    s.TASKABLE = false;
    std::vector<std::string> description;
    for (const auto& c : site.identity) {
      Verified v;
      if (!verify(run, c, context + " " + c.f, &v)) continue;
      const Doc& d = run.docs[c.doc];
      used.push_back(&d);
      if (c.f == "operator") {
        auto party = std::make_unique<SITPartyT>();
        party->ROLE = sitPartyRole::OPERATOR;
        party->NAME = c.name;
        party->CITATION = citation(d, c.doc.compare(0, 3, "wd:") == 0 ? "description" : "description");
        s.PARTIES.push_back(std::move(party));
      } else if (c.f == "kind") {
        s.SITE_KIND = c.name;
      } else if (c.f == "network") {
        s.NETWORK = c.name;
      } else if (c.f == "established") {
        s.ESTABLISHMENT_DATE = c.name;
      } else if (c.f == "status") {
        bool lok = true;
        s.LIFECYCLE_STATUS = lifecycle_of_name(c.e, &lok);
        if (!lok) { run.missing.push_back(context + ": unknown lifecycle " + c.e); s.LIFECYCLE_STATUS = siteLifecycleStatus::UNSPECIFIED; continue; }
        s.LIFECYCLE_STATUS_DATE = c.des;
        s.STATUS_VERIFIED_AT = rfc3339_ms(d.retrieved_ms);
        auto ev = std::make_unique<SITStatusEvidenceT>();
        ev->STATUS = s.LIFECYCLE_STATUS;
        ev->STATUS_DATE = c.des;
        ev->CITATION = citation(d, "description");
        s.STATUS_EVIDENCE.push_back(std::move(ev));
      }
    }
    // Position evidence.
    s.POSITION_CITATION = citation(*pos_doc, pos.field);
    if (!site.pos_denotes.empty()) description.push_back("Position: " + site.pos_denotes + ".");
    if (agreeing == 0) description.push_back("Position from a single source (no second source in the roster agrees or disagrees).");
    else description.push_back("Position agrees with " + std::to_string(agreeing) + " other source(s) within the roster tolerance: " + [&] { std::string out; for (const auto& n : check_notes) out += (out.empty() ? "" : "; ") + n; return out; }() + ".");
    if (site.pos_src == "wikidata" && pos.precision_deg > 0) description.push_back("Wikidata states a coordinate precision of " + fixed(pos.precision_deg, 6) + " degrees.");
    std::string desc;
    for (const auto& x : description) desc += (desc.empty() ? "" : " ") + x;
    s.DESCRIPTION = clip(desc, 1200);
    s.DESCRIPTION_LANGUAGE = "en";
    // Elevation, when Wikidata states one for the position item, in metres.
    if (site.pos_src == "wikidata") {
      double elevation = 0;
      const auto ent = run.entities.find(site.pos_ref);
      if (ent != run.entities.end() && wikidata_quantity(ent->second, "P2044", &elevation)) {
        auto q = std::make_unique<SITQuantityT>();
        q->KIND = sitQuantityKind::ELEVATION;
        q->VALUE = elevation;
        q->UNITS = "m";
        q->CITATION = citation(*pos_doc, "P2044");
        s.QUANTITIES.push_back(std::move(q));
      }
    }
    // External references.
    auto ref = [&](sitReferenceRole role, const char* registry, const std::string& id, const std::string& url, const std::string& title) {
      auto r = std::make_unique<SITReferenceT>();
      r->ROLE = role; r->REGISTRY = registry; r->RECORD_ID = id; r->URL = url; r->TITLE = title; r->LANGUAGE = "en";
      s.EXTERNAL_REFERENCES.push_back(std::move(r));
    };
    if (!site.wikidata.empty()) ref(sitReferenceRole::REGISTRY_RECORD, "wikidata", site.wikidata, "https://www.wikidata.org/wiki/" + site.wikidata, std::string());
    if (!site.enwiki.empty()) ref(sitReferenceRole::ENCYCLOPEDIA_ARTICLE, "enwiki", "", "https://en.wikipedia.org/wiki/" + [&] { std::string t = site.enwiki; std::replace(t.begin(), t.end(), ' ', '_'); return t; }(), site.enwiki);
    if (!site.osm.empty()) { const std::string type = site.osm[0] == 'n' ? "node" : site.osm[0] == 'w' ? "way" : "relation"; ref(sitReferenceRole::REGISTRY_RECORD, "openstreetmap", type + "/" + site.osm.substr(1), "https://www.openstreetmap.org/" + type + "/" + site.osm.substr(1), std::string()); }

    // Sensors first (their sources join the site's PROVENANCE), the site last.
    struct PendingSensor { SNRT s; Spec spec; std::vector<const Doc*> used; };
    std::vector<PendingSensor> pending;
    for (const auto& sensor : site.sensors) {
      PendingSensor p;
      apply_claims(run, "sensor " + site.id + "/" + sensor.id, sensor.claims, &p.spec);
      if (p.spec.verified == 0) { ++sensors_refused; run.missing.push_back("sensor " + site.id + "/" + sensor.id + ": no claim verified; the sensor is not published"); continue; }
      p.s.SENSOR_ID = "infra:" + site.id + ":" + sensor.id;
      p.s.NAME = sensor.name;
      p.s.SITE_ID = s.ID;
      for (const auto& d : p.spec.docs_all) p.used.push_back(&run.docs[d]);
      pending.push_back(std::move(p));
    }
    for (auto& p : pending) {
      std::map<std::string, const Doc*> by_doc;
      for (const auto& d : p.spec.docs_all) by_doc[d] = &run.docs[d];
      const Doc& primary = *by_doc[p.spec.quotes.front().first];
      std::string notes = "Sensor at " + site.name + " (" + s.ID + "). Facts quoted verbatim from the sources, each from its own document:";
      for (const auto& q : p.spec.quotes) notes += " [" + q.first + "] \"" + q.second + "\"";
      notes += ".";
      bool derived = false;
      for (const auto& b : p.spec.bands) derived = derived || b.derived;
      if (derived) notes += " Band edges are derived: the centre frequency -/+ half the stated width.";
      if (p.spec.type == SensorType::UNSPECIFIED) notes += " The sources do not classify the sensor into a SensorType.";
      if (!p.spec.has_cone) notes += " No field of view angle is stated.";
      if (p.spec.max_range > 0) notes += " Stated range: " + fixed(p.spec.max_range / 1000.0, 1) + " km.";
      p.s.NOTES = clip(notes, 3500);
      p.s.PROVENANCE = opp(primary, "Primary document of the record; sections read from other documents carry their own PROVENANCE.");
      std::vector<uint8_t> bytes;
      std::string pack_error;
      if (!pack_snr(p.s, p.spec, primary, by_doc, &pack_error, &bytes)) { ++sensors_refused; run.missing.push_back(pack_error); continue; }
      add(&sensor_lane, bytes, p.s.SENSOR_ID, EnumNameSensorType(p.spec.type), primary.retrieved_ms, p.used);
      ++sensors_by_country[site.ctr];
      ++sensors_by_type[EnumNameSensorType(p.spec.type)];
      for (const Doc* d : p.used) used.push_back(d);
    }
    s.PROVENANCE = record_pvn(used);
    flatbuffers::FlatBufferBuilder b(2048);
    FinishSizePrefixedSITBuffer(b, SIT::Pack(b, &s));
    if (b.GetSize() > kMaxRecordBytes) { ++sites_refused; run.missing.push_back(s.ID + " is " + std::to_string(b.GetSize()) + " bytes, over the 8 KiB record bound"); continue; }
    std::vector<uint8_t> bytes(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
    add(&site_lane, bytes, s.ID, site.ctr, pos_doc->retrieved_ms, used);
    ++sites_by_country[site.ctr];
    ++sites_by_position_source[site.pos_src];
  }

  // Platforms: sensors on a mobile platform, joined by ENTITY_ID, with no fixed site.
  for (const auto& platform : g_platforms) {
    Spec spec;
    apply_claims(run, "platform " + platform.id, platform.claims, &spec);
    if (spec.verified == 0) { ++sensors_refused; run.missing.push_back("platform " + platform.id + ": no claim verified; the sensor is not published"); continue; }
    SNRT sn;
    sn.SENSOR_ID = "infra:platform:" + platform.id;
    sn.NAME = platform.name;
    sn.ENTITY_ID = "infra:platform:" + platform.id;
    std::map<std::string, const Doc*> by_doc;
    std::vector<const Doc*> used;
    for (const auto& d : spec.docs_all) { by_doc[d] = &run.docs[d]; used.push_back(&run.docs[d]); }
    const Doc& primary = *by_doc[spec.quotes.front().first];
    std::string notes = "Mobile sensor platform " + platform.name + " (" + sn.ENTITY_ID + "), no fixed site. Facts quoted verbatim from the sources, each from its own document:";
    for (const auto& q : spec.quotes) notes += " [" + q.first + "] \"" + q.second + "\"";
    notes += ".";
    if (spec.type == SensorType::UNSPECIFIED) notes += " The sources do not classify the sensor into a SensorType.";
    if (!spec.has_cone) notes += " No field of view angle is stated.";
    if (spec.max_range > 0) notes += " Stated range: " + fixed(spec.max_range / 1000.0, 1) + " km.";
    sn.NOTES = clip(notes, 3500);
    sn.PROVENANCE = opp(primary, "Primary document of the record; sections read from other documents carry their own PROVENANCE.");
    std::vector<uint8_t> bytes;
    std::string pack_error;
    if (!pack_snr(sn, spec, primary, by_doc, &pack_error, &bytes)) { ++sensors_refused; run.missing.push_back(pack_error); continue; }
    add(&sensor_lane, bytes, sn.SENSOR_ID, EnumNameSensorType(spec.type), primary.retrieved_ms, used);
    ++sensors_by_country[platform.ctr.empty() ? std::string("platform") : platform.ctr];
    ++sensors_by_type[EnumNameSensorType(spec.type)];
  }

  // Outputs.
  const R::reconcileMode reconcile = fetch_failures == 0 ? R::reconcileMode_Current : R::reconcileMode_Duplicates;
  if (site_lane.count && (push("site_records", "SIT.fbs", "$SIT", "SIT", site_lane.stream.data(), site_lane.stream.size()) < 0 ||
                          push_meta("site_meta", "SIT.fbs", "SIT", "sites", site_lane, peer, reconcile) < 0))
    return fail("output-failed", "The site lane could not be written.");
  if (sensor_lane.count && (push("sensor_records", "SNR.fbs", "$SNR", "SNR", sensor_lane.stream.data(), sensor_lane.stream.size()) < 0 ||
                            push_meta("sensor_meta", "SNR.fbs", "SNR", "sensors", sensor_lane, peer, reconcile) < 0))
    return fail("output-failed", "The sensor lane could not be written.");
  if ((entities_read && push_pvn(kWikidata, version[0], latest[0], bytes[0]) < 0) || (pages_read && push_pvn(kWikipedia, version[1], latest[1], bytes[1]) < 0) ||
      (elements_read && push_pvn(kOsm, version[2], latest[2], bytes[2]) < 0))
    return fail("output-failed", "A provenance record could not be written.");

  std::vector<std::string> items = {"records.sites=" + std::to_string(site_lane.count), "records.sensors=" + std::to_string(sensor_lane.count),
                                    "sites.refused=" + std::to_string(sites_refused), "sensors.refused=" + std::to_string(sensors_refused),
                                    "positions.corroborated=" + std::to_string(positions_corroborated), "positions.single=" + std::to_string(positions_single),
                                    "wikidata.entities=" + std::to_string(entities_read), "wikipedia.pages=" + std::to_string(pages_read), "osm.elements=" + std::to_string(elements_read),
                                    "claims.verified=" + std::to_string(run.verified), "claims.refused=" + std::to_string(run.refused),
                                    "fetch.failures=" + std::to_string(fetch_failures), std::string("reconcile=") + (fetch_failures == 0 ? "current" : "duplicates")};
  for (const auto& e : sites_by_country) items.push_back("sites.ctr." + e.first + "=" + std::to_string(e.second));
  for (const auto& e : sensors_by_country) items.push_back("sensors.ctr." + e.first + "=" + std::to_string(e.second));
  for (const auto& e : sensors_by_type) items.push_back("sensors.type." + e.first + "=" + std::to_string(e.second));
  for (const auto& e : sites_by_position_source) items.push_back("sites.position." + e.first + "=" + std::to_string(e.second));
  const uint64_t at = std::max(latest[0], std::max(latest[1], latest[2]));
  if (push_notice(R::flowNoticeKind_Info, "infrastructure-counts", site_lane.count + sensor_lane.count, items, at) < 0) return fail("output-failed", "The report could not be written.");
  if (!run.missing.empty() && push_notice(R::flowNoticeKind_Missing, "refused", run.missing.size(), run.missing, at) < 0) return fail("output-failed", "The report could not be written.");
  return 0;
}
