/*
 * data-source/celestrak-request (typed contracts 1.0: FlatBuffers only, no JSON and no base64).
 *
 * Request-builder flow nodes: a module cron TIMER tick (TimerTick, TICK) enters on "tick"; each method emits the
 * hostcap/http-request HttpRequest (HREQ) whose CONTEXT carries the parser's job as ONE size-prefixed SDS $ICN record
 * (Ingest Connector: the lane's endpoint, source tags, upstream origin, dataset and usage terms). hostcap/http-request
 * echoes CONTEXT verbatim in its HttpResponse, so the parser reads the job from the response it parses: requests and
 * jobs are never paired by position and there is no job port. Source URLs default to the CelesTrak endpoints the
 * in-daemon ingest runner uses and are overridable via node CONFIG (plugin.getConfig as an SDS $PIV hostcall:
 * one ModuleConfig FlatBuffer on raw "config"), never via host code.
 *
 * Methods:
 *   gp       -> request                          (GP full catalog CSV)
 *   satcat   -> request_txt + request_csv        (legacy fixed-width + CSV snapshot)
 *   spw      -> request                          (SW-All.csv space weather)
 *   eop      -> request                          (EOP-All.csv Earth orientation)
 *   socrates -> request_minrange + request_maxprob (SOCRATES sort files)
 *
 *   publish_request -> request   (§19 dataset-publication trigger)
 *     Joins the hostcap/storage-ingest IngestResult (INGR) with the parser's IngestRequest (INGQ: the ONLY carrier of
 *     provider_id / source_name) and emits the HttpRequest that POSTs the publication to the node's loopback admin
 *     endpoint, its BODY one IngestResult FlatBuffer naming the stored batch. The DECISION to publish after a store is
 *     application policy and therefore lives here, in the flow, never in the host. Fail-closed: with no
 *     celestrak_publish_url in node CONFIG the method emits NOTHING - absence of configuration is not permission to
 *     publish; a REFUSED batch (nothing stored) is not published either.
 *
 *   cache_warm -> query          (materialize-on-ingest for the dataset's default query)
 *     A stored batch's IngestResult -> ONE $FSO QUERY_RECORDS control frame for hostcap/flatsql-query.
 */

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "HttpRequest_generated.h"
#include "IngestRequest_generated.h"
#include "IngestResult_generated.h"
// $ICN and $FSO (spacedatastandards.org lib/cpp/<CODE>/main_generated.h) are inlined ahead of this file by build.mjs.

