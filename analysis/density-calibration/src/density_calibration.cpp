// analysis/density-calibration: JB2008 thermospheric density at points, with
// an exospheric-temperature correction field, and the estimation of that
// field from observed densities: a public, simplified analogue of the
// Dynamic Calibration of the Atmosphere (DCA) inside the Air Force's HASDM
// (Storz et al. 2005, Adv. Space Res. 36(12), 2497-2505), which estimates
// global corrections to Jacchia's temperatures from calibration-satellite
// drag every few hours.
//
// The density is propagator/hpop's JB2008 (lib/jb2008.h, Orekit 13.1's port,
// itself a port of Space Environment Technologies' Fortran), driven as hpop
// drives it: SOLFSMY values at 12 UT of each DATE interpolated linearly at
// the instant less JB2008's lags (1 day F10 and S10, 2 M10, 5 Y10), DSTDTC
// linear between hourly values; the Sun's and the point's Earth-fixed
// longitude and latitude. The correction dT(lat, h) is added to DSTDTC, so
// it adds to the local exospheric temperature exactly as JB2008's own
// geomagnetic term does; a constant dT is therefore the same model as hpop
// with every DTC value raised by dT.
//
// dT(lat, h) = sum over l = 0..L, m = 0..l of P_l^m(sin lat) (a_lm cos mh +
// b_lm sin mh), Schmidt semi-normalized, h the point's hour angle from the
// Sun (Earth-fixed longitude minus the Sun's; local solar time is 12 h + h).
// Coefficient order: (0,0), (1,0), (1,1)c, (1,1)s, (2,0), (2,1)c, (2,1)s,
// (2,2)c, (2,2)s, ...; a_00 is the global mean of dT.
//
// The Sun: ERFA's eraEpv00 (heliocentric Earth, BCRS axes) negated, rotated
// to Earth-fixed axes by the IAU 2006/2000A CIO-based celestial-to-
// intermediate matrix (held for an hour of TT) and the Earth rotation angle
// with UT1 = UTC and no polar motion. Its direction is within 0.01 deg of
// DE440's, i.e. 2.4 s of local solar time.
//
// Methods (JSON in, JSON out):
//   evaluate   density, its log-derivative in dT, dT and local solar time at
//              each point.
//   calibrate  per time bin, the coefficients minimising the weighted sum of
//              squared log-density residuals plus a Gaussian prior on each
//              coefficient (Gauss-Newton, robust editing).
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <map>
#include <string>
#include <vector>

namespace {

using json = nlohmann::json;
using astro::jb2008::Inputs;
constexpr double kPi = 3.14159265358979323846;
constexpr double kDeg = kPi / 180.0;

int fail(const char* code, const std::string& message) {
  plugin_set_error(code, message.c_str());
  return 1;
}
const plugin_input_frame_t* input(const char* port) {
  const int32_t index = plugin_find_input_index(port, 0);
  return index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(index)) : nullptr;
}
json json_input(const char* port) {
  const plugin_input_frame_t* f = input(port);
  if (!f || !f->payload) return json(json::value_t::discarded);
  return json::parse(f->payload, f->payload + f->payload_length, nullptr, false);
}
int emit(const char* port, const json& j) {
  const std::string text = j.dump();
  return plugin_push_output_ex(port, nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                               reinterpret_cast<const uint8_t*>(text.data()), static_cast<uint32_t>(text.size())) < 0
             ? 1
             : 0;
}
bool finite(double x) { return std::isfinite(x); }
bool positive(double x) { return std::isfinite(x) && x > 0; }

// ── JB2008 drivers, read as propagator/hpop's JB2008IndicesTable reads PRW
// JB2008_INDICES rows (src/cpp/src/prw_execution.cpp) ──
class Jb2008Table {
 public:
  struct Day { double f10, f10B, s10, s10B, m10, m10B, y10, y10B; };
  std::vector<Day> days;
  std::vector<double> dtc;
  long firstMjd = 0;
  std::string add(const json& rows) {
    if (!rows.is_array() || rows.empty()) return "jb2008.rows must be a non-empty array.";
    for (const json& row : rows) {
      int y = 0, m = 0, d = 0;
      double jd0 = 0, mjd = 0;
      const std::string date = row.value("DATE", std::string());
      if (std::sscanf(date.c_str(), "%d-%d-%d", &y, &m, &d) != 3 || eraCal2jd(y, m, d, &jd0, &mjd) != 0)
        return "JB2008 DATE must be an ISO 8601 calendar date.";
      if (days.empty()) firstMjd = long(mjd);
      else if (long(mjd) != firstMjd + long(days.size())) return "JB2008 rows must be consecutive days.";
      const auto num = [&](const char* k) { return row.contains(k) && row[k].is_number() ? row[k].get<double>() : -1.0; };
      const Day v{num("F10"), num("F10_CENTRED_81"), num("S10"), num("S10_CENTRED_81"),
                  num("M10"), num("M10_CENTRED_81"), num("Y10"), num("Y10_CENTRED_81")};
      for (const double x : {v.f10, v.f10B, v.s10, v.s10B, v.m10, v.m10B, v.y10, v.y10B})
        if (!positive(x)) return "JB2008 solar indices must be positive and finite (" + date + ").";
      if (!row.contains("DTC_HOURLY_K") || !row["DTC_HOURLY_K"].is_array() || row["DTC_HOURLY_K"].size() != 24)
        return "JB2008 DTC_HOURLY_K needs 24 hourly values (" + date + ").";
      for (const json& x : row["DTC_HOURLY_K"]) {
        if (!x.is_number() || !finite(x.get<double>())) return "JB2008 DTC values must be finite.";
        dtc.push_back(x.get<double>());
      }
      days.push_back(v);
    }
    return "";
  }
  // Inputs at a UTC MJD; false outside the rows.
  bool at(double mjd, Inputs& out) const {
    const auto sol = [&](double lag, double Day::*member, double& value) {
      const double x = mjd - lag - (double(firstMjd) + 0.5);
      const long k = long(std::ceil(x)) - 1;
      if (k < 0 || k + 1 >= long(days.size())) return false;
      const double w = x - double(k);
      value = days[k].*member * (1 - w) + days[k + 1].*member * w;
      return true;
    };
    const double h = (mjd - double(firstMjd)) * 24.0;
    const long k = long(std::ceil(h)) - 1;
    if (k < 0 || k + 1 >= long(dtc.size())) return false;
    const double w = h - double(k);
    out.dstdtc = dtc[k] * (1 - w) + dtc[k + 1] * w;
    return sol(1, &Day::f10, out.f10) && sol(1, &Day::f10B, out.f10B) && sol(1, &Day::s10, out.s10) &&
           sol(1, &Day::s10B, out.s10B) && sol(2, &Day::m10, out.xm10) && sol(2, &Day::m10B, out.xm10B) &&
           sol(5, &Day::y10, out.y10) && sol(5, &Day::y10B, out.y10B);
  }
};

// ── The Sun in Earth-fixed axes ──
class SunEarthFixed {
 public:
  // Earth-fixed longitude and latitude (rad) of the Sun's direction at a UTC MJD.
  void at(double mjdUtc, double& lon, double& lat) {
    double tai1 = 0, tai2 = 0, tt1 = 0, tt2 = 0;
    eraUtctai(2400000.5, mjdUtc, &tai1, &tai2);
    eraTaitt(tai1, tai2, &tt1, &tt2);
    const double ttHour = std::floor(((tt1 - 2400000.5) + tt2) * 24.0);
    if (ttHour != cachedHour) {
      eraC2i06a(2400000.5, ttHour / 24.0, rc2i);
      cachedHour = ttHour;
    }
    double pvh[2][3], pvb[2][3];
    eraEpv00(tt1, tt2, pvh, pvb);
    double sun[3] = {-pvh[0][0], -pvh[0][1], -pvh[0][2]};
    double cirs[3];
    eraRxp(rc2i, sun, cirs);
    const double era = eraEra00(2400000.5, mjdUtc);
    const double c = std::cos(era), s = std::sin(era);
    const double x = c * cirs[0] + s * cirs[1], y = -s * cirs[0] + c * cirs[1], z = cirs[2];
    lon = std::atan2(y, x);
    lat = std::atan2(z, std::hypot(x, y));
  }

 private:
  double cachedHour = std::numeric_limits<double>::quiet_NaN();
  double rc2i[3][3] = {};
};

// ── Correction basis ──
int basis_size(int degree) { return (degree + 1) * (degree + 1); }
// Schmidt semi-normalized P_l^m(sin lat) times cos/sin(m h), in coefficient order.
void basis(int degree, double lat, double h, double* y) {
  const double x = std::sin(lat), c = std::cos(lat);
  double P[9][9] = {};
  P[0][0] = 1.0;
  for (int m = 1; m <= degree; ++m) P[m][m] = (2 * m - 1) * c * P[m - 1][m - 1];
  for (int m = 0; m < degree; ++m) P[m + 1][m] = (2 * m + 1) * x * P[m][m];
  for (int m = 0; m <= degree; ++m)
    for (int l = m + 2; l <= degree; ++l) P[l][m] = ((2 * l - 1) * x * P[l - 1][m] - (l + m - 1) * P[l - 2][m]) / (l - m);
  int k = 0;
  for (int l = 0; l <= degree; ++l) {
    for (int m = 0; m <= l; ++m) {
      double norm = 1.0;
      if (m > 0) {
        double ratio = 1.0;  // (l-m)! / (l+m)!
        for (int i = l - m + 1; i <= l + m; ++i) ratio /= i;
        norm = std::sqrt(2.0 * ratio);
      }
      const double p = norm * P[l][m];
      if (m == 0) {
        y[k++] = p;
      } else {
        y[k++] = p * std::cos(m * h);
        y[k++] = p * std::sin(m * h);
      }
    }
  }
}

