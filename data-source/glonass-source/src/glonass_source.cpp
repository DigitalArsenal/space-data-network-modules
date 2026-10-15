/*
 * GLONASS precise ephemeris (IAC SP3) data-source module
 * (A2.2c-2, fourth Tier-1 adapter on the shared provider template).
 *
 * For each run this fetches a GLONASS precise ephemeris from the
 * Russian Information-Analytical Center (IAC), an SP3-d file, and for each
 * GLONASS satellite (SP3 id `Rnn`) emits a schema-exact SDS **OEM** record with
 * the state-vector series. The OEM/verbose skeleton mirrors the ISS adapter;
 * only the SP3 parse stays here.
 *
 * ─── FRAME / TIME (honest, preserved AS DECLARED — with a mission correction) ─
 * The A2.2c-2 packet expected IAC GLONASS ephemerides to be "PZ-90.11 ECEF state
 * vectors". LIVE INVESTIGATION (2026-07-13) of the actual IAC product corrects
 * that: IAC's precise SP3-d files declare, in their own headers,
 *   coordinate system = "IGS20"  (the IGS realization of ITRF2020),  NOT PZ-90.11
 *   time system       = "GPS"     (GPS system time),                  NOT GLONASS
 * PZ-90.11/GLONASS-time is the frame of the GLONASS *broadcast navigation
 * message* — a different product. IAC, as a full multi-GNSS IGS Analysis Center
 * (AC code "IAC"), publishes its precise orbits in standard IGS conventions
 * (IGS20 / GPS time) for interoperability. This adapter PRESERVES WHAT THE FILE
 * DECLARES: REFERENCE_FRAME = the SP3 coordinate-system field (e.g. "IGS20"),
 * TIME_SYSTEM = the SP3 time-system field (e.g. "GPS"). It does NOT relabel to
 * PZ-90.11 and does NOT transform frames — the OD module owns any frame transform
 * (A2.2a). 
 *
 * ─── REPRESENTATION: position-only (no fabricated velocity) ──────────────────
 * Every IAC SP3 sampled is POSITION-ONLY (P records only; no V/velocity records).
 * Per the A2.2a ethos we do NOT fabricate velocities (e.g. by finite-differencing).
 * The OEM is therefore VERBOSE (STEP_SIZE = 0, explicit EPOCH per line) with
 * STATE_VECTOR_SIZE = 3 and only X/Y/Z (km) per line. SP3 satellite-clock values
 * are not orbital state and are dropped (a bad/absent clock 999999.999999 does
 * NOT invalidate the position). An absent position (SP3 sentinel 0.000000 on all
 * of X/Y/Z) is skipped.
 *
 * TYPED CONTRACTS 1.0 (FlatBuffers only, no JSON, no base64): the module makes no
 * fetch and no store itself. `request` turns the flow's TimerTick (TICK) into a GET
 * HttpRequest (HREQ) for hostcap/http-request; `emit` turns the
 * HttpResponse (HRSP) into $OEM FlatBuffers on "oem", consumed in memory by
 * analysis/od.fit. Nothing is stored, signed or published (the former `pull`
 * path declared a $PNM it never produced and is gone). Node config (sourceUrl, objectCap) is
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

// IAC precise ephemeris, rolling "latest" product (SP3-d), fetched via the host
// hostcap/http-request (the HttpRequest `request` emits). TRANSPORT (2026-07-19 re-verified): every IAC
// HTTP/HTTPS frontend is dead — www.glonass-iac.ru => 502, ftp.glonass-iac.ru
// speaks only ftp (http/https connect fails) — so the ONLY live source is this
// ftp:// product (curl on the node => 226). The kubo host `http` cap uses net/http,
// which supports http/https but NOT ftp, so this fetch fails on prod until EITHER
// (a) the host `http` cap gains ftp:// support (the robust fix — a HOST concern,
// out of module scope: "modules only, no host changes"), OR (b) ops set `sourceUrl`
// to a live HTTPS IGS mirror of the same SP3 content. No rolling-"latest" HTTPS
// mirror exists (ESA GSSC / WHU serve date-coded IGS filenames, which would need
// GPS-week/DOY URL construction — beyond a transport swap). The module stays
// transport-agnostic (whatever scheme the host cap supports); `sourceUrl` overrides.
static const char* kDefaultSp3URL =
    "ftp://ftp.glonass-iac.ru/MCC/PRODUCTS/LATEST/Final.sp3";


// One record per GLONASS satellite. The DEFAULT is UNLIMITED — the WASM-only OD
// flow sends no per-run cap, so a default run emits the WHOLE constellation
// (~21-24 sats). `objectCap` stays an OPTIONAL invoke override: a positive value
// caps; <=0 means the whole constellation.
static const long kDefaultObjectCap = 0;  // 0 => unlimited (whole constellation)

namespace {

// ── SP3 parsing ──────────────────────────────────────────────────────────────

struct StateLine {
    std::string epoch;  // ISO 8601, TIME_SYSTEM as declared (no 'Z' — scale is TIME_SYSTEM)
    double x = 0, y = 0, z = 0;  // km
};

struct SatEphem {
    std::string sat_id;             // SP3 id, e.g. "R01"
    std::vector<StateLine> states;
};

struct Sp3Meta {
    std::string version;            // "d" from "#d"
    std::string coord_system;       // header col 47-51, e.g. "IGS20" (preserved AS DECLARED)
    std::string time_system = "GPS";// %c line col 10-12
    std::string orbit_type;         // header col 53-55, e.g. "FIT"
    std::string agency;             // header col 57-60, e.g. "IAC"
    long gps_week = 0;              // "##" line
    std::string creation_date;      // header epoch start (proxy; SP3 has no distinct creation ts)
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

// Fixed-column substring (1-indexed col_start..col_end inclusive), trimmed.
std::string cols(const std::string& line, size_t col_start, size_t col_end) {
    if (col_start < 1) col_start = 1;
    if (line.size() < col_start) return std::string();
    size_t begin = col_start - 1;
    size_t len = (col_end >= col_start) ? (col_end - col_start + 1) : 0;
    return trim(line.substr(begin, len));
}

void pad2(std::string* s, long v) { if (v < 10) s->push_back('0'); *s += std::to_string(v); }

// SP3 epoch line "*  YYYY MM DD HH MM SS.ssssssss" -> "YYYY-MM-DDThh:mm:ss.sss"
// (no 'Z'; the scale is carried by TIME_SYSTEM, matching the ISS OEM convention).
std::string sp3_epoch_iso(const std::string& epoch_line) {
    std::vector<std::string> t = split_ws(epoch_line);
    // t[0] == "*"; then Y M D H M S.
    if (t.size() < 7) return std::string();
    long Y = strtol(t[1].c_str(), nullptr, 10);
    long M = strtol(t[2].c_str(), nullptr, 10);
    long D = strtol(t[3].c_str(), nullptr, 10);
    long h = strtol(t[4].c_str(), nullptr, 10);
    long m = strtol(t[5].c_str(), nullptr, 10);
    double sec = strtod(t[6].c_str(), nullptr);
    long whole = static_cast<long>(sec);
    long milli = static_cast<long>((sec - static_cast<double>(whole)) * 1000.0 + 0.5);
    std::string s = std::to_string(Y);
    s.push_back('-'); pad2(&s, M);
    s.push_back('-'); pad2(&s, D);
    s.push_back('T'); pad2(&s, h);
    s.push_back(':'); pad2(&s, m);
    s.push_back(':'); pad2(&s, whole);
    s.push_back('.');
    if (milli < 100) s.push_back('0');
    if (milli < 10) s.push_back('0');
    s += std::to_string(milli);
    return s;
}

// Parse an SP3 file. Fills meta + a per-satellite GLONASS ('R') ephemeris map
// (insertion-ordered). Position sentinel 0.0/0.0/0.0 => absent (skipped).
void parse_sp3(const std::string& content, Sp3Meta* meta, std::vector<SatEphem>* sats) {
    std::vector<std::string> lines = split_lines(content);
    std::string cur_epoch;
    bool time_system_set = false;
    for (size_t li = 0; li < lines.size(); ++li) {
        const std::string& line = lines[li];
        if (li == 0 && line.size() >= 2 && line[0] == '#') {
            // "#dP..." : version letter at col 2, coord/orbit/agency at fixed cols.
            meta->version = std::string(1, line.size() > 1 ? line[1] : '?');
            meta->coord_system = cols(line, 47, 51);  // AS DECLARED (e.g. IGS20)
            meta->orbit_type = cols(line, 53, 55);
            meta->agency = cols(line, 57, 60);
            // Epoch start (proxy creation date) from the same line's Y M D H M S.
            std::vector<std::string> t = split_ws(line);
            if (t.size() >= 7) {
                // t[0] = "#dP2026" (year fused); recover Y from cols 4-7.
                std::string yr = cols(line, 4, 7);
                std::string mo = t[1], dy = t[2], hh = t[3], mm = t[4], ss = t[5];
                std::string ce = yr; ce.push_back('-');
                pad2(&ce, strtol(mo.c_str(), nullptr, 10)); ce.push_back('-');
                pad2(&ce, strtol(dy.c_str(), nullptr, 10)); ce.push_back('T');
                pad2(&ce, strtol(hh.c_str(), nullptr, 10)); ce.push_back(':');
                pad2(&ce, strtol(mm.c_str(), nullptr, 10)); ce.push_back(':');
                pad2(&ce, static_cast<long>(strtod(ss.c_str(), nullptr))); ce += ".000";
                meta->creation_date = ce;
            }
            continue;
        }
        if (line.compare(0, 2, "##") == 0) {
            std::vector<std::string> t = split_ws(line);
            if (t.size() >= 2) meta->gps_week = strtol(t[1].c_str(), nullptr, 10);
            continue;
        }
        if (line.compare(0, 2, "%c") == 0 && !time_system_set) {
            // First %c line only: time system at cols 10-12 (preserve AS DECLARED).
            std::string ts = cols(line, 10, 12);
            if (!ts.empty()) meta->time_system = ts;
            time_system_set = true;
            continue;
        }
        if (!line.empty() && line[0] == '*') {
            cur_epoch = sp3_epoch_iso(line);
            continue;
        }
        // Position record: "P<sat> X Y Z clock". GLONASS only ('R').
        if (line.size() >= 4 && line[0] == 'P' && line[1] == 'R') {
            std::string sat_id = trim(line.substr(1, 3));  // e.g. "R01"
            std::vector<std::string> t = split_ws(line.substr(4));
            if (t.size() < 3) continue;
            double x = strtod(t[0].c_str(), nullptr);
            double y = strtod(t[1].c_str(), nullptr);
            double z = strtod(t[2].c_str(), nullptr);
            if (x == 0.0 && y == 0.0 && z == 0.0) continue;  // SP3 absent-position sentinel
            // Find/append the satellite (insertion-ordered).
            SatEphem* se = nullptr;
            for (SatEphem& s : *sats) if (s.sat_id == sat_id) { se = &s; break; }
            if (se == nullptr) { sats->push_back(SatEphem{sat_id, {}}); se = &sats->back(); }
            StateLine sl; sl.epoch = cur_epoch; sl.x = x; sl.y = y; sl.z = z;
            se->states.push_back(sl);
        }
    }
}

// Build a schema-exact verbose OEM record (position-only) for one satellite.
// Build a NON-size-prefixed SDS $OEM FlatBuffer for one GLONASS sat: verbose,
// position-only (SP3 has no velocity -> velocity 0, unused by the position-residual
// fit), Earth-fixed (CustomFrame::ECEF; SP3 coord_system is an ITRF realization),
// GPS time, km. SP3 carries only the slot id -> NORAD_CAT_ID 0 (not fabricated).
std::vector<uint8_t> build_oem_fb(const SatEphem& sat, const std::string& object_name) {
    struct PosState {
        const char* epoch;
        double x, y, z, vx, vy, vz;
    };
    std::vector<PosState> full;
    full.reserve(sat.states.size());
    for (const StateLine& s : sat.states) {
        full.push_back({s.epoch.c_str(), s.x, s.y, s.z, 0.0, 0.0, 0.0});
    }
    const oem_fb::Identity id{object_name.c_str(), "", 0u};
    return oem_fb::build_oem_flatbuffer(id, CustomFrame::ECEF, "EARTH",
                                        timingStandard::GPS, full.data(),
                                        static_cast<int>(full.size()));
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

}  // namespace

extern "C" {

// request: a TimerTick (its fields are not read) -> the GET of the IAC SP3 (config sourceUrl, default IAC's latest).
int request(void) {
    const sdm_piv::Config config = sdm_piv::get_config();
    return push_get("request", config_text(config, "sourceUrl", kDefaultSp3URL)) < 0 ? 1 : 0;
}

// emit: the HttpResponse of that GET -> one $OEM per GLONASS satellite with states, in file order, at most config
// objectCap of them when it is positive (default: the whole constellation). Nothing is stored.
int emit(void) {
    const R::HttpResponse* response = response_on("response", "the GLONASS SP3");
    if (!response) return 1;
    const sdm_piv::Config config = sdm_piv::get_config();
    const double cap_value = config.number("objectCap", static_cast<double>(kDefaultObjectCap));
    const long object_cap = cap_value > 0 ? static_cast<long>(cap_value) : kDefaultObjectCap;
    Sp3Meta meta;
    std::vector<SatEphem> sats;
    parse_sp3(body_of(*response), &meta, &sats);
    long count = 0;
    for (const SatEphem& sat : sats) {
        if (sat.states.empty()) continue;
        if (object_cap > 0 && count >= object_cap) break;
        const std::vector<uint8_t> oem = build_oem_fb(sat, "GLONASS " + sat.sat_id);
        if (oem.empty()) continue;
        if (push_oem(oem) < 0) return 1;
        count++;
    }
    if (count == 0) return fail("fetch-empty", "no fittable $OEM objects from provider: the SP3 has no position records");
    return 0;
}

}  // extern "C"
