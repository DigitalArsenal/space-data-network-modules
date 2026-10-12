// The $CAT integrator. One call takes the composed catalog and every source's products and gives the catalog, the
// product chosen for each object, and the report that says how (catalog pipeline C3, graph/programs/catalog-pipeline.md).
//
//   recipe        JSON   asOf, the identity links, the selection policy with its measured table, the maneuver policy
//   catalog       $CAT   the composed catalog (compose's output, or one snapshot): each object once
//   ephemerides   $OEM   the normalized trajectories of the identity candidates, in candidate order
//   omm_products  $OMM   every source's element sets, each naming its source in PROVENANCE as analysis/gp-error-model writes it
//   ocm_products  $OCM   every source's states and covariance, with the covariance's realism (COV_REALISM)
//   mnv_products  $MNV   every source's maneuvers, each naming its source in PROVENANCE
//   -> catalog    $CAT   the input objects, in order; MANEUVERABLE is true where the history shows a maneuver
//      omm        $OMM   per object and product kind (SGP4, SGP4-XP) the element set of the selected source, byte for byte
//      ocm        $OCM   the selected product's state and covariance with its realism, byte for byte
//      mnv        $MNV   the maneuvers of every source, merged within the policy's tolerances
//      report     JSON   per object every candidate, why one was chosen or none, the covariance's realism, record CIDs
//
// The steps, in order: identity (a source's own names join objects only through links the trajectories supported),
// maneuvers (merged; MANEUVERABLE; a burn after a product's epoch retires it), selection (the lowest measured median
// error among the products that remain), covariance (the selected product's own). Nothing is estimated here and no
// record is edited except the catalog's MANEUVERABLE and a merged maneuver's status and tags.
namespace integrate {

int refuse(const char* code, const std::string& message) {
  plugin_set_error(code, message.c_str());
  return 1;
}
int bad_recipe(const std::string& message) { return refuse("invalid-integration-recipe", message); }

// A product's object in the catalog, from what the record says and the links that bound a native name.
struct Index {
  std::map<uint32_t, size_t> norad;
  std::map<std::string, size_t> cospar;
  std::map<Native, size_t> native;
};
enum class Link { Found, Unlinked, Conflict };
Link link_of(const Identity& who, const std::string& source, const Index& index, size_t* object) {
  std::set<size_t> found;
  if (who.norad) { const auto it = index.norad.find(who.norad); if (it != index.norad.end()) found.insert(it->second); }
  if (!who.cospar.empty()) { const auto it = index.cospar.find(who.cospar); if (it != index.cospar.end()) found.insert(it->second); }
  if (!who.native.empty()) { const auto it = index.native.find({source, who.native}); if (it != index.native.end()) found.insert(it->second); }
  if (found.size() > 1) return Link::Conflict;
  if (found.empty()) return Link::Unlinked;
  *object = *found.begin();
  return Link::Found;
}
Json who_json(const Identity& who) {
  Json out = Json::object();
  if (who.norad) out["norad"] = who.norad;
  if (!who.cospar.empty()) out["cospar"] = who.cospar;
  if (!who.native.empty()) out["native"] = who.native;
  return out;
}

struct PerObject {
  std::vector<const Omm*> omms;
  std::vector<const Ocm*> ocms;
  std::vector<const Mnv*> mnvs;
};

std::string instant_text(int64_t micros) {
  int64_t days = micros / 86400000000LL, rem = micros % 86400000000LL;
  if (rem < 0) { rem += 86400000000LL; --days; }
  // civil_from_days (Hinnant)
  const int64_t z = days + 719468;
  const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const unsigned doe = static_cast<unsigned>(z - era * 146097);
  const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const int64_t y = static_cast<int64_t>(yoe) + era * 400;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const unsigned mp = (5 * doy + 2) / 153;
  const unsigned d = doy - (153 * mp + 2) / 5 + 1;
  const unsigned m = mp < 10 ? mp + 3 : mp - 9;
  char buffer[48];
  std::snprintf(buffer, sizeof(buffer), "%04lld-%02u-%02uT%02lld:%02lld:%02lld.%06lldZ", static_cast<long long>(y + (m <= 2)), m, d, static_cast<long long>(rem / 3600000000LL),
                static_cast<long long>(rem / 60000000LL % 60), static_cast<long long>(rem / 1000000LL % 60), static_cast<long long>(rem % 1000000LL));
  return buffer;
}

// The label a product carries for its covariance: from its $OCM when it has one, else from its $OMM.
Json covariance_of(const Omm& omm, const Ocm* ocm) {
  Json out = {{"from", ocm ? "ocm" : omm.label.is_null() ? "none" : "omm"}};
  if (ocm) {
    out["calibration"] = ocm->calibration;
    out["label"] = ocm->label;
  } else if (!omm.label.is_null()) {
    out["calibration"] = field(omm.label, "calibration");
    out["label"] = omm.label;
  }
  return out;
}

}  // namespace integrate

