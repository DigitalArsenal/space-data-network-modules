// analysis/maneuver-detection: the impulse of a detected event and its
// uncertainty, from a GP error model.
//
// The model is analysis/gp-error-model's ElementSetModel ($ERM MODEL on
// `error_model`): per regime and age bin, the 6x6 RTN covariance of SGP4
// prediction error, linear in age between the centers of bins with at least
// MINIMUM_BIN_SAMPLES samples and held beyond them, times the cell's factor
// when it has one. A set's regime is its mean altitude from SGP4's un-Kozai'd
// mean motion (WGS-72) and its eccentricity. The rule is gp-error-model's
// (attach_covariance), so an element set gets the covariance it gets there.
//
// An event between the last set before it (A, epoch tA) and the first after it
// (B, epoch tB) is one impulse at an unknown time tb in [tA, tB]. At tb the two
// trajectories differ by the impulse alone:
//   x_B(tb) - x_A(tb) = [0; dv] + e,  e ~ N(0, R),  R = P(tb - tA) + D P(tB - tb) D,
// in the RTN axes of A at tb. B is predicted backwards, which reverses time:
// its velocity and its T and N axes change sign, D = diag(1, -1, -1, -1, 1, 1).
// Given tb, dv is Gaussian with
//   mean  dvel - R_vr R_rr^-1 dpos,  covariance  R_vv - R_vr R_rr^-1 R_rv,
// and the position mismatch is the evidence for tb (a uniform prior over the
// bracket): p(tb) ~ |R_rr|^-1/2 exp(-dpos' R_rr^-1 dpos / 2). The estimate is
// the mixture over tb: the mean of dv(tb) and the covariance
// sum w (S + (dv - mean)(dv - mean)'), each dv(tb) in the RTN axes at its own
// tb, and the magnitude's mean and spread over the same mixture (a plane change
// can be made at either node: its sign in W is ambiguous, its size is not).
// The event time is the posterior mode; the burn window holds the central
// 99.73 % of the posterior. When no burn time fits one impulse (the position
// mismatch's chi-square at the mode above 14.16, the 99.73 % point of three
// degrees of freedom: the trajectories do not meet, as after several burns, a
// long burn, or a set fitted across the burn), R is scaled by chi-square / 3
// and the posterior taken again, so the uncertainty says how far the single
// impulse is from the data.
//
// The minimum two-impulse bound: dv1 at t1 and dv2 at t2 > t1, both in the
// bracket, that take trajectory A onto trajectory B under two-body and J2
// relative dynamics about A (ranked over every pair of times with the
// linearized transfer, x_B(t2) - x_A(t2) = Phi(t2, t1) [0; dv1] + [0; dv2],
// then solved without linearizing): the least |dv1| + |dv2| over the
// bracket, and its 1-sigma from R at t2 (linearized at the optimum). It is the bound of the estimated trajectories:
// with their errors it can exceed the true impulse.
namespace {

constexpr double kJ2 = 1.0826266835531513e-3;                // EGM-96 / WGS 84 (the bound's transition matrix)
constexpr double kWindowTail = 0.00135;                       // each side of the central 99.73 %
constexpr double kRejectChi2 = 14.1563;                       // chi-square, 3 degrees of freedom, 99.73 %

using Mat3 = std::array<double, 9>;
using Mat6 = std::array<double, 36>;

// ── the error model ────────────────────────────────────────────────────────
struct ErrorModel {
  struct Regime { std::string id; double altLo, altHi, eccLo, eccHi; };
  bool loaded = false;
  std::string id, version;
  std::vector<Regime> regimes;
  std::vector<std::pair<double, double>> ages;                 // days
  std::map<std::pair<int, int>, std::array<double, 21>> cov;   // RTN lower triangle, km, km/s
  std::map<std::pair<int, int>, uint64_t> samples;
  std::map<std::pair<int, int>, double> factor;
  std::map<std::pair<int, int>, std::string> decision;
  uint64_t minimumBinSamples = 0;
};

bool loadErrorModel(const std::vector<const ERM*>& roots, ErrorModel& m) {
  NEED(roots.size() == 1, "error_model takes one $ERM record (the MODEL arm).");
  const ERMModel* model = roots[0]->MODEL();
  NEED(model && model->FORM() == ermModelForm::ElementSetModel,
       "error_model must be an $ERM MODEL of form ElementSetModel (analysis/gp-error-model's element-set covariance model).");
  NEED(model->STRATA_SETTINGS() && model->STRATA_SETTINGS()->REGIMES() && model->STRATA_SETTINGS()->AGE_BINS() && model->STRATA(),
       "The error model needs STRATA_SETTINGS (REGIMES, AGE_BINS) and STRATA.");
  for (const auto* r : *model->STRATA_SETTINGS()->REGIMES())
    m.regimes.push_back({r->ID() ? r->ID()->str() : "", r->ALTITUDE_MIN_KM(), r->ALTITUDE_MAX_KM(), r->ECCENTRICITY_MIN(), r->ECCENTRICITY_MAX()});
  for (const auto* a : *model->STRATA_SETTINGS()->AGE_BINS()) {
    NEED(a->MAX_DAYS() > a->MIN_DAYS() && (m.ages.empty() || a->MIN_DAYS() >= m.ages.back().second),
         "The error model's age bins must be increasing and disjoint.");
    m.ages.push_back({a->MIN_DAYS(), a->MAX_DAYS()});
  }
  for (const auto* s : *model->STRATA()) {
    NEED(s->COVARIANCE() && s->COVARIANCE()->size() == 21, "Each error-model stratum needs 21 covariance values (RTN, km, km/s).");
    NEED(s->REGIME_INDEX() < m.regimes.size() && s->AGE_INDEX() < m.ages.size(), "An error-model stratum names a regime or age bin the model lacks.");
    const std::pair<int, int> key{int(s->REGIME_INDEX()), int(s->AGE_INDEX())};
    std::array<double, 21> c{};
    for (int k = 0; k < 21; ++k) c[k] = s->COVARIANCE()->Get(k);
    m.cov[key] = c;
    m.samples[key] = s->N();
  }
  if (model->STRATUM_FACTORS())
    for (const auto* f : *model->STRATUM_FACTORS())
      if (std::isfinite(f->FACTOR()) && f->FACTOR() > 0) m.factor[{int(f->REGIME_INDEX()), int(f->AGE_INDEX())}] = f->FACTOR();
  if (model->CELLS())
    for (const auto* c : *model->CELLS())
      if (c->DECISION()) m.decision[{int(c->REGIME_INDEX()), int(c->AGE_INDEX())}] = c->DECISION()->str();
  m.minimumBinSamples = model->MINIMUM_BIN_SAMPLES();
  m.id = model->ID() ? model->ID()->str() : "";
  m.version = model->CALIBRATION_VERSION() ? model->CALIBRATION_VERSION()->str() : "";
  m.loaded = true;
  return true;
}

Mat6 expand(const std::array<double, 21>& c) {
  Mat6 out{};
  for (int a = 0, k = 0; a < 6; ++a)
    for (int b = 0; b <= a; ++b, ++k) out[6 * a + b] = out[6 * b + a] = c[k];
  return out;
}

// One element set's covariance against age: its regime's usable bins, the
// covariance (factor applied) at each bin center.
struct SetCurve {
  bool ok = false;
  std::string why;
  int regime = -1;
  std::vector<int> bins;
  std::vector<double> centers;
  std::vector<Mat6> cov;
};

SetCurve curveOf(const ErrorModel& m, double altitude, double ecc) {
  SetCurve c;
  if (!std::isfinite(altitude)) { c.why = "SGP4 refuses the element set (no mean altitude)"; return c; }
  for (size_t i = 0; i < m.regimes.size(); ++i) {
    const auto& r = m.regimes[i];
    if (ecc >= r.eccLo && ecc < r.eccHi && altitude >= r.altLo && altitude < r.altHi) { c.regime = int(i); break; }
  }
  if (c.regime < 0) { c.why = "outside the error model's regimes"; return c; }
  std::vector<int> withFactor;
  for (size_t i = 0; i < m.ages.size(); ++i) {
    const std::pair<int, int> key{c.regime, int(i)};
    const auto n = m.samples.find(key);
    if (!m.cov.count(key) || n == m.samples.end() || n->second < m.minimumBinSamples) continue;
    c.bins.push_back(int(i));
    c.centers.push_back(0.5 * (m.ages[i].first + m.ages[i].second));
    c.cov.push_back(expand(m.cov.at(key)));
    if (m.factor.count(key)) withFactor.push_back(int(i));
  }
  if (c.bins.empty()) { c.why = "no error-model strata for the regime " + m.regimes[c.regime].id; return c; }
  // The factor, linear in age between the centers of the bins that have one (held beyond), multiplies the covariance.
  if (!withFactor.empty())
    for (size_t k = 0; k < c.bins.size(); ++k) {
      const double x = c.centers[k];
      auto center = [&](int i) { return 0.5 * (m.ages[i].first + m.ages[i].second); };
      auto f = [&](int i) { return m.factor.at({c.regime, i}); };
      double s = f(withFactor.front());
      if (x >= center(withFactor.back())) s = f(withFactor.back());
      else
        for (size_t u = 0; u + 1 < withFactor.size(); ++u)
          if (x >= center(withFactor[u]) && x <= center(withFactor[u + 1])) {
            const double w = (x - center(withFactor[u])) / (center(withFactor[u + 1]) - center(withFactor[u]));
            s = (1 - w) * f(withFactor[u]) + w * f(withFactor[u + 1]);
          }
      for (double& v : c.cov[k]) v *= s;
    }
  c.ok = true;
  return c;
}

// The covariance at `days` of prediction age (the model's bins must hold it).
bool covarianceAt(const ErrorModel& m, const SetCurve& c, double days, Mat6& out) {
  if (days < m.ages.front().first || days > m.ages.back().second) return false;
  const size_t n = c.centers.size();
  if (days <= c.centers.front() || n == 1) { out = c.cov.front(); return true; }
  if (days >= c.centers.back()) { out = c.cov.back(); return true; }
  size_t k = size_t(std::upper_bound(c.centers.begin(), c.centers.end(), days) - c.centers.begin()) - 1;
  const double w = (days - c.centers[k]) / (c.centers[k + 1] - c.centers[k]);
  for (int i = 0; i < 36; ++i) out[i] = (1 - w) * c.cov[k][i] + w * c.cov[k + 1][i];
  return true;
}

std::string cellText(const ErrorModel& m, const SetCurve& c, double days) {
  int bin = -1;
  for (size_t i = 0; i < m.ages.size(); ++i)
    if (days >= m.ages[i].first && (days < m.ages[i].second || (i + 1 == m.ages.size() && days == m.ages[i].second))) bin = int(i);
  char text[160];
  std::snprintf(text, sizeof text, "%s, age %.2f d", m.regimes[c.regime].id.c_str(), days);
  std::string out = text;
  const auto d = m.decision.find({c.regime, bin});
  if (d != m.decision.end()) out += ": " + d->second;
  return out;
}

// ── small linear algebra ──────────────────────────────────────────────────
// The rows R, T, N of the RTN axes of the state r, v.
Mat3 rtnAxes(const Vec3& r, const Vec3& v) {
  const Vec3 R = unit(r), N = unit(cross(r, v)), T = cross(N, R);
  return {R[0], R[1], R[2], T[0], T[1], T[2], N[0], N[1], N[2]};
}
Vec3 mul(const Mat3& a, const Vec3& x) {
  return {a[0] * x[0] + a[1] * x[1] + a[2] * x[2], a[3] * x[0] + a[4] * x[1] + a[5] * x[2], a[6] * x[0] + a[7] * x[1] + a[8] * x[2]};
}
Mat3 mul(const Mat3& a, const Mat3& b) {
  Mat3 c{};
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) c[3 * i + j] = a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j];
  return c;
}
Mat3 transpose(const Mat3& a) { return {a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]}; }
Mat3 block(const Mat6& m, int r, int c) {
  Mat3 out{};
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) out[3 * i + j] = m[6 * (r + i) + c + j];
  return out;
}
// Lower Cholesky factor of a symmetric positive definite 3x3; false when it is not.
bool cholesky(const Mat3& a, Mat3& l) {
  l = {};
  for (int j = 0; j < 3; ++j) {
    double d = a[4 * j];
    for (int k = 0; k < j; ++k) d -= l[3 * j + k] * l[3 * j + k];
    if (!(d > 0)) return false;
    l[4 * j] = std::sqrt(d);
    for (int i = j + 1; i < 3; ++i) {
      double s = a[3 * i + j];
      for (int k = 0; k < j; ++k) s -= l[3 * i + k] * l[3 * j + k];
      l[3 * i + j] = s / l[4 * j];
    }
  }
  return true;
}
Vec3 cholSolve(const Mat3& l, const Vec3& b) {
  Vec3 y{}, x{};
  for (int i = 0; i < 3; ++i) {
    double s = b[i];
    for (int k = 0; k < i; ++k) s -= l[3 * i + k] * y[k];
    y[i] = s / l[4 * i];
  }
  for (int i = 2; i >= 0; --i) {
    double s = y[i];
    for (int k = i + 1; k < 3; ++k) s -= l[3 * k + i] * x[k];
    x[i] = s / l[4 * i];
  }
  return x;
}
bool solve3(const Mat3& a, const Vec3& b, Vec3& x) {
  const double det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
  double scale = 0;
  for (double v : a) scale = std::max(scale, std::fabs(v));
  if (!(std::fabs(det) > 1e-12 * scale * scale * scale)) return false;
  x[0] = (b[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (b[1] * a[8] - a[5] * b[2]) + a[2] * (b[1] * a[7] - a[4] * b[2])) / det;
  x[1] = (a[0] * (b[1] * a[8] - a[5] * b[2]) - b[0] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * b[2] - b[1] * a[6])) / det;
  x[2] = (a[0] * (a[4] * b[2] - b[1] * a[7]) - a[1] * (a[3] * b[2] - b[1] * a[6]) + b[0] * (a[3] * a[7] - a[4] * a[6])) / det;
  return true;
}

