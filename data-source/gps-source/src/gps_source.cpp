/*
 * GPS almanac (USCG NAVCEN SEM / YUMA) data-source module
 * (A2.2c-2, third Tier-1 adapter on the shared provider template).
 *
 * On a TIMERS-driven `pull` this fetches a public GPS almanac from USCG NAVCEN
 * (navcen.uscg.gov) — either the YUMA (`current_yuma.alm`) or SEM
 * (`current_sem.al3`) product, auto-detected — and for each PRN emits a
 * schema-exact SDS **OMM** record, stores it, signs its content id, and
 * publishes a schema-exact PNM pointer.
 *
 * ─── CANONICAL-MAPPING DECISION (why OMM, and the honesty caveats) ───────────
 * A GPS almanac is a set of reduced-precision MEAN quasi-Keplerian ELEMENTS
 * (eccentricity, sqrt(semi-major axis), inclination, longitude of ascending
 * node + its rate, argument of perigee, mean anomaly, clock af0/af1), one per
 * PRN, valid around a reference time-of-applicability (toa) in a given GPS week.
 * It is NOT a state-vector ephemeris. Per the A2.2a ethos we DO NOT fabricate
 * state vectors by propagating the almanac. The faithful canonical container for
 * mean elements is the SDS **OMM** (not OEM), so each PRN becomes one OMM record:
 *
 *   - SEMI_MAJOR_AXIS   = sqrt(A)^2               (km; direct, no model)
 *   - MEAN_MOTION       = sqrt(GM/a^3)            (rev/day; two-body, GM = the
 *                         GPS ICD WGS-84 value 398600.5 km^3/s^2, recorded in GM)
 *   - ECCENTRICITY      = e                        (direct)
 *   - INCLINATION       = i                        (deg; YUMA rad / SEM (0.30+di)
 *                         semicircles, normalized)
 *   - RA_OF_ASC_NODE    = Omega_0                  (deg; SEE CAVEAT below)
 *   - ARG_OF_PERICENTER = omega                    (deg)
 *   - MEAN_ANOMALY      = M_0                       (deg, normalized [0,360))
 *
 * HONESTY CAVEATS (also in the record COMMENT + README, and the OD/consumer owns
 * any reconciliation — the same split A2.2a uses for reference frames):
 *   1. MEAN_ELEMENT_THEORY = "GPS-LNAV-ALMANAC" — these are GPS broadcast-almanac
 *      Keplerian elements for the GPS almanac (two-body + nodal-regression)
 *      propagation model. They are NOT SGP4/TLE mean elements; DO NOT propagate
 *      them with SGP4.
 *   2. REFERENCE_FRAME = "GPS-BROADCAST" — the almanac declares no CCSDS frame.
 *      RA_OF_ASC_NODE (Omega_0) is the longitude of the ascending node referenced
 *      to the Greenwich meridian at the START of the GPS week (an ECEF-referenced
 *      quantity), NOT an inertial (TEME/J2000) RAAN. i / omega / M_0 are
 *      frame-agnostic Keplerian angles.
 *   3. TIME_SYSTEM = "GPS" — EPOCH is the GPS-time calendar representation of the
 *      (week, toa) with NO GPS->UTC leap-second correction applied.
 *   4. NORAD_CAT_ID = 0, OBJECT_ID = "" — the almanac carries only a PRN (and, in
 *      SEM, an SVN). Neither is a NORAD id / international designator, and the
 *      PRN->NORAD assignment is time-varying and NOT in the almanac, so it is NOT
 *      fabricated here. OBJECT_NAME = "GPS PRN NN"; PRN/SVN kept in provenance.
 *
 * A2.4 IMPLICATION (documented, not silently skipped): the A2.4 hard-RMS parity
 * gate (fit SGP4 to a source state-vector ephemeris, RMS <= CelesTrak SupGP RMS)
 * is NOT achievable for GPS from the almanac alone, because (a) the almanac is not
 * a state-vector ephemeris and we must not synthesize one by propagation, and
 * (b) even an element-space comparison vs CelesTrak's GPS-A OMM requires a frame
 * + theory reconciliation (GPS ECEF-week node & GPS-Kepler mean motion vs SGP4
 * inertial mean elements) PLUS a PRN->NORAD cross-reference the almanac lacks.
 * So GPS's A2.4 gate is BLOCKED at the hard-RMS level pending a GPS state-vector
 * ephemeris source (e.g. IGS/precise products, an owner decision); any interim
 * element check must be labeled non-independent. This mirrors A2.4's
 * "blocked on data access, NOT descoped to soft gates" language.
 *
 * The fetch/hash/store/sign/publish skeleton lives in the shared
 * common/provider_source.hpp; GPS-time conversion lives in the shared
 * common/gps_time.hpp (promoted here in A2.2c-2). Only the almanac parse + OMM
 * mapping stay in this file.
 *
 * Hostcall ABI (space_data_module_host): see common/sdm_hostcall_wire.hpp.
 */
