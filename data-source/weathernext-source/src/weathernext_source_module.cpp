/*
 * data-source/weathernext-source.
 *
 * Request-builder flow nodes for a machine-learned global ensemble weather
 * forecast source served as Zarr v3 objects from an allow-listed cloud
 * bucket. A module cron TIMER tick enters on "tick"; the methods emit the
 * hostcap/http-request request JSON plus the matching parser "job" JSON.
 * EVERYTHING is node CONFIG (the builtin plugin.getConfig hostcall — the
 * host's flow-service config block), never host code:
 *
 *   weathernext_live_access      false  THE live switch. false: no request,
 *                                       no job, no secrets.get, one status
 *                                       frame {"skipped":"live-access-disabled"}.
 *   weathernext_auth_mode        bearer none | bearer | refresh-token (reserved)
 *   weathernext_secrets_lane     gcp-weathernext
 *   weathernext_gcs_base_url     https://storage.googleapis.com/weathernext3_spatial
 *   weathernext_store_path       ""     required when live (store-path-missing)
 *   weathernext_arrays           low_cloud_cover,medium_cloud_cover,high_cloud_cover
 *   weathernext_init_time        ""     ISO 8601 UTC; else the previous
 *                                       00/06/12/18Z cycle at least 1 h ago
 *   weathernext_init_index       0
 *   weathernext_lead_hours       6      comma list
 *   weathernext_lead_step_hours  1      lead_index = lead_hours / step
 *   weathernext_member_kind      Member
 *   weathernext_member_index     0
 *   weathernext_ensemble_size    64
 *   weathernext_horizon_hours    360
 *   weathernext_chunks           14,7   "lat,lon" pairs separated by ";"
 *   weathernext_chunk_lat/lon    64
 *   weathernext_dtype            float32
 *   weathernext_codecs           bytes  comma list, outermost last
 *   weathernext_dims             init_time,member,lead_time,latitude,longitude
 *   weathernext_grid_*           lat0 90, lon0 0, dlat -0.1, dlon 0.1,
 *                                nlat 1801, nlon 3600, periodic_lon true
 *   weathernext_model_id         weathernext-3
 *   weathernext_model_version    ""
 *   weathernext_cyclone_url      ""     cyclone lane: {"skipped":"cyclone-url-missing"}
 *   weathernext_wind_averaging_period_s 60
 *   weathernext_http_timeout_ms  90000
 *   weathernext_provider_id      weathernext
 *   weathernext_publish_url      ""     publish_request emits nothing
 *   weathernext_license_realtime_url / weathernext_license_historical_url
 *   weathernext_citation         ""
 *
 * Nothing about the private bucket layout is hardcoded: anonymous reads are
 * refused (401/403), so chunk shape, codecs, dims and the store path are
 * operator-declared here and validated by size in the parser.
 *
 * CREDENTIAL. In bearer mode the operator's OAuth2 access token is read from
 * the machine-bound credential store lane with secrets.get and placed ONLY on
 * the request frames (authorization header), never on a job frame, and the
 * plaintext is wiped as soon as the request JSON is built. The host injects
 * nothing. This is the ONLY node in the flow holding the secrets capability,
 * so the parser sibling stays capabilities:[] and browser-instantiable.
 *
 * LICENCE. Decided per (init, lead) by this node, which owns the clock:
 * now - valid_time >= 1 h -> "Historical" (open attribution licence), else
 * "RealTimeExperimental" (experimental real-time terms). The parser copies
 * the class into the records and the ingest meta.
 */

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include <sys/time.h>

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

constexpr const char* kDefaultBaseURL = "https://storage.googleapis.com/weathernext3_spatial";
constexpr const char* kDefaultArrays = "low_cloud_cover,medium_cloud_cover,high_cloud_cover";
constexpr const char* kDefaultLeadHours = "6";
constexpr const char* kDefaultChunks = "14,7";
constexpr const char* kDefaultDims = "init_time,member,lead_time,latitude,longitude";
constexpr const char* kDefaultCodecs = "bytes";
constexpr const char* kDefaultDtype = "float32";
constexpr const char* kDefaultModelID = "weathernext-3";
constexpr const char* kDefaultMemberKind = "Member";
constexpr const char* kDefaultSecretsLane = "gcp-weathernext";
constexpr const char* kDefaultProviderID = "weathernext";
constexpr const char* kDefaultRealtimeLicenseURL =
    "https://storage.googleapis.com/weathernext-public/terms-of-use.pdf";
