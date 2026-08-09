/*
 * foundation/decision-gate (loop C.3c).
 *
 * Two single-purpose gate nodes for the routing-decision JSON contract
 * (foundation/http-route). They exist so flow-level branching stays
 * DECLARATIVE: the flow graph wires static edges from route/format-specific
 * output ports; the gate decides which port fires. Pure compute — no
 * capabilities, no hostcalls.
 *
 *   dispatch — one decision frame in, route-specific frames out:
 *     route=omm_bulk   -> $CAQ (CAQRequest.QUERY = decision.query JSON) on
 *                         "omm_bulk" + decision passthrough on "routed"
 *     route=data_query -> $CAQ (CAQRequest.QUERY = {"sql","params"} JSON) on
 *                         "data_query" + decision passthrough on "routed"
 *     otherwise        -> decision passthrough on "not_found"
 *
 *   branch — joins decision + retrieval stream:
 *     decision.format=json -> stream verbatim on "json"
 *     otherwise            -> stream verbatim on "flatbuffer"
 *     plus (always): decision passthrough on "decision" and a deterministic
 *     FNV-1a 64-bit entity tag over the stream bytes on "etag"
 *     (W/"fnv1a64-<16 hex>"), matching http-respond's verbatim
 *     etag/If-None-Match comparison.
 *
 * The SDS CAQ generated C++ header (and its ETM include) is prepended by
 * build.mjs; this file contains only the method bodies.
 */

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>

#include "space_data_module_invoke.h"

namespace {

// ---------------------------------------------------------------------------
// Minimal JSON field extraction (control metadata only), mirroring the
// data-source/retrieval helpers so both ends of the contract parse alike.
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

std::string json_block_slice(const std::string& json, const std::string& key,
                             char open, char close) {
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return std::string();
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return std::string();
    size_t i = colon + 1;
    while (i < json.size() && is_json_ws(json[i])) i++;
    if (i >= json.size() || json[i] != open) return std::string();
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
        else if (c == open) depth++;
        else if (c == close) {
            depth--;
            if (depth == 0) return json.substr(start, i - start + 1);
        }
    }
    return std::string();
}

std::string json_object_slice(const std::string& json, const std::string& key) {
    return json_block_slice(json, key, '{', '}');
}

std::string json_array_slice(const std::string& json, const std::string& key) {
    return json_block_slice(json, key, '[', ']');
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

// ---------------------------------------------------------------------------
// Frame helpers
// ---------------------------------------------------------------------------

const plugin_input_frame_t* find_frame(const char* port_id) {
    const int32_t index = plugin_find_input_index(port_id, 0);
    return index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(index)) : nullptr;
}

std::string frame_text(const plugin_input_frame_t* frame) {
    if (!frame || !frame->payload || frame->payload_length == 0) return std::string();
    return std::string(reinterpret_cast<const char*>(frame->payload), frame->payload_length);
}

int push_json(const char* port, const std::string& json) {
    return plugin_push_output_ex(
        port, nullptr, nullptr,
        PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr,
        0, 1,
        reinterpret_cast<const uint8_t*>(json.data()),
        static_cast<uint32_t>(json.size()));
}

// Build a $CAQ envelope whose CAQRequest.QUERY carries the given JSON/SQL
// document verbatim (the data-source/retrieval request contract).
int push_caq(const char* port, const std::string& query) {
    ::flatbuffers::FlatBufferBuilder builder(512);
    const auto query_offset = query.empty() ? 0 : builder.CreateString(query);
    CAQRequestBuilder request_builder(builder);
    if (!query.empty()) {
        request_builder.add_QUERY(query_offset);
    }
    const auto request = request_builder.Finish();
    FinishCAQBuffer(builder, CreateCAQ(builder, request));
    return plugin_push_output_ex(
        port, "CAQ.fbs", "$CAQ",
        PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "CAQ",
        0, 0,
        builder.GetBufferPointer(), builder.GetSize());
}

// Deterministic FNV-1a 64-bit entity tag over the stream bytes, folded in
// 8-byte little-endian words (tail bytes folded individually). The tag is an
// OPAQUE validator: http-respond compares If-None-Match verbatim, nothing
// recomputes it elsewhere — word folding keeps it deterministic and
// content-sensitive while doing 1/8th the loop iterations of byte-at-a-time
// FNV, which dominated per-request time on interpreted hosts (loop C.5).
// The SAME algorithm produces the "fnv1a64" field of body-reference
// descriptors (computed host-side over the identical stream bytes, loop
// C.5c), so reference-mode etags are byte-identical to hashed-stream etags.
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

// Body-reference descriptor frames (loop C.5c): the retrieval node emits a
// small JSON descriptor {"$sdnbodyref":1,"token":..,"size":..,"frames":..,
// "fnv1a64":"<16 hex>"} instead of the stream bytes when the host answered a
// storage query in "deliver":"ref" mode. Detection is by the exact prefix —
// a real aligned FlatBuffer stream starts with a u32le size prefix, never
// with this JSON.
constexpr const char* kBodyRefPrefix = "{\"$sdnbodyref\"";

bool is_body_ref_frame(const uint8_t* data, uint32_t length) {
    const size_t prefix_len = std::strlen(kBodyRefPrefix);
    return length >= prefix_len && std::memcmp(data, kBodyRefPrefix, prefix_len) == 0;
}

