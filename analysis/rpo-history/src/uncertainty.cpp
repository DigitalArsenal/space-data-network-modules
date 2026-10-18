// analysis/rpo-history: the uncertainty of the relative motion, the
// conditional coast projection and its hindcast.
//
// Model covariance. An object's element set at prediction age a has the GP
// error model's 6x6 RTN covariance for its regime and age (km, km/s), in the
// object's own RTN axes at that instant. Both objects' covariances are
// carried to the curvilinear R, I, C through the Jacobian of the geometry
// with respect to each object's inertial state (central differences, 1 m and
// 1 mm/s), so an error of the target moves the reference frame, origin and
// axes, as it does. The objects' errors are taken as independent:
// C = Jc Cc Jc^T + Jt Ct Jt^T.
//
// Relative samples. For each t0 at which a set of either object comes into
// force, the sets in force at t0 predict to each later epoch tau of either
// object within the horizon; the truth there is the relative state from the
// sets in force at tau (the next element sets). The model covariance of the
// difference has the terms of the objects whose set changed, each at its
// prediction age (and, against a model of the error against truth rather
// than of set differences, the later set's own at its age). No sample spans
// a maneuver bracket or involves a settling set (one issued within `settle`
// after a bracket): the projection is conditional on no maneuvers.
//
// Calibration, continuous and out of sample. At a time t the bands are the
// model's times per-axis factors from the pair's own relative samples whose
// later epoch lies in [t - W, t): the 1-sigma factor is the 68.27 % quantile
// of |e| / model sigma, the 3-sigma factor a third of the 99.73 % quantile,
// so each band holds its nominal share even when the errors are not Gaussian.
// Nothing at or after t enters t's factors, so the hindcast over [start,
// stop) tests bands that never saw what they are tested on.
namespace {

using Mat6 = std::array<double, 36>;  // row-major

constexpr size_t kMinCalibration = 20;
constexpr double kOneSigmaShare = 0.682689492137086;
constexpr double kThreeSigmaShare = 0.997300203936740;

double quantile(std::vector<double> x, double p) {
  if (x.empty()) return kNaN;
  std::sort(x.begin(), x.end());
  const size_t k = std::min(x.size() - 1, size_t(std::max(0.0, std::ceil(p * double(x.size())) - 1.0)));
  return x[k];
}

Mat6 fromLower21(const std::array<double, 21>& l) {
  Mat6 m{};
  for (int i = 0; i < 6; ++i)
    for (int j = 0; j <= i; ++j) m[size_t(6 * i + j)] = m[size_t(6 * j + i)] = l[size_t(i * (i + 1) / 2 + j)];
  return m;
}

// The model's covariance of a set at an age in the inertial axes of the basis
// B (rows R, T, N): T^T C T with T = blockdiag(B, B).
bool modelCovariance(const ErrorModel& model, const ElementSet& s, double ageDays, const Mat3& B, Mat6& out) {
  const Stratum* x = model.at(model.regimeOf(s.altitude, s.eccentricity), ageDays);
  if (!x) return false;
  const Mat6 c = fromLower21(x->lower);
  Mat6 t{};
  for (int blk = 0; blk < 2; ++blk)
    for (int i = 0; i < 3; ++i)
      for (int j = 0; j < 3; ++j) t[size_t(6 * (3 * blk + i) + 3 * blk + j)] = B[size_t(3 * i + j)];
  Mat6 ct{};
  for (int i = 0; i < 6; ++i)
    for (int j = 0; j < 6; ++j) {
      double v = 0;
      for (int k = 0; k < 6; ++k) v += c[size_t(6 * i + k)] * t[size_t(6 * k + j)];
      ct[size_t(6 * i + j)] = v;
    }
  for (int i = 0; i < 6; ++i)
    for (int j = 0; j < 6; ++j) {
      double v = 0;
      for (int k = 0; k < 6; ++k) v += t[size_t(6 * k + i)] * ct[size_t(6 * k + j)];
      out[size_t(6 * i + j)] = v;
    }
  return true;
}

// Curvilinear R, I, C of a pair of inertial states.
bool curvilinearOf(const State& c, const State& t, double out[3]) {
  const double rt[3] = {t[0], t[1], t[2]}, vt[3] = {t[3], t[4], t[5]};
  const double rc[3] = {c[0], c[1], c[2]}, vc[3] = {c[3], c[4], c[5]};
  double rel[6];
  return relativeStateRic(rt, vt, rc, vc, rel) && curvilinearFromRectilinear(norm(posOf(t)), rel, out);
}

// d(R, I, C)/d(state) of one object, the other held: central differences.
bool jacobianOf(const State& c, const State& t, bool ofTarget, double J[3][6]) {
  const double halfArc = kPi * norm(posOf(t));
  for (int k = 0; k < 6; ++k) {
    const double h = k < 3 ? 1e-3 : 1e-6;
    State cp = c, cm = c, tp = t, tm = t;
    (ofTarget ? tp : cp)[size_t(k)] += h;
    (ofTarget ? tm : cm)[size_t(k)] -= h;
    double op[3], om[3];
    if (!curvilinearOf(cp, tp, op) || !curvilinearOf(cm, tm, om)) return false;
    double d1 = op[1] - om[1];  // in-track wraps at +-pi r0
    if (d1 > halfArc) d1 -= 2 * halfArc;
    if (d1 < -halfArc) d1 += 2 * halfArc;
    J[0][k] = (op[0] - om[0]) / (2 * h);
    J[1][k] = d1 / (2 * h);
    J[2][k] = (op[2] - om[2]) / (2 * h);
  }
  return true;
}

// Adds one object's term, its set's covariance at t carried through the
// Jacobian at the states (sc, st), to the curvilinear covariance.
bool addObject(const ErrorModel& model, const ElementSet& set, const State& own, bool isTarget, const State& sc, const State& st,
               double t, Mat3& out) {
  Mat3 B;
  Mat6 C{};
  double J[3][6];
  if (!basisOf(own, B) || !modelCovariance(model, set, (t - set.epoch) / 86400.0, B, C) || !jacobianOf(sc, st, isTarget, J)) return false;
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) {
      double v = 0;
      for (int a = 0; a < 6; ++a)
        for (int b = 0; b < 6; ++b) v += J[i][a] * C[size_t(6 * a + b)] * J[j][b];
      out[size_t(3 * i + j)] += v;
    }
  return true;
}

