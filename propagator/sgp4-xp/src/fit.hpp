// propagator/sgp4-xp: the fit of an SGP4-XP element set to an ephemeris.
//
// What is fitted. The six mean elements at an epoch, BTERM and AGOM: the parameters of the Space Force library's
// type-4 element set. The library is the model (it is a black box reached through ussf.hpp); this file only asks
// it for positions. The objective is the sum of squared TEME position differences, km, over the fit interval, with
// weak priors on BTERM and AGOM so that a short arc, which cannot see them, leaves them near zero.
//
// How. Levenberg-Marquardt on the eight parameters with forward-difference Jacobians, over an arc that grows from
// about two revolutions to the whole interval (each stage starts from the last: the along-track error of an osculating
// start is many radians over days, and a Gauss-Newton step is only good for a fraction of one). Then a search on the
// lattice of the text: the library reads element sets as two-line text, so an element set has the digits of that text
// (angles to 1e-4 degree, 12 m at low orbit; mean motion to 1e-8 rev/day; eccentricity to 1e-7), and the published
// set is the lattice point, not the continuous optimum. Every evaluation propagates the rounded set, so the
// objective is the published set's.
#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

#include "ussf.hpp"

namespace sgp4xp {

struct Sample {
  Instant t;
  double r[3] = {0, 0, 0};  // TEME, km
  double v[3] = {0, 0, 0};  // TEME, km/s; meaningful when hasVelocity
  bool hasVelocity = false;
};

struct Statistics {
  size_t count = 0;
  double rms = 0;     // 3D position, km
  double max = 0;
  double radial = 0;  // RMS of each component of the position error in the model's radial, along-track and
  double along = 0;   // cross-track axes (km)
  double cross = 0;
};

struct DayStatistics {
  int day = 0;  // the day after the end of the fit interval, from 1
  Statistics statistics;
};

struct FitResult {
  bool ok = false;
  const char* code = "";
  std::string message;
  Elements elements;
  Statistics fit;
  Statistics heldOut;
  std::vector<DayStatistics> heldOutDays;
  double firstPassRms = 0;  // before the first iteration, km
  double rmsBeforeLattice = 0;
  int iterations = 0;
  bool converged = false;
  size_t evaluations = 0;
  std::string trace;  // debugging only (SGP4XP_TRACE)
};

namespace detail {

constexpr size_t kParams = 8;
using Vector = std::array<double, kParams>;

inline double norm3(const double* a) { return std::sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); }
inline void cross3(const double* a, const double* b, double* c) {
  c[0] = a[1] * b[2] - a[2] * b[1];
  c[1] = a[2] * b[0] - a[0] * b[2];
  c[2] = a[0] * b[1] - a[1] * b[0];
}
inline double dot3(const double* a, const double* b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

// Solves A x = b (n x n, Gaussian elimination with partial pivoting). false when singular.
inline bool solve(std::array<std::array<double, kParams>, kParams> A, Vector b, Vector* x, size_t n = kParams) {
  for (size_t c = 0; c < n; ++c) {
    size_t pivot = c;
    for (size_t r = c + 1; r < n; ++r)
      if (std::fabs(A[r][c]) > std::fabs(A[pivot][c])) pivot = r;
    if (!(std::fabs(A[pivot][c]) > 1e-300)) return false;
    std::swap(A[c], A[pivot]);
    std::swap(b[c], b[pivot]);
    for (size_t r = c + 1; r < n; ++r) {
      const double f = A[r][c] / A[c][c];
      for (size_t k = c; k < n; ++k) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  for (size_t ii = n; ii-- > 0;) {
    double s = b[ii];
    for (size_t k = ii + 1; k < n; ++k) s -= A[ii][k] * (*x)[k];
    (*x)[ii] = s / A[ii][ii];
  }
  return true;
}

// Mean-element start from an osculating state: the Keplerian elements of (r, v), km and km/s. Circular orbits put
// the argument of latitude in the mean anomaly and the argument of perigee at zero; equatorial ones put the
// ascending node at the x axis.
inline bool osculating(const double r[3], const double v[3], Elements* e) {
  const double mu = kMuKm3PerS2;
  const double rn = norm3(r), vv = dot3(v, v);
  double h[3];
  cross3(r, v, h);
  const double hn = norm3(h);
  if (!(rn > 0) || !(hn > 0)) return false;
  const double energy = 0.5 * vv - mu / rn;
  if (!(energy < 0)) return false;
  const double a = -mu / (2.0 * energy);
  const double rv = dot3(r, v);
  double ev[3];
  for (int k = 0; k < 3; ++k) ev[k] = ((vv - mu / rn) * r[k] - rv * v[k]) / mu;
  const double ecc = norm3(ev);
  const double eps = 1e-10;
  const double hhat[3] = {h[0] / hn, h[1] / hn, h[2] / hn};
  const double inc = std::acos(std::max(-1.0, std::min(1.0, hhat[2])));
  const double node[3] = {-h[1], h[0], 0.0};
  const double nn = norm3(node);
  double nhat[3] = {1.0, 0.0, 0.0};
  double raan = 0.0;
  if (nn > eps * hn) {
    nhat[0] = node[0] / nn;
    nhat[1] = node[1] / nn;
    raan = std::atan2(nhat[1], nhat[0]);
  }
  const bool eccentric = ecc > eps;
  double pdir[3] = {nhat[0], nhat[1], nhat[2]};
  if (eccentric) for (int k = 0; k < 3; ++k) pdir[k] = ev[k] / ecc;
  double w[3], q[3];
  cross3(hhat, nhat, w);
  const double argp = eccentric ? std::atan2(dot3(pdir, w), dot3(pdir, nhat)) : 0.0;
  cross3(hhat, pdir, q);
  const double nu = std::atan2(dot3(r, q), dot3(r, pdir));
  const double E = 2.0 * std::atan2(std::sqrt(1.0 - ecc) * std::sin(nu / 2.0), std::sqrt(1.0 + ecc) * std::cos(nu / 2.0));
  const double M = E - ecc * std::sin(E);
  const double n = std::sqrt(mu / (a * a * a));  // rad/s
  e->meanMotion = n * kSecondsPerDay / (2.0 * kPi);
  e->eccentricity = ecc;
  e->inclination = inc * kRadToDeg;
  e->raan = wrapDegrees(raan * kRadToDeg);
  e->argPerigee = wrapDegrees(argp * kRadToDeg);
  e->meanAnomaly = wrapDegrees(M * kRadToDeg);
  return std::isfinite(e->meanMotion) && std::isfinite(e->meanAnomaly) && std::isfinite(e->argPerigee) &&
         std::isfinite(e->raan);
}


// Gibbs' method: the velocity at the middle of three coplanar positions (km), two-body.
inline bool gibbs(const double r1[3], const double r2[3], const double r3[3], double v2[3]) {
  double z12[3], z23[3], z31[3];
  cross3(r1, r2, z12);
  cross3(r2, r3, z23);
  cross3(r3, r1, z31);
  const double n1 = norm3(r1), n2 = norm3(r2), n3 = norm3(r3);
  double N[3], D[3], S[3], B[3];
  for (int k = 0; k < 3; ++k) {
    N[k] = n1 * z23[k] + n2 * z31[k] + n3 * z12[k];
    D[k] = z12[k] + z23[k] + z31[k];
    S[k] = r1[k] * (n2 - n3) + r2[k] * (n3 - n1) + r3[k] * (n1 - n2);
  }
  const double Nn = norm3(N), Dn = norm3(D);
  if (!(Nn > 0) || !(Dn > 0) || !(n2 > 0)) return false;
  cross3(D, r2, B);
  const double L = std::sqrt(kMuKm3PerS2 / (Nn * Dn));
  for (int k = 0; k < 3; ++k) v2[k] = L * (B[k] / n2 + S[k]);
  return std::isfinite(v2[0]) && std::isfinite(v2[1]) && std::isfinite(v2[2]);
}

}  // namespace detail

class Fitter {
 public:
  // theory: xp = true fits BTERM and AGOM; xp = false fits SGP4's B*.
  Fitter(bool xp = true) : xp_(xp) {}

  FitResult run(const std::vector<Sample>& fit, const std::vector<Sample>& held, uint32_t norad) {
    FitResult result;
    result.code = "";
    if (fit.size() < 10) return fail(result, "too-few-states", "The fit interval holds fewer than 10 states.");
    for (size_t i = 1; i < fit.size(); ++i)
      if (!(secondsBetween(fit[i].t, fit[i - 1].t) > 0))
        return fail(result, "epochs-not-increasing", "The states' epochs must strictly increase.");
    const double span = secondsBetween(fit.back().t, fit.front().t);
    if (!(span >= 600.0)) return fail(result, "arc-too-short", "The fit interval is shorter than 10 minutes.");

    Elements start;
    start.xp = xp_;
    start.norad = norad;
    setEpoch(&start, fit.front().t);
    if (!initialElements(fit, &start)) return fail(result, "no-start", "The first states are not a bound Earth orbit.");
    const double period = 86400.0 / start.meanMotion;
    start.drag = 0.0;
    start.agom = 0.0;

    detail::Vector p = pack(start);
    elements_ = start;

    // Stages: about two revolutions, then doubling to the whole interval.
    double window = std::min(span, std::max(2.0 * period, 1800.0));
    int iterationsTotal = 0;
    bool converged = false;
    for (;;) {
      const bool last = window >= span;
      setStage(fit, window);
      if (stage_.size() < 10) {
        if (last) return fail(result, "too-few-states", "The fit interval holds fewer than 10 states.");
        window = std::min(span, window * 2.0);
        continue;
      }
      int it = 0;
      // The six elements through every stage; BTERM and AGOM join at the last, and only when the arc is long enough
      // (one day) for the drag to show: a shorter arc leaves them at zero.
      std::vector<size_t> active = {0, 1, 2, 3, 4, 5};
      if (last && span >= 86400.0) { active.push_back(6); if (xp_) active.push_back(7); }
      const bool ok = levenbergMarquardt(&p, active, last ? 60 : 20, &it, &converged);
      iterationsTotal += it;
      if (!ok && last) return fail(result, "fit-failed", "The fit did not find a bound orbit the library can propagate.");
      if (result.firstPassRms == 0 && ok) result.firstPassRms = lastPrefitRms_;
      if (last) break;
      window = std::min(span, window * 2.0);
    }
    result.iterations = iterationsTotal;
    result.converged = converged;

    // Residuals at the continuous optimum, then the lattice of the text.
    setStage(fit, span + 1.0);
    result.rmsBeforeLattice = rmsOf(p);
    p = searchLattice(p);
    elements_ = elementsOf(p);
    result.elements = roundedToText(elements_);
    result.elements.norad = norad;
    result.elements.xp = xp_;
    result.fit = statistics(result.elements, fit);
    if (result.fit.count == 0 || !std::isfinite(result.fit.rms))
      return fail(result, "fit-failed", "The fitted element set cannot be propagated over the fit interval.");
    if (!held.empty()) {
      result.heldOut = statistics(result.elements, held);
      // by day after the end of the interval
      const Instant end = fit.back().t;
      std::vector<Sample> bucket;
      int day = 1;
      for (size_t i = 0; i < held.size(); ++i) {
        const int d = 1 + static_cast<int>(std::floor(std::max(0.0, secondsBetween(held[i].t, end)) / kSecondsPerDay - 1e-9));
        if (d != day && !bucket.empty()) {
          result.heldOutDays.push_back({day, statistics(result.elements, bucket)});
          bucket.clear();
        }
        day = d;
        bucket.push_back(held[i]);
      }
      if (!bucket.empty()) result.heldOutDays.push_back({day, statistics(result.elements, bucket)});
    }
    result.evaluations = evaluations_;
    result.trace = trace_;
    result.ok = true;
    return result;
  }

  // Statistics of an element set against states (TEME); the model's radial/along/cross axes.
  Statistics statistics(const Elements& e, const std::vector<Sample>& samples) {
    Statistics s;
    if (samples.empty()) return s;
    std::vector<double> minutes(samples.size());
    for (size_t i = 0; i < samples.size(); ++i) minutes[i] = minutesSinceEpoch(e, samples[i].t);
    std::vector<double> states(samples.size() * 8);
    Satellite sat;
    if (!sat.create(e, 1)) { s.rms = std::nan(""); return s; }
    sat.propagate(minutes.data(), minutes.size(), states.data());
    double sum = 0, sr = 0, st = 0, sn = 0, mx = 0;
    size_t used = 0;
    for (size_t i = 0; i < samples.size(); ++i) {
      const double* m = &states[i * 8];
      if (m[0] != 0.0) continue;
      const double d[3] = {m[2] - samples[i].r[0], m[3] - samples[i].r[1], m[4] - samples[i].r[2]};
      const double mag2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
      sum += mag2;
      mx = std::max(mx, std::sqrt(mag2));
      double R[3] = {m[2], m[3], m[4]}, V[3] = {m[5], m[6], m[7]}, N[3], T[3];
      const double rn = detail::norm3(R);
      for (int k = 0; k < 3; ++k) R[k] /= rn;
      detail::cross3(&states[i * 8 + 2], V, N);
      const double nn = detail::norm3(N);
      for (int k = 0; k < 3; ++k) N[k] /= nn;
      detail::cross3(N, R, T);
      const double dr = detail::dot3(d, R), dt = detail::dot3(d, T), dn = detail::dot3(d, N);
      sr += dr * dr; st += dt * dt; sn += dn * dn;
      ++used;
    }
    s.count = used;
    if (used == samples.size() && used > 0) {
      s.rms = std::sqrt(sum / static_cast<double>(used));
      s.max = mx;
      s.radial = std::sqrt(sr / static_cast<double>(used));
      s.along = std::sqrt(st / static_cast<double>(used));
      s.cross = std::sqrt(sn / static_cast<double>(used));
    } else {
      s.count = 0;
      s.rms = std::nan("");
    }
    return s;
  }

 private:
  FitResult fail(FitResult r, const char* code, const char* message) {
    r.ok = false;
    r.code = code;
    r.message = message;
    return r;
  }

  // The mean-element start. With the first state's velocity: its osculating elements, at the first epoch. Without
  // (an ephemeris of positions): Gibbs' method on the first three positions gives the velocity at the second, and
  // the osculating elements there are carried back to the first epoch by two-body motion.
  static bool initialElements(const std::vector<Sample>& fit, Elements* e) {
    const Sample& s0 = fit[0];
    if (s0.hasVelocity && (s0.v[0] != 0 || s0.v[1] != 0 || s0.v[2] != 0)) return detail::osculating(s0.r, s0.v, e);
    if (fit.size() < 3) return false;
    const Sample& s1 = fit[1];
    const Sample& s2 = fit[2];
    double v1[3];
    if (!detail::gibbs(s0.r, s1.r, s2.r, v1)) return false;
    Elements mid;
    if (!detail::osculating(s1.r, v1, &mid)) return false;
    const double n = mid.meanMotion * 2.0 * kPi / kSecondsPerDay;  // rad/s
    mid.meanAnomaly = wrapDegrees(mid.meanAnomaly + n * secondsBetween(s0.t, s1.t) * kRadToDeg);
    e->meanMotion = mid.meanMotion;
    e->eccentricity = mid.eccentricity;
    e->inclination = mid.inclination;
    e->raan = mid.raan;
    e->argPerigee = mid.argPerigee;
    e->meanAnomaly = mid.meanAnomaly;
    return true;
  }

  // ---- parameters -------------------------------------------------------------------------------------------
  // p = {n rev/day, e, i deg, raan deg, argp deg, M deg, drag, agom}
  detail::Vector pack(const Elements& e) const {
    return {e.meanMotion, e.eccentricity, e.inclination, e.raan, e.argPerigee, e.meanAnomaly, e.drag, e.agom};
  }
  Elements elementsOf(const detail::Vector& p) const {
    Elements e = elements_;
    e.xp = xp_;
    e.meanMotion = p[0];
    e.eccentricity = p[1];
    e.inclination = p[2];
    e.raan = p[3];
    e.argPerigee = p[4];
    e.meanAnomaly = p[5];
    e.drag = p[6];
    e.agom = xp_ ? p[7] : 0.0;
    return e;
  }
  // The value a parameter has once written as text (angles unwrapped).
  static double asText(size_t j, double v) {
    switch (j) {
      case 0: return decimals(v, 8);
      case 1: return decimals(v, 7);
      case 2: case 3: case 4: case 5: return decimals(v, 4);
      default: return parseExponentField(exponentField(v));
    }
  }
  static double stepOf(size_t j, double v) {
    switch (j) {
      case 0: return 1.0e-6;
      case 1: return 2.0e-5;
      case 2: case 3: case 4: case 5: return 0.02;
      default: return std::max(2.0e-4, std::fabs(v) * 0.02);
    }
  }
  static double quantumOf(size_t j) {
    switch (j) {
      case 0: return 1.0e-8;
      case 1: return 1.0e-7;
      default: return 1.0e-4;
    }
  }
  void clampParams(detail::Vector* p) const {
    (*p)[0] = std::max(0.05, std::min(20.0, (*p)[0]));
    (*p)[1] = std::max(0.0, std::min(0.9, (*p)[1]));
    (*p)[2] = std::max(0.0, std::min(180.0, (*p)[2]));
    (*p)[6] = std::max(0.0, std::min(0.5, (*p)[6]));
    (*p)[7] = std::max(0.0, std::min(0.5, (*p)[7]));
  }

  // ---- the objective -----------------------------------------------------------------------------------------
  void setStage(const std::vector<Sample>& fit, double windowSeconds) {
    stage_.clear();
    minutes_.clear();
    const Instant t0 = fit.front().t;
    for (const Sample& s : fit) {
      if (secondsBetween(s.t, t0) > windowSeconds) break;
      stage_.push_back(s);
    }
    elementsEpoch_ = fit.front().t;
    minutes_.resize(stage_.size());
  }

  // Residuals (model - observed, km) of the element set `p` over the stage: 3 per state, then the two priors.
  // false when the library refuses the set or any propagation.
  bool residuals(const detail::Vector& pRaw, std::vector<double>* out) {
    ++evaluations_;
    detail::Vector p = pRaw;
    clampParams(&p);
    Elements e = roundedToText(elementsOf(p));
    for (size_t i = 0; i < stage_.size(); ++i) minutes_[i] = minutesSinceEpoch(e, stage_[i].t);
    states_.resize(stage_.size() * 8);
    Satellite sat;
    if (!sat.create(e, 1)) return false;
    if (!sat.propagate(minutes_.data(), minutes_.size(), states_.data())) return false;
    out->resize(stage_.size() * 3 + 2);
    for (size_t i = 0; i < stage_.size(); ++i) {
      const double* m = &states_[i * 8];
      (*out)[3 * i + 0] = m[2] - stage_[i].r[0];
      (*out)[3 * i + 1] = m[3] - stage_[i].r[1];
      (*out)[3 * i + 2] = m[4] - stage_[i].r[2];
    }
    // Priors: a metre per standard deviation (BTERM 0.05, AGOM 0.1 m^2/kg) about zero.
    (*out)[stage_.size() * 3 + 0] = 0.001 * p[6] / 0.05;
    (*out)[stage_.size() * 3 + 1] = xp_ ? 0.001 * p[7] / 0.1 : 0.0;
    return true;
  }
  static double sumSquares(const std::vector<double>& r) {
    double s = 0;
    for (double x : r) s += x * x;
    return s;
  }
  double rmsOf(const detail::Vector& p) {
    std::vector<double> r;
    if (!residuals(p, &r)) return std::nan("");
    double s = 0;
    for (size_t i = 0; i + 2 < r.size(); ++i) s += r[i] * r[i];
    return std::sqrt(s / static_cast<double>(stage_.size()));
  }

  // Levenberg-Marquardt over the parameters in `active` (indices into p). The rest keep their values.
  bool levenbergMarquardt(detail::Vector* p, const std::vector<size_t>& active, int maxIterations, int* iterations, bool* converged) {
    using detail::kParams;
    const size_t m = active.size();
    std::vector<double> r0, r1;
    clampParams(p);
    if (!residuals(*p, &r0)) return false;
    double cost = sumSquares(r0);
    if (lastPrefitRms_ == 0) lastPrefitRms_ = std::sqrt(cost / static_cast<double>(stage_.size()));
    double lambda = 1e-2;
    int stall = 0;
    *converged = false;
    for (int it = 0; it < maxIterations; ++it) {
      *iterations = it + 1;
      // Jacobian by forward differences on the text's values.
      const size_t rows = r0.size();
      std::vector<std::array<double, kParams>> J(rows);
      std::vector<bool> usable(m, true);
      for (size_t c = 0; c < m; ++c) {
        const size_t j = active[c];
        detail::Vector q = *p;
        q[j] = (*p)[j] + stepOf(j, (*p)[j]);
        if (j == 6 || j == 7) q[j] = std::min(q[j], 0.5);
        const double denom = asText(j, q[j]) - asText(j, (*p)[j]);
        if (!(std::fabs(denom) > 0) || !residuals(q, &r1)) {
          usable[c] = false;
          for (size_t i = 0; i < rows; ++i) J[i][c] = 0;
          continue;
        }
        for (size_t i = 0; i < rows; ++i) J[i][c] = (r1[i] - r0[i]) / denom;
      }
      std::array<std::array<double, kParams>, kParams> A{};
      detail::Vector g{};
      for (size_t i = 0; i < rows; ++i)
        for (size_t a = 0; a < m; ++a) {
          g[a] += J[i][a] * r0[i];
          for (size_t b = 0; b < m; ++b) A[a][b] += J[i][a] * J[i][b];
        }
      bool improved = false;
      for (int attempt = 0; attempt < 14; ++attempt) {
        auto M = A;
        for (size_t a = 0; a < m; ++a) M[a][a] += lambda * std::max(A[a][a], 1e-12);
        detail::Vector rhs{};
        for (size_t a = 0; a < m; ++a) rhs[a] = -g[a];
        detail::Vector delta{};
        if (!detail::solve(M, rhs, &delta, m)) { lambda *= 10; continue; }
        detail::Vector trial = *p;
        for (size_t a = 0; a < m; ++a) if (usable[a]) trial[active[a]] += delta[a];
        clampParams(&trial);
        if (!residuals(trial, &r1)) { lambda *= 10; continue; }
        const double c1 = sumSquares(r1);
        if (c1 < cost) {
          const double rel = (cost - c1) / std::max(cost, 1e-30);
#ifdef SGP4XP_TRACE
          { char tb[200]; std::snprintf(tb, sizeof tb, "[win=%zu it=%d rms=%.6g lam=%.3g n=%.8f e=%.7f i=%.4f o=%.4f w=%.4f ma=%.4f b=%.5g a=%.5g]", stage_.size(), it, std::sqrt(c1 / double(stage_.size())), lambda, trial[0], trial[1], trial[2], trial[3], trial[4], trial[5], trial[6], trial[7]); trace_ += tb; }
#endif
          *p = trial;
          r0 = r1;
          cost = c1;
          lambda = std::max(lambda / 3.0, 1e-9);
          improved = true;
          stall = rel < 1e-9 ? stall + 1 : 0;
          break;
        }
        lambda *= 4.0;
      }
      if (!improved) { *converged = true; break; }
      if (stall >= 2) { *converged = true; break; }
    }
    return true;
  }

  // Coordinate and pair moves on the text's lattice: the rounded set whose residuals are least.
  detail::Vector searchLattice(detail::Vector p) {
    clampParams(&p);
    for (size_t j = 0; j < 8; ++j) p[j] = asText(j, p[j]);
    std::vector<double> r;
    if (!residuals(p, &r)) return p;
    double cost = sumSquares(r);
    int budget = 400;
    const double steps[] = {1, 2, 3, 5, 8, 13, 21, 34, 55};
    bool improved = true;
    while (improved && budget > 0) {
      improved = false;
      for (size_t j : {size_t{0}, size_t{1}, size_t{2}, size_t{3}, size_t{4}, size_t{5}}) {
        for (double s : steps) {
          for (double sign : {1.0, -1.0}) {
            if (budget-- <= 0) return p;
            detail::Vector q = p;
            q[j] = asText(j, p[j] + sign * s * quantumOf(j));
            if (!residuals(q, &r)) continue;
            const double c = sumSquares(r);
            if (c < cost) { cost = c; p = q; improved = true; }
          }
        }
      }
      // argument of perigee and mean anomaly together (their sum is what a near-circular orbit sees)
      for (double s : steps) {
        for (double sign : {1.0, -1.0}) {
          if (budget-- <= 0) return p;
          detail::Vector q = p;
          q[4] = asText(4, p[4] + sign * s * 1.0e-4);
          q[5] = asText(5, p[5] - sign * s * 1.0e-4);
          if (!residuals(q, &r)) continue;
          const double c = sumSquares(r);
          if (c < cost) { cost = c; p = q; improved = true; }
        }
      }
      // mean motion with the mean anomaly: a later epoch's phase is n*t + M
      for (double s : steps) {
        for (double sign : {1.0, -1.0}) {
          if (budget-- <= 0) return p;
          detail::Vector q = p;
          q[0] = asText(0, p[0] + sign * s * 1.0e-8);
          q[5] = asText(5, p[5] - sign * s * 1.0e-4);
          if (!residuals(q, &r)) continue;
          const double c = sumSquares(r);
          if (c < cost) { cost = c; p = q; improved = true; }
        }
      }
    }
    return p;
  }

  bool xp_;
  Elements elements_;
  Instant elementsEpoch_;
  std::vector<Sample> stage_;
  std::vector<double> minutes_;
  std::vector<double> states_;
  size_t evaluations_ = 0;
  double lastPrefitRms_ = 0;
 public:
  std::string trace_;
 private:
};

}  // namespace sgp4xp
