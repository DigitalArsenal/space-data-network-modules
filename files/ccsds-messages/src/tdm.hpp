/*
 * files/ccsds-messages — CCSDS Tracking Data Message, structured view.
 *
 * THE SHAPE OF TDM DATA, AND WHY IT IS NOT A TABLE
 *
 * A TDM data block is a SEQUENCE of independent observations, each carrying
 * its own keyword and its own epoch:
 *
 *     RANGE         = 2011-05-11T10:26:33.9686  2799.8754
 *     CARRIER_POWER = 2011-05-11T10:26:33.9686   -36.67897415
 *     RCS           = 2011-05-11T10:26:33.7008     2.986
 *
 * Those three lines are Figure E-17 as published, and the last one's epoch is
 * EARLIER than the one above it. That is not a typo in our fixture: a tracking
 * station reports what its subsystems produce when they produce it, and the
 * format was designed to carry exactly that. It follows that:
 *
 *   - the observation list is never sorted, deduplicated or regrouped. Order
 *     is data. Two observations may share an epoch, an epoch may go backwards,
 *     and one keyword may appear a hundred times and another twice;
 *   - there is no row, no column and no grid. Any model that materialised
 *     parallel arrays on a common time base would have to either drop the RCS
 *     line above or move it, and both are lies about the measurement;
 *   - the observable keyword is carried as text and is NOT validated against a
 *     list. 503.0-B-2 Annex E alone uses 70 distinct keywords across its 18
 *     examples, the set differs between issues, and producers extend it. A
 *     reader that refused an unrecognised observable would reject published
 *     files to no benefit — the value is preserved either way, and a consumer
 *     that cannot interpret a keyword can say so with far more context here.
 *
 * Everything else follows aem.hpp: named accessors over an ordered metadata
 * copy, a builder that is a strict inverse, epochs left as strings because the
 * leap-second table lives in `foundation/time` and a second copy is drift.
 */

#ifndef CCSDS_MESSAGES_TDM_HPP
#define CCSDS_MESSAGES_TDM_HPP

