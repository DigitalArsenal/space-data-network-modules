#include "operator_fit.hpp"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cmath>
#include <limits>

#include "ephemeris_input.hpp"
#include "od/meme_parser.h"

namespace odhpop {

namespace {

double now_s() {
  return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

constexpr std::size_t kNone = std::numeric_limits<std::size_t>::max();

std::vector<Segment> split_segments(const Ephemeris& e, double gap_factor) {
  std::vector<Segment> out;
  const auto& s = e.samples;
  std::vector<double> steps;
  for (std::size_t i = 1; i < s.size(); ++i) steps.push_back(seconds_between(s[i - 1].t, s[i].t));
  std::vector<double> sorted = steps;
  std::nth_element(sorted.begin(), sorted.begin() + sorted.size() / 2, sorted.end());
  const double median = sorted.empty() ? 0.0 : sorted[sorted.size() / 2];
  Segment cur;
  std::size_t i = 1;
  while (i <= s.size()) {
    std::string why;
    bool event = false;
    if (i < s.size()) {
      if (s[i].segment != s[i - 1].segment) why = "operator-segment-boundary";
      else if (median > 0 && steps[i - 1] > gap_factor * median) why = "gap";
      else
        for (const auto& [te, text] : e.events)
          if (seconds_between(te, s[i].t) > 0 && seconds_between(te, s[i - 1].t) <= 0) why = "operator-event: " + text, event = true;
    }
    if (i < s.size() && why.empty()) {
      ++i;
      continue;
    }
    cur.end = i;
    if (i < s.size()) cur.evidence.push_back("ends: " + why);
    if (cur.end > cur.begin) out.push_back(cur);
    if (i >= s.size()) break;
    cur = Segment();
    cur.begin = i;
    if (event) {
      // The next segment starts after a 1800 s guard (E4-A5's rule).
      const UtcEpoch guard = add_seconds(s[i - 1].t, 1800.0);
      while (cur.begin < s.size() && seconds_between(guard, s[cur.begin].t) < 0) ++cur.begin;
    }
    cur.evidence.push_back("starts: " + why);
    i = cur.begin + 1;
  }
  if (out.empty()) out.push_back(Segment{0, s.size(), {}});
  return out;
}

// Points [begin, end) whose time from points[begin] is within span (0: all).
std::size_t span_end(const std::vector<Sample>& s, std::size_t begin, std::size_t end, double span_s) {
  if (span_s <= 0) return end;
  std::size_t i = begin;
  while (i < end && seconds_between(s[begin].t, s[i].t) <= span_s + 1e-6) ++i;
  return i;
}

std::vector<std::size_t> thin(std::size_t begin, std::size_t end, std::size_t maximum) {
  std::vector<std::size_t> pick;
  const std::size_t n = end - begin;
  const std::size_t m = std::min(n, std::max<std::size_t>(maximum, 4));
  for (std::size_t k = 0; k < m; ++k) {
    const std::size_t i = begin + (m == 1 ? 0 : static_cast<std::size_t>(std::llround(double(k) * double(n - 1) / double(m - 1))));
    if (pick.empty() || pick.back() != i) pick.push_back(i);
  }
  return pick;
}

// Velocity for a position-only sample from its neighbours (Lagrange, 3 points).
std::array<double, 3> velocity_from_positions(const std::vector<Sample>& s, std::size_t i, std::size_t begin,
                                              std::size_t end) {
  std::size_t a = i > begin ? i - 1 : i, c = i + 1 < end ? i + 1 : i;
  if (a == i) c = std::min(end - 1, i + 2), a = i, i = i + 1;
  const double ta = seconds_between(s[i].t, s[a].t), tc = seconds_between(s[i].t, s[c].t);
  std::array<double, 3> v{};
  for (int k = 0; k < 3; ++k) {
    // derivative at t=0 of the quadratic through (ta, xa), (0, xb), (tc, xc)
    const double xa = s[a].gcrf_m[k], xb = s[i].gcrf_m[k], xc = s[c].gcrf_m[k];
    v[k] = xa * tc / (ta * (ta - tc)) + xb * (-(ta + tc)) / (ta * tc) + xc * ta / (tc * (tc - ta));
  }
  return v;
}

od::EphemerisPoint teme_point(const Sample& s, const UtcEpoch& origin) {
  od::EphemerisPoint p{};
  p.epoch_jd = jd_single(s.t);
  p.timestamp_str = format_iso_utc(s.t, 6);
  p.x = s.teme_km[0];
  p.y = s.teme_km[1];
  p.z = s.teme_km[2];
  p.vx = s.teme_km[3];
  p.vy = s.teme_km[4];
  p.vz = s.teme_km[5];
  p.has_covariance = false;
  p.t_offset_s = seconds_between(origin, s.t);
  return p;
}

struct SgpFit {
  bool ok = false;
  od::SGP4Elements el;
  UtcEpoch epoch;
  std::size_t fit_points = 0;
};

SgpFit fit_sgp4_window(const std::vector<Sample>& s, std::size_t begin, std::size_t end, std::size_t maximum,
                       bool position_only) {
  SgpFit out;
  if (end - begin < 4) return out;
  std::vector<od::EphemerisPoint> pts;
  for (std::size_t i : thin(begin, end, maximum)) pts.push_back(teme_point(s[i], s[begin].t));
  od::FitterConfig cfg;
  cfg.position_only = position_only;
  od::FitResult r = od::fit_sgp4_exact(pts, cfg);
  if (!(r.rms_km < 1e5)) return out;
  out.ok = true;
  out.el = r.elements;
  out.epoch = s[begin].t;
  out.el.epoch_iso = format_iso_utc(out.epoch, 6);
  out.fit_points = pts.size();
  return out;
}

ResidualStats sgp_stats(const od::SGP4Elements& el, const UtcEpoch& epoch, const std::vector<Sample>& s,
                        std::size_t begin, std::size_t end, double max_rtn[3]) {
  std::vector<UtcEpoch> t;
  std::vector<std::array<double, 6>> truth, model;
  std::vector<bool> hv;
  for (std::size_t i = begin; i < end; ++i) {
    std::array<double, 6> m{};
    if (!sgp4_at(el, epoch, s[i].t, &m)) continue;
    t.push_back(s[i].t);
    truth.push_back(s[i].teme_km);
    model.push_back(m);
    hv.push_back(s[i].has_velocity);
  }
  ResidualStats st = residual_stats(t, truth, model, hv, false);
  if (max_rtn) {
    max_rtn[0] = max_rtn[1] = max_rtn[2] = 0;
    for (std::size_t i = 0; i < t.size(); ++i) {
      const auto& a = hv[i] ? truth[i] : model[i];
      const double r[3] = {a[0], a[1], a[2]}, v[3] = {a[3], a[4], a[5]};
      const double d[3] = {model[i][0] - truth[i][0], model[i][1] - truth[i][1], model[i][2] - truth[i][2]};
      const double rn = std::sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
      double h[3] = {r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]};
      const double hn = std::sqrt(h[0] * h[0] + h[1] * h[1] + h[2] * h[2]);
      const double R[3] = {r[0] / rn, r[1] / rn, r[2] / rn}, N[3] = {h[0] / hn, h[1] / hn, h[2] / hn};
      const double T[3] = {N[1] * R[2] - N[2] * R[1], N[2] * R[0] - N[0] * R[2], N[0] * R[1] - N[1] * R[0]};
      max_rtn[0] = std::max(max_rtn[0], std::abs(d[0] * R[0] + d[1] * R[1] + d[2] * R[2]));
      max_rtn[1] = std::max(max_rtn[1], std::abs(d[0] * T[0] + d[1] * T[1] + d[2] * T[2]));
      max_rtn[2] = std::max(max_rtn[2], std::abs(d[0] * N[0] + d[1] * N[1] + d[2] * N[2]));
    }
  }
  return st;
}

// RTN residual components (m) of model - truth, per point.
void rtn_components(const std::array<double, 6>& truth_m, const std::array<double, 6>& model_m, bool own,
                    double out[3]) {
  const auto& a = own ? truth_m : model_m;
  const double r[3] = {a[0], a[1], a[2]}, v[3] = {a[3], a[4], a[5]};
  const double d[3] = {model_m[0] - truth_m[0], model_m[1] - truth_m[1], model_m[2] - truth_m[2]};
  const double rn = std::sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
  double h[3] = {r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]};
  const double hn = std::sqrt(h[0] * h[0] + h[1] * h[1] + h[2] * h[2]);
  const double R[3] = {r[0] / rn, r[1] / rn, r[2] / rn}, N[3] = {h[0] / hn, h[1] / hn, h[2] / hn};
  const double T[3] = {N[1] * R[2] - N[2] * R[1], N[2] * R[0] - N[0] * R[2], N[0] * R[1] - N[1] * R[0]};
  out[0] = d[0] * R[0] + d[1] * R[1] + d[2] * R[2];
  out[1] = d[0] * T[0] + d[1] * T[1] + d[2] * T[2];
  out[2] = d[0] * N[0] + d[1] * N[1] + d[2] * N[2];
}

// E4-A5's residual-jump detector: the second difference over sample times of
// each RTN residual component (m/s^2); a sample beyond max(k * 1.4826 MAD,
// floor) starts a jump. Returns the first such sample, or kNone.
std::size_t residual_jump(const std::vector<UtcEpoch>& t, const std::vector<std::array<double, 3>>& e, double k,
                          double floor_m_s2, std::string* detail) {
  const std::size_t n = t.size();
  if (n < 5) return kNone;
  std::vector<std::array<double, 3>> d2(n, {0, 0, 0});
  for (std::size_t i = 1; i + 1 < n; ++i) {
    const double h0 = seconds_between(t[i - 1], t[i]), h1 = seconds_between(t[i], t[i + 1]);
    for (int c = 0; c < 3; ++c)
      d2[i][c] = 2.0 * ((e[i + 1][c] - e[i][c]) / h1 - (e[i][c] - e[i - 1][c]) / h0) / (h0 + h1);
  }
  double thr[3];
  for (int c = 0; c < 3; ++c) {
    std::vector<double> v;
    for (std::size_t i = 1; i + 1 < n; ++i) v.push_back(d2[i][c]);
    std::vector<double> w = v;
    std::nth_element(w.begin(), w.begin() + w.size() / 2, w.end());
    const double med = w[w.size() / 2];
    for (auto& x : w) x = std::abs(x - med);
    std::nth_element(w.begin(), w.begin() + w.size() / 2, w.end());
    thr[c] = std::max(k * 1.4826 * w[w.size() / 2], floor_m_s2);
  }
  for (std::size_t i = 1; i + 1 < n; ++i)
    for (int c = 0; c < 3; ++c)
      if (std::abs(d2[i][c]) > thr[c]) {
        if (detail) {
          char buf[160];
          std::snprintf(buf, sizeof buf, "residual-jump %c %.3e m/s2 > %.3e at %s", "RTN"[c], d2[i][c], thr[c],
                        format_iso_utc(t[i], 3).c_str());
          *detail = buf;
        }
        return i;
      }
  return kNone;
}

struct HpopRun {
  bool ok = false;
  std::string error;
  FitResult fit;
  ResidualStats stats;
  std::vector<UtcEpoch> t;
  std::vector<std::array<double, 3>> rtn;  // m
  double max_rtn_km[3] = {0, 0, 0};
  double t_fit_s = 0, t_exact_s = 0;
};

HpopRun hpop_fit_range(const std::vector<Sample>& s, std::size_t begin, std::size_t end, const Environment& env,
                       const OperatorFitOptions& o, const std::vector<ParamValue>* warm = nullptr) {
  HpopRun out;
  if (end - begin < 4) {
    out.error = "fit-failed: fewer than four points";
    return out;
  }
  std::vector<Point> pts;
  for (std::size_t i = begin; i < end; ++i) {
    Point p;
    p.t = s[i].t;
    for (int k = 0; k < 3; ++k) p.r[k] = s[i].gcrf_m[k], p.v[k] = s[i].gcrf_m[3 + k];
    p.has_velocity = s[i].has_velocity;
    pts.push_back(p);
  }
  Solution guess;
  guess.epoch = s[begin].t;
  guess.forces = o.forces;
  for (int k = 0; k < 3; ++k) guess.state[k] = s[begin].gcrf_m[k];
  std::array<double, 3> v{s[begin].gcrf_m[3], s[begin].gcrf_m[4], s[begin].gcrf_m[5]};
  if (!s[begin].has_velocity) v = velocity_from_positions(s, begin, begin, end);
  for (int k = 0; k < 3; ++k) guess.state[3 + k] = v[k];
  guess.params = default_parameters(guess.state, seconds_between(s[begin].t, s[end - 1].t), &guess.forces);
  for (auto& q : guess.params)
    for (const auto& [name, value] : o.initial_parameters)
      if (name == param_name(q.id) && std::isfinite(value)) {
        q.value = value;
        if (std::isfinite(q.lower) && q.value < q.lower) q.value = q.lower;
      }
  // A starting point only: the half fit converges on its own data.
  if (warm)
    for (auto& q : guess.params)
      for (const auto& w : *warm)
        if (w.id == q.id) q.value = std::isfinite(q.lower) ? std::max(q.lower, w.value) : w.value;
  Integration integ;
  FitOptions fo;
  fo.maximum_fit_points = o.maximum_fit_points;
  const double t0 = now_s();
  out.fit = fit(pts, guess, env, integ, fo);
  out.t_fit_s = now_s() - t0;
  if (!out.fit.ok) {
    out.error = out.fit.error;
    return out;
  }
  // Exact statistics: every point of the range.
  std::vector<std::array<double, 6>> model, truth;
  std::vector<bool> hv;
  for (std::size_t i = begin; i < end; ++i) {
    out.t.push_back(s[i].t);
    truth.push_back(s[i].gcrf_m);
    hv.push_back(s[i].has_velocity);
  }
  std::string error;
  if (!predict(out.fit.solution, env, integ, out.t, &model, &error)) {
    out.error = error;
    return out;
  }
  out.stats = residual_stats(out.t, truth, model, hv, true);
  out.t_exact_s = now_s() - t0 - out.t_fit_s;
  for (std::size_t i = 0; i < out.t.size(); ++i) {
    double c[3];
    rtn_components(truth[i], model[i], hv[i], c);
    out.rtn.push_back({c[0], c[1], c[2]});
    for (int k = 0; k < 3; ++k) out.max_rtn_km[k] = std::max(out.max_rtn_km[k], std::abs(c[k]) * 1e-3);
  }
  out.ok = true;
  return out;
}

}  // namespace

