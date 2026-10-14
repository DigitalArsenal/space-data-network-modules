/*
 * data-source/weathernext-source (typed contracts 1.0).
 *
 * Request-builder flow nodes for a machine-learned global ensemble weather
 * forecast source served as Zarr v3 objects from an allow-listed cloud
 * bucket. A module cron TIMER tick (TimerTick, TICK; payload not read) enters
 * on "tick"; the methods emit HttpRequest (HREQ) frames for hostcap/http-request
 * whose CONTEXT carries the parse job as ONE size-prefixed SDS record, echoed
 * verbatim in the HttpResponse the parser reads:
 *   - a cloud chunk: a $WXF header record (no samples) naming the field and
 *     the chunk's tile - FIELD_ID, MODEL_CLASS/ID/VERSION, INIT_TIME_MS,
 *     LEAD_HOURS, VALID_TIME_MS, HORIZON_HOURS, MEMBER_KIND/INDEX,
 *     ENSEMBLE_SIZE, VARIABLE/VARIABLE_NAME (the array), GRID (the tile's
 *     real rows and columns, padding past the declared grid edge dropped),
 *     TILE_INDEX/TILE_COUNT, CHUNK_DTYPE, CHUNK_CODECS, ORIGIN_ID, DATASET_ID,
 *     SOURCE_URL, LICENSE_CLASS/URL, CITATION;
 *   - the cyclone tracks: a $TCT header record (no points, STORM_ID empty)
 *     naming MODEL_CLASS/ID/VERSION, ENSEMBLE_SIZE, WIND_AVERAGING_PERIOD_S,
 *     ORIGIN_ID, DATASET_ID, SOURCE_URL, LICENSE_CLASS/URL, CITATION.
 * Skipped cycles answer one FlowNotice (FNTC, KIND Skipped, REASON
 * live-access-disabled / cyclone-url-missing) on "status". No JSON job frames.
 *
 * EVERYTHING is node CONFIG (plugin.getConfig, one ModuleConfig FlatBuffer,
 * nested values read by dotted path), never host code:
 *
 *   weathernext_live_access      false  THE live switch. false: no request,
 *                                       no secrets.get, one Skipped notice.
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
 *   weathernext_cyclone_url      ""     cyclone lane: Skipped cyclone-url-missing
 *   weathernext_wind_averaging_period_s 60
 *   weathernext_http_timeout_ms  90000
 *   weathernext_provider_id      weathernext (read by the parser, which tags the batch)
 *   weathernext_publish_url      ""     publish_request emits nothing
 *   weathernext_license_realtime_url / weathernext_license_historical_url
 *   weathernext_citation         ""
 * A list value may also arrive as dotted entries (weathernext_arrays.0, ...).
 *
 * The parser reads the padded chunk extents (weathernext_chunk_lat/lon) and
 * the dimension order (weathernext_dims) from the same flow-service config:
 * a $WXF header has no field for them. The tile geometry it needs otherwise
 * (GRID, TILE_INDEX/COUNT) rides the CONTEXT, computed here.
 *
 * CREDENTIAL. In bearer mode the operator's OAuth2 access token is read from
 * the machine-bound credential store lane with secrets.get (SDS $PIV:
 * SecretParams -> raw "secret") and placed ONLY in the HttpRequest HEADERS
 * (authorization), never in a CONTEXT record, and the plaintext is wiped as
 * soon as the requests are built. This is the ONLY node in the flow holding
 * the secrets capability.
 *
 * LICENCE. Decided per (init, lead) by this node, which owns the clock:
 * now - valid_time >= 1 h -> Historical (open attribution licence), else
 * RealTimeExperimental. The parser copies the class into the records and the
 * IngestRequest.
 *
 * publish_request: the storage-ingest IngestResult (INGR) + the parser's
 * IngestRequest (INGQ) -> an HttpRequest POST to weathernext_publish_url. Its
 * BODY stays the JSON {schema, providerId, sourceName, batchId} the node's
 * loopback admin endpoint decodes (sdn-server internal/api/dataset_publication.go,
 * handlePublish: json.NewDecoder with DisallowUnknownFields) - a host HTTP API
 * body, not a module contract. A REFUSED result publishes nothing.
 */

