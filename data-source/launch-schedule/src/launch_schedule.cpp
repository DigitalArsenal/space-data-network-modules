#include "space_data_module_invoke.h"
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

// Upcoming-launch notices from a public launch registry (Launch Library 2,
// https://ll.thespacedevs.com/2.3.0/, mode=normal), normalised to $LDM.
// plan_launches builds the GET for the generic HTTP host; parse_launches
// validates one complete response and emits one size-prefixed $LDM per
// launch. No host calls: fetching, storage and publication are the host's.

using Json = nlohmann::json;
namespace {
constexpr size_t maxBytes = 4 * 1024 * 1024;
constexpr int maxLaunches = 100;
const char* endpoint = "https://ll.thespacedevs.com/2.3.0/launches/upcoming/";
const char* error = "Invalid launch registry input.";
#define NEED(condition, message) do { if (!(condition)) { error = message; return false; } } while (0)
#define CHECK(condition, message) do { if (!(condition)) return fail(message); } while (0)
int fail(const char* message) { plugin_set_error("invalid-launch-schedule-input", message); return 1; }

const plugin_input_frame_t* frame(const char* port) {
  const plugin_input_frame_t* found = nullptr;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* f = plugin_get_input_frame(i);
    if (!f || !f->port_id || !f->payload || !f->payload_length || f->payload_length > maxBytes + 8) return nullptr;
    if (std::strcmp(f->port_id, port) == 0) { if (found) return nullptr; found = f; }
  }
  return found;
}
Json json(const char* port) {
  const auto* f = frame(port);
  return f ? Json::parse(f->payload, f->payload + f->payload_length, nullptr, false) : Json();
}
int output(const char* port, const Json& value) {
  const auto text = value.dump();
  return plugin_push_output_ex(port, nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,
    nullptr, 0, 1, reinterpret_cast<const uint8_t*>(text.data()), text.size());
}
bool isText(const Json& o, const char* key) { return o.is_object() && o.contains(key) && o[key].is_string(); }
std::string text(const Json& o, const char* key) { return isText(o, key) ? o[key].get<std::string>() : std::string(); }
const Json& child(const Json& o, const char* key) {
  static const Json none;
  return o.is_object() && o.contains(key) && o[key].is_object() ? o[key] : none;
}

// ── UTC calendar (proleptic Gregorian, H. Hinnant's days_from_civil) ─────
int64_t daysFromCivil(int64_t y, unsigned m, unsigned d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + static_cast<int64_t>(doe) - 719468;
}
void civilFromDays(int64_t z, int64_t& y, unsigned& m, unsigned& d) {
  z += 719468;
  const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const unsigned doe = static_cast<unsigned>(z - era * 146097);
  const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  y = static_cast<int64_t>(yoe) + era * 400;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const unsigned mp = (5 * doy + 2) / 153;
  d = doy - (153 * mp + 2) / 5 + 1;
  m = mp < 10 ? mp + 3 : mp - 9;
  y += m <= 2;
}
// Strict "YYYY-MM-DDTHH:MM:SS[.fff]Z" → whole UTC seconds (fraction dropped).
bool parseIso(const std::string& s, int64_t& seconds) {
  int y, mo, d, h, mi, se, used = 0;
  if (s.size() < 20 || s.back() != 'Z') return false;
  if (std::sscanf(s.c_str(), "%4d-%2d-%2dT%2d:%2d:%2d%n", &y, &mo, &d, &h, &mi, &se, &used) != 6 || used != 19) return false;
  if (s.size() > 20 && s[19] != '.') return false;
  for (size_t i = 20; i + 1 < s.size(); ++i) if (s[i] < '0' || s[i] > '9') return false;
  if (y < 1957 || y > 9999 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 60) return false;
  int64_t yy; unsigned mm, dd;
  civilFromDays(daysFromCivil(y, mo, d), yy, mm, dd);
  if (yy != y || mm != unsigned(mo) || dd != unsigned(d)) return false;
  seconds = daysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + se;
  return true;
}
std::string iso(int64_t seconds) {
  const int64_t day = seconds >= 0 ? seconds / 86400 : (seconds - 86399) / 86400;
  const int64_t rem = seconds - day * 86400;
  int64_t y; unsigned m, d;
  civilFromDays(day, y, m, d);
  char buffer[32];
  std::snprintf(buffer, sizeof buffer, "%04lld-%02u-%02uT%02lld:%02lld:%02lldZ", static_cast<long long>(y), m, d,
    static_cast<long long>(rem / 3600), static_cast<long long>(rem % 3600 / 60), static_cast<long long>(rem % 60));
  return buffer;
}
int64_t monthStart(int64_t y, unsigned m) {
  while (m > 12) { m -= 12; ++y; }
  return daysFromCivil(y, m, 1) * 86400;
}

