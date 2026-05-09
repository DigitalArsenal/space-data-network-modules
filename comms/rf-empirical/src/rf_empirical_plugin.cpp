// SPDX-License-Identifier: Apache-2.0
//
// rf-empirical — empirical terrestrial path-loss models.
//
// Phase 4 Wave B of the RF audit migration plan. Three published models
// in one module since the link-budget orchestrator picks among them at
// runtime and they share most input plumbing:
//
//   rf_two_ray_ground_loss_db
//     Rappaport 2e §4.6.2 (Eq. 4.52). Breakpoint at 4·h_t·h_r/λ; FSPL
//     below the breakpoint, 40·log10(d) − 20·log10(h_t·h_r) above.
//
//   rf_hata_urban_loss_db (medium-/small-city formulation, the most
//     common reference form)
//   rf_hata_suburban_loss_db = urban − [2·(log10(f/28))² + 5.4]
//   rf_hata_rural_loss_db    = urban − 4.78·(log10 f)² + 18.33·log10 f − 40.94
//     Hata, IEEE T-VT-29(3), Aug 1980, Eqs. (1)–(3).
//
//   rf_cost231_loss_db
//     COST 231 Final Report 1999 §4.4.3, Eq. 4.4.3. Adds a 3 dB
//     metropolitan-area correction.
//
// All models share the corrected mobile-antenna height term:
//   a(h_m) = (1.1·log10 f − 0.7)·h_m − (1.56·log10 f − 0.8)
// in dB.

#include "orbpro_plugin.h"

#include <cmath>
#include <cstdint>
#include <cstddef>

namespace {

constexpr double kSpeedOfLight = 299792458.0;
constexpr double kPi = 3.141592653589793238462643383279502884;

bool g_initialized = false;

inline bool isFiniteD(double v) {
  return std::isfinite(v);
}

inline double log10_safe(double x) {
  return std::log10(x);
}

// Standard small-city Hata mobile-antenna correction.
inline double hata_a_hm(double freq_mhz, double rx_height_m) {
  const double logF = log10_safe(freq_mhz);
  return (1.1 * logF - 0.7) * rx_height_m - (1.56 * logF - 0.8);
}

// Plain Friis form, kept private here so the empirical module is
// self-contained even when rf-fspl is not loaded.
inline double fspl_db(double range_m, double frequency_hz) {
  const double wavelength = kSpeedOfLight / frequency_hz;
  return 20.0 * log10_safe((4.0 * kPi * range_m) / wavelength);
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

// Two-ray ground (Rappaport §4.6.2). Returns 0.0 for invalid inputs.
// Below the breakpoint d_b = 4·h_t·h_r·f/c the model collapses to FSPL
// (the assumption that the surface-reflected ray's phase difference is
// small breaks down close-in); above d_b it follows the 40·log10 form.
ORBPRO_EXPORT
double rf_two_ray_ground_loss_db(
    double range_m,
    double tx_height_m,
    double rx_height_m,
    double frequency_hz) {
  if (!isFiniteD(range_m) || !isFiniteD(tx_height_m) ||
      !isFiniteD(rx_height_m) || !isFiniteD(frequency_hz)) {
    return 0.0;
  }
  if (range_m <= 0.0 || tx_height_m <= 0.0 ||
      rx_height_m <= 0.0 || frequency_hz <= 0.0) {
    return 0.0;
  }

  const double wavelength = kSpeedOfLight / frequency_hz;
  const double breakpoint = (4.0 * tx_height_m * rx_height_m) / wavelength;

  if (range_m < breakpoint) {
    return fspl_db(range_m, frequency_hz);
  }

  return 40.0 * log10_safe(range_m) -
         20.0 * log10_safe(tx_height_m * rx_height_m);
}

// Hata urban-area (medium/small city) loss in dB.
// frequency_mhz: 150–1500 MHz nominal.
// tx_height_m: base-station antenna height (30–200 m nominal).
// rx_height_m: mobile-station antenna height (1–10 m nominal).
// range_km: 1–20 km nominal.
ORBPRO_EXPORT
double rf_hata_urban_loss_db(
    double frequency_mhz,
    double tx_height_m,
    double rx_height_m,
    double range_km) {
  if (!isFiniteD(frequency_mhz) || !isFiniteD(tx_height_m) ||
      !isFiniteD(rx_height_m) || !isFiniteD(range_km)) {
    return 0.0;
  }
  if (frequency_mhz <= 0.0 || tx_height_m <= 0.0 ||
      rx_height_m <= 0.0 || range_km <= 0.0) {
    return 0.0;
  }

  const double a_hm = hata_a_hm(frequency_mhz, rx_height_m);
  return 69.55 +
         26.16 * log10_safe(frequency_mhz) -
         13.82 * log10_safe(tx_height_m) -
         a_hm +
         (44.9 - 6.55 * log10_safe(tx_height_m)) * log10_safe(range_km);
}

// Hata suburban-area correction:
//   L_suburban = L_urban − [2·(log10(f/28))² + 5.4]
ORBPRO_EXPORT
double rf_hata_suburban_loss_db(
    double frequency_mhz,
    double tx_height_m,
    double rx_height_m,
    double range_km) {
  const double urban = rf_hata_urban_loss_db(
      frequency_mhz, tx_height_m, rx_height_m, range_km);
  if (urban == 0.0) {
    return 0.0;
  }
  const double logFOver28 = log10_safe(frequency_mhz / 28.0);
  const double correction = 2.0 * logFOver28 * logFOver28 + 5.4;
  return urban - correction;
}

// Hata rural / open-area correction:
//   L_rural = L_urban − 4.78·(log10 f)² + 18.33·log10 f − 40.94
ORBPRO_EXPORT
double rf_hata_rural_loss_db(
    double frequency_mhz,
    double tx_height_m,
    double rx_height_m,
    double range_km) {
  const double urban = rf_hata_urban_loss_db(
      frequency_mhz, tx_height_m, rx_height_m, range_km);
  if (urban == 0.0) {
    return 0.0;
  }
  const double logF = log10_safe(frequency_mhz);
  return urban - 4.78 * logF * logF + 18.33 * logF - 40.94;
}

// COST 231 Hata extension (1500–2000 MHz nominal).
// metropolitan: 1 → metropolitan correction +3 dB; 0 → suburban (0 dB).
ORBPRO_EXPORT
double rf_cost231_loss_db(
    double frequency_mhz,
    double tx_height_m,
    double rx_height_m,
    double range_km,
    int32_t metropolitan) {
  if (!isFiniteD(frequency_mhz) || !isFiniteD(tx_height_m) ||
      !isFiniteD(rx_height_m) || !isFiniteD(range_km)) {
    return 0.0;
  }
  if (frequency_mhz <= 0.0 || tx_height_m <= 0.0 ||
      rx_height_m <= 0.0 || range_km <= 0.0) {
    return 0.0;
  }

  const double a_hm = hata_a_hm(frequency_mhz, rx_height_m);
  const double correction = metropolitan ? 3.0 : 0.0;
  return 46.3 +
         33.9 * log10_safe(frequency_mhz) -
         13.82 * log10_safe(tx_height_m) -
         a_hm +
         (44.9 - 6.55 * log10_safe(tx_height_m)) * log10_safe(range_km) +
         correction;
}

}  // extern "C"
