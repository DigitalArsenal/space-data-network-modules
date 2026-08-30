/*
 * files/ccsds-messages — the SDS `$TDM` projection.
 *
 * A `ccsds::tdm::Message` in, a `TDMT` out, and back.
 *
 * OBSERVATIONS ARE TRIPLES, IN FILE ORDER, ALWAYS
 *
 * `TDMObservation` is `(KEYWORD, EPOCH, VALUE)` and this projection writes one
 * per data line, in the order the file wrote them. Never sorted, never
 * deduplicated, never gathered into columns on a common time base. Figure E-17
 * is the reason and it is published: its last `RCS` line is stamped
 * `10:26:33.7008`, 0.2678 s EARLIER than the `CARRIER_POWER` line above it. A
 * parallel-array form would have to move that line or drop it, and both change
 * what the station reported. The root's legacy arrays
 * (`ANGLE_1`, `RECEIVE_FREQ`, `STEC`, `CLOCK_BIAS`, ...) and their
 * `OBSERVATION_START_TIME + i * OBSERVATION_STEP_SIZE` grid are therefore never
 * written, and a record that arrives carrying only them is REFUSED rather than
 * reconstructed — rebuilding those epochs needs the leap-second table
 * `foundation/time` owns.
 *
 * ALWAYS THE `SEGMENTS` FORM
 *
 * A TDM's metadata is per segment: Figure E-16 carries two segments whose only
 * difference is the track number, Figure E-18 two whose start times are three
 * hours apart. The IDL's own precedence rule makes `SEGMENTS` authoritative
 * whenever it is non-empty, so writing it for every message — one segment or
 * twenty — means one code path, exercised by every fixture, and no case where
 * the record's shape depends on how many segments the file happened to have.
 * The root keeps only what CCSDS 503.0-B-2 table 3-2 calls the header:
 * `CCSDS_TDM_VERS`, `COMMENT`, `CREATION_DATE`, `ORIGINATOR`, `MESSAGE_ID`.
 * Reading is more permissive than writing: the root `OBSERVATIONS` form is
 * accepted and folded into a single segment, because other producers may write
 * it and refusing a form the IDL defines would be this reader being stricter
 * than the schema.
 *
 * `TRANSMIT_RAMPS` IS ABSENT, NOT EMPTY
 *
 * The ramp table is an SDS extension: a record that omits it is exactly a
 * CCSDS-conformant TDM. So this projection never writes one, never synthesises
 * one from `TRANSMIT_FREQ_1`, and — because a FlatBuffers vector left empty is
 * an absent field, not an empty one — a ramp-free message produces a record
 * whose `TRANSMIT_RAMPS()` accessor returns null. Reading a record that DOES
 * carry ramps is symmetric in the other direction: the ramps are preserved in
 * the record and NOTHING about them reaches the KVN body, because there is no
 * CCSDS keyword for a ramp and inventing one would emit a file no TDM reader
 * can parse. The same holds for `SIGNAL_TO_NOISE`, `SPECTRAL_MAX` and
 * `DOPPLER_NOISE_HZ`.
 *
 * WHAT THE RECORD CANNOT CARRY IS DECLARED
 *
 * `ProjectionReport::losses` names every keyword and comment the record has no
 * field for, with its segment and its text. The published corpus produces two:
 *
 *   - Figure E-17's `EPHEMERIS_NAME`. 503.0-B-2's own metadata table defines
 *     only `EPHEMERIS_NAME_1..5`; the bare form the figure prints is not in it,
 *     and Orekit rejects the same line. Renaming it to `EPHEMERIS_NAME_1` on
 *     the way in would put a participant index into the record that the file
 *     never stated.
 *   - Figure E-18's `FREQ_OFFSET = 0.0`. A FlatBuffers table omits a scalar
 *     equal to its type default, so a numeric keyword written as zero and one
 *     never written are the same bytes. `from_record` emits a numeric keyword
 *     only when it differs from the default; the alternative — always emitting
 *     every numeric field — would invent sixty keywords the file never had.
 *
 * NO FILESYSTEM, NO EXCEPTIONS, NO THROW. Every failure is a status code and a
 * report; a malformed record never produces a NaN and never traps.
 */

#ifndef CCSDS_MESSAGES_TDM_PROJECTION_HPP
#define CCSDS_MESSAGES_TDM_PROJECTION_HPP

#include "tdm.hpp"
#include "generated/sds/TDM_generated.h"

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <string>
#include <vector>

/* ------------------------------------------------------------------------ */
/* Shared by both SDS projections in this package                            */
/* ------------------------------------------------------------------------ */
/*
 * This block is IDENTICAL in `aem_projection.hpp`; whichever header is included
 * first defines it and the guard makes the second a no-op. It is duplicated
 * rather than split into a third header so that each projection stays
 * self-contained — the module build concatenates headers into one translation
 * unit and a file that only exists to be included by two others is one more
 * ordering constraint for no benefit. Keep the two copies byte-identical.
 */
#ifndef CCSDS_MESSAGES_SDS_PROJECTION_COMMON_HPP
#define CCSDS_MESSAGES_SDS_PROJECTION_COMMON_HPP

namespace ccsds {
namespace sdsproj {

/*
 * The SHORTEST decimal text that reads back as the same double. A record holds
 * IEEE-754, a KVN line holds text, and the only property that can survive both
 * directions is the value — `%.17g` would turn `0.56748` into
 * `0.56747999999999996` and lose a byte round trip that is otherwise free,
 * while `%.15g` alone would silently truncate `7175173383.615373`. Trying 15,
 * 16 and 17 in order and keeping the first that reparses exactly gets both.
 */
inline std::string format_number(double v) {
    char buf[48];
    for (int precision = 15; precision <= 17; ++precision) {
        std::snprintf(buf, sizeof(buf), "%.*g", precision, v);
        bool ok = false;
        if (kvn::to_double(buf, &ok) == v && ok) return std::string(buf);
    }
    return std::string(buf);
}

inline std::string format_integer(long long v) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%lld", v);
    return std::string(buf);
}

/* True only when the WHOLE token is a number. `2,1` parses as 2 and stops at
 * the comma; treating that as the number two is how a signal path becomes a
 * participant count three layers downstream. */
inline bool parse_full_number(const std::string& s, double* out) {
    if (s.empty()) return false;
    char* end = nullptr;
    const double v = std::strtod(s.c_str(), &end);
    if (!end || end == s.c_str()) return false;
    while (*end != '\0' && kvn::is_space(*end)) ++end;
    if (*end != '\0') return false;
    if (out) *out = v;
    return true;
}

enum class LossReason : int32_t {
    /* The record has no field for this keyword at all. */
    NoCarrier = 1,
    /* The value equals the FlatBuffers default for the field's type, which a
     * table cannot tell apart from an absent field. */
    DefaultValued = 2,
    /* The field is numeric and the keyword's value is not a number. */
    NotANumber = 3,
};

inline const char* loss_reason_name(LossReason r) {
    switch (r) {
        case LossReason::NoCarrier: return "no-carrier";
        case LossReason::DefaultValued: return "default-valued";
        case LossReason::NotANumber: return "not-a-number";
    }
    return "unknown";
}

/* `segment` for a loss taken from the message header rather than a segment. */
static const size_t kHeaderScope = static_cast<size_t>(-1);

struct Loss {
    size_t segment = kHeaderScope;
    std::string key;   /* the CCSDS keyword, or "COMMENT" for a comment line */
    std::string text;  /* the value, or the comment's text — enough to find it */
    LossReason reason = LossReason::NoCarrier;
};

/* ---- JSON primitives -------------------------------------------------- */
/*
 * SDS JSON keys are the IDL field identifiers character for character (owner
 * law, json-schema-capitalization-rule), so every key below is produced by
 * stringizing the same identifier the field access compiles against. A key
 * cannot be hand-typed and therefore cannot drift from the schema.
 */
inline void json_escape(std::string* out, const std::string& s) {
    *out += '"';
    for (size_t i = 0; i < s.size(); ++i) {
        const unsigned char c = static_cast<unsigned char>(s[i]);
        switch (c) {
            case '"': *out += "\\\""; break;
            case '\\': *out += "\\\\"; break;
            case '\n': *out += "\\n"; break;
            case '\r': *out += "\\r"; break;
            case '\t': *out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char esc[8];
                    std::snprintf(esc, sizeof(esc), "\\u%04x", c);
                    *out += esc;
                } else {
                    *out += static_cast<char>(c);
                }
        }
    }
    *out += '"';
}

