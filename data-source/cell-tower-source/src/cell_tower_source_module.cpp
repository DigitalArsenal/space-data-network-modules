/*
 * data-source/cell-tower-source — many cellular-provider registries -> one
 * deconflicted SDS $TBS site stream.
 *
 * OWNER DIRECTIVE 2026-08-08: "the entire point is to grab from all providers
 * in the wasm module deployed to sdn.spaceaware.io, and have as options there
 * (configurable through the GUI here) which providers to use and how to
 * deconflict them, and have the final result sent using a spacedatastandard
 * streamed to OrbPro and displayed."
 *
 * ─── FLOW-NODE SHAPE ────────────────────────────────────────────────────────
 * Three pure flow nodes. The module performs NO I/O of its own: fetching is the
 * generic hostcap/http-request connector node, exactly as satnogs-source and
 * mlab-starlink-connectivity do. No new host capability exists or is needed.
 *
 *   route     : $HTQ request        -> "requests" (N hostcap/http-request GETs)
 *                                      "job"      (the run contract for parse)
 *                                      "reply"    (early error reply, or empty)
 *   parse     : job + responses     -> "reports"  (normalized reports, JSON)
 *   deconflict: job + reports       -> "records"  (size-prefixed $TBS stream)
 *                                      "summary"  (counts for the HTTP reply)
 *
 * The BROWSER supplies the configuration per request and renders the result. It
 * never fetches a provider, never merges, never scores. That inversion is the
 * whole point of the directive.
 *
 * ─── WHY REQUEST-SCOPED CONFIG, NOT NODE OPTIONS ────────────────────────────
 * The node's module-runtime options API is admin-only and node-global. A demo
 * viewer choosing his own provider set must not rewrite operator config for
 * every other viewer, so the provider set and merge method arrive on the
 * request and die with it. Credentials are the exception: those are node state
 * by nature and live in the node's credential store (see the CREDENTIALS note).
 *
 * ─── THE $TBS CONTRACT THIS ENCODES (SDS 1.184.0, ratified 2026-08-08) ──────
 * 1. SOURCES and CONSENSUS are BOTH `required` in the IDL. A deconflicted site
 *    that cannot say who reported it and how it was merged is unrepresentable
 *    by construction — every record written here carries both, always.
 * 2. Every provider in a merge group appears in SOURCES, winners and losers,
 *    each with its own LICENSE and ATTRIBUTION. That is a share-alike
 *    obligation surviving republication, not decoration.
 * 3. RADIO defaults to UNKNOWN and METHOD to UNSPECIFIED in the IDL precisely
 *    so an unset enum never decodes as ordinal-0 GSM / SINGLE_SOURCE. This
 *    module always writes both explicitly anyway.
 * 4. CELL_ID is a STRING: a 16-bit CI, a 28-bit LTE ECI and a 36-bit NR NCI are
 *    not the same number space and must not be coerced into one integer.
 *
 * ─── DECONFLICTION ──────────────────────────────────────────────────────────
 * The normative semantics live in
 * packages/cell-towers-worldwide/src/deconflict.mjs and are mirrored here
 * exactly; tests/parity.test.mjs drives BOTH over the same fixtures and fails
 * the build on any divergence, so this comment can never quietly drift from the
 * code. Summary of the rules that are judgement calls rather than mechanics:
 *   - Identity is the network identifiers where a provider supplies them.
 *     LAC and TAC are the same slot in different generations, so keying on both
 *     would split an agreement into two sites.
 *   - A report with no identifiers is matched by proximity and NEVER folded
 *     into an identifier group: being near a cell is not evidence of being it.
 *   - Ties break on provider id ascending. The parity gate needs determinism
 *     more than it needs a cleverer rule.
 *   - Providers CONSULTED counts every provider asked, including ones that
 *     returned nothing. Absent is not zero.
 *
 * ─── CREDENTIALS (owner directive #2, deliberately NOT implemented here) ────
 * Providers needing a login are SKIPPED with an explicit reason until the node
 * can hand this module a credential: `secrets.put` does not exist yet and the
 * `provider-wrapping` key slot is declared X25519 but filled with a secp256k1
 * scalar, so `keyslot.unwrap` cannot open anything a browser seals. Both are
 * tracked by upstream-sdn-3 and turned on by
 * orbpro-cellular-credential-persistence. Skipping loudly is correct; inventing
 * an envelope or fetching unauthenticated and pretending would not be.
 */

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <algorithm>
#include <cmath>
#include <map>
#include <set>
#include <string>
#include <vector>

#include <sys/time.h>
#include <ctime>

#include "space_data_module_invoke.h"

namespace {

// ── tbsRadioClass / tbsMergeMethod ordinals (schema/TBS/main.fbs) ───────────
// Verified against the published 1.184.0 IDL, not against a summary of it.
enum RadioClass : int8_t { RC_GSM = 0, RC_CDMA, RC_UMTS, RC_LTE, RC_NR, RC_OTHER, RC_UNKNOWN };
enum MergeMethod : int8_t {
    MM_SINGLE_SOURCE = 0,
    MM_HIGHEST_SAMPLE_COUNT,
    MM_MOST_RECENT,
    MM_AUTHORITY_PRECEDENCE,
    MM_CENTROID,
    MM_UNSPECIFIED
};

// Matches DEFAULT_POSITION_TOLERANCE_M in deconflict.mjs. Deliberately
// conservative: collapsing two real masts on one street is a worse error than
// leaving a duplicate visible.
constexpr double kPositionToleranceM = 250.0;
constexpr double kEarthRadiusM = 6378137.0;

// ── minimal JSON helpers ───────────────────────────────────────────────────
// The flow's intra-node frames are UTF-8 JSON (the hostcap http-request
// descriptor shape is defined by the host op, not by SDS), so a small reader is
// all that is needed. Nothing here parses provider payloads: those go through
// the per-adapter decoders below.

std::string json_escape(const std::string& in) {
    std::string out;
    out.reserve(in.size() + 8);
    for (char c : in) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += c;
                }
        }
    }
    return out;
}

