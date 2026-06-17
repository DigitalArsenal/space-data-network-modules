/**
 * US Standard Atmosphere 1976
 * Ported from OrbPro2-ModSim/plugins/atmosphere/src/us76.cpp
 *
 * Reference: US Standard Atmosphere, 1976 (NOAA-S/T 76-1562)
 */

#include "atmosphere/models.h"
#include <cmath>
#include <limits>

namespace atmosphere {

// Layer base geopotential altitudes [m]
static const double H_LAYER[8] = {
    0.0, 11000.0, 20000.0, 32000.0, 47000.0, 51000.0, 71000.0, 84852.0
};

// Layer base temperatures [K]
static const double T_LAYER[7] = {
    288.15, 216.65, 216.65, 228.65, 270.65, 270.65, 214.65
};

// Layer temperature lapse rates [K/m]
static const double L_LAYER[7] = {
    -0.0065, 0.0, 0.001, 0.0028, 0.0, -0.0028, -0.002
};

// Layer base pressures [Pa] — precomputed
static const double P_LAYER[7] = {
    101325.0, 22632.06, 5474.889, 868.0187, 110.9063, 66.93887, 3.956420
};

static int findLayer(double H) {
    for (int i = 6; i >= 0; --i)
        if (H >= H_LAYER[i]) return i;
    return 0;
}

State us76(double altitude_m) {
    State s;

    if (altitude_m < 0) altitude_m = 0;
    if (altitude_m > US76_MAX_ALT) altitude_m = US76_MAX_ALT;

    double H = geopotentialAlt(altitude_m);
    if (H < 0) H = 0;
    if (H > H_LAYER[7]) H = H_LAYER[7];

    int layer = findLayer(H);
    double dH = H - H_LAYER[layer];

    // Temperature
    s.temperature = T_LAYER[layer] + L_LAYER[layer] * dH;

    // Pressure: barometric formula
    // GMR = g0 * M0 / R* (in consistent units)
    const double GMR = G0 * M0_KGKMOL / R_UNIVERSAL;

    if (std::fabs(L_LAYER[layer]) < 1e-10) {
        // Isothermal
        s.pressure = P_LAYER[layer] * std::exp(-GMR * dH / T_LAYER[layer]);
    } else {
        // Gradient
        double exponent = GMR / L_LAYER[layer];
        s.pressure = P_LAYER[layer] * std::pow(T_LAYER[layer] / s.temperature, exponent);
    }

    // Density from ideal gas law
    s.density = s.pressure / (R_SPECIFIC * s.temperature);

    // Speed of sound
    s.soundSpeed = speedOfSound(s.temperature);

    s.molecularMass = M0_KGKMOL;
    s.exosphericTemp = s.temperature;

    return s;
}

double us76_density(double alt)       { return us76(alt).density; }
double us76_temperature(double alt)   { return us76(alt).temperature; }
double us76_pressure(double alt)      { return us76(alt).pressure; }
double us76_speedOfSound(double alt)  { return us76(alt).soundSpeed; }

double standardAtmosphere1976OrbitalDensity(double altitude_m) {
    const double alt_km = altitude_m / 1000.0;
    if (alt_km < 100.0) {
        return us76_density(altitude_m);
    }

    double logdensity = 0.0;
    if (alt_km > 1000.0) {
        logdensity = (-7e-05) * alt_km - 14.464;
    } else {
        const double val = (alt_km - 526.8000) / 292.8563;
        logdensity = 0.34047 * std::pow(val, 6) -
                     0.5889 * std::pow(val, 5) -
                     0.5269 * std::pow(val, 4) +
                     1.0036 * std::pow(val, 3) +
                     0.60713 * std::pow(val, 2) -
                     2.3024 * val -
                     12.575;
    }
    return std::pow(10.0, logdensity);
}

double basiliskDebyeLength(double altitude_m) {
    double alt_km = altitude_m / 1000.0;
    constexpr double X[] = {
        200.0, 250.0, 300.0, 350.0, 400.0, 450.0, 500.0, 550.0,
        600.0, 650.0, 700.0, 750.0, 800.0, 850.0, 900.0, 950.0,
        1000.0, 1050.0, 1100.0, 1150.0, 1200.0, 1250.0, 1300.0,
        1350.0, 1400.0, 1450.0, 1500.0, 1550.0, 1600.0, 1650.0,
        1700.0, 1750.0, 1800.0, 1850.0, 1900.0, 1950.0, 2000.0,
    };
    constexpr double Y[] = {
        5.64E-03, 3.92E-03, 3.24E-03, 3.59E-03, 4.04E-03,
        4.28E-03, 4.54E-03, 5.30E-03, 6.55E-03, 7.30E-03,
        8.31E-03, 8.38E-03, 8.45E-03, 9.84E-03, 1.22E-02,
        1.37E-02, 1.59E-02, 1.75E-02, 1.95E-02, 2.09E-02,
        2.25E-02, 2.25E-02, 2.25E-02, 2.47E-02, 2.76E-02,
        2.76E-02, 2.76E-02, 2.76E-02, 2.76E-02, 2.76E-02,
        2.76E-02, 3.21E-02, 3.96E-02, 3.96E-02, 3.96E-02,
        3.96E-02, 3.96E-02,
    };
    constexpr int n = static_cast<int>(sizeof(X) / sizeof(X[0]));

    if ((alt_km < 200.0) || (alt_km > 35000.0)) {
        return std::numeric_limits<double>::quiet_NaN();
    }
    if (alt_km > 30000.0) {
        return 0.1 * alt_km - 2999.7;
    }
    if (alt_km >= 2000.0) {
        return Y[n - 1];
    }

    int i = 0;
    for (; i < n - 1; ++i) {
        if (X[i + 1] > alt_km) {
            break;
        }
    }
    const double a = (alt_km - X[i]) / (X[i + 1] - X[i]);
    return Y[i] + a * (Y[i + 1] - Y[i]);
}

void basiliskAtmosphericDragAcceleration(double drag_coefficient,
                                         double area_m2,
                                         double mass_kg,
                                         const double position_m[3],
                                         const double velocity_m_per_s[3],
                                         double acceleration_m_per_s2[3]) {
    constexpr double BSK_EARTH_EQUATORIAL_RADIUS_M = 6378136.6;
    const double nan = std::numeric_limits<double>::quiet_NaN();

    const double radius_m = std::sqrt(position_m[0] * position_m[0] +
                                      position_m[1] * position_m[1] +
                                      position_m[2] * position_m[2]);
    const double speed_m_per_s = std::sqrt(velocity_m_per_s[0] * velocity_m_per_s[0] +
                                           velocity_m_per_s[1] * velocity_m_per_s[1] +
                                           velocity_m_per_s[2] * velocity_m_per_s[2]);
    const double altitude_m = radius_m - BSK_EARTH_EQUATORIAL_RADIUS_M;

    if (altitude_m <= 0.0 || speed_m_per_s <= 0.0 || mass_kg <= 0.0) {
        acceleration_m_per_s2[0] = nan;
        acceleration_m_per_s2[1] = nan;
        acceleration_m_per_s2[2] = nan;
        return;
    }

    const double density = standardAtmosphere1976OrbitalDensity(altitude_m);
    const double scale = -0.5 * density * (drag_coefficient * area_m2 / mass_kg) *
                         speed_m_per_s;
    acceleration_m_per_s2[0] = scale * velocity_m_per_s[0];
    acceleration_m_per_s2[1] = scale * velocity_m_per_s[1];
    acceleration_m_per_s2[2] = scale * velocity_m_per_s[2];
}

}  // namespace atmosphere
