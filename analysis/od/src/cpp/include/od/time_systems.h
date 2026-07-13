#ifndef OD_TIME_SYSTEMS_H
#define OD_TIME_SYSTEMS_H

/**
 * Time-system conversion to UTC for OD ephemeris ingest (A2.4-prereq).
 *
 * The SGP4 fitter and the frame transforms operate on a UTC Julian Date
 * (StateSeries invariant: epoch_jd is UTC). A2.2a handled UTC-only OEM feeds.
 * GNSS precise products declare GPS SYSTEM TIME (IAC GLONASS SP3 %c line = "GPS";
 * GPS almanacs), so their sample epochs must be mapped GPS -> UTC before fitting
 * or the fitted epoch (and the per-point Earth-rotation used by ecef_to_teme)
 * would be wrong by the current 18 s GPS-UTC offset.
 *
 *   GPS time = TAI - 19 s      (fixed at the 1980-01-06 GPS epoch, forever)
 *   UTC      = TAI - (TAI-UTC) (TAI-UTC steps by +1 s at each leap second)
 *   => UTC   = GPS - ((TAI-UTC) - 19)
 *
 * The (TAI-UTC) step table below is EXPLICIT and TERMINATES at the last leap
 * second actually inserted (2017-01-01 -> 37 s). It is NEVER extrapolated: a leap
 * second is an IERS decision announced in Bulletin C, not a predictable event, so
 * for any epoch beyond the documented validity horizon (through which IERS has
 * announced NO leap second) the conversion FAILS CLOSED with a precise error
 * rather than silently assuming the last offset still holds. Within the horizon
 * the last known offset is the correct current value (not an extrapolation).
 *
 * PROVENANCE: IERS Bulletin C leap-second history (the canonical
 * <https://hpiers.obspm.fr/iers/bul/bulc/> / IETF `leap-seconds.list` table). The
 * last inserted leap second was 2017-01-01 (TAI-UTC = 37 s); IERS Bulletin C has
 * announced no leap second since, and the current bulletin guarantees none
 * through the horizon date below. Update BOTH the table and the horizon when a
 * future Bulletin C announces a new leap second.
 */

#include <cmath>
#include <string>

