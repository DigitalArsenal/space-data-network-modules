/**
 * NRLMSISE-00 Empirical Atmosphere Model — thin wrapper over the real model.
 *
 * Wraps the public-domain Brodowski C port of NRLMSISE-00 vendored in
 * third_party/nrlmsise00/ (see that directory's README for provenance).
 * This is NOT a re-implementation: all physics comes from gtd7/gtd7d.
 *
 * Reference: Picone, J.M., Hedin, A.E., Drob, D.P., Aikin, A.C.,
 *            "NRLMSISE-00 empirical model of the atmosphere: Statistical
 *            comparisons and scientific issues", Journal of Geophysical
 *            Research, 107(A12), 1468, 2002.
 *
 * Total mass density is taken from gtd7d (includes anomalous oxygen — the
 * "effective mass density for drag" recommended for satellite drag work).
 */

#include "atmosphere/models.h"
#include <cmath>
#include <cstring>

extern "C" {
#include "nrlmsise-00.h"
}

namespace atmosphere {

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

State nrlmsise00(const GeoPos& pos, const Epoch& epoch, const SolarActivity& solar,
                 double lstHours) {
    State s;

    const double alt_km = std::clamp(pos.alt_m / 1000.0, 0.0, NRLMSISE_MAX_ALT / 1000.0);
    const double DEG = 180.0 / M_PI;

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

    input.year = epoch.year;  // ignored by the model
    input.doy = epoch.dayOfYear;
    input.sec = epoch.secondOfDay;
    input.alt = alt_km;
    input.g_lat = pos.lat_rad * DEG;
    input.g_long = pos.lon_rad * DEG;
    // NOTE: a negative lstHours means "derive from UT and longitude".
    // (A NaN sentinel is unusable here: the module builds with -ffast-math,
    // under which isfinite/isnan checks are not reliable.)
    if (lstHours >= 0.0 && lstHours < 24.0) {
        input.lst = lstHours;
    } else {
        // Recommended consistency relation lst = sec/3600 + g_long/15
        // (NRLMSISE-00 package notes on input variables).
        double lst = input.sec / 3600.0 + input.g_long / 15.0;
        lst = std::fmod(lst, 24.0);
        if (lst < 0.0) lst += 24.0;
        input.lst = lst;
    }
    input.f107A = solar.F107A;
    input.f107 = solar.F107;
    input.ap = solar.Ap[0];
    input.ap_a = nullptr;

    // Epoch-relative 3-hour ap history: switch 9 = -1 and ap_a set
    // (nrlmsise-00.h, switches and struct ap_array).
    ap_array history;
    if (solar.geomagnetic == GeomagneticInput::ApHistory) {
        for (int i = 0; i < 7; ++i) {
            history.a[i] = solar.Ap[i];
        }
        flags.switches[9] = -1;
        input.ap_a = &history;
    }

    gtd7d(&input, &flags, &output);

    // Unit conversions: number densities 1/cm^3 -> 1/m^3,
    // mass density g/cm^3 -> kg/m^3.
    const double n_He = output.d[0] * 1e6;
    const double n_O  = output.d[1] * 1e6;
    const double n_N2 = output.d[2] * 1e6;
    const double n_O2 = output.d[3] * 1e6;
    const double n_Ar = output.d[4] * 1e6;
    const double n_H  = output.d[6] * 1e6;
    const double n_N  = output.d[7] * 1e6;

    const double rho = output.d[5] * 1000.0;  // kg/m^3 (incl. anomalous O)
    const double T = output.t[1];

    const double n_total = n_He + n_O + n_N2 + n_O2 + n_Ar + n_H + n_N;

    double M = M0_KGKMOL;  // fallback; g/mol == kg/kmol numerically
    if (n_total > 1e-30) {
        M = rho / n_total * AVOGADRO * 1000.0;
    }

    const double P = n_total * BOLTZMANN * T;

    double a = 0.0;
    if (M > 1e-12 && T > 0.0) {
        const double R_spec = R_UNIVERSAL / M;
        a = std::sqrt(GAMMA * R_spec * T);
    }

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
    s.exosphericTemp = output.t[0];

    return s;
}

State nrlmsise00(const GeoPos& pos, const Epoch& epoch, const SolarActivity& solar) {
    return nrlmsise00(pos, epoch, solar, -1.0);
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
