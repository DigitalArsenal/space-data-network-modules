#include "orbpro_solver_abi.h"
#include "coords.h"

#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iostream>

extern "C" {
int32_t plugin_reference_evaluate(const double*, double*);
int32_t plugin_reference_finish(const double*, const double*, double*);
int32_t plugin_reference_sqp_evaluate(const double*, double*);
int32_t plugin_reference_sqp_infeasible_evaluate(const double*, double*);
}

using Evaluator = int32_t (*)(const double*, double*);
using JacobianEvaluator = int32_t (*)(const double*, double*);

int32_t reference_analytic_jacobian(const double* candidate, double* output) {
  if (!candidate || !output) return -1;
  constexpr double mu = 3.986004418e14;
  constexpr double perigee_radius = 6678136.3;
  constexpr double target_apogee = 42164000.0;
  constexpr double pi = 3.14159265358979323846;
  const double circular_speed = std::sqrt(mu / perigee_radius);
  const double angular_rate =
      std::sqrt(mu / (perigee_radius * perigee_radius * perigee_radius));
  const double phase = angular_rate * candidate[1];
  const double plane_angle = 0.12 * std::sin(phase);
  const double plane_angle_rate = 0.12 * angular_rate * std::cos(phase);
  const double delta_v = candidate[0];
  const double speed_squared =
      circular_speed * circular_speed + delta_v * delta_v +
      2.0 * circular_speed * delta_v * std::cos(plane_angle);
  const double energy = 0.5 * speed_squared - mu / perigee_radius;
  if (!(energy < 0.0) || !(speed_squared > 0.0)) return -2;
  const double apogee_scale = mu / (energy * energy * target_apogee);
  const double speed_squared_dv =
      2.0 * delta_v + 2.0 * circular_speed * std::cos(plane_angle);
  const double speed_squared_dt =
      -2.0 * circular_speed * delta_v * std::sin(plane_angle) *
      plane_angle_rate;
  const double goal0_dv = 0.5 * apogee_scale * speed_squared_dv;
  const double goal0_dt = 0.5 * apogee_scale * speed_squared_dt;
  const double goal1_dv =
      circular_speed * std::sin(plane_angle) / speed_squared;
  const double goal1_dt =
      delta_v * plane_angle_rate *
      (circular_speed * std::cos(plane_angle) + delta_v) /
      speed_squared;
  output[0] = goal0_dv;
  output[1] = goal0_dt;
  output[2] = goal1_dv;
  output[3] = goal1_dt;
  return 0;
}

OrbProSolverResult run(OrbProSolverSettings settings,
                       const double* initial,
                       const double* lower,
                       const double* upper,
                       const double* desired,
                       const double* perturbations,
                       Evaluator evaluator,
                       JacobianEvaluator jacobian_evaluator = nullptr) {
  assert(plugin_solver_configure(&settings, initial, lower, upper, desired,
                                 perturbations) == ORBPRO_SOLVER_STATUS_IDLE);
  assert(plugin_solver_begin() == ORBPRO_SOLVER_STATUS_NEEDS_EVALUATION);
  for (uint32_t guard = 0; guard < settings.maximum_evaluations; ++guard) {
    OrbProSolverEvaluationRequest request{};
    const int32_t next = plugin_solver_next(&request);
    if (next == 0) break;
    assert(next == 1);
    double values[ORBPRO_SOLVER_MAX_DIMENSION + 1]{};
    assert(evaluator(request.variables, values) == 0);
    OrbProSolverEvaluation evaluation{};
    evaluation.request_id = request.request_id;
    evaluation.valid = 1;
    if (settings.algorithm == ORBPRO_SOLVER_SQP) {
      evaluation.constraint_count = settings.equality_constraint_count +
                                    settings.inequality_constraint_count;
      evaluation.objective = values[0];
      std::copy(values + 1, values + 1 + evaluation.constraint_count,
                evaluation.constraints);
    } else {
      evaluation.goal_count = settings.goal_count;
      std::copy(values, values + settings.goal_count, evaluation.goals);
      if (request.kind == ORBPRO_SOLVER_EVALUATE_VALUES_AND_JACOBIAN) {
        assert(jacobian_evaluator != nullptr);
        evaluation.jacobian_rows = settings.goal_count;
        evaluation.jacobian_columns = settings.variable_count;
        assert(jacobian_evaluator(request.variables, evaluation.jacobian) == 0);
      }
    }
    plugin_solver_supply(&evaluation);
  }
  OrbProSolverResult result{};
  const int32_t reported_status = plugin_solver_result(&result);
  assert(reported_status == result.status);
  return result;
}

