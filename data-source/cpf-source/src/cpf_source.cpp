/*
 * CPF (ILRS Consolidated Prediction Format) data-source module
 * (A2.2c-2, Tier-1 adapter).
 *
 * On a TIMERS-driven `pull` this:
 *   1. GETs an ILRS CPF v2 prediction directory listing from an UNAUTHENTICATED
 *      archive (EDC / DGFI-TUM — the archive verified to allow anonymous access;
 *      CDDIS requires an Earthdata login and is NOT used — see README),
 *   2. selects the NEWEST CPF file for the target from the listing,
 *   3. GETs that CPF file (whitespace-delimited CPF v2 records),
 *   4. parses the header (H1/H2/H5) + the type-10 position records,
 *   5. re-emits a schema-exact SDS OEM record with the CPF frame PRESERVED AS
 *      DECLARED (frame code 0 = geocentric Earth-fixed = ITRF/ECEF — the OD side
 *      owns the ITRF->TEME transform per A2.2a), stores it, signs its content id,
 *      and publishes a schema-exact PNM pointer.
 *
 * ─── HONEST FORMAT NOTES ────────────────────────────────────────────────────
 * CPF type-10 records carry POSITION ONLY (X,Y,Z in metres, geocentric). There
 * is NO velocity in a standard CPF prediction (record type 20 is optional and
 * absent here). Per the A2.2a ethos (never fabricate: velocities, frames, IDs),
 * this adapter does NOT synthesize velocity by differencing — it emits a
 * position-only OEM (STATE_VECTOR_SIZE = 3, EPHEMERIS_DATA_LINES carry EPOCH +
 * X/Y/Z only). Positions are normalised metres -> kilometres (the CCSDS OEM
 * canonical unit; a lossless scale, NOT a frame transform); the source unit is
 * recorded in provenance. The CPF is TWO PREDICTION products vs CelesTrak's
 * SupGP (both are predictions, not raw-vs-fit — see README / A2.1 caveat).
 *
 * Identity is REAL, parsed from H2: NORAD Catalog Number (field 3) and the ILRS
 * Satellite ID (field 1, COSPAR-derived) reformatted to the international
 * designator (OBJECT_ID). Nothing is hardcoded per target.
 *
 * The fetch/hash/store/sign/publish skeleton lives in the shared
 * common/provider_source.hpp; only the CPF discovery + parse + OEM mapping
 * stay here.
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

// EDC (EUROLAS Data Center, DGFI-TUM) anonymous HTTPS CPF v2 archive. The
// per-target year directory is an Apache index whose <a href> links are the CPF
// filenames; the newest (lexically-max filename: <target>_cpf_<yymmdd>_<seq>.<ext>)
// is selected. CDDIS is NOT used (it requires an Earthdata Login — see README).
static const char* kDefaultListingURL =
    "https://edc.dgfi.tum.de/pub/slr/cpf_predicts_v2/2026/lageos1/";
// Default target basename; the filename marker is "<target>_cpf_".
static const char* kDefaultTarget = "lageos1";

static const char* kSigningKeySlot = "node-signing";
static const char* kPublishTopic = "sdn/data-source/cpf";

// MJD of the Unix epoch (1970-01-01T00:00:00Z). CPF epochs are (MJD, sec-of-day)
// in UTC; unix = (MJD - 40587)*86400 + sec.
static const long kMjdUnixEpochDays = 40587;

extern "C" {
// Guest allocator used by the host to pass request/response buffers.
__attribute__((visibility("default")))
uint8_t* plugin_alloc(uint32_t size) { return static_cast<uint8_t*>(malloc(size)); }
__attribute__((visibility("default")))
void plugin_free(uint8_t* ptr, uint32_t /*size*/) { free(ptr); }
}  // extern "C"

