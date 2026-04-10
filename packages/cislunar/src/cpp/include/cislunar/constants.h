#ifndef CISLUNAR_CONSTANTS_H
#define CISLUNAR_CONSTANTS_H

#include "types.h"

namespace cislunar {

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

constexpr double G = 6.67430e-11;           // gravitational constant [m^3/(kg·s^2)]
constexpr double MU_EARTH = 3.986004418e14; // Earth μ [m^3/s^2]
constexpr double MU_MOON  = 4.9048695e12;   // Moon μ [m^3/s^2]
constexpr double MU_SUN   = 1.32712440018e20; // Sun μ [m^3/s^2]

constexpr double R_EARTH  = 6.3781e6;       // Earth equatorial radius [m]
constexpr double R_MOON   = 1.7374e6;       // Moon mean radius [m]

constexpr double M_EARTH  = 5.97219e24;     // Earth mass [kg]
constexpr double M_MOON   = 7.34767309e22;  // Moon mass [kg]
constexpr double M_SUN    = 1.989e30;       // Sun mass [kg]

constexpr double AU       = 1.496e11;       // Astronomical Unit [m]

// Earth-Moon system
constexpr double EM_DISTANCE = 3.844e8;     // mean Earth-Moon distance [m]
constexpr double EM_PERIOD   = 2.3606e6;    // sidereal lunar period [s] (~27.3 days)

constexpr double TWO_PI   = 6.283185307179586;
constexpr double DEG_TO_RAD = 0.017453292519943295;
constexpr double RAD_TO_DEG = 57.29577951308232;

// ---------------------------------------------------------------------------
// Pre-configured CR3BP systems
// ---------------------------------------------------------------------------

/// Earth-Moon CR3BP system
inline CR3BPSystem earthMoonSystem() {
    double mu = M_MOON / (M_EARTH + M_MOON);  // ~0.01215
    return {
        mu,
        EM_DISTANCE,       // l* = Earth-Moon distance
        EM_PERIOD / TWO_PI, // t* = 1/(angular velocity)
        M_EARTH,
        M_MOON,
        "Earth-Moon"
    };
}

/// Sun-Earth CR3BP system
inline CR3BPSystem sunEarthSystem() {
    double mu = M_EARTH / (M_SUN + M_EARTH);  // ~3.003e-6
    return {
        mu,
        AU,                    // l* = 1 AU
        365.25 * 86400.0 / TWO_PI, // t*
        M_SUN,
        M_EARTH,
        "Sun-Earth"
    };
}

/// Sun-Jupiter CR3BP system (for interplanetary)
inline CR3BPSystem sunJupiterSystem() {
    constexpr double M_JUPITER = 1.898e27;
    double mu = M_JUPITER / (M_SUN + M_JUPITER);
    return {
        mu,
        7.783e11,              // Jupiter SMA
        (11.862 * 365.25 * 86400.0) / TWO_PI,
        M_SUN,
        M_JUPITER,
        "Sun-Jupiter"
    };
}

}  // namespace cislunar

#endif  // CISLUNAR_CONSTANTS_H
