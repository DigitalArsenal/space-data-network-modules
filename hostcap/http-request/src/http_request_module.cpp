/*
 * hostcap/http-request (loop C.3c2).
 *
 * Capability node for the host http.request hostcall. One method:
 *
 *   request — "request" JSON {"method","url","headers","bodyB64","timeoutMs",
 *                              "maxBytes","responseWire":"raw-body-v1"}
 *             -> http.request -> one "response" frame. The default is JSON
 *             {"status":N,"headers":{...},"bodyB64":"..."}; raw-body-v1 is
 *             $HRB + status + the body bytes, with no base64 expansion.
 *
 * Host dialects (verified against SDK nodeHost.js/browserHost.js and
 * sdn-server internal/modulert/caps/http.go):
 *   - SDK JS hosts take {url,method,headers,body,timeoutMs,responseType}
 *     and return {status,statusText,ok,headers,body} with body as raw
 *     bytes (binary envelope segment) when responseType=binary.
 *   - The Go host takes {method,url,headers,body,body_encoding,timeout_ms,
 *     max_bytes} and returns {status,headers,body,body_encoding} with body
 *     as a JSON string (utf8 or base64), bounded by host policy and by the
 *     request's own max_bytes budget (exceeding either is an error, never a
 *     truncation).
 * The request meta therefore carries BOTH dialects (timeout_ms + timeoutMs,
 * body as binary segment which the Go bridge attaches as a base64 string
 * matched by body_encoding=base64), and the response path normalizes either
 * shape to bodyB64, or decodes it directly into the raw frame when opted in.
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

bool is_json_ws(char c);

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

bool envelope_meta_view(const std::vector<uint8_t>& env,
                        const uint8_t** meta_out, size_t* meta_len_out) {
    *meta_out = nullptr;
    *meta_len_out = 0;
    if (env.size() < 4) return false;
    const uint32_t meta_len = read_u32le(env.data());
    if (env.size() < 4u + meta_len) return false;
    *meta_out = env.data() + 4;
    *meta_len_out = meta_len;
    return true;
}

// Locate a structural JSON string field without materialising the host's whole
// response envelope as std::string copies. Provider bodies are themselves JSON
// strings in the Go host dialect, so copying meta -> result -> body used three
// additional body-sized allocations before decoding even began.
bool json_string_field_view(const uint8_t* json, size_t json_len, const char* key,
                            const uint8_t** value_out, size_t* value_len_out) {
    *value_out = nullptr;
    *value_len_out = 0;
    const size_t key_len = std::strlen(key);
    for (size_t i = 0; i + key_len + 2 <= json_len; ++i) {
        if (json[i] != '"' || std::memcmp(json + i + 1, key, key_len) != 0 ||
            json[i + key_len + 1] != '"') {
            continue;
        }
        size_t at = i + key_len + 2;
        while (at < json_len && is_json_ws(static_cast<char>(json[at]))) ++at;
        if (at >= json_len || json[at++] != ':') continue;
        while (at < json_len && is_json_ws(static_cast<char>(json[at]))) ++at;
        if (at >= json_len || json[at++] != '"') return false;
        const size_t start = at;
        bool escaped = false;
        for (; at < json_len; ++at) {
            const uint8_t c = json[at];
            if (escaped) {
                escaped = false;
                continue;
            }
            if (c == '\\') {
                escaped = true;
                continue;
            }
            if (c == '"') {
                *value_out = json + start;
                *value_len_out = at - start;
                return true;
            }
        }
        return false;
    }
    return false;
}

bool json_integer_field_view(const uint8_t* json, size_t json_len, const char* key,
                             int* value_out) {
    const size_t key_len = std::strlen(key);
    for (size_t i = 0; i + key_len + 2 <= json_len; ++i) {
        if (json[i] != '"' || std::memcmp(json + i + 1, key, key_len) != 0 ||
            json[i + key_len + 1] != '"') {
            continue;
        }
        size_t at = i + key_len + 2;
        while (at < json_len && is_json_ws(static_cast<char>(json[at]))) ++at;
        if (at >= json_len || json[at++] != ':') continue;
        while (at < json_len && is_json_ws(static_cast<char>(json[at]))) ++at;
        bool negative = false;
        if (at < json_len && json[at] == '-') { negative = true; ++at; }
        if (at >= json_len || json[at] < '0' || json[at] > '9') return false;
        int value = 0;
        while (at < json_len && json[at] >= '0' && json[at] <= '9') {
            value = value * 10 + static_cast<int>(json[at++] - '0');
        }
        *value_out = negative ? -value : value;
        return true;
    }
    return false;
}

bool json_true_field_view(const uint8_t* json, size_t json_len, const char* key) {
    const size_t key_len = std::strlen(key);
    for (size_t i = 0; i + key_len + 2 <= json_len; ++i) {
        if (json[i] != '"' || std::memcmp(json + i + 1, key, key_len) != 0 ||
            json[i + key_len + 1] != '"') {
            continue;
        }
        size_t at = i + key_len + 2;
        while (at < json_len && is_json_ws(static_cast<char>(json[at]))) ++at;
        if (at >= json_len || json[at++] != ':') continue;
        while (at < json_len && is_json_ws(static_cast<char>(json[at]))) ++at;
        return at + 4 <= json_len && std::memcmp(json + at, "true", 4) == 0;
    }
    return false;
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

int hex_value(uint8_t c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

void append_utf8(uint32_t codepoint, std::vector<uint8_t>* out) {
    if (codepoint <= 0x7f) {
        out->push_back(static_cast<uint8_t>(codepoint));
    } else if (codepoint <= 0x7ff) {
        out->push_back(static_cast<uint8_t>(0xc0 | (codepoint >> 6)));
        out->push_back(static_cast<uint8_t>(0x80 | (codepoint & 0x3f)));
    } else if (codepoint <= 0xffff) {
        out->push_back(static_cast<uint8_t>(0xe0 | (codepoint >> 12)));
        out->push_back(static_cast<uint8_t>(0x80 | ((codepoint >> 6) & 0x3f)));
        out->push_back(static_cast<uint8_t>(0x80 | (codepoint & 0x3f)));
    } else {
        out->push_back(static_cast<uint8_t>(0xf0 | (codepoint >> 18)));
        out->push_back(static_cast<uint8_t>(0x80 | ((codepoint >> 12) & 0x3f)));
        out->push_back(static_cast<uint8_t>(0x80 | ((codepoint >> 6) & 0x3f)));
        out->push_back(static_cast<uint8_t>(0x80 | (codepoint & 0x3f)));
    }
}

bool decode_json_string_into(const uint8_t* text, size_t text_len,
                             std::vector<uint8_t>* out, size_t prefix) {
    out->clear();
    out->reserve(prefix + text_len);
    out->resize(prefix, 0);
    for (size_t i = 0; i < text_len; ++i) {
        const uint8_t c = text[i];
        if (c != '\\') {
            out->push_back(c);
            continue;
        }
        if (++i >= text_len) return false;
        const uint8_t escaped = text[i];
        if (escaped == '"' || escaped == '\\' || escaped == '/') out->push_back(escaped);
        else if (escaped == 'b') out->push_back('\b');
        else if (escaped == 'f') out->push_back('\f');
        else if (escaped == 'n') out->push_back('\n');
        else if (escaped == 'r') out->push_back('\r');
        else if (escaped == 't') out->push_back('\t');
        else if (escaped == 'u') {
            if (i + 4 >= text_len) return false;
            uint32_t codepoint = 0;
            for (size_t digit = 0; digit < 4; ++digit) {
                const int value = hex_value(text[++i]);
                if (value < 0) return false;
                codepoint = (codepoint << 4) | static_cast<uint32_t>(value);
            }
            if (codepoint >= 0xd800 && codepoint <= 0xdbff && i + 6 < text_len &&
                text[i + 1] == '\\' && text[i + 2] == 'u') {
                uint32_t low = 0;
                bool valid_low = true;
                for (size_t digit = 0; digit < 4; ++digit) {
                    const int value = hex_value(text[i + 3 + digit]);
                    if (value < 0) { valid_low = false; break; }
                    low = (low << 4) | static_cast<uint32_t>(value);
                }
                if (valid_low && low >= 0xdc00 && low <= 0xdfff) {
                    codepoint = 0x10000 + ((codepoint - 0xd800) << 10) + (low - 0xdc00);
                    i += 6;
                }
            }
            append_utf8(codepoint, out);
        } else {
            return false;
        }
    }
    return true;
}

bool base64_decode_into(const uint8_t* text, size_t text_len,
                        std::vector<uint8_t>* out, size_t prefix) {
    out->clear();
    out->reserve(prefix + ((text_len + 3) / 4) * 3);
    out->resize(prefix, 0);
    uint32_t acc = 0;
    int bits = 0;
    for (size_t i = 0; i < text_len; ++i) {
        const char c = static_cast<char>(text[i]);
        if (c == '=' || c == '\n' || c == '\r') continue;
        const int value = b64_value(c);
        if (value < 0) return false;
        acc = (acc << 6) | static_cast<uint32_t>(value);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out->push_back(static_cast<uint8_t>((acc >> bits) & 0xff));
        }
    }
    return true;
}

bool base64_decode(const std::string& text, std::vector<uint8_t>* out) {
    return base64_decode_into(reinterpret_cast<const uint8_t*>(text.data()),
                              text.size(), out, 0);
}

// Push one "response" frame. Every exit path of perform_one_request goes
// through here, so the node emits EXACTLY ONE response per request frame.
int push_response(int status, const std::string& headers_json, const std::string& body_b64,
                  const std::string& error_code, const std::string& error_message) {
    char status_buf[16];
    std::snprintf(status_buf, sizeof(status_buf), "%d", status);
    std::string response = std::string("{\"status\":") + status_buf +
                           ",\"headers\":" + (headers_json.empty() ? "{}" : headers_json) +
                           ",\"bodyB64\":\"" + body_b64 + "\"";
    if (!error_code.empty()) {
        response += ",\"error\":\"" + json_escape(error_code) + "\"" +
                    ",\"errorMessage\":\"" + json_escape(error_message) + "\"";
    }
    response += "}";
    const int32_t pushed = plugin_push_output_ex(
        "response", nullptr, nullptr,
        PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr,
        0, 1,
        reinterpret_cast<const uint8_t*>(response.data()),
        static_cast<uint32_t>(response.size()));
    return pushed < 0 ? 500 : 0;
}

// Raw response-body lane for flows that consume large provider documents.
//
// The default JSON response above remains the public connector contract. It is
// convenient for small responses, but a 27 MB GeoJSON body becomes a 36 MB
// base64 string and is copied through several JSON/string buffers before the
// downstream parser sees it. The cellular aggregate's 128 MB flow instance
// exhausted its memory in that conversion and trapped before the HTTP node
// completed, permanently leaving one pooled instance unable to run real work.
//
// A descriptor may therefore request `responseWire:"raw-body-v1"`. The output
// is an aligned-binary frame:
//
//   0..3  "$HRB" (host response body)
//   4..7  signed HTTP status, little endian (0 means connector failure)
//   8..N  response body bytes verbatim
//
// This is still a generic connector surface: no provider or application
// semantics enter this node. The consumer opts in and owns the body format.
int push_raw_response(int status, const uint8_t* body, size_t body_len) {
    std::vector<uint8_t> response(8 + body_len);
    response[0] = '$';
    response[1] = 'H';
    response[2] = 'R';
    response[3] = 'B';
    write_u32le(response.data() + 4, static_cast<uint32_t>(status));
    if (body_len > 0 && body) {
        std::memcpy(response.data() + 8, body, body_len);
    }
    const int32_t pushed = plugin_push_output_ex(
        "response", nullptr, nullptr,
        PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr,
        0, 1, response.data(), static_cast<uint32_t>(response.size()));
    return pushed < 0 ? 500 : 0;
}

int fail_slot(int return_status, const char* code, const std::string& message,
              bool raw_response);

int push_raw_response_buffer(int status, std::vector<uint8_t>* response) {
    if (!response || response->size() < 8) return 500;
    (*response)[0] = '$';
    (*response)[1] = 'H';
    (*response)[2] = 'R';
    (*response)[3] = 'B';
    write_u32le(response->data() + 4, static_cast<uint32_t>(status));
    const int32_t pushed = plugin_push_output_ex(
        "response", nullptr, nullptr,
        PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr,
        0, 1, response->data(), static_cast<uint32_t>(response->size()));
    return pushed < 0 ? 500 : 0;
}

// Go returns text/json bodies inside the hostcall envelope's JSON metadata.
// Decode that JSON string DIRECTLY from the envelope into the output frame.
// The former meta/result/body std::string chain held three extra 27 MB copies
// for BAKOM before push_output made a fourth, exhausting the 128 MiB guest.
int push_raw_host_response(const std::vector<uint8_t>& env) {
    const uint8_t* meta = nullptr;
    size_t meta_len = 0;
    if (!envelope_meta_view(env, &meta, &meta_len) ||
        !json_true_field_view(meta, meta_len, "ok")) {
        return fail_slot(502, "http-request-failed",
                         "http.request hostcall failed.", true);
    }

    int status = 0;
    if (!json_integer_field_view(meta, meta_len, "status", &status)) {
        return fail_slot(502, "http-request-failed",
                         "http.request response carried no status field.", true);
    }

    const uint8_t* seg = nullptr;
    uint32_t seg_len = 0;
    if (envelope_first_segment(env, &seg, &seg_len)) {
        return push_raw_response(status, seg, seg_len);
    }

    const uint8_t* body = nullptr;
    size_t body_len = 0;
    if (!json_string_field_view(meta, meta_len, "body", &body, &body_len)) {
        return push_raw_response(status, nullptr, 0);
    }
    const uint8_t* encoding = nullptr;
    size_t encoding_len = 0;
    const bool base64 = json_string_field_view(meta, meta_len, "body_encoding",
                                                &encoding, &encoding_len) &&
                        encoding_len == 6 && std::memcmp(encoding, "base64", 6) == 0;

    std::vector<uint8_t> response;
    const bool decoded = base64
        ? base64_decode_into(body, body_len, &response, 8)
        : decode_json_string_into(body, body_len, &response, 8);
    if (!decoded) {
        return fail_slot(502, "http-request-failed",
                         base64 ? "http.request response body is not valid base64."
                                : "http.request response body is not valid JSON text.",
                         true);
    }
    return push_raw_response_buffer(status, &response);
}

// A request that could not be performed still occupies its slot. Status 0 is
// outside 2xx, so a consumer that filters on status drops it exactly as it
// would drop a 500 — but the FRAME EXISTS, which is what keeps request k and
// response k aligned.
//
// This is not defensive padding, it is a correctness requirement ruled by
// Janus (module-sdk-oracle, 2026-08-09) and paid for once already: this node
// used to push NOTHING for a failed fetch, so a single dead mirror shifted
// every later body one slot left and `cell-tower-source::parse` attributed
// bodies to providers that never served them. That is the one failure this
// record type cannot tolerate — a mast published under a regulator's name that
// never asserted it — so parse had to add format corroboration to fail closed
// against a hole this node was digging.
int fail_slot(int return_status, const char* code, const std::string& message,
              bool raw_response) {
    plugin_set_error(code, message.c_str());
    if (raw_response) push_raw_response(0, nullptr, 0);
    else push_response(0, "{}", "", code, message);
    return return_status;
}

// ---------------------------------------------------------------------------
// One descriptor -> one hostcall -> one pushed "response" frame.
//
// Split out of `request` so the entry can run it once per INPUT FRAME. See the
// comment on `request` for why that is not optional.
//
// Returns 0 on success, or the status this node would have returned as a
// single-frame node (400 malformed, 502 transport). EITHER WAY it pushes
// exactly one response frame.
// ---------------------------------------------------------------------------
int perform_one_request(const std::string& request_json) {
    std::string response_wire;
    json_string_field(request_json, "responseWire", &response_wire);
    const bool raw_response = response_wire == "raw-body-v1";

    std::string url;
    if (!json_string_field(request_json, "url", &url) || url.empty()) {
        return fail_slot(400, "missing-url", "request requires {\"url\":\"...\"}.",
                         raw_response);
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
    // Per-request response byte budget. Forwarded to the Go host as
    // "max_bytes", where the cap lowers its read limit and ERRORS when the
    // body exceeds it — the host never truncates, so a flow that declares a
    // budget can never ingest a partial document as if it were complete.
    // The SDK JS hosts ignore the key.
    double max_bytes = 0.0;
    const bool has_max_bytes = json_number_field(request_json, "maxBytes", &max_bytes) &&
                               max_bytes > 0;

    std::vector<uint8_t> body;
    bool has_body = false;
    {
        std::string body_b64;
        if (json_string_field(request_json, "bodyB64", &body_b64) && !body_b64.empty()) {
            if (!base64_decode(body_b64, &body)) {
                return fail_slot(400, "invalid-body", "bodyB64 is not valid base64.",
                                 raw_response);
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
    if (has_max_bytes) {
        char max_bytes_buf[32];
        std::snprintf(max_bytes_buf, sizeof(max_bytes_buf), "%.0f", max_bytes);
        payload += std::string(",\"max_bytes\":") + max_bytes_buf;
    }
    if (has_body) {
        payload += ",\"body\":{\"$bin\":0},\"body_encoding\":\"base64\"";
    }
    payload += "}";

    const std::vector<uint8_t> env =
        has_body ? hostcall("http.request", payload, body.data(),
                            static_cast<uint32_t>(body.size()))
                 : hostcall("http.request", payload);
    if (raw_response) return push_raw_host_response(env);

    const std::string meta = envelope_meta_json(env);
    if (!meta_ok(meta)) {
        std::string message;
        json_string_field(meta, "message", &message);
        return fail_slot(502, "http-request-failed",
                         message.empty() ? "http.request hostcall failed." : message,
                         raw_response);
    }

    const std::string result = json_object_slice(meta, "result");
    double status = 0.0;
    if (result.empty() || !json_number_field(result, "status", &status)) {
        return fail_slot(502, "http-request-failed",
                         "http.request response carried no status field.", raw_response);
    }

    std::string response_headers = json_object_slice(result, "headers");
    if (response_headers.empty()) response_headers = "{}";

    // Body: JS hosts detach the binary body into envelope segment 0; the Go
    // host inlines a string body with body_encoding utf8|base64.
    std::string body_b64;
    std::string body_text;
    const uint8_t* seg = nullptr;
    uint32_t seg_len = 0;
    if (envelope_first_segment(env, &seg, &seg_len)) {
        if (!raw_response) body_b64 = base64_encode(seg, seg_len);
    } else {
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

    return push_response(static_cast<int>(status), response_headers, body_b64, "", "");
}

}  // namespace

extern "C" {

// request: N x {"method","url","headers","bodyB64","timeoutMs"} -> http.request
// -> N x {"status","headers","bodyB64"} on "response", one per input frame, in
// input order.
//
// THIS NODE MUST DRAIN ITS WHOLE INPUT BATCH. It used to read
// plugin_get_input_frame(0) and return, and that single line was a live P1:
// `cellular-multiprovider-returns-only-first-provider`. The compiled flow
// runtime does not enforce maxStreams or maxBatch when it fills an invocation —
// space_data_module_runtime_begin_node_invocation (SDK
// src/flow/runtime-src/flow_runtime.cpp) pops frames off the node's queue
// `while (count < budget && !queue.empty())`, with budget 64 from
// drain_linked. So when an upstream node fans out N descriptors, ALL N arrive
// in ONE invocation, and a guest that looks only at frame 0 silently DESTROYS
// the other N-1: they are already dequeued, so nothing re-delivers them and
// nothing logs their loss.
//
// Measured live on host-01 (sdn-server 3bd7f449) from the host's OWN connector
// ledger (fetch_events, written by caps.SetFetchObserver — not a harness):
// POST /api/v1/cellular/aggregate PROVIDERS ["fcc-uls-3650","openstreetmap-overpass"]
// incremented the FCC url's fetch_count by 1 and the Overpass url's by ZERO,
// and the reverse order incremented Overpass by 1 and FCC by zero. Exactly one
// outbound fetch per run, always the first descriptor's — so a two-provider
// request returned precisely the first-named provider's sites and
// multiProviderSites was 0 on every run.
//
// The declarations disagreed with each other AND with the runtime, which is why
// this hid: plugin-manifest.json said maxBatch 1 / single-shot, the flow said
// drain-until-yield, and the runtime enforced neither. The manifest is
// corrected to match what this code now does; the code no longer depends on
// either declaration being honoured.
//
// PARTIAL FAILURE IS NOT BATCH FAILURE. One dead mirror must not delete the
// providers queued behind it, so a frame that fails emits its slot-preserving
// response (status 0 + error) and the loop continues. A non-zero status is
// returned only when NOTHING succeeded, which preserves this node's
// single-frame behaviour exactly when N == 1.
//
// Fetches are SEQUENTIAL: hostcall("http.request") is synchronous, so a batch
// costs the sum of its members. That is a real cost — a 2-provider cellular
// request is 4 descriptors (FCC + 3 Overpass endpoints, measured 0.2 s / 3.1 s
// / 4.4 s / 5.4 s from host-01) — and it is still the right shape here,
// because the alternative is losing providers. Bounding a batch is the
// upstream node's job: it decides how many descriptors to fan out.
int request(void) {
    const uint32_t input_count = plugin_get_input_count();

    uint32_t considered = 0;
    uint32_t succeeded = 0;
    int first_failure = 0;

    for (uint32_t i = 0; i < input_count; i++) {
        const plugin_input_frame_t* frame = plugin_get_input_frame(i);
        if (!frame) continue;
        // Defensive: this method declares exactly one input port, but the
        // runtime hands a node whatever is queued on it, so never assume the
        // port of a frame that was handed over.
        if (frame->port_id && std::strcmp(frame->port_id, "request") != 0) continue;
        if (!frame->payload || frame->payload_length == 0) continue;

        considered++;
        const std::string request_json(reinterpret_cast<const char*>(frame->payload),
                                       frame->payload_length);
        const int status = perform_one_request(request_json);
        if (status == 0) {
            succeeded++;
        } else if (first_failure == 0) {
            first_failure = status;
        }
    }

    if (considered == 0) {
        plugin_set_error("missing-request-frame", "request requires a request JSON frame.");
        return 400;
    }
    // At least one response was pushed: the batch is a partial success and the
    // downstream node gets what was actually fetched. plugin_set_error may hold
    // the last failure's text; clear it so a partial success is not reported as
    // a node error.
    if (succeeded > 0) {
        plugin_set_error("", "");
        return 0;
    }
    return first_failure != 0 ? first_failure : 502;
}

}  // extern "C"
