/**
 * NRLMSISE-00 Empirical Atmosphere Model
 * Ported from OrbPro2-ModSim/plugins/atmosphere/src/nrlmsise00.cpp
 *
 * Reference: Picone, J.M., et al., "NRLMSISE-00 empirical model of the atmosphere",
 *            Journal of Geophysical Research, 107(A12), 1468, 2002.
 *
 * Simplified implementation capturing essential physics for WASM deployment.
 */

#include "atmosphere/models.h"
#include <cmath>
#include <cstring>
#include <algorithm>

namespace atmosphere {

// ---------------------------------------------------------------------------
// Molecular masses [kg]
// ---------------------------------------------------------------------------

static constexpr double MASS_N2 = 28.0134e-3 / AVOGADRO;
static constexpr double MASS_O2 = 31.9988e-3 / AVOGADRO;
static constexpr double MASS_O  = 15.9994e-3 / AVOGADRO;
static constexpr double MASS_HE = 4.0026e-3 / AVOGADRO;
static constexpr double MASS_AR = 39.948e-3 / AVOGADRO;
static constexpr double MASS_H  = 1.00797e-3 / AVOGADRO;
static constexpr double MASS_N  = 14.0067e-3 / AVOGADRO;

// Reference altitude and values at 120 km
static constexpr double ZB = 120.0;       // km
static constexpr double T120_REF = 355.0; // K

static constexpr double N2_120 = 1.129e17;
static constexpr double O2_120 = 3.030e16;
static constexpr double O_120  = 4.427e17;
static constexpr double HE_120 = 1.355e13;
static constexpr double AR_120 = 1.272e15;
static constexpr double H_120  = 3.089e13;
static constexpr double N_120  = 5.498e10;

// Scale heights [km]
static constexpr double SCALE_N2 = 7.8;
static constexpr double SCALE_O2 = 7.2;
static constexpr double SCALE_O  = 9.5;
static constexpr double SCALE_HE = 50.0;
static constexpr double SCALE_AR = 6.8;
static constexpr double SCALE_H  = 200.0;
static constexpr double SCALE_N  = 10.0;

// Exospheric temperature coefficients
// T_inf = TC1 + TC2*F107A + TC3*(F107-F107A) + TC4*Ap
static constexpr double TC1 = 740.0;
static constexpr double TC2 = 3.0;
static constexpr double TC3 = 1.5;
static constexpr double TC4 = 1.2;
static constexpr double SIGMA = 0.02; // temperature gradient shape

// ---------------------------------------------------------------------------
// Exospheric temperature
// ---------------------------------------------------------------------------

static double exosphericTemp(const SolarActivity& solar) {
    double F107A = std::clamp(solar.F107A, 65.0, 400.0);
    double F107  = std::clamp(solar.F107, 65.0, 400.0);
    double Ap    = std::clamp(solar.Ap[0], 0.0, 400.0);

    double T_inf = TC1 + TC2 * F107A + TC3 * (F107 - F107A) + TC4 * Ap;
    return std::clamp(T_inf, 600.0, 2500.0);
}

// ---------------------------------------------------------------------------
// Temperature profile
// ---------------------------------------------------------------------------

static double temperatureProfile(double alt_km, double T_inf) {
    if (alt_km <= 11.0)
        return 288.15 - 6.5 * alt_km;
    if (alt_km <= 20.0)
        return 216.65;
    if (alt_km <= 32.0)
        return 216.65 + 1.0 * (alt_km - 20.0);
    if (alt_km <= 47.0)
        return 228.65 + 2.8 * (alt_km - 32.0);
    if (alt_km <= 51.0)
        return 270.65;
    if (alt_km <= 71.0)
        return 270.65 - 2.8 * (alt_km - 51.0);
    if (alt_km <= 86.0)
        return 214.65 - 2.0 * (alt_km - 71.0);
    if (alt_km <= 120.0) {
        // Smooth transition 86-120 km
        double x = (alt_km - 86.0) / 34.0;
        double T86 = 186.87;
        return T86 + (T120_REF - T86) * x * x * (3.0 - 2.0 * x);
    }
    // Thermosphere: Bates profile
    return T_inf - (T_inf - T120_REF) * std::exp(-SIGMA * (alt_km - ZB));
}

// ---------------------------------------------------------------------------
// Species number density
// ---------------------------------------------------------------------------

static double speciesDensity(double alt_km, double n120, double scale_km,
                             double T, double T_inf, double massRatio) {
    if (alt_km <= 86.0) {
        double H0 = 8.5;
        return n120 * std::exp((120.0 - alt_km) / H0);
    }
    if (alt_km <= 120.0) {
        double x = (alt_km - 86.0) / 34.0;
        double n86 = n120 * std::exp(34.0 / scale_km);
        return n86 + (n120 - n86) * x;
    }
    // Diffusive equilibrium above 120 km
    double dz = alt_km - ZB;
    double T_avg = 0.5 * (T120_REF + T);
    double H_eff = scale_km * (T_avg / T120_REF);
    double T_factor = std::pow(T120_REF / T, 1.0 + 0.25 * massRatio);
    return n120 * T_factor * std::exp(-dz / H_eff);
}

// ---------------------------------------------------------------------------
// Solar activity & diurnal corrections
// ---------------------------------------------------------------------------

static void applySolarVariation(const SolarActivity& solar, double alt_km,
                                double& n_O, double& n_N2, double& n_O2) {
    if (alt_km < 150.0) return;

    double O_factor = 1.0 + 0.001 * (solar.F107A - 150.0) * (alt_km - 150.0) / 850.0;
    n_O *= std::clamp(O_factor, 0.5, 3.0);

    double N2_factor = 1.0 - 0.0003 * solar.Ap[0] * (alt_km - 150.0) / 850.0;
    N2_factor = std::clamp(N2_factor, 0.3, 1.2);
    n_N2 *= N2_factor;
    n_O2 *= N2_factor;
}

static double localSolarTime(double lon_rad, const Epoch& epoch) {
    double ut_h = epoch.secondOfDay / 3600.0;
    double lon_h = lon_rad * (12.0 / M_PI);
    double lst = ut_h + lon_h;
    while (lst < 0) lst += 24;
    while (lst >= 24) lst -= 24;
    return lst;
}

static void applyDiurnal(double lst, double alt_km, double& n_O, double& T) {
    if (alt_km < 200.0) return;
    double phase = (lst - 14.0) * (M_PI / 12.0);
    double amp = std::min(0.4, 0.2 * (alt_km - 200.0) / 800.0);
    double factor = 1.0 + amp * std::cos(phase);
    n_O *= factor;
    T *= (1.0 + 0.1 * amp * std::cos(phase));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

State nrlmsise00(const GeoPos& pos, const Epoch& epoch, const SolarActivity& solar) {
    State s;

    double alt_km = std::clamp(pos.alt_m / 1000.0, 0.0, 1000.0);

    // Below 86 km: use US76 for bulk properties (mixed atmosphere).
    // NRLMSISE-00 species breakdown only meaningful above ~86 km.
    if (alt_km <= 86.0) {
        s = us76(pos.alt_m);
        s.exosphericTemp = exosphericTemp(solar);
        return s;
    }

    double T_inf = exosphericTemp(solar);
    double T = temperatureProfile(alt_km, T_inf);

    double n_N2 = speciesDensity(alt_km, N2_120, SCALE_N2, T, T_inf, 28.0/16.0);
    double n_O2 = speciesDensity(alt_km, O2_120, SCALE_O2, T, T_inf, 32.0/16.0);
    double n_O  = speciesDensity(alt_km, O_120,  SCALE_O,  T, T_inf, 1.0);
    double n_He = speciesDensity(alt_km, HE_120, SCALE_HE, T, T_inf, 4.0/16.0);
    double n_Ar = speciesDensity(alt_km, AR_120, SCALE_AR, T, T_inf, 40.0/16.0);
    double n_H  = speciesDensity(alt_km, H_120,  SCALE_H,  T, T_inf, 1.0/16.0);
    double n_N  = speciesDensity(alt_km, N_120,  SCALE_N,  T, T_inf, 14.0/16.0);

    applySolarVariation(solar, alt_km, n_O, n_N2, n_O2);

    double lst = localSolarTime(pos.lon_rad, epoch);
    applyDiurnal(lst, alt_km, n_O, T);

    // Mass density
    double rho = n_N2 * MASS_N2 + n_O2 * MASS_O2 + n_O * MASS_O +
                 n_He * MASS_HE + n_Ar * MASS_AR + n_H * MASS_H + n_N * MASS_N;

    // Pressure from ideal gas law
    double n_total = n_N2 + n_O2 + n_O + n_He + n_Ar + n_H + n_N;
    double P = n_total * BOLTZMANN * T;

    // Mean molecular mass and speed of sound
    double M = (n_total > 1e-30) ? (rho / n_total) * AVOGADRO / 1000.0 : M0_KGKMOL;
    double R_spec = R_UNIVERSAL / M;
    double a = std::sqrt(GAMMA * R_spec * T);

    s.density = rho;
    s.temperature = T;
    s.pressure = P;
    s.soundSpeed = a;
    s.molecularMass = M;
    s.numDensityN2 = n_N2;
    s.numDensityO2 = n_O2;
    s.numDensityO  = n_O;
    s.numDensityHe = n_He;
    s.numDensityAr = n_Ar;
    s.numDensityH  = n_H;
    s.numDensityN  = n_N;
    s.exosphericTemp = T_inf;

    return s;
}

State nrlmsise00_simple(double altitude_m, const SolarActivity& solar) {
    GeoPos pos{0, 0, altitude_m};
    Epoch epoch{2024, 1, 43200.0};
    return nrlmsise00(pos, epoch, solar);
}

State nrlmsise00_simple(double altitude_m) {
    SolarActivity solar;
    return nrlmsise00_simple(altitude_m, solar);
}

// ---------------------------------------------------------------------------
// Unified Interface
// ---------------------------------------------------------------------------

State getAtmosphere(double altitude_m, Model model) {
    if (model == Model::NRLMSISE00)
        return nrlmsise00_simple(altitude_m);
    return us76(altitude_m);
}

State getAtmosphere(const GeoPos& pos, const Epoch& epoch,
                    const SolarActivity& solar, Model model) {
    if (model == Model::NRLMSISE00)
        return nrlmsise00(pos, epoch, solar);
    return us76(pos.alt_m);
}

WindVec getWind(const GeoPos&, const Epoch&) {
    return WindVec{};  // Stub — integrate with wind plugin
}

}  // namespace atmosphere
