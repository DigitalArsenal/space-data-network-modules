// data-source/gp-archive-records: builds the GP archive's $MPE and $CAT records
// in ARCHIVE ENCODING V1, the byte layout the archive's content IDs depend on.
//
// build_mpe: field batch of element sets -> aligned size-prefixed $MPE stream
// build_cat: field batch of catalog rows -> aligned size-prefixed $CAT stream
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
// add_<FIELD> (which carries the slot). A name that is not a generated field
// does not compile.
//
// INPUT: one "field batch" frame on port "records" (all integers little-endian):
//   "GPAF" | u16 version = 1 | u16 field_count
//   field_count x { u8 name_length | name }   SDS field names, any order
//   u32 record_count
//   record_count x, per field in header order:
//     string field: u32 byte_length | bytes   (bytes kept exactly)
//     double field: 8 bytes, IEEE-754 binary64 (exact, negative zero included)
//     uint32 field: 4 bytes
// The header must name every field of the record exactly once. Values travel
// as their bits, so nothing is re-parsed or rounded on the way in.
//
// Output bytes depend only on the input bytes.

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"

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

enum FieldKind : uint8_t { kString, kDouble, kUint32 };

struct FieldSpec {
    const char* name;
    FieldKind kind;
};

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

// &MPE::FIELD / &CAT::FIELD bind each name to a generated accessor.
#define GP_ARCHIVE_MPE_STRING(FIELD) {(static_cast<void>(&MPE::FIELD), #FIELD), kString},
#define GP_ARCHIVE_MPE_DOUBLE(FIELD) {(static_cast<void>(&MPE::FIELD), #FIELD), kDouble},
#define GP_ARCHIVE_MPE_UINT32(FIELD) {(static_cast<void>(&MPE::FIELD), #FIELD), kUint32},
const FieldSpec kMpeFields[] = {GP_ARCHIVE_V1_MPE_FIELDS(GP_ARCHIVE_MPE_STRING, GP_ARCHIVE_MPE_DOUBLE, GP_ARCHIVE_MPE_UINT32)};
#define GP_ARCHIVE_CAT_STRING(FIELD) {(static_cast<void>(&CAT::FIELD), #FIELD), kString},
#define GP_ARCHIVE_CAT_DOUBLE(FIELD) {(static_cast<void>(&CAT::FIELD), #FIELD), kDouble},
#define GP_ARCHIVE_CAT_UINT32(FIELD) {(static_cast<void>(&CAT::FIELD), #FIELD), kUint32},
const FieldSpec kCatFields[] = {GP_ARCHIVE_V1_CAT_FIELDS(GP_ARCHIVE_CAT_STRING, GP_ARCHIVE_CAT_DOUBLE, GP_ARCHIVE_CAT_UINT32)};

// ---------------------------------------------------------------------------
// Field batch reader.
// ---------------------------------------------------------------------------

struct Cursor {
    const uint8_t* p = nullptr;
    const uint8_t* end = nullptr;

    bool take(size_t n, const uint8_t** out) {
        if (static_cast<size_t>(end - p) < n) return false;
        *out = p;
        p += n;
        return true;
    }
    bool u8(uint8_t* v) {
        const uint8_t* b;
        if (!take(1, &b)) return false;
        *v = b[0];
        return true;
    }
    bool u16(uint16_t* v) {
        const uint8_t* b;
        if (!take(2, &b)) return false;
        *v = static_cast<uint16_t>(b[0] | (b[1] << 8));
        return true;
    }
    bool u32(uint32_t* v) {
        const uint8_t* b;
        if (!take(4, &b)) return false;
        *v = static_cast<uint32_t>(b[0]) | (static_cast<uint32_t>(b[1]) << 8) |
             (static_cast<uint32_t>(b[2]) << 16) | (static_cast<uint32_t>(b[3]) << 24);
        return true;
    }
    bool f64(double* v) {
        const uint8_t* b;
        if (!take(8, &b)) return false;
        std::memcpy(v, b, 8);  // wasm is little-endian
        return true;
    }
};

