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
#include <algorithm>
#include <atomic>
#include <string>
#include <thread>
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


// Fetch policy (see README "Fetch politeness"): the DEFAULT object cap is
// UNLIMITED — the WASM-only OD flow has no host pager, so a default run (the tick
// the composed flow sends carries NO objectCap) must emit the ENTIRE Starlink
// constellation (~11k MEME entries) itself. `objectCap` stays an OPTIONAL invoke
// override for tests/ops: a positive value caps; <=0 means the whole catalog.
// Starlink is UNTHROTTLED — the >=2.5s/3h spacing policy is CelesTrak/Space-Track
// ONLY (hosts this provider never touches). The per-object spacing default is 0 so
// the full-catalog fetch is bounded by bandwidth, not an artificial delay.
// `fetchIntervalMs` is advisory only (the guest has no clock; the streaming path
// never busy-waits) and stays an optional override.
static const long kDefaultObjectCap = 0;        // 0 => unlimited (whole constellation)
static const long kDefaultFetchIntervalMs = 0;  // 0 => no artificial inter-object spacing
// The production artifact is wasi-threads. Sixty-four bounded workers matches
// the generic host's concurrently-live worker quota and is enough to keep the
// network busy without creating one thread per catalog object.
static const long kDefaultFetchConcurrency = 64;
// One full-file page at a time keeps raw OEM input bounded while OD and storage
// drain between pages. The generic flow scheduler resumes yielded pages.
static const long kDefaultFlowBatchSize = 64;

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

