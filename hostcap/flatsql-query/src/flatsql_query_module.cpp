/*
 * hostcap/flatsql-query (loop C.3c2; sandbox_query added in gateway loop G.5).
 *
 * Generalized engine query node for the storage.flatsql_query_* hostcalls.
 * Methods:
 *
 *   query — "query" JSON {"sql":"...","params":[tagged]} ->
 *           storage.flatsql_query_stream; the ALIGNED size-prefixed
 *           FlatBuffer result stream (hostcall binary segment 0) passes
 *           through VERBATIM on the "stream" port. (The OPERATOR surface —
 *           unsandboxed, auth-gated at the wall.)
 *
 *   sandbox_query — the PUBLIC /api/v1/query surface (gateway loop G.5).
 *           Routing-decision JSON in ("public_query" | "query_surface" from
 *           http-route route_public_query), one response decision out plus
 *           body/etag/stream frames for http-respond. Data path is the
 *           policy-mediated READ-ONLY storage.query_sandboxed hostcall: the
 *           engine enforces the sandbox IN-WASM (authorizer over record
 *           tables/shadows/views, single-statement SELECT, statement
 *           timeout, row/byte caps — configured host-side, gateway.query).
 *           sort/limit/profile request params compose the effective SQL
 *           HERE (in wasm), never on the host. Sandbox rejections map to
 *           HTTP statuses: validation 400, non-BLOB-projection-as-fb 406,
 *           resource caps (timeout/row-cap/byte-cap) 422.
 *
 * data-source/retrieval remains the profile-aware variant (epoch profiles,
 * SDS CAQ envelopes); this node is the raw JSON-in / stream-out primitive.
 *
 * TRANSITIONAL: flatsql is becoming a component dependency with direct
 * in-wasm linkage in a later task; until then this node rides the hostcall
 * bridge (server-only — see the manifest description).
 */

#include <cstdint>
#include <cstdio>
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

// ---------------------------------------------------------------------------
// Hostcall wire envelope helpers.
// ---------------------------------------------------------------------------

void write_u32le(uint8_t* dst, uint32_t value) {
    dst[0] = static_cast<uint8_t>(value & 0xff);
    dst[1] = static_cast<uint8_t>((value >> 8) & 0xff);
    dst[2] = static_cast<uint8_t>((value >> 16) & 0xff);
    dst[3] = static_cast<uint8_t>((value >> 24) & 0xff);
}

uint32_t read_u32le(const uint8_t* src) {
    return static_cast<uint32_t>(src[0]) | (static_cast<uint32_t>(src[1]) << 8) |
           (static_cast<uint32_t>(src[2]) << 16) | (static_cast<uint32_t>(src[3]) << 24);
}

std::vector<uint8_t> hostcall(const char* op, const std::string& payload_json) {
    std::vector<uint8_t> req(4 + payload_json.size() + 4, 0);
    write_u32le(req.data(), static_cast<uint32_t>(payload_json.size()));
    std::memcpy(req.data() + 4, payload_json.data(), payload_json.size());
    sdm_host_call(reinterpret_cast<const uint8_t*>(op),
                  static_cast<int32_t>(std::strlen(op)),
                  req.data(), static_cast<int32_t>(req.size()));
    const int32_t len = sdm_host_response_len();
    std::vector<uint8_t> buf(len > 0 ? static_cast<size_t>(len) : 0);
    if (len > 0) {
        sdm_host_read_response(buf.data(), len);
    }
    return buf;
}

std::string envelope_meta_json(const std::vector<uint8_t>& env) {
    if (env.size() < 4) return std::string();
    const uint32_t meta_len = read_u32le(env.data());
    if (env.size() < 4u + meta_len) return std::string();
    return std::string(reinterpret_cast<const char*>(env.data() + 4), meta_len);
}

bool envelope_first_segment(const std::vector<uint8_t>& env,
                            const uint8_t** seg_out, uint32_t* seg_len_out) {
    *seg_out = nullptr;
    *seg_len_out = 0;
    if (env.size() < 4) return false;
    const uint32_t meta_len = read_u32le(env.data());
    size_t off = 4u + meta_len;
    if (off + 4 > env.size()) return false;
    const uint32_t seg_count = read_u32le(env.data() + off);
    off += 4;
    if (seg_count == 0 || off + 4 > env.size()) return false;
    const uint32_t seg_len = read_u32le(env.data() + off);
    off += 4;
    if (off + seg_len > env.size()) return false;
    *seg_out = env.data() + off;
    *seg_len_out = seg_len;
    return true;
}

