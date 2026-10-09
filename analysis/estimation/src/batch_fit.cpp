#include "estimation.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

// Batch weighted least squares of [state at the configuration epoch,
// dynamic parameters] (Tapley, Schutz & Born 2004, Statistical Orbit
// Determination, sections 4.3-4.6): Gauss-Newton on the whitened residuals
// with the design matrix H [Phi S] from the caller's propagator, the normal
// matrix N = P0^-1 + sum A' A and the formal covariance N^-1.
namespace sdn::estimation {
namespace {

using Matrix = std::vector<double>;  // row-major, n x n

// Lower Cholesky factor of a symmetric positive-definite n x n matrix.
bool cholesky(const Matrix& a, int n, Matrix* lower) {
  Matrix l(static_cast<std::size_t>(n) * n, 0.0);
  for (int i = 0; i < n; ++i) {
    for (int j = 0; j <= i; ++j) {
      double sum = a[i * n + j];
      for (int k = 0; k < j; ++k) sum -= l[i * n + k] * l[j * n + k];
      if (i == j) {
        if (!(sum > 0.0) || !std::isfinite(sum)) return false;
        l[i * n + i] = std::sqrt(sum);
      } else {
        l[i * n + j] = sum / l[j * n + j];
      }
    }
  }
  *lower = std::move(l);
  return true;
}

// Solves L L' x = b.
std::vector<double> cholesky_solve(const Matrix& l, int n, std::vector<double> b) {
  for (int i = 0; i < n; ++i) {
    for (int k = 0; k < i; ++k) b[i] -= l[i * n + k] * b[k];
    b[i] /= l[i * n + i];
  }
  for (int i = n - 1; i >= 0; --i) {
    for (int k = i + 1; k < n; ++k) b[i] -= l[k * n + i] * b[k];
    b[i] /= l[i * n + i];
  }
  return b;
}

Matrix cholesky_inverse(const Matrix& l, int n) {
  Matrix inverse(static_cast<std::size_t>(n) * n, 0.0);
  for (int column = 0; column < n; ++column) {
    std::vector<double> unit(n, 0.0);
    unit[column] = 1.0;
    const std::vector<double> x = cholesky_solve(l, n, unit);
    for (int row = 0; row < n; ++row) inverse[row * n + column] = x[row];
  }
  for (int i = 0; i < n; ++i)
    for (int j = 0; j < i; ++j) inverse[i * n + j] = inverse[j * n + i] = 0.5 * (inverse[i * n + j] + inverse[j * n + i]);
  return inverse;
}

// One observation's whitened residual and design rows (m x n).
struct Whitened {
  int count{0};
  std::array<double, 6> residual{};
  std::vector<double> design;
};

}  // namespace

BatchFitResult batch_fit(const BatchFitConfig& config, const std::vector<Observation>& observations) {
  BatchFitResult result;
  const int p = static_cast<int>(config.initial_parameters.size());
  const int n = 6 + p;
  const std::size_t count = observations.size();
  auto fail = [&](const char* message) { result.error = message; return result; };
  if (count == 0) return fail("no observations");
  if (!config.propagator) return fail("no propagator");
  if (p > 4) return fail("at most four dynamic parameters");
  if (!config.apriori_covariance.empty() && config.apriori_covariance.size() != static_cast<std::size_t>(n * n))
    return fail("the a priori covariance must be (6 + p)^2");
  const bool full = !config.observation_covariances.empty();
  if (full && config.observation_covariances.size() != count) return fail("observation covariances must be given for every observation");

  // Per-observation whitening: the Cholesky factor of its covariance (in
  // the request axes), or its component sigmas.
  std::vector<Matrix> factors(full ? count : 0);
  for (std::size_t j = 0; j < count; ++j) {
    const Observation& o = observations[j];
    const int m = o.value_count;
    if (full) {
      Matrix c = config.observation_covariances[j];
      if (c.size() != static_cast<std::size_t>(m * m)) return fail("an observation covariance must be value_count squared");
      for (int a = 0; a < m; ++a)
        for (int b = 0; b < a; ++b)
          if (std::abs(c[a * m + b] - c[b * m + a]) > 1e-12 * std::max(std::abs(c[a * m + b]), 1.0)) return fail("observation covariance is not symmetric");
      if (config.rtn_axes) {
        if (o.kind != MeasurementKind::POSITION_VELOCITY || m != 6) return fail("RTN covariances need POSITION_VELOCITY observations");
        // Rows of D are the observed state's R, T, N axes in request axes;
        // C = D' C_rtn D on position and velocity alike.
        const Vec3 r{o.value[0], o.value[1], o.value[2]}, v{o.value[3], o.value[4], o.value[5]};
        const Vec3 h = cross(r, v);
        if (!(norm(r) > 0.0) || !(norm(h) > 0.0)) return fail("RTN axes need a nonzero, non-radial observed state");
        const Vec3 R = scale(r, 1.0 / norm(r)), N = scale(h, 1.0 / norm(h)), T = cross(N, R);
        const double d[3][3] = {{R.x, R.y, R.z}, {T.x, T.y, T.z}, {N.x, N.y, N.z}};
        Matrix rotated(36, 0.0);
        for (int a = 0; a < 6; ++a)
          for (int b = 0; b < 6; ++b) {
            double sum = 0.0;
            for (int k = 0; k < 3; ++k)
              for (int l = 0; l < 3; ++l) sum += d[k][a % 3] * c[(a / 3 * 3 + k) * 6 + (b / 3 * 3 + l)] * d[l][b % 3];
            rotated[a * 6 + b] = sum;
          }
        c.swap(rotated);
      }
      if (!cholesky(c, m, &factors[j])) return fail("observation covariance is not positive definite");
    } else {
      for (int k = 0; k < m && k < 6; ++k)
        if (!(o.sigma[k] > 0.0) || !std::isfinite(o.sigma[k])) return fail("observation sigmas must be positive and finite");
    }
  }

  Matrix apriori_information;
  std::vector<double> apriori(n);
  for (int i = 0; i < 6; ++i) apriori[i] = config.initial_state[i];
  for (int i = 0; i < p; ++i) apriori[6 + i] = config.initial_parameters[i];
  if (!config.apriori_covariance.empty()) {
    Matrix l;
    if (!cholesky(config.apriori_covariance, n, &l)) return fail("the a priori covariance is not positive definite");
    apriori_information = cholesky_inverse(l, n);
  }

  std::vector<double> x = apriori;
  std::vector<bool> rejected(count, false);
  double previous_rms = 0.0;
  const int maximum = std::max(1, config.maximum_iterations);
  for (int iteration = 0; iteration < maximum; ++iteration) {
    Vector6 seed{};
    for (int i = 0; i < 6; ++i) seed[i] = x[i];
    const std::vector<double> parameters(x.begin() + 6, x.end());
    std::vector<ParameterSample> samples;
    if (!config.propagator(seed, parameters, &samples)) {
      result.pending = true;
      return result;
    }
    if (samples.size() != count) return fail("the propagator must return one sample per observation");

    std::vector<Whitened> rows(count);
    for (std::size_t j = 0; j < count; ++j) {
      const Observation& o = observations[j];
      const ParameterSample& s = samples[j];
      if (s.sensitivity.size() != static_cast<std::size_t>(6 * p)) return fail("each sample needs a 6 x p parameter sensitivity");
      const MeasurementPrediction predicted = predict_measurement(o, s.state);
      const int m = predicted.count;
      if (m == 0) return fail("unsupported measurement kind");
      if (m != o.value_count) return fail("value_count does not match the measurement kind");
      Whitened& w = rows[j];
      w.count = m;
      w.design.assign(static_cast<std::size_t>(m) * n, 0.0);
      for (int c = 0; c < m; ++c) {
        double residual = o.value[c] - predicted.value[c];
        if (o.kind == MeasurementKind::AZIMUTH_ELEVATION || o.kind == MeasurementKind::RIGHT_ASCENSION_DECLINATION)
          residual = std::remainder(residual, 2.0 * 3.141592653589793238462643383279502884);
        w.residual[c] = residual;
        for (int k = 0; k < 6; ++k) {
          const double h = predicted.jacobian[c][k];
          if (h == 0.0) continue;
          for (int col = 0; col < 6; ++col) w.design[c * n + col] += h * s.stm[k * 6 + col];
          for (int q = 0; q < p; ++q) w.design[c * n + 6 + q] += h * s.sensitivity[k * p + q];
        }
      }
      if (full) {
        // Forward substitution with the factor, residual and columns alike.
        const Matrix& l = factors[j];
        for (int c = 0; c < m; ++c) {
          for (int k = 0; k < c; ++k) {
            w.residual[c] -= l[c * m + k] * w.residual[k];
            for (int col = 0; col < n; ++col) w.design[c * n + col] -= l[c * m + k] * w.design[k * n + col];
          }
          w.residual[c] /= l[c * m + c];
          for (int col = 0; col < n; ++col) w.design[c * n + col] /= l[c * m + c];
        }
      } else {
        for (int c = 0; c < m; ++c) {
          w.residual[c] /= o.sigma[c];
          for (int col = 0; col < n; ++col) w.design[c * n + col] /= o.sigma[c];
        }
      }
    }

    // Editing against the previous iteration's weighted RMS.
    const std::vector<bool> before = rejected;
    if (config.sigma_edit_threshold > 0.0 && iteration > 0) {
      const double limit = config.sigma_edit_threshold * std::max(1.0, previous_rms);
      for (std::size_t j = 0; j < count; ++j) {
        double sum = 0.0;
        for (int c = 0; c < rows[j].count; ++c) sum += rows[j].residual[c] * rows[j].residual[c];
        rejected[j] = std::sqrt(sum / rows[j].count) > limit;
      }
    }

    Matrix normal = apriori_information.empty() ? Matrix(static_cast<std::size_t>(n) * n, 0.0) : apriori_information;
    std::vector<double> rhs(n, 0.0);
    if (!apriori_information.empty())
      for (int i = 0; i < n; ++i)
        for (int k = 0; k < n; ++k) rhs[i] += apriori_information[i * n + k] * (apriori[k] - x[k]);
    double chi_square = 0.0;
    std::size_t scalars = 0;
    for (std::size_t j = 0; j < count; ++j) {
      if (rejected[j]) continue;
      const Whitened& w = rows[j];
      for (int c = 0; c < w.count; ++c) {
        const double* a = &w.design[c * n];
        for (int i = 0; i < n; ++i) {
          rhs[i] += a[i] * w.residual[c];
          for (int k = 0; k <= i; ++k) normal[i * n + k] += a[i] * a[k];
        }
        chi_square += w.residual[c] * w.residual[c];
        ++scalars;
      }
    }
    for (int i = 0; i < n; ++i)
      for (int k = 0; k < i; ++k) normal[k * n + i] = normal[i * n + k];
    if (scalars == 0) return fail("every observation was edited");
    Matrix l;
    if (!cholesky(normal, n, &l)) return fail("the normal matrix is singular: the state and parameters are not observable");
    const std::vector<double> dx = cholesky_solve(l, n, rhs);
    double step = 0.0;
    for (int i = 0; i < n; ++i)
      for (int k = 0; k < n; ++k) step += dx[i] * normal[i * n + k] * dx[k];
    step = std::sqrt(std::max(step, 0.0) / n);
    previous_rms = std::sqrt(chi_square / scalars);
    for (int i = 0; i < n; ++i) x[i] += dx[i];
    result.iterations = iteration + 1;
    const bool converged = step < config.correction_tolerance && rejected == before;
    if (!converged && iteration + 1 < maximum) continue;

    // Final: the corrected estimate, its formal covariance and the residuals
    // linearized at the correction.
    result.converged = converged;
    result.estimate = x;
    result.covariance = cholesky_inverse(l, n);
    result.chi_square = 0.0;
    result.measurement_count = scalars;
    for (std::size_t j = 0; j < count; ++j) {
      const Whitened& w = rows[j];
      for (int c = 0; c < w.count; ++c) {
        double r = w.residual[c];
        for (int i = 0; i < n; ++i) r -= w.design[c * n + i] * dx[i];
        result.whitened_residuals.push_back(r);
        if (!rejected[j]) result.chi_square += r * r;
      }
      if (rejected[j]) result.rejected_indices.push_back(j);
    }
    result.degrees_of_freedom = scalars > static_cast<std::size_t>(n) ? scalars - n : 1;
    result.reduced_chi_square = result.chi_square / result.degrees_of_freedom;
    result.weighted_rms = std::sqrt(result.chi_square / scalars);
    result.valid = true;
    return result;
  }
  return fail("no iteration ran");
}

}  // namespace sdn::estimation
