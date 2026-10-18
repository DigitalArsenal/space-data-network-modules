// analysis/rpo-history: the module's method.
//
// characterize  the chaser's and the target's element sets ($OMM) ->
//               propagation_requests ($PRW WINDOW_REQUEST) on the first pass;
//               with the answers ($OEM on propagation), maneuver brackets
//               ($MNV, optional) and the GP error model ($ERM, optional):
//               relative ($OCM per segment), geometry ($OCM per segment)
//               and realism ($CVR, with an error model).
//
// Options are the node configuration's `rpo` table (keys rpo.*):
//   chaser, target       catalog number ("68762", "NORAD:68762") or OBJECT_ID / OBJECT_NAME (required)
//   start, stop          the history window, ISO 8601 UTC (default: the first epoch both objects have, the newest epoch of either)
//   step_seconds         sample grid, 1..3600 s (60)
//   projection_hours     conditional coast projection after stop, 0..240 h (24; 0 = none)
//   hindcast             test the projection covariance against later element sets (true when an error model is given)
//   calibration_days     with an error model: the bands at a time t are the model's times per-axis factors from the
//                        pair's own relative samples in [t - calibration_days, t) (14; 0 = the model's bands as they are)
//   settle_days          after a maneuver bracket, sets issued within this many days are settling (1; 0..10)
//   propagator_port_id   echoed in the request, for the host's routing
//   creation_date        the records' CREATION_DATE (default: stop)
namespace {

const char* portOf(const plugin_input_frame_t* frame) { return frame && frame->port_id ? frame->port_id : ""; }

struct Options {
  std::string chaser, target, propagatorPort, creation;
  double start = kNaN, stop = kNaN, step = 60, horizonHours = 24, calibrationDays = 14, settleDays = 1.0;
  bool hindcast = true, hindcastGiven = false;
};

bool readOptions(Options& o) {
  const sdm_piv::Config config = sdm_piv::get_config();
  if (!config.ok()) return failWith("plugin.getConfig failed: " + config.error_message());
  if (!config.has("rpo")) return failWith("Option table rpo is required (rpo.chaser, rpo.target).");
  const sdm_piv::ConfigTable t = config.table("rpo");
  if (!t) return failWith("Option rpo must be one table (keys rpo.*).");
  static const char* known[] = {"chaser", "target", "start", "stop", "step_seconds", "projection_hours", "hindcast",
                                "calibration_days", "settle_days", "propagator_port_id", "creation_date"};
  for (const auto* e : *t.entries()) {
    const std::string key = textOf(e->KEY());
    bool ok = false;
    for (const char* k : known) ok = ok || key == k;
    if (!ok) return failWith("Unknown option rpo." + key + ".");
  }
  o.chaser = std::string(t.string("chaser"));
  o.target = std::string(t.string("target"));
  if (o.chaser.empty() || o.target.empty()) return failWith("rpo.chaser and rpo.target are required (catalog number or OBJECT_ID).");
  if (t.has("start") && !parseIso(std::string(t.string("start")).c_str(), o.start)) return failWith("rpo.start must be ISO 8601 UTC.");
  if (t.has("stop") && !parseIso(std::string(t.string("stop")).c_str(), o.stop)) return failWith("rpo.stop must be ISO 8601 UTC.");
  if (t.has("calibration_days")) {
    o.calibrationDays = t.number("calibration_days", -1);
    if (!(o.calibrationDays >= 0 && o.calibrationDays <= 90)) return failWith("rpo.calibration_days must be from 0 to 90.");
  }
  if (t.has("step_seconds")) {
    o.step = t.number("step_seconds", -1);
    if (!(o.step >= 1 && o.step <= 3600)) return failWith("rpo.step_seconds must be from 1 to 3600.");
  }
  if (t.has("projection_hours")) {
    o.horizonHours = t.number("projection_hours", -1);
    if (!(o.horizonHours >= 0 && o.horizonHours <= 240)) return failWith("rpo.projection_hours must be from 0 to 240.");
  }
  if (t.has("settle_days")) {
    o.settleDays = t.number("settle_days", -1);
    if (!(o.settleDays >= 0 && o.settleDays <= 10)) return failWith("rpo.settle_days must be from 0 to 10.");
  }
  if (t.has("hindcast")) {
    if (t.kind("hindcast") != sdn::runtime::configValueKind_Bool) return failWith("rpo.hindcast must be true or false.");
    o.hindcast = t.boolean("hindcast");
    o.hindcastGiven = true;
  }
  o.propagatorPort = std::string(t.string("propagator_port_id"));
  if (t.has("creation_date")) {
    double c;
    if (!parseIso(std::string(t.string("creation_date")).c_str(), c)) return failWith("rpo.creation_date must be ISO 8601 UTC.");
    o.creation = isoMs(c);
  }
  return true;
}

bool pushRecords(const char* port, const char* schema, const char* ident, const char* root, const std::vector<std::vector<uint8_t>>& records) {
  std::vector<uint8_t> stream;
  for (const auto& r : records) stream.insert(stream.end(), r.begin(), r.end());
  if (stream.empty()) return true;
  return plugin_push_output_ex(port, schema, ident, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0, stream.data(), stream.size()) >= 0;
}

int characterizeRpo() {
  Options options;
  if (!readOptions(options)) return fail(error);
  std::vector<const OMM*> sets;
  std::vector<const OEM*> answers;
  std::vector<const MNV*> maneuvers;
  std::vector<const ERM*> models;
  bool sawPropagation = false;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* frame = plugin_get_input_frame(i);
    const std::string port = portOf(frame);
    if (port.empty()) return fail("An input frame has no port.");
    if (!frame->payload || frame->payload_length == 0) continue;
    bool ok = true;
    if (port == "element_sets")
      ok = forEachRecord<OMM>(frame->payload, frame->payload_length, OMMIdentifier(), VerifyOMMBuffer, VerifySizePrefixedOMMBuffer,
                              GetOMM, GetSizePrefixedOMM, sets, "element_sets");
    else if (port == "propagation") {
      sawPropagation = true;
      ok = forEachRecord<OEM>(frame->payload, frame->payload_length, OEMIdentifier(), VerifyOEMBuffer, VerifySizePrefixedOEMBuffer,
                              GetOEM, GetSizePrefixedOEM, answers, "propagation");
    } else if (port == "maneuvers")
      ok = forEachRecord<MNV>(frame->payload, frame->payload_length, MNVIdentifier(), VerifyMNVBuffer, VerifySizePrefixedMNVBuffer,
                              GetMNV, GetSizePrefixedMNV, maneuvers, "maneuvers");
    else if (port == "error_model")
      ok = forEachRecord<ERM>(frame->payload, frame->payload_length, ERMIdentifier(), VerifyERMBuffer, VerifySizePrefixedERMBuffer,
                              GetERM, GetSizePrefixedERM, models, "error_model");
    else
      return fail("Unknown input port.");
    if (!ok) return fail(error);
  }
  if (sets.empty()) return fail("Element sets ($OMM) on element_sets are required.");
  if (models.size() > 1) return fail("At most one $ERM model on error_model.");

