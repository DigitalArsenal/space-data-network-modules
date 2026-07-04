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

}  // namespace

extern "C" {

// gp: timer tick -> GP catalog fetch request + job.
int gp(void) {
    return emit_single("request", "job", "celestrak_gp_url", kDefaultGPURL, "celestrak-gp",
                       "catalog.csv");
}

// satcat: timer tick -> BOTH the legacy fixed-width and CSV snapshot fetches
// (the runner ingests both sources per satcat sync).
int satcat(void) {
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
    return emit_single("request", "job", "celestrak_space_weather_url", kDefaultSpaceWeatherURL,
                       "celestrak-space-weather", "SW-All.csv");
}

}  // extern "C"
