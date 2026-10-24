// -----------------------------------------------------------------------------
// SDN-AP 2h.2 / 2h.5: cislunar segments, a baseline to measure the DESIGN's
// synodic series against. The segment is the J2000 epoch state about the Moon
// or the Earth with the other body and the Sun as point masses (DE440,
// tabulated hourly over the segment and interpolated), the centre's J2
// (the Moon's about its epoch pole), radial SRP (AGOM) and a constant RTN
// acceleration;
// RK4 at a fixed 60 s step. Not yet: Richardson's base, the Sundman-phase series.
// -----------------------------------------------------------------------------

namespace sdnap {
namespace cislunar {

constexpr double kMuMoon = lunar::kMu, kMuEarth = 398600.4418, kMuSun = 1.32712440018e11;

struct Seg {
  bool moon = true;          // centre: the Moon, else the Earth (segment::kMoon / kEarth)
  double et0 = 0.0;          // TT seconds from J2000 at the epoch
  double pole[3] = {0, 0, 1};  // the Moon's pole (J2000) at the epoch
  double r0[3] = {}, v0[3] = {};
  double agom = 0.0;         // m^2/kg
  double rtn[3] = {0, 0, 0};  // km/s^2
  // hourly table of the third bodies relative to the centre (J2000 km): [k][0..2] the other body, [k][3..5] the Sun
  std::vector<double> tab;
  double tab_t0 = 0.0, tab_dt = 3600.0;
};

/// DE440 geocentric Moon and Sun (J2000 km); false outside the embedded span.
inline bool bodies_j2000(double et, double moon[3], double sun[3]) { return lunar::de_moon(et, moon) && lunar::de_sun(et, sun); }

inline bool tabulate(Seg& s, double t_lo, double t_hi) {
  s.tab_t0 = t_lo - 2.0 * s.tab_dt;
  const int n = static_cast<int>((t_hi - s.tab_t0) / s.tab_dt) + 5;
  s.tab.assign(6 * n, 0.0);
  for (int k = 0; k < n; ++k) {
    double moon[3], sun[3];
    if (!bodies_j2000(s.et0 + s.tab_t0 + k * s.tab_dt, moon, sun)) return false;
    for (int c = 0; c < 3; ++c) {
      s.tab[6 * k + c] = s.moon ? -moon[c] : moon[c];
      s.tab[6 * k + 3 + c] = s.moon ? sun[c] - moon[c] : sun[c];
    }
  }
  return true;
}

/// 4-point Lagrange interpolation of the table at t (s from the epoch).
inline void third(const Seg& s, double t, double* o) {
  const int n = static_cast<int>(s.tab.size() / 6);
  double u = (t - s.tab_t0) / s.tab_dt;
  int k = static_cast<int>(std::floor(u)) - 1;
  if (k < 0) k = 0;
  if (k > n - 4) k = n - 4;
  u -= k;
  const double w[4] = {-(u - 1) * (u - 2) * (u - 3) / 6.0, u * (u - 2) * (u - 3) / 2.0, -u * (u - 1) * (u - 3) / 2.0, u * (u - 1) * (u - 2) / 6.0};
  for (int c = 0; c < 6; ++c) o[c] = w[0] * s.tab[6 * k + c] + w[1] * s.tab[6 * (k + 1) + c] + w[2] * s.tab[6 * (k + 2) + c] + w[3] * s.tab[6 * (k + 3) + c];
}

inline void accel(const Seg& s, double t, const double* r, const double* v, double* a) {
  const double mu = s.moon ? kMuMoon : kMuEarth, mu3 = s.moon ? kMuEarth : kMuMoon;
  const double r2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2], rn = std::sqrt(r2);
  for (int c = 0; c < 3; ++c) a[c] = -mu * r[c] / (r2 * rn);
  {  // J2 about the epoch pole: the Moon's -sqrt(5) C20 (GRGM660PRIM), the Earth's EGM2008 value about J2000 z
    const double J2 = s.moon ? -std::sqrt(5.0) * lunar::lc(2, 0) : 1.08262668e-3, R = s.moon ? lunar::kR : 6378.1363;
    const double z = r[0] * s.pole[0] + r[1] * s.pole[1] + r[2] * s.pole[2];
    const double f = -1.5 * J2 * mu * R * R / (r2 * r2 * rn), q = 5.0 * z * z / r2;
    for (int c = 0; c < 3; ++c) a[c] += f * (r[c] * (1.0 - q) + s.pole[c] * z * 2.0);
  }
  double b[6];
  third(s, t, b);
  const double* rb[2] = {b, b + 3};
  const double mub[2] = {mu3, kMuSun};
  for (int j = 0; j < 2; ++j) {
    const double d[3] = {rb[j][0] - r[0], rb[j][1] - r[1], rb[j][2] - r[2]};
    const double dn = std::sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]), bn = std::sqrt(rb[j][0] * rb[j][0] + rb[j][1] * rb[j][1] + rb[j][2] * rb[j][2]);
    for (int c = 0; c < 3; ++c) a[c] += mub[j] * (d[c] / (dn * dn * dn) - rb[j][c] / (bn * bn * bn));
  }
  // radial SRP from the Sun (no shadow): P1AU (1 AU / d)^2 AGOM, km/s^2
  const double ds[3] = {r[0] - rb[1][0], r[1] - rb[1][1], r[2] - rb[1][2]};
  const double dsn = std::sqrt(ds[0] * ds[0] + ds[1] * ds[1] + ds[2] * ds[2]), au = dsn / 1.495978707e8;
  const double fs = 4.56e-6 * s.agom / (1000.0 * au * au);
  double h[3] = {r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]};
  const double hn = std::sqrt(h[0] * h[0] + h[1] * h[1] + h[2] * h[2]);
  double R[3], N[3], T[3];
  for (int c = 0; c < 3; ++c) { R[c] = r[c] / rn; N[c] = h[c] / hn; }
  T[0] = N[1] * R[2] - N[2] * R[1]; T[1] = N[2] * R[0] - N[0] * R[2]; T[2] = N[0] * R[1] - N[1] * R[0];
  for (int c = 0; c < 3; ++c) a[c] += fs * ds[c] / dsn + s.rtn[0] * R[c] + s.rtn[1] * T[c] + s.rtn[2] * N[c];
}

