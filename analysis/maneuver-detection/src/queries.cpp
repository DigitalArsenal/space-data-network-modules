// analysis/maneuver-detection: the propagator query port.
//
// The module holds no propagator. Given element sets ($OMM), it asks for each
// set's trajectory, from its own epoch's neighbours two sets earlier to two
// sets later, on `propagation_requests`; the host routes every query to the
// propagator plugged into the caller's `propagator_port_id` (SGP4, FFM, an
// ABI provider) and replays the request with the answers on `propagation`
// ($OEM, one data block per query, in query order). The queries are a pure
// function of the element sets and options, so the replay is stateless and
// every runtime gives the same bytes.
namespace {

constexpr double kMuWgs72 = 398600.8, kReWgs72 = 6378.135;  // SGP4's WGS-72

// A set's mean altitude (km): SGP4's un-Kozai'd mean motion under WGS-72, the
// altitude analysis/gp-error-model places a set in a regime by; NaN when SGP4
// refuses the set.
double meanAltitudeOf(const OMM* omm, double epoch) {
  // SGP4: the SGP4/SDP4 base foundation/sgp4-str3 (WGS-72, improved mode), the epoch one Julian date; a set SGP4
  // refuses at its epoch has no altitude.
  const double days1950 = epoch / 86400.0 + 2440587.5 - 2433281.5;
  sdnap::Elements el{};
  el.epoch_jd_whole = days1950 + sdnap::kJd1950;
  el.xno = omm->MEAN_MOTION() * kTwoPi / 1440.0;
  el.eo = omm->ECCENTRICITY();
  el.xincl = omm->INCLINATION() / kDeg;
  el.xnodeo = omm->RA_OF_ASC_NODE() / kDeg;
  el.omegao = omm->ARG_OF_PERICENTER() / kDeg;
  el.xmo = omm->MEAN_ANOMALY() / kDeg;
  el.bstar = omm->BSTAR();
  sdnap::Sat sat;
  double r[3], v[3];
  if (sdnap::sat_init(el, sdnap::gravity_wgs72(), sat, sdnap::Sgp4Mode::kImproved) != sdnap::kPropOk ||
      sdnap::sat_propagate(sat, nullptr, 0.0, r, v) != sdnap::kPropOk)
    return kNaN;
  const double n = sat.xnodp / 60.0;
  return std::cbrt(kMuWgs72 / (n * n)) - kReWgs72;
}

struct ElementSet {
  std::string key, objectId, objectName, comment;
  Source source;
  uint32_t norad = 0;
  double epoch = 0;
  double meanAltitude = kNaN, meanEccentricity = kNaN;  // the set's regime coordinates (gp-error-model's)
  size_t record = 0;  // index of the $OMM record over all element_sets frames
};

struct Query {
  size_t sequence = 0, set = 0;
  std::string key;
  uint32_t norad = 0;
  std::string objectId, comment;
  Source source;
  double epoch = 0, start = 0, stop = 0, step = 0;
  double meanAltitude = kNaN, meanEccentricity = kNaN;
};

using SetsByObject = std::map<std::string, std::vector<ElementSet>>;

bool loadElementSets(const std::vector<const OMM*>& records, SetsByObject& objects, Json& report) {
  Json duplicates = Json::array();
  for (size_t i = 0; i < records.size(); ++i) {
    const OMM* omm = records[i];
    ElementSet s;
    s.record = i;
    s.norad = omm->NORAD_CAT_ID();
    s.objectId = omm->OBJECT_ID() ? omm->OBJECT_ID()->str() : "";
    s.objectName = omm->OBJECT_NAME() ? omm->OBJECT_NAME()->str() : "";
    if (s.norad == 0 && s.objectId.empty() && s.objectName.empty())
      return failWith("Element set " + std::to_string(i) + " names no object (NORAD_CAT_ID, OBJECT_ID or OBJECT_NAME).");
    if (!parseIso(omm->EPOCH(), s.epoch)) return failWith("Element set " + std::to_string(i) + " has no valid EPOCH (ISO 8601 UTC).");
    s.key = objectKey(s.norad, s.objectId, s.objectName);
    s.meanAltitude = meanAltitudeOf(omm, s.epoch);
    s.meanEccentricity = omm->ECCENTRICITY();
    s.source = sourceOf(omm->PROVENANCE());
    s.comment = "EPOCH " + isoMs(s.epoch) + (omm->COMMENT() && omm->COMMENT()->size() ? " " + omm->COMMENT()->str() : "");
    objects[s.key].push_back(s);
  }
  for (auto& [key, sets] : objects) {
    std::stable_sort(sets.begin(), sets.end(), [](const ElementSet& a, const ElementSet& b) { return a.epoch < b.epoch; });
    // One set per epoch: the later record wins (a reissue).
    std::vector<ElementSet> unique;
    for (const ElementSet& s : sets) {
      if (!unique.empty() && unique.back().epoch == s.epoch) {
        duplicates.push_back({{"object", key}, {"epoch", isoMs(s.epoch)}, {"kept_record", s.record}, {"dropped_record", unique.back().record}});
        unique.back() = s;
      } else {
        unique.push_back(s);
      }
    }
    sets = std::move(unique);
  }
  if (!duplicates.empty()) report["duplicate_epochs"] = duplicates;
  return true;
}

// One query per set of every object with at least two sets, in object then
// epoch order: the set's trajectory from the epoch `neighbours` sets earlier
// to the epoch `neighbours` sets later (clamped at the ends), sampled every
// `step` seconds from the start and at the stop.
std::vector<Query> queriesFor(const SetsByObject& objects, int neighbours, double step) {
  std::vector<Query> out;
  for (const auto& [key, sets] : objects) {
    if (sets.size() < 2) continue;
    for (size_t i = 0; i < sets.size(); ++i) {
      Query q;
      q.sequence = out.size();
      q.set = sets[i].record;
      q.key = key;
      q.norad = sets[i].norad;
      q.objectId = sets[i].objectId;
      q.comment = sets[i].comment;
      q.source = sets[i].source;
      q.epoch = sets[i].epoch;
      q.meanAltitude = sets[i].meanAltitude;
      q.meanEccentricity = sets[i].meanEccentricity;
      q.start = sets[i >= size_t(neighbours) ? i - neighbours : 0].epoch;
      q.stop = sets[std::min(sets.size() - 1, i + neighbours)].epoch;
      q.step = step;
      out.push_back(q);
    }
  }
  return out;
}

// The answer blocks against their queries: same object, the query's span
// covered, no sample gap wider than the step (1 ms and 1 % slack).
bool takeAnswers(const std::vector<Query>& queries, const std::vector<const ephemerisDataBlock*>& answers,
                 std::map<std::string, std::vector<Block>>& objects, size_t& blockCount, Json& refused) {
  if (answers.size() != queries.size())
    return failWith("The propagation port holds " + std::to_string(answers.size()) + " answer blocks for " +
                    std::to_string(queries.size()) + " queries; answer every query, in order.");
  for (size_t k = 0; k < queries.size(); ++k) {
    const Query& q = queries[k];
    const ephemerisDataBlock* a = answers[k];
    const std::string where = "Answer " + std::to_string(k) + " (" + q.key + ", set " + isoMs(q.epoch) + ")";
    if (isRefusal(a)) {
      refused.push_back({{"object", q.key}, {"epoch", isoMs(q.epoch)}, {"set", q.set}, {"reason", a->COMMENT()->str()}});
      continue;
    }
    Block b;
    if (!loadBlock(a, b)) return failWith(where + ": " + error);
    if (q.norad > 0 && b.norad > 0 && b.norad != q.norad)
      return failWith(where + " is for NORAD " + std::to_string(b.norad) + "; answers must follow the queries' order.");
    if (q.norad == 0 && !q.objectId.empty() && b.objectId != q.objectId)
      return failWith(where + " names another object; answers must follow the queries' order.");
    if (b.start() > q.start + 1e-3 || b.stop() < q.stop - 1e-3)
      return failWith(where + " does not cover its query's span " + isoMs(q.start) + " to " + isoMs(q.stop) + ".");
    for (size_t i = 1; i < b.t.size(); ++i)
      if (b.t[i] - b.t[i - 1] > q.step * 1.01 + 1e-3 && b.t[i] > q.start && b.t[i - 1] < q.stop)
        return failWith(where + " has a sample gap of " + std::to_string(b.t[i] - b.t[i - 1]) + " s; the query asks for " +
                        std::to_string(q.step) + " s or less.");
    if (++blockCount > kMaxBlocks) return failWith("Too many ephemeris blocks in one request.");
    b.key = q.key;
    b.norad = q.norad ? q.norad : b.norad;
    b.objectId = q.objectId.empty() ? b.objectId : q.objectId;
    b.epoch = q.epoch;
    b.meanAltitude = q.meanAltitude;
    b.meanEccentricity = q.meanEccentricity;
    b.comment = q.comment;
    b.source = q.source;
    objects[q.key].push_back(std::move(b));
  }
  return true;
}
}  // namespace
