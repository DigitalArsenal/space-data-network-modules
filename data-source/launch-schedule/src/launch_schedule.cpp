#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "HttpRequest_generated.h"
#include "HttpResponse_generated.h"
#include "IngestRequest_generated.h"
#include "FlowNotice_generated.h"
#include "TimerTick_generated.h"
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <vector>

// Upcoming-launch notices from a public launch registry (Launch Library 2,
// https://ll.thespacedevs.com/2.3.0/, mode=normal), normalised to $LDM
// (typed contracts 1.0: FlatBuffers only between modules).
//
//   plan_launches  : "tick" TimerTick (TICK; fields not read) -> node CONFIG
//                    launch_schedule_source.access / .limit and
//                    launch_schedule_producer_peer_id (plugin.getConfig, SDS
//                    $PIV) -> ONE "request" HttpRequest (HREQ, GET) whose
//                    CONTEXT is the plan: ONE size-prefixed IngestRequest
//                    (INGQ) skeleton - SCHEMA LDM.fbs, TAGS PROVIDER_ID
//                    launch-schedule / SOURCE_NAME upcoming / SOURCE_URL the
//                    canonical request URL (it names the page size) /
//                    SOURCE_PEER the producer peer id / LICENSE_URL the terms /
//                    CITATION, RECONCILE Current.
//   parse_launches : ONE "response" HttpResponse (HRSP; the plan echoed in
//                    CONTEXT, RETRIEVED_MS the host's retrieval time) -> the
//                    plan re-derived from its URL and required to be canonical
//                    -> "records" one size-prefixed $LDM per launch, "meta" ONE
//                    IngestRequest for hostcap/storage-ingest, "report" ONE
//                    FlowNotice (FNTC) Info. No host call: a pure transform.
//
// The upstream response body is the registry's JSON - a foreign wire format
// parsed here; nothing module-to-module is JSON.

using Json = nlohmann::json;
namespace {
namespace A = sdn::runtime::Aligned;
namespace R = sdn::runtime;
constexpr size_t maxBytes = 4 * 1024 * 1024;
constexpr int maxLaunches = 100;
const char* endpoint = "https://ll.thespacedevs.com/2.3.0/launches/upcoming/";
const char* kProvider = "launch-schedule";
const char* kSourceName = "upcoming";
const char* kTermsUrl = "https://thespacedevs.com/llapi";
const char* kCitation = "Launch data from Launch Library 2 by The Space Devs (https://thespacedevs.com), free access tier.";
const char* error = "Invalid launch registry input.";
#define NEED(condition, message) do { if (!(condition)) { error = message; return false; } } while (0)
#define CHECK(condition, message) do { if (!(condition)) return fail(message); } while (0)
int fail(const char* message) { plugin_set_error("invalid-launch-schedule-input", message); return 1; }

// The single frame on `port`; nullptr when absent, repeated, empty or over budget.
const plugin_input_frame_t* frame(const char* port) {
  const plugin_input_frame_t* found = nullptr;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* f = plugin_get_input_frame(i);
    if (!f || !f->port_id || !f->payload || !f->payload_length || f->payload_length > maxBytes + 64 * 1024) return nullptr;
    if (std::strcmp(f->port_id, port) == 0) { if (found) return nullptr; found = f; }
  }
  return found;
}
int push(const char* port, const char* schema, const char* identifier, const char* root, const uint8_t* data, size_t size) {
  return plugin_push_output_ex(port, schema, identifier, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0, data, static_cast<uint32_t>(size));
}
bool isText(const Json& o, const char* key) { return o.is_object() && o.contains(key) && o[key].is_string(); }
std::string text(const Json& o, const char* key) { return isText(o, key) ? o[key].get<std::string>() : std::string(); }
const Json& child(const Json& o, const char* key) {
  static const Json none;
  return o.is_object() && o.contains(key) && o[key].is_object() ? o[key] : none;
}
std::string str(const flatbuffers::String* s) { return s ? s->str() : std::string(); }

