#include "space_data_module_invoke.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

// Launch-window collision screening ($CQR LAUNCH_REQUEST -> LAUNCH_RESULT).
//
// Every trajectory and ephemeris is in one Earth-fixed frame. A launched
// object's Earth-fixed state at liftoff + tau is the same for every liftoff
// time of a fixed-azimuth ascent, so the segment trajectory (produced for
// NOMINAL_LIFTOFF) is shifted in time only. Orbiting objects are evaluated at
// absolute times. Both are cubic-Hermite interpolated from their samples.
//
// The search is exact for that interpolation model up to the stated bound:
// candidates come from an absolute-time sweep (10 s) over coarse liftoff
// cells (10 s), keeping every pair whose separation at the cell centre is
// within the criterion extent plus the largest possible motion inside the
// cell; every liftoff time of a candidate cell is then minimised over tau.

namespace {
using Json = nlohmann::json;
using Vec3 = std::array<double, 3>;
constexpr double kWgsA = 6378137.0;                 // WGS 84 semi-major axis, m
constexpr double kWgsF = 1.0 / 298.257223563;       // WGS 84 flattening
constexpr double kOmegaEarth = 7.2921150e-5;        // rad/s; orients RTN axes only
constexpr double kSweepStep = 10.0;                 // absolute-time sweep, s
constexpr double kCoarseLiftoff = 10.0;             // coarse liftoff cell, s
constexpr double kSpeedMargin = 1.05;               // Hermite overshoot allowance
constexpr size_t kMaxLiftoffs = 200000;
constexpr size_t kMaxApproaches = 100000;

const char* error = "Invalid launch screening request.";
std::string errorBuffer;
#define NEED(condition, message) do { if (!(condition)) { error = message; return false; } } while (0)

int fail(const char* message) { plugin_set_error("invalid-launch-cola-request", message); return 1; }

Vec3 sub(const Vec3& a, const Vec3& b) { return {a[0] - b[0], a[1] - b[1], a[2] - b[2]}; }
Vec3 add(const Vec3& a, const Vec3& b) { return {a[0] + b[0], a[1] + b[1], a[2] + b[2]}; }
double dot(const Vec3& a, const Vec3& b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
Vec3 cross(const Vec3& a, const Vec3& b) {
  return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
}
double norm(const Vec3& a) { return std::sqrt(dot(a, a)); }
Vec3 scale(const Vec3& a, double s) { return {a[0] * s, a[1] * s, a[2] * s}; }

// ── time: UTC seconds since 1970 (no leap-second table; a screen spanning a
// leap second would be off by one second, which a request never needs) ─────
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
bool instantSeconds(const TIMInstant* t, double& out) {
  NEED(t, "A required instant is missing.");
  NEED(t->TIME_SYSTEM() == timingStandard::UTC, "Instants must state TIME_SYSTEM UTC.");
  switch (t->EPOCH_FORMAT()) {
    case timEpochRepresentation::ISO8601:
      NEED(t->ISO8601() && parseIso(t->ISO8601()->c_str(), out), "Instant ISO8601 text is not a valid UTC timestamp.");
      break;
    case timEpochRepresentation::UNIX_SECONDS: out = t->SECONDS(); break;
    case timEpochRepresentation::JULIAN_DATE: out = (t->JULIAN_DATE() - 2440587.5) * 86400.0; break;
    case timEpochRepresentation::MODIFIED_JULIAN_DATE: out = (t->JULIAN_DATE() - 40587.0) * 86400.0; break;
    default: error = "Instant representation is not supported; use ISO8601, UNIX_SECONDS, JULIAN_DATE or MODIFIED_JULIAN_DATE."; return false;
  }
  out += t->SUBSECOND_NANOS() * 1e-9;
  NEED(std::isfinite(out), "Instant is not finite.");
  return true;
}

// ── sampled tracks, metres and m/s ───────────────────────────────────────
struct Track {
  std::vector<double> t;
  std::vector<std::array<double, 6>> s;
  double vmax = 0, rmin = std::numeric_limits<double>::infinity(), rmax = 0, maxStep = 0;
};

bool earthFixed(const RFM* frame) {
  if (!frame || frame->REFERENCE_FRAME_type() == RFMUnion::NONE) return true;
  if (const auto* celestial = frame->REFERENCE_FRAME_as_CelestialFrameWrapper()) {
    switch (celestial->frame()) {
      case CelestialFrame::ITRF2000: case CelestialFrame::ITRF93: case CelestialFrame::ITRF97:
      case CelestialFrame::EFG: case CelestialFrame::FIXED_EARTH: case CelestialFrame::WGS84:
      case CelestialFrame::DTRFYYYY: case CelestialFrame::GTOD:
        return true;
      default: return false;
    }
  }
  if (const auto* system = frame->REFERENCE_FRAME_as_RFMCoordinateSystemWrapper())
    return system->COORDINATE_SYSTEM() && system->COORDINATE_SYSTEM()->AXIS_TYPE() == rfmAxisType::BODY_FIXED;
  return false;
}

bool loadTrack(const OEM* oem, Track& track) {
  NEED(oem && oem->EPHEMERIS_DATA_BLOCK() && oem->EPHEMERIS_DATA_BLOCK()->size() > 0, "An ephemeris has no data blocks.");
  std::vector<std::pair<double, std::array<double, 6>>> rows;
  for (const auto* block : *oem->EPHEMERIS_DATA_BLOCK()) {
    NEED(block->TIME_SYSTEM() == timingStandard::UTC, "Ephemeris blocks must state TIME_SYSTEM UTC.");
    NEED(earthFixed(block->REFERENCE_FRAME()), "Ephemeris block frame is not Earth-fixed; convert it to the evaluation frame first.");
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
      NEED(block->EPHEMERIS_DATA_LINES(), "Ephemeris block has neither compact data nor lines.");
      for (const auto* line : *block->EPHEMERIS_DATA_LINES()) {
        double epoch;
        NEED(line->EPOCH() && parseIso(line->EPOCH()->c_str(), epoch), "Ephemeris line EPOCH is not a valid UTC timestamp.");
        rows.push_back({epoch, {line->X() * 1000.0, line->Y() * 1000.0, line->Z() * 1000.0,
                                line->X_DOT() * 1000.0, line->Y_DOT() * 1000.0, line->Z_DOT() * 1000.0}});
      }
    }
  }
  std::stable_sort(rows.begin(), rows.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
  for (const auto& row : rows) {
    for (double v : row.second) NEED(std::isfinite(v), "Ephemeris state is not finite.");
    if (!track.t.empty() && row.first == track.t.back()) {
      NEED(row.second == track.s.back(), "Two different states share one epoch.");
      continue;
    }
    track.t.push_back(row.first);
    track.s.push_back(row.second);
    const Vec3 r{row.second[0], row.second[1], row.second[2]}, v{row.second[3], row.second[4], row.second[5]};
    track.vmax = std::max(track.vmax, norm(v));
    track.rmin = std::min(track.rmin, norm(r));
    track.rmax = std::max(track.rmax, norm(r));
  }
  NEED(track.t.size() >= 2, "An ephemeris needs at least two states.");
  for (size_t i = 0; i + 1 < track.t.size(); ++i) track.maxStep = std::max(track.maxStep, track.t[i + 1] - track.t[i]);
  return true;
}

// Cubic Hermite position and velocity at t (clamped to the track span).
void sample(const Track& track, double t, Vec3& p, Vec3& v) {
  const auto& ts = track.t;
  t = std::min(std::max(t, ts.front()), ts.back());
  size_t i = size_t(std::upper_bound(ts.begin(), ts.end(), t) - ts.begin());
  i = i == 0 ? 0 : std::min(i - 1, ts.size() - 2);
  const double h = ts[i + 1] - ts[i], u = (t - ts[i]) / h;
  const double u2 = u * u, u3 = u2 * u;
  const double h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  const double d00 = 6 * u2 - 6 * u, d10 = 3 * u2 - 4 * u + 1, d01 = -6 * u2 + 6 * u, d11 = 3 * u2 - 2 * u;
  const auto& a = track.s[i];
  const auto& b = track.s[i + 1];
  for (int k = 0; k < 3; ++k) {
    p[k] = h00 * a[k] + h10 * h * a[k + 3] + h01 * b[k] + h11 * h * b[k + 3];
    v[k] = (d00 * a[k] + d10 * h * a[k + 3] + d01 * b[k] + d11 * h * b[k + 3]) / h;
  }
}

// Height above the WGS 84 ellipsoid from an Earth-fixed position (Bowring's
// latitude, refined; h = p cos(lat) + z sin(lat) - a sqrt(1 - e2 sin^2 lat)).
double altitude(const Vec3& r) {
  const double e2 = kWgsF * (2 - kWgsF), b = kWgsA * (1 - kWgsF), ep2 = e2 / (1 - e2);
  const double p = std::hypot(r[0], r[1]);
  const double theta = std::atan2(r[2] * kWgsA, p * b);
  double lat = std::atan2(r[2] + ep2 * b * std::pow(std::sin(theta), 3), p - e2 * kWgsA * std::pow(std::cos(theta), 3));
  double h = 0;
  for (int i = 0; i < 3; ++i) {
    const double s = std::sin(lat), c = std::cos(lat);
    const double n = kWgsA / std::sqrt(1 - e2 * s * s);
    h = p * c + r[2] * s - kWgsA * std::sqrt(1 - e2 * s * s);
    lat = std::atan2(r[2], p * (1 - e2 * n / (n + h)));
  }
  return h;
}

struct Criterion {
  cqrLaunchScreening screening = cqrLaunchScreening::UNSPECIFIED;
  double radius = 0, radial = 0, inTrack = 0, crossTrack = 0;
  double extent() const { return screening == cqrLaunchScreening::SPHERICAL ? radius : std::max({radial, inTrack, crossTrack}); }
};

struct Segment {
  std::string id;
  Track track;
  double nominal = 0;
  double validFrom = -std::numeric_limits<double>::infinity(), validUntil = std::numeric_limits<double>::infinity();
  std::vector<std::pair<double, double>> screened;  // tau spans, s
  double rmin = std::numeric_limits<double>::infinity(), rmax = 0;
};

struct Object {
  std::string id;
  Track track;
  cqrLaunchObjectClass cls = cqrLaunchObjectClass::UNSPECIFIED;
  bool rendezvous = false;
  Criterion criterion;
  double extent = 0;
  bool active = true;
};

// RTN axes of the orbiting object from its Earth-fixed state: the inertial
// velocity is v + omega x r (Earth rotation about +z; precession, nutation
// and polar motion are far below the axis accuracy this needs).
void rtn(const Vec3& q, const Vec3& w, Vec3& R, Vec3& T, Vec3& N) {
  const Vec3 inertial = add(w, cross({0, 0, kOmegaEarth}, q));
  R = scale(q, 1 / norm(q));
  const Vec3 h = cross(q, inertial);
  N = scale(h, 1 / norm(h));
  T = cross(N, R);
}

double criterionRatio(const Criterion& c, const Vec3& rel, const Vec3& q, const Vec3& w) {
  if (c.screening == cqrLaunchScreening::SPHERICAL) return norm(rel) / c.radius;
  Vec3 R, T, N;
  rtn(q, w, R, T, N);
  const double r = dot(rel, R) / c.radial, t = dot(rel, T) / c.inTrack, n = dot(rel, N) / c.crossTrack;
  return std::sqrt(r * r + t * t + n * n);
}

struct Eval {
  double distance = std::numeric_limits<double>::infinity(), tauDistance = 0;
  double ratio = std::numeric_limits<double>::infinity(), tauRatio = 0;
};

// Minimises f over [a, b]: 1 s samples, then golden-section on the bracket.
template <typename F>
double minimise(F&& f, double a, double b, double& best) {
  const int steps = std::max(4, int(std::ceil((b - a) / 1.0)));
  const double delta = (b - a) / steps;
  double bestTau = a;
  best = std::numeric_limits<double>::infinity();
  for (int i = 0; i <= steps; ++i) {
    const double tau = a + delta * i, value = f(tau);
    if (value < best) { best = value; bestTau = tau; }
  }
  double lo = std::max(a, bestTau - delta), hi = std::min(b, bestTau + delta);
  const double g = 0.5 * (std::sqrt(5.0) - 1);
  double x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo), f1 = f(x1), f2 = f(x2);
  while (hi - lo > 1e-4) {
    if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = f(x1); }
    else { lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = f(x2); }
  }
  const double tau = f1 < f2 ? x1 : x2, value = std::min(f1, f2);
  if (value < best) { best = value; bestTau = tau; }
  return bestTau;
}

