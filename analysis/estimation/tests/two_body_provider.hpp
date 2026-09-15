#pragma once
// Test-only independent Newtonian two-body + variational-equation integrator.
// Vallado, Fundamentals of Astrodynamics and Applications, 4e, Ch. 2/9.
// SI, inertial Cartesian, elapsed TAI seconds. RK4 steps <= 1 second.
#include "estimation.hpp"
#include <algorithm>
#include <cmath>
namespace test_provider {
using namespace sdn::estimation;
inline bool two_body(const CartesianState &seed, double target,
                     PropagatorSample *out) {
  using State = std::array<double, 42>;
  State x{};
  for (int i = 0; i < 6; ++i)
    x[i] = seed.value[i];
  for (int i = 0; i < 6; ++i)
    x[6 + 7 * i] = 1;
  auto derivative = [](const State &a) {
    constexpr double mu = 3.986004418e14;
    State b{};
    double rr = a[0] * a[0] + a[1] * a[1] + a[2] * a[2], r = std::sqrt(rr),
           f = mu / (rr * r);
    for (int i = 0; i < 3; ++i) {
      b[i] = a[i + 3];
      b[i + 3] = -f * a[i];
    }
    for (int i = 0; i < 3; ++i)
      for (int j = 0; j < 6; ++j) {
        b[6 + 6 * i + j] = a[6 + 6 * (i + 3) + j];
        for (int k = 0; k < 3; ++k)
          b[6 + 6 * (i + 3) + j] +=
              f * (3 * a[i] * a[k] / rr - (i == k ? 1 : 0)) * a[6 + 6 * k + j];
      }
    return b;
  };
  const int steps = std::max(
      1, static_cast<int>(std::ceil(std::abs(target - seed.epoch_seconds))));
  const double h = (target - seed.epoch_seconds) / steps;
  for (int step = 0; step < steps; ++step) {
    const State a = derivative(x);
    State z{};
    for (int i = 0; i < 42; ++i)
      z[i] = x[i] + h * a[i] / 2;
    const State b = derivative(z);
    for (int i = 0; i < 42; ++i)
      z[i] = x[i] + h * b[i] / 2;
    const State c = derivative(z);
    for (int i = 0; i < 42; ++i)
      z[i] = x[i] + h * c[i];
    const State d = derivative(z);
    for (int i = 0; i < 42; ++i)
      x[i] += h * (a[i] + 2 * b[i] + 2 * c[i] + d[i]) / 6;
  }
  out->state.epoch_seconds = target;
  for (int i = 0; i < 6; ++i)
    out->state.value[i] = x[i];
  for (int i = 0; i < 36; ++i)
    out->stm[i] = x[6 + i];
  return true;
}
} // namespace test_provider
