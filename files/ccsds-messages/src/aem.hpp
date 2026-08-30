/*
 * files/ccsds-messages — CCSDS Attitude Ephemeris Message, structured view.
 *
 * WHAT THIS IS AND WHY IT SITS ON TOP OF kvn::Document RATHER THAN REPLACING IT
 *
 * kvn.hpp holds everything the file said, in the order it said it. That is the
 * layer the "every keyword round-trips exactly" acceptance is measured on, and
 * nothing here is allowed to weaken it. This header adds the two things a
 * consumer actually needs and the document model deliberately does not know:
 *
 *   1. NAMES. `segment.object_name()` instead of `find(meta, "OBJECT_NAME")`
 *      repeated at every call site, each with its own idea of what an absent
 *      key means.
 *   2. ROW WIDTH. An AEM data row is N numbers whose meaning is fixed by
 *      ATTITUDE_TYPE — 4 for QUATERNION, 8 for QUATERNION/DERIVATIVE, and so
 *      on. Nothing in the row itself says which; the metadata does.
 *
 * A Message here is a COPY of the ordered entries, not a pointer into the
 * source Document. That is what makes `to_document` a true inverse: build a
 * Message, hand it back, and the serialized text parses to the same structure
 * the original did. A view that only held pointers could be read but never
 * round-tripped, and the round trip is the acceptance.
 *
 * WHY A WRONG COMPONENT COUNT IS A REFUSAL
 *
 * If ATTITUDE_TYPE says QUATERNION and a row carries 7 numbers, one of two
 * things is true: the file is wrong, or the file is a type this reader does
 * not know. Both are facts the caller must see. Truncating to 4 would silently
 * produce a valid-looking attitude built from the wrong numbers — an attitude
 * that propagates, plots and publishes, and is not the one in the file. So the
 * count mismatch is `Status::ComponentCountMismatch` with the offending
 * segment, row, expected and actual carried out in a `Fault`, and no Message
 * is produced. There is no partial success here.
 *
 * NO TIME MATH
 *
 * Epochs stay strings, exactly as in kvn.hpp, for the same reason: converting
 * them needs the leap-second table `foundation/time` owns, and a second copy
 * of that table in this header is the drift this stack keeps paying for. Step
 * sizes, uniformity and ordering are questions for whoever holds the table.
 */

#ifndef CCSDS_MESSAGES_AEM_HPP
#define CCSDS_MESSAGES_AEM_HPP

#include "kvn.hpp"

