// analysis/rpo-history: element sets, the propagator query port, and the
// per-set trajectories the answers carry.
//
// The module holds no propagator (pluggable-propagation law). Given the two
// objects' element sets ($OMM), it asks for each set's trajectory on
// `propagation_requests` (one $PRW WINDOW_REQUEST, the contract of
// analysis/maneuver-detection, answered by analysis/epoch-state's
// answer_propagation_requests or any provider the host plugs in), and is
// called again with the answers on `propagation` ($OEM, one block per query,
// in query order). The queries are a pure function of the sets and options,
// so the replay is stateless and every runtime gives the same bytes.
//
// Every query starts on the sample grid (whole multiples of step_seconds
// since 1970-01-01 UTC), so the chaser's and the target's samples fall at the
// same instants and no series is interpolated across an element update.
namespace {

// ── frames ─────────────────────────────────────────────────────────────────
// Relative geometry is a difference of two states in one frame: both objects
// must arrive in the same Earth-centered inertial axes. Earth-fixed states are
// turned to TEME by GMST (IAU 1982, UT1 = UTC) with v + w x r, one rotation
// shared by both objects' states at every instant.
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
  if (frame->NAME() && frame->NAME()->size() > 0) return classifyName(frame->NAME()->str(), name);
  return FrameKind::Refused;
}

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

// ── one element set's trajectory, km and km/s, inertial ─────────────────────
struct Trajectory {
  std::string frame;
  std::vector<double> t;
  std::vector<State> s;
  bool empty() const { return t.size() < 2; }
};

bool isRefusal(const ephemerisDataBlock* block) {
  const bool empty = (!block->EPHEMERIS_DATA() || block->EPHEMERIS_DATA()->size() == 0) &&
                     (!block->EPHEMERIS_DATA_LINES() || block->EPHEMERIS_DATA_LINES()->size() == 0);
  return empty && block->COMMENT() && block->COMMENT()->str().rfind("REFUSED", 0) == 0;
}

bool loadBlock(const ephemerisDataBlock* block, Trajectory& out, uint32_t& norad, std::string& objectId) {
  NEED(block->TIME_SYSTEM() == timingStandard::UTC, "Ephemeris blocks must state TIME_SYSTEM UTC.");
  const FrameKind kind = classifyFrame(block->REFERENCE_FRAME(), out.frame);
  NEED(kind != FrameKind::Refused,
    "Ephemeris block frame must be Earth-centered: inertial (GCRF, ICRF, J2000, EME2000, TEME, CIRS, MOD, TOD, TOE, B1950) or Earth-fixed (ITRF, ECEF, EFG, WGS84, GTOD).");
  if (block->CENTER_NAME()) NEED(upper(block->CENTER_NAME()->str()) == "EARTH", "Ephemeris blocks must be centered on EARTH.");
  const auto* object = block->OBJECT();
  norad = object ? object->NORAD_CAT_ID() : 0;
  objectId = object && object->OBJECT_ID() ? object->OBJECT_ID()->str() : "";
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
      for (int k = 0; k < 6; ++k) state[k] = data->Get(flatbuffers::uoffset_t(i * width + k));
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
    if (!out.t.empty() && row.first == out.t.back()) continue;
    const State state = kind == FrameKind::EarthFixed ? fixedToTeme(row.first, row.second) : row.second;
    NEED(norm(posOf(state)) > 1000.0, "An ephemeris state is inside the Earth; positions must be in km.");
    out.t.push_back(row.first);
    out.s.push_back(state);
  }
  NEED(out.t.size() >= 2, "An ephemeris block needs at least two states.");
  if (kind == FrameKind::EarthFixed) out.frame = "TEMEOFDATE";
  return true;
}

