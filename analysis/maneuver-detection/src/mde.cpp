// analysis/maneuver-detection: the typed outputs besides $MNV.
//
// The detectors keep their evidence as an in-memory tree while they run (the
// shape the reports always had); here it is written out as one $MDE (the
// detect, compare or score report arm) and the propagation queries as one
// $PRW WINDOW_REQUEST. Times become Unix milliseconds: every time in the tree
// is an isoMs string, a whole millisecond, so the conversion is exact.
// Numbers are the same doubles; an absent statistic is NaN, as $MDE defines.
namespace {

int64_t msOf(const Json& v) {
  double t;
  if (!v.is_string() || !parseIso(v.get_ref<const std::string&>().c_str(), t)) return 0;
  return static_cast<int64_t>(std::llround(t * 1000.0));
}
int64_t msOfIso(const std::string& s) {
  double t;
  return !s.empty() && parseIso(s.c_str(), t) ? static_cast<int64_t>(std::llround(t * 1000.0)) : 0;
}
double numOf(const Json& j, const char* key) {
  if (!j.is_object()) return kNaN;
  const auto it = j.find(key);
  return it != j.end() && it->is_number() ? it->get<double>() : kNaN;
}
uint32_t countOf(const Json& j, const char* key) {
  if (!j.is_object()) return 0;
  const auto it = j.find(key);
  return it != j.end() && it->is_number() ? static_cast<uint32_t>(it->get<double>()) : 0;
}
bool flagOf(const Json& j, const char* key) {
  if (!j.is_object()) return false;
  const auto it = j.find(key);
  return it != j.end() && it->is_boolean() && it->get<bool>();
}
std::string textOf(const Json& j, const char* key) {
  if (!j.is_object()) return std::string();
  const auto it = j.find(key);
  return it != j.end() && it->is_string() ? it->get<std::string>() : std::string();
}
const Json& at(const Json& j, const char* key) {
  static const Json none;
  if (!j.is_object()) return none;
  const auto it = j.find(key);
  return it != j.end() ? *it : none;
}
int64_t msAt(const Json& j, const char* key, size_t index) {
  const Json& v = at(j, key);
  return v.is_array() && v.size() > index ? msOf(v[index]) : 0;
}
flatbuffers::Offset<flatbuffers::String> stringOrNull(flatbuffers::FlatBufferBuilder& fb, const std::string& s) {
  return s.empty() ? flatbuffers::Offset<flatbuffers::String>() : fb.CreateString(s);
}

mdeDetector detectorOf(const std::string& d) {
  if (d == "D1") return mdeDetector::Crossing;
  if (d == "D2") return mdeDetector::LevelShift;
  if (d == "D3") return mdeDetector::RateChange;
  if (d == "C") return mdeDetector::Combined;
  return mdeDetector::Unspecified;
}
mdeTimeBasis timeBasisOf(const std::string& s) {
  return s == "crossing" ? mdeTimeBasis::Crossing : s == "gap" ? mdeTimeBasis::Gap : mdeTimeBasis::Unspecified;
}
maneuverCharacterization characterizationOf(const std::string& s) {
  for (int v = int(maneuverCharacterization::MIN); v <= int(maneuverCharacterization::MAX); ++v)
    if (s == EnumNamemaneuverCharacterization(maneuverCharacterization(v))) return maneuverCharacterization(v);
  return maneuverCharacterization::UNKNOWN;
}
maneuverStatus statusOf(const std::string& s) {
  for (int v = int(maneuverStatus::MIN); v <= int(maneuverStatus::MAX); ++v)
    if (s == EnumNamemaneuverStatus(maneuverStatus(v))) return maneuverStatus(v);
  return maneuverStatus::UNKNOWN;
}

// ── detect ──────────────────────────────────────────────────────────────────────
// One detector's evidence. D1 names its pair and span, D2 its gap and level
// statistics (in-track and/or plane), D3 its rate change; C the evidence of
// each component with the time it gave.
flatbuffers::Offset<MDEEvidence> evidenceOf(flatbuffers::FlatBufferBuilder& fb, const Json& ev, mdeDetector detector, int64_t timeMs) {
  std::vector<flatbuffers::Offset<MDEEvidence>> components;
  mdeDetector kept = mdeDetector::Unspecified;
  if (detector == mdeDetector::Combined) {
    components.push_back(evidenceOf(fb, at(ev, "D1"), mdeDetector::Crossing, msOf(at(ev, "D1_time"))));
    components.push_back(evidenceOf(fb, at(ev, "D2"), mdeDetector::LevelShift, msOf(at(ev, "D2_time"))));
    kept = detectorOf(textOf(ev, "kept"));
  }
  const auto componentsVec = components.empty() ? flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<MDEEvidence>>>()
                                                : fb.CreateVector(components);
  const char* span = ev.is_object() && ev.contains("span") ? "span" : "gap";
  const Json& pair = at(ev, "pair");
  MDEEvidenceBuilder b(fb);
  b.add_DETECTOR(detector);
  b.add_TIME_MS(timeMs);
  b.add_PAIR_INDEX(pair.is_number() ? pair.get<int32_t>() : -1);
  b.add_STEP_IN_TRACK_M_S(numOf(ev, "step_in_track_mps"));
  b.add_STEP_PLANE_M_S(numOf(ev, "step_plane_mps"));
  b.add_THRESHOLD_IN_TRACK_M_S(numOf(ev, "threshold_in_track_mps"));
  b.add_THRESHOLD_PLANE_M_S(numOf(ev, "threshold_plane_mps"));
  b.add_CROSSING_AT_EDGE(flagOf(ev, "crossing_at_edge"));
  b.add_SPAN_START_MS(msAt(ev, span, 0));
  b.add_SPAN_STOP_MS(msAt(ev, span, 1));
  b.add_GLR_STATISTIC(numOf(ev, "lambda"));
  b.add_STEP_M_S(numOf(ev, "step_mps"));
  b.add_STEP_SD_M_S(numOf(ev, "step_sd_mps"));
  b.add_SIGMA_M_S(numOf(ev, "sigma_mps"));
  b.add_TREND_M_S_PER_DAY(numOf(ev, "trend_mps_per_day"));
  b.add_OLD_LEVEL_SET_MS(msOf(at(ev, "old_level_set")));
  b.add_NEW_LEVEL_SET_MS(msOf(at(ev, "new_level_set")));
  b.add_TIME_BASIS(timeBasisOf(textOf(ev, "time_from")));
  b.add_PLANE_GLR_STATISTIC(numOf(ev, "plane_lambda"));
  b.add_PLANE_STEP_M_S(numOf(ev, "plane_step_mps"));
  b.add_RATE_CHANGE_M_S_PER_DAY(numOf(ev, "rate_change_mps_per_day"));
  b.add_RATE_CHANGE_SD(numOf(ev, "rate_change_sd"));
  b.add_TREND_BEFORE_M_S_PER_DAY(numOf(ev, "trend_before_mps_per_day"));
  if (!components.empty()) b.add_COMPONENTS(componentsVec);
  b.add_KEPT(kept);
  return b.Finish();
}

// One event; an emitted one names the $MNV it became (encodeEvent's ID).
flatbuffers::Offset<MDEEvent> eventOf(flatbuffers::FlatBufferBuilder& fb, const Json& e, const std::string& objectKey, bool emitted) {
  const std::string detector = textOf(e, "detector");
  const mdeDetector d = detectorOf(detector);
  const int64_t time = msOf(at(e, "time"));
  const auto evidence = evidenceOf(fb, at(e, "evidence"), d, 0);
  const auto mnvId = emitted ? fb.CreateString("MNV:" + objectKey + ":" + textOf(e, "time") + ":" + detector) : flatbuffers::Offset<flatbuffers::String>();
  const Json& blocks = at(e, "blocks");
  MDEEventBuilder b(fb);
  b.add_DETECTOR(d);
  b.add_TIME_MS(time);
  b.add_CHARACTERIZATION(characterizationOf(textOf(e, "characterization")));
  b.add_IN_TRACK_M_S(numOf(e, "in_track_mps"));
  b.add_CROSS_TRACK_M_S(numOf(e, "cross_track_mps"));
  b.add_IN_TRACK_FIRED(flagOf(e, "in_track_fired"));
  b.add_CROSS_TRACK_FIRED(flagOf(e, "cross_track_fired"));
  b.add_RAW_IN_TRACK_M_S(numOf(e, "raw_in_track_mps"));
  b.add_RAW_CROSS_TRACK_M_S(numOf(e, "raw_cross_track_mps"));
  b.add_DELTA_SMA_KM(numOf(e, "delta_sma_km"));
  b.add_SEPARATION_KM(numOf(e, "separation_km"));
  b.add_TIME_FROM_CROSSING(flagOf(e, "time_from_crossing"));
  if (blocks.is_array() && blocks.size() == 2) {
    b.add_BLOCK_BEFORE(blocks[0].get<uint32_t>());
    b.add_BLOCK_AFTER(blocks[1].get<uint32_t>());
  }
  b.add_EVIDENCE(evidence);
  b.add_ACCEL_CHANGE_M_S2(numOf(e, "accel_change_mps2"));
  if (emitted) b.add_MNV_ID(mnvId);
  return b.Finish();
}

flatbuffers::Offset<MDEDetectOptions> detectOptionsOf(flatbuffers::FlatBufferBuilder& fb, const Options& o) {
  std::vector<uint8_t> detectors;
  if (o.d1) detectors.push_back(uint8_t(mdeDetector::Crossing));
  if (o.d2) detectors.push_back(uint8_t(mdeDetector::LevelShift));
  if (o.d3) detectors.push_back(uint8_t(mdeDetector::RateChange));
  const auto list = fb.CreateVector(reinterpret_cast<const mdeDetector*>(detectors.data()), detectors.size());
  const auto port = stringOrNull(fb, o.propagatorPort);
  MDEDetectOptionsBuilder b(fb);
  b.add_DETECTORS(list);
  b.add_REPORT_TIME_MS(msOfIso(o.reportTime));
  if (!o.propagatorPort.empty()) b.add_PROPAGATOR_PORT_ID(port);
  b.add_REPORT_PAIRS(o.reportPairs);
  b.add_REPORT_LEVELS(o.reportLevels);
  b.add_K(o.k);
  b.add_FLOOR_IN_TRACK_M_S(o.floorInTrack);
  b.add_FLOOR_CROSS_TRACK_M_S(o.floorCrossTrack);
  b.add_MEDIAN_SETS(uint32_t(o.medianSets));
  b.add_SCALE_WINDOW_PAIRS(uint32_t(o.scaleWindow));
  b.add_GRID_STEP_S(o.gridStep);
  b.add_NEIGHBOUR_SETS(uint32_t(o.neighbours));
  b.add_GLR_SETS(uint32_t(o.glrSets));
  b.add_GLR_SPAN_DAYS(o.glrSpanDays);
  b.add_GLR_H(o.glrH);
  b.add_GLR_FLOOR_IN_TRACK_M_S(o.glrFloorInTrack);
  b.add_GLR_FLOOR_PLANE_RAD(o.glrFloorPlane);
  b.add_LT_H(o.ltH);
  b.add_LT_FLOOR_M_S_PER_DAY(o.ltFloor);
  b.add_LT_SPAN_DAYS(o.ltSpanDays);
  b.add_LT_SETS(uint32_t(o.ltSets));
  b.add_MERGE_HOURS(o.mergeHours);
  return b.Finish();
}

flatbuffers::Offset<MDEObjectDetection> objectDetectionOf(flatbuffers::FlatBufferBuilder& fb, const Json& obj) {
  const std::string key = textOf(obj, "object");
  std::vector<flatbuffers::Offset<MDECrossingPair>> pairs;
  for (const Json& p : at(obj, "pairs")) {
    MDECrossingPairBuilder b(fb);
    b.add_SPAN_START_MS(msAt(p, "span", 0));
    b.add_SPAN_STOP_MS(msAt(p, "span", 1));
    b.add_CROSSING_MS(msOf(at(p, "crossing")));
    b.add_CROSSING_AT_EDGE(flagOf(p, "crossing_at_edge"));
    b.add_SEPARATION_KM(numOf(p, "separation_km"));
    b.add_DELTA_SMA_KM(numOf(p, "delta_sma_km"));
    b.add_IN_TRACK_M_S(numOf(p, "in_track_mps"));
    b.add_PLANE_M_S(numOf(p, "plane_mps"));
    b.add_STEP_IN_TRACK_M_S(numOf(p, "step_in_track_mps"));
    b.add_STEP_PLANE_M_S(numOf(p, "step_plane_mps"));
    b.add_THRESHOLD_IN_TRACK_M_S(numOf(p, "threshold_in_track_mps"));
    b.add_THRESHOLD_PLANE_M_S(numOf(p, "threshold_plane_mps"));
    b.add_CANDIDATE(flagOf(p, "candidate"));
    pairs.push_back(b.Finish());
  }
  std::vector<flatbuffers::Offset<MDELevel>> levels;
  for (const Json& l : at(obj, "levels")) {
    std::vector<double> plane;
    for (const Json& x : at(l, "plane_mps")) plane.push_back(x.is_number() ? x.get<double>() : kNaN);
    const auto planeVec = fb.CreateVector(plane);
    MDELevelBuilder b(fb);
    b.add_SET_EPOCH_MS(msOf(at(l, "set")));
    b.add_SMA_KM(numOf(l, "sma_km"));
    b.add_LEVEL_M_S(numOf(l, "level_mps"));
    b.add_SIGMA_M_S(numOf(l, "sigma_mps"));
    b.add_PLANE_M_S(planeVec);
    b.add_PLANE_SIGMA_M_S(numOf(l, "plane_sigma_mps"));
    levels.push_back(b.Finish());
  }
  std::vector<flatbuffers::Offset<MDEEvent>> raised, emitted;
  for (const char* d : {"D1", "D2", "D3"})
    for (const Json& e : at(obj, d)) raised.push_back(eventOf(fb, e, key, false));
  for (const Json& e : at(obj, "events")) emitted.push_back(eventOf(fb, e, key, true));
  const auto keyOffset = fb.CreateString(key);
  const auto frame = stringOrNull(fb, textOf(obj, "frame"));
  const auto detail = stringOrNull(fb, textOf(obj, "detail"));
  const bool hasPairs = obj.contains("pairs"), hasLevels = obj.contains("levels");
  const auto pairsVec = hasPairs ? fb.CreateVector(pairs) : 0;
  const auto levelsVec = hasLevels ? fb.CreateVector(levels) : 0;
  const auto raisedVec = fb.CreateVector(raised);
  const auto emittedVec = fb.CreateVector(emitted);
  const std::string status = textOf(obj, "status");
  MDEObjectDetectionBuilder b(fb);
  b.add_OBJECT_KEY(keyOffset);
  b.add_NORAD_CAT_ID(countOf(obj, "norad_cat_id"));
  b.add_ELEMENT_SETS(countOf(obj, "element_sets"));
  if (!frame.IsNull()) b.add_FRAME(frame);
  b.add_STATUS(status == "screened" ? mdeObjectStatus::Screened : status == "insufficient-history" ? mdeObjectStatus::InsufficientHistory
                                                                                                   : mdeObjectStatus::Unspecified);
  if (!detail.IsNull()) b.add_DETAIL(detail);
  if (hasPairs) b.add_PAIRS(pairsVec);
  if (hasLevels) b.add_LEVELS(levelsVec);
  b.add_DETECTOR_EVENTS(raisedVec);
  b.add_EVENTS(emittedVec);
  return b.Finish();
}

// The detection report: options only when detection ran (as before).
std::vector<uint8_t> encodeDetectReport(const Json& report, const Options* options) {
  flatbuffers::FlatBufferBuilder fb(16384);
  std::vector<flatbuffers::Offset<MDEDuplicateEpoch>> duplicates;
  for (const Json& d : at(report, "duplicate_epochs")) {
    const auto key = fb.CreateString(textOf(d, "object"));
    MDEDuplicateEpochBuilder b(fb);
    b.add_OBJECT_KEY(key);
    b.add_EPOCH_MS(msOf(at(d, "epoch")));
    b.add_KEPT_RECORD(countOf(d, "kept_record"));
    b.add_DROPPED_RECORD(countOf(d, "dropped_record"));
    duplicates.push_back(b.Finish());
  }
  std::vector<flatbuffers::Offset<MDERefusedSet>> refused;
  for (const Json& r : at(report, "refused_sets")) {
    const auto key = fb.CreateString(textOf(r, "object"));
    const auto reason = fb.CreateString(textOf(r, "reason"));
    const Json& set = at(r, "set");
    MDERefusedSetBuilder b(fb);
    b.add_OBJECT_KEY(key);
    b.add_EPOCH_MS(msOf(at(r, "epoch")));
    b.add_SET_INDEX(set.is_number() ? set.get<int32_t>() : -1);
    b.add_REASON(reason);
    refused.push_back(b.Finish());
  }
  std::vector<flatbuffers::Offset<MDEObjectDetection>> objects;
  for (const Json& obj : at(report, "objects")) objects.push_back(objectDetectionOf(fb, obj));
  const auto opts = options ? detectOptionsOf(fb, *options) : 0;
  const auto duplicatesVec = report.contains("duplicate_epochs") ? fb.CreateVector(duplicates) : 0;
  const auto refusedVec = report.contains("refused_sets") ? fb.CreateVector(refused) : 0;
  const auto objectsVec = report.contains("objects") ? fb.CreateVector(objects) : 0;
  const std::string status = textOf(report, "status");
  MDEDetectReportBuilder b(fb);
  b.add_STATUS(status == "needs-propagation" ? mdeRunStatus::NeedsPropagation : status == "detected" ? mdeRunStatus::Detected : mdeRunStatus::Unspecified);
  b.add_QUERIES(countOf(report, "queries"));
  if (!duplicatesVec.IsNull()) b.add_DUPLICATE_EPOCHS(duplicatesVec);
  if (!opts.IsNull()) b.add_OPTIONS(opts);
  if (!objectsVec.IsNull()) b.add_OBJECTS(objectsVec);
  b.add_OBJECTS_SCREENED(countOf(report, "objects_screened"));
  if (!refusedVec.IsNull()) b.add_REFUSED_SETS(refusedVec);
  b.add_DETECTIONS(countOf(report, "detections"));
  const auto arm = b.Finish();
  MDEBuilder m(fb);
  m.add_DETECT_REPORT(arm);
  FinishMDEBuffer(fb, m.Finish());
  return std::vector<uint8_t>(fb.GetBufferPointer(), fb.GetBufferPointer() + fb.GetSize());
}

// ── compare ─────────────────────────────────────────────────────────────────────
std::vector<uint8_t> encodeCompareReport(const Json& report, const CompareOptions& o) {
  flatbuffers::FlatBufferBuilder fb(8192);
  std::vector<flatbuffers::Offset<MDEObjectComparison>> objects;
  for (const Json& obj : at(report, "objects")) {
    std::vector<flatbuffers::Offset<MDEVersionChange>> changes;
    for (const Json& c : at(obj, "changes")) {
      const auto older = stringOrNull(fb, textOf(c, "older"));
      const auto newer = stringOrNull(fb, textOf(c, "newer"));
      const auto within = stringOrNull(fb, textOf(c, "within"));
      const auto detail = stringOrNull(fb, textOf(c, "detail"));
      const std::string mode = textOf(c, "mode");
      MDEVersionChangeBuilder b(fb);
      if (!older.IsNull()) b.add_OLDER(older);
      if (!newer.IsNull()) b.add_NEWER(newer);
      if (!within.IsNull()) b.add_WITHIN(within);
      b.add_MODE(c.contains("within") ? mdeComparisonMode::WithinVersion
                 : mode == "none" ? mdeComparisonMode::NoComparison
                 : mode == "overlap" ? mdeComparisonMode::Overlap
                 : mode == "adjacent" ? mdeComparisonMode::Adjacent : mdeComparisonMode::Unspecified);
      if (!detail.IsNull()) b.add_DETAIL(detail);
      b.add_WINDOW_START_MS(msAt(c, "window", 0));
      b.add_WINDOW_STOP_MS(msAt(c, "window", 1));
      b.add_DELTA_SMA_KM(numOf(c, "delta_sma_km"));
      b.add_IN_TRACK_M_S(numOf(c, "in_track_mps"));
      b.add_CROSS_TRACK_M_S(numOf(c, "cross_track_mps"));
      b.add_GAP_S(numOf(c, "gap_s"));
      changes.push_back(b.Finish());
    }
    std::vector<flatbuffers::Offset<MDEPlannedCheck>> planned;
    for (const Json& p : at(obj, "planned")) {
      const auto id = fb.CreateString(textOf(p, "id"));
      const auto detail = stringOrNull(fb, textOf(p, "detail"));
      const auto pre = stringOrNull(fb, textOf(p, "pre"));
      const auto post = stringOrNull(fb, textOf(p, "post"));
      MDEPlannedCheckBuilder b(fb);
      b.add_ID(id);
      b.add_TIG_MS(msOf(at(p, "tig")));
      b.add_PLANNED_M_S(numOf(p, "planned_mps"));
      b.add_STATUS(statusOf(textOf(p, "status")));
      b.add_GROUP_START_MS(msAt(p, "group", 0));
      b.add_GROUP_STOP_MS(msAt(p, "group", 1));
      if (!detail.IsNull()) b.add_DETAIL(detail);
      if (!pre.IsNull()) b.add_PRE(pre);
      if (!post.IsNull()) b.add_POST(post);
      b.add_WINDOW_START_MS(msAt(p, "window", 0));
      b.add_WINDOW_STOP_MS(msAt(p, "window", 1));
      b.add_MODELED_DELTA_SMA_KM(numOf(p, "modeled_delta_sma_km"));
      b.add_POST_MINUS_PRE_SMA_KM(numOf(p, "post_minus_pre_sma_km"));
      b.add_EXECUTED_DELTA_SMA_KM(numOf(p, "executed_delta_sma_km"));
      b.add_EXECUTED_IN_TRACK_M_S(numOf(p, "executed_in_track_mps"));
      b.add_EXECUTED_CROSS_TRACK_M_S(numOf(p, "executed_cross_track_mps"));
      b.add_MODELED_CROSS_TRACK_M_S(numOf(p, "modeled_cross_track_mps"));
      b.add_POST_MINUS_PRE_CROSS_TRACK_M_S(numOf(p, "post_minus_pre_cross_track_mps"));
      planned.push_back(b.Finish());
    }
    const auto key = fb.CreateString(textOf(obj, "object"));
    const auto changesVec = fb.CreateVector(changes);
    const auto plannedVec = fb.CreateVector(planned);
    MDEObjectComparisonBuilder b(fb);
    b.add_OBJECT_KEY(key);
    b.add_VERSIONS(countOf(obj, "versions"));
    b.add_CHANGES(changesVec);
    b.add_PLANNED(plannedVec);
    objects.push_back(b.Finish());
  }
  MDECompareOptionsBuilder ob(fb);
  ob.add_REPORT_TIME_MS(msOfIso(o.reportTime));
  ob.add_WITHIN_VERSION(o.withinVersion);
  ob.add_MARGIN_S(o.margin);
  ob.add_POST_START_AFTER_S(o.postAfter);
  ob.add_EXECUTED_FRACTION(o.executedFraction);
  ob.add_CANCELLED_FRACTION(o.cancelledFraction);
  ob.add_UNPLANNED_THRESHOLD_KM(o.unplannedKm >= 0 ? o.unplannedKm : kNaN);
  const auto opts = ob.Finish();
  const auto objectsVec = fb.CreateVector(objects);
  MDECompareReportBuilder b(fb);
  b.add_OPTIONS(opts);
  b.add_OBJECTS(objectsVec);
  b.add_EXECUTED_COUNT(countOf(report, "executed"));
  b.add_CANCELLED_COUNT(countOf(report, "cancelled"));
  b.add_UNDECIDED_COUNT(countOf(report, "unknown"));
  b.add_UNPLANNED_CHANGE_COUNT(countOf(report, "unplanned_changes"));
  const auto arm = b.Finish();
  MDEBuilder m(fb);
  m.add_COMPARE_REPORT(arm);
  FinishMDEBuffer(fb, m.Finish());
  return std::vector<uint8_t>(fb.GetBufferPointer(), fb.GetBufferPointer() + fb.GetSize());
}

// ── score ───────────────────────────────────────────────────────────────────────
flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<MDEObjectSpan>>> spansOf(flatbuffers::FlatBufferBuilder& fb,
                                                                                   const std::vector<ScoreOptions::Interval>& list) {
  std::vector<flatbuffers::Offset<MDEObjectSpan>> out;
  for (const auto& i : list) {
    const auto key = fb.CreateString(i.key);
    MDEObjectSpanBuilder b(fb);
    b.add_OBJECT_KEY(key);
    b.add_FROM_MS(static_cast<int64_t>(std::llround(i.from * 1000.0)));
    b.add_TO_MS(static_cast<int64_t>(std::llround(i.to * 1000.0)));
    out.push_back(b.Finish());
  }
  return fb.CreateVector(out);
}
flatbuffers::Offset<MDEDistribution> distributionOf(flatbuffers::FlatBufferBuilder& fb, const Json& d) {
  if (!d.is_object()) return 0;
  MDEDistributionBuilder b(fb);
  b.add_COUNT(countOf(d, "n"));
  b.add_MEDIAN(numOf(d, "median"));
  b.add_P10(numOf(d, "p10"));
  b.add_P90(numOf(d, "p90"));
  return b.Finish();
}
double pairAt(const Json& j, const char* key, size_t index) {
  const Json& v = at(j, key);
  return v.is_array() && v.size() > index && v[index].is_number() ? v[index].get<double>() : kNaN;
}
flatbuffers::Offset<MDETruthMatch> truthMatchOf(flatbuffers::FlatBufferBuilder& fb, const Json& m) {
  const auto key = fb.CreateString(textOf(m, "object"));
  const auto id = fb.CreateString(textOf(m, "id"));
  const auto event = stringOrNull(fb, textOf(m, "event"));
  MDETruthMatchBuilder b(fb);
  b.add_OBJECT_KEY(key);
  b.add_ID(id);
  b.add_TIME_MS(msOf(at(m, "time")));
  b.add_DV_M_S(numOf(m, "dv_mps"));
  b.add_IN_TRACK_M_S(numOf(m, "in_track_mps"));
  if (!event.IsNull()) b.add_EVENT_ID(event);
  b.add_EVENT_TIME_MS(msOf(at(m, "event_time")));
  b.add_TIME_ERROR_S(numOf(m, "time_error_s"));
  b.add_EVENT_DV_M_S(numOf(m, "event_dv_mps"));
  b.add_EVENT_IN_TRACK_M_S(numOf(m, "event_in_track_mps"));
  b.add_DV_RATIO(numOf(m, "dv_ratio"));
  b.add_IN_TRACK_RATIO(numOf(m, "in_track_ratio"));
  return b.Finish();
}

std::vector<uint8_t> encodeScoreReport(const Json& report, const ScoreOptions& o) {
  flatbuffers::FlatBufferBuilder fb(8192);
  const auto bins = fb.CreateVector(o.bins);
  const auto explained = spansOf(fb, o.explained);
  const auto assessed = spansOf(fb, o.assessed);
  const auto spans = spansOf(fb, o.spans);
  MDEScoreOptionsBuilder ob(fb);
  ob.add_BEFORE_S(o.before);
  ob.add_AFTER_S(o.after);
  ob.add_BINS_M_S(bins);
  ob.add_EXPLAINED(explained);
  ob.add_ASSESSED(assessed);
  ob.add_SPANS(spans);
  const auto opts = ob.Finish();

  const Json& s = at(report, "summary");
  std::vector<flatbuffers::Offset<MDERecallBin>> byBin;
  for (const Json& r : at(s, "by_dv")) {
    MDERecallBinBuilder b(fb);
    b.add_FROM_M_S(numOf(r, "from_mps"));
    b.add_TO_M_S(at(r, "to_mps").is_number() ? at(r, "to_mps").get<double>() : std::numeric_limits<double>::infinity());
    b.add_TRUTH(countOf(r, "truth"));
    b.add_DETECTED(countOf(r, "detected"));
    b.add_RECALL(numOf(r, "recall"));
    b.add_WILSON95_LOW(pairAt(r, "wilson95", 0));
    b.add_WILSON95_HIGH(pairAt(r, "wilson95", 1));
    byBin.push_back(b.Finish());
  }
  const auto byBinVec = fb.CreateVector(byBin);
  const auto timeError = distributionOf(fb, at(s, "time_error_abs_s"));
  const auto dvRatio = distributionOf(fb, at(s, "dv_ratio"));
  const auto inTrackRatio = distributionOf(fb, at(s, "in_track_ratio"));
  MDEScoreSummaryBuilder sb(fb);
  sb.add_TRUTH(countOf(s, "truth"));
  sb.add_EVENTS(countOf(s, "events"));
  sb.add_DETECTED(countOf(s, "detected"));
  sb.add_RECALL(numOf(s, "recall"));
  sb.add_WILSON95_LOW(pairAt(s, "wilson95", 0));
  sb.add_WILSON95_HIGH(pairAt(s, "wilson95", 1));
  sb.add_BY_DELTA_V(byBinVec);
  if (!timeError.IsNull()) sb.add_TIME_ERROR_ABS_S(timeError);
  if (!dvRatio.IsNull()) sb.add_DV_RATIO(dvRatio);
  if (!inTrackRatio.IsNull()) sb.add_IN_TRACK_RATIO(inTrackRatio);
  sb.add_UNMATCHED_EVENTS(countOf(s, "unmatched_events"));
  sb.add_EXPLAINED(countOf(s, "explained"));
  sb.add_FALSE_ALARMS(countOf(s, "false_alarms"));
  sb.add_OBJECT_YEARS(numOf(s, "object_years"));
  sb.add_FALSE_ALARMS_PER_OBJECT_YEAR(numOf(s, "false_alarms_per_object_year"));
  const auto summary = sb.Finish();

  std::vector<flatbuffers::Offset<MDETruthMatch>> matches, missed;
  for (const Json& m : at(report, "matches")) matches.push_back(truthMatchOf(fb, m));
  for (const Json& m : at(report, "missed")) missed.push_back(truthMatchOf(fb, m));
  std::vector<flatbuffers::Offset<MDEUnmatchedEvent>> unmatched;
  for (const Json& u : at(report, "unmatched")) {
    const auto key = fb.CreateString(textOf(u, "object"));
    const auto id = fb.CreateString(textOf(u, "id"));
    MDEUnmatchedEventBuilder b(fb);
    b.add_OBJECT_KEY(key);
    b.add_ID(id);
    b.add_TIME_MS(msOf(at(u, "time")));
    b.add_DV_M_S(numOf(u, "dv_mps"));
    b.add_IN_TRACK_M_S(numOf(u, "in_track_mps"));
    b.add_CROSS_TRACK_M_S(numOf(u, "cross_track_mps"));
    b.add_EXPLAINED(flagOf(u, "explained"));
    b.add_ASSESSED(flagOf(u, "assessed"));
    unmatched.push_back(b.Finish());
  }
  const auto matchesVec = fb.CreateVector(matches);
  const auto missedVec = fb.CreateVector(missed);
  const auto unmatchedVec = fb.CreateVector(unmatched);
  MDEScoreReportBuilder b(fb);
  b.add_OPTIONS(opts);
  b.add_SUMMARY(summary);
  b.add_MATCHES(matchesVec);
  b.add_MISSED(missedVec);
  b.add_UNMATCHED(unmatchedVec);
  const auto arm = b.Finish();
  MDEBuilder m(fb);
  m.add_SCORE_REPORT(arm);
  FinishMDEBuffer(fb, m.Finish());
  return std::vector<uint8_t>(fb.GetBufferPointer(), fb.GetBufferPointer() + fb.GetSize());
}

// ── the propagator query port ───────────────────────────────────────────────────
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
  "UTC, km and km/s, Earth-centred inertial or Earth-fixed axes. A set the propagator refuses: an empty block whose COMMENT begins REFUSED.";

std::vector<uint8_t> encodeWindowRequest(const std::vector<Query>& queries, const std::string& portId, int neighbours) {
  flatbuffers::FlatBufferBuilder fb(1024 + queries.size() * 256);
  std::vector<flatbuffers::Offset<PRWWindowQuery>> list;
  for (const Query& q : queries) {
    const auto key = fb.CreateString(q.key);
    const auto objectId = stringOrNull(fb, q.objectId);
    const auto epoch = instantOf(fb, q.epoch);
    const auto start = instantOf(fb, q.start);
    const auto stop = instantOf(fb, q.stop);
    PRWWindowQueryBuilder b(fb);
    b.add_SEQUENCE(uint32_t(q.sequence));
    b.add_SET_INDEX(uint32_t(q.set));
    b.add_OBJECT_KEY(key);
    b.add_NORAD_CAT_ID(q.norad);
    if (!objectId.IsNull()) b.add_OBJECT_ID(objectId);
    b.add_SOURCE_EPOCH(epoch);
    b.add_START(start);
    b.add_STOP(stop);
    b.add_STEP_SECONDS(q.step);
    list.push_back(b.Finish());
  }
  const auto queriesVec = fb.CreateVector(list);
  const auto port = stringOrNull(fb, portId);
  const auto instructions = fb.CreateString(kWindowInstructions);
  PRWWindowRequestBuilder b(fb);
  b.add_QUERIES(queriesVec);
  if (!port.IsNull()) b.add_PROPAGATOR_PORT_ID(port);
  b.add_NEIGHBOUR_SETS(uint32_t(neighbours));
  b.add_INSTRUCTIONS(instructions);
  const auto arm = b.Finish();
  PRWBuilder m(fb);
  m.add_WINDOW_REQUEST(arm);
  FinishPRWBuffer(fb, m.Finish());
  return std::vector<uint8_t>(fb.GetBufferPointer(), fb.GetBufferPointer() + fb.GetSize());
}
}  // namespace