#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace ccsds {
namespace aem {

enum class Status : int32_t {
    Ok = 0,
    NotAem = -10,                 /* the document's CCSDS_*_VERS is not CCSDS_AEM_VERS */
    MissingAttitudeType = -11,    /* mandatory metadata keyword absent (504.0-B-2 4.2.5) */
    UnknownAttitudeType = -12,    /* declared type is outside the published set          */
    ComponentCountMismatch = -13, /* row width disagrees with the declared type          */
    UnexpectedKeyedRow = -14,     /* a `KEY = ...` line inside an AEM data block          */
};

inline const char* status_name(Status s) {
    switch (s) {
        case Status::Ok: return "ok";
        case Status::NotAem: return "not-aem";
        case Status::MissingAttitudeType: return "missing-attitude-type";
        case Status::UnknownAttitudeType: return "unknown-attitude-type";
        case Status::ComponentCountMismatch: return "component-count-mismatch";
        case Status::UnexpectedKeyedRow: return "unexpected-keyed-row";
    }
    return "unknown";
}

/* ------------------------------------------------------------------------ */
/* Attitude type                                                             */
/* ------------------------------------------------------------------------ */

/*
 * The published spellings carry a SLASH, not an underscore: the Blue Books
 * write `QUATERNION/DERIVATIVE`, `EULER_ANGLE/RATE`, `SPIN/NUTATION`. The
 * underscore forms are how implementations name the enum, and files written by
 * those implementations do turn up with underscores. Both are accepted, by
 * normalising away `_` and `/` before the lookup — after that collapse the
 * eleven spellings below are still eleven distinct strings, so nothing is
 * merged that should stay apart.
 *
 * 504.0-B-2 renamed two of them (`EULER_ANGLE/RATE` -> `EULER_ANGLE/DERIVATIVE`)
 * and added three (`QUATERNION/ANGVEL`, `EULER_ANGLE/ANGVEL`,
 * `SPIN/NUTATION_MOM`). A B-1 file and a B-2 file therefore name the same
 * rotation differently; a reader that knew only one issue's spellings would
 * reject half the published corpus.
 */
enum class AttitudeType : int32_t {
    Unknown = 0,
    Quaternion,            /* 4: q1 q2 q3 qc, order per QUATERNION_TYPE          */
    QuaternionDerivative,  /* 8: quaternion + dq/dt                              */
    QuaternionRate,        /* 7: quaternion + Euler rates       (B-1 spelling)   */
    QuaternionAngvel,      /* 7: quaternion + angular velocity  (B-2 addition)   */
    EulerAngle,            /* 3: angles in EULER_ROT_SEQ order                   */
    EulerAngleRate,        /* 6: angles + rates  (B-1 `/RATE`, B-2 `/DERIVATIVE`)*/
    EulerAngleAngvel,      /* 6: angles + angular velocity      (B-2 addition)   */
    Spin,                  /* 4: spin RA, spin dec, spin angle, spin angle rate  */
    SpinNutation,          /* 7: spin 4 + nutation angle, period, phase          */
    SpinNutationMomentum,  /* 7: spin 4 + momentum RA, dec, nutation vel (B-2)   */
};

inline size_t components_for(AttitudeType t) {
    switch (t) {
        case AttitudeType::Quaternion: return 4;
        case AttitudeType::QuaternionDerivative: return 8;
        case AttitudeType::QuaternionRate: return 7;
        case AttitudeType::QuaternionAngvel: return 7;
        case AttitudeType::EulerAngle: return 3;
        case AttitudeType::EulerAngleRate: return 6;
        case AttitudeType::EulerAngleAngvel: return 6;
        case AttitudeType::Spin: return 4;
        case AttitudeType::SpinNutation: return 7;
        case AttitudeType::SpinNutationMomentum: return 7;
        case AttitudeType::Unknown: return 0;
    }
    return 0;
}

inline const char* attitude_type_name(AttitudeType t) {
    switch (t) {
        case AttitudeType::Quaternion: return "QUATERNION";
        case AttitudeType::QuaternionDerivative: return "QUATERNION/DERIVATIVE";
        case AttitudeType::QuaternionRate: return "QUATERNION/RATE";
        case AttitudeType::QuaternionAngvel: return "QUATERNION/ANGVEL";
        case AttitudeType::EulerAngle: return "EULER_ANGLE";
        case AttitudeType::EulerAngleRate: return "EULER_ANGLE/DERIVATIVE";
        case AttitudeType::EulerAngleAngvel: return "EULER_ANGLE/ANGVEL";
        case AttitudeType::Spin: return "SPIN";
        case AttitudeType::SpinNutation: return "SPIN/NUTATION";
        case AttitudeType::SpinNutationMomentum: return "SPIN/NUTATION_MOM";
        case AttitudeType::Unknown: return "";
    }
    return "";
}

/* Uppercase, minus the separators. See the comment on AttitudeType. */
inline std::string normalise_type(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (size_t i = 0; i < s.size(); ++i) {
        const char c = s[i];
        if (c == '_' || c == '/' || c == ' ' || c == '-') continue;
        out.push_back((c >= 'a' && c <= 'z') ? static_cast<char>(c - 'a' + 'A') : c);
    }
    return out;
}

inline AttitudeType attitude_type_from_text(const std::string& raw) {
    const std::string k = normalise_type(raw);
    if (k == "QUATERNION") return AttitudeType::Quaternion;
    if (k == "QUATERNIONDERIVATIVE") return AttitudeType::QuaternionDerivative;
    if (k == "QUATERNIONRATE") return AttitudeType::QuaternionRate;
    if (k == "QUATERNIONANGVEL") return AttitudeType::QuaternionAngvel;
    if (k == "EULERANGLE") return AttitudeType::EulerAngle;
    if (k == "EULERANGLERATE") return AttitudeType::EulerAngleRate;
    if (k == "EULERANGLEDERIVATIVE") return AttitudeType::EulerAngleRate;
    if (k == "EULERANGLEANGVEL") return AttitudeType::EulerAngleAngvel;
    if (k == "SPIN") return AttitudeType::Spin;
    if (k == "SPINNUTATION") return AttitudeType::SpinNutation;
    if (k == "SPINNUTATIONMOM") return AttitudeType::SpinNutationMomentum;
    if (k == "SPINNUTATIONMOMENTUM") return AttitudeType::SpinNutationMomentum;
    return AttitudeType::Unknown;
}

/* ------------------------------------------------------------------------ */
/* Rows                                                                      */
/* ------------------------------------------------------------------------ */

/*
 * One attitude record, or one comment that stood on its own line inside the
 * data block. The two share a struct because they share a POSITION: Figure G-5
 * puts `COMMENT Spin KF ground solution, SPINKF rates` between DATA_START and
 * the first record, and a model that dropped it, or hoisted it out of the
 * sequence, could not put it back where the file had it.
 *
 * `epoch` carries the comment text when `is_standalone_comment` is set. That
 * is kvn::DataLine's own convention, mirrored here on purpose: the inverse
 * mapping is then a field copy with no special case that could disagree.
 */
struct Row {
    std::string epoch;                        /* verbatim epoch token           */
    std::vector<std::string> components;      /* verbatim, exactly N of them    */
    std::vector<std::string> comments_before;
    bool is_standalone_comment = false;

