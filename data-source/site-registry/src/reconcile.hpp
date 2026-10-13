// Reconcile: one lifecycle status per site from every licence-OK source,
// each source's assertion kept as cited evidence (ported from the audit's
// facility-status/reconcile.mjs and placemark-status.mjs, verified round 5).
//
//   - A reviewed fact (register/reviewed.json, read by hand from the cited
//     article or item) decides when one exists; reviewed steps are a timeline
//     and the last is the current state.
//   - Otherwise the most advanced state any source states wins, unless a
//     source DATES a return to service after every dated stop.
//   - A state's date is the earliest any source gives for it (at their
//     common precision, the most precise at that); a decommissioning-date
//     field stands in only when nothing else dates the shutdown.
//   - A date after the run's day is an announcement and is dropped.
//   - An operating site no source dates takes its start of operation.
//   - An organisation renamed or merged into a successor stays OPERATING.
//   - Outside the reactor sets a row no source states a lifecycle for is
//     UNVERIFIED (its evidence names what was read).
//   - A nuclear placemark follows its joined item, the tracker's units
//     (a station runs while any of its units runs) and its own reviewed facts.
//   - Prose statements of a started or completed dismantling never decide:
//     the rows they leave open are the run report's review queue.
#pragma once
#include <algorithm>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace sr {

struct Ev {
  int status = UNSPECIFIED;
  std::string date;
  Citation cit;
  bool reviewed = false, renamed = false, renaming = false, decommissionedRole = false;
};

inline int sourceOrder(const std::string& s) {
  if (s == "gem-gnpt") return 0;
  if (s == "wikidata") return 1;
  if (s == "wikipedia") return 2;
  if (s == "ror") return 3;
  return -1;
}

// When a state took effect, from the evidence that states it ("" when none dates it).
inline std::string dateOf(const std::vector<const Ev*>& items) {
  std::vector<const Ev*> dated;
  for (const Ev* e : items) if (!e->date.empty()) dated.push_back(e);
  bool anyPrimary = false;
  for (const Ev* e : dated) if (!e->decommissionedRole) anyPrimary = true;
  std::vector<const Ev*> primary;
  for (const Ev* e : dated) if (!anyPrimary || !e->decommissionedRole) primary.push_back(e);
  std::stable_sort(primary.begin(), primary.end(), [](const Ev* a, const Ev* b) {
    const int c = compareDates(a->date, b->date);
    if (c) return c < 0;
    const int p = precision(b->date) - precision(a->date);
    if (p) return p < 0;
    return sourceOrder(a->cit.source) < sourceOrder(b->cit.source);
  });
  return primary.empty() ? "" : primary[0]->date;
}

struct Decision { int status = UNSPECIFIED; std::string date, rule; };

