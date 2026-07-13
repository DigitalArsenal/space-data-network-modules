/*
 * OneWeb (Eutelsat) data-source module (A2.2c, first Tier-1 adapter after
 * Starlink). On a TIMERS-driven `pull` it fetches OneWeb's public Long-Term
 * Ephemeris File (LTEF) — a single whole-fleet CSV at ephemeris.oneweb.net —
 * plans a capped set of per-satellite records, and for each emits a schema-exact
 * SDS OEM record, stores it, signs its content id, and publishes a schema-exact
 * PNM pointer, all on the shared provider-adapter template
 * (common/provider_source.hpp).
 *
 * ─── HONEST FORMAT FINDING (LTEF is an UNDOCUMENTED compact encoding) ────────
 * The LTEF `ltef.csv` is NOT a Cartesian state-vector ephemeris. It is a
 * proprietary, compact, fixed-point encoding: one row per fleet satellite
 * (~578), 17 integer columns, with NO public column specification (confirmed by
 * web search; CelesTrak ingests OneWeb-E but does not publish the decode).
 * Observed structure (from a live 2026-07-13 sample):
 *   c0  = OneWeb slot/index id (unique per satellite)
 *   c1  = element epoch, GPS-epoch seconds (1980-01-06, no leap-second offset)
 *   c2  = file reference epoch, GPS-epoch seconds (constant; == timestamp.txt)
 *   c3,c5,c7 = PER-PLANE parameters (exactly 12 distinct values == OneWeb's 12
 *              orbital planes); c7 behaves like RAAN (2^18 == 360deg scale,
 *              ~15deg/plane spanning 180deg — a Walker-star layout)
 *   c6  = 4096 (2^12) fixed-point scale constant
 *   c8  = per-satellite phase angle in [0, 2^18) (arg-of-latitude / mean anomaly)
 *   c4,c9,c10,c11,c16 = small per-plane/per-sat integers (rates / flags)
 *   c12..c15 = reserved (all zero in the sample)
 * The EPOCH decode is VALIDATED (c2 -> 2026-07-13T11:59:59Z reproduces the
 * feed's own timestamp.txt 2026-07-13T12:00:00.000). BUT there is NO public
 * mapping from these columns to semi-major axis / eccentricity / a physical
 * frame, so a Cartesian state-vector decode CANNOT be produced honestly.
 *
 * Per the A2.2a ethos (fail-closed, never fabricate): this adapter does NOT
 * invent state vectors. It emits a schema-exact OEM record carrying only the
 * HONESTLY-decodable metadata (slot -> OBJECT_NAME, GPS-time epoch, EARTH
 * center), with REFERENCE_FRAME = "UNKNOWN" and EMPTY EPHEMERIS_DATA_LINES, and
 * preserves the raw encoded row + full-file SHA-256 in signed provenance
 * (DECODE_STATUS = "unresolved-ltef-encoding") so a spec-based decoder can
 * reprocess without re-fetching. The physical decode is an OWNER-ASSIST residual
 * (obtain OneWeb's LTEF spec) — the same class of blocker as the Tier-2
 * data-access items in A2.1/A2.4. This is the honest, documented deliverable.
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

// OneWeb public LTEF (single whole-fleet CSV). timestamp.txt (at the site root)
// carries the last-update epoch; ltef.csv is the ephemeris payload.
static const char* kDefaultLtefURL = "https://ephemeris.oneweb.net/ltef/ltef.csv";

static const char* kSigningKeySlot = "node-signing";
static const char* kPublishTopic = "sdn/data-source/oneweb";

// Politeness: the whole fleet is one small (~45 KB) CSV, so fetch load is
// trivially bounded (a single GET per pull). objectCap instead bounds the number
// of per-satellite RECORDS emitted per pull (storage.write + pubsub churn). The
// fleet is ~520-578 objects; a conservative default of 40/pull cycles the whole
// fleet in ~15 pulls (~3.75 days at the 6h timer) without a churn spike.
static const long kDefaultObjectCap = 40;

// GPS-epoch (1980-01-06T00:00:00 UTC) expressed as Unix seconds. The LTEF stores
// continuous GPS-epoch seconds with NO leap-second correction; adding this
// offset reproduces the feed's own timestamp.txt wall-clock (validated).
static const long kGpsUnixOffsetSec = 315964800;

extern "C" {
__attribute__((visibility("default")))
uint8_t* plugin_alloc(uint32_t size) { return static_cast<uint8_t*>(malloc(size)); }
__attribute__((visibility("default")))
void plugin_free(uint8_t* ptr, uint32_t /*size*/) { free(ptr); }
}  // extern "C"

