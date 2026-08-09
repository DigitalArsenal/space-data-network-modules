/*
 * hostcap/node-status (M1 node-status flow, cycle B).
 *
 * Capability node for the host read-only node_status_read hostcall. One
 * method:
 *
 *   status — routing-decision JSON in (foundation/http-route
 *            route_node_status contract: route="status" | "error") ->
 *            when route=="status", forwards an EMPTY payload ({}) to the
 *            node_status_read.status hostcall (the capability name IS the
 *            op prefix — the host's capPrefixFromName has no mapping for
 *            node_status_read) and emits the hostcall's "result" object
 *            VERBATIM as UTF-8 JSON bytes on "body"; "decision" is
 *            re-emitted unchanged (linear flow chaining into
 *            foundation/http-respond). A route this method does not own
 *            (already rewritten to "error" by the route node, e.g. 405 for
 *            non-GET) short-circuits: NO hostcall, the decision passes
 *            through untouched and no body frame is pushed —
 *            foundation/http-respond owns that response.
 *
 *            A node_status_read.status hostcall FAILURE (or a missing /
 *            non-object "result" field) rewrites the decision to
 *            route="error" status=503 with the host's error message (or an
 *            honest fallback) — never a silent empty body.
 *
 * Response shape (no FlatBuffers): there is no SDS schema for node status
 * (checked spacedatastandards.org/schema — no STA/HLT/NOD/SVC-style match);
 * a hand-written FlatBuffers table would violate the generated-types-only
 * rule, so v1 ships JSON-ONLY. The response body is a JSON OBJECT
 * (uptime_seconds, started_at, store, disk, service, bandwidth) — a live
 * status snapshot, not a record collection, so the bare-array JSON
 * convention used by the other gateway flows does not apply here.
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
    size_t off = 0;
    write_u32le(req.data() + off, static_cast<uint32_t>(payload_json.size()));
    off += 4;
    std::memcpy(req.data() + off, payload_json.data(), payload_json.size());
    off += payload_json.size();
    write_u32le(req.data() + off, 0u);
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

bool meta_ok(const std::string& meta) {
    return meta.find("\"ok\":true") != std::string::npos;
}

bool is_json_ws(char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

// Colon-anchored key lookup (the G.3 key-vs-value lesson): a bare "key"
// needle can match a string VALUE, e.g. {"route":"error"} would make an
// "error" key lookup land on the route value.
bool json_string_field(const std::string& json, const std::string& key, std::string* out) {
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

std::string json_escape(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (const char c : s) {
        if (c == '"' || c == '\\') { out.push_back('\\'); out.push_back(c); }
        else if (c == '\n') out += "\\n";
        else if (c == '\r') out += "\\r";
        else if (c == '\t') out += "\\t";
        else if (static_cast<unsigned char>(c) < 0x20) {
            char buf[8];
            std::snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned char>(c));
            out += buf;
        } else out.push_back(c);
    }
    return out;
}

// Slice "key":{...} out of an object (brace-depth scan, string-aware).
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

int push_decision(const std::string& decision) {
    const int32_t pushed = plugin_push_output_ex(
        "decision", nullptr, nullptr,
        PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr,
        0, 1,
        reinterpret_cast<const uint8_t*>(decision.data()),
        static_cast<uint32_t>(decision.size()));
    return pushed < 0 ? 500 : 0;
}

int push_body(const uint8_t* data, uint32_t length) {
    const int32_t pushed = plugin_push_output_ex(
        "body", nullptr, nullptr,
        PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr,
        0, 1, data, length);
    return pushed < 0 ? 500 : 0;
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
// One routing decision in, one live status snapshot out. Two decisions in an
// invocation would answer one HTTP exchange and destroy the other.
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

// status: routing decision -> node_status_read.status (route=="status"
// only) -> decision passthrough + the hostcall result object verbatim on
// "body".
int status(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

    const int32_t decision_index = plugin_find_input_index("decision", 0);
    const plugin_input_frame_t* frame =
        decision_index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(decision_index))
                            : nullptr;
    if (!frame || !frame->payload || frame->payload_length == 0) {
        plugin_set_error("missing-decision-frame",
                         "node-status status requires a routing-decision JSON frame on port \"decision\".");
        return 400;
    }
    const std::string decision(reinterpret_cast<const char*>(frame->payload),
                               frame->payload_length);

    std::string route;
    json_string_field(decision, "route", &route);

    // Routes this method does not own (already an error/not_found decision
    // from the route node, e.g. 405 for non-GET) short-circuit: NO
    // hostcall, decision forwarded unchanged, no body — http-respond owns
    // the response.
    if (route != "status") {
        return push_decision(decision);
    }

    const std::vector<uint8_t> env = hostcall("node_status_read.status", "{}");
    const std::string meta = envelope_meta_json(env);
    if (meta.empty() || !meta_ok(meta)) {
        std::string message;
        json_string_field(meta, "message", &message);
        if (message.empty()) message = "node status hostcall failed.";
        const std::string out = "{\"route\":\"error\",\"status\":503,\"format\":\"json\",\"error\":\"" +
                                json_escape(message) + "\"}";
        return push_decision(out);
    }

    const std::string result = json_object_slice(meta, "result");
    if (result.empty()) {
        const std::string out =
            "{\"route\":\"error\",\"status\":503,\"format\":\"json\","
            "\"error\":\"node status hostcall returned no result object.\"}";
        return push_decision(out);
    }

    if (push_body(reinterpret_cast<const uint8_t*>(result.data()),
                 static_cast<uint32_t>(result.size())) != 0) {
        plugin_set_error("push-failed", "failed to push the node status body frame.");
        return 500;
    }
    return push_decision(decision);
}

}  // extern "C"
