/**
 * @file nrlmsise00.cpp
 * @brief NRLMSISE-00 atmosphere model — thin wrapper over the real model.
 *
 * This wraps the public-domain Brodowski C port of NRLMSISE-00 vendored in
 * third_party/nrlmsise00/ (see that directory's README for provenance).
 * It is NOT a re-implementation: all physics comes from gtd7/gtd7d.
 *
 * References:
 * - Picone, J.M., Hedin, A.E., Drob, D.P., Aikin, A.C., "NRLMSISE-00
 *   empirical model of the atmosphere: Statistical comparisons and
 *   scientific issues", J. Geophys. Res., 107(A12), 1468, 2002.
 *
 * Total mass density is taken from gtd7d (includes anomalous oxygen — the
 * "effective mass density for drag" recommended for satellite drag).
 */

#include "atmosphere.h"
#include <cmath>
#include <cstring>

extern "C" {
#include "nrlmsise-00.h"
}

/* ============================================================================
 * Helpers
 * ============================================================================ */

static double localSolarTimeHours(double longitude_rad, const AtmosphereEpoch* epoch)
{
    /* Recommended consistency relation lst = sec/3600 + g_long/15
     * (NRLMSISE-00 package notes on input variables). */
    double sec = epoch ? epoch->secondOfDay : 43200.0;
    double lonDeg = longitude_rad * (180.0 / 3.14159265358979323846);
    double lst = sec / 3600.0 + lonDeg / 15.0;
    lst = std::fmod(lst, 24.0);
    if (lst < 0.0) lst += 24.0;
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
    if (state == nullptr) {
        return ATMOSPHERE_ERROR_INVALID_PARAMETER;
    }

    const double alt_m = position ? position->altitude : 0.0;
    const double alt_km = alt_m / 1000.0;

    if (alt_km < 0.0 || alt_km > NRLMSISE_MAX_ALTITUDE / 1000.0) {
        return ATMOSPHERE_ERROR_INVALID_ALTITUDE;
    }

    std::memset(state, 0, sizeof(AtmosphereState));

    const double lat_rad = position ? position->latitude : 0.0;
    const double lon_rad = position ? position->longitude : 0.0;
    const double DEG = 180.0 / 3.14159265358979323846;

    nrlmsise_input input;
    nrlmsise_flags flags;
    nrlmsise_output output;
    std::memset(&input, 0, sizeof(input));
    std::memset(&flags, 0, sizeof(flags));
    std::memset(&output, 0, sizeof(output));

    flags.switches[0] = 0;
    for (int i = 1; i < 24; ++i) {
        flags.switches[i] = 1;
    }

    input.year = epoch ? epoch->year : 0;  /* ignored by the model */
    input.doy = epoch ? epoch->dayOfYear : 1;
    input.sec = epoch ? epoch->secondOfDay : 43200.0;
    input.alt = alt_km;
    input.g_lat = lat_rad * DEG;
    input.g_long = lon_rad * DEG;
    input.lst = localSolarTimeHours(lon_rad, epoch);
    input.f107A = solar ? solar->F107A : 150.0;
    input.f107 = solar ? solar->F107 : 150.0;
    input.ap = solar ? solar->Ap[0] : 4.0;
    input.ap_a = nullptr;

    gtd7d(&input, &flags, &output);

    /* Unit conversions: number densities 1/cm^3 -> 1/m^3, mass density
     * g/cm^3 -> kg/m^3. */
    const double n_He = output.d[0] * 1e6;
    const double n_O  = output.d[1] * 1e6;
    const double n_N2 = output.d[2] * 1e6;
    const double n_O2 = output.d[3] * 1e6;
    const double n_Ar = output.d[4] * 1e6;
    const double n_H  = output.d[6] * 1e6;
    const double n_N  = output.d[7] * 1e6;

    const double rho = output.d[5] * 1000.0;  /* kg/m^3 (incl. anomalous O) */
    const double T = output.t[1];

    const double n_total = n_He + n_O + n_N2 + n_O2 + n_Ar + n_H + n_N;

    /* Mean molecular mass in g/mol from rho/n. */
    double M = ATMOSPHERE_M0;  /* fallback; g/mol == kg/kmol numerically */
    if (n_total > 1e-30) {
        M = rho / n_total * 6.02214076e23 * 1000.0;
    }

    /* Pressure from ideal gas law (neutral gas). */
    const double BOLTZMANN = 1.380649e-23;  /* J/K */
    const double P = n_total * BOLTZMANN * T;

    /* Speed of sound — only physically meaningful in the mixed, collisional
     * lower atmosphere. */
    double a = 0.0;
    if (M > 1e-12 && T > 0.0) {
        const double R_specific = 8314.32 / M;  /* J/(kg K) */
        a = std::sqrt(ATMOSPHERE_GAMMA * R_specific * T);
    }

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
    state->exosphericTemp = output.t[0];

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
