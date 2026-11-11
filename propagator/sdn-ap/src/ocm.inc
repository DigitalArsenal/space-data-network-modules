// -----------------------------------------------------------------------------
// The $OCM element-set record (SDS 1.279.0 OCM 2.1.10): one mean element set
// with its theory, its force model, its identity and, from `fit`, its orbit
// determination and covariance, every field typed. MEAN_ELEMENTS carries the
// set (MEAN_ELEMENT_THEORY SGP4, SGP4XP or AP, written; Brouwer MEAN_MOTION,
// BTERM and AGOM for SGP4XP and AP); PERTURBATIONS the forces (ATMOSPHERIC_MODEL
// {JXX,1970} or {NRLMSIS00E,2000}, WEATHER_SOURCE, DENSITY_CORRECTION, the
// gravity caps, the daily SPACE_WEATHER rows and the density-correction nodes
// the set flies on); METADATA.NORAD_CAT_ID the join key; TRAJ_REF_FRAME
// TEMEOFDATE, or TEMEOFEPOCH at the set's epoch for AP with gravity terms;
// ORB_AVERAGING BROUWER (KOZAI for SGP4); STATE_DATA empty; PROVENANCE this
// module's, or the source's carried with this module as PRODUCER; a carried
// forecast, when fit is asked for one, in POLYNOMIAL_POSITION_RECORDS (SPEC 18).
// Nothing goes in USER_DEFINED_PARAMETERS.
// -----------------------------------------------------------------------------

