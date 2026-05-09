// SPDX-License-Identifier: Apache-2.0
//
// rf-cloud-fog — ITU-R P.840-9 Annex 1 cloud / fog liquid-water absorption.
//
// Two exported kernels:
//
//   rf_cloud_specific_attenuation_coeff(f_GHz, T_C)
//     Mass-specific cloud-liquid-water attenuation coefficient K_l in
//     dB/(km · g/m³). Double-Debye permittivity for liquid water from
//     ITU-R P.840-9 Annex 1 §1.
//
//   rf_cloud_attenuation_db(f_GHz, T_C, density_g_per_m3, path_km)
//     Total slant-path cloud attenuation in dB:
//       A = K_l · ρ · path_km
//
// Constants ported verbatim from RfCommsCore.js
// `_cloudLiquidWaterSpecificAttenuationCoefficient` at line 4911.

#include "orbpro_plugin.h"

#include <cmath>
#include <cstdint>
#include <cstddef>

namespace {

bool g_initialized = false;

inline bool finite(double v) { return std::isfinite(v); }

// Mass-specific liquid-water attenuation coefficient K_l (dB/km per g/m³)
// from the double-Debye dispersion form of ITU-R P.840-9 Annex 1.
double cloud_liquid_water_K_l(double frequency_ghz, double temperature_kelvin) {
  if (frequency_ghz <= 0.0) return 0.0;
  const double T = std::max(temperature_kelvin, 1.0);
  const double theta = 300.0 / T;
  const double epsilon0 = 77.66 + 103.3 * (theta - 1.0);
  const double epsilon1 = 0.0671 * epsilon0;
  const double epsilon2 = 3.52;
  const double fp =
      20.2 - 146.0 * (theta - 1.0) + 316.0 * (theta - 1.0) * (theta - 1.0);
  const double fs = 39.8 * fp;
  const double fpRatio = frequency_ghz / std::max(fp, 1.0e-6);
  const double fsRatio = frequency_ghz / std::max(fs, 1.0e-6);
  const double epsilonPrime =
      (epsilon0 - epsilon1) / (1.0 + fpRatio * fpRatio) +
      (epsilon1 - epsilon2) / (1.0 + fsRatio * fsRatio) + epsilon2;
  const double epsilonDoublePrime =
      (fpRatio * (epsilon0 - epsilon1)) / (1.0 + fpRatio * fpRatio) +
      (fsRatio * (epsilon1 - epsilon2)) / (1.0 + fsRatio * fsRatio);
  const double eta =
      (2.0 + epsilonPrime) / std::max(epsilonDoublePrime, 1.0e-12);
  return (0.819 * frequency_ghz * epsilonDoublePrime) /
         (1.0 + eta * eta);
}

}  // namespace

extern "C" {

ORBPRO_EXPORT
int32_t plugin_init(const uint8_t *data, size_t len) {
  (void)data;
  (void)len;
  g_initialized = true;
  return 0;
}

ORBPRO_EXPORT
void plugin_destroy(void) {
  g_initialized = false;
}

// K_l in dB/(km · g/m³). T_C in °C.
ORBPRO_EXPORT
double rf_cloud_specific_attenuation_coeff(
    double frequency_ghz, double temperature_c) {
  if (!finite(frequency_ghz) || !finite(temperature_c)) return 0.0;
  return cloud_liquid_water_K_l(frequency_ghz, temperature_c + 273.15);
}

// Total cloud / fog slant-path attenuation in dB.
// liquid_water_density_g_per_m3: typical fog values 0.05–0.5 g/m³;
//   non-precipitating clouds 0.1–1.0 g/m³.
ORBPRO_EXPORT
double rf_cloud_attenuation_db(
    double frequency_ghz,
    double temperature_c,
    double liquid_water_density_g_per_m3,
    double path_km) {
  if (!finite(frequency_ghz) || !finite(temperature_c) ||
      !finite(liquid_water_density_g_per_m3) || !finite(path_km)) {
    return 0.0;
  }
  if (frequency_ghz <= 0.0 || path_km <= 0.0 ||
      liquid_water_density_g_per_m3 <= 0.0) {
    return 0.0;
  }
  const double K_l = cloud_liquid_water_K_l(
      frequency_ghz, temperature_c + 273.15);
  return K_l * liquid_water_density_g_per_m3 * path_km;
}

}  // extern "C"
