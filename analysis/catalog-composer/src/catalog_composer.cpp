// CAT composition is selection over immutable provider records. The output
// retains the selected record's exact bytes; no inferred orbit or identifier
// is written into a CAT. Recipe and diagnostics are module control frames.
#include "space_data_module_invoke.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <map>
#include <set>
#include <string>
#include <vector>

using Json = nlohmann::json;
namespace {
constexpr size_t kMaxRecords = 250000;
constexpr size_t kMaxBytes = 128 * 1024 * 1024;
const Json& field(const Json& value, const char* key) {
  static const Json absent;
  return value.is_object() && value.contains(key) ? value[key] : absent;
}
std::string text(const Json& value) { return value.is_string() ? value.get<std::string>() : ""; }
double number(const Json& value) { return value.is_number() ? value.get<double>() : NAN; }
std::string trimmed(std::string value) {
  const auto first = value.find_first_not_of(" \t\r\n");
  if (first == std::string::npos) return "";
  return value.substr(first, value.find_last_not_of(" \t\r\n") - first + 1);
}
bool cospar(const std::string& value) {
  if (value.size() < 9 || value.size() > 11 || value[4] != '-') return false;
  for (size_t i = 0; i < value.size(); ++i) {
    if (i == 4) continue;
    if (i < 8 ? (value[i] < '0' || value[i] > '9') : (value[i] < 'A' || value[i] > 'Z')) return false;
  }
  return true;
}
int fail(const char* message) { plugin_set_error("invalid-catalog-recipe", message); return 1; }
struct Record {
  size_t layer, ordinal;
  const uint8_t* bytes;
  uint32_t length;
  std::string key, name, designator, nativeKey;
  uint32_t norad;
};
bool strings(const Json& values) {
  if (!values.is_array()) return false;
  std::set<std::string> seen;
  for (const auto& value : values) {
    const auto id = text(value);
    if (id.empty() || !seen.insert(id).second) return false;
  }
  return true;
}
using StateIndex = std::map<std::string, std::map<std::string, const Json*>>;
Json selectState(const std::string& key, const Json& recipe, const Json& override, const StateIndex& states) {
  const auto& sources = field(override, "stateSources").is_array() ? field(override, "stateSources") : field(recipe, "stateSources");
  const double maxAge = field(override, "maxAgeSeconds").is_number() ? number(field(override, "maxAgeSeconds")) : number(field(recipe, "version")) == 1 ? number(field(recipe, "maxAgeSeconds")) : INFINITY;
  const double asOf = number(field(recipe, "asOf"));
  const auto candidates = states.find(key);
  bool found = false, past = false;
  for (const auto& source : sources) {
    if (candidates == states.end()) continue;
    const auto candidate = candidates->second.find(text(source));
    if (candidate == candidates->second.end()) continue;
    found = true;
    const auto* newest = candidate->second;
    if (newest) past = true;
    if (newest && asOf - number(field(*newest, "epoch")) <= maxAge) return {{"status", "selected"}, {"sourceId", source}, {"recordId", field(*newest, "recordId")}, {"epoch", field(*newest, "epoch")}};
  }
  return {{"status", sources.empty() ? "unconfigured" : past ? "stale" : found ? "future" : "missing"}, {"sources", sources}};
}
} // namespace

