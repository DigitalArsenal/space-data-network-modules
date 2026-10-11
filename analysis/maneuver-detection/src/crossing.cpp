// analysis/maneuver-detection: D1, the crossing detector (tier 1).
//
// For each pair of consecutive trajectories the crossing time t* is where they
// are closest over their common span. An impulsive burn keeps position
// continuous, so t* estimates the burn time, and the two states at t* differ
// by the burn: the energy change gives the in-track delta-V (dv_T =
// v da / (2a)), the turn of the orbit normal the cross-track delta-V
// (dh_hat = -(dv_N / v) T_hat). Both are compared at one instant and one
// position, so each propagator's periodic terms cancel.
//
// Detection is a step test on the cumulative per-set level of each quantity:
// the median of the next `median_sets` levels minus the median of the previous
// ones, against k robust scales (1.4826 MAD over +-`scale_window_pairs`) and an
// absolute floor. Each run of candidates is one event at its largest jump.
namespace {

struct Options {
  // D1
  double k = 8.0;
  double floorInTrack = 0.08;      // m/s
  double floorCrossTrack = 1.0;    // m/s
  int medianSets = 3;
  int scaleWindow = 100;
  double gridStep = 60.0;          // s
  // query port
  int neighbours = 2;
  std::string propagatorPort;
  // D2 (frozen on the ISS tuning window, PLAN-2026-10 amendment A6)
  int glrSets = 8;                 // W, sets per side
  double glrSpanDays = 3.0;        // per side
  double glrH = 10.0;              // threshold on sqrt(Lambda)
  double glrFloorInTrack = 0.04;   // m/s
  double glrFloorPlane = 4e-4;     // rad, plane-change angle (v x angle in m/s)
  // D3 (frozen, A6)
  double ltH = 6.0;
  double ltFloor = 0.05;           // m/s per day
  double ltSpanDays = 5.0;
  int ltSets = 20;
  // output
  bool d1 = true, d2 = false, d3 = false;   // the default stays D1 until the held-out test decides (PLAN-2026-10 R1)
  double mergeHours = 12.0;
  bool reportPairs = true, reportLevels = false;
  std::string reportTime;
};

bool readDetectors(const Json& v, Options& o) {
  NEED(v.is_array() && !v.empty(), "detectors must be a non-empty array of D1, D2 and D3.");
  o.d1 = o.d2 = o.d3 = false;
  for (const Json& d : v) {
    NEED(d.is_string(), "detectors must name D1, D2 or D3.");
    const std::string s = d.get<std::string>();
    if (s == "D1") o.d1 = true;
    else if (s == "D2") o.d2 = true;
    else if (s == "D3") o.d3 = true;
    else return failWith("Unknown detector: " + s + " (D1, D2 or D3).");
  }
  return true;
}

bool readOptions(const Json& j, Options& o) {
  NEED(j.is_object(), "Options must be a JSON object.");
  for (auto it = j.begin(); it != j.end(); ++it) {
    const std::string& key = it.key();
    const Json& v = it.value();
    const char* k = key.c_str();
    bool ok = true;
    if (key == "report_time") {
      double t;
      NEED(v.is_string() && parseIso(v.get<std::string>().c_str(), t), "report_time must be an ISO 8601 UTC timestamp.");
      o.reportTime = isoMs(t);
    } else if (key == "propagator_port_id") {
      NEED(v.is_string(), "propagator_port_id must be a string.");
      o.propagatorPort = v.get<std::string>();
    } else if (key == "detectors") ok = readDetectors(v, o);
    else if (key == "report_pairs") { NEED(v.is_boolean(), "report_pairs must be true or false."); o.reportPairs = v.get<bool>(); }
    else if (key == "report_levels") { NEED(v.is_boolean(), "report_levels must be true or false."); o.reportLevels = v.get<bool>(); }
    else if (key == "k") ok = readNumber(v, k, 1e-6, 1e6, o.k);
    else if (key == "floor_in_track_mps") ok = readNumber(v, k, 0, 1e4, o.floorInTrack);
    else if (key == "floor_cross_track_mps") ok = readNumber(v, k, 0, 1e4, o.floorCrossTrack);
    else if (key == "median_sets") ok = readInteger(v, k, 1, 50, o.medianSets);
    else if (key == "scale_window_pairs") ok = readInteger(v, k, 5, 100000, o.scaleWindow);
    else if (key == "grid_step_s") ok = readNumber(v, k, 1, 3600, o.gridStep);
    else if (key == "neighbour_sets") ok = readInteger(v, k, 1, 10, o.neighbours);
    else if (key == "glr_sets") ok = readInteger(v, k, 3, 50, o.glrSets);
    else if (key == "glr_span_days") ok = readNumber(v, k, 0.1, 60, o.glrSpanDays);
    else if (key == "glr_h") ok = readNumber(v, k, 1, 100, o.glrH);
    else if (key == "glr_floor_in_track_mps") ok = readNumber(v, k, 0, 1e4, o.glrFloorInTrack);
    else if (key == "glr_floor_plane_rad") ok = readNumber(v, k, 0, 1, o.glrFloorPlane);
    else if (key == "lt_h") ok = readNumber(v, k, 1, 100, o.ltH);
    else if (key == "lt_floor_mps_per_day") ok = readNumber(v, k, 0, 1e4, o.ltFloor);
    else if (key == "lt_span_days") ok = readNumber(v, k, 0.5, 60, o.ltSpanDays);
    else if (key == "lt_sets") ok = readInteger(v, k, 4, 200, o.ltSets);
    else if (key == "merge_hours") ok = readNumber(v, k, 0, 240, o.mergeHours);
    else return failWith("Unknown option: " + key);
    if (!ok) return false;
  }
  return true;
}

// ── one pair of trajectories ────────────────────────────────────────────────
struct Pair {
  double lo = 0, hi = 0, t = 0, dmin = 0;
  bool edge = false;
  Vec3 r0{}, v0{}, r1{}, v1{};
  double speed = 0, sma = 0, da = 0, qT = 0;   // qT: in-track delta-V, m/s
  Vec3 qH{};                                   // v * (h_hat1 - h_hat0), m/s, inertial
};

double separation(const Block& a, const Block& b, double t) {
  Vec3 p0, v0, p1, v1;
  sample(a, t, p0, v0);
  sample(b, t, p1, v1);
  return norm(sub(p1, p0));
}

// The crossing of two trajectories over their common span (grid, then
// golden section). Fails when the spans do not overlap.
bool analysePair(const Block& a, const Block& b, double step, Pair& p) {
  p.lo = std::max(a.start(), b.start());
  p.hi = std::min(a.stop(), b.stop());
  NEED(p.hi > p.lo, "Consecutive blocks of one object do not overlap; each block must span its neighbours' epochs.");
  const size_t n = std::max<size_t>(2, size_t(std::ceil((p.hi - p.lo) / step)) + 1);
  const double h = (p.hi - p.lo) / double(n - 1);
  size_t best = 0;
  double bestD = std::numeric_limits<double>::infinity();
  for (size_t k = 0; k < n; ++k) {
    const double d = separation(a, b, p.lo + h * double(k));
    if (d < bestD) { bestD = d; best = k; }
  }
  double lo = p.lo + h * double(best == 0 ? 0 : best - 1);
  double hi = p.lo + h * double(std::min(best + 1, n - 1));
  const double g = 0.5 * (std::sqrt(5.0) - 1.0);
  double x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo);
  double f1 = separation(a, b, x1), f2 = separation(a, b, x2);
  while (hi - lo > 1e-3) {
    if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = separation(a, b, x1); }
    else { lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = separation(a, b, x2); }
  }
  p.t = 0.5 * (lo + hi);
  if (separation(a, b, p.lo + h * double(best)) < separation(a, b, p.t)) p.t = p.lo + h * double(best);
  p.edge = best == 0 || best == n - 1;
  sample(a, p.t, p.r0, p.v0);
  sample(b, p.t, p.r1, p.v1);
  p.dmin = norm(sub(p.r1, p.r0));
  const double a0 = smaOf(p.r0, p.v0), a1 = smaOf(p.r1, p.v1);
  NEED(a0 > 0 && a1 > 0, "A state is not on a bound orbit.");
  p.sma = a0;
  p.speed = norm(p.v0);
  p.da = a1 - a0;
  p.qT = p.speed * p.da / (2.0 * a0) * 1000.0;
  const Vec3 h0 = unit(cross(p.r0, p.v0)), h1 = unit(cross(p.r1, p.v1));
  p.qH = scale(sub(h1, h0), p.speed * 1000.0);
  return true;
}

