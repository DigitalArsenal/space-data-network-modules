// analysis/maneuver-detection: the module's methods.
//
// detect_maneuvers    element sets ($OMM, through the propagator query port)
//                     or per-set trajectories ($OEM) -> $MNV DETECTED
// compare_ephemerides ephemeris versions ($OEM) and planned maneuvers ($MNV)
//                     -> $MNV EXECUTED / CANCELLED / UNKNOWN, version changes
// score_detections    detected $MNV against truth $MNV -> metrics
//
// Every report is one $MDE (src/mde.cpp); the propagation queries are one $PRW
// WINDOW_REQUEST.
namespace {

using Objects = std::map<std::string, std::vector<Block>>;

const char* portOf(const plugin_input_frame_t* frame) { return frame && frame->port_id ? frame->port_id : ""; }

// The node's configuration (plugin.getConfig: one ModuleConfig, MCFG) as the
// option object the option readers check, key by key: a String is a string, a
// Number a number, a Bool a boolean, a list an array and a TableList an array
// of objects. Nothing travels as JSON; the readers' validation is unchanged.
Json tableJson(const sdm_piv::ConfigEntries* entries) {
  Json out = Json::object();
  if (!entries) return out;
  for (const auto* e : *entries) {
    if (!e->KEY()) continue;
    const std::string key = e->KEY()->str();
    switch (e->KIND()) {
      case sdn::runtime::configValueKind_String: out[key] = e->STRING_VALUE() ? e->STRING_VALUE()->str() : std::string(); break;
      case sdn::runtime::configValueKind_Number: out[key] = e->NUMBER_VALUE(); break;
      case sdn::runtime::configValueKind_Bool: out[key] = e->BOOL_VALUE(); break;
      case sdn::runtime::configValueKind_StringList: {
        Json list = Json::array();
        if (e->STRINGS()) for (const auto* s : *e->STRINGS()) list.push_back(s ? s->str() : std::string());
        out[key] = list;
        break;
      }
      case sdn::runtime::configValueKind_NumberList: {
        Json list = Json::array();
        if (e->NUMBERS()) for (double x : *e->NUMBERS()) list.push_back(x);
        out[key] = list;
        break;
      }
      case sdn::runtime::configValueKind_TableList: {
        Json list = Json::array();
        if (e->TABLES()) for (const auto* t : *e->TABLES()) list.push_back(tableJson(t ? t->ENTRIES() : nullptr));
        out[key] = list;
        break;
      }
      default: break;
    }
  }
  return out;
}

bool readConfig(Json& out) {
  const sdm_piv::Config config = sdm_piv::get_config();
  if (!config.ok()) return failWith("plugin.getConfig failed: " + config.error_message());
  // The node's options are the `detect` table (keys `detect.*`): a flow shares one config across its nodes, each
  // module under its own prefix, so keys outside `detect` belong to other modules and are not read. Inside it the
  // option readers still refuse an unknown key, so a typo is caught.
  if (!config.has("detect")) { out = Json::object(); return true; }
  const sdm_piv::ConfigTable detect = config.table("detect");
  if (!detect) return failWith("Option detect must be one table (the module's options, keys detect.*)");
  out = tableJson(detect.entries());
  return true;
}

bool oemRoots(const plugin_input_frame_t* frame, std::vector<const OEM*>& out, const char* what) {
  return forEachRecord<OEM>(frame->payload, frame->payload_length, OEMIdentifier(), VerifyOEMBuffer, VerifySizePrefixedOEMBuffer,
                            GetOEM, GetSizePrefixedOEM, out, what);
}
bool ommRoots(const plugin_input_frame_t* frame, std::vector<const OMM*>& out) {
  return forEachRecord<OMM>(frame->payload, frame->payload_length, OMMIdentifier(), VerifyOMMBuffer, VerifySizePrefixedOMMBuffer,
                            GetOMM, GetSizePrefixedOMM, out, "element_sets");
}
bool ermRoots(const plugin_input_frame_t* frame, std::vector<const ERM*>& out) {
  return forEachRecord<ERM>(frame->payload, frame->payload_length, ERMIdentifier(), VerifyERMBuffer, VerifySizePrefixedERMBuffer,
                            GetERM, GetSizePrefixedERM, out, "error_model");
}
bool mnvRoots(const plugin_input_frame_t* frame, std::vector<const MNV*>& out, const char* what) {
  return forEachRecord<MNV>(frame->payload, frame->payload_length, MNVIdentifier(), VerifyMNVBuffer, VerifySizePrefixedMNVBuffer,
                            GetMNV, GetSizePrefixedMNV, out, what);
}

bool pushMde(const std::vector<uint8_t>& bytes) {
  return plugin_push_output_ex("report", "MDE.fbs", "$MDE", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "MDE", 0, 0,
                               bytes.data(), bytes.size()) >= 0;
}
bool pushPrw(const std::vector<uint8_t>& bytes) {
  return plugin_push_output_ex("propagation_requests", "PRW.fbs", "$PRW", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "PRW", 0, 0,
                               bytes.data(), bytes.size()) >= 0;
}
bool pushMnv(const std::vector<uint8_t>& bytes) {
  return plugin_push_output_ex("maneuvers", "MNV.fbs", "$MNV", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "MNV", 0, 0,
                               bytes.data(), bytes.size()) >= 0;
}

// ── detect_maneuvers ────────────────────────────────────────────────────────────
bool detect(Objects& objects, const std::string& creation, const Options& o, const ErrorModel& model, const Json& refused, Json& report,
            std::vector<std::vector<uint8_t>>& outputs) {
  const std::string reportTime = o.reportTime.empty() ? creation : o.reportTime;
  report["options"] = {{"detectors", Json::array()}, {"k", o.k}, {"floor_in_track_mps", o.floorInTrack}, {"floor_cross_track_mps", o.floorCrossTrack},
                       {"median_sets", o.medianSets}, {"scale_window_pairs", o.scaleWindow}, {"grid_step_s", o.gridStep},
                       {"neighbour_sets", o.neighbours}, {"glr_sets", o.glrSets}, {"glr_span_days", o.glrSpanDays}, {"glr_h", o.glrH},
                       {"glr_floor_in_track_mps", o.glrFloorInTrack}, {"glr_floor_plane_rad", o.glrFloorPlane},
                       {"lt_h", o.ltH}, {"lt_floor_mps_per_day", o.ltFloor}, {"lt_span_days", o.ltSpanDays}, {"lt_sets", o.ltSets},
                       {"merge_hours", o.mergeHours}};
  if (o.d1) report["options"]["detectors"].push_back("D1");
  if (o.d2) report["options"]["detectors"].push_back("D2");
  if (o.d3) report["options"]["detectors"].push_back("D3");
  if (!o.propagatorPort.empty()) report["propagator_port_id"] = o.propagatorPort;
  report["objects"] = Json::array();
  size_t detections = 0;
  for (auto& [key, blocks] : objects) {
    std::stable_sort(blocks.begin(), blocks.end(), [](const Block& a, const Block& b) { return a.mid() < b.mid(); });
    for (size_t i = 1; i < blocks.size(); ++i)
      if (blocks[i].frame != blocks[0].frame) return failWith("All blocks of one object must use one reference frame (object " + key + ").");
    Json obj = {{"object", key}, {"norad_cat_id", blocks[0].norad}, {"element_sets", blocks.size()}, {"frame", blocks[0].frame}};
    TierOne d1;
    if (blocks.size() >= 2 && !runPairs(blocks, o, key, d1)) return false;
    runTierOne(blocks, o, d1);
    TierTwo d2;
    if (o.d2 || o.d3) runTierTwo(blocks, d1, o, d2);
    if (!d1.screened && d2.levels.t.size() < 6) {
      obj["status"] = "insufficient-history";
      obj["detail"] = "The detectors need at least 2 * median_sets + 1 element sets (D1) or 6 sets with whole revolutions (D2).";
      report["objects"].push_back(obj);
      continue;
    }
    obj["status"] = "screened";
    if (o.reportPairs) obj["pairs"] = pairsJson(d1);
    if (o.reportLevels) obj["levels"] = levelsJson(d2);
    Json d1Events = Json::array(), d2Events = Json::array(), d3Events = Json::array();
    for (const Event& e : d1.events) d1Events.push_back(eventJson(e));
    for (const Event& e : d2.events) d2Events.push_back(eventJson(e));
    for (const Event& e : d2.lowThrust) d3Events.push_back(eventJson(e));
    obj["D1"] = d1Events;
    obj["D2"] = d2Events;
    if (o.d3) obj["D3"] = d3Events;
    // The sources of the object's sets: the event names what they agree on.
    Source source = blocks[0].source;
    for (size_t i = 1; i < blocks.size(); ++i) source = agreement(source, blocks[i].source);
    std::vector<Event> chosen;
    if (o.d1 && o.d2) chosen = mergeEvents(d1.events, d2.events, o.mergeHours);
    else if (o.d1) chosen = d1.events;
    else if (o.d2) chosen = d2.events;
    if (o.d3) chosen.insert(chosen.end(), d2.lowThrust.begin(), d2.lowThrust.end());
    Json events = Json::array();
    for (Event& e : chosen) {
      // With an error model, each impulsive event is the impulse between its two sets: its time is the burn-time
      // posterior's mode and its states those of the two sets there.
      if (model.loaded && e.detector != "D3" && estimateImpulse(blocks[e.before], blocks[e.after], model, e.impulse)) {
        const Impulse& im = e.impulse;
        e.time = e.endTime = im.time;
        e.r0 = im.r0; e.v0 = im.v0; e.r1 = im.r1; e.v1 = im.v1;
        e.separation = norm(im.dpos);
      }
      EventContext pv;
      pv.key = key;
      pv.source = source;
      pv.norad = blocks[e.before].norad;
      pv.objectId = blocks[e.before].objectId;
      pv.reportTime = reportTime;
      pv.frame = blocks[e.before].frame;
      pv.propagatorPort = o.propagatorPort;
      pv.comment0 = blocks[e.before].comment;
      pv.comment1 = blocks[e.after].comment;
      outputs.push_back(encodeEvent(e, pv, maneuverStatus::DETECTED));
      events.push_back(eventJson(e));
      ++detections;
    }
    obj["events"] = events;
    report["objects"].push_back(obj);
  }
  report["objects_screened"] = objects.size();
  if (!refused.empty()) report["refused_sets"] = refused;
  report["detections"] = detections;
  return true;
}

int detectManeuvers() {
  Options options;
  {
    Json j;
    if (!readConfig(j) || !readOptions(j, options)) return fail(error);
  }
  std::vector<const OEM*> frames, answers;
  std::vector<const OMM*> sets;
  std::vector<const ERM*> models;
  bool sawPropagation = false;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* frame = plugin_get_input_frame(i);
    const std::string port = portOf(frame);
    if (port.empty()) return fail("An input frame has no port.");
    if (!frame->payload || frame->payload_length == 0) continue;
    if (port == "ephemerides") {
      if (!oemRoots(frame, frames, "ephemerides")) return fail(error);
    } else if (port == "element_sets") {
      if (!ommRoots(frame, sets)) return fail(error);
    } else if (port == "propagation") {
      sawPropagation = true;
      if (!oemRoots(frame, answers, "propagation")) return fail(error);
    } else if (port == "error_model") {
      if (!ermRoots(frame, models)) return fail(error);
    } else {
      return fail("Unknown input port.");
    }
  }
  if (frames.empty() && sets.empty()) return fail("At least one $OEM frame on ephemerides, or $OMM element sets on element_sets, is required.");
  if (sawPropagation && sets.empty()) return fail("Answers on propagation need the element sets they answer, on element_sets.");
  Objects objects;
  std::string creation;
  size_t blockCount = 0;
  Json refused = Json::array();
  Json report = Json::object();
  report["method"] = "detect_maneuvers";
  for (const OEM* oem : frames) {
    if (creation.empty() && oem->CREATION_DATE()) {
      double t;
      if (parseIso(oem->CREATION_DATE(), t)) creation = isoMs(t);
    }
    if (!oem->EPHEMERIS_DATA_BLOCK() || oem->EPHEMERIS_DATA_BLOCK()->size() == 0) return fail("An $OEM frame has no data blocks.");
    for (const auto* block : *oem->EPHEMERIS_DATA_BLOCK()) {
      if (++blockCount > kMaxBlocks) return fail("Too many ephemeris blocks in one request.");
      Block b;
      if (!loadBlock(block, b)) return fail(error);
      objects[b.key].push_back(std::move(b));
    }
  }
  if (!sets.empty()) {
    SetsByObject byObject;
    if (!loadElementSets(sets, byObject, report)) return fail(error);
    const std::vector<Query> queries = queriesFor(byObject, options.neighbours, options.gridStep);
    for (const auto& [key, list] : byObject)
      if (list.size() < 2) refused.push_back({{"object", key}, {"epoch", isoMs(list[0].epoch)}, {"reason", "a single element set"}});
    if (!sawPropagation) {
      report["status"] = "needs-propagation";
      report["queries"] = queries.size();
      if (!pushPrw(encodeWindowRequest(queries, options.propagatorPort, options.neighbours))) return 1;
      return pushMde(encodeDetectReport(report, nullptr)) ? 0 : 1;
    }
    std::vector<const ephemerisDataBlock*> blocks;
    for (const OEM* oem : answers) {
      if (creation.empty() && oem->CREATION_DATE()) {
        double t;
        if (parseIso(oem->CREATION_DATE(), t)) creation = isoMs(t);
      }
      if (oem->EPHEMERIS_DATA_BLOCK()) for (const auto* b : *oem->EPHEMERIS_DATA_BLOCK()) blocks.push_back(b);
    }
    if (!takeAnswers(queries, blocks, objects, blockCount, refused)) return fail(error);
  }
  ErrorModel model;
  if (!models.empty() && !loadErrorModel(models, model)) return fail(error);
  std::vector<std::vector<uint8_t>> outputs;
  report["status"] = "detected";
  if (!detect(objects, creation, options, model, refused, report, outputs)) return fail(error);
  if (!pushMde(encodeDetectReport(report, &options))) return 1;
  for (const auto& mnv : outputs) if (!pushMnv(mnv)) return 1;
  return 0;
}