// The registry states how precisely NET is known. For calendar precisions it
// places NET at the end of the period (a July launch reads "July 31"), so the
// honest notice is the whole period: NET and the earliest time at its start,
// the latest time at its last second. Minute and second precision keep the
// published window. Unknown precisions are refused per launch, not guessed.
bool launchWindow(const Json& launch, int64_t net, std::string& earliest, std::string& latest, std::string& netOut) {
  const auto precision = text(child(launch, "net_precision"), "abbrev");
  int64_t start = 0, end = 0, ws = 0, we = 0;
  int64_t y; unsigned m, d;
  const int64_t day = net / 86400;
  civilFromDays(day, y, m, d);
  if (precision.empty() || precision == "SEC" || precision == "MIN") {
    NEED(parseIso(text(launch, "window_start"), ws) && parseIso(text(launch, "window_end"), we), "Launch window must be ISO 8601 UTC.");
    NEED(ws <= net && net <= we, "NET must lie inside its launch window.");
    earliest = iso(ws); latest = iso(we); netOut = iso(net);
    return true;
  }
  if (precision == "HR") { start = net - net % 3600; end = start + 3600; }
  else if (precision == "DAY") { start = day * 86400; end = start + 86400; }
  else if (precision == "M") { start = monthStart(y, m); end = monthStart(y, m + 1); }
  else if (precision.size() == 2 && precision[0] == 'Q' && precision[1] >= '1' && precision[1] <= '4') {
    const unsigned first = 1 + 3 * unsigned(precision[1] - '1');
    start = monthStart(y, first); end = monthStart(y, first + 3);
  } else if (precision == "H1" || precision == "H2") {
    const unsigned first = precision == "H1" ? 1 : 7;
    start = monthStart(y, first); end = monthStart(y, first + 6);
  } else if (precision == "Y") { start = monthStart(y, 1); end = monthStart(y + 1, 1); }
  else { error = "unsupported-precision"; return false; }
  NEED(start <= net && net < end + 86400, "NET falls outside its stated precision period.");
  earliest = iso(start); latest = iso(end - 1); netOut = iso(start);
  return true;
}

bool plan(const Json& config, Json& job) {
  NEED(config.is_object(), "Configuration must be an object.");
  NEED(isText(config, "access") && config["access"] == "anonymous",
    "Choose access explicitly; this release supports the anonymous tier only (15 requests per hour).");
  NEED(!config.contains("limit") || config["limit"].is_number_integer(), "limit must be an integer.");
  const int limit = config.contains("limit") ? config["limit"].get<int>() : maxLaunches;
  NEED(limit >= 1 && limit <= maxLaunches, "limit must be between 1 and 100.");
  const auto url = std::string(endpoint) + "?format=json&mode=normal&limit=" + std::to_string(limit);
  job = {{"source_url", url}, {"limit", limit}, {"access", "anonymous"}, {"provider_id", "launch-schedule"},
    {"source_name", "upcoming"}};
  return true;
}

