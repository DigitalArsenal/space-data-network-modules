/**
 * @file us76.cpp
 * @brief US Standard Atmosphere 1976 implementation
 *
 * Implements the US Standard Atmosphere 1976 model for altitudes 0-86 km.
 * Uses layer-based temperature profiles with lapse rates and barometric formulas.
 *
 * References:
 * - US Standard Atmosphere, 1976 (NOAA-S/T 76-1562)
 */

#include <hpop/atmosphere.h>
#include <cmath>

/* ============================================================================
 * Constants
 * ============================================================================ */

/* Earth's radius for geopotential altitude conversion [m] */
static const double EARTH_RADIUS = 6356766.0;

/* Number of atmospheric layers in US76 */
static const int NUM_LAYERS = 7;

/* Layer base geopotential altitudes [m] */
static const double H_LAYER[8] = {
    0.0,      /* Layer 0: Troposphere */
    11000.0,  /* Layer 1: Tropopause (isothermal) */
    20000.0,  /* Layer 2: Stratosphere lower */
    32000.0,  /* Layer 3: Stratosphere upper */
    47000.0,  /* Layer 4: Stratopause (isothermal) */
    51000.0,  /* Layer 5: Mesosphere lower */
    71000.0,  /* Layer 6: Mesosphere upper */
    84852.0   /* Top of model (geometric ~86km) */
};

/* Layer base temperatures [K] */
static const double T_LAYER[7] = {
    288.15,   /* Layer 0: Sea level */
    216.65,   /* Layer 1: Tropopause */
    216.65,   /* Layer 2: Stratosphere lower base */
    228.65,   /* Layer 3: Stratosphere upper base */
    270.65,   /* Layer 4: Stratopause */
    270.65,   /* Layer 5: Mesosphere lower base */
    214.65    /* Layer 6: Mesosphere upper base */
};

/* Layer temperature lapse rates [K/m] */
static const double L_LAYER[7] = {
    -0.0065,  /* Layer 0: Troposphere lapse rate */
     0.0,     /* Layer 1: Tropopause (isothermal) */
     0.001,   /* Layer 2: Stratosphere lower */
     0.0028,  /* Layer 3: Stratosphere upper */
     0.0,     /* Layer 4: Stratopause (isothermal) */
    -0.0028,  /* Layer 5: Mesosphere lower */
    -0.002    /* Layer 6: Mesosphere upper */
};

/* Layer base pressures [Pa] - precomputed for efficiency */
static const double P_LAYER[7] = {
    101325.0,       /* Layer 0: Sea level */
    22632.06,       /* Layer 1: 11 km */
    5474.889,       /* Layer 2: 20 km */
    868.0187,       /* Layer 3: 32 km */
    110.9063,       /* Layer 4: 47 km */
    66.93887,       /* Layer 5: 51 km */
    3.956420        /* Layer 6: 71 km */
};

/* ============================================================================
 * Helper Functions
 * ============================================================================ */

/**
 * @brief Convert geometric altitude to geopotential altitude
 *
 * Uses the relationship: H = (r * Z) / (r + Z)
 * where r is Earth's radius, Z is geometric altitude, H is geopotential altitude.
 */
double us76_geometric_to_geopotential(double geometric)
{
    return (EARTH_RADIUS * geometric) / (EARTH_RADIUS + geometric);
}

/**
 * @brief Convert geopotential altitude to geometric altitude
 */
double us76_geopotential_to_geometric(double geopotential)
{
    return (EARTH_RADIUS * geopotential) / (EARTH_RADIUS - geopotential);
}

/**
 * @brief Find the layer index for a given geopotential altitude
 */
static int find_layer(double H)
{
    for (int i = NUM_LAYERS - 1; i >= 0; --i) {
        if (H >= H_LAYER[i]) {
            return i;
        }
    }
    return 0;
}

/**
 * @brief Calculate temperature at geopotential altitude within a layer
 */
static double calculate_temperature(double H, int layer)
{
    double dH = H - H_LAYER[layer];
    return T_LAYER[layer] + L_LAYER[layer] * dH;
}

/**
 * @brief Calculate pressure using barometric formula
 *
 * For isothermal layers (L = 0):
 *   P = Pb * exp(-g0 * M0 * dH / (R* * Tb))
 *
 * For gradient layers (L != 0):
 *   P = Pb * (Tb / T)^(g0 * M0 / (R* * L))
 */