// ── relative samples ───────────────────────────────────────────────────────
struct RelativeSample {
  double t0 = 0, tau = 0;
  double e[3] = {0, 0, 0};  // prediction minus truth, curvilinear R, I, C, km
  Mat3 cov{};               // the model's covariance of e
  bool chaser = false, target = false;  // whose set changed
};

struct RelativeSamples {
  std::vector<RelativeSample> list;  // by tau
  size_t skippedBracket = 0, skippedSettling = 0, outsideModel = 0;
};

RelativeSamples relativeSamples(const Object& chaser, const Object& target, const Window& w, const ErrorModel& model) {
  RelativeSamples r;
  if (!model.present || !(w.horizon > 0)) return r;
  const double from = w.calibration > 0 ? w.start - w.calibration : w.start;
  std::vector<double> starts{from};
  for (const Object* o : {&chaser, &target})
    for (const ElementSet& s : o->sets) if (s.epoch > from && s.epoch < w.stop) starts.push_back(s.epoch);
  std::sort(starts.begin(), starts.end());
  starts.erase(std::unique(starts.begin(), starts.end()), starts.end());
  for (double t0 : starts) {
    const int pc = chaser.active(t0), pt = target.active(t0);
    if (pc < 0 || pt < 0 || chaser.inBracket(t0) || target.inBracket(t0)) continue;
    std::vector<double> taus;
    for (const Object* o : {&chaser, &target})
      for (const ElementSet& s : o->sets)
        if (s.epoch > t0 && s.epoch <= std::min(t0 + w.horizon, w.stop)) taus.push_back(w.gridCeil(s.epoch));
    std::sort(taus.begin(), taus.end());
    taus.erase(std::unique(taus.begin(), taus.end()), taus.end());
    for (double tau : taus) {
      if (tau > std::min(t0 + w.horizon, w.stop) + 1e-6) continue;
      const int qc = chaser.active(tau), qt = target.active(tau);
      if (qc == pc && qt == pt) continue;
      if (chaser.bracketOverlaps(t0, tau) || target.bracketOverlaps(t0, tau)) { ++r.skippedBracket; continue; }
      const ElementSet &pcs = chaser.sets[size_t(pc)], &pts = target.sets[size_t(pt)];
      const ElementSet &qcs = chaser.sets[size_t(qc)], &qts = target.sets[size_t(qt)];
      if (chaser.settling(pcs.epoch, w.settle) || chaser.settling(qcs.epoch, w.settle) || target.settling(pts.epoch, w.settle) ||
          target.settling(qts.epoch, w.settle)) {
        ++r.skippedSettling;
        continue;
      }
      State a, b, c, d;
      Sample pred, truth;
      if (!stateOf(chaser, pc, tau, a) || !stateOf(target, pt, tau, b) || !stateOf(chaser, qc, tau, c) || !stateOf(target, qt, tau, d) ||
          !geometry(tau, a, b, pred) || !geometry(tau, c, d, truth))
        continue;
      RelativeSample s;
      s.t0 = t0;
      s.tau = tau;
      s.chaser = qc != pc;
      s.target = qt != pt;
      bool ok = true;
      if (s.chaser) ok = ok && addObject(model, pcs, a, false, a, b, tau, s.cov) && (model.setDifferences || addObject(model, qcs, c, false, c, d, tau, s.cov));
      if (s.target) ok = ok && addObject(model, pts, b, true, a, b, tau, s.cov) && (model.setDifferences || addObject(model, qts, d, true, c, d, tau, s.cov));
      if (!ok || !(s.cov[0] > 0 && s.cov[4] > 0 && s.cov[8] > 0)) { ++r.outsideModel; continue; }
      s.e[0] = pred.R - truth.R;
      s.e[1] = pred.I - truth.I;
      s.e[2] = pred.C - truth.C;
      const double half = kPi * pred.r0;
      if (s.e[1] > half) s.e[1] -= 2 * half;
      if (s.e[1] < -half) s.e[1] += 2 * half;
      r.list.push_back(s);
    }
  }
  std::stable_sort(r.list.begin(), r.list.end(), [](const RelativeSample& x, const RelativeSample& y) { return x.tau < y.tau; });
  return r;
}