// Reverses json_escape for the one level of nesting the http mount introduces.
std::string json_unescape(const std::string& in) {
    std::string out;
    out.reserve(in.size());
    for (size_t i = 0; i < in.size(); ++i) {
        if (in[i] != '\\' || i + 1 >= in.size()) { out += in[i]; continue; }
        switch (in[++i]) {
            case 'n': out += '\n'; break;
            case 'r': out += '\r'; break;
            case 't': out += '\t'; break;
            case 'b': out += '\b'; break;
            case 'f': out += '\f'; break;
            case '"': out += '"'; break;
            case '\\': out += '\\'; break;
            case '/': out += '/'; break;
            case 'u': {
                if (i + 4 < in.size()) {
                    const std::string hex = in.substr(i + 1, 4);
                    const long cp = std::strtol(hex.c_str(), nullptr, 16);
                    i += 4;
                    // Only the ASCII range appears in these control frames;
                    // anything above it is passed through as a replacement
                    // rather than silently mangled into a wrong byte.
                    out += (cp < 0x80) ? static_cast<char>(cp) : '?';
                }
                break;
            }
            default: out += in[i];
        }
    }
    return out;
}

// Finds "key": and returns the raw value slice. Depth-aware enough for the
// flat frames this flow uses; it is never pointed at arbitrary provider JSON.
bool json_raw_field(const std::string& src, const std::string& key, std::string* out) {
    const std::string needle = "\"" + key + "\"";
    size_t at = src.find(needle);
    if (at == std::string::npos) return false;
    at = src.find(':', at + needle.size());
    if (at == std::string::npos) return false;
    ++at;
    while (at < src.size() && (src[at] == ' ' || src[at] == '\n' || src[at] == '\t')) ++at;
    if (at >= src.size()) return false;
    size_t end = at;
    if (src[at] == '"') {
        end = at + 1;
        while (end < src.size() && !(src[end] == '"' && src[end - 1] != '\\')) ++end;
        if (end >= src.size()) return false;
        // UNESCAPED, deliberately. The http mount hands the request BODY through
        // as a JSON string field, so the caller's own JSON arrives escaped one
        // level deep. Returning the raw slice would leave \" in place and every
        // subsequent key lookup would silently miss, which reads exactly like
        // "the caller sent nothing".
        *out = json_unescape(src.substr(at + 1, end - at - 1));
        return true;
    }
    int depth = 0;
    while (end < src.size()) {
        const char c = src[end];
        if (c == '[' || c == '{') ++depth;
        if (c == ']' || c == '}') {
            if (depth == 0) break;
            --depth;
        }
        if (c == ',' && depth == 0) break;
        ++end;
    }
    *out = src.substr(at, end - at);
    return true;
}

std::string json_string(const std::string& src, const std::string& key, const std::string& fallback) {
    std::string raw;
    if (!json_raw_field(src, key, &raw)) return fallback;
    return raw;
}

double json_number(const std::string& src, const std::string& key, double fallback) {
    std::string raw;
    if (!json_raw_field(src, key, &raw)) return fallback;
    if (raw.empty() || raw == "null") return fallback;
    return std::atof(raw.c_str());
}

// Splits a JSON array of strings. Used for the PROVIDERS list.
std::vector<std::string> json_string_array(const std::string& src, const std::string& key) {
    std::vector<std::string> out;
    std::string raw;
    if (!json_raw_field(src, key, &raw)) return out;
    size_t i = 0;
    while (i < raw.size()) {
        if (raw[i] != '"') { ++i; continue; }
        size_t end = i + 1;
        while (end < raw.size() && !(raw[end] == '"' && raw[end - 1] != '\\')) ++end;
        if (end >= raw.size()) break;
        out.push_back(raw.substr(i + 1, end - i - 1));
        i = end + 1;
    }
    return out;
}

// ── provider registry (mirrors packages/cell-towers-worldwide/providers.json) ──
// Only the fields this module needs to FETCH and ATTRIBUTE. The full registry
// with terms/notes stays in the JS package; duplicating prose here would let
// the two drift. tests/registry-parity.test.mjs asserts the id set matches.
struct ProviderSpec {
    const char* id;
    const char* authority;
    const char* url;
    const char* format;       // "csv" | "json"
    const char* license;
    const char* license_url;
    const char* attribution;
    bool login_required;
    bool authoritative;       // administration/regulator register, not a crowd
};