// ── the estimate ────────────────────────────────────────────────────────────
struct Impulse {
  bool ok = false;
  std::string why;                     // when not ok
  double lo = 0, hi = 0;               // the bracket: the two sets' epochs, inside their common span
  double time = 0, windowStart = 0, windowStop = 0;
  Vec3 dv{};                           // RTN, km/s: the posterior mean
  Mat3 dvCov{};                        // RTN, km^2/s^2
  double speed = 0, speedSigma = 0;    // |dv|: its posterior mean and 1-sigma, km/s
  size_t modes = 0;                    // burn-time posterior modes above 1 % of the largest
  Vec3 dpos{};                         // B - A at `time`, RTN, km
  Mat3 posCov{};                       // its covariance, km^2
  double chi2 = 0;                     // dpos' R_rr^-1 dpos at `time` with the model's R (3 degrees of freedom)
  double scale = 1;                    // R's scale: 1, or chi2 / 3 at the mode when one impulse does not fit
  Vec3 sigmaPre{}, sigmaPost{};        // 1-sigma position of A and of B at `time`, RTN, km
  Vec3 r0{}, v0{}, r1{}, v1{};         // A and B at `time`, km, km/s
  std::string cellPre, cellPost, model;
  size_t samples = 0;                  // burn times evaluated
  bool bound = false;                  // the minimum two-impulse bound
  double boundTotal = 0, boundSigma = 0, t1 = 0, t2 = 0;   // km/s, s
  Vec3 dv1{}, dv2{};                   // RTN at t1 (A) and t2 (B), km/s
};

