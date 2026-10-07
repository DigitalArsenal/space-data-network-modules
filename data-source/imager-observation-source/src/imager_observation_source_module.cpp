/*
 * data-source/imager-observation-source.
 *
 * Request-builder flow nodes for geostationary imager observations in NOAA Open Data Dissemination's anonymous public
 * buckets (GOES-East noaa-goes19, GOES-West noaa-goes18: ABI L1b/L2 NetCDF4 under <product>/<YYYY>/<DDD>/<HH>/). No
 * credentials and no capabilities beyond the node config: the http connector does the fetching.
 *
 *   plan            : timer tick -> one S3 ListObjectsV2 request per (satellite, product folder) of the frame hour
 *                     + a list job each (or one status frame when skipped).
 *   select_files    : listings + list jobs -> each wanted field's file (the hour's first full-disk scan) as GET
 *                     requests, byte ranges when larger than imager_max_part_bytes, with a parse job per part - ONE FILE
 *                     PER INVOCATION, the rest yielded as backlog, so the parser holds one file and storage-ingest gets
 *                     one meta + one record stream at a time. Missing files / failed listings -> status.
 *   publish_request : storage-ingest result + parser meta -> the dataset-publication POST (imager_publish_url).
 *
 * Node CONFIG (plugin.getConfig): imager_live_access (default true), imager_satellites ("goes-east,goes-west"),
 * imager_fields (the five the world-clouds display reads), imager_widths ("4096,2048,1024"), imager_frame_time (ISO or
 * Unix ms; default the latest hour imager_lag_minutes (20) old), imager_max_part_bytes (64 MiB),
 * imager_list_timeout_ms (60000), imager_file_timeout_ms (300000), imager_publish_url (unset: no publication).
 */
#include <algorithm>
#include <cctype>
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

// ---------------------------------------------------------------------------
// JSON / base64 / date helpers, the hostcall wire, node config and frame IO: the same code as
// data-source/weathernext-source (control metadata only).
// ---------------------------------------------------------------------------
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
// Satellites and fields. A field is one variable of one product of the imager's L1b/L2 NetCDF4 files in the
// satellite's public bucket, under <product>/<YYYY>/<DDD>/<HH>/ (NOAA Open Data Dissemination layout).
// ---------------------------------------------------------------------------

struct Satellite { const char* id; const char* bucket; const char* sensor; };
const Satellite kSatellites[] = {
    {"goes-east", "noaa-goes19", "GOES-19 ABI"},
    {"goes-west", "noaa-goes18", "GOES-18 ABI"},
};

struct FieldSource { const char* field; const char* product; const char* band; const char* variable; };
const FieldSource kFieldSources[] = {
    {"brightness_temperature_10um", "ABI-L2-CMIPF", "C13", "CMI"},
    {"reflectance_064um", "ABI-L2-CMIPF", "C02", "CMI"},
    {"cloud_top_height", "ABI-L2-ACHA2KMF", "", "HT"},
    {"cloud_mask", "ABI-L2-ACMF", "", "ACM"},
    {"cloud_phase", "ABI-L2-ACTPF", "", "Phase"},
    {"cloud_optical_depth", "ABI-L2-COD2KMF", "", "COD"},
    {"cloud_effective_radius", "ABI-L2-CPSF", "", "CPS"},
    {"rain_rate", "ABI-L2-RRQPEF", "", "RRQPE"},
};

const Satellite* satellite_for(const std::string& id) {
    for (const Satellite& s : kSatellites) if (id == s.id) return &s;
    return nullptr;
}
const FieldSource* field_source(const std::string& field) {
    for (const FieldSource& f : kFieldSources) if (field == f.field) return &f;
    return nullptr;
}

constexpr const char* kDefaultSatellites = "goes-east,goes-west";
// the fields the world-clouds display reads (cloud cover, optical depth, daylight brightness, temperature, top height)
constexpr const char* kDefaultFields = "cloud_mask,cloud_optical_depth,reflectance_064um,brightness_temperature_10um,cloud_top_height";
constexpr const char* kDefaultWidths = "4096,2048,1024";
constexpr double kDefaultLagMinutes = 20;          // the hour's first full-disk scan and its L2 products are out by then
constexpr double kDefaultListTimeoutMs = 60000;
constexpr double kDefaultFileTimeoutMs = 300000;
constexpr double kDefaultMaxPartBytes = 64.0 * 1024 * 1024;   // each response well under the host's 100 MiB cap
constexpr const char* kProviderID = "noaa-goes";
constexpr const char* kOriginID = "NOAA Open Data Dissemination (AWS)";
constexpr const char* kLicenseID = "LicenseRef-NOAA-Open-Data";
constexpr const char* kLicenseURL = "https://www.ncei.noaa.gov/access/metadata/landing-page/bin/iso?id=gov.noaa.ncdc:C01502";
// The host adds the validators of the last 2xx for a URL to a GET (If-None-Match / If-Modified-Since) unless the
// request sets one; a repeat listing or a second byte range of the same object could then come back 304, empty.
// An If-Modified-Since at the epoch is always satisfied, so S3 answers 200 / 206 with the body.
constexpr const char* kNoValidators = "\"If-Modified-Since\":\"Thu, 01 Jan 1970 00:00:00 GMT\"";

