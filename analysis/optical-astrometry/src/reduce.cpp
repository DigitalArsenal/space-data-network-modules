// The sequence reduction: frames -> times -> sources -> plate solutions ->
// satellite tracks -> site and timing from the calibrator -> observations.
// Stateless: each call recomputes everything from its inputs and either asks
// for what is missing (propagator answers, deeper catalogue cones) or
// finishes. The host answers and calls again with the answers added.
namespace oa {

struct FrameInput {
  const uint8_t* data = nullptr;
  size_t size = 0;
  std::string name;
};

struct ElementSetInfo {
  uint32_t norad = 0;
  std::string name, object_id;
  double epoch = kNaN;  // UTC Unix s
};

struct PropagationQuery {
  size_t set = 0;
  double start = 0, stop = 0, step = 1;
};

struct ReduceOptions {
  OverlayOptions overlay;
  DetectOptions detect;
  SolveOptions solve;
  uint32_t calibrator = 0;
  std::vector<uint32_t> targets;
  bool site_known = false;
  Site site;
  double site_sigma_m = 30;           // a known site's uncertainty
  CalibrationPrior prior;
  double catalog_mag_limit = 13.5;    // depth of requested catalogue cones (G)
  double search_lat0 = -90, search_lat1 = 90, search_lon0 = -180, search_lon1 = 180, search_step = 1.0;  // deg
  int max_candidates = 24;
  std::map<uint32_t, std::vector<double>> prior_rtn;  // per target: 6x6 RTN covariance of its prior element set at the arc (km, km/s)
  std::string time_reference = "tag";  // overlay tags: "tag" (bias solved); FITS DATE-OBS: "start", "mid" or "end"
  double min_elevation_deg = 3.0;
};

struct FrameState {
  double t = kNaN;              // tag time, UTC Unix s (mid-exposure after the bias)
  bool time_ok = false;
  Detection det;
  int width = 0, height = 0;
  double drift_x = kNaN, drift_y = kNaN;   // field shift to the next frame, px
  bool solved = false;
  int solve_method = 0;         // 1 blind, 2 tracked from a neighbour
  Wcs wcs;
  PlateFit fit;
  int matched = 0;
  double zero_point = kNaN;     // G = zp - 2.5 log10(flux)
  double exptime = kNaN;
};

struct TrackPoint {
  int frame = -1;
  int source = -1;
  double x = 0, y = 0;
  V3 observed;                  // GCRS, with the site's aberration
  V3 geometric;                 // aberration removed
  double c[2][2] = {{0}};       // tangent-plane covariance, rad^2 (centroid + plate)
  double snr = 0, mag = kNaN;
  bool valid = false;           // the frame has a plate solution
};

struct ObjectTrack {
  std::vector<TrackPoint> points;
  uint32_t norad = 0;           // 0: unidentified
  std::string name, object_id;
  double prior_oc_arcsec = kNaN;    // median distance to the prior prediction
  bool calibrator = false;
  std::vector<std::array<double, 2>> oc_arcsec;  // after calibration, per point (east, north)
};

struct ReduceResult {
  enum Stage { NEED_PROPAGATION, NEED_CATALOG, DONE, FAILED } stage = FAILED;
  std::string error;
  std::vector<std::string> notes;
  std::vector<PropagationQuery> queries;
  std::vector<Cone> cones;
  OverlayResult timing;
  bool timing_from_overlay = false;
  std::vector<FrameState> frames;
  std::vector<ObjectTrack> tracks;
  CalibrationResult calib;
  bool site_estimated = false;
  int reference_frame = -1;
  double plate_scale_arcsec = kNaN;
  std::vector<SiteCandidate> candidates;
  int stars_in_catalogue = 0;
  double exposure_s = kNaN;          // from trail length over drift rate
  std::map<uint32_t, OdResult> fits;  // per target: the batch orbit
  std::map<uint32_t, int> edited;     // per target: observations edited out
};

namespace detail_reduce {

// Field drift between consecutive frames by voting on star displacements;
// a streaked field must drift along its trails by about a trail length.
inline bool field_drift(const Detection& a, const Detection& b, double* dx, double* dy) {
  std::map<std::pair<int, int>, int> votes;
  std::vector<const Source*> sa, sb;
  for (const Source& s : a.sources) if (s.kind == 1 && !s.edge) sa.push_back(&s);
  for (const Source& s : b.sources) if (s.kind == 1 && !s.edge) sb.push_back(&s);
  if (sa.size() < 4 || sb.size() < 4) return false;
  const double lim = std::max(60.0, 4.0 * std::max(a.trail_length, a.streak_length));
  for (const Source* p : sa)
    for (const Source* q : sb) {
      const double ddx = q->x - p->x, ddy = q->y - p->y;
      if (std::fabs(ddx) > lim || std::fabs(ddy) > lim) continue;
      ++votes[{static_cast<int>(std::floor(ddx / 2)), static_cast<int>(std::floor(ddy / 2))}];
    }
  int best = 0;
  std::pair<int, int> key{0, 0};
  for (const auto& kv : votes) {
    int s = 0;
    for (int ox = -1; ox <= 1; ++ox)
      for (int oy = -1; oy <= 1; ++oy) {
        const auto it = votes.find({kv.first.first + ox, kv.first.second + oy});
        if (it != votes.end()) s += it->second;
      }
    if (s > best) { best = s; key = kv.first; }
  }
  if (best < 4) return false;
  // Mean of the votes in the winning 6x6 px box.
  double sx = 0, sy = 0;
  int n = 0;
  for (const Source* p : sa)
    for (const Source* q : sb) {
      const double ddx = q->x - p->x, ddy = q->y - p->y;
      if (std::fabs(ddx - (key.first * 2 + 1)) <= 3 && std::fabs(ddy - (key.second * 2 + 1)) <= 3) { sx += ddx; sy += ddy; ++n; }
    }
  if (n < 4) return false;
  *dx = sx / n;
  *dy = sy / n;
  if (a.streaked) {
    const double ang = std::atan2(*dy, *dx);
    const double da = std::fabs(std::remainder(ang - a.streak_angle, kPi));
    if (da > 15 * kDeg || std::hypot(*dx, *dy) < 0.3 * std::max(a.trail_length, a.streak_length)) return false;
  }
  return true;
}

inline void index_bands(double scale_lo, double scale_hi, int width, int height, std::vector<std::pair<double, double>>* bands) {
  const double diag = std::hypot(width, height);
  double lo = 0.12 * diag * scale_lo, hi = 0.95 * diag * scale_hi;
  bands->clear();
  for (double a = hi; a > lo; a /= 1.5) bands->push_back({std::max(lo, a / 1.5), a});
}

}  // namespace detail_reduce

class Reduction {
 public:
  Reduction(const ReduceOptions& o, const Clock& clock) : opt_(o), clock_(clock) {}

