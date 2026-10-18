// analysis/rpo-history: inspection geometry of a chaser about a target.
//
// inspect  the chaser's, the target's and the Sun's trajectories ($OEM, one
//          Earth-centered frame, UTC, km and km/s) -> inspection ($OCM,
//          extended trajectory type RPO_INSPECTION): on a fixed UTC grid, per
//          sample, what an inspection of the target from the chaser sees and
//          where the chaser sits in the target's side-looking radar geometry.
//
// Columns (USER_DEFINED_PARAMETERS COLUMNS):
//   PHASE_ANGLE_DEG          the angle at the target between the Sun and the chaser
//   TARGET_SUNLIT            the target's Earth-shadow function: 1 sunlit, 0 umbra
//   CHASER_SUNLIT            the chaser's
//   LINE_OF_SIGHT            1 when the chaser-target segment clears the Earth
//   TARGET_LIT_FROM_CHASER   TARGET_SUNLIT * LINE_OF_SIGHT
//   SUN_FROM_LINE_OF_SIGHT_DEG  the angle at the chaser between the target and the Sun
//   RANGE_KM                 the chaser-target distance
//   CHASER_OFF_NADIR_DEG     the angle at the target between its nadir and the chaser
//   CHASER_CLOCK_DEG         the chaser's clock angle about the target's nadir, from
//                            its Earth-relative along-track direction toward its
//                            right (90 right of the track, 270 left)
//   IN_SAR_RIGHT, IN_SAR_LEFT  1 when the chaser is inside the target's radar
//                            field of regard on that side: off-nadir between the
//                            look angles of the incidence band, within half the
//                            azimuth beamwidth of the broadside plane
//
// The shadow is the conical model of a spherical Earth (6378.137 km) and a
// spherical Sun (695700 km), the analysis/access TARGET_LIGHTING constants.
// The radar's derived geometry is recorded with the inputs it came from:
// wavelength c / f; -3 dB beamwidths 0.886 lambda / D of a uniformly
// illuminated aperture of length D; look angle from incidence on a spherical
// Earth, sin(look) = (R_E / r) sin(incidence), at each sample's r. The
// along-track direction is the Earth-relative velocity v - w x r (w the
// Earth's rotation about the frame's z), perpendicular to r.
//
// Options are the node configuration's `inspect` table (keys inspect.*):
//   chaser, target               labels for the records (required)
//   start, stop                  the grid, ISO 8601 UTC (default: the span the three trajectories share)
//   step_seconds                 1..3600 (60)
//   sar_frequency_ghz            carrier frequency (required for the radar columns)
//   sar_antenna_length_m         aperture length along track
//   sar_antenna_height_m         aperture height across track
//   sar_incidence_min_deg, sar_incidence_max_deg   the incidence band
//   sar_source                   citation text recorded with the parameters
//   creation_date                the record's CREATION_DATE (default: stop)
namespace {

constexpr double kEarthRadiusShadow = 6378.137;  // km, WGS 84 equatorial (analysis/access TARGET_LIGHTING)
constexpr double kSunRadius = 695700.0;          // km, IAU 2015 nominal solar radius
constexpr double kLightSpeed = 299792458.0;      // m/s
const char* const kInspectionColumns =
  "PHASE_ANGLE_DEG,TARGET_SUNLIT,CHASER_SUNLIT,LINE_OF_SIGHT,TARGET_LIT_FROM_CHASER,SUN_FROM_LINE_OF_SIGHT_DEG,RANGE_KM,"
  "CHASER_OFF_NADIR_DEG,CHASER_CLOCK_DEG,IN_SAR_RIGHT,IN_SAR_LEFT";
constexpr uint8_t kInspectionWidth = 11;

struct InspectOptions {
  std::string chaser, target, creation, sarSource;
  double start = kNaN, stop = kNaN, step = 60;
  double frequencyGhz = kNaN, lengthM = kNaN, heightM = kNaN, incidenceMin = kNaN, incidenceMax = kNaN;
  bool sar() const { return std::isfinite(frequencyGhz); }
};

bool readInspectOptions(InspectOptions& o) {
  const sdm_piv::Config config = sdm_piv::get_config();
  if (!config.ok()) return failWith("plugin.getConfig failed: " + config.error_message());
  if (!config.has("inspect")) return failWith("Option table inspect is required (inspect.chaser, inspect.target).");
  const sdm_piv::ConfigTable t = config.table("inspect");
  if (!t) return failWith("Option inspect must be one table (keys inspect.*).");
  static const char* known[] = {"chaser", "target", "start", "stop", "step_seconds", "sar_frequency_ghz", "sar_antenna_length_m",
                                "sar_antenna_height_m", "sar_incidence_min_deg", "sar_incidence_max_deg", "sar_source", "creation_date"};
  for (const auto* e : *t.entries()) {
    const std::string key = textOf(e->KEY());
    bool ok = false;
    for (const char* k : known) ok = ok || key == k;
    if (!ok) return failWith("Unknown option inspect." + key + ".");
  }
  o.chaser = std::string(t.string("chaser"));
  o.target = std::string(t.string("target"));
  if (o.chaser.empty() || o.target.empty()) return failWith("inspect.chaser and inspect.target are required.");
  if (t.has("start") && !parseIso(std::string(t.string("start")).c_str(), o.start)) return failWith("inspect.start must be ISO 8601 UTC.");
  if (t.has("stop") && !parseIso(std::string(t.string("stop")).c_str(), o.stop)) return failWith("inspect.stop must be ISO 8601 UTC.");
  if (t.has("step_seconds")) {
    o.step = t.number("step_seconds", -1);
    if (!(o.step >= 1 && o.step <= 3600)) return failWith("inspect.step_seconds must be from 1 to 3600.");
  }
  if (t.has("sar_frequency_ghz")) {
    o.frequencyGhz = t.number("sar_frequency_ghz", -1);
    o.lengthM = t.number("sar_antenna_length_m", -1);
    o.heightM = t.number("sar_antenna_height_m", -1);
    o.incidenceMin = t.number("sar_incidence_min_deg", -1);
    o.incidenceMax = t.number("sar_incidence_max_deg", -1);
    if (!(o.frequencyGhz > 0 && o.frequencyGhz < 1000)) return failWith("inspect.sar_frequency_ghz must be from 0 to 1000 GHz.");
    if (!(o.lengthM > 0 && o.lengthM < 100 && o.heightM > 0 && o.heightM < 100))
      return failWith("inspect.sar_antenna_length_m and inspect.sar_antenna_height_m must be from 0 to 100 m.");
    if (!(o.incidenceMin >= 0 && o.incidenceMax > o.incidenceMin && o.incidenceMax < 90))
      return failWith("inspect.sar_incidence_min_deg and inspect.sar_incidence_max_deg must make a band inside 0 to 90 deg.");
    o.sarSource = std::string(t.string("sar_source"));
  }
  if (t.has("creation_date")) {
    double c;
    if (!parseIso(std::string(t.string("creation_date")).c_str(), c)) return failWith("inspect.creation_date must be ISO 8601 UTC.");
    o.creation = isoMs(c);
  }
  return true;
}

// One object's trajectories (blocks), in one frame; the state at t from the block that starts latest at or before t
// and still covers t (arcs never blend).
struct Arcs {
  std::string frame, label;
  uint32_t norad = 0;
  std::string objectId;
  std::vector<Trajectory> blocks;
  bool at(double t, State& out) const {
    const Trajectory* best = nullptr;
    for (const auto& b : blocks)
      if (b.t.front() <= t + 1e-3 && b.t.back() >= t - 1e-3 && (!best || b.t.front() > best->t.front())) best = &b;
    return best && sampleAt(*best, t, out);
  }
  double first() const { double v = INFINITY; for (const auto& b : blocks) v = std::min(v, b.t.front()); return v; }
  double last() const { double v = -INFINITY; for (const auto& b : blocks) v = std::max(v, b.t.back()); return v; }
};

bool loadArcs(const std::vector<const OEM*>& records, const char* port, Arcs& out) {
  for (const OEM* oem : records) {
    if (!oem->EPHEMERIS_DATA_BLOCK()) continue;
    for (const auto* block : *oem->EPHEMERIS_DATA_BLOCK()) {
      if (isRefusal(block)) continue;
      Trajectory traj;
      uint32_t norad = 0;
      std::string objectId;
      if (!loadBlock(block, traj, norad, objectId)) return failWith(std::string("The ") + port + " port: " + error);
      if (out.frame.empty()) out.frame = traj.frame;
      if (traj.frame != out.frame) return failWith(std::string("The ") + port + " port mixes frames " + out.frame + " and " + traj.frame + ".");
      if (!out.norad) out.norad = norad;
      if (out.objectId.empty()) out.objectId = objectId;
      out.blocks.push_back(std::move(traj));
    }
  }
  if (out.blocks.empty()) return failWith(std::string("The ") + port + " port holds no trajectory ($OEM).");
  if (out.blocks.size() > kMaxBlocks) return failWith(std::string("The ") + port + " port holds too many blocks.");
  return true;
}

double clampUnit(double x) { return std::max(-1.0, std::min(1.0, x)); }
double angleDeg(const Vec3& a, const Vec3& b) { return std::acos(clampUnit(dot(a, b) / (norm(a) * norm(b)))) * kDeg; }

// Montenbruck & Gill (2000), 3.4.2: the fraction of the Sun's disk seen from r (Earth-centered, km), the Sun at s.
double shadowFunction(const Vec3& r, const Vec3& s) {
  const Vec3 toSun = sub(s, r);
  const double dSun = norm(toSun), dEarth = norm(r);
  const double a = std::asin(std::min(1.0, kSunRadius / dSun));
  const double b = std::asin(std::min(1.0, kEarthRadiusShadow / dEarth));
  const double c = std::acos(clampUnit(-dot(r, toSun) / (dEarth * dSun)));
  if (c >= a + b) return 1.0;
  if (c <= b - a) return 0.0;               // umbra
  if (c <= a - b) return 1.0 - (b * b) / (a * a);  // antumbra: the Earth inside the Sun's disk
  const double x = (c * c + a * a - b * b) / (2.0 * c);
  const double y = std::sqrt(std::max(0.0, a * a - x * x));
  const double area = a * a * std::acos(clampUnit(x / a)) + b * b * std::acos(clampUnit((c - x) / b)) - c * y;
  return std::max(0.0, std::min(1.0, 1.0 - area / (kPi * a * a)));
}

// The segment p -> q clears the sphere of radius R about the origin.
bool clears(const Vec3& p, const Vec3& q, double radius) {
  const Vec3 d = sub(q, p);
  const double dd = dot(d, d);
  const double tau = dd > 0 ? std::max(0.0, std::min(1.0, -dot(p, d) / dd)) : 0.0;
  const Vec3 closest = {p[0] + tau * d[0], p[1] + tau * d[1], p[2] + tau * d[2]};
  return norm(closest) > radius;
}

struct Radar {
  double wavelengthM = kNaN, azimuthBeamDeg = kNaN, elevationBeamDeg = kNaN;
  double sinIncMin = kNaN, sinIncMax = kNaN;
};

Radar radarOf(const InspectOptions& o) {
  Radar r;
  if (!o.sar()) return r;
  r.wavelengthM = kLightSpeed / (o.frequencyGhz * 1e9);
  r.azimuthBeamDeg = 0.886 * r.wavelengthM / o.lengthM * kDeg;
  r.elevationBeamDeg = 0.886 * r.wavelengthM / o.heightM * kDeg;
  r.sinIncMin = std::sin(o.incidenceMin / kDeg);
  r.sinIncMax = std::sin(o.incidenceMax / kDeg);
  return r;
}

// The look angle (off nadir, deg) that meets a spherical Earth at incidence with sin(incidence) = sinInc, seen from r km.
double lookAngleDeg(double sinInc, double r) { return std::asin(clampUnit(kEarthRadiusShadow / r * sinInc)) * kDeg; }

struct Row {
  double t = 0;
  std::array<double, kInspectionWidth> v{};
};

std::vector<uint8_t> inspectionRecord(const InspectOptions& o, const Arcs& chaser, const Arcs& target, const std::vector<Row>& rows,
                                      size_t index, const std::vector<std::pair<std::string, std::string>>& params, double stop) {
  flatbuffers::FlatBufferBuilder fb(2048 + rows.size() * kInspectionWidth * 8 + 4096);
  const auto vers = fb.CreateString("3.0");
  const auto creation = fb.CreateString(o.creation.empty() ? isoMs(stop) : o.creation);
  const auto originator = fb.CreateString("SDN");
  const auto message = fb.CreateString("RPO-INSPECTION:" + o.chaser + ":" + o.target + ":" + std::to_string(index));
  HeaderBuilder hb(fb);
  hb.add_CCSDS_OCM_VERS(vers);
  hb.add_CREATION_DATE(creation);
  hb.add_ORIGINATOR(originator);
  hb.add_MESSAGE_ID(message);
  const auto head = hb.Finish();
  std::vector<flatbuffers::Offset<flatbuffers::String>> comments{
    fb.CreateString("Inspection geometry of chaser " + o.chaser + " about target " + o.target + " (" + chaser.frame + " trajectories).")};
  const auto commentVec = fb.CreateVector(comments);
  const auto name = fb.CreateString(o.chaser);
  const auto intl = fb.CreateString(chaser.objectId);
  const auto desig = fb.CreateString(chaser.norad ? std::to_string(chaser.norad) : o.chaser);
  const auto ts = fb.CreateString("UTC");
  const auto start = fb.CreateString(isoMs(rows.front().t));
  const auto end = fb.CreateString(isoMs(rows.back().t));
  MetadataBuilder mb(fb);
  mb.add_COMMENT(commentVec);
  mb.add_OBJECT_NAME(name);
  mb.add_INTERNATIONAL_DESIGNATOR(intl);
  mb.add_OBJECT_DESIGNATOR(desig);
  mb.add_TIME_SYSTEM(ts);
  mb.add_START_TIME(start);
  mb.add_STOP_TIME(end);
  mb.add_TIME_SPAN((rows.back().t - rows.front().t) / 86400.0);
  const auto meta = mb.Finish();
  const auto description = fb.CreateString("RPO_INSPECTION");
  std::vector<double> data;
  data.reserve(rows.size() * kInspectionWidth);
  for (const Row& r : rows) data.insert(data.end(), r.v.begin(), r.v.end());
  const auto dataVec = fb.CreateVector(data);
  const auto center = fb.CreateString(!target.objectId.empty() ? target.objectId : o.target);
  std::vector<Udp> udps;
  for (const auto& [k, v] : params) udps.push_back(udp(fb, k, v));
  const auto paramVec = fb.CreateVector(udps);
  OCMBuilder b(fb);
  b.add_HEADER(head);
  b.add_METADATA(meta);
  b.add_TRAJ_TYPE_DESCRIPTION(description);
  b.add_STATE_STEP_SIZE(o.step);
  b.add_STATE_VECTOR_SIZE(kInspectionWidth);
  b.add_STATE_DATA(dataVec);
  b.add_USER_DEFINED_PARAMETERS(paramVec);
  b.add_CENTER_NAME(center);
  return finishOcm(fb, b.Finish());
}

int inspectRpo() {
  InspectOptions o;
  if (!readInspectOptions(o)) return fail(error);
  std::vector<const OEM*> chaserIn, targetIn, sunIn;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* frame = plugin_get_input_frame(i);
    const std::string port = frame && frame->port_id ? frame->port_id : "";
    if (port.empty()) return fail("An input frame has no port.");
    if (!frame->payload || frame->payload_length == 0) continue;
    std::vector<const OEM*>* into = port == "chaser" ? &chaserIn : port == "target" ? &targetIn : port == "sun" ? &sunIn : nullptr;
    if (!into) return fail("Unknown input port.");
    if (!forEachRecord<OEM>(frame->payload, frame->payload_length, OEMIdentifier(), VerifyOEMBuffer, VerifySizePrefixedOEMBuffer, GetOEM,
                            GetSizePrefixedOEM, *into, port.c_str()))
      return fail(error);
  }
  Arcs chaser, target, sun;
  if (!loadArcs(chaserIn, "chaser", chaser) || !loadArcs(targetIn, "target", target) || !loadArcs(sunIn, "sun", sun)) return fail(error);
  if (chaser.frame != target.frame || sun.frame != chaser.frame)
    return fail("The chaser, target and sun trajectories must share one Earth-centered frame.");
  const double first = std::max({chaser.first(), target.first(), sun.first()});
  const double last = std::min({chaser.last(), target.last(), sun.last()});
  const double start = std::isfinite(o.start) ? o.start : std::ceil(first / o.step) * o.step;
  const double stop = std::isfinite(o.stop) ? o.stop : last;
  if (!(stop > start)) return fail("The trajectories share no span inside inspect.start .. inspect.stop.");
  if ((stop - start) / o.step > double(kMaxSamples)) return fail("The grid holds too many samples; widen inspect.step_seconds.");
  const Radar radar = radarOf(o);
  const double azimuthHalf = radar.azimuthBeamDeg / 2.0;

