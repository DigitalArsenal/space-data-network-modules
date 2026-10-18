// analysis/maneuver-detection: $MNV records.
//
// Delta-V is in the standard UVW axes of the SDS MNV schema: U radial, V
// in-track, W cross-track (along the orbit normal), km/s.
namespace {

// sigma: the state's 1-sigma position in its UVW axes (km), when the event has an impulse estimate.
flatbuffers::Offset<mnvOrbitalState> stateTable(flatbuffers::FlatBufferBuilder& fb, const Vec3& r, const Vec3& v, const Vec3* sigma = nullptr) {
  const Elements e = elementsOf(r, v);
  mnvOrbitalStateBuilder b(fb);
  b.add_POS_X(r[0]); b.add_POS_Y(r[1]); b.add_POS_Z(r[2]);
  b.add_VEL_X(v[0]); b.add_VEL_Y(v[1]); b.add_VEL_Z(v[2]);
  b.add_SMA(e.sma); b.add_ECCENTRICITY(e.ecc); b.add_INCLINATION(e.inc); b.add_RAAN(e.raan);
  b.add_PERIOD(e.period); b.add_APOGEE(e.apogee); b.add_PERIGEE(e.perigee);
  if (sigma) { b.add_SIGMA_U((*sigma)[0]); b.add_SIGMA_V((*sigma)[1]); b.add_SIGMA_W((*sigma)[2]); }
  return b.Finish();
}

// The impulse estimate in words: what DELTA_VEL, DELTA_POS and COV hold, the 1-sigma delta-V, the burn window, the
// minimum two-impulse bound and the error-model cells.
std::string mps(double kmPerS) {
  char b[32];
  std::snprintf(b, sizeof b, "%.3f", kmPerS * 1000.0);
  return b;
}
std::string impulseText(const Impulse& im, const std::string& frame) {
  const std::string bound = im.bound ? mps(im.boundTotal) + " +- " + mps(im.boundSigma) + " m/s (" + mps(norm(im.dv1)) + " m/s at " +
                                         isoMs(im.t1) + ", " + mps(norm(im.dv2)) + " m/s at " + isoMs(im.t2) + ")"
                                     : "not found";
  char chi2[32], scaleText[32];
  std::snprintf(chi2, sizeof chi2, "%.2f", im.chi2);
  std::snprintf(scaleText, sizeof scaleText, "%.1f", im.scale);
  return "Impulse between consecutive element sets (" + frame + ") given the GP error model " + im.model +
    ". DELTA_VEL_U, _V, _W (radial, in-track, cross-track) is the mean over the burn-time posterior in the bracket " + isoMs(im.lo) +
    " to " + isoMs(im.hi) + "; COV is the 6x6 covariance (UVW, km and km/s, upper triangle, row-major) of DELTA_POS_U, _V, _W, the "
    "post-minus-pre position at the event time, and DELTA_VEL_U, _V, _W. 1-sigma delta-V: U " + mps(std::sqrt(im.dvCov[0])) + ", V " +
    mps(std::sqrt(im.dvCov[4])) + ", W " + mps(std::sqrt(im.dvCov[8])) + " m/s. DELTA_VEL is the posterior mean of the magnitude: " +
    mps(im.speed) + " +- " + mps(im.speedSigma) + " m/s. Event time: the posterior mode of " + std::to_string(im.modes) +
    (im.modes == 1 ? " mode" : " modes (each component's sign can differ between them; a plane change can be made at either node)") +
    "; burn window (99.73 %): " + isoMs(im.windowStart) + " to " + isoMs(im.windowStop) + ". Minimum two-impulse delta-V in the bracket: " + bound +
    ". Position mismatch chi-square " + chi2 + " (3 degrees of freedom" +
    (im.scale > 1 ? std::string("; above 14.16, its 99.73 % point: no burn time fits one impulse, the trajectories do not meet (several "
                                "burns, a long burn, or a set fitted across the burn), so the error model's covariance is scaled by "
                                "chi-square / 3 = ") + scaleText + ")"
                  : std::string(")")) +
    ". Error-model cells: before " + im.cellPre + "; after " +
    im.cellPost + ". PRE_EVENT and POST_EVENT are the two sets' osculating two-body states at the event time, km and km/s, with their "
    "1-sigma position (SIGMA_U, _V, _W, km).";
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

// What a detected event is about: its object, the report it belongs to, the
// two element sets it lies between and the source those sets come from.
struct EventContext {
  std::string key, objectId, reportTime, frame, propagatorPort, comment0, comment1;
  Source source;
  uint32_t norad = 0;
};

std::vector<uint8_t> encodeEvent(const Event& e, const EventContext& pv, maneuverStatus status) {
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
  const Impulse& im = e.impulse;
  const auto preState = stateTable(fb, e.r0, e.v0, im.ok ? &im.sigmaPre : nullptr);
  const auto postState = stateTable(fb, e.r1, e.v1, im.ok ? &im.sigmaPost : nullptr);
  const auto algorithm = fb.CreateString(std::string(kProducer) + " " + algorithmOf(e.detector) +
    (pv.propagatorPort.empty() ? "" : "; trajectories from propagator port " + pv.propagatorPort) +
    (im.ok ? "; impulse from the GP error model " + im.model + " (burn-time posterior over the bracket, minimum two-impulse bound)" : ""));
  std::string text = "Impulsive estimate from consecutive element-set trajectories (" + pv.frame +
    "). Delta-V in UVW: DELTA_VEL_V in-track from the energy change, DELTA_VEL_W cross-track from the orbit-normal change, each 0 unless its "
    "test fired; DELTA_VEL_U, the radial component, is not estimated (0). PRE_EVENT and POST_EVENT are osculating two-body states at the event time, km and km/s.";
  if (e.detector == "D3")
    text = "Change of the orbit-averaged energy rate (low thrust) at the event time (" + pv.frame +
      "): MNVR_ACCELS holds the change of in-track acceleration as U, V, W (radial, in-track, cross-track; km/s^2). DELTA_VEL is not estimated (0).";
  else if (im.ok)
    text = impulseText(im, pv.frame);
  // COV: the covariance of (DELTA_POS_U, _V, _W, DELTA_VEL_U, _V, _W), upper triangle, row-major. Given the burn time,
  // the impulse's error is uncorrelated with the position mismatch (it is conditioned on it), so the blocks are apart.
  std::vector<double> cov;
  if (im.ok)
    for (int r = 0; r < 6; ++r)
      for (int c = r; c < 6; ++c)
        cov.push_back(r < 3 && c < 3 ? im.posCov[3 * r + c] : r >= 3 && c >= 3 ? im.dvCov[3 * (r - 3) + (c - 3)] : 0.0);
  const auto covOffset = im.ok ? fb.CreateVector(cov) : flatbuffers::Offset<flatbuffers::Vector<double>>();
  const auto description = fb.CreateString(text);
  std::vector<flatbuffers::Offset<flatbuffers::String>> sourced;
  if (!pv.comment0.empty()) sourced.push_back(fb.CreateString(pv.comment0));
  if (!pv.comment1.empty()) sourced.push_back(fb.CreateString(pv.comment1));
  const auto sourcedData = fb.CreateVector(sourced);
  const auto sourcedTypes = fb.CreateString("OEM");
  const auto provenance = encodeProvenance(fb, pv.source);
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
  if (im.ok) {
    b.add_DELTA_VEL(im.speed);
    b.add_DELTA_VEL_U(im.dv[0]);
    b.add_DELTA_VEL_V(im.dv[1]);
    b.add_DELTA_VEL_W(im.dv[2]);
    b.add_DELTA_POS(norm(im.dpos));
    b.add_DELTA_POS_U(im.dpos[0]);
    b.add_DELTA_POS_V(im.dpos[1]);
    b.add_DELTA_POS_W(im.dpos[2]);
    b.add_COV(covOffset);
  } else {
    b.add_DELTA_VEL(std::hypot(e.inTrack, e.crossTrack) / 1000.0);
    b.add_DELTA_VEL_U(0.0);
    b.add_DELTA_VEL_V(e.inTrack / 1000.0);
    b.add_DELTA_VEL_W(e.crossTrack / 1000.0);
  }
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
  b.add_PROVENANCE(provenance);
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
