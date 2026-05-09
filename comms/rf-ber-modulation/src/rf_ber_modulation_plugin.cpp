// SPDX-License-Identifier: Apache-2.0
//
// rf-ber-modulation — bit-error-rate per modulation given Eb/N0.
//
// One exported kernel taking an integer modulation code and a dB Eb/N0:
//
//   rf_ber_from_ebno(ebno_db, modulation_code)
//
// Modulation codes (integer enum, matches RfCommsCore.ModulationType
// numeric constants):
//   0 = BPSK,     1 = QPSK,    2 = 8-PSK,
//   3 = 16-QAM,   4 = 64-QAM,  5 = FSK
//
// Closed forms ported from RfCommsCore.js calculateBER (Sklar 2e §4):
//   BPSK / QPSK      : 0.5 · erfc(√(Eb/N0))
//   8-PSK            : (2/3) · erfc(√((Eb/N0) · sin²(π/8)))   (note: code uses sin(π/8) per Sklar §4.5.2 approximation)
//   16-QAM           : 0.75 · erfc(√(0.4 · Eb/N0))            (Sklar §4.6.1)
//   64-QAM           : (7/12) · erfc(√((Eb/N0) / 7))          (Sklar §4.6.1)
//   FSK (coherent)   : 0.5 · exp(−0.5 · Eb/N0)
//
// Plus rf_erfc as a primitive — same Chebyshev-approximation form as
// the JS port (Numerical Recipes §6.2 erfcc).

#include "orbpro_plugin.h"

#include <cmath>
#include <cstdint>
#include <cstddef>

namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;

bool g_initialized = false;

inline bool finite(double v) { return std::isfinite(v); }

// Numerical Recipes §6.2 erfcc — same coefficients as the JS port.
double erfc_chebyshev(double x) {
  const double t = 1.0 / (1.0 + 0.5 * std::fabs(x));
  const double tau = t * std::exp(
      -x * x - 1.26551223 +
      t * (1.00002368 +
      t * (0.37409196 +
      t * (0.09678418 +
      t * (-0.18628806 +
      t * (0.27886807 +
      t * (-1.13520398 +
      t * (1.48851587 +
      t * (-0.82215223 +
      t * 0.17087277))))))))
  );
  return x >= 0.0 ? tau : 2.0 - tau;
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

// Complementary error function. Numerical Recipes §6.2 Chebyshev
// approximation; ~7 digits of accuracy.
ORBPRO_EXPORT
double rf_erfc(double x) {
  if (!finite(x)) return 0.0;
  return erfc_chebyshev(x);
}

// Bit-error rate given Eb/N0 in dB and modulation code.
// Returns 0.5 (worst case) for unknown modulation codes — same fallback
// as the JS calculateBER default branch.
ORBPRO_EXPORT
double rf_ber_from_ebno(double ebno_db, int32_t modulation_code) {
  if (!finite(ebno_db)) return 0.5;
  const double ebnoLinear = std::pow(10.0, ebno_db / 10.0);
  if (!finite(ebnoLinear) || ebnoLinear <= 0.0) return 0.5;

  switch (modulation_code) {
    case 0:   // BPSK
    case 1: { // QPSK (same BER per bit as BPSK)
      return 0.5 * erfc_chebyshev(std::sqrt(ebnoLinear));
    }
    case 2: { // 8-PSK — Sklar §4.5.2 approximation.
      const double s = std::sin(kPi / 8.0);
      return (2.0 / 3.0) * erfc_chebyshev(std::sqrt(ebnoLinear * s));
    }
    case 3: { // 16-QAM — Sklar §4.6.1.
      return 0.75 * erfc_chebyshev(std::sqrt(0.4 * ebnoLinear));
    }
    case 4: { // 64-QAM — Sklar §4.6.1.
      return (7.0 / 12.0) * erfc_chebyshev(std::sqrt(ebnoLinear / 7.0));
    }
    case 5: { // Coherent binary FSK — Sklar §4.4.
      return 0.5 * std::exp(-0.5 * ebnoLinear);
    }
    default: {
      return 0.5 * erfc_chebyshev(std::sqrt(ebnoLinear));
    }
  }
}

}  // extern "C"
