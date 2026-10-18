// Site and timing from a calibrator: an object whose orbit is known to a
// stated uncertainty, tracked in the same frames.
//
// Unknowns: the site's geodetic latitude, longitude and height, the bias of
// the frame time tags (true mid-exposure = tag + bias), and the calibrator's
// own position error in its RTN axes (radial, transverse, normal), held by
// its prior covariance (the GP error model's), so the site and timing
// uncertainty carries the calibrator's ephemeris error instead of hiding it.
// Measurements: the calibrator's observed directions (plate solutions at its
// centroid), two tangent-plane components per frame with their covariance.
// Weighted Gauss-Newton with priors (Tapley, Schutz & Born 2004, Statistical
// Orbit Determination, ch. 4: the batch processor with a priori information).
namespace oa {

struct DirectionObs {
  double t = 0;            // tag, UTC Unix s
  V3 u;                    // observed direction (GCRS, with the site's aberration)
  double c[2][2] = {{0}};  // covariance in the tangent plane at u (east, north), rad^2
  int frame = -1;
};

struct CalibrationPrior {
  double h0 = 1000, sigma_h = 1500;        // m
  double sigma_dt = 1.0;                   // s
  double sigma_rtn[3] = {0.2, 1.0, 0.2};   // km, the calibrator's ephemeris error
  double rtn_corr_rt = 0.0;                // radial-transverse correlation
};

struct CalibrationResult {
  bool ok = false;
  std::string error;
  Site site;
  double dt = 0;                 // s
  double rtn[3] = {0, 0, 0};     // km
  std::vector<double> cov;       // 7x7: lat (rad), lon (rad), h (m), dt (s), R, T, N (km)
  double chi2 = 0;
  int dof = 0;
  double rms_arcsec = 0;
  std::vector<std::array<double, 2>> residual_arcsec;  // per observation (east, north), observed - computed
  std::vector<double> chi;       // per observation normalized distance
  int iterations = 0;
  // Derived 1-sigma: north/east/up of the site (m), time (s).
  double sigma_north_m = 0, sigma_east_m = 0, sigma_up_m = 0, sigma_dt = 0;
};

struct CalibContext {
  const Trajectory* tr = nullptr;
  std::vector<ax::Mat3> t2c;   // ITRS -> GCRS at each observation's tag
};

inline V3 rotz(V3 v, double a) {
  const double c = std::cos(a), s = std::sin(a);
  return V3{c * v.x - s * v.y, s * v.x + c * v.y, v.z};
}

// Predicted observed direction for parameters p at observation k.
inline bool predict_direction(const CalibContext& ctx, const DirectionObs& o, size_t k, const double p[7], V3* out) {
  Site s;
  s.lat = p[0]; s.lon = p[1]; s.h = p[2];
  const double dt = p[3];
  const double omega = 7.292115146706979e-5;
  const V3 si = site_itrs_km(s);
  const V3 sg = rotz(rotate(ctx.t2c[k], si), omega * dt);           // km
  const V3 sv = cross(V3{0, 0, omega}, sg);                          // km/s
  const double t = o.t + dt;
  double tau = 0;
  V3 r, v;
  for (int it = 0; it < 4; ++it) {
    if (!ctx.tr->at(t - tau, &r, &v)) return false;
    // RTN offset of the calibrator.
    const V3 R = unit(r), N = unit(cross(r, v)), T = cross(N, R);
    r = r + R * p[4] + T * p[5] + N * p[6];
    tau = norm(r - sg) * 1000.0 / kSpeedOfLight;
  }
  const V3 u = unit(r - sg);
  const V3 beta = sv * (1000.0 / kSpeedOfLight);
  *out = unit(u + beta - u * dot(u, beta));
  return true;
}

inline CalibrationResult calibrate_site(const Trajectory& tr, const Clock& clock, const std::vector<DirectionObs>& obs, const Site& start,
                                        const CalibrationPrior& prior, bool solve_site) {
  CalibrationResult res;
  if (obs.size() < 3) { res.error = "fewer than three calibrator directions"; return res; }
  CalibContext ctx;
  ctx.tr = &tr;
  for (const DirectionObs& o : obs) {
    ax::Epoch e;
    ax::EarthOrientation eo;
    if (!clock.at(o.t, &e, &eo, &res.error)) return res;
    ctx.t2c.push_back(ax::transpose(ax::gcrfToItrf(e, eo)));
  }
  double p[7] = {start.lat, start.lon, start.h, 0, 0, 0, 0};
  const int np = 7;
  // Prior information matrix and centre.
  std::vector<double> P0inv(np * np, 0.0);
  double p0[7] = {start.lat, start.lon, prior.h0, 0, 0, 0, 0};
  if (!solve_site) {
    // A known site: lat, lon, h held by tight priors (the given site).
    p0[2] = start.h;
    P0inv[0] = 1.0 / std::pow(1e-7, 2);
    P0inv[1 * np + 1] = 1.0 / std::pow(1e-7, 2);
    P0inv[2 * np + 2] = 1.0 / std::pow(1.0, 2);
  } else {
    P0inv[2 * np + 2] = 1.0 / (prior.sigma_h * prior.sigma_h);
  }
  P0inv[3 * np + 3] = 1.0 / (prior.sigma_dt * prior.sigma_dt);
  {
    // RTN block with the R-T correlation.
    const double sr = prior.sigma_rtn[0], st = prior.sigma_rtn[1], sn = prior.sigma_rtn[2], rho = prior.rtn_corr_rt;
    const double c00 = sr * sr, c11 = st * st, c01 = rho * sr * st;
    const double det = c00 * c11 - c01 * c01;
    P0inv[4 * np + 4] = c11 / det;
    P0inv[5 * np + 5] = c00 / det;
    P0inv[4 * np + 5] = P0inv[5 * np + 4] = -c01 / det;
    P0inv[6 * np + 6] = 1.0 / (sn * sn);
  }
  std::vector<double> cov;
  const double steps[7] = {1e-7, 1e-7, 1.0, 1e-3, 1e-3, 1e-3, 1e-3};
  for (int it = 0; it < 15; ++it) {
    std::vector<double> N(P0inv), b(np, 0.0);
    // Prior pull.
    for (int a = 0; a < np; ++a)
      for (int c = 0; c < np; ++c) b[a] += P0inv[a * np + c] * (p0[c] - p[c]);
    double chi2 = 0;
    res.residual_arcsec.assign(obs.size(), {0, 0});
    res.chi.assign(obs.size(), 0);
    for (size_t k = 0; k < obs.size(); ++k) {
      const DirectionObs& o = obs[k];
      V3 e, n;
      tangent_basis(o.u, &e, &n);
      V3 u0;
      if (!predict_direction(ctx, o, k, p, &u0)) { res.error = "the calibrator trajectory does not cover the frames"; return res; }
      const double r[2] = {dot(o.u - u0, e), dot(o.u - u0, n)};
      double H[2][7];
      for (int j = 0; j < np; ++j) {
        double q[7];
        std::copy(p, p + 7, q);
        q[j] += steps[j];
        V3 u1;
        if (!predict_direction(ctx, o, k, q, &u1)) { res.error = "the calibrator trajectory does not cover the frames"; return res; }
        H[0][j] = dot(u1 - u0, e) / steps[j];
        H[1][j] = dot(u1 - u0, n) / steps[j];
      }
      const double det = o.c[0][0] * o.c[1][1] - o.c[0][1] * o.c[1][0];
      const double W[2][2] = {{o.c[1][1] / det, -o.c[0][1] / det}, {-o.c[1][0] / det, o.c[0][0] / det}};
      for (int a = 0; a < np; ++a)
        for (int x = 0; x < 2; ++x)
          for (int y = 0; y < 2; ++y) {
            b[a] += H[x][a] * W[x][y] * r[y];
            for (int c = 0; c < np; ++c) N[a * np + c] += H[x][a] * W[x][y] * H[y][c];
          }
      const double q = r[0] * (W[0][0] * r[0] + W[0][1] * r[1]) + r[1] * (W[1][0] * r[0] + W[1][1] * r[1]);
      chi2 += q;
      res.residual_arcsec[k] = {r[0] / kArcsec, r[1] / kArcsec};
      res.chi[k] = std::sqrt(q);
    }
    std::vector<double> dx(b);
    if (!cholesky_solve(N, np, &dx, &cov)) { res.error = "the calibration normal matrix is singular"; return res; }
    for (int a = 0; a < np; ++a) p[a] += dx[a];
    res.chi2 = chi2;
    res.iterations = it + 1;
    if (std::fabs(dx[0]) + std::fabs(dx[1]) < 1e-10 && std::fabs(dx[2]) < 0.01 && std::fabs(dx[3]) < 1e-6) break;
  }
  // Final residuals at the solution.
  double ss = 0, chi2 = 0;
  for (size_t k = 0; k < obs.size(); ++k) {
    const DirectionObs& o = obs[k];
    V3 e, n, u0;
    tangent_basis(o.u, &e, &n);
    predict_direction(ctx, o, k, p, &u0);
    const double r[2] = {dot(o.u - u0, e), dot(o.u - u0, n)};
    const double det = o.c[0][0] * o.c[1][1] - o.c[0][1] * o.c[1][0];
    const double q = (o.c[1][1] * r[0] * r[0] - 2 * o.c[0][1] * r[0] * r[1] + o.c[0][0] * r[1] * r[1]) / det;
    chi2 += q;
    res.residual_arcsec[k] = {r[0] / kArcsec, r[1] / kArcsec};
    res.chi[k] = std::sqrt(q);
    ss += (r[0] * r[0] + r[1] * r[1]) / (kArcsec * kArcsec);
  }
  res.chi2 = chi2;
  res.dof = static_cast<int>(2 * obs.size()) - (solve_site ? 4 : 1);
  res.rms_arcsec = std::sqrt(ss / obs.size());
  res.site.lat = p[0];
  res.site.lon = p[1];
  res.site.h = p[2];
  res.dt = p[3];
  res.rtn[0] = p[4]; res.rtn[1] = p[5]; res.rtn[2] = p[6];
  res.cov = cov;
  const double R = 6378137.0;
  res.sigma_north_m = std::sqrt(cov[0]) * R;
  res.sigma_east_m = std::sqrt(cov[1 * np + 1]) * R * std::cos(p[0]);
  res.sigma_up_m = std::sqrt(cov[2 * np + 2]);
  res.sigma_dt = std::sqrt(cov[3 * np + 3]);
  res.ok = true;
  return res;
}

}  // namespace oa