// One point ready for the model: the time, the Sun's and the point's
// Earth-fixed angles (rad), the altitude (m) and the drivers.
struct Point {
  double mjd = 0, sunLon = 0, sunLat = 0, lon = 0, lat = 0, altM = 0;
  Inputs in{};
  bool ok = false;
};
double rho_at(const Point& p, double dT) {
  Inputs in = p.in;
  in.dstdtc += dT;
  return astro::jb2008::density(p.mjd, p.sunLon, p.sunLat, p.lon, p.lat, p.altM, in);
}
double hour_angle(const Point& p) { return std::remainder(p.lon - p.sunLon, 2 * kPi); }

// Points from {points: {mjd, latDeg, lonDeg, altKm}} with the drivers from
// {jb2008: {rows}}, or from {raw: [{mjd, sunRaRad, sunDecRad, lonRad, latRad,
// altKm, inputs: [F10, F10B, S10, S10B, M10, M10B, Y10, Y10B, DSTDTC]}]}
// (the arguments of Space Environment Technologies' JB2008 subroutine).
std::string load_points(const json& request, std::vector<Point>& points) {
  if (request.contains("raw")) {
    const json& raw = request["raw"];
    if (!raw.is_array()) return "raw must be an array.";
    for (const json& r : raw) {
      Point p;
      const json& v = r.value("inputs", json::array());
      if (!v.is_array() || v.size() != 9) return "raw inputs need nine values.";
      p.mjd = r.value("mjd", 0.0);
      p.sunLon = r.value("sunRaRad", 0.0);
      p.sunLat = r.value("sunDecRad", 0.0);
      p.lon = r.value("lonRad", 0.0);
      p.lat = r.value("latRad", 0.0);
      p.altM = r.value("altKm", 0.0) * 1000.0;
      p.in = Inputs{v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8]};
      p.ok = true;
      points.push_back(p);
    }
    return "";
  }
  if (!request.contains("points") || !request["points"].is_object()) return "points {mjd, latDeg, lonDeg, altKm} is required.";
  const json& pts = request["points"];
  for (const char* k : {"mjd", "latDeg", "lonDeg", "altKm"})
    if (!pts.contains(k) || !pts[k].is_array()) return std::string("points.") + k + " must be an array.";
  const size_t n = pts["mjd"].size();
  for (const char* k : {"latDeg", "lonDeg", "altKm"})
    if (pts[k].size() != n) return std::string("points.") + k + " must have one value per point.";
  Jb2008Table table;
  if (!request.contains("jb2008") || !request["jb2008"].is_object()) return "jb2008 {rows} is required.";
  std::string e = table.add(request["jb2008"].value("rows", json::array()));
  if (!e.empty()) return e;
  SunEarthFixed sun;
  points.resize(n);
  const json &mj = pts["mjd"], &la = pts["latDeg"], &lo = pts["lonDeg"], &al = pts["altKm"];
  for (size_t i = 0; i < n; ++i) {
    Point& p = points[i];
    if (!mj[i].is_number() || !la[i].is_number() || !lo[i].is_number() || !al[i].is_number()) continue;
    p.mjd = mj[i];
    p.lat = la[i].get<double>() * kDeg;
    // JB2008 expects longitudes in [-pi, pi], as hpop's geodetic conversion gives them.
    p.lon = std::remainder(lo[i].get<double>() * kDeg, 2 * kPi);
    p.altM = al[i].get<double>() * 1000.0;
    if (!finite(p.mjd) || !finite(p.lat) || !finite(p.lon) || !(p.altM >= 90e3 && p.altM <= 2500e3)) continue;
    if (!table.at(p.mjd, p.in)) continue;
    sun.at(p.mjd, p.sunLon, p.sunLat);
    p.ok = true;
  }
  return "";
}

// A correction in time nodes {nodesMjd, altitudeKm, values}: dT(t, h) =
// sum_j sum_a values[j][a] phi_j(t) w_a(h), phi_j the linear interpolant in
// time between nodes (the first and last values held outside them) and w_a
// the linear interpolant in altitude between altitudeKm nodes, extrapolated
// linearly up to 100 km beyond the outer nodes and held beyond that; an empty
// altitudeKm is one global value per node. calibrate_decay estimates it.
struct NodeCorrection {
  std::vector<double> t, alt, v;  // node MJDs, altitude nodes (km), values node-major [j * P + a]
  int P() const { return alt.empty() ? 1 : int(alt.size()); }
  int M() const { return int(t.size()); }
  std::string load(const json& j) {
    t.clear(); alt.clear(); v.clear();
    const json& nodes = j.value("nodesMjd", json::array());
    const json& altitudes = j.value("altitudeKm", json::array());
    const json& values = j.value("values", json::array());
    if (!nodes.is_array() || nodes.empty()) return "correction.nodesMjd must be a non-empty array.";
    for (const json& x : nodes) { if (!x.is_number()) return "correction.nodesMjd must be numbers."; t.push_back(x.get<double>()); }
    for (size_t i = 1; i < t.size(); ++i) if (!(t[i] > t[i - 1])) return "correction.nodesMjd must increase.";
    if (!altitudes.is_array()) return "correction.altitudeKm must be an array.";
    for (const json& x : altitudes) { if (!x.is_number()) return "correction.altitudeKm must be numbers."; alt.push_back(x.get<double>()); }
    if (alt.size() == 1) return "correction.altitudeKm needs none (global) or at least two altitudes.";
    for (size_t i = 1; i < alt.size(); ++i) if (!(alt[i] > alt[i - 1])) return "correction.altitudeKm must increase.";
    if (!values.is_array() || values.size() != t.size()) return "correction.values needs one entry per node.";
    for (const json& row : values) {
      if (!row.is_array() || int(row.size()) != P()) return "each correction.values entry needs one value per altitude node (one when global).";
      for (const json& x : row) { if (!x.is_number() || !finite(x.get<double>())) return "correction values must be finite numbers."; v.push_back(x.get<double>()); }
    }
    return "";
  }
  void timeWeight(double mjd, int& j0, double& w) const {
    if (t.size() == 1 || mjd <= t.front()) { j0 = 0; w = 0; return; }
    if (mjd >= t.back()) { j0 = M() - 2; w = 1; return; }
    j0 = int(std::upper_bound(t.begin(), t.end(), mjd) - t.begin()) - 1;
    w = (mjd - t[j0]) / (t[j0 + 1] - t[j0]);
  }
  void altitudeWeight(double hKm, int& a0, double& w) const {
    if (P() == 1) { a0 = 0; w = 0; return; }
    const double h = std::max(alt.front() - 100.0, std::min(alt.back() + 100.0, hKm));
    a0 = std::max(0, std::min(P() - 2, int(std::upper_bound(alt.begin(), alt.end(), h) - alt.begin()) - 1));
    w = (h - alt[a0]) / (alt[a0 + 1] - alt[a0]);
  }
  double value(int j, int a) const { return v[size_t(j) * P() + a]; }
  // dT at (t, h) and, when asked, its weights: up to four (index, weight) pairs.
  double at(double mjd, double hKm, int* index = nullptr, double* weight = nullptr) const {
    int j0, a0;
    double wt, wa;
    timeWeight(mjd, j0, wt);
    altitudeWeight(hKm, a0, wa);
    const int jn = M() == 1 ? 0 : j0 + 1, an = P() == 1 ? 0 : a0 + 1;
    const int idx[4] = {j0 * P() + a0, j0 * P() + an, jn * P() + a0, jn * P() + an};
    const double wgt[4] = {(1 - wt) * (1 - wa), (1 - wt) * wa, wt * (1 - wa), wt * wa};
    double dT = 0;
    for (int k = 0; k < 4; ++k) {
      dT += wgt[k] * v[idx[k]];
      if (index) { index[k] = idx[k]; weight[k] = wgt[k]; }
    }
    return dT;
  }
};