namespace {

namespace A = sdn::runtime::Aligned;
namespace R = sdn::runtime;

// Runner defaults (internal/ingest/runner.go).
constexpr const char* kDefaultGPURL =
    "https://celestrak.org/NORAD/elements/gp.php?SPECIAL=full-catalog&FORMAT=csv";
constexpr const char* kDefaultSatcatURL = "https://celestrak.org/pub/satcat.txt";
constexpr const char* kDefaultSatcatCSVURL = "https://celestrak.org/pub/satcat.csv";
constexpr const char* kDefaultSpaceWeatherURL = "https://celestrak.org/SpaceData/SW-All.csv";
constexpr const char* kDefaultEOPURL = "https://celestrak.org/SpaceData/EOP-All.csv";
constexpr const char* kDefaultSocratesMinRangeURL = "https://celestrak.org/SOCRATES/sort-minRange.csv";
constexpr const char* kDefaultSocratesMaxProbURL = "https://celestrak.org/SOCRATES/sort-maxProb.csv";
constexpr double kDefaultTimeoutMs = 90000;  // runner HTTPTimeout default (90 s)

// Per-lane response byte budgets: HttpRequest.MAX_BYTES; the host errors past it, never truncates - a truncated catalog
// is never delivered as if complete. Overridable per lane via node CONFIG celestrak_<lane>_max_bytes.
constexpr double kDefaultGPMaxBytes = 67108864;       // 64 MiB full-catalog CSV
constexpr double kDefaultSatcatMaxBytes = 33554432;   // 32 MiB satcat txt/csv
constexpr double kDefaultSPWMaxBytes = 4194304;       // 4 MiB SW-All.csv
constexpr double kDefaultEOPMaxBytes = 4194304;       // 4 MiB EOP-All.csv
constexpr double kDefaultSocratesMaxBytes = 8388608;  // 8 MiB per SOCRATES sort

// Upstream origin registry. Provenance is structural: the producer is the ingesting node's signed $EPM, and the
// upstream ORIGIN rides on the job so the parser's ingest request can name the organisation the bytes came from. The
// licence text is quoted VERBATIM from the origin's usage-policy page (fetched once, 2026-09-03); it is not a grant of
// rights and must never be reworded here - an operator overrides it through node CONFIG celestrak_license /
// celestrak_license_url / celestrak_citation.
constexpr const char* kOriginID = "celestrak.org";
constexpr const char* kOriginName = "CelesTrak";
constexpr const char* kDefaultProviderID = "space-data-network-02";
constexpr const char* kDefaultLicense =
    "Only download the data you need, when you are going to use it, and only download data "
    "once per update.";
constexpr const char* kDefaultLicenseURL = "https://celestrak.org/usage-policy.php";
constexpr const char* kDefaultCitation =
    "CelesTrak Usage Policy, by Dr. T.S. Kelso, https://celestrak.org/usage-policy.php";

std::string format_number(double v) {
    char buf[32];
    if (v == static_cast<double>(static_cast<long long>(v))) std::snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(v));
    else std::snprintf(buf, sizeof(buf), "%.17g", v);
    return buf;
}

// ---------------------------------------------------------------------------
// Node config: plugin.getConfig as an SDS $PIV hostcall - one ModuleConfig (MCFG) FlatBuffer on raw "config", read in
// place through sdm_piv::get_config(). No config (or a host that provides none) reads as the defaults.
// ---------------------------------------------------------------------------

struct Config {
    sdm_piv::Config cfg;

    static std::string text_of(const sdn::runtime::ConfigEntry& e) {
        if (e.KIND() == sdn::runtime::configValueKind_String) return e.STRING_VALUE() ? e.STRING_VALUE()->str() : std::string();
        if (e.KIND() == sdn::runtime::configValueKind_Number) return format_number(e.NUMBER_VALUE());
        if (e.KIND() == sdn::runtime::configValueKind_Bool) return e.BOOL_VALUE() ? "true" : "false";
        return std::string();
    }
    // A non-empty string value, else `fallback` (the legacy reader treated an empty string as unset).
    std::string string(const char* key, const char* fallback) const {
        if (const sdn::runtime::ConfigEntry* e = cfg.entry(key)) {
            const std::string v = text_of(*e);
            return v.empty() ? fallback : v;
        }
        return fallback;
    }
    // A positive number (a numeric string is tolerated), else `fallback`.
    double positive(const char* key, double fallback) const {
        const sdn::runtime::ConfigEntry* e = cfg.entry(key);
        if (!e) return fallback;
        double v = 0;
        if (e->KIND() == sdn::runtime::configValueKind_Number) v = e->NUMBER_VALUE();
        else if (e->KIND() == sdn::runtime::configValueKind_String) {
            const std::string s = e->STRING_VALUE() ? e->STRING_VALUE()->str() : std::string();
            char* end = nullptr;
            v = strtod(s.c_str(), &end);
            if (end == s.c_str()) return fallback;
        } else return fallback;
        return v > 0 ? v : fallback;
    }
};

Config load_config() { return Config{sdm_piv::get_config()}; }

// ---------------------------------------------------------------------------
// Frames.
// ---------------------------------------------------------------------------

using Bytes = std::vector<uint8_t>;

Bytes finished(const flatbuffers::FlatBufferBuilder& b) { return Bytes(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize()); }

