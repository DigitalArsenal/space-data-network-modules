/*
 * GLONASS precise ephemeris (IAC SP3) data-source module
 * (A2.2c-2, fourth Tier-1 adapter on the shared provider template).
 *
 * On a TIMERS-driven `pull` this fetches a GLONASS precise ephemeris from the
 * Russian Information-Analytical Center (IAC), an SP3-d file, and for each
 * GLONASS satellite (SP3 id `Rnn`) emits a schema-exact SDS **OEM** record with
 * the state-vector series, stores it, signs its content id, and publishes a
 * schema-exact PNM pointer. The OEM/verbose skeleton mirrors the ISS adapter;
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
 * (A2.2a). The raw SP3 bytes are bound into signed provenance by SHA-256.
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
 * Hostcall ABI (space_data_module_host): see common/sdm_hostcall_wire.hpp.
 */
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string>
#include <vector>

#include "provider_source.hpp"

// SDS $OEM FlatBuffer + shared builder (math.h SVID macro guards; native-only).
#include <cmath>
#ifdef SING
#undef SING
#endif
#ifdef DOMAIN
#undef DOMAIN
#endif
#ifdef OVERFLOW
#undef OVERFLOW
#endif
#ifdef UNDERFLOW
#undef UNDERFLOW
#endif
#ifdef TLOSS
#undef TLOSS
#endif
#ifdef PLOSS
#undef PLOSS
#endif
#include "OEM_generated.h"
#include "oem_fb_builder.hpp"

namespace ps = provider_source;

// ── Provider constants ──────────────────────────────────────────────────────

// IAC precise ephemeris, rolling "latest" product (SP3-d). NOTE (2026-07-13): the
// IAC HTTPS frontend (glonass-iac.ru) is returning 502; the live product is on
// the IAC anonymous FTP server. The host `http` capability performs the fetch, so
// the transport (ftp:// vs https://) is a host concern — see README (OWNER-ASSIST
// transport residual). `sourceUrl` overrides this default.
static const char* kDefaultSp3URL =
    "ftp://ftp.glonass-iac.ru/MCC/PRODUCTS/LATEST/Final.sp3";

static const char* kSigningKeySlot = "node-signing";
static const char* kPublishTopic = "sdn/data-source/glonass";

// One record per GLONASS satellite; cap bounds per-pull record churn. A GLONASS
// SP3 carries ~21-24 satellites, so the default emits the whole constellation.
static const long kDefaultObjectCap = 40;

extern "C" {
__attribute__((visibility("default")))
uint8_t* plugin_alloc(uint32_t size) { return static_cast<uint8_t*>(malloc(size)); }
__attribute__((visibility("default")))
void plugin_free(uint8_t* ptr, uint32_t /*size*/) { free(ptr); }
}  // extern "C"

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