// Cubic Hermite state at t; false outside the trajectory's span (1 ms slack).
bool sampleAt(const Trajectory& b, double t, State& out) {
  const auto& ts = b.t;
  if (b.empty() || t < ts.front() - 1e-3 || t > ts.back() + 1e-3) return false;
  t = std::min(std::max(t, ts.front()), ts.back());
  size_t i = size_t(std::upper_bound(ts.begin(), ts.end(), t) - ts.begin());
  i = i == 0 ? 0 : std::min(i - 1, ts.size() - 2);
  const double h = ts[i + 1] - ts[i], u = (t - ts[i]) / h;
  if (u <= 1e-12) { out = b.s[i]; return true; }
  if (u >= 1.0 - 1e-12) { out = b.s[i + 1]; return true; }
  const double u2 = u * u, u3 = u2 * u;
  const double h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  const double d00 = 6 * u2 - 6 * u, d10 = 3 * u2 - 4 * u + 1, d01 = -6 * u2 + 6 * u, d11 = 3 * u2 - 2 * u;
  const auto& a = b.s[i];
  const auto& c = b.s[i + 1];
  for (int k = 0; k < 3; ++k) {
    out[k] = h00 * a[k] + h10 * h * a[k + 3] + h01 * c[k] + h11 * h * c[k + 3];
    out[k + 3] = (d00 * a[k] + d10 * h * a[k + 3] + d01 * c[k] + d11 * h * c[k + 3]) / h;
  }
  return true;
}

// ── element sets ───────────────────────────────────────────────────────────
struct ElementSet {
  size_t record = 0;       // index of the $OMM record over all element_sets frames
  double epoch = 0;        // UTC s
  double altitude = kNaN;  // mean altitude, km (WGS-72 mean motion, as the error model's regimes)
  double eccentricity = kNaN;
  std::string comment;     // "EPOCH <iso> <the set's COMMENT>"
  Source source;
  Trajectory traj;         // the answer, when queried and answered
  std::string refused;     // the provider's refusal, when it refused
};

struct Object {
  std::string role, key, objectId, objectName, request;
  uint32_t norad = 0;
  // Per-axis (R, T, N) factors on the error model's standard deviations for
  // this object, fitted on the calibration window (1 when not fitted).
  std::array<double, 3> scale{1.0, 1.0, 1.0};
  size_t scaleSamples = 0;
  std::vector<ElementSet> sets;  // by epoch, one per epoch
  std::vector<std::pair<double, double>> brackets;  // maneuver brackets, UTC s
  std::vector<std::string> bracketIds;
  // Index of the set in force at t: the latest epoch <= t; -1 before the first.
  int active(double t) const {
    int lo = 0, hi = int(sets.size());
    while (lo < hi) {
      const int mid = (lo + hi) / 2;
      if (sets[size_t(mid)].epoch <= t) lo = mid + 1; else hi = mid;
    }
    return lo - 1;
  }
  // A bracket open at t: the trajectory there is a set propagated across a
  // maneuver, so the sample is not supported.
  bool inBracket(double t) const {
    for (const auto& b : brackets) if (t > b.first && t < b.second) return true;
    return false;
  }
  bool bracketOverlaps(double from, double to) const {
    for (const auto& b : brackets) if (b.first < to && b.second > from) return true;
    return false;
  }
  // A set issued within `settle` seconds after a bracket closed: its orbit fit
  // still spans observations from before the burn, so it is a settling set,
  // not one the error model describes.
  bool settling(double epoch, double settle) const {
    for (const auto& b : brackets) if (epoch >= b.second && epoch < b.second + settle) return true;
    return false;
  }
};

bool matches(const std::string& request, uint32_t norad, const std::string& objectId, const std::string& objectName) {
  if (request.empty()) return false;
  bool digits = true;
  for (char c : request) digits = digits && c >= '0' && c <= '9';
  std::string r = request;
  if (r.rfind("NORAD:", 0) == 0) { r = r.substr(6); digits = !r.empty(); for (char c : r) digits = digits && c >= '0' && c <= '9'; }
  if (digits) return norad != 0 && std::to_string(norad) == r;
  return r == objectId || r == objectName;
}

