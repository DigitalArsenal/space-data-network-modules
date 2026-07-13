/*
 * Intelsat (public ephemeris) data-source module (A2.2c-2, Tier-1 adapter).
 *
 * On a TIMERS-driven `pull` this:
 *   1. GETs the public MyIntelsat ephemeris listing page
 *      (my.intelsat.com/ephemeris/public — unauthenticated HTML; the file
 *      dropdowns' <option value="..."> are the bare ephemeris filenames),
 *   2. selects the NEWEST ECF file for the configured satellite,
 *   3. GETs that ECF file from /Resource/Ephemeris/<name>.txt,
 *   4. parses the ECF position table,
 *   5. re-emits a schema-exact SDS OEM record with the frame PRESERVED AS
 *      DECLARED (Intelsat "ECF" = Earth-Centered-Fixed / ECEF — the OD side owns
 *      the ECEF->TEME transform per A2.2a), stores it, signs its content id, and
 *      publishes a schema-exact PNM pointer.
 *
 * ─── HONEST FORMAT NOTES ────────────────────────────────────────────────────
 * Intelsat publishes TWO product families under CelesTrak's "Intelsat-11P":
 *   (a) ECF files (category token "_e_") — a TRUE state-vector table, but
 *       POSITION ONLY (X,Y,Z metres, ECF; no velocity columns). This adapter
 *       ingests THIS product as the canonical OEM.
 *   (b) 11-Parameter Weekly/Maneuver files (category tokens "_w_"/"_x_"/"_m_") —
 *       a telex-wrapped geostationary longitude/latitude drift-and-libration
 *       model (LM0/LM1/LM2, LONC.., LATC..), NOT a Cartesian state vector.
 *       Converting the 11-parameter model to a state vector is a physical
 *       propagation (an OD-owned transform, per A2.2a) and is NOT done here —
 *       fabricating state vectors from it would violate the never-fabricate rule.
 *       (These files + the Center-of-Box event logs are documented in the README
 *       as related products / residuals.)
 * Per the A2.2a ethos this adapter does NOT synthesize velocity by differencing
 * the ECF positions — it emits a position-only OEM (STATE_VECTOR_SIZE = 3,
 * EPHEMERIS_DATA_LINES carry EPOCH + X/Y/Z only). Positions are normalised
 * metres -> kilometres (the CCSDS OEM canonical unit; a lossless scale, NOT a
 * frame transform); the source unit is recorded in provenance.
 *
 * IDENTITY (honest): the ECF file carries NO NORAD Catalog Number and NO
 * international designator — only the operator short name (e.g. "IS-21"). Neither
 * is fabricated: OBJECT_NAME is the real name from the header; NORAD_CAT_ID = 0
 * and OBJECT_ID = "" (a name->NORAD registry mapping is a documented A2.4
 * residual, NOT inlined here).
 *
 * The fetch/hash/store/sign/publish skeleton lives in the shared
 * common/provider_source.hpp; only the Intelsat discovery + ECF parse + OEM
 * mapping stay here.
 *
 * Hostcall ABI (space_data_module_host): see common/sdm_hostcall_wire.hpp.
 */
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string>
#include <vector>

#include "provider_source.hpp"

namespace ps = provider_source;

// ── Provider constants ──────────────────────────────────────────────────────

// MyIntelsat public ephemeris listing page (unauthenticated HTML).
static const char* kDefaultListingURL = "https://my.intelsat.com/ephemeris/public";
// Ephemeris file directory; the fetched file is <base><filename>.txt.
static const char* kDefaultEphemerisBase = "https://my.intelsat.com/Resource/Ephemeris/";
// Default target satellite short name (the "_<sat>_" filename field).
static const char* kDefaultTarget = "is-21";
// ECF category filename token (the honest state-vector product family).
static const char* kEcfCategoryMarker = "_e_";

static const char* kSigningKeySlot = "node-signing";
static const char* kPublishTopic = "sdn/data-source/intelsat";

extern "C" {
// Guest allocator used by the host to pass request/response buffers.
__attribute__((visibility("default")))
uint8_t* plugin_alloc(uint32_t size) { return static_cast<uint8_t*>(malloc(size)); }
__attribute__((visibility("default")))
void plugin_free(uint8_t* ptr, uint32_t /*size*/) { free(ptr); }
}  // extern "C"