const plugin_input_frame_t* frame_for(const char* port_id) {
    const int32_t index = plugin_find_input_index(port_id, 0);
    if (index < 0) return nullptr;
    return plugin_get_input_frame(static_cast<uint32_t>(index));
}

// An HttpRequest (HREQ). Headers are given lower-cased; the vector is written sorted by NAME (a FlatBuffers key).
Bytes http_request(const char* method, const std::string& url, std::vector<std::pair<std::string, std::string>> headers,
                   const Bytes* body, uint32_t timeout_ms, uint64_t max_bytes, const Bytes* context) {
    flatbuffers::FlatBufferBuilder b(512 + (body ? body->size() : 0) + (context ? context->size() : 0));
    std::sort(headers.begin(), headers.end());
    std::vector<flatbuffers::Offset<R::Header>> header_offsets;
    for (const auto& [name, value] : headers) header_offsets.push_back(R::CreateHeaderDirect(b, name.c_str(), value.c_str()));
    R::FinishHttpRequestBuffer(b, R::CreateHttpRequestDirect(b, method, url.c_str(), headers.empty() ? nullptr : &header_offsets,
                                                             body, timeout_ms, max_bytes, context));
    return finished(b);
}

int push_request(const char* port, const Bytes& request) {
    return plugin_push_output_ex(port, "HttpRequest.fbs", R::HttpRequestIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 "HttpRequest", 0, 0, request.data(), static_cast<uint32_t>(request.size()));
}

// The parser job: one size-prefixed $ICN record - the lane's connector (endpoint, target standard, the standards it
// emits), its source tags (provider, source name), the upstream origin and dataset, and the origin's usage terms.
Bytes icn_job(const Config& config, const std::string& url, const char* source_name, const char* dataset_id,
              const char* target_schema, const std::vector<const char*>& emits) {
    flatbuffers::FlatBufferBuilder b(1024);
    const auto connector_id = b.CreateString(source_name);
    const auto target = b.CreateString(target_schema);
    const auto endpoint = b.CreateString(url);
    const auto method = b.CreateString("GET");
    const auto origin_id = b.CreateString(kOriginID);
    const auto origin_name = b.CreateString(kOriginName);
    const auto dataset = b.CreateString(dataset_id);
    const auto provider = b.CreateString(config.string("celestrak_provider_id", kDefaultProviderID));
    const auto source = b.CreateString(source_name);
    const auto license = b.CreateString(config.string("celestrak_license", kDefaultLicense));
    const auto license_url = b.CreateString(config.string("celestrak_license_url", kDefaultLicenseURL));
    const auto citation = b.CreateString(config.string("celestrak_citation", kDefaultCitation));
    std::vector<flatbuffers::Offset<flatbuffers::String>> codes;
    for (const char* code : emits) codes.push_back(b.CreateString(code));
    const auto emits_off = b.CreateVector(codes);
    ICNBuilder r(b);
    r.add_CONNECTOR_ID(connector_id);
    r.add_KIND(icnConnectorKind_HttpsPull);
    r.add_TARGET_SCHEMA(target);
    r.add_ENDPOINT_URL(endpoint);
    r.add_HTTP_METHOD(method);
    r.add_POST_INGEST_ACTION(icnPostIngestAction_Archive);
    r.add_ORIGIN_ID(origin_id);
    r.add_ORIGIN_NAME(origin_name);
    r.add_DATASET_ID(dataset);
    r.add_PROVIDER_ID(provider);
    r.add_SOURCE_NAME(source);
    r.add_LICENSE(license);
    r.add_LICENSE_URL(license_url);
    r.add_CITATION(citation);
    r.add_EMITS_SCHEMAS(emits_off);
    FinishSizePrefixedICNBuffer(b, r.Finish());
    return finished(b);
}

struct Lane {
    const char* request_port;
    const char* url_key;
    const char* default_url;
    const char* source_name;
    const char* dataset_id;
    const char* target_schema;
    std::vector<const char*> emits;
};

