// data-source/gp-archive-records: builds the GP archive's $MPE and $CAT records
// in ARCHIVE ENCODING V1, the byte layout the archive's content IDs depend on.
//
// build_mpe: JSON array of element sets -> aligned size-prefixed $MPE stream
// build_cat: JSON array of catalog rows  -> aligned size-prefixed $CAT stream
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
// Field names and vtable slots come only from the generated SDS headers: every
// field below is named once in an X-macro that both stringizes the name (the
// JSON key) and calls the generated add_<FIELD> (which carries the slot). A
// name that is not a generated field does not compile.
//
// Output bytes depend only on the input bytes.

#include <cerrno>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"

namespace {

// Archive encoding v1, $MPE doubles, in the order they are added.
#define GP_ARCHIVE_V1_MPE_DOUBLES(X) \
    X(EPOCH)                         \
    X(MEAN_MOTION)                   \
    X(ECCENTRICITY)                  \
    X(INCLINATION)                   \
    X(RA_OF_ASC_NODE)                \
    X(ARG_OF_PERICENTER)             \
    X(MEAN_ANOMALY)                  \
    X(BSTAR)

enum MpeDouble {
#define GP_ARCHIVE_ENUM(FIELD) kMpe_##FIELD,
    GP_ARCHIVE_V1_MPE_DOUBLES(GP_ARCHIVE_ENUM)
#undef GP_ARCHIVE_ENUM
    kMpeDoubleCount
};

const char* const kMpeDoubleNames[] = {
#define GP_ARCHIVE_NAME(FIELD) #FIELD,
    GP_ARCHIVE_V1_MPE_DOUBLES(GP_ARCHIVE_NAME)
#undef GP_ARCHIVE_NAME
};

// Generated-accessor spellings of the remaining keys. Each is checked against a
// generated member so a key cannot drift from the schema.
#define GP_ARCHIVE_FIELD_NAME(TABLE, FIELD) \
    (static_cast<void>(&TABLE::FIELD), #FIELD)

struct MpeInput {
    std::string entity_id;
    double values[kMpeDoubleCount];
    bool have_entity_id = false;
    bool have[kMpeDoubleCount] = {};
    bool have_theory = false;
};

struct CatInput {
    std::string object_id;
    std::string object_name;
    uint32_t norad_cat_id = 0;
    bool have_object_id = false;
    bool have_object_name = false;
    bool have_norad_cat_id = false;
};

// ---------------------------------------------------------------------------
// JSON reader: a top-level array of flat objects whose values are strings or
// numbers. Strings are byte strings: escapes are decoded and every other byte
// (including bytes that are not UTF-8) is kept as is, so a name reaches
// CreateString with exactly the bytes the caller holds.
// ---------------------------------------------------------------------------

struct Reader {
    const char* p;
    const char* end;
    std::string error;

    bool fail(const std::string& message) {
        if (error.empty()) error = message;
        return false;
    }
    void ws() {
        while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) p++;
    }
    bool expect(char c) {
        ws();
        if (p >= end || *p != c) return fail(std::string("expected '") + c + "'");
        p++;
        return true;
    }
    bool peek(char c) {
        ws();
        return p < end && *p == c;
    }

    static void put_utf8(std::string* out, uint32_t cp) {
        if (cp < 0x80) {
            out->push_back(static_cast<char>(cp));
        } else if (cp < 0x800) {
            out->push_back(static_cast<char>(0xC0 | (cp >> 6)));
            out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else if (cp < 0x10000) {
            out->push_back(static_cast<char>(0xE0 | (cp >> 12)));
            out->push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else {
            out->push_back(static_cast<char>(0xF0 | (cp >> 18)));
            out->push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
            out->push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        }
    }

    bool hex4(uint32_t* out) {
        if (end - p < 4) return fail("truncated \\u escape");
        uint32_t v = 0;
        for (int i = 0; i < 4; i++) {
            const char c = p[i];
            v <<= 4;
            if (c >= '0' && c <= '9') v |= static_cast<uint32_t>(c - '0');
            else if (c >= 'a' && c <= 'f') v |= static_cast<uint32_t>(c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') v |= static_cast<uint32_t>(c - 'A' + 10);
            else return fail("invalid \\u escape");
        }
        p += 4;
        *out = v;
        return true;
    }

    bool string(std::string* out) {
        out->clear();
        if (!expect('"')) return false;
        while (true) {
            if (p >= end) return fail("unterminated string");
            const unsigned char c = static_cast<unsigned char>(*p++);
            if (c == '"') return true;
            if (c < 0x20) return fail("control character in string");
            if (c != '\\') {
                out->push_back(static_cast<char>(c));
                continue;
            }
            if (p >= end) return fail("unterminated escape");
            const char e = *p++;
            switch (e) {
                case '"': out->push_back('"'); break;
                case '\\': out->push_back('\\'); break;
                case '/': out->push_back('/'); break;
                case 'b': out->push_back('\b'); break;
                case 'f': out->push_back('\f'); break;
                case 'n': out->push_back('\n'); break;
                case 'r': out->push_back('\r'); break;
                case 't': out->push_back('\t'); break;
                case 'u': {
                    uint32_t cp = 0;
                    if (!hex4(&cp)) return false;
                    if (cp >= 0xD800 && cp <= 0xDBFF) {
                        uint32_t low = 0;
                        if (end - p < 2 || p[0] != '\\' || p[1] != 'u') return fail("unpaired surrogate");
                        p += 2;
                        if (!hex4(&low)) return false;
                        if (low < 0xDC00 || low > 0xDFFF) return fail("unpaired surrogate");
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
                    } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
                        return fail("unpaired surrogate");
                    }
                    put_utf8(out, cp);
                    break;
                }
                default:
                    return fail("invalid escape");
            }
        }
    }

    // JSON number grammar, then strtod (correctly rounded), so a value written
    // with a shortest round-trip formatter comes back as the same double,
    // negative zero included.
    bool number(double* out) {
        ws();
        const char* start = p;
        if (p < end && *p == '-') p++;
        if (p >= end) return fail("expected a number");
        if (*p == '0') {
            p++;
        } else if (*p >= '1' && *p <= '9') {
            while (p < end && *p >= '0' && *p <= '9') p++;
        } else {
            return fail("expected a number");
        }
        if (p < end && *p == '.') {
            p++;
            if (p >= end || *p < '0' || *p > '9') return fail("invalid number");
            while (p < end && *p >= '0' && *p <= '9') p++;
        }
        if (p < end && (*p == 'e' || *p == 'E')) {
            p++;
            if (p < end && (*p == '+' || *p == '-')) p++;
            if (p >= end || *p < '0' || *p > '9') return fail("invalid number");
            while (p < end && *p >= '0' && *p <= '9') p++;
        }
        const std::string token(start, static_cast<size_t>(p - start));
        errno = 0;
        char* stop = nullptr;
        const double value = std::strtod(token.c_str(), &stop);
        if (stop != token.c_str() + token.size()) return fail("invalid number");
        if (!std::isfinite(value)) return fail("number out of range");
        *out = value;
        return true;
    }

    bool unsigned32(uint32_t* out) {
        ws();
        const char* start = p;
        while (p < end && *p >= '0' && *p <= '9') p++;
        const size_t digits = static_cast<size_t>(p - start);
        if (digits == 0) return fail("expected an unsigned integer");
        if (digits > 1 && *start == '0') return fail("leading zero");
        if (p < end && (*p == '.' || *p == 'e' || *p == 'E')) return fail("expected an unsigned integer");
        if (digits > 10) return fail("unsigned integer out of range");
        uint64_t v = 0;
        for (const char* q = start; q < p; q++) v = v * 10 + static_cast<uint64_t>(*q - '0');
        if (v > 0xFFFFFFFFull) return fail("unsigned integer out of range");
        *out = static_cast<uint32_t>(v);
        return true;
    }
};

// Calls field(key) for each key of one object; field consumes the value.
template <typename FieldFn>
bool read_object(Reader* r, FieldFn field) {
    if (!r->expect('{')) return false;
    if (r->peek('}')) {
        r->p++;
        return true;
    }
    std::string key;
    while (true) {
        if (!r->string(&key)) return false;
        if (!r->expect(':')) return false;
        if (!field(key)) return false;
        if (r->peek(',')) {
            r->p++;
            continue;
        }
        return r->expect('}');
    }
}

template <typename RecordFn>
bool read_array(Reader* r, RecordFn record) {
    if (!r->expect('[')) return false;
    if (r->peek(']')) {
        r->p++;
    } else {
        uint32_t index = 0;
        while (true) {
            if (!record(index)) return false;
            index++;
            if (r->peek(',')) {
                r->p++;
                continue;
            }
            if (!r->expect(']')) return false;
            break;
        }
    }
    r->ws();
    if (r->p != r->end) return r->fail("trailing bytes after the array");
    return true;
}

bool duplicate(Reader* r, bool* seen, const std::string& key) {
    if (*seen) return r->fail("duplicate key " + key);
    *seen = true;
    return true;
}

bool read_mpe(Reader* r, MpeInput* in) {
    return read_object(r, [&](const std::string& key) -> bool {
        if (key == GP_ARCHIVE_FIELD_NAME(MPE, ENTITY_ID)) {
            if (!duplicate(r, &in->have_entity_id, key)) return false;
            return r->string(&in->entity_id);
        }
        for (int i = 0; i < kMpeDoubleCount; i++) {
            if (key == kMpeDoubleNames[i]) {
                if (!duplicate(r, &in->have[i], key)) return false;
                return r->number(&in->values[i]);
            }
        }
        if (key == GP_ARCHIVE_FIELD_NAME(MPE, MEAN_ELEMENT_THEORY)) {
            if (!duplicate(r, &in->have_theory, key)) return false;
            std::string theory;
            if (!r->string(&theory)) return false;
            if (theory != EnumNamemeanElementSource(meanElementSource::SGP4)) {
                return r->fail("archive encoding v1 stores SGP4 element sets only");
            }
            return true;
        }
        return r->fail("unknown key " + key);
    });
}

bool read_cat(Reader* r, CatInput* in) {
    return read_object(r, [&](const std::string& key) -> bool {
        if (key == GP_ARCHIVE_FIELD_NAME(CAT, OBJECT_ID)) {
            if (!duplicate(r, &in->have_object_id, key)) return false;
            return r->string(&in->object_id);
        }
        if (key == GP_ARCHIVE_FIELD_NAME(CAT, NORAD_CAT_ID)) {
            if (!duplicate(r, &in->have_norad_cat_id, key)) return false;
            return r->unsigned32(&in->norad_cat_id);
        }
        if (key == GP_ARCHIVE_FIELD_NAME(CAT, OBJECT_NAME)) {
            if (!duplicate(r, &in->have_object_name, key)) return false;
            return r->string(&in->object_name);
        }
        return r->fail("unknown key " + key);
    });
}

// ---------------------------------------------------------------------------
// Archive encoding v1 builders.
// ---------------------------------------------------------------------------

void build_mpe_v1(::flatbuffers::FlatBufferBuilder* b, const MpeInput& in) {
    b->Clear();
    b->ForceDefaults(true);
    const auto entity_id = b->CreateString(in.entity_id);
    MPEBuilder mpe(*b);
    mpe.add_ENTITY_ID(entity_id);
#define GP_ARCHIVE_ADD(FIELD) mpe.add_##FIELD(in.values[kMpe_##FIELD]);
    GP_ARCHIVE_V1_MPE_DOUBLES(GP_ARCHIVE_ADD)
#undef GP_ARCHIVE_ADD
    mpe.add_MEAN_ELEMENT_THEORY(meanElementSource::SGP4);
    FinishSizePrefixedMPEBuffer(*b, mpe.Finish());
}

void build_cat_v1(::flatbuffers::FlatBufferBuilder* b, const CatInput& in) {
    b->Clear();
    b->ForceDefaults(false);
    const auto object_id = b->CreateString(in.object_id);
    const auto object_name = b->CreateString(in.object_name);
    CATBuilder cat(*b);
    cat.add_OBJECT_ID(object_id);
    cat.add_NORAD_CAT_ID(in.norad_cat_id);
    cat.add_OBJECT_NAME(object_name);
    FinishSizePrefixedCATBuffer(*b, cat.Finish());
}

void append_frame(std::vector<uint8_t>* stream, const ::flatbuffers::FlatBufferBuilder& b) {
    stream->insert(stream->end(), b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
    while (stream->size() % 8 != 0) stream->push_back(0);
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

// Points r at the one JSON frame on port "records"; returns 0 or a status.
int records_frame(Reader* r, const char* method) {
    char batch_message[256];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    const int32_t input_index = plugin_find_input_index("records", 0);
    const plugin_input_frame_t* frame =
        input_index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(input_index)) : nullptr;
    if (!frame) {
        char message[128];
        std::snprintf(message, sizeof(message), "%s requires a JSON frame on port \"records\".", method);
        plugin_set_error("missing-records-frame", message);
        return 400;
    }
    r->p = reinterpret_cast<const char*>(frame->payload);
    r->end = r->p + (frame->payload ? frame->payload_length : 0u);
    return 0;
}

int refuse(const Reader& r, uint32_t index, const char* what) {
    std::string message = std::string(what) + " record " + std::to_string(index) + ": " + r.error;
    plugin_set_error("invalid-record", message.c_str());
    return 400;
}

int push_stream(const char* schema, const char* identifier, const char* root,
                const std::vector<uint8_t>& stream) {
    if (plugin_push_output_ex("records", schema, identifier, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,
                              root, 0, 8, stream.data(), static_cast<uint32_t>(stream.size())) < 0) {
        return 500;
    }
    return 0;
}

}  // namespace

extern "C" {

int build_mpe(void) {
    Reader r{nullptr, nullptr, {}};
    if (const int status = records_frame(&r, "build_mpe")) return status;
    std::vector<uint8_t> stream;
    ::flatbuffers::FlatBufferBuilder builder(256);
    uint32_t failed_index = 0;
    const bool ok = read_array(&r, [&](uint32_t index) -> bool {
        failed_index = index;
        MpeInput in;
        if (!read_mpe(&r, &in)) return false;
        if (!in.have_entity_id) return r.fail("missing ENTITY_ID");
        for (int i = 0; i < kMpeDoubleCount; i++) {
            if (!in.have[i]) return r.fail(std::string("missing ") + kMpeDoubleNames[i]);
        }
        build_mpe_v1(&builder, in);
        append_frame(&stream, builder);
        return true;
    });
    if (!ok) return refuse(r, failed_index, "$MPE");
    return push_stream("MPE.fbs", "$MPE", "MPE", stream);
}

int build_cat(void) {
    Reader r{nullptr, nullptr, {}};
    if (const int status = records_frame(&r, "build_cat")) return status;
    std::vector<uint8_t> stream;
    ::flatbuffers::FlatBufferBuilder builder(128);
    uint32_t failed_index = 0;
    const bool ok = read_array(&r, [&](uint32_t index) -> bool {
        failed_index = index;
        CatInput in;
        if (!read_cat(&r, &in)) return false;
        if (!in.have_object_id) return r.fail("missing OBJECT_ID");
        if (!in.have_norad_cat_id) return r.fail("missing NORAD_CAT_ID");
        if (!in.have_object_name) return r.fail("missing OBJECT_NAME");
        build_cat_v1(&builder, in);
        append_frame(&stream, builder);
        return true;
    });
    if (!ok) return refuse(r, failed_index, "$CAT");
    return push_stream("CAT.fbs", "$CAT", "CAT", stream);
}

}  // extern "C"