struct Closure { double start, end; std::set<std::string> objects, segments; };
struct Approach {
  size_t segment, object, liftoff, runStart, runEnd;
  Eval eval;
};

bool screen(const CQRLaunchRequest* request, flatbuffers::FlatBufferBuilder& out, std::string& reportJson) {
  NEED(request, "The CQR frame carries no LAUNCH_REQUEST.");
  const auto* frame = request->EVALUATION_FRAME();
  NEED(frame && frame->AXIS_TYPE() == rfmAxisType::BODY_FIXED && frame->AXIS_REFERENCE_BODY_ID() == 399,
    "EVALUATION_FRAME must be an Earth-fixed (BODY_FIXED, body 399) system.");
  double nominal, open, close;
  if (!instantSeconds(request->NOMINAL_LIFTOFF(), nominal) || !instantSeconds(request->WINDOW_OPEN(), open) ||
      !instantSeconds(request->WINDOW_CLOSE(), close)) return false;
  NEED(open <= close, "WINDOW_OPEN is after WINDOW_CLOSE.");
  const double step = request->LIFTOFF_STEP_SECONDS();
  NEED(std::isfinite(step) && step >= 0.001, "LIFTOFF_STEP_SECONDS must be at least 1 ms.");
  const double floorAltitude = request->MINIMUM_ALTITUDE_M(), screenAfter = request->SCREEN_SECONDS_AFTER_LIFTOFF();
  const double pad = request->CLOSURE_PAD_SECONDS(), reportRatio = request->REPORT_RATIO();
  NEED(std::isfinite(floorAltitude) && std::isfinite(screenAfter) && screenAfter > 0, "Altitude floor or screening duration is invalid.");
  NEED(std::isfinite(pad) && pad >= 0, "CLOSURE_PAD_SECONDS must be finite and non-negative.");
  NEED(std::isfinite(reportRatio) && reportRatio >= 1 && reportRatio <= 100, "REPORT_RATIO must be between 1 and 100.");

  // Liftoff grid, both window ends included.
  std::vector<double> liftoffs;
  const double span = close - open;
  NEED(span / step + 2 <= double(kMaxLiftoffs), "Too many liftoff times; widen LIFTOFF_STEP_SECONDS.");
  for (size_t k = 0;; ++k) {
    const double t = open + double(k) * step;
    if (t > close + 1e-9) break;
    liftoffs.push_back(t);
  }
  if (liftoffs.back() < close - 1e-9) liftoffs.push_back(close);

  // Criteria, one per class.
  Criterion criteria[4];
  bool present[4] = {false, false, false, false};
  NEED(request->CRITERIA() && request->CRITERIA()->size() > 0, "At least one criterion is required.");
  for (const auto* c : *request->CRITERIA()) {
    const int cls = int(c->OBJECT_CLASS());
    NEED(cls >= 1 && cls <= 3, "Each criterion needs an OBJECT_CLASS.");
    NEED(!present[cls], "Two criteria name the same object class.");
    Criterion value;
    value.screening = c->SCREENING();
    if (value.screening == cqrLaunchScreening::SPHERICAL) {
      value.radius = c->RADIUS_M();
      NEED(std::isfinite(value.radius) && value.radius > 0, "A spherical criterion needs a positive RADIUS_M.");
    } else if (value.screening == cqrLaunchScreening::ELLIPSOIDAL) {
      value.radial = c->RADIAL_M(); value.inTrack = c->IN_TRACK_M(); value.crossTrack = c->CROSS_TRACK_M();
      NEED(std::isfinite(value.radial) && std::isfinite(value.inTrack) && std::isfinite(value.crossTrack) &&
           value.radial > 0 && value.inTrack > 0 && value.crossTrack > 0, "An ellipsoidal criterion needs three positive semi-axes.");
    } else if (value.screening == cqrLaunchScreening::PROBABILITY) {
      error = "Probability screening needs covariance for launched and orbiting objects; this provider does not support it. Use a spherical or ellipsoidal criterion.";
      return false;
    } else {
      error = "Each criterion needs a SCREENING kind.";
      return false;
    }
    criteria[cls] = value;
    present[cls] = true;
  }

  // Segments: trajectory, validity span and the tau spans actually screened.
  std::vector<Segment> segments;
  NEED(request->SEGMENTS() && request->SEGMENTS()->size() > 0, "At least one segment is required.");
  for (const auto* s : *request->SEGMENTS()) {
    Segment segment;
    segment.id = s->SEGMENT_ID() ? s->SEGMENT_ID()->str() : std::string();
    NEED(!segment.id.empty(), "Every segment needs a SEGMENT_ID.");
    if (!loadTrack(s->TRAJECTORY(), segment.track)) return false;
    segment.nominal = nominal;
    if (s->VALID_FROM() && !instantSeconds(s->VALID_FROM(), segment.validFrom)) return false;
    if (s->VALID_UNTIL() && !instantSeconds(s->VALID_UNTIL(), segment.validUntil)) return false;
    const auto& ts = segment.track.t;
    auto above = [&](double tau) {
      Vec3 p, v;
      sample(segment.track, nominal + tau, p, v);
      return altitude(p) >= floorAltitude;
    };
    auto crossing = [&](double lo, double hi, bool upward) {
      for (int i = 0; i < 60; ++i) {
        const double mid = 0.5 * (lo + hi);
        if (above(mid) == upward) hi = mid; else lo = mid;
      }
      return 0.5 * (lo + hi);
    };
    for (size_t i = 0; i + 1 < ts.size(); ++i) {
      double a = ts[i] - nominal, b = ts[i + 1] - nominal;
      if (a >= screenAfter) break;
      b = std::min(b, screenAfter);
      const bool ua = above(a), ub = above(b);
      if (!ua && !ub) continue;
      if (!ua) a = crossing(a, b, true);
      if (!ub) b = crossing(a, b, false);
      if (!segment.screened.empty() && std::fabs(segment.screened.back().second - a) < 1e-9) segment.screened.back().second = b;
      else segment.screened.push_back({a, b});
    }
    for (const auto& span : segment.screened)
      for (size_t i = 0; i < ts.size(); ++i) {
        const double tau = ts[i] - nominal;
        if (tau < span.first || tau > span.second) continue;
        const auto& st = segment.track.s[i];
        const double r = norm({st[0], st[1], st[2]});
        segment.rmin = std::min(segment.rmin, r);
        segment.rmax = std::max(segment.rmax, r);
      }
    segments.push_back(std::move(segment));
  }

  // Orbiting objects.
  std::vector<Object> objects;
  NEED(request->OBJECTS() && request->OBJECTS()->size() > 0, "At least one orbiting object is required.");
  for (const auto* o : *request->OBJECTS()) {
    Object object;
    NEED(o->SOURCE() && o->SOURCE()->OBJECT_ID(), "Every orbiting object needs SOURCE.OBJECT_ID.");
    object.id = o->SOURCE()->OBJECT_ID()->str();
    NEED(o->SOURCE()->EPHEMERIS(),
      "Orbiting objects must arrive as ephemerides in the evaluation frame, produced by a host-selected propagator; mean elements are not propagated here.");
    if (!loadTrack(o->SOURCE()->EPHEMERIS(), object.track)) return false;
    object.cls = o->OBJECT_CLASS();
    const int cls = int(object.cls);
    NEED(cls >= 1 && cls <= 3, "Every orbiting object needs an OBJECT_CLASS.");
    NEED(present[cls], "An orbiting object's class has no criterion.");
    object.criterion = criteria[cls];
    object.extent = object.criterion.extent() * reportRatio;
    object.rendezvous = o->RENDEZVOUS_COORDINATED();
    objects.push_back(std::move(object));
  }

  // Sweep parameters and the motion bound.
  const size_t perCell = std::max<size_t>(1, size_t(std::llround(kCoarseLiftoff / step)));
  const size_t cells = (liftoffs.size() + perCell - 1) / perCell;
  double cellHalf = 0;
  for (size_t c = 0; c < cells; ++c) {
    const size_t first = c * perCell, last = std::min(first + perCell - 1, liftoffs.size() - 1);
    cellHalf = std::max(cellHalf, 0.5 * (liftoffs[last] - liftoffs[first]));
  }
  double segmentSpeed = 0, objectSpeed = 0, tauLo = std::numeric_limits<double>::infinity(), tauHi = -tauLo;
  double segmentRmin = std::numeric_limits<double>::infinity(), segmentRmax = 0, segmentSlack = 0;
  for (const auto& s : segments) {
    if (s.screened.empty()) continue;
    segmentSpeed = std::max(segmentSpeed, s.track.vmax * kSpeedMargin);
    tauLo = std::min(tauLo, s.screened.front().first);
    tauHi = std::max(tauHi, s.screened.back().second);
    segmentRmin = std::min(segmentRmin, s.rmin);
    segmentRmax = std::max(segmentRmax, s.rmax);
    segmentSlack = std::max(segmentSlack, s.track.vmax * kSpeedMargin * s.track.maxStep / 2);
  }
  uint64_t prefiltered = 0;
  double largestExtent = 0;
  for (auto& o : objects) largestExtent = std::max(largestExtent, o.extent);

  std::vector<Approach> approaches;
  std::vector<Closure> closures;
  uint64_t candidateCount = 0, refined = 0;
  const bool anythingScreened = std::isfinite(tauLo);
  if (anythingScreened) {
    for (const auto& o : objects) objectSpeed = std::max(objectSpeed, o.track.vmax * kSpeedMargin);
    const double motion = segmentSpeed * (kSweepStep / 2 + cellHalf) + objectSpeed * kSweepStep / 2;
    // Geocentric radii differ by no more than the separation, and between
    // samples a radius moves by at most speed x half the sample spacing.
    for (auto& o : objects) {
      const double slack = o.extent + segmentSlack + o.track.vmax * kSpeedMargin * o.track.maxStep / 2;
      if (o.track.rmin > segmentRmax + slack || o.track.rmax < segmentRmin - slack) {
        o.active = false;
        prefiltered += segments.size();
      }
    }
    const double tA = liftoffs.front() + tauLo, tB = liftoffs.back() + tauHi;
    for (const auto& o : objects)
      if (o.active && (o.track.t.front() > tA + 1e-6 || o.track.t.back() < tB - 1e-6)) {
        errorBuffer = "Ephemeris of orbiting object " + o.id + " does not cover " + isoMs(tA) + " to " + isoMs(tB) + ".";
        error = errorBuffer.c_str();
        return false;
      }

    // Coarse sweep: spatial hash of object positions at each sweep time.
    const double cellSize = largestExtent + motion;
    auto key = [&](const Vec3& p) {
      auto ix = [&](double x) { return uint64_t(int64_t(std::floor(x / cellSize)) + (int64_t(1) << 20)) & 0x1fffff; };
      return ix(p[0]) << 42 | ix(p[1]) << 21 | ix(p[2]);
    };
    std::unordered_map<uint64_t, std::vector<size_t>> grid;
    std::vector<Vec3> positions(objects.size());
    struct Window { double lo, hi; };
    std::unordered_map<uint64_t, Window> candidates;
    const double reach = kSweepStep / 2 + cellHalf;
    for (double tg = tA; tg - kSweepStep / 2 <= tB; tg += kSweepStep) {
      grid.clear();
      for (size_t j = 0; j < objects.size(); ++j) {
        if (!objects[j].active) continue;
        Vec3 v;
        sample(objects[j].track, tg, positions[j], v);
        grid[key(positions[j])].push_back(j);
      }
      for (size_t s = 0; s < segments.size(); ++s) {
        const auto& segment = segments[s];
        if (segment.screened.empty()) continue;
        for (size_t c = 0; c < cells; ++c) {
          const size_t first = c * perCell, last = std::min(first + perCell - 1, liftoffs.size() - 1);
          if (liftoffs[last] < segment.validFrom || liftoffs[first] >= segment.validUntil) continue;
          const double tau = tg - 0.5 * (liftoffs[first] + liftoffs[last]);
          // nearest screened tau within reach
          double nearest = std::numeric_limits<double>::quiet_NaN(), gap = std::numeric_limits<double>::infinity();
          for (const auto& spanTau : segment.screened) {
            const double clamped = std::min(std::max(tau, spanTau.first), spanTau.second);
            if (std::fabs(clamped - tau) < gap) { gap = std::fabs(clamped - tau); nearest = clamped; }
          }
          if (gap > reach) continue;
          Vec3 p, v;
          sample(segment.track, segment.nominal + nearest, p, v);
          const int64_t cx = int64_t(std::floor(p[0] / cellSize)), cy = int64_t(std::floor(p[1] / cellSize)), cz = int64_t(std::floor(p[2] / cellSize));
          for (int64_t dx = -1; dx <= 1; ++dx)
            for (int64_t dy = -1; dy <= 1; ++dy)
              for (int64_t dz = -1; dz <= 1; ++dz) {
                const Vec3 probe{(double(cx + dx) + 0.5) * cellSize, (double(cy + dy) + 0.5) * cellSize, (double(cz + dz) + 0.5) * cellSize};
                const auto found = grid.find(key(probe));
                if (found == grid.end()) continue;
                for (size_t j : found->second) {
                  if (norm(sub(p, positions[j])) >= objects[j].extent + motion) continue;
                  const uint64_t id = (uint64_t(s) * objects.size() + j) * cells + c;
                  auto [it, inserted] = candidates.try_emplace(id, Window{tau - reach, tau + reach});
                  if (!inserted) { it->second.lo = std::min(it->second.lo, tau - reach); it->second.hi = std::max(it->second.hi, tau + reach); }
                }
              }
        }
      }
    }
    candidateCount = candidates.size();

    // Refinement: every liftoff time of every candidate cell.
    std::vector<std::vector<std::pair<size_t, Eval>>> results(segments.size() * objects.size());
    for (const auto& [id, window] : candidates) {
      const size_t c = size_t(id % cells), pair = size_t(id / cells);
      const size_t s = pair / objects.size(), j = pair % objects.size();
      const auto& segment = segments[s];
      const auto& object = objects[j];
      const size_t first = c * perCell, last = std::min(first + perCell - 1, liftoffs.size() - 1);
      for (size_t k = first; k <= last; ++k) {
        const double liftoff = liftoffs[k];
        if (liftoff < segment.validFrom || liftoff >= segment.validUntil) continue;
        Eval eval;
        for (const auto& spanTau : segment.screened) {
          const double a = std::max(spanTau.first, window.lo), b = std::min(spanTau.second, window.hi);
          if (a > b) continue;
          auto relative = [&](double tau, Vec3& rel, Vec3& q, Vec3& w) {
            Vec3 p, v;
            sample(segment.track, segment.nominal + tau, p, v);
            sample(object.track, liftoff + tau, q, w);
            rel = sub(p, q);
          };
          double d;
          const double tauD = minimise([&](double tau) { Vec3 rel, q, w; relative(tau, rel, q, w); return norm(rel); }, a, b, d);
          if (d < eval.distance) { eval.distance = d; eval.tauDistance = tauD; }
          double g;
          const double tauG = minimise([&](double tau) {
            Vec3 rel, q, w; relative(tau, rel, q, w); return criterionRatio(object.criterion, rel, q, w); }, a, b, g);
          if (g < eval.ratio) { eval.ratio = g; eval.tauRatio = tauG; }
        }
        ++refined;
        if (eval.ratio < reportRatio) results[s * objects.size() + j].push_back({k, eval});
      }
    }

    // Runs of consecutive liftoff times: approaches and closures.
    for (size_t s = 0; s < segments.size(); ++s)
      for (size_t j = 0; j < objects.size(); ++j) {
        auto& rows = results[s * objects.size() + j];
        if (rows.empty()) continue;
        std::sort(rows.begin(), rows.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
        for (size_t i = 0; i < rows.size();) {
          size_t e = i;
          while (e + 1 < rows.size() && rows[e + 1].first == rows[e].first + 1) ++e;
          size_t best = i;
          for (size_t r = i; r <= e; ++r) if (rows[r].second.ratio < rows[best].second.ratio) best = r;
          approaches.push_back({s, j, rows[best].first, rows[i].first, rows[e].first, rows[best].second});
          if (approaches.size() > kMaxApproaches) { error = "Too many reported approaches; lower REPORT_RATIO."; return false; }
          if (!objects[j].rendezvous) {
            // violating sub-runs inside this run
            for (size_t r = i; r <= e;) {
              if (rows[r].second.ratio >= 1) { ++r; continue; }
              size_t q = r;
              while (q + 1 <= e && rows[q + 1].second.ratio < 1) ++q;
              const size_t ka = rows[r].first, kb = rows[q].first;
              const double start = (ka > 0 ? liftoffs[ka - 1] : liftoffs[ka] - step) - pad;
              const double end = (kb + 1 < liftoffs.size() ? liftoffs[kb + 1] : liftoffs[kb] + step) + pad;
              closures.push_back({start, end, {objects[j].id}, {segments[s].id}});
              r = q + 1;
            }
          }
          i = e + 1;
        }
      }
  }

  // Merge closures.
  std::sort(closures.begin(), closures.end(), [](const Closure& a, const Closure& b) { return a.start < b.start; });
  std::vector<Closure> merged;
  for (auto& c : closures) {
    if (!merged.empty() && c.start <= merged.back().end) {
      merged.back().end = std::max(merged.back().end, c.end);
      merged.back().objects.insert(c.objects.begin(), c.objects.end());
      merged.back().segments.insert(c.segments.begin(), c.segments.end());
    } else merged.push_back(std::move(c));
  }
  std::sort(approaches.begin(), approaches.end(), [&](const Approach& a, const Approach& b) {
    if (a.liftoff != b.liftoff) return a.liftoff < b.liftoff;
    if (segments[a.segment].id != segments[b.segment].id) return segments[a.segment].id < segments[b.segment].id;
    return objects[a.object].id < objects[b.object].id;
  });

  // Result.
  auto instant = [&](double t) {
    return CreateTIMInstant(out, timingStandard::UTC, timEpochRepresentation::ISO8601, 0, 0, out.CreateString(isoMs(t)));
  };
  std::vector<flatbuffers::Offset<CQRLaunchClosure>> closureOffsets;
  Json intervals = Json::array();
  for (const auto& c : merged) {
    std::vector<std::string> ids(c.objects.begin(), c.objects.end()), segs(c.segments.begin(), c.segments.end());
    const auto objectIds = out.CreateVectorOfStrings(ids), segmentIds = out.CreateVectorOfStrings(segs);
    const auto start = instant(c.start), end = instant(c.end);
    closureOffsets.push_back(CreateCQRLaunchClosure(out, start, end, objectIds, segmentIds));
    intervals.push_back(isoMs(c.start) + "/" + isoMs(c.end));
  }
  std::vector<flatbuffers::Offset<CQRLaunchApproach>> approachOffsets;
  uint64_t violations = 0;
  for (const auto& a : approaches) {
    const auto& segment = segments[a.segment];
    const auto& object = objects[a.object];
    const double liftoff = liftoffs[a.liftoff];
    Vec3 p, v, q, w;
    sample(segment.track, segment.nominal + a.eval.tauDistance, p, v);
    sample(object.track, liftoff + a.eval.tauDistance, q, w);
    const Vec3 rel = sub(p, q);
    Vec3 R, T, N;
    rtn(q, w, R, T, N);
    const double speed = norm(add(sub(v, w), cross({0, 0, kOmegaEarth}, rel)));
    const bool violates = a.eval.ratio < 1;
    violations += violates && !object.rendezvous;
    const auto segmentId = out.CreateString(segment.id), objectId = out.CreateString(object.id);
    const auto lift = instant(liftoff), tca = instant(liftoff + a.eval.tauDistance);
    const auto offset = CreateFRMVector3(out, dot(rel, R), dot(rel, T), dot(rel, N));
    const auto runStart = instant(liftoffs[a.runStart]), runEnd = instant(liftoffs[a.runEnd]);
    approachOffsets.push_back(CreateCQRLaunchApproach(out, segmentId, objectId, object.cls, lift, tca, a.eval.distance,
      speed, offset, a.eval.ratio, violates, object.rendezvous, runStart, runEnd));
  }
  const auto statistics = CreateCQRScreeningStatistics(out, objects.size(), segments.size() * objects.size(), prefiltered,
    candidateCount, refined, approaches.size(), 0, 0);
  flatbuffers::Offset<flatbuffers::String> mission;
  if (request->MISSION_NAME()) mission = out.CreateString(request->MISSION_NAME()->str());
  const auto closureVector = out.CreateVector(closureOffsets);
  const auto approachVector = out.CreateVector(approachOffsets);
  const auto windowOpen = instant(open), windowClose = instant(close);
  const auto result = CreateCQRLaunchResult(out, mission, windowOpen, windowClose, step, liftoffs.size(), closureVector,
    approachVector, statistics);
  CQRBuilder root(out);
  root.add_LAUNCH_RESULT(result);
  FinishCQRBuffer(out, root.Finish());

  size_t screenedSegments = 0;
  for (const auto& s : segments) screenedSegments += !s.screened.empty();
  reportJson = Json{{"liftoff_times", liftoffs.size()}, {"closures", intervals}, {"violations", violations},
    {"approaches", approaches.size()}, {"segments_screened", screenedSegments}, {"objects", objects.size()},
    {"objects_prefiltered", prefiltered / std::max<size_t>(1, segments.size())}}.dump();
  return true;
}
}  // namespace

