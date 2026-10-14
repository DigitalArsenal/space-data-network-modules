// The $CAT integrator. One call takes the composed catalog and every source's products and gives the catalog, the
// product chosen for each object, and the report that says how (catalog pipeline C3, graph/programs/catalog-pipeline.md).
//
//   recipe        $XMT   INTEGRATE_RECIPE: asOf, the identity links, the selection policy with its measured table, the maneuver policy
//   catalog       $CAT   the composed catalog (compose's output, or one snapshot): each object once
//   ephemerides   $OEM   the normalized trajectories of the identity candidates, in candidate order
//   omm_products  $OMM   every source's element sets, each naming its source in PROVENANCE as analysis/gp-error-model writes it
//   ocm_products  $OCM   every source's states and covariance, with the covariance's realism (COV_REALISM)
//   mnv_products  $MNV   every source's maneuvers, each naming its source in PROVENANCE
//   -> catalog    $CAT   the input objects, in order; MANEUVERABLE is true where the history shows a maneuver
//      omm        $OMM   per object and product kind (SGP4, SGP4-XP) the element set of the selected source, byte for byte
//      ocm        $OCM   the selected product's state and covariance with its realism, byte for byte
//      mnv        $MNV   the maneuvers of every source, merged within the policy's tolerances
//      report     $XMT   INTEGRATE_REPORT: per object every candidate, why one was chosen or none, the covariance's realism, record CIDs
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
struct PerObject {
  std::vector<const Omm*> omms;
  std::vector<const Ocm*> ocms;
  std::vector<const Mnv*> mnvs;
};

// Microseconds to Unix milliseconds, rounded down (the report's instants are milliseconds).
int64_t ms_of(int64_t micros) { return micros >= 0 ? micros / 1000 : -((-micros + 999) / 1000); }

