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
inline const R::HttpResponse* response_on(const plugin_input_frame_t* f, std::string& error) {
  if (!f || !f->payload || f->payload_length < 8 || f->payload_length > 32u * 1024u * 1024u) {
    error = "invalid-http-response"; return nullptr;
  }
  flatbuffers::Verifier v(f->payload, f->payload_length, 64, 1000000, false);
  if (!R::VerifyHttpResponseBuffer(v)) { error = "invalid-http-response"; return nullptr; }
  const auto* r = R::GetHttpResponse(f->payload);
  if (r->ERROR() && r->ERROR()->size()) { error = "fetch-failed"; return nullptr; }
  if (r->STATUS() != 200 || !r->BODY() || !r->BODY()->size()) {
    error = "horizons-http-error"; return nullptr;
  }
  return r;
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
                const Attributes& attributes, bool catalogs = false) {
  const auto sha = ephem::sha256_hex(stream.data(), stream.size());
  const uint64_t retrieved = config["retrieved_ms"];
  R::IngestRequestT m;
  m.SCHEMA = schema; m.RECONCILE = R::reconcileMode_Current;
  m.TAGS = std::make_unique<R::SourceTagsT>();
  auto& tags = *m.TAGS;
  tags.PROVIDER_ID = kProvider; tags.SOURCE_NAME = source;
  tags.BATCH_ID = sha + (catalogs ? "@" + std::to_string(retrieved) : "");
  tags.SOURCE_URL = kUrl; tags.SOURCE_PEER = config["producer_peer_id"].get<std::string>();
  tags.LICENSE = "LicenseRef-NASA-JPL-Horizons-PD"; tags.CITATION = "Ephemeris: NASA/JPL-Caltech Horizons";
  m.PROVENANCE = std::make_unique<R::ProvenanceT>();
  auto& p = *m.PROVENANCE;
  p.SOURCE_URL = kUrl; p.HTTP_STATUS = 200; p.RETRIEVED_MS = retrieved;
  p.PARSER = kProvider; p.PARSER_VERSION = "0.2.0"; p.NORMALIZED_SHA256 = sha;
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
