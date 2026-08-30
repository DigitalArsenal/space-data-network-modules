/*
 * files/orbit-products — one door onto four containers.
 *
 * `load_container(bytes, len, format, &series)` is the single entry point every
 * consumer uses: this package's own reader surface, the `data-source/spk-source`
 * ephemeris propagator, and the signed closed exporter. One dispatcher rather
 * than four call sites, because the moment two consumers each decide for
 * themselves what an SPK is, they are two readers.
 *
 * AUTO IS A REAL MEMBER, NOT A GUESS
 *
 * Every container here identifies itself in its first bytes, so a caller that
 * does not know what it fetched can say so honestly instead of being forced to
 * assert something it cannot know:
 *
 *   DAF/SPK      `DAF/SPK ` or the older `NAIF/DAF` ID word at offset 0
 *   SP3          `#a`..`#d` in columns 1-2, then `P` or `V`
 *   STK          the `stk.v.<n>` banner
 *   CCSDS OEM    a `CCSDS_OEM_VERS` keyword in the first lines
 *   Code-500     no text signature at all — it is the RESIDUAL, and is
 *                accepted only after a structural plausibility check, never
 *                as "whatever did not match".
 *
 * That last point is the one that matters. A residual format identified by
 * elimination will happily "read" a corrupted file of any other kind and
 * return numbers. So AUTO reaches Code-500 only if the buffer also passes
 * Code-500's own header validation, and returns UnsupportedVariant otherwise.
 * An explicit format discriminator always wins over detection: a caller who
 * knows is more authoritative than a sniff.
 */

#ifndef ORBIT_PRODUCTS_CONTAINERS_HPP
#define ORBIT_PRODUCTS_CONTAINERS_HPP

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "ephemeris_series.hpp"

#include "code500.hpp"
#include "daf.hpp"
#include "sp3.hpp"
#include "spk_read.hpp"
#include "stk_ephemeris.hpp"

/* The CCSDS keyword-value document model lives in the sibling package because
 * AEM and TDM are its primary consumers. Reading it from here is the same
 * seam `foundation/frames` uses to reach `foundation/orbits`' state
 * representations: ONE implementation, included by whoever needs it, rather
 * than a second OEM parser living next to the first. */
#include "../../ccsds-messages/src/kvn.hpp"

