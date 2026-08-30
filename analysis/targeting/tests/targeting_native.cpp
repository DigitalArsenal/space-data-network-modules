#include "higherpop/target.hpp"
#include "higherpop/stationkeeping.hpp"

#include <algorithm>
#include <cassert>
#include <cmath>
#include <iostream>

using hp::target::Algorithm;
using hp::target::DifferenceMode;
using hp::target::Matrix;
using hp::target::Options;
using hp::target::Vecd;

double relative(double actual, double expected) {
  return std::fabs(actual - expected) / std::max(1.0, std::fabs(expected));
}

int main() {
  // Orekit bug #362 authority: a normalized parameter with physical scale
  // 1e-3 is presented to the propagator builder at normalized values 0 and 1,
  // not scaled a second time. The targeter therefore perturbs the consumer's
  // control coordinates exactly once and leaves physical scaling to that port.
  std::vector<double> orekit_samples;
  const auto orekit_scaled_parameter = [&](const Vecd& x) {
    orekit_samples.push_back(x[0]);
    return Vecd{x[0]};
  };
  Options orekit_options;
  orekit_options.difference_mode = DifferenceMode::Forward;
  orekit_options.perturbations = {1.0};
  int orekit_evaluations = 0;
  const Vecd orekit_base = orekit_scaled_parameter({0.0});
  const Matrix orekit_jacobian = hp::target::finiteDifferenceJacobian(
      orekit_scaled_parameter, {0.0}, orekit_base, orekit_options,
      orekit_evaluations);
  assert(orekit_samples == std::vector<double>({0.0, 1.0}));
  assert(orekit_jacobian.size() == 1 && orekit_jacobian[0][0] == 1.0);

  const Vecd expected{1.25, -0.4};
  const auto smooth = [](const Vecd& x) {
    return Vecd{x[0] * x[0] + x[1], x[0] + std::sin(x[1])};
  };
  const Vecd desired = smooth(expected);
  int newton_evaluations = 0;
  int broyden_evaluations = 0;
  int modified_broyden_evaluations = 0;
  double worst_smooth_relative = 0.0;
  for (Algorithm algorithm : {Algorithm::NewtonRaphson, Algorithm::Broyden,
                              Algorithm::ModifiedBroyden}) {
    Options options;
    options.algorithm = algorithm;
    options.difference_mode = DifferenceMode::Central;
    options.tol = 1e-11;
    const auto result = hp::target::solve(smooth, {0.8, 0.1}, desired, options);
    assert(result.converged);
    worst_smooth_relative = std::max(
        {worst_smooth_relative,
         relative(result.controls[0], expected[0]),
         relative(result.controls[1], expected[1])});
    assert(worst_smooth_relative <= 1e-9);
    if (algorithm == Algorithm::NewtonRaphson) newton_evaluations = result.nfev;
    else {
      assert(result.nfev < newton_evaluations);
      if (algorithm == Algorithm::Broyden) broyden_evaluations = result.nfev;
      else modified_broyden_evaluations = result.nfev;
    }
  }

  Options central;
  central.difference_mode = DifferenceMode::Central;
  int central_evaluations = 0;
  const Vecd at = smooth(expected);
  const Matrix finite = hp::target::finiteDifferenceJacobian(
      smooth, expected, at, central, central_evaluations);
  const Matrix analytic{{2.0 * expected[0], 1.0},
                        {1.0, std::cos(expected[1])}};
  double analytic_worst_relative = 0.0;
  for (std::size_t row = 0; row < 2; ++row) {
    for (std::size_t column = 0; column < 2; ++column) {
      analytic_worst_relative = std::max(
          analytic_worst_relative,
          relative(finite[row][column], analytic[row][column]));
      assert(analytic_worst_relative <= 1e-7);
    }
  }
  Options forward = central;
  forward.difference_mode = DifferenceMode::Forward;
  int forward_evaluations = 0;
  const Matrix one_sided = hp::target::finiteDifferenceJacobian(
      smooth, expected, at, forward, forward_evaluations);
  double finite_difference_worst_relative = 0.0;
  for (std::size_t row = 0; row < 2; ++row) {
    for (std::size_t column = 0; column < 2; ++column) {
      finite_difference_worst_relative = std::max(
          finite_difference_worst_relative,
          relative(one_sided[row][column], finite[row][column]));
      assert(finite_difference_worst_relative <= 1e-5);
    }
  }

  constexpr double mu = 398600.4418;
  // Vallado 4th ed., Example 6-1. These values are the generated Tier-B row
  // already pinned in analysis/maneuver/vectors/vectors.json.
  constexpr double vallado_r1 = 6569.48111;
  constexpr double vallado_r2 = 42159.48557;
  constexpr double vallado_dv1 = 2.4570375641775745;
  double vallado_worst_relative = 0.0;
  const auto vallado_apogee = [&](const Vecd& controls) {
    const double circular_speed = std::sqrt(mu / vallado_r1);
    const double speed = circular_speed + controls[0];
    const double energy = 0.5 * speed * speed - mu / vallado_r1;
    const double semi_major_axis = -mu / (2.0 * energy);
    return Vecd{2.0 * semi_major_axis - vallado_r1};
  };
  for (Algorithm algorithm : {Algorithm::NewtonRaphson, Algorithm::Broyden,
                              Algorithm::ModifiedBroyden}) {
    Options options;
    options.algorithm = algorithm;
    options.difference_mode = DifferenceMode::Central;
    options.tol = 1e-9;
    const auto result = hp::target::solve(
        vallado_apogee, {2.0}, {vallado_r2}, options);
    assert(result.converged);
    vallado_worst_relative = std::max(
        vallado_worst_relative,
        relative(result.controls[0], vallado_dv1));
    assert(vallado_worst_relative <= 1e-6);
    assert(relative(vallado_apogee(result.controls)[0], vallado_r2) <= 1e-9);
  }

  constexpr double r1 = 6678.1363;
  constexpr double r2 = 42164.0;
  const double circular = std::sqrt(mu / r1);
  const double transfer = std::sqrt(mu * (2.0 / r1 - 2.0 / (r1 + r2)));
  const double hohmann = transfer - circular;
  const auto apogee = [&](const Vecd& controls) {
    const double speed = circular + controls[0];
    const double energy = 0.5 * speed * speed - mu / r1;
    const double semi_major_axis = -mu / (2.0 * energy);
    return Vecd{2.0 * semi_major_axis - r1};
  };
  Options target_options;
  target_options.tol = 1e-8;
  const auto hohmann_result =
      hp::target::solve(apogee, {2.0}, {r2}, target_options);
  assert(hohmann_result.converged);
  const double hohmann_relative = relative(hohmann_result.controls[0], hohmann);
  assert(hohmann_relative <= 1e-6);
  assert(relative(apogee(hohmann_result.controls)[0], r2) <= 1e-10);

  const double inclination = 28.5 * M_PI / 180.0;
  const double combined =
      std::sqrt(transfer * transfer + circular * circular -
                2.0 * transfer * circular * std::cos(inclination));
  const double burn_angle =
      std::atan2(transfer * std::sin(inclination),
                 transfer * std::cos(inclination) - circular);
  const auto combined_state = [&](const Vecd& controls) {
    const double tangential = circular + controls[0] * std::cos(controls[1]);
    const double normal = controls[0] * std::sin(controls[1]);
    const double speed = std::hypot(tangential, normal);
    const double energy = 0.5 * speed * speed - mu / r1;
    const double semi_major_axis = -mu / (2.0 * energy);
    return Vecd{2.0 * semi_major_axis - r1, std::atan2(normal, tangential)};
  };
  const auto combined_evaluator = [&](const Vecd& controls) {
    const Vecd state = combined_state(controls);
    return Vecd{state[0] / r2, state[1]};
  };
  target_options.difference_mode = DifferenceMode::Central;
  const auto combined_result = hp::target::solve(
      combined_evaluator, {combined * 0.9, burn_angle * 1.1},
      {1.0, inclination}, target_options);
  if (!combined_result.converged) {
    std::cerr << "combined target failed: status="
              << static_cast<int>(combined_result.status)
              << " message=" << combined_result.message
              << " residual=" << combined_result.residual_norm
              << " iters=" << combined_result.iters
              << " nfev=" << combined_result.nfev << "\n";
  }
  assert(combined_result.converged);
  const double combined_relative =
      relative(combined_result.controls[0], combined);
  assert(combined_relative <= 1e-6);
  assert(relative(combined_state(combined_result.controls)[0], r2) <= 1e-8);
  assert(relative(combined_state(combined_result.controls)[1], inclination) <= 1e-8);

  // One-year textbook GEO sizing anchors: approximately 2 m/s east-west for
  // the stated 0.05 deg deadband scenario and 45.5 m/s north-south for the
  // mean 0.85 deg/year luni-solar plane drift.
  const auto geo = hp::stationkeeping::annualGeoBudget(
      0.764695, 0.05, 0.85);
  const double geo_east_west_relative =
      std::fabs(geo.east_west.dv_per_year - 0.002) / 0.002;
  const double geo_north_south_relative =
      std::fabs(geo.north_south.dv_per_year - 0.0455) / 0.0455;
  assert(geo_east_west_relative <= 0.05);
  assert(geo_north_south_relative <= 0.05);

  std::cout << std::scientific
            << "targeting: orekit_scale_once=0,1 algorithms=3"
            << " smooth_relative=" << worst_smooth_relative
            << " evaluations=" << newton_evaluations << "/"
            << broyden_evaluations << "/" << modified_broyden_evaluations
            << " vallado_6_1_relative=" << vallado_worst_relative
            << " fd_vs_central=" << finite_difference_worst_relative
            << " analytic_vs_central=" << analytic_worst_relative
            << " hohmann_relative=" << hohmann_relative
            << " combined_relative=" << combined_relative
            << " geo_ew_m_s=" << geo.east_west.dv_per_year * 1000.0
            << " geo_ns_m_s=" << geo.north_south.dv_per_year * 1000.0
            << " geo_ew_relative=" << geo_east_west_relative
            << " geo_ns_relative=" << geo_north_south_relative << "\n";
}
