#ifndef LAMBERT_IZZO_SOLVER_HPP
#define LAMBERT_IZZO_SOLVER_HPP

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <utility>
#include <vector>

// Header-only Izzo 2014 Lambert kernel. This is the sole Lambert trajectory
// implementation shared by the standalone SDS module and the maneuver
// planner. Adapters own units and wire formats; this kernel owns the math.
namespace lambert_izzo {

constexpr double kPi = 3.141592653589793238462643383279502884;

struct Vector3 {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

struct Request {
  Vector3 r1;
  Vector3 r2;
  double tof = 0.0;
  double mu = 0.0;
  bool long_way = false;
  uint16_t max_revolutions = 0;
  // Optional plane for exactly antipodal endpoints (e.g. Hohmann transfer).
  // Zero preserves the original collinear refusal.
  Vector3 antipodal_normal;
};

struct Solution {
  Vector3 v1;
  Vector3 v2;
  uint32_t iterations = 0;
  double x = 0.0;
  double residual = 0.0;
};

struct RevolutionSolutions {
  uint16_t revolutions = 0;
  Solution long_period;
  Solution short_period;
};

enum class Status {
  Ok,
  InvalidInput,
  DegenerateGeometry,
  NoConvergence,
};

struct Result {
  Status status = Status::NoConvergence;
  Solution single;
  std::vector<RevolutionSolutions> multi;
};

inline double norm(const Vector3& value) {
  return std::sqrt(value.x * value.x + value.y * value.y + value.z * value.z);
}

inline Vector3 add(const Vector3& left, const Vector3& right) {
  return {left.x + right.x, left.y + right.y, left.z + right.z};
}

inline Vector3 subtract(const Vector3& left, const Vector3& right) {
  return {left.x - right.x, left.y - right.y, left.z - right.z};
}

inline Vector3 scale(const Vector3& value, double scalar) {
  return {value.x * scalar, value.y * scalar, value.z * scalar};
}

inline Vector3 cross(const Vector3& left, const Vector3& right) {
  return {
      left.y * right.z - left.z * right.y,
      left.z * right.x - left.x * right.z,
      left.x * right.y - left.y * right.x};
}

inline Vector3 normalize(const Vector3& value) {
  const double magnitude = norm(value);
  return scale(value, 1.0 / magnitude);
}

inline bool finite(const Vector3& value) {
  return std::isfinite(value.x) && std::isfinite(value.y) &&
         std::isfinite(value.z);
}

inline double hypergeometric_f(double z) {
  constexpr double tolerance = 1e-11;
  double sum = 1.0;
  double term = 1.0;
  for (int j = 0; j <= 12; ++j) {
    term = term * (3.0 + j) * (1.0 + j) / (2.5 + j) * z / (j + 1.0);
    sum += term;
    if (std::abs(term) < tolerance) break;
  }
  return sum;
}

inline double x_to_tof(double x, int revolutions, double lambda) {
  constexpr double battin = 0.01;
  constexpr double lagrange = 0.2;
  const double distance_from_one = std::abs(x - 1.0);
  const double u = 1.0 - x * x;
  const double y = std::sqrt(std::max(0.0, 1.0 - lambda * lambda * u));

  if (revolutions == 0 && distance_from_one < 1e-8) {
    return 2.0 / 3.0 * (1.0 - std::pow(lambda, 3));
  }
  if (revolutions == 0 && distance_from_one <= battin) {
    const double eta = y - lambda * x;
    const double s1 = 0.5 * (1.0 - lambda - x * eta);
    const double q = 4.0 / 3.0 * hypergeometric_f(s1);
    return (std::pow(eta, 3) * q + 4.0 * lambda * eta) / 2.0;
  }
  if (distance_from_one > lagrange) {
    const double a = 1.0 / u;
    if (a > 0.0) {
      const double alpha = 2.0 * std::acos(x);
      double beta = 2.0 * std::asin(std::sqrt(std::abs(lambda * lambda / a)));
      if (lambda < 0.0) beta = -beta;
      return 0.5 * a * std::sqrt(a) *
             ((alpha - std::sin(alpha)) - (beta - std::sin(beta)) +
              2.0 * kPi * revolutions);
    }
    const double alpha = 2.0 * std::acosh(x);
    double beta = 2.0 * std::asinh(std::sqrt(-lambda * lambda / a));
    if (lambda < 0.0) beta = -beta;
    return -0.5 * a * std::sqrt(-a) *
           ((beta - std::sinh(beta)) - (alpha - std::sinh(alpha)));
  }

  const double psi = u > 0.0
                         ? std::atan2((y - x * lambda) * std::sqrt(u),
                                      x * y + lambda * u)
                         : std::asinh((y - x * lambda) * std::sqrt(-u));
  return (((psi + revolutions * kPi) / std::sqrt(std::abs(u))) - x +
          lambda * y) /
         u;
}

inline void tof_derivatives(double x, double tof, double lambda, double* first,
                            double* second, double* third) {
  if (std::abs(x - 1.0) < 1e-8) {
    *first = 2.0 / 5.0 * (std::pow(lambda, 5) - 1.0);
    *second = 0.0;
    *third = 0.0;
    return;
  }
  const double u = 1.0 - x * x;
  const double y = std::sqrt(1.0 - lambda * lambda * u);
  *first = (3.0 * tof * x - 2.0 + 2.0 * std::pow(lambda, 3) * x / y) / u;
  *second =
      (3.0 * tof + 5.0 * x * *first +
       2.0 * (1.0 - lambda * lambda) * std::pow(lambda, 3) /
           std::pow(y, 3)) /
      u;
  *third =
      (7.0 * x * *second + 8.0 * *first -
       6.0 * (1.0 - lambda * lambda) * std::pow(lambda, 5) * x /
           std::pow(y, 5)) /
      u;
}

inline double initial_guess_zero_revolution(double lambda,
                                             double nondimensional_tof) {
  const double t00 =
      std::acos(lambda) + lambda * std::sqrt(1.0 - lambda * lambda);
  const double t1 = 2.0 / 3.0 * (1.0 - std::pow(lambda, 3));
  if (nondimensional_tof >= t00) {
    return std::pow(t00 / nondimensional_tof, 2.0 / 3.0) - 1.0;
  }
  if (nondimensional_tof <= t1) {
    return 2.5 * t1 * (t1 - nondimensional_tof) /
               (nondimensional_tof * (1.0 - std::pow(lambda, 5))) +
           1.0;
  }
  return std::pow(t00 / nondimensional_tof,
                  std::log(2.0) / std::log(t00 / t1)) -
         1.0;
}

inline bool householder(double target_tof, double lambda, int revolutions,
                        double* x, uint32_t* iterations, double* residual) {
  const double tolerance = revolutions == 0 ? 1e-5 : 1e-8;
  double current = *x;
  for (uint32_t iteration = 1; iteration <= 15; ++iteration) {
    const double tof = x_to_tof(current, revolutions, lambda);
    double first = 0.0;
    double second = 0.0;
    double third = 0.0;
    tof_derivatives(current, tof, lambda, &first, &second, &third);
    const double delta = tof - target_tof;
    const double first_squared = first * first;
    const double denominator =
        first * (first_squared - delta * second) +
        third * delta * delta / 6.0;
    if (!std::isfinite(denominator) || denominator == 0.0) return false;
    const double next =
        current - delta * (first_squared - delta * second / 2.0) / denominator;
    if (!std::isfinite(next)) return false;
    const double step = std::abs(current - next);
    current = next;
    *iterations = iteration;
    if (step < tolerance) {
      *x = current;
      *residual = std::abs(x_to_tof(current, revolutions, lambda) - target_tof);
      return std::isfinite(*residual);
    }
  }
  *x = current;
  *residual = std::abs(x_to_tof(current, revolutions, lambda) - target_tof);
  return false;
}

inline std::pair<double, double> initial_guess_multi_revolution(
    double target_tof, int revolutions) {
  const double m_pi = revolutions * kPi;
  const double left_scale =
      std::pow((m_pi + kPi) / (8.0 * target_tof), 2.0 / 3.0);
  const double right_scale =
      std::pow((8.0 * target_tof) / m_pi, 2.0 / 3.0);
  return {(left_scale - 1.0) / (left_scale + 1.0),
          (right_scale - 1.0) / (right_scale + 1.0)};
}

inline double minimum_multi_revolution_tof(double lambda, int revolutions) {
  double x = 0.0;
  for (int iteration = 0; iteration < 12; ++iteration) {
    const double tof = x_to_tof(x, revolutions, lambda);
    double first = 0.0;
    double second = 0.0;
    double third = 0.0;
    tof_derivatives(x, tof, lambda, &first, &second, &third);
    const double denominator = 2.0 * second * second - first * third;
    if (denominator == 0.0) break;
    const double step = 2.0 * first * second / denominator;
    x -= step;
    if (std::abs(step) < 1e-13) break;
  }
  return x_to_tof(x, revolutions, lambda);
}

inline bool reconstruct(const Request& request, double x, uint32_t iterations,
                        double residual, Solution* solution) {
  const Vector3 chord = subtract(request.r2, request.r1);
  const double chord_norm = norm(chord);
  const double r1_norm = norm(request.r1);
  const double r2_norm = norm(request.r2);
  const double semiperimeter = 0.5 * (r1_norm + r2_norm + chord_norm);
  double lambda =
      std::sqrt(std::max(0.0, 1.0 - chord_norm / semiperimeter));

  Vector3 plane = cross(normalize(request.r1), normalize(request.r2));
  if (norm(plane) == 0.0) plane = request.antipodal_normal;
  Vector3 angular_momentum = normalize(plane);
  if (request.long_way) {
    lambda = -lambda;
    angular_momentum = scale(angular_momentum, -1.0);
  }
  const Vector3 r1_hat = normalize(request.r1);
  const Vector3 r2_hat = normalize(request.r2);
  const Vector3 t1_hat = cross(angular_momentum, r1_hat);
  const Vector3 t2_hat = cross(angular_momentum, r2_hat);
  const double y = std::sqrt(
      std::max(0.0, 1.0 - lambda * lambda * (1.0 - x * x)));
  const double gamma = std::sqrt(request.mu * semiperimeter / 2.0);
  const double rho = (r1_norm - r2_norm) / chord_norm;
  const double sigma = std::sqrt(std::max(0.0, 1.0 - rho * rho));
  const double vr1 =
      gamma * ((lambda * y - x) - rho * (lambda * y + x)) / r1_norm;
  const double vr2 =
      -gamma * ((lambda * y - x) + rho * (lambda * y + x)) / r2_norm;
  const double tangential = gamma * sigma * (y + lambda * x);
  const double vt1 = tangential / r1_norm;
  const double vt2 = tangential / r2_norm;

  solution->v1 = add(scale(r1_hat, vr1), scale(t1_hat, vt1));
  solution->v2 = add(scale(r2_hat, vr2), scale(t2_hat, vt2));
  solution->iterations = iterations;
  solution->x = x;
  solution->residual = residual;
  return finite(solution->v1) && finite(solution->v2);
}

inline Result solve(const Request& request) {
  Result result;
  if (!finite(request.r1) || !finite(request.r2) ||
      !std::isfinite(request.tof) || !std::isfinite(request.mu) ||
      !(norm(request.r1) > 0.0) || !(norm(request.r2) > 0.0) ||
      !(request.tof > 0.0) || !(request.mu > 0.0) ||
      request.max_revolutions > 32) {
    result.status = Status::InvalidInput;
    return result;
  }
  const bool antipodal_plane = finite(request.antipodal_normal) &&
      norm(request.antipodal_normal) > 0.0 &&
      request.r1.x * request.r2.x + request.r1.y * request.r2.y +
          request.r1.z * request.r2.z < 0.0 &&
      std::abs(request.r1.x * request.antipodal_normal.x +
          request.r1.y * request.antipodal_normal.y +
          request.r1.z * request.antipodal_normal.z) <=
          1e-12 * norm(request.r1) * norm(request.antipodal_normal);
  if (!(norm(cross(request.r1, request.r2)) > 0.0) && !antipodal_plane) {
    result.status = Status::DegenerateGeometry;
    return result;
  }

  const double chord_norm = norm(subtract(request.r2, request.r1));
  const double semiperimeter =
      0.5 * (norm(request.r1) + norm(request.r2) + chord_norm);
  double lambda =
      std::sqrt(std::max(0.0, 1.0 - chord_norm / semiperimeter));
  if (request.long_way) lambda = -lambda;
  const double target_tof =
      std::sqrt(2.0 * request.mu / std::pow(semiperimeter, 3)) * request.tof;

  double x = initial_guess_zero_revolution(lambda, target_tof);
  uint32_t iterations = 0;
  double residual = 0.0;
  if (!householder(target_tof, lambda, 0, &x, &iterations, &residual) ||
      !reconstruct(request, x, iterations, residual, &result.single)) {
    result.status = Status::NoConvergence;
    return result;
  }

  const double t00 =
      std::acos(lambda) + lambda * std::sqrt(1.0 - lambda * lambda);
  for (uint16_t revolutions = 1; revolutions <= request.max_revolutions;
       ++revolutions) {
    const double m_pi = revolutions * kPi;
    if (target_tof < m_pi) break;
    if (target_tof < t00 + m_pi &&
        minimum_multi_revolution_tof(lambda, revolutions) > target_tof) {
      break;
    }
    auto guesses = initial_guess_multi_revolution(target_tof, revolutions);
    uint32_t left_iterations = 0;
    uint32_t right_iterations = 0;
    double left_residual = 0.0;
    double right_residual = 0.0;
    if (!householder(target_tof, lambda, revolutions, &guesses.first,
                     &left_iterations, &left_residual) ||
        !householder(target_tof, lambda, revolutions, &guesses.second,
                     &right_iterations, &right_residual)) {
      result.status = Status::NoConvergence;
      return result;
    }
    RevolutionSolutions pair;
    pair.revolutions = revolutions;
    if (!reconstruct(request, guesses.first, left_iterations, left_residual,
                     &pair.long_period) ||
        !reconstruct(request, guesses.second, right_iterations, right_residual,
                     &pair.short_period)) {
      result.status = Status::NoConvergence;
      return result;
    }
    result.multi.push_back(pair);
  }

  result.status = Status::Ok;
  return result;
}

}  // namespace lambert_izzo

#endif  // LAMBERT_IZZO_SOLVER_HPP
