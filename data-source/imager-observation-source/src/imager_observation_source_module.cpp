/*
 * data-source/imager-observation-source (typed contracts 1.0).
 *
 * Request-builder flow nodes for geostationary imager observations in NOAA Open Data Dissemination's anonymous public
 * buckets (GOES-East noaa-goes19, GOES-West noaa-goes18: ABI L1b/L2 NetCDF4 under <product>/<YYYY>/<DDD>/<HH>/). No
 * credentials and no capabilities beyond the node config: the http connector does the fetching.
 *
 *   plan            : TimerTick -> one S3 ListObjectsV2 HttpRequest (HREQ) per (satellite, product folder) of the frame
 *                     hour, its list job in HREQ.CONTEXT (or one FlowNotice when skipped).
 *   select_files    : the listings, HttpResponses (HRSP) each echoing its list job in CONTEXT -> each wanted field's file
 *                     (the hour's first full-disk scan) as GET HttpRequests, byte ranges when larger than
 *                     imager_max_part_bytes, each part's file job in CONTEXT - ONE FILE PER INVOCATION, the rest yielded
 *                     as backlog, so the parser holds one file and storage-ingest gets one meta + one record stream at a
 *                     time. Missing files / failed listings -> one FlowNotice (Missing).
 *   publish_request : IngestResult (INGR) + the parser's IngestRequest (INGQ) -> the dataset-publication POST
 *                     (imager_publish_url).
 *
 * JOBS ride in HREQ.CONTEXT as ONE size-prefixed $WXF record holding only the header fields that name the job (GRID
 * is required by the standard, so it is present and empty):
 *   list job  FIELD_ID       the wanted fields of that product folder, comma-separated (e.g. "reflectance_064um,
 *                            brightness_temperature_10um")
 *             SENSOR_ID      the imager ("GOES-19 ABI"); DATASET_ID the bucket; SOURCE_URL the folder prefix
 *                            ("ABI-L2-CMIPF/2026/280/06/"); VALID_TIME_MS the frame hour
 *   file job  FIELD_ID       the field ("reflectance_064um"); VARIABLE_NAME the NetCDF variable ("CMI")
 *             SENSOR_ID, DATASET_ID (bucket), SOURCE_URL (the object's https URL; the key follows the host),
 *             ORIGIN_ID, LICENSE_CLASS OpenAttribution, LICENSE_URL, CITATION, VALID_TIME_MS (frame hour),
 *             TILE_INDEX / TILE_COUNT (byte-range part / parts)
 * The satellite id is the bucket's (kSatellites). The output widths are node config (imager_widths) the parser reads
 * itself; the provider id (noaa-goes), source name (<bucket>-world) and licence id are the parser's constants.
 *
 * Node CONFIG (plugin.getConfig, one ModuleConfig): imager_live_access (default true), imager_satellites
 * ("goes-east,goes-west"), imager_fields (the five the world-clouds display reads), imager_frame_time (ISO or Unix ms;
 * default the latest hour imager_lag_minutes (20) old), imager_max_part_bytes (64 MiB), imager_list_timeout_ms (60000),
 * imager_file_timeout_ms (300000), imager_publish_url (unset: no publication). A list may be a comma-separated string
 * or a dotted list ("imager_fields.0", ...).
 *
 * Hostcalls: plugin.getConfig only, an SDS $PIV invocation (typedHostcall.hpp). The ONE untyped byte string left is the
 * publication POST's BODY: the node's admin endpoint (sdn-server internal/api/dataset_publication.go handlePublish)
 * decodes {schema, providerId, sourceName, batchId} as JSON; it travels inside HREQ.BODY verbatim.
 */
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <optional>
#include <string_view>
#include <utility>
#include <string>
#include <vector>

#include <sys/time.h>

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "FlowNotice_generated.h"
#include "HttpRequest_generated.h"
#include "HttpResponse_generated.h"
#include "IngestRequest_generated.h"
#include "IngestResult_generated.h"

