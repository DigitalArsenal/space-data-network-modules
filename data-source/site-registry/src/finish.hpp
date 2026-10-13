// The last stage's output: the published $SIT records (decided, cited,
// working entries dropped, sorted by ID), the $GNP search projection of the
// current and prospective rows, the ingest meta of both lanes and the run
// report (counts and the review queue).
#pragma once
#include <algorithm>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace sr {

inline const char* lifecycleLabel(int s) {
  switch (s) {
    case PLANNED: return "Planned";
    case UNDER_CONSTRUCTION: return "Under construction";
    case CONSTRUCTION_SUSPENDED: return "Construction suspended";
    case OPERATING: return "Operating";
    case LONG_TERM_SHUTDOWN: return "Long-term shutdown";
    case PERMANENT_SHUTDOWN: return "Permanently shut down";
    case DECOMMISSIONING: return "Decommissioning";
    case DECOMMISSIONED: return "Decommissioned";
    case CANCELLED: return "Cancelled";
    case UNVERIFIED: return "Unverified";
    default: return "";
  }
}

inline std::string countryName(const std::string& a2) {
  for (const auto& c : reg::kCountries) if (a2 == c.a2) return c.name;
  return "";
}

// The terms a record's reproduced content travels under: CC BY 4.0 when any
// of it (a position, a quantity, a register row) comes from an attribution
// source, else CC0. Wikipedia contributes facts, titles and links only.
inline void recordTerms(Site& s) {
  bool attribution = false;
  auto check = [&](const Citation& c) {
    if (c.empty() || c.source == "wikipedia" || c.source == "wikidata" || c.source == "ror") return;
    const reg::Source* src = regSource(c.source);
    if (src && std::string(src->licenseId) != "CC0-1.0") attribution = true;
  };
  check(s.positionCitation);
  for (const auto& q : s.quantities) check(q.cit);
  for (const auto& e : s.evidence) if (e.cit.source != "gem-gnpt") check(e.cit);
  s.licenseClass = "Reproducible";
  s.licenseId = attribution ? "CC-BY-4.0" : "CC0-1.0";
}

inline std::string sourceLine(const Site& s) {
  if (startsWith(s.id, "wikidata:")) return "Wikidata " + s.id.substr(9);
  if (startsWith(s.id, "geonames:")) return "GeoNames " + s.id.substr(9);
  if (startsWith(s.id, "gem:")) return "Global Energy Monitor, Global Nuclear Power Tracker";
  return "Space Data Network site register";
}

inline std::string fixedMs(const std::string& rfc3339) {
  // "2026-10-13T12:00:00Z" -> "2026-10-13T12:00:00.000Z"
  if (rfc3339.size() == 20 && rfc3339.back() == 'Z') return rfc3339.substr(0, 19) + ".000Z";
  return rfc3339;
}

struct Finished {
  std::vector<Site> sites;
  std::vector<uint8_t> sitStream, gnpStream;
  Json report;
};

inline bool evidenceLess(const Evidence& a, const Evidence& b) {
  if (a.cit.source != b.cit.source) return a.cit.source < b.cit.source;
  if (a.cit.recordId != b.cit.recordId) return a.cit.recordId < b.cit.recordId;
  if (a.date != b.date) return a.date < b.date;
  if (a.cit.field != b.cit.field) return a.cit.field < b.cit.field;
  return a.status < b.status;
}