// ── compare_ephemerides ─────────────────────────────────────────────────────────
bool plannedOf(const MNV* m, Planned& p) {
  p.norad = m->SAT_NO();
  p.objectId = m->ORIG_OBJECT_ID() ? m->ORIG_OBJECT_ID()->str() : "";
  p.key = objectKey(p.norad, p.objectId, "");
  if (p.key.empty()) return failWith("A planned $MNV names no object (SAT_NO or ORIG_OBJECT_ID).");
  p.id = m->ID() ? m->ID()->str() : "";
  if (!parseIso(m->EVENT_START_TIME(), p.tig)) return failWith("A planned $MNV has no valid EVENT_START_TIME (its TIG).");
  p.dv = std::fabs(m->DELTA_VEL()) * 1000.0;
  if (!(p.dv > 0)) return failWith("A planned $MNV needs DELTA_VEL above zero (km/s).");
  p.outOfPlane = m->DELTA_VEL_W() != 0.0;
  p.source = sourceOf(m->PROVENANCE());
  return true;
}

int compareEphemerides() {
  CompareOptions options;
  {
    Json j;
    if (!readConfig(j) || !readCompareOptions(j, options)) return fail(error);
  }
  Objects objects;
  std::map<std::string, std::vector<Planned>> planned;
  size_t blockCount = 0;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* frame = plugin_get_input_frame(i);
    const std::string port = portOf(frame);
    if (port.empty()) return fail("An input frame has no port.");
    if (!frame->payload || frame->payload_length == 0) continue;
    if (port == "versions") {
      std::vector<const OEM*> roots;
      if (!oemRoots(frame, roots, "versions")) return fail(error);
      for (const OEM* oem : roots) {
        double issued;
        if (!parseIso(oem->CREATION_DATE(), issued)) return fail("Every version ($OEM) needs CREATION_DATE, its issue time.");
        if (!oem->EPHEMERIS_DATA_BLOCK()) continue;
        std::map<std::string, int> seen;
        for (const auto* block : *oem->EPHEMERIS_DATA_BLOCK()) {
          if (++blockCount > kMaxBlocks) return fail("Too many ephemeris blocks in one request.");
          Block b;
          if (!loadBlock(block, b)) return fail(error);
          if (seen[b.key]++) return fail("A version holds two blocks of one object; send each segment as its own version.");
          b.issued = issued;
          objects[b.key].push_back(std::move(b));
        }
      }
    } else if (port == "planned") {
      std::vector<const MNV*> roots;
      if (!mnvRoots(frame, roots, "planned")) return fail(error);
      for (const MNV* m : roots) {
        Planned p;
        if (!plannedOf(m, p)) return fail(error);
        planned[p.key].push_back(p);
      }
    } else {
      return fail("Unknown input port.");
    }
  }
  if (objects.empty()) return fail("compare_ephemerides needs $OEM versions on versions.");
  for (auto& [key, versions] : objects)
    for (size_t i = 1; i < versions.size(); ++i)
      if (versions[i].frame != versions[0].frame) return fail("All versions of one object must use one reference frame.");
  Json report = {{"method", "compare_ephemerides"}};
  std::vector<std::vector<uint8_t>> outputs;
  if (!runCompare(objects, planned, options, outputs, report)) return fail(error);
  if (!pushMde(encodeCompareReport(report, options))) return 1;
  for (const auto& mnv : outputs) if (!pushMnv(mnv)) return 1;
  return 0;
}

