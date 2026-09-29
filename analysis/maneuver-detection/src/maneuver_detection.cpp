#include "space_data_module_invoke.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cctype>
#include <cstring>
#include <limits>
#include <map>
#include <string>
#include <vector>

// Maneuver detection from an element-set history ($OEM in, $MNV out).
//
// Input: for each object, one ephemeris data block per element set, each the
// trajectory of that set propagated by the caller's propagator across its
// neighbours' epochs (two on each side recommended). Blocks are ordered by
// the midpoint of their span.
//
// For each consecutive pair of blocks the module finds the crossing time t*,
// where the two trajectories are closest over their common span. An impulsive
// burn leaves position continuous, so t* estimates the burn time, and the
// difference of the two states at t* is the burn: the energy change gives the
// in-track delta-V (dE = v dv_T, i.e. dv_T = v da / (2a) from vis-viva at one
// position), the change of the orbit normal gives the cross-track delta-V
// (dh_hat = -(dv_N / v) T_hat). Both are compared at one instant and one
// position, so the propagator's periodic terms cancel.
//
// Detection is a step test on the cumulative per-set level of each quantity:
// the median of the next `median_sets` levels minus the median of the previous
// ones. One bad element set or a settling tail after a burn does not move a
// median. A pair is a candidate when its step exceeds K times the robust scale
// (1.4826 MAD over +-`scale_window_pairs`) and an absolute floor. Each run of
// candidates yields one event at its largest single-pair jump.

