/*
 * data-source/celestrak-request (loop C.8a).
 *
 * Request-builder flow nodes: a module cron TIMER tick enters on "tick";
 * each method emits the hostcap/http-request request JSON plus the matching
 * parser "job" JSON (attribution + archive naming). Source URLs default to
 * the CelesTrak endpoints the in-daemon ingest runner uses and are
 * overridable via node CONFIG (the builtin plugin.getConfig hostcall — the
 * host's flow-service config block), never via host code.
 *
 * Methods:
 *   gp     -> request/job                 (GP full catalog CSV)
 *   satcat -> request_txt/job_txt +
 *             request_csv/job_csv         (legacy fixed-width + CSV snapshot)
 *   spw    -> request/job                 (SW-All.csv space weather)
 *
 *   publish_request -> request            (§19 dataset-publication trigger)
 *     Joins the hostcap/storage-ingest "result" with the parser's ingest
 *     "meta" (the ONLY carrier of provider_id/source_name) and emits the
 *     hostcap/http-request JSON that POSTs a DatasetPublicationRequest to
 *     the node's loopback admin endpoint. The DECISION to publish after a
 *     store is application policy and therefore lives here, in the flow,
 *     never in the host. Fail-closed: with no celestrak_publish_url in node
 *     CONFIG the method emits NOTHING — absence of configuration is not
 *     permission to publish.
 */

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"

extern "C" {

__attribute__((import_module("space_data_module_host"), import_name("call")))
int32_t sdm_host_call(const uint8_t* op_ptr, int32_t op_len,
                      const uint8_t* payload_ptr, int32_t payload_len);
__attribute__((import_module("space_data_module_host"), import_name("response_len")))
int32_t sdm_host_response_len(void);
__attribute__((import_module("space_data_module_host"), import_name("read_response")))
int32_t sdm_host_read_response(uint8_t* dst_ptr, int32_t dst_len);

}  // extern "C"

