// Observation-to-object association for catalog maintenance.
//
// Observations ($RDO radar, $EOO electro-optical, $RFO RF) are compared with
// catalog predictions ($OEM ephemerides with covariance). For each
// observation and each prediction covering its time the module forms the
// innovation nu = z - h(x) over every measured component, its covariance
// S = H P H^T + R (H the measurement Jacobian at the predicted state, P the
// predicted state covariance, R the reported 1-sigma uncertainties squared)
// and the Mahalanobis distance d2 = nu^T S^-1 nu. A prediction is a candidate
// when d2 is inside the chi-square gate of the observation's measurement
// dimension. Observations of one sensor scan (one sensor, one time) are then
// assigned jointly: each observation to at most one object and each object to
// at most one observation of the scan, minimising the summed d2, where leaving
// an observation unassigned costs its gate. Unassigned observations are
// uncorrelated tracks (UCTs).
//
// Geometry is in GCRF. Earth-fixed sensors and predictions are rotated with
// the foundation/frames chain (ERFA, IAU 2006/2000A, CIO based) and the
// caller's $EOP rows; an Earth-fixed point's velocity is the rate of that
// rotation (polar motion, precession-nutation and the Earth rotation angle,
// with UT1 advancing at 1 - LOD/86400).
// Predicted measurements use the state at the light-time-corrected emission
// time t - tau, tau = |r(t - tau) - s(t)| / c (one-way down leg); the range
// rate is the derivative of that range, rho_dot = u.(v - v_s) / (1 + u.v / c).
// RFO Doppler is one-way, first order: rho_dot = c (1 - f / f0), its sigma
// from FREQUENCY_UNC. RDO Doppler is a monostatic radar's two-way shift of its
// carrier DOPPLER_FREQUENCY: rho_dot = -c DOPPLER / (2 DOPPLER_FREQUENCY). Angles are
// geometric (astrometric) directions: no aberration and no refraction.
// Measurement biases (*_BIAS) and timing biases are not applied.

#include "linear.hpp"
#include "chi_square.hpp"
#include "assignment.hpp"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <map>
#include <string>
#include <vector>

namespace {

using namespace assoc;
using Json = nlohmann::json;
namespace ax = ::sdn::frames;

constexpr double kC = 299792.458;                // km/s
constexpr double kPi = 3.14159265358979323846;
constexpr double kDeg = kPi / 180.0;
constexpr size_t kMaxObservations = 200000;
constexpr size_t kMaxStatesPerBlock = 500000;

std::string error;
#define NEED(condition, message) do { if (!(condition)) { error = (message); return false; } } while (0)

int fail(const std::string& message) {
  plugin_set_error("invalid-association-request", message.c_str());
  return 1;
}

Mat3 fromAx(const ax::Mat3& m) {
  Mat3 r{};
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) r[i][j] = m.m[i][j];
  return r;
}

// ── time: UTC as an ERFA two-part Julian date, plus seconds from J2000 for
// interpolation (UTC seconds; a span across a leap second is off by 1 s) ──
struct Utc {
  double jd1 = 0, jd2 = 0, t = 0;
  std::string text;
};

bool parseUtc(const char* text, Utc& out) {
  if (!text) return false;
  int y, mo, d, h, mi, used = 0;
  double s;
  if (std::sscanf(text, "%4d-%2d-%2dT%2d:%2d:%lf%n", &y, &mo, &d, &h, &mi, &s, &used) != 6) return false;
  const char* rest = text + used;
  if (!(*rest == 0 || (rest[0] == 'Z' && rest[1] == 0))) return false;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || !(s >= 0 && s < 61)) return false;
  if (eraDtf2d("UTC", y, mo, d, h, mi, s, &out.jd1, &out.jd2) != 0) return false;
  out.t = ((out.jd1 - 2451545.0) + out.jd2) * 86400.0;
  out.text = text;
  return true;
}

Utc shifted(const Utc& u, double seconds) {
  Utc r = u;
  r.jd2 += seconds / 86400.0;
  r.t += seconds;
  return r;
}

// ── Earth orientation ──
std::vector<ax::eop::Row> eopRows;

bool dateMatchesMjd(const char* date, double mjd) {
  int y, m, d, used = 0;
  if (std::sscanf(date, "%4d-%2d-%2d%n", &y, &m, &d, &used) != 3) return false;
  const char* rest = date + used;
  if (*rest && std::strncmp(rest, "T00:00:00", 9) != 0) return false;
  double jd0, day;
  return eraCal2jd(y, m, d, &jd0, &day) == 0 && day == mjd;
}

// GCRF -> ITRF at a UTC instant, and the Earth's angular velocity there.
struct Earth {
  Mat3 r{};     // GCRF -> ITRF
  Mat3 rate{};  // its time derivative (1/s)
};

bool earthAt(const Utc& u, Earth& out) {
  NEED(!eopRows.empty(), "Earth orientation is required: an Earth-fixed sensor or prediction meets inertial geometry, and no $EOP rows were supplied on earth_orientation.");
  ax::EarthOrientation eo;
  const std::string e = ax::eop::at(eopRows, u.jd1, u.jd2, &eo, dateMatchesMjd);
  NEED(e.empty(), "earth_orientation: " + e);
  ax::Epoch epoch;
  double tai1, tai2;
  NEED(eraUtctai(u.jd1, u.jd2, &tai1, &tai2) == 0 && eraTaitt(tai1, tai2, &epoch.tt1, &epoch.tt2) == 0 &&
       eraUtcut1(u.jd1, u.jd2, eo.dut1, &epoch.ut11, &epoch.ut12) == 0, "An epoch is outside ERFA's leap-second table.");
  out.r = fromAx(ax::gcrfToItrf(epoch, eo));
  // The rate by a central difference of the same chain over +/-1 s (the
  // foundation/frames step), TT advancing 1 s and UT1 (1 - LOD/86400) s:
  // truncation omega^3 r h^2 / 6, 3e-10 km/s at the Earth's surface.
  const double h = 1.0, ut1 = h * (1.0 - eo.lengthOfDay / 86400.0);
  ax::Epoch ahead = epoch, behind = epoch;
  ahead.tt2 += h / 86400.0;
  ahead.ut12 += ut1 / 86400.0;
  behind.tt2 -= h / 86400.0;
  behind.ut12 -= ut1 / 86400.0;
  const Mat3 a = fromAx(ax::gcrfToItrf(ahead, eo)), b = fromAx(ax::gcrfToItrf(behind, eo));
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) out.rate[i][j] = (a[i][j] - b[i][j]) / (2.0 * h);
  return true;
}

// Celestial-side epoch (TT) without Earth orientation, for TEME and the bias.
bool ttEpoch(const Utc& u, ax::Epoch& epoch) {
  double tai1, tai2;
  NEED(eraUtctai(u.jd1, u.jd2, &tai1, &tai2) == 0 && eraTaitt(tai1, tai2, &epoch.tt1, &epoch.tt2) == 0,
       "An epoch is outside ERFA's leap-second table.");
  epoch.ut11 = epoch.tt1;
  epoch.ut12 = epoch.tt2;
  return true;
}

const Mat3& gcrfToJ2000() {
  static const Mat3 bias = fromAx(ax::gcrfToMj2000Eq(ax::Epoch{}));
  return bias;
}

// ── frames named by an RFM ──
enum class Frame { GCRF, J2000, TEME, ITRF, RSW_INERTIAL, UNSUPPORTED };

const char* frameName(Frame f) {
  switch (f) {
    case Frame::GCRF: return "GCRF";
    case Frame::J2000: return "J2000";
    case Frame::TEME: return "TEME";
    case Frame::ITRF: return "ITRF";
    case Frame::RSW_INERTIAL: return "RSW_INERTIAL";
    default: return "UNSUPPORTED";
  }
}

