/*
 * hostcap/http-request (loop C.3c2).
 *
 * Capability node for the host http.request hostcall. One method:
 *
 *   request — "request" JSON {"method","url","headers","bodyB64","timeoutMs"}
 *             -> http.request -> "response" JSON
 *             {"status":N,"headers":{...},"bodyB64":"..."}.
 *
 * Host dialects (verified against SDK nodeHost.js/browserHost.js and
 * sdn-server internal/modulert/caps/http.go):
 *   - SDK JS hosts take {url,method,headers,body,timeoutMs,responseType}
 *     and return {status,statusText,ok,headers,body} with body as raw
 *     bytes (binary envelope segment) when responseType=binary.
 *   - The Go host takes {method,url,headers,body,body_encoding,timeout_ms}
 *     and returns {status,headers,body,body_encoding} with body as a JSON
 *     string (utf8 or base64), capped at 4 MiB.
 * The request meta therefore carries BOTH dialects (timeout_ms + timeoutMs,
 * body as binary segment which the Go bridge attaches as a base64 string
 * matched by body_encoding=base64), and the response path normalizes either
 * shape to bodyB64.
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

// ---------------------------------------------------------------------------
// Hostcall wire envelope helpers (optional binary request segment).
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
// Base64 (standard alphabet, padded).
// ---------------------------------------------------------------------------

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

bool base64_decode(const std::string& text, std::vector<uint8_t>* out) {
    out->clear();
    uint32_t acc = 0;
    int bits = 0;
    for (const char c : text) {
        if (c == '=' || c == '\n' || c == '\r') continue;
        const int v = b64_value(c);
        if (v < 0) return false;
        acc = (acc << 6) | static_cast<uint32_t>(v);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out->push_back(static_cast<uint8_t>((acc >> bits) & 0xff));
        }
    }
    return true;
}

}  // namespace

extern "C" {

// request: {"method","url","headers","bodyB64","timeoutMs"} -> http.request
// -> {"status","headers","bodyB64"} on "response".
int request(void) {
    const plugin_input_frame_t* frame = plugin_get_input_frame(0);
    if (!frame || !frame->payload || frame->payload_length == 0) {
        plugin_set_error("missing-request-frame", "request requires a request JSON frame.");
        return 400;
    }
    const std::string request_json(reinterpret_cast<const char*>(frame->payload),
                                   frame->payload_length);

    std::string url;
    if (!json_string_field(request_json, "url", &url) || url.empty()) {
        plugin_set_error("missing-url", "request requires {\"url\":\"...\"}.");
        return 400;
    }
    std::string method = "GET";
    {
        std::string m;
        if (json_string_field(request_json, "method", &m) && !m.empty()) method = m;
    }
    const std::string headers = json_object_slice(request_json, "headers");
    double timeout_ms = 0.0;
    const bool has_timeout = json_number_field(request_json, "timeoutMs", &timeout_ms) &&
                             timeout_ms > 0;

    std::vector<uint8_t> body;
    bool has_body = false;
    {
        std::string body_b64;
        if (json_string_field(request_json, "bodyB64", &body_b64) && !body_b64.empty()) {
            if (!base64_decode(body_b64, &body)) {
                plugin_set_error("invalid-body", "bodyB64 is not valid base64.");
                return 400;
            }
            has_body = true;
        }
    }

    // Meta carries both host dialects: the SDK JS hosts read timeoutMs /
    // responseType and receive body as a re-attached Uint8Array; the Go host
    // reads timeout_ms / body_encoding and receives the same segment attached
    // as a base64 string.
    std::string payload = std::string("{\"method\":\"") + json_escape(method) +
                          "\",\"url\":\"" + json_escape(url) + "\"" +
                          ",\"responseType\":\"binary\"";
    if (!headers.empty()) {
        payload += ",\"headers\":" + headers;
    }
    if (has_timeout) {
        char timeout_buf[32];
        std::snprintf(timeout_buf, sizeof(timeout_buf), "%.0f", timeout_ms);
        payload += std::string(",\"timeout_ms\":") + timeout_buf + ",\"timeoutMs\":" + timeout_buf;
    }
    if (has_body) {
        payload += ",\"body\":{\"$bin\":0},\"body_encoding\":\"base64\"";
    }
    payload += "}";

    const std::vector<uint8_t> env =
        has_body ? hostcall("http.request", payload, body.data(),
                            static_cast<uint32_t>(body.size()))
                 : hostcall("http.request", payload);
    const std::string meta = envelope_meta_json(env);
    if (!meta_ok(meta)) {
        return fail_from_meta("http-request-failed", meta, "http.request hostcall failed.");
    }

    const std::string result = json_object_slice(meta, "result");
    double status = 0.0;
    if (result.empty() || !json_number_field(result, "status", &status)) {
        plugin_set_error("http-request-failed",
                         "http.request response carried no status field.");
        return 502;
    }

    std::string response_headers = json_object_slice(result, "headers");
    if (response_headers.empty()) response_headers = "{}";

    // Body: JS hosts detach the binary body into envelope segment 0; the Go
    // host inlines a string body with body_encoding utf8|base64.
    std::string body_b64;
    const uint8_t* seg = nullptr;
    uint32_t seg_len = 0;
    if (envelope_first_segment(env, &seg, &seg_len)) {
        body_b64 = base64_encode(seg, seg_len);
    } else {
        std::string body_text;
        if (json_string_field(result, "body", &body_text) && !body_text.empty()) {
            std::string encoding;
            json_string_field(result, "body_encoding", &encoding);
            if (encoding == "base64") {
                body_b64 = body_text;
            } else {
                body_b64 = base64_encode(
                    reinterpret_cast<const uint8_t*>(body_text.data()), body_text.size());
            }
        }
    }

    char status_buf[16];
    std::snprintf(status_buf, sizeof(status_buf), "%d", static_cast<int>(status));
    const std::string response = std::string("{\"status\":") + status_buf +
                                 ",\"headers\":" + response_headers +
                                 ",\"bodyB64\":\"" + body_b64 + "\"}";
    const int32_t pushed = plugin_push_output_ex(
        "response", nullptr, nullptr,
        PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr,
        0, 1,
        reinterpret_cast<const uint8_t*>(response.data()),
        static_cast<uint32_t>(response.size()));
    return pushed < 0 ? 500 : 0;
}

}  // extern "C"
