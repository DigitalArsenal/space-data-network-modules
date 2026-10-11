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

// Tuning constants (build.mjs may override them for experiments).
#ifndef SGP4XP_DRAG_MIN_SPAN_SECONDS
#define SGP4XP_DRAG_MIN_SPAN_SECONDS 82800.0   // an arc shorter than this (about a day) leaves BTERM and AGOM at zero
#endif
#ifndef SGP4XP_PRIOR_WEIGHT_KM
#define SGP4XP_PRIOR_WEIGHT_KM 0.001           // residual (km) of a prior one standard deviation from zero
#endif
#ifndef SGP4XP_PRIOR_SIGMA_BTERM
#define SGP4XP_PRIOR_SIGMA_BTERM 0.05          // m^2/kg
#endif
#ifndef SGP4XP_PRIOR_SIGMA_AGOM
#define SGP4XP_PRIOR_SIGMA_AGOM 0.1            // m^2/kg
#endif
// The bounds of BTERM and AGOM, m^2/kg. A negative BTERM (a thrusting satellite's along-track force) fits the arc better
// and predicts the next day worse (measured on Starlink: tests/measure/README.md); a decaying satellite needs more than 0.5.
#ifndef SGP4XP_BTERM_MIN
#define SGP4XP_BTERM_MIN 0.0
#endif
#ifndef SGP4XP_BTERM_MAX
#define SGP4XP_BTERM_MAX 5.0
#endif
#ifndef SGP4XP_AGOM_MIN
#define SGP4XP_AGOM_MIN 0.0
#endif
#ifndef SGP4XP_AGOM_MAX
#define SGP4XP_AGOM_MAX 5.0
#endif
#ifndef SGP4XP_LATTICE_BUDGET
#define SGP4XP_LATTICE_BUDGET 100               // evaluations the search on the text's lattice may spend
#endif
#ifndef SGP4XP_MAX_FIT_STATES
#define SGP4XP_MAX_FIT_STATES 240              // the optimisation uses at most this many states, evenly spaced
#endif

namespace sgp4xp {


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
  Fitter(bool xp = true, size_t maxStates = 0) : xp_(xp), maxStates_(maxStates != 0 ? maxStates : SGP4XP_MAX_FIT_STATES) {}

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

    // The optimisation sees at most `maxStates` of the states (SGP4XP_MAX_FIT_STATES unless the caller sets it), evenly spaced and always the first and the
    // last (a minute-cadence day is 1440 states, and the library does not make a propagation cheaper by being asked
    // for the same orbit again); the statistics below are over every state.
    std::vector<Sample> thinned;
    const size_t stride = std::max<size_t>(1, (fit.size() + maxStates_ - 1) / maxStates_);
    if (stride > 1) {
      for (size_t i = 0; i < fit.size(); i += stride) thinned.push_back(fit[i]);
      if ((fit.size() - 1) % stride != 0) thinned.push_back(fit.back());
    }
    const std::vector<Sample>& seen = stride > 1 ? thinned : fit;

    elements_ = start;
    detail::Vector p = toU(start);