#include "kvn.hpp"

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace ccsds {
namespace tdm {

enum class Status : int32_t {
    Ok = 0,
    NotTdm = -20,            /* the document's CCSDS_*_VERS is not CCSDS_TDM_VERS */
    UnkeyedObservation = -21,/* a columnar row inside a TDM data block            */
    MissingEpoch = -22,      /* `KEYWORD = ` with nothing after it                */
    EmptyObservation = -23,  /* an epoch with no measurement following it         */
};

inline const char* status_name(Status s) {
    switch (s) {
        case Status::Ok: return "ok";
        case Status::NotTdm: return "not-tdm";
        case Status::UnkeyedObservation: return "unkeyed-observation";
        case Status::MissingEpoch: return "missing-epoch";
        case Status::EmptyObservation: return "empty-observation";
    }
    return "unknown";
}

/* ------------------------------------------------------------------------ */
/* Observations                                                              */
/* ------------------------------------------------------------------------ */

/*
 * One observation, or one standalone COMMENT that held a line of its own in
 * the data block. As in aem.hpp, `epoch` carries the comment text when
 * `is_standalone_comment` is set — kvn::DataLine's convention, mirrored so the
 * inverse mapping is a field copy with no case that could disagree.
 *
 * `values` is a vector and not a double because a handful of observables carry
 * more than one number and because the TEXT is what round-trips: `2.984` and
 * `2.9840000000000002` are the same measurement and different files.
 */
struct Observation {
    std::string keyword;                  /* RANGE, ANGLE_1, RCS, ... verbatim   */
    std::string epoch;                    /* verbatim epoch token                */
    std::vector<std::string> values;      /* verbatim, usually one               */
    std::vector<std::string> comments_before;
    bool is_standalone_comment = false;

    bool value(size_t index, double* out) const {
        if (index >= values.size() || !out) return false;
        bool ok = false;
        const double v = kvn::to_double(values[index], &ok);
        if (!ok) return false;
        *out = v;
        return true;
    }
};

/* ------------------------------------------------------------------------ */
/* Segment                                                                   */
/* ------------------------------------------------------------------------ */

/* See the note in aem.hpp: identical bodies, and the keyword is the only part
 * worth reading, so it stays visible at each use. */
#define CCSDS_TDM_META(fn, KEY)                                        \
    const char* fn() const {                                           \
        const kvn::Entry* e = kvn::find(metadata, KEY);                \
        return e ? e->value.c_str() : nullptr;                         \
    }

struct Segment {
    std::vector<kvn::Entry> metadata;  /* verbatim and in order, comments included */
    std::vector<Observation> observations;
    bool has_data_block = false;

    CCSDS_TDM_META(time_system, "TIME_SYSTEM")
    CCSDS_TDM_META(start_time, "START_TIME")
    CCSDS_TDM_META(stop_time, "STOP_TIME")
    CCSDS_TDM_META(mode, "MODE")
    CCSDS_TDM_META(path, "PATH")
    CCSDS_TDM_META(ephemeris_name, "EPHEMERIS_NAME")
    CCSDS_TDM_META(transmit_band, "TRANSMIT_BAND")
    CCSDS_TDM_META(receive_band, "RECEIVE_BAND")
    CCSDS_TDM_META(turnaround_numerator, "TURNAROUND_NUMERATOR")
    CCSDS_TDM_META(turnaround_denominator, "TURNAROUND_DENOMINATOR")
    CCSDS_TDM_META(timetag_ref, "TIMETAG_REF")
    CCSDS_TDM_META(integration_interval, "INTEGRATION_INTERVAL")
    CCSDS_TDM_META(integration_ref, "INTEGRATION_REF")
    CCSDS_TDM_META(freq_offset, "FREQ_OFFSET")
    CCSDS_TDM_META(range_mode, "RANGE_MODE")
    CCSDS_TDM_META(range_modulus, "RANGE_MODULUS")
    CCSDS_TDM_META(range_units, "RANGE_UNITS")
    CCSDS_TDM_META(angle_type, "ANGLE_TYPE")
    CCSDS_TDM_META(reference_frame, "REFERENCE_FRAME")
    CCSDS_TDM_META(interpolation, "INTERPOLATION")
    CCSDS_TDM_META(interpolation_degree_text, "INTERPOLATION_DEGREE")
    CCSDS_TDM_META(data_quality, "DATA_QUALITY")
    CCSDS_TDM_META(data_types, "DATA_TYPES")
    CCSDS_TDM_META(track_id, "TRACK_ID")
    CCSDS_TDM_META(correction_angle_1, "CORRECTION_ANGLE_1")
    CCSDS_TDM_META(correction_angle_2, "CORRECTION_ANGLE_2")
    CCSDS_TDM_META(correction_doppler, "CORRECTION_DOPPLER")
    CCSDS_TDM_META(correction_mag, "CORRECTION_MAG")
    CCSDS_TDM_META(correction_range, "CORRECTION_RANGE")
    CCSDS_TDM_META(correction_rcs, "CORRECTION_RCS")
    CCSDS_TDM_META(correction_receive, "CORRECTION_RECEIVE")
    CCSDS_TDM_META(correction_transmit, "CORRECTION_TRANSMIT")
    CCSDS_TDM_META(correction_aberration_yearly, "CORRECTION_ABERRATION_YEARLY")
    CCSDS_TDM_META(correction_aberration_diurnal, "CORRECTION_ABERRATION_DIURNAL")
    CCSDS_TDM_META(corrections_applied, "CORRECTIONS_APPLIED")

    /* The indexed families. Written as a function of n rather than as five
     * accessors each, because the index is the only thing that varies and a
     * caller almost always has it in a variable already. */
    const char* participant(int n) const { return indexed("PARTICIPANT_%d", n); }
    const char* path_n(int n) const { return indexed("PATH_%d", n); }
    const char* transmit_delay(int n) const { return indexed("TRANSMIT_DELAY_%d", n); }
    const char* receive_delay(int n) const { return indexed("RECEIVE_DELAY_%d", n); }
    const char* ephemeris_name_n(int n) const { return indexed("EPHEMERIS_NAME_%d", n); }

    /* Everything the named accessors do not cover. TDM metadata is an open set
     * in practice and losing an unrecognised keyword is precisely what this
     * package exists to prevent. */
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

    /* Measurements only; standalone comments are not observations. */
    size_t observation_count() const {
        size_t n = 0;
        for (size_t i = 0; i < observations.size(); ++i) {
            if (!observations[i].is_standalone_comment) ++n;
        }
        return n;
    }

    /* How many times an observable appears. Not an index and not a filter,
     * because handing back a filtered copy would let a caller forget that the
     * position of each observation among the others is itself information. */
    size_t count_of(const char* keyword) const {
        size_t n = 0;
        for (size_t i = 0; i < observations.size(); ++i) {
            if (!observations[i].is_standalone_comment && observations[i].keyword == keyword) ++n;
        }
        return n;
    }

  private:
    const char* indexed(const char* pattern, int n) const {
        char key[64];
        std::snprintf(key, sizeof(key), pattern, n);
        const kvn::Entry* e = kvn::find(metadata, key);
        return e ? e->value.c_str() : nullptr;
    }
};

#undef CCSDS_TDM_META

/* ------------------------------------------------------------------------ */
/* Message                                                                   */
/* ------------------------------------------------------------------------ */

#define CCSDS_TDM_HEADER(fn, KEY)                                      \
    const char* fn() const {                                           \
        const kvn::Entry* e = kvn::find(header, KEY);                  \
        return e ? e->value.c_str() : nullptr;                         \
    }

struct Message {
    std::vector<kvn::Entry> header;
    std::vector<Segment> segments;

    CCSDS_TDM_HEADER(version, "CCSDS_TDM_VERS")
    CCSDS_TDM_HEADER(creation_date, "CREATION_DATE")
    CCSDS_TDM_HEADER(originator, "ORIGINATOR")
    CCSDS_TDM_HEADER(message_id, "MESSAGE_ID")

    const char* header_field(const char* key) const {
        const kvn::Entry* e = kvn::find(header, key);
        return e ? e->value.c_str() : nullptr;
    }
};

#undef CCSDS_TDM_HEADER

struct Fault {
    Status status = Status::Ok;
    size_t segment = 0;
    size_t observation = 0;
};

/* ------------------------------------------------------------------------ */
/* Document -> Message                                                       */
/* ------------------------------------------------------------------------ */

inline Status from_document(const kvn::Document& doc, Message* out, Fault* fault = nullptr) {
    if (fault) *fault = Fault{};
    if (!out) return Status::NotTdm;
    *out = Message{};
    if (doc.message_type != "TDM") {
        if (fault) fault->status = Status::NotTdm;
        return Status::NotTdm;
    }

    out->header = doc.header;
    out->segments.reserve(doc.segments.size());

    for (size_t si = 0; si < doc.segments.size(); ++si) {
        const kvn::Segment& src = doc.segments[si];
        Segment seg;
        seg.metadata = src.metadata;
        seg.has_data_block = src.has_data_block;
        seg.observations.reserve(src.data.size());

        for (size_t di = 0; di < src.data.size(); ++di) {
            const kvn::DataLine& line = src.data[di];
            Observation obs;
            obs.comments_before = line.comments_before;
            obs.is_standalone_comment = line.is_standalone_comment;
            if (line.is_standalone_comment) {
                obs.keyword = "COMMENT";
                obs.epoch = line.epoch;  /* the comment text; see Observation */
                seg.observations.push_back(obs);
                continue;
            }
            if (line.key.empty()) {
                /* A bare columnar row. In an AEM that is a state; in a TDM it
                 * is an observation whose observable nobody wrote down, and
                 * there is no way to guess which of the seventy it was. */
                if (fault) {
                    fault->status = Status::UnkeyedObservation;
                    fault->segment = si;
                    fault->observation = di;
                }
                return Status::UnkeyedObservation;
            }
            obs.keyword = line.key;
            obs.epoch = line.epoch;
            obs.values = line.tokens;
            if (obs.epoch.empty()) {
                if (fault) {
                    fault->status = Status::MissingEpoch;
                    fault->segment = si;
                    fault->observation = di;
                }
                return Status::MissingEpoch;
            }
            if (obs.values.empty()) {
                /* An epoch with no measurement is not a degenerate
                 * observation, it is a truncated line — and silently keeping
                 * it would put a valueless entry into a series a consumer
                 * reasonably assumes is measurements. */
                if (fault) {
                    fault->status = Status::EmptyObservation;
                    fault->segment = si;
                    fault->observation = di;
                }
                return Status::EmptyObservation;
            }
            seg.observations.push_back(obs);
        }
        out->segments.push_back(seg);
    }
    return Status::Ok;
}

/* ------------------------------------------------------------------------ */
/* Message -> Document                                                       */
/* ------------------------------------------------------------------------ */

inline Status to_document(const Message& msg, kvn::Document* out) {
    if (!out) return Status::NotTdm;
    *out = kvn::Document{};
    out->message_type = "TDM";
    out->header = msg.header;
    out->segments.reserve(msg.segments.size());
    for (size_t si = 0; si < msg.segments.size(); ++si) {
        const Segment& seg = msg.segments[si];
        kvn::Segment dst;
        dst.metadata = seg.metadata;
        dst.has_data_block = seg.has_data_block;
        dst.data.reserve(seg.observations.size());
        for (size_t oi = 0; oi < seg.observations.size(); ++oi) {
            const Observation& obs = seg.observations[oi];
            kvn::DataLine line;
            line.comments_before = obs.comments_before;
            line.is_standalone_comment = obs.is_standalone_comment;
            line.key = obs.keyword;
            line.epoch = obs.epoch;
            if (!obs.is_standalone_comment) line.tokens = obs.values;
            dst.data.push_back(line);
        }
        out->segments.push_back(dst);
    }
    return Status::Ok;
}

inline Status from_text(const char* text, size_t len, Message* out, Fault* fault = nullptr) {
    kvn::Document doc;
    const kvn::Status ks = kvn::parse(text, len, &doc);
    if (ks != kvn::Status::Ok) {
        if (fault) fault->status = Status::NotTdm;
        return Status::NotTdm;
    }
    return from_document(doc, out, fault);
}

/* ------------------------------------------------------------------------ */
/* SDS $TDM projection seam — deliberately empty at SDS 1.201.0              */
/* ------------------------------------------------------------------------ */
/*
 * Nothing projects a Message into `$TDM` here. At the pinned schema the record
 * has no RANGE field at all — the single most important observable a tracking
 * station produces, and the one Figure E-17 leads with — and it models
 * observations as PARALLEL ARRAYS on a uniform time grid. Figure E-17's last
 * RCS observation is stamped earlier than the CARRIER_POWER above it, so there
 * is no grid to lay those arrays on; a projection at this pin would have to
 * reorder the observations, which changes what the station reported.
 *
 * When `upstream-spacedatastandards-10` lands the extension, the projection
 * attaches HERE. What it needs from the record is a per-observation triple
 * (keyword, epoch, value) in file order, not columns: that is the only shape
 * that survives repeated epochs, out-of-order epochs, and an observable set
 * that grows between Blue Book issues.
 */

}  // namespace tdm
}  // namespace ccsds

#endif  // CCSDS_MESSAGES_TDM_HPP