// Node CONFIG: plugin.getConfig answers one ModuleConfig (MCFG) FlatBuffer on raw "config", read in place
// (sdm_piv::get_config(); nested objects are TableLists, reached by dotted paths).
using Config = sdm_piv::Config;
using ConfigValue = sdn::runtime::ConfigEntry;
Config loadConfig() { return sdm_piv::get_config(); }
const ConfigValue* entry(const Config& c, const std::string& key) { return c.entry(key); }
bool isString(const ConfigValue* e) { return e && e->KIND() == sdn::runtime::configValueKind_String; }
std::string textOf(const ConfigValue* e) { return isString(e) ? str(e->STRING_VALUE()) : std::string(); }
// Some nested table under `key` holds at least one entry (an object, or a list of objects).
bool hasTable(const Config& c, const char* key) {
  for (size_t i = 0, n = c.tables(key); i < n; i++) if (c.table(key, i).size()) return true;
  return false;
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

// The plan: an explicit access tier (anonymous only) and a page size 1-100.
struct Plan { std::string access; int limit = maxLaunches; std::string url; };
bool canonical(Plan& plan) {
  NEED(plan.access == "anonymous",
    "Choose access explicitly; this release supports the anonymous tier only (15 requests per hour).");
  NEED(plan.limit >= 1 && plan.limit <= maxLaunches, "limit must be between 1 and 100.");
  plan.url = std::string(endpoint) + "?format=json&mode=normal&limit=" + std::to_string(plan.limit);
  return true;
}
// The plan from node CONFIG launch_schedule_source (a nested object; dotted paths).
bool planFromConfig(const Config& c, Plan& plan) {
  const std::string p = "launch_schedule_source.";
  NEED(hasTable(c, "launch_schedule_source"), "Configuration must be an object.");
  const auto* access = entry(c, p + "access");
  NEED(textOf(access) == "anonymous",
    "Choose access explicitly; this release supports the anonymous tier only (15 requests per hour).");
  plan.access = textOf(access);
  if (const auto* limit = entry(c, p + "limit")) {
    const double n = limit->NUMBER_VALUE();
    NEED(limit->KIND() == sdn::runtime::configValueKind_Number && std::isfinite(n) && std::floor(n) == n &&
      std::fabs(n) < 1e9, "limit must be an integer.");
    plan.limit = static_cast<int>(n);
  }
  return canonical(plan);
}
// The plan back from its canonical request URL (the URL names the page size).
bool planFromUrl(const std::string& url, Plan& plan) {
  const std::string prefix = std::string(endpoint) + "?format=json&mode=normal&limit=";
  NEED(url.compare(0, prefix.size(), prefix) == 0, "Job differs from its canonical launch plan.");
  const std::string digits = url.substr(prefix.size());
  NEED(!digits.empty() && digits.size() <= 3 && digits.find_first_not_of("0123456789") == std::string::npos,
    "Job differs from its canonical launch plan.");
  plan.access = "anonymous";
  plan.limit = std::atoi(digits.c_str());
  NEED(canonical(plan) && plan.url == url, "Job differs from its canonical launch plan.");
  return true;
}

// The plan as ONE size-prefixed IngestRequest skeleton: the request's CONTEXT.
std::vector<uint8_t> planContext(const Plan& plan, const std::string& peer) {
  R::IngestRequestT job;
  job.SCHEMA = "LDM.fbs";
  job.TAGS = std::make_unique<R::SourceTagsT>();
  job.TAGS->PROVIDER_ID = kProvider;
  job.TAGS->SOURCE_NAME = kSourceName;
  job.TAGS->SOURCE_URL = plan.url;
  job.TAGS->SOURCE_PEER = peer;
  job.TAGS->LICENSE_URL = kTermsUrl;
  job.TAGS->CITATION = kCitation;
  job.RECONCILE = R::reconcileMode_Current;
  flatbuffers::FlatBufferBuilder b(512);
  R::FinishSizePrefixedIngestRequestBuffer(b, R::IngestRequest::Pack(b, &job));
  return std::vector<uint8_t>(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
}
std::string headerOf(const R::HttpResponse& r, const char* name) {
  if (!r.HEADERS()) return std::string();
  for (const R::Header* h : *r.HEADERS()) if (h && h->NAME() && h->NAME()->str() == name) return str(h->VALUE());
  return std::string();
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
  CHECK(plugin_get_input_count() == 1, "Exactly one timer tick is required.");
  const auto* tick = frame("tick");
  CHECK(tick, "Exactly one timer tick is required.");
  flatbuffers::Verifier verifier(tick->payload, tick->payload_length);
  CHECK(R::VerifyTimerTickBuffer(verifier), "The tick is not a TimerTick (TICK).");
  const auto config = loadConfig();
  Plan plan;
  CHECK(planFromConfig(config, plan), error);
  // The producer peer id (node CONFIG launch_schedule_producer_peer_id) rides the plan, so parse_launches needs no host.
  const auto* peer = entry(config, "launch_schedule_producer_peer_id");
  const auto context = planContext(plan, textOf(peer));
  flatbuffers::FlatBufferBuilder b(1024);
  R::FinishHttpRequestBuffer(b, R::CreateHttpRequestDirect(b, "GET", plan.url.c_str(), nullptr, nullptr, 30000, maxBytes, &context));
  return push("request", "HttpRequest.fbs", R::HttpRequestIdentifier(), "HttpRequest", b.GetBufferPointer(), b.GetSize()) < 0 ? 1 : 0;
}

extern "C" int parse_launches() {
  CHECK(plugin_get_input_count() == 1, "Exactly one response frame is required.");
  const auto* f = frame("response");
  CHECK(f, "Expected one HttpResponse on \"response\".");
  flatbuffers::Verifier verifier(f->payload, f->payload_length);
  CHECK(R::VerifyHttpResponseBuffer(verifier), "Expected an HttpResponse (HRSP).");
  const auto* http = R::GetHttpResponse(f->payload);
  // The plan rides the request's CONTEXT; it must be the canonical plan of its own URL.
  const auto* ctx = http->CONTEXT();
  CHECK(ctx && ctx->size() > 8, "The response carries no launch plan (CONTEXT).");
  flatbuffers::Verifier ctxVerifier(ctx->data(), ctx->size());
  CHECK(R::VerifySizePrefixedIngestRequestBuffer(ctxVerifier), "The launch plan (CONTEXT) is not a size-prefixed IngestRequest.");
  const auto* job = R::GetSizePrefixedIngestRequest(ctx->data());
  const auto* tags = job->TAGS();
  CHECK(tags && str(job->SCHEMA()) == "LDM.fbs", "Job is not a launch plan.");
  Plan plan;
  CHECK(planFromUrl(str(tags->SOURCE_URL()), plan), error);
  CHECK(str(tags->PROVIDER_ID()) == kProvider && str(tags->SOURCE_NAME()) == kSourceName && str(tags->LICENSE_URL()) == kTermsUrl &&
    str(tags->CITATION()) == kCitation && job->RECONCILE() == R::reconcileMode_Current && !job->ARCHIVE() && !job->PROVENANCE() &&
    str(tags->BATCH_ID()).empty(), "Job differs from its canonical launch plan.");
  const std::string peer = str(tags->SOURCE_PEER());
  CHECK(!peer.empty() && peer.size() <= 128, "An authenticated producer peer ID is required.");
  const uint64_t retrieved = http->RETRIEVED_MS();
  CHECK(retrieved > 0 && retrieved <= 9007199254740991ULL, "Invalid retrieval epoch.");
  CHECK(http->STATUS() == 200, "Launch registry request did not succeed; keep the previous notices.");
  const uint8_t* body = http->BODY() ? http->BODY()->data() : nullptr;
  const size_t bodyLength = http->BODY() ? http->BODY()->size() : 0;
  CHECK(bodyLength <= maxBytes, "Registry response exceeds its byte budget.");
  const auto source = Json::parse(body, body + bodyLength, nullptr, false);
  CHECK(source.is_object() && source.contains("results") && source["results"].is_array(), "Registry response has no results array.");
  const auto& results = source["results"];
  CHECK(results.size() <= size_t(plan.limit), "Registry returned more launches than requested.");

  std::vector<uint8_t> stream;
  size_t count = 0;
  std::vector<std::string> skippedIds;
  for (const auto& launch : results) {
    flatbuffers::FlatBufferBuilder b(2048);
    bool skip = false;
    CHECK(buildRecord(launch, b, skip), error);
    if (skip) { skippedIds.push_back(text(launch, "id")); continue; }
    CHECK(stream.size() + b.GetSize() <= 16 * 1024 * 1024, "Output exceeds its byte budget.");
    stream.insert(stream.end(), b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
    ++count;
  }
  // Emit only after the whole response validated, so a bad tail never
  // replaces a good set of notices with a partial one.
  const std::string batch = ephem::sha256_hex(body, bodyLength);
  R::IngestRequestT meta;
  meta.SCHEMA = "LDM.fbs";
  meta.TAGS = std::make_unique<R::SourceTagsT>();
  meta.TAGS->PROVIDER_ID = kProvider;
  meta.TAGS->SOURCE_NAME = kSourceName;
  meta.TAGS->BATCH_ID = batch;
  meta.TAGS->SOURCE_URL = plan.url;
  meta.TAGS->SOURCE_PEER = peer;
  meta.TAGS->LICENSE_URL = kTermsUrl;
  meta.TAGS->CITATION = kCitation;
  meta.RECONCILE = R::reconcileMode_Current;
  meta.PROVENANCE = std::make_unique<R::ProvenanceT>();
  auto& p = *meta.PROVENANCE;
  p.SOURCE_URL = plan.url;
  p.HTTP_STATUS = 200;
  p.ETAG = headerOf(*http, "etag");
  p.LAST_MODIFIED = headerOf(*http, "last-modified");
  p.CONTENT_TYPE = headerOf(*http, "content-type");
  p.RETRIEVED_MS = retrieved;
  p.PARSER = "launch-schedule";
  p.PARSER_VERSION = "launch-schedule/0.2.0";
  p.SOURCE_SHA256 = batch;
  p.NORMALIZED_COUNT = count;
  p.SCHEMAS = {"LDM.fbs"};
  p.SCHEMA_COUNTS = {count};
  flatbuffers::FlatBufferBuilder mb(1024);
  R::FinishIngestRequestBuffer(mb, R::IngestRequest::Pack(mb, &meta));
  // The report: records normalized (COUNT), the retrieval time (AT_MS), the registry's own total and every launch skipped
  // for an unsupported NET precision (ITEMS).
  R::FlowNoticeT report;
  report.KIND = R::flowNoticeKind_Info;
  report.SCHEMA = "LDM.fbs";
  report.PROVIDER_ID = kProvider;
  report.SOURCE_NAME = kSourceName;
  report.BATCH_ID = batch;
  report.COUNT = count;
  report.REASON = "normalized";
  report.ITEMS.push_back("registry-count:" + std::to_string(source.value("count", 0)));
  for (const auto& id : skippedIds) report.ITEMS.push_back("skipped-imprecise:" + id);
  report.AT_MS = retrieved;
  flatbuffers::FlatBufferBuilder rb(512);
  R::FinishFlowNoticeBuffer(rb, R::FlowNotice::Pack(rb, &report));
  if (push("meta", "IngestRequest.fbs", R::IngestRequestIdentifier(), "IngestRequest", mb.GetBufferPointer(), mb.GetSize()) < 0 ||
      push("report", "FlowNotice.fbs", R::FlowNoticeIdentifier(), "FlowNotice", rb.GetBufferPointer(), rb.GetSize()) < 0) return 1;
  return push("records", "LDM.fbs", "$LDM", "LDM", stream.data(), stream.size()) < 0 ? 1 : 0;
}
