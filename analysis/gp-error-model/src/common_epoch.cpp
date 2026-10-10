// common_epoch: element sets of one object propagated by SGP4 to a common
// epoch, and each one's difference from an origin state there, in the
// origin's RTN axes (R radial, N orbit normal, T = N x R; prediction minus
// origin; km, km/s; GCRF). The origin is a reference state (independent
// truth), the mean of the propagated states, or one element set's own
// propagated state. Built in one translation unit after gp_error_model.cpp,
// whose element loading, reference verification, SGP4 propagation and frame
// rotation it uses.
//
// options.targets[]:
//   norad        the object
//   epoch        the target epoch, ISO 8601 UTC
//   afterSeconds with reference states: the target is the object's first
//                reference epoch in [epoch, epoch + afterSeconds] (0, the
//                default, means at epoch within 1 ms)
//   sets         the element sets to propagate, by epoch (ISO 8601 UTC,
//                matched within 1 s, the duplicate rule of accumulate)
//   origin       "reference" | "mean" | "set"
//   originSet    origin "set": that element set (by epoch); it need not be
//                among `sets`
// Each target reports its epoch, the origin state, and per set its epoch,
// age (target minus set epoch, days; negative for a set after the target)
// and RTN difference. Sets not found or not propagated are listed as missing;
// a target without its reference state carries `missing` and no sets.

namespace common {

struct RefState {
  Instant t;
  std::string text;
  double r[3], v[3];
};
using RefMap = std::map<uint32_t, std::vector<RefState>>;

// Every reference block's states per object, in time order; the first copy
// of an epoch (within 1 ms) in input order wins.
std::string load_states(RefMap* out) {
  using Lines = flatbuffers::Vector<flatbuffers::Offset<ephemerisDataLine>>;
  const std::string e = for_each_reference_block([&](uint32_t norad, const Lines& lines) -> std::string {
    auto& list = (*out)[norad];
    for (const ephemerisDataLine* l : lines) {
      RefState s;
      if (!parse_instant(l->EPOCH(), &s.t)) return "reference epoch is not ISO 8601 UTC.";
      s.text = l->EPOCH()->str();
      s.r[0] = l->X(); s.r[1] = l->Y(); s.r[2] = l->Z();
      s.v[0] = l->X_DOT(); s.v[1] = l->Y_DOT(); s.v[2] = l->Z_DOT();
      list.push_back(s);
    }
    return {};
  });
  if (!e.empty()) return e;
  for (auto& [norad, list] : *out) {
    std::stable_sort(list.begin(), list.end(), [](const RefState& a, const RefState& b) { return before(a.t, b.t); });
    std::vector<RefState> unique;
    unique.reserve(list.size());
    for (const RefState& s : list)
      if (unique.empty() || seconds_between(unique.back().t, s.t) > 1e-3) unique.push_back(s);
    list.swap(unique);
  }
  return {};
}

// The object's element set with this epoch (within 1 s), or null.
ElementSet* find_set(std::vector<ElementSet>& sets, uint32_t norad, const Instant& epoch) {
  auto it = std::lower_bound(sets.begin(), sets.end(), std::make_pair(norad, epoch),
                             [](const ElementSet& s, const std::pair<uint32_t, Instant>& k) {
                               return s.norad != k.first ? s.norad < k.first : seconds_between(s.epoch, k.second) >= 1.0;
                             });
  for (; it != sets.end() && it->norad == norad; ++it) {
    const double d = seconds_between(it->epoch, epoch);
    if (std::fabs(d) < 1.0) return &*it;
    if (d < 0) break;
  }
  return nullptr;
}

// SGP4's TEME state of a set at UTC instant t, in GCRF (rotation m: GCRF -> TEME at t).
bool gcrf_state_at(ElementSet& s, const Instant& t, const fr::Mat3& m, double rg[3], double vg[3]) {
  double r[3], v[3];
  if (!propagate(s, seconds_between(s.epoch, t) / 60.0, r, v)) return false;
  for (int a = 0; a < 3; ++a) {  // TEME -> GCRF: transpose of GCRF -> TEME
    rg[a] = m.m[0][a] * r[0] + m.m[1][a] * r[1] + m.m[2][a] * r[2];
    vg[a] = m.m[0][a] * v[0] + m.m[1][a] * v[1] + m.m[2][a] * v[2];
  }
  return true;
}

}  // namespace common