// ── calibration ──────────────────────────────────────────────────────────────
struct Factors {
  bool fitted = false;
  size_t samples = 0;
  std::array<double, 3> one{1.0, 1.0, 1.0}, three{1.0, 1.0, 1.0};
};

Factors factorsAt(const RelativeSamples& r, double t, const Window& w) {
  Factors f;
  if (!(w.calibration > 0)) return f;
  std::vector<double> z[3];
  for (const RelativeSample& s : r.list) {
    if (s.tau < t - w.calibration) continue;
    if (s.tau >= t) break;
    for (int k = 0; k < 3; ++k) z[k].push_back(std::fabs(s.e[k]) / std::sqrt(s.cov[size_t(4 * k)]));
  }
  f.samples = z[0].size();
  if (f.samples < kMinCalibration) return f;
  f.fitted = true;
  for (int k = 0; k < 3; ++k) {
    f.one[size_t(k)] = quantile(z[k], kOneSigmaShare);
    f.three[size_t(k)] = quantile(z[k], kThreeSigmaShare) / 3.0;
  }
  return f;
}

Mat3 scaledBy(const Mat3& c, const std::array<double, 3>& f) {
  Mat3 out = c;
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) out[size_t(3 * i + j)] *= f[size_t(i)] * f[size_t(j)];
  return out;
}

