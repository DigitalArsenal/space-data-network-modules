// Selection of one source's product per object, regime and horizon by measured error.
//
// The measured table is a recipe input, refreshed by the experiments: for a source, a product (the mean-element theory
// of its $OMM), an orbit regime and a horizon, the median 3-D position error on a training window and its sample count.
// A source's newest product at or before asOf is its candidate. A candidate whose epoch precedes a retiring maneuver is
// retired; one older than maxAgeDays is too old. Of the rest, those the table measures (at least minSamples) are
// ordered by their median error; the lowest wins, ties going to the source earlier in sourceOrder and then to the
// newer epoch. With none measured, sourceOrder decides and the report says so. The regime is the one the product's
// covariance label names (gp-error-model), so the covariance model and the selection speak of the same strata.
namespace integrate {

using Cell = std::tuple<std::string, std::string, std::string, double>;  // source, product, regime, horizon (days)
struct Measure {
  double median, samples;
};

struct SelectionPolicy {
  double horizon = NAN;
  double min_samples = 30;
  double max_age_days = INFINITY;
  std::vector<std::string> source_order;
  std::map<Cell, Measure> table;
  size_t order_of(const std::string& source) const {
    const auto it = std::find(source_order.begin(), source_order.end(), source);
    return static_cast<size_t>(it - source_order.begin());
  }
};

bool parse_selection_policy(const Json& s, SelectionPolicy* out, std::string* error) {
  if (s.is_null()) return true;
  if (!s.is_object()) { *error = "The selection policy must be an object."; return false; }
  if (!field(s, "horizonDays").is_null()) {
    out->horizon = number(field(s, "horizonDays"));
    if (!std::isfinite(out->horizon) || out->horizon < 0) { *error = "horizonDays must be nonnegative and finite."; return false; }
  }
  if (!field(s, "minSamples").is_null()) {
    out->min_samples = number(field(s, "minSamples"));
    if (!std::isfinite(out->min_samples) || out->min_samples < 1) { *error = "minSamples must be at least 1."; return false; }
  }
  if (!field(s, "maxAgeDays").is_null()) {
    out->max_age_days = number(field(s, "maxAgeDays"));
    if (!(out->max_age_days >= 0)) { *error = "maxAgeDays must be nonnegative."; return false; }
  }
  const auto& order = field(s, "sourceOrder");
  if (!order.is_null()) {
    if (!order.is_array()) { *error = "sourceOrder must be an array of source IDs."; return false; }
    std::set<std::string> seen;
    for (const auto& id : order) {
      if (text(id).empty() || !seen.insert(text(id)).second) { *error = "sourceOrder holds distinct source IDs."; return false; }
      out->source_order.push_back(text(id));
    }
  }
  const auto& table = field(s, "table");
  if (!table.is_null()) {
    if (!table.is_array() || table.size() > 100000) { *error = "The measured table must be an array of at most 100000 rows."; return false; }
    if (!table.empty() && !std::isfinite(out->horizon)) { *error = "A measured table needs selection.horizonDays."; return false; }
    for (const auto& row : table) {
      const std::string source = text(field(row, "source")), product = text(field(row, "product")), regime = text(field(row, "regime"));
      const double horizon = number(field(row, "horizonDays")), median = number(field(row, "median3dKm")), samples = number(field(row, "samples"));
      if (source.empty() || product.empty() || regime.empty() || !std::isfinite(horizon) || horizon < 0 || !std::isfinite(median) || median < 0 || !std::isfinite(samples) || samples < 0) {
        *error = "A measured row needs a source, product, regime, horizonDays, a nonnegative median3dKm and a sample count.";
        return false;
      }
      if (!out->table.emplace(Cell{source, product, regime, horizon}, Measure{median, samples}).second) { *error = "The measured table repeats a source, product, regime and horizon."; return false; }
    }
  }
  return true;
}
Json selection_policy_json(const SelectionPolicy& p) {
  return {{"horizonDays", std::isfinite(p.horizon) ? Json(p.horizon) : Json()}, {"minSamples", p.min_samples},
          {"maxAgeDays", std::isfinite(p.max_age_days) ? Json(p.max_age_days) : Json()}, {"sourceOrder", p.source_order}, {"measuredRows", p.table.size()}};
}

struct Candidate {
  const Omm* omm;
  const char* status;  // eligible, future, retired or too-old
  double age_days;
  bool measured;
  double median, samples;
};

// One candidate per source from that source's products of one kind for one object.
std::vector<Candidate> candidates_of(const std::vector<const Omm*>& products, const std::string& regime, int64_t as_of, const Event* retiring, const SelectionPolicy& p) {
  std::map<std::string, const Omm*> newest, future;
  for (const Omm* omm : products) {
    auto& slot = omm->epoch <= as_of ? newest : future;
    auto it = slot.find(omm->source);
    // Of equal epochs the first record read stands; a source's later epoch (or, for the future, earlier) replaces it.
    const bool better = it == slot.end() || (omm->epoch <= as_of ? omm->epoch > it->second->epoch : omm->epoch < it->second->epoch);
    if (better) slot[omm->source] = omm;
  }
  for (const auto& [source, omm] : future) if (!newest.count(source)) newest[source] = omm;
  std::vector<Candidate> out;
  for (const auto& [source, omm] : newest) {
    Candidate c{omm, "eligible", static_cast<double>(as_of - omm->epoch) / 86400e6, false, NAN, 0};
    if (omm->epoch > as_of) c.status = "future";
    else if (retiring && omm->epoch < began(*retiring)) c.status = "retired";
    else if (c.age_days > p.max_age_days) c.status = "too-old";
    const auto cell = p.table.find(Cell{source, omm->product, regime, p.horizon});
    if (!regime.empty() && std::isfinite(p.horizon) && cell != p.table.end()) {
      c.median = cell->second.median;
      c.samples = cell->second.samples;
      c.measured = c.samples >= p.min_samples;
    }
    out.push_back(c);
  }
  // The report reads in the recipe's order of preference.
  std::stable_sort(out.begin(), out.end(), [&](const Candidate& a, const Candidate& b) {
    const size_t oa = p.order_of(a.omm->source), ob = p.order_of(b.omm->source);
    return oa != ob ? oa < ob : a.omm->source < b.omm->source;
  });
  return out;
}

struct Choice {
  const Candidate* winner = nullptr;
  const char* reason = "";
  bool tie = false;
};
Choice choose(const std::vector<Candidate>& candidates, const SelectionPolicy& p) {
  std::vector<const Candidate*> eligible, measured;
  for (const auto& c : candidates) if (std::strcmp(c.status, "eligible") == 0) eligible.push_back(&c);
  for (const Candidate* c : eligible) if (c->measured) measured.push_back(c);
  Choice choice;
  if (eligible.empty()) return choice;
  auto later_epoch = [&](const Candidate* a, const Candidate* b) { return a->omm->epoch > b->omm->epoch; };
  auto by_order = [&](const Candidate* a, const Candidate* b) {
    const size_t oa = p.order_of(a->omm->source), ob = p.order_of(b->omm->source);
    if (oa != ob) return oa < ob;
    if (a->omm->epoch != b->omm->epoch) return later_epoch(a, b);
    return a->omm->source < b->omm->source;
  };
  if (eligible.size() == 1) {
    choice.winner = eligible.front();
    choice.reason = "only-candidate";
    return choice;
  }
  if (!measured.empty()) {
    std::stable_sort(measured.begin(), measured.end(), [&](const Candidate* a, const Candidate* b) {
      if (a->median != b->median) return a->median < b->median;
      return by_order(a, b);
    });
    choice.winner = measured.front();
    choice.reason = "lowest-measured-median";
    choice.tie = measured.size() > 1 && measured[1]->median == measured[0]->median;
    return choice;
  }
  std::stable_sort(eligible.begin(), eligible.end(), by_order);
  choice.winner = eligible.front();
  choice.reason = "unmeasured-fallback-order";
  return choice;
}

}  // namespace integrate