std::string trim_copy(std::string s) {
    while (!s.empty() && is_ws(s.back())) s.pop_back();
    size_t at = 0;
    while (at < s.size() && is_ws(s[at])) at++;
    return s.substr(at);
}

std::vector<std::string> list_of(const std::string& text) {
    std::vector<std::string> out;
    for (const std::string& part : split(text, ',')) {
        const std::string t = trim_copy(part);
        if (!t.empty()) out.push_back(t);
    }
    return out;
}

// The UTC hour the cycle publishes: imager_frame_time (ISO 8601 or Unix ms) when set, else the latest hour whose first
// scan is imager_lag_minutes old.
bool frame_time_ms(const std::string& config, int64_t* out, std::string* err) {
    std::string set;
    if (json_string_field(config, "imager_frame_time", &set) && !set.empty()) {
        int64_t ms = 0;
        if (std::all_of(set.begin(), set.end(), ::isdigit)) ms = std::atoll(set.c_str());
        else if (!parse_iso_ms(set, &ms)) { *err = "imager_frame_time is neither ISO 8601 nor Unix ms: " + set; return false; }
        *out = ms - ms % 3600000;
        return true;
    }
    double n = 0;
    if (json_number_field(config, "imager_frame_time", &n) && n > 0) { const int64_t ms = static_cast<int64_t>(n); *out = ms - ms % 3600000; return true; }
    const int64_t now = now_unix_ms();
    if (now <= 0) { *err = "no clock"; return false; }
    const int64_t lag = static_cast<int64_t>(config_number(config, "imager_lag_minutes", kDefaultLagMinutes) * 60000.0);
    const int64_t t = now - lag;
    *out = t - ((t % 3600000) + 3600000) % 3600000;
    return true;
}

void civil(int64_t ms, int* year, int* doy, int* hour) {
    const int64_t days = ms / 86400000;
    int64_t z = days + 719468;
    const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    const int64_t doe = z - era * 146097;
    const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    int64_t y = yoe + era * 400;
    const int64_t doy_mar = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const int64_t mp = (5 * doy_mar + 2) / 153;
    const int64_t m = mp < 10 ? mp + 3 : mp - 9;
    if (m <= 2) y++;
    *year = static_cast<int>(y);
    *doy = static_cast<int>(days - days_from_civil(y, 1, 1) + 1);
    *hour = static_cast<int>((ms % 86400000) / 3600000);
}

std::string pad(int v, int width) {
    std::string s = std::to_string(v);
    while (static_cast<int>(s.size()) < width) s = "0" + s;
    return s;
}

std::string get_request(const std::string& url, const std::string& extra_headers, long timeout_ms) {
    return "{\"method\":\"GET\",\"url\":\"" + json_escape(url) + "\",\"headers\":{" + kNoValidators + extra_headers + "}" +
           ",\"timeoutMs\":" + std::to_string(timeout_ms) + ",\"responseWire\":\"raw-body-v1\"}";
}

// ---------------------------------------------------------------------------
// The S3 ListObjectsV2 XML: each <Contents> as (key, size).
// ---------------------------------------------------------------------------

struct Listed { std::string key; double size = 0; };

std::string xml_text(const std::string& xml, size_t from, size_t to, const char* tag) {
    const std::string open = std::string("<") + tag + ">", close = std::string("</") + tag + ">";
    const size_t a = xml.find(open, from);
    if (a == std::string::npos || a >= to) return std::string();
    const size_t b = xml.find(close, a);
    if (b == std::string::npos || b > to) return std::string();
    return xml.substr(a + open.size(), b - a - open.size());
}

