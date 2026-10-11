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
// An instant given on the time scale of an $OEM block, as UTC.
bool timeOf(const std::string& text, timingStandard system, Instant* out) {
  TimeScale scale;
  return timeScaleOf(system, &scale) && utcOf(text, scale, out);
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
        { TimeScale scale; if (!timeScaleOf(block->TIME_SYSTEM, &scale)) { why = "The grid's TIME_SYSTEM must be UTC, GPS, TAI or TT."; return false; } }
        if (block->REFERENCE_FRAME && !frameOf(block->REFERENCE_FRAME.get(), &g.frame)) { why = "The grid's REFERENCE_FRAME is not one this module writes."; return false; }
        if (g.frame == Frame::Itrf) { why = "The grid asks for Earth-fixed axes; this module writes TEME, GCRF and EME2000."; return false; }
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
struct Series {
  std::vector<Sample> samples;  // TEME, strictly in the block's order
  Frame frame = Frame::Teme;
  bool positionOnly = true;
};

// false: `code` and `why` say why.
bool blockSeries(const ephemerisDataBlockT& b, const EopTable& eop, Series* out, std::string* code, std::string* why) {
  TimeScale scale;
  if (!timeScaleOf(b.TIME_SYSTEM, &scale)) {
    *code = "unsupported-time-system";
    *why = "The block's TIME_SYSTEM must be UTC, GPS, TAI or TT.";
    return false;
  }
  if (!b.REFERENCE_FRAME || !frameOf(b.REFERENCE_FRAME.get(), &out->frame)) {
    *code = "unsupported-frame";
    *why = "The block's REFERENCE_FRAME is missing or not one of TEME, GCRF (ICRF), J2000 (EME2000) or an Earth-fixed frame (ITRF, ECEF).";
    return false;
  }
  if (!b.CENTER_NAME.empty() && upper(b.CENTER_NAME) != "EARTH") {
    *code = "unsupported-center";
    *why = "The block's CENTER_NAME must be EARTH.";
    return false;
  }
  std::vector<Observed> raw;
  if (b.STEP_SIZE > 0 && !b.EPHEMERIS_DATA.empty()) {
    const size_t stride = b.STATE_VECTOR_SIZE == 0 ? 6 : b.STATE_VECTOR_SIZE;
    if (stride != 3 && stride != 6 && stride != 9) { *code = "bad-state-size"; *why = "STATE_VECTOR_SIZE must be 3, 6 or 9."; return false; }
    if (b.EPHEMERIS_DATA.size() % stride != 0) { *code = "bad-ephemeris-data"; *why = "EPHEMERIS_DATA is not a whole number of states."; return false; }
    Instant start;
    if (!timeOf(b.START_TIME, b.TIME_SYSTEM, &start)) { *code = "bad-epoch"; *why = "START_TIME is not an ISO 8601 time: " + b.START_TIME; return false; }
    const size_t n = b.EPHEMERIS_DATA.size() / stride;
    for (size_t i = 0; i < n; ++i) {
      Observed s;
      s.t = addSeconds(start, static_cast<double>(i) * b.STEP_SIZE);
      for (int k = 0; k < 3; ++k) s.r[k] = b.EPHEMERIS_DATA[i * stride + k];
      if (stride >= 6) { for (int k = 0; k < 3; ++k) s.v[k] = b.EPHEMERIS_DATA[i * stride + 3 + k]; s.hasVelocity = true; }
      raw.push_back(s);
    }
  } else {
    for (const auto& line : b.EPHEMERIS_DATA_LINES) {
      Observed s;
      if (!timeOf(line->EPOCH, b.TIME_SYSTEM, &s.t)) { *code = "bad-epoch"; *why = "An EPOCH is not an ISO 8601 time: " + line->EPOCH; return false; }
      s.r[0] = line->X; s.r[1] = line->Y; s.r[2] = line->Z;
      s.v[0] = line->X_DOT; s.v[1] = line->Y_DOT; s.v[2] = line->Z_DOT;
      s.hasVelocity = line->X_DOT != 0.0 || line->Y_DOT != 0.0 || line->Z_DOT != 0.0;
      raw.push_back(s);
    }
  }
  if (raw.empty()) { *code = "no-states"; *why = "The block holds no states."; return false; }
  if (raw.size() > kMaxStates) { *code = "too-many-states"; *why = "The block holds more states than one request may."; return false; }
  return toTeme(raw, out->frame, eop, &out->samples, &out->positionOnly, code, why);
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
      block->REFERENCE_FRAME = rfmOf(g.frame);
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
        if (g.frame == Frame::Gcrf || g.frame == Frame::Eme2000) {
          double rg[3], vg[3];
          if (!stateTemeToGcrf(times[i], r, v, rg, vg, g.frame == Frame::Eme2000)) return refuse("frame-failed", "No GCRF axes at " + formatInstant(times[i]) + ".", 422);
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

// ---------------------------------------------------------------------------------------------------------------
// fit
// ---------------------------------------------------------------------------------------------------------------
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

        // The declared fit interval (USEABLE_START_TIME to USEABLE_STOP_TIME; the whole block when it declares none),
        // and the states after it that score the fit.
        Instant intervalStart = series.samples.front().t, intervalStop = series.samples.back().t;
        if (!block->USEABLE_START_TIME.empty() && !timeOf(block->USEABLE_START_TIME, block->TIME_SYSTEM, &intervalStart)) { status = refuse("bad-epoch", where + ": USEABLE_START_TIME is not an ISO 8601 time.", 422); return false; }
        if (!block->USEABLE_STOP_TIME.empty() && !timeOf(block->USEABLE_STOP_TIME, block->TIME_SYSTEM, &intervalStop)) { status = refuse("bad-epoch", where + ": USEABLE_STOP_TIME is not an ISO 8601 time.", 422); return false; }

        Provenance who;
        who.originator = oem->ORIGINATOR;
        who.creation = oem->CREATION_DATE;
        if (block->OBJECT) {
          who.name = block->OBJECT->OBJECT_NAME;
          who.id = block->OBJECT->OBJECT_ID;
          who.norad = block->OBJECT->NORAD_CAT_ID;
        }
        IntervalFit interval;
        std::string fitCode;
        if (!fitInterval(series.samples, intervalStart, intervalStop, series.samples.back().t, who.norad, 0, &interval, &fitCode, &why)) {
          status = refuse(fitCode.c_str(), where + ": " + why, 422);
          return false;
        }

        const auto omm = ommOf(interval, who, kProduct);
        flatbuffers::FlatBufferBuilder a(4096);
        a.FinishSizePrefixed(CreateOMM(a, omm.get()), OMMIdentifier());
        if ((status = push("elements", "OMM.fbs", "$OMM", "OMM", a)) != 0) return false;
        const auto obd = obdOf(interval, who, kProduct);
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