namespace {

// ── time helpers (local; GPS/MJD epoch helper → promote to common/ later) ────

// Howard Hinnant's civil_from_days: days since 1970-01-01 -> (y, m, d).
void civil_from_days(long z, long* y, unsigned* m, unsigned* d) {
    z += 719468;
    long era = (z >= 0 ? z : z - 146096) / 146097;
    unsigned doe = static_cast<unsigned>(z - era * 146097);          // [0, 146096]
    unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;  // [0, 399]
    long yy = static_cast<long>(yoe) + era * 400;
    unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);          // [0, 365]
    unsigned mp = (5 * doy + 2) / 153;                               // [0, 11]
    *d = doy - (153 * mp + 2) / 5 + 1;                               // [1, 31]
    *m = mp < 10 ? mp + 3 : mp - 9;                                  // [1, 12]
    *y = yy + (*m <= 2 ? 1 : 0);
}

void pad2(std::string* s, long v) {
    if (v < 10) s->push_back('0');
    *s += std::to_string(v);
}

// Format (MJD, seconds-of-day) UTC -> ISO 8601 "YYYY-MM-DDThh:mm:ss[.ffffff]Z".
// Fractional seconds appended only when the source carries them.
std::string mjd_sod_to_iso(long mjd, double sec_of_day) {
    long whole = static_cast<long>(sec_of_day);
    double frac = sec_of_day - static_cast<double>(whole);
    long unix = (mjd - kMjdUnixEpochDays) * 86400 + whole;
    long days = unix / 86400;
    long sod = unix - days * 86400;
    if (sod < 0) { sod += 86400; days -= 1; }
    long y; unsigned mo, da;
    civil_from_days(days, &y, &mo, &da);
    long hh = sod / 3600, mm = (sod % 3600) / 60, ss = sod % 60;
    std::string s = std::to_string(y);
    s.push_back('-'); pad2(&s, static_cast<long>(mo));
    s.push_back('-'); pad2(&s, static_cast<long>(da));
    s.push_back('T'); pad2(&s, hh);
    s.push_back(':'); pad2(&s, mm);
    s.push_back(':'); pad2(&s, ss);
    if (frac > 1e-9) {
        char buf[24];
        snprintf(buf, sizeof(buf), "%.6f", frac);  // "0.xxxxxx"
        s += (buf[0] == '0' ? buf + 1 : buf);       // drop the leading 0 -> ".xxxxxx"
        // trim trailing zeros
        while (s.size() > 1 && s.back() == '0') s.pop_back();
    }
    s.push_back('Z');
    return s;
}

// Build an ISO 8601 UTC string from explicit calendar integers (H2 span fields).
std::string calendar_to_iso(long y, long mo, long da, long hh, long mm, long ss) {
    std::string s = std::to_string(y);
    s.push_back('-'); pad2(&s, mo);
    s.push_back('-'); pad2(&s, da);
    s.push_back('T'); pad2(&s, hh);
    s.push_back(':'); pad2(&s, mm);
    s.push_back(':'); pad2(&s, ss);
    s.push_back('Z');
    return s;
}

// ── ILRS Satellite ID (COSPAR-derived) -> international designator ───────────
// ILRS ID = YYNNNPP (2-digit year, 3-digit launch, 2-digit piece). E.g.
// 7603901 -> 1976-039A. Piece -> bijective base-26 letters (1->A, 26->Z, 27->AA).
std::string piece_letters(long piece) {
    std::string out;
    while (piece > 0) {
        long rem = (piece - 1) % 26;
        out.insert(out.begin(), static_cast<char>('A' + rem));
        piece = (piece - 1) / 26;
    }
    return out.empty() ? std::string("A") : out;
}

std::string ilrs_to_intl_designator(long ilrs_id) {
    if (ilrs_id <= 0) return std::string();
    long piece = ilrs_id % 100;
    long launch = (ilrs_id / 100) % 1000;
    long yy = ilrs_id / 100000;
    long year = (yy >= 57) ? (1900 + yy) : (2000 + yy);
    std::string s = std::to_string(year);
    s.push_back('-');
    if (launch < 100) s.push_back('0');
    if (launch < 10) s.push_back('0');
    s += std::to_string(launch);
    s += piece_letters(piece);
    return s;
}

