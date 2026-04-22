#ifndef ATMOSPHERE_SDN_TYPES_H
#define ATMOSPHERE_SDN_TYPES_H

#include <cstdint>
#include <cmath>
#include <algorithm>

namespace atmosphere {

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

static constexpr double R_SPECIFIC    = 287.053;    // J/(kg·K) specific gas constant for air
static constexpr double G0            = 9.80665;    // m/s² standard gravity
static constexpr double M0_KGKMOL     = 28.9644;    // kg/kmol mean molecular weight sea level
static constexpr double GAMMA         = 1.4;        // ratio of specific heats
static constexpr double R_UNIVERSAL   = 8314.32;    // J/(kmol·K)
static constexpr double P0            = 101325.0;   // Pa sea level pressure
static constexpr double T0            = 288.15;     // K sea level temperature
static constexpr double RHO0          = 1.225;      // kg/m³ sea level density
static constexpr double EARTH_RADIUS  = 6356766.0;  // m for geopotential conversion
static constexpr double AVOGADRO      = 6.022169e23;
static constexpr double BOLTZMANN     = 1.380622e-23; // J/K

// Model altitude limits
static constexpr double US76_MAX_ALT      = 86000.0;    // m
static constexpr double NRLMSISE_MAX_ALT  = 1000000.0;  // m

// ---------------------------------------------------------------------------
// Atmosphere Model Selection
// ---------------------------------------------------------------------------

enum class Model : uint8_t {
    US76       = 0,   // US Standard Atmosphere 1976 (0-86 km, altitude-only)
    NRLMSISE00 = 1,   // NRLMSISE-00 (0-1000 km, solar/geomagnetic dependent)
};

// ---------------------------------------------------------------------------
// Atmospheric State
// ---------------------------------------------------------------------------

struct State {
    double density      = RHO0;    // kg/m³
    double temperature  = T0;      // K
    double pressure     = P0;      // Pa
    double soundSpeed   = 340.294; // m/s

    // Extended NRLMSISE-00 outputs
    double molecularMass = M0_KGKMOL;  // g/mol
    double numDensityN2  = 0;     // 1/m³
    double numDensityO2  = 0;
    double numDensityO   = 0;
    double numDensityHe  = 0;
    double numDensityAr  = 0;
    double numDensityH   = 0;
    double numDensityN   = 0;
    double exosphericTemp = 0;    // K
};

// ---------------------------------------------------------------------------
// Wind Vector (local NED frame)
// ---------------------------------------------------------------------------

struct WindVec {
    double north = 0;  // m/s toward north
    double east  = 0;  // m/s toward east
    double down  = 0;  // m/s downward
};

// ---------------------------------------------------------------------------
// Geographic Position
// ---------------------------------------------------------------------------

struct GeoPos {
    double lat_rad = 0;  // geodetic latitude [rad]
    double lon_rad = 0;  // geodetic longitude [rad]
    double alt_m   = 0;  // altitude above MSL [m]
};

// ---------------------------------------------------------------------------
// Solar & Geomagnetic Activity (for NRLMSISE-00)
// ---------------------------------------------------------------------------

struct SolarActivity {
    double F107  = 150.0;  // daily F10.7 solar flux (previous day) [SFU]
    double F107A = 150.0;  // 81-day centered average F10.7 [SFU]
    double Ap[7] = {4,4,4,4,4,4,4}; // magnetic index array
};

// ---------------------------------------------------------------------------
// Time Epoch
// ---------------------------------------------------------------------------

struct Epoch {
    int32_t year       = 2024;
    int32_t dayOfYear  = 1;
    double  secondOfDay = 43200.0; // noon UTC
};

// ---------------------------------------------------------------------------
// Derived quantities
// ---------------------------------------------------------------------------

inline double speedOfSound(double temperature_K) {
    return std::sqrt(GAMMA * R_SPECIFIC * temperature_K);
}

inline double dynamicPressure(double density, double speed) {
    return 0.5 * density * speed * speed;
}

inline double machNumber(double speed, double soundSpd) {
    return speed / std::max(soundSpd, 1.0);
}

inline double stagnationTemp(double T_freestream, double mach) {
    return T_freestream * (1.0 + (GAMMA - 1.0) / 2.0 * mach * mach);
}

inline double geopotentialAlt(double geometric) {
    return (EARTH_RADIUS * geometric) / (EARTH_RADIUS + geometric);
}

inline double geometricAlt(double geopotential) {
    return (EARTH_RADIUS * geopotential) / (EARTH_RADIUS - geopotential);
}

}  // namespace atmosphere

#endif  // ATMOSPHERE_SDN_TYPES_H