struct Candidate {
  double t = 0, logL = 0, chi2 = 0;
  Vec3 mean{};
  Mat3 S{};
};

struct Pairing {
  const Block& a;
  const Block& b;
  const ErrorModel& m;
  SetCurve ca, cb;
  double scale = 1;  // R's scale
  // dv given a burn at t: false when the model does not hold both ages or R_rr is not positive definite.
  bool at(double t, Candidate& c, Vec3* dposOut = nullptr, Mat3* rrOut = nullptr, Mat6* paOut = nullptr, Mat6* pbOut = nullptr) const {
    Vec3 pa, va, pb, vb;
    sample(a, t, pa, va);
    sample(b, t, pb, vb);
    Mat6 Pa, Pb;
    if (!covarianceAt(m, ca, (t - a.epoch) / 86400.0, Pa) || !covarianceAt(m, cb, (b.epoch - t) / 86400.0, Pb)) return false;
    static const double D[6] = {1, -1, -1, -1, 1, 1};
    Mat6 R;
    for (int i = 0; i < 6; ++i)
      for (int j = 0; j < 6; ++j) R[6 * i + j] = scale * (Pa[6 * i + j] + D[i] * D[j] * Pb[6 * i + j]);
    const Mat3 axes = rtnAxes(pa, va);
    const Vec3 dr = mul(axes, sub(pb, pa)), dvel = mul(axes, sub(vb, va));
    const Mat3 Rrr = block(R, 0, 0), Rrv = block(R, 0, 3), Rvv = block(R, 3, 3);
    Mat3 L;
    if (!cholesky(Rrr, L)) return false;
    const Vec3 x = cholSolve(L, dr);
    // K = R_vr R_rr^-1, column by column of R_rr^-1 R_rv.
    Mat3 KT{};
    for (int j = 0; j < 3; ++j) {
      const Vec3 col = cholSolve(L, {Rrv[j], Rrv[3 + j], Rrv[6 + j]});
      for (int i = 0; i < 3; ++i) KT[3 * i + j] = col[i];
    }
    const Mat3 K = transpose(KT);
    const Vec3 kd = mul(K, dr);
    c.t = t;
    c.mean = sub(dvel, kd);
    const Mat3 KRrv = mul(K, Rrv);
    for (int i = 0; i < 9; ++i) c.S[i] = Rvv[i] - KRrv[i];
    c.chi2 = dot(dr, x);
    c.logL = -0.5 * c.chi2 - (std::log(L[0]) + std::log(L[4]) + std::log(L[8]));
    if (dposOut) *dposOut = dr;
    if (rrOut) *rrOut = Rrr;
    if (paOut) *paOut = Pa;
    if (pbOut) *pbOut = Pb;
    return true;
  }
};

