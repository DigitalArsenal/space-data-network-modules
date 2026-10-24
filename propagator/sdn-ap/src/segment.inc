// -----------------------------------------------------------------------------
// SDN-AP 2h.5: what the segment sets share (cislunar and heliocentric). A
// segment set is an epoch state about its center, carried in an $OMM as the
// osculating elements of that state (SEMI_MAJOR_AXIS and GM given; e > 1 with
// a < 0 and the hyperbolic mean anomaly for an open orbit), its force-model
// parameters in USER_DEFINED_*; states come from RK4 on a fixed node grid from
// the epoch (backward for earlier times), so a state at a time depends on the
// set and the time alone, never on the other requested times.
// -----------------------------------------------------------------------------

namespace sdnap {
namespace segment {

enum Center : int { kNone = 0, kEarth = 1, kMoon = 2, kSun = 3, kOther = 4 };

inline double mu_of(int center) {
  return center == kEarth ? 398600.4418 : center == kMoon ? lunar::kMu : center == kSun ? 1.32712440018e11 : 0.0;
}

inline const char* name_of(int center) { return center == kEarth ? "EARTH" : center == kMoon ? "MOON" : center == kSun ? "SUN" : "?"; }

/// RK4 states at ascending times t (s from the epoch; earlier times integrated backward from the epoch), each from
/// the last node of the fixed grid k h before it and one partial step; out: 3 (positions) or 6 (states) per time.
/// f(t, y, dy) is the dynamics. False on a non-finite state.
template <class F, class Sub>
inline bool rk4_states(F&& f, const double* y0, double h, const double* t, int count, double* out, int stride, Sub&& substeps) {
  auto rk4 = [&](const double* x, double t0, double dt, double* y) {
    double k1[6], k2[6], k3[6], k4[6], z[6];
    f(t0, x, k1);
    for (int j = 0; j < 6; ++j) z[j] = x[j] + 0.5 * dt * k1[j];
    f(t0 + 0.5 * dt, z, k2);
    for (int j = 0; j < 6; ++j) z[j] = x[j] + 0.5 * dt * k2[j];
    f(t0 + 0.5 * dt, z, k3);
    for (int j = 0; j < 6; ++j) z[j] = x[j] + dt * k3[j];
    f(t0 + dt, z, k4);
    for (int j = 0; j < 6; ++j) y[j] = x[j] + dt * (k1[j] + 2.0 * k2[j] + 2.0 * k3[j] + k4[j]) / 6.0;
  };
  // a node step of h, or a partial one, in substeps(t, x) equal parts of h (a close planetary passage)
  auto step = [&](const double* x, double t0, double dt, double* y) {
    const int m = substeps(t0, x);
    const int parts = m <= 1 ? 1 : static_cast<int>(std::ceil(m * std::fabs(dt) / h - 1e-9));
    if (parts <= 1) { rk4(x, t0, dt, y); return; }
    double z[6];
    for (int j = 0; j < 6; ++j) z[j] = x[j];
    const double d = dt / parts;
    for (int q = 0; q < parts; ++q) rk4(z, t0 + q * d, d, z);
    for (int j = 0; j < 6; ++j) y[j] = z[j];
  };
  auto put = [&](int k, const double* y) {
    for (int j = 0; j < stride; ++j) out[stride * k + j] = y[j];
  };
  int first_forward = 0;
  while (first_forward < count && t[first_forward] < 0.0) ++first_forward;
  // backward: from the epoch down through the earlier times (latest first)
  {
    double x[6], tc = 0.0;
    for (int j = 0; j < 6; ++j) x[j] = y0[j];
    for (int k = first_forward - 1; k >= 0; --k) {
      if (k + 1 < first_forward && t[k] > t[k + 1]) return false;
      while (tc - t[k] > h) { step(x, tc, -h, x); tc -= h; }
      double y[6];
      if (tc - t[k] > 0.0) step(x, tc, t[k] - tc, y);
      else for (int j = 0; j < 6; ++j) y[j] = x[j];
      if (!std::isfinite(y[0]) || !std::isfinite(y[3])) return false;
      put(k, y);
    }
  }
  double x[6], tc = 0.0;
  for (int j = 0; j < 6; ++j) x[j] = y0[j];
  for (int k = first_forward; k < count; ++k) {
    if (k > first_forward && t[k] < t[k - 1]) return false;
    while (t[k] - tc > h) { step(x, tc, h, x); tc += h; }
    double y[6];
    if (t[k] - tc > 0.0) step(x, tc, t[k] - tc, y);
    else for (int j = 0; j < 6; ++j) y[j] = x[j];
    if (!std::isfinite(y[0]) || !std::isfinite(y[3])) return false;
    put(k, y);
  }
  return true;
}
template <class F>
inline bool rk4_states(F&& f, const double* y0, double h, const double* t, int count, double* out, int stride) {
  return rk4_states(f, y0, h, t, count, out, stride, [](double, const double*) { return 1; });
}

/// Osculating elements of a state about mu: a (km; < 0 when open), e, i, node, argp, M (rad; hyperbolic M when e > 1).
inline bool elements_of(double mu, const double* r, const double* v, double* el) {
  const double h[3] = {r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]};
  const double hn = std::sqrt(h[0] * h[0] + h[1] * h[1] + h[2] * h[2]), rn = std::sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
  const double v2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2], rv = r[0] * v[0] + r[1] * v[1] + r[2] * v[2];
  if (!(hn > 0.0) || !(rn > 0.0)) return false;
  const double energy = 0.5 * v2 - mu / rn;
  if (energy == 0.0) return false;  // parabolic
  const double a = -mu / (2.0 * energy), p = hn * hn / mu;
  const double inc = std::atan2(std::sqrt(h[0] * h[0] + h[1] * h[1]), h[2]);
  const double node = std::atan2(h[0], -h[1]);
  // argument of latitude from the node line (cos node, sin node, 0) and its normal in the orbit plane
  const double nx = std::cos(node), ny = std::sin(node);
  const double w[3] = {(h[1] * 0.0 - h[2] * ny) / hn, (h[2] * nx - h[0] * 0.0) / hn, (h[0] * ny - h[1] * nx) / hn};
  const double u = std::atan2(r[0] * w[0] + r[1] * w[1] + r[2] * w[2], r[0] * nx + r[1] * ny);
  const double ec = p / rn - 1.0, es = rv * hn / (mu * rn);
  const double e = std::sqrt(ec * ec + es * es), nu = std::atan2(es, ec);
  double M;
  if (e < 1.0) {
    const double E = std::atan2(std::sqrt(1.0 - e * e) * std::sin(nu), e + std::cos(nu));
    M = E - e * std::sin(E);
  } else {
    const double H = std::asinh(std::sqrt(e * e - 1.0) * std::sin(nu) / (1.0 + e * std::cos(nu)));
    M = e * std::sinh(H) - H;
  }
  el[0] = a; el[1] = e; el[2] = inc; el[3] = node; el[4] = u - nu; el[5] = M;
  return std::isfinite(a) && std::isfinite(M);
}