// ── CPF parsing ─────────────────────────────────────────────────────────────

struct CpfHeader {
    std::string format_version;   // H1 field 3 ("2")
    std::string source_agency;    // H1 field 4 (e.g. DGF)
    std::string target_name;      // H1 field 11 (e.g. lageos1)
    long ilrs_id = 0;             // H2 field 1
    long norad = 0;               // H2 field 3
    std::string start_time;       // H2 fields 4-9 -> ISO
    std::string stop_time;        // H2 fields 10-15 -> ISO
    long interval = 0;            // H2 field 16 (sec between entries; 0 = variable)
    long frame_code = -1;         // H2 field 19 (0=ITRF, 1=TOD, 2=EME2000)
    long com_correction = -1;     // H2 field 21 (0=none/CoM, 1=applied/retro-array)
    long location_code = -1;      // H2 field 22 (1=Earth orbit)
    double com_offset = 0.0;      // H5 field 2 (metres, optional)
    bool has_com_offset = false;
    bool valid = false;           // H1 + H2 both parsed
};

struct CpfPos {
    long mjd = 0;
    double sec_of_day = 0.0;
    long leap = 0;
    double x_m = 0, y_m = 0, z_m = 0;  // metres, geocentric
};

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

// Map a CPF H2 reference-frame code to a preserved, honest frame name. Nothing
// is transformed here — the label is exactly what the CPF declares.
std::string frame_name(long code) {
    if (code == 0) return "ITRF";      // geocentric true body-fixed (Earth-fixed)
    if (code == 1) return "TOD";       // geocentric space-fixed, true-of-date inertial
    if (code == 2) return "EME2000";   // geocentric space-fixed, mean-of-date J2000
    return "UNKNOWN";                  // undocumented code -> honest UNKNOWN
}

// Parse a CPF v2 document: header records (H1/H2/H5, terminated by H9) then the
// type-10 position records (data), stopping at the "99" trailer. Comment ("00")
// and other record types are skipped for the canonical OEM (raw bytes are bound
// by SHA-256 in provenance).
void parse_cpf(const std::string& content, CpfHeader* h, std::vector<CpfPos>* pos) {
    size_t p = 0;
    std::string line;
    while (p <= content.size()) {
        size_t nl = content.find('\n', p);
        line = content.substr(p, (nl == std::string::npos ? content.size() : nl) - p);
        p = (nl == std::string::npos) ? content.size() + 1 : nl + 1;
        std::vector<std::string> t = split_ws(line);
        if (t.empty()) continue;
        const std::string& rt = t[0];
        if (rt == "H1") {
            // H1 CPF <ver> <src> <yyyy> <mm> <dd> <hh> <seq> <subseq> <target> <notes>
            if (t.size() >= 4) { h->format_version = t[2]; h->source_agency = t[3]; }
            if (t.size() >= 11) h->target_name = t[10];
        } else if (rt == "H2") {
            // H2 <ilrsID> <SIC> <NORAD> <sY sM sD sH sMin sSec> <eY eM eD eH eMin eSec>
            //    <interval> <compat> <class> <frame> <rotangle> <com> <location>
            if (t.size() >= 4) {
                h->ilrs_id = strtol(t[1].c_str(), nullptr, 10);
                h->norad = strtol(t[3].c_str(), nullptr, 10);
            }
            if (t.size() >= 16) {
                h->start_time = calendar_to_iso(
                    strtol(t[4].c_str(), nullptr, 10), strtol(t[5].c_str(), nullptr, 10),
                    strtol(t[6].c_str(), nullptr, 10), strtol(t[7].c_str(), nullptr, 10),
                    strtol(t[8].c_str(), nullptr, 10), strtol(t[9].c_str(), nullptr, 10));
                h->stop_time = calendar_to_iso(
                    strtol(t[10].c_str(), nullptr, 10), strtol(t[11].c_str(), nullptr, 10),
                    strtol(t[12].c_str(), nullptr, 10), strtol(t[13].c_str(), nullptr, 10),
                    strtol(t[14].c_str(), nullptr, 10), strtol(t[15].c_str(), nullptr, 10));
                h->interval = strtol(t[16].c_str(), nullptr, 10);
            }
            if (t.size() >= 20) h->frame_code = strtol(t[19].c_str(), nullptr, 10);
            if (t.size() >= 22) h->com_correction = strtol(t[21].c_str(), nullptr, 10);
            if (t.size() >= 23) h->location_code = strtol(t[22].c_str(), nullptr, 10);
            h->valid = (h->norad > 0);
        } else if (rt == "H5") {
            if (t.size() >= 2) { h->com_offset = strtod(t[1].c_str(), nullptr); h->has_com_offset = true; }
        } else if (rt == "10") {
            // 10 <dirflag> <MJD> <secOfDay> <leapflag> <X> <Y> <Z>  (metres)
            if (t.size() >= 8) {
                CpfPos c;
                c.mjd = strtol(t[2].c_str(), nullptr, 10);
                c.sec_of_day = strtod(t[3].c_str(), nullptr);
                c.leap = strtol(t[4].c_str(), nullptr, 10);
                c.x_m = strtod(t[5].c_str(), nullptr);
                c.y_m = strtod(t[6].c_str(), nullptr);
                c.z_m = strtod(t[7].c_str(), nullptr);
                pos->push_back(c);
            }
        } else if (rt == "99") {
            break;  // trailer
        }
        // H3/H4/H9/20/30/.../00 comment -> skipped for the canonical OEM record.
    }
}