// clang-format off
constexpr ProviderSpec kProviders[] = {
  {"opencellid","OpenCelliD contributors","https://opencellid.org/downloads.php","csv",
   "CC BY-SA 4.0","https://wiki.opencellid.org/wiki/Menu_map_view","OpenCelliD Project",true,false},
  {"openstreetmap-overpass","OpenStreetMap contributors","https://overpass-api.de/api/interpreter","json",
   "ODbL 1.0","https://www.openstreetmap.org/copyright","OpenStreetMap contributors",false,false},
  {"fcc-asr","Federal Communications Commission","https://www.fcc.gov/uls/transactions/daily-weekly","csv",
   "Public domain (US Government work)","https://www.fcc.gov/","FCC Antenna Structure Registration",false,true},
  {"anfr-cartoradio","Agence nationale des frequences","https://data.anfr.fr/api/records/2.0/downloadfile/","csv",
   "Licence Ouverte 2.0","https://www.etalab.gouv.fr/licence-ouverte-open-licence","ANFR Cartoradio",false,true},
  {"acma-rrl","Australian Communications and Media Authority","https://web.acma.gov.au/rrl/","csv",
   "CC BY 4.0","https://creativecommons.org/licenses/by/4.0/","ACMA Register of Radiocommunications Licences",false,true},
  {"ised-sms-tafl","Innovation, Science and Economic Development Canada","https://sms-sgs.ic.gc.ca/","csv",
   "Open Government Licence - Canada","https://open.canada.ca/en/open-government-licence-canada","ISED Spectrum Management System",false,true},
  {"bnetza-emf","Bundesnetzagentur","https://www.bundesnetzagentur.de/","json",
   "DL-DE-BY-2.0","https://www.govdata.de/dl-de/by-2-0","Bundesnetzagentur EMF database",false,true},
  {"nl-antenneregister","Agentschap Telecom","https://antenneregister.nl/","json",
   "CC BY 4.0","https://creativecommons.org/licenses/by/4.0/","Antenneregister",false,true},
  {"bakom-mobile-sites","Bundesamt fuer Kommunikation","https://www.bakom.admin.ch/","json",
   "opendata.swiss terms","https://opendata.swiss/en/terms-of-use","BAKOM mobile sites",false,true},
  {"comreg-siteviewer","Commission for Communications Regulation","https://siteviewer.comreg.ie/","json",
   "CC BY 4.0","https://creativecommons.org/licenses/by/4.0/","ComReg SiteViewer",false,true},
  {"nz-rsm-rrf","Radio Spectrum Management","https://www.rsm.govt.nz/","csv",
   "CC BY 4.0","https://creativecommons.org/licenses/by/4.0/","RSM Register of Radio Frequencies",false,true},
  {"wigle","WiGLE.net contributors","https://api.wigle.net/api/v2/cell/search","json",
   "WiGLE terms of use","https://wigle.net/tos","WiGLE.net",true,false},
  {"mls-archive","Mozilla Location Service archive","https://d17pt8qph6ncyq.cloudfront.net/","csv",
   "CC0 1.0","https://creativecommons.org/publicdomain/zero/1.0/","MLS historical archive",false,false},
};
// clang-format on
constexpr size_t kProviderCount = sizeof(kProviders) / sizeof(kProviders[0]);

const ProviderSpec* find_provider(const std::string& id) {
    for (size_t i = 0; i < kProviderCount; ++i) {
        if (id == kProviders[i].id) return &kProviders[i];
    }
    return nullptr;
}

// ── normalized report ──────────────────────────────────────────────────────
struct Report {
    std::string provider_id;
    std::string native_id;
    int8_t radio = RC_UNKNOWN;
    long mcc = -1, mnc = -1, lac = -1, tac = -1;
    std::string cell_id;
    double latitude = 0, longitude = 0;
    double range_m = -1;
    long samples = -1;
    double average_signal_dbm = 0;
    bool has_signal = false;
    long long observed_at = -1;   // epoch seconds
    std::string site_name;
    std::string operator_name;
    std::string country_code;
};

int8_t radio_from_text(const std::string& raw) {
    std::string v;
    for (char c : raw) v += static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    if (v == "GSM" || v == "2G") return RC_GSM;
    if (v == "CDMA") return RC_CDMA;
    if (v == "UMTS" || v == "3G" || v == "WCDMA") return RC_UMTS;
    if (v == "LTE" || v == "4G") return RC_LTE;
    if (v == "NR" || v == "5G" || v == "NR5G") return RC_NR;
    if (v.empty()) return RC_UNKNOWN;
    return RC_OTHER;
}

// RETRIEVED_AT / MERGED_AT. Read from the host clock through the standard
// wasi clock, not invented: a provenance timestamp that is not a real time is
// worse than an absent one, because it looks authoritative.
std::string iso_now() {
    struct timeval tv;
    if (gettimeofday(&tv, nullptr) != 0) return std::string();
    const time_t secs = static_cast<time_t>(tv.tv_sec);
    struct tm utc;
    if (gmtime_r(&secs, &utc) == nullptr) return std::string();
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02d.000Z", utc.tm_year + 1900,
                  utc.tm_mon + 1, utc.tm_mday, utc.tm_hour, utc.tm_min, utc.tm_sec);
    return std::string(buf);
}

// The hostcap/http-request response frame carries the body BASE64-ENCODED
// (`bodyB64`), because a raw body is not JSON-safe. Reading `body` instead
// would silently see nothing on every real response.
int b64_value(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

bool base64_decode(const std::string& text, std::string* out) {
    out->clear();
    out->reserve((text.size() / 4) * 3);
    uint32_t acc = 0;
    int bits = 0;
    for (const char c : text) {
        if (c == '=' || c == '\n' || c == '\r') continue;
        const int v = b64_value(c);
        if (v < 0) return false;
        acc = (acc << 6) | static_cast<uint32_t>(v);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out->push_back(static_cast<char>((acc >> bits) & 0xff));
        }
    }
    return true;
}