// ── the two-impulse bound ─────────────────────────────────────────────────
Vec3 gravity(const Vec3& r) {
  const double r2 = dot(r, r), rn = std::sqrt(r2), z2 = r[2] * r[2] / r2;
  const double k = -1.5 * kJ2 * kMu * kRe * kRe / (r2 * r2 * rn);
  const Vec3 central = scale(r, -kMu / (r2 * rn));
  return {central[0] + k * r[0] * (1 - 5 * z2), central[1] + k * r[1] * (1 - 5 * z2), central[2] + k * r[2] * (3 - 5 * z2)};
}
Mat3 gravityGradient(const Vec3& r) {
  Mat3 g{};
  const double h = 1e-3;  // km
  for (int k = 0; k < 3; ++k) {
    Vec3 up = r, down = r;
    up[k] += h;
    down[k] -= h;
    const Vec3 d = scale(sub(gravity(up), gravity(down)), 0.5 / h);
    for (int i = 0; i < 3; ++i) g[3 * i + k] = d[i];
  }
  return g;
}

// Phi(t, t0) along a's trajectory on `times` (RK4 between consecutive times).
std::vector<Mat6> transitions(const Block& a, const std::vector<double>& times) {
  std::vector<Mat6> out(times.size());
  Mat6 phi{};
  for (int i = 0; i < 6; ++i) phi[7 * i] = 1;
  out[0] = phi;
  auto rate = [&](double t, const Mat6& p) {
    Vec3 r, v;
    sample(a, t, r, v);
    const Mat3 g = gravityGradient(r);
    Mat6 d{};
    for (int j = 0; j < 6; ++j)
      for (int i = 0; i < 3; ++i) {
        d[6 * i + j] = p[6 * (3 + i) + j];
        d[6 * (3 + i) + j] = g[3 * i] * p[j] + g[3 * i + 1] * p[6 + j] + g[3 * i + 2] * p[12 + j];
      }
    return d;
  };
  for (size_t k = 1; k < times.size(); ++k) {
    const double t = times[k - 1], h = times[k] - t;
    Mat6 tmp;
    const Mat6 k1 = rate(t, phi);
    for (int i = 0; i < 36; ++i) tmp[i] = phi[i] + 0.5 * h * k1[i];
    const Mat6 k2 = rate(t + 0.5 * h, tmp);
    for (int i = 0; i < 36; ++i) tmp[i] = phi[i] + 0.5 * h * k2[i];
    const Mat6 k3 = rate(t + 0.5 * h, tmp);
    for (int i = 0; i < 36; ++i) tmp[i] = phi[i] + h * k3[i];
    const Mat6 k4 = rate(t + h, tmp);
    for (int i = 0; i < 36; ++i) phi[i] += h / 6.0 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
    out[k] = phi;
  }
  return out;
}

