// propagator/sgp4-xp: the US Space Force SGP4 and SGP4-XP as an SDN propagator module, and SDN's own fits of XP
// element sets to ephemerides.
//
//   propagate   $OMM element sets (MEAN_ELEMENT_THEORY SGP4XP; SGP4 sets too) to $OEM trajectories, on the grid an
//               optional $OEM template names, in TEME or GCRF axes.
//   fit         an $OEM ephemeris to an $OMM SGP4XP element set (BTERM in BSTAR, AGOM in MEAN_MOTION_DDOT) with its
//               fit statistics, and an $OBD.
//   ingest_omm  element sets into the module, for the propagator ABI below.
//   plugin_*    the OrbPro propagator ABI (docs/propagator-abi.md in space-data-module-sdk), Earth-fixed metres:
//               the same exports as propagator/keplerian-reference, so any ABI consumer (OrbPro's pluggable
//               propagation, the maneuver detector's propagator query port) routes to this module.
//
// Every number a trajectory holds is the Space Force library's (ussf.hpp). This file moves records in and out,
// rotates axes with foundation/frames, and drives the fit. Errors are returned and named, never thrown.
#include <functional>
#include <map>
#include <memory>

namespace sgp4xp {

constexpr const char* kModuleName = "propagator/sgp4-xp";
constexpr const char* kProduct =
    "SDN propagator/sgp4-xp 0.1.0 over the US Space Force Sgp4Prop 9.1.1.0 (XP build)";
// States one request may write or read, over all its blocks.
constexpr size_t kMaxStates = 500000;

int refuse(const char* code, const std::string& message, int status = 400) {
  plugin_set_error(code, message.c_str());
  return status;
}

// ---------------------------------------------------------------------------------------------------------------
// Frames of the invocation.
// ---------------------------------------------------------------------------------------------------------------
std::vector<const plugin_input_frame_t*> framesOn(const char* port) {
  std::vector<const plugin_input_frame_t*> frames;
  const uint32_t count = plugin_get_input_count();
  for (uint32_t i = 0; i < count; ++i) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (f != nullptr && f->port_id != nullptr && f->payload != nullptr && f->payload_length > 0 &&
        std::strcmp(f->port_id, port) == 0)
      frames.push_back(f);
  }
  return frames;
}