// ── score_detections ─────────────────────────────────────────────────────────────
int scoreDetections() {
  ScoreOptions options;
  {
    Json j;
    if (!readConfig(j) || !readScoreOptions(j, options)) return fail(error);
  }
  std::vector<Scored> events, truth;
  bool sawTruth = false;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* frame = plugin_get_input_frame(i);
    const std::string port = portOf(frame);
    if (port.empty()) return fail("An input frame has no port.");
    if (!frame->payload || frame->payload_length == 0) continue;
    if (port == "detected" || port == "truth") {
      std::vector<const MNV*> roots;
      if (!mnvRoots(frame, roots, port.c_str())) return fail(error);
      for (const MNV* m : roots) {
        Scored s;
        if (!scoredOf(m, s, port.c_str())) return fail(error);
        (port == "truth" ? truth : events).push_back(s);
      }
      if (port == "truth") sawTruth = true;
    } else {
      return fail("Unknown input port.");
    }
  }
  if (!sawTruth) return fail("score_detections needs truth $MNV on truth.");
  Json report = {{"method", "score_detections"}, {"before_s", options.before}, {"after_s", options.after}};
  runScore(events, truth, options, report);
  return pushMde(encodeScoreReport(report, options)) ? 0 : 1;
}
}  // namespace

extern "C" int detect_maneuvers() { return detectManeuvers(); }
extern "C" int compare_ephemerides() { return compareEphemerides(); }
extern "C" int score_detections() { return scoreDetections(); }
