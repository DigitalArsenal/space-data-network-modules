// analysis/maneuver-detection: D2 (level GLR, impulsive) and D3 (low thrust).
//
// D2. Each set's in-track level is its trajectory's orbit-averaged
// semi-major axis about its own epoch, as in-track delta-V (v da / 2a). A set
// fitted across a burn may absorb it in its drag term; its level, taken where
// its fit is centred, is unaffected. The cross-track level is D1's cumulative
// orbit-normal chain. For every gap between consecutive levels a robust
// (Huber) regression over the sets within +-glr_span_days (at most glr_sets per side)
// fits a level, a drag trend and a step: y = a + b (t - tau) + d H(t - tau).
// Lambda = (d / s_d)^2 is the generalised likelihood ratio for a jump in a
// linear model (Willsky and Jones 1976). Changes are accepted strongest
// first, each one entering the regressions around it as a known-time step, and
// a second change within one window needs two sets between them whose levels
// agree. The event time is the crossing of the last set on the old level and
// the first set on the new one.
//
// D3. On the same in-track levels, a hinge regression y = a + b (t - tau) +
// g (t - tau)+ finds changes of the energy rate: the onset or end of thrust
// sustained over days (electric propulsion), when the hinge explains the gap
// better than a step does.
namespace {

// ── weighted least squares with Tukey's biweight ────────────────────────────
struct Fit {
  bool ok = false;
  std::vector<double> beta, cov, w, resid;  // cov: (X^T W X)^-1, row-major
};

// Solve (X^T W X) beta = X^T W y; cov = (X^T W X)^-1 by Gauss-Jordan with
// partial pivoting. Rows are X's rows.
bool weightedSolve(const std::vector<std::vector<double>>& X, const std::vector<double>& y, const std::vector<double>& w, Fit& f) {
  const size_t n = X.size(), p = X.empty() ? 0 : X[0].size();
  if (n < p || p == 0) return false;
  std::vector<double> A(p * 2 * p, 0.0), b(p, 0.0);
  for (size_t i = 0; i < n; ++i) {
    if (w[i] <= 0) continue;
    for (size_t r = 0; r < p; ++r) {
      b[r] += w[i] * X[i][r] * y[i];
      for (size_t c = 0; c < p; ++c) A[r * 2 * p + c] += w[i] * X[i][r] * X[i][c];
    }
  }
  for (size_t r = 0; r < p; ++r) A[r * 2 * p + p + r] = 1.0;
  double scaleMax = 0;
  for (size_t r = 0; r < p; ++r) scaleMax = std::max(scaleMax, std::fabs(A[r * 2 * p + r]));
  if (!(scaleMax > 0)) return false;
  for (size_t c = 0; c < p; ++c) {
    size_t piv = c;
    for (size_t r = c + 1; r < p; ++r) if (std::fabs(A[r * 2 * p + c]) > std::fabs(A[piv * 2 * p + c])) piv = r;
    if (std::fabs(A[piv * 2 * p + c]) < 1e-12 * scaleMax) return false;
    if (piv != c) for (size_t k = 0; k < 2 * p; ++k) std::swap(A[c * 2 * p + k], A[piv * 2 * p + k]);
    const double d = A[c * 2 * p + c];
    for (size_t k = 0; k < 2 * p; ++k) A[c * 2 * p + k] /= d;
    for (size_t r = 0; r < p; ++r) {
      if (r == c) continue;
      const double f0 = A[r * 2 * p + c];
      if (f0 == 0) continue;
      for (size_t k = 0; k < 2 * p; ++k) A[r * 2 * p + k] -= f0 * A[c * 2 * p + k];
    }
  }
  f.cov.assign(p * p, 0);
  for (size_t r = 0; r < p; ++r) for (size_t c = 0; c < p; ++c) f.cov[r * p + c] = A[r * 2 * p + p + c];
  f.beta.assign(p, 0);
  for (size_t r = 0; r < p; ++r) for (size_t c = 0; c < p; ++c) f.beta[r] += f.cov[r * p + c] * b[c];
  f.resid.assign(n, 0);
  for (size_t i = 0; i < n; ++i) {
    double fit = 0;
    for (size_t c = 0; c < p; ++c) fit += X[i][c] * f.beta[c];
    f.resid[i] = y[i] - fit;
  }
  f.w = w;
  f.ok = true;
  return true;
}

// Iteratively reweighted least squares with Huber's weights at 1.345 sigma
// (95 % efficiency under Gaussian noise of scale sigma). Huber's weights never
// vanish, so a window that holds a second, not yet accepted step still fits,
// with that step's sets down-weighted; the forward selection then finds it.
bool robustFit(const std::vector<std::vector<double>>& X, const std::vector<double>& y, double sigma, Fit& f) {
  std::vector<double> w(X.size(), 1.0);
  if (!weightedSolve(X, y, w, f)) return false;
  const double c = 1.345 * sigma;
  for (int it = 0; it < 50; ++it) {
    std::vector<double> nw(X.size());
    for (size_t i = 0; i < X.size(); ++i) {
      const double r = std::fabs(f.resid[i]);
      nw[i] = r <= c ? 1.0 : c / r;
    }
    Fit next;
    if (!weightedSolve(X, y, nw, next)) return false;
    double change = 0, size = 0;
    for (size_t k = 0; k < next.beta.size(); ++k) { change += std::fabs(next.beta[k] - f.beta[k]); size += std::fabs(next.beta[k]); }
    f = next;
    if (change <= 1e-12 * std::max(1.0, size)) break;
  }
  return true;
}

// ── levels ─────────────────────────────────────────────────────────────────────
struct Levels {
  std::vector<size_t> block;   // block of each level
  std::vector<double> t;       // s
  std::vector<double> a;       // km, orbit-averaged
  std::vector<double> y;       // m/s, in-track level
  std::vector<double> sigma;   // m/s, local robust scale
  std::vector<OrbitMean> means;
  std::vector<Vec3> plane;     // m/s, cumulative v (h1 - h0) of consecutive sets over one revolution
  std::vector<double> planeSigma;
  double aRef = 0, vRef = 0;   // km, km/s
};

// Local robust scale of a level series: 1.4826 x the median absolute
// residual of each level against the line through its neighbours,
// normalised to unit variance under white noise, over +-window levels.
std::vector<double> localScale(const std::vector<double>& t, const std::vector<std::vector<double>>& y, int window) {
  const size_t n = t.size();
  std::vector<double> sigma(n, kNaN);
  if (n < 3) return sigma;
  std::vector<std::vector<double>> r(n);
  for (size_t j = 1; j + 1 < n; ++j) {
    const double span = t[j + 1] - t[j - 1];
    const double w = span > 0 ? (t[j] - t[j - 1]) / span : 0.5;
    const double norm2 = std::sqrt(1 + w * w + (1 - w) * (1 - w));
    for (size_t c = 0; c < y[j].size(); ++c)
      r[j].push_back(std::fabs(y[j][c] - (y[j - 1][c] + w * (y[j + 1][c] - y[j - 1][c]))) / norm2);
  }
  for (size_t j = 0; j < n; ++j) {
    const size_t c = std::min(std::max<size_t>(j, 1), n - 2);
    const size_t lo = c >= size_t(window) + 1 ? c - window : 1, hi = std::min(n - 2, c + window);
    std::vector<double> pool;
    for (size_t k = lo; k <= hi; ++k) pool.insert(pool.end(), r[k].begin(), r[k].end());
    sigma[j] = std::max(1e-9, 1.4826 * median(pool));
  }
  return sigma;
}

void buildLevels(const std::vector<Block>& blocks, const Options& o, Levels& L) {
  std::vector<double> as;
  for (size_t k = 0; k < blocks.size(); ++k) {
    const OrbitMean m = orbitMeanNear(blocks[k], blocks[k].ref());
    if (!m.ok) continue;
    L.block.push_back(k);
    L.t.push_back(blocks[k].ref());
    L.a.push_back(m.a);
    L.means.push_back(m);
    as.push_back(m.a);
  }
  if (L.block.empty()) return;
  L.aRef = median(as);
  L.vRef = std::sqrt(kMu / L.aRef);
  std::vector<std::vector<double>> y;
  for (double a : L.a) {
    L.y.push_back(L.vRef * (a - L.aRef) / (2.0 * L.aRef) * 1000.0);
    y.push_back({L.y.back()});
  }
  L.sigma = localScale(L.t, y, o.scaleWindow);
  // The plane: each set's mean orbit normal over its own revolution against
  // the previous set's over the same revolution (one instant span, so the
  // nodal regression common to both cancels), summed into a chain.
  std::vector<std::vector<double>> h;
  Vec3 level{0, 0, 0};
  for (size_t i = 0; i < L.block.size(); ++i) {
    if (i > 0) {
      const OrbitMean prev = orbitMeanSame(blocks[L.block[i - 1]], L.means[i]);
      if (prev.ok) level = add(level, scale(sub(L.means[i].h, prev.h), L.vRef * 1000.0));
    }
    L.plane.push_back(level);
    h.push_back({level[0], level[1], level[2]});
  }
  L.planeSigma = localScale(L.t, h, o.scaleWindow);
}

// ── the step scan ──────────────────────────────────────────────────────────────
struct Change {
  size_t gap = 0;            // between level gap and gap + 1
  double tau = 0;            // s
  Vec3 delta{};              // step (one component for in-track)
  double sd = 0;             // standard error of |delta| (in-track: of delta)
  double lambda = 0;
  double slope = 0;          // m/s per day (trend in the window)
  bool valid = false;
};

struct Series {
  std::vector<double> t;
  std::vector<std::vector<double>> y;  // one or three components
  std::vector<double> sigma;
  size_t dims() const { return y.empty() ? 0 : y[0].size(); }
};

// The window of gap g: sets within span seconds and at most per sets on each side.
void windowOf(const Series& s, size_t g, int per, double span, size_t& lo, size_t& hi) {
  lo = g;
  while (lo > 0 && g + 1 - lo < size_t(per) && s.t[g] - s.t[lo - 1] <= span) --lo;
  hi = g + 1;
  while (hi + 1 < s.t.size() && hi - g < size_t(per) && s.t[hi + 1] - s.t[g + 1] <= span) ++hi;
}

// Step (and optionally hinge) regression around gap g with the accepted
// changes inside the window as known-time steps. `hinge` replaces the step
// regressor by (t - tau)+ (days).
Change testGap(const Series& s, size_t g, const std::vector<size_t>& known, int per, double span, bool hinge, int minEach) {
  Change c;
  c.gap = g;
  size_t lo, hi;
  windowOf(s, g, per, span, lo, hi);
  if (int(g + 1 - lo) < minEach || int(hi - g) < minEach) return c;
  c.tau = 0.5 * (s.t[g] + s.t[g + 1]);
  std::vector<size_t> others;
  for (size_t k : known) if (k != g && k >= lo && k < hi) others.push_back(k);
  std::vector<std::vector<double>> X;
  for (size_t i = lo; i <= hi; ++i) {
    const double dt = (s.t[i] - c.tau) / 86400.0;
    std::vector<double> row = {1.0, dt, hinge ? std::max(0.0, dt) : (i > g ? 1.0 : 0.0)};
    for (size_t k : others) row.push_back(i > k ? 1.0 : 0.0);
    X.push_back(row);
  }
  const double sigma = s.sigma[g];
  double lambda = 0, magnitude2 = 0, var = 0;
  for (size_t d = 0; d < s.dims(); ++d) {
    std::vector<double> y;
    for (size_t i = lo; i <= hi; ++i) y.push_back(s.y[i][d]);
    Fit f;
    if (!robustFit(X, y, sigma, f)) return c;
    const double v = sigma * sigma * f.cov[2 * X[0].size() + 2];
    if (!(v > 0)) return c;
    c.delta[d] = f.beta[2];
    if (d == 0) c.slope = f.beta[1];
    lambda += f.beta[2] * f.beta[2] / v;
    magnitude2 += f.beta[2] * f.beta[2];
    var += v;
  }
  c.lambda = lambda;
  c.sd = std::sqrt(var / double(s.dims()));
  c.valid = std::isfinite(lambda) && std::sqrt(magnitude2) >= 0;
  return c;
}

double magnitudeOf(const Change& c, size_t dims) {
  return dims == 1 ? std::fabs(c.delta[0]) : norm(c.delta);
}

// Two changes in one window need at least two sets between them whose levels
// (less the trend) agree within max(3 sigma, 25 % of the smaller step).
bool separable(const Series& s, const Change& a, const Change& b, size_t dims) {
  const size_t g1 = std::min(a.gap, b.gap), g2 = std::max(a.gap, b.gap);
  if (g2 - g1 < 2) return false;
  double lo = std::numeric_limits<double>::infinity(), hi = -lo;
  const double slope = a.gap < b.gap ? a.slope : b.slope;
  for (size_t i = g1 + 1; i <= g2; ++i) {
    const double v = s.y[i][0] - slope * (s.t[i] - s.t[g1 + 1]) / 86400.0;
    lo = std::min(lo, v);
    hi = std::max(hi, v);
  }
  if (dims > 1) return true;
  const double tolerance = std::max(3.0 * s.sigma[g1 + 1], 0.25 * std::min(magnitudeOf(a, dims), magnitudeOf(b, dims)));
  return hi - lo <= tolerance;
}

// Forward selection of step changes (strongest first).
std::vector<Change> selectSteps(const Series& s, int per, double span, double h2, double floor) {
  std::vector<Change> accepted;
  const size_t n = s.t.size();
  if (n < 6) return accepted;
  const size_t dims = s.dims();
  std::vector<size_t> known;
  std::vector<Change> scan(n - 1);
  for (size_t g = 0; g + 1 < n; ++g) scan[g] = testGap(s, g, known, per, span, false, 3);
  std::vector<char> blocked(n - 1, 0);
  for (size_t iteration = 0; iteration < n; ++iteration) {
    size_t best = n;
    for (size_t g = 0; g + 1 < n; ++g) {
      const Change& c = scan[g];
      if (blocked[g] || !c.valid || c.lambda < h2 || magnitudeOf(c, dims) < floor) continue;
      if (best == n || c.lambda > scan[best].lambda) best = g;
    }
    if (best == n) break;
    bool ok = true;
    for (const Change& a : accepted) {
      size_t lo, hi;
      windowOf(s, best, per, span, lo, hi);
      if (a.gap + 1 >= lo && a.gap <= hi && !separable(s, a, scan[best], dims)) { ok = false; break; }
    }
    blocked[best] = 1;
    if (!ok) continue;
    accepted.push_back(scan[best]);
    known.push_back(best);
    // Re-test the gaps whose windows hold the new change.
    const size_t from = best > size_t(per) + 1 ? best - per - 1 : 0, to = std::min(n - 2, best + per + 1);
    for (size_t g = from; g <= to; ++g) if (!blocked[g]) scan[g] = testGap(s, g, known, per, span, false, 3);
  }
  // Joint refit of every accepted change with its neighbours as known steps.
  for (Change& c : accepted) {
    Change refit = testGap(s, c.gap, known, per, span, false, 3);
    if (refit.valid) c = refit;
  }
  std::vector<Change> kept;
  for (const Change& c : accepted) if (c.lambda >= h2 && magnitudeOf(c, dims) >= floor) kept.push_back(c);
  std::sort(kept.begin(), kept.end(), [](const Change& a, const Change& b) { return a.gap < b.gap; });
  return kept;
}

// D3: hinge changes, with D2's steps as known regressors.
std::vector<Change> selectHinges(const Series& s, const std::vector<Change>& steps, const Options& o) {
  std::vector<Change> out;
  const size_t n = s.t.size();
  if (n < 10) return out;
  std::vector<size_t> known;
  for (const Change& c : steps) known.push_back(c.gap);
  const double h2 = o.ltH * o.ltH, span = o.ltSpanDays * 86400.0;
  std::vector<Change> hinge(n - 1), step(n - 1);
  for (size_t g = 0; g + 1 < n; ++g) {
    hinge[g] = testGap(s, g, known, o.ltSets, span, true, 4);
    step[g] = testGap(s, g, known, o.ltSets, span, false, 4);
  }
  std::vector<size_t> order;
  for (size_t g = 0; g + 1 < n; ++g) {
    const Change& c = hinge[g];
    if (!c.valid || c.lambda < h2 || std::fabs(c.delta[0]) < o.ltFloor) continue;
    if (step[g].valid && step[g].lambda >= c.lambda) continue;
    order.push_back(g);
  }
  std::sort(order.begin(), order.end(), [&](size_t a, size_t b) { return hinge[a].lambda > hinge[b].lambda; });
  for (size_t g : order) {
    bool near = false;
    for (const Change& c : out) if (std::fabs(c.tau - hinge[g].tau) < 0.5 * span) near = true;
    if (!near) out.push_back(hinge[g]);
  }
  std::sort(out.begin(), out.end(), [](const Change& a, const Change& b) { return a.gap < b.gap; });
  return out;
}

// The levels on either side of a change that sit on the old and the new
// level: the last before (and first after) the gap whose residual from the
// change's own fit is within max(3 sigma, 10 % of the step) (sets after a burn
// settle with errors that grow with the burn).
void consistentSides(const Series& s, const Change& c, const std::vector<size_t>& known, int per, double span,
                     size_t& before, size_t& after) {
  before = c.gap;
  after = c.gap + 1;
  size_t lo, hi;
  windowOf(s, c.gap, per, span, lo, hi);
  std::vector<size_t> others;
  for (size_t k : known) if (k != c.gap && k >= lo && k < hi) others.push_back(k);
  std::vector<std::vector<double>> X;
  std::vector<double> y;
  for (size_t i = lo; i <= hi; ++i) {
    std::vector<double> row = {1.0, (s.t[i] - c.tau) / 86400.0, i > c.gap ? 1.0 : 0.0};
    for (size_t k : others) row.push_back(i > k ? 1.0 : 0.0);
    X.push_back(row);
    y.push_back(s.y[i][0]);
  }
  Fit f;
  if (!robustFit(X, y, s.sigma[c.gap], f)) return;
  const double limit = std::max(3.0 * s.sigma[c.gap], 0.1 * std::fabs(f.beta[2]));
  for (size_t i = c.gap + 1; i-- > lo;) if (std::fabs(f.resid[i - lo]) <= limit) { before = i; break; }
  for (size_t i = c.gap + 1; i <= hi; ++i) if (std::fabs(f.resid[i - lo]) <= limit) { after = i; break; }
}

struct TierTwo {
  Levels levels;
  Series inTrack, plane;
  std::vector<Change> steps, planeSteps, hinges;
  std::vector<Event> events, lowThrust;
};

void runTierTwo(const std::vector<Block>& blocks, const TierOne& d1, const Options& o, TierTwo& d) {
  buildLevels(blocks, o, d.levels);
  const Levels& L = d.levels;
  const double span = o.glrSpanDays * 86400.0;
  const double h2 = o.glrH * o.glrH;
  for (size_t i = 0; i < L.t.size(); ++i) { d.inTrack.t.push_back(L.t[i]); d.inTrack.y.push_back({L.y[i]}); }
  d.inTrack.sigma = L.sigma;
  for (size_t i = 0; i < L.t.size(); ++i) { d.plane.t.push_back(L.t[i]); d.plane.y.push_back({L.plane[i][0], L.plane[i][1], L.plane[i][2]}); }
  d.plane.sigma = L.planeSigma;
  d.steps = selectSteps(d.inTrack, o.glrSets, span, h2, o.glrFloorInTrack);
  d.planeSteps = selectSteps(d.plane, o.glrSets, span, chi2Threshold3(h2), o.glrFloorPlane * L.vRef * 1000.0);
  std::vector<size_t> known;
  for (const Change& c : d.steps) known.push_back(c.gap);

  // In-track changes become events; a plane change on the same or the next
  // block gap joins it (COMBINED), others stand alone.
  std::vector<char> planeUsed(d.planeSteps.size(), 0);
  for (const Change& c : d.steps) {
    size_t before, after;
    consistentSides(d.inTrack, c, known, o.glrSets, span, before, after);
    Event e;
    e.detector = "D2";
    e.before = L.block[before];
    e.after = L.block[after];
    const Block& pre = blocks[e.before];
    const Block& post = blocks[e.after];
    Pair p;
    const bool overlap = std::min(pre.stop(), post.stop()) > std::max(pre.start(), post.start());
    if (overlap && analysePair(pre, post, o.gridStep, p) && !p.edge && p.t <= L.t[after] && p.t >= L.t[before] - 86400.0) {
      e.crossing = true;
      e.time = p.t;
      e.r0 = p.r0; e.v0 = p.v0; e.r1 = p.r1; e.v1 = p.v1;
      e.separation = p.dmin;
    } else {
      e.time = c.tau;
      sample(pre, e.time, e.r0, e.v0);
      sample(post, e.time, e.r1, e.v1);
      e.separation = norm(sub(e.r1, e.r0));
    }
    e.endTime = e.time;
    // The step in semi-major axis, and the in-track delta-V at the burn point.
    e.deltaSma = c.delta[0] / 1000.0 * 2.0 * L.aRef / L.vRef;
    const double aB = smaOf(e.r0, e.v0), vB = norm(e.v0);
    e.rawInTrack = (aB > 0 && vB > 0) ? kMu * e.deltaSma / (2.0 * aB * aB * vB) * 1000.0 : c.delta[0];
    e.inTrack = e.rawInTrack;
    e.inTrackFired = true;
    e.evidence = {{"lambda", c.lambda}, {"step_mps", c.delta[0]}, {"step_sd_mps", c.sd}, {"sigma_mps", d.inTrack.sigma[c.gap]},
                  {"trend_mps_per_day", c.slope}, {"gap", {isoMs(L.t[c.gap]), isoMs(L.t[c.gap + 1])}},
                  {"old_level_set", isoMs(L.t[before])}, {"new_level_set", isoMs(L.t[after])}, {"time_from", e.crossing ? "crossing" : "gap"}};
    for (size_t k = 0; k < d.planeSteps.size(); ++k) {
      const size_t g = d.planeSteps[k].gap;
      if (planeUsed[k] || g + 1 < before || g > after) continue;
      planeUsed[k] = 1;
      e.crossTrackFired = true;
      e.rawCrossTrack = crossTrackOf(d.planeSteps[k].delta, e.r0, e.v0);
      e.crossTrack = e.rawCrossTrack;
      e.evidence["plane_lambda"] = d.planeSteps[k].lambda;
      e.evidence["plane_step_mps"] = norm(d.planeSteps[k].delta);
    }
    d.events.push_back(e);
  }
  for (size_t k = 0; k < d.planeSteps.size(); ++k) {
    if (planeUsed[k]) continue;
    const Change& c = d.planeSteps[k];
    Event e;
    e.detector = "D2";
    e.before = L.block[c.gap];
    e.after = L.block[c.gap + 1];
    const Block& pre = blocks[e.before];
    const Block& post = blocks[e.after];
    Pair p;
    const bool overlap = std::min(pre.stop(), post.stop()) > std::max(pre.start(), post.start());
    if (overlap && analysePair(pre, post, o.gridStep, p) && !p.edge) {
      e.crossing = true;
      e.time = p.t;
      e.r0 = p.r0; e.v0 = p.v0; e.r1 = p.r1; e.v1 = p.v1;
      e.separation = p.dmin;
      e.rawInTrack = p.qT;
    } else {
      e.time = c.tau;
      sample(pre, e.time, e.r0, e.v0);
      sample(post, e.time, e.r1, e.v1);
      e.separation = norm(sub(e.r1, e.r0));
    }
    e.endTime = e.time;
    e.crossTrackFired = true;
    e.rawCrossTrack = crossTrackOf(c.delta, e.r0, e.v0);
    e.crossTrack = e.rawCrossTrack;
    e.evidence = {{"plane_lambda", c.lambda}, {"plane_step_mps", norm(c.delta)}, {"sigma_mps", d.plane.sigma[c.gap]},
                  {"gap", {isoMs(L.t[c.gap]), isoMs(L.t[c.gap + 1])}}, {"time_from", e.crossing ? "crossing" : "gap"}};
    d.events.push_back(e);
  }
  std::sort(d.events.begin(), d.events.end(), [](const Event& a, const Event& b) { return a.time < b.time; });

  if (o.d3) {
    d.hinges = selectHinges(d.inTrack, d.steps, o);
    for (const Change& c : d.hinges) {
      Event e;
      e.detector = "D3";
      e.before = L.block[c.gap];
      e.after = L.block[c.gap + 1];
      e.time = e.endTime = c.tau;
      sample(blocks[e.before], e.time, e.r0, e.v0);
      sample(blocks[e.after], e.time, e.r1, e.v1);
      e.separation = norm(sub(e.r1, e.r0));
      e.accel = c.delta[0] / 86400.0;  // m/s per day of level -> m/s^2 along-track
      e.evidence = {{"lambda", c.lambda}, {"rate_change_mps_per_day", c.delta[0]}, {"rate_change_sd", c.sd},
                    {"trend_before_mps_per_day", c.slope}, {"gap", {isoMs(L.t[c.gap]), isoMs(L.t[c.gap + 1])}}};
      d.lowThrust.push_back(e);
    }
  }
}

Json levelsJson(const TierTwo& d) {
  Json rows = Json::array();
  for (size_t i = 0; i < d.levels.t.size(); ++i)
    rows.push_back({{"set", isoMs(d.levels.t[i])}, {"sma_km", d.levels.a[i]}, {"level_mps", d.levels.y[i]}, {"sigma_mps", d.levels.sigma[i]},
                    {"plane_mps", {d.levels.plane[i][0], d.levels.plane[i][1], d.levels.plane[i][2]}}, {"plane_sigma_mps", d.levels.planeSigma[i]}});
  return rows;
}

// C: D1 and D2 events of one object within merge_hours are one event, with
// D2's time and delta-V when D2's time comes from a crossing, else D1's.
std::vector<Event> mergeEvents(const std::vector<Event>& d1, const std::vector<Event>& d2, double hours) {
  std::vector<Event> out;
  std::vector<char> used(d1.size(), 0);
  for (const Event& e2 : d2) {
    size_t best = d1.size();
    for (size_t k = 0; k < d1.size(); ++k) {
      if (used[k] || std::fabs(d1[k].time - e2.time) > hours * 3600.0) continue;
      if (best == d1.size() || std::fabs(d1[k].time - e2.time) < std::fabs(d1[best].time - e2.time)) best = k;
    }
    if (best == d1.size()) { out.push_back(e2); continue; }
    used[best] = 1;
    Event e = e2.crossing ? e2 : d1[best];
    e.detector = "C";
    e.evidence = {{"D1", d1[best].evidence}, {"D2", e2.evidence}, {"D1_time", isoMs(d1[best].time)}, {"D2_time", isoMs(e2.time)},
                  {"kept", e2.crossing ? "D2" : "D1"}};
    out.push_back(e);
  }
  for (size_t k = 0; k < d1.size(); ++k) if (!used[k]) out.push_back(d1[k]);
  std::sort(out.begin(), out.end(), [](const Event& a, const Event& b) { return a.time < b.time; });
  return out;
}
}  // namespace
