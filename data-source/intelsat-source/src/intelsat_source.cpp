/*
 * Intelsat (public ephemeris) data-source module (A2.2c-2, Tier-1 adapter).
 *
 * For each run this:
 *   1. GETs the public MyIntelsat ephemeris listing page
 *      (my.intelsat.com/ephemeris/public — unauthenticated HTML; the file
 *      dropdowns' <option value="..."> are the bare ephemeris filenames),
 *   2. selects the NEWEST ECF file for the configured satellite,
 *   3. GETs that ECF file from /Resource/Ephemeris/<name>.txt,
 *   4. parses the ECF position table,
 *   5. re-emits a schema-exact SDS OEM record with the frame PRESERVED AS
 *      DECLARED (Intelsat "ECF" = Earth-Centered-Fixed / ECEF — the OD side owns
 *      the ECEF->TEME transform per A2.2a).
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
 * TYPED CONTRACTS 1.0 (FlatBuffers only, no JSON, no base64): the module makes no
 * fetch and no store itself. `request` turns the flow's TimerTick (TICK) into a GET
 * HttpRequest (HREQ) for hostcap/http-request; `select_file` turns the listing's HttpResponse
 * into the GET of the file; `emit` turns the
 * HttpResponse (HRSP) into $OEM FlatBuffers on "oem", consumed in memory by
 * analysis/od.fit. Nothing is stored, signed or published (the former `pull`
 * path declared a $PNM it never produced and is gone). Node config (listingUrl, ephemerisBase, target) is
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

// MyIntelsat public ephemeris listing page (unauthenticated HTML).
static const char* kDefaultListingURL = "https://my.intelsat.com/ephemeris/public";
// Ephemeris file directory; the fetched file is <base><filename>.txt.
static const char* kDefaultEphemerisBase = "https://my.intelsat.com/Resource/Ephemeris/";
// Default target satellite short name (the "_<sat>_" filename field).
static const char* kDefaultTarget = "is-21";
// ECF category filename token (the honest state-vector product family).
static const char* kEcfCategoryMarker = "_e_";


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
// Build a NON-size-prefixed SDS $OEM FlatBuffer for the Intelsat ECF ephemeris:
// verbose, position-only (ECF has no velocity -> velocity 0, unused by the
// position-residual fit), Earth-fixed (CustomFrame::ECEF), UTC. ECF positions are
// METRES -> convert to km. ECF carries no NORAD -> NORAD_CAT_ID 0.
std::vector<uint8_t> build_oem_fb(const EcfDoc& doc, const std::string& object_name) {
    struct PosState {
        const char* epoch;
        double x, y, z, vx, vy, vz;
    };
    std::vector<PosState> full;
    full.reserve(doc.rows.size());
    for (const EcfRow& r : doc.rows) {
        full.push_back({r.epoch.c_str(), r.x_m / 1000.0, r.y_m / 1000.0,
                        r.z_m / 1000.0, 0.0, 0.0, 0.0});
    }
    const oem_fb::Identity id{object_name.c_str(), "", 0u};
    return oem_fb::build_oem_flatbuffer(id, CustomFrame::ECEF, "EARTH",
                                        timingStandard::UTC, full.data(),
                                        static_cast<int>(full.size()));
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

std::string join_url(const std::string& base, const std::string& file) {
    if (!base.empty() && base.back() == '/') return base + file;
    return base + "/" + file;
}

}  // namespace

extern "C" {

// request: a TimerTick (its fields are not read) -> the GET of the public ephemeris listing (config listingUrl).
int request(void) {
    const sdm_piv::Config config = sdm_piv::get_config();
    return push_get("request", config_text(config, "listingUrl", kDefaultListingURL)) < 0 ? 1 : 0;
}

// select_file: the listing's HttpResponse -> the GET of the newest ECF ("_e_") file of the target satellite (config target,
// ephemerisBase).
int select_file(void) {
    const R::HttpResponse* listing = response_on("listing", "the Intelsat listing");
    if (!listing) return 1;
    const sdm_piv::Config config = sdm_piv::get_config();
    const std::string target = config_text(config, "target", kDefaultTarget);
    const std::vector<uint8_t> body(listing->BODY()->begin(), listing->BODY()->end());
    const std::string filename = select_newest_ecf(body, "_" + target + "_", kEcfCategoryMarker);
    if (filename.empty()) return fail("fetch-empty", "no fittable $OEM objects from provider: the listing names no ECF file of " + target);
    return push_get("request", join_url(config_text(config, "ephemerisBase", kDefaultEphemerisBase), filename + ".txt")) < 0 ? 1 : 0;
}

// emit: the ECF file's HttpResponse -> one position-only ECEF $OEM. OBJECT_NAME is the file header's name, else the
// filename's satellite field (the response URL's last segment), else the configured target. Nothing is stored.
int emit(void) {
    const R::HttpResponse* response = response_on("response", "the Intelsat ECF file");
    if (!response) return 1;
    EcfDoc doc;
    parse_ecf(body_of(*response), &doc);
    if (doc.rows.empty()) return fail("fetch-empty", "no fittable $OEM objects from provider: the ECF has no data rows");
    std::string filename = response->URL() ? response->URL()->str() : std::string();
    filename = filename.substr(filename.find_last_of('/') == std::string::npos ? 0 : filename.find_last_of('/') + 1);
    if (filename.size() > 4 && filename.compare(filename.size() - 4, 4, ".txt") == 0) filename.resize(filename.size() - 4);
    const std::vector<std::string> fields = split_filename_fields(filename);
    std::string object_name = doc.object_name;
    if (object_name.empty()) {
        const sdm_piv::Config config = sdm_piv::get_config();
        object_name = fields.size() >= 5 ? fields[4] : config_text(config, "target", kDefaultTarget);
    }
    const std::vector<uint8_t> oem = build_oem_fb(doc, object_name);
    if (oem.empty()) return fail("fetch-empty", "no fittable $OEM objects from provider");
    return push_oem(oem) < 0 ? 1 : 0;
}

}  // extern "C"