// Header columns mapped to record fields; returns an error or empty.
std::string read_header(Cursor* c, const FieldSpec* fields, int field_count, std::vector<int>* columns,
                        uint32_t* record_count) {
    const uint8_t* magic;
    if (!c->take(4, &magic) || std::memcmp(magic, "GPAF", 4) != 0) return "not a GPAF field batch";
    uint16_t version = 0, count = 0;
    if (!c->u16(&version) || version != 1) return "unsupported field batch version";
    if (!c->u16(&count)) return "truncated header";
    std::vector<bool> seen(static_cast<size_t>(field_count), false);
    columns->clear();
    for (uint16_t i = 0; i < count; i++) {
        uint8_t len = 0;
        const uint8_t* name;
        if (!c->u8(&len) || !c->take(len, &name)) return "truncated header";
        int match = -1;
        for (int f = 0; f < field_count; f++) {
            if (std::strlen(fields[f].name) == len && std::memcmp(fields[f].name, name, len) == 0) {
                match = f;
                break;
            }
        }
        const std::string field(reinterpret_cast<const char*>(name), len);
        if (match < 0) return "unknown field " + field;
        if (seen[static_cast<size_t>(match)]) return "duplicate field " + field;
        seen[static_cast<size_t>(match)] = true;
        columns->push_back(match);
    }
    for (int f = 0; f < field_count; f++) {
        if (!seen[static_cast<size_t>(f)]) return std::string("missing field ") + fields[f].name;
    }
    if (!c->u32(record_count)) return "truncated header";
    return {};
}

bool read_record(Cursor* c, const FieldSpec* fields, const std::vector<int>& columns, Value* values) {
    for (const int f : columns) {
        Value& v = values[f];
        switch (fields[f].kind) {
            case kString: {
                const uint8_t* bytes;
                if (!c->u32(&v.len) || !c->take(v.len, &bytes)) return false;
                v.str = reinterpret_cast<const char*>(bytes);
                break;
            }
            case kDouble:
                if (!c->f64(&v.d)) return false;
                break;
            case kUint32:
                if (!c->u32(&v.u)) return false;
                break;
        }
    }
    return true;
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
    mpe.add_MEAN_ELEMENT_THEORY(meanElementSource::SGP4);
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

using BuildFn = void (*)(::flatbuffers::FlatBufferBuilder*, const Value*);

int build(const char* method, const FieldSpec* fields, int field_count, BuildFn build_record,
          const char* schema, const char* identifier, const char* root) {
    char message[256];
    if (find_batched_input_port(message, sizeof(message))) {
        plugin_set_error("batched-input-frames", message);
        return 500;
    }
    const int32_t input_index = plugin_find_input_index("records", 0);
    const plugin_input_frame_t* frame =
        input_index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(input_index)) : nullptr;
    if (!frame) {
        std::snprintf(message, sizeof(message), "%s requires a field batch frame on port \"records\".",
                      method);
        plugin_set_error("missing-records-frame", message);
        return 400;
    }
    Cursor c;
    c.p = frame->payload;
    c.end = c.p + (frame->payload ? frame->payload_length : 0u);

    std::vector<int> columns;
    uint32_t record_count = 0;
    const std::string header_error = read_header(&c, fields, field_count, &columns, &record_count);
    if (!header_error.empty()) {
        plugin_set_error("invalid-field-batch", header_error.c_str());
        return 400;
    }
    std::vector<Value> values(static_cast<size_t>(field_count));
    std::vector<uint8_t> stream;
    ::flatbuffers::FlatBufferBuilder builder(256);
    for (uint32_t i = 0; i < record_count; i++) {
        if (!read_record(&c, fields, columns, values.data())) {
            std::snprintf(message, sizeof(message), "%s record %u is truncated.", schema,
                          static_cast<unsigned>(i));
            plugin_set_error("invalid-field-batch", message);
            return 400;
        }
        build_record(&builder, values.data());
        append_frame(&stream, builder);
    }
    if (c.p != c.end) {
        plugin_set_error("invalid-field-batch", "Trailing bytes after the last record.");
        return 400;
    }
    if (plugin_push_output_ex("records", schema, identifier, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,
                              root, 0, 8, stream.data(), static_cast<uint32_t>(stream.size())) < 0) {
        return 500;
    }
    return 0;
}

}  // namespace

extern "C" {

int build_mpe(void) {
    return build("build_mpe", kMpeFields, kMpeFieldCount, build_mpe_v1, "MPE.fbs", "$MPE", "MPE");
}

int build_cat(void) {
    return build("build_cat", kCatFields, kCatFieldCount, build_cat_v1, "CAT.fbs", "$CAT", "CAT");
}

}  // extern "C"
