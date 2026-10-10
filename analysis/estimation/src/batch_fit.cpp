#include "estimation.hpp"
#include "teag.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

// Batch weighted least squares of [state at the configuration epoch,
// dynamic parameters, measurement parameters] (Tapley, Schutz & Born 2004,
// Statistical Orbit Determination, sections 4.3-4.6 and 6.3): Gauss-Newton
// on the whitened residuals with the design matrix H [Phi S] from the
// caller's propagator, the normal matrix N = P0^-1 + sum A' A and the formal
// covariance N^-1.
//
// Version 2. With none of its options this is version 1, operation for
// operation:
// - a dynamic parameter estimated as its logarithm, or bounded: a step that
//   leaves the bounds is projected onto them, and a parameter held at a
//   bound is released when its multiplier points back inside, so the
//   propagator never receives a value outside;
// - Levenberg-Marquardt damping (Marquardt's diagonal), judged on the cost;
// - bias, drift and time-bias states of observation groups: a time bias by
//   propagating to the shifted epoch, its partial by a central difference of
//   the measurement model over two more samples;
// - consider parameters (Schmidt): P + S Pc S', S = -P Hx' W Hc;
// - covariance blocks across observations, optionally regularized by an
//   eigenvalue floor on their correlation matrix.
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

constexpr double kTwoPi = 2.0 * 3.141592653589793238462643383279502884;
constexpr double kInfinity = std::numeric_limits<double>::infinity();
// Half-width (s) of the central difference giving a time bias's partial:
// its truncation error is (1/6) d4h/dt4, about 3e-5 of the partial for a
// LEO range rate at closest approach.
constexpr double kTimeBiasStep = 1.0;
constexpr int kMaximumDimension = 512;
constexpr double kMaximumDamping = 1.0e12;
// A LOGARITHM parameter changes by at most a factor of ten per step (a trust
// region in ln p): an undamped Gauss-Newton step in ln p that the
// unconstrained problem would take past zero is many orders of magnitude.
const double kMaximumLogStep = std::log(10.0);

bool is_angle(MeasurementKind kind) {
  return kind == MeasurementKind::AZIMUTH_ELEVATION || kind == MeasurementKind::RIGHT_ASCENSION_DECLINATION;
}

// Rows R, T, N (in request axes) of the radial, transverse and normal axes
// of a position and velocity.
bool rtn_rows(const Vec3& r, const Vec3& v, double d[3][3]) {
  const Vec3 h = cross(r, v);
  if (!(norm(r) > 0.0) || !(norm(h) > 0.0)) return false;
  const Vec3 R = scale(r, 1.0 / norm(r)), N = scale(h, 1.0 / norm(h)), T = cross(N, R);
  const double rows[3][3] = {{R.x, R.y, R.z}, {T.x, T.y, T.z}, {N.x, N.y, N.z}};
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) d[i][j] = rows[i][j];
  return true;
}

struct Axes {
  bool rotated{false};
  double d[3][3]{};
};

// Observations whitened together: one observation (its sigmas or its
// covariance) or a covariance block.
struct Unit {
  std::vector<std::size_t> members;
  std::vector<int> offsets;  // first row of each member
  int dimension{0};
  int block{-1};
  bool covariance{false};
  bool varying{false};  // RTN axes from the predicted velocity (POSITION_VECTOR)
  Matrix stated;        // in the stated axes, regularized
  Matrix factor;        // Cholesky factor in request axes (fixed axes)
};

// C' = D' C D with D block-diagonal: each member's RTN rows on each of its
// 3-vectors (POSITION_VELOCITY: position and velocity; POSITION_VECTOR:
// position), or the identity for the other kinds.
Matrix to_request_axes(const Matrix& c, const Unit& unit, const std::vector<Axes>& axes) {
  const int m = unit.dimension;
  std::vector<int> member(m), local(m);
  for (std::size_t i = 0; i < unit.members.size(); ++i) {
    const int end = i + 1 < unit.members.size() ? unit.offsets[i + 1] : m;
    for (int a = unit.offsets[i]; a < end; ++a) {
      member[a] = static_cast<int>(i);
      local[a] = a - unit.offsets[i];
    }
  }
  Matrix out(static_cast<std::size_t>(m) * m, 0.0);
  for (int a = 0; a < m; ++a) {
    const Axes& da = axes[member[a]];
    const int ra = unit.offsets[member[a]] + local[a] / 3 * 3;
    for (int b = 0; b < m; ++b) {
      const Axes& db = axes[member[b]];
      const int rb = unit.offsets[member[b]] + local[b] / 3 * 3;
      double sum = 0.0;
      if (da.rotated && db.rotated) {
        for (int k = 0; k < 3; ++k)
          for (int l = 0; l < 3; ++l) sum += da.d[k][local[a] % 3] * c[(ra + k) * m + (rb + l)] * db.d[l][local[b] % 3];
      } else if (da.rotated) {
        for (int k = 0; k < 3; ++k) sum += da.d[k][local[a] % 3] * c[(ra + k) * m + b];
      } else if (db.rotated) {
        for (int l = 0; l < 3; ++l) sum += c[a * m + (rb + l)] * db.d[l][local[b] % 3];
      } else {
        sum = c[a * m + b];
      }
      out[a * m + b] = sum;
    }
  }
  return out;
}

bool symmetric(const Matrix& c, int m) {
  for (int a = 0; a < m; ++a)
    for (int b = 0; b < a; ++b)
      if (std::abs(c[a * m + b] - c[b * m + a]) > 1e-12 * std::max(std::abs(c[a * m + b]), 1.0)) return false;
  return true;
}

