// Where the camera points when the site is unknown.
//
// The mount tracks the calibrator, so the star field drifts across the frame
// at the calibrator's angular rate over the plate scale. The ratio of the
// field's drift rate between frames is free of the plate scale, and the
// calibrator's angular-rate profile over the pass depends on where the site
// is (range and geometry). A grid search over sites fits one scale per site
// to the measured rates; the low-cost sites form a ridge, each predicting a
// field center (the calibrator's direction) and a plate scale. Their cones of
// the deep catalog are requested and the plate solver decides between them.
// After one frame solves, the calibrator's measured direction fixes the site
// on that ridge, and the field's path over the whole sequence follows.
namespace oa {

struct FrameEpochs {
  std::vector<double> t;                    // UTC Unix seconds
  std::vector<ax::Mat3> t2c;                // ITRS -> GCRS
  std::vector<ax::EarthOrientation> eo;
};

inline bool frame_epochs(const std::vector<double>& times, const Clock& clock, FrameEpochs* out, std::string* err) {
  out->t = times;
  out->t2c.resize(times.size());
  out->eo.resize(times.size());
  for (size_t i = 0; i < times.size(); ++i) {
    ax::Epoch e;
    if (!clock.at(times[i], &e, &out->eo[i], err)) return false;
    out->t2c[i] = ax::transpose(ax::gcrfToItrf(e, out->eo[i]));
  }
  return true;
}

inline V3 site_itrs_km(const Site& s) {
  double xyz[3];
  eraGd2gc(1, s.lon, s.lat, s.h, xyz);
  return V3{xyz[0] / 1000, xyz[1] / 1000, xyz[2] / 1000};
}
inline V3 rotate(const ax::Mat3& m, V3 v) {
  const ax::Vec3 r = ax::apply(m, ax::Vec3{v.x, v.y, v.z});
  return V3{r.x, r.y, r.z};
}

struct RateSample {
  double t = 0;          // mid time of the frame pair, UTC Unix s
  double rate = 0;       // field drift, px/s
  double angle = 0;      // drift direction in the image, rad
};

struct SiteCandidate {
  Site site;
  double cost = 0;
  double scale = 0;      // rad/px implied by the rate fit
  V3 center;             // calibrator direction at the reference frame
  double elevation = 0;  // of the calibrator at the reference frame, rad
};

// Calibrator direction (geometric, no light time: the rate test only) and
// elevation from a site at time t, given the GCRS rotation at t.
inline bool calib_dir(const Trajectory& tr, const Site& s, double t, const ax::Mat3& t2c, V3* dir, double* el) {
  V3 r, v;
  if (!tr.at(t, &r, &v)) return false;
  const V3 si = site_itrs_km(s);
  const V3 sg = rotate(t2c, si);
  const V3 d = r - sg;
  *dir = unit(d);
  // Up: geodetic normal rotated to GCRS.
  const V3 up = rotate(t2c, V3{std::cos(s.lat) * std::cos(s.lon), std::cos(s.lat) * std::sin(s.lon), std::sin(s.lat)});
  *el = std::asin(std::clamp(dot(*dir, up), -1.0, 1.0));
  return true;
}

// The ridge of sites whose calibrator rate profile matches the field drift.
inline std::vector<SiteCandidate> site_ridge(const Trajectory& calib, const std::vector<RateSample>& rates, double t_ref,
                                             const Clock& clock, double lat0, double lat1, double lon0, double lon1, double step,
                                             double min_elevation, int keep, std::string* err) {
  std::vector<SiteCandidate> out;
  if (rates.size() < 5) { *err = "too few frame pairs with a measured field drift to locate the site"; return out; }
  // Rotations at the sample times, at +/- 0.25 s, and at the reference.
  std::vector<double> times;
  for (const RateSample& r : rates) { times.push_back(r.t - 0.25); times.push_back(r.t + 0.25); }
  times.push_back(t_ref);
  FrameEpochs fe;
  if (!frame_epochs(times, clock, &fe, err)) return out;
  struct Scored { SiteCandidate c; };
  std::vector<SiteCandidate> all;
  for (double la = lat0; la <= lat1 + 1e-9; la += step)
    for (double lo = lon0; lo <= lon1 + 1e-9; lo += step) {
      Site s;
      s.lat = la * kDeg;
      s.lon = lo * kDeg;
      s.h = 1000;
      std::vector<double> lr;
      bool ok = true;
      for (size_t k = 0; k < rates.size() && ok; ++k) {
        V3 a, b;
        double ea, eb;
        if (!calib_dir(calib, s, times[2 * k], fe.t2c[2 * k], &a, &ea) || !calib_dir(calib, s, times[2 * k + 1], fe.t2c[2 * k + 1], &b, &eb) ||
            ea < min_elevation) { ok = false; break; }
        const double w = separation(a, b) / 0.5;
        if (!(w > 0)) { ok = false; break; }
        lr.push_back(std::log(rates[k].rate) - std::log(w));
      }
      if (!ok) continue;
      double m = 0;
      for (double v : lr) m += v;
      m /= lr.size();
      double c = 0;
      for (double v : lr) c += (v - m) * (v - m);
      c /= lr.size();
      SiteCandidate cand;
      cand.site = s;
      cand.cost = c;
      cand.scale = 1.0 / std::exp(m);  // rate[px/s] = w[rad/s] * exp(m) -> scale = rad/px
      double el;
      if (!calib_dir(calib, s, t_ref, fe.t2c.back(), &cand.center, &el)) continue;
      cand.elevation = el;
      all.push_back(cand);
    }
  if (all.empty()) { *err = "the calibrator is above the horizon from no site in the search region"; return out; }
  std::sort(all.begin(), all.end(), [](const SiteCandidate& a, const SiteCandidate& b) { return a.cost < b.cost; });
  // The ridge: within a factor of the best cost; spread by field center.
  const double limit = std::max(all.front().cost * 8.0, all.front().cost + 2e-3);
  for (const SiteCandidate& c : all) {
    if (c.cost > limit || static_cast<int>(out.size()) >= keep) break;
    bool near = false;
    for (const SiteCandidate& o : out) near = near || separation(o.center, c.center) < 1.2 * kDeg;
    if (!near) out.push_back(c);
  }
  return out;
}

// Refine the site on the ridge from one solved frame: the calibrator's
// measured direction (GCRS, observed) at time t. Gauss-Newton on (lat, lon)
// with the height held, starting from a candidate.
inline bool site_from_direction(const Trajectory& calib, const Clock& clock, double t, V3 measured, Site* site, std::string* err) {
  for (int it = 0; it < 12; ++it) {
    Look l0;
    if (!look_at(calib, *site, clock, t, &l0, err)) return false;
    const V3 r0 = measured - l0.observed;
    double J[3][2];
    const double h = 1e-5;
    for (int k = 0; k < 2; ++k) {
      Site s2 = *site;
      (k == 0 ? s2.lat : s2.lon) += h;
      Look l1;
      if (!look_at(calib, s2, clock, t, &l1, err)) return false;
      const V3 d = (l1.observed - l0.observed) * (1.0 / h);
      J[0][k] = d.x; J[1][k] = d.y; J[2][k] = d.z;
    }
    double N[2][2] = {{0, 0}, {0, 0}}, b[2] = {0, 0};
    const double rv[3] = {r0.x, r0.y, r0.z};
    for (int i = 0; i < 3; ++i)
      for (int a = 0; a < 2; ++a) {
        b[a] += J[i][a] * rv[i];
        for (int c = 0; c < 2; ++c) N[a][c] += J[i][a] * J[i][c];
      }
    const double det = N[0][0] * N[1][1] - N[0][1] * N[1][0];
    if (std::fabs(det) < 1e-30) { *err = "site refinement is singular"; return false; }
    double dlat = (N[1][1] * b[0] - N[0][1] * b[1]) / det, dlon = (-N[1][0] * b[0] + N[0][0] * b[1]) / det;
    const double cap = 2.0 * kDeg;
    dlat = std::clamp(dlat, -cap, cap);
    dlon = std::clamp(dlon, -cap, cap);
    site->lat += dlat;
    site->lon += dlon;
    if (std::fabs(dlat) + std::fabs(dlon) < 1e-9) break;
  }
  return true;
}

struct Cone {
  V3 center;
  double radius = 0;   // rad
};

// Cones along the calibrator's path from a site, spaced so that consecutive
// cones overlap by the field.
inline std::vector<Cone> path_cones(const Trajectory& calib, const Site& site, const Clock& clock, const std::vector<double>& times,
                                    double fov_radius, std::string* err) {
  // A frame's field lies inside a cone when its center is within `margin` of
  // the cone's center; a new cone starts when the path leaves that margin.
  std::vector<Cone> out;
  const double margin = 1.0 * kDeg;
  for (double t : times) {
    Look l;
    if (!look_at(calib, site, clock, t, &l, err)) continue;
    if (!out.empty() && separation(out.back().center, l.observed) < margin) continue;
    out.push_back({l.observed, fov_radius + margin});
  }
  return out;
}

// A cone is covered when the catalog already holds stars of the requested
// depth near its center.
inline bool cone_covered(const Catalog& cat, const Cone& c, double mag_limit) {
  std::vector<int> in;
  cat.cone(c.center, 0.3 * c.radius, kNaN, &in);
  int deep = 0;
  for (int k : in)
    if (std::isfinite(cat.stars[k].mag) && cat.stars[k].mag > mag_limit - 1.5) ++deep;
  return deep >= 3;
}

}  // namespace oa
