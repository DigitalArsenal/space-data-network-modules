/*
 * CPF (ILRS Consolidated Prediction Format) data-source module
 * (A2.2c-2, Tier-1 adapter).
 *
 * For each run this:
 *   1. GETs an ILRS CPF v2 prediction directory listing from an UNAUTHENTICATED
 *      archive (EDC / DGFI-TUM — the archive verified to allow anonymous access;
 *      CDDIS requires an Earthdata login and is NOT used — see README),
 *   2. selects the NEWEST CPF file for the target from the listing,
 *   3. GETs that CPF file (whitespace-delimited CPF v2 records),
 *   4. parses the header (H1/H2/H5) + the type-10 position records,
 *   5. re-emits a schema-exact SDS OEM record with the CPF frame PRESERVED AS
 *      DECLARED (frame code 0 = geocentric Earth-fixed = ITRF/ECEF — the OD side
 *      owns the ITRF->TEME transform per A2.2a).
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
 * TYPED CONTRACTS 1.0 (FlatBuffers only, no JSON, no base64): the module makes no
 * fetch and no store itself. `request` turns the flow's TimerTick (TICK) into a GET
 * HttpRequest (HREQ) for hostcap/http-request; `select_file` turns the listing's HttpResponse
 * into the GET of the file; `emit` turns the
 * HttpResponse (HRSP) into $OEM FlatBuffers on "oem", consumed in memory by
 * analysis/od.fit. Nothing is stored, signed or published (the former `pull`
 * path declared a $PNM it never produced and is gone). Node config (listingUrl, target) is
 * plugin.getConfig through sdm_piv (one ModuleConfig, read in place), the only
 * hostcall. A transport error, another status than 200, an empty body or a
 * file with nothing fittable fails closed (fetch-failed / fetch-empty).
 */
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string>
#include <vector>

#include <string_view>

#include <HttpRequest_generated.h>
#include <HttpResponse_generated.h>
#include <typedHostcall.hpp>

// SDS $OEM FlatBuffer + shared builder (math.h SVID macro guards; native-only).
#include <cmath>

namespace R = sdn::runtime;

// ── Provider constants ──────────────────────────────────────────────────────

// EDC (EUROLAS Data Center, DGFI-TUM) anonymous HTTPS CPF v2 archive. The
// per-target year directory is an Apache index whose <a href> links are the CPF
// filenames; the newest (lexically-max filename: <target>_cpf_<yymmdd>_<seq>.<ext>)
// is selected. CDDIS is NOT used (it requires an Earthdata Login — see README).
static const char* kDefaultListingURL =
    "https://edc.dgfi.tum.de/pub/slr/cpf_predicts_v2/2026/lageos1/";
// Default target basename; the filename marker is "<target>_cpf_".
static const char* kDefaultTarget = "lageos1";


