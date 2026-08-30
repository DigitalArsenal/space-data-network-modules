/*
 * files/ccsds-messages — the SDS `$AEM` projection.
 *
 * A `ccsds::aem::Message` in, an `AEMT` out, and back. This is the seam the
 * views were built around: the record is a set of NAMED FIELDS, the document is
 * an ORDERED LIST OF LINES, and turning one into the other is where every
 * lossy decision in this package lives. Putting it here keeps those decisions
 * in one file with one voice instead of scattered across call sites that each
 * guess differently.
 *
 * ALWAYS THE VERBOSE FORM
 *
 * `schema/AEM/main.fbs` declares the attitude rows twice and forbids populating
 * both: `STEP_SIZE > 0` selects the compact row-major `ATTITUDE_DATA` whose
 * epochs are reconstructed as `START_TIME + i * STEP_SIZE`, and `STEP_SIZE == 0`
 * selects `ATTITUDE_DATA_LINES`, one table per state with its own `EPOCH`. This
 * projection writes the VERBOSE form for every segment, uniform or not, and the
 * reason is not preference:
 *
 *   - Figure G-4 steps 2336.3 s, then 1.0 s, then 98398.0 s. The compact form
 *     cannot express it at all, so a projection that chose by measurement would
 *     need two code paths and only one of them would be exercised by the
 *     published corpus.
 *   - Choosing the compact form for Figure G-5 would mean COMPUTING a step size
 *     from two epoch strings, and reading it back would mean computing an epoch
 *     string from a start and a step. Both need the leap-second table
 *     `foundation/time` owns; kvn.hpp and aem.hpp refuse to carry a second copy
 *     of it, and this header is not the place that copy finally appears.
 *   - `2006-090T05:00:00.196` is a day-of-year epoch written to three decimals.
 *     Reconstructing it from a start plus an index would produce SOME correct
 *     instant in SOME format; it would not produce that text, and the text is
 *     what the round trip is measured on.
 *
 * So `STEP_SIZE` is left at 0 and `ATTITUDE_DATA` empty. Reading is symmetric
 * but not identical: a record that arrives in the compact form is REFUSED with
 * `CompactFormNeedsTimeMath` rather than guessed at, because inventing epochs is
 * the failure mode the whole package exists to prevent.
 *
 * WHAT THE RECORD CANNOT CARRY IS DECLARED, NOT DROPPED IN SILENCE
 *
 * `ProjectionReport::losses` names every keyword and every comment line the
 * record has no field for, with the segment it came from and the text it
 * carried. A caller can therefore ask "what will I lose" BEFORE it writes, and
 * the acceptance can assert that the set of round-trip differences is exactly
 * the set of declared losses — which is a far stronger statement than "the
 * fields we remembered to compare matched".
 *
 * At $AEM 2.0.2 the corpus produces exactly one such loss: Figure G-5 carries a
 * COMMENT line INSIDE its data block, and `AEMSegment.COMMENT` is defined as
 * the metadata block's comments. Putting a data-section comment there would
 * make the record say the file had it somewhere it did not.
 *
 * ABSENT IS NOT ZERO
 *
 * A FlatBuffers table omits a scalar equal to its type default, so a numeric
 * keyword written as `0` and a numeric keyword that was never written are the
 * same bytes. `from_record` therefore emits a numeric keyword only when the
 * value differs from the default, and `to_record` DECLARES a `DefaultValued`
 * loss on the way in for every keyword whose value cannot survive that rule.
 * Figure E-18's `FREQ_OFFSET = 0.0` is the corpus case; the alternative — always
 * emitting every numeric field — would invent forty keywords the file never had.
 *
 * NO FILESYSTEM, NO EXCEPTIONS, NO THROW. Every failure is a status code and a
 * report; a malformed record never produces a NaN and never traps.
 */

#ifndef CCSDS_MESSAGES_AEM_PROJECTION_HPP
#define CCSDS_MESSAGES_AEM_PROJECTION_HPP

