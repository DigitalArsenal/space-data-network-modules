// analysis/maneuver-detection: compare_ephemerides, the operator check.
//
// Versions of one object's ephemeris (an operator's successive files, or a
// precise orbit's daily arcs) are compared in orbit-averaged energy and
// orbit normal:
// - consecutive versions: the newer version's first revolution against the
//   older version over the same revolution when the older covers it (the
//   newer orbit determination against the older forecast: executed minus
//   planned), else against the older version's last revolution (adjacent
//   arcs);
// - planned maneuvers ($MNV): the pre-burn version (the latest issued before
//   the TIG) models the burn as a step across the TIG; the post-burn version
//   is the first whose trajectory starts at least post_start_after_s after the
//   TIG, so all of it comes from orbit determination after the burn (a
//   version issued just after a TIG can be a re-issue still carrying the
//   plan). Executed = modelled step + (post - pre) over the post version's
//   first revolution.
namespace {

struct CompareOptions {
  double margin = 600.0;           // s around a TIG
  double postAfter = 3600.0;       // s
  double executedFraction = 0.5;
  double cancelledFraction = 0.25;
  double unplannedKm = -1;         // report version changes at least this large (km of SMA); off when < 0
  bool withinVersion = false;
  std::string reportTime;
};

bool readCompareOptions(const Json& j, CompareOptions& o) {
  NEED(j.is_object(), "Options must be a JSON object.");
  for (auto it = j.begin(); it != j.end(); ++it) {
    const std::string& key = it.key();
    const Json& v = it.value();
    const char* k = key.c_str();
    bool ok = true;
    if (key == "report_time") {
      double t;
      NEED(v.is_string() && parseIso(v.get<std::string>().c_str(), t), "report_time must be an ISO 8601 UTC timestamp.");
      o.reportTime = isoMs(t);
    } else if (key == "within_version") { NEED(v.is_boolean(), "within_version must be true or false."); o.withinVersion = v.get<bool>(); }
    else if (key == "margin_s") ok = readNumber(v, k, 0, 86400, o.margin);
    else if (key == "post_start_after_s") ok = readNumber(v, k, 0, 30 * 86400, o.postAfter);
    else if (key == "executed_fraction") ok = readNumber(v, k, 0, 10, o.executedFraction);
    else if (key == "cancelled_fraction") ok = readNumber(v, k, 0, 10, o.cancelledFraction);
    else if (key == "unplanned_threshold_km") ok = readNumber(v, k, 0, 1e5, o.unplannedKm);
    else return failWith("Unknown option: " + key);
    if (!ok) return false;
  }
  NEED(o.cancelledFraction <= o.executedFraction, "cancelled_fraction must not exceed executed_fraction.");
  return true;
}

struct Planned {
  std::string id, key, objectId;
  uint32_t norad = 0;
  double tig = 0, dv = 0;          // s, m/s
  bool outOfPlane = false;         // the plan states a cross-track component (DELTA_VEL_V)
};

double inTrackOf(double da, double a) { return std::sqrt(kMu / a) * da / (2.0 * a) * 1000.0; }

// Mean normals of different revolutions differ by the nodal regression
// between them. The rate comes from the two revolutions of one trajectory
// that end at `last` (its node longitude change over their mid-time span),
// and the earlier normal is turned about the pole by rate x dt.
double nodeOf(const Vec3& h) { return std::atan2(h[0], -h[1]); }
double nodeRate(const Block& b, const OrbitMean& last) {
  const OrbitMean prev = orbitMeanFrom(b, last.from, true);
  if (!prev.ok) return 0.0;
  double d = nodeOf(last.h) - nodeOf(prev.h);
  while (d > kPi) d -= kTwoPi;
  while (d < -kPi) d += kTwoPi;
  const double dt = 0.5 * (last.from + last.to) - 0.5 * (prev.from + prev.to);
  return dt > 0 ? d / dt : 0.0;
}
Vec3 precess(const Vec3& h, double rate, double dt) {
  const double c = std::cos(rate * dt), s = std::sin(rate * dt);
  return {c * h[0] - s * h[1], s * h[0] + c * h[1], h[2]};
}
// The normal change from revolution `a` (of trajectory b) to revolution `c`
// later, less the nodal regression between them.
Vec3 normalChange(const Block& b, const OrbitMean& a, const OrbitMean& c) {
  const double dt = 0.5 * (c.from + c.to) - 0.5 * (a.from + a.to);
  return sub(c.h, precess(a.h, nodeRate(b, a), dt));
}

// The cross-track delta-V of a change of mean normal dh at the state (r, v).
double crossTrackOfNormal(const Vec3& dh, const Vec3& r, const Vec3& v) { return crossTrackOf(scale(dh, norm(v) * 1000.0), r, v); }

struct VersionChange {
  size_t older = 0, newer = 0;
  std::string mode;
  OrbitMean wOld, wNew;
  double da = 0, inTrack = 0, crossTrack = 0, gap = 0;
  double from = 0, to = 0;          // when the change happened
};

bool compareVersions(const Block& a, const Block& b, VersionChange& c) {
  c.wNew = orbitMeanFrom(b, b.start(), false);
  if (!c.wNew.ok) return false;
  c.wOld = orbitMeanSame(a, c.wNew);
  if (c.wOld.ok) {
    c.mode = "overlap";
    c.from = std::isfinite(a.issued) ? std::min(a.issued, c.wNew.from) : a.start();
    c.to = c.wNew.to;
  } else {
    c.wOld = orbitMeanFrom(a, a.stop(), true);
    if (!c.wOld.ok) return false;
    c.mode = "adjacent";
    c.gap = b.start() - a.stop();
    c.from = c.wOld.from;
    c.to = c.wNew.to;
  }
  c.da = c.wNew.a - c.wOld.a;
  c.inTrack = inTrackOf(c.da, c.wOld.a);
  Vec3 r, v;
  sample(b, c.wNew.from, r, v);
  c.crossTrack = crossTrackOfNormal(c.mode == "overlap" ? sub(c.wNew.h, c.wOld.h) : sub(c.wNew.h, precess(c.wOld.h, nodeRate(a, c.wOld),
                                    0.5 * (c.wNew.from + c.wNew.to) - 0.5 * (c.wOld.from + c.wOld.to))), r, v);
  return true;
}

std::vector<uint8_t> encodeCheck(const Planned& p, maneuverStatus status, double inTrack, double crossTrack, const Vec3& r0, const Vec3& v0,
                                 const Vec3& r1, const Vec3& v1, const std::string& description, const std::vector<std::string>& sources,
                                 const std::string& reportTime, double start, double end, const std::string& idSuffix) {
  flatbuffers::FlatBufferBuilder fb(4096);
  const auto id = fb.CreateString((p.id.empty() ? "MNV:" + p.key + ":" + isoMs(start) : p.id) + idSuffix);
  const auto objectId = p.objectId.empty() ? 0 : fb.CreateString(p.objectId).o;
  const auto reportOffset = reportTime.empty() ? 0 : fb.CreateString(reportTime).o;
  const auto s = fb.CreateString(isoMs(start));
  const auto e = fb.CreateString(isoMs(end));
  const auto preState = stateTable(fb, r0, v0);
  const auto postState = stateTable(fb, r1, v1);
  const auto algorithm = fb.CreateString("com.digitalarsenal.analysis.maneuver-detection 0.3.0 compare_ephemerides: orbit-averaged energy and orbit normal of successive ephemeris versions");
  const auto text = fb.CreateString(description);
  std::vector<flatbuffers::Offset<flatbuffers::String>> sourced;
  for (const std::string& x : sources) sourced.push_back(fb.CreateString(x));
  const auto sourcedData = fb.CreateVector(sourced);
  const auto sourcedTypes = fb.CreateString("OEM");
  const Elements pre = elementsOf(r0, v0);
  const bool geo = pre.period > 1300.0 && pre.period < 1600.0 && pre.ecc < 0.05;
  maneuverCharacterization kind = maneuverCharacterization::UNKNOWN;
  if (status != maneuverStatus::CANCELLED) {
    if (geo) kind = maneuverCharacterization::STATION_KEEPING;
    else if (std::fabs(crossTrack) > 0.5 * std::fabs(inTrack) && std::fabs(inTrack) > 0.5 * std::fabs(crossTrack)) kind = maneuverCharacterization::COMBINED;
    else if (std::fabs(crossTrack) > std::fabs(inTrack)) kind = maneuverCharacterization::OUT_OF_PLANE;
    else kind = inTrack > 0 ? maneuverCharacterization::ORBIT_RAISING : maneuverCharacterization::ORBIT_LOWERING;
  }
  MNVBuilder b(fb);
  b.add_ID(id);
  if (p.norad) b.add_SAT_NO(p.norad);
  if (objectId) b.add_ORIG_OBJECT_ID(flatbuffers::Offset<flatbuffers::String>(objectId));
  b.add_STATUS(status);
  b.add_CHARACTERIZATION(kind);
  if (reportOffset) b.add_REPORT_TIME(flatbuffers::Offset<flatbuffers::String>(reportOffset));
  b.add_EVENT_START_TIME(s);
  b.add_EVENT_END_TIME(e);
  b.add_UCT(false);
  b.add_DELTA_VEL(std::hypot(inTrack, crossTrack) / 1000.0);
  b.add_DELTA_VEL_U(inTrack / 1000.0);
  b.add_DELTA_VEL_V(crossTrack / 1000.0);
  b.add_DELTA_VEL_W(0.0);
  b.add_PRE_EVENT(preState);
  b.add_POST_EVENT(postState);
  b.add_DESCRIPTION(text);
  b.add_ALGORITHM(algorithm);
  b.add_SOURCED_DATA(sourcedData);
  b.add_SOURCED_DATA_TYPES(sourcedTypes);
  FinishMNVBuffer(fb, b.Finish());
  return std::vector<uint8_t>(fb.GetBufferPointer(), fb.GetBufferPointer() + fb.GetSize());
}

std::string versionName(const Block& b) {
  return "version issued " + (std::isfinite(b.issued) ? isoMs(b.issued) : std::string("?")) + ", " + isoMs(b.start()) + " to " + isoMs(b.stop()) +
         (b.comment.empty() ? "" : " (" + b.comment + ")");
}

bool runCompare(std::map<std::string, std::vector<Block>>& objects, std::map<std::string, std::vector<Planned>>& planned,
                const CompareOptions& o, std::vector<std::vector<uint8_t>>& outputs, Json& report) {
  report["objects"] = Json::array();
  size_t executed = 0, cancelled = 0, unknown = 0, unplanned = 0;
  for (auto& [key, versions] : objects) {
    std::stable_sort(versions.begin(), versions.end(), [](const Block& a, const Block& b) {
      return a.issued != b.issued ? a.issued < b.issued : a.start() < b.start();
    });
    Json obj = {{"object", key}, {"versions", versions.size()}, {"changes", Json::array()}, {"planned", Json::array()}};
    std::vector<Planned>& plans = planned[key];
    std::stable_sort(plans.begin(), plans.end(), [](const Planned& a, const Planned& b) { return a.tig < b.tig; });
    // Consecutive versions.
    for (size_t i = 0; i + 1 < versions.size(); ++i) {
      VersionChange c;
      c.older = i;
      c.newer = i + 1;
      if (!compareVersions(versions[i], versions[i + 1], c)) {
        obj["changes"].push_back({{"older", versionName(versions[i])}, {"newer", versionName(versions[i + 1])}, {"mode", "none"},
                                  {"detail", "no whole revolution to compare"}});
        continue;
      }
      obj["changes"].push_back({{"older", versionName(versions[i])}, {"newer", versionName(versions[i + 1])}, {"mode", c.mode},
                                {"window", {isoMs(c.wNew.from), isoMs(c.wNew.to)}}, {"delta_sma_km", c.da}, {"in_track_mps", c.inTrack},
                                {"cross_track_mps", c.crossTrack}, {"gap_s", c.gap}});
      bool explained = false;
      for (const Planned& p : plans) if (p.tig >= c.from && p.tig <= c.to) explained = true;
      if (o.unplannedKm >= 0 && std::fabs(c.da) >= o.unplannedKm && !explained) {
        Planned p;
        p.key = key; p.norad = versions[i].norad; p.objectId = versions[i].objectId;
        Vec3 r0, v0, r1, v1;
        sample(versions[i], std::min(std::max(c.wOld.from, versions[i].start()), versions[i].stop()), r0, v0);
        sample(versions[i + 1], c.wNew.from, r1, v1);
        outputs.push_back(encodeCheck(p, maneuverStatus::DETECTED, c.inTrack, c.crossTrack, r0, v0, r1, v1,
          "Change between successive ephemeris versions (" + c.mode + "): orbit-averaged SMA " + std::to_string(c.da) +
          " km; it happened between EVENT_START_TIME and EVENT_END_TIME.", {versionName(versions[i]), versionName(versions[i + 1])},
          o.reportTime, c.from, c.to, ":versions"));
        ++unplanned;
      }
    }
    // Revolutions within each version.
    if (o.withinVersion && o.unplannedKm >= 0) {
      for (const Block& b : versions) {
        OrbitMean prev = orbitMeanFrom(b, b.start(), false);
        while (prev.ok) {
          const OrbitMean next = orbitMeanFrom(b, prev.to, false);
          if (!next.ok) break;
          const double da = next.a - prev.a;
          if (std::fabs(da) >= o.unplannedKm) {
            Planned p;
            p.key = key; p.norad = b.norad; p.objectId = b.objectId;
            Vec3 r0, v0, r1, v1;
            sample(b, prev.from, r0, v0);
            sample(b, next.from, r1, v1);
            Vec3 r, v;
            sample(b, next.from, r, v);
            const double cross = crossTrackOfNormal(normalChange(b, prev, next), r, v);
            outputs.push_back(encodeCheck(p, maneuverStatus::DETECTED, inTrackOf(da, prev.a), cross, r0, v0, r1, v1,
              "Change between consecutive revolutions of one ephemeris version: orbit-averaged SMA " + std::to_string(da) + " km.",
              {versionName(b)}, o.reportTime, prev.from, next.to, ":within"));
            obj["changes"].push_back({{"within", versionName(b)}, {"window", {isoMs(prev.from), isoMs(next.to)}}, {"delta_sma_km", da}});
            ++unplanned;
          }
          prev = next;
        }
      }
    }
    // Planned maneuvers, in groups: burns with no clean post-burn version
    // between them (a two-burn sequence hours apart) are checked together, the
    // group's executed change shared out in proportion to the plan.
    for (size_t k = 0; k < plans.size();) {
      const Block* pre = nullptr;
      OrbitMean before;
      for (const Block& b : versions) {
        if (!(b.issued < plans[k].tig)) continue;
        const OrbitMean x = orbitMeanFrom(b, plans[k].tig - o.margin, true);
        if (x.ok) { pre = &b; before = x; }
      }
      size_t g = k;
      const Block* post = nullptr;
      OrbitMean after, w, wPre;
      for (; pre && g < plans.size() && g < k + 4; ++g) {
        after = orbitMeanFrom(*pre, plans[g].tig + o.margin, false);
        if (!after.ok) break;
        const double nextTig = g + 1 < plans.size() ? plans[g + 1].tig : std::numeric_limits<double>::infinity();
        for (const Block& b : versions) {
          if (b.start() < plans[g].tig + o.postAfter) continue;
          const OrbitMean x = orbitMeanFrom(b, b.start(), false);
          if (!x.ok || x.to > nextTig - o.margin) continue;
          const OrbitMean y = orbitMeanSame(*pre, x);
          if (!y.ok) continue;
          post = &b; w = x; wPre = y;
          break;
        }
        if (post) break;
      }
      if (!post) g = k;  // checked alone, as unknown
      double plannedSum = 0;
      for (size_t i = k; i <= g; ++i) plannedSum += plans[i].dv;
      double groupInTrack = 0, groupCross = 0, modeled = 0, delta = 0, modeledCross = 0, deltaCross = 0;
      maneuverStatus status = maneuverStatus::UNKNOWN;
      Vec3 r0{}, v0{}, r1{}, v1{};
      std::string detail;
      if (!pre) detail = "no version issued before the TIG covers it";
      else if (!post) detail = "no version starting after the TIG (with its first revolution before the next planned burn) overlaps the pre-burn version";
      if (pre) { sample(*pre, plans[k].tig, r0, v0); r1 = r0; v1 = v0; }
      if (post) {
        modeled = after.a - before.a;
        delta = w.a - wPre.a;
        const Vec3 dh = add(normalChange(*pre, before, after), sub(w.h, wPre.h));
        sample(*post, w.from, r1, v1);
        groupInTrack = inTrackOf(modeled + delta, before.a);
        groupCross = crossTrackOfNormal(dh, r0, v0);
        modeledCross = crossTrackOfNormal(normalChange(*pre, before, after), r0, v0);
        deltaCross = crossTrackOfNormal(sub(w.h, wPre.h), r0, v0);
        // The executed size along the plan: in-track only, unless a burn of the
        // group states a cross-track component. Across a TIG the mean normal
        // is compared over different revolutions, so the cross-track estimate
        // carries the error of the nodal-regression correction (a few tenths
        // of a m/s in LEO); an in-plane plan is not judged by it.
        bool outOfPlane = false;
        for (size_t i = k; i <= g; ++i) outOfPlane = outOfPlane || plans[i].outOfPlane;
        const double size = outOfPlane ? std::hypot(groupInTrack, groupCross) : std::fabs(groupInTrack);
        status = size >= o.executedFraction * plannedSum ? maneuverStatus::EXECUTED
               : size < o.cancelledFraction * plannedSum ? maneuverStatus::CANCELLED : maneuverStatus::UNKNOWN;
      }
      for (size_t i = k; i <= g; ++i) {
        const Planned& p = plans[i];
        const double share = plannedSum > 0 ? p.dv / plannedSum : 1.0 / double(g - k + 1);
        const double inTrack = groupInTrack * share, crossTrack = groupCross * share;
        Json row = {{"id", p.id}, {"tig", isoMs(p.tig)}, {"planned_mps", p.dv}, {"status", EnumNamemaneuverStatus(status)},
                    {"group", {isoMs(plans[k].tig), isoMs(plans[g].tig)}}};
        std::string description = "Planned " + std::to_string(p.dv) + " m/s at " + isoMs(p.tig) + ": ";
        if (!detail.empty()) { row["detail"] = detail; description += detail + "."; }
        if (pre) row["pre"] = versionName(*pre);
        if (post) {
          row["post"] = versionName(*post);
          row["window"] = {isoMs(w.from), isoMs(w.to)};
          row["modeled_delta_sma_km"] = modeled;
          row["post_minus_pre_sma_km"] = delta;
          row["executed_delta_sma_km"] = modeled + delta;
          row["executed_in_track_mps"] = inTrack;
          row["executed_cross_track_mps"] = crossTrack;
          row["modeled_cross_track_mps"] = modeledCross;
          row["post_minus_pre_cross_track_mps"] = deltaCross;
          description += "the pre-burn version models " + std::to_string(inTrackOf(modeled, before.a)) + " m/s in-track over the group of " +
                         std::to_string(g - k + 1) + " planned burn(s); the post-burn version's first revolution differs from it by " +
                         std::to_string(delta) + " km of SMA; this burn's share of the executed change is " + std::to_string(share) + ".";
        }
        if (status == maneuverStatus::EXECUTED) ++executed; else if (status == maneuverStatus::CANCELLED) ++cancelled; else ++unknown;
        std::vector<std::string> sources;
        if (pre) sources.push_back(versionName(*pre));
        if (post) sources.push_back(versionName(*post));
        outputs.push_back(encodeCheck(p, status, inTrack, crossTrack, r0, v0, r1, v1, description, sources, o.reportTime, p.tig, p.tig, ":check"));
        obj["planned"].push_back(row);
      }
      k = g + 1;
    }
    report["objects"].push_back(obj);
  }
  report["executed"] = executed;
  report["cancelled"] = cancelled;
  report["unknown"] = unknown;
  report["unplanned_changes"] = unplanned;
  return true;
}
}  // namespace
