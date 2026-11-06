#pragma once
// Typed boundary only. Planning and compact internal state retain their existing
// representation; neither HTTP transport nor ingest policy belongs to that state machine.
#include <HttpRequest_generated.h>
#include <HttpResponse_generated.h>
#include <TimerTick_generated.h>
#include <FlowNotice_generated.h>
#include <IngestRequest_generated.h>
#include <typedHostcall.hpp>
#include <algorithm>

namespace spacecraft_wire {
namespace R = sdn::runtime;
using Json = nlohmann::json;
constexpr const char* kProvider = "deep-space-spacecraft";
constexpr const char* kUrl = "https://ssd.jpl.nasa.gov/api/horizons.api";
constexpr const char* kVersion = "0.3.1";
// The composed flow runtime hands a node at most 64 frames per invocation
// (space-data-module-sdk flow_runtime.cpp kMaxInvocationFrames). An advance
// needs its state frame and every response of its stage in one invocation, so
// a stage carries at most 63 requests. flow.mjs `stages` advances carry a run.
constexpr size_t kStageRequests = 63;
constexpr const char* kHorizonsLicense = "LicenseRef-NASA-JPL-Horizons-PD";
constexpr const char* kSpiceLicense = "LicenseRef-NASA-NAIF-PDS-Public";
constexpr const char* kSpiceCredit = "SPICE kernels: NASA/JPL NAIF and the PDS NAIF node";
constexpr size_t kMaxSpkSources = 16, kMaxKernelFiles = 8;
constexpr int64_t kMaxKernelBytes = 32LL * 1024 * 1024; // one HttpResponse body
// Public NAIF directories that hold current cislunar mission kernels (README "Sources").
struct SpkSource { const char* url; const char* mission; const char* prefix; int files; };
inline constexpr SpkSource kDefaultSpkSources[] = {
  {"https://naif.jpl.nasa.gov/pub/naif/pds/data/lro-l-spice-6-v1.0/lrosp_1000/data/spk/", "lro", "lrorg_", 1},
  {"https://naif.jpl.nasa.gov/pub/naif/ARTEMIS/kernels/spk/", "artemis-ii", "art", 2},
};

inline int push(const char* port, const char* schema, const char* identifier,
                const char* root, const uint8_t* data, size_t size) {
  return plugin_push_output_ex(port, schema, identifier, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
      root, 0, 0, data, size);
}
inline int push_get(const std::string& url) {
  flatbuffers::FlatBufferBuilder b(256 + url.size());
  R::FinishHttpRequestBuffer(b, R::CreateHttpRequestDirect(b, "GET", url.c_str()));
  return push("request", "HttpRequest.fbs", "HREQ", "HttpRequest", b.GetBufferPointer(), b.GetSize());
}
// The verified HttpResponse envelope (a body up to kMaxKernelBytes), or nullptr
// with invalid-http-response.
inline const R::HttpResponse* response_on(const plugin_input_frame_t* f, std::string& error) {
  if (!f || !f->payload || f->payload_length < 8 || f->payload_length > uint64_t(kMaxKernelBytes) + 1024u * 1024u) {
    error = "invalid-http-response"; return nullptr;
  }
  flatbuffers::Verifier v(f->payload, f->payload_length, 64, 1000000, false);
  if (!R::VerifyHttpResponseBuffer(v)) { error = "invalid-http-response"; return nullptr; }
  return R::GetHttpResponse(f->payload);
}
// One request's transport failure: fetch-failed (ERROR), horizons-http-error
// (non-200 or empty BODY); nullptr when the body is usable.
inline const char* transport_error(const R::HttpResponse& r) {
  if (r.ERROR() && r.ERROR()->size()) return "fetch-failed";
  if (r.STATUS() != 200 || !r.BODY() || !r.BODY()->size()) return "horizons-http-error";
  return nullptr;
}
inline int notice(const char* port, R::flowNoticeKind kind, const std::string& reason,
                  uint64_t count, const std::vector<std::string>& items, uint64_t at) {
  R::FlowNoticeT n;
  n.KIND = kind; n.SCHEMA = "OEM.fbs"; n.PROVIDER_ID = kProvider; n.SOURCE_NAME = "catalogs";
  n.REASON = reason; n.COUNT = count; n.ITEMS = items; n.AT_MS = at;
  flatbuffers::FlatBufferBuilder b(1024);
  R::FinishFlowNoticeBuffer(b, R::FlowNotice::Pack(b, &n));
  return push(port, "FlowNotice.fbs", "FNTC", "FlowNotice", b.GetBufferPointer(), b.GetSize());
}
inline bool config(const sdm_piv::Config& in, uint64_t fired, Json& out, std::string& error) {
  const auto refuse = [&](const char* code) { error = code; return false; };
  if (!in.ok()) return refuse("invalid-config");
  if (in.kind("producer_peer_id") != R::configValueKind_String || in.string("producer_peer_id").empty())
    return refuse("missing-producer-peer-id");
  // The window planner uses only the day. FIRED_MS is UTC: floor to its UTC
  // calendar day and use that day label for now_tdb, not a sub-day UTC->TDB conversion.
  // This day conversion is independent of the flow's weekly refresh interval.
  // Keep the original millisecond timestamp separately for creation/provenance.
  if (fired > 60000000000000ULL) return refuse("invalid-tick-time");
  out = {{"now_tdb", sdn_time::format_iso_micro(int64_t(fired / 86400000ULL) * 86400000000LL).substr(0, 19)},
         {"retrieved_ms", fired}, {"producer_peer_id", std::string(in.string("producer_peer_id"))}};
  // `run_day` (String YYYY-MM-DD) plans as of that day instead of the tick's
  // (a replay or backfill); creation and provenance keep the tick's time.
  if (in.has("run_day")) {
    const std::string day(in.string("run_day"));
    double seconds;
    if (in.kind("run_day") != R::configValueKind_String || day.size() != 10 ||
        !horizons::parseCalendar(day + "T00:00:00", seconds)) return refuse("invalid-run-day");
    out["now_tdb"] = day + "T00:00:00";
  }
  if (in.has("objects")) {
    if (in.kind("objects") != R::configValueKind_NumberList) return refuse("invalid-objects");
    out["objects"] = Json::array();
    for (double id : in.numbers("objects")) {
      if (!std::isfinite(id) || id != std::floor(id) || id < INT32_MIN || id > INT32_MAX) return refuse("unknown-object");
      out["objects"].push_back(int64_t(id));
    }
  }
  if (in.has("page_rows")) {
    const double rows = in.number("page_rows");
    if (in.kind("page_rows") != R::configValueKind_Number || !std::isfinite(rows) ||
        rows != std::floor(rows) || rows <= 0 || rows > horizons::kMaxPageRows) return refuse("invalid-page-rows");
    out["page_rows"] = int64_t(rows);
  }
  // Discovery and SPICE: on by default for the full run, off for an explicit `objects` selection.
  if (in.has("discover") && in.kind("discover") != R::configValueKind_Bool) return refuse("invalid-discover");
  out["discover"] = in.has("discover") ? in.boolean("discover") : !in.has("objects");
  out["spk_sources"] = Json::array();
  if (in.has("spk_sources")) {
    if (in.kind("spk_sources") != R::configValueKind_TableList || in.tables("spk_sources") > kMaxSpkSources)
      return refuse("invalid-spk-sources");
    for (size_t i = 0; i < in.tables("spk_sources"); ++i) {
      const auto table = in.table("spk_sources", i);
      Json source = {{"files", 1}, {"max_bytes", kMaxKernelBytes}, {"prefix", ""}, {"mission", ""}};
      if (!table.has("url") || table.kind("url") != R::configValueKind_String) return refuse("invalid-spk-sources");
      const std::string url(table.string("url"));
      if (url.rfind("https://", 0) != 0 || url.back() != '/' || url.find_first_of("?#\"' ") != std::string::npos)
        return refuse("invalid-spk-sources");
      source["url"] = url;
      for (const char* field : {"prefix", "mission"}) if (table.has(field)) {
        if (table.kind(field) != R::configValueKind_String) return refuse("invalid-spk-sources");
        source[field] = std::string(table.string(field));
      }
      for (const char* field : {"files", "max_bytes"}) if (table.has(field)) {
        const double value = table.number(field);
        const double cap = std::string(field) == "files" ? double(kMaxKernelFiles) : double(kMaxKernelBytes);
        if (table.kind(field) != R::configValueKind_Number || !std::isfinite(value) || value != std::floor(value) ||
            value < 1 || value > cap) return refuse("invalid-spk-sources");
        source[field] = int64_t(value);
      }
      out["spk_sources"].push_back(source);
    }
  } else if (out["discover"].get<bool>()) {
    for (const auto& d : kDefaultSpkSources)
      out["spk_sources"].push_back({{"url", d.url}, {"mission", d.mission}, {"prefix", d.prefix},
          {"files", d.files}, {"max_bytes", kMaxKernelBytes}});
  }
  if (in.has("stage_requests")) {
    const double cap = in.number("stage_requests");
    if (in.kind("stage_requests") != R::configValueKind_Number || !std::isfinite(cap) || cap != std::floor(cap) ||
        cap < 1 || cap > double(kStageRequests)) return refuse("invalid-stage-requests");
    out["stage_requests"] = int64_t(cap);
  }
  if (in.has("limits")) {
    if (in.kind("limits") != R::configValueKind_TableList) return refuse("invalid-limits");
    out["limits"] = Json::object();
    for (size_t i = 0; i < in.tables("limits"); ++i) {
      const auto table = in.table("limits", i);
      const double id = table.number("id");
      if (!table.has("id") || table.kind("id") != R::configValueKind_Number || !std::isfinite(id) ||
          id != std::floor(id) || id < INT32_MIN || id > INT32_MAX) return refuse("invalid-limits");
      const std::string key = std::to_string(int64_t(id));
      if (out["limits"].contains(key)) return refuse("invalid-limits");
      out["limits"][key] = Json::object();
      for (const char* field : {"start", "stop"}) if (table.has(field)) {
        if (table.kind(field) != R::configValueKind_String) return refuse("invalid-limit-time");
        out["limits"][key][field] = std::string(table.string(field));
      }
    }
  }
  return true;
}
inline std::string port_id(std::string id) {
  std::replace(id.begin(), id.end(), '-', '_');
  return id;
}
using Attributes = std::vector<std::pair<std::string, std::string>>;
inline int meta(const std::string& port, const char* schema, const char* source,
                const std::vector<uint8_t>& stream, uint64_t count, const Json& config,
                const Attributes& attributes, bool catalogs = false, bool spice = false) {
  const auto sha = ephem::sha256_hex(stream.data(), stream.size());
  const uint64_t retrieved = config["retrieved_ms"];
  R::IngestRequestT m;
  m.SCHEMA = schema; m.RECONCILE = R::reconcileMode_Current;
  m.TAGS = std::make_unique<R::SourceTagsT>();
  auto& tags = *m.TAGS;
  tags.PROVIDER_ID = kProvider; tags.SOURCE_NAME = source;
  tags.BATCH_ID = sha + (catalogs ? "@" + std::to_string(retrieved) : "");
  tags.SOURCE_URL = kUrl; tags.SOURCE_PEER = config["producer_peer_id"].get<std::string>();
  tags.LICENSE = spice ? std::string(kHorizonsLicense) + " AND " + kSpiceLicense : kHorizonsLicense;
  tags.CITATION = spice ? std::string("Ephemeris: NASA/JPL-Caltech Horizons; ") + kSpiceCredit : "Ephemeris: NASA/JPL-Caltech Horizons";
  m.PROVENANCE = std::make_unique<R::ProvenanceT>();
  auto& p = *m.PROVENANCE;
  p.SOURCE_URL = kUrl; p.HTTP_STATUS = 200; p.RETRIEVED_MS = retrieved;
  p.PARSER = kProvider; p.PARSER_VERSION = kVersion; p.NORMALIZED_SHA256 = sha;
  p.NORMALIZED_COUNT = count; p.SCHEMAS = {schema}; p.SCHEMA_COUNTS = {count};
  for (const auto& entry : attributes) {
    auto a = std::make_unique<R::HeaderT>(); a->NAME = entry.first; a->VALUE = entry.second;
    p.ATTRIBUTES.push_back(std::move(a));
  }
  flatbuffers::FlatBufferBuilder b(2048);
  R::FinishIngestRequestBuffer(b, R::IngestRequest::Pack(b, &m));
  return push(port.c_str(), "IngestRequest.fbs", "INGQ", "IngestRequest", b.GetBufferPointer(), b.GetSize());
}
} // namespace spacecraft_wire
