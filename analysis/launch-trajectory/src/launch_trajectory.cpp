#include "space_data_module_invoke.h"
#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <string>
#include <vector>

// Launch trajectory reconstruction and projected orbit insertion ($LAM -> $LAM).
//
// Ascent model. The ground track is a great circle on the rotating Earth that
// leaves the pad at one Earth-relative azimuth. Altitude and speed samples fix
// the motion along it: vertical rate from a local quadratic fit of altitude,
// horizontal Earth-relative speed sqrt(v^2 - hdot^2), downrange integrated
// along the circle. The inertial state is the Earth-fixed state plus omega x r,
// rotated by GMST (IAU-82) into TEME. The azimuth is the one whose insertion
// state has the target inclination.
//
// Because the Earth-fixed ascent does not depend on the liftoff time, the
// inclination depends on the azimuth alone and the node advances with GMST:
// a rendezvous launch joins a reference plane where the node longitude plus
// GMST at insertion equals the reference RAAN.
//
// Checked in docs/studies/launch-trajectory-tracking-and-insertion.md against
// the first catalog element sets of 12 Falcon 9 launches: RAAN 0.41 deg RMS
// from broadcast telemetry, 0.21 deg RMS projected from a sister flight.
//
// Nothing here propagates an orbit. Output ends at insertion; the insertion
// state is for whichever propagator the caller composes next.