int push(const char* port, const char* schema, const char* identifier, const char* root,
         const flatbuffers::FlatBufferBuilder& fbb) {
  return plugin_push_output_ex(port, schema, identifier, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, root, 0, 8,
                               fbb.GetBufferPointer(), static_cast<uint32_t>(fbb.GetSize())) < 0
             ? 500
             : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// $OMM in.
// ---------------------------------------------------------------------------------------------------------------
struct ElementSet {
  Elements elements;
  std::string name, id, originator, creation;
};

// Every $OMM on the 'omm' port (plain, or size-prefixed one after another). Returns 0, or the refusal's status.
int readSets(std::vector<ElementSet>* sets) {
  const auto frames = framesOn("omm");
  if (frames.empty()) return refuse("missing-omm", "An 'omm' input frame is required.");
  for (const plugin_input_frame_t* f : frames) {
    std::string why;
    const bool ok = forEachRecord(f->payload, f->payload_length, "$OMM", [&](const uint8_t* data, size_t length, bool prefixed) {
      flatbuffers::Verifier verifier(data, length);
      if (!(prefixed ? VerifySizePrefixedOMMBuffer(verifier) : VerifyOMMBuffer(verifier))) { why = "The $OMM does not verify."; return false; }
      const OMM* root = prefixed ? GetSizePrefixedOMM(data) : GetOMM(data);
      std::unique_ptr<OMMT> record(root->UnPack());
      ElementSet set;
      if (!ommToElements(*record, &set.elements, &why)) return false;
      set.name = record->OBJECT_NAME;
      set.id = record->OBJECT_ID;
      set.originator = record->ORIGINATOR;
      set.creation = record->CREATION_DATE;
      sets->push_back(std::move(set));
      return true;
    });
    if (!ok) return refuse("invalid-omm", why.empty() ? "The 'omm' payload is not $OMM records." : why);
  }
  if (sets->size() > kMaxStates) return refuse("too-many-sets", "Too many element sets.");
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// $OEM in: the grid of `propagate` and the ephemerides of `fit`.
// ---------------------------------------------------------------------------------------------------------------
bool timeOf(const std::string& text, timingStandard system, Instant* out) {
  Instant stamp;
  if (!parseInstant(text, &stamp)) return false;
  double offset = 0;
  if (!utcOffsetSeconds(system, stamp, &offset)) return false;
  *out = addSeconds(stamp, offset);
  return true;
}

struct Grid {
  Frame frame = Frame::Teme;
  bool explicitTimes = false;
  std::vector<Instant> times;
  bool hasStart = false, hasStop = false;
  Instant start, stop;
  double step = 60.0;
};

int readGrid(std::vector<Grid>* grids) {
  for (const plugin_input_frame_t* f : framesOn("grid")) {
    std::string why;
    const bool ok = forEachRecord(f->payload, f->payload_length, "$OEM", [&](const uint8_t* data, size_t length, bool prefixed) {
      flatbuffers::Verifier verifier(data, length);
      if (!(prefixed ? VerifySizePrefixedOEMBuffer(verifier) : VerifyOEMBuffer(verifier))) { why = "The grid $OEM does not verify."; return false; }
      const OEM* root = prefixed ? GetSizePrefixedOEM(data) : GetOEM(data);
      std::unique_ptr<OEMT> oem(root->UnPack());
      for (const auto& block : oem->EPHEMERIS_DATA_BLOCK) {
        Grid g;
        if (block->REFERENCE_FRAME && !frameOf(block->REFERENCE_FRAME.get(), &g.frame)) { why = "The grid's REFERENCE_FRAME is not one this module writes."; return false; }
        if (g.frame == Frame::Itrf) { why = "The grid asks for Earth-fixed axes; this module writes TEME and GCRF."; return false; }
        if (!block->CENTER_NAME.empty() && upper(block->CENTER_NAME) != "EARTH") { why = "The grid's CENTER_NAME must be EARTH."; return false; }
        if (!block->EPHEMERIS_DATA_LINES.empty()) {
          g.explicitTimes = true;
          for (const auto& line : block->EPHEMERIS_DATA_LINES) {
            Instant t;
            if (!timeOf(line->EPOCH, block->TIME_SYSTEM, &t)) { why = "A grid EPOCH is not an ISO 8601 time: " + line->EPOCH; return false; }
            g.times.push_back(t);
          }
        } else {
          if (!block->START_TIME.empty()) {
            if (!timeOf(block->START_TIME, block->TIME_SYSTEM, &g.start)) { why = "START_TIME is not an ISO 8601 time."; return false; }
            g.hasStart = true;
          }
          if (!block->STOP_TIME.empty()) {
            if (!timeOf(block->STOP_TIME, block->TIME_SYSTEM, &g.stop)) { why = "STOP_TIME is not an ISO 8601 time."; return false; }
            g.hasStop = true;
          }
          if (block->STEP_SIZE > 0) g.step = block->STEP_SIZE;
        }
        grids->push_back(std::move(g));
      }
      return true;
    });
    if (!ok) return refuse("invalid-grid", why.empty() ? "The 'grid' payload is not an $OEM." : why);
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// $EOP in (optional): rows by MJD.
// ---------------------------------------------------------------------------------------------------------------
int readEop(EopTable* table) {
  for (const plugin_input_frame_t* f : framesOn("eop")) {
    std::string why;
    const bool ok = forEachRecord(f->payload, f->payload_length, "$EOP", [&](const uint8_t* data, size_t length, bool prefixed) {
      flatbuffers::Verifier verifier(data, length);
      if (!(prefixed ? VerifySizePrefixedEOPBuffer(verifier) : VerifyEOPBuffer(verifier))) { why = "The $EOP does not verify."; return false; }
      const EOP* root = prefixed ? GetSizePrefixedEOP(data) : GetEOP(data);
      EopRow row;
      row.mjd = static_cast<double>(root->MJD());
      row.dut1 = root->UT1_MINUS_UTC_SECONDS_HP() != 0.0 ? root->UT1_MINUS_UTC_SECONDS_HP() : static_cast<double>(root->UT1_MINUS_UTC_SECONDS());
      row.xPole = root->X_POLE_WANDER_RADIANS_HP() != 0.0 ? root->X_POLE_WANDER_RADIANS_HP() : static_cast<double>(root->X_POLE_WANDER_RADIANS());
      row.yPole = root->Y_POLE_WANDER_RADIANS_HP() != 0.0 ? root->Y_POLE_WANDER_RADIANS_HP() : static_cast<double>(root->Y_POLE_WANDER_RADIANS());
      row.dX = root->X_CELESTIAL_POLE_OFFSET_RADIANS_HP() != 0.0 ? root->X_CELESTIAL_POLE_OFFSET_RADIANS_HP() : static_cast<double>(root->X_CELESTIAL_POLE_OFFSET_RADIANS());
      row.dY = root->Y_CELESTIAL_POLE_OFFSET_RADIANS_HP() != 0.0 ? root->Y_CELESTIAL_POLE_OFFSET_RADIANS_HP() : static_cast<double>(root->Y_CELESTIAL_POLE_OFFSET_RADIANS());
      row.lod = root->LENGTH_OF_DAY_CORRECTION_SECONDS_HP() != 0.0 ? root->LENGTH_OF_DAY_CORRECTION_SECONDS_HP() : static_cast<double>(root->LENGTH_OF_DAY_CORRECTION_SECONDS());
      table->add(row);
      return true;
    });
    if (!ok) return refuse("invalid-eop", why.empty() ? "The 'eop' payload is not $EOP records." : why);
  }
  table->finish();
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// One ephemeris block as states in TEME.
// ---------------------------------------------------------------------------------------------------------------
constexpr double kEarthRotationRadPerS = 7.292115146706979e-5;

struct Series {
  std::vector<Sample> samples;  // TEME, strictly in the block's order
  Frame frame = Frame::Teme;
  bool positionOnly = true;
};

// false: `code` and `why` say why.
bool blockSeries(const ephemerisDataBlockT& b, const EopTable& eop, Series* out, std::string* code, std::string* why) {
  if (!b.REFERENCE_FRAME || !frameOf(b.REFERENCE_FRAME.get(), &out->frame)) {
    *code = "unsupported-frame";
    *why = "The block's REFERENCE_FRAME is missing or not one of TEME, GCRF (ICRF, J2000, EME2000) or an Earth-fixed frame (ITRF, ECEF).";
    return false;
  }
  if (!b.CENTER_NAME.empty() && upper(b.CENTER_NAME) != "EARTH") {
    *code = "unsupported-center";
    *why = "The block's CENTER_NAME must be EARTH.";
    return false;
  }
  struct Raw { Instant t; double r[3]; double v[3]; bool hasV; };
  std::vector<Raw> raw;
  if (b.STEP_SIZE > 0 && !b.EPHEMERIS_DATA.empty()) {
    const size_t stride = b.STATE_VECTOR_SIZE == 0 ? 6 : b.STATE_VECTOR_SIZE;
    if (stride != 3 && stride != 6 && stride != 9) { *code = "bad-state-size"; *why = "STATE_VECTOR_SIZE must be 3, 6 or 9."; return false; }
    if (b.EPHEMERIS_DATA.size() % stride != 0) { *code = "bad-ephemeris-data"; *why = "EPHEMERIS_DATA is not a whole number of states."; return false; }
    Instant start;
    if (!timeOf(b.START_TIME, b.TIME_SYSTEM, &start)) { *code = "bad-epoch"; *why = "START_TIME is not an ISO 8601 time: " + b.START_TIME; return false; }
    const size_t n = b.EPHEMERIS_DATA.size() / stride;
    for (size_t i = 0; i < n; ++i) {
      Raw s{};
      s.t = addSeconds(start, static_cast<double>(i) * b.STEP_SIZE);
      for (int k = 0; k < 3; ++k) s.r[k] = b.EPHEMERIS_DATA[i * stride + k];
      if (stride >= 6) { for (int k = 0; k < 3; ++k) s.v[k] = b.EPHEMERIS_DATA[i * stride + 3 + k]; s.hasV = true; }
      raw.push_back(s);
    }
  } else {
    for (const auto& line : b.EPHEMERIS_DATA_LINES) {
      Raw s{};
      if (!timeOf(line->EPOCH, b.TIME_SYSTEM, &s.t)) { *code = "bad-epoch"; *why = "An EPOCH is not an ISO 8601 time: " + line->EPOCH; return false; }
      s.r[0] = line->X; s.r[1] = line->Y; s.r[2] = line->Z;
      s.v[0] = line->X_DOT; s.v[1] = line->Y_DOT; s.v[2] = line->Z_DOT;
      s.hasV = line->X_DOT != 0.0 || line->Y_DOT != 0.0 || line->Z_DOT != 0.0;
      raw.push_back(s);
    }
  }
  if (raw.empty()) { *code = "no-states"; *why = "The block holds no states."; return false; }
  if (raw.size() > kMaxStates) { *code = "too-many-states"; *why = "The block holds more states than one request may."; return false; }
  for (const Raw& s : raw) {
    Sample sample;
    sample.t = s.t;
    if (!positionToTeme(out->frame, s.t, eop, s.r, sample.r)) { *code = "frame-failed"; *why = "No axes at " + formatInstant(s.t, 3) + " (outside ERFA's dates)."; return false; }
    if (s.hasV) {
      // Velocity: rotated with the position's axes (their rate is 1e-11 rad/s, 0.05 mm/s at low orbit; the
      // Earth-fixed frame's own rotation is added).
      double v[3] = {s.v[0], s.v[1], s.v[2]};
      if (out->frame == Frame::Itrf) {
        v[0] += -kEarthRotationRadPerS * s.r[1];
        v[1] += kEarthRotationRadPerS * s.r[0];
      }
      if (out->frame != Frame::Teme) {
        const fr::EarthOrientation orientation = eop.at(s.t);
        fr::Epoch epoch;
        if (!frameEpoch(s.t, orientation, &epoch)) { *code = "frame-failed"; *why = "No axes."; return false; }
        fr::Vec3 vec{v[0], v[1], v[2]};
        if (out->frame == Frame::Itrf) vec = fr::apply(fr::transpose(fr::gcrfToItrf(epoch, orientation)), vec);
        const fr::Vec3 t = fr::apply(fr::gcrfToTeme(epoch), vec);
        v[0] = t.x; v[1] = t.y; v[2] = t.z;
      }
      sample.v[0] = v[0]; sample.v[1] = v[1]; sample.v[2] = v[2];
      sample.hasVelocity = true;
      out->positionOnly = false;
    }
    out->samples.push_back(sample);
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// propagate
// ---------------------------------------------------------------------------------------------------------------
struct OutLine {
  Instant t;
  double r[3], v[3];
};

std::vector<Instant> gridTimes(const Grid& g, const Elements& e, std::string* why) {
  std::vector<Instant> times;
  if (g.explicitTimes) return g.times;
  const Instant start = g.hasStart ? g.start : epochOf(e);
  const Instant stop = g.hasStop ? g.stop : addSeconds(start, kSecondsPerDay);
  const double span = secondsBetween(stop, start);
  if (!(span >= 0) || !(g.step > 0)) { *why = "The grid's span or step is not positive."; return times; }
  const double count = std::floor(span / g.step + 1e-9) + 1.0;
  if (count > static_cast<double>(kMaxStates)) { *why = "The grid asks for more states than one request may."; return times; }
  for (size_t k = 0; k < static_cast<size_t>(count); ++k) times.push_back(addSeconds(start, static_cast<double>(k) * g.step));
  return times;
}

}  // namespace sgp4xp

extern "C" int propagate(void) {
  using namespace sgp4xp;
  plugin_reset_output_state();
  std::vector<ElementSet> sets;
  if (const int rc = readSets(&sets)) return rc;
  std::vector<Grid> grids;
  if (const int rc = readGrid(&grids)) return rc;
  if (grids.empty()) grids.push_back(Grid{});

  size_t budget = kMaxStates;
  uint32_t satnum = 0;
  for (const ElementSet& set : sets) {
    ++satnum;
    Satellite sat;
    int32_t libraryError = 0;
    if (!sat.create(set.elements, satnum, &libraryError))
      return refuse("element-set-refused",
                    "The element set of NORAD " + std::to_string(set.elements.norad) + " at " + formatInstant(epochOf(set.elements)) +
                        " was refused by the Space Force library (code " + std::to_string(libraryError) + ").",
                    422);
    auto oem = std::make_unique<OEMT>();
    oem->CCSDS_OEM_VERS = 2.0;
    oem->ORIGINATOR = kModuleName;
    oem->CREATION_DATE = set.creation;
    for (const Grid& g : grids) {
      std::string why;
      const std::vector<Instant> times = gridTimes(g, set.elements, &why);
      if (times.empty()) return refuse("bad-grid", why.empty() ? "The grid holds no epochs." : why);
      if (times.size() > budget) return refuse("too-many-states", "The request asks for more than 500,000 states.");
      budget -= times.size();
      std::vector<double> minutes(times.size());
      for (size_t i = 0; i < times.size(); ++i) minutes[i] = minutesSinceEpoch(set.elements, times[i]);
      std::vector<double> states(times.size() * 8);
      sat.propagate(minutes.data(), minutes.size(), states.data());
      auto block = std::make_unique<ephemerisDataBlockT>();
      block->OBJECT = std::make_unique<CATT>();
      block->OBJECT->OBJECT_NAME = set.name;
      block->OBJECT->OBJECT_ID = set.id;
      block->OBJECT->NORAD_CAT_ID = set.elements.norad;
      block->CENTER_NAME = "EARTH";
      block->REFERENCE_FRAME = rfmOf(g.frame == Frame::Gcrf);
      block->TIME_SYSTEM = timingStandard::UTC;
      block->COMMENT = std::string("SGP4-XP element set of epoch ") + formatInstant(epochOf(set.elements)) + (set.elements.xp ? "" : " (SGP4)");
      for (size_t i = 0; i < times.size(); ++i) {
        const double* m = &states[i * 8];
        if (m[0] != 0.0)
          return refuse("propagation-failed",
                        "The Space Force library cannot propagate NORAD " + std::to_string(set.elements.norad) + " to " + formatInstant(times[i]) +
                            " (library error " + std::to_string(static_cast<int>(m[0])) + ").",
                        422);
        double r[3] = {m[2], m[3], m[4]}, v[3] = {m[5], m[6], m[7]};
        if (g.frame == Frame::Gcrf) {
          double rg[3], vg[3];
          if (!stateTemeToGcrf(times[i], r, v, rg, vg)) return refuse("frame-failed", "No GCRF axes at " + formatInstant(times[i]) + ".", 422);
          std::memcpy(r, rg, sizeof r);
          std::memcpy(v, vg, sizeof v);
        }
        auto line = std::make_unique<ephemerisDataLineT>();
        line->EPOCH = formatInstant(times[i]);
        line->X = r[0]; line->Y = r[1]; line->Z = r[2];
        line->X_DOT = v[0]; line->Y_DOT = v[1]; line->Z_DOT = v[2];
        block->EPHEMERIS_DATA_LINES.push_back(std::move(line));
      }
      block->START_TIME = block->EPHEMERIS_DATA_LINES.front()->EPOCH;
      block->STOP_TIME = block->EPHEMERIS_DATA_LINES.back()->EPOCH;
      oem->EPHEMERIS_DATA_BLOCK.push_back(std::move(block));
    }
    flatbuffers::FlatBufferBuilder fbb(1 << 16);
    fbb.FinishSizePrefixed(CreateOEM(fbb, oem.get()), OEMIdentifier());
    if (const int rc = push("ephemeris", "OEM.fbs", "$OEM", "OEM", fbb)) return rc;
  }
  return 0;
}

namespace sgp4xp {

// ---------------------------------------------------------------------------------------------------------------
// fit
// ---------------------------------------------------------------------------------------------------------------
struct Provenance {
  std::string originator, creation, name, id;
  uint32_t norad = 0;
};

std::string statLine(const char* label, const Statistics& s) {
  char b[256];
  std::snprintf(b, sizeof b, "%s N=%zu RMS_KM=%s MAX_KM=%s RADIAL_RMS_KM=%s ALONG_TRACK_RMS_KM=%s CROSS_TRACK_RMS_KM=%s", label, s.count,
                number(s.rms).c_str(), number(s.max).c_str(), number(s.radial).c_str(), number(s.along).c_str(), number(s.cross).c_str());
  return b;
}

void addParameter(OMMT* omm, const std::string& name, const std::string& value) {
  auto p = std::make_unique<OMMUserDefinedParameterT>();
  p->PARAM_NAME = name;
  p->PARAM_VALUE = value;
  omm->USER_DEFINED_PARAMETERS.push_back(std::move(p));
}

std::unique_ptr<OMMT> ommOf(const FitResult& fit, const Provenance& who, const Instant& fitStart, const Instant& fitStop,
                            const Instant& heldStop, bool haveHeld) {
  auto omm = std::make_unique<OMMT>();
  const Elements& e = fit.elements;
  omm->CCSDS_OMM_VERS = 3.0;
  omm->CREATION_DATE = who.creation.empty() ? formatInstant(fitStop, 3) : who.creation;
  omm->ORIGINATOR = who.originator.empty() ? "UNKNOWN" : who.originator;
  omm->OBJECT_NAME = who.name;
  omm->OBJECT_ID = who.id;
  omm->CENTER_NAME = "EARTH";
  omm->REFERENCE_FRAME = rfmOf(false);
  omm->TIME_SYSTEM = timingStandard::UTC;
  omm->MEAN_ELEMENT_THEORY = meanElementSource::SGP4XP;
  omm->EPOCH = formatInstant(epochOf(e));
  omm->SEMI_MAJOR_AXIS = semiMajorAxisKm(e.meanMotion);
  omm->MEAN_MOTION = e.meanMotion;
  omm->ECCENTRICITY = e.eccentricity;
  omm->INCLINATION = e.inclination;
  omm->RA_OF_ASC_NODE = e.raan;
  omm->ARG_OF_PERICENTER = e.argPerigee;
  omm->MEAN_ANOMALY = e.meanAnomaly;
  omm->GM = kMuKm3PerS2;
  omm->CLASSIFICATION_TYPE = "U";
  omm->NORAD_CAT_ID = who.norad;
  omm->ELEMENT_SET_NO = 999;
  omm->BSTAR = e.drag;              // BTERM, m^2/kg
  omm->MEAN_MOTION_DOT = 0.0;
  omm->MEAN_MOTION_DDOT = e.agom;   // AGOM, m^2/kg
  omm->USER_DEFINED_EARTH_MODEL = "WGS-72";
  std::string comment = std::string("SGP4-XP fit by ") + kProduct + " to the ephemeris of " + (who.originator.empty() ? "an unnamed source" : who.originator) +
                        ". BTERM is BSTAR and AGOM is MEAN_MOTION_DDOT, in m**2/kg.\n";
  comment += statLine("FIT", fit.fit) + "\n";
  if (haveHeld && fit.heldOut.count > 0) comment += statLine("HELD_OUT", fit.heldOut);
  omm->COMMENT = comment;
  addParameter(omm.get(), "FIT_START", formatInstant(fitStart, 3));
  addParameter(omm.get(), "FIT_STOP", formatInstant(fitStop, 3));
  addParameter(omm.get(), "FIT_STATES", std::to_string(fit.fit.count));
  addParameter(omm.get(), "FIT_RMS_KM", number(fit.fit.rms));
  addParameter(omm.get(), "FIT_MAX_KM", number(fit.fit.max));
  addParameter(omm.get(), "FIT_RADIAL_RMS_KM", number(fit.fit.radial));
  addParameter(omm.get(), "FIT_ALONG_TRACK_RMS_KM", number(fit.fit.along));
  addParameter(omm.get(), "FIT_CROSS_TRACK_RMS_KM", number(fit.fit.cross));
  addParameter(omm.get(), "FIT_ITERATIONS", std::to_string(fit.iterations));
  addParameter(omm.get(), "FIT_CONVERGED", fit.converged ? "true" : "false");
  addParameter(omm.get(), "FIT_FIRST_PASS_RMS_KM", number(fit.firstPassRms));
  if (haveHeld && fit.heldOut.count > 0) {
    addParameter(omm.get(), "HELD_OUT_STOP", formatInstant(heldStop, 3));
    addParameter(omm.get(), "HELD_OUT_STATES", std::to_string(fit.heldOut.count));
    addParameter(omm.get(), "HELD_OUT_RMS_KM", number(fit.heldOut.rms));
    addParameter(omm.get(), "HELD_OUT_MAX_KM", number(fit.heldOut.max));
    for (const DayStatistics& d : fit.heldOutDays)
      addParameter(omm.get(), "HELD_OUT_DAY" + std::to_string(d.day) + "_RMS_KM", number(d.statistics.rms));
  }
  addParameter(omm.get(), "LIBRARY", "US Space Force Sgp4Prop 9.1.1.0 XP");
#ifdef SGP4XP_TRACE
  addParameter(omm.get(), "TRACE", fit.trace);
#endif
  return omm;
}

std::unique_ptr<OBDT> obdOf(const FitResult& fit, const Provenance& who, const Instant& fitStart, const Instant& fitStop,
                            const Instant& heldStop, bool haveHeld) {
  auto obd = std::make_unique<OBDT>();
  obd->ID = std::to_string(who.norad) + "-" + formatInstant(epochOf(fit.elements), 3) + "-SGP4XP";
  obd->SAT_NO = who.norad;
  obd->ORIG_OBJECT_ID = who.id;
  obd->START_TIME = formatInstant(fitStart, 3);
  obd->END_TIME = formatInstant(fitStop, 3);
  obd->METHOD = odMethod::BATCH_LEAST_SQUARES;
  obd->METHOD_SOURCE = std::string(kProduct) + ": Levenberg-Marquardt on TEME position residuals; fitted to " +
                       (who.originator.empty() ? "an unnamed source" : who.originator);
  obd->INITIAL_OD = false;
  obd->LAST_OB_START = obd->START_TIME;
  obd->LAST_OB_END = obd->END_TIME;
  obd->TIME_SPAN = secondsBetween(fitStop, fitStart) / kSecondsPerDay;
  obd->FIT_SPAN = obd->TIME_SPAN;
  obd->EFFECTIVE_FROM = formatInstant(epochOf(fit.elements), 3);
  obd->EFFECTIVE_UNTIL = formatInstant(haveHeld && fit.heldOut.count > 0 ? heldStop : fitStop, 3);
  obd->WRMS = fit.fit.rms;                // km, 3D, every state weighted alike
  obd->FIRST_PASS_WRMS = fit.firstPassRms;
  obd->BEST_PASS_WRMS = fit.fit.rms;
  if (haveHeld && fit.heldOut.count > 0 && !fit.heldOutDays.empty()) {
    // km/day: the held-out error at its last day, per day after the end of the fit interval.
    const DayStatistics& last = fit.heldOutDays.back();
    obd->ERROR_GROWTH_RATE = last.statistics.rms / static_cast<double>(last.day);
  }
  obd->BALLISTIC_COEFF_EST = true;
  obd->BALLISTIC_COEFF_MODEL = "SGP4-XP BTERM, m**2/kg";
  obd->AGOM_EST = true;
  obd->AGOM_MODEL = "SGP4-XP AGOM, m**2/kg";
  obd->RMS_CONVERGENCE_CRITERIA = 1.0e-9;
  obd->NUM_ITERATIONS = static_cast<uint16_t>(std::min(fit.iterations, 65535));
  obd->NUM_ACCEPTED_OBS = static_cast<uint32_t>(fit.fit.count);
  obd->NUM_REJECTED_OBS = 0;
  auto contribution = std::make_unique<odSensorContributionT>();
  contribution->SENSOR_ID = who.originator.empty() ? "ephemeris" : who.originator;
  contribution->NUM_ACCEPTED = static_cast<uint32_t>(fit.fit.count);
  contribution->WRMS = fit.fit.rms;
  contribution->OB_TYPES.push_back("EPHEMERIS_POSITION");
  obd->SENSORS.push_back(std::move(contribution));
  obd->ACCEPTED_OB_TYPS.push_back("EPHEMERIS_POSITION");
  return obd;
}

}  // namespace sgp4xp

extern "C" int fit(void) {
  using namespace sgp4xp;
  plugin_reset_output_state();
  EopTable eop;
  if (const int rc = readEop(&eop)) return rc;
  const auto frames = framesOn("ephemeris");
  if (frames.empty()) return refuse("missing-ephemeris", "An 'ephemeris' input frame is required.");

  size_t block_index = 0;
  for (const plugin_input_frame_t* f : frames) {
    std::string why;
    int status = 0;
    const bool ok = forEachRecord(f->payload, f->payload_length, "$OEM", [&](const uint8_t* data, size_t length, bool prefixed) {
      flatbuffers::Verifier verifier(data, length);
      if (!(prefixed ? VerifySizePrefixedOEMBuffer(verifier) : VerifyOEMBuffer(verifier))) { why = "The $OEM does not verify."; status = refuse("invalid-oem", why); return false; }
      const OEM* root = prefixed ? GetSizePrefixedOEM(data) : GetOEM(data);
      std::unique_ptr<OEMT> oem(root->UnPack());
      for (const auto& block : oem->EPHEMERIS_DATA_BLOCK) {
        ++block_index;
        const std::string where = "block " + std::to_string(block_index) + (block->OBJECT ? " (" + block->OBJECT->OBJECT_NAME + ")" : "");
        Series series;
        std::string code;
        if (!blockSeries(*block, eop, &series, &code, &why)) { status = refuse(code.c_str(), where + ": " + why, 422); return false; }

        // The declared fit interval, and the states held out after it.
        std::vector<Sample> fitSamples, held;
        Instant intervalStart = series.samples.front().t, intervalStop = series.samples.back().t;
        bool declared = false;
        if (!block->USEABLE_START_TIME.empty() || !block->USEABLE_STOP_TIME.empty()) {
          declared = true;
          if (!block->USEABLE_START_TIME.empty() && !timeOf(block->USEABLE_START_TIME, block->TIME_SYSTEM, &intervalStart)) { status = refuse("bad-epoch", where + ": USEABLE_START_TIME is not an ISO 8601 time.", 422); return false; }
          if (!block->USEABLE_STOP_TIME.empty() && !timeOf(block->USEABLE_STOP_TIME, block->TIME_SYSTEM, &intervalStop)) { status = refuse("bad-epoch", where + ": USEABLE_STOP_TIME is not an ISO 8601 time.", 422); return false; }
        }
        for (const Sample& s : series.samples) {
          if (secondsBetween(s.t, intervalStart) < -1e-6) continue;
          if (secondsBetween(s.t, intervalStop) <= 1e-6) fitSamples.push_back(s);
          else held.push_back(s);
        }
        if (fitSamples.size() < 10) { status = refuse("too-few-states", where + ": the fit interval holds fewer than 10 states.", 422); return false; }
        const Instant fitStart = fitSamples.front().t, fitStop = fitSamples.back().t;
        // No leap second inside the arc: minutes since epoch are counted in 86400-second days.
        {
          int64_t y0, m0, d0, y1, m1, d1;
          civilFromDays(fitStart.day - kMjdOfUnixEpoch, &y0, &m0, &d0);
          civilFromDays((held.empty() ? fitStop : held.back().t).day - kMjdOfUnixEpoch, &y1, &m1, &d1);
          double dat0 = 0, dat1 = 0;
          if (eraDat(static_cast<int>(y0), static_cast<int>(m0), static_cast<int>(d0), 0.0, &dat0) < 0 ||
              eraDat(static_cast<int>(y1), static_cast<int>(m1), static_cast<int>(d1), 0.0, &dat1) < 0 || dat0 != dat1) {
            status = refuse("leap-second-in-arc", where + ": a leap second falls inside the arc.", 422);
            return false;
          }
        }
        (void)declared;

        Provenance who;
        who.originator = oem->ORIGINATOR;
        who.creation = oem->CREATION_DATE;
        if (block->OBJECT) {
          who.name = block->OBJECT->OBJECT_NAME;
          who.id = block->OBJECT->OBJECT_ID;
          who.norad = block->OBJECT->NORAD_CAT_ID;
        }
        Fitter fitter(true);
        const Instant heldStop = held.empty() ? fitStop : held.back().t;
        FitResult result = fitter.run(fitSamples, held, who.norad);
        if (!result.ok) { status = refuse(result.code, where + ": " + result.message, 422); return false; }

        const auto omm = ommOf(result, who, fitStart, fitStop, heldStop, !held.empty());
        flatbuffers::FlatBufferBuilder a(4096);
        a.FinishSizePrefixed(CreateOMM(a, omm.get()), OMMIdentifier());
        if ((status = push("elements", "OMM.fbs", "$OMM", "OMM", a)) != 0) return false;
        const auto obd = obdOf(result, who, fitStart, fitStop, heldStop, !held.empty());
        flatbuffers::FlatBufferBuilder b(4096);
        b.FinishSizePrefixed(CreateOBD(b, obd.get()), OBDIdentifier());
        if ((status = push("determination", "OBD.fbs", "$OBD", "OBD", b)) != 0) return false;
      }
      return true;
    });
    if (status != 0) return status;
    if (!ok) return refuse("invalid-oem", why.empty() ? "The 'ephemeris' payload is not $OEM records." : why);
  }
  return 0;
}

// =================================================================================================================
// The propagator ABI (space-data-module-sdk docs/propagator-abi.md): the exports of propagator/keplerian-reference
// on this module's physics. Records are OrbProOMMRecord; BSTAR holds BTERM and MEAN_MOTION_DDOT holds AGOM, as in
// the SDS $OMM for SGP4-XP. States are Earth-fixed, metres and metres/second: TEME turned by GMST (IAU 1982,
// UT1 = UTC), the velocity relative to the rotating axes.
// =================================================================================================================
#define ORBPRO_ABI_EXPORT(name) __attribute__((export_name(name))) extern "C"

namespace sgp4xp {

constexpr int32_t kOk = 0;
constexpr int32_t kErrNotInitialized = -1;
constexpr int32_t kErrBadEntityIndex = -2;
constexpr int32_t kErrNullOutput = -3;
constexpr int32_t kErrBadInput = -4;
constexpr int32_t kErrUnphysical = -6;

struct Entity {
  Elements elements;
  Satellite satellite;
  uint32_t satnum = 0;
  double epochJd = 0;
};
std::vector<std::unique_ptr<Entity>>* g_entities = nullptr;
uint32_t g_nextSatnum = 0;

std::vector<std::unique_ptr<Entity>>& entities() {
  if (g_entities == nullptr) g_entities = new std::vector<std::unique_ptr<Entity>>();
  return *g_entities;
}

bool adopt(const OrbProOMMRecord& record, Entity* out) {
  if (!std::isfinite(record.epoch_jd) || !(record.mean_motion > 0) || !std::isfinite(record.mean_motion)) return false;
  if (!(record.eccentricity >= 0) || !(record.eccentricity < 1)) return false;
  Elements e;
  e.xp = true;
  const double mjd = record.epoch_jd - 2400000.5;
  Instant epoch;
  epoch.day = static_cast<int64_t>(std::floor(mjd));
  epoch.seconds = (mjd - static_cast<double>(epoch.day)) * kSecondsPerDay;
  setEpoch(&e, epoch);
  e.meanMotion = record.mean_motion;
  e.eccentricity = record.eccentricity;
  e.inclination = record.inclination;
  e.raan = record.ra_of_asc_node;
  e.argPerigee = record.arg_of_pericenter;
  e.meanAnomaly = record.mean_anomaly;
  e.drag = record.bstar;
  e.agom = record.mean_motion_ddot;
  e.norad = record.norad_cat_id;
  out->elements = e;
  out->epochJd = record.epoch_jd;
  return true;
}

// Adds a record; its handle, or a negative code.
int32_t addEntity(const OrbProOMMRecord& record) {
  auto entity = std::make_unique<Entity>();
  if (!adopt(record, entity.get())) return kErrBadInput;
  if (g_nextSatnum >= 99999) return kErrBadInput;
  entity->satnum = ++g_nextSatnum;
  if (!entity->satellite.create(entity->elements, entity->satnum)) return kErrUnphysical;
  entities().push_back(std::move(entity));
  return static_cast<int32_t>(entities().size() - 1);
}

int32_t propagateEntity(Entity& entity, double julianDate, OrbProStateVector* out) {
  const double mjd = julianDate - 2400000.5;
  Instant t;
  t.day = static_cast<int64_t>(std::floor(mjd));
  t.seconds = (mjd - static_cast<double>(t.day)) * kSecondsPerDay;
  const double minutes = minutesSinceEpoch(entity.elements, t);
  double state[8] = {0};
  if (!entity.satellite.propagate(&minutes, 1, state)) {
    orbpro_state_init(out);
    return kErrUnphysical;
  }
  const double theta = gmstRadians(julianDate);
  const double c = std::cos(theta), s = std::sin(theta);
  // km -> m, TEME -> Earth-fixed
  const double x = state[2] * 1000.0, y = state[3] * 1000.0, z = state[4] * 1000.0;
  const double vx = state[5] * 1000.0, vy = state[6] * 1000.0, vz = state[7] * 1000.0;
  const double xe = c * x + s * y, ye = -s * x + c * y;
  const double vxr = c * vx + s * vy, vyr = -s * vx + c * vy;
  orbpro_state_init(out);
  out->epoch = julianDate;
  out->position[0] = xe;
  out->position[1] = ye;
  out->position[2] = z;
  out->velocity[0] = vxr + kEarthRotationRadPerS * ye;
  out->velocity[1] = vyr - kEarthRotationRadPerS * xe;
  out->velocity[2] = vz;
  orbpro_state_set_reference_frame(out, ORBPRO_FRAME_ECEF);
  out->flags |= static_cast<uint32_t>(ORBPRO_STATE_VALID);
  return kOk;
}

void clearEntities() {
  delete g_entities;  // each entity's satellite leaves the library with it
  g_entities = nullptr;
  g_nextSatnum = 0;
}

}  // namespace sgp4xp

ORBPRO_ABI_EXPORT("plugin_init_omm")
int32_t plugin_init_omm(const OrbProOMMRecord* records, uint32_t count) {
  using namespace sgp4xp;
  if (records == nullptr) return kErrBadInput;
  clearEntities();
  entities().reserve(count);
  for (uint32_t i = 0; i < count; ++i) {
    const int32_t handle = addEntity(records[i]);
    if (handle < 0) { clearEntities(); return handle; }
  }
  return static_cast<int32_t>(entities().size());
}

ORBPRO_ABI_EXPORT("plugin_init")
int32_t plugin_init(const uint8_t* data, size_t len) {
  if (data == nullptr || len == 0) return sgp4xp::kErrBadInput;
  if (len % sizeof(OrbProOMMRecord) != 0) return sgp4xp::kErrBadInput;
  return plugin_init_omm(reinterpret_cast<const OrbProOMMRecord*>(data), static_cast<uint32_t>(len / sizeof(OrbProOMMRecord)));
}

ORBPRO_ABI_EXPORT("plugin_ingest_omm_one")
int32_t plugin_ingest_omm_one(const OrbProOMMRecord* record) {
  if (record == nullptr) return sgp4xp::kErrBadInput;
  return sgp4xp::addEntity(*record);
}

ORBPRO_ABI_EXPORT("plugin_propagate")
int32_t plugin_propagate(double julian_date, uint32_t entity_index, OrbProStateVector* out) {
  using namespace sgp4xp;
  if (out == nullptr) return kErrNullOutput;
  auto& store = entities();
  if (store.empty()) return kErrNotInitialized;
  if (entity_index >= store.size()) return kErrBadEntityIndex;
  return propagateEntity(*store[entity_index], julian_date, out);
}

ORBPRO_ABI_EXPORT("plugin_propagate_batch")
int32_t plugin_propagate_batch(double julian_date, OrbProStateVector* out, uint32_t count) {
  using namespace sgp4xp;
  if (out == nullptr) return kErrNullOutput;
  auto& store = entities();
  if (store.empty()) return kErrNotInitialized;
  if (count > store.size()) return kErrBadEntityIndex;
  for (uint32_t i = 0; i < count; ++i) {
    const int32_t status = propagateEntity(*store[i], julian_date, &out[i]);
    if (status != kOk) {
      orbpro_state_init(&out[i]);
      return status;
    }
  }
  return kOk;
}

ORBPRO_ABI_EXPORT("plugin_entity_count")
int32_t plugin_entity_count(void) {
  return sgp4xp::g_entities ? static_cast<int32_t>(sgp4xp::g_entities->size()) : 0;
}

ORBPRO_ABI_EXPORT("plugin_destroy")
void plugin_destroy(void) { sgp4xp::clearEntities(); }

// The invoke surface's way in: $OMM frames into the same entity table the ABI propagates from. Replaces the table.
extern "C" int ingest_omm(void) {
  using namespace sgp4xp;
  plugin_reset_output_state();
  std::vector<ElementSet> sets;
  if (const int rc = readSets(&sets)) return rc;
  clearEntities();
  for (const ElementSet& set : sets) {
    if (!set.elements.xp) return refuse("unsupported-theory", "ingest_omm takes SGP4XP element sets: the propagator ABI is this module's SGP4-XP.", 422);
    OrbProOMMRecord record;
    std::memset(&record, 0, sizeof record);
    record.epoch_jd = static_cast<double>(set.elements.epochDay) + 2400000.5 +
                      static_cast<double>(set.elements.epochTicks) * kEpochTickDays;
    record.mean_motion = set.elements.meanMotion;
    record.eccentricity = set.elements.eccentricity;
    record.inclination = set.elements.inclination;
    record.ra_of_asc_node = set.elements.raan;
    record.arg_of_pericenter = set.elements.argPerigee;
    record.mean_anomaly = set.elements.meanAnomaly;
    record.bstar = set.elements.drag;
    record.mean_motion_ddot = set.elements.agom;
    record.norad_cat_id = set.elements.norad;
    if (addEntity(record) < 0) return refuse("element-set-refused", "The Space Force library refused an element set.", 422);
  }
  return 0;
}