// Builds one $LDM for a registry launch. Returns false with `error` set.
bool buildRecord(const Json& launch, flatbuffers::FlatBufferBuilder& b, bool& skipped) {
  skipped = false;
  NEED(launch.is_object(), "Each launch must be an object.");
  const auto id = text(launch, "id");
  NEED(id.size() == 36 && id[8] == '-' && id[13] == '-' && id[18] == '-' && id[23] == '-', "Launch id must be a UUID.");
  int64_t net;
  NEED(parseIso(text(launch, "net"), net), "NET must be ISO 8601 UTC.");
  std::string earliest, latest, netText;
  if (!launchWindow(launch, net, earliest, latest, netText)) {
    if (std::strcmp(error, "unsupported-precision") == 0) { skipped = true; return true; }
    return false;
  }
  const auto& pad = child(launch, "pad");
  NEED(pad.contains("latitude") && pad["latitude"].is_number() && pad.contains("longitude") && pad["longitude"].is_number(),
    "Pad latitude and longitude must be numbers.");
  const double lat = pad["latitude"].get<double>(), lon = pad["longitude"].get<double>();
  NEED(std::isfinite(lat) && std::isfinite(lon) && std::fabs(lat) <= 90 && std::fabs(lon) <= 180, "Pad coordinates out of range.");
  NEED(pad.contains("id") && pad["id"].is_number_integer(), "Pad id must be an integer.");

  const auto& mission = child(launch, "mission");
  const auto& configuration = child(child(launch, "rocket"), "configuration");
  std::string family;
  if (configuration.contains("families") && configuration["families"].is_array() && !configuration["families"].empty())
    family = text(configuration["families"][0], "name");
  std::string webcast;
  if (mission.contains("vid_urls") && mission["vid_urls"].is_array())
    for (const auto& v : mission["vid_urls"]) if (webcast.empty()) webcast = text(v, "url");

  const auto siteId = b.CreateString(std::to_string(pad["id"].get<int64_t>()));
  const auto siteName = b.CreateString(text(pad, "name"));
  const auto siteDescription = b.CreateString(text(child(pad, "location"), "name"));
  SITBuilder site(b);
  site.add_ID(siteId); site.add_NAME(siteName); site.add_DESCRIPTION(siteDescription);
  site.add_LATITUDE(static_cast<float>(lat)); site.add_LONGITUDE(static_cast<float>(lon));
  const auto siteOffset = site.Finish();

  const auto rocketName = b.CreateString(isText(configuration, "full_name") ? text(configuration, "full_name") : text(configuration, "name"));
  const auto rocketFamily = b.CreateString(family);
  const auto rocketVariant = b.CreateString(text(configuration, "variant"));
  ROCBuilder rocket(b);
  rocket.add_NAME(rocketName); rocket.add_FAMILY(rocketFamily); rocket.add_VARIANT(rocketVariant);
  const auto rocketOffset = rocket.Finish();

  const auto idOffset = b.CreateString(id);
  const auto netOffset = b.CreateString(netText);
  const auto agency = b.CreateString(text(child(launch, "launch_service_provider"), "name"));
  const auto missionName = b.CreateString(isText(mission, "name") ? text(mission, "name") : text(launch, "name"));
  const auto missionDescription = b.CreateString(text(mission, "description"));
  const auto missionType = b.CreateString(text(mission, "type"));
  const auto orbit = b.CreateString(text(child(mission, "orbit"), "abbrev"));
  const auto status = b.CreateString(text(child(launch, "status"), "name"));
  const auto webcastOffset = b.CreateString(webcast);
  const auto references = b.CreateString(text(launch, "url"));
  const auto earliestOffset = b.CreateVectorOfStrings(std::vector<std::string>{earliest});
  const auto latestOffset = b.CreateVectorOfStrings(std::vector<std::string>{latest});
  LDMBuilder record(b);
  record.add_ID(idOffset);
  record.add_SITE(siteOffset);
  record.add_AGENCY_NAME(agency);
  record.add_NET(netOffset);
  record.add_ROCKET_CONFIGURATION(rocketOffset);
  record.add_MISSION_NAME(missionName);
  record.add_MISSION_DESCRIPTION(missionDescription);
  record.add_MISSION_TYPE(missionType);
  record.add_ORBIT_TYPE(orbit);
  record.add_LAUNCH_STATUS(status);
  record.add_WEBCAST_URL(webcastOffset);
  record.add_REFERENCES(references);
  record.add_EARLIEST_LAUNCH_TIMES(earliestOffset);
  record.add_LATEST_LAUNCH_TIMES(latestOffset);
  b.FinishSizePrefixed(record.Finish(), "$LDM");
  return true;
}
}  // namespace

