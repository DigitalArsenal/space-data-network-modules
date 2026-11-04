// -----------------------------------------------------------------------------
// The invoke surface: `export_omm`, the one $OMM this module writes. Each
// 'ocm' frame's element set, SGP4 or stock SGP4XP ({JXX,1970} on the theory's
// flux model, no density correction, both gravity caps 0), to one $OMM on
// 'omm': MEAN_ELEMENT_THEORY, EPOCH as the record states it, the six elements;
// SGP4: BSTAR, MEAN_MOTION_DOT, MEAN_MOTION_DDOT; SGP4XP: BTERM in BSTAR and
// AGOM in MEAN_MOTION_DDOT (OMM 1.276.0 has no BTERM or AGOM field: the SGP4-XP
// convention of the OMM's own comment), USER_DEFINED_EARTH_MODEL the theory's
// (WGS-72, EGM-96), the covariance's state block as COVARIANCE (TEME), the
// identity, ORIGINATOR and PROVENANCE carried. No COMMENT and no
// USER_DEFINED_PARAMETERS. An AP set is not an $OMM: theory-not-exportable:AP.
// -----------------------------------------------------------------------------

namespace sdnap {
namespace exportomm {

/// forces-not-exportable unless the record's PERTURBATIONS are its theory's own (SGP4: NONE and no atmosphere;
/// SGP4XP: {JXX,1970}, THEORY_FLUX_MODEL, NONE, caps 0).
inline bool stock_forces(const OCM* o, int theory) {
  const Perturbations* pt = o->PERTURBATIONS();
  if (pt == nullptr) return false;
  if (pt->DENSITY_CORRECTION() != pcfDensityCorrection_NONE || pt->MAXIMUM_TESSERAL_DEGREE() != 0 || pt->MAXIMUM_ZONAL_DEGREE() != 0 ||
      (pt->SPACE_WEATHER() != nullptr && pt->SPACE_WEATHER()->size() > 0))
    return false;
  if (theory == meanElementSource_SGP4) return pt->WEATHER_SOURCE() == pcfWeatherSource_NONE && pt->ATMOSPHERIC_MODEL() == nullptr;
  const ATM* am = pt->ATMOSPHERIC_MODEL();
  return pt->WEATHER_SOURCE() == pcfWeatherSource_THEORY_FLUX_MODEL && am != nullptr && am->MODEL() == AtmosphericModelFamily_JXX && am->YEAR() == 1970;
}

}  // namespace exportomm
}  // namespace sdnap