namespace sdnap {
namespace ocm {

constexpr const char* kModuleId = "com.spacedatanetwork.sdn-ap-propagator";
constexpr const char* kModuleVersion = "0.6.12";
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
  bool carried = false;  ///< PROVENANCE is `provenance` as given (another's, or none); else this module's
  flatbuffers::Offset<flatbuffers::Vector<double>> covariance = 0;
  flatbuffers::Offset<RFM> cov_frame = 0;
  uint8_t cov_size = 6;
  flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<flatbuffers::String>>> cov_parameters = 0, cov_units = 0;
  flatbuffers::Offset<flatbuffers::Vector<uint8_t>> cov_kinds = 0;
  flatbuffers::Offset<OCMCovariancePropagation> cov_propagation = 0;
  flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<CVR>>> cov_realism = 0;
  flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<flatbuffers::String>>> header_comment = 0;  ///< HEADER.COMMENT
  flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<PPEPositionRecord>>> forecast = 0;  ///< the carried forecast (SPEC 18)
  flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<OCMTrajectoryBlock>>> trajectory = 0;  ///< its statement (SPEC 18.6)
  std::string span_start, span_stop;  ///< its span: METADATA START_TIME and STOP_TIME
  bool ecom2 = false;  ///< SPEC 16.13: the set carries the radiation term Y0 (PERTURBATIONS.SOLAR_RAD_PRESSURE names it)
};

/// SPEC 16.13: PERTURBATIONS.SOLAR_RAD_PRESSURE of a set fitted with the radiation term Y0 (absent on every other set).
constexpr const char* kY0RadiationModel = "SPHERE (AGOM) AND ECOM2 Y0 (ARNOLD ET AL. 2015), SPHERE'S CYLINDRICAL SHADOW";

/// SPEC 17.3: the refusal of a covariance about to be written, or nullptr. Its rows are the state block and the solved
/// parameters in the fixed order (cov::kParameters), each named, each a prwDynamicParameter of the five, COV_UNITS
/// COV_SIZE entries (km, km/s, then the parameters' units) and COV_SIZE 6 plus the solved count; anything else is
/// refused by name, never emitted: cov-parameter-unnamed, cov-parameter-unknown, cov-parameter-order, cov-units,
/// cov-size.
inline const char* covariance_refusal(int size, const std::vector<std::string>& names, const std::vector<uint8_t>& kinds,
                                      const std::vector<std::string>& units) {
  if (size != 6 + static_cast<int>(names.size()) || kinds.size() != names.size()) return "cov-size";
  if (units.size() != static_cast<size_t>(size)) return "cov-units";
  static const char* const state_units[6] = {"km", "km", "km", "km/s", "km/s", "km/s"};
  for (int i = 0; i < 6; ++i)
    if (units[static_cast<size_t>(i)] != state_units[i]) return "cov-units";
  int last = 5;
  for (size_t k = 0; k < names.size(); ++k) {
    if (names[k].empty()) return "cov-parameter-unnamed";
    const int kind = cov::kind_named(names[k].c_str());
    if (kind < 0 || cov::kind_of(kinds[k]) != kind) return "cov-parameter-unknown";
    if (kind <= last) return "cov-parameter-order";
    last = kind;
    if (units[6 + k] != cov::consider_units(kind)) return "cov-units";
  }
  return nullptr;
}

/// The RFM of a set's frame: TEMEOFDATE (the celestial enumeration) or TEMEOFEPOCH (the custom one), with the NAME.
inline flatbuffers::Offset<RFM> frame_of(flatbuffers::FlatBufferBuilder& fbb, bool of_epoch) {
  if (of_epoch) return CreateRFMDirect(fbb, RFMUnion_CustomFrameWrapper, CreateCustomFrameWrapper(fbb, CustomFrame_TEMEOFEPOCH).Union(), 0, "TEMEOFEPOCH");
  return CreateRFMDirect(fbb, RFMUnion_CelestialFrameWrapper, CreateCelestialFrameWrapper(fbb, CelestialFrame_TEMEOFDATE).Union(), 0, "TEMEOFDATE");
}

/// This module and its version, as a PVN's PRODUCER names it.
inline std::string producer_name() { return std::string(kModuleId) + " " + kModuleVersion; }

/// The PROVENANCE a module-made record carries: this module as provider and producer.
inline flatbuffers::Offset<PVN> producer_pvn(flatbuffers::FlatBufferBuilder& fbb) {
  const auto s_provider = fbb.CreateString(kModuleId);
  const auto s_producer = fbb.CreateString(producer_name());
  PVNBuilder b(fbb);
  b.add_PROVIDER_ID(s_provider);
  b.add_PRODUCER(s_producer);
  return b.Finish();
}

/// A copy of a PVN into `fbb` (every field; with `as_producer`, PRODUCER this module), or 0 for none.
inline flatbuffers::Offset<PVN> copy_pvn(flatbuffers::FlatBufferBuilder& fbb, const PVN* v, bool as_producer = false) {
  if (v == nullptr) return 0;
  auto str = [&](const flatbuffers::String* t) { return t == nullptr ? flatbuffers::Offset<flatbuffers::String>(0) : fbb.CreateString(t); };
  const auto source_id = str(v->SOURCE_ID()), originator = str(v->ORIGINATOR()), provider = str(v->PROVIDER_ID());
  const auto producer = as_producer ? fbb.CreateString(producer_name()) : str(v->PRODUCER());
  const auto license = str(v->LICENSE_ID()), lineage = str(v->LINEAGE()), url = str(v->SOURCE_URL()), version = str(v->SOURCE_VERSION());
  const auto retrieved = str(v->RETRIEVED_AT()), sha = str(v->SOURCE_SHA256());
  PVNBuilder b(fbb);
  if (!source_id.IsNull()) b.add_SOURCE_ID(source_id);
  b.add_SOURCE_KIND(v->SOURCE_KIND());
  if (!originator.IsNull()) b.add_ORIGINATOR(originator);
  if (!provider.IsNull()) b.add_PROVIDER_ID(provider);
  if (!producer.IsNull()) b.add_PRODUCER(producer);
  b.add_LICENSE_CLASS(v->LICENSE_CLASS());
  if (!license.IsNull()) b.add_LICENSE_ID(license);
  if (!lineage.IsNull()) b.add_LINEAGE(lineage);
  if (!url.IsNull()) b.add_SOURCE_URL(url);
  if (!version.IsNull()) b.add_SOURCE_VERSION(version);
  if (!retrieved.IsNull()) b.add_RETRIEVED_AT(retrieved);
  if (!sha.IsNull()) b.add_SOURCE_SHA256(sha);
  b.add_SOURCE_BYTES(v->SOURCE_BYTES());
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
inline flatbuffers::Offset<Perturbations> perturbations_of(flatbuffers::FlatBufferBuilder& fbb, int32_t row_theory, const Forces& f, const Weather* w,
                                                           bool ecom2 = false) {
  const bool sgp4 = row_theory == kTheorySgp4;
  const auto s_gravity = fbb.CreateString(sgp4 ? "WGS-72" : "EGM-96");
  const auto s_srp = ecom2 ? fbb.CreateString(kY0RadiationModel) : flatbuffers::Offset<flatbuffers::String>(0);
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
  if (!s_srp.IsNull()) b.add_SOLAR_RAD_PRESSURE(s_srp);
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
  const auto perturbations = perturbations_of(fbb, row.theory, f, w, x.ecom2);
  // HEADER and METADATA
  const auto s_version = fbb.CreateString("3.0");
  const auto s_originator = fbb.CreateString(id.originator.empty() ? "SDN" : id.originator);
  HeaderBuilder hb(fbb);
  hb.add_CCSDS_OCM_VERS(s_version);
  hb.add_ORIGINATOR(s_originator);
  if (!x.header_comment.IsNull()) hb.add_COMMENT(x.header_comment);
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
  const auto s_span_start = x.span_start.empty() ? flatbuffers::Offset<flatbuffers::String>(0) : fbb.CreateString(x.span_start);
  const auto s_span_stop = x.span_stop.empty() ? flatbuffers::Offset<flatbuffers::String>(0) : fbb.CreateString(x.span_stop);
  MetadataBuilder mb(fbb);
  if (!s_span_start.IsNull()) mb.add_START_TIME(s_span_start);
  if (!s_span_stop.IsNull()) mb.add_STOP_TIME(s_span_stop);
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
  const auto provenance = x.carried || !x.provenance.IsNull() ? x.provenance : producer_pvn(fbb);
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
  if (!provenance.IsNull()) b.add_PROVENANCE(provenance);
  if (!x.forecast.IsNull()) {  // SPEC 18: the carried forecast, in TRAJ_REF_FRAME
    b.add_TRAJ_TYPE(trajectoryType_POLYNOMIAL_POS);
    b.add_POLYNOMIAL_POSITION_RECORDS(x.forecast);
    b.add_TRAJ_BASIS(ocmTrajectoryBasis_PREDICTED);
  }
  if (!x.trajectory.IsNull()) b.add_TRAJECTORY_BLOCKS(x.trajectory);  // the carried record's statement, or the hand-over's
  b.add_MEAN_ELEMENTS(mean);
  FinishOCMBuffer(fbb, b.Finish());
}

/// A verified plain view of an $OCM given plain or size-prefixed (a record cut from a size-prefixed stream is aligned to
/// its prefix, not to its own start), or nullptr.
inline const OCM* view(const uint8_t* p, uint32_t n) {
  if (!plain_view(p, n, "$OCM")) return nullptr;
  flatbuffers::Verifier::Options vopt;
  vopt.check_alignment = false;
  flatbuffers::Verifier v(p, n, vopt);
  return VerifyOCMBuffer(v) ? GetOCM(p) : nullptr;
}

/// The identity of a record.
inline Identity identity_of(const OCM* o) {
  Identity id;
  if (const Metadata* m = o->METADATA()) {
    id.norad = m->NORAD_CAT_ID();
    if (m->INTERNATIONAL_DESIGNATOR() != nullptr) id.object_id = m->INTERNATIONAL_DESIGNATOR()->str();
    if (m->OBJECT_NAME() != nullptr) id.object_name = m->OBJECT_NAME()->str();
  }
  if (o->HEADER() != nullptr && o->HEADER()->ORIGINATOR() != nullptr) id.originator = o->HEADER()->ORIGINATOR()->str();
  return id;
}

/// The refusal of a record, by name (a flight's frames are refused before anything flies).
inline int refuse(const char* code, const char* why) {
  plugin_set_error(code, why);
  return 3;
}

/// The frame of an RFM: 1 TEMEOFDATE (the celestial enumeration, or NAME TEMEOFDATE / TEME), 2 TEMEOFEPOCH (the custom
/// enumeration or NAME), 0 anything else or a disagreement.
inline int frame_kind(const RFM* f) {
  if (f == nullptr) return 0;
  int by_union = -1, by_name = -1;
  if (f->REFERENCE_FRAME_type() == RFMUnion_CelestialFrameWrapper && f->REFERENCE_FRAME_as_CelestialFrameWrapper() != nullptr)
    by_union = f->REFERENCE_FRAME_as_CelestialFrameWrapper()->frame() == CelestialFrame_TEMEOFDATE ? 1 : 0;
  else if (f->REFERENCE_FRAME_type() == RFMUnion_CustomFrameWrapper && f->REFERENCE_FRAME_as_CustomFrameWrapper() != nullptr)
    by_union = f->REFERENCE_FRAME_as_CustomFrameWrapper()->frame() == CustomFrame_TEMEOFEPOCH ? 2 : f->REFERENCE_FRAME_as_CustomFrameWrapper()->frame() == CustomFrame_TEME ? 1 : 0;
  else if (f->REFERENCE_FRAME_type() != RFMUnion_NONE)
    by_union = 0;
  if (f->NAME() != nullptr && f->NAME()->size() > 0) {
    const char* nm = f->NAME()->c_str();
    by_name = oem::same_text(nm, "TEMEOFDATE") || oem::same_text(nm, "TEME") ? 1 : oem::same_text(nm, "TEMEOFEPOCH") ? 2 : 0;
  }
  if (by_union >= 0 && by_name >= 0 && by_union != by_name) return 0;
  return by_union >= 0 ? by_union : by_name >= 0 ? by_name : 0;
}

/// One element set of an $OCM, decoded for flight: the row, its forces and the weather it flies on.
struct Set {
  ElementRow row{};
  Forces forces{};
  Weather weather;
  Identity id;
  int theory = 0;  ///< meanElementSource as written
  const OCM* record = nullptr;
};

/// The record's daily rows (Perturbations.SPACE_WEATHER), ascending one per day: 0, or 3 refused by name.
inline int rows_of(const Perturbations* pt, std::vector<atm::SpwDay>& rows) {
  rows.clear();
  if (pt->SPACE_WEATHER() == nullptr) return 0;
  for (const SPW* r : *pt->SPACE_WEATHER()) {
    atm::SpwDay d{};
    if (!atm::spw_day(r, d)) return atm::fail_row(r);
    if (!rows.empty() && d.mjd <= rows.back().mjd)
      return atm::fail_day("weather-rows-invalid", d.date, "The record's SPACE_WEATHER rows repeat or go back a day: one row per UTC day, ascending.");
    rows.push_back(d);
  }
  return 0;
}

/// SPEC 16.13: the units ECOM2_Y0's VALUE is in.
constexpr const char* kY0Units = "m/s**2";

/// SPEC 16.13: an AP set's radiation term Y0 from ORBIT_DETERMINATION.OD_DYNAMIC_PARAMETERS, keyed on PARAMETER: one
/// ECOM2_Y0 entry, VALUE finite in m/s**2, into the row (radiation_y0; absent or 0: no term). Refused by name: ECOM2_Y0
/// on an SGP4 or SGP4XP set, or on an AP set without gravity terms, which flies none (elements-other-theory); a second
/// entry (parameter-repeated:ECOM2_Y0); UNITS other than m/s**2 or a VALUE that is not a number (parameter-invalid:ECOM2_Y0);
/// any other ECOM2 coefficient (parameter-not-modeled:<NAME>). The other kinds are read where they are (MEAN_ELEMENTS,
/// the covariance's rows). 0 or 3.
inline int radiation_of(const OCM* o, Set& s) {
  const OrbitDetermination* od = o->ORBIT_DETERMINATION();
  if (od == nullptr || od->OD_DYNAMIC_PARAMETERS() == nullptr) return 0;
  bool seen = false;
  for (const OCMDynamicParameter* p : *od->OD_DYNAMIC_PARAMETERS()) {
    if (p == nullptr) continue;
    const int kind = p->PARAMETER();
    if (kind >= prwDynamicParameter_ECOM2_D0 && kind <= prwDynamicParameter_ECOM2_B3_SIN && kind != prwDynamicParameter_ECOM2_Y0) {
      char code[64];
      std::snprintf(code, sizeof code, "parameter-not-modeled:%s", EnumNameprwDynamicParameter(static_cast<prwDynamicParameter>(kind)));
      return refuse(code, "Of ECOM2's coefficients AP flies Y0 (ECOM2_Y0); its direct term is the sphere's AGOM.");
    }
    if (kind != prwDynamicParameter_ECOM2_Y0) continue;
    if (seen) return refuse("parameter-repeated:ECOM2_Y0", "OD_DYNAMIC_PARAMETERS carries ECOM2_Y0 twice.");
    seen = true;
    if (s.theory != meanElementSource_AP || !epoch_frame(s.forces))
      return refuse("elements-other-theory",
                    "ECOM2_Y0 is AP's radiation term, flown with its gravity terms: an SGP4 or SGP4XP set, or an AP set whose gravity caps are both 0, carries none.");
    const double v = p->VALUE();
    if (!std::isfinite(v) || (p->UNITS() != nullptr && p->UNITS()->size() > 0 && std::strcmp(p->UNITS()->c_str(), kY0Units) != 0))
      return refuse("parameter-invalid:ECOM2_Y0", "ECOM2_Y0's VALUE is a number in m/s**2 (UNITS m/s**2).");
    radiation_y0(s.row) = v;
  }
  return 0;
}

/// Decodes one $OCM element set (plain or size-prefixed): 0 with `s` filled, or 3 with the named refusal set.
inline int decode_view(const OCM* o, Set& s);
inline int decode(const uint8_t* p, uint32_t n, Set& s) {
  s = Set{};
  const OCM* o = view(p, n);
  if (o == nullptr) return refuse("invalid-ocm", "An 'ocm' payload is not a verifiable SDS $OCM.");
  return decode_view(o, s);
}
/// decode() of a record view() has verified.
inline int decode_view(const OCM* o, Set& s) {
  s = Set{};
  s.record = o;
  if (o->CENTER_NAME() != nullptr && o->CENTER_NAME()->size() > 0 && !oem::same_text(o->CENTER_NAME()->c_str(), "EARTH"))
    return refuse("unsupported-center", "An 'ocm' record is not centered on the Earth (CENTER_NAME); the theories here are geocentric.");
  const OCMMeanElements* me = o->MEAN_ELEMENTS();
  if (me == nullptr) return refuse("mean-elements-missing", "An 'ocm' record carries no MEAN_ELEMENTS: flight takes an element set.");
  s.theory = me->MEAN_ELEMENT_THEORY();
  if (s.theory == meanElementSource_UNSPECIFIED)
    return refuse("mean-element-theory-unspecified", "MEAN_ELEMENT_THEORY is UNSPECIFIED: a set states its theory.");
  if (s.theory != meanElementSource_SGP4 && s.theory != meanElementSource_SGP4XP && s.theory != meanElementSource_AP) {
    char code[64];
    const char* name = EnumNamemeanElementSource(static_cast<meanElementSource>(s.theory));
    std::snprintf(code, sizeof code, "theory-not-flown:%s", name != nullptr && *name ? name : "UNKNOWN");
    return refuse(code, "This module flies SGP4, SGP4XP and AP sets.");
  }
  ElementRow& row = s.row;
  if (me->EPOCH() == nullptr || !omm::epoch(me->EPOCH()->c_str(), me->EPOCH()->size(), row.epoch_jd_whole, row.epoch_jd_frac))
    return refuse("invalid-ocm", "MEAN_ELEMENTS.EPOCH is not an ISO 8601 UTC time.");
  const bool sgp4 = s.theory == meanElementSource_SGP4;
  row.theory = sgp4 ? kTheorySgp4 : kTheorySgp4Xp;
  row.mean_motion_rev_day = me->MEAN_MOTION();
  row.eccentricity = me->ECCENTRICITY();
  row.inclination_deg = me->INCLINATION();
  row.raan_deg = me->RA_OF_ASC_NODE();
  row.arg_pericenter_deg = me->ARG_OF_PERICENTER();
  row.mean_anomaly_deg = me->MEAN_ANOMALY();
  if (sgp4) {
    row.bstar = me->BSTAR();
    row.mean_motion_dot = me->MEAN_MOTION_DOT();
    row.mean_motion_ddot = me->MEAN_MOTION_DDOT();
    if (me->BTERM() != 0.0 || me->AGOM() != 0.0) return refuse("elements-other-theory", "An SGP4 set carries BTERM or AGOM (SGP4XP's terms).");
  } else {
    row.bterm = me->BTERM();
    row.agom = me->AGOM();
    if (me->BSTAR() != 0.0 || me->MEAN_MOTION_DOT() != 0.0 || me->MEAN_MOTION_DDOT() != 0.0)
      return refuse("elements-other-theory", "An SGP4XP or AP set carries BSTAR, MEAN_MOTION_DOT or MEAN_MOTION_DDOT (SGP4's terms).");
  }
  if (!(row.mean_motion_rev_day > 0.0)) return refuse("invalid-ocm", "MEAN_ELEMENTS.MEAN_MOTION is not positive.");
  s.id = identity_of(o);
  row.norad_cat_id = s.id.norad;
  const char* averaging = sgp4 ? "KOZAI" : "BROUWER";
  if (o->ORB_AVERAGING() == nullptr || !oem::same_text(o->ORB_AVERAGING()->c_str(), averaging))
    return refuse("orb-averaging-mismatch", sgp4 ? "An SGP4 set's ORB_AVERAGING is KOZAI." : "An SGP4XP or AP set's ORB_AVERAGING is BROUWER.");
  // the forces: PERTURBATIONS, the one authority
  const Perturbations* pt = o->PERTURBATIONS();
  const int ws = pt == nullptr ? pcfWeatherSource_UNSPECIFIED : pt->WEATHER_SOURCE();
  if (ws == pcfWeatherSource_UNSPECIFIED) return refuse("weather-source-unspecified", "PERTURBATIONS.WEATHER_SOURCE is UNSPECIFIED: a set states it (SGP4: NONE).");
  const ATM* am = pt->ATMOSPHERIC_MODEL();
  if ((am != nullptr) != (ws != pcfWeatherSource_NONE))
    return refuse("atmosphere-weather-mismatch", "ATMOSPHERIC_MODEL is present exactly when WEATHER_SOURCE is not NONE.");
  if (sgp4 != (ws == pcfWeatherSource_NONE))
    return refuse("atmosphere-weather-mismatch", "An SGP4 set's WEATHER_SOURCE is NONE (its drag is BSTAR); an SGP4XP or AP set's is THEORY_FLUX_MODEL or RECORDS.");
  Forces& f = s.forces;
  if (!sgp4) {
    if (am->MODEL() == AtmosphericModelFamily_JXX && am->YEAR() == 1970) f.msis = false;
    else if (am->MODEL() == AtmosphericModelFamily_NRLMSIS00E && am->YEAR() == 2000) f.msis = true;
    else return refuse("atmosphere-unsupported", "ATMOSPHERIC_MODEL is {JXX,1970} or {NRLMSIS00E,2000}.");
    if (ws != pcfWeatherSource_THEORY_FLUX_MODEL && ws != pcfWeatherSource_RECORDS)
      return refuse("atmosphere-weather-mismatch", "WEATHER_SOURCE is THEORY_FLUX_MODEL or RECORDS for an SGP4XP or AP set.");
    if (f.msis && ws != pcfWeatherSource_RECORDS)
      return refuse("atmosphere-weather-mismatch", "NRLMSISE-00 reads the record's daily rows (WEATHER_SOURCE RECORDS).");
    f.weather_source = ws;
    f.tesseral = pt->MAXIMUM_TESSERAL_DEGREE();
    f.zonal = pt->MAXIMUM_ZONAL_DEGREE();
    if (f.tesseral > 70 || f.zonal > 70) return refuse("atmosphere-unsupported", "MAXIMUM_TESSERAL_DEGREE and MAXIMUM_ZONAL_DEGREE are 0 to 70.");
  } else if (pt->MAXIMUM_TESSERAL_DEGREE() != 0 || pt->MAXIMUM_ZONAL_DEGREE() != 0) {
    return refuse("elements-other-theory", "An SGP4 set carries no gravity caps.");
  }
  if (const int rc = rows_of(pt, s.weather.rows)) return rc;
  const bool records = ws == pcfWeatherSource_RECORDS;
  if (records && s.weather.rows.empty()) return refuse("weather-rows-missing", "WEATHER_SOURCE RECORDS with no SPACE_WEATHER rows.");
  if (!records && !s.weather.rows.empty()) return refuse("weather-rows-unselected", "SPACE_WEATHER rows with WEATHER_SOURCE other than RECORDS.");
  // the density correction: the open-DCA nodes over NRLMSISE-00
  const auto* nt = pt->DENSITY_CORRECTION_NODE_TIMES_MS();
  const auto* nv = pt->DENSITY_CORRECTION_LOG_DENSITY_SCALE_DIMENSIONLESS();
  const bool has_nodes = (nt != nullptr && nt->size() > 0) || (nv != nullptr && nv->size() > 0);
  if (pt->DENSITY_CORRECTION() == pcfDensityCorrection_DCA_COMMON_MODE) {
    if (sgp4) return refuse("elements-other-theory", "An SGP4 set carries no density correction.");
    if (!has_nodes) return refuse("density-correction-missing", "DENSITY_CORRECTION DCA_COMMON_MODE with no nodes.");
    if (nt == nullptr || nv == nullptr || nt->size() != nv->size()) return refuse("invalid-density-correction", "One value per node.");
    for (uint32_t k = 0; k < nt->size(); ++k) {
      const int64_t ms = nt->Get(k);
      const double v = nv->Get(k);
      if (ms < 63072000000LL || ms > 253402300799999LL || (k > 0 && ms <= nt->Get(k - 1)) || !std::isfinite(v) || !std::isfinite(std::exp(v)))
        return refuse("invalid-density-correction", "UTC nodes increase strictly within 1972..9999, with finite values.");
      s.weather.node_ms.push_back(ms);
      s.weather.node_s.push_back(v);
    }
    if (!f.msis) return refuse("density-correction-atmosphere-mismatch", "The open-DCA nodes correct NRLMSISE-00: ATMOSPHERIC_MODEL {NRLMSIS00E,2000}.");
    if (pt->DENSITY_CORRECTION_CID() == nullptr || pt->DENSITY_CORRECTION_CID()->size() == 0)
      return refuse("density-correction-cid-missing", "DENSITY_CORRECTION DCA_COMMON_MODE names the $DCL its nodes copy (DENSITY_CORRECTION_CID).");
    s.weather.dcl_cid = pt->DENSITY_CORRECTION_CID()->str();
    f.dca = true;
  } else if (pt->DENSITY_CORRECTION() != pcfDensityCorrection_NONE) {
    return refuse("atmosphere-unsupported", "DENSITY_CORRECTION is NONE or DCA_COMMON_MODE.");
  } else if (has_nodes) {
    return refuse("density-correction-unselected", "Density-correction nodes with DENSITY_CORRECTION NONE.");
  }
  // the theory by MEAN_ELEMENT_THEORY alone: SGP4XP flies the theory's own forces, AP any other
  if (s.theory == meanElementSource_SGP4XP && !f.stock()) return refuse("elements-other-theory", "An SGP4XP set states AP's forces (MEAN_ELEMENT_THEORY AP).");
  if (s.theory == meanElementSource_AP && f.stock()) return refuse("elements-other-theory", "An AP set states SGP4XP's own forces (MEAN_ELEMENT_THEORY SGP4XP).");
  if (const int rc = radiation_of(o, s)) return rc;
  // the frame pairing: TEMEOFDATE, or TEMEOFEPOCH at the set's epoch for AP with gravity terms
  const int frame = frame_kind(o->TRAJ_REF_FRAME());
  const bool want_epoch = !sgp4 && epoch_frame(f);
  if (frame != (want_epoch ? 2 : 1) ||
      (want_epoch && (o->TRAJ_FRAME_EPOCH() == nullptr || std::strcmp(o->TRAJ_FRAME_EPOCH()->c_str(), me->EPOCH()->c_str()) != 0)) ||
      (!want_epoch && o->TRAJ_FRAME_EPOCH() != nullptr && o->TRAJ_FRAME_EPOCH()->size() > 0))
    return refuse("frame-pairing-invalid", want_epoch ? "AP with gravity terms is TEMEOFEPOCH, TRAJ_FRAME_EPOCH the set's EPOCH."
                                                      : "SGP4, SGP4XP and AP without gravity terms are TEMEOFDATE.");
  return 0;
}

/// The drag atmosphere of a decoded set (nullptr fills nothing: the theory's own flux model).
inline void atmosphere_of(const Set& s, atm::Atmosphere& a) {
  a = atm::Atmosphere{};
  a.model = s.forces.msis ? atm::kNrlmsise00 : atm::kJacchia70;
  a.measured = true;
  a.days = s.weather.rows;
  for (size_t k = 0; k < s.weather.node_ms.size(); ++k) {
    a.dca_ms.push_back(s.weather.node_ms[k]);
    a.dca_d50.push_back(static_cast<double>(s.weather.node_ms[k]) / 86400000.0 + 7306.0);
    a.dca_s.push_back(s.weather.node_s[k]);
  }
}

/// A set's forces bound while its theory records are initialized (they keep the atmosphere's address: it outlives them).
struct Bind {
  const atm::Atmosphere* prev;
  xpt::tess::Terms prev_terms;
  Bind(const Forces& f, const atm::Atmosphere* a) : prev(atm::active()), prev_terms(xpt::tess::active()) {
    atm::active() = f.weather_source == pcfWeatherSource_RECORDS ? a : nullptr;
    xpt::tess::active() = xpt::tess::Terms{f.tesseral, f.zonal};
  }
  ~Bind() {
    atm::active() = prev;
    xpt::tess::active() = prev_terms;
  }
};

/// weather-rows-short:<day> unless the rows hold every UTC day of [first_mjd - 1, last_mjd] (a set flown from its
/// epoch to the call's times reads the rows of every day between).
inline int rows_cover(const Set& s, int32_t first_mjd, int32_t last_mjd) {
  if (s.forces.weather_source != pcfWeatherSource_RECORDS) return 0;
  const std::vector<atm::SpwDay>& d = s.weather.rows;
  size_t k = 0;
  for (int32_t day = first_mjd - 1; day <= last_mjd; ++day) {
    while (k < d.size() && d[k].mjd < day) ++k;
    if (k >= d.size() || d[k].mjd != day) {
      char text[16];
      atm::date_of_mjd(day, text, sizeof text);
      return atm::fail_day("weather-rows-short", text, "The record's SPACE_WEATHER rows do not reach a day the call flies the set through: it flies from the day after its first row to the end of its last.");
    }
  }
  return 0;
}

/// The record type of a payload (plain or size-prefixed): its file identifier, or "" when it names none.
inline std::string type_of(const uint8_t* p, uint32_t n) {
  if (p == nullptr || n < 8) return std::string();
  const uint8_t* id = (n >= 12 && p[8] == '$') ? p + 8 : p + 4;
  if (id[0] != '$') return std::string();
  return std::string(reinterpret_cast<const char*>(id), 4);
}

/// A flight's frames ('ocm'): every frame's record type checked before anything is decoded. Flight takes $OCM records
/// (and the $PCF on 'configuration') and nothing else: an $OMM, $SPW, $DCL or $OEM is refused by its type. 0 with
/// `count` the 'ocm' frames, or 3 refused by name.
inline int admit(uint32_t& count) {
  count = 0;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (f == nullptr || f->port_id == nullptr || std::strcmp(f->port_id, "ocm") != 0) continue;
    const std::string t = type_of(f->payload, f->payload_length);
    if (t == "$OMM") return refuse("omm-not-flown", "Flight takes $OCM element sets: an $OMM enters through ingest_omm.");
    if (t == "$SPW") return refuse("spw-not-flown", "The record carries the space weather it flies on (PERTURBATIONS.SPACE_WEATHER): no $SPW beside it.");
    if (t == "$DCL") return refuse("dcl-not-flown", "The record carries its density-correction nodes: no $DCL beside it.");
    if (t == "$OEM") return refuse("grid-not-flown", "The output times are the $PCF's OUTPUT.EPOCHS, or START_TIME and STOP_TIME: no grid $OEM.");
    if (t != "$OCM") return refuse("invalid-ocm", "An 'ocm' payload is not an SDS $OCM.");
    ++count;
  }
  if (count == 0) return refuse("missing-ocm", "An 'ocm' input frame is required.");
  return 0;
}

/// The MJD of a split Julian date.
inline int32_t mjd_of(double whole, double frac) { return static_cast<int32_t>(std::floor((whole - 2400000.5) + frac)); }

}  // namespace ocm
}  // namespace sdnap