/// States (stride 6) or positions (stride 3) at ascending times t (s from the epoch; earlier times backward): RK4 on
/// a fixed 60 s node grid (3 % of r / v at an NRHO perilune; a state-dependent step would make the finite-difference
/// Jacobian discontinuous). The third-body table must cover the times.
constexpr double kStep = 60.0;
inline bool states(const Seg& s, const double* t, int count, double* out, int stride) {
  const double y0[6] = {s.r0[0], s.r0[1], s.r0[2], s.v0[0], s.v0[1], s.v0[2]};
  auto f = [&](double tt, const double* y, double* d) {
    double a[3];
    accel(s, tt, y, y + 3, a);
    for (int c = 0; c < 3; ++c) { d[c] = y[3 + c]; d[3 + c] = a[c]; }
  };
  return segment::rk4_states(f, y0, kStep, t, count, out, stride);
}
inline bool positions(const Seg& s, const double* t, int count, double* out) { return states(s, t, count, out, 3); }

/// Levenberg-Marquardt (Jacobi-scaled) on the state, AGOM and the RTN acceleration; returns the RMS (km) or < 0.
inline double fit(Seg& s, const double* t, const double* pos, int count, int iterations, int np) {
  constexpr int NP = 10;
  std::vector<double> res(3 * count), trial(3 * count), J(3 * count * NP, 0.0), p3(3 * count);
  auto get = [](Seg& q, int p) -> double& { return p < 3 ? q.r0[p] : p < 6 ? q.v0[p - 3] : p == 6 ? q.agom : q.rtn[p - 7]; };
  auto residuals = [&](const Seg& q, std::vector<double>& o) {
    if (!positions(q, t, count, p3.data())) return false;
    for (int k = 0; k < 3 * count; ++k) o[k] = p3[k] - pos[k];
    return true;
  };
  auto cost = [](const std::vector<double>& v) { double c = 0; for (double x : v) c += x * x; return c; };
  if (!residuals(s, res)) return -1.0;
  double c0 = cost(res), lambda = 1e-3;
  const double step[NP] = {1e-3, 1e-3, 1e-3, 1e-7, 1e-7, 1e-7, 1e-3, 1e-12, 1e-12, 1e-12};
  const double prior_sigma[NP] = {0, 0, 0, 0, 0, 0, 0.1, 1e-9, 1e-9, 1e-9};
  for (int it = 0; it < iterations; ++it) {
    for (int p = 0; p < np; ++p) {
      Seg q = s;
      get(q, p) += step[p];
      if (!residuals(q, trial)) return -2.0;
      for (int k = 0; k < 3 * count; ++k) J[k * NP + p] = (trial[k] - res[k]) / step[p];
    }
    double N[NP * NP] = {}, g[NP] = {};
    for (int k = 0; k < 3 * count; ++k)
      for (int i = 0; i < np; ++i) {
        g[i] += J[k * NP + i] * res[k];
        for (int j = 0; j < np; ++j) N[i * NP + j] += J[k * NP + i] * J[k * NP + j];
      }
    for (int p = np; p < NP; ++p) N[p * NP + p] = 1.0;
    for (int p = 6; p < np; ++p) {
      N[p * NP + p] += 1.0 / (prior_sigma[p] * prior_sigma[p]);
      g[p] += get(s, p) / (prior_sigma[p] * prior_sigma[p]);
    }
    bool improved = false;
    for (int tries = 0; tries < 8 && !improved; ++tries) {
      double A[NP * NP], b[NP], dx[NP], d[NP];
      for (int i = 0; i < NP; ++i) d[i] = N[i * NP + i] > 0.0 ? std::sqrt(N[i * NP + i]) : 1.0;
      for (int i = 0; i < NP; ++i)
        for (int j = 0; j < NP; ++j) A[i * NP + j] = N[i * NP + j] / (d[i] * d[j]);
      for (int i = 0; i < NP; ++i) { A[i * NP + i] *= 1.0 + lambda; b[i] = -g[i] / d[i]; }
      for (int c = 0; c < NP; ++c) {
        int pv = c;
        for (int r = c + 1; r < NP; ++r) if (std::fabs(A[r * NP + c]) > std::fabs(A[pv * NP + c])) pv = r;
        for (int j = 0; j < NP; ++j) std::swap(A[c * NP + j], A[pv * NP + j]);
        std::swap(b[c], b[pv]);
        for (int r = c + 1; r < NP; ++r) {
          const double f = A[r * NP + c] / A[c * NP + c];
          for (int j = c; j < NP; ++j) A[r * NP + j] -= f * A[c * NP + j];
          b[r] -= f * b[c];
        }
      }
      for (int c = NP - 1; c >= 0; --c) {
        double sum = b[c];
        for (int j = c + 1; j < NP; ++j) sum -= A[c * NP + j] * dx[j];
        dx[c] = sum / A[c * NP + c];
      }
      for (int i = 0; i < NP; ++i) dx[i] /= d[i];
      Seg q = s;
      for (int p = 0; p < np; ++p) get(q, p) += dx[p];
      if (residuals(q, trial) && cost(trial) < c0) {
        const double c1 = cost(trial);
        const bool converged = (c0 - c1) < 1e-12 * c0;
        s = std::move(q);
        res = trial;
        c0 = c1;
        lambda *= 0.3;
        improved = true;
        if (converged) it = iterations;
      } else {
        lambda *= 10.0;
      }
    }
    if (!improved) break;
  }
  return std::sqrt(c0 / count);
}

}  // namespace cislunar
}  // namespace sdnap

