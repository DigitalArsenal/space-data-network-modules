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

// A correction {degree, segments: [{fromMjd, toMjd, coefficients}]}: the
// segment holding the instant (from <= t < to) applies; none means dT = 0.
struct Correction {
  int degree = 0;
  struct Segment { double from, to; std::vector<double> c; };
  std::vector<Segment> segments;
  std::string load(const json& j) {
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