// ── the conditional coast projection ────────────────────────────────────────
// From the newest set of each object at `stop`, held fixed for `horizon`: no
// maneuvers after stop. Refused when either newest set is still inside a
// maneuver bracket at stop (it would be propagated across the burn); flagged
// when either is a settling set (the calibration never covers one).
struct Projection {
  bool made = false;
  bool settling = false;
  std::string reason;
  Segment segment;
  Factors factors;
  int chaserRegime = -1, targetRegime = -1;
  size_t withoutCovariance = 0;
};

// The bands at one sample: 1-sigma and 3-sigma half-widths of R, I, C, the
// 1-sigma of separation, and the 1-sigma rectilinear covariance in the
// target's RTN (the curvilinear one carried back through the inverse of the
// curvilinear Jacobian).
bool bands(const ErrorModel& model, const ElementSet& cs, const ElementSet& ts, const State& sc, const State& st, double t,
           const Factors& f, Sample& s) {
  Mat3 curv{};
  if (!addObject(model, cs, sc, false, sc, st, t, curv) || !addObject(model, ts, st, true, sc, st, t, curv)) return false;
  const Mat3 one = scaledBy(curv, f.one);
  s.sR = std::sqrt(std::max(0.0, one[0]));
  s.sI = std::sqrt(std::max(0.0, one[4]));
  s.sC = std::sqrt(std::max(0.0, one[8]));
  s.b3R = 3.0 * f.three[0] * std::sqrt(std::max(0.0, curv[0]));
  s.b3I = 3.0 * f.three[1] * std::sqrt(std::max(0.0, curv[4]));
  s.b3C = 3.0 * f.three[2] * std::sqrt(std::max(0.0, curv[8]));
  double offset[3] = {s.rel[0], s.rel[1], s.rel[2]}, j[9];
  Mat3 J, Jinv;
  if (!curvilinearJacobian(s.r0, offset, j)) return false;
  for (int i = 0; i < 9; ++i) J[size_t(i)] = j[i];
  if (!invert(J, Jinv)) return false;
  s.covRel = sandwich(Jinv, one);
  s.hasCov = true;
  const Vec3 p{s.rel[0], s.rel[1], s.rel[2]};
  const double d = norm(p);
  if (d > 0) {
    double v = 0;
    for (int a = 0; a < 3; ++a)
      for (int b = 0; b < 3; ++b) v += p[size_t(a)] * s.covRel[size_t(3 * a + b)] * p[size_t(b)];
    s.sSep = std::sqrt(std::max(0.0, v)) / d;
  }
  return true;
}

Projection project(const Object& chaser, const Object& target, const Window& w, const ErrorModel& model, const RelativeSamples& rel) {
  Projection p;
  if (!(w.horizon > 0)) { p.reason = "no projection asked (projection_hours 0)"; return p; }
  const int ic = chaser.active(w.stop), it = target.active(w.stop);
  if (ic < 0 || it < 0) { p.reason = "an object has no element set at stop"; return p; }
  if (chaser.inBracket(w.stop) || target.inBracket(w.stop)) { p.reason = "a maneuver bracket is open at stop"; return p; }
  const ElementSet& cs = chaser.sets[size_t(ic)];
  const ElementSet& ts = target.sets[size_t(it)];
  p.segment.projection = true;
  p.segment.ic = ic;
  p.segment.it = it;
  p.settling = chaser.settling(cs.epoch, w.settle) || target.settling(ts.epoch, w.settle);
  p.factors = factorsAt(rel, w.stop, w);
  p.chaserRegime = model.present ? model.regimeOf(cs.altitude, cs.eccentricity) : -1;
  p.targetRegime = model.present ? model.regimeOf(ts.altitude, ts.eccentricity) : -1;
  for (double t = w.gridCeil(w.stop); t <= w.stop + w.horizon + 1e-6; t += w.step) {
    State sc, st;
    Sample s;
    if (!stateOf(chaser, ic, t, sc) || !stateOf(target, it, t, st) || !geometry(t, sc, st, s)) continue;
    s.ic = ic;
    s.it = it;
    if (model.present && !bands(model, cs, ts, sc, st, t, p.factors, s)) ++p.withoutCovariance;
    p.segment.samples.push_back(s);
  }
  unwrapInTrack(p.segment);
  p.made = p.segment.samples.size() >= 2;
  if (!p.made) p.reason = "the newest sets' trajectories do not reach past stop";
  return p;
}

