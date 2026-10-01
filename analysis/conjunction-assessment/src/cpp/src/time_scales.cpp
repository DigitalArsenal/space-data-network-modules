#include "conjunction/time_scales.h"

#include <cmath>
#include <limits>

// ERFA (vendored, BSD-3): the module build amalgamates it ahead of this file,
// the native build links it; these are its declarations from erfa.h.
extern "C" {
double eraDtdb(double date1, double date2, double ut, double elong, double u, double v);
int eraTdbtt(double tdb1, double tdb2, double dtr, double* tt1, double* tt2);
int eraTttai(double tt1, double tt2, double* tai1, double* tai2);
int eraTaiutc(double tai1, double tai2, double* utc1, double* utc2);
}

namespace conjunction {

double tt_to_utc_jd(double tt_jd) {
    double tai1 = 0, tai2 = 0, utc1 = 0, utc2 = 0;
    if (eraTttai(tt_jd, 0.0, &tai1, &tai2) != 0 || eraTaiutc(tai1, tai2, &utc1, &utc2) != 0) {
        return std::numeric_limits<double>::quiet_NaN();
    }
    return utc1 + utc2;
}

double tdb_to_utc_jd(double tdb_jd) {
    // TDB - TT at the geocentre; UT1's fraction of a day enters only through
    // terms below a microsecond, so the TDB fraction stands in for it.
    const double fraction = std::fmod(tdb_jd + 0.5, 1.0);
    const double dtr = eraDtdb(tdb_jd, 0.0, fraction, 0.0, 0.0, 0.0);
    double tt1 = 0, tt2 = 0;
    if (eraTdbtt(tdb_jd, 0.0, dtr, &tt1, &tt2) != 0) {
        return std::numeric_limits<double>::quiet_NaN();
    }
    return tt_to_utc_jd(tt1 + tt2);
}

} // namespace conjunction
