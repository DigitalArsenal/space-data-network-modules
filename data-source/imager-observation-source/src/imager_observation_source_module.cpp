/*
 * data-source/imager-observation-source.
 *
 * Request-builder flow nodes for imager observations - raw per-satellite fields (owner 2026-10-07: SDN carries raw
 * per-satellite fields; the world-clouds display derives the rest) from public sources, no credentials:
 *   GOES-East / GOES-West  NOAA Open Data Dissemination (noaa-goes19 / noaa-goes18): ABI L1b/L2 NetCDF4
 *   Himawari-9             NOAA Open Data Dissemination (noaa-himawari9): AHI ISatSS tiles (NetCDF4), L2 clouds (HDF5)
 *   Meteosat-12, Meteosat-9 IODC, Metop-B/C   EUMETSAT's public view service (WMS)
 * The http connector does the fetching; the parser sibling (data-source/imager-observation-parser) fetches each file's
 * bytes through it and builds the $WXF records.
 *
 *   plan            : timer tick -> per satellite, the frame hours of the window not yet landed: an S3 listing request
 *                     per product folder (+ its list job), or a view work job straight to the parser.
 *   select_files    : listings + list jobs -> one parser work job per file (or per band of tiles).
 *   note            : the parser's notices (landed marks found, view frames missing) -> the module's landed set.
 *   publish_request : storage-ingest result + parser meta -> the field's landed mark (a one-byte GET the node's HTTP
 *                     validator ledger remembers) and the dataset-publication POST (imager_publish_url).
 *
 * Node CONFIG (plugin.getConfig): imager_live_access (default true), imager_satellites ("goes-east,goes-west"; also
 * himawari, meteosat, meteosat-iodc, metop), imager_fields (the five the world-clouds display reads), imager_widths
 * ("4096,2048,1024"), imager_backfill_hours (72: the ledger satellites' window), imager_view_backfill_hours (0),
 * imager_frame_time (one fixed hour, ISO or Unix ms), imager_lag_minutes / imager_lag_minutes_<satellite> (per
 * satellite: ABI/AHI 20, Meteosat 40, Metop 360), imager_max_part_bytes (64 MiB), imager_list_timeout_ms (60000),
 * imager_file_timeout_ms (300000), imager_publish_url (unset: no publication).
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
// Satellites. A satellite is one imager's raw fields from one public source:
//   ABI   - NOAA Open Data Dissemination's GOES buckets: ABI L1b/L2 NetCDF4 under <product>/<YYYY>/<DDD>/<HH>/.
//   AHI   - noaa-himawari9: the full disc's sectorized CMI tiles (AHI-L2-FLDK-ISatSS/<YYYY>/<MM>/<DD>/<HHMM>/, NetCDF4,
//           88 tiles a band) and NOAA's cloud retrievals (AHI-L2-FLDK-Clouds/.../<HHMM>/, HDF5, read by byte range).
//   VIEW  - EUMETSAT's public view service (WMS GetMap): Meteosat-12 FCI (0 degrees) and Meteosat-9 SEVIRI over the
//           Indian Ocean (45.5 E), geostationary discs; Metop-B/C AVHRR, the polar caps.
// Each satellite publishes under its provider and source (sdn/PROTOCOL.md in DigitalArsenal/Cesium_Weather:
// <dataset>-world), with the reference producer's licence and citation (raw_satellite.py LICENSE).
// ---------------------------------------------------------------------------

enum Kind { kABI, kAHI, kViewGeo, kViewPolar };

struct Satellite {
    const char* id; Kind kind; const char* provider; const char* dataset; const char* sensor;
    const char* origin; const char* license_id; const char* license_url; const char* citation;
    double lag_minutes;   // the frame hour's products are out this long after the hour (default; imager_lag_minutes overrides)
};

constexpr const char* kNoaaOrigin = "NOAA Open Data Dissemination (AWS)";
constexpr const char* kViewOrigin = "EUMETSAT view service (public WMS)";
constexpr const char* kNoaaLicense = "LicenseRef-NOAA-Open-Data";
constexpr const char* kGoesLicenseURL = "https://www.ncei.noaa.gov/access/metadata/landing-page/bin/iso?id=gov.noaa.ncdc:C01502";
constexpr const char* kHimawariLicenseURL = "https://registry.opendata.aws/noaa-himawari/";
constexpr const char* kEumetsatLicense = "LicenseRef-EUMETSAT-Data-Policy";
constexpr const char* kEumetsatLicenseURL = "https://www.eumetsat.int/eumetsat-data-licensing";

const Satellite kSatellites[] = {
    {"goes-east", kABI, "noaa-goes", "noaa-goes19", "GOES-19 ABI", kNoaaOrigin, kNoaaLicense, kGoesLicenseURL,
     "GOES-19 ABI data courtesy of NOAA via NOAA Open Data Dissemination", 20},
    {"goes-west", kABI, "noaa-goes", "noaa-goes18", "GOES-18 ABI", kNoaaOrigin, kNoaaLicense, kGoesLicenseURL,
     "GOES-18 ABI data courtesy of NOAA via NOAA Open Data Dissemination", 20},
    {"himawari", kAHI, "noaa-himawari", "noaa-himawari9", "Himawari-9 AHI", kNoaaOrigin, kNoaaLicense, kHimawariLicenseURL,
     "Himawari-9 AHI data courtesy of NOAA and JMA via NOAA Open Data Dissemination", 20},
    {"meteosat", kViewGeo, "eumetsat", "eumetsat-msg-0deg", "Meteosat-12 FCI", kViewOrigin, kEumetsatLicense, kEumetsatLicenseURL,
     "Meteosat-12 FCI: contains modified EUMETSAT data", 40},
    {"meteosat-iodc", kViewGeo, "eumetsat", "eumetsat-msg-iodc", "Meteosat-9 SEVIRI", kViewOrigin, kEumetsatLicense, kEumetsatLicenseURL,
     "Meteosat-9 SEVIRI (Indian Ocean): contains modified EUMETSAT data", 40},
    // (the view service's Metop orbits arrive 3-5 hours after they are flown, measured 2026-10-14)
    {"metop", kViewPolar, "eumetsat", "eumetsat-metop", "Metop-B/C AVHRR", kViewOrigin, kEumetsatLicense, kEumetsatLicenseURL,
     "Metop-B/C AVHRR: contains modified EUMETSAT data", 360},
};

const Satellite* satellite_for(const std::string& id) {
    for (const Satellite& s : kSatellites) if (id == s.id) return &s;
    return nullptr;
}

// ---------------------------------------------------------------------------
// Fields: where each satellite's value comes from. ABI: (product folder, band token, NetCDF variable). AHI: ISatSS band
// or (cloud product, HDF5 variable). VIEW: the parser derives them from the view imagery (raw_satellite.py
// mtgview_fields / polarview_fields), so only which fields a view satellite has.
// ---------------------------------------------------------------------------

struct FieldSource { const char* field; const char* abi_product; const char* abi_band; const char* abi_variable;
                     int ahi_band; const char* ahi_product; const char* ahi_variable; };
const FieldSource kFieldSources[] = {
    {"brightness_temperature_10um", "ABI-L2-CMIPF", "C13", "CMI", 13, "", ""},
    {"reflectance_064um", "ABI-L2-CMIPF", "C02", "CMI", 3, "", ""},
    {"cloud_top_height", "ABI-L2-ACHA2KMF", "", "HT", 0, "CHGT", "CldTopHght"},
    {"cloud_mask", "ABI-L2-ACMF", "", "ACM", 0, "CMSK", "CloudMask"},
    {"cloud_phase", "ABI-L2-ACTPF", "", "Phase", 0, "CPHS", "CloudPhase"},
    {"cloud_optical_depth", "ABI-L2-COD2KMF", "", "COD", 0, "CHGT", "CldOptDpth"},
    {"cloud_effective_radius", "ABI-L2-CPSF", "", "CPS", 0, "", ""},
    {"rain_rate", "ABI-L2-RRQPEF", "", "RRQPE", 0, "", ""},
    {"cloud_top_emissivity", "", "", "", 0, "CHGT", "CldTopEmss"},
};

const FieldSource* field_source(const std::string& field) {
    for (const FieldSource& f : kFieldSources) if (field == f.field) return &f;
    return nullptr;
}

// Whether a satellite has a field (the reference producer's per-imager fields).
bool has_field(const Satellite& sat, const FieldSource& f) {
    const std::string name = f.field;
    switch (sat.kind) {
        case kABI: return f.abi_product[0] != 0;
        case kAHI: return f.ahi_band != 0 || f.ahi_product[0] != 0;
        case kViewGeo:
            if (name == "reflectance_064um") return std::string(sat.id) == "meteosat";   // GeoColour: the 0-degree disc only
            return name == "brightness_temperature_10um" || name == "cloud_mask" || name == "cloud_top_height";
        case kViewPolar: return name == "brightness_temperature_10um" || name == "cloud_mask" || name == "cloud_top_height";
    }
    return false;
}
bool ledger_kind(const Satellite& sat) { return sat.kind == kABI || sat.kind == kAHI; }

constexpr const char* kDefaultSatellites = "goes-east,goes-west";
// the fields the world-clouds display reads (cloud cover, optical depth, daylight brightness, temperature, top height)
constexpr const char* kDefaultFields = "cloud_mask,cloud_optical_depth,reflectance_064um,brightness_temperature_10um,cloud_top_height";
constexpr const char* kDefaultWidths = "4096,2048,1024";
constexpr double kDefaultBackfillHours = 72;      // the node's retention window (record-retention's default)
constexpr double kDefaultViewBackfillHours = 0;   // (view imagery has no landed ledger: see plan)
constexpr double kDefaultListTimeoutMs = 60000;
constexpr double kDefaultFileTimeoutMs = 300000;
constexpr double kDefaultMaxPartBytes = 64.0 * 1024 * 1024;   // each response well under the host's 100 MiB cap
constexpr uint32_t kPlanBatch = 32;                           // listing requests / work jobs per invocation
// The host adds the validators of the last 2xx for a URL to a GET (If-None-Match / If-Modified-Since) unless the
// request sets one; a repeat listing could then come back 304, empty. An If-Modified-Since at the epoch is always
// satisfied, so S3 answers 200 with the body.
constexpr const char* kNoValidators = "\"If-Modified-Since\":\"Thu, 01 Jan 1970 00:00:00 GMT\"";
// The landed mark (see publish_request): a byte of the source object under a query S3 ignores, fetched once the field's
// batch is stored, so the node's HTTP validator ledger holds the object's ETag under this URL.
constexpr const char* kLandedQuery = "sdn-ingest=landed";

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

int64_t floor_hour(int64_t ms) { return ms - ((ms % 3600000) + 3600000) % 3600000; }

// imager_frame_time (ISO 8601 or Unix ms): one fixed hour; 0 when unset.
bool fixed_frame_ms(const std::string& config, int64_t* out, std::string* err) {
    *out = 0;
    std::string set;
    if (json_string_field(config, "imager_frame_time", &set) && !set.empty()) {
        int64_t ms = 0;
        if (std::all_of(set.begin(), set.end(), ::isdigit)) ms = std::atoll(set.c_str());
        else if (!parse_iso_ms(set, &ms)) { *err = "imager_frame_time is neither ISO 8601 nor Unix ms: " + set; return false; }
        *out = floor_hour(ms);
        return true;
    }
    double n = 0;
    if (json_number_field(config, "imager_frame_time", &n) && n > 0) *out = floor_hour(static_cast<int64_t>(n));
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

void civil_ymd(int64_t ms, int* year, int* month, int* day) {
    int64_t z = ms / 86400000 + 719468;
    const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    const int64_t doe = z - era * 146097;
    const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    const int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const int64_t mp = (5 * doy + 2) / 153;
    *day = static_cast<int>(doy - (153 * mp + 2) / 5 + 1);
    *month = static_cast<int>(mp < 10 ? mp + 3 : mp - 9);
    *year = static_cast<int>(yoe + era * 400 + (*month <= 2 ? 1 : 0));
}

std::string pad(int v, int width) {
    std::string s = std::to_string(v);
    while (static_cast<int>(s.size()) < width) s = "0" + s;
    return s;
}

std::string get_request(const std::string& url, const std::string& headers, long timeout_ms) {
    return "{\"method\":\"GET\",\"url\":\"" + json_escape(url) + "\",\"headers\":{" + headers + "}" +
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

// ABI: the hour's first scan of a field: the key whose scan start stamp is _s<YYYY><DDD><HH>0 (minutes 00-09) and, for
// a multi-band product, whose mode-and-channel token is -M<n>C<band>_.
const Listed* pick_abi_file(const std::vector<Listed>& listing, const std::string& stamp, const std::string& band) {
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
// Module state (one instance per flow service; it lives as long as the node keeps the flow loaded).
//   g_landed      - "<satellite>|<frameMs>|<field>" the node holds: from storage-ingest results (publish_request) and
//                   the parser's landed notices (a probe of the landed mark answered 304). Lost on a restart; the
//                   ledger satellites (ABI, AHI) learn it again from their marks, cheaply, on the first tick.
//   g_view_tried  - view satellites' frames planned by this instance (no ledger: planned once, retried only when the
//                   parser reports them missing).
// ---------------------------------------------------------------------------

std::vector<std::string> g_landed;
std::vector<std::string> g_view_tried, g_view_retry;
constexpr int kViewRetryHours = 12;   // a view frame the service did not have is tried again while it is this new
struct Pending { std::string port_a, a, port_b, b; };   // one or two frames (a request and its list job, or a work job)
std::vector<Pending> g_plan_backlog, g_select_backlog;
size_t g_plan_next = 0, g_select_next = 0;

bool contains(const std::vector<std::string>& v, const std::string& k) { return std::find(v.begin(), v.end(), k) != v.end(); }
void add_unique(std::vector<std::string>& v, const std::string& k) { if (!contains(v, k)) v.push_back(k); }
void remove_key(std::vector<std::string>& v, const std::string& k) { v.erase(std::remove(v.begin(), v.end(), k), v.end()); }
std::string landed_key(const std::string& sat, int64_t frame_ms, const std::string& field) {
    return sat + "|" + std::to_string(frame_ms) + "|" + field;
}
// (landed keys older than the window are forgotten: the set stays the window's size)
void forget_before(int64_t horizon_ms) {
    auto old = [&](const std::string& k) {
        const size_t a = k.find('|'), b = k.find('|', a + 1);
        return a != std::string::npos && b != std::string::npos && std::atoll(k.substr(a + 1, b - a - 1).c_str()) < horizon_ms;
    };
    g_landed.erase(std::remove_if(g_landed.begin(), g_landed.end(), old), g_landed.end());
    g_view_tried.erase(std::remove_if(g_view_tried.begin(), g_view_tried.end(), old), g_view_tried.end());
    g_view_retry.erase(std::remove_if(g_view_retry.begin(), g_view_retry.end(), old), g_view_retry.end());
}

int emit_from(std::vector<Pending>& backlog, size_t& next, uint32_t per_invocation) {
    uint32_t emitted = 0;
    while (next < backlog.size() && emitted < per_invocation) {
        const Pending& p = backlog[next++];
        if (push_json(p.port_a.c_str(), p.a) < 0) return 500;
        if (!p.port_b.empty() && push_json(p.port_b.c_str(), p.b) < 0) return 500;
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

// The attribution every job carries to the parser (and on to the records and the ingest meta).
std::string attribution_json(const Satellite& sat) {
    return std::string("\"satellite\":\"") + sat.id + "\",\"sensor\":\"" + json_escape(sat.sensor) + "\",\"provider_id\":\"" + sat.provider +
           "\",\"source_name\":\"" + sat.dataset + "-world\",\"dataset_id\":\"" + sat.dataset + "\",\"origin_id\":\"" + json_escape(sat.origin) +
           "\",\"license\":\"" + sat.license_id + "\",\"license_class\":\"OpenAttribution\",\"license_url\":\"" + json_escape(sat.license_url) +
           "\",\"citation\":\"" + json_escape(sat.citation) + "\"";
}

std::string fields_json(const std::vector<std::string>& fields) {
    std::string out = "[";
    for (size_t k = 0; k < fields.size(); k++) out += std::string(k ? "," : "") + "\"" + fields[k] + "\"";
    return out + "]";
}

}  // namespace

extern "C" {

// plan: timer tick -> for every satellite, the frame hours of the window not yet landed: S3 kinds a listing request per
// product folder with its list job; view kinds a work job straight to the parser. kPlanBatch frames per invocation, the
// rest yielded as backlog (a resume without input hands out the next). When nothing is left to fetch: the node's
// unchanged notice.
//
// The window. A ledger satellite (ABI, AHI: S3 objects with ETags) plans every hour of the last imager_backfill_hours
// (default 72, the retention window) that this instance has not seen landed; the parser first probes each file's
// landed mark (publish_request) and skips what the node already holds, so a restart re-learns the window from the
// node's HTTP validator ledger instead of fetching it again. A view satellite (no ETags, no mark) plans the newest hour,
// the hours it was told were missing, and imager_view_backfill_hours (default 0) - set that once to fill a new node, then
// clear it: on a restart it would fetch those hours again (new retrieval times, new records).
int plan(void) {
    if (plugin_get_input_count() == 0) return emit_from(g_plan_backlog, g_plan_next, kPlanBatch);
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    const std::string config = load_config();
    if (!config_bool(config, "imager_live_access", true)) return push_status("live-access-disabled");
    int64_t fixed = 0;
    std::string err;
    if (!fixed_frame_ms(config, &fixed, &err)) { plugin_set_error("invalid-frame-time", err.c_str()); return 400; }
    const std::vector<std::string> satellites = list_of(config_string(config, "imager_satellites", kDefaultSatellites));
    const std::vector<std::string> fields = list_of(config_string(config, "imager_fields", kDefaultFields));
    const std::string widths = config_string(config, "imager_widths", kDefaultWidths);
    for (const std::string& f : fields) {
        if (!field_source(f)) { plugin_set_error("unknown-field", ("imager_fields names an unknown field: " + f).c_str()); return 400; }
    }
    const long timeout = static_cast<long>(config_number(config, "imager_list_timeout_ms", kDefaultListTimeoutMs));
    const int backfill = std::max(1, static_cast<int>(config_number(config, "imager_backfill_hours", kDefaultBackfillHours)));
    const int view_backfill = std::max(1, static_cast<int>(config_number(config, "imager_view_backfill_hours", kDefaultViewBackfillHours)));
    const int64_t now = now_unix_ms();
    if (now <= 0 && !fixed) { plugin_set_error("invalid-frame-time", "no clock"); return 400; }
    forget_before(floor_hour(now) - static_cast<int64_t>(std::max(backfill, view_backfill) + 24) * 3600000);
    // (a tick re-plans from scratch: what the last one queued and did not hand out yet is replaced)
    g_plan_backlog.clear(); g_plan_next = 0;
    // (newest hour first across the satellites: every satellite's latest frame before any backfill)
    std::vector<std::vector<Pending>> by_hour;
    for (const std::string& id : satellites) {
        const Satellite* sat = satellite_for(id);
        if (!sat) { plugin_set_error("unknown-satellite", ("imager_satellites names an unknown satellite: " + id).c_str()); return 400; }
        std::vector<std::string> wanted;
        for (const std::string& f : fields) if (has_field(*sat, *field_source(f))) wanted.push_back(f);
        if (wanted.empty()) continue;
        const double lag = config_number(config, (std::string("imager_lag_minutes_") + sat->id).c_str(),
                                         config_number(config, "imager_lag_minutes", sat->lag_minutes));
        const int64_t latest = fixed ? fixed : floor_hour(now - static_cast<int64_t>(lag * 60000.0));
        const int hours = fixed ? 1 : ledger_kind(*sat) ? backfill : std::max(view_backfill, kViewRetryHours);
        if (by_hour.size() < size_t(hours)) by_hour.resize(size_t(hours));
        for (int h = 0; h < hours; h++) {
            const int64_t frame = latest - static_cast<int64_t>(h) * 3600000;
            std::vector<std::string> todo;
            for (const std::string& f : wanted) if (!contains(g_landed, landed_key(sat->id, frame, f))) todo.push_back(f);
            if (todo.empty()) continue;
            if (!ledger_kind(*sat)) {
                // the newest hour and the backfill window once each, and an hour again when the parser reported it missing
                const std::string tried = sat->id + std::string("|") + std::to_string(frame) + "|";
                if (contains(g_view_retry, tried)) remove_key(g_view_retry, tried);
                else if (h >= view_backfill || contains(g_view_tried, tried)) continue;
                add_unique(g_view_tried, tried);
                Pending p;
                p.port_a = "work";
                p.a = std::string("{\"kind\":\"view\",") + attribution_json(*sat) + ",\"frame_time_ms\":" + std::to_string(frame) +
                      ",\"widths\":\"" + json_escape(widths) + "\",\"fields\":" + fields_json(todo) + ",\"behind\":" + std::to_string(h) + "}";
                by_hour[size_t(h)].push_back(p);
                continue;
            }
            int year = 0, doy = 0, hour = 0, month = 0, day = 0;
            civil(frame, &year, &doy, &hour);
            civil_ymd(frame, &year, &month, &day);
            // listings: (prefix, what the select step takes from it)
            std::vector<std::pair<std::string, std::string>> listings;
            for (const std::string& f : todo) {
                const FieldSource& src = *field_source(f);
                std::string prefix, what;
                if (sat->kind == kABI) {
                    prefix = std::string(src.abi_product) + "/" + std::to_string(year) + "/" + pad(doy, 3) + "/" + pad(hour, 2) + "/";
                    what = "abi";
                } else if (src.ahi_band) {
                    // the band's 88 tiles only (a whole minute folder holds over a thousand keys: one listing page)
                    prefix = "AHI-L2-FLDK-ISatSS/" + std::to_string(year) + "/" + pad(month, 2) + "/" + pad(day, 2) + "/" + pad(hour, 2) +
                             "00/OR_HFD-" + (src.ahi_band == 3 ? "005-B11" : "020-B12") + "-M1C" + pad(src.ahi_band, 2) + "-";
                    what = "ahi-tiles";
                } else {
                    prefix = "AHI-L2-FLDK-Clouds/" + std::to_string(year) + "/" + pad(month, 2) + "/" + pad(day, 2) + "/" + pad(hour, 2) + "00/";
                    what = "ahi-clouds";
                }
                bool merged = false;
                for (auto& l : listings) if (l.first == prefix) { l.second += "," + f; merged = true; }
                if (!merged) listings.push_back({prefix, what + ":" + f});
            }
            for (const auto& l : listings) {
                const size_t colon = l.second.find(':');
                const std::string what = l.second.substr(0, colon), list_fields = l.second.substr(colon + 1);
                const std::string url = std::string("https://") + sat->dataset + ".s3.amazonaws.com/?list-type=2&max-keys=1000&prefix=" + l.first;
                Pending p;
                p.port_a = "requests"; p.a = get_request(url, kNoValidators, timeout);
                p.port_b = "jobs";
                p.b = std::string("{\"what\":\"") + what + "\"," + attribution_json(*sat) + ",\"bucket\":\"" + sat->dataset +
                      "\",\"prefix\":\"" + json_escape(l.first) + "\",\"frame_time_ms\":" + std::to_string(frame) +
                      ",\"widths\":\"" + json_escape(widths) + "\",\"fields\":\"" + list_fields + "\",\"behind\":" + std::to_string(h) + "}";
                by_hour[size_t(h)].push_back(p);
            }
        }
    }
    for (const auto& hour : by_hour) g_plan_backlog.insert(g_plan_backlog.end(), hour.begin(), hour.end());
    if (g_plan_backlog.empty()) {
        // every frame of the window landed (or tried, for view imagery): nothing new upstream - the node's unchanged
        // notice (internal/flowrt cronmount egressReportsUnchanged), not a failure that widens the retrieval window
        return push_json("status", "{\"skipped\":\"all-landed\",\"status\":304,\"unchanged\":true}") < 0 ? 500 : 0;
    }
    return emit_from(g_plan_backlog, g_plan_next, kPlanBatch);
}

// select_files: listing responses + list jobs (paired by position) -> one work job per file the parser fetches (ABI: the
// hour's first full-disk scan of each field; AHI: a band's tiles as one job, a cloud product's file as one job naming
// the fields read from it). kPlanBatch per invocation, the rest yielded. Files not (yet) published are reported on
// status as the node's unchanged notice: nothing new upstream for them.
int select_files(void) {
    const std::vector<const plugin_input_frame_t*> jobs = frames_on("list_jobs");
    const std::vector<const plugin_input_frame_t*> listings = frames_on("listings");
    if (jobs.empty() && listings.empty()) return emit_from(g_select_backlog, g_select_next, kPlanBatch);   // resumed
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
    auto note_missing = [&](const std::string& what) { missing += std::string(missing.empty() ? "" : ",") + what; };
    for (size_t k = 0; k < jobs.size(); k++) {
        const std::string job = frame_string(jobs[k]);
        std::string what, satellite, bucket, prefix, fields, widths;
        double frame_ms = 0, behind = 0;
        json_number_field(job, "behind", &behind);
        json_string_field(job, "what", &what);
        json_string_field(job, "satellite", &satellite);
        json_string_field(job, "bucket", &bucket);
        json_string_field(job, "prefix", &prefix);
        json_string_field(job, "fields", &fields);
        json_string_field(job, "widths", &widths);
        json_number_field(job, "frame_time_ms", &frame_ms);
        const Satellite* sat = satellite_for(satellite);
        if (!sat) { plugin_set_error("unknown-satellite", ("list job names an unknown satellite: " + satellite).c_str()); return 400; }
        const plugin_input_frame_t* r = listings[k];
        long status = 0;
        std::string body;
        if (r && r->payload && r->payload_length >= 8 && memcmp(r->payload, "$HRB", 4) == 0) {
            status = static_cast<int32_t>(static_cast<uint32_t>(r->payload[4]) | (static_cast<uint32_t>(r->payload[5]) << 8) |
                                          (static_cast<uint32_t>(r->payload[6]) << 16) | (static_cast<uint32_t>(r->payload[7]) << 24));
            body.assign(reinterpret_cast<const char*>(r->payload + 8), r->payload_length - 8);
        }
        if (status != 200) { note_missing("{\"listing\":\"" + json_escape(bucket + "/" + prefix) + "\",\"http_status\":" + std::to_string(status) + "}"); continue; }
        const std::vector<Listed> listing = parse_listing(body);
        const std::string common = std::string("\"bucket\":\"") + json_escape(bucket) + "\"," + attribution_json(*sat) +
                                   ",\"frame_time_ms\":" + format_number(frame_ms) + ",\"widths\":\"" + json_escape(widths) +
                                   "\",\"timeout_ms\":" + std::to_string(timeout) + ",\"max_part_bytes\":" + format_number(max_part) +
                                   ",\"behind\":" + format_number(behind);
        auto queue_work = [&](const std::string& work) { Pending p; p.port_a = "work"; p.a = work; g_select_backlog.push_back(p); };
        auto missing_field = [&](const std::string& field) {
            note_missing("{\"field\":\"" + field + "\",\"satellite\":\"" + json_escape(satellite) + "\",\"frame_time_ms\":" + format_number(frame_ms) + "}");
        };
        if (what == "abi") {
            int year = 0, doy = 0, hour = 0;
            civil(static_cast<int64_t>(frame_ms), &year, &doy, &hour);
            const std::string stamp = "_s" + std::to_string(year) + pad(doy, 3) + pad(hour, 2) + "0";
            for (const std::string& field : list_of(fields)) {
                const FieldSource* src = field_source(field);
                if (!src) continue;
                const Listed* file = pick_abi_file(listing, stamp, src->abi_band);
                if (!file) { missing_field(field); continue; }
                queue_work("{\"kind\":\"abi\"," + common + ",\"key\":\"" + json_escape(file->key) + "\",\"size\":" + format_number(file->size) +
                           ",\"variable\":\"" + src->abi_variable + "\",\"field\":\"" + field + "\"}");
            }
        } else if (what == "ahi-tiles") {
            // one band: every tile of the minute folder's first full-disk scan (keys sorted by tile number)
            for (const std::string& field : list_of(fields)) {
                std::vector<const Listed*> tiles;
                for (const Listed& l : listing) if (l.key.compare(0, prefix.size(), prefix) == 0 && l.key.find(".nc") != std::string::npos) tiles.push_back(&l);
                std::sort(tiles.begin(), tiles.end(), [](const Listed* a, const Listed* b) { return a->key < b->key; });
                if (tiles.empty()) { missing_field(field); continue; }
                std::string keys = "[", sizes = "[";
                for (size_t t = 0; t < tiles.size(); t++) {
                    keys += std::string(t ? "," : "") + "\"" + json_escape(tiles[t]->key) + "\"";
                    sizes += std::string(t ? "," : "") + format_number(tiles[t]->size);
                }
                queue_work("{\"kind\":\"ahi-tiles\"," + common + ",\"keys\":" + keys + "],\"sizes\":" + sizes + "],\"field\":\"" + field +
                           "\",\"band\":" + std::to_string(field_source(field)->ahi_band) + "}");
            }
        } else if (what == "ahi-clouds") {
            // each cloud product file once, naming the fields (and their HDF5 variables) read from it
            std::vector<std::string> products;
            for (const std::string& field : list_of(fields)) {
                const std::string product = field_source(field)->ahi_product;
                if (std::find(products.begin(), products.end(), product) == products.end()) products.push_back(product);
            }
            for (const std::string& product : products) {
                const Listed* file = nullptr;
                for (const Listed& l : listing) if (l.key.find("/AHI-" + product + "_") != std::string::npos && (!file || l.key < file->key)) file = &l;
                std::vector<std::string> from_file, variables;
                for (const std::string& field : list_of(fields)) if (product == field_source(field)->ahi_product) { from_file.push_back(field); variables.push_back(field_source(field)->ahi_variable); }
                if (!file) { for (const std::string& f : from_file) missing_field(f); continue; }
                queue_work("{\"kind\":\"ahi-h5\"," + common + ",\"key\":\"" + json_escape(file->key) + "\",\"size\":" + format_number(file->size) +
                           ",\"fields\":" + fields_json(from_file) + ",\"variables\":" + fields_json(variables) + "}");
            }
        } else {
            plugin_set_error("unknown-list-job", ("list job of unknown kind: " + what).c_str());
            return 400;
        }
    }
    // (not published, or not yet: nothing new upstream for these - the node's unchanged notice, so an hour whose
    // products are late does not widen the retrieval window; a later tick lists it again)
    if (!missing.empty() && push_json("status", "{\"missing\":[" + missing + "],\"status\":304,\"unchanged\":true}") < 0) return 500;
    return emit_from(g_select_backlog, g_select_next, kPlanBatch);
}

// note: the parser's notices - {"satellite","frame_time_ms","field","state"}: "landed" (its landed mark answered 304:
// the node holds it), "missing" (a view frame the service did not have yet: plan tries it again next tick, while it is
// kViewRetryHours new).
int note(void) {
    for (const plugin_input_frame_t* f : frames_on("notices")) {
        const std::string n = frame_string(f);
        std::string satellite, field, state;
        double frame_ms = 0;
        json_string_field(n, "satellite", &satellite);
        json_string_field(n, "field", &field);
        json_string_field(n, "state", &state);
        json_number_field(n, "frame_time_ms", &frame_ms);
        const int64_t frame = static_cast<int64_t>(frame_ms);
        if (state == "landed") add_unique(g_landed, landed_key(satellite, frame, field));
        else if (state == "missing") add_unique(g_view_retry, satellite + "|" + std::to_string(frame) + "|");
    }
    return 0;
}

// publish_request: the storage-ingest result + the parser's ingest meta -> (1) the field is landed (plan skips it from
// now on); (2) its landed mark: a one-byte GET of the source object under ?sdn-ingest=landed&field=<field>, forced to
// 206 by an epoch If-Modified-Since, so the node's HTTP validator ledger keeps the object's ETag under that URL - the
// parser's probe of the same URL (validators added by the host) is then answered 304 even after a restart; (3) the
// dataset-publication POST for the node's loopback admin endpoint, when imager_publish_url is set. A result that
// stored nothing (refused, or zero records) marks nothing.
int publish_request(void) {
    // Results pair with metas by batch id: a meta whose ingest failed (no result) is left behind, never paired with
    // the next batch's result.
    const std::vector<const plugin_input_frame_t*> results = frames_on("result"), metas = frames_on("meta");
    const std::string config = load_config();
    const long timeout = static_cast<long>(config_number(config, "imager_list_timeout_ms", kDefaultListTimeoutMs));
    std::string url;
    const bool publish = json_string_field(config, "imager_publish_url", &url) && !url.empty();
    for (const plugin_input_frame_t* rf : results) {
        const std::string result = frame_string(rf);
        std::string batch_id, meta;
        json_string_field(result, "batch_id", &batch_id);
        for (const plugin_input_frame_t* mf : metas) {
            const std::string m = frame_string(mf);
            std::string id;
            if (json_string_field(m, "batch_id", &id) && id == batch_id) { meta = m; break; }
        }
        if (meta.empty()) {
            plugin_set_error("missing-meta-frame", ("publish_request has no parser meta for the ingest result of batch " + batch_id).c_str());
            return 400;
        }
        std::string schema, provider, source;
        if (!json_string_field(result, "schema", &schema) || schema.empty()) json_string_field(meta, "schema", &schema);
        json_string_field(meta, "provider_id", &provider);
        json_string_field(meta, "source_name", &source);
        double inserted = -1;
        json_number_field(result, "inserted", &inserted);
        if (inserted > 0) {
            std::string satellite, field, mark;
            double frame_ms = 0;
            json_string_field(meta, "satellite", &satellite);
            json_string_field(meta, "field", &field);
            json_string_field(meta, "landed_mark", &mark);
            json_number_field(meta, "frame_time_ms", &frame_ms);
            if (!satellite.empty() && !field.empty()) add_unique(g_landed, landed_key(satellite, static_cast<int64_t>(frame_ms), field));
            if (!mark.empty() && push_json("mark", get_request(mark, std::string(kNoValidators) + ",\"Range\":\"bytes=0-0\"", timeout)) < 0) return 500;
        }
        if (!publish) continue;
        if (schema.empty() || batch_id.empty() || provider.empty() || source.empty()) {
            plugin_set_error("incomplete-publication-identity", "publish_request needs schema, batchId, providerId and sourceName.");
            return 400;
        }
        const std::string body = std::string("{\"schema\":\"") + json_escape(schema) + "\",\"providerId\":\"" + json_escape(provider) +
                                 "\",\"sourceName\":\"" + json_escape(source) + "\",\"batchId\":\"" + json_escape(batch_id) + "\"}";
        const std::string request = std::string("{\"method\":\"POST\",\"url\":\"") + json_escape(url) + "\"" +
                                    ",\"headers\":{\"content-type\":\"application/json\"},\"bodyB64\":\"" +
                                    base64_encode(reinterpret_cast<const uint8_t*>(body.data()), body.size()) + "\"" +
                                    ",\"timeoutMs\":" + std::to_string(timeout) + "}";
        if (push_json("request", request) < 0) return 500;
    }
    return 0;
}

}  // extern "C"