double haversine_m(double lat1, double lon1, double lat2, double lon2) {
    const double to_rad = 3.14159265358979323846 / 180.0;
    const double dlat = (lat2 - lat1) * to_rad;
    const double dlon = (lon2 - lon1) * to_rad;
    const double a = std::sin(dlat / 2) * std::sin(dlat / 2) +
                     std::cos(lat1 * to_rad) * std::cos(lat2 * to_rad) *
                         std::sin(dlon / 2) * std::sin(dlon / 2);
    return 2 * kEarthRadiusM * std::asin(std::min(1.0, std::sqrt(a)));
}

// ── CSV decoding (the OpenCelliD/MLS column contract) ──────────────────────
std::vector<std::string> split_csv_line(const std::string& line) {
    std::vector<std::string> cells;
    std::string cur;
    bool quoted = false;
    for (size_t i = 0; i < line.size(); ++i) {
        const char c = line[i];
        if (quoted) {
            if (c == '"' && i + 1 < line.size() && line[i + 1] == '"') { cur += '"'; ++i; }
            else if (c == '"') quoted = false;
            else cur += c;
        } else if (c == '"') {
            quoted = true;
        } else if (c == ',') {
            cells.push_back(cur);
            cur.clear();
        } else if (c != '\r') {
            cur += c;
        }
    }
    cells.push_back(cur);
    return cells;
}

int column_of(const std::vector<std::string>& header, const char* name) {
    for (size_t i = 0; i < header.size(); ++i) {
        if (header[i] == name) return static_cast<int>(i);
    }
    return -1;
}

void decode_csv(const ProviderSpec& spec, const std::string& body, std::vector<Report>* out) {
    size_t pos = 0, line_no = 0;
    std::vector<std::string> header;
    while (pos < body.size()) {
        size_t nl = body.find('\n', pos);
        if (nl == std::string::npos) nl = body.size();
        const std::string line = body.substr(pos, nl - pos);
        pos = nl + 1;
        if (line.empty()) continue;
        const std::vector<std::string> cells = split_csv_line(line);
        if (line_no++ == 0) { header = cells; continue; }

        const int c_lat = column_of(header, "lat");
        const int c_lon = column_of(header, "lon");
        if (c_lat < 0 || c_lon < 0) return;  // not the expected contract; emit nothing
        if (c_lat >= static_cast<int>(cells.size()) || c_lon >= static_cast<int>(cells.size())) continue;

        Report r;
        r.provider_id = spec.id;
        r.latitude = std::atof(cells[c_lat].c_str());
        r.longitude = std::atof(cells[c_lon].c_str());
        // A row whose coordinates are out of range is DROPPED, not clamped: a
        // clamped tower is a tower in the wrong place, silently.
        if (r.latitude < -90 || r.latitude > 90 || r.longitude < -180 || r.longitude > 180) continue;

        const int c_radio = column_of(header, "radio");
        const int c_mcc = column_of(header, "mcc");
        const int c_net = column_of(header, "net");
        const int c_area = column_of(header, "area");
        const int c_cell = column_of(header, "cell");
        const int c_range = column_of(header, "range");
        const int c_samples = column_of(header, "samples");
        const int c_updated = column_of(header, "updated");
        const int c_signal = column_of(header, "averageSignal");

        auto cell_at = [&](int idx) -> std::string {
            return (idx >= 0 && idx < static_cast<int>(cells.size())) ? cells[idx] : std::string();
        };
        r.radio = radio_from_text(cell_at(c_radio));
        if (!cell_at(c_mcc).empty()) r.mcc = std::atol(cell_at(c_mcc).c_str());
        if (!cell_at(c_net).empty()) r.mnc = std::atol(cell_at(c_net).c_str());
        if (!cell_at(c_area).empty()) r.lac = std::atol(cell_at(c_area).c_str());
        r.cell_id = cell_at(c_cell);
        if (!cell_at(c_range).empty()) r.range_m = std::atof(cell_at(c_range).c_str());
        if (!cell_at(c_samples).empty()) r.samples = std::atol(cell_at(c_samples).c_str());
        if (!cell_at(c_updated).empty()) r.observed_at = std::atoll(cell_at(c_updated).c_str());
        if (!cell_at(c_signal).empty()) {
            r.average_signal_dbm = std::atof(cell_at(c_signal).c_str());
            r.has_signal = true;
        }
        r.native_id = r.cell_id;
        out->push_back(r);
    }
}

// ── report <-> JSON (the intra-flow "reports" frame) ────────────────────────
std::string report_to_json(const Report& r) {
    std::string j = "{\"provider_id\":\"" + json_escape(r.provider_id) + "\"";
    j += ",\"radio\":" + std::to_string(static_cast<int>(r.radio));
    j += ",\"latitude\":" + std::to_string(r.latitude);
    j += ",\"longitude\":" + std::to_string(r.longitude);
    if (!r.native_id.empty()) j += ",\"native_id\":\"" + json_escape(r.native_id) + "\"";
    if (r.mcc >= 0) j += ",\"mcc\":" + std::to_string(r.mcc);
    if (r.mnc >= 0) j += ",\"mnc\":" + std::to_string(r.mnc);
    if (r.lac >= 0) j += ",\"lac\":" + std::to_string(r.lac);
    if (r.tac >= 0) j += ",\"tac\":" + std::to_string(r.tac);
    if (!r.cell_id.empty()) j += ",\"cell_id\":\"" + json_escape(r.cell_id) + "\"";
    if (r.range_m >= 0) j += ",\"range_m\":" + std::to_string(r.range_m);
    if (r.samples >= 0) j += ",\"samples\":" + std::to_string(r.samples);
    if (r.has_signal) j += ",\"average_signal_dbm\":" + std::to_string(r.average_signal_dbm);
    if (r.observed_at >= 0) j += ",\"observed_at\":" + std::to_string(r.observed_at);
    if (!r.site_name.empty()) j += ",\"site_name\":\"" + json_escape(r.site_name) + "\"";
    if (!r.operator_name.empty()) j += ",\"operator\":\"" + json_escape(r.operator_name) + "\"";
    if (!r.country_code.empty()) j += ",\"country_code\":\"" + json_escape(r.country_code) + "\"";
    return j + "}";
}