namespace sdnap {
namespace cislunar {

/// A segment's epoch-dependent parts: the Moon's pole at the epoch (DE440 PA) and the third-body table over
/// t_lo .. t_hi (s from the epoch); false outside the embedded span.
inline bool prepare(Seg& s, double t_lo, double t_hi) {
  if (s.moon) {
    double M[3][3];
    if (!lunar::j2000_to_pa(s.et0, M)) return false;
    for (int c = 0; c < 3; ++c) s.pole[c] = M[2][c];
  }
  return tabulate(s, t_lo, t_hi);
}

/// One segment fitted to the states [first, nfit) re-based to the epoch t_fit[first] (s from et_arc); the table
/// covers t_lo .. t_hi (s from et_arc). RMS (km) or < 0.
inline double fit_from(Seg& s, double et_arc, const double* t_fit, const double* pos_fit, const double* vel_fit, int first, int nfit,
                       double t_lo, double t_hi, int np) {
  const double t0 = t_fit[first];
  s.et0 = et_arc + t0;
  for (int c = 0; c < 3; ++c) { s.r0[c] = pos_fit[3 * first + c]; s.v0[c] = vel_fit[3 * first + c]; }
  s.agom = 0.0;
  for (double& a : s.rtn) a = 0.0;
  if (!prepare(s, t_lo - t0, t_hi - t0)) return -3.0;
  std::vector<double> t(t_fit + first, t_fit + nfit);
  for (double& x : t) x -= t0;
  return np == 0 ? 0.0 : fit(s, t.data(), pos_fit + 3 * first, nfit - first, 40, np);
}

/// The segment set of an arc (2h.2 / 2h.5): `base` carries the centre and the Moon's pole; np 6 (state), 7 (+ AGOM)
/// or 10 (+ RTN); with `segment` the rule of segment::choose_segment (at least 6 h). out: the kept set (epoch
/// et_arc + t_fit[first]); returns its RMS (km, < 0 on refusal) and first.
inline double fit_segmented(const Seg& base, double et_arc, const double* t_fit, const double* pos_fit, const double* vel_fit, int nfit,
                            double t_lo, double t_hi, int np, bool segment, Seg& out, int& first) {
  auto fit_at = [&](int k) {
    Seg q = base;
    return fit_from(q, et_arc, t_fit, pos_fit, vel_fit, k, nfit, t_lo, t_hi, np);
  };
  double rms = -1.0;
  first = segment::choose_segment(t_fit, nfit, segment, 6.0 * 3600.0, fit_at, rms);
  if (first < 0) return -2.0;
  out = base;
  return fit_from(out, et_arc, t_fit, pos_fit, vel_fit, first, nfit, t_lo, t_hi, np);
}

}  // namespace cislunar
}  // namespace sdnap