#include "aem.hpp"
#include "generated/sds/AEM_generated.h"

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
 * This block is IDENTICAL in `tdm_projection.hpp`; whichever header is included
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
namespace aem {

/* ------------------------------------------------------------------------ */
/* Status                                                                    */
/* ------------------------------------------------------------------------ */

enum class ProjectionStatus : int32_t {
    Ok = 0,
    NullArgument = -50,
    MissingAttitudeType = -51,        /* a segment with no ATTITUDE_TYPE at all  */
    UnknownAttitudeType = -52,        /* a spelling outside the published set    */
    ComponentCountMismatch = -53,     /* a row is not as wide as its type says   */
    NonNumericComponent = -54,        /* an attitude column that is not a number */
    CompactFormNeedsTimeMath = -55,   /* STEP_SIZE > 0: epochs are not stored    */
    BothFormsPopulated = -56,         /* the IDL forbids this outright           */
    NonFiniteValue = -57,             /* a NaN or infinity in the record         */
};

inline const char* projection_status_name(ProjectionStatus s) {
    switch (s) {
        case ProjectionStatus::Ok: return "ok";
        case ProjectionStatus::NullArgument: return "null-argument";
        case ProjectionStatus::MissingAttitudeType: return "missing-attitude-type";
        case ProjectionStatus::UnknownAttitudeType: return "unknown-attitude-type";
        case ProjectionStatus::ComponentCountMismatch: return "component-count-mismatch";
        case ProjectionStatus::NonNumericComponent: return "non-numeric-component";
        case ProjectionStatus::CompactFormNeedsTimeMath: return "compact-form-needs-time-math";
        case ProjectionStatus::BothFormsPopulated: return "both-forms-populated";
        case ProjectionStatus::NonFiniteValue: return "non-finite-value";
    }
    return "unknown";
}

struct ProjectionReport {
    ProjectionStatus status = ProjectionStatus::Ok;
    /* Header and metadata keyword occurrences that landed in an IDL field, plus
     * every comment line the record carried. `mapped_keys + losses.size()` is
     * the whole keyword population of the message, which is what makes "nothing
     * was lost in silence" a measurable claim rather than a promise. */
    size_t mapped_keys = 0;
    std::vector<sdsproj::Loss> losses;
    size_t segment = 0;  /* where a refusal happened */
    size_t row = 0;
};

/* ------------------------------------------------------------------------ */
/* Field rosters — also the reconstruction order                             */
/* ------------------------------------------------------------------------ */

/*
 * CCSDS 504.0-B-2 table 4-2 (header) and table 4-3 (metadata) fix the order in
 * which these keywords appear. A record has fields, not lines, so re-emitting
 * has to CHOOSE an order; choosing the standard's own order is what makes the
 * published examples come back the way they went in, and it is the one choice
 * that is not arbitrary. A producer who wrote its metadata in some other order
 * gets it back in this one — the record never carried the order.
 */
inline const char* const* aem_header_keys(size_t* count) {
    static const char* const keys[] = {
        "CCSDS_AEM_VERS", "COMMENT", "CREATION_DATE", "ORIGINATOR", "MESSAGE_ID",
        "CLASSIFICATION",
    };
    *count = sizeof(keys) / sizeof(keys[0]);
    return keys;
}

inline const char* const* aem_segment_keys(size_t* count) {
    static const char* const keys[] = {
        "COMMENT", "OBJECT_NAME", "OBJECT_ID", "CENTER_NAME", "REF_FRAME_A",
        "REF_FRAME_B", "ATTITUDE_DIR", "TIME_SYSTEM", "START_TIME",
        "USEABLE_START_TIME", "USEABLE_STOP_TIME", "STOP_TIME", "ATTITUDE_TYPE",
        "EULER_ROT_SEQ", "ANGVEL_FRAME", "INTERPOLATION_METHOD",
        "INTERPOLATION_DEGREE", "CLASSIFICATION",
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

/*
 * The attitude columns a type populates, in the order a CCSDS data row writes
 * them (504.0-B-2 table 4-4, restated in the schema's own comment on
 * `attitudeDataLine`). Member pointers rather than a switch per direction:
 * one table serves both `to_record` and `from_record`, so the two cannot
 * disagree about which column is which.
 *
 * The two B-1 spellings map onto the B-2 columns the rename produced:
 * `QUATERNION/RATE`'s rate triple is B-2's ANGVEL_*, and `EULER_ANGLE/RATE`'s
 * is B-2's ANGLE_*_DOT. B-2 renamed those keywords; it did not add a second
 * set of columns for the old ones.
 */
typedef double ::attitudeDataLineT::*Column;

inline size_t columns_for(AttitudeType t, Column* out) {
    switch (t) {
        case AttitudeType::Quaternion:
            out[0] = &::attitudeDataLineT::Q1; out[1] = &::attitudeDataLineT::Q2;
            out[2] = &::attitudeDataLineT::Q3; out[3] = &::attitudeDataLineT::QC;
            return 4;
        case AttitudeType::QuaternionDerivative:
            out[0] = &::attitudeDataLineT::Q1; out[1] = &::attitudeDataLineT::Q2;
            out[2] = &::attitudeDataLineT::Q3; out[3] = &::attitudeDataLineT::QC;
            out[4] = &::attitudeDataLineT::Q1_DOT; out[5] = &::attitudeDataLineT::Q2_DOT;
            out[6] = &::attitudeDataLineT::Q3_DOT; out[7] = &::attitudeDataLineT::QC_DOT;
            return 8;
        case AttitudeType::QuaternionRate:
        case AttitudeType::QuaternionAngvel:
            out[0] = &::attitudeDataLineT::Q1; out[1] = &::attitudeDataLineT::Q2;
            out[2] = &::attitudeDataLineT::Q3; out[3] = &::attitudeDataLineT::QC;
            out[4] = &::attitudeDataLineT::ANGVEL_X; out[5] = &::attitudeDataLineT::ANGVEL_Y;
            out[6] = &::attitudeDataLineT::ANGVEL_Z;
            return 7;
        case AttitudeType::EulerAngle:
            out[0] = &::attitudeDataLineT::ANGLE_1; out[1] = &::attitudeDataLineT::ANGLE_2;
            out[2] = &::attitudeDataLineT::ANGLE_3;
            return 3;
        case AttitudeType::EulerAngleRate:
            out[0] = &::attitudeDataLineT::ANGLE_1; out[1] = &::attitudeDataLineT::ANGLE_2;
            out[2] = &::attitudeDataLineT::ANGLE_3;
            out[3] = &::attitudeDataLineT::ANGLE_1_DOT;
            out[4] = &::attitudeDataLineT::ANGLE_2_DOT;
            out[5] = &::attitudeDataLineT::ANGLE_3_DOT;
            return 6;
        case AttitudeType::EulerAngleAngvel:
            out[0] = &::attitudeDataLineT::ANGLE_1; out[1] = &::attitudeDataLineT::ANGLE_2;
            out[2] = &::attitudeDataLineT::ANGLE_3;
            out[3] = &::attitudeDataLineT::ANGVEL_X; out[4] = &::attitudeDataLineT::ANGVEL_Y;
            out[5] = &::attitudeDataLineT::ANGVEL_Z;
            return 6;
        case AttitudeType::Spin:
            out[0] = &::attitudeDataLineT::SPIN_ALPHA; out[1] = &::attitudeDataLineT::SPIN_DELTA;
            out[2] = &::attitudeDataLineT::SPIN_ANGLE;
            out[3] = &::attitudeDataLineT::SPIN_ANGLE_VEL;
            return 4;
        case AttitudeType::SpinNutation:
            out[0] = &::attitudeDataLineT::SPIN_ALPHA; out[1] = &::attitudeDataLineT::SPIN_DELTA;
            out[2] = &::attitudeDataLineT::SPIN_ANGLE;
            out[3] = &::attitudeDataLineT::SPIN_ANGLE_VEL;
            out[4] = &::attitudeDataLineT::NUTATION;
            out[5] = &::attitudeDataLineT::NUTATION_PER;
            out[6] = &::attitudeDataLineT::NUTATION_PHASE;
            return 7;
        case AttitudeType::SpinNutationMomentum:
            out[0] = &::attitudeDataLineT::SPIN_ALPHA; out[1] = &::attitudeDataLineT::SPIN_DELTA;
            out[2] = &::attitudeDataLineT::SPIN_ANGLE;
            out[3] = &::attitudeDataLineT::SPIN_ANGLE_VEL;
            out[4] = &::attitudeDataLineT::MOMENTUM_ALPHA;
            out[5] = &::attitudeDataLineT::MOMENTUM_DELTA;
            out[6] = &::attitudeDataLineT::NUTATION_VEL;
            return 7;
        case AttitudeType::Unknown:
            return 0;
    }
    return 0;
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
        /* An empty string is how a FlatBuffers table spells "absent"; the
         * keyword would not come back. A keyword is counted MAPPED only when it
         * is actually carried, so `mapped + lost` stays exactly the number of
         * keywords in the file. */
        declare_loss(rep, scope, key, e->value, sdsproj::LossReason::DefaultValued);
        return false;
    }
    *dst = e->value;
    ++rep->mapped_keys;
    return true;
}

inline bool take_uint(const std::vector<kvn::Entry>& src, const char* key, uint32_t* dst,
                      ProjectionReport* rep, size_t scope) {
    const kvn::Entry* e = kvn::find(src, key);
    if (!e) return false;
    double v = 0.0;
    if (!sdsproj::parse_full_number(e->value, &v) || v < 0.0 || v != std::floor(v)) {
        declare_loss(rep, scope, key, e->value, sdsproj::LossReason::NotANumber);
        return false;
    }
    if (v == 0.0) {
        declare_loss(rep, scope, key, e->value, sdsproj::LossReason::DefaultValued);
        return false;
    }
    *dst = static_cast<uint32_t>(v);
    ++rep->mapped_keys;
    return true;
}

/*
 * Comments are carried where CCSDS puts them and nowhere else. `AEM.COMMENT` is
 * the header's comment lines and `AEMSegment.COMMENT` is the METADATA block's;
 * neither is a general comment bag. So a comment attached to the entry the
 * standard places comments before is carried, and any other comment — one
 * further down a metadata block, one inside a data block — is declared and
 * dropped rather than relocated into a block it was never in.
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
 * the one that follows CCSDS_AEM_VERS (504.0-B-2 table 4-2). */
inline size_t header_comment_host(const std::vector<kvn::Entry>& header) {
    for (size_t i = 0; i < header.size(); ++i) {
        if (!header[i].is_standalone_comment && header[i].key == "CCSDS_AEM_VERS") {
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
    /* Nothing followed the comments in the record, so they cannot be attached
     * to anything; standalone is where kvn.hpp puts a trailing comment. */
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
/* Message -> $AEM                                                           */
/* ------------------------------------------------------------------------ */

inline ProjectionStatus to_record(const Message& msg, ::AEMT* out,
                                  ProjectionReport* report = nullptr) {
    ProjectionReport local;
    ProjectionReport* rep = report ? report : &local;
    *rep = ProjectionReport{};
    if (!out) {
        rep->status = ProjectionStatus::NullArgument;
        return rep->status;
    }
    *out = ::AEMT{};

    size_t header_key_count = 0;
    const char* const* header_keys = aem_header_keys(&header_key_count);
    detail::take_comments(msg.header, detail::header_comment_host(msg.header), &out->COMMENT, rep,
                          sdsproj::kHeaderScope);
    detail::take_string(msg.header, "CCSDS_AEM_VERS", &out->CCSDS_AEM_VERS, rep,
                        sdsproj::kHeaderScope);
    detail::take_string(msg.header, "CREATION_DATE", &out->CREATION_DATE, rep,
                        sdsproj::kHeaderScope);
    detail::take_string(msg.header, "ORIGINATOR", &out->ORIGINATOR, rep, sdsproj::kHeaderScope);
    detail::take_string(msg.header, "MESSAGE_ID", &out->MESSAGE_ID, rep, sdsproj::kHeaderScope);
    detail::take_string(msg.header, "CLASSIFICATION", &out->CLASSIFICATION, rep,
                        sdsproj::kHeaderScope);
    for (size_t i = 0; i < msg.header.size(); ++i) {
        if (msg.header[i].is_standalone_comment) continue;
        if (detail::key_in(header_keys, header_key_count, msg.header[i].key)) continue;
        detail::declare_loss(rep, sdsproj::kHeaderScope, msg.header[i].key.c_str(),
                             msg.header[i].value, sdsproj::LossReason::NoCarrier);
    }

    size_t segment_key_count = 0;
    const char* const* segment_keys = aem_segment_keys(&segment_key_count);

    out->SEGMENTS.reserve(msg.segments.size());
    for (size_t si = 0; si < msg.segments.size(); ++si) {
        const Segment& src = msg.segments[si];
        std::unique_ptr< ::AEMSegmentT> seg(new ::AEMSegmentT());

        detail::take_comments(src.metadata, 0, &seg->COMMENT, rep, si);
        detail::take_string(src.metadata, "OBJECT_NAME", &seg->OBJECT_NAME, rep, si);
        detail::take_string(src.metadata, "OBJECT_ID", &seg->OBJECT_ID, rep, si);
        detail::take_string(src.metadata, "CENTER_NAME", &seg->CENTER_NAME, rep, si);
        detail::take_string(src.metadata, "REF_FRAME_A", &seg->REF_FRAME_A, rep, si);
        detail::take_string(src.metadata, "REF_FRAME_B", &seg->REF_FRAME_B, rep, si);
        detail::take_string(src.metadata, "ATTITUDE_DIR", &seg->ATTITUDE_DIR, rep, si);
        detail::take_string(src.metadata, "TIME_SYSTEM", &seg->TIME_SYSTEM, rep, si);
        detail::take_string(src.metadata, "START_TIME", &seg->START_TIME, rep, si);
        detail::take_string(src.metadata, "USEABLE_START_TIME", &seg->USEABLE_START_TIME, rep, si);
        detail::take_string(src.metadata, "USEABLE_STOP_TIME", &seg->USEABLE_STOP_TIME, rep, si);
        detail::take_string(src.metadata, "STOP_TIME", &seg->STOP_TIME, rep, si);
        detail::take_string(src.metadata, "ATTITUDE_TYPE", &seg->ATTITUDE_TYPE, rep, si);
        detail::take_string(src.metadata, "EULER_ROT_SEQ", &seg->EULER_ROT_SEQ, rep, si);
        detail::take_string(src.metadata, "ANGVEL_FRAME", &seg->ANGVEL_FRAME, rep, si);
        detail::take_string(src.metadata, "INTERPOLATION_METHOD", &seg->INTERPOLATION_METHOD, rep,
                            si);
        detail::take_uint(src.metadata, "INTERPOLATION_DEGREE", &seg->INTERPOLATION_DEGREE, rep, si);
        detail::take_string(src.metadata, "CLASSIFICATION", &seg->CLASSIFICATION, rep, si);
        for (size_t i = 0; i < src.metadata.size(); ++i) {
            if (src.metadata[i].is_standalone_comment) continue;
            if (detail::key_in(segment_keys, segment_key_count, src.metadata[i].key)) continue;
            detail::declare_loss(rep, si, src.metadata[i].key.c_str(), src.metadata[i].value,
                                 sdsproj::LossReason::NoCarrier);
        }

        if (src.attitude_type == AttitudeType::Unknown) {
            rep->status = seg->ATTITUDE_TYPE.empty() ? ProjectionStatus::MissingAttitudeType
                                                     : ProjectionStatus::UnknownAttitudeType;
            rep->segment = si;
            *out = ::AEMT{};
            return rep->status;
        }

        detail::Column columns[8];
        const size_t width = detail::columns_for(src.attitude_type, columns);
        seg->ATTITUDE_COMPONENTS = static_cast<uint8_t>(width);
        /* The verbose form, always. See the file header. */
        seg->STEP_SIZE = 0.0;

        for (size_t ri = 0; ri < src.rows.size(); ++ri) {
            const Row& row = src.rows[ri];
            if (row.is_standalone_comment) {
                detail::declare_loss(rep, si, "COMMENT", row.epoch,
                                     sdsproj::LossReason::NoCarrier);
                continue;
            }
            for (size_t c = 0; c < row.comments_before.size(); ++c) {
                detail::declare_loss(rep, si, "COMMENT", row.comments_before[c],
                                     sdsproj::LossReason::NoCarrier);
            }
            if (row.components.size() != width) {
                rep->status = ProjectionStatus::ComponentCountMismatch;
                rep->segment = si;
                rep->row = ri;
                *out = ::AEMT{};
                return rep->status;
            }
            std::unique_ptr< ::attitudeDataLineT> line(new ::attitudeDataLineT());
            line->EPOCH = row.epoch;
            for (size_t c = 0; c < width; ++c) {
                double v = 0.0;
                if (!sdsproj::parse_full_number(row.components[c], &v)) {
                    rep->status = ProjectionStatus::NonNumericComponent;
                    rep->segment = si;
                    rep->row = ri;
                    *out = ::AEMT{};
                    return rep->status;
                }
                (*line).*columns[c] = v;
            }
            seg->ATTITUDE_DATA_LINES.push_back(std::move(line));
        }

        if (src.has_data_block && seg->ATTITUDE_DATA_LINES.empty()) {
            /* An AEM segment may legally carry DATA_START/DATA_STOP with nothing
             * between them. `AEMSegment` has no marker field, so the empty block
             * itself is what cannot be carried — unlike `TDMSegment`, which does
             * carry its markers. */
            detail::declare_loss(rep, si, "DATA_START", std::string(),
                                 sdsproj::LossReason::NoCarrier);
        }
        out->SEGMENTS.push_back(std::move(seg));
    }
    return ProjectionStatus::Ok;
}

/* ------------------------------------------------------------------------ */
/* $AEM -> Message                                                           */
/* ------------------------------------------------------------------------ */

inline ProjectionStatus from_record(const ::AEMT& rec, Message* out,
                                    ProjectionReport* report = nullptr) {
    ProjectionReport local;
    ProjectionReport* rep = report ? report : &local;
    *rep = ProjectionReport{};
    if (!out) {
        rep->status = ProjectionStatus::NullArgument;
        return rep->status;
    }
    *out = Message{};

    detail::push_entry(&out->header, "CCSDS_AEM_VERS", rec.CCSDS_AEM_VERS);
    const size_t header_comment_host = out->header.size();
    detail::push_entry(&out->header, "CREATION_DATE", rec.CREATION_DATE);
    detail::push_entry(&out->header, "ORIGINATOR", rec.ORIGINATOR);
    detail::push_entry(&out->header, "MESSAGE_ID", rec.MESSAGE_ID);
    detail::push_entry(&out->header, "CLASSIFICATION", rec.CLASSIFICATION);
    detail::attach_comments(&out->header, header_comment_host, rec.COMMENT);

    out->segments.reserve(rec.SEGMENTS.size());
    for (size_t si = 0; si < rec.SEGMENTS.size(); ++si) {
        const ::AEMSegmentT* src = rec.SEGMENTS[si].get();
        if (!src) continue;

        if (src->STEP_SIZE != 0.0 || !src->ATTITUDE_DATA.empty()) {
            if (!src->ATTITUDE_DATA_LINES.empty()) {
                rep->status = ProjectionStatus::BothFormsPopulated;
                rep->segment = si;
                *out = Message{};
                return rep->status;
            }
            /* The compact form stores no epoch per state; rebuilding them is
             * `START_TIME + i * STEP_SIZE` on a declared TIME_SYSTEM, which
             * needs the leap-second table `foundation/time` owns. Refusing names
             * the missing dependency; guessing would put invented epochs into a
             * document that looks exactly like a real one. */
            rep->status = ProjectionStatus::CompactFormNeedsTimeMath;
            rep->segment = si;
            *out = Message{};
            return rep->status;
        }

        Segment seg;
        seg.attitude_type = attitude_type_from_text(src->ATTITUDE_TYPE);
        if (seg.attitude_type == AttitudeType::Unknown) {
            rep->status = src->ATTITUDE_TYPE.empty() ? ProjectionStatus::MissingAttitudeType
                                                     : ProjectionStatus::UnknownAttitudeType;
            rep->segment = si;
            *out = Message{};
            return rep->status;
        }
        detail::Column columns[8];
        const size_t width = detail::columns_for(seg.attitude_type, columns);
        seg.components_per_row = width;

        detail::push_entry(&seg.metadata, "OBJECT_NAME", src->OBJECT_NAME);
        detail::push_entry(&seg.metadata, "OBJECT_ID", src->OBJECT_ID);
        detail::push_entry(&seg.metadata, "CENTER_NAME", src->CENTER_NAME);
        detail::push_entry(&seg.metadata, "REF_FRAME_A", src->REF_FRAME_A);
        detail::push_entry(&seg.metadata, "REF_FRAME_B", src->REF_FRAME_B);
        detail::push_entry(&seg.metadata, "ATTITUDE_DIR", src->ATTITUDE_DIR);
        detail::push_entry(&seg.metadata, "TIME_SYSTEM", src->TIME_SYSTEM);
        detail::push_entry(&seg.metadata, "START_TIME", src->START_TIME);
        detail::push_entry(&seg.metadata, "USEABLE_START_TIME", src->USEABLE_START_TIME);
        detail::push_entry(&seg.metadata, "USEABLE_STOP_TIME", src->USEABLE_STOP_TIME);
        detail::push_entry(&seg.metadata, "STOP_TIME", src->STOP_TIME);
        detail::push_entry(&seg.metadata, "ATTITUDE_TYPE", src->ATTITUDE_TYPE);
        detail::push_entry(&seg.metadata, "EULER_ROT_SEQ", src->EULER_ROT_SEQ);
        detail::push_entry(&seg.metadata, "ANGVEL_FRAME", src->ANGVEL_FRAME);
        detail::push_entry(&seg.metadata, "INTERPOLATION_METHOD", src->INTERPOLATION_METHOD);
        if (src->INTERPOLATION_DEGREE != 0) {
            detail::push_entry(&seg.metadata, "INTERPOLATION_DEGREE",
                               sdsproj::format_integer(
                                   static_cast<long long>(src->INTERPOLATION_DEGREE)));
        }
        detail::push_entry(&seg.metadata, "CLASSIFICATION", src->CLASSIFICATION);
        detail::attach_comments(&seg.metadata, 0, src->COMMENT);

        seg.has_data_block = !src->ATTITUDE_DATA_LINES.empty();
        seg.rows.reserve(src->ATTITUDE_DATA_LINES.size());
        for (size_t ri = 0; ri < src->ATTITUDE_DATA_LINES.size(); ++ri) {
            const ::attitudeDataLineT* line = src->ATTITUDE_DATA_LINES[ri].get();
            if (!line) continue;
            Row row;
            row.epoch = line->EPOCH;
            row.components.reserve(width);
            for (size_t c = 0; c < width; ++c) {
                const double v = (*line).*columns[c];
                if (!std::isfinite(v)) {
                    rep->status = ProjectionStatus::NonFiniteValue;
                    rep->segment = si;
                    rep->row = ri;
                    *out = Message{};
                    return rep->status;
                }
                row.components.push_back(sdsproj::format_number(v));
            }
            seg.rows.push_back(row);
        }
        out->segments.push_back(seg);
    }
    return ProjectionStatus::Ok;
}

/* ------------------------------------------------------------------------ */
/* $AEM -> canonical JSON                                                    */
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

inline void json_attitude_data_line(std::string* out, const ::attitudeDataLineT& o) {
    bool first = true;
    *out += '{';
    J_STR(EPOCH);
    J_NUM(Q1);
    J_NUM(Q2);
    J_NUM(Q3);
    J_NUM(QC);
    J_NUM(Q1_DOT);
    J_NUM(Q2_DOT);
    J_NUM(Q3_DOT);
    J_NUM(QC_DOT);
    J_NUM(ANGLE_1);
    J_NUM(ANGLE_2);
    J_NUM(ANGLE_3);
    J_NUM(ANGLE_1_DOT);
    J_NUM(ANGLE_2_DOT);
    J_NUM(ANGLE_3_DOT);
    J_NUM(ANGVEL_X);
    J_NUM(ANGVEL_Y);
    J_NUM(ANGVEL_Z);
    J_NUM(SPIN_ALPHA);
    J_NUM(SPIN_DELTA);
    J_NUM(SPIN_ANGLE);
    J_NUM(SPIN_ANGLE_VEL);
    J_NUM(NUTATION);
    J_NUM(NUTATION_PER);
    J_NUM(NUTATION_PHASE);
    J_NUM(MOMENTUM_ALPHA);
    J_NUM(MOMENTUM_DELTA);
    J_NUM(NUTATION_VEL);
    *out += '}';
}

inline void json_aem_segment(std::string* out, const ::AEMSegmentT& o) {
    bool first = true;
    *out += '{';
    J_STR(OBJECT_NAME);
    J_STR(OBJECT_ID);
    J_STR(REF_FRAME_A);
    J_STR(REF_FRAME_B);
    J_STR(ATTITUDE_DIR);
    J_STR(TIME_SYSTEM);
    J_STR(ATTITUDE_TYPE);
    J_STR(START_TIME);
    J_STR(STOP_TIME);
    J_NUM(STEP_SIZE);
    J_INT(ATTITUDE_COMPONENTS);
    J_NUMVEC(ATTITUDE_DATA);
    J_STRVEC(COMMENT);
    J_STR(CENTER_NAME);
    J_STR(CLASSIFICATION);
    J_STR(USEABLE_START_TIME);
    J_STR(USEABLE_STOP_TIME);
    J_STR(EULER_ROT_SEQ);
    J_STR(ANGVEL_FRAME);
    J_STR(INTERPOLATION_METHOD);
    J_INT(INTERPOLATION_DEGREE);
    J_TABLEVEC(ATTITUDE_DATA_LINES, json_attitude_data_line);
    *out += '}';
}

inline std::string to_json(const ::AEMT& o) {
    std::string json;
    std::string* out = &json;
    bool first = true;
    *out += '{';
    J_STR(CCSDS_AEM_VERS);
    J_STR(CREATION_DATE);
    J_STR(ORIGINATOR);
    J_TABLEVEC(SEGMENTS, json_aem_segment);
    J_STR(MESSAGE_ID);
    J_STRVEC(COMMENT);
    J_STR(CLASSIFICATION);
    *out += '}';
    return json;
}

#undef J_STR
#undef J_NUM
#undef J_INT
#undef J_STRVEC
#undef J_NUMVEC
#undef J_TABLEVEC

}  // namespace aem
}  // namespace ccsds

#endif  // CCSDS_MESSAGES_AEM_PROJECTION_HPP