#include <algorithm>
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
#include <utility>
#include <vector>

#include <sys/time.h>

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "FlowNotice_generated.h"
#include "HttpRequest_generated.h"
#include "IngestRequest_generated.h"
#include "IngestResult_generated.h"

namespace {

namespace A = sdn::runtime::Aligned;
namespace R = sdn::runtime;

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
constexpr const char* kDefaultRealtimeLicenseURL =
    "https://storage.googleapis.com/weathernext-public/terms-of-use.pdf";
constexpr const char* kDefaultHistoricalLicenseURL = "https://creativecommons.org/licenses/by/4.0/";
constexpr const char* kOriginID = "storage.googleapis.com";
constexpr const char* kDatasetID = "weathernext3_spatial";
constexpr long kDefaultTimeoutMs = 90000;
constexpr int64_t kRealTimeWindowMs = 3600000;

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
// Node CONFIG: plugin.getConfig answers with one ModuleConfig FlatBuffer (MCFG)
// on raw "config", read in place through sdm_piv::get_config(); list items are
// read by dotted path ("weathernext_arrays.0"). A host that provides no config (or
// fails the call) leaves every key at its compiled default. The accessors keep
// the JSON lane's tolerance: quoted numbers, "true"/"1"/"false"/"0" switches,
// and a number given where a list text is expected.
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
    // A value as text (a number formatted, a switch as true/false), or a list
    // given as dotted entries joined by `sep`; empty -> fallback.
    std::string text(const std::string& key, const char* fallback, char sep = ',') const {
        if (const auto v = find(key)) {
            const std::string out = text_of(*v);
            return out.empty() ? std::string(fallback) : out;
        }
        std::string joined;
        for (size_t i = 0;; i++) {
            const auto item = find(key + "." + std::to_string(i));
            if (!item) break;
            if (i) joined.push_back(sep);
            joined += text_of(*item);
        }
        return joined.empty() ? std::string(fallback) : joined;
    }
    static std::string text_of(const ConfigValue& v) {
        if (v.kind == R::configValueKind_String) return v.text;
        if (v.kind == R::configValueKind_Number) return format_number(v.number);
        return v.flag ? "true" : "false";
    }
    double number(const std::string& key, double fallback) const {
        const auto v = find(key);
        if (!v) return fallback;
        if (v->kind == R::configValueKind_Number) return v->number;
        if (v->kind == R::configValueKind_String && !v->text.empty()) {
            char* end = nullptr;
            const double d = std::strtod(v->text.c_str(), &end);
            if (end != v->text.c_str()) return d;
        }
        return fallback;
    }
    bool flag(const std::string& key, bool fallback) const {
        const auto v = find(key);
        if (!v) return fallback;
        if (v->kind == R::configValueKind_Bool) return v->flag;
        if (v->kind == R::configValueKind_Number) {
            if (v->number == 1) return true;
            if (v->number == 0) return false;
            return fallback;
        }
        if (v->text == "true" || v->text == "1") return true;
        if (v->text == "false" || v->text == "0") return false;
        return fallback;
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

// The previous synoptic cycle (00/06/12/18Z) at least one hour before now.
int64_t default_init_time_ms(int64_t now_ms) {
    const int64_t cycle_ms = 6 * 3600000LL;
    const int64_t reference = now_ms - kRealTimeWindowMs;
    if (reference <= 0) return 0;
    return (reference / cycle_ms) * cycle_ms;
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


void civil_from_days(int64_t z, int* y_out, int* m_out, int* d_out) {
    z += 719468;
    const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    const unsigned doe = static_cast<unsigned>(z - era * 146097);
    const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    const int64_t y = static_cast<int64_t>(yoe) + era * 400;
    const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const unsigned mp = (5 * doy + 2) / 153;
    const unsigned d = doy - (153 * mp + 2) / 5 + 1;
    const unsigned m = mp + (mp < 10 ? 3 : -9);
    *y_out = static_cast<int>(y + (m <= 2));
    *m_out = static_cast<int>(m);
    *d_out = static_cast<int>(d);
}

std::string format_iso_seconds(int64_t unix_ms) {
    const int64_t unix_seconds = unix_ms >= 0 ? unix_ms / 1000 : (unix_ms - 999) / 1000;
    const int64_t days = unix_seconds >= 0 ? unix_seconds / 86400 : (unix_seconds - 86399) / 86400;
    int64_t rem = unix_seconds - days * 86400;
    int y, m, d;
    civil_from_days(days, &y, &m, &d);
    const int hh = static_cast<int>(rem / 3600);
    rem -= static_cast<int64_t>(hh) * 3600;
    const int mm = static_cast<int>(rem / 60);
    const int ss = static_cast<int>(rem - mm * 60);
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02dZ", y, m, d, hh, mm, ss);
    return std::string(buf);
}

// ---------------------------------------------------------------------------
// Frame IO.
// ---------------------------------------------------------------------------

const plugin_input_frame_t* frame_for(const char* port_id) {
    const int32_t index = plugin_find_input_index(port_id, 0);
    if (index < 0) return nullptr;
    return plugin_get_input_frame(static_cast<uint32_t>(index));
}

// The builder's bytes are zeroed once pushed: a request may carry the bearer token.
int push_request(const char* port, flatbuffers::FlatBufferBuilder& b) {
    const int pushed = plugin_push_output_ex(port, "HttpRequest.fbs", R::HttpRequestIdentifier(),
                                             PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "HttpRequest", 0, 0,
                                             b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize()));
    std::memset(b.GetBufferPointer(), 0, b.GetSize());
    return pushed;
}

int push_skipped(const char* schema, const char* source_name, const std::string& provider_id, const char* reason) {
    flatbuffers::FlatBufferBuilder b(256);
    R::FinishFlowNoticeBuffer(b, R::CreateFlowNoticeDirect(b, R::flowNoticeKind_Skipped, schema, provider_id.c_str(),
                                                           source_name, nullptr, 0, reason));
    return plugin_push_output_ex("status", "FlowNotice.fbs", R::FlowNoticeIdentifier(),
                                 PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "FlowNotice", 0, 0, b.GetBufferPointer(),
                                 static_cast<uint32_t>(b.GetSize())) < 0
               ? 500
               : 0;
}

// ---------------------------------------------------------------------------
// Auth. Returns 0 and fills *token (empty for mode none) or a non-zero status
// after plugin_set_error. The caller places the token only in the request
// HEADERS and wipes it.
// ---------------------------------------------------------------------------
void wipe(std::string* s) {
    std::fill(s->begin(), s->end(), '\0');
    s->clear();
}

int resolve_auth_token(const NodeConfig& config, std::string* token) {
    token->clear();
    const std::string mode = config.text("weathernext_auth_mode", "bearer");
    if (mode == "none") return 0;
    if (mode == "bearer") {
        const std::string lane = config.text("weathernext_secrets_lane", kDefaultSecretsLane);
        A::SecretParams params{};
        if (sdm_piv::put(params.ID, lane)) {
            params.set_has_ID(true);
            const auto response = sdm_piv::call("secrets.get", "SecretParams", params);
            if (response.ok()) {
                const std::string_view secret = response.raw("secret");
                token->assign(secret.data(), secret.size());
            }
            // The response buffer holding the plaintext goes out of scope here.
        }
        if (token->empty()) {
            plugin_set_error("credential-unavailable",
                             ("no access token is stored in credential lane \"" + lane +
                              "\" on this node, or this module is not approved for secrets:" + lane)
                                 .c_str());
            return 403;
        }
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

struct Provenance {
    std::string provider_id;
    std::string model_id;
    std::string model_version;
    std::string citation;
    std::string realtime_url;
    std::string historical_url;
};

Provenance read_provenance(const NodeConfig& config) {
    Provenance p;
    p.provider_id = config.text("weathernext_provider_id", "weathernext");
    p.model_id = config.text("weathernext_model_id", kDefaultModelID);
    p.model_version = config.text("weathernext_model_version", "");
    p.citation = config.text("weathernext_citation", "");
    p.realtime_url = config.text("weathernext_license_realtime_url", kDefaultRealtimeLicenseURL);
    p.historical_url = config.text("weathernext_license_historical_url", kDefaultHistoricalLicenseURL);
    return p;
}

// now - valid >= 1 h -> Historical, else RealTimeExperimental.
bool is_historical(int64_t now_ms, int64_t valid_ms) { return now_ms - valid_ms >= kRealTimeWindowMs; }

wxfMemberKind member_kind_for(const std::string& name) {
    if (name == "Control") return wxfMemberKind_Control;
    if (name == "Deterministic") return wxfMemberKind_Deterministic;
    if (name == "Mean") return wxfMemberKind_Mean;
    if (name == "Median") return wxfMemberKind_Median;
    if (name == "StandardDeviation") return wxfMemberKind_StandardDeviation;
    if (name == "Minimum") return wxfMemberKind_Minimum;
    if (name == "Maximum") return wxfMemberKind_Maximum;
    if (name == "Percentile") return wxfMemberKind_Percentile;
    if (name == "ProbabilityAboveThreshold") return wxfMemberKind_ProbabilityAboveThreshold;
    if (name == "ProbabilityBelowThreshold") return wxfMemberKind_ProbabilityBelowThreshold;
    return wxfMemberKind_Member;
}

wxfVariable variable_for_array(const std::string& array) {
    if (array == "low_cloud_cover") return wxfVariable_LowCloudCover;
    if (array == "medium_cloud_cover") return wxfVariable_MediumCloudCover;
    if (array == "high_cloud_cover") return wxfVariable_HighCloudCover;
    if (array == "total_cloud_cover") return wxfVariable_TotalCloudCover;
    return wxfVariable_Unspecified;
}

// One GET as an HttpRequest whose CONTEXT is the job record.
void build_get(flatbuffers::FlatBufferBuilder& b, const std::string& url, const std::string& token, long timeout_ms,
               const uint8_t* context, size_t context_size) {
    std::vector<flatbuffers::Offset<R::Header>> headers;
    if (!token.empty()) {
        const std::string value = "Bearer " + token;
        headers.push_back(R::CreateHeaderDirect(b, "authorization", value.c_str()));
    }
    const auto context_off = b.CreateVector(context, context_size);
    const auto headers_off = headers.empty() ? 0 : b.CreateVector(headers);
    const auto url_off = b.CreateString(url);
    const auto method_off = b.CreateString("GET");
    R::FinishHttpRequestBuffer(b, R::CreateHttpRequest(b, method_off, url_off, headers_off, 0,
                                                       static_cast<uint32_t>(timeout_ms > 0 ? timeout_ms : 0), 0,
                                                       context_off));
}

// The tile one chunk covers on the declared global grid (padding past its edge dropped).
struct TileGeometry {
    double lat0 = 0, lon0 = 0;
    uint32_t nlat = 0, nlon = 0;
    uint32_t tile_index = 0, tile_count = 0;
    bool periodic_lon = false;
};

}  // namespace

extern "C" {

// plan: timer tick -> N chunk GETs (HttpRequest, the chunk's $WXF header in
// CONTEXT), or one Skipped FlowNotice when the cycle is skipped.
int plan(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

    const NodeConfig config = NodeConfig::load();
    const Provenance provenance = read_provenance(config);
    if (!config.flag("weathernext_live_access", false)) {
        // No network, no secrets.get: the dev daemon and every test run here.
        return push_skipped("WXF.fbs", "weathernext3-clouds-0p1deg", provenance.provider_id, "live-access-disabled");
    }
    const std::string store_path = config.text("weathernext_store_path", "");
    if (store_path.empty()) {
        plugin_set_error("store-path-missing",
                         "weathernext_live_access is true but weathernext_store_path is empty; the "
                         "Zarr store path inside the bucket is operator-declared, never guessed.");
        return 400;
    }

    std::string token;
    const int auth_status = resolve_auth_token(config, &token);
    if (auth_status != 0) return auth_status;

    const std::string base_url = config.text("weathernext_gcs_base_url", kDefaultBaseURL);
    const std::vector<std::string> arrays = split(config.text("weathernext_arrays", kDefaultArrays), ',');
    const std::vector<std::string> lead_texts = split(config.text("weathernext_lead_hours", kDefaultLeadHours), ',');
    const std::vector<std::string> chunk_pairs = split(config.text("weathernext_chunks", kDefaultChunks, ';'), ';');
    const std::vector<std::string> codecs = split(config.text("weathernext_codecs", kDefaultCodecs), ',');
    const std::vector<std::string> dims = split(config.text("weathernext_dims", kDefaultDims), ',');
    const std::string dtype = config.text("weathernext_dtype", kDefaultDtype);
    const std::string member_kind = config.text("weathernext_member_kind", kDefaultMemberKind);
    const double init_index = config.number("weathernext_init_index", 0);
    const double member_index = config.number("weathernext_member_index", 0);
    const double ensemble_size = config.number("weathernext_ensemble_size", 64);
    const double horizon_hours = config.number("weathernext_horizon_hours", 360);
    const double lead_step = config.number("weathernext_lead_step_hours", 1);
    const double chunk_lat = config.number("weathernext_chunk_lat", 64);
    const double chunk_lon = config.number("weathernext_chunk_lon", 64);
    const double lat0 = config.number("weathernext_grid_lat0", 90);
    const double lon0 = config.number("weathernext_grid_lon0", 0);
    const double dlat = config.number("weathernext_grid_dlat", -0.1);
    const double dlon = config.number("weathernext_grid_dlon", 0.1);
    const double nlat = config.number("weathernext_grid_nlat", 1801);
    const double nlon = config.number("weathernext_grid_nlon", 3600);
    const bool periodic_lon = config.flag("weathernext_grid_periodic_lon", true);
    const long timeout_ms = static_cast<long>(config.number("weathernext_http_timeout_ms", kDefaultTimeoutMs));

    const int64_t now_ms = now_unix_ms();
    int64_t init_ms = 0;
    {
        const std::string init_text = config.text("weathernext_init_time", "");
        if (init_text.empty()) init_ms = default_init_time_ms(now_ms);
        else if (!parse_iso_ms(init_text, &init_ms)) {
            wipe(&token);
            plugin_set_error("init-time-invalid",
                             ("weathernext_init_time \"" + init_text + "\" is not ISO 8601 UTC").c_str());
            return 400;
        }
    }
    if (arrays.empty() || lead_texts.empty() || chunk_pairs.empty() || lead_step <= 0 || chunk_lat < 1 ||
        chunk_lon < 1) {
        wipe(&token);
        plugin_set_error("plan-config-invalid",
                         "weathernext_arrays, weathernext_lead_hours, weathernext_chunks, "
                         "weathernext_lead_step_hours and the chunk extents must all be non-empty and positive.");
        return 400;
    }
    if (nlat <= 0 || nlon <= 0) {
        wipe(&token);
        plugin_set_error("plan-config-invalid", "weathernext_grid_nlat / weathernext_grid_nlon must be positive.");
        return 400;
    }

    int lat_dim = -1, lon_dim = -1, init_dim = -1, member_dim = -1, lead_dim = -1;
    for (size_t i = 0; i < dims.size(); i++) {
        if (dims[i] == "latitude") lat_dim = static_cast<int>(i);
        if (dims[i] == "longitude") lon_dim = static_cast<int>(i);
        if (dims[i] == "init_time") init_dim = static_cast<int>(i);
        if (dims[i] == "member") member_dim = static_cast<int>(i);
        if (dims[i] == "lead_time") lead_dim = static_cast<int>(i);
    }
    if (lat_dim < 0 || lon_dim < 0) {
        wipe(&token);
        plugin_set_error("plan-config-invalid", "weathernext_dims must name latitude and longitude.");
        return 400;
    }

    const uint64_t grid_nlat = static_cast<uint64_t>(nlat);
    const uint64_t grid_nlon = static_cast<uint64_t>(nlon);
    const uint64_t extent_lat = static_cast<uint64_t>(chunk_lat);
    const uint64_t extent_lon = static_cast<uint64_t>(chunk_lon);
    const uint64_t tiles_per_row = (grid_nlon + extent_lon - 1) / extent_lon;
    const uint64_t tile_rows = (grid_nlat + extent_lat - 1) / extent_lat;

    std::vector<flatbuffers::FlatBufferBuilder> requests;
    for (const std::string& array : arrays) {
        for (const std::string& lead_text : lead_texts) {
            const double lead_hours = strtod(lead_text.c_str(), nullptr);
            const double lead_index = std::floor(lead_hours / lead_step + 0.5);
            const int64_t valid_ms = init_ms + static_cast<int64_t>(std::llround(lead_hours * 3600000.0));
            const bool historical = is_historical(now_ms, valid_ms);
            const std::string field_id = provenance.model_id + "|" + format_iso_seconds(init_ms) + "|" + member_kind +
                                         format_number(member_index) + "|" + array + "|" + format_number(lead_hours) + "h";
            for (const std::string& pair : chunk_pairs) {
                const std::vector<std::string> parts = split(pair, ',');
                if (parts.size() != 2) {
                    wipe(&token);
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

                // The tile this chunk covers (the parser's former job arithmetic, done once here).
                const uint64_t i0 = static_cast<uint64_t>(lat_chunk) * extent_lat;
                const uint64_t j0 = static_cast<uint64_t>(lon_chunk) * extent_lon;
                if (i0 >= grid_nlat || j0 >= grid_nlon) {
                    wipe(&token);
                    plugin_set_error("chunk-index-invalid",
                                     ("weathernext_chunks entry \"" + pair + "\" lies outside the declared grid").c_str());
                    return 400;
                }
                TileGeometry tile;
                tile.nlat = static_cast<uint32_t>(std::min<uint64_t>(extent_lat, grid_nlat - i0));
                tile.nlon = static_cast<uint32_t>(std::min<uint64_t>(extent_lon, grid_nlon - j0));
                tile.lat0 = lat0 + static_cast<double>(i0) * dlat;
                tile.lon0 = lon0 + static_cast<double>(j0) * dlon;
                tile.tile_index = static_cast<uint32_t>(static_cast<uint64_t>(lat_chunk) * tiles_per_row +
                                                        static_cast<uint64_t>(lon_chunk));
                tile.tile_count = static_cast<uint32_t>(tile_rows * tiles_per_row);
                tile.periodic_lon = periodic_lon && tile.nlon == grid_nlon;

                // The job: a $WXF header record (no samples).
                flatbuffers::FlatBufferBuilder job(1024);
                {
                    std::vector<flatbuffers::Offset<flatbuffers::String>> codec_offs;
                    for (const std::string& c : codecs) codec_offs.push_back(job.CreateString(c));
                    const auto codecs_off = job.CreateVector(codec_offs);
                    const auto field_id_off = job.CreateString(field_id);
                    const auto model_id_off = job.CreateString(provenance.model_id);
                    const auto model_version_off = job.CreateString(provenance.model_version);
                    const auto variable_name_off = job.CreateString(array);
                    const auto dtype_off = job.CreateString(dtype);
                    const auto origin_off = job.CreateString(kOriginID);
                    const auto dataset_off = job.CreateString(kDatasetID);
                    const auto source_url_off = job.CreateString(url);
                    const auto license_url_off = job.CreateString(historical ? provenance.historical_url : provenance.realtime_url);
                    const auto citation_off = job.CreateString(provenance.citation);
                    WXFGridBuilder grid(job);
                    grid.add_KIND(wxfGridKind_RegularLatLon);
                    grid.add_LAT0(tile.lat0);
                    grid.add_LON0(tile.lon0);
                    grid.add_DLAT(dlat);
                    grid.add_DLON(dlon);
                    grid.add_NLAT(tile.nlat);
                    grid.add_NLON(tile.nlon);
                    grid.add_PERIODIC_LON(tile.periodic_lon);
                    const auto grid_off = grid.Finish();
                    WXFBuilder w(job);
                    w.add_FIELD_ID(field_id_off);
                    w.add_MODEL_CLASS(wxfModelClass_MachineLearnedGlobalEnsemble);
                    w.add_MODEL_ID(model_id_off);
                    w.add_MODEL_VERSION(model_version_off);
                    w.add_INIT_TIME_MS(static_cast<uint64_t>(init_ms));
                    w.add_LEAD_HOURS(static_cast<float>(lead_hours));
                    w.add_VALID_TIME_MS(static_cast<uint64_t>(valid_ms));
                    w.add_HORIZON_HOURS(static_cast<uint16_t>(horizon_hours));
                    w.add_MEMBER_KIND(member_kind_for(member_kind));
                    w.add_MEMBER_INDEX(static_cast<uint16_t>(member_index));
                    w.add_ENSEMBLE_SIZE(static_cast<uint16_t>(ensemble_size));
                    w.add_VARIABLE(variable_for_array(array));
                    w.add_VARIABLE_NAME(variable_name_off);
                    w.add_GRID(grid_off);
                    w.add_TILE_INDEX(tile.tile_index);
                    w.add_TILE_COUNT(tile.tile_count);
                    w.add_CHUNK_DTYPE(dtype_off);
                    w.add_CHUNK_CODECS(codecs_off);
                    w.add_ORIGIN_ID(origin_off);
                    w.add_DATASET_ID(dataset_off);
                    w.add_SOURCE_URL(source_url_off);
                    w.add_LICENSE_CLASS(historical ? wxfLicenseClass_Historical : wxfLicenseClass_RealTimeExperimental);
                    w.add_LICENSE_URL(license_url_off);
                    w.add_CITATION(citation_off);
                    FinishSizePrefixedWXFBuffer(job, w.Finish());
                }
                requests.emplace_back(1024 + job.GetSize());
                build_get(requests.back(), url, token, timeout_ms, job.GetBufferPointer(), job.GetSize());
            }
        }
    }
    wipe(&token);

    for (auto& request : requests) {
        if (push_request("requests", request) < 0) return 500;
    }
    return 0;
}

// cyclone_request: timer tick -> the cyclone track CSV GET (HttpRequest, a
// $TCT header in CONTEXT), or a Skipped FlowNotice when the cycle is skipped.
int cyclone_request(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

    const NodeConfig config = NodeConfig::load();
    const Provenance provenance = read_provenance(config);
    if (!config.flag("weathernext_live_access", false)) {
        return push_skipped("TCT.fbs", "weathernext3-cyclone-tracks", provenance.provider_id, "live-access-disabled");
    }
    const std::string url = config.text("weathernext_cyclone_url", "");
    if (url.empty()) return push_skipped("TCT.fbs", "weathernext3-cyclone-tracks", provenance.provider_id, "cyclone-url-missing");

    std::string token;
    const int auth_status = resolve_auth_token(config, &token);
    if (auth_status != 0) return auth_status;

    const long timeout_ms = static_cast<long>(config.number("weathernext_http_timeout_ms", kDefaultTimeoutMs));
    const double ensemble_size = config.number("weathernext_ensemble_size", 64);
    const double wind_period = config.number("weathernext_wind_averaging_period_s", 60);
    // Track rows carry their own valid times; the licence class of the fetch
    // is decided from the configured init time (the run being fetched) or,
    // absent one, from the previous synoptic cycle — both at least one hour old.
    const int64_t now_ms = now_unix_ms();
    int64_t init_ms = 0;
    {
        const std::string init_text = config.text("weathernext_init_time", "");
        if (init_text.empty() || !parse_iso_ms(init_text, &init_ms)) init_ms = default_init_time_ms(now_ms);
    }
    const bool historical = is_historical(now_ms, init_ms);

    // The job: a $TCT header record (no points; STORM_ID is required, so present and empty).
    flatbuffers::FlatBufferBuilder job(512);
    {
        const auto storm_id_off = job.CreateString("");
        const auto model_id_off = job.CreateString(provenance.model_id);
        const auto model_version_off = job.CreateString(provenance.model_version);
        const auto origin_off = job.CreateString(kOriginID);
        const auto dataset_off = job.CreateString(kDatasetID);
        const auto source_url_off = job.CreateString(url);
        const auto license_url_off = job.CreateString(historical ? provenance.historical_url : provenance.realtime_url);
        const auto citation_off = job.CreateString(provenance.citation);
        TCTBuilder t(job);
        t.add_STORM_ID(storm_id_off);
        t.add_MODEL_CLASS(wxfModelClass_MachineLearnedGlobalEnsemble);
        t.add_MODEL_ID(model_id_off);
        t.add_MODEL_VERSION(model_version_off);
        t.add_ENSEMBLE_SIZE(static_cast<uint16_t>(ensemble_size));
        t.add_WIND_AVERAGING_PERIOD_S(static_cast<uint16_t>(wind_period));
        t.add_ORIGIN_ID(origin_off);
        t.add_DATASET_ID(dataset_off);
        t.add_SOURCE_URL(source_url_off);
        t.add_LICENSE_CLASS(historical ? wxfLicenseClass_Historical : wxfLicenseClass_RealTimeExperimental);
        t.add_LICENSE_URL(license_url_off);
        t.add_CITATION(citation_off);
        FinishSizePrefixedTCTBuffer(job, t.Finish());
    }
    flatbuffers::FlatBufferBuilder request(1024 + job.GetSize());
    build_get(request, url, token, timeout_ms, job.GetBufferPointer(), job.GetSize());
    wipe(&token);
    return push_request("request", request) < 0 ? 500 : 0;
}

// publish_request: (storage-ingest IngestResult, parser IngestRequest) -> the
// HttpRequest that POSTs a DatasetPublicationRequest to the node's loopback
// admin endpoint. Fail-closed: no weathernext_publish_url, no frame; a REFUSED
// result (nothing stored) publishes nothing. The BODY is the endpoint's JSON
// ({schema, providerId, sourceName, batchId}, camelCase, decoded with
// DisallowUnknownFields) - a host HTTP API body, never an SDS record.
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
    const std::string url = config.text("weathernext_publish_url", "");
    // Absence of configuration is NOT permission to publish.
    if (url.empty()) return 0;
    // A refused batch was not stored: there is nothing to publish.
    if (result.REFUSED() && result.REFUSED()->size()) return 0;

    const auto text = [](const flatbuffers::String* s) { return s ? s->str() : std::string(); };
    std::string schema = text(result.SCHEMA());
    if (schema.empty()) schema = text(meta.SCHEMA());
    std::string batch_id = text(result.BATCH_ID());
    if (batch_id.empty() && meta.TAGS()) batch_id = text(meta.TAGS()->BATCH_ID());
    const std::string provider = meta.TAGS() ? text(meta.TAGS()->PROVIDER_ID()) : std::string();
    const std::string source = meta.TAGS() ? text(meta.TAGS()->SOURCE_NAME()) : std::string();
    if (schema.empty() || batch_id.empty() || provider.empty() || source.empty()) {
        plugin_set_error("incomplete-publication-identity",
                         "publish_request needs schema, batchId, providerId and sourceName.");
        return 400;
    }

    // The publication names the stored batch: an IngestResult (INGR) FlatBuffer, as data-source/nwp-field-source posts it.
    flatbuffers::FlatBufferBuilder rb(512);
    R::FinishIngestResultBuffer(rb, R::CreateIngestResultDirect(rb, schema.c_str(), provider.c_str(), source.c_str(), batch_id.c_str(), result.INSERTED(),
                                                                result.RECONCILED_DUPLICATES(), result.RECONCILED_OLD_BATCHES(),
                                                                result.ARCHIVED() && result.ARCHIVED()->size() ? result.ARCHIVED()->c_str() : nullptr, nullptr));
    const std::vector<uint8_t> body(rb.GetBufferPointer(), rb.GetBufferPointer() + rb.GetSize());
    const long timeout_ms = static_cast<long>(config.number("weathernext_http_timeout_ms", kDefaultTimeoutMs));
    flatbuffers::FlatBufferBuilder b(512 + body.size());
    std::vector<flatbuffers::Offset<R::Header>> headers{R::CreateHeaderDirect(b, "content-type", "application/octet-stream")};
    const auto headers_off = b.CreateVector(headers);
    const auto body_off = b.CreateVector(body);
    const auto url_off = b.CreateString(url);
    const auto method_off = b.CreateString("POST");
    R::FinishHttpRequestBuffer(b, R::CreateHttpRequest(b, method_off, url_off, headers_off, body_off,
                                                       static_cast<uint32_t>(timeout_ms > 0 ? timeout_ms : 0)));
    return push_request("request", b) < 0 ? 500 : 0;
}

}  // extern "C"