// A transfer from A at t1 to B at t2: dv1 at t1 such that the relative state about A, under two-body and J2
// relative dynamics (nonlinear: after a burn of tens of m/s the trajectories are hundreds of km apart within hours),
// reaches B's position at t2; dv2 the velocity left there. Newton on dv1 from `guess`. rv, vv: the derivatives of
// the relative position and velocity at t2 with respect to dv1.
struct Transfer {
  bool ok = false;
  Vec3 d1{}, d2{};
  Mat3 rv{}, vv{};
  double total = std::numeric_limits<double>::infinity();
};

Transfer shoot(const Block& a, double t1, double t2, const Vec3& drTarget, const Vec3& dvTarget, Vec3 guess) {
  Transfer out;
  const size_t steps = std::max<size_t>(1, size_t(std::ceil((t2 - t1) / 30.0)));
  const double h = (t2 - t1) / double(steps);
  using X = std::array<double, 24>;  // relative position, velocity, then d/d dv1 of both (6 x 3, row-major)
  auto rate = [&](double t, const X& x) {
    Vec3 r, v;
    sample(a, t, r, v);
    const Vec3 rel{x[0], x[1], x[2]};
    const Vec3 dg = sub(gravity(add(r, rel)), gravity(r));
    const Mat3 g = gravityGradient(add(r, rel));
    X d{};
    for (int i = 0; i < 3; ++i) { d[i] = x[3 + i]; d[3 + i] = dg[i]; }
    for (int c = 0; c < 3; ++c)
      for (int i = 0; i < 3; ++i) {
        d[6 + 3 * i + c] = x[6 + 3 * (3 + i) + c];
        d[6 + 3 * (3 + i) + c] = g[3 * i] * x[6 + c] + g[3 * i + 1] * x[6 + 3 + c] + g[3 * i + 2] * x[6 + 6 + c];
      }
    return d;
  };
  for (int it = 0; it < 10; ++it) {
    X x{};
    for (int i = 0; i < 3; ++i) { x[3 + i] = guess[i]; x[6 + 3 * (3 + i) + i] = 1; }
    for (size_t k = 0; k < steps; ++k) {
      const double t = t1 + h * double(k);
      X tmp;
      const X k1 = rate(t, x);
      for (int i = 0; i < 24; ++i) tmp[i] = x[i] + 0.5 * h * k1[i];
      const X k2 = rate(t + 0.5 * h, tmp);
      for (int i = 0; i < 24; ++i) tmp[i] = x[i] + 0.5 * h * k2[i];
      const X k3 = rate(t + 0.5 * h, tmp);
      for (int i = 0; i < 24; ++i) tmp[i] = x[i] + h * k3[i];
      const X k4 = rate(t + h, tmp);
      for (int i = 0; i < 24; ++i) x[i] += h / 6.0 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
    }
    for (int i = 0; i < 9; ++i) { out.rv[i] = x[6 + i]; out.vv[i] = x[15 + i]; }
    const Vec3 miss = sub(Vec3{x[0], x[1], x[2]}, drTarget);
    if (norm(miss) < 1e-7) {
      out.ok = true;
      out.d1 = guess;
      out.d2 = sub(dvTarget, Vec3{x[3], x[4], x[5]});
      out.total = norm(out.d1) + norm(out.d2);
      return out;
    }
    Vec3 step;
    if (!solve3(out.rv, miss, step)) return out;
    guess = sub(guess, step);
    if (!(norm(guess) < 1.0)) return out;  // 1 km/s: not a transfer between neighboring orbits
  }
  return out;
}