inline void json_key(std::string* out, const char* name, bool* first) {
    if (!*first) *out += ',';
    *first = false;
    *out += '"';
    *out += name;
    *out += "\":";
}

/* JSON has no NaN and no Infinity. A record that carries one is malformed, and
 * `null` says so without inventing a number or emitting a token no parser
 * accepts. */
inline void json_number(std::string* out, double v) {
    if (!std::isfinite(v)) { *out += "null"; return; }
    *out += format_number(v);
}

}  // namespace sdsproj
}  // namespace ccsds

#endif  // CCSDS_MESSAGES_SDS_PROJECTION_COMMON_HPP

namespace ccsds {
namespace tdm {

/* ------------------------------------------------------------------------ */
/* Status                                                                    */
/* ------------------------------------------------------------------------ */

enum class ProjectionStatus : int32_t {
    Ok = 0,
    NullArgument = -60,
    NonNumericValue = -61,        /* an observation whose value is not a number */
    UniformGridNeedsTimeMath = -62, /* only the legacy parallel arrays are set  */
    BothFormsPopulated = -63,     /* SEGMENTS and root OBSERVATIONS together    */
    NonFiniteValue = -64,         /* a NaN or infinity in the record            */
};

inline const char* projection_status_name(ProjectionStatus s) {
    switch (s) {
        case ProjectionStatus::Ok: return "ok";
        case ProjectionStatus::NullArgument: return "null-argument";
        case ProjectionStatus::NonNumericValue: return "non-numeric-value";
        case ProjectionStatus::UniformGridNeedsTimeMath: return "uniform-grid-needs-time-math";
        case ProjectionStatus::BothFormsPopulated: return "both-forms-populated";
        case ProjectionStatus::NonFiniteValue: return "non-finite-value";
    }
    return "unknown";
}

struct ProjectionReport {
    ProjectionStatus status = ProjectionStatus::Ok;
    /* Header and metadata keyword occurrences that landed in an IDL field, plus
     * every comment line the record carried. `mapped_keys + losses.size()` is
     * the whole keyword population of the message. */
    size_t mapped_keys = 0;
    std::vector<sdsproj::Loss> losses;
    size_t segment = 0;  /* where a refusal happened */
    size_t observation = 0;
};

/* ------------------------------------------------------------------------ */
/* Field rosters — also the reconstruction order                             */
/* ------------------------------------------------------------------------ */

/*
 * CCSDS 503.0-B-2 Cor.1 table 3-2 (header) and table 3-3 (metadata) fix the
 * order these keywords appear in. A record has fields, not lines, so re-emitting
 * has to CHOOSE an order; the standard's own order is what brings the published
 * examples back the way they went in, and it is the one choice that is not
 * arbitrary. This roster is also what decides whether a keyword is "known": a
 * keyword mapped by `to_record` but missing here would be counted both mapped
 * and lost, and a keyword listed here with no mapping would be counted neither.
 * The acceptance asserts `mapped + lost == every keyword in the file`, so
 * either mistake fails loudly.
 */
inline const char* const* tdm_header_keys(size_t* count) {
    static const char* const keys[] = {
        "CCSDS_TDM_VERS", "COMMENT", "CREATION_DATE", "ORIGINATOR", "MESSAGE_ID",
    };
    *count = sizeof(keys) / sizeof(keys[0]);
    return keys;
}

inline const char* const* tdm_segment_keys(size_t* count) {
    static const char* const keys[] = {
        "COMMENT", "MESSAGE_ID", "TRACK_ID", "DATA_TYPES", "TIME_SYSTEM", "START_TIME",
        "STOP_TIME", "PARTICIPANT_1", "PARTICIPANT_2", "PARTICIPANT_3", "PARTICIPANT_4",
        "PARTICIPANT_5", "MODE", "PATH", "PATH_1", "PATH_2", "EPHEMERIS_NAME_1",
        "EPHEMERIS_NAME_2", "EPHEMERIS_NAME_3", "EPHEMERIS_NAME_4", "EPHEMERIS_NAME_5",
        "TRANSMIT_BAND", "RECEIVE_BAND", "TURNAROUND_NUMERATOR", "TURNAROUND_DENOMINATOR",
        "TIMETAG_REF", "INTEGRATION_INTERVAL", "INTEGRATION_REF", "FREQ_OFFSET",
        "RANGE_MODE", "RANGE_MODULUS", "RANGE_UNITS", "ANGLE_TYPE", "REFERENCE_FRAME",
        "INTERPOLATION", "INTERPOLATION_DEGREE", "DOPPLER_COUNT_BIAS", "DOPPLER_COUNT_SCALE",
        "DOPPLER_COUNT_ROLLOVER", "TRANSMIT_DELAY_1", "TRANSMIT_DELAY_2", "TRANSMIT_DELAY_3",
        "TRANSMIT_DELAY_4", "TRANSMIT_DELAY_5", "RECEIVE_DELAY_1", "RECEIVE_DELAY_2",
        "RECEIVE_DELAY_3", "RECEIVE_DELAY_4", "RECEIVE_DELAY_5", "TRANSMIT_FREQ_1",
        "TRANSMIT_FREQ_2", "TRANSMIT_FREQ_3", "TRANSMIT_FREQ_4", "TRANSMIT_FREQ_5",
        "TRANSMIT_FREQ_RATE_1", "TRANSMIT_FREQ_RATE_2", "TRANSMIT_FREQ_RATE_3",
        "TRANSMIT_FREQ_RATE_4", "TRANSMIT_FREQ_RATE_5", "DATA_QUALITY",
        "CORRECTION_ANGLE_1", "CORRECTION_ANGLE_2", "CORRECTION_DOPPLER", "CORRECTION_MAG",
        "CORRECTION_RANGE", "CORRECTION_RCS", "CORRECTION_RECEIVE", "CORRECTION_TRANSMIT",
        "CORRECTION_ABERRATION_YEARLY", "CORRECTION_ABERRATION_DIURNAL", "CORRECTIONS_APPLIED",
    };
    *count = sizeof(keys) / sizeof(keys[0]);
    return keys;
}

namespace detail {

inline bool key_in(const char* const* keys, size_t count, const std::string& key) {
    for (size_t i = 0; i < count; ++i) {
        if (key == keys[i]) return true;
    }
    return false;
}

inline void declare_loss(ProjectionReport* rep, size_t segment, const char* key,
                         const std::string& text, sdsproj::LossReason reason) {
    sdsproj::Loss loss;
    loss.segment = segment;
    loss.key = key;
    loss.text = text;
    loss.reason = reason;
    rep->losses.push_back(loss);
}

inline bool take_string(const std::vector<kvn::Entry>& src, const char* key, std::string* dst,
                        ProjectionReport* rep, size_t scope) {
    const kvn::Entry* e = kvn::find(src, key);
    if (!e) return false;
    if (e->value.empty()) {
        /* A keyword is counted MAPPED only when it is actually carried, so
         * `mapped + lost` stays exactly the number of keywords in the file. */
        declare_loss(rep, scope, key, e->value, sdsproj::LossReason::DefaultValued);
        return false;
    }
    *dst = e->value;
    ++rep->mapped_keys;
    return true;
}

/* One body for every numeric width. The `min`/`max` bounds are the field's, so
 * a value the record's type cannot hold is a declared loss rather than a silent
 * wrap — `TRANSMIT_FREQ_1` truncated into a uint16 is a different frequency. */
inline bool take_number(const std::vector<kvn::Entry>& src, const char* key, double* value,
                        ProjectionReport* rep, size_t scope, bool integral, double lo, double hi) {
    const kvn::Entry* e = kvn::find(src, key);
    if (!e) return false;
    double v = 0.0;
    if (!sdsproj::parse_full_number(e->value, &v) || (integral && v != std::floor(v)) || v < lo ||
        v > hi) {
        declare_loss(rep, scope, key, e->value, sdsproj::LossReason::NotANumber);
        return false;
    }
    if (v == 0.0) {
        declare_loss(rep, scope, key, e->value, sdsproj::LossReason::DefaultValued);
        return false;
    }
    *value = v;
    ++rep->mapped_keys;
    return true;
}

/* CCSDS writes booleans as YES/NO (503.0-B-2 table 3-3). `NO` is the field's
 * default and therefore indistinguishable from absent. */
inline bool take_bool(const std::vector<kvn::Entry>& src, const char* key, bool* dst,
                      ProjectionReport* rep, size_t scope) {
    const kvn::Entry* e = kvn::find(src, key);
    if (!e) return false;
    if (e->value == "YES") { *dst = true; ++rep->mapped_keys; return true; }
    if (e->value == "NO") {
        declare_loss(rep, scope, key, e->value, sdsproj::LossReason::DefaultValued);
        return false;
    }
    declare_loss(rep, scope, key, e->value, sdsproj::LossReason::NotANumber);
    return false;
}

/*
 * Comments are carried where CCSDS puts them and nowhere else. `TDM.COMMENT` is
 * the header's comment lines and `TDMSegment.COMMENT` is the METADATA block's;
 * neither is a general comment bag. A comment anywhere else — further down a
 * metadata block, inside a data block — is declared and dropped rather than
 * relocated into a block it was never in.
 */
inline void take_comments(const std::vector<kvn::Entry>& src, size_t comment_host,
                          std::vector<std::string>* dst, ProjectionReport* rep, size_t scope) {
    for (size_t i = 0; i < src.size(); ++i) {
        for (size_t c = 0; c < src[i].comments_before.size(); ++c) {
            const std::string& text = src[i].comments_before[c];
            if (i == comment_host) {
                dst->push_back(text);
                ++rep->mapped_keys;
            } else {
                declare_loss(rep, scope, "COMMENT", text, sdsproj::LossReason::NoCarrier);
            }
        }
        if (src[i].is_standalone_comment) {
            declare_loss(rep, scope, "COMMENT", src[i].value, sdsproj::LossReason::NoCarrier);
        }
    }
}

/* The index of the entry CCSDS puts the header's COMMENT lines in front of:
 * the one that follows CCSDS_TDM_VERS (503.0-B-2 table 3-2). */
inline size_t header_comment_host(const std::vector<kvn::Entry>& header) {
    for (size_t i = 0; i < header.size(); ++i) {
        if (!header[i].is_standalone_comment && header[i].key == "CCSDS_TDM_VERS") {
            return i + 1;
        }
    }
    return 0;
}

inline void push_entry(std::vector<kvn::Entry>* out, const char* key, const std::string& value) {
    if (value.empty()) return;
    kvn::Entry e;
    e.key = key;
    e.value = value;
    out->push_back(e);
}

inline void attach_comments(std::vector<kvn::Entry>* out, size_t host,
                            const std::vector<std::string>& comments) {
    if (comments.empty()) return;
    if (host < out->size()) {
        (*out)[host].comments_before = comments;
        return;
    }
    for (size_t i = 0; i < comments.size(); ++i) {
        kvn::Entry e;
        e.key = "COMMENT";
        e.value = comments[i];
        e.is_standalone_comment = true;
        out->push_back(e);
    }
}

}  // namespace detail

/* ------------------------------------------------------------------------ */
/* Message -> $TDM                                                           */
/* ------------------------------------------------------------------------ */

inline ProjectionStatus to_record(const Message& msg, ::TDMT* out,
                                  ProjectionReport* report = nullptr) {
    ProjectionReport local;
    ProjectionReport* rep = report ? report : &local;
    *rep = ProjectionReport{};
    if (!out) {
        rep->status = ProjectionStatus::NullArgument;
        return rep->status;
    }
    *out = ::TDMT{};

    size_t header_key_count = 0;
    const char* const* header_keys = tdm_header_keys(&header_key_count);
    detail::take_comments(msg.header, detail::header_comment_host(msg.header), &out->COMMENT, rep,
                          sdsproj::kHeaderScope);
    detail::take_string(msg.header, "CCSDS_TDM_VERS", &out->CCSDS_TDM_VERS, rep,
                        sdsproj::kHeaderScope);
    detail::take_string(msg.header, "CREATION_DATE", &out->CREATION_DATE, rep,
                        sdsproj::kHeaderScope);
    detail::take_string(msg.header, "ORIGINATOR", &out->ORIGINATOR, rep, sdsproj::kHeaderScope);
    detail::take_string(msg.header, "MESSAGE_ID", &out->MESSAGE_ID, rep, sdsproj::kHeaderScope);
    for (size_t i = 0; i < msg.header.size(); ++i) {
        if (msg.header[i].is_standalone_comment) continue;
        if (detail::key_in(header_keys, header_key_count, msg.header[i].key)) continue;
        detail::declare_loss(rep, sdsproj::kHeaderScope, msg.header[i].key.c_str(),
                             msg.header[i].value, sdsproj::LossReason::NoCarrier);
    }

    size_t segment_key_count = 0;
    const char* const* segment_keys = tdm_segment_keys(&segment_key_count);

    out->SEGMENTS.reserve(msg.segments.size());
    for (size_t si = 0; si < msg.segments.size(); ++si) {
        const Segment& src = msg.segments[si];
        const std::vector<kvn::Entry>& meta = src.metadata;
        std::unique_ptr< ::TDMSegmentT> seg(new ::TDMSegmentT());

        detail::take_comments(meta, 0, &seg->COMMENT, rep, si);

/* `#KEY` and `seg->KEY` are the same identifier, so the CCSDS keyword and the
 * IDL field it lands in cannot drift apart. */
#define TAKE_S(KEY) detail::take_string(meta, #KEY, &seg->KEY, rep, si)
#define TAKE_N(KEY, INTEGRAL, LO, HI)                                        \
    do {                                                                      \
        double v_ = 0.0;                                                      \
        if (detail::take_number(meta, #KEY, &v_, rep, si, INTEGRAL, LO, HI)) { \
            seg->KEY = static_cast<decltype(seg->KEY)>(v_);                    \
        }                                                                     \
    } while (0)
#define TAKE_D(KEY) TAKE_N(KEY, false, -1e308, 1e308)
#define TAKE_U16(KEY) TAKE_N(KEY, true, 0.0, 65535.0)
#define TAKE_U32(KEY) TAKE_N(KEY, true, 0.0, 4294967295.0)
#define TAKE_I32(KEY) TAKE_N(KEY, true, -2147483648.0, 2147483647.0)
#define TAKE_B(KEY) detail::take_bool(meta, #KEY, &seg->KEY, rep, si)

        TAKE_S(MESSAGE_ID);
        TAKE_S(TRACK_ID);
        TAKE_S(DATA_TYPES);
        TAKE_S(TIME_SYSTEM);
        TAKE_S(START_TIME);
        TAKE_S(STOP_TIME);
        TAKE_S(PARTICIPANT_1);
        TAKE_S(PARTICIPANT_2);
        TAKE_S(PARTICIPANT_3);
        TAKE_S(PARTICIPANT_4);
        TAKE_S(PARTICIPANT_5);
        TAKE_S(MODE);
        TAKE_S(PATH);
        TAKE_U16(PATH_1);
        TAKE_U16(PATH_2);
        TAKE_S(EPHEMERIS_NAME_1);
        TAKE_S(EPHEMERIS_NAME_2);
        TAKE_S(EPHEMERIS_NAME_3);
        TAKE_S(EPHEMERIS_NAME_4);
        TAKE_S(EPHEMERIS_NAME_5);
        TAKE_S(TRANSMIT_BAND);
        TAKE_S(RECEIVE_BAND);
        TAKE_I32(TURNAROUND_NUMERATOR);
        TAKE_I32(TURNAROUND_DENOMINATOR);
        TAKE_S(TIMETAG_REF);
        TAKE_D(INTEGRATION_INTERVAL);
        TAKE_S(INTEGRATION_REF);
        TAKE_D(FREQ_OFFSET);
        TAKE_S(RANGE_MODE);
        TAKE_D(RANGE_MODULUS);
        TAKE_S(RANGE_UNITS);
        TAKE_S(ANGLE_TYPE);
        TAKE_S(REFERENCE_FRAME);
        TAKE_S(INTERPOLATION);
        TAKE_U32(INTERPOLATION_DEGREE);
        TAKE_D(DOPPLER_COUNT_BIAS);
        TAKE_U32(DOPPLER_COUNT_SCALE);
        TAKE_B(DOPPLER_COUNT_ROLLOVER);
        TAKE_D(TRANSMIT_DELAY_1);
        TAKE_D(TRANSMIT_DELAY_2);
        TAKE_D(TRANSMIT_DELAY_3);
        TAKE_D(TRANSMIT_DELAY_4);
        TAKE_D(TRANSMIT_DELAY_5);
        TAKE_D(RECEIVE_DELAY_1);
        TAKE_D(RECEIVE_DELAY_2);
        TAKE_D(RECEIVE_DELAY_3);
        TAKE_D(RECEIVE_DELAY_4);
        TAKE_D(RECEIVE_DELAY_5);
        TAKE_D(TRANSMIT_FREQ_1);
        TAKE_D(TRANSMIT_FREQ_2);
        TAKE_D(TRANSMIT_FREQ_3);
        TAKE_D(TRANSMIT_FREQ_4);
        TAKE_D(TRANSMIT_FREQ_5);
        TAKE_D(TRANSMIT_FREQ_RATE_1);
        TAKE_D(TRANSMIT_FREQ_RATE_2);
        TAKE_D(TRANSMIT_FREQ_RATE_3);
        TAKE_D(TRANSMIT_FREQ_RATE_4);
        TAKE_D(TRANSMIT_FREQ_RATE_5);
        TAKE_S(DATA_QUALITY);
        TAKE_D(CORRECTION_ANGLE_1);
        TAKE_D(CORRECTION_ANGLE_2);
        TAKE_D(CORRECTION_DOPPLER);
        TAKE_D(CORRECTION_MAG);
        TAKE_D(CORRECTION_RANGE);
        TAKE_D(CORRECTION_RCS);
        TAKE_D(CORRECTION_RECEIVE);
        TAKE_D(CORRECTION_TRANSMIT);
        TAKE_D(CORRECTION_ABERRATION_YEARLY);
        TAKE_D(CORRECTION_ABERRATION_DIURNAL);
        TAKE_S(CORRECTIONS_APPLIED);

#undef TAKE_S
#undef TAKE_N
#undef TAKE_D
#undef TAKE_U16
#undef TAKE_U32
#undef TAKE_I32
#undef TAKE_B

        for (size_t i = 0; i < meta.size(); ++i) {
            if (meta[i].is_standalone_comment) continue;
            if (detail::key_in(segment_keys, segment_key_count, meta[i].key)) continue;
            detail::declare_loss(rep, si, meta[i].key.c_str(), meta[i].value,
                                 sdsproj::LossReason::NoCarrier);
        }

        /* The block markers are structure in a KVN document and fields in this
         * record; carrying them is what lets a segment with an EMPTY data block
         * come back as one, which `has_data_block` alone could not express. */
        seg->META_START = "META_START";
        seg->META_STOP = "META_STOP";
        if (src.has_data_block) {
            seg->DATA_START = "DATA_START";
            seg->DATA_STOP = "DATA_STOP";
        }

        seg->OBSERVATIONS.reserve(src.observations.size());
        for (size_t oi = 0; oi < src.observations.size(); ++oi) {
            const Observation& obs = src.observations[oi];
            if (obs.is_standalone_comment) {
                detail::declare_loss(rep, si, "COMMENT", obs.epoch,
                                     sdsproj::LossReason::NoCarrier);
                continue;
            }
            for (size_t c = 0; c < obs.comments_before.size(); ++c) {
                detail::declare_loss(rep, si, "COMMENT", obs.comments_before[c],
                                     sdsproj::LossReason::NoCarrier);
            }
            double v = 0.0;
            if (obs.values.empty() || !sdsproj::parse_full_number(obs.values[0], &v)) {
                rep->status = ProjectionStatus::NonNumericValue;
                rep->segment = si;
                rep->observation = oi;
                *out = ::TDMT{};
                return rep->status;
            }
            /* `TDMObservation` holds ONE value, which is what a 503.0-B-2 data
             * line carries. A line with more numbers on it is a producer
             * extension; the first is the measurement and the rest are named. */
            for (size_t k = 1; k < obs.values.size(); ++k) {
                detail::declare_loss(rep, si, obs.keyword.c_str(), obs.values[k],
                                     sdsproj::LossReason::NoCarrier);
            }
            std::unique_ptr< ::TDMObservationT> row(new ::TDMObservationT());
            row->KEYWORD = obs.keyword;
            row->EPOCH = obs.epoch;
            row->VALUE = v;
            seg->OBSERVATIONS.push_back(std::move(row));
        }

        /* TRANSMIT_RAMPS is left untouched. An empty object-API vector packs to
         * offset zero, which is an ABSENT field — the record stays exactly a
         * CCSDS-conformant TDM. */
        out->SEGMENTS.push_back(std::move(seg));
    }
    return ProjectionStatus::Ok;
}

/* ------------------------------------------------------------------------ */
/* $TDM -> Message                                                           */
/* ------------------------------------------------------------------------ */

namespace detail {

/*
 * The root's single-segment form, restated as a segment so that reading has one
 * body instead of two that can disagree. MESSAGE_ID is deliberately NOT copied:
 * on the root it is the MESSAGE header's identifier (503.0-B-2 table 3-2), and
 * copying it here would move a header keyword into a metadata block.
 */
inline void segment_from_root(const ::TDMT& root, ::TDMSegmentT* dst) {
#define COPY(FIELD) dst->FIELD = root.FIELD
#define COPY_CAST(FIELD) dst->FIELD = static_cast<decltype(dst->FIELD)>(root.FIELD)
    COPY(META_START);
    COPY(TIME_SYSTEM);
    COPY(START_TIME);
    COPY(STOP_TIME);
    COPY(PARTICIPANT_1);
    COPY(PARTICIPANT_2);
    COPY(PARTICIPANT_3);
    COPY(PARTICIPANT_4);
    COPY(PARTICIPANT_5);
    COPY(MODE);
    COPY(PATH_1);
    COPY(PATH_2);
    COPY(TRANSMIT_BAND);
    COPY(RECEIVE_BAND);
    COPY_CAST(INTEGRATION_INTERVAL);
    COPY(INTEGRATION_REF);
    COPY(TIMETAG_REF);
    COPY(ANGLE_TYPE);
    COPY(RANGE_MODE);
    COPY(RANGE_MODULUS);
    COPY_CAST(CORRECTION_ANGLE_1);
    COPY_CAST(CORRECTION_ANGLE_2);
    COPY(CORRECTIONS_APPLIED);
    COPY(DATA_QUALITY);
    COPY(RECEIVE_DELAY_2);
    COPY(RECEIVE_DELAY_3);
    COPY(TRANSMIT_FREQ_1);
    COPY(TRANSMIT_FREQ_2);
    COPY(TRANSMIT_FREQ_3);
    COPY(TRANSMIT_FREQ_4);
    COPY(TRANSMIT_FREQ_5);
    COPY(TRANSMIT_FREQ_RATE_1);
    COPY(TRANSMIT_FREQ_RATE_2);
    COPY(TRANSMIT_FREQ_RATE_3);
    COPY(TRANSMIT_FREQ_RATE_4);
    COPY(TRANSMIT_FREQ_RATE_5);
    COPY(META_STOP);
    COPY(DATA_START);
    COPY(DATA_STOP);
    COPY(TRACK_ID);
    COPY(DATA_TYPES);
    COPY(PATH);
    COPY(EPHEMERIS_NAME_1);
    COPY(EPHEMERIS_NAME_2);
    COPY(EPHEMERIS_NAME_3);
    COPY(EPHEMERIS_NAME_4);
    COPY(EPHEMERIS_NAME_5);
    COPY(RANGE_UNITS);
    COPY(REFERENCE_FRAME);
    COPY(INTERPOLATION);
    COPY(INTERPOLATION_DEGREE);
    COPY(FREQ_OFFSET);
    COPY(TURNAROUND_NUMERATOR);
    COPY(TURNAROUND_DENOMINATOR);
    COPY(TRANSMIT_DELAY_1);
    COPY(TRANSMIT_DELAY_2);
    COPY(TRANSMIT_DELAY_3);
    COPY(TRANSMIT_DELAY_4);
    COPY(TRANSMIT_DELAY_5);
    COPY(RECEIVE_DELAY_1);
    COPY(RECEIVE_DELAY_4);
    COPY(RECEIVE_DELAY_5);
    COPY(DOPPLER_COUNT_BIAS);
    COPY(DOPPLER_COUNT_SCALE);
    COPY(DOPPLER_COUNT_ROLLOVER);
    COPY(CORRECTION_RANGE);
    COPY(CORRECTION_DOPPLER);
    COPY(CORRECTION_MAG);
    COPY(CORRECTION_RCS);
    COPY(CORRECTION_RECEIVE);
    COPY(CORRECTION_TRANSMIT);
    COPY(CORRECTION_ABERRATION_YEARLY);
    COPY(CORRECTION_ABERRATION_DIURNAL);
#undef COPY
#undef COPY_CAST
    for (size_t i = 0; i < root.OBSERVATIONS.size(); ++i) {
        if (!root.OBSERVATIONS[i]) continue;
        std::unique_ptr< ::TDMObservationT> row(new ::TDMObservationT(*root.OBSERVATIONS[i]));
        dst->OBSERVATIONS.push_back(std::move(row));
    }
}

/* True when the root carries observation data ONLY in the legacy parallel
 * arrays, whose epochs exist nowhere and would have to be computed. */
inline bool root_has_only_gridded_arrays(const ::TDMT& root) {
    return root.SEGMENTS.empty() && root.OBSERVATIONS.empty() &&
           (!root.RECEIVE_FREQ.empty() || !root.ANGLE_1.empty() || !root.ANGLE_2.empty() ||
            !root.TROPO_DRY.empty() || !root.TROPO_WET.empty() || !root.STEC.empty() ||
            !root.PRESSURE.empty() || !root.RHUMIDITY.empty() || !root.TEMPERATURE.empty() ||
            !root.CLOCK_BIAS.empty() || !root.CLOCK_DRIFT.empty() ||
            !root.SIGNAL_TO_NOISE.empty() || !root.SPECTRAL_MAX.empty() ||
            !root.DOPPLER_NOISE_HZ.empty());
}

inline ProjectionStatus segment_to_view(const ::TDMSegmentT& src, Segment* seg,
                                        ProjectionReport* rep, size_t si) {
    std::vector<kvn::Entry>& meta = seg->metadata;
#define PUT_S(KEY) detail::push_entry(&meta, #KEY, src.KEY)
#define PUT_D(KEY)                                                          \
    do {                                                                     \
        if (src.KEY != 0) {                                                  \
            if (!std::isfinite(static_cast<double>(src.KEY))) return ProjectionStatus::NonFiniteValue; \
            detail::push_entry(&meta, #KEY,                                  \
                               sdsproj::format_number(static_cast<double>(src.KEY))); \
        }                                                                    \
    } while (0)
#define PUT_I(KEY)                                                          \
    do {                                                                     \
        if (src.KEY != 0) {                                                  \
            detail::push_entry(&meta, #KEY,                                  \
                               sdsproj::format_integer(static_cast<long long>(src.KEY))); \
        }                                                                    \
    } while (0)
#define PUT_B(KEY)                                                          \
    do {                                                                     \
        if (src.KEY) detail::push_entry(&meta, #KEY, "YES");                 \
    } while (0)

    PUT_S(MESSAGE_ID);
    PUT_S(TRACK_ID);
    PUT_S(DATA_TYPES);
    PUT_S(TIME_SYSTEM);
    PUT_S(START_TIME);
    PUT_S(STOP_TIME);
    PUT_S(PARTICIPANT_1);
    PUT_S(PARTICIPANT_2);
    PUT_S(PARTICIPANT_3);
    PUT_S(PARTICIPANT_4);
    PUT_S(PARTICIPANT_5);
    PUT_S(MODE);
    PUT_S(PATH);
    PUT_I(PATH_1);
    PUT_I(PATH_2);
    PUT_S(EPHEMERIS_NAME_1);
    PUT_S(EPHEMERIS_NAME_2);
    PUT_S(EPHEMERIS_NAME_3);
    PUT_S(EPHEMERIS_NAME_4);
    PUT_S(EPHEMERIS_NAME_5);
    PUT_S(TRANSMIT_BAND);
    PUT_S(RECEIVE_BAND);
    PUT_I(TURNAROUND_NUMERATOR);
    PUT_I(TURNAROUND_DENOMINATOR);
    PUT_S(TIMETAG_REF);
    PUT_D(INTEGRATION_INTERVAL);
    PUT_S(INTEGRATION_REF);
    PUT_D(FREQ_OFFSET);
    PUT_S(RANGE_MODE);
    PUT_D(RANGE_MODULUS);
    PUT_S(RANGE_UNITS);
    PUT_S(ANGLE_TYPE);
    PUT_S(REFERENCE_FRAME);
    PUT_S(INTERPOLATION);
    PUT_I(INTERPOLATION_DEGREE);
    PUT_D(DOPPLER_COUNT_BIAS);
    PUT_I(DOPPLER_COUNT_SCALE);
    PUT_B(DOPPLER_COUNT_ROLLOVER);
    PUT_D(TRANSMIT_DELAY_1);
    PUT_D(TRANSMIT_DELAY_2);
    PUT_D(TRANSMIT_DELAY_3);
    PUT_D(TRANSMIT_DELAY_4);
    PUT_D(TRANSMIT_DELAY_5);
    PUT_D(RECEIVE_DELAY_1);
    PUT_D(RECEIVE_DELAY_2);
    PUT_D(RECEIVE_DELAY_3);
    PUT_D(RECEIVE_DELAY_4);
    PUT_D(RECEIVE_DELAY_5);
    PUT_D(TRANSMIT_FREQ_1);
    PUT_D(TRANSMIT_FREQ_2);
    PUT_D(TRANSMIT_FREQ_3);
    PUT_D(TRANSMIT_FREQ_4);
    PUT_D(TRANSMIT_FREQ_5);
    PUT_D(TRANSMIT_FREQ_RATE_1);
    PUT_D(TRANSMIT_FREQ_RATE_2);
    PUT_D(TRANSMIT_FREQ_RATE_3);
    PUT_D(TRANSMIT_FREQ_RATE_4);
    PUT_D(TRANSMIT_FREQ_RATE_5);
    PUT_S(DATA_QUALITY);
    PUT_D(CORRECTION_ANGLE_1);
    PUT_D(CORRECTION_ANGLE_2);
    PUT_D(CORRECTION_DOPPLER);
    PUT_D(CORRECTION_MAG);
    PUT_D(CORRECTION_RANGE);
    PUT_D(CORRECTION_RCS);
    PUT_D(CORRECTION_RECEIVE);
    PUT_D(CORRECTION_TRANSMIT);
    PUT_D(CORRECTION_ABERRATION_YEARLY);
    PUT_D(CORRECTION_ABERRATION_DIURNAL);
    PUT_S(CORRECTIONS_APPLIED);

#undef PUT_S
#undef PUT_D
#undef PUT_I
#undef PUT_B

    detail::attach_comments(&meta, 0, src.COMMENT);

    seg->has_data_block = !src.DATA_START.empty() || !src.OBSERVATIONS.empty();
    seg->observations.reserve(src.OBSERVATIONS.size());
    for (size_t oi = 0; oi < src.OBSERVATIONS.size(); ++oi) {
        const ::TDMObservationT* row = src.OBSERVATIONS[oi].get();
        if (!row) continue;
        if (!std::isfinite(row->VALUE)) {
            rep->segment = si;
            rep->observation = oi;
            return ProjectionStatus::NonFiniteValue;
        }
        Observation obs;
        obs.keyword = row->KEYWORD;
        obs.epoch = row->EPOCH;
        obs.values.push_back(sdsproj::format_number(row->VALUE));
        seg->observations.push_back(obs);
    }
    return ProjectionStatus::Ok;
}

}  // namespace detail

inline ProjectionStatus from_record(const ::TDMT& rec, Message* out,
                                    ProjectionReport* report = nullptr) {
    ProjectionReport local;
    ProjectionReport* rep = report ? report : &local;
    *rep = ProjectionReport{};
    if (!out) {
        rep->status = ProjectionStatus::NullArgument;
        return rep->status;
    }
    *out = Message{};

    if (!rec.SEGMENTS.empty() && !rec.OBSERVATIONS.empty()) {
        rep->status = ProjectionStatus::BothFormsPopulated;
        return rep->status;
    }
    if (detail::root_has_only_gridded_arrays(rec)) {
        /* Form 3: the parallel arrays on the implicit
         * OBSERVATION_START_TIME + i * OBSERVATION_STEP_SIZE grid. Rebuilding an
         * epoch text from that needs the leap-second table `foundation/time`
         * owns; refusing names the missing dependency rather than inventing
         * timestamps that look exactly like measured ones. */
        rep->status = ProjectionStatus::UniformGridNeedsTimeMath;
        return rep->status;
    }

    detail::push_entry(&out->header, "CCSDS_TDM_VERS", rec.CCSDS_TDM_VERS);
    const size_t header_comment_host = out->header.size();
    detail::push_entry(&out->header, "CREATION_DATE", rec.CREATION_DATE);
    detail::push_entry(&out->header, "ORIGINATOR", rec.ORIGINATOR);
    detail::push_entry(&out->header, "MESSAGE_ID", rec.MESSAGE_ID);
    detail::attach_comments(&out->header, header_comment_host, rec.COMMENT);

    if (!rec.SEGMENTS.empty()) {
        out->segments.reserve(rec.SEGMENTS.size());
        for (size_t si = 0; si < rec.SEGMENTS.size(); ++si) {
            if (!rec.SEGMENTS[si]) continue;
            Segment seg;
            const ProjectionStatus st = detail::segment_to_view(*rec.SEGMENTS[si], &seg, rep, si);
            if (st != ProjectionStatus::Ok) {
                rep->status = st;
                *out = Message{};
                return st;
            }
            out->segments.push_back(seg);
        }
        return ProjectionStatus::Ok;
    }

    if (!rec.OBSERVATIONS.empty()) {
        ::TDMSegmentT folded;
        detail::segment_from_root(rec, &folded);
        Segment seg;
        const ProjectionStatus st = detail::segment_to_view(folded, &seg, rep, 0);
        if (st != ProjectionStatus::Ok) {
            rep->status = st;
            *out = Message{};
            return st;
        }
        out->segments.push_back(seg);
    }
    return ProjectionStatus::Ok;
}

/* ------------------------------------------------------------------------ */
/* $TDM -> canonical JSON                                                    */
/* ------------------------------------------------------------------------ */

#define J_STR(FIELD)                                     \
    do {                                                 \
        sdsproj::json_key(out, #FIELD, &first);          \
        if (o.FIELD.empty()) *out += "null";             \
        else sdsproj::json_escape(out, o.FIELD);         \
    } while (0)
#define J_NUM(FIELD)                                     \
    do {                                                 \
        sdsproj::json_key(out, #FIELD, &first);          \
        sdsproj::json_number(out, static_cast<double>(o.FIELD)); \
    } while (0)
#define J_INT(FIELD)                                     \
    do {                                                 \
        sdsproj::json_key(out, #FIELD, &first);          \
        *out += sdsproj::format_integer(static_cast<long long>(o.FIELD)); \
    } while (0)
#define J_BOOL(FIELD)                                    \
    do {                                                 \
        sdsproj::json_key(out, #FIELD, &first);          \
        *out += o.FIELD ? "true" : "false";              \
    } while (0)
#define J_STRVEC(FIELD)                                  \
    do {                                                 \
        sdsproj::json_key(out, #FIELD, &first);          \
        *out += '[';                                     \
        for (size_t i = 0; i < o.FIELD.size(); ++i) {    \
            if (i) *out += ',';                          \
            sdsproj::json_escape(out, o.FIELD[i]);       \
        }                                                \
        *out += ']';                                     \
    } while (0)
#define J_NUMVEC(FIELD)                                  \
    do {                                                 \
        sdsproj::json_key(out, #FIELD, &first);          \
        *out += '[';                                     \
        for (size_t i = 0; i < o.FIELD.size(); ++i) {    \
            if (i) *out += ',';                          \
            sdsproj::json_number(out, static_cast<double>(o.FIELD[i])); \
        }                                                \
        *out += ']';                                     \
    } while (0)
#define J_TABLEVEC(FIELD, EMITTER)                       \
    do {                                                 \
        sdsproj::json_key(out, #FIELD, &first);          \
        *out += '[';                                     \
        for (size_t i = 0; i < o.FIELD.size(); ++i) {    \
            if (i) *out += ',';                          \
            if (o.FIELD[i]) EMITTER(out, *o.FIELD[i]);   \
            else *out += "null";                         \
        }                                                \
        *out += ']';                                     \
    } while (0)

inline void json_tdm_transmit_ramp(std::string* out, const ::TDMTransmitRampT& o) {
    bool first = true;
    *out += '{';
    J_STR(START_TIME);
    J_STR(END_TIME);
    J_STR(REFERENCE_TIME);
    J_NUM(FREQUENCY_HZ);
    J_NUM(FREQUENCY_RATE_HZ_PER_S);
    J_STR(TRANSMITTING_STATION_ID);
    J_STR(TRANSMIT_BAND);
    *out += '}';
}

inline void json_tdm_observation(std::string* out, const ::TDMObservationT& o) {
    bool first = true;
    *out += '{';
    J_STR(KEYWORD);
    J_STR(EPOCH);
    J_NUM(VALUE);
    *out += '}';
}

inline void json_tdm_segment(std::string* out, const ::TDMSegmentT& o) {
    bool first = true;
    *out += '{';
    J_STRVEC(COMMENT);
    J_STR(META_START);
    J_STR(TIME_SYSTEM);
    J_STR(START_TIME);
    J_STR(STOP_TIME);
    J_STR(PARTICIPANT_1);
    J_STR(PARTICIPANT_2);
    J_STR(PARTICIPANT_3);
    J_STR(PARTICIPANT_4);
    J_STR(PARTICIPANT_5);
    J_STR(MODE);
    J_INT(PATH_1);
    J_INT(PATH_2);
    J_STR(TRANSMIT_BAND);
    J_STR(RECEIVE_BAND);
    J_NUM(INTEGRATION_INTERVAL);
    J_STR(INTEGRATION_REF);
    J_STR(TIMETAG_REF);
    J_STR(ANGLE_TYPE);
    J_STR(RANGE_MODE);
    J_NUM(RANGE_MODULUS);
    J_NUM(CORRECTION_ANGLE_1);
    J_NUM(CORRECTION_ANGLE_2);
    J_STR(CORRECTIONS_APPLIED);
    J_STR(DATA_QUALITY);
    J_NUM(RECEIVE_DELAY_2);
    J_NUM(RECEIVE_DELAY_3);
    J_NUM(TRANSMIT_FREQ_1);
    J_NUM(TRANSMIT_FREQ_2);
    J_NUM(TRANSMIT_FREQ_3);
    J_NUM(TRANSMIT_FREQ_4);
    J_NUM(TRANSMIT_FREQ_5);
    J_NUM(TRANSMIT_FREQ_RATE_1);
    J_NUM(TRANSMIT_FREQ_RATE_2);
    J_NUM(TRANSMIT_FREQ_RATE_3);
    J_NUM(TRANSMIT_FREQ_RATE_4);
    J_NUM(TRANSMIT_FREQ_RATE_5);
    J_STR(META_STOP);
    J_STR(DATA_START);
    J_TABLEVEC(OBSERVATIONS, json_tdm_observation);
    J_STR(DATA_STOP);
    J_TABLEVEC(TRANSMIT_RAMPS, json_tdm_transmit_ramp);
    J_STR(MESSAGE_ID);
    J_STR(TRACK_ID);
    J_STR(DATA_TYPES);
    J_STR(PATH);
    J_STR(EPHEMERIS_NAME_1);
    J_STR(EPHEMERIS_NAME_2);
    J_STR(EPHEMERIS_NAME_3);
    J_STR(EPHEMERIS_NAME_4);
    J_STR(EPHEMERIS_NAME_5);
    J_STR(RANGE_UNITS);
    J_STR(REFERENCE_FRAME);
    J_STR(INTERPOLATION);
    J_INT(INTERPOLATION_DEGREE);
    J_NUM(FREQ_OFFSET);
    J_INT(TURNAROUND_NUMERATOR);
    J_INT(TURNAROUND_DENOMINATOR);
    J_NUM(TRANSMIT_DELAY_1);
    J_NUM(TRANSMIT_DELAY_2);
    J_NUM(TRANSMIT_DELAY_3);
    J_NUM(TRANSMIT_DELAY_4);
    J_NUM(TRANSMIT_DELAY_5);
    J_NUM(RECEIVE_DELAY_1);
    J_NUM(RECEIVE_DELAY_4);
    J_NUM(RECEIVE_DELAY_5);
    J_NUM(DOPPLER_COUNT_BIAS);
    J_INT(DOPPLER_COUNT_SCALE);
    J_BOOL(DOPPLER_COUNT_ROLLOVER);
    J_NUM(CORRECTION_RANGE);
    J_NUM(CORRECTION_DOPPLER);
    J_NUM(CORRECTION_MAG);
    J_NUM(CORRECTION_RCS);
    J_NUM(CORRECTION_RECEIVE);
    J_NUM(CORRECTION_TRANSMIT);
    J_NUM(CORRECTION_ABERRATION_YEARLY);
    J_NUM(CORRECTION_ABERRATION_DIURNAL);
    *out += '}';
}

inline std::string to_json(const ::TDMT& o) {
    std::string json;
    std::string* out = &json;
    bool first = true;
    *out += '{';
    J_STR(OBSERVER_ID);
    J_NUM(OBSERVER_X);
    J_NUM(OBSERVER_Y);
    J_NUM(OBSERVER_Z);
    J_NUM(OBSERVER_VX);
    J_NUM(OBSERVER_VY);
    J_NUM(OBSERVER_VZ);
    /* OBSERVER_POSITION_REFERENCE_FRAME and OBS_REFERENCE_FRAME are $RFM union
     * tables with no JSON-trivial form, and this projection never populates
     * them: a CCSDS TDM states its frame in the REFERENCE_FRAME keyword, which
     * is carried as the string the file wrote. Same treatment the $OMM JSON
     * module gives the same union. */
    J_STR(EPOCH);
    J_NUM(OBSERVATION_STEP_SIZE);
    J_STR(OBSERVATION_START_TIME);
    J_STR(CCSDS_TDM_VERS);
    J_STRVEC(COMMENT);
    J_STR(CREATION_DATE);
    J_STR(ORIGINATOR);
    J_STR(META_START);
    J_STR(TIME_SYSTEM);
    J_STR(START_TIME);
    J_STR(STOP_TIME);
    J_STR(PARTICIPANT_1);
    J_STR(PARTICIPANT_2);
    J_STR(PARTICIPANT_3);
    J_STR(PARTICIPANT_4);
    J_STR(PARTICIPANT_5);
    J_STR(MODE);
    J_INT(PATH_1);
    J_INT(PATH_2);
    J_STR(TRANSMIT_BAND);
    J_STR(RECEIVE_BAND);
    J_NUM(INTEGRATION_INTERVAL);
    J_STR(INTEGRATION_REF);
    J_NUM(RECEIVE_DELAY_2);
    J_NUM(RECEIVE_DELAY_3);
    J_STR(DATA_QUALITY);
    J_STR(META_STOP);
    J_STR(DATA_START);
    J_NUM(TRANSMIT_FREQ_1);
    J_NUMVEC(RECEIVE_FREQ);
    J_STR(DATA_STOP);
    J_STR(TIMETAG_REF);
    J_STR(ANGLE_TYPE);
    J_NUMVEC(ANGLE_1);
    J_NUMVEC(ANGLE_2);
    J_NUM(ANGLE_UNCERTAINTY_1);
    J_NUM(ANGLE_UNCERTAINTY_2);
    J_NUM(RANGE_RATE);
    J_NUM(RANGE_UNCERTAINTY);
    J_STR(RANGE_MODE);
    J_NUM(RANGE_MODULUS);
    J_NUM(CORRECTION_ANGLE_1);
    J_NUM(CORRECTION_ANGLE_2);
    J_STR(CORRECTIONS_APPLIED);
    J_NUMVEC(TROPO_DRY);
    J_NUMVEC(TROPO_WET);
    J_NUMVEC(STEC);
    J_NUMVEC(PRESSURE);
    J_NUMVEC(RHUMIDITY);
    J_NUMVEC(TEMPERATURE);
    J_NUMVEC(CLOCK_BIAS);
    J_NUMVEC(CLOCK_DRIFT);
    J_NUMVEC(SIGNAL_TO_NOISE);
    J_NUMVEC(SPECTRAL_MAX);
    J_NUMVEC(DOPPLER_NOISE_HZ);
    J_TABLEVEC(TRANSMIT_RAMPS, json_tdm_transmit_ramp);
    J_TABLEVEC(OBSERVATIONS, json_tdm_observation);
    J_TABLEVEC(SEGMENTS, json_tdm_segment);
    J_NUM(TRANSMIT_FREQ_2);
    J_NUM(TRANSMIT_FREQ_3);
    J_NUM(TRANSMIT_FREQ_4);
    J_NUM(TRANSMIT_FREQ_5);
    J_NUM(TRANSMIT_FREQ_RATE_1);
    J_NUM(TRANSMIT_FREQ_RATE_2);
    J_NUM(TRANSMIT_FREQ_RATE_3);
    J_NUM(TRANSMIT_FREQ_RATE_4);
    J_NUM(TRANSMIT_FREQ_RATE_5);
    J_STR(MESSAGE_ID);
    J_STR(TRACK_ID);
    J_STR(DATA_TYPES);
    J_STR(PATH);
    J_STR(EPHEMERIS_NAME_1);
    J_STR(EPHEMERIS_NAME_2);
    J_STR(EPHEMERIS_NAME_3);
    J_STR(EPHEMERIS_NAME_4);
    J_STR(EPHEMERIS_NAME_5);
    J_STR(RANGE_UNITS);
    J_STR(REFERENCE_FRAME);
    J_STR(INTERPOLATION);
    J_INT(INTERPOLATION_DEGREE);
    J_NUM(FREQ_OFFSET);
    J_INT(TURNAROUND_NUMERATOR);
    J_INT(TURNAROUND_DENOMINATOR);
    J_NUM(TRANSMIT_DELAY_1);
    J_NUM(TRANSMIT_DELAY_2);
    J_NUM(TRANSMIT_DELAY_3);
    J_NUM(TRANSMIT_DELAY_4);
    J_NUM(TRANSMIT_DELAY_5);
    J_NUM(RECEIVE_DELAY_1);
    J_NUM(RECEIVE_DELAY_4);
    J_NUM(RECEIVE_DELAY_5);
    J_NUM(DOPPLER_COUNT_BIAS);
    J_INT(DOPPLER_COUNT_SCALE);
    J_BOOL(DOPPLER_COUNT_ROLLOVER);
    J_NUM(CORRECTION_RANGE);
    J_NUM(CORRECTION_DOPPLER);
    J_NUM(CORRECTION_MAG);
    J_NUM(CORRECTION_RCS);
    J_NUM(CORRECTION_RECEIVE);
    J_NUM(CORRECTION_TRANSMIT);
    J_NUM(CORRECTION_ABERRATION_YEARLY);
    J_NUM(CORRECTION_ABERRATION_DIURNAL);
    *out += '}';
    return json;
}

#undef J_STR
#undef J_NUM
#undef J_INT
#undef J_BOOL
#undef J_STRVEC
#undef J_NUMVEC
#undef J_TABLEVEC

}  // namespace tdm
}  // namespace ccsds

#endif  // CCSDS_MESSAGES_TDM_PROJECTION_HPP
