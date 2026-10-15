// data-source/gp-archive-records: builds the GP archive's $MPE and $CAT records
// in ARCHIVE ENCODING V1, the byte layout the archive's content IDs depend on.
//
// build_mpe: $MPE record stream -> $MPE stream in archive encoding v1
// build_cat: $CAT record stream -> $CAT stream in archive encoding v1
//
// A content ID is sha256 over the record bytes, so the archive's ~101M element
// sets are identified by this exact layout. FlatBuffers leaves the layout to the
// builder: the same values added in a different order (or with default values
// omitted) give different bytes and so a different ID. The archive's records
// were written by the importer's original Go builder; this module reproduces
// that builder's order with the schema-generated C++ builders.
//
// ARCHIVE ENCODING V1 (compatibility contract; see README.md):
//   $MPE  CreateString(ENTITY_ID), then add ENTITY_ID, EPOCH, MEAN_MOTION,
//         ECCENTRICITY, INCLINATION, RA_OF_ASC_NODE, ARG_OF_PERICENTER,
//         MEAN_ANOMALY, BSTAR, MEAN_ELEMENT_THEORY (= SGP4), every field
//         written even when it equals the schema default (zero eccentricity,
//         zero BSTAR and SGP4 are stored, not omitted); size-prefixed, "$MPE".
//   $CAT  CreateString(OBJECT_ID), CreateString(OBJECT_NAME), then add
//         OBJECT_ID, NORAD_CAT_ID, OBJECT_NAME with defaults omitted (a zero
//         NORAD_CAT_ID is absent); size-prefixed, "$CAT".
//
// Field names and vtable slots come only from the generated SDS headers: each
// record's fields are listed once in an X-macro that both stringizes the name
// (matched against the input's field names) and calls the generated
// add_<FIELD> / accessor / VT_<FIELD> (which carry the slot). A name that is
// not a generated field does not compile.
//
// INPUT: one size-prefixed record stream on port "records": build_mpe takes
// $MPE, build_cat takes $CAT (concatenated [u32le length][buffer] frames;
// zero-length prefixes are padding, so 8-aligned streams and unpadded ones both
// read). Each input record is verified (identifier included) and its values
// are read in place through the generated accessors, then re-built in archive
// encoding v1. Values travel as FlatBuffers stores them (strings as bytes,
// doubles as IEEE-754 bits), so nothing is formatted or rounded on the way.
//   $MPE in: ENTITY_ID..BSTAR must all be PRESENT in the record (write it
//            with force-defaults: an omitted 0.0 cannot be told from -0.0);
//            MEAN_ELEMENT_THEORY, if present, must be SGP4; any other field
//            (TARGETER) is refused, since archive v1 cannot carry it.
//   $CAT in: OBJECT_ID and OBJECT_NAME must be present; NORAD_CAT_ID may be
//            absent (= 0, which v1 omits anyway); any other field is refused.
// A malformed stream or record refuses the whole batch.
//
// Output bytes depend only on the input bytes.

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"

#include "SDS_ARCHIVE_HEADERS.h"  // replaced by build.mjs with the SDS MET/MPE/IDM/PLD/LCC/CAT headers

