#include "space_data_module_invoke.h"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <map>
#include <string>
#include <vector>

// Simulated sensor observations ($ACW SIMULATE_OBSERVATIONS in; $RDO, $EOO,
// $RFO and the $ACW result out).
//
// Truth: each target's Earth-fixed states with velocity (cubic Hermite).
// Visibility: the request's ACCESS windows, computed per sensor and target by
// COMPUTE_ACCESS_WINDOWS; this module does not re-derive visibility.
// Schedule: per sensor, earliest-deadline-first over the open windows, one
// track per target at a time, REVISIT_INTERVAL_S between a target's tracks,
// at most MAX_SIMULTANEOUS_TRACKS at once, TRACK_DURATION_S per track.
// Measurements: at each observation time the host and target are rotated to
// GCRF (IAU 2006/2000A, CIO based, with the request's EOP) and every error
// model's measurement is predicted by the estimation module's
// predict_measurement, the model the estimator inverts: downleg light time,
// receiver time tag, optional troposphere. A RADAR DOPPLER is the echo's
// two-way shift of the sensor's TRANSMIT_FREQUENCY_HZ, twice the one-way
// shift ($RDO DOPPLER, SDS 1.242.0); a PASSIVE_RF one is the one-way shift of
// the target's emission. Noise per component: a first-order
// Gauss-Markov sequence with the model's CORRELATION_TIME_SECONDS within a
// track (white when 0) plus one bias per sensor and model, BIAS +
// BIAS_SIGMA * N(0, 1), for the whole run.
// Detection: RADAR SNR = REFERENCE_SNR_DB + 10 log10(RCS / REFERENCE_RCS)
// - 40 log10(R / REFERENCE_RANGE); OPTICAL magnitude of a diffuse sphere,
// Earth's shadow cone and host darkness; PASSIVE_RF link budget. False alarms
// are a Poisson process per track, flagged UCT.

