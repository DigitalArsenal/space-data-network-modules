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

// ---------------------------------------------------------------------------
// NRLMSISE-00 Empirical Atmosphere
// Ported from OrbPro2-ModSim/plugins/atmosphere/src/nrlmsise00.cpp
// Altitude range: 0 to 1000 km
// Includes solar/geomagnetic activity effects, species composition,
// diurnal variation, and exospheric temperature
// ---------------------------------------------------------------------------

/// Full NRLMSISE-00 with position, time, and solar activity
State nrlmsise00(const GeoPos& pos, const Epoch& epoch, const SolarActivity& solar);

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
// Wind Models (stubs for external plugin integration)
// ---------------------------------------------------------------------------

/// Get wind at position and time
/// Currently returns zero wind — designed for integration with
/// atmospheric-wind-sdn-plugin via callback
WindVec getWind(const GeoPos& pos, const Epoch& epoch);

}  // namespace atmosphere

#endif  // ATMOSPHERE_SDN_MODELS_H