    // Stages: about two revolutions, then doubling to the whole interval.
    double window = std::min(span, std::max(2.0 * period, 1800.0));
    int iterationsTotal = 0;
    bool converged = false;
    for (;;) {
      const bool last = window >= span;
      setStage(seen, window);
      if (stage_.size() < 10) {
        if (last) return fail(result, "too-few-states", "The fit interval holds fewer than 10 states.");
        window = std::min(span, window * 2.0);
        continue;
      }
      int it = 0;
      // The six elements through every stage; BTERM and AGOM join at the last, and only when the arc is long enough
      // (one day) for the drag to show: a shorter arc leaves them at zero.
      std::vector<size_t> active = {0, 1, 2, 3, 4, 5};
      if (last && span >= SGP4XP_DRAG_MIN_SPAN_SECONDS) { active.push_back(6); if (xp_) active.push_back(7); }
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
    setStage(seen, span + 1.0);
    result.rmsBeforeLattice = rmsOf(p);
    clampU(&p);
    result.elements = searchLattice(fromU(p));
    elements_ = result.elements;
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
  // The fit's parameters are non-singular: u = {n rev/day, af = e cos(w+O), ag = e sin(w+O), chi = tan(i/2) sin O,
  // psi = tan(i/2) cos O, lambda = M+w+O deg, BTERM, AGOM}. In (e, w) a circular orbit is a point where the step in e
  // has no direction and a Gauss-Newton step that wants a different w is refused; the equinoctial pair is linear there.
  detail::Vector toU(const Elements& e) const {
    const double varpi = (e.argPerigee + e.raan) * kDegToRad;
    const double t = std::tan(0.5 * e.inclination * kDegToRad);
    const double node = e.raan * kDegToRad;
    return {e.meanMotion, e.eccentricity * std::cos(varpi), e.eccentricity * std::sin(varpi), t * std::sin(node), t * std::cos(node),
            wrapDegrees(e.meanAnomaly + e.argPerigee + e.raan), e.drag, e.agom};
  }
  Elements fromU(const detail::Vector& u) const {
    Elements e = elements_;
    e.xp = xp_;
    e.meanMotion = u[0];
    e.eccentricity = std::sqrt(u[1] * u[1] + u[2] * u[2]);
    const double varpi = (u[1] == 0.0 && u[2] == 0.0) ? 0.0 : std::atan2(u[2], u[1]) * kRadToDeg;
    const double t = std::sqrt(u[3] * u[3] + u[4] * u[4]);
    e.inclination = 2.0 * std::atan(t) * kRadToDeg;
    e.raan = t == 0.0 ? 0.0 : wrapDegrees(std::atan2(u[3], u[4]) * kRadToDeg);
    e.argPerigee = wrapDegrees(varpi - e.raan);
    e.meanAnomaly = wrapDegrees(u[5] - varpi);
    e.drag = u[6];
    e.agom = xp_ ? u[7] : 0.0;
    return e;
  }
  static double stepOf(size_t j, double v) {
    switch (j) {
      case 0: return 1.0e-6;
      case 1: case 2: return 2.0e-5;
      case 3: case 4: return 2.0e-4;
      case 5: return 0.02;
      default: return std::max(2.0e-4, std::fabs(v) * 0.02);
    }
  }
  void clampU(detail::Vector* u) const {
    (*u)[0] = std::max(0.05, std::min(20.0, (*u)[0]));
    const double e = std::sqrt((*u)[1] * (*u)[1] + (*u)[2] * (*u)[2]);
    if (e > 0.9) { (*u)[1] *= 0.9 / e; (*u)[2] *= 0.9 / e; }
    const double t = std::sqrt((*u)[3] * (*u)[3] + (*u)[4] * (*u)[4]);
    if (t > 50.0) { (*u)[3] *= 50.0 / t; (*u)[4] *= 50.0 / t; }
    (*u)[6] = std::max(SGP4XP_BTERM_MIN, std::min(SGP4XP_BTERM_MAX, (*u)[6]));
    (*u)[7] = std::max(SGP4XP_AGOM_MIN, std::min(SGP4XP_AGOM_MAX, (*u)[7]));
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

  // Residuals (model - observed, km) of the element set `e`, rounded to the digits of the text, over the stage: 3 per
  // state, then the two priors. false when the library refuses the set or any propagation.
  bool residualsE(const Elements& raw, std::vector<double>* out) {
    ++evaluations_;
    const Elements e = roundedToText(raw);
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
    (*out)[stage_.size() * 3 + 0] = SGP4XP_PRIOR_WEIGHT_KM * e.drag / SGP4XP_PRIOR_SIGMA_BTERM;
    (*out)[stage_.size() * 3 + 1] = xp_ ? SGP4XP_PRIOR_WEIGHT_KM * e.agom / SGP4XP_PRIOR_SIGMA_AGOM : 0.0;
    return true;
  }
  bool residuals(const detail::Vector& uRaw, std::vector<double>* out) {
    detail::Vector u = uRaw;
    clampU(&u);
    return residualsE(fromU(u), out);
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
    clampU(p);
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
        if (j == 6) q[j] = std::min(q[j], SGP4XP_BTERM_MAX);
        if (j == 7) q[j] = std::min(q[j], SGP4XP_AGOM_MAX);
        const double denom = q[j] - (*p)[j];
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
        clampU(&trial);
        if (!residuals(trial, &r1)) { lambda *= 10; continue; }
        const double c1 = sumSquares(r1);
        if (c1 < cost) {
          const double rel = (cost - c1) / std::max(cost, 1e-30);
#ifdef SGP4XP_TRACE
          { char tb[200]; std::snprintf(tb, sizeof tb, "[win=%zu it=%d rms=%.6g lam=%.3g n=%.8f af=%.7f ag=%.7f chi=%.6f psi=%.6f lam=%.4f b=%.5g a=%.5g]", stage_.size(), it, std::sqrt(c1 / double(stage_.size())), lambda, trial[0], trial[1], trial[2], trial[3], trial[4], trial[5], trial[6], trial[7]); trace_ += tb; }
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

  // Coordinate and pair moves on the text's lattice, in the classical elements the text carries: the rounded set whose
  // residuals are least.
  Elements searchLattice(const Elements& start) {
    Elements best = roundedToText(start);
    std::vector<double> r;
    if (!residualsE(best, &r)) return best;
    double cost = sumSquares(r);
    int budget = SGP4XP_LATTICE_BUDGET;
    const double steps[] = {1, 2, 3, 5, 8, 13, 21, 34, 55};
    auto tryMove = [&](Elements candidate) {
      if (budget-- <= 0) return false;
      candidate = roundedToText(candidate);
      if (!residualsE(candidate, &r)) return false;
      const double c = sumSquares(r);
      if (c >= cost) return false;
      cost = c;
      best = candidate;
      return true;
    };
    bool improved = true;
    while (improved && budget > 0) {
      improved = false;
      for (double s : steps) {
        for (double sign : {1.0, -1.0}) {
          Elements c;
          c = best; c.meanMotion += sign * s * 1.0e-8; improved |= tryMove(c);
          c = best; c.eccentricity = std::max(0.0, c.eccentricity + sign * s * 1.0e-7); improved |= tryMove(c);
          c = best; c.inclination += sign * s * 1.0e-4; improved |= tryMove(c);
          c = best; c.raan += sign * s * 1.0e-4; improved |= tryMove(c);
          c = best; c.argPerigee += sign * s * 1.0e-4; improved |= tryMove(c);
          c = best; c.meanAnomaly += sign * s * 1.0e-4; improved |= tryMove(c);
          // argument of perigee and mean anomaly together (their sum is what a near-circular orbit sees)
          c = best; c.argPerigee += sign * s * 1.0e-4; c.meanAnomaly -= sign * s * 1.0e-4; improved |= tryMove(c);
          // mean motion with the mean anomaly: a later epoch's phase is n*t + M
          c = best; c.meanMotion += sign * s * 1.0e-8; c.meanAnomaly -= sign * s * 1.0e-4; improved |= tryMove(c);
        }
      }
    }
    return best;
  }

  bool xp_;
  size_t maxStates_;
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