// A correction: either time nodes (above, with nodesMjd) or spherical-
// harmonic segments {degree, segments: [{fromMjd, toMjd, coefficients}]}, the
// segment holding the instant (from <= t < to) applying and none meaning dT = 0.
struct Correction {
  int degree = 0;
  bool nodal = false;
  NodeCorrection nodes;
  struct Segment { double from, to; std::vector<double> c; };
  std::vector<Segment> segments;
  std::string load(const json& j) {
    if (j.contains("nodesMjd")) {
      nodal = true;
      return nodes.load(j);
    }
    degree = j.value("degree", 0);
    if (degree < 0 || degree > 8) return "correction.degree must be 0-8.";
    for (const json& s : j.value("segments", json::array())) {
      Segment g{s.value("fromMjd", 0.0), s.value("toMjd", 0.0), {}};
      const json& c = s.value("coefficients", json::array());
      if (!c.is_array() || int(c.size()) != basis_size(degree)) return "each correction segment needs (degree+1)^2 coefficients.";
      for (const json& x : c) g.c.push_back(x.is_number() ? x.get<double>() : std::numeric_limits<double>::quiet_NaN());
      if (!(g.to > g.from)) return "correction segments need toMjd > fromMjd.";
      segments.push_back(g);
    }
    std::sort(segments.begin(), segments.end(), [](const Segment& a, const Segment& b) { return a.from < b.from; });
    for (size_t i = 1; i < segments.size(); ++i)
      if (segments[i].from < segments[i - 1].to) return "correction segments must not overlap.";
    return "";
  }
  double at(const Point& p) const {
    if (nodal) return nodes.at(p.mjd, p.altM / 1000.0);
    auto it = std::upper_bound(segments.begin(), segments.end(), p.mjd, [](double t, const Segment& s) { return t < s.from; });
    if (it == segments.begin()) return 0.0;
    --it;
    if (!(p.mjd < it->to)) return 0.0;
    double y[81];
    basis(degree, p.lat, hour_angle(p), y);
    double dT = 0;
    for (int k = 0; k < basis_size(degree); ++k) dT += it->c[k] * y[k];
    return dT;
  }
};

// Solves A x = b in place (A symmetric positive definite, n x n); false if not.
bool cholesky_solve(std::vector<double>& A, std::vector<double>& b, int n, std::vector<double>* inverse) {
  for (int j = 0; j < n; ++j) {
    double d = A[j * n + j];
    for (int k = 0; k < j; ++k) d -= A[j * n + k] * A[j * n + k];
    if (!(d > 0)) return false;
    A[j * n + j] = std::sqrt(d);
    for (int i = j + 1; i < n; ++i) {
      double s = A[i * n + j];
      for (int k = 0; k < j; ++k) s -= A[i * n + k] * A[j * n + k];
      A[i * n + j] = s / A[j * n + j];
    }
  }
  const auto solve = [&](std::vector<double>& v) {
    for (int i = 0; i < n; ++i) { for (int k = 0; k < i; ++k) v[i] -= A[i * n + k] * v[k]; v[i] /= A[i * n + i]; }
    for (int i = n - 1; i >= 0; --i) { for (int k = i + 1; k < n; ++k) v[i] -= A[k * n + i] * v[k]; v[i] /= A[i * n + i]; }
  };
  solve(b);
  if (inverse) {
    inverse->assign(n * n, 0.0);
    for (int c = 0; c < n; ++c) {
      std::vector<double> e(n, 0.0);
      e[c] = 1.0;
      solve(e);
      for (int r = 0; r < n; ++r) (*inverse)[r * n + c] = e[r];
    }
  }
  return true;
}

double median_abs(std::vector<double> v) {
  if (v.empty()) return 0;
  for (double& x : v) x = std::abs(x);
  std::nth_element(v.begin(), v.begin() + v.size() / 2, v.end());
  return v[v.size() / 2];
}
double median_of(std::vector<double> v) {
  if (v.empty()) return 0;
  std::nth_element(v.begin(), v.begin() + v.size() / 2, v.end());
  return v[v.size() / 2];
}

// ── Orbit decay from element sets ──
// Each element set is propagated by Vallado's SGP4 (propagator/sgp4's
// sources: WGS-72, opsmode 'i') from its epoch to the next set's epoch. Its
// mean semi-major axis is SGP4's own (Brouwer, un-Kozai'd) a. Drag changes
// the semi-major axis at
//   da/dt = -(a^2 / mu) B rho |v_r| (v . v_r),   v_r = v - omega_E x r
// (Gauss's equation for the drag acceleration -1/2 B rho |v_r| v_r, B =
// Cd A/m, the atmosphere co-rotating with the Earth), which is integrated
// along the set's trajectory by the trapezoid rule. Over whole revolutions
// this is the drag change in mean semi-major axis that the next set observes.
// rho is JB2008 with the correction, at the trajectory's geodetic latitude,
// longitude and altitude: TEME turned Earth-fixed by GMST (IAU 1982, UT1 =
// UTC; no polar motion), as SGP4's TEME is defined, then WGS84.
constexpr double kMu = 3.986004418e14;       // m^3/s^2
constexpr double kOmegaEarth = 7.292115e-5;  // rad/s
constexpr double kSgp4EpochMjd = 33281.0;    // SGP4 epochs count days from 1949 December 31 0h UT

struct ElementSet {
  double mjd = 0, aKm = 0, ecc = 0, perigeeKm = 0, bstar = 0;
  elsetrec rec{};
};
std::string load_set(const json& s, ElementSet& out) {
  const auto num = [&](const char* k, double& x) {
    if (!s.contains(k) || !s[k].is_number()) return false;
    x = s[k].get<double>();
    return finite(x);
  };
  double n = 0, e = 0, inc = 0, raan = 0, argp = 0, ma = 0;
  if (!num("mjd", out.mjd) || !num("MEAN_MOTION", n) || !num("ECCENTRICITY", e) || !num("INCLINATION", inc) || !num("RA_OF_ASC_NODE", raan) ||
      !num("ARG_OF_PERICENTER", argp) || !num("MEAN_ANOMALY", ma) || !num("BSTAR", out.bstar))
    return "fields";
  if (!(n > 0) || !(e >= 0 && e < 1)) return "mean-motion-or-eccentricity";
  std::memset(&out.rec, 0, sizeof(out.rec));
  const char satn[9] = "00000";
  if (!SGP4Funcs::sgp4init(wgs72, 'i', satn, out.mjd - kSgp4EpochMjd, out.bstar, 0.0, 0.0, e, argp * kDeg, inc * kDeg, ma * kDeg,
                           n * 2 * kPi / 1440.0, raan * kDeg, out.rec) || out.rec.error != 0)
    return "sgp4-init";
  if (out.rec.method != 'n') return "deep-space";
  out.aKm = out.rec.a * out.rec.radiusearthkm;
  out.ecc = e;
  out.perigeeKm = out.aKm * (1 - e) - out.rec.radiusearthkm;
  return "";
}

// The Sun's CIRS direction at every TT hour of a span (ERFA, as
// SunEarthFixed), interpolated linearly in time and turned Earth-fixed by the
// Earth rotation angle (UT1 = UTC): within 1e-6 rad of SunEarthFixed.
class SunTable {
 public:
  void build(double fromMjd, double toMjd) {
    first = std::floor(tt_mjd(fromMjd) * 24.0) - 1;
    const long n = long(std::ceil(tt_mjd(toMjd) * 24.0) + 2 - first);
    s.assign(size_t(std::max(2L, n)), {0, 0, 0});
    for (size_t k = 0; k < s.size(); ++k) {
      const double tt = (first + double(k)) / 24.0;
      double pvh[2][3], pvb[2][3], rc2i[3][3];
      eraEpv00(2400000.5, tt, pvh, pvb);
      eraC2i06a(2400000.5, tt, rc2i);
      double sun[3] = {-pvh[0][0], -pvh[0][1], -pvh[0][2]};
      eraRxp(rc2i, sun, s[k].data());
    }
  }
  bool at(double mjdUtc, double& lon, double& lat) const {
    const double h = tt_mjd(mjdUtc) * 24.0 - first;
    const long k = long(std::floor(h));
    if (k < 0 || k + 1 >= long(s.size())) return false;
    const double w = h - double(k);
    double c[3];
    for (int i = 0; i < 3; ++i) c[i] = s[k][i] * (1 - w) + s[k + 1][i] * w;
    const double era = eraEra00(2400000.5, mjdUtc);
    const double ce = std::cos(era), se = std::sin(era);
    const double x = ce * c[0] + se * c[1], y = -se * c[0] + ce * c[1], z = c[2];
    lon = std::atan2(y, x);
    lat = std::atan2(z, std::hypot(x, y));
    return true;
  }

 private:
  static double tt_mjd(double mjdUtc) {
    double a1 = 0, a2 = 0, t1 = 0, t2 = 0;
    eraUtctai(2400000.5, mjdUtc, &a1, &a2);
    eraTaitt(a1, a2, &t1, &t2);
    return (t1 - 2400000.5) + t2;
  }
  double first = 0;
  std::vector<std::array<double, 3>> s;
};