// Cross-track delta-V of a normal change qH at the burn point r, v: an
// out-of-plane burn turns the normal about r, dh_hat = -(dv_N / v) T_hat.
double crossTrackOf(const Vec3& qH, const Vec3& r, const Vec3& v) {
  const Vec3 rHat = unit(r), hHat = unit(cross(r, v)), tHat = cross(hHat, rHat);
  return -dot(qH, tHat);
}

// ── events, shared by every detector ───────────────────────────────────────
struct Event {
  std::string detector;           // D1, D2, D3, or C when merged
  double time = 0, endTime = 0;
  bool crossing = false;          // time from a crossing of two trajectories
  bool inTrackFired = false, crossTrackFired = false;
  double inTrack = 0, crossTrack = 0;        // m/s, reported (0 unless fired)
  double rawInTrack = 0, rawCrossTrack = 0;  // m/s
  double deltaSma = 0;                       // km
  double accel = 0;                          // D3: along-track acceleration change, m/s^2
  Vec3 r0{}, v0{}, r1{}, v1{};
  double separation = 0;                     // km
  size_t before = 0, after = 0;              // block indices
  Json evidence = Json::object();
};

// ── D1 ────────────────────────────────────────────────────────────────────────
struct TierOne {
  std::vector<Pair> pairs;
  std::vector<double> levelT;      // per block (cumulative qT)
  std::vector<Vec3> levelH;        // per block (cumulative qH)
  std::vector<double> stepT, stepH, thT, thH;
  std::vector<char> candidate;
  std::vector<Event> events;
  bool screened = false;
};