inline Decision decide(const std::vector<Ev>& given) {
  std::vector<const Ev*> all;
  for (const auto& e : given) if (!e.renamed) all.push_back(&e);
  std::vector<const Ev*> reviewed;
  for (const Ev* e : all) if (e->reviewed && e->status != UNSPECIFIED) reviewed.push_back(e);
  if (!reviewed.empty()) {
    const Ev* last = reviewed.back();
    long change = -1;
    for (long i = long(reviewed.size()) - 1; i >= 0; --i) if (reviewed[size_t(i)]->status != last->status) { change = i; break; }
    std::vector<const Ev*> same;
    for (size_t i = size_t(change + 1); i < reviewed.size(); ++i) if (reviewed[i]->status == last->status) same.push_back(reviewed[i]);
    return {last->status, last->date.empty() ? dateOf(same) : last->date, "reviewed"};
  }
  std::vector<const Ev*> ev;
  for (const Ev* e : all) if (e->status != UNSPECIFIED) ev.push_back(e);
  if (ev.empty()) return {UNSPECIFIED, "", "none"};
  const Ev* best = ev[0];
  for (const Ev* e : ev) if (rankOf(e->status) > rankOf(best->status)) best = e;
  std::vector<const Ev*> returns;
  for (const Ev* e : ev) {
    if (e->date.empty() || !restartState(e->status) || rankOf(e->status) >= rankOf(best->status)) continue;
    std::vector<const Ev*> stops;
    for (const Ev* o : ev) if (!o->date.empty() && rankOf(o->status) > rankOf(e->status)) stops.push_back(o);
    bool after = !stops.empty();
    for (const Ev* o : stops) if (compareDates(e->date, o->date) <= 0) after = false;
    if (after) returns.push_back(e);
  }
  if (!returns.empty()) {
    const Ev* latest = returns[0];
    for (const Ev* e : returns) if (compareDates(e->date, latest->date) > 0) latest = e;
    std::vector<const Ev*> same;
    for (const Ev* e : returns) if (e->status == latest->status && compareDates(e->date, latest->date) == 0) same.push_back(e);
    return {latest->status, dateOf(same), "restart"};
  }
  std::vector<const Ev*> same;
  for (const Ev* e : ev) if (e->status == best->status) same.push_back(e);
  std::string date = dateOf(same);
  if (best->status == CANCELLED && date.empty()) {
    std::vector<const Ev*> stops;
    for (const Ev* e : ev) if (e->status == PERMANENT_SHUTDOWN) stops.push_back(e);
    date = dateOf(stops);
  }
  return {best->status, date, "most-advanced"};
}

// ── evidence classes, by the field a statement was read from ──────────────────
inline bool isWorking(const Evidence& e) { return e.status == UNSPECIFIED || startsWith(e.cit.field, "prose:") || e.cit.field == "station-unit"; }
inline bool isStartCandidate(const Evidence& e) {
  if (e.status != OPERATING) return false;
  if (e.cit.source == "wikidata") { for (const auto& p : startProperties()) if (e.cit.field == p) return true; return false; }
  return e.cit.source == "wikipedia" && startsWith(e.cit.field, "infobox:") && isServiceStartKey(e.cit.field.substr(8));
}

// The language order of a Wikipedia record id ("de:Title").
inline int langRank(const std::string& recordId) {
  const std::string lang = recordId.substr(0, recordId.find(':'));
  const auto& L = wikiLangs();
  for (size_t i = 0; i < L.size(); ++i) if (L[i] == lang) return int(i);
  return int(L.size());
}

struct ReconcileReport {
  Json open = Json::array();
  std::map<std::string, int> byStatus, byNetwork, byRule;
  int undatedNuclear = 0, noCountry = 0, noRecord = 0, dropped = 0, unnamed = 0;
  Json droppedRows = Json::array();
};

// The facility rules over one row's evidence: the JS order (Wikidata, Wikipedia
// by language, reviewed facts in register order, ROR, the tracker), renamings,
// announcements dropped, the decision, the start of operation, UNVERIFIED.
struct RowResult { Decision decided; std::vector<Ev> evidence; std::string started; Ev startEv; bool hasStart = false; };