  Object chaser, target;
  chaser.role = "chaser";
  target.role = "target";
  chaser.request = options.chaser;
  target.request = options.target;
  size_t others = 0;
  if (!loadElementSets(sets, chaser, target, others)) return fail(error);

  Window w;
  w.step = options.step;
  w.horizon = options.horizonHours * 3600.0;
  w.start = std::isfinite(options.start) ? options.start : std::max(chaser.sets.front().epoch, target.sets.front().epoch);
  w.stop = std::isfinite(options.stop) ? options.stop : std::max(chaser.sets.back().epoch, target.sets.back().epoch);
  if (!(w.stop > w.start)) return fail("rpo.stop must be after rpo.start (and the objects' element sets must overlap in time).");
  w.calibration = options.calibrationDays * 86400.0;
  w.settle = options.settleDays * 86400.0;
  if ((w.stop - w.start + w.horizon) / w.step > double(kMaxSamples)) return fail("The window holds too many samples; widen step_seconds.");
  ErrorModel model;
  if (!models.empty() && !loadErrorModel(models[0], model)) return fail(error);
  w.hindcast = options.hindcastGiven ? options.hindcast : model.present;

  const std::vector<Query> queries = queriesFor(chaser, target, w);
  if (queries.empty()) return fail("No element set of either object is in force inside the window.");
  if (!sawPropagation) {
    const auto request = encodeWindowRequest(queries, options.propagatorPort, w.step);
    return plugin_push_output_ex("propagation_requests", "PRW.fbs", "$PRW", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "PRW", 0, 0,
                                 request.data(), request.size()) >= 0 ? 0 : 1;
  }
  std::vector<const ephemerisDataBlock*> blocks;
  for (const OEM* oem : answers)
    if (oem->EPHEMERIS_DATA_BLOCK()) for (const auto* b : *oem->EPHEMERIS_DATA_BLOCK()) blocks.push_back(b);
  std::string frame;
  size_t refusedCount = 0;
  if (!takeAnswers(queries, blocks, frame, refusedCount)) return fail(error);
  size_t bracketsUsed = 0, bracketsIgnored = 0;
  if (!loadBrackets(maneuvers, chaser, target, bracketsUsed, bracketsIgnored)) return fail(error);

  const RelativeSamples rel = relativeSamples(chaser, target, w, model);
  Counts counts;
  std::vector<Segment> segments = history(chaser, target, w, counts);
  const Projection projection = project(chaser, target, w, model, rel);
  const Hindcast hc = hindcast(rel, w);

  Context c;
  c.chaser = &chaser;
  c.target = &target;
  c.w = w;
  c.creation = options.creation.empty() ? isoMs(w.stop) : options.creation;

  std::vector<const Segment*> all;
  for (const Segment& s : segments) all.push_back(&s);
  if (projection.made) all.push_back(&projection.segment);
  if (all.empty()) return fail("No supported sample in the window (every sample lies in a maneuver bracket or outside the answers).");