/// Diagnostic (2h.2 baseline): fit a segment about the Moon (`center` 2) or the Earth (1) to `nfit` J2000 states
/// (positions and velocities, km and km/s) at `t_fit` seconds from the UTC epoch (whole + frac JD); `mode` & 7: 0 the
/// state, 1 with AGOM, 2 with the RTN acceleration; 7 propagates the first state without a fit; `mode` & 8 segments
/// at a maneuver (segment::choose_segment). Positions at `t_out` (s from the same epoch) into `out`; returns the kept
/// fit's RMS (km), negative on refusal; *start_out the kept segment's start (s).
SDNAP_EXPORT("sdnap_cislunar_fit_predict")
double sdnap_cislunar_fit_predict(double whole, double frac, int32_t center, const double* t_fit, const double* pos_fit,
                                  const double* vel_fit, int32_t nfit, const double* t_out, int32_t nout, double* out, int32_t mode,
                                  double* start_out) {
  using namespace sdnap::cislunar;
  const double et_arc = sdnap::lunar::et_of(whole, frac);
  const int np = (mode & 7) == 7 ? 0 : (mode & 7) == 0 ? 6 : (mode & 7) == 1 ? 7 : 10;
  Seg base;
  base.moon = center == 2;
  if (base.moon) {
    double M[3][3];
    if (!sdnap::lunar::j2000_to_pa(et_arc, M)) return -3.0;
    for (int c = 0; c < 3; ++c) base.pole[c] = M[2][c];
  }
  const double t_hi = std::max(t_fit[nfit - 1], nout > 0 ? t_out[nout - 1] : 0.0);
  Seg s;
  int first = 0;
  const double rms = fit_segmented(base, et_arc, t_fit, pos_fit, vel_fit, nfit, t_fit[0], t_hi, np, (mode & 8) != 0, s, first);
  if (rms < 0) return rms;
  const double t0 = t_fit[first];
  if (start_out) *start_out = t0;
  if (nout > 0) {
    std::vector<double> t(t_out, t_out + nout);
    for (double& x : t) x -= t0;
    if (!positions(s, t.data(), nout, out)) return -4.0;
  }
  return rms;
}