    /* False rather than a NaN when the token is not a number: "the file said
     * something unparseable" and "the file said not-a-number" are different,
     * and only one of them should ever reach a propagator. */
    bool value(size_t index, double* out) const {
        if (index >= components.size() || !out) return false;
        bool ok = false;
        const double v = kvn::to_double(components[index], &ok);
        if (!ok) return false;
        *out = v;
        return true;
    }
};

/* ------------------------------------------------------------------------ */
/* Segment                                                                   */
/* ------------------------------------------------------------------------ */

/*
 * Generates `const char* fn() const` returning the metadata value, or nullptr
 * when the key is absent — nullptr and not "" for kvn::find's reason: a
 * defaulted CENTER_NAME must not be indistinguishable from a declared one.
 * A macro rather than seventeen hand-written bodies because the bodies would
 * be identical and the only thing worth reading, the keyword, stays visible
 * and greppable at each use.
 */
#define CCSDS_AEM_META(fn, KEY)                                        \
    const char* fn() const {                                           \
        const kvn::Entry* e = kvn::find(metadata, KEY);                \
        return e ? e->value.c_str() : nullptr;                         \
    }

struct Segment {
    std::vector<kvn::Entry> metadata;  /* verbatim and in order, comments included */
    std::vector<Row> rows;
    bool has_data_block = false;

    AttitudeType attitude_type = AttitudeType::Unknown;
    size_t components_per_row = 0;

    CCSDS_AEM_META(object_name, "OBJECT_NAME")
    CCSDS_AEM_META(object_id, "OBJECT_ID")
    CCSDS_AEM_META(center_name, "CENTER_NAME")
    CCSDS_AEM_META(ref_frame_a, "REF_FRAME_A")
    CCSDS_AEM_META(ref_frame_b, "REF_FRAME_B")
    CCSDS_AEM_META(attitude_dir, "ATTITUDE_DIR")
    CCSDS_AEM_META(time_system, "TIME_SYSTEM")
    CCSDS_AEM_META(start_time, "START_TIME")
    CCSDS_AEM_META(useable_start_time, "USEABLE_START_TIME")
    CCSDS_AEM_META(useable_stop_time, "USEABLE_STOP_TIME")
    CCSDS_AEM_META(stop_time, "STOP_TIME")
    CCSDS_AEM_META(attitude_type_text, "ATTITUDE_TYPE")
    CCSDS_AEM_META(quaternion_type, "QUATERNION_TYPE")
    CCSDS_AEM_META(euler_rot_seq, "EULER_ROT_SEQ")
    CCSDS_AEM_META(rate_frame, "RATE_FRAME")
    CCSDS_AEM_META(interpolation_method, "INTERPOLATION_METHOD")
    CCSDS_AEM_META(interpolation_degree_text, "INTERPOLATION_DEGREE")