// Raises the eigenvalues of the correlation matrix R of c below `floor` to
// it (the nearest matrix with that spectral floor, in the Frobenius norm)
// and rescales the result to unit diagonal, so the sigmas are unchanged.
bool regularize(Matrix* c, int m, double floor, CovarianceRegularization* out) {
  std::vector<double> s(m);
  for (int i = 0; i < m; ++i) {
    const double v = (*c)[i * m + i];
    if (!(v > 0.0) || !std::isfinite(v)) return false;
    s[i] = std::sqrt(v);
  }
  teag::Vec r(static_cast<std::size_t>(m) * m);
  for (int i = 0; i < m; ++i)
    for (int j = 0; j < m; ++j) r[i * m + j] = i == j ? 1.0 : 0.5 * ((*c)[i * m + j] + (*c)[j * m + i]) / (s[i] * s[j]);
  teag::Vec values, vectors;
  if (!teag::symmetric_eigen(r, m, &values, &vectors)) return false;
  out->dimension = m;
  out->minimum_eigenvalue = values.front();
  out->raised = 0;
  for (double v : values)
    if (v < floor) ++out->raised;
  if (out->raised == 0) return true;
  teag::Vec raised(r.size(), 0.0);
  for (int k = 0; k < m; ++k) {
    const double v = std::max(values[k], floor);
    for (int i = 0; i < m; ++i)
      for (int j = 0; j < m; ++j) raised[i * m + j] += vectors[i * m + k] * v * vectors[j * m + k];
  }
  double change = 0.0, size = 0.0, largest = 0.0;
  for (int i = 0; i < m; ++i)
    for (int j = 0; j < m; ++j) {
      const double rij = i == j ? 1.0
          : 0.5 * (raised[i * m + j] + raised[j * m + i]) / std::sqrt(raised[i * m + i] * raised[j * m + j]);
      const double d = rij - r[i * m + j];
      change += d * d;
      size += r[i * m + j] * r[i * m + j];
      largest = std::max(largest, std::abs(d));
      if (i != j) (*c)[i * m + j] = s[i] * rij * s[j];
    }
  out->frobenius_change = std::sqrt(change / size);
  out->maximum_correlation_change = largest;
  return true;
}

// Whitened residuals and design rows (dimension x n) of every unit at one
// point.
struct Evaluation {
  std::vector<Matrix> design;
  std::vector<std::vector<double>> residual;
};

}  // namespace

