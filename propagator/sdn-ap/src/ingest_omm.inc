// -----------------------------------------------------------------------------
// The invoke surface: `ingest_omm`, the one $OMM boundary. Each 'omm' record
// (SGP4, or SGP4XP with BTERM and AGOM, m^2/kg) becomes one $OCM on 'ocm' with its theory's
// own forces written explicitly (SGP4: GRAVITY_MODEL WGS-72, WEATHER_SOURCE
// NONE, no atmosphere; SGP4XP: {JXX,1970}, THEORY_FLUX_MODEL, no correction,
// both caps 0, EGM-96), NORAD_CAT_ID and the $OMM's PROVENANCE; the sets
// also replace the batch store (the sdnap_* entries). An $OMM with
// USER_DEFINED_PARAMETERS is refused by their count, never read by name; an
// AP set is never an $OMM. SPEC 17.6: an SGP4XP set's BTERM and AGOM come from
// the $OMM's own BTERM and AGOM fields when either is present; without them,
// from BSTAR and MEAN_MOTION_DDOT, where the SGP4-XP element-set definition
// carries them. The $OCM's HEADER.COMMENT states the source in one line:
// "BTERM_SOURCE=BTERM AGOM_SOURCE=AGOM" or "BTERM_SOURCE=BSTAR AGOM_SOURCE=MEAN_MOTION_DDOT".
// -----------------------------------------------------------------------------

static int ingest_omm_call(void);
extern "C" int ingest_omm(void) {
  sdnap::mem::CallMark call_mark;
  return sdnap::mem::finish(ingest_omm_call());
}
static int ingest_omm_call(void) {
  using namespace sdnap;
  plugin_reset_output_state();
  std::vector<ElementRow> rows;
  std::vector<std::pair<const uint8_t*, uint32_t>> records;
  std::vector<int> sources;  ///< SGP4XP: 1 BTERM and AGOM fields, 2 BSTAR and MEAN_MOTION_DDOT; SGP4: 0
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (f == nullptr || f->port_id == nullptr || std::strcmp(f->port_id, "omm") != 0) continue;
    const uint8_t* p = f->payload;
    uint32_t n = f->payload_length;
    flatbuffers::Verifier::Options vopt;
    vopt.check_alignment = false;
    if (!plain_view(p, n, "$OMM")) return ocm::refuse("invalid-omm", "An 'omm' payload is not an SDS $OMM.");
    flatbuffers::Verifier v(p, n, vopt);
    if (!VerifyOMMBuffer(v)) return ocm::refuse("invalid-omm", "An 'omm' payload does not verify.");
    const OMM* o = GetOMM(p);
    if (o->USER_DEFINED_PARAMETERS() != nullptr && o->USER_DEFINED_PARAMETERS()->size() > 0) {
      char code[48];
      std::snprintf(code, sizeof code, "user-defined-parameters:%u", o->USER_DEFINED_PARAMETERS()->size());
      return ocm::refuse(code, "An $OMM with USER_DEFINED_PARAMETERS: every field this module reads is typed.");
    }
    if (o->CENTER_NAME() != nullptr && o->CENTER_NAME()->size() > 0 && !oem::same_text(o->CENTER_NAME()->c_str(), "EARTH"))
      return ocm::refuse("unsupported-center", "An 'omm' record is not centered on the Earth (CENTER_NAME); the theories here are geocentric.");
    const int theory = o->MEAN_ELEMENT_THEORY();
    if (theory == meanElementSource_AP) return ocm::refuse("theory-not-ingestable:AP", "An AP set is an $OCM, never an $OMM.");
    if (theory != meanElementSource_SGP4 && theory != meanElementSource_SGP4XP)
      return ocm::refuse("invalid-omm", "An 'omm' record's MEAN_ELEMENT_THEORY is SGP4 or SGP4XP.");
    ElementRow row{};
    if (o->EPOCH() == nullptr || !omm::epoch(o->EPOCH()->c_str(), o->EPOCH()->size(), row.epoch_jd_whole, row.epoch_jd_frac))
      return ocm::refuse("invalid-omm", "An 'omm' record's EPOCH is not an ISO 8601 UTC time.");
    row.theory = theory == meanElementSource_SGP4XP ? kTheorySgp4Xp : kTheorySgp4;
    row.mean_motion_rev_day = o->MEAN_MOTION();
    row.eccentricity = o->ECCENTRICITY();
    row.inclination_deg = o->INCLINATION();
    row.raan_deg = o->RA_OF_ASC_NODE();
    row.arg_pericenter_deg = o->ARG_OF_PERICENTER();
    row.mean_anomaly_deg = o->MEAN_ANOMALY();
    row.norad_cat_id = o->NORAD_CAT_ID();
    int source = 0;
    if (row.theory == kTheorySgp4Xp) {
      const auto* table = reinterpret_cast<const flatbuffers::Table*>(o);
      const bool slots = !table->CheckField(OMM::VT_BTERM) && !table->CheckField(OMM::VT_AGOM);
      source = slots ? 2 : 1;
      row.bterm = slots ? o->BSTAR() : o->BTERM();            // m^2/kg
      row.agom = slots ? o->MEAN_MOTION_DDOT() : o->AGOM();  // m^2/kg
    } else {
      row.bstar = o->BSTAR();
      row.mean_motion_dot = o->MEAN_MOTION_DOT();
      row.mean_motion_ddot = o->MEAN_MOTION_DDOT();
    }
    if (!(row.mean_motion_rev_day > 0.0)) return ocm::refuse("invalid-omm", "An 'omm' record's MEAN_MOTION is not positive.");
    rows.push_back(row);
    records.emplace_back(p, n);
    sources.push_back(source);
  }
  if (rows.empty()) return ocm::refuse("missing-omm", "An 'omm' input frame is required.");
  for (size_t k = 0; k < rows.size(); ++k) {
    const OMM* o = GetOMM(records[k].first);
    ocm::Identity id;
    id.norad = o->NORAD_CAT_ID();
    if (o->OBJECT_ID() != nullptr) id.object_id = o->OBJECT_ID()->str();
    if (o->OBJECT_NAME() != nullptr) id.object_name = o->OBJECT_NAME()->str();
    if (o->ORIGINATOR() != nullptr) id.originator = o->ORIGINATOR()->str();
    flatbuffers::FlatBufferBuilder fbb(1024);
    ocm::Extras x;
    x.provenance = ocm::copy_pvn(fbb, o->PROVENANCE());
    x.carried = true;
    if (sources[k] != 0)
      x.header_comment = fbb.CreateVectorOfStrings(std::vector<std::string>{
          sources[k] == 2 ? "BTERM_SOURCE=BSTAR AGOM_SOURCE=MEAN_MOTION_DDOT" : "BTERM_SOURCE=BTERM AGOM_SOURCE=AGOM"});
    ocm::build(fbb, rows[k], Forces{}, nullptr, id, x);
    if (plugin_push_output("ocm", "OCM.fbs", "$OCM", fbb.GetBufferPointer(), fbb.GetSize()) < 0) {
      plugin_set_error("output-failed", "The $OCM could not be emitted.");
      return 3;
    }
  }
  if (store_init(rows.data(), static_cast<uint32_t>(rows.size())) < 0) {
    plugin_set_error("out-of-memory", "No memory for the element set.");
    return 3;
  }
  return 0;
}
