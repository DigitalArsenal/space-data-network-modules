// Orbit determination from the reduced angles.
//
// Initial orbit: Gooding's angles-only method (R. H. Gooding, "A new
// procedure for the solution of the classical problem of minimal orbit
// determination from three lines of sight", Celestial Mechanics and
// Dynamical Astronomy 66, 387-423, 1997; DRA report 1996): the ranges at the
// first and last sight are the unknowns; their positions fix a Lambert arc
// (here Izzo's solver, analysis/lambert-izzo), propagated to the middle time,
// whose miss perpendicular to the middle sight is driven to zero by Newton
// iteration. Two-body dynamics; started from circular-orbit range guesses.
//
// Differential correction: weighted batch least squares with a priori
// information (Tapley, Schutz & Born 2004, ch. 4) for the Cartesian GCRS
// state at the arc's middle. The reference trajectory is the propagator's
// answer for the prior element set (the pluggable port); deviations from it
// map through the state transition matrix of two-body plus J2 dynamics
// integrated along it (an arc of a few minutes: the linear map is exact to
// centimeters for kilometer deviations). Measurements are the observed
// directions with the light-time solution and the site's aberration, as the
// calibration models them. The calibration's site and timing parameters are
// consider parameters: their covariance from the calibrator enters the
// state covariance through the sensitivity of the solution (Tapley et al.
// 2004, sec. 6.3, the consider covariance).
namespace oa {

constexpr double kMuEarth = 398600.4418;      // km^3/s^2 (EGM-96 / WGS-84 GM)
constexpr double kReEarth = 6378.137;         // km
constexpr double kJ2 = 1.08262668e-3;

inline V3 gravity(V3 r) {
  const double r2 = dot(r, r), rn = std::sqrt(r2);
  const double mu_r3 = kMuEarth / (r2 * rn);
  V3 a = r * (-mu_r3);
  const double z2 = r.z * r.z / r2;
  const double k = 1.5 * kJ2 * kMuEarth * kReEarth * kReEarth / (r2 * r2 * rn);
  a.x += -k * r.x * (1 - 5 * z2);
  a.y += -k * r.y * (1 - 5 * z2);
  a.z += -k * r.z * (3 - 5 * z2);
  return a;
}
// Gravity gradient d(a)/d(r) by central differences (3x3, row-major).
inline void gravity_gradient(V3 r, double g[9]) {
  const double h = 1e-3;  // km
  for (int j = 0; j < 3; ++j) {
    V3 dp = r, dm = r;
    (j == 0 ? dp.x : j == 1 ? dp.y : dp.z) += h;
    (j == 0 ? dm.x : j == 1 ? dm.y : dm.z) -= h;
    const V3 a = gravity(dp), b = gravity(dm);
    g[0 * 3 + j] = (a.x - b.x) / (2 * h);
    g[1 * 3 + j] = (a.y - b.y) / (2 * h);
    g[2 * 3 + j] = (a.z - b.z) / (2 * h);
  }
}

// State transition matrices Phi(t_k, t0) along a reference trajectory,
// integrated with RK4 at <= 1 s steps from t0 to each requested time.
inline bool transition_matrices(const Trajectory& ref, double t0, const std::vector<double>& times, std::vector<std::array<double, 36>>* out) {
  out->assign(times.size(), {});
  auto deriv = [&](double t, const std::array<double, 36>& P, std::array<double, 36>* dP) {
    V3 r, v;
    if (!ref.at(t, &r, &v)) return false;
    double G[9];
    gravity_gradient(r, G);
    // A = [[0, I], [G, 0]]; dP = A P.
    for (int c = 0; c < 6; ++c) {
      for (int i = 0; i < 3; ++i) (*dP)[i * 6 + c] = P[(i + 3) * 6 + c];
      for (int i = 0; i < 3; ++i) {
        double s = 0;
        for (int k = 0; k < 3; ++k) s += G[i * 3 + k] * P[k * 6 + c];
        (*dP)[(i + 3) * 6 + c] = s;
      }
    }
    return true;
  };
  for (size_t q = 0; q < times.size(); ++q) {
    std::array<double, 36> P{};
    for (int i = 0; i < 6; ++i) P[i * 6 + i] = 1;
    const double span = times[q] - t0;
    const int steps = std::max(1, static_cast<int>(std::ceil(std::fabs(span) / 1.0)));
    const double h = span / steps;
    double t = t0;
    for (int s = 0; s < steps; ++s) {
      std::array<double, 36> k1, k2, k3, k4, tmp;
      if (!deriv(t, P, &k1)) return false;
      for (int i = 0; i < 36; ++i) tmp[i] = P[i] + 0.5 * h * k1[i];
      if (!deriv(t + 0.5 * h, tmp, &k2)) return false;
      for (int i = 0; i < 36; ++i) tmp[i] = P[i] + 0.5 * h * k2[i];
      if (!deriv(t + 0.5 * h, tmp, &k3)) return false;
      for (int i = 0; i < 36; ++i) tmp[i] = P[i] + h * k3[i];
      if (!deriv(t + h, tmp, &k4)) return false;
      for (int i = 0; i < 36; ++i) P[i] += h / 6.0 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
      t += h;
    }
    (*out)[q] = P;
  }
  return true;
}

// Two-body propagation by RK4 (the IOD's dynamics).
inline void kepler_rk4(V3* r, V3* v, double dt) {
  const int steps = std::max(1, static_cast<int>(std::ceil(std::fabs(dt) / 2.0)));
  const double h = dt / steps;
  auto acc = [](V3 x) { const double n = norm(x); return x * (-kMuEarth / (n * n * n)); };
  for (int s = 0; s < steps; ++s) {
    const V3 k1v = acc(*r), k1r = *v;
    const V3 k2v = acc(*r + k1r * (0.5 * h)), k2r = *v + k1v * (0.5 * h);
    const V3 k3v = acc(*r + k2r * (0.5 * h)), k3r = *v + k2v * (0.5 * h);
    const V3 k4v = acc(*r + k3r * h), k4r = *v + k3v * h;
    *r = *r + (k1r + k2r * 2 + k3r * 2 + k4r) * (h / 6);
    *v = *v + (k1v + k2v * 2 + k3v * 2 + k4v) * (h / 6);
  }
}

struct SightObs {
  double t = 0;   // receive time, UTC Unix s (tag + bias)
  V3 los;         // geometric line of sight (aberration removed), GCRS
  V3 site_km;     // site GCRS position, km
};

struct IodResult {
  bool ok = false;
  std::string error;
  double t = 0;
  V3 r, v;                      // km, km/s at t (the middle sight)
  double rho[3] = {0, 0, 0};    // ranges, km
  double miss_arcsec = 0;
  int iterations = 0;
  int solutions = 0;            // distinct converged solutions from the starts
};

// Gooding's method on three sights (light time neglected: < 30 m over a
// LEO arc, below an angles-only IOD's own range uncertainty).
inline IodResult gooding_iod(const SightObs s[3]) {
  IodResult best;
  best.error = "no start converged";
  std::vector<double> found;
  const double t12 = s[1].t - s[0].t, t13 = s[2].t - s[0].t;
  auto miss = [&](double r1, double r3, double out[2], V3* p2, V3* v2) {
    const V3 p1 = s[0].site_km + s[0].los * r1, p3 = s[2].site_km + s[2].los * r3;
    lambert_izzo::Request rq;
    rq.r1 = {p1.x, p1.y, p1.z};
    rq.r2 = {p3.x, p3.y, p3.z};
    rq.tof = t13;
    rq.mu = kMuEarth;
    const lambert_izzo::Result lr = lambert_izzo::solve(rq);
    if (lr.status != lambert_izzo::Status::Ok) return false;
    V3 r = p1, v{lr.single.v1.x, lr.single.v1.y, lr.single.v1.z};
    kepler_rk4(&r, &v, t12);
    *p2 = r;
    *v2 = v;
    const V3 d = unit(r - s[1].site_km);
    V3 e, n;
    tangent_basis(s[1].los, &e, &n);
    out[0] = dot(d - s[1].los, e);
    out[1] = dot(d - s[1].los, n);
    return true;
  };
  for (double alt : {300.0, 500.0, 700.0, 1000.0, 1500.0, 2500.0}) {
    // Range to a circular orbit of this altitude along the first sight.
    auto range_to = [&](const SightObs& o) {
      const double b = 2 * dot(o.site_km, o.los), c = dot(o.site_km, o.site_km) - std::pow(kReEarth + alt, 2);
      const double disc = b * b - 4 * c;
      return disc > 0 ? (-b + std::sqrt(disc)) / 2 : kNaN;
    };
    double r1 = range_to(s[0]), r3 = range_to(s[2]);
    if (!std::isfinite(r1) || !std::isfinite(r3)) continue;
    bool ok = false;
    int it = 0;
    V3 p2, v2;
    double f[2];
    for (; it < 40; ++it) {
      if (!miss(r1, r3, f, &p2, &v2)) break;
      if (std::hypot(f[0], f[1]) < 1e-12) { ok = true; break; }
      double J[2][2];
      const double h1 = 1e-3 * r1, h3 = 1e-3 * r3;
      double f1[2], f3[2];
      V3 tp, tv;
      if (!miss(r1 + h1, r3, f1, &tp, &tv) || !miss(r1, r3 + h3, f3, &tp, &tv)) break;
      for (int k = 0; k < 2; ++k) { J[k][0] = (f1[k] - f[k]) / h1; J[k][1] = (f3[k] - f[k]) / h3; }
      // Least-squares Newton step (two residuals, two unknowns).
      const double det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
      if (std::fabs(det) < 1e-30) break;
      double d1 = (J[1][1] * f[0] - J[0][1] * f[1]) / det, d3 = (-J[1][0] * f[0] + J[0][0] * f[1]) / det;
      // Damp steps beyond a fifth of the range.
      const double lim = 0.2 * std::min(r1, r3);
      const double scale = std::max(1.0, std::max(std::fabs(d1), std::fabs(d3)) / lim);
      r1 -= d1 / scale;
      r3 -= d3 / scale;
      if (r1 <= 0 || r3 <= 0) break;
      if (std::fabs(d1) + std::fabs(d3) < 1e-7) { ok = miss(r1, r3, f, &p2, &v2); break; }
    }
    if (!ok) continue;
    const double r2n = norm(p2 - s[1].site_km);
    bool dup = false;
    for (double x : found) dup = dup || std::fabs(x - r2n) < 1.0;
    if (!dup) found.push_back(r2n);
    const double m = std::hypot(f[0], f[1]) / kArcsec;
    // Keep the solution whose orbit is bound and nearest-circular.
    const double energy = 0.5 * dot(v2, v2) - kMuEarth / norm(p2);
    if (energy >= 0) continue;
    if (!best.ok || m < best.miss_arcsec) {
      best.ok = true;
      best.error.clear();
      best.t = s[1].t;
      best.r = p2;
      best.v = v2;
      best.rho[0] = r1;
      best.rho[1] = r2n;
      best.rho[2] = r3;
      best.miss_arcsec = m;
      best.iterations = it;
    }
  }
  best.solutions = static_cast<int>(found.size());
  return best;
}

struct OdObservation {
  double t = 0;           // tag, UTC Unix s
  V3 u;                   // observed direction (with the site's aberration)
  double c[2][2] = {{0}}; // tangent-plane covariance, rad^2
};

struct OdResult {
  bool ok = false;
  std::string error;
  double t0 = 0;
  double x[6] = {0};                 // km, km/s GCRS at t0
  std::vector<double> cov;           // 6x6 noise-only (with the prior)
  std::vector<double> cov_total;     // 6x6 with the consider parameters
  std::vector<double> prior_cov;     // 6x6 the prior used
  double prior_x[6] = {0};
  std::vector<std::array<double, 2>> residual_arcsec;
  double rms_arcsec = 0, chi2 = 0;
  int dof = 0, iterations = 0, used = 0;
  IodResult iod;
};

// Site-and-time-dependent predicted observed direction for a satellite
// whose GCRS position at time t comes from `pos`.
template <typename PosFn>
inline bool predict_obs(const ax::Mat3& t2c, const double theta[4], double tag, PosFn pos, V3* out, V3* site_km = nullptr) {
  Site s;
  s.lat = theta[0]; s.lon = theta[1]; s.h = theta[2];
  const double dt = theta[3], omega = 7.292115146706979e-5;
  const V3 sg = rotz(rotate(t2c, site_itrs_km(s)), omega * dt);
  const V3 sv = cross(V3{0, 0, omega}, sg);
  const double t = tag + dt;
  double tau = 0;
  V3 r;
  for (int it = 0; it < 4; ++it) {
    if (!pos(t - tau, &r)) return false;
    tau = norm(r - sg) * 1000.0 / kSpeedOfLight;
  }
  const V3 u = unit(r - sg);
  const V3 beta = sv * (1000.0 / kSpeedOfLight);
  *out = unit(u + beta - u * dot(u, beta));
  if (site_km) *site_km = sg;
  return true;
}

inline OdResult determine_orbit_once(const Trajectory& ref, const std::vector<OdObservation>& obs, const Clock& clock, const CalibrationResult& cal,
                                     const std::vector<double>& prior_cov_gcrs, double t0) {
  OdResult res;
  res.t0 = t0;
  if (obs.size() < 3) { res.error = "fewer than three observations"; return res; }
  std::vector<ax::Mat3> t2c;
  std::vector<double> times;
  for (const OdObservation& o : obs) {
    ax::Epoch e;
    ax::EarthOrientation eo;
    if (!clock.at(o.t, &e, &eo, &res.error)) return res;
    t2c.push_back(ax::transpose(ax::gcrfToItrf(e, eo)));
    times.push_back(o.t + cal.dt);
  }
  // Reference state at t0 and the transition matrices to every receive
  // time (light time < 10 ms: the matrix at the receive time serves).
  V3 r0, v0;
  if (!ref.at(t0, &r0, &v0)) { res.error = "the prior trajectory does not cover the arc's middle"; return res; }
  const double xref[6] = {r0.x, r0.y, r0.z, v0.x, v0.y, v0.z};
  std::vector<std::array<double, 36>> phi;
  if (!transition_matrices(ref, t0, times, &phi)) { res.error = "the prior trajectory does not cover the arc"; return res; }
  for (int i = 0; i < 6; ++i) res.prior_x[i] = xref[i];
  res.prior_cov = prior_cov_gcrs;
  const double theta[4] = {cal.site.lat, cal.site.lon, cal.site.h, cal.dt};
  // Position at time t for a deviation dx at t0 (Phi from the nearest
  // receive time; the light-time offset of a few ms moves Phi negligibly).
  auto make_pos = [&](size_t k, const double dx[6]) {
    return [&, k, dx](double t, V3* r) {
      V3 rr, vv;
      if (!ref.at(t, &rr, &vv)) return false;
      double d[3] = {0, 0, 0};
      for (int i = 0; i < 3; ++i)
        for (int j = 0; j < 6; ++j) d[i] += phi[k][i * 6 + j] * dx[j];
      *r = rr + V3{d[0], d[1], d[2]};
      return true;
    };
  };
  std::vector<double> P0inv;
  if (prior_cov_gcrs.size() == 36) {
    std::vector<double> inv;
    if (!cholesky_solve(prior_cov_gcrs, 6, nullptr, &inv)) { res.error = "the prior covariance is not positive definite"; return res; }
    P0inv = inv;
  } else {
    P0inv.assign(36, 0.0);
  }
  double dx[6] = {0, 0, 0, 0, 0, 0};
  std::vector<double> cov, Hall, Wall;
  const double steps[6] = {1e-3, 1e-3, 1e-3, 1e-6, 1e-6, 1e-6};
  for (int it = 0; it < 12; ++it) {
    std::vector<double> N(P0inv), b(6, 0.0);
    for (int a = 0; a < 6; ++a)
      for (int c = 0; c < 6; ++c) b[a] -= P0inv[a * 6 + c] * dx[c];
    double chi2 = 0;
    res.residual_arcsec.assign(obs.size(), {0, 0});
    for (size_t k = 0; k < obs.size(); ++k) {
      const OdObservation& o = obs[k];
      V3 e, n, u0;
      tangent_basis(o.u, &e, &n);
      if (!predict_obs(t2c[k], theta, o.t, make_pos(k, dx), &u0)) { res.error = "prediction outside the trajectory"; return res; }
      const double rr[2] = {dot(o.u - u0, e), dot(o.u - u0, n)};
      double H[2][6];
      for (int j = 0; j < 6; ++j) {
        double d2[6];
        std::copy(dx, dx + 6, d2);
        d2[j] += steps[j];
        V3 u1;
        predict_obs(t2c[k], theta, o.t, make_pos(k, d2), &u1);
        H[0][j] = dot(u1 - u0, e) / steps[j];
        H[1][j] = dot(u1 - u0, n) / steps[j];
      }
      const double det = o.c[0][0] * o.c[1][1] - o.c[0][1] * o.c[1][0];
      const double W[2][2] = {{o.c[1][1] / det, -o.c[0][1] / det}, {-o.c[1][0] / det, o.c[0][0] / det}};
      for (int a = 0; a < 6; ++a)
        for (int x = 0; x < 2; ++x)
          for (int y = 0; y < 2; ++y) {
            b[a] += H[x][a] * W[x][y] * rr[y];
            for (int c = 0; c < 6; ++c) N[a * 6 + c] += H[x][a] * W[x][y] * H[y][c];
          }
      chi2 += rr[0] * (W[0][0] * rr[0] + W[0][1] * rr[1]) + rr[1] * (W[1][0] * rr[0] + W[1][1] * rr[1]);
      res.residual_arcsec[k] = {rr[0] / kArcsec, rr[1] / kArcsec};
    }
    std::vector<double> step(b);
    if (!cholesky_solve(N, 6, &step, &cov)) { res.error = "the orbit normal matrix is singular (add a prior)"; return res; }
    for (int a = 0; a < 6; ++a) dx[a] += step[a];
    res.chi2 = chi2;
    res.iterations = it + 1;
    if (std::fabs(step[0]) + std::fabs(step[1]) + std::fabs(step[2]) < 1e-6) break;
  }
  // Final residuals, partials for the consider analysis.
  double ss = 0, chi2 = 0;
  std::vector<double> HtWHth(6 * 4, 0.0);  // H^T W H_theta
  const double tsteps[4] = {1e-7, 1e-7, 1.0, 1e-3};
  for (size_t k = 0; k < obs.size(); ++k) {
    const OdObservation& o = obs[k];
    V3 e, n, u0;
    tangent_basis(o.u, &e, &n);
    predict_obs(t2c[k], theta, o.t, make_pos(k, dx), &u0);
    const double rr[2] = {dot(o.u - u0, e), dot(o.u - u0, n)};
    const double det = o.c[0][0] * o.c[1][1] - o.c[0][1] * o.c[1][0];
    const double W[2][2] = {{o.c[1][1] / det, -o.c[0][1] / det}, {-o.c[1][0] / det, o.c[0][0] / det}};
    chi2 += rr[0] * (W[0][0] * rr[0] + W[0][1] * rr[1]) + rr[1] * (W[1][0] * rr[0] + W[1][1] * rr[1]);
    res.residual_arcsec[k] = {rr[0] / kArcsec, rr[1] / kArcsec};
    ss += (rr[0] * rr[0] + rr[1] * rr[1]) / (kArcsec * kArcsec);
    double H[2][6], Ht[2][4];
    for (int j = 0; j < 6; ++j) {
      double d2[6];
      std::copy(dx, dx + 6, d2);
      d2[j] += steps[j];
      V3 u1;
      predict_obs(t2c[k], theta, o.t, make_pos(k, d2), &u1);
      H[0][j] = dot(u1 - u0, e) / steps[j];
      H[1][j] = dot(u1 - u0, n) / steps[j];
    }
    for (int j = 0; j < 4; ++j) {
      double th[4];
      std::copy(theta, theta + 4, th);
      th[j] += tsteps[j];
      V3 u1;
      predict_obs(t2c[k], th, o.t, make_pos(k, dx), &u1);
      Ht[0][j] = dot(u1 - u0, e) / tsteps[j];
      Ht[1][j] = dot(u1 - u0, n) / tsteps[j];
    }
    for (int a = 0; a < 6; ++a)
      for (int j = 0; j < 4; ++j)
        for (int x = 0; x < 2; ++x)
          for (int y = 0; y < 2; ++y) HtWHth[a * 4 + j] += H[x][a] * W[x][y] * Ht[y][j];
  }
  res.chi2 = chi2;
  res.used = static_cast<int>(obs.size());
  res.dof = static_cast<int>(2 * obs.size()) - 6;
  res.rms_arcsec = std::sqrt(ss / obs.size());
  for (int i = 0; i < 6; ++i) res.x[i] = xref[i] + dx[i];
  res.cov = cov;
  // Consider: S = -P H^T W H_theta (6x4); P_total = P + S C_theta S^T, with
  // C_theta the calibration's lat, lon, h, dt block.
  std::vector<double> S(24, 0.0);
  for (int a = 0; a < 6; ++a)
    for (int j = 0; j < 4; ++j) {
      double s = 0;
      for (int c = 0; c < 6; ++c) s += cov[a * 6 + c] * HtWHth[c * 4 + j];
      S[a * 4 + j] = -s;
    }
  res.cov_total = cov;
  if (cal.cov.size() == 49) {
    double C[4][4];
    for (int i = 0; i < 4; ++i)
      for (int j = 0; j < 4; ++j) C[i][j] = cal.cov[i * 7 + j];
    for (int a = 0; a < 6; ++a)
      for (int b = 0; b < 6; ++b) {
        double s = 0;
        for (int i = 0; i < 4; ++i)
          for (int j = 0; j < 4; ++j) s += S[a * 4 + i] * C[i][j] * S[b * 4 + j];
        res.cov_total[a * 6 + b] += s;
      }
  }
  // Gooding IOD on the first, middle and last observations.
  {
    SightObs s3[3];
    const size_t idx[3] = {0, obs.size() / 2, obs.size() - 1};
    for (int q = 0; q < 3; ++q) {
      const OdObservation& o = obs[idx[q]];
      Site site = cal.site;
      ax::Epoch e;
      ax::EarthOrientation eo;
      std::string err;
      clock.at(o.t + cal.dt, &e, &eo, &err);
      V3 sr, sv;
      site_gcrs(site, e, eo, &sr, &sv);
      s3[q].t = o.t + cal.dt;
      s3[q].los = deaberrate(o.u, sv);
      s3[q].site_km = sr * 1e-3;
    }
    res.iod = gooding_iod(s3);
  }
  res.ok = true;
  return res;
}

// The batch with data editing: observations beyond five robust sigmas of
// the normalized residuals are dropped and the fit repeated until no more
// are (a satellite blended with a passing star trail measures far off).
inline OdResult determine_orbit(const Trajectory& ref, std::vector<OdObservation> obs, const Clock& clock, const CalibrationResult& cal,
                                const std::vector<double>& prior_cov_gcrs, double t0, int* edited) {
  *edited = 0;
  OdResult res;
  for (int pass = 0; pass < 8; ++pass) {
    res = determine_orbit_once(ref, obs, clock, cal, prior_cov_gcrs, t0);
    if (!res.ok) return res;
    std::vector<double> chi(obs.size());
    for (size_t k = 0; k < obs.size(); ++k) {
      const OdObservation& o = obs[k];
      const double rx = res.residual_arcsec[k][0] * kArcsec, ry = res.residual_arcsec[k][1] * kArcsec;
      const double det = o.c[0][0] * o.c[1][1] - o.c[0][1] * o.c[1][0];
      chi[k] = std::sqrt((o.c[1][1] * rx * rx - 2 * o.c[0][1] * rx * ry + o.c[0][0] * ry * ry) / det);
    }
    const double cut = std::max(3.0, 5.0 * 1.4826 * median(chi) / 1.1774);
    std::vector<OdObservation> kept;
    for (size_t k = 0; k < obs.size(); ++k) if (chi[k] < cut) kept.push_back(obs[k]);
    if (kept.size() == obs.size() || kept.size() < 6) break;
    *edited += static_cast<int>(obs.size() - kept.size());
    obs = std::move(kept);
  }
  return res;
}

// RTN axes of a state (rows R, T, N).
inline void rtn_axes(const double x[6], V3 axes[3]) {
  const V3 r{x[0], x[1], x[2]}, v{x[3], x[4], x[5]};
  axes[0] = unit(r);
  axes[2] = unit(cross(r, v));
  axes[1] = cross(axes[2], axes[0]);
}
// Rotate a 6x6 GCRS covariance into RTN (position and velocity blocks).
inline std::vector<double> to_rtn(const std::vector<double>& c, const double x[6]) {
  V3 ax3[3];
  rtn_axes(x, ax3);
  double R[6][6] = {{0}};
  for (int i = 0; i < 3; ++i) {
    const double row[3] = {ax3[i].x, ax3[i].y, ax3[i].z};
    for (int j = 0; j < 3; ++j) { R[i][j] = row[j]; R[i + 3][j + 3] = row[j]; }
  }
  std::vector<double> out(36, 0.0);
  for (int a = 0; a < 6; ++a)
    for (int b = 0; b < 6; ++b) {
      double s = 0;
      for (int i = 0; i < 6; ++i)
        for (int j = 0; j < 6; ++j) s += R[a][i] * c[i * 6 + j] * R[b][j];
      out[a * 6 + b] = s;
    }
  return out;
}
inline std::vector<double> from_rtn(const std::vector<double>& c, const double x[6]) {
  V3 ax3[3];
  rtn_axes(x, ax3);
  double R[6][6] = {{0}};
  for (int i = 0; i < 3; ++i) {
    const double row[3] = {ax3[i].x, ax3[i].y, ax3[i].z};
    for (int j = 0; j < 3; ++j) { R[i][j] = row[j]; R[i + 3][j + 3] = row[j]; }
  }
  std::vector<double> out(36, 0.0);
  for (int a = 0; a < 6; ++a)
    for (int b = 0; b < 6; ++b) {
      double s = 0;
      for (int i = 0; i < 6; ++i)
        for (int j = 0; j < 6; ++j) s += R[i][a] * c[i * 6 + j] * R[j][b];
      out[a * 6 + b] = s;
    }
  return out;
}

}  // namespace oa