Frame classify(const RFM* frame) {
  if (!frame || frame->REFERENCE_FRAME_type() == RFMUnion::NONE) return Frame::UNSUPPORTED;
  if (const auto* c = frame->REFERENCE_FRAME_as_CelestialFrameWrapper()) {
    switch (c->frame()) {
      case CelestialFrame::GCRF: case CelestialFrame::ICRF: return Frame::GCRF;
      case CelestialFrame::J2000: case CelestialFrame::EME2000: return Frame::J2000;
      case CelestialFrame::TEMEOFDATE: return Frame::TEME;
      case CelestialFrame::ITRF2000: case CelestialFrame::ITRF93: case CelestialFrame::ITRF97: case CelestialFrame::EFG:
      case CelestialFrame::FIXED_EARTH: case CelestialFrame::WGS84: return Frame::ITRF;
      default: return Frame::UNSUPPORTED;
    }
  }
  if (const auto* o = frame->REFERENCE_FRAME_as_OrbitFrameWrapper()) {
    return o->frame() == OrbitFrame::RSW_INERTIAL ? Frame::RSW_INERTIAL : Frame::UNSUPPORTED;
  }
  if (const auto* w = frame->REFERENCE_FRAME_as_RFMCoordinateSystemWrapper()) {
    const auto* cs = w->COORDINATE_SYSTEM();
    if (!cs) return Frame::UNSUPPORTED;
    switch (cs->AXIS_TYPE()) {
      case rfmAxisType::ICRF: return Frame::GCRF;
      case rfmAxisType::MEAN_EQUATOR_EQUINOX_J2000: return Frame::J2000;
      case rfmAxisType::TRUE_EQUATOR_MEAN_EQUINOX_OF_DATE: return Frame::TEME;
      default: return Frame::UNSUPPORTED;
    }
  }
  return Frame::UNSUPPORTED;
}

Frame classifyText(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::toupper(c); });
  if (s.empty() || s == "ECEF" || s == "ECR" || s == "EFG" || s == "WGS84" || s == "WGS-84" || s.rfind("ITRF", 0) == 0) return Frame::ITRF;
  if (s == "GCRF" || s == "ICRF") return Frame::GCRF;
  if (s == "J2000" || s == "J2K" || s == "EME2000") return Frame::J2000;
  return Frame::UNSUPPORTED;
}

// ── predictions ──
struct Block {
  std::string key, objectId, name;
  uint32_t norad = 0;
  Frame frame = Frame::GCRF;
  bool covarianceRsw = false;
  int degree = 7;
  std::vector<double> t;
  std::vector<std::array<double, 6>> s;
  std::vector<double> ct;
  std::vector<std::array<double, 21>> c;  // lower triangle, row by row, km and s
};
std::vector<Block> blocks;

