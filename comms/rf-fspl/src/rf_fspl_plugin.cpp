// SPDX-License-Identifier: Apache-2.0
//
// rf-fspl — Free-space path loss (Friis 1946 / ITU-R P.525-4)
//
// A primitive-math WASM module: takes scalar (range, frequency) inputs and
// returns scalar dB output. No state beyond the init/destroy lifecycle. The
// module is part of the comms/ family that decomposes RfCommsCore.js into
// modular C++ kernels per RF_AUDIT_SOURCES.md (Section 1).
//
// Authority: ITU-R P.525-4 §6 + Friis IRE Proc. 1946. Both forms are
// implemented:
//
//   rf_fspl_friis_db(range_m, frequency_hz)
//     => 20·log10(4π·R·f/c)
//
//   rf_fspl_itu_p525_db(distance_km, frequency_mhz)
//     => 32.44778322188337 + 20·log10(d_km) + 20·log10(f_MHz)
//
// The two forms are mathematically identical. The ITU form is the standard
// presentation in P.525-4 §6.1; the Friis form lives at the boundary between
// SI inputs and dB output. Both yield identical IEEE-754 results to within
// the ulp of the constant.

#include "orbpro_plugin.h"

#include <cmath>
#include <cstdint>
#include <cstddef>

namespace {

constexpr double kSpeedOfLight = 299792458.0;     // CODATA 2018 / SI exact
constexpr double kPi = 3.141592653589793238462643383279502884;
// 32.44778322188337... = 20 * log10(4π * 1e9 / c). Computed to full double
// precision and frozen as a literal so the ITU form does not carry runtime
// log10(constant) cost.
constexpr double kIturFsplConstantDb = 32.44778322188337;

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

// Friis form: range in meters, frequency in Hz.
// Returns 0.0 for invalid inputs (negative range, non-positive frequency,
// zero range). Returns NaN-free, finite dB values for valid inputs.
ORBPRO_EXPORT
double rf_fspl_friis_db(double range_meters, double frequency_hz) {
  if (!std::isfinite(range_meters) || !std::isfinite(frequency_hz)) {
    return 0.0;
  }
  if (range_meters <= 0.0 || frequency_hz <= 0.0) {
    return 0.0;
  }
  const double wavelength = kSpeedOfLight / frequency_hz;
  const double ratio = (4.0 * kPi * range_meters) / wavelength;
  return 20.0 * std::log10(ratio);
}

// ITU-R P.525-4 §6.1 form: distance in km, frequency in MHz.
// Returns 0.0 for invalid inputs.
ORBPRO_EXPORT
double rf_fspl_itu_p525_db(double distance_km, double frequency_mhz) {
  if (!std::isfinite(distance_km) || !std::isfinite(frequency_mhz)) {
    return 0.0;
  }
  if (distance_km <= 0.0 || frequency_mhz <= 0.0) {
    return 0.0;
  }
  return kIturFsplConstantDb + 20.0 * std::log10(distance_km) +
         20.0 * std::log10(frequency_mhz);
}

}  // extern "C"