extern "C" int export_omm(void) {
  using namespace sdnap;
  plugin_reset_output_state();
  uint32_t count = 0;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (f == nullptr || f->port_id == nullptr || std::strcmp(f->port_id, "ocm") != 0) continue;
    ++count;
    const OCM* o = ocm::view(f->payload, f->payload_length);
    if (o == nullptr) return ocm::refuse("invalid-ocm", "An 'ocm' payload is not a verifiable SDS $OCM.");
    const int theory = o->MEAN_ELEMENTS() != nullptr ? o->MEAN_ELEMENTS()->MEAN_ELEMENT_THEORY() : meanElementSource_UNSPECIFIED;
    if (theory == meanElementSource_AP)
      return ocm::refuse("theory-not-exportable:AP", "An AP set flies on AP only: it is not an $OMM (SGP4 and SGP4XP sets are).");
    if ((theory == meanElementSource_SGP4 || theory == meanElementSource_SGP4XP) && !exportomm::stock_forces(o, theory))
      return ocm::refuse("forces-not-exportable", "An $OMM states the theory's own forces only: the record's PERTURBATIONS are not its theory's.");
    ocm::Set set;
    if (const int rc = ocm::decode(f->payload, f->payload_length, set)) return rc;
    const ElementRow& row = set.row;
    const bool sgp4 = row.theory == kTheorySgp4;
    // the order of the fields is the 0.4 fit's, so the bytes of an exported set are the 0.4 set's less what is gone
    flatbuffers::FlatBufferBuilder fbb(1024);
    const auto s_epoch = fbb.CreateString(o->MEAN_ELEMENTS()->EPOCH());
    const auto s_center = fbb.CreateString("EARTH");
    const auto s_model = fbb.CreateString(sgp4 ? "WGS-72" : "EGM-96");
    const auto s_orig = fbb.CreateString(set.id.originator.empty() ? "SDN" : set.id.originator);
    const auto s_frame = CreateRFMDirect(fbb, RFMUnion_NONE, 0, 0, "TEME");
    const auto s_object_id = set.id.object_id.empty() ? flatbuffers::Offset<flatbuffers::String>(0) : fbb.CreateString(set.id.object_id);
    const auto s_object_name = set.id.object_name.empty() ? flatbuffers::Offset<flatbuffers::String>(0) : fbb.CreateString(set.id.object_name);
    flatbuffers::Offset<flatbuffers::Vector<double>> s_cov = 0;
    flatbuffers::Offset<RFM> s_cov_frame = 0;
    if (!sgp4) {
      cov::Set cs;
      const int cr = cov::read(o, row, cs);
      if (cr < 0) return ocm::refuse(cr == -2 ? "cov-parameter-kind-unspecified" : cr == -3 ? "cov-propagation-invariant" : "invalid-covariance",
                                     "The set's COVARIANCE_DATA, COV_PARAMETER_KINDS or COV_PROPAGATION are malformed.");
      if (cr == 1) {
        double c21[21];
        int k21 = 0;
        for (int i = 0; i < 6; ++i)
          for (int j = 0; j <= i; ++j) c21[k21++] = cs.C[i * cs.np + j];
        s_cov = fbb.CreateVector(c21, 21);
        s_cov_frame = CreateRFMDirect(fbb, RFMUnion_NONE, 0, 0, "TEME");
      }
    }
    const auto s_pvn = ocm::copy_pvn(fbb, o->PROVENANCE());
    OMMBuilder b(fbb);
    b.add_ORIGINATOR(s_orig);
    b.add_CENTER_NAME(s_center);
    b.add_REFERENCE_FRAME(s_frame);
    b.add_TIME_SYSTEM(timingStandard_UTC);
    b.add_MEAN_ELEMENT_THEORY(sgp4 ? meanElementSource_SGP4 : meanElementSource_SGP4XP);
    if (set.id.norad != 0) b.add_NORAD_CAT_ID(set.id.norad);
    if (!s_object_id.IsNull()) b.add_OBJECT_ID(s_object_id);
    if (!s_object_name.IsNull()) b.add_OBJECT_NAME(s_object_name);
    b.add_EPOCH(s_epoch);
    b.add_MEAN_MOTION(row.mean_motion_rev_day);
    b.add_ECCENTRICITY(row.eccentricity);
    b.add_INCLINATION(row.inclination_deg);
    b.add_RA_OF_ASC_NODE(row.raan_deg);
    b.add_ARG_OF_PERICENTER(row.arg_pericenter_deg);
    b.add_MEAN_ANOMALY(row.mean_anomaly_deg);
    if (sgp4) {
      b.add_BSTAR(row.bstar);
      b.add_MEAN_MOTION_DOT(row.mean_motion_dot);
      b.add_MEAN_MOTION_DDOT(row.mean_motion_ddot);
    } else {
      b.add_BSTAR(row.bterm);
      b.add_MEAN_MOTION_DDOT(row.agom);
    }
    b.add_USER_DEFINED_EARTH_MODEL(s_model);
    if (!s_cov.IsNull()) {
      b.add_COV_REFERENCE_FRAME(s_cov_frame);
      b.add_COVARIANCE(s_cov);
    }
    if (!s_pvn.IsNull()) b.add_PROVENANCE(s_pvn);
    FinishOMMBuffer(fbb, b.Finish());
    if (plugin_push_output("omm", "OMM.fbs", "$OMM", fbb.GetBufferPointer(), fbb.GetSize()) < 0) {
      plugin_set_error("output-failed", "The $OMM could not be emitted.");
      return 3;
    }
  }
  if (count == 0) return ocm::refuse("missing-ocm", "An 'ocm' input frame is required.");
  return 0;
}
