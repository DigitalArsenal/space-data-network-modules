// The site-registry retrieval stages. Each stage takes the $SIT stream built
// so far (the state) and the HTTP answers to the requests the stage before it
// made, folds them in, and asks for the next ones (at most 60, the flow
// runtime hands a node at most 64 frames). Which requests a stage made is
// recomputed from the state, so nothing but the $SIT stream crosses a stage.
//
//   plan        the register rows; SPARQL class membership and the
//               register items' settlement check
//   entities_a  class members -> rows; Wikidata items, first third
//   entities_b  items, second third
//   entities_c  items, last third
//   parties     operators, owners and regulators (labels, websites), the
//               country of rows no item names one for, the GEM tracker and
//               the newest ROR release record
//   articles_a  parties, GEM, ROR record; Wikipedia articles, first third,
//               and the ROR dump
//   articles_b  articles and the ROR dump; second third
//   articles_c  articles, last third
//   finish      reconcile: one cited lifecycle per site, references, parties
//               and quantities; the $SIT lane, the $GNP search projection,
//               the ingest meta and the run report
//
// Every request names its own URL (sdn-req=<stage>-<n>) and states its own
// validator (If-Modified-Since: the epoch), so the host's per-URL
// If-None-Match never answers one request with another's ETag. A non-2xx
// answer, a MediaWiki maxlag or an unfinished (continued) answer fails the
// stage: nothing is published from a partial read. Wikipedia reads carry
// maxlag=5; Wikidata reads do not, because wikidata.org counts the query
// service's replication lag (routinely minutes) in maxlag, which would fail
// most runs for a lag that does not affect what wbgetentities answers.
#pragma once
#include <algorithm>
#include <map>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