/// The state of osculating elements (as elements_of) about mu.
inline bool state_of(double mu, const double* el, double* r, double* v) {
  const double a = el[0], e = el[1], inc = el[2], node = el[3], argp = el[4], M = el[5];
  if (!(e >= 0.0) || e == 1.0 || (e < 1.0) != (a > 0.0)) return false;
  double cnu, snu;
  if (e < 1.0) {
    const double Mr = std::remainder(M, 2.0 * kPi);  // Danby's start, M reduced to [-pi, pi]
    double E = Mr + 0.85 * e * (std::sin(Mr) >= 0.0 ? 1.0 : -1.0);
    for (int it = 0; it < 60; ++it) {
      const double d = (E - e * std::sin(E) - Mr) / (1.0 - e * std::cos(E));
      E -= d;
      if (std::fabs(d) < 1e-15) break;
    }
    const double den = 1.0 - e * std::cos(E);
    cnu = (std::cos(E) - e) / den;
    snu = std::sqrt(1.0 - e * e) * std::sin(E) / den;
  } else {
    double H = std::asinh(M / e);
    for (int it = 0; it < 80; ++it) {
      const double d = (e * std::sinh(H) - H - M) / (e * std::cosh(H) - 1.0);
      H -= d;
      if (std::fabs(d) < 1e-15) break;
    }
    const double den = e * std::cosh(H) - 1.0;
    cnu = (e - std::cosh(H)) / den;
    snu = std::sqrt(e * e - 1.0) * std::sinh(H) / den;
  }
  const double p = a * (1.0 - e * e), rr = p / (1.0 + e * cnu), vs = std::sqrt(mu / p);
  const double xp = rr * cnu, yp = rr * snu, vxp = -vs * snu, vyp = vs * (e + cnu);
  const double cO = std::cos(node), sO = std::sin(node), ci = std::cos(inc), si = std::sin(inc), cw = std::cos(argp), sw = std::sin(argp);
  const double P[3] = {cO * cw - sO * sw * ci, sO * cw + cO * sw * ci, sw * si};
  const double Q[3] = {-cO * sw - sO * cw * ci, -sO * sw + cO * cw * ci, cw * si};
  for (int c = 0; c < 3; ++c) {
    r[c] = xp * P[c] + yp * Q[c];
    v[c] = vxp * P[c] + vyp * Q[c];
  }
  return std::isfinite(r[0]) && std::isfinite(v[0]);
}