extern "C" int screen_launch_window() {
  if (plugin_get_input_count() != 1) return fail("Exactly one request frame is required.");
  const auto* frame = plugin_get_input_frame(0);
  if (!frame || !frame->payload || frame->payload_length < 8 || std::strcmp(frame->port_id, "request") != 0)
    return fail("The request port must carry one $CQR FlatBuffer.");
  const uint8_t* bytes = frame->payload;
  size_t length = frame->payload_length;
  if (length >= 12 && std::memcmp(bytes + 8, "$CQR", 4) == 0 && std::memcmp(bytes + 4, "$CQR", 4) != 0) { bytes += 4; length -= 4; }
  flatbuffers::Verifier::Options options;
  options.max_depth = 128;
  options.max_tables = 50000000;
  flatbuffers::Verifier verifier(bytes, length, options);
  if (!VerifyCQRBuffer(verifier)) return fail("The request is not a valid $CQR FlatBuffer.");
  flatbuffers::FlatBufferBuilder out(1 << 16);
  std::string report;
  if (!screen(GetCQR(bytes)->LAUNCH_REQUEST(), out, report)) return fail(error);
  if (plugin_push_output_ex("report", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
        reinterpret_cast<const uint8_t*>(report.data()), report.size()) < 0) return 1;
  return plugin_push_output_ex("result", "CQR.fbs", "$CQR", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "CQR", 0, 0,
    out.GetBufferPointer(), out.GetSize()) < 0 ? 1 : 0;
}
