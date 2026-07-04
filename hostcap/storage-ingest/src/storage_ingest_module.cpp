/*
 * hostcap/storage-ingest (loop C.8a).
 *
 * Capability node wrapping the host storage.ingest_with_source hostcall —
 * the provenance/batch-capable flow-ingest sink. One method:
 *
 *   ingest — inputs:
 *     "meta"    UTF-8 JSON authored by the parser node: schema + SourceTags
 *               attribution (provider_id/source_name/source_url/batch_id/
 *               content_key_id), source_peer, reconcile mode, optional
 *               archive naming {"archive":{"source","name"}} and provenance
 *               {"provenance":{"source","json":"<b64>"}}.
 *     "records" size-prefixed FlatBuffer record stream.
 *     "raw"     OPTIONAL raw source payload (archived by the host when the
 *               meta carries archive naming).
 *   output:
 *     "result"  UTF-8 JSON {"ok":true,"schema","inserted",...} from the cap
 *               response (verbatim result object), or the node fails with
 *               the host error.
 *
 * The node rewrites the meta's binary references only: records -> {"$bin":0}
 * and archive.raw -> {"$bin":1}. Every DECISION (attribution, reconcile
 * mode, archive naming) was made upstream in the parser; the host side is
 * policy-mediated by the storage_ingest capability grant.
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

// Hostcall with JSON meta + N binary segments; returns the response envelope.
std::vector<uint8_t> hostcall(const char* op, const std::string& payload_json,
                              const std::vector<std::pair<const uint8_t*, uint32_t>>& segments) {
    size_t total = 4 + payload_json.size() + 4;
    for (const auto& seg : segments) total += 4 + seg.second;
    std::vector<uint8_t> req(total, 0);
    size_t off = 0;
    write_u32le(req.data() + off, static_cast<uint32_t>(payload_json.size()));
    off += 4;
    std::memcpy(req.data() + off, payload_json.data(), payload_json.size());
    off += payload_json.size();
    write_u32le(req.data() + off, static_cast<uint32_t>(segments.size()));
    off += 4;
    for (const auto& seg : segments) {
        write_u32le(req.data() + off, seg.second);
        off += 4;
        if (seg.second > 0) std::memcpy(req.data() + off, seg.first, seg.second);
        off += seg.second;
    }
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

}  // namespace

extern "C" {

int ingest(void) {
    const plugin_input_frame_t* meta_frame = frame_for("meta");
    if (!meta_frame || !meta_frame->payload || meta_frame->payload_length == 0) {
        plugin_set_error("missing-meta-frame", "ingest requires the meta JSON frame.");
        return 400;
    }
    const plugin_input_frame_t* records_frame = frame_for("records");
    if (!records_frame || !records_frame->payload || records_frame->payload_length == 0) {
        plugin_set_error("missing-records-frame", "ingest requires the records stream frame.");
        return 400;
    }
    const plugin_input_frame_t* raw_frame = frame_for("raw");  // optional

    std::string meta(reinterpret_cast<const char*>(meta_frame->payload),
                     meta_frame->payload_length);
    if (meta.empty() || meta.back() != '}') {
        plugin_set_error("invalid-meta", "meta frame is not a JSON object.");
        return 400;
    }

    // Rewrite binary references into the meta: records is segment 0; when
    // BOTH raw bytes and archive naming are present, archive.raw is
    // segment 1. Archive naming without raw bytes is stripped (nothing to
    // archive); raw bytes without naming are ignored.
    const std::string archive = json_object_slice(meta, "archive");
    const bool has_raw = raw_frame && raw_frame->payload && raw_frame->payload_length > 0;
    std::string rewritten = meta;
    if (!archive.empty()) {
        const size_t pos = rewritten.find(archive);
        if (pos != std::string::npos) {
            if (has_raw) {
                std::string patched = archive;
                patched.insert(patched.size() - 1, ",\"raw\":{\"$bin\":1}");
                rewritten = rewritten.substr(0, pos) + patched +
                            rewritten.substr(pos + archive.size());
            } else {
                // Remove ,"archive":{...} (or leading occurrence) safely.
                size_t key_pos = rewritten.rfind("\"archive\"", pos);
                size_t start = key_pos;
                if (start > 0 && rewritten[start - 1] == ',') start--;
                rewritten = rewritten.substr(0, start) +
                            rewritten.substr(pos + archive.size());
            }
        }
    }
    rewritten.insert(rewritten.size() - 1, ",\"records\":{\"$bin\":0}");

    std::vector<std::pair<const uint8_t*, uint32_t>> segments;
    segments.emplace_back(records_frame->payload, records_frame->payload_length);
    if (!archive.empty() && has_raw) {
        segments.emplace_back(raw_frame->payload, raw_frame->payload_length);
    }

    const std::vector<uint8_t> env = hostcall("storage.ingest_with_source", rewritten, segments);
    const std::string response_meta = envelope_meta_json(env);
    if (response_meta.find("\"ok\":true") == std::string::npos) {
        std::string message = json_string_field(response_meta, "message");
        if (message.empty()) message = "storage.ingest_with_source hostcall failed.";
        plugin_set_error("ingest-failed", message.c_str());
        return 502;
    }
    std::string result = json_object_slice(response_meta, "result");
    if (result.empty()) result = "{}";

    const int32_t pushed = plugin_push_output_ex(
        "result", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
        reinterpret_cast<const uint8_t*>(result.data()), static_cast<uint32_t>(result.size()));
    return pushed < 0 ? 500 : 0;
}

}  // extern "C"
