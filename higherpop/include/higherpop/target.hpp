// higherpop/target.hpp — propagator-independent differential correction.
//
// A caller supplies the Vary vector and an evaluator that routes every trial
// through its selected propagator port. This file deliberately contains no
// orbit model. It provides Newton-Raphson, good-Broyden and modified-Broyden
// updates, forward/central finite differences, analytic Jacobians and a full
// iteration report.

#ifndef HIGHERPOP_TARGET_HPP
#define HIGHERPOP_TARGET_HPP

#include <algorithm>
#include <cmath>
#include <functional>
#include <limits>
#include <string>
#include <utility>
#include <vector>

namespace hp {
namespace target {

using Vecd = std::vector<double>;
using Matrix = std::vector<Vecd>;
using ResidualFn = std::function<Vecd(const Vecd&)>;
using JacobianFn = std::function<Matrix(const Vecd&)>;

enum class Algorithm { NewtonRaphson, Broyden, ModifiedBroyden };
enum class DifferenceMode { Forward, Central, Analytic };
enum class Status {
  Converged,
  InvalidProblem,
  SingularJacobian,
  EvaluationFailed,
  BudgetExceeded,
  Stalled,
};

struct Options {
  int max_iter = 50;
  int max_evaluations = 10000;
  double tol = 1e-9;
  double step_tol = 1e-13;
  double fd_rel = 1e-6;
  double fd_abs = 1e-9;
  double lambda0 = 1e-10;
  double lambda_up = 10.0;
  double lambda_down = 0.25;
  double step_clip = 0.0;
  Algorithm algorithm = Algorithm::NewtonRaphson;
  DifferenceMode difference_mode = DifferenceMode::Forward;
  Vecd perturbations;
  Vecd lower_bounds;
  Vecd upper_bounds;
  bool show_progress = false;
  std::string report_style = "normal";
  bool verbose = false;
};

struct Iteration {
  int iteration = 0;
  Vecd controls;
  Vecd goals;
  double residual_norm = std::numeric_limits<double>::infinity();
  double step_norm = 0.0;
  double jacobian_condition = std::numeric_limits<double>::infinity();
  double damping = 0.0;
  int evaluations = 0;
  bool accepted = false;
};

struct Result {
  Vecd controls;
  Vecd goals;
  double residual_norm = std::numeric_limits<double>::infinity();
  int iters = 0;
  int nfev = 0;
  bool converged = false;
  Status status = Status::InvalidProblem;
  std::string message;
  std::vector<Iteration> history;
};

inline bool finite(const Vecd& values) {
  for (double value : values) {
    if (!std::isfinite(value)) return false;
  }
  return true;
}

inline double dot(const Vecd& a, const Vecd& b) {
  double value = 0.0;
  for (std::size_t i = 0; i < a.size(); ++i) value += a[i] * b[i];
  return value;
}

inline double norm2(const Vecd& values) { return std::sqrt(dot(values, values)); }

inline Vecd multiply(const Matrix& matrix, const Vecd& vector) {
  Vecd value(matrix.size(), 0.0);
  for (std::size_t row = 0; row < matrix.size(); ++row) {
    value[row] = dot(matrix[row], vector);
  }
  return value;
}

inline bool solveLinear(Matrix& matrix, Vecd& rhs) {
  const int n = static_cast<int>(rhs.size());
  for (int column = 0; column < n; ++column) {
    int pivot = column;
    double largest = std::fabs(matrix[column][column]);
    for (int row = column + 1; row < n; ++row) {
      const double candidate = std::fabs(matrix[row][column]);
      if (candidate > largest) {
        largest = candidate;
        pivot = row;
      }
    }
    if (!(largest > 1e-24) || !std::isfinite(largest)) return false;
    if (pivot != column) {
      std::swap(matrix[pivot], matrix[column]);
      std::swap(rhs[pivot], rhs[column]);
    }
    const double diagonal = matrix[column][column];
    for (int row = column + 1; row < n; ++row) {
      const double factor = matrix[row][column] / diagonal;
      for (int k = column; k < n; ++k) matrix[row][k] -= factor * matrix[column][k];
      rhs[row] -= factor * rhs[column];
    }
  }
  for (int row = n - 1; row >= 0; --row) {
    double value = rhs[row];
    for (int k = row + 1; k < n; ++k) value -= matrix[row][k] * rhs[k];
    rhs[row] = value / matrix[row][row];
  }
  return finite(rhs);
}

inline double perturbation(const Vecd& x, std::size_t column, const Options& options) {
  if (column < options.perturbations.size() && options.perturbations[column] > 0.0) {
    return options.perturbations[column];
  }
  return options.fd_rel * std::max(1.0, std::fabs(x[column])) + options.fd_abs;
}

inline Matrix finiteDifferenceJacobian(const ResidualFn& evaluate,
                                       const Vecd& controls,
                                       const Vecd& at_controls,
                                       const Options& options,
                                       int& evaluations) {
  const std::size_t rows = at_controls.size();
  const std::size_t columns = controls.size();
  Matrix jacobian(rows, Vecd(columns, 0.0));
  Vecd trial = controls;
  for (std::size_t column = 0; column < columns; ++column) {
    const double h = perturbation(controls, column, options);
    trial[column] = controls[column] + h;
    const Vecd plus = evaluate(trial);
    ++evaluations;
    trial[column] = controls[column];
    if (plus.size() != rows || !finite(plus)) return {};
    if (options.difference_mode == DifferenceMode::Central) {
      trial[column] = controls[column] - h;
      const Vecd minus = evaluate(trial);
      ++evaluations;
      trial[column] = controls[column];
      if (minus.size() != rows || !finite(minus)) return {};
      for (std::size_t row = 0; row < rows; ++row) {
        jacobian[row][column] = (plus[row] - minus[row]) / (2.0 * h);
      }
    } else {
      for (std::size_t row = 0; row < rows; ++row) {
        jacobian[row][column] = (plus[row] - at_controls[row]) / h;
      }
    }
  }
  return jacobian;
}

inline Matrix jacobian(const ResidualFn& evaluate, const Vecd& controls,
                       const Vecd& at_controls, const Options& options,
                       int& evaluations) {
  return finiteDifferenceJacobian(evaluate, controls, at_controls, options, evaluations);
}

inline double conditionEstimate(const Matrix& jacobian) {
  if (jacobian.empty() || jacobian.front().empty()) {
    return std::numeric_limits<double>::infinity();
  }
  double largest = 0.0;
  double smallest = std::numeric_limits<double>::infinity();
  for (std::size_t column = 0; column < jacobian.front().size(); ++column) {
    double magnitude = 0.0;
    for (const auto& row : jacobian) magnitude += row[column] * row[column];
    magnitude = std::sqrt(magnitude);
    largest = std::max(largest, magnitude);
    if (magnitude > 1e-24) smallest = std::min(smallest, magnitude);
  }
  return smallest < std::numeric_limits<double>::infinity()
             ? largest / smallest
             : std::numeric_limits<double>::infinity();
}

inline bool leastSquaresStep(const Matrix& jacobian, const Vecd& residual,
                             double damping, Vecd& step) {
  if (jacobian.empty() || jacobian.size() != residual.size()) return false;
  const std::size_t columns = jacobian.front().size();
  Matrix normal(columns, Vecd(columns, 0.0));
  Vecd rhs(columns, 0.0);
  for (std::size_t a = 0; a < columns; ++a) {
    for (std::size_t b = 0; b < columns; ++b) {
      for (std::size_t row = 0; row < residual.size(); ++row) {
        normal[a][b] += jacobian[row][a] * jacobian[row][b];
      }
    }
    for (std::size_t row = 0; row < residual.size(); ++row) {
      rhs[a] -= jacobian[row][a] * residual[row];
    }
    normal[a][a] += damping * std::max(1.0, normal[a][a]);
  }
  step = rhs;
  return solveLinear(normal, step);
}

inline void applyBounds(Vecd& controls, const Options& options) {
  for (std::size_t i = 0; i < controls.size(); ++i) {
    if (i < options.lower_bounds.size()) controls[i] = std::max(controls[i], options.lower_bounds[i]);
    if (i < options.upper_bounds.size()) controls[i] = std::min(controls[i], options.upper_bounds[i]);
  }
}

inline void updateBroyden(Matrix& jacobian, const Vecd& step,
                          const Vecd& old_values, const Vecd& new_values,
                          bool modified) {
  Vecd observed(new_values.size(), 0.0);
  for (std::size_t i = 0; i < observed.size(); ++i) observed[i] = new_values[i] - old_values[i];
  const Vecd predicted = multiply(jacobian, step);
  Vecd defect(observed.size(), 0.0);
  for (std::size_t i = 0; i < defect.size(); ++i) defect[i] = observed[i] - predicted[i];

  Vecd weight = step;
  double denominator = dot(step, step);
  if (modified) {
    weight.assign(step.size(), 0.0);
    for (std::size_t column = 0; column < step.size(); ++column) {
      for (std::size_t row = 0; row < observed.size(); ++row) {
        weight[column] += observed[row] * jacobian[row][column];
      }
    }
    denominator = dot(weight, step);
  }
  if (std::fabs(denominator) < 1e-24) return;
  for (std::size_t row = 0; row < jacobian.size(); ++row) {
    for (std::size_t column = 0; column < step.size(); ++column) {
      jacobian[row][column] += defect[row] * weight[column] / denominator;
    }
  }
}

inline Result solve(const ResidualFn& evaluate, const Vecd& initial_controls,
                    const Vecd& desired, const Options& options = Options(),
                    const JacobianFn& analytic_jacobian = JacobianFn()) {
  Result result;
  result.controls = initial_controls;
  if (!evaluate || initial_controls.empty() || desired.empty() ||
      (options.difference_mode == DifferenceMode::Analytic && !analytic_jacobian)) {
    result.message = "invalid target problem";
    return result;
  }

  Vecd values = evaluate(result.controls);
  ++result.nfev;
  if (values.size() != desired.size() || !finite(values)) {
    result.status = Status::EvaluationFailed;
    result.message = "initial evaluator call failed";
    return result;
  }
  auto make_residual = [&](const Vecd& candidate) {
    Vecd residual(candidate.size(), 0.0);
    for (std::size_t i = 0; i < candidate.size(); ++i) residual[i] = candidate[i] - desired[i];
    return residual;
  };
  Vecd residual = make_residual(values);
  result.goals = values;
  result.residual_norm = norm2(residual);
  result.status = Status::Stalled;
  double damping = options.lambda0;
  Matrix current_jacobian;

  for (int iteration = 0; iteration <= options.max_iter; ++iteration) {
    if (result.residual_norm <= options.tol) {
      result.converged = true;
      result.status = Status::Converged;
      result.message = "goal tolerance attained";
      result.iters = iteration;
      break;
    }
    if (iteration == options.max_iter || result.nfev >= options.max_evaluations) {
      result.status = Status::BudgetExceeded;
      result.message = "solver budget exhausted";
      result.iters = iteration;
      break;
    }

    const bool rebuild = current_jacobian.empty() ||
                         options.algorithm == Algorithm::NewtonRaphson;
    if (rebuild) {
      if (options.difference_mode == DifferenceMode::Analytic) {
        current_jacobian = analytic_jacobian(result.controls);
      } else {
        current_jacobian = finiteDifferenceJacobian(
            evaluate, result.controls, values, options, result.nfev);
      }
    }
    if (current_jacobian.size() != desired.size() || current_jacobian.empty()) {
      result.status = Status::EvaluationFailed;
      result.message = "Jacobian evaluation failed";
      result.iters = iteration;
      break;
    }

    Vecd step;
    if (!leastSquaresStep(current_jacobian, residual, damping, step)) {
      result.status = Status::SingularJacobian;
      result.message = "Jacobian normal equations are singular";
      result.iters = iteration;
      break;
    }
    if (options.step_clip > 0.0 && norm2(step) > options.step_clip) {
      const double scale = options.step_clip / norm2(step);
      for (double& value : step) value *= scale;
    }

    Vecd trial(result.controls.size(), 0.0);
    for (std::size_t i = 0; i < trial.size(); ++i) trial[i] = result.controls[i] + step[i];
    applyBounds(trial, options);
    for (std::size_t i = 0; i < step.size(); ++i) step[i] = trial[i] - result.controls[i];
    const double step_norm = norm2(step);
    if (step_norm <= options.step_tol) {
      result.status = Status::Stalled;
      result.message = "control step fell below tolerance";
      result.iters = iteration;
      break;
    }

    const Vecd trial_values = evaluate(trial);
    ++result.nfev;
    const bool valid = trial_values.size() == desired.size() && finite(trial_values);
    const Vecd trial_residual = valid ? make_residual(trial_values) : Vecd{};
    const double trial_norm = valid ? norm2(trial_residual)
                                    : std::numeric_limits<double>::infinity();
    const bool accepted = trial_norm < result.residual_norm;
    result.history.push_back({iteration + 1, trial, trial_values, trial_norm,
                              step_norm, conditionEstimate(current_jacobian),
                              damping, result.nfev, accepted});
    result.iters = iteration + 1;

    if (accepted) {
      if (options.algorithm != Algorithm::NewtonRaphson) {
        updateBroyden(current_jacobian, step, values, trial_values,
                      options.algorithm == Algorithm::ModifiedBroyden);
      }
      result.controls = trial;
      values = trial_values;
      residual = trial_residual;
      result.goals = values;
      result.residual_norm = trial_norm;
      damping = std::max(1e-18, damping * options.lambda_down);
    } else {
      damping = std::max(1e-18, damping * options.lambda_up);
      if (options.algorithm != Algorithm::NewtonRaphson) current_jacobian.clear();
      if (!valid) {
        result.status = Status::EvaluationFailed;
        result.message = "trial evaluator call failed";
        break;
      }
    }
  }

  if (!result.converged && result.message.empty()) result.message = "solver stalled";
  return result;
}

}  // namespace target
}  // namespace hp

#endif  // HIGHERPOP_TARGET_HPP
