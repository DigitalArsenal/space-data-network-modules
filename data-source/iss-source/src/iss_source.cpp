/*
 * ISS (NASA public OEM) data-source module (A2.2c, second Tier-1 adapter).
 *
 * For each run this fetches the single public NASA ISS ephemeris
 * file — a CCSDS OEM KVN document — and re-emits it as a schema-exact SDS OEM
 * record. Unlike the SpaceX Starlink adapter there is no manifest and no
 * per-object loop: the ISS is a single object (NORAD 25544) and the source is
 * already an OEM, so the "parser" faithfully re-serializes it.
 *
 * FRAME/TIME (honest, per A2.2a frame handling): the NASA OEM declares
 * REF_FRAME = EME2000, TIME_SYSTEM = UTC, CENTER = Earth. We preserve those as
 * declared — REFERENCE_FRAME = "EME2000" — and DO NOT transform to TEME here;
 * the OD side owns the EME2000->TEME transform (validated in A2.2a). The raw
 * OEM text is never relabelled.
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
 * TYPED CONTRACTS 1.0 (FlatBuffers only, no JSON, no base64): the module makes no
 * fetch and no store itself. `request` turns the flow's TimerTick (TICK) into a GET
 * HttpRequest (HREQ) for hostcap/http-request; `emit` turns the
 * HttpResponse (HRSP) into $OEM FlatBuffers on "oem", consumed in memory by
 * analysis/od.fit. Nothing is stored, signed or published (the former `pull`
 * path declared a $PNM it never produced and is gone). Node config (sourceUrl) is
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

// SDS $OEM FlatBuffer + the shared builder. math.h SVID macros (SING/DOMAIN/…)
// collide with generated enum ids on native builds; undef before the generated
// header (the em++/WASI sysroot is clean).
#include <cmath>

namespace R = sdn::runtime;

// ── Provider constants ──────────────────────────────────────────────────────

// NASA public ISS ephemeris (CCSDS OEM KVN, EME2000/UTC, ~4-min steps, 15-day
// span). Single file, no manifest.
static const char* kDefaultSourceURL =
    "https://nasa-public-data.s3.amazonaws.com/iss-coords/current/ISS_OEM/ISS.OEM_J2K_EPH.txt";


// The ISS is a single, well-known object; NORAD 25544 is canonical and is NOT
// carried in the OEM file, so it is a constant here (per the A2.2c FILE_ID
// convention iss:OEM:25544:<epoch>).
static const long kIssNoradCatId = 25544;

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

// request: a TimerTick (its fields are not read) -> the GET of the ISS OEM (config sourceUrl, default NASA's).
int request(void) {
    const sdm_piv::Config config = sdm_piv::get_config();
    return push_get("request", config_text(config, "sourceUrl", kDefaultSourceURL)) < 0 ? 1 : 0;
}

// emit: the HttpResponse of that GET -> one $OEM (verbose, EME2000/UTC as declared). Nothing is stored.
int emit(void) {
    const R::HttpResponse* response = response_on("response", "the ISS OEM");
    if (!response) return 1;
    OemMeta m;
    std::vector<StateLine> states;
    parse_oem(body_of(*response), &m, &states);
    if (states.empty()) return fail("fetch-empty", "no fittable $OEM objects from provider: the OEM has no state vectors");
    const std::vector<uint8_t> oem = build_oem_fb(m, states);
    if (oem.empty()) return fail("fetch-empty", "no fittable $OEM objects from provider");
    return push_oem(oem) < 0 ? 1 : 0;
}

}  // extern "C"