Report report_from_json(const std::string& j) {
    Report r;
    r.provider_id = json_string(j, "provider_id", "");
    r.native_id = json_string(j, "native_id", "");
    r.radio = static_cast<int8_t>(json_number(j, "radio", RC_UNKNOWN));
    r.latitude = json_number(j, "latitude", 0);
    r.longitude = json_number(j, "longitude", 0);
    r.mcc = static_cast<long>(json_number(j, "mcc", -1));
    r.mnc = static_cast<long>(json_number(j, "mnc", -1));
    r.lac = static_cast<long>(json_number(j, "lac", -1));
    r.tac = static_cast<long>(json_number(j, "tac", -1));
    r.cell_id = json_string(j, "cell_id", "");
    r.range_m = json_number(j, "range_m", -1);
    r.samples = static_cast<long>(json_number(j, "samples", -1));
    const double sig = json_number(j, "average_signal_dbm", 1e9);
    if (sig < 1e8) { r.average_signal_dbm = sig; r.has_signal = true; }
    r.observed_at = static_cast<long long>(json_number(j, "observed_at", -1));
    r.site_name = json_string(j, "site_name", "");
    r.operator_name = json_string(j, "operator", "");
    r.country_code = json_string(j, "country_code", "");
    return r;
}

// Splits a JSON array of objects into its top-level object slices.
std::vector<std::string> split_json_objects(const std::string& src) {
    std::vector<std::string> out;
    int depth = 0;
    size_t start = 0;
    bool in_string = false;
    for (size_t i = 0; i < src.size(); ++i) {
        const char c = src[i];
        if (in_string) {
            if (c == '"' && src[i - 1] != '\\') in_string = false;
            continue;
        }
        if (c == '"') { in_string = true; continue; }
        if (c == '{') { if (depth++ == 0) start = i; }
        else if (c == '}') { if (--depth == 0) out.push_back(src.substr(start, i - start + 1)); }
    }
    return out;
}

// ── deconfliction (mirror of deconflict.mjs; parity-gated) ─────────────────
std::string network_identity(const Report& r) {
    if (r.mcc < 0 || r.mnc < 0 || r.cell_id.empty()) return std::string();
    const long area = (r.lac >= 0) ? r.lac : r.tac;  // same slot, different era
    return std::to_string(static_cast<int>(r.radio)) + "|" + std::to_string(r.mcc) + "|" +
           std::to_string(r.mnc) + "|" + (area >= 0 ? std::to_string(area) : "") + "|" + r.cell_id;
}

std::vector<std::vector<size_t>> group_reports(const std::vector<Report>& reports) {
    std::vector<std::vector<size_t>> groups;
    std::map<std::string, size_t> by_identity;
    std::vector<size_t> geometric;  // indices INTO groups
    for (size_t i = 0; i < reports.size(); ++i) {
        const std::string identity = network_identity(reports[i]);
        if (!identity.empty()) {
            auto it = by_identity.find(identity);
            if (it == by_identity.end()) {
                by_identity[identity] = groups.size();
                groups.push_back({i});
            } else {
                groups[it->second].push_back(i);
            }
            continue;
        }
        size_t matched = SIZE_MAX;
        double best = 1e18;
        for (size_t g : geometric) {
            const Report& head = reports[groups[g][0]];
            const double d = haversine_m(head.latitude, head.longitude,
                                         reports[i].latitude, reports[i].longitude);
            if (d <= kPositionToleranceM && d < best) { best = d; matched = g; }
        }
        if (matched != SIZE_MAX) { groups[matched].push_back(i); continue; }
        geometric.push_back(groups.size());
        groups.push_back({i});
    }
    return groups;
}

long sample_count(const Report& r) { return r.samples >= 0 ? r.samples : 0; }

size_t select_winner(const std::vector<Report>& reports, const std::vector<size_t>& group,
                     int8_t method) {
    size_t best = group[0];
    for (size_t idx : group) {
        const Report& a = reports[idx];
        const Report& b = reports[best];
        bool better = false;
        if (method == MM_MOST_RECENT) {
            if (a.observed_at != b.observed_at) better = a.observed_at > b.observed_at;
            else better = a.provider_id < b.provider_id;
        } else if (method == MM_AUTHORITY_PRECEDENCE) {
            const ProviderSpec* pa = find_provider(a.provider_id);
            const ProviderSpec* pb = find_provider(b.provider_id);
            const int aa = (pa && pa->authoritative) ? 1 : 0;
            const int ab = (pb && pb->authoritative) ? 1 : 0;
            if (aa != ab) better = aa > ab;
            else if (sample_count(a) != sample_count(b)) better = sample_count(a) > sample_count(b);
            else better = a.provider_id < b.provider_id;
        } else {
            if (sample_count(a) != sample_count(b)) better = sample_count(a) > sample_count(b);
            else better = a.provider_id < b.provider_id;
        }
        if (better) best = idx;
    }
    return best;
}

