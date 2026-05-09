// SPDX-License-Identifier: Apache-2.0
//
// rf-atmospheric-gaseous — gaseous absorption: oxygen + water vapor.
//
// **AUDIT NOTE.** This module ports the existing simplified single-line
// approximations from RfCommsCore.js verbatim. The forms are NOT
// ITU-R P.676-13 Annex 2 — they are ad-hoc Lorentzian fits centered on
// the dominant 60 GHz O₂ line and 22 GHz H₂O line. The port is
// deliberately faithful so behavior is preserved during the WASM
// migration; Phase 2 of the RF audit will (a) characterize their
// deviation from the proper P.676-13 reference values across the
// (frequency, temperature, humidity) operating envelope, and (b) annotate
// `valid_range` metadata at the call sites where the deviation is
// acceptable, OR replace them with full P.676 Annex 2 in a follow-up.
//
// Citations:
//   - Simplified O₂ / H₂O line fits — RfCommsCore.js:4882-4906 (origin
//     unknown, no published reference cited in the JS).
//   - Magnus saturation vapor pressure — WMO No. 8 (CIMO Guide), 8th ed.,
//     Annex 4.A.1 (Alduchov & Eskridge 1996 form).
//
// Returns dB for a given path length, frequency, temperature, and
// humidity. Compatible signature with RfCommsCore.js's
// `_atmosphericAbsorption(freqGHz, pathKm, tempC, humidity, profile)`.

#include "orbpro_plugin.h"

#include <cmath>
#include <cstdint>
#include <cstddef>

namespace {

bool g_initialized = false;

inline bool isFiniteD(double v) { return std::isfinite(v); }

// WMO Magnus form for saturation vapor pressure over water.
// temperature_c: temperature in °C.
// Returns saturation vapor pressure in hPa.
inline double magnus_saturation_vapor_pressure_hpa(double temperature_c) {
  return 6.1121 * std::exp(
      (17.502 * temperature_c) / (240.97 + temperature_c));
}

// Single-Lorentzian oxygen-line absorption, dB/km.
// Valid roughly < 57 GHz; above that the 60 GHz oxygen complex dominates
// and this single-line fit is meaningless.
inline double oxygen_specific_attenuation_db_per_km(
    double frequency_ghz, double temperature_kelvin) {
  if (frequency_ghz >= 57.0) return 0.0;
  const double f2 = frequency_ghz * frequency_ghz;
  const double thetaCubed =
      std::pow(300.0 / temperature_kelvin, 3.0);
  return ((7.2 * f2) / (f2 + 0.34)) * thetaCubed * 1.0e-3;
}

// Single-Lorentzian water-vapor-line absorption (centered at 22.235 GHz),
// dB/km. Valid roughly > 1 GHz and below the dominant 183 GHz H₂O line.
inline double water_vapor_specific_attenuation_db_per_km(
    double frequency_ghz,
    double temperature_kelvin,
    double vapor_pressure_hpa) {
  if (frequency_ghz <= 1.0) return 0.0;
  const double thetaPow25 = std::pow(300.0 / temperature_kelvin, 2.5);
  const double f_minus_22 = frequency_ghz - 22.235;
  const double denom = f_minus_22 * f_minus_22 + 9.0;
  return 0.05 * vapor_pressure_hpa * thetaPow25 * (3.0 / denom);
}

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

// Specific oxygen attenuation in dB/km.
// frequency_ghz: in GHz. Returns 0.0 above the model's valid range.
// temperature_c: ambient temperature in °C.
ORBPRO_EXPORT
double rf_oxygen_specific_attenuation_db_per_km(
    double frequency_ghz,
    double temperature_c) {
  if (!isFiniteD(frequency_ghz) || !isFiniteD(temperature_c)) return 0.0;
  if (frequency_ghz <= 0.0) return 0.0;
  return oxygen_specific_attenuation_db_per_km(
      frequency_ghz, temperature_c + 273.15);
}

// Specific water-vapor attenuation in dB/km.
// frequency_ghz: in GHz.
// temperature_c: ambient temperature in °C.
// humidity_percent: relative humidity, 0..100. Used with the WMO Magnus
//   form to compute partial vapor pressure.
ORBPRO_EXPORT
double rf_water_vapor_specific_attenuation_db_per_km(
    double frequency_ghz,
    double temperature_c,
    double humidity_percent) {
  if (!isFiniteD(frequency_ghz) || !isFiniteD(temperature_c) ||
      !isFiniteD(humidity_percent)) {
    return 0.0;
  }
  if (frequency_ghz <= 0.0 || humidity_percent < 0.0) return 0.0;
  const double esat = magnus_saturation_vapor_pressure_hpa(temperature_c);
  const double e = humidity_percent * esat / 100.0;
  return water_vapor_specific_attenuation_db_per_km(
      frequency_ghz, temperature_c + 273.15, e);
}

// Total atmospheric absorption over a slant path, dB.
// frequency_ghz: in GHz.
// path_km: path length through the atmosphere, in km.
// temperature_c: ambient temperature in °C.
// humidity_percent: relative humidity, 0..100.
//
// **VALID RANGE NOTE.** The simplified Lorentzian fits are valid roughly
// within (1, 50) GHz at temperate conditions (250–320 K, 0–100 % RH).
// Outside this range the call returns the simplified value but should
// be treated with skepticism until Phase 2 of the audit publishes
// deviation maps.
ORBPRO_EXPORT
double rf_atmospheric_absorption_db(
    double frequency_ghz,
    double path_km,
    double temperature_c,
    double humidity_percent) {
  if (!isFiniteD(frequency_ghz) || !isFiniteD(path_km) ||
      !isFiniteD(temperature_c) || !isFiniteD(humidity_percent)) {
    return 0.0;
  }
  if (path_km <= 0.0 || frequency_ghz <= 0.0 ||
      humidity_percent < 0.0) {
    return 0.0;
  }
  const double tempK = temperature_c + 273.15;
  const double esat = magnus_saturation_vapor_pressure_hpa(temperature_c);
  const double e = humidity_percent * esat / 100.0;
  const double gammaO =
      oxygen_specific_attenuation_db_per_km(frequency_ghz, tempK);
  const double gammaH = water_vapor_specific_attenuation_db_per_km(
      frequency_ghz, tempK, e);
  return (gammaO + gammaH) * path_km;
}

// WMO Magnus saturation vapor pressure exposed as a primitive — used by
// the rain and cloud modules and worth having directly callable.
ORBPRO_EXPORT
double rf_saturation_vapor_pressure_hpa(double temperature_c) {
  if (!isFiniteD(temperature_c)) return 0.0;
  return magnus_saturation_vapor_pressure_hpa(temperature_c);
}

}  // extern "C"