extern "C" int compose(void) {
  const plugin_input_frame_t* recipeFrame = nullptr;
  std::vector<const plugin_input_frame_t*> inputs;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* frame = plugin_get_input_frame(i);
    if (!frame || !frame->port_id) return fail("An input frame has no port.");
    if (std::strcmp(frame->port_id, "recipe") == 0) {
      if (recipeFrame) return fail("Exactly one recipe frame is required.");
      recipeFrame = frame;
    } else if (std::strcmp(frame->port_id, "catalogs") == 0) inputs.push_back(frame);
    else return fail("Unknown input port.");
  }
  if (!recipeFrame || !recipeFrame->payload || recipeFrame->payload_length > 32 * 1024 * 1024) return fail("A bounded recipe frame is required.");
  const auto recipe = Json::parse(recipeFrame->payload, recipeFrame->payload + recipeFrame->payload_length, nullptr, false);
  const auto& layers = field(recipe, "layers");
  if (recipe.is_discarded() || (number(field(recipe, "version")) != 1 && number(field(recipe, "version")) != 2) || !layers.is_array() || layers.empty() || layers.size() != inputs.size() || layers.size() > 16) return fail("Recipe version 1 needs one catalog frame per layer, in priority order (maximum 16).");
  const bool internationalIdentity = number(field(recipe, "version")) == 2;
  const double asOf = number(field(recipe, "asOf")), maxAge = internationalIdentity ? INFINITY : number(field(recipe, "maxAgeSeconds"));
  if (!std::isfinite(asOf) || asOf <= 0 || (!internationalIdentity && !std::isfinite(maxAge)) || maxAge < 0 || !strings(field(recipe, "stateSources"))) return fail("Specify asOf, a nonnegative maximum state age, and distinct state source IDs.");
  const auto& overrides = field(recipe, "overrides");
  if (!overrides.is_null() && !overrides.is_object()) return fail("Object overrides must be a map.");
  for (const auto& override : overrides) {
    if (!override.is_object() || (!field(override, "catalogLayer").is_null() && text(field(override, "catalogLayer")).empty())) return fail("An object override is malformed.");
    if (!field(override, "stateSources").is_null() && !strings(field(override, "stateSources"))) return fail("Override state sources must be distinct IDs.");
    if (!field(override, "maxAgeSeconds").is_null() && (!std::isfinite(number(field(override, "maxAgeSeconds"))) || number(field(override, "maxAgeSeconds")) < 0)) return fail("An override state age is invalid.");
  }
  const auto& states = field(recipe, "stateCandidates");
  if (!states.is_null() && !states.is_array()) return fail("State candidates must be an array.");
  std::set<std::string> stateIdentities;
  StateIndex stateIndex;
  for (const auto& state : states) {
    if (text(field(state, "objectKey")).empty() || text(field(state, "sourceId")).empty() || text(field(state, "recordId")).empty() || !std::isfinite(number(field(state, "epoch"))) || number(field(state, "epoch")) <= 0) return fail("A state candidate requires an object, source, record ID and positive finite epoch.");
    const auto identity = Json::array({field(state, "objectKey"), field(state, "sourceId"), field(state, "epoch")}).dump();
    if (!stateIdentities.insert(identity).second) return fail("State candidates disagree at the same source epoch; resolve the ambiguity first.");
    auto& newest = stateIndex[text(field(state, "objectKey"))][text(field(state, "sourceId"))];
    const double epoch = number(field(state, "epoch"));
    if (epoch <= asOf && (!newest || epoch > number(field(*newest, "epoch")))) newest = &state;
  }

  std::map<std::string, std::vector<std::string>> coverageIndex;
  const auto& coverage = field(recipe, "coverage");
  if (!coverage.is_null() && !coverage.is_array()) return fail("Source coverage must be an array.");
  for (const auto& source : coverage) {
    const auto id = text(field(source, "sourceId"));
    if (id.empty() || text(field(source, "head")).empty() || !strings(field(source, "objects"))) return fail("Coverage needs a source, immutable publication and distinct international designators.");
    for (const auto& designator : field(source, "objects")) {
      if (!cospar(text(designator))) return fail("Coverage identifiers must be international designators.");
      coverageIndex["cospar:" + text(designator)].push_back(id);
    }
  }

  std::vector<Record> records;
  std::map<std::string, std::vector<size_t>> groups;
  std::set<std::string> layerIds;
  std::map<std::string, std::set<uint32_t>> designatorOwners;
  size_t totalBytes = 0;
  for (size_t layerIndex = 0; layerIndex < layers.size(); ++layerIndex) {
    const auto& layer = layers[layerIndex];
    const auto id = text(field(layer, "id"));
    if (id.empty() || !layerIds.insert(id).second || text(field(layer, "node")).empty() || text(field(layer, "provider")).empty() || text(field(layer, "source")).empty() || text(field(layer, "head")).empty()) return fail("Every layer needs a unique ID, node, provider, source and immutable publication head.");
    const auto* frame = inputs[layerIndex];
    totalBytes += frame->payload_length;
    if (totalBytes > kMaxBytes || (frame->payload_length && !frame->payload)) return fail("Catalog input exceeds the 128 MiB limit.");
    const auto& nativeKeys = field(layer, "nativeKeys");
    if (!nativeKeys.is_null() && !nativeKeys.is_array()) return fail("Native keys must follow the input record order.");
    size_t offset = 0, ordinal = 0;
    std::set<std::string> layerKeys;
    while (offset < frame->payload_length) {
      if (frame->payload_length - offset < 4) return fail("Truncated CAT size prefix.");
      const uint8_t* bytes = frame->payload + offset;
      const auto size = flatbuffers::ReadScalar<uint32_t>(bytes);
      if (size < 8 || size > frame->payload_length - offset - 4) return fail("Invalid CAT record length.");
      flatbuffers::Verifier verifier(bytes, size + 4);
      if (!VerifySizePrefixedCATBuffer(verifier)) return fail("Catalog input must contain canonical size-prefixed CAT records.");
      const auto* cat = GetSizePrefixedCAT(bytes);
      Record record{layerIndex, ordinal, bytes, size + 4, "", cat->OBJECT_NAME() ? cat->OBJECT_NAME()->str() : "", cat->OBJECT_ID() ? trimmed(cat->OBJECT_ID()->str()) : "", "", cat->NORAD_CAT_ID()};
      if (nativeKeys.is_array() && ordinal < nativeKeys.size()) record.nativeKey = text(nativeKeys[ordinal]);
      if (internationalIdentity && cospar(record.designator)) record.key = "cospar:" + record.designator;
      else if (internationalIdentity) record.key = "unresolved:" + Json::array({field(layer, "node"), field(layer, "id"), ordinal}).dump();
      else if (record.norad) record.key = "norad:" + std::to_string(record.norad);
      else if (cospar(record.designator)) record.key = "cospar:" + record.designator;
      else if (!record.nativeKey.empty()) record.key = "source:" + Json::array({field(layer, "provider"), field(layer, "source"), record.nativeKey}).dump();
      else return fail("An unnumbered object needs a valid international designator or its original source-native key.");
      if (!layerKeys.insert(record.key).second) return fail("A layer contains duplicate object identities; choose one edition first.");
      if (record.norad && cospar(record.designator)) designatorOwners[record.designator].insert(record.norad);
      records.push_back(std::move(record));
      if (records.size() > kMaxRecords) return fail("Catalog composition exceeds the 250000-record limit.");
      offset += size + 4; ++ordinal;
    }
    if (nativeKeys.is_array() && nativeKeys.size() != ordinal) return fail("Native keys must match the catalog record count exactly.");
  }
  // A unique international-designator link can join an unnumbered source
  // record to a numbered one. Ambiguous designators remain separate conflicts.
  for (size_t index = 0; index < records.size(); ++index) {
    auto& record = records[index];
    if (internationalIdentity || record.norad || !cospar(record.designator)) continue;
    const auto owners = designatorOwners.find(record.designator);
    if (owners != designatorOwners.end() && owners->second.size() == 1) record.key = "norad:" + std::to_string(*owners->second.begin());
  }
  for (size_t index = 0; index < records.size(); ++index) groups[records[index].key].push_back(index);
  std::vector<uint8_t> output;
  Json rows = Json::array();
  size_t conflictCount = 0;
  for (const auto& [key, indices] : groups) {
    std::set<size_t> sourceLayers;
    for (size_t index : indices) if (!sourceLayers.insert(records[index].layer).second) return fail("A layer repeats an object through both numbered and international-designator identities.");
    const Json& override = field(overrides, key.c_str());
    size_t chosen = indices.front();
    const auto preferred = text(field(override, "catalogLayer"));
    if (!preferred.empty()) {
      const auto found = std::find_if(indices.begin(), indices.end(), [&](size_t index) { return text(field(layers[records[index].layer], "id")) == preferred; });
      if (found == indices.end()) return fail("An object override names a layer that does not contain that object.");
      chosen = *found;
    }
    const auto& selected = records[chosen];
    std::set<std::string> designators;
    Json candidates = Json::array();
    for (size_t index : indices) {
      const auto& record = records[index];
      if (cospar(record.designator)) designators.insert(record.designator);
      candidates.push_back({{"layer", field(layers[record.layer], "id")}, {"record", record.ordinal}, {"nativeKey", record.nativeKey}, {"name", record.name}, {"designator", record.designator}});
    }
    bool conflict = internationalIdentity ? !cospar(selected.designator) : designators.size() > 1;
    if (!internationalIdentity) for (const auto& designator : designators) if (designatorOwners[designator].size() > 1) conflict = true;
    if (conflict) ++conflictCount;
    // Conflicting identifiers are visible but never silently published. A
    // per-object layer choice is the user's explicit resolution.
    const bool resolved = internationalIdentity ? !conflict : !conflict || !preferred.empty();
    if (resolved) output.insert(output.end(), selected.bytes, selected.bytes + selected.length);
    Json state = selectState(key, recipe, override, stateIndex);
    if (internationalIdentity) {
      std::vector<std::string> covered;
      for (const auto& source : field(recipe, "stateSources")) {
        const auto& candidates = coverageIndex[key];
        if (std::find(candidates.begin(), candidates.end(), text(source)) != candidates.end()) covered.push_back(text(source));
      }
      const auto& choices = field(override, "stateSources");
      const auto selectedSource = choices.is_array() && !choices.empty() ? text(choices.front()) : covered.size() == 1 ? covered.front() : "";
      if (!selectedSource.empty() && std::find(covered.begin(), covered.end(), selectedSource) == covered.end()) return fail("The selected orbital source does not declare coverage of this object.");
      state = {{"status", !selectedSource.empty() ? "covered" : covered.size() > 1 ? "overlap" : "missing"}, {"sourceId", selectedSource}, {"sources", covered}};
    }
    rows.push_back({{"key", key}, {"internationalDesignator", selected.designator}, {"name", selected.name}, {"selectedLayer", field(layers[selected.layer], "id")}, {"status", resolved ? "selected" : internationalIdentity ? "missing-designator" : "identity-conflict"}, {"candidates", candidates}, {"state", state}});
  }
  const auto report = Json({{"version", 1}, {"inputRecords", records.size()}, {"objectCount", rows.size()}, {"identityConflicts", conflictCount}, {"objects", rows}}).dump();
  if (plugin_push_output_ex("report", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1, reinterpret_cast<const uint8_t*>(report.data()), static_cast<uint32_t>(report.size())) < 0) return 1;
  if (!output.empty() && plugin_push_output_ex("catalog", "CAT.fbs", "$CAT", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "CAT", 0, 0, output.data(), static_cast<uint32_t>(output.size())) < 0) return 1;
  return 0;
}
