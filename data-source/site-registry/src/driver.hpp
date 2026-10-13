// The stage chain: which answers each stage reads and which requests it makes.
#pragma once
#include <string>
#include <vector>

namespace sr {

inline void emitRequests(StageIO& io, const std::vector<Request>& requests) {
  for (const auto& r : requests) io.json("request", describe(r));
}

// The requests of a third of a list of batches; one idle request when the third is empty.
template <typename B, typename F>
inline std::vector<Request> thirdRequests(const std::vector<B>& all, int g, const std::string& stage, F&& make) {
  std::vector<Request> out;
  const auto part = third(all, g);
  const size_t first = (all.size() * size_t(g) + kStages - 1) / kStages;
  for (size_t i = 0; i < part.size(); ++i) out.push_back(make(part[i], first + i));
  if (out.empty()) out.push_back(idle(stage));
  return out;
}
inline size_t expectedOf(size_t n) { return n == 0 ? 1 : n; }

inline bool loadAnswers(const StageIO& io, State& st, size_t expected, std::vector<Response>& rs, std::string& error) {
  return loadState(io, st, error) && readResponses(io, expected, rs, error);
}

inline bool runStage(const std::string& stage, StageIO& io) {
  State st;
  std::vector<Response> rs;
  std::string& error = io.error;
  auto entityReq = [](const std::vector<std::string>& ids, size_t i) { return entityRequest(ids, i); };
  auto articleReq = [](const ArticleBatch& b, size_t i) { return articleRequest(b, i); };
  if (stage == "plan") {
    const auto cfg = io.port("config");
    if (cfg.size() != 1) return io.fail("Exactly one configuration frame is required.");
    const Json c = Json::parse(cfg[0]->data, cfg[0]->data + cfg[0]->size, nullptr, false);
    if (!c.is_object() || jstr(c, "access") != "anonymous") return io.fail("The site registry reads public sources only; set access to anonymous.");
    const Json* at = jget(c, "run_at_ms");
    if (!at || !at->is_number_integer() || at->get<int64_t>() < 1600000000000LL) return io.fail("The configuration names no run time (run_at_ms).");
    st.runAt = rfc3339(at->get<int64_t>());
    st.nowYear = std::atoi(st.runAt.substr(0, 4).c_str());
    seedRegisterRows(st);
    if (st.sites.empty()) return io.fail("The register holds no rows.");
    st.sites[0].createdBy = jstr(c, "producer_peer_id");
    emitRequests(io, classRequests(st));
    saveState(io, st);
    return true;
  }
  if (stage == "entities_a") {
    if (!loadAnswers(io, st, reg::kClassesCount + 1, rs, error) || !absorbClasses(st, rs, error)) return false;
    emitRequests(io, thirdRequests(entityBatches(st), 0, "entities-idle-0", entityReq));
    saveState(io, st);
    return true;
  }
  if (stage == "entities_b" || stage == "entities_c" || stage == "parties") {
    const int g = stage == "entities_b" ? 0 : stage == "entities_c" ? 1 : 2;
    if (!loadState(io, st, error)) return false;
    const auto all = entityBatches(st);
    const auto asked = third(all, g);
    if (!readResponses(io, expectedOf(asked.size()), rs, error)) return false;
    if (!asked.empty() && !absorbEntities(st, rs, asked, error)) return false;
    if (stage == "parties") emitRequests(io, partiesRequests(st));
    else emitRequests(io, thirdRequests(all, g + 1, "entities-idle-" + std::to_string(g + 1), entityReq));
    saveState(io, st);
    return true;
  }
  if (stage == "articles_a") {
    if (!loadState(io, st, error)) return false;
    const size_t n = partiesRequests(st).size();
    if (!readResponses(io, n, rs, error)) return false;
    std::string zipUrl, rorVersion;
    std::vector<GemUnit> gem;
    if (!absorbParties(st, rs, zipUrl, rorVersion, gem, error)) return false;
    absorbGem(st, gem);
    auto requests = thirdRequests(articleBatches(st), 0, "articles-idle-0", articleReq);
    Request zip;
    zip.url = zipUrl + (zipUrl.find('?') == std::string::npos ? "?" : "&") + "sdn-req=ror-dump";
    zip.accept = "*/*";  // Zenodo answers 406 to application/zip
    zip.timeoutMs = 600000;
    requests.push_back(zip);
    emitRequests(io, requests);
    saveState(io, st);
    return true;
  }
  if (stage == "articles_b" || stage == "articles_c" || stage == "finish") {
    const int g = stage == "articles_b" ? 0 : stage == "articles_c" ? 1 : 2;
    if (!loadState(io, st, error)) return false;
    const auto all = articleBatches(st);
    const auto asked = third(all, g);
    const size_t extra = stage == "articles_b" ? 1 : 0;  // the ROR dump
    if (!readResponses(io, expectedOf(asked.size()) + extra, rs, error)) return false;
    std::vector<Response> articles(rs.begin(), rs.begin() + long(rs.size() - extra));
    if (!asked.empty() && !absorbArticles(st, articles, asked, error)) return false;
    if (extra && !absorbRor(st, rs.back(), "", error)) return false;
    if (stage != "finish") {
      emitRequests(io, thirdRequests(all, g + 1, "articles-idle-" + std::to_string(g + 1), articleReq));
      saveState(io, st);
      return true;
    }
    const std::string producer = st.sites.empty() ? "" : st.sites[0].createdBy;
    if (!st.sites.empty()) st.sites[0].createdBy.clear();
    Finished done = finish(st, producer);
    if (done.sites.size() < 100) return io.fail("Fewer than 100 site records; refusing to publish a partial registry.");
    const std::string batch = ephem::sha256_hex(done.sitStream.data(), done.sitStream.size());
    const Json common = {{"provider_id", kProviderId}, {"source_peer", producer}, {"reconcile", "current"}, {"origin_id", "sdn-site-registry"},
                         {"origin_name", "Space Data Network site registry"}, {"terms_url", registerUrl("sources.json")},
                         {"citation", "Wikidata (CC0); Wikipedia contributors (CC BY-SA 4.0, facts and titles); Global Energy Monitor, Global Nuclear Power Tracker (CC BY 4.0); Research Organization Registry (CC0); GeoNames (CC BY 4.0); Space Data Network site register"},
                         {"licence", "Per record (SIT PROVENANCE): CC0 1.0 or CC BY 4.0; each citation carries its source's terms"}};
    Json sitesMeta = common, placesMeta = common;
    sitesMeta.update({{"schema", "SIT.fbs"}, {"source_name", kSitesLane}, {"batch_id", batch}, {"dataset_id", std::string(kProviderId) + "/" + kSitesLane},
                      {"source_url", "https://www.wikidata.org/"}});
    placesMeta.update({{"schema", "GNP.fbs"}, {"source_name", kPlacesLane}, {"batch_id", batch}, {"dataset_id", std::string(kProviderId) + "/" + kPlacesLane},
                       {"source_url", "https://www.wikidata.org/"}});
    io.fb("sites", std::move(done.sitStream), "SIT.fbs", "$SIT", "SIT");
    io.json("sites_meta", sitesMeta);
    io.fb("places", std::move(done.gnpStream), "GNP.fbs", "$GNP", "GNP");
    io.json("places_meta", placesMeta);
    done.report["batch_id"] = batch;
    io.json("report", done.report);
    return true;
  }
  return io.fail("Unknown stage " + stage + ".");
}

}  // namespace sr
