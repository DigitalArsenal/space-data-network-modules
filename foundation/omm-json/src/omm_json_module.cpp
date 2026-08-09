/*
 * foundation/omm-json (loop C.3b).
 *
 * Single-purpose flow node: ALIGNED size-prefixed $OMM FlatBuffer stream in
 * (concatenated [u32le length][$OMM buffer] frames — the verbatim output of
 * data-source/retrieval omm_bulk), one JSON frame out:
 *
 *   [ {<the ENTIRE OMM record: every scalar/string field of the $OMM table
 *      with property names EXACTLY matching the spacedatastandards.org IDL
 *      capitalization (NORAD_CAT_ID, MEAN_MOTION, BSTAR, …); enums as their
 *      CCSDS names; absent strings as null; COVARIANCE only when present>},
 *     ... ]
 *
 * HARD RULE (user 2026-07-06, memory json-schema-capitalization-rule):
 * SDS-record JSON property names match the schema/OMM/main.fbs field names
 * EXACTLY — never lowercased. To make drift impossible, every key below is
 * derived from the generated accessor name via the preprocessor (#FIELD):
 * the accessor names ARE the IDL field names, so a hand-typed key cannot
 * diverge from the schema. The sdk_compat suite additionally cross-checks
 * the emitted keys against schema/OMM/main.fbs, so a schema rename fails
 * the build instead of drifting silently.
 *
 * A BARE top-level array: the JSON surface is the same record stream as the
 * flatbuffer format in a different encoding, with metadata (record count,
 * etag) in HTTP headers — never a body envelope. The original 7-field
 * projection (norad/name/id/epoch/mm/ecc/inc) shipped a subset and consumers
 * initializing SGP4 from the JSON surface lost BSTAR/MEAN_MOTION_DOT — the
 * full record is the contract now.
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
// `encode` turns ONE record stream into ONE JSON document, and its `json`
// output feeds a single-stream consumer (foundation/http-respond's `body`), so
// there is no N-in/N-out reading available to it: a second stream frame has
// nowhere to go. It is refused rather than dropped.
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

// encode: size-prefixed $OMM stream -> BARE top-level JSON array of records.
// The JSON surface is the same record stream as the flatbuffer format in a
// different encoding: metadata (record count, etag) travels in HTTP headers,
// never in a body envelope. The {"records":[...],"count":N} wrapper was
// legacy-contract reproduction from C.3d; the legacy handler is dead.
int encode(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

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

    std::string json = "[";
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
        json += "{";
        // SCHEMA-EXACT keys, derived from the generated accessor names via
        // the preprocessor (see the file header): #FIELD stringizes the same
        // identifier the accessor call compiles against, so the JSON key and
        // the schema field name cannot diverge.
        bool first_field = true;
        const auto field_key = [&](const char* name) {
            if (!first_field) json += ",";
            first_field = false;
            json += "\"";
            json += name;
            json += "\":";
        };
#define OMM_JSON_STRING(FIELD)                       \
    do {                                             \
        field_key(#FIELD);                           \
        append_string_or_null(&json, omm->FIELD()); \
    } while (0)
#define OMM_JSON_DOUBLE(FIELD)              \
    do {                                    \
        field_key(#FIELD);                  \
        json += format_double(omm->FIELD()); \
    } while (0)
#define OMM_JSON_UINT(FIELD)                                    \
    do {                                                        \
        field_key(#FIELD);                                      \
        char uint_buf[16];                                      \
        std::snprintf(uint_buf, sizeof(uint_buf), "%u", omm->FIELD()); \
        json += uint_buf;                                       \
    } while (0)
#define OMM_JSON_ENUM(FIELD, ENUM_NAME_FN)   \
    do {                                     \
        field_key(#FIELD);                   \
        json += "\"";                        \
        json += ENUM_NAME_FN(omm->FIELD()); \
        json += "\"";                        \
    } while (0)
        OMM_JSON_UINT(NORAD_CAT_ID);
        OMM_JSON_STRING(OBJECT_NAME);
        OMM_JSON_STRING(OBJECT_ID);
        OMM_JSON_STRING(EPOCH);
        OMM_JSON_DOUBLE(MEAN_MOTION);
        OMM_JSON_DOUBLE(ECCENTRICITY);
        OMM_JSON_DOUBLE(INCLINATION);
        // Full OMM record from here (the 7 keys above keep their original
        // positions for existing consumers).
        OMM_JSON_DOUBLE(RA_OF_ASC_NODE);
        OMM_JSON_DOUBLE(ARG_OF_PERICENTER);
        OMM_JSON_DOUBLE(MEAN_ANOMALY);
        OMM_JSON_DOUBLE(BSTAR);
        OMM_JSON_DOUBLE(MEAN_MOTION_DOT);
        OMM_JSON_DOUBLE(MEAN_MOTION_DDOT);
        OMM_JSON_UINT(ELEMENT_SET_NO);
        OMM_JSON_DOUBLE(REV_AT_EPOCH);
        OMM_JSON_STRING(CLASSIFICATION_TYPE);
        OMM_JSON_ENUM(EPHEMERIS_TYPE, EnumNameephemerisFormat);
        OMM_JSON_DOUBLE(CCSDS_OMM_VERS);
        OMM_JSON_STRING(CREATION_DATE);
        OMM_JSON_STRING(ORIGINATOR);
        OMM_JSON_STRING(CENTER_NAME);
        // REFERENCE_FRAME / COV_REFERENCE_FRAME are RFM union tables (no
        // JSON-trivial form; never populated by the ingest paths) — omitted.
        OMM_JSON_STRING(REFERENCE_FRAME_EPOCH);
        OMM_JSON_ENUM(TIME_SYSTEM, EnumNametimingStandard);
        OMM_JSON_ENUM(MEAN_ELEMENT_THEORY, EnumNamemeanElementSource);
        OMM_JSON_STRING(COMMENT);
        OMM_JSON_DOUBLE(SEMI_MAJOR_AXIS);
        OMM_JSON_DOUBLE(GM);
        OMM_JSON_DOUBLE(MASS);
        OMM_JSON_DOUBLE(SOLAR_RAD_AREA);
        OMM_JSON_DOUBLE(SOLAR_RAD_COEFF);
        OMM_JSON_DOUBLE(DRAG_AREA);
        OMM_JSON_DOUBLE(DRAG_COEFF);
        if (const auto* cov = omm->COVARIANCE()) {
            field_key("COVARIANCE");
            json += "[";
            for (::flatbuffers::uoffset_t i = 0; i < cov->size(); ++i) {
                if (i > 0) json += ",";
                json += format_double(cov->Get(i));
            }
            json += "]";
        }
        OMM_JSON_UINT(USER_DEFINED_BIP_0044_TYPE);
        OMM_JSON_STRING(USER_DEFINED_OBJECT_DESIGNATOR);
        OMM_JSON_STRING(USER_DEFINED_EARTH_MODEL);
        OMM_JSON_DOUBLE(USER_DEFINED_EPOCH_TIMESTAMP);
        OMM_JSON_DOUBLE(USER_DEFINED_MICROSECONDS);
#undef OMM_JSON_STRING
#undef OMM_JSON_DOUBLE
#undef OMM_JSON_UINT
#undef OMM_JSON_ENUM
        json += "}";
        count++;
    }

    json += "]";

    const int32_t pushed = plugin_push_output_ex(
        "json", nullptr, nullptr,
        PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr,
        0, 1,
        reinterpret_cast<const uint8_t*>(json.data()),
        static_cast<uint32_t>(json.size()));
    return pushed < 0 ? 500 : 0;
}

}  // extern "C"
