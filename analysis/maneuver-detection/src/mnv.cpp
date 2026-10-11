// analysis/maneuver-detection: $MNV records.
//
// U, V and W follow the component comments of the SDS MNV schema: U along
// track (in-track), V cross-track (along the orbit normal), W radial. This is
// not the common RTN order; it is the schema's, kept as written.
namespace {

flatbuffers::Offset<mnvOrbitalState> stateTable(flatbuffers::FlatBufferBuilder& fb, const Vec3& r, const Vec3& v) {
  const Elements e = elementsOf(r, v);
  mnvOrbitalStateBuilder b(fb);
  b.add_POS_X(r[0]); b.add_POS_Y(r[1]); b.add_POS_Z(r[2]);
  b.add_VEL_X(v[0]); b.add_VEL_Y(v[1]); b.add_VEL_Z(v[2]);
  b.add_SMA(e.sma); b.add_ECCENTRICITY(e.ecc); b.add_INCLINATION(e.inc); b.add_RAAN(e.raan);
  b.add_PERIOD(e.period); b.add_APOGEE(e.apogee); b.add_PERIGEE(e.perigee);
  return b.Finish();
}

// Characterization, in order: DEORBIT when the post-event perigee is under
// 120 km; GEO (period 1300-1600 min, e < 0.05): STATION_KEEPING when |da| <
// 5 km, else PHASING; both components fired: COMBINED; cross-track only:
// OUT_OF_PLANE; in-track only, or a low-thrust rate change: ORBIT_RAISING or
// ORBIT_LOWERING by sign.
maneuverCharacterization characterize(const Event& ev, const Elements& pre, const Elements& post) {
  if (post.perigee < 120.0) return maneuverCharacterization::DEORBIT;
  const bool geo = pre.period > 1300.0 && pre.period < 1600.0 && pre.ecc < 0.05;
  if (ev.detector == "D3") return ev.accel > 0 ? maneuverCharacterization::ORBIT_RAISING : maneuverCharacterization::ORBIT_LOWERING;
  if (geo) return std::fabs(ev.deltaSma != 0 ? ev.deltaSma : post.sma - pre.sma) < 5.0 ? maneuverCharacterization::STATION_KEEPING
                                                                                      : maneuverCharacterization::PHASING;
  if (ev.inTrack != 0 && ev.crossTrack != 0) return maneuverCharacterization::COMBINED;
  if (ev.crossTrack != 0) return maneuverCharacterization::OUT_OF_PLANE;
  return ev.inTrack > 0 ? maneuverCharacterization::ORBIT_RAISING : maneuverCharacterization::ORBIT_LOWERING;
}

std::string algorithmOf(const std::string& detector) {
  if (detector == "D1") return "D1: crossing-point energy and orbit-normal differences, median step test";
  if (detector == "D2") return "D2: orbit-averaged energy levels and the orbit-normal chain, robust GLR step test";
  if (detector == "D3") return "D3: orbit-averaged energy levels, GLR test for a change of energy rate (low thrust)";
  return "C: D1 and D2 combined";
}

struct Provenance {
  std::string key, objectId, reportTime, frame, propagatorPort, comment0, comment1;
  uint32_t norad = 0;
};

std::vector<uint8_t> encodeEvent(const Event& e, const Provenance& pv, maneuverStatus status) {
  const Elements pre = elementsOf(e.r0, e.v0), post = elementsOf(e.r1, e.v1);
  const maneuverCharacterization kind = characterize(e, pre, post);
  const double big = std::max(std::fabs(e.rawInTrack), std::fabs(e.rawCrossTrack));
  const double unc = big > 0 ? std::min(std::fabs(e.rawInTrack), std::fabs(e.rawCrossTrack)) / big : 1.0;
  const std::string when = isoMs(e.time);
  flatbuffers::FlatBufferBuilder fb(4096);
  const auto id = fb.CreateString("MNV:" + pv.key + ":" + when + ":" + e.detector);
  const auto objectId = pv.objectId.empty() ? 0 : fb.CreateString(pv.objectId).o;
  const auto reportOffset = pv.reportTime.empty() ? 0 : fb.CreateString(pv.reportTime).o;
  const auto start = fb.CreateString(when);
  const auto end = fb.CreateString(isoMs(e.endTime));
  const auto preState = stateTable(fb, e.r0, e.v0);
  const auto postState = stateTable(fb, e.r1, e.v1);
  const auto algorithm = fb.CreateString("com.digitalarsenal.analysis.maneuver-detection 0.4.0 " + algorithmOf(e.detector) +
    (pv.propagatorPort.empty() ? "" : "; trajectories from propagator port " + pv.propagatorPort));
  std::string text = "Impulsive estimate from consecutive element-set trajectories (" + pv.frame +
    "). Delta-V in UVW: DELTA_VEL_V in-track from the energy change, DELTA_VEL_W cross-track from the orbit-normal change, each 0 unless its "
    "test fired; DELTA_VEL_U, the radial component, is not estimated (0). PRE_EVENT and POST_EVENT are osculating two-body states at the event time, km and km/s.";
  if (e.detector == "D3")
    text = "Change of the orbit-averaged energy rate (low thrust) at the event time (" + pv.frame +
      "): MNVR_ACCELS holds the change of in-track acceleration as U, V, W (radial, in-track, cross-track; km/s^2). DELTA_VEL is not estimated (0).";
  const auto description = fb.CreateString(text);
  std::vector<flatbuffers::Offset<flatbuffers::String>> sourced;
  if (!pv.comment0.empty()) sourced.push_back(fb.CreateString(pv.comment0));
  if (!pv.comment1.empty()) sourced.push_back(fb.CreateString(pv.comment1));
  const auto sourcedData = fb.CreateVector(sourced);
  const auto sourcedTypes = fb.CreateString("OEM");
  flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<flatbuffers::String>>> accelTimes;
  flatbuffers::Offset<flatbuffers::Vector<double>> accels;
  if (e.detector == "D3") {
    std::vector<flatbuffers::Offset<flatbuffers::String>> times = {fb.CreateString(when)};
    accelTimes = fb.CreateVector(times);
    accels = fb.CreateVector(std::vector<double>{0.0, e.accel / 1000.0, 0.0});
  }
  MNVBuilder b(fb);
  b.add_ID(id);
  if (pv.norad) b.add_SAT_NO(pv.norad);
  if (objectId) b.add_ORIG_OBJECT_ID(flatbuffers::Offset<flatbuffers::String>(objectId));
  b.add_STATUS(status);
  b.add_CHARACTERIZATION(kind);
  b.add_CHARACTERIZATION_UNC(unc);
  if (reportOffset) b.add_REPORT_TIME(flatbuffers::Offset<flatbuffers::String>(reportOffset));
  b.add_EVENT_START_TIME(start);
  b.add_EVENT_END_TIME(end);
  b.add_UCT(false);
  b.add_MANEUVER_UNC(e.separation);
  b.add_DELTA_VEL(std::hypot(e.inTrack, e.crossTrack) / 1000.0);
  b.add_DELTA_VEL_U(0.0);
  b.add_DELTA_VEL_V(e.inTrack / 1000.0);
  b.add_DELTA_VEL_W(e.crossTrack / 1000.0);
  b.add_PRE_EVENT(preState);
  b.add_POST_EVENT(postState);
  if (e.detector == "D3") {
    b.add_NUM_ACCEL_POINTS(1);
    b.add_MNVR_ACCEL_TIMES(accelTimes);
    b.add_MNVR_ACCELS(accels);
  }
  b.add_DESCRIPTION(description);
  b.add_ALGORITHM(algorithm);
  b.add_SOURCED_DATA(sourcedData);
  b.add_SOURCED_DATA_TYPES(sourcedTypes);
  FinishMNVBuffer(fb, b.Finish());
  return std::vector<uint8_t>(fb.GetBufferPointer(), fb.GetBufferPointer() + fb.GetSize());
}

Json eventJson(const Event& e) {
  const Elements pre = elementsOf(e.r0, e.v0), post = elementsOf(e.r1, e.v1);
  Json j = {{"detector", e.detector}, {"time", isoMs(e.time)}, {"characterization", EnumNamemaneuverCharacterization(characterize(e, pre, post))},
            {"in_track_mps", e.inTrack}, {"cross_track_mps", e.crossTrack}, {"in_track_fired", e.inTrackFired},
            {"cross_track_fired", e.crossTrackFired}, {"raw_in_track_mps", e.rawInTrack}, {"raw_cross_track_mps", e.rawCrossTrack},
            {"delta_sma_km", e.deltaSma}, {"separation_km", e.separation}, {"time_from_crossing", e.crossing},
            {"blocks", {e.before, e.after}}, {"evidence", e.evidence}};
  if (e.detector == "D3") j["accel_change_mps2"] = e.accel;
  return j;
}
}  // namespace