#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string>
#include <vector>

#include "provider_source.hpp"
#include "gps_time.hpp"

namespace ps = provider_source;

// ── Provider constants ──────────────────────────────────────────────────────

// USCG NAVCEN public GPS almanacs. YUMA is the default (human-readable); the
// parser auto-detects SEM vs YUMA from content, so a SEM sourceUrl works too.
static const char* kDefaultAlmanacURL =
    "https://www.navcen.uscg.gov/sites/default/files/gps/almanac/current_yuma.alm";

static const char* kSigningKeySlot = "node-signing";
static const char* kPublishTopic = "sdn/data-source/gps";

// The GPS constellation is ~31 active + spares (32 almanac slots). Almanacs
// change ~daily at most, and each OMM record is tiny, so a default cap of 40
// emits every PRN in one pull without any churn concern.
static const long kDefaultObjectCap = 40;

// GM used for the two-body MEAN_MOTION derivation: the GPS ICD (IS-GPS-200)
// WGS-84 value, 3.986005e14 m^3/s^2 == 398600.5 km^3/s^2. Recorded in the OMM's
// GM field so the derivation is explicit and reversible.
static const double kGpsGmM3S2 = 3.986005e14;
static const double kGpsGmKm3S2 = 398600.5;

// GPS week rollover resolution. NAVCEN distributes the 10-bit GPS week (the
// current almanac shows 379 while the true week is 2427 = 2048 + 379). The
// current rollover era began at GPS week 2048 (2019-04-07); adding it recovers
// the full week and stays correct until week 3072 (~2038-11). The raw
// as-distributed week is preserved in provenance so the epoch can be recomputed
// if a future era needs a different anchor.
static const long kGpsRolloverAnchorWeek = 2048;
static const long kSecondsPerGpsWeek = 604800;

static const double kPi = 3.14159265358979323846;

extern "C" {
__attribute__((visibility("default")))
uint8_t* plugin_alloc(uint32_t size) { return static_cast<uint8_t*>(malloc(size)); }
__attribute__((visibility("default")))
void plugin_free(uint8_t* ptr, uint32_t /*size*/) { free(ptr); }
}  // extern "C"

namespace {

// ── Almanac record (elements normalized to radians + SI internally) ──────────

struct Almanac {
    long prn = 0;
    long svn = -1;          // SEM only (-1 = absent)
    long health = -1;
    long config = -1;       // SEM only
    long ura = -1;          // SEM only
    long week_raw = 0;      // as-distributed GPS week (10-bit)
    double toa = 0.0;       // time of applicability, seconds into the week
    double ecc = 0.0;
    double incl_rad = 0.0;
    double omega_dot_rad_s = 0.0;
    double sqrt_a = 0.0;    // m^(1/2)
    double omega0_rad = 0.0;
    double argp_rad = 0.0;
    double m0_rad = 0.0;
    double af0 = 0.0;
    double af1 = 0.0;
    bool valid = false;
};

std::string trim(const std::string& in) {
    size_t a = in.find_first_not_of(" \t\r\n");
    size_t b = in.find_last_not_of(" \t\r\n");
    if (a == std::string::npos) return std::string();
    return in.substr(a, b - a + 1);
}

std::vector<std::string> split_lines(const std::string& content) {
    std::vector<std::string> lines;
    size_t pos = 0;
    while (pos <= content.size()) {
        size_t nl = content.find('\n', pos);
        lines.push_back(content.substr(pos, (nl == std::string::npos ? content.size() : nl) - pos));
        if (nl == std::string::npos) break;
        pos = nl + 1;
    }
    return lines;
}

std::vector<std::string> tokenize(const std::string& s) {
    std::vector<std::string> toks;
    size_t i = 0;
    while (i < s.size()) {
        while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) i++;
        size_t j = i;
        while (j < s.size() && s[j] != ' ' && s[j] != '\t' && s[j] != '\r' && s[j] != '\n') j++;
        if (j > i) toks.push_back(s.substr(i, j - i));
        i = j;
    }
    return toks;
}

