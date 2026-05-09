// SPDX-License-Identifier: Apache-2.0
//
// rf-rain — rain-attenuation primitives.
//
// Three exported kernels:
//
//   rf_rain_specific_attenuation_db_per_km(f_GHz, R_mm_h, elev_deg, tau_deg)
//     ITU-R P.838-3 §1: γ_R = k(f, θ, τ) · R^α(f, θ, τ).
//     k_H, α_H, k_V, α_V are interpolated from frequency via the published
//     four-/five-curve sum-of-Lorentzians fit, then mixed via the
//     elevation/polarization-tilt orientation factor.
//
//   rf_rain_attenuation_db(f_GHz, R_mm_h, path_km, elev_deg, tau_deg)
//     ITU-R P.530-18 §2.4 Eq. (33) terrestrial line-of-sight reduction:
//     A = γ_R · d / (1 + 0.045·d).
//
//   rf_rain_attenuation_crane_db(f_GHz, R_mm_h, path_km, elev_deg, tau_deg)
//     Crane 1980 IEEE T-COMM-28(9) piecewise-exponential model. JS port
//     truncates to 22.5 km; this preserves that behavior.
//
// All functions return 0.0 for invalid inputs (non-finite, frequency
// below 1 GHz where the P.838-3 fit is invalid, non-positive path).
//
// Coefficient values are taken verbatim from RfCommsCore.js's
// `_rainSpecificAttenuationParameters` (which itself reproduces the
// ITU-R P.838-3 published table). Phase 2 of the audit replaces these
// with values regenerated from the ITU table directly.

#include "orbpro_plugin.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstddef>

namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kDegToRad = kPi / 180.0;

bool g_initialized = false;

inline bool isFiniteD(double v) { return std::isfinite(v); }

// Sum-of-Lorentzians curve term used in the P.838 coefficient fit.
inline double curve(double f_GHz, double a, double b, double c) {
  const double t = (std::log10(f_GHz) - b) / c;
  return a * std::exp(-t * t);
}

struct RainCoefficients {
  double k;
  double alpha;
};

// ITU-R P.838-3 fit constants ported verbatim from RfCommsCore.js.
struct CurveFit {
  const double *aj;
  const double *bj;
  const double *cj;
  int len;
  double m;
  double c;
};

constexpr double kKh_aj[] = {-5.3398, -0.35351, -0.23789, -0.94158};
constexpr double kKh_bj[] = {-0.10008, 1.2697, 0.86036, 0.64552};
constexpr double kKh_cj[] = {1.13098, 0.454, 0.15354, 0.16817};

constexpr double kKv_aj[] = {-3.80595, -3.44965, -0.39902, 0.50167};
constexpr double kKv_bj[] = {0.56934, -0.22911, 0.73042, 1.07319};
constexpr double kKv_cj[] = {0.81061, 0.51059, 0.11899, 0.27195};

constexpr double kAh_aj[] = {-0.14318, 0.29591, 0.32177, -5.3761, 16.1721};
constexpr double kAh_bj[] = {1.82442, 0.77564, 0.63773, -0.9623, -3.2998};
constexpr double kAh_cj[] = {-0.55187, 0.19822, 0.13164, 1.47828, 3.4399};

constexpr double kAv_aj[] = {-0.07771, 0.56727, -0.20238, -48.2991, 48.5833};
constexpr double kAv_bj[] = {2.3384, 0.95545, 1.1452, 0.791669, 0.791459};
constexpr double kAv_cj[] = {-0.76284, 0.54039, 0.26809, 0.116226, 0.116479};

inline double evaluate_log10_k(
    double f_GHz, const double *aj, const double *bj,
    const double *cj, int len, double m, double c) {
  double total = m * std::log10(f_GHz) + c;
  for (int i = 0; i < len; ++i) {
    total += curve(f_GHz, aj[i], bj[i], cj[i]);
  }
  return total;
}

inline double evaluate_alpha(
    double f_GHz, const double *aj, const double *bj,
    const double *cj, int len, double m, double c) {
  double total = m * std::log10(f_GHz) + c;
  for (int i = 0; i < len; ++i) {
    total += curve(f_GHz, aj[i], bj[i], cj[i]);
  }
  return total;
}

// Mix horizontal/vertical k and α values via the elevation+polarization
// orientation factor. Identical to the JS form.
RainCoefficients rain_coefficients(
    double f_GHz, double elevation_deg, double tau_deg) {
  RainCoefficients zero{0.0, 0.0};
  if (!isFiniteD(f_GHz) || f_GHz < 1.0) {
    return zero;
  }
  const double kHorizontalLog = evaluate_log10_k(
      f_GHz, kKh_aj, kKh_bj, kKh_cj, 4, -0.18961, 0.71147);
  const double kVerticalLog = evaluate_log10_k(
      f_GHz, kKv_aj, kKv_bj, kKv_cj, 4, -0.16398, 0.63297);
  const double alphaHorizontal = evaluate_alpha(
      f_GHz, kAh_aj, kAh_bj, kAh_cj, 5, 0.67849, -1.95537);
  const double alphaVertical = evaluate_alpha(
      f_GHz, kAv_aj, kAv_bj, kAv_cj, 5, -0.053739, 0.83433);

  const double kH = std::pow(10.0, kHorizontalLog);
  const double kV = std::pow(10.0, kVerticalLog);
  const double thetaRad = elevation_deg * kDegToRad;
  const double tauRad = tau_deg * kDegToRad;
  const double cosTheta = std::cos(thetaRad);
  const double orientation = cosTheta * cosTheta * std::cos(2.0 * tauRad);

  const double k = (kH + kV + (kH - kV) * orientation) / 2.0;
  const double alphaNumerator = kH * alphaHorizontal + kV * alphaVertical +
      (kH * alphaHorizontal - kV * alphaVertical) * orientation;
  const double alphaDenominator = std::max(2.0 * k, 1.0e-12);
  const double alpha = alphaNumerator / alphaDenominator;

  RainCoefficients out;
  out.k = std::max(k, 0.0);
  out.alpha = std::max(alpha, 0.0);
  return out;
}