  // Frames are decoded twice (the overlay and the persistence mask first,
  // then detection), so only one image is held at a time.
  bool measure_frames(const std::vector<FrameInput>& frames, ReduceResult* r) {
    const size_t n = frames.size();
    if (n < 2) { r->error = "at least two frames are needed"; return false; }
    OverlayReader overlay(opt_.overlay);
    std::vector<std::vector<uint8_t>> lit;
    int width = 0, height = 0;
    bool headers_timed = true;
    std::vector<double> header_t(n, kNaN), header_exp(n, kNaN);
    std::string err;
    const size_t stride = std::max<size_t>(1, n / 20);
    for (size_t i = 0; i < n; ++i) {
      Image im;
      if (!decode_image(frames[i].data, frames[i].size, &im, &err)) { r->error = "frame " + std::to_string(i) + ": " + err; return false; }
      if (i == 0) { width = im.width; height = im.height; }
      if (im.width != width || im.height != height) { r->error = "frames differ in size"; return false; }
      const auto d = im.header.find("DATE-OBS");
      double t = kNaN;
      if (d != im.header.end() && parse_iso_utc_seconds(d->second, &t)) {
        header_t[i] = t;
        const auto e = im.header.find("EXPTIME");
        if (e != im.header.end()) header_exp[i] = std::atof(e->second.c_str());
      } else {
        headers_timed = false;
      }
      if (i == 0) read_site_header(im);
      overlay.add(im, &err);
      if (i % stride == 0) lit.push_back(lit_map(im, opt_.detect));
    }
    r->frames.assign(n, FrameState{});
    if (headers_timed) {
      for (size_t i = 0; i < n; ++i) {
        double t = header_t[i];
        if (opt_.time_reference == "start" && std::isfinite(header_exp[i])) t += 0.5 * header_exp[i];
        if (opt_.time_reference == "end" && std::isfinite(header_exp[i])) t -= 0.5 * header_exp[i];
        r->frames[i].t = t;
        r->frames[i].time_ok = true;
        r->frames[i].exptime = header_exp[i];
      }
      r->notes.push_back("timing=FITS DATE-OBS (" + opt_.time_reference + ")");
    } else {
      r->timing = overlay.read();
      if (!r->timing.ok) { r->error = r->timing.error; return false; }
      r->timing_from_overlay = true;
      for (size_t i = 0; i < n; ++i) {
        const FrameTime& ft = r->timing.frames[i];
        r->frames[i].t = ft.unix_seconds;
        r->frames[i].time_ok = ft.decoded && !ft.outlier && !ft.duplicate;
      }
    }
    mask_ = persistence_mask(lit, width, height, 0.9, 60);
    for (size_t i = 0; i < n; ++i) {
      Image im;
      decode_image(frames[i].data, frames[i].size, &im, &err);
      r->frames[i].det = detect_sources(im, mask_, opt_.detect);
      r->frames[i].width = im.width;
      r->frames[i].height = im.height;
    }
    for (size_t i = 0; i + 1 < n; ++i) {
      double dx, dy;
      if (r->frames[i].time_ok && r->frames[i + 1].time_ok && detail_reduce::field_drift(r->frames[i].det, r->frames[i + 1].det, &dx, &dy)) {
        r->frames[i].drift_x = dx;
        r->frames[i].drift_y = dy;
      }
    }
    // Exposure: trail length over the drift per second.
    std::vector<double> ex;
    for (size_t i = 0; i + 1 < n; ++i) {
      const FrameState& f = r->frames[i];
      if (!std::isfinite(f.drift_x) || !(f.det.trail_length > 0)) continue;
      const double rate = std::hypot(f.drift_x, f.drift_y) / (r->frames[i + 1].t - f.t);
      ex.push_back(f.det.trail_length / rate);
    }
    if (!ex.empty()) r->exposure_s = median(ex);
    return true;
  }

  void read_site_header(const Image& im) {
    auto num = [&](const char* k, double* v) {
      const auto it = im.header.find(k);
      if (it == im.header.end()) return false;
      *v = std::atof(it->second.c_str());
      return true;
    };
    double lat, lon, h = 0;
    if (!opt_.site_known && num("SITELAT", &lat) && num("SITELONG", &lon)) {
      num("SITEELEV", &h);
      opt_.site_known = true;
      opt_.site.lat = lat * kDeg;
      opt_.site.lon = lon * kDeg;
      opt_.site.h = h;
    }
  }

  std::vector<PropagationQuery> queries(const ReduceResult& r, size_t sets) const {
    double t0 = kNaN, t1 = kNaN;
    for (const FrameState& f : r.frames)
      if (f.time_ok) { t0 = std::isfinite(t0) ? std::min(t0, f.t) : f.t; t1 = std::isfinite(t1) ? std::max(t1, f.t) : f.t; }
    std::vector<PropagationQuery> q;
    for (size_t s = 0; s < sets; ++s) q.push_back({s, std::floor(t0) - 6.0, std::ceil(t1) + 6.0, 1.0});
    return q;
  }

