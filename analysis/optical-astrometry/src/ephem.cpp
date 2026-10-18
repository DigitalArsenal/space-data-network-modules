// Time scales, the observing site and satellite directions.
//  - UTC -> TT and UT1 by ERFA (leap seconds) and the $EOP series
//    (foundation/frames eop_series.hpp; without rows UT1 = UTC, no polar
//    motion, and the report says so);
//  - the site: WGS-84 geodetic -> ITRS (eraGd2gc) -> GCRS through the IAU
//    2006/2000A CIO chain of foundation/frames (gcrfToItrf), velocity from
//    the Earth's rotation;
//  - a satellite's trajectory: the propagator's answer block ($OEM, TEME, UTC)
//    rotated to GCRS (gcrfToTeme), cubic Hermite between samples;
//  - its direction from the site: the light-time solution for the receive
//    time, then aberration by the site's GCRS velocity (eraAb's first-order
//    form), the direction a camera on the site sees against stars reduced to
//    GCRS apparent places with the same observer velocity.
namespace oa {
namespace ax = sdn::frames;

struct Clock {
  std::vector<ax::eop::Row> rows;
  bool have_eop = false;
  std::string eop_error;
  // Two-part UTC Julian date of a Unix time (days without a leap second).
  static void utc_jd(double unix_s, double* u1, double* u2) {
    const double day = std::floor(unix_s / 86400.0);
    *u1 = 2440587.5 + day;
    *u2 = (unix_s - day * 86400.0) / 86400.0;
  }
  bool at(double unix_s, ax::Epoch* e, ax::EarthOrientation* eo, std::string* err) const {
    double u1, u2;
    utc_jd(unix_s, &u1, &u2);
    *eo = ax::EarthOrientation{};
    if (have_eop) {
      const std::string m = ax::eop::atValidated(rows, u1, u2, eo);
      if (!m.empty()) { *err = "earth orientation: " + m; return false; }
    }
    double tai1, tai2;
    if (eraUtctai(u1, u2, &tai1, &tai2) != 0 || eraTaitt(tai1, tai2, &e->tt1, &e->tt2) != 0 ||
        eraUtcut1(u1, u2, eo->dut1, &e->ut11, &e->ut12) != 0) {
      *err = "time scales: UTC outside the leap-second table";
      return false;
    }
    return true;
  }
};

struct Site {
  double lat = 0, lon = 0, h = 0;  // geodetic WGS-84: rad, rad, m
};

// GCRS position and velocity of a site, meters and m/s.
inline void site_gcrs(const Site& s, const ax::Epoch& e, const ax::EarthOrientation& eo, V3* r, V3* v) {
  double xyz[3];
  eraGd2gc(1, s.lon, s.lat, s.h, xyz);
  const ax::Mat3 c2t = ax::gcrfToItrf(e, eo);
  const ax::Mat3 t2c = ax::transpose(c2t);
  const ax::Vec3 p_itrs{xyz[0], xyz[1], xyz[2]};
  const double omega = 7.292115146706979e-5 * (1.0 - eo.lengthOfDay / 86400.0);
  const ax::Vec3 vi{-omega * p_itrs.y, omega * p_itrs.x, 0.0};
  const ax::Vec3 pg = ax::apply(t2c, p_itrs), vg = ax::apply(t2c, vi);
  *r = V3{pg.x, pg.y, pg.z};
  *v = V3{vg.x, vg.y, vg.z};
}

// One object's trajectory: UTC Unix seconds, GCRS km and km/s.
struct Trajectory {
  uint32_t norad = 0;
  std::string name, object_id;
  std::vector<double> t;
  std::vector<std::array<double, 6>> s;
  bool covers(double x) const { return t.size() >= 2 && x >= t.front() - 1e-3 && x <= t.back() + 1e-3; }
  bool at(double x, V3* r, V3* v) const {
    if (!covers(x)) return false;
    x = std::clamp(x, t.front(), t.back());
    size_t i = static_cast<size_t>(std::upper_bound(t.begin(), t.end(), x) - t.begin());
    i = i == 0 ? 0 : std::min(i - 1, t.size() - 2);
    const double h = t[i + 1] - t[i], u = (x - t[i]) / h;
    const double h00 = 2 * u * u * u - 3 * u * u + 1, h10 = u * u * u - 2 * u * u + u;
    const double h01 = -2 * u * u * u + 3 * u * u, h11 = u * u * u - u * u;
    const double d00 = (6 * u * u - 6 * u) / h, d10 = 3 * u * u - 4 * u + 1, d01 = (-6 * u * u + 6 * u) / h, d11 = 3 * u * u - 2 * u;
    double p[3], q[3];
    for (int k = 0; k < 3; ++k) {
      const double a = s[i][k], b = s[i + 1][k], va = s[i][k + 3], vb = s[i + 1][k + 3];
      p[k] = h00 * a + h10 * h * va + h01 * b + h11 * h * vb;
      q[k] = d00 * a + d10 * va + d01 * b + d11 * vb;
    }
    *r = V3{p[0], p[1], p[2]};
    *v = V3{q[0], q[1], q[2]};
    return true;
  }
};

// TEME -> GCRS for a trajectory sampled in TEME (the SGP4 answer frame).
inline bool trajectory_to_gcrs(Trajectory* tr, const Clock& clock, std::string* err) {
  for (size_t i = 0; i < tr->t.size(); ++i) {
    ax::Epoch e;
    ax::EarthOrientation eo;
    if (!clock.at(tr->t[i], &e, &eo, err)) return false;
    const ax::Mat3 m = ax::transpose(ax::gcrfToTeme(e));
    auto& st = tr->s[i];
    const ax::Vec3 r = ax::apply(m, ax::Vec3{st[0], st[1], st[2]});
    const ax::Vec3 v = ax::apply(m, ax::Vec3{st[3], st[4], st[5]});
    st = {r.x, r.y, r.z, v.x, v.y, v.z};
  }
  return true;
}

// Geometric direction (GCRS) of a satellite from a site at receive time t,
// the light-time solution; and the range, km.
struct Look {
  V3 geometric;    // unit, light-time corrected, no aberration
  V3 observed;     // unit, with aberration by the site's GCRS velocity
  double range_km = 0;
  V3 site_m, site_v;  // site GCRS position (m) and velocity (m/s) at t
  V3 sat_km, sat_v;   // satellite GCRS position at emission (km, km/s)
};

inline bool look_at(const Trajectory& tr, const Site& site, const Clock& clock, double t, Look* out, std::string* err) {
  ax::Epoch e;
  ax::EarthOrientation eo;
  if (!clock.at(t, &e, &eo, err)) return false;
  site_gcrs(site, e, eo, &out->site_m, &out->site_v);
  const V3 sk = out->site_m * 1e-3;
  double tau = 0;
  V3 r, v;
  for (int it = 0; it < 4; ++it) {
    if (!tr.at(t - tau, &r, &v)) { *err = "trajectory does not cover the frame time"; return false; }
    tau = norm(r - sk) * 1000.0 / kSpeedOfLight;
  }
  out->sat_km = r;
  out->sat_v = v;
  const V3 d = r - sk;
  out->range_km = norm(d);
  out->geometric = unit(d);
  // Aberration (first order in v/c, as eraAb without the Sun's potential).
  const V3 beta = out->site_v * (1.0 / kSpeedOfLight);
  const V3 u = out->geometric;
  out->observed = unit(u + beta - u * dot(u, beta));
  return true;
}

// Remove the site's aberration from an observed direction.
inline V3 deaberrate(V3 observed, V3 site_v) {
  const V3 beta = site_v * (1.0 / kSpeedOfLight);
  V3 u = observed;
  for (int it = 0; it < 3; ++it) u = unit(observed - beta + u * dot(u, beta));
  return u;
}

}  // namespace oa