inline RowResult reconcileRow(const State& st, const std::string& category, const std::string& kind, const std::vector<Evidence>& stored,
                              const std::string& factKey, bool organisation) {
  RowResult out;
  std::vector<Ev> wikidata, wikipedia, reviewed, ror, gem;
  std::vector<std::pair<int, Ev>> wikipediaOrdered;
  std::vector<Ev> starts;
  // Reviewed GEM joins are stored by their unit list; the register gives their order.
  std::map<std::string, Ev> reviewedGem;
  for (size_t i = 0; i < stored.size(); ++i) {
    const Evidence& e = stored[i];
    if (isWorking(e)) continue;
    Ev v{e.status, e.date, e.cit};
    if (isStartCandidate(e)) { starts.push_back(v); continue; }
    if (e.cit.field == "register:reviewed") { if (e.cit.source == "gem-gnpt") reviewedGem[e.cit.recordId] = v; continue; }
    if (e.cit.field == "register:placemarks") continue;  // the placemark's own join: placemark logic
    if (e.cit.source == "wikidata") { v.renaming = isSuccessorProperty(e.cit.field); wikidata.push_back(v); }
    else if (e.cit.source == "wikipedia") { v.decommissionedRole = startsWith(e.cit.field, "infobox:") && isDecommissionKey(e.cit.field.substr(8)); wikipediaOrdered.push_back({langRank(e.cit.recordId), v}); }
    else if (e.cit.source == "ror") { v.renaming = e.cit.field == "successor"; ror.push_back(v); }
    else if (e.cit.source == "gem-gnpt") gem.push_back(v);
    else wikidata.push_back(v);  // register statements (space sites) read first
  }
  std::stable_sort(wikipediaOrdered.begin(), wikipediaOrdered.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
  for (auto& [r, v] : wikipediaOrdered) wikipedia.push_back(v);
  for (const auto& f : reg::kFacts) {
    if (factKey.empty() || factKey != f.qid) continue;
    const std::string source = f.source;
    if (source == "gem-gnpt") {
      std::vector<std::string> ids;
      for (size_t u = 0; u < f.unitCount; ++u) ids.push_back(reg::kFactUnits[f.unitBegin + u]);
      auto it = reviewedGem.find(join(ids, ","));
      if (it != reviewedGem.end()) { Ev v = it->second; v.reviewed = true; reviewed.push_back(v); }
      continue;
    }
    for (size_t k = 0; k < f.stepCount; ++k) {
      const auto& step = reg::kSteps[f.stepBegin + k];
      Ev v;
      v.status = statusFromName(step.status);
      v.date = step.date;
      v.reviewed = true;
      if (source == "wikidata") v.cit = cite("wikidata", f.qid, wikidataUrl(f.qid), f.revision, "register:reviewed", f.reviewedAt);
      else v.cit = cite("wikipedia", std::string(f.wiki) + ":" + f.title, revisionUrl(f.wiki, f.title, f.revision), f.revision, "register:reviewed", f.reviewedAt);
      reviewed.push_back(v);
    }
  }
  std::vector<Ev>& ev = out.evidence;
  for (auto* list : {&wikidata, &wikipedia, &reviewed, &ror, &gem}) ev.insert(ev.end(), list->begin(), list->end());
  // One merger rule for every source: a renaming or merger is never a closure.
  bool anyRenaming = false;
  for (const auto& v : ev) if (v.renaming) anyRenaming = true;
  if (organisation && anyRenaming) {
    for (auto& v : ev) {
      if (v.status != PERMANENT_SHUTDOWN || v.reviewed) continue;
      const bool wd = v.cit.source == "wikidata" && (isEndProperty(v.cit.field) || v.cit.field == "description");
      if (wd || v.cit.source == "ror") v.renamed = true;
    }
  }
  // A date after the run's day announces a step.
  const std::string today = st.runAt.substr(0, 10);
  ev.erase(std::remove_if(ev.begin(), ev.end(), [&](const Ev& v) { return !v.date.empty() && compareDates(v.date, today) > 0; }), ev.end());
  out.decided = decide(ev);
  // Start of operation: the item's own P729/P1619, else the earliest any source gives;
  // a facility never takes an inception or founding date (often its construction or renaming).
  const Ev* wdStart = nullptr;
  for (const auto& v : starts) if (v.cit.source == "wikidata") wdStart = &v;
  const bool own = wdStart && wdStart->cit.field != "P571";
  std::vector<const Ev*> cands;
  for (const auto& v : starts) cands.push_back(&v);
  // Space centres and mission control are organisations too (the audit read them as research bodies).
  const bool isOrganisation = (organisationSet(category) && kind != "research reactor") || category == "S.CTRS" || category == "S.MCC";
  if (!isOrganisation) cands.erase(std::remove_if(cands.begin(), cands.end(), [](const Ev* v) { return v->cit.field == "P571" || v->cit.field == "infobox:established"; }), cands.end());
  const Ev* started = nullptr;
  if (own) { for (const Ev* v : cands) if (v->cit.source == "wikidata") { started = v; break; } }
  else {
    std::vector<const Ev*> sorted = cands;
    std::stable_sort(sorted.begin(), sorted.end(), [](const Ev* a, const Ev* b) {
      const int c = compareDates(a->date, b->date);
      if (c) return c < 0;
      return precision(b->date) - precision(a->date) < 0;
    });
    if (!sorted.empty()) started = sorted[0];
  }
  if (started) { out.started = started->date; out.startEv = *started; out.hasStart = true; }
  if (out.decided.status == OPERATING && out.decided.date.empty() && started) {
    ev.push_back(*started);
    out.decided.date = started->date;
  }
  if (out.decided.status == UNSPECIFIED && !reactorSet(category)) {
    out.decided.status = UNVERIFIED;
    out.decided.rule = "unverified";
  }
  return out;
}

// ── placemark names (placemark-status.mjs tokens/parts) ──────────────────────
inline bool placemarkUnitLevel(const std::string& name) {
  static const std::set<std::string> kindWords{"kernkraftwerk", "kerncentrale", "kernenergiecentrale", "centrale", "nucleaire", "nucleare", "atomic", "atomique", "atomnaya", "elektrostantsiya", "station",
                                               "generating", "powerplant", "plant", "power", "nuclear", "npp", "aes", "block", "unit", "unite", "complex", "historical", "energy", "center", "centre",
                                               "pwr", "bwr", "agr", "magnox", "reactor", "c", "n", "de", "la", "le", "of", "the"};
  static const std::map<std::string, std::string> roman{{"i", "1"}, {"ii", "2"}, {"iii", "3"}, {"iv", "4"}, {"v", "5"}, {"vi", "6"}};
  std::vector<std::string> tokens;
  for (auto& w : split(nameKey(name), ' ')) {
    if (w.empty() || kindWords.count(w)) continue;
    auto r = roman.find(w);
    tokens.push_back(r == roman.end() ? w : r->second);
  }
  for (size_t i = 0; i < tokens.size(); ++i) {
    const auto& w = tokens[i];
    const bool digits = !w.empty() && std::all_of(w.begin(), w.end(), [](char c) { return c >= '0' && c <= '9'; });
    if (digits || (w.size() == 1 && i == tokens.size() - 1)) return true;
  }
  return false;
}

inline const reg::Placemark* placemarkOf(const std::string& id) {
  for (const auto& p : reg::kPlacemarks) if (id == std::string("geonames:") + p.geonameId) return &p;
  return nullptr;
}

inline bool currentAtGem(int s) { return s == OPERATING || s == LONG_TERM_SHUTDOWN || s == UNDER_CONSTRUCTION; }

// A nuclear placemark (placemark-status.mjs): its item's record, the tracker join, its own reviewed facts.
inline RowResult reconcilePlacemark(const State& st, const Site& s) {
  const reg::Placemark* p = placemarkOf(s.id);
  const std::string qid = s.qid();
  RowResult record;
  bool hasRecord = !qid.empty();
  if (hasRecord) record = reconcileRow(st, "NUCF", "nuclear power plant", s.evidence, qid, false);
  // The placemark's own join, and its facts (keyed geonames:<id>).
  const Evidence* joinEv = nullptr;
  std::vector<int> stationStatuses;
  for (const auto& e : s.evidence) {
    if (e.cit.field == "register:placemarks") joinEv = &e;
    if (e.cit.field == "station-unit") stationStatuses.push_back(e.status);
  }
  std::vector<Ev> evidence = hasRecord ? record.evidence : std::vector<Ev>{};
  bool reviewedJoin = false;
  std::vector<const reg::Fact*> facts;
  for (const auto& f : reg::kFacts) if (s.id == f.qid) { facts.push_back(&f); if (std::string(f.source) == "gem-gnpt") reviewedJoin = true; }
  Ev gemLine;
  if (joinEv) {
    gemLine = Ev{joinEv->status, "", joinEv->cit};
    bool same = false;
    for (const auto& v : evidence) if (v.cit.source == "gem-gnpt" && v.cit.recordId == joinEv->cit.recordId) same = true;
    if (!reviewedJoin && !same) evidence.insert(evidence.begin(), gemLine);
  }
  for (const auto* f : facts) {
    if (std::string(f->source) == "gem-gnpt") {
      std::vector<std::string> ids;
      for (size_t u = 0; u < f->unitCount; ++u) ids.push_back(reg::kFactUnits[f->unitBegin + u]);
      for (const auto& e : s.evidence)
        if (e.cit.field == "register:reviewed" && e.cit.source == "gem-gnpt" && e.cit.recordId == join(ids, ",")) { Ev v{e.status, "", e.cit}; v.reviewed = true; evidence.push_back(v); break; }
      continue;
    }
    for (size_t k = 0; k < f->stepCount; ++k) {
      const auto& step = reg::kSteps[f->stepBegin + k];
      Ev v;
      v.status = statusFromName(step.status);
      v.date = step.date;
      v.reviewed = true;
      v.cit = cite("wikipedia", std::string(f->wiki) + ":" + f->title, revisionUrl(f->wiki, f->title, f->revision), f->revision, "register:reviewed", f->reviewedAt);
      evidence.push_back(v);
    }
  }
  RowResult out;
  out.started = record.started;
  out.startEv = record.startEv;
  out.hasStart = record.hasStart;
  const bool unitLevel = placemarkUnitLevel(s.name);
  if (!facts.empty()) out.decided = decide(evidence);
  else if (unitLevel && !(p && p->unitItem)) {
    if (p && p->unitPlant && joinEv) out.decided = {gemLine.status, "", "tracker unit"};
    else out.decided = {hasRecord ? record.decided.status : UNSPECIFIED, "", "station item"};
    const bool allUnits = !stationStatuses.empty() && std::all_of(stationStatuses.begin(), stationStatuses.end(), [&](int x) { return x == out.decided.status; });
    std::vector<const Ev*> dated;
    for (const auto& v : record.evidence) if (v.status == out.decided.status && !v.date.empty()) dated.push_back(&v);
    bool unitDates = false;
    for (const auto& e : s.evidence) if (e.status == UNSPECIFIED && startsWith(e.cit.field, "infobox:")) {
      for (const Ev* d : dated) if (d->cit.recordId == e.cit.recordId && d->cit.field == e.cit.field) unitDates = true;
    }
    bool oneDate = !dated.empty() && !unitDates;
    for (const Ev* d : dated) if (compareDates(d->date, record.decided.date) != 0) oneDate = false;
    if (hasRecord && allUnits && oneDate && record.decided.status == out.decided.status && !record.decided.date.empty())
      out.decided = {out.decided.status, record.decided.date, out.decided.rule + ", station date"};
  } else if (hasRecord && !record.evidence.empty()) {
    out.decided = record.decided;
    if (joinEv && !unitLevel && out.decided.rule != "reviewed" && currentAtGem(gemLine.status) && gemLine.status != out.decided.status) {
      std::vector<std::string> same;
      for (const auto& v : evidence) if (v.status == gemLine.status && !v.date.empty()) same.push_back(v.date);
      std::sort(same.begin(), same.end());
      const std::string date = !same.empty() ? same[0] : (gemLine.status == OPERATING ? record.started : "");
      out.decided = {gemLine.status, date, "station units"};
    }
  } else out.decided = decide(evidence);
  out.evidence = evidence;
  return out;
}

}  // namespace sr
