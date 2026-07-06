/*
 * hostcap/p2p-discovery (gateway loops G.2 + G.3).
 *
 * Capability node for the host p2p_read discovery hostcalls. Three methods,
 * one hostcall each:
 *
 *   peers       — "request" decision JSON -> p2p.peers_snapshot
 *                 (optional {"peer_id"} narrows to one peer)
 *   standards   — "request" decision JSON -> p2p.standards_snapshot
 *   pnm_history — "request" decision JSON -> p2p.pnm_history
 *                 ({"peer_id","limit"}: the peer's stored signed $PNM
 *                 publications, publisher-attributed by SIGNATURE on the
 *                 host, newest first, limit already clamped by the route
 *                 node)
 *
 * Both methods emit:
 *   "decision" — the incoming decision frame re-emitted VERBATIM (linear
 *                flow chaining: route -> this node -> discovery-shape).
 *   "snapshot" — the RAW hostcall response envelope
 *                ([u32le metaLen][meta JSON][u32le segCount]([u32le
 *                segLen][bytes])*) — meta {"ok":..,"result":..}, segment 0 =
 *                the aligned size-prefixed $EPM/$PNM stream referenced as
 *                {"$bin":0} inside the result. The downstream shape node
 *                parses the envelope; nothing is re-encoded here.
 *
 * A decision with route=not_found short-circuits: NO hostcall happens and an
 * empty-result envelope ({"ok":true,"result":{}}, zero segments) is emitted
 * so the graph still completes and http-respond can answer 404.
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

int push_bytes(const char* port_id, const uint8_t* data, uint32_t length) {
    const int32_t pushed = plugin_push_output_ex(
        port_id, nullptr, nullptr,
        PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr,
        0, 1, data, length);
    return pushed < 0 ? 500 : 0;
}

// Empty-result envelope for short-circuited (not_found) requests.
std::vector<uint8_t> empty_envelope() {
    static const char kMeta[] = "{\"ok\":true,\"result\":{}}";
    const uint32_t meta_len = static_cast<uint32_t>(sizeof(kMeta) - 1);
    std::vector<uint8_t> env(4 + meta_len + 4, 0);
    write_u32le(env.data(), meta_len);
    std::memcpy(env.data() + 4, kMeta, meta_len);
    write_u32le(env.data() + 4 + meta_len, 0u);
    return env;
}

bool json_int_field(const std::string& json, const std::string& key, long* out) {
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return false;
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return false;
    size_t i = colon + 1;
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

// run_snapshot dispatches one hostcall for the routes the method OWNS.
// A decision whose route is not_found — or one this method does not serve
// (the discover router also emits routes for sibling flows; each flow's
// shape node 404s them) — short-circuits: NO hostcall, empty envelope.
int run_snapshot(const char* op, const char* route_a, const char* route_b,
                 bool include_limit = false) {
    const int32_t input_index = plugin_find_input_index("request", 0);
    const plugin_input_frame_t* frame =
        input_index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(input_index)) : nullptr;
    if (!frame || !frame->payload || frame->payload_length == 0) {
        plugin_set_error("missing-request-frame",
                         "p2p-discovery requires a decision JSON frame on port \"request\".");
        return 400;
    }
    const std::string decision(reinterpret_cast<const char*>(frame->payload),
                               frame->payload_length);

    // Decision passthrough first: the shape node joins it with the snapshot.
    if (push_bytes("decision", frame->payload, frame->payload_length) != 0) {
        plugin_set_error("push-failed", "failed to push the decision passthrough frame.");
        return 500;
    }

    std::string route;
    json_string_field(decision, "route", &route);
    const bool owned = (route_a && route == route_a) || (route_b && route == route_b);
    if (route == "not_found" || !owned) {
        const std::vector<uint8_t> env = empty_envelope();
        if (push_bytes("snapshot", env.data(), static_cast<uint32_t>(env.size())) != 0) {
            plugin_set_error("push-failed", "failed to push the empty snapshot envelope.");
            return 500;
        }
        return 0;
    }

    std::string payload = "{";
    std::string peer_id;
    bool first = true;
    if (json_string_field(decision, "peerId", &peer_id) && !peer_id.empty()) {
        payload += "\"peer_id\":\"" + json_escape(peer_id) + "\"";
        first = false;
    }
    if (include_limit) {
        // The route node clamps ?limit to [1, 100] (wasm owns the clamp);
        // forward the clamped value, defaulting to 1 = newest publication.
        long limit = 1;
        json_int_field(decision, "limit", &limit);
        if (limit < 1) limit = 1;
        char limit_buf[32];
        std::snprintf(limit_buf, sizeof(limit_buf), "%ld", limit);
        if (!first) payload += ",";
        payload += "\"limit\":";
        payload += limit_buf;
    }
    payload += "}";

    const std::vector<uint8_t> env = hostcall(op, payload);
    const std::string meta = envelope_meta_json(env);
    if (meta.empty() || !meta_ok(meta)) {
        std::string message;
        if (!json_string_field(meta, "message", &message) || message.empty()) {
            message = std::string(op) + " hostcall failed.";
        }
        plugin_set_error("hostcall-failed", message.c_str());
        return 502;
    }
    if (push_bytes("snapshot", env.data(), static_cast<uint32_t>(env.size())) != 0) {
        plugin_set_error("push-failed", "failed to push the snapshot envelope frame.");
        return 500;
    }
    return 0;
}

}  // namespace

extern "C" {

// peers: decision JSON -> p2p.peers_snapshot -> raw response envelope.
int peers_snapshot(void) {
    return run_snapshot("p2p.peers_snapshot", "peers_list", "peer_get");
}

// standards: decision JSON -> p2p.standards_snapshot -> raw response envelope.
int standards_snapshot(void) {
    return run_snapshot("p2p.standards_snapshot", "standards", nullptr);
}

// pnm_history: decision JSON ({"peerId","limit"}) -> p2p.pnm_history ->
// raw response envelope (the peer's stored signed $PNM publications,
// publisher-attributed by signature on the host, newest first).
int pnm_history(void) {
    return run_snapshot("p2p.pnm_history", "pnm_history", nullptr,
                        /*include_limit=*/true);
}

}  // extern "C"