  // The deep work, once trajectories exist.
  void reduce(std::vector<Trajectory>& trajectories, Catalog& cat, ReduceResult* r) {
    std::string err;
    const Trajectory* calib = nullptr;
    for (const Trajectory& t : trajectories)
      if (t.norad == opt_.calibrator) calib = &t;
    if (!calib) { r->stage = ReduceResult::FAILED; r->error = "no element set for the calibrator " + std::to_string(opt_.calibrator); return; }
    const size_t n = r->frames.size();
    double tmid = 0;
    int nt = 0;
    for (const FrameState& f : r->frames) if (f.time_ok) { tmid += f.t; ++nt; }
    tmid /= std::max(1, nt);
    r->stars_in_catalogue = static_cast<int>(cat.stars.size());
    // Places for the geocentre first (the site's diurnal aberration, < 0.32",
    // is added once the site is known).
    set_places(cat, tmid, nullptr);
    // Satellite tracks in pixels; the tracked one is the calibrator.
    build_tracks(r);
    const int tracked = tracked_track(*r);
    if (tracked >= 0) r->notes.push_back("tracked object: track of " + std::to_string(r->tracks[tracked].points.size()) + " frames");
    // Reference frames: the most stars, early first on ties.
    std::vector<int> order;
    for (size_t i = 0; i < n; ++i) if (r->frames[i].time_ok) order.push_back(static_cast<int>(i));
    std::stable_sort(order.begin(), order.end(), [&](int a, int b) { return count_stars(r->frames[a]) > count_stars(r->frames[b]); });
    if (order.size() > 3) order.resize(3);
    // Rate samples for the ridge, and the scale range they imply.
    std::vector<RateSample> rates;
    for (size_t i = 0; i + 1 < n; ++i) {
      const FrameState& f = r->frames[i];
      if (!std::isfinite(f.drift_x)) continue;
      const double dtf = r->frames[i + 1].t - f.t;
      if (!(dtf > 0)) continue;
      rates.push_back({0.5 * (f.t + r->frames[i + 1].t), std::hypot(f.drift_x, f.drift_y) / dtf, std::atan2(f.drift_y, f.drift_x)});
    }
    std::vector<SiteCandidate> cands;
    Site site = opt_.site;
    if (opt_.site_known) {
      SiteCandidate c;
      c.site = site;
      cands.push_back(c);
    } else {
      cands = site_ridge(*calib, rates, r->frames[order.empty() ? 0 : order[0]].t, clock_, opt_.search_lat0, opt_.search_lat1, opt_.search_lon0,
                         opt_.search_lon1, opt_.search_step, opt_.min_elevation_deg * kDeg, opt_.max_candidates, &err);
      if (cands.empty()) { r->stage = ReduceResult::FAILED; r->error = err; return; }
    }
    r->candidates = cands;
    // Scale range from the candidates (or a wide default).
    double slo = 1.0 * kArcsec, shi = 60.0 * kArcsec;
    if (!opt_.site_known) {
      slo = 1e9; shi = 0;
      for (const SiteCandidate& c : cands) { slo = std::min(slo, c.scale); shi = std::max(shi, c.scale); }
      slo *= 0.8; shi *= 1.25;
    }
    // Blind solve of a reference frame with what the catalogue holds.
    std::vector<QuadIndex> idx;
    int ref = -1;
    if (!cat.stars.empty()) {
      std::vector<std::pair<double, double>> bands;
      detail_reduce::index_bands(slo, shi, r->frames[0].width, r->frames[0].height, &bands);
      for (const auto& b : bands) {
        QuadIndex q;
        build_index_band(cat, b.first, b.second, 8, &q);
        idx.push_back(std::move(q));
      }
      for (int fi : order) {
        SolveResult s = blind_solve(idx, cat, r->frames[fi].det, r->frames[fi].width, r->frames[fi].height, opt_.solve);
        if (!s.solved) continue;
        FrameState& f = r->frames[fi];
        f.solved = true;
        f.solve_method = 1;
        f.wcs = s.wcs;
        f.fit = s.fit;
        f.matched = s.fit.used;
        ref = fi;
        r->notes.push_back("reference_frame=" + std::to_string(fi) + " blind log10_false=" + std::to_string(s.log10_false));
        break;
      }
    }
    if (ref < 0) {
      // Ask for the candidates' cones not yet held.
      const double fov = 0.5 * std::hypot(r->frames[0].width, r->frames[0].height);
      for (const SiteCandidate& c : cands) {
        if (opt_.site_known) {
          Look l;
          if (!look_at(*calib, site, clock_, r->frames[order[0]].t, &l, &err)) continue;
          Cone cone{l.observed, fov * 60 * kArcsec + 1.0 * kDeg};
          if (!cone_covered(cat, cone, opt_.catalog_mag_limit)) r->cones.push_back(cone);
          continue;
        }
        Cone cone{c.centre, fov * c.scale + 1.25 * kDeg};
        if (!cone_covered(cat, cone, opt_.catalog_mag_limit)) r->cones.push_back(cone);
      }
      if (r->cones.empty()) {
        r->stage = ReduceResult::FAILED;
        r->error = "no reference frame plate-solved against the catalogue held, and every candidate field's cone is already held";
        return;
      }
      r->stage = ReduceResult::NEED_CATALOG;
      r->notes.push_back("requested candidate field cones=" + std::to_string(r->cones.size()));
      return;
    }
    r->reference_frame = ref;
    r->plate_scale_arcsec = r->frames[ref].wcs.pixel_scale() / kArcsec;
    // The calibrator in the reference frame: the satellite-like source
    // nearest its predicted position, for each candidate site.
    if (!opt_.site_known) {
      double best = 1e9;
      for (const SiteCandidate& c : cands) {
        const double sep = separation(c.centre, r->frames[ref].wcs.pixel_to_sky(r->frames[ref].width / 2.0, r->frames[ref].height / 2.0));
        if (sep < best) { best = sep; site = c.site; }
      }
      if (tracked < 0) { r->stage = ReduceResult::FAILED; r->error = "no tracked (pixel-stationary) satellite for the calibrator"; return; }
      double cx = 0, cy = 0;
      int bestgap = 1 << 30;
      for (const TrackPoint& p : r->tracks[tracked].points)
        if (std::abs(p.frame - ref) < bestgap) { bestgap = std::abs(p.frame - ref); cx = p.x; cy = p.y; }
      const V3 u = r->frames[ref].wcs.pixel_to_sky(cx, cy);
      if (!site_from_direction(*calib, clock_, r->frames[ref].t, u, &site, &err)) { r->stage = ReduceResult::FAILED; r->error = err; return; }
      r->site_estimated = true;
    }
    // Cones along the field's path.
    std::vector<double> times;
    for (const FrameState& f : r->frames) if (f.time_ok) times.push_back(f.t);
    const double fov_r = 0.5 * std::hypot(r->frames[ref].width, r->frames[ref].height) * r->frames[ref].wcs.pixel_scale();
    for (const Cone& c : path_cones(*calib, site, clock_, times, fov_r, &err))
      if (!cone_covered(cat, c, opt_.catalog_mag_limit)) r->cones.push_back(c);
    if (!r->cones.empty()) {
      r->stage = ReduceResult::NEED_CATALOG;
      r->notes.push_back("requested path cones=" + std::to_string(r->cones.size()));
      return;
    }
    // Places for the site.
    set_places(cat, tmid, &site);
    solve_all(cat, idx, ref, r);
    // The calibrator's track: the tracked one, or the nearest to its
    // prediction when the mount tracked something else.
    int ci = tracked >= 0 && !opt_.site_known ? tracked : identify_calibrator(r, *calib, site);
    measure_tracks(r, site);
    if (ci < 0) { r->stage = ReduceResult::FAILED; r->error = "the calibrator's track was not found"; return; }
    r->tracks[ci].calibrator = true;
    r->tracks[ci].norad = opt_.calibrator;
    // Calibrate the site and the timing.
    for (int pass = 0; pass < 6; ++pass) {
      std::vector<DirectionObs> obs;
      for (const TrackPoint& p : r->tracks[ci].points) {
        if (!p.valid) continue;
        DirectionObs o;
        o.t = r->frames[p.frame].t;
        o.u = p.observed;
        std::memcpy(o.c, p.c, sizeof o.c);
        o.frame = p.frame;
        obs.push_back(o);
      }
      CalibrationPrior prior = opt_.prior;
      if (opt_.site_known) prior.sigma_h = opt_.site_sigma_m;
      r->calib = calibrate_site(*calib, clock_, obs, site, prior, !opt_.site_known);
      if (!r->calib.ok) { r->stage = ReduceResult::FAILED; r->error = r->calib.error; return; }
      // Drop calibrator points beyond 5 sigma and refit once.
      std::vector<TrackPoint> kept;
      size_t k = 0, dropped = 0;
      // Robust cut: five robust sigmas of the normalized residuals.
      std::vector<double> chis(r->calib.chi.begin(), r->calib.chi.end());
      const double cut = std::max(3.0, 5.0 * 1.4826 * median(chis) / 1.1774);
      for (const TrackPoint& p : r->tracks[ci].points) {
        if (!p.valid) { kept.push_back(p); continue; }
        if (r->calib.chi[k++] < cut) kept.push_back(p); else ++dropped;
      }
      if (pass < 5 && dropped > 0 && kept.size() >= 3) {
        r->notes.push_back("calibrator outliers=" + std::to_string(dropped));
        r->tracks[ci].points = kept;
        continue;
      }
      break;
    }
    // Scale the formal covariance by the reduced chi-square (never down).
    const double red = r->calib.dof > 0 ? r->calib.chi2 / r->calib.dof : 1.0;
    if (red > 1) for (double& v : r->calib.cov) v *= red;
    const double R = 6378137.0;
    r->calib.sigma_north_m = std::sqrt(r->calib.cov[0]) * R;
    r->calib.sigma_east_m = std::sqrt(r->calib.cov[8]) * R * std::cos(r->calib.site.lat);
    r->calib.sigma_up_m = std::sqrt(r->calib.cov[16]);
    r->calib.sigma_dt = std::sqrt(r->calib.cov[24]);
    // Re-measure every track with the calibrated site's aberration and
    // identify the targets.
    finish_tracks(r, trajectories);
    r->stage = ReduceResult::DONE;
  }

