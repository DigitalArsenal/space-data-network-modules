/*
 * SpaceX Starlink data-source module (WS5, finished A2.2b).
 *
 * The `pull` method (TIMERS-driven, provider-agnostic scheduler) fetches the
 * SpaceX/Starlink public ephemeris MANIFEST, plans a capped + polite per-object
 * fetch, then for each object:
 *   1. GETs the raw MEME ephemeris file (SpaceX's internal operator-ephemeris
 *      text format),
 *   2. parses it into a canonical CCSDS OEM record (compact row-major format,
 *      schema-exact keys) — the honest SDS type for operator state-vector
 *      ephemeris; the RAW MEME text is NOT stored under a mislabeled schema
 *      (the A2.1-flagged placeholder), it is bound into signed provenance by
 *      SHA-256 (DPM `SOURCE_SHA256` convention),
 *   3. stores the OEM record (storage.write), signs its content id via the
 *      keyslot.sign host-side crypto oracle, and publishes a schema-exact
 *      Publish Notification Message (PNM) pointer on the pubsub topic.
 *
 * The fetch/hash/store/sign/publish skeleton lives in provider_source.hpp so
 * the A2.2c Tier-1 adapters (OneWeb LTEF, ISS OEM, ...) reuse it; only the
 * MEME-specific parse + OEM mapping stays here.
 *
 * Hostcall ABI (space_data_module_host): see common/sdm_hostcall_wire.hpp.
 */
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string>
#include <vector>

#include "provider_source.hpp"
#include "meme_oem.hpp"

namespace ps = provider_source;

// ── Provider constants ──────────────────────────────────────────────────────

// SpaceX Starlink public ephemeris listing (discover endpoint): MANIFEST.txt
// lists one MEME ephemeris filename per line (the bare directory URL 404s).
static const char* kBaseURL = "https://api.starlink.com/public-files/ephemerides/";
static const char* kDefaultManifestURL =
    "https://api.starlink.com/public-files/ephemerides/MANIFEST.txt";


// Fetch politeness (see README "Fetch politeness"): a small per-pull object cap
// bounds burst load, and the manifest MEME cadence (regenerated a few times
// daily) plus the module TIMERS cadence bound pulls/day. Both are configurable
// via the invoke request payload; the guest is synchronous with no clock, so
// intra-pull pacing (`fetchIntervalMs`) is an advisory the host scheduler can
// honor — it is echoed in the summary but never busy-waits.
static const long kDefaultObjectCap = 25;
static const long kDefaultFetchIntervalMs = 2000;

extern "C" {
// Guest allocator used by the host to pass request/response buffers.
__attribute__((visibility("default")))
uint8_t* plugin_alloc(uint32_t size) { return static_cast<uint8_t*>(malloc(size)); }
__attribute__((visibility("default")))
void plugin_free(uint8_t* ptr, uint32_t /*size*/) { free(ptr); }
}  // extern "C"

