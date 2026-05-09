// SPDX-License-Identifier: Apache-2.0
//
// rf-longley-rice — Longley-Rice (Irregular Terrain Model) skeleton.
//
// **STUB STATUS.** This module is structurally complete but the C++
// kernel is a deliberate stub that returns 0.0 with a status flag. The
// audit plan (RF_AUDIT_REPORT.md, Phase 4 Wave D) specifies fixture-only
// validation rather than a native port of the NTIA-ITS reference C
// implementation, which is a several-thousand-line single-purpose port
// outside the scope of the modular WASM migration. A follow-up effort
// will:
//
//   1. Vendor the NTIA-ITS Longley-Rice v1.2.2 source under
//      `vendor/longley-rice/` (BSD-style, NTIA public-domain release).
//   2. Wire the canonical entry points (`point_to_point`, `area`) here.
//   3. Replace the stub.
//
// Until then, the JS host's `RfCommsCore.calculateLinkBudget` continues
// to delegate Longley-Rice computations to the existing external WASM
// (see `RfCommsCore.js:2423` `computeLongleyRicePathLoss`). This module
// reserves the API surface so the future native port can land without
// changing JS-host call sites.
//
// Reference: NTIA-ITS Tech Memo 82-100 (Hufford, Longley, Kissick);
// NTIA-ITS reference algorithm v1.2.2; ITU-R P.1546-6 for the related
// land-mobile point-to-area model.

#include "orbpro_plugin.h"

#include <cmath>
#include <cstdint>
#include <cstddef>

namespace {

bool g_initialized = false;

inline bool isFiniteD(double v) { return std::isfinite(v); }

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

// Returns 1 to indicate the kernel is a stub (not implemented).
// Callers can branch on this and fall back to the JS-side delegation
// path until the NTIA-ITS reference implementation lands.
ORBPRO_EXPORT
int32_t rf_longley_rice_is_stub(void) {
  return 1;
}

// Stub entry: returns 0.0 dB regardless of inputs. The signature is
// frozen so the future native implementation can land without breaking
// the JS host.
//
// distance_km: great-circle distance between transmitter and receiver.
// frequency_mhz: 20 MHz – 20 GHz nominal range for the published
//   Longley-Rice ITM model.
// tx_height_m, rx_height_m: antenna heights above ground.
// terrain_irregularity_m: ITM "delta_h" terrain irregularity parameter
//   (typical 30–500 m for real terrain).
// climate_code: 1 = equatorial, 2 = continental subtropical, 3 = maritime
//   subtropical, 4 = desert, 5 = continental temperate (default), 6 =
//   maritime temperate over land, 7 = maritime temperate over sea.
// polarization_code: 0 = horizontal, 1 = vertical.
// surface_refractivity_n_units: standard 301 N-units.
// ground_dielectric_constant: typical 15.0 (average ground).
// ground_conductivity_s_per_m: typical 0.005 S/m (average ground).
// time_percent / location_percent / situation_percent: 0..100;
//   typical reliability targets 50/50/50 for median, 95/50/95 for
//   high reliability.
ORBPRO_EXPORT
double rf_longley_rice_path_loss_db(
    double distance_km,
    double frequency_mhz,
    double tx_height_m,
    double rx_height_m,
    double terrain_irregularity_m,
    int32_t climate_code,
    int32_t polarization_code,
    double surface_refractivity_n_units,
    double ground_dielectric_constant,
    double ground_conductivity_s_per_m,
    double time_percent,
    double location_percent,
    double situation_percent) {
  (void)distance_km;
  (void)frequency_mhz;
  (void)tx_height_m;
  (void)rx_height_m;
  (void)terrain_irregularity_m;
  (void)climate_code;
  (void)polarization_code;
  (void)surface_refractivity_n_units;
  (void)ground_dielectric_constant;
  (void)ground_conductivity_s_per_m;
  (void)time_percent;
  (void)location_percent;
  (void)situation_percent;

  if (!isFiniteD(distance_km) || !isFiniteD(frequency_mhz) ||
      !isFiniteD(tx_height_m) || !isFiniteD(rx_height_m)) {
    return 0.0;
  }

  // Stub — see file header. Returns 0.0; caller should check
  // rf_longley_rice_is_stub() before relying on this result.
  return 0.0;
}

}  // extern "C"
