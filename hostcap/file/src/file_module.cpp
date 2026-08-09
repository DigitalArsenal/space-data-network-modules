/*
 * hostcap/file (loop C.3c2).
 *
 * Capability node for the host filesystem hostcall group:
 *
 *   read_file  — "request" JSON {"path":"..."} -> filesystem.readFile; the
 *                file bytes (hostcall binary segment 0) pass through
 *                VERBATIM to the "content" port.
 *   write_file — "content" raw bytes + "request" JSON {"path":"..."} ->
 *                filesystem.writeFile with the content forwarded as the
 *                hostcall binary segment; emits
 *                {"ok":true,"bytesWritten":N,"path":"..."} on "result".
 *
 * The methodIds are read_file/write_file (not read/write): the SDK invoke
 * glue binds each methodId to an identically named extern "C" symbol, and
 * `read`/`write` collide with the POSIX declarations in the wasi/emscripten
 * sysroot pulled into the generated plugin-invoke-bridge translation unit.
 *
 * Cross-host support (verified against SDK nodeHost.js/browserHost.js and
 * sdn-server internal/modulert): filesystem.readFile/writeFile exist on the
 * SDK NodeHost (sandboxed root) and BrowserHost (requires a configured
 * filesystem adapter). The Go server host has NO filesystem cap handler
 * today; server-side invokes fail with operation-not-supported. Documented,
 * not faked.
 *
 * The write path sends a request envelope with one binary segment referenced
 * from the meta document as {"value":{"$bin":0}}: the SDK JS hosts re-attach
 * it as a Uint8Array (hostcallWire attachBinaryValues) and a future Go
 * filesystem handler receives it base64-attached (hostbridge
 * attachHostcallBinaryRefs).
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
// Hostcall wire envelope helpers. Unlike the read-only nodes, hostcall()
// here supports an optional binary request segment (the write content).
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

std::vector<uint8_t> hostcall(const char* op, const std::string& payload_json,
                              const uint8_t* seg = nullptr, uint32_t seg_len = 0) {
    const bool has_seg = seg != nullptr;
    std::vector<uint8_t> req(4 + payload_json.size() + 4 + (has_seg ? 4 + seg_len : 0), 0);
    size_t off = 0;
    write_u32le(req.data() + off, static_cast<uint32_t>(payload_json.size()));
    off += 4;
    std::memcpy(req.data() + off, payload_json.data(), payload_json.size());
    off += payload_json.size();
    write_u32le(req.data() + off, has_seg ? 1u : 0u);
    off += 4;
    if (has_seg) {
        write_u32le(req.data() + off, seg_len);
        off += 4;
        if (seg_len > 0) std::memcpy(req.data() + off, seg, seg_len);
    }
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

int fail_from_meta(const char* code, const std::string& meta, const char* fallback) {
    std::string message;
    json_string_field(meta, "message", &message);
    plugin_set_error(code, message.empty() ? fallback : message.c_str());
    return 502;
}

// ---------------------------------------------------------------------------
// Frame helpers.
// ---------------------------------------------------------------------------

const plugin_input_frame_t* find_frame(const char* port_id) {
    const int32_t index = plugin_find_input_index(port_id, 0);
    return index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(index)) : nullptr;
}

std::string frame_text(const plugin_input_frame_t* frame) {
    if (!frame || !frame->payload || frame->payload_length == 0) return std::string();
    return std::string(reinterpret_cast<const char*>(frame->payload), frame->payload_length);
}

// Extract the required {"path":...} from the request frame; sets the plugin
// error and returns false when absent.
bool request_path(const char* method, std::string* path_out) {
    const plugin_input_frame_t* frame = find_frame("request");
    const std::string request = frame_text(frame);
    if (request.empty() || !json_string_field(request, "path", path_out) || path_out->empty()) {
        plugin_set_error("missing-path",
                         (std::string(method) +
                          " requires a request JSON frame {\"path\":\"...\"}.")
                             .c_str());
        return false;
    }
    return true;
}

int push_json(const char* port, const std::string& json) {
    return plugin_push_output_ex(
        port, nullptr, nullptr,
        PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr,
        0, 1,
        reinterpret_cast<const uint8_t*>(json.data()),
        static_cast<uint32_t>(json.size()));
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
// `read_file` performs ONE read per request frame and `write_file` pairs ONE
// content frame with ONE request. Silently reading the first path of two, or
// writing the first content to a path that came with different bytes, are both
// unrecoverable and both invisible at the output.
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

// read_file: {"path"} -> filesystem.readFile -> "content" raw bytes verbatim.
int read_file(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

    std::string path;
    if (!request_path("read_file", &path)) return 400;

    const std::vector<uint8_t> env =
        hostcall("filesystem.readFile", std::string("{\"path\":\"") + json_escape(path) + "\"}");
    const std::string meta = envelope_meta_json(env);
    if (!meta_ok(meta)) {
        return fail_from_meta("file-read-failed", meta, "filesystem.readFile hostcall failed.");
    }

    // The JS hosts return the content as a Uint8Array, detached into binary
    // segment 0. Empty files still produce a (zero-length) segment.
    const uint8_t* seg = nullptr;
    uint32_t seg_len = 0;
    if (!envelope_first_segment(env, &seg, &seg_len)) {
        plugin_set_error("file-read-failed",
                         "filesystem.readFile response carried no binary segment.");
        return 502;
    }
    const int32_t pushed = plugin_push_output_ex(
        "content", nullptr, nullptr,
        PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr,
        0, 1, seg, seg_len);
    return pushed < 0 ? 500 : 0;
}

// write_file: "content" bytes + {"path"} -> filesystem.writeFile ->
// {"ok":true,"bytesWritten":N,"path":"..."} on "result".
int write_file(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

    const plugin_input_frame_t* content = find_frame("content");
    if (!content || (!content->payload && content->payload_length > 0)) {
        plugin_set_error("missing-content", "write_file requires a content bytes frame.");
        return 400;
    }
    std::string path;
    if (!request_path("write_file", &path)) return 400;

    // Meta references the content as binary segment 0 so raw bytes never
    // round-trip through JSON on the wire.
    const std::string payload =
        std::string("{\"path\":\"") + json_escape(path) + "\",\"value\":{\"$bin\":0}}";
    const std::vector<uint8_t> env = hostcall(
        "filesystem.writeFile", payload,
        content->payload ? content->payload : reinterpret_cast<const uint8_t*>(""),
        content->payload_length);
    const std::string meta = envelope_meta_json(env);
    if (!meta_ok(meta)) {
        return fail_from_meta("file-write-failed", meta, "filesystem.writeFile hostcall failed.");
    }

    // NodeHost reports the resolved path in result.path; fall back to the
    // requested path when the host result carries none.
    std::string resolved = path;
    {
        std::string host_path;
        if (json_string_field(meta, "path", &host_path) && !host_path.empty()) {
            resolved = host_path;
        }
    }
    char count_buf[32];
    std::snprintf(count_buf, sizeof(count_buf), "%u", content->payload_length);
    const std::string result = std::string("{\"ok\":true,\"bytesWritten\":") + count_buf +
                               ",\"path\":\"" + json_escape(resolved) + "\"}";
    const int32_t pushed = push_json("result", result);
    return pushed < 0 ? 500 : 0;
}

}  // extern "C"
