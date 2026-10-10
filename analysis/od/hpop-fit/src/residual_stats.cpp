#include "residual_stats.hpp"

#include <algorithm>
#include <cmath>

namespace odhpop {

ResidualStats residual_stats(const std::vector<UtcEpoch>& epochs,
                             const std::vector<std::array<double, 6>>& truth,
                             const std::vector<std::array<double, 6>>& model,
                             const std::vector<bool>& truth_has_velocity, bool metres) {
  ResidualStats s;
  const std::size_t n = std::min({epochs.size(), truth.size(), model.size()});
  if (n == 0) return s;
  const double k = metres ? 1e-3 : 1.0;
  double sum3 = 0, sr = 0, st = 0, sn = 0, worst = 0;
  for (std::size_t i = 0; i < n; ++i) {
    const auto& a = truth[i];
    const auto& b = model[i];
    const bool own = i >= truth_has_velocity.size() || truth_has_velocity[i];
    const auto& axes = own ? a : b;
    const double d[3] = {(b[0] - a[0]) * k, (b[1] - a[1]) * k, (b[2] - a[2]) * k};
    const double r[3] = {axes[0], axes[1], axes[2]};
    const double v[3] = {axes[3], axes[4], axes[5]};
    const double rn = std::sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
    double h[3] = {r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]};
    const double hn = std::sqrt(h[0] * h[0] + h[1] * h[1] + h[2] * h[2]);
    const double R[3] = {r[0] / rn, r[1] / rn, r[2] / rn};
    const double N[3] = {h[0] / hn, h[1] / hn, h[2] / hn};
    const double T[3] = {N[1] * R[2] - N[2] * R[1], N[2] * R[0] - N[0] * R[2], N[0] * R[1] - N[1] * R[0]};
    const double dr = d[0] * R[0] + d[1] * R[1] + d[2] * R[2];
    const double dt = d[0] * T[0] + d[1] * T[1] + d[2] * T[2];
    const double dn = d[0] * N[0] + d[1] * N[1] + d[2] * N[2];
    const double m2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    sum3 += m2;
    sr += dr * dr;
    st += dt * dt;
    sn += dn * dn;
    worst = std::max(worst, std::sqrt(m2));
  }
  s.n = n;
  s.start = epochs.front();
  s.stop = epochs[n - 1];
  s.span_s = seconds_between(s.start, s.stop);
  s.rms_3d_km = std::sqrt(sum3 / double(n));
  s.rms_r_km = std::sqrt(sr / double(n));
  s.rms_t_km = std::sqrt(st / double(n));
  s.rms_n_km = std::sqrt(sn / double(n));
  s.max_3d_km = worst;
  s.rms_per_coordinate_km = s.rms_3d_km / std::sqrt(3.0);
  return s;
}

}  // namespace odhpop
