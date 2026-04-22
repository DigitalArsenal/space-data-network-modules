// time_types.h - Time Systems Types
// =============================================================================
// Defines time scales, epoch representation, and leap second structures for
// astronomical time conversions.
//
// Task 6.2: Time Systems Plugin
// =============================================================================

#ifndef ORBPRO2_TIME_TYPES_H
#define ORBPRO2_TIME_TYPES_H

#include <cstdint>
#include <cstddef>

namespace timesys {

// =============================================================================
// Time Scales
// =============================================================================
// Reference: IERS Conventions, SOFA Software Library
//
// UTC  - Coordinated Universal Time (civil time, includes leap seconds)
// TAI  - International Atomic Time (continuous, no leap seconds)
// TT   - Terrestrial Time (formerly TDT, used for geocentric ephemerides)
// TDB  - Barycentric Dynamical Time (used for planetary ephemerides)
// TCG  - Geocentric Coordinate Time (proper time for geocentric frame)
// TCB  - Barycentric Coordinate Time (proper time for barycentric frame)
// GPS  - GPS Time (constant offset from TAI, no leap seconds)
// UT1  - Universal Time (Earth rotation angle based)
// GMST - Greenwich Mean Sidereal Time
// GAST - Greenwich Apparent Sidereal Time (includes nutation)
// =============================================================================

enum class TimeScale : uint8_t {
    UTC  = 0,   // Coordinated Universal Time
    TAI  = 1,   // International Atomic Time
    TT   = 2,   // Terrestrial Time (TDT)
    TDB  = 3,   // Barycentric Dynamical Time
    TCG  = 4,   // Geocentric Coordinate Time
    TCB  = 5,   // Barycentric Coordinate Time
    GPS  = 6,   // GPS Time
    UT1  = 7,   // Universal Time
    GMST = 8,   // Greenwich Mean Sidereal Time
    GAST = 9    // Greenwich Apparent Sidereal Time
};

// Number of time scales
constexpr int NUM_TIME_SCALES = 10;

// =============================================================================
// Time Constants
// =============================================================================

// Julian date of J2000.0 epoch (2000-01-01T12:00:00 TT)
constexpr double J2000_JD = 2451545.0;

// Julian date of GPS epoch (1980-01-06T00:00:00 UTC)
constexpr double GPS_EPOCH_JD = 2444244.5;

// Julian date of TAI epoch (1958-01-01T00:00:00)
constexpr double TAI_EPOCH_JD = 2436204.5;

// Modified Julian Date offset
constexpr double MJD_OFFSET = 2400000.5;

// Seconds per day
constexpr double SECONDS_PER_DAY = 86400.0;

// Days per Julian century
constexpr double DAYS_PER_JULIAN_CENTURY = 36525.0;

// TT - TAI offset (32.184 seconds)
constexpr double TT_TAI_OFFSET = 32.184;

// GPS - TAI offset (-19 seconds; GPS = TAI - 19)
constexpr double GPS_TAI_OFFSET = -19.0;

// =============================================================================
// Epoch Structure
// =============================================================================
// Represents a point in time in a specific time scale.
// Uses Julian Date for high precision (1 day = 1 unit).
// =============================================================================

struct Epoch {
    double jd;          // Julian date (whole days + fraction)
    TimeScale scale;    // Time scale

    // Default constructor
    Epoch() : jd(0.0), scale(TimeScale::UTC) {}

    // Parameterized constructor
    Epoch(double julian_date, TimeScale time_scale)
        : jd(julian_date), scale(time_scale) {}

    // ==========================================================================
    // Conversion to/from calendar components
    // ==========================================================================

    /// Convert Julian date to calendar components
    /// @param year Output: year (negative for BCE)
    /// @param month Output: month (1-12)
    /// @param day Output: day of month (1-31)
    /// @param hour Output: hour (0-23)
    /// @param minute Output: minute (0-59)
    /// @param second Output: second (0-59.999...)
    void toComponents(int& year, int& month, int& day,
                      int& hour, int& minute, double& second) const;

    /// Create Epoch from calendar components
    /// @param year Year (negative for BCE)
    /// @param month Month (1-12)
    /// @param day Day of month (1-31)
    /// @param hour Hour (0-23)
    /// @param minute Minute (0-59)
    /// @param second Second (0-59.999...)
    /// @param scale Time scale
    /// @return Epoch in specified time scale
    static Epoch fromComponents(int year, int month, int day,
                                int hour, int minute, double second,
                                TimeScale scale);

    // ==========================================================================
    // ISO 8601 String Conversion
    // ==========================================================================

    /// Convert to ISO 8601 string format
    /// Format: "YYYY-MM-DDTHH:MM:SS.sss SCALE"
    /// @param buffer Output buffer (must be at least 32 bytes)
    /// @param bufferSize Size of output buffer
    void toIso8601(char* buffer, size_t bufferSize) const;

    /// Parse ISO 8601 string
    /// @param str Input string in ISO 8601 format
    /// @param scale Time scale to assign (not parsed from string)
    /// @return Epoch, or invalid epoch if parsing fails
    static Epoch fromIso8601(const char* str, TimeScale scale);

    // ==========================================================================
    // Utility Methods
    // ==========================================================================

    /// Get Modified Julian Date (MJD = JD - 2400000.5)
    double toMjd() const { return jd - MJD_OFFSET; }

    /// Create from Modified Julian Date
    static Epoch fromMjd(double mjd, TimeScale scale) {
        return Epoch(mjd + MJD_OFFSET, scale);
    }

    /// Check if epoch is valid (JD > 0)
    bool isValid() const { return jd > 0.0; }

    /// Get Julian centuries since J2000.0
    double julianCenturiesSinceJ2000() const {
        return (jd - J2000_JD) / DAYS_PER_JULIAN_CENTURY;
    }

    /// Get the time scale name as a string
    const char* scaleName() const;
};

// =============================================================================
// Leap Second Entry
// =============================================================================
// Represents when a leap second was inserted and the cumulative TAI-UTC offset.
// =============================================================================

struct LeapSecond {
    double jd;          // Julian date when leap second takes effect (at 00:00:00 UTC)
    int32_t tai_utc;    // TAI - UTC after this date (cumulative seconds)

    LeapSecond() : jd(0.0), tai_utc(0) {}
    LeapSecond(double julian_date, int32_t offset)
        : jd(julian_date), tai_utc(offset) {}
};

// =============================================================================
// Time Scale Name Lookup
// =============================================================================

/// Get the name of a time scale
/// @param scale Time scale enum
/// @return Static string with scale name
const char* timeScaleName(TimeScale scale);

}  // namespace timesys

#endif // ORBPRO2_TIME_TYPES_H
