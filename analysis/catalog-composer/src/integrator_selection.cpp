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

bool parse_selection_policy(const XMTSelectionPolicy* s, SelectionPolicy* out, std::string* error) {
  if (!s) return true;
  if (!std::isnan(s->HORIZON_DAYS())) {
    out->horizon = s->HORIZON_DAYS();
    if (!std::isfinite(out->horizon) || out->horizon < 0) { *error = "HORIZON_DAYS must be nonnegative and finite."; return false; }
  }
  out->min_samples = s->MIN_SAMPLES();
  if (out->min_samples < 1) { *error = "MIN_SAMPLES must be at least 1."; return false; }
  out->max_age_days = s->MAX_AGE_DAYS();
  if (!(out->max_age_days >= 0)) { *error = "MAX_AGE_DAYS must be nonnegative."; return false; }
  if (s->SOURCE_ORDER()) {
    std::set<std::string> seen;
    for (const auto* id : *s->SOURCE_ORDER()) {
      if (str_of(id).empty() || !seen.insert(str_of(id)).second) { *error = "SOURCE_ORDER holds distinct source IDs."; return false; }
      out->source_order.push_back(str_of(id));
    }
  }
  if (const auto* table = s->MEASURED()) {
    if (table->size() > 100000) { *error = "The measured table holds at most 100000 rows."; return false; }
    if (table->size() && !std::isfinite(out->horizon)) { *error = "A measured table needs SELECTION.HORIZON_DAYS."; return false; }
    for (const auto* row : *table) {
      const std::string source = str_of(row->SOURCE_ID()), product = str_of(row->PRODUCT()), regime = str_of(row->REGIME());
      const double horizon = row->HORIZON_DAYS(), median = row->MEDIAN_3D_KM(), samples = row->SAMPLES();
      if (source.empty() || product.empty() || regime.empty() || !std::isfinite(horizon) || horizon < 0 || !std::isfinite(median) || median < 0) {
        *error = "A measured row needs a source, product, regime, HORIZON_DAYS, a nonnegative MEDIAN_3D_KM and a sample count.";
        return false;
      }
      if (!out->table.emplace(Cell{source, product, regime, horizon}, Measure{median, samples}).second) { *error = "The measured table repeats a source, product, regime and horizon."; return false; }
    }
  }
  return true;
}
std::unique_ptr<XMTSelectionPolicyT> selection_policy_table(const SelectionPolicy& p) {
  auto out = std::make_unique<XMTSelectionPolicyT>();
  out->HORIZON_DAYS = p.horizon;
  out->MIN_SAMPLES = static_cast<uint32_t>(p.min_samples);
  out->MAX_AGE_DAYS = p.max_age_days;
  out->SOURCE_ORDER = p.source_order;
  out->MEASURED_ROWS = static_cast<uint32_t>(p.table.size());
  return out;
}

struct Candidate {
  const Omm* omm;
  xmtCandidateStanding status;  // NotSelected (eligible), Future, Retired or TooOld
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
    Candidate c{omm, xmtCandidateStanding::NotSelected, static_cast<double>(as_of - omm->epoch) / 86400e6, false, NAN, 0};
    if (omm->epoch > as_of) c.status = xmtCandidateStanding::Future;
    else if (retiring && omm->epoch < began(*retiring)) c.status = xmtCandidateStanding::Retired;
    else if (c.age_days > p.max_age_days) c.status = xmtCandidateStanding::TooOld;
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
  xmtSelectionReason reason = xmtSelectionReason::Unspecified;
  bool tie = false;
};
Choice choose(const std::vector<Candidate>& candidates, const SelectionPolicy& p) {
  std::vector<const Candidate*> eligible, measured;
  for (const auto& c : candidates) if (c.status == xmtCandidateStanding::NotSelected) eligible.push_back(&c);
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
    choice.reason = xmtSelectionReason::OnlyCandidate;
    return choice;
  }
  if (!measured.empty()) {
    std::stable_sort(measured.begin(), measured.end(), [&](const Candidate* a, const Candidate* b) {
      if (a->median != b->median) return a->median < b->median;
      return by_order(a, b);
    });
    choice.winner = measured.front();
    choice.reason = xmtSelectionReason::LowestMeasuredMedian;
    choice.tie = measured.size() > 1 && measured[1]->median == measured[0]->median;
    return choice;
  }
  std::stable_sort(eligible.begin(), eligible.end(), by_order);
  choice.winner = eligible.front();
  choice.reason = xmtSelectionReason::UnmeasuredFallbackOrder;
  return choice;
}

}  // namespace integrate
