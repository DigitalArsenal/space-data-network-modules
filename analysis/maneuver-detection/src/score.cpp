// analysis/maneuver-detection: score_detections, detected $MNV against truth
// $MNV.
//
// An event matches a truth maneuver of the same object when its
// EVENT_START_TIME lies in [truth start - before_s, truth end + after_s];
// pairs are taken one-to-one, nearest first. Truth delta-V is DELTA_VEL, or
// the integral of a piecewise-constant acceleration profile (MNVR_ACCEL_TIMES
// and MNVR_ACCELS, U V W per point, each held until the next time).
namespace {

struct ScoreOptions {
  double before = 21600.0, after = 129600.0;
  std::vector<double> bins = {0.05, 0.2, 1.0};
  struct Interval { std::string key; double from = 0, to = 0; };
  std::vector<Interval> explained, assessed, spans;
};

bool readIntervals(const Json& v, const char* what, std::vector<ScoreOptions::Interval>& out) {
  if (!v.is_array()) return failWith(std::string(what) + " must be an array of {object, from, to}.");
  for (const Json& x : v) {
    ScoreOptions::Interval i;
    if (!x.is_object() || !x.contains("object") || !x["object"].is_string() || !x.contains("from") || !x["from"].is_string() ||
        !x.contains("to") || !x["to"].is_string() || !parseIso(x["from"].get<std::string>().c_str(), i.from) ||
        !parseIso(x["to"].get<std::string>().c_str(), i.to) || i.to < i.from)
      return failWith(std::string(what) + " entries need object, from and to (ISO 8601 UTC, from <= to).");
    i.key = x["object"].get<std::string>();
    out.push_back(i);
  }
  return true;
}

bool readScoreOptions(const Json& j, ScoreOptions& o) {
  NEED(j.is_object(), "Options must be a JSON object.");
  for (auto it = j.begin(); it != j.end(); ++it) {
    const std::string& key = it.key();
    const Json& v = it.value();
    bool ok = true;
    if (key == "before_s") ok = readNumber(v, "before_s", 0, 1e8, o.before);
    else if (key == "after_s") ok = readNumber(v, "after_s", 0, 1e8, o.after);
    else if (key == "bins_mps") {
      NEED(v.is_array(), "bins_mps must be an array of increasing numbers.");
      o.bins.clear();
      for (const Json& b : v) { NEED(b.is_number() && std::isfinite(b.get<double>()), "bins_mps must be numbers."); o.bins.push_back(b.get<double>()); }
      for (size_t k = 1; k < o.bins.size(); ++k) NEED(o.bins[k] > o.bins[k - 1], "bins_mps must increase.");
    } else if (key == "explained") ok = readIntervals(v, "explained", o.explained);
    else if (key == "assessed") ok = readIntervals(v, "assessed", o.assessed);
    else if (key == "spans") ok = readIntervals(v, "spans", o.spans);
    else return failWith("Unknown option: " + key);
    if (!ok) return false;
  }
  return true;
}

struct Scored {
  std::string key, id, status;
  double start = 0, end = 0;
  double dv = 0, inTrack = 0, crossTrack = 0;  // m/s
};

bool scoredOf(const MNV* m, Scored& s, const char* what) {
  s.key = objectKey(m->SAT_NO(), m->ORIG_OBJECT_ID() ? m->ORIG_OBJECT_ID()->str() : "", "");
  if (s.key.empty()) return failWith(std::string("A ") + what + " $MNV names no object (SAT_NO or ORIG_OBJECT_ID).");
  s.id = m->ID() ? m->ID()->str() : "";
  s.status = EnumNamemaneuverStatus(m->STATUS());
  if (!parseIso(m->EVENT_START_TIME(), s.start)) return failWith(std::string("A ") + what + " $MNV has no valid EVENT_START_TIME.");
  if (!parseIso(m->EVENT_END_TIME(), s.end) || s.end < s.start) s.end = s.start;
  s.inTrack = m->DELTA_VEL_V() * 1000.0;
  s.crossTrack = m->DELTA_VEL_W() * 1000.0;
  s.dv = std::fabs(m->DELTA_VEL()) * 1000.0;
  const auto* times = m->MNVR_ACCEL_TIMES();
  const auto* accels = m->MNVR_ACCELS();
  if (s.dv == 0 && times && accels && times->size() >= 2 && accels->size() == 3 * times->size()) {
    Vec3 dv{0, 0, 0};
    double prev = 0;
    for (size_t i = 0; i < times->size(); ++i) {
      double t;
      if (!parseIso(times->Get(i), t) || (i > 0 && t < prev)) return failWith(std::string("A ") + what + " $MNV has unordered MNVR_ACCEL_TIMES.");
      if (i > 0) for (int c = 0; c < 3; ++c) dv[c] += accels->Get(3 * (i - 1) + c) * (t - prev);
      prev = t;
    }
    s.inTrack = dv[1] * 1000.0;
    s.crossTrack = dv[2] * 1000.0;
    s.dv = norm(dv) * 1000.0;
  }
  return true;
}

bool inIntervals(const std::vector<ScoreOptions::Interval>& list, const std::string& key, double t) {
  for (const auto& i : list) if (i.key == key && t >= i.from && t <= i.to) return true;
  return false;
}

Json distribution(std::vector<double> x) {
  if (x.empty()) return Json(nullptr);
  return {{"n", x.size()}, {"median", median(x)}, {"p10", quantile(x, 0.1)}, {"p90", quantile(x, 0.9)}};
}

void runScore(const std::vector<Scored>& events, const std::vector<Scored>& truth, const ScoreOptions& o, Json& report) {
  struct Candidate { size_t e, t; double distance; };
  std::vector<Candidate> candidates;
  for (size_t i = 0; i < events.size(); ++i)
    for (size_t k = 0; k < truth.size(); ++k) {
      if (events[i].key != truth[k].key) continue;
      const double t = events[i].start;
      if (t < truth[k].start - o.before || t > truth[k].end + o.after) continue;
      const double d = t < truth[k].start ? truth[k].start - t : t > truth[k].end ? t - truth[k].end : 0.0;
      candidates.push_back({i, k, d});
    }
  std::stable_sort(candidates.begin(), candidates.end(), [](const Candidate& a, const Candidate& b) {
    return a.distance != b.distance ? a.distance < b.distance : (a.t != b.t ? a.t < b.t : a.e < b.e);
  });
  std::vector<long> eventOf(truth.size(), -1), truthOf(events.size(), -1);
  for (const Candidate& c : candidates) {
    if (eventOf[c.t] >= 0 || truthOf[c.e] >= 0) continue;
    eventOf[c.t] = long(c.e);
    truthOf[c.e] = long(c.t);
  }
  Json matches = Json::array(), missed = Json::array(), unmatched = Json::array();
  std::vector<double> timeErrors, ratios, inTrackRatios;
  const size_t bins = o.bins.size() + 1;
  std::vector<size_t> binTruth(bins, 0), binHit(bins, 0);
  size_t hits = 0;
  for (size_t k = 0; k < truth.size(); ++k) {
    const Scored& tr = truth[k];
    size_t bin = 0;
    while (bin < o.bins.size() && tr.dv >= o.bins[bin]) ++bin;
    ++binTruth[bin];
    if (eventOf[k] < 0) {
      missed.push_back({{"object", tr.key}, {"id", tr.id}, {"time", isoMs(tr.start)}, {"dv_mps", tr.dv}, {"in_track_mps", tr.inTrack}});
      continue;
    }
    ++hits;
    ++binHit[bin];
    const Scored& ev = events[size_t(eventOf[k])];
    const double dt = ev.start - tr.start;
    timeErrors.push_back(std::fabs(dt));
    Json row = {{"object", tr.key}, {"id", tr.id}, {"time", isoMs(tr.start)}, {"dv_mps", tr.dv}, {"in_track_mps", tr.inTrack},
                {"event", ev.id}, {"event_time", isoMs(ev.start)}, {"time_error_s", dt}, {"event_dv_mps", ev.dv}, {"event_in_track_mps", ev.inTrack}};
    if (tr.dv > 0) { ratios.push_back(ev.dv / tr.dv); row["dv_ratio"] = ev.dv / tr.dv; }
    if (std::fabs(tr.inTrack) > 0) { inTrackRatios.push_back(ev.inTrack / tr.inTrack); row["in_track_ratio"] = ev.inTrack / tr.inTrack; }
    matches.push_back(row);
  }
  size_t falseAlarms = 0, explainedCount = 0;
  for (size_t i = 0; i < events.size(); ++i) {
    if (truthOf[i] >= 0) continue;
    const Scored& ev = events[i];
    const bool explained = inIntervals(o.explained, ev.key, ev.start);
    const bool assessed = o.assessed.empty() || inIntervals(o.assessed, ev.key, ev.start);
    if (explained) ++explainedCount;
    else if (assessed) ++falseAlarms;
    unmatched.push_back({{"object", ev.key}, {"id", ev.id}, {"time", isoMs(ev.start)}, {"dv_mps", ev.dv}, {"in_track_mps", ev.inTrack},
                         {"cross_track_mps", ev.crossTrack}, {"explained", explained}, {"assessed", assessed}});
  }
  double years = 0;
  for (const auto& s : o.spans) years += (s.to - s.from) / (365.25 * 86400.0);
  double lo, hi;
  wilson(hits, truth.size(), lo, hi);
  Json byBin = Json::array();
  for (size_t b = 0; b < bins; ++b) {
    double l, h;
    wilson(binHit[b], binTruth[b], l, h);
    byBin.push_back({{"from_mps", b == 0 ? 0.0 : o.bins[b - 1]}, {"to_mps", b < o.bins.size() ? Json(o.bins[b]) : Json(nullptr)},
                     {"truth", binTruth[b]}, {"detected", binHit[b]}, {"recall", binTruth[b] ? Json(double(binHit[b]) / double(binTruth[b])) : Json(nullptr)},
                     {"wilson95", binTruth[b] ? Json::array({l, h}) : Json(nullptr)}});
  }
  report["summary"] = {{"truth", truth.size()}, {"events", events.size()}, {"detected", hits},
                       {"recall", truth.empty() ? Json(nullptr) : Json(double(hits) / double(truth.size()))},
                       {"wilson95", truth.empty() ? Json(nullptr) : Json::array({lo, hi})}, {"by_dv", byBin},
                       {"time_error_abs_s", distribution(timeErrors)}, {"dv_ratio", distribution(ratios)},
                       {"in_track_ratio", distribution(inTrackRatios)}, {"unmatched_events", events.size() - hits},
                       {"explained", explainedCount}, {"false_alarms", falseAlarms}, {"object_years", years},
                       {"false_alarms_per_object_year", years > 0 ? Json(double(falseAlarms) / years) : Json(nullptr)}};
  report["matches"] = matches;
  report["missed"] = missed;
  report["unmatched"] = unmatched;
}
}  // namespace
