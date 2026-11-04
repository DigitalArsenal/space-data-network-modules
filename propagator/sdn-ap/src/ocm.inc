// -----------------------------------------------------------------------------
// The $OCM element-set record (SDS 1.276.0 OCM 2.1.9): one mean element set
// with its theory, its force model, its identity and, from `fit`, its orbit
// determination and covariance, every field typed. MEAN_ELEMENTS carries the
// set (MEAN_ELEMENT_THEORY SGP4, SGP4XP or AP, written; Brouwer MEAN_MOTION,
// BTERM and AGOM for SGP4XP and AP); PERTURBATIONS the forces (ATMOSPHERIC_MODEL
// {JXX,1970} or {NRLMSIS00E,2000}, WEATHER_SOURCE, DENSITY_CORRECTION, the
// gravity caps, the daily SPACE_WEATHER rows and the density-correction nodes
// the set flies on); METADATA.NORAD_CAT_ID the join key; TRAJ_REF_FRAME
// TEMEOFDATE, or TEMEOFEPOCH at the set's epoch for AP with gravity terms;
// ORB_AVERAGING BROUWER (KOZAI for SGP4); STATE_DATA empty. Nothing goes in
// USER_DEFINED_PARAMETERS.
// -----------------------------------------------------------------------------

namespace sdnap {
namespace ocm {

constexpr const char* kModuleId = "com.spacedatanetwork.sdn-ap-propagator";
constexpr const char* kModuleVersion = "0.5.0";
constexpr const char* kWeatherInterpolation =
    "DAILY: F10.7 OF THE PREVIOUS DAY, 81-DAY CENTERED MEAN AND DAILY AP OF THE DAY, NO INTERPOLATION";

/// The object a set describes, and who issued it.
struct Identity {
  uint32_t norad = 0;
  std::string object_id, object_name, originator;
};

/// MET meanElementSource of a set: SGP4 0, SGP4XP 1 (stock forces), AP 5.
inline int theory_of(int32_t row_theory, const Forces& f) {
  return row_theory == kTheorySgp4 ? meanElementSource_SGP4 : f.stock() ? meanElementSource_SGP4XP : meanElementSource_AP;
}

/// AP with gravity terms is computed in the axes of its epoch (SPEC 16.4): TEMEOFEPOCH.
inline bool epoch_frame(const Forces& f) { return f.tesseral > 0 || f.zonal > 0; }

/// What the drag of a set reads beyond its forces: the daily rows (RECORDS) and the density-correction nodes.
struct Weather {
  std::vector<atm::SpwDay> rows;
  std::string source_id;
  std::vector<int64_t> node_ms;
  std::vector<double> node_s;
  std::string dcl_cid;
};

/// The parts of a record `fit` adds, built before the root (FlatBuffers builds children first).
struct Extras {
  flatbuffers::Offset<OrbitDetermination> od = 0;
  flatbuffers::Offset<PVN> provenance = 0;
  flatbuffers::Offset<flatbuffers::Vector<double>> covariance = 0;
  flatbuffers::Offset<RFM> cov_frame = 0;
  uint8_t cov_size = 6;
  flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<flatbuffers::String>>> cov_parameters = 0, cov_units = 0;
  flatbuffers::Offset<flatbuffers::Vector<uint8_t>> cov_kinds = 0;
  flatbuffers::Offset<OCMCovariancePropagation> cov_propagation = 0;
  flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<CVR>>> cov_realism = 0;
};

/// The RFM of a set's frame: TEMEOFDATE (the celestial enumeration) or TEMEOFEPOCH (the custom one), with the NAME.
inline flatbuffers::Offset<RFM> frame_of(flatbuffers::FlatBufferBuilder& fbb, bool of_epoch) {
  if (of_epoch) return CreateRFMDirect(fbb, RFMUnion_CustomFrameWrapper, CreateCustomFrameWrapper(fbb, CustomFrame_TEMEOFEPOCH).Union(), 0, "TEMEOFEPOCH");
  return CreateRFMDirect(fbb, RFMUnion_CelestialFrameWrapper, CreateCelestialFrameWrapper(fbb, CelestialFrame_TEMEOFDATE).Union(), 0, "TEMEOFDATE");
}

/// The PROVENANCE a module-made record carries: this module as provider and producer.
inline flatbuffers::Offset<PVN> producer_pvn(flatbuffers::FlatBufferBuilder& fbb) {
  char producer[96];
  std::snprintf(producer, sizeof producer, "%s %s", kModuleId, kModuleVersion);
  const auto s_provider = fbb.CreateString(kModuleId);
  const auto s_producer = fbb.CreateString(producer);
  PVNBuilder b(fbb);
  b.add_PROVIDER_ID(s_provider);
  b.add_PRODUCER(s_producer);
  return b.Finish();
}

/// The $SPW rows of a record: DATE, F107_OBS, F107_OBS_CENTER81, AP_AVG and F107_DATA_TYPE (OBS written too).
inline flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<SPW>>> rows_of(flatbuffers::FlatBufferBuilder& fbb, const std::vector<atm::SpwDay>& rows) {
  std::vector<flatbuffers::Offset<SPW>> out;
  out.reserve(rows.size());
  for (const atm::SpwDay& d : rows) {
    const auto date = fbb.CreateString(d.date);
    fbb.ForceDefaults(true);
    SPWBuilder b(fbb);
    b.add_DATE(date);
    b.add_F107_OBS(static_cast<float>(d.f107_obs));
    b.add_F107_OBS_CENTER81(static_cast<float>(d.f107_center81));
    b.add_AP_AVG(static_cast<int32_t>(d.ap_avg));
    b.add_F107_DATA_TYPE(static_cast<F107DataType>(d.data_type));
    out.push_back(b.Finish());
    fbb.ForceDefaults(false);
  }
  return fbb.CreateVector(out);
}

/// PERTURBATIONS of a set under `f` (`w` the rows and nodes it reads; nullptr none). SGP4: WGS-72, WEATHER_SOURCE NONE,
/// no atmosphere. SGP4XP and AP: EGM-96, the atmosphere as a direct map of the forces, the caps, the source; the rows
/// with SW_DATA_SOURCE, SW_DATA_EPOCH and SW_INTERP_METHOD under RECORDS; the nodes and the $DCL CID under DCA_COMMON_MODE.
inline flatbuffers::Offset<Perturbations> perturbations_of(flatbuffers::FlatBufferBuilder& fbb, int32_t row_theory, const Forces& f, const Weather* w) {
  const bool sgp4 = row_theory == kTheorySgp4;
  const auto s_gravity = fbb.CreateString(sgp4 ? "WGS-72" : "EGM-96");
  flatbuffers::Offset<ATM> atmosphere = 0;
  if (!sgp4) atmosphere = CreateATM(fbb, f.msis ? AtmosphericModelFamily_NRLMSIS00E : AtmosphericModelFamily_JXX, f.msis ? 2000 : 1970);
  const bool records = !sgp4 && f.weather_source == pcfWeatherSource_RECORDS && w != nullptr;
  flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<SPW>>> rows = 0;
  flatbuffers::Offset<flatbuffers::String> sw_source = 0, sw_epoch = 0, sw_interp = 0, dcl_cid = 0;
  flatbuffers::Offset<flatbuffers::Vector<int64_t>> node_ms = 0;
  flatbuffers::Offset<flatbuffers::Vector<double>> node_s = 0;
  if (records) {
    rows = rows_of(fbb, w->rows);
    if (!w->source_id.empty()) sw_source = fbb.CreateString(w->source_id);
    const char* observed = nullptr;
    for (const atm::SpwDay& d : w->rows)
      if (d.data_type == F107DataType_OBS) observed = d.date;
    if (observed != nullptr) sw_epoch = fbb.CreateString(observed);
    sw_interp = fbb.CreateString(kWeatherInterpolation);
  }
  if (!sgp4 && f.dca && w != nullptr) {
    node_ms = fbb.CreateVector(w->node_ms);
    node_s = fbb.CreateVector(w->node_s);
    dcl_cid = fbb.CreateString(w->dcl_cid);
  }
  PerturbationsBuilder b(fbb);
  if (!atmosphere.IsNull()) b.add_ATMOSPHERIC_MODEL(atmosphere);
  b.add_GRAVITY_MODEL(s_gravity);
  if (!sw_source.IsNull()) b.add_SW_DATA_SOURCE(sw_source);
  if (!sw_epoch.IsNull()) b.add_SW_DATA_EPOCH(sw_epoch);
  if (!sw_interp.IsNull()) b.add_SW_INTERP_METHOD(sw_interp);
  if (!sgp4) {
    b.add_MAXIMUM_TESSERAL_DEGREE(static_cast<uint16_t>(f.tesseral));
    b.add_MAXIMUM_ZONAL_DEGREE(static_cast<uint16_t>(f.zonal));
  }
  b.add_WEATHER_SOURCE(static_cast<pcfWeatherSource>(sgp4 ? pcfWeatherSource_NONE : f.weather_source));
  if (!sgp4 && f.dca) b.add_DENSITY_CORRECTION(pcfDensityCorrection_DCA_COMMON_MODE);
  if (!dcl_cid.IsNull()) b.add_DENSITY_CORRECTION_CID(dcl_cid);
  if (!rows.IsNull()) b.add_SPACE_WEATHER(rows);
  if (!node_ms.IsNull()) b.add_DENSITY_CORRECTION_NODE_TIMES_MS(node_ms);
  if (!node_s.IsNull()) b.add_DENSITY_CORRECTION_LOG_DENSITY_SCALE_DIMENSIONLESS(node_s);
  return b.Finish();
}

/// One $OCM of the set `row` under forces `f`, finished in `fbb` (plain, file identifier $OCM).
inline void build(flatbuffers::FlatBufferBuilder& fbb, const ElementRow& row, const Forces& f, const Weather* w, const Identity& id, Extras x = {}) {
  char epoch[48];
  oem::iso_text(row.epoch_jd_whole, row.epoch_jd_frac, 0.0, epoch, sizeof epoch);
  const bool sgp4 = row.theory == kTheorySgp4;
  const bool of_epoch = !sgp4 && epoch_frame(f);
  const auto s_epoch = fbb.CreateString(epoch);
  OCMMeanElementsBuilder me(fbb);
  me.add_MEAN_ELEMENT_THEORY(static_cast<meanElementSource>(theory_of(row.theory, f)));
  me.add_EPOCH(s_epoch);
  me.add_MEAN_MOTION(row.mean_motion_rev_day);
  me.add_ECCENTRICITY(row.eccentricity);
  me.add_INCLINATION(row.inclination_deg);
  me.add_RA_OF_ASC_NODE(row.raan_deg);
  me.add_ARG_OF_PERICENTER(row.arg_pericenter_deg);
  me.add_MEAN_ANOMALY(row.mean_anomaly_deg);
  if (sgp4) {
    me.add_BSTAR(row.bstar);
    me.add_MEAN_MOTION_DOT(row.mean_motion_dot);
    me.add_MEAN_MOTION_DDOT(row.mean_motion_ddot);
  } else {
    me.add_BTERM(row.bterm);
    me.add_AGOM(row.agom);
  }
  const auto mean = me.Finish();
  const auto perturbations = perturbations_of(fbb, row.theory, f, w);
  // HEADER and METADATA
  const auto s_version = fbb.CreateString("3.0");
  const auto s_originator = fbb.CreateString(id.originator.empty() ? "SDN" : id.originator);
  HeaderBuilder hb(fbb);
  hb.add_CCSDS_OCM_VERS(s_version);
  hb.add_ORIGINATOR(s_originator);
  const auto header = hb.Finish();
  const auto s_name = id.object_name.empty() ? flatbuffers::Offset<flatbuffers::String>(0) : fbb.CreateString(id.object_name);
  const auto s_intl = id.object_id.empty() ? flatbuffers::Offset<flatbuffers::String>(0) : fbb.CreateString(id.object_id);
  flatbuffers::Offset<flatbuffers::String> s_catalog = 0, s_designator = 0;
  if (id.norad != 0) {
    char designator[16];
    std::snprintf(designator, sizeof designator, "%u", id.norad);
    s_catalog = fbb.CreateString("NORAD");
    s_designator = fbb.CreateString(designator);
  }
  const auto s_time = fbb.CreateString("UTC");
  MetadataBuilder mb(fbb);
  if (!s_name.IsNull()) mb.add_OBJECT_NAME(s_name);
  if (!s_intl.IsNull()) mb.add_INTERNATIONAL_DESIGNATOR(s_intl);
  if (!s_catalog.IsNull()) {
    mb.add_CATALOG_NAME(s_catalog);
    mb.add_OBJECT_DESIGNATOR(s_designator);
  }
  mb.add_TIME_SYSTEM(s_time);
  if (id.norad != 0) mb.add_NORAD_CAT_ID(id.norad);
  const auto metadata = mb.Finish();
  const auto s_center = fbb.CreateString("EARTH");
  const auto frame = frame_of(fbb, of_epoch);
  const auto s_frame_epoch = of_epoch ? fbb.CreateString(epoch) : flatbuffers::Offset<flatbuffers::String>(0);
  const auto s_averaging = fbb.CreateString(sgp4 ? "KOZAI" : "BROUWER");
  const auto provenance = x.provenance.IsNull() ? producer_pvn(fbb) : x.provenance;
  const auto s_cov_type = x.covariance.IsNull() ? flatbuffers::Offset<flatbuffers::String>(0) : fbb.CreateString("CARTPV");
  OCMBuilder b(fbb);
  b.add_HEADER(header);
  b.add_METADATA(metadata);
  b.add_PERTURBATIONS(perturbations);
  if (!x.od.IsNull()) b.add_ORBIT_DETERMINATION(x.od);
  b.add_CENTER_NAME(s_center);
  b.add_TRAJ_REF_FRAME(frame);
  if (!s_frame_epoch.IsNull()) b.add_TRAJ_FRAME_EPOCH(s_frame_epoch);
  b.add_ORB_AVERAGING(s_averaging);
  if (!x.covariance.IsNull()) {
    b.add_COVARIANCE_DATA(x.covariance);
    b.add_COV_REF_FRAME(x.cov_frame);
    b.add_COV_TYPE(s_cov_type);
    b.add_COV_ORDERING(covarianceOrdering_LTM);
    b.add_COV_SIZE(x.cov_size);
    if (!x.cov_parameters.IsNull()) b.add_COV_PARAMETERS(x.cov_parameters);
    if (!x.cov_units.IsNull()) b.add_COV_UNITS(x.cov_units);
    if (!x.cov_kinds.IsNull()) b.add_COV_PARAMETER_KINDS(x.cov_kinds);
    if (!x.cov_propagation.IsNull()) b.add_COV_PROPAGATION(x.cov_propagation);
    if (!x.cov_realism.IsNull()) b.add_COV_REALISM(x.cov_realism);
  }
  b.add_PROVENANCE(provenance);
  b.add_MEAN_ELEMENTS(mean);
  FinishOCMBuffer(fbb, b.Finish());
}

}  // namespace ocm
}  // namespace sdnap
