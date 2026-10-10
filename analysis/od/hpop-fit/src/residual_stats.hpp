// Exact position residual statistics: every reference point, no thinning.
//
// CelesTrak's rms.txt convention (measured by E11 2026-10-10 on ISS and
// Starlink): the per-coordinate RMS, sqrt(sum |dr|^2 / (3 N)) = 3D RMS /
// sqrt(3), in km, TEME, over the fit span. 3D and RTN magnitudes are the same
// in any inertial frame, so they may be scored in GCRF or TEME alike.
#pragma once

#include <array>
#include <cstddef>
#include <vector>

#include "time_frames.hpp"

namespace odhpop {

struct ResidualStats {
  std::size_t n = 0;
  double span_s = 0.0;
  UtcEpoch start;
  UtcEpoch stop;
  double rms_3d_km = 0.0;
  double rms_r_km = 0.0;
  double rms_t_km = 0.0;
  double rms_n_km = 0.0;
  double max_3d_km = 0.0;
  double rms_per_coordinate_km = 0.0;  // rms_3d / sqrt(3): the rms.txt figure
};

// `truth` and `model` are states (km and km/s, or m and m/s with
// `metres` true) at the same epochs, in one inertial frame. RTN axes come
// from the truth state; a truth without velocity uses the model's.
ResidualStats residual_stats(const std::vector<UtcEpoch>& epochs,
                             const std::vector<std::array<double, 6>>& truth,
                             const std::vector<std::array<double, 6>>& model,
                             const std::vector<bool>& truth_has_velocity, bool metres);

}  // namespace odhpop