// YUMA: trimmed line starts with `prefix`; value is the number after the ':'.
bool yuma_field(const std::string& line, const char* prefix, double* out) {
    std::string t = trim(line);
    size_t plen = 0; while (prefix[plen]) plen++;
    if (t.size() < plen || t.compare(0, plen, prefix) != 0) return false;
    size_t colon = t.find(':');
    if (colon == std::string::npos) return false;
    *out = strtod(t.c_str() + colon + 1, nullptr);
    return true;
}

// Format detection: YUMA blocks begin with a "********" banner and carry "ID:"
// lines; SEM's first line is "<count>  <title>" (e.g. "32  CURRENT.ALM") and has
// no "ID:" labels.
bool looks_like_yuma(const std::string& content) {
    return content.find("ID:") != std::string::npos &&
           content.find("SQRT(A)") != std::string::npos;
}

// Parse the YUMA almanac (angles already in radians). One record per "ID:" block.
std::vector<Almanac> parse_yuma(const std::string& content) {
    std::vector<Almanac> out;
    std::vector<std::string> lines = split_lines(content);
    Almanac cur;
    bool have = false;
    double v;
    for (const std::string& line : lines) {
        std::string t = trim(line);
        if (t.compare(0, 3, "ID:") == 0) {
            if (have && cur.prn > 0) out.push_back(cur);
            cur = Almanac();
            have = true;
            cur.prn = strtol(t.c_str() + 3, nullptr, 10);
            continue;
        }
        if (!have) continue;
        double d;
        if (yuma_field(line, "Health", &d)) cur.health = static_cast<long>(d);
        else if (yuma_field(line, "Eccentricity", &d)) cur.ecc = d;
        else if (yuma_field(line, "Time of Applicability", &d)) cur.toa = d;
        else if (yuma_field(line, "Orbital Inclination", &d)) cur.incl_rad = d;
        else if (yuma_field(line, "Rate of Right Ascen", &d)) cur.omega_dot_rad_s = d;
        else if (yuma_field(line, "SQRT(A)", &d)) cur.sqrt_a = d;
        else if (yuma_field(line, "Right Ascen at Week", &d)) cur.omega0_rad = d;
        else if (yuma_field(line, "Argument of Perigee", &d)) cur.argp_rad = d;
        else if (yuma_field(line, "Mean Anom", &d)) cur.m0_rad = d;
        else if (yuma_field(line, "Af0", &d)) cur.af0 = d;
        else if (yuma_field(line, "Af1", &d)) cur.af1 = d;
        else if (yuma_field(line, "week", &d)) cur.week_raw = static_cast<long>(d);
        (void)v;
    }
    if (have && cur.prn > 0) {
        // A record is valid once it has a positive sqrt(A) (guards partial tails).
        out.push_back(cur);
    }
    // Mark validity (needs sqrt_a and a nonzero toa/week set on the block).
    for (Almanac& a : out) a.valid = (a.sqrt_a > 0.0 && a.prn > 0);
    return out;
}