namespace ephem {

/* The ABI's discriminator and this header's must not drift. Where the SDK's
 * generated propagator header is present in the translation unit, the two are
 * tied together mechanically; where it is not (the native acceptance builds),
 * the restatement in ephemeris_series.hpp stands alone and this check
 * silently does nothing — which is why the ties are asserted rather than
 * assumed wherever they CAN be. */
#ifdef ORBPRO_PROPAGATOR_ABI_H
static_assert(static_cast<uint32_t>(Format::Auto) == ORBPRO_EPHEM_FORMAT_AUTO, "");
static_assert(static_cast<uint32_t>(Format::CcsdsOemKvn) == ORBPRO_EPHEM_FORMAT_CCSDS_OEM_KVN, "");
static_assert(static_cast<uint32_t>(Format::SpkDaf) == ORBPRO_EPHEM_FORMAT_SPK_DAF, "");
static_assert(static_cast<uint32_t>(Format::Code500) == ORBPRO_EPHEM_FORMAT_CODE500, "");
static_assert(static_cast<uint32_t>(Format::StkEphemeris) == ORBPRO_EPHEM_FORMAT_STK_EPHEMERIS, "");
static_assert(static_cast<uint32_t>(Format::Sp3d) == ORBPRO_EPHEM_FORMAT_SP3_D, "");
#endif

/* ------------------------------------------------------------------------ */
/* CCSDS OEM (keyword-value notation)                                        */
/* ------------------------------------------------------------------------ */

namespace oem_kvn {

/*
 * An OEM's data lines are `EPOCH X Y Z [X_DOT Y_DOT Z_DOT [X_DDOT ...]]` in
 * kilometres — the same units the spine holds, so nothing is scaled here. The
 * epoch is kept as the container's own text and converted to an offset from
 * the block's START_TIME, which is the only arithmetic this reader does on
 * time: no scale conversion, per the spine's rule.
 */

/* Days in the months of a proleptic Gregorian year. Used only to turn an
 * ISO-8601 calendar date into a count of days, which is arithmetic on the
 * CALENDAR, not on a time SCALE — no leap second is involved and none is
 * assumed. */
inline int days_from_civil(int y, int m, int d) {
    /* Howard Hinnant's days_from_civil: exact for the whole proleptic
     * Gregorian range with no floating point and no table. */
    y -= m <= 2;
    const int era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = static_cast<unsigned>(y - era * 400);
    const unsigned doy = static_cast<unsigned>((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1);
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + static_cast<int>(doe) - 719468;
}

/*
 * Parse an ISO-8601 epoch to seconds past the J2000 epoch ON THE SAME SCALE
 * the string is expressed in. Accepts both CCSDS forms:
 *   YYYY-MM-DDThh:mm:ss[.fff]
 *   YYYY-DDDThh:mm:ss[.fff]   (day-of-year, used by Figure G-5 and E-18)
 *
 * Returns false rather than a sentinel: an epoch we cannot read is a refusal,
 * and a NaN here would propagate into every interpolation downstream.
 */
inline bool iso_to_seconds(const std::string& s, double* out) {
    int y = 0, mo = 0, da = 0, hh = 0, mi = 0;
    double se = 0.0;
    const char* p = s.c_str();
    char* end = nullptr;

    y = static_cast<int>(std::strtol(p, &end, 10));
    if (end == p || *end != '-') return false;
    p = end + 1;

    long first = std::strtol(p, &end, 10);
    if (end == p) return false;

    int days = 0;
    if (*end == '-') {
        mo = static_cast<int>(first);
        p = end + 1;
        da = static_cast<int>(std::strtol(p, &end, 10));
        if (end == p) return false;
        days = days_from_civil(y, mo, da);
    } else if (*end == 'T' || *end == 't') {
        /* Day-of-year form: January 1 is day 1. */
        days = days_from_civil(y, 1, 1) + static_cast<int>(first) - 1;
    } else {
        return false;
    }
    if (*end != 'T' && *end != 't') return false;
    p = end + 1;

    hh = static_cast<int>(std::strtol(p, &end, 10));
    if (end == p || *end != ':') return false;
    p = end + 1;
    mi = static_cast<int>(std::strtol(p, &end, 10));
    if (end == p) return false;
    if (*end == ':') {
        p = end + 1;
        se = std::strtod(p, &end);
        if (end == p) return false;
    }

    /* 2451545.0 JD is 2000-01-01T12:00:00; days_from_civil is relative to the
     * Unix epoch, so the J2000 offset is that same date's day number. */
    static const int kJ2000Day = days_from_civil(2000, 1, 1);
    *out = static_cast<double>(days - kJ2000Day) * 86400.0 +
           static_cast<double>(hh) * 3600.0 + static_cast<double>(mi) * 60.0 + se -
           43200.0; /* J2000 is at 12:00, not 00:00 */
    return true;
}

inline Interp interp_from_name(const std::string& v) {
    std::string u;
    for (char c : v) u.push_back(c >= 'a' && c <= 'z' ? static_cast<char>(c - 32) : c);
    if (u == "HERMITE") return Interp::Hermite;
    if (u == "LAGRANGE") return Interp::Lagrange;
    if (u == "LINEAR") return Interp::Linear;
    if (u == "CHEBYSHEV") return Interp::Chebyshev;
    return Interp::Unknown;
}

inline Status read(const char* text, size_t len, std::vector<Series>* out) {
    if (!text || !out) return Status::Malformed;
    kvn::Document doc;
    const kvn::Status ks = kvn::parse(text, len, &doc);
    if (ks != kvn::Status::Ok) return Status::Malformed;
    if (doc.message_type != "OEM") return Status::BadMagic;

    out->clear();
    for (const kvn::Segment& seg : doc.segments) {
        Series s;
        if (const kvn::Entry* e = kvn::find(seg.metadata, "OBJECT_NAME")) s.object_name = e->value;
        if (const kvn::Entry* e = kvn::find(seg.metadata, "OBJECT_ID")) s.object_id = e->value;
        if (const kvn::Entry* e = kvn::find(seg.metadata, "CENTER_NAME")) s.center_name = e->value;
        if (const kvn::Entry* e = kvn::find(seg.metadata, "REF_FRAME")) s.frame_name = e->value;
        if (const kvn::Entry* e = kvn::find(seg.metadata, "TIME_SYSTEM")) s.time_system = e->value;
        if (const kvn::Entry* e = kvn::find(seg.metadata, "START_TIME")) s.epoch_zero_iso = e->value;
        if (const kvn::Entry* e = kvn::find(seg.metadata, "INTERPOLATION")) {
            s.interp = interp_from_name(e->value);
        }
        if (const kvn::Entry* e = kvn::find(seg.metadata, "INTERPOLATION_DEGREE")) {
            bool ok = false;
            const double d = kvn::to_double(e->value, &ok);
            if (ok) s.interp_degree = static_cast<int>(d);
        }

        /* Row epochs are absolute on the container's own axis (seconds past
         * J2000 in the declared scale), and epoch_zero_offset_sec is left at
         * zero, so a caller holding a Julian date reaches them directly. An
         * OEM's START_TIME is metadata, not an origin the rows are relative
         * to — the rows carry their own absolute epochs. */
        for (const kvn::DataLine& d : seg.data) {
            if (d.is_standalone_comment || !d.key.empty()) continue;
            if (d.tokens.size() < 3) continue;
            StateRow r;
            if (!iso_to_seconds(d.epoch, &r.epoch)) return Status::Malformed;
            bool ok = true;
            for (int c = 0; c < 3 && ok; ++c) r.pos[c] = kvn::to_double(d.tokens[c], &ok);
            if (!ok) return Status::Malformed;
            if (d.tokens.size() >= 6) {
                for (int c = 0; c < 3 && ok; ++c) r.vel[c] = kvn::to_double(d.tokens[3 + c], &ok);
                r.has_vel = ok;
            }
            if (d.tokens.size() >= 9) {
                for (int c = 0; c < 3 && ok; ++c) r.acc[c] = kvn::to_double(d.tokens[6 + c], &ok);
                r.has_acc = ok;
            }
            if (!ok) return Status::Malformed;
            if (!row_is_finite(r)) return Status::Malformed;
            s.rows.push_back(r);
        }
        if (!s.rows.empty()) out->push_back(s);
    }
    return out->empty() ? Status::NotEnoughStates : Status::Ok;
}

}  // namespace oem_kvn

/* ------------------------------------------------------------------------ */
/* Detection                                                                 */
/* ------------------------------------------------------------------------ */

inline bool looks_like_daf(const uint8_t* b, size_t n) {
    return n >= 8 && (std::memcmp(b, "DAF/SPK ", 8) == 0 || std::memcmp(b, "NAIF/DAF", 8) == 0);
}

inline bool looks_like_sp3(const uint8_t* b, size_t n) {
    return n >= 3 && b[0] == '#' && b[1] >= 'a' && b[1] <= 'z' && (b[2] == 'P' || b[2] == 'V');
}

inline bool looks_like_stk(const uint8_t* b, size_t n) {
    /* The banner is `stk.v.<n>` and is the first non-blank line. Scan a bounded
     * prefix rather than the whole buffer: an ephemeris body can be hundreds of
     * megabytes and a signature is not hiding in the middle of it. */
    const size_t limit = n < 256 ? n : 256;
    for (size_t i = 0; i + 6 <= limit; ++i) {
        if (std::memcmp(b + i, "stk.v.", 6) == 0) return true;
    }
    return false;
}

inline bool looks_like_oem_kvn(const uint8_t* b, size_t n) {
    const size_t limit = n < 4096 ? n : 4096;
    for (size_t i = 0; i + 15 <= limit; ++i) {
        if (std::memcmp(b + i, "CCSDS_OEM_VERS", 14) == 0) return true;
    }
    return false;
}

/* ------------------------------------------------------------------------ */
/* Dispatch                                                                  */
/* ------------------------------------------------------------------------ */

/*
 * A DAF holds many segments and an OEM many blocks, so the result is a LIST of
 * series — one per object the container actually describes. Collapsing that to
 * "the first one" is a hidden choice about which object the caller meant, and
 * the caller is the only one who knows.
 */
inline Status load_container(const uint8_t* bytes, size_t len, Format format,
                             std::vector<Series>* out) {
    if (!bytes || !out || len == 0) return Status::Malformed;
    out->clear();

    Format resolved = format;
    if (resolved == Format::Auto) {
        if (looks_like_daf(bytes, len)) resolved = Format::SpkDaf;
        else if (looks_like_sp3(bytes, len)) resolved = Format::Sp3d;
        else if (looks_like_stk(bytes, len)) resolved = Format::StkEphemeris;
        else if (looks_like_oem_kvn(bytes, len)) resolved = Format::CcsdsOemKvn;
        else resolved = Format::Code500; /* the residual — validated below */
    }

    switch (resolved) {
        case Format::SpkDaf: {
            daf::File f;
            const Status st = daf::read(bytes, len, &f);
            if (st != Status::Ok) return st;
            for (const daf::Summary& seg : f.summaries) {
                Series s;
                const Status ss = spk::to_series(f, seg, &s);
                if (ss == Status::UnsupportedVariant) {
                    /* A kernel may mix segment types. Skipping the ones we do
                     * not evaluate is right — refusing the whole file would
                     * make one Chebyshev planetary segment hide forty perfectly
                     * readable spacecraft segments — but a kernel with NOTHING
                     * readable must still fail rather than return empty. */
                    continue;
                }
                if (ss != Status::Ok) return ss;
                out->push_back(s);
            }
            return out->empty() ? Status::UnsupportedVariant : Status::Ok;
        }
        case Format::Sp3d: {
            sp3::File f;
            const Status st = sp3::read(reinterpret_cast<const char*>(bytes), len, &f);
            if (st != Status::Ok) return st;
            for (const sp3::SatelliteBlock& sat : f.satellites) out->push_back(sat.series);
            return out->empty() ? Status::NotEnoughStates : Status::Ok;
        }
        case Format::StkEphemeris: {
            Series s;
            const Status st =
                stk_ephem::read(reinterpret_cast<const char*>(bytes), len, &s);
            if (st != Status::Ok) return st;
            out->push_back(s);
            return Status::Ok;
        }
        case Format::CcsdsOemKvn:
            return oem_kvn::read(reinterpret_cast<const char*>(bytes), len, out);
        case Format::Code500: {
            Series s;
            const Status st = code500::read(bytes, len, &s, nullptr);
            if (st != Status::Ok) {
                /* When we ARRIVED here by elimination rather than by an
                 * explicit discriminator, a Code-500 failure means the buffer
                 * was never any of these containers — report that, not a
                 * Code-500 parse error, or the caller chases the wrong bug. */
                return format == Format::Auto ? Status::UnsupportedVariant : st;
            }
            out->push_back(s);
            return Status::Ok;
        }
        case Format::Auto:
            break;
    }
    return Status::UnsupportedVariant;
}

}  // namespace ephem

#endif  // ORBIT_PRODUCTS_CONTAINERS_HPP