// A point of a set's trajectory: the JB2008 point and the decay weight q =
// (a^2 / mu) |v_r| (v . v_r) in m^2/s, so that da/dt = -B rho q. rv, when
// given, receives the TEME state (km, km/s). Returns kPointFailed (SGP4
// refused, below 90 km, or outside the drivers), kPointOk, or kPointAbove:
// above 2500 km, JB2008's ceiling here, where the point adds no drag.
constexpr int kPointFailed = 0, kPointOk = 1, kPointAbove = 2;
int trajectory_point(ElementSet& set, double mjd, const Jb2008Table& table, const SunTable& sun, Point& p, double& q, double* rv) {
  double r[3], v[3];
  if (!SGP4Funcs::sgp4(set.rec, (mjd - set.mjd) * 1440.0, r, v) || set.rec.error != 0) return kPointFailed;
  const double rm[3] = {r[0] * 1e3, r[1] * 1e3, r[2] * 1e3}, vm[3] = {v[0] * 1e3, v[1] * 1e3, v[2] * 1e3};
  const double rr = std::sqrt(rm[0] * rm[0] + rm[1] * rm[1] + rm[2] * rm[2]), vv = vm[0] * vm[0] + vm[1] * vm[1] + vm[2] * vm[2];
  const double a = 1.0 / (2.0 / rr - vv / kMu);
  const double vr[3] = {vm[0] + kOmegaEarth * rm[1], vm[1] - kOmegaEarth * rm[0], vm[2]};
  const double vrn = std::sqrt(vr[0] * vr[0] + vr[1] * vr[1] + vr[2] * vr[2]);
  q = a * a / kMu * vrn * (vm[0] * vr[0] + vm[1] * vr[1] + vm[2] * vr[2]);
  const double g = SGP4Funcs::gstime_SGP4(mjd + 2400000.5);
  const double cg = std::cos(g), sg = std::sin(g);
  double ef[3] = {cg * rm[0] + sg * rm[1], -sg * rm[0] + cg * rm[1], rm[2]};
  double elong = 0, phi = 0, height = 0;
  if (eraGc2gd(1, ef, &elong, &phi, &height) != 0) return kPointFailed;
  p = Point{};
  p.mjd = mjd;
  p.lon = std::remainder(elong, 2 * kPi);
  p.lat = phi;
  p.altM = height;
  if (rv)
    for (int i = 0; i < 3; ++i) { rv[i] = r[i]; rv[3 + i] = v[i]; }
  if (p.altM > 2500e3) return kPointAbove;
  if (!(p.altM >= 90e3) || !table.at(mjd, p.in) || !sun.at(mjd, p.sunLon, p.sunLat)) return kPointFailed;
  p.ok = true;
  return kPointOk;
}

// One stretch of a set's trajectory, from its epoch (or a later instant) to
// the next set's epoch. D is the integral of -rho q dt (m per unit B), so
// that the drag change in mean semi-major axis is B * D; G is dD/d(value) over
// the correction nodes [j0, j1] x P.
struct Segment {
  int set = 0;
  double from = 0, to = 0, D = 0, altSum = 0, altCount = 0;
  int j0 = 0, j1 = -1;
  std::vector<double> G;
  bool ok = false;
};
bool integrate(ElementSet& set, Segment& sg, double stepS, const Jb2008Table& table, const SunTable& sun, const NodeCorrection& corr,
               bool gradient, json* samples) {
  const double span = (sg.to - sg.from) * 86400.0;
  const int n = std::max(1, int(std::ceil(span / stepS - 1e-9)));
  const double h = span / n;
  const int P = corr.P();
  sg.D = sg.altSum = sg.altCount = 0;
  sg.ok = false;
  if (gradient) {
    int ja = 0, jb = 0;
    double w = 0;
    corr.timeWeight(sg.from, ja, w);
    corr.timeWeight(sg.to, jb, w);
    sg.j0 = ja;
    sg.j1 = std::min(corr.M() - 1, jb + 1);
    sg.G.assign(size_t(sg.j1 - sg.j0 + 1) * P, 0.0);
  }
  Point p;
  for (int k = 0; k <= n; ++k) {
    const double mjd = sg.from + k * h / 86400.0;
    double q = 0, rv[6];
    const int status = trajectory_point(set, mjd, table, sun, p, q, samples ? rv : nullptr);
    if (status == kPointFailed) return false;
    if (status == kPointAbove) continue;
    int idx[4];
    double wgt[4];
    const double dT = corr.at(mjd, p.altM / 1000.0, idx, wgt);
    const double rho = rho_at(p, dT);
    if (!positive(rho)) return false;
    const double c = (k == 0 || k == n ? 0.5 : 1.0) * h;
    sg.D -= c * q * rho;
    sg.altSum += p.altM / 1000.0;
    sg.altCount += 1;
    if (gradient) {
      const double g = (std::log(rho_at(p, dT + 1.0)) - std::log(rho_at(p, dT - 1.0))) / 2.0;
      for (int m = 0; m < 4; ++m) {
        if (wgt[m] == 0) continue;
        const int j = idx[m] / P, a = idx[m] % P;
        sg.G[size_t(j - sg.j0) * P + a] -= c * q * rho * g * wgt[m];
      }
    }
    if (samples)
      samples->push_back({{"mjd", mjd}, {"temeKm", {rv[0], rv[1], rv[2]}}, {"temeKmS", {rv[3], rv[4], rv[5]}}, {"latDeg", p.lat / kDeg},
                          {"lonDeg", p.lon / kDeg}, {"altKm", p.altM / 1000.0}, {"rho", rho}, {"qM2S", q}});
  }
  sg.ok = true;
  return true;
}

// An object: its element sets in epoch order, split into chains where two
// sets are more than maxGapDays apart (each chain has its own offset a0), and
// the segments joining consecutive sets of a chain.
struct Object {
  std::string id;
  std::vector<ElementSet> sets;
  std::vector<std::vector<int>> chains;
  std::vector<std::vector<Segment>> segments;
  std::vector<double> a0;  // per chain, km
  double lnB = 0, lnBPrior = 0, lnBSigma = 0, sigmaM = 0;
  json refused = json::array();
  std::vector<double> residualM;  // per set (NaN when not in a chain)
  std::vector<char> use;          // per set
};
std::string load_object(const json& o, double fromMjd, double toMjd, double maxGapDays, Object& out) {
  out.id = o.contains("id") ? (o["id"].is_string() ? o["id"].get<std::string>() : o["id"].dump()) : std::string();
  const json& sets = o.value("sets", json::array());
  if (!sets.is_array()) return "objects[].sets must be an array.";
  std::vector<ElementSet> all;
  for (size_t k = 0; k < sets.size(); ++k) {
    ElementSet s;
    const std::string e = load_set(sets[k], s);
    if (e == "fields")
      return "each element set needs mjd (UTC), MEAN_MOTION (rev/day), ECCENTRICITY, INCLINATION, RA_OF_ASC_NODE, ARG_OF_PERICENTER, "
             "MEAN_ANOMALY (deg) and BSTAR (1/earth radii).";
    if (!e.empty()) {
      out.refused.push_back({{"index", k}, {"reason", e}});
      continue;
    }
    if (s.mjd < fromMjd || s.mjd > toMjd) continue;
    all.push_back(s);
  }
  std::stable_sort(all.begin(), all.end(), [](const ElementSet& a, const ElementSet& b) { return a.mjd < b.mjd; });
  for (const ElementSet& s : all)
    if (out.sets.empty() || s.mjd > out.sets.back().mjd + 60.0 / 86400.0) out.sets.push_back(s);
  for (size_t k = 0; k < out.sets.size(); ++k) {
    if (k == 0 || out.sets[k].mjd - out.sets[k - 1].mjd > maxGapDays) out.chains.push_back({});
    out.chains.back().push_back(int(k));
  }
  out.segments.resize(out.chains.size());
  for (size_t c = 0; c < out.chains.size(); ++c)
    for (size_t k = 0; k + 1 < out.chains[c].size(); ++k) {
      Segment sg;
      sg.set = out.chains[c][k];
      sg.from = out.sets[sg.set].mjd;
      sg.to = out.sets[out.chains[c][k + 1]].mjd;
      out.segments[c].push_back(sg);
    }
  out.a0.assign(out.chains.size(), 0.0);
  out.residualM.assign(out.sets.size(), std::numeric_limits<double>::quiet_NaN());
  out.use.assign(out.sets.size(), 1);
  if (o.contains("lnBPrior") && o["lnBPrior"].is_object()) {
    out.lnBPrior = o["lnBPrior"].value("mean", 0.0);
    out.lnBSigma = o["lnBPrior"].value("sigma", 0.0);
    if (!finite(out.lnBPrior) || !(out.lnBSigma >= 0)) return "objects[].lnBPrior needs a finite mean and a sigma >= 0.";
  }
  return "";
}
// Integrates every segment of an object; false if any fails.
bool integrate_object(Object& ob, double stepS, const Jb2008Table& table, const SunTable& sun, const NodeCorrection& corr, bool gradient) {
  for (auto& chain : ob.segments)
    for (Segment& sg : chain)
      if (!integrate(ob.sets[sg.set], sg, stepS, table, sun, corr, gradient, nullptr)) return false;
  return true;
}
double mean_altitude(const Object& ob) {
  double s = 0, n = 0;
  for (const auto& chain : ob.segments)
    for (const Segment& sg : chain) { s += sg.altSum; n += sg.altCount; }
  return n > 0 ? s / n : std::numeric_limits<double>::quiet_NaN();
}
// Residuals (m) of every set against a0 + B * cumulative D; per-chain index of
// sets; returns the number of sets in chains.
void residuals(Object& ob) {
  const double B = std::exp(ob.lnB);
  for (size_t c = 0; c < ob.chains.size(); ++c) {
    double cum = 0;
    for (size_t k = 0; k < ob.chains[c].size(); ++k) {
      if (k > 0) cum += ob.segments[c][k - 1].D;
      const int s = ob.chains[c][k];
      ob.residualM[s] = (ob.sets[s].aKm - ob.a0[c]) * 1000.0 - B * cum;
    }
  }
}
// Robust scale (1.4826 MAD about the median) of an object's residuals; with
// edit > 0, sets beyond edit robust sigmas of the median are left out.
void robust_sigma(Object& ob, double floorM, double edit) {
  std::vector<double> r;
  for (double x : ob.residualM) if (finite(x)) r.push_back(x);
  if (r.empty()) { ob.sigmaM = floorM; return; }
  const double centre = median_of(r);
  for (double& x : r) x -= centre;
  const double scale = 1.4826 * median_abs(r);
  ob.sigmaM = std::max(floorM, scale);
  if (edit > 0)
    for (size_t s = 0; s < ob.residualM.size(); ++s)
      ob.use[s] = finite(ob.residualM[s]) && std::abs(ob.residualM[s] - centre) <= edit * ob.sigmaM ? 1 : 0;
}

}  // namespace