namespace {
using Json = nlohmann::json;
using Vec3 = std::array<double, 3>;
constexpr double kMu = 398600.4418;   // km^3/s^2, Earth GM (EGM-96 / WGS 84), osculating elements
constexpr double kRe = 6378.137;      // km, WGS 84 equatorial radius, apogee/perigee altitudes
constexpr double kPi = 3.14159265358979323846;
constexpr double kDeg = 180.0 / kPi;
constexpr size_t kMaxStatesPerBlock = 200000;
constexpr size_t kMaxBlocks = 100000;

const char* error = "Invalid maneuver detection request.";
std::string errorBuffer;
#define NEED(condition, message) do { if (!(condition)) { error = message; return false; } } while (0)

int fail(const char* message) { plugin_set_error("invalid-maneuver-detection-request", message); return 1; }

Vec3 sub(const Vec3& a, const Vec3& b) { return {a[0] - b[0], a[1] - b[1], a[2] - b[2]}; }
double dot(const Vec3& a, const Vec3& b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
Vec3 cross(const Vec3& a, const Vec3& b) {
  return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
}
double norm(const Vec3& a) { return std::sqrt(dot(a, a)); }
Vec3 scale(const Vec3& a, double s) { return {a[0] * s, a[1] * s, a[2] * s}; }
Vec3 unit(const Vec3& a) { return scale(a, 1.0 / norm(a)); }

// ── time: UTC seconds since 1970 (no leap-second table; element-set spans
// that straddle a leap second are off by one second at most) ─────────────
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

// ── frames: Earth-centred inertial or quasi-inertial axes only. The energy
// and orbit-normal differences are taken between two states at one instant
// in one frame, so any of these frames gives the same delta-V. ───────────
bool inertialFrame(const RFM* frame, std::string& name) {
  if (!frame || frame->REFERENCE_FRAME_type() == RFMUnion::NONE) return false;
  if (const auto* celestial = frame->REFERENCE_FRAME_as_CelestialFrameWrapper()) {
    switch (celestial->frame()) {
      case CelestialFrame::GCRF: case CelestialFrame::ICRF: case CelestialFrame::J2000: case CelestialFrame::J2000A:
      case CelestialFrame::EME2000: case CelestialFrame::TEMEOFDATE: case CelestialFrame::CIRS:
      case CelestialFrame::MOD_EARTH: case CelestialFrame::TOD_EARTH: case CelestialFrame::TOE_EARTH:
      case CelestialFrame::B1950:
        name = EnumNameCelestialFrame(celestial->frame());
        return true;
      default: return false;
    }
  }
  if (const auto* system = frame->REFERENCE_FRAME_as_RFMCoordinateSystemWrapper()) {
    const auto* cs = system->COORDINATE_SYSTEM();
    if (!cs) return false;
    switch (cs->AXIS_TYPE()) {
      case rfmAxisType::MEAN_EQUATOR_EQUINOX_J2000: case rfmAxisType::ICRF:
      case rfmAxisType::TRUE_EQUATOR_MEAN_EQUINOX_OF_DATE: case rfmAxisType::MEAN_OF_DATE_EQUATOR:
        name = std::string("AXIS:") + EnumNamerfmAxisType(cs->AXIS_TYPE());
        return true;
      default: return false;
    }
  }
  return false;
}

// ── one element set's propagated trajectory, km and km/s ─────────────────
struct Block {
  std::string key, objectId, objectName, comment, frame;
  uint32_t norad = 0;
  std::vector<double> t;
  std::vector<std::array<double, 6>> s;
  double mid() const { return 0.5 * (t.front() + t.back()); }
};

bool loadBlock(const ephemerisDataBlock* block, Block& out) {
  NEED(block->TIME_SYSTEM() == timingStandard::UTC, "Ephemeris blocks must state TIME_SYSTEM UTC.");
  NEED(inertialFrame(block->REFERENCE_FRAME(), out.frame),
    "Ephemeris block frame must be an Earth-centred inertial or quasi-inertial frame (GCRF, ICRF, J2000, EME2000, TEME, CIRS, MOD, TOD, TOE, B1950).");
  if (block->CENTER_NAME()) {
    std::string center = block->CENTER_NAME()->str();
    std::transform(center.begin(), center.end(), center.begin(), [](unsigned char c) { return std::toupper(c); });
    NEED(center == "EARTH", "Ephemeris blocks must be centred on EARTH.");
  }
  const auto* object = block->OBJECT();
  NEED(object && (object->NORAD_CAT_ID() > 0 || (object->OBJECT_ID() && object->OBJECT_ID()->size() > 0)),
    "Every block must name its object (OBJECT.NORAD_CAT_ID or OBJECT.OBJECT_ID).");
  out.norad = object->NORAD_CAT_ID();
  out.objectId = object->OBJECT_ID() ? object->OBJECT_ID()->str() : "";
  out.objectName = object->OBJECT_NAME() ? object->OBJECT_NAME()->str() : "";
  out.key = out.objectId.empty() ? "NORAD:" + std::to_string(out.norad) : out.objectId;
  out.comment = block->COMMENT() ? block->COMMENT()->str() : "";
  std::vector<std::pair<double, std::array<double, 6>>> rows;
  if (block->STEP_SIZE() > 0) {
    const unsigned width = block->STATE_VECTOR_SIZE();
    NEED(width == 6 || width == 9, "STATE_VECTOR_SIZE must be 6 or 9.");
    NEED(block->EPHEMERIS_DATA() && block->EPHEMERIS_DATA()->size() % width == 0, "EPHEMERIS_DATA length is not a whole number of states.");
    NEED(block->EPHEMERIS_DATA()->size() / width <= kMaxStatesPerBlock, "An ephemeris block has too many states.");
    double start;
    NEED(block->START_TIME() && parseIso(block->START_TIME()->c_str(), start), "Compact ephemeris needs START_TIME.");
    const auto* data = block->EPHEMERIS_DATA();
    for (size_t i = 0; i * width < data->size(); ++i) {
      std::array<double, 6> state;
      for (int k = 0; k < 6; ++k) state[k] = data->Get(i * width + k);
      rows.push_back({start + double(i) * block->STEP_SIZE(), state});
    }
  } else {
    NEED(block->EPHEMERIS_DATA_LINES(), "Ephemeris block has neither compact data nor lines.");
    NEED(block->EPHEMERIS_DATA_LINES()->size() <= kMaxStatesPerBlock, "An ephemeris block has too many states.");
    for (const auto* line : *block->EPHEMERIS_DATA_LINES()) {
      double epoch;
      NEED(line->EPOCH() && parseIso(line->EPOCH()->c_str(), epoch), "Ephemeris line EPOCH is not a valid UTC timestamp.");
      rows.push_back({epoch, {line->X(), line->Y(), line->Z(), line->X_DOT(), line->Y_DOT(), line->Z_DOT()}});
    }
  }
  std::stable_sort(rows.begin(), rows.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
  for (const auto& row : rows) {
    for (double v : row.second) NEED(std::isfinite(v), "Ephemeris state is not finite.");
    if (!out.t.empty() && row.first == out.t.back()) {
      NEED(row.second == out.s.back(), "Two different states share one epoch in one block.");
      continue;
    }
    const Vec3 r{row.second[0], row.second[1], row.second[2]};
    NEED(norm(r) > 1000.0, "An ephemeris state is inside the Earth; positions must be in km.");
    out.t.push_back(row.first);
    out.s.push_back(row.second);
  }
  NEED(out.t.size() >= 2, "An ephemeris block needs at least two states.");
  return true;
}

// Cubic Hermite position and velocity at t (clamped to the block span).
void sample(const Block& b, double t, Vec3& p, Vec3& v) {
  const auto& ts = b.t;
  t = std::min(std::max(t, ts.front()), ts.back());
  size_t i = size_t(std::upper_bound(ts.begin(), ts.end(), t) - ts.begin());
  i = i == 0 ? 0 : std::min(i - 1, ts.size() - 2);
  const double h = ts[i + 1] - ts[i], u = (t - ts[i]) / h;
  const double u2 = u * u, u3 = u2 * u;
  const double h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  const double d00 = 6 * u2 - 6 * u, d10 = 3 * u2 - 4 * u + 1, d01 = -6 * u2 + 6 * u, d11 = 3 * u2 - 2 * u;
  const auto& a = b.s[i];
  const auto& c = b.s[i + 1];
  for (int k = 0; k < 3; ++k) {
    p[k] = h00 * a[k] + h10 * h * a[k + 3] + h01 * c[k] + h11 * h * c[k + 3];
    v[k] = (d00 * a[k] + d10 * h * a[k + 3] + d01 * c[k] + d11 * h * c[k + 3]) / h;
  }
}

// ── options ───────────────────────────────────────────────────────────────
struct Options {
  double k = 8.0;                 // robust-scale multiple
  double floorInTrack = 0.08;     // m/s, absolute floor on the in-track step
  double floorCrossTrack = 1.0;   // m/s, absolute floor on the cross-track step
  int medianSets = 3;             // element sets on each side of a step
  int scaleWindow = 100;          // pairs on each side for the robust scale
  double gridStep = 60.0;         // s, crossing-search grid
  std::string reportTime;         // REPORT_TIME; defaults to the first CREATION_DATE
};

bool readOptions(const Json& j, Options& o) {
  NEED(j.is_object(), "Options must be a JSON object.");
  for (auto it = j.begin(); it != j.end(); ++it) {
    const std::string& key = it.key();
    const Json& v = it.value();
    if (key == "report_time") {
      double t;
      NEED(v.is_string() && parseIso(v.get<std::string>().c_str(), t), "report_time must be an ISO 8601 UTC timestamp.");
      o.reportTime = isoMs(t);
      continue;
    }
    NEED(v.is_number(), "Numeric options must be numbers.");
    const double x = v.get<double>();
    NEED(std::isfinite(x), "Options must be finite.");
    if (key == "k") { NEED(x > 0, "k must be positive."); o.k = x; }
    else if (key == "floor_in_track_mps") { NEED(x >= 0, "floor_in_track_mps must be non-negative."); o.floorInTrack = x; }
    else if (key == "floor_cross_track_mps") { NEED(x >= 0, "floor_cross_track_mps must be non-negative."); o.floorCrossTrack = x; }
    else if (key == "median_sets") { NEED(x >= 1 && x <= 50 && x == std::floor(x), "median_sets must be an integer from 1 to 50."); o.medianSets = int(x); }
    else if (key == "scale_window_pairs") { NEED(x >= 5 && x <= 100000 && x == std::floor(x), "scale_window_pairs must be an integer from 5 to 100000."); o.scaleWindow = int(x); }
    else if (key == "grid_step_s") { NEED(x >= 1 && x <= 3600, "grid_step_s must be from 1 to 3600 seconds."); o.gridStep = x; }
    else { errorBuffer = "Unknown option: " + key; error = errorBuffer.c_str(); return false; }
  }
  return true;
}

// ── one consecutive pair ──────────────────────────────────────────────────
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

double smaOf(const Vec3& r, const Vec3& v) { return 1.0 / (2.0 / norm(r) - dot(v, v) / kMu); }

bool analysePair(const Block& a, const Block& b, double step, Pair& p) {
  p.lo = std::max(a.t.front(), b.t.front());
  p.hi = std::min(a.t.back(), b.t.back());
  NEED(p.hi > p.lo, "Consecutive blocks of one object do not overlap; each block must span its neighbours' epochs.");
  const size_t n = std::max<size_t>(2, size_t(std::ceil((p.hi - p.lo) / step)) + 1);
  const double h = (p.hi - p.lo) / double(n - 1);
  size_t best = 0;
  double bestD = std::numeric_limits<double>::infinity();
  for (size_t k = 0; k < n; ++k) {
    const double d = separation(a, b, p.lo + h * double(k));
    if (d < bestD) { bestD = d; best = k; }
  }
  // Golden-section refinement inside the neighbouring grid cells.
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

// ── robust statistics ────────────────────────────────────────────────────
double median(std::vector<double> x) {
  const size_t n = x.size();
  std::nth_element(x.begin(), x.begin() + n / 2, x.end());
  double m = x[n / 2];
  if (n % 2 == 0) m = 0.5 * (m + *std::max_element(x.begin(), x.begin() + n / 2));
  return m;
}
// Median and 1.4826 * MAD of x[i-w .. i+w].
void robust(const std::vector<double>& x, size_t i, int w, double& m, double& s) {
  const size_t lo = i >= size_t(w) ? i - w : 0, hi = std::min(x.size(), i + w + 1);
  std::vector<double> window(x.begin() + lo, x.begin() + hi);
  m = median(window);
  for (double& v : window) v = std::fabs(v - m);
  s = 1.4826 * median(window);
}

// ── osculating two-body elements for the MNV state tables ─────────────────
struct Elements { double sma, ecc, inc, raan, period, apogee, perigee; };
Elements elementsOf(const Vec3& r, const Vec3& v) {
  Elements e{};
  const Vec3 h = cross(r, v);
  const Vec3 ev = sub(scale(cross(v, h), 1.0 / kMu), unit(r));
  e.sma = smaOf(r, v);
  e.ecc = norm(ev);
  e.inc = std::acos(std::max(-1.0, std::min(1.0, h[2] / norm(h)))) * kDeg;
  double raan = std::atan2(h[0], -h[1]) * kDeg;
  e.raan = raan < 0 ? raan + 360.0 : raan;
  e.period = 2.0 * kPi * std::sqrt(e.sma * e.sma * e.sma / kMu) / 60.0;
  e.apogee = e.sma * (1.0 + e.ecc) - kRe;
  e.perigee = e.sma * (1.0 - e.ecc) - kRe;
  return e;
}

flatbuffers::Offset<mnvOrbitalState> stateTable(flatbuffers::FlatBufferBuilder& fb, const Vec3& r, const Vec3& v) {
  const Elements e = elementsOf(r, v);
  mnvOrbitalStateBuilder b(fb);
  b.add_POS_X(r[0]); b.add_POS_Y(r[1]); b.add_POS_Z(r[2]);
  b.add_VEL_X(v[0]); b.add_VEL_Y(v[1]); b.add_VEL_Z(v[2]);
  b.add_SMA(e.sma); b.add_ECCENTRICITY(e.ecc); b.add_INCLINATION(e.inc); b.add_RAAN(e.raan);
  b.add_PERIOD(e.period); b.add_APOGEE(e.apogee); b.add_PERIGEE(e.perigee);
  return b.Finish();
}

// ── characterization (rules stated in the README) ────────────────────────
// inTrack / crossTrack are the reported components: zero unless that
// component's step test fired in the event's run.
maneuverCharacterization characterize(double inTrack, double crossTrack, const Elements& pre, const Elements& post) {
  if (post.perigee < 120.0) return maneuverCharacterization::DEORBIT;
  const bool geo = pre.period > 1300.0 && pre.period < 1600.0 && pre.ecc < 0.05;
  if (geo) {
    if (std::fabs(post.sma - pre.sma) < 5.0) return maneuverCharacterization::STATION_KEEPING;
    return maneuverCharacterization::PHASING;
  }
  if (inTrack != 0 && crossTrack != 0) return maneuverCharacterization::COMBINED;
  if (crossTrack != 0) return maneuverCharacterization::OUT_OF_PLANE;
  return inTrack > 0 ? maneuverCharacterization::ORBIT_RAISING : maneuverCharacterization::ORBIT_LOWERING;
}

struct Event { size_t pair; bool inTrack, crossTrack; double stepInTrack, stepCrossTrack, thInTrack, thCrossTrack; };

bool detect(const std::vector<const uint8_t*>& frames, const std::vector<size_t>& lengths, const Options& o,
            std::vector<std::vector<uint8_t>>& outputs, std::string& reportJson) {
  std::map<std::string, std::vector<Block>> objects;
  std::string creation;
  size_t blockCount = 0;
  for (size_t f = 0; f < frames.size(); ++f) {
    const OEM* oem = GetOEM(frames[f]);
    NEED(oem->EPHEMERIS_DATA_BLOCK() && oem->EPHEMERIS_DATA_BLOCK()->size() > 0, "An $OEM frame has no data blocks.");
    if (creation.empty() && oem->CREATION_DATE()) {
      double t;
      if (parseIso(oem->CREATION_DATE()->c_str(), t)) creation = isoMs(t);
    }
    for (const auto* block : *oem->EPHEMERIS_DATA_BLOCK()) {
      NEED(++blockCount <= kMaxBlocks, "Too many ephemeris blocks in one request.");
      Block b;
      if (!loadBlock(block, b)) return false;
      objects[b.key].push_back(std::move(b));
    }
  }
  const std::string reportTime = o.reportTime.empty() ? creation : o.reportTime;
  Json report = Json::object();
  report["options"] = {{"k", o.k}, {"floor_in_track_mps", o.floorInTrack}, {"floor_cross_track_mps", o.floorCrossTrack},
                       {"median_sets", o.medianSets}, {"scale_window_pairs", o.scaleWindow}, {"grid_step_s", o.gridStep}};
  report["objects"] = Json::array();
  size_t detections = 0;
  for (auto& [key, blocks] : objects) {
    std::stable_sort(blocks.begin(), blocks.end(), [](const Block& a, const Block& b) { return a.mid() < b.mid(); });
    for (size_t i = 1; i < blocks.size(); ++i)
      NEED(blocks[i].frame == blocks[0].frame, "All blocks of one object must use one reference frame.");
    Json objectReport = {{"object", key}, {"norad_cat_id", blocks[0].norad}, {"element_sets", blocks.size()},
                         {"frame", blocks[0].frame}, {"pairs", Json::array()}, {"events", Json::array()}};
    const size_t n = blocks.size() >= 2 ? blocks.size() - 1 : 0;
    std::vector<Pair> pairs(n);
    for (size_t i = 0; i < n; ++i) {
      if (!analysePair(blocks[i], blocks[i + 1], o.gridStep, pairs[i])) {
        errorBuffer = std::string(error) + " (object " + key + ", blocks " + std::to_string(i) + " and " + std::to_string(i + 1) + ")";
        error = errorBuffer.c_str();
        return false;
      }
    }
    if (n < size_t(2 * o.medianSets)) {
      objectReport["status"] = "insufficient-history";
      objectReport["detail"] = "A step test needs at least 2 * median_sets + 1 element sets.";
      report["objects"].push_back(objectReport);
      continue;
    }
    // Cumulative levels: C[0] = 0, C[j+1] = C[j] + q[j].
    std::vector<double> levelT(n + 1, 0.0);
    std::vector<Vec3> levelH(n + 1, Vec3{0, 0, 0});
    for (size_t j = 0; j < n; ++j) {
      levelT[j + 1] = levelT[j] + pairs[j].qT;
      for (int c = 0; c < 3; ++c) levelH[j + 1][c] = levelH[j][c] + pairs[j].qH[c];
    }
    const size_t w = size_t(o.medianSets);
    std::vector<double> stepT(n), stepH(n);
    std::vector<Vec3> stepHv(n);
    for (size_t i = 0; i < n; ++i) {
      const size_t preLo = i + 1 >= w ? i + 1 - w : 0, postHi = std::min(n + 1, i + 1 + w);
      std::vector<double> pre(levelT.begin() + preLo, levelT.begin() + i + 1), post(levelT.begin() + i + 1, levelT.begin() + postHi);
      stepT[i] = median(post) - median(pre);
      for (int c = 0; c < 3; ++c) {
        std::vector<double> a, b;
        for (size_t j = preLo; j <= i; ++j) a.push_back(levelH[j][c]);
        for (size_t j = i + 1; j < postHi; ++j) b.push_back(levelH[j][c]);
        stepHv[i][c] = median(b) - median(a);
      }
      stepH[i] = norm(stepHv[i]);
    }
    std::vector<char> candidate(n, 0);
    std::vector<double> thT(n), thH(n);
    for (size_t i = 0; i < n; ++i) {
      double m, s;
      robust(stepT, i, o.scaleWindow, m, s);
      thT[i] = std::max(o.k * s, o.floorInTrack);
      robust(stepH, i, o.scaleWindow, m, s);
      thH[i] = std::max(m + o.k * s, o.floorCrossTrack);
      candidate[i] = std::fabs(stepT[i]) > thT[i] || stepH[i] > thH[i];
    }
    for (size_t i = 0; i < n; ++i) {
      const Pair& p = pairs[i];
      objectReport["pairs"].push_back({{"span", {isoMs(p.lo), isoMs(p.hi)}}, {"crossing", isoMs(p.t)},
        {"crossing_at_edge", p.edge}, {"separation_km", p.dmin}, {"delta_sma_km", p.da}, {"in_track_mps", p.qT},
        {"plane_mps", norm(p.qH)}, {"step_in_track_mps", stepT[i]}, {"step_plane_mps", stepH[i]},
        {"threshold_in_track_mps", thT[i]}, {"threshold_plane_mps", thH[i]}, {"candidate", bool(candidate[i])}});
    }
    std::vector<Event> events;
    for (size_t i = 0; i < n;) {
      if (!candidate[i]) { ++i; continue; }
      size_t j = i;
      while (j + 1 < n && candidate[j + 1]) ++j;
      // The event's pair: the largest single-pair jump relative to its own
      // thresholds, within the run widened by the median span.
      const size_t lo = i + 1 >= w ? i + 1 - w : 0, hi = std::min(n - 1, j + w - 1);
      size_t best = lo;
      double bestScore = -1;
      for (size_t m = lo; m <= hi; ++m) {
        const double score = std::max(std::fabs(pairs[m].qT) / thT[m], norm(pairs[m].qH) / thH[m]);
        if (score > bestScore) { bestScore = score; best = m; }
      }
      bool firedT = false, firedH = false;
      for (size_t m = i; m <= j; ++m) {
        firedT = firedT || std::fabs(stepT[m]) > thT[m];
        firedH = firedH || stepH[m] > thH[m];
      }
      if (events.empty() || events.back().pair != best)
        events.push_back({best, firedT, firedH, stepT[best], stepH[best], thT[best], thH[best]});
      i = j + 1;
    }
    for (const Event& e : events) {
      const Pair& p = pairs[e.pair];
      const Block& before = blocks[e.pair];
      const Block& after = blocks[e.pair + 1];
      // Cross-track component: an out-of-plane burn at r turns the orbit
      // normal about r, dh_hat = -(dv_N / v) T_hat, with T_hat = h_hat x r_hat.
      const Vec3 rHat = unit(p.r0), hHat = unit(cross(p.r0, p.v0)), tHat = cross(hHat, rHat);
      const double rawCrossTrack = -dot(p.qH, tHat), rawInTrack = p.qT;
      const double crossTrack = e.crossTrack ? rawCrossTrack : 0.0;
      const double inTrack = e.inTrack ? rawInTrack : 0.0;
      const Elements pre = elementsOf(p.r0, p.v0), post = elementsOf(p.r1, p.v1);
      const maneuverCharacterization kind = characterize(inTrack, crossTrack, pre, post);
      // Mixing: the smaller raw component over the larger (0 = one pure axis).
      const double big = std::max(std::fabs(rawInTrack), std::fabs(rawCrossTrack));
      const double unc = big > 0 ? std::min(std::fabs(rawInTrack), std::fabs(rawCrossTrack)) / big : 1.0;
      const std::string when = isoMs(p.t);
      flatbuffers::FlatBufferBuilder fb(4096);
      const auto id = fb.CreateString("MNV:" + key + ":" + when);
      const auto objectId = before.objectId.empty() ? 0 : fb.CreateString(before.objectId).o;
      const auto reportOffset = reportTime.empty() ? 0 : fb.CreateString(reportTime).o;
      const auto start = fb.CreateString(when);
      const auto end = fb.CreateString(when);
      const auto preState = stateTable(fb, p.r0, p.v0);
      const auto postState = stateTable(fb, p.r1, p.v1);
      const auto algorithm = fb.CreateString(
        "com.digitalarsenal.analysis.maneuver-detection 0.1.0: crossing-point energy and orbit-normal differences, median step test");
      const auto description = fb.CreateString(
        "Impulsive estimate at the crossing of consecutive element-set trajectories (" + before.frame +
        "). DELTA_VEL_U in-track from the energy change, DELTA_VEL_V cross-track from the orbit-normal change, each 0 unless "
        "its step test fired; the radial component is not estimated (0). PRE_EVENT and POST_EVENT are osculating two-body states at the event time, km and km/s.");
      std::vector<flatbuffers::Offset<flatbuffers::String>> sourced;
      if (!before.comment.empty()) sourced.push_back(fb.CreateString(before.comment));
      if (!after.comment.empty()) sourced.push_back(fb.CreateString(after.comment));
      const auto sourcedData = fb.CreateVector(sourced);
      const auto sourcedTypes = fb.CreateString("OEM");
      MNVBuilder b(fb);
      b.add_ID(id);
      if (before.norad) b.add_SAT_NO(before.norad);
      if (objectId) b.add_ORIG_OBJECT_ID(flatbuffers::Offset<flatbuffers::String>(objectId));
      b.add_STATUS(maneuverStatus::DETECTED);
      b.add_CHARACTERIZATION(kind);
      b.add_CHARACTERIZATION_UNC(unc);
      if (reportOffset) b.add_REPORT_TIME(flatbuffers::Offset<flatbuffers::String>(reportOffset));
      b.add_EVENT_START_TIME(start);
      b.add_EVENT_END_TIME(end);
      b.add_UCT(false);
      b.add_MANEUVER_UNC(p.dmin);
      b.add_DELTA_VEL(std::hypot(inTrack, crossTrack) / 1000.0);
      b.add_DELTA_VEL_U(inTrack / 1000.0);
      b.add_DELTA_VEL_V(crossTrack / 1000.0);
      b.add_DELTA_VEL_W(0.0);
      b.add_PRE_EVENT(preState);
      b.add_POST_EVENT(postState);
      b.add_DESCRIPTION(description);
      b.add_ALGORITHM(algorithm);
      b.add_SOURCED_DATA(sourcedData);
      b.add_SOURCED_DATA_TYPES(sourcedTypes);
      FinishMNVBuffer(fb, b.Finish());
      outputs.emplace_back(fb.GetBufferPointer(), fb.GetBufferPointer() + fb.GetSize());
      objectReport["events"].push_back({{"time", when}, {"pair", e.pair}, {"characterization", EnumNamemaneuverCharacterization(kind)},
        {"in_track_mps", inTrack}, {"cross_track_mps", crossTrack}, {"in_track_fired", e.inTrack}, {"cross_track_fired", e.crossTrack},
        {"raw_in_track_mps", rawInTrack}, {"raw_cross_track_mps", rawCrossTrack}, {"delta_sma_km", p.da},
        {"step_in_track_mps", e.stepInTrack}, {"step_plane_mps", e.stepCrossTrack},
        {"threshold_in_track_mps", e.thInTrack}, {"threshold_plane_mps", e.thCrossTrack},
        {"separation_km", p.dmin}, {"crossing_at_edge", p.edge}, {"span", {isoMs(p.lo), isoMs(p.hi)}}});
      ++detections;
    }
    objectReport["status"] = "screened";
    report["objects"].push_back(objectReport);
  }
  report["objects_screened"] = objects.size();
  report["detections"] = detections;
  reportJson = report.dump();
  return true;
}

const uint8_t* rootOf(const plugin_input_frame_t* frame, size_t& length, const char* ident) {
  const uint8_t* bytes = frame->payload;
  length = frame->payload_length;
  if (length >= 12 && std::memcmp(bytes + 8, ident, 4) == 0 && std::memcmp(bytes + 4, ident, 4) != 0) { bytes += 4; length -= 4; }
  return bytes;
}
}  // namespace

extern "C" int detect_maneuvers() {
  Options options;
  std::vector<const uint8_t*> frames;
  std::vector<size_t> lengths;
  const uint32_t count = plugin_get_input_count();
  for (uint32_t i = 0; i < count; ++i) {
    const auto* frame = plugin_get_input_frame(i);
    if (!frame || !frame->port_id) return fail("An input frame has no port.");
    if (std::strcmp(frame->port_id, "options") == 0) {
      if (!frame->payload || frame->payload_length == 0) continue;
      const std::string text(reinterpret_cast<const char*>(frame->payload), frame->payload_length);
      const Json j = Json::parse(text, nullptr, false);
      if (j.is_discarded()) return fail("The options frame is not valid JSON.");
      if (!readOptions(j, options)) return fail(error);
      continue;
    }
    if (std::strcmp(frame->port_id, "ephemerides") != 0) return fail("Unknown input port.");
    size_t length;
    const uint8_t* bytes = rootOf(frame, length, "$OEM");
    if (!bytes || length < 8) return fail("The ephemerides port must carry $OEM FlatBuffers.");
    flatbuffers::Verifier::Options verifierOptions;
    verifierOptions.max_depth = 128;
    verifierOptions.max_tables = 50000000;
    flatbuffers::Verifier verifier(bytes, length, verifierOptions);
    if (!VerifyOEMBuffer(verifier)) return fail("An ephemerides frame is not a valid $OEM FlatBuffer.");
    frames.push_back(bytes);
    lengths.push_back(length);
  }
  if (frames.empty()) return fail("At least one $OEM frame is required on the ephemerides port.");
  std::vector<std::vector<uint8_t>> outputs;
  std::string report;
  if (!detect(frames, lengths, options, outputs, report)) return fail(error);
  if (plugin_push_output_ex("report", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
        reinterpret_cast<const uint8_t*>(report.data()), report.size()) < 0) return 1;
  for (const auto& mnv : outputs) {
    if (plugin_push_output_ex("maneuvers", "MNV.fbs", "$MNV", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "MNV", 0, 0,
          mnv.data(), mnv.size()) < 0) return 1;
  }
  return 0;
}
