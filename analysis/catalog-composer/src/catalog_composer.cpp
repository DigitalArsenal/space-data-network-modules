// CAT composition is selection over immutable provider records. The output
// retains the selected record's exact bytes; no inferred orbit or identifier
// is written into a CAT. The recipe comes in and the decisions go out as SDS
// $XMT (COMPOSE_RECIPE / COMPOSE_REPORT).
#include "space_data_module_invoke.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <map>
#include <set>
#include <string>
#include <tuple>
#include <vector>

using Json = nlohmann::json;  // only to spell the composite object keys ("source:[...]", "unresolved:[...]")
namespace {
constexpr size_t kMaxRecords = 250000;
constexpr size_t kMaxBytes = 128 * 1024 * 1024;
std::string str(const flatbuffers::String* value) { return value ? value->str() : ""; }
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
// One size-prefixed $XMT on a recipe port, verified; null when it is not one.
const XMT* read_xmt(const plugin_input_frame_t* frame, size_t limit) {
  if (!frame || !frame->payload || frame->payload_length < 12 || frame->payload_length > limit) return nullptr;
  if (flatbuffers::ReadScalar<uint32_t>(frame->payload) != frame->payload_length - 4) return nullptr;
  flatbuffers::Verifier verifier(frame->payload, frame->payload_length, 64, 100000000);
  if (!VerifySizePrefixedXMTBuffer(verifier)) return nullptr;
  return GetSizePrefixedXMT(frame->payload);
}
// The report port carries one size-prefixed $XMT.
int push_report(const XMTT& report) {
  flatbuffers::FlatBufferBuilder builder(4096);
  FinishSizePrefixedXMTBuffer(builder, XMT::Pack(builder, &report));
  return plugin_push_output_ex("report", "XMT.fbs", "$XMT", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "XMT", 0, 0, builder.GetBufferPointer(), builder.GetSize()) < 0 ? 1 : 0;
}
using Strings = flatbuffers::Vector<flatbuffers::Offset<flatbuffers::String>>;
// Distinct non-empty IDs; an absent list is empty.
bool distinct(const Strings* values) {
  if (!values) return true;
  std::set<std::string> seen;
  for (const auto* value : *values) {
    const auto id = str(value);
    if (id.empty() || !seen.insert(id).second) return false;
  }
  return true;
}
std::vector<std::string> list(const Strings* values) {
  std::vector<std::string> out;
  if (values) for (const auto* value : *values) out.push_back(str(value));
  return out;
}
struct Record {
  size_t layer, ordinal;
  const uint8_t* bytes;
  uint32_t length;
  std::string key, name, designator, nativeKey;
  uint32_t norad;
};
using StateIndex = std::map<std::string, std::map<std::string, const XMTStateCandidate*>>;
std::unique_ptr<XMTStateSelectionT> selectState(const std::string& key, const std::vector<std::string>& sources, double maxAge, double asOf, const StateIndex& states) {
  const auto candidates = states.find(key);
  bool found = false, past = false;
  auto out = std::make_unique<XMTStateSelectionT>();
  for (const auto& source : sources) {
    if (candidates == states.end()) continue;
    const auto candidate = candidates->second.find(source);
    if (candidate == candidates->second.end()) continue;
    found = true;
    const auto* newest = candidate->second;
    if (newest) past = true;
    if (newest && asOf - static_cast<double>(newest->EPOCH_MS()) / 1000 <= maxAge) {
      out->STATUS = xmtStateChoice::Selected;
      out->SOURCE_ID = source;
      out->RECORD_ID = str(newest->RECORD_ID());
      out->EPOCH_MS = newest->EPOCH_MS();
      return out;
    }
  }
  out->STATUS = sources.empty() ? xmtStateChoice::Unconfigured : past ? xmtStateChoice::Stale : found ? xmtStateChoice::Future : xmtStateChoice::Missing;
  out->SOURCES = sources;
  return out;
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
  const XMT* message = read_xmt(recipeFrame, 32 * 1024 * 1024);
  if (!message) return fail("A bounded $XMT recipe frame is required.");
  const auto* recipe = message->COMPOSE_RECIPE();
  const auto* layers = recipe ? recipe->LAYERS() : nullptr;
  if (!recipe || !layers || layers->size() == 0 || layers->size() != inputs.size() || layers->size() > 16) return fail("A COMPOSE_RECIPE needs one catalog frame per layer, in priority order (maximum 16).");
  if (recipe->IDENTITY_RULE() != xmtIdentityRule::NoradFirst && recipe->IDENTITY_RULE() != xmtIdentityRule::InternationalDesignator) return fail("Unknown identity rule.");
  const bool internationalIdentity = recipe->IDENTITY_RULE() == xmtIdentityRule::InternationalDesignator;
  const double asOf = static_cast<double>(recipe->AS_OF_MS()) / 1000, maxAge = internationalIdentity ? INFINITY : recipe->MAX_AGE_S();
  if (!std::isfinite(asOf) || asOf <= 0 || (!internationalIdentity && !std::isfinite(maxAge)) || !(maxAge >= 0) || !distinct(recipe->STATE_SOURCES())) return fail("Specify asOf, a nonnegative maximum state age, and distinct state source IDs.");
  const std::vector<std::string> stateSources = list(recipe->STATE_SOURCES());
  std::map<std::string, const XMTObjectOverride*> overrides;
  if (recipe->OVERRIDES()) for (const auto* override : *recipe->OVERRIDES()) {
    if (str(override->OBJECT_KEY()).empty() || !overrides.emplace(str(override->OBJECT_KEY()), override).second) return fail("An object override is malformed.");
    if (!distinct(override->STATE_SOURCES())) return fail("Override state sources must be distinct IDs.");
    if (!std::isnan(override->MAX_AGE_S()) && (!std::isfinite(override->MAX_AGE_S()) || override->MAX_AGE_S() < 0)) return fail("An override state age is invalid.");
  }
  std::set<std::tuple<std::string, std::string, int64_t>> stateIdentities;
  StateIndex stateIndex;
  if (recipe->STATE_CANDIDATES()) for (const auto* state : *recipe->STATE_CANDIDATES()) {
    if (str(state->OBJECT_KEY()).empty() || str(state->SOURCE_ID()).empty() || str(state->RECORD_ID()).empty() || state->EPOCH_MS() <= 0) return fail("A state candidate requires an object, source, record ID and positive finite epoch.");
    if (!stateIdentities.insert({str(state->OBJECT_KEY()), str(state->SOURCE_ID()), state->EPOCH_MS()}).second) return fail("State candidates disagree at the same source epoch; resolve the ambiguity first.");
    auto& newest = stateIndex[str(state->OBJECT_KEY())][str(state->SOURCE_ID())];
    const double epoch = static_cast<double>(state->EPOCH_MS()) / 1000;
    if (epoch <= asOf && (!newest || state->EPOCH_MS() > newest->EPOCH_MS())) newest = state;
  }

  std::map<std::string, std::vector<std::string>> coverageIndex;
  if (recipe->COVERAGE()) for (const auto* source : *recipe->COVERAGE()) {
    const auto id = str(source->SOURCE_ID());
    if (id.empty() || str(source->HEAD()).empty() || !distinct(source->OBJECTS())) return fail("Coverage needs a source, immutable publication and distinct international designators.");
    for (const auto& designator : list(source->OBJECTS())) {
      if (!cospar(designator)) return fail("Coverage identifiers must be international designators.");
      coverageIndex["cospar:" + designator].push_back(id);
    }
  }

  std::vector<Record> records;
  std::map<std::string, std::vector<size_t>> groups;
  std::set<std::string> layerIds;
  std::map<std::string, std::set<uint32_t>> designatorOwners;
  size_t totalBytes = 0;
  for (size_t layerIndex = 0; layerIndex < layers->size(); ++layerIndex) {
    const auto* layer = layers->Get(layerIndex);
    const auto id = str(layer->ID());
    if (id.empty() || !layerIds.insert(id).second || str(layer->NODE()).empty() || str(layer->PROVIDER()).empty() || str(layer->SOURCE()).empty() || str(layer->HEAD()).empty()) return fail("Every layer needs a unique ID, node, provider, source and immutable publication head.");
    const auto* frame = inputs[layerIndex];
    totalBytes += frame->payload_length;
    if (totalBytes > kMaxBytes || (frame->payload_length && !frame->payload)) return fail("Catalog input exceeds the 128 MiB limit.");
    const auto* nativeKeys = layer->NATIVE_KEYS();
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
      if (nativeKeys && ordinal < nativeKeys->size()) record.nativeKey = str(nativeKeys->Get(static_cast<flatbuffers::uoffset_t>(ordinal)));
      if (internationalIdentity && cospar(record.designator)) record.key = "cospar:" + record.designator;
      else if (internationalIdentity) record.key = "unresolved:" + Json::array({str(layer->NODE()), id, ordinal}).dump();
      else if (record.norad) record.key = "norad:" + std::to_string(record.norad);
      else if (cospar(record.designator)) record.key = "cospar:" + record.designator;
      else if (!record.nativeKey.empty()) record.key = "source:" + Json::array({str(layer->PROVIDER()), str(layer->SOURCE()), record.nativeKey}).dump();
      else return fail("An unnumbered object needs a valid international designator or its original source-native key.");
      if (!layerKeys.insert(record.key).second) return fail("A layer contains duplicate object identities; choose one edition first.");
      if (record.norad && cospar(record.designator)) designatorOwners[record.designator].insert(record.norad);
      records.push_back(std::move(record));
      if (records.size() > kMaxRecords) return fail("Catalog composition exceeds the 250000-record limit.");
      offset += size + 4; ++ordinal;
    }
    if (nativeKeys && nativeKeys->size() && nativeKeys->size() != ordinal) return fail("Native keys must match the catalog record count exactly.");
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
  XMTT result;
  result.COMPOSE_REPORT = std::make_unique<XMTComposeReportT>();
  auto& report = *result.COMPOSE_REPORT;
  size_t conflictCount = 0;
  for (const auto& [key, indices] : groups) {
    std::set<size_t> sourceLayers;
    for (size_t index : indices) if (!sourceLayers.insert(records[index].layer).second) return fail("A layer repeats an object through both numbered and international-designator identities.");
    const auto found_override = overrides.find(key);
    const XMTObjectOverride* override = found_override == overrides.end() ? nullptr : found_override->second;
    size_t chosen = indices.front();
    const auto preferred = override ? str(override->CATALOG_LAYER()) : "";
    if (!preferred.empty()) {
      const auto found = std::find_if(indices.begin(), indices.end(), [&](size_t index) { return str(layers->Get(static_cast<flatbuffers::uoffset_t>(records[index].layer))->ID()) == preferred; });
      if (found == indices.end()) return fail("An object override names a layer that does not contain that object.");
      chosen = *found;
    }
    const auto& selected = records[chosen];
    std::set<std::string> designators;
    auto row = std::make_unique<XMTComposedObjectT>();
    for (size_t index : indices) {
      const auto& record = records[index];
      if (cospar(record.designator)) designators.insert(record.designator);
      auto candidate = std::make_unique<XMTLayerRecordT>();
      candidate->LAYER = str(layers->Get(static_cast<flatbuffers::uoffset_t>(record.layer))->ID());
      candidate->ORDINAL = static_cast<uint32_t>(record.ordinal);
      candidate->NATIVE_KEY = record.nativeKey;
      candidate->NAME = record.name;
      candidate->DESIGNATOR = record.designator;
      row->CANDIDATES.push_back(std::move(candidate));
    }
    bool conflict = internationalIdentity ? !cospar(selected.designator) : designators.size() > 1;
    if (!internationalIdentity) for (const auto& designator : designators) if (designatorOwners[designator].size() > 1) conflict = true;
    if (conflict) ++conflictCount;
    // Conflicting identifiers are visible but never silently published. A
    // per-object layer choice is the user's explicit resolution.
    const bool resolved = internationalIdentity ? !conflict : !conflict || !preferred.empty();
    if (resolved) output.insert(output.end(), selected.bytes, selected.bytes + selected.length);
    // An override's state sources replace the recipe's; an empty list keeps the recipe's.
    const bool overrideSources = override && override->STATE_SOURCES() && override->STATE_SOURCES()->size();
    const auto sources = overrideSources ? list(override->STATE_SOURCES()) : stateSources;
    const double objectMaxAge = override && !std::isnan(override->MAX_AGE_S()) ? override->MAX_AGE_S() : maxAge;
    auto state = selectState(key, sources, objectMaxAge, asOf, stateIndex);
    if (internationalIdentity) {
      std::vector<std::string> covered;
      for (const auto& source : stateSources) {
        const auto& candidates = coverageIndex[key];
        if (std::find(candidates.begin(), candidates.end(), source) != candidates.end()) covered.push_back(source);
      }
      const auto selectedSource = overrideSources ? str(override->STATE_SOURCES()->Get(0)) : covered.size() == 1 ? covered.front() : "";
      if (!selectedSource.empty() && std::find(covered.begin(), covered.end(), selectedSource) == covered.end()) return fail("The selected orbital source does not declare coverage of this object.");
      state = std::make_unique<XMTStateSelectionT>();
      state->STATUS = !selectedSource.empty() ? xmtStateChoice::Covered : covered.size() > 1 ? xmtStateChoice::Overlap : xmtStateChoice::Missing;
      state->SOURCE_ID = selectedSource;
      state->SOURCES = covered;
    }
    row->KEY = key;
    row->INTERNATIONAL_DESIGNATOR = selected.designator;
    row->NAME = selected.name;
    row->SELECTED_LAYER = str(layers->Get(static_cast<flatbuffers::uoffset_t>(selected.layer))->ID());
    row->STATUS = resolved ? xmtRecordChoice::Selected : internationalIdentity ? xmtRecordChoice::MissingDesignator : xmtRecordChoice::IdentityConflict;
    row->STATE = std::move(state);
    report.OBJECTS.push_back(std::move(row));
  }
  report.INPUT_RECORDS = static_cast<uint32_t>(records.size());
  report.OBJECT_COUNT = static_cast<uint32_t>(report.OBJECTS.size());
  report.IDENTITY_CONFLICTS = static_cast<uint32_t>(conflictCount);
  if (push_report(result)) return 1;
  if (!output.empty() && plugin_push_output_ex("catalog", "CAT.fbs", "$CAT", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "CAT", 0, 0, output.data(), static_cast<uint32_t>(output.size())) < 0) return 1;
  return 0;
}