// evaluate: {points|raw, jb2008, correction?, derivative?} ->
// {density [kg/m^3], deltaT [K], dLnRhoDT [1/K] (with derivative), lstHours,
// sunLonDeg and sunLatDeg (with diagnostics; the Sun's Earth-fixed direction), refused}
extern "C" int evaluate() {
  const json request = json_input("request");
  if (request.is_discarded() || !request.is_object()) return fail("invalid-request", "request must be a JSON object.");
  std::vector<Point> points;
  std::string e = load_points(request, points);
  if (!e.empty()) return fail("invalid-request", e);
  Correction correction;
  if (request.contains("correction")) {
    e = correction.load(request["correction"]);
    if (!e.empty()) return fail("invalid-correction", e);
  }
  const bool derivative = request.value("derivative", false), diagnostics = request.value("diagnostics", false);
  json density = json::array(), deltaT = json::array(), dlog = json::array(), lst = json::array(), refused = json::array();
  json sunLon = json::array(), sunLat = json::array();
  for (size_t i = 0; i < points.size(); ++i) {
    const Point& p = points[i];
    if (!p.ok) {
      refused.push_back(i);
      density.push_back(nullptr); deltaT.push_back(nullptr); lst.push_back(nullptr);
      if (derivative) dlog.push_back(nullptr);
      if (diagnostics) { sunLon.push_back(nullptr); sunLat.push_back(nullptr); }
      continue;
    }
    const double dT = correction.at(p);
    const double rho = rho_at(p, dT);
    density.push_back(rho);
    deltaT.push_back(dT);
    lst.push_back(std::fmod(12.0 + hour_angle(p) / kPi * 12.0 + 24.0, 24.0));
    if (derivative) dlog.push_back((std::log(rho_at(p, dT + 1.0)) - std::log(rho_at(p, dT - 1.0))) / 2.0);
    if (diagnostics) { sunLon.push_back(p.sunLon / kDeg); sunLat.push_back(p.sunLat / kDeg); }
  }
  json out = {{"kind", "jb2008-densities"}, {"version", 1}, {"density", density}, {"deltaT", deltaT}, {"lstHours", lst}, {"refused", refused}};
  if (derivative) out["dLnRhoDT"] = dlog;
  if (diagnostics) { out["sunLonDeg"] = sunLon; out["sunLatDeg"] = sunLat; }
  return emit("result", out);
}

// calibrate: {points + rho (+ weight) | raw + rho, jb2008, degree, binHours,
// fromMjd, toMjd, logSigma, priorSigmaK [per degree], minPoints, iterations,
// editSigma} -> {bins: [{fromMjd, toMjd, n, used, coefficients, sigmas,
// prefitRms, postfitRms, iterations, converged}]}
extern "C" int calibrate() {
  const json request = json_input("request");
  if (request.is_discarded() || !request.is_object()) return fail("invalid-request", "request must be a JSON object.");
  std::vector<Point> points;
  std::string e = load_points(request, points);
  if (!e.empty()) return fail("invalid-request", e);
  const json rhoJson = request.contains("raw") ? json(nullptr) : request["points"].value("rho", json::array());
  std::vector<double> rho(points.size(), 0.0), weight(points.size(), 1.0);
  if (request.contains("raw")) {
    for (size_t i = 0; i < points.size(); ++i) rho[i] = request["raw"][i].value("rho", 0.0);
  } else {
    if (!rhoJson.is_array() || rhoJson.size() != points.size()) return fail("invalid-request", "points.rho must have one value per point.");
    for (size_t i = 0; i < points.size(); ++i) rho[i] = rhoJson[i].is_number() ? rhoJson[i].get<double>() : 0.0;
    const json w = request["points"].value("weight", json::array());
    if (w.is_array() && w.size() == points.size())
      for (size_t i = 0; i < points.size(); ++i) weight[i] = w[i].is_number() ? w[i].get<double>() : 0.0;
  }
  const int degree = request.value("degree", 0);
  if (degree < 0 || degree > 8) return fail("invalid-request", "degree must be 0-8.");
  const int K = basis_size(degree);
  const double binDays = request.value("binHours", 3.0) / 24.0;
  const double from = request.value("fromMjd", 0.0), to = request.value("toMjd", 0.0);
  if (!(binDays > 0) || !(to > from)) return fail("invalid-request", "binHours > 0 and toMjd > fromMjd are required.");
  const double logSigma = request.value("logSigma", 0.1);
  std::vector<double> priorSigma(degree + 1, 100.0);
  if (request.contains("priorSigmaK")) {
    const json& ps = request["priorSigmaK"];
    if (!ps.is_array() || int(ps.size()) != degree + 1) return fail("invalid-request", "priorSigmaK needs one value per degree.");
    for (int l = 0; l <= degree; ++l) priorSigma[l] = ps[l];
  }
  const int minPoints = request.value("minPoints", 30), maxIterations = request.value("iterations", 10);
  const double editSigma = request.value("editSigma", 4.0);
  std::vector<double> priorDiag(K);
  for (int l = 0, k = 0; l <= degree; ++l)
    for (int c = 0; c < 2 * l + 1; ++c, ++k) priorDiag[k] = 1.0 / (priorSigma[l] * priorSigma[l]);

  const long nBins = long(std::ceil((to - from) / binDays - 1e-9));
  std::vector<std::vector<size_t>> members(nBins);
  for (size_t i = 0; i < points.size(); ++i) {
    if (!points[i].ok || !positive(rho[i]) || !(weight[i] > 0)) continue;
    const long b = long(std::floor((points[i].mjd - from) / binDays));
    if (b >= 0 && b < nBins) members[b].push_back(i);
  }
  json bins = json::array();
  std::vector<double> y(K);
  for (long b = 0; b < nBins; ++b) {
    const std::vector<size_t>& idx = members[b];
    json bin = {{"fromMjd", from + b * binDays}, {"toMjd", from + (b + 1) * binDays}, {"n", idx.size()}};
    if (long(idx.size()) < minPoints) {
      bin["coefficients"] = nullptr;
      bins.push_back(bin);
      continue;
    }
    std::vector<double> c(K, 0.0), r(idx.size()), g(idx.size());
    std::vector<char> use(idx.size(), 1);
    std::vector<std::vector<double>> Y(idx.size(), std::vector<double>(K));
    for (size_t j = 0; j < idx.size(); ++j) basis(degree, points[idx[j]].lat, hour_angle(points[idx[j]]), Y[j].data());
    const auto residuals = [&]() {
      for (size_t j = 0; j < idx.size(); ++j) {
        const Point& p = points[idx[j]];
        double dT = 0;
        for (int k = 0; k < K; ++k) dT += c[k] * Y[j][k];
        const double model = rho_at(p, dT);
        r[j] = std::log(rho[idx[j]]) - std::log(model);
        g[j] = (std::log(rho_at(p, dT + 1.0)) - std::log(rho_at(p, dT - 1.0))) / 2.0;
      }
    };
    const auto rms = [&]() {
      double s = 0, w = 0;
      for (size_t j = 0; j < idx.size(); ++j) if (use[j]) { s += weight[idx[j]] * r[j] * r[j]; w += weight[idx[j]]; }
      return w > 0 ? std::sqrt(s / w) : 0.0;
    };
    residuals();
    const double prefit = rms();
    int iterations = 0;
    bool converged = false;
    std::vector<double> inverse;
    for (; iterations < maxIterations; ++iterations) {
      if (iterations >= 1 && editSigma > 0) {
        std::vector<double> kept;
        for (size_t j = 0; j < idx.size(); ++j) kept.push_back(r[j]);
        double centre = 0;
        { std::vector<double> s = kept; std::nth_element(s.begin(), s.begin() + s.size() / 2, s.end()); centre = s[s.size() / 2]; }
        for (double& x : kept) x -= centre;
        const double robust = 1.4826 * median_abs(kept);
        for (size_t j = 0; j < idx.size(); ++j) use[j] = robust > 0 ? std::abs(r[j] - centre) <= editSigma * robust : 1;
      }
      std::vector<double> A(K * K, 0.0), rhs(K, 0.0);
      for (size_t j = 0; j < idx.size(); ++j) {
        if (!use[j]) continue;
        const double w = weight[idx[j]] / (logSigma * logSigma);
        for (int a = 0; a < K; ++a) {
          const double ja = g[j] * Y[j][a];
          rhs[a] += w * ja * r[j];
          for (int bb = 0; bb <= a; ++bb) A[a * K + bb] += w * ja * g[j] * Y[j][bb];
        }
      }
      for (int a = 0; a < K; ++a) {
        for (int bb = 0; bb < a; ++bb) A[bb * K + a] = A[a * K + bb];
        A[a * K + a] += priorDiag[a];
        rhs[a] -= priorDiag[a] * c[a];
      }
      if (!cholesky_solve(A, rhs, K, &inverse)) break;
      double largest = 0;
      for (int a = 0; a < K; ++a) {
        const double step = std::max(-200.0, std::min(200.0, rhs[a]));
        c[a] += step;
        largest = std::max(largest, std::abs(step));
      }
      residuals();
      if (largest < 0.01) { converged = true; ++iterations; break; }
    }
    long used = 0;
    for (char u : use) used += u;
    json sigmas = json::array();
    for (int a = 0; a < K; ++a) sigmas.push_back(inverse.empty() ? json(nullptr) : json(std::sqrt(inverse[a * K + a])));
    bin["used"] = used;
    bin["coefficients"] = c;
    bin["sigmas"] = sigmas;
    bin["prefitRms"] = prefit;
    bin["postfitRms"] = rms();
    bin["iterations"] = iterations;
    bin["converged"] = converged;
    bins.push_back(bin);
  }
  return emit("calibration", {{"kind", "jb2008-dt-calibration"}, {"version", 1}, {"degree", degree}, {"binHours", binDays * 24.0},
                              {"logSigma", logSigma}, {"priorSigmaK", priorSigma}, {"bins", bins}});
}