std::vector<Listed> parse_listing(const std::string& xml) {
    std::vector<Listed> out;
    for (size_t at = xml.find("<Contents>"); at != std::string::npos; at = xml.find("<Contents>", at + 1)) {
        const size_t end = xml.find("</Contents>", at);
        if (end == std::string::npos) break;
        Listed l;
        l.key = xml_text(xml, at, end, "Key");
        l.size = std::atof(xml_text(xml, at, end, "Size").c_str());
        if (!l.key.empty()) out.push_back(l);
    }
    return out;
}

// The hour's first scan of a field: the key whose scan start stamp is _s<YYYY><DDD><HH>0 (minutes 00-09) and, for a
// multi-band product, whose mode-and-channel token is -M<n>C<band>_.
const Listed* pick_file(const std::vector<Listed>& listing, const std::string& stamp, const std::string& band) {
    const Listed* best = nullptr;
    for (const Listed& l : listing) {
        if (l.key.find(stamp) == std::string::npos) continue;
        if (!band.empty()) {
            const size_t at = l.key.find(band + "_");
            if (at == std::string::npos || at < 3 || l.key[at - 3] != '-' || l.key[at - 2] != 'M' || !::isdigit(l.key[at - 1])) continue;
        }
        if (!best || l.key < best->key) best = &l;   // (one scan per stamp; the earliest creation if NOAA reprocessed)
    }
    return best;
}

// ---------------------------------------------------------------------------
// The select backlog: one file (all its byte-range parts) is handed to the http node and the parser per invocation,
// so the parser's memory holds one file and storage-ingest receives one meta and one record stream at a time; the
// rest wait here and the node yields with them as its backlog (the compiled runtime resumes it without input).
// ---------------------------------------------------------------------------

struct PendingFile { std::vector<std::string> requests, jobs; };
std::vector<PendingFile> g_backlog;
size_t g_backlog_next = 0;

int emit_next_file() {
    if (g_backlog_next >= g_backlog.size()) { g_backlog.clear(); g_backlog_next = 0; plugin_set_backlog_remaining(0); plugin_set_yielded(0); return 0; }
    const PendingFile& f = g_backlog[g_backlog_next++];
    for (size_t k = 0; k < f.requests.size(); k++) {
        if (push_json("requests", f.requests[k]) < 0) return 500;
        if (push_json("jobs", f.jobs[k]) < 0) return 500;
    }
    const uint32_t remaining = static_cast<uint32_t>(g_backlog.size() - g_backlog_next);
    if (remaining == 0) { g_backlog.clear(); g_backlog_next = 0; }
    plugin_set_backlog_remaining(remaining);
    plugin_set_yielded(remaining > 0 ? 1 : 0);
    return 0;
}

std::vector<const plugin_input_frame_t*> frames_on(const char* port) {
    std::vector<const plugin_input_frame_t*> out;
    for (uint32_t ordinal = 0;; ordinal++) {
        const int32_t idx = plugin_find_input_index(port, ordinal);
        if (idx < 0) break;
        out.push_back(plugin_get_input_frame(static_cast<uint32_t>(idx)));
    }
    return out;
}

std::string frame_string(const plugin_input_frame_t* f) {
    return f && f->payload ? std::string(reinterpret_cast<const char*>(f->payload), f->payload_length) : std::string();
}

}  // namespace

