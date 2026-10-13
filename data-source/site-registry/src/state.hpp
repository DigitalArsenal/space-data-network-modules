// The site record the stages build, and its SDS encodings: the $SIT 1.1.0
// record (the lane and the state carried from stage to stage) and the $GNP
// search projection.
//
// Working state rides in the $SIT stream itself, so no other frame type
// crosses a stage: while a run is under way STATUS_VERIFIED_AT holds the run
// time; evidence with STATUS UNSPECIFIED (unit-date markers) or a
// "prose:" field (review-queue statements), references with ROLE UNSPECIFIED
// and parties without a NAME are working entries the reconcile stage drops
// before it publishes.
#pragma once
#include <cmath>
#include <map>
#include <string>
#include <vector>

#include "rules.hpp"

namespace sr {

enum SiteTypeCode : int8_t {
  ST_LAUNCH_SITE = 0, ST_OBSERVATION_STATION, ST_HOBBYIST_OBSERVER, ST_RESEARCH_FACILITY, ST_SATELLITE_GROUND_STATION, ST_SPACEPORT,
  ST_MILITARY_BASE, ST_WEATHER_STATION, ST_ASTRONOMICAL_OBSERVATORY, ST_EDUCATIONAL_INSTITUTE, ST_COMMUNICATION_HUB, ST_POWER_PLANT,
  ST_INDUSTRIAL_COMPLEX, ST_TRANSPORTATION_HUB, ST_URBAN_AREA, ST_NATIONAL_PARK, ST_HISTORICAL_SITE, ST_OTHER,
};
enum RefRole : int8_t { REF_UNSPECIFIED = 0, REF_RECORD, REF_OFFICIAL_WEBSITE, REF_ENCYCLOPEDIA_ARTICLE, REF_REGISTRY_RECORD, REF_REGULATORY_DOCKET };
enum PartyRole : int8_t { PARTY_UNSPECIFIED = 0, PARTY_OPERATOR, PARTY_OWNER, PARTY_REGULATOR };
enum QuantityKind : int8_t { Q_UNSPECIFIED = 0, Q_ELECTRICAL_CAPACITY, Q_THERMAL_POWER, Q_REACTOR_UNITS, Q_ELEVATION };

struct Citation {
  std::string source, recordId, url, version, field, retrievedAt;
  bool empty() const { return source.empty(); }
};
struct Evidence {
  int status = UNSPECIFIED;
  std::string date;
  Citation cit;
};
struct Reference {
  int role = REF_UNSPECIFIED;
  std::string registry, recordId, url, title, language;
};
struct Party {
  int role = PARTY_UNSPECIFIED;
  std::string name;
  std::vector<Reference> refs;
  Citation cit;
};
struct Quantity {
  int kind = Q_UNSPECIFIED;
  double value = NAN;
  std::string units, date;
  Citation cit;
};

struct Site {
  std::string id, name, abbreviation, catcode, network;
  int siteType = ST_OTHER;
  double lat = NAN, lon = NAN, alt = NAN;
  std::string ctrId, description, source, operationalStatus, establishmentDate;
  std::string createdBy;  // working: the producer peer, on the first row of the state
  int lifecycle = UNSPECIFIED;
  std::string lifecycleDate, verifiedAt;
  std::vector<Evidence> evidence;
  std::string siteKind, descriptionLanguage;
  Citation descriptionCitation, positionCitation;
  std::vector<Reference> refs;
  std::vector<Party> parties;
  std::vector<Quantity> quantities;
  std::string licenseClass, licenseId;  // record PROVENANCE terms (set at reconcile)

