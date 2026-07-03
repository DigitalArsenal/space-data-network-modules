/*
 * hostcap/random (loop C.3c2).
 *
 * Capability node for the host random.bytes hostcall. One method:
 *
 *   bytes — optional "request" JSON frame {"length":N} (default 32,
 *           max 65536); calls random.bytes and passes the returned raw
 *           bytes (hostcall binary segment 0) through VERBATIM on the
 *           "bytes" port.
 *
 * Both hosts deliver the random bytes as binary envelope segment 0: the
 * SDK JS hosts return a Uint8Array (detached into a segment by the wire
 * codec) and the Go host returns {"__type":"bytes"} which detaches the
 * same way. The Go host silently clamps length to 8192 — downstream
 * consumers must use the emitted frame's actual length.
 *
 * Hostcall ABI and envelope helpers follow the data-source/retrieval
 * pattern; see space-data-module-sdk/src/host/hostcallWire.js.
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

constexpr long kDefaultLength = 32;
constexpr long kMaxLength = 65536;

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

bool json_number_field(const std::string& json, const std::string& key, double* out) {
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return false;
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return false;
    size_t i = colon + 1;
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

int fail_from_meta(const char* code, const std::string& meta, const char* fallback) {
    std::string message;
    json_string_field(meta, "message", &message);
    plugin_set_error(code, message.empty() ? fallback : message.c_str());
    return 502;
}

}  // namespace

extern "C" {

// bytes: resolve the byte count (request frame > default 32, max 65536),
// call random.bytes, and pass the returned bytes through verbatim.
int bytes(void) {
    long length = kDefaultLength;
    if (plugin_get_input_count() > 0) {
        const plugin_input_frame_t* frame = plugin_get_input_frame(0);
        if (frame && frame->payload && frame->payload_length > 0) {
            const std::string request(reinterpret_cast<const char*>(frame->payload),
                                      frame->payload_length);
            double d = 0.0;
            if (json_number_field(request, "length", &d)) {
                length = static_cast<long>(d);
            }
        }
    }
    if (length < 1 || length > kMaxLength) {
        plugin_set_error("invalid-length",
                         "random bytes length must be between 1 and 65536.");
        return 400;
    }

    char length_buf[32];
    std::snprintf(length_buf, sizeof(length_buf), "%ld", length);
    const std::vector<uint8_t> env =
        hostcall("random.bytes", std::string("{\"length\":") + length_buf + "}");
    const std::string meta = envelope_meta_json(env);
    if (!meta_ok(meta)) {
        return fail_from_meta("random-unavailable", meta, "random.bytes hostcall failed.");
    }

    const uint8_t* seg = nullptr;
    uint32_t seg_len = 0;
    if (!envelope_first_segment(env, &seg, &seg_len)) {
        plugin_set_error("random-unavailable",
                         "random.bytes response carried no binary segment.");
        return 502;
    }
    const int32_t pushed = plugin_push_output_ex(
        "bytes", nullptr, nullptr,
        PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr,
        0, 1, seg, seg_len);
    return pushed < 0 ? 500 : 0;
}

}  // extern "C"