namespace {
// The drivers of a decay request; empty string or the reason.
std::string load_drivers(const json& request, Jb2008Table& table) {
  if (!request.contains("jb2008") || !request["jb2008"].is_object()) return "jb2008 {rows} is required.";
  return table.add(request["jb2008"].value("rows", json::array()));
}
// The UTC span of every set (and, for decay, its one-set span) for the Sun table.
void set_span(const std::vector<Object>& objects, double extraDays, double& lo, double& hi) {
  lo = std::numeric_limits<double>::infinity();
  hi = -lo;
  for (const Object& ob : objects)
    for (const ElementSet& s : ob.sets) { lo = std::min(lo, s.mjd); hi = std::max(hi, s.mjd + extraDays); }
}
}  // namespace

// decay: the forward model. {jb2008, objects: [{id, sets, B? (m^2/kg, default
// 1), spanDays? (one set: integrate it alone over this span)}], correction?
// (time nodes), stepSeconds?, maxGapDays?, samples?} -> per object the sets'
// mean semi-major axes, the drag change over each segment (B * D) and its
// cumulative sum at each set, the mean geodetic altitude, and with samples
// every trajectory point (TEME state, geodetic point, density, q).
extern "C" int decay() {
  const json request = json_input("request");
  if (request.is_discarded() || !request.is_object()) return fail("invalid-request", "request must be a JSON object.");
  Jb2008Table table;
  std::string e = load_drivers(request, table);
  if (!e.empty()) return fail("invalid-request", e);
  NodeCorrection corr;
  if (request.contains("correction")) {
    e = corr.load(request["correction"]);
    if (!e.empty()) return fail("invalid-correction", e);
  } else {
    corr.t = {0.0};
    corr.v = {0.0};
  }
  const double stepS = request.value("stepSeconds", 60.0), maxGap = request.value("maxGapDays", 3.0);
  if (!(stepS >= 1 && stepS <= 600)) return fail("invalid-request", "stepSeconds must be 1-600.");
  const bool wantSamples = request.value("samples", false);
  const json& list = request.value("objects", json::array());
  if (!list.is_array() || list.empty()) return fail("invalid-request", "objects must be a non-empty array.");
  std::vector<Object> objects(list.size());
  std::vector<double> span(list.size(), 0.0), B(list.size(), 1.0);
  double extra = 0;
  for (size_t i = 0; i < list.size(); ++i) {
    e = load_object(list[i], -1e9, 1e9, maxGap, objects[i]);
    if (!e.empty()) return fail("invalid-request", e);
    span[i] = list[i].value("spanDays", 0.0);
    B[i] = list[i].value("B", 1.0);
    if (!(span[i] >= 0 && span[i] <= 30) || !positive(B[i])) return fail("invalid-request", "spanDays must be 0-30 and B positive.");
    if (objects[i].sets.size() == 1 && span[i] > 0) {
      Segment sg;
      sg.set = 0;
      sg.from = objects[i].sets[0].mjd;
      sg.to = sg.from + span[i];
      objects[i].segments[0].push_back(sg);
    }
    extra = std::max(extra, span[i]);
  }
  double lo = 0, hi = 0;
  set_span(objects, extra, lo, hi);
  SunTable sun;
  sun.build(lo - 0.1, hi + 0.1);
  json out = json::array();
  for (size_t i = 0; i < objects.size(); ++i) {
    Object& ob = objects[i];
    json samples = json::array(), segs = json::array(), sets = json::array();
    std::vector<double> cumulative(ob.sets.size(), std::numeric_limits<double>::quiet_NaN());
    bool ok = true;
    for (size_t c = 0; c < ob.chains.size() && ok; ++c) {
      double cum = 0;
      cumulative[ob.chains[c][0]] = 0;
      for (size_t k = 0; k < ob.segments[c].size(); ++k) {
        Segment& sg = ob.segments[c][k];
        if (!integrate(ob.sets[sg.set], sg, stepS, table, sun, corr, false, wantSamples ? &samples : nullptr)) { ok = false; break; }
        cum += B[i] * sg.D;
        if (k + 1 < ob.chains[c].size()) cumulative[ob.chains[c][k + 1]] = cum;
        segs.push_back({{"fromMjd", sg.from}, {"toMjd", sg.to}, {"decayM", B[i] * sg.D}, {"meanAltitudeKm", sg.altSum / std::max(1.0, sg.altCount)}});
      }
    }
    for (size_t k = 0; k < ob.sets.size(); ++k)
      sets.push_back({{"mjd", ob.sets[k].mjd}, {"aKm", ob.sets[k].aKm}, {"perigeeKm", ob.sets[k].perigeeKm}, {"eccentricity", ob.sets[k].ecc},
                      {"cumulativeDecayM", std::isfinite(cumulative[k]) ? json(cumulative[k]) : json(nullptr)}});
    json o = {{"id", ob.id}, {"ok", ok}, {"B", B[i]}, {"sets", sets}, {"segments", segs}, {"refused", ob.refused},
              {"meanAltitudeKm", ok ? json(mean_altitude(ob)) : json(nullptr)}};
    if (wantSamples) o["samples"] = samples;
    out.push_back(o);
  }
  return emit("result", {{"kind", "jb2008-orbit-decay"}, {"version", 1}, {"objects", out}});
}