namespace {

// Archive encoding v1 field lists, in the order the fields are added.
#define GP_ARCHIVE_V1_MPE_FIELDS(STRING, DOUBLE, UINT32) \
    STRING(ENTITY_ID)                                    \
    DOUBLE(EPOCH)                                        \
    DOUBLE(MEAN_MOTION)                                  \
    DOUBLE(ECCENTRICITY)                                 \
    DOUBLE(INCLINATION)                                  \
    DOUBLE(RA_OF_ASC_NODE)                               \
    DOUBLE(ARG_OF_PERICENTER)                            \
    DOUBLE(MEAN_ANOMALY)                                 \
    DOUBLE(BSTAR)

#define GP_ARCHIVE_V1_CAT_FIELDS(STRING, DOUBLE, UINT32) \
    STRING(OBJECT_ID)                                    \
    UINT32(NORAD_CAT_ID)                                 \
    STRING(OBJECT_NAME)

struct Value {
    const char* str = nullptr;
    uint32_t len = 0;
    double d = 0.0;
    uint32_t u = 0;
};

#define GP_ARCHIVE_ENUM(FIELD) kMpe_##FIELD,
enum MpeField { GP_ARCHIVE_V1_MPE_FIELDS(GP_ARCHIVE_ENUM, GP_ARCHIVE_ENUM, GP_ARCHIVE_ENUM) kMpeFieldCount };
#undef GP_ARCHIVE_ENUM
#define GP_ARCHIVE_ENUM(FIELD) kCat_##FIELD,
enum CatField { GP_ARCHIVE_V1_CAT_FIELDS(GP_ARCHIVE_ENUM, GP_ARCHIVE_ENUM, GP_ARCHIVE_ENUM) kCatFieldCount };
#undef GP_ARCHIVE_ENUM

// ---------------------------------------------------------------------------
// Input record readers (generated accessors, read in place).
// ---------------------------------------------------------------------------

bool present(const ::flatbuffers::Table* t, ::flatbuffers::voffset_t slot) {
    return t->GetOptionalFieldOffset(slot) != 0;
}

// Every vtable slot the record sets must be in `allowed`; returns the first
// other slot's index, or -1.
int unexpected_slot(const ::flatbuffers::Table* t, const ::flatbuffers::voffset_t* allowed, size_t allowed_count) {
    const uint8_t* vtable = t->GetVTable();
    const uint16_t vsize = ::flatbuffers::ReadScalar<uint16_t>(vtable);
    for (uint16_t at = 4; at + 2 <= vsize; at = static_cast<uint16_t>(at + 2)) {
        if (::flatbuffers::ReadScalar<uint16_t>(vtable + at) == 0) continue;
        bool ok = false;
        for (size_t i = 0; i < allowed_count; i++) ok = ok || allowed[i] == at;
        if (!ok) return (at - 4) / 2;
    }
    return -1;
}

std::string read_mpe(const uint8_t* frame, size_t size, Value* v) {
    ::flatbuffers::Verifier verifier(frame, size, 64, 1000000, false);
    if (!VerifySizePrefixedMPEBuffer(verifier)) return "is not a verifiable size-prefixed $MPE buffer";
    const MPE* mpe = GetSizePrefixedMPE(frame);
    const auto* t = reinterpret_cast<const ::flatbuffers::Table*>(mpe);
#define GP_ARCHIVE_REQUIRE(FIELD) \
    if (!present(t, MPE::VT_##FIELD)) return "lacks " #FIELD " (archive v1 needs every field written)";
    GP_ARCHIVE_V1_MPE_FIELDS(GP_ARCHIVE_REQUIRE, GP_ARCHIVE_REQUIRE, GP_ARCHIVE_REQUIRE)
#undef GP_ARCHIVE_REQUIRE
#define GP_ARCHIVE_SLOT(FIELD) MPE::VT_##FIELD,
    const ::flatbuffers::voffset_t allowed[] = {
        GP_ARCHIVE_V1_MPE_FIELDS(GP_ARCHIVE_SLOT, GP_ARCHIVE_SLOT, GP_ARCHIVE_SLOT) MPE::VT_MEAN_ELEMENT_THEORY};
#undef GP_ARCHIVE_SLOT
    const int extra = unexpected_slot(t, allowed, sizeof(allowed) / sizeof(allowed[0]));
    if (extra >= 0) return "sets field slot " + std::to_string(extra) + ", which archive v1 does not carry";
    if (mpe->MEAN_ELEMENT_THEORY() != meanElementSource_SGP4) return "has MEAN_ELEMENT_THEORY other than SGP4";
#define GP_ARCHIVE_GET_STRING(FIELD) \
    v[kMpe_##FIELD].str = mpe->FIELD()->c_str();     \
    v[kMpe_##FIELD].len = mpe->FIELD()->size();
#define GP_ARCHIVE_GET_DOUBLE(FIELD) v[kMpe_##FIELD].d = mpe->FIELD();
#define GP_ARCHIVE_GET_UINT32(FIELD) v[kMpe_##FIELD].u = mpe->FIELD();
    GP_ARCHIVE_V1_MPE_FIELDS(GP_ARCHIVE_GET_STRING, GP_ARCHIVE_GET_DOUBLE, GP_ARCHIVE_GET_UINT32)
#undef GP_ARCHIVE_GET_STRING
#undef GP_ARCHIVE_GET_DOUBLE
#undef GP_ARCHIVE_GET_UINT32
    return {};
}

std::string read_cat(const uint8_t* frame, size_t size, Value* v) {
    ::flatbuffers::Verifier verifier(frame, size, 64, 1000000, false);
    if (!VerifySizePrefixedCATBuffer(verifier)) return "is not a verifiable size-prefixed $CAT buffer";
    const CAT* cat = GetSizePrefixedCAT(frame);
    const auto* t = reinterpret_cast<const ::flatbuffers::Table*>(cat);
    if (!present(t, CAT::VT_OBJECT_ID)) return "lacks OBJECT_ID";
    if (!present(t, CAT::VT_OBJECT_NAME)) return "lacks OBJECT_NAME";
#define GP_ARCHIVE_SLOT(FIELD) CAT::VT_##FIELD,
    const ::flatbuffers::voffset_t allowed[] = {GP_ARCHIVE_V1_CAT_FIELDS(GP_ARCHIVE_SLOT, GP_ARCHIVE_SLOT, GP_ARCHIVE_SLOT)};
#undef GP_ARCHIVE_SLOT
    const int extra = unexpected_slot(t, allowed, sizeof(allowed) / sizeof(allowed[0]));
    if (extra >= 0) return "sets field slot " + std::to_string(extra) + ", which archive v1 does not carry";
#define GP_ARCHIVE_GET_STRING(FIELD) \
    v[kCat_##FIELD].str = cat->FIELD()->c_str();     \
    v[kCat_##FIELD].len = cat->FIELD()->size();
#define GP_ARCHIVE_GET_DOUBLE(FIELD) v[kCat_##FIELD].d = cat->FIELD();
#define GP_ARCHIVE_GET_UINT32(FIELD) v[kCat_##FIELD].u = cat->FIELD();
    GP_ARCHIVE_V1_CAT_FIELDS(GP_ARCHIVE_GET_STRING, GP_ARCHIVE_GET_DOUBLE, GP_ARCHIVE_GET_UINT32)
#undef GP_ARCHIVE_GET_STRING
#undef GP_ARCHIVE_GET_DOUBLE
#undef GP_ARCHIVE_GET_UINT32
    return {};
}

// ---------------------------------------------------------------------------
// Archive encoding v1 builders.
// ---------------------------------------------------------------------------

void build_mpe_v1(::flatbuffers::FlatBufferBuilder* b, const Value* v) {
    b->Clear();
    b->ForceDefaults(true);
#define GP_ARCHIVE_CREATE(FIELD) \
    const auto FIELD##_offset = b->CreateString(v[kMpe_##FIELD].str, v[kMpe_##FIELD].len);
#define GP_ARCHIVE_NONE(FIELD)
    GP_ARCHIVE_V1_MPE_FIELDS(GP_ARCHIVE_CREATE, GP_ARCHIVE_NONE, GP_ARCHIVE_NONE)
    MPEBuilder mpe(*b);
#define GP_ARCHIVE_ADD_OFFSET(FIELD) mpe.add_##FIELD(FIELD##_offset);
#define GP_ARCHIVE_ADD_DOUBLE(FIELD) mpe.add_##FIELD(v[kMpe_##FIELD].d);
#define GP_ARCHIVE_ADD_UINT32(FIELD) mpe.add_##FIELD(v[kMpe_##FIELD].u);
    GP_ARCHIVE_V1_MPE_FIELDS(GP_ARCHIVE_ADD_OFFSET, GP_ARCHIVE_ADD_DOUBLE, GP_ARCHIVE_ADD_UINT32)
#undef GP_ARCHIVE_ADD_OFFSET
#undef GP_ARCHIVE_ADD_DOUBLE
#undef GP_ARCHIVE_ADD_UINT32
    mpe.add_MEAN_ELEMENT_THEORY(meanElementSource_SGP4);
    FinishSizePrefixedMPEBuffer(*b, mpe.Finish());
}

void build_cat_v1(::flatbuffers::FlatBufferBuilder* b, const Value* v) {
    b->Clear();
    b->ForceDefaults(false);
#define GP_ARCHIVE_CREATE_CAT(FIELD) \
    const auto FIELD##_offset = b->CreateString(v[kCat_##FIELD].str, v[kCat_##FIELD].len);
    GP_ARCHIVE_V1_CAT_FIELDS(GP_ARCHIVE_CREATE_CAT, GP_ARCHIVE_NONE, GP_ARCHIVE_NONE)
    CATBuilder cat(*b);
#define GP_ARCHIVE_ADD_OFFSET(FIELD) cat.add_##FIELD(FIELD##_offset);
#define GP_ARCHIVE_ADD_DOUBLE(FIELD) cat.add_##FIELD(v[kCat_##FIELD].d);
#define GP_ARCHIVE_ADD_UINT32(FIELD) cat.add_##FIELD(v[kCat_##FIELD].u);
    GP_ARCHIVE_V1_CAT_FIELDS(GP_ARCHIVE_ADD_OFFSET, GP_ARCHIVE_ADD_DOUBLE, GP_ARCHIVE_ADD_UINT32)
#undef GP_ARCHIVE_ADD_OFFSET
#undef GP_ARCHIVE_ADD_DOUBLE
#undef GP_ARCHIVE_ADD_UINT32
    FinishSizePrefixedCATBuffer(*b, cat.Finish());
}

void append_frame(std::vector<uint8_t>* stream, const ::flatbuffers::FlatBufferBuilder& b) {
    const size_t size = b.GetSize();
    const size_t padded = (size + 7u) & ~static_cast<size_t>(7u);
    const size_t at = stream->size();
    stream->resize(at + padded, 0);
    std::memcpy(stream->data() + at, b.GetBufferPointer(), size);
}

// Refuse a surplus frame on a single-stream port instead of dropping it (see
// foundation/omm-json and graph task modules-guest-nodes-drop-batched-frames).
bool find_batched_input_port(char* message, size_t message_len) {
    const uint32_t count = plugin_get_input_count();
    for (uint32_t i = 0; i < count; i++) {
        const plugin_input_frame_t* frame = plugin_get_input_frame(i);
        if (!frame || !frame->port_id) continue;
        for (uint32_t j = 0; j < i; j++) {
            const plugin_input_frame_t* earlier = plugin_get_input_frame(j);
            if (!earlier || !earlier->port_id) continue;
            if (std::strcmp(earlier->port_id, frame->port_id) != 0) continue;
            std::snprintf(message, message_len,
                          "Single-stream input port \"%s\" carries more than one frame; the "
                          "surplus is refused rather than silently discarded.",
                          frame->port_id);
            return true;
        }
    }
    return false;
}

using ReadFn = std::string (*)(const uint8_t*, size_t, Value*);
using BuildFn = void (*)(::flatbuffers::FlatBufferBuilder*, const Value*);

int build(const char* method, int field_count, ReadFn read_record, BuildFn build_record, const char* schema,
          const char* identifier, const char* root) {
    char message[256];
    if (find_batched_input_port(message, sizeof(message))) {
        plugin_set_error("batched-input-frames", message);
        return 500;
    }
    const int32_t input_index = plugin_find_input_index("records", 0);
    const plugin_input_frame_t* frame =
        input_index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(input_index)) : nullptr;
    if (!frame) {
        std::snprintf(message, sizeof(message), "%s requires a %s record stream on port \"records\".", method,
                      identifier);
        plugin_set_error("missing-records-frame", message);
        return 400;
    }
    const uint8_t* p = frame->payload;
    const size_t n = frame->payload ? frame->payload_length : 0u;
    std::vector<Value> values(static_cast<size_t>(field_count));
    std::vector<uint8_t> stream;
    ::flatbuffers::FlatBufferBuilder builder(256);
    size_t at = 0;
    for (uint32_t i = 0; at < n;) {
        if (n - at < 4) {
            std::snprintf(message, sizeof(message), "%s stream ends in a truncated size prefix.", identifier);
            plugin_set_error("invalid-records", message);
            return 400;
        }
        uint32_t size = 0;
        std::memcpy(&size, p + at, 4);  // wasm is little-endian
        if (size == 0) {  // padding
            at += 4;
            continue;
        }
        if (n - at - 4 < size) {
            std::snprintf(message, sizeof(message), "%s record %u is truncated.", identifier, static_cast<unsigned>(i));
            plugin_set_error("invalid-records", message);
            return 400;
        }
        const std::string error = read_record(p + at, size + 4u, values.data());
        if (!error.empty()) {
            std::snprintf(message, sizeof(message), "%s record %u %s.", identifier, static_cast<unsigned>(i),
                          error.c_str());
            plugin_set_error("invalid-records", message);
            return 400;
        }
        build_record(&builder, values.data());
        append_frame(&stream, builder);
        at += 4u + size;
        i++;
    }
    if (plugin_push_output_ex("records", schema, identifier, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0,
                              stream.data(), static_cast<uint32_t>(stream.size())) < 0) {
        plugin_set_error("output-push-failed", "The records output could not be pushed.");
        return 500;
    }
    return 0;
}

}  // namespace

extern "C" {

int build_mpe(void) {
    return build("build_mpe", kMpeFieldCount, read_mpe, build_mpe_v1, "MPE.fbs", "$MPE", "MPE");
}

int build_cat(void) {
    return build("build_cat", kCatFieldCount, read_cat, build_cat_v1, "CAT.fbs", "$CAT", "CAT");
}

}  // extern "C"