extern "C" int plan_launches() {
  CHECK(plugin_get_input_count() == 1, "Exactly one configuration frame is required.");
  Json job;
  CHECK(plan(json("config"), job), error);
  const Json request = {{"method", "GET"}, {"url", job["source_url"]}, {"timeoutMs", 30000}, {"maxBytes", maxBytes},
    {"responseWire", "raw-body-v1"}};
  if (output("request", request) < 0 || output("job", job) < 0) return 1;
  return 0;
}

extern "C" int parse_launches() {
  CHECK(plugin_get_input_count() == 3, "Exactly one job, response and receipt frame are required.");
  const Json job = json("job"), receipt = json("receipt");
  Json expected;
  CHECK(job.is_object() && job.contains("limit") && job["limit"].is_number_integer(), "Job is not a launch plan.");
  CHECK(plan({{"access", job.value("access", "")}, {"limit", job["limit"]}}, expected), error);
  CHECK(job == expected, "Job differs from its canonical launch plan.");
  CHECK(receipt.is_object() && receipt.contains("retrieved_at_ms") && receipt["retrieved_at_ms"].is_number_integer(), "Invalid retrieval epoch.");
  const int64_t retrieved = receipt["retrieved_at_ms"].get<int64_t>();
  CHECK(retrieved > 0 && retrieved <= 9007199254740991LL, "Invalid retrieval epoch.");
  const auto peer = text(receipt, "producer_peer_id");
  CHECK(!peer.empty() && peer.size() <= 128, "An authenticated producer peer ID is required.");
  const auto* response = frame("response");
  CHECK(response && response->payload_length > 8 && std::memcmp(response->payload, "$HRB", 4) == 0, "Expected a raw-body-v1 HTTP response.");
  const auto* p = response->payload;
  const uint32_t status = uint32_t(p[4]) | uint32_t(p[5]) << 8 | uint32_t(p[6]) << 16 | uint32_t(p[7]) << 24;
  CHECK(status == 200, "Launch registry request did not succeed; keep the previous notices.");
  const auto source = Json::parse(p + 8, p + response->payload_length, nullptr, false);
  CHECK(source.is_object() && source.contains("results") && source["results"].is_array(), "Registry response has no results array.");
  const auto& results = source["results"];
  CHECK(results.size() <= size_t(job["limit"].get<int>()), "Registry returned more launches than requested.");

  std::vector<uint8_t> stream;
  size_t count = 0, skipped = 0;
  for (const auto& launch : results) {
    flatbuffers::FlatBufferBuilder b(2048);
    bool skip = false;
    CHECK(buildRecord(launch, b, skip), error);
    if (skip) { ++skipped; continue; }
    CHECK(stream.size() + b.GetSize() <= 16 * 1024 * 1024, "Output exceeds its byte budget.");
    stream.insert(stream.end(), b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
    ++count;
  }
  // Emit only after the whole response validated, so a bad tail never
  // replaces a good set of notices with a partial one.
  const Json meta = {{"schema", "LDM.fbs"}, {"batch_id", ephem::sha256_hex(p + 8, response->payload_length - 8)},
    {"provider_id", "launch-schedule"}, {"source_name", job["source_name"]}, {"source_url", job["source_url"]},
    {"source_peer", peer}, {"reconcile", "current"}, {"origin_id", "thespacedevs.com"},
    {"origin_name", "Launch Library 2"}, {"dataset_id", "launch-library-2/upcoming"},
    {"terms_url", "https://thespacedevs.com/llapi"},
    {"citation", "Launch data from Launch Library 2 by The Space Devs (https://thespacedevs.com), free access tier."}};
  const Json report = {{"records", count}, {"skipped_imprecise", skipped}, {"registry_count", source.value("count", 0)},
    {"retrieved_at_ms", retrieved}};
  if (output("meta", meta) < 0 || output("report", report) < 0) return 1;
  return plugin_push_output_ex("records", "LDM.fbs", "$LDM", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "LDM", 0, 0,
    stream.data(), stream.size()) < 0 ? 1 : 0;
}