// The bound: the linearized transfer (Phi along A) over every pair of grid times ranks the pairs; the best ones are
// solved under the nonlinear relative dynamics, and every pair within one ranking step of the best of those.
void twoImpulseBound(const Block& a, const Block& b, const Pairing& p, Impulse& out) {
  const double span = out.hi - out.lo;
  const size_t n = std::min<size_t>(20000, size_t(std::ceil(span / 30.0)) + 1);
  if (n < 3) return;
  std::vector<double> times(n);
  for (size_t k = 0; k < n; ++k) times[k] = out.lo + span * double(k) / double(n - 1);
  const std::vector<Mat6> phi = transitions(a, times);
  std::vector<Vec3> dr(n), dvel(n);
  for (size_t k = 0; k < n; ++k) {
    Vec3 pa, va, pb, vb;
    sample(a, times[k], pa, va);
    sample(b, times[k], pb, vb);
    dr[k] = sub(pb, pa);
    dvel[k] = sub(vb, va);
  }
  // Phi(t_j, t_i) = Phi_j Phi_i^-1, with the symplectic inverse [[Pvv', -Prv'], [-Pvr', Prr']].
  auto linear = [&](size_t i, size_t j, Vec3& d1) {
    const Mat6& pi = phi[i];
    const Mat6& pj = phi[j];
    const Mat3 irv = transpose(block(pi, 0, 3)), irr = transpose(block(pi, 0, 0));
    const Mat3 a1 = mul(block(pj, 0, 0), irv), a2 = mul(block(pj, 0, 3), irr), b1 = mul(block(pj, 3, 0), irv), b2 = mul(block(pj, 3, 3), irr);
    Mat3 rv{}, vv{};
    for (int k = 0; k < 9; ++k) { rv[k] = a2[k] - a1[k]; vv[k] = b2[k] - b1[k]; }
    if (!solve3(rv, dr[j], d1)) return std::numeric_limits<double>::infinity();
    return norm(d1) + norm(sub(dvel[j], mul(vv, d1)));
  };
  const size_t q = std::max<size_t>(1, (n + 399) / 400);
  struct Ranked { double total; size_t i, j; Vec3 d1; };
  std::vector<Ranked> ranked;
  for (size_t i = 0; i < n; i += q)
    for (size_t j = i + q; j < n; j += q) {
      Vec3 d1;
      const double s = linear(i, j, d1);
      if (std::isfinite(s)) ranked.push_back({s, i, j, d1});
    }
  if (ranked.empty()) return;
  const size_t keep = std::min<size_t>(24, ranked.size());
  std::partial_sort(ranked.begin(), ranked.begin() + keep, ranked.end(), [](const Ranked& x, const Ranked& y) { return x.total < y.total; });
  Transfer best;
  size_t bi = 0, bj = 0;
  for (size_t k = 0; k < keep; ++k) {
    const Ranked& r = ranked[k];
    const Transfer t = shoot(a, times[r.i], times[r.j], dr[r.j], dvel[r.j], r.d1);
    if (t.ok && t.total < best.total) { best = t; bi = r.i; bj = r.j; }
  }
  if (!best.ok) return;
  const size_t i0 = bi >= q ? bi - q : 0, j0 = bj >= q ? bj - q : 0;
  const size_t step = std::max<size_t>(1, q / 3);
  for (size_t i = i0; i <= std::min(n - 1, bi + q); i += step)
    for (size_t j = std::max(i + 1, j0); j <= std::min(n - 1, bj + q); j += step) {
      const Transfer t = shoot(a, times[i], times[j], dr[j], dvel[j], best.d1);
      if (t.ok && t.total < best.total) { best = t; bi = i; bj = j; }
    }
  // 1-sigma: d total = g' d(x_B - x_A)(t2), g_r = rv^-T (u1 - vv' u2), g_v = u2 (inertial); R at t2 is in the RTN axes of
  // A there, so g goes to those axes. Two impulses meet the data exactly, so R is the model's, never scaled.
  const Vec3 u1 = norm(best.d1) > 0 ? scale(best.d1, 1.0 / norm(best.d1)) : Vec3{0, 0, 0};
  const Vec3 u2 = norm(best.d2) > 0 ? scale(best.d2, 1.0 / norm(best.d2)) : Vec3{0, 0, 0};
  Vec3 gr, pa, va, pb, vb;
  sample(a, times[bi], pa, va);
  sample(b, times[bj], pb, vb);
  Vec3 p2, v2;
  sample(a, times[bj], p2, v2);
  Candidate c;
  Mat6 Pa, Pb;
  out.boundSigma = kNaN;
  if (solve3(transpose(best.rv), sub(u1, mul(transpose(best.vv), u2)), gr) && p.at(times[bj], c, nullptr, nullptr, &Pa, &Pb)) {
    const Mat3 axes = rtnAxes(p2, v2);
    const Vec3 g[2] = {mul(axes, gr), mul(axes, u2)};
    static const double D[6] = {1, -1, -1, -1, 1, 1};
    double var = 0;
    for (int i = 0; i < 6; ++i)
      for (int j = 0; j < 6; ++j) var += g[i / 3][i % 3] * g[j / 3][j % 3] * (Pa[6 * i + j] + D[i] * D[j] * Pb[6 * i + j]);
    out.boundSigma = std::sqrt(std::max(0.0, var));
  }
  out.bound = true;
  out.boundTotal = best.total;
  out.t1 = times[bi];
  out.t2 = times[bj];
  out.dv1 = mul(rtnAxes(pa, va), best.d1);
  out.dv2 = mul(rtnAxes(pb, vb), best.d2);
}