    /* Anything the seventeen do not name. AEM metadata is an open set in
     * practice — producers add keywords the reader was not built for, and
     * losing them is exactly what this package exists to prevent. */
    const char* meta(const char* key) const {
        const kvn::Entry* e = kvn::find(metadata, key);
        return e ? e->value.c_str() : nullptr;
    }

    bool interpolation_degree(int64_t* out) const {
        const kvn::Entry* e = kvn::find(metadata, "INTERPOLATION_DEGREE");
        if (!e || e->value.empty() || !out) return false;
        char* end = nullptr;
        const long long v = std::strtoll(e->value.c_str(), &end, 10);
        if (!end || end == e->value.c_str()) return false;
        *out = static_cast<int64_t>(v);
        return true;
    }

    /* Attitude records only — the standalone comments are skipped, because a
     * caller asking "how many states" never means "including the prose". */
    size_t record_count() const {
        size_t n = 0;
        for (size_t i = 0; i < rows.size(); ++i) {
            if (!rows[i].is_standalone_comment) ++n;
        }
        return n;
    }
};

#undef CCSDS_AEM_META

/* ------------------------------------------------------------------------ */
/* Message                                                                   */
/* ------------------------------------------------------------------------ */

#define CCSDS_AEM_HEADER(fn, KEY)                                      \
    const char* fn() const {                                           \
        const kvn::Entry* e = kvn::find(header, KEY);                  \
        return e ? e->value.c_str() : nullptr;                         \
    }

struct Message {
    std::vector<kvn::Entry> header;
    std::vector<Segment> segments;

    CCSDS_AEM_HEADER(version, "CCSDS_AEM_VERS")
    CCSDS_AEM_HEADER(creation_date, "CREATION_DATE")
    CCSDS_AEM_HEADER(originator, "ORIGINATOR")
    CCSDS_AEM_HEADER(message_id, "MESSAGE_ID")

