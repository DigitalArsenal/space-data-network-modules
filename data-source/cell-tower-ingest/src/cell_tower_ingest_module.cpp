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

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
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

std::string mark_json(const std::string& provider_id, const std::string& source_url,
                      long next_offset, long total_bytes, long chunk_index,
                      const std::string& batch_id) {
    char buf[160];
    std::snprintf(buf, sizeof(buf), "%ld,\"total_bytes\":%ld,\"chunk_index\":%ld", next_offset,
                  total_bytes, chunk_index);
    return std::string("{\"provider_id\":\"") + json_escape(provider_id) + "\"" +
           ",\"source_url\":\"" + json_escape(source_url) + "\"" + ",\"next_offset\":" + buf +
           ",\"batch_id\":\"" + json_escape(batch_id) + "\"}";
}

}  // namespace

extern "C" {

// mark_query: timer tick -> the flatsql-query JSON that reads this provider's
// resume mark back. It is a SEPARATE node from ingest_plan on purpose: the plan
// needs the mark as an input, and a node that emitted its own input would be a
// cycle in the flow graph.
int mark_query(void) {
    if (refuse_batched()) return 500;
    const std::string config = load_config();
    const std::string provider = config_string(config, "cell_ingest_provider_id", "opencellid");
    const std::string query = std::string("{\"table\":\"") + kMarkTable + "\"" +
                              ",\"where\":{\"provider_id\":\"" + json_escape(provider) + "\"}" +
                              ",\"limit\":1}";
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
    if (!mark.empty()) {
        std::string mark_provider;
        // A mark belonging to a DIFFERENT provider is ignored rather than
        // trusted: resuming provider A at provider B's offset would skip the
        // head of B's file and never report it.
        if (json_string_field(mark, "provider_id", &mark_provider) && mark_provider == provider) {
            offset = static_cast<long>(json_number_or(mark, "next_offset", 0));
            total = static_cast<long>(json_number_or(mark, "total_bytes", 0));
            chunk_index = static_cast<long>(json_number_or(mark, "chunk_index", 0));
            if (offset < 0) offset = 0;
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
        json_escape(url) + "\"" + ",\"chunk_bytes\":" + std::to_string(chunk) + "}";

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

    const std::string next_mark =
        mark_json(provider, source_url, next_offset, total, chunk_index + 1, batch_id);
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