inline Finished finish(State& st, const std::string& producer) {
  Finished out;
  ReconcileReport rep;
  Json changedRevisions = Json::array();
  std::set<std::string> openSeen;
  std::set<std::string> dismantlingReviewed;
  for (const auto& d : reg::kDismantlingReviewed) dismantlingReviewed.insert(std::string(d.qid) + "|" + d.recordId + "|" + d.phrase);
  for (auto& s : st.sites) {
    if (s.name.empty()) { rep.unnamed++; rep.droppedRows.push_back({{"id", s.id}, {"why", "no name in any language"}}); continue; }
    const std::string qid = s.qid();
    if (!qid.empty() && startsWith(s.id, "wikidata:") && notAFacility(qid)) { rep.dropped++; rep.droppedRows.push_back({{"id", s.id}, {"why", "not a facility (register)"}}); continue; }
    const bool placemark = startsWith(s.id, "geonames:");
    const bool organisation = organisationSet(s.catcode) && s.siteKind != "research reactor";
    const std::string factKey = placemark ? qid : qid;
    RowResult r = placemark ? reconcilePlacemark(st, s) : reconcileRow(st, s.catcode, s.siteKind, s.evidence, factKey, organisation);
    // NPP stations follow their tracker units as stations do (a station runs while any unit runs).
    if (!placemark && s.catcode == "NPP" && r.decided.rule != "reviewed") {
      const Ev* line = nullptr;
      for (const auto& v : r.evidence) if (v.cit.source == "gem-gnpt" && v.cit.field == "units") { line = &v; break; }
      if (line && currentAtGem(line->status) && line->status != r.decided.status && !placemarkUnitLevel(s.name)) {
        std::vector<std::string> same;
        for (const auto& v : r.evidence) if (v.status == line->status && !v.date.empty()) same.push_back(v.date);
        std::sort(same.begin(), same.end());
        r.decided = {line->status, !same.empty() ? same[0] : (line->status == OPERATING ? r.started : ""), "station units"};
      }
    }
    // The review queue: prose statements the decided status leaves open.
    for (const auto& e : s.evidence) {
      if (!startsWith(e.cit.field, "prose:")) continue;
      const bool started = e.status == DECOMMISSIONING;
      const bool open = started ? r.decided.status == PERMANENT_SHUTDOWN
                                : (r.decided.status == PERMANENT_SHUTDOWN || r.decided.status == DECOMMISSIONING || r.decided.status == LONG_TERM_SHUTDOWN || r.decided.status == UNSPECIFIED);
      if (!open) continue;
      const std::string phrase = e.cit.field.substr(6);
      if (dismantlingReviewed.count(qid + "|" + e.cit.recordId + "|" + phrase) || dismantlingReviewed.count(s.id + "|" + e.cit.recordId + "|" + phrase)) continue;
      const std::string key = s.id + "|" + e.cit.recordId + "|" + phrase;
      if (openSeen.count(key)) continue;
      openSeen.insert(key);
      rep.open.push_back({{"id", s.id}, {"name", s.name}, {"status", statusName(r.decided.status)}, {"kind", started ? "started" : "completed"},
                          {"record", e.cit.recordId}, {"revision", e.cit.version}, {"phrase", phrase}, {"date", e.date}});
    }
    // Reviewed facts whose article has a newer revision than the one read by hand.
    for (const auto& f : reg::kFacts) {
      if ((f.qid != qid && f.qid != s.id) || std::string(f.source) != "wikipedia") continue;
      const std::string record = std::string(f.wiki) + ":" + f.title;
      for (const auto& e : s.evidence)
        if (e.cit.source == "wikipedia" && e.cit.recordId == record && !e.cit.version.empty() && e.cit.version != f.revision) {
          changedRevisions.push_back({{"id", s.id}, {"record", record}, {"reviewed", f.revision}, {"current", e.cit.version}, {"reviewedAt", f.reviewedAt}});
          break;
        }
    }
    Site o = s;
    o.lifecycle = r.decided.status;
    o.lifecycleDate = r.decided.date;
    o.operationalStatus = lifecycleLabel(r.decided.status);
    o.establishmentDate = r.started;
    o.evidence.clear();
    std::string verified = st.runAt;
    for (const auto& v : r.evidence) {
      if (v.renamed) { o.evidence.push_back({v.status, v.date, v.cit}); continue; }
      o.evidence.push_back({v.status, v.date, v.cit});
      if (r.decided.rule == "reviewed" && v.reviewed) verified = v.cit.retrievedAt;
    }
    if (o.lifecycle == UNVERIFIED) {
      if (!qid.empty() && !placemark) o.evidence.push_back({UNVERIFIED, "", cite("wikidata", qid, wikidataUrl(qid), "", "", st.runAt)});
      else if (qid.empty()) o.evidence.push_back({UNVERIFIED, "", cite(o.network == networkName("SPACE") ? "space-sites" : "spaceaware-curated", o.id,
                                                                             registerUrl(o.network == networkName("SPACE") ? "space-sites.json" : "curated.json"), "", "register:" + std::string(o.network == networkName("SPACE") ? "space-sites" : "curated"), st.runAt)});
    }
    o.verifiedAt = verified;
    // Citations: the Wikidata version of a reviewed fact's item is its own revision; drop duplicate statements.
    std::sort(o.evidence.begin(), o.evidence.end(), evidenceLess);
    o.evidence.erase(std::unique(o.evidence.begin(), o.evidence.end(), [](const Evidence& a, const Evidence& b) {
                       return a.status == b.status && a.date == b.date && a.cit.source == b.cit.source && a.cit.recordId == b.cit.recordId && a.cit.field == b.cit.field;
                     }), o.evidence.end());
    // References: no working entries; articles in English and the country's language.
    const std::string a2 = alpha2OfNumeric(o.ctrId);
    const std::string local = localLanguage(a2);
    std::vector<Reference> refs;
    std::set<std::string> seen;
    for (const auto& ref : o.refs) {
      if (ref.role == REF_UNSPECIFIED) continue;
      if (ref.role == REF_ENCYCLOPEDIA_ARTICLE && ref.language != "en" && ref.language != local) continue;
      const std::string key = std::to_string(ref.role) + "|" + ref.registry + "|" + ref.recordId + "|" + ref.url;
      if (seen.count(key)) continue;
      seen.insert(key);
      refs.push_back(ref);
    }
    for (const auto& d : reg::kDockets)
      if (!qid.empty() && qid == d.wikidata) refs.push_back({REF_REGULATORY_DOCKET, "us-nrc", d.docket, d.url, d.unit, "en"});
    std::stable_sort(refs.begin(), refs.end(), [](const Reference& a, const Reference& b) { return a.role < b.role; });
    o.refs = refs;
    std::vector<Party> parties;
    std::set<std::string> partySeen;
    for (const auto& p : o.parties) {
      if (p.name.empty()) continue;
      const std::string key = std::to_string(p.role) + "|" + p.name;
      if (partySeen.count(key)) continue;
      partySeen.insert(key);
      parties.push_back(p);
    }
    std::stable_sort(parties.begin(), parties.end(), [](const Party& a, const Party& b) { return a.role < b.role; });
    o.parties = parties;
    if (o.descriptionCitation.empty()) { o.description.clear(); o.descriptionLanguage.clear(); }
    o.source = sourceLine(o);
    recordTerms(o);
    if (o.ctrId.empty()) rep.noCountry++;
    bool record = false;
    for (const auto& ref : o.refs) if (ref.role == REF_RECORD) record = true;
    if (!record) rep.noRecord++;
    if (reactorSet(o.catcode) && o.lifecycleDate.empty() && o.lifecycle != UNSPECIFIED) rep.undatedNuclear++;
    rep.byStatus[statusName(o.lifecycle)]++;
    rep.byNetwork[o.network]++;
    rep.byRule[r.decided.rule]++;
    out.sites.push_back(std::move(o));
  }
  std::sort(out.sites.begin(), out.sites.end(), [](const Site& a, const Site& b) { return a.id < b.id; });
  SiteWriter w;
  for (const auto& s : out.sites) w.append(s, out.sitStream);

  // The search projection: what stands or is to come, never what has gone.
  flatbuffers::FlatBufferBuilder b(2048);
  // Each row credits the source of its own record (the full list is in each $SIT record's citations).
  auto rowCredit = [](const Site& s) -> std::string {
    std::string source = "space-sites";
    if (startsWith(s.id, "wikidata:")) source = "wikidata";
    else if (startsWith(s.id, "geonames:")) source = "geonames";
    else if (startsWith(s.id, "gem:")) source = "gem-gnpt";
    else if (s.network != networkName("SPACE")) source = "spaceaware-curated";
    const reg::Source* src = regSource(source);
    return src ? (*src->credit ? src->credit : src->attribution) : "";
  };
  size_t places = 0;
  for (const auto& s : out.sites) {
    if (historicView(s.lifecycle)) continue;
    b.Clear();
    const std::string a2 = alpha2OfNumeric(s.ctrId);
    std::string code;
    if (startsWith(s.catcode, "S.")) code = s.catcode.substr(2);
    else if (startsWith(s.id, "geonames:")) { const reg::Placemark* p = placemarkOf(s.id); code = p ? p->code : "PSN"; }
    else if (s.catcode == "NPP") code = "PSN";
    else code = s.catcode;
    std::string admin1;
    if (const reg::Placemark* p = placemarkOf(s.id)) admin1 = p->admin1;
    for (const auto& sp : reg::kSpaceSites) if (s.id == "wikidata:" + std::string(sp.wikidata) || s.id == "sdn-site:" + slug(sp.name)) admin1 = sp.admin1;
    auto str = [&](const std::string& v) { return v.empty() ? flatbuffers::Offset<flatbuffers::String>() : b.CreateString(v); };
    auto dsId = b.CreateString(kProviderId), dsName = b.CreateString("SDN site registry"), epoch = b.CreateString(fixedMs(st.runAt)),
         at = b.CreateString(fixedMs(st.runAt)), license = b.CreateString(s.licenseId == "CC0-1.0" ? "CC0 1.0" : "CC BY 4.0"),
         licenseUrl = b.CreateString(s.licenseId == "CC0-1.0" ? "https://creativecommons.org/publicdomain/zero/1.0/" : "https://creativecommons.org/licenses/by/4.0/"),
         attr = b.CreateString(rowCredit(s)), native = b.CreateString(s.id);
    GNPProvenanceBuilder pb(b);
    pb.add_DATASET_ID(dsId);
    pb.add_DATASET_NAME(dsName);
    pb.add_DATASET_EPOCH(epoch);
    pb.add_RETRIEVED_AT(at);
    pb.add_LICENSE(license);
    pb.add_LICENSE_URL(licenseUrl);
    pb.add_ATTRIBUTION(attr);
    pb.add_NATIVE_ID(native);
    const auto prov = pb.Finish();
    auto id = b.CreateString(s.id), name = b.CreateString(s.name), ascii = str(s.abbreviation), fcc = b.CreateString("S"), fc = str(code), fn = str(s.siteKind),
         cc = str(a2), cn = str(countryName(a2)), a1 = str(admin1);
    GNPBuilder g(b);
    g.add_ID(id);
    g.add_NAME(name);
    g.add_ASCII_NAME(ascii);
    g.add_LATITUDE(s.lat);
    g.add_LONGITUDE(s.lon);
    g.add_FEATURE_CLASS(gnpFeatureClass::SPOT);
    g.add_FEATURE_CLASS_CODE(fcc);
    g.add_FEATURE_CODE(fc);
    g.add_FEATURE_NAME(fn);
    g.add_COUNTRY_CODE(cc);
    g.add_COUNTRY_NAME(cn);
    g.add_ADMIN1_NAME(a1);
    g.add_SOURCE(prov);
    b.FinishSizePrefixed(g.Finish(), "$GNP");
    out.gnpStream.insert(out.gnpStream.end(), b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
    ++places;
  }
  Json byStatus = Json::object(), byNetwork = Json::object(), byRule = Json::object();
  for (auto& [k, v] : rep.byStatus) byStatus[k] = v;
  for (auto& [k, v] : rep.byNetwork) byNetwork[k] = v;
  for (auto& [k, v] : rep.byRule) byRule[k] = v;
  out.report = {{"lane", std::string(kProviderId) + "/" + kSitesLane}, {"run_at", st.runAt}, {"producer_peer_id", producer},
                {"records", out.sites.size()}, {"places", places}, {"sit_bytes", out.sitStream.size()}, {"gnp_bytes", out.gnpStream.size()},
                {"by_status", byStatus}, {"by_network", byNetwork}, {"by_rule", byRule},
                {"undated_nuclear", rep.undatedNuclear}, {"no_country", rep.noCountry}, {"no_record_reference", rep.noRecord},
                {"dropped", rep.droppedRows}, {"review_queue", rep.open}, {"reviewed_revisions_changed", changedRevisions}};
  return out;
}

}  // namespace sr
