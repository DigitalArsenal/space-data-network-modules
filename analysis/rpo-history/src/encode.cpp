// analysis/rpo-history: the records the module writes.
//
// relative ($OCM, CCSDS 502.0-B-3): one record per segment, the chaser's
//   Cartesian state about the target (CENTER_NAME, another spacecraft as
//   CCSDS allows) in the target's RTN axes, rectilinear, km and km/s with the
//   velocity as seen in the rotating frame; START_TIME + i * STATE_STEP_SIZE.
//   History segments are TRAJ_BASIS DETERMINED (the element sets in force at
//   each time); the projection is PREDICTED, conditional (no maneuvers after
//   its start), and carries the relative position covariance (COV_TYPE CARTP,
//   LTM, km**2, RTN) with its realism ($CVR). SEED_SETS name the chaser's and
//   the target's element sets. Maneuver brackets are MANEUVER_DATA (MAN_BASIS
//   DETERMINED, NORAD_CAT_ID the object's) on the record that follows them.
// geometry ($OCM, RPO_GEOMETRY): the same segments, epochs, TRAJ_BASIS and
//   SEED_SETS; OCMRelativeGeometry holds one vector per quantity (curvilinear
//   RIC, separation, range rate, orbital-plane angle, D'Amico relative orbital
//   elements, the projection's bands); STATE_DATA is empty.
// realism ($CVR): the projection covariance's hindcast.
namespace {

struct Context {
  const Object* chaser = nullptr;
  const Object* target = nullptr;
  Window w;
  std::string creation;
};

using StrOff = flatbuffers::Offset<flatbuffers::String>;

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

flatbuffers::Offset<Metadata> metadata(flatbuffers::FlatBufferBuilder& fb, const Context& c, const Segment& seg, bool settling) {
  const Object& ch = *c.chaser;
  const Object& tg = *c.target;
  std::vector<StrOff> comments;
  comments.push_back(fb.CreateString("Chaser " + objectLabel(ch) + " relative to target " + objectLabel(tg) +
                                     ", in the target's CCSDS RTN axes from its inertial state."));
  comments.push_back(fb.CreateString("Chaser element set " + ch.sets[size_t(seg.ic)].comment + "; target element set " +
                                     tg.sets[size_t(seg.it)].comment + "."));
  if (seg.projection)
    comments.push_back(fb.CreateString("CONDITIONAL coast projection: both newest element sets held fixed, no maneuvers after " +
                                       isoMs(seg.samples.front().t) + "." +
                                       (settling ? " A newest element set is settling (issued within " + fmt(c.w.settle / 86400.0) +
                                                       " d after a maneuver bracket): the hindcast does not cover it." : std::string())));
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
      m.add_NORAD_CAT_ID(o->norad);
      out.push_back(m.Finish());
    }
  }
  return out;
}

Source sourceOfSegment(const Context& c, const Segment& seg) {
  return agreement(c.chaser->sets[size_t(seg.ic)].source, c.target->sets[size_t(seg.it)].source);
}

ocmTrajectoryBasis basisOf(const Segment& seg) { return seg.projection ? ocmTrajectoryBasis::PREDICTED : ocmTrajectoryBasis::DETERMINED; }

// The chaser's and the target's element sets behind a segment, in that order.
flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<OCMSeedSet>>> seedSets(flatbuffers::FlatBufferBuilder& fb, const Context& c,
                                                                                    const Segment& seg) {
  std::vector<flatbuffers::Offset<OCMSeedSet>> out;
  for (const auto& [o, i] : {std::pair{c.chaser, seg.ic}, std::pair{c.target, seg.it}}) {
    const auto epoch = fb.CreateString(isoMs(o->sets[size_t(i)].epoch));
    OCMSeedSetBuilder b(fb);
    b.add_NORAD_CAT_ID(o->norad);
    b.add_EPOCH(epoch);
    out.push_back(b.Finish());
  }
  return fb.CreateVector(out);
}

// Identifier of the hindcast evidence: COV_CALIBRATION_REFERENCE and CVR EVIDENCE.
std::string hindcastReference(const ErrorModel& model) { return "analysis/rpo-history hindcast; error model " + model.id; }

flatbuffers::Offset<CVR> realismRecord(flatbuffers::FlatBufferBuilder& fb, const Context& c, const ErrorModel& model,
                                       const Hindcast& h, const Projection& p, const Source& lineage) {
  const std::string regimes = "chaser " + model.regimeName(p.chaserRegime) + "; target " + model.regimeName(p.targetRegime);
  const auto modelId = fb.CreateString(model.id);
  const auto regime = fb.CreateString(regimes);
  const auto measured = fb.CreateString(lineage.lineage);
  const auto window = fb.CreateString(std::isfinite(h.first) ? isoMs(h.first) + "/" + isoMs(h.last) : std::string());
  const auto ev = fb.CreateString(hindcastReference(model));
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
  b.add_TRUTH_EPOCHS(uint32_t(h.truthEpochs));
  b.add_COVERAGE_1_SIGMA_AXIS1(h.fraction1(0));
  b.add_COVERAGE_1_SIGMA_AXIS2(h.fraction1(1));
  b.add_COVERAGE_1_SIGMA_AXIS3(h.fraction1(2));
  b.add_COVERAGE_3_SIGMA_AXIS1(h.fraction3(0));
  b.add_COVERAGE_3_SIGMA_AXIS2(h.fraction3(1));
  b.add_COVERAGE_3_SIGMA_AXIS3(h.fraction3(2));
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
  const auto meta = metadata(fb, c, seg, seg.projection && p.settling);
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
  const auto seeds = seedSets(fb, c, seg);
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
    calRef = fb.CreateString(hindcastReference(model));
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
  b.add_TRAJ_BASIS(basisOf(seg));
  b.add_SEED_SETS(seeds);
  return finishOcm(fb, b.Finish());
}