// The two objects' element sets, by epoch; a republished set (same epoch)
// keeps the later record. Sets of other objects are ignored and counted.
bool loadElementSets(const std::vector<const OMM*>& records, Object& chaser, Object& target, size_t& others) {
  others = 0;
  for (size_t i = 0; i < records.size(); ++i) {
    const OMM* omm = records[i];
    const uint32_t norad = omm->NORAD_CAT_ID();
    const std::string id = textOf(omm->OBJECT_ID()), name = textOf(omm->OBJECT_NAME());
    Object* owner = matches(chaser.request, norad, id, name) ? &chaser : matches(target.request, norad, id, name) ? &target : nullptr;
    if (!owner) { ++others; continue; }
    ElementSet s;
    s.record = i;
    if (!parseIso(omm->EPOCH(), s.epoch)) return failWith("Element set " + std::to_string(i) + " has no valid EPOCH (ISO 8601 UTC).");
    const double n = omm->MEAN_MOTION() * kTwoPi / 86400.0;  // rev/day -> rad/s
    if (n > 0) s.altitude = std::cbrt(kMuWgs72 / (n * n)) - kReWgs72;
    s.eccentricity = omm->ECCENTRICITY();
    s.source = sourceOf(omm->PROVENANCE());
    s.comment = "EPOCH " + isoMs(s.epoch) + (omm->COMMENT() && omm->COMMENT()->size() ? " " + omm->COMMENT()->str() : "");
    if (owner->norad == 0) owner->norad = norad;
    if (owner->objectId.empty()) owner->objectId = id;
    if (owner->objectName.empty()) owner->objectName = name;
    owner->sets.push_back(std::move(s));
  }
  for (Object* o : {&chaser, &target}) {
    if (o->sets.empty()) return failWith("No element sets for the " + o->role + " (" + o->request + ").");
    o->key = o->norad ? "NORAD:" + std::to_string(o->norad) : !o->objectId.empty() ? o->objectId : o->objectName;
    std::stable_sort(o->sets.begin(), o->sets.end(), [](const ElementSet& a, const ElementSet& b) { return a.epoch < b.epoch; });
    std::vector<ElementSet> unique;
    for (auto& s : o->sets) {
      if (!unique.empty() && unique.back().epoch == s.epoch) unique.back() = std::move(s);
      else unique.push_back(std::move(s));
    }
    o->sets = std::move(unique);
  }
  if (chaser.key == target.key) return failWith("The chaser and the target name the same object.");
  return true;
}

// ── queries ────────────────────────────────────────────────────────────────
struct Window {
  double start = 0, stop = 0, step = 60, horizon = 86400;  // s
  double calibration = 14 * 86400.0;  // s: the trailing window of each object's own set differences (0 = none)
  double settle = 86400;               // s after a maneuver bracket during which new sets are settling
  bool hindcast = true;
  double gridCeil(double t) const { return std::ceil(t / step - 1e-9) * step; }
};

struct Query {
  Object* object = nullptr;
  size_t setIndex = 0;  // within object->sets
  double start = 0, stop = 0;
};

// One query per set that can matter, chaser then target, by epoch. Set k is
// in force over [epoch_k, epoch_k+1); the newest set at `stop` carries the
// coast projection to stop + horizon; with the hindcast, a set that is in
// force at some t0 >= start predicts to t0 + horizon (capped at stop). With
// the calibration, every set from (start - calibration - horizon) predicts
// to epoch + horizon (capped at stop), the pairs its trailing factors use.
std::vector<Query> queriesFor(Object& chaser, Object& target, const Window& w) {
  std::vector<Query> out;
  for (Object* o : {&chaser, &target}) {
    const int newest = o->active(w.stop);
    for (size_t k = 0; k < o->sets.size(); ++k) {
      const double epoch = o->sets[k].epoch;
      if (epoch > w.stop) break;
      const bool last = int(k) == newest;
      const double next = last ? w.stop : o->sets[k + 1].epoch;
      double lo = INFINITY, hi = -INFINITY;
      if (last || next > w.start) {
        lo = std::max(epoch, w.start);
        hi = last ? w.stop + w.horizon : next;
        if (!last && w.hindcast && w.horizon > 0) hi = std::max(hi, std::min(next + w.horizon, w.stop));
      }
      if (w.calibration > 0 && w.horizon > 0 && epoch >= w.start - w.calibration - w.horizon) {
        lo = std::min(lo, epoch);
        hi = std::max(hi, std::min(epoch + w.horizon, w.stop));
      }
      if (!std::isfinite(lo)) continue;
      if (!(hi > lo)) hi = lo;
      Query q;
      q.object = o;
      q.setIndex = k;
      q.start = w.gridCeil(lo);
      q.stop = std::max(q.start + w.step, w.gridCeil(hi));
      out.push_back(q);
    }
  }
  return out;
}

flatbuffers::Offset<TIMInstant> instantOf(flatbuffers::FlatBufferBuilder& fb, double t) {
  const auto text = fb.CreateString(isoMs(t));
  TIMInstantBuilder b(fb);
  b.add_TIME_SYSTEM(timingStandard::UTC);
  b.add_EPOCH_FORMAT(timEpochRepresentation::ISO8601);
  b.add_ISO8601(text);
  return b.Finish();
}

