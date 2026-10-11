// analysis/maneuver-detection: trajectories. One element set's (or one
// ephemeris version's) states from a $OEM data block, in Earth-centred
// inertial axes, with cubic Hermite sampling and orbit-averaged quantities.
namespace {

// ── frames ─────────────────────────────────────────────────────────────────
// Detection quantities are differences of two states at one instant in one
// frame, so any Earth-centred inertial or quasi-inertial axes give the same
// delta-V. Earth-fixed states (what the propagator ABI's providers write) are
// turned to TEME by GMST (IAU 1982, UT1 = UTC), with velocity v + w x r: the
// inverse of the providers' own TEME -> Earth-fixed rotation, and in any case
// one rotation shared by both states of every comparison.
enum class FrameKind { Inertial, EarthFixed, Refused };

std::string upper(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return char(std::toupper(c)); });
  return s;
}

FrameKind classifyName(const std::string& raw, std::string& name) {
  const std::string n = upper(raw);
  static const char* inertial[] = {"GCRF", "ICRF", "J2000", "EME2000", "TEME", "TEMEOFDATE", "TOD", "MOD", "CIRS", "TOE", "B1950", "J2000A"};
  for (const char* x : inertial) if (n == x) { name = n == "TEME" ? "TEMEOFDATE" : n; return FrameKind::Inertial; }
  static const char* fixed[] = {"ITRF", "ITRS", "ECEF", "EFG", "WGS84", "IGS", "GTOD", "FIXED_EARTH", "EARTH_FIXED", "PEF"};
  for (const char* x : fixed) if (n.rfind(x, 0) == 0) { name = n; return FrameKind::EarthFixed; }
  return FrameKind::Refused;
}

FrameKind classifyFrame(const RFM* frame, std::string& name) {
  if (!frame) return FrameKind::Refused;
  if (const auto* celestial = frame->REFERENCE_FRAME_as_CelestialFrameWrapper()) {
    switch (celestial->frame()) {
      case CelestialFrame::GCRF: case CelestialFrame::ICRF: case CelestialFrame::J2000: case CelestialFrame::J2000A:
      case CelestialFrame::EME2000: case CelestialFrame::TEMEOFDATE: case CelestialFrame::CIRS:
      case CelestialFrame::MOD_EARTH: case CelestialFrame::TOD_EARTH: case CelestialFrame::TOE_EARTH:
      case CelestialFrame::B1950:
        name = EnumNameCelestialFrame(celestial->frame());
        return FrameKind::Inertial;
      case CelestialFrame::GTOD: case CelestialFrame::ITRF2000: case CelestialFrame::ITRF93: case CelestialFrame::ITRF97:
      case CelestialFrame::EFG: case CelestialFrame::FIXED_EARTH: case CelestialFrame::WGS84:
        name = EnumNameCelestialFrame(celestial->frame());
        return FrameKind::EarthFixed;
      default: return FrameKind::Refused;
    }
  }
  if (const auto* system = frame->REFERENCE_FRAME_as_RFMCoordinateSystemWrapper()) {
    const auto* cs = system->COORDINATE_SYSTEM();
    if (!cs) return FrameKind::Refused;
    switch (cs->AXIS_TYPE()) {
      case rfmAxisType::MEAN_EQUATOR_EQUINOX_J2000: case rfmAxisType::ICRF:
      case rfmAxisType::TRUE_EQUATOR_MEAN_EQUINOX_OF_DATE: case rfmAxisType::MEAN_OF_DATE_EQUATOR:
      case rfmAxisType::TRUE_OF_DATE_EQUATOR:
        name = std::string("AXIS:") + EnumNamerfmAxisType(cs->AXIS_TYPE());
        return FrameKind::Inertial;
      case rfmAxisType::BODY_FIXED:
        if (cs->AXIS_REFERENCE_BODY_ID() != 0 && cs->AXIS_REFERENCE_BODY_ID() != 399) return FrameKind::Refused;
        name = "AXIS:BODY_FIXED(EARTH)";
        return FrameKind::EarthFixed;
      default: return FrameKind::Refused;
    }
  }
  if (frame->NAME() && frame->NAME()->size() > 0) return classifyName(frame->NAME()->str(), name);
  return FrameKind::Refused;
}