// Closed-form integral used in Crane's piecewise model.
inline double exponential_segment(double coeff, double x0, double x1) {
  if (x1 <= x0) return 0.0;
  if (std::fabs(coeff) < 1.0e-12) {
    return x1 - x0;
  }
  return (std::exp(coeff * x1) - std::exp(coeff * x0)) / coeff;
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

// ITU-R P.838-3 specific attenuation γ_R = k · R^α in dB/km.
ORBPRO_EXPORT
double rf_rain_specific_attenuation_db_per_km(
    double frequency_ghz,
    double rain_rate_mm_per_hour,
    double elevation_deg,
    double polarization_tilt_deg) {
  if (!isFiniteD(frequency_ghz) || !isFiniteD(rain_rate_mm_per_hour) ||
      !isFiniteD(elevation_deg) || !isFiniteD(polarization_tilt_deg)) {
    return 0.0;
  }
  if (rain_rate_mm_per_hour <= 0.0 || frequency_ghz < 1.0) {
    return 0.0;
  }
  const RainCoefficients params = rain_coefficients(
      frequency_ghz, elevation_deg, polarization_tilt_deg);
  if (params.k <= 0.0) return 0.0;
  return params.k * std::pow(rain_rate_mm_per_hour, params.alpha);
}

// ITU-R P.530-18 §2.4 terrestrial LOS rain attenuation, dB.
ORBPRO_EXPORT
double rf_rain_attenuation_db(
    double frequency_ghz,
    double rain_rate_mm_per_hour,
    double path_km,
    double elevation_deg,
    double polarization_tilt_deg) {
  if (!isFiniteD(frequency_ghz) || !isFiniteD(rain_rate_mm_per_hour) ||
      !isFiniteD(path_km) || !isFiniteD(elevation_deg) ||
      !isFiniteD(polarization_tilt_deg)) {
    return 0.0;
  }
  if (rain_rate_mm_per_hour <= 0.0 || frequency_ghz < 1.0 ||
      path_km <= 0.0) {
    return 0.0;
  }
  const double gamma_R = rf_rain_specific_attenuation_db_per_km(
      frequency_ghz, rain_rate_mm_per_hour,
      elevation_deg, polarization_tilt_deg);
  const double reductionFactor = 1.0 / (1.0 + 0.045 * path_km);
  return gamma_R * path_km * reductionFactor;
}

// Crane 1980 piecewise-exponential rain attenuation, dB.
// Path is clamped to 22.5 km (matches the JS port).
ORBPRO_EXPORT
double rf_rain_attenuation_crane_db(
    double frequency_ghz,
    double rain_rate_mm_per_hour,
    double path_km,
    double elevation_deg,
    double polarization_tilt_deg) {
  if (!isFiniteD(frequency_ghz) || !isFiniteD(rain_rate_mm_per_hour) ||
      !isFiniteD(path_km) || !isFiniteD(elevation_deg) ||
      !isFiniteD(polarization_tilt_deg)) {
    return 0.0;
  }
  if (rain_rate_mm_per_hour <= 0.0 || frequency_ghz < 1.0) {
    return 0.0;
  }

  double distance_km = path_km;
  if (distance_km < 0.0) distance_km = 0.0;
  if (distance_km > 22.5) distance_km = 22.5;
  if (distance_km == 0.0) return 0.0;

  const RainCoefficients params = rain_coefficients(
      frequency_ghz, elevation_deg, polarization_tilt_deg);
  if (params.k <= 0.0 || params.alpha <= 0.0) return 0.0;

  const double gamma_R =
      params.k * std::pow(rain_rate_mm_per_hour, params.alpha);
  const double logRain = std::log(rain_rate_mm_per_hour);
  const double delta = std::max(0.1, 3.8 - 0.6 * logRain);
  const double c = 0.026 - 0.03 * logRain;
  const double bAlpha = std::exp(params.alpha * (0.83 - 0.17 * logRain));
  const double y =
      params.alpha * (c + (std::log(2.3) - 0.17 * logRain) / delta);
  const double z = params.alpha * c;

  if (distance_km <= delta) {
    return gamma_R * exponential_segment(y, 0.0, distance_km);
  }
  return gamma_R *
         (exponential_segment(y, 0.0, delta) +
          bAlpha * exponential_segment(z, delta, distance_km));
}

}  // extern "C"