  const std::vector<uint8_t>& mask() const { return mask_; }

 private:
  static int count_stars(const FrameState& f) {
    int c = 0;
    for (const Source& s : f.det.sources) c += (s.kind == 1 && !s.edge);
    return c;
  }

  void set_places(Catalog& cat, double t, const Site* site) {
    ax::Epoch e;
    ax::EarthOrientation eo;
    std::string err;
    double pv[2][3] = {{0, 0, 0}, {0, 0, 0}};
    if (!clock_.at(t, &e, &eo, &err)) return;
    if (site) {
      V3 r, v;
      site_gcrs(*site, e, eo, &r, &v);
      pv[0][0] = r.x; pv[0][1] = r.y; pv[0][2] = r.z;
      pv[1][0] = v.x; pv[1][1] = v.y; pv[1][2] = v.z;
    }
    double tdb1 = e.tt1, tdb2 = e.tt2;  // TDB - TT < 2 ms: below the places' sensitivity
    apparent_places(&cat, tdb1, tdb2, pv);
    cat.index();
  }

  // Satellite-like: not a star trail, compact against the trail length.
  static bool satellite_like(const FrameState& f, const Source& s) {
    if (s.edge || s.kind == 1 || s.snr < 6) return false;
    const double trail = f.det.streaked ? std::max(f.det.trail_length, f.det.streak_length) : 0.0;
    return f.det.streaked ? s.length < std::max(8.0, 0.35 * trail) : s.length < 8.0;
  }

  // The tracked object: a long track that stays put in the frame (median
  // motion under a pixel a frame), the brightest such.
  static int tracked_track(const ReduceResult& r) {
    int best = -1;
    double bs = 0;
    for (size_t k = 0; k < r.tracks.size(); ++k) {
      const auto& pts = r.tracks[k].points;
      if (pts.size() < 20) continue;
      std::vector<double> v;
      double ssum = 0;
      for (size_t i = 1; i < pts.size(); ++i) {
        const int g = pts[i].frame - pts[i - 1].frame;
        if (g > 0) v.push_back(std::hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) / g);
      }
      for (const TrackPoint& p : pts) ssum += p.snr;
      if (v.empty() || median(v) > 1.0) continue;
      if (ssum > bs) { bs = ssum; best = static_cast<int>(k); }
    }
    return best;
  }