// Build the canonical SDS OEM record (verbose, POSITION-ONLY, km) from a CPF.
// REFERENCE_FRAME is the CPF-declared frame (preserved, not transformed); the OD
// side owns the ITRF->TEME transform (A2.2a). STATE_VECTOR_SIZE = 3 (CPF carries
// no velocity — none is fabricated). Positions metres->km (CCSDS OEM unit).
std::string build_oem_record(const CpfHeader& h, const std::vector<CpfPos>& pos,
                             const std::string& object_id, const std::string& frame) {
    std::string s;
    s.reserve(pos.size() * 100 + 640);
    s += "{";
    s += "\"CCSDS_OEM_VERS\":2.0,";
    s += "\"CREATION_DATE\":\"" + ps::json_escape(h.start_time) + "\",";
    s += "\"ORIGINATOR\":\"" + ps::json_escape(h.source_agency.empty() ? std::string("ILRS") : h.source_agency) + "\",";
    s += "\"CLASSIFICATION\":\"UNCLASSIFIED\",";
    s += "\"EPHEMERIS_DATA_BLOCK\":[{";
    s += "\"COMMENT\":\"ILRS CPF v2 prediction (position-only); frame preserved AS DECLARED "
         "(CPF frame code " + std::to_string(h.frame_code) + "). Positions metres->km; NO velocity "
         "(CPF carries none; none fabricated). OD owns the frame transform.\",";
    s += "\"OBJECT_NAME\":\"" + ps::json_escape(h.target_name) + "\",";
    s += "\"OBJECT_ID\":\"" + ps::json_escape(object_id) + "\",";
    s += "\"NORAD_CAT_ID\":" + std::to_string(h.norad) + ",";
    s += "\"CENTER_NAME\":\"EARTH\",";
    s += "\"REFERENCE_FRAME\":\"" + ps::json_escape(frame) + "\",";  // declared (ITRF for code 0)
    s += "\"TIME_SYSTEM\":\"UTC\",";
    s += "\"START_TIME\":\"" + ps::json_escape(h.start_time) + "\",";
    s += "\"STOP_TIME\":\"" + ps::json_escape(h.stop_time) + "\",";
    s += "\"STEP_SIZE\":" + std::to_string(h.interval) + ",";  // declared CPF interval (sec)
    s += "\"STATE_VECTOR_SIZE\":3,";  // position-only (honest; no velocity in CPF)
    s += "\"EPHEMERIS_DATA_LINES\":[";
    for (size_t i = 0; i < pos.size(); ++i) {
        const CpfPos& c = pos[i];
        if (i) s += ",";
        s += "{\"EPOCH\":\"" + ps::json_escape(mjd_sod_to_iso(c.mjd, c.sec_of_day)) + "\",";
        s += "\"X\":" + ps::double_to_json(c.x_m / 1000.0) + ",";
        s += "\"Y\":" + ps::double_to_json(c.y_m / 1000.0) + ",";
        s += "\"Z\":" + ps::double_to_json(c.z_m / 1000.0) + "}";
    }
    s += "]}]}";
    return s;
}

