// Identity links: a source's own name for an object (Vimpel's datefirst pairing, an AOE id) joins a catalog object
// only when the trajectories agree. The recipe's IDENTITY is an $XMT match request (trajectories, the four thresholds
// of match_catalog, and $OIL links) whose links also name the catalog object the native trajectory is proposed to be:
// LEFT.TRAJECTORY_ID the native trajectory, RIGHT.TRAJECTORY_ID the reference trajectory, and RIGHT.NORAD_CAT_ID or
// RIGHT.INTERNATIONAL_DESIGNATOR the object.
//
// Each link is tested on the trajectories' normalized ephemerides (catalog_match::run) and recorded as compatible,
// rejected, ambiguous or insufficient. Only a compatible link binds, and not when its native identity is proposed
// for two objects. A name, a bare number or an orbit that merely resembles another never joins.
namespace integrate {

using Native = std::pair<std::string, std::string>;  // source, native ID

struct Links {
  std::unique_ptr<XMTMatchReportT> report;
  std::map<Native, std::string> bound;  // -> catalog object key ("norad:N" or "cospar:D")
};

bool resolve_identity(const XMTMatchRequest* identity, const std::vector<const plugin_input_frame_t*>& ephemerides, const std::set<std::string>& catalog_keys, Links* out,
                      std::string* error) {
  using namespace catalog_match;
  std::vector<Trajectory> trajectories;
  std::vector<Pair> pairs;
  if (!request_of(identity, &trajectories, &pairs)) { *error = "The identity section needs trajectories and pairs."; return false; }
  std::map<std::string, Native> natives;
  for (const auto& t : trajectories) natives[t.id] = {t.provider, t.nativeId};
  std::vector<std::string> keys;
  std::vector<Native> proposed;
  for (const auto& pair : pairs) {
    const auto native = natives.find(pair.left);
    const auto* object = pair.link->RIGHT.get();
    std::string key;
    if (object && object->NORAD_CAT_ID) key = "norad:" + std::to_string(object->NORAD_CAT_ID);
    else if (object && cospar(object->INTERNATIONAL_DESIGNATOR)) key = "cospar:" + object->INTERNATIONAL_DESIGNATOR;
    if (native == natives.end() || pair.right.empty() || key.empty()) { *error = "A link names a native trajectory, a reference trajectory and the catalog object (NORAD number or international designator)."; return false; }
    keys.push_back(key);
    proposed.push_back(native->second);
  }
  const Policy policy = policy_of(identity->POLICY());
  std::vector<Result> rows;
  if (!run(policy, trajectories, pairs, ephemerides, &rows, error)) return false;
  // A native identity proposed for two objects binds to neither.
  std::map<Native, std::set<std::string>> objects;
  for (size_t i = 0; i < rows.size(); ++i) if (rows[i].verdict == xmtPairVerdict::Compatible) objects[proposed[i]].insert(keys[i]);
  std::vector<bool> bound(rows.size(), false);
  for (size_t i = 0; i < rows.size(); ++i) {
    Result& row = rows[i];
    if (!row.link->LEFT) row.link->LEFT = std::make_unique<OILIdentifierT>();
    row.link->LEFT->NAMESPACE = proposed[i].first;
    row.link->LEFT->ID = proposed[i].second;
    if (row.verdict != xmtPairVerdict::Compatible) continue;
    if (objects[proposed[i]].size() > 1) {
      row.verdict = xmtPairVerdict::Ambiguous;
      row.reason = "The native identity is proposed for more than one catalog object; review before establishing identity.";
    } else if (!catalog_keys.count(keys[i])) {
      row.reason = "The proposed object is not in the catalog.";
    } else {
      bound[i] = true;
      row.link->STATUS = oilLinkStatus::Bound;
      out->bound[proposed[i]] = keys[i];
    }
  }
  out->report = report_table(policy, trajectories, rows);
  for (size_t i = 0; i < rows.size(); ++i) {
    out->report->PAIRS[i]->OBJECT_KEY = keys[i];
    out->report->PAIRS[i]->BOUND = bound[i];
  }
  return true;
}

}  // namespace integrate