  std::vector<std::vector<Row>> runs(1);
  double lookMin = INFINITY, lookMax = -INFINITY, rangeTarget = 0;
  size_t samples = 0, rightSamples = 0, leftSamples = 0;
  for (double t = start; t <= stop + 1e-6; t += o.step) {
    State c, g, s;
    if (!chaser.at(t, c) || !target.at(t, g) || !sun.at(t, s)) {
      if (!runs.back().empty()) runs.emplace_back();
      continue;
    }
    const Vec3 rc = posOf(c), rt = posOf(g), rs = posOf(s);
    const Vec3 toChaser = sub(rc, rt), toSun = sub(rs, rt);
    Row row;
    row.t = t;
    const double targetLit = shadowFunction(rt, rs), chaserLit = shadowFunction(rc, rs);
    const bool los = clears(rc, rt, kEarthRadiusShadow);
    const double range = norm(toChaser);
    const Vec3 nadir = scale(unit(rt), -1.0);
    const Vec3 omegaCrossR = {-kEarthRate * rt[1], kEarthRate * rt[0], 0.0};
    const Vec3 vRel = sub(velOf(g), omegaCrossR);
    const Vec3 along = unit(sub(vRel, scale(nadir, dot(vRel, nadir))));
    const Vec3 right = cross(nadir, along);
    const double offNadir = angleDeg(nadir, toChaser);
    double clock = std::atan2(dot(toChaser, right), dot(toChaser, along)) * kDeg;
    if (clock < 0) clock += 360.0;
    double inRight = kNaN, inLeft = kNaN;
    if (o.sar()) {
      const double r = norm(rt);
      const double lo = lookAngleDeg(radar.sinIncMin, r), hi = lookAngleDeg(radar.sinIncMax, r);
      lookMin = std::min(lookMin, lo);
      lookMax = std::max(lookMax, hi);
      rangeTarget += r;
      const bool band = offNadir >= lo && offNadir <= hi;
      inRight = band && std::fabs(clock - 90.0) <= azimuthHalf ? 1.0 : 0.0;
      inLeft = band && std::fabs(clock - 270.0) <= azimuthHalf ? 1.0 : 0.0;
      rightSamples += inRight > 0 ? 1 : 0;
      leftSamples += inLeft > 0 ? 1 : 0;
    }
    row.v = {angleDeg(toSun, toChaser), targetLit, chaserLit, los ? 1.0 : 0.0, targetLit * (los ? 1.0 : 0.0),
             angleDeg(scale(toChaser, -1.0), sub(rs, rc)), range, offNadir, clock, inRight, inLeft};
    runs.back().push_back(row);
    ++samples;
  }
  if (runs.back().empty()) runs.pop_back();
  if (runs.empty()) return fail("No grid sample has all three trajectories.");

