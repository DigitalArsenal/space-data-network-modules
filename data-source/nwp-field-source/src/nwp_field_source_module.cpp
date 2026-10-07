/*
 * data-source/nwp-field-source.
 *
 * Request-builder flow nodes for numerical-weather-prediction model fields in NOAA Open Data Dissemination's anonymous
 * public buckets (NCEP GFS noaa-gfs-bdp-pds, GEFS noaa-gefs-pds), fetched message by message through each file's .idx
 * inventory. No credentials and no capabilities beyond the node config: the http connector does the fetching.
 *
 *   plan            : timer tick -> the run's inventory requests (product by product, lead by lead), 16 per invocation,
 *                     the rest yielded as backlog (or one status frame when skipped).
 *   select_messages : inventories + their jobs -> each lead-file's wanted messages as byte ranges (adjacent ones merged,
 *                     each under 64 MiB) with a GRIB job per range - ONE BATCH (a lead-file, or 16 of its ranges) PER
 *                     INVOCATION, the rest yielded as backlog, so the parser holds one batch's messages (never more than
 *                     32 frames a port) and storage-ingest gets one meta + one record stream at a time. A lead the run
 *                     lacks -> status.
 *   publish_request : storage-ingest result + parser meta -> the dataset-publication POST (nwp_publish_url).
 *
 * Products (nwp_products; the world-clouds display's, as its reference fetchers choose them): gfs-1p00-motion (UGRD,
 * VGRD and, to nwp_motion_heights_to, HGT at 1000-200 hPa), gefs-0p50-spread (the ensemble's wind spread at those
 * levels, every other point), gfs-0p50-clouds (total/low/middle/high cloud cover, instantaneous), each lead 0 ..
 * nwp_max_lead by nwp_lead_step; gfs-0p25-physics (2 m temperature and dew point, 10 m wind, boundary-layer height,
 * CAPE, surface height, cloud layers, and temperature/height/wind/humidity/vertical velocity on 21 levels plus the
 * tropopause) at nwp_physics_leads. Node CONFIG through plugin.getConfig: nwp_live_access (default true), nwp_run
 * (YYYYMMDDTHH; default the latest cycle nwp_lag_hours (5) old), nwp_products, nwp_max_lead (384), nwp_lead_step (3),
 * nwp_motion_heights_to (12), nwp_physics_leads ("0,3"), timeouts, nwp_publish_url (unset: no publication).
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
// Products: a NOAA Open Data Dissemination file per (run, lead) and the messages of it the world-clouds display reads,
// chosen by the .idx inventory line (variable, level, forecast text). As the reference fetchers choose them
// (Cesium_Weather tools/fetch-motion-wxf.mjs, fetch-model-clouds-wxf.mjs, fetch-gfs-wxf.mjs, fetch-gfs-profile-wxf.mjs).
// ---------------------------------------------------------------------------

const int kMotionLevels[] = {1000, 925, 850, 700, 500, 400, 300, 250, 200};
const int kProfileLevels[] = {1000, 975, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300, 250, 200, 150, 100};

bool level_in(const std::string& level, const int* levels, size_t n) {
    for (size_t i = 0; i < n; i++) if (level == std::to_string(levels[i]) + " mb") return true;
    return false;
}
// "anl" or "N hour fcst" - an instantaneous field, not an interval mean ("a-b hour ave fcst") or accumulation
bool instantaneous(const std::string& fcst) {
    if (fcst == "anl") return true;
    const size_t at = fcst.find(" hour fcst");
    if (at == std::string::npos || at + 10 != fcst.size()) return false;
    return std::all_of(fcst.begin(), fcst.begin() + static_cast<ptrdiff_t>(at), ::isdigit);
}

struct Product {
    const char* id;
    const char* host;           // bucket host
    const char* path;           // file path with {D} (YYYYMMDD), {H} (HH), {L} (LLL)
    const char* model_key;
    const char* model_id;
    const char* model_class;
    int stride, band_rows, ensemble_size;
    bool spread;
};
const Product kProducts[] = {
    {"gfs-1p00-motion", "noaa-gfs-bdp-pds.s3.amazonaws.com", "gfs.{D}/{H}/atmos/gfs.t{H}z.pgrb2.1p00.f{L}", "gfs", "NCEP GFS 1°", "NumericalGlobalDeterministic", 1, 0, 0, false},
    {"gefs-0p50-spread", "noaa-gefs-pds.s3.amazonaws.com", "gefs.{D}/{H}/atmos/pgrb2ap5/gespr.t{H}z.pgrb2a.0p50.f{L}", "gefs", "NCEP GEFS 0.5° (every other point)", "NumericalGlobalEnsemble", 2, 0, 31, true},
    {"gfs-0p50-clouds", "noaa-gfs-bdp-pds.s3.amazonaws.com", "gfs.{D}/{H}/atmos/gfs.t{H}z.pgrb2.0p50.f{L}", "gfs", "NCEP GFS 0.5°", "NumericalGlobalDeterministic", 1, 0, 0, false},
    {"gfs-0p25-physics", "noaa-gfs-bdp-pds.s3.amazonaws.com", "gfs.{D}/{H}/atmos/gfs.t{H}z.pgrb2.0p25.f{L}", "gfs", "NCEP GFS 0.25°", "NumericalGlobalDeterministic", 1, 64, 0, false},
};
const Product* product_named(const std::string& id) {
    for (const Product& p : kProducts) if (id == p.id) return &p;
    return nullptr;
}

// Whether an inventory line's message is one the product publishes (lead: hours; heights_to: the last motion lead with
// geopotential height).
bool wanted(const Product& p, const std::string& var, const std::string& level, const std::string& fcst, int lead, int heights_to) {
    if (!instantaneous(fcst)) return false;
    const std::string id = p.id;
    if (id == "gfs-1p00-motion") return level_in(level, kMotionLevels, 9) && (var == "UGRD" || var == "VGRD" || (var == "HGT" && lead <= heights_to));
    if (id == "gefs-0p50-spread") return level_in(level, kMotionLevels, 9) && (var == "UGRD" || var == "VGRD");
    if (id == "gfs-0p50-clouds")
        return (var == "TCDC" && level == "entire atmosphere") || (var == "LCDC" && level == "low cloud layer") ||
               (var == "MCDC" && level == "middle cloud layer") || (var == "HCDC" && level == "high cloud layer");
    if (id == "gfs-0p25-physics") {
        if ((var == "TMP" || var == "DPT") && level == "2 m above ground") return true;
        if ((var == "UGRD" || var == "VGRD") && level == "10 m above ground") return true;
        if ((var == "HPBL" || var == "CAPE" || var == "HGT") && level == "surface") return true;
        if ((var == "LCDC" && level == "low cloud layer") || (var == "MCDC" && level == "middle cloud layer") || (var == "HCDC" && level == "high cloud layer")) return true;
        if ((var == "TMP" || var == "HGT" || var == "UGRD" || var == "VGRD" || var == "RH" || var == "VVEL") && level_in(level, kProfileLevels, 21)) return true;
        if ((var == "TMP" || var == "HGT" || var == "UGRD" || var == "VGRD") && level == "tropopause") return true;
        return false;
    }
    return false;
}

constexpr const char* kDefaultProducts = "gfs-1p00-motion,gefs-0p50-spread,gfs-0p50-clouds,gfs-0p25-physics";
constexpr double kDefaultLagHours = 5;             // a GFS run's files are all out about 5 h after its cycle
constexpr double kDefaultMaxLead = 384, kDefaultLeadStep = 3, kDefaultHeightsTo = 12;
constexpr const char* kDefaultPhysicsLeads = "0,3";
constexpr double kDefaultIdxTimeoutMs = 60000, kDefaultGribTimeoutMs = 300000;
constexpr double kMaxRangeBytes = 64.0 * 1024 * 1024;
constexpr uint32_t kPlanBatch = 16;                // inventory requests handed out per plan invocation
// A batch's ranges: the compiled runtime hands a node at most 64 frames an invocation, so the parser's jobs and
// responses of one batch must stay at 32 each or fewer - a lead-file with more ranges is split into batches of 16.
constexpr size_t kMaxRangesPerBatch = 16;
constexpr const char* kProviderID = "noaa-ncep";
constexpr const char* kOriginID = "NOAA Open Data Dissemination (AWS)";
constexpr const char* kLicenseID = "LicenseRef-NOAA-Open-Data";
constexpr const char* kLicenseURL = "https://www.weather.gov/disclaimer";
// (see imager-observation-source: the host's validators must never turn a repeat inventory or range into an empty 304)
constexpr const char* kNoValidators = "\"If-Modified-Since\":\"Thu, 01 Jan 1970 00:00:00 GMT\"";

std::string trim_copy(std::string s) {
    while (!s.empty() && is_ws(s.back())) s.pop_back();
    size_t at = 0;
    while (at < s.size() && is_ws(s[at])) at++;
    return s.substr(at);
}
std::vector<std::string> list_of(const std::string& text) {
    std::vector<std::string> out;
    for (const std::string& part : split(text, ',')) { const std::string t = trim_copy(part); if (!t.empty()) out.push_back(t); }
    return out;
}
std::string pad(int v, int width) { std::string s = std::to_string(v); while (static_cast<int>(s.size()) < width) s = "0" + s; return s; }
std::string replace_all(std::string s, const std::string& from, const std::string& to) {
    for (size_t at = s.find(from); at != std::string::npos; at = s.find(from, at + to.size())) s.replace(at, from.size(), to);
    return s;
}
void civil_ymdh(int64_t ms, int* y, int* m, int* d, int* h) {
    const int64_t days = ms / 86400000;
    const int64_t z = days + 719468, era = (z >= 0 ? z : z - 146096) / 146097, doe = z - era * 146097;
    const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365, doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const int64_t mp = (5 * doy + 2) / 153, dd = doy - (153 * mp + 2) / 5 + 1, mm = mp < 10 ? mp + 3 : mp - 9;
    *y = static_cast<int>(yoe + era * 400 + (mm <= 2)); *m = static_cast<int>(mm); *d = static_cast<int>(dd); *h = static_cast<int>((ms % 86400000) / 3600000);
}
std::string get_request(const std::string& url, const std::string& extra, long timeout_ms) {
    return "{\"method\":\"GET\",\"url\":\"" + json_escape(url) + "\",\"headers\":{" + kNoValidators + extra + "}" +
           ",\"timeoutMs\":" + std::to_string(timeout_ms) + ",\"responseWire\":\"raw-body-v1\"}";
}

// The run: nwp_run ("YYYYMMDDTHH" / ISO / Unix ms) when set, else the latest 6-hourly cycle nwp_lag_hours old.
bool run_time_ms(const std::string& config, int64_t* out, std::string* err) {
    std::string set;
    if (json_string_field(config, "nwp_run", &set) && !set.empty()) {
        int64_t ms = 0;
        if (set.size() == 11 && set[8] == 'T' && std::all_of(set.begin(), set.begin() + 8, ::isdigit) && ::isdigit(set[9]) && ::isdigit(set[10]))
            ms = (days_from_civil(std::atoi(set.substr(0, 4).c_str()), std::atoi(set.substr(4, 2).c_str()), std::atoi(set.substr(6, 2).c_str())) * 24 + std::atoi(set.substr(9, 2).c_str())) * 3600000LL;
        else if (std::all_of(set.begin(), set.end(), ::isdigit)) ms = std::atoll(set.c_str());
        else if (!parse_iso_ms(set, &ms)) { *err = "nwp_run is neither YYYYMMDDTHH, ISO 8601 nor Unix ms: " + set; return false; }
        if (ms % (6 * 3600000LL) != 0) { *err = "nwp_run is not a 00/06/12/18 UTC cycle: " + set; return false; }
        *out = ms;
        return true;
    }
    const int64_t now = now_unix_ms();
    if (now <= 0) { *err = "no clock"; return false; }
    const int64_t t = now - static_cast<int64_t>(config_number(config, "nwp_lag_hours", kDefaultLagHours) * 3600000.0);
    *out = t - ((t % 21600000) + 21600000) % 21600000;
    return true;
}

// ---------------------------------------------------------------------------
// Backlogs: plan hands out kPlanBatch inventory requests per invocation; select_messages one lead-file (all its byte
// ranges) per invocation, so the parser holds one file's messages and storage-ingest receives one meta and one record
// stream at a time. The compiled runtime resumes a yielded node without input.
// ---------------------------------------------------------------------------

struct Pending { std::vector<std::string> requests, jobs; };
std::vector<Pending> g_plan_backlog, g_select_backlog;
size_t g_plan_next = 0, g_select_next = 0;

int emit_from(std::vector<Pending>& backlog, size_t& next, uint32_t per_invocation, const char* request_port, const char* job_port) {
    uint32_t emitted = 0;
    while (next < backlog.size() && emitted < per_invocation) {
        const Pending& p = backlog[next++];
        for (size_t k = 0; k < p.requests.size(); k++) {
            if (push_json(request_port, p.requests[k]) < 0) return 500;
            if (push_json(job_port, p.jobs[k]) < 0) return 500;
        }
        emitted++;
    }
    const uint32_t remaining = static_cast<uint32_t>(backlog.size() - next);
    if (remaining == 0) { backlog.clear(); next = 0; }
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

// plan: timer tick -> the run's inventory (.idx) requests, product by product and lead by lead, kPlanBatch per
// invocation (the rest yielded as backlog); a resume without input hands out the next batch. One status frame when the
// cycle is skipped.
int plan(void) {
    if (plugin_get_input_count() == 0) return emit_from(g_plan_backlog, g_plan_next, kPlanBatch, "requests", "jobs");
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    const std::string config = load_config();
    if (!config_bool(config, "nwp_live_access", true)) return push_status("live-access-disabled");
    int64_t run = 0;
    std::string err;
    if (!run_time_ms(config, &run, &err)) { plugin_set_error("invalid-run", err.c_str()); return 400; }
    int y = 0, mo = 0, d = 0, h = 0;
    civil_ymdh(run, &y, &mo, &d, &h);
    const std::string D = std::to_string(y) + pad(mo, 2) + pad(d, 2), H = pad(h, 2), run_id = D + "T" + H;
    const int max_lead = static_cast<int>(config_number(config, "nwp_max_lead", kDefaultMaxLead));
    const int step = std::max(1, static_cast<int>(config_number(config, "nwp_lead_step", kDefaultLeadStep)));
    const int heights_to = static_cast<int>(config_number(config, "nwp_motion_heights_to", kDefaultHeightsTo));
    std::vector<int> physics_leads;
    for (const std::string& l : list_of(config_string(config, "nwp_physics_leads", kDefaultPhysicsLeads))) physics_leads.push_back(std::atoi(l.c_str()));
    const long timeout = static_cast<long>(config_number(config, "nwp_idx_timeout_ms", kDefaultIdxTimeoutMs));
    for (const std::string& id : list_of(config_string(config, "nwp_products", kDefaultProducts))) {
        const Product* p = product_named(id);
        if (!p) { plugin_set_error("unknown-product", ("nwp_products names an unknown product: " + id).c_str()); return 400; }
        std::vector<int> leads;
        if (std::string(p->id) == "gfs-0p25-physics") leads = physics_leads;
        else for (int lead = 0; lead <= max_lead; lead += step) leads.push_back(lead);
        for (int lead : leads) {
            const std::string url = std::string("https://") + p->host + "/" + replace_all(replace_all(replace_all(p->path, "{D}", D), "{H}", H), "{L}", pad(lead, 3));
            Pending pending;
            pending.requests.push_back(get_request(url + ".idx", "", timeout));
            pending.jobs.push_back(std::string("{\"product\":\"") + p->id + "\",\"url\":\"" + json_escape(url) + "\",\"run\":\"" + run_id +
                                   "\",\"lead\":" + std::to_string(lead) + ",\"heights_to\":" + std::to_string(heights_to) + "}");
            g_plan_backlog.push_back(pending);
        }
    }
    if (g_plan_backlog.empty()) return push_status("nothing-to-fetch");
    return emit_from(g_plan_backlog, g_plan_next, kPlanBatch, "requests", "jobs");
}

// select_messages: inventories + their jobs (paired by position) -> each lead-file's wanted messages as byte ranges
// (adjacent messages merged, each range under kMaxRangeBytes) with a GRIB job per range; one lead-file per invocation,
// the rest yielded as backlog. A missing inventory (a lead the run does not have) is reported on status.
int select_messages(void) {
    const std::vector<const plugin_input_frame_t*> jobs = frames_on("idx_jobs");
    const std::vector<const plugin_input_frame_t*> inventories = frames_on("inventories");
    if (jobs.empty() && inventories.empty()) return emit_from(g_select_backlog, g_select_next, 1, "requests", "jobs");
    if (jobs.size() != inventories.size()) {
        const std::string msg = "select_messages received " + std::to_string(jobs.size()) + " inventory jobs but " + std::to_string(inventories.size()) +
                                " inventory responses; they pair by position, so a mismatch cannot be attributed and is refused.";
        plugin_set_error("job-response-count-mismatch", msg.c_str());
        return 400;
    }
    const std::string config = load_config();
    const long timeout = static_cast<long>(config_number(config, "nwp_grib_timeout_ms", kDefaultGribTimeoutMs));
    std::string missing;
    for (size_t k = 0; k < jobs.size(); k++) {
        const std::string job = frame_string(jobs[k]);
        std::string product_id, url, run;
        double lead = 0, heights_to = kDefaultHeightsTo;
        json_string_field(job, "product", &product_id);
        json_string_field(job, "url", &url);
        json_string_field(job, "run", &run);
        json_number_field(job, "lead", &lead);
        json_number_field(job, "heights_to", &heights_to);
        const Product* p = product_named(product_id);
        const plugin_input_frame_t* r = inventories[k];
        long status = 0;
        std::string body;
        if (r && r->payload && r->payload_length >= 8 && memcmp(r->payload, "$HRB", 4) == 0) {
            status = static_cast<int32_t>(static_cast<uint32_t>(r->payload[4]) | (static_cast<uint32_t>(r->payload[5]) << 8) |
                                          (static_cast<uint32_t>(r->payload[6]) << 16) | (static_cast<uint32_t>(r->payload[7]) << 24));
            body.assign(reinterpret_cast<const char*>(r->payload + 8), r->payload_length - 8);
        }
        if (!p || status != 200) {
            missing += std::string(missing.empty() ? "" : ",") + "{\"inventory\":\"" + json_escape(url + ".idx") + "\",\"http_status\":" + std::to_string(status) + "}";
            continue;
        }
        // "n:offset:d=YYYYMMDDHH:VAR:LEVEL:FCST:" per message; a message runs to the next line's offset
        struct Line { long long offset; std::string var, level, fcst; };
        std::vector<Line> lines;
        for (const std::string& raw : split(body, '\n')) {
            const std::vector<std::string> f = split(raw, ':');
            if (f.size() < 6) continue;
            lines.push_back({std::atoll(f[1].c_str()), f[3], f[4], f[5]});
        }
        std::vector<std::pair<long long, long long>> ranges;   // inclusive end; -1 = to the end of the file
        for (size_t i = 0; i < lines.size(); i++) {
            if (!wanted(*p, lines[i].var, lines[i].level, lines[i].fcst, static_cast<int>(lead), static_cast<int>(heights_to))) continue;
            const long long a = lines[i].offset, b = i + 1 < lines.size() ? lines[i + 1].offset - 1 : -1;
            if (!ranges.empty() && ranges.back().second != -1 && ranges.back().second + 1 == a && (b == -1 || b - ranges.back().first + 1 <= kMaxRangeBytes)) ranges.back().second = b;
            else ranges.push_back({a, b});
        }
        if (ranges.empty()) {
            missing += std::string(missing.empty() ? "" : ",") + "{\"product\":\"" + product_id + "\",\"lead\":" + format_number(lead) + ",\"messages\":0}";
            continue;
        }
        Pending pending;
        auto flush = [&]() { if (!pending.requests.empty()) { g_select_backlog.push_back(pending); pending = Pending(); } };
        for (const auto& range : ranges) {
            if (pending.requests.size() == kMaxRangesPerBatch) flush();
            pending.requests.push_back(get_request(url, ",\"Range\":\"bytes=" + std::to_string(range.first) + "-" + (range.second >= 0 ? std::to_string(range.second) : std::string()) + "\"", timeout));
            const std::string host = url.substr(8, url.find('/', 8) - 8);
            pending.jobs.push_back(std::string("{\"url\":\"") + json_escape(url) + "\",\"product\":\"" + p->id + "\",\"model_key\":\"" + p->model_key +
                                   "\",\"model_id\":\"" + json_escape(p->model_id) + "\",\"model_class\":\"" + p->model_class + "\",\"run\":\"" + json_escape(run) +
                                   "\",\"lead\":" + format_number(lead) + ",\"stride\":" + std::to_string(p->stride) + ",\"band_rows\":" + std::to_string(p->band_rows) +
                                   (p->spread ? ",\"spread\":true" : "") + (p->ensemble_size ? ",\"ensemble_size\":" + std::to_string(p->ensemble_size) : std::string()) +
                                   ",\"source_url\":\"" + json_escape(url) + "\",\"provider_id\":\"" + kProviderID + "\",\"source_name\":\"" + p->id +
                                   "\",\"origin_id\":\"" + kOriginID + "\",\"dataset_id\":\"" + json_escape(host.substr(0, host.find('.'))) +
                                   "\",\"license\":\"" + kLicenseID + "\",\"license_class\":\"OpenAttribution\",\"license_url\":\"" + kLicenseURL +
                                   "\",\"citation\":\"NOAA/NCEP " + (p->spread ? "Global Ensemble Forecast System ensemble standard deviation" : "Global Forecast System") +
                                   " via NOAA Open Data Dissemination (AWS)\"}");
        }
        flush();
    }
    if (!missing.empty() && push_json("status", "{\"missing\":[" + missing + "]}") < 0) return 500;
    return emit_from(g_select_backlog, g_select_next, 1, "requests", "jobs");
}

// publish_request: the storage-ingest result + the parser's ingest meta -> the dataset-publication POST
// (nwp_publish_url); nothing when it is unset.
int publish_request(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    const plugin_input_frame_t* result_frame = frame_for("result");
    const plugin_input_frame_t* meta_frame = frame_for("meta");
    if (!result_frame || !result_frame->payload || result_frame->payload_length == 0) { plugin_set_error("missing-result-frame", "publish_request requires the storage-ingest result frame."); return 400; }
    if (!meta_frame || !meta_frame->payload || meta_frame->payload_length == 0) { plugin_set_error("missing-meta-frame", "publish_request requires the parser ingest meta frame."); return 400; }
    const std::string config = load_config();
    std::string url;
    if (!json_string_field(config, "nwp_publish_url", &url) || url.empty()) return 0;
    const std::string result = frame_string(result_frame), meta = frame_string(meta_frame);
    std::string schema, batch_id, provider, source;
    if (!json_string_field(result, "schema", &schema) || schema.empty()) json_string_field(meta, "schema", &schema);
    if (!json_string_field(result, "batch_id", &batch_id) || batch_id.empty()) json_string_field(meta, "batch_id", &batch_id);
    json_string_field(meta, "provider_id", &provider);
    json_string_field(meta, "source_name", &source);
    if (schema.empty() || batch_id.empty() || provider.empty() || source.empty()) { plugin_set_error("incomplete-publication-identity", "publish_request needs schema, batchId, providerId and sourceName."); return 400; }
    const std::string body = std::string("{\"schema\":\"") + json_escape(schema) + "\",\"providerId\":\"" + json_escape(provider) +
                             "\",\"sourceName\":\"" + json_escape(source) + "\",\"batchId\":\"" + json_escape(batch_id) + "\"}";
    const std::string request = std::string("{\"method\":\"POST\",\"url\":\"") + json_escape(url) + "\",\"headers\":{\"content-type\":\"application/json\"},\"bodyB64\":\"" +
                                base64_encode(reinterpret_cast<const uint8_t*>(body.data()), body.size()) + "\",\"timeoutMs\":" +
                                std::to_string(static_cast<long>(config_number(config, "nwp_idx_timeout_ms", kDefaultIdxTimeoutMs))) + "}";
    return push_json("request", request) < 0 ? 500 : 0;
}

}  // extern "C"
