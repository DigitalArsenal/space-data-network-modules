/**
 * US Standard Atmosphere 1976
 * Ported from OrbPro2-ModSim/plugins/atmosphere/src/us76.cpp
 *
 * Reference: US Standard Atmosphere, 1976 (NOAA-S/T 76-1562)
 */

#include "atmosphere/models.h"
#include <cmath>

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

}  // namespace atmosphere
