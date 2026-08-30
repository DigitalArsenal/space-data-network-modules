#ifndef SDN_OPTIMAL_CONTROL_SQP_HPP
#define SDN_OPTIMAL_CONTROL_SQP_HPP

#include <algorithm>
#include <cmath>
#include <functional>
#include <limits>
#include <string>
#include <vector>

namespace sdn {
namespace sqp {

using Vector = std::vector<double>;
using Matrix = std::vector<Vector>;

struct Evaluation {
  double objective = std::numeric_limits<double>::infinity();
  Vector equalities;
  Vector inequalities;  // feasible when every value <= 0
  bool valid = false;
};

using Evaluator = std::function<Evaluation(const Vector&)>;

enum class Status {
  Converged,
  InvalidProblem,
  EvaluationFailed,
  SingularSubproblem,
  BudgetExceeded,
  Stalled,
  Infeasible,
};

struct Options {
  int maximum_iterations = 200;
  int maximum_evaluations = 10000;
  double finite_difference_relative_step = 1e-6;
  double finite_difference_absolute_step = 1e-8;
  double objective_tolerance = 1e-10;
  double constraint_tolerance = 1e-8;
  double kkt_tolerance = 1e-6;
  double step_tolerance = 1e-12;
  double active_constraint_tolerance = 1e-5;
  double merit_penalty = 100.0;
  Vector lower_bounds;
  Vector upper_bounds;
};

struct Iteration {
  int iteration = 0;
  Vector variables;
  double objective = std::numeric_limits<double>::infinity();
  double maximum_constraint_violation = std::numeric_limits<double>::infinity();
  double kkt_residual = std::numeric_limits<double>::infinity();
  double step_norm = 0.0;
  int evaluations = 0;
  bool accepted = false;
};

struct Result {
  Status status = Status::InvalidProblem;
  std::string message;
  Vector variables;
  Evaluation evaluation;
  double maximum_constraint_violation = std::numeric_limits<double>::infinity();
  double kkt_residual = std::numeric_limits<double>::infinity();
  int iterations = 0;
  int evaluations = 0;
  std::vector<Iteration> history;
};

inline double dot(const Vector& left, const Vector& right) {
  double value = 0.0;
  for (std::size_t i = 0; i < left.size(); ++i) value += left[i] * right[i];
  return value;
}

inline double norm2(const Vector& value) { return std::sqrt(dot(value, value)); }

inline double normInf(const Vector& value) {
  double result = 0.0;
  for (double component : value) result = std::max(result, std::fabs(component));
  return result;
}

inline bool finite(const Evaluation& value) {
  if (!value.valid || !std::isfinite(value.objective)) return false;
  for (double component : value.equalities) if (!std::isfinite(component)) return false;
  for (double component : value.inequalities) if (!std::isfinite(component)) return false;
  return true;
}

inline bool solveLinear(Matrix matrix, Vector rhs, Vector& solution) {
  const int n = static_cast<int>(rhs.size());
  for (int column = 0; column < n; ++column) {
    int pivot = column;
    double largest = std::fabs(matrix[column][column]);
    for (int row = column + 1; row < n; ++row) {
      if (std::fabs(matrix[row][column]) > largest) {
        largest = std::fabs(matrix[row][column]);
        pivot = row;
      }
    }
    if (!(largest > 1e-14)) return false;
    if (pivot != column) {
      std::swap(matrix[pivot], matrix[column]);
      std::swap(rhs[pivot], rhs[column]);
    }
    for (int row = column + 1; row < n; ++row) {
      const double factor = matrix[row][column] / matrix[column][column];
      for (int k = column; k < n; ++k) matrix[row][k] -= factor * matrix[column][k];
      rhs[row] -= factor * rhs[column];
    }
  }
  solution.assign(rhs.size(), 0.0);
  for (int row = n - 1; row >= 0; --row) {
    double value = rhs[row];
    for (int column = row + 1; column < n; ++column) {
      value -= matrix[row][column] * solution[column];
    }
    solution[row] = value / matrix[row][row];
  }
  return true;
}

inline double violation(const Evaluation& evaluation) {
  double value = 0.0;
  for (double equality : evaluation.equalities) value = std::max(value, std::fabs(equality));
  for (double inequality : evaluation.inequalities) value = std::max(value, std::max(0.0, inequality));
  return value;
}

inline double merit(const Evaluation& evaluation, double penalty) {
  double value = evaluation.objective;
  for (double equality : evaluation.equalities) value += penalty * std::fabs(equality);
  for (double inequality : evaluation.inequalities) value += penalty * std::max(0.0, inequality);
  return value;
}

struct Derivatives {
  Vector objective;
  Matrix equalities;
  Matrix inequalities;
  bool valid = false;
};

inline Derivatives finiteDifference(const Evaluator& evaluate, const Vector& x,
                                    const Evaluation& at_x,
                                    const Options& options, int& evaluations) {
  Derivatives result;
  result.objective.assign(x.size(), 0.0);
  result.equalities.assign(at_x.equalities.size(), Vector(x.size(), 0.0));
  result.inequalities.assign(at_x.inequalities.size(), Vector(x.size(), 0.0));
  for (std::size_t column = 0; column < x.size(); ++column) {
    const double h = options.finite_difference_relative_step *
                         std::max(1.0, std::fabs(x[column])) +
                     options.finite_difference_absolute_step;
    Vector plus_x = x;
    Vector minus_x = x;
    plus_x[column] += h;
    minus_x[column] -= h;
    const Evaluation plus = evaluate(plus_x);
    const Evaluation minus = evaluate(minus_x);
    evaluations += 2;
    if (!finite(plus) || !finite(minus) ||
        plus.equalities.size() != at_x.equalities.size() ||
        plus.inequalities.size() != at_x.inequalities.size() ||
        minus.equalities.size() != at_x.equalities.size() ||
        minus.inequalities.size() != at_x.inequalities.size()) {
      return result;
    }
    result.objective[column] = (plus.objective - minus.objective) / (2.0 * h);
    for (std::size_t row = 0; row < at_x.equalities.size(); ++row) {
      result.equalities[row][column] =
          (plus.equalities[row] - minus.equalities[row]) / (2.0 * h);
    }
    for (std::size_t row = 0; row < at_x.inequalities.size(); ++row) {
      result.inequalities[row][column] =
          (plus.inequalities[row] - minus.inequalities[row]) / (2.0 * h);
    }
  }
  result.valid = true;
  return result;
}

inline void projectBounds(Vector& x, const Options& options) {
  for (std::size_t i = 0; i < x.size(); ++i) {
    if (i < options.lower_bounds.size()) x[i] = std::max(x[i], options.lower_bounds[i]);
    if (i < options.upper_bounds.size()) x[i] = std::min(x[i], options.upper_bounds[i]);
  }
}

inline Vector lagrangianGradient(const Derivatives& derivatives,
                                 const std::vector<std::pair<bool, std::size_t>>& active,
                                 const Vector& multipliers) {
  Vector result = derivatives.objective;
  for (std::size_t row = 0; row < active.size(); ++row) {
    const Vector& gradient = active[row].first
                                 ? derivatives.equalities[active[row].second]
                                 : derivatives.inequalities[active[row].second];
    for (std::size_t column = 0; column < result.size(); ++column) {
      result[column] += multipliers[row] * gradient[column];
    }
  }
  return result;
}

inline Result solve(const Evaluator& evaluate, Vector x,
                    const Options& options = Options()) {
  Result result;
  result.variables = x;
  if (!evaluate || x.empty()) {
    result.message = "invalid optimization problem";
    return result;
  }
  projectBounds(x, options);
  Evaluation current = evaluate(x);
  result.evaluations = 1;
  if (!finite(current)) {
    result.status = Status::EvaluationFailed;
    result.message = "initial evaluator call failed";
    return result;
  }

  const std::size_t n = x.size();
  Matrix hessian(n, Vector(n, 0.0));
  for (std::size_t i = 0; i < n; ++i) hessian[i][i] = 1.0;
  double last_objective = current.objective;

  for (int iteration = 0; iteration < options.maximum_iterations; ++iteration) {
    Derivatives derivatives =
        finiteDifference(evaluate, x, current, options, result.evaluations);
    if (!derivatives.valid) {
      result.status = Status::EvaluationFailed;
      result.message = "finite-difference evaluation failed";
      break;
    }

    std::vector<std::pair<bool, std::size_t>> active;
    Vector active_values;
    for (std::size_t row = 0; row < current.equalities.size(); ++row) {
      active.push_back({true, row});
      active_values.push_back(current.equalities[row]);
    }
    for (std::size_t row = 0; row < current.inequalities.size(); ++row) {
      if (current.inequalities[row] >= -options.active_constraint_tolerance) {
        active.push_back({false, row});
        active_values.push_back(current.inequalities[row]);
      }
    }

    const std::size_t k = active.size();
    Matrix kkt(n + k, Vector(n + k, 0.0));
    Vector rhs(n + k, 0.0);
    for (std::size_t row = 0; row < n; ++row) {
      rhs[row] = -derivatives.objective[row];
      for (std::size_t column = 0; column < n; ++column) kkt[row][column] = hessian[row][column];
    }
    for (std::size_t constraint = 0; constraint < k; ++constraint) {
      const Vector& gradient = active[constraint].first
                                   ? derivatives.equalities[active[constraint].second]
                                   : derivatives.inequalities[active[constraint].second];
      rhs[n + constraint] = -active_values[constraint];
      for (std::size_t column = 0; column < n; ++column) {
        kkt[column][n + constraint] = gradient[column];
        kkt[n + constraint][column] = gradient[column];
      }
    }

    Vector kkt_solution;
    bool solved = solveLinear(kkt, rhs, kkt_solution);
    if (!solved) {
      // A dependent active inequality must not turn a valid problem into a
      // false success. Drop inactive-at-the-solution inequalities first, then
      // regularize the primal block once.
      for (std::size_t i = 0; i < n; ++i) kkt[i][i] += 1e-8;
      solved = solveLinear(kkt, rhs, kkt_solution);
    }
    if (!solved) {
      if (violation(current) > options.constraint_tolerance) {
        result.status = Status::Infeasible;
        result.message = "active constraints are mutually inconsistent";
      } else {
        result.status = Status::SingularSubproblem;
        result.message = "SQP subproblem is singular";
      }
      break;
    }

    Vector step(kkt_solution.begin(), kkt_solution.begin() + n);
    Vector multipliers(kkt_solution.begin() + n, kkt_solution.end());
    const Vector old_lagrangian_gradient =
        lagrangianGradient(derivatives, active, multipliers);
    const double kkt_residual = normInf(old_lagrangian_gradient);
    const double current_violation = violation(current);
    if (current_violation <= options.constraint_tolerance &&
        kkt_residual <= options.kkt_tolerance) {
      result.status = Status::Converged;
      result.message = "KKT and feasibility tolerances attained";
      result.kkt_residual = kkt_residual;
      result.maximum_constraint_violation = current_violation;
      break;
    }

    const double original_merit = merit(current, options.merit_penalty);
    bool accepted = false;
    Vector candidate;
    Evaluation candidate_evaluation;
    double alpha = 1.0;
    for (int line_search = 0; line_search < 30; ++line_search) {
      candidate = x;
      for (std::size_t i = 0; i < n; ++i) candidate[i] += alpha * step[i];
      projectBounds(candidate, options);
      candidate_evaluation = evaluate(candidate);
      ++result.evaluations;
      if (finite(candidate_evaluation) &&
          merit(candidate_evaluation, options.merit_penalty) <=
              original_merit - 1e-4 * alpha * dot(derivatives.objective, step)) {
        accepted = true;
        break;
      }
      alpha *= 0.5;
    }

    const double step_norm = accepted ? norm2(step) * alpha : 0.0;
    result.history.push_back({
        iteration + 1,
        accepted ? candidate : x,
        accepted ? candidate_evaluation.objective : current.objective,
        accepted ? violation(candidate_evaluation) : current_violation,
        kkt_residual,
        step_norm,
        result.evaluations,
        accepted,
    });
    result.iterations = iteration + 1;

    if (!accepted) {
      result.status = current_violation > options.constraint_tolerance
                          ? Status::Infeasible
                          : Status::Stalled;
      result.message = current_violation > options.constraint_tolerance
                           ? "no feasible descent step exists"
                           : "merit line search stalled";
      break;
    }

    Derivatives new_derivatives =
        finiteDifference(evaluate, candidate, candidate_evaluation,
                         options, result.evaluations);
    if (!new_derivatives.valid) {
      result.status = Status::EvaluationFailed;
      result.message = "accepted-point derivative evaluation failed";
      break;
    }
    const Vector new_lagrangian_gradient =
        lagrangianGradient(new_derivatives, active, multipliers);
    Vector actual_step(n, 0.0);
    Vector gradient_change(n, 0.0);
    for (std::size_t i = 0; i < n; ++i) {
      actual_step[i] = candidate[i] - x[i];
      gradient_change[i] = new_lagrangian_gradient[i] - old_lagrangian_gradient[i];
    }
    Vector hessian_step(n, 0.0);
    for (std::size_t row = 0; row < n; ++row) {
      hessian_step[row] = dot(hessian[row], actual_step);
    }
    const double sy = dot(actual_step, gradient_change);
    const double sbs = dot(actual_step, hessian_step);
    if (sy > 1e-12 && sbs > 1e-12) {
      for (std::size_t row = 0; row < n; ++row) {
        for (std::size_t column = 0; column < n; ++column) {
          hessian[row][column] +=
              gradient_change[row] * gradient_change[column] / sy -
              hessian_step[row] * hessian_step[column] / sbs;
        }
      }
    } else {
      for (std::size_t row = 0; row < n; ++row) {
        std::fill(hessian[row].begin(), hessian[row].end(), 0.0);
        hessian[row][row] = 1.0;
      }
    }

    x = candidate;
    current = candidate_evaluation;
    result.kkt_residual = kkt_residual;
    result.maximum_constraint_violation = violation(current);
    if (step_norm <= options.step_tolerance &&
        std::fabs(current.objective - last_objective) <= options.objective_tolerance) {
      result.status = result.maximum_constraint_violation <= options.constraint_tolerance
                          ? Status::Stalled
                          : Status::Infeasible;
      result.message = result.status == Status::Infeasible
                           ? "step vanished before feasibility"
                           : "step and objective change fell below tolerance";
      break;
    }
    last_objective = current.objective;
    if (result.evaluations >= options.maximum_evaluations) {
      result.status = Status::BudgetExceeded;
      result.message = "evaluation budget exhausted";
      break;
    }
  }

  if (result.message.empty()) {
    result.status = violation(current) > options.constraint_tolerance
                        ? Status::Infeasible
                        : Status::BudgetExceeded;
    result.message = result.status == Status::Infeasible
                         ? "iteration budget exhausted without feasibility"
                         : "iteration budget exhausted";
  }
  result.variables = x;
  result.evaluation = current;
  result.maximum_constraint_violation = violation(current);
  return result;
}

}  // namespace sqp
}  // namespace sdn

#endif  // SDN_OPTIMAL_CONTROL_SQP_HPP
