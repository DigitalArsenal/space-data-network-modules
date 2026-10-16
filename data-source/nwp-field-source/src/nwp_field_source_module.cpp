/*
 * data-source/nwp-field-source (typed contracts 1.0: FlatBuffers only, no JSON and no base64).
 *
 * Request-builder flow nodes for numerical-weather-prediction model fields in NOAA Open Data Dissemination's anonymous
 * public buckets (NCEP GFS noaa-gfs-bdp-pds, GEFS noaa-gefs-pds), fetched message by message through each file's .idx
 * inventory. No credentials and no capabilities beyond the node config: the http connector does the fetching.
 *
 *   plan            : TimerTick (TICK) -> the run's inventory HttpRequests (HREQ; product by product, lead by lead),
 *                     16 per invocation, the rest yielded as backlog (or one FlowNotice when skipped / already planned).
 *   select_messages : the inventories' HttpResponses (HRSP) -> each lead-file's wanted messages as byte-range
 *                     HttpRequests (adjacent ones merged, each under 64 MiB) - ONE BATCH (a lead-file, or 16 of its
 *                     ranges) PER INVOCATION, the rest yielded as backlog, so the parser holds one batch's messages
 *                     (never more than 32 frames a port) and storage-ingest gets one meta + one record stream at a time.
 *                     A lead the run lacks -> a FlowNotice Missing; inventories answered 304 -> a FlowNotice Unchanged.
 *   publish_request : IngestResult (INGR) + the parser's IngestRequest (INGQ) -> the dataset-publication POST
 *                     (nwp_publish_url): an HttpRequest whose BODY is the IngestResult naming the stored batch.
 *
 * JOB STATE TRAVELS AS HttpRequest.CONTEXT: one size-prefixed $WXF HEADER RECORD per (product, lead) - the field the
 * job fetches, without values - built by plan, echoed by the http connector in the HttpResponse, copied verbatim by
 * select_messages into every range request of the lead-file, and read by the parser (nwp-grib2-parser) as its job:
 *   FIELD_ID       "<model_key>:<run YYYYMMDDTHH>:f<LLL>:<product>"   (the parser names records and tile batches from
 *                                                                      its first two parts)
 *   VARIABLE_NAME  the product id (gfs-1p00-motion, ..., gfs-0p25-sea): the ingest lane's SOURCE_NAME
 *   MODEL_CLASS, MODEL_ID, TIME_BASIS Initialization, INIT_TIME_MS (the run), LEAD_HOURS, VALID_TIME_MS
 *   MEMBER_KIND    StandardDeviation for the GEFS spread, else Unspecified; ENSEMBLE_SIZE (GEFS 31)
 *   GRID           RegularLatLon; DLAT = DLON = the records' spacing in degrees (the native spacing times the stride:
 *                  GEFS 0.5 deg spread at every other point = 1 deg); NLAT = rows per record (0 = the whole field)
 *   TILE_COUNT     > 1: the field is cut into that many square tiles, 2n x n (gfs-0p25-sea: 512 = 11.25 deg tiles)
 *   SOURCE_URL     the GRIB2 file; ORIGIN_ID, DATASET_ID (the bucket), LICENSE_CLASS, LICENSE_URL, CITATION
 * Pairing is by CONTEXT, never by position: a response that carries no $WXF header cannot be attributed and is refused.
 *
 * Products (nwp_products; the world-clouds display's, as its reference fetchers choose them): gfs-1p00-motion (UGRD,
 * VGRD and, to nwp_motion_heights_to, HGT at 1000-200 hPa), gefs-0p50-spread (the ensemble's wind spread at those
 * levels, every other point), gfs-0p50-clouds (total/low/middle/high cloud cover, instantaneous, and the surface fields
 * the node's 1° world-clouds kernel samples from the 0.5° grid: 2 m temperature and dew point, 10 m wind,
 * boundary-layer height, CAPE and surface height), each lead 0 .. nwp_max_lead by nwp_lead_step; gfs-0p25-physics
 * (2 m temperature and dew point, 10 m wind, boundary-layer height, CAPE, surface height, cloud layers, and
 * temperature/height/wind/humidity/vertical velocity on 21 levels plus the tropopause) at nwp_physics_leads; gfs-0p25-sea (10 m wind, 2 m temperature and dew point, boundary-layer height, surface
 * height, the instantaneous precipitation rate, visibility and the cloud ceiling's height) each lead, cut by the parser
 * into 11.25° tiles, one batch a tile a lead (gfs:<run>:f<LLL>:s4:<x>:<y>, x from 180 W, y from the north pole).
 *
 * Node CONFIG through plugin.getConfig (SDS $PIV: one ModuleConfig FlatBuffer on raw "config", read
 * through sdm_piv::get_config()): nwp_live_access (default true), nwp_run (YYYYMMDDTHH / ISO / Unix ms; default the latest cycle
 * nwp_lag_hours (5) old), nwp_products (a comma list or a list), nwp_max_lead (384), nwp_lead_step (3),
 * nwp_motion_heights_to (12), nwp_physics_leads ("0,3" or a list), nwp_idx_timeout_ms, nwp_grib_timeout_ms,
 * nwp_publish_url (unset: no publication).
 */
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <sys/time.h>

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "HttpRequest_generated.h"
#include "HttpResponse_generated.h"
#include "IngestRequest_generated.h"
#include "IngestResult_generated.h"
#include "FlowNotice_generated.h"
// $WXF (spacedatastandards.org lib/cpp/WXF/main_generated.h) is inlined ahead of this file by build.mjs.

