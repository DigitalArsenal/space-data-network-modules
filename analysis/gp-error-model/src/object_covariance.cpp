// Per-object SGP4 history second moments, shrunk toward the population model.
// One translation unit, after source_products.cpp. All physics stays in C++.
namespace objectcov {
using Json = nlohmann::json;
using namespace covreal;
constexpr const char* kMethod = "empirical-history-shrunk";
// SDS 1.261.0 covarianceRule::EmpiricalHistoryShrunk. Wire values are append-only; 2 (ScaledFit) is an orbit fit's rule.
constexpr int kRuleEmpirical = static_cast<int>(covarianceRule::EmpiricalHistoryShrunk);
constexpr const char* kProducer = "SDN object covariance";

struct Settings {
  double history_days = 30, max_age_days = 8, minimum_sets = 8, minimum_bin_sets = 12, shrinkage = 30;
};
std::string settings(const Json& j, Settings* s) {
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
// The $OCM product is on when the node config names its source (object.source, the shape attach_covariance's recipe
// takes: id, kind, originator, provider, lineage, licence {class, id}). Without it only the two $ERM ports answer.
std::string product_recipe(const Json& j, sp::Recipe* r, bool* on) {
  *on = j.contains("source");
  if (!*on) return {};
  r->producer = kProducer;
  const std::string error = sp::read_attribution(j, &r->a);
  if (!error.empty()) return "object config: " + error;
  if (!json_string(j, "producer").empty()) r->producer = json_string(j, "producer");
  r->created = json_string(j, "created");
  return {};
}
// Earth-centered inertial axes for a GCRF state and covariance (the same frame carries both in the $OCM).
std::shared_ptr<RFMT> gcrf_frame() {
  auto f = std::make_shared<RFMT>();
  f->NAME = "GCRF";
  CelestialFrameWrapperT w;
  w.frame = CelestialFrame::GCRF;
  f->REFERENCE_FRAME.Set(std::move(w));
  return f;
}
// Strict size-prefixed streams, preserving frame and record order.
template<class Read>
std::string records(const char* port, Read read, bool* supplied = nullptr) {
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* f = plugin_get_input_frame(i);
    if (!f || !f->port_id || std::strcmp(f->port_id, port)) continue;
    if (supplied) *supplied = true;
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
struct History { std::vector<Bin> bins; size_t older_sets = 0; double last_age = 0; std::string window; };
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
  // The element-set epochs the fit used: the oldest selected set to the set in force (empty without an older set).
  if (selected.size() > 1) out.window = sp::iso_micro(selected.front().epoch) + "/" + sp::iso_micro(selected.back().epoch);
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
// What an EmpiricalHistoryShrunk CVR's EVIDENCE must let a reader rebuild: the estimator, its configuration, the bin that
// holds the requested age, and every bin the blend interpolated between with its share of the interpolation, the distinct
// older sets n and pairs m it retained and its history weight w: "<method>/1 clip=5 historyDays=.. maxAgeDays=.. minimumSets=..
// minimumBinSets=.. shrinkage=.. bin=<index> blend=<bin>:<share>:<n>:<m>:<w> ...". The estimator is the second moment about
// zero of the object's older/newer SGP4 residual pairs in the later set's RTN axes, pairs more than clip robust sigma of
// position from the bin's median rejected; w = n/(n+shrinkage) once n >= minimumBinSets; alpha = 1 - sum(share*w).
std::string empirical_evidence(const Settings& cfg, int bin, const History& h, const std::vector<double>& share,
                               const std::vector<double>& weights) {
  char text[256];
  std::snprintf(text, sizeof text, "%s/1 clip=5 historyDays=%g maxAgeDays=%g minimumSets=%g minimumBinSets=%g shrinkage=%g bin=%d blend=",
                kMethod, cfg.history_days, cfg.max_age_days, cfg.minimum_sets, cfg.minimum_bin_sets, cfg.shrinkage, bin);
  std::string out = text;
  bool first = true;
  for (size_t b = 0; b < share.size(); ++b) {
    if (!(share[b] > 0)) continue;
    std::snprintf(text, sizeof text, "%s%zu:%.6g:%zu:%zu:%.6g", first ? "" : " ", b, share[b], h.bins[b].sets, h.bins[b].samples, weights[b]);
    out += text;
    first = false;
  }
  return out;
}
// One record: the entries of a request that share SET_NORAD_CAT_ID and SET_EPOCH, one state-and-covariance row each.
struct Group {
  uint32_t norad;
  std::string epoch, request;  // the request id of the group's first entry names the request that made the record
  std::vector<sp::OutRow> rows;
};
// The set's GCRF state at its epoch + age (km, km/s). The reason is empty on success.
struct StateFailure { std::string code, message; };
bool state_at(const ElementSet& anchor, double age, double r[3], double v[3], StateFailure* why) {
  const Instant target = ffmcal::plus_seconds(anchor.epoch, age * 86400.0);
  int ymdhm[5]; double second; Instant check;
  parse_instant(sp::iso_micro(target), &check, ymdhm, &second);
  fr::Epoch e; fr::EarthOrientation none;
  if (!fr::epochFromUtc(ymdhm[0], ymdhm[1], ymdhm[2], ymdhm[3], ymdhm[4], second, none, &e)) {
    *why = {"invalid-request", "prediction epoch outside the frame engine's time range."};
    return false;
  }
  ElementSet copy = anchor;
  if (!common::gcrf_state_at(copy, target, fr::gcrfToTeme(e), r, v)) {
    *why = {"propagation-failed", "set in force cannot be propagated to the requested age."};
    return false;
  }
  return true;
}
}  // namespace objectcov

extern "C" int object_covariance() {
  using namespace objectcov;
  std::string error;
  const Json config = ermb::recipe_from_config("object", &error, false);
  if (!error.empty()) return fail("invalid-config", error);
  Settings cfg;
  error = settings(config, &cfg);
  if (!error.empty()) return fail("invalid-config", error);
  sp::Recipe recipe;
  bool product = false;
  error = product_recipe(config, &recipe, &product);
  if (!error.empty()) return fail("invalid-config", error);
  Json chosen;
  const auto select_model = [&](const ERMT& e) -> std::string {
    if (!e.MODEL || e.MODEL->FORM != ermModelForm::ElementSetModel) return "models requires the MODEL arm, form ElementSetModel.";
    if (chosen.is_null() || (!chosen.value("pooled", false) && e.MODEL->POOLED)) chosen = ermb::model_out(*e.MODEL);
    return {};
  };
  bool models_supplied = false;
  error = records("models", select_model, &models_supplied);
  if (!error.empty()) return fail("invalid-models", error);
  if (!models_supplied) {
    const auto embedded = ermb::read_erm(kDefaultModelErm, kDefaultModelErmSize);
    if (!embedded) return fail("invalid-models", ermb::last_error);
    error = select_model(*embedded);
    if (!error.empty()) return fail("invalid-models", error);
  }
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
  std::vector<Group> groups;
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
    auto note = [&](const std::string& reason, int rule = kRuleEmpirical) { notes.push_back({{"rule", rule}, {"reason", reason}}); };
    sp::Label label;
    label.method = kMethod; label.model_id = has_model ? model.id : "";
    label.age_days = age; label.calibration = "UNCALIBRATED";
    // The report's OBJECTS, SAMPLES and SCALE_FACTOR keep the meaning the console reads them with (older sets, pairs and
    // history weight of the containing bin; zero where no history was weighed). The record's CVR carries the SDS 1.261.0
    // meaning: SAMPLES and OBJECTS count the held-out test, the history is in HISTORY_*, the prior's share in SHRINKAGE_WEIGHT.
    uint64_t report_pairs = 0, report_sets = 0;
    double report_weight = 0;
    // The record's row: the state and, where there is one, the covariance (GCRF; km, km/s; km**2 family).
    sp::OutRow out;
    double r[3] = {NAN, NAN, NAN}, v[3] = {NAN, NAN, NAN};
    bool covered = false;
    std::string status, refusal;
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
        label.rule = empirical ? kRuleEmpirical : model.pooled ? 4 : 3;
        label.method = empirical ? kMethod : model.pooled ? "e14-s3-kc-pooled" : "e14-s3-kc";
        report_pairs = h.bins[bin].samples; report_sets = h.bins[bin].sets;
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
          // Each populated bin's interpolation share, by the one interpolation rule: a unit value on that bin alone.
          std::vector<double> share(h.bins.size(), 0.0), unit;
          for (size_t b = 0; b < h.bins.size(); ++b)
            if (have[b] && interpolate_bins(options.ages, have, age, [&](int bb, size_t) { return bb == static_cast<int>(b) ? 1.0 : 0.0; }, 1, &unit))
              share[b] = unit[0];
          report_weight = weight[0];
          label.history_samples = h.bins[bin].samples; label.history_sets = h.bins[bin].sets;
          label.history_window = h.window;
          label.shrinkage_weight = 1.0 - weight[0];
          label.evidence = empirical_evidence(cfg, bin, h, share, weights);
          factor = 1;
        } else {
          label.evidence = model.evidence;
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
        for (int a = 0, k = 0; a < 6; ++a)
          for (int b = 0; b <= a; ++b, ++k) rtn[6 * a + b] = rtn[6 * b + a] = evaluated[k] * 1e6 * factor;
        StateFailure why;
        if (!state_at(*anchor, age, r, v, &why)) {
          // The console's call fails explicitly. A call that builds records answers the entry with a row that says why.
          if (!product) return fail(why.code.c_str(), why.message);
          status = "NO_STATE"; refusal = why.message;
        } else {
          double ax[3][3];
          axes_of(r, v, ax);
          rotate6(ax, rtn, inertial, false);
          if (!std::all_of(rtn, rtn + 36, [](double x) { return std::isfinite(x); }) ||
              !std::all_of(inertial, inertial + 36, [](double x) { return std::isfinite(x); }))
            return fail("invalid-models", "covariance must be finite.");
          row["factor"] = factor_for_output;
          row["covarianceRtn"] = lower21(rtn); row["covarianceInertial"] = full36(inertial);
          covered = true;
          out.has_cov = true; out.cov = sp::lower_from_full(inertial);
          for (double& x : out.cov) x /= 1e6;
        }
      }
    }
    if (product) {
      // Every entry has its row, so a caller that stores the record as its cursor always advances: where there is no
      // covariance the row has no covariance and its CVR says why (the report holds the same reasons).
      if (!covered) {
        std::string reasons = refusal;
        for (const auto& n : notes) reasons += (reasons.empty() ? "" : "; ") + n.value("reason", std::string());
        label = sp::Label();
        label.age_days = age; label.calibration = "UNCALIBRATED";
        label.regime = row.value("regime", std::string());
        label.evidence = "no covariance (" + status + "): " + reasons;
        if (anchor && status != "NO_STATE") { StateFailure ignored; state_at(*anchor, age, r, v, &ignored); }  // the row still carries the state
      }
      out.t = ffmcal::plus_seconds(anchor ? anchor->epoch : time, age * 86400.0);
      out.text = sp::iso_micro(out.t);
      for (int k = 0; k < 3; ++k) { out.x[k] = r[k]; out.x[3 + k] = v[k]; }
      out.label = label;
      auto at = std::find_if(groups.begin(), groups.end(), [&](const Group& g) { return g.norad == norad && g.epoch == epoch; });
      if (at == groups.end()) { groups.push_back({norad, epoch, id, {}}); at = groups.end() - 1; }
      at->rows.push_back(std::move(out));
    }
    row["status"] = status;
    results.push_back(row);
    sp::Label legacy = label;
    legacy.samples = report_pairs; legacy.objects = report_sets; legacy.scale = report_weight;
    Json l = sp::label_json(legacy); l["epoch"] = epoch;
    reports.push_back({{"object", id}, {"epoch", epoch}, {"theory", "SGP4"}, {"rule", label.rule},
                       {"method", label.method}, {"calibrated", label.calibrated()}, {"rows", Json::array({l})}, {"notes", notes}});
  }
  // The records first: a consumer of both ports sees them before the statuses that say they exist.
  std::vector<uint8_t> ocm_stream;
  for (auto& g : groups) {
    std::stable_sort(g.rows.begin(), g.rows.end(), [](const sp::OutRow& a, const sp::OutRow& b) { return before(a.t, b.t); });
    sp::Product p;
    p.method = kMethod; p.kind = "sgp4-epoch-state";
    p.state_frame = p.cov_frame = gcrf_frame(); p.state_frame_name = p.cov_frame_name = "GCRF";
    p.axes = sp::CovAxes::State;
    p.rows = std::move(g.rows);
    // The message id is the record's key, in a form a reader finds without decoding the record: the lane's store exposes a
    // record's body only, so a reader of the lane searches the bytes for "object-covariance|" and reads what follows:
    // "object-covariance|<object key>|<first epoch>|<method>|<id of the request that made it>". A caller that stores the
    // record as its cursor puts its position in that request id.
    const std::string key = sp::key_of(g.norad, "", "");
    const std::vector<uint8_t> ocm = sp::build_ocm(recipe, key, "", "", g.norad, p,
        "object-covariance|" + key + "|" + p.rows.front().text + "|" + p.method + "|" + g.request);
    ocm_stream.insert(ocm_stream.end(), ocm.begin(), ocm.end());
  }
  if (!ocm_stream.empty() &&
      plugin_push_output_ex("ocm", "OCM.fbs", "$OCM", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "OCM", 0, 0, ocm_stream.data(),
                            static_cast<uint32_t>(ocm_stream.size())) < 0)
    return fail("output", "cannot emit the covariance records");
  const int rc = emit("covariance", {{"kind", "e14-calibrated-covariance"}, {"model", "e14-element-set-model"},
    {"calibrationVersion", std::string("0.8.0:") + (has_model ? model.id : "")}, {"rule", kMethod},
    {"units", "SI (m, m/s); RTN lower21; GCRF row-major 6x6"}, {"counts", {{"objects", results.size()}}}, {"objects", results}});
  return rc ? rc : emit("report", {{"kind", "object-covariance-report"}, {"objects", reports}});
}
