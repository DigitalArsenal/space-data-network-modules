/*
 * CelesTrak SupGP (multi-provider supplemental OMM) data-source module (A2.9).
 *
 * OWNER DIRECTIVE ("we should have more providers than this"): grow the catalog's
 * honest coverage for the A2.1 providers whose RAW operator ephemeris is NOT
 * public, by ingesting CelesTrak's PUBLISHED Supplemental GP (SupGP) OMM sets.
 *
 * ─── WHAT THIS IS (and just as importantly, what it is NOT) ──────────────────
 * ONE generic, token-parameterized adapter driven by a data-driven SOURCE-token
 * registry (below, overridable at invoke). On a TIMERS-driven `pull` it iterates
 * the registry and, per token, issues ONE query to
 *   https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?SOURCE=<token>&FORMAT=JSON
 * (CSV fallback), parses the CCSDS OMM set, and re-emits EACH object as a
 * schema-exact SDS **OMM** record, stored with a per-provider SourceName, signed,
 * and published as a PNM pointer — on the shared provider template
 * (common/provider_source.hpp).
 *
 * HONESTY MODEL (critical). These OMMs are CELESTRAK-FITTED mean elements, NOT
 * our OD and NOT the operator's raw product. Every record is marked
 * NON-INDEPENDENT so catalog synthesis and the status board keep them in their
 * own lane and they NEVER count as "our OD":
 *   - SourceTags.SourceName = the provider registry token (ses / planet / iridium
 *     / telesat / kuiper / ast-spacemobile / css) — distinct per provider, and
 *     distinct from every Tier-1 adapter's SourceName (so we do NOT duplicate
 *     the operator-raw or our-fit lanes).
 *   - USER_DEFINED_SDN_DATA_SOURCE = "CelesTrak SupGP".
 *   - USER_DEFINED_SDN_INDEPENDENT = "false"  (the NON-INDEPENDENT flag).
 *   - a CCSDS COMMENT array states the same in prose.
 *   - CelesTrak's own fit residual (RMS) + DATA_SOURCE token are preserved in
 *     USER_DEFINED_SDN_CELESTRAK_RMS / _CELESTRAK_DATA_SOURCE (they are NOT part
 *     of the canonical SDS OMM schema, so they live under USER_DEFINED, not as
 *     bare record fields).
 * SYNTHESIS CONFIG (data, not code — owned by analysis/catalog-synthesis): each
 * SourceName must be listed in config/provider-gate-status.json at a NON-hard-pass
 * level so it is published but NEVER outranks Space-Track GP. See README.
 *
 * FRAME/TIME. SupGP OMMs are SGP4 mean elements by construction (EPHEMERIS_TYPE 0)
 * — i.e. TEME / UTC / EARTH, MEAN_ELEMENT_THEORY = SGP4. We declare those
 * explicitly (they are honest for any SGP4 GP record) rather than leaving them
 * implicit; element VALUES are copied faithfully to full double precision.
 *
 * POLITENESS (analysis/conjunction-assessment/scripts/CELESTRAK_FETCH_POLICY.md
 * semantics): one token = one query per cycle; default cadence 2h (SupGP refreshes
 * every 2h — "no need to check more often"); the registry is de-duplicated so a
 * token is never re-fetched within a cycle; and the cycle HALTS on any non-200
 * (CelesTrak's M2M rule) — tokens already processed keep their records, remaining
 * tokens are not queried.
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

static const char* kSigningKeySlot = "node-signing";
// Default CelesTrak SupGP endpoint (the docs page is the token authority:
// celestrak.org/NORAD/documentation/sup-gp-queries.php).
static const char* kDefaultBaseUrl =
    "https://celestrak.org/NORAD/elements/supplemental/sup-gp.php";

// Per-token blast-radius cap (D4/A2.6): emit at most this many objects per token
// per cycle. Default covers the largest current set (Kuiper-E ~393) with headroom;
// overridable down at invoke for tests / churn control.
static const long kDefaultObjectCap = 2000;

// ── Data-driven SOURCE-token registry ───────────────────────────────────────
// {CelesTrak SOURCE token, provider SourceName, cadence(ms)}. The SourceName is
// the fit-pipeline grouping key == PNM topic suffix == the key catalog-synthesis
// classifies on == the key to add to provider-gate-status.json. Cadence is
// metadata (all SupGP sets refresh on CelesTrak's uniform 2h cycle, so the single
// 2h pull timer is correct); it is recorded here so a future per-token scheduler
// can differentiate without touching this table's meaning.
//
// Ground truth: all seven verified LIVE via the read-only host proxy on
// 2026-07-13 (sup-gp.php?SOURCE=<token>&FORMAT=JSON → HTTP 200, schema-exact OMM
// JSON). See README + test/fixtures/PROVENANCE.md for the probe log.
struct RegistryEntry {
    const char* token;        // CelesTrak SOURCE token
    const char* source_name;  // SDN provider SourceName (distinct per provider)
    long cadence_ms;          // metadata (uniform 2h SupGP refresh)
};

static const RegistryEntry kRegistry[] = {
    {"SES-E",    "ses",             7200000},
    {"Planet",   "planet",          7200000},
    {"Iridium",  "iridium",         7200000},
    {"Telesat",  "telesat",         7200000},
    {"Kuiper-E", "kuiper",          7200000},
    {"AST",      "ast-spacemobile", 7200000},
    {"CSS-E",    "css",             7200000},
};
static const size_t kRegistryCount = sizeof(kRegistry) / sizeof(kRegistry[0]);

extern "C" {
__attribute__((visibility("default")))
uint8_t* plugin_alloc(uint32_t size) { return static_cast<uint8_t*>(malloc(size)); }
__attribute__((visibility("default")))
void plugin_free(uint8_t* ptr, uint32_t /*size*/) { free(ptr); }
}  // extern "C"

