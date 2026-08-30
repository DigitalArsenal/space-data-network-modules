#include "orbpro_solver_abi.h"
#include "higherpop/target.hpp"
#include "optimal_control/sqp.hpp"
#include "coords.h"

#if __has_include("space_data_module_invoke.h")
#include "space_data_module_invoke.h"
#define TARGETING_HAS_INVOKE_SUPPORT 1
#else
#define TARGETING_HAS_INVOKE_SUPPORT 0
#endif

#if defined(__wasm__)
#define TARGETING_WASM_EXPORT(name) __attribute__((export_name(name)))
#else
#define TARGETING_WASM_EXPORT(name)
#endif

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>

namespace {

enum class Phase { Idle, Base, Plus, Minus, Trial, Done };

OrbProSolverSettings settings{};
hp::target::Vecd controls;
hp::target::Vecd lower_bounds;
hp::target::Vecd upper_bounds;
hp::target::Vecd desired;
hp::target::Vecd perturbations;
hp::target::Vecd values;
hp::target::Matrix jacobian;
hp::target::Vecd plus_values;
hp::target::Vecd trial_controls;
hp::target::Vecd pending_step;
std::vector<OrbProSolverIteration> iterations;
OrbProSolverEvaluationRequest request{};
OrbProSolverResult terminal{};
Phase phase = Phase::Idle;
uint32_t column = 0;
uint32_t evaluation_count = 0;
uint64_t request_id = 0;
double residual_norm = 0.0;
double damping = 1e-10;
int rejected_steps = 0;
bool request_pending = false;

#if TARGETING_HAS_INVOKE_SUPPORT
const plugin_input_frame_t* find_problem_frame() {
  const uint32_t count = plugin_get_input_count();
  for (uint32_t index = 0; index < count; ++index) {
    const plugin_input_frame_t* frame = plugin_get_input_frame(index);
    if (frame != nullptr && frame->port_id != nullptr &&
        std::strcmp(frame->port_id, "problem") == 0) {
      return frame;
    }
  }
  return nullptr;
}

struct FlatTable {
  const uint8_t* bytes = nullptr;
  std::size_t size = 0;
  std::size_t position = 0;

  template <typename T>
  bool read(std::size_t offset, T* value) const {
    if (value == nullptr || offset > size || sizeof(T) > size - offset) return false;
    std::memcpy(value, bytes + offset, sizeof(T));
    return true;
  }

  bool field(uint16_t index, std::size_t width, std::size_t* offset) const {
    int32_t backwards = 0;
    if (!read(position, &backwards) || backwards <= 0 ||
        static_cast<std::size_t>(backwards) > position) return false;
    const std::size_t vtable = position - static_cast<std::size_t>(backwards);
    uint16_t vtable_size = 0;
    if (!read(vtable, &vtable_size)) return false;
    const std::size_t entry = 4 + static_cast<std::size_t>(index) * 2;
    if (entry + 2 > vtable_size || entry + 2 > size - vtable) return false;
    uint16_t displacement = 0;
    if (!read(vtable + entry, &displacement) || displacement == 0) return false;
    const std::size_t candidate = position + displacement;
    if (candidate > size || width > size - candidate) return false;
    *offset = candidate;
    return true;
  }

  template <typename T>
  bool scalar(uint16_t index, T fallback, T* value) const {
    std::size_t offset = 0;
    if (!field(index, sizeof(T), &offset)) {
      *value = fallback;
      return true;
    }
    return read(offset, value);
  }

  bool reference(uint16_t index, std::size_t* target) const {
    std::size_t offset = 0;
    uint32_t relative = 0;
    if (!field(index, sizeof(relative), &offset) || !read(offset, &relative) ||
        relative > size - offset) return false;
    *target = offset + relative;
    return *target < size;
  }

  bool table(uint16_t index, FlatTable* child) const {
    std::size_t target = 0;
    if (child == nullptr || !reference(index, &target)) return false;
    *child = {bytes, size, target};
    return true;
  }

  bool vector(uint16_t index, std::size_t element_width,
              std::size_t* data, uint32_t* count) const {
    std::size_t target = 0;
    if (element_width == 0 || !reference(index, &target) || !read(target, count)) return false;
    *data = target + sizeof(uint32_t);
    return *data <= size && *count <= (size - *data) / element_width;
  }

  bool vector_table(std::size_t data, uint32_t count, uint32_t index,
                    FlatTable* child) const {
    if (child == nullptr || index >= count || data > size ||
        static_cast<std::size_t>(index) > (size - data) / sizeof(uint32_t)) return false;
    const std::size_t slot = data + static_cast<std::size_t>(index) * sizeof(uint32_t);
    uint32_t relative = 0;
    if (!read(slot, &relative) || relative > size - slot || slot + relative >= size) return false;
    *child = {bytes, size, slot + relative};
    return true;
  }