// Parse the SEM almanac. Header line 1 = "<count>  <title>"; line 2 = "<week>
// <toa>"; then a flat stream of 14 numeric tokens per record:
//   prn svn ura  ecc dInc(sc) OmegaDot(sc/s)  sqrtA Omega0(sc) argp(sc)
//   M0(sc) af0 af1  health config
// SEM angles are in SEMICIRCLES and inclination is an offset from 0.30 semicircles.
std::vector<Almanac> parse_sem(const std::string& content) {
    std::vector<Almanac> out;
    std::vector<std::string> lines = split_lines(content);
    if (lines.size() < 2) return out;
    // Line 2: week + toa.
    std::vector<std::string> hdr = tokenize(lines[1]);
    long week_raw = 0; double toa = 0.0;
    if (hdr.size() >= 2) { week_raw = strtol(hdr[0].c_str(), nullptr, 10); toa = strtod(hdr[1].c_str(), nullptr); }
    // Flatten every token from line 3 onward.
    std::vector<std::string> toks;
    for (size_t i = 2; i < lines.size(); ++i) {
        std::vector<std::string> lt = tokenize(lines[i]);
        for (const std::string& s : lt) toks.push_back(s);
    }
    for (size_t i = 0; i + 14 <= toks.size(); i += 14) {
        Almanac a;
        a.prn = strtol(toks[i + 0].c_str(), nullptr, 10);
        a.svn = strtol(toks[i + 1].c_str(), nullptr, 10);
        a.ura = strtol(toks[i + 2].c_str(), nullptr, 10);
        a.ecc = strtod(toks[i + 3].c_str(), nullptr);
        double d_incl_sc = strtod(toks[i + 4].c_str(), nullptr);
        double omega_dot_sc = strtod(toks[i + 5].c_str(), nullptr);
        a.sqrt_a = strtod(toks[i + 6].c_str(), nullptr);
        double omega0_sc = strtod(toks[i + 7].c_str(), nullptr);
        double argp_sc = strtod(toks[i + 8].c_str(), nullptr);
        double m0_sc = strtod(toks[i + 9].c_str(), nullptr);
        a.af0 = strtod(toks[i + 10].c_str(), nullptr);
        a.af1 = strtod(toks[i + 11].c_str(), nullptr);
        a.health = strtol(toks[i + 12].c_str(), nullptr, 10);
        a.config = strtol(toks[i + 13].c_str(), nullptr, 10);
        // Semicircles -> radians; inclination = (0.30 + delta) semicircles.
        a.incl_rad = (0.30 + d_incl_sc) * kPi;
        a.omega_dot_rad_s = omega_dot_sc * kPi;
        a.omega0_rad = omega0_sc * kPi;
        a.argp_rad = argp_sc * kPi;
        a.m0_rad = m0_sc * kPi;
        a.week_raw = week_raw;
        a.toa = toa;
        a.valid = (a.sqrt_a > 0.0 && a.prn > 0);
        out.push_back(a);
    }
    return out;
}

// Normalize an angle (radians) to degrees in [0, 360).
double rad_to_deg_norm(double rad) {
    double deg = rad * 180.0 / kPi;
    while (deg < 0.0) deg += 360.0;
    while (deg >= 360.0) deg -= 360.0;
    return deg;
}

long resolve_gps_week(long week_raw) {
    // Post-2019 rollover era; raw week is < 1024 (10-bit), true week = 2048 + raw.
    return kGpsRolloverAnchorWeek + week_raw;
}

