/*
 * foundation/omm-json (loop C.3b).
 *
 * Single-purpose flow node: ALIGNED size-prefixed $OMM FlatBuffer stream in
 * (concatenated [u32le length][$OMM buffer] frames — the verbatim output of
 * data-source/retrieval omm_bulk), one JSON frame out:
 *
 *   {"records":[{"norad_cat_id":...,"object_name":...,"object_id":...,
 *                "epoch":...,"mean_motion":...,"eccentricity":...,
 *                "inclination":...}, ...],"count":N}
 *
 * Pure compute — no capabilities, no hostcalls. Each frame is copied into an
 * aligned scratch buffer, identifier- and verifier-checked, then decoded via
 * the SDS OMM generated accessors (vtable offset reads against the canonical
 * OMM layout; the spacedatastandards lib/cpp/OMM/main_generated.h header is
 * prepended by build.mjs). Absent string fields serialize as JSON null;
 * doubles use %.17g round-trip formatting.
 *
 * Framing tolerance: a zero-length prefix is skipped as padding; a frame
 * that overruns the payload or fails $OMM verification fails the invoke.
 */

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"

namespace {

uint32_t read_u32le(const uint8_t* src) {
    return static_cast<uint32_t>(src[0]) | (static_cast<uint32_t>(src[1]) << 8) |
           (static_cast<uint32_t>(src[2]) << 16) | (static_cast<uint32_t>(src[3]) << 24);
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

// Round-trip double formatting: %.17g preserves the exact IEEE-754 value
// through JSON.parse on the consumer side.
std::string format_double(double value) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.17g", value);
    return std::string(buf);
}

void append_string_or_null(std::string* out, const ::flatbuffers::String* value) {
    if (value) {
        *out += "\"" + json_escape(std::string(value->c_str(), value->size())) + "\"";
    } else {
        *out += "null";
    }
}

}  // namespace

extern "C" {

// encode: size-prefixed $OMM stream -> {"records":[...],"count":N} JSON frame.
int encode(void) {
    const int32_t input_index = plugin_find_input_index("stream", 0);
    const plugin_input_frame_t* frame =
        input_index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(input_index)) : nullptr;
    if (!frame) {
        plugin_set_error("missing-stream-frame",
                         "encode requires a $OMM stream input frame on port \"stream\".");
        return 400;
    }

    const uint8_t* data = frame->payload;
    const size_t length = data ? static_cast<size_t>(frame->payload_length) : 0u;

    std::string json = "{\"records\":[";
    uint32_t count = 0;
    std::vector<uint8_t> scratch;  // Frame copy: guarantees allocator alignment for decode.
    size_t offset = 0;
    while (offset < length) {
        if (length - offset < 4) {
            plugin_set_error("malformed-stream",
                             "Trailing bytes after the last size-prefixed $OMM frame.");
            return 400;
        }
        const uint32_t frame_size = read_u32le(data + offset);
        offset += 4;
        if (frame_size == 0) {
            continue;  // Zero-length prefix: alignment padding, skip.
        }
        if (frame_size > length - offset) {
            plugin_set_error("malformed-stream",
                             "Size-prefixed $OMM frame overruns the stream payload.");
            return 400;
        }
        scratch.assign(data + offset, data + offset + frame_size);
        offset += frame_size;

        ::flatbuffers::Verifier verifier(scratch.data(), scratch.size());
        if (frame_size < 8 || !OMMBufferHasIdentifier(scratch.data()) ||
            !VerifyOMMBuffer(verifier)) {
            plugin_set_error("invalid-omm-frame",
                             "Stream frame is not a valid $OMM FlatBuffer.");
            return 400;
        }
        const OMM* omm = GetOMM(scratch.data());

        if (count > 0) json += ",";
        json += "{\"norad_cat_id\":";
        {
            char buf[16];
            std::snprintf(buf, sizeof(buf), "%u", omm->NORAD_CAT_ID());
            json += buf;
        }
        json += ",\"object_name\":";
        append_string_or_null(&json, omm->OBJECT_NAME());
        json += ",\"object_id\":";
        append_string_or_null(&json, omm->OBJECT_ID());
        json += ",\"epoch\":";
        append_string_or_null(&json, omm->EPOCH());
        json += ",\"mean_motion\":" + format_double(omm->MEAN_MOTION());
        json += ",\"eccentricity\":" + format_double(omm->ECCENTRICITY());
        json += ",\"inclination\":" + format_double(omm->INCLINATION());
        json += "}";
        count++;
    }

    json += "],\"count\":";
    {
        char buf[16];
        std::snprintf(buf, sizeof(buf), "%u", count);
        json += buf;
    }
    json += "}";

    const int32_t pushed = plugin_push_output_ex(
        "json", nullptr, nullptr,
        PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr,
        0, 1,
        reinterpret_cast<const uint8_t*>(json.data()),
        static_cast<uint32_t>(json.size()));
    return pushed < 0 ? 500 : 0;
}

}  // extern "C"
