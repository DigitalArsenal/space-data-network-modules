/*
 * foundation/omm-json (loop C.3b).
 *
 * Single-purpose flow node: ALIGNED size-prefixed $OMM FlatBuffer stream in
 * (concatenated [u32le length][$OMM buffer] frames — the verbatim output of
 * data-source/retrieval omm_bulk), one JSON frame out:
 *
 *   {"records":[{<the ENTIRE OMM record: every scalar/string field of the
 *                 $OMM table in lowercase snake_case; enums as their CCSDS
 *                 names; absent strings as null; covariance only when
 *                 present>}, ...],"count":N}
 *
 * The original 7-field projection (norad/name/id/epoch/mm/ecc/inc) shipped a
 * subset and consumers initializing SGP4 from the JSON surface lost
 * BSTAR/MEAN_MOTION_DOT — the full record is the contract now.
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
        // Copy [u32le size][frame] together. FlatBuffers built size-prefixed
        // (the store/engine wire contract: internal alignment counts the
        // 4-byte prefix, so 8-byte scalars are aligned only WITH it) verify
        // and decode at scratch+0 via the size-prefixed accessors. Frames
        // built without a prefix align at offset 0 instead — for those,
        // re-anchor the frame body at the front and use the plain accessors.
        scratch.assign(data + offset - 4, data + offset + frame_size);
        offset += frame_size;

        const OMM* omm = nullptr;
        if (frame_size >= 8) {
            ::flatbuffers::Verifier prefixed_verifier(scratch.data(), scratch.size());
            if (VerifySizePrefixedOMMBuffer(prefixed_verifier)) {
                omm = GetSizePrefixedOMM(scratch.data());
            } else {
                scratch.erase(scratch.begin(), scratch.begin() + 4);
                ::flatbuffers::Verifier plain_verifier(scratch.data(), scratch.size());
                if (OMMBufferHasIdentifier(scratch.data()) && VerifyOMMBuffer(plain_verifier)) {
                    omm = GetOMM(scratch.data());
                }
            }
        }
        if (!omm) {
            plugin_set_error("invalid-omm-frame",
                             "Stream frame is not a valid $OMM FlatBuffer.");
            return 400;
        }

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
        // Full OMM record from here (the 7 keys above keep their original
        // positions for existing consumers).
        json += ",\"ra_of_asc_node\":" + format_double(omm->RA_OF_ASC_NODE());
        json += ",\"arg_of_pericenter\":" + format_double(omm->ARG_OF_PERICENTER());
        json += ",\"mean_anomaly\":" + format_double(omm->MEAN_ANOMALY());
        json += ",\"bstar\":" + format_double(omm->BSTAR());
        json += ",\"mean_motion_dot\":" + format_double(omm->MEAN_MOTION_DOT());
        json += ",\"mean_motion_ddot\":" + format_double(omm->MEAN_MOTION_DDOT());
        {
            char buf[16];
            std::snprintf(buf, sizeof(buf), "%u", omm->ELEMENT_SET_NO());
            json += ",\"element_set_no\":";
            json += buf;
        }
        json += ",\"rev_at_epoch\":" + format_double(omm->REV_AT_EPOCH());
        json += ",\"classification_type\":";
        append_string_or_null(&json, omm->CLASSIFICATION_TYPE());
        json += ",\"ephemeris_type\":\"";
        json += EnumNameephemerisFormat(omm->EPHEMERIS_TYPE());
        json += "\"";
        json += ",\"ccsds_omm_vers\":" + format_double(omm->CCSDS_OMM_VERS());
        json += ",\"creation_date\":";
        append_string_or_null(&json, omm->CREATION_DATE());
        json += ",\"originator\":";
        append_string_or_null(&json, omm->ORIGINATOR());
        json += ",\"center_name\":";
        append_string_or_null(&json, omm->CENTER_NAME());
        // REFERENCE_FRAME / COV_REFERENCE_FRAME are RFM union tables (no
        // JSON-trivial form; never populated by the ingest paths) — omitted.
        json += ",\"reference_frame_epoch\":";
        append_string_or_null(&json, omm->REFERENCE_FRAME_EPOCH());
        json += ",\"time_system\":\"";
        json += EnumNametimingStandard(omm->TIME_SYSTEM());
        json += "\"";
        json += ",\"mean_element_theory\":\"";
        json += EnumNamemeanElementSource(omm->MEAN_ELEMENT_THEORY());
        json += "\"";
        json += ",\"comment\":";
        append_string_or_null(&json, omm->COMMENT());
        json += ",\"semi_major_axis\":" + format_double(omm->SEMI_MAJOR_AXIS());
        json += ",\"gm\":" + format_double(omm->GM());
        json += ",\"mass\":" + format_double(omm->MASS());
        json += ",\"solar_rad_area\":" + format_double(omm->SOLAR_RAD_AREA());
        json += ",\"solar_rad_coeff\":" + format_double(omm->SOLAR_RAD_COEFF());
        json += ",\"drag_area\":" + format_double(omm->DRAG_AREA());
        json += ",\"drag_coeff\":" + format_double(omm->DRAG_COEFF());
        if (const auto* cov = omm->COVARIANCE()) {
            json += ",\"covariance\":[";
            for (::flatbuffers::uoffset_t i = 0; i < cov->size(); ++i) {
                if (i > 0) json += ",";
                json += format_double(cov->Get(i));
            }
            json += "]";
        }
        json += ",\"user_defined_epoch_timestamp\":" +
                format_double(omm->USER_DEFINED_EPOCH_TIMESTAMP());
        json += ",\"user_defined_microseconds\":" +
                format_double(omm->USER_DEFINED_MICROSECONDS());
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