// One GET per lane, its job in CONTEXT; the lane's byte budget from max_bytes_key.
int emit_lanes(const std::vector<Lane>& lanes, const char* max_bytes_key, double default_max_bytes) {
    const Config config = load_config();
    const uint32_t timeout = static_cast<uint32_t>(config.positive("celestrak_http_timeout_ms", kDefaultTimeoutMs));
    const uint64_t max_bytes = static_cast<uint64_t>(config.positive(max_bytes_key, default_max_bytes));
    for (const Lane& lane : lanes) {
        const std::string url = config.string(lane.url_key, lane.default_url);
        const Bytes job = icn_job(config, url, lane.source_name, lane.dataset_id, lane.target_schema, lane.emits);
        if (push_request(lane.request_port, http_request("GET", url, {}, nullptr, timeout, max_bytes, &job)) < 0) return 500;
    }
    return 0;
}

// ---------------------------------------------------------------------------
// SURPLUS-FRAME REFUSAL — graph task `modules-guest-nodes-drop-batched-frames`.
//
// `space_data_module_runtime_begin_node_invocation` (module-SDK src/flow/runtime-src/flow_runtime.cpp) fills an
// invocation by popping the node's queue PORT-BLIND, with a drain budget of 64; `maxStreams`, `maxBatch` and
// `drainPolicy` are DECLARATIVE in the compiled runtime. A guest that reads ordinal 0 of a port and returns DESTROYS
// every other frame it was handed on that port. The tick methods turn ONE timer tick into one fetch per lane, and
// publish_request / cache_warm pair ONE ingest result with ONE meta: a surplus is REFUSED by name rather than
// silently dropped.
// ---------------------------------------------------------------------------
bool find_batched_input_port(char* message, size_t message_len) {
    const uint32_t count = plugin_get_input_count();
    for (uint32_t i = 0; i < count; i++) {
        const plugin_input_frame_t* frame = plugin_get_input_frame(i);
        if (!frame || !frame->port_id) continue;
        for (uint32_t j = 0; j < i; j++) {
            const plugin_input_frame_t* earlier = plugin_get_input_frame(j);
            if (!earlier || !earlier->port_id) continue;
            if (std::strcmp(earlier->port_id, frame->port_id) != 0) continue;
            uint32_t on_port = 0;
            for (uint32_t k = 0; k < count; k++) {
                const plugin_input_frame_t* f = plugin_get_input_frame(k);
                if (f && f->port_id && std::strcmp(f->port_id, frame->port_id) == 0) on_port++;
            }
            std::snprintf(message, message_len,
                          "This invocation carries %u frames on single-stream input port \"%s\" "
                          "(the compiled flow runtime drains a node's whole queue port-blind; "
                          "maxStreams is declarative only). The surplus frames are refused "
                          "rather than silently discarded.",
                          on_port, frame->port_id);
            return true;
        }
    }
    return false;
}

bool refuse_batched() {
    char batch_message[384];
    if (!find_batched_input_port(batch_message, sizeof(batch_message))) return false;
    plugin_set_error("batched-input-frames", batch_message);
    return true;
}

// cache_warm defaults (Hermes contract section 1, generalisation rule): the plan node NEVER interpolates a
// caller-supplied value into the SQL; the LIMIT is a bound i64 parameter, so capabilities stay [].
constexpr const char* kDefaultCacheSql = "SELECT data FROM sds_omm ORDER BY rowid DESC LIMIT ?";
constexpr double kDefaultCacheMaxRows = 5000;

}  // namespace

