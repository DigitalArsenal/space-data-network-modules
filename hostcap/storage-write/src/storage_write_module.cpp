/*
 * hostcap/storage-write (graph tasks mod-cell-tower-ingest-flow /
 * upstream-modules-2).
 *
 * Capability node wrapping the host `storage.write` hostcall — the
 * SCHEMA-TYPED single-record write lane. One method:
 *
 *   write — inputs:
 *     "record" the FlatBuffer bytes of ONE SDS record.
 *     "meta"   OPTIONAL UTF-8 JSON {"source":"...","type":"IRM"}. `source` is
 *              the record's attribution string; absent, the host falls back to
 *              the module's own attribution. `type` is the SDS type code;
 *              absent, it is DERIVED from the record's own file identifier.
 *   output:
 *     "result" the host's verbatim result object {"cid","source","type"}.
 *
 * WHY THIS NODE HAD TO EXIST.
 *
 * `mod-cell-tower-ingest-flow` shipped a chunked bulk-ingest flow whose resume
 * mark had NOWHERE DURABLE TO GO, and the three candidate lanes were each ruled
 * out by measurement rather than by preference:
 *
 *   * `hostcap/flatsql-store` is built wasi-threads, so the flow compiler
 *     refuses to link it into a single-thread flow at all
 *     (`mixed-guest-thread-models`), and its `records` port admits only
 *     $OMM/$OCM/$OBD. It is not a generic row writer.
 *   * `hostcap/file` is single-thread and would fit, but the Go server host has
 *     no filesystem capability handler, so it fails closed on the very box the
 *     cellular lane targets.
 *   * `storage.write` exists on the host and is exactly right — but it is
 *     SCHEMA-TYPED, and using it meant inventing an SDS record for a
 *     bookkeeping row, which is Themis's call and not a flow's to make.
 *
 * Themis ruled: $IRM (Ingest Resume Mark) was minted and ratified in
 * spacedatastandards.org 1.196.0. The record now exists, so the lane can be
 * built, and it is built GENERICALLY — nothing here knows what $IRM is. Any
 * flow with a schema-typed row to persist gets a durable write lane out of this
 * node and the existing `storage_write` grant, with ZERO Go host changes.
 *
 * THE TYPE AND THE BYTES MUST AGREE, AND THAT IS CHECKED.
 *
 * `storage.write` files the bytes under whatever `type` it is told. A meta that
 * says "OMM" over a buffer whose file identifier is "$IRM" writes a mark into
 * the orbit table, where it is indistinguishable from a corrupt element set and
 * where nothing will ever look for it again. So when the record carries a file
 * identifier (bytes 4..7 of a FlatBuffer root buffer) and the meta also declares
 * a type, DISAGREEMENT IS REFUSED. Neither value is preferred over the other and
 * neither is coerced: the write does not happen.
 *
 * POLICY IS THE HOST'S. This node makes no decision about what may be written;
 * `storage.write` is gated by the dedicated `storage_write` capability grant,
 * which `storage_query` explicitly does NOT imply (kubo/sdn/sdnservices/
 * storage_cap.go). This node moves bytes and refuses contradictions.
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

std::string json_escape(const std::string& in) {
    std::string out;
    out.reserve(in.size() + 8);
    for (const char c : in) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out.push_back(c);
                }
        }
    }
    return out;
}

std::vector<uint8_t> hostcall(const char* op, const std::string& payload_json) {
    const size_t total = 4 + payload_json.size() + 4;
    std::vector<uint8_t> req(total, 0);
    write_u32le(req.data(), static_cast<uint32_t>(payload_json.size()));
    std::memcpy(req.data() + 4, payload_json.data(), payload_json.size());
    write_u32le(req.data() + 4 + payload_json.size(), 0);  // zero binary segments
    sdm_host_call(reinterpret_cast<const uint8_t*>(op), static_cast<int32_t>(std::strlen(op)),
                  req.data(), static_cast<int32_t>(req.size()));
    const int32_t len = sdm_host_response_len();
    std::vector<uint8_t> buf(len > 0 ? static_cast<size_t>(len) : 0);
    if (len > 0) sdm_host_read_response(buf.data(), len);
    return buf;
}

std::string envelope_meta_json(const std::vector<uint8_t>& env) {
    if (env.size() < 4) return std::string();
    const uint32_t meta_len = read_u32le(env.data());
    if (env.size() < 4u + meta_len) return std::string();
    return std::string(reinterpret_cast<const char*>(env.data() + 4), meta_len);
}

bool is_ws(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

std::string json_string_field(const std::string& json, const std::string& key) {
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return std::string();
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return std::string();
    size_t i = colon + 1;
    while (i < json.size() && is_ws(json[i])) i++;
    if (i >= json.size() || json[i] != '"') return std::string();
    i++;
    std::string value;
    while (i < json.size() && json[i] != '"') {
        if (json[i] == '\\' && i + 1 < json.size()) {
            value.push_back(json[i + 1]);
            i += 2;
        } else {
            value.push_back(json[i]);
            i++;
        }
    }
    return value;
}

std::string json_object_slice(const std::string& json, const std::string& key) {
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return std::string();
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return std::string();
    size_t i = colon + 1;
    while (i < json.size() && is_ws(json[i])) i++;
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

const plugin_input_frame_t* frame_for(const char* port) {
    const int32_t idx = plugin_find_input_index(port, 0);
    if (idx < 0) return nullptr;
    return plugin_get_input_frame(static_cast<uint32_t>(idx));
}

// SURPLUS-FRAME REFUSAL. The compiled flow runtime drains a node's queue
// PORT-BLIND up to a budget of 64; maxStreams/maxBatch/drainPolicy are purely
// declarative there. A guest that reads ordinal 0 and returns destroys every
// other frame it was handed, with nothing re-delivering and nothing logging the
// loss (live P1 `cellular-multiprovider-returns-only-first-provider`). `write`
// persists ONE record and answers with ONE cid, so a surplus cannot be merged
// into a correct answer — a second record silently dropped is a mark that was
// never durable, which is precisely the failure this whole lane exists to fix.
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

// The SDS type a FlatBuffer declares about ITSELF: bytes 4..7 of a root buffer
// are the file identifier, "$XXX". Returns "" when the buffer is too short or
// the identifier is not in that shape — absent, never guessed.
std::string type_from_file_identifier(const uint8_t* data, uint32_t length) {
    if (!data || length < 8) return std::string();
    if (data[4] != '$') return std::string();
    for (uint32_t i = 5; i < 8; i++) {
        const char c = static_cast<char>(data[i]);
        const bool printable = (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
        if (!printable) return std::string();
    }
    return std::string(reinterpret_cast<const char*>(data + 5), 3);
}

std::string upper_ascii(const std::string& s) {
    std::string out = s;
    for (char& c : out) {
        if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
    }
    return out;
}

}  // namespace

extern "C" {

int write_record(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

    const plugin_input_frame_t* record = frame_for("record");
    if (!record || !record->payload || record->payload_length == 0) {
        plugin_set_error("missing-record-frame", "write requires the record FlatBuffer frame.");
        return 400;
    }

    std::string meta;
    const plugin_input_frame_t* meta_frame = frame_for("meta");
    if (meta_frame && meta_frame->payload && meta_frame->payload_length > 0) {
        meta.assign(reinterpret_cast<const char*>(meta_frame->payload), meta_frame->payload_length);
    }

    const std::string declared = upper_ascii(json_string_field(meta, "type"));
    const std::string intrinsic = type_from_file_identifier(record->payload, record->payload_length);

    // THE CONTRADICTION IS REFUSED, NOT RESOLVED. Preferring either value would
    // file the bytes under a type the other half of the system will not look
    // for, and a record in the wrong table is indistinguishable from a record
    // that was never written.
    if (!declared.empty() && !intrinsic.empty() && declared != intrinsic) {
        char message[256];
        std::snprintf(message, sizeof(message),
                      "the meta declares type \"%s\" but the record's own file identifier is "
                      "\"$%s\". The write is refused rather than filed under either: a record "
                      "written to the wrong type's table is indistinguishable from one that was "
                      "never written.",
                      declared.c_str(), intrinsic.c_str());
        plugin_set_error("record-type-disagreement", message);
        return 400;
    }

    const std::string type = declared.empty() ? intrinsic : declared;
    if (type.empty()) {
        plugin_set_error("missing-record-type",
                         "write needs an SDS type: declare it on the meta frame, or hand a record "
                         "that carries its own file identifier.");
        return 400;
    }

    const std::string source = json_string_field(meta, "source");
    std::string payload = std::string("{\"type\":\"") + json_escape(type) + "\"";
    if (!source.empty()) payload += ",\"source\":\"" + json_escape(source) + "\"";
    payload += ",\"data\":\"" + base64_encode(record->payload, record->payload_length) + "\"}";

    const std::vector<uint8_t> env = hostcall("storage.write", payload);
    const std::string response = envelope_meta_json(env);
    if (response.find("\"ok\":true") == std::string::npos) {
        std::string message = json_string_field(response, "message");
        if (message.empty()) message = "storage.write hostcall failed.";
        plugin_set_error("write-failed", message.c_str());
        return 502;
    }
    std::string result = json_object_slice(response, "result");
    if (result.empty()) result = "{}";

    const int32_t pushed = plugin_push_output_ex(
        "result", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
        reinterpret_cast<const uint8_t*>(result.data()), static_cast<uint32_t>(result.size()));
    return pushed < 0 ? 500 : 0;
}

}  // extern "C"
