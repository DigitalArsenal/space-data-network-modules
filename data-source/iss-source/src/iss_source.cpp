/*
 * ISS (NASA public OEM) data-source module (A2.2c, second Tier-1 adapter).
 *
 * On a TIMERS-driven `pull` this fetches the single public NASA ISS ephemeris
 * file — a CCSDS OEM KVN document — and re-emits it as a schema-exact SDS OEM
 * record, then stores it, signs its content id, and publishes a schema-exact
 * PNM pointer. Unlike the SpaceX Starlink adapter there is no manifest and no
 * per-object loop: the ISS is a single object (NORAD 25544) and the source is
 * already an OEM, so the "parser" faithfully re-serializes it.
 *
 * FRAME/TIME (honest, per A2.2a frame handling): the NASA OEM declares
 * REF_FRAME = EME2000, TIME_SYSTEM = UTC, CENTER = Earth. We preserve those as
 * declared — REFERENCE_FRAME = "EME2000" — and DO NOT transform to TEME here;
 * the OD side owns the EME2000->TEME transform (validated in A2.2a). The raw
 * OEM text is bound into signed provenance by SHA-256 (never mislabeled).
 *
 * REPRESENTATION: the NASA ISS OEM carries an explicit epoch on every state
 * line and is NON-uniform in time (mostly 240 s / 4-min steps, but with shorter
 * steps around ascending-node boundaries / reboosts). The faithful SDS OEM
 * representation is therefore the VERBOSE format (STEP_SIZE = 0 +
 * EPHEMERIS_DATA_LINES with an explicit EPOCH per state), not Starlink's compact
 * row-major array. Both are first-class in the SDS OEM schema; verbose is the
 * correct choice for an explicit-epoch, possibly-non-uniform source and avoids
 * any reconstruction drift.
 *
 * The fetch/hash/store/sign/publish skeleton lives in the shared
 * common/provider_source.hpp (promoted from spacex-starlink-source in A2.2c);
 * only the OEM-KVN parse + verbose-OEM mapping stay here.
 *
 * Hostcall ABI (space_data_module_host): see common/sdm_hostcall_wire.hpp.
 */
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string>
#include <vector>

#include "provider_source.hpp"

// SDS $OEM FlatBuffer + the shared builder. math.h SVID macros (SING/DOMAIN/…)
// collide with generated enum ids on native builds; undef before the generated
// header (the em++/WASI sysroot is clean).
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

// NASA public ISS ephemeris (CCSDS OEM KVN, EME2000/UTC, ~4-min steps, 15-day
// span). Single file, no manifest.
static const char* kDefaultSourceURL =
    "https://nasa-public-data.s3.amazonaws.com/iss-coords/current/ISS_OEM/ISS.OEM_J2K_EPH.txt";

// Node signing key slot (host-side only) used to sign published PNMs.
static const char* kSigningKeySlot = "node-signing";
// PubSub topic the module publishes PNM pointers on.
static const char* kPublishTopic = "sdn/data-source/iss";

// The ISS is a single, well-known object; NORAD 25544 is canonical and is NOT
// carried in the OEM file, so it is a constant here (per the A2.2c FILE_ID
// convention iss:OEM:25544:<epoch>).
static const long kIssNoradCatId = 25544;

extern "C" {
// Guest allocator used by the host to pass request/response buffers.
__attribute__((visibility("default")))
uint8_t* plugin_alloc(uint32_t size) { return static_cast<uint8_t*>(malloc(size)); }
__attribute__((visibility("default")))
void plugin_free(uint8_t* ptr, uint32_t /*size*/) { free(ptr); }
}  // extern "C"