extern "C" {

// gp: timer tick -> GP catalog fetch request (job in CONTEXT).
int gp(void) {
    if (refuse_batched()) return 500;
    return emit_lanes({{"request", "celestrak_gp_url", kDefaultGPURL, "celestrak-gp", "gp-full-catalog", "OMM.fbs", {"OMM", "MPE"}}},
                      "celestrak_gp_max_bytes", kDefaultGPMaxBytes);
}

// satcat: timer tick -> BOTH the legacy fixed-width and CSV snapshot fetches (the runner ingests both sources per sync).
int satcat(void) {
    if (refuse_batched()) return 500;
    return emit_lanes({{"request_txt", "celestrak_satcat_url", kDefaultSatcatURL, "celestrak-satcat", "satcat", "CAT.fbs", {"CAT"}},
                       {"request_csv", "celestrak_satcat_csv_url", kDefaultSatcatCSVURL, "celestrak-satcat-csv", "satcat-csv", "CAT.fbs", {"CAT"}}},
                      "celestrak_satcat_max_bytes", kDefaultSatcatMaxBytes);
}

// spw: timer tick -> space weather fetch request.
int spw(void) {
    if (refuse_batched()) return 500;
    return emit_lanes({{"request", "celestrak_space_weather_url", kDefaultSpaceWeatherURL, "celestrak-space-weather", "sw-all", "SPW.fbs", {"SPW"}}},
                      "celestrak_spw_max_bytes", kDefaultSPWMaxBytes);
}

// eop: timer tick -> Earth-orientation (EOP-All.csv) fetch request.
int eop(void) {
    if (refuse_batched()) return 500;
    return emit_lanes({{"request", "celestrak_eop_url", kDefaultEOPURL, "celestrak-eop", "eop-all", "EOP.fbs", {"EOP"}}},
                      "celestrak_eop_max_bytes", kDefaultEOPMaxBytes);
}

// socrates: timer tick -> BOTH SOCRATES sort files, each its own lane with its own snapshot batch.
int socrates(void) {
    if (refuse_batched()) return 500;
    return emit_lanes({{"request_minrange", "celestrak_socrates_minrange_url", kDefaultSocratesMinRangeURL, "celestrak-socrates-minrange",
                        "socrates-minrange", "CSM.fbs", {"CSM"}},
                       {"request_maxprob", "celestrak_socrates_maxprob_url", kDefaultSocratesMaxProbURL, "celestrak-socrates-maxprob",
                        "socrates-maxprob", "CSM.fbs", {"CSM"}}},
                      "celestrak_socrates_max_bytes", kDefaultSocratesMaxBytes);
}

// publish_request: the storage-ingest IngestResult + the parser's IngestRequest -> the dataset-publication POST
// (celestrak_publish_url, the node's loopback admin endpoint), its BODY the IngestResult naming the stored batch
// (SCHEMA, PROVIDER_ID, SOURCE_NAME, BATCH_ID, counts). Schema and batch from the result (the request's when the result
// lacks them), provider and source from the request. Nothing when the url is unset or the batch was REFUSED.
int publish_request(void) {
    if (refuse_batched()) return 500;
    const plugin_input_frame_t* result_frame = frame_for("result");
    if (!result_frame || !result_frame->payload || result_frame->payload_length == 0) {
        plugin_set_error("missing-result-frame", "publish_request requires the storage-ingest result frame.");
        return 400;
    }
    const plugin_input_frame_t* meta_frame = frame_for("meta");
    if (!meta_frame || !meta_frame->payload || meta_frame->payload_length == 0) {
        plugin_set_error("missing-meta-frame", "publish_request requires the parser ingest meta frame.");
        return 400;
    }
    flatbuffers::Verifier result_verifier(result_frame->payload, result_frame->payload_length);
    if (!R::VerifyIngestResultBuffer(result_verifier)) { plugin_set_error("invalid-result-frame", "the result frame is not an IngestResult (INGR)."); return 400; }
    flatbuffers::Verifier meta_verifier(meta_frame->payload, meta_frame->payload_length);
    if (!R::VerifyIngestRequestBuffer(meta_verifier)) { plugin_set_error("invalid-meta-frame", "the meta frame is not an IngestRequest (INGQ)."); return 400; }

    const Config config = load_config();
    const std::string url = config.string("celestrak_publish_url", "");
    // Fail-closed: absence of configuration is NOT permission to publish.
    if (url.empty()) return 0;
    const R::IngestResult& result = *R::GetIngestResult(result_frame->payload);
    const R::IngestRequest& meta = *R::GetIngestRequest(meta_frame->payload);
    if (result.REFUSED() && result.REFUSED()->size()) return 0;  // nothing stored, nothing to publish
    const auto text = [](const flatbuffers::String* s) { return s ? s->str() : std::string(); };
    std::string schema = text(result.SCHEMA()), batch_id = text(result.BATCH_ID());
    if (schema.empty()) schema = text(meta.SCHEMA());
    if (batch_id.empty()) batch_id = text(meta.TAGS()->BATCH_ID());
    const std::string provider = text(meta.TAGS()->PROVIDER_ID()), source = text(meta.TAGS()->SOURCE_NAME());
    if (schema.empty() || batch_id.empty() || provider.empty() || source.empty()) {
        plugin_set_error("incomplete-publication-identity", "publish_request needs schema, batchId, providerId and sourceName.");
        return 400;
    }
    flatbuffers::FlatBufferBuilder b(512);
    R::FinishIngestResultBuffer(b, R::CreateIngestResultDirect(b, schema.c_str(), provider.c_str(), source.c_str(), batch_id.c_str(), result.INSERTED(),
                                                               result.RECONCILED_DUPLICATES(), result.RECONCILED_OLD_BATCHES(),
                                                               result.ARCHIVED() && result.ARCHIVED()->size() ? result.ARCHIVED()->c_str() : nullptr, nullptr));
    const Bytes body = finished(b);
    const Bytes request = http_request("POST", url, {{"content-type", "application/octet-stream"}}, &body,
                                       static_cast<uint32_t>(config.positive("celestrak_http_timeout_ms", kDefaultTimeoutMs)), 0, nullptr);
    return push_request("request", request) < 0 ? 500 : 0;
}

// cache_warm: materialize-on-ingest for the dataset's default query (graph task
// sdn-dataset-default-query-materialized-cache, FOLLOW-UP C: celestrak catalog). A stored batch's IngestResult -> ONE
// $FSO QUERY_RECORDS control frame for hostcap/flatsql-query:query, so the engine's response artifact is warmed with
// exactly what was just persisted. Config: celestrak_cache_sql (default "SELECT data FROM sds_omm ORDER BY rowid DESC
// LIMIT ?"), celestrak_cache_max_rows (the bound LIMIT, default 5000) - FlatSQL's tagged parameter encoding, one i64.
int cache_warm(void) {
    if (refuse_batched()) return 500;
    const plugin_input_frame_t* result_frame = frame_for("result");
    if (result_frame == nullptr || result_frame->payload == nullptr || result_frame->payload_length == 0) {
        plugin_set_error("missing-result-frame", "cache_warm requires the storage-ingest result frame.");
        return 400;
    }
    flatbuffers::Verifier verifier(result_frame->payload, result_frame->payload_length);
    if (!R::VerifyIngestResultBuffer(verifier)) { plugin_set_error("invalid-result-frame", "the result frame is not an IngestResult (INGR)."); return 400; }
    const Config config = load_config();
    const std::string sql = config.string("celestrak_cache_sql", kDefaultCacheSql);
    const int64_t max_rows = static_cast<int64_t>(config.positive("celestrak_cache_max_rows", kDefaultCacheMaxRows));
    const std::vector<uint8_t> query(sql.begin(), sql.end());
    sdm_piv::SqlValues values;
    values.i64(max_rows);
    const std::vector<uint8_t> params(values.view().begin(), values.view().end());
    flatbuffers::FlatBufferBuilder b(256 + query.size());
    FinishFSOBuffer(b, CreateFSODirect(b, flatSqlNodeOperation_QUERY_RECORDS, 0, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr,
                                       nullptr, &query, &params, 1));
    return plugin_push_output_ex("query", "FSO.fbs", FSOIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "FSO", 0, 0,
                                 b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize())) < 0 ? 500 : 0;
}

}  // extern "C"