  bool string_length(uint16_t index, uint32_t* length) const {
    std::size_t data = 0;
    return vector(index, 1, &data, length);
  }
};

bool slp_root(const uint8_t* bytes, std::size_t size, FlatTable* root) {
  if (bytes == nullptr || root == nullptr || size < 8 ||
      std::memcmp(bytes + 4, "$SLP", 4) != 0) return false;
  uint32_t root_offset = 0;
  std::memcpy(&root_offset, bytes, sizeof(root_offset));
  if (root_offset >= size) return false;
  *root = {bytes, size, root_offset};
  return true;
}

bool has_signed_problem_shape(const FlatTable& problem) {
  FlatTable attestation;
  uint32_t key_length = 0;
  uint32_t signature_count = 0;
  uint32_t json_signature_count = 0;
  std::size_t ignored = 0;
  return problem.table(12, &attestation) &&
         attestation.string_length(0, &key_length) && key_length == 64 &&
         attestation.vector(2, 1, &ignored, &signature_count) && signature_count == 64 &&
         attestation.vector(3, 1, &ignored, &json_signature_count) &&
         json_signature_count == 64;
}
#endif

sdn::sqp::Evaluation sqp_current;
sdn::sqp::Evaluation sqp_plus;
sdn::sqp::Derivatives sqp_derivatives;
sdn::sqp::Matrix sqp_hessian;
sdn::sqp::Vector sqp_multipliers;
std::vector<std::pair<bool, std::size_t>> sqp_active;
double sqp_original_merit = 0.0;
double sqp_kkt_residual = std::numeric_limits<double>::infinity();
double sqp_alpha = 1.0;
int sqp_line_search = 0;
constexpr double sqp_merit_penalty = 1.0e6;

int32_t evaluate_reference(const double* candidate, double* output) {
  if (!candidate || !output) return -1;
  constexpr double mu = 3.986004418e14;
  constexpr double perigee_radius = 6678136.3;
  constexpr double target_apogee = 42164000.0;
  constexpr double seconds_per_day = 86400.0;
  constexpr double radians_to_degrees = 180.0 / 3.14159265358979323846;
  const double circular_speed = std::sqrt(mu / perigee_radius);
  const double transfer_speed =
      std::sqrt(mu * (2.0 / perigee_radius -
                      2.0 / (perigee_radius + target_apogee)));
  const double angular_rate =
      std::sqrt(mu / (perigee_radius * perigee_radius * perigee_radius));
  const double phase = angular_rate * candidate[1];
  // A fixed inertial-attitude schedule yields a small cross-track component
  // away from the reference epoch. Epoch zero is purely tangential, so the
  // reference solution is exactly the closed-form Hohmann first burn.
  const double plane_angle = 0.12 * std::sin(phase);
  const double tangential_speed =
      circular_speed + candidate[0] * std::cos(plane_angle);
  const double normal_speed = candidate[0] * std::sin(plane_angle);
  const double speed_squared =
      tangential_speed * tangential_speed + normal_speed * normal_speed;
  const double specific_energy = 0.5 * speed_squared - mu / perigee_radius;
  if (!(specific_energy < 0.0) || !std::isfinite(specific_energy)) return -2;
  const double semi_major_axis = -mu / (2.0 * specific_energy);
  const double apogee_radius = 2.0 * semi_major_axis - perigee_radius;
  const double eccentricity =
      (apogee_radius - perigee_radius) / (apogee_radius + perigee_radius);
  const double signed_inclination = std::atan2(normal_speed, tangential_speed);
  const double inclination = std::fabs(signed_inclination);
  const double mean_motion =
      std::sqrt(mu / (semi_major_axis * semi_major_axis * semi_major_axis)) *
      seconds_per_day / (2.0 * 3.14159265358979323846);
  const double coast_seconds =
      3.14159265358979323846 *
      std::sqrt(semi_major_axis * semi_major_axis * semi_major_axis / mu);

  output[0] = apogee_radius / target_apogee;
  output[1] = signed_inclination;
  output[2] = apogee_radius;
  output[3] = mean_motion;
  output[4] = eccentricity;
  output[5] = inclination * radians_to_degrees;
  output[6] = std::fmod(phase * radians_to_degrees + 360.0, 360.0);
  output[7] = 0.0;
  output[8] = 0.0;
  output[9] = transfer_speed - circular_speed;
  output[10] = coast_seconds;
  return 0;
}

double fd_step(uint32_t index) {
  if (perturbations[index] > 0.0) return perturbations[index];
  return 1e-6 * std::max(1.0, std::fabs(controls[index])) + 1e-9;
}

double norm_residual(const hp::target::Vecd& candidate) {
  double sum = 0.0;
  for (uint32_t i = 0; i < settings.goal_count; ++i) {
    const double error = candidate[i] - desired[i];
    sum += error * error;
  }
  return std::sqrt(sum);
}

void set_terminal(OrbProSolverStatus status) {
  terminal.status = static_cast<uint8_t>(status);
  terminal.iteration_count = static_cast<uint32_t>(iterations.size());
  terminal.evaluation_count = evaluation_count;
  terminal.variable_count = settings.variable_count;
  terminal.value_count = settings.goal_count;
  for (uint32_t i = 0; i < settings.variable_count; ++i) terminal.variables[i] = controls[i];
  for (uint32_t i = 0; i < settings.goal_count; ++i) terminal.values[i] = values[i];
  terminal.residual_norm = residual_norm;
  phase = Phase::Done;
  request_pending = false;
}

void queue(Phase next, const hp::target::Vecd& candidate, OrbProSolverEvaluationKind kind) {
  std::memset(&request, 0, sizeof(request));
  request.request_id = ++request_id;
  request.kind = static_cast<uint8_t>(kind);
  request.variable_count = settings.variable_count;
  for (uint32_t i = 0; i < settings.variable_count; ++i) request.variables[i] = candidate[i];
  phase = next;
  request_pending = true;
  terminal.status = ORBPRO_SOLVER_STATUS_NEEDS_EVALUATION;
}

void queue_jacobian_column() {
  hp::target::Vecd candidate = controls;
  candidate[column] += fd_step(column);
  queue(Phase::Plus, candidate, ORBPRO_SOLVER_EVALUATE_VALUES);
}

void record_iteration(const hp::target::Vecd& candidate,
                      const hp::target::Vecd& achieved,
                      bool accepted) {
  OrbProSolverIteration report{};
  report.iteration = static_cast<uint32_t>(iterations.size() + 1);
  report.evaluation_count = evaluation_count;
  report.variable_count = settings.variable_count;
  report.goal_count = settings.goal_count;
  for (uint32_t i = 0; i < settings.variable_count; ++i) report.variables[i] = candidate[i];
  for (uint32_t i = 0; i < settings.goal_count; ++i) report.values[i] = achieved[i];
  report.residual_norm = norm_residual(achieved);
  report.step_norm = hp::target::norm2(pending_step);
  report.jacobian_condition = hp::target::conditionEstimate(jacobian);
  report.accepted = accepted ? 1 : 0;
  iterations.push_back(report);
}

bool queue_newton_step() {
  hp::target::Vecd residual(settings.goal_count, 0.0);
  for (uint32_t i = 0; i < settings.goal_count; ++i) residual[i] = values[i] - desired[i];
  if (!hp::target::leastSquaresStep(jacobian, residual, damping, pending_step)) {
    set_terminal(ORBPRO_SOLVER_STATUS_SINGULAR_JACOBIAN);
    return false;
  }
  trial_controls = controls;
  for (uint32_t i = 0; i < settings.variable_count; ++i) {
    trial_controls[i] = std::max(lower_bounds[i],
                                 std::min(upper_bounds[i], controls[i] + pending_step[i]));
    pending_step[i] = trial_controls[i] - controls[i];
  }
  if (hp::target::norm2(pending_step) <= settings.step_tolerance) {
    set_terminal(ORBPRO_SOLVER_STATUS_STALLED);
    return false;
  }
  queue(Phase::Trial, trial_controls,
        settings.difference_mode == ORBPRO_SOLVER_DIFFERENCE_ANALYTIC_STM
            ? ORBPRO_SOLVER_EVALUATE_VALUES_AND_JACOBIAN
            : ORBPRO_SOLVER_EVALUATE_VALUES);
  return true;
}

bool accept_evaluation(const OrbProSolverEvaluation* evaluation) {
  return evaluation != nullptr && evaluation->valid != 0 &&
         evaluation->goal_count == settings.goal_count &&
         evaluation->request_id == request.request_id;
}

hp::target::Vecd supplied_values(const OrbProSolverEvaluation* evaluation) {
  hp::target::Vecd result(settings.goal_count, 0.0);
  for (uint32_t i = 0; i < settings.goal_count; ++i) result[i] = evaluation->goals[i];
  return result;
}

bool read_analytic_jacobian(const OrbProSolverEvaluation* evaluation) {
  if (evaluation->jacobian_rows != settings.goal_count ||
      evaluation->jacobian_columns != settings.variable_count) return false;
  jacobian.assign(settings.goal_count, hp::target::Vecd(settings.variable_count, 0.0));
  for (uint32_t row = 0; row < settings.goal_count; ++row) {
    for (uint32_t col = 0; col < settings.variable_count; ++col) {
      jacobian[row][col] = evaluation->jacobian[row * settings.variable_count + col];
    }
  }
  return true;
}

bool optimizing() { return settings.algorithm == ORBPRO_SOLVER_SQP; }

sdn::sqp::Evaluation supplied_sqp_evaluation(
    const OrbProSolverEvaluation* evaluation) {
  sdn::sqp::Evaluation result;
  const uint32_t expected_constraints =
      settings.equality_constraint_count + settings.inequality_constraint_count;
  if (evaluation == nullptr || evaluation->valid == 0 ||
      evaluation->goal_count != 0 ||
      evaluation->constraint_count != expected_constraints) {
    return result;
  }
  result.objective = evaluation->objective;
  result.equalities.assign(
      evaluation->constraints,
      evaluation->constraints + settings.equality_constraint_count);
  result.inequalities.assign(
      evaluation->constraints + settings.equality_constraint_count,
      evaluation->constraints + expected_constraints);
  result.valid = true;
  return result;
}

void set_sqp_terminal(OrbProSolverStatus status) {
  terminal.status = static_cast<uint8_t>(status);
  terminal.iteration_count = static_cast<uint32_t>(iterations.size());
  terminal.evaluation_count = evaluation_count;
  terminal.variable_count = settings.variable_count;
  terminal.value_count =
      settings.equality_constraint_count + settings.inequality_constraint_count;
  for (uint32_t i = 0; i < settings.variable_count; ++i) {
    terminal.variables[i] = controls[i];
  }
  uint32_t value = 0;
  for (double equality : sqp_current.equalities) terminal.values[value++] = equality;
  for (double inequality : sqp_current.inequalities) terminal.values[value++] = inequality;
  terminal.objective = sqp_current.objective;
  terminal.residual_norm = sdn::sqp::violation(sqp_current);
  terminal.maximum_constraint_violation = terminal.residual_norm;
  terminal.kkt_residual = sqp_kkt_residual;
  phase = Phase::Done;
  request_pending = false;
}

void queue_sqp_column() {
  sdn::sqp::Vector candidate = controls;
  candidate[column] += fd_step(column);
  queue(Phase::Plus, candidate, ORBPRO_SOLVER_EVALUATE_VALUES);
}

void record_sqp_iteration(const sdn::sqp::Vector& candidate,
                          const sdn::sqp::Evaluation& evaluation,
                          bool accepted) {
  OrbProSolverIteration report{};
  report.iteration = static_cast<uint32_t>(iterations.size() + 1);
  report.evaluation_count = evaluation_count;
  report.variable_count = settings.variable_count;
  report.goal_count =
      settings.equality_constraint_count + settings.inequality_constraint_count;
  for (uint32_t i = 0; i < settings.variable_count; ++i) {
    report.variables[i] = candidate[i];
  }
  uint32_t value = 0;
  for (double equality : evaluation.equalities) report.values[value++] = equality;
  for (double inequality : evaluation.inequalities) report.values[value++] = inequality;
  report.residual_norm = sdn::sqp::violation(evaluation);
  report.step_norm = hp::target::norm2(pending_step) * sqp_alpha;
  report.maximum_constraint_violation = report.residual_norm;
  report.kkt_residual = sqp_kkt_residual;
  report.accepted = accepted ? 1 : 0;
  iterations.push_back(report);
}

bool prepare_sqp_step() {
  const std::size_t n = controls.size();
  sqp_active.clear();
  sdn::sqp::Vector active_values;
  for (std::size_t row = 0; row < sqp_current.equalities.size(); ++row) {
    sqp_active.push_back({true, row});
    active_values.push_back(sqp_current.equalities[row]);
  }
  for (std::size_t row = 0; row < sqp_current.inequalities.size(); ++row) {
    if (sqp_current.inequalities[row] >= -1e-5) {
      sqp_active.push_back({false, row});
      active_values.push_back(sqp_current.inequalities[row]);
    }
  }

  const std::size_t k = sqp_active.size();
  sdn::sqp::Matrix kkt(n + k, sdn::sqp::Vector(n + k, 0.0));
  sdn::sqp::Vector rhs(n + k, 0.0);
  for (std::size_t row = 0; row < n; ++row) {
    rhs[row] = -sqp_derivatives.objective[row];
    for (std::size_t col = 0; col < n; ++col) {
      kkt[row][col] = sqp_hessian[row][col];
    }
  }
  for (std::size_t constraint = 0; constraint < k; ++constraint) {
    const auto& gradient = sqp_active[constraint].first
                               ? sqp_derivatives.equalities[sqp_active[constraint].second]
                               : sqp_derivatives.inequalities[sqp_active[constraint].second];
    rhs[n + constraint] = -active_values[constraint];
    for (std::size_t col = 0; col < n; ++col) {
      kkt[col][n + constraint] = gradient[col];
      kkt[n + constraint][col] = gradient[col];
    }
  }

  sdn::sqp::Vector solution;
  bool solved = sdn::sqp::solveLinear(kkt, rhs, solution);
  if (!solved) {
    for (std::size_t i = 0; i < n; ++i) kkt[i][i] += 1e-8;
    solved = sdn::sqp::solveLinear(kkt, rhs, solution);
  }
  if (!solved) {
    set_sqp_terminal(
        sdn::sqp::violation(sqp_current) > settings.constraint_tolerance
            ? ORBPRO_SOLVER_STATUS_INFEASIBLE
            : ORBPRO_SOLVER_STATUS_SINGULAR_JACOBIAN);
    return false;
  }

  pending_step.assign(solution.begin(), solution.begin() + n);
  sqp_multipliers.assign(solution.begin() + n, solution.end());
  sqp_kkt_residual = sdn::sqp::normInf(
      sdn::sqp::lagrangianGradient(
          sqp_derivatives, sqp_active, sqp_multipliers));
  const double violation = sdn::sqp::violation(sqp_current);
  if (violation <= settings.constraint_tolerance &&
      sqp_kkt_residual <= settings.kkt_tolerance) {
    set_sqp_terminal(ORBPRO_SOLVER_STATUS_CONVERGED);
    return false;
  }

  sqp_original_merit = sdn::sqp::merit(sqp_current, sqp_merit_penalty);
  sqp_alpha = 1.0;
  sqp_line_search = 0;
  trial_controls = controls;
  for (std::size_t i = 0; i < n; ++i) {
    trial_controls[i] = std::max(
        lower_bounds[i],
        std::min(upper_bounds[i], controls[i] + pending_step[i]));
  }
  queue(Phase::Trial, trial_controls, ORBPRO_SOLVER_EVALUATE_VALUES);
  return true;
}

int32_t supply_sqp(const OrbProSolverEvaluation* evaluation) {
  const sdn::sqp::Evaluation supplied = supplied_sqp_evaluation(evaluation);
  if (!sdn::sqp::finite(supplied)) {
    set_sqp_terminal(ORBPRO_SOLVER_STATUS_EVALUATION_FAILED);
    return ORBPRO_SOLVER_STATUS_EVALUATION_FAILED;
  }

  if (phase == Phase::Base) {
    sqp_current = supplied;
    column = 0;
    sqp_derivatives.objective.assign(settings.variable_count, 0.0);
    sqp_derivatives.equalities.assign(
        settings.equality_constraint_count,
        sdn::sqp::Vector(settings.variable_count, 0.0));
    sqp_derivatives.inequalities.assign(
        settings.inequality_constraint_count,
        sdn::sqp::Vector(settings.variable_count, 0.0));
    sqp_derivatives.valid = false;
    queue_sqp_column();
    return terminal.status;
  }

  if (phase == Phase::Plus) {
    if (settings.difference_mode == ORBPRO_SOLVER_DIFFERENCE_CENTRAL) {
      sqp_plus = supplied;
      sdn::sqp::Vector candidate = controls;
      candidate[column] -= fd_step(column);
      queue(Phase::Minus, candidate, ORBPRO_SOLVER_EVALUATE_VALUES);
      return terminal.status;
    }
    const double divisor = fd_step(column);
    sqp_derivatives.objective[column] =
        (supplied.objective - sqp_current.objective) / divisor;
    for (uint32_t row = 0; row < settings.equality_constraint_count; ++row) {
      sqp_derivatives.equalities[row][column] =
          (supplied.equalities[row] - sqp_current.equalities[row]) / divisor;
    }
    for (uint32_t row = 0; row < settings.inequality_constraint_count; ++row) {
      sqp_derivatives.inequalities[row][column] =
          (supplied.inequalities[row] - sqp_current.inequalities[row]) / divisor;
    }
  } else if (phase == Phase::Minus) {
    const double divisor = 2.0 * fd_step(column);
    sqp_derivatives.objective[column] =
        (sqp_plus.objective - supplied.objective) / divisor;
    for (uint32_t row = 0; row < settings.equality_constraint_count; ++row) {
      sqp_derivatives.equalities[row][column] =
          (sqp_plus.equalities[row] - supplied.equalities[row]) / divisor;
    }
    for (uint32_t row = 0; row < settings.inequality_constraint_count; ++row) {
      sqp_derivatives.inequalities[row][column] =
          (sqp_plus.inequalities[row] - supplied.inequalities[row]) / divisor;
    }
  } else if (phase == Phase::Trial) {
    const double directional =
        sdn::sqp::dot(sqp_derivatives.objective, pending_step);
    const bool accepted =
        sdn::sqp::merit(supplied, sqp_merit_penalty) <=
        sqp_original_merit - 1e-4 * sqp_alpha * directional;
    record_sqp_iteration(trial_controls, supplied, accepted);
    if (accepted) {
      controls = trial_controls;
      sqp_current = supplied;
      if (iterations.size() >= settings.maximum_iterations) {
        set_sqp_terminal(ORBPRO_SOLVER_STATUS_BUDGET_EXCEEDED);
        return terminal.status;
      }
      column = 0;
      queue_sqp_column();
      return terminal.status;
    }
    if (++sqp_line_search >= 30) {
      set_sqp_terminal(
          sdn::sqp::violation(sqp_current) > settings.constraint_tolerance
              ? ORBPRO_SOLVER_STATUS_INFEASIBLE
              : ORBPRO_SOLVER_STATUS_STALLED);
      return terminal.status;
    }
    sqp_alpha *= 0.5;
    trial_controls = controls;
    for (uint32_t i = 0; i < settings.variable_count; ++i) {
      trial_controls[i] = std::max(
          lower_bounds[i],
          std::min(upper_bounds[i], controls[i] + sqp_alpha * pending_step[i]));
    }
    queue(Phase::Trial, trial_controls, ORBPRO_SOLVER_EVALUATE_VALUES);
    return terminal.status;
  }

  if (phase == Phase::Plus || phase == Phase::Minus) {
    if (++column < settings.variable_count) {
      queue_sqp_column();
    } else {
      sqp_derivatives.valid = true;
      prepare_sqp_step();
    }
  }
  return terminal.status;
}

}  // namespace