  // The record's Wikidata item: its id ("wikidata:Q…") or a joined registry reference.
  std::string qid() const {
    if (startsWith(id, "wikidata:")) return id.substr(9);
    for (const auto& r : refs) if (r.registry == "wikidata" && (r.role == REF_RECORD || r.role == REF_REGISTRY_RECORD)) return r.recordId;
    return "";
  }
  const Reference* ref(int role, const std::string& registry) const {
    for (const auto& r : refs) if (r.role == role && r.registry == registry) return &r;
    return nullptr;
  }
};

// The terms of a register source (register/sources.json).
struct SourceTerms {
  std::string id, name, licenseClass, licenseId, attribution, version, recordUrl;
};
inline const SourceTerms* sourceTerms(const std::string& id);  // defined with the generated register

inline int8_t licenseClassCode(const std::string& c) {
  if (c == "Reproducible") return 1;
  if (c == "CiteOnly") return 2;
  if (c == "ShareAlike") return 3;
  if (c == "NonCommercial") return 4;
  return 0;
}
inline const char* licenseClassName(int8_t c) {
  switch (c) { case 1: return "Reproducible"; case 2: return "CiteOnly"; case 3: return "ShareAlike"; case 4: return "NonCommercial"; default: return "Unspecified"; }
}

constexpr const char* kProviderId = "sdn-site-registry";
constexpr const char* kProducer = "site-registry 0.1.0";

// ── encode ─────────────────────────────────────────────────────────────────
class SiteWriter {
 public:
  // One size-prefixed $SIT frame.
  void append(const Site& s, std::vector<uint8_t>& out) {
    b_.Clear();
    pvnCache_.clear();
    auto off = encode(s);
    b_.FinishSizePrefixed(off, "$SIT");
    out.insert(out.end(), b_.GetBufferPointer(), b_.GetBufferPointer() + b_.GetSize());
  }

 private:
  flatbuffers::FlatBufferBuilder b_{4096};
  // One PVN table per source within a record: every citation of that source points at it.
  std::map<std::string, flatbuffers::Offset<PVN>> pvnCache_;

  flatbuffers::Offset<flatbuffers::String> str(const std::string& v) { return v.empty() ? 0 : b_.CreateSharedString(v); }

  flatbuffers::Offset<PVN> pvn(const std::string& sourceId, const std::string& licenseClass = "", const std::string& licenseId = "") {
    const SourceTerms* t = sourceTerms(sourceId);
    const std::string cls = licenseClass.empty() ? (t ? t->licenseClass : "") : licenseClass;
    const std::string lic = licenseId.empty() ? (t ? t->licenseId : "") : licenseId;
    auto sid = str(sourceId), orig = str(t ? t->name : sourceId), prov = str(kProviderId), prod = str(kProducer), lid = str(lic), lin = str(sourceId);
    PVNBuilder p(b_);
    p.add_SOURCE_ID(sid);
    p.add_SOURCE_KIND(pvnSourceKind::Reference);
    p.add_ORIGINATOR(orig);
    p.add_PROVIDER_ID(prov);
    p.add_PRODUCER(prod);
    p.add_LICENSE_CLASS(static_cast<pvnLicenseClass>(licenseClassCode(cls)));
    p.add_LICENSE_ID(lid);
    p.add_LINEAGE(lin);
    return p.Finish();
  }

  flatbuffers::Offset<SITCitation> citation(const Citation& c) {
    if (c.empty()) return 0;
    auto cached = pvnCache_.find(c.source);
    auto p = cached != pvnCache_.end() ? cached->second : (pvnCache_[c.source] = pvn(c.source));
    auto rid = str(c.recordId), url = str(c.url), ver = str(c.version), field = str(c.field), at = str(c.retrievedAt);
    SITCitationBuilder cb(b_);
    cb.add_PROVENANCE(p);
    cb.add_SOURCE_RECORD_ID(rid);
    cb.add_SOURCE_URL(url);
    cb.add_SOURCE_VERSION(ver);
    cb.add_SOURCE_FIELD(field);
    cb.add_RETRIEVED_AT(at);
    return cb.Finish();
  }

  flatbuffers::Offset<SITReference> reference(const Reference& r) {
    auto reg = str(r.registry), rid = str(r.recordId), url = str(r.url), title = str(r.title), lang = str(r.language);
    SITReferenceBuilder rb(b_);
    rb.add_ROLE(static_cast<sitReferenceRole>(r.role));
    rb.add_REGISTRY(reg);
    rb.add_RECORD_ID(rid);
    rb.add_URL(url);
    rb.add_TITLE(title);
    rb.add_LANGUAGE(lang);
    return rb.Finish();
  }