// MJD of the Unix epoch (1970-01-01T00:00:00Z). CPF epochs are (MJD, sec-of-day)
// in UTC; unix = (MJD - 40587)*86400 + sec.
static const long kMjdUnixEpochDays = 40587;

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
    long unix_seconds = (mjd - kMjdUnixEpochDays) * 86400 + whole;
    long days = unix_seconds / 86400;
    long sod = unix_seconds - days * 86400;
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
// Build a NON-size-prefixed SDS $OEM FlatBuffer for the CPF prediction: verbose,
// position-only (CPF has no velocity -> velocity 0, unused by the position-residual
// fit), positions metres->km, MJD+sec-of-day -> ISO UTC. Frame from the CPF code:
// 0=ITRF (CustomFrame::ECEF), 2=EME2000 (CelestialFrame). Other codes (e.g. 1=TOD,
// not accepted by the OD reader's classify_frame) are skipped (empty result). CPF
// carries the real NORAD.
std::vector<uint8_t> build_oem_fb(const CpfHeader& h, const std::vector<CpfPos>& pos,
                                  const std::string& object_id) {
    struct PosState {
        std::string epoch;
        double x, y, z, vx, vy, vz;
    };
    std::vector<PosState> full;
    full.reserve(pos.size());
    for (const CpfPos& c : pos) {
        full.push_back({mjd_sod_to_iso(c.mjd, c.sec_of_day), c.x_m / 1000.0,
                        c.y_m / 1000.0, c.z_m / 1000.0, 0.0, 0.0, 0.0});
    }
    const oem_fb::Identity id{h.target_name.c_str(), object_id.c_str(),
                              static_cast<uint32_t>(h.norad)};
    if (h.frame_code == 2) {
        return oem_fb::build_oem_flatbuffer(id, CelestialFrame::EME2000, "EARTH",
                                            timingStandard::UTC, full.data(),
                                            static_cast<int>(full.size()));
    }
    if (h.frame_code == 0) {
        return oem_fb::build_oem_flatbuffer(id, CustomFrame::ECEF, "EARTH",
                                            timingStandard::UTC, full.data(),
                                            static_cast<int>(full.size()));
    }
    return {};  // unsupported CPF frame (e.g. TOD) -> skip
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


// ── Typed contracts 1.0: node config, HttpRequest out, HttpResponse in, $OEM out ─────────────────
// Config is plugin.getConfig through sdm_piv (one ModuleConfig, read in place); the fetch is the flow's
// hostcap/http-request (an HttpRequest out, its HttpResponse back in); every frame is a FlatBuffer.

int fail(const char* code, const std::string& message) {
    plugin_set_error(code, message.c_str());
    return 1;
}

// A config string, or `fallback` when the key is absent or empty.
std::string config_text(const sdm_piv::Config& config, const char* key, const char* fallback) {
    const std::string_view v = config.string(key);
    return v.empty() ? std::string(fallback) : std::string(v);
}

// One GET HttpRequest (HREQ) on `port`, as the legacy ps::http_get asked for it (method and URL only).
int push_get(const char* port, const std::string& url) {
    flatbuffers::FlatBufferBuilder b(256 + url.size());
    R::FinishHttpRequestBuffer(b, R::CreateHttpRequestDirect(b, "GET", url.c_str()));
    return plugin_push_output_ex(port, "HttpRequest.fbs", R::HttpRequestIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 "HttpRequest", 0, 0, b.GetBufferPointer(), b.GetSize());
}

// The HttpResponse (HRSP) on `port`: STATUS 200 with a body, or nullptr with the error set (a transport ERROR, another
// status or an empty body fails closed, as the legacy fetch did).
const R::HttpResponse* response_on(const char* port, const char* what) {
    const int32_t index = plugin_find_input_index(port, 0);
    const plugin_input_frame_t* f = index < 0 ? nullptr : plugin_get_input_frame(static_cast<uint32_t>(index));
    if (!f || !f->payload || !f->payload_length) {
        fail("missing-response-frame", std::string("an HttpResponse frame is required on '") + port + "'");
        return nullptr;
    }
    flatbuffers::Verifier verifier(f->payload, f->payload_length, 64, 1000000, false);
    if (!R::VerifyHttpResponseBuffer(verifier)) {
        fail("invalid-response-frame", std::string("the '") + port + "' frame is not an HttpResponse (HRSP)");
        return nullptr;
    }
    const R::HttpResponse* r = R::GetHttpResponse(f->payload);
    const std::string url = r->URL() ? r->URL()->str() : std::string();
    if (r->ERROR() && r->ERROR()->size()) {
        fail("fetch-failed", std::string(what) + " " + url + ": " + r->ERROR()->str());
        return nullptr;
    }
    if (r->STATUS() != 200 || !r->BODY() || r->BODY()->size() == 0) {
        fail("fetch-empty", std::string(what) + " " + url + " returned HTTP status " + std::to_string(r->STATUS()) +
                                (r->BODY() && r->BODY()->size() ? "" : " with no body"));
        return nullptr;
    }
    return r;
}

std::string body_of(const R::HttpResponse& r) {
    return std::string(reinterpret_cast<const char*>(r.BODY()->data()), r.BODY()->size());
}

// One $OEM FlatBuffer (not size-prefixed) on "oem".
int push_oem(const std::vector<uint8_t>& oem) {
    return plugin_push_output_ex("oem", "OEM.fbs", "$OEM", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "OEM", 0, 0, oem.data(),
                                 static_cast<uint32_t>(oem.size()));
}

// Join a directory URL (with or without trailing '/') and a filename.
std::string join_url(const std::string& dir, const std::string& file) {
    if (!dir.empty() && dir.back() == '/') return dir + file;
    return dir + "/" + file;
}

}  // namespace

extern "C" {

// request: a TimerTick (its fields are not read) -> the GET of the target's EDC directory listing (config listingUrl).
int request(void) {
    const sdm_piv::Config config = sdm_piv::get_config();
    return push_get("request", config_text(config, "listingUrl", kDefaultListingURL)) < 0 ? 1 : 0;
}

// select_file: the listing's HttpResponse -> the GET of the newest "<target>_cpf_" file in it (config target).
int select_file(void) {
    const R::HttpResponse* listing = response_on("listing", "the CPF listing");
    if (!listing) return 1;
    const sdm_piv::Config config = sdm_piv::get_config();
    const std::string target = config_text(config, "target", kDefaultTarget);
    const std::vector<uint8_t> body(listing->BODY()->begin(), listing->BODY()->end());
    const std::string filename = select_newest_cpf(body, target + "_cpf_");
    if (filename.empty()) return fail("fetch-empty", "no fittable $OEM objects from provider: the listing names no " + target + "_cpf_ file");
    return push_get("request", join_url(config_text(config, "listingUrl", kDefaultListingURL), filename)) < 0 ? 1 : 0;
}

// emit: the CPF file's HttpResponse -> one position-only $OEM in the CPF's declared frame. Nothing is stored.
int emit(void) {
    const R::HttpResponse* response = response_on("response", "the CPF file");
    if (!response) return 1;
    CpfHeader h;
    std::vector<CpfPos> pos;
    parse_cpf(body_of(*response), &h, &pos);
    if (!h.valid || pos.empty()) return fail("fetch-empty", "no fittable $OEM objects from provider: the CPF has no valid header or position records");
    const std::vector<uint8_t> oem = build_oem_fb(h, pos, ilrs_to_intl_designator(h.ilrs_id));
    if (oem.empty()) return fail("fetch-empty", "no fittable $OEM objects from provider");
    return push_oem(oem) < 0 ? 1 : 0;
}

}  // extern "C"
