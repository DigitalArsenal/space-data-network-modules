#include "conjunction/time_scales.h"

#include <cmath>
#include <limits>
#include <unordered_map>

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

namespace {
// TDB - TT (s) at the geocentre. Its largest term is 1.66 ms over a year, so it
// changes by under 3.4e-10 s per second: linear between whole-minute
// evaluations of ERFA's series is exact to ~1e-14 s. Interval ends of one
// window fall in a few hundred minutes, so the series runs that often.
double tdb_minus_tt(double tdb_jd) {
    thread_local std::unordered_map<long long, double> minutes;
    const auto at = [](long long minute) {
        auto found = minutes.find(minute);
        if (found != minutes.end()) return found->second;
        if (minutes.size() > 100000) minutes.clear();
        const double jd = static_cast<double>(minute) / 1440.0;
        // UT1's fraction of a day enters only through terms below a
        // microsecond, so the TDB fraction stands in for it.
        const double value = eraDtdb(jd, 0.0, std::fmod(jd + 0.5, 1.0), 0.0, 0.0, 0.0);
        return minutes.emplace(minute, value).first->second;
    };
    const double m = std::floor(tdb_jd * 1440.0);
    const double f = tdb_jd * 1440.0 - m;
    const long long minute = static_cast<long long>(m);
    return at(minute) + (at(minute + 1) - at(minute)) * f;
}
} // namespace

double tdb_to_utc_jd(double tdb_jd) {
    double tt1 = 0, tt2 = 0;
    if (eraTdbtt(tdb_jd, 0.0, tdb_minus_tt(tdb_jd), &tt1, &tt2) != 0) {
        return std::numeric_limits<double>::quiet_NaN();
    }
    return tt_to_utc_jd(tt1 + tt2);
}

} // namespace conjunction
