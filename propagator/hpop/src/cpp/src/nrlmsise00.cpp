/**
 * @file nrlmsise00.cpp
 * @brief NRLMSISE-00 atmosphere model implementation
 *
 * Implements a simplified NRLMSISE-00 model suitable for WASM deployment.
 * Covers altitudes from 0 to 1000 km with solar/geomagnetic activity effects.
 *
 * References:
 * - Picone, J.M., et al., "NRLMSISE-00 empirical model of the atmosphere",
 *   Journal of Geophysical Research, 107(A12), 1468, 2002.
 *
 * This is a simplified implementation that captures the essential physics
 * while remaining compact for embedded/WASM use.
 */

#include <hpop/atmosphere.h>
#include <cmath>
#include <cstring>

/* ============================================================================
 * Physical Constants
 * ============================================================================ */

/* Avogadro's number */
static const double AVOGADRO = 6.022169e23;

/* Boltzmann constant [J/K] */
static const double BOLTZMANN = 1.380622e-23;

/* Molecular masses [kg] */
static const double MASS_N2 = 28.0134e-3 / AVOGADRO;
static const double MASS_O2 = 31.9988e-3 / AVOGADRO;
static const double MASS_O  = 15.9994e-3 / AVOGADRO;
static const double MASS_HE = 4.0026e-3 / AVOGADRO;
static const double MASS_AR = 39.948e-3 / AVOGADRO;
static const double MASS_H  = 1.00797e-3 / AVOGADRO;
static const double MASS_N  = 14.0067e-3 / AVOGADRO;

/* Reference altitude for density profile [km] */
static const double ZB = 120.0;

/* Reference values at 120 km */
static const double T120_REF = 355.0;  /* Temperature at 120 km [K] */
static const double N2_120 = 1.129e17; /* N2 number density at 120 km [1/m³] */
static const double O2_120 = 3.030e16; /* O2 number density at 120 km [1/m³] */
static const double O_120  = 4.427e17; /* O number density at 120 km [1/m³] */
static const double HE_120 = 1.355e13; /* He number density at 120 km [1/m³] */
static const double AR_120 = 1.272e15; /* Ar number density at 120 km [1/m³] */
static const double H_120  = 3.089e13; /* H number density at 120 km [1/m³] */
static const double N_120  = 5.498e10; /* N number density at 120 km [1/m³] */

/* Scale heights [km] - approximate values */
static const double SCALE_N2 = 7.8;
static const double SCALE_O2 = 7.2;
static const double SCALE_O  = 9.5;
static const double SCALE_HE = 50.0;
static const double SCALE_AR = 6.8;
static const double SCALE_H  = 200.0;
static const double SCALE_N  = 10.0;

/* ============================================================================
 * Model Coefficients (Simplified)
 * ============================================================================ */

/* Exospheric temperature coefficients */
/* T_inf = TC1 + TC2 * F107A + TC3 * (F107 - F107A) + TC4 * Ap */
static const double TC1 = 740.0;   /* Base exospheric temperature [K] */
static const double TC2 = 3.0;     /* F107A coefficient */
static const double TC3 = 1.5;     /* F107 deviation coefficient */
static const double TC4 = 1.2;     /* Ap coefficient */

/* Temperature profile shape parameter */
static const double SIGMA = 0.02;  /* Controls temperature gradient */

/* ============================================================================
 * Helper Functions
 * ============================================================================ */

/**
 * @brief Calculate exospheric temperature based on solar/geomagnetic activity
 */
static double calculate_exospheric_temp(const SolarActivity* solar)
{
    double F107A = solar ? solar->F107A : 150.0;
    double F107 = solar ? solar->F107 : 150.0;
    double Ap = solar ? solar->Ap[0] : 4.0;

    /* Clamp inputs to reasonable ranges */
    if (F107A < 65.0) F107A = 65.0;
    if (F107A > 400.0) F107A = 400.0;
    if (F107 < 65.0) F107 = 65.0;
    if (F107 > 400.0) F107 = 400.0;
    if (Ap < 0.0) Ap = 0.0;
    if (Ap > 400.0) Ap = 400.0;

    double T_inf = TC1 + TC2 * F107A + TC3 * (F107 - F107A) + TC4 * Ap;

    /* Ensure physically reasonable bounds */
    if (T_inf < 600.0) T_inf = 600.0;
    if (T_inf > 2500.0) T_inf = 2500.0;

    return T_inf;
}

/**
 * @brief Calculate temperature at altitude using Bates profile
 *
 * T(z) = T_inf - (T_inf - T_120) * exp(-sigma * (z - z_120))
 */
