/*
 * data-source/cell-tower-ingest (graph task `mod-cell-tower-ingest-flow`).
 *
 * The INGEST half of the cellular program. `cell-tower-source` is the
 * REQUEST-scoped browser aggregate: one $HTQ in, one deconflicted $TBS stream
 * straight back to the caller, `capabilities: []`, nothing persisted. That is
 * the right shape for the demo and the wrong shape for ingest, and the two
 * cannot be one flow — so the ingest-only decisions live here, in a separate
 * plugin, exactly as the credential lane was split into `cell-tower-credentials`
 * for the same reason.
 *
 * This plugin REUSES `cell-tower-source`'s `parse` and `deconflict` unchanged:
 * decoding a provider body and merging sites across providers are the same
 * operations whether the answer is served or stored, and forking them would
 * fork the deconfliction rules.
 *
 * Methods:
 *   mark_query      tick                     -> query           (read the resume mark)
 *   ingest_plan     tick + mark?             -> request, job    (ONE ranged chunk)
 *   ingest_meta     job + records            -> meta, records   (storage-ingest input)
 *   publish_request result + meta            -> request?, mark  (publish + advance)
 *
 * WHY THE FETCH IS CHUNKED, AND WHY THE CHUNK SIZE IS NOT A FREE PARAMETER.
 *
 * `hostcap/http-request`'s own manifest records that the Go server host
 * (sdn-server modulert/caps/http.go) CAPS THE RESPONSE BODY AT 4 MiB. A bulk
 * cellular export is measured in gigabytes, so a whole-file GET does not merely
 * strain memory — it is truncated by the host before the guest ever sees it, and
 * a truncated CSV parses to a plausible-looking short row set with no error
 * anywhere. Independently, `cellular-worldwide-ingest-exceeds-host01` measured a
 * 4.75 MB CSV already forcing 8192 linear-memory pages.
 *
 * So the bulk lanes fetch by HTTP Range, strictly under that ceiling, and ingest
 * per chunk. The default is 3 MiB, leaving headroom under the 4 MiB cap.
 *
 * WHY THE RESUME MARK ADVANCES WHERE IT DOES.
 *
 * The mark is written by `publish_request`, from the STORAGE RESULT — never by
 * `ingest_plan` when it dispatches a chunk. A mark advanced at dispatch time
 * turns a crash between fetch and store into permanently skipped rows, and the
 * gap is invisible: the next run resumes past data that was never persisted.
 * Advancing only on a verified store makes a restart re-fetch at most one chunk,
 * which is idempotent because the storage lane reconciles by source batch.
 *
 * THE MARK'S WRITE LANE IS A MEASURED GAP, NOT AN OVERSIGHT. `hostcap/flatsql-
 * store` cannot carry it: it is the OD flow's fitted-results terminal, built
 * wasi-threads (so it cannot link into a single-thread flow at all — the flow
 * compiler refuses with `mixed-guest-thread-models`) and its `records` port
 * admits only $OMM/$OCM/$OBD. `hostcap/file` is single-thread and would fit, but
 * the Go server host has NO filesystem capability handler, so it fails closed on
 * the very box this flow targets. `storage.write` is schema-typed and would
 * require inventing an SDS record for a bookkeeping row, which is Themis's call
 * and not this flow's to make.
 *
 * So `publish_request` EMITS the advanced mark on its own port — correct, tested
 * and ready — and the flow currently lands it on egress rather than in a store.
 * The read side is real: `mark_query` builds the flatsql-query that reads the
 * mark back, and `ingest_plan` consumes it. Closing the loop needs one durable
 * row lane; see the task note.
 *
 * FAIL LOUDLY ON THE SILENT NOP. `storage.ingest_with_source` refuses the whole
 * batch below a 5 GiB free-disk floor, and the refusal is an errCapJSON RETURN
 * VALUE, not a host event (`sdn-host02-flow-ingest-silent-nop`). hostcap/storage-
 * ingest already turns `ok:false` into a node error. The residue this module must
 * catch is the other half: `ok:true` with `inserted: 0` for a chunk that carried
 * records. That is byte-identical to a healthy empty tail, so it is checked
 * against the record count the job carries rather than guessed at, and it stops
 * the run instead of advancing the mark over data that was never stored.
 */

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <string>
#include <sys/time.h>
#include <vector>

#include "space_data_module_invoke.h"

extern "C" {

__attribute__((import_module("space_data_module_host"), import_name("call")))
int32_t sdm_host_call(const uint8_t* op_ptr, int32_t op_len,
                      const uint8_t* payload_ptr, int32_t payload_len);
__attribute__((import_module("space_data_module_host"), import_name("response_len")))
int32_t sdm_host_response_len(void);
__attribute__((import_module("space_data_module_host"), import_name("read_response")))
int32_t sdm_host_read_response(uint8_t* dst_ptr, int32_t dst_len);

}  // extern "C"