/// The segmentation rule (2h.5): the whole arc and its latest 1/2 and 1/4 (each at least min_seconds and 24 states)
/// are fitted; the longest whose RMS is within max(2 r, r + 0.05 km) of the shortest's RMS r is kept, the set's epoch
/// carried to its start (measured: refining that start by bisection to the earliest within the tolerance extends the
/// segment into the maneuver's tail and loses: CAPSTONE day 3 4.3 -> 5.9 km, Psyche day 15 16.7 -> 19.4).
/// fit_from(first) fits the states [first, n) and returns the RMS (km, < 0 on failure). Returns the kept first index
/// (-1 when every fit failed); rms_out its RMS.
/// The rule's factor and margin ($PCF SEGMENTS.SEGMENT_RMS_FACTOR, SEGMENT_RMS_MARGIN_KM).
inline double& rms_factor() {
  static double f = 2.0;
  return f;
}
inline double& rms_margin_km() {
  static double m = 0.05;
  return m;
}
template <class FitFrom>
inline int choose_segment(const double* t, int n, bool segment, double min_seconds, FitFrom&& fit_from, double& rms_out) {
  int firsts[3] = {0, -1, -1};
  if (segment) {
    const double span = t[n - 1] - t[0];
    for (int f = 1; f <= 2; ++f) {
      const double from = t[n - 1] - std::max(span / (f == 1 ? 2.0 : 4.0), min_seconds);
      int k = 0;
      while (k < n - 1 && t[k] < from) ++k;
      if (k > firsts[f - 1] && n - k >= 24) firsts[f] = k;
    }
  }
  double rms[3] = {-1, -1, -1};
  for (int f = 0; f < 3; ++f)
    if (firsts[f] >= 0) rms[f] = fit_from(firsts[f]);
  int shortest = -1;
  for (int f = 0; f < 3; ++f)
    if (rms[f] >= 0) shortest = f;
  if (shortest < 0) return -1;
  const double tol = std::max(rms_factor() * rms[shortest], rms[shortest] + rms_margin_km());
  int keep = shortest;
  for (int f = 0; f < shortest; ++f)
    if (rms[f] >= 0 && rms[f] <= tol) { keep = f; break; }
  rms_out = rms[keep];
  return firsts[keep];
}

}  // namespace segment
}  // namespace sdnap