// The impulse of the event between blocks a (before) and b (after).
bool estimateImpulse(const Block& a, const Block& b, const ErrorModel& m, Impulse& out) {
  out = Impulse{};
  if (!m.loaded) { out.why = "no error model"; return false; }
  if (!std::isfinite(a.epoch) || !std::isfinite(b.epoch)) { out.why = "trajectories without element-set epochs (ephemerides)"; return false; }
  Pairing p{a, b, m, curveOf(m, a.meanAltitude, a.meanEccentricity), curveOf(m, b.meanAltitude, b.meanEccentricity)};
  if (!p.ca.ok || !p.cb.ok) { out.why = (p.ca.ok ? p.cb : p.ca).why; return false; }
  out.lo = std::max({a.epoch, a.start(), b.start()});
  out.hi = std::min({b.epoch, a.stop(), b.stop()});
  if (!(out.hi > out.lo)) { out.why = "the two sets' epochs bracket no common span"; return false; }
  // Burn times: a grid over the bracket (at most 10 s apart), then ten points in each grid cell whose posterior
  // weight is above 1e-9 of the largest.
  const double span = out.hi - out.lo;
  const size_t n = std::max<size_t>(2, std::min<size_t>(200001, size_t(std::ceil(span / 10.0)) + 1));
  const double h = span / double(n - 1);
  std::vector<Candidate> coarse(n);
  double top = -std::numeric_limits<double>::infinity();
  for (int pass = 0; pass < 2; ++pass) {
    top = -std::numeric_limits<double>::infinity();
    size_t best = 0;
    for (size_t k = 0; k < n; ++k) {
      if (!p.at(out.lo + h * double(k), coarse[k])) { out.why = "the error model does not hold the bracket's ages (beyond its last bin)"; return false; }
      if (coarse[k].logL > top) { top = coarse[k].logL; best = k; }
    }
    if (pass == 1 || coarse[best].chi2 <= kRejectChi2) break;
    p.scale = coarse[best].chi2 / 3.0;
  }
  out.scale = p.scale;
  std::vector<Candidate> grid;
  std::vector<size_t> kept;
  for (size_t k = 0; k < n; ++k) if (coarse[k].logL > top - 20.72) kept.push_back(k);
  if (kept.size() <= 20000) {
    for (size_t k : kept)
      for (int j = 0; j < 10; ++j) {
        const double t = out.lo + h * (double(k) - 0.5 + (j + 0.5) / 10.0);
        if (t < out.lo || t > out.hi) continue;
        Candidate c;
        if (p.at(t, c)) grid.push_back(c);
      }
  } else {
    grid = coarse;
  }
  if (grid.empty()) { out.why = "no burn time in the bracket"; return false; }
  top = -std::numeric_limits<double>::infinity();
  for (const auto& c : grid) top = std::max(top, c.logL);
  std::vector<double> w(grid.size());
  double sum = 0;
  size_t mode = 0;
  for (size_t k = 0; k < grid.size(); ++k) {
    w[k] = std::exp(grid[k].logL - top);
    sum += w[k];
    if (grid[k].logL == top) mode = k;
  }
  Vec3 mean{};
  for (size_t k = 0; k < grid.size(); ++k) mean = add(mean, scale(grid[k].mean, w[k] / sum));
  Mat3 cov{};
  for (size_t k = 0; k < grid.size(); ++k) {
    const Vec3 d = sub(grid[k].mean, mean);
    for (int i = 0; i < 3; ++i)
      for (int j = 0; j < 3; ++j) cov[3 * i + j] += w[k] / sum * (grid[k].S[3 * i + j] + d[i] * d[j]);
  }
  double acc = 0;
  out.windowStart = grid.front().t;
  out.windowStop = grid.back().t;
  bool started = false;
  for (size_t k = 0; k < grid.size(); ++k) {
    acc += w[k] / sum;
    if (!started && acc >= kWindowTail) { out.windowStart = grid[k].t; started = true; }
    if (acc >= 1.0 - kWindowTail) { out.windowStop = grid[k].t; break; }
  }
  // |dv| over the mixture: given tb its mean is |mean(tb)| and its variance u' S u, u the direction.
  double speed = 0, speed2 = 0;
  for (size_t k = 0; k < grid.size(); ++k) {
    const double m = norm(grid[k].mean);
    const Vec3 u = m > 0 ? scale(grid[k].mean, 1.0 / m) : Vec3{0, 0, 0};
    double var = 0;
    for (int i = 0; i < 3; ++i)
      for (int j = 0; j < 3; ++j) var += u[i] * grid[k].S[3 * i + j] * u[j];
    speed += w[k] / sum * m;
    speed2 += w[k] / sum * (var + m * m);
  }
  out.speed = speed;
  out.speedSigma = std::sqrt(std::max(0.0, speed2 - speed * speed));
  // Modes: local maxima of the coarse posterior above 1 % of its largest.
  double coarseTop = -std::numeric_limits<double>::infinity();
  for (const auto& c : coarse) coarseTop = std::max(coarseTop, c.logL);
  for (size_t k = 0; k < n; ++k) {
    const double l = coarse[k].logL;
    if (l > coarseTop + std::log(0.01) && (k == 0 || l >= coarse[k - 1].logL) && (k + 1 == n || l > coarse[k + 1].logL)) ++out.modes;
  }
  out.time = grid[mode].t;
  out.dv = mean;
  out.dvCov = cov;
  out.samples = coarse.size() + (grid.size() == coarse.size() ? 0 : grid.size());
  Candidate c;
  Mat6 Pa, Pb;
  p.at(out.time, c, &out.dpos, &out.posCov, &Pa, &Pb);
  out.chi2 = c.chi2 * p.scale;
  for (int i = 0; i < 3; ++i) {
    out.sigmaPre[i] = std::sqrt(p.scale * Pa[7 * i]);
    out.sigmaPost[i] = std::sqrt(p.scale * Pb[7 * i]);
  }
  sample(a, out.time, out.r0, out.v0);
  sample(b, out.time, out.r1, out.v1);
  out.cellPre = cellText(m, p.ca, (out.time - a.epoch) / 86400.0);
  out.cellPost = cellText(m, p.cb, (b.epoch - out.time) / 86400.0);
  out.model = m.id + (m.version.empty() || m.version == m.id ? "" : " " + m.version);
  twoImpulseBound(a, b, p, out);
  out.ok = true;
  return true;
}
}  // namespace