namespace {

// ── CCSDS OEM KVN parsing (ISS-specific, minimal) ────────────────────────────

struct OemMeta {
    std::string creation_date;   // header CREATION_DATE
    std::string originator;      // header ORIGINATOR
    std::string object_name;     // META OBJECT_NAME
    std::string object_id;       // META OBJECT_ID (intl designator, e.g. 1998-067-A)
    std::string center_name;     // META CENTER_NAME (normalized to EARTH)
    std::string reference_frame; // META REF_FRAME (as declared, e.g. EME2000)
    std::string time_system;     // META TIME_SYSTEM (e.g. UTC)
    std::string start_time;      // META START_TIME
    std::string useable_start;   // META USEABLE_START_TIME
    std::string useable_stop;    // META USEABLE_STOP_TIME
    std::string stop_time;       // META STOP_TIME
};

// One explicit-epoch state line (verbose OEM).
struct StateLine {
    std::string epoch;
    double x = 0, y = 0, z = 0, vx = 0, vy = 0, vz = 0;
};

std::string trim(const std::string& in) {
    size_t a = in.find_first_not_of(" \t\r\n");
    size_t b = in.find_last_not_of(" \t\r\n");
    if (a == std::string::npos) return std::string();
    return in.substr(a, b - a + 1);
}

// KVN "KEY = VALUE" extractor: if `line` begins (after leading space) with
// `key` followed by '=', returns the trimmed value.
bool kvn_value(const std::string& line, const char* key, std::string* out) {
    std::string t = trim(line);
    size_t klen = 0; while (key[klen]) klen++;
    if (t.compare(0, klen, key) != 0) return false;
    size_t i = klen;
    while (i < t.size() && (t[i] == ' ' || t[i] == '\t')) i++;
    if (i >= t.size() || t[i] != '=') return false;
    *out = trim(t.substr(i + 1));
    return true;
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

// A state line's first token is an ISO 8601 epoch (starts with 4 digits + a
// 'T'); distinct from KVN keys, COMMENTs, and section markers.
bool is_state_line(const std::string& t) {
    if (t.size() < 5) return false;
    for (int i = 0; i < 4; ++i) if (t[i] < '0' || t[i] > '9') return false;
    return t.find('T') != std::string::npos && t.find('=') == std::string::npos;
}

// Parse the ISS CCSDS OEM KVN: header + the (single) META block + explicit-epoch
// state lines. COMMENT lines and the trajectory-event summary are skipped for
// the canonical record (the raw bytes are preserved by SHA-256 in provenance).
void parse_oem(const std::string& content, OemMeta* m, std::vector<StateLine>* states) {
    size_t pos = 0;
    bool in_meta = false;
    std::string line, v;
    while (pos <= content.size()) {
        size_t nl = content.find('\n', pos);
        line = content.substr(pos, (nl == std::string::npos ? content.size() : nl) - pos);
        pos = (nl == std::string::npos) ? content.size() + 1 : nl + 1;
        std::string t = trim(line);
        if (t.empty() || t.compare(0, 7, "COMMENT") == 0) continue;
        if (t == "META_START") { in_meta = true; continue; }
        if (t == "META_STOP") { in_meta = false; continue; }
        if (in_meta) {
            if (kvn_value(line, "OBJECT_NAME", &v)) m->object_name = v;
            else if (kvn_value(line, "OBJECT_ID", &v)) m->object_id = v;
            else if (kvn_value(line, "CENTER_NAME", &v)) m->center_name = v;
            else if (kvn_value(line, "REF_FRAME", &v)) m->reference_frame = v;
            else if (kvn_value(line, "TIME_SYSTEM", &v)) m->time_system = v;
            else if (kvn_value(line, "USEABLE_START_TIME", &v)) m->useable_start = v;
            else if (kvn_value(line, "USEABLE_STOP_TIME", &v)) m->useable_stop = v;
            else if (kvn_value(line, "START_TIME", &v)) m->start_time = v;
            else if (kvn_value(line, "STOP_TIME", &v)) m->stop_time = v;
            continue;
        }
        // Header KVN (before the first META_START).
        if (kvn_value(line, "CREATION_DATE", &v)) { m->creation_date = v; continue; }
        if (kvn_value(line, "ORIGINATOR", &v)) { m->originator = v; continue; }
        // State line (after META_STOP).
        if (is_state_line(t)) {
            std::vector<std::string> tok = split_ws(t);
            if (tok.size() >= 7) {
                StateLine s;
                s.epoch = tok[0];
                s.x = strtod(tok[1].c_str(), nullptr);
                s.y = strtod(tok[2].c_str(), nullptr);
                s.z = strtod(tok[3].c_str(), nullptr);
                s.vx = strtod(tok[4].c_str(), nullptr);
                s.vy = strtod(tok[5].c_str(), nullptr);
                s.vz = strtod(tok[6].c_str(), nullptr);
                states->push_back(s);
            }
        }
    }
}

// Normalize a CENTER_NAME to the SDS uppercase convention ("Earth" -> "EARTH").
std::string upper_center(const std::string& in) {
    std::string s = in;
    for (char& c : s) if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
    return s;
}

// Build the canonical CCSDS OEM record (VERBOSE format, explicit epochs) as a
// schema-exact JSON document. Keys mirror the SDS OEM schema: OEM.{CLASSIFICATION,
// CCSDS_OEM_VERS, CREATION_DATE, ORIGINATOR, EPHEMERIS_DATA_BLOCK[]}, and each
// block's { OBJECT_NAME, OBJECT_ID, NORAD_CAT_ID, CENTER_NAME, REFERENCE_FRAME,
// TIME_SYSTEM, START_TIME, USEABLE_START_TIME, USEABLE_STOP_TIME, STOP_TIME,
// STEP_SIZE(=0), STATE_VECTOR_SIZE, EPHEMERIS_DATA_LINES[] } (mirroring the
// A2.2b Starlink adapter's flattened-OBJECT decision, extended to verbose lines).
// Build a NON-size-prefixed SDS $OEM FlatBuffer for the ISS OEM: verbose form
// (per-line EPOCH, non-uniform cadence), EME2000/UTC/EARTH — the honest declared
// frame (the OD reader rotates EME2000 -> TEME). StateLine feeds the shared builder
// template directly (.epoch/.x/.y/.z/.vx/.vy/.vz). Ephemeris in-memory only.
std::vector<uint8_t> build_oem_fb(const OemMeta& m, const std::vector<StateLine>& states) {
    const oem_fb::Identity id{m.object_name.c_str(), m.object_id.c_str(),
                              static_cast<uint32_t>(kIssNoradCatId)};
    return oem_fb::build_oem_flatbuffer(id, CelestialFrame::EME2000, "EARTH",
                                        timingStandard::UTC, states.data(),
                                        static_cast<int>(states.size()));
}

// ── Config (optional, from the invoke request payload) ───────────────────────

struct PullConfig {
    std::string source_url = kDefaultSourceURL;
};

PullConfig parse_config(const uint8_t* req, uint32_t len) {
    PullConfig c;
    if (req == nullptr || len == 0) return c;
    size_t i = 0;
    while (i < len && (req[i] == ' ' || req[i] == '\n' || req[i] == '\t' || req[i] == '\r')) i++;
    if (i >= len || req[i] != '{') return c;  // binary PIV request leaves defaults intact
    std::string json(reinterpret_cast<const char*>(req), len);
    std::string url;
    if (ps::json_string_field(json, "sourceUrl", &url) && !url.empty()) c.source_url = url;
    return c;
}

// ── The pull method ──────────────────────────────────────────────────────────

std::string run_pull(const uint8_t* req, uint32_t req_len) {
    PullConfig cfg = parse_config(req, req_len);
    ps::HttpResult src = ps::http_get(cfg.source_url);

    // Emit an $OEM STREAM (in-memory, never stored): [u32le count] then
    // count x ( [u32le len][non-size-prefixed $OEM] ). ISS is a single object.
    std::string stream(4, '\0');
    uint32_t count = 0;
    auto put_u32le = [](std::string& s, size_t at, uint32_t v) {
        s[at + 0] = static_cast<char>(v & 0xFF);
        s[at + 1] = static_cast<char>((v >> 8) & 0xFF);
        s[at + 2] = static_cast<char>((v >> 16) & 0xFF);
        s[at + 3] = static_cast<char>((v >> 24) & 0xFF);
    };

    if (src.status == 200 && !src.body.empty()) {
        OemMeta m;
        std::vector<StateLine> states;
        std::string content(src.body.begin(), src.body.end());
        parse_oem(content, &m, &states);
        if (!states.empty()) {
            std::vector<uint8_t> oem = build_oem_fb(m, states);
            if (!oem.empty()) {
                const size_t hdr = stream.size();
                stream.append(4, '\0');
                put_u32le(stream, hdr, static_cast<uint32_t>(oem.size()));
                stream.append(reinterpret_cast<const char*>(oem.data()), oem.size());
                count++;
            }
        }
    }

    put_u32le(stream, 0, count);
    return stream;
}

}  // namespace

extern "C" {

// Canonical streaming invoke entrypoint. The TIMERS `pull` entry (and any manual
// invoke) triggers a fetch+parse+store+sign+publish cycle for the single ISS OEM.
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