namespace {

// ── MEME parsing (SpaceX-specific) ───────────────────────────────────────────

using namespace meme_oem;  // MemeMeta/parse_meme/build_oem_fb (src/meme_oem.hpp)

// Build the canonical CCSDS OEM record (compact row-major format) as a
// schema-exact JSON document. Keys mirror the SDS OEM schema
// (OEM.EPHEMERIS_DATA_BLOCK[].{ CENTER_NAME, REFERENCE_FRAME, TIME_SYSTEM,
// START_TIME, STOP_TIME, STEP_SIZE, STATE_VECTOR_SIZE, EPHEMERIS_DATA } plus
// ── Config (optional, from the invoke request payload) ───────────────────────

// Per-object range-fetch cap: only the first ~2-3 orbits of the multi-day MEME
// file are needed (the OD fit windows to ~2 orbits internally and the accuracy is
// lossless — see analysis/od test_downsample_accuracy). 128 KiB of a Starlink MEME
// (~118 B/line, 4 lines/state) is ~270 states ≈ ~4.5 h ≈ ~2.8 orbits. api.starlink.com
// honors byte ranges (HTTP 206), cutting per-object download ~16x (2 MB -> 128 KB).
static const long kDefaultRangeBytes = 131072;

struct PullConfig {
    long object_cap = kDefaultObjectCap;   // upper bound on total objects considered
    long fetch_interval_ms = kDefaultFetchIntervalMs;
    std::string manifest_url = kDefaultManifestURL;
    // Batch window into the manifest (host-driven concurrent batches). offset<0 or
    // count<0 => the whole [0, object_cap) span (legacy single-shot behavior).
    long offset = -1;
    long count = -1;
    long range_bytes = kDefaultRangeBytes; // 0 => full file (no Range header)
    bool probe = false;                    // true => return only the total object count (u32le)
};

PullConfig parse_config(const uint8_t* req, uint32_t len) {
    PullConfig c;
    if (req == nullptr || len == 0) return c;
    // Only interpret a JSON object; a binary PIV request leaves defaults intact.
    size_t i = 0;
    while (i < len && (req[i] == ' ' || req[i] == '\n' || req[i] == '\t' || req[i] == '\r')) i++;
    if (i >= len || req[i] != '{') return c;
    std::string json(reinterpret_cast<const char*>(req), len);
    long cap = ps::json_number_field(json, "objectCap", -1);
    if (cap > 0) c.object_cap = cap;
    long iv = ps::json_number_field(json, "fetchIntervalMs", -1);
    if (iv >= 0) c.fetch_interval_ms = iv;
    std::string url;
    if (ps::json_string_field(json, "manifestUrl", &url) && !url.empty()) c.manifest_url = url;
    long off = ps::json_number_field(json, "offset", -1);
    if (off >= 0) c.offset = off;
    long cnt = ps::json_number_field(json, "count", -1);
    if (cnt >= 0) c.count = cnt;
    long rb = ps::json_number_field(json, "rangeBytes", -1);
    if (rb >= 0) c.range_bytes = rb;
    if (json.find("\"probe\":true") != std::string::npos) c.probe = true;
    return c;
}

// put_u32le appends a little-endian u32 at byte offset `at` in `s`.
static inline void put_u32le(std::string& s, size_t at, uint32_t v) {
    s[at + 0] = static_cast<char>(v & 0xFF);
    s[at + 1] = static_cast<char>((v >> 8) & 0xFF);
    s[at + 2] = static_cast<char>((v >> 16) & 0xFF);
    s[at + 3] = static_cast<char>((v >> 24) & 0xFF);
}

// ── The pull method ──────────────────────────────────────────────────────────

std::string run_pull(const uint8_t* req, uint32_t req_len) {
    PullConfig cfg = parse_config(req, req_len);

    ps::HttpResult manifest = ps::http_get(cfg.manifest_url);
    std::vector<std::string> entries = ps::listing_lines(manifest.body, "MEME_");

    // Total objects this pull is willing to cover (bounded by the object cap).
    long total = static_cast<long>(entries.size());
    if (total > cfg.object_cap) total = cfg.object_cap;
    if (total < 0) total = 0;

    // Probe mode: the host learns how many objects exist so it can schedule
    // concurrent [offset,count) batches. Return the total as a bare u32le.
    if (cfg.probe) {
        std::string out(4, '\0');
        put_u32le(out, 0, static_cast<uint32_t>(total));
        return out;
    }

    // Batch window into the manifest. Default (offset<0 / count<0) = the whole
    // [0,total) span (legacy single-shot). Host-driven batches pass explicit
    // offset+count so many small pulls run concurrently with bounded memory.
    long start = (cfg.offset >= 0) ? cfg.offset : 0;
    long end = (cfg.count >= 0) ? (start + cfg.count) : total;
    if (start > total) start = total;
    if (end > total) end = total;

    // Emit an $OEM STREAM, never a store: fetch + parse + build one aligned-binary
    // SDS $OEM per object and frame it into a length-prefixed stream the OD runner
    // splits into the transient per-object set fed to the FlowPool. Ephemeris is
    // in-memory only (SDN OD-flow invariant) — no storage.write / sign / publish;
    // provenance rides on the RESULT $OMM/$OCM/$OBD the OD flow's store node writes.
    // Stream layout: [u32le count]  then count x ( [u32le len][non-size-prefixed $OEM] ).
    std::string stream(4, '\0');  // reserve the count header
    uint32_t count = 0;

    for (long i = start; i < end; ++i) {
        const std::string& filename = entries[static_cast<size_t>(i)];
        std::string url = std::string(kBaseURL) + filename;
        // Range-fetch only the fit window (first ~2-3 orbits) unless rangeBytes==0.
        ps::HttpResult obj = (cfg.range_bytes > 0)
                                 ? ps::http_get_range(url, cfg.range_bytes)
                                 : ps::http_get(url);
        // Range servers reply 206 (partial); non-range servers reply 200 (full).
        if ((obj.status != 200 && obj.status != 206) || obj.body.empty()) continue;

        MemeMeta m;
        parse_meme_filename(filename, &m);
        std::vector<double> states;
        std::string content(obj.body.begin(), obj.body.end());
        parse_meme(content, &m, &states);  // drops the truncated trailing record
        if (states.empty()) continue;

        std::vector<uint8_t> oem = build_oem_fb(m, states);  // in-memory $OEM (TEME)
        if (oem.empty()) continue;

        const size_t hdr = stream.size();
        stream.append(4, '\0');
        put_u32le(stream, hdr, static_cast<uint32_t>(oem.size()));
        stream.append(reinterpret_cast<const char*>(oem.data()), oem.size());
        count++;
    }

    put_u32le(stream, 0, count);
    return stream;
}

}  // namespace

extern "C" {

// Canonical streaming invoke entrypoint. The TIMERS `pull` entry (and any manual
// invoke) triggers a capped, polite discover+fetch+store+sign+publish cycle.
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