static double calculate_pressure(double H, double T, int layer)
{
    double dH = H - H_LAYER[layer];
    double Pb = P_LAYER[layer];
    double Tb = T_LAYER[layer];
    double L = L_LAYER[layer];

    /* g0 * M0 / R* = 34.1631947 [K/m] equivalent */
    const double GMR = ATMOSPHERE_G0 * ATMOSPHERE_M0 / ATMOSPHERE_R_UNIVERSAL;

    if (std::fabs(L) < 1e-10) {
        /* Isothermal layer */
        return Pb * std::exp(-GMR * dH / Tb);
    } else {
        /* Gradient layer */
        double exponent = GMR / L;
        return Pb * std::pow(Tb / T, exponent);
    }
}

/**
 * @brief Calculate density using ideal gas law
 *
 * rho = P * M0 / (R* * T) = P / (R_specific * T)
 */
static double calculate_density(double P, double T)
{
    return P / (ATMOSPHERE_R_SPECIFIC * T);
}

/**
 * @brief Calculate speed of sound
 *
 * a = sqrt(gamma * R_specific * T)
 */
static double calculate_speed_of_sound(double T)
{
    return std::sqrt(ATMOSPHERE_GAMMA * ATMOSPHERE_R_SPECIFIC * T);
}

/* ============================================================================
 * Public API
 * ============================================================================ */

AtmosphereResult us76_calculate(double altitude, AtmosphereState* state)
{
    /* Validate inputs */
    if (state == nullptr) {
        return ATMOSPHERE_ERROR_INVALID_PARAMETER;
    }

    if (altitude < 0.0) {
        return ATMOSPHERE_ERROR_INVALID_ALTITUDE;
    }

    if (altitude > US76_MAX_ALTITUDE) {
        return ATMOSPHERE_ERROR_INVALID_ALTITUDE;
    }

    /* Convert geometric to geopotential altitude */
    double H = us76_geometric_to_geopotential(altitude);

    /* Clamp to valid range (should not happen after above checks) */
    if (H < 0.0) H = 0.0;
    if (H > H_LAYER[NUM_LAYERS]) H = H_LAYER[NUM_LAYERS];

    /* Find atmospheric layer */
    int layer = find_layer(H);

    /* Calculate atmospheric properties */
    double T = calculate_temperature(H, layer);
    double P = calculate_pressure(H, T, layer);
    double rho = calculate_density(P, T);
    double a = calculate_speed_of_sound(T);

    /* Fill output structure */
    state->temperature = T;
    state->pressure = P;
    state->density = rho;
    state->speedOfSound = a;

    /* US76 doesn't provide species breakdown - set to zero */
    state->molecularMass = ATMOSPHERE_M0;
    state->numDensityN2 = 0.0;
    state->numDensityO2 = 0.0;
    state->numDensityO = 0.0;
    state->numDensityHe = 0.0;
    state->numDensityAr = 0.0;
    state->numDensityH = 0.0;
    state->numDensityN = 0.0;
    state->exosphericTemp = T;

    return ATMOSPHERE_OK;
}

/* ============================================================================
 * Extended US76 calculations for specific properties
 * These provide optimized single-value queries
 * ============================================================================ */

/**
 * @brief Get US76 temperature at altitude
 */
double us76_get_temperature(double altitude)
{
    if (altitude < 0.0 || altitude > US76_MAX_ALTITUDE) {
        return -1.0;
    }

    double H = us76_geometric_to_geopotential(altitude);
    int layer = find_layer(H);
    return calculate_temperature(H, layer);
}

/**
 * @brief Get US76 pressure at altitude
 */
double us76_get_pressure(double altitude)
{
    if (altitude < 0.0 || altitude > US76_MAX_ALTITUDE) {
        return -1.0;
    }

    double H = us76_geometric_to_geopotential(altitude);
    int layer = find_layer(H);
    double T = calculate_temperature(H, layer);
    return calculate_pressure(H, T, layer);
}

/**
 * @brief Get US76 density at altitude
 */
double us76_get_density(double altitude)
{
    if (altitude < 0.0 || altitude > US76_MAX_ALTITUDE) {
        return -1.0;
    }

    double H = us76_geometric_to_geopotential(altitude);
    int layer = find_layer(H);
    double T = calculate_temperature(H, layer);
    double P = calculate_pressure(H, T, layer);
    return calculate_density(P, T);
}

/**
 * @brief Get US76 speed of sound at altitude
 */
double us76_get_speed_of_sound(double altitude)
{
    if (altitude < 0.0 || altitude > US76_MAX_ALTITUDE) {
        return -1.0;
    }

    double H = us76_geometric_to_geopotential(altitude);
    int layer = find_layer(H);
    double T = calculate_temperature(H, layer);
    return calculate_speed_of_sound(T);
}