extern "C" {

// Reference evaluator used by the gallery through the evaluator/propagator
// port. It is deliberately an export, not solver internals: the host may
// replace it with any provider implementing the same two-goal mapping.
//
// controls[0] = burn magnitude [m/s]
// controls[1] = burn epoch offset [s]
// output       = [apogee/GEO, inclination rad, apogee m, mean motion rev/day,
//                 eccentricity, inclination deg, RAAN deg, arg-perigee deg,
//                 mean anomaly deg, Hohmann delta-v m/s, coast time s]
__attribute__((visibility("default")))
TARGETING_WASM_EXPORT("plugin_reference_evaluate")
int32_t plugin_reference_evaluate(const double* candidate, double* output) {
  return evaluate_reference(candidate, output);
}

// Prepare a post-impulse inertial state for whichever propagator port the
// caller selected. output = [r_km(3), v_km_s(3), coast_seconds, hohmann_dv].
// The host only transports these values into the selected port; all orbital
// equations remain in this WASM module.
__attribute__((visibility("default")))
TARGETING_WASM_EXPORT("plugin_reference_prepare")
int32_t plugin_reference_prepare(const double* candidate, double* output) {
  if (!candidate || !output) return -1;
  constexpr double mu = 3.986004418e14;
  constexpr double perigee_radius = 6678136.3;
  constexpr double target_apogee = 42164000.0;
  constexpr double pi = 3.14159265358979323846;
  const double circular_speed = std::sqrt(mu / perigee_radius);
  const double transfer_speed =
      std::sqrt(mu * (2.0 / perigee_radius -
                      2.0 / (perigee_radius + target_apogee)));
  const double angular_rate =
      std::sqrt(mu / (perigee_radius * perigee_radius * perigee_radius));
  const double plane_angle = 0.12 * std::sin(angular_rate * candidate[1]);
  const double tangential_speed =
      circular_speed + candidate[0] * std::cos(plane_angle);
  const double normal_speed = candidate[0] * std::sin(plane_angle);
  const double speed_squared = tangential_speed * tangential_speed +
                               normal_speed * normal_speed;
  const double specific_energy = 0.5 * speed_squared - mu / perigee_radius;
  if (!(specific_energy < 0.0) || !std::isfinite(specific_energy)) return -2;
  const double semi_major_axis = -mu / (2.0 * specific_energy);

  output[0] = perigee_radius / 1000.0;
  output[1] = 0.0;
  output[2] = 0.0;
  output[3] = 0.0;
  output[4] = tangential_speed / 1000.0;
  output[5] = normal_speed / 1000.0;
  output[6] = pi * std::sqrt(
                       semi_major_axis * semi_major_axis * semi_major_axis / mu);
  output[7] = transfer_speed - circular_speed;
  return 0;
}

// Consume the state returned by the selected propagator port. The port's
// common browser contract returns ECEF metres and metres/second followed by
// the UTC Julian date. The targeting module performs the complete ECEF->GCRF
// state conversion in WASM before evaluating inertial goals; the host only
// transports the provider's answer.
__attribute__((visibility("default")))
TARGETING_WASM_EXPORT("plugin_reference_finish")
int32_t plugin_reference_finish(const double* candidate,
                                const double* propagated_state,
                                double* output) {
  if (!candidate || !propagated_state || !output) return -1;
  const int32_t status = evaluate_reference(candidate, output);
  if (status != 0) return status;
  constexpr double target_apogee = 42164000.0;
  const coords::StateVec ecef(
      {propagated_state[0] / 1000.0, propagated_state[1] / 1000.0,
       propagated_state[2] / 1000.0},
      {propagated_state[3] / 1000.0, propagated_state[4] / 1000.0,
       propagated_state[5] / 1000.0});
  const coords::StateVec gcrf = coords::transform(
      ecef, coords::Frame::ECEF, coords::Frame::GCRF, propagated_state[6]);
  const double x = gcrf.position.x * 1000.0;
  const double y = gcrf.position.y * 1000.0;
  const double z = gcrf.position.z * 1000.0;
  const double vx = gcrf.velocity.x * 1000.0;
  const double vy = gcrf.velocity.y * 1000.0;
  const double vz = gcrf.velocity.z * 1000.0;
  const double hx = y * vz - z * vy;
  const double hy = z * vx - x * vz;
  const double hz = x * vy - y * vx;
  const double radius = std::sqrt(x * x + y * y + z * z);
  const double h = std::sqrt(hx * hx + hy * hy + hz * hz);
  if (!(radius > 0.0) || !(h > 0.0) || !std::isfinite(radius) ||
      !std::isfinite(h)) return -3;
  const double cosine = std::max(-1.0, std::min(1.0, hz / h));
  const double inclination_sign = output[1] < 0.0 ? -1.0 : 1.0;
  output[0] = radius / target_apogee;
  output[1] = inclination_sign * std::acos(cosine);
  output[2] = radius;
  output[5] = output[1] * 180.0 / 3.14159265358979323846;
  return 0;
}

// Convert a propagated target evaluation into the generic objective and
// nonlinear-constraint vector. output = [objective, equality apogee,
// equality inclination, inequality coast-time-20000s].
__attribute__((visibility("default")))
TARGETING_WASM_EXPORT("plugin_reference_sqp_finish")
int32_t plugin_reference_sqp_finish(const double* candidate,
                                    const double* propagated_evaluation,
                                    double* output) {
  if (!candidate || !propagated_evaluation || !output) return -1;
  output[0] = candidate[0];
  output[1] = propagated_evaluation[0] - 1.0;
  output[2] = propagated_evaluation[1];
  output[3] = propagated_evaluation[10] - 20000.0;
  return 0;
}

// Reference objective/nonlinear-constraint provider for the reverse-
// communication SQP surface. output = [objective, equality apogee,
// equality inclination, inequality coast-time-20000s]. A caller may replace this
// export with any evaluator port that returns the same generic shape.
__attribute__((visibility("default")))
TARGETING_WASM_EXPORT("plugin_reference_sqp_evaluate")
int32_t plugin_reference_sqp_evaluate(const double* candidate, double* output) {
  if (!candidate || !output) return -1;
  double state[11]{};
  const int32_t status = evaluate_reference(candidate, state);
  if (status != 0) return status;
  output[0] = candidate[0];
  output[1] = state[0] - 1.0;
  output[2] = state[1];
  output[3] = state[10] - 20000.0;
  return 0;
}

// Deliberately inconsistent nonlinear constraints used to prove that the
// generic SQP surface reports infeasibility rather than manufacturing a
// solution. Both constraints use the solver convention g(x) <= 0:
// x >= 2400 and x <= 2300 cannot hold simultaneously.
__attribute__((visibility("default")))
TARGETING_WASM_EXPORT("plugin_reference_sqp_infeasible_evaluate")
int32_t plugin_reference_sqp_infeasible_evaluate(const double* candidate,
                                                 double* output) {
  if (!candidate || !output) return -1;
  output[0] = candidate[0];
  output[1] = 2400.0 - candidate[0];
  output[2] = candidate[0] - 2300.0;
  return 0;
}

__attribute__((visibility("default")))
TARGETING_WASM_EXPORT("plugin_solver_configure")
int32_t plugin_solver_configure(const OrbProSolverSettings* input,
                                const double* initial_variables,
                                const double* lowers,
                                const double* uppers,
                                const double* desired_values,
                                const double* steps) {
  if (!input || !initial_variables || !lowers || !uppers || !steps ||
      input->variable_count == 0 ||
      input->variable_count > ORBPRO_SOLVER_MAX_DIMENSION ||
      input->goal_count > ORBPRO_SOLVER_MAX_DIMENSION ||
      input->equality_constraint_count + input->inequality_constraint_count >
          ORBPRO_SOLVER_MAX_DIMENSION ||
      input->algorithm > ORBPRO_SOLVER_SQP ||
      (input->algorithm == ORBPRO_SOLVER_SQP &&
       (input->goal_count != 0 ||
        input->difference_mode == ORBPRO_SOLVER_DIFFERENCE_ANALYTIC_STM)) ||
      (input->algorithm != ORBPRO_SOLVER_SQP &&
       (input->goal_count == 0 || desired_values == nullptr))) {
    return ORBPRO_SOLVER_STATUS_INVALID_PROBLEM;
  }
  settings = *input;
  controls.assign(initial_variables, initial_variables + settings.variable_count);
  lower_bounds.assign(lowers, lowers + settings.variable_count);
  upper_bounds.assign(uppers, uppers + settings.variable_count);
  desired.clear();
  if (settings.goal_count > 0) {
    desired.assign(desired_values, desired_values + settings.goal_count);
  }
  perturbations.assign(steps, steps + settings.variable_count);
  for (uint32_t i = 0; i < settings.variable_count; ++i) {
    if (!(lower_bounds[i] <= controls[i] && controls[i] <= upper_bounds[i])) {
      return ORBPRO_SOLVER_STATUS_INVALID_PROBLEM;
    }
  }
  std::memset(&terminal, 0, sizeof(terminal));
  sqp_hessian.assign(
      settings.variable_count,
      sdn::sqp::Vector(settings.variable_count, 0.0));
  for (uint32_t i = 0; i < settings.variable_count; ++i) {
    sqp_hessian[i][i] = 1.0;
  }
  terminal.status = ORBPRO_SOLVER_STATUS_IDLE;
  phase = Phase::Idle;
  return ORBPRO_SOLVER_STATUS_IDLE;
}

__attribute__((visibility("default")))
TARGETING_WASM_EXPORT("plugin_solver_begin")
int32_t plugin_solver_begin(void) {
  if (controls.empty()) return ORBPRO_SOLVER_STATUS_INVALID_PROBLEM;
  values.clear();
  iterations.clear();
  evaluation_count = 0;
  request_id = 0;
  residual_norm = std::numeric_limits<double>::infinity();
  damping = 1e-10;
  rejected_steps = 0;
  sqp_current = sdn::sqp::Evaluation{};
  sqp_kkt_residual = std::numeric_limits<double>::infinity();
  queue(Phase::Base, controls,
        settings.difference_mode == ORBPRO_SOLVER_DIFFERENCE_ANALYTIC_STM
            ? ORBPRO_SOLVER_EVALUATE_VALUES_AND_JACOBIAN
            : ORBPRO_SOLVER_EVALUATE_VALUES);
  return ORBPRO_SOLVER_STATUS_NEEDS_EVALUATION;
}

__attribute__((visibility("default")))
TARGETING_WASM_EXPORT("plugin_solver_next")
int32_t plugin_solver_next(OrbProSolverEvaluationRequest* output) {
  if (!output) return -1;
  if (!request_pending) return 0;
  *output = request;
  request_pending = false;
  return 1;
}

__attribute__((visibility("default")))
TARGETING_WASM_EXPORT("plugin_solver_supply")
int32_t plugin_solver_supply(const OrbProSolverEvaluation* evaluation) {
  if (!accept_evaluation(evaluation)) {
    if (optimizing()) set_sqp_terminal(ORBPRO_SOLVER_STATUS_EVALUATION_FAILED);
    else set_terminal(ORBPRO_SOLVER_STATUS_EVALUATION_FAILED);
    return ORBPRO_SOLVER_STATUS_EVALUATION_FAILED;
  }
  ++evaluation_count;
  if (evaluation_count > settings.maximum_evaluations) {
    if (optimizing()) set_sqp_terminal(ORBPRO_SOLVER_STATUS_BUDGET_EXCEEDED);
    else set_terminal(ORBPRO_SOLVER_STATUS_BUDGET_EXCEEDED);
    return ORBPRO_SOLVER_STATUS_BUDGET_EXCEEDED;
  }
  if (optimizing()) return supply_sqp(evaluation);
  const hp::target::Vecd supplied = supplied_values(evaluation);

  if (phase == Phase::Base) {
    values = supplied;
    residual_norm = norm_residual(values);
    if (residual_norm <= settings.residual_tolerance) {
      set_terminal(ORBPRO_SOLVER_STATUS_CONVERGED);
      return ORBPRO_SOLVER_STATUS_CONVERGED;
    }
    if (settings.difference_mode == ORBPRO_SOLVER_DIFFERENCE_ANALYTIC_STM) {
      if (!read_analytic_jacobian(evaluation)) {
        set_terminal(ORBPRO_SOLVER_STATUS_EVALUATION_FAILED);
        return ORBPRO_SOLVER_STATUS_EVALUATION_FAILED;
      }
      queue_newton_step();
    } else {
      column = 0;
      jacobian.assign(settings.goal_count, hp::target::Vecd(settings.variable_count, 0.0));
      queue_jacobian_column();
    }
    return terminal.status;
  }

  if (phase == Phase::Plus) {
    if (settings.difference_mode == ORBPRO_SOLVER_DIFFERENCE_CENTRAL) {
      plus_values = supplied;
      hp::target::Vecd candidate = controls;
      candidate[column] -= fd_step(column);
      queue(Phase::Minus, candidate, ORBPRO_SOLVER_EVALUATE_VALUES);
      return terminal.status;
    }
    const double h = fd_step(column);
    for (uint32_t row = 0; row < settings.goal_count; ++row) {
      jacobian[row][column] = (supplied[row] - values[row]) / h;
    }
  } else if (phase == Phase::Minus) {
    const double h = fd_step(column);
    for (uint32_t row = 0; row < settings.goal_count; ++row) {
      jacobian[row][column] = (plus_values[row] - supplied[row]) / (2.0 * h);
    }
  } else if (phase == Phase::Trial) {
    if (settings.difference_mode == ORBPRO_SOLVER_DIFFERENCE_ANALYTIC_STM &&
        !read_analytic_jacobian(evaluation)) {
      set_terminal(ORBPRO_SOLVER_STATUS_EVALUATION_FAILED);
      return ORBPRO_SOLVER_STATUS_EVALUATION_FAILED;
    }
    const double candidate_norm = norm_residual(supplied);
    const bool accepted = candidate_norm < residual_norm;
    record_iteration(trial_controls, supplied, accepted);
    if (accepted) {
      if (settings.difference_mode != ORBPRO_SOLVER_DIFFERENCE_ANALYTIC_STM &&
          settings.algorithm != ORBPRO_SOLVER_NEWTON_RAPHSON) {
        hp::target::updateBroyden(
            jacobian, pending_step, values, supplied,
            settings.algorithm == ORBPRO_SOLVER_MODIFIED_BROYDEN);
      }
      controls = trial_controls;
      values = supplied;
      residual_norm = candidate_norm;
      rejected_steps = 0;
      damping = std::max(1e-18, damping * 0.25);
      if (residual_norm <= settings.residual_tolerance) {
        set_terminal(ORBPRO_SOLVER_STATUS_CONVERGED);
        return ORBPRO_SOLVER_STATUS_CONVERGED;
      }
      if (iterations.size() >= settings.maximum_iterations) {
        set_terminal(ORBPRO_SOLVER_STATUS_BUDGET_EXCEEDED);
        return ORBPRO_SOLVER_STATUS_BUDGET_EXCEEDED;
      }
      if (settings.difference_mode == ORBPRO_SOLVER_DIFFERENCE_ANALYTIC_STM ||
          settings.algorithm != ORBPRO_SOLVER_NEWTON_RAPHSON) {
        queue_newton_step();
      } else {
        column = 0;
        queue_jacobian_column();
      }
      return terminal.status;
    }
    if (++rejected_steps >= 12) {
      set_terminal(ORBPRO_SOLVER_STATUS_STALLED);
      return ORBPRO_SOLVER_STATUS_STALLED;
    }
    for (double& component : pending_step) component *= 0.5;
    trial_controls = controls;
    for (uint32_t i = 0; i < settings.variable_count; ++i) {
      trial_controls[i] += pending_step[i];
    }
    queue(Phase::Trial, trial_controls,
          settings.difference_mode == ORBPRO_SOLVER_DIFFERENCE_ANALYTIC_STM
              ? ORBPRO_SOLVER_EVALUATE_VALUES_AND_JACOBIAN
              : ORBPRO_SOLVER_EVALUATE_VALUES);
    return terminal.status;
  }

  if (phase == Phase::Plus || phase == Phase::Minus) {
    if (++column < settings.variable_count) queue_jacobian_column();
    else queue_newton_step();
  }
  return terminal.status;
}

__attribute__((visibility("default")))
TARGETING_WASM_EXPORT("plugin_solver_result")
int32_t plugin_solver_result(OrbProSolverResult* output) {
  if (!output) return -1;
  *output = terminal;
  return terminal.status;
}

__attribute__((visibility("default")))
TARGETING_WASM_EXPORT("plugin_solver_iteration")
int32_t plugin_solver_iteration(uint32_t index, OrbProSolverIteration* output) {
  if (!output || index >= iterations.size()) return -1;
  *output = iterations[index];
  return 0;
}

#if TARGETING_HAS_INVOKE_SUPPORT
// Typed entry seam. A successful call validates the bounded SLP shape and
// configures the reverse pull/supply session. Cryptographic trust verification
// remains the invoking host's responsibility; this guest requires both signed
// representations to be present and never receives signing keys.
__attribute__((visibility("default")))
int solve(void) {
  plugin_reset_output_state();
  const plugin_input_frame_t* frame = find_problem_frame();
  FlatTable problem;
  if (frame == nullptr || !slp_root(frame->payload, frame->payload_length, &problem)) {
    plugin_set_error("invalid-problem-buffer", "A valid signed SLP problem frame is required.");
    return 1;
  }
  uint32_t problem_id_length = 0;
  uint32_t propagator_port_length = 0;
  if (!problem.string_length(0, &problem_id_length) || problem_id_length == 0 ||
      !problem.string_length(3, &propagator_port_length) || propagator_port_length == 0 ||
      !has_signed_problem_shape(problem)) {
    plugin_set_error("unsigned-problem", "SLP identity, propagator port, and both signatures are required.");
    return 1;
  }

  std::size_t variables_data = 0;
  uint32_t variable_count = 0;
  FlatTable record_settings;
  if (!problem.vector(5, sizeof(uint32_t), &variables_data, &variable_count) ||
      variable_count == 0 || variable_count > ORBPRO_SOLVER_MAX_DIMENSION ||
      !problem.table(9, &record_settings)) {
    plugin_set_error("invalid-problem-shape", "SLP variables and settings must fit the fixed solver ABI.");
    return 1;
  }

  uint8_t algorithm = 0;
  uint8_t difference_mode = 0;
  uint8_t problem_kind = 0;
  OrbProSolverSettings decoded{};
  if (!record_settings.scalar<uint8_t>(0, 0, &algorithm) || algorithm < 1 || algorithm > 4 ||
      !record_settings.scalar<uint8_t>(1, 0, &difference_mode) ||
      difference_mode < 1 || difference_mode > 3 ||
      !problem.scalar<uint8_t>(2, 0, &problem_kind)) {
    plugin_set_error("invalid-solver-settings", "SLP must select a supported solver and Jacobian mode.");
    return 1;
  }
  decoded.algorithm = algorithm - 1;
  decoded.difference_mode = difference_mode - 1;
  decoded.variable_count = variable_count;
  if (!record_settings.scalar<uint32_t>(2, 50, &decoded.maximum_iterations) ||
      !record_settings.scalar<uint32_t>(3, 1000, &decoded.maximum_evaluations) ||
      !record_settings.scalar<double>(4, 1e-9, &decoded.residual_tolerance) ||
      !record_settings.scalar<double>(5, 1e-12, &decoded.step_tolerance) ||
      !record_settings.scalar<double>(7, 1e-8, &decoded.constraint_tolerance) ||
      !record_settings.scalar<double>(8, 1e-6, &decoded.kkt_tolerance) ||
      decoded.maximum_iterations == 0 || decoded.maximum_evaluations == 0 ||
      !(decoded.residual_tolerance > 0.0) || !(decoded.step_tolerance > 0.0) ||
      !(decoded.constraint_tolerance > 0.0) || !(decoded.kkt_tolerance > 0.0)) {
    plugin_set_error("invalid-solver-settings", "SLP iteration budgets and tolerances must be positive.");
    return 1;
  }
  const bool target_problem = problem_kind == 1;
  const bool optimize_problem = problem_kind == 2;
  if ((!target_problem && !optimize_problem) ||
      (target_problem && decoded.algorithm == ORBPRO_SOLVER_SQP) ||
      (optimize_problem && decoded.algorithm != ORBPRO_SOLVER_SQP)) {
    plugin_set_error("problem-algorithm-mismatch", "SLP kind and solver algorithm do not agree.");
    return 1;
  }

  std::vector<double> initial(variable_count);
  std::vector<double> lowers(variable_count);
  std::vector<double> uppers(variable_count);
  std::vector<double> steps(variable_count);
  for (uint32_t index = 0; index < variable_count; ++index) {
    FlatTable variable;
    double scale = 1.0;
    if (!problem.vector_table(variables_data, variable_count, index, &variable) ||
        !variable.scalar<double>(3, 0.0, &initial[index]) ||
        !variable.scalar<double>(4, -std::numeric_limits<double>::max(), &lowers[index]) ||
        !variable.scalar<double>(5, std::numeric_limits<double>::max(), &uppers[index]) ||
        !variable.scalar<double>(6, 0.0, &steps[index]) ||
        !variable.scalar<double>(7, 1.0, &scale) || scale != 1.0 ||
        !std::isfinite(initial[index]) || !std::isfinite(lowers[index]) ||
        !std::isfinite(uppers[index]) || !std::isfinite(steps[index])) {
      plugin_set_error("invalid-variable", "SLP variables must be finite and use the direct ABI scale.");
      return 1;
    }
  }

  std::vector<double> desired_values;
  if (target_problem) {
    std::size_t goals_data = 0;
    uint32_t goal_count = 0;
    if (!problem.vector(6, sizeof(uint32_t), &goals_data, &goal_count) ||
        goal_count == 0 || goal_count > ORBPRO_SOLVER_MAX_DIMENSION) {
      plugin_set_error("invalid-goals", "A target SLP must declare goals within the fixed ABI limit.");
      return 1;
    }
    decoded.goal_count = goal_count;
    desired_values.resize(goal_count);
    for (uint32_t index = 0; index < goal_count; ++index) {
      FlatTable goal;
      double scale = 1.0;
      if (!problem.vector_table(goals_data, goal_count, index, &goal) ||
          !goal.scalar<double>(3, 0.0, &desired_values[index]) ||
          !goal.scalar<double>(5, 1.0, &scale) || scale != 1.0 ||
          !std::isfinite(desired_values[index])) {
        plugin_set_error("invalid-goal", "SLP goals must be finite and use the direct ABI scale.");
        return 1;
      }
    }
  } else {
    FlatTable objective;
    uint8_t direction = 0;
    if (!problem.table(7, &objective) ||
        !objective.scalar<uint8_t>(3, 0, &direction) || direction != 1) {
      plugin_set_error("invalid-objective", "The open SQP ABI requires one minimization objective.");
      return 1;
    }
    std::size_t constraints_data = 0;
    uint32_t constraint_count = 0;
    if (problem.vector(8, sizeof(uint32_t), &constraints_data, &constraint_count)) {
      for (uint32_t index = 0; index < constraint_count; ++index) {
        FlatTable constraint;
        uint8_t relation = 0;
        if (!problem.vector_table(constraints_data, constraint_count, index, &constraint) ||
            !constraint.scalar<uint8_t>(3, 0, &relation)) {
          plugin_set_error("invalid-constraint", "SLP contains an invalid nonlinear constraint.");
          return 1;
        }
        if (relation == 1) ++decoded.equality_constraint_count;
        else if (relation == 2 || relation == 3) ++decoded.inequality_constraint_count;
        else {
          plugin_set_error("unsupported-constraint", "The fixed ABI admits equality or one-sided constraints.");
          return 1;
        }
      }
    }
    if (decoded.equality_constraint_count + decoded.inequality_constraint_count >
        ORBPRO_SOLVER_MAX_DIMENSION) {
      plugin_set_error("too-many-constraints", "SLP constraints exceed the fixed solver ABI.");
      return 1;
    }
  }

  const int32_t configured = plugin_solver_configure(
      &decoded, initial.data(), lowers.data(), uppers.data(),
      desired_values.empty() ? nullptr : desired_values.data(), steps.data());
  if (configured != ORBPRO_SOLVER_STATUS_IDLE ||
      plugin_solver_begin() != ORBPRO_SOLVER_STATUS_NEEDS_EVALUATION) {
    plugin_set_error("solver-configuration-failed", "The SLP problem could not start a solver session.");
    return 1;
  }
  return 0;
}
#endif

}  // extern "C"