  int calibrator_source(const FrameState& f, const Trajectory& calib, const Site& site) const {
    Look l;
    std::string err;
    double px = f.width / 2.0, py = f.height / 2.0;
    if (look_at(calib, site, clock_, f.t, &l, &err)) {
      double x, y;
      if (f.wcs.sky_to_pixel(l.observed, &x, &y) && x > -f.width && x < 2 * f.width && y > -f.height && y < 2 * f.height) { px = x; py = y; }
    }
    // The brightest satellite-like source within a quarter frame of the
    // prediction (the site is only roughly known here).
    int best = -1;
    double bf = 0;
    const double gate = 0.25 * std::hypot(f.width, f.height);
    for (size_t i = 0; i < f.det.sources.size(); ++i) {
      const Source& s = f.det.sources[i];
      if (!satellite_like(f, s)) continue;
      if (std::hypot(s.x - px, s.y - py) > gate) continue;
      if (s.flux > bf) { bf = s.flux; best = static_cast<int>(i); }
    }
    return best;
  }

  // Plate solutions for every frame, outward from the reference: the
  // neighbour's solution moved by the measured drift, verified and refined;
  // the blind solver when that fails.
  void solve_all(const Catalog& cat, std::vector<QuadIndex>& idx, int ref, ReduceResult* r) {
    const int n = static_cast<int>(r->frames.size());
    // Rebuild the index with the full catalogue and the known scale.
    idx.clear();
    std::vector<std::pair<double, double>> bands;
    const double sc = r->frames[ref].wcs.pixel_scale();
    detail_reduce::index_bands(sc * 0.97, sc * 1.03, r->frames[ref].width, r->frames[ref].height, &bands);
    bool built = false;
    auto ensure_index = [&]() {
      if (built) return;
      for (const auto& b : bands) {
        QuadIndex q;
        build_index_band(cat, b.first, b.second, 8, &q);
        idx.push_back(std::move(q));
      }
      built = true;
    };
    // Re-fit the reference with the site's places.
    {
      FrameState& f = r->frames[ref];
      std::vector<PlateMatch> m;
      if (refine_solution(&f.wcs, cat, f.det, f.width, f.height, opt_.solve, &m, &f.fit)) f.matched = f.fit.used;
      zero_point(&f, m, cat);
    }
    for (int dir : {+1, -1}) {
      for (int i = ref + dir; i >= 0 && i < n; i += dir) {
        FrameState& f = r->frames[i];
        if (!f.time_ok) continue;
        // Nearest solved neighbour toward the reference.
        int j = i - dir;
        while (j >= 0 && j < n && !r->frames[j].solved) j -= dir;
        bool ok = false;
        if (j >= 0 && j < n) {
          Wcs w = r->frames[j].wcs;
          // Accumulated drift from j to i.
          double dx = 0, dy = 0;
          bool have = true;
          if (dir > 0) for (int k = j; k < i; ++k) { if (!std::isfinite(r->frames[k].drift_x)) { have = false; break; } dx += r->frames[k].drift_x; dy += r->frames[k].drift_y; }
          else for (int k = i; k < j; ++k) { if (!std::isfinite(r->frames[k].drift_x)) { have = false; break; } dx -= r->frames[k].drift_x; dy -= r->frames[k].drift_y; }
          if (!have) {
            // The drift of the nearest measured pair, per frame.
            double mx = 0, my = 0;
            int c = 0;
            for (int k = std::max(0, std::min(i, j) - 6); k < std::min(n - 1, std::max(i, j) + 6); ++k)
              if (std::isfinite(r->frames[k].drift_x)) { mx += r->frames[k].drift_x; my += r->frames[k].drift_y; ++c; }
            if (c > 0) { dx = (i - j) * mx / c; dy = (i - j) * my / c; }
          }
          // A field moved by (dx, dy) px: pixel p now shows what p - d showed.
          w.crpix_x += dx;
          w.crpix_y += dy;
          SolveOptions so = opt_.solve;
          so.match_radius_px = std::max(6.0, 0.1 * std::hypot(dx, dy) + 6.0);
          std::vector<PlateMatch> m;
          PlateFit fit;
          if (refine_solution(&w, cat, f.det, f.width, f.height, so, &m, &fit) && fit.used >= so.min_matches) {
            f.solved = true; f.solve_method = 2; f.wcs = w; f.fit = fit; f.matched = fit.used;
            zero_point(&f, m, cat);
            ok = true;
          }
        }
        if (!ok) {
          ensure_index();
          SolveResult s = blind_solve(idx, cat, f.det, f.width, f.height, opt_.solve);
          if (s.solved) {
            f.solved = true; f.solve_method = 1; f.wcs = s.wcs; f.fit = s.fit; f.matched = s.fit.used;
            zero_point(&f, s.matches, cat);
          }
        }
      }
    }
  }

  static void zero_point(FrameState* f, const std::vector<PlateMatch>& m, const Catalog& cat) {
    std::vector<double> zp;
    for (const PlateMatch& p : m) {
      if (p.outlier) continue;
      const Source& s = f->det.sources[p.source];
      const double mag = cat.stars[p.star].mag;
      if (!std::isfinite(mag) || s.saturated || !(s.flux > 0)) continue;
      zp.push_back(mag + 2.5 * std::log10(s.flux));
    }
    if (zp.size() >= 5) f->zero_point = median(zp);
  }