// GMST (IAU 1982) in radians at UTC seconds since 1970, taking UT1 = UTC.
double gmst82(double t) {
  const double tut1 = (t / 86400.0 + 2440587.5 - 2451545.0) / 36525.0;
  double seconds = -6.2e-6 * tut1 * tut1 * tut1 + 0.093104 * tut1 * tut1 + (876600.0 * 3600.0 + 8640184.812866) * tut1 + 67310.54841;
  double theta = std::fmod(seconds * (kPi / 180.0) / 240.0, kTwoPi);
  if (theta < 0) theta += kTwoPi;
  return theta;
}
State fixedToTeme(double t, const State& s) {
  const double theta = gmst82(t), c = std::cos(theta), sn = std::sin(theta);
  const double vx = s[3] - kEarthRate * s[1], vy = s[4] + kEarthRate * s[0];
  return {c * s[0] - sn * s[1], sn * s[0] + c * s[1], s[2], c * vx - sn * vy, sn * vx + c * vy, s[5]};
}

// ── one trajectory, km and km/s, inertial ────────────────────────────────────
struct Block {
  std::string key, objectId, objectName, comment, frame;
  uint32_t norad = 0;
  double epoch = kNaN;     // the element set's epoch when known (query answers)
  double issued = kNaN;    // the version's issue time (compare_ephemerides)
  std::vector<double> t;
  std::vector<State> s;
  double mid() const { return 0.5 * (t.front() + t.back()); }
  // The time a set's level is taken at: its epoch, else the middle of its span.
  double ref() const { return std::isfinite(epoch) ? epoch : mid(); }
  double start() const { return t.front(); }
  double stop() const { return t.back(); }
};

// Object key: NORAD number when given (an OBJECT_ID is not a stable key in GP
// history), else OBJECT_ID, else OBJECT_NAME.
std::string objectKey(uint32_t norad, const std::string& id, const std::string& name) {
  if (norad > 0) return "NORAD:" + std::to_string(norad);
  if (!id.empty()) return id;
  return name;
}

// A provider that refuses one element set answers with an empty block whose
// COMMENT begins "REFUSED".
bool isRefusal(const ephemerisDataBlock* block) {
  const bool empty = (!block->EPHEMERIS_DATA() || block->EPHEMERIS_DATA()->size() == 0) &&
                     (!block->EPHEMERIS_DATA_LINES() || block->EPHEMERIS_DATA_LINES()->size() == 0);
  return empty && block->COMMENT() && block->COMMENT()->str().rfind("REFUSED", 0) == 0;
}

