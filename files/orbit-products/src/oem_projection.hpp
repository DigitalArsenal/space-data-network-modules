/*
 * files/orbit-products — the $OEM projection.
 *
 * The spine's `Series` in, an SDS `$OEM` out, and back. This is the ONLY place
 * a container's state history becomes a record, so the four readers cannot
 * disagree about what an $OEM built from a trajectory looks like.
 *
 * TWO FORMS, AND THE IDL PICKS WHICH
 *
 * `schema/OEM/main.fbs` declares state rows twice and forbids populating both
 * (its own rules block): `STEP_SIZE > 0` selects the compact row-major
 * `EPHEMERIS_DATA` on an implicit uniform grid, `STEP_SIZE == 0` selects the
 * verbose `EPHEMERIS_DATA_LINES` with an explicit `EPOCH` per state. This
 * projection chooses by measuring the series rather than by preference: a
 * uniform history takes the compact form because that is what it IS, and
 * anything else takes the lines form because the compact form cannot represent
 * it. Writing a non-uniform history into the compact form is not a compression,
 * it is a different trajectory.
 *
 * WHAT IS LOST, NAMED RATHER THAN HIDDEN
 *
 * At SDS 1.201.0 `$OEM` has no carrier for SP3's per-state clock bias and rate,
 * for per-state accuracy exponents, or for NAIF integer target/centre codes.
 * Reading SP3 through this projection therefore drops the clocks. That is a
 * schema gap, tracked as `upstream-spacedatastandards-10`, not a decision made
 * here — and it is why `StateRow` carries the clock columns even though this
 * file cannot yet write them: the reader must not lose what the record will
 * shortly be able to hold.
 *
 * JSON KEYS, WHEN A CALLER PROJECTS FURTHER: the IDL field identifiers
 * verbatim, character for character. Never lowercased, never camel-cased.
 */

#ifndef ORBIT_PRODUCTS_OEM_PROJECTION_HPP
#define ORBIT_PRODUCTS_OEM_PROJECTION_HPP

#include <cstdint>
#include <string>
#include <vector>

#include "ephemeris_series.hpp"

namespace ephem {
namespace oem {

/*
 * Epoch text for a row, on the container's own scale. The spine holds seconds
 * past J2000; $OEM wants ISO-8601, and a record whose epochs are numbers a
 * reader has to know the origin of is a record that only its author can read.
 *
 * Fixed six-decimal fractional seconds: enough to hold a microsecond, and a
 * FIXED width so two rows of the same series are lexically comparable, which
 * is what a consumer sorting a record by its epoch string actually relies on.
 */
inline std::string iso_from_seconds(double seconds_past_j2000) {
    /* J2000 is 2000-01-01T12:00:00 on the series' own scale. */
    double t = seconds_past_j2000 + 43200.0;
    long long days = static_cast<long long>(t / 86400.0);
    double rem = t - static_cast<double>(days) * 86400.0;
    if (rem < 0.0) {
        rem += 86400.0;
        days -= 1;
    }
    /* civil_from_days, the inverse of the days_from_civil this repo already
     * uses — exact integer arithmetic, no floating point, no table. */
    long long z = days + 730120; /* days from 0000-03-01 to 2000-01-01 */
    const long long era = (z >= 0 ? z : z - 146096) / 146097;
    const unsigned long long doe = static_cast<unsigned long long>(z - era * 146097);
    const unsigned long long yoe =
        (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    long long y = static_cast<long long>(yoe) + era * 400;
    const unsigned long long doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const unsigned long long mp = (5 * doy + 2) / 153;
    const unsigned d = static_cast<unsigned>(doy - (153 * mp + 2) / 5 + 1);
    const unsigned m = static_cast<unsigned>(mp + (mp < 10 ? 3 : -9));
    y += (m <= 2);

    const int hh = static_cast<int>(rem / 3600.0);
    rem -= hh * 3600.0;
    const int mi = static_cast<int>(rem / 60.0);
    const double ss = rem - mi * 60.0;

    char buf[64];
    std::snprintf(buf, sizeof(buf), "%04lld-%02u-%02uT%02d:%02d:%09.6f",
                  y, m, d, hh, mi, ss);
    return std::string(buf);
}

/* Whether this series must take the verbose form. Asked once, at projection
 * time, so the answer cannot differ between the two branches. */
inline bool needs_data_lines(const Series& s, double* step_out) {
    double step = 0.0;
    if (!s.uniform_step(&step)) return true;
    *step_out = step;
    return false;
}

}  // namespace oem
}  // namespace ephem

#endif  // ORBIT_PRODUCTS_OEM_PROJECTION_HPP