// Inject "deliver":"ref" into a JSON object document (possibly empty),
// preserving all other keys.
std::string with_deliver_ref(const std::string& query_object) {
    if (query_object.empty() || query_object == "{}") {
        return "{\"deliver\":\"ref\"}";
    }
    if (query_object[0] != '{') return query_object;
    return "{\"deliver\":\"ref\"," + query_object.substr(1);
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
// `dispatch` takes ONE decision and routes it to ONE branch; `branch` pairs
// ONE decision with ONE stream and must not mix. data-retrieval wires TWO
// edges into branch's `stream` port (omm.stream + query.rows) and TWO into
// respond's `decision`, relying on gate having dispatched to exactly one of
// them. It has — that exclusivity is real in `dispatch` — but this node used
// to depend on it silently, and a decision paired with the wrong branch's
// stream is a wrong answer no consumer can detect.
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

// dispatch: decision in -> route-specific typed frames out.
int dispatch(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

    const plugin_input_frame_t* frame = find_frame("decision");
    if (!frame || !frame->payload || frame->payload_length == 0) {
        plugin_set_error("missing-decision-frame", "dispatch requires a decision JSON frame.");
        return 400;
    }
    const std::string decision = frame_text(frame);
    std::string route;
    json_string_field(decision, "route", &route);

    // Reference-delivery election (loop C.5c): on the flatbuffer path the
    // retrieval stream passes through to the response body VERBATIM, so the
    // host may deliver it as an out-of-band body reference (zero copies
    // through the flow). The json path needs the actual bytes in-flow for
    // omm-json field extraction, so it stays on byte delivery.
    std::string format;
    json_string_field(decision, "format", &format);
    const bool deliver_ref = format != "json";

    if (route == "omm_bulk") {
        // decision.query is the retrieval override object; absent keys defer
        // to the retrieval module's config/compiled defaults.
        std::string query = json_object_slice(decision, "query");
        if (deliver_ref) query = with_deliver_ref(query);
        if (push_caq("omm_bulk", query) < 0) {
            plugin_set_error("push-failed", "failed to push the omm_bulk $CAQ frame.");
            return 500;
        }
        if (push_json("routed", decision) < 0) {
            plugin_set_error("push-failed", "failed to push the routed decision frame.");
            return 500;
        }
        return 0;
    }

    if (route == "data_query") {
        std::string sql;
        json_string_field(decision, "sql", &sql);
        if (sql.empty()) {
            // http-route degrades SQL-less /query requests to not_found; a
            // data_query decision without SQL is treated the same way.
            if (push_json("not_found", decision) < 0) {
                plugin_set_error("push-failed", "failed to push the not_found decision frame.");
                return 500;
            }
            return 0;
        }
        std::string params = json_array_slice(decision, "params");
        if (params.empty()) params = "[]";
        std::string query =
            std::string("{\"sql\":\"") + json_escape(sql) + "\",\"params\":" + params + "}";
        if (deliver_ref) query = with_deliver_ref(query);
        if (push_caq("data_query", query) < 0) {
            plugin_set_error("push-failed", "failed to push the data_query $CAQ frame.");
            return 500;
        }
        if (push_json("routed", decision) < 0) {
            plugin_set_error("push-failed", "failed to push the routed decision frame.");
            return 500;
        }
        return 0;
    }

    if (push_json("not_found", decision) < 0) {
        plugin_set_error("push-failed", "failed to push the not_found decision frame.");
        return 500;
    }
    return 0;
}

// branch: decision + stream in -> format-specific stream + decision + etag out.
int branch(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

    const plugin_input_frame_t* decision_frame = find_frame("decision");
    if (!decision_frame || !decision_frame->payload || decision_frame->payload_length == 0) {
        plugin_set_error("missing-decision-frame", "branch requires a decision JSON frame.");
        return 400;
    }
    const plugin_input_frame_t* stream_frame = find_frame("stream");
    if (!stream_frame) {
        plugin_set_error("missing-stream-frame", "branch requires a stream frame.");
        return 400;
    }
    const std::string decision = frame_text(decision_frame);
    std::string format;
    json_string_field(decision, "format", &format);
    const bool as_json = format == "json";

    const uint8_t* stream = stream_frame->payload;
    const uint32_t stream_length = stream_frame->payload_length;
    const int pushed = plugin_push_output_ex(
        as_json ? "json" : "flatbuffer",
        "OMM.fbs",
        "$OMM",
        PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,
        "OMM",
        0, 8, stream, stream_length);
    if (pushed < 0) {
        plugin_set_error("push-failed", "failed to push the branched stream frame.");
        return 500;
    }
    if (push_json("decision", decision) < 0) {
        plugin_set_error("push-failed", "failed to push the decision passthrough frame.");
        return 500;
    }
    // Entity tag: for byte streams, hash the bytes; for body-reference
    // descriptors (loop C.5c), the host already computed the SAME word-folded
    // FNV-1a 64 over the referenced stream bytes — format its "fnv1a64" hex
    // field into the identical validator string.
    std::string etag;
    if (is_body_ref_frame(stream, stream_length)) {
        const std::string descriptor(reinterpret_cast<const char*>(stream), stream_length);
        std::string hash_hex;
        if (!json_string_field(descriptor, "fnv1a64", &hash_hex) || hash_hex.empty()) {
            plugin_set_error("invalid-body-ref",
                             "body-reference descriptor is missing the fnv1a64 field.");
            return 502;
        }
        etag = "W/\"fnv1a64-" + hash_hex + "\"";
    } else {
        etag = fnv1a64_etag(stream, stream_length);
    }
    if (push_json("etag", etag) < 0) {
        plugin_set_error("push-failed", "failed to push the etag frame.");
        return 500;
    }
    return 0;
}

}  // extern "C"