std::string build_oem_record(const Sp3Meta& m, const SatEphem& sat,
                             const std::string& object_name) {
    const std::string& start = sat.states.empty() ? std::string() : sat.states.front().epoch;
    const std::string& stop = sat.states.empty() ? std::string() : sat.states.back().epoch;
    std::string s;
    s.reserve(sat.states.size() * 90 + 640);
    s += "{";
    s += "\"CCSDS_OEM_VERS\":2.0,";
    s += "\"CREATION_DATE\":\"" + ps::json_escape(m.creation_date) + "\",";
    s += "\"ORIGINATOR\":\"" + ps::json_escape(m.agency.empty() ? std::string("IAC") : m.agency) + "\",";
    s += "\"CLASSIFICATION\":\"UNCLASSIFIED\",";
    s += "\"EPHEMERIS_DATA_BLOCK\":[{";
    s += "\"COMMENT\":\"IAC GLONASS precise SP3-" + ps::json_escape(m.version) +
         " ephemeris. REFERENCE_FRAME + TIME_SYSTEM preserved AS DECLARED in the SP3 header ("
         + ps::json_escape(m.coord_system) + " / " + ps::json_escape(m.time_system) +
         "): IAC's precise product is IGS20 (an ITRF2020 realization) / GPS time, NOT PZ-90.11 / "
         "GLONASS time (that is the broadcast-nav frame). OD owns any frame transform (A2.2a). "
         "Position-only: SP3 has no velocity records (STATE_VECTOR_SIZE=3); clock dropped "
         "(not orbital). OBJECT_ID/NORAD_CAT_ID absent (SP3 carries only the GLONASS slot id).\",";
    s += "\"OBJECT_NAME\":\"" + ps::json_escape(object_name) + "\",";
    s += "\"OBJECT_ID\":\"\",";                    // no international designator in SP3
    s += "\"NORAD_CAT_ID\":0,";                    // GLONASS slot is not a NORAD id — not fabricated
    s += "\"CENTER_NAME\":\"EARTH\",";
    s += "\"REFERENCE_FRAME\":\"" + ps::json_escape(m.coord_system) + "\",";  // AS DECLARED
    s += "\"TIME_SYSTEM\":\"" + ps::json_escape(m.time_system) + "\",";       // AS DECLARED
    s += "\"START_TIME\":\"" + ps::json_escape(start) + "\",";
    s += "\"USEABLE_START_TIME\":\"" + ps::json_escape(start) + "\",";
    s += "\"USEABLE_STOP_TIME\":\"" + ps::json_escape(stop) + "\",";
    s += "\"STOP_TIME\":\"" + ps::json_escape(stop) + "\",";
    s += "\"STEP_SIZE\":0,";                        // verbose (explicit epoch per line)
    s += "\"STATE_VECTOR_SIZE\":3,";                // position-only (no fabricated velocity)
    s += "\"EPHEMERIS_DATA_LINES\":[";
    for (size_t i = 0; i < sat.states.size(); ++i) {
        const StateLine& st = sat.states[i];
        if (i) s += ",";
        s += "{\"EPOCH\":\"" + ps::json_escape(st.epoch) + "\",";
        s += "\"X\":" + ps::double_to_json(st.x) + ",";
        s += "\"Y\":" + ps::double_to_json(st.y) + ",";
        s += "\"Z\":" + ps::double_to_json(st.z) + "}";
    }
    s += "]}]}";
    return s;
}

// ── Config (optional, from the invoke request payload) ───────────────────────

struct PullConfig {
    long object_cap = kDefaultObjectCap;
    std::string source_url = kDefaultSp3URL;
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
    ps::HttpResult src = ps::http_get(cfg.source_url);

    // $OEM STREAM (in-memory, never stored): [u32le count] then count x
    // ( [u32le len][non-size-prefixed $OEM] ). One $OEM per GLONASS satellite.
    std::string stream(4, '\0');
    uint32_t count = 0;
    auto put_u32le = [](std::string& s, size_t at, uint32_t v) {
        s[at + 0] = static_cast<char>(v & 0xFF);
        s[at + 1] = static_cast<char>((v >> 8) & 0xFF);
        s[at + 2] = static_cast<char>((v >> 16) & 0xFF);
        s[at + 3] = static_cast<char>((v >> 24) & 0xFF);
    };

    if (src.status == 200 && !src.body.empty()) {
        std::string content(src.body.begin(), src.body.end());
        Sp3Meta meta;
        std::vector<SatEphem> sats;
        parse_sp3(content, &meta, &sats);
        for (const SatEphem& sat : sats) {
            if (sat.states.empty()) continue;
            if (static_cast<long>(count) >= cfg.object_cap) break;
            std::string object_name = "GLONASS " + sat.sat_id;
            std::vector<uint8_t> oem = build_oem_fb(sat, object_name);
            if (oem.empty()) continue;
            const size_t hdr = stream.size();
            stream.append(4, '\0');
            put_u32le(stream, hdr, static_cast<uint32_t>(oem.size()));
            stream.append(reinterpret_cast<const char*>(oem.data()), oem.size());
            count++;
        }
    }

    put_u32le(stream, 0, count);
    return stream;
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