bool loadBlock(const ephemerisDataBlock* block, Block& out) {
  NEED(block->TIME_SYSTEM() == timingStandard::UTC, "Ephemeris blocks must state TIME_SYSTEM UTC.");
  const FrameKind kind = classifyFrame(block->REFERENCE_FRAME(), out.frame);
  NEED(kind != FrameKind::Refused,
    "Ephemeris block frame must be Earth-centred: inertial (GCRF, ICRF, J2000, EME2000, TEME, CIRS, MOD, TOD, TOE, B1950) or Earth-fixed (ITRF, ECEF, EFG, WGS84, GTOD).");
  if (block->CENTER_NAME()) NEED(upper(block->CENTER_NAME()->str()) == "EARTH", "Ephemeris blocks must be centred on EARTH.");
  const auto* object = block->OBJECT();
  NEED(object && (object->NORAD_CAT_ID() > 0 || (object->OBJECT_ID() && object->OBJECT_ID()->size() > 0) ||
                  (object->OBJECT_NAME() && object->OBJECT_NAME()->size() > 0)),
    "Every block must name its object (OBJECT.NORAD_CAT_ID, OBJECT_ID or OBJECT_NAME).");
  out.norad = object->NORAD_CAT_ID();
  out.objectId = object->OBJECT_ID() ? object->OBJECT_ID()->str() : "";
  out.objectName = object->OBJECT_NAME() ? object->OBJECT_NAME()->str() : "";
  out.key = objectKey(out.norad, out.objectId, out.objectName);
  out.comment = block->COMMENT() ? block->COMMENT()->str() : "";
  std::vector<std::pair<double, State>> rows;
  if (block->STEP_SIZE() > 0) {
    const unsigned width = block->STATE_VECTOR_SIZE();
    NEED(width == 6 || width == 9, "STATE_VECTOR_SIZE must be 6 or 9.");
    NEED(block->EPHEMERIS_DATA() && block->EPHEMERIS_DATA()->size() % width == 0, "EPHEMERIS_DATA length is not a whole number of states.");
    NEED(block->EPHEMERIS_DATA()->size() / width <= kMaxStatesPerBlock, "An ephemeris block has too many states.");
    double start;
    NEED(parseIso(block->START_TIME(), start), "Compact ephemeris needs START_TIME.");
    const auto* data = block->EPHEMERIS_DATA();
    for (size_t i = 0; i * width < data->size(); ++i) {
      State state;
      for (int k = 0; k < 6; ++k) state[k] = data->Get(i * width + k);
      rows.push_back({start + double(i) * block->STEP_SIZE(), state});
    }
  } else {
    NEED(block->EPHEMERIS_DATA_LINES(), "Ephemeris block has neither compact data nor lines.");
    NEED(block->EPHEMERIS_DATA_LINES()->size() <= kMaxStatesPerBlock, "An ephemeris block has too many states.");
    for (const auto* line : *block->EPHEMERIS_DATA_LINES()) {
      double epoch;
      NEED(parseIso(line->EPOCH(), epoch), "Ephemeris line EPOCH is not a valid UTC timestamp.");
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
    const State state = kind == FrameKind::EarthFixed ? fixedToTeme(row.first, row.second) : row.second;
    NEED(norm(Vec3{state[0], state[1], state[2]}) > 1000.0, "An ephemeris state is inside the Earth; positions must be in km.");
    out.t.push_back(row.first);
    out.s.push_back(state);
  }
  NEED(out.t.size() >= 2, "An ephemeris block needs at least two states.");
  if (kind == FrameKind::EarthFixed) out.frame = "TEMEOFDATE";
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

// ── orbit averages ───────────────────────────────────────────────────────────
// Mean over one revolution of the osculating semi-major axis and orbit normal.
// The revolution runs between consecutive ascending crossings of a reference
// line fixed at the reference time (the ascending node; for orbits within 1
// degree of the equator, the +x axis), so every set's window starts at the
// same phase and what one revolution leaves of the short-period terms is the
// same constant for every set. 64 midpoint samples.
struct OrbitMean {
  bool ok = false;
  double a = 0;      // km
  Vec3 h{};          // mean unit normal
  double from = 0, to = 0;
  double speed = 0;  // km/s, mean
};

// The in-plane coordinate across the reference line: positive ahead of it.
struct Phase {
  Vec3 line{}, ahead{};
  double at(const Block& b, double t) const { Vec3 p, v; sample(b, t, p, v); return dot(p, ahead); }
  double along(const Block& b, double t) const { Vec3 p, v; sample(b, t, p, v); return dot(p, line); }
};

Phase phaseOf(const Block& b, double tc) {
  Vec3 p, v;
  sample(b, tc, p, v);
  const Vec3 h = unit(cross(p, v));
  Vec3 nodeLine = cross(Vec3{0, 0, 1}, h);
  Phase ph;
  ph.line = norm(nodeLine) > std::sin(1.0 / kDeg) ? unit(nodeLine) : Vec3{1, 0, 0};
  ph.ahead = unit(cross(h, ph.line));
  return ph;
}

// Ascending crossings of the reference line within [lo, hi], sorted.
std::vector<double> crossings(const Block& b, const Phase& ph, double lo, double hi, double period) {
  std::vector<double> out;
  lo = std::max(lo, b.start());
  hi = std::min(hi, b.stop());
  if (!(hi > lo)) return out;
  const double step = period / 64.0;
  const size_t n = size_t(std::ceil((hi - lo) / step)) + 1;
  double t0 = lo, f0 = ph.at(b, t0);
  for (size_t k = 1; k < n; ++k) {
    const double t1 = std::min(hi, lo + double(k) * step), f1 = ph.at(b, t1);
    if (f0 < 0 && f1 >= 0 && ph.along(b, 0.5 * (t0 + t1)) > 0) {
      double a = t0, c = t1, fa = f0;
      for (int it = 0; it < 60 && c - a > 1e-4; ++it) {
        const double m = 0.5 * (a + c), fm = ph.at(b, m);
        if ((fm < 0) == (fa < 0)) { a = m; fa = fm; } else c = m;
      }
      out.push_back(0.5 * (a + c));
    }
    t0 = t1; f0 = f1;
  }
  return out;
}

OrbitMean meanOver(const Block& b, double from, double to) {
  OrbitMean m;
  const int n = 64;
  const double h = (to - from) / n;
  Vec3 hs{0, 0, 0};
  double as = 0, vs = 0;
  for (int k = 0; k < n; ++k) {
    Vec3 p, v;
    sample(b, from + (k + 0.5) * h, p, v);
    as += smaOf(p, v);
    vs += norm(v);
    hs = add(hs, unit(cross(p, v)));
  }
  m.a = as / n;
  m.speed = vs / n;
  m.h = unit(hs);
  m.from = from;
  m.to = to;
  m.ok = std::isfinite(m.a) && m.a > 0;
  return m;
}

// The revolution nearest to tc (centred on it when the block allows), phase
// fixed at tc. Fails when the block holds no whole revolution near tc.
OrbitMean orbitMeanNear(const Block& b, double tc) {
  Vec3 p, v;
  sample(b, tc, p, v);
  const double a = smaOf(p, v);
  OrbitMean none;
  if (!(a > 0)) return none;
  const double period = kTwoPi * std::sqrt(a * a * a / kMu);
  const Phase ph = phaseOf(b, tc);
  const std::vector<double> c = crossings(b, ph, tc - 1.6 * period, tc + 1.6 * period, period);
  if (c.size() < 2) return none;
  // The pair of consecutive crossings whose midpoint is nearest tc.
  size_t best = 0;
  double bestD = std::numeric_limits<double>::infinity();
  for (size_t k = 0; k + 1 < c.size(); ++k) {
    const double len = c[k + 1] - c[k];
    if (len < 0.5 * period || len > 1.5 * period) continue;
    const double d = std::fabs(0.5 * (c[k] + c[k + 1]) - tc);
    if (d < bestD) { bestD = d; best = k; }
  }
  if (!std::isfinite(bestD)) return none;
  return meanOver(b, c[best], c[best + 1]);
}

// The first whole revolution starting at or after `from` (phase fixed there),
// or the last one ending at or before `to` when `last` is set.
OrbitMean orbitMeanFrom(const Block& b, double at, bool last) {
  Vec3 p, v;
  sample(b, at, p, v);
  const double a = smaOf(p, v);
  OrbitMean none;
  if (!(a > 0)) return none;
  const double period = kTwoPi * std::sqrt(a * a * a / kMu);
  const Phase ph = phaseOf(b, at);
  const std::vector<double> c = last ? crossings(b, ph, at - 2.6 * period, at, period)
                                     : crossings(b, ph, at, at + 2.6 * period, period);
  if (c.size() < 2) return none;
  const size_t k = last ? c.size() - 2 : 0;
  const double len = c[k + 1] - c[k];
  if (len < 0.5 * period || len > 1.5 * period) return none;
  return meanOver(b, c[k], c[k + 1]);
}

// The same revolution [from, to] of another trajectory (both must cover it).
OrbitMean orbitMeanSame(const Block& b, const OrbitMean& w) {
  if (!w.ok || b.start() > w.from + 1e-3 || b.stop() < w.to - 1e-3) return OrbitMean{};
  return meanOver(b, w.from, w.to);
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
  e.period = kTwoPi * std::sqrt(e.sma * e.sma * e.sma / kMu) / 60.0;
  e.apogee = e.sma * (1.0 + e.ecc) - kRe;
  e.perigee = e.sma * (1.0 - e.ecc) - kRe;
  return e;
}
}  // namespace
