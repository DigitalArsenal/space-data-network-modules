// time_convert.cpp - Time Systems Conversion Implementation
// =============================================================================
// Implements astronomical time scale conversions with leap second support.
//
// Task 6.2: Time Systems Plugin
//
// References:
// - IERS Conventions (2010), Chapter 5
// - SOFA Software Library (iauDat, iauTaitt, etc.)
// - USNO Circular 179
// - IERS Bulletin C (leap second announcements)
// =============================================================================

#include <hpop/time_convert.h>
#include <cmath>
#include <cstring>
#include <cstdio>
#include <vector>
#include <algorithm>

namespace timesys {

// =============================================================================
// Constants
// =============================================================================

// Pi
constexpr double PI = 3.14159265358979323846;
constexpr double TWO_PI = 2.0 * PI;

// Arcseconds to radians
constexpr double ARCSEC_TO_RAD = PI / (180.0 * 3600.0);

// TT - TAI offset in days
constexpr double TT_TAI_DAYS = TT_TAI_OFFSET / SECONDS_PER_DAY;

// GPS - TAI offset in days
constexpr double GPS_TAI_DAYS = GPS_TAI_OFFSET / SECONDS_PER_DAY;

// LG rate for TCG (IERS Conventions 2010)
// TCG - TT = LG * (JD_TCG - T0) where LG = 6.969290134e-10
constexpr double LG_RATE = 6.969290134e-10;

// LB rate for TCB (IERS Conventions 2010)
// TCB - TDB = LB * (JD_TCB - T0) where LB = 1.550519768e-8
constexpr double LB_RATE = 1.550519768e-8;

// Reference epoch T0 for TCG/TCB (1977-01-01 00:00:00 TAI = JD 2443144.5003725)
constexpr double TCG_TCB_EPOCH = 2443144.5003725;

// =============================================================================
// Leap Second Table
// =============================================================================
// Official leap seconds from IERS Bulletin C
// Format: Julian date at 00:00:00 UTC when the leap second takes effect,
//         and cumulative TAI-UTC offset after that date.
//
// Source: https://www.iers.org/IERS/EN/Publications/Bulletins/bulletins.html
// Last update: 2024 (37 seconds as of 2017-01-01)
// =============================================================================

static std::vector<LeapSecond> g_leapSeconds = {
    // Year  Month  Day   JD at 00:00 UTC    TAI-UTC
    // 1972  Jan    1     2441317.5          10
    {2441317.5, 10},
    // 1972  Jul    1     2441499.5          11
    {2441499.5, 11},
    // 1973  Jan    1     2441683.5          12
    {2441683.5, 12},
    // 1974  Jan    1     2442048.5          13
    {2442048.5, 13},
    // 1975  Jan    1     2442413.5          14
    {2442413.5, 14},
    // 1976  Jan    1     2442778.5          15
    {2442778.5, 15},
    // 1977  Jan    1     2443144.5          16
    {2443144.5, 16},
    // 1978  Jan    1     2443509.5          17
    {2443509.5, 17},
    // 1979  Jan    1     2443874.5          18
    {2443874.5, 18},
    // 1980  Jan    1     2444239.5          19
    {2444239.5, 19},
    // 1981  Jul    1     2444786.5          20
    {2444786.5, 20},
    // 1982  Jul    1     2445151.5          21
    {2445151.5, 21},
    // 1983  Jul    1     2445516.5          22
    {2445516.5, 22},
    // 1985  Jul    1     2446247.5          23
    {2446247.5, 23},
    // 1988  Jan    1     2447161.5          24
    {2447161.5, 24},
    // 1990  Jan    1     2447892.5          25
    {2447892.5, 25},
    // 1991  Jan    1     2448257.5          26
    {2448257.5, 26},
    // 1992  Jul    1     2448804.5          27
    {2448804.5, 27},
    // 1993  Jul    1     2449169.5          28
    {2449169.5, 28},
    // 1994  Jul    1     2449534.5          29
    {2449534.5, 29},
    // 1996  Jan    1     2450083.5          30
    {2450083.5, 30},
    // 1997  Jul    1     2450630.5          31
    {2450630.5, 31},
    // 1999  Jan    1     2451179.5          32
    {2451179.5, 32},
    // 2006  Jan    1     2453736.5          33
    {2453736.5, 33},
    // 2009  Jan    1     2454832.5          34
    {2454832.5, 34},
    // 2012  Jul    1     2456109.5          35
    {2456109.5, 35},
    // 2015  Jul    1     2457204.5          36
    {2457204.5, 36},
    // 2017  Jan    1     2457754.5          37
    {2457754.5, 37}
};

// Current DUT1 value (UT1 - UTC in seconds)
static double g_dut1 = 0.0;

// =============================================================================
// Leap Second Functions
// =============================================================================

int32_t getLeapSeconds(double utc_jd) {
    // Before first leap second (1972-01-01), return 10
    // (This is a simplification; before 1972, the relationship was more complex)
    if (utc_jd < g_leapSeconds[0].jd) {
        return 10;  // Prior to leap second system
    }

    // Binary search for the appropriate leap second entry
    int32_t result = 10;  // Default before any leap seconds
    for (const auto& ls : g_leapSeconds) {
        if (utc_jd >= ls.jd) {
            result = ls.tai_utc;
        } else {
            break;
        }
    }

    return result;
}

bool isLeapSecond(double utc_jd) {
    // Check if this JD falls during the leap second (23:59:60 UTC)
    // A leap second occurs in the last second of the day before the JD
    // when the new offset takes effect

    for (const auto& ls : g_leapSeconds) {
        // The leap second is inserted at the end of the day BEFORE ls.jd
        // So it occurs between (ls.jd - 1/86400) and ls.jd
        double leapStart = ls.jd - (1.0 / SECONDS_PER_DAY);
        if (utc_jd >= leapStart && utc_jd < ls.jd) {
            return true;
        }
    }
    return false;
}

void addLeapSecond(double jd, int32_t tai_utc) {
    // Validate input
    if (jd <= 0.0 || tai_utc <= 0) {
        return;
    }

    // Find insertion point to keep sorted
    auto it = std::lower_bound(g_leapSeconds.begin(), g_leapSeconds.end(), jd,
        [](const LeapSecond& ls, double val) { return ls.jd < val; });

    // Check if this date already exists
    if (it != g_leapSeconds.end() && std::abs(it->jd - jd) < 0.0001) {
        // Update existing entry
        it->tai_utc = tai_utc;
    } else {
        // Insert new entry
        g_leapSeconds.insert(it, LeapSecond(jd, tai_utc));
    }
}

size_t getLeapSecondCount() {
    return g_leapSeconds.size();
}

bool getLeapSecondEntry(size_t index, LeapSecond& out) {
    if (index >= g_leapSeconds.size()) {
        return false;
    }
    out = g_leapSeconds[index];
    return true;
}

// =============================================================================
// DUT1 Functions
// =============================================================================

void setDut1(double dut1) {
    // DUT1 is typically between -0.9 and +0.9 seconds
    // We don't enforce this limit but users should be aware
    g_dut1 = dut1;
}

double getDut1() {
    return g_dut1;
}

// =============================================================================
// Core Conversions
// =============================================================================

double utcToTai(double utc_jd) {
    int32_t leapSec = getLeapSeconds(utc_jd);
    return utc_jd + static_cast<double>(leapSec) / SECONDS_PER_DAY;
}

double taiToUtc(double tai_jd) {
    // This is trickier because we need to find the right leap second
    // Start with an initial guess
    double utc_jd = tai_jd - 37.0 / SECONDS_PER_DAY;  // Current offset

    // Iterate to find correct UTC
    for (int i = 0; i < 3; ++i) {
        int32_t leapSec = getLeapSeconds(utc_jd);
        utc_jd = tai_jd - static_cast<double>(leapSec) / SECONDS_PER_DAY;
    }

    return utc_jd;
}

double taiToTt(double tai_jd) {
    return tai_jd + TT_TAI_DAYS;
}

double ttToTai(double tt_jd) {
    return tt_jd - TT_TAI_DAYS;
}

double ttToTdb(double tt_jd) {
    // TDB - TT is a quasi-periodic function with max amplitude ~1.7 ms
    // Using Fairhead & Bretagnon (2001) simplified model

    // Julian centuries since J2000.0 TT
    double T = (tt_jd - J2000_JD) / DAYS_PER_JULIAN_CENTURY;

    // Mean anomaly of the Earth in its orbit around the Sun
    double M = 357.5277233 + 35999.05034 * T;  // degrees
    M = std::fmod(M, 360.0);
    if (M < 0) M += 360.0;
    double M_rad = M * PI / 180.0;

    // TDB - TT in seconds (simplified model)
    // Main term from the Earth's orbital eccentricity
    double dt = 0.001658 * std::sin(M_rad) + 0.000014 * std::sin(2.0 * M_rad);

    return tt_jd + dt / SECONDS_PER_DAY;
}

double tdbToTt(double tdb_jd) {
    // Inverse of ttToTdb - iterate for convergence
    double tt_jd = tdb_jd;  // Initial guess

    for (int i = 0; i < 3; ++i) {
        double tdb_calc = ttToTdb(tt_jd);
        double diff = tdb_jd - tdb_calc;
        tt_jd += diff;
    }

    return tt_jd;
}

double utcToGps(double utc_jd) {
    // GPS time = TAI - 19 seconds
    // First convert UTC to TAI, then to GPS
    double tai_jd = utcToTai(utc_jd);
    return tai_jd + GPS_TAI_DAYS;  // GPS_TAI_DAYS is -19 seconds in days
}

double gpsToUtc(double gps_jd) {
    // First convert GPS to TAI, then to UTC
    double tai_jd = gps_jd - GPS_TAI_DAYS;  // TAI = GPS + 19 seconds
    return taiToUtc(tai_jd);
}

double taiToGps(double tai_jd) {
    return tai_jd + GPS_TAI_DAYS;  // GPS = TAI - 19 seconds
}

double gpsToTai(double gps_jd) {
    return gps_jd - GPS_TAI_DAYS;  // TAI = GPS + 19 seconds
}

double ttToTcg(double tt_jd) {
    // TCG = TT + LG * (JD_TT - T0) * 86400
    // where LG = 6.969290134e-10
    double elapsed_days = tt_jd - TCG_TCB_EPOCH;
    double offset_days = LG_RATE * elapsed_days * SECONDS_PER_DAY / SECONDS_PER_DAY;
    return tt_jd + offset_days;
}

double tcgToTt(double tcg_jd) {
    // TT = TCG / (1 + LG) - simplified
    double elapsed_days = tcg_jd - TCG_TCB_EPOCH;
    double offset_days = LG_RATE * elapsed_days * SECONDS_PER_DAY / SECONDS_PER_DAY;
    return tcg_jd - offset_days;
}

double tdbToTcb(double tdb_jd) {
    // TCB = TDB + LB * (JD_TDB - T0) * 86400
    double elapsed_days = tdb_jd - TCG_TCB_EPOCH;
    double offset_days = LB_RATE * elapsed_days * SECONDS_PER_DAY / SECONDS_PER_DAY;
    return tdb_jd + offset_days;
}

double tcbToTdb(double tcb_jd) {
    // TDB = TCB / (1 + LB) - simplified
    double elapsed_days = tcb_jd - TCG_TCB_EPOCH;
    double offset_days = LB_RATE * elapsed_days * SECONDS_PER_DAY / SECONDS_PER_DAY;
    return tcb_jd - offset_days;
}

// =============================================================================
// UT1 Conversions
// =============================================================================

double utcToUt1(double utc_jd) {
    // UT1 = UTC + DUT1
    return utc_jd + g_dut1 / SECONDS_PER_DAY;
}

double ut1ToUtc(double ut1_jd) {
    // UTC = UT1 - DUT1
    return ut1_jd - g_dut1 / SECONDS_PER_DAY;
}

// =============================================================================
// Sidereal Time Conversions
// =============================================================================

double ut1ToGmst(double ut1_jd) {
    // GMST calculation using IAU 2006 precession model
    // Reference: IERS Conventions (2010), Chapter 5

    // Julian UT1 date (integer and fraction)
    double jd0 = std::floor(ut1_jd - 0.5) + 0.5;  // JD at 0h UT1
    double frac = ut1_jd - jd0;  // Fraction of day

    // Julian centuries from J2000.0
    double T = (ut1_jd - J2000_JD) / DAYS_PER_JULIAN_CENTURY;
    double T2 = T * T;
    double T3 = T2 * T;
    double T4 = T3 * T;
    double T5 = T4 * T;

    // GMST in seconds (IAU 2006)
    // GMST = GMST0 + 1.00273781191135448 * UT1
    double gmst_sec =
        67310.54841 +
        (876600.0 * 3600.0 + 8640184.812866) * T +
        0.093104 * T2 -
        6.2e-6 * T3;

    // Convert to radians and normalize
    double gmst_rad = std::fmod(gmst_sec / 240.0 * PI / 180.0, TWO_PI);
    if (gmst_rad < 0.0) gmst_rad += TWO_PI;

    return gmst_rad;
}

double ut1ToGast(double ut1_jd) {
    // GAST = GMST + equation of equinoxes
    double gmst = ut1ToGmst(ut1_jd);

    // Simplified equation of equinoxes (nutation in longitude)
    // Full computation would require nutation model (IAU 2000A/B)
    double T = (ut1_jd - J2000_JD) / DAYS_PER_JULIAN_CENTURY;

    // Mean longitude of ascending node of Moon
    double omega = 125.04452 - 1934.136261 * T;
    omega = std::fmod(omega, 360.0) * PI / 180.0;

    // Mean longitude of Sun
    double L = 280.4665 + 36000.7698 * T;
    L = std::fmod(L, 360.0) * PI / 180.0;

    // Mean longitude of Moon
    double Lprime = 218.3165 + 481267.8813 * T;
    Lprime = std::fmod(Lprime, 360.0) * PI / 180.0;

    // Simplified nutation in longitude (arcseconds)
    double dpsi = -17.20 * std::sin(omega)
                  - 1.32 * std::sin(2.0 * L)
                  - 0.23 * std::sin(2.0 * Lprime)
                  + 0.21 * std::sin(2.0 * omega);

    // Mean obliquity of the ecliptic (arcseconds)
    double eps0 = 84381.406 - 46.836769 * T;
    double eps_rad = eps0 * ARCSEC_TO_RAD;

    // Equation of equinoxes
    double eqeq = dpsi * std::cos(eps_rad) * ARCSEC_TO_RAD;

    double gast = gmst + eqeq;
    if (gast < 0.0) gast += TWO_PI;
    if (gast >= TWO_PI) gast -= TWO_PI;

    return gast;
}

double ut1ToEra(double ut1_jd) {
    // Earth Rotation Angle (ERA) - IERS 2000 model
    // ERA is the angle between CIO and TIO measured along the CIP equator

    // UT1 Julian date as integer and fraction
    double jd0 = std::floor(ut1_jd - 0.5) + 0.5;  // JD at 0h UT1
    double t = ut1_jd - J2000_JD;  // Days since J2000.0

    // ERA = 2*pi * (0.7790572732640 + 1.00273781191135448 * Du)
    // where Du is UT1 days since J2000.0
    double theta = TWO_PI * (0.7790572732640 + 1.00273781191135448 * t);

    // Normalize to [0, 2*pi)
    theta = std::fmod(theta, TWO_PI);
    if (theta < 0.0) theta += TWO_PI;

    return theta;
}

// =============================================================================
// General Conversion
// =============================================================================

Epoch convert(const Epoch& from, TimeScale to) {
    // If same scale, return copy
    if (from.scale == to) {
        return from;
    }

    double jd = from.jd;

    // Convert to TAI as intermediate (hub-and-spoke model)
    double tai_jd;

    switch (from.scale) {
        case TimeScale::UTC:
            tai_jd = utcToTai(jd);
            break;
        case TimeScale::TAI:
            tai_jd = jd;
            break;
        case TimeScale::TT:
            tai_jd = ttToTai(jd);
            break;
        case TimeScale::TDB:
            tai_jd = ttToTai(tdbToTt(jd));
            break;
        case TimeScale::TCG:
            tai_jd = ttToTai(tcgToTt(jd));
            break;
        case TimeScale::TCB:
            tai_jd = ttToTai(tdbToTt(tcbToTdb(jd)));
            break;
        case TimeScale::GPS:
            tai_jd = gpsToTai(jd);
            break;
        case TimeScale::UT1:
            tai_jd = utcToTai(ut1ToUtc(jd));
            break;
        case TimeScale::GMST:
        case TimeScale::GAST:
            // GMST/GAST are angles, not time scales for conversion
            // This is a conceptual mismatch; return unchanged
            return from;
        default:
            return from;
    }

    // Convert from TAI to target scale
    double result_jd;

    switch (to) {
        case TimeScale::UTC:
            result_jd = taiToUtc(tai_jd);
            break;
        case TimeScale::TAI:
            result_jd = tai_jd;
            break;
        case TimeScale::TT:
            result_jd = taiToTt(tai_jd);
            break;
        case TimeScale::TDB:
            result_jd = ttToTdb(taiToTt(tai_jd));
            break;
        case TimeScale::TCG:
            result_jd = ttToTcg(taiToTt(tai_jd));
            break;
        case TimeScale::TCB:
            result_jd = tdbToTcb(ttToTdb(taiToTt(tai_jd)));
            break;
        case TimeScale::GPS:
            result_jd = taiToGps(tai_jd);
            break;
        case TimeScale::UT1:
            result_jd = utcToUt1(taiToUtc(tai_jd));
            break;
        case TimeScale::GMST:
            // Return GMST as a JD-like value (angle in radians stored as JD)
            // This is unconventional but allows the Epoch struct to hold it
            result_jd = ut1ToGmst(utcToUt1(taiToUtc(tai_jd)));
            break;
        case TimeScale::GAST:
            result_jd = ut1ToGast(utcToUt1(taiToUtc(tai_jd)));
            break;
        default:
            result_jd = tai_jd;
            break;
    }

    return Epoch(result_jd, to);
}

// =============================================================================
// Epoch Methods Implementation
// =============================================================================

void Epoch::toComponents(int& year, int& month, int& day,
                         int& hour, int& minute, double& second) const {
    // Convert JD to calendar date using algorithm from Meeus, Astronomical Algorithms
    double Z = std::floor(jd + 0.5);
    double F = (jd + 0.5) - Z;

    double A;
    if (Z < 2299161.0) {
        A = Z;
    } else {
        double alpha = std::floor((Z - 1867216.25) / 36524.25);
        A = Z + 1 + alpha - std::floor(alpha / 4.0);
    }

    double B = A + 1524;
    double C = std::floor((B - 122.1) / 365.25);
    double D = std::floor(365.25 * C);
    double E = std::floor((B - D) / 30.6001);

    day = static_cast<int>(B - D - std::floor(30.6001 * E));

    if (E < 14) {
        month = static_cast<int>(E - 1);
    } else {
        month = static_cast<int>(E - 13);
    }

    if (month > 2) {
        year = static_cast<int>(C - 4716);
    } else {
        year = static_cast<int>(C - 4715);
    }

    // Time of day
    double dayFrac = F * 24.0;
    hour = static_cast<int>(dayFrac);
    double minFrac = (dayFrac - hour) * 60.0;
    minute = static_cast<int>(minFrac);
    second = (minFrac - minute) * 60.0;
}

Epoch Epoch::fromComponents(int year, int month, int day,
                            int hour, int minute, double second,
                            TimeScale scale) {
    // Convert calendar date to JD using algorithm from Meeus
    int Y = year;
    int M = month;

    if (M <= 2) {
        Y -= 1;
        M += 12;
    }

    int A = Y / 100;
    int B = 2 - A + A / 4;

    double JD = std::floor(365.25 * (Y + 4716))
              + std::floor(30.6001 * (M + 1))
              + day + B - 1524.5;

    // Add time of day
    JD += (hour + minute / 60.0 + second / 3600.0) / 24.0;

    return Epoch(JD, scale);
}

void Epoch::toIso8601(char* buffer, size_t bufferSize) const {
    if (buffer == nullptr || bufferSize < 32) {
        return;
    }

    int year, month, day, hour, minute;
    double second;
    toComponents(year, month, day, hour, minute, second);

    // Format: "YYYY-MM-DDTHH:MM:SS.sss SCALE"
    int intSec = static_cast<int>(second);
    int millis = static_cast<int>((second - intSec) * 1000);

    std::snprintf(buffer, bufferSize, "%04d-%02d-%02dT%02d:%02d:%02d.%03d %s",
                  year, month, day, hour, minute, intSec, millis,
                  scaleName());
}

Epoch Epoch::fromIso8601(const char* str, TimeScale scale) {
    if (str == nullptr) {
        return Epoch();
    }

    int year, month, day, hour = 0, minute = 0;
    double second = 0.0;

    // Parse "YYYY-MM-DDTHH:MM:SS" or "YYYY-MM-DD"
    int matched = std::sscanf(str, "%d-%d-%dT%d:%d:%lf",
                              &year, &month, &day, &hour, &minute, &second);

    if (matched < 3) {
        // Try alternative format "YYYY-MM-DD HH:MM:SS"
        matched = std::sscanf(str, "%d-%d-%d %d:%d:%lf",
                              &year, &month, &day, &hour, &minute, &second);
    }

    if (matched < 3) {
        return Epoch();  // Invalid format
    }

    return fromComponents(year, month, day, hour, minute, second, scale);
}

const char* Epoch::scaleName() const {
    return timeScaleName(scale);
}

// =============================================================================
// Time Scale Name Lookup
// =============================================================================

const char* timeScaleName(TimeScale scale) {
    switch (scale) {
        case TimeScale::UTC:  return "UTC";
        case TimeScale::TAI:  return "TAI";
        case TimeScale::TT:   return "TT";
        case TimeScale::TDB:  return "TDB";
        case TimeScale::TCG:  return "TCG";
        case TimeScale::TCB:  return "TCB";
        case TimeScale::GPS:  return "GPS";
        case TimeScale::UT1:  return "UT1";
        case TimeScale::GMST: return "GMST";
        case TimeScale::GAST: return "GAST";
        default:              return "Unknown";
    }
}

}  // namespace timesys
