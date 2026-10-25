// -----------------------------------------------------------------------------
// SDN-AP 2h.2: the fitted quasi-periodic series of a libration-point orbit
// (NRHO, halo), a diagnostic beside the cislunar segments. Frame: the Earth-Moon
// synodic frame about the Moon, pulsating with the Earth-Moon distance d(t)
// (x from the Earth to the Moon, z along the Moon's orbital angular momentum;
// DE440). Phase: a Sundman anomaly s, ds/dt = 1 / r (r the distance to the
// Moon), so the sharp perilune passage spreads over few harmonics; theta1 =
// 2 pi s / S (S the anomaly per revolution, from the perilunes in the data),
// theta2 the Moon's mean anomaly (theta3 the Sun's 2D, optional). Series: each
// normalized synodic coordinate sum_{k <= K, |l| <= L} a cos(k theta1 + l
// theta2) + b sin(...), and t(s) = c s + the same sum, fitted by linear
// least squares with the same forcing phases; a prediction solves t(s) = t for s
// with the phases of the target time.
// -----------------------------------------------------------------------------

namespace sdnap {
namespace nrho {

/// The synodic axes (rows: x, y, z in ICRF) and the Earth-Moon distance at et; false outside the DE440 span.
inline bool synodic(double et, double R[3][3], double& d) {
  double m[3], mp[3], mm[3];
  if (!lunar::de_moon(et, m) || !lunar::de_moon(et + 60.0, mp) || !lunar::de_moon(et - 60.0, mm)) return false;
  const double v[3] = {(mp[0] - mm[0]) / 120.0, (mp[1] - mm[1]) / 120.0, (mp[2] - mm[2]) / 120.0};
  d = std::sqrt(m[0] * m[0] + m[1] * m[1] + m[2] * m[2]);
  double z[3] = {m[1] * v[2] - m[2] * v[1], m[2] * v[0] - m[0] * v[2], m[0] * v[1] - m[1] * v[0]};
  const double zn = std::sqrt(z[0] * z[0] + z[1] * z[1] + z[2] * z[2]);
  for (int c = 0; c < 3; ++c) { R[0][c] = m[c] / d; R[2][c] = z[c] / zn; }
  R[1][0] = R[2][1] * R[0][2] - R[2][2] * R[0][1];
  R[1][1] = R[2][2] * R[0][0] - R[2][0] * R[0][2];
  R[1][2] = R[2][0] * R[0][1] - R[2][1] * R[0][0];
  return true;
}

/// The Moon's mean anomaly (rad) at et (Simon et al. 1994, linear part).
inline double moon_anomaly(double et) { return (134.96340251 + 13.06499295 * (et / 86400.0)) * kPi / 180.0; }

/// Linear least squares by normal equations with a small ridge (Cholesky); A is m x n row-major. False when singular.
inline bool lsq(const std::vector<double>& A, const std::vector<double>& y, int m, int n, std::vector<double>& x) {
  std::vector<double> N(static_cast<size_t>(n) * n, 0.0), g(n, 0.0);
  for (int i = 0; i < m; ++i) {
    const double* a = A.data() + static_cast<size_t>(i) * n;
    for (int p = 0; p < n; ++p) {
      if (a[p] == 0.0) continue;
      g[p] += a[p] * y[i];
      for (int q = p; q < n; ++q) N[static_cast<size_t>(p) * n + q] += a[p] * a[q];
    }
  }
  double tr = 0.0;
  for (int p = 0; p < n; ++p) tr += N[static_cast<size_t>(p) * n + p];
  for (int p = 0; p < n; ++p) N[static_cast<size_t>(p) * n + p] += 1e-12 * tr / n;
  for (int p = 0; p < n; ++p)
    for (int q = 0; q < p; ++q) N[static_cast<size_t>(p) * n + q] = N[static_cast<size_t>(q) * n + p];
  for (int j = 0; j < n; ++j) {  // Cholesky in place (lower)
    double sum = N[static_cast<size_t>(j) * n + j];
    for (int k = 0; k < j; ++k) sum -= N[static_cast<size_t>(j) * n + k] * N[static_cast<size_t>(j) * n + k];
    if (!(sum > 0.0)) return false;
    const double l = std::sqrt(sum);
    N[static_cast<size_t>(j) * n + j] = l;
    for (int i = j + 1; i < n; ++i) {
      double s = N[static_cast<size_t>(i) * n + j];
      for (int k = 0; k < j; ++k) s -= N[static_cast<size_t>(i) * n + k] * N[static_cast<size_t>(j) * n + k];
      N[static_cast<size_t>(i) * n + j] = s / l;
    }
  }
  x.assign(n, 0.0);
  for (int i = 0; i < n; ++i) {
    double s = g[i];
    for (int k = 0; k < i; ++k) s -= N[static_cast<size_t>(i) * n + k] * x[k];
    x[i] = s / N[static_cast<size_t>(i) * n + i];
  }
  for (int i = n - 1; i >= 0; --i) {
    double s = x[i];
    for (int k = i + 1; k < n; ++k) s -= N[static_cast<size_t>(k) * n + i] * x[k];
    x[i] = s / N[static_cast<size_t>(i) * n + i];
  }
  return true;
}

inline double& last_coordinate_rms() { static double v = 0.0; return v; }
inline double& last_time_rms() { static double v = 0.0; return v; }

struct Series {
  int K = 30, L = 1;
  bool solar = false;  // the Sun's argument 2D (D the Moon's mean elongation) as a second forcing phase
  double et_arc = 0.0, s0 = 0.0, S = 1.0;
  std::vector<double> cx[3], ct;  // the coordinates' and t(s)'s coefficients
};

inline int basis_count(int K, int L, bool solar = false) { return (K + 1) * (2 * L + 1) * (solar ? 2 * L + 1 : 1) * 2; }
inline void basis(int K, int L, double th1, double th2, double* phi, bool solar = false, double th3 = 0.0) {
  int j = 0;
  const int M = solar ? L : 0;
  for (int k = 0; k <= K; ++k)
    for (int l = -L; l <= L; ++l)
      for (int q = -M; q <= M; ++q) {
        const double a = k * th1 + l * th2 + q * th3;
        phi[j++] = std::cos(a);
        phi[j++] = (k == 0 && l == 0 && q == 0) ? 0.0 : std::sin(a);
      }
}

/// The basis and its derivative in theta1 (the same order as basis()).
inline void basis_d1(int K, int L, double th1, double th2, double* phi, double* dphi, bool solar = false, double th3 = 0.0) {
  int j = 0;
  const int M = solar ? L : 0;
  for (int k = 0; k <= K; ++k)
    for (int l = -L; l <= L; ++l)
      for (int q = -M; q <= M; ++q) {
        const double a = k * th1 + l * th2 + q * th3, c = std::cos(a), sn = std::sin(a);
        const bool zero = k == 0 && l == 0 && q == 0;
        phi[j] = c; dphi[j++] = -k * sn;
        phi[j] = zero ? 0.0 : sn; dphi[j++] = zero ? 0.0 : k * c;
      }
}

/// The Sun's argument 2D (D the Moon's mean elongation, Simon et al. 1994, linear part), rad.
inline double solar_argument(double et) { return 2.0 * (297.85019547 + 12.19074912 * (et / 86400.0)) * kPi / 180.0; }

/// Positions at times t (s from et_arc) from a fitted series: t(s) = t solved by Newton from s_guess onward.
inline bool positions(const Series& f, const double* t, int n, double* out, double s_guess) {
  const int nb = basis_count(f.K, f.L, f.solar);
  std::vector<double> phi(nb), dphi(nb);
  double s = s_guess;
  for (int k = 0; k < n; ++k) {
    // t(s) = c (s - s0) + sum c_j phi_j(theta1(s), theta2(t), theta3(t)): the forcing phases are the target time's
    const double th2 = moon_anomaly(f.et_arc + t[k]), th3 = solar_argument(f.et_arc + t[k]);
    for (int it = 0; it < 60; ++it) {
      const double th1 = 2.0 * kPi * (s - f.s0) / f.S;
      basis_d1(f.K, f.L, th1, th2, phi.data(), dphi.data(), f.solar, th3);
      double tt = f.ct[0] * (s - f.s0), dt = f.ct[0];
      for (int q = 0; q < nb; ++q) { tt += f.ct[1 + q] * phi[q]; dt += f.ct[1 + q] * dphi[q] * 2.0 * kPi / f.S; }
      if (!(dt > 0.0)) dt = f.ct[0];  // a non-monotonic stretch of the extrapolated t(s): the mean rate
      if (!(dt > 0.0)) return false;
      const double step = (tt - t[k]) / dt;
      s -= step;
      if (std::fabs(step) * dt < 1e-6) break;
    }
    const double th1 = 2.0 * kPi * (s - f.s0) / f.S;
    basis(f.K, f.L, th1, th2, phi.data(), f.solar, th3);
    double xi[3] = {0, 0, 0};
    for (int c = 0; c < 3; ++c)
      for (int q = 0; q < nb; ++q) xi[c] += f.cx[c][q] * phi[q];
    double R[3][3], d;
    if (!synodic(f.et_arc + t[k], R, d)) return false;
    for (int c = 0; c < 3; ++c) out[3 * k + c] = d * (R[0][c] * xi[0] + R[1][c] * xi[1] + R[2][c] * xi[2]);
  }
  return true;
}

/// Fit the series to Moon-centered ICRF positions at t (s from et_arc). In-span RMS (km), < 0 on refusal.
inline double fit(Series& f, double et_arc, const double* t, const double* pos, int n) {
  f.et_arc = et_arc;
  std::vector<double> r(n), s(n, 0.0), xi(3 * n);
  for (int k = 0; k < n; ++k) {
    const double* p = pos + 3 * k;
    r[k] = std::sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
    double R[3][3], d;
    if (!synodic(et_arc + t[k], R, d)) return -3.0;
    for (int c = 0; c < 3; ++c) xi[3 * k + c] = (R[c][0] * p[0] + R[c][1] * p[1] + R[c][2] * p[2]) / d;
  }
  for (int k = 1; k < n; ++k) s[k] = s[k - 1] + 0.5 * (t[k] - t[k - 1]) * (1.0 / r[k] + 1.0 / r[k - 1]);
  std::vector<int> peri;
  for (int k = 1; k + 1 < n; ++k)
    if (r[k] < r[k - 1] && r[k] <= r[k + 1] && r[k] < 0.5 * (*std::max_element(r.begin(), r.end()))) peri.push_back(k);
  if (peri.size() < 2) return -6.0;  // fewer than two perilunes: no revolution to phase
  f.s0 = s[peri.front()];
  f.S = (s[peri.back()] - s[peri.front()]) / static_cast<double>(peri.size() - 1);
  const int nb = basis_count(f.K, f.L, f.solar), nt = 1 + nb;
  std::vector<double> A(static_cast<size_t>(n) * nb), At(static_cast<size_t>(n) * nt), y(n);
  for (int k = 0; k < n; ++k) {
    const double th1 = 2.0 * kPi * (s[k] - f.s0) / f.S, th2 = moon_anomaly(et_arc + t[k]);
    basis(f.K, f.L, th1, th2, A.data() + static_cast<size_t>(k) * nb, f.solar, solar_argument(et_arc + t[k]));
    double* b = At.data() + static_cast<size_t>(k) * nt;
    b[0] = s[k] - f.s0;
    for (int q = 0; q < nb; ++q) b[1 + q] = A[static_cast<size_t>(k) * nb + q];
  }
  for (int c = 0; c < 3; ++c) {
    for (int k = 0; k < n; ++k) y[k] = xi[3 * k + c];
    if (!lsq(A, y, n, nb, f.cx[c])) return -7.0;
  }
  for (int k = 0; k < n; ++k) y[k] = t[k];
  if (!lsq(At, y, n, nt, f.ct)) return -7.0;
  {  // the coordinates' residual at the data's own anomaly (km) and t(s)'s (s), apart from the inversion
    double sc = 0.0, st = 0.0;
    for (int k = 0; k < n; ++k) {
      double R[3][3], d;
      synodic(et_arc + t[k], R, d);
      const double* a = A.data() + static_cast<size_t>(k) * nb;
      for (int c = 0; c < 3; ++c) {
        double v = 0.0;
        for (int j = 0; j < nb; ++j) v += f.cx[c][j] * a[j];
        sc += d * d * (v - xi[3 * k + c]) * (v - xi[3 * k + c]);
      }
      const double* b = At.data() + static_cast<size_t>(k) * nt;
      double v = 0.0;
      for (int j = 0; j < nt; ++j) v += f.ct[j] * b[j];
      st += (v - t[k]) * (v - t[k]);
    }
    last_coordinate_rms() = std::sqrt(sc / n);
    last_time_rms() = std::sqrt(st / n);
  }
  // in-span RMS through the evaluation used for predictions
  std::vector<double> out(3 * n);
  double ss = 0.0;
  if (!positions(f, t, n, out.data(), 0.0)) return -8.0;
  for (int k = 0; k < 3 * n; ++k) ss += (out[k] - pos[k]) * (out[k] - pos[k]);
  return std::sqrt(ss / n);
}

}  // namespace nrho
}  // namespace sdnap

