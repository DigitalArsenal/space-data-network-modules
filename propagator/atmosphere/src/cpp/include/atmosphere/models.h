#ifndef ATMOSPHERE_SDN_MODELS_H
#define ATMOSPHERE_SDN_MODELS_H

#include "types.h"

namespace atmosphere {

// ---------------------------------------------------------------------------
// US Standard Atmosphere 1976
// Ported from OrbPro2-ModSim/plugins/atmosphere/src/us76.cpp
// Altitude range: 0 to 86 km geometric
// 7 layers with temperature gradients and barometric formulas
// ---------------------------------------------------------------------------

/// Calculate full atmospheric state at geometric altitude
State us76(double altitude_m);

/// Quick single-value queries
double us76_density(double altitude_m);
double us76_temperature(double altitude_m);
double us76_pressure(double altitude_m);
double us76_speedOfSound(double altitude_m);

/// Basilisk orbitalMotion atmosphericDensity curve fit based on Standard
/// Atmosphere 1976 data. Input and output use SDK SI units.
double standardAtmosphere1976OrbitalDensity(double altitude_m);

/// Basilisk orbitalMotion debyeLength interpolation. Input altitude and output
/// Debye length use SDK SI units; returns NaN outside Basilisk's valid range.
double basiliskDebyeLength(double altitude_m);

/// Basilisk orbitalMotion atmosphericDrag acceleration. Inputs and output use
/// SDK SI units; acceleration is inertial and aligned opposite velocity.
void basiliskAtmosphericDragAcceleration(double drag_coefficient,
                                         double area_m2,
                                         double mass_kg,
                                         const double position_m[3],
                                         const double velocity_m_per_s[3],
                                         double acceleration_m_per_s2[3]);

// ---------------------------------------------------------------------------
// NRLMSISE-00 Empirical Atmosphere
// Thin wrapper over the real, public-domain NRLMSISE-00 C port vendored in
// third_party/nrlmsise00/ (Picone/Hedin/Drob via D. Brodowski).
// Altitude range: 0 to 1000 km. Total mass density from gtd7d (includes
// anomalous oxygen — drag-effective density).
// ---------------------------------------------------------------------------

/// Full NRLMSISE-00 with position, time, and solar activity
State nrlmsise00(const GeoPos& pos, const Epoch& epoch, const SolarActivity& solar);

/// Full NRLMSISE-00 with explicit local apparent solar time override (hours,
/// [0, 24)). Pass a negative value to derive lst from secondOfDay and
/// longitude (recommended relation lst = sec/3600 + lon_deg/15). The
/// override exists because the canonical published test vectors use an lst
/// that is deliberately inconsistent with UT/longitude. (Negative sentinel
/// instead of NaN: builds use -ffast-math.)
State nrlmsise00(const GeoPos& pos, const Epoch& epoch, const SolarActivity& solar,
                 double lstHours);

/// Simplified: altitude-only with default solar activity
State nrlmsise00_simple(double altitude_m, const SolarActivity& solar);

/// Altitude-only with all defaults
State nrlmsise00_simple(double altitude_m);

// ---------------------------------------------------------------------------
// Unified Interface
// ---------------------------------------------------------------------------

/// Get atmosphere state using specified model
/// For US76: only altitude matters
/// For NRLMSISE-00: uses all parameters
State getAtmosphere(double altitude_m, Model model = Model::US76);

State getAtmosphere(const GeoPos& pos, const Epoch& epoch,
                    const SolarActivity& solar, Model model);

// ---------------------------------------------------------------------------
// Horizontal winds: HWM14 (third_party/hwm14, bit-exact port of the NRL
// release HWM14.123114). Winds are horizontal; down is always 0.
// ---------------------------------------------------------------------------

/// HWM14 wind at a geodetic position (height >= 0) and UTC epoch. ap3h is the
/// 3-hour ap of the epoch; a negative ap3h gives the quiet-time wind only,
/// HWM14's own convention.
WindVec getWind(const GeoPos& pos, const Epoch& epoch, double ap3h);

/// The model release string, "HWM14.123114".
const char* windModelRelease();

}  // namespace atmosphere

#endif  // ATMOSPHERE_SDN_MODELS_H