constexpr const char* kDefaultHistoricalLicenseURL = "https://creativecommons.org/licenses/by/4.0/";
constexpr const char* kOriginID = "storage.googleapis.com";
constexpr const char* kCloudSourceName = "weathernext3-clouds-0p1deg";
constexpr const char* kCycloneSourceName = "weathernext3-cyclone-tracks";
constexpr const char* kCycloneArchiveName = "cyclone-tracks.csv";
constexpr const char* kModelClass = "MachineLearnedGlobalEnsemble";
constexpr long kDefaultTimeoutMs = 90000;
constexpr int64_t kRealTimeWindowMs = 3600000;

// ---------------------------------------------------------------------------
// JSON helpers (control metadata only).
// ---------------------------------------------------------------------------

bool is_ws(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

std::string trim(const std::string& s) {
    size_t b = 0, e = s.size();
    while (b < e && is_ws(s[b])) b++;
    while (e > b && is_ws(s[e - 1])) e--;
    return s.substr(b, e - b);
}

size_t json_value_start(const std::string& json, const std::string& key) {
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return std::string::npos;
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return std::string::npos;
    size_t i = colon + 1;
    while (i < json.size() && is_ws(json[i])) i++;
    return i;
}

bool json_string_field(const std::string& json, const std::string& key, std::string* out) {
    size_t i = json_value_start(json, key);
    if (i == std::string::npos || i >= json.size() || json[i] != '"') return false;
    i++;
    std::string value;
    while (i < json.size() && json[i] != '"') {
        if (json[i] == '\\' && i + 1 < json.size()) {
            const char n = json[i + 1];
            if (n == 'n') value.push_back('\n');
            else if (n == 't') value.push_back('\t');
            else if (n == 'r') value.push_back('\r');
            else value.push_back(n);
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
    const size_t i = json_value_start(json, key);
    if (i == std::string::npos || i >= json.size()) return false;
    const char c = json[i];
    if (c == '"') {
        // Tolerate a quoted number in operator config.
        char* end = nullptr;
        const double value = strtod(json.c_str() + i + 1, &end);
        if (end == json.c_str() + i + 1) return false;
        *out = value;
        return true;
    }
    if (c != '-' && (c < '0' || c > '9')) return false;
    char* end = nullptr;
    const double value = strtod(json.c_str() + i, &end);
    if (end == json.c_str() + i) return false;
    *out = value;
    return true;
}

bool json_bool_field(const std::string& json, const std::string& key, bool* out) {
    const size_t i = json_value_start(json, key);
    if (i == std::string::npos || i >= json.size()) return false;
    if (json.compare(i, 4, "true") == 0 || json.compare(i, 6, "\"true\"") == 0 ||
        json.compare(i, 3, "\"1\"") == 0 || json[i] == '1') {
        *out = true;
        return true;
    }
    if (json.compare(i, 5, "false") == 0 || json.compare(i, 7, "\"false\"") == 0 ||
        json.compare(i, 3, "\"0\"") == 0 || json[i] == '0') {
        *out = false;
        return true;
    }
    return false;
}

std::string json_escape(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (const char c : s) {
        if (c == '"' || c == '\\') { out.push_back('\\'); out.push_back(c); }
        else if (c == '\n') out += "\\n";
        else if (c == '\r') out += "\\r";
        else if (c == '\t') out += "\\t";
        else if (static_cast<unsigned char>(c) < 0x20) {
            char buf[8];
            std::snprintf(buf, sizeof(buf), "\\u%04x", c);
            out += buf;
        } else out.push_back(c);
    }
    return out;
}

std::string format_number(double v) {
    if (std::isfinite(v) && v == std::floor(v) && std::fabs(v) < 1e15) {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(v));
        return buf;
    }
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%.15g", v);
    if (strtod(buf, nullptr) != v) std::snprintf(buf, sizeof(buf), "%.17g", v);
    return buf;
}

std::vector<std::string> split(const std::string& text, char sep) {
    std::vector<std::string> out;
    std::string current;
    for (const char c : text) {
        if (c == sep) {
            const std::string t = trim(current);
            if (!t.empty()) out.push_back(t);
            current.clear();
        } else {
            current.push_back(c);
        }
    }
    const std::string t = trim(current);
    if (!t.empty()) out.push_back(t);
    return out;
}

std::string json_string_array(const std::vector<std::string>& items) {
    std::string out = "[";
    for (size_t i = 0; i < items.size(); i++) {
        if (i) out += ",";
        out += "\"" + json_escape(items[i]) + "\"";
    }
    return out + "]";
}

std::string json_number_array(const std::vector<double>& items) {
    std::string out = "[";
    for (size_t i = 0; i < items.size(); i++) {
        if (i) out += ",";
        out += format_number(items[i]);
    }
    return out + "]";
}

// ---------------------------------------------------------------------------
// Base64 (the http cap takes its body as bodyB64).
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

// ---------------------------------------------------------------------------
// Civil time (UTC; Unix milliseconds).
// ---------------------------------------------------------------------------

int64_t days_from_civil(int64_t y, int m, int d) {
    y -= m <= 2;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = static_cast<unsigned>(y - era * 400);
    const unsigned doy = (153u * static_cast<unsigned>(m + (m > 2 ? -3 : 9)) + 2u) / 5u +
                         static_cast<unsigned>(d) - 1u;
    const unsigned doe = yoe * 365u + yoe / 4u - yoe / 100u + doy;
    return era * 146097 + static_cast<int64_t>(doe) - 719468;
}

bool parse_iso_ms(const std::string& raw_in, int64_t* out_ms) {
    const std::string raw = trim(raw_in);
    if (raw.size() < 10 || raw[4] != '-' || raw[7] != '-') return false;
    const int y = atoi(raw.substr(0, 4).c_str());
    const int mo = atoi(raw.substr(5, 2).c_str());
    const int d = atoi(raw.substr(8, 2).c_str());
    int hh = 0, mm = 0;
    double ss = 0;
    if (raw.size() >= 16 && (raw[10] == 'T' || raw[10] == ' ') && raw[13] == ':') {
        hh = atoi(raw.substr(11, 2).c_str());
        mm = atoi(raw.substr(14, 2).c_str());
        if (raw.size() >= 19 && raw[16] == ':') ss = strtod(raw.substr(17).c_str(), nullptr);
    } else if (raw.size() != 10) {
        return false;
    }
    if (y < 1600 || mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    const int64_t seconds = days_from_civil(y, mo, d) * 86400 + hh * 3600 + mm * 60;
    *out_ms = seconds * 1000 + static_cast<int64_t>(std::llround(ss * 1000.0));
    return true;
}

int64_t now_unix_ms() {
    struct timeval tv;
    if (gettimeofday(&tv, nullptr) != 0) return 0;
    return static_cast<int64_t>(tv.tv_sec) * 1000 + static_cast<int64_t>(tv.tv_usec / 1000);
}

// The previous synoptic cycle (00/06/12/18Z) at least one hour before now.
int64_t default_init_time_ms(int64_t now_ms) {
    const int64_t cycle_ms = 6 * 3600000LL;
    const int64_t reference = now_ms - kRealTimeWindowMs;
    if (reference <= 0) return 0;
    return (reference / cycle_ms) * cycle_ms;
}

// ---------------------------------------------------------------------------
// Hostcall wire: u32 metaLen | meta JSON | u32 segCount | (u32 len | bytes)*.
// Response: u32 metaLen | {"ok":bool,"result":...}. Mirrors
// space-data-module-sdk/src/host/hostcallWire.js.
// ---------------------------------------------------------------------------

void wire_u32le(uint8_t* dst, uint32_t value) {
    dst[0] = static_cast<uint8_t>(value & 0xff);
    dst[1] = static_cast<uint8_t>((value >> 8) & 0xff);
    dst[2] = static_cast<uint8_t>((value >> 16) & 0xff);
    dst[3] = static_cast<uint8_t>((value >> 24) & 0xff);
}

uint32_t wire_rd32le(const uint8_t* src) {
    return static_cast<uint32_t>(src[0]) | (static_cast<uint32_t>(src[1]) << 8) |
           (static_cast<uint32_t>(src[2]) << 16) | (static_cast<uint32_t>(src[3]) << 24);
}

// ⛔ THE RETURN VALUE OF THIS FUNCTION CAN CARRY A SECRET (secrets.get). It is
// never pushed to an output port other than inside the request headers it was
// fetched for, never logged and never returned; callers extract one field and
// let the rest go out of scope.
std::string host_meta(const char* op, const std::string& payload_json) {
    std::vector<uint8_t> req(4 + payload_json.size() + 4, 0);
    wire_u32le(req.data(), static_cast<uint32_t>(payload_json.size()));
    if (!payload_json.empty()) {
        std::memcpy(req.data() + 4, payload_json.data(), payload_json.size());
    }
    wire_u32le(req.data() + 4 + payload_json.size(), 0u);
    sdm_host_call(reinterpret_cast<const uint8_t*>(op), static_cast<int32_t>(std::strlen(op)),
                  req.data(), static_cast<int32_t>(req.size()));
    const int32_t len = sdm_host_response_len();
    if (len <= 0) return std::string();
    std::vector<uint8_t> buf(static_cast<size_t>(len), 0);
    sdm_host_read_response(buf.data(), len);
    if (buf.size() < 4) return std::string();
    const uint32_t meta_len = wire_rd32le(buf.data());
    if (buf.size() < 4u + meta_len) return std::string();
    return std::string(reinterpret_cast<const char*>(buf.data() + 4), meta_len);
}

bool host_meta_ok(const std::string& meta) {
    return meta.find("\"ok\":true") != std::string::npos;
}

// plugin.getConfig builtin hostcall: the node-config JSON for this flow
// service (inside {"ok":true,"result":{...}}), or "{}" when the host provides
// none. Every key is read by name, so the wrapper is harmless.
std::string load_config() {
    const std::string meta = host_meta("plugin.getConfig", "{}");
    return meta.empty() ? "{}" : meta;
}

// ---------------------------------------------------------------------------
// Config accessors.
// ---------------------------------------------------------------------------

std::string config_string(const std::string& config, const char* key, const char* fallback) {
    std::string value;
    if (json_string_field(config, key, &value) && !value.empty()) return value;
    return fallback;
}

double config_number(const std::string& config, const char* key, double fallback) {
    double v = 0;
    if (json_number_field(config, key, &v)) return v;
    return fallback;
}

bool config_bool(const std::string& config, const char* key, bool fallback) {
    bool v = false;
    if (json_bool_field(config, key, &v)) return v;
    return fallback;
}

// ---------------------------------------------------------------------------
// Frame IO.
// ---------------------------------------------------------------------------

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

int push_status(const char* reason) {
    return push_json("status", std::string("{\"skipped\":\"") + reason + "\"}") < 0 ? 500 : 0;
}

// ---------------------------------------------------------------------------
// SURPLUS-FRAME REFUSAL — graph task `modules-guest-nodes-drop-batched-frames`.
// The compiled runtime drains a node's queue PORT-BLIND up to a budget of 64
// while maxStreams stays declarative; a guest that read ordinal 0 of a port
// and returned would destroy the rest silently. The tick methods turn ONE tick
// into one plan and publish_request pairs ONE result with ONE meta, so a
// surplus is refused by name.
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

// ---------------------------------------------------------------------------
// Auth. Returns 0 and fills *header_json (either "" or the "headers":{...}
// fragment) or a non-zero status after plugin_set_error. The plaintext token
// lives only inside the returned fragment.
// ---------------------------------------------------------------------------
int resolve_auth_headers(const std::string& config, std::string* header_json) {
    header_json->clear();
    const std::string mode = config_string(config, "weathernext_auth_mode", "bearer");
    if (mode == "none") return 0;
    if (mode == "bearer") {
        const std::string lane = config_string(config, "weathernext_secrets_lane", kDefaultSecretsLane);
        const std::string meta = host_meta("secrets.get", "{\"id\":\"" + json_escape(lane) + "\"}");
        std::string token;
        if (host_meta_ok(meta)) json_string_field(meta, "secret", &token);
        if (token.empty()) {
            plugin_set_error("credential-unavailable",
                             ("no access token is stored in credential lane \"" + lane +
                              "\" on this node, or this module is not approved for secrets:" + lane)
                                 .c_str());
            return 403;
        }
        *header_json = ",\"headers\":{\"authorization\":\"Bearer " + json_escape(token) + "\"}";
        // The plaintext's lifetime ends here; only the header fragment carries
        // it, and that travels to the http node alone.
        std::fill(token.begin(), token.end(), '\0');
        token.clear();
        return 0;
    }
    if (mode == "refresh-token") {
        plugin_set_error("auth-mode-unsupported",
                         "weathernext_auth_mode \"refresh-token\" is reserved: the two-hop OAuth2 "
                         "exchange through hostcap/http-request is a follow-up; store an access "
                         "token and use \"bearer\", or \"none\" for a public mirror.");
        return 400;
    }
    plugin_set_error("auth-mode-unsupported",
                     ("weathernext_auth_mode \"" + mode + "\" is not one of none|bearer|refresh-token").c_str());
    return 400;
}

void wipe(std::string* s) {
    std::fill(s->begin(), s->end(), '\0');
    s->clear();
}

struct Provenance {
    std::string provider_id;
    std::string model_id;
    std::string model_version;
    std::string citation;
    std::string realtime_url;
    std::string historical_url;
};

Provenance read_provenance(const std::string& config) {
    Provenance p;
    p.provider_id = config_string(config, "weathernext_provider_id", kDefaultProviderID);
    p.model_id = config_string(config, "weathernext_model_id", kDefaultModelID);
    p.model_version = config_string(config, "weathernext_model_version", "");
    p.citation = config_string(config, "weathernext_citation", "");
    p.realtime_url = config_string(config, "weathernext_license_realtime_url", kDefaultRealtimeLicenseURL);
    p.historical_url = config_string(config, "weathernext_license_historical_url", kDefaultHistoricalLicenseURL);
    return p;
}

// now - valid >= 1 h -> Historical, else RealTimeExperimental.
bool is_historical(int64_t now_ms, int64_t valid_ms) { return now_ms - valid_ms >= kRealTimeWindowMs; }

std::string license_fragment(const Provenance& p, bool historical) {
    return std::string(",\"license_class\":\"") + (historical ? "Historical" : "RealTimeExperimental") +
           "\",\"license_url\":\"" + json_escape(historical ? p.historical_url : p.realtime_url) +
           "\",\"citation\":\"" + json_escape(p.citation) + "\"";
}

std::string request_json(const std::string& url, const std::string& header_json, long timeout_ms,
                         bool raw_body) {
    std::string out = "{\"method\":\"GET\",\"url\":\"" + json_escape(url) + "\"" + header_json +
                      ",\"timeoutMs\":" + std::to_string(timeout_ms);
    if (raw_body) out += ",\"responseWire\":\"raw-body-v1\"";
    return out + "}";
}

}  // namespace

extern "C" {

// plan: timer tick -> N chunk fetch requests + N positional parse jobs, or
// one status frame when the cycle is skipped.
int plan(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

    const std::string config = load_config();
    if (!config_bool(config, "weathernext_live_access", false)) {
        // No network, no secrets.get: the dev daemon and every test run here.
        return push_status("live-access-disabled");
    }
    const std::string store_path = config_string(config, "weathernext_store_path", "");
    if (store_path.empty()) {
        plugin_set_error("store-path-missing",
                         "weathernext_live_access is true but weathernext_store_path is empty; the "
                         "Zarr store path inside the bucket is operator-declared, never guessed.");
        return 400;
    }

    std::string header_json;
    const int auth_status = resolve_auth_headers(config, &header_json);
    if (auth_status != 0) return auth_status;

    const std::string base_url = config_string(config, "weathernext_gcs_base_url", kDefaultBaseURL);
    const std::vector<std::string> arrays = split(config_string(config, "weathernext_arrays", kDefaultArrays), ',');
    const std::vector<std::string> lead_texts = split(config_string(config, "weathernext_lead_hours", kDefaultLeadHours), ',');
    const std::vector<std::string> chunk_pairs = split(config_string(config, "weathernext_chunks", kDefaultChunks), ';');
    const std::vector<std::string> codecs = split(config_string(config, "weathernext_codecs", kDefaultCodecs), ',');
    const std::vector<std::string> dims = split(config_string(config, "weathernext_dims", kDefaultDims), ',');
    const std::string dtype = config_string(config, "weathernext_dtype", kDefaultDtype);
    const std::string member_kind = config_string(config, "weathernext_member_kind", kDefaultMemberKind);
    const double init_index = config_number(config, "weathernext_init_index", 0);
    const double member_index = config_number(config, "weathernext_member_index", 0);
    const double ensemble_size = config_number(config, "weathernext_ensemble_size", 64);
    const double horizon_hours = config_number(config, "weathernext_horizon_hours", 360);
    const double lead_step = config_number(config, "weathernext_lead_step_hours", 1);
    const double chunk_lat = config_number(config, "weathernext_chunk_lat", 64);
    const double chunk_lon = config_number(config, "weathernext_chunk_lon", 64);
    const double lat0 = config_number(config, "weathernext_grid_lat0", 90);
    const double lon0 = config_number(config, "weathernext_grid_lon0", 0);
    const double dlat = config_number(config, "weathernext_grid_dlat", -0.1);
    const double dlon = config_number(config, "weathernext_grid_dlon", 0.1);
    const double nlat = config_number(config, "weathernext_grid_nlat", 1801);
    const double nlon = config_number(config, "weathernext_grid_nlon", 3600);
    const bool periodic_lon = config_bool(config, "weathernext_grid_periodic_lon", true);
    const long timeout_ms = static_cast<long>(config_number(config, "weathernext_http_timeout_ms", kDefaultTimeoutMs));
    const Provenance provenance = read_provenance(config);

    const int64_t now_ms = now_unix_ms();
    int64_t init_ms = 0;
    {
        const std::string init_text = config_string(config, "weathernext_init_time", "");
        if (init_text.empty()) init_ms = default_init_time_ms(now_ms);
        else if (!parse_iso_ms(init_text, &init_ms)) {
            wipe(&header_json);
            plugin_set_error("init-time-invalid",
                             ("weathernext_init_time \"" + init_text + "\" is not ISO 8601 UTC").c_str());
            return 400;
        }
    }
    if (arrays.empty() || lead_texts.empty() || chunk_pairs.empty() || lead_step <= 0 || chunk_lat < 1 ||
        chunk_lon < 1) {
        wipe(&header_json);
        plugin_set_error("plan-config-invalid",
                         "weathernext_arrays, weathernext_lead_hours, weathernext_chunks, "
                         "weathernext_lead_step_hours and the chunk extents must all be non-empty and positive.");
        return 400;
    }

    // Chunk shape in dims order: 1 on every non-spatial dimension.
    std::vector<double> chunk_shape(dims.size(), 1.0);
    int lat_dim = -1, lon_dim = -1;
    for (size_t i = 0; i < dims.size(); i++) {
        if (dims[i] == "latitude") { lat_dim = static_cast<int>(i); chunk_shape[i] = chunk_lat; }
        if (dims[i] == "longitude") { lon_dim = static_cast<int>(i); chunk_shape[i] = chunk_lon; }
    }
    int init_dim = -1, member_dim = -1, lead_dim = -1;
    for (size_t i = 0; i < dims.size(); i++) {
        if (dims[i] == "init_time") init_dim = static_cast<int>(i);
        if (dims[i] == "member") member_dim = static_cast<int>(i);
        if (dims[i] == "lead_time") lead_dim = static_cast<int>(i);
    }
    if (lat_dim < 0 || lon_dim < 0) {
        wipe(&header_json);
        plugin_set_error("plan-config-invalid", "weathernext_dims must name latitude and longitude.");
        return 400;
    }

    const std::string grid_json = "{\"lat0\":" + format_number(lat0) + ",\"lon0\":" + format_number(lon0) +
                                  ",\"dlat\":" + format_number(dlat) + ",\"dlon\":" + format_number(dlon) +
                                  ",\"nlat\":" + format_number(nlat) + ",\"nlon\":" + format_number(nlon) +
                                  ",\"periodic_lon\":" + (periodic_lon ? "true" : "false") + "}";

    std::vector<std::string> requests;
    std::vector<std::string> jobs;
    for (const std::string& array : arrays) {
        for (const std::string& lead_text : lead_texts) {
            const double lead_hours = strtod(lead_text.c_str(), nullptr);
            const double lead_index = std::floor(lead_hours / lead_step + 0.5);
            const int64_t valid_ms = init_ms + static_cast<int64_t>(std::llround(lead_hours * 3600000.0));
            const bool historical = is_historical(now_ms, valid_ms);
            for (const std::string& pair : chunk_pairs) {
                const std::vector<std::string> parts = split(pair, ',');
                if (parts.size() != 2) {
                    wipe(&header_json);
                    plugin_set_error("plan-config-invalid",
                                     ("weathernext_chunks entry \"" + pair + "\" is not \"lat,lon\"").c_str());
                    return 400;
                }
                const double lat_chunk = strtod(parts[0].c_str(), nullptr);
                const double lon_chunk = strtod(parts[1].c_str(), nullptr);

                // Chunk key in dims order: c/<init>/<member>/<lead>/<lat>/<lon>.
                std::vector<double> chunk_index(dims.size(), 0.0);
                if (init_dim >= 0) chunk_index[init_dim] = init_index;
                if (member_dim >= 0) chunk_index[member_dim] = member_index;
                if (lead_dim >= 0) chunk_index[lead_dim] = lead_index;
                chunk_index[lat_dim] = lat_chunk;
                chunk_index[lon_dim] = lon_chunk;
                std::string key = "c";
                for (const double idx : chunk_index) key += "/" + format_number(idx);
                const std::string url = base_url + "/" + store_path + "/" + array + "/" + key;

                requests.push_back(request_json(url, header_json, timeout_ms, /*raw_body=*/true));
                jobs.push_back(
                    "{\"source_url\":\"" + json_escape(url) + "\"" +
                    ",\"source_name\":\"" + kCloudSourceName + "\"" +
                    ",\"provider_id\":\"" + json_escape(provenance.provider_id) + "\"" +
                    ",\"array\":\"" + json_escape(array) + "\"" +
                    ",\"variable_name\":\"" + json_escape(array) + "\"" +
                    ",\"model_id\":\"" + json_escape(provenance.model_id) + "\"" +
                    ",\"model_version\":\"" + json_escape(provenance.model_version) + "\"" +
                    ",\"model_class\":\"" + kModelClass + "\"" +
                    ",\"init_time_ms\":" + std::to_string(init_ms) +
                    ",\"lead_hours\":" + format_number(lead_hours) +
                    ",\"horizon_hours\":" + format_number(horizon_hours) +
                    ",\"member_kind\":\"" + json_escape(member_kind) + "\"" +
                    ",\"member_index\":" + format_number(member_index) +
                    ",\"ensemble_size\":" + format_number(ensemble_size) +
                    ",\"dtype\":\"" + json_escape(dtype) + "\"" +
                    ",\"codecs\":" + json_string_array(codecs) +
                    ",\"chunk_shape\":" + json_number_array(chunk_shape) +
                    ",\"chunk_index\":" + json_number_array(chunk_index) +
                    ",\"dims\":" + json_string_array(dims) +
                    ",\"grid\":" + grid_json +
                    license_fragment(provenance, historical) +
                    ",\"origin_id\":\"" + kOriginID + "\"" +
                    ",\"dataset_id\":\"weathernext3_spatial\"}");
            }
        }
    }
    wipe(&header_json);

    for (const std::string& request : requests) {
        if (push_json("requests", request) < 0) return 500;
    }
    for (const std::string& job : jobs) {
        if (push_json("jobs", job) < 0) return 500;
    }
    return 0;
}

// cyclone_request: timer tick -> cyclone track CSV fetch request + job, or a
// status frame when the cycle is skipped.
int cyclone_request(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

    const std::string config = load_config();
    if (!config_bool(config, "weathernext_live_access", false)) {
        return push_status("live-access-disabled");
    }
    const std::string url = config_string(config, "weathernext_cyclone_url", "");
    if (url.empty()) return push_status("cyclone-url-missing");

    std::string header_json;
    const int auth_status = resolve_auth_headers(config, &header_json);
    if (auth_status != 0) return auth_status;

    const Provenance provenance = read_provenance(config);
    const long timeout_ms = static_cast<long>(config_number(config, "weathernext_http_timeout_ms", kDefaultTimeoutMs));
    const double ensemble_size = config_number(config, "weathernext_ensemble_size", 64);
    const double wind_period = config_number(config, "weathernext_wind_averaging_period_s", 60);
    // Track rows carry their own valid times; the licence class of the fetch
    // is decided from the configured init time (the run being fetched) or,
    // absent one, from the previous synoptic cycle — both at least one hour old.
    const int64_t now_ms = now_unix_ms();
    int64_t init_ms = 0;
    {
        const std::string init_text = config_string(config, "weathernext_init_time", "");
        if (init_text.empty() || !parse_iso_ms(init_text, &init_ms)) init_ms = default_init_time_ms(now_ms);
    }
    const bool historical = is_historical(now_ms, init_ms);

    const std::string request = request_json(url, header_json, timeout_ms, /*raw_body=*/false);
    wipe(&header_json);
    const std::string job =
        "{\"source_url\":\"" + json_escape(url) + "\"" +
        ",\"source_name\":\"" + kCycloneSourceName + "\"" +
        ",\"provider_id\":\"" + json_escape(provenance.provider_id) + "\"" +
        ",\"archive_source\":\"weathernext\"" +
        ",\"archive_name\":\"" + kCycloneArchiveName + "\"" +
        ",\"model_id\":\"" + json_escape(provenance.model_id) + "\"" +
        ",\"model_version\":\"" + json_escape(provenance.model_version) + "\"" +
        ",\"model_class\":\"" + kModelClass + "\"" +
        ",\"ensemble_size\":" + format_number(ensemble_size) +
        ",\"wind_averaging_period_s\":" + format_number(wind_period) +
        license_fragment(provenance, historical) +
        ",\"origin_id\":\"" + kOriginID + "\"" +
        ",\"dataset_id\":\"weathernext3_spatial\"}";
    if (push_json("request", request) < 0) return 500;
    if (push_json("job", job) < 0) return 500;
    return 0;
}

// publish_request: (storage-ingest result, parser ingest meta) -> the
// hostcap/http-request JSON that POSTs a DatasetPublicationRequest to the
// node's loopback admin endpoint. Fail-closed: no weathernext_publish_url,
// no frame. Body keys are camelCase (API-synthesized shape, decoded with
// DisallowUnknownFields), never an SDS record.
int publish_request(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

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

    const std::string config = load_config();
    std::string url;
    if (!json_string_field(config, "weathernext_publish_url", &url) || url.empty()) {
        // Absence of configuration is NOT permission to publish.
        return 0;
    }

    const std::string result(reinterpret_cast<const char*>(result_frame->payload), result_frame->payload_length);
    const std::string meta(reinterpret_cast<const char*>(meta_frame->payload), meta_frame->payload_length);

    std::string schema;
    if (!json_string_field(result, "schema", &schema) || schema.empty()) json_string_field(meta, "schema", &schema);
    std::string batch_id;
    if (!json_string_field(result, "batch_id", &batch_id) || batch_id.empty()) json_string_field(meta, "batch_id", &batch_id);
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
    const long timeout_ms = static_cast<long>(config_number(config, "weathernext_http_timeout_ms", kDefaultTimeoutMs));
    const std::string request =
        std::string("{\"method\":\"POST\",\"url\":\"") + json_escape(url) + "\"" +
        ",\"headers\":{\"content-type\":\"application/json\"}" + ",\"bodyB64\":\"" +
        base64_encode(reinterpret_cast<const uint8_t*>(body.data()), body.size()) + "\"" +
        ",\"timeoutMs\":" + std::to_string(timeout_ms) + "}";
    return push_json("request", request) < 0 ? 500 : 0;
}

}  // extern "C"
