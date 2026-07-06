/*
 * foundation/http-respond (loop C.3b).
 *
 * Single-purpose flow node: routing-decision JSON frame in (plus optional
 * body / etag / error frames), exactly one $HTR HttpResponse envelope out.
 * Pure compute — no capabilities, no hostcalls. Behavior (documented in
 * plugin-manifest.json):
 *
 *   1. "error" input present (JSON {"error":msg}, plain text tolerated)
 *      -> 502 application/json {"error":msg}. Wins over everything.
 *   2. decision.route == "not_found"
 *      -> 404 application/json {"error": decision.error | "not found"}.
 *   2b. decision.route == "error" (gateway loop G.4)
 *      -> decision.status (clamped [400,599], default 503)
 *         application/json {"error": decision.error, "pnm": {...}?} — the
 *         optional "pnm" object rides verbatim from the decision so
 *         unavailability answers carry the newest publication pointer.
 *   3. "etag" input present and equal to decision.ifNoneMatch
 *      -> 304 with an etag header and an empty body.
 *   4. Otherwise 200: body frame verbatim (empty when absent),
 *      content-type from decision.format (flatbuffer ->
 *      application/vnd.sdn.flatbuffers.stream, json -> application/json),
 *      x-sdn-record-count when derivable (format=flatbuffer: count of
 *      size-prefixed frames when the framing parses cleanly, zero-length
 *      prefixes skipped as padding; format=json: count of top-level
 *      elements when the body is a bare JSON array — the json surface is
 *      the same record stream in a different encoding, so the count header
 *      carries the metadata the body envelope used to), etag header when
 *      the etag input is present.
 *
 * Response headers are lower-cased here and sorted by the $HTR encoder
 * (HttpHeader.NAME is a FlatBuffers key field). The SDK HTTP ABI C++
 * headers (HttpRequestAbi_generated.h + HttpResponseAbi_generated.h) are
 * prepended by build.mjs; this file contains only the method body.
 */

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"