bool sgp4_at(const od::SGP4Elements& el, const UtcEpoch& epoch, const UtcEpoch& t, std::array<double, 6>* out) {
  double r[3], v[3];
  if (!od::propagate_sgp4(el, seconds_between(epoch, t) / 60.0, r, v)) return false;
  *out = {r[0], r[1], r[2], v[0], v[1], v[2]};
  return true;
}

OperatorFitResult fit_operator_ephemeris(const uint8_t* bytes, std::size_t size, const Reference& reference,
                                         const Environment& env, const OperatorFitOptions& o) {
  OperatorFitResult res;
  res.raw_sha256 = sha256_hex(bytes, size);
  res.raw_bytes = size;
  auto failed = [&](const std::string& code, const std::string& message) {
    res.ok = false;
    res.failure_code = code;
    res.failure_message = message;
    return res;
  };
  double mark = now_s();
  EarthOrientation eop;
  if (env.earth_orientation_size) {
    const std::string why = eop.load(env.earth_orientation, env.earth_orientation_size);
    if (!why.empty()) return failed("invalid-earth-orientation", why);
  }
  ObjectSelector select;
  select.norad_cat_id = o.norad_cat_id;
  select.object_name = o.object_name;
  select.object_id = o.object_id;
  ReadResult rr = read_ephemeris(bytes, size, o.input_format, &eop, select);
  if (!rr.ok) return failed(rr.error_code, rr.error_message);
  Ephemeris& e = rr.ephemeris;
  res.format = e.format;
  res.source_frame = e.source_frame;
  res.time_system = e.time_system;
  res.object_name = !o.object_name.empty() ? o.object_name : e.object_name;
  res.object_id = !o.object_id.empty() ? o.object_id : e.object_id;
  res.norad_cat_id = o.norad_cat_id > 0 ? o.norad_cat_id : e.norad_cat_id;
  res.samples = e.samples.size();
  res.first = e.samples.front().t;
  res.last = e.samples.back().t;
  res.segments = split_segments(e, o.gap_factor);
  res.t_read_s = now_s() - mark;
  mark = now_s();
  const auto& s = e.samples;

  // ---- SGP4 OMM over its window -------------------------------------------
  {
    SgpResult& g = res.sgp4;
    UtcEpoch anchor = s.front().t;
    if (o.omm_anchor == "reference") {
      if (!reference.present) return failed("missing-reference", "omm_anchor reference needs a reference OMM");
      anchor = reference.epoch;
    }
    const UtcEpoch from = add_seconds(anchor, o.omm_start_s);
    std::size_t begin = 0;
    while (begin < s.size() && seconds_between(from, s[begin].t) < -1e-6) ++begin;
    const std::size_t end = span_end(s, begin, s.size(), o.omm_span_s);
    if (end - begin < 4) return failed("empty-window", "fewer than four points in the OMM window");
    SgpFit f = fit_sgp4_window(s, begin, end, o.maximum_fit_points, e.position_only);
    if (!f.ok) return failed("sgp4-fit-failed", "SGP4 least squares did not produce elements");
    g.elements = f.el;
    g.epoch = f.epoch;
    g.fit_points = f.fit_points;
    g.elements.norad_cat_id = res.norad_cat_id > 0 ? res.norad_cat_id : g.elements.norad_cat_id;
    if (!res.object_name.empty()) g.elements.object_name = res.object_name;
    if (!res.object_id.empty()) g.elements.object_id = res.object_id;
    g.elements.data_source = o.data_source;
    g.stats = sgp_stats(g.elements, g.epoch, s, begin, end, nullptr);
    g.elements.rms_km = g.stats.rms_3d_km;
    if (reference.present) {
      g.has_reference = true;
      g.reference = sgp_stats(reference.elements, reference.epoch, s, begin, end, nullptr);
      g.reference_gate_pass = g.reference.n == g.stats.n && g.reference.rms_3d_km <= o.reference_rms_max_km;
    }
    if (o.closure) {
      ClosureResult& c = g.closure;
      c.split = add_seconds(s[begin].t, 0.5 * seconds_between(s[begin].t, s[end - 1].t));
      std::size_t mid = begin;
      while (mid < end && seconds_between(c.split, s[mid].t) <= 0) ++mid;
      SgpFit h = fit_sgp4_window(s, begin, mid, o.maximum_fit_points, e.position_only);
      if (h.ok && mid < end) {
        c.first_half = sgp_stats(h.el, h.epoch, s, begin, mid, nullptr);
        double mx[3];
        c.second_half = sgp_stats(h.el, h.epoch, s, mid, end, mx);
        c.max_r_km = mx[0], c.max_t_km = mx[1], c.max_n_km = mx[2];
        c.done = true;
      } else {
        c.error = "half fit failed";
      }
    }
    g.ok = true;
    res.t_sgp4_s = now_s() - mark;
  }

  // ---- HPOP over the first maneuver-free segment ----------------------------
  if (o.hpop) {
    HpopResult& hp = res.hpop;
    const Segment& seg0 = res.segments.front();
    std::size_t begin = seg0.begin;
    double span_s = o.hpop_span_s;
    if (o.hpop_span_orbits > 0) {
      const auto& x = s[begin].gcrf_m;
      const double r = std::sqrt(x[0] * x[0] + x[1] * x[1] + x[2] * x[2]);
      const double a = 1.0 / (2.0 / r - (x[3] * x[3] + x[4] * x[4] + x[5] * x[5]) / 3.986004415e14);
      span_s = a > 0 ? o.hpop_span_orbits * 2.0 * M_PI * std::sqrt(a * a * a / 3.986004415e14) : o.hpop_span_s;
    }
    std::size_t end = span_end(s, begin, seg0.end, span_s);
    hp.segment.begin = begin;
    hp.segment.evidence = seg0.evidence;
    if (span_s > 0 && end < seg0.end) hp.segment.evidence.push_back("ends: hpop span limit");
    HpopRun run;
    for (int attempt = 0; attempt < 4; ++attempt) {
      run = hpop_fit_range(s, begin, end, env, o);
      if (!run.ok) return failed("hpop-fit-failed", run.error);
      std::string detail;
      // A solution that matches every point to within jump_min_residual_m
      // leaves no room for an unmodelled maneuver; below it the second
      // differences are integration noise (mm at 10 s sampling is 1e-5 m/s^2).
      if (run.stats.max_3d_km * 1e3 < o.jump_min_residual_m) {
        char buf[120];
        std::snprintf(buf, sizeof buf, "maneuver-free: every residual below %.3g m (max %.3g m)", o.jump_min_residual_m,
                      run.stats.max_3d_km * 1e3);
        hp.segment.evidence.push_back(buf);
        break;
      }
      const std::size_t j = residual_jump(run.t, run.rtn, o.jump_k, o.jump_floor_m_s2, &detail);
      if (j == kNone) {
        hp.segment.evidence.push_back("maneuver-free: no residual jump (k=" + std::to_string(o.jump_k) + ")");
        break;
      }
      hp.segment.evidence.push_back("cut: " + detail);
      if (j < 8) return failed("maneuver-at-start", detail);
      end = begin + j - 1;
    }
    hp.segment.end = end;
    res.t_hpop_fit_s = run.t_fit_s;
    res.t_hpop_exact_s = run.t_exact_s;
    mark = now_s();
    hp.fit = run.fit;
    hp.stats = run.stats;
    // Convergence is recorded (iterations, criterion, flag), not gated: the
    // exact statistics below are the measure of the solution.
    if (!(run.stats.rms_3d_km <= o.hpop_rms_max_km)) return failed("hpop-rms-gate", "HPOP RMS above the gate");
    if (o.closure) {
      ClosureResult& c = hp.closure;
      c.split = add_seconds(s[begin].t, 0.5 * seconds_between(s[begin].t, s[end - 1].t));
      std::size_t mid = begin;
      while (mid < end && seconds_between(c.split, s[mid].t) <= 0) ++mid;
      HpopRun half = hpop_fit_range(s, begin, mid, env, o, &run.fit.solution.params);
      if (half.ok && mid < end) {
        c.first_half = half.stats;
        c.iterations = half.fit.iterations;
        c.stage_iterations = half.fit.stage_iterations;
        c.converged = half.fit.converged;
        std::vector<UtcEpoch> t2, through;
        std::vector<std::array<double, 6>> truth, model, all;
        std::vector<bool> hv;
        for (std::size_t i = mid; i < end; ++i) t2.push_back(s[i].t), truth.push_back(s[i].gcrf_m), hv.push_back(s[i].has_velocity);
        // The prediction passes through every ephemeris epoch from the
        // start, as the fit's own propagation did (HPOP restarts at each),
        // and is scored on the second half.
        for (std::size_t i = begin; i < end; ++i) through.push_back(s[i].t);
        std::string error;
        if (predict(half.fit.solution, env, Integration(), through, &all, &error)) {
          model.assign(all.begin() + (mid - begin), all.end());
          c.second_half = residual_stats(t2, truth, model, hv, true);
          for (std::size_t i = 0; i < t2.size(); ++i) {
            double d[3];
            rtn_components(truth[i], model[i], hv[i], d);
            c.max_r_km = std::max(c.max_r_km, std::abs(d[0]) * 1e-3);
            c.max_t_km = std::max(c.max_t_km, std::abs(d[1]) * 1e-3);
            c.max_n_km = std::max(c.max_n_km, std::abs(d[2]) * 1e-3);
          }
          c.done = true;
        } else {
          c.error = error;
        }
      } else {
        c.error = half.ok ? "no second half" : half.error;
      }
    }
    res.t_closure_s = now_s() - mark;
    hp.ok = true;
  }

  if (res.sgp4.has_reference && !res.sgp4.reference_gate_pass)
    return failed("reference-rms-gate", "the reference OMM scores above the gate on our states (frame error?)");
  res.ok = true;
  return res;
}

}  // namespace odhpop