std::vector<uint8_t> geometryRecord(const Context& c, const Segment& seg, size_t index, bool settling) {
  flatbuffers::FlatBufferBuilder fb(1024 + seg.samples.size() * 21 * 8 + 2048);
  const std::string id = "RPO-GEOMETRY:" + c.chaser->key + ":" + c.target->key + ":" + (seg.projection ? "PROJECTION" : "HISTORY") + ":" +
                         std::to_string(index);
  const auto head = header(fb, c, id);
  const auto meta = metadata(fb, c, seg, settling);
  const auto column = [&](auto value) {
    std::vector<double> v;
    v.reserve(seg.samples.size());
    for (const Sample& s : seg.samples) v.push_back(value(s));
    return fb.CreateVector(v);
  };
  const auto roe = [&](double Roe::*m) { return column([m](const Sample& s) { return s.roe.ok ? s.roe.*m : kNaN; }); };
  const auto r = column([](const Sample& s) { return s.R; }), i = column([](const Sample& s) { return s.I; });
  const auto cc = column([](const Sample& s) { return s.C; }), iu = column([](const Sample& s) { return s.Iunwrapped; });
  const auto sep = column([](const Sample& s) { return s.separation; }), rr = column([](const Sample& s) { return s.rangeRate; });
  const auto plane = column([](const Sample& s) { return s.planeDeg; });
  const auto a = roe(&Roe::a), da = roe(&Roe::da), dl = roe(&Roe::dl);
  const auto dex = roe(&Roe::dex), dey = roe(&Roe::dey), dix = roe(&Roe::dix), diy = roe(&Roe::diy);
  const auto sr = column([](const Sample& s) { return s.sR; }), si = column([](const Sample& s) { return s.sI; });
  const auto sc = column([](const Sample& s) { return s.sC; }), ss = column([](const Sample& s) { return s.sSep; });
  const auto b3r = column([](const Sample& s) { return s.b3R; }), b3i = column([](const Sample& s) { return s.b3I; });
  const auto b3c = column([](const Sample& s) { return s.b3C; });
  OCMRelativeGeometryBuilder g(fb);
  g.add_R_KM(r);
  g.add_I_KM(i);
  g.add_C_KM(cc);
  g.add_I_UNWRAPPED_KM(iu);
  g.add_SEPARATION_KM(sep);
  g.add_RANGE_RATE_KM_S(rr);
  g.add_PLANE_ANGLE_DEG(plane);
  g.add_A_CHIEF_KM(a);
  g.add_DA(da);
  g.add_DLAMBDA(dl);
  g.add_DEX(dex);
  g.add_DEY(dey);
  g.add_DIX(dix);
  g.add_DIY(diy);
  g.add_SIGMA_R_KM(sr);
  g.add_SIGMA_I_KM(si);
  g.add_SIGMA_C_KM(sc);
  g.add_SIGMA_SEPARATION_KM(ss);
  g.add_BAND3_R_KM(b3r);
  g.add_BAND3_I_KM(b3i);
  g.add_BAND3_C_KM(b3c);
  const auto geometry = g.Finish();
  const auto center = fb.CreateString(centerName(*c.target));
  const auto frame = rtnFrame(fb);
  const auto pvn = encodeProvenance(fb, sourceOfSegment(c, seg));
  const auto seeds = seedSets(fb, c, seg);
  OCMBuilder b(fb);
  b.add_HEADER(head);
  b.add_METADATA(meta);
  b.add_STATE_STEP_SIZE(c.w.step);
  b.add_CENTER_NAME(center);
  b.add_TRAJ_REF_FRAME(frame);
  b.add_PROVENANCE(pvn);
  b.add_TRAJ_BASIS(basisOf(seg));
  b.add_SEED_SETS(seeds);
  b.add_RPO_GEOMETRY(geometry);
  return finishOcm(fb, b.Finish());
}

std::vector<uint8_t> realismOnly(const Context& c, const ErrorModel& model, const Hindcast& h, const Projection& p, const Source& lineage) {
  flatbuffers::FlatBufferBuilder fb(2048);
  const auto root = realismRecord(fb, c, model, h, p, lineage);
  FinishSizePrefixedCVRBuffer(fb, root);
  return std::vector<uint8_t>(fb.GetBufferPointer(), fb.GetBufferPointer() + fb.GetSize());
}
}  // namespace