  std::vector<std::pair<std::string, std::string>> summary = {
    {"FRAME", frame},
    {"GRID_SAMPLES", std::to_string(counts.gridSamples)},
    {"SAMPLES_IN_BRACKETS", std::to_string(counts.inBracket)},
    {"SAMPLES_WITHOUT_SET", std::to_string(counts.noSet)},
    {"SAMPLES_UNSUPPORTED", std::to_string(counts.unsupported)},
    {"ELEMENT_SETS", "chaser " + std::to_string(chaser.sets.size()) + ", target " + std::to_string(target.sets.size()) +
                     ", other objects ignored " + std::to_string(others) + ", refused by the propagator " + std::to_string(refusedCount)},
    {"MANEUVER_BRACKETS", "used " + std::to_string(bracketsUsed) + ", ignored " + std::to_string(bracketsIgnored)},
    {"PROJECTION", projection.made ? "made, " + fmt(w.horizon / 3600.0) + " h, samples without covariance " +
                                         std::to_string(projection.withoutCovariance) +
                                         (projection.settling ? "; a newest element set is SETTLING (issued within " + fmt(options.settleDays) +
                                                                " d after a maneuver bracket): the bands are the model's, not calibrated for it" : "")
                                   : "not made: " + projection.reason},
  };
  if (model.present) {
    summary.push_back({"ERROR_MODEL", model.id + (model.basisText.empty() ? "" : " (" + model.basisText + ")")});
    if (w.calibration > 0) {
      const Factors& f = projection.factors;
      summary.push_back({"CALIBRATION_AT_STOP",
        std::string(f.fitted ? "fitted" : "NOT FITTED (too few samples: the model's bands as they are)") + " from " + std::to_string(f.samples) +
        " relative samples in the trailing " + fmt(options.calibrationDays) + " d; 1-sigma factors R,I,C " + fmt(f.one[0], "%.4f") + "," +
        fmt(f.one[1], "%.4f") + "," + fmt(f.one[2], "%.4f") + "; 3-sigma factors " + fmt(f.three[0], "%.4f") + "," + fmt(f.three[1], "%.4f") + "," +
        fmt(f.three[2], "%.4f")});
    }
    summary.push_back({"RELATIVE_SAMPLES", std::to_string(rel.list.size()) + " (left out: " + std::to_string(rel.skippedBracket) +
                                           " across brackets, " + std::to_string(rel.skippedSettling) + " settling sets, " +
                                           std::to_string(rel.outsideModel) + " outside the model)"});
    summary.push_back({"HINDCAST_SAMPLES", std::to_string(hc.samples)});
    summary.push_back({"HINDCAST_TRUTH_EPOCHS", std::to_string(hc.truthEpochs)});
    summary.push_back({"HINDCAST_INSIDE_1SIGMA_RIC", fmt(hc.fraction1(0), "%.4f") + "," + fmt(hc.fraction1(1), "%.4f") + "," + fmt(hc.fraction1(2), "%.4f")});
    summary.push_back({"HINDCAST_INSIDE_3SIGMA_RIC", fmt(hc.fraction3(0), "%.4f") + "," + fmt(hc.fraction3(1), "%.4f") + "," + fmt(hc.fraction3(2), "%.4f")});
    summary.push_back({"HINDCAST_MEAN_D2_OVER_3", fmt(hc.meanD2Over3(), "%.4f")});
    summary.push_back({"HINDCAST_COVERAGE_95", fmt(hc.coverage95(), "%.4f")});
    summary.push_back({"HINDCAST_FACTORS_NOT_FITTED", std::to_string(hc.unfitted)});
  }

  std::vector<std::vector<uint8_t>> relative, geometryRecords;
  for (size_t i = 0; i < all.size(); ++i) {
    const Segment& s = *all[i];
    // Brackets that close after the previous record's end and by this one's start ride on this record; the last
    // record also takes any that close later.
    const double from = i == 0 ? -INFINITY : all[i - 1]->samples.back().t;
    const double to = i + 1 == all.size() ? INFINITY : s.samples.front().t;
    relative.push_back(relativeRecord(c, s, i, from, to, model, hc, projection));
    geometryRecords.push_back(geometryRecord(c, s, i, i + 1 == all.size() ? summary : std::vector<std::pair<std::string, std::string>>{}));
  }
  if (!pushRecords("relative", "OCM.fbs", "$OCM", "OCM", relative)) return 1;
  if (!pushRecords("geometry", "OCM.fbs", "$OCM", "OCM", geometryRecords)) return 1;
  if (model.present) {
    const Segment& s = projection.made ? projection.segment : *all.back();
    const auto cvr = realismOnly(c, model, hc, projection, sourceOfSegment(c, s));
    if (!pushRecords("realism", "CVR.fbs", "$CVR", "CVR", {cvr})) return 1;
  }
  return 0;
}
}  // namespace

extern "C" int characterize() { return characterizeRpo(); }