static double calculate_temperature(double alt_km, double T_inf)
{
    if (alt_km <= 120.0) {
        /* Use US76-like profile below 120 km */
        if (alt_km <= 11.0) {
            return 288.15 - 6.5 * alt_km;
        } else if (alt_km <= 20.0) {
            return 216.65;
        } else if (alt_km <= 32.0) {
            return 216.65 + 1.0 * (alt_km - 20.0);
        } else if (alt_km <= 47.0) {
            return 228.65 + 2.8 * (alt_km - 32.0);
        } else if (alt_km <= 51.0) {
            return 270.65;
        } else if (alt_km <= 71.0) {
            return 270.65 - 2.8 * (alt_km - 51.0);
        } else if (alt_km <= 86.0) {
            return 214.65 - 2.0 * (alt_km - 71.0);
        } else {
            /* Transition to thermosphere 86-120 km */
            double x = (alt_km - 86.0) / (120.0 - 86.0);
            double T86 = 186.87;
            return T86 + (T120_REF - T86) * x * x * (3.0 - 2.0 * x);
        }
    }

    /* Thermosphere (above 120 km) - Bates temperature profile */
    double dz = alt_km - ZB;
    return T_inf - (T_inf - T120_REF) * std::exp(-SIGMA * dz);
}

/**
 * @brief Calculate species number density at altitude
 *
 * Uses barometric formula with diffusive equilibrium above 120 km:
 * n(z) = n_120 * (T_120/T)^(1+alpha) * exp(-integral)
 *
 * Simplified to exponential decay with effective scale height:
 * n(z) = n_120 * exp(-(z - 120) / H_eff)
 */
static double calculate_species_density(double alt_km, double n_120, double scale_km,
                                         double T, double T_inf, double mass_ratio)
{
    if (alt_km <= 86.0) {
        /* Below 86 km, use mixed atmosphere (constant composition) */
        /* Simple exponential with sea-level scale height */
        double H0 = 8.5; /* Average scale height [km] */
        return n_120 * std::exp((120.0 - alt_km) / H0);
    }

    if (alt_km <= 120.0) {
        /* 86-120 km transition region */
        double x = (alt_km - 86.0) / (120.0 - 86.0);
        double n_86 = n_120 * std::exp((120.0 - 86.0) / scale_km);
        return n_86 + (n_120 - n_86) * x;
    }

    /* Above 120 km - diffusive equilibrium */
    double dz = alt_km - ZB;

    /* Effective scale height increases with temperature */
    double T_avg = 0.5 * (T120_REF + T);
    double H_eff = scale_km * (T_avg / T120_REF);

    /* Additional temperature-dependent factor for light species */
    double T_factor = std::pow(T120_REF / T, 1.0 + 0.25 * mass_ratio);

    return n_120 * T_factor * std::exp(-dz / H_eff);
}

/**
 * @brief Calculate total mass density from species densities
 */
static double calculate_mass_density(double n_N2, double n_O2, double n_O,
                                      double n_He, double n_Ar, double n_H, double n_N)
{
    return n_N2 * MASS_N2 + n_O2 * MASS_O2 + n_O * MASS_O +
           n_He * MASS_HE + n_Ar * MASS_AR + n_H * MASS_H + n_N * MASS_N;
}

/**
 * @brief Calculate mean molecular mass
 */
static double calculate_mean_mass(double n_N2, double n_O2, double n_O,
                                   double n_He, double n_Ar, double n_H, double n_N,
                                   double rho)
{
    double n_total = n_N2 + n_O2 + n_O + n_He + n_Ar + n_H + n_N;
    if (n_total < 1e-30) return ATMOSPHERE_M0 / 1000.0;  /* g/mol */
    return (rho / n_total) * AVOGADRO / 1000.0;  /* g/mol */
}

/**
 * @brief Apply solar activity variations to species densities
 */
static void apply_solar_variation(const SolarActivity* solar, double alt_km,
                                   double* n_O, double* n_N2, double* n_O2)
{
    if (solar == nullptr) return;
    if (alt_km < 150.0) return;  /* Minimal effect below 150 km */

    double F107A = solar->F107A;
    double Ap = solar->Ap[0];

    /* Oxygen enhancement during high solar activity */
    double O_factor = 1.0 + 0.001 * (F107A - 150.0) * (alt_km - 150.0) / 850.0;
    if (O_factor < 0.5) O_factor = 0.5;
    if (O_factor > 3.0) O_factor = 3.0;
    *n_O *= O_factor;

    /* N2 reduction during geomagnetic storms */
    double N2_factor = 1.0 - 0.0003 * Ap * (alt_km - 150.0) / 850.0;
    if (N2_factor < 0.3) N2_factor = 0.3;
    if (N2_factor > 1.2) N2_factor = 1.2;
    *n_N2 *= N2_factor;
    *n_O2 *= N2_factor;
}

/**
 * @brief Apply diurnal variation (simplified)
 */
