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

// Node signing key slot (host-side only) used to sign published PNMs.
static const char* kSigningKeySlot = "node-signing";
// PubSub topic the module publishes PNM pointers on (unchanged publisher topic).
static const char* kPublishTopic = "sdn/data-source/spacex-starlink";

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
// OBJECT identity). MEME state vectors are effectively TEME (validated by the
// OD module's <1 m fit RMS); the "UVW" label is the covariance frame only.
std::string build_oem_record(const MemeMeta& m, const std::vector<double>& states) {
    std::string s;
    s.reserve(states.size() * 20 + 512);
    s += "{";
    s += "\"CCSDS_OEM_VERS\":2.0,";
    s += "\"CREATION_DATE\":\"" + ps::json_escape(m.created_iso) + "\",";
    s += "\"ORIGINATOR\":\"SpaceX\",";
    s += "\"CLASSIFICATION\":\"UNCLASSIFIED\",";
    s += "\"EPHEMERIS_DATA_BLOCK\":[{";
    s += "\"OBJECT_NAME\":\"" + ps::json_escape(m.object_name) + "\",";
    s += "\"OBJECT_ID\":\"\",";  // MEME COSPAR field is SpaceX-internal; not an intl designator
    s += "\"NORAD_CAT_ID\":" + std::to_string(m.norad_cat_id) + ",";
    s += "\"CENTER_NAME\":\"EARTH\",";
    s += "\"REFERENCE_FRAME\":\"TEME\",";
    s += "\"TIME_SYSTEM\":\"UTC\",";
    s += "\"START_TIME\":\"" + ps::json_escape(m.start_iso) + "\",";
    s += "\"STOP_TIME\":\"" + ps::json_escape(m.stop_iso) + "\",";
    s += "\"STEP_SIZE\":" + std::to_string(m.step_size > 0 ? m.step_size : 60) + ",";
    s += "\"STATE_VECTOR_SIZE\":6,";
    s += "\"EPHEMERIS_DATA\":[";
    for (size_t i = 0; i < states.size(); ++i) {
        if (i) s += ",";
        s += ps::double_to_json(states[i]);
    }
    s += "]}]}";
    return s;
}

// ── Config (optional, from the invoke request payload) ───────────────────────

struct PullConfig {
    long object_cap = kDefaultObjectCap;
    long fetch_interval_ms = kDefaultFetchIntervalMs;
    std::string manifest_url = kDefaultManifestURL;
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
    return c;
}

// ── The pull method ──────────────────────────────────────────────────────────

std::string run_pull(const uint8_t* req, uint32_t req_len) {
    PullConfig cfg = parse_config(req, req_len);

    ps::ProviderConfig pcfg;
    pcfg.signing_slot = kSigningKeySlot;
    pcfg.publish_topic = kPublishTopic;
    pcfg.signature_type = "ed25519";     // must match the node-signing slot's key
    pcfg.source_name = "spacex-starlink";
    pcfg.data_source = "SpaceX-E";        // CelesTrak-comparable SOURCE token (A2.1)
    pcfg.record_schema = "OEM";           // honest canonical SDS type for operator ephemeris

    ps::HttpResult manifest = ps::http_get(cfg.manifest_url);
    std::vector<std::string> entries = ps::listing_lines(manifest.body, "MEME_");

    long fetched = 0, stored = 0, signed_ = 0, published = 0;
    long plan = static_cast<long>(entries.size());
    if (plan > cfg.object_cap) plan = cfg.object_cap;  // per-pull politeness cap

    for (long i = 0; i < plan; ++i) {
        const std::string& filename = entries[static_cast<size_t>(i)];
        std::string url = std::string(kBaseURL) + filename;
        ps::HttpResult obj = ps::http_get(url);
        if (obj.status != 200 || obj.body.empty()) continue;  // skip; halt-friendly per object
        fetched++;

        MemeMeta m;
        parse_meme_filename(filename, &m);
        std::vector<double> states;
        std::string content(obj.body.begin(), obj.body.end());
        parse_meme(content, &m, &states);
        if (states.empty()) continue;  // nothing canonical to publish

        // Raw source artifact is bound into signed provenance by SHA-256, not
        // stored under a data schema (no honest raw-blob SDS type exists; the
        // OEM-mislabel of the raw bytes was the A2.1-flagged placeholder bug).
        std::string source_sha256 = ps::sha256_hex(obj.body.data(), obj.body.size());

        std::string oem = build_oem_record(m, states);

        std::string file_id = pcfg.source_name + ":" + pcfg.record_schema + ":" +
                              std::to_string(m.norad_cat_id) + ":" + m.start_iso;
        std::string provenance =
            std::string("{\"SOURCE_NAME\":\"") + ps::json_escape(pcfg.source_name) + "\"," +
            "\"SOURCE_URL\":\"" + ps::json_escape(url) + "\"," +
            "\"SOURCE_SHA256\":\"" + source_sha256 + "\"," +
            "\"DATA_SOURCE\":\"" + ps::json_escape(pcfg.data_source) + "\"," +
            "\"RECORD_SCHEMA\":\"" + ps::json_escape(pcfg.record_schema) + "\"," +
            "\"NORAD_CAT_ID\":" + std::to_string(m.norad_cat_id) + "," +
            "\"OBJECT_NAME\":\"" + ps::json_escape(m.object_name) + "\"," +
            "\"OBJECT_STATUS\":\"" + ps::json_escape(m.status) + "\"," +
            "\"EPHEMERIS_SOURCE\":\"" + ps::json_escape(m.ephemeris_source) + "\"," +
            "\"STATE_COUNT\":" + std::to_string(states.size() / 6) + "}";

        ps::PublishResult r = ps::publish_record_with_source(
            pcfg,
            reinterpret_cast<const uint8_t*>(oem.data()), oem.size(),
            filename, file_id, m.created_iso, provenance,
            url, source_sha256);
        if (r.stored) stored++;
        if (r.signed_) signed_++;
        if (r.published) published++;
    }

    return std::string("{\"ok\":true,\"source\":\"") + pcfg.source_name + "\"," +
           "\"discover_status\":" + std::to_string(manifest.status) + "," +
           "\"manifest_entries\":" + std::to_string(entries.size()) + "," +
           "\"object_cap\":" + std::to_string(cfg.object_cap) + "," +
           "\"fetch_interval_ms\":" + std::to_string(cfg.fetch_interval_ms) + "," +
           "\"record_schema\":\"" + pcfg.record_schema + "\"," +
           "\"fetched\":" + std::to_string(fetched) + "," +
           "\"stored\":" + std::to_string(stored) + "," +
           "\"signed\":" + std::to_string(signed_) + "," +
           "\"published\":" + std::to_string(published) + "}";
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