namespace {

constexpr const char* kContentTypeStream = "application/vnd.sdn.flatbuffers.stream";
constexpr const char* kContentTypeJson = "application/json";

uint32_t read_u32le(const uint8_t* src) {
    return static_cast<uint32_t>(src[0]) | (static_cast<uint32_t>(src[1]) << 8) |
           (static_cast<uint32_t>(src[2]) << 16) | (static_cast<uint32_t>(src[3]) << 24);
}

bool is_json_ws(char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

// Extract "key":"..." string values (simple escapes), mirroring the other
// C.3b nodes' control-metadata helpers. Colon-anchored: a bare "key" needle
// can match a string VALUE (the G.3 lesson — {"route":"error"} would make
// the "error" key lookup land on the route value). All producers on this
// graph emit no space between the key quote and the colon.
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

const plugin_input_frame_t* find_input(const char* port_id) {
    const int32_t index = plugin_find_input_index(port_id, 0);
    return index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(index)) : nullptr;
}

std::string frame_as_string(const plugin_input_frame_t* frame) {
    if (!frame || !frame->payload || frame->payload_length == 0) return std::string();
    return std::string(reinterpret_cast<const char*>(frame->payload), frame->payload_length);
}

// Count size-prefixed frames in an aligned FlatBuffer stream. Zero-length
// prefixes are skipped as padding. Returns false when the framing is
// malformed (the record-count header is then omitted, never wrong).
bool count_stream_frames(const uint8_t* data, size_t length, uint32_t* count_out) {
    uint32_t count = 0;
    size_t offset = 0;
    while (offset < length) {
        if (length - offset < 4) return false;
        const uint32_t frame_size = read_u32le(data + offset);
        offset += 4;
        if (frame_size == 0) continue;
        if (frame_size > length - offset) return false;
        offset += frame_size;
        count++;
    }
    *count_out = count;
    return true;
}

// Count the top-level elements of a bare JSON array (string- and
// escape-aware bracket-depth scan). Returns false when the body is not a
// well-formed top-level array (the record-count header is then omitted,
// never wrong). An empty array counts 0.
bool count_json_array_elements(const uint8_t* data, size_t length, uint32_t* count_out) {
    size_t i = 0;
    while (i < length && (data[i] == ' ' || data[i] == '\t' || data[i] == '\n' || data[i] == '\r')) i++;
    if (i >= length || data[i] != '[') return false;
    i++;
    int depth = 1;  // inside the top-level array
    bool in_string = false;
    bool escaped = false;
    bool saw_element = false;
    uint32_t count = 0;
    for (; i < length; i++) {
        const char c = static_cast<char>(data[i]);
        if (in_string) {
            if (escaped) {
                escaped = false;
            } else if (c == '\\') {
                escaped = true;
            } else if (c == '"') {
                in_string = false;
            }
            continue;
        }
        switch (c) {
            case '"':
                in_string = true;
                if (depth == 1) saw_element = true;
                break;
            case '[':
            case '{':
                if (depth == 1) saw_element = true;
                depth++;
                break;
            case ']':
            case '}':
                depth--;
                if (depth == 0) {
                    // End of the top-level array: everything after must be
                    // whitespace.
                    if (saw_element) count++;
                    for (i++; i < length; i++) {
                        const char t = static_cast<char>(data[i]);
                        if (t != ' ' && t != '\t' && t != '\n' && t != '\r') return false;
                    }
                    *count_out = count;
                    return true;
                }
                break;
            case ',':
                if (depth == 1) {
                    if (!saw_element) return false;  // leading/double comma
                    count++;
                    saw_element = false;
                }
                break;
            case ' ':
            case '\t':
            case '\n':
            case '\r':
                break;
            default:
                if (depth == 1) saw_element = true;  // number / literal element
                break;
        }
    }
    return false;  // unterminated array
}

struct HeaderEntry {
    std::string name;
    std::string value;
};

int push_response_with_ref(uint16_t status, const std::vector<HeaderEntry>& headers,
                           const uint8_t* body, size_t body_length,
                           uint64_t body_ref_token, uint64_t body_ref_size) {
    ::flatbuffers::FlatBufferBuilder builder(1024);
    std::vector<::flatbuffers::Offset<sdn::http::HttpHeader>> header_offsets;
    header_offsets.reserve(headers.size());
    for (const auto& header : headers) {
        header_offsets.push_back(sdn::http::CreateHttpHeader(
            builder,
            builder.CreateString(header.name),
            builder.CreateString(header.value)));
    }
    // CreateVectorOfSortedTables sorts by the HttpHeader NAME key field, as
    // the $HTR ABI requires.
    const auto headers_vector =
        header_offsets.empty()
            ? ::flatbuffers::Offset<
                  ::flatbuffers::Vector<::flatbuffers::Offset<sdn::http::HttpHeader>>>(0)
            : builder.CreateVectorOfSortedTables<sdn::http::HttpHeader>(&header_offsets);
    const auto body_vector =
        body && body_length > 0
            ? builder.CreateVector<uint8_t>(body, body_length)
            : ::flatbuffers::Offset<::flatbuffers::Vector<uint8_t>>(0);
    const auto response = sdn::http::CreateHttpResponse(
        builder, status, headers_vector, body_vector, body_ref_token, body_ref_size);
    sdn::http::FinishHttpResponseBuffer(builder, response);

    const int32_t pushed = plugin_push_output_ex(
        "response", "HttpResponseAbi.fbs", "$HTR",
        PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "HttpResponse",
        0, 0,
        builder.GetBufferPointer(), builder.GetSize());
    return pushed < 0 ? 500 : 0;
}

int push_response(uint16_t status, const std::vector<HeaderEntry>& headers,
                  const uint8_t* body, size_t body_length) {
    return push_response_with_ref(status, headers, body, body_length, 0, 0);
}

// Body-reference descriptor frames (loop C.5c): a body input that is the
// retrieval path's {"$sdnbodyref":1,"token":..,"size":..,"frames":..,
// "fnv1a64":".."} JSON descriptor (instead of stream bytes). The $HTR then
// carries BODY_REF_TOKEN/BODY_REF_SIZE and NO inline body; the host
// substitutes the byte buffer it registered under the token. An aligned
// FlatBuffer stream starts with a u32le size prefix, never this JSON.
constexpr const char* kBodyRefPrefix = "{\"$sdnbodyref\"";

bool is_body_ref_frame(const uint8_t* data, size_t length) {
    const size_t prefix_len = std::strlen(kBodyRefPrefix);
    return data != nullptr && length >= prefix_len &&
           std::memcmp(data, kBodyRefPrefix, prefix_len) == 0;
}

// Extract "key":<number> values (uint64-safe for the u53-range tokens and
// sizes the host issues).
bool json_u64_field(const std::string& json, const std::string& key, uint64_t* out) {
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return false;
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return false;
    size_t i = colon + 1;
    while (i < json.size() && is_json_ws(json[i])) i++;
    if (i >= json.size() || json[i] < '0' || json[i] > '9') return false;
    uint64_t value = 0;
    while (i < json.size() && json[i] >= '0' && json[i] <= '9') {
        value = value * 10 + static_cast<uint64_t>(json[i] - '0');
        i++;
    }
    *out = value;
    return true;
}

int push_json_error(uint16_t status, const std::string& message) {
    const std::string body = "{\"error\":\"" + json_escape(message) + "\"}";
    std::vector<HeaderEntry> headers;
    headers.push_back({"content-type", kContentTypeJson});
    return push_response(status, headers,
                         reinterpret_cast<const uint8_t*>(body.data()), body.size());
}

// Slice "key":{...} (brace-depth scan) out of an object — used to forward
// the decision's "pnm" pointer object verbatim into error bodies (G.4).
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

// Extract "key":<integer> control values (status codes).
bool json_int_field(const std::string& json, const std::string& key, long* out) {
    const std::string needle = "\"" + key + "\":";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return false;
    size_t i = k + needle.size();
    while (i < json.size() && is_json_ws(json[i])) i++;
    if (i >= json.size() || json[i] < '0' || json[i] > '9') return false;
    long value = 0;
    while (i < json.size() && json[i] >= '0' && json[i] <= '9') {
        value = value * 10 + (json[i] - '0');
        i++;
    }
    *out = value;
    return true;
}

}  // namespace