namespace {

namespace A = sdn::runtime::Aligned;
namespace R = sdn::runtime;

bool is_ws(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

std::string trim(const std::string& s) {
    size_t b = 0, e = s.size();
    while (b < e && is_ws(s[b])) b++;
    while (e > b && is_ws(s[e - 1])) e--;
    return s.substr(b, e - b);
}

std::vector<std::string> list_of(const std::string& text) {
    std::vector<std::string> out;
    std::string current;
    for (const char c : text + ",") {
        if (c == ',') {
            const std::string t = trim(current);
            if (!t.empty()) out.push_back(t);
            current.clear();
        } else {
            current.push_back(c);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Node CONFIG: plugin.getConfig answers with one ModuleConfig FlatBuffer (MCFG) on raw "config", read in place through
// sdm_piv::get_config(); list items are read by dotted path ("imager_fields.0"). A host that provides no config (or fails the call)
// leaves every key at its compiled default.
// ---------------------------------------------------------------------------

struct ConfigValue {
    R::configValueKind kind = R::configValueKind_String;
    std::string text;
    double number = 0;
    bool flag = false;
};

class NodeConfig {
 public:
    static NodeConfig load() { return NodeConfig(sdm_piv::get_config()); }
    // The list index a dotted path ends in ("key.3" -> 3).
    static size_t index_of(const std::string& key) { return static_cast<size_t>(std::strtoull(key.c_str() + key.rfind('.') + 1, nullptr, 10)); }
    // One value read in place from the ModuleConfig: a String, Number or Bool at a key or dotted path, or one item of a
    // StringList / NumberList ("key.0"). A list or table itself reads as absent (callers walk "key.0", "key.1", ...).
    std::optional<ConfigValue> find(const std::string& key) const {
        const R::ConfigEntry* e = config_.entry(key);
        if (!e) return std::nullopt;
        const std::string_view name = e->KEY() ? std::string_view(e->KEY()->c_str(), e->KEY()->size()) : std::string_view();
        const bool item = !(key == name || (key.size() > name.size() && key[key.size() - name.size() - 1] == '.' &&
                                            std::string_view(key).substr(key.size() - name.size()) == name));
        ConfigValue v;
        switch (e->KIND()) {
            case R::configValueKind_String: if (item) return std::nullopt; v.text = std::string(config_.string(key)); return v;
            case R::configValueKind_Number: if (item) return std::nullopt; v.kind = R::configValueKind_Number; v.number = e->NUMBER_VALUE(); return v;
            case R::configValueKind_Bool: if (item) return std::nullopt; v.kind = R::configValueKind_Bool; v.flag = e->BOOL_VALUE(); return v;
            case R::configValueKind_StringList:
                if (!item || !e->STRINGS() || index_of(key) >= e->STRINGS()->size()) return std::nullopt;
                v.text = std::string(config_.string(key));
                return v;
            case R::configValueKind_NumberList:
                if (!item || !e->NUMBERS() || index_of(key) >= e->NUMBERS()->size()) return std::nullopt;
                v.kind = R::configValueKind_Number;
                v.number = config_.number(key);
                return v;
            default: return std::nullopt;
        }
    }
    // A number, or a String holding one (operators quote numbers).
    bool number(const std::string& key, double* out) const {
        const auto v = find(key);
        if (!v) return false;
        if (v->kind == R::configValueKind_Number) { *out = v->number; return true; }
        if (v->kind == R::configValueKind_String && !v->text.empty()) {
            char* end = nullptr;
            const double d = std::strtod(v->text.c_str(), &end);
            if (end == v->text.c_str()) return false;
            *out = d;
            return true;
        }
        return false;
    }
    double number_or(const std::string& key, double fallback) const {
        double v = 0;
        return number(key, &v) ? v : fallback;
    }
    bool text(const std::string& key, std::string* out) const {
        const auto v = find(key);
        if (!v || v->kind != R::configValueKind_String) return false;
        *out = v->text;
        return true;
    }
    // A non-empty String, else the fallback.
    std::string text_or(const std::string& key, const char* fallback) const {
        std::string v;
        return text(key, &v) && !v.empty() ? v : std::string(fallback);
    }
    // A Bool, a String "true"/"1"/"false"/"0", or a Number 1/0.
    bool flag_or(const std::string& key, bool fallback) const {
        const auto v = find(key);
        if (!v) return fallback;
        if (v->kind == R::configValueKind_Bool) return v->flag;
        if (v->kind == R::configValueKind_Number) return v->number == 1 ? true : v->number == 0 ? false : fallback;
        if (v->text == "true" || v->text == "1") return true;
        if (v->text == "false" || v->text == "0") return false;
        return fallback;
    }
    // A comma-separated String, or a dotted list ("key.0", "key.1", ...); else the fallback's items.
    std::vector<std::string> list_or(const std::string& key, const char* fallback) const {
        std::string joined;
        if (text(key, &joined) && !joined.empty()) return list_of(joined);
        std::vector<std::string> out;
        for (size_t i = 0;; i++) {
            const auto v = find(key + "." + std::to_string(i));
            if (!v) break;
            const std::string t = trim(v->text);
            if (!t.empty()) out.push_back(t);
        }
        return out.empty() ? list_of(fallback) : out;
    }

 private:
    explicit NodeConfig(sdm_piv::Config config) : config_(std::move(config)) {}
    sdm_piv::Config config_;
};

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

int push_request(const char* port, const std::vector<uint8_t>& bytes) {
    return plugin_push_output_ex(port, "HttpRequest.fbs", R::HttpRequestIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 "HttpRequest", 0, 0, bytes.data(), static_cast<uint32_t>(bytes.size()));
}

constexpr const char* kProviderID = "noaa-goes";

int push_notice(R::flowNoticeKind kind, const std::string& reason, const std::vector<std::string>& items) {
    flatbuffers::FlatBufferBuilder b(512);
    std::vector<flatbuffers::Offset<flatbuffers::String>> item_offsets;
    for (const std::string& item : items) item_offsets.push_back(b.CreateString(item));
    const auto items_vector = items.empty() ? 0 : b.CreateVector(item_offsets);
    const auto schema = b.CreateString("WXF.fbs");
    const auto provider = b.CreateString(kProviderID);
    const auto reason_offset = b.CreateString(reason);
    R::FlowNoticeBuilder n(b);
    n.add_KIND(kind);
    n.add_SCHEMA(schema);
    n.add_PROVIDER_ID(provider);
    n.add_COUNT(items.size());
    n.add_REASON(reason_offset);
    if (!items.empty()) n.add_ITEMS(items_vector);
    R::FinishFlowNoticeBuffer(b, n.Finish());
    return plugin_push_output_ex("status", "FlowNotice.fbs", R::FlowNoticeIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 "FlowNotice", 0, 0, b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize()));
}

int push_skipped(const char* reason) { return push_notice(R::flowNoticeKind_Skipped, reason, {}) < 0 ? 500 : 0; }

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
const Satellite* satellite_of_bucket(const std::string& bucket) {
    for (const Satellite& s : kSatellites) if (bucket == s.bucket) return &s;
    return nullptr;
}
const FieldSource* field_source(const std::string& field) {
    for (const FieldSource& f : kFieldSources) if (field == f.field) return &f;
    return nullptr;
}

constexpr const char* kDefaultSatellites = "goes-east,goes-west";
// the fields the world-clouds display reads (cloud cover, optical depth, daylight brightness, temperature, top height)
constexpr const char* kDefaultFields = "cloud_mask,cloud_optical_depth,reflectance_064um,brightness_temperature_10um,cloud_top_height";
constexpr double kDefaultLagMinutes = 20;          // the hour's first full-disk scan and its L2 products are out by then
constexpr double kDefaultListTimeoutMs = 60000;
constexpr double kDefaultFileTimeoutMs = 300000;
constexpr double kDefaultMaxPartBytes = 64.0 * 1024 * 1024;   // each response well under the host's 100 MiB cap
constexpr const char* kOriginID = "NOAA Open Data Dissemination (AWS)";
constexpr const char* kLicenseURL = "https://www.ncei.noaa.gov/access/metadata/landing-page/bin/iso?id=gov.noaa.ncdc:C01502";
// The host adds the validators of the last 2xx for a URL to a GET (If-None-Match / If-Modified-Since) unless the
// request sets one; a repeat listing or a second byte range of the same object could then come back 304, empty.
// An If-Modified-Since at the epoch is always satisfied, so S3 answers 200 / 206 with the body.
constexpr const char* kNoValidators = "Thu, 01 Jan 1970 00:00:00 GMT";

// The UTC hour the cycle publishes: imager_frame_time (ISO 8601 or Unix ms) when set, else the latest hour whose first
// scan is imager_lag_minutes old.
bool frame_time_ms(const NodeConfig& config, int64_t* out, std::string* err) {
    const auto set = config.find("imager_frame_time");
    if (set && set->kind == R::configValueKind_String && !set->text.empty()) {
        int64_t ms = 0;
        if (std::all_of(set->text.begin(), set->text.end(), ::isdigit)) ms = std::atoll(set->text.c_str());
        else if (!parse_iso_ms(set->text, &ms)) { *err = "imager_frame_time is neither ISO 8601 nor Unix ms: " + set->text; return false; }
        *out = ms - ms % 3600000;
        return true;
    }
    if (set && set->kind == R::configValueKind_Number && set->number > 0) {
        const int64_t ms = static_cast<int64_t>(set->number);
        *out = ms - ms % 3600000;
        return true;
    }
    const int64_t now = now_unix_ms();
    if (now <= 0) { *err = "no clock"; return false; }
    const int64_t lag = static_cast<int64_t>(config.number_or("imager_lag_minutes", kDefaultLagMinutes) * 60000.0);
    const int64_t t = now - lag;
    *out = t - ((t % 3600000) + 3600000) % 3600000;
    return true;
}

// The job record: one size-prefixed $WXF holding only the header fields named in the file comment (GRID present, empty).
struct Job {
    std::string field_id, variable_name, sensor, dataset, source_url, origin, license_url, citation;
    bool attributed = false;
    int64_t valid_time_ms = 0;
    int part = 0, parts = 1;
};

std::vector<uint8_t> job_record(const Job& job) {
    flatbuffers::FlatBufferBuilder b(512);
    const auto field_id = b.CreateString(job.field_id);
    const auto variable_name = job.variable_name.empty() ? 0 : b.CreateString(job.variable_name);
    const auto sensor = b.CreateString(job.sensor);
    const auto dataset = b.CreateString(job.dataset);
    const auto source_url = b.CreateString(job.source_url);
    const auto origin = job.attributed ? b.CreateString(job.origin) : 0;
    const auto license_url = job.attributed ? b.CreateString(job.license_url) : 0;
    const auto citation = job.attributed ? b.CreateString(job.citation) : 0;
    WXFGridBuilder grid(b);
    const auto grid_offset = grid.Finish();
    WXFBuilder w(b);
    w.add_FIELD_ID(field_id);
    if (!job.variable_name.empty()) w.add_VARIABLE_NAME(variable_name);
    w.add_TIME_BASIS(wxfTimeBasis_ValidTimeOnly);
    w.add_VALID_TIME_MS(static_cast<uint64_t>(job.valid_time_ms));
    w.add_GRID(grid_offset);
    w.add_TILE_INDEX(static_cast<uint32_t>(job.part));
    w.add_TILE_COUNT(static_cast<uint32_t>(job.parts));
    w.add_SENSOR_ID(sensor);
    w.add_DATASET_ID(dataset);
    w.add_SOURCE_URL(source_url);
    if (job.attributed) {
        w.add_ORIGIN_ID(origin);
        w.add_LICENSE_CLASS(wxfLicenseClass_OpenAttribution);
        w.add_LICENSE_URL(license_url);
        w.add_CITATION(citation);
    }
    FinishSizePrefixedWXFBuffer(b, w.Finish());
    return std::vector<uint8_t>(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
}

// A GET HttpRequest with the epoch If-Modified-Since (and a Range when given), its job in CONTEXT. Headers sorted by
// lower-case NAME.
std::vector<uint8_t> get_request(const std::string& url, const std::string& range, uint32_t timeout_ms,
                                 const std::vector<uint8_t>& context) {
    flatbuffers::FlatBufferBuilder b(1024);
    std::vector<flatbuffers::Offset<R::Header>> headers{R::CreateHeaderDirect(b, "if-modified-since", kNoValidators)};
    if (!range.empty()) headers.push_back(R::CreateHeaderDirect(b, "range", range.c_str()));
    const auto headers_vector = b.CreateVector(headers);
    const auto context_vector = b.CreateVector(context);
    R::FinishHttpRequestBuffer(b, R::CreateHttpRequest(b, b.CreateString("GET"), b.CreateString(url), headers_vector, 0,
                                                       timeout_ms, 0, context_vector));
    return std::vector<uint8_t>(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
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

struct PendingFile { std::vector<std::vector<uint8_t>> requests; };
std::vector<PendingFile> g_backlog;
size_t g_backlog_next = 0;

int emit_next_file() {
    if (g_backlog_next >= g_backlog.size()) { g_backlog.clear(); g_backlog_next = 0; plugin_set_backlog_remaining(0); plugin_set_yielded(0); return 0; }
    const PendingFile& f = g_backlog[g_backlog_next++];
    for (const auto& request : f.requests) {
        if (push_request("requests", request) < 0) return 500;
    }
    const uint32_t remaining = static_cast<uint32_t>(g_backlog.size() - g_backlog_next);
    if (remaining == 0) { g_backlog.clear(); g_backlog_next = 0; }
    plugin_set_backlog_remaining(remaining);
    plugin_set_yielded(remaining > 0 ? 1 : 0);
    return 0;
}

std::string str(const flatbuffers::String* s) { return s ? s->str() : std::string(); }

}  // namespace

extern "C" {

// plan: TimerTick -> one S3 listing HttpRequest per (satellite, product folder) of the frame hour, its list job in
// CONTEXT; or one Skipped FlowNotice.
int plan(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    const NodeConfig config = NodeConfig::load();
    if (!config.flag_or("imager_live_access", true)) return push_skipped("live-access-disabled");
    int64_t frame_ms = 0;
    std::string err;
    if (!frame_time_ms(config, &frame_ms, &err)) { plugin_set_error("invalid-frame-time", err.c_str()); return 400; }
    const std::vector<std::string> satellites = config.list_or("imager_satellites", kDefaultSatellites);
    const std::vector<std::string> fields = config.list_or("imager_fields", kDefaultFields);
    for (const std::string& f : fields) {
        if (!field_source(f)) { plugin_set_error("unknown-field", ("imager_fields names an unknown field: " + f).c_str()); return 400; }
    }
    int year = 0, doy = 0, hour = 0;
    civil(frame_ms, &year, &doy, &hour);
    const std::string folder = std::to_string(year) + "/" + pad(doy, 3) + "/" + pad(hour, 2) + "/";
    const uint32_t timeout = static_cast<uint32_t>(config.number_or("imager_list_timeout_ms", kDefaultListTimeoutMs));
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
            Job job;
            for (const std::string& f : fields) {
                if (product == field_source(f)->product) job.field_id += (job.field_id.empty() ? "" : ",") + f;
            }
            const std::string prefix = product + "/" + folder;
            const std::string url = std::string("https://") + sat->bucket + ".s3.amazonaws.com/?list-type=2&max-keys=1000&prefix=" + prefix;
            job.sensor = sat->sensor;
            job.dataset = sat->bucket;
            job.source_url = prefix;
            job.valid_time_ms = frame_ms;
            if (push_request("requests", get_request(url, "", timeout, job_record(job))) < 0) return 500;
            emitted++;
        }
    }
    return emitted ? 0 : push_skipped("nothing-to-list");
}

// select: listing HttpResponses (each echoing its list job) -> each field's file as GET requests (byte ranges when it
// is larger than one response may be) with its file job in CONTEXT, one file per invocation; the rest yielded as
// backlog. A resume without input frames emits the next file. Missing files and failed listings are one Missing notice.
int select_files(void) {
    const std::vector<const plugin_input_frame_t*> listings = frames_on("listings");
    if (listings.empty()) return emit_next_file();   // resumed with backlog
    const NodeConfig config = NodeConfig::load();
    const uint32_t timeout = static_cast<uint32_t>(config.number_or("imager_file_timeout_ms", kDefaultFileTimeoutMs));
    double max_part = config.number_or("imager_max_part_bytes", kDefaultMaxPartBytes);
    if (max_part < 1024 * 1024) max_part = 1024 * 1024;
    std::vector<std::string> missing;
    for (size_t k = 0; k < listings.size(); k++) {
        const plugin_input_frame_t* r = listings[k];
        flatbuffers::Verifier verifier(r ? r->payload : nullptr, r ? r->payload_length : 0);
        if (!r || !r->payload || !R::VerifyHttpResponseBuffer(verifier)) {
            plugin_set_error("invalid-listing", ("listing " + std::to_string(k) + " is not an HttpResponse (HRSP)").c_str());
            return 400;
        }
        const R::HttpResponse& response = *R::GetHttpResponse(r->payload);
        const auto* context = response.CONTEXT();
        bool job_ok = false;
        if (context) {
            flatbuffers::Verifier job_verifier(context->data(), context->size());
            job_ok = VerifySizePrefixedWXFBuffer(job_verifier);
        }
        if (!job_ok) {
            plugin_set_error("invalid-list-job", ("listing " + std::to_string(k) + " does not echo its list job (a size-prefixed $WXF) in CONTEXT").c_str());
            return 400;
        }
        const WXF& job = *GetSizePrefixedWXF(context->data());
        const std::string bucket = str(job.DATASET_ID()), prefix = str(job.SOURCE_URL()), sensor = str(job.SENSOR_ID());
        const Satellite* sat = satellite_of_bucket(bucket);
        const std::string satellite = sat ? sat->id : bucket;
        if (response.STATUS() != 200) {
            missing.push_back("listing " + bucket + "/" + prefix + " http " + std::to_string(response.STATUS()));
            continue;
        }
        const std::string body = response.BODY() ? std::string(reinterpret_cast<const char*>(response.BODY()->data()), response.BODY()->size()) : std::string();
        const std::vector<Listed> listing = parse_listing(body);
        const int64_t frame_ms = static_cast<int64_t>(job.VALID_TIME_MS());
        int year = 0, doy = 0, hour = 0;
        civil(frame_ms, &year, &doy, &hour);
        const std::string stamp = "_s" + std::to_string(year) + pad(doy, 3) + pad(hour, 2) + "0";
        for (const std::string& field : list_of(str(job.FIELD_ID()))) {
            const FieldSource* src = field_source(field);
            if (!src) continue;
            const Listed* file = pick_file(listing, stamp, src->band);
            if (!file) {
                missing.push_back(field + " " + satellite + " " + prefix);
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
                    range = "bytes=" + std::to_string(a) + "-" + std::to_string(b);
                }
                Job file_job;
                file_job.field_id = field;
                file_job.variable_name = src->variable;
                file_job.sensor = sensor;
                file_job.dataset = bucket;
                file_job.source_url = url;
                file_job.attributed = true;
                file_job.origin = kOriginID;
                file_job.license_url = kLicenseURL;
                file_job.citation = sensor + " data courtesy of NOAA via NOAA Open Data Dissemination";
                file_job.valid_time_ms = frame_ms;
                file_job.part = p;
                file_job.parts = parts;
                pending.requests.push_back(get_request(url, range, timeout, job_record(file_job)));
            }
            g_backlog.push_back(pending);
        }
    }
    if (!missing.empty() && push_notice(R::flowNoticeKind_Missing, "not in the hour's listings", missing) < 0) return 500;
    return emit_next_file();
}

// publish_request: the storage-ingest IngestResult + the parser's IngestRequest -> the dataset-publication POST for the
// node's loopback admin endpoint (imager_publish_url); nothing when it is unset (absence of configuration is not
// permission) or when the batch was refused (nothing was stored).
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
    flatbuffers::Verifier result_verifier(result_frame->payload, result_frame->payload_length);
    if (!R::VerifyIngestResultBuffer(result_verifier)) {
        plugin_set_error("invalid-result", "the result frame is not an IngestResult (INGR).");
        return 400;
    }
    flatbuffers::Verifier meta_verifier(meta_frame->payload, meta_frame->payload_length);
    if (!R::VerifyIngestRequestBuffer(meta_verifier)) {
        plugin_set_error("invalid-meta", "the meta frame is not an IngestRequest (INGQ).");
        return 400;
    }
    const R::IngestResult& result = *R::GetIngestResult(result_frame->payload);
    const R::IngestRequest& meta = *R::GetIngestRequest(meta_frame->payload);
    const NodeConfig config = NodeConfig::load();
    std::string url;
    if (!config.text("imager_publish_url", &url) || url.empty()) return 0;
    if (result.REFUSED() && result.REFUSED()->size()) return 0;
    std::string schema = str(result.SCHEMA()), batch_id = str(result.BATCH_ID());
    if (schema.empty()) schema = str(meta.SCHEMA());
    if (batch_id.empty()) batch_id = str(meta.TAGS()->BATCH_ID());
    const std::string provider = str(meta.TAGS()->PROVIDER_ID()), source = str(meta.TAGS()->SOURCE_NAME());
    if (schema.empty() || batch_id.empty() || provider.empty() || source.empty()) {
        plugin_set_error("incomplete-publication-identity", "publish_request needs schema, batchId, providerId and sourceName.");
        return 400;
    }
    // The publication names the stored batch: an IngestResult (INGR) FlatBuffer, as data-source/nwp-field-source posts it.
    flatbuffers::FlatBufferBuilder rb(512);
    R::FinishIngestResultBuffer(rb, R::CreateIngestResultDirect(rb, schema.c_str(), provider.c_str(), source.c_str(), batch_id.c_str(), result.INSERTED(),
                                                                result.RECONCILED_DUPLICATES(), result.RECONCILED_OLD_BATCHES(),
                                                                result.ARCHIVED() && result.ARCHIVED()->size() ? result.ARCHIVED()->c_str() : nullptr, nullptr));
    const std::vector<uint8_t> body(rb.GetBufferPointer(), rb.GetBufferPointer() + rb.GetSize());
    const uint32_t timeout = static_cast<uint32_t>(config.number_or("imager_list_timeout_ms", kDefaultListTimeoutMs));
    flatbuffers::FlatBufferBuilder b(512);
    std::vector<flatbuffers::Offset<R::Header>> headers{R::CreateHeaderDirect(b, "content-type", "application/octet-stream")};
    const auto headers_vector = b.CreateVector(headers);
    const auto body_vector = b.CreateVector(body);
    R::FinishHttpRequestBuffer(b, R::CreateHttpRequest(b, b.CreateString("POST"), b.CreateString(url), headers_vector, body_vector, timeout));
    return push_request("request", std::vector<uint8_t>(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize())) < 0 ? 500 : 0;
}

}  // extern "C"
