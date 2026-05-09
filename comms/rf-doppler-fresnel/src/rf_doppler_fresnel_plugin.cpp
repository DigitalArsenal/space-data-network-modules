// SPDX-License-Identifier: Apache-2.0
//
// rf-doppler-fresnel — Classical Doppler shift and Fresnel-zone radius.
//
// Two scalar primitives that decompose into their own WASM module per the
// RF_AUDIT_SOURCES.md plan (Section 7 "Doppler and link kinematics" +
// Section 5 "Diffraction" Fresnel-zone row). Both functions appear in the
// link-budget orchestrator and several of the empirical-model paths, so
// they ship as a single tightly-scoped module rather than two trivial
// modules with separate ABI surfaces.
//
// Authority for Doppler:
//   Sklar, *Digital Communications*, 2nd ed. §1.3.2 (classical first-order
//   form). Relativistic correction at LEO velocities (~7.5 km/s) is
//   O((v/c)²) ≈ 6e-10 — negligible for link-budget purposes.
//
//   Δf = (v_r / c) * f_0
//
// Authority for Fresnel zone:
//   ITU-R P.526-15 §3 + Pratt 4e §4.3.5.
//
//   r_n = sqrt(n * λ * d1 * d2 / (d1 + d2))   where λ = c / f.

#include "orbpro_plugin.h"

#include <cmath>
#include <cstdint>
#include <cstddef>

namespace {

constexpr double kSpeedOfLight = 299792458.0;  // CODATA 2018 / SI exact

bool g_initialized = false;

}  // namespace

extern "C" {

ORBPRO_EXPORT
int32_t plugin_init(const uint8_t* data, size_t len) {
  (void)data;
  (void)len;
  g_initialized = true;
  return 0;
}

ORBPRO_EXPORT
void plugin_destroy(void) {
  g_initialized = false;
}

// Sklar §1.3.2 first-order Doppler shift.
// relative_velocity_mps: positive when transmitter and receiver are
//   approaching each other along the line of sight (closing rate).
// frequency_hz: carrier frequency.
// Returns the shift Δf in Hz; negative if receding.
// Returns 0.0 for non-finite or non-positive frequency.
ORBPRO_EXPORT
double rf_doppler_shift_hz(double relative_velocity_mps, double frequency_hz) {
  if (!std::isfinite(relative_velocity_mps) ||
      !std::isfinite(frequency_hz)) {
    return 0.0;
  }
  if (frequency_hz <= 0.0) {
    return 0.0;
  }
  return (relative_velocity_mps / kSpeedOfLight) * frequency_hz;
}

// ITU-R P.526-15 §3 Fresnel zone radius.
// d1_m, d2_m: distances from the two link endpoints to the obstruction
//   plane along the boresight, in meters. The total path length is
//   d1 + d2.
// frequency_hz: carrier frequency.
// zone: Fresnel zone number n (>= 1). The first Fresnel zone (n = 1)
//   is the canonical clearance reference.
// Returns the zone radius in meters at the obstruction plane.
// Returns 0.0 for invalid inputs (non-finite, non-positive distance or
// frequency, zone <= 0).
ORBPRO_EXPORT
double rf_fresnel_zone_radius_m(
    double d1_m,
    double d2_m,
    double frequency_hz,
    int32_t zone) {
  if (!std::isfinite(d1_m) || !std::isfinite(d2_m) ||
      !std::isfinite(frequency_hz)) {
    return 0.0;
  }
  if (d1_m <= 0.0 || d2_m <= 0.0 || frequency_hz <= 0.0 || zone <= 0) {
    return 0.0;
  }
  const double wavelength = kSpeedOfLight / frequency_hz;
  const double n = static_cast<double>(zone);
  const double total = d1_m + d2_m;
  return std::sqrt(n * wavelength * d1_m * d2_m / total);
}

}  // extern "C"
