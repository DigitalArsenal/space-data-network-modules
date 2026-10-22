// Per-object SGP4 history second moments, shrunk toward the population model.
// One translation unit, after source_products.cpp. All physics stays in C++.
namespace objectcov {
using Json = nlohmann::json;
using namespace covreal;
constexpr const char* kMethod = "empirical-history-shrunk";

struct Settings {
  double history_days = 30, max_age_days = 8, minimum_sets = 8, minimum_bin_sets = 12, shrinkage = 30;
};
std::string settings(Settings* s) {
  std::string error;
  const Json j = ermb::recipe_from_config("object", &error, false);
  if (!error.empty()) return error;
  for (auto [key, value] : {std::pair<const char*, double*>{"historyDays", &s->history_days},
                           {"maxAgeDays", &s->max_age_days}, {"minimumSets", &s->minimum_sets},
                           {"minimumBinSets", &s->minimum_bin_sets}, {"shrinkage", &s->shrinkage}}) {
    if (!j.contains(key)) continue;
    if (!j[key].is_number() || !std::isfinite(j[key].get<double>()) || j[key].get<double>() < 0)
      return std::string("object.") + key + " must be finite and non-negative.";
    *value = j[key].get<double>();
  }
  if (!(s->history_days > 0 && s->max_age_days > 0 && s->minimum_sets >= 1 && s->minimum_bin_sets >= 1) ||
      std::floor(s->minimum_sets) != s->minimum_sets || std::floor(s->minimum_bin_sets) != s->minimum_bin_sets)
    return "object historyDays/maxAgeDays must be positive; minimumSets/minimumBinSets must be positive integers.";
  return {};
}
// Strict size-prefixed streams, preserving frame and record order.
template<class Read>
std::string records(const char* port, Read read) {
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* f = plugin_get_input_frame(i);
    if (!f || !f->port_id || std::strcmp(f->port_id, port)) continue;
    for (size_t at = 0; at < f->payload_length;) {
      const size_t remaining = f->payload_length - at;
      if (remaining < 12) return "truncated size-prefixed $ERM stream";
      const auto* p = f->payload + at;
      const size_t len = flatbuffers::ReadScalar<uint32_t>(p);
      if (len > remaining - 4 || !flatbuffers::BufferHasIdentifier(p, ERMIdentifier(), true))
        return "invalid size-prefixed $ERM stream";
      const auto e = ermb::read_erm(p, len + 4);
      if (!e) return ermb::last_error;
      const std::string error = read(*e);
      if (!error.empty()) return error;
      at += len + 4;
    }
  }
  return {};
}
struct Pair { size_t older; std::array<double, 6> x; };
struct Bin {
  std::vector<Pair> pairs;
  std::array<double, 21> moment{};
  size_t sets = 0, samples = 0;
};
struct History { std::vector<Bin> bins; size_t older_sets = 0; double last_age = 0; };
History history(const std::vector<ElementSet>& sets, const ElementSet& anchor, const Options& options, const Settings& cfg) {
  History out;
  out.bins.resize(options.ages.size());
  std::vector<ElementSet> selected;
  for (const auto& s : sets) {
    const double age = seconds_between(s.epoch, anchor.epoch) / 86400.0;
    if (s.norad == anchor.norad && age >= 0 && age <= cfg.history_days) selected.push_back(s);
  }
  if (selected.size() > 200) selected.erase(selected.begin(), selected.end() - 200);
  out.older_sets = selected.empty() ? 0 : selected.size() - 1;
  const double max_age = std::min(cfg.max_age_days, options.ages.back().second);
  for (size_t j = 0; j < selected.size(); ++j) {
    for (size_t k = j + 1; k < selected.size(); ++k) {
      const double age_seconds = seconds_between(selected[j].epoch, selected[k].epoch);
      if (age_seconds < 1.0) continue;  // Republished sets are never residual pairs.
      const double age = age_seconds / 86400.0;
      if (age >= max_age) break;
      const int bin = age_of(options, age);
      if (bin < 0) continue;
      // A fresh record keeps SDP4 resonance integration independent of request ordering.
      ElementSet older = selected[j];
      double r[3], v[3];
      if (!propagate(older, age * 1440.0, r, v)) continue;
      Pair p{j, {}};
      rtn_error(r, v, selected[k].r, selected[k].v, p.x.data());
      if (!std::all_of(p.x.begin(), p.x.end(), [](double x) { return std::isfinite(x); })) continue;
      out.bins[bin].pairs.push_back(p);
      out.last_age = std::max(out.last_age, age);
    }
  }
  for (auto& bin : out.bins) {
    if (bin.pairs.empty()) continue;
    Stratum pooled;
    for (const auto& p : bin.pairs) add_sample(pooled, p.x.data(), nullptr, 0);
    std::array<double, 6> clip{};
    for (int c = 0; c < 3; ++c) {
      const auto q = histogram_quantiles(pooled, c);
      clip[c] = q[3]; clip[3 + c] = (q[4] - q[2]) / 2.0;
    }
    std::set<size_t> owners;
    for (const auto& p : bin.pairs) {
      if (!within_clip(p.x.data(), clip, 5)) continue;
      ++bin.samples;
      owners.insert(p.older);
      for (int a = 0, t = 0; a < 6; ++a)
        for (int b = 0; b <= a; ++b, ++t) bin.moment[t] += p.x[a] * p.x[b];
    }
    bin.sets = owners.size();
    if (bin.samples) for (double& x : bin.moment) x /= static_cast<double>(bin.samples);
  }
  return out;
}
}  // namespace objectcov