// Build the schema-exact SDS OMM record for one PRN. Honest mean-element mapping;
// see the canonical-mapping decision at the top of this file.
std::string build_omm_record(const Almanac& a, const std::string& epoch_iso,
                             const std::string& object_name, const char* format) {
    double a_m = a.sqrt_a * a.sqrt_a;
    double a_km = a_m / 1000.0;
    double n_rad_s = sqrt(kGpsGmM3S2 / (a_m * a_m * a_m));
    double n_rev_day = n_rad_s * 86400.0 / (2.0 * kPi);
    double incl_deg = rad_to_deg_norm(a.incl_rad);   // inclination stays 0..180 in practice
    double raan_deg = rad_to_deg_norm(a.omega0_rad);
    double argp_deg = rad_to_deg_norm(a.argp_rad);
    double m0_deg = rad_to_deg_norm(a.m0_rad);

    std::string s;
    s.reserve(1200);
    s += "{";
    s += "\"CCSDS_OMM_VERS\":2.0,";
    s += "\"CREATION_DATE\":\"" + ps::json_escape(epoch_iso) + "\",";  // no distinct creation ts in almanac; applicability epoch used
    s += "\"ORIGINATOR\":\"USCG NAVCEN\",";
    s += "\"COMMENT\":\"GPS broadcast-almanac (" + std::string(format) +
         ") mean Keplerian elements; NOT SGP4/TLE mean elements (MEAN_ELEMENT_THEORY="
         "GPS-LNAV-ALMANAC) - do not propagate with SGP4. RA_OF_ASC_NODE is the "
         "ascending-node longitude referenced to Greenwich at the start of GPS week "
         "(ECEF-referenced), not an inertial RAAN. TIME_SYSTEM=GPS (no leap "
         "correction). NORAD_CAT_ID/OBJECT_ID absent (almanac carries only PRN"
         "/SVN).\",";
    s += "\"OBJECT_NAME\":\"" + ps::json_escape(object_name) + "\",";
    s += "\"OBJECT_ID\":\"\",";                       // no international designator in almanac
    s += "\"CENTER_NAME\":\"EARTH\",";
    s += "\"REFERENCE_FRAME\":\"GPS-BROADCAST\",";    // no CCSDS frame declared; see COMMENT
    s += "\"TIME_SYSTEM\":\"GPS\",";                  // GPS system time, no leap correction
    s += "\"MEAN_ELEMENT_THEORY\":\"GPS-LNAV-ALMANAC\",";  // NOT SGP4
    s += "\"EPOCH\":\"" + ps::json_escape(epoch_iso) + "\",";
    s += "\"SEMI_MAJOR_AXIS\":" + ps::double_to_json(a_km) + ",";
    s += "\"MEAN_MOTION\":" + ps::double_to_json(n_rev_day) + ",";
    s += "\"ECCENTRICITY\":" + ps::double_to_json(a.ecc) + ",";
    s += "\"INCLINATION\":" + ps::double_to_json(incl_deg) + ",";
    s += "\"RA_OF_ASC_NODE\":" + ps::double_to_json(raan_deg) + ",";
    s += "\"ARG_OF_PERICENTER\":" + ps::double_to_json(argp_deg) + ",";
    s += "\"MEAN_ANOMALY\":" + ps::double_to_json(m0_deg) + ",";
    s += "\"GM\":" + ps::double_to_json(kGpsGmKm3S2) + ",";
    s += "\"NORAD_CAT_ID\":0";                        // absent; not fabricated from PRN
    s += "}";
    return s;
}

// ── Config (optional, from the invoke request payload) ───────────────────────

struct PullConfig {
    long object_cap = kDefaultObjectCap;
    std::string source_url = kDefaultAlmanacURL;
};

PullConfig parse_config(const uint8_t* req, uint32_t len) {
    PullConfig c;
    if (req == nullptr || len == 0) return c;
    size_t i = 0;
    while (i < len && (req[i] == ' ' || req[i] == '\n' || req[i] == '\t' || req[i] == '\r')) i++;
    if (i >= len || req[i] != '{') return c;  // binary PIV request leaves defaults intact
    std::string json(reinterpret_cast<const char*>(req), len);
    long cap = ps::json_number_field(json, "objectCap", -1);
    if (cap > 0) c.object_cap = cap;
    std::string url;
    if (ps::json_string_field(json, "sourceUrl", &url) && !url.empty()) c.source_url = url;
    return c;
}

// ── The pull method ──────────────────────────────────────────────────────────