static void apply_diurnal_variation(double localSolarTime, double alt_km,
                                     double* n_O, double* T)
{
    if (alt_km < 200.0) return;

    /* Maximum density around 14:00 local time */
    double phase = (localSolarTime - 14.0) * (3.14159265 / 12.0);
    double amplitude = 0.2 * (alt_km - 200.0) / 800.0;
    if (amplitude > 0.4) amplitude = 0.4;

    double factor = 1.0 + amplitude * std::cos(phase);
    *n_O *= factor;

    /* Temperature also varies diurnally */
    *T *= (1.0 + 0.1 * amplitude * std::cos(phase));
}

/**
 * @brief Calculate local solar time from longitude and epoch
 */
static double calculate_local_solar_time(double longitude_rad, const AtmosphereEpoch* epoch)
{
    if (epoch == nullptr) return 12.0;  /* Default to noon */

    double ut_hours = epoch->secondOfDay / 3600.0;
    double longitude_hours = longitude_rad * (12.0 / 3.14159265);

    double lst = ut_hours + longitude_hours;
    while (lst < 0.0) lst += 24.0;
    while (lst >= 24.0) lst -= 24.0;

    return lst;
}

/* ============================================================================
 * Public API
 * ============================================================================ */

AtmosphereResult nrlmsise00_calculate(const GeoPosition* position,
                                       const AtmosphereEpoch* epoch,
                                       const SolarActivity* solar,
                                       AtmosphereState* state)
{
    /* Validate inputs */
    if (state == nullptr) {
        return ATMOSPHERE_ERROR_INVALID_PARAMETER;
    }

    double alt_m = position ? position->altitude : 0.0;
    double alt_km = alt_m / 1000.0;

    if (alt_km < 0.0 || alt_km > 1000.0) {
        return ATMOSPHERE_ERROR_INVALID_ALTITUDE;
    }

    /* Initialize state */
    std::memset(state, 0, sizeof(AtmosphereState));

    /* Calculate exospheric temperature */
    double T_inf = calculate_exospheric_temp(solar);

    /* Calculate temperature at altitude */
    double T = calculate_temperature(alt_km, T_inf);

    /* Calculate species number densities */
    double n_N2 = calculate_species_density(alt_km, N2_120, SCALE_N2, T, T_inf, 28.0/16.0);
    double n_O2 = calculate_species_density(alt_km, O2_120, SCALE_O2, T, T_inf, 32.0/16.0);
    double n_O  = calculate_species_density(alt_km, O_120,  SCALE_O,  T, T_inf, 1.0);
    double n_He = calculate_species_density(alt_km, HE_120, SCALE_HE, T, T_inf, 4.0/16.0);
    double n_Ar = calculate_species_density(alt_km, AR_120, SCALE_AR, T, T_inf, 40.0/16.0);
    double n_H  = calculate_species_density(alt_km, H_120,  SCALE_H,  T, T_inf, 1.0/16.0);
    double n_N  = calculate_species_density(alt_km, N_120,  SCALE_N,  T, T_inf, 14.0/16.0);

    /* Apply solar activity variations */
    apply_solar_variation(solar, alt_km, &n_O, &n_N2, &n_O2);

    /* Apply diurnal variation if position/time provided */
    if (position && epoch) {
        double lst = calculate_local_solar_time(position->longitude, epoch);
        apply_diurnal_variation(lst, alt_km, &n_O, &T);
    }

    /* Calculate total mass density */
    double rho = calculate_mass_density(n_N2, n_O2, n_O, n_He, n_Ar, n_H, n_N);

    /* Calculate pressure from ideal gas law: P = n_total * k * T */
    double n_total = n_N2 + n_O2 + n_O + n_He + n_Ar + n_H + n_N;
    double P = n_total * BOLTZMANN * T;

    /* Calculate speed of sound (valid mainly in lower atmosphere) */
    double gamma = 1.4;
    double M = calculate_mean_mass(n_N2, n_O2, n_O, n_He, n_Ar, n_H, n_N, rho);
    double R_specific = 8314.32 / M;  /* J/(kg·K) */
    double a = std::sqrt(gamma * R_specific * T);

    /* Fill output structure */
    state->density = rho;
    state->temperature = T;
    state->pressure = P;
    state->speedOfSound = a;
    state->molecularMass = M;
    state->numDensityN2 = n_N2;
    state->numDensityO2 = n_O2;
    state->numDensityO = n_O;
    state->numDensityHe = n_He;
    state->numDensityAr = n_Ar;
    state->numDensityH = n_H;
    state->numDensityN = n_N;
    state->exosphericTemp = T_inf;

    return ATMOSPHERE_OK;
}

AtmosphereResult nrlmsise00_calculate_simple(double altitude,
                                              const SolarActivity* solar,
                                              AtmosphereState* state)
{
    GeoPosition pos = {0.0, 0.0, altitude};

    /* Default epoch: Jan 1, noon UTC */
    AtmosphereEpoch epoch = {2024, 1, 43200.0};

    return nrlmsise00_calculate(&pos, &epoch, solar, state);
}