  std::vector<std::pair<std::string, std::string>> params = {
    {"COLUMNS", kInspectionColumns},
    {"UNITS", "deg, km; TARGET_SUNLIT and CHASER_SUNLIT the fraction of the Sun's disk visible (0 umbra, 1 sunlit); LINE_OF_SIGHT, IN_SAR_* 0 or 1"},
    {"FRAME", chaser.frame},
    {"SHADOW", "conical: spherical Earth 6378.137 km, spherical Sun 695700 km (Montenbruck & Gill 2000, 3.4.2)"},
    {"LINE_OF_SIGHT_MODEL", "the chaser-target segment clears a sphere of 6378.137 km"},
    {"TARGET_FRAME", "nadir = -r/|r|; along-track = Earth-relative velocity v - w x r (w = 7.292115146706979e-5 rad/s about the frame's z) "
                     "perpendicular to r; right = nadir x along-track; clock from along-track toward right"},
    {"SAMPLES", std::to_string(samples)},
  };
  if (o.sar()) {
    params.push_back({"SAR_SOURCE", o.sarSource});
    params.push_back({"SAR_FREQUENCY_GHZ", fmt(o.frequencyGhz, "%.6g")});
    params.push_back({"SAR_ANTENNA_M", fmt(o.lengthM, "%.6g") + " x " + fmt(o.heightM, "%.6g")});
    params.push_back({"SAR_INCIDENCE_DEG", fmt(o.incidenceMin, "%.6g") + " to " + fmt(o.incidenceMax, "%.6g")});
    params.push_back({"SAR_WAVELENGTH_M", fmt(radar.wavelengthM, "%.15g")});
    params.push_back({"SAR_AZIMUTH_BEAMWIDTH_DEG", fmt(radar.azimuthBeamDeg, "%.15g")});
    params.push_back({"SAR_ELEVATION_BEAMWIDTH_DEG", fmt(radar.elevationBeamDeg, "%.15g")});
    params.push_back({"SAR_LOOK_ANGLE_DEG", fmt(lookMin, "%.9g") + " to " + fmt(lookMax, "%.9g")});
    params.push_back({"SAR_LOOK_ANGLE_AT_MEAN_RADIUS_DEG", fmt(lookAngleDeg(radar.sinIncMin, rangeTarget / double(samples)), "%.9g") + " to " +
                                                            fmt(lookAngleDeg(radar.sinIncMax, rangeTarget / double(samples)), "%.9g")});
    params.push_back({"SAR_TARGET_MEAN_RADIUS_KM", fmt(rangeTarget / double(samples), "%.9g")});
    params.push_back({"SAR_BEAM_MODEL", "beamwidth 0.886 lambda / D (-3 dB, uniform aperture); look from incidence on a spherical Earth "
                                        "of 6378.137 km, sin(look) = (R_E / r) sin(incidence), at each sample's r"});
    params.push_back({"IN_SAR_SAMPLES", "right " + std::to_string(rightSamples) + ", left " + std::to_string(leftSamples)});
  }
  std::vector<std::vector<uint8_t>> records;
  for (size_t i = 0; i < runs.size(); ++i) records.push_back(inspectionRecord(o, chaser, target, runs[i], i, params, stop));
  return pushRecords("inspection", "OCM.fbs", "$OCM", "OCM", records) ? 0 : 1;
}
}  // namespace

extern "C" int inspect() { return inspectRpo(); }
