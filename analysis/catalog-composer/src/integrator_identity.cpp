// Identity links: a source's own name for an object (Vimpel's datefirst pairing, an AOE id) joins a catalog object
// only when the trajectories agree. The recipe's `identity` section is a match recipe (candidates, pairs and the four
// thresholds of match_catalog) whose pairs also name the catalog object the native candidate is proposed to be:
//
//   {"native": "<candidate id>", "reference": "<candidate id>", "object": {"norad": 25544} | {"cospar": "1998-067A"},
//    "evidence": {...}}
//
// Each pair is tested on the candidates' normalized ephemerides (catalog_match::run) and recorded as compatible,
// rejected, ambiguous or insufficient. Only a compatible link binds, and not when its native identity is proposed
// for two objects. A name, a bare number or an orbit that merely resembles another never joins.
namespace integrate {

using Native = std::pair<std::string, std::string>;  // source, native ID

struct Links {
  Json report = Json::object();
  std::map<Native, std::string> bound;  // -> catalog object key ("norad:N" or "cospar:D")
};

bool resolve_identity(const Json& identity, const std::vector<const plugin_input_frame_t*>& ephemerides, const std::set<std::string>& catalog_keys, Links* out,
                      std::string* error) {
  const auto& candidates = field(identity, "candidates");
  const auto& pairs = field(identity, "pairs");
  if (!identity.is_object() || !candidates.is_array() || !pairs.is_array()) { *error = "The identity section needs candidates and pairs."; return false; }
  std::map<std::string, Native> natives;
  for (const auto& c : candidates) natives[text(field(c, "id"))] = {text(field(c, "provider")), text(field(c, "nativeId"))};
  Json recipe = identity;
  recipe["pairs"] = Json::array();
  std::vector<std::string> keys;
  std::vector<Native> proposed;
  for (const auto& pair : pairs) {
    const auto native = natives.find(text(field(pair, "native")));
    const auto& object = field(pair, "object");
    std::string key;
    if (!field(object, "norad").is_null()) {
      const double n = number(field(object, "norad"));
      if (std::isfinite(n) && n >= 1 && n <= 4294967295.0 && n == std::floor(n)) key = "norad:" + std::to_string(static_cast<uint32_t>(n));
    } else if (cospar(text(field(object, "cospar")))) {
      key = "cospar:" + text(field(object, "cospar"));
    }
    if (native == natives.end() || text(field(pair, "reference")).empty() || key.empty()) { *error = "A link names a native candidate, a reference candidate and the catalog object (norad or cospar)."; return false; }
    recipe["pairs"].push_back({{"left", text(field(pair, "native"))}, {"right", text(field(pair, "reference"))}, {"evidence", field(pair, "evidence")}});
    keys.push_back(key);
    proposed.push_back(native->second);
  }
  Json matched;
  if (!catalog_match::run(recipe, ephemerides, &matched, error)) return false;
  Json& rows = matched["matches"];
  // A native identity proposed for two objects binds to neither.
  std::map<Native, std::set<std::string>> objects;
  for (size_t i = 0; i < rows.size(); ++i) if (rows[i]["status"] == "compatible") objects[proposed[i]].insert(keys[i]);
  for (size_t i = 0; i < rows.size(); ++i) {
    Json& row = rows[i];
    row["native"] = {{"source", proposed[i].first}, {"nativeId", proposed[i].second}};
    row["object"] = keys[i];
    row["bound"] = false;
    if (row["status"] != "compatible") continue;
    if (objects[proposed[i]].size() > 1) {
      row["status"] = "ambiguous";
      row["reason"] = "The native identity is proposed for more than one catalog object; review before establishing identity.";
    } else if (!catalog_keys.count(keys[i])) {
      row["reason"] = "The proposed object is not in the catalog.";
    } else {
      row["bound"] = true;
      out->bound[proposed[i]] = keys[i];
    }
  }
  out->report = matched;
  return true;
}

}  // namespace integrate