namespace {
namespace est = sdn::estimation;
namespace fr = sdn::frames;
using est::Vec3;

constexpr double kPi = 3.14159265358979323846;
constexpr double kDeg = 180.0 / kPi;
constexpr double kDay = 86400.0;
constexpr double kSunRadius = 6.957e8;          // m, IAU 2015 nominal solar radius
constexpr double kEarthRadius = 6378137.0;      // m, WGS 84 equatorial radius (shadow cone)
constexpr double kSunMagnitudeG = -26.90;       // Sun's apparent Gaia G magnitude at 1 au
constexpr double kAu = 1.495978707e11;          // m
constexpr double kBoltzmannDb = -228.59916717321767;   // 10 log10(1.380649e-23 J/K), dBW/(K Hz)
constexpr size_t kMaxObservations = 2000000;

std::string error;
int fail(const std::string& message) { plugin_set_error("invalid-observation-simulation-request", message.c_str()); return 1; }

Vec3 v3(const fr::Vec3& v) { return {v.x, v.y, v.z}; }
fr::Vec3 f3(const Vec3& v) { return {v.x, v.y, v.z}; }

// ── deterministic randomness: SplitMix64-seeded PCG32, Box-Muller normals ──
uint64_t splitmix(uint64_t x) {
  x += 0x9e3779b97f4a7c15ULL;
  x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9ULL;
  x = (x ^ (x >> 27)) * 0x94d049bb133111ebULL;
  return x ^ (x >> 31);
}
uint64_t hashText(uint64_t seed, const std::string& text) {
  uint64_t h = splitmix(seed);
  for (unsigned char c : text) h = splitmix(h ^ c);
  return h;
}
struct Random {
  uint64_t state, inc;
  explicit Random(uint64_t seed) : state(0), inc((splitmix(seed ^ 0x5851f42d4c957f2dULL) << 1) | 1) { next(); state += splitmix(seed); next(); }
  uint32_t next() {
    const uint64_t old = state;
    state = old * 6364136223846793005ULL + inc;
    const uint32_t xorshifted = uint32_t(((old >> 18) ^ old) >> 27), rot = uint32_t(old >> 59);
    return (xorshifted >> rot) | (xorshifted << ((32 - rot) & 31));
  }
  double uniform() { return (double(next()) + 0.5) / 4294967296.0; }
  double normal() { return std::sqrt(-2.0 * std::log(uniform())) * std::cos(2.0 * kPi * uniform()); }
  uint32_t poisson(double mean) {
    if (!(mean > 0)) return 0;
    const double limit = std::exp(-std::min(mean, 700.0));
    uint32_t k = 0;
    double p = uniform();
    while (p > limit && k < 100000) { p *= uniform(); ++k; }
    return k;
  }
};

// ── time: Julian Date TT (two-part) to UTC text and UT1 ───────────────────
bool isoUtc(double jdTt, std::string& out) {
  double tai1, tai2, utc1, utc2;
  if (eraTttai(jdTt, 0.0, &tai1, &tai2) != 0 || eraTaiutc(tai1, tai2, &utc1, &utc2) != 0) return false;
  int ihmsf[4], y, m, d;
  if (eraD2dtf("UTC", 6, utc1, utc2, &y, &m, &d, ihmsf) != 0) return false;
  char buffer[40];
  std::snprintf(buffer, sizeof buffer, "%04d-%02d-%02dT%02d:%02d:%02d.%06dZ", y, m, d, ihmsf[0], ihmsf[1], ihmsf[2], ihmsf[3]);
  out = buffer;
  return true;
}

// ── Earth orientation: linear in MJD between EOP rows (UTC days), nearest
// row outside the table, zero when the request carries none ──────────────
struct EopRow { double mjd; fr::EarthOrientation value; };
std::vector<EopRow> eopTable;
double pick(const EOP* row, flatbuffers::voffset_t field, double hp, double legacy) {
  return reinterpret_cast<const flatbuffers::Table*>(row)->CheckField(field) ? hp : legacy;
}
bool loadEop(const ACWRequest* request) {
  eopTable.clear();
  if (!request->EARTH_ORIENTATION()) return true;
  for (const EOP* row : *request->EARTH_ORIENTATION()) {
    EopRow r;
    r.mjd = row->MJD();
    r.value.xPole = pick(row, EOP::VT_X_POLE_WANDER_RADIANS_HP, row->X_POLE_WANDER_RADIANS_HP(), row->X_POLE_WANDER_RADIANS());
    r.value.yPole = pick(row, EOP::VT_Y_POLE_WANDER_RADIANS_HP, row->Y_POLE_WANDER_RADIANS_HP(), row->Y_POLE_WANDER_RADIANS());
    r.value.dut1 = pick(row, EOP::VT_UT1_MINUS_UTC_SECONDS_HP, row->UT1_MINUS_UTC_SECONDS_HP(), row->UT1_MINUS_UTC_SECONDS());
    r.value.dX = pick(row, EOP::VT_X_CELESTIAL_POLE_OFFSET_RADIANS_HP, row->X_CELESTIAL_POLE_OFFSET_RADIANS_HP(), row->X_CELESTIAL_POLE_OFFSET_RADIANS());
    r.value.dY = pick(row, EOP::VT_Y_CELESTIAL_POLE_OFFSET_RADIANS_HP, row->Y_CELESTIAL_POLE_OFFSET_RADIANS_HP(), row->Y_CELESTIAL_POLE_OFFSET_RADIANS());
    if (!(r.mjd > 0) || !std::isfinite(r.value.xPole + r.value.yPole + r.value.dut1 + r.value.dX + r.value.dY)) {
      error = "EARTH_ORIENTATION rows need MJD and finite values.";
      return false;
    }
    eopTable.push_back(r);
  }
  std::sort(eopTable.begin(), eopTable.end(), [](const EopRow& a, const EopRow& b) { return a.mjd < b.mjd; });
  return true;
}
fr::EarthOrientation eopAt(double mjdUtc) {
  if (eopTable.empty()) return {};
  if (mjdUtc <= eopTable.front().mjd) return eopTable.front().value;
  if (mjdUtc >= eopTable.back().mjd) return eopTable.back().value;
  const auto hi = std::upper_bound(eopTable.begin(), eopTable.end(), mjdUtc, [](double t, const EopRow& r) { return t < r.mjd; });
  const EopRow& a = *(hi - 1);
  const EopRow& b = *hi;
  const double u = (mjdUtc - a.mjd) / (b.mjd - a.mjd);
  fr::EarthOrientation e;
  e.xPole = a.value.xPole + u * (b.value.xPole - a.value.xPole);
  e.yPole = a.value.yPole + u * (b.value.yPole - a.value.yPole);
  e.dut1 = a.value.dut1 + u * (b.value.dut1 - a.value.dut1);
  e.dX = a.value.dX + u * (b.value.dX - a.value.dX);
  e.dY = a.value.dY + u * (b.value.dY - a.value.dY);
  return e;
}
// GCRF -> ITRF at a TT Julian Date (UT1 from the interpolated UT1-UTC).
bool itrfFromGcrf(double jdTt, fr::Mat3& m) {
  double tai1, tai2, utc1, utc2, ut11, ut12;
  if (eraTttai(jdTt, 0.0, &tai1, &tai2) != 0 || eraTaiutc(tai1, tai2, &utc1, &utc2) != 0) return false;
  const fr::EarthOrientation eop = eopAt(utc1 - 2400000.5 + utc2);
  if (eraUtcut1(utc1, utc2, eop.dut1, &ut11, &ut12) != 0) return false;
  fr::Epoch epoch;
  epoch.tt1 = jdTt;
  epoch.tt2 = 0.0;
  epoch.ut11 = ut11;
  epoch.ut12 = ut12;
  m = fr::gcrfToItrf(epoch, eop);
  return true;
}

// ── sampled Earth-fixed series (seconds from the request epoch, m, m/s) ──
struct Series {
  std::vector<double> t;
  std::vector<std::array<double, 6>> s;
  bool velocity = false;
};
double epochJd = 0;
// Targets always interpolate with their velocities (a geostationary target
// has zero Earth-fixed velocity); observers and bodies without velocities
// are interpolated linearly.
bool loadSeries(const flatbuffers::Vector<flatbuffers::Offset<ACWStateSample>>* input, Series& out, bool withVelocity, const char* what) {
  if (!input || input->size() < 2) { error = std::string(what) + " needs at least two states."; return false; }
  for (const ACWStateSample* s : *input) {
    const std::array<double, 6> row{s->POSITION_X_M(), s->POSITION_Y_M(), s->POSITION_Z_M(),
                                    s->VELOCITY_X_MPS(), s->VELOCITY_Y_MPS(), s->VELOCITY_Z_MPS()};
    const double t = (s->JULIAN_DATE_TT() - epochJd) * kDay;
    for (double v : row) if (!std::isfinite(v)) { error = std::string(what) + " has a non-finite state."; return false; }
    if (!std::isfinite(t) || (!out.t.empty() && !(t > out.t.back()))) { error = std::string(what) + " epochs must strictly increase."; return false; }
    out.t.push_back(t);
    out.s.push_back(row);
    out.velocity = out.velocity || row[3] != 0 || row[4] != 0 || row[5] != 0;
  }
  out.velocity = out.velocity || withVelocity;
  return true;
}
bool covers(const Series& s, double t) { return t >= s.t.front() && t <= s.t.back(); }
// Cubic Hermite with velocities, linear (and its slope) without.
void sample(const Series& series, double t, Vec3& p, Vec3& v) {
  const auto& ts = series.t;
  t = std::min(std::max(t, ts.front()), ts.back());
  size_t i = size_t(std::upper_bound(ts.begin(), ts.end(), t) - ts.begin());
  i = i == 0 ? 0 : std::min(i - 1, ts.size() - 2);
  const double h = ts[i + 1] - ts[i], u = (t - ts[i]) / h;
  const auto& a = series.s[i];
  const auto& b = series.s[i + 1];
  double P[3], V[3];
  if (series.velocity) {
    const double u2 = u * u, u3 = u2 * u;
    const double h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    const double d00 = 6 * u2 - 6 * u, d10 = 3 * u2 - 4 * u + 1, d01 = -6 * u2 + 6 * u, d11 = 3 * u2 - 2 * u;
    for (int k = 0; k < 3; ++k) {
      P[k] = h00 * a[k] + h10 * h * a[k + 3] + h01 * b[k] + h11 * h * b[k + 3];
      V[k] = (d00 * a[k] + d10 * h * a[k + 3] + d01 * b[k] + d11 * h * b[k + 3]) / h;
    }
  } else {
    for (int k = 0; k < 3; ++k) { P[k] = a[k] + u * (b[k] - a[k]); V[k] = (b[k] - a[k]) / h; }
  }
  p = {P[0], P[1], P[2]};
  v = {V[0], V[1], V[2]};
}

// ── request model ──────────────────────────────────────────────────────────
struct Host {
  std::string id;
  bool ground = false;
  double lat = 0, lon = 0, alt = 0;   // rad, rad, m
  Vec3 ecef;                          // ground station, m
  Series states;                      // observer trajectory
};
struct Target {
  std::string id, objectId;
  uint32_t norad = 0;
  Series states;
  double rcs = 0, diameter = 0, albedo = 0, frequency = 0, eirp = 0;
};
struct Model {
  const MEMErrorModel* record;
  est::MeasurementKind kind;
  double bias = 0;
};
struct Sensor {
  const ACWSensor* record;
  std::string id;
  const Host* host = nullptr;
  std::vector<Model> models;
};
struct Window { double start, end; };

bool kindOf(memMeasurementType type, est::MeasurementKind& kind) {
  switch (type) {
    case memMeasurementType::RANGE: kind = est::MeasurementKind::RANGE; return true;
    case memMeasurementType::RANGE_RATE: kind = est::MeasurementKind::RANGE_RATE; return true;
    case memMeasurementType::DOPPLER: kind = est::MeasurementKind::DOPPLER; return true;
    case memMeasurementType::AZIMUTH_ELEVATION: kind = est::MeasurementKind::AZIMUTH_ELEVATION; return true;
    case memMeasurementType::RIGHT_ASCENSION_DECLINATION: kind = est::MeasurementKind::RIGHT_ASCENSION_DECLINATION; return true;
    case memMeasurementType::LASER_RANGE: kind = est::MeasurementKind::LASER_RANGE; return true;
    default: return false;
  }
}

// Geodetic latitude, longitude (rad) and height (m) of an Earth-fixed point;
// the geocentre (a test observer) is reported as 0, 0, 0.
void geodetic(const Vec3& p, double& lat, double& lon, double& height) {
  lat = lon = height = 0;
  if (est::norm(p) < 1.0) return;
  double xyz[3] = {p.x, p.y, p.z};
  if (eraGc2gd(1, xyz, &lon, &lat, &height) != 0) lat = lon = height = 0;
}

// ── geometry at one instant, GCRF metres ─────────────────────────────────
struct Geometry {
  Vec3 hostP, hostV, east, north, up;   // GCRF
  Vec3 hostF, upF;                      // Earth-fixed host position and zenith
  Vec3 targetP, targetV;                // GCRF
  Vec3 targetF;                         // Earth-fixed target position
  double range = 0;
};
Vec3 rotT(const fr::Mat3& m, const Vec3& v) { return v3(fr::apply(fr::transpose(m), f3(v))); }
bool geometryAt(double t, const Host& host, const Target& target, Geometry& g) {
  const double jd = epochJd + t / kDay;
  fr::Mat3 m, mPlus, mMinus;
  if (!itrfFromGcrf(jd, m) || !itrfFromGcrf(jd + 0.5 / kDay, mPlus) || !itrfFromGcrf(jd - 0.5 / kDay, mMinus)) {
    error = "An observation time is outside the leap-second table.";
    return false;
  }
  const fr::Mat3 mDot = fr::subtractScaled(mPlus, mMinus, 1.0);   // per second over 1 s
  // Earth-fixed r_f = M r_g, v_f = M v_g + Mdot r_g, so v_g = M^T (v_f - Mdot r_g).
  auto toGcrf = [&](const Vec3& pF, const Vec3& vF, Vec3& pG, Vec3& vG) {
    pG = rotT(m, pF);
    vG = rotT(m, est::subtract(vF, v3(fr::apply(mDot, f3(pG)))));
  };
  Vec3 hp, hv;
  if (host.ground) { hp = host.ecef; hv = {0, 0, 0}; }
  else sample(host.states, t, hp, hv);
  toGcrf(hp, hv, g.hostP, g.hostV);
  g.hostF = hp;
  double lat = host.lat, lon = host.lon;
  if (!host.ground) {
    double height;
    geodetic(hp, lat, lon, height);
  }
  const fr::Mat3 enu = fr::topocentricFromBodyFixed(lat, lon);
  const Vec3 eF{enu.m[0][0], enu.m[0][1], enu.m[0][2]}, nF{enu.m[1][0], enu.m[1][1], enu.m[1][2]}, uF{enu.m[2][0], enu.m[2][1], enu.m[2][2]};
  g.east = rotT(m, eF);
  g.north = rotT(m, nF);
  g.up = rotT(m, uF);
  g.upF = uF;
  Vec3 tp, tv;
  sample(target.states, t, tp, tv);
  g.targetF = tp;
  toGcrf(tp, tv, g.targetP, g.targetV);
  g.range = est::norm(est::subtract(g.targetP, g.hostP));
  return true;
}

// ── phenomenology ────────────────────────────────────────────────────────
Series sunStates;
bool haveSun = false;
Vec3 sunF(double t) { Vec3 p, v; sample(sunStates, t, p, v); return p; }
// Conical shadow of a spherical Earth: 0 sunlit, 1 penumbra, 2 umbra.
int shadow(const Vec3& target, const Vec3& sun) {
  const Vec3 s = est::subtract(sun, target);
  const double ds = est::norm(sun), dsat = est::norm(target);
  const Vec3 sunHat = est::scale(sun, 1.0 / ds);
  const double along = est::dot(target, sunHat);
  if (along > 0) return 0;                                  // on the Sun's side of Earth
  const double perp = est::norm(est::subtract(target, est::scale(sunHat, along)));
  const double umbraAngle = std::asin((kSunRadius - kEarthRadius) / ds);
  const double penumbraAngle = std::asin((kSunRadius + kEarthRadius) / ds);
  const double umbraRadius = kEarthRadius - (-along) * std::tan(umbraAngle);
  const double penumbraRadius = kEarthRadius + (-along) * std::tan(penumbraAngle);
  (void)s; (void)dsat;
  if (perp < umbraRadius) return 2;
  if (perp < penumbraRadius) return 1;
  return 0;
}
// Diffuse (Lambertian) sphere: F / F_sun = (2 / 3) p a^2 [(pi - phi) cos(phi) + sin(phi)] / (pi R^2)
// with a the radius, p the geometric albedo, phi the solar phase angle, and
// the Sun's flux at the target that at 1 au scaled by (1 au / d_sun)^2.
double diffuseSphereMagnitude(double diameter, double albedo, double phase, double range, double sunDistance) {
  const double a = 0.5 * diameter;
  const double f = (2.0 / 3.0) * albedo * a * a * ((kPi - phase) * std::cos(phase) + std::sin(phase)) / (kPi * range * range);
  return kSunMagnitudeG - 2.5 * std::log10(f * (kAu / sunDistance) * (kAu / sunDistance));
}

// ── outputs ──────────────────────────────────────────────────────────────
struct Output { std::string port, schema, ident, root; std::vector<uint8_t> bytes; };
// Globals stay trivially constructible: the reactor artifact does not run
// static constructors, so a builder or container needing one lives in
// simulate().
std::vector<Output> outputs;
uint32_t observationCount = 0;

struct Obs {
  const Sensor* sensor;
  const Target* target;   // null for a false alarm
  double t;
  std::string trackId;
  Geometry g;
  std::vector<std::pair<const Model*, est::MeasurementPrediction>> values;
  double snr = NAN, magnitude = NAN, phase = NAN, frequency = NAN;
  int shade = 0;
};

double deg(double rad) { return rad * kDeg; }
void emit(const Obs& o) {
  const ACWSensor* s = o.sensor->record;
  std::string when;
  isoUtc(epochJd + o.t / kDay, when);
  const std::string id = "SIM:" + o.sensor->id + ":" + std::to_string(observationCount);
  const bool uct = o.target == nullptr;
  double lon, lat, height;
  geodetic(o.g.hostF, lat, lon, height);
  double az = NAN, el = NAN, range = NAN, rate = NAN, doppler = NAN, ra = NAN, dec = NAN;
  double azSigma = NAN, elSigma = NAN, rangeSigma = NAN, rateSigma = NAN, dopplerSigma = NAN, raSigma = NAN, decSigma = NAN;
  for (const auto& [model, p] : o.values) {
    const double sigma = model->record->NOISE_SIGMA();
    switch (model->kind) {
      case est::MeasurementKind::AZIMUTH_ELEVATION: az = p.value[0]; el = p.value[1]; azSigma = elSigma = sigma; break;
      case est::MeasurementKind::RIGHT_ASCENSION_DECLINATION: ra = p.value[0]; dec = p.value[1]; raSigma = decSigma = sigma; break;
      case est::MeasurementKind::RANGE: case est::MeasurementKind::LASER_RANGE: range = p.value[0]; rangeSigma = sigma; break;
      case est::MeasurementKind::RANGE_RATE: rate = p.value[0]; rateSigma = sigma; break;
      case est::MeasurementKind::DOPPLER: doppler = p.value[0]; dopplerSigma = sigma; break;
      default: break;
    }
  }
  if (std::isfinite(ra)) { ra = std::fmod(ra, 2 * kPi); if (ra < 0) ra += 2 * kPi; }
  flatbuffers::FlatBufferBuilder fb(1024);
  const auto idOff = fb.CreateString(id);
  const auto timeOff = fb.CreateString(when);
  const auto sensorOff = fb.CreateString(o.sensor->id);
  const auto objectOff = uct || o.target->objectId.empty() ? flatbuffers::Offset<flatbuffers::String>() : fb.CreateString(o.target->objectId);
  const auto trackOff = fb.CreateString(o.trackId);
  const auto descriptorOff = fb.CreateString("SIMULATED");
  const acwSensorPhenomenology kind = s->PHENOMENOLOGY();
  if (kind == acwSensorPhenomenology::RADAR) {
    const auto tags = fb.CreateVector(std::vector<flatbuffers::Offset<flatbuffers::String>>{fb.CreateString("SIMULATED")});
    RDOBuilder b(fb);
    b.add_ID(idOff); b.add_OB_TIME(timeOff); b.add_ID_SENSOR(sensorOff);
    if (!uct && o.target->norad) b.add_SAT_NO(o.target->norad);
    if (!objectOff.IsNull()) b.add_ORIG_OBJECT_ID(objectOff);
    b.add_UCT(uct); b.add_OBS_TYPE(radarObsType::METRIC); b.add_TRACK_ID(trackOff);
    if (std::isfinite(az)) { b.add_AZIMUTH(deg(az)); b.add_ELEVATION(deg(el)); b.add_AZIMUTH_UNC(deg(azSigma)); b.add_ELEVATION_UNC(deg(elSigma)); }
    if (std::isfinite(range)) { b.add_RANGE(range / 1000.0); b.add_RANGE_UNC(rangeSigma / 1000.0); }
    if (std::isfinite(rate)) { b.add_RANGE_RATE(rate / 1000.0); b.add_RANGE_RATE_UNC(rateSigma / 1000.0); }
    // Two-way Doppler of the transmitted carrier, with that carrier.
    if (std::isfinite(doppler)) { b.add_DOPPLER(doppler); b.add_DOPPLER_UNC(dopplerSigma); b.add_DOPPLER_FREQUENCY(s->TRANSMIT_FREQUENCY_HZ()); }
    b.add_SENX(o.g.hostF.x / 1000.0); b.add_SENY(o.g.hostF.y / 1000.0); b.add_SENZ(o.g.hostF.z / 1000.0);
    if (std::isfinite(o.snr)) b.add_SNR(o.snr);
    b.add_DESCRIPTOR(descriptorOff); b.add_TAGS(tags);
    FinishRDOBuffer(fb, b.Finish());
    outputs.push_back({"radar", "RDO.fbs", "$RDO", "RDO", std::vector<uint8_t>(fb.GetBufferPointer(), fb.GetBufferPointer() + fb.GetSize())});
  } else if (kind == acwSensorPhenomenology::PASSIVE_RF) {
    const auto tags = fb.CreateVector(std::vector<flatbuffers::Offset<flatbuffers::String>>{fb.CreateString("SIMULATED")});
    RFOBuilder b(fb);
    b.add_ID(idOff); b.add_OB_TIME(timeOff); b.add_ID_SENSOR(sensorOff);
    if (!uct && o.target->norad) b.add_SAT_NO(o.target->norad);
    if (!objectOff.IsNull()) b.add_ORIG_OBJECT_ID(objectOff);
    b.add_UCT(uct); b.add_OBS_TYPE(rfObsType::EMISSION); b.add_TRACK_ID(trackOff);
    b.add_DETECTION_STATUS(rfDetectionStatus::DETECTED);
    if (std::isfinite(az)) { b.add_AZIMUTH(deg(az)); b.add_ELEVATION(deg(el)); b.add_AZIMUTH_UNC(deg(azSigma)); b.add_ELEVATION_UNC(deg(elSigma)); }
    if (std::isfinite(range)) { b.add_RANGE(range / 1000.0); b.add_RANGE_UNC(rangeSigma / 1000.0); }
    if (std::isfinite(rate)) { b.add_RANGE_RATE(rate / 1000.0); b.add_RANGE_RATE_UNC(rateSigma / 1000.0); }
    if (std::isfinite(o.frequency)) {
      b.add_FREQUENCY(o.frequency / 1e6); b.add_NOMINAL_FREQUENCY((uct ? o.frequency : o.target->frequency) / 1e6);
      // A DOPPLER model measures FREQUENCY: its sigma, in MHz as FREQUENCY.
      if (std::isfinite(dopplerSigma)) b.add_FREQUENCY_UNC(dopplerSigma / 1e6);
    }
    if (std::isfinite(o.snr)) b.add_SNR(o.snr);
    if (!uct) b.add_EIRP(o.target->eirp);
    b.add_SENLAT(deg(lat)); b.add_SENLON(deg(lon)); b.add_SENALT(height / 1000.0);
    b.add_DESCRIPTOR(descriptorOff); b.add_TAGS(tags);
    FinishRFOBuffer(fb, b.Finish());
    outputs.push_back({"rf", "RFO.fbs", "$RFO", "RFO", std::vector<uint8_t>(fb.GetBufferPointer(), fb.GetBufferPointer() + fb.GetSize())});
  } else {
    auto wrapper = CreateCelestialFrameWrapper(fb, CelestialFrame::GCRF);
    auto frame = CreateRFM(fb, RFMUnion::CelestialFrameWrapper, wrapper.Union());
    const auto setOff = fb.CreateString(o.trackId);
    EOOBuilder b(fb);
    b.add_ID(idOff); b.add_OB_TIME(timeOff); b.add_SENSOR_ID(sensorOff);
    if (!uct && o.target->norad) b.add_NORAD_CAT_ID(int32_t(o.target->norad));
    if (!objectOff.IsNull()) b.add_ORIG_OBJECT_ID(objectOff);
    b.add_UCT(uct);
    b.add_IMAGE_SET_ID(setOff);
    if (std::isfinite(ra)) { b.add_RA(float(deg(ra))); b.add_DECLINATION(float(deg(dec))); b.add_RA_UNC(float(deg(raSigma))); b.add_DECLINATION_UNC(float(deg(decSigma))); }
    if (std::isfinite(az)) { b.add_AZIMUTH(float(deg(az))); b.add_ELEVATION(float(deg(el))); b.add_AZIMUTH_UNC(float(deg(azSigma))); b.add_ELEVATION_UNC(float(deg(elSigma))); }
    if (std::isfinite(range)) { b.add_RANGE(float(range / 1000.0)); b.add_RANGE_UNC(float(rangeSigma / 1000.0)); }
    if (std::isfinite(o.magnitude)) b.add_MAG(float(o.magnitude));
    if (std::isfinite(o.phase)) b.add_SOLAR_PHASE_ANGLE(float(deg(o.phase)));
    b.add_UMBRA(o.shade == 2); b.add_PENUMBRA(o.shade == 1);
    b.add_SENLAT(float(deg(lat))); b.add_SENLON(float(deg(lon))); b.add_SENALT(float(height / 1000.0));
    b.add_SENX(float(o.g.hostF.x / 1000.0)); b.add_SENY(float(o.g.hostF.y / 1000.0)); b.add_SENZ(float(o.g.hostF.z / 1000.0));
    b.add_DATA_MODE(DataMode::SIMULATED);
    b.add_REFERENCE_FRAME(frame);
    b.add_DESCRIPTOR(descriptorOff);
    FinishEOOBuffer(fb, b.Finish());
    outputs.push_back({"optical", "EOO.fbs", "$EOO", "EOO", std::vector<uint8_t>(fb.GetBufferPointer(), fb.GetBufferPointer() + fb.GetSize())});
  }
  ++observationCount;
}

// Predict every model's measurement from the geometry, then add noise.
struct NoiseState { std::array<double, 2> x{0, 0}; double t = -1e300; };
bool measure(Obs& o, const Target& truthLike, Random& random, std::vector<NoiseState>& noise, bool addNoise) {
  (void)truthLike;
  o.values.clear();
  for (size_t k = 0; k < o.sensor->models.size(); ++k) {
    const Model& model = o.sensor->models[k];
    const MEMErrorModel* rec = model.record;
    est::Observation obs;
    obs.kind = model.kind;
    obs.epoch_seconds = o.t;
    obs.station_position_m = o.g.hostP;
    obs.station_velocity_mps = o.g.hostV;
    obs.station_east = o.g.east;
    obs.station_north = o.g.north;
    obs.station_up = o.g.up;
    obs.apply_light_time = rec->APPLY_LIGHT_TIME();
    obs.apply_sagnac = false;   // GCRF throughout: Earth's rotation during the light time is in the geometry
    const Vec3 los = est::subtract(o.g.targetP, o.g.hostP);
    obs.media.elevation_rad = std::asin(std::max(-1.0, std::min(1.0, est::dot(los, o.g.up) / est::norm(los))));
    double lon, lat, height;
    geodetic(o.g.hostF, lat, lon, height);
    obs.media.latitude_rad = lat;
    obs.media.height_m = height;
    // DOPPLER: a monostatic radar measures the echo's shift of its own
    // carrier, out and back; passive RF the one-way shift of the emission.
    const bool twoWay = model.kind == est::MeasurementKind::DOPPLER && o.sensor->record->PHENOMENOLOGY() == acwSensorPhenomenology::RADAR;
    if (twoWay) obs.media.frequency_hz = o.sensor->record->TRANSMIT_FREQUENCY_HZ();
    else if (model.kind == est::MeasurementKind::DOPPLER && o.target && o.target->frequency > 0) obs.media.frequency_hz = o.target->frequency;
    switch (rec->TROPOSPHERE_MODEL()) {
      case memTroposphereModel::HOPFIELD_SAASTAMOINEN: obs.troposphere = est::TroposphereModel::HOPFIELD_SAASTAMOINEN; break;
      case memTroposphereModel::MARINI: obs.troposphere = est::TroposphereModel::MARINI; break;
      default: obs.troposphere = est::TroposphereModel::NONE; break;
    }
    est::CartesianState state;
    state.epoch_seconds = o.t;
    state.value = {o.g.targetP.x, o.g.targetP.y, o.g.targetP.z, o.g.targetV.x, o.g.targetV.y, o.g.targetV.z};
    est::MeasurementPrediction p = est::predict_measurement(obs, state);
    if (p.count == 0) { error = "A measurement type cannot be predicted from this geometry."; return false; }
    // Two-way: twice the one-way shift, -2 f rdot / c to first order.
    if (twoWay) p.value[0] *= 2.0;
    if (addNoise) {
      const double sigma = rec->NOISE_SIGMA(), tau = rec->CORRELATION_TIME_SECONDS();
      NoiseState& n = noise[k];
      const double phi = tau > 0 ? std::exp(-std::max(0.0, o.t - n.t) / tau) : 0.0;
      for (int c = 0; c < p.count && c < 2; ++c) {
        n.x[c] = phi * n.x[c] + std::sqrt(1.0 - phi * phi) * sigma * random.normal();
        p.value[c] += model.bias + n.x[c];
      }
      n.t = o.t;
    }
    o.values.push_back({&model, p});
  }
  return true;
}

bool simulate(const ACW* root, std::vector<uint8_t>& resultBytes) {
  const ACWRequest* request = root->REQUEST();
  if (!request) { error = "The $ACW has no REQUEST."; return false; }
  if (request->OPERATION() != acwOperationCode::SIMULATE_OBSERVATIONS) { error = "REQUEST.OPERATION must be SIMULATE_OBSERVATIONS."; return false; }
  if (!request->TARGETS() || request->TARGETS()->size() == 0) { error = "SIMULATE_OBSERVATIONS needs TARGETS."; return false; }
  if (!request->SENSORS() || request->SENSORS()->size() == 0) { error = "SIMULATE_OBSERVATIONS needs SENSORS."; return false; }
  if (!loadEop(request)) return false;
  flatbuffers::FlatBufferBuilder resultBuilder(1 << 16);
  std::vector<flatbuffers::Offset<ACWTrack>> trackOffsets;

  // Epoch: the earliest target sample; all times are seconds from it.
  epochJd = std::numeric_limits<double>::infinity();
  for (const ACWTarget* t : *request->TARGETS())
    if (t->STATES() && t->STATES()->size()) epochJd = std::min(epochJd, t->STATES()->Get(0)->JULIAN_DATE_TT());
  if (!std::isfinite(epochJd)) { error = "Targets need STATES."; return false; }

  std::map<std::string, Target> targets;
  for (const ACWTarget* t : *request->TARGETS()) {
    Target target;
    target.id = t->TARGET_ID() ? t->TARGET_ID()->str() : "";
    if (target.id.empty() || targets.count(target.id)) { error = "Every target needs a unique TARGET_ID."; return false; }
    target.objectId = t->OBJECT_ID() ? t->OBJECT_ID()->str() : "";
    target.norad = t->NORAD_CAT_ID();
    if (!loadSeries(t->STATES(), target.states, true, ("Target " + target.id).c_str())) return false;
    if (const auto* sig = t->SIGNATURE()) {
      target.rcs = sig->RCS_M2(); target.diameter = sig->DIAMETER_M(); target.albedo = sig->GEOMETRIC_ALBEDO();
      target.frequency = sig->EMITTER_FREQUENCY_HZ(); target.eirp = sig->EMITTER_EIRP_DBW();
    }
    targets[target.id] = std::move(target);
  }
  std::map<std::string, Host> hosts;
  if (request->GROUND_STATIONS()) for (const ACWGroundStation* s : *request->GROUND_STATIONS()) {
    Host h;
    h.id = s->STATION_ID() ? s->STATION_ID()->str() : "";
    h.ground = true;
    h.lat = s->LATITUDE_RAD(); h.lon = s->LONGITUDE_RAD(); h.alt = s->ALTITUDE_M();
    double xyz[3];
    if (h.id.empty() || eraGd2gc(1, h.lon, h.lat, h.alt, xyz) != 0) { error = "Ground stations need STATION_ID and a valid geodetic position."; return false; }
    h.ecef = {xyz[0], xyz[1], xyz[2]};
    hosts[h.id] = h;
  }
  if (request->OBSERVERS()) for (const ACWObserverTrajectory* o : *request->OBSERVERS()) {
    Host h;
    h.id = o->OBSERVER_ID() ? o->OBSERVER_ID()->str() : "";
    if (h.id.empty() || !loadSeries(o->STATES(), h.states, false, ("Observer " + h.id).c_str())) { if (h.id.empty()) error = "Observers need OBSERVER_ID."; return false; }
    hosts[h.id] = std::move(h);
  }
  haveSun = request->SUN_STATES() && request->SUN_STATES()->size() >= 2;
  if (haveSun && !loadSeries(request->SUN_STATES(), sunStates, false, "SUN_STATES")) return false;

  std::vector<Sensor> sensors;
  for (const ACWSensor* s : *request->SENSORS()) {
    Sensor sensor;
    sensor.record = s;
    sensor.id = s->SENSOR_ID() ? s->SENSOR_ID()->str() : "";
    const std::string hostId = s->HOST_ID() ? s->HOST_ID()->str() : "";
    if (sensor.id.empty() || !hosts.count(hostId)) { error = "Sensor " + sensor.id + " needs a SENSOR_ID and a HOST_ID naming a ground station or observer."; return false; }
    sensor.host = &hosts[hostId];
    const acwSensorPhenomenology kind = s->PHENOMENOLOGY();
    if (kind == acwSensorPhenomenology::UNSPECIFIED) { error = "Sensor " + sensor.id + " needs a PHENOMENOLOGY."; return false; }
    if (!(s->OBSERVATION_INTERVAL_S() > 0)) { error = "Sensor " + sensor.id + " needs OBSERVATION_INTERVAL_S > 0."; return false; }
    if (!s->ERROR_MODELS() || s->ERROR_MODELS()->size() == 0) { error = "Sensor " + sensor.id + " needs ERROR_MODELS."; return false; }
    for (const MEMErrorModel* m : *s->ERROR_MODELS()) {
      Model model{m, est::MeasurementKind::RANGE, 0};
      if (!kindOf(m->MEASUREMENT_TYPE(), model.kind)) {
        error = "Sensor " + sensor.id + ": supported measurement types are RANGE, RANGE_RATE, DOPPLER, AZIMUTH_ELEVATION, RIGHT_ASCENSION_DECLINATION and LASER_RANGE.";
        return false;
      }
      if (!(m->NOISE_SIGMA() >= 0) || !std::isfinite(m->BIAS()) || !(m->BIAS_SIGMA() >= 0) || !(m->CORRELATION_TIME_SECONDS() >= 0)) {
        error = "Sensor " + sensor.id + " has an invalid error model."; return false;
      }
      Random biasRandom(hashText(request->RANDOM_SEED(), "bias|" + sensor.id + "|" + (m->MODEL_ID() ? m->MODEL_ID()->str() : "")));
      model.bias = m->BIAS() + m->BIAS_SIGMA() * biasRandom.normal();
      sensor.models.push_back(model);
    }
    if (kind == acwSensorPhenomenology::OPTICAL && sensor.host->ground && !haveSun) { error = "Ground optical sensors need SUN_STATES for darkness."; return false; }
    if (kind == acwSensorPhenomenology::OPTICAL && request->TARGETS()->size() && !haveSun) { error = "OPTICAL magnitudes need SUN_STATES."; return false; }
    if (kind == acwSensorPhenomenology::PASSIVE_RF && !(s->RECEIVER_BANDWIDTH_HZ() > 0)) { error = "Sensor " + sensor.id + " needs RECEIVER_BANDWIDTH_HZ > 0."; return false; }
    const bool dopplerModel = std::any_of(sensor.models.begin(), sensor.models.end(), [](const Model& m) { return m.kind == est::MeasurementKind::DOPPLER; });
    if (kind == acwSensorPhenomenology::RADAR && dopplerModel && !(s->TRANSMIT_FREQUENCY_HZ() > 0 && std::isfinite(s->TRANSMIT_FREQUENCY_HZ()))) {
      error = "Sensor " + sensor.id + ": a RADAR DOPPLER model needs TRANSMIT_FREQUENCY_HZ > 0, the carrier its two-way shift is measured against."; return false;
    }
    sensors.push_back(sensor);
  }

  // Access windows per sensor and target, in seconds from the epoch.
  std::map<std::pair<std::string, std::string>, std::vector<Window>> access;
  if (request->ACCESS()) for (const ACWSensorAccess* a : *request->ACCESS()) {
    const std::string sid = a->SENSOR_ID() ? a->SENSOR_ID()->str() : "", tid = a->TARGET_ID() ? a->TARGET_ID()->str() : "";
    if (!targets.count(tid)) { error = "ACCESS names an unknown target " + tid + "."; return false; }
    if (a->WINDOWS()) for (const ACWAccessWindow* w : *a->WINDOWS()) {
      // One JD double resolves ~40 us; window bounds are kept to 0.1 ms.
      const auto seconds = [](double jd) { return std::round((jd - epochJd) * kDay * 1e4) / 1e4; };
      Window win{seconds(w->START_JULIAN_DATE_TT()), seconds(w->END_JULIAN_DATE_TT())};
      if (!(win.end >= win.start)) { error = "An access window ends before it starts."; return false; }
      access[{sid, tid}].push_back(win);
    }
  }
  double spanStart = -std::numeric_limits<double>::infinity(), spanEnd = std::numeric_limits<double>::infinity();
  if (request->START_JULIAN_DATE_TT() > 0) spanStart = (request->START_JULIAN_DATE_TT() - epochJd) * kDay;
  if (request->END_JULIAN_DATE_TT() > 0) spanEnd = (request->END_JULIAN_DATE_TT() - epochJd) * kDay;

  for (const Sensor& sensor : sensors) {
    const ACWSensor* s = sensor.record;
    const acwSensorPhenomenology kind = s->PHENOMENOLOGY();
    struct Candidate { std::string target; Window w; };
    std::vector<Candidate> candidates;
    for (auto& [key, windows] : access) {
      if (key.first != sensor.id) continue;
      for (Window w : windows) {
        const Target& target = targets[key.second];
        w.start = std::max({w.start, spanStart, target.states.t.front()});
        w.end = std::min({w.end, spanEnd, target.states.t.back()});
        if (!sensor.host->ground) { w.start = std::max(w.start, sensor.host->states.t.front()); w.end = std::min(w.end, sensor.host->states.t.back()); }
        if (w.end >= w.start) candidates.push_back({key.second, w});
      }
    }
    // Earliest-deadline-first scheduling of tracks.
    const uint32_t slots = std::max<uint32_t>(1, s->MAX_SIMULTANEOUS_TRACKS());
    const double dt = s->OBSERVATION_INTERVAL_S(), duration = s->TRACK_DURATION_S(), revisit = std::max(0.0, s->REVISIT_INTERVAL_S());
    std::map<std::string, double> lastEnd;
    std::vector<std::pair<double, std::string>> active;   // end time, target
    std::map<std::string, uint32_t> trackCount;
    double t = std::numeric_limits<double>::infinity();
    for (const Candidate& c : candidates) t = std::min(t, c.w.start);
    size_t guard = 0;
    while (std::isfinite(t) && ++guard < 10000000) {
      active.erase(std::remove_if(active.begin(), active.end(), [&](const auto& a) { return a.first <= t; }), active.end());
      std::vector<const Candidate*> open;
      // A track starts strictly before its window closes (an instantaneous
      // window is one observation at its instant).
      for (const Candidate& c : candidates) {
        if (c.w.start > t || !(t < c.w.end || (t == c.w.end && c.w.start == c.w.end))) continue;
        if (std::any_of(active.begin(), active.end(), [&](const auto& a) { return a.second == c.target; })) continue;
        const auto last = lastEnd.find(c.target);
        if (last != lastEnd.end() && t < last->second + revisit) continue;
        open.push_back(&c);
      }
      std::stable_sort(open.begin(), open.end(), [](const Candidate* a, const Candidate* b) { return a->w.end != b->w.end ? a->w.end < b->w.end : a->target < b->target; });
      for (const Candidate* c : open) {
        if (active.size() >= slots) break;
        if (std::any_of(active.begin(), active.end(), [&](const auto& a) { return a.second == c->target; })) continue;
        const double end = duration > 0 ? std::min(c->w.end, t + duration) : c->w.end;
        const Target& target = targets[c->target];
        const std::string trackId = sensor.id + "/" + target.id + "/" + std::to_string(trackCount[c->target]++);
        Random random(hashText(request->RANDOM_SEED(), "track|" + trackId));
        std::vector<NoiseState> noise(sensor.models.size());
        uint32_t scheduled = 0, detected = 0;
        std::map<std::string, uint32_t> losses;
        const uint64_t count = uint64_t(std::floor((end - t) / dt + 1e-6)) + 1;
        for (uint64_t k = 0; k < count; ++k) {
          const double tk = t + double(k) * dt;
          if (observationCount >= kMaxObservations) { error = "More than 2,000,000 observations; shorten the span or raise the interval."; return false; }
          ++scheduled;
          Obs o{&sensor, &target, tk, trackId};
          if (!geometryAt(tk, *sensor.host, target, o.g)) return false;
          std::string loss;
          if (kind == acwSensorPhenomenology::RADAR && s->REFERENCE_RANGE_M() > 0) {
            if (!(target.rcs > 0)) loss = "RCS";
            else {
              o.snr = s->REFERENCE_SNR_DB() + 10 * std::log10(target.rcs / std::max(1e-12, s->REFERENCE_RCS_M2())) - 40 * std::log10(o.g.range / s->REFERENCE_RANGE_M());
              if (o.snr < s->DETECTION_THRESHOLD_DB()) loss = "SNR";
            }
          } else if (kind == acwSensorPhenomenology::OPTICAL) {
            const Vec3 sun = sunF(tk);
            if (sensor.host->ground && est::dot(est::scale(est::subtract(sun, o.g.hostF), 1.0 / est::norm(est::subtract(sun, o.g.hostF))), o.g.upF) > std::sin(s->MAX_HOST_SUN_ELEVATION_RAD())) loss = "DAYLIGHT";
            o.shade = shadow(o.g.targetF, sun);
            if (loss.empty() && o.shade == 2) loss = "ECLIPSED";
            const Vec3 toSun = est::subtract(sun, o.g.targetF), toHost = est::subtract(o.g.hostF, o.g.targetF);
            o.phase = std::acos(std::max(-1.0, std::min(1.0, est::dot(toSun, toHost) / (est::norm(toSun) * est::norm(toHost)))));
            if (target.diameter > 0 && target.albedo > 0) {
              o.magnitude = diffuseSphereMagnitude(target.diameter, target.albedo, o.phase, o.g.range, est::norm(toSun));
              if (loss.empty() && s->LIMITING_MAGNITUDE() != 0 && o.magnitude > s->LIMITING_MAGNITUDE()) loss = "MAGNITUDE";
            }
          } else if (kind == acwSensorPhenomenology::PASSIVE_RF) {
            if (!(target.frequency > 0)) loss = "NO_EMISSION";
            else {
              const double fspl = 20 * std::log10(4 * kPi * o.g.range * target.frequency / est::kSpeedOfLight);
              o.snr = target.eirp - fspl + s->RECEIVER_G_OVER_T_DB_PER_K() - kBoltzmannDb - 10 * std::log10(s->RECEIVER_BANDWIDTH_HZ());
              if (o.snr < s->DETECTION_THRESHOLD_DB()) loss = "SNR";
            }
          }
          // Measurements are drawn for every scheduled observation, so the
          // noise sequence does not depend on which ones are detected.
          if (!measure(o, target, random, noise, true)) return false;
          if (kind == acwSensorPhenomenology::PASSIVE_RF && target.frequency > 0) {
            est::Observation rr;
            rr.kind = est::MeasurementKind::RANGE_RATE;
            rr.station_position_m = o.g.hostP; rr.station_velocity_mps = o.g.hostV; rr.apply_sagnac = false;
            est::CartesianState st;
            st.value = {o.g.targetP.x, o.g.targetP.y, o.g.targetP.z, o.g.targetV.x, o.g.targetV.y, o.g.targetV.z};
            o.frequency = target.frequency * (1.0 - est::predict_measurement(rr, st).value[0] / est::kSpeedOfLight);
            // A DOPPLER error model measures that shift: the received
            // frequency is the emitted one plus the Doppler as measured,
            // with its bias and noise.
            for (const auto& [model, p] : o.values)
              if (model->kind == est::MeasurementKind::DOPPLER) o.frequency = target.frequency + p.value[0];
          }
          if (!loss.empty()) { ++losses[loss]; continue; }
          ++detected;
          emit(o);
        }
        // False alarms: Poisson in the track's duration, each a ghost near
        // the target's line of sight (within 5 deg, range x 0.8-1.2).
        const double hours = (end - t) / 3600.0;
        const uint32_t ghosts = random.poisson(s->FALSE_ALARM_RATE_PER_HOUR() * hours);
        for (uint32_t k = 0; k < ghosts; ++k) {
          Obs o{&sensor, nullptr, t + random.uniform() * (end - t), trackId + "/uct"};
          if (!geometryAt(o.t, *sensor.host, target, o.g)) return false;
          const Vec3 los = est::subtract(o.g.targetP, o.g.hostP);
          const double r = est::norm(los) * (0.8 + 0.4 * random.uniform());
          Vec3 dir = est::scale(los, 1.0 / est::norm(los));
          const double off = (5.0 / kDeg) * std::sqrt(random.uniform()), turn = 2 * kPi * random.uniform();
          const Vec3 a = est::scale(o.g.east, std::cos(turn)), b = est::scale(o.g.north, std::sin(turn));
          dir = est::add(est::scale(dir, std::cos(off)), est::scale(est::add(a, b), std::sin(off)));
          dir = est::scale(dir, 1.0 / est::norm(dir));
          o.g.targetP = est::add(o.g.hostP, est::scale(dir, r));
          o.g.targetV = o.g.hostV;
          o.g.range = r;
          Target ghost = target;
          ghost.frequency = target.frequency;
          if (!measure(o, ghost, random, noise, true)) return false;
          if (kind == acwSensorPhenomenology::OPTICAL && s->LIMITING_MAGNITUDE() != 0) o.magnitude = s->LIMITING_MAGNITUDE() - 1.5 * random.uniform();
          if (kind != acwSensorPhenomenology::OPTICAL && kind != acwSensorPhenomenology::LASER_RANGING) o.snr = s->DETECTION_THRESHOLD_DB() + 3 * random.uniform();
          if (kind == acwSensorPhenomenology::PASSIVE_RF) o.frequency = target.frequency > 0 ? target.frequency : s->RECEIVER_BANDWIDTH_HZ();
          emit(o);
        }
        std::string reason;
        for (const auto& [name, count] : losses) reason += (reason.empty() ? "" : ",") + name + ":" + std::to_string(count);
        trackOffsets.push_back(CreateACWTrack(resultBuilder, resultBuilder.CreateString(sensor.id), resultBuilder.CreateString(target.id),
          epochJd + t / kDay, epochJd + end / kDay, scheduled, detected, resultBuilder.CreateString(reason)));
        active.push_back({end, c->target});
        lastEnd[c->target] = end;
      }
      // Next decision time: a track ends, a window opens, or a revisit expires.
      double next = std::numeric_limits<double>::infinity();
      for (const auto& a : active) if (a.first > t) next = std::min(next, a.first);
      for (const Candidate& c : candidates) {
        if (c.w.start > t) next = std::min(next, c.w.start);
        const auto last = lastEnd.find(c.target);
        if (last != lastEnd.end()) {
          const double ready = last->second + revisit;
          if (ready > t && ready < c.w.end && ready >= c.w.start) next = std::min(next, ready);
        }
      }
      // A track that ends exactly at the next start leaves the slot free there.
      if (next <= t) next = t + std::max(dt, 1e-3);
      t = next;
    }
  }

  const auto traceOff = request->TRACE_ID() ? resultBuilder.CreateString(request->TRACE_ID()->str()) : flatbuffers::Offset<flatbuffers::String>();
  const auto tracks = resultBuilder.CreateVector(trackOffsets);
  ACWResultBuilder rb(resultBuilder);
  rb.add_STATUS(acwResultStatus::OK);
  if (!traceOff.IsNull()) rb.add_TRACE_ID(traceOff);
  rb.add_TRACKS(tracks);
  rb.add_OBSERVATION_COUNT(observationCount);
  const auto result = rb.Finish();
  ACWBuilder ab(resultBuilder);
  ab.add_RESULT(result);
  FinishACWBuffer(resultBuilder, ab.Finish());
  resultBytes.assign(resultBuilder.GetBufferPointer(), resultBuilder.GetBufferPointer() + resultBuilder.GetSize());
  return true;
}
}  // namespace

