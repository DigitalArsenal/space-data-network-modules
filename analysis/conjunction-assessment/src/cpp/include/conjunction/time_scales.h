#pragma once
// Time-scale conversion for trajectories supplied in a scale other than UTC.
// Screening runs on UTC Julian dates; ERFA (vendored, amalgamated by
// foundation/frames/erfa-amalgamation.mjs) supplies leap seconds and TDB.

namespace conjunction {

/// UTC Julian date of a TDB Julian date (geocentric TDB - TT). NaN when ERFA
/// refuses the date.
double tdb_to_utc_jd(double tdb_jd);

/// UTC Julian date of a TT Julian date. NaN when ERFA refuses the date.
double tt_to_utc_jd(double tt_jd);

} // namespace conjunction