  // Link satellite-like sources frame to frame. A tracked or co-moving
  // satellite moves a few pixels per frame while star trails and their
  // fragments move with the field, so a short gate links the satellites and
  // nothing else; within the gate the candidate of the most similar flux
  // wins, so a faint fragment never steals a bright satellite's link.
  // Tracks survive gaps (a satellite blended with a passing trail) and
  // tracks of one object split by a long gap are merged afterwards.
  void build_tracks(ReduceResult* r) {
    struct Open { std::vector<TrackPoint> pts; std::vector<double> flux; double vx = 0, vy = 0; int last = -1; };
    std::vector<Open> open, done;
    const int n = static_cast<int>(r->frames.size());
    const int max_gap = 30;
    for (int i = 0; i < n; ++i) {
      const FrameState& f = r->frames[i];
      if (!f.time_ok) continue;
      std::vector<int> cand;
      for (size_t k = 0; k < f.det.sources.size(); ++k) if (satellite_like(f, f.det.sources[k])) cand.push_back(static_cast<int>(k));
      std::vector<char> used(cand.size(), 0);
      // Longest tracks claim first.
      std::vector<size_t> ord(open.size());
      std::iota(ord.begin(), ord.end(), 0);
      std::sort(ord.begin(), ord.end(), [&](size_t a, size_t b) { return open[a].pts.size() > open[b].pts.size(); });
      for (size_t oi : ord) {
        Open& o = open[oi];
        const TrackPoint& lp = o.pts.back();
        const int gap = i - o.last;
        if (gap > max_gap) continue;
        const double px = lp.x + o.vx * gap, py = lp.y + o.vy * gap;
        const double gate = 5.0 + 0.6 * gap;
        double ref = 0;
        for (size_t k = o.flux.size() > 5 ? o.flux.size() - 5 : 0; k < o.flux.size(); ++k) ref += std::log(o.flux[k]);
        ref /= std::min<size_t>(5, o.flux.size());
        int best = -1;
        double bs = 1e9;
        for (size_t c = 0; c < cand.size(); ++c) {
          if (used[c]) continue;
          const Source& s = f.det.sources[cand[c]];
          const double d = std::hypot(s.x - px, s.y - py);
          if (d > gate) continue;
          if (std::fabs(std::log(std::max(s.flux, 1.0)) - ref) > std::log(4.0)) continue;
          const double score = d / gate + 0.5 * std::fabs(std::log(std::max(s.flux, 1.0)) - ref);
          if (score < bs) { bs = score; best = static_cast<int>(c); }
        }
        if (best < 0) continue;
        used[best] = 1;
        const Source& s = f.det.sources[cand[best]];
        TrackPoint p;
        p.frame = i; p.source = cand[best]; p.x = s.x; p.y = s.y; p.snr = s.snr;
        const double nvx = (s.x - lp.x) / gap, nvy = (s.y - lp.y) / gap;
        o.vx = o.pts.size() > 1 ? 0.8 * o.vx + 0.2 * nvx : nvx;
        o.vy = o.pts.size() > 1 ? 0.8 * o.vy + 0.2 * nvy : nvy;
        // A satellite moves slowly against the frame; cap the velocity so a
        // wrong link cannot fling the predictor away.
        o.vx = std::clamp(o.vx, -4.0, 4.0);
        o.vy = std::clamp(o.vy, -4.0, 4.0);
        o.pts.push_back(p);
        o.flux.push_back(std::max(s.flux, 1.0));
        o.last = i;
      }
      for (size_t c = 0; c < cand.size(); ++c) {
        if (used[c]) continue;
        const Source& s = f.det.sources[cand[c]];
        if (s.snr < 15) continue;  // a new track starts only from a clear detection
        Open o;
        TrackPoint p;
        p.frame = i; p.source = cand[c]; p.x = s.x; p.y = s.y; p.snr = s.snr;
        o.pts.push_back(p);
        o.flux.push_back(std::max(s.flux, 1.0));
        o.last = i;
        open.push_back(o);
      }
      std::vector<Open> keep;
      for (Open& o : open) (i - o.last > max_gap ? done : keep).push_back(std::move(o));
      open = std::move(keep);
    }
    for (Open& o : open) done.push_back(std::move(o));
    // Chain pieces of one object split by gaps: in order of their first
    // frame, each piece joins the chain whose extrapolated end it starts at,
    // with a similar flux; one greedy pass.
    std::vector<Open> pieces;
    auto clear = [](const Open& o) {
      std::vector<double> snr;
      for (const TrackPoint& p : o.pts) snr.push_back(p.snr);
      return o.pts.size() >= 8 && median(snr) >= 15;
    };
    for (Open& o : done) if (clear(o)) pieces.push_back(std::move(o));
    std::sort(pieces.begin(), pieces.end(), [](const Open& a, const Open& b) { return a.pts.front().frame < b.pts.front().frame; });
    std::vector<Open> chains;
    for (Open& B : pieces) {
      int best = -1;
      double bd = 1e9;
      const double fb = median(std::vector<double>(B.flux.begin(), B.flux.begin() + std::min<size_t>(5, B.flux.size())));
      for (size_t a = 0; a < chains.size(); ++a) {
        const Open& A = chains[a];
        const int gap = B.pts.front().frame - A.pts.back().frame;
        if (gap <= 0 || gap > 120) continue;
        const double px = A.pts.back().x + A.vx * gap, py = A.pts.back().y + A.vy * gap;
        const double fa = median(std::vector<double>(A.flux.end() - std::min<size_t>(5, A.flux.size()), A.flux.end()));
        const double d = std::hypot(B.pts.front().x - px, B.pts.front().y - py);
        if (d > 6.0 + 0.3 * gap || std::fabs(std::log(fb / fa)) > std::log(8.0)) continue;
        if (d < bd) { bd = d; best = static_cast<int>(a); }
      }
      if (best < 0) { chains.push_back(std::move(B)); continue; }
      Open& A = chains[best];
      A.pts.insert(A.pts.end(), B.pts.begin(), B.pts.end());
      A.flux.insert(A.flux.end(), B.flux.begin(), B.flux.end());
      A.vx = B.vx; A.vy = B.vy; A.last = B.last;
    }
    done = std::move(chains);
    r->tracks.clear();
    for (Open& o : done) {
      // A satellite is detected in most frames of its span and moves
      // smoothly across the frame: a quadratic in time fits its pixel path
      // to a pixel; points off it by more than three pixels are dropped, and
      // a chain of unrelated fragments, which fits no quadratic, is dropped.
      std::vector<TrackPoint> pts = smooth_points(o.pts);
      if (pts.size() < 10) continue;
      const int span = pts.back().frame - pts.front().frame + 1;
      if (pts.size() < 0.25 * span) continue;
      ObjectTrack t;
      t.points = pts;
      r->tracks.push_back(t);
    }
  }