  flatbuffers::Offset<SIT> encode(const Site& s) {
    std::vector<flatbuffers::Offset<SITStatusEvidence>> ev;
    for (const auto& e : s.evidence) {
      auto c = citation(e.cit);
      auto d = str(e.date);
      SITStatusEvidenceBuilder eb(b_);
      eb.add_STATUS(static_cast<siteLifecycleStatus>(e.status));
      eb.add_STATUS_DATE(d);
      eb.add_CITATION(c);
      ev.push_back(eb.Finish());
    }
    std::vector<flatbuffers::Offset<SITReference>> refs;
    for (const auto& r : s.refs) refs.push_back(reference(r));
    std::vector<flatbuffers::Offset<SITParty>> parties;
    for (const auto& p : s.parties) {
      std::vector<flatbuffers::Offset<SITReference>> pr;
      for (const auto& r : p.refs) pr.push_back(reference(r));
      auto prv = pr.empty() ? 0 : b_.CreateVector(pr);
      auto c = citation(p.cit);
      auto n = str(p.name);
      SITPartyBuilder pb(b_);
      pb.add_ROLE(static_cast<sitPartyRole>(p.role));
      pb.add_NAME(n);
      pb.add_EXTERNAL_REFERENCES(prv);
      pb.add_CITATION(c);
      parties.push_back(pb.Finish());
    }
    std::vector<flatbuffers::Offset<SITQuantity>> qs;
    for (const auto& q : s.quantities) {
      auto c = citation(q.cit);
      auto u = str(q.units), d = str(q.date);
      SITQuantityBuilder qb(b_);
      qb.add_KIND(static_cast<sitQuantityKind>(q.kind));
      qb.add_VALUE(q.value);
      qb.add_UNITS(u);
      qb.add_DATE(d);
      qb.add_CITATION(c);
      qs.push_back(qb.Finish());
    }
    auto evv = ev.empty() ? 0 : b_.CreateVector(ev);
    auto refv = refs.empty() ? 0 : b_.CreateVector(refs);
    auto partyv = parties.empty() ? 0 : b_.CreateVector(parties);
    auto qv = qs.empty() ? 0 : b_.CreateVector(qs);
    auto descCit = citation(s.descriptionCitation), posCit = citation(s.positionCitation);
    flatbuffers::Offset<PVN> prov = 0;
    if (!s.licenseId.empty()) prov = pvn(kProviderId, s.licenseClass, s.licenseId);
    auto id = str(s.id), name = str(s.name), abbr = str(s.abbreviation), cat = str(s.catcode), net = str(s.network), ctr = str(s.ctrId),
         desc = str(s.description), src = str(s.source), by = str(s.createdBy), op = str(s.operationalStatus), est = str(s.establishmentDate), ld = str(s.lifecycleDate),
         va = str(s.verifiedAt), kind = str(s.siteKind), dl = str(s.descriptionLanguage);
    SITBuilder sb(b_);
    sb.add_ID(id);
    sb.add_NAME(name);
    sb.add_ABBREVIATION(abbr);
    sb.add_SITE_TYPE(static_cast<SiteType>(s.siteType));
    sb.add_CATCODE(cat);
    sb.add_NETWORK(net);
    if (!std::isnan(s.lat)) sb.add_LATITUDE(float(s.lat));
    if (!std::isnan(s.lon)) sb.add_LONGITUDE(float(s.lon));
    sb.add_ALTITUDE(std::isnan(s.alt) ? std::numeric_limits<float>::quiet_NaN() : float(s.alt));
    sb.add_CTR_ID(ctr);
    sb.add_CREATED_BY(by);
    sb.add_DESCRIPTION(desc);
    sb.add_SOURCE(src);
    sb.add_OPERATIONAL_STATUS(op);
    sb.add_ESTABLISHMENT_DATE(est);
    sb.add_LIFECYCLE_STATUS(static_cast<siteLifecycleStatus>(s.lifecycle));
    sb.add_LIFECYCLE_STATUS_DATE(ld);
    sb.add_STATUS_VERIFIED_AT(va);
    sb.add_STATUS_EVIDENCE(evv);
    sb.add_SITE_KIND(kind);
    sb.add_DESCRIPTION_LANGUAGE(dl);
    sb.add_DESCRIPTION_CITATION(descCit);
    sb.add_POSITION_CITATION(posCit);
    sb.add_EXTERNAL_REFERENCES(refv);
    sb.add_PARTIES(partyv);
    sb.add_QUANTITIES(qv);
    sb.add_PROVENANCE(prov);
    return sb.Finish();
  }
};

// ── decode ─────────────────────────────────────────────────────────────────
inline std::string s8(const flatbuffers::String* v) { return v ? v->str() : std::string(); }

inline Citation readCitation(const SITCitation* c) {
  Citation out;
  if (!c) return out;
  out.source = c->PROVENANCE() ? s8(c->PROVENANCE()->SOURCE_ID()) : "";
  out.recordId = s8(c->SOURCE_RECORD_ID());
  out.url = s8(c->SOURCE_URL());
  out.version = s8(c->SOURCE_VERSION());
  out.field = s8(c->SOURCE_FIELD());
  out.retrievedAt = s8(c->RETRIEVED_AT());
  return out;
}
inline Reference readReference(const SITReference* r) {
  Reference out;
  out.role = int(r->ROLE());
  out.registry = s8(r->REGISTRY());
  out.recordId = s8(r->RECORD_ID());
  out.url = s8(r->URL());
  out.title = s8(r->TITLE());
  out.language = s8(r->LANGUAGE());
  return out;
}

inline Site readSite(const SIT* t) {
  Site s;
  s.id = s8(t->ID());
  s.name = s8(t->NAME());
  s.abbreviation = s8(t->ABBREVIATION());
  s.siteType = int(t->SITE_TYPE());
  s.catcode = s8(t->CATCODE());
  s.network = s8(t->NETWORK());
  s.lat = t->LATITUDE();
  s.lon = t->LONGITUDE();
  s.alt = t->ALTITUDE();
  s.ctrId = s8(t->CTR_ID());
  s.createdBy = s8(t->CREATED_BY());
  s.description = s8(t->DESCRIPTION());
  s.source = s8(t->SOURCE());
  s.operationalStatus = s8(t->OPERATIONAL_STATUS());
  s.establishmentDate = s8(t->ESTABLISHMENT_DATE());
  s.lifecycle = int(t->LIFECYCLE_STATUS());
  s.lifecycleDate = s8(t->LIFECYCLE_STATUS_DATE());
  s.verifiedAt = s8(t->STATUS_VERIFIED_AT());
  if (t->STATUS_EVIDENCE())
    for (const auto* e : *t->STATUS_EVIDENCE()) s.evidence.push_back({int(e->STATUS()), s8(e->STATUS_DATE()), readCitation(e->CITATION())});
  s.siteKind = s8(t->SITE_KIND());
  s.descriptionLanguage = s8(t->DESCRIPTION_LANGUAGE());
  s.descriptionCitation = readCitation(t->DESCRIPTION_CITATION());
  s.positionCitation = readCitation(t->POSITION_CITATION());
  if (t->EXTERNAL_REFERENCES()) for (const auto* r : *t->EXTERNAL_REFERENCES()) s.refs.push_back(readReference(r));
  if (t->PARTIES())
    for (const auto* p : *t->PARTIES()) {
      Party party;
      party.role = int(p->ROLE());
      party.name = s8(p->NAME());
      if (p->EXTERNAL_REFERENCES()) for (const auto* r : *p->EXTERNAL_REFERENCES()) party.refs.push_back(readReference(r));
      party.cit = readCitation(p->CITATION());
      s.parties.push_back(party);
    }
  if (t->QUANTITIES())
    for (const auto* q : *t->QUANTITIES()) s.quantities.push_back({int(q->KIND()), q->VALUE(), s8(q->UNITS()), s8(q->DATE()), readCitation(q->CITATION())});
  if (t->PROVENANCE()) {
    s.licenseId = s8(t->PROVENANCE()->LICENSE_ID());
    s.licenseClass = licenseClassName(int8_t(t->PROVENANCE()->LICENSE_CLASS()));
  }
  return s;
}

// A size-prefixed $SIT stream -> sites. False when a frame does not verify.
inline bool readSites(const uint8_t* p, size_t n, std::vector<Site>& out, std::string& error) {
  size_t at = 0;
  while (at + 4 <= n) {
    const uint32_t size = uint32_t(p[at]) | uint32_t(p[at + 1]) << 8 | uint32_t(p[at + 2]) << 16 | uint32_t(p[at + 3]) << 24;
    if (size < 8 || at + 4 + size > n) { error = "A $SIT frame is truncated."; return false; }
    const uint8_t* frame = p + at + 4;
    // Frames sit back to back in the stream, so a frame is not 8-byte aligned: verify without the alignment check.
    flatbuffers::Verifier v(frame, size, flatbuffers::Verifier::Options{64, 1000000, false, true, 1ull << 30});
    if (!flatbuffers::BufferHasIdentifier(frame, "$SIT") || !v.VerifyBuffer<SIT>("$SIT")) { error = "A $SIT frame does not verify."; return false; }
    out.push_back(readSite(flatbuffers::GetRoot<SIT>(frame)));
    at += 4 + size;
  }
  if (at != n) { error = "The $SIT stream has trailing bytes."; return false; }
  return true;
}

}  // namespace sr