BatchFitResult batch_fit(const BatchFitConfig& config, const std::vector<Observation>& observations) {
  BatchFitResult result;
  const int p = static_cast<int>(config.initial_parameters.size());
  const int q = static_cast<int>(config.measurement_parameters.size());
  const int s = 6 + p;  // state and dynamic parameters
  const int n = s + q;
  const std::size_t count = observations.size();
  auto fail = [&](const char* message) { result.error = message; return result; };
  if (count == 0) return fail("no observations");
  if (!config.propagator) return fail("no propagator");
  if (n > kMaximumDimension) return fail("at most 512 state, dynamic and measurement parameters");
  if (!config.apriori_covariance.empty() && config.apriori_covariance.size() != static_cast<std::size_t>(s * s))
    return fail("the a priori covariance must be (6 + p)^2");
  auto per_parameter = [&](std::size_t size) { return size == 0 || size == static_cast<std::size_t>(p); };
  if (!per_parameter(config.transforms.size()) || !per_parameter(config.lower_bounds.size()) ||
      !per_parameter(config.upper_bounds.size()) || !per_parameter(config.consider.size()))
    return fail("parameter transforms, bounds and consider flags take one entry per dynamic parameter");

  // Dynamic parameters: transform, bounds (internal coordinates) and role.
  std::vector<bool> logarithm(p, false), consider(n, false);
  std::vector<double> lower(n, -kInfinity), upper(n, kInfinity);
  bool bounded = false;
  for (int i = 0; i < p; ++i) {
    const int g = 6 + i;
    const double value = config.initial_parameters[i];
    const double lo = config.lower_bounds.empty() || !std::isfinite(config.lower_bounds[i]) ? -kInfinity : config.lower_bounds[i];
    const double hi = config.upper_bounds.empty() || !std::isfinite(config.upper_bounds[i]) ? kInfinity : config.upper_bounds[i];
    if (!config.transforms.empty() && config.transforms[i] != ParameterTransform::IDENTITY &&
        config.transforms[i] != ParameterTransform::LOGARITHM) return fail("unknown parameter transform");
    logarithm[i] = !config.transforms.empty() && config.transforms[i] == ParameterTransform::LOGARITHM;
    consider[g] = !config.consider.empty() && config.consider[i];
    if (!std::isfinite(value)) return fail("parameter values must be finite");
    if (!(lo < hi)) return fail("a parameter's lower bound must be below its upper bound");
    if (value < lo || value > hi) return fail("a parameter's initial value is outside its bounds");
    if (consider[g] && (logarithm[i] || lo > -kInfinity || hi < kInfinity))
      return fail("a consider parameter takes no transform or bounds");
    if (logarithm[i]) {
      if (!(value > 0.0)) return fail("a LOGARITHM parameter must start positive");
      lower[g] = lo > 0.0 ? std::log(lo) : -kInfinity;
      upper[g] = hi < kInfinity ? std::log(hi) : kInfinity;
    } else {
      lower[g] = lo;
      upper[g] = hi;
    }
    bounded = bounded || logarithm[i] || lo > -kInfinity || hi < kInfinity;
  }

  // Measurement parameters: the terms of each observation.
  struct Terms {
    int time_bias{-1};
    std::vector<int> bias, drift;  // parameter indices
  };
  std::vector<Terms> terms(count);
  std::vector<double> reference(n, 0.0);  // DRIFT: zero-drift epoch (s)
  for (int k = 0; k < q; ++k) {
    const MeasurementParameter& mp = config.measurement_parameters[k];
    const int g = s + k;
    if (mp.kind != MeasurementParameterKind::BIAS && mp.kind != MeasurementParameterKind::DRIFT &&
        mp.kind != MeasurementParameterKind::TIME_BIAS) return fail("unknown measurement parameter kind");
    if (!std::isfinite(mp.value) || !std::isfinite(mp.sigma) || mp.sigma < 0.0)
      return fail("a measurement parameter needs a finite value and a non-negative sigma");
    if (mp.consider && !(mp.sigma > 0.0)) return fail("a consider parameter needs an a priori sigma");
    if (mp.observations.empty()) return fail("a measurement parameter needs observations");
    consider[g] = mp.consider;
    double earliest = kInfinity;
    for (std::size_t at = 0; at < mp.observations.size(); ++at) {
      const std::size_t j = mp.observations[at];
      if (j >= count || (at > 0 && j <= mp.observations[at - 1]))
        return fail("a measurement parameter's observations must be ascending indices");
      earliest = std::min(earliest, observations[j].epoch_seconds);
      Terms& t = terms[j];
      if (mp.kind == MeasurementParameterKind::TIME_BIAS) {
        if (t.time_bias >= 0) return fail("an observation takes at most one time bias");
        t.time_bias = g;
        continue;
      }
      if (mp.component < 0 || mp.component >= observations[j].value_count)
        return fail("a bias or drift component is beyond its observation's values");
      std::vector<int>& list = mp.kind == MeasurementParameterKind::BIAS ? t.bias : t.drift;
      for (int other : list)
        if (config.measurement_parameters[other - s].component == mp.component)
          return fail("an observation component takes at most one bias and one drift");
      list.push_back(g);
    }
    reference[g] = mp.has_reference ? mp.reference_seconds : earliest;
  }
  std::vector<int> estimated, considered;
  for (int g = 0; g < n; ++g) (consider[g] ? considered : estimated).push_back(g);
  const int ne = static_cast<int>(estimated.size());
  const int nc = static_cast<int>(considered.size());

  // A priori: the information of the estimated block of [state, dynamic
  // parameters] (physical units), and the consider covariance Pc.
  std::vector<int> prior_index;  // estimated among the first s
  for (int g = 0; g < s; ++g)
    if (!consider[g]) prior_index.push_back(g);
  const int np = static_cast<int>(prior_index.size());
  Matrix information;
  if (!config.apriori_covariance.empty()) {
    const Matrix& p0 = config.apriori_covariance;
    Matrix block;
    if (np == s) {
      block = p0;
    } else {
      block.resize(static_cast<std::size_t>(np) * np);
      for (int a = 0; a < np; ++a)
        for (int b = 0; b < np; ++b) block[a * np + b] = p0[prior_index[a] * s + prior_index[b]];
      for (int g = 0; g < s; ++g)
        for (int e : prior_index)
          if (consider[g] && (p0[g * s + e] != 0.0 || p0[e * s + g] != 0.0))
            return fail("a consider parameter must be uncorrelated a priori with the estimated parameters");
    }
    Matrix l;
    if (!cholesky(block, np, &l)) return fail("the a priori covariance is not positive definite");
    information = cholesky_inverse(l, np);
  } else {
    for (int g = 6; g < s; ++g)
      if (consider[g]) return fail("a consider dynamic parameter needs apriori_covariance");
  }
  Matrix pc(static_cast<std::size_t>(nc) * nc, 0.0);
  for (int a = 0; a < nc; ++a)
    for (int b = 0; b < nc; ++b) {
      const int ga = considered[a], gb = considered[b];
      if (ga < s && gb < s) pc[a * nc + b] = config.apriori_covariance[ga * s + gb];
      else if (ga == gb) pc[a * nc + b] = config.measurement_parameters[ga - s].sigma * config.measurement_parameters[ga - s].sigma;
    }
  if (nc > 0) {
    Matrix l;
    if (!cholesky(pc, nc, &l)) return fail("the consider parameters' a priori covariance is not positive definite");
  }

  // Whitening units.
  const bool full = !config.observation_covariances.empty();
  const bool blocks = !config.covariance_blocks.empty();
  if (full && blocks) return fail("observation_covariances and covariance_blocks are exclusive");
  if (full && config.observation_covariances.size() != count) return fail("observation covariances must be given for every observation");
  std::vector<int> unit_of(count, -1), offset_of(count, 0);
  std::vector<Unit> units;
  auto axes_of = [&](const Observation& o, Axes* axes, bool* varying) -> bool {
    *varying = false;
    if (!config.rtn_axes) return true;
    if (o.kind == MeasurementKind::POSITION_VELOCITY && o.value_count == 6) {
      axes->rotated = true;
      return rtn_rows({o.value[0], o.value[1], o.value[2]}, {o.value[3], o.value[4], o.value[5]}, axes->d);
    }
    if (o.kind == MeasurementKind::POSITION_VECTOR && o.value_count == 3) *varying = true;
    return true;
  };
  auto add_unit = [&](Unit unit, const Matrix* stated) -> bool {
    std::vector<Axes> axes(unit.members.size());
    for (std::size_t i = 0; i < unit.members.size(); ++i) {
      bool varying = false;
      if (!axes_of(observations[unit.members[i]], &axes[i], &varying)) {
        result.error = "RTN axes need a nonzero, non-radial observed state";
        return false;
      }
      unit.varying = unit.varying || varying;
    }
    if (stated != nullptr) {
      unit.covariance = true;
      unit.stated = *stated;
      if (!unit.varying) {
        bool rotated = false;
        for (const Axes& a : axes) rotated = rotated || a.rotated;
        const Matrix c = rotated ? to_request_axes(unit.stated, unit, axes) : unit.stated;
        if (!cholesky(c, unit.dimension, &unit.factor)) {
          result.error = unit.block >= 0 ? "a covariance block is not positive definite" : "observation covariance is not positive definite";
          return false;
        }
      }
    }
    for (std::size_t i = 0; i < unit.members.size(); ++i) {
      unit_of[unit.members[i]] = static_cast<int>(units.size());
      offset_of[unit.members[i]] = unit.offsets[i];
    }
    units.push_back(std::move(unit));
    return true;
  };
  auto stated_covariance = [&](Matrix c, int m, int block, std::size_t first, Matrix* out) -> bool {
    if (!symmetric(c, m)) {
      result.error = block >= 0 ? "a covariance block is not symmetric" : "observation covariance is not symmetric";
      return false;
    }
    if (config.regularize) {
      CovarianceRegularization diagnostic;
      diagnostic.block = block;
      diagnostic.observation = first;
      if (!regularize(&c, m, config.correlation_floor, &diagnostic)) {
        result.error = "a covariance to regularize needs positive finite variances";
        return false;
      }
      if (diagnostic.raised > 0) result.regularizations.push_back(diagnostic);
    }
    *out = std::move(c);
    return true;
  };
  if (config.regularize && !(config.correlation_floor > 0.0 && config.correlation_floor < 1.0))
    return fail("correlation_floor must be in (0, 1)");
  std::vector<bool> in_block(count, false);
  for (std::size_t b = 0; b < config.covariance_blocks.size(); ++b) {
    const CovarianceBlock& block = config.covariance_blocks[b];
    Unit unit;
    unit.block = static_cast<int>(b);
    if (block.observations.empty()) return fail("a covariance block needs observations");
    for (std::size_t at = 0; at < block.observations.size(); ++at) {
      const std::size_t j = block.observations[at];
      if (j >= count || (at > 0 && j <= block.observations[at - 1]))
        return fail("a covariance block's observations must be ascending indices");
      if (in_block[j]) return fail("an observation is in at most one covariance block");
      in_block[j] = true;
      unit.members.push_back(j);
      unit.offsets.push_back(unit.dimension);
      unit.dimension += observations[j].value_count;
    }
    if (block.covariance.size() != static_cast<std::size_t>(unit.dimension) * unit.dimension)
      return fail("a covariance block must be (sum of its value counts)^2");
    Matrix stated;
    if (!stated_covariance(block.covariance, unit.dimension, unit.block, unit.members.front(), &stated)) return result;
    if (!add_unit(std::move(unit), &stated)) return result;
  }
  for (std::size_t j = 0; j < count; ++j) {
    if (in_block[j]) continue;
    const Observation& o = observations[j];
    const int m = o.value_count;
    Unit unit;
    unit.members.push_back(j);
    unit.offsets.push_back(0);
    unit.dimension = m;
    if (full) {
      if (config.observation_covariances[j].size() != static_cast<std::size_t>(m * m)) return fail("an observation covariance must be value_count squared");
      Matrix stated;
      if (!stated_covariance(config.observation_covariances[j], m, -1, j, &stated)) return result;
      if (!add_unit(std::move(unit), &stated)) return result;
    } else {
      for (int k = 0; k < m && k < 6; ++k)
        if (!(o.sigma[k] > 0.0) || !std::isfinite(o.sigma[k])) return fail("observation sigmas must be positive and finite");
      if (!add_unit(std::move(unit), nullptr)) return result;
    }
  }
  // Units in the order of their first observation.
  if (blocks) {
    std::vector<int> order(units.size());
    for (std::size_t i = 0; i < order.size(); ++i) order[i] = static_cast<int>(i);
    std::stable_sort(order.begin(), order.end(), [&](int a, int b) { return units[a].members.front() < units[b].members.front(); });
    std::vector<Unit> sorted;
    for (int i : order) sorted.push_back(std::move(units[i]));
    units = std::move(sorted);
    for (std::size_t u = 0; u < units.size(); ++u)
      for (std::size_t j : units[u].members) unit_of[j] = static_cast<int>(u);
  }
  const std::size_t unit_count = units.size();

  std::vector<double> apriori(s);
  for (int i = 0; i < 6; ++i) apriori[i] = config.initial_state[i];
  for (int i = 0; i < p; ++i) apriori[6 + i] = config.initial_parameters[i];
  std::vector<double> x(n);
  for (int g = 0; g < s; ++g) x[g] = g >= 6 && logarithm[g - 6] ? std::log(apriori[g]) : apriori[g];
  for (int k = 0; k < q; ++k) x[s + k] = config.measurement_parameters[k].value;
  auto physical = [&](const std::vector<double>& xi, int g) {
    return g >= 6 && g < s && logarithm[g - 6] ? std::exp(xi[g]) : xi[g];
  };

  // 1: evaluated; 0: the propagator has not answered; -1: failed.
  auto evaluate = [&](const std::vector<double>& xi, Evaluation* ev) -> int {
    Vector6 seed{};
    for (int i = 0; i < 6; ++i) seed[i] = xi[i];
    std::vector<double> parameters(p);
    for (int i = 0; i < p; ++i) parameters[i] = physical(xi, 6 + i);
    std::vector<EpochRequest> requests;
    requests.reserve(count);
    std::vector<std::size_t> primary(count), minus(count), plus(count);
    for (std::size_t j = 0; j < count; ++j) {
      const int tb = terms[j].time_bias;
      const double tau = tb >= 0 ? xi[tb] : 0.0;
      primary[j] = requests.size();
      requests.push_back({j, tau});
      if (tb < 0) continue;
      minus[j] = requests.size();
      requests.push_back({j, tau - kTimeBiasStep});
      plus[j] = requests.size();
      requests.push_back({j, tau + kTimeBiasStep});
    }
    std::vector<ParameterSample> samples;
    if (!config.propagator(seed, parameters, requests, &samples)) return 0;
    if (samples.size() != requests.size()) {
      result.error = "the propagator must return one sample per observation";
      return -1;
    }
    auto shifted = [](const Observation& o, double tau) {
      Observation out = o;
      out.station_position_m = add(o.station_position_m, scale(o.station_velocity_mps, tau));
      out.remote_position_m = add(o.remote_position_m, scale(o.remote_velocity_mps, tau));
      return out;
    };
    ev->design.assign(unit_count, Matrix());
    ev->residual.assign(unit_count, std::vector<double>());
    for (std::size_t u = 0; u < unit_count; ++u) {
      ev->design[u].assign(static_cast<std::size_t>(units[u].dimension) * n, 0.0);
      ev->residual[u].assign(units[u].dimension, 0.0);
    }
    for (std::size_t j = 0; j < count; ++j) {
      const Observation& o = observations[j];
      const ParameterSample& sample = samples[primary[j]];
      if (sample.sensitivity.size() != static_cast<std::size_t>(6 * p)) {
        result.error = "each sample needs a 6 x p parameter sensitivity";
        return -1;
      }
      const Terms& t = terms[j];
      const double tau = t.time_bias >= 0 ? xi[t.time_bias] : 0.0;
      const MeasurementPrediction predicted = predict_measurement(t.time_bias >= 0 ? shifted(o, tau) : o, sample.state);
      const int m = predicted.count;
      if (m == 0) { result.error = "unsupported measurement kind"; return -1; }
      if (m != o.value_count) { result.error = "value_count does not match the measurement kind"; return -1; }
      MeasurementPrediction before{}, after{};
      if (t.time_bias >= 0) {
        if (samples[minus[j]].sensitivity.size() != static_cast<std::size_t>(6 * p) ||
            samples[plus[j]].sensitivity.size() != static_cast<std::size_t>(6 * p)) {
          result.error = "each sample needs a 6 x p parameter sensitivity";
          return -1;
        }
        before = predict_measurement(shifted(o, tau - kTimeBiasStep), samples[minus[j]].state);
        after = predict_measurement(shifted(o, tau + kTimeBiasStep), samples[plus[j]].state);
      }
      const std::size_t u = static_cast<std::size_t>(unit_of[j]);
      const int offset = offset_of[j];
      for (int c = 0; c < m; ++c) {
        double residual = o.value[c] - predicted.value[c];
        for (int b : t.bias)
          if (config.measurement_parameters[b - s].component == c) residual -= xi[b];
        for (int d : t.drift)
          if (config.measurement_parameters[d - s].component == c) residual -= xi[d] * (o.epoch_seconds - reference[d]);
        if (is_angle(o.kind)) residual = std::remainder(residual, kTwoPi);
        ev->residual[u][offset + c] = residual;
        double* row = &ev->design[u][static_cast<std::size_t>(offset + c) * n];
        for (int k = 0; k < 6; ++k) {
          const double h = predicted.jacobian[c][k];
          if (h == 0.0) continue;
          for (int col = 0; col < 6; ++col) row[col] += h * sample.stm[k * 6 + col];
          for (int r = 0; r < p; ++r) row[6 + r] += h * sample.sensitivity[k * p + r];
        }
        for (int r = 0; r < p; ++r)
          if (logarithm[r]) row[6 + r] *= parameters[r];
        for (int b : t.bias)
          if (config.measurement_parameters[b - s].component == c) row[b] += 1.0;
        for (int d : t.drift)
          if (config.measurement_parameters[d - s].component == c) row[d] += o.epoch_seconds - reference[d];
        if (t.time_bias >= 0) {
          double change = after.value[c] - before.value[c];
          if (is_angle(o.kind)) change = std::remainder(change, kTwoPi);
          row[t.time_bias] += change / (2.0 * kTimeBiasStep);
        }
      }
    }
    // Whitening, unit by unit.
    for (std::size_t u = 0; u < unit_count; ++u) {
      const Unit& unit = units[u];
      const int m = unit.dimension;
      std::vector<double>& w = ev->residual[u];
      Matrix& design = ev->design[u];
      if (!unit.covariance) {
        const Observation& o = observations[unit.members.front()];
        for (int c = 0; c < m; ++c) {
          w[c] /= o.sigma[c];
          for (int col = 0; col < n; ++col) design[c * n + col] /= o.sigma[c];
        }
        continue;
      }
      Matrix varying;
      const Matrix* l = &unit.factor;
      if (unit.varying) {
        std::vector<Axes> axes(unit.members.size());
        for (std::size_t i = 0; i < unit.members.size(); ++i) {
          const std::size_t j = unit.members[i];
          const Observation& o = observations[j];
          bool unused = false;
          axes_of(o, &axes[i], &unused);
          if (o.kind == MeasurementKind::POSITION_VECTOR) {
            const CartesianState& predicted = samples[primary[j]].state;
            axes[i].rotated = true;
            if (!rtn_rows({o.value[0], o.value[1], o.value[2]},
                          {predicted.value[3], predicted.value[4], predicted.value[5]}, axes[i].d)) {
              result.error = "RTN axes need a nonzero, non-radial observed state";
              return -1;
            }
          }
        }
        if (!cholesky(to_request_axes(unit.stated, unit, axes), m, &varying)) {
          result.error = unit.block >= 0 ? "a covariance block is not positive definite" : "observation covariance is not positive definite";
          return -1;
        }
        l = &varying;
      }
      // Forward substitution with the factor, residual and columns alike.
      for (int c = 0; c < m; ++c) {
        for (int k = 0; k < c; ++k) {
          w[c] -= (*l)[c * m + k] * w[k];
          for (int col = 0; col < n; ++col) design[c * n + col] -= (*l)[c * m + k] * design[k * n + col];
        }
        w[c] /= (*l)[c * m + c];
        for (int col = 0; col < n; ++col) design[c * n + col] /= (*l)[c * m + c];
      }
    }
    return 1;
  };

  // Normal equations at a point over all n columns: the a priori of the
  // estimated parameters, then the accepted units' data.
  auto build = [&](const std::vector<double>& xi, const Evaluation& ev, const std::vector<bool>& rejected,
                   Matrix* normal, std::vector<double>* rhs, double* chi_square, std::size_t* scalars) {
    normal->assign(static_cast<std::size_t>(n) * n, 0.0);
    rhs->assign(n, 0.0);
    if (!information.empty()) {
      std::vector<double> jacobian(np, 1.0), difference(np);
      for (int a = 0; a < np; ++a) {
        const int g = prior_index[a];
        if (g >= 6 && logarithm[g - 6]) jacobian[a] = physical(xi, g);
        difference[a] = apriori[g] - physical(xi, g);
      }
      if (np == n && !bounded) {
        *normal = information;
      } else {
        for (int a = 0; a < np; ++a)
          for (int b = 0; b < np; ++b)
            (*normal)[prior_index[a] * n + prior_index[b]] = jacobian[a] * information[a * np + b] * jacobian[b];
      }
      for (int a = 0; a < np; ++a)
        for (int b = 0; b < np; ++b)
          (*rhs)[prior_index[a]] += (bounded ? jacobian[a] : 1.0) * information[a * np + b] * difference[b];
    }
    for (int k = 0; k < q; ++k) {
      const MeasurementParameter& mp = config.measurement_parameters[k];
      const int g = s + k;
      if (consider[g] || !(mp.sigma > 0.0)) continue;
      const double weight = 1.0 / (mp.sigma * mp.sigma);
      (*normal)[g * n + g] += weight;
      (*rhs)[g] += weight * (mp.value - xi[g]);
    }
    *chi_square = 0.0;
    *scalars = 0;
    for (std::size_t u = 0; u < unit_count; ++u) {
      if (rejected[u]) continue;
      const std::vector<double>& w = ev.residual[u];
      for (int c = 0; c < units[u].dimension; ++c) {
        const double* a = &ev.design[u][static_cast<std::size_t>(c) * n];
        for (int i = 0; i < n; ++i) {
          (*rhs)[i] += a[i] * w[c];
          for (int k = 0; k <= i; ++k) (*normal)[i * n + k] += a[i] * a[k];
        }
        *chi_square += w[c] * w[c];
        ++*scalars;
      }
    }
    for (int i = 0; i < n; ++i)
      for (int k = 0; k < i; ++k) (*normal)[k * n + i] = (*normal)[i * n + k];
  };
  auto data_cost = [&](const Evaluation& ev, const std::vector<bool>& rejected) {
    double cost = 0.0;
    for (std::size_t u = 0; u < unit_count; ++u)
      if (!rejected[u])
        for (double w : ev.residual[u]) cost += w * w;
    return cost;
  };
  auto prior_cost = [&](const std::vector<double>& xi) {
    double cost = 0.0;
    if (!information.empty())
      for (int a = 0; a < np; ++a)
        for (int b = 0; b < np; ++b)
          cost += (apriori[prior_index[a]] - physical(xi, prior_index[a])) * information[a * np + b] *
                  (apriori[prior_index[b]] - physical(xi, prior_index[b]));
    for (int k = 0; k < q; ++k) {
      const MeasurementParameter& mp = config.measurement_parameters[k];
      if (consider[s + k] || !(mp.sigma > 0.0)) continue;
      const double z = (mp.value - xi[s + k]) / mp.sigma;
      cost += z * z;
    }
    return cost;
  };
  // The (damped) step over the estimated parameters with those held at a
  // bound fixed; a held parameter whose multiplier points inside is
  // released, one at a time.
  auto solve = [&](const Matrix& normal, const std::vector<double>& rhs, double damping, std::vector<int> held,
                   std::vector<double>* dx) -> bool {
    for (;;) {
      std::vector<int> free;
      for (int a = 0; a < ne; ++a)
        if (held[a] == 0) free.push_back(a);
      const int nf = static_cast<int>(free.size());
      Matrix reduced(static_cast<std::size_t>(nf) * nf);
      std::vector<double> g(nf);
      for (int i = 0; i < nf; ++i) {
        g[i] = rhs[free[i]];
        for (int k = 0; k < nf; ++k) reduced[i * nf + k] = normal[free[i] * ne + free[k]];
        if (damping > 0.0) reduced[i * nf + i] += damping * normal[free[i] * ne + free[i]];
      }
      Matrix l;
      if (!cholesky(reduced, nf, &l)) return false;
      const std::vector<double> step = cholesky_solve(l, nf, g);
      dx->assign(ne, 0.0);
      for (int i = 0; i < nf; ++i) (*dx)[free[i]] = step[i];
      int release = -1;
      double strongest = 0.0;
      for (int a = 0; a < ne; ++a) {
        if (held[a] == 0) continue;
        double multiplier = rhs[a];
        for (int i = 0; i < nf; ++i) multiplier -= normal[a * ne + free[i]] * step[i];
        if ((held[a] < 0 && multiplier > 0.0) || (held[a] > 0 && multiplier < 0.0)) {
          if (std::abs(multiplier) > strongest) {
            strongest = std::abs(multiplier);
            release = a;
          }
        }
      }
      if (release < 0) return true;
      held[release] = 0;
    }
  };
  // The point after a step, projected onto the bounds; `taken` is the step
  // actually taken.
  auto advance = [&](const std::vector<double>& xi, const std::vector<double>& dx, std::vector<double>* taken) {
    std::vector<double> next = xi;
    taken->assign(ne, 0.0);
    for (int a = 0; a < ne; ++a) {
      const int g = estimated[a];
      next[g] = xi[g] + dx[a];
      (*taken)[a] = dx[a];
      if (next[g] < lower[g] || next[g] > upper[g]) {
        next[g] = std::min(std::max(next[g], lower[g]), upper[g]);
        (*taken)[a] = next[g] - xi[g];
      }
    }
    return next;
  };
  // Each LOGARITHM parameter's step clamped to +/-kMaximumLogStep (a box
  // trust region in ln p); the other parameters take their full step, so the
  // state keeps converging while p moves at most tenfold.
  auto limited = [&](std::vector<double> dx) {
    for (int a = 0; a < ne; ++a) {
      const int g = estimated[a];
      if (g >= 6 && g < s && logarithm[g - 6]) dx[a] = std::min(std::max(dx[a], -kMaximumLogStep), kMaximumLogStep);
    }
    return dx;
  };
  auto held_at = [&](const std::vector<double>& xi) {
    std::vector<int> held(ne, 0);
    for (int a = 0; a < ne; ++a) {
      const int g = estimated[a];
      if (xi[g] <= lower[g]) held[a] = -1;
      else if (xi[g] >= upper[g]) held[a] = 1;
    }
    return held;
  };

  // The result: the corrected estimate, its formal covariance and the
  // residuals linearized at the correction.
  auto finish = [&](const std::vector<double>& estimate, const Evaluation& ev, const Matrix& normal_full,
                    const Matrix& normal, const std::vector<double>& taken, const std::vector<bool>& rejected,
                    std::size_t scalars, bool converged) {
    Matrix l;
    if (!cholesky(normal, ne, &l)) return fail("the normal matrix is singular: the state and parameters are not observable");
    const Matrix pe = cholesky_inverse(l, ne);
    result.converged = converged;
    result.estimate.resize(n);
    for (int g = 0; g < n; ++g) result.estimate[g] = physical(estimate, g);
    std::vector<double> jacobian(n, 1.0);
    for (int i = 0; i < p; ++i)
      if (logarithm[i]) jacobian[6 + i] = result.estimate[6 + i];
    result.chi_square = 0.0;
    result.measurement_count = scalars;
    for (std::size_t j = 0; j < count; ++j) {
      const std::size_t u = static_cast<std::size_t>(unit_of[j]);
      for (int c = 0; c < observations[j].value_count; ++c) {
        const int row = offset_of[j] + c;
        double r = ev.residual[u][row];
        for (int a = 0; a < ne; ++a) r -= ev.design[u][static_cast<std::size_t>(row) * n + estimated[a]] * taken[a];
        result.whitened_residuals.push_back(r);
        if (!rejected[u]) result.chi_square += r * r;
      }
      if (rejected[u]) result.rejected_indices.push_back(j);
    }
    result.degrees_of_freedom = scalars > static_cast<std::size_t>(ne) ? scalars - ne : 1;
    result.reduced_chi_square = result.chi_square / result.degrees_of_freedom;
    result.weighted_rms = std::sqrt(result.chi_square / scalars);
    result.measurement_parameter_count = static_cast<std::size_t>(q);

    // Covariances in the physical parameters (J P J', J = d value / d internal).
    const bool layout = ne == n && !bounded;
    auto physical_covariance = [&](const Matrix& internal) {
      Matrix out = internal;
      if (!bounded) return out;
      for (int i = 0; i < n; ++i)
        for (int k = 0; k < n; ++k) out[i * n + k] = jacobian[i] * internal[i * n + k] * jacobian[k];
      return out;
    };
    if (layout) {
      result.covariance = pe;
    } else {
      Matrix internal(static_cast<std::size_t>(n) * n, 0.0);
      for (int a = 0; a < ne; ++a)
        for (int b = 0; b < ne; ++b) internal[estimated[a] * n + estimated[b]] = pe[a * ne + b];
      for (int a = 0; a < nc; ++a) internal[considered[a] * n + considered[a]] = pc[a * nc + a];
      result.covariance = physical_covariance(internal);
    }
    result.scaled_covariance = result.covariance;
    for (int i = 0; i < n; ++i)
      for (int k = 0; k < n; ++k)
        if (!consider[i] && !consider[k]) result.scaled_covariance[i * n + k] *= result.reduced_chi_square;
    if (nc > 0) {
      // S = -P M with M = Hx' W Hc over the accepted data (the a priori
      // has no cross terms).
      Matrix sensitivity(static_cast<std::size_t>(ne) * nc, 0.0);
      for (int a = 0; a < ne; ++a)
        for (int c = 0; c < nc; ++c) {
          double sum = 0.0;
          for (int b = 0; b < ne; ++b) sum += pe[a * ne + b] * normal_full[estimated[b] * n + considered[c]];
          sensitivity[a * nc + c] = -sum;
        }
      Matrix internal(static_cast<std::size_t>(n) * n, 0.0);
      for (int a = 0; a < ne; ++a)
        for (int b = 0; b < ne; ++b) {
          double sum = pe[a * ne + b];
          for (int c = 0; c < nc; ++c)
            for (int d = 0; d < nc; ++d) sum += sensitivity[a * nc + c] * pc[c * nc + d] * sensitivity[b * nc + d];
          internal[estimated[a] * n + estimated[b]] = sum;
        }
      for (int a = 0; a < ne; ++a)
        for (int c = 0; c < nc; ++c) {
          double sum = 0.0;
          for (int d = 0; d < nc; ++d) sum += sensitivity[a * nc + d] * pc[d * nc + c];
          internal[estimated[a] * n + considered[c]] = internal[considered[c] * n + estimated[a]] = sum;
        }
      for (int c = 0; c < nc; ++c)
        for (int d = 0; d < nc; ++d) internal[considered[c] * n + considered[d]] = pc[c * nc + d];
      result.consider_covariance = physical_covariance(internal);
    }
    if (bounded) {
      result.bound_status.assign(p, 0);
      for (int i = 0; i < p; ++i) {
        const int g = 6 + i;
        if (estimate[g] <= lower[g]) result.bound_status[i] = 1;
        else if (estimate[g] >= upper[g]) result.bound_status[i] = 2;
      }
    }
    if (config.rtn_output) {
      double d[3][3];
      const std::vector<double>& e = result.estimate;
      if (!rtn_rows({e[0], e[1], e[2]}, {e[3], e[4], e[5]}, d)) return fail("RTN axes need a nonzero, non-radial estimated state");
      // C' = D C D' with D = diag(rows, rows) on the state, identity on the parameters.
      auto rotate = [&](const Matrix& c) {
        Matrix left(c.size(), 0.0), out(c.size(), 0.0);
        for (int i = 0; i < n; ++i)
          for (int k = 0; k < n; ++k) {
            if (i >= 6) { left[i * n + k] = c[i * n + k]; continue; }
            double sum = 0.0;
            for (int l = 0; l < 3; ++l) sum += d[i % 3][l] * c[(i / 3 * 3 + l) * n + k];
            left[i * n + k] = sum;
          }
        for (int i = 0; i < n; ++i)
          for (int k = 0; k < n; ++k) {
            if (k >= 6) { out[i * n + k] = left[i * n + k]; continue; }
            double sum = 0.0;
            for (int l = 0; l < 3; ++l) sum += left[i * n + (k / 3 * 3 + l)] * d[k % 3][l];
            out[i * n + k] = sum;
          }
        return out;
      };
      result.covariance_rtn = rotate(result.covariance);
      if (!result.consider_covariance.empty()) result.consider_covariance_rtn = rotate(result.consider_covariance);
    }
    result.valid = true;
    return result;
  };

  std::vector<bool> rejected(unit_count, false);
  double previous_rms = 0.0;
  double damping = config.levenberg_marquardt ? config.initial_damping : 0.0;
  if (config.levenberg_marquardt && !(damping > 0.0 && std::isfinite(damping))) return fail("initial_damping must be positive");
  const int maximum = std::max(1, config.maximum_iterations);
  Evaluation ev;
  int status = evaluate(x, &ev);
  if (status == 0) { result.pending = true; return result; }
  if (status < 0) return result;
  int evaluations = 1;
  bool fresh = true;  // ev is a newly accepted point
  for (;;) {
    // Editing against the previous accepted point's weighted RMS.
    const std::vector<bool> before = rejected;
    if (fresh && config.sigma_edit_threshold > 0.0 && evaluations > 1) {
      const double limit = config.sigma_edit_threshold * std::max(1.0, previous_rms);
      for (std::size_t u = 0; u < unit_count; ++u) {
        double sum = 0.0;
        for (double w : ev.residual[u]) sum += w * w;
        rejected[u] = std::sqrt(sum / units[u].dimension) > limit;
      }
    }
    fresh = false;
    Matrix normal_full;
    std::vector<double> rhs_full;
    double chi_square = 0.0;
    std::size_t scalars = 0;
    build(x, ev, rejected, &normal_full, &rhs_full, &chi_square, &scalars);
    if (scalars == 0) return fail("every observation was edited");
    Matrix normal;
    std::vector<double> rhs;
    if (ne == n) {
      normal = normal_full;
      rhs = rhs_full;
    } else {
      normal.resize(static_cast<std::size_t>(ne) * ne);
      rhs.resize(ne);
      for (int a = 0; a < ne; ++a) {
        rhs[a] = rhs_full[estimated[a]];
        for (int b = 0; b < ne; ++b) normal[a * ne + b] = normal_full[estimated[a] * n + estimated[b]];
      }
    }
    const std::vector<int> held = held_at(x);
    std::vector<double> dx;
    if (!solve(normal, rhs, 0.0, held, &dx)) return fail("the normal matrix is singular: the state and parameters are not observable");
    // Convergence is judged on the projected Gauss-Newton step; the step
    // taken is also limited in ln p. (Near p = 0 a LOGARITHM parameter's
    // column vanishes, so a limited step would look converged.)
    std::vector<double> projected, taken;
    advance(x, dx, &projected);
    const std::vector<double> next = advance(x, limited(dx), &taken);
    double step = 0.0;
    for (int i = 0; i < ne; ++i)
      for (int k = 0; k < ne; ++k) step += projected[i] * normal[i * ne + k] * projected[k];
    step = std::sqrt(std::max(step, 0.0) / ne);
    previous_rms = std::sqrt(chi_square / scalars);
    result.iterations = evaluations;
    const bool converged = step < config.correction_tolerance && rejected == before;
    if (converged || evaluations >= maximum) return finish(next, ev, normal_full, normal, taken, rejected, scalars, converged);
    if (!config.levenberg_marquardt) {
      x = next;
      status = evaluate(x, &ev);
      if (status == 0) { result.pending = true; return result; }
      if (status < 0) return result;
      ++evaluations;
      fresh = true;
      continue;
    }
    // Levenberg-Marquardt: damped trial steps from this point until one
    // lowers the cost.
    const double cost = chi_square + prior_cost(x);
    for (;;) {
      std::vector<double> damped, damped_taken;
      if (!solve(normal, rhs, damping, held, &damped)) return fail("the normal matrix is singular: the state and parameters are not observable");
      const std::vector<double> trial = advance(x, limited(damped), &damped_taken);
      Evaluation trial_ev;
      status = evaluate(trial, &trial_ev);
      if (status == 0) { result.pending = true; return result; }
      if (status < 0) return result;
      ++evaluations;
      result.iterations = evaluations;
      if (data_cost(trial_ev, rejected) + prior_cost(trial) < cost) {
        x = trial;
        ev = std::move(trial_ev);
        damping = std::max(damping * 0.1, 1.0e-15);
        fresh = true;
        break;
      }
      damping *= 10.0;
      if (damping > kMaximumDamping || evaluations >= maximum)
        return finish(x, ev, normal_full, normal, std::vector<double>(ne, 0.0), rejected, scalars, false);
    }
  }
}

}  // namespace sdn::estimation
