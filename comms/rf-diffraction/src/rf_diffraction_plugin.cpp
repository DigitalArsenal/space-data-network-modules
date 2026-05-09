// SPDX-License-Identifier: Apache-2.0
//
// rf-diffraction — knife-edge diffraction primitives per ITU-R P.526-15.
//
// Four exported scalar kernels:
//
//   rf_knife_edge_parameter_v(start_d, start_h, end_d, end_h,
//                             obstacle_d, obstacle_h, wavelength_m,
//                             effective_earth_radius_factor)
//     Dimensionless Fresnel-Kirchhoff parameter v at a single knife-edge
//     obstruction in a 2-D path profile. Earth-curvature correction
//     (4/3-rule and similar) is applied when
//     effective_earth_radius_factor > 0; pass 0 to skip.
//
//   rf_knife_edge_loss_db(v)
//     ITU-R P.526-15 §4.1 Eq. (31) Vogler approximation:
//       J(v) ≈ 6.9 + 20·log10(√((v−0.1)² + 1) + v − 0.1) for v > −0.78,
//       0 otherwise.
//
//   rf_fresnel_kirchhoff_v(clearance_m, d1_m, d2_m, wavelength_m)
//     Alternative entry point for callers that already know the
//     clearance (positive = obstacle above LOS) and want v directly.
//
//   rf_curvature_drop_m(distance_m, effective_earth_radius_factor)
//     Earth-bulge drop relative to a flat geometry: d² / (2·k·R_E).
//
// Multi-knife Deygout is intentionally JS-host-orchestrated: the host
// recursively picks the dominant obstacle (highest v) and calls these
// primitives — there's no numerical advantage to doing the recursion in
// C++ and a real cost in passing variable-length obstacle arrays across
// the WASM boundary. Same pattern as analysis/access uses for arrays.

#include "orbpro_plugin.h"

#include <cmath>
#include <cstdint>
#include <cstddef>

namespace {

constexpr double kEarthRadiusMeters = 6371000.0;

bool g_initialized = false;

inline bool isFiniteD(double v) { return std::isfinite(v); }

inline double curvature_drop(double distance_m,
                             double effective_earth_radius_factor) {
  if (effective_earth_radius_factor <= 0.0) {
    return 0.0;
  }
  return (distance_m * distance_m) /
         (2.0 * effective_earth_radius_factor * kEarthRadiusMeters);
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

// Earth-curvature drop in meters at distance d along the path.
// Pass effective_earth_radius_factor = 0 (or negative) to disable the
// adjustment. The standard 4/3-rule corresponds to factor ≈ 1.333.
ORBPRO_EXPORT
double rf_curvature_drop_m(
    double distance_m,
    double effective_earth_radius_factor) {
  if (!isFiniteD(distance_m) || !isFiniteD(effective_earth_radius_factor)) {
    return 0.0;
  }
  return curvature_drop(distance_m, effective_earth_radius_factor);
}

// Fresnel-Kirchhoff diffraction parameter v at an obstruction plane,
// computed from raw clearance.
//   v = h · √(2·(d1 + d2) / (λ · d1 · d2))
// Sign convention: clearance positive when obstacle is above the
// straight line of sight; negative for clear paths.
ORBPRO_EXPORT
double rf_fresnel_kirchhoff_v(
    double clearance_m,
    double d1_m,
    double d2_m,
    double wavelength_m) {
  if (!isFiniteD(clearance_m) || !isFiniteD(d1_m) || !isFiniteD(d2_m) ||
      !isFiniteD(wavelength_m)) {
    return 0.0;
  }
  if (d1_m <= 0.0 || d2_m <= 0.0 || wavelength_m <= 0.0) {
    return 0.0;
  }
  return clearance_m * std::sqrt(
      (2.0 * (d1_m + d2_m)) / (wavelength_m * d1_m * d2_m));
}

// Knife-edge v parameter from a 2-D path profile with explicit endpoint
// and obstruction coordinates. Optional Earth-curvature adjustment.
// Distances are along the great-circle path (projected to the path
// surface); heights are vertical above a common reference (e.g.,
// MSL). Returns 0 for invalid geometry.
ORBPRO_EXPORT
double rf_knife_edge_parameter_v(
    double start_distance_m,
    double start_height_m,
    double end_distance_m,
    double end_height_m,
    double obstacle_distance_m,
    double obstacle_height_m,
    double wavelength_m,
    double effective_earth_radius_factor) {
  if (!isFiniteD(start_distance_m) || !isFiniteD(start_height_m) ||
      !isFiniteD(end_distance_m) || !isFiniteD(end_height_m) ||
      !isFiniteD(obstacle_distance_m) || !isFiniteD(obstacle_height_m) ||
      !isFiniteD(wavelength_m) || !isFiniteD(effective_earth_radius_factor)) {
    return 0.0;
  }
  if (wavelength_m <= 0.0) return 0.0;

  const double segmentLength = end_distance_m - start_distance_m;
  const double d1 = obstacle_distance_m - start_distance_m;
  const double d2 = end_distance_m - obstacle_distance_m;
  if (segmentLength <= 0.0 || d1 <= 0.0 || d2 <= 0.0) {
    return 0.0;
  }

  const double sH = start_height_m -
                    curvature_drop(start_distance_m,
                                   effective_earth_radius_factor);
  const double eH = end_height_m -
                    curvature_drop(end_distance_m,
                                   effective_earth_radius_factor);
  const double oH = obstacle_height_m -
                    curvature_drop(obstacle_distance_m,
                                   effective_earth_radius_factor);
  const double losHeight = sH + (eH - sH) * d1 / segmentLength;
  const double clearance = oH - losHeight;
  return clearance *
         std::sqrt((2.0 * (d1 + d2)) / (wavelength_m * d1 * d2));
}

// ITU-R P.526-15 §4.1 Eq. (31) Vogler approximation for J(v).
// Returns 0 dB for v <= −0.78 (sub-threshold; treat as no diffraction
// loss). Same form as RfCommsCore.js port.
ORBPRO_EXPORT
double rf_knife_edge_loss_db(double v) {
  if (!isFiniteD(v) || v <= -0.78) {
    return 0.0;
  }
  const double term =
      std::sqrt((v - 0.1) * (v - 0.1) + 1.0) + v - 0.1;
  return 6.9 + 20.0 * std::log10(term);
}

}  // extern "C"