/// Diagnostic (2h.2): fit the quasi-periodic series (K theta1 harmonics, L theta2 harmonics, with the Sun's 2D as a third
/// phase to the same L when `orders` & 65536; `orders` = K + 256 L)
/// to `nfit` Moon-centered ICRF positions at `t_fit` seconds from the UTC epoch whole + frac and write positions at
/// `t_out` (s, ascending, after the fit) into `out`. Returns the in-span RMS (km), negative on refusal.
SDNAP_EXPORT("sdnap_nrho_series_fit_predict")
double sdnap_nrho_series_fit_predict(double whole, double frac, const double* t_fit, const double* pos_fit, int32_t nfit, const double* t_out,
                                     int32_t nout, double* out, int32_t orders) {
  sdnap::nrho::Series f;
  f.K = orders & 255;
  f.L = (orders >> 8) & 255;
  f.solar = (orders >> 16) & 1;
  const double rms = sdnap::nrho::fit(f, sdnap::lunar::et_of(whole, frac), t_fit, pos_fit, nfit);
  if (rms < 0) return rms;
  // the anomaly at the arc's end: the Newton start for the predictions
  double s_end = 0.0;
  {
    std::vector<double> r(nfit);
    for (int k = 0; k < nfit; ++k) r[k] = std::sqrt(pos_fit[3 * k] * pos_fit[3 * k] + pos_fit[3 * k + 1] * pos_fit[3 * k + 1] + pos_fit[3 * k + 2] * pos_fit[3 * k + 2]);
    for (int k = 1; k < nfit; ++k) s_end += 0.5 * (t_fit[k] - t_fit[k - 1]) * (1.0 / r[k] + 1.0 / r[k - 1]);
  }
  if (nout > 0 && !sdnap::nrho::positions(f, t_out, nout, out, s_end)) return -9.0;
  return rms;
}

/// Diagnostic: the last series fit's coordinate residual (km) at the data's anomaly and its t(s) residual (s).
SDNAP_EXPORT("sdnap_nrho_last_residuals")
double sdnap_nrho_last_residuals(int32_t which) { return which == 0 ? sdnap::nrho::last_coordinate_rms() : sdnap::nrho::last_time_rms(); }
