#ifndef MANEUVER_CONSTANTS_H
#define MANEUVER_CONSTANTS_H

namespace maneuver {

// ---------------------------------------------------------------------------
// Fundamental constants  (from constants.ts)
// ---------------------------------------------------------------------------

/// J2 zonal harmonic coefficient for Earth
constexpr double J2 = 1.08263e-3;

/// Mean equatorial radius of Earth [meters]
constexpr double R_EARTH = 6.3781e6;

/// Earth gravitational parameter [m^3/s^2]
constexpr double MU_EARTH = 3.986004418e14;

/// Seconds in one day
constexpr double SECONDS_PER_DAY = 86400.0;

/// 2 * pi
constexpr double TWO_PI = 6.283185307179586;

/// Degrees to radians conversion factor
constexpr double DEG_TO_RAD = 0.017453292519943295;

/// Radians to degrees conversion factor
constexpr double RAD_TO_DEG = 57.29577951308232;

// ---------------------------------------------------------------------------
// Solar system / interplanetary constants
// ---------------------------------------------------------------------------

/// Sun gravitational parameter [m^3/s^2]
constexpr double MU_SUN = 1.32712440018e20;

/// Astronomical unit [meters]
constexpr double AU = 1.496e11;

// ---------------------------------------------------------------------------
// Planet data for classical maneuver analysis
// ---------------------------------------------------------------------------

/// Basic planetary parameters for Hohmann / Lambert transfer calculations
struct Planet {
    double semiMajorAxis;   // heliocentric semi-major axis [meters]
    double mu;              // gravitational parameter [m^3/s^2]
};

/// Earth orbital and gravitational data
constexpr Planet EARTH = { 1.496e11, MU_EARTH };

/// Mars orbital and gravitational data
constexpr Planet MARS = { 2.279e11, 4.282837e13 };

/// Jupiter orbital and gravitational data
constexpr Planet JUPITER = { 7.783e11, 1.26687e17 };

}  // namespace maneuver

#endif  // MANEUVER_CONSTANTS_H
