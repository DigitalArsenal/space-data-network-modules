#include "optimal_control/sqp.hpp"

#include <algorithm>
#include <cassert>
#include <cmath>
#include <iostream>
#include <limits>

using sdn::sqp::Evaluation;
using sdn::sqp::Options;
using sdn::sqp::Status;
using sdn::sqp::Vector;

double relative(double actual, double expected) {
  return std::fabs(actual - expected) / std::max(1.0, std::fabs(expected));
}

int main() {
  // Hock-Schittkowski problem 1: Rosenbrock with x2 >= -1.5.
  const auto hs1 = [](const Vector& x) {
    const double objective =
        100.0 * std::pow(x[1] - x[0] * x[0], 2) + std::pow(1.0 - x[0], 2);
    return Evaluation{objective, {}, {-x[1] - 1.5}, true};
  };
  Options hs_options;
  hs_options.maximum_iterations = 500;
  hs_options.kkt_tolerance = 1e-6;
  hs_options.constraint_tolerance = 1e-8;
  const auto hs_result = sdn::sqp::solve(hs1, {-2.0, 1.0}, hs_options);
  if (hs_result.status != Status::Converged) {
    std::cerr << "HS1 failed status=" << static_cast<int>(hs_result.status)
              << " message=" << hs_result.message
              << " f=" << hs_result.evaluation.objective
              << " violation=" << hs_result.maximum_constraint_violation
              << " kkt=" << hs_result.kkt_residual << "\n";
  }
  assert(hs_result.status == Status::Converged);
  assert(relative(hs_result.evaluation.objective, 0.0) <= 1e-6);
  assert(hs_result.maximum_constraint_violation <= 1e-8);

  // Physical two-impulse LEO-to-GEO transfer with a 28.5 degree plane change.
  // x[0]/x[1] split the plane change between perigee and apogee, and x[2]
  // is the coast time. The objective is the vector-summed delta-v of both
  // burns; the equalities close the plane change and enforce the Hohmann
  // half-period time of flight.
  constexpr double mu = 398600.4418;
  constexpr double r1 = 6678.1363;
  constexpr double r2 = 42164.0;
  constexpr double total_plane_change = 28.5 * M_PI / 180.0;
  const double transfer_axis = 0.5 * (r1 + r2);
  const double circular_1 = std::sqrt(mu / r1);
  const double circular_2 = std::sqrt(mu / r2);
  const double transfer_perigee =
      std::sqrt(mu * (2.0 / r1 - 1.0 / transfer_axis));
  const double transfer_apogee =
      std::sqrt(mu * (2.0 / r2 - 1.0 / transfer_axis));
  const double transfer_time =
      M_PI * std::sqrt(transfer_axis * transfer_axis * transfer_axis / mu);
  const auto transfer = [&](const Vector& x) {
    const double departure = std::sqrt(
        circular_1 * circular_1 + transfer_perigee * transfer_perigee -
        2.0 * circular_1 * transfer_perigee * std::cos(x[0]));
    const double arrival = std::sqrt(
        transfer_apogee * transfer_apogee + circular_2 * circular_2 -
        2.0 * transfer_apogee * circular_2 * std::cos(x[1]));
    return Evaluation{departure + arrival,
                      {x[0] + x[1] - total_plane_change,
                       (x[2] - transfer_time) / transfer_time},
                      {}, true};
  };
  Options mission_options;
  mission_options.maximum_iterations = 500;
  mission_options.lower_bounds = {0.0, 0.0, 0.0};
  mission_options.upper_bounds = {
      total_plane_change, total_plane_change, 1.99 * transfer_time};
  const auto mission = sdn::sqp::solve(
      transfer,
      {0.1 * total_plane_change, 0.9 * total_plane_change, transfer_time},
      mission_options);
  assert(mission.status == Status::Converged);
  assert(mission.maximum_constraint_violation <= 1e-8);
  assert(mission.kkt_residual <= 1e-6);

  double grid_best = std::numeric_limits<double>::infinity();
  for (int row = 0; row < 200; ++row) {
    const double departure_angle = total_plane_change * row / 199.0;
    for (int column = 0; column < 200; ++column) {
      const double arrival_angle = total_plane_change * column / 199.0;
      if (std::fabs(departure_angle + arrival_angle - total_plane_change) <=
          1e-12) {
        grid_best = std::min(
            grid_best,
            transfer({departure_angle, arrival_angle, transfer_time}).objective);
      }
    }
  }
  assert(mission.evaluation.objective <= grid_best + 1e-12);

  // Known-infeasible pair: x >= 2 and x <= 1.
  const auto infeasible = [](const Vector& x) {
    return Evaluation{x[0] * x[0], {}, {2.0 - x[0], x[0] - 1.0}, true};
  };
  Options infeasible_options;
  infeasible_options.maximum_iterations = 50;
  const auto infeasible_result =
      sdn::sqp::solve(infeasible, {1.5}, infeasible_options);
  if (infeasible_result.status != Status::Infeasible) {
    std::cerr << "infeasible problem status="
              << static_cast<int>(infeasible_result.status)
              << " message=" << infeasible_result.message
              << " violation=" << infeasible_result.maximum_constraint_violation
              << "\n";
  }
  assert(infeasible_result.status == Status::Infeasible);

  std::cout << std::scientific
            << "sqp: hs1_objective=" << hs_result.evaluation.objective
            << " hs1_violation=" << hs_result.maximum_constraint_violation
            << " mission_objective=" << mission.evaluation.objective
            << " grid_best=" << grid_best
            << " mission_violation=" << mission.maximum_constraint_violation
            << " mission_kkt=" << mission.kkt_residual
            << " infeasible=reported\n";
}