// The label a product carries for its covariance: from its $OCM when it has one, else from its $OMM.
void covariance_of(const Omm& omm, const Ocm* ocm, XMTProductSelectionT* out) {
  if (ocm) {
    out->COVARIANCE_ORIGIN = xmtCovarianceOrigin::FromOcm;
    if (ocm->label) out->COVARIANCE.reset(ocm->label->UnPack());
    else { out->COVARIANCE = std::make_unique<CVRT>(); out->COVARIANCE->CALIBRATION = ocm->calibration; }
  } else if (omm.label) {
    out->COVARIANCE_ORIGIN = xmtCovarianceOrigin::FromOmm;
    out->COVARIANCE.reset(omm.label->UnPack());
  }
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
  if (!catalog_frame) return refuse("invalid-integration-input", "A catalog frame is required.");
  const XMT* message = read_xmt(recipe_frame, 32 * 1024 * 1024);
  const XMTIntegrateRecipe* recipe = message ? message->INTEGRATE_RECIPE() : nullptr;
  if (!recipe) return bad_recipe("A bounded $XMT INTEGRATE_RECIPE frame is required.");
  if (recipe->AS_OF_MS() <= 0) return bad_recipe("Specify AS_OF_MS as positive Unix milliseconds.");
  const int64_t as_of = recipe->AS_OF_MS() * 1000;
  std::string error;
  SelectionPolicy selection;
  ManeuverPolicy maneuvers;
  if (!parse_selection_policy(recipe->SELECTION(), &selection, &error) || !parse_maneuver_policy(recipe->MANEUVERS(), &maneuvers, &error)) return bad_recipe(error);

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
  std::unique_ptr<XMTMatchReportT> identity_report;
  if (const auto* identity = recipe->IDENTITY()) {
    Links links;
    if (!resolve_identity(identity, ephemerides, catalog_keys, &links, &error)) return refuse("invalid-integration-input", error);
    for (const auto& [native, key] : links.bound) {
      const size_t colon = key.find(':');
      const std::string value = key.substr(colon + 1);
      index.native[native] = key.compare(0, colon, "norad") == 0 ? index.norad.at(static_cast<uint32_t>(std::stoul(value))) : index.cospar.at(value);
    }
    identity_report = std::move(links.report);
  } else if (!ephemerides.empty()) {
    return bad_recipe("Ephemerides need an identity section that names their trajectories.");
  }

  // Each product to its object.
  std::vector<PerObject> per(catalog.size());
  XMTT result;
  result.INTEGRATE_REPORT = std::make_unique<XMTIntegrateReportT>();
  XMTIntegrateReportT& report = *result.INTEGRATE_REPORT;
  std::map<std::string, size_t> unlinked_counts;
  auto place = [&](xmtRecordKind kind, size_t ordinal, const Identity& who, const std::string& source, auto&& attach) {
    size_t object = 0;
    const Link link = link_of(who, source, index, &object);
    if (link == Link::Found) { attach(per[object]); return; }
    const char* reason = link == Link::Conflict ? "identity-conflict" : who.native.empty() || (who.norad || !who.cospar.empty()) ? "not-in-catalog" : "unbound-native-identity";
    ++unlinked_counts[reason];
    if (report.UNLINKED.size() < 1000) {
      auto row = std::make_unique<XMTUnplacedRecordT>();
      row->KIND = kind; row->ORDINAL = static_cast<uint32_t>(ordinal); row->SOURCE_ID = source;
      row->NORAD_CAT_ID = who.norad; row->INTERNATIONAL_DESIGNATOR = who.cospar; row->NATIVE_ID = who.native; row->REASON = reason;
      report.UNLINKED.push_back(std::move(row));
    }
  };
  for (const auto& p : omms) place(xmtRecordKind::Omm, p.ordinal, p.who, p.source, [&](PerObject& o) { o.omms.push_back(&p); });
  for (const auto& p : ocms) place(xmtRecordKind::Ocm, p.ordinal, p.who, p.source, [&](PerObject& o) { o.ocms.push_back(&p); });
  for (const auto& p : mnvs) place(xmtRecordKind::Mnv, p.ordinal, p.who, p.source, [&](PerObject& o) { o.mnvs.push_back(&p); });

  // Per object: maneuvers, selection, covariance.
  std::vector<uint8_t> catalog_out, omm_out, ocm_out, mnv_out;
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

    auto row = std::make_unique<XMTIntegratedObjectT>();
    row->KEY = object.norad ? "norad:" + std::to_string(object.norad) : !object.cospar.empty() ? "cospar:" + object.cospar : "unkeyed:" + std::to_string(object.ordinal);
    row->NORAD_CAT_ID = object.norad;
    row->INTERNATIONAL_DESIGNATOR = object.cospar;
    row->NAME = object.name;
    row->MANEUVERABLE = maneuverable || object.maneuverable;
    row->MANEUVERABLE_FROM_HISTORY = maneuverable;

    for (const Event& e : events) {
      const auto record = event_record(e);
      mnv_out.insert(mnv_out.end(), record.begin(), record.end());
      auto event = std::make_unique<XMTManeuverEventT>();
      event->TIME_MS = ms_of(began(e));
      event->STATUS = e.status;
      event->DELTA_V_KM_S = std::isfinite(e.primary->delta_v) ? e.primary->delta_v : NAN;
      for (const Mnv* m : e.members) {
        auto member = std::make_unique<XMTManeuverMemberT>();
        member->SOURCE_ID = m->source; member->STATUS = m->status; member->ID = m->id; member->TIME_MS = ms_of(m->time);
        event->MEMBERS.push_back(std::move(member));
      }
      event->RECORD = record_ref(xmtRecordKind::Mnv, record.data(), record.size());
      row->MANEUVERS.push_back(std::move(event));
      if (e.members.size() > 1) ++counts_merged;
    }

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
    row->REGIME = regime;

    std::set<std::string> kinds;
    for (const Omm* omm : mine.omms) kinds.insert(omm->product);
    bool any_selected = false;
    for (const std::string& kind : kinds) {
      std::vector<const Omm*> of_kind;
      for (const Omm* omm : mine.omms) if (omm->product == kind) of_kind.push_back(omm);
      const std::vector<Candidate> candidates = candidates_of(of_kind, regime, as_of, retiring, selection);
      const Choice choice = choose(candidates, selection);
      auto kind_row = std::make_unique<XMTProductChoiceT>();
      kind_row->PRODUCT = kind;
      for (const Candidate& c : candidates) {
        auto r = std::make_unique<XMTProductCandidateT>();
        r->SOURCE_ID = c.omm->source;
        r->EPOCH_MS = ms_of(c.omm->epoch);
        r->AGE_DAYS = c.age_days;
        r->STANDING = &c == choice.winner ? xmtCandidateStanding::Selected : c.status;
        r->MEASURED = c.measured;
        if (std::isfinite(c.median)) { r->MEDIAN_3D_KM = c.median; r->SAMPLES = static_cast<uint32_t>(c.samples); }
        if (c.status == xmtCandidateStanding::Retired && retiring) r->RETIRED_BY_MS = ms_of(began(*retiring));
        r->RECORD = record_ref(xmtRecordKind::Omm, c.omm->bytes, c.omm->length, false);
        kind_row->CANDIDATES.push_back(std::move(r));
      }
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
        if (choice.reason == xmtSelectionReason::UnmeasuredFallbackOrder) ++counts_unmeasured;
        auto selected = std::make_unique<XMTProductSelectionT>();
        selected->SOURCE_ID = win.source;
        selected->EPOCH_MS = ms_of(win.epoch);
        selected->REASON = choice.reason;
        selected->TIE = choice.tie;
        selected->OMM_REF = record_ref(xmtRecordKind::Omm, win.bytes, win.length);
        if (paired) selected->OCM_REF = record_ref(xmtRecordKind::Ocm, paired->bytes, paired->length);
        covariance_of(win, paired, selected.get());
        if (choice.winner->measured) {
          selected->MEASURED = std::make_unique<XMTMeasuredErrorT>();
          selected->MEASURED->SOURCE_ID = win.source;
          selected->MEASURED->PRODUCT = kind;
          selected->MEASURED->REGIME = regime;
          selected->MEASURED->HORIZON_DAYS = selection.horizon;
          selected->MEASURED->MEDIAN_3D_KM = choice.winner->median;
          selected->MEASURED->SAMPLES = static_cast<uint32_t>(choice.winner->samples);
        }
        kind_row->SELECTED = std::move(selected);
      }
      row->PRODUCTS.push_back(std::move(kind_row));
    }
    row->OUTCOME = any_selected ? xmtObjectOutcome::Selected : mine.omms.empty() ? xmtObjectOutcome::NoProduct : xmtObjectOutcome::Stale;
    if (!any_selected) {
      if (mine.omms.empty()) ++counts_no_product;
      else ++counts_stale;
    }
    report.OBJECTS.push_back(std::move(row));
  }

  for (size_t i = 0; i < refused.size() && i < 1000; ++i) {
    auto row = std::make_unique<XMTUnplacedRecordT>();
    row->KIND = refused[i].record; row->ORDINAL = static_cast<uint32_t>(refused[i].ordinal); row->REASON = refused[i].reason;
    report.REFUSED.push_back(std::move(row));
  }
  report.AS_OF_MS = ms_of(as_of);
  report.SELECTION = selection_policy_table(selection);
  report.MANEUVERS = maneuver_policy_table(maneuvers);
  report.CATALOG_RECORDS = static_cast<uint32_t>(catalog.size());
  report.OMM_RECORDS = static_cast<uint32_t>(omms.size());
  report.OCM_RECORDS = static_cast<uint32_t>(ocms.size());
  report.MNV_RECORDS = static_cast<uint32_t>(mnvs.size());
  report.SELECTED_COUNT = static_cast<uint32_t>(counts_selected);
  report.STALE_COUNT = static_cast<uint32_t>(counts_stale);
  report.NO_PRODUCT_COUNT = static_cast<uint32_t>(counts_no_product);
  report.UNMEASURED_COUNT = static_cast<uint32_t>(counts_unmeasured);
  report.WITHOUT_OCM_COUNT = static_cast<uint32_t>(counts_without_ocm);
  report.MANEUVERABLE_COUNT = static_cast<uint32_t>(counts_maneuverable);
  report.MANEUVER_EVENT_COUNT = static_cast<uint32_t>(counts_events);
  report.MERGED_EVENT_COUNT = static_cast<uint32_t>(counts_merged);
  for (const auto& [reason, count] : unlinked_counts) {
    auto c = std::make_unique<XMTReasonCountT>();
    c->REASON = reason; c->COUNT = static_cast<uint32_t>(count);
    report.UNLINKED_COUNTS.push_back(std::move(c));
  }
  report.REFUSED_COUNT = static_cast<uint32_t>(refused.size());
  report.IDENTITY = std::move(identity_report);
  auto push = [](const char* port, const char* schema, const char* identifier, const char* root, const std::vector<uint8_t>& data) {
    return data.empty() || plugin_push_output_ex(port, schema, identifier, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0, data.data(), static_cast<uint32_t>(data.size())) >= 0;
  };
  if (push_report(result)) return 1;
  if (!push("catalog", "CAT.fbs", "$CAT", "CAT", catalog_out) || !push("omm", "OMM.fbs", "$OMM", "OMM", omm_out) || !push("ocm", "OCM.fbs", "$OCM", "OCM", ocm_out) ||
      !push("mnv", "MNV.fbs", "$MNV", "MNV", mnv_out)) return 1;
  return 0;
}