  static std::vector<TrackPoint> smooth_points(std::vector<TrackPoint> pts) {
    for (int pass = 0; pass < 6 && pts.size() >= 10; ++pass) {
      // Least-squares quadratic in the frame index for x and y.
      const double f0 = pts.front().frame;
      double N[3][3] = {{0}}, bx[3] = {0}, by[3] = {0};
      for (const TrackPoint& p : pts) {
        const double u = (p.frame - f0) / 100.0, t[3] = {1, u, u * u};
        for (int a = 0; a < 3; ++a) {
          bx[a] += t[a] * p.x;
          by[a] += t[a] * p.y;
          for (int c = 0; c < 3; ++c) N[a][c] += t[a] * t[c];
        }
      }
      std::vector<double> Nm(9), cx(bx, bx + 3), cy(by, by + 3);
      for (int a = 0; a < 3; ++a) for (int c = 0; c < 3; ++c) Nm[a * 3 + c] = N[a][c];
      if (!cholesky_solve(Nm, 3, &cx, nullptr) || !cholesky_solve(Nm, 3, &cy, nullptr)) return {};
      std::vector<double> d(pts.size());
      for (size_t k = 0; k < pts.size(); ++k) {
        const double u = (pts[k].frame - f0) / 100.0;
        d[k] = std::hypot(pts[k].x - (cx[0] + cx[1] * u + cx[2] * u * u), pts[k].y - (cy[0] + cy[1] * u + cy[2] * u * u));
      }
      const double worst = *std::max_element(d.begin(), d.end());
      if (worst <= 3.0) {
        double ss = 0;
        for (double v : d) ss += v * v;
        return std::sqrt(ss / d.size()) <= 1.2 ? pts : std::vector<TrackPoint>{};
      }
      std::vector<TrackPoint> keep;
      const double cut = std::max(3.0, 3.0 * 1.4826 * median(d));
      for (size_t k = 0; k < pts.size(); ++k) if (d[k] <= cut) keep.push_back(pts[k]);
      if (keep.size() == pts.size()) {
        // Nothing beyond the robust cut but the fit is still loose: drop the worst.
        const size_t w = static_cast<size_t>(std::max_element(d.begin(), d.end()) - d.begin());
        keep.erase(keep.begin() + w);
      }
      pts = std::move(keep);
    }
    return pts.size() >= 10 ? pts : std::vector<TrackPoint>{};
  }

  // Sky positions of every track point at a site (its aberration).
  void measure_tracks(ReduceResult* r, const Site& site) {
    for (ObjectTrack& t : r->tracks)
      for (TrackPoint& p : t.points) {
        const FrameState& f = r->frames[p.frame];
        p.valid = f.solved;
        if (!p.valid) continue;
        const Source& s = f.det.sources[p.source];
        p.observed = f.wcs.pixel_to_sky(s.x, s.y);
        // Covariance: centroid through the plate Jacobian plus the plate model.
        double j[2][2], pm[2][2];
        f.wcs.jacobian(s.x, s.y, j);
        f.wcs.model_covariance(s.x, s.y, pm);
        const double C[2][2] = {{s.cxx, s.cxy}, {s.cxy, s.cyy}};
        // (xi, eta) are east, north at the tangent point; at the source the
        // basis differs by < field radius: negligible for the covariance.
        for (int a = 0; a < 2; ++a)
          for (int b = 0; b < 2; ++b) {
            double v = pm[a][b];
            for (int k = 0; k < 2; ++k)
              for (int l = 0; l < 2; ++l) v += j[a][k] * C[k][l] * j[b][l];
            p.c[a][b] = v;
          }
        // Rescale the centroid part by the plate's reduced chi-square: the
        // codec's centroid noise is what the plate residuals measure.
        const double red = std::isfinite(f.fit.reduced_chi2) ? std::max(1.0, f.fit.reduced_chi2) : 1.0;
        for (int a = 0; a < 2; ++a)
          for (int b = 0; b < 2; ++b) {
            double cent = 0;
            for (int k = 0; k < 2; ++k)
              for (int l = 0; l < 2; ++l) cent += j[a][k] * C[k][l] * j[b][l];
            p.c[a][b] += (red - 1.0) * cent;
          }
        p.snr = s.snr;
        p.mag = std::isfinite(f.zero_point) && s.flux > 0 ? f.zero_point - 2.5 * std::log10(s.flux) : kNaN;
        Look l;
        std::string err;
        ax::Epoch e;
        ax::EarthOrientation eo;
        if (clock_.at(f.t, &e, &eo, &err)) {
          V3 sr, sv;
          site_gcrs(site, e, eo, &sr, &sv);
          p.geometric = deaberrate(p.observed, sv);
        } else {
          p.geometric = p.observed;
        }
      }
  }

  int identify_calibrator(ReduceResult* r, const Trajectory& calib, const Site& site) {
    measure_tracks(r, site);
    int best = -1;
    double bd = 1e9;
    for (size_t k = 0; k < r->tracks.size(); ++k) {
      std::vector<double> d;
      for (const TrackPoint& p : r->tracks[k].points) {
        if (!p.valid) continue;
        Look l;
        std::string err;
        if (!look_at(calib, site, clock_, r->frames[p.frame].t, &l, &err)) continue;
        d.push_back(separation(l.observed, p.observed));
      }
      if (d.size() < 10) continue;
      const double m = median(d);
#ifdef OA_DEBUG
      if (r->tracks[k].points.size() >= 20) std::printf("  calib? track %zu n=%zu (%.0f,%.0f) median sep %.1f arcsec\n", k, r->tracks[k].points.size(), r->tracks[k].points[0].x, r->tracks[k].points[0].y, m / kArcsec);
#endif
      // Prefer long tracks among the close ones.
      const double score = m / std::sqrt(static_cast<double>(d.size()));
      if (m < 0.5 * kDeg && score < bd) { bd = score; best = static_cast<int>(k); }
    }
    if (best >= 0) {
      r->tracks[best].calibrator = true;
      r->tracks[best].norad = opt_.calibrator;
    }
    return best;
  }