namespace {

// The Go host caps an http response body at 4 MiB (hostcap/http-request
// manifest). 3 MiB leaves headroom for the response envelope and keeps a chunk
// comfortably inside a guest heap that 4.75 MB was already straining.
constexpr long kDefaultChunkBytes = 3L * 1024L * 1024L;
constexpr long kMaxChunkBytes = 4L * 1024L * 1024L;
constexpr long kDefaultTimeoutMs = 90000;
constexpr const char* kMarkTable = "cell_tower_ingest_mark";
constexpr const char* kSchema = "TBS";

bool is_ws(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

bool json_string_field(const std::string& json, const std::string& key, std::string* out) {
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return false;
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return false;
    size_t i = colon + 1;
    while (i < json.size() && is_ws(json[i])) i++;
    if (i >= json.size() || json[i] != '"') return false;
    i++;
    std::string value;
    while (i < json.size() && json[i] != '"') {
        if (json[i] == '\\' && i + 1 < json.size()) {
            value.push_back(json[i + 1]);
            i += 2;
        } else {
            value.push_back(json[i]);
            i++;
        }
    }
    *out = value;
    return true;
}

bool json_number_field(const std::string& json, const std::string& key, double* out) {
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return false;
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return false;
    size_t i = colon + 1;
    while (i < json.size() && is_ws(json[i])) i++;
    if (i >= json.size()) return false;
    const char c = json[i];
    if (c != '-' && (c < '0' || c > '9')) return false;
    char* end = nullptr;
    const double value = strtod(json.c_str() + i, &end);
    if (end == json.c_str() + i) return false;
    *out = value;
    return true;
}

double json_number_or(const std::string& json, const char* key, double fallback) {
    double v = 0;
    return json_number_field(json, key, &v) ? v : fallback;
}

std::string json_escape(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (const char c : s) {
        if (c == '"' || c == '\\') { out.push_back('\\'); out.push_back(c); }
        else if (c == '\n') out += "\\n";
        else out.push_back(c);
    }
    return out;
}

const char kB64Alphabet[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string base64_encode(const uint8_t* data, size_t length) {
    std::string out;
    out.reserve(((length + 2) / 3) * 4);
    size_t i = 0;
    while (i + 3 <= length) {
        const uint32_t v = (static_cast<uint32_t>(data[i]) << 16) |
                           (static_cast<uint32_t>(data[i + 1]) << 8) | data[i + 2];
        out.push_back(kB64Alphabet[(v >> 18) & 0x3f]);
        out.push_back(kB64Alphabet[(v >> 12) & 0x3f]);
        out.push_back(kB64Alphabet[(v >> 6) & 0x3f]);
        out.push_back(kB64Alphabet[v & 0x3f]);
        i += 3;
    }
    const size_t remain = length - i;
    if (remain == 1) {
        const uint32_t v = static_cast<uint32_t>(data[i]) << 16;
        out.push_back(kB64Alphabet[(v >> 18) & 0x3f]);
        out.push_back(kB64Alphabet[(v >> 12) & 0x3f]);
        out.push_back('=');
        out.push_back('=');
    } else if (remain == 2) {
        const uint32_t v = (static_cast<uint32_t>(data[i]) << 16) |
                           (static_cast<uint32_t>(data[i + 1]) << 8);
        out.push_back(kB64Alphabet[(v >> 18) & 0x3f]);
        out.push_back(kB64Alphabet[(v >> 12) & 0x3f]);
        out.push_back(kB64Alphabet[(v >> 6) & 0x3f]);
        out.push_back('=');
    }
    return out;
}

int b64_value(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

std::string base64_decode(const std::string& in) {
    std::string out;
    out.reserve((in.size() / 4) * 3);
    uint32_t acc = 0;
    int bits = 0;
    for (const char c : in) {
        const int v = b64_value(c);
        if (v < 0) continue;  // padding and whitespace
        acc = (acc << 6) | static_cast<uint32_t>(v);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back(static_cast<char>((acc >> bits) & 0xff));
        }
    }
    return out;
}

// plugin.getConfig builtin hostcall: node CONFIG for this flow service, or "{}".
std::string load_config() {
    static const char* op = "plugin.getConfig";
    const std::string payload_json = "{}";
    std::vector<uint8_t> req(4 + payload_json.size() + 4, 0);
    const uint32_t meta_len = static_cast<uint32_t>(payload_json.size());
    req[0] = static_cast<uint8_t>(meta_len & 0xff);
    req[1] = static_cast<uint8_t>((meta_len >> 8) & 0xff);
    req[2] = static_cast<uint8_t>((meta_len >> 16) & 0xff);
    req[3] = static_cast<uint8_t>((meta_len >> 24) & 0xff);
    std::memcpy(req.data() + 4, payload_json.data(), payload_json.size());
    sdm_host_call(reinterpret_cast<const uint8_t*>(op),
                  static_cast<int32_t>(std::strlen(op)), req.data(),
                  static_cast<int32_t>(req.size()));
    const int32_t len = sdm_host_response_len();
    if (len <= 4) return "{}";
    std::vector<uint8_t> buf(static_cast<size_t>(len));
    sdm_host_read_response(buf.data(), len);
    const uint32_t rlen = static_cast<uint32_t>(buf[0]) | (static_cast<uint32_t>(buf[1]) << 8) |
                          (static_cast<uint32_t>(buf[2]) << 16) |
                          (static_cast<uint32_t>(buf[3]) << 24);
    if (buf.size() < 4u + rlen) return "{}";
    return std::string(reinterpret_cast<const char*>(buf.data() + 4), rlen);
}

std::string config_string(const std::string& config, const char* key, const char* fallback) {
    std::string value;
    if (json_string_field(config, key, &value) && !value.empty()) return value;
    return fallback;
}

// The configured chunk size is CLAMPED, not merely defaulted. An operator who
// sets 64 MiB "for throughput" would get a silently truncated body from the host
// and a short parse that looks like a clean tail.
long config_chunk_bytes(const std::string& config) {
    long v = static_cast<long>(json_number_or(config, "cell_ingest_chunk_bytes",
                                              static_cast<double>(kDefaultChunkBytes)));
    if (v <= 0) return kDefaultChunkBytes;
    if (v > kMaxChunkBytes) return kMaxChunkBytes;
    return v;
}

long config_timeout_ms(const std::string& config) {
    const long v = static_cast<long>(json_number_or(config, "cell_ingest_http_timeout_ms",
                                                    static_cast<double>(kDefaultTimeoutMs)));
    return v > 0 ? v : kDefaultTimeoutMs;
}

const plugin_input_frame_t* frame_for(const char* port_id) {
    const int32_t index = plugin_find_input_index(port_id, 0);
    if (index < 0) return nullptr;
    return plugin_get_input_frame(static_cast<uint32_t>(index));
}

std::string input_text(const char* port_id) {
    const plugin_input_frame_t* f = frame_for(port_id);
    if (!f || !f->payload || f->payload_length == 0) return std::string();
    return std::string(reinterpret_cast<const char*>(f->payload), f->payload_length);
}

int push_json(const char* port, const std::string& json) {
    return plugin_push_output_ex(port, nullptr, nullptr,
                                 PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                                 reinterpret_cast<const uint8_t*>(json.data()),
                                 static_cast<uint32_t>(json.size()));
}

int push_bytes(const char* port, const uint8_t* data, uint32_t length) {
    return plugin_push_output_ex(port, nullptr, nullptr,
                                 PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                                 data, length);
}

// SURPLUS-FRAME REFUSAL. The compiled flow runtime drains a node's queue
// PORT-BLIND up to a budget of 64; maxStreams/maxBatch/drainPolicy are purely
// declarative there. A guest that reads ordinal 0 and returns destroys every
// other frame it was handed, with nothing re-delivering and nothing logging the
// loss — the live P1 `cellular-multiprovider-returns-only-first-provider`.
// Every method here pairs exactly one frame per port (one tick = one chunk, one
// result = one mark), so a surplus is refused by name rather than silently
// halved. See `modules-guest-nodes-drop-batched-frames`.
bool find_batched_input_port(char* message, size_t message_len) {
    const uint32_t count = plugin_get_input_count();
    for (uint32_t i = 0; i < count; i++) {
        const plugin_input_frame_t* frame = plugin_get_input_frame(i);
        if (!frame || !frame->port_id) continue;
        for (uint32_t j = 0; j < i; j++) {
            const plugin_input_frame_t* earlier = plugin_get_input_frame(j);
            if (!earlier || !earlier->port_id) continue;
            if (std::strcmp(earlier->port_id, frame->port_id) != 0) continue;
            uint32_t on_port = 0;
            for (uint32_t k = 0; k < count; k++) {
                const plugin_input_frame_t* f = plugin_get_input_frame(k);
                if (f && f->port_id && std::strcmp(f->port_id, frame->port_id) == 0) on_port++;
            }
            std::snprintf(message, message_len,
                          "This invocation carries %u frames on single-stream input port \"%s\" "
                          "(the compiled flow runtime drains a node's whole queue port-blind; "
                          "maxStreams is declarative only). The surplus frames are refused "
                          "rather than silently discarded.",
                          on_port, frame->port_id);
            return true;
        }
    }
    return false;
}

bool refuse_batched(void) {
    char message[384];
    if (!find_batched_input_port(message, sizeof(message))) return false;
    plugin_set_error("batched-input-frames", message);
    return true;
}

// Content-Range: "bytes 0-3145727/2147483648" -> the total after the slash.
// The DENOMINATOR is the only authority on the object's size: Content-Length on
// a 206 describes the CHUNK, and reading it as the total ends the run after one
// chunk with every later byte silently unfetched.
bool total_from_content_range(const std::string& headers_json, long* total) {
    std::string value;
    if (!json_string_field(headers_json, "content-range", &value) &&
        !json_string_field(headers_json, "Content-Range", &value)) {
        return false;
    }
    const size_t slash = value.rfind('/');
    if (slash == std::string::npos || slash + 1 >= value.size()) return false;
    if (value[slash + 1] == '*') return false;  // unknown total; not an answer
    const long parsed = std::atol(value.c_str() + slash + 1);
    if (parsed <= 0) return false;
    *total = parsed;
    return true;
}

// The mark also carries WHAT THE STORE HOLDS, not only where the fetch is.
//
// `stored_rows` and `stored_at` exist because the tile lane must answer
// "how many records, ingested when" WITHOUT scanning the store: a COUNT over
// millions of rows to fill one field of a capability envelope the client
// fetches at startup is not a tile lane, it is a table scan with a URL. The
// ingest lane is the only place those two numbers are ever established, so it
// records them where the read side can find them. `stored_rows` is CUMULATIVE
// across chunks — a per-chunk count would report the size of the last chunk as
// the size of the dataset.
std::string mark_json(const std::string& provider_id, const std::string& source_url,
                      long next_offset, long total_bytes, long chunk_index,
                      const std::string& batch_id, long stored_rows,
                      const std::string& stored_at) {
    char buf[160];
    std::snprintf(buf, sizeof(buf), "%ld,\"total_bytes\":%ld,\"chunk_index\":%ld", next_offset,
                  total_bytes, chunk_index);
    return std::string("{\"provider_id\":\"") + json_escape(provider_id) + "\"" +
           ",\"source_url\":\"" + json_escape(source_url) + "\"" + ",\"next_offset\":" + buf +
           ",\"stored_rows\":" + std::to_string(stored_rows) + ",\"stored_at\":\"" +
           json_escape(stored_at) + "\"" + ",\"batch_id\":\"" + json_escape(batch_id) + "\"}";
}

// ── $HTQ request envelope (read-only) ──────────────────────────────────────
//
// The cache lane sits in FRONT of cell-tower-source's `route`, so it has to read
// the same envelope `route` reads in order to decide whether a request can be
// answered from the store. Hand-decoded exactly as cell-tower-source does it
// (cell_tower_source_module.cpp:2374) — one table, six fields, slots
// METHOD=0, PATH=1, QUERY=2, HEADERS=3, BODY=4, REMOTE=5. Deliberately a COPY
// rather than a shared header: this reader is READ-ONLY and never constructs an
// envelope, and linking the two plugins' sources together would drag
// cell-tower-source's whole provider registry into a plugin whose entire point
// is that it holds none.
struct HtqPeek {
    const uint8_t* buf = nullptr;
    uint32_t len = 0;
    uint32_t root = 0;
    uint32_t vtable = 0;
    uint16_t vtable_len = 0;

    bool init(const uint8_t* data, uint32_t size) {
        if (!data || size < 8) return false;
        buf = data;
        len = size;
        root = rd32(0);
        if (root + 4 > len) return false;
        const int32_t soffset = static_cast<int32_t>(rd32(root));
        const int64_t vt = static_cast<int64_t>(root) - soffset;
        if (vt < 0 || vt + 4 > len) return false;
        vtable = static_cast<uint32_t>(vt);
        vtable_len = rd16(vtable);
        return true;
    }
    uint32_t rd32(uint32_t at) const {
        return static_cast<uint32_t>(buf[at]) | (static_cast<uint32_t>(buf[at + 1]) << 8) |
               (static_cast<uint32_t>(buf[at + 2]) << 16) |
               (static_cast<uint32_t>(buf[at + 3]) << 24);
    }
    uint16_t rd16(uint32_t at) const {
        return static_cast<uint16_t>(buf[at]) | (static_cast<uint16_t>(buf[at + 1]) << 8);
    }
    uint16_t slot(int index) const {
        const uint32_t at = vtable + 4 + static_cast<uint32_t>(index) * 2;
        if (at + 2 > vtable + vtable_len || at + 2 > len) return 0;
        return rd16(at);
    }
    std::string str(int index) const {
        const uint16_t rel = slot(index);
        if (!rel) return std::string();
        const uint32_t at = root + rel;
        if (at + 4 > len) return std::string();
        const uint32_t off = at + rd32(at);
        if (off + 4 > len) return std::string();
        const uint32_t n = rd32(off);
        if (off + 4 + n > len) return std::string();
        return std::string(reinterpret_cast<const char*>(buf + off + 4), n);
    }
};

std::string upper_ascii(const std::string& s) {
    std::string out = s;
    for (char& c : out) {
        if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
    }
    return out;
}

bool json_bool_or(const std::string& json, const char* key, bool fallback) {
    const std::string needle = std::string("\"") + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return fallback;
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return fallback;
    size_t i = colon + 1;
    while (i < json.size() && is_ws(json[i])) i++;
    if (json.compare(i, 4, "true") == 0) return true;
    if (json.compare(i, 5, "false") == 0) return false;
    return fallback;
}

bool path_has_segment(const std::string& path, const char* segment) {
    return path.find(segment) != std::string::npos;
}

// THE DEFAULT QUERY. This is the per-dataset default FlatSQL query of
// `sdn-dataset-default-query-materialized-cache`, in its first concrete
// instance: the SQL is node CONFIG (`cell_cache_sql`), not a compiled-in
// constant, so an operator retargets the cache without a rebuild. The default
// names the table the cellular ingest lane's storage writes land in
// (`sds_<lowercased SDS type>`, the convention hostcap/flatsql-store encodes at
// flatsql_store_module.cpp:137) and takes the row cap as a bound parameter, so
// the caller's LIMIT still bounds the answer.
constexpr const char* kDefaultCacheSql = "SELECT data FROM sds_tbs ORDER BY rowid DESC LIMIT ?";
constexpr long kDefaultCacheMaxRows = 5000;

// ═══════════════════════════════════════════════════════════════════════════
// THE DENSITY-TILE SERVING LANE (graph tasks sdn-cellular-density-tiles /
// upstream-modules-2; owner 2026-08-24: "all worldwide cell towers must reach
// the cellular sandcastle").
//
// A worldwide site set is millions of rows. Handing them to a browser as one
// answer is not slow, it is impossible — so the node serves BOUNDED tiles and
// the client streams the ones its camera can see. THE TILING CONTRACT LIVES
// SERVER-SIDE: the client re-derives nothing, and every mode decision below is
// this node's, never the renderer's.
//
// The grammar is not negotiable and is not documented-only: the landed OrbPro
// client (packages/sandcastle/gallery/_shared/cellularTileStream.js, f9e39b5437)
// FAILS HARD on an off-contract envelope — points mode above budget, density
// mode at or below budget, a density tile with an empty cells array, a missing
// threshold, a non-ISO epoch. Its parser is the normative consumer, so these
// constants and this envelope are written against it rather than against prose.
//
// ZERO GO HOST CHANGES. The lane is the existing generic hooks: plugin.getConfig
// plus hostcap/flatsql-query frames. The plugin stays `capabilities: []`.
// ═══════════════════════════════════════════════════════════════════════════

constexpr const char* kTileScheme = "xyz";
constexpr long kTileMinZoom = 0;
constexpr long kTileMaxZoom = 18;

// The mode boundaries. `threshold` is where raw points stop being sent whole;
// `budget` is the client's per-tile point envelope (proven 250k points at
// 360 fps across ~60 visible tiles). count <= threshold -> every point;
// threshold < count <= budget -> a deterministic sample; count > budget ->
// a density grid. The client refuses any tile that disagrees with this.
constexpr long kTileThreshold = 2048;
constexpr long kTileBudget = 4096;
constexpr long kTileDensityN = 16;

// Web Mercator's latitude limit. y = 0 and y = 2^z - 1 close exactly here.
constexpr double kTileLatClamp = 85.05112878;

// ONE SHARED EPSILON WITH THE CLIENT. A point produced by the round trip
// lon/lat -> tileBounds -> lon/lat must never land on the wrong side of a seam
// by one ulp, and server and client must agree on which tile owns a seam.
// This is the client's TILE_INDEX_EPSILON verbatim (cellularTileStream.js).
constexpr double kTileIndexEpsilon = 1e-9;

// The tile lane's own default query. Same posture as `cell_cache_sql`: node
// CONFIG, not a compiled-in constant, so an operator with a spatial index can
// push the bbox into SQL without a rebuild. The default reads the rows the
// cellular ingest lane's storage writes land in and bounds the scan.
constexpr const char* kDefaultTileSql = "SELECT data FROM sds_tbs ORDER BY rowid DESC LIMIT ?";
constexpr long kDefaultTileMaxRows = 100000;

// The dataset identity the envelope names. The client only requires a non-empty
// string; naming the dataset rather than the table keeps the store's physical
// layout out of a public contract.
constexpr const char* kTileDataset = "cellular-base-stations";

// The honest "no epoch yet" answer. dataset.epoch MUST parse as a timestamp
// (the client refuses anything Date.parse cannot read), so an empty store
// cannot answer with "" or null — and it must not answer with NOW, which would
// stamp an empty store as freshly current. The Unix epoch reads as what it is,
// beside cacheState "empty" and records 0.
constexpr const char* kTileNoEpoch = "1970-01-01T00:00:00Z";

std::string iso_now(void) {
    struct timeval tv;
    gettimeofday(&tv, nullptr);
    const time_t seconds = static_cast<time_t>(tv.tv_sec);
    struct tm g;
    gmtime_r(&seconds, &g);
    char buf[32];
    std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &g);
    return std::string(buf);
}

// ── the XYZ scheme, byte-for-byte the client's math ────────────────────────
//
// These four functions are the SAME formulas as lonToTileX / latToTileY /
// tileBounds in the landed client. They are duplicated rather than shared
// because one of them is C++ in a wasm guest and the other is JS in a browser;
// what makes the duplication safe is that the tests below assert the SERVER's
// assignment against tiles the CLIENT's bounds produced.

double tile_lat_clamp(double lat) {
    if (lat > kTileLatClamp) return kTileLatClamp;
    if (lat < -kTileLatClamp) return -kTileLatClamp;
    return lat;
}

long tile_n(long z) { return 1L << z; }

long lon_to_tile_x(double lon, long z) {
    const double n = static_cast<double>(tile_n(z));
    const double raw = ((lon + 180.0) / 360.0) * n + kTileIndexEpsilon;
    long x = static_cast<long>(std::floor(raw));
    if (x < 0) x = 0;
    if (x > tile_n(z) - 1) x = tile_n(z) - 1;
    return x;
}

long lat_to_tile_y(double lat, long z) {
    const double n = static_cast<double>(tile_n(z));
    const double phi = (tile_lat_clamp(lat) * M_PI) / 180.0;
    const double raw = ((1.0 - std::asinh(std::tan(phi)) / M_PI) / 2.0) * n + kTileIndexEpsilon;
    long y = static_cast<long>(std::floor(raw));
    if (y < 0) y = 0;
    if (y > tile_n(z) - 1) y = tile_n(z) - 1;
    return y;
}

struct TileBounds {
    double west = 0, south = 0, north = 0, east = 0;
};

TileBounds tile_bounds(long z, long x, long y) {
    const double n = static_cast<double>(tile_n(z));
    TileBounds b;
    b.west = (static_cast<double>(x) / n) * 360.0 - 180.0;
    b.east = (static_cast<double>(x + 1) / n) * 360.0 - 180.0;
    b.north = std::atan(std::sinh(M_PI * (1.0 - (2.0 * static_cast<double>(y)) / n))) * 180.0 / M_PI;
    b.south =
        std::atan(std::sinh(M_PI * (1.0 - (2.0 * static_cast<double>(y + 1)) / n))) * 180.0 / M_PI;
    return b;
}

// ── $TBS read-only peek ────────────────────────────────────────────────────
//
// The tile lane needs exactly two fields out of a stored $TBS record: LATITUDE
// and LONGITUDE. Linking the generated TBS header in would drag the whole
// schema (and cell-tower-source's registry, via its inlining build) into a
// plugin whose entire point is that it holds neither — so the two doubles are
// hand-decoded, exactly as HtqPeek above hand-decodes the $HTQ it only reads.
//
// SLOT INDICES ARE THE IDL'S DECLARATION ORDER, verified against
// spacedatastandards.org schema/TBS: ID=0, NATIVE_ID=1, RADIO=2, MCC=3, MNC=4,
// LAC=5, TAC=6, CELL_ID=7, LATITUDE=8, LONGITUDE=9. A field the writer omitted
// has vtable slot 0 and is ABSENT, not zero — a record with no position must be
// skipped, never plotted at null island.
constexpr int kTbsSlotLatitude = 8;
constexpr int kTbsSlotLongitude = 9;

struct TbsPeek {
    const uint8_t* buf = nullptr;
    uint32_t len = 0;
    uint32_t root = 0;
    uint32_t vtable = 0;
    uint16_t vtable_len = 0;

    uint32_t rd32(uint32_t at) const {
        return static_cast<uint32_t>(buf[at]) | (static_cast<uint32_t>(buf[at + 1]) << 8) |
               (static_cast<uint32_t>(buf[at + 2]) << 16) |
               (static_cast<uint32_t>(buf[at + 3]) << 24);
    }
    uint16_t rd16(uint32_t at) const {
        return static_cast<uint16_t>(buf[at]) | (static_cast<uint16_t>(buf[at + 1]) << 8);
    }

    bool init(const uint8_t* data, uint32_t size) {
        if (!data || size < 8) return false;
        buf = data;
        len = size;
        root = rd32(0);
        if (root + 4 > len) return false;
        const int32_t soffset = static_cast<int32_t>(rd32(root));
        const int64_t vt = static_cast<int64_t>(root) - soffset;
        if (vt < 0 || vt + 4 > static_cast<int64_t>(len)) return false;
        vtable = static_cast<uint32_t>(vt);
        vtable_len = rd16(vtable);
        return vtable_len >= 4;
    }

    uint16_t slot(int index) const {
        const uint32_t at = vtable + 4 + static_cast<uint32_t>(index) * 2;
        if (at + 2 > vtable + vtable_len || at + 2 > len) return 0;
        return rd16(at);
    }

    bool f64(int index, double* out) const {
        const uint16_t rel = slot(index);
        if (!rel) return false;  // ABSENT, not zero.
        const uint32_t at = root + rel;
        if (at + 8 > len) return false;
        uint64_t bits = 0;
        for (int i = 7; i >= 0; i--) bits = (bits << 8) | static_cast<uint64_t>(buf[at + i]);
        double value;
        std::memcpy(&value, &bits, sizeof(value));
        *out = value;
        return true;
    }
};

struct TilePoint {
    double lat = 0, lon = 0;
};

// Walk a size-prefixed record stream, keep the points that fall in ONE tile.
//
// Membership is decided by re-deriving the point's own (x, y) with the same
// formulas and the same epsilon the client uses, NOT by a west<=lon<east
// rectangle test: a rectangle test disagrees with the client's tile assignment
// on the seams, and a site that both sides claim (or neither) is a duplicate or
// a hole in the worldwide picture.
//
// `scanned` counts every well-formed positioned record the query returned, so
// the envelope can say how much of the store this answer actually saw.
void collect_tile_points(const uint8_t* stream, uint32_t stream_len, long z, long x, long y,
                         std::vector<TilePoint>* out, long* scanned, long* malformed) {
    uint32_t at = 0;
    while (at + 4 <= stream_len) {
        const uint32_t size = static_cast<uint32_t>(stream[at]) |
                              (static_cast<uint32_t>(stream[at + 1]) << 8) |
                              (static_cast<uint32_t>(stream[at + 2]) << 16) |
                              (static_cast<uint32_t>(stream[at + 3]) << 24);
        at += 4;
        if (size == 0 || at + size > stream_len) break;
        const uint8_t* record = stream + at;
        at += size;

        TbsPeek peek;
        double lat = 0, lon = 0;
        if (!peek.init(record, size) || !peek.f64(kTbsSlotLatitude, &lat) ||
            !peek.f64(kTbsSlotLongitude, &lon)) {
            (*malformed)++;
            continue;
        }
        if (!(lat >= -90.0 && lat <= 90.0) || !(lon >= -180.0 && lon <= 180.0)) {
            (*malformed)++;
            continue;
        }
        (*scanned)++;
        if (lon_to_tile_x(lon, z) != x || lat_to_tile_y(lat, z) != y) continue;
        TilePoint p;
        p.lat = lat;
        p.lon = lon;
        out->push_back(p);
    }
}

// Point coordinates: 1e-7 degrees is ~1 cm, far finer than any renderer needs,
// and a tile ships up to 2048 of them — precision beyond this is payload, not
// information.
std::string fixed7(double v) {
    char buf[40];
    std::snprintf(buf, sizeof(buf), "%.7f", v);
    return std::string(buf);
}

// DENSITY CELL CORNERS ARE FULL-PRECISION, and that is not fussiness.
//
// The client rebuilds a cell's rectangle from its south-west corner plus the
// tile's own span (densityCellRectangle: east = cell.lon + (bounds.east -
// bounds.west) / n). If the corner it is handed has been rounded, the
// reconstructed east edge of the last column OVERSHOOTS the tile's east edge —
// measured at 2e-8 degrees with %.7f corners, i.e. the cells no longer tile
// their parent and adjacent tiles overlap by a sliver at every seam. A grid
// whose cells do not partition the tile is a density product that double-counts
// at its own boundaries. Round-trip precision (17 significant digits) hands the
// client the EXACT double the server computed, so its arithmetic reproduces the
// server's bit for bit. There are at most 256 cells, so the extra bytes are
// nothing.
std::string exact_double(double v) {
    char buf[40];
    std::snprintf(buf, sizeof(buf), "%.17g", v);
    return std::string(buf);
}

// ── the dataset block ──────────────────────────────────────────────────────
//
// Every tile and the meta carry the SAME dataset block, sourced from the ingest
// lane's resume mark and from nothing else. An empty store answers honestly:
// cacheState "empty", records 0, the sentinel epoch, stale true. Nothing here
// invents a count, a time, or a state it cannot establish — a tile layer that
// draws zero towers over a store that was never ingested must say which of the
// two it is.
std::string tile_dataset_json(const std::string& mark, std::string* state_out) {
    std::string state = "empty";
    std::string epoch = kTileNoEpoch;
    long records = 0;
    bool stale = true;

    std::string mark_provider;
    if (!mark.empty() && json_string_field(mark, "provider_id", &mark_provider)) {
        const long next_offset = static_cast<long>(json_number_or(mark, "next_offset", 0));
        const long total_bytes = static_cast<long>(json_number_or(mark, "total_bytes", 0));
        records = static_cast<long>(json_number_or(mark, "stored_rows", 0));
        if (records < 0) records = 0;
        const bool complete = total_bytes > 0 && next_offset >= total_bytes;
        state = complete ? "warm" : "ingesting";
        stale = !complete;
        std::string stored_at;
        if (json_string_field(mark, "stored_at", &stored_at) && !stored_at.empty()) {
            epoch = stored_at;
        }
    }

    if (state_out) *state_out = state;
    return std::string("{\"dataset\":\"") + kTileDataset + "\",\"epoch\":\"" + json_escape(epoch) +
           "\",\"records\":" + std::to_string(records) + ",\"stale\":" + (stale ? "true" : "false") +
           ",\"cacheState\":\"" + state + "\"}";
}

// The tile path grammar: ".../tiles/meta" or ".../tiles/{z}/{x}/{y}".
// Returns false when the path is not a tile path at all.
bool split_tile_path(const std::string& path, std::vector<std::string>* segments) {
    const size_t at = path.find("/tiles");
    if (at == std::string::npos) return false;
    size_t i = at + 6;
    if (i < path.size() && path[i] != '/') return false;  // "/tilesfoo" is not ours
    std::string current;
    for (; i <= path.size(); i++) {
        const char c = i < path.size() ? path[i] : '/';
        if (c == '/' || c == '?') {
            if (!current.empty()) segments->push_back(current);
            current.clear();
            if (c == '?') break;
        } else {
            current.push_back(c);
        }
    }
    return true;
}

// Strict non-negative integer parse. "3.5", "+3", "0x3", "", " 3" and "3abc"
// are all REFUSED: a tile index that silently truncates serves a neighbour's
// tile under the requested key, which is a wrong answer with a 200 on it.
bool parse_index(const std::string& text, long* out) {
    if (text.empty() || text.size() > 10) return false;
    long value = 0;
    for (const char c : text) {
        if (c < '0' || c > '9') return false;
        value = value * 10 + (c - '0');
    }
    *out = value;
    return true;
}

}  // namespace

extern "C" {

// ---------------------------------------------------------------------------
// cache_plan — THE CACHE GATE. Owner 2026-08-14: "the cell towers should load
// almost instantaneously."
//
// This node sits between the flow's ONE http trigger and cell-tower-source's
// `route`, and it is the whole reason the request path stops costing ~9s. Before
// this existed, every /aggregate request fanned out a live GET per provider and
// merged the bodies while the caller waited. Now:
//
//   * an /aggregate read is answered FROM THE STORE — one FlatSQL SELECT over
//     rows the cellular-network-ingest timer already persisted, streamed back
//     verbatim by hostcap/flatsql-query;
//   * every other route (/providers, /credentials/*) and any request that asks
//     for `REFRESH: true` is PASSED THROUGH to `route` unchanged, so the live
//     provider lane is intact and reachable, just no longer the default;
//   * provider refresh is the timer flow's job (flows/cellular-network-ingest),
//     never the request path's.
//
// It emits NOTHING on the cache ports when it passes through, and nothing on
// `passthrough` when it serves from cache, so exactly one lane answers and the
// two bodies can never race into `respond`.
//
// NO NEW HOST SURFACE. This is `plugin.getConfig` plus two flatsql-query frames
// over the existing generic hooks; the plugin stays `capabilities: []`.
// ---------------------------------------------------------------------------
int cache_plan(void) {
    if (refuse_batched()) return 500;

    const plugin_input_frame_t* frame = frame_for("request");
    if (!frame || !frame->payload || frame->payload_length == 0) {
        plugin_set_error("missing-request-frame",
                         "cache_plan requires the $HTQ request frame on port \"request\".");
        return 400;
    }

    // A FORWARD ON EVERY UNCERTAINTY. If the envelope cannot be read, this node
    // does not get to decide anything — it hands the frame to `route`, which
    // owns the error vocabulary for a malformed request. Answering an
    // unreadable request out of the cache would serve the last good answer to a
    // request nobody could parse.
    HtqPeek htq;
    const bool readable = htq.init(frame->payload, frame->payload_length);
    const std::string path = readable ? htq.str(1) : std::string();
    const std::string verb = readable ? upper_ascii(htq.str(0)) : std::string();
    const std::string body = readable ? htq.str(4) : std::string();

    // THE TILE LANE gets the request BEFORE anything else looks at it. Without
    // this branch `/tiles/...` is a GET that names neither /providers nor
    // /credentials/, so the aggregate test below would claim it and answer a
    // tile request with the whole cached record stream — a 200 carrying
    // megabytes of the wrong shape. The $HTQ is forwarded byte-for-byte; this
    // node re-serialises nothing.
    if (readable && path_has_segment(path, "/tiles")) {
        const int32_t pushed = plugin_push_output_ex(
            "tile", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 8,
            frame->payload, frame->payload_length);
        return pushed < 0 ? 500 : 0;
    }

    const bool is_aggregate = readable && !path_has_segment(path, "/providers") &&
                              !path_has_segment(path, "/credentials/") &&
                              (verb == "POST" || verb == "GET");
    // REFRESH is the caller's explicit "go to the providers now". It is opt-IN:
    // a default that refreshed would put the 9 s back for everyone.
    const bool refresh = json_bool_or(body, "REFRESH", false);

    if (!is_aggregate || refresh) {
        // Verbatim forward. The payload is re-pushed byte-for-byte as aligned
        // binary — `route` re-decodes the same $HTQ this node just read, and no
        // field is re-serialised in between where it could drift.
        const int32_t pushed = plugin_push_output_ex(
            "passthrough", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0,
            8, frame->payload, frame->payload_length);
        return pushed < 0 ? 500 : 0;
    }

    const std::string config = load_config();
    const std::string sql = config_string(config, "cell_cache_sql", kDefaultCacheSql);
    long max_rows = static_cast<long>(json_number_or(config, "cell_cache_max_rows",
                                                     static_cast<double>(kDefaultCacheMaxRows)));
    if (max_rows <= 0) max_rows = kDefaultCacheMaxRows;
    long limit = static_cast<long>(json_number_or(body, "LIMIT", 2000));
    if (limit <= 0) limit = 2000;
    if (limit > max_rows) limit = max_rows;

    char limit_buf[32];
    std::snprintf(limit_buf, sizeof(limit_buf), "%ld", limit);

    const std::string query = std::string("{\"sql\":\"") + json_escape(sql) +
                              "\",\"params\":[{\"t\":\"i64\",\"v\":" + limit_buf + "}]}";
    if (push_json("query", query) < 0) return 500;

    // The freshness read is a SECOND query, not a join onto the first: the
    // records answer must stream back verbatim to the caller, and mixing
    // bookkeeping columns into it would corrupt the record stream.
    const std::string provider = config_string(config, "cell_ingest_provider_id", "opencellid");
    const std::string mark_sql = std::string("{\"sql\":\"SELECT * FROM ") + kMarkTable +
                                 "\",\"params\":[]}";
    if (push_json("mark_query", mark_sql) < 0) return 500;

    const std::string job = std::string("{\"route\":\"cellular-aggregate-cache\"") +
                            ",\"limit\":" + limit_buf + ",\"maxRows\":" +
                            std::to_string(max_rows) + ",\"provider_id\":\"" +
                            json_escape(provider) + "\"" + ",\"sql\":\"" + json_escape(sql) + "\"}";
    return push_json("job", job) < 0 ? 500 : 0;
}

// ---------------------------------------------------------------------------
// cache_freshness — the honest half of the cache.
//
// A cache that answers instantly and says nothing about its age is worse than
// the 9 s fetch it replaced, because a stale answer becomes indistinguishable
// from a current one. This node authors the decision envelope that rides beside
// the cached record stream, and it exists so that the UI can say WHEN the towers
// it is drawing were last ingested.
//
// It reports what it can actually establish and refuses to invent the rest:
//
//   * `cacheState: "empty"` when the ingest lane has left no mark at all. That
//     is the "no fake instant-but-empty answers" case from the task — the
//     answer is instant AND empty, and the envelope says so, names the reason,
//     and tells the caller that REFRESH:true reaches the providers directly.
//   * `cacheState: "warm"` when a mark exists, with the provider and byte
//     progress the mark carries.
//   * `freshness: "unavailable"` when the mark frame is present but not
//     readable as the JSON `ingest_plan` already expects on this port
//     (cell_tower_ingest_module.cpp `ingest_plan`, port "mark"). The read side
//     of the mark lane is not yet closed end-to-end (see the file header), and
//     a timestamp guessed at here would be a lie with a number on it.
// ---------------------------------------------------------------------------
int cache_freshness(void) {
    if (refuse_batched()) return 500;

    const std::string job = input_text("job");
    if (job.empty()) {
        plugin_set_error("missing-job-frame",
                         "cache_freshness requires the cache job frame from cache_plan.");
        return 400;
    }
    const long limit = static_cast<long>(json_number_or(job, "limit", 0));
    std::string provider;
    json_string_field(job, "provider_id", &provider);

    const std::string mark = input_text("mark");

    std::string state = "empty";
    std::string freshness = "unknown";
    std::string detail;
    bool stale = true;

    if (!mark.empty()) {
        std::string mark_provider;
        if (json_string_field(mark, "provider_id", &mark_provider)) {
            const long next_offset = static_cast<long>(json_number_or(mark, "next_offset", 0));
            const long total_bytes = static_cast<long>(json_number_or(mark, "total_bytes", 0));
            const long chunk_index = static_cast<long>(json_number_or(mark, "chunk_index", 0));
            state = "warm";
            freshness = (total_bytes > 0 && next_offset >= total_bytes) ? "complete" : "ingesting";
            stale = freshness != "complete";
            char buf[224];
            std::snprintf(buf, sizeof(buf),
                          ",\"providers\":[{\"providerId\":\"%s\",\"nextOffset\":%ld"
                          ",\"totalBytes\":%ld,\"chunkIndex\":%ld,\"state\":\"%s\"}]",
                          json_escape(mark_provider).c_str(), next_offset, total_bytes, chunk_index,
                          freshness.c_str());
            detail = buf;
        } else {
            state = "warm";
            freshness = "unavailable";
            detail =
                ",\"providers\":[],\"freshnessReason\":\"the resume-mark row is not readable as "
                "JSON on this port; the mark read lane is not closed end-to-end yet\"";
        }
    } else {
        detail = std::string(
                     ",\"providers\":[],\"freshnessReason\":\"no ingest mark for provider \\\"") +
                 json_escape(provider) +
                 "\\\" — the cellular-network-ingest timer has not stored anything yet; POST "
                 "{\\\"REFRESH\\\":true} to reach the providers directly\"";
    }

    // THE FRESHNESS MUST REACH THE CALLER, and the body is a verbatim FlatBuffer
    // stream that cannot carry it. So it rides as response HEADERS, through
    // foundation/http-respond's `decision.headers` passthrough — string values
    // only, which is why `providers` is serialised into one compact string
    // rather than nested. The same fields stay on the decision object itself so
    // an in-flow consumer reads them structurally.
    std::string providers_header = detail;
    const size_t marker = providers_header.find("\"providers\":");
    providers_header = marker == std::string::npos
                           ? std::string("[]")
                           : providers_header.substr(marker + 12);
    const size_t close = providers_header.find(']');
    providers_header =
        close == std::string::npos ? std::string("[]") : providers_header.substr(0, close + 1);

    const std::string headers = std::string(",\"headers\":{\"x-sdn-cache\":\"") + state + "\"" +
                                ",\"x-sdn-cache-freshness\":\"" + freshness + "\"" +
                                ",\"x-sdn-cache-stale\":\"" + (stale ? "true" : "false") + "\"" +
                                ",\"x-sdn-cache-providers\":\"" + json_escape(providers_header) +
                                "\"}";

    const std::string decision =
        std::string("{\"route\":\"cellular-aggregate-cache\",\"format\":\"record-stream\"") +
        ",\"status\":200,\"served\":\"cache\"" + ",\"cacheState\":\"" + state + "\"" +
        ",\"freshness\":\"" + freshness + "\"" + ",\"stale\":" + (stale ? "true" : "false") +
        ",\"limit\":" + std::to_string(limit) + detail + headers + "}";
    return push_json("decision", decision) < 0 ? 500 : 0;
}

// ---------------------------------------------------------------------------
// tile_plan — THE TILE ROUTER. One $HTQ in, ONE lane out.
//
// `/tiles/meta` and `/tiles/{z}/{x}/{y}` are the only two shapes; everything
// else under `/tiles` is refused with the reason named. The refusal travels on
// the SAME `tile_job` port the tile lane uses, so exactly one node ever answers
// a tile request and two bodies can never race into `respond` — the discipline
// the cache gate established and the one property that makes this flow's
// single-responder invariant checkable.
//
// BOUNDS ARE REFUSED, NEVER CLAMPED. A z of 19 clamped to 18, or an x of 2^z
// clamped to 2^z - 1, answers 200 with a DIFFERENT tile's contents under the
// requested key — a wrong answer that no client can detect. z outside [0, 18],
// x or y outside [0, 2^z), and any non-canonical integer literal are 400s.
// ---------------------------------------------------------------------------
int tile_plan(void) {
    if (refuse_batched()) return 500;

    const plugin_input_frame_t* frame = frame_for("request");
    if (!frame || !frame->payload || frame->payload_length == 0) {
        plugin_set_error("missing-request-frame",
                         "tile_plan requires the $HTQ request frame on port \"request\".");
        return 400;
    }

    HtqPeek htq;
    const bool readable = htq.init(frame->payload, frame->payload_length);
    const std::string path = readable ? htq.str(1) : std::string();

    auto refuse = [&](const char* code, const std::string& why) -> int {
        const std::string job = std::string("{\"route\":\"cellular-tile\",\"code\":\"") + code +
                                "\",\"refuse\":\"" + json_escape(why) + "\"}";
        return push_json("tile_job", job) < 0 ? 500 : 0;
    };

    std::vector<std::string> segments;
    if (!readable || !split_tile_path(path, &segments)) {
        return refuse("tile-path",
                      "the tile lane serves /tiles/meta and /tiles/{z}/{x}/{y} only");
    }

    const std::string config = load_config();
    const std::string provider = config_string(config, "cell_ingest_provider_id", "opencellid");
    const std::string mark_sql = std::string("{\"sql\":\"SELECT * FROM ") + kMarkTable +
                                 "\",\"params\":[]}";

    // ── the meta lane: capability envelope + store honesty, and NO row scan.
    //
    // `dataset.records` comes from the resume mark, not from a COUNT over the
    // store. Counting would mean reading the whole record stream back through
    // the guest to answer a question the client asks ONCE at startup — tens of
    // MB to produce one integer. The mark is the number the ingest lane
    // actually established, and it is the honest one.
    if (segments.size() == 1 && segments[0] == "meta") {
        if (push_json("meta_mark_query", mark_sql) < 0) return 500;
        const std::string job = std::string("{\"route\":\"cellular-tile-meta\",\"provider_id\":\"") +
                                json_escape(provider) + "\"}";
        return push_json("meta_job", job) < 0 ? 500 : 0;
    }

    if (segments.size() != 3) {
        return refuse("tile-path",
                      "a tile request is /tiles/{z}/{x}/{y}; got " +
                          std::to_string(segments.size()) + " path segment(s) after /tiles");
    }

    long z = 0, x = 0, y = 0;
    if (!parse_index(segments[0], &z) || !parse_index(segments[1], &x) ||
        !parse_index(segments[2], &y)) {
        return refuse("tile-bounds",
                      "z, x and y must be canonical non-negative integers");
    }
    if (z < kTileMinZoom || z > kTileMaxZoom) {
        return refuse("tile-bounds", "zoom " + std::to_string(z) + " is outside [" +
                                         std::to_string(kTileMinZoom) + ", " +
                                         std::to_string(kTileMaxZoom) + "]");
    }
    const long n = tile_n(z);
    if (x >= n || y >= n) {
        return refuse("tile-bounds", "tile " + std::to_string(z) + "/" + std::to_string(x) + "/" +
                                         std::to_string(y) + " is outside [0, " +
                                         std::to_string(n) + ") at this zoom");
    }

    const std::string sql = config_string(config, "cell_tile_sql", kDefaultTileSql);
    long max_rows = static_cast<long>(
        json_number_or(config, "cell_tile_max_rows", static_cast<double>(kDefaultTileMaxRows)));
    if (max_rows <= 0) max_rows = kDefaultTileMaxRows;

    const std::string rows_query = std::string("{\"sql\":\"") + json_escape(sql) +
                                   "\",\"params\":[{\"t\":\"i64\",\"v\":" +
                                   std::to_string(max_rows) + "}]}";
    if (push_json("rows_query", rows_query) < 0) return 500;
    if (push_json("tile_mark_query", mark_sql) < 0) return 500;

    const std::string job = std::string("{\"route\":\"cellular-tile\",\"z\":") + std::to_string(z) +
                            ",\"x\":" + std::to_string(x) + ",\"y\":" + std::to_string(y) +
                            ",\"maxRows\":" + std::to_string(max_rows) + ",\"provider_id\":\"" +
                            json_escape(provider) + "\"}";
    return push_json("tile_job", job) < 0 ? 500 : 0;
}

// ---------------------------------------------------------------------------
// tile_meta — the tile layer's capability envelope.
//
// The client fetches this ONCE and fails hard if it drifts: scheme must be
// "xyz", and minZoom/maxZoom/threshold/budget/densityN must all be integers.
// It is the server's declaration of the contract it will then honour on every
// tile, which is why the same constants author both.
// ---------------------------------------------------------------------------
int tile_meta(void) {
    if (refuse_batched()) return 500;

    const std::string job = input_text("job");
    if (job.empty()) {
        plugin_set_error("missing-job-frame", "tile_meta requires the meta job from tile_plan.");
        return 400;
    }

    std::string state;
    const std::string dataset = tile_dataset_json(input_text("mark"), &state);

    const std::string envelope =
        std::string("{\"scheme\":\"") + kTileScheme + "\"" +
        ",\"minZoom\":" + std::to_string(kTileMinZoom) +
        ",\"maxZoom\":" + std::to_string(kTileMaxZoom) +
        ",\"threshold\":" + std::to_string(kTileThreshold) +
        ",\"budget\":" + std::to_string(kTileBudget) +
        ",\"densityN\":" + std::to_string(kTileDensityN) +
        ",\"latClamp\":" + exact_double(kTileLatClamp) +
        ",\"tileUrlTemplate\":\"/api/v1/cellular/tiles/{z}/{x}/{y}\"" +
        ",\"deconfliction\":{\"statement\":\"Tiles are pre-deconflicted on the node: sites are "
        "merged across provider registries before storage, so a tile never carries the same "
        "site twice.\"}" +
        ",\"dataset\":" + dataset + "}";

    const std::string decision =
        std::string("{\"route\":\"cellular-tile-meta\",\"format\":\"json\",\"status\":200") +
        ",\"headers\":{\"x-sdn-cache\":\"" + state + "\"}}";

    if (push_bytes("body", reinterpret_cast<const uint8_t*>(envelope.data()),
                   static_cast<uint32_t>(envelope.size())) < 0) {
        return 500;
    }
    return push_json("decision", decision) < 0 ? 500 : 0;
}

// ---------------------------------------------------------------------------
// tile — ONE bounded tile, and the mode is the SERVER's.
//
//   count <= 2048  -> every point, sampled false
//   count <= 4096  -> a DETERMINISTIC stride sample, sampled true
//   count >  4096  -> a 16x16 density grid, points null
//
// The client refuses any tile that disagrees with those boundaries, so `count`
// is always the tile's TRUE population — never the number of points shipped.
// Reporting the shipped count instead would make a sampled tile look complete
// and a density tile look like a points tile that lost its rows.
//
// DETERMINISM IS THE POINT OF THE SAMPLE. The stride is derived from the count
// alone, over the rows in the order the query returned them, so the same store
// and the same tile produce byte-identical output on every runtime and every
// request — no RNG, no time, no thread count. A "representative" sample that
// varied per request would make the same tile flicker as the camera returned
// to it.
//
// AN EMPTY STORE ANSWERS EMPTY, NEVER FABRICATED: count 0, points [], and the
// dataset block saying cacheState "empty" so the client can say WHY there is
// nothing to draw instead of drawing zero towers over a populated planet.
// ---------------------------------------------------------------------------
int tile(void) {
    if (refuse_batched()) return 500;

    const std::string job = input_text("job");
    if (job.empty()) {
        plugin_set_error("missing-job-frame", "tile requires the tile job from tile_plan.");
        return 400;
    }

    // A refusal authored by tile_plan. It travels this far so that exactly one
    // node in the flow speaks to `respond`.
    std::string why;
    if (json_string_field(job, "refuse", &why) && !why.empty()) {
        std::string code = "tile-bounds";
        json_string_field(job, "code", &code);
        const std::string decision =
            std::string("{\"route\":\"error\",\"status\":400,\"code\":\"") + json_escape(code) +
            "\",\"error\":\"" + json_escape(why) + "\"}";
        return push_json("decision", decision) < 0 ? 500 : 0;
    }

    const long z = static_cast<long>(json_number_or(job, "z", -1));
    const long x = static_cast<long>(json_number_or(job, "x", -1));
    const long y = static_cast<long>(json_number_or(job, "y", -1));
    if (z < kTileMinZoom || z > kTileMaxZoom || x < 0 || y < 0) {
        plugin_set_error("invalid-tile-job", "the tile job does not carry a valid z/x/y.");
        return 500;
    }

    std::string state;
    const std::string dataset = tile_dataset_json(input_text("mark"), &state);

    std::vector<TilePoint> points;
    long scanned = 0;
    long malformed = 0;
    const plugin_input_frame_t* rows = frame_for("rows");
    if (rows && rows->payload && rows->payload_length > 0) {
        collect_tile_points(rows->payload, rows->payload_length, z, x, y, &points, &scanned,
                            &malformed);
    }

    const long count = static_cast<long>(points.size());
    std::string body;
    body.reserve(count > 0 ? static_cast<size_t>(count) * 48 + 512 : 512);
    body += std::string("{\"scheme\":\"") + kTileScheme + "\",\"z\":" + std::to_string(z) +
            ",\"x\":" + std::to_string(x) + ",\"y\":" + std::to_string(y) +
            ",\"count\":" + std::to_string(count) +
            ",\"threshold\":" + std::to_string(kTileThreshold) +
            ",\"budget\":" + std::to_string(kTileBudget) + ",\"deconflicted\":true" +
            ",\"scanned\":" + std::to_string(scanned) +
            ",\"malformed\":" + std::to_string(malformed) + ",\"dataset\":" + dataset;

    if (count > kTileBudget) {
        // DENSITY. The grid is linear in degrees inside the tile's own bounds,
        // because that is exactly how the client rebuilds a cell rectangle from
        // its south-west corner (densityCellRectangle: spanLon = (east - west)
        // / n). A Mercator-linear grid here would draw cells that do not tile
        // the parent, with visible gaps at the top of every tile.
        const TileBounds b = tile_bounds(z, x, y);
        const double span_lon = (b.east - b.west) / static_cast<double>(kTileDensityN);
        const double span_lat = (b.north - b.south) / static_cast<double>(kTileDensityN);
        std::vector<long> cells(static_cast<size_t>(kTileDensityN * kTileDensityN), 0);
        for (const TilePoint& p : points) {
            long col = span_lon > 0 ? static_cast<long>(std::floor((p.lon - b.west) / span_lon)) : 0;
            long row = span_lat > 0 ? static_cast<long>(std::floor((p.lat - b.south) / span_lat)) : 0;
            if (col < 0) col = 0;
            if (col > kTileDensityN - 1) col = kTileDensityN - 1;
            if (row < 0) row = 0;
            if (row > kTileDensityN - 1) row = kTileDensityN - 1;
            cells[static_cast<size_t>(row * kTileDensityN + col)]++;
        }
        // EMPTY CELLS ARE OMITTED, and the client REFUSES an empty cells array
        // outright. count > budget guarantees at least one cell is populated,
        // so the two rules cannot collide.
        body += ",\"mode\":\"density\",\"sampled\":false,\"points\":null";
        body += ",\"density\":{\"n\":" + std::to_string(kTileDensityN) + ",\"cells\":[";
        bool first = true;
        for (long row = 0; row < kTileDensityN; row++) {
            for (long col = 0; col < kTileDensityN; col++) {
                const long c = cells[static_cast<size_t>(row * kTileDensityN + col)];
                if (c == 0) continue;
                if (!first) body += ",";
                first = false;
                body += "{\"lon\":" + exact_double(b.west + static_cast<double>(col) * span_lon) +
                        ",\"lat\":" + exact_double(b.south + static_cast<double>(row) * span_lat) +
                        ",\"count\":" + std::to_string(c) + "}";
            }
        }
        body += "]}";
    } else {
        // POINTS, whole or deterministically sampled. The stride is
        // ceil(count / threshold), so a tile at the threshold ships every point
        // and one above it ships every other one — a monotone, reproducible
        // step, not a heuristic.
        long stride = 1;
        bool sampled = false;
        if (count > kTileThreshold) {
            stride = (count + kTileThreshold - 1) / kTileThreshold;
            sampled = true;
        }
        body += std::string(",\"mode\":\"points\",\"sampled\":") + (sampled ? "true" : "false") +
                ",\"density\":null,\"points\":[";
        bool first = true;
        for (long i = 0; i < count; i += stride) {
            if (!first) body += ",";
            first = false;
            body += "{\"LATITUDE\":" + fixed7(points[static_cast<size_t>(i)].lat) +
                    ",\"LONGITUDE\":" + fixed7(points[static_cast<size_t>(i)].lon) + "}";
        }
        body += "]";
    }
    body += "}";

    const std::string decision =
        std::string("{\"route\":\"cellular-tile\",\"format\":\"json\",\"status\":200") +
        ",\"headers\":{\"x-sdn-cache\":\"" + state + "\",\"x-sdn-tile\":\"" + std::to_string(z) +
        "/" + std::to_string(x) + "/" + std::to_string(y) + "\"}}";

    if (push_bytes("body", reinterpret_cast<const uint8_t*>(body.data()),
                   static_cast<uint32_t>(body.size())) < 0) {
        return 500;
    }
    return push_json("decision", decision) < 0 ? 500 : 0;
}

// mark_query: timer tick -> the flatsql-query JSON that reads this provider's
// resume mark back. It is a SEPARATE node from ingest_plan on purpose: the plan
// needs the mark as an input, and a node that emitted its own input would be a
// cycle in the flow graph.
//
// EMITS {"sql","params"}, NOT {"table","where","limit"}. The original shape was
// refused by the node that consumes it: hostcap/flatsql-query's `query` reads
// `sql` and returns 400 `missing-sql` for anything else
// (hostcap/flatsql-query/src/flatsql_query_module.cpp:465-469), so the mark read
// could never have executed. It is fixed on discovery rather than filed, per the
// standing rule on broken basics.
int mark_query(void) {
    if (refuse_batched()) return 500;
    const std::string config = load_config();
    const std::string provider = config_string(config, "cell_ingest_provider_id", "opencellid");
    const std::string query = std::string("{\"sql\":\"SELECT * FROM ") + kMarkTable +
                              " WHERE provider_id = ? LIMIT 1\"" +
                              ",\"params\":[{\"t\":\"str\",\"v\":\"" + json_escape(provider) +
                              "\"}]}";
    return push_json("query", query) < 0 ? 500 : 0;
}

// ingest_plan: tick (+ the resume mark, when one exists) -> ONE ranged fetch
// descriptor plus the cell-tower-source `parse` run contract for that chunk.
//
// Emitting one chunk per tick rather than looping in-guest is deliberate: the
// loop's state then lives in the durable mark instead of in a guest instance
// that a restart erases, which is the whole point of the exercise.
int ingest_plan(void) {
    if (refuse_batched()) return 500;

    const std::string config = load_config();
    const std::string provider = config_string(config, "cell_ingest_provider_id", "opencellid");
    const std::string url = config_string(config, "cell_ingest_url", "");
    if (url.empty()) {
        // Fail-closed: with no source configured there is nothing to range over,
        // and inventing a default URL would ingest a provider nobody selected.
        plugin_set_error("missing-ingest-url",
                         "ingest_plan requires cell_ingest_url in node CONFIG.");
        return 400;
    }

    const std::string mark = input_text("mark");
    long offset = 0;
    long total = 0;
    long chunk_index = 0;
    long prior_stored_rows = 0;
    if (!mark.empty()) {
        std::string mark_provider;
        // A mark belonging to a DIFFERENT provider is ignored rather than
        // trusted: resuming provider A at provider B's offset would skip the
        // head of B's file and never report it.
        if (json_string_field(mark, "provider_id", &mark_provider) && mark_provider == provider) {
            offset = static_cast<long>(json_number_or(mark, "next_offset", 0));
            total = static_cast<long>(json_number_or(mark, "total_bytes", 0));
            chunk_index = static_cast<long>(json_number_or(mark, "chunk_index", 0));
            prior_stored_rows = static_cast<long>(json_number_or(mark, "stored_rows", 0));
            if (offset < 0) offset = 0;
            if (prior_stored_rows < 0) prior_stored_rows = 0;
        }
    }

    // Already complete: emit NOTHING. The downstream http node never becomes
    // ready and the run ends without a fetch. A finished file is not an error.
    if (total > 0 && offset >= total) return 0;

    const long chunk = config_chunk_bytes(config);
    long last = offset + chunk - 1;
    if (total > 0 && last > total - 1) last = total - 1;

    char range_buf[80];
    std::snprintf(range_buf, sizeof(range_buf), "bytes=%ld-%ld", offset, last);
    char timeout_buf[24];
    std::snprintf(timeout_buf, sizeof(timeout_buf), "%ld", config_timeout_ms(config));

    const std::string request = std::string("{\"method\":\"GET\",\"url\":\"") + json_escape(url) +
                                "\",\"headers\":{\"Range\":\"" + range_buf + "\"}" +
                                ",\"timeoutMs\":" + timeout_buf + "}";

    // The job is cell-tower-source's `parse`/`deconflict` run contract verbatim
    // (method/method_name/limit/providers_consulted/request_providers/skipped),
    // so the ingest lane reuses those nodes without forking the deconfliction
    // rules. `request_providers` is what correlates response frames to providers
    // positionally, so it must name exactly the one descriptor emitted above.
    // The chunk fields ride alongside for ingest_meta; parse ignores what it
    // does not know.
    // MM_HIGHEST_SAMPLE_COUNT (1), never MM_SINGLE_SOURCE (0). Sites arrive from
    // OVERLAPPING registries, so single-source is the one mode that guarantees
    // the duplicates survive into storage — and a duplicated site set is
    // indistinguishable from a larger one once stored.
    const long method = static_cast<long>(json_number_or(config, "cell_ingest_merge_method", 1));
    const long limit = static_cast<long>(json_number_or(config, "cell_ingest_limit", 1000000));
    char nums[128];
    std::snprintf(nums, sizeof(nums), "%ld,\"limit\":%ld,\"chunk_offset\":%ld,\"chunk_index\":%ld",
                  method, limit, offset, chunk_index);
    const std::string job =
        std::string("{\"method\":") + nums + ",\"method_name\":\"" +
        json_escape(config_string(config, "cell_ingest_merge_method_name", "HIGHEST_SAMPLE_COUNT")) +
        "\"" + ",\"providers_consulted\":[\"" + json_escape(provider) + "\"]" +
        ",\"request_providers\":[\"" + json_escape(provider) + "\"]" + ",\"skipped\":[]" +
        ",\"provider_id\":\"" + json_escape(provider) + "\"" + ",\"source_url\":\"" +
        json_escape(url) + "\"" + ",\"prior_stored_rows\":" + std::to_string(prior_stored_rows) +
        ",\"chunk_bytes\":" + std::to_string(chunk) + "}";

    // Job first: parse and deconflict both need the run contract, and a response
    // arriving before it would have nothing to be interpreted against.
    if (push_json("job", job) < 0) return 500;
    if (push_json("request", request) < 0) return 500;
    return 0;
}

// ingest_meta: the cell-tower-source `job`, the deconflicted $TBS record stream,
// the deconflict `decision` and the raw http `response` -> the
// hostcap/storage-ingest `meta` frame and the records, forwarded.
//
// The records are passed through untouched. This node exists to author the
// attribution the storage lane cannot invent — provider, source, batch and the
// $TBS.SOURCES provenance — which is why it sits between deconflict and storage
// rather than being folded into either.
//
// It also takes the http `response` because THE OBJECT'S TOTAL SIZE IS ONLY
// KNOWABLE HERE. `Content-Range: bytes A-B/TOTAL` is the sole authority on
// TOTAL; the guest that dispatched the range never sees the reply, and
// Content-Length on a 206 describes the CHUNK, so reading it as the total would
// end the run after one chunk with every later byte silently unfetched. The
// total is carried onto the meta so publish_request can write it into the mark.
int ingest_meta(void) {
    if (refuse_batched()) return 500;

    const std::string job = input_text("job");
    if (job.empty()) {
        plugin_set_error("missing-job-frame", "ingest_meta requires the run-contract job frame.");
        return 400;
    }
    const plugin_input_frame_t* records = frame_for("records");
    if (!records || !records->payload) {
        plugin_set_error("missing-records-frame",
                         "ingest_meta requires the deconflicted record stream.");
        return 400;
    }

    const std::string config = load_config();
    std::string provider;
    std::string source_url;
    json_string_field(job, "provider_id", &provider);
    json_string_field(job, "source_url", &source_url);
    if (provider.empty() || source_url.empty()) {
        plugin_set_error("incomplete-job-attribution",
                         "ingest_meta needs provider_id and source_url on the job frame.");
        return 400;
    }

    const long chunk_index = static_cast<long>(json_number_or(job, "chunk_index", 0));
    const long chunk_offset = static_cast<long>(json_number_or(job, "chunk_offset", 0));
    const long chunk_bytes =
        static_cast<long>(json_number_or(job, "chunk_bytes", kDefaultChunkBytes));

    // Total object size from Content-Range's denominator (see the note above).
    // Absent or "*" leaves total 0, which the mark reads as "length still
    // unknown" and keeps ranging — it never reads as "finished".
    long total_bytes = 0;
    const std::string response = input_text("response");
    if (!response.empty()) {
        std::string headers;
        const size_t h = response.find("\"headers\"");
        if (h != std::string::npos) {
            const size_t open = response.find('{', h);
            if (open != std::string::npos) {
                int depth = 0;
                size_t i = open;
                for (; i < response.size(); i++) {
                    if (response[i] == '{') depth++;
                    else if (response[i] == '}' && --depth == 0) break;
                }
                if (i < response.size()) headers = response.substr(open, i - open + 1);
            }
        }
        if (!headers.empty()) total_from_content_range(headers, &total_bytes);
    }

    // ROW-BOUNDARY CORRECTION. A byte range does not respect record boundaries:
    // a chunk almost always ends mid-row, and the next chunk starting at
    // offset+chunk_bytes would begin mid-row too. Both partial rows are then
    // DROPPED by the decoder's own field guards — silently, because a short row
    // is indistinguishable from a malformed one, and the loss is invisible in
    // every count the run reports.
    //
    // So the next offset is the end of the last COMPLETE row in this chunk, not
    // the end of the chunk. The overlap is re-fetched and re-decoded, which is
    // free: the storage lane is content-addressed and the row is identical.
    // This node is the only one that sees both the body and the offset, which is
    // why the correction lives here.
    // Falls back to the nominal chunk end only when the body is unavailable —
    // never silently, since that is the case a test must be able to see.
    long next_offset = chunk_offset + chunk_bytes;
    std::string body_b64;
    if (json_string_field(response, "bodyB64", &body_b64) && !body_b64.empty()) {
        const std::string body = base64_decode(body_b64);
        const size_t nl = body.rfind('\n');
        // No newline at all means the chunk holds no complete row. Advancing by
        // the chunk size would skip it; the run must widen the chunk instead, so
        // the offset does not move and the condition is reported.
        if (nl != std::string::npos) next_offset = chunk_offset + static_cast<long>(nl) + 1;
    }

    // The record count this chunk actually produced, from deconflict's decision.
    // publish_request needs it to tell a real empty tail from a stored-nothing
    // refusal; -1 (absent) disables that check rather than faking a count.
    const std::string decision = input_text("decision");
    const long records_in =
        decision.empty() ? -1 : static_cast<long>(json_number_or(decision, "sitesOut", -1));

    // ONE BATCH PER CHUNK. A single batch id spanning every chunk would make the
    // storage lane's source-batch reconcile treat each chunk as the provider's
    // complete current set and delete the chunks before it — the whole ingest
    // would converge on the last chunk alone.
    char batch_buf[96];
    std::snprintf(batch_buf, sizeof(batch_buf), "%s@%ld", provider.c_str(), chunk_offset);
    const std::string batch_id = batch_buf;

    char prov_buf[192];
    std::snprintf(prov_buf, sizeof(prov_buf),
                  "{\"source_url\":\"%s\",\"chunk_index\":%ld,\"chunk_offset\":%ld}",
                  json_escape(source_url).c_str(), chunk_index, chunk_offset);
    const std::string provenance = prov_buf;

    const std::string meta =
        std::string("{\"schema\":\"") + kSchema + "\"" + ",\"provider_id\":\"" +
        json_escape(provider) + "\"" + ",\"source_name\":\"" +
        json_escape(config_string(config, "cell_ingest_source_name", "cell-tower-bulk")) + "\"" +
        ",\"source_url\":\"" + json_escape(source_url) + "\"" + ",\"batch_id\":\"" +
        json_escape(batch_id) + "\"" +
        // `append` and NOT the celestrak lane's source-batch reconcile: this
        // batch is one CHUNK of the provider's set, not the set. Reconciling
        // here would delete every earlier chunk on arrival of the next one.
        ",\"reconcile\":\"append\"" +
        // Chunk state rides on the meta because the meta is the ONLY frame that
        // reaches publish_request alongside the storage result, and that is
        // where the resume mark is authored.
        ",\"chunk_offset\":" + std::to_string(chunk_offset) +
        ",\"chunk_index\":" + std::to_string(chunk_index) +
        ",\"chunk_bytes\":" + std::to_string(chunk_bytes) +
        ",\"total_bytes\":" + std::to_string(total_bytes) +
        ",\"next_offset\":" + std::to_string(next_offset) +
        ",\"records_in\":" + std::to_string(records_in) +
        ",\"prior_stored_rows\":" +
        std::to_string(static_cast<long>(json_number_or(job, "prior_stored_rows", 0))) +
        ",\"provenance\":{\"source\":\"cell-tower-ingest-wasm/v1\"" + ",\"json\":\"" +
        base64_encode(reinterpret_cast<const uint8_t*>(provenance.data()), provenance.size()) +
        "\"}}";

    if (push_json("meta", meta) < 0) return 500;
    if (push_bytes("records", records->payload, records->payload_length) < 0) return 500;
    return 0;
}

// publish_request: the storage-ingest `result` joined with the `meta` that
// produced it -> the advanced resume mark, and (only when configured) the
// dataset-publication POST.
//
// The mark is emitted on its own port and is NOT gated on the publish URL: a
// node that stores without publishing must still make progress, or an unpublished
// deployment re-ingests chunk 0 forever.
int publish_request(void) {
    if (refuse_batched()) return 500;

    const std::string result = input_text("result");
    if (result.empty()) {
        plugin_set_error("missing-result-frame",
                         "publish_request requires the storage-ingest result frame.");
        return 400;
    }
    const std::string meta = input_text("meta");
    if (meta.empty()) {
        plugin_set_error("missing-meta-frame", "publish_request requires the ingest meta frame.");
        return 400;
    }

    std::string provider;
    std::string source_url;
    std::string batch_id;
    json_string_field(meta, "provider_id", &provider);
    json_string_field(meta, "source_url", &source_url);
    json_string_field(meta, "batch_id", &batch_id);

    // THE SILENT NOP, CAUGHT. hostcap/storage-ingest already errors on
    // `ok:false`, which covers the disk-floor errCapJSON refusal. What survives
    // that check is `ok:true, inserted:0` — byte-identical to a healthy empty
    // tail. It is only distinguishable against the count the run actually
    // produced, so the flow carries `records_in` on the result join and the mark
    // does NOT advance when records went in and nothing came out.
    const long inserted = static_cast<long>(json_number_or(result, "inserted", -1));
    const long records_in = static_cast<long>(json_number_or(meta, "records_in", -1));
    if (inserted == 0 && records_in > 0) {
        char message[256];
        std::snprintf(message, sizeof(message),
                      "storage.ingest_with_source reported ok with inserted=0 for a chunk "
                      "carrying %ld records (provider %s, batch %s). The resume mark is NOT "
                      "advanced: advancing here would skip these rows permanently.",
                      records_in, provider.c_str(), batch_id.c_str());
        plugin_set_error("ingest-stored-nothing", message);
        return 502;
    }

    const long chunk_offset = static_cast<long>(json_number_or(meta, "chunk_offset", 0));
    const long chunk_index = static_cast<long>(json_number_or(meta, "chunk_index", 0));
    const long total = static_cast<long>(json_number_or(meta, "total_bytes", 0));
    // The ROW-BOUNDARY-CORRECTED offset ingest_meta computed from the body, not
    // the nominal chunk end: resuming at the nominal end would start mid-row and
    // silently drop the row that straddles the boundary.
    const long next_offset =
        static_cast<long>(json_number_or(meta, "next_offset", static_cast<double>(chunk_offset)));

    // CUMULATIVE, and only what STORAGE confirmed. `inserted` is the storage
    // lane's own count; a negative (absent) value adds nothing rather than
    // guessing from records_in, because the read side reports this number to
    // users as "records in the store".
    long prior_stored = static_cast<long>(json_number_or(meta, "prior_stored_rows", 0));
    if (prior_stored < 0) prior_stored = 0;
    const long stored_rows = prior_stored + (inserted > 0 ? inserted : 0);

    const std::string next_mark = mark_json(provider, source_url, next_offset, total,
                                            chunk_index + 1, batch_id, stored_rows, iso_now());
    if (push_json("mark", next_mark) < 0) return 500;

    const std::string config = load_config();
    std::string publish_url;
    if (!json_string_field(config, "cell_ingest_publish_url", &publish_url) || publish_url.empty()) {
        // Fail-closed. Absence of configuration is not permission to publish.
        return 0;
    }

    std::string schema;
    if (!json_string_field(result, "schema", &schema) || schema.empty()) {
        json_string_field(meta, "schema", &schema);
    }
    std::string source;
    json_string_field(meta, "source_name", &source);
    if (schema.empty() || batch_id.empty() || provider.empty() || source.empty()) {
        plugin_set_error("incomplete-publication-identity",
                         "publish_request needs schema, batchId, providerId and sourceName.");
        return 400;
    }

    const std::string body = std::string("{\"schema\":\"") + json_escape(schema) + "\"" +
                             ",\"providerId\":\"" + json_escape(provider) + "\"" +
                             ",\"sourceName\":\"" + json_escape(source) + "\"" +
                             ",\"batchId\":\"" + json_escape(batch_id) + "\"}";
    char timeout_buf[24];
    std::snprintf(timeout_buf, sizeof(timeout_buf), "%ld", config_timeout_ms(config));
    const std::string request =
        std::string("{\"method\":\"POST\",\"url\":\"") + json_escape(publish_url) + "\"" +
        ",\"headers\":{\"content-type\":\"application/json\"}" + ",\"bodyB64\":\"" +
        base64_encode(reinterpret_cast<const uint8_t*>(body.data()), body.size()) + "\"" +
        ",\"timeoutMs\":" + timeout_buf + "}";
    return push_json("request", request) < 0 ? 500 : 0;
}

}  // extern "C"