namespace od {

// GPS system time is TAI minus a constant 19 s, fixed at the GPS epoch forever.
inline double gps_tai_offset_sec() { return 19.0; }

// Julian Date at 0h UTC of a Gregorian calendar date (proleptic Gregorian).
inline double jd_from_ymd(int y, int m, int d) {
    long a = (14 - m) / 12;
    long yy = y + 4800 - a;
    long mm = m + 12 * a - 3;
    long jdn = d + (153 * mm + 2) / 5 + 365L * yy + yy / 4 - yy / 100 + yy / 400 - 32045;
    return static_cast<double>(jdn) - 0.5;  // JDN is noon-based; 0h is -0.5
}

struct LeapStep {
    int y, m, d;      // effective date, 0h UTC
    double tai_utc;   // TAI - UTC (seconds) from this date until the next step
};

// Complete modern (post-1972) integer-leap-second table. Only the entries from
// 1980 onward are reachable via GPS time, but the full table keeps a direct
// TAI->UTC conversion correct too. Terminates at the last inserted leap second.
inline const LeapStep* leap_table(int* n) {
    static const LeapStep kSteps[] = {
        {1972, 1, 1, 10}, {1972, 7, 1, 11}, {1973, 1, 1, 12}, {1974, 1, 1, 13},
        {1975, 1, 1, 14}, {1976, 1, 1, 15}, {1977, 1, 1, 16}, {1978, 1, 1, 17},
        {1979, 1, 1, 18}, {1980, 1, 1, 19}, {1981, 7, 1, 20}, {1982, 7, 1, 21},
        {1983, 7, 1, 22}, {1985, 7, 1, 23}, {1988, 1, 1, 24}, {1990, 1, 1, 25},
        {1991, 1, 1, 26}, {1992, 7, 1, 27}, {1993, 7, 1, 28}, {1994, 7, 1, 29},
        {1996, 1, 1, 30}, {1997, 7, 1, 31}, {1999, 1, 1, 32}, {2006, 1, 1, 33},
        {2009, 1, 1, 34}, {2012, 7, 1, 35}, {2015, 7, 1, 36}, {2017, 1, 1, 37},
    };
    *n = static_cast<int>(sizeof(kSteps) / sizeof(kSteps[0]));
    return kSteps;
}

// Documented validity horizon: IERS has announced NO leap second through this
// date (Bulletin C). Beyond it a leap second COULD have been inserted, so any
// conversion that would assume the last offset persists must fail closed.
// Update alongside each new Bulletin C.
inline double leap_valid_through_jd() { return jd_from_ymd(2027, 6, 30); }

struct TimeConv {
    bool ok = false;
    double jd_utc = 0.0;
    std::string error_code;     // "time-past-leap-horizon", "time-before-utc-table", "unsupported-time-system"
    std::string error_message;
};

// TAI - UTC (seconds) applicable at the given UTC (or near-UTC) Julian Date.
// Returns false for epochs before the 1972 table start.
inline bool tai_minus_utc_at(double jd, double* out) {
    int n = 0;
    const LeapStep* t = leap_table(&n);
    double best = -1.0;
    for (int i = 0; i < n; ++i) {
        double step_jd = jd_from_ymd(t[i].y, t[i].m, t[i].d);
        if (jd >= step_jd) best = t[i].tai_utc;
    }
    if (best < 0.0) return false;
    *out = best;
    return true;
}

// GPS Julian Date -> UTC Julian Date. Fail-closed past the documented horizon
// and for pre-1980 (pre-GPS) inputs; never extrapolates future leap seconds.
inline TimeConv gps_jd_to_utc(double jd_gps) {
    TimeConv r;
    // Look up TAI-UTC near this instant; refine once because the table is keyed
    // by UTC while we hold GPS (they differ by <= 18 s, only ambiguous within a
    // leap-second boundary). One UTC-side refinement removes that ambiguity
    // except within the leap second itself (sub-second, irrelevant to an epoch).
    double tai_utc = 0.0;
    if (!tai_minus_utc_at(jd_gps, &tai_utc)) {
        r.error_code = "time-before-utc-table";
        r.error_message = "GPS epoch precedes the 1972 UTC leap-second table.";
        return r;
    }
    double utc_est = jd_gps - (tai_utc - gps_tai_offset_sec()) / 86400.0;
    double tai_utc2 = tai_utc;
    tai_minus_utc_at(utc_est, &tai_utc2);
    double jd_utc = jd_gps - (tai_utc2 - gps_tai_offset_sec()) / 86400.0;

    if (jd_utc > leap_valid_through_jd()) {
        r.error_code = "time-past-leap-horizon";
        r.error_message =
            "Epoch is past the documented leap-second validity horizon "
            "(2027-06-30); a future leap second is unknown, so GPS->UTC is not "
            "extrapolated. Update the leap-second table + horizon.";
        return r;
    }
    r.ok = true;
    r.jd_utc = jd_utc;
    return r;
}

// TAI Julian Date -> UTC Julian Date (same table; same horizon policy).
inline TimeConv tai_jd_to_utc(double jd_tai) {
    TimeConv r;
    double tai_utc = 0.0;
    if (!tai_minus_utc_at(jd_tai, &tai_utc)) {
        r.error_code = "time-before-utc-table";
        r.error_message = "TAI epoch precedes the 1972 UTC leap-second table.";
        return r;
    }
    double utc_est = jd_tai - tai_utc / 86400.0;
    double tai_utc2 = tai_utc;
    tai_minus_utc_at(utc_est, &tai_utc2);
    double jd_utc = jd_tai - tai_utc2 / 86400.0;
    if (jd_utc > leap_valid_through_jd()) {
        r.error_code = "time-past-leap-horizon";
        r.error_message = "Epoch is past the documented leap-second validity horizon.";
        return r;
    }
    r.ok = true;
    r.jd_utc = jd_utc;
    return r;
}

// Dispatch on an upper-cased TIME_SYSTEM token. UTC passes through unchanged; GPS
// and TAI convert via the leap table; anything else fails closed (correctness
// over coverage — never guess an unknown time scale's offset).
inline TimeConv time_system_to_utc(const std::string& time_system_upper, double jd_in) {
    if (time_system_upper.empty() || time_system_upper == "UTC") {
        TimeConv r;
        r.ok = true;
        r.jd_utc = jd_in;
        return r;
    }
    if (time_system_upper == "GPS") return gps_jd_to_utc(jd_in);
    if (time_system_upper == "TAI") return tai_jd_to_utc(jd_in);
    TimeConv r;
    r.error_code = "unsupported-time-system";
    r.error_message = "TIME_SYSTEM=" + time_system_upper +
                      " is not supported (UTC, GPS, TAI only).";
    return r;
}

}  // namespace od

#endif  // OD_TIME_SYSTEMS_H
