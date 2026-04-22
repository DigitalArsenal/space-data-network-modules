// time_convert.h - Time Systems Conversion Functions
// =============================================================================
// Provides functions for converting between astronomical time scales.
// Includes leap second handling and DUT1 support.
//
// Task 6.2: Time Systems Plugin
//
// References:
// - IERS Conventions (2010)
// - SOFA (Standards of Fundamental Astronomy) library
// - USNO Circular 179
// =============================================================================

#ifndef ORBPRO2_TIME_CONVERT_H
#define ORBPRO2_TIME_CONVERT_H

#include "time_types.h"

namespace timesys {

// =============================================================================
// Core Time Scale Conversions
// =============================================================================
// All functions take Julian date in the source scale and return Julian date
// in the target scale.
// =============================================================================

/// Convert UTC to TAI
/// TAI = UTC + leap_seconds
/// @param utc_jd Julian date in UTC
/// @return Julian date in TAI
double utcToTai(double utc_jd);

/// Convert TAI to UTC
/// UTC = TAI - leap_seconds
/// @param tai_jd Julian date in TAI
/// @return Julian date in UTC
double taiToUtc(double tai_jd);

/// Convert TAI to TT (Terrestrial Time)
/// TT = TAI + 32.184 seconds
/// @param tai_jd Julian date in TAI
/// @return Julian date in TT
double taiToTt(double tai_jd);

/// Convert TT to TAI
/// TAI = TT - 32.184 seconds
/// @param tt_jd Julian date in TT
/// @return Julian date in TAI
double ttToTai(double tt_jd);

/// Convert TT to TDB (Barycentric Dynamical Time)
/// TDB = TT + periodic terms (max ~1.7 ms)
/// Uses simplified FB2001 model
/// @param tt_jd Julian date in TT
/// @return Julian date in TDB
double ttToTdb(double tt_jd);

/// Convert TDB to TT
/// Inverse of ttToTdb (iterative)
/// @param tdb_jd Julian date in TDB
/// @return Julian date in TT
double tdbToTt(double tdb_jd);

/// Convert UTC to GPS time
/// GPS = UTC + leap_seconds - 19 (since GPS epoch)
/// @param utc_jd Julian date in UTC
/// @return Julian date in GPS time
double utcToGps(double utc_jd);

/// Convert GPS time to UTC
/// UTC = GPS - leap_seconds + 19
/// @param gps_jd Julian date in GPS time
/// @return Julian date in UTC
double gpsToUtc(double gps_jd);

/// Convert TAI to GPS time
/// GPS = TAI - 19 seconds (constant offset)
/// @param tai_jd Julian date in TAI
/// @return Julian date in GPS time
double taiToGps(double tai_jd);

/// Convert GPS time to TAI
/// TAI = GPS + 19 seconds (constant offset)
/// @param gps_jd Julian date in GPS time
/// @return Julian date in TAI
double gpsToTai(double gps_jd);

/// Convert TT to TCG (Geocentric Coordinate Time)
/// TCG = TT + LG * (JD - T0), where LG = 6.969290134e-10
/// @param tt_jd Julian date in TT
/// @return Julian date in TCG
double ttToTcg(double tt_jd);

/// Convert TCG to TT
/// TT = TCG - LG * (JD - T0)
/// @param tcg_jd Julian date in TCG
/// @return Julian date in TT
double tcgToTt(double tcg_jd);

/// Convert TDB to TCB (Barycentric Coordinate Time)
/// TCB = TDB + LB * (JD - T0), where LB ~ 1.550519768e-8
/// @param tdb_jd Julian date in TDB
/// @return Julian date in TCB
double tdbToTcb(double tdb_jd);

/// Convert TCB to TDB
/// TDB = TCB - LB * (JD - T0)
/// @param tcb_jd Julian date in TCB
/// @return Julian date in TDB
double tcbToTdb(double tcb_jd);

// =============================================================================
// General Conversion Function
// =============================================================================

/// Convert an Epoch from one time scale to another
/// Handles all conversions via a chain of core conversions
/// @param from Source epoch
/// @param to Target time scale
/// @return Epoch in target time scale
Epoch convert(const Epoch& from, TimeScale to);

// =============================================================================
// Leap Second Handling
// =============================================================================

/// Get the cumulative leap seconds (TAI - UTC) at a given UTC date
/// @param utc_jd Julian date in UTC
/// @return Number of leap seconds (TAI - UTC)
int32_t getLeapSeconds(double utc_jd);

/// Check if a given UTC Julian date falls within a leap second
/// A leap second occurs at 23:59:60 UTC
/// @param utc_jd Julian date in UTC
/// @return true if this instant is during a leap second
bool isLeapSecond(double utc_jd);

/// Add a new leap second to the table
/// Used to update the table when new leap seconds are announced
/// @param jd Julian date when leap second takes effect (at 00:00:00 UTC)
/// @param tai_utc TAI - UTC after this date
void addLeapSecond(double jd, int32_t tai_utc);

/// Get the number of leap seconds in the table
/// @return Count of leap second entries
size_t getLeapSecondCount();

/// Get a leap second entry by index
/// @param index Index into leap second table (0-based)
/// @param out Output leap second entry
/// @return true if index is valid
bool getLeapSecondEntry(size_t index, LeapSecond& out);

// =============================================================================
// DUT1 (UT1 - UTC) Handling
// =============================================================================
// DUT1 is published by IERS in Bulletin A and typically |DUT1| < 0.9s
// It must be set from external data (not computed analytically)
// =============================================================================

/// Set the current DUT1 value (UT1 - UTC)
/// @param dut1 DUT1 value in seconds
void setDut1(double dut1);

/// Get the current DUT1 value
/// @return DUT1 value in seconds (default 0.0)
double getDut1();

/// Convert UTC to UT1
/// UT1 = UTC + DUT1
/// @param utc_jd Julian date in UTC
/// @return Julian date in UT1
double utcToUt1(double utc_jd);

/// Convert UT1 to UTC
/// UTC = UT1 - DUT1
/// @param ut1_jd Julian date in UT1
/// @return Julian date in UTC
double ut1ToUtc(double ut1_jd);

// =============================================================================
// Sidereal Time Conversions
// =============================================================================

/// Calculate Greenwich Mean Sidereal Time (GMST) from UT1
/// @param ut1_jd Julian date in UT1
/// @return GMST in radians [0, 2*pi)
double ut1ToGmst(double ut1_jd);

/// Calculate Greenwich Apparent Sidereal Time (GAST) from UT1
/// GAST = GMST + equation of equinoxes
/// @param ut1_jd Julian date in UT1
/// @return GAST in radians [0, 2*pi)
double ut1ToGast(double ut1_jd);

/// Calculate Earth Rotation Angle (ERA) from UT1
/// ERA is the modern replacement for GMST
/// @param ut1_jd Julian date in UT1
/// @return ERA in radians [0, 2*pi)
double ut1ToEra(double ut1_jd);

// =============================================================================
// Utility Functions
// =============================================================================

/// Convert Julian date to Modified Julian Date
/// MJD = JD - 2400000.5
/// @param jd Julian date
/// @return Modified Julian date
inline double jdToMjd(double jd) {
    return jd - MJD_OFFSET;
}

/// Convert Modified Julian Date to Julian date
/// JD = MJD + 2400000.5
/// @param mjd Modified Julian date
/// @return Julian date
inline double mjdToJd(double mjd) {
    return mjd + MJD_OFFSET;
}

/// Get Julian centuries since J2000.0
/// @param jd Julian date
/// @return Julian centuries since J2000.0
inline double julianCenturiesJ2000(double jd) {
    return (jd - J2000_JD) / DAYS_PER_JULIAN_CENTURY;
}

/// Convert seconds to days
/// @param seconds Time in seconds
/// @return Time in days
inline double secondsToDays(double seconds) {
    return seconds / SECONDS_PER_DAY;
}

/// Convert days to seconds
/// @param days Time in days
/// @return Time in seconds
inline double daysToSeconds(double days) {
    return days * SECONDS_PER_DAY;
}

}  // namespace timesys

#endif // ORBPRO2_TIME_CONVERT_H