extern "C" int integrate_catalog(void) {
  using namespace integrate;
  const plugin_input_frame_t *recipe_frame = nullptr, *catalog_frame = nullptr;
  std::vector<const plugin_input_frame_t*> ephemerides, omm_frames, ocm_frames, mnv_frames;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* frame = plugin_get_input_frame(i);
    if (!frame || !frame->port_id) return refuse("invalid-integration-input", "An input frame has no port.");
    const std::string port = frame->port_id;
    if (port == "recipe") {
      if (recipe_frame) return bad_recipe("Exactly one recipe frame is required.");
      recipe_frame = frame;
    } else if (port == "catalog") {
      if (catalog_frame) return refuse("invalid-integration-input", "Exactly one catalog frame is required.");
      catalog_frame = frame;
    } else if (port == "ephemerides") ephemerides.push_back(frame);
    else if (port == "omm_products") omm_frames.push_back(frame);
    else if (port == "ocm_products") ocm_frames.push_back(frame);
    else if (port == "mnv_products") mnv_frames.push_back(frame);
    else return refuse("invalid-integration-input", "Unknown input port.");
  }
  if (!recipe_frame || !recipe_frame->payload || recipe_frame->payload_length > 32 * 1024 * 1024) return bad_recipe("A bounded recipe frame is required.");
  if (!catalog_frame) return refuse("invalid-integration-input", "A catalog frame is required.");
  const Json recipe = Json::parse(recipe_frame->payload, recipe_frame->payload + recipe_frame->payload_length, nullptr, false);
  if (recipe.is_discarded() || number(field(recipe, "version")) != 1) return bad_recipe("The integration recipe is version 1.");
  const double as_of_seconds = number(field(recipe, "asOf"));
  if (!std::isfinite(as_of_seconds) || as_of_seconds <= 0) return bad_recipe("Specify asOf as positive finite Unix seconds.");
  const int64_t as_of = static_cast<int64_t>(std::llround(as_of_seconds * 1e6));
  std::string error;
  SelectionPolicy selection;
  ManeuverPolicy maneuvers;
  if (!parse_selection_policy(field(recipe, "selection"), &selection, &error) || !parse_maneuver_policy(field(recipe, "maneuvers"), &maneuvers, &error)) return bad_recipe(error);

  // The records.
  std::vector<CatObject> catalog;
  size_t bytes = catalog_frame->payload_length;
  if (bytes > kMaxInputBytes) return refuse("invalid-integration-input", "Integration input exceeds the 128 MiB limit.");
  if (!read_catalog(catalog_frame, &catalog, &error)) return refuse("invalid-integration-input", error);
  std::vector<Omm> omms;
  std::vector<Ocm> ocms;
  std::vector<Mnv> mnvs;
  std::vector<Refusal> refused;
  if (!read_port<Omm>(omm_frames, [](const uint8_t* r, uint32_t n) { flatbuffers::Verifier v(r, n); return VerifySizePrefixedOMMBuffer(v); }, read_omm, &omms, &refused, &bytes, &error) ||
      !read_port<Ocm>(ocm_frames, [](const uint8_t* r, uint32_t n) { flatbuffers::Verifier v(r, n); return VerifySizePrefixedOCMBuffer(v); }, read_ocm, &ocms, &refused, &bytes, &error) ||
      !read_port<Mnv>(mnv_frames, [](const uint8_t* r, uint32_t n) { flatbuffers::Verifier v(r, n); return VerifySizePrefixedMNVBuffer(v); }, read_mnv, &mnvs, &refused, &bytes, &error)) {
    return refuse("invalid-integration-input", error);
  }

  Index index;
  std::set<std::string> catalog_keys;
  for (const auto& object : catalog) {
    if (object.norad) { index.norad[object.norad] = object.ordinal; catalog_keys.insert("norad:" + std::to_string(object.norad)); }
    if (!object.cospar.empty()) { index.cospar[object.cospar] = object.ordinal; catalog_keys.insert("cospar:" + object.cospar); }
  }

  // Identity.
  Json identity_report = Json();
  const auto& identity = field(recipe, "identity");
  if (!identity.is_null()) {
    Links links;
    if (!resolve_identity(identity, ephemerides, catalog_keys, &links, &error)) return refuse("invalid-integration-input", error);
    for (const auto& [native, key] : links.bound) {
      const size_t colon = key.find(':');
      const std::string value = key.substr(colon + 1);
      index.native[native] = key.compare(0, colon, "norad") == 0 ? index.norad.at(static_cast<uint32_t>(std::stoul(value))) : index.cospar.at(value);
    }
    identity_report = links.report;
  } else if (!ephemerides.empty()) {
    return bad_recipe("Ephemerides need an identity section that names their candidates.");
  }

  // Each product to its object.
  std::vector<PerObject> per(catalog.size());
  Json unlinked = Json::array();
  std::map<std::string, size_t> unlinked_counts;
  auto place = [&](const char* kind, size_t ordinal, const Identity& who, const std::string& source, auto&& attach) {
    size_t object = 0;
    const Link link = link_of(who, source, index, &object);
    if (link == Link::Found) { attach(per[object]); return; }
    const char* reason = link == Link::Conflict ? "identity-conflict" : who.native.empty() || (who.norad || !who.cospar.empty()) ? "not-in-catalog" : "unbound-native-identity";
    ++unlinked_counts[reason];
    if (unlinked.size() < 1000) unlinked.push_back({{"record", kind}, {"ordinal", ordinal}, {"source", source}, {"who", who_json(who)}, {"reason", reason}});
  };
  for (const auto& p : omms) place("omm", p.ordinal, p.who, p.source, [&](PerObject& o) { o.omms.push_back(&p); });
  for (const auto& p : ocms) place("ocm", p.ordinal, p.who, p.source, [&](PerObject& o) { o.ocms.push_back(&p); });
  for (const auto& p : mnvs) place("mnv", p.ordinal, p.who, p.source, [&](PerObject& o) { o.mnvs.push_back(&p); });

  // Per object: maneuvers, selection, covariance.
  std::vector<uint8_t> catalog_out, omm_out, ocm_out, mnv_out;
  Json objects = Json::array();
  size_t counts_selected = 0, counts_stale = 0, counts_no_product = 0, counts_unmeasured = 0, counts_maneuverable = 0, counts_events = 0, counts_merged = 0, counts_without_ocm = 0;
  for (const auto& object : catalog) {
    const PerObject& mine = per[object.ordinal];
    const std::vector<Event> events = merge_maneuvers(mine.mnvs, maneuvers);
    const bool maneuverable = is_maneuverable(events, maneuvers, as_of);
    const Event* retiring = latest_retiring(events, maneuvers, as_of);
    counts_events += events.size();

    // The catalog record: its own bytes unless the history says it maneuvers and it does not.
    if (maneuverable && !object.maneuverable) {
      std::unique_ptr<CATT> record(GetSizePrefixedCAT(object.bytes)->UnPack());
      record->MANEUVERABLE = true;
      flatbuffers::FlatBufferBuilder fbb(1024);
      FinishSizePrefixedCATBuffer(fbb, CreateCAT(fbb, record.get()));
      catalog_out.insert(catalog_out.end(), fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
    } else {
      catalog_out.insert(catalog_out.end(), object.bytes, object.bytes + object.length);
    }
    if (maneuverable) ++counts_maneuverable;

    const std::string key = object.norad ? "norad:" + std::to_string(object.norad) : !object.cospar.empty() ? "cospar:" + object.cospar : "unkeyed:" + std::to_string(object.ordinal);
    Json row = {{"key", key}, {"norad", object.norad}, {"cospar", object.cospar},
                {"name", object.name}, {"maneuverable", maneuverable || object.maneuverable}, {"maneuverableFromHistory", maneuverable}};

    Json event_rows = Json::array();
    for (const Event& e : events) {
      const auto record = event_record(e);
      mnv_out.insert(mnv_out.end(), record.begin(), record.end());
      Json members = Json::array();
      for (const Mnv* m : e.members) members.push_back({{"source", m->source}, {"status", EnumNamemaneuverStatus(m->status)}, {"id", m->id}, {"time", instant_text(m->time)}});
      Json ids = record_ids(record.data(), record.size());
      event_rows.push_back({{"time", instant_text(began(e))}, {"status", EnumNamemaneuverStatus(e.status)}, {"deltaVKmS", std::isfinite(e.primary->delta_v) ? Json(e.primary->delta_v) : Json()},
                            {"members", members}, {"sha256", ids["sha256"]}, {"cid", ids["cid"]}});
      if (e.members.size() > 1) ++counts_merged;
    }
    row["maneuvers"] = event_rows;

    // The object's regime: the first the covariance labels of its products name, in source order.
    std::vector<const Omm*> ordered = mine.omms;
    std::stable_sort(ordered.begin(), ordered.end(), [&](const Omm* a, const Omm* b) {
      const size_t oa = selection.order_of(a->source), ob = selection.order_of(b->source);
      if (oa != ob) return oa < ob;
      if (a->epoch != b->epoch) return a->epoch > b->epoch;
      return a->source < b->source;
    });
    std::string regime;
    for (const Omm* omm : ordered) if (regime.empty()) regime = omm->regime;
    row["regime"] = regime.empty() ? Json() : Json(regime);

    std::set<std::string> kinds;
    for (const Omm* omm : mine.omms) kinds.insert(omm->product);
    Json kind_rows = Json::array();
    bool any_selected = false;
    for (const std::string& kind : kinds) {
      std::vector<const Omm*> of_kind;
      for (const Omm* omm : mine.omms) if (omm->product == kind) of_kind.push_back(omm);
      const std::vector<Candidate> candidates = candidates_of(of_kind, regime, as_of, retiring, selection);
      const Choice choice = choose(candidates, selection);
      Json candidate_rows = Json::array();
      for (const Candidate& c : candidates) {
        Json r = {{"source", c.omm->source}, {"epoch", instant_text(c.omm->epoch)}, {"ageDays", c.age_days},
                  {"status", &c == choice.winner ? "selected" : std::strcmp(c.status, "eligible") == 0 ? "not-selected" : c.status}, {"measured", c.measured}};
        if (std::isfinite(c.median)) { r["median3dKm"] = c.median; r["samples"] = c.samples; }
        if (std::strcmp(c.status, "retired") == 0 && retiring) r["retiredBy"] = instant_text(began(*retiring));
        r["sha256"] = record_ids(c.omm->bytes, c.omm->length)["sha256"];
        candidate_rows.push_back(r);
      }
      Json kind_row = {{"product", kind}, {"candidates", candidate_rows}};
      if (choice.winner) {
        const Omm& win = *choice.winner->omm;
        const Ocm* paired = nullptr;
        for (const Ocm* ocm : mine.ocms) {
          if (ocm->source == win.source && ocm->has_epoch && std::llabs(ocm->first_epoch - win.epoch) <= 1000 && (!paired || ocm->ordinal < paired->ordinal)) paired = ocm;
        }
        omm_out.insert(omm_out.end(), win.bytes, win.bytes + win.length);
        if (paired) ocm_out.insert(ocm_out.end(), paired->bytes, paired->bytes + paired->length);
        else ++counts_without_ocm;
        ++counts_selected;
        any_selected = true;
        if (std::strcmp(choice.reason, "unmeasured-fallback-order") == 0) ++counts_unmeasured;
        kind_row["selected"] = {{"source", win.source}, {"epoch", instant_text(win.epoch)}, {"reason", choice.reason}, {"tie", choice.tie}, {"omm", record_ids(win.bytes, win.length)},
                                {"ocm", paired ? record_ids(paired->bytes, paired->length) : Json()}, {"covariance", covariance_of(win, paired)}};
        if (choice.winner->measured) kind_row["selected"]["measured"] = {{"median3dKm", choice.winner->median}, {"samples", choice.winner->samples}, {"regime", regime}, {"horizonDays", selection.horizon}};
      } else {
        kind_row["status"] = "stale";
      }
      kind_rows.push_back(kind_row);
    }
    row["products"] = kind_rows;
    row["status"] = any_selected ? "selected" : mine.omms.empty() ? "no-product" : "stale";
    if (!any_selected) {
      if (mine.omms.empty()) ++counts_no_product;
      else ++counts_stale;
    }
    objects.push_back(row);
  }

  Json refused_rows = Json::array();
  for (size_t i = 0; i < refused.size() && i < 1000; ++i) refused_rows.push_back({{"record", refused[i].record}, {"ordinal", refused[i].ordinal}, {"reason", refused[i].reason}});
  const Json report = {
      {"version", 1},
      {"method", "integrate_catalog"},
      {"asOf", instant_text(as_of)},
      {"policy", {{"selection", selection_policy_json(selection)}, {"maneuvers", maneuver_policy_json(maneuvers)}}},
      {"counts", {{"catalogRecords", catalog.size()}, {"ommRecords", omms.size()}, {"ocmRecords", ocms.size()}, {"mnvRecords", mnvs.size()}, {"selected", counts_selected}, {"stale", counts_stale},
                  {"noProduct", counts_no_product}, {"unmeasured", counts_unmeasured}, {"withoutOcm", counts_without_ocm}, {"maneuverable", counts_maneuverable}, {"maneuverEvents", counts_events},
                  {"mergedEvents", counts_merged}, {"unlinked", unlinked_counts}, {"refused", refused.size()}}},
      {"identity", identity_report},
      {"objects", objects},
      {"unlinked", unlinked},
      {"refused", refused_rows}};
  const std::string dumped = report.dump();
  auto push = [](const char* port, const char* schema, const char* identifier, const char* root, const std::vector<uint8_t>& data) {
    return data.empty() || plugin_push_output_ex(port, schema, identifier, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0, data.data(), static_cast<uint32_t>(data.size())) >= 0;
  };
  if (plugin_push_output_ex("report", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1, reinterpret_cast<const uint8_t*>(dumped.data()), static_cast<uint32_t>(dumped.size())) < 0) return 1;
  if (!push("catalog", "CAT.fbs", "$CAT", "CAT", catalog_out) || !push("omm", "OMM.fbs", "$OMM", "OMM", omm_out) || !push("ocm", "OCM.fbs", "$OCM", "OCM", ocm_out) ||
      !push("mnv", "MNV.fbs", "$MNV", "MNV", mnv_out)) return 1;
  return 0;
}