namespace {

namespace A = sdn::runtime::Aligned;
namespace R = sdn::runtime;

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

bool is_ws(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

std::string trim(const std::string& s) {
    size_t b = 0, e = s.size();
    while (b < e && is_ws(s[b])) b++;
    while (e > b && is_ws(s[e - 1])) e--;
    return s.substr(b, e - b);
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
// Node config: plugin.getConfig as an SDS $PIV hostcall - one ModuleConfig FlatBuffer (MCFG) on raw "config", read in
// place through sdm_piv::get_config() (lookups by key or dotted path: "nwp_products.0"). No config (or a host that
// provides none) reads as the defaults, as before.
// ---------------------------------------------------------------------------

struct Config {
    sdm_piv::Config config;

    static std::string text_of(const sdm_piv::ConfigTable& c, const std::string& key, const R::ConfigEntry& e) {
        switch (e.KIND()) {
            case R::configValueKind_String: return std::string(c.string(key));
            case R::configValueKind_Number: return format_number(e.NUMBER_VALUE());
            case R::configValueKind_Bool: return e.BOOL_VALUE() ? "true" : "false";
            default: return {};
        }
    }
    // A scalar, or a list joined with commas; `fallback` when absent or empty.
    std::string string(const char* key, const char* fallback) const {
        const R::ConfigEntry* e = config.entry(key);
        std::string v;
        if (e && e->KIND() == R::configValueKind_StringList) {
            int i = 0;
            for (std::string_view item : config.strings(key)) v += (i++ ? "," : "") + std::string(item);
        } else if (e && e->KIND() == R::configValueKind_NumberList) {
            int i = 0;
            for (double item : config.numbers(key)) v += (i++ ? "," : "") + format_number(item);
        } else if (e) {
            v = text_of(config, key, *e);
        }
        return v.empty() ? fallback : v;
    }
    // A number (a numeric string is tolerated, as the operator config always allowed).
    double number(const char* key, double fallback) const {
        const R::ConfigEntry* e = config.entry(key);
        if (!e) return fallback;
        if (e->KIND() == R::configValueKind_Number) return e->NUMBER_VALUE();
        if (e->KIND() == R::configValueKind_String) {
            const std::string s(config.string(key));
            char* end = nullptr;
            const double v = strtod(s.c_str(), &end);
            if (end != s.c_str()) return v;
        }
        return fallback;
    }
    bool boolean(const char* key, bool fallback) const {
        const R::ConfigEntry* e = config.entry(key);
        if (!e) return fallback;
        if (e->KIND() == R::configValueKind_Bool) return e->BOOL_VALUE();
        if (e->KIND() == R::configValueKind_Number) return e->NUMBER_VALUE() != 0;
        if (e->KIND() != R::configValueKind_String) return fallback;
        const std::string_view s = config.string(key);
        if (s == "true" || s == "1") return true;
        if (s == "false" || s == "0") return false;
        return fallback;
    }
};

Config load_config() { return Config{sdm_piv::get_config()}; }

// ---------------------------------------------------------------------------
// Frame IO.
// ---------------------------------------------------------------------------

const plugin_input_frame_t* frame_for(const char* port_id) {
    const int32_t index = plugin_find_input_index(port_id, 0);
    if (index < 0) return nullptr;
    return plugin_get_input_frame(static_cast<uint32_t>(index));
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

using Bytes = std::vector<uint8_t>;

Bytes finished(const flatbuffers::FlatBufferBuilder& b) { return Bytes(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize()); }

// An HttpRequest (HREQ). Headers are given lower-cased; the vector is written sorted by NAME (a FlatBuffers key).
Bytes http_request(const char* method, const std::string& url, std::vector<std::pair<std::string, std::string>> headers,
                   const Bytes* body, uint32_t timeout_ms, const Bytes* context) {
    flatbuffers::FlatBufferBuilder b(512 + (body ? body->size() : 0) + (context ? context->size() : 0));
    std::sort(headers.begin(), headers.end());
    std::vector<flatbuffers::Offset<R::Header>> header_offsets;
    for (const auto& [name, value] : headers) header_offsets.push_back(R::CreateHeaderDirect(b, name.c_str(), value.c_str()));
    R::FinishHttpRequestBuffer(b, R::CreateHttpRequestDirect(b, method, url.c_str(), &header_offsets, body, timeout_ms, 0, context));
    return finished(b);
}

int push_request(const char* port, const Bytes& request) {
    return plugin_push_output_ex(port, "HttpRequest.fbs", R::HttpRequestIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 "HttpRequest", 0, 0, request.data(), static_cast<uint32_t>(request.size()));
}

// A FlowNotice (FNTC) on "status": what a pass did that is not a stored batch.
int push_notice(R::flowNoticeKind kind, const std::string& reason, uint64_t count = 0, std::vector<std::string> items = {},
                const char* provider = "") {
    R::FlowNoticeT notice;
    notice.KIND = kind;
    notice.PROVIDER_ID = provider;
    notice.REASON = reason;
    notice.COUNT = count;
    notice.ITEMS = std::move(items);
    flatbuffers::FlatBufferBuilder b(256);
    R::FinishFlowNoticeBuffer(b, R::FlowNotice::Pack(b, &notice));
    return plugin_push_output_ex("status", "FlowNotice.fbs", R::FlowNoticeIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 "FlowNotice", 0, 0, b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize()));
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
    wxfModelClass model_class;
    double native_deg;          // the file's grid spacing
    int stride, band_rows, ensemble_size;
    bool spread;
    double tile_deg;            // > 0: the parser cuts the fields into tiles of this size, one batch a tile
};
const Product kProducts[] = {
    {"gfs-1p00-motion", "noaa-gfs-bdp-pds.s3.amazonaws.com", "gfs.{D}/{H}/atmos/gfs.t{H}z.pgrb2.1p00.f{L}", "gfs", "NCEP GFS 1°", wxfModelClass_NumericalGlobalDeterministic, 1.0, 1, 0, 0, false, 0},
    {"gefs-0p50-spread", "noaa-gefs-pds.s3.amazonaws.com", "gefs.{D}/{H}/atmos/pgrb2ap5/gespr.t{H}z.pgrb2a.0p50.f{L}", "gefs", "NCEP GEFS 0.5° (every other point)", wxfModelClass_NumericalGlobalEnsemble, 0.5, 2, 0, 31, true, 0},
    {"gfs-0p50-clouds", "noaa-gfs-bdp-pds.s3.amazonaws.com", "gfs.{D}/{H}/atmos/gfs.t{H}z.pgrb2.0p50.f{L}", "gfs", "NCEP GFS 0.5°", wxfModelClass_NumericalGlobalDeterministic, 0.5, 1, 0, 0, false, 0},
    {"gfs-0p25-physics", "noaa-gfs-bdp-pds.s3.amazonaws.com", "gfs.{D}/{H}/atmos/gfs.t{H}z.pgrb2.0p25.f{L}", "gfs", "NCEP GFS 0.25°", wxfModelClass_NumericalGlobalDeterministic, 0.25, 1, 64, 0, false, 0},
    // the weather at the surface the world-clouds display reads about its camera (sea state, fog, rain): 11.25° tiles,
    // one batch a tile a lead (gfs:<run>:f<LLL>:s4:<x>:<y>), so a client fetches only the tiles it stands in
    {"gfs-0p25-sea", "noaa-gfs-bdp-pds.s3.amazonaws.com", "gfs.{D}/{H}/atmos/gfs.t{H}z.pgrb2.0p25.f{L}", "gfs", "NCEP GFS 0.25°", wxfModelClass_NumericalGlobalDeterministic, 0.25, 1, 0, 0, false, 11.25},
};
const Product* product_named(const std::string& id) {
    for (const Product& p : kProducts) if (id == p.id) return &p;
    return nullptr;
}

bool surface_field(const std::string& var, const std::string& level) {
    return ((var == "TMP" || var == "DPT") && level == "2 m above ground") ||
           ((var == "UGRD" || var == "VGRD") && level == "10 m above ground") ||
           ((var == "HPBL" || var == "CAPE" || var == "HGT") && level == "surface");
}

// Whether an inventory line's message is one the product publishes (lead: hours; heights_to: the last motion lead with
// geopotential height).
bool wanted(const Product& p, const std::string& var, const std::string& level, const std::string& fcst, int lead, int heights_to) {
    if (!instantaneous(fcst)) return false;
    const std::string id = p.id;
    if (id == "gfs-1p00-motion") return level_in(level, kMotionLevels, 9) && (var == "UGRD" || var == "VGRD" || (var == "HGT" && lead <= heights_to));
    if (id == "gefs-0p50-spread") return level_in(level, kMotionLevels, 9) && (var == "UGRD" || var == "VGRD");
    if (id == "gfs-0p50-clouds")
        return surface_field(var, level) || (var == "TCDC" && level == "entire atmosphere") || (var == "LCDC" && level == "low cloud layer") ||
               (var == "MCDC" && level == "middle cloud layer") || (var == "HCDC" && level == "high cloud layer");
    if (id == "gfs-0p25-sea") {
        if ((var == "TMP" || var == "DPT") && level == "2 m above ground") return true;
        if ((var == "UGRD" || var == "VGRD") && level == "10 m above ground") return true;
        if ((var == "HPBL" || var == "HGT" || var == "PRATE" || var == "VIS") && level == "surface") return true;
        return var == "HGT" && level == "cloud ceiling";
    }
    if (id == "gfs-0p25-physics") {
        if (surface_field(var, level)) return true;
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
// A batch's ranges: the compiled runtime hands a node at most 64 frames an invocation, so the parser's responses of one
// batch must stay at 32 or fewer - a lead-file with more ranges is split into batches of 16.
constexpr size_t kMaxRangesPerBatch = 16;
constexpr const char* kProviderID = "noaa-ncep";
constexpr const char* kOriginID = "NOAA Open Data Dissemination (AWS)";
constexpr const char* kLicenseURL = "https://www.weather.gov/disclaimer";
// (see imager-observation-source: the host's validators must never turn a repeat inventory or range into an empty 304)
constexpr const char* kNoValidatorsName = "if-modified-since";
constexpr const char* kNoValidatorsValue = "Thu, 01 Jan 1970 00:00:00 GMT";

std::vector<std::string> list_of(const std::string& text) { return split(text, ','); }
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

// The job of one (product, lead): a size-prefixed $WXF header record (no values) naming the field the job fetches and
// how the parser is to cut it. It travels as HttpRequest.CONTEXT and comes back verbatim in the HttpResponse.
Bytes job_header(const Product& p, int64_t run_ms, const std::string& run_id, int lead, const std::string& url) {
    flatbuffers::FlatBufferBuilder b(1024);
    const std::string host = url.substr(8, url.find('/', 8) - 8);
    const auto field_id = b.CreateString(std::string(p.model_key) + ":" + run_id + ":f" + pad(lead, 3) + ":" + p.id);
    const auto model_id = b.CreateString(p.model_id);
    const auto variable_name = b.CreateString(p.id);
    const auto origin = b.CreateString(kOriginID);
    const auto dataset = b.CreateString(host.substr(0, host.find('.')));
    const auto source_url = b.CreateString(url);
    const auto license_url = b.CreateString(kLicenseURL);
    const auto citation = b.CreateString(std::string("NOAA/NCEP ") +
                                         (p.spread ? "Global Ensemble Forecast System ensemble standard deviation" : "Global Forecast System") +
                                         " via NOAA Open Data Dissemination (AWS)");
    WXFGridBuilder grid(b);
    grid.add_KIND(wxfGridKind_RegularLatLon);
    grid.add_DLAT(p.native_deg * p.stride);
    grid.add_DLON(p.native_deg * p.stride);
    grid.add_NLAT(static_cast<uint32_t>(p.band_rows));
    const auto grid_off = grid.Finish();
    WXFBuilder r(b);
    r.add_FIELD_ID(field_id);
    r.add_MODEL_CLASS(p.model_class);
    r.add_MODEL_ID(model_id);
    r.add_TIME_BASIS(wxfTimeBasis_Initialization);
    r.add_INIT_TIME_MS(static_cast<uint64_t>(run_ms));
    r.add_LEAD_HOURS(static_cast<float>(lead));
    r.add_VALID_TIME_MS(static_cast<uint64_t>(run_ms + static_cast<int64_t>(lead) * 3600000));
    r.add_MEMBER_KIND(p.spread ? wxfMemberKind_StandardDeviation : wxfMemberKind_Unspecified);
    if (p.ensemble_size > 0) r.add_ENSEMBLE_SIZE(static_cast<uint16_t>(p.ensemble_size));
    r.add_VARIABLE_NAME(variable_name);
    r.add_TEMPORAL_KIND(wxfTemporalKind_Instantaneous);
    r.add_GRID(grid_off);
    if (p.tile_deg > 0) r.add_TILE_COUNT(static_cast<uint32_t>(std::lround(360.0 / p.tile_deg) * std::lround(180.0 / p.tile_deg)));
    r.add_ORIGIN_ID(origin);
    r.add_DATASET_ID(dataset);
    r.add_SOURCE_URL(source_url);
    r.add_LICENSE_CLASS(wxfLicenseClass_OpenAttribution);
    r.add_LICENSE_URL(license_url);
    r.add_CITATION(citation);
    FinishSizePrefixedWXFBuffer(b, r.Finish());
    return finished(b);
}

// The job header an HttpResponse carries back in CONTEXT, or nullptr when it carries none (or not a $WXF).
const WXF* job_of(const R::HttpResponse& response) {
    const auto* context = response.CONTEXT();
    if (!context || context->size() < 8) return nullptr;
    flatbuffers::Verifier verifier(context->data(), context->size());
    if (!VerifySizePrefixedWXFBuffer(verifier)) return nullptr;
    const WXF* job = GetSizePrefixedWXF(context->data());
    return job->VARIABLE_NAME() && job->SOURCE_URL() ? job : nullptr;
}

// The run: nwp_run ("YYYYMMDDTHH" / ISO / Unix ms) when set, else the latest 6-hourly cycle nwp_lag_hours old.
bool run_time_ms(const Config& config, int64_t* out, std::string* err) {
    const std::string set = config.string("nwp_run", "");
    if (!set.empty()) {
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
    const int64_t t = now - static_cast<int64_t>(config.number("nwp_lag_hours", kDefaultLagHours) * 3600000.0);
    *out = t - ((t % 21600000) + 21600000) % 21600000;
    return true;
}

// ---------------------------------------------------------------------------
// Backlogs: plan hands out kPlanBatch inventory requests per invocation; select_messages one lead-file (all its byte
// ranges, at most kMaxRangesPerBatch) per invocation, so the parser holds one file's messages and storage-ingest receives
// one meta and one record stream at a time. The compiled runtime resumes a yielded node without input.
// ---------------------------------------------------------------------------

struct Pending { std::vector<Bytes> requests; };
std::vector<Pending> g_plan_backlog, g_select_backlog;
std::string g_planned;   // the run (and products, leads) plan() last queued - plan_key
size_t g_plan_next = 0, g_select_next = 0;

int emit_from(std::vector<Pending>& backlog, size_t& next, uint32_t per_invocation, const char* request_port) {
    uint32_t emitted = 0;
    while (next < backlog.size() && emitted < per_invocation) {
        const Pending& p = backlog[next++];
        for (const Bytes& request : p.requests)
            if (push_request(request_port, request) < 0) return 500;
        emitted++;
    }
    const uint32_t remaining = static_cast<uint32_t>(backlog.size() - next);
    if (remaining == 0) { backlog.clear(); next = 0; }
    plugin_set_backlog_remaining(remaining);
    plugin_set_yielded(remaining > 0 ? 1 : 0);
    return 0;
}

}  // namespace

extern "C" {

// plan: TimerTick -> the run's inventory (.idx) requests, product by product and lead by lead, kPlanBatch per
// invocation (the rest yielded as backlog); a resume without input hands out the next batch. The tick's fields are not
// read: any tick plans. One FlowNotice when the cycle is skipped or already planned.
int plan(void) {
    if (plugin_get_input_count() == 0) return emit_from(g_plan_backlog, g_plan_next, kPlanBatch, "requests");
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    const Config config = load_config();
    if (!config.boolean("nwp_live_access", true)) return push_notice(R::flowNoticeKind_Skipped, "live-access-disabled") < 0 ? 500 : 0;
    int64_t run = 0;
    std::string err;
    if (!run_time_ms(config, &run, &err)) { plugin_set_error("invalid-run", err.c_str()); return 400; }
    int y = 0, mo = 0, d = 0, h = 0;
    civil_ymdh(run, &y, &mo, &d, &h);
    const std::string D = std::to_string(y) + pad(mo, 2) + pad(d, 2), H = pad(h, 2), run_id = D + "T" + H;
    const int max_lead = static_cast<int>(config.number("nwp_max_lead", kDefaultMaxLead));
    const int step = std::max(1, static_cast<int>(config.number("nwp_lead_step", kDefaultLeadStep)));
    std::vector<int> physics_leads;
    for (const std::string& l : list_of(config.string("nwp_physics_leads", kDefaultPhysicsLeads))) physics_leads.push_back(std::atoi(l.c_str()));
    const uint32_t timeout = static_cast<uint32_t>(config.number("nwp_idx_timeout_ms", kDefaultIdxTimeoutMs));
    // A run already planned (the same run, products and leads): nothing planned again - the tick only lets the work it
    // queued go on. A node drains a bounded number of invocations a trigger (internal/flowrt cronmount: 1000); a run of
    // tiled leads (gfs-0p25-sea: 512 batches a lead) takes several triggers, and re-planning the same run on each would
    // fetch and store it again (each record carries its retrieval time: new bytes, new CIDs). A new cycle plans as before.
    const std::string products = config.string("nwp_products", kDefaultProducts);
    const std::string plan_key = run_id + "|" + products + "|" + std::to_string(max_lead) + "|" + std::to_string(step) + "|" +
                                 config.string("nwp_physics_leads", kDefaultPhysicsLeads);
    if (plan_key == g_planned) {
        if (g_plan_next < g_plan_backlog.size()) return emit_from(g_plan_backlog, g_plan_next, kPlanBatch, "requests");
        // Nothing new upstream (the next cycle is not out yet): the node's unchanged notice, so a quiet tick between
        // cycles is a success without a batch, not a failure that widens the retrieval window and holds the next cycle back.
        return push_notice(R::flowNoticeKind_Unchanged, "already-planned") < 0 ? 500 : 0;
    }
    g_planned = plan_key;
    for (const std::string& id : list_of(products)) {
        const Product* p = product_named(id);
        if (!p) { plugin_set_error("unknown-product", ("nwp_products names an unknown product: " + id).c_str()); return 400; }
        std::vector<int> leads;
        if (std::string(p->id) == "gfs-0p25-physics") leads = physics_leads;
        else for (int lead = 0; lead <= max_lead; lead += step) leads.push_back(lead);
        for (int lead : leads) {
            const std::string url = std::string("https://") + p->host + "/" + replace_all(replace_all(replace_all(p->path, "{D}", D), "{H}", H), "{L}", pad(lead, 3));
            const Bytes header = job_header(*p, run, run_id, lead, url);
            Pending pending;
            pending.requests.push_back(http_request("GET", url + ".idx", {{kNoValidatorsName, kNoValidatorsValue}}, nullptr, timeout, &header));
            g_plan_backlog.push_back(std::move(pending));
        }
    }
    if (g_plan_backlog.empty()) return push_notice(R::flowNoticeKind_Skipped, "nothing-to-fetch") < 0 ? 500 : 0;
    return emit_from(g_plan_backlog, g_plan_next, kPlanBatch, "requests");
}

// select_messages: the inventories' HttpResponses, each carrying its job header in CONTEXT -> each lead-file's wanted
// messages as byte-range HttpRequests (adjacent messages merged, each range under kMaxRangeBytes), the job header copied
// into every one; one lead-file per invocation, the rest yielded as backlog. A missing inventory (a lead the run does
// not have) is reported as a FlowNotice Missing; inventories answered 304 as a FlowNotice Unchanged.
int select_messages(void) {
    const std::vector<const plugin_input_frame_t*> inventories = frames_on("inventories");
    if (inventories.empty()) return emit_from(g_select_backlog, g_select_next, 1, "requests");
    const Config config = load_config();
    const uint32_t timeout = static_cast<uint32_t>(config.number("nwp_grib_timeout_ms", kDefaultGribTimeoutMs));
    const int heights_to = static_cast<int>(config.number("nwp_motion_heights_to", kDefaultHeightsTo));
    std::vector<std::string> missing;
    uint64_t unchanged = 0;
    for (size_t k = 0; k < inventories.size(); k++) {
        const plugin_input_frame_t* frame = inventories[k];
        flatbuffers::Verifier verifier(frame && frame->payload ? frame->payload : reinterpret_cast<const uint8_t*>(""), frame ? frame->payload_length : 0);
        if (!frame || !frame->payload || !R::VerifyHttpResponseBuffer(verifier)) {
            plugin_set_error("invalid-response-frame", ("inventory " + std::to_string(k) + " is not an HttpResponse (HRSP)").c_str());
            return 400;
        }
        const R::HttpResponse& r = *R::GetHttpResponse(frame->payload);
        const WXF* job = job_of(r);
        if (!job) {
            // pairing is by CONTEXT: a response that names no job cannot be attributed, so it is refused, not guessed
            plugin_set_error("missing-context", ("inventory " + std::to_string(k) + " (" + (r.URL() ? r.URL()->str() : std::string()) +
                                                 ") carries no $WXF job header in CONTEXT; it cannot be attributed and is refused.").c_str());
            return 400;
        }
        const std::string product_id = job->VARIABLE_NAME()->str(), url = job->SOURCE_URL()->str();
        const int lead = static_cast<int>(std::lround(job->LEAD_HOURS()));
        const Product* p = product_named(product_id);
        const long status = r.STATUS();
        // 304: the host presented the inventory's validators (the retrieval ledger keeps them across restarts) and the
        // publisher has nothing new - a lead already ingested, e.g. a run planned again after a node restart. Nothing to
        // fetch, and not a missing lead: counted, and said once below as the node's unchanged notice.
        if (p && status == 304) { unchanged++; continue; }
        if (!p || status != 200) {
            missing.push_back(url + ".idx: HTTP " + std::to_string(status) + (r.ERROR() && r.ERROR()->size() ? " (" + r.ERROR()->str() + ")" : std::string()));
            continue;
        }
        const std::string body = r.BODY() ? std::string(reinterpret_cast<const char*>(r.BODY()->data()), r.BODY()->size()) : std::string();
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
            if (!wanted(*p, lines[i].var, lines[i].level, lines[i].fcst, lead, heights_to)) continue;
            const long long a = lines[i].offset, b = i + 1 < lines.size() ? lines[i + 1].offset - 1 : -1;
            if (!ranges.empty() && ranges.back().second != -1 && ranges.back().second + 1 == a && (b == -1 || b - ranges.back().first + 1 <= kMaxRangeBytes)) ranges.back().second = b;
            else ranges.push_back({a, b});
        }
        if (ranges.empty()) {
            missing.push_back(product_id + " f" + pad(lead, 3) + ": no wanted message in " + url + ".idx");
            continue;
        }
        const Bytes header(r.CONTEXT()->data(), r.CONTEXT()->data() + r.CONTEXT()->size());
        Pending pending;
        auto flush = [&]() { if (!pending.requests.empty()) { g_select_backlog.push_back(std::move(pending)); pending = Pending(); } };
        for (const auto& range : ranges) {
            if (pending.requests.size() == kMaxRangesPerBatch) flush();
            const std::string bytes = "bytes=" + std::to_string(range.first) + "-" + (range.second >= 0 ? std::to_string(range.second) : std::string());
            pending.requests.push_back(http_request("GET", url, {{kNoValidatorsName, kNoValidatorsValue}, {"range", bytes}}, nullptr, timeout, &header));
        }
        flush();
    }
    if (!missing.empty() && push_notice(R::flowNoticeKind_Missing, "missing-leads", missing.size(), missing, kProviderID) < 0) return 500;
    // (the node reads it only when the run landed nothing: then a success without a batch, not a failure)
    if (unchanged > 0 && push_notice(R::flowNoticeKind_Unchanged, "inventory-304", unchanged, {}, kProviderID) < 0) return 500;
    return emit_from(g_select_backlog, g_select_next, 1, "requests");
}

// publish_request: the storage-ingest IngestResult + the parser's IngestRequest -> the dataset-publication POST
// (nwp_publish_url), its BODY the IngestResult naming the stored batch (SCHEMA, PROVIDER_ID, SOURCE_NAME, BATCH_ID);
// nothing when nwp_publish_url is unset, or when the batch was REFUSED (nothing was stored).
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
    flatbuffers::Verifier result_verifier(result_frame->payload, result_frame->payload_length);
    if (!R::VerifyIngestResultBuffer(result_verifier)) { plugin_set_error("invalid-result-frame", "the result frame is not an IngestResult (INGR)."); return 400; }
    flatbuffers::Verifier meta_verifier(meta_frame->payload, meta_frame->payload_length);
    if (!R::VerifyIngestRequestBuffer(meta_verifier)) { plugin_set_error("invalid-meta-frame", "the meta frame is not an IngestRequest (INGQ)."); return 400; }
    const Config config = load_config();
    const std::string url = config.string("nwp_publish_url", "");
    if (url.empty()) return 0;
    const R::IngestResult& result = *R::GetIngestResult(result_frame->payload);
    const R::IngestRequest& meta = *R::GetIngestRequest(meta_frame->payload);
    if (result.REFUSED() && result.REFUSED()->size()) return 0;   // nothing stored, nothing to publish
    const auto text = [](const flatbuffers::String* s) { return s ? s->str() : std::string(); };
    std::string schema = text(result.SCHEMA()), batch_id = text(result.BATCH_ID());
    if (schema.empty()) schema = text(meta.SCHEMA());
    if (batch_id.empty()) batch_id = text(meta.TAGS()->BATCH_ID());
    const std::string provider = text(meta.TAGS()->PROVIDER_ID()), source = text(meta.TAGS()->SOURCE_NAME());
    if (schema.empty() || batch_id.empty() || provider.empty() || source.empty()) { plugin_set_error("incomplete-publication-identity", "publish_request needs schema, batchId, providerId and sourceName."); return 400; }
    flatbuffers::FlatBufferBuilder b(512);
    R::FinishIngestResultBuffer(b, R::CreateIngestResultDirect(b, schema.c_str(), provider.c_str(), source.c_str(), batch_id.c_str(), result.INSERTED(),
                                                               result.RECONCILED_DUPLICATES(), result.RECONCILED_OLD_BATCHES(),
                                                               result.ARCHIVED() && result.ARCHIVED()->size() ? result.ARCHIVED()->c_str() : nullptr, nullptr));
    const Bytes body = finished(b);
    const Bytes request = http_request("POST", url, {{"content-type", "application/octet-stream"}}, &body,
                                       static_cast<uint32_t>(config.number("nwp_idx_timeout_ms", kDefaultIdxTimeoutMs)), nullptr);
    return push_request("request", request) < 0 ? 500 : 0;
}

}  // extern "C"