bool loadBlock(const ephemerisDataBlock* block, Block& out) {
  NEED(block->TIME_SYSTEM() == timingStandard::UTC, "Prediction blocks must state TIME_SYSTEM UTC.");
  if (block->CENTER_NAME()) {
    std::string center = block->CENTER_NAME()->str();
    std::transform(center.begin(), center.end(), center.begin(), [](unsigned char c) { return std::toupper(c); });
    NEED(center == "EARTH", "Prediction blocks must be centred on EARTH.");
  }
  out.frame = classify(block->REFERENCE_FRAME());
  NEED(out.frame != Frame::UNSUPPORTED && out.frame != Frame::RSW_INERTIAL,
       "Prediction frame must be GCRF, ICRF, J2000, EME2000, TEME or an ITRF realization.");
  if (block->COV_REFERENCE_FRAME()) {
    const Frame cf = classify(block->COV_REFERENCE_FRAME());
    NEED(cf == out.frame || (cf == Frame::RSW_INERTIAL && out.frame != Frame::ITRF),
         "Covariance frame must be the state frame, or RSW_INERTIAL with an inertial state frame.");
    out.covarianceRsw = cf == Frame::RSW_INERTIAL;
  }
  const auto* object = block->OBJECT();
  NEED(object && (object->NORAD_CAT_ID() > 0 || (object->OBJECT_ID() && object->OBJECT_ID()->size() > 0) ||
                  (object->OBJECT_NAME() && object->OBJECT_NAME()->size() > 0)),
       "Every prediction block must name its object (OBJECT.NORAD_CAT_ID, OBJECT_ID or OBJECT_NAME).");
  out.norad = object->NORAD_CAT_ID();
  out.objectId = object->OBJECT_ID() ? object->OBJECT_ID()->str() : "";
  out.name = object->OBJECT_NAME() ? object->OBJECT_NAME()->str() : "";
  out.key = !out.objectId.empty() ? out.objectId : out.norad ? "NORAD:" + std::to_string(out.norad) : out.name;
  if (block->INTERPOLATION_DEGREE() > 0) out.degree = static_cast<int>(std::min<uint32_t>(block->INTERPOLATION_DEGREE(), 15));
  std::vector<std::pair<double, std::array<double, 6>>> rows;
  if (block->STEP_SIZE() > 0) {
    const unsigned width = block->STATE_VECTOR_SIZE();
    NEED(width == 6 || width == 9, "STATE_VECTOR_SIZE must be 6 or 9.");
    NEED(block->EPHEMERIS_DATA() && block->EPHEMERIS_DATA()->size() % width == 0, "EPHEMERIS_DATA length is not a whole number of states.");
    NEED(block->EPHEMERIS_DATA()->size() / width <= kMaxStatesPerBlock, "A prediction block has too many states.");
    Utc start;
    NEED(block->START_TIME() && parseUtc(block->START_TIME()->c_str(), start), "Compact ephemeris needs START_TIME.");
    const auto* data = block->EPHEMERIS_DATA();
    for (size_t i = 0; i * width < data->size(); ++i) {
      std::array<double, 6> state;
      for (int k = 0; k < 6; ++k) state[k] = data->Get(static_cast<flatbuffers::uoffset_t>(i * width + k));
      rows.push_back({start.t + double(i) * block->STEP_SIZE(), state});
    }
  } else {
    NEED(block->EPHEMERIS_DATA_LINES() && block->EPHEMERIS_DATA_LINES()->size() <= kMaxStatesPerBlock,
         "A prediction block has neither compact data nor (a bounded number of) lines.");
    for (const auto* line : *block->EPHEMERIS_DATA_LINES()) {
      Utc u;
      NEED(line->EPOCH() && parseUtc(line->EPOCH()->c_str(), u), "Ephemeris line EPOCH is not a valid UTC timestamp.");
      rows.push_back({u.t, {line->X(), line->Y(), line->Z(), line->X_DOT(), line->Y_DOT(), line->Z_DOT()}});
    }
  }
  std::stable_sort(rows.begin(), rows.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
  for (const auto& row : rows) {
    for (double v : row.second) NEED(std::isfinite(v), "A predicted state is not finite.");
    if (!out.t.empty() && row.first == out.t.back()) continue;
    NEED(norm3({row.second[0], row.second[1], row.second[2]}) > 1000.0, "A predicted state is inside the Earth; positions must be in km.");
    out.t.push_back(row.first);
    out.s.push_back(row.second);
  }
  NEED(out.t.size() >= 2, "A prediction block needs at least two states.");
  NEED(block->COVARIANCE_MATRIX_LINES() && block->COVARIANCE_MATRIX_LINES()->size() > 0,
       "Prediction block " + out.key + " has no COVARIANCE_MATRIX_LINES; association needs the predicted covariance.");
  std::vector<std::pair<double, std::array<double, 21>>> covs;
  for (const auto* line : *block->COVARIANCE_MATRIX_LINES()) {
    Utc u;
    NEED(line->EPOCH() && parseUtc(line->EPOCH()->c_str(), u), "Covariance line EPOCH is not a valid UTC timestamp.");
    const std::array<double, 21> v{line->CX_X(), line->CY_X(), line->CY_Y(), line->CZ_X(), line->CZ_Y(), line->CZ_Z(),
      line->CX_DOT_X(), line->CX_DOT_Y(), line->CX_DOT_Z(), line->CX_DOT_X_DOT(),
      line->CY_DOT_X(), line->CY_DOT_Y(), line->CY_DOT_Z(), line->CY_DOT_X_DOT(), line->CY_DOT_Y_DOT(),
      line->CZ_DOT_X(), line->CZ_DOT_Y(), line->CZ_DOT_Z(), line->CZ_DOT_X_DOT(), line->CZ_DOT_Y_DOT(), line->CZ_DOT_Z_DOT()};
    for (double x : v) NEED(std::isfinite(x), "A covariance entry is not finite.");
    covs.push_back({u.t, v});
  }
  std::stable_sort(covs.begin(), covs.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
  for (const auto& c : covs) {
    if (!out.ct.empty() && c.first == out.ct.back()) continue;
    out.ct.push_back(c.first);
    out.c.push_back(c.second);
  }
  return true;
}

// Lagrange interpolation of position and velocity through degree + 1 samples
// around t; a sample epoch returns the sample. False outside the span.
bool interpolate(const Block& b, double t, std::array<double, 6>& x) {
  const size_t n = b.t.size();
  if (t < b.t.front() || t > b.t.back()) return false;
  const size_t hit = static_cast<size_t>(std::lower_bound(b.t.begin(), b.t.end(), t) - b.t.begin());
  if (hit < n && b.t[hit] == t) { x = b.s[hit]; return true; }
  const size_t points = std::min<size_t>(static_cast<size_t>(b.degree) + 1, n);
  size_t first = hit >= points / 2 ? hit - points / 2 : 0;
  if (first + points > n) first = n - points;
  x.fill(0.0);
  for (size_t i = first; i < first + points; ++i) {
    double w = 1.0;
    for (size_t j = first; j < first + points; ++j)
      if (j != i) w *= (t - b.t[j]) / (b.t[i] - b.t[j]);
    for (int k = 0; k < 6; ++k) x[k] += w * b.s[i][k];
  }
  return true;
}

// Covariance at t: a covariance epoch returns its matrix; between two epochs
// the entries are interpolated linearly (a convex combination of positive
// semi-definite matrices, so the result stays positive semi-definite).
bool covarianceAt(const Block& b, double t, Mat6& p) {
  if (b.ct.empty() || t < b.ct.front() || t > b.ct.back()) return false;
  size_t i = static_cast<size_t>(std::lower_bound(b.ct.begin(), b.ct.end(), t) - b.ct.begin());
  std::array<double, 21> v;
  if (b.ct[i] == t) {
    v = b.c[i];
  } else {
    const double w = (t - b.ct[i - 1]) / (b.ct[i] - b.ct[i - 1]);
    for (int k = 0; k < 21; ++k) v[k] = (1.0 - w) * b.c[i - 1][k] + w * b.c[i][k];
  }
  int k = 0;
  for (int r = 0; r < 6; ++r)
    for (int c = 0; c <= r; ++c) p[r][c] = p[c][r] = v[k++];
  return true;
}

Mat6 transformCovariance(const Mat6& p, const Mat6& j) {
  Mat6 jp{}, out{};
  for (int r = 0; r < 6; ++r)
    for (int c = 0; c < 6; ++c)
      for (int k = 0; k < 6; ++k) jp[r][c] += j[r][k] * p[k][c];
  for (int r = 0; r < 6; ++r)
    for (int c = 0; c < 6; ++c)
      for (int k = 0; k < 6; ++k) out[r][c] += jp[r][k] * j[c][k];
  return out;
}

Mat6 blockDiagonal(const Mat3& a, const Mat3& lower, const Mat3& d) {
  Mat6 j{};
  for (int r = 0; r < 3; ++r)
    for (int c = 0; c < 3; ++c) {
      j[r][c] = a[r][c];
      j[r + 3][c] = lower[r][c];
      j[r + 3][c + 3] = d[r][c];
    }
  return j;
}

// GCRF state at u (and, when asked, its covariance there).
bool predictGcrf(const Block& b, const Utc& u, std::array<double, 6>& x, Mat6* p, bool& covered) {
  covered = false;
  std::array<double, 6> n;
  if (!interpolate(b, u.t, n)) return true;
  Mat6 pn{};
  if (p && !covarianceAt(b, u.t, pn)) return true;
  covered = true;
  const Vec3 r{n[0], n[1], n[2]}, v{n[3], n[4], n[5]};
  if (p && b.covarianceRsw) {
    const Vec3 rh = scale3(r, 1.0 / norm3(r));
    const Vec3 h = cross3(r, v);
    const Vec3 wh = scale3(h, 1.0 / norm3(h));
    const Vec3 sh = cross3(wh, rh);
    const Mat3 q{{{rh[0], sh[0], wh[0]}, {rh[1], sh[1], wh[1]}, {rh[2], sh[2], wh[2]}}};  // RSW -> state frame
    pn = transformCovariance(pn, blockDiagonal(q, Mat3{}, q));
  }
  Mat3 rot{}, lower{};  // state frame -> GCRF
  Vec3 rg, vg;
  if (b.frame == Frame::GCRF) {
    rot = {{{1, 0, 0}, {0, 1, 0}, {0, 0, 1}}};
    rg = r; vg = v;
  } else if (b.frame == Frame::J2000) {
    rot = transpose3(gcrfToJ2000());
    rg = apply3(rot, r); vg = apply3(rot, v);
  } else if (b.frame == Frame::TEME) {
    ax::Epoch epoch;
    if (!ttEpoch(u, epoch)) return false;
    rot = transpose3(fromAx(ax::gcrfToTeme(epoch)));
    rg = apply3(rot, r); vg = apply3(rot, v);
  } else {
    Earth e;
    if (!earthAt(u, e)) return false;
    // r_g = M' r, v_g = M' v + Mdot' r.
    rot = transpose3(e.r);
    lower = transpose3(e.rate);
    rg = apply3(rot, r);
    vg = add3(apply3(rot, v), apply3(lower, r));
  }
  x = {rg[0], rg[1], rg[2], vg[0], vg[1], vg[2]};
  if (p) *p = transformCovariance(pn, blockDiagonal(rot, lower, rot));
  return true;
}

// ── observations ──
enum class Kind { RANGE, RANGE_RATE, RA, DEC, AZ, EL };
const char* kindName(Kind k) {
  switch (k) {
    case Kind::RANGE: return "range_km";
    case Kind::RANGE_RATE: return "range_rate_km_s";
    case Kind::RA: return "ra_deg";
    case Kind::DEC: return "dec_deg";
    case Kind::AZ: return "azimuth_deg";
    default: return "elevation_deg";
  }
}
bool isAngle(Kind k) { return k == Kind::RA || k == Kind::DEC || k == Kind::AZ || k == Kind::EL; }
double display(Kind k, double v) { return isAngle(k) ? v / kDeg : v; }

struct Measurement {
  Kind kind;
  double value;  // km, km/s, rad
  double sigma;
  std::string source;
};

enum class RecordType { RDO, EOO, RFO };
const char* typeName(RecordType t) { return t == RecordType::RDO ? "RDO" : t == RecordType::EOO ? "EOO" : "RFO"; }

struct Candidate {
  size_t block;
  double d2 = 0, logDetS = 0, pValue = 0, logLikelihood = 0, posterior = 0;
  bool inGate = false;
  std::vector<double> residual, predicted, s;
  std::array<double, 6> state{};
  Mat6 p{};
  double lightTime = 0;
};

struct Observation {
  RecordType type;
  const uint8_t* bytes;
  size_t length;
  std::string id, sensorKey, trackId;
  Utc time;
  Frame sensorFrame = Frame::ITRF;
  Vec3 sensor{};          // km, in sensorFrame
  Frame angleFrame = Frame::J2000;
  std::vector<Measurement> z;
  // filled by evaluation
  Vec3 sensorGcrf{}, sensorVelocityGcrf{};
  Mat3 itrf{};            // GCRF -> ITRF at the observation time
  Mat3 enu{};             // ITRF -> local east, north, up
  bool haveEarth = false;
  std::vector<Candidate> candidates;  // best per object key, sorted by d2
  double gate = 0;
  long assigned = -1;     // index into candidates
  std::string status, reason;
  bool ambiguous = false, conflict = false;
};

struct Options {
  double gateProbability = 0.9973;
  bool lightTime = true;
  double minPosterior = 0.99;
  double clutterDensity = 0.0;
  std::string scan = "sensor_time";
  int maxCandidates = 5;
  bool geometry = true;
};

bool readOptions(const Json& j, Options& o) {
  NEED(j.is_object(), "options must be a JSON object.");
  for (auto it = j.begin(); it != j.end(); ++it) {
    const std::string& k = it.key();
    const Json& v = it.value();
    if (k == "gate_probability") { NEED(v.is_number() && v.get<double>() > 0 && v.get<double>() < 1, "gate_probability must be in (0, 1)."); o.gateProbability = v.get<double>(); }
    else if (k == "light_time") { NEED(v.is_boolean(), "light_time must be true or false."); o.lightTime = v.get<bool>(); }
    else if (k == "min_posterior") { NEED(v.is_number() && v.get<double>() > 0 && v.get<double>() <= 1, "min_posterior must be in (0, 1]."); o.minPosterior = v.get<double>(); }
    else if (k == "clutter_density") { NEED(v.is_number() && v.get<double>() >= 0, "clutter_density must be a non-negative number."); o.clutterDensity = v.get<double>(); }
    else if (k == "scan") { NEED(v.is_string() && (v == "sensor_time" || v == "track" || v == "observation"), "scan must be sensor_time, track or observation."); o.scan = v.get<std::string>(); }
    else if (k == "max_candidates") { NEED(v.is_number_integer() && v.get<int>() >= 1 && v.get<int>() <= 50, "max_candidates must be an integer in [1, 50]."); o.maxCandidates = v.get<int>(); }
    else if (k == "geometry") { NEED(v.is_boolean(), "geometry must be true or false."); o.geometry = v.get<bool>(); }
    else { error = "Unknown option " + k + "."; return false; }
  }
  return true;
}

void add(std::vector<Measurement>& z, Kind kind, double value, double sigma, const char* source, bool angle) {
  if (!(sigma > 0) || !std::isfinite(value) || !std::isfinite(sigma)) return;
  z.push_back({kind, angle ? value * kDeg : value, angle ? sigma * kDeg : sigma, source});
}

bool geodetic(double latDeg, double lonDeg, double altKm, Vec3& out) {
  double xyz[3];
  NEED(eraGd2gc(1, lonDeg * kDeg, latDeg * kDeg, altKm * 1000.0, xyz) == 0, "A sensor's geodetic position is invalid.");
  out = {xyz[0] / 1000.0, xyz[1] / 1000.0, xyz[2] / 1000.0};
  return true;
}

bool loadRdo(const RDO* r, Observation& o) {
  o.id = r->ID() ? r->ID()->str() : "";
  o.sensorKey = r->ID_SENSOR() ? r->ID_SENSOR()->str() : r->ORIG_SENSOR_ID() ? r->ORIG_SENSOR_ID()->str() : "";
  o.trackId = r->TRACK_ID() ? r->TRACK_ID()->str() : "";
  NEED(r->OB_TIME() && parseUtc(r->OB_TIME()->c_str(), o.time), "An $RDO has no valid OB_TIME (ISO 8601 UTC).");
  o.sensorFrame = classifyText(r->SEN_REFERENCE_FRAME() ? r->SEN_REFERENCE_FRAME()->str() : "");
  NEED(o.sensorFrame == Frame::ITRF || o.sensorFrame == Frame::GCRF || o.sensorFrame == Frame::J2000,
       "$RDO SEN_REFERENCE_FRAME must be ITRF/ECEF, GCRF or J2000.");
  o.sensor = {r->SENX(), r->SENY(), r->SENZ()};
  NEED(o.sensorFrame != Frame::ITRF || norm3(o.sensor) > 1.0, "An $RDO has no Earth-fixed sensor position (SENX, SENY, SENZ in km).");
  add(o.z, Kind::RANGE, r->RANGE(), r->RANGE_UNC(), "RANGE", false);
  if (r->RANGE_RATE_UNC() > 0) {
    add(o.z, Kind::RANGE_RATE, r->RANGE_RATE(), r->RANGE_RATE_UNC(), "RANGE_RATE", false);
  } else if (r->DOPPLER_UNC() > 0) {
    // Monostatic two-way Doppler of the carrier: df = -2 f rho_dot / c.
    NEED(r->DOPPLER_FREQUENCY() > 0, "An $RDO DOPPLER needs its carrier DOPPLER_FREQUENCY (Hz).");
    const double f = r->DOPPLER_FREQUENCY();
    add(o.z, Kind::RANGE_RATE, -kC * r->DOPPLER() / (2.0 * f), kC * r->DOPPLER_UNC() / (2.0 * f), "DOPPLER", false);
  }
  add(o.z, Kind::AZ, r->AZIMUTH(), r->AZIMUTH_UNC(), "AZIMUTH", true);
  add(o.z, Kind::EL, r->ELEVATION(), r->ELEVATION_UNC(), "ELEVATION", true);
  return true;
}

bool loadEoo(const EOO* r, Observation& o) {
  o.id = r->ID() ? r->ID()->str() : "";
  o.sensorKey = r->SENSOR_ID() ? r->SENSOR_ID()->str() : r->ORIG_SENSOR_ID() ? r->ORIG_SENSOR_ID()->str() : "";
  NEED(r->OB_TIME() && parseUtc(r->OB_TIME()->c_str(), o.time), "An $EOO has no valid OB_TIME (ISO 8601 UTC).");
  o.sensorFrame = r->SEN_REFERENCE_FRAME() ? classify(r->SEN_REFERENCE_FRAME()) : Frame::ITRF;
  NEED(o.sensorFrame == Frame::ITRF || o.sensorFrame == Frame::GCRF || o.sensorFrame == Frame::J2000,
       "$EOO SEN_REFERENCE_FRAME must be an ITRF realization, GCRF or J2000.");
  o.angleFrame = r->REFERENCE_FRAME() ? classify(r->REFERENCE_FRAME()) : Frame::J2000;
  NEED(o.angleFrame == Frame::GCRF || o.angleFrame == Frame::J2000, "$EOO REFERENCE_FRAME (of RA and DECLINATION) must be J2000, EME2000, GCRF or ICRF.");
  o.sensor = {r->SENX(), r->SENY(), r->SENZ()};
  if (o.sensorFrame == Frame::ITRF && norm3(o.sensor) == 0.0) {
    // No Cartesian position: the WGS-84 geodetic one.
    if (!geodetic(r->SENLAT(), r->SENLON(), r->SENALT(), o.sensor)) return false;
  }
  add(o.z, Kind::RA, r->RA(), r->RA_UNC(), "RA", true);
  add(o.z, Kind::DEC, r->DECLINATION(), r->DECLINATION_UNC(), "DECLINATION", true);
  add(o.z, Kind::AZ, r->AZIMUTH(), r->AZIMUTH_UNC(), "AZIMUTH", true);
  add(o.z, Kind::EL, r->ELEVATION(), r->ELEVATION_UNC(), "ELEVATION", true);
  add(o.z, Kind::RANGE, r->RANGE(), r->RANGE_UNC(), "RANGE", false);
  add(o.z, Kind::RANGE_RATE, r->RANGE_RATE(), r->RANGE_RATE_UNC(), "RANGE_RATE", false);
  return true;
}

bool loadRfo(const RFO* r, Observation& o) {
  o.id = r->ID() ? r->ID()->str() : "";
  o.sensorKey = r->ID_SENSOR() ? r->ID_SENSOR()->str() : r->ORIG_SENSOR_ID() ? r->ORIG_SENSOR_ID()->str() : "";
  o.trackId = r->TRACK_ID() ? r->TRACK_ID()->str() : "";
  NEED(r->OB_TIME() && parseUtc(r->OB_TIME()->c_str(), o.time), "An $RFO has no valid OB_TIME (ISO 8601 UTC).");
  o.sensorFrame = Frame::ITRF;
  if (!geodetic(r->SENLAT(), r->SENLON(), r->SENALT(), o.sensor)) return false;
  add(o.z, Kind::RANGE, r->RANGE(), r->RANGE_UNC(), "RANGE", false);
  add(o.z, Kind::AZ, r->AZIMUTH(), r->AZIMUTH_UNC(), "AZIMUTH", true);
  add(o.z, Kind::EL, r->ELEVATION(), r->ELEVATION_UNC(), "ELEVATION", true);
  if (r->RANGE_RATE_UNC() > 0) {
    add(o.z, Kind::RANGE_RATE, r->RANGE_RATE(), r->RANGE_RATE_UNC(), "RANGE_RATE", false);
  } else if (r->FREQUENCY() > 0 && r->NOMINAL_FREQUENCY() > 0) {
    // One-way Doppler: f = f0 (1 - rho_dot / c), so rho_dot = c (1 - f / f0).
    NEED(r->FREQUENCY_UNC() > 0, "An $RFO carries a Doppler FREQUENCY without FREQUENCY_UNC or RANGE_RATE_UNC.");
    const double f0 = r->NOMINAL_FREQUENCY();  // MHz, as FREQUENCY and FREQUENCY_UNC
    add(o.z, Kind::RANGE_RATE, kC * (1.0 - r->FREQUENCY() / f0), kC * r->FREQUENCY_UNC() / f0, "DOPPLER", false);
  }
  return true;
}

// ── measurement model: predicted value and Jacobian row over the GCRF state ──
bool predict(const Observation& o, Kind kind, const std::array<double, 6>& x, double& h, std::array<double, 6>& row) {
  const Vec3 dr = sub3({x[0], x[1], x[2]}, o.sensorGcrf);
  const Vec3 dv = sub3({x[3], x[4], x[5]}, o.sensorVelocityGcrf);
  const double rho = norm3(dr);
  NEED(rho > 0, "A prediction coincides with its sensor.");
  const Vec3 u = scale3(dr, 1.0 / rho);
  row.fill(0.0);
  auto setPosition = [&row](const Vec3& g) { row[0] = g[0]; row[1] = g[1]; row[2] = g[2]; };
  switch (kind) {
    case Kind::RANGE:
      h = rho;
      setPosition(u);
      return true;
    case Kind::RANGE_RATE: {
      h = dot3(u, dv);
      setPosition(scale3(sub3(dv, scale3(u, h)), 1.0 / rho));
      row[3] = u[0]; row[4] = u[1]; row[5] = u[2];
      return true;
    }
    case Kind::RA: case Kind::DEC: {
      const Mat3 a = o.angleFrame == Frame::J2000 ? gcrfToJ2000() : Mat3{{{1, 0, 0}, {0, 1, 0}, {0, 0, 1}}};
      const Vec3 d = apply3(a, dr);
      const double q = d[0] * d[0] + d[1] * d[1], sq = std::sqrt(q);
      NEED(sq > 0, "A line of sight is along the pole of the RA/Dec frame.");
      if (kind == Kind::RA) {
        h = std::atan2(d[1], d[0]);
        if (h < 0) h += 2 * kPi;
        setPosition(rowTimes3({-d[1] / q, d[0] / q, 0}, a));
      } else {
        h = std::asin(d[2] / rho);
        setPosition(rowTimes3({-d[0] * d[2] / (rho * rho * sq), -d[1] * d[2] / (rho * rho * sq), sq / (rho * rho)}, a));
      }
      return true;
    }
    case Kind::AZ: case Kind::EL: {
      NEED(o.haveEarth, "Azimuth and elevation need an Earth-fixed sensor.");
      const Mat3 a = mul3(o.enu, o.itrf);
      const Vec3 d = apply3(a, dr);  // east, north, up
      const double q = d[0] * d[0] + d[1] * d[1], sq = std::sqrt(q);
      NEED(sq > 0, "A line of sight is at the sensor's zenith.");
      if (kind == Kind::AZ) {
        h = std::atan2(d[0], d[1]);
        if (h < 0) h += 2 * kPi;
        setPosition(rowTimes3({d[1] / q, -d[0] / q, 0}, a));
      } else {
        h = std::asin(d[2] / rho);
        setPosition(rowTimes3({-d[0] * d[2] / (rho * rho * sq), -d[1] * d[2] / (rho * rho * sq), sq / (rho * rho)}, a));
      }
      return true;
    }
  }
  return false;
}

double wrap(double a) {
  while (a > kPi) a -= 2 * kPi;
  while (a <= -kPi) a += 2 * kPi;
  return a;
}

bool sensorGeometry(Observation& o) {
  const bool earthFixed = o.sensorFrame == Frame::ITRF;
  for (const auto& m : o.z) {
    if (m.kind == Kind::AZ || m.kind == Kind::EL) NEED(earthFixed, "Azimuth and elevation need an Earth-fixed sensor.");
    if (m.kind == Kind::RANGE_RATE) NEED(earthFixed, "Range rate needs an Earth-fixed sensor (an inertial sensor position carries no velocity).");
  }
  if (!earthFixed) {
    o.sensorGcrf = o.sensorFrame == Frame::J2000 ? apply3(transpose3(gcrfToJ2000()), o.sensor) : o.sensor;
    o.sensorVelocityGcrf = {0, 0, 0};
    return true;
  }
  Earth e;
  if (!earthAt(o.time, e)) return false;
  o.itrf = e.r;
  o.haveEarth = true;
  const Mat3 back = transpose3(e.r);
  o.sensorGcrf = apply3(back, o.sensor);
  o.sensorVelocityGcrf = apply3(transpose3(e.rate), o.sensor);
  double xyz[3] = {o.sensor[0] * 1000, o.sensor[1] * 1000, o.sensor[2] * 1000}, lon, lat, height;
  NEED(eraGc2gd(1, xyz, &lon, &lat, &height) == 0, "A sensor position has no geodetic equivalent.");
  o.enu = {{{-std::sin(lon), std::cos(lon), 0},
            {-std::sin(lat) * std::cos(lon), -std::sin(lat) * std::sin(lon), std::cos(lat)},
            {std::cos(lat) * std::cos(lon), std::cos(lat) * std::sin(lon), std::sin(lat)}}};
  return true;
}

// One observation against one prediction block.
bool evaluate(Observation& o, size_t bi, const Options& opt, Candidate& c, bool& covered) {
  const Block& b = blocks[bi];
  c.block = bi;
  std::array<double, 6> x;
  if (!predictGcrf(b, o.time, x, &c.p, covered)) return false;
  if (!covered) return true;
  // Light time: the state at emission, t - tau, seen from the sensor at t.
  double tau = 0;
  if (opt.lightTime) {
    for (int i = 0; i < 4; ++i) {
      tau = norm3(sub3({x[0], x[1], x[2]}, o.sensorGcrf)) / kC;
      bool inside;
      if (!predictGcrf(b, shifted(o.time, -tau), x, nullptr, inside)) return false;
      if (!inside) { covered = false; return true; }
    }
  }
  c.lightTime = tau;
  c.state = x;
  const size_t m = o.z.size();
  std::vector<std::array<double, 6>> hRows(m);
  c.residual.resize(m);
  c.predicted.resize(m);
  for (size_t i = 0; i < m; ++i) {
    double h;
    if (!predict(o, o.z[i].kind, x, h, hRows[i])) return false;
    if (opt.lightTime && o.z[i].kind == Kind::RANGE_RATE) {
      // d rho/dt of the light-time range |x(t - tau) - s(t)|, tau = rho / c:
      // rho_dot (1 + u.v_x / c) = u.(v_x - v_s).
      const Vec3 dr = sub3({x[0], x[1], x[2]}, o.sensorGcrf);
      h /= 1.0 + dot3(scale3(dr, 1.0 / norm3(dr)), {x[3], x[4], x[5]}) / kC;
    }
    c.predicted[i] = h;
    c.residual[i] = isAngle(o.z[i].kind) && (o.z[i].kind == Kind::RA || o.z[i].kind == Kind::AZ) ? wrap(o.z[i].value - h) : o.z[i].value - h;
  }
  // S = H P H^T + R
  c.s.assign(m * m, 0.0);
  for (size_t i = 0; i < m; ++i)
    for (size_t j = 0; j <= i; ++j) {
      double v = 0;
      for (int k = 0; k < 6; ++k)
        for (int l = 0; l < 6; ++l) v += hRows[i][k] * c.p[k][l] * hRows[j][l];
      if (i == j) v += o.z[i].sigma * o.z[i].sigma;
      c.s[i * m + j] = c.s[j * m + i] = v;
    }
  Cholesky chol;
  NEED(chol.factor(c.s, m), "The innovation covariance of observation " + o.id + " against " + b.key + " is not positive definite.");
  c.d2 = chol.mahalanobis(c.residual);
  c.logDetS = chol.logDet();
  c.pValue = chiSquareTail(c.d2, static_cast<int>(m));
  c.logLikelihood = -0.5 * c.d2 - 0.5 * (double(m) * std::log(2 * kPi) + c.logDetS);
  c.inGate = c.d2 <= o.gate;
  return true;
}

// ── output records ──
template <typename T>
std::vector<uint8_t> finish(flatbuffers::FlatBufferBuilder& fbb, flatbuffers::Offset<T> root, const char* ident) {
  fbb.Finish(root, ident);
  return {fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize()};
}

// The record re-emitted: identity (or UCT) and the association statistics.
// `c` is the assigned candidate, or for a UCT the nearest one (null when no
// prediction covered the observation); `b` its object when assigned.
template <typename T>
void statistics(T& t, const Observation& o, const Candidate* c) {
  t.CORR_MAHALANOBIS_SQ = c ? c->d2 : 0.0;
  t.CORR_DOF = static_cast<uint8_t>(o.z.size());
  t.CORR_GATE = o.gate;
  t.CORR_P_VALUE = c ? c->pValue : 0.0;
  t.CORR_AMBIGUOUS = o.ambiguous;
}

std::vector<uint8_t> annotated(const Observation& o, const Block* b, const Candidate* c) {
  flatbuffers::FlatBufferBuilder fbb(o.length + 256);
  const std::string onOrbit = b ? (!b->objectId.empty() ? b->objectId : b->norad ? std::to_string(b->norad) : b->name) : "";
  const double posterior = b ? c->posterior : 0.0;
  if (o.type == RecordType::RDO) {
    std::unique_ptr<RDOT> t(GetRDO(o.bytes)->UnPack());
    t->UCT = b == nullptr;
    t->SAT_NO = b ? b->norad : 0;
    t->ON_ORBIT = onOrbit;
    t->CORR_QUALITY = posterior;
    statistics(*t, o, c);
    return finish(fbb, RDO::Pack(fbb, t.get()), "$RDO");
  }
  if (o.type == RecordType::EOO) {
    std::unique_ptr<EOOT> t(GetEOO(o.bytes)->UnPack());
    t->UCT = b == nullptr;
    t->NORAD_CAT_ID = b ? static_cast<int32_t>(b->norad) : 0;
    t->ID_ON_ORBIT = onOrbit;
    t->CORR_QUALITY = static_cast<float>(posterior);
    statistics(*t, o, c);
    return finish(fbb, EOO::Pack(fbb, t.get()), "$EOO");
  }
  std::unique_ptr<RFOT> t(GetRFO(o.bytes)->UnPack());
  t->UCT = b == nullptr;
  t->SAT_NO = b ? b->norad : 0;
  t->ON_ORBIT = onOrbit;
  t->CONFIDENCE = posterior;
  statistics(*t, o, c);
  return finish(fbb, RFO::Pack(fbb, t.get()), "$RFO");
}

Json vec(const Vec3& v) { return Json::array({v[0], v[1], v[2]}); }

Json objectJson(const Block& b) {
  return {{"key", b.key}, {"norad_cat_id", b.norad}, {"object_id", b.objectId}, {"object_name", b.name}};
}

// Measured line of sight in GCRF, when the observation has angles.
bool lineOfSight(const Observation& o, Vec3& los) {
  double ra = NAN, dec = NAN, az = NAN, el = NAN;
  for (const auto& m : o.z) {
    if (m.kind == Kind::RA) ra = m.value;
    if (m.kind == Kind::DEC) dec = m.value;
    if (m.kind == Kind::AZ) az = m.value;
    if (m.kind == Kind::EL) el = m.value;
  }
  if (std::isfinite(ra) && std::isfinite(dec)) {
    const Vec3 d{std::cos(dec) * std::cos(ra), std::cos(dec) * std::sin(ra), std::sin(dec)};
    los = o.angleFrame == Frame::J2000 ? apply3(transpose3(gcrfToJ2000()), d) : d;
    return true;
  }
  if (std::isfinite(az) && std::isfinite(el) && o.haveEarth) {
    const Vec3 local{std::sin(az) * std::cos(el), std::cos(az) * std::cos(el), std::sin(el)};
    los = apply3(transpose3(o.itrf), apply3(transpose3(o.enu), local));
    return true;
  }
  return false;
}

const uint8_t* rootOf(const plugin_input_frame_t* frame, size_t& length, const char* ident) {
  const uint8_t* bytes = frame->payload;
  length = frame->payload_length;
  if (length >= 12 && std::memcmp(bytes + 8, ident, 4) == 0 && std::memcmp(bytes + 4, ident, 4) != 0) { bytes += 4; length -= 4; }
  return bytes;
}

flatbuffers::Verifier::Options verifierOptions() {
  flatbuffers::Verifier::Options v;
  v.max_depth = 128;
  v.max_tables = 50000000;
  return v;
}

bool run(Json& report, std::vector<std::pair<std::string, std::pair<RecordType, std::vector<uint8_t>>>>& outputs) {
  Options opt;
  std::vector<Observation> obs;
  std::vector<const plugin_input_frame_t*> observationFrames;
  const uint32_t count = plugin_get_input_count();
  // Options first.
  for (uint32_t i = 0; i < count; ++i) {
    const auto* frame = plugin_get_input_frame(i);
    NEED(frame && frame->port_id, "An input frame has no port.");
    if (std::strcmp(frame->port_id, "options") == 0) {
      if (!frame->payload || frame->payload_length == 0) continue;
      const Json j = Json::parse(std::string(reinterpret_cast<const char*>(frame->payload), frame->payload_length), nullptr, false);
      NEED(!j.is_discarded(), "The options frame is not valid JSON.");
      if (!readOptions(j, opt)) return false;
    }
  }
  for (uint32_t i = 0; i < count; ++i) {
    const auto* frame = plugin_get_input_frame(i);
    const std::string port = frame->port_id;
    if (port == "options") continue;
    if (port == "earth_orientation") {
      const std::string e = ax::eop::addPayload(frame->payload, frame->payload_length, eopRows);
      NEED(e.empty(), "earth_orientation: " + e);
      continue;
    }
    if (port == "predictions") {
      size_t length;
      const uint8_t* bytes = rootOf(frame, length, "$OEM");
      NEED(bytes && length >= 8, "The predictions port must carry $OEM FlatBuffers.");
      flatbuffers::Verifier verifier(bytes, length, verifierOptions());
      NEED(VerifyOEMBuffer(verifier), "A predictions frame is not a valid $OEM FlatBuffer.");
      const OEM* oem = GetOEM(bytes);
      NEED(oem->EPHEMERIS_DATA_BLOCK() && oem->EPHEMERIS_DATA_BLOCK()->size() > 0, "An $OEM frame has no data blocks.");
      for (const auto* block : *oem->EPHEMERIS_DATA_BLOCK()) {
        Block b;
        if (!loadBlock(block, b)) return false;
        blocks.push_back(std::move(b));
      }
      continue;
    }
    NEED(port == "radar_observations" || port == "optical_observations" || port == "rf_observations", "Unknown input port " + port + ".");
    NEED(obs.size() < kMaxObservations, "Too many observations in one request.");
    Observation o;
    size_t length;
    const uint8_t* bytes;
    if (port == "radar_observations") {
      bytes = rootOf(frame, length, "$RDO");
      NEED(bytes && length >= 8 && RDOBufferHasIdentifier(bytes), "radar_observations carries $RDO FlatBuffers.");
      flatbuffers::Verifier verifier(bytes, length, verifierOptions());
      NEED(VerifyRDOBuffer(verifier), "A radar_observations frame is not a valid $RDO FlatBuffer.");
      o.type = RecordType::RDO;
      if (!loadRdo(GetRDO(bytes), o)) return false;
    } else if (port == "optical_observations") {
      bytes = rootOf(frame, length, "$EOO");
      NEED(bytes && length >= 8 && EOOBufferHasIdentifier(bytes), "optical_observations carries $EOO FlatBuffers.");
      flatbuffers::Verifier verifier(bytes, length, verifierOptions());
      NEED(VerifyEOOBuffer(verifier), "An optical_observations frame is not a valid $EOO FlatBuffer.");
      o.type = RecordType::EOO;
      if (!loadEoo(GetEOO(bytes), o)) return false;
    } else {
      bytes = rootOf(frame, length, "$RFO");
      NEED(bytes && length >= 8 && RFOBufferHasIdentifier(bytes), "rf_observations carries $RFO FlatBuffers.");
      flatbuffers::Verifier verifier(bytes, length, verifierOptions());
      NEED(VerifyRFOBuffer(verifier), "An rf_observations frame is not a valid $RFO FlatBuffer.");
      o.type = RecordType::RFO;
      if (!loadRfo(GetRFO(bytes), o)) return false;
    }
    NEED(!o.z.empty(), "Observation " + o.id + " has no measurement: a field is measured when its 1-sigma uncertainty is positive.");
    NEED(o.z.size() <= 6, "An observation has more than six measured components.");
    o.bytes = bytes;
    o.length = length;
    obs.push_back(std::move(o));
  }
  NEED(!obs.empty(), "At least one observation is required.");
  NEED(!blocks.empty(), "At least one prediction block is required.");

  std::map<int, double> gates;
  for (int m = 1; m <= 6; ++m) gates[m] = chiSquareQuantile(opt.gateProbability, m);

  // Gate every observation against every prediction covering its time.
  for (auto& o : obs) {
    o.gate = gates[static_cast<int>(o.z.size())];
    if (!sensorGeometry(o)) return false;
    std::map<std::string, Candidate> best;
    for (size_t bi = 0; bi < blocks.size(); ++bi) {
      Candidate c;
      bool covered = false;
      if (!evaluate(o, bi, opt, c, covered)) return false;
      if (!covered) continue;
      auto it = best.find(blocks[bi].key);
      if (it == best.end() || c.d2 < it->second.d2) best[blocks[bi].key] = std::move(c);
    }
    for (auto& [key, c] : best) o.candidates.push_back(std::move(c));
    std::sort(o.candidates.begin(), o.candidates.end(), [](const Candidate& a, const Candidate& b) { return a.d2 < b.d2; });
    // Posterior over the in-gate candidates and, with a clutter density, a
    // new-object hypothesis: p_j = L_j / (beta + sum_k L_k).
    double top = -INFINITY;
    for (const auto& c : o.candidates) if (c.inGate) top = std::max(top, c.logLikelihood);
    if (std::isfinite(top)) {
      double sum = opt.clutterDensity > 0 ? std::exp(std::log(opt.clutterDensity) - top) : 0.0;
      for (const auto& c : o.candidates) if (c.inGate) sum += std::exp(c.logLikelihood - top);
      for (auto& c : o.candidates) c.posterior = c.inGate ? std::exp(c.logLikelihood - top) / sum : 0.0;
    }
  }

  // Scans: observations that may not share an object.
  std::map<std::string, std::vector<size_t>> scans;
  for (size_t i = 0; i < obs.size(); ++i) {
    std::string key;
    if (opt.scan == "observation") key = std::to_string(i);
    else if (opt.scan == "track" && !obs[i].trackId.empty()) key = "track:" + obs[i].trackId;
    else {
      char t[64];
      std::snprintf(t, sizeof t, "%.6f", obs[i].time.t);
      key = obs[i].sensorKey + "|" + t;
    }
    scans[key].push_back(i);
  }
  size_t ambiguousCount = 0;
  for (const auto& [key, rows] : scans) {
    std::vector<std::string> objects;
    std::map<std::string, size_t> column;
    for (size_t r : rows)
      for (const auto& c : obs[r].candidates)
        if (c.inGate && !column.count(blocks[c.block].key)) { column[blocks[c.block].key] = objects.size(); objects.push_back(blocks[c.block].key); }
    const size_t n = rows.size(), m = objects.size() + n;
    std::vector<double> cost(n * m, kForbidden);
    for (size_t i = 0; i < n; ++i) {
      const auto& o = obs[rows[i]];
      for (const auto& c : o.candidates) if (c.inGate) cost[i * m + column[blocks[c.block].key]] = c.d2;
      cost[i * m + objects.size() + i] = o.gate;  // leaving it unassigned costs its gate
    }
    std::vector<long> columnOf;
    double total;
    NEED(solveAssignment(cost, n, m, columnOf, &total), "The scan assignment has no solution.");
    for (size_t i = 0; i < n; ++i) {
      auto& o = obs[rows[i]];
      const long j = columnOf[i];
      if (j >= 0 && static_cast<size_t>(j) < objects.size()) {
        for (size_t k = 0; k < o.candidates.size(); ++k)
          if (blocks[o.candidates[k].block].key == objects[static_cast<size_t>(j)]) o.assigned = static_cast<long>(k);
        o.status = "associated";
      } else {
        o.status = "uct";
        o.reason = o.candidates.empty() ? "no-prediction" : !o.candidates.front().inGate ? "outside-gate" : "lost-assignment";
      }
      // Ambiguous: the assigned (or, for a UCT, the best) in-gate candidate's
      // posterior is under min_posterior, or the assignment gave the
      // observation other than its best candidate.
      const long judged = o.assigned >= 0 ? o.assigned : 0;
      const bool weak = !o.candidates.empty() && o.candidates[static_cast<size_t>(judged)].inGate &&
                        o.candidates[static_cast<size_t>(judged)].posterior < opt.minPosterior;
      o.conflict = !o.candidates.empty() && o.candidates.front().inGate && o.assigned != 0;
      o.ambiguous = weak || o.conflict;
      if (o.ambiguous) ++ambiguousCount;
    }
  }

  // Report and records.
  Json observationsJson = Json::array();
  Json associations = Json::array();
  Json ucts = Json::array();
  for (size_t i = 0; i < obs.size(); ++i) {
    const auto& o = obs[i];
    Json measured = Json::object(), sigma = Json::object(), sources = Json::object();
    for (const auto& z : o.z) {
      measured[kindName(z.kind)] = display(z.kind, z.value);
      sigma[kindName(z.kind)] = display(z.kind, z.sigma);
      sources[kindName(z.kind)] = z.source;
    }
    Json candidates = Json::array();
    for (size_t k = 0; k < o.candidates.size() && (k < static_cast<size_t>(opt.maxCandidates) || o.candidates[k].inGate); ++k) {
      const auto& c = o.candidates[k];
      Json residual = Json::object(), predicted = Json::object();
      for (size_t q = 0; q < o.z.size(); ++q) {
        residual[kindName(o.z[q].kind)] = display(o.z[q].kind, c.residual[q]);
        predicted[kindName(o.z[q].kind)] = display(o.z[q].kind, c.predicted[q]);
      }
      Json cj = {{"object", objectJson(blocks[c.block])}, {"d2", c.d2}, {"p_value", c.pValue}, {"posterior", c.posterior},
                 {"in_gate", c.inGate}, {"log_det_s", c.logDetS}, {"residual", residual}, {"predicted", predicted},
                 {"light_time_s", c.lightTime}};
      if (opt.geometry) {
        Json cov = Json::array();
        for (int r = 0; r < 3; ++r) for (int q = 0; q < 3; ++q) cov.push_back(c.p[r][q]);
        cj["position_gcrf_km"] = Json::array({c.state[0], c.state[1], c.state[2]});
        cj["velocity_gcrf_km_s"] = Json::array({c.state[3], c.state[4], c.state[5]});
        cj["position_covariance_km2"] = cov;
      }
      candidates.push_back(cj);
    }
    Json oj = {{"index", i}, {"type", typeName(o.type)}, {"id", o.id}, {"time", o.time.text}, {"sensor", o.sensorKey},
               {"measured", measured}, {"sigma", sigma}, {"source", sources}, {"dof", o.z.size()}, {"gate", o.gate},
               {"status", o.status}, {"ambiguous", o.ambiguous}, {"assignment_conflict", o.conflict}, {"candidates", candidates}};
    if (!o.reason.empty()) oj["reason"] = o.reason;
    oj["sensor_gcrf_km"] = vec(o.sensorGcrf);
    // omega x r rotated to GCRF for an Earth-fixed sensor; an inertial
    // sensor position carries no velocity.
    oj["sensor_velocity_gcrf_km_s"] = o.haveEarth ? vec(o.sensorVelocityGcrf) : Json();
    Vec3 los;
    if (lineOfSight(o, los)) oj["line_of_sight_gcrf"] = vec(los);
    const Block* assigned = o.assigned >= 0 ? &blocks[o.candidates[static_cast<size_t>(o.assigned)].block] : nullptr;
    const Candidate* judged = assigned ? &o.candidates[static_cast<size_t>(o.assigned)] : o.candidates.empty() ? nullptr : &o.candidates.front();
    if (assigned) {
      const auto& c = o.candidates[static_cast<size_t>(o.assigned)];
      oj["object"] = objectJson(*assigned);
      oj["d2"] = c.d2;
      oj["p_value"] = c.pValue;
      oj["posterior"] = c.posterior;
      associations.push_back({{"observation", i}, {"id", o.id}, {"object", assigned->key}, {"d2", c.d2}, {"dof", o.z.size()},
                              {"p_value", c.pValue}, {"posterior", c.posterior}, {"ambiguous", o.ambiguous}});
    } else {
      ucts.push_back({{"observation", i}, {"id", o.id}, {"reason", o.reason},
                      {"nearest", o.candidates.empty() ? Json() : Json(blocks[o.candidates.front().block].key)},
                      {"nearest_d2", o.candidates.empty() ? Json() : Json(o.candidates.front().d2)}});
    }
    observationsJson.push_back(oj);
    const char* family = o.type == RecordType::RDO ? "radar" : o.type == RecordType::EOO ? "optical" : "rf";
    outputs.push_back({std::string(family) + (assigned ? "_associated" : "_ucts"), {o.type, annotated(o, assigned, judged)}});
  }
  Json gatesJson = Json::object();
  for (const auto& [m, g] : gates) gatesJson[std::to_string(m)] = g;
  report = {
    {"method", "chi-square gate on S = H P H^T + R, global nearest neighbour per scan (Hungarian), gate as the non-assignment cost"},
    {"options", {{"gate_probability", opt.gateProbability}, {"light_time", opt.lightTime}, {"min_posterior", opt.minPosterior},
                 {"clutter_density", opt.clutterDensity}, {"scan", opt.scan}}},
    {"gate_thresholds", gatesJson},
    {"earth_orientation_rows", eopRows.size()},
    {"counts", {{"observations", obs.size()}, {"predictions", blocks.size()}, {"scans", scans.size()},
                {"associated", associations.size()}, {"ucts", ucts.size()}, {"ambiguous", ambiguousCount}}},
    {"associations", associations},
    {"ucts", ucts},
    {"observations", observationsJson},
  };
  return true;
}

void reset() {
  error.clear();
  eopRows.clear();
  blocks.clear();
}

bool solve(const Json& j, Json& out) {
  NEED(j.is_object(), "The problem must be a JSON object.");
  size_t rows = 0, columns = 0;
  std::vector<double> cost;
  if (j.contains("cost")) {
    const Json& c = j["cost"];
    NEED(c.is_array() && !c.empty() && c[0].is_array(), "cost must be a non-empty array of rows.");
    rows = c.size();
    columns = c[0].size();
    cost.assign(rows * columns, kForbidden);
    for (size_t i = 0; i < rows; ++i) {
      NEED(c[i].is_array() && c[i].size() == columns, "Every cost row must have the same length.");
      for (size_t k = 0; k < columns; ++k) {
        if (c[i][k].is_null()) continue;
        NEED(c[i][k].is_number() && std::isfinite(c[i][k].get<double>()), "Costs must be finite numbers or null (forbidden).");
        cost[i * columns + k] = c[i][k].get<double>();
      }
    }
  } else {
    NEED(j.contains("rows") && j.contains("columns") && j.contains("entries") && j["rows"].is_number_unsigned() &&
         j["columns"].is_number_unsigned() && j["entries"].is_array(), "A sparse problem needs rows, columns and entries.");
    rows = j["rows"].get<size_t>();
    columns = j["columns"].get<size_t>();
    NEED(rows > 0 && columns > 0 && rows * columns <= 25000000, "The problem size is out of range.");
    cost.assign(rows * columns, kForbidden);
    for (const auto& e : j["entries"]) {
      NEED(e.is_array() && e.size() == 3 && e[0].is_number_unsigned() && e[1].is_number_unsigned() && e[2].is_number(),
           "Each entry is [row, column, cost].");
      const size_t i = e[0].get<size_t>(), k = e[1].get<size_t>();
      NEED(i < rows && k < columns, "An entry is outside the problem.");
      cost[i * columns + k] = std::min(cost[i * columns + k], e[2].get<double>());
    }
  }
  std::vector<double> unassigned;
  if (j.contains("unassigned_cost")) {
    const Json& u = j["unassigned_cost"];
    if (u.is_number()) unassigned.assign(rows, u.get<double>());
    else {
      NEED(u.is_array() && u.size() == rows, "unassigned_cost is a number or one number per row.");
      for (const auto& x : u) { NEED(x.is_number(), "unassigned_cost entries must be numbers."); unassigned.push_back(x.get<double>()); }
    }
  }
  size_t width = columns;
  std::vector<double> problem = cost;
  if (!unassigned.empty()) {
    width = columns + rows;
    problem.assign(rows * width, kForbidden);
    for (size_t i = 0; i < rows; ++i) {
      for (size_t k = 0; k < columns; ++k) problem[i * width + k] = cost[i * columns + k];
      problem[i * width + columns + i] = unassigned[i];
    }
  }
  NEED(rows <= width, "There are more rows than columns and no unassigned_cost.");
  std::vector<long> columnOf;
  double total;
  NEED(solveAssignment(problem, rows, width, columnOf, &total), "The assignment problem has no feasible solution.");
  Json assignment = Json::array();
  size_t assigned = 0;
  for (size_t i = 0; i < rows; ++i) {
    const bool real = columnOf[i] >= 0 && static_cast<size_t>(columnOf[i]) < columns;
    assignment.push_back(real ? columnOf[i] : -1);
    assigned += real;
  }
  out = {{"assignment", assignment}, {"total_cost", total}, {"rows", rows}, {"columns", columns}, {"assigned", assigned},
         {"method", "Hungarian (shortest augmenting path with potentials)"}};
  return true;
}

}  // namespace

extern "C" int associate_observations() {
  reset();
  Json report;
  std::vector<std::pair<std::string, std::pair<RecordType, std::vector<uint8_t>>>> outputs;
  if (!run(report, outputs)) return fail(error);
  const std::string text = report.dump();
  if (plugin_push_output_ex("report", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
        reinterpret_cast<const uint8_t*>(text.data()), static_cast<uint32_t>(text.size())) < 0) return 1;
  for (const auto& [port, record] : outputs) {
    const char* code = typeName(record.first);
    const std::string schema = std::string(code) + ".fbs", ident = std::string("$") + code;
    if (plugin_push_output_ex(port.c_str(), schema.c_str(), ident.c_str(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, code, 0, 0,
          record.second.data(), static_cast<uint32_t>(record.second.size())) < 0) return 1;
  }
  return 0;
}

extern "C" int solve_assignment() {
  reset();
  const int32_t index = plugin_find_input_index("problem", 0);
  const auto* frame = index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(index)) : nullptr;
  if (!frame || !frame->payload || frame->payload_length == 0) return fail("A problem frame is required.");
  const Json j = Json::parse(std::string(reinterpret_cast<const char*>(frame->payload), frame->payload_length), nullptr, false);
  if (j.is_discarded()) return fail("The problem frame is not valid JSON.");
  Json out;
  if (!solve(j, out)) return fail(error);
  const std::string text = out.dump();
  if (plugin_push_output_ex("solution", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
        reinterpret_cast<const uint8_t*>(text.data()), static_cast<uint32_t>(text.size())) < 0) return 1;
  return 0;
}