  void finish_tracks(ReduceResult* r, const std::vector<Trajectory>& trajectories) {
    const Site& site = r->calib.site;
    measure_tracks(r, site);
    // Identify: each trajectory to the nearest unclaimed track (calibrator
    // first, then targets), by the median angle to its prediction at the
    // calibrated site and time bias.
    std::vector<char> taken(r->tracks.size(), 0);
    for (size_t k = 0; k < r->tracks.size(); ++k) if (r->tracks[k].calibrator) taken[k] = 1;
    // A bright calibrator throws bloom and blended fragments around itself;
    // a track that stays within a few trail widths of it is one of those.
    int ci = -1;
    for (size_t k = 0; k < r->tracks.size(); ++k) if (r->tracks[k].calibrator) ci = static_cast<int>(k);
    if (ci >= 0) {
      std::map<int, std::pair<double, double>> at;
      for (const TrackPoint& p : r->tracks[ci].points) at[p.frame] = {p.x, p.y};
      for (size_t k = 0; k < r->tracks.size(); ++k) {
        if (taken[k]) continue;
        int near = 0, both = 0;
        for (const TrackPoint& p : r->tracks[k].points) {
          const auto it = at.find(p.frame);
          if (it == at.end()) continue;
          ++both;
          near += std::hypot(p.x - it->second.first, p.y - it->second.second) < 25.0;
        }
        if (both > 0 && near * 2 > both) taken[k] = 1;
      }
    }
    auto predicted = [&](const Trajectory& tr, double t, V3* u) {
      Look l;
      std::string err;
      if (!look_at(tr, site, clock_, t + r->calib.dt, &l, &err)) return false;
      *u = l.geometric;
      return true;
    };
    std::vector<const Trajectory*> order;
    for (const Trajectory& t : trajectories) if (t.norad == opt_.calibrator) order.push_back(&t);
    for (uint32_t id : opt_.targets)
      for (const Trajectory& t : trajectories) if (t.norad == id && id != opt_.calibrator) order.push_back(&t);
    for (const Trajectory* tr : order) {
      // Candidates: unclaimed tracks by their median angle to the prior
      // prediction. The calibrator is its own track. For a target, a prior
      // element set may be off by more than the distance between objects in
      // the field, so the nearest track is not enough: each of the nearest
      // few is fitted with an orbit (the batch below, with the prior), and
      // the track a single orbit fits best (lowest chi-square per degree of
      // freedom, prior term included) is the object. A chain of image
      // fragments fits no orbit.
      struct Cand { int k; double m; };
      std::vector<Cand> cands;
      for (size_t k = 0; k < r->tracks.size(); ++k) {
        if (taken[k] && !(r->tracks[k].calibrator && tr->norad == opt_.calibrator)) continue;
        if (tr->norad != opt_.calibrator && r->tracks[k].calibrator) continue;
        std::vector<double> d;
        for (const TrackPoint& p : r->tracks[k].points) {
          V3 u;
          if (p.valid && predicted(*tr, r->frames[p.frame].t, &u)) d.push_back(separation(u, p.geometric));
        }
        if (d.size() < 10) continue;
        std::vector<double> snr;
        for (const TrackPoint& p : r->tracks[k].points) snr.push_back(p.snr);
        if (tr->norad != opt_.calibrator && (d.size() < 20 || median(snr) < 20)) continue;
        cands.push_back({static_cast<int>(k), median(d)});
      }
      std::sort(cands.begin(), cands.end(), [](const Cand& a, const Cand& b) { return a.m < b.m; });
      int best = -1;
      double bd = 1e9;
      if (tr->norad == opt_.calibrator) {
        for (const Cand& c : cands) if (r->tracks[c.k].calibrator) { best = c.k; bd = c.m; }
      } else {
        double best_score = 1e300;
        int tried = 0;
        for (const Cand& c : cands) {
          if (c.m > 2.0 * kDeg || tried >= 12) break;
          ++tried;
          OdResult od;
          int edited = 0;
          if (!fit_track(r, *tr, c.k, &od, &edited)) continue;
          const double score = od.chi2 / std::max(1, od.dof);
          r->notes.push_back("candidate track for NORAD " + std::to_string(tr->norad) + ": prior O-C " + std::to_string(c.m / kArcsec) +
                             " arcsec, orbit fit rms " + std::to_string(od.rms_arcsec) + " arcsec, chi2/dof " + std::to_string(score));
          if (score < best_score) { best_score = score; best = c.k; bd = c.m; r->fits[tr->norad] = od; r->edited[tr->norad] = edited; }
        }
      }
      if (best < 0) {
        r->notes.push_back("no track for NORAD " + std::to_string(tr->norad));
        continue;
      }
      ObjectTrack& t = r->tracks[best];
      taken[best] = 1;
      t.norad = tr->norad;
      t.name = tr->name;
      t.object_id = tr->object_id;
      t.prior_oc_arcsec = bd / kArcsec;
      t.oc_arcsec.clear();
      for (const TrackPoint& p : t.points) {
        V3 u, e, nn;
        if (!p.valid || !predicted(*tr, r->frames[p.frame].t, &u)) { t.oc_arcsec.push_back({kNaN, kNaN}); continue; }
        tangent_basis(p.geometric, &e, &nn);
        t.oc_arcsec.push_back({dot(p.geometric - u, e) / kArcsec, dot(p.geometric - u, nn) / kArcsec});
      }
    }
  }

  // The batch orbit of one track against one prior trajectory, at the
  // middle of the track's valid points.
  bool fit_track(const ReduceResult* r, const Trajectory& tr, int k, OdResult* out, int* edited) const {
    std::vector<OdObservation> obs;
    for (const TrackPoint& p : r->tracks[k].points) {
      if (!p.valid) continue;
      OdObservation o;
      o.t = r->frames[p.frame].t;
      o.u = p.observed;
      std::memcpy(o.c, p.c, sizeof o.c);
      obs.push_back(o);
    }
    if (obs.size() < 10) return false;
    const double t0 = obs[obs.size() / 2].t + r->calib.dt;
    V3 r0, v0;
    if (!tr.at(t0, &r0, &v0)) return false;
    const double x0[6] = {r0.x, r0.y, r0.z, v0.x, v0.y, v0.z};
    std::vector<double> prior;
    const auto it = opt_.prior_rtn.find(tr.norad);
    if (it != opt_.prior_rtn.end() && it->second.size() == 36) prior = from_rtn(it->second, x0);
    *out = determine_orbit(tr, obs, clock_, r->calib, prior, t0, edited);
    return out->ok;
  }

  ReduceOptions opt_;
  const Clock& clock_;
  std::vector<uint8_t> mask_;
};

}  // namespace oa