double position_spread(const std::vector<Report>& reports, const std::vector<size_t>& group) {
    double worst = 0;
    for (size_t i = 0; i < group.size(); ++i) {
        for (size_t j = i + 1; j < group.size(); ++j) {
            worst = std::max(worst, haversine_m(reports[group[i]].latitude, reports[group[i]].longitude,
                                                reports[group[j]].latitude, reports[group[j]].longitude));
        }
    }
    return worst;
}

double confidence_of(const std::vector<Report>& reports, const std::vector<size_t>& group,
                     size_t consulted, double spread) {
    std::set<std::string> agreeing;
    for (size_t i : group) agreeing.insert(reports[i].provider_id);
    const double corroboration =
        consulted <= 1 ? 0.5
                       : 0.5 + 0.5 * (static_cast<double>(agreeing.size() - 1) /
                                      static_cast<double>(consulted - 1));
    const double dispersion = spread <= 0 ? 1.0 : std::max(0.0, 1.0 - spread / (kPositionToleranceM * 2));
    const double raw = std::min(1.0, corroboration * (0.6 + 0.4 * dispersion));
    return std::round(raw * 1000.0) / 1000.0;
}

// ── $TBS encoding ──────────────────────────────────────────────────────────
// SOURCES and CONSENSUS are `required` in the IDL, so both are always built.
// Optional scalars are only added when the source actually reported them:
// FlatBuffers omits default-valued fields, which is what keeps "the provider
// did not say" distinguishable from "the provider said zero".
void build_tbs_record(const std::vector<Report>& reports, const std::vector<size_t>& group,
                      size_t win, int8_t method, double lat, double lon, double spread,
                      uint32_t consulted, uint32_t agreeing, double confidence,
                      const std::string& stamp, std::vector<uint8_t>* out) {
    flatbuffers::FlatBufferBuilder b(2048);

    std::vector<flatbuffers::Offset<TBSProvenance>> sources;
    sources.reserve(group.size());
    for (size_t idx : group) {
        const Report& r = reports[idx];
        const ProviderSpec* spec = find_provider(r.provider_id);
        const auto provider_id = b.CreateString(r.provider_id);
        const auto retrieved_at = b.CreateString(stamp);
        const auto license = b.CreateString(spec ? spec->license : "unknown");
        const auto authority = spec ? b.CreateString(spec->authority) : 0;
        const auto source_url = spec ? b.CreateString(spec->url) : 0;
        const auto license_url = spec ? b.CreateString(spec->license_url) : 0;
        const auto attribution = spec ? b.CreateString(spec->attribution) : 0;
        const auto native_id = r.native_id.empty() ? 0 : b.CreateString(r.native_id);

        TBSProvenanceBuilder pb(b);
        pb.add_PROVIDER_ID(provider_id);
        pb.add_RETRIEVED_AT(retrieved_at);
        pb.add_LICENSE(license);
        if (authority.o) pb.add_AUTHORITY(authority);
        if (source_url.o) pb.add_SOURCE_URL(source_url);
        if (license_url.o) pb.add_LICENSE_URL(license_url);
        if (attribution.o) pb.add_ATTRIBUTION(attribution);
        if (native_id.o) pb.add_NATIVE_ID(native_id);
        pb.add_REPORTED_LATITUDE(r.latitude);
        pb.add_REPORTED_LONGITUDE(r.longitude);
        pb.add_CONTRIBUTED(idx == win);
        sources.push_back(pb.Finish());
    }
    const auto sources_vec = b.CreateVector(sources);

    const Report& w = reports[win];
    const auto winner_id = b.CreateString(w.provider_id);
    const auto merged_at = b.CreateString(stamp);
    TBSConsensusBuilder cb(b);
    cb.add_METHOD(static_cast<tbsMergeMethod>(method));
    cb.add_PROVIDERS_CONSULTED(consulted);
    cb.add_PROVIDERS_AGREEING(agreeing);
    cb.add_WINNING_PROVIDER_ID(winner_id);
    cb.add_POSITION_SPREAD_M(spread);
    cb.add_CONFIDENCE(confidence);
    cb.add_MERGED_AT(merged_at);
    const auto consensus = cb.Finish();

    // The site id is the WINNER's, so a site that keeps winning keeps its id
    // across runs and the globe does not churn between requests.
    const std::string site_id = w.provider_id + ":" + (w.cell_id.empty() ? "geo" : w.cell_id);
    const auto id = b.CreateString(site_id);
    const auto cell_id = w.cell_id.empty() ? 0 : b.CreateString(w.cell_id);
    const auto native_id = w.native_id.empty() ? 0 : b.CreateString(w.native_id);
    const auto site_name = w.site_name.empty() ? 0 : b.CreateString(w.site_name);
    const auto operator_name = w.operator_name.empty() ? 0 : b.CreateString(w.operator_name);
    const auto country_code = w.country_code.empty() ? 0 : b.CreateString(w.country_code);
    const auto last_observed =
        w.observed_at >= 0 ? b.CreateString(std::to_string(w.observed_at)) : 0;

    TBSBuilder tb(b);
    tb.add_ID(id);
    tb.add_RADIO(static_cast<tbsRadioClass>(w.radio));
    tb.add_LATITUDE(lat);
    tb.add_LONGITUDE(lon);
    if (native_id.o) tb.add_NATIVE_ID(native_id);
    if (w.mcc >= 0) tb.add_MCC(static_cast<uint32_t>(w.mcc));
    if (w.mnc >= 0) tb.add_MNC(static_cast<uint32_t>(w.mnc));
    if (w.lac >= 0) tb.add_LAC(static_cast<uint32_t>(w.lac));
    if (w.tac >= 0) tb.add_TAC(static_cast<uint32_t>(w.tac));
    if (cell_id.o) tb.add_CELL_ID(cell_id);
    if (w.range_m >= 0) tb.add_RANGE_M(w.range_m);
    if (w.samples >= 0) tb.add_SAMPLES(static_cast<uint32_t>(w.samples));
    if (w.has_signal) tb.add_AVERAGE_SIGNAL_DBM(w.average_signal_dbm);
    if (last_observed.o) tb.add_LAST_OBSERVED(last_observed);
    if (operator_name.o) tb.add_OPERATOR(operator_name);
    if (site_name.o) tb.add_SITE_NAME(site_name);
    if (country_code.o) tb.add_COUNTRY_CODE(country_code);
    tb.add_SOURCES(sources_vec);
    tb.add_CONSENSUS(consensus);
    FinishTBSBuffer(b, tb.Finish());

    out->assign(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
}

// ── frame helpers ──────────────────────────────────────────────────────────
int push_json(const char* port, const std::string& json) {
    return plugin_push_output_ex(port, nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 nullptr, 0, 0, reinterpret_cast<const uint8_t*>(json.data()),
                                 static_cast<uint32_t>(json.size()));
}

int push_tbs_stream(const char* port, const std::vector<uint8_t>& bytes) {
    return plugin_push_output_ex(port, "TBS.fbs", "$TBS", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 "TBS", 0, 0, bytes.data(), static_cast<uint32_t>(bytes.size()));
}

std::string input_text(const char* port_id, uint32_t ordinal) {
    const int32_t idx = plugin_find_input_index(port_id, ordinal);
    if (idx < 0) return std::string();
    const plugin_input_frame_t* f = plugin_get_input_frame(static_cast<uint32_t>(idx));
    if (!f || !f->payload) return std::string();
    return std::string(reinterpret_cast<const char*>(f->payload), f->payload_length);
}

}  // namespace