bool runPairs(const std::vector<Block>& blocks, const Options& o, const std::string& key, TierOne& d) {
  const size_t n = blocks.size() >= 2 ? blocks.size() - 1 : 0;
  d.pairs.assign(n, Pair{});
  for (size_t i = 0; i < n; ++i)
    if (!analysePair(blocks[i], blocks[i + 1], o.gridStep, d.pairs[i]))
      return failWith(std::string(error) + " (object " + key + ", blocks " + std::to_string(i) + " and " + std::to_string(i + 1) + ")");
  d.levelT.assign(n + 1, 0.0);
  d.levelH.assign(n + 1, Vec3{0, 0, 0});
  for (size_t j = 0; j < n; ++j) {
    d.levelT[j + 1] = d.levelT[j] + d.pairs[j].qT;
    for (int c = 0; c < 3; ++c) d.levelH[j + 1][c] = d.levelH[j][c] + d.pairs[j].qH[c];
  }
  return true;
}

void runTierOne(const std::vector<Block>& blocks, const Options& o, TierOne& d) {
  const size_t n = d.pairs.size();
  if (n < size_t(2 * o.medianSets)) return;
  d.screened = true;
  const size_t w = size_t(o.medianSets);
  d.stepT.assign(n, 0); d.stepH.assign(n, 0);
  for (size_t i = 0; i < n; ++i) {
    const size_t preLo = i + 1 >= w ? i + 1 - w : 0, postHi = std::min(n + 1, i + 1 + w);
    std::vector<double> pre(d.levelT.begin() + preLo, d.levelT.begin() + i + 1), post(d.levelT.begin() + i + 1, d.levelT.begin() + postHi);
    d.stepT[i] = median(post) - median(pre);
    Vec3 stepHv{};
    for (int c = 0; c < 3; ++c) {
      std::vector<double> a, b;
      for (size_t j = preLo; j <= i; ++j) a.push_back(d.levelH[j][c]);
      for (size_t j = i + 1; j < postHi; ++j) b.push_back(d.levelH[j][c]);
      stepHv[c] = median(b) - median(a);
    }
    d.stepH[i] = norm(stepHv);
  }
  d.candidate.assign(n, 0); d.thT.assign(n, 0); d.thH.assign(n, 0);
  for (size_t i = 0; i < n; ++i) {
    double m, s;
    robust(d.stepT, i, o.scaleWindow, m, s);
    d.thT[i] = std::max(o.k * s, o.floorInTrack);
    robust(d.stepH, i, o.scaleWindow, m, s);
    d.thH[i] = std::max(m + o.k * s, o.floorCrossTrack);
    d.candidate[i] = std::fabs(d.stepT[i]) > d.thT[i] || d.stepH[i] > d.thH[i];
  }
  size_t lastPair = std::numeric_limits<size_t>::max();
  for (size_t i = 0; i < n;) {
    if (!d.candidate[i]) { ++i; continue; }
    size_t j = i;
    while (j + 1 < n && d.candidate[j + 1]) ++j;
    // The event's pair: the largest single-pair jump relative to its own
    // thresholds, within the run widened by the median span.
    const size_t lo = i + 1 >= w ? i + 1 - w : 0, hi = std::min(n - 1, j + w - 1);
    size_t best = lo;
    double bestScore = -1;
    for (size_t m = lo; m <= hi; ++m) {
      const double score = std::max(std::fabs(d.pairs[m].qT) / d.thT[m], norm(d.pairs[m].qH) / d.thH[m]);
      if (score > bestScore) { bestScore = score; best = m; }
    }
    bool firedT = false, firedH = false;
    for (size_t m = i; m <= j; ++m) {
      firedT = firedT || std::fabs(d.stepT[m]) > d.thT[m];
      firedH = firedH || d.stepH[m] > d.thH[m];
    }
    if (best != lastPair) {
      const Pair& p = d.pairs[best];
      Event e;
      e.detector = "D1";
      e.time = e.endTime = p.t;
      e.crossing = true;
      e.inTrackFired = firedT;
      e.crossTrackFired = firedH;
      e.rawInTrack = p.qT;
      e.rawCrossTrack = crossTrackOf(p.qH, p.r0, p.v0);
      e.inTrack = firedT ? e.rawInTrack : 0.0;
      e.crossTrack = firedH ? e.rawCrossTrack : 0.0;
      e.deltaSma = p.da;
      e.r0 = p.r0; e.v0 = p.v0; e.r1 = p.r1; e.v1 = p.v1;
      e.separation = p.dmin;
      e.before = best;
      e.after = best + 1;
      e.evidence = {{"pair", best}, {"step_in_track_mps", d.stepT[best]}, {"step_plane_mps", d.stepH[best]},
                    {"threshold_in_track_mps", d.thT[best]}, {"threshold_plane_mps", d.thH[best]},
                    {"crossing_at_edge", p.edge}, {"span", {isoMs(p.lo), isoMs(p.hi)}}};
      d.events.push_back(e);
      lastPair = best;
    }
    i = j + 1;
  }
  (void)blocks;
}

Json pairsJson(const TierOne& d) {
  Json out = Json::array();
  for (size_t i = 0; i < d.pairs.size(); ++i) {
    const Pair& p = d.pairs[i];
    Json row = {{"span", {isoMs(p.lo), isoMs(p.hi)}}, {"crossing", isoMs(p.t)}, {"crossing_at_edge", p.edge},
                {"separation_km", p.dmin}, {"delta_sma_km", p.da}, {"in_track_mps", p.qT}, {"plane_mps", norm(p.qH)}};
    if (d.screened) {
      row["step_in_track_mps"] = d.stepT[i];
      row["step_plane_mps"] = d.stepH[i];
      row["threshold_in_track_mps"] = d.thT[i];
      row["threshold_plane_mps"] = d.thH[i];
      row["candidate"] = bool(d.candidate[i]);
    }
    out.push_back(row);
  }
  return out;
}
}  // namespace
