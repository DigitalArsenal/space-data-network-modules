// SPDX-License-Identifier: Apache-2.0
//
// rf-link-budget — Friis link-budget orchestrator.
//
// Composes the per-model loss values produced by the other comms/
// modules into the standard Friis transmission budget plus kTB noise,
// SNR, Eb/N0, channel capacity, and link margin. The C++ kernel is
// scalar-only: the host (or rf-link-budget JS wrapper) calls each
// per-model module first, then hands the composed losses to this
// module.
//
// **Audit fix.** This module applies the
//   Eb/N0 = SNR + 10·log10(bandwidth / symbol_rate)
// correction the audit identified at RfCommsCore.js:2872. The original
// JS sets Eb/N0 = SNR which is only correct when bandwidth equals the
// symbol rate. The new signature requires the caller to specify both;
// hosts may default symbol_rate to bandwidth to preserve legacy
// behavior, but this module emits the correct relation given any
// consistent (B, R_b) pair.
//
// Authority:
//   Pratt, *Satellite Communications* 4e, Chapter 4 — link budget,
//     EIRP, received power, kTB noise.
//   Sklar, *Digital Communications* 2e, Chapter 4 + Eq. 4.27 — SNR,
//     Eb/N0 = SNR + 10·log10(B/R_b).
//   Shannon, Bell Sys. Tech. J. 1948, Eq. (16) — channel capacity.
//   Johnson 1928 / Nyquist 1928 — thermal noise floor.

#include "orbpro_plugin.h"

#include <cmath>
#include <cstdint>
#include <cstddef>
#include <cstring>