extern "C" int simulate_observations() {
  outputs.clear();
  observationCount = 0;
  sunStates = Series{};
  if (plugin_get_input_count() != 1) return fail("Exactly one $ACW request frame is required.");
  const auto* frame = plugin_get_input_frame(0);
  if (!frame || !frame->payload || frame->payload_length < 8 || std::strcmp(frame->port_id, "request") != 0)
    return fail("The request port must carry one $ACW FlatBuffer.");
  const uint8_t* bytes = frame->payload;
  size_t length = frame->payload_length;
  if (length >= 12 && std::memcmp(bytes + 8, "$ACW", 4) == 0 && std::memcmp(bytes + 4, "$ACW", 4) != 0) { bytes += 4; length -= 4; }
  flatbuffers::Verifier::Options options;
  options.max_depth = 128;
  options.max_tables = 50000000;
  flatbuffers::Verifier verifier(bytes, length, options);
  if (!VerifyACWBuffer(verifier)) return fail("The request is not a valid $ACW FlatBuffer.");
  std::vector<uint8_t> result;
  if (!simulate(GetACW(bytes), result)) return fail(error);
  for (const Output& o : outputs) {
    if (plugin_push_output_ex(o.port.c_str(), o.schema.c_str(), o.ident.c_str(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, o.root.c_str(), 0, 0,
          o.bytes.data(), o.bytes.size()) < 0) return 1;
  }
  return plugin_push_output_ex("result", "ACW.fbs", "$ACW", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "ACW", 0, 0,
    result.data(), result.size()) < 0 ? 1 : 0;
}
