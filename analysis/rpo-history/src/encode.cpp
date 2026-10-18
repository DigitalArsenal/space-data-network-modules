// analysis/rpo-history: the records the module writes.
//
// relative ($OCM, CCSDS 502.0-B-3): one record per segment, the chaser's
//   Cartesian state about the target (CENTER_NAME, another spacecraft as
//   CCSDS allows) in the target's RTN axes, rectilinear, km and km/s with the
//   velocity as seen in the rotating frame; START_TIME + i * STATE_STEP_SIZE.
//   History segments are TRAJ_BASIS-equivalent "element sets propagated";
//   the projection record is conditional (no maneuvers after its start) and
//   carries the relative position covariance (COV_TYPE CARTP, LTM, km**2,
//   RTN) with its realism ($CVR). Maneuver brackets are MANEUVER_DATA
//   (MAN_BASIS DETERMINED) on the record that follows them.
// geometry ($OCM, extended trajectory type RPO_GEOMETRY): the same segments
//   and epochs; STATE_DATA rows hold the columns USER_DEFINED_PARAMETERS
//   COLUMNS names (curvilinear RIC, separation, range rate, orbital-plane
//   angle, D'Amico relative orbital elements, the projection's 1-sigma).
//   CCSDS has no curvilinear or relative-element trajectory type, so these
//   are carried as an SDS extended type rather than as a CCSDS one.
// realism ($CVR): the projection covariance's hindcast.
namespace {

const char* const kGeometryColumns =
  "R_KM,I_KM,C_KM,I_UNWRAPPED_KM,SEPARATION_KM,RANGE_RATE_KM_S,PLANE_ANGLE_DEG,A_CHIEF_KM,DA,DLAMBDA,DEX,DEY,DIX,DIY,"
  "SIGMA_R_KM,SIGMA_I_KM,SIGMA_C_KM,SIGMA_SEPARATION_KM,BAND3_R_KM,BAND3_I_KM,BAND3_C_KM";
constexpr uint8_t kGeometryWidth = 21;

struct Context {
  const Object* chaser = nullptr;
  const Object* target = nullptr;
  Window w;
  std::string creation;
};

using StrOff = flatbuffers::Offset<flatbuffers::String>;
using Udp = flatbuffers::Offset<UserDefinedParameters>;

Udp udp(flatbuffers::FlatBufferBuilder& fb, const std::string& name, const std::string& value) {
  const auto n = fb.CreateString(name), v = fb.CreateString(value);
  return CreateUserDefinedParameters(fb, n, v);
}

flatbuffers::Offset<RFM> rtnFrame(flatbuffers::FlatBufferBuilder& fb) {
  const auto wrapper = CreateCustomFrameWrapper(fb, CustomFrame::RTN);
  const auto name = fb.CreateString("RTN");
  RFMBuilder b(fb);
  b.add_REFERENCE_FRAME_type(RFMUnion::CustomFrameWrapper);
  b.add_REFERENCE_FRAME(wrapper.Union());
  b.add_NAME(name);
  return b.Finish();
}

std::string objectLabel(const Object& o) {
  std::string s = o.objectName.empty() ? o.key : o.objectName;
  if (!o.objectId.empty()) s += " (" + o.objectId + (o.norad ? ", NORAD " + std::to_string(o.norad) : "") + ")";
  else if (o.norad) s += " (NORAD " + std::to_string(o.norad) + ")";
  return s;
}

std::string centerName(const Object& o) { return !o.objectId.empty() ? o.objectId : o.key; }

flatbuffers::Offset<Header> header(flatbuffers::FlatBufferBuilder& fb, const Context& c, const std::string& id) {
  const auto vers = fb.CreateString("3.0");
  const auto creation = fb.CreateString(c.creation);
  const auto originator = fb.CreateString("SDN");
  const auto message = fb.CreateString(id);
  HeaderBuilder b(fb);
  b.add_CCSDS_OCM_VERS(vers);
  b.add_CREATION_DATE(creation);
  b.add_ORIGINATOR(originator);
  b.add_MESSAGE_ID(message);
  return b.Finish();
}

flatbuffers::Offset<Metadata> metadata(flatbuffers::FlatBufferBuilder& fb, const Context& c, const Segment& seg) {
  const Object& ch = *c.chaser;
  const Object& tg = *c.target;
  std::vector<StrOff> comments;
  comments.push_back(fb.CreateString("Chaser " + objectLabel(ch) + " relative to target " + objectLabel(tg) +
                                     ", in the target's CCSDS RTN axes from its inertial state."));
  comments.push_back(fb.CreateString("Chaser element set " + ch.sets[size_t(seg.ic)].comment + "; target element set " +
                                     tg.sets[size_t(seg.it)].comment + "."));
  if (seg.projection)
    comments.push_back(fb.CreateString("CONDITIONAL coast projection: both newest element sets held fixed, no maneuvers after " +
                                       isoMs(seg.samples.front().t) + "."));
  const auto commentVec = fb.CreateVector(comments);
  const auto name = fb.CreateString(ch.objectName);
  const auto intl = fb.CreateString(ch.objectId);
  const auto desig = fb.CreateString(ch.norad ? std::to_string(ch.norad) : ch.key);
  const auto ts = fb.CreateString("UTC");
  const auto start = fb.CreateString(isoMs(seg.samples.front().t));
  const auto stop = fb.CreateString(isoMs(seg.samples.back().t));
  MetadataBuilder b(fb);
  b.add_COMMENT(commentVec);
  b.add_OBJECT_NAME(name);
  b.add_INTERNATIONAL_DESIGNATOR(intl);
  b.add_OBJECT_DESIGNATOR(desig);
  b.add_TIME_SYSTEM(ts);
  b.add_START_TIME(start);
  b.add_STOP_TIME(stop);
  b.add_TIME_SPAN((seg.samples.back().t - seg.samples.front().t) / 86400.0);
  return b.Finish();
}

std::vector<flatbuffers::Offset<Maneuver>> bracketsFor(flatbuffers::FlatBufferBuilder& fb, const Context& c, double from, double to) {
  std::vector<flatbuffers::Offset<Maneuver>> out;
  for (const Object* o : {c.chaser, c.target}) {
    for (size_t i = 0; i < o->brackets.size(); ++i) {
      const auto& b = o->brackets[i];
      if (!(b.second > from && b.second <= to)) continue;
      const auto id = fb.CreateString(o->bracketIds[i].empty() ? "BRACKET:" + o->key + ":" + isoMs(b.first) : o->bracketIds[i]);
      const auto basis = fb.CreateString("DETERMINED");
      const auto start = fb.CreateString(isoMs(b.first));
      std::vector<StrOff> text{fb.CreateString(o->role + " " + o->key + ": orbit-change bracket from the element set of " +
                                               isoMs(b.first) + " to that of " + isoMs(b.second) +
                                               " (analysis/maneuver-detection); not propagated through.")};
      const auto comment = fb.CreateVector(text);
      ManeuverBuilder m(fb);
      m.add_MAN_ID(id);
      m.add_MAN_BASIS(basis);
      m.add_MAN_EPOCH_START(start);
      m.add_MAN_DURATION(b.second - b.first);
      m.add_MAN_COMMENT(comment);
      out.push_back(m.Finish());
    }
  }
  return out;
}

Source sourceOfSegment(const Context& c, const Segment& seg) {
  return agreement(c.chaser->sets[size_t(seg.ic)].source, c.target->sets[size_t(seg.it)].source);
}

flatbuffers::Offset<CVR> realismRecord(flatbuffers::FlatBufferBuilder& fb, const Context& c, const ErrorModel& model,
                                       const Hindcast& h, const Projection& p, const Source& lineage) {
  const std::string regimes = "chaser " + model.regimeName(p.chaserRegime) + "; target " + model.regimeName(p.targetRegime);
  std::string evidence = "analysis/rpo-history hindcast of the conditional projection: " + std::to_string(h.samples) +
    " predictions (sets in force at t0) against the next element sets of either object (" + std::to_string(h.truthEpochs) +
    " distinct truth epochs) within " + fmt(c.w.horizon / 3600.0) +
    " h, none across a maneuver bracket or from a set issued within " + fmt(c.w.settle / 86400.0) + " d after one; " +
    (c.w.calibration > 0 ? "the model's bands times per-axis factors from the pair's own relative samples in the trailing " +
                               fmt(c.w.calibration / 86400.0) + " d before t0; " : std::string("the model's bands as they are; ")) +
    "curvilinear R/I/C inside the 1-sigma band " + fmt(h.fraction1(0), "%.3f") + "/" + fmt(h.fraction1(1), "%.3f") + "/" +
    fmt(h.fraction1(2), "%.3f") + " (nominal 0.683), inside the 3-sigma band " + fmt(h.fraction3(0), "%.4f") + "/" +
    fmt(h.fraction3(1), "%.4f") + "/" + fmt(h.fraction3(2), "%.4f") + " (nominal 0.9973)" +
    (p.settling ? "; this projection starts from a settling element set (within " + fmt(c.w.settle / 86400.0) +
                      " d after a maneuver bracket), which the hindcast does not cover" : std::string());
  const auto modelId = fb.CreateString(model.id);
  const auto regime = fb.CreateString(regimes);
  const auto measured = fb.CreateString(lineage.lineage);
  const auto window = fb.CreateString(std::isfinite(h.first) ? isoMs(h.first) + "/" + isoMs(h.last) : std::string());
  const auto ev = fb.CreateString(evidence);
  CVRBuilder b(fb);
  b.add_RULE(model.pooled ? covarianceRule::PooledModel : covarianceRule::SourceModel);
  b.add_MODEL_ID(modelId);
  b.add_REGIME(regime);
  b.add_HORIZON_DAYS(c.w.horizon / 86400.0);
  if (!lineage.lineage.empty()) b.add_MEASURED_LINEAGE(measured);
  b.add_TEST_WINDOW(window);
  b.add_MEAN_D2_OVER_3(h.meanD2Over3());
  b.add_COVERAGE_95(h.coverage95());
  b.add_SAMPLES(uint32_t(h.samples));
  b.add_OBJECTS(uint32_t(h.objects()));
  b.add_CALIBRATION(h.calibrated() ? covarianceCalibration::Calibrated : covarianceCalibration::Uncalibrated);
  b.add_EVIDENCE(ev);
  return b.Finish();
}

std::vector<uint8_t> finishOcm(flatbuffers::FlatBufferBuilder& fb, flatbuffers::Offset<OCM> root) {
  FinishSizePrefixedOCMBuffer(fb, root);
  return std::vector<uint8_t>(fb.GetBufferPointer(), fb.GetBufferPointer() + fb.GetSize());
}

std::vector<uint8_t> relativeRecord(const Context& c, const Segment& seg, size_t index, double bracketsFrom, double bracketsTo,
                                    const ErrorModel& model, const Hindcast& h, const Projection& p) {
  flatbuffers::FlatBufferBuilder fb(1024 + seg.samples.size() * 6 * 8 * 2);
  const std::string id = "RPO:" + c.chaser->key + ":" + c.target->key + ":" + (seg.projection ? "PROJECTION" : "HISTORY") + ":" +
                         std::to_string(index);
  const auto head = header(fb, c, id);
  const auto meta = metadata(fb, c, seg);
  std::vector<double> data;
  data.reserve(seg.samples.size() * 6);
  for (const Sample& s : seg.samples) data.insert(data.end(), s.rel.begin(), s.rel.end());
  const auto dataVec = fb.CreateVector(data);
  const auto center = fb.CreateString(centerName(*c.target));
  const auto frame = rtnFrame(fb);
  const auto covFrame = rtnFrame(fb);
  const auto maneuvers = bracketsFor(fb, c, bracketsFrom, bracketsTo);
  const auto maneuverVec = fb.CreateVector(maneuvers);
  const Source src = sourceOfSegment(c, seg);
  const auto pvn = encodeProvenance(fb, src);
  std::vector<Udp> params;
  params.push_back(udp(fb, "SEGMENT", seg.projection ? "PROJECTION" : "HISTORY"));
  params.push_back(udp(fb, "CHASER_ELEMENT_SET_EPOCH", isoMs(c.chaser->sets[size_t(seg.ic)].epoch)));
  params.push_back(udp(fb, "TARGET_ELEMENT_SET_EPOCH", isoMs(c.target->sets[size_t(seg.it)].epoch)));
  params.push_back(udp(fb, "VELOCITY", "rotating frame: B^T (v_chaser - v_target) - w x r, w = |r x v| / |r|^2 about N of the target"));
  if (seg.projection) params.push_back(udp(fb, "CONDITIONAL", "no maneuvers after " + isoMs(seg.samples.front().t)));
  const auto paramVec = fb.CreateVector(params);
  flatbuffers::Offset<flatbuffers::Vector<double>> covVec;
  flatbuffers::Offset<flatbuffers::Vector<StrOff>> covUnits;
  StrOff covType, calRef;
  flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<CVR>>> realismVec;
  bool withCov = seg.projection && model.present;
  for (const Sample& s : seg.samples) withCov = withCov && s.hasCov;
  covarianceCalibration calibration = covarianceCalibration::Unspecified;
  if (withCov) {
    std::vector<double> cov;
    for (const Sample& s : seg.samples) {
      const Mat3& m = s.covRel;
      cov.insert(cov.end(), {m[0], m[3], m[4], m[6], m[7], m[8]});
    }
    covVec = fb.CreateVector(cov);
    covType = fb.CreateString("CARTP");
    std::vector<StrOff> units{fb.CreateString("km"), fb.CreateString("km"), fb.CreateString("km")};
    covUnits = fb.CreateVector(units);
    const auto cvr = realismRecord(fb, c, model, h, p, src);
    realismVec = fb.CreateVector(std::vector<flatbuffers::Offset<CVR>>{cvr});
    calRef = fb.CreateString("analysis/rpo-history hindcast; error model " + model.id);
    calibration = h.calibrated() ? covarianceCalibration::Calibrated : covarianceCalibration::Uncalibrated;
  }
  OCMBuilder b(fb);
  b.add_HEADER(head);
  b.add_METADATA(meta);
  b.add_TRAJ_TYPE(trajectoryType::CARTESIAN_PV);
  b.add_STATE_STEP_SIZE(c.w.step);
  b.add_STATE_VECTOR_SIZE(6);
  b.add_STATE_DATA(dataVec);
  if (!maneuvers.empty()) b.add_MANEUVER_DATA(maneuverVec);
  b.add_USER_DEFINED_PARAMETERS(paramVec);
  b.add_CENTER_NAME(center);
  b.add_TRAJ_REF_FRAME(frame);
  if (withCov) {
    b.add_COVARIANCE_DATA(covVec);
    b.add_COV_REF_FRAME(covFrame);
    b.add_COV_TYPE(covType);
    b.add_COV_ORDERING(covarianceOrdering::LTM);
    b.add_COV_SIZE(3);
    b.add_COV_UNITS(covUnits);
    b.add_COV_CALIBRATION(calibration);
    b.add_COV_CALIBRATION_REFERENCE(calRef);
    b.add_COV_REALISM(realismVec);
  }
  b.add_PROVENANCE(pvn);
  return finishOcm(fb, b.Finish());
}

std::vector<uint8_t> geometryRecord(const Context& c, const Segment& seg, size_t index, const std::vector<std::pair<std::string, std::string>>& extra) {
  flatbuffers::FlatBufferBuilder fb(1024 + seg.samples.size() * kGeometryWidth * 8 + 2048);
  const std::string id = "RPO-GEOMETRY:" + c.chaser->key + ":" + c.target->key + ":" + (seg.projection ? "PROJECTION" : "HISTORY") + ":" +
                         std::to_string(index);
  const auto head = header(fb, c, id);
  const auto meta = metadata(fb, c, seg);
  const auto description = fb.CreateString("RPO_GEOMETRY");
  std::vector<double> data;
  data.reserve(seg.samples.size() * kGeometryWidth);
  for (const Sample& s : seg.samples) {
    const double roe[7] = {s.roe.ok ? s.roe.a : kNaN, s.roe.ok ? s.roe.da : kNaN, s.roe.ok ? s.roe.dl : kNaN, s.roe.ok ? s.roe.dex : kNaN,
                           s.roe.ok ? s.roe.dey : kNaN, s.roe.ok ? s.roe.dix : kNaN, s.roe.ok ? s.roe.diy : kNaN};
    data.insert(data.end(), {s.R, s.I, s.C, s.Iunwrapped, s.separation, s.rangeRate, s.planeDeg});
    data.insert(data.end(), roe, roe + 7);
    data.insert(data.end(), {s.sR, s.sI, s.sC, s.sSep, s.b3R, s.b3I, s.b3C});
  }
  const auto dataVec = fb.CreateVector(data);
  const auto center = fb.CreateString(centerName(*c.target));
  const auto frame = rtnFrame(fb);
  const auto pvn = encodeProvenance(fb, sourceOfSegment(c, seg));
  std::vector<Udp> params;
  params.push_back(udp(fb, "COLUMNS", kGeometryColumns));
  params.push_back(udp(fb, "SEGMENT", seg.projection ? "PROJECTION" : "HISTORY"));
  params.push_back(udp(fb, "CURVILINEAR",
    "about the target at r0 = |r_target|: R = |p| - r0, I = r0 atan2(y, r0 + x) wrapped to +-pi r0, C = r0 atan2(z, hypot(r0 + x, y)), "
    "(x, y, z) the chaser's rectilinear RTN offset; I_UNWRAPPED continuous within the record (foundation/frames/include/rtn_curvilinear.hpp)"));
  params.push_back(udp(fb, "RELATIVE_ORBITAL_ELEMENTS",
    "D'Amico 2010 quasi-nonsingular, chief = target, from osculating two-body elements: DA = (a_d - a_c)/a_c, DLAMBDA = du + dRAAN cos i_c, "
    "DEX/DEY = e cos/sin w differences, DIX = di, DIY = dRAAN sin i_c (rad); A_CHIEF_KM = a_c"));
  params.push_back(udp(fb, "UNITS", "km, km/s, deg (PLANE_ANGLE_DEG), rad and dimensionless (relative orbital elements)"));
  params.push_back(udp(fb, "BANDS",
    "projection only: SIGMA_* the GP error model's 1-sigma times per-axis factors, the 68.27 % quantile of |error| / model sigma over the "
    "pair's own relative samples (predictions against the next element sets) in the trailing calibration window; BAND3_* the 3-sigma band "
    "half-width from the 99.73 % quantile (not 3 SIGMA_* when the errors are not Gaussian); NaN in the history"));
  params.push_back(udp(fb, "CHASER_ELEMENT_SET_EPOCH", isoMs(c.chaser->sets[size_t(seg.ic)].epoch)));
  params.push_back(udp(fb, "TARGET_ELEMENT_SET_EPOCH", isoMs(c.target->sets[size_t(seg.it)].epoch)));
  if (seg.projection) params.push_back(udp(fb, "CONDITIONAL", "no maneuvers after " + isoMs(seg.samples.front().t)));
  for (const auto& [k, v] : extra) params.push_back(udp(fb, k, v));
  const auto paramVec = fb.CreateVector(params);
  OCMBuilder b(fb);
  b.add_HEADER(head);
  b.add_METADATA(meta);
  b.add_TRAJ_TYPE_DESCRIPTION(description);
  b.add_STATE_STEP_SIZE(c.w.step);
  b.add_STATE_VECTOR_SIZE(kGeometryWidth);
  b.add_STATE_DATA(dataVec);
  b.add_USER_DEFINED_PARAMETERS(paramVec);
  b.add_CENTER_NAME(center);
  b.add_TRAJ_REF_FRAME(frame);
  b.add_PROVENANCE(pvn);
  return finishOcm(fb, b.Finish());
}

std::vector<uint8_t> realismOnly(const Context& c, const ErrorModel& model, const Hindcast& h, const Projection& p, const Source& lineage) {
  flatbuffers::FlatBufferBuilder fb(2048);
  const auto root = realismRecord(fb, c, model, h, p, lineage);
  FinishSizePrefixedCVRBuffer(fb, root);
  return std::vector<uint8_t>(fb.GetBufferPointer(), fb.GetBufferPointer() + fb.GetSize());
}
}  // namespace