extern "C" {

// plan: timer tick -> one S3 listing request per (satellite, product folder) of the frame hour, with a list job each;
// or one status frame when the cycle is skipped.
int plan(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    const std::string config = load_config();
    if (!config_bool(config, "imager_live_access", true)) return push_status("live-access-disabled");
    int64_t frame_ms = 0;
    std::string err;
    if (!frame_time_ms(config, &frame_ms, &err)) { plugin_set_error("invalid-frame-time", err.c_str()); return 400; }
    const std::vector<std::string> satellites = list_of(config_string(config, "imager_satellites", kDefaultSatellites));
    const std::vector<std::string> fields = list_of(config_string(config, "imager_fields", kDefaultFields));
    const std::string widths = config_string(config, "imager_widths", kDefaultWidths);
    for (const std::string& f : fields) {
        if (!field_source(f)) { plugin_set_error("unknown-field", ("imager_fields names an unknown field: " + f).c_str()); return 400; }
    }
    int year = 0, doy = 0, hour = 0;
    civil(frame_ms, &year, &doy, &hour);
    const std::string folder = std::to_string(year) + "/" + pad(doy, 3) + "/" + pad(hour, 2) + "/";
    const long timeout = static_cast<long>(config_number(config, "imager_list_timeout_ms", kDefaultListTimeoutMs));
    int emitted = 0;
    for (const std::string& id : satellites) {
        const Satellite* sat = satellite_for(id);
        if (!sat) { plugin_set_error("unknown-satellite", ("imager_satellites names an unknown satellite: " + id).c_str()); return 400; }
        std::vector<std::string> products;
        for (const std::string& f : fields) {
            const std::string product = field_source(f)->product;
            if (std::find(products.begin(), products.end(), product) == products.end()) products.push_back(product);
        }
        for (const std::string& product : products) {
            std::vector<std::string> wanted;
            for (const std::string& f : fields) if (product == field_source(f)->product) wanted.push_back(f);
            const std::string prefix = product + "/" + folder;
            const std::string url = std::string("https://") + sat->bucket + ".s3.amazonaws.com/?list-type=2&max-keys=1000&prefix=" + prefix;
            std::string job = std::string("{\"satellite\":\"") + sat->id + "\",\"sensor\":\"" + sat->sensor + "\",\"bucket\":\"" + sat->bucket +
                              "\",\"prefix\":\"" + json_escape(prefix) + "\",\"frame_time_ms\":" + std::to_string(frame_ms) +
                              ",\"widths\":\"" + json_escape(widths) + "\",\"fields\":\"";
            for (size_t k = 0; k < wanted.size(); k++) job += (k ? "," : "") + wanted[k];
            job += "\"}";
            if (push_json("requests", get_request(url, "", timeout)) < 0 || push_json("jobs", job) < 0) return 500;
            emitted++;
        }
    }
    return emitted ? 0 : push_status("nothing-to-list");
}

// select: listing responses + list jobs (paired by position) -> each field's file as GET requests (byte ranges when it is
// larger than one response may be) with a parse job each, one file per invocation; the rest yielded as backlog. A
// resume without input frames emits the next file. Missing files and failed listings are reported on status.
int select_files(void) {
    const std::vector<const plugin_input_frame_t*> jobs = frames_on("list_jobs");
    const std::vector<const plugin_input_frame_t*> listings = frames_on("listings");
    if (jobs.empty() && listings.empty()) return emit_next_file();   // resumed with backlog
    if (jobs.size() != listings.size()) {
        const std::string msg = "select received " + std::to_string(jobs.size()) + " list jobs but " + std::to_string(listings.size()) +
                                " listing responses; they pair by position, so a mismatch cannot be attributed and is refused.";
        plugin_set_error("job-response-count-mismatch", msg.c_str());
        return 400;
    }
    const std::string config = load_config();
    const long timeout = static_cast<long>(config_number(config, "imager_file_timeout_ms", kDefaultFileTimeoutMs));
    double max_part = config_number(config, "imager_max_part_bytes", kDefaultMaxPartBytes);
    if (max_part < 1024 * 1024) max_part = 1024 * 1024;
    std::string missing;
    for (size_t k = 0; k < jobs.size(); k++) {
        const std::string job = frame_string(jobs[k]);
        std::string satellite, sensor, bucket, prefix, fields, widths;
        double frame_ms = 0;
        json_string_field(job, "satellite", &satellite);
        json_string_field(job, "sensor", &sensor);
        json_string_field(job, "bucket", &bucket);
        json_string_field(job, "prefix", &prefix);
        json_string_field(job, "fields", &fields);
        json_string_field(job, "widths", &widths);
        json_number_field(job, "frame_time_ms", &frame_ms);
        const plugin_input_frame_t* r = listings[k];
        long status = 0;
        std::string body;
        if (r && r->payload && r->payload_length >= 8 && memcmp(r->payload, "$HRB", 4) == 0) {
            status = static_cast<int32_t>(static_cast<uint32_t>(r->payload[4]) | (static_cast<uint32_t>(r->payload[5]) << 8) |
                                          (static_cast<uint32_t>(r->payload[6]) << 16) | (static_cast<uint32_t>(r->payload[7]) << 24));
            body.assign(reinterpret_cast<const char*>(r->payload + 8), r->payload_length - 8);
        }
        if (status != 200) {
            missing += std::string(missing.empty() ? "" : ",") + "{\"listing\":\"" + json_escape(bucket + "/" + prefix) + "\",\"http_status\":" + std::to_string(status) + "}";
            continue;
        }
        const std::vector<Listed> listing = parse_listing(body);
        int year = 0, doy = 0, hour = 0;
        civil(static_cast<int64_t>(frame_ms), &year, &doy, &hour);
        const std::string stamp = "_s" + std::to_string(year) + pad(doy, 3) + pad(hour, 2) + "0";
        for (const std::string& field : list_of(fields)) {
            const FieldSource* src = field_source(field);
            if (!src) continue;
            const Listed* file = pick_file(listing, stamp, src->band);
            if (!file) {
                missing += std::string(missing.empty() ? "" : ",") + "{\"field\":\"" + field + "\",\"satellite\":\"" + json_escape(satellite) + "\",\"prefix\":\"" + json_escape(prefix) + "\"}";
                continue;
            }
            const std::string url = "https://" + bucket + ".s3.amazonaws.com/" + file->key;
            const int parts = file->size > max_part ? static_cast<int>(std::ceil(file->size / max_part)) : 1;
            PendingFile pending;
            for (int p = 0; p < parts; p++) {
                std::string range;
                if (parts > 1) {
                    const long long a = static_cast<long long>(std::floor(file->size * p / parts));
                    const long long b = static_cast<long long>(std::floor(file->size * (p + 1) / parts)) - 1;
                    range = ",\"Range\":\"bytes=" + std::to_string(a) + "-" + std::to_string(b) + "\"";
                }
                pending.requests.push_back(get_request(url, range, timeout));
                pending.jobs.push_back(std::string("{\"satellite\":\"") + json_escape(satellite) + "\",\"sensor\":\"" + json_escape(sensor) +
                                       "\",\"bucket\":\"" + json_escape(bucket) + "\",\"key\":\"" + json_escape(file->key) +
                                       "\",\"variable\":\"" + src->variable + "\",\"field\":\"" + field +
                                       "\",\"frame_time_ms\":" + format_number(frame_ms) + ",\"part\":" + std::to_string(p) +
                                       ",\"parts\":" + std::to_string(parts) + ",\"widths\":\"" + json_escape(widths) +
                                       "\",\"source_url\":\"" + json_escape(url) + "\",\"provider_id\":\"" + kProviderID +
                                       "\",\"source_name\":\"" + json_escape(bucket) + "-world\",\"origin_id\":\"" + kOriginID +
                                       "\",\"dataset_id\":\"" + json_escape(bucket) + "\",\"license\":\"" + kLicenseID +
                                       "\",\"license_class\":\"OpenAttribution\",\"license_url\":\"" + kLicenseURL +
                                       "\",\"citation\":\"" + json_escape(sensor) + " data courtesy of NOAA via NOAA Open Data Dissemination\"}");
            }
            g_backlog.push_back(pending);
        }
    }
    if (!missing.empty() && push_json("status", "{\"missing\":[" + missing + "]}") < 0) return 500;
    return emit_next_file();
}

// publish_request: the storage-ingest result + the parser's ingest meta -> the dataset-publication POST for the node's
// loopback admin endpoint (imager_publish_url); nothing when it is unset (absence of configuration is not permission).
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
    if (!json_string_field(config, "imager_publish_url", &url) || url.empty()) return 0;
    const std::string result = frame_string(result_frame), meta = frame_string(meta_frame);
    std::string schema, batch_id, provider, source;
    if (!json_string_field(result, "schema", &schema) || schema.empty()) json_string_field(meta, "schema", &schema);
    if (!json_string_field(result, "batch_id", &batch_id) || batch_id.empty()) json_string_field(meta, "batch_id", &batch_id);
    json_string_field(meta, "provider_id", &provider);
    json_string_field(meta, "source_name", &source);
    if (schema.empty() || batch_id.empty() || provider.empty() || source.empty()) {
        plugin_set_error("incomplete-publication-identity", "publish_request needs schema, batchId, providerId and sourceName.");
        return 400;
    }
    const std::string body = std::string("{\"schema\":\"") + json_escape(schema) + "\",\"providerId\":\"" + json_escape(provider) +
                             "\",\"sourceName\":\"" + json_escape(source) + "\",\"batchId\":\"" + json_escape(batch_id) + "\"}";
    const long timeout = static_cast<long>(config_number(config, "imager_list_timeout_ms", kDefaultListTimeoutMs));
    const std::string request = std::string("{\"method\":\"POST\",\"url\":\"") + json_escape(url) + "\"" +
                                ",\"headers\":{\"content-type\":\"application/json\"},\"bodyB64\":\"" +
                                base64_encode(reinterpret_cast<const uint8_t*>(body.data()), body.size()) + "\"" +
                                ",\"timeoutMs\":" + std::to_string(timeout) + "}";
    return push_json("request", request) < 0 ? 500 : 0;
}

}  // extern "C"