// ── CPF directory-listing discovery ─────────────────────────────────────────
// Extract CPF filenames (containing the marker "<target>_cpf_") from an Apache
// HTML index (or any text listing). A filename token is bounded by any of the
// delimiters " \t\r\n\"'<>/=". The NEWEST is the lexically-max filename (the
// embedded yymmdd + sequence sorts chronologically).
bool is_fn_delim(char c) {
    return c == ' ' || c == '\t' || c == '\r' || c == '\n' ||
           c == '"' || c == '\'' || c == '<' || c == '>' || c == '/' || c == '=';
}

std::string select_newest_cpf(const std::vector<uint8_t>& listing, const std::string& marker) {
    std::string s(listing.begin(), listing.end());
    std::string newest;
    size_t from = 0;
    while (true) {
        size_t k = s.find(marker, from);
        if (k == std::string::npos) break;
        // expand left to filename start
        size_t a = k;
        while (a > 0 && !is_fn_delim(s[a - 1])) a--;
        // expand right to filename end
        size_t b = k + marker.size();
        while (b < s.size() && !is_fn_delim(s[b])) b++;
        std::string fn = s.substr(a, b - a);
        // basic sanity: must still contain the marker and have chars after it
        if (fn.size() > marker.size() && fn.find(marker) != std::string::npos) {
            if (fn > newest) newest = fn;
        }
        from = k + marker.size();
    }
    return newest;
}

// ── Config (optional, from the invoke request payload) ───────────────────────

struct PullConfig {
    std::string listing_url = kDefaultListingURL;
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
    if (ps::json_string_field(json, "target", &v) && !v.empty()) c.target = v;
    return c;
}

// Join a directory URL (with or without trailing '/') and a filename.
std::string join_url(const std::string& dir, const std::string& file) {
    if (!dir.empty() && dir.back() == '/') return dir + file;
    return dir + "/" + file;
}

// ── The pull method ──────────────────────────────────────────────────────────

