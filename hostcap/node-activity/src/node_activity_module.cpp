/*
 * hostcap/node-activity (M2 node-activity flow, cycle B).
 *
 * Capability node for the host read-only node_activity_read hostcall. One
 * method:
 *
 *   activity — routing-decision JSON in (foundation/http-route
 *              route_node_activity contract: route="activity" | "error")
 *              -> when route=="activity", forwards {"limit":N} (N is the
 *              decision's already-clamped "limit" integer field, defensively
 *              re-clamped here to [1, 256] with a default of 50 — mirrors
 *              hostcap/p2p-discovery's pnm_history limit-forwarding
 *              precedent: the route node owns the clamp, this node never
 *              trusts it blindly) to the node_activity_read.activity
 *              hostcall (the capability name IS the op prefix — the host's
 *              capPrefixFromName has no mapping for node_activity_read,
 *              same as node_status_read) and emits the hostcall's "result"
 *              object VERBATIM as UTF-8 JSON bytes on "body"; "decision" is
 *              re-emitted unchanged (linear flow chaining into
 *              foundation/http-respond). A route this method does not own
 *              (already rewritten to "error" by the route node, e.g. 405 for
 *              non-GET) short-circuits: NO hostcall, the decision passes
 *              through untouched and no body frame is pushed —
 *              foundation/http-respond owns that response.
 *
 *              A node_activity_read.activity hostcall FAILURE (or a missing /
 *              non-object "result" field) rewrites the decision to
 *              route="error" status=503 with the host's error message (or an
 *              honest fallback) — never a silent empty body.
 *
 * Response shape (no FlatBuffers): there is no SDS schema for node activity
 * events (checked spacedatastandards.org/schema — no matching record type);
 * a hand-written FlatBuffers table would violate the generated-types-only
 * rule, so v1 ships JSON-ONLY (fb blocked-on-schema). The response body is a
 * JSON OBJECT ({count, events}) — an activity-log snapshot, not a bare
 * record collection, so the bare-array JSON convention used by the other
 * gateway flows does not apply here (mirrors hostcap/node-status).
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

// Colon-anchored integer field lookup (same lesson as json_string_field).
bool json_int_field(const std::string& json, const std::string& key, long* out) {
    const std::string needle = "\"" + key + "\":";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return false;
    size_t i = k + needle.size();
    while (i < json.size() && is_json_ws(json[i])) i++;
    bool negative = false;
    if (i < json.size() && json[i] == '-') { negative = true; i++; }
    if (i >= json.size() || json[i] < '0' || json[i] > '9') return false;
    long value = 0;
    while (i < json.size() && json[i] >= '0' && json[i] <= '9') {
        value = value * 10 + (json[i] - '0');
        i++;
    }
    *out = negative ? -value : value;
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

}  // namespace

extern "C" {

// activity: routing decision -> node_activity_read.activity (route==
// "activity" only) -> decision passthrough + the hostcall result object
// verbatim on "body". The decision's "limit" integer field (already parsed
// and clamped to [1, 256] by foundation/http-route route_node_activity,
// default 50) is forwarded as {"limit":N}; defensively re-clamped to
// [1, 256] here (default 50 when absent/invalid) — this node never trusts
// the route's clamp blindly (mirrors hostcap/p2p-discovery pnm_history).
int activity(void) {
    const int32_t decision_index = plugin_find_input_index("decision", 0);
    const plugin_input_frame_t* frame =
        decision_index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(decision_index))
                            : nullptr;
    if (!frame || !frame->payload || frame->payload_length == 0) {
        plugin_set_error("missing-decision-frame",
                         "node-activity activity requires a routing-decision JSON frame on port \"decision\".");
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
    if (route != "activity") {
        return push_decision(decision);
    }

    long limit = 50;
    if (!json_int_field(decision, "limit", &limit)) limit = 50;
    if (limit < 1) limit = 1;
    if (limit > 256) limit = 256;
    char limit_buf[32];
    std::snprintf(limit_buf, sizeof(limit_buf), "%ld", limit);
    std::string payload = "{\"limit\":";
    payload += limit_buf;
    payload += "}";

    const std::vector<uint8_t> env = hostcall("node_activity_read.activity", payload);
    const std::string meta = envelope_meta_json(env);
    if (meta.empty() || !meta_ok(meta)) {
        std::string message;
        json_string_field(meta, "message", &message);
        if (message.empty()) message = "node activity hostcall failed.";
        const std::string out = "{\"route\":\"error\",\"status\":503,\"format\":\"json\",\"error\":\"" +
                                json_escape(message) + "\"}";
        return push_decision(out);
    }

    const std::string result = json_object_slice(meta, "result");
    if (result.empty()) {
        const std::string out =
            "{\"route\":\"error\",\"status\":503,\"format\":\"json\","
            "\"error\":\"node activity hostcall returned no result object.\"}";
        return push_decision(out);
    }

    if (push_body(reinterpret_cast<const uint8_t*>(result.data()),
                 static_cast<uint32_t>(result.size())) != 0) {
        plugin_set_error("push-failed", "failed to push the node activity body frame.");
        return 500;
    }
    return push_decision(decision);
}

}  // extern "C"