namespace {
using Json = nlohmann::json;
using Vec3 = std::array<double, 3>;
constexpr double kPi = 3.14159265358979323846;
constexpr double kDeg = kPi / 180.0;
constexpr double kWgsA = 6378137.0;                  // WGS 84 semi-major axis, m
constexpr double kWgsF = 1.0 / 298.257223563;        // WGS 84 flattening
constexpr double kMu = 3.986004418e14;               // Earth GM, m^3/s^2
constexpr double kOmegaEarth = 7.2921150e-5;         // Earth rotation, rad/s
constexpr double kGridStep = 0.25;                   // integration step, s
constexpr double kPoweredAcceleration = 2.0;         // m/s^2, dv/dt above this is powered flight
constexpr double kCoastConfirm = 5.0;                // s of coast that confirm a cutoff
constexpr double kMinInsertionPeriapsis = 80000.0;   // m, periapsis altitude of an orbit
constexpr size_t kMaxSamples = 200000;
constexpr size_t kMaxOutput = 20000;
// One-sigma accuracy measured in the study (13 launches, SGP4 truth at cutoff).
constexpr double kTelemetryRaanSigma = 0.45, kTelemetryArgLatSigma = 0.6;
constexpr double kTelemetryPeriSigma = 2000.0, kTelemetryApoSigma = 20000.0;
constexpr double kProjectedRaanSigma = 0.25, kProjectedArgLatSigma = 1.25;
const char* kModuleName = "com.digitalarsenal.analysis.launch-trajectory";
const char* kModuleVersion = "0.1.0";

const char* error = "Invalid launch trajectory request.";
std::string errorBuffer;
#define NEED(condition, message) do { if (!(condition)) { error = message; return false; } } while (0)

int fail(const char* message) { plugin_set_error("invalid-launch-trajectory-request", message); return 1; }

Vec3 sub(const Vec3& a, const Vec3& b) { return {a[0] - b[0], a[1] - b[1], a[2] - b[2]}; }
Vec3 add(const Vec3& a, const Vec3& b) { return {a[0] + b[0], a[1] + b[1], a[2] + b[2]}; }
Vec3 scale(const Vec3& a, double s) { return {a[0] * s, a[1] * s, a[2] * s}; }
double dot(const Vec3& a, const Vec3& b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
Vec3 cross(const Vec3& a, const Vec3& b) {
  return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
}
double norm(const Vec3& a) { return std::sqrt(dot(a, a)); }
Vec3 unit(const Vec3& a) { return scale(a, 1.0 / norm(a)); }
double wrap360(double deg) { deg = std::fmod(deg, 360.0); return deg < 0 ? deg + 360.0 : deg; }
double wrap180(double deg) { deg = std::fmod(deg + 180.0, 360.0); return (deg < 0 ? deg + 360.0 : deg) - 180.0; }
double nan() { return std::numeric_limits<double>::quiet_NaN(); }

// ── time: UTC seconds since 1970 (no leap-second table) ────────────────────
int64_t daysFromCivil(int64_t y, unsigned m, unsigned d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + static_cast<int64_t>(doe) - 719468;
}
void civilFromDays(int64_t z, int64_t& y, unsigned& m, unsigned& d) {
  z += 719468;
  const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const unsigned doe = static_cast<unsigned>(z - era * 146097);
  const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  y = static_cast<int64_t>(yoe) + era * 400;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const unsigned mp = (5 * doy + 2) / 153;
  d = doy - (153 * mp + 2) / 5 + 1;
  m = mp < 10 ? mp + 3 : mp - 9;
  y += m <= 2;
}
// "YYYY-MM-DDTHH:MM:SS[.f...][Z]"
bool parseIso(const char* text, double& out) {
  if (!text) return false;
  int y, mo, d, h, mi, used = 0;
  double s;
  if (std::sscanf(text, "%4d-%2d-%2dT%2d:%2d:%lf%n", &y, &mo, &d, &h, &mi, &s, &used) != 6) return false;
  const char* rest = text + used;
  if (!(*rest == 0 || (rest[0] == 'Z' && rest[1] == 0))) return false;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || !(s >= 0 && s < 61)) return false;
  out = double(daysFromCivil(y, mo, d)) * 86400.0 + h * 3600.0 + mi * 60.0 + s;
  return true;
}
std::string isoMs(double t) {
  const double rounded = std::round(t * 1000.0) / 1000.0;
  int64_t whole = static_cast<int64_t>(std::floor(rounded));
  int ms = static_cast<int>(std::llround((rounded - double(whole)) * 1000.0));
  if (ms == 1000) { ++whole; ms = 0; }
  const int64_t day = whole >= 0 ? whole / 86400 : (whole - 86399) / 86400;
  const int64_t rem = whole - day * 86400;
  int64_t y; unsigned m, d;
  civilFromDays(day, y, m, d);
  char buffer[40];
  std::snprintf(buffer, sizeof buffer, "%04lld-%02u-%02uT%02lld:%02lld:%02lld.%03dZ", static_cast<long long>(y), m, d,
    static_cast<long long>(rem / 3600), static_cast<long long>(rem % 3600 / 60), static_cast<long long>(rem % 60), ms);
  return buffer;
}
// Greenwich mean sidereal time, IAU-82 (the angle SGP4's TEME is built on),
// with UT1 taken as UTC.
double gmst(double utc) {
  const double t = (utc / 86400.0 + 2440587.5 - 2451545.0) / 36525.0;
  const double s = -6.2e-6 * t * t * t + 0.093104 * t * t + (876600.0 * 3600.0 + 8640184.812866) * t + 67310.54841;
  double g = std::fmod(s * kDeg / 240.0, 2.0 * kPi);
  return g < 0 ? g + 2.0 * kPi : g;
}
Vec3 rotateZ(const Vec3& a, double angle) {
  const double c = std::cos(angle), s = std::sin(angle);
  return {c * a[0] - s * a[1], s * a[0] + c * a[1], a[2]};
}

// ── WGS 84 ──────────────────────────────────────────────────────────────────
constexpr double kE2 = kWgsF * (2.0 - kWgsF);
Vec3 geodeticToEcef(double lat, double lon, double h) {
  const double s = std::sin(lat), c = std::cos(lat), n = kWgsA / std::sqrt(1.0 - kE2 * s * s);
  return {(n + h) * c * std::cos(lon), (n + h) * c * std::sin(lon), (n * (1.0 - kE2) + h) * s};
}
// Bowring's latitude, refined twice.
void ecefToGeodetic(const Vec3& r, double& lat, double& lon, double& h) {
  const double b = kWgsA * (1 - kWgsF), ep2 = kE2 / (1 - kE2), p = std::hypot(r[0], r[1]);
  const double theta = std::atan2(r[2] * kWgsA, p * b);
  lat = std::atan2(r[2] + ep2 * b * std::pow(std::sin(theta), 3), p - kE2 * kWgsA * std::pow(std::cos(theta), 3));
  lon = std::atan2(r[1], r[0]);
  for (int i = 0; i < 2; ++i) {
    const double s = std::sin(lat), n = kWgsA / std::sqrt(1 - kE2 * s * s);
    h = p * std::cos(lat) + r[2] * s - kWgsA * std::sqrt(1 - kE2 * s * s);
    lat = std::atan2(r[2], p * (1 - kE2 * n / (n + h)));
  }
  const double s = std::sin(lat);
  h = p * std::cos(lat) + r[2] * s - kWgsA * std::sqrt(1 - kE2 * s * s);
}

// ── osculating elements (TEME) ──────────────────────────────────────────────
struct Elements {
  double a = nan(), e = nan(), inc = nan(), raan = nan(), argp = nan(), argLat = nan(), peri = nan(), apo = nan();
};
Elements elements(const Vec3& r, const Vec3& v) {
  Elements el;
  const Vec3 h = cross(r, v), n = cross({0, 0, 1}, h);
  const double rm = norm(r), vm = norm(v), hm = norm(h), nm = norm(n);
  if (!(rm > 0) || !(hm > 0)) return el;
  const Vec3 ev = sub(scale(r, vm * vm / kMu - 1.0 / rm), scale(v, dot(r, v) / kMu));
  el.e = norm(ev);
  const double energy = vm * vm / 2.0 - kMu / rm;
  el.inc = std::acos(std::max(-1.0, std::min(1.0, h[2] / hm))) / kDeg;
  if (nm > 1e-9 * hm) {
    el.raan = wrap360(std::atan2(n[1], n[0]) / kDeg);
    double u = std::acos(std::max(-1.0, std::min(1.0, dot(n, r) / (nm * rm)))) / kDeg;
    if (r[2] < 0) u = 360.0 - u;
    el.argLat = u;
    if (el.e > 1e-9) {
      double w = std::acos(std::max(-1.0, std::min(1.0, dot(n, ev) / (nm * el.e)))) / kDeg;
      if (ev[2] < 0) w = 360.0 - w;
      el.argp = w;
    }
  }
  const double p = hm * hm / kMu;
  el.peri = p / (1.0 + el.e) - kWgsA;
  if (energy < 0) {
    el.a = -kMu / (2.0 * energy);
    el.apo = el.a * (1.0 + el.e) - kWgsA;
  }
  return el;
}

// Vacuum instantaneous impact point: where the conic of the current inertial
// state meets the WGS 84 surface, with the Earth's rotation during the fall.
bool impactPoint(const Vec3& r, const Vec3& v, double utc, double& latDeg, double& lonDeg) {
  const Vec3 h = cross(r, v);
  const double rm = norm(r), vm = norm(v), hm = norm(h);
  const double energy = vm * vm / 2.0 - kMu / rm;
  if (!(hm > 0) || energy >= 0) return false;
  const double a = -kMu / (2.0 * energy);
  const Vec3 ev = sub(scale(r, vm * vm / kMu - 1.0 / rm), scale(v, dot(r, v) / kMu));
  const double e = norm(ev), p = hm * hm / kMu;
  if (e < 1e-9) return false;
  const Vec3 P = scale(ev, 1.0 / e), Q = unit(cross(h, P));
  double nu0 = std::atan2(dot(r, Q), dot(r, P));
  if (nu0 < 0) nu0 += 2 * kPi;
  const auto meanAnomaly = [&](double nu) {
    const double E = 2.0 * std::atan(std::sqrt((1 - e) / (1 + e)) * std::tan(nu / 2.0));
    double M = E - e * std::sin(E);
    return M < 0 ? M + 2 * kPi : M;
  };
  const double n = std::sqrt(kMu / (a * a * a));
  double lat0, lon0, h0;
  ecefToGeodetic(rotateZ(r, -gmst(utc)), lat0, lon0, h0);
  if (h0 <= 0) { latDeg = lat0 / kDeg; lonDeg = lon0 / kDeg; return true; }
  double surface = norm(geodeticToEcef(lat0, lon0, 0));
  for (int iteration = 0; iteration < 4; ++iteration) {
    if (p / (1 + e) >= surface) return false;  // periapsis above the surface: orbital
    const double c = std::max(-1.0, std::min(1.0, (p / surface - 1.0) / e));
    const double nuImpact = 2 * kPi - std::acos(c);    // descending branch
    double M0 = meanAnomaly(nu0), M1 = meanAnomaly(nuImpact);
    if (M1 < M0) M1 += 2 * kPi;
    const double flight = (M1 - M0) / n;
    const Vec3 hit = scale(add(scale(P, std::cos(nuImpact)), scale(Q, std::sin(nuImpact))), surface);
    double lat, lon, alt;
    ecefToGeodetic(rotateZ(hit, -gmst(utc + flight)), lat, lon, alt);
    latDeg = lat / kDeg;
    lonDeg = lon / kDeg;
    const double next = norm(geodeticToEcef(lat, lon, 0));
    if (std::fabs(next - surface) < 0.5) break;
    surface = next;
  }
  return true;
}

// ── altitude and speed samples ───────────────────────────────────────────────
struct Samples {
  std::vector<double> t, h, v;
  double half = 6.0;  // fit half-window, s
};

// Resolution of the altitude samples within 30 s of t: broadcasts show whole
// kilometres above 100 km. 0 when finer than 100 m.
double altitudeStepNear(const Samples& s, double t) {
  const size_t i0 = size_t(std::lower_bound(s.t.begin(), s.t.end(), t - 30.0) - s.t.begin());
  const size_t i1 = size_t(std::upper_bound(s.t.begin(), s.t.end(), t + 30.0) - s.t.begin());
  if (i1 < i0 + 3) return 0.0;
  for (double step : {1000.0, 500.0, 100.0}) {
    bool multiple = true;
    for (size_t i = i0; i < i1 && multiple; ++i) multiple = std::fabs(s.h[i] / step - std::round(s.h[i] / step)) <= 1e-6;
    if (multiple) return step;
  }
  return 0.0;
}
struct Fit { double y = 0, dy = 0; bool ok = false; };

// Least-squares quadratic through the samples in [a, b], value and slope at t.
Fit quadratic(const std::vector<double>& ts, const std::vector<double>& ys, double t, double a, double b) {
  Fit f;
  const size_t i0 = size_t(std::lower_bound(ts.begin(), ts.end(), a) - ts.begin());
  const size_t i1 = size_t(std::upper_bound(ts.begin(), ts.end(), b) - ts.begin());
  if (i1 < i0 + 6) return f;
  double S[5] = {0, 0, 0, 0, 0}, T[3] = {0, 0, 0};
  for (size_t i = i0; i < i1; ++i) {
    const double x = ts[i] - t, y = ys[i];
    double p = 1;
    for (int k = 0; k < 5; ++k) { S[k] += p; if (k < 3) T[k] += p * y; p *= x; }
  }
  double A[3][4] = {{S[0], S[1], S[2], T[0]}, {S[1], S[2], S[3], T[1]}, {S[2], S[3], S[4], T[2]}};
  for (int i = 0; i < 3; ++i) {
    int pivot = i;
    for (int r = i + 1; r < 3; ++r) if (std::fabs(A[r][i]) > std::fabs(A[pivot][i])) pivot = r;
    if (std::fabs(A[pivot][i]) < 1e-12) return f;
    for (int c = 0; c < 4; ++c) std::swap(A[i][c], A[pivot][c]);
    for (int r = 0; r < 3; ++r) {
      if (r == i) continue;
      const double k = A[r][i] / A[i][i];
      for (int c = i; c < 4; ++c) A[r][c] -= k * A[i][c];
    }
  }
  f.y = A[0][3] / A[0][0];
  f.dy = A[1][3] / A[1][1];
  f.ok = std::isfinite(f.y) && std::isfinite(f.dy);
  return f;
}

struct Point { double h = 0, hd = 0, v = 0, vd = 0; };

// Smoothed altitude, vertical rate, speed and its rate at t, using only samples
// in [lo, hi]. The window keeps its width at the ends; a gap in the samples is
// bridged by a cubic Hermite between one-sided fits at its edges.
Point smoothAt(const Samples& s, double t, double lo, double hi) {
  const double H = s.half;
  double a = t - H, b = t + H;
  if (b > hi) { b = hi; a = hi - 2 * H; }
  if (a < lo) { a = lo; b = std::min(hi, lo + 2 * H); }
  const Fit h = quadratic(s.t, s.h, t, a, b), v = quadratic(s.t, s.v, t, a, b);
  if (h.ok && v.ok) return {h.y, h.dy, v.y, v.dy};
  size_t k = size_t(std::lower_bound(s.t.begin(), s.t.end(), t) - s.t.begin());
  const size_t il = k == 0 ? 0 : k - 1, ir = std::min(k, s.t.size() - 1);
  const double tl = s.t[il], tr = std::max(s.t[ir], tl + 1e-3);
  auto edge = [&](double te, bool left, const std::vector<double>& ys, size_t idx) {
    Fit f = left ? quadratic(s.t, ys, te, std::max(lo, te - 2 * H), te) : quadratic(s.t, ys, te, te, std::min(hi, te + 2 * H));
    if (!f.ok) f = {ys[idx], 0.0, true};
    return f;
  };
  const Fit hl = edge(tl, true, s.h, il), hr = edge(tr, false, s.h, ir), vl = edge(tl, true, s.v, il), vr = edge(tr, false, s.v, ir);
  const double T = tr - tl, x = std::min(1.0, std::max(0.0, (t - tl) / T));
  const auto herm = [&](const Fit& A, const Fit& B, double& y, double& dy) {
    const double x2 = x * x, x3 = x2 * x;
    y = (2 * x3 - 3 * x2 + 1) * A.y + (x3 - 2 * x2 + x) * T * A.dy + (-2 * x3 + 3 * x2) * B.y + (x3 - x2) * T * B.dy;
    dy = ((6 * x2 - 6 * x) * A.y + (-6 * x2 + 6 * x) * B.y) / T + (3 * x2 - 4 * x + 1) * A.dy + (3 * x2 - 2 * x) * B.dy;
  };
  Point p;
  herm(hl, hr, p.h, p.hd);
  herm(vl, vr, p.v, p.vd);
  return p;
}

// ── ascent along an Earth-fixed great circle ────────────────────────────────
struct Ascent {
  double lat = 0, lon = 0, alt = 0;  // pad, rad, rad, m
  double liftoff = 0;                 // UTC s
  bool inertialSpeed = false;
  std::vector<double> t;              // grid, s from liftoff
  std::vector<Point> p;               // smoothed samples on the grid
  Vec3 u0{}, east{}, north{};
  double r0 = 0;
};

struct State {
  double t = 0, theta = 0, lat = 0, lon = 0, alt = 0, speed = 0, fpa = 0;
  Vec3 rEF{}, vRelEF{}, rTEME{}, vTEME{};
};

// Earth-fixed and TEME state at downrange angle theta for azimuth beta, with
// altitude h, vertical rate hd and a speed that is Earth-relative or inertial.
State stateAt(const Ascent& A, double beta, double t, double theta, double h, double hd, double speed, bool inertial,
              double radius = 0) {
  State s;
  s.t = t;
  s.theta = theta;
  const Vec3 d0 = add(scale(A.east, std::sin(beta)), scale(A.north, std::cos(beta)));
  const Vec3 p = add(scale(A.u0, std::cos(theta)), scale(d0, std::sin(theta)));
  const Vec3 tan = add(scale(A.u0, -std::sin(theta)), scale(d0, std::cos(theta)));
  const double latc = std::asin(std::max(-1.0, std::min(1.0, p[2])));
  s.lon = std::atan2(p[1], p[0]);
  s.lat = std::atan(std::tan(latc) / ((1 - kWgsF) * (1 - kWgsF)));
  if (radius > 0) {
    // hold the geocentric radius (an apsis radius), not the height
    h = radius - norm(geodeticToEcef(s.lat, s.lon, 0.0));
    h += radius - norm(geodeticToEcef(s.lat, s.lon, h));
  }
  s.alt = h;
  s.rEF = geodeticToEcef(s.lat, s.lon, h);
  const Vec3 up = unit(s.rEF), horizontal = unit(sub(tan, scale(up, dot(tan, up))));
  const Vec3 w = cross({0, 0, kOmegaEarth}, s.rEF);
  double vh;
  if (inertial) {
    const double tw = dot(horizontal, w), ww = dot(w, w);
    vh = -tw + std::sqrt(std::max(0.0, tw * tw - ww + speed * speed - hd * hd));
  } else {
    vh = std::sqrt(std::max(0.0, speed * speed - hd * hd));
  }
  s.vRelEF = add(scale(horizontal, vh), scale(up, hd));
  s.speed = norm(s.vRelEF);
  s.fpa = std::atan2(hd, vh) / kDeg;
  const double g = gmst(A.liftoff + t);
  s.rTEME = rotateZ(s.rEF, g);
  s.vTEME = rotateZ(add(s.vRelEF, w), g);
  return s;
}

// Integrate the downrange angle to tEnd on the grid (trapezoid).
double downrangeAt(const Ascent& A, double beta, double tEnd) {
  double theta = 0, prevRate = 0;
  for (size_t k = 0; k < A.t.size() && A.t[k] <= tEnd + 1e-9; ++k) {
    const Point& q = A.p[k];
    const State s = stateAt(A, beta, A.t[k], theta, q.h, q.hd, q.v, A.inertialSpeed);
    const double horizontal = std::sqrt(std::max(0.0, s.speed * s.speed - q.hd * q.hd));
    const double rate = horizontal / (A.r0 + q.h);
    if (k > 0) theta += 0.5 * (rate + prevRate) * (A.t[k] - A.t[k - 1]);
    prevRate = rate;
  }
  return theta;
}

// Insertion condition at tEnd: altitude, vertical rate and speed, and whether
// the speed is inertial.
struct Insertion { double t = 0, h = 0, hd = 0, speed = 0, radius = 0; bool inertial = false; };

State insertionState(const Ascent& A, double beta, const Insertion& in) {
  return stateAt(A, beta, in.t, downrangeAt(A, beta, in.t), in.h, in.hd, in.speed, in.inertial, in.radius);
}

// Azimuth whose insertion state has the target inclination. Northbound
// azimuths run from due west to due east through north, southbound through
// south; along each the inclination is monotonic.
bool solveAzimuth(const Ascent& A, const Insertion& in, double inclination, bool northbound, double& beta) {
  double lo = northbound ? -89.9 * kDeg : 90.1 * kDeg, hi = northbound ? 89.9 * kDeg : 269.9 * kDeg;
  const auto f = [&](double b) {
    const State st = insertionState(A, b, in);
    return elements(st.rTEME, st.vTEME).inc - inclination;
  };
  double flo = f(lo), fhi = f(hi);
  NEED(std::isfinite(flo) && std::isfinite(fhi), "The insertion state has no orbit plane.");
  if (flo * fhi > 0) {
    errorBuffer = "Inclination " + std::to_string(inclination) + " deg is not reachable from this pad by a direct " +
      (northbound ? "northbound" : "southbound") + " ascent (reachable " + std::to_string(std::min(flo, fhi) + inclination) +
      " to " + std::to_string(std::max(flo, fhi) + inclination) + " deg); dogleg and plane-change ascents are not modelled.";
    error = errorBuffer.c_str();
    return false;
  }
  for (int i = 0; i < 64; ++i) {
    const double mid = 0.5 * (lo + hi), fm = f(mid);
    if ((fm > 0) == (flo > 0)) { lo = mid; flo = fm; } else hi = mid;
  }
  beta = 0.5 * (lo + hi);
  return true;
}

bool buildAscent(const LAM* lam, const Samples& samples, bool inertial, double tEnd, Ascent& A) {
  const LDM* launch = lam->LAUNCH_DATA();
  NEED(launch && launch->SITE(), "LAUNCH_DATA.SITE (pad latitude and longitude) is required.");
  const double latDeg = launch->SITE()->LATITUDE(), lonDeg = launch->SITE()->LONGITUDE();
  NEED(std::isfinite(latDeg) && std::fabs(latDeg) <= 90 && std::isfinite(lonDeg) && std::fabs(lonDeg) <= 360,
    "LAUNCH_DATA.SITE latitude and longitude must be degrees.");
  A.lat = latDeg * kDeg;
  A.lon = lonDeg * kDeg;
  A.alt = std::isfinite(launch->SITE()->ALTITUDE()) ? launch->SITE()->ALTITUDE() : 0.0;
  A.inertialSpeed = inertial;
  const Vec3 pad = geodeticToEcef(A.lat, A.lon, 0.0);
  A.r0 = norm(pad);
  A.u0 = unit(pad);
  A.east = unit(cross({0, 0, 1}, A.u0));
  A.north = cross(A.u0, A.east);
  const double lo = samples.t.front(), hi = std::max(samples.t.back(), lo);
  const size_t steps = size_t(std::ceil(tEnd / kGridStep));
  NEED(steps < 4 * kMaxSamples, "The ascent is too long for the integration grid.");
  for (size_t k = 0; k <= steps; ++k) {
    const double t = std::min(tEnd, double(k) * kGridStep);
    A.t.push_back(t);
    A.p.push_back(smoothAt(samples, std::min(std::max(t, lo), hi), lo, hi));
    if (t >= tEnd) break;
  }
  return true;
}

// Altitude and speed arrays from a $LAM, sorted, with a liftoff anchor.
bool loadSamples(const LAM* lam, Samples& s, double padAltitude) {
  const auto* t = lam->TIME_FROM_LAUNCH_S();
  const auto* h = lam->ALTITUDE_M();
  const auto* v = lam->SPEED_M_PER_S();
  NEED(t && h && v, "TIME_FROM_LAUNCH_S, ALTITUDE_M and SPEED_M_PER_S are required.");
  NEED(t->size() == h->size() && t->size() == v->size(), "TIME_FROM_LAUNCH_S, ALTITUDE_M and SPEED_M_PER_S differ in length.");
  NEED(t->size() >= 8 && t->size() <= kMaxSamples, "Between 8 and 200000 samples are required.");
  std::vector<std::array<double, 3>> rows;
  for (size_t i = 0; i < t->size(); ++i) {
    const double ti = t->Get(i), hi = h->Get(i), vi = v->Get(i);
    NEED(std::isfinite(ti) && std::isfinite(hi) && std::isfinite(vi), "Samples must be finite.");
    NEED(vi >= 0 && hi > -1000 && hi < 5.0e7, "Speed must be non-negative and altitude in metres.");
    if (ti >= 0) rows.push_back({ti, hi, vi});
  }
  std::stable_sort(rows.begin(), rows.end(), [](const auto& a, const auto& b) { return a[0] < b[0]; });
  NEED(rows.size() >= 8, "At least 8 samples at or after liftoff are required.");
  if (rows.front()[0] > 0.5) rows.insert(rows.begin(), {0.0, padAltitude, 0.0});
  // Samples that share a time (repeated broadcast frames) are averaged.
  for (size_t i = 0; i < rows.size();) {
    size_t j = i;
    double h = 0, v = 0;
    for (; j < rows.size() && rows[j][0] == rows[i][0]; ++j) { h += rows[j][1]; v += rows[j][2]; }
    s.t.push_back(rows[i][0]);
    s.h.push_back(h / double(j - i));
    s.v.push_back(v / double(j - i));
    i = j;
  }
  std::vector<double> gaps;
  for (size_t i = 1; i < s.t.size(); ++i) gaps.push_back(s.t[i] - s.t[i - 1]);
  std::nth_element(gaps.begin(), gaps.begin() + gaps.size() / 2, gaps.end());
  s.half = std::max(6.0, 3.5 * gaps[gaps.size() / 2]);
  return true;
}

bool speedReference(const LAM* lam, bool& inertial) {
  switch (lam->SPEED_REFERENCE()) {
    case lamSpeedReference::EARTH_RELATIVE: inertial = false; return true;
    case lamSpeedReference::INERTIAL: inertial = true; return true;
    default: error = "SPEED_REFERENCE must say whether speeds are EARTH_RELATIVE or INERTIAL."; return false;
  }
}

std::string upper(const char* text) {
  std::string s = text ? text : "";
  for (auto& c : s) c = char(std::toupper(static_cast<unsigned char>(c)));
  return s;
}

// First ascent event that marks engine cutoff into orbit.
bool cutoffEvent(const LAM* lam, double& t) {
  if (!lam->ASCENT_EVENTS()) return false;
  double best = std::numeric_limits<double>::infinity();
  for (const auto* e : *lam->ASCENT_EVENTS()) {
    const std::string type = upper(e->EVENT_TYPE() ? e->EVENT_TYPE()->c_str() : nullptr);
    const bool cutoff = e->PHASE() == lamMissionPhase::ORBIT_INSERTION || type.find("SECO") != std::string::npos ||
      type.find("CUTOFF") != std::string::npos || type.find("INSERTION") != std::string::npos;
    if (cutoff && std::isfinite(e->TIME_FROM_LAUNCH_S()) && e->TIME_FROM_LAUNCH_S() > 0) best = std::min(best, e->TIME_FROM_LAUNCH_S());
  }
  if (!std::isfinite(best)) return false;
  t = best;
  return true;
}

bool stageSeparated(const LAM* lam, double before) {
  if (!lam->ASCENT_EVENTS()) return false;
  for (const auto* e : *lam->ASCENT_EVENTS()) {
    const std::string type = upper(e->EVENT_TYPE() ? e->EVENT_TYPE()->c_str() : nullptr);
    if ((type.find("SEPARATION") != std::string::npos || type.find("MECO") != std::string::npos ||
         e->PHASE() == lamMissionPhase::STAGE_SEPARATION || e->PHASE() == lamMissionPhase::UPPER_STAGE) &&
        e->TIME_FROM_LAUNCH_S() > 0 && e->TIME_FROM_LAUNCH_S() <= before) return true;
  }
  return false;
}

// Ends of powered flight (dv/dt above kPoweredAcceleration) followed by at
// least kCoastConfirm seconds of coast inside the samples. Gaps confirm
// nothing: a stretch without samples resets the search.
std::vector<double> poweredEnds(const Samples& s) {
  std::vector<double> ends;
  const double lo = s.t.front(), hi = s.t.back();
  bool powered = false;
  double lastPowered = -1;
  for (double t = std::max(lo, 20.0); t <= hi; t += 0.5) {
    const size_t k = size_t(std::lower_bound(s.t.begin(), s.t.end(), t - 1.0) - s.t.begin());
    if (k >= s.t.size() || s.t[k] > t + 1.0) { powered = false; continue; }
    const Point p = smoothAt(s, t, lo, hi);
    if (p.vd > kPoweredAcceleration) { powered = true; lastPowered = t; continue; }
    if (powered && t - lastPowered >= kCoastConfirm) {
      ends.push_back(lastPowered);
      powered = false;
    }
  }
  return ends;
}

// Altitude, vertical rate and speed at a cutoff: speed from the coast plateau
// just after it when the samples reach it, else from powered flight ending
// there; altitude from a fit that straddles it.
Insertion cutoffCondition(const Samples& s, double c, bool inertial) {
  Insertion in;
  in.t = c;
  in.inertial = inertial;
  const size_t i0 = size_t(std::lower_bound(s.t.begin(), s.t.end(), c) - s.t.begin());
  const size_t i1 = size_t(std::upper_bound(s.t.begin(), s.t.end(), c + 3.0) - s.t.begin());
  Fit h = quadratic(s.t, s.h, c, c - 10.0, c + 10.0);
  if (!h.ok || i1 < i0 + 3) h = quadratic(s.t, s.h, c, c - 20.0, c);
  const Point p = smoothAt(s, c, s.t.front(), c);
  in.h = h.ok ? h.y : p.h;
  in.hd = h.ok ? h.dy : p.hd;
  // Altitude in steps of 100 m or more cannot resolve the vertical rate at a
  // near-zero flight-path angle (a 1 km step inside a 20 s fit is 50 m/s):
  // insertion is then taken at an apsis.
  if (altitudeStepNear(s, c) >= 100.0) in.hd = 0.0;
  if (i1 >= i0 + 3) {
    double sum = 0;
    for (size_t i = i0; i < i1; ++i) sum += s.v[i];
    in.speed = sum / double(i1 - i0);
  } else {
    in.speed = p.v;
  }
  return in;
}

// Refine an automatic cutoff to the fastest sample within 3 s of it.
double refineCutoff(const Samples& s, double c) {
  double best = c, speed = -1;
  for (size_t i = 0; i < s.t.size(); ++i) {
    if (s.t[i] < c - 3.0 || s.t[i] > c + 3.0) continue;
    if (s.v[i] > speed) { speed = s.v[i]; best = s.t[i]; }
  }
  return best;
}

// ── $LAM output ──────────────────────────────────────────────────────────────
struct Output {
  std::vector<double> t, lat, lon, alt, downrange, speed, fpa, iipLat, iipLon, peri, apo;
  std::vector<double> oem;  // Earth-fixed km, km/s
  double step = 1.0;
};

void sampleAscent(const Ascent& A, double beta, double tEnd, double step, Output& out) {
  out.step = step;
  const size_t every = std::max<size_t>(1, size_t(std::llround(step / kGridStep)));
  out.step = double(every) * kGridStep;
  double theta = 0, prevRate = 0;
  for (size_t k = 0; k < A.t.size() && A.t[k] <= tEnd + 1e-9; ++k) {
    const Point& q = A.p[k];
    const State s = stateAt(A, beta, A.t[k], theta, q.h, q.hd, q.v, A.inertialSpeed);
    const double horizontal = std::sqrt(std::max(0.0, s.speed * s.speed - q.hd * q.hd));
    const double rate = horizontal / (A.r0 + q.h);
    if (k % every == 0 && out.t.size() < kMaxOutput) {
      out.t.push_back(A.t[k]);
      out.lat.push_back(s.lat / kDeg);
      out.lon.push_back(wrap180(s.lon / kDeg));
      out.alt.push_back(s.alt);
      out.downrange.push_back(theta * A.r0);
      out.speed.push_back(s.speed);
      out.fpa.push_back(s.fpa);
      double la = nan(), lo = nan();
      if (!impactPoint(s.rTEME, s.vTEME, A.liftoff + A.t[k], la, lo)) { la = nan(); lo = nan(); }
      out.iipLat.push_back(la);
      out.iipLon.push_back(std::isfinite(lo) ? wrap180(lo) : lo);
      const Elements el = elements(s.rTEME, s.vTEME);
      out.peri.push_back(el.peri);
      out.apo.push_back(el.apo);
      const Vec3 v = s.vRelEF;
      out.oem.insert(out.oem.end(), {s.rEF[0] / 1000.0, s.rEF[1] / 1000.0, s.rEF[2] / 1000.0, v[0] / 1000.0, v[1] / 1000.0, v[2] / 1000.0});
    }
    if (k > 0) theta += 0.5 * (rate + prevRate) * (A.t[k] - A.t[k - 1]);
    prevRate = rate;
  }
}

struct InsertionResult {
  bool present = false;
  State state;
  Elements el;
  double raanSigma = nan(), argLatSigma = nan(), periSigma = nan(), apoSigma = nan();
};

using Builder = flatbuffers::FlatBufferBuilder;

flatbuffers::Offset<OEM> earthFixedOem(Builder& b, const Ascent& A, const Output& out) {
  const auto frame = CreateCelestialFrameWrapper(b, CelestialFrame::EFG);
  RFMBuilder rfm(b);
  rfm.add_REFERENCE_FRAME_type(RFMUnion::CelestialFrameWrapper);
  rfm.add_REFERENCE_FRAME(frame.Union());
  const auto reference = rfm.Finish();
  const auto center = b.CreateString("EARTH");
  const auto start = b.CreateString(isoMs(A.liftoff + out.t.front()));
  const auto stop = b.CreateString(isoMs(A.liftoff + out.t.back()));
  const auto data = b.CreateVector(out.oem);
  ephemerisDataBlockBuilder block(b);
  block.add_CENTER_NAME(center);
  block.add_REFERENCE_FRAME(reference);
  block.add_TIME_SYSTEM(timingStandard::UTC);
  block.add_START_TIME(start);
  block.add_STOP_TIME(stop);
  block.add_STEP_SIZE(out.step);
  block.add_STATE_VECTOR_SIZE(6);
  block.add_EPHEMERIS_DATA(data);
  const auto blocks = b.CreateVector(std::vector<flatbuffers::Offset<ephemerisDataBlock>>{block.Finish()});
  OEMBuilder oem(b);
  oem.add_EPHEMERIS_DATA_BLOCK(blocks);
  return oem.Finish();
}

flatbuffers::Offset<lamAscentEvent> event(Builder& b, const char* id, const char* type, double liftoff, double t,
                                          lamMissionPhase phase, double altitude, double speed) {
  const auto eid = b.CreateString(id), etype = b.CreateString(type), epoch = b.CreateString(isoMs(liftoff + t));
  lamAscentEventBuilder e(b);
  e.add_EVENT_ID(eid);
  e.add_EVENT_TYPE(etype);
  e.add_EPOCH(epoch);
  e.add_TIME_FROM_LAUNCH_S(t);
  e.add_PHASE(phase);
  e.add_ALTITUDE_M(altitude);
  e.add_SPEED_M_PER_S(speed);
  return e.Finish();
}

// Copy of the request's target orbit, without its reference ephemeris.
flatbuffers::Offset<lamTargetOrbit> targetCopy(Builder& b, const lamTargetOrbit* t) {
  if (!t) return 0;
  lamTargetOrbitBuilder o(b);
  o.add_INCLINATION_DEG(t->INCLINATION_DEG());
  o.add_PASS_DIRECTION(t->PASS_DIRECTION());
  o.add_PERIAPSIS_ALTITUDE_M(t->PERIAPSIS_ALTITUDE_M());
  o.add_APOAPSIS_ALTITUDE_M(t->APOAPSIS_ALTITUDE_M());
  o.add_INSERTION_TIME_FROM_LAUNCH_S(t->INSERTION_TIME_FROM_LAUNCH_S());
  return o.Finish();
}

void writeLam(Builder& b, const LAM* request, const Ascent& A, const Output& out, const InsertionResult& ins,
              lamTrajectorySource source, lamMissionPhase phase, const std::vector<std::string>& inPlane,
              const std::vector<std::string>& assumptions, const std::vector<flatbuffers::Offset<lamAscentEvent>>& events) {
  const auto str = [&](const flatbuffers::String* s) { return s ? b.CreateString(s->str()) : flatbuffers::Offset<flatbuffers::String>(); };
  const auto message = str(request->MESSAGE_ID()), mission = str(request->MISSION_NAME()), vehicle = str(request->VEHICLE_NAME());
  const auto originator = b.CreateString(kModuleName), propagator = b.CreateString(kModuleName), version = b.CreateString(kModuleVersion);
  const auto timeSystem = b.CreateString("UTC"), refFrame = b.CreateString("EFG");
  const auto launchEpoch = b.CreateString(isoMs(A.liftoff));
  const auto start = b.CreateString(isoMs(A.liftoff + out.t.front())), stop = b.CreateString(isoMs(A.liftoff + out.t.back()));
  const auto guidance = b.CreateString("Earth-fixed great-circle ground track at one Earth-relative azimuth, solved for the target inclination at insertion");
  const auto t = b.CreateVector(out.t), lat = b.CreateVector(out.lat), lon = b.CreateVector(out.lon), alt = b.CreateVector(out.alt);
  const auto downrange = b.CreateVector(out.downrange), speed = b.CreateVector(out.speed), fpa = b.CreateVector(out.fpa);
  const auto iipLat = b.CreateVector(out.iipLat), iipLon = b.CreateVector(out.iipLon);
  const auto peri = b.CreateVector(out.peri), apo = b.CreateVector(out.apo);
  const auto oem = earthFixedOem(b, A, out);
  const auto target = targetCopy(b, request->TARGET_ORBIT());
  const auto eventVector = b.CreateVector(events);
  const auto assumptionVector = b.CreateVectorOfStrings(assumptions);
  const auto inPlaneVector = b.CreateVectorOfStrings(inPlane);
  flatbuffers::Offset<lamInsertionOrbit> insertion;
  flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<BOV>>> bov;
  flatbuffers::Offset<flatbuffers::String> insertionEpoch;
  if (ins.present) {
    const auto epoch = b.CreateString(isoMs(A.liftoff + ins.state.t)), frame = b.CreateString("TEME");
    lamInsertionOrbitBuilder o(b);
    o.add_EPOCH(epoch);
    o.add_TIME_FROM_LAUNCH_S(ins.state.t);
    o.add_REF_FRAME(frame);
    o.add_SEMI_MAJOR_AXIS_M(ins.el.a);
    o.add_ECCENTRICITY(ins.el.e);
    o.add_INCLINATION_DEG(ins.el.inc);
    o.add_RAAN_DEG(ins.el.raan);
    o.add_ARGUMENT_OF_PERIAPSIS_DEG(ins.el.argp);
    o.add_ARGUMENT_OF_LATITUDE_DEG(ins.el.argLat);
    o.add_PERIAPSIS_ALTITUDE_M(ins.el.peri);
    o.add_APOAPSIS_ALTITUDE_M(ins.el.apo);
    o.add_RAAN_UNCERTAINTY_DEG(ins.raanSigma);
    o.add_ARGUMENT_OF_LATITUDE_UNCERTAINTY_DEG(ins.argLatSigma);
    o.add_PERIAPSIS_ALTITUDE_UNCERTAINTY_M(ins.periSigma);
    o.add_APOAPSIS_ALTITUDE_UNCERTAINTY_M(ins.apoSigma);
    insertion = o.Finish();
    const auto bovEpoch = b.CreateString(isoMs(A.liftoff + ins.state.t));
    const Vec3 r = ins.state.rEF, v = ins.state.vRelEF;
    BOVBuilder vector(b);
    vector.add_E_COORDINATE(r[0] / 1000.0);
    vector.add_F_COORDINATE(r[1] / 1000.0);
    vector.add_G_COORDINATE(r[2] / 1000.0);
    vector.add_E_DOT(v[0] / 1000.0);
    vector.add_F_DOT(v[1] / 1000.0);
    vector.add_G_DOT(v[2] / 1000.0);
    vector.add_EPOCH(bovEpoch);
    vector.add_TIME_FROM_LAUNCH(ins.state.t);
    bov = b.CreateVector(std::vector<flatbuffers::Offset<BOV>>{vector.Finish()});
    insertionEpoch = b.CreateString(isoMs(A.liftoff + ins.state.t));
  }
  LAMBuilder lam(b);
  if (!message.IsNull()) lam.add_MESSAGE_ID(message);
  if (!mission.IsNull()) lam.add_MISSION_NAME(mission);
  if (!vehicle.IsNull()) lam.add_VEHICLE_NAME(vehicle);
  lam.add_ORIGINATOR(originator);
  lam.add_TIME_SYSTEM(timeSystem);
  lam.add_REF_FRAME(refFrame);
  lam.add_LAUNCH_EPOCH(launchEpoch);
  lam.add_START_TIME(start);
  lam.add_STOP_TIME(stop);
  lam.add_STEP_SIZE(out.step);
  lam.add_TRAJECTORY_OEM(oem);
  lam.add_PROPAGATOR_NAME(propagator);
  lam.add_PROPAGATOR_VERSION(version);
  lam.add_GUIDANCE_MODEL(guidance);
  lam.add_PHASE(phase);
  lam.add_TIME_FROM_LAUNCH_S(t);
  lam.add_LATITUDE_DEG(lat);
  lam.add_LONGITUDE_DEG(lon);
  lam.add_ALTITUDE_M(alt);
  lam.add_DOWNRANGE_M(downrange);
  lam.add_SPEED_M_PER_S(speed);
  lam.add_FLIGHT_PATH_ANGLE_DEG(fpa);
  lam.add_IIP_LATITUDE_DEG(iipLat);
  lam.add_IIP_LONGITUDE_DEG(iipLon);
  lam.add_ASCENT_EVENTS(eventVector);
  lam.add_ASSUMPTIONS(assumptionVector);
  if (!target.IsNull()) lam.add_TARGET_ORBIT(target);
  lam.add_TRAJECTORY_SOURCE(source);
  lam.add_SPEED_REFERENCE(lamSpeedReference::EARTH_RELATIVE);
  lam.add_INSTANTANEOUS_PERIAPSIS_ALTITUDE_M(peri);
  lam.add_INSTANTANEOUS_APOAPSIS_ALTITUDE_M(apo);
  lam.add_IN_PLANE_LIFTOFF_EPOCHS(inPlaneVector);
  if (ins.present) {
    lam.add_INSERTION(insertion);
    lam.add_BURN_OUT_VECTORS(bov);
    lam.add_ORBIT_INSERTION_EPOCH(insertionEpoch);
    lam.add_INCLINATION_DEG(ins.el.inc);
  }
  FinishLAMBuffer(b, lam.Finish());
}

std::vector<std::string> commonAssumptions() {
  return {
    "Ground track: a great circle on the rotating Earth at one Earth-relative azimuth; dogleg and plane-change ascents are not modelled.",
    "Vertical rate from a local quadratic fit of altitude; horizontal Earth-relative speed sqrt(v^2 - hdot^2).",
    "Inertial frame TEME: GMST (IAU-82) with UT1 taken as UTC; Earth rotation 7.2921150e-5 rad/s; WGS 84 geodesy.",
    "ALTITUDE_M is height above the WGS 84 ellipsoid; the pad altitude, when given, is metres.",
    "Instantaneous apsides and impact points are vacuum two-body conics of each sample's inertial state.",
    "TRAJECTORY_OEM and BURN_OUT_VECTORS are Earth-fixed (EFG, GMST-82 pseudo-Earth-fixed), km and km/s, Earth-relative velocity.",
    "Output ends at insertion; nothing is propagated past it.",
  };
}

Json insertionJson(const InsertionResult& ins, double liftoff) {
  if (!ins.present) return nullptr;
  return Json{{"epoch", isoMs(liftoff + ins.state.t)}, {"time_from_launch_s", ins.state.t},
    {"inclination_deg", ins.el.inc}, {"raan_deg", ins.el.raan}, {"argument_of_latitude_deg", ins.el.argLat},
    {"periapsis_altitude_km", ins.el.peri / 1000.0}, {"apoapsis_altitude_km", std::isfinite(ins.el.apo) ? Json(ins.el.apo / 1000.0) : Json(nullptr)},
    {"raan_sigma_deg", ins.raanSigma}, {"argument_of_latitude_sigma_deg", ins.argLatSigma}};
}

Json lastSampleJson(const Output& out) {
  const size_t i = out.t.size() - 1;
  const auto num = [](double x) { return std::isfinite(x) ? Json(x) : Json(nullptr); };
  return Json{{"time_from_launch_s", out.t[i]}, {"latitude_deg", out.lat[i]}, {"longitude_deg", out.lon[i]},
    {"altitude_km", out.alt[i] / 1000.0}, {"downrange_km", out.downrange[i] / 1000.0}, {"speed_m_s", out.speed[i]},
    {"iip_latitude_deg", num(out.iipLat[i])}, {"iip_longitude_deg", num(out.iipLon[i])},
    {"periapsis_altitude_km", num(out.peri[i] / 1000.0)}, {"apoapsis_altitude_km", num(out.apo[i] / 1000.0)}};
}

bool readLam(const char* port, const LAM*& lam) {
  NEED(plugin_get_input_count() == 1, "Exactly one $LAM frame is required.");
  const auto* frame = plugin_get_input_frame(0);
  NEED(frame && frame->payload && frame->payload_length >= 8 && std::strcmp(frame->port_id, port) == 0,
    "The input port must carry one $LAM FlatBuffer.");
  const uint8_t* bytes = frame->payload;
  size_t length = frame->payload_length;
  if (length >= 12 && std::memcmp(bytes + 8, "$LAM", 4) == 0 && std::memcmp(bytes + 4, "$LAM", 4) != 0) { bytes += 4; length -= 4; }
  flatbuffers::Verifier::Options options;
  options.max_depth = 128;
  options.max_tables = 50000000;
  flatbuffers::Verifier verifier(bytes, length, options);
  NEED(VerifyLAMBuffer(verifier), "The input is not a valid $LAM FlatBuffer.");
  lam = GetLAM(bytes);
  return true;
}

bool liftoffOf(const LAM* lam, double& liftoff) {
  NEED(lam->LAUNCH_EPOCH() && parseIso(lam->LAUNCH_EPOCH()->c_str(), liftoff), "LAUNCH_EPOCH must be an ISO 8601 UTC liftoff time.");
  return true;
}

bool passOf(const lamTargetOrbit* target, bool& northbound) {
  NEED(target, "TARGET_ORBIT (inclination and pass direction) is required.");
  NEED(target->PASS_DIRECTION() == lamPassDirection::NORTHBOUND || target->PASS_DIRECTION() == lamPassDirection::SOUTHBOUND,
    "TARGET_ORBIT.PASS_DIRECTION must be NORTHBOUND or SOUTHBOUND.");
  northbound = target->PASS_DIRECTION() == lamPassDirection::NORTHBOUND;
  return true;
}

// ── track_ascent ─────────────────────────────────────────────────────────────
bool track(const LAM* lam, Builder& b, std::string& report) {
  double liftoff;
  if (!liftoffOf(lam, liftoff)) return false;
  bool inertial, northbound;
  if (!speedReference(lam, inertial) || !passOf(lam->TARGET_ORBIT(), northbound)) return false;
  const double inclination = lam->TARGET_ORBIT()->INCLINATION_DEG();
  NEED(std::isfinite(inclination) && inclination > 0 && inclination < 180, "TARGET_ORBIT.INCLINATION_DEG must be between 0 and 180.");
  Samples s;
  const double padAltitude = lam->LAUNCH_DATA() && lam->LAUNCH_DATA()->SITE() && std::isfinite(lam->LAUNCH_DATA()->SITE()->ALTITUDE())
    ? lam->LAUNCH_DATA()->SITE()->ALTITUDE() : 0.0;
  if (!loadSamples(lam, s, padAltitude)) return false;

  // Cutoff: an event, else the first confirmed end of powered flight whose
  // state is in orbit.
  double cutoff = -1;
  bool fromEvent = false;
  if (cutoffEvent(lam, cutoff)) {
    NEED(cutoff > s.t.front() && cutoff <= s.t.back(), "The cutoff event lies outside the samples.");
    fromEvent = true;
  }
  Ascent A;
  A.liftoff = liftoff;
  if (!buildAscent(lam, s, inertial, s.t.back(), A)) return false;
  double beta = 0;
  InsertionResult ins;
  std::vector<double> candidates;
  if (fromEvent) candidates.push_back(cutoff);
  else for (double c : poweredEnds(s)) candidates.push_back(refineCutoff(s, c));
  for (double c : candidates) {
    const Insertion in = cutoffCondition(s, c, inertial);
    double trial;
    if (!solveAzimuth(A, in, inclination, northbound, trial)) {
      if (fromEvent) return false;
      continue;
    }
    const State st = insertionState(A, trial, in);
    const Elements el = elements(st.rTEME, st.vTEME);
    if (fromEvent || el.peri >= kMinInsertionPeriapsis) {
      beta = trial;
      ins.present = true;
      ins.state = st;
      ins.el = el;
      ins.raanSigma = kTelemetryRaanSigma;
      ins.argLatSigma = kTelemetryArgLatSigma;
      ins.periSigma = kTelemetryPeriSigma;
      ins.apoSigma = kTelemetryApoSigma;
      cutoff = c;
      break;
    }
  }
  double tEnd = s.t.back();
  if (ins.present) {
    tEnd = cutoff;
  } else {
    // Before cutoff: the azimuth that puts an orbital-speed vehicle at the
    // latest sample into the target plane.
    const Point p = smoothAt(s, tEnd, s.t.front(), tEnd);
    Insertion in;
    in.t = tEnd;
    in.h = std::max(p.h, 150000.0);
    in.hd = 0;
    in.speed = std::sqrt(kMu / (kWgsA + in.h));
    in.inertial = true;
    if (!solveAzimuth(A, in, inclination, northbound, beta)) return false;
  }
  const double step = lam->STEP_SIZE() > 0 ? lam->STEP_SIZE() : 1.0;
  Output out;
  sampleAscent(A, beta, tEnd, step, out);
  NEED(!out.t.empty(), "No trajectory samples were produced.");
  if (ins.present && out.t.back() < tEnd - 1e-9) {
    // close the trajectory on the insertion state itself
    const State& st = ins.state;
    out.t.push_back(st.t); out.lat.push_back(st.lat / kDeg); out.lon.push_back(wrap180(st.lon / kDeg)); out.alt.push_back(st.alt);
    out.downrange.push_back(st.theta * A.r0); out.speed.push_back(st.speed); out.fpa.push_back(st.fpa);
    out.iipLat.push_back(nan()); out.iipLon.push_back(nan()); out.peri.push_back(ins.el.peri); out.apo.push_back(ins.el.apo);
    out.oem.insert(out.oem.end(), {st.rEF[0] / 1000, st.rEF[1] / 1000, st.rEF[2] / 1000, st.vRelEF[0] / 1000, st.vRelEF[1] / 1000, st.vRelEF[2] / 1000});
  }
  lamMissionPhase phase = ins.present ? lamMissionPhase::ORBIT_INSERTION
    : (stageSeparated(lam, tEnd) ? lamMissionPhase::UPPER_STAGE : lamMissionPhase::BOOST);
  std::vector<flatbuffers::Offset<lamAscentEvent>> events;
  events.push_back(event(b, "liftoff", "LIFTOFF", liftoff, 0.0, lamMissionPhase::LIFTOFF, out.alt.front(), 0.0));
  if (ins.present)
    events.push_back(event(b, "insertion", fromEvent ? "ENGINE CUTOFF (EVENT)" : "ENGINE CUTOFF (DETECTED)", liftoff, cutoff,
      lamMissionPhase::ORBIT_INSERTION, ins.state.alt, ins.state.speed));
  auto assumptions = commonAssumptions();
  assumptions.push_back("Speeds are " + std::string(inertial ? "inertial" : "Earth-relative, as launch broadcasts report them") + ".");
  if (ins.present) {
    if (const double step = altitudeStepNear(s, cutoff); step >= 100.0)
      assumptions.push_back("Altitude samples near cutoff come in " + std::to_string(int(step)) +
        " m steps, too coarse for the vertical rate there: insertion is taken at an apsis (zero flight-path angle).");
    assumptions.push_back(fromEvent ? "Insertion at the cutoff event time." :
      "Insertion at the first end of powered flight (dv/dt above 2 m/s^2) followed by 5 s of coast whose periapsis is above 80 km.");
    assumptions.push_back("Insertion one-sigma from the study: RAAN 0.45 deg, argument of latitude 0.6 deg, periapsis 2 km, apoapsis 20 km.");
  } else {
    assumptions.push_back("No cutoff yet: the azimuth puts an orbital-speed vehicle at the latest sample into the target plane.");
  }
  writeLam(b, lam, A, out, ins, lamTrajectorySource::TELEMETRY, phase, {}, assumptions, events);
  Json j{{"method", "track_ascent"}, {"launch_epoch", isoMs(liftoff)}, {"samples", out.t.size()},
    {"azimuth_deg", wrap360(beta / kDeg)}, {"phase", ins.present ? "orbit-insertion" : (phase == lamMissionPhase::UPPER_STAGE ? "upper-stage" : "boost")},
    {"cutoff_s", ins.present ? Json(cutoff) : Json(nullptr)}, {"insertion", insertionJson(ins, liftoff)}, {"last", lastSampleJson(out)}};
  report = j.dump();
  return true;
}

// ── project_insertion ────────────────────────────────────────────────────────
struct Plane { std::vector<double> t; std::vector<std::array<double, 6>> s; };

bool temeFrame(const RFM* frame) {
  if (!frame) return false;
  if (const auto* celestial = frame->REFERENCE_FRAME_as_CelestialFrameWrapper())
    return celestial->frame() == CelestialFrame::TEMEOFDATE;
  return false;
}

bool loadPlane(const OEM* oem, Plane& plane) {
  NEED(oem->EPHEMERIS_DATA_BLOCK() && oem->EPHEMERIS_DATA_BLOCK()->size() > 0, "PLANE_REFERENCE has no data blocks.");
  std::vector<std::pair<double, std::array<double, 6>>> rows;
  for (const auto* block : *oem->EPHEMERIS_DATA_BLOCK()) {
    NEED(block->TIME_SYSTEM() == timingStandard::UTC, "PLANE_REFERENCE blocks must state TIME_SYSTEM UTC.");
    NEED(temeFrame(block->REFERENCE_FRAME()), "PLANE_REFERENCE must be in the TEME (TEMEOFDATE) frame.");
    if (block->STEP_SIZE() > 0) {
      const unsigned width = block->STATE_VECTOR_SIZE();
      NEED(width == 6 || width == 9, "STATE_VECTOR_SIZE must be 6 or 9.");
      NEED(block->EPHEMERIS_DATA() && block->EPHEMERIS_DATA()->size() % width == 0, "EPHEMERIS_DATA length is not a whole number of states.");
      double start;
      NEED(block->START_TIME() && parseIso(block->START_TIME()->c_str(), start), "Compact ephemeris needs START_TIME.");
      const auto* data = block->EPHEMERIS_DATA();
      for (size_t i = 0; i * width < data->size(); ++i) {
        std::array<double, 6> state;
        for (int k = 0; k < 6; ++k) state[k] = data->Get(i * width + k) * 1000.0;
        rows.push_back({start + double(i) * block->STEP_SIZE(), state});
      }
    } else {
      NEED(block->EPHEMERIS_DATA_LINES(), "PLANE_REFERENCE block has neither compact data nor lines.");
      for (const auto* line : *block->EPHEMERIS_DATA_LINES()) {
        double epoch;
        NEED(line->EPOCH() && parseIso(line->EPOCH()->c_str(), epoch), "PLANE_REFERENCE line EPOCH is not a valid UTC timestamp.");
        rows.push_back({epoch, {line->X() * 1000.0, line->Y() * 1000.0, line->Z() * 1000.0,
                                line->X_DOT() * 1000.0, line->Y_DOT() * 1000.0, line->Z_DOT() * 1000.0}});
      }
    }
  }
  std::stable_sort(rows.begin(), rows.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
  for (const auto& row : rows) {
    for (double v : row.second) NEED(std::isfinite(v), "PLANE_REFERENCE state is not finite.");
    if (!plane.t.empty() && row.first == plane.t.back()) continue;
    plane.t.push_back(row.first);
    plane.s.push_back(row.second);
  }
  NEED(plane.t.size() >= 2, "PLANE_REFERENCE needs at least two states.");
  return true;
}

// Orbit normal of the reference at t (cubic Hermite states), as inclination
// and RAAN in degrees.
bool planeAt(const Plane& plane, double t, double& inc, double& raan) {
  if (t < plane.t.front() || t > plane.t.back()) return false;
  size_t i = size_t(std::upper_bound(plane.t.begin(), plane.t.end(), t) - plane.t.begin());
  i = i == 0 ? 0 : std::min(i - 1, plane.t.size() - 2);
  const double h = plane.t[i + 1] - plane.t[i], u = (t - plane.t[i]) / h, u2 = u * u, u3 = u2 * u;
  const double h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  const double d00 = 6 * u2 - 6 * u, d10 = 3 * u2 - 4 * u + 1, d01 = -6 * u2 + 6 * u, d11 = 3 * u2 - 2 * u;
  const auto& a = plane.s[i];
  const auto& c = plane.s[i + 1];
  Vec3 r, v;
  for (int k = 0; k < 3; ++k) {
    r[k] = h00 * a[k] + h10 * h * a[k + 3] + h01 * c[k] + h11 * h * c[k + 3];
    v[k] = (d00 * a[k] + d10 * h * a[k + 3] + d01 * c[k] + d11 * h * c[k + 3]) / h;
  }
  const Elements el = elements(r, v);
  inc = el.inc;
  raan = el.raan;
  return std::isfinite(inc) && std::isfinite(raan);
}

// Reference ascent's own cutoff: an event, else the first confirmed end of
// powered flight at orbital-class speed, else the fastest sample.
double referenceCutoff(const LAM* lam, const Samples& s) {
  double c;
  if (cutoffEvent(lam, c) && c > s.t.front() && c <= s.t.back()) return c;
  for (double end : poweredEnds(s)) {
    const double r = refineCutoff(s, end);
    const Point p = smoothAt(s, r, s.t.front(), s.t.back());
    if (p.v > 5000.0) return r;
  }
  return s.t[size_t(std::max_element(s.v.begin(), s.v.end()) - s.v.begin())];
}

bool project(const LAM* lam, Builder& b, std::string& report) {
  const lamTargetOrbit* target = lam->TARGET_ORBIT();
  bool inertial, northbound;
  if (!speedReference(lam, inertial) || !passOf(target, northbound)) return false;
  const double tIns = target->INSERTION_TIME_FROM_LAUNCH_S();
  NEED(std::isfinite(tIns) && tIns > 60 && tIns < 7200, "TARGET_ORBIT.INSERTION_TIME_FROM_LAUNCH_S must be between 60 s and 2 h.");
  const double peri = target->PERIAPSIS_ALTITUDE_M(), apo = target->APOAPSIS_ALTITUDE_M();
  const bool targetApsides = peri > 0;
  NEED(!targetApsides || !(apo > 0) || apo >= peri, "TARGET_ORBIT apoapsis is below its periapsis.");

  // Reference profile, time-scaled so its cutoff falls at the target insertion.
  Samples ref;
  if (!loadSamples(lam, ref, 0.0)) return false;
  const double refCutoff = referenceCutoff(lam, ref);
  NEED(refCutoff > 60, "The reference profile reaches no cutoff after 60 s.");
  const double k = refCutoff / tIns;
  Samples s;
  s.half = ref.half / k;
  for (size_t i = 0; i < ref.t.size() && ref.t[i] <= refCutoff + 1e-9; ++i) {
    s.t.push_back(ref.t[i] / k);
    s.h.push_back(ref.h[i]);
    s.v.push_back(ref.v[i]);
  }
  NEED(s.t.size() >= 8, "The reference profile has too few samples before its cutoff.");

  // Reference plane and search window.
  Plane plane;
  const bool rendezvous = target->PLANE_REFERENCE() != nullptr;
  if (rendezvous && !loadPlane(target->PLANE_REFERENCE(), plane)) return false;
  double liftoff = nan();
  const bool hasLiftoff = lam->LAUNCH_EPOCH() && parseIso(lam->LAUNCH_EPOCH()->c_str(), liftoff);
  double windowOpen = liftoff, windowClose = liftoff;
  if (const LDM* launch = lam->LAUNCH_DATA()) {
    double t;
    if (launch->EARLIEST_LAUNCH_TIMES() && launch->EARLIEST_LAUNCH_TIMES()->size() > 0 &&
        parseIso(launch->EARLIEST_LAUNCH_TIMES()->Get(0)->c_str(), t)) windowOpen = t;
    if (launch->LATEST_LAUNCH_TIMES() && launch->LATEST_LAUNCH_TIMES()->size() > 0 &&
        parseIso(launch->LATEST_LAUNCH_TIMES()->Get(0)->c_str(), t)) windowClose = t;
    if (!std::isfinite(windowOpen)) windowOpen = windowClose;
    if (!std::isfinite(windowClose)) windowClose = windowOpen;
  }
  NEED(hasLiftoff || (rendezvous && std::isfinite(windowOpen)), "LAUNCH_EPOCH is required unless a reference plane and a launch window are given.");
  NEED(!std::isfinite(windowOpen) || windowClose >= windowOpen, "The launch window closes before it opens.");

  double inclination = target->INCLINATION_DEG();
  if (rendezvous) {
    const double at = (hasLiftoff ? liftoff : 0.5 * (windowOpen + windowClose)) + tIns;
    double pinc, praan;
    NEED(planeAt(plane, at, pinc, praan), "PLANE_REFERENCE does not cover the insertion time.");
    inclination = pinc;
  }
  NEED(std::isfinite(inclination) && inclination > 0 && inclination < 180, "TARGET_ORBIT.INCLINATION_DEG must be between 0 and 180.");

  Ascent A;
  A.liftoff = hasLiftoff ? liftoff : windowOpen;
  if (!buildAscent(lam, s, inertial, tIns, A)) return false;
  Insertion in;
  in.t = tIns;
  if (targetApsides) {
    const double rp = kWgsA + peri, ra = kWgsA + (apo > 0 ? apo : peri);
    in.h = peri;
    in.radius = rp;
    in.hd = 0;
    in.speed = std::sqrt(kMu * (2.0 / rp - 2.0 / (rp + ra)));
    in.inertial = true;
  } else {
    in = cutoffCondition(s, tIns, inertial);
  }
  double beta;
  if (!solveAzimuth(A, in, inclination, northbound, beta)) return false;
  const State probe = insertionState(A, beta, in);
  const Elements probeEl = elements(probe.rTEME, probe.vTEME);
  // RAAN(liftoff) = node longitude + GMST(liftoff + tIns): the Earth-fixed
  // ascent does not depend on the liftoff time.
  const double nodeLongitude = wrap360(probeEl.raan - gmst(A.liftoff + tIns) / kDeg);

  std::vector<std::string> inPlane;
  std::vector<double> inPlaneTimes;
  if (rendezvous) {
    const double span = std::max(0.0, windowClose - windowOpen);
    const double from = std::max(windowOpen - 3600.0, plane.t.front() - tIns), to = std::min(windowClose + 3600.0, plane.t.back() - tIns);
    NEED(to > from, "PLANE_REFERENCE does not cover the launch window.");
    NEED(to - from <= 3 * 86400.0 + span, "The in-plane search spans more than three days beyond the window.");
    const auto f = [&](double t0, double& value) {
      double pinc, praan;
      if (!planeAt(plane, t0 + tIns, pinc, praan)) return false;
      value = wrap180(nodeLongitude + gmst(t0 + tIns) / kDeg - praan);
      return true;
    };
    double prevT = from, prevV;
    bool havePrev = f(prevT, prevV);
    for (double t0 = from + 30.0; t0 <= to + 1e-9; t0 += 30.0) {
      double v;
      if (!f(t0, v)) { havePrev = false; continue; }
      if (havePrev && ((v > 0) != (prevV > 0)) && std::fabs(v) < 30 && std::fabs(prevV) < 30) {
        double lo = prevT, hi = t0, flo = prevV;
        for (int i = 0; i < 50; ++i) {
          const double mid = 0.5 * (lo + hi);
          double fm;
          if (!f(mid, fm)) break;
          if ((fm > 0) == (flo > 0)) { lo = mid; flo = fm; } else hi = mid;
        }
        inPlaneTimes.push_back(0.5 * (lo + hi));
      }
      prevT = t0; prevV = v; havePrev = true;
    }
    for (double t : inPlaneTimes) inPlane.push_back(isoMs(t));
    if (!hasLiftoff) {
      NEED(!inPlaneTimes.empty(), "The ascent joins the reference plane nowhere near the launch window.");
      double pick = inPlaneTimes.front();
      for (double t : inPlaneTimes) if (t >= windowOpen - 1e-3 && t <= windowClose + 1e-3) { pick = t; break; }
      liftoff = pick;
    }
  }
  A.liftoff = liftoff;
  InsertionResult ins;
  ins.present = true;
  ins.state = insertionState(A, beta, in);
  ins.el = elements(ins.state.rTEME, ins.state.vTEME);
  ins.raanSigma = kProjectedRaanSigma;
  ins.argLatSigma = kProjectedArgLatSigma;
  const double step = lam->STEP_SIZE() > 0 ? lam->STEP_SIZE() : 1.0;
  Output out;
  sampleAscent(A, beta, tIns, step, out);
  NEED(!out.t.empty(), "No trajectory samples were produced.");
  if (out.t.back() < tIns - 1e-9) {
    const State& st = ins.state;
    out.t.push_back(st.t); out.lat.push_back(st.lat / kDeg); out.lon.push_back(wrap180(st.lon / kDeg)); out.alt.push_back(st.alt);
    out.downrange.push_back(st.theta * A.r0); out.speed.push_back(st.speed); out.fpa.push_back(st.fpa);
    out.iipLat.push_back(nan()); out.iipLon.push_back(nan()); out.peri.push_back(ins.el.peri); out.apo.push_back(ins.el.apo);
    out.oem.insert(out.oem.end(), {st.rEF[0] / 1000, st.rEF[1] / 1000, st.rEF[2] / 1000, st.vRelEF[0] / 1000, st.vRelEF[1] / 1000, st.vRelEF[2] / 1000});
  }
  std::vector<flatbuffers::Offset<lamAscentEvent>> events;
  events.push_back(event(b, "liftoff", "LIFTOFF", liftoff, 0.0, lamMissionPhase::LIFTOFF, out.alt.front(), 0.0));
  events.push_back(event(b, "insertion", "ORBIT INSERTION (PROJECTED)", liftoff, tIns, lamMissionPhase::ORBIT_INSERTION, ins.state.alt, ins.state.speed));
  auto assumptions = commonAssumptions();
  assumptions.push_back("Along-track motion from the request's reference profile, time-scaled so its cutoff (T+" +
    std::to_string(refCutoff) + " s) falls at the target insertion time.");
  assumptions.push_back(targetApsides ? "Insertion at the target periapsis with zero flight-path angle; speed from vis-viva for the target apsides."
                                      : "Insertion altitude and speed from the reference profile at its cutoff.");
  assumptions.push_back("Insertion one-sigma from the study: RAAN 0.25 deg, argument of latitude 1.25 deg; apsides as targeted.");
  if (rendezvous) assumptions.push_back("Inclination and plane from PLANE_REFERENCE at insertion; IN_PLANE_LIFTOFF_EPOCHS joins that plane.");
  writeLam(b, lam, A, out, ins, lamTrajectorySource::PROJECTED, lamMissionPhase::PRELAUNCH, inPlane, assumptions, events);

  Json j{{"method", "project_insertion"}, {"launch_epoch", isoMs(liftoff)}, {"samples", out.t.size()},
    {"azimuth_deg", wrap360(beta / kDeg)}, {"reference_cutoff_s", refCutoff}, {"insertion", insertionJson(ins, liftoff)},
    {"in_plane_liftoffs", inPlane}};
  if (rendezvous) {
    double pinc, praan;
    if (planeAt(plane, liftoff + tIns, pinc, praan)) j["plane_offset_deg"] = wrap180(ins.el.raan - praan);
    Json inside = Json::array();
    for (double t : inPlaneTimes) if (std::isfinite(windowOpen) && t >= windowOpen - 1e-3 && t <= windowClose + 1e-3) inside.push_back(isoMs(t));
    j["in_plane_liftoffs_in_window"] = inside;
  }
  report = j.dump();
  return true;
}

int emit(const char* port, Builder& b, const std::string& report) {
  if (plugin_push_output_ex("report", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
        reinterpret_cast<const uint8_t*>(report.data()), report.size()) < 0) return 1;
  return plugin_push_output_ex(port, "LAM.fbs", "$LAM", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "LAM", 0, 0,
    b.GetBufferPointer(), b.GetSize()) < 0 ? 1 : 0;
}
}  // namespace

extern "C" int track_ascent() {
  const LAM* lam = nullptr;
  if (!readLam("telemetry", lam)) return fail(error);
  Builder b(1 << 16);
  std::string report;
  if (!track(lam, b, report)) return fail(error);
  return emit("trajectory", b, report);
}

extern "C" int project_insertion() {
  const LAM* lam = nullptr;
  if (!readLam("request", lam)) return fail(error);
  Builder b(1 << 16);
  std::string report;
  if (!project(lam, b, report)) return fail(error);
  return emit("projection", b, report);
}