namespace {

std::string trim(const std::string& in) {
    size_t a = in.find_first_not_of(" \t\r\n");
    size_t b = in.find_last_not_of(" \t\r\n");
    if (a == std::string::npos) return std::string();
    return in.substr(a, b - a + 1);
}

std::vector<std::string> split_ws(const std::string& line) {
    std::vector<std::string> toks;
    size_t i = 0;
    while (i < line.size()) {
        while (i < line.size() && (line[i] == ' ' || line[i] == '\t' || line[i] == '\r')) i++;
        size_t j = i;
        while (j < line.size() && line[j] != ' ' && line[j] != '\t' && line[j] != '\r') j++;
        if (j > i) toks.push_back(line.substr(i, j - i));
        i = j;
    }
    return toks;
}

// An ECF data row's first token is a date "YYYY/MM/DD"; the second is a time
// "HH:MM:SS.sss". Distinguishes data rows from the header/units lines.
bool is_ecf_date(const std::string& t) {
    if (t.size() < 10) return false;
    if (t[4] != '/' || t[7] != '/') return false;
    for (int i : {0, 1, 2, 3, 5, 6, 8, 9}) if (t[i] < '0' || t[i] > '9') return false;
    return true;
}

// "2026/07/10" + "23:53:00.000" -> ISO 8601 UTC "2026-07-10T23:53:00.000Z".
std::string ecf_epoch_to_iso(const std::string& date, const std::string& time) {
    std::string s = date;
    for (char& c : s) if (c == '/') c = '-';
    s.push_back('T');
    s += time;
    s.push_back('Z');
    return s;
}

struct EcfRow {
    std::string epoch;              // ISO 8601 UTC
    double x_m = 0, y_m = 0, z_m = 0;  // metres, ECF (Earth-Centered-Fixed)
};

struct EcfDoc {
    std::string object_name;        // e.g. "IS-21" (from header, real)
    std::string header_raw;         // line 1 verbatim (provenance)
    std::vector<EcfRow> rows;
};

// Extract the operator name from the ECF header line
// "ECF Ephemeris for Intelsat IS-21 / 302.00 deg E / ...": the token after
// "Intelsat " up to the next space.
std::string parse_object_name(const std::string& header) {
    const std::string key = "Intelsat ";
    size_t k = header.find(key);
    if (k == std::string::npos) return std::string();
    size_t start = k + key.size();
    size_t end = start;
    while (end < header.size() && header[end] != ' ' && header[end] != '\t' && header[end] != '\r') end++;
    return header.substr(start, end - start);
}

// Parse the Intelsat ECF file: header line 1 + the position table. Non-data
// lines (units/column headers/blank) are skipped; the raw bytes are bound by
// SHA-256 in provenance.
void parse_ecf(const std::string& content, EcfDoc* doc) {
    size_t pos = 0;
    bool first_line = true;
    std::string line;
    while (pos <= content.size()) {
        size_t nl = content.find('\n', pos);
        line = content.substr(pos, (nl == std::string::npos ? content.size() : nl) - pos);
        pos = (nl == std::string::npos) ? content.size() + 1 : nl + 1;
        if (first_line) {
            doc->header_raw = trim(line);
            doc->object_name = parse_object_name(doc->header_raw);
            first_line = false;
            continue;
        }
        std::vector<std::string> t = split_ws(line);
        if (t.size() >= 5 && is_ecf_date(t[0])) {
            EcfRow r;
            r.epoch = ecf_epoch_to_iso(t[0], t[1]);
            r.x_m = strtod(t[2].c_str(), nullptr);
            r.y_m = strtod(t[3].c_str(), nullptr);
            r.z_m = strtod(t[4].c_str(), nullptr);
            doc->rows.push_back(r);
        }
    }
}

// Build the canonical SDS OEM record (verbose, POSITION-ONLY, km) from the ECF
// table. REFERENCE_FRAME is the declared Earth-fixed frame (ECEF); the OD side
// owns the ECEF->TEME transform (A2.2a). STATE_VECTOR_SIZE = 3 (ECF carries no
// velocity — none is fabricated). Positions metres->km (CCSDS OEM unit).
std::string build_oem_record(const EcfDoc& doc, const std::string& object_name) {
    std::string s;
    s.reserve(doc.rows.size() * 110 + 640);
    const std::string start_time = doc.rows.empty() ? std::string() : doc.rows.front().epoch;
    const std::string stop_time = doc.rows.empty() ? std::string() : doc.rows.back().epoch;
    s += "{";
    s += "\"CCSDS_OEM_VERS\":2.0,";
    s += "\"CREATION_DATE\":\"" + ps::json_escape(start_time) + "\",";
    s += "\"ORIGINATOR\":\"Intelsat\",";
    s += "\"CLASSIFICATION\":\"UNCLASSIFIED\",";
    s += "\"EPHEMERIS_DATA_BLOCK\":[{";
    s += "\"COMMENT\":\"Intelsat public ECF ephemeris (position-only); frame preserved AS "
         "DECLARED (Intelsat 'ECF' = Earth-Centered-Fixed / ECEF). Positions metres->km; NO "
         "velocity (ECF carries none; none fabricated). No NORAD/COSPAR in source. OD owns "
         "the frame transform.\",";
    s += "\"OBJECT_NAME\":\"" + ps::json_escape(object_name) + "\",";
    s += "\"OBJECT_ID\":\"\",";     // ECF carries no international designator (not fabricated)
    s += "\"NORAD_CAT_ID\":0,";     // ECF carries no NORAD id (not fabricated)
    s += "\"CENTER_NAME\":\"EARTH\",";
    s += "\"REFERENCE_FRAME\":\"ECEF\",";  // declared Earth-fixed frame (Intelsat "ECF")
    s += "\"TIME_SYSTEM\":\"UTC\",";
    s += "\"START_TIME\":\"" + ps::json_escape(start_time) + "\",";
    s += "\"STOP_TIME\":\"" + ps::json_escape(stop_time) + "\",";
    s += "\"STEP_SIZE\":0,";        // verbose / explicit-epoch (no declared step in ECF header)
    s += "\"STATE_VECTOR_SIZE\":3,";  // position-only (honest; no velocity in ECF)
    s += "\"EPHEMERIS_DATA_LINES\":[";
    for (size_t i = 0; i < doc.rows.size(); ++i) {
        const EcfRow& r = doc.rows[i];
        if (i) s += ",";
        s += "{\"EPOCH\":\"" + ps::json_escape(r.epoch) + "\",";
        s += "\"X\":" + ps::double_to_json(r.x_m / 1000.0) + ",";
        s += "\"Y\":" + ps::double_to_json(r.y_m / 1000.0) + ",";
        s += "\"Z\":" + ps::double_to_json(r.z_m / 1000.0) + "}";
    }
    s += "]}]}";
    return s;
}

// ── Intelsat listing discovery ──────────────────────────────────────────────
// Extract ECF filenames for the target satellite from the listing page. A
// filename token is bounded by any of " \t\r\n\"'<>=/" (filenames themselves use
// [a-z0-9._-]). A candidate must contain BOTH the sat marker ("_<sat>_") and the
// ECF category marker ("_e_"). The NEWEST is the lexically-max filename (the
// embedded YYYYMMDD_HHMMSS sorts chronologically).
bool is_fn_delim(char c) {
    return c == ' ' || c == '\t' || c == '\r' || c == '\n' ||
           c == '"' || c == '\'' || c == '<' || c == '>' || c == '=' || c == '/';
}

std::string select_newest_ecf(const std::vector<uint8_t>& listing,
                              const std::string& sat_marker, const std::string& cat_marker) {
    std::string s(listing.begin(), listing.end());
    std::string newest;
    size_t from = 0;
    while (true) {
        size_t k = s.find(sat_marker, from);
        if (k == std::string::npos) break;
        size_t a = k;
        while (a > 0 && !is_fn_delim(s[a - 1])) a--;
        size_t b = k + sat_marker.size();
        while (b < s.size() && !is_fn_delim(s[b])) b++;
        std::string fn = s.substr(a, b - a);
        // strip a trailing ".txt" if the page happened to include the extension
        if (fn.size() > 4 && fn.compare(fn.size() - 4, 4, ".txt") == 0)
            fn = fn.substr(0, fn.size() - 4);
        // require the ECF category token and structural sanity
        if (fn.find(cat_marker) != std::string::npos && fn.find(sat_marker) != std::string::npos) {
            if (fn > newest) newest = fn;
        }
        from = k + sat_marker.size();
    }
    return newest;
}

// Split "i_aor_e_302.00_is-21_20260710_235300" into its 7 underscore fields:
// [owner, region, category, longitude, sat, yyyymmdd, hhmmss]. sat itself uses a
// hyphen (no underscore), and longitude uses a dot, so a plain '_' split is safe.
std::vector<std::string> split_filename_fields(const std::string& fn) {
    std::vector<std::string> out;
    size_t start = 0;
    while (start <= fn.size()) {
        size_t us = fn.find('_', start);
        out.push_back(fn.substr(start, (us == std::string::npos ? fn.size() : us) - start));
        if (us == std::string::npos) break;
        start = us + 1;
    }
    return out;
}

// ── Config (optional, from the invoke request payload) ───────────────────────

struct PullConfig {
    std::string listing_url = kDefaultListingURL;
    std::string ephemeris_base = kDefaultEphemerisBase;
    std::string target = kDefaultTarget;
};

PullConfig parse_config(const uint8_t* req, uint32_t len) {
    PullConfig c;
    if (req == nullptr || len == 0) return c;
    size_t i = 0;
    while (i < len && (req[i] == ' ' || req[i] == '\n' || req[i] == '\t' || req[i] == '\r')) i++;
    if (i >= len || req[i] != '{') return c;  // binary PIV request leaves defaults intact
    std::string json(reinterpret_cast<const char*>(req), len);
    std::string v;
    if (ps::json_string_field(json, "listingUrl", &v) && !v.empty()) c.listing_url = v;
    if (ps::json_string_field(json, "ephemerisBase", &v) && !v.empty()) c.ephemeris_base = v;
    if (ps::json_string_field(json, "target", &v) && !v.empty()) c.target = v;
    return c;
}

std::string join_url(const std::string& base, const std::string& file) {
    if (!base.empty() && base.back() == '/') return base + file;
    return base + "/" + file;
}

// ── The pull method ──────────────────────────────────────────────────────────

std::string run_pull(const uint8_t* req, uint32_t req_len) {
    PullConfig cfg = parse_config(req, req_len);

    ps::ProviderConfig pcfg;
    pcfg.signing_slot = kSigningKeySlot;
    pcfg.publish_topic = kPublishTopic;
    pcfg.signature_type = "ed25519";   // must match the node-signing slot's key
    pcfg.source_name = "intelsat";
    pcfg.data_source = "Intelsat-11P";  // CelesTrak-comparable SOURCE token (A2.1)
    pcfg.record_schema = "OEM";         // honest canonical SDS type (ephemeris)

    std::string sat_marker = "_" + cfg.target + "_";

    // 1) discover the newest ECF file for the target satellite.
    ps::HttpResult listing = ps::http_get(cfg.listing_url);
    std::string filename;
    if (listing.status == 200 && !listing.body.empty())
        filename = select_newest_ecf(listing.body, sat_marker, kEcfCategoryMarker);

    long fetched = 0, stored = 0, signed_ = 0, published = 0, row_count = 0;
    long ecf_status = 0;
    std::string object_name;
    std::vector<std::string> fields;

    if (!filename.empty()) {
        fields = split_filename_fields(filename);
        std::string file_url = join_url(cfg.ephemeris_base, filename + ".txt");
        ps::HttpResult ecf = ps::http_get(file_url);
        ecf_status = ecf.status;
        if (ecf.status == 200 && !ecf.body.empty()) {
            fetched = 1;
            EcfDoc doc;
            std::string content(ecf.body.begin(), ecf.body.end());
            parse_ecf(content, &doc);
            row_count = static_cast<long>(doc.rows.size());

            // Prefer the header's operator name; fall back to the filename sat field.
            object_name = !doc.object_name.empty() ? doc.object_name
                        : (fields.size() >= 5 ? fields[4] : cfg.target);

            if (!doc.rows.empty()) {
                std::string source_sha256 = ps::sha256_hex(ecf.body.data(), ecf.body.size());
                std::string oem = build_oem_record(doc, object_name);

                std::string sat_field = fields.size() >= 5 ? fields[4] : cfg.target;
                std::string region = fields.size() >= 2 ? fields[1] : std::string();
                std::string longitude = fields.size() >= 4 ? fields[3] : std::string();
                const std::string& start_time = doc.rows.front().epoch;
                const std::string& stop_time = doc.rows.back().epoch;

                std::string file_id = pcfg.source_name + ":" + pcfg.record_schema + ":" +
                                      sat_field + ":" + start_time;
                std::string provenance =
                    std::string("{\"SOURCE_NAME\":\"") + ps::json_escape(pcfg.source_name) + "\"," +
                    "\"SOURCE_URL\":\"" + ps::json_escape(file_url) + "\"," +
                    "\"SOURCE_SHA256\":\"" + source_sha256 + "\"," +
                    "\"DATA_SOURCE\":\"" + ps::json_escape(pcfg.data_source) + "\"," +
                    "\"RECORD_SCHEMA\":\"" + ps::json_escape(pcfg.record_schema) + "\"," +
                    "\"NORAD_CAT_ID\":0," +
                    "\"OBJECT_ID\":\"\"," +
                    "\"OBJECT_NAME\":\"" + ps::json_escape(object_name) + "\"," +
                    "\"INTELSAT_SAT\":\"" + ps::json_escape(sat_field) + "\"," +
                    "\"INTELSAT_REGION\":\"" + ps::json_escape(region) + "\"," +
                    "\"INTELSAT_LONGITUDE_DEG_E\":\"" + ps::json_escape(longitude) + "\"," +
                    "\"INTELSAT_HEADER\":\"" + ps::json_escape(doc.header_raw) + "\"," +
                    "\"REFERENCE_FRAME\":\"ECEF\"," +
                    "\"SOURCE_UNITS\":\"m\"," +
                    "\"RECORD_UNITS\":\"km\"," +
                    "\"HAS_VELOCITY\":false," +
                    "\"START_TIME\":\"" + ps::json_escape(start_time) + "\"," +
                    "\"STOP_TIME\":\"" + ps::json_escape(stop_time) + "\"," +
                    "\"ROW_COUNT\":" + std::to_string(doc.rows.size()) + "," +
                    "\"PRODUCT_KIND\":\"ephemeris\"}";

                ps::PublishResult r = ps::publish_record_with_source(
                    pcfg,
                    reinterpret_cast<const uint8_t*>(oem.data()), oem.size(),
                    filename + ".txt", file_id, start_time, provenance,
                    file_url, source_sha256);
                if (r.stored) stored++;
                if (r.signed_) signed_++;
                if (r.published) published++;
            }
        }
    }

    std::string out = std::string("{\"ok\":true,\"source\":\"") + pcfg.source_name + "\",";
    out += "\"listing_status\":" + std::to_string(listing.status) + ",";
    out += "\"selected_file\":\"" + ps::json_escape(filename) + "\",";
    out += "\"ecf_status\":" + std::to_string(ecf_status) + ",";
    out += "\"record_schema\":\"" + pcfg.record_schema + "\",";
    out += "\"reference_frame\":\"ECEF\",";
    out += "\"object_name\":\"" + ps::json_escape(object_name) + "\",";
    out += "\"row_count\":" + std::to_string(row_count) + ",";
    out += "\"fetched\":" + std::to_string(fetched) + ",";
    out += "\"stored\":" + std::to_string(stored) + ",";
    out += "\"signed\":" + std::to_string(signed_) + ",";
    out += "\"published\":" + std::to_string(published) + "}";
    return out;
}

}  // namespace

extern "C" {

// Canonical streaming invoke entrypoint. The TIMERS `pull` entry (and any manual
// invoke) triggers a discover+fetch+parse+store+sign+publish cycle for the
// newest Intelsat ECF ephemeris of the configured satellite.
__attribute__((visibility("default")))
uint8_t* plugin_invoke_stream(const uint8_t* req_ptr, uint32_t req_len, uint32_t* out_len_ptr) {
    std::string result = run_pull(req_ptr, req_len);
    uint8_t* out = static_cast<uint8_t*>(malloc(result.size()));
    if (out != nullptr) {
        for (size_t i = 0; i < result.size(); i++) out[i] = static_cast<uint8_t>(result[i]);
    }
    if (out_len_ptr != nullptr) *out_len_ptr = static_cast<uint32_t>(result.size());
    return out;
}

}  // extern "C"