std::string run_pull(const uint8_t* req, uint32_t req_len) {
    PullConfig cfg = parse_config(req, req_len);

    ps::ProviderConfig pcfg;
    pcfg.signing_slot = kSigningKeySlot;
    pcfg.publish_topic = kPublishTopic;
    pcfg.signature_type = "ed25519";
    pcfg.source_name = "gps";
    pcfg.data_source = "GPS-A";       // CelesTrak-comparable SupGP SOURCE token (A2.1)
    pcfg.record_schema = "OMM";       // mean elements -> OMM (honest container)

    ps::HttpResult src = ps::http_get(cfg.source_url);
    std::string source_sha256 =
        (src.status == 200 && !src.body.empty())
            ? ps::sha256_hex(src.body.data(), src.body.size())
            : std::string();

    long fetched = 0, records = 0, stored = 0, signed_ = 0, published = 0, parsed = 0;
    const char* format = "unknown";

    if (src.status == 200 && !src.body.empty()) {
        fetched = 1;
        std::string content(src.body.begin(), src.body.end());
        std::vector<Almanac> alms;
        if (looks_like_yuma(content)) { alms = parse_yuma(content); format = "yuma"; }
        else { alms = parse_sem(content); format = "sem"; }
        parsed = static_cast<long>(alms.size());

        for (const Almanac& a : alms) {
            if (!a.valid) continue;
            if (records >= cfg.object_cap) break;
            records++;

            long gps_week = resolve_gps_week(a.week_raw);
            long gps_seconds = gps_week * kSecondsPerGpsWeek + static_cast<long>(a.toa + 0.5);
            std::string epoch_iso = ps::gps_seconds_to_iso(gps_seconds);

            std::string object_name = "GPS PRN " + (a.prn < 10 ? std::string("0") : std::string()) +
                                      std::to_string(a.prn);
            std::string omm = build_omm_record(a, epoch_iso, object_name, format);

            std::string file_id = pcfg.source_name + ":" + pcfg.record_schema + ":" +
                                  std::to_string(a.prn) + ":" + epoch_iso;

            std::string provenance =
                std::string("{\"SOURCE_NAME\":\"") + ps::json_escape(pcfg.source_name) + "\"," +
                "\"SOURCE_URL\":\"" + ps::json_escape(cfg.source_url) + "\"," +
                "\"SOURCE_SHA256\":\"" + source_sha256 + "\"," +
                "\"DATA_SOURCE\":\"" + ps::json_escape(pcfg.data_source) + "\"," +
                "\"RECORD_SCHEMA\":\"" + ps::json_escape(pcfg.record_schema) + "\"," +
                "\"OBJECT_NAME\":\"" + ps::json_escape(object_name) + "\"," +
                "\"MEAN_ELEMENT_THEORY\":\"GPS-LNAV-ALMANAC\"," +
                "\"REFERENCE_FRAME\":\"GPS-BROADCAST\"," +
                "\"TIME_SYSTEM\":\"GPS\"," +
                "\"ALMANAC_FORMAT\":\"" + format + "\"," +
                "\"GPS_PRN\":" + std::to_string(a.prn) + "," +
                "\"GPS_SVN\":" + std::to_string(a.svn) + "," +
                "\"GPS_HEALTH\":" + std::to_string(a.health) + "," +
                "\"GPS_CONFIG\":" + std::to_string(a.config) + "," +
                "\"GPS_URA\":" + std::to_string(a.ura) + "," +
                "\"GPS_WEEK_RAW\":" + std::to_string(a.week_raw) + "," +
                "\"GPS_WEEK_RESOLVED\":" + std::to_string(gps_week) + "," +
                "\"TOA_SECONDS\":" + ps::double_to_json(a.toa) + "," +
                "\"SQRT_A_M_HALF\":" + ps::double_to_json(a.sqrt_a) + "," +
                "\"OMEGA_DOT_RAD_S\":" + ps::double_to_json(a.omega_dot_rad_s) + "," +
                "\"AF0_S\":" + ps::double_to_json(a.af0) + "," +
                "\"AF1_S_S\":" + ps::double_to_json(a.af1) + "," +
                "\"GM_KM3_S2\":" + ps::double_to_json(kGpsGmKm3S2) + "," +
                "\"EPOCH_GPS\":\"" + epoch_iso + "\"}";

            // FILE_NAME = source artifact basename (last path segment of the URL).
            std::string url = cfg.source_url;
            size_t slash = url.find_last_of('/');
            std::string file_name = (slash == std::string::npos) ? url : url.substr(slash + 1);

            ps::PublishResult r = ps::publish_record(
                pcfg,
                reinterpret_cast<const uint8_t*>(omm.data()), omm.size(),
                file_name, file_id, epoch_iso, provenance);
            if (r.stored) stored++;
            if (r.signed_) signed_++;
            if (r.published) published++;
        }
    }

    return std::string("{\"ok\":true,\"source\":\"") + pcfg.source_name + "\"," +
           "\"fetch_status\":" + std::to_string(src.status) + "," +
           "\"almanac_format\":\"" + format + "\"," +
           "\"record_schema\":\"" + pcfg.record_schema + "\"," +
           "\"object_cap\":" + std::to_string(cfg.object_cap) + "," +
           "\"parsed\":" + std::to_string(parsed) + "," +
           "\"fetched\":" + std::to_string(fetched) + "," +
           "\"records\":" + std::to_string(records) + "," +
           "\"stored\":" + std::to_string(stored) + "," +
           "\"signed\":" + std::to_string(signed_) + "," +
           "\"published\":" + std::to_string(published) + "}";
}

}  // namespace

extern "C" {

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