namespace {

// CODATA 2018 / SI 2019 — Boltzmann constant is exactly defined.
constexpr double kBoltzmannK = 1.380649e-23;
constexpr double kSpeedOfLight = 299792458.0;
constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kLn2Recip = 1.4426950408889634;  // 1 / ln(2)

bool g_initialized = false;

inline bool finite(double v) { return std::isfinite(v); }

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

// EIRP_dBW = 10·log10(P_W) + G_t − L_t.
ORBPRO_EXPORT
double rf_link_eirp_dbw(
    double tx_power_w, double tx_gain_dbi, double tx_line_loss_db) {
  if (!finite(tx_power_w) || !finite(tx_gain_dbi) ||
      !finite(tx_line_loss_db)) {
    return 0.0;
  }
  if (tx_power_w <= 0.0) return 0.0;
  return 10.0 * std::log10(tx_power_w) + tx_gain_dbi - tx_line_loss_db;
}

// kTB noise floor in dBW. Includes the receiver noise factor F as
// 10^(NF/10).
ORBPRO_EXPORT
double rf_link_noise_power_dbw(
    double system_temp_k,
    double bandwidth_hz,
    double rx_noise_figure_db) {
  if (!finite(system_temp_k) || !finite(bandwidth_hz) ||
      !finite(rx_noise_figure_db)) {
    return 0.0;
  }
  if (system_temp_k <= 0.0 || bandwidth_hz <= 0.0) return 0.0;
  const double F = std::pow(10.0, rx_noise_figure_db / 10.0);
  const double N_linear = kBoltzmannK * system_temp_k * bandwidth_hz * F;
  return 10.0 * std::log10(N_linear);
}

// Free-space path loss (Friis) — duplicated here so this module is
// self-contained even if rf-fspl is not loaded.
ORBPRO_EXPORT
double rf_link_free_space_loss_db(double range_m, double frequency_hz) {
  if (!finite(range_m) || !finite(frequency_hz)) return 0.0;
  if (range_m <= 0.0 || frequency_hz <= 0.0) return 0.0;
  const double wavelength = kSpeedOfLight / frequency_hz;
  return 20.0 * std::log10((4.0 * kPi * range_m) / wavelength);
}

// Compute Eb/N0 from SNR with the bandwidth-to-symbol-rate correction
// the audit identified. If symbol_rate_hz is non-positive (or
// non-finite) the function falls back to Eb/N0 = SNR — same as the
// legacy buggy form — so callers that haven't migrated still get a
// sensible value.
//
// Sklar §4 Eq. 4.27:
//   Eb/N0 = SNR + 10·log10(B / R_b)
ORBPRO_EXPORT
double rf_link_ebno_db(
    double snr_db, double bandwidth_hz, double symbol_rate_hz) {
  if (!finite(snr_db)) return 0.0;
  if (!finite(bandwidth_hz) || !finite(symbol_rate_hz) ||
      bandwidth_hz <= 0.0 || symbol_rate_hz <= 0.0) {
    return snr_db;  // Legacy fallback: behaves as the old
                    // (incorrect) Eb/N0 = SNR identity.
  }
  return snr_db + 10.0 * std::log10(bandwidth_hz / symbol_rate_hz);
}

// Shannon channel capacity in bps. SNR provided in dB.
ORBPRO_EXPORT
double rf_link_capacity_bps(double bandwidth_hz, double snr_db) {
  if (!finite(bandwidth_hz) || !finite(snr_db)) return 0.0;
  if (bandwidth_hz <= 0.0) return 0.0;
  const double snrLinear = std::pow(10.0, snr_db / 10.0);
  return bandwidth_hz * std::log(1.0 + snrLinear) * kLn2Recip;
}

// Compose the full link budget. Caller has already computed the per-model
// loss components via the other comms/ modules (or set them to 0). The
// result buffer layout matches the legacy CommsPlugin 96-byte struct:
//
//   offset 0   double eirp_dbw
//   offset 8   double free_space_loss_db
//   offset 16  double total_path_loss_db
//   offset 24  double received_power_dbw
//   offset 32  double noise_power_dbw
//   offset 40  double snr_db
//   offset 48  double ebno_db                  ← FIXED
//   offset 56  double capacity_bps
//   offset 64  double link_margin_db
//   offset 72  double atmospheric_loss_db_echo
//   offset 80  double rain_loss_db_echo
//   offset 88  uint32 flags  (LINK_UP, BER_OK, MARGIN_OK, RAIN_FADE,
//                             ATMO_EFFECTS)
//   offset 92  uint32 reserved
//
// Returns 0 on success, negative on invalid output buffer size.
ORBPRO_EXPORT
int32_t rf_link_budget_compute(
    double range_m,
    double frequency_hz,
    double tx_power_w,
    double tx_gain_dbi,
    double tx_line_loss_db,
    double rx_gain_dbi,
    double rx_line_loss_db,
    double rx_noise_figure_db,
    double system_temp_k,
    double bandwidth_hz,
    double symbol_rate_hz,
    double model_loss_db,
    double atmospheric_loss_db,
    double rain_loss_db,
    double cloud_loss_db,
    double environmental_loss_db,
    double polarization_mismatch_db,
    double required_link_margin_db,
    uint8_t *result_bytes,
    uint32_t result_size) {
  if (result_bytes == nullptr || result_size < 96) return -1;
  std::memset(result_bytes, 0, 96);

  const double eirp = rf_link_eirp_dbw(
      tx_power_w, tx_gain_dbi, tx_line_loss_db);
  const double fsl = rf_link_free_space_loss_db(range_m, frequency_hz);
  const double total = model_loss_db + atmospheric_loss_db +
                       rain_loss_db + cloud_loss_db +
                       environmental_loss_db + polarization_mismatch_db +
                       rx_line_loss_db;
  const double rxp = eirp + rx_gain_dbi - total;
  const double noise = rf_link_noise_power_dbw(
      system_temp_k, bandwidth_hz, rx_noise_figure_db);
  const double snr = rxp - noise;
  const double ebno = rf_link_ebno_db(snr, bandwidth_hz, symbol_rate_hz);
  const double capacity = rf_link_capacity_bps(bandwidth_hz, snr);
  const double linkMargin = snr - required_link_margin_db;

  uint32_t flags = 0;
  if (snr > 0.0) flags |= 0x01;          // LINK_UP
  if (snr > 10.0) flags |= 0x02;         // BER_OK
  if (linkMargin > 3.0) flags |= 0x04;   // MARGIN_OK
  if (rain_loss_db > 1.0) flags |= 0x08; // RAIN_FADE
  if (atmospheric_loss_db + cloud_loss_db > 1.0) flags |= 0x10; // ATMO_EFFECTS

  std::memcpy(result_bytes + 0, &eirp, sizeof(double));
  std::memcpy(result_bytes + 8, &fsl, sizeof(double));
  std::memcpy(result_bytes + 16, &total, sizeof(double));
  std::memcpy(result_bytes + 24, &rxp, sizeof(double));
  std::memcpy(result_bytes + 32, &noise, sizeof(double));
  std::memcpy(result_bytes + 40, &snr, sizeof(double));
  std::memcpy(result_bytes + 48, &ebno, sizeof(double));
  std::memcpy(result_bytes + 56, &capacity, sizeof(double));
  std::memcpy(result_bytes + 64, &linkMargin, sizeof(double));
  std::memcpy(result_bytes + 72, &atmospheric_loss_db, sizeof(double));
  std::memcpy(result_bytes + 80, &rain_loss_db, sizeof(double));
  std::memcpy(result_bytes + 88, &flags, sizeof(uint32_t));

  return 0;
}

}  // extern "C"