struct PullConfig {
    long object_cap = kDefaultObjectCap;   // <=0 => unlimited (emit the whole catalog)
    long fetch_interval_ms = kDefaultFetchIntervalMs;
    std::string manifest_url = kDefaultManifestURL;
    // Batch window into the manifest (host-driven concurrent batches). offset<0 or
    // count<0 => the whole [0, object_cap) span (legacy single-shot behavior).
    long offset = -1;
    long count = -1;
    long fetch_concurrency = kDefaultFetchConcurrency;
    long flow_batch_size = kDefaultFlowBatchSize;
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
    long concurrency = ps::json_number_field(json, "fetchConcurrency", -1);
    if (concurrency > 0) c.fetch_concurrency = std::min<long>(concurrency, 64);
    long batch_size = ps::json_number_field(json, "batchSize", -1);
    if (batch_size > 0) c.flow_batch_size = std::min<long>(batch_size, 64);
    // Deliberately ignore the retired rangeBytes option. Every object is fetched
    // with a plain GET and an HTTP 200 response before any fitting can occur.
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

struct PullRecords {
    std::vector<std::vector<uint8_t>> records;
};

std::vector<uint8_t> fetch_complete_oem(const std::string& filename) {
    const std::string url = std::string(kBaseURL) + filename;
    // A plain GET and HTTP 200 are mandatory. A 206 response is partial by
    // definition and is rejected so a proxy/upstream cannot silently restore a
    // prefix-only fit.
    ps::HttpResult obj = ps::http_get(url);
    if (obj.status != 200 || obj.body.empty()) return {};

    MemeMeta meta;
    parse_meme_filename(filename, &meta);
    std::vector<double> states;
    const std::string content(obj.body.begin(), obj.body.end());
    parse_meme(content, &meta, &states);
    if (states.empty()) return {};
    return build_oem_fb(meta, states);
}

PullRecords fetch_complete_span(const std::vector<std::string>& entries,
                                long start,
                                long end,
                                long requested_concurrency) {
    PullRecords out;
    if (start < 0) start = 0;
    if (end < start) end = start;
    const std::size_t span = static_cast<std::size_t>(end - start);
    if (span == 0) return out;

    std::vector<std::vector<uint8_t>> ordered(span);
    const std::size_t worker_count = std::min<std::size_t>(
        span, static_cast<std::size_t>(std::max<long>(1, requested_concurrency)));
    std::atomic<std::size_t> next{0};
    auto worker = [&]() {
        for (;;) {
            const std::size_t local = next.fetch_add(1, std::memory_order_relaxed);
            if (local >= span) break;
            ordered[local] = fetch_complete_oem(entries[static_cast<std::size_t>(start) + local]);
        }
    };

    // The flow guest is compiled with wasm atomics + wasi-threads. The separate
    // legacy Emscripten reactor is intentionally kept single-threaded for its JS
    // fixture harness, while native builds exercise the same bounded pool.
#if !defined(__wasm__) || defined(__wasm_atomics__) || defined(__EMSCRIPTEN_PTHREADS__)
    std::vector<std::thread> workers;
    workers.reserve(worker_count > 0 ? worker_count - 1 : 0);
    for (std::size_t i = 1; i < worker_count; ++i) workers.emplace_back(worker);
    worker();
    for (std::thread& thread : workers) thread.join();
#else
    worker();
#endif

    out.records.reserve(span);
    for (std::vector<uint8_t>& record : ordered) {
        if (!record.empty()) out.records.push_back(std::move(record));
    }
    return out;
}

std::string encode_oem_stream(const std::vector<std::vector<uint8_t>>& records) {
    std::size_t total_size = 4;
    for (const auto& record : records) total_size += 4 + record.size();
    std::string stream(4, '\0');
    stream.reserve(total_size);
    for (const auto& record : records) {
        const std::size_t header = stream.size();
        stream.append(4, '\0');
        put_u32le(stream, header, static_cast<uint32_t>(record.size()));
        stream.append(reinterpret_cast<const char*>(record.data()), record.size());
    }
    put_u32le(stream, 0, static_cast<uint32_t>(records.size()));
    return stream;
}

long limited_total(const PullConfig& cfg, const std::vector<std::string>& entries) {
    long total = static_cast<long>(entries.size());
    if (cfg.object_cap > 0 && total > cfg.object_cap) total = cfg.object_cap;
    return std::max<long>(0, total);
}

// Legacy/direct pull surface: still supports explicit offset/count benchmarking,
// but every selected object is fetched in full and the selected span is fetched
// concurrently. The composed flow uses run_flow_batch below to bound memory.
std::string run_pull(const uint8_t* req, uint32_t req_len) {
    const PullConfig cfg = parse_config(req, req_len);
    const ps::HttpResult manifest = ps::http_get(cfg.manifest_url);
    const std::vector<std::string> entries = ps::listing_lines(manifest.body, "MEME_");
    const long total = limited_total(cfg, entries);

    if (cfg.probe) {
        std::string result(4, '\0');
        put_u32le(result, 0, static_cast<uint32_t>(total));
        return result;
    }

    long start = cfg.offset >= 0 ? cfg.offset : 0;
    long end = cfg.count >= 0 ? start + cfg.count : total;
    start = std::min(start, total);
    end = std::min(end, total);
    return encode_oem_stream(
        fetch_complete_span(entries, start, end, cfg.fetch_concurrency).records);
}

struct FlowPullBatch {
    std::vector<std::vector<uint8_t>> records;
    uint32_t backlog_remaining = 0;
};

struct FlowPullState {
    PullConfig config;
    std::vector<std::string> entries;
    long next = 0;
    long total = 0;
    bool active = false;
};

FlowPullState g_flow_pull;

// Persistent WASM-only pager. The first timer/config frame captures the complete
// manifest. Each invocation performs one bounded, parallel, full-file page;
// emit_entry marks a positive backlog as yielded and the generic runtime resumes
// this function after downstream OD/storage have had a chance to drain.
FlowPullBatch run_flow_batch(const uint8_t* req, uint32_t req_len) {
    if (!g_flow_pull.active) {
        g_flow_pull.config = parse_config(req, req_len);
        const ps::HttpResult manifest = ps::http_get(g_flow_pull.config.manifest_url);
        g_flow_pull.entries = ps::listing_lines(manifest.body, "MEME_");
        g_flow_pull.total = limited_total(g_flow_pull.config, g_flow_pull.entries);
        g_flow_pull.next = 0;
        g_flow_pull.active = g_flow_pull.total > 0;
    }

    FlowPullBatch batch;
    if (!g_flow_pull.active) return batch;
    const long end = std::min(
        g_flow_pull.total, g_flow_pull.next + g_flow_pull.config.flow_batch_size);
    PullRecords fetched = fetch_complete_span(
        g_flow_pull.entries, g_flow_pull.next, end,
        g_flow_pull.config.fetch_concurrency);
    batch.records = std::move(fetched.records);
    g_flow_pull.next = end;
    batch.backlog_remaining = static_cast<uint32_t>(
        std::max<long>(0, g_flow_pull.total - g_flow_pull.next));
    if (batch.backlog_remaining == 0) {
        g_flow_pull.active = false;
        g_flow_pull.entries.clear();
    }
    return batch;
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