extern "C" {

// ---------------------------------------------------------------------------
// route: one $HTQ request -> N provider fetch descriptors + the run contract.
//
// The provider set and merge method are read from the REQUEST, never from node
// config, so two viewers can ask for different things at the same time without
// either of them changing what the node is.
// ---------------------------------------------------------------------------
int route(void) {
    const std::string request = input_text("request", 0);
    const std::string body = json_string(request, "body", request);

    std::vector<std::string> wanted = json_string_array(body, "PROVIDERS");
    const std::string method_name = json_string(body, "METHOD", "HIGHEST_SAMPLE_COUNT");
    const double limit = json_number(body, "LIMIT", 2000);

    int8_t method = MM_HIGHEST_SAMPLE_COUNT;
    if (method_name == "SINGLE_SOURCE") method = MM_SINGLE_SOURCE;
    else if (method_name == "MOST_RECENT") method = MM_MOST_RECENT;
    else if (method_name == "AUTHORITY_PRECEDENCE") method = MM_AUTHORITY_PRECEDENCE;
    else if (method_name == "CENTROID") method = MM_CENTROID;
    else if (method_name == "HIGHEST_SAMPLE_COUNT") method = MM_HIGHEST_SAMPLE_COUNT;
    else {
        // An unknown strategy is REFUSED, never silently defaulted: answering a
        // question the caller did not ask, under a name they chose, is worse
        // than saying no.
        push_json("reply",
                  std::string("{\"status\":400,\"error\":\"unknown METHOD \\\"") +
                      json_escape(method_name) + "\\\"\"}");
        return 0;
    }

    if (wanted.empty()) {
        push_json("reply", "{\"status\":400,\"error\":\"PROVIDERS must name at least one provider\"}");
        return 0;
    }

    std::string requests = "[";
    std::string consulted = "[";
    std::string skipped = "[";
    size_t emitted = 0, skipped_count = 0;
    for (const std::string& id : wanted) {
        const ProviderSpec* spec = find_provider(id);
        if (!spec) {
            if (skipped_count++) skipped += ",";
            skipped += "{\"provider_id\":\"" + json_escape(id) + "\",\"reason\":\"unknown provider\"}";
            continue;
        }
        if (spec->login_required) {
            // See the CREDENTIALS note at the top: skip loudly, never fetch
            // unauthenticated and pretend the answer is complete.
            if (skipped_count++) skipped += ",";
            skipped += std::string("{\"provider_id\":\"") + spec->id +
                       "\",\"reason\":\"credential required and the node cannot yet store one\"}";
            continue;
        }
        if (emitted++) { requests += ","; consulted += ","; }
        requests += std::string("{\"provider_id\":\"") + spec->id + "\",\"method\":\"GET\",\"url\":\"" +
                    json_escape(spec->url) + "\",\"headers\":{\"accept\":\"*/*\"},\"timeoutMs\":30000}";
        consulted += std::string("\"") + spec->id + "\"";
    }
    requests += "]";
    consulted += "]";
    skipped += "]";

    const std::string job = std::string("{\"method\":") + std::to_string(static_cast<int>(method)) +
                            ",\"method_name\":\"" + json_escape(method_name) + "\"" +
                            ",\"limit\":" + std::to_string(static_cast<long>(limit)) +
                            ",\"providers_consulted\":" + consulted +
                            ",\"skipped\":" + skipped + "}";

    if (push_json("requests", requests) < 0) return 500;
    if (push_json("job", job) < 0) return 500;
    return 0;
}

// ---------------------------------------------------------------------------
// parse: job + N http responses -> normalized reports.
// ---------------------------------------------------------------------------
int parse(void) {
    const std::string job = input_text("job", 0);
    std::vector<Report> reports;

    const uint32_t count = plugin_get_input_count();
    for (uint32_t i = 0; i < count; ++i) {
        const plugin_input_frame_t* f = plugin_get_input_frame(i);
        if (!f || !f->port_id || std::strcmp(f->port_id, "responses") != 0) continue;
        const std::string frame(reinterpret_cast<const char*>(f->payload), f->payload_length);
        const std::string provider_id = json_string(frame, "provider_id", "");
        const ProviderSpec* spec = find_provider(provider_id);
        if (!spec) continue;
        const double status = json_number(frame, "status", 0);
        // A provider that failed is simply absent from the answer. It stays in
        // providers_consulted, so "asked and got nothing" remains visible and
        // never reads as "agreed".
        if (status < 200 || status >= 300) continue;
        const std::string body_b64 = json_string(frame, "bodyB64", "");
        if (body_b64.empty()) continue;
        std::string payload;
        if (!base64_decode(body_b64, &payload) || payload.empty()) continue;
        if (std::strcmp(spec->format, "csv") == 0) decode_csv(*spec, payload, &reports);
        // JSON adapters land with the per-provider decoders; until each is
        // written and fixtured, an unsupported format contributes nothing
        // rather than a guess.
    }

    std::string out = "[";
    for (size_t i = 0; i < reports.size(); ++i) {
        if (i) out += ",";
        out += report_to_json(reports[i]);
    }
    out += "]";

    if (push_json("job", job) < 0) return 500;
    if (push_json("reports", out) < 0) return 500;
    return 0;
}

// ---------------------------------------------------------------------------
// deconflict: job + reports -> size-prefixed $TBS stream + run summary.
// ---------------------------------------------------------------------------
int deconflict(void) {
    const std::string job = input_text("job", 0);
    const std::string reports_json = input_text("reports", 0);

    const int8_t method = static_cast<int8_t>(json_number(job, "method", MM_HIGHEST_SAMPLE_COUNT));
    const long limit = static_cast<long>(json_number(job, "limit", 2000));
    const std::vector<std::string> consulted_ids = json_string_array(job, "providers_consulted");
    const size_t consulted = consulted_ids.size();

    std::vector<Report> reports;
    for (const std::string& obj : split_json_objects(reports_json)) {
        reports.push_back(report_from_json(obj));
    }

    std::vector<std::vector<size_t>> groups;
    if (method == MM_SINGLE_SOURCE) {
        for (size_t i = 0; i < reports.size(); ++i) groups.push_back({i});
    } else {
        groups = group_reports(reports);
    }

    const std::string stamp = iso_now();
    std::vector<uint8_t> stream;
    size_t multi = 0;
    size_t written = 0;
    for (const std::vector<size_t>& group : groups) {
        if (limit > 0 && static_cast<long>(written) >= limit) break;
        const size_t win = select_winner(reports, group, method);
        const double spread = position_spread(reports, group);
        std::set<std::string> agreeing;
        for (size_t i : group) agreeing.insert(reports[i].provider_id);
        if (agreeing.size() > 1) ++multi;

        double lat = reports[win].latitude, lon = reports[win].longitude;
        if (method == MM_CENTROID) {
            lat = 0; lon = 0;
            for (size_t i : group) { lat += reports[i].latitude; lon += reports[i].longitude; }
            lat /= static_cast<double>(group.size());
            lon /= static_cast<double>(group.size());
        }
        const double confidence = confidence_of(reports, group, consulted, spread);
        std::vector<uint8_t> record;
        build_tbs_record(reports, group, win, method, lat, lon, spread,
                         static_cast<uint32_t>(consulted), static_cast<uint32_t>(agreeing.size()),
                         confidence, stamp, &record);
        const uint32_t len = static_cast<uint32_t>(record.size());
        stream.push_back(static_cast<uint8_t>(len & 0xff));
        stream.push_back(static_cast<uint8_t>((len >> 8) & 0xff));
        stream.push_back(static_cast<uint8_t>((len >> 16) & 0xff));
        stream.push_back(static_cast<uint8_t>((len >> 24) & 0xff));
        stream.insert(stream.end(), record.begin(), record.end());
        ++written;
    }

    const std::string summary =
        std::string("{\"reportsIn\":") + std::to_string(reports.size()) +
        ",\"sitesOut\":" + std::to_string(written) +
        ",\"collapsed\":" + std::to_string(reports.size() > written ? reports.size() - written : 0) +
        ",\"multiProviderSites\":" + std::to_string(multi) +
        ",\"providersConsulted\":" + std::to_string(consulted) +
        ",\"method\":\"" + json_escape(json_string(job, "method_name", "")) + "\"" +
        ",\"skipped\":" + json_string(job, "skipped", "[]") + "}";

    if (push_tbs_stream("records", stream) < 0) return 500;
    if (push_json("summary", summary) < 0) return 500;
    return 0;
}

}  // extern "C"