extern "C" int object_covariance() {
  using namespace objectcov;
  Settings cfg;
  std::string error = settings(&cfg);
  if (!error.empty()) return fail("invalid-config", error);
  Json chosen;
  error = records("models", [&](const ERMT& e) -> std::string {
    if (!e.MODEL || e.MODEL->FORM != ermModelForm::ElementSetModel) return "models requires the MODEL arm, form ElementSetModel.";
    if (chosen.is_null() || (!chosen.value("pooled", false) && e.MODEL->POOLED)) chosen = ermb::model_out(*e.MODEL);
    return {};
  });
  if (!error.empty()) return fail("invalid-models", error);
  sp::Model model;
  const bool has_model = !chosen.is_null();
  Options options;
  default_options(&options);
  if (has_model) {
    error = sp::read_model(chosen, &model);
    if (!error.empty()) return fail("invalid-models", error);
    options = model.sm.options;
  }
  Json requests = Json::array();
  error = records("request", [&](const ERMT& e) -> std::string {
    if (!e.CALIBRATED_COVARIANCES) return "request requires the CALIBRATED_COVARIANCES arm.";
    for (const auto& o : e.CALIBRATED_COVARIANCES->OBJECTS)
      requests.push_back({{"id", o->ID}, {"set", {{"norad", o->SET_NORAD_CAT_ID}, {"epoch", o->SET_EPOCH}}}, {"ageDays", o->AGE_DAYS}});
    return {};
  });
  if (!error.empty()) return fail("invalid-request", error);
  std::vector<ElementSet> sets;
  Counts counts;
  // Retain uncovered regimes so NO_SET and OUTSIDE remain distinct. Use the
  // standard one-second duplicate window; the last record in stream order wins.
  if (!load_elements(options, sets, counts, true)) return fail("invalid-elements", error_text);
  Json results = Json::array(), reports = Json::array();
  // Reuse one history fit for all prediction ages of the same set in this call.
  std::map<size_t, History> histories;
  for (const auto& o : requests) {
    const double age = json_number(o, "ageDays", NAN);
    const auto set = o.contains("set") ? o["set"] : Json::object();
    const std::string epoch = json_string(set, "epoch"), id = json_string(o, "id");
    Instant time;
    if (id.empty() || !parse_instant(epoch, &time) || !std::isfinite(age) || age < 0 || json_number(set, "norad", 0) <= 0)
      return fail("invalid-request", "each object needs ID, SET_NORAD_CAT_ID, SET_EPOCH (ISO UTC), and finite AGE_DAYS >= 0.");
    const auto norad = static_cast<uint32_t>(json_number(set, "norad", 0));
    // Either published epoch can name the retained set in force. Its epoch
    // anchors both the history window and the requested prediction age.
    const ElementSet* anchor = common::find_set(sets, norad, time);
    Json row{{"id", id}, {"cell", {{"ageIndex", -1}, {"ageDays", age}}}};
    Json notes = Json::array();
    auto note = [&](const std::string& reason) { notes.push_back({{"rule", 2}, {"reason", reason}}); };
    sp::Label label;
    label.method = kMethod; label.model_id = has_model ? model.id : "";
    label.age_days = age; label.scale = 0; label.calibration = "UNCALIBRATED";
    label.evidence = "empirical-history-shrunk: 5 robust sigma; minimumSets=8, minimumBinSets=12, shrinkage=30 defaults (object config may override).";
    std::string status;
    if (!anchor) { status = "NO_SET"; note("no set matching SET_NORAD_CAT_ID and SET_EPOCH"); }
    if (!has_model) { if (status.empty()) status = "NO_MODEL"; note("no model supplied for the population prior"); }
    if (status.empty()) {
      const int regime = anchor->regime, bin = age_of(options, age);
      label.age_index = bin;
      row["cell"]["ageIndex"] = bin;
      if (regime >= 0) { label.regime = options.regimes[regime].id; row["regime"] = label.regime; }
      std::vector<double> pop;
      double factor = 1;
      if (regime < 0 || bin < 0) { status = "OUTSIDE"; note("regime or age outside model support"); }
      else if (!evaluate_population(model.sm, regime, age, &pop, &factor)) { status = "NO_MODEL"; note("no model cells for this regime"); }
      else {
        const size_t key = static_cast<size_t>(anchor - sets.data());
        auto it = histories.find(key);
        if (it == histories.end()) it = histories.emplace(key, history(sets, *anchor, options, cfg)).first;
        const auto& h = it->second;
        const auto have = populated_bins(model.sm, regime);
        if (h.older_sets < cfg.minimum_sets) note("too few older sets: below object.minimumSets");
        if (h.bins[bin].sets < cfg.minimum_bin_sets) note("age bin under object.minimumBinSets");
        if (age > h.last_age || age >= cfg.max_age_days) note("age outside the history pair support");
        if (!have[bin]) note("no model cell for the requested age bin");
        const bool empirical = notes.empty();
        status = empirical ? "EMPIRICAL" : "POPULATION";
        label.rule = empirical ? 2 : model.pooled ? 4 : 3;
        label.method = empirical ? kMethod : model.pooled ? "e14-s3-kc-pooled" : "e14-s3-kc";
        if (!empirical) {
          const auto verdict = model.cells.find({regime, bin});
          if (verdict != model.cells.end()) {
            const auto& v = verdict->second;
            label.mean_d2 = v.mean_d2; label.coverage = v.coverage;
            label.samples = v.samples; label.objects = v.objects;
            // No source lineage is supplied by this method: this verdict is
            // explicitly the population cell's own test, not an object claim.
            label.calibration = sp::verdict_of(label, true);
            label.window = sp::interval_of(model.window);
            label.measured_lineage = model.lineages.empty() ? "" : model.lineages.front();
          }
        }
        label.samples = h.bins[bin].samples; label.objects = h.bins[bin].sets;
        double rtn[36] = {}, inertial[36], factor_for_output = factor;
        std::vector<double> evaluated = pop;
        if (empirical) {
          std::vector<std::array<double, 21>> blend(h.bins.size());
          std::vector<double> weights(h.bins.size());
          for (size_t b = 0; b < h.bins.size(); ++b) {
            if (!have[b]) continue;
            const auto cell = std::make_pair(regime, static_cast<int>(b));
            const double w = h.bins[b].sets >= cfg.minimum_bin_sets ? h.bins[b].sets / (h.bins[b].sets + cfg.shrinkage) : 0;
            weights[b] = w;
            const double f = model.sm.factor.count(cell) ? model.sm.factor.at(cell) : 1;
            for (int k = 0; k < 21; ++k) blend[b][k] = w * h.bins[b].moment[k] + (1 - w) * model.sm.cov.at(cell)[k] * f;
          }
          interpolate_bins(options.ages, have, age, [&](int b, size_t k) { return blend[b][k]; }, 21, &evaluated);
          std::vector<double> weight;
          interpolate_bins(options.ages, have, age, [&](int b, size_t) { return weights[b]; }, 1, &weight);
          label.scale = weight[0];
          factor = 1;
        }
        for (int a = 0, k = 0; a < 6; ++a)
          for (int b = 0; b <= a; ++b, ++k) rtn[6 * a + b] = rtn[6 * b + a] = evaluated[k] * 1e6 * factor;
        const Instant target = ffmcal::plus_seconds(anchor->epoch, age * 86400.0);
        int ymdhm[5]; double second; Instant check;
        parse_instant(sp::iso_micro(target), &check, ymdhm, &second);
        fr::Epoch e; fr::EarthOrientation none;
        if (!fr::epochFromUtc(ymdhm[0], ymdhm[1], ymdhm[2], ymdhm[3], ymdhm[4], second, none, &e))
          return fail("invalid-request", "prediction epoch outside the frame engine's time range.");
        ElementSet copy = *anchor;
        double r[3], v[3], ax[3][3];
        if (!common::gcrf_state_at(copy, target, fr::gcrfToTeme(e), r, v))
          return fail("propagation-failed", "set in force cannot be propagated to the requested age.");
        axes_of(r, v, ax);
        rotate6(ax, rtn, inertial, false);
        if (!std::all_of(rtn, rtn + 36, [](double x) { return std::isfinite(x); }) ||
            !std::all_of(inertial, inertial + 36, [](double x) { return std::isfinite(x); }))
          return fail("invalid-models", "covariance must be finite.");
        row["factor"] = factor_for_output;
        row["covarianceRtn"] = lower21(rtn); row["covarianceInertial"] = full36(inertial);
      }
    }
    row["status"] = status;
    results.push_back(row);
    Json l = sp::label_json(label); l["epoch"] = epoch;
    reports.push_back({{"object", id}, {"epoch", epoch}, {"theory", "SGP4"}, {"rule", label.rule},
                       {"method", label.method}, {"calibrated", label.calibrated()}, {"rows", Json::array({l})}, {"notes", notes}});
  }
  const int rc = emit("covariance", {{"kind", "e14-calibrated-covariance"}, {"model", "e14-element-set-model"},
    {"calibrationVersion", std::string("0.8.0:") + (has_model ? model.id : "")}, {"rule", kMethod},
    {"units", "SI (m, m/s); RTN lower21; GCRF row-major 6x6"}, {"counts", {{"objects", results.size()}}}, {"objects", results}});
  return rc ? rc : emit("report", {{"kind", "object-covariance-report"}, {"objects", reports}});
}