namespace {

// ── Small local helpers (do NOT modify common/) ──────────────────────────────

std::string trim(const std::string& in) {
    size_t a = in.find_first_not_of(" \t\r\n");
    size_t b = in.find_last_not_of(" \t\r\n");
    if (a == std::string::npos) return std::string();
    return in.substr(a, b - a + 1);
}

std::string to_lower(const std::string& in) {
    std::string s = in;
    for (char& c : s) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    return s;
}

// Double-valued "key": <number> extractor within ONE flat JSON object (provider_
// source.hpp only ships a long-valued json_number_field). Finds the first match
// of key in `obj` and parses the value with strtod (handles leading-dot and
// scientific notation, e.g. .0002684 / 1.1466e-6).
double json_double_field(const std::string& obj, const std::string& key, double fallback) {
    std::string needle = "\"" + key + "\"";
    size_t k = obj.find(needle);
    if (k == std::string::npos) return fallback;
    size_t colon = obj.find(':', k + needle.size());
    if (colon == std::string::npos) return fallback;
    return strtod(obj.c_str() + colon + 1, nullptr);
}

// Split a flat JSON array "[{...},{...}]" into per-object substrings "{...}".
// SupGP OMM objects are flat (no nested braces), but this is string-/escape-aware
// so a brace inside a string value can never mis-split.
std::vector<std::string> split_json_objects(const std::string& s) {
    std::vector<std::string> objs;
    int depth = 0;
    bool instr = false, esc = false;
    size_t start = std::string::npos;
    for (size_t i = 0; i < s.size(); ++i) {
        char c = s[i];
        if (instr) {
            if (esc) esc = false;
            else if (c == '\\') esc = true;
            else if (c == '"') instr = false;
            continue;
        }
        if (c == '"') { instr = true; continue; }
        if (c == '{') { if (depth == 0) start = i; depth++; }
        else if (c == '}') {
            if (depth > 0) {
                depth--;
                if (depth == 0 && start != std::string::npos) {
                    objs.push_back(s.substr(start, i - start + 1));
                    start = std::string::npos;
                }
            }
        }
    }
    return objs;
}

std::vector<std::string> split_char(const std::string& s, char sep) {
    std::vector<std::string> out;
    size_t start = 0;
    for (size_t i = 0; i <= s.size(); ++i) {
        if (i == s.size() || s[i] == sep) {
            out.push_back(s.substr(start, i - start));
            start = i + 1;
        }
    }
    return out;
}

// ── One parsed SupGP OMM object (canonical GP fields + SupGP extras) ──────────

struct Omm {
    std::string object_name;
    std::string object_id;
    std::string epoch;
    std::string classification_type;   // usually "C"
    std::string rms;                    // CelesTrak fit residual (string in the feed)
    std::string data_source;            // CelesTrak DATA_SOURCE token (e.g. SES-E, AST-E)
    double mean_motion = 0, eccentricity = 0, inclination = 0;
    double raan = 0, argp = 0, mean_anomaly = 0;
    double bstar = 0, mm_dot = 0, mm_ddot = 0;
    long ephemeris_type = 0, norad_cat_id = 0, element_set_no = 0, rev_at_epoch = 0;
    bool valid = false;
};

// Parse one flat JSON OMM object substring into an Omm.
Omm parse_json_object(const std::string& obj) {
    Omm o;
    ps::json_string_field(obj, "OBJECT_NAME", &o.object_name);
    ps::json_string_field(obj, "OBJECT_ID", &o.object_id);
    ps::json_string_field(obj, "EPOCH", &o.epoch);
    ps::json_string_field(obj, "CLASSIFICATION_TYPE", &o.classification_type);
    ps::json_string_field(obj, "RMS", &o.rms);            // quoted string in the feed
    ps::json_string_field(obj, "DATA_SOURCE", &o.data_source);
    o.mean_motion = json_double_field(obj, "MEAN_MOTION", 0);
    o.eccentricity = json_double_field(obj, "ECCENTRICITY", 0);
    o.inclination = json_double_field(obj, "INCLINATION", 0);
    o.raan = json_double_field(obj, "RA_OF_ASC_NODE", 0);
    o.argp = json_double_field(obj, "ARG_OF_PERICENTER", 0);
    o.mean_anomaly = json_double_field(obj, "MEAN_ANOMALY", 0);
    o.bstar = json_double_field(obj, "BSTAR", 0);
    o.mm_dot = json_double_field(obj, "MEAN_MOTION_DOT", 0);
    o.mm_ddot = json_double_field(obj, "MEAN_MOTION_DDOT", 0);
    o.ephemeris_type = ps::json_number_field(obj, "EPHEMERIS_TYPE", 0);
    o.norad_cat_id = ps::json_number_field(obj, "NORAD_CAT_ID", 0);
    o.element_set_no = ps::json_number_field(obj, "ELEMENT_SET_NO", 0);
    o.rev_at_epoch = ps::json_number_field(obj, "REV_AT_EPOCH", 0);
    // Valid iff it carries the load-bearing GP fields (a real object, not a stray).
    o.valid = (!o.epoch.empty() && o.mean_motion > 0.0 && !o.object_name.empty());
    return o;
}

// Parse a CelesTrak SupGP CSV (header + rows; same columns as JSON, RMS/DATA_SOURCE
// trailing). SupGP CSV fields contain no embedded commas, so a naive comma split is
// correct. Column order is taken from the header (not assumed positional).
std::vector<Omm> parse_csv(const std::string& body) {
    std::vector<Omm> out;
    std::vector<std::string> lines = split_char(body, '\n');
    // First non-empty line is the header.
    size_t hdr_idx = 0;
    while (hdr_idx < lines.size() && trim(lines[hdr_idx]).empty()) hdr_idx++;
    if (hdr_idx >= lines.size()) return out;
    std::vector<std::string> header = split_char(trim(lines[hdr_idx]), ',');
    auto col = [&](const char* name) -> int {
        for (size_t i = 0; i < header.size(); ++i) if (trim(header[i]) == name) return static_cast<int>(i);
        return -1;
    };
    int c_name = col("OBJECT_NAME"), c_id = col("OBJECT_ID"), c_epoch = col("EPOCH");
    int c_mm = col("MEAN_MOTION"), c_ecc = col("ECCENTRICITY"), c_incl = col("INCLINATION");
    int c_raan = col("RA_OF_ASC_NODE"), c_argp = col("ARG_OF_PERICENTER"), c_ma = col("MEAN_ANOMALY");
    int c_et = col("EPHEMERIS_TYPE"), c_ct = col("CLASSIFICATION_TYPE"), c_norad = col("NORAD_CAT_ID");
    int c_esn = col("ELEMENT_SET_NO"), c_rev = col("REV_AT_EPOCH"), c_bstar = col("BSTAR");
    int c_mmd = col("MEAN_MOTION_DOT"), c_mmdd = col("MEAN_MOTION_DDOT");
    int c_rms = col("RMS"), c_ds = col("DATA_SOURCE");
    for (size_t li = hdr_idx + 1; li < lines.size(); ++li) {
        std::string line = trim(lines[li]);
        if (line.empty()) continue;
        std::vector<std::string> f = split_char(line, ',');
        auto sv = [&](int i) -> std::string { return (i >= 0 && i < static_cast<int>(f.size())) ? trim(f[i]) : std::string(); };
        auto dv = [&](int i) -> double { std::string s = sv(i); return s.empty() ? 0.0 : strtod(s.c_str(), nullptr); };
        auto lv = [&](int i) -> long { std::string s = sv(i); return s.empty() ? 0 : strtol(s.c_str(), nullptr, 10); };
        Omm o;
        o.object_name = sv(c_name);
        o.object_id = sv(c_id);
        o.epoch = sv(c_epoch);
        o.classification_type = sv(c_ct);
        o.rms = sv(c_rms);
        o.data_source = sv(c_ds);
        o.mean_motion = dv(c_mm);
        o.eccentricity = dv(c_ecc);
        o.inclination = dv(c_incl);
        o.raan = dv(c_raan);
        o.argp = dv(c_argp);
        o.mean_anomaly = dv(c_ma);
        o.bstar = dv(c_bstar);
        o.mm_dot = dv(c_mmd);
        o.mm_ddot = dv(c_mmdd);
        o.ephemeris_type = lv(c_et);
        o.norad_cat_id = lv(c_norad);
        o.element_set_no = lv(c_esn);
        o.rev_at_epoch = lv(c_rev);
        o.valid = (!o.epoch.empty() && o.mean_motion > 0.0 && !o.object_name.empty());
        out.push_back(o);
    }
    return out;
}

// Detect + parse a SupGP payload (JSON array or CSV) into OMM objects.
std::vector<Omm> parse_supgp(const std::string& body, const char** format_out) {
    std::string t = trim(body);
    if (!t.empty() && (t[0] == '[' || t[0] == '{')) {
        if (format_out) *format_out = "JSON";
        std::vector<Omm> out;
        for (const std::string& obj : split_json_objects(t)) out.push_back(parse_json_object(obj));
        return out;
    }
    if (format_out) *format_out = "CSV";
    return parse_csv(body);
}

// Build the schema-exact, honestly-labeled SDS OMM record for one SupGP object.
// Canonical GP/OMM keys are copied faithfully; the SupGP-specific RMS/DATA_SOURCE
// (NOT part of the SDS OMM schema) and the non-independence marking live under
// USER_DEFINED_*.
std::string build_omm_record(const Omm& o, const std::string& source_name) {
    std::string s;
    s.reserve(1400);
    s += "{";
    s += "\"CCSDS_OMM_VERS\":2.0,";
    s += "\"COMMENT\":[";
    s += "\"CelesTrak Supplemental GP (SupGP) OMM re-published by SDN — App 2 A2.9.\",";
    s += "\"NON-INDEPENDENT: these are CelesTrak-FITTED SGP4 mean elements, NOT an SDN OD solution and NOT the operator's raw ephemeris.\",";
    s += "\"data_source=CelesTrak SupGP; must never count as our OD; never outranks Space-Track GP in synthesis.\",";
    s += "\"SOURCE_NAME=" + ps::json_escape(source_name) +
         " CELESTRAK_DATA_SOURCE=" + ps::json_escape(o.data_source) +
         " CELESTRAK_RMS=" + ps::json_escape(o.rms) + "\"";
    s += "],";
    s += "\"OBJECT_NAME\":\"" + ps::json_escape(o.object_name) + "\",";
    s += "\"OBJECT_ID\":\"" + ps::json_escape(o.object_id) + "\",";
    s += "\"CENTER_NAME\":\"EARTH\",";
    s += "\"REFERENCE_FRAME\":\"TEME\",";       // SGP4 GP records are TEME by construction
    s += "\"TIME_SYSTEM\":\"UTC\",";
    s += "\"MEAN_ELEMENT_THEORY\":\"SGP4\",";
    s += "\"EPOCH\":\"" + ps::json_escape(o.epoch) + "\",";
    s += "\"MEAN_MOTION\":" + ps::double_to_json(o.mean_motion) + ",";
    s += "\"ECCENTRICITY\":" + ps::double_to_json(o.eccentricity) + ",";
    s += "\"INCLINATION\":" + ps::double_to_json(o.inclination) + ",";
    s += "\"RA_OF_ASC_NODE\":" + ps::double_to_json(o.raan) + ",";
    s += "\"ARG_OF_PERICENTER\":" + ps::double_to_json(o.argp) + ",";
    s += "\"MEAN_ANOMALY\":" + ps::double_to_json(o.mean_anomaly) + ",";
    s += "\"EPHEMERIS_TYPE\":" + std::to_string(o.ephemeris_type) + ",";
    s += "\"CLASSIFICATION_TYPE\":\"" + ps::json_escape(o.classification_type) + "\",";
    s += "\"NORAD_CAT_ID\":" + std::to_string(o.norad_cat_id) + ",";
    s += "\"ELEMENT_SET_NO\":" + std::to_string(o.element_set_no) + ",";
    s += "\"REV_AT_EPOCH\":" + std::to_string(o.rev_at_epoch) + ",";
    s += "\"BSTAR\":" + ps::double_to_json(o.bstar) + ",";
    s += "\"MEAN_MOTION_DOT\":" + ps::double_to_json(o.mm_dot) + ",";
    s += "\"MEAN_MOTION_DDOT\":" + ps::double_to_json(o.mm_ddot) + ",";
    // Machine-readable lineage + honesty flags (flat USER_DEFINED_* convention;
    // catalog-synthesis reads USER_DEFINED_SDN_SOURCE_NAME as its fallback key).
    s += "\"USER_DEFINED_SDN_SOURCE_NAME\":\"" + ps::json_escape(source_name) + "\",";
    s += "\"USER_DEFINED_SDN_DATA_SOURCE\":\"CelesTrak SupGP\",";
    s += "\"USER_DEFINED_SDN_INDEPENDENT\":\"false\",";
    s += "\"USER_DEFINED_SDN_CELESTRAK_DATA_SOURCE\":\"" + ps::json_escape(o.data_source) + "\",";
    s += "\"USER_DEFINED_SDN_CELESTRAK_RMS\":\"" + ps::json_escape(o.rms) + "\"";
    s += "}";
    return s;
}

// ── Config (optional, from the invoke request payload) ───────────────────────
// Overrides at invoke:
//   {"token":"SES-E","sourceName":"ses"}  -> registry becomes JUST that one entry
//   {"format":"CSV"}                       -> fetch format for all tokens (JSON default)
//   {"baseUrl":"..."}                      -> override the sup-gp.php base
//   {"sourceUrl":"..."}                    -> full URL override (single-token only)
//   {"objectCap":N}                        -> per-token emit cap
struct PullConfig {
    std::string base_url = kDefaultBaseUrl;
    std::string format = "JSON";
    long object_cap = kDefaultObjectCap;
    bool single = false;              // true when a single-token override is given
    std::string token;                // single-token override
    std::string source_name;          // single-token override
    std::string source_url;           // single-token full URL override (optional)
};

PullConfig parse_config(const uint8_t* req, uint32_t len) {
    PullConfig c;
    if (req == nullptr || len == 0) return c;
    size_t i = 0;
    while (i < len && (req[i] == ' ' || req[i] == '\n' || req[i] == '\t' || req[i] == '\r')) i++;
    if (i >= len || req[i] != '{') return c;  // binary PIV request leaves defaults intact
    std::string json(reinterpret_cast<const char*>(req), len);
    std::string v;
    if (ps::json_string_field(json, "baseUrl", &v) && !v.empty()) c.base_url = v;
    if (ps::json_string_field(json, "format", &v) && !v.empty()) c.format = v;
    long cap = ps::json_number_field(json, "objectCap", -1);
    if (cap > 0) c.object_cap = cap;
    if (ps::json_string_field(json, "token", &c.token) && !c.token.empty()) {
        c.single = true;
        ps::json_string_field(json, "sourceName", &c.source_name);
        ps::json_string_field(json, "sourceUrl", &c.source_url);
        // Sensible default SourceName if omitted: lowercase token.
        if (c.source_name.empty()) c.source_name = to_lower(c.token);
    }
    return c;
}

std::string build_url(const PullConfig& cfg, const std::string& token, const std::string& source_url_override) {
    if (!source_url_override.empty()) return source_url_override;
    return cfg.base_url + "?SOURCE=" + token + "&FORMAT=" + cfg.format;
}

// Per-token processing result (for the summary board).
struct TokenResult {
    std::string token, source_name;
    long status = 0, records = 0, stored = 0, signed_ = 0, published = 0;
    const char* format = "";
};

// Fetch + parse + ingest one token's SupGP set. Returns false ONLY on a non-200
// (the caller then HALTS the cycle per the CelesTrak M2M rule); a 200 that parses
// to zero records is a clean (fail-closed) empty result, not a halt.
bool process_token(const PullConfig& cfg, const std::string& token,
                   const std::string& source_name, const std::string& source_url_override,
                   TokenResult* tr) {
    tr->token = token;
    tr->source_name = source_name;

    std::string url = build_url(cfg, token, source_url_override);
    ps::HttpResult src = ps::http_get(url);
    tr->status = src.status;
    if (src.status != 200) return false;   // halt the cycle
    if (src.body.empty()) return true;     // clean empty

    std::string source_sha256 = ps::sha256_hex(src.body.data(), src.body.size());
    std::string body(src.body.begin(), src.body.end());
    const char* format = "";
    std::vector<Omm> objs = parse_supgp(body, &format);
    tr->format = format;

    ps::ProviderConfig pcfg;
    pcfg.signing_slot = kSigningKeySlot;
    pcfg.publish_topic = "sdn/data-source/" + source_name;   // per-provider channel
    pcfg.signature_type = "ed25519";
    pcfg.source_name = source_name;             // distinct per provider (grouping key)
    pcfg.data_source = "CelesTrak SupGP";       // NON-INDEPENDENT lane label
    pcfg.record_schema = "OMM";                 // mean elements -> OMM

    long emitted = 0;
    // FILE_NAME = the CelesTrak query artifact name for this token.
    std::string ext = to_lower(cfg.format == "" ? std::string("json") : cfg.format);
    std::string file_name = "celestrak_supgp_" + token + "." + ext;

    for (const Omm& o : objs) {
        if (!o.valid) continue;
        if (emitted >= cfg.object_cap) break;
        emitted++;
        tr->records++;

        std::string omm = build_omm_record(o, source_name);

        // FILE_ID follows the CelesTrak <source>:<schema>:<key>:<epoch> partition
        // convention; per-segment epochs (e.g. CSS-E) yield distinct FILE_IDs.
        std::string file_id = source_name + ":OMM:" + std::to_string(o.norad_cat_id) + ":" + o.epoch;

        std::string provenance =
            std::string("{\"SOURCE_NAME\":\"") + ps::json_escape(source_name) + "\"," +
            "\"SOURCE_URL\":\"" + ps::json_escape(url) + "\"," +
            "\"SOURCE_SHA256\":\"" + source_sha256 + "\"," +
            "\"DATA_SOURCE\":\"CelesTrak SupGP\"," +
            "\"INDEPENDENT\":false," +
            "\"NON_INDEPENDENT_REASON\":\"CelesTrak-fitted SupGP OMM re-published; not an independent SDN OD solution and not operator-raw ephemeris\"," +
            "\"CELESTRAK_TOKEN\":\"" + ps::json_escape(token) + "\"," +
            "\"CELESTRAK_DATA_SOURCE\":\"" + ps::json_escape(o.data_source) + "\"," +
            "\"CELESTRAK_RMS\":\"" + ps::json_escape(o.rms) + "\"," +
            "\"RECORD_SCHEMA\":\"OMM\"," +
            "\"REFERENCE_FRAME\":\"TEME\"," +
            "\"TIME_SYSTEM\":\"UTC\"," +
            "\"MEAN_ELEMENT_THEORY\":\"SGP4\"," +
            "\"NORAD_CAT_ID\":" + std::to_string(o.norad_cat_id) + "," +
            "\"OBJECT_NAME\":\"" + ps::json_escape(o.object_name) + "\"," +
            "\"OBJECT_ID\":\"" + ps::json_escape(o.object_id) + "\"," +
            "\"EPOCH\":\"" + ps::json_escape(o.epoch) + "\"}";

        ps::PublishResult r = ps::publish_record_with_source(
            pcfg,
            reinterpret_cast<const uint8_t*>(omm.data()), omm.size(),
            file_name, file_id, o.epoch, provenance,
            url, source_sha256);
        if (r.stored) tr->stored++;
        if (r.signed_) tr->signed_++;
        if (r.published) tr->published++;
    }
    return true;
}

// ── The pull method ──────────────────────────────────────────────────────────

std::string run_pull(const uint8_t* req, uint32_t req_len) {
    PullConfig cfg = parse_config(req, req_len);

    // Build the effective registry: single-token override or the built-in table.
    struct Ent { std::string token, source_name, url_override; };
    std::vector<Ent> reg;
    if (cfg.single) {
        reg.push_back({cfg.token, cfg.source_name, cfg.source_url});
    } else {
        for (size_t i = 0; i < kRegistryCount; ++i)
            reg.push_back({kRegistry[i].token, kRegistry[i].source_name, std::string()});
    }
    // De-dup by token (never re-fetch the same token within a cycle).
    std::vector<Ent> uniq;
    for (const Ent& e : reg) {
        bool seen = false;
        for (const Ent& u : uniq) if (u.token == e.token) { seen = true; break; }
        if (!seen) uniq.push_back(e);
    }

    std::vector<TokenResult> results;
    long tokens_ok = 0, fetched = 0, records = 0, stored = 0, signed_ = 0, published = 0;
    bool halted = false;
    std::string halted_token;
    long halted_status = 0;

    for (const Ent& e : uniq) {
        TokenResult tr;
        bool ok = process_token(cfg, e.token, e.source_name, e.url_override, &tr);
        results.push_back(tr);
        if (!ok) {
            halted = true;
            halted_token = e.token;
            halted_status = tr.status;
            break;   // CelesTrak M2M rule: halt the cycle on any non-200
        }
        tokens_ok++;
        if (tr.status == 200) fetched++;
        records += tr.records;
        stored += tr.stored;
        signed_ += tr.signed_;
        published += tr.published;
    }

    // Per-token board array.
    std::string per_token = "[";
    for (size_t i = 0; i < results.size(); ++i) {
        const TokenResult& t = results[i];
        if (i) per_token += ",";
        per_token += "{\"token\":\"" + ps::json_escape(t.token) + "\",";
        per_token += "\"source_name\":\"" + ps::json_escape(t.source_name) + "\",";
        per_token += "\"status\":" + std::to_string(t.status) + ",";
        per_token += "\"format\":\"" + std::string(t.format) + "\",";
        per_token += "\"records\":" + std::to_string(t.records) + ",";
        per_token += "\"stored\":" + std::to_string(t.stored) + ",";
        per_token += "\"signed\":" + std::to_string(t.signed_) + ",";
        per_token += "\"published\":" + std::to_string(t.published) + "}";
    }
    per_token += "]";

    return std::string("{\"ok\":true,\"provider\":\"celestrak-supgp\",") +
           "\"data_source\":\"CelesTrak SupGP\",\"independent\":false," +
           "\"format\":\"" + ps::json_escape(cfg.format) + "\"," +
           "\"tokens_attempted\":" + std::to_string(results.size()) + "," +
           "\"tokens_ok\":" + std::to_string(tokens_ok) + "," +
           "\"halted\":" + (halted ? "true" : "false") + "," +
           "\"halted_token\":\"" + ps::json_escape(halted_token) + "\"," +
           "\"halted_status\":" + std::to_string(halted_status) + "," +
           "\"fetched\":" + std::to_string(fetched) + "," +
           "\"records\":" + std::to_string(records) + "," +
           "\"stored\":" + std::to_string(stored) + "," +
           "\"signed\":" + std::to_string(signed_) + "," +
           "\"published\":" + std::to_string(published) + "," +
           "\"per_token\":" + per_token + "}";
}

}  // namespace

extern "C" {

// Canonical streaming invoke entrypoint. The TIMERS `pull` entry (and any manual
// invoke) triggers a multi-provider fetch+parse+store+sign+publish cycle.
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