bool meta_ok(const std::string& meta) {
    return meta.find("\"ok\":true") != std::string::npos;
}

// ---------------------------------------------------------------------------
// Minimal JSON field extraction (control metadata only).
// ---------------------------------------------------------------------------

bool is_json_ws(char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

bool json_string_field(const std::string& json, const std::string& key, std::string* out) {
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return false;
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return false;
    size_t i = colon + 1;
    while (i < json.size() && is_json_ws(json[i])) i++;
    if (i >= json.size() || json[i] != '"') return false;
    i++;
    std::string value;
    while (i < json.size() && json[i] != '"') {
        if (json[i] == '\\' && i + 1 < json.size()) {
            const char n = json[i + 1];
            if (n == 'n') value.push_back('\n');
            else if (n == 't') value.push_back('\t');
            else if (n == 'r') value.push_back('\r');
            else value.push_back(n);
            i += 2;
        } else {
            value.push_back(json[i]);
            i++;
        }
    }
    *out = value;
    return true;
}

std::string json_array_slice(const std::string& json, const std::string& key) {
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return std::string();
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return std::string();
    size_t i = colon + 1;
    while (i < json.size() && is_json_ws(json[i])) i++;
    if (i >= json.size() || json[i] != '[') return std::string();
    const size_t start = i;
    int depth = 0;
    bool in_string = false;
    for (; i < json.size(); i++) {
        const char c = json[i];
        if (in_string) {
            if (c == '\\') i++;
            else if (c == '"') in_string = false;
            continue;
        }
        if (c == '"') in_string = true;
        else if (c == '[') depth++;
        else if (c == ']') {
            depth--;
            if (depth == 0) return json.substr(start, i - start + 1);
        }
    }
    return std::string();
}

std::string json_escape(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (const char c : s) {
        if (c == '"' || c == '\\') { out.push_back('\\'); out.push_back(c); }
        else if (c == '\n') out += "\\n";
        else if (c == '\r') out += "\\r";
        else if (c == '\t') out += "\\t";
        else out.push_back(c);
    }
    return out;
}

// Colon-anchored variant (the G.3 key-vs-value lesson): only matches
// "key": occurrences, so a string VALUE equal to the key name can never be
// misread as the key.
bool json_string_field_anchored(const std::string& json, const std::string& key, std::string* out) {
    const std::string needle = "\"" + key + "\":";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return false;
    size_t i = k + needle.size();
    while (i < json.size() && is_json_ws(json[i])) i++;
    if (i >= json.size() || json[i] != '"') return false;
    i++;
    std::string value;
    while (i < json.size() && json[i] != '"') {
        if (json[i] == '\\' && i + 1 < json.size()) {
            const char n = json[i + 1];
            if (n == 'n') value.push_back('\n');
            else if (n == 't') value.push_back('\t');
            else if (n == 'r') value.push_back('\r');
            else value.push_back(n);
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
    const std::string needle = "\"" + key + "\":";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return false;
    size_t i = k + needle.size();
    while (i < json.size() && is_json_ws(json[i])) i++;
    if (i >= json.size()) return false;
    const char c = json[i];
    if (c != '-' && (c < '0' || c > '9')) return false;
    char* end = nullptr;
    const double value = strtod(json.c_str() + i, &end);
    if (end == json.c_str() + i) return false;
    *out = value;
    return true;
}

// Slice "key":{...} (brace-depth scan, string-aware).
std::string json_object_slice(const std::string& json, const std::string& key) {
    const std::string needle = "\"" + key + "\":";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return std::string();
    size_t i = k + needle.size();
    while (i < json.size() && is_json_ws(json[i])) i++;
    if (i >= json.size() || json[i] != '{') return std::string();
    const size_t start = i;
    int depth = 0;
    bool in_string = false;
    for (; i < json.size(); i++) {
        const char c = json[i];
        if (in_string) {
            if (c == '\\') i++;
            else if (c == '"') in_string = false;
            continue;
        }
        if (c == '"') in_string = true;
        else if (c == '{') depth++;
        else if (c == '}') {
            depth--;
            if (depth == 0) return json.substr(start, i - start + 1);
        }
    }
    return std::string();
}

// FNV-1a 64 etag — byte-for-byte the same algorithm and format as
// foundation/decision-gate and foundation/discovery-shape (word-folded
// 8-byte main loop), so identical streams carry identical tags across all
// gateway flows.
std::string fnv1a64_etag(const uint8_t* data, uint32_t length) {
    constexpr uint64_t kPrime = 1099511628211ull;
    uint64_t hash = 1469598103934665603ull;
    uint32_t i = 0;
    for (; i + 8 <= length; i += 8) {
        uint64_t word;
        std::memcpy(&word, data + i, 8);
        hash ^= word;
        hash *= kPrime;
    }
    for (; i < length; i++) {
        hash ^= data[i];
        hash *= kPrime;
    }
    char buf[40];
    std::snprintf(buf, sizeof(buf), "W/\"fnv1a64-%016llx\"",
                  static_cast<unsigned long long>(hash));
    return std::string(buf);
}

// ---------------------------------------------------------------------------
// sandbox_query support (gateway loop G.5).
// ---------------------------------------------------------------------------

// Engine-native epoch profile SQL over the unified OMM view — byte-identical
// to sdn-server internal/storage/engine_records.go and data-source/retrieval
// (same engine query identity). Positional params: ?1 source shadow name
// ('' = all), ?2 epoch unix seconds, ?3 limit.
constexpr const char* kPQEpochNearestSQL =
    "SELECT _data FROM (SELECT _data, ROW_NUMBER() OVER (PARTITION BY NORAD_CAT_ID ORDER BY "
    "ABS(USER_DEFINED_EPOCH_TIMESTAMP - ?2)) rn FROM OMM WHERE (?1 = '' OR _source = ?1)) WHERE "
    "rn = 1 LIMIT ?3";
constexpr const char* kPQEpochAsOfSQL =
    "SELECT _data FROM (SELECT _data, ROW_NUMBER() OVER (PARTITION BY NORAD_CAT_ID ORDER BY "
    "USER_DEFINED_EPOCH_TIMESTAMP DESC) rn FROM OMM WHERE (?1 = '' OR _source = ?1) AND "
    "USER_DEFINED_EPOCH_TIMESTAMP <= ?2) WHERE rn = 1 LIMIT ?3";
constexpr const char* kPQEpochForwardSQL =
    "SELECT _data FROM (SELECT _data, ROW_NUMBER() OVER (PARTITION BY NORAD_CAT_ID ORDER BY "
    "USER_DEFINED_EPOCH_TIMESTAMP ASC) rn FROM OMM WHERE (?1 = '' OR _source = ?1) AND "
    "USER_DEFINED_EPOCH_TIMESTAMP >= ?2) WHERE rn = 1 LIMIT ?3";

const char* pq_epoch_profile_sql(const std::string& profile) {
    std::string p = profile;
    if (p.rfind("epoch.", 0) == 0) p = p.substr(6);
    if (p == "nearest") return kPQEpochNearestSQL;
    if (p == "as_of") return kPQEpochAsOfSQL;
    if (p == "forward") return kPQEpochForwardSQL;
    return nullptr;
}

constexpr long kPQDefaultProfileLimit = 50000;

// Validate a "COL [ASC|DESC]" sort request; emits a quoted ORDER BY clause.
// Column chars are restricted to [A-Za-z0-9_@] (engine column and shadow
// names) — anything else is rejected (the caller answers 400).
bool pq_build_order_by(const std::string& sort, std::string* out) {
    std::string col = sort;
    std::string dir;
    const size_t space = sort.find(' ');
    if (space != std::string::npos) {
        col = sort.substr(0, space);
        std::string rest = sort.substr(space + 1);
        while (!rest.empty() && rest.front() == ' ') rest.erase(rest.begin());
        while (!rest.empty() && rest.back() == ' ') rest.pop_back();
        std::string upper;
        for (char c : rest) upper.push_back(c >= 'a' && c <= 'z' ? static_cast<char>(c - 'a' + 'A') : c);
        if (upper == "ASC" || upper == "DESC") {
            dir = upper;
        } else if (!rest.empty()) {
            return false;
        }
    }
    if (col.empty()) return false;
    for (char c : col) {
        const bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                        (c >= '0' && c <= '9') || c == '_' || c == '@';
        if (!ok) return false;
    }
    *out = " ORDER BY \"" + col + "\"";
    if (!dir.empty()) *out += " " + dir;
    return true;
}

// Map a storage.query_sandboxed failure to an HTTP status:
//   sandbox validation (not-authorized / multi-statement / read-only /
//   not-select / empty-statement / params / mode)          -> 400
//   not-a-record-stream (projection requested as fb)       -> 406
//   resource caps (timeout / row-cap / byte-cap)           -> 422
//   plain SQL errors (syntax, unknown column)              -> 400
//   host/engine failures                                   -> 502
long pq_error_status(const std::string& code, const std::string& message) {
    if (code == "timeout" || code == "row-cap" || code == "byte-cap") return 422;
    if (code == "not-a-record-stream") return 406;
    if (!code.empty()) return 400;
    if (message.find("SQL error") != std::string::npos) return 400;
    return 502;
}

int fail_from_meta(const char* code, const std::string& meta, const char* fallback) {
    std::string message;
    json_string_field(meta, "message", &message);
    plugin_set_error(code, message.empty() ? fallback : message.c_str());
    return 502;
}

// ---------------------------------------------------------------------------
// SURPLUS-FRAME REFUSAL — graph task `modules-guest-nodes-drop-batched-frames`.
//
// `space_data_module_runtime_begin_node_invocation` (module-SDK
// src/flow/runtime-src/flow_runtime.cpp) fills an invocation by popping the
// node's queue `while (count < budget && !queue.empty())`: PORT-BLIND, with a
// drain budget of 64. `maxStreams`, `maxBatch` and `drainPolicy` are purely
// DECLARATIVE in the compiled runtime — enforced at compose time and in the
// JS-only reference runtime, never by the baked runtime.wasm. So a guest that
// reads ordinal 0 of a port and returns DESTROYS every other frame it was
// handed on that port: they are already dequeued, nothing re-delivers them,
// and nothing logs the loss.
//
// That is measured, not hypothetical. It was a live P1
// (`cellular-multiprovider-returns-only-first-provider`) that survived four
// passes precisely because a partial answer is indistinguishable from an
// honest one: a two-provider request performed exactly ONE outbound fetch and
// returned the first provider's records, byte-identical to that provider run
// alone, with no error anywhere.
//
// Both methods answer ONE query. Note what was here before: `query` read
// `plugin_get_input_frame(0)` with NO port filter at all, and `sandbox_query`
// fell back to frame 0 when it could not find its `decision` port - and frame 0
// is NOT promised to be on any particular port, so both could execute a frame
// that belonged to a different port entirely. Port-blind reads are gone.
//
// So a surplus is REFUSED rather than silently dropped — a named node error
// the flow surfaces, instead of an answer assembled from whichever frame the
// queue happened to hold first (queue order is not semantic order, so such an
// answer is arbitrary AND indistinguishable from a correct one). This costs
// nothing while the contract holds: one frame per port is what every deployed
// flow delivers today.
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

}  // namespace

extern "C" {

// query: {"sql","params"} -> storage.flatsql_query_stream -> "stream"
// verbatim aligned size-prefixed FlatBuffer bytes.
int query(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

    // PORT-FILTERED, not frame 0. This read used to be
    // `plugin_get_input_frame(0)` with no port filter at all, and frame 0 is
    // NOT promised to be on any particular port — the runtime hands a node
    // whatever is queued on it, in queue order. Executing SQL taken from a
    // frame that belonged to a different port is the sharpest edge of the
    // whole class (graph task modules-guest-nodes-drop-batched-frames).
    const int32_t query_index = plugin_find_input_index("query", 0);
    const plugin_input_frame_t* frame =
        query_index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(query_index)) : nullptr;
    if (!frame || !frame->payload || frame->payload_length == 0) {
        plugin_set_error("missing-query-frame",
                         "query requires a query JSON frame on port \"query\".");
        return 400;
    }
    const std::string request(reinterpret_cast<const char*>(frame->payload),
                              frame->payload_length);

    std::string sql;
    if (!json_string_field(request, "sql", &sql) || sql.empty()) {
        plugin_set_error("missing-sql", "query requires {\"sql\":\"...\"}.");
        return 400;
    }
    std::string params_json = json_array_slice(request, "params");
    if (params_json.empty()) params_json = "[]";

    const std::string payload =
        std::string("{\"sql\":\"") + json_escape(sql) + "\",\"params\":" + params_json + "}";
    const std::vector<uint8_t> env = hostcall("storage.flatsql_query_stream", payload);
    const std::string meta = envelope_meta_json(env);
    if (!meta_ok(meta)) {
        return fail_from_meta("flatsql-query-stream-failed", meta,
                              "storage.flatsql_query_stream hostcall failed.");
    }

    const uint8_t* seg = nullptr;
    uint32_t seg_len = 0;
    envelope_first_segment(env, &seg, &seg_len);  // Zero rows -> empty stream.
    const int32_t pushed = plugin_push_output_ex(
        "stream", nullptr, nullptr,
        PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr,
        0, 8, seg, seg_len);
    return pushed < 0 ? 500 : 0;
}


// sandbox_query: routing decision in -> response decision (+ body / etag /
// stream) out. See the file header for the contract.
int sandbox_query(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

    // NO FRAME-0 FALLBACK. This used to fall back to `plugin_get_input_frame(0)`
    // when the `decision` port could not be found, and frame 0 is NOT promised
    // to be on any particular port — the fallback could parse a routing
    // decision out of a frame that belonged to some other port and answer a
    // query nobody asked for. An absent `decision` port is an error, not an
    // invitation to guess (graph task modules-guest-nodes-drop-batched-frames).
    const int32_t decision_index = plugin_find_input_index("decision", 0);
    const plugin_input_frame_t* frame =
        decision_index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(decision_index))
                            : nullptr;
    if (!frame || !frame->payload || frame->payload_length == 0) {
        plugin_set_error("missing-decision-frame",
                         "sandbox_query requires a routing-decision JSON frame on port \"decision\".");
        return 400;
    }
    const std::string decision(reinterpret_cast<const char*>(frame->payload),
                               frame->payload_length);

    std::string route;
    json_string_field_anchored(decision, "route", &route);
    std::string format = "flatbuffer";
    {
        std::string f;
        if (json_string_field_anchored(decision, "format", &f) && f == "json") format = "json";
    }
    std::string if_none_match;
    const bool has_if_none_match =
        json_string_field_anchored(decision, "ifNoneMatch", &if_none_match);

    const auto push_decision_out = [&](const std::string& out) {
        const int32_t pushed = plugin_push_output_ex(
            "decision", nullptr, nullptr,
            PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr,
            0, 1,
            reinterpret_cast<const uint8_t*>(out.data()), static_cast<uint32_t>(out.size()));
        return pushed < 0 ? 500 : 0;
    };
    const auto push_bytes = [&](const char* port, const uint8_t* data, uint32_t length,
                                uint32_t alignment) {
        const int32_t pushed = plugin_push_output_ex(
            port, nullptr, nullptr,
            PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr,
            0, alignment, data, length);
        return pushed < 0;
    };
    const auto error_decision = [&](long status, const std::string& message,
                                    const std::string& code) {
        std::string out = "{\"route\":\"error\",\"status\":";
        char buf[16];
        std::snprintf(buf, sizeof(buf), "%ld", status);
        out += buf;
        out += ",\"format\":\"" + format + "\"";
        if (has_if_none_match) out += ",\"ifNoneMatch\":\"" + json_escape(if_none_match) + "\"";
        out += ",\"error\":\"" + json_escape(message) + "\"";
        if (!code.empty()) out += ",\"code\":\"" + json_escape(code) + "\"";
        out += "}";
        return push_decision_out(out);
    };

    // Pass-through routes: http-respond owns not_found (404) and error
    // decisions; nothing to execute.
    if (route != "public_query" && route != "query_surface") {
        return push_decision_out(decision);
    }

    if (route == "query_surface") {
        const std::vector<uint8_t> env = hostcall("storage.query_surface", "{}");
        const std::string meta = envelope_meta_json(env);
        if (!meta_ok(meta)) {
            std::string message;
            json_string_field_anchored(meta, "message", &message);
            return error_decision(502,
                                  message.empty() ? "query surface unavailable" : message,
                                  "");
        }
        const std::string result = json_object_slice(meta, "result");
        if (result.empty()) {
            return error_decision(502, "query surface envelope missing result", "");
        }
        const std::string etag =
            fnv1a64_etag(reinterpret_cast<const uint8_t*>(result.data()),
                         static_cast<uint32_t>(result.size()));
        if (push_bytes("etag", reinterpret_cast<const uint8_t*>(etag.data()),
                       static_cast<uint32_t>(etag.size()), 1)) {
            return 500;
        }
        if (push_bytes("body", reinterpret_cast<const uint8_t*>(result.data()),
                       static_cast<uint32_t>(result.size()), 1)) {
            return 500;
        }
        return push_decision_out(decision);
    }

    // ---- public_query ----
    std::string sql;
    json_string_field_anchored(decision, "sql", &sql);
    std::string params_json = json_array_slice(decision, "params");
    if (params_json.empty()) params_json = "[]";
    std::string profile;
    json_string_field_anchored(decision, "profile", &profile);
    std::string sort;
    json_string_field_anchored(decision, "sort", &sort);
    std::string source;
    json_string_field_anchored(decision, "source", &source);
    double limit_num = 0.0;
    const bool has_limit = json_number_field(decision, "limit", &limit_num) && limit_num > 0;
    double epoch = 0.0;
    bool has_epoch = json_number_field(decision, "epoch", &epoch);

    std::string effective_sql;
    std::string effective_params = params_json;

    if (!profile.empty()) {
        // Named epoch profile over the unified OMM view (sort is profile-
        // owned; a raw "sql" alongside a profile is rejected as ambiguous).
        const char* profile_sql = pq_epoch_profile_sql(profile);
        if (!profile_sql) {
            return error_decision(400, "unknown profile: " + profile +
                                           " (nearest | as_of | forward)",
                                  "invalid-profile");
        }
        if (!sql.empty()) {
            return error_decision(400, "request carries both sql and profile — send one",
                                  "ambiguous-query");
        }
        if (!has_epoch) {
            // Default epoch = now (host clock; base hostcall, no capability).
            const std::vector<uint8_t> env = hostcall("clock.now", "{}");
            const std::string meta = envelope_meta_json(env);
            double now_ms = 0.0;
            if (!meta_ok(meta) || !json_number_field(meta, "result", &now_ms)) {
                return error_decision(502, "clock unavailable for default epoch", "");
            }
            epoch = now_ms / 1000.0;
        }
        long limit = has_limit ? static_cast<long>(limit_num) : kPQDefaultProfileLimit;
        char limit_buf[32];
        std::snprintf(limit_buf, sizeof(limit_buf), "%ld", limit);
        char epoch_buf[64];
        std::snprintf(epoch_buf, sizeof(epoch_buf), "%.6f", epoch);
        effective_sql = profile_sql;
        // ?1 is the source SHADOW-TABLE name — the unified view's _source
        // column carries "OMM@<source>", not the bare source string
        // (mirrors data-source/retrieval).
        const std::string source_shadow = source.empty() ? std::string() : ("OMM@" + source);
        effective_params = std::string("[{\"t\":\"str\",\"v\":\"") + json_escape(source_shadow) +
                           "\"},{\"t\":\"f64\",\"v\":" + epoch_buf +
                           "},{\"t\":\"i64\",\"v\":" + limit_buf + "}]";
    } else {
        if (sql.empty()) {
            return error_decision(400, "public query requires sql or profile", "missing-sql");
        }
        effective_sql = sql;
        const bool wrap = !sort.empty() || has_limit;
        if (wrap) {
            effective_sql = "SELECT * FROM (" + effective_sql + ")";
            if (!sort.empty()) {
                std::string order_by;
                if (!pq_build_order_by(sort, &order_by)) {
                    return error_decision(400,
                                          "invalid sort: expected \"COLUMN [ASC|DESC]\" "
                                          "(column chars A-Za-z0-9_@)",
                                          "invalid-sort");
                }
                effective_sql += order_by;
            }
            if (has_limit) {
                char buf[32];
                std::snprintf(buf, sizeof(buf), "%ld", static_cast<long>(limit_num));
                effective_sql += " LIMIT ";
                effective_sql += buf;
            }
        }
    }

    // format=flatbuffer -> strict stream, host body-reference delivery.
    // format=json -> auto: stream first (full-record queries feed the
    // omm-json presentation), rows fallback (engine-assembled bare-array
    // JSON with schema-exact column keys).
    const bool want_json = format == "json";
    std::string payload = "{\"sql\":\"" + json_escape(effective_sql) +
                          "\",\"params\":" + effective_params +
                          ",\"want\":\"" + (want_json ? "auto" : "stream") + "\"";
    if (!want_json) payload += ",\"deliver\":\"ref\"";
    payload += "}";

    const std::vector<uint8_t> env = hostcall("storage.query_sandboxed", payload);
    const std::string meta = envelope_meta_json(env);
    if (!meta_ok(meta)) {
        const std::string error_obj = json_object_slice(meta, "error");
        std::string message;
        json_string_field_anchored(error_obj.empty() ? meta : error_obj, "message", &message);
        std::string code;
        json_string_field_anchored(error_obj.empty() ? meta : error_obj, "sandbox", &code);
        if (message.empty()) message = "sandboxed query failed";
        long status = pq_error_status(code, message);
        if (status == 406) {
            message += " — request format=json for projection results";
        }
        return error_decision(status, message, code);
    }

    const std::string result = json_object_slice(meta, "result");
    std::string kind;
    json_string_field_anchored(result, "kind", &kind);

    // Body-reference delivery (fb path): forward the descriptor; the etag
    // comes precomputed from the host materialization.
    const std::string ref = json_object_slice(result, "ref");
    if (!ref.empty() && ref[0] == '{') {
        std::string fnv_hex;
        json_string_field_anchored(ref, "fnv1a64", &fnv_hex);
        if (!fnv_hex.empty()) {
            const std::string etag = "W/\"fnv1a64-" + fnv_hex + "\"";
            if (push_bytes("etag", reinterpret_cast<const uint8_t*>(etag.data()),
                           static_cast<uint32_t>(etag.size()), 1)) {
                return 500;
            }
        }
        const std::string descriptor = "{\"$sdnbodyref\":1," + ref.substr(1);
        if (push_bytes("body", reinterpret_cast<const uint8_t*>(descriptor.data()),
                       static_cast<uint32_t>(descriptor.size()), 1)) {
            return 500;
        }
        return push_decision_out(decision);
    }

    const uint8_t* seg = nullptr;
    uint32_t seg_len = 0;
    envelope_first_segment(env, &seg, &seg_len);  // zero rows -> empty payload

    const std::string etag = fnv1a64_etag(seg, seg_len);
    if (push_bytes("etag", reinterpret_cast<const uint8_t*>(etag.data()),
                   static_cast<uint32_t>(etag.size()), 1)) {
        return 500;
    }

    if (kind == "rows") {
        // Engine-assembled bare-array JSON (projection results). A
        // flatbuffer request never reaches here (want=stream errors first).
        if (push_bytes("body", seg, seg_len, 1)) return 500;
        return push_decision_out(decision);
    }

    if (want_json) {
        // Full-record stream on the json path: route the raw $OMM frames
        // through foundation/omm-json (bare-array presentation, schema-exact
        // keys). The etag above is over the RAW stream — shared by both
        // encodings of the same logical result.
        const int32_t pushed = plugin_push_output_ex(
            "stream", "OMM.fbs", "$OMM",
            PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, "OMM",
            0, 8, seg, seg_len);
        if (pushed < 0) return 500;
        return push_decision_out(decision);
    }

    // fb byte delivery (host without a bridge): body verbatim.
    const int32_t pushed = plugin_push_output_ex(
        "omm_body", "OMM.fbs", "$OMM",
        PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, "OMM",
        0, 8, seg, seg_len);
    if (pushed < 0) return 500;
    return push_decision_out(decision);
}

}  // extern "C"