    const char* header_field(const char* key) const {
        const kvn::Entry* e = kvn::find(header, key);
        return e ? e->value.c_str() : nullptr;
    }
};

#undef CCSDS_AEM_HEADER

/*
 * Where a refusal happened. Zeroes mean "not applicable", which is safe only
 * because the Status says whether to read them at all.
 */
struct Fault {
    Status status = Status::Ok;
    size_t segment = 0;
    size_t row = 0;
    size_t expected = 0;
    size_t actual = 0;
};

/* ------------------------------------------------------------------------ */
/* Document -> Message                                                       */
/* ------------------------------------------------------------------------ */

inline Status from_document(const kvn::Document& doc, Message* out, Fault* fault = nullptr) {
    if (fault) *fault = Fault{};
    if (!out) return Status::NotAem;
    *out = Message{};
    if (doc.message_type != "AEM") {
        if (fault) fault->status = Status::NotAem;
        return Status::NotAem;
    }

    out->header = doc.header;
    out->segments.reserve(doc.segments.size());

    for (size_t si = 0; si < doc.segments.size(); ++si) {
        const kvn::Segment& src = doc.segments[si];
        Segment seg;
        seg.metadata = src.metadata;
        seg.has_data_block = src.has_data_block;

        const kvn::Entry* type_entry = kvn::find(src.metadata, "ATTITUDE_TYPE");
        if (!type_entry) {
            /* 504.0-B-2 makes ATTITUDE_TYPE mandatory in every metadata block,
             * with no default. Without it a row of numbers has no meaning at
             * all, so this refuses even for a segment that carries no data. */
            if (fault) { fault->status = Status::MissingAttitudeType; fault->segment = si; }
            return Status::MissingAttitudeType;
        }
        seg.attitude_type = attitude_type_from_text(type_entry->value);
        if (seg.attitude_type == AttitudeType::Unknown) {
            if (fault) { fault->status = Status::UnknownAttitudeType; fault->segment = si; }
            return Status::UnknownAttitudeType;
        }
        seg.components_per_row = components_for(seg.attitude_type);

        seg.rows.reserve(src.data.size());
        for (size_t di = 0; di < src.data.size(); ++di) {
            const kvn::DataLine& line = src.data[di];
            Row row;
            row.comments_before = line.comments_before;
            row.is_standalone_comment = line.is_standalone_comment;
            row.epoch = line.epoch;
            if (line.is_standalone_comment) {
                seg.rows.push_back(row);
                continue;
            }
            if (!line.key.empty()) {
                /* AEM data is columnar. A `KEY = value` line here is either a
                 * TDM body in an AEM envelope or a metadata keyword that
                 * escaped its block; guessing which would corrupt the record
                 * sequence either way. */
                if (fault) {
                    fault->status = Status::UnexpectedKeyedRow;
                    fault->segment = si;
                    fault->row = di;
                }
                return Status::UnexpectedKeyedRow;
            }
            row.components = line.tokens;
            if (row.components.size() != seg.components_per_row) {
                if (fault) {
                    fault->status = Status::ComponentCountMismatch;
                    fault->segment = si;
                    fault->row = di;
                    fault->expected = seg.components_per_row;
                    fault->actual = row.components.size();
                }
                return Status::ComponentCountMismatch;
            }
            seg.rows.push_back(row);
        }
        out->segments.push_back(seg);
    }
    return Status::Ok;
}

/* ------------------------------------------------------------------------ */
/* Message -> Document                                                       */
/* ------------------------------------------------------------------------ */

/*
 * The inverse. It is a field copy and nothing else: no canonical key order, no
 * reformatted numbers, no synthesised keywords. A builder that "tidied" its
 * output would make the structured view a lossy stage, and then the exactness
 * proven at the kvn layer would stop meaning anything for a caller that went
 * through here — which is every caller that edits a message.
 */
inline Status to_document(const Message& msg, kvn::Document* out) {
    if (!out) return Status::NotAem;
    *out = kvn::Document{};
    out->message_type = "AEM";
    out->header = msg.header;
    out->segments.reserve(msg.segments.size());
    for (size_t si = 0; si < msg.segments.size(); ++si) {
        const Segment& seg = msg.segments[si];
        kvn::Segment dst;
        dst.metadata = seg.metadata;
        dst.has_data_block = seg.has_data_block;
        dst.data.reserve(seg.rows.size());
        for (size_t ri = 0; ri < seg.rows.size(); ++ri) {
            const Row& row = seg.rows[ri];
            kvn::DataLine line;
            line.comments_before = row.comments_before;
            line.is_standalone_comment = row.is_standalone_comment;
            line.epoch = row.epoch;
            if (row.is_standalone_comment) {
                line.key = "COMMENT";
            } else {
                line.tokens = row.components;
            }
            dst.data.push_back(line);
        }
        out->segments.push_back(dst);
    }
    return Status::Ok;
}

/* Convenience: text straight to a Message. The intermediate Document is not
 * kept, so a caller that means to edit and re-emit should parse it itself. */
inline Status from_text(const char* text, size_t len, Message* out, Fault* fault = nullptr) {
    kvn::Document doc;
    const kvn::Status ks = kvn::parse(text, len, &doc);
    if (ks != kvn::Status::Ok) {
        if (fault) fault->status = Status::NotAem;
        return Status::NotAem;
    }
    return from_document(doc, out, fault);
}

/* ------------------------------------------------------------------------ */
/* SDS $AEM projection seam — deliberately empty at SDS 1.201.0              */
/* ------------------------------------------------------------------------ */
/*
 * Nothing projects a Message into `$AEM` here, and that is a finding rather
 * than an omission. At the pinned schema `$AEM` has no carrier for
 * CENTER_NAME, QUATERNION_TYPE, INTERPOLATION_METHOD, INTERPOLATION_DEGREE,
 * USEABLE_START_TIME, USEABLE_STOP_TIME or MESSAGE_ID, and it holds no epoch
 * per attitude state — it reconstructs them as START_TIME + i*STEP_SIZE.
 * Figure G-4's first segment steps 2336.3 s and then 1.0 s, so that grid
 * cannot express the published example at all; a projection written against
 * this pin would have to either drop records or invent epochs.
 *
 * When `upstream-spacedatastandards-10` lands the extension, the projection
 * attaches HERE and consumes `Message` as it stands. That is why `Message`
 * keeps `metadata` as an ordered kvn::Entry list rather than a struct of the
 * seventeen named keywords: the projection needs the keywords the record grows
 * next, and a struct would have to be edited in lockstep with the schema.
 */

}  // namespace aem
}  // namespace ccsds

#endif  // CCSDS_MESSAGES_AEM_HPP