namespace {

// ── GPS-seconds → UTC ISO 8601 ───────────────────────────────────────────────

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

// Convert LTEF GPS-epoch seconds to a UTC ISO 8601 string (YYYY-MM-DDThh:mm:ssZ),
// no leap-second correction (matches OneWeb's own timestamp.txt convention).
std::string gps_seconds_to_iso(long gps_seconds) {
    long unix = gps_seconds + kGpsUnixOffsetSec;
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
    s.push_back('Z');
    return s;
}

// ── LTEF CSV parsing ─────────────────────────────────────────────────────────

struct LtefRow {
    std::string raw;              // verbatim CSV row (preserved for reprocessing)
    long slot = 0;                // c0
    long epoch_gps = 0;           // c1 (GPS-epoch seconds)
    long ref_epoch_gps = 0;       // c2 (GPS-epoch seconds)
    int ncols = 0;
    bool valid = false;
};

std::vector<std::string> split_commas(const std::string& line) {
    std::vector<std::string> out;
    size_t i = 0, start = 0;
    for (; i < line.size(); ++i) {
        if (line[i] == ',') { out.push_back(line.substr(start, i - start)); start = i + 1; }
    }
    out.push_back(line.substr(start));
    return out;
}

// Parse one LTEF line into the honestly-decodable fields. A valid row needs at
// least slot + epoch + ref-epoch (the encoded element columns are preserved raw
// but NOT decoded — see the file header).
LtefRow parse_ltef_row(const std::string& line) {
    LtefRow r;
    r.raw = line;
    std::vector<std::string> c = split_commas(line);
    r.ncols = static_cast<int>(c.size());
    if (c.size() < 3) return r;
    // slot + both epochs must be integers.
    char* end = nullptr;
    r.slot = strtol(c[0].c_str(), &end, 10);
    if (end == c[0].c_str() || c[0].empty()) return r;
    r.epoch_gps = strtol(c[1].c_str(), nullptr, 10);
    r.ref_epoch_gps = strtol(c[2].c_str(), nullptr, 10);
    if (r.epoch_gps <= 0) return r;
    r.valid = true;
    return r;
}

// Build the schema-exact OEM record shell for one OneWeb satellite. Honest:
// metadata only (no fabricated state vectors); REFERENCE_FRAME = "UNKNOWN";
// EPHEMERIS_DATA_LINES empty; a COMMENT documents the unresolved LTEF decode.
std::string build_oem_record(const LtefRow& r, const std::string& epoch_iso,
                             const std::string& object_name) {
    std::string s;
    s.reserve(768);
    s += "{";
    s += "\"CCSDS_OEM_VERS\":2.0,";
    s += "\"CREATION_DATE\":\"" + ps::json_escape(epoch_iso) + "\",";
    s += "\"ORIGINATOR\":\"OneWeb\",";
    s += "\"CLASSIFICATION\":\"UNCLASSIFIED\",";
    s += "\"EPHEMERIS_DATA_BLOCK\":[{";
    s += "\"COMMENT\":\"OneWeb LTEF compact encoding; physical state-vector decode "
         "UNRESOLVED (no public column spec). Raw encoded row + epoch preserved in "
         "signed provenance (DECODE_STATUS=unresolved-ltef-encoding).\",";
    s += "\"OBJECT_NAME\":\"" + ps::json_escape(object_name) + "\",";
    s += "\"OBJECT_ID\":\"\",";                 // LTEF carries no international designator
    s += "\"NORAD_CAT_ID\":0,";                 // LTEF carries no NORAD id
    s += "\"CENTER_NAME\":\"EARTH\",";
    s += "\"REFERENCE_FRAME\":\"UNKNOWN\",";    // LTEF declares no frame; decode unresolved
    s += "\"TIME_SYSTEM\":\"UTC\",";            // epoch converted GPS->UTC (validated)
    s += "\"START_TIME\":\"" + ps::json_escape(epoch_iso) + "\",";
    s += "\"STOP_TIME\":\"" + ps::json_escape(epoch_iso) + "\",";
    s += "\"STEP_SIZE\":0,";
    s += "\"STATE_VECTOR_SIZE\":6,";
    s += "\"EPHEMERIS_DATA_LINES\":[]";         // empty — decode unresolved (honest)
    s += "}]}";
    return s;
}

// ── Config (optional, from the invoke request payload) ───────────────────────

struct PullConfig {
    long object_cap = kDefaultObjectCap;
    std::string ltef_url = kDefaultLtefURL;
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
    if (ps::json_string_field(json, "ltefUrl", &url) && !url.empty()) c.ltef_url = url;
    return c;
}

// ── The pull method ──────────────────────────────────────────────────────────

std::string run_pull(const uint8_t* req, uint32_t req_len) {
    PullConfig cfg = parse_config(req, req_len);

    ps::ProviderConfig pcfg;
    pcfg.signing_slot = kSigningKeySlot;
    pcfg.publish_topic = kPublishTopic;
    pcfg.signature_type = "ed25519";
    pcfg.source_name = "oneweb";
    pcfg.data_source = "OneWeb-E";      // CelesTrak-comparable SOURCE token (A2.1)
    pcfg.record_schema = "OEM";

    ps::HttpResult ltef = ps::http_get(cfg.ltef_url);
    // Raw whole-file SHA-256 binds every per-satellite record's provenance to the
    // exact bytes fetched (the raw LTEF is never stored under a data schema).
    std::string source_sha256 =
        (ltef.status == 200 && !ltef.body.empty())
            ? ps::sha256_hex(ltef.body.data(), ltef.body.size())
            : std::string();

    // One record per LTEF row (marker "" -> every non-empty line).
    std::vector<std::string> lines = ps::listing_lines(ltef.body, "");

    long rows = 0, fetched = 0, stored = 0, signed_ = 0, published = 0;
    if (ltef.status == 200 && !ltef.body.empty()) fetched = 1;

    for (size_t li = 0; li < lines.size(); ++li) {
        LtefRow r = parse_ltef_row(lines[li]);
        if (!r.valid) continue;
        if (rows >= cfg.object_cap) break;   // per-pull record cap (churn bound)
        rows++;

        std::string epoch_iso = gps_seconds_to_iso(r.epoch_gps);
        std::string ref_iso = gps_seconds_to_iso(r.ref_epoch_gps);
        std::string object_name = "ONEWEB-" + std::to_string(r.slot);

        std::string oem = build_oem_record(r, epoch_iso, object_name);

        std::string file_id = pcfg.source_name + ":" + pcfg.record_schema + ":" +
                              std::to_string(r.slot) + ":" + epoch_iso;
        // Provenance preserves the raw encoded row + the honestly-decoded fields,
        // and flags the unresolved physical decode for a future spec-based pass.
        std::string provenance =
            std::string("{\"SOURCE_NAME\":\"") + ps::json_escape(pcfg.source_name) + "\"," +
            "\"SOURCE_URL\":\"" + ps::json_escape(cfg.ltef_url) + "\"," +
            "\"SOURCE_SHA256\":\"" + source_sha256 + "\"," +
            "\"DATA_SOURCE\":\"" + ps::json_escape(pcfg.data_source) + "\"," +
            "\"RECORD_SCHEMA\":\"" + ps::json_escape(pcfg.record_schema) + "\"," +
            "\"OBJECT_NAME\":\"" + ps::json_escape(object_name) + "\"," +
            "\"LTEF_SLOT\":" + std::to_string(r.slot) + "," +
            "\"LTEF_COLUMNS\":" + std::to_string(r.ncols) + "," +
            "\"LTEF_EPOCH_GPS\":" + std::to_string(r.epoch_gps) + "," +
            "\"LTEF_EPOCH_UTC\":\"" + epoch_iso + "\"," +
            "\"LTEF_REF_EPOCH_GPS\":" + std::to_string(r.ref_epoch_gps) + "," +
            "\"LTEF_REF_EPOCH_UTC\":\"" + ref_iso + "\"," +
            "\"LTEF_RAW\":\"" + ps::json_escape(r.raw) + "\"," +
            "\"DECODE_STATUS\":\"unresolved-ltef-encoding\"}";

        ps::PublishResult pr = ps::publish_record(
            pcfg,
            reinterpret_cast<const uint8_t*>(oem.data()), oem.size(),
            "ltef.csv", file_id, epoch_iso, provenance);
        if (pr.stored) stored++;
        if (pr.signed_) signed_++;
        if (pr.published) published++;
    }

    return std::string("{\"ok\":true,\"source\":\"") + pcfg.source_name + "\"," +
           "\"fetch_status\":" + std::to_string(ltef.status) + "," +
           "\"ltef_rows\":" + std::to_string(static_cast<long>(lines.size())) + "," +
           "\"object_cap\":" + std::to_string(cfg.object_cap) + "," +
           "\"record_schema\":\"" + pcfg.record_schema + "\"," +
           "\"decode_status\":\"unresolved-ltef-encoding\"," +
           "\"fetched\":" + std::to_string(fetched) + "," +
           "\"records\":" + std::to_string(rows) + "," +
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