extern "C" {

// respond: decision (+ optional body / etag / error) -> one $HTR envelope.
int respond(void) {
    const plugin_input_frame_t* decision_frame = find_input("decision");
    if (!decision_frame || !decision_frame->payload || decision_frame->payload_length == 0) {
        plugin_set_error("missing-decision-frame",
                         "respond requires a routing-decision JSON frame on port \"decision\".");
        return 400;
    }
    const std::string decision = frame_as_string(decision_frame);

    std::string route;
    if (!json_string_field(decision, "route", &route) || route.empty()) {
        plugin_set_error("invalid-decision-frame",
                         "Decision frame does not carry a \"route\" field.");
        return 400;
    }
    std::string format = "flatbuffer";
    {
        std::string format_field;
        if (json_string_field(decision, "format", &format_field) && format_field == "json") {
            format = "json";
        }
    }
    std::string if_none_match;
    const bool has_if_none_match = json_string_field(decision, "ifNoneMatch", &if_none_match);

    // 1. Upstream error wins over everything: 502.
    if (const plugin_input_frame_t* error_frame = find_input("error")) {
        const std::string error_json = frame_as_string(error_frame);
        std::string message;
        if (!json_string_field(error_json, "error", &message) || message.empty()) {
            message = error_json.empty() ? "upstream error" : error_json;
        }
        return push_json_error(502, message);
    }

    // 2. not_found -> 404.
    if (route == "not_found") {
        std::string message;
        if (!json_string_field(decision, "error", &message) || message.empty()) {
            message = "not found";
        }
        return push_json_error(404, message);
    }

    // 2b. Explicit error decision (gateway loop G.4): status from the
    //     decision (clamped [400,599], default 503), body carries the error
    //     message plus the optional "pnm" publication pointer verbatim —
    //     the honest unavailability answer for unpinned/unmaterialized
    //     provider datasets.
    if (route == "error") {
        long status = 503;
        json_int_field(decision, "status", &status);
        if (status < 400 || status > 599) status = 503;
        std::string message;
        if (!json_string_field(decision, "error", &message) || message.empty()) {
            message = "service unavailable";
        }
        std::string body = "{\"error\":\"" + json_escape(message) + "\"";
        const std::string pnm = json_object_slice(decision, "pnm");
        if (!pnm.empty()) {
            body += ",\"pnm\":" + pnm;
        }
        body += "}";
        std::vector<HeaderEntry> headers;
        headers.push_back({"content-type", kContentTypeJson});
        return push_response(static_cast<uint16_t>(status), headers,
                             reinterpret_cast<const uint8_t*>(body.data()), body.size());
    }

    const plugin_input_frame_t* etag_frame = find_input("etag");
    const std::string etag = frame_as_string(etag_frame);

    // 3. Conditional request: If-None-Match equals the entity tag -> 304.
    if (etag_frame && !etag.empty() && has_if_none_match && if_none_match == etag) {
        std::vector<HeaderEntry> headers;
        headers.push_back({"etag", etag});
        return push_response(304, headers, nullptr, 0);
    }

    // 4. 200 with the body frame verbatim — either inline bytes or a
    //    body-reference descriptor forwarded as $HTR BODY_REF fields.
    const plugin_input_frame_t* body_frame = find_input("body");
    const uint8_t* body = body_frame ? body_frame->payload : nullptr;
    const size_t body_length = body ? static_cast<size_t>(body_frame->payload_length) : 0u;

    uint64_t body_ref_token = 0;
    uint64_t body_ref_size = 0;
    uint64_t body_ref_frames = 0;
    bool has_ref_frames = false;
    const bool body_is_ref = is_body_ref_frame(body, body_length);
    if (body_is_ref) {
        const std::string descriptor(reinterpret_cast<const char*>(body), body_length);
        if (!json_u64_field(descriptor, "token", &body_ref_token) ||
            !json_u64_field(descriptor, "size", &body_ref_size)) {
            plugin_set_error("invalid-body-ref",
                             "body-reference descriptor is missing token/size fields.");
            return 400;
        }
        has_ref_frames = json_u64_field(descriptor, "frames", &body_ref_frames);
    }

    std::vector<HeaderEntry> headers;
    headers.push_back({"content-type", format == "json" ? kContentTypeJson : kContentTypeStream});
    if (format == "json") {
        // Bare top-level array body: the count header carries the record
        // count the {"records":…,"count":N} envelope used to (json body
        // references never occur — the json branch materializes in flow
        // memory).
        uint32_t record_count = 0;
        if (!body_is_ref && count_json_array_elements(body, body_length, &record_count)) {
            char buf[16];
            std::snprintf(buf, sizeof(buf), "%u", record_count);
            headers.push_back({"x-sdn-record-count", buf});
        }
    } else {
        uint32_t record_count = 0;
        if (body_is_ref) {
            // The host counted the referenced stream's size-prefixed frames
            // when it materialized the buffer (same skip-zero-prefix rule as
            // count_stream_frames).
            if (has_ref_frames) {
                char buf[24];
                std::snprintf(buf, sizeof(buf), "%llu",
                              static_cast<unsigned long long>(body_ref_frames));
                headers.push_back({"x-sdn-record-count", buf});
            }
        } else if (count_stream_frames(body, body_length, &record_count)) {
            char buf[16];
            std::snprintf(buf, sizeof(buf), "%u", record_count);
            headers.push_back({"x-sdn-record-count", buf});
        }
    }
    if (etag_frame && !etag.empty()) {
        headers.push_back({"etag", etag});
    }
    if (body_is_ref) {
        return push_response_with_ref(200, headers, nullptr, 0, body_ref_token, body_ref_size);
    }
    return push_response(200, headers, body, body_length);
}

}  // extern "C"