std::string run_pull(const uint8_t* req, uint32_t req_len) {
    PullConfig cfg = parse_config(req, req_len);

    ps::ProviderConfig pcfg;
    pcfg.signing_slot = kSigningKeySlot;
    pcfg.publish_topic = kPublishTopic;
    pcfg.signature_type = "ed25519";   // must match the node-signing slot's key
    pcfg.source_name = "cpf";
    pcfg.data_source = "CPF";           // CelesTrak-comparable SOURCE token (A2.1)
    pcfg.record_schema = "OEM";         // honest canonical SDS type (ephemeris)

    std::string marker = cfg.target + "_cpf_";

    // 1) discover the newest CPF file for the target.
    ps::HttpResult listing = ps::http_get(cfg.listing_url);
    std::string filename;
    if (listing.status == 200 && !listing.body.empty())
        filename = select_newest_cpf(listing.body, marker);

    long fetched = 0, stored = 0, signed_ = 0, published = 0, pos_count = 0;
    long cpf_status = 0;
    std::string frame, object_id;

    if (!filename.empty()) {
        std::string file_url = join_url(cfg.listing_url, filename);
        ps::HttpResult cpf = ps::http_get(file_url);
        cpf_status = cpf.status;
        if (cpf.status == 200 && !cpf.body.empty()) {
            fetched = 1;
            CpfHeader h;
            std::vector<CpfPos> pos;
            std::string content(cpf.body.begin(), cpf.body.end());
            parse_cpf(content, &h, &pos);
            pos_count = static_cast<long>(pos.size());

            if (h.valid && !pos.empty()) {
                frame = frame_name(h.frame_code);
                object_id = ilrs_to_intl_designator(h.ilrs_id);

                // Raw CPF bytes bound into signed provenance by SHA-256 (never
                // stored under a data schema).
                std::string source_sha256 = ps::sha256_hex(cpf.body.data(), cpf.body.size());
                std::string oem = build_oem_record(h, pos, object_id, frame);

                std::string file_id = pcfg.source_name + ":" + pcfg.record_schema + ":" +
                                      std::to_string(h.norad) + ":" + h.start_time;
                std::string provenance =
                    std::string("{\"SOURCE_NAME\":\"") + ps::json_escape(pcfg.source_name) + "\"," +
                    "\"SOURCE_URL\":\"" + ps::json_escape(file_url) + "\"," +
                    "\"SOURCE_SHA256\":\"" + source_sha256 + "\"," +
                    "\"DATA_SOURCE\":\"" + ps::json_escape(pcfg.data_source) + "\"," +
                    "\"RECORD_SCHEMA\":\"" + ps::json_escape(pcfg.record_schema) + "\"," +
                    "\"NORAD_CAT_ID\":" + std::to_string(h.norad) + "," +
                    "\"OBJECT_NAME\":\"" + ps::json_escape(h.target_name) + "\"," +
                    "\"OBJECT_ID\":\"" + ps::json_escape(object_id) + "\"," +
                    "\"ILRS_SATELLITE_ID\":" + std::to_string(h.ilrs_id) + "," +
                    "\"CPF_SOURCE_AGENCY\":\"" + ps::json_escape(h.source_agency) + "\"," +
                    "\"CPF_FRAME_CODE\":" + std::to_string(h.frame_code) + "," +
                    "\"REFERENCE_FRAME\":\"" + ps::json_escape(frame) + "\"," +
                    "\"CPF_COM_CORRECTION\":" + std::to_string(h.com_correction) + "," +
                    "\"SOURCE_UNITS\":\"m\"," +
                    "\"RECORD_UNITS\":\"km\"," +
                    "\"HAS_VELOCITY\":false," +
                    "\"START_TIME\":\"" + ps::json_escape(h.start_time) + "\"," +
                    "\"STOP_TIME\":\"" + ps::json_escape(h.stop_time) + "\"," +
                    "\"INTERVAL_SEC\":" + std::to_string(h.interval) + "," +
                    "\"POSITION_COUNT\":" + std::to_string(pos.size()) + "," +
                    "\"PRODUCT_KIND\":\"prediction\"}";

                ps::PublishResult r = ps::publish_record_with_source(
                    pcfg,
                    reinterpret_cast<const uint8_t*>(oem.data()), oem.size(),
                    filename, file_id, h.start_time, provenance,
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
    out += "\"cpf_status\":" + std::to_string(cpf_status) + ",";
    out += "\"record_schema\":\"" + pcfg.record_schema + "\",";
    out += "\"reference_frame\":\"" + ps::json_escape(frame) + "\",";
    out += "\"object_id\":\"" + ps::json_escape(object_id) + "\",";
    out += "\"position_count\":" + std::to_string(pos_count) + ",";
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
// newest CPF prediction of the configured target.
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