int main() {
  constexpr double target_apogee_m = 42164000.0;
  constexpr double frame_test_jd = 2461283.0;
  const coords::StateVec frame_test_gcrf(
      {target_apogee_m / 1000.0, 0.0, 0.0},
      {0.0, 3.074666284127684, 0.0});
  const coords::StateVec frame_test_ecef = coords::transform(
      frame_test_gcrf, coords::Frame::GCRF, coords::Frame::ECEF,
      frame_test_jd);
  const double frame_test_state[]{
      frame_test_ecef.position.x * 1000.0,
      frame_test_ecef.position.y * 1000.0,
      frame_test_ecef.position.z * 1000.0,
      frame_test_ecef.velocity.x * 1000.0,
      frame_test_ecef.velocity.y * 1000.0,
      frame_test_ecef.velocity.z * 1000.0,
      frame_test_jd,
  };
  const double frame_test_candidate[]{2425.73, 0.0};
  double frame_test_output[11]{};
  assert(plugin_reference_finish(frame_test_candidate, frame_test_state,
                                 frame_test_output) == 0);
  const double frame_radius_relative =
      std::fabs(frame_test_output[0] - 1.0);
  const double frame_inclination_absolute = std::fabs(frame_test_output[1]);
  assert(frame_radius_relative <= 1e-12);
  assert(frame_inclination_absolute <= 1e-12);

  OrbProSolverSettings target{};
  target.algorithm = ORBPRO_SOLVER_NEWTON_RAPHSON;
  target.difference_mode = ORBPRO_SOLVER_DIFFERENCE_CENTRAL;
  target.maximum_iterations = 50;
  target.maximum_evaluations = 1000;
  target.variable_count = 2;
  target.goal_count = 2;
  target.residual_tolerance = 1e-9;
  target.step_tolerance = 1e-12;
  target.constraint_tolerance = 1e-8;
  target.kkt_tolerance = 1e-6;
  const double target_initial[]{2400.0, 500.0};
  const double target_lower[]{0.0, -3000.0};
  const double target_upper[]{5000.0, 3000.0};
  const double target_desired[]{1.0, 0.0};
  const double target_steps[]{0.01, 0.1};
  const auto targeted = run(target, target_initial, target_lower, target_upper,
                            target_desired, target_steps,
                            plugin_reference_evaluate);
  assert(targeted.status == ORBPRO_SOLVER_STATUS_CONVERGED);
  assert(targeted.residual_norm <= target.residual_tolerance);

  OrbProSolverSettings analytic_target = target;
  analytic_target.difference_mode = ORBPRO_SOLVER_DIFFERENCE_ANALYTIC_STM;
  const auto analytic_targeted = run(
      analytic_target, target_initial, target_lower, target_upper,
      target_desired, target_steps, plugin_reference_evaluate,
      reference_analytic_jacobian);
  assert(analytic_targeted.status == ORBPRO_SOLVER_STATUS_CONVERGED);
  double analytic_stm_relative = 0.0;
  for (uint32_t index = 0; index < target.variable_count; ++index) {
    analytic_stm_relative = std::max(
        analytic_stm_relative,
        std::fabs(analytic_targeted.variables[index] - targeted.variables[index]) /
            std::max(1.0, std::fabs(targeted.variables[index])));
  }
  assert(analytic_stm_relative <= 1e-7);
  assert(analytic_targeted.evaluation_count < targeted.evaluation_count);

  OrbProSolverSettings sqp = target;
  sqp.algorithm = ORBPRO_SOLVER_SQP;
  sqp.goal_count = 0;
  sqp.equality_constraint_count = 2;
  sqp.inequality_constraint_count = 1;
  sqp.maximum_iterations = 100;
  sqp.maximum_evaluations = 2000;
  const auto optimized = run(sqp, target_initial, target_lower, target_upper,
                             nullptr, target_steps,
                             plugin_reference_sqp_evaluate);
  if (optimized.status != ORBPRO_SOLVER_STATUS_CONVERGED) {
    std::cerr << "reverse SQP failed status=" << static_cast<int>(optimized.status)
              << " objective=" << optimized.objective
              << " violation=" << optimized.maximum_constraint_violation
              << " kkt=" << optimized.kkt_residual
              << " iterations=" << optimized.iteration_count
              << " evaluations=" << optimized.evaluation_count << "\n";
  }
  assert(optimized.status == ORBPRO_SOLVER_STATUS_CONVERGED);
  assert(optimized.maximum_constraint_violation <= sqp.constraint_tolerance);
  assert(optimized.kkt_residual <= sqp.kkt_tolerance);
  assert(optimized.objective <= targeted.variables[0] * (1.0 + 1e-9));

  OrbProSolverSettings impossible = sqp;
  impossible.variable_count = 1;
  impossible.equality_constraint_count = 0;
  impossible.inequality_constraint_count = 2;
  const double impossible_initial[]{2350.0};
  const double impossible_lower[]{0.0};
  const double impossible_upper[]{5000.0};
  const double impossible_steps[]{0.01};
  const auto refused = run(impossible, impossible_initial, impossible_lower,
                           impossible_upper, nullptr, impossible_steps,
                           plugin_reference_sqp_infeasible_evaluate);
  assert(refused.status == ORBPRO_SOLVER_STATUS_INFEASIBLE);

  std::cout << std::scientific
            << "reverse-port: target=converged sqp=converged"
            << " target_objective=" << targeted.variables[0]
            << " analytic_stm_relative=" << analytic_stm_relative
            << " analytic_evaluations=" << analytic_targeted.evaluation_count
            << " sqp_objective=" << optimized.objective
            << " sqp_violation=" << optimized.maximum_constraint_violation
            << " sqp_kkt=" << optimized.kkt_residual
            << " ecef_gcrf_radius_relative=" << frame_radius_relative
            << " ecef_gcrf_inclination_absolute="
            << frame_inclination_absolute
            << " infeasible=reported\n";
}
