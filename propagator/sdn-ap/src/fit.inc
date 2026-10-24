// -----------------------------------------------------------------------------
// fit: an ephemeris (TEME states at minutes from a reference epoch) to an
// element set of the SGP4XP or SDN-AP theory by Levenberg-Marquardt.
//
// The residuals are the theory's own (each iteration ingests the trial set and
// propagates it to every sample); the Jacobian is analytic: the exact
// derivatives, by forward-mode differentiation, of the two-body motion with
// the J2 secular drift of the node, the perigee and the mean longitude, in the
// equinoctial elements of SPEC 1.5, plus the drag (or B_eff) column through the
// mean-motion rate per unit B. Priors (DESIGN 2e.3) enter as extra rows.
// -----------------------------------------------------------------------------

namespace sdnap {
namespace fit {

/// Forward-mode dual number with up to 8 partials.
constexpr int kMaxParams = 11;
struct Dual {
  double v;
  double d[kMaxParams];
};
inline Dual dconst(double v) { Dual r{}; r.v = v; return r; }
inline Dual dvar(double v, int k) { Dual r{}; r.v = v; r.d[k] = 1.0; return r; }
inline Dual operator+(Dual a, Dual b) { Dual r{}; r.v = a.v + b.v; for (int k = 0; k < kMaxParams; ++k) r.d[k] = a.d[k] + b.d[k]; return r; }
inline Dual operator-(Dual a, Dual b) { Dual r{}; r.v = a.v - b.v; for (int k = 0; k < kMaxParams; ++k) r.d[k] = a.d[k] - b.d[k]; return r; }
inline Dual operator*(Dual a, Dual b) { Dual r{}; r.v = a.v * b.v; for (int k = 0; k < kMaxParams; ++k) r.d[k] = a.d[k] * b.v + a.v * b.d[k]; return r; }
inline Dual operator*(double s, Dual a) { Dual r{}; r.v = s * a.v; for (int k = 0; k < kMaxParams; ++k) r.d[k] = s * a.d[k]; return r; }
inline Dual operator/(Dual a, Dual b) {
  Dual r{};
  r.v = a.v / b.v;
  for (int k = 0; k < kMaxParams; ++k) r.d[k] = (a.d[k] * b.v - a.v * b.d[k]) / (b.v * b.v);
  return r;
}
inline Dual dsqrt(Dual a) { Dual r{}; r.v = std::sqrt(a.v); for (int k = 0; k < kMaxParams; ++k) r.d[k] = a.d[k] / (2.0 * r.v); return r; }
inline Dual dsin(Dual a) { Dual r{}; r.v = std::sin(a.v); const double c = std::cos(a.v); for (int k = 0; k < kMaxParams; ++k) r.d[k] = c * a.d[k]; return r; }
inline Dual dcos(Dual a) { Dual r{}; r.v = std::cos(a.v); const double s = -std::sin(a.v); for (int k = 0; k < kMaxParams; ++k) r.d[k] = s * a.d[k]; return r; }
inline Dual dpow(Dual a, double p) { Dual r{}; r.v = std::pow(a.v, p); const double dv = p * std::pow(a.v, p - 1.0); for (int k = 0; k < kMaxParams; ++k) r.d[k] = dv * a.d[k]; return r; }

/// Two-body position (ER) of mean equinoctial elements y (af, ag, chi, psi,
/// lambda0, n) at t minutes with the J2 secular rates and a mean-motion rate
/// ndot (rad/min^2): the model whose derivatives form the Jacobian.
inline void model_position(const Dual* y, double t, Dual ndot, Dual out[3]) {
  using namespace xpt;
  const Dual af = y[0], ag = y[1], chi = y[2], psi = y[3], lam0 = y[4], n = y[5];
  const Dual a = dpow(dconst(kKe) / n, kX2o3);
  const Dual e2 = af * af + ag * ag;
  const Dual eta = dsqrt(dconst(1.0) - e2);
  const Dual t2 = chi * chi + psi * psi;
  const Dual ci = (dconst(1.0) - t2) / (dconst(1.0) + t2);
  const Dual p = a * eta * eta;
  const Dual k2n = (0.75 * kJ2) * n / (p * p);
  // J2 secular: node, perigee and mean-longitude drifts
  const Dual nodedot = dconst(-2.0) * k2n * ci;
  const Dual argpdot = k2n * (dconst(5.0) * ci * ci - dconst(1.0));
  const Dual mdot = n + k2n * eta * (dconst(3.0) * ci * ci - dconst(1.0));
  const Dual tt = dconst(t);
  const Dual dO = nodedot * tt, dvarpi = (argpdot + nodedot) * tt;
  // rotate the e-vector by dvarpi and the inclination vector by dO
  const Dual cv = dcos(dvarpi), sv = dsin(dvarpi), cO = dcos(dO), sO = dsin(dO);
  const Dual k = af * cv - ag * sv, h = af * sv + ag * cv;
  const Dual q = psi * cO - chi * sO, pp = psi * sO + chi * cO;  // psi = q, chi = p
  const Dual lam = lam0 + (mdot + argpdot + nodedot) * tt + 0.5 * ndot * tt * tt;
  // eccentric longitude
  double Fv = lam.v;
  for (int it = 0; it < 30; ++it) {
    const double f = Fv + h.v * std::cos(Fv) - k.v * std::sin(Fv) - lam.v;
    const double fp = 1.0 - h.v * std::sin(Fv) - k.v * std::cos(Fv);
    const double dF = f / fp;
    Fv -= dF;
    if (std::fabs(dF) < 1e-15) break;
  }
  // implicit derivative: dF = (dlam - cos F dh + sin F dk) / (1 - h sin F - k cos F)
  const double cF = std::cos(Fv), sF = std::sin(Fv);
  const double den = 1.0 - h.v * sF - k.v * cF;
  Dual F{};
  F.v = Fv;
  for (int j = 0; j < kMaxParams; ++j) F.d[j] = (lam.d[j] - cF * h.d[j] + sF * k.d[j]) / den;
  const Dual cFd = dcos(F), sFd = dsin(F);
  const Dual beta = dconst(1.0) / (dconst(1.0) + eta);
  const Dual X = a * ((dconst(1.0) - h * h * beta) * cFd + h * k * beta * sFd - k);
  const Dual Y = a * ((dconst(1.0) - k * k * beta) * sFd + h * k * beta * cFd - h);
  const Dual C = dconst(1.0) + pp * pp + q * q;
  const Dual fx = (dconst(1.0) - pp * pp + q * q) / C, fy = dconst(2.0) * pp * q / C, fz = dconst(-2.0) * pp / C;
  const Dual gx = dconst(2.0) * pp * q / C, gy = (dconst(1.0) + pp * pp - q * q) / C, gz = dconst(2.0) * q / C;
  out[0] = X * fx + Y * gx;
  out[1] = X * fy + Y * gy;
  out[2] = X * fz + Y * gz;
}

/// Fit options (48 bytes, sdnap_fit).
struct Options {
  int32_t fit_drag;        ///< fit B (SGP4XP BTERM) or B_eff (SDN-AP, signed)
  int32_t max_iterations;  ///< 0: 30
  double drag_prior;       ///< prior mean of the drag term (DESIGN 2e.3)
  double drag_sigma;       ///< its sigma; <= 0: no prior
  int32_t fit_agom;        ///< fit AGOM (its column by a finite difference of the theory)
  int32_t fit_tau;         ///< SDN-AP 2c: bit 0 tau0, bit 1 tauc and taus (columns by finite differences)
  double agom_prior;       ///< prior mean of AGOM
  double agom_sigma;       ///< its sigma; <= 0: no prior
};
static_assert(sizeof(Options) == 48, "fit Options are 48 bytes");

struct Result {
  int32_t status;       ///< 0 converged, 1 stopped at the iteration limit, < 0 refused
  int32_t iterations;
  double rms_km;        ///< position rms over the samples
  double max_km;
};

/// Residuals of the trial row: model minus observed, km, 3 per sample.
inline bool residuals(const ElementRow& row, const double* t, const double* r, int count, double* res) {
  Elements e = elements_of(row);
  xpt::XpSat* s = static_cast<xpt::XpSat*>(std::malloc(sizeof(xpt::XpSat)));
  if (s == nullptr) return false;
  bool ok = xpt::xp_init(e, *s) == kPropOk;
  for (int k = 0; ok && k < count; ++k) {
    double rm[3], vm[3];
    if (xpt::xp_propagate(*s, t[k], rm, vm) != kPropOk) { ok = false; break; }
    for (int j = 0; j < 3; ++j) res[3 * k + j] = rm[j] - r[3 * k + j];
  }
  xpt::xp_release(*s);
  std::free(s);
  return ok;
}

/// Solve the symmetric positive system A x = b (n <= kMaxParams) by Cholesky.
inline bool solve(double* A, double* b, int n) {
  for (int j = 0; j < n; ++j) {
    double d = A[j * n + j];
    for (int k = 0; k < j; ++k) d -= A[j * n + k] * A[j * n + k];
    if (!(d > 0.0)) return false;
    d = std::sqrt(d);
    A[j * n + j] = d;
    for (int i = j + 1; i < n; ++i) {
      double s = A[i * n + j];
      for (int k = 0; k < j; ++k) s -= A[i * n + k] * A[j * n + k];
      A[i * n + j] = s / d;
    }
  }
  for (int i = 0; i < n; ++i) {
    double s = b[i];
    for (int k = 0; k < i; ++k) s -= A[i * n + k] * b[k];
    b[i] = s / A[i * n + i];
  }
  for (int i = n - 1; i >= 0; --i) {
    double s = b[i];
    for (int k = i + 1; k < n; ++k) s -= A[k * n + i] * b[k];
    b[i] = s / A[i * n + i];
  }
  return true;
}

/// The parameter vector of a row: af, ag, chi, psi, lambda0, n, [drag], [agom].
inline int params_of(const ElementRow& row, const Options& o, double* x) {
  const double n = row.mean_motion_rev_day * kTwoPi / kMinutesPerDay;
  double y[6];
  xpt::equinoctial_of(n, row.eccentricity, row.inclination_deg * kDeg, row.raan_deg * kDeg,
                      row.arg_pericenter_deg * kDeg, row.mean_anomaly_deg * kDeg, y);
  x[0] = y[xpt::kAf]; x[1] = y[xpt::kAg]; x[2] = y[xpt::kChi]; x[3] = y[xpt::kPsi]; x[4] = y[xpt::kLam]; x[5] = y[xpt::kN];
  int np = 6;
  if (o.fit_drag) x[np++] = row.bterm;
  if (o.fit_agom) x[np++] = row.agom;
  if (o.fit_tau & 1) x[np++] = row.tau0;
  if (o.fit_tau & 2) {
    x[np++] = row.tauc;
    x[np++] = row.taus;
  }
  return np;
}

inline void row_of(const double* x, const Options& o, ElementRow& row) {
  double y[6] = {x[0], x[1], x[2], x[3], x[4], x[5]};
  const xpt::Kepler k = xpt::kepler_of(y);
  row.mean_motion_rev_day = x[5] * kMinutesPerDay / kTwoPi;
  row.eccentricity = k.e;
  row.inclination_deg = k.i / kDeg;
  row.raan_deg = k.node / kDeg;
  row.arg_pericenter_deg = k.argp / kDeg;
  row.mean_anomaly_deg = k.m / kDeg;
  int np = 6;
  if (o.fit_drag) row.bterm = x[np++];
  if (o.fit_agom) row.agom = x[np++];
  if (o.fit_tau & 1) row.tau0 = x[np++];
  if (o.fit_tau & 2) {
    row.tauc = x[np++];
    row.taus = x[np++];
  }
}

/// Levenberg-Marquardt. `row` holds the starting set (epoch, theory and the
/// fixed terms) and receives the fitted one. `variances`, when given, receives
/// the parameters' variances (diagonal of the inverse normal matrix of the last
/// step, scaled by the residual variance), in params_of order.
inline Result run(ElementRow& row, const double* t, const double* r, int count, const Options& o,
                  double* variances = nullptr) {
  Result out{};
  const int nres = 3 * count;
  const int max_it = o.max_iterations > 0 ? o.max_iterations : 30;
  double x[kMaxParams];
  const int np = params_of(row, o, x);
  double* res = static_cast<double*>(std::malloc(sizeof(double) * nres));
  double* trial = static_cast<double*>(std::malloc(sizeof(double) * nres));
  double* jac = static_cast<double*>(std::malloc(sizeof(double) * nres * kMaxParams));
  auto release = [&]() { std::free(res); std::free(trial); std::free(jac); };
  if (res == nullptr || trial == nullptr || jac == nullptr) {
    release();
    out.status = -1;
    return out;
  }
  const bool prior = o.fit_drag && o.drag_sigma > 0.0;
  const int agom_index = o.fit_drag ? 7 : 6;
  const bool agom_prior = o.fit_agom && o.agom_sigma > 0.0;
  auto cost_of = [&](const double* rr, const double* xx) {
    double c = 0.0;
    for (int i = 0; i < nres; ++i) c += rr[i] * rr[i];
    if (prior) {
      const double d = (xx[6] - o.drag_prior) / o.drag_sigma;
      c += d * d;
    }
    if (agom_prior) {
      const double d = (xx[agom_index] - o.agom_prior) / o.agom_sigma;
      c += d * d;
    }
    return c;
  };
  ElementRow work = row;
  row_of(x, o, work);
  if (!residuals(work, t, r, count, res)) {
    release();
    out.status = -2;
    return out;
  }
  double cost = cost_of(res, x);
  double mu = 1e-3;
  bool converged = false;
  int it = 0;
  for (; it < max_it && !converged; ++it) {
    // n-dot per unit drag term from the theory's own rate function at epoch
    double ndot_per_drag = 0.0;
    if (o.fit_drag) {
      ElementRow probe = work;
      if (probe.bterm == 0.0) probe.bterm = 1e-3;
      Elements e = elements_of(probe);
      xpt::XpSat* s = static_cast<xpt::XpSat*>(std::malloc(sizeof(xpt::XpSat)));
      if (s != nullptr && xpt::xp_init(e, *s) == kPropOk) {
        ElementRow none = probe;
        none.bterm = 0.0;
        Elements e0 = elements_of(none);
        xpt::XpSat* s0 = static_cast<xpt::XpSat*>(std::malloc(sizeof(xpt::XpSat)));
        if (s0 != nullptr && xpt::xp_init(e0, *s0) == kPropOk)
          ndot_per_drag = (s->epoch.f[xpt::kN] - s0->epoch.f[xpt::kN]) / probe.bterm;
        if (s0 != nullptr) xpt::xp_release(*s0);
        std::free(s0);
      }
      if (s != nullptr) xpt::xp_release(*s);
      std::free(s);
    }
    for (int k = 0; k < count; ++k) {
      Dual y[6];
      for (int j = 0; j < 6; ++j) y[j] = dvar(x[j], j);
      Dual ndot = dconst(0.0);
      if (o.fit_drag) {
        ndot.v = x[6] * ndot_per_drag;
        ndot.d[6] = ndot_per_drag;
      }
      Dual pos[3];
      model_position(y, t[k], ndot, pos);
      const int analytic = o.fit_drag ? 7 : 6;
      for (int c = 0; c < 3; ++c)
        for (int j = 0; j < analytic; ++j) jac[(3 * k + c) * kMaxParams + j] = pos[c].d[j] * xpt::kRe;
    }
    if (o.fit_agom) {
      ElementRow bumped = work;
      const double step = std::fabs(work.agom) * 0.01 > 1e-4 ? std::fabs(work.agom) * 0.01 : 1e-4;
      bumped.agom = work.agom + step;
      if (residuals(bumped, t, r, count, trial))
        for (int i = 0; i < nres; ++i) jac[i * kMaxParams + agom_index] = (trial[i] - res[i]) / step;
    }
    // SDN-AP 2c tau columns: one-sided differences of the theory (m/s^2)
    {
      int col = 6 + (o.fit_drag ? 1 : 0) + (o.fit_agom ? 1 : 0);
      double ElementRow::*taus[3] = {&ElementRow::tau0, &ElementRow::tauc, &ElementRow::taus};
      for (int q = 0; q < 3; ++q) {
        if (q == 0 ? !(o.fit_tau & 1) : !(o.fit_tau & 2)) continue;
        ElementRow bumped = work;
        const double v = work.*taus[q];
        const double step = std::fabs(v) * 0.01 > 1e-9 ? std::fabs(v) * 0.01 : 1e-9;
        bumped.*taus[q] = v + step;
        if (residuals(bumped, t, r, count, trial))
          for (int i = 0; i < nres; ++i) jac[i * kMaxParams + col] = (trial[i] - res[i]) / step;
        ++col;
      }
    }
    double A[kMaxParams * kMaxParams] = {}, g[kMaxParams] = {};
    for (int i = 0; i < nres; ++i)
      for (int a = 0; a < np; ++a) {
        g[a] -= jac[i * kMaxParams + a] * res[i];
        for (int b = 0; b <= a; ++b) A[a * np + b] += jac[i * kMaxParams + a] * jac[i * kMaxParams + b];
      }
    if (prior) {
      A[6 * np + 6] += 1.0 / (o.drag_sigma * o.drag_sigma);
      g[6] -= (x[6] - o.drag_prior) / (o.drag_sigma * o.drag_sigma);
    }
    if (agom_prior) {
      A[agom_index * np + agom_index] += 1.0 / (o.agom_sigma * o.agom_sigma);
      g[agom_index] -= (x[agom_index] - o.agom_prior) / (o.agom_sigma * o.agom_sigma);
    }
    for (int a = 0; a < np; ++a)
      for (int b = 0; b < a; ++b) A[b * np + a] = A[a * np + b];
    if (variances != nullptr) {
      // diag(A^-1), A at this iteration's point, scaled below by the residual variance
      for (int q = 0; q < np; ++q) {
        double M[kMaxParams * kMaxParams], e[kMaxParams] = {};
        for (int a = 0; a < np * np; ++a) M[a] = A[a];
        e[q] = 1.0;
        variances[q] = solve(M, e, np) ? e[q] : 0.0;
      }
    }
    bool improved = false;
    for (int tries = 0; tries < 12 && !improved; ++tries) {
      double M[kMaxParams * kMaxParams], dx[kMaxParams];
      for (int a = 0; a < np * np; ++a) M[a] = A[a];
      for (int a = 0; a < np; ++a) {
        M[a * np + a] *= (1.0 + mu);
        dx[a] = g[a];
      }
      if (solve(M, dx, np)) {
        double xt[kMaxParams];
        for (int a = 0; a < np; ++a) xt[a] = x[a] + dx[a];
        ElementRow cand = work;
        row_of(xt, o, cand);
        if (residuals(cand, t, r, count, trial)) {
          const double c = cost_of(trial, xt);
          if (c < cost) {
            const double rel = (cost - c) / cost;
            for (int a = 0; a < np; ++a) x[a] = xt[a];
            for (int i = 0; i < nres; ++i) res[i] = trial[i];
            work = cand;
            cost = c;
            mu = mu * 0.3 > 1e-12 ? mu * 0.3 : 1e-12;
            improved = true;
            if (rel < 1e-10) converged = true;
            continue;
          }
        }
      }
      mu *= 10.0;
    }
    if (!improved) converged = true;  // no step lowers the cost: at the minimum
  }
  double ss = 0.0, mx = 0.0;
  for (int k = 0; k < count; ++k) {
    const double d = std::sqrt(res[3 * k] * res[3 * k] + res[3 * k + 1] * res[3 * k + 1] + res[3 * k + 2] * res[3 * k + 2]);
    ss += d * d;
    if (d > mx) mx = d;
  }
  row = work;
  if (variances != nullptr) {
    const double s2 = nres > np ? (ss / (nres - np)) : 0.0;  // km^2 per residual component
    for (int q = 0; q < np; ++q) variances[q] *= s2;
  }
  out.rms_km = std::sqrt(ss / (count > 0 ? count : 1));
  out.max_km = mx;
  out.iterations = it;
  out.status = converged ? 0 : 1;
  release();
  return out;
}

/// The two-line text's digits: mean motion 1e-8 rev/day, eccentricity 1e-7,
/// angles 1e-4 deg, BTERM and AGOM five significant digits (+-0.NNNNN+-E).
inline double round_to(double v, double unit) { return std::round(v / unit) * unit; }
inline double exp_unit(double v) {
  if (v == 0.0) return 1e-10;
  const int e = static_cast<int>(std::floor(std::log10(std::fabs(v)))) + 1;
  return std::pow(10.0, e - 5);
}

/// Rounds the fitted set to the two-line text and searches the lattice of the
/// text's digits (coordinate steps of one unit in the last digit) for the
/// representable set of least cost: the set the Space Force library reads.
inline Result tle_lattice(ElementRow& row, const double* t, const double* r, int count, const Options& o) {
  Result out{};
  const int nres = 3 * count;
  std::vector<double> res(nres);
  auto cost = [&](const ElementRow& w) {
    if (!residuals(w, t, r, count, res.data())) return 1e300;
    double c = 0.0;
    for (int i = 0; i < nres; ++i) c += res[i] * res[i];
    return c;
  };
  ElementRow best = row;
  best.mean_motion_rev_day = round_to(row.mean_motion_rev_day, 1e-8);
  best.eccentricity = round_to(row.eccentricity, 1e-7);
  best.inclination_deg = round_to(row.inclination_deg, 1e-4);
  best.raan_deg = round_to(row.raan_deg, 1e-4);
  best.arg_pericenter_deg = round_to(row.arg_pericenter_deg, 1e-4);
  best.mean_anomaly_deg = round_to(row.mean_anomaly_deg, 1e-4);
  best.bterm = round_to(row.bterm, exp_unit(row.bterm));
  best.agom = round_to(row.agom, exp_unit(row.agom));
  double c = cost(best);
  for (int pass = 0; pass < 4; ++pass) {
    bool moved = false;
    for (int k = 0; k < 8; ++k) {
      if (k == 6 && !o.fit_drag) continue;
      if (k == 7 && !o.fit_agom) continue;
      for (int dir = -1; dir <= 1; dir += 2) {
        ElementRow cand = best;
        switch (k) {
          case 0: cand.mean_motion_rev_day += dir * 1e-8; break;
          case 1: cand.eccentricity += dir * 1e-7; break;
          case 2: cand.inclination_deg += dir * 1e-4; break;
          case 3: cand.raan_deg += dir * 1e-4; break;
          case 4: cand.arg_pericenter_deg += dir * 1e-4; break;
          case 5: cand.mean_anomaly_deg += dir * 1e-4; break;
          case 6: cand.bterm += dir * exp_unit(best.bterm); break;
          default: cand.agom += dir * exp_unit(best.agom); break;
        }
        if (cand.eccentricity < 0.0) continue;
        const double cc = cost(cand);
        if (cc < c) { c = cc; best = cand; moved = true; }
      }
    }
    if (!moved) break;
  }
  cost(best);
  double ss = 0.0, mx = 0.0;
  for (int kk = 0; kk < count; ++kk) {
    const double d = std::sqrt(res[3 * kk] * res[3 * kk] + res[3 * kk + 1] * res[3 * kk + 1] + res[3 * kk + 2] * res[3 * kk + 2]);
    ss += d * d;
    if (d > mx) mx = d;
  }
  row = best;
  out.rms_km = std::sqrt(ss / (count > 0 ? count : 1));
  out.max_km = mx;
  return out;
}

}  // namespace fit
}  // namespace sdnap