namespace {

// Runner defaults (internal/ingest/runner.go).
constexpr const char* kDefaultGPURL =
    "https://celestrak.org/NORAD/elements/gp.php?SPECIAL=full-catalog&FORMAT=csv";
constexpr const char* kDefaultSatcatURL = "https://celestrak.org/pub/satcat.txt";
constexpr const char* kDefaultSatcatCSVURL = "https://celestrak.org/pub/satcat.csv";
constexpr const char* kDefaultSpaceWeatherURL = "https://celestrak.org/SpaceData/SW-All.csv";
constexpr long kDefaultTimeoutMs = 90000;  // runner HTTPTimeout default (90 s)

bool is_ws(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

bool json_string_field(const std::string& json, const std::string& key, std::string* out) {
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return false;
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return false;
    size_t i = colon + 1;
    while (i < json.size() && is_ws(json[i])) i++;
    if (i >= json.size() || json[i] != '"') return false;
    i++;
    std::string value;
    while (i < json.size() && json[i] != '"') {
        if (json[i] == '\\' && i + 1 < json.size()) {
            value.push_back(json[i + 1]);
            i += 2;
        } else {
            value.push_back(json[i]);
            i++;
        }
    }
    *out = value;
    return true;
}

bool json_number_field(const std::string& json, const std::string& key, double* out) {
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return false;
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return false;
    size_t i = colon + 1;
    while (i < json.size() && is_ws(json[i])) i++;
    if (i >= json.size()) return false;
    const char c = json[i];
    if (c != '-' && (c < '0' || c > '9')) return false;
    char* end = nullptr;
    const double value = strtod(json.c_str() + i, &end);
    if (end == json.c_str() + i) return false;
    *out = value;
    return true;
}

std::string json_escape(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (const char c : s) {
        if (c == '"' || c == '\\') { out.push_back('\\'); out.push_back(c); }
        else if (c == '\n') out += "\\n";
        else out.push_back(c);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Base64 (standard alphabet, padded). The http cap takes its body as bodyB64,
// never as a raw string; copied from hostcap/http-request.
// ---------------------------------------------------------------------------

const char kB64Alphabet[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string base64_encode(const uint8_t* data, size_t length) {
    std::string out;
    out.reserve(((length + 2) / 3) * 4);
    size_t i = 0;
    while (i + 3 <= length) {
        const uint32_t v = (static_cast<uint32_t>(data[i]) << 16) |
                           (static_cast<uint32_t>(data[i + 1]) << 8) | data[i + 2];
        out.push_back(kB64Alphabet[(v >> 18) & 0x3f]);
        out.push_back(kB64Alphabet[(v >> 12) & 0x3f]);
        out.push_back(kB64Alphabet[(v >> 6) & 0x3f]);
        out.push_back(kB64Alphabet[v & 0x3f]);
        i += 3;
    }
    const size_t remain = length - i;
    if (remain == 1) {
        const uint32_t v = static_cast<uint32_t>(data[i]) << 16;
        out.push_back(kB64Alphabet[(v >> 18) & 0x3f]);
        out.push_back(kB64Alphabet[(v >> 12) & 0x3f]);
        out.push_back('=');
        out.push_back('=');
    } else if (remain == 2) {
        const uint32_t v = (static_cast<uint32_t>(data[i]) << 16) |
                           (static_cast<uint32_t>(data[i + 1]) << 8);
        out.push_back(kB64Alphabet[(v >> 18) & 0x3f]);
        out.push_back(kB64Alphabet[(v >> 12) & 0x3f]);
        out.push_back(kB64Alphabet[(v >> 6) & 0x3f]);
        out.push_back('=');
    }
    return out;
}

// plugin.getConfig builtin hostcall: returns the node-config JSON for this
// flow service, or "{}" when the host provides none.
std::string load_config() {
    static const char* op = "plugin.getConfig";
    const std::string payload_json = "{}";
    std::vector<uint8_t> req(4 + payload_json.size() + 4, 0);
    const uint32_t meta_len = static_cast<uint32_t>(payload_json.size());
    req[0] = static_cast<uint8_t>(meta_len & 0xff);
    req[1] = static_cast<uint8_t>((meta_len >> 8) & 0xff);
    req[2] = static_cast<uint8_t>((meta_len >> 16) & 0xff);
    req[3] = static_cast<uint8_t>((meta_len >> 24) & 0xff);
    std::memcpy(req.data() + 4, payload_json.data(), payload_json.size());
    sdm_host_call(reinterpret_cast<const uint8_t*>(op),
                  static_cast<int32_t>(std::strlen(op)), req.data(),
                  static_cast<int32_t>(req.size()));
    const int32_t len = sdm_host_response_len();
    if (len <= 4) return "{}";
    std::vector<uint8_t> buf(static_cast<size_t>(len));
    sdm_host_read_response(buf.data(), len);
    const uint32_t rlen = static_cast<uint32_t>(buf[0]) | (static_cast<uint32_t>(buf[1]) << 8) |
                          (static_cast<uint32_t>(buf[2]) << 16) |
                          (static_cast<uint32_t>(buf[3]) << 24);
    if (buf.size() < 4u + rlen) return "{}";
    return std::string(reinterpret_cast<const char*>(buf.data() + 4), rlen);
}

std::string config_url(const std::string& config, const char* key, const char* fallback) {
    // Config responses are {"ok":true,"result":{...}}; the URL keys live in
    // the result object (or at top level for permissive hosts).
    std::string value;
    if (json_string_field(config, key, &value) && !value.empty()) return value;
    return fallback;
}

long config_timeout_ms(const std::string& config) {
    double v = 0;
    if (json_number_field(config, "celestrak_http_timeout_ms", &v) && v > 0) {
        return static_cast<long>(v);
    }
    return kDefaultTimeoutMs;
}

std::string provider_id(const std::string& config) {
    std::string value;
    if (json_string_field(config, "celestrak_provider_id", &value) && !value.empty()) return value;
    return "space-data-network-02";
}

// The input frame on a named port, or nullptr when the port carries none.
const plugin_input_frame_t* frame_for(const char* port_id) {
    const int32_t index = plugin_find_input_index(port_id, 0);
    if (index < 0) return nullptr;
    return plugin_get_input_frame(static_cast<uint32_t>(index));
}

int push_json(const char* port, const std::string& json) {
    return plugin_push_output_ex(port, nullptr, nullptr,
                                 PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                                 reinterpret_cast<const uint8_t*>(json.data()),
                                 static_cast<uint32_t>(json.size()));
}

std::string build_request_json(const std::string& url, long timeout_ms) {
    char timeout_buf[24];
    std::snprintf(timeout_buf, sizeof(timeout_buf), "%ld", timeout_ms);
    return std::string("{\"method\":\"GET\",\"url\":\"") + json_escape(url) +
           "\",\"timeoutMs\":" + timeout_buf + "}";
}

std::string build_job_json(const std::string& config, const std::string& url,
                           const char* source_name, const char* archive_source,
                           const char* archive_name) {
    return std::string("{\"source_url\":\"") + json_escape(url) + "\"" +
           ",\"source_name\":\"" + source_name + "\"" +
           ",\"provider_id\":\"" + json_escape(provider_id(config)) + "\"" +
           ",\"archive_source\":\"" + archive_source + "\"" +
           ",\"archive_name\":\"" + archive_name + "\"}";
}

int emit_single(const char* request_port, const char* job_port, const char* config_key,
                const char* default_url, const char* source_name, const char* archive_name) {
    const std::string config = load_config();
    const std::string url = config_url(config, config_key, default_url);
    if (push_json(request_port, build_request_json(url, config_timeout_ms(config))) < 0) return 500;
    if (push_json(job_port, build_job_json(config, url, source_name, "celestrak", archive_name)) < 0)
        return 500;
    return 0;
}

// ---------------------------------------------------------------------------
// SURPLUS-FRAME REFUSAL — graph task `modules-guest-nodes-drop-batched-frames`.
//
// `space_data_module_runtime_begin_node_invocation` (module-SDK
// src/flow/runtime-src/flow_runtime.cpp) fills an invocation by popping the
// node's queue `while (count < budget && !queue.empty())`: PORT-BLIND, with a
// drain budget of 64. `maxStreams`, `maxBatch` and `drainPolicy` are purely
// DECLARATIVE in the compiled runtime — enforced at compose time and in the
// JS-only reference runtime, never by the baked runtime.wasm. So a guest that
// reads ordinal 0 of a port and returns DESTROYS every other frame it was
// handed on that port: they are already dequeued, nothing re-delivers them,
// and nothing logs the loss.
//
// That is measured, not hypothetical. It was a live P1
// (`cellular-multiprovider-returns-only-first-provider`) that survived four
// passes precisely because a partial answer is indistinguishable from an
// honest one: a two-provider request performed exactly ONE outbound fetch and
// returned the first provider's records, byte-identical to that provider run
// alone, with no error anywhere.
//
// The tick methods turn ONE timer tick into one request/job pair, and
// `publish_request` pairs ONE ingest result with ONE meta. A second tick in an
// invocation would emit one fetch for two ticks; a second result would publish
// one PNM for two ingests, attributing the wrong meta to the wrong result.
//
// So a surplus is REFUSED rather than silently dropped — a named node error
// the flow surfaces, instead of an answer assembled from whichever frame the
// queue happened to hold first (queue order is not semantic order, so such an
// answer is arbitrary AND indistinguishable from a correct one). This costs
// nothing while the contract holds: one frame per port is what every deployed
// flow delivers today.
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

}  // namespace

extern "C" {

// gp: timer tick -> GP catalog fetch request + job.
int gp(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

    return emit_single("request", "job", "celestrak_gp_url", kDefaultGPURL, "celestrak-gp",
                       "catalog.csv");
}

// satcat: timer tick -> BOTH the legacy fixed-width and CSV snapshot fetches
// (the runner ingests both sources per satcat sync).
int satcat(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

    const std::string config = load_config();
    const long timeout = config_timeout_ms(config);
    const std::string txt_url = config_url(config, "celestrak_satcat_url", kDefaultSatcatURL);
    const std::string csv_url =
        config_url(config, "celestrak_satcat_csv_url", kDefaultSatcatCSVURL);
    if (push_json("request_txt", build_request_json(txt_url, timeout)) < 0) return 500;
    if (push_json("job_txt",
                  build_job_json(config, txt_url, "celestrak-satcat", "celestrak", "satcat.txt")) < 0)
        return 500;
    if (push_json("request_csv", build_request_json(csv_url, timeout)) < 0) return 500;
    if (push_json("job_csv", build_job_json(config, csv_url, "celestrak-satcat-csv", "celestrak",
                                            "satcat.csv")) < 0)
        return 500;
    return 0;
}

// spw: timer tick -> space weather fetch request + job.
int spw(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

    return emit_single("request", "job", "celestrak_space_weather_url", kDefaultSpaceWeatherURL,
                       "celestrak-space-weather", "SW-All.csv");
}

// publish_request: (storage-ingest result, parser ingest meta) -> the
// hostcap/http-request JSON that POSTs a DatasetPublicationRequest to the
// node's loopback admin endpoint
// (POST /api/v1/admin/dataset-updates/publish, gated by isLoopbackRemoteAddr).
//
// BOTH inputs are required: the storage-ingest result carries only
// schema/inserted/batch_id/reconciled_*/archived, while provider_id and
// source_name exist ONLY on the parser's meta.
//
// The body keys are camelCase because DatasetPublicationRequest is an
// API-synthesized shape (internal/api/dataset_publication.go), NOT an SDS
// record — and the handler decodes with DisallowUnknownFields, so no other
// key may appear.
int publish_request(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

    const plugin_input_frame_t* result_frame = frame_for("result");
    if (!result_frame || !result_frame->payload || result_frame->payload_length == 0) {
        plugin_set_error("missing-result-frame",
                         "publish_request requires the storage-ingest result frame.");
        return 400;
    }
    const plugin_input_frame_t* meta_frame = frame_for("meta");
    if (!meta_frame || !meta_frame->payload || meta_frame->payload_length == 0) {
        plugin_set_error("missing-meta-frame",
                         "publish_request requires the parser ingest meta frame.");
        return 400;
    }

    const std::string config = load_config();
    std::string url;
    if (!json_string_field(config, "celestrak_publish_url", &url) || url.empty()) {
        // Fail-closed. Absence of configuration is NOT permission to publish,
        // so no request frame is emitted and the downstream http node never
        // becomes ready.
        return 0;
    }

    const std::string result(reinterpret_cast<const char*>(result_frame->payload),
                             result_frame->payload_length);
    const std::string meta(reinterpret_cast<const char*>(meta_frame->payload),
                           meta_frame->payload_length);

    std::string schema;
    if (!json_string_field(result, "schema", &schema) || schema.empty()) {
        json_string_field(meta, "schema", &schema);
    }
    std::string batch_id;
    if (!json_string_field(result, "batch_id", &batch_id) || batch_id.empty()) {
        json_string_field(meta, "batch_id", &batch_id);
    }
    std::string provider;
    std::string source;
    json_string_field(meta, "provider_id", &provider);
    json_string_field(meta, "source_name", &source);
    if (schema.empty() || batch_id.empty() || provider.empty() || source.empty()) {
        plugin_set_error("incomplete-publication-identity",
                         "publish_request needs schema, batchId, providerId and sourceName.");
        return 400;
    }

    const std::string body = std::string("{\"schema\":\"") + json_escape(schema) + "\"" +
                             ",\"providerId\":\"" + json_escape(provider) + "\"" +
                             ",\"sourceName\":\"" + json_escape(source) + "\"" +
                             ",\"batchId\":\"" + json_escape(batch_id) + "\"}";

    char timeout_buf[24];
    std::snprintf(timeout_buf, sizeof(timeout_buf), "%ld", config_timeout_ms(config));
    const std::string request =
        std::string("{\"method\":\"POST\",\"url\":\"") + json_escape(url) + "\"" +
        ",\"headers\":{\"content-type\":\"application/json\"}" + ",\"bodyB64\":\"" +
        base64_encode(reinterpret_cast<const uint8_t*>(body.data()), body.size()) + "\"" +
        ",\"timeoutMs\":" + timeout_buf + "}";
    return push_json("request", request) < 0 ? 500 : 0;
}

}  // extern "C"