extern "C" int common_epoch() {
  using namespace common;
  const nlohmann::json opt = json_input("options");
  if (!opt.is_object() || !opt.contains("targets") || !opt["targets"].is_array())
    return fail("invalid-options", "options must be JSON with a targets array.");
  Options defaults;
  default_options(&defaults);
  Counts counts;
  std::vector<ElementSet> sets;
  if (!load_elements(defaults, sets, counts)) return fail("invalid-elements", error_text);
  RefMap refs;
  const bool have_reference = plugin_find_input_index("reference", 0) >= 0;
  if (have_reference) {
    const std::string e = load_states(&refs);
    if (!e.empty()) return fail("invalid-reference", e);
  }
  std::map<std::string, fr::Mat3> rotations;  // GCRF -> TEME per target epoch text
  nlohmann::json out = nlohmann::json::array();
  uint64_t missing_targets = 0, missing_sets = 0, differences = 0;
  for (const auto& target : opt["targets"]) {
    if (!target.is_object() || !target.contains("norad") || !target["norad"].is_number_unsigned() ||
        !target.contains("epoch") || !target["epoch"].is_string() || !target.contains("sets") ||
        !target["sets"].is_array())
      return fail("invalid-options", "each target needs norad, epoch and sets.");
    const uint32_t norad = target["norad"].get<uint32_t>();
    const std::string origin = target.value("origin", std::string("reference"));
    if (origin != "reference" && origin != "mean" && origin != "set")
      return fail("invalid-options", "origin is reference, mean or set.");
    Instant nominal;
    if (!parse_instant(target["epoch"].get<std::string>(), &nominal))
      return fail("invalid-options", "target epoch is not ISO 8601 UTC.");
    const double after = target.contains("afterSeconds") && target["afterSeconds"].is_number()
                             ? target["afterSeconds"].get<double>() : 0.0;
    nlohmann::json row{{"norad", norad}, {"origin", origin}};
    if (origin == "reference" && !have_reference)
      return fail("invalid-options", "origin reference needs reference states.");

    // The target instant: the first reference epoch in [nominal, nominal + after]
    // when reference states are given, else the nominal epoch.
    Instant t = nominal;
    std::string text = target["epoch"].get<std::string>();
    const RefState* ref = nullptr;
    if (have_reference) {
      const auto list = refs.find(norad);
      if (list != refs.end()) {
        const auto it = std::lower_bound(list->second.begin(), list->second.end(), nominal,
                                         [](const RefState& s, const Instant& k) { return seconds_between(s.t, k) > 1e-3; });
        if (it != list->second.end() && seconds_between(nominal, it->t) <= after + 1e-3) ref = &*it;
      }
      if (ref) {
        t = ref->t;
        text = ref->text;
      } else if (origin == "reference") {
        row["epoch"] = text;
        row["missing"] = "no reference state";
        ++missing_targets;
        out.push_back(row);
        continue;
      }
    }
    row["epoch"] = text;
    auto rot = rotations.find(text);
    if (rot == rotations.end()) {
      int ymdhm[5];
      double second;
      Instant check;
      if (!parse_instant(text, &check, ymdhm, &second)) return fail("invalid-options", "target epoch is not ISO 8601 UTC.");
      fr::EarthOrientation none;  // TEME <-> GCRF needs TT only; UT1 does not enter
      fr::Epoch e;
      if (!fr::epochFromUtc(ymdhm[0], ymdhm[1], ymdhm[2], ymdhm[3], ymdhm[4], second, none, &e))
        return fail("invalid-options", "target epoch outside the leap-second table.");
      rot = rotations.emplace(text, fr::gcrfToTeme(e)).first;
    }

    struct Prop {
      std::string epoch;
      double age_days;
      double r[3], v[3];
    };
    std::vector<Prop> props;
    nlohmann::json missing = nlohmann::json::array();
    for (const auto& id : target["sets"]) {
      Instant at;
      if (!id.is_string() || !parse_instant(id.get<std::string>(), &at))
        return fail("invalid-options", "set epochs are ISO 8601 UTC strings.");
      ElementSet* s = find_set(sets, norad, at);
      Prop p;
      if (!s || !gcrf_state_at(*s, t, rot->second, p.r, p.v)) {
        missing.push_back(id);
        ++missing_sets;
        continue;
      }
      p.epoch = s->epoch_text;
      p.age_days = seconds_between(s->epoch, t) / 86400.0;
      props.push_back(p);
    }

    double o_r[3] = {}, o_v[3] = {};
    if (origin == "reference") {
      std::copy(ref->r, ref->r + 3, o_r);
      std::copy(ref->v, ref->v + 3, o_v);
    } else if (origin == "mean") {
      if (props.empty()) {
        row["missing"] = "no propagated set for the mean";
        row["missingSets"] = missing;
        ++missing_targets;
        out.push_back(row);
        continue;
      }
      for (const Prop& p : props)
        for (int a = 0; a < 3; ++a) {
          o_r[a] += p.r[a] / props.size();
          o_v[a] += p.v[a] / props.size();
        }
    } else {
      Instant at;
      if (!target.contains("originSet") || !target["originSet"].is_string() ||
          !parse_instant(target["originSet"].get<std::string>(), &at))
        return fail("invalid-options", "origin set needs originSet, an ISO 8601 UTC epoch.");
      ElementSet* s = find_set(sets, norad, at);
      if (!s || !gcrf_state_at(*s, t, rot->second, o_r, o_v)) {
        row["missing"] = "origin set not found or not propagated";
        row["missingSets"] = missing;
        ++missing_targets;
        out.push_back(row);
        continue;
      }
      row["originSet"] = s->epoch_text;
    }
    row["state"] = {o_r[0], o_r[1], o_r[2], o_v[0], o_v[1], o_v[2]};
    nlohmann::json list = nlohmann::json::array();
    for (const Prop& p : props) {
      double x[6];
      rtn_error(p.r, p.v, o_r, o_v, x);
      list.push_back({{"epoch", p.epoch}, {"ageDays", p.age_days}, {"rtn", {x[0], x[1], x[2], x[3], x[4], x[5]}}});
      ++differences;
    }
    row["sets"] = list;
    if (!missing.empty()) row["missingSets"] = missing;
    out.push_back(row);
  }
  return emit("differences", {{"kind", "common-epoch"}, {"version", 1},
                              {"units", "km, km/s; GCRF; RTN axes of the origin state; prediction minus origin"},
                              {"counts", {{"elementSets", counts.records}, {"refused", counts.refused},
                                          {"duplicateEpochs", counts.duplicates}, {"targets", opt["targets"].size()},
                                          {"missingTargets", missing_targets}, {"missingSets", missing_sets},
                                          {"differences", differences}}},
                              {"targets", out}});
}