const char* const kWindowInstructions =
  "One $OEM data block per query, in SEQUENCE order: the source's trajectory from START to STOP, sampled at least every STEP_SECONDS, "
  "UTC, km and km/s, Earth-centered inertial or Earth-fixed axes, both objects in the same axes. A set the propagator refuses: an empty "
  "block whose COMMENT begins REFUSED.";

std::vector<uint8_t> encodeWindowRequest(const std::vector<Query>& queries, const std::string& portId, double step) {
  flatbuffers::FlatBufferBuilder fb(1024 + queries.size() * 256);
  std::vector<flatbuffers::Offset<PRWWindowQuery>> list;
  for (size_t i = 0; i < queries.size(); ++i) {
    const Query& q = queries[i];
    const ElementSet& s = q.object->sets[q.setIndex];
    const auto key = fb.CreateString(q.object->key);
    const auto objectId = q.object->objectId.empty() ? flatbuffers::Offset<flatbuffers::String>() : fb.CreateString(q.object->objectId);
    const auto epoch = instantOf(fb, s.epoch);
    const auto start = instantOf(fb, q.start);
    const auto stop = instantOf(fb, q.stop);
    PRWWindowQueryBuilder b(fb);
    b.add_SEQUENCE(uint32_t(i));
    b.add_SET_INDEX(uint32_t(s.record));
    b.add_OBJECT_KEY(key);
    b.add_NORAD_CAT_ID(q.object->norad);
    if (!objectId.IsNull()) b.add_OBJECT_ID(objectId);
    b.add_SOURCE_EPOCH(epoch);
    b.add_START(start);
    b.add_STOP(stop);
    b.add_STEP_SECONDS(step);
    list.push_back(b.Finish());
  }
  const auto queriesVec = fb.CreateVector(list);
  const auto port = portId.empty() ? flatbuffers::Offset<flatbuffers::String>() : fb.CreateString(portId);
  const auto instructions = fb.CreateString(kWindowInstructions);
  PRWWindowRequestBuilder b(fb);
  b.add_QUERIES(queriesVec);
  if (!port.IsNull()) b.add_PROPAGATOR_PORT_ID(port);
  b.add_NEIGHBOUR_SETS(0);  // us-spelling-ok: the SDS $PRW field name
  b.add_INSTRUCTIONS(instructions);
  const auto arm = b.Finish();
  PRWBuilder m(fb);
  m.add_WINDOW_REQUEST(arm);
  FinishPRWBuffer(fb, m.Finish());
  return std::vector<uint8_t>(fb.GetBufferPointer(), fb.GetBufferPointer() + fb.GetSize());
}

// The answer blocks against their queries: the same object, the query's span
// covered, one frame for both objects.
bool takeAnswers(const std::vector<Query>& queries, const std::vector<const ephemerisDataBlock*>& answers, std::string& frame,
                 size_t& refusedCount) {
  if (answers.size() != queries.size())
    return failWith("The propagation port holds " + std::to_string(answers.size()) + " answer blocks for " +
                    std::to_string(queries.size()) + " queries; answer every query, in order.");
  if (answers.size() > kMaxBlocks) return failWith("Too many ephemeris blocks in one request.");
  refusedCount = 0;
  for (size_t k = 0; k < queries.size(); ++k) {
    const Query& q = queries[k];
    ElementSet& s = q.object->sets[q.setIndex];
    const std::string where = "Answer " + std::to_string(k) + " (" + q.object->key + ", set " + isoMs(s.epoch) + ")";
    if (isRefusal(answers[k])) {
      s.refused = answers[k]->COMMENT()->str();
      ++refusedCount;
      continue;
    }
    uint32_t norad = 0;
    std::string objectId;
    Trajectory traj;
    if (!loadBlock(answers[k], traj, norad, objectId)) return failWith(where + ": " + error);
    if (q.object->norad > 0 && norad > 0 && norad != q.object->norad)
      return failWith(where + " is for NORAD " + std::to_string(norad) + "; answers must follow the queries' order.");
    if (traj.t.front() > q.start + 1e-3 || traj.t.back() < q.stop - 1e-3)
      return failWith(where + " does not cover its query's span " + isoMs(q.start) + " to " + isoMs(q.stop) + ".");
    if (frame.empty()) frame = traj.frame;
    if (traj.frame != frame)
      return failWith(where + " is in " + traj.frame + " and an earlier answer in " + frame + "; both objects must share one frame.");
    s.traj = std::move(traj);
  }
  return true;
}
}  // namespace