// ── hindcast ─────────────────────────────────────────────────────────────────
// The relative samples with t0 in [start, stop), each against the bands the
// module would have drawn at t0 (factors from [t0 - W, t0)): inside the
// 1-sigma band per axis, inside the 3-sigma band per axis, and d2 = e^T C1^-1
// e (C1 the 1-sigma covariance) against chi2(3).
struct Hindcast {
  size_t samples = 0, unfitted = 0;
  // Samples that compare with the same later element sets are not independent:
  // the effective sample size is the number of distinct truth epochs.
  size_t truthEpochs = 0;
  size_t in1[3] = {0, 0, 0}, in3[3] = {0, 0, 0};
  double sumD2 = 0;
  size_t in95 = 0;
  bool chaserSeen = false, targetSeen = false;
  double first = kNaN, last = kNaN;
  double fraction1(int k) const { return samples ? double(in1[k]) / double(samples) : kNaN; }
  double fraction3(int k) const { return samples ? double(in3[k]) / double(samples) : kNaN; }
  double meanD2Over3() const { return samples ? sumD2 / double(samples) / 3.0 : kNaN; }
  double coverage95() const { return samples ? double(in95) / double(samples) : kNaN; }
  size_t objects() const { return size_t(chaserSeen) + size_t(targetSeen); }
  // The CVR rule: d2/3 in [0.8, 1.25] and 95 % coverage in [0.93, 0.97] from
  // at least 30 samples of at least 3 objects. One pair is two objects, so a
  // pair's hindcast alone never labels the covariance Calibrated.
  bool calibrated() const {
    const double mean = meanD2Over3(), cov95 = coverage95();
    return samples >= 30 && objects() >= 3 && mean >= 0.8 && mean <= 1.25 && cov95 >= 0.93 && cov95 <= 0.97;
  }
};

Hindcast hindcast(const RelativeSamples& rel, const Window& w) {
  Hindcast h;
  if (!w.hindcast) return h;
  constexpr double kChi2_3_95 = 7.814727903251178;
  double lastTau = kNaN;
  for (const RelativeSample& s : rel.list) {
    if (s.t0 < w.start) continue;
    const Factors f = factorsAt(rel, s.t0, w);
    if (w.calibration > 0 && !f.fitted) { ++h.unfitted; continue; }
    const Mat3 one = scaledBy(s.cov, f.one);
    Mat3 inv;
    if (!invert(one, inv)) continue;
    for (int k = 0; k < 3; ++k) {
      const double sigma = std::sqrt(one[size_t(4 * k)]), band3 = 3.0 * f.three[size_t(k)] * std::sqrt(s.cov[size_t(4 * k)]);
      if (std::fabs(s.e[k]) <= sigma) ++h.in1[k];
      if (std::fabs(s.e[k]) <= band3) ++h.in3[k];
    }
    double d2 = 0;
    for (int i = 0; i < 3; ++i)
      for (int j = 0; j < 3; ++j) d2 += s.e[i] * inv[size_t(3 * i + j)] * s.e[j];
    h.sumD2 += d2;
    if (d2 <= kChi2_3_95) ++h.in95;
    ++h.samples;
    if (s.tau != lastTau) ++h.truthEpochs;  // the list is by tau
    lastTau = s.tau;
    h.chaserSeen = h.chaserSeen || s.chaser;
    h.targetSeen = h.targetSeen || s.target;
    h.first = std::isfinite(h.first) ? std::min(h.first, s.t0) : s.t0;
    h.last = std::isfinite(h.last) ? std::max(h.last, s.tau) : s.tau;
  }
  return h;
}
}  // namespace