// calibrate_decay: the temperature correction (time nodes, optionally linear
// in altitude) and every object's ballistic coefficient, from the objects'
// element-set histories: Gauss-Newton on the sets' mean semi-major axes,
//   a_k = a0_chain + B * sum over the segments before k of D(correction),
// weighted by each object's robust residual scale, with a random-walk prior
// on the correction, a prior on its mean level, an optional prior tying
// altitude nodes, and each object's prior on ln B (anchors: known area to
// mass). {jb2008, objects: [{id, sets, lnBPrior? {mean, sigma}}], nodes:
// {fromMjd, toMjd, stepHours, altitudeKm?}, priors: {randomWalkKPerSqrtDay,
// meanLevelK, altitudeDifferenceK?}, stepSeconds?, maxGapDays?, sigmaFloorM?,
// editSigma?, iterations?, minSets?, residuals?}
extern "C" int calibrate_decay() {
  const json request = json_input("request");
  if (request.is_discarded() || !request.is_object()) return fail("invalid-request", "request must be a JSON object.");
  Jb2008Table table;
  std::string e = load_drivers(request, table);
  if (!e.empty()) return fail("invalid-request", e);
  const json& nodes = request.value("nodes", json::object());
  const double from = nodes.value("fromMjd", 0.0), to = nodes.value("toMjd", 0.0), stepH = nodes.value("stepHours", 6.0);
  if (!(to > from) || !(stepH > 0)) return fail("invalid-request", "nodes {fromMjd, toMjd > fromMjd, stepHours > 0} is required.");
  NodeCorrection corr;
  const int M = int(std::ceil((to - from) / (stepH / 24.0) - 1e-9)) + 1;
  if (M > 4000) return fail("invalid-request", "too many correction nodes.");
  for (int j = 0; j < M; ++j) corr.t.push_back(from + j * stepH / 24.0);
  for (const json& a : nodes.value("altitudeKm", json::array())) corr.alt.push_back(a.is_number() ? a.get<double>() : -1.0);
  if (corr.alt.size() == 1) return fail("invalid-request", "nodes.altitudeKm needs none (global) or at least two altitudes.");
  for (size_t a = 1; a < corr.alt.size(); ++a)
    if (!(corr.alt[a] > corr.alt[a - 1])) return fail("invalid-request", "nodes.altitudeKm must increase.");
  const int P = corr.P(), nTheta = M * P;
  corr.v.assign(size_t(nTheta), 0.0);
  const json& priors = request.value("priors", json::object());
  const double rw = priors.value("randomWalkKPerSqrtDay", 30.0), meanK = priors.value("meanLevelK", 150.0), diffK = priors.value("altitudeDifferenceK", 100.0);
  if (!positive(rw) || !positive(meanK) || !positive(diffK)) return fail("invalid-request", "priors must be positive.");
  const double stepS = request.value("stepSeconds", 60.0), maxGap = request.value("maxGapDays", 3.0), floorM = request.value("sigmaFloorM", 1.0);
  const double edit = request.value("editSigma", 4.0);
  const int maxIt = request.value("iterations", 10), minSets = request.value("minSets", 5);
  const json& tol = request.value("tolerance", json::object());
  const double tolK = tol.value("K", 0.5), tolLnB = tol.value("lnB", 1e-3), tolA0 = tol.value("a0M", 0.1);
  if (!positive(tolK) || !positive(tolLnB) || !positive(tolA0)) return fail("invalid-request", "tolerance {K, lnB, a0M} must be positive.");
  json history = json::array();
  const bool wantResiduals = request.value("residuals", false);
  if (!(stepS >= 1 && stepS <= 600) || !positive(floorM)) return fail("invalid-request", "stepSeconds must be 1-600 and sigmaFloorM positive.");

  // Objects: sets inside the node span, chains of at least two sets.
  const json& list = request.value("objects", json::array());
  if (!list.is_array()) return fail("invalid-request", "objects must be an array.");
  std::vector<Object> objects;
  json skipped = json::array();
  for (const json& o : list) {
    Object ob;
    e = load_object(o, from, to, maxGap, ob);
    if (!e.empty()) return fail("invalid-request", e);
    std::vector<std::vector<int>> chains;
    std::vector<std::vector<Segment>> segments;
    size_t used = 0;
    for (size_t c = 0; c < ob.chains.size(); ++c) {
      if (ob.chains[c].size() < 2) {
        for (int s : ob.chains[c]) ob.use[s] = 0;
        continue;
      }
      chains.push_back(ob.chains[c]);
      segments.push_back(ob.segments[c]);
      used += ob.chains[c].size();
    }
    ob.chains = chains;
    ob.segments = segments;
    ob.a0.assign(chains.size(), 0.0);
    if (int(used) < minSets) {
      skipped.push_back({{"id", ob.id}, {"reason", "fewer than minSets sets in chains"}, {"sets", used}});
      continue;
    }
    if (!(ob.lnBSigma > 0)) ob.lnBSigma = 0;
    objects.push_back(std::move(ob));
  }
  double lo = 0, hi = 0;
  set_span(objects, 0.0, lo, hi);
  if (objects.empty()) return fail("invalid-request", "no object has enough element sets in the node span.");
  SunTable sun;
  sun.build(std::min(lo, from) - 0.1, std::max(hi, to) + 0.1);

  // Start: the correction at zero, each object's B and offsets by linear least
  // squares; an object whose drag cannot be resolved starts at its prior (or
  // at Cd A/m = 12.741621 B*, or 0.01 m^2/kg) and keeps a weak prior.
  std::vector<Object> kept;
  for (Object& ob : objects) {
    if (!integrate_object(ob, stepS, table, sun, corr, false)) {
      skipped.push_back({{"id", ob.id}, {"reason", "trajectory outside the drivers, below 90 km or refused by SGP4"}});
      continue;
    }
    double sxx = 0, sxy = 0;
    std::vector<double> xm(ob.chains.size(), 0.0), ym(ob.chains.size(), 0.0);
    for (size_t c = 0; c < ob.chains.size(); ++c) {
      double cum = 0;
      for (size_t k = 0; k < ob.chains[c].size(); ++k) {
        if (k > 0) cum += ob.segments[c][k - 1].D;
        xm[c] += cum / ob.chains[c].size();
        ym[c] += ob.sets[ob.chains[c][k]].aKm * 1000.0 / ob.chains[c].size();
      }
      cum = 0;
      for (size_t k = 0; k < ob.chains[c].size(); ++k) {
        if (k > 0) cum += ob.segments[c][k - 1].D;
        sxx += (cum - xm[c]) * (cum - xm[c]);
        sxy += (cum - xm[c]) * (ob.sets[ob.chains[c][k]].aKm * 1000.0 - ym[c]);
      }
    }
    double B = sxx > 0 ? sxy / sxx : 0;
    if (!positive(B)) B = ob.lnBSigma > 0 ? std::exp(ob.lnBPrior) : (ob.sets[0].bstar > 1e-6 ? 12.741621 * ob.sets[0].bstar : 0.01);
    if (!(ob.lnBSigma > 0)) { ob.lnBPrior = std::log(B); ob.lnBSigma = 10.0; }
    ob.lnB = std::log(B);
    for (size_t c = 0; c < ob.chains.size(); ++c) ob.a0[c] = (ym[c] - B * xm[c]) / 1000.0;
    residuals(ob);
    robust_sigma(ob, floorM, 0);
    kept.push_back(std::move(ob));
  }
  objects = std::move(kept);
  if (objects.empty()) return fail("invalid-request", "no object could be integrated.");
  std::vector<double> prefit(objects.size(), 0.0);
  for (size_t i = 0; i < objects.size(); ++i) {
    double s = 0, n = 0;
    for (double r : objects[i].residualM) if (std::isfinite(r)) { s += r * r; ++n; }
    prefit[i] = n > 0 ? std::sqrt(s / n) : 0;
  }

  // Parameters: the correction, then ln B per object, then a0 per chain (m).
  const int N = int(objects.size());
  std::vector<int> chainBase(N, 0);
  int C = 0;
  for (int i = 0; i < N; ++i) { chainBase[i] = nTheta + N + C; C += int(objects[i].chains.size()); }
  const int n = nTheta + N + C;
  if (n > 6000) return fail("invalid-request", "too many parameters (nodes x altitudes + objects + chains > 6000).");
  std::vector<double> NM, rhs;
  int iterations = 0;
  bool converged = false;
  double chi2 = 0;
  long observations = 0;
  const double stepDays = stepH / 24.0;
  const auto build = [&]() {
    NM.assign(size_t(n) * n, 0.0);
    rhs.assign(n, 0.0);
    chi2 = 0;
    observations = 0;
    for (int i = 0; i < N; ++i) {
      Object& ob = objects[i];
      const double B = std::exp(ob.lnB), w = 1.0 / (ob.sigmaM * ob.sigmaM);
      const int iB = nTheta + i;
      for (size_t c = 0; c < ob.chains.size(); ++c) {
        const auto& segs = ob.segments[c];
        const int jlo = segs.front().j0, jhi = segs.back().j1, ia0 = chainBase[i] + int(c);
        std::vector<double> cumG(size_t(jhi - jlo + 1) * P, 0.0);
        double cumD = 0;
        int top = jlo - 1;
        for (size_t k = 0; k < ob.chains[c].size(); ++k) {
          if (k > 0) {
            const Segment& sg = segs[k - 1];
            cumD += sg.D;
            for (int j = sg.j0; j <= sg.j1; ++j)
              for (int a = 0; a < P; ++a) cumG[size_t(j - jlo) * P + a] += sg.G[size_t(j - sg.j0) * P + a];
            top = std::max(top, sg.j1);
          }
          const int s = ob.chains[c][k];
          if (!ob.use[s]) continue;
          const double r = ob.residualM[s], A = B * cumD;
          chi2 += w * r * r;
          ++observations;
          const int L = jlo * P, len = (top - jlo + 1) * P;
          for (int u = 0; u < len; ++u) {
            const double xu = B * cumG[u];
            if (xu == 0) continue;
            double* row = &NM[size_t(L + u) * n + L];
            const double wx = w * xu;
            for (int v = 0; v <= u; ++v) row[v] += wx * B * cumG[v];
            rhs[L + u] += wx * r;
            NM[size_t(iB) * n + (L + u)] += wx * A;
            NM[size_t(ia0) * n + (L + u)] += wx;
          }
          NM[size_t(iB) * n + iB] += w * A * A;
          NM[size_t(ia0) * n + ia0] += w;
          NM[size_t(ia0) * n + iB] += w * A;
          rhs[iB] += w * A * r;
          rhs[ia0] += w * r;
        }
      }
      // ln B prior.
      const double s2 = ob.lnBSigma * ob.lnBSigma;
      NM[size_t(iB) * n + iB] += 1.0 / s2;
      rhs[iB] -= (ob.lnB - ob.lnBPrior) / s2;
    }
    // Random walk between consecutive nodes, per altitude node.
    const double qrw = rw * rw * stepDays;
    for (int a = 0; a < P; ++a)
      for (int j = 0; j + 1 < M; ++j) {
        const int i1 = j * P + a, i2 = (j + 1) * P + a;
        const double d = corr.v[i2] - corr.v[i1];
        NM[size_t(i1) * n + i1] += 1 / qrw;
        NM[size_t(i2) * n + i2] += 1 / qrw;
        NM[size_t(i2) * n + i1] -= 1 / qrw;
        rhs[i1] += d / qrw;
        rhs[i2] -= d / qrw;
      }
    // The mean level of each altitude node.
    for (int a = 0; a < P; ++a) {
      double m = 0;
      for (int j = 0; j < M; ++j) m += corr.v[j * P + a] / M;
      const double h = 1.0 / (double(M) * M * meanK * meanK);
      for (int j = 0; j < M; ++j) {
        for (int k = 0; k <= j; ++k) NM[size_t(j * P + a) * n + (k * P + a)] += h;
        rhs[j * P + a] -= m / (double(M) * meanK * meanK);
      }
    }
    // Neighbouring altitude nodes tied loosely at each time node.
    for (int j = 0; j < M; ++j)
      for (int a = 1; a < P; ++a) {
        const int i1 = j * P + a - 1, i2 = j * P + a;
        const double d = corr.v[i2] - corr.v[i1], h = 1.0 / (diffK * diffK);
        NM[size_t(i1) * n + i1] += h;
        NM[size_t(i2) * n + i2] += h;
        NM[size_t(i2) * n + i1] -= h;
        rhs[i1] += d * h;
        rhs[i2] -= d * h;
      }
  };
  for (; iterations < maxIt; ++iterations) {
    bool ok = true;
    for (Object& ob : objects) ok = integrate_object(ob, stepS, table, sun, corr, true) && ok;
    if (!ok) return fail("integration-failed", "a trajectory left the drivers' span during the iterations.");
    for (Object& ob : objects) {
      residuals(ob);
      robust_sigma(ob, floorM, iterations >= 1 ? edit : 0);
    }
    build();
    if (!cholesky_solve(NM, rhs, n, nullptr)) break;
    double big = 0, bigB = 0, bigA = 0;
    for (int k = 0; k < nTheta; ++k) {
      const double step = std::max(-100.0, std::min(100.0, rhs[k]));
      corr.v[k] += step;
      big = std::max(big, std::abs(step));
    }
    for (int i = 0; i < N; ++i) {
      const double step = std::max(-1.0, std::min(1.0, rhs[nTheta + i]));
      objects[i].lnB += step;
      bigB = std::max(bigB, std::abs(step));
      for (size_t c = 0; c < objects[i].chains.size(); ++c) {
        objects[i].a0[c] += rhs[chainBase[i] + c] / 1000.0;
        bigA = std::max(bigA, std::abs(rhs[chainBase[i] + c]));
      }
    }
    history.push_back({{"iteration", iterations + 1}, {"chiSquare", chi2}, {"observations", observations}, {"maxStepK", big}, {"maxStepLnB", bigB}, {"maxStepA0M", bigA}});
    if (big < tolK && bigB < tolLnB && bigA < tolA0) { converged = true; ++iterations; break; }
  }
  // The solution: residuals, scales and the formal covariance there.
  for (Object& ob : objects)
    if (!integrate_object(ob, stepS, table, sun, corr, true)) return fail("integration-failed", "a trajectory left the drivers' span at the solution.");
  for (Object& ob : objects) {
    residuals(ob);
    robust_sigma(ob, floorM, edit);
  }
  build();
  std::vector<double> cov;
  std::vector<double> scratch(rhs);
  const bool haveCov = cholesky_solve(NM, scratch, n, &cov);

  json values = json::array(), sigmas = json::array();
  for (int j = 0; j < M; ++j) {
    json v = json::array(), s = json::array();
    for (int a = 0; a < P; ++a) {
      v.push_back(corr.v[j * P + a]);
      s.push_back(haveCov ? json(std::sqrt(cov[size_t(j * P + a) * n + (j * P + a)])) : json(nullptr));
    }
    values.push_back(v);
    sigmas.push_back(s);
  }
  // Identifiability: the mean level of each altitude node and its formal
  // sigma; the correlation of the overall mean level with the mean ln B.
  json level = json::array();
  double varT = 0, varB = 0, covTB = 0;
  for (int a = 0; a < P; ++a) {
    double m = 0, var = 0;
    for (int j = 0; j < M; ++j) m += corr.v[j * P + a] / M;
    if (haveCov)
      for (int j = 0; j < M; ++j)
        for (int k = 0; k < M; ++k) var += cov[size_t(j * P + a) * n + (k * P + a)] / (double(M) * M);
    level.push_back({{"altitudeKm", P == 1 ? json(nullptr) : json(corr.alt[a])}, {"meanK", m}, {"sigmaK", haveCov ? json(std::sqrt(var)) : json(nullptr)}});
  }
  if (haveCov) {
    for (int u = 0; u < nTheta; ++u)
      for (int v = 0; v < nTheta; ++v) varT += cov[size_t(u) * n + v] / (double(nTheta) * nTheta);
    for (int i = 0; i < N; ++i)
      for (int k = 0; k < N; ++k) varB += cov[size_t(nTheta + i) * n + (nTheta + k)] / (double(N) * N);
    for (int u = 0; u < nTheta; ++u)
      for (int i = 0; i < N; ++i) covTB += cov[size_t(u) * n + (nTheta + i)] / (double(nTheta) * N);
  }
  json objs = json::array();
  for (int i = 0; i < N; ++i) {
    Object& ob = objects[i];
    double s = 0, cnt = 0, obsDecay = 0, modelDecay = 0;
    long used = 0, inChains = 0;
    for (size_t c = 0; c < ob.chains.size(); ++c) {
      obsDecay += (ob.sets[ob.chains[c].back()].aKm - ob.sets[ob.chains[c].front()].aKm) * 1000.0;
      for (const Segment& sg : ob.segments[c]) modelDecay += std::exp(ob.lnB) * sg.D;
      inChains += long(ob.chains[c].size());
    }
    for (size_t k = 0; k < ob.sets.size(); ++k)
      if (std::isfinite(ob.residualM[k]) && ob.use[k]) { s += ob.residualM[k] * ob.residualM[k]; ++cnt; ++used; }
    json o = {{"id", ob.id}, {"sets", inChains}, {"used", used}, {"chains", ob.chains.size()}, {"lnB", ob.lnB},
              {"lnBSigma", haveCov ? json(std::sqrt(cov[size_t(nTheta + i) * n + (nTheta + i)])) : json(nullptr)}, {"B", std::exp(ob.lnB)},
              {"lnBPrior", {{"mean", ob.lnBPrior}, {"sigma", ob.lnBSigma}}}, {"sigmaM", ob.sigmaM}, {"rmsM", cnt > 0 ? std::sqrt(s / cnt) : 0.0},
              {"prefitRmsM", prefit[i]}, {"meanAltitudeKm", mean_altitude(ob)}, {"perigeeKm", ob.sets.front().perigeeKm},
              {"firstMjd", ob.sets[ob.chains.front().front()].mjd}, {"lastMjd", ob.sets[ob.chains.back().back()].mjd},
              {"observedDecayM", obsDecay}, {"modelDecayM", modelDecay}, {"refused", ob.refused}};
    if (wantResiduals) {
      json res = json::array();
      for (size_t k = 0; k < ob.sets.size(); ++k)
        if (std::isfinite(ob.residualM[k])) res.push_back({{"mjd", ob.sets[k].mjd}, {"residualM", ob.residualM[k]}, {"used", ob.use[k] != 0}});
      o["residuals"] = res;
    }
    objs.push_back(o);
  }
  json fit = {{"iterations", iterations}, {"converged", converged}, {"observations", observations}, {"parameters", n}, {"objects", N},
              {"chiSquare", chi2}, {"level", level}, {"history", history},
              {"tolerance", {{"K", tolK}, {"lnB", tolLnB}, {"a0M", tolA0}}},
              {"levelLnBCorrelation", haveCov && varT > 0 && varB > 0 ? json(covTB / std::sqrt(varT * varB)) : json(nullptr)},
              {"meanLevelSigmaK", haveCov ? json(std::sqrt(varT)) : json(nullptr)}};
  json correction = {{"nodesMjd", corr.t}, {"altitudeKm", corr.alt}, {"values", values}, {"sigmas", sigmas}};
  return emit("calibration", {{"kind", "jb2008-decay-calibration"}, {"version", 1}, {"correction", correction}, {"objects", objs},
                              {"skipped", skipped}, {"fit", fit},
                              {"settings", {{"stepSeconds", stepS}, {"maxGapDays", maxGap}, {"sigmaFloorM", floorM}, {"editSigma", edit},
                                            {"priors", {{"randomWalkKPerSqrtDay", rw}, {"meanLevelK", meanK}, {"altitudeDifferenceK", diffK}}}}}});
}
