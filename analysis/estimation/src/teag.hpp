// Theory of Epistemic Abductive Geometry (TEAG) primitives on a finite support
// in R^n (Jah 2026, "TEAG", preprints 202603.2010; Jah 2026, "The ESPF as a
// Tropical Hamilton-Jacobi System", preprints 202603.2110; Jah 2026, "ESPF:
// Jaynesian maximum entropy meets Popperian falsification", arXiv
// 2603.10065). docs/espf-spec.md maps each function to its paper, section
// and equation, and lists the choices made where the papers leave a gap.
//
// Header-only, deterministic (no randomness, no threads, fixed iteration
// order), no allocation beyond std::vector. Every matrix is row-major n x n.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <functional>
#include <limits>
#include <numeric>
#include <vector>

namespace sdn::teag {

using Vec = std::vector<double>;
constexpr double kInfinity = std::numeric_limits<double>::infinity();
constexpr double kPi = 3.141592653589793238462643383279502884;

// ---------------------------------------------------------------------------
// Small dense linear algebra.

inline bool cholesky(const Vec &a, int n, Vec *lower) {
  lower->assign(static_cast<std::size_t>(n) * n, 0.0);
  for (int i = 0; i < n; ++i)
    for (int j = 0; j <= i; ++j) {
      double v = 0.5 * (a[i * n + j] + a[j * n + i]);
      if (!std::isfinite(v)) return false;
      for (int k = 0; k < j; ++k) v -= (*lower)[i * n + k] * (*lower)[j * n + k];
      if (i == j) {
        if (!(v > 0.0) || !std::isfinite(v)) return false;
        (*lower)[i * n + i] = std::sqrt(v);
      } else {
        (*lower)[i * n + j] = v / (*lower)[j * n + j];
      }
    }
  return true;
}

// x = L^-1 b (forward substitution).
inline void solve_lower(const Vec &lower, int n, const double *b, double *x) {
  for (int i = 0; i < n; ++i) {
    double v = b[i];
    for (int k = 0; k < i; ++k) v -= lower[i * n + k] * x[k];
    x[i] = v / lower[i * n + i];
  }
}

// x = L^-T b (back substitution).
inline void solve_upper_transposed(const Vec &lower, int n, const double *b,
                                   double *x) {
  for (int i = n; i-- > 0;) {
    double v = b[i];
    for (int k = i + 1; k < n; ++k) v -= lower[k * n + i] * x[k];
    x[i] = v / lower[i * n + i];
  }
}

inline bool spd_inverse(const Vec &a, int n, Vec *inverse) {
  Vec l;
  if (!cholesky(a, n, &l)) return false;
  inverse->assign(static_cast<std::size_t>(n) * n, 0.0);
  Vec e(n), y(n), x(n);
  for (int c = 0; c < n; ++c) {
    std::fill(e.begin(), e.end(), 0.0);
    e[c] = 1.0;
    solve_lower(l, n, e.data(), y.data());
    solve_upper_transposed(l, n, y.data(), x.data());
    for (int r = 0; r < n; ++r) (*inverse)[r * n + c] = x[r];
  }
  for (int i = 0; i < n; ++i)
    for (int j = 0; j < i; ++j)
      (*inverse)[i * n + j] = (*inverse)[j * n + i] =
          0.5 * ((*inverse)[i * n + j] + (*inverse)[j * n + i]);
  return true;
}

inline double log_det_cholesky(const Vec &lower, int n) {
  double s = 0.0;
  for (int i = 0; i < n; ++i) s += std::log(lower[i * n + i]);
  return 2.0 * s;
}

inline bool log_det_spd(const Vec &a, int n, double *value) {
  Vec l;
  if (!cholesky(a, n, &l)) return false;
  *value = log_det_cholesky(l, n);
  return true;
}

inline double trace(const Vec &a, int n) {
  double s = 0.0;
  for (int i = 0; i < n; ++i) s += a[i * n + i];
  return s;
}

// Quadratic form d' A^-1 d through the Cholesky factor of A.
inline double whitened_squared(const Vec &lower, int n, const double *d) {
  Vec z(n);
  solve_lower(lower, n, d, z.data());
  double s = 0.0;
  for (double v : z) s += v * v;
  return s;
}

// Cyclic Jacobi eigen-decomposition of a symmetric matrix: values ascending,
// vectors as columns (row-major n x n). Deterministic sweep order.
inline bool symmetric_eigen(const Vec &a, int n, Vec *values, Vec *vectors) {
  Vec m(a);
  for (int i = 0; i < n; ++i)
    for (int j = 0; j < i; ++j) m[i * n + j] = m[j * n + i] = 0.5 * (m[i * n + j] + m[j * n + i]);
  vectors->assign(static_cast<std::size_t>(n) * n, 0.0);
  for (int i = 0; i < n; ++i) (*vectors)[i * n + i] = 1.0;
  for (int sweep = 0; sweep < 100; ++sweep) {
    double off = 0.0, scale = 0.0;
    for (int i = 0; i < n; ++i)
      for (int j = 0; j < n; ++j) (i == j ? scale : off) += m[i * n + j] * m[i * n + j];
    if (!std::isfinite(off) || !std::isfinite(scale)) return false;
    if (off <= 1e-30 * std::max(scale, 1e-300)) break;
    for (int p = 0; p < n; ++p)
      for (int q = p + 1; q < n; ++q) {
        const double apq = m[p * n + q];
        if (apq == 0.0) continue;
        const double theta = 0.5 * (m[q * n + q] - m[p * n + p]) / apq;
        const double t = (theta >= 0 ? 1.0 : -1.0) / (std::abs(theta) + std::sqrt(theta * theta + 1.0));
        const double c = 1.0 / std::sqrt(t * t + 1.0), s = t * c;
        for (int k = 0; k < n; ++k) {
          const double mkp = m[k * n + p], mkq = m[k * n + q];
          m[k * n + p] = c * mkp - s * mkq;
          m[k * n + q] = s * mkp + c * mkq;
        }
        for (int k = 0; k < n; ++k) {
          const double mpk = m[p * n + k], mqk = m[q * n + k];
          m[p * n + k] = c * mpk - s * mqk;
          m[q * n + k] = s * mpk + c * mqk;
        }
        for (int k = 0; k < n; ++k) {
          const double vkp = (*vectors)[k * n + p], vkq = (*vectors)[k * n + q];
          (*vectors)[k * n + p] = c * vkp - s * vkq;
          (*vectors)[k * n + q] = s * vkp + c * vkq;
        }
      }
  }
  std::vector<int> order(n);
  std::iota(order.begin(), order.end(), 0);
  std::stable_sort(order.begin(), order.end(), [&](int x, int y) { return m[x * n + x] < m[y * n + y]; });
  values->assign(n, 0.0);
  Vec sorted(static_cast<std::size_t>(n) * n);
  for (int k = 0; k < n; ++k) {
    (*values)[k] = m[order[k] * n + order[k]];
    for (int r = 0; r < n; ++r) sorted[r * n + k] = (*vectors)[r * n + order[k]];
  }
  *vectors = sorted;
  return true;
}

// Clamp the eigenvalues of a symmetric positive semi-definite matrix to
// [floor_ratio * largest, +inf) (TEAG Axiom A4, volumetric faithfulness:
// lambda_min >= epsilon > 0, stated relative so it is unit-free).
inline bool clamp_eigenvalues(Vec *a, int n, double floor_ratio) {
  Vec values, vectors;
  if (!symmetric_eigen(*a, n, &values, &vectors)) return false;
  const double largest = values.back();
  if (!(largest > 0.0) || !std::isfinite(largest)) return false;
  const double floor = floor_ratio * largest;
  Vec out(static_cast<std::size_t>(n) * n, 0.0);
  for (int k = 0; k < n; ++k) {
    const double v = std::max(values[k], floor);
    for (int i = 0; i < n; ++i)
      for (int j = 0; j < n; ++j) out[i * n + j] += vectors[i * n + k] * v * vectors[j * n + k];
  }
  for (int i = 0; i < n; ++i)
    for (int j = 0; j < i; ++j) out[i * n + j] = out[j * n + i] = 0.5 * (out[i * n + j] + out[j * n + i]);
  *a = out;
  return true;
}

// ---------------------------------------------------------------------------
// Possibility algebra on a finite support (TEAG section 3; ESPF-HJ section 2).

// Impossibility field Phi = -log pi (TEAG Definition 3.10; ESPF-HJ eq. 3).
inline double impossibility(double possibility) {
  return possibility > 0.0 ? -std::log(possibility) : kInfinity;
}
inline double possibility(double impossibility_value) {
  return std::isfinite(impossibility_value) ? std::exp(-impossibility_value) : 0.0;
}

// The canonical conjunctive contraction in impossibility coordinates:
// Phi+ = max(Phi-, psi) (TEAG section 3.4.2, Proposition 3.12; ESPF-HJ
// Definition 3, eq. 6). Unnormalized: Popperian monotone by construction.
inline Vec conjoin(const Vec &prior, const Vec &surprisal) {
  Vec out(prior.size());
  for (std::size_t i = 0; i < prior.size(); ++i) out[i] = std::max(prior[i], surprisal[i]);
  return out;
}

// Max-rescaling (TEAG eq. 1, pi' = pi^ / sup pi^) in impossibility
// coordinates: Phi' = Phi - min Phi. Returns the shift -log sup pi^, the
// impossibility of the most possible hypothesis (0 when evidence leaves one
// hypothesis fully possible; positive when it conflicts with all of them).
inline double rescale(Vec *field) {
  double shift = kInfinity;
  for (double v : *field) shift = std::min(shift, v);
  if (!std::isfinite(shift)) return shift;
  for (double &v : *field) v -= shift;
  return shift;
}

// Zones of the tropical polynomial max(Phi-, psi) (ESPF-HJ eq. 7 and its
// three regions; TEAG Theorem 3.13): -1 history-governed (Phi- > psi),
// 0 the active deformation front (|Phi- - psi| <= tolerance), +1
// evidence-governed (psi > Phi-).
inline std::vector<int> zones(const Vec &prior, const Vec &surprisal, double tolerance) {
  std::vector<int> out(prior.size());
  for (std::size_t i = 0; i < prior.size(); ++i) {
    const double d = prior[i] - surprisal[i];
    out[i] = std::abs(d) <= tolerance ? 0 : (d > 0 ? -1 : 1);
  }
  return out;
}

// alpha-cut H_alpha = {h : Phi(h) <= -log alpha} (TEAG Definition 1.1 (iii)
// and section 3.4.4).
inline std::vector<int> alpha_cut(const Vec &field, double alpha) {
  std::vector<int> out;
  const double level = impossibility(alpha);
  for (std::size_t i = 0; i < field.size(); ++i)
    if (field[i] <= level) out.push_back(static_cast<int>(i));
  return out;
}

// Possibility of an event A (a membership mask over the support):
// Pi(A) = sup_{h in A} pi(h); 0 for the empty event.
inline double possibility_of(const Vec &field, const std::vector<std::uint8_t> &event) {
  double best = kInfinity;
  for (std::size_t i = 0; i < field.size(); ++i)
    if (event[i]) best = std::min(best, field[i]);
  return possibility(best);
}

// Necessity N(A) = 1 - Pi(A^c) (TEAG Remark 3.7; ESPF 2025 section 5.2).
inline double necessity_of(const Vec &field, const std::vector<std::uint8_t> &event) {
  std::vector<std::uint8_t> complement(event.size());
  for (std::size_t i = 0; i < event.size(); ++i) complement[i] = event[i] ? 0 : 1;
  return 1.0 - possibility_of(field, complement);
}

// Aggregate epistemic surprisal, the Choquet integral of 1/2 q under the
// prior possibility capacity: sup_i min(q_i / 2, pi_i) (TEAG Definition 4.4;
// ESPF-HJ Definition 7, eq. 30; 2603.10065 Definition 2.6).
inline double choquet_surprisal(const Vec &whitened_squared_innovation, const Vec &prior_possibility) {
  double s = 0.0;
  for (std::size_t i = 0; i < whitened_squared_innovation.size(); ++i)
    s = std::max(s, std::min(0.5 * whitened_squared_innovation[i], prior_possibility[i]));
  return s;
}

// Possibilistic information content I = 1 - exp(-S) (same references).
inline double information_content(double choquet) { return 1.0 - std::exp(-choquet); }

// PCRB floor on the possibilistic entropy change per update:
// (n/2) log(1 - I) (TEAG Theorem 4.5, eq. 8; 2603.10065 Lemma 2). With
// effective_dimension = m (the measurement rank) it is the rank-aware floor
// of the PCRB paper (preprints 202607.2165, abstract).
inline double pcrb_floor(int effective_dimension, double information) {
  return 0.5 * effective_dimension * std::log(std::max(1.0 - information, 1e-300));
}

struct PcrbBasin {
  double radius{0};     // r*_k
  double threshold{0};  // c*_k = (r*_k)^2 / 2
  int unit_survivors{0};
};

// PCRB-admissible basin (TEAG Definition 3.15; ESPF-HJ Remark 4):
// r* = r- ((1 - I) M / M_surv)^(1/n), c* = r*^2 / 2. M is the support count.
// M_surv is the number of hypotheses inside the basin at the prior radius,
// {Phi' <= r-^2 / 2} on the rescaled field (a choice; docs/espf-spec.md G7).
inline PcrbBasin pcrb_basin(const Vec &rescaled_field, double information, int effective_dimension,
                            double prior_radius) {
  PcrbBasin b;
  const double unit = 0.5 * prior_radius * prior_radius;
  for (double v : rescaled_field)
    if (v <= unit) ++b.unit_survivors;
  const int m = static_cast<int>(rescaled_field.size());
  const double ratio = (1.0 - information) * m / std::max(1, b.unit_survivors);
  b.radius = prior_radius * std::pow(ratio, 1.0 / std::max(1, effective_dimension));
  b.threshold = 0.5 * b.radius * b.radius;
  return b;
}

// ---------------------------------------------------------------------------
// Minimum-volume enclosing ellipsoid.

struct Ellipsoid {
  int dimension{0};
  Vec center;  // n
  Vec shape;   // n x n, E = {x : (x - c)' shape^-1 (x - c) <= 1}
};

struct MveeReport {
  int iterations{0};
  double gap{0};             // max(eps+, eps-) at exit
  double containment{0};     // the largest (x - c)' shape^-1 (x - c) before the final scaling
  bool converged{false};
};

// The MVEE of `count` points (row-major count x n): Khachiyan's (1996)
// barycentric coordinate ascent with Todd and Yildirim's (2007) away steps,
// run in coordinates whitened by the sample covariance (the MVEE is affine
// equivariant, so this only conditions the arithmetic), stopped when both
// optimality gaps are below epsilon, then scaled by the largest normalized
// distance of any point so that every point lies inside (or on) the result.
// Fails for fewer than n + 1 points or an affinely degenerate set.
inline bool mvee(const Vec &points, int count, int n, double epsilon, int max_iterations, Ellipsoid *out,
                 MveeReport *report = nullptr) {
  if (count < n + 1 || n < 1) return false;
  Vec mean(n, 0.0);
  for (int j = 0; j < count; ++j)
    for (int i = 0; i < n; ++i) mean[i] += points[j * n + i];
  for (double &v : mean) v /= count;
  Vec cov(static_cast<std::size_t>(n) * n, 0.0);
  for (int j = 0; j < count; ++j)
    for (int r = 0; r < n; ++r)
      for (int c = 0; c < n; ++c)
        cov[r * n + c] += (points[j * n + r] - mean[r]) * (points[j * n + c] - mean[c]);
  for (double &v : cov) v /= count;
  Vec l;
  if (!cholesky(cov, n, &l)) return false;
  const int d1 = n + 1;
  Vec q(static_cast<std::size_t>(count) * d1);
  {
    Vec y(n), z(n);
    for (int j = 0; j < count; ++j) {
      for (int i = 0; i < n; ++i) y[i] = points[j * n + i] - mean[i];
      solve_lower(l, n, y.data(), z.data());
      for (int i = 0; i < n; ++i) q[j * d1 + i] = z[i];
      q[j * d1 + n] = 1.0;
    }
  }
  Vec u(count, 1.0 / count), x(static_cast<std::size_t>(d1) * d1), xl, g(count), t(d1);
  MveeReport r;
  for (r.iterations = 0; r.iterations < max_iterations; ++r.iterations) {
    std::fill(x.begin(), x.end(), 0.0);
    for (int j = 0; j < count; ++j) {
      if (u[j] == 0.0) continue;
      for (int a = 0; a < d1; ++a)
        for (int b = 0; b <= a; ++b) x[a * d1 + b] += u[j] * q[j * d1 + a] * q[j * d1 + b];
    }
    for (int a = 0; a < d1; ++a)
      for (int b = 0; b < a; ++b) x[b * d1 + a] = x[a * d1 + b];
    if (!cholesky(x, d1, &xl)) return false;
    int jp = 0, jm = -1;
    for (int j = 0; j < count; ++j) {
      g[j] = whitened_squared(xl, d1, &q[j * d1]);
      if (g[j] > g[jp]) jp = j;
      if (u[j] > 0.0 && (jm < 0 || g[j] < g[jm])) jm = j;
    }
    const double kp = g[jp], km = g[jm];
    const double ep = kp / d1 - 1.0, em = 1.0 - km / d1;
    r.gap = std::max(ep, em);
    if (r.gap <= epsilon) { r.converged = true; break; }
    if (ep >= em || km - 1.0 <= 1e-15) {
      const double beta = (kp - d1) / (d1 * (kp - 1.0));
      for (double &v : u) v *= (1.0 - beta);
      u[jp] += beta;
    } else {
      double beta = (d1 - km) / (d1 * (km - 1.0));
      const bool drop = u[jm] < 1.0 && beta >= u[jm] / (1.0 - u[jm]);
      if (drop) beta = u[jm] / (1.0 - u[jm]);
      for (double &v : u) v *= (1.0 + beta);
      u[jm] -= beta;
      if (drop) u[jm] = 0.0;
    }
  }
  // Ellipsoid in whitened coordinates: c = sum u z, S = n sum u (z-c)(z-c)'.
  Vec cz(n, 0.0), sz(static_cast<std::size_t>(n) * n, 0.0);
  for (int j = 0; j < count; ++j)
    for (int i = 0; i < n; ++i) cz[i] += u[j] * q[j * d1 + i];
  for (int j = 0; j < count; ++j) {
    if (u[j] == 0.0) continue;
    for (int a = 0; a < n; ++a)
      for (int b = 0; b < n; ++b) sz[a * n + b] += u[j] * (q[j * d1 + a] - cz[a]) * (q[j * d1 + b] - cz[b]);
  }
  for (double &v : sz) v *= n;
  Vec sl;
  if (!cholesky(sz, n, &sl)) return false;
  double worst = 0.0;
  {
    Vec dz(n);
    for (int j = 0; j < count; ++j) {
      for (int i = 0; i < n; ++i) dz[i] = q[j * d1 + i] - cz[i];
      worst = std::max(worst, whitened_squared(sl, n, dz.data()));
    }
  }
  r.containment = worst;
  if (worst > 1.0)
    for (double &v : sz) v *= worst;
  // Back to the original coordinates: x = mean + L z.
  out->dimension = n;
  out->center.assign(n, 0.0);
  for (int i = 0; i < n; ++i) {
    out->center[i] = mean[i];
    for (int k = 0; k <= i; ++k) out->center[i] += l[i * n + k] * cz[k];
  }
  Vec ls(static_cast<std::size_t>(n) * n, 0.0);
  for (int i = 0; i < n; ++i)
    for (int j = 0; j < n; ++j)
      for (int k = 0; k <= i; ++k) ls[i * n + j] += l[i * n + k] * sz[k * n + j];
  out->shape.assign(static_cast<std::size_t>(n) * n, 0.0);
  for (int i = 0; i < n; ++i)
    for (int j = 0; j < n; ++j)
      for (int k = 0; k <= j; ++k) out->shape[i * n + j] += ls[i * n + k] * l[j * n + k];
  for (int i = 0; i < n; ++i)
    for (int j = 0; j < i; ++j)
      out->shape[i * n + j] = out->shape[j * n + i] = 0.5 * (out->shape[i * n + j] + out->shape[j * n + i]);
  if (report) *report = r;
  return true;
}

// log volume of an ellipsoid with shape S: log c_n + log det(S) / 2, with
// c_n = pi^(n/2) / Gamma(n/2 + 1) (TEAG Definition 4.1).
inline double unit_ball_log_volume(int n) {
  return 0.5 * n * std::log(kPi) - std::lgamma(0.5 * n + 1.0);
}
inline bool ellipsoid_log_volume(const Vec &shape, int n, double *value) {
  double ld = 0.0;
  if (!log_det_spd(shape, n, &ld)) return false;
  *value = unit_ball_log_volume(n) + 0.5 * ld;
  return true;
}

// Outer bound of the Minkowski sum of two centred ellipsoids, the member
// (1 + 1/p) A + (1 + p) B of the outer family of minimum trace,
// p = sqrt(tr A / tr B) (Kurzhanski and Valyi 1997; Maksarov and Norton
// 1996). Used for the joint spread of the ESPF 2025 measurement update
// (section 8.1, "bound(E_h(X) + E_v)"), the innovation shape Pi_e of the
// 2026 papers and the Minkowski process-noise expansion of the prediction.
inline Vec minkowski_outer(const Vec &a, const Vec &b, int n) {
  const double ta = trace(a, n), tb = trace(b, n);
  if (!(tb > 0.0)) return a;
  if (!(ta > 0.0)) return b;
  const double p = std::sqrt(ta / tb);
  Vec out(static_cast<std::size_t>(n) * n);
  for (std::size_t i = 0; i < out.size(); ++i) out[i] = (1.0 + 1.0 / p) * a[i] + (1.0 + p) * b[i];
  return out;
}

// ---------------------------------------------------------------------------
// Commitment: the minimax medoid argmin_i max_j rho(h_i, h_j) over a subset of
// the support, rho the distance induced by `shape` (TEAG Axiom 3.5 and
// Proposition 3.21; ESPF-HJ Definition 9, eq. 49). `points` is row-major
// count x dimension in the coordinates `shape` is stated in. Ties go to the
// lowest index. Returns -1 on failure.
inline int minimax_medoid(const Vec &points, int dimension, const std::vector<int> &subset, const Vec &shape,
                          double *radius = nullptr) {
  Vec l;
  if (subset.empty() || !cholesky(shape, dimension, &l)) return -1;
  const int k = static_cast<int>(subset.size());
  Vec z(static_cast<std::size_t>(k) * dimension);
  for (int a = 0; a < k; ++a) solve_lower(l, dimension, &points[subset[a] * dimension], &z[a * dimension]);
  int best = -1;
  double best_value = kInfinity;
  for (int a = 0; a < k; ++a) {
    double worst = 0.0;
    for (int b = 0; b < k; ++b) {
      double s = 0.0;
      for (int i = 0; i < dimension; ++i) {
        const double d = z[a * dimension + i] - z[b * dimension + i];
        s += d * d;
      }
      worst = std::max(worst, s);
    }
    if (worst < best_value) { best_value = worst; best = subset[a]; }
  }
  if (radius) *radius = std::sqrt(best_value);
  return best;
}

// ---------------------------------------------------------------------------
// Smolyak sparse grid on [-1, 1]^n from the nested Clenshaw-Curtis rule
// (ESPF 2025 section 6.4): X_1 = {0}, X_i = {cos(pi j / (m_i - 1))}, m_i =
// 2^(i-1) + 1 for i >= 2 (the 2025 paper writes m_i = 2^(i-1) + 1 for every
// i; at i = 1 that is two points and the level-1 grid would be the 2^n
// corners, so the standard m_1 = 1 is used: docs/espf-spec.md G2). The grid
// is the union of the tensor products with sum (i_k - 1) <= level - 1. Nodes
// are held as dyadic indices so shared nodes coincide exactly. Point 0 is
// the centre; the rest follow in a fixed order. Level 2 gives 2n + 1 points,
// level 3 gives 2n^2 + 2n + 1.
inline Vec smolyak_clenshaw_curtis(int n, int level) {
  Vec out;
  if (n < 1 || level < 1) return out;
  const int top = level;  // finest 1-D level
  const long long grid = top >= 2 ? (1LL << (top - 1)) : 0;  // dyadic denominator
  auto node = [&](long long k) -> double {  // cos(pi k / grid), exact at 0, ends and centre
    if (grid == 0) return 0.0;
    if (2 * k == grid) return 0.0;
    if (k == 0) return 1.0;
    if (k == grid) return -1.0;
    if (2 * k > grid) return -std::cos(kPi * static_cast<double>(grid - k) / static_cast<double>(grid));
    return std::cos(kPi * static_cast<double>(k) / static_cast<double>(grid));
  };
  // 1-D nodes of level i as dyadic indices.
  auto nodes = [&](int i) {
    std::vector<long long> ks;
    if (i == 1) { ks.push_back(grid / 2); return ks; }
    const long long m = (1LL << (i - 1));  // m_i - 1
    const long long stride = grid / m;
    for (long long j = 0; j <= m; ++j) ks.push_back(j * stride);
    return ks;
  };
  std::vector<std::vector<long long>> points;
  std::vector<int> index(n, 1);
  // Enumerate multi-indices with sum(i_k - 1) <= level - 1 in lexicographic order.
  std::function<void(int, int)> walk;
  std::vector<std::vector<long long>> per(n);
  walk = [&](int dim, int budget) {
    if (dim == n) {
      for (int k = 0; k < n; ++k) per[k] = nodes(index[k]);
      std::vector<long long> p(n);
      std::function<void(int)> fill = [&](int d) {
        if (d == n) { points.push_back(p); return; }
        for (long long v : per[d]) { p[d] = v; fill(d + 1); }
      };
      fill(0);
      return;
    }
    for (int i = 1; i - 1 <= budget; ++i) {
      index[dim] = i;
      walk(dim + 1, budget - (i - 1));
    }
  };
  walk(0, level - 1);
  std::sort(points.begin(), points.end());
  points.erase(std::unique(points.begin(), points.end()), points.end());
  // Centre first, then by distance from the centre (number of off-centre
  // coordinates, then lexicographic): a fixed, symmetric-friendly order.
  const long long mid = grid / 2;
  std::stable_sort(points.begin(), points.end(), [&](const auto &a, const auto &b) {
    int na = 0, nb = 0;
    for (int k = 0; k < n; ++k) { na += a[k] != mid; nb += b[k] != mid; }
    return na < nb;
  });
  out.reserve(points.size() * n);
  for (const auto &p : points)
    for (long long k : p) out.push_back(node(k));
  return out;
}

// ---------------------------------------------------------------------------
// Possibilistic entropy E_pi = int_0^1 log V_alpha d alpha (TEAG Definition
// 4.1; 2603.10065 Definition 2.2), V_alpha the MVEE volume of the alpha-cut.
// The papers set V_alpha = 0 when the cut has fewer than 2n + 1 points, which
// makes E_pi = -infinity for every non-uniform distribution on a finite
// support (docs/espf-spec.md G12). This returns the integral over the levels
// whose cut has at least `minimum_count` points, and that truncation level.
struct EntropyReport {
  double entropy{0};          // truncated integral
  double support_entropy{0};  // log V of the whole support (alpha -> 0)
  double truncation_alpha{0};
  int levels{0};
};
inline bool possibilistic_entropy(const Vec &points, const Vec &possibility_values, int n, int minimum_count,
                                  EntropyReport *out) {
  const int count = static_cast<int>(possibility_values.size());
  std::vector<int> order(count);
  std::iota(order.begin(), order.end(), 0);
  std::stable_sort(order.begin(), order.end(),
                   [&](int a, int b) { return possibility_values[a] > possibility_values[b]; });
  EntropyReport r;
  bool have_support = false;
  Vec cut;
  int k = 0;
  while (k < count) {
    const double level = possibility_values[order[k]];
    int end = k;
    while (end < count && possibility_values[order[end]] == level) ++end;
    const double next = end < count ? possibility_values[order[end]] : 0.0;
    if (end >= minimum_count) {
      cut.clear();
      for (int a = 0; a < end; ++a)
        for (int i = 0; i < n; ++i) cut.push_back(points[order[a] * n + i]);
      Ellipsoid e;
      double lv = 0.0;
      if (!mvee(cut, end, n, 1e-9, 20000, &e) || !ellipsoid_log_volume(e.shape, n, &lv)) return false;
      r.entropy += (level - next) * lv;
      if (r.truncation_alpha == 0.0) r.truncation_alpha = level;
      ++r.levels;
      if (end == count) { r.support_entropy = lv; have_support = true; }
    }
    k = end;
  }
  if (!have_support) return false;
  *out = r;
  return true;
}

}  // namespace sdn::teag