namespace sr {
using Json = nlohmann::json;

constexpr const char* kUserAgent = "SDN-site-registry/0.1.0 (+https://spacedatanetwork.org)";
constexpr const char* kFresh = "Thu, 01 Jan 1970 00:00:00 GMT";
constexpr size_t kMaxRequests = 60;
constexpr size_t kEntityBatch = 50;
constexpr size_t kArticleBatch = 50;
constexpr size_t kSparqlBatch = 400;
constexpr int kStages = 3;  // entity and article stages each
constexpr const char* kSitesLane = "sites";
constexpr const char* kPlacesLane = "site-places";
inline const std::vector<std::string>& wikiLangs() {
  static const std::vector<std::string> v{"en", "de", "fr", "ru", "ja", "es", "it", "nl", "sv", "pl", "cs", "uk", "zh"};
  return v;
}
inline const std::vector<std::string>& labelLangs() {
  static const std::vector<std::string> v{"mul", "en", "fr", "de", "es", "it", "pt", "nl", "sv", "pl", "cs", "ru", "uk", "ja", "zh", "ko", "ar", "fa", "hi"};
  return v;
}

// ── frames in and out ──────────────────────────────────────────────────────
struct Frame { std::string port; const uint8_t* data = nullptr; size_t size = 0; };
struct Output { std::string port; std::vector<uint8_t> bytes; bool flatbuffer = false; std::string schema, fileId, root; };
struct StageIO {
  std::vector<Frame> inputs;
  std::vector<Output> outputs;
  std::string error;
  std::vector<const Frame*> port(const std::string& name) const {
    std::vector<const Frame*> out;
    for (const auto& f : inputs) if (f.port == name) out.push_back(&f);
    return out;
  }
  void json(const std::string& port, const Json& value) {
    const std::string text = value.dump();
    outputs.push_back({port, std::vector<uint8_t>(text.begin(), text.end())});
  }
  void fb(const std::string& port, std::vector<uint8_t> bytes, const char* schema, const char* fileId, const char* root) {
    outputs.push_back({port, std::move(bytes), true, schema, fileId, root});
  }
  bool fail(const std::string& message) { error = message; return false; }
};

struct Response { int status = 0; std::string_view body; };

inline bool readResponses(const StageIO& io, size_t expected, std::vector<Response>& out, std::string& error) {
  const auto frames = io.port("response");
  if (frames.size() != expected) { error = "Expected " + std::to_string(expected) + " HTTP responses, got " + std::to_string(frames.size()) + "."; return false; }
  for (const auto* f : frames) {
    if (f->size < 8 || std::memcmp(f->data, "$HRB", 4) != 0) { error = "Expected raw-body-v1 HTTP responses."; return false; }
    const int32_t status = int32_t(uint32_t(f->data[4]) | uint32_t(f->data[5]) << 8 | uint32_t(f->data[6]) << 16 | uint32_t(f->data[7]) << 24);
    out.push_back({status, std::string_view(reinterpret_cast<const char*>(f->data + 8), f->size - 8)});
  }
  return true;
}

// ── requests ───────────────────────────────────────────────────────────────
struct Request {
  std::string method = "GET", url, body, accept = "application/json", contentType;
  size_t maxBytes = 99u * 1024u * 1024u;
  int timeoutMs = 120000;
};
inline Json describe(const Request& r) {
  Json headers = {{"User-Agent", kUserAgent}, {"Accept", r.accept}, {"If-Modified-Since", kFresh}};
  if (!r.contentType.empty()) headers["Content-Type"] = r.contentType;
  Json j = {{"method", r.method}, {"url", r.url}, {"headers", headers}, {"timeoutMs", r.timeoutMs}, {"maxBytes", r.maxBytes}, {"responseWire", "raw-body-v1"}};
  if (!r.body.empty()) j["bodyB64"] = base64(reinterpret_cast<const uint8_t*>(r.body.data()), r.body.size());
  return j;
}
inline Request sparql(const std::string& query, const std::string& tag) {
  Request r;
  r.method = "POST";
  r.url = "https://query.wikidata.org/sparql?sdn-req=" + tag;
  r.accept = "application/sparql-results+json";
  r.contentType = "application/x-www-form-urlencoded";
  r.body = "query=" + encodeForm(query) + "&format=json";
  return r;
}
// A tiny answer for a stage with nothing left to ask: every stage asks at least once.
inline Request idle(const std::string& tag) {
  Request r;
  r.url = "https://www.wikidata.org/w/api.php?action=query&meta=siteinfo&siprop=general&format=json&sdn-req=" + tag;
  r.maxBytes = 1u << 20;
  return r;
}

// ── register lookups ───────────────────────────────────────────────────────
inline std::string networkName(const std::string& code) {
  for (const auto& n : reg::kNetworks) if (code == n.code) return n.name;
  return code;
}
inline std::string numericCountry(const std::string& a2) {
  for (const auto& c : reg::kCountries) if (a2 == c.a2) return c.numeric;
  return "";
}
inline std::string alpha2OfNumeric(const std::string& numeric) {
  for (const auto& c : reg::kCountries) if (numeric == c.numeric && *c.numeric) return c.a2;
  return "";
}
inline std::string alpha2OfItem(const std::string& qid) {
  for (const auto& c : reg::kCountries) if (qid == c.qid) return c.a2;
  return "";
}
inline std::string alpha2OfName(const std::string& name) {
  for (const auto& a : reg::kCountryAliases) if (name == a.key) return a.value;
  for (const auto& c : reg::kCountries) if (name == c.name) return c.a2;
  return "";
}
inline std::string localLanguage(const std::string& a2) {
  for (const auto& l : reg::kLanguages) if (a2 == l.key) return l.value;
  return "";
}
inline const reg::Source* regSource(const std::string& id) {
  for (const auto& s : reg::kSources) if (id == s.id) return &s;
  return nullptr;
}
inline const SourceTerms* sourceTerms(const std::string& id) {
  static std::map<std::string, SourceTerms> cache;
  auto it = cache.find(id);
  if (it != cache.end()) return &it->second;
  const reg::Source* s = regSource(id);
  if (!s) {
    if (id != kProviderId) return nullptr;
    return &cache.emplace(id, SourceTerms{id, "Space Data Network site register", "Reproducible", "", "", "", ""}).first->second;
  }
  return &cache.emplace(id, SourceTerms{s->id, s->name, s->licenseClass, s->licenseId, s->attribution, s->version, s->recordUrl}).first->second;
}
inline std::string sourceVersion(const std::string& id) {
  const reg::Source* s = regSource(id);
  return s ? s->version : "";
}

inline Citation cite(const std::string& source, const std::string& recordId, const std::string& url, const std::string& version, const std::string& field, const std::string& at) {
  return Citation{source, recordId, url, version, field, at};
}
inline std::string wikidataUrl(const std::string& qid) { return "https://www.wikidata.org/wiki/" + qid; }
inline std::string revisionUrl(const std::string& lang, const std::string& title, const std::string& revision) {
  return "https://" + lang + ".wikipedia.org/w/index.php?title=" + encodeComponent(replaceAll(title, " ", "_")) + "&oldid=" + revision;
}

// ── the run's state ────────────────────────────────────────────────────────
struct State {
  std::vector<Site> sites;
  std::string runAt;  // RFC 3339
  int nowYear = 0;
  std::unordered_map<std::string, size_t> byId;
  void index() { byId.clear(); for (size_t i = 0; i < sites.size(); ++i) byId[sites[i].id] = i; }
  Site* find(const std::string& id) { auto it = byId.find(id); return it == byId.end() ? nullptr : &sites[it->second]; }
};

inline bool loadState(const StageIO& io, State& st, std::string& error) {
  const auto frames = io.port("state");
  if (frames.size() != 1) { error = "Exactly one state frame is required."; return false; }
  if (!readSites(frames[0]->data, frames[0]->size, st.sites, error)) return false;
  if (st.sites.empty() || st.sites[0].verifiedAt.size() < 20) { error = "The state carries no run time."; return false; }
  st.runAt = st.sites[0].verifiedAt;
  st.nowYear = std::atoi(st.runAt.substr(0, 4).c_str());
  st.index();
  return true;
}
inline void saveState(StageIO& io, const State& st) {
  std::vector<uint8_t> out;
  out.reserve(st.sites.size() * 900);
  SiteWriter w;
  for (const auto& s : st.sites) w.append(s, out);
  io.fb("state", std::move(out), "SIT.fbs", "$SIT", "SIT");
}

// ── schedules (recomputed from the state by the stage that made them and the one that reads them) ──
inline std::vector<std::string> entityIds(const State& st) {
  std::set<std::string> ids;
  for (const auto& s : st.sites) { const std::string q = s.qid(); if (!q.empty()) ids.insert(q); }
  return {ids.begin(), ids.end()};
}
template <typename T>
inline std::vector<std::vector<T>> batches(const std::vector<T>& items, size_t size) {
  std::vector<std::vector<T>> out;
  for (size_t i = 0; i < items.size(); i += size) out.emplace_back(items.begin() + long(i), items.begin() + long(std::min(items.size(), i + size)));
  return out;
}
// The batches of third `g` (0..2) of a list of batches.
template <typename T>
inline std::vector<T> third(const std::vector<T>& all, int g) {
  const size_t n = all.size();
  const size_t a = (n * size_t(g) + kStages - 1) / kStages, b = (n * size_t(g + 1) + kStages - 1) / kStages;
  return std::vector<T>(all.begin() + long(std::min(a, n)), all.begin() + long(std::min(b, n)));
}
// Entity batches: 50 ids each, smaller when there are few, so each third gets some.
inline std::vector<std::vector<std::string>> entityBatches(const State& st) {
  const auto ids = entityIds(st);
  if (ids.empty()) return {};
  const size_t size = std::min(kEntityBatch, std::max<size_t>(1, (ids.size() + kStages - 1) / kStages));
  return batches(ids, size);
}
inline Request entityRequest(const std::vector<std::string>& ids, size_t index) {
  std::string langs;
  for (const auto& l : labelLangs()) langs += (langs.empty() ? "" : "|") + l;
  for (const auto& l : wikiLangs()) if (langs.find("|" + l) == std::string::npos && !startsWith(langs, l + "|")) langs += "|" + l;
  std::string wikis;
  for (const auto& l : wikiLangs()) wikis += (wikis.empty() ? "" : "|") + l + "wiki";
  Request r;
  r.url = "https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=" + encodeComponent("info|labels|descriptions|claims|sitelinks") +
          "&languages=" + encodeComponent(langs) + "&sitefilter=" + encodeComponent(wikis) + "&ids=" + encodeComponent(join(ids, "|")) +
          "&sdn-req=entities-" + std::to_string(index);
  return r;
}

struct ArticleBatch { std::string lang; std::vector<std::string> titles; };
inline std::vector<ArticleBatch> articleBatches(const State& st) {
  std::map<std::string, std::set<std::string>> byLang;
  for (const auto& s : st.sites) {
    if (!articleSet(s.catcode) || s.qid().empty()) continue;
    for (const auto& r : s.refs) {
      if (r.role != REF_ENCYCLOPEDIA_ARTICLE || !endsWith(r.registry, "wiki")) continue;
      byLang[r.registry.substr(0, r.registry.size() - 4)].insert(r.title);
    }
  }
  size_t total = 0;
  for (const auto& [l, t] : byLang) total += t.size();
  const size_t size = std::min(kArticleBatch, std::max<size_t>(1, (total + kStages - 1) / kStages));
  std::vector<ArticleBatch> out;
  for (const auto& lang : wikiLangs()) {
    auto it = byLang.find(lang);
    if (it == byLang.end()) continue;
    const std::vector<std::string> titles(it->second.begin(), it->second.end());
    for (auto& b : batches(titles, size)) out.push_back({lang, b});
  }
  return out;
}
inline Request articleRequest(const ArticleBatch& b, size_t index) {
  Request r;
  r.url = "https://" + b.lang + ".wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=" + encodeComponent("ids|content") +
          "&rvslots=main&format=json&formatversion=2&redirects=1&maxlag=5&titles=" + encodeComponent(join(b.titles, "|")) + "&sdn-req=articles-" + std::to_string(index);
  return r;
}

// Parties: the items whose labels and websites are read.
inline std::vector<std::string> partyIds(const State& st) {
  std::set<std::string> ids;
  for (const auto& s : st.sites)
    for (const auto& p : s.parties)
      for (const auto& r : p.refs) if (r.registry == "wikidata" && r.role == REF_RECORD) ids.insert(r.recordId);
  for (const auto& r : reg::kRegulators) ids.insert(r.qid);
  return {ids.begin(), ids.end()};
}
inline std::vector<std::string> countrylessIds(const State& st) {
  std::set<std::string> ids;
  for (const auto& s : st.sites) if (s.ctrId.empty() && !s.qid().empty()) ids.insert(s.qid());
  return {ids.begin(), ids.end()};
}
inline std::string values(const std::vector<std::string>& ids) {
  std::string v;
  for (const auto& id : ids) v += " wd:" + id;
  return v;
}
// Rows whose item has a label in none of the label languages: every label of theirs is read.
inline std::vector<std::string> unnamedIds(const State& st) {
  std::set<std::string> ids;
  for (const auto& s : st.sites) if (s.name.empty() && startsWith(s.id, "wikidata:")) ids.insert(s.qid());
  return {ids.begin(), ids.end()};
}
struct PartiesPlan { std::vector<std::vector<std::string>> parties, countryless, unnamed; };
inline PartiesPlan partiesPlan(const State& st) {
  return {batches(partyIds(st), kSparqlBatch), batches(countrylessIds(st), kSparqlBatch), batches(unnamedIds(st), kSparqlBatch)};
}
inline std::vector<Request> partiesRequests(const State& st) {
  std::vector<Request> out;
  const auto plan = partiesPlan(st);
  for (size_t i = 0; i < plan.parties.size(); ++i)
    out.push_back(sparql("SELECT ?item ?label ?lang ?site WHERE { VALUES ?item {" + values(plan.parties[i]) + " } OPTIONAL { ?item rdfs:label ?label . BIND(LANG(?label) AS ?lang) FILTER(?lang = \"en\" || ?lang = \"mul\") } OPTIONAL { ?item wdt:P856 ?site } }", "parties-" + std::to_string(i)));
  for (size_t i = 0; i < plan.countryless.size(); ++i)
    // Up to three administrative levels, joined from the rows outward (the
    // optimizer would otherwise start from every country code and time out).
    out.push_back(sparql("SELECT ?item ?cc WHERE { hint:Query hint:optimizer \"None\" . VALUES ?item {" + values(plan.countryless[i]) +
                             " } { ?item wdt:P131 ?a . ?a wdt:P17 ?c . } UNION { ?item wdt:P131 ?a . ?a wdt:P131 ?b . ?b wdt:P17 ?c . }"
                             " UNION { ?item wdt:P131 ?a . ?a wdt:P131 ?b . ?b wdt:P131 ?d . ?d wdt:P17 ?c . } ?c wdt:P297 ?cc . }",
                         "country-" + std::to_string(i)));
  for (size_t i = 0; i < plan.unnamed.size(); ++i)
    out.push_back(sparql("SELECT ?item ?label WHERE { VALUES ?item {" + values(plan.unnamed[i]) + " } ?item rdfs:label ?label . }", "labels-" + std::to_string(i)));
  const reg::Source* gem = regSource("gem-gnpt");
  Request g;
  g.url = std::string(gem && gem->data ? gem->data : "") + "?sdn-req=gem";
  out.push_back(g);
  Request z;
  z.url = "https://zenodo.org/api/records?communities=ror-data&sort=mostrecent&size=1&sdn-req=ror-release";
  out.push_back(z);
  return out;
}

// ── JSON helpers ───────────────────────────────────────────────────────────
inline bool parseJson(const Response& r, Json& out, std::string& error, const std::string& what) {
  if (r.status < 200 || r.status > 299) { error = what + " answered HTTP " + std::to_string(r.status) + "; nothing is published from a partial read."; return false; }
  out = Json::parse(r.body.begin(), r.body.end(), nullptr, false);
  if (out.is_discarded()) { error = what + " answered something that is not JSON."; return false; }
  if (out.is_object() && out.contains("error")) {
    const Json& e = out["error"];
    const std::string code = e.is_object() && e.contains("code") && e["code"].is_string() ? e["code"].get<std::string>() : "error";
    error = what + " refused the request (" + code + "); nothing is published from a partial read.";
    return false;
  }
  return true;
}
inline std::string jstr(const Json& j, const char* key) {
  if (!j.is_object()) return "";
  auto it = j.find(key);
  return it != j.end() && it->is_string() ? it->get<std::string>() : "";
}
inline const Json* jget(const Json& j, const char* key) {
  if (!j.is_object()) return nullptr;
  auto it = j.find(key);
  return it == j.end() ? nullptr : &*it;
}
// SPARQL bindings: [{var: value}].
inline std::vector<std::map<std::string, std::string>> bindings(const Json& j) {
  std::vector<std::map<std::string, std::string>> out;
  const Json* results = jget(j, "results");
  const Json* list = results ? jget(*results, "bindings") : nullptr;
  if (!list || !list->is_array()) return out;
  for (const auto& b : *list) {
    std::map<std::string, std::string> row;
    if (!b.is_object()) continue;
    for (auto it = b.begin(); it != b.end(); ++it) {
      row[it.key()] = jstr(it.value(), "value");
      if (it.value().contains("xml:lang")) row[it.key() + "@lang"] = jstr(it.value(), "xml:lang");
    }
    out.push_back(std::move(row));
  }
  return out;
}
inline std::string qidOf(const std::string& iri) { const size_t s = iri.rfind('/'); return s == std::string::npos ? iri : iri.substr(s + 1); }

// ── seed rows (plan) ───────────────────────────────────────────────────────
inline int spaceSiteType(const std::string& code) {
  if (code == "S.LNCH") return ST_LAUNCH_SITE;
  if (code == "S.SPRT") return ST_SPACEPORT;
  if (code == "S.STNS" || code == "S.DSS") return ST_SATELLITE_GROUND_STATION;
  if (code == "S.SSA") return ST_OBSERVATION_STATION;
  return ST_OTHER;
}
inline int networkSiteType(const std::string& network) {
  if (network == "NPP") return ST_POWER_PLANT;
  if (network == "NUCL" || network == "RSCH" || network == "BIO" || network == "CHEM") return ST_RESEARCH_FACILITY;
  if (network == "NUCF" || network == "CHEMP") return ST_INDUSTRIAL_COMPLEX;
  return ST_OTHER;
}
inline std::string registerUrl(const std::string& file) {
  return "https://github.com/DigitalArsenal/space-data-network-modules/blob/main/data-source/site-registry/register/" + file;
}

inline void seedRegisterRows(State& st) {
  std::set<std::string> taken;
  // Curated facilities (one row per site: a site listed under two categories keeps the first).
  for (const auto& r : reg::kCurated) {
    Site s;
    const std::string qid = r.wikidata;
    s.id = qid.empty() ? "sdn-site:" + slug(r.name) : "wikidata:" + qid;
    if (taken.count(s.id)) continue;
    taken.insert(s.id);
    s.name = r.name;
    s.catcode = r.category;
    s.network = networkName(r.category);
    s.siteType = networkSiteType(r.category);
    s.siteKind = r.kind;
    s.lat = r.lat;
    s.lon = r.lon;
    s.ctrId = numericCountry(r.cc);
    s.verifiedAt = st.runAt;
    const std::string position = r.position;
    const std::string positionUrl = r.positionUrl;
    if (startsWith(positionUrl, "https://www.wikidata.org/wiki/Q")) {
      // An approximation at a named place's own Wikidata coordinate (the town the site is in).
      const std::string town = positionUrl.substr(positionUrl.rfind('/') + 1);
      s.positionCitation = cite("wikidata", town, positionUrl, "", "P625", st.runAt);
    } else if (startsWith(position, "approximate")) {
      s.positionCitation = cite("spaceaware-curated", s.id, registerUrl("curated.json"), sourceVersion("spaceaware-curated"), "register:curated", st.runAt);
    }
    if (qid.empty()) s.refs.push_back({REF_RECORD, "sdn-site-register", s.id.substr(9), registerUrl("curated.json"), r.name, "en"});
    if (!qid.empty()) s.source = position;  // working: where the position is read (Wikidata = the item's P625)
    st.sites.push_back(std::move(s));
  }
  // Space sites.
  for (const auto& r : reg::kSpaceSites) {
    Site s;
    const std::string qid = r.wikidata;
    s.id = qid.empty() ? "sdn-site:" + slug(r.name) : "wikidata:" + qid;
    if (taken.count(s.id)) continue;
    taken.insert(s.id);
    s.name = r.name;
    s.abbreviation = std::string(r.ascii) != r.name ? r.ascii : "";
    s.catcode = r.code;
    s.network = networkName("SPACE");
    s.siteType = spaceSiteType(r.code);
    for (const auto& c : reg::kSpaceCodes) if (std::string(c.code) == r.code) s.siteKind = c.name;
    s.lat = r.lat;
    s.lon = r.lon;
    s.ctrId = numericCountry(r.cc);
    s.verifiedAt = st.runAt;
    s.positionCitation = cite("space-sites", s.id, registerUrl("space-sites.json"), sourceVersion("space-sites"), "register:space-sites", st.runAt);
    if (qid.empty()) s.refs.push_back({REF_RECORD, "sdn-site-register", s.id.substr(9), registerUrl("space-sites.json"), r.name, "en"});
    else s.source = "Wikidata";  // working: the item's P625 is the position
    if (*r.status) s.evidence.push_back({statusFromName(r.status), r.statusDate, cite("space-sites", r.statusTitle, r.statusUrl, sourceVersion("space-sites"), "register:space-sites", st.runAt)});
    st.sites.push_back(std::move(s));
  }
  // Nuclear placemarks (GeoNames).
  for (const auto& p : reg::kPlacemarks) {
    Site s;
    s.id = std::string("geonames:") + p.geonameId;
    if (taken.count(s.id)) continue;
    taken.insert(s.id);
    s.name = p.name;
    s.abbreviation = std::string(p.ascii) != p.name ? p.ascii : "";
    s.catcode = "NPP";
    s.network = networkName("NPP");
    s.siteType = ST_POWER_PLANT;
    const std::string code = p.code;
    s.siteKind = code == "PSN" ? "nuclear power station" : code == "CTRA" ? "atomic center" : "power station";
    s.lat = p.lat;
    s.lon = p.lon;
    s.ctrId = numericCountry(p.cc);
    s.verifiedAt = st.runAt;
    s.source = code;  // working: the GeoNames feature code
    s.positionCitation = cite("geonames", p.geonameId, std::string("https://www.geonames.org/") + p.geonameId, sourceVersion("geonames"), "register:placemarks", st.runAt);
    s.refs.push_back({REF_RECORD, "geonames", p.geonameId, std::string("https://www.geonames.org/") + p.geonameId, p.name, ""});
    if (*p.wikidata) s.refs.push_back({REF_REGISTRY_RECORD, "wikidata", p.wikidata, wikidataUrl(p.wikidata), "", ""});
    st.sites.push_back(std::move(s));
  }
}

inline std::vector<Request> classRequests(const State& st) {
  std::vector<Request> out;
  for (size_t i = 0; i < reg::kClassesCount; ++i) {
    const auto& c = reg::kClasses[i];
    const std::string path = c.transitive ? "wdt:P31/wdt:P279*" : "wdt:P31";
    out.push_back(sparql("SELECT ?item ?label ?coord ?cc WHERE {\n  ?item " + path + " wd:" + c.qid +
                             " ; wdt:P625 ?coord .\n  OPTIONAL { ?item rdfs:label ?label . FILTER(LANG(?label) = \"en\") }\n  OPTIONAL { ?item wdt:P17/wdt:P297 ?cc . }\n}",
                         "classes-" + std::to_string(i)));
  }
  // The register's items that are human settlements or political territories, not sites (Kambarka's
  // town item; military bases, which Wikidata also files under administrative entities, stay).
  std::set<std::string> ids;
  for (const auto& s : st.sites) { const std::string q = s.qid(); if (!q.empty()) ids.insert(q); }
  out.push_back(sparql("SELECT DISTINCT ?item WHERE { VALUES ?item {" + values({ids.begin(), ids.end()}) +
                           " } { ?item wdt:P31/wdt:P279* wd:Q486972 } UNION { ?item wdt:P31/wdt:P279* wd:Q1048835 } }",
                       "settlements"));
  return out;
}

// The register's facts about an id ("Q…" or "geonames:<id>").
inline bool notAFacility(const std::string& qid) {
  for (const auto& n : reg::kNotFacilities) if (qid == n.qid) return true;
  for (const auto& d : reg::kDuplicates) if (qid == d.drop) return true;
  return false;
}

inline bool absorbClasses(State& st, const std::vector<Response>& rs, std::string& error) {
  if (rs.size() != reg::kClassesCount + 1) { error = "Class answers missing."; return false; }
  // Settlements first: a register row naming a town keeps its own coordinate and loses the item.
  Json settle;
  if (!parseJson(rs.back(), settle, error, "Wikidata SPARQL (settlements)")) return false;
  std::set<std::string> settlements;
  for (auto& b : bindings(settle)) settlements.insert(qidOf(b["item"]));
  for (auto& s : st.sites) {
    const std::string q = s.qid();
    if (q.empty() || !settlements.count(q)) continue;
    if (startsWith(s.id, "wikidata:")) {
      const bool space = s.network == networkName("SPACE");
      s.id = "sdn-site:" + slug(s.name);
      s.refs.push_back({REF_RECORD, "sdn-site-register", s.id.substr(9), registerUrl(space ? "space-sites.json" : "curated.json"), s.name, "en"});
      s.source.clear();
    }
    s.refs.erase(std::remove_if(s.refs.begin(), s.refs.end(), [&](const Reference& r) { return r.registry == "wikidata" && r.recordId == q; }), s.refs.end());
    if (!s.positionCitation.empty() && s.positionCitation.source == "spaceaware-curated") s.positionCitation.recordId = s.id;
  }
  // A register row's item is that row; a placemark's joined item is that placemark for the power-plant
  // class only (the audit kept the research-reactor and facility rows beside their placemarks).
  std::set<std::string> taken, joined;
  for (const auto& s : st.sites) {
    const std::string q = s.qid();
    if (q.empty()) continue;
    (startsWith(s.id, "geonames:") ? joined : taken).insert(q);
  }
  std::vector<Site> added;
  std::set<std::string> seen;
  for (size_t i = 0; i < reg::kClassesCount; ++i) {
    const auto& c = reg::kClasses[i];
    Json j;
    if (!parseJson(rs[i], j, error, std::string("Wikidata SPARQL (") + c.kind + ")")) return false;
    std::set<std::string> inClass;
    for (auto& b : bindings(j)) {
      const std::string qid = qidOf(b["item"]);
      if (inClass.count(qid)) continue;
      // "Point(lon lat)"
      const std::string coord = b["coord"];
      const size_t open = coord.find('('), space = coord.find(' ', open), close = coord.find(')', space);
      if (!startsWith(coord, "Point(") || space == std::string::npos || close == std::string::npos) continue;
      inClass.insert(qid);
      if (taken.count(qid) || seen.count(qid) || notAFacility(qid) || (std::string(c.network) == "NPP" && joined.count(qid))) continue;
      seen.insert(qid);
      Site s;
      s.id = "wikidata:" + qid;
      s.name = b["label"];
      s.catcode = c.network;
      s.network = networkName(c.network);
      s.siteType = networkSiteType(c.network);
      s.siteKind = c.kind;
      s.lon = std::round(std::strtod(coord.substr(open + 1, space - open - 1).c_str(), nullptr) * 1e5) / 1e5;
      s.lat = std::round(std::strtod(coord.substr(space + 1, close - space - 1).c_str(), nullptr) * 1e5) / 1e5;
      s.ctrId = numericCountry(b["cc"]);
      s.verifiedAt = st.runAt;
      s.source = "Wikidata";
      added.push_back(std::move(s));
    }
  }
  for (auto& s : added) st.sites.push_back(std::move(s));
  st.index();
  return true;
}

// ── Wikidata items ─────────────────────────────────────────────────────────
inline std::string timeValue(const Json& dv) {
  const Json* v = jget(dv, "value");
  if (!v || !v->is_object()) return "";
  const std::string t = jstr(*v, "time");
  const Json* p = jget(*v, "precision");
  return wikidataDate(t, p && p->is_number() ? p->get<int>() : 0);
}
inline std::string itemValue(const Json& snak) {
  const Json* dv = jget(snak, "datavalue");
  const Json* v = dv ? jget(*dv, "value") : nullptr;
  return v ? jstr(*v, "id") : "";
}
// A quantity in metres or megawatts (NaN when its unit is another).
inline double quantity(const Json& snak, bool power) {
  const Json* dv = jget(snak, "datavalue");
  const Json* v = dv ? jget(*dv, "value") : nullptr;
  if (!v) return NAN;
  const double amount = std::strtod(jstr(*v, "amount").c_str(), nullptr);
  const std::string unit = qidOf(jstr(*v, "unit"));
  if (power) {
    if (unit == "Q6982035") return amount;          // megawatt
    if (unit == "Q6859") return amount / 1e3;       // kilowatt
    if (unit == "Q25236") return amount / 1e6;      // watt
    if (unit == "Q2364743") return amount * 1e3;    // gigawatt
    return NAN;
  }
  if (unit == "Q11573") return amount;               // metre
  if (unit == "Q3710") return amount * 0.3048;       // foot
  return NAN;
}

inline Item itemOf(const Json& e, std::vector<std::string>& descriptionOrder) {
  Item it;
  it.qid = jstr(e, "id");
  if (const Json* r = jget(e, "lastrevid"); r && r->is_number()) it.revision = r->get<int64_t>();
  if (const Json* l = jget(e, "labels"); l && l->is_object()) for (auto x = l->begin(); x != l->end(); ++x) it.labels[x.key()] = jstr(x.value(), "value");
  if (const Json* d = jget(e, "descriptions"); d && d->is_object())
    for (auto x = d->begin(); x != d->end(); ++x) { it.descriptions[x.key()] = jstr(x.value(), "value"); descriptionOrder.push_back(x.key()); }
  if (const Json* s = jget(e, "sitelinks"); s && s->is_object()) for (auto x = s->begin(); x != s->end(); ++x) it.sitelinks[x.key()] = jstr(x.value(), "title");
  const Json* claims = jget(e, "claims");
  if (!claims || !claims->is_object()) return it;
  auto statements = [&](const char* p) -> std::vector<const Json*> {
    std::vector<const Json*> out;
    const Json* list = jget(*claims, p);
    if (list && list->is_array()) for (const auto& c : *list) out.push_back(&c);
    return out;
  };
  auto items = [&](const char* p) {
    std::vector<std::string> out;
    for (const Json* c : statements(p)) {
      if (jstr(*c, "rank") == "deprecated") continue;
      const Json* snak = jget(*c, "mainsnak");
      if (!snak || jstr(*snak, "snaktype") != "value") continue;
      const std::string id = itemValue(*snak);
      if (!id.empty()) out.push_back(id);
    }
    return out;
  };
  std::vector<std::string> props{"P5817"};
  for (const auto& p : endProperties()) props.push_back(p);
  for (const auto& p : startProperties()) props.push_back(p);
  for (const auto& p : props) {
    for (const Json* c : statements(p.c_str())) {
      const Json* snak = jget(*c, "mainsnak");
      if (!snak) continue;
      const std::string snaktype = jstr(*snak, "snaktype");
      const bool unknown = snaktype == "somevalue" && isEndProperty(p);
      if (jstr(*c, "rank") == "deprecated" || (snaktype != "value" && !unknown)) continue;
      Claim cl;
      cl.rank = jstr(*c, "rank");
      if (p == "P5817") {
        cl.value = itemValue(*snak);
        const Json* q = jget(*c, "qualifiers");
        const Json* p580 = q ? jget(*q, "P580") : nullptr;
        if (p580 && p580->is_array() && !p580->empty()) if (const Json* dv = jget((*p580)[0], "datavalue")) cl.since = timeValue(*dv);
      } else if (const Json* dv = jget(*snak, "datavalue")) {
        cl.value = timeValue(*dv);
      }
      it.claims[p].push_back(cl);
    }
  }
  it.classes = items("P31");
  it.partOf = items("P361");
  for (const auto& p : successorProperties()) for (const auto& q : items(p.c_str())) it.successors.push_back(p + " " + q);
  it.operators = items("P137");
  it.owners = items("P127");
  it.countries = items("P17");
  // The official website: a preferred statement, else the first.
  std::string preferredSite, firstSite;
  for (const Json* c : statements("P856")) {
    const Json* snak = jget(*c, "mainsnak");
    const Json* dv = snak ? jget(*snak, "datavalue") : nullptr;
    const std::string url = dv ? jstr(*dv, "value") : "";
    if (url.empty() || jstr(*c, "rank") == "deprecated") continue;
    if (firstSite.empty()) firstSite = url;
    if (preferredSite.empty() && jstr(*c, "rank") == "preferred") preferredSite = url;
  }
  if (!(preferredSite.empty() && firstSite.empty())) it.websites.push_back(preferredSite.empty() ? firstSite : preferredSite);
  for (const Json* c : statements("P625")) {
    if (jstr(*c, "rank") == "deprecated") continue;
    const Json* snak = jget(*c, "mainsnak");
    const Json* dv = snak ? jget(*snak, "datavalue") : nullptr;
    const Json* v = dv ? jget(*dv, "value") : nullptr;
    if (v && v->contains("latitude") && (*v)["latitude"].is_number()) { it.lat = (*v)["latitude"].get<double>(); it.lon = (*v)["longitude"].get<double>(); break; }
  }
  for (const Json* c : statements("P2044")) {
    if (jstr(*c, "rank") == "deprecated") continue;
    if (const Json* snak = jget(*c, "mainsnak")) { const double m = quantity(*snak, false); if (!std::isnan(m)) { it.elevationM = m; break; } }
  }
  for (const Json* c : statements("P2109")) {
    if (jstr(*c, "rank") == "deprecated") continue;
    if (const Json* snak = jget(*c, "mainsnak")) { const double w = quantity(*snak, true); if (!std::isnan(w)) { it.nominalPowerMW = w; break; } }
  }
  return it;
}

inline std::string labelOf(const Item& it) {
  for (const auto& l : labelLangs()) { auto x = it.labels.find(l); if (x != it.labels.end() && !x->second.empty()) return x->second; }
  return it.labels.empty() ? "" : it.labels.begin()->second;
}

// Fold one item into every row that names it: the row's own item (wikidata:Q…,
// curated and space sites with an item) or a placemark's joined item, whose
// statements, articles, references and parties the placemark carries; the
// placemark keeps its GeoNames name, position and record.
inline void applyItem(State& st, Site& s, const Item& it, const std::vector<std::string>& descriptionOrder) {
  const std::string qid = it.qid;
  const std::string rev = std::to_string(it.revision);
  auto wd = [&](const std::string& field) { return cite("wikidata", qid, wikidataUrl(qid), rev, field, st.runAt); };
  const bool own = startsWith(s.id, "wikidata:");
  const bool placemark = startsWith(s.id, "geonames:");
  if (own && s.name.empty()) s.name = labelOf(it);
  // The rules read a placemark's item as the audit did: a nuclear facility under the item's name.
  const std::string ruleName = placemark ? (labelOf(it).empty() ? s.name : labelOf(it)) : s.name;
  const RowKind rk{placemark ? "NUCF" : s.catcode, placemark ? "nuclear power plant" : s.siteKind, ruleName,
                   !placemark && organisationSet(s.catcode) && s.siteKind != "research reactor"};
  for (const auto& e : wikidataEvidence(it, rk, descriptionOrder)) s.evidence.push_back({e.status, e.date, wd(e.field)});
  const Stated start = wikidataStart(it);
  if (!start.field.empty()) s.evidence.push_back({OPERATING, start.date, wd(start.field)});
  if (own) s.refs.push_back({REF_RECORD, "wikidata", qid, wikidataUrl(qid), labelOf(it), "en"});
  if (placemark) {
    auto en = it.labels.find("en");
    for (auto& r : s.refs) if (r.registry == "wikidata" && r.recordId == qid) r.title = en != it.labels.end() && !en->second.empty() ? en->second : labelOf(it);
  }
  for (const auto& lang : wikiLangs()) {
    auto x = it.sitelinks.find(lang + "wiki");
    if (x != it.sitelinks.end()) s.refs.push_back({REF_ENCYCLOPEDIA_ARTICLE, lang + "wiki", x->second, wikiUrl(lang, x->second), x->second, lang});
  }
  for (const auto& w : it.websites) s.refs.push_back({REF_OFFICIAL_WEBSITE, "wikidata", qid, w, "", ""});
  for (const auto& q : it.operators) s.parties.push_back({PARTY_OPERATOR, "", {{REF_RECORD, "wikidata", q, wikidataUrl(q), "", ""}}, wd("P137")});
  for (const auto& q : it.owners) s.parties.push_back({PARTY_OWNER, "", {{REF_RECORD, "wikidata", q, wikidataUrl(q), "", ""}}, wd("P127")});
  if (s.ctrId.empty()) for (const auto& c : it.countries) { const std::string a2 = alpha2OfItem(c); if (!a2.empty()) { s.ctrId = numericCountry(a2); break; } }
  // Description: English, else the country's language.
  const std::string a2 = alpha2OfNumeric(s.ctrId);
  for (const std::string lang : {std::string("en"), localLanguage(a2)}) {
    if (lang.empty()) continue;
    auto d = it.descriptions.find(lang);
    if (d == it.descriptions.end() || d->second.empty()) continue;
    s.description = d->second;
    s.descriptionLanguage = lang;
    s.descriptionCitation = wd("description");
    break;
  }
  // Position: the item's P625 for the rows that read it.
  if (!std::isnan(it.lat) && s.source == "Wikidata") {
    s.lat = std::round(it.lat * 1e5) / 1e5;
    s.lon = std::round(it.lon * 1e5) / 1e5;
    s.positionCitation = wd("P625");
  }
  if (!std::isnan(it.elevationM) && !placemark) {
    s.alt = it.elevationM;
    s.quantities.push_back({Q_ELEVATION, std::round(it.elevationM * 10) / 10, "m", "", wd("P2044")});
  }
  if (!std::isnan(it.nominalPowerMW) && (s.catcode == "NUCL" || s.catcode == "NUCF")) s.quantities.push_back({Q_THERMAL_POWER, it.nominalPowerMW, "MW", "", wd("P2109")});
}

inline bool absorbEntities(State& st, const std::vector<Response>& rs, const std::vector<std::vector<std::string>>& asked, std::string& error) {
  std::unordered_map<std::string, std::vector<size_t>> rowsOf;
  for (size_t i = 0; i < st.sites.size(); ++i) { const std::string q = st.sites[i].qid(); if (!q.empty()) rowsOf[q].push_back(i); }
  for (size_t k = 0; k < rs.size(); ++k) {
    Json j;
    if (!parseJson(rs[k], j, error, "Wikidata wbgetentities")) return false;
    const Json* ents = jget(j, "entities");
    if (!ents || !ents->is_object()) { error = "Wikidata answered without entities."; return false; }
    for (const auto& asked1 : asked[k]) {
      // A redirected id answers under its target; the row keeps the id it asked for.
      const Json* e = nullptr;
      auto direct = ents->find(asked1);
      if (direct != ents->end()) e = &*direct;
      if (!e) for (auto it = ents->begin(); it != ents->end(); ++it) if (it.value().contains("redirects") && jstr(it.value()["redirects"], "from") == asked1) e = &it.value();
      if (!e || e->contains("missing")) continue;
      std::vector<std::string> order;
      Item item = itemOf(*e, order);
      item.qid = asked1;
      for (size_t i : rowsOf[asked1]) applyItem(st, st.sites[i], item, order);
    }
  }
  return true;
}

// ── parties, GEM, ROR release ──────────────────────────────────────────────
struct GemUnit { std::string project, unit, name, unitName, country, url; int status = UNSPECIFIED; double capacity = NAN, lat = NAN, lon = NAN; };
struct GemPlant { std::string name; std::vector<int> statuses; std::vector<std::string> unitIds; double lat = NAN, lon = NAN; int status = UNSPECIFIED; };

inline bool absorbParties(State& st, const std::vector<Response>& rs, std::string& rorZipUrl, std::string& rorVersion, std::vector<GemUnit>& gemUnits, std::string& error) {
  const auto plan = partiesPlan(st);
  size_t k = 0;
  std::map<std::string, std::pair<std::string, std::string>> named;  // qid -> label, website
  for (size_t i = 0; i < plan.parties.size(); ++i, ++k) {
    Json j;
    if (!parseJson(rs[k], j, error, "Wikidata SPARQL (parties)")) return false;
    std::map<std::string, std::string> en, mul, site;
    for (auto& b : bindings(j)) {
      const std::string q = qidOf(b["item"]);
      if (b["lang"] == "en" && !b["label"].empty()) en[q] = b["label"];
      if (b["lang"] == "mul" && !b["label"].empty()) mul[q] = b["label"];
      if (!b["site"].empty() && (site[q].empty() || b["site"] < site[q])) site[q] = b["site"];
    }
    for (const auto& q : plan.parties[i]) named[q] = {en.count(q) ? en[q] : mul.count(q) ? mul[q] : "", site[q]};
  }
  std::map<std::string, std::string> countryOf;
  for (size_t i = 0; i < plan.countryless.size(); ++i, ++k) {
    Json j;
    if (!parseJson(rs[k], j, error, "Wikidata SPARQL (countries)")) return false;
    for (auto& b : bindings(j)) {
      const std::string q = qidOf(b["item"]);
      if (countryOf[q].empty() || b["cc"] < countryOf[q]) countryOf[q] = b["cc"];
    }
  }
  // Any label of an otherwise unnamed item: the label languages' order, then the lowest language code.
  std::map<std::string, std::string> anyLabel;
  for (size_t i = 0; i < plan.unnamed.size(); ++i, ++k) {
    Json j;
    if (!parseJson(rs[k], j, error, "Wikidata SPARQL (labels)")) return false;
    std::map<std::string, std::map<std::string, std::string>> byLang;
    for (auto& b : bindings(j)) byLang[qidOf(b["item"])][b["label@lang"]] = b["label"];
    for (auto& [q, labels] : byLang) {
      std::string pick;
      for (const auto& l : labelLangs()) { auto x = labels.find(l); if (x != labels.end() && !x->second.empty()) { pick = x->second; break; } }
      if (pick.empty() && !labels.empty()) pick = labels.begin()->second;
      anyLabel[q] = pick;
    }
  }
  for (auto& s : st.sites) {
    if (s.name.empty() && startsWith(s.id, "wikidata:")) { auto x = anyLabel.find(s.qid()); if (x != anyLabel.end()) s.name = x->second; }
    for (auto& p : s.parties) {
      if (p.refs.empty()) continue;
      auto x = named.find(p.refs[0].recordId);
      if (x == named.end()) continue;
      p.name = x->second.first;
      p.refs[0].title = x->second.first;
      if (!x->second.second.empty() && p.refs.size() == 1) p.refs.push_back({REF_OFFICIAL_WEBSITE, "wikidata", p.refs[0].recordId, x->second.second, "", ""});
    }
    if (s.ctrId.empty()) { auto c = countryOf.find(s.qid()); if (c != countryOf.end()) s.ctrId = numericCountry(c->second); }
    // The national nuclear regulator of the country, for nuclear rows (not the US national laboratories DOE oversees).
    const bool nuclear = reactorSet(s.catcode) || (s.catcode == "STORE" && s.siteKind.find(reg::kRegulatorStoreKinds) != std::string::npos);
    if (nuclear && s.siteKind != reg::kRegulatorExcludeKinds) {
      const std::string a2 = alpha2OfNumeric(s.ctrId);
      for (const auto& r : reg::kRegulators) {
        if (a2 != r.cc) continue;
        auto x = named.find(r.qid);
        if (x == named.end() || x->second.first.empty()) continue;
        Party p{PARTY_REGULATOR, x->second.first, {{REF_RECORD, "wikidata", r.qid, wikidataUrl(r.qid), x->second.first, "en"}},
                cite("wikidata", r.qid, wikidataUrl(r.qid), "", "register:regulators", st.runAt)};
        if (!x->second.second.empty()) p.refs.push_back({REF_OFFICIAL_WEBSITE, "wikidata", r.qid, x->second.second, "", ""});
        s.parties.push_back(p);
      }
    }
  }
  // GEM tracker units.
  Json gem;
  if (!parseJson(rs[k++], gem, error, "Global Energy Monitor tracker")) return false;
  const Json* features = jget(gem, "features");
  if (!features || !features->is_array() || features->size() < 100) { error = "The Global Energy Monitor tracker holds no units; refusing a partial read."; return false; }
  for (const auto& f : *features) {
    const Json* p = jget(f, "properties");
    if (!p) continue;
    GemUnit u;
    u.project = jstr(*p, "project-id");
    u.unit = jstr(*p, "unit-id");
    u.name = jstr(*p, "name");
    u.unitName = jstr(*p, "unit-name");
    u.country = jstr(*p, "country-area1");
    u.url = jstr(*p, "url");
    u.status = gemStatus(jstr(*p, "status"));
    if (const Json* c = jget(*p, "capacity"); c && c->is_number()) u.capacity = c->get<double>();
    if (const Json* c = jget(*p, "Latitude"); c && c->is_number()) u.lat = c->get<double>();
    if (const Json* c = jget(*p, "Longitude"); c && c->is_number()) u.lon = c->get<double>();
    gemUnits.push_back(u);
  }
  // The newest ROR release.
  Json z;
  if (!parseJson(rs[k++], z, error, "Zenodo (ROR release)")) return false;
  const Json* hits = jget(z, "hits");
  const Json* list = hits ? jget(*hits, "hits") : nullptr;
  if (!list || !list->is_array() || list->empty()) { error = "Zenodo lists no ROR release."; return false; }
  const Json* files = jget((*list)[0], "files");
  if (files && files->is_array())
    for (const auto& f : *files) {
      const std::string key = jstr(f, "key");
      if (!endsWith(key, ".zip")) continue;
      const Json* links = jget(f, "links");
      rorZipUrl = links ? jstr(*links, "self") : "";
      rorVersion = replaceAll(key, "-ror-data.zip", "");
    }
  if (rorZipUrl.empty()) { error = "The ROR release has no data dump."; return false; }
  return true;
}

// GEM plants by name key, with each unit also a one-unit plant "<plant> <unit>" (gem.mjs gemPlants).
inline std::map<std::string, GemPlant> gemPlants(const std::vector<GemUnit>& units) {
  std::map<std::string, GemPlant> plants;
  auto add = [&](const std::string& key, const std::string& name, const GemUnit& u) {
    auto it = plants.find(key);
    if (it == plants.end()) it = plants.emplace(key, GemPlant{name, {}, {}, u.lat, u.lon, UNSPECIFIED}).first;
    it->second.statuses.push_back(u.status);
    it->second.unitIds.push_back(u.unit);
  };
  for (const auto& u : units) {
    const std::string key = nameKey(u.name);
    if (key.empty()) continue;
    add(key, u.name, u);
    const std::string unit = nameKey(u.unitName);
    if (!unit.empty()) add(key + " " + unit, u.name + " " + u.unitName, u);
  }
  for (auto& [k, p] : plants) p.status = plantStatus(p.statuses);
  return plants;
}

inline void absorbGem(State& st, const std::vector<GemUnit>& units) {
  const auto plants = gemPlants(units);
  std::map<std::string, const GemUnit*> byUnit;
  for (const auto& u : units) byUnit[u.unit] = &u;
  const std::string version = sourceVersion("gem-gnpt");
  std::set<std::string> covered;  // GEM projects a row stands for
  auto gemCite = [&](const std::vector<std::string>& ids, const std::string& field) {
    const GemUnit* first = ids.empty() ? nullptr : byUnit[ids[0]];
    return cite("gem-gnpt", join(ids, ","), first ? first->url : "", version, field, st.runAt);
  };
  auto addQuantities = [&](Site& s, const std::vector<std::string>& ids) {
    double capacity = 0;
    int operating = 0;
    for (const auto& id : ids) {
      auto it = byUnit.find(id);
      if (it == byUnit.end() || it->second->status != OPERATING) continue;
      ++operating;
      if (!std::isnan(it->second->capacity)) capacity += it->second->capacity;
    }
    if (operating > 0) {
      s.quantities.push_back({Q_ELECTRICAL_CAPACITY, capacity, "MW", "", gemCite(ids, "units")});
      s.quantities.push_back({Q_REACTOR_UNITS, double(operating), "", "", gemCite(ids, "units")});
    }
    if (!ids.empty() && byUnit.count(ids[0]) && !byUnit[ids[0]]->url.empty() && !s.ref(REF_REGISTRY_RECORD, "gem-gnpt"))
      s.refs.push_back({REF_REGISTRY_RECORD, "gem-gnpt", byUnit[ids[0]]->project, byUnit[ids[0]]->url, byUnit[ids[0]]->name, "en"});
  };
  for (auto& s : st.sites) {
    const bool placemark = startsWith(s.id, "geonames:");
    // Reviewed joins (register): the units a placemark or an item stands for, read by hand.
    for (const std::string key : {s.qid(), placemark ? s.id : std::string()}) {
      if (key.empty()) continue;
      for (const auto& f : reg::kFacts) {
        if (key != f.qid || std::string(f.source) != "gem-gnpt") continue;
        std::vector<std::string> ids;
        std::vector<int> statuses;
        for (size_t u = 0; u < f.unitCount; ++u) {
          ids.push_back(reg::kFactUnits[f.unitBegin + u]);
          auto it = byUnit.find(ids.back());
          statuses.push_back(it == byUnit.end() ? UNSPECIFIED : it->second->status);
          if (it != byUnit.end()) covered.insert(it->second->project);
        }
        s.evidence.push_back({plantStatus(statuses), "", gemCite(ids, "register:reviewed")});
      }
    }
    if (!reactorSet(s.catcode) || s.qid().empty()) {
      if (!placemark) continue;
    }
    // The tracker plant of the same name (gem.mjs gemMatch): the item's name and its article titles, within 100 km.
    if (!s.qid().empty() && reactorSet(s.catcode)) {
      std::vector<std::string> names;
      if (placemark) {
        const Reference* item = nullptr;
        for (const auto& r : s.refs) if (r.registry == "wikidata" && r.role == REF_REGISTRY_RECORD) item = &r;
        names.push_back(item && !item->title.empty() ? item->title : s.name);
      } else names.push_back(s.name);
      for (const auto& r : s.refs) if (r.role == REF_ENCYCLOPEDIA_ARTICLE) names.push_back(r.title);
      for (const auto& name : names) {
        auto it = plants.find(nameKey(name));
        if (it == plants.end() || kmBetween(it->second.lat, it->second.lon, s.lat, s.lon) > 100) continue;
        s.evidence.push_back({it->second.status, "", gemCite(it->second.unitIds, "units")});
        for (const auto& id : it->second.unitIds) if (byUnit.count(id)) covered.insert(byUnit[id]->project);
        if (!placemark) addQuantities(s, it->second.unitIds);
        break;
      }
    }
    if (!placemark) continue;
    // The placemark's own join (register/placemarks.json), and for a unit placemark the units of its whole station.
    for (const auto& p : reg::kPlacemarks) {
      if (s.id != std::string("geonames:") + p.geonameId || !p.gemCount) continue;
      std::vector<std::string> ids;
      std::vector<int> statuses;
      for (size_t u = 0; u < p.gemCount; ++u) {
        ids.push_back(reg::kPlacemarkGemUnits[p.gemBegin + u]);
        auto it = byUnit.find(ids.back());
        statuses.push_back(it == byUnit.end() ? UNSPECIFIED : it->second->status);
        if (it != byUnit.end()) covered.insert(it->second->project);
      }
      s.evidence.push_back({plantStatus(statuses), "", gemCite(ids, "register:placemarks")});
      addQuantities(s, ids);
      const GemPlant* station = nullptr;
      for (const auto& [k, plant] : plants)
        if (std::find(plant.unitIds.begin(), plant.unitIds.end(), ids[0]) != plant.unitIds.end() && (!station || plant.unitIds.size() > station->unitIds.size())) station = &plant;
      if (station) for (int st2 : station->statuses) s.evidence.push_back({st2, "", gemCite(station->unitIds, "station-unit")});  // working
    }
  }
  // Plants no row stands for: rows of their own (gem:<project id>).
  std::map<std::string, std::vector<const GemUnit*>> projects;
  for (const auto& u : units) if (!u.project.empty()) projects[u.project].push_back(&u);
  for (const auto& [project, list] : projects) {
    if (covered.count(project)) continue;
    Site s;
    s.id = "gem:" + project;
    s.name = list[0]->name;
    s.catcode = "NPP";
    s.network = networkName("NPP");
    s.siteType = ST_POWER_PLANT;
    s.siteKind = "nuclear power plant";
    s.lat = list[0]->lat;
    s.lon = list[0]->lon;
    s.ctrId = numericCountry(alpha2OfName(list[0]->country));
    s.verifiedAt = st.runAt;
    std::vector<std::string> ids;
    std::vector<int> statuses;
    for (const auto* u : list) { ids.push_back(u->unit); statuses.push_back(u->status); }
    s.positionCitation = gemCite(ids, "units");
    s.refs.push_back({REF_RECORD, "gem-gnpt", project, list[0]->url, list[0]->name, "en"});
    s.evidence.push_back({plantStatus(statuses), "", gemCite(ids, "units")});
    addQuantities(s, ids);
    st.sites.push_back(std::move(s));
  }
  st.index();
}

// ── articles ───────────────────────────────────────────────────────────────
inline bool absorbArticles(State& st, const std::vector<Response>& rs, const std::vector<ArticleBatch>& asked, std::string& error) {
  // (lang, title) -> rows
  std::map<std::pair<std::string, std::string>, std::vector<size_t>> rowsOf;
  for (size_t i = 0; i < st.sites.size(); ++i) {
    const Site& s = st.sites[i];
    if (!articleSet(s.catcode) || s.qid().empty()) continue;
    for (const auto& r : s.refs) if (r.role == REF_ENCYCLOPEDIA_ARTICLE && endsWith(r.registry, "wiki")) rowsOf[{r.registry.substr(0, r.registry.size() - 4), r.title}].push_back(i);
  }
  for (size_t k = 0; k < rs.size(); ++k) {
    const std::string& lang = asked[k].lang;
    Json j;
    if (!parseJson(rs[k], j, error, lang + ".wikipedia.org")) return false;
    if (j.contains("continue")) { error = lang + ".wikipedia.org answered in parts (continue); refusing a partial read."; return false; }
    const Json* q = jget(j, "query");
    if (!q) { error = lang + ".wikipedia.org answered without pages."; return false; }
    std::map<std::string, std::string> renamed;  // to -> from
    for (const char* key : {"normalized", "redirects"})
      if (const Json* list = jget(*q, key); list && list->is_array()) for (const auto& r : *list) renamed[jstr(r, "to")] = jstr(r, "from");
    const Json* pages = jget(*q, "pages");
    if (!pages || !pages->is_array()) continue;
    for (const auto& page : *pages) {
      const Json* revs = jget(page, "revisions");
      if (!revs || !revs->is_array() || revs->empty()) continue;
      const Json& rev = (*revs)[0];
      const Json* slots = jget(rev, "slots");
      const Json* main = slots ? jget(*slots, "main") : nullptr;
      const std::string text = main ? jstr(*main, "content") : "";
      const std::string title = jstr(page, "title");
      std::string askedTitle = title;
      for (int guard = 0; guard < 4 && renamed.count(askedTitle); ++guard) askedTitle = renamed[askedTitle];
      const std::string revid = rev.contains("revid") && rev["revid"].is_number() ? std::to_string(rev["revid"].get<int64_t>()) : "";
      auto rows = rowsOf.find({lang, askedTitle});
      if (rows == rowsOf.end()) continue;
      const std::string recordId = lang + ":" + title;
      auto wp = [&](const std::string& field) { return cite("wikipedia", recordId, revisionUrl(lang, title, revid), revid, field, st.runAt); };
      const Params params = infoboxParameters(text);
      const auto evidence = infoboxEvidence(params, st.nowYear);
      const Stated start = infoboxStart(params, st.nowYear);
      std::vector<Statement> statements;
      bool reactorRows = false;
      for (size_t i : rows->second) if (reactorSet(st.sites[i].catcode)) reactorRows = true;
      if (reactorRows) statements = articleStatements(text, st.nowYear);
      for (size_t i : rows->second) {
        Site& s = st.sites[i];
        for (const auto& e : evidence) {
          s.evidence.push_back({e.status, e.date, wp(e.field)});
          if (!e.unitDates.empty()) s.evidence.push_back({UNSPECIFIED, "", wp(e.field)});  // working: the units shut on different dates
        }
        if (!start.field.empty()) s.evidence.push_back({OPERATING, start.date, wp(start.field)});
        if (reactorSet(s.catcode))
          for (const auto& m : statements) s.evidence.push_back({m.kind == "completed" ? DECOMMISSIONED : DECOMMISSIONING, m.date, wp("prose:" + m.phrase)});
      }
    }
  }
  return true;
}

}  // namespace sr
