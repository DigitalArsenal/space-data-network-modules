// -----------------------------------------------------------------------------
// $PCF 1.0.8 (SDS 1.279.0): the `configuration` input of the methods with
// options, optional on the flights that have a default for every value it
// carries (propagate, maneuver, load_epochs: a lone $OCM flies). A method reads
// THEORY and its own tables:
//   propagate, maneuver   OUTPUT (FRAME, STEP_SECONDS, MAXIMUM_STATES, and the
//                         output times: EPOCHS, or START_TIME and STOP_TIME),
//                         INTEGRATOR, EVENTS
//   fit                   FIT, FORCES, INTEGRATOR, and OUTPUT START_TIME and
//                         STOP_TIME: the forecast the record carries (SPEC 18)
// A flight's record is the one authority for its forces: a FORCES table on a
// flight call is refused (configuration-refused FORCES).
// FORCES on fit is the force model the fit runs under and writes into its
// $OCM (SPEC 15, 16; Forces): ATMOSPHERE_MODEL, required, JACCHIA70 or
// NRLMSISE00; WEATHER_SOURCE (UNSPECIFIED: THEORY_FLUX_MODEL under JACCHIA70,
// RECORDS under NRLMSISE00); DENSITY_CORRECTION; MAXIMUM_TESSERAL_DEGREE and
// MAXIMUM_DEGREE (the zonal tail). Every other FORCES field away from its
// default, ENABLE_DRAG included, is refused by name.
//   load_epochs, propagate_epochs  EPOCH_STORE and propagate's tables
// and leaves the other tables to the methods that read them. Fields left unset
// take the defaults schema/PCF/main.fbs documents (each equal to this module's
// own, so a table whose fields are all unset reads as an absent one), but one:
// a BTERM prior left unset (FIT.DRAG_PRIOR absent or without a sigma, its form
// unset) is LOG_NORMAL, median 0.01 m^2/kg, sigma of the log ln 10
// (kDragPriorDefault), where the schema's text says 0 +- 0.05; a field
// set to a value this module cannot apply is refused by name
// (configuration-refused). Each command invocation is a fresh instance: the
// values below live for one call.
// -----------------------------------------------------------------------------

namespace sdnap {
namespace fitoem {
inline double& tail_minutes();
}  // namespace fitoem

/// The force model of an SGP4XP or AP element set (SPEC 15, 16): what `fit` runs under (its $PCF FORCES) and what the
/// $OCM it writes states in PERTURBATIONS. Stock SGP4-XP is Jacchia 1970 on the theory's own flux model, no density
/// correction, no gravity terms beyond the theory's; anything else is AP.
struct Forces {
  bool msis = false;                                          ///< NRLMSISE-00 ({NRLMSIS00E,2000}); else Jacchia 1970 ({JXX,1970})
  int weather_source = pcfWeatherSource_THEORY_FLUX_MODEL;    ///< THEORY_FLUX_MODEL or RECORDS
  bool dca = false;                                           ///< DENSITY_CORRECTION DCA_COMMON_MODE
  int tesseral = 0;                                           ///< MAXIMUM_TESSERAL_DEGREE
  int zonal = 0;                                              ///< MAXIMUM_ZONAL_DEGREE (the $PCF's MAXIMUM_DEGREE): the zonal tail, J6 up
  bool stock() const { return !msis && weather_source == pcfWeatherSource_THEORY_FLUX_MODEL && !dca && tesseral == 0 && zonal == 0; }
  bool same(const Forces& o) const {
    return msis == o.msis && weather_source == o.weather_source && dca == o.dca && tesseral == o.tesseral && zonal == o.zonal;
  }
};

namespace pcf {

enum Method : uint32_t { kPropagate, kManeuver, kFit, kEpochs, kExport };  ///< kEpochs: load_epochs, propagate_epochs (propagate's tables); kExport: export_omm (THEORY only)

/// A fitted parameter's prior, $PCF FIT.DRAG_PRIOR (B_eff) or FIT.SRP_PRIOR (AGOM), m^2/kg, with its form
/// (FIT.DRAG_PRIOR_FORM, FIT.SRP_PRIOR_FORM). GAUSSIAN_SIGNED: on the parameter itself, `mean` and `sigma` in its unit.
/// LOG_NORMAL: the fit estimates the parameter's natural log, `mean` is the median (> 0) and `sigma` the standard
/// deviation of the log.
struct Prior {
  double mean, sigma;
  int form;
};

/// The prior of a term whose FIT prior is unset or without a sigma and whose form is unset (GAUSSIAN_SIGNED is the form's
/// value on the wire when unset, so an unset form and a written GAUSSIAN_SIGNED cannot be told apart): one constant per
/// term. BTERM: LOG_NORMAL with median 0.01 m^2/kg and sigma of the log ln 10 (2.302585092994046), the prior of the free
/// fits of experiments xp2-fit-design (1,214 windows, every one converged). The GAUSSIAN_SIGNED 0 +- 0.05 it replaces ended
/// at BTERM <= 0, no drag at all, on the real ISS window of test/fit.e2e.mjs; a Gaussian on BTERM is asked for by its
/// mean and sigma (FIT.DRAG_PRIOR, HAS_SIGMA true). AGOM: GAUSSIAN_SIGNED 0 +- 0.05.
constexpr Prior kDragPriorDefault = {0.01, 2.302585092994045684, pcfPriorForm_LOG_NORMAL};
constexpr Prior kSrpPriorDefault = {0.0, 0.05, pcfPriorForm_GAUSSIAN_SIGNED};
/// AGOM's prior on an arc shorter than kShortArcHours when FIT.SRP_PRIOR is unset: the Space Force wrapper's
/// (propagator/sgp4-xp/src/fit.hpp SGP4XP_PRIOR_SIGMA_AGOM), GAUSSIAN_SIGNED 0 +- 0.1 m^2/kg (SPEC 12.1).
constexpr Prior kSrpPriorShortArc = {0.0, 0.1, pcfPriorForm_GAUSSIAN_SIGNED};
/// An arc shorter than this takes kSrpPriorShortArc: the 24 h arcs; spans of 48 h and more keep kSrpPriorDefault.
constexpr double kShortArcHours = 36.0;
/// BTERM's sigma of the log when FIT.DRAG_PRIOR is unset under NRLMSISE-00 at a mean altitude of 800 to 1400 km (SPEC
/// 12.8): 10 ln 10. Under ln 10 the fit started at the band's median 0.0005 m^2/kg does not leave it, whatever the arc
/// holds (a true 0.044 ended at 0.0005-0.0008 and 1.3-4.0 km at day 3 on model truth); under 10 ln 10 it reaches the
/// value the arc determines.
constexpr double kDragPriorWideLogSigma = 23.02585092994045684;

/// One call's options, every one at its documented default.
struct Options {
  int theory = pcfTheory_UNSPECIFIED;
  // FIT
  double default_span_h = 48.0, minimum_span_h = 24.0, maximum_span_h = 120.0;
  double candidate_spans_h[8] = {};
  int candidate_count = 0;  // 0: 48, 72 and 120 h (24 h in front for an eccentric orbit)
  double extension_margin = 0.9;
  bool has_holdout = false;
  double holdout_h = 0.0;
  double eccentricity_threshold = 0.5, eccentric_default_span_h = 24.0, eccentric_extension_margin = 0.7;
  double eccentric_maximum_period_h = 36.0, implausible_rms_km = 100.0;
  Prior drag_prior = kDragPriorDefault, srp_prior = kSrpPriorDefault;
  bool drag_prior_given = false;  ///< FIT.DRAG_PRIOR stated with its sigma: fitted as given, no altitude band (SPEC 12.8)
  bool srp_prior_given = false;   ///< FIT.SRP_PRIOR stated with its sigma: no short-arc prior (kSrpPriorShortArc)
  uint32_t weather_horizon_days = 30;  ///< FIT.WEATHER_HORIZON_DAYS: the rows the $OCM carries past its epoch's day
  // FORCES (fit): the force model (SPEC 15, 16)
  Forces forces{};
  // OUTPUT
  int output_frame = pcfOutputFrame_UNSPECIFIED;
  double output_step_s = 60.0;
  uint32_t maximum_states = 500000;
  std::vector<double> epochs_w, epochs_f;  ///< OUTPUT.EPOCHS (UTC split Julian dates), ascending
  bool has_start = false, has_stop = false;
  double start_w = 0.0, start_f = 0.0, stop_w = 0.0, stop_f = 0.0;  ///< OUTPUT.START_TIME, STOP_TIME
};
inline Options& options() {
  static Options o;
  return o;
}

/// SPEC 12.8: one object's BTERM and AGOM priors, from a $PCF after the call's own on the fit's 'configuration' port
/// (the k-th such $PCF for the k-th 'ephemeris' frame); a prior it does not state stays the call's (band default).
struct ObjectPriors {
  Prior drag = kDragPriorDefault, srp = kSrpPriorDefault;
  bool drag_given = false, srp_given = false;
};
inline std::vector<ObjectPriors>& object_priors() {
  static std::vector<ObjectPriors> v;
  return v;
}

inline int refuse(const char* field, const char* why) {
  char text[400];
  std::snprintf(text, sizeof text, "%s: %s", field, why);
  plugin_set_error("configuration-refused", text);
  return 3;
}
inline const flatbuffers::Table* raw(const void* t) { return reinterpret_cast<const flatbuffers::Table*>(t); }
inline bool has(const void* t, uint16_t vt) { return t != nullptr && raw(t)->CheckField(vt); }

/// Every field of PCFForceModel in declaration order (slot 4 + 2 x index): its kind and documented default, for refusal
/// by name of a value other than the default (u8 / u16 / i32 / f64 scalars, a non-empty vector, a present table).
enum class Kind : uint8_t { U8, U16, I32, F64, Vec, Tab, Str };
struct ForceField {
  const char* name;
  Kind kind;
  double dflt;
};
constexpr ForceField kForceFields[] = {
    {"GRAVITY_CHOICE", Kind::U8, 0}, {"ENABLE_POINT_MASS", Kind::U8, 1}, {"GRAVITATIONAL_PARAMETER", Kind::F64, 0},
    {"ENABLE_J2", Kind::U8, 1}, {"ENABLE_J3", Kind::U8, 0}, {"ENABLE_J4", Kind::U8, 0}, {"ENABLE_HIGHER_ZONALS", Kind::U8, 0},
    {"MAXIMUM_DEGREE", Kind::U16, 0}, {"HAS_MAXIMUM_DEGREE", Kind::U8, 0}, {"MAXIMUM_ORDER", Kind::U16, 0},
    {"HAS_MAXIMUM_ORDER", Kind::U8, 0}, {"ENABLE_THIRD_BODY", Kind::U8, 0}, {"THIRD_BODY_IDS", Kind::Vec, 0},
    {"ENABLE_SRP", Kind::U8, 0}, {"ENABLE_DRAG", Kind::U8, 0}, {"INITIAL_MASS_KG", Kind::F64, 1000}, {"AREA_M2", Kind::F64, 10},
    {"REFLECTIVITY_COEFFICIENT", Kind::F64, 1.5}, {"DRAG_COEFFICIENT", Kind::F64, 2.2}, {"ATMOSPHERE_MODEL", Kind::U8, 1},
    {"WEATHER", Kind::Tab, 0}, {"EPHEMERIS_SOURCE", Kind::Str, 0}, {"SOLID_TIDES", Kind::U8, 0}, {"RELATIVITY", Kind::U8, 0},
    {"IN_TRACK_ACCELERATION_M_S2", Kind::F64, 0}, {"HAS_IN_TRACK_ACCELERATION_M_S2", Kind::U8, 0},
    {"DRAG_AREA_OVER_MASS_RATE_M2_KG_S", Kind::F64, 0}, {"HAS_DRAG_AREA_OVER_MASS_RATE_M2_KG_S", Kind::U8, 0},
    {"MAXIMUM_TESSERAL_DEGREE", Kind::U16, 0}, {"HAS_MAXIMUM_TESSERAL_DEGREE", Kind::U8, 0},
    {"RADIATION_PRESSURE_MODEL", Kind::U8, 0}, {"GNSS_BLOCK", Kind::U8, 0}, {"ECOM2", Kind::Tab, 0}, {"EARTH_RADIATION", Kind::U8, 0},
    {"EARTH_RADIATION_RESOLUTION_DEG", Kind::F64, 15}, {"EARTH_RADIATION_AREA_OVER_MASS_M2_KG", Kind::F64, 0},
    {"HAS_EARTH_RADIATION_AREA_OVER_MASS_M2_KG", Kind::U8, 0}, {"OCEAN_TIDES", Kind::U8, 0}, {"OCEAN_TIDE_MAXIMUM_DEGREE", Kind::U16, 30},
    {"OCEAN_TIDE_MAXIMUM_ORDER", Kind::U16, 30}, {"CENTRAL_BODY_NAIF_ID", Kind::I32, 399}, {"EPHEMERIS_KIND", Kind::U8, 0},
    {"SHADOW_MODEL", Kind::U8, 0}, {"WEATHER_SOURCE", Kind::U8, 0}, {"WEATHER_EXTENSION", Kind::U8, 0},
    {"DENSITY_CORRECTION", Kind::U8, 0}, {"DENSITY_CORRECTION_RELAXATION_HOURS", Kind::F64, 0},
    {"HAS_DENSITY_CORRECTION_RELAXATION_HOURS", Kind::U8, 0}, {"NEUTRAL_WIND", Kind::U8, 0},
    {"THIRD_BODY_MAXIMUM_DEGREE", Kind::U16, 0}, {"THIRD_BODY_MAXIMUM_ORDER", Kind::U16, 0}};

static_assert(sizeof kForceFields / sizeof kForceFields[0] == 51 && PCFForceModel::VT_THIRD_BODY_MAXIMUM_ORDER == 4 + 2 * 50 &&
                  PCFForceModel::VT_NEUTRAL_WIND == 4 + 2 * 48 && PCFForceModel::VT_EPHEMERIS_SOURCE == 4 + 2 * 21 &&
                  PCFForceModel::VT_THIRD_BODY_IDS == 4 + 2 * 12,
              "kForceFields follows PCFForceModel's declaration order, every field");

/// A field away from its documented default.
inline bool off_default(const flatbuffers::Table* t, uint16_t vt, const ForceField& f) {
  if (!t->CheckField(vt)) return false;
  switch (f.kind) {
    case Kind::U8: return t->GetField<uint8_t>(vt, static_cast<uint8_t>(f.dflt)) != static_cast<uint8_t>(f.dflt);
    case Kind::U16: return t->GetField<uint16_t>(vt, static_cast<uint16_t>(f.dflt)) != static_cast<uint16_t>(f.dflt);
    case Kind::I32: return t->GetField<int32_t>(vt, static_cast<int32_t>(f.dflt)) != static_cast<int32_t>(f.dflt);
    case Kind::F64: return t->GetField<double>(vt, f.dflt) != f.dflt;
    case Kind::Vec: {
      const auto* v = t->GetPointer<const flatbuffers::Vector<int32_t>*>(vt);
      return v != nullptr && v->size() != 0;
    }
    case Kind::Tab:
    case Kind::Str: return true;
  }
  return true;
}

/// The table masks of each method (bit per PCF table).
enum Table : uint32_t { kTFit = 1, kTOutput = 4, kTForces = 8, kTIntegrator = 16, kTEvents = 32 };
inline uint32_t tables_of(Method m) {
  switch (m) {
    case kPropagate:
    case kManeuver:
    case kEpochs: return kTOutput | kTIntegrator | kTEvents;
    case kFit: return kTFit | kTForces | kTIntegrator;
    case kExport: return 0;
  }
  return 0;
}

/// FIT.<name> and its form FIT.<name>_FORM: 0 with `out`, which arrives at the term's default, set, or 3 refused by
/// name. A prior absent or without a sigma under GAUSSIAN_SIGNED (the form's value when unset) leaves `out` at its
/// default. LOG_NORMAL needs the prior, its sigma (HAS_SIGMA true) and a MEAN, the median, > 0.
inline int read_prior(const PCFGaussianPrior* p, uint8_t form, const char* name, Prior& out) {
  char field[48];
  bool given = false;
  if (p != nullptr) {
    if (p->HAS_SIGMA()) {
      std::snprintf(field, sizeof field, "FIT.%s.SIGMA", name);
      if (!(p->SIGMA() > 0.0)) return refuse(field, "a sigma is positive");
      out.mean = p->MEAN();
      out.sigma = p->SIGMA();
      given = true;
    } else if (p->MEAN() != 0.0) {
      std::snprintf(field, sizeof field, "FIT.%s.MEAN", name);
      return refuse(field, "a prior mean comes with its SIGMA (HAS_SIGMA true)");
    }
  }
  switch (form) {
    case pcfPriorForm_GAUSSIAN_SIGNED:
      if (!given) return 0;
      break;
    case pcfPriorForm_LOG_NORMAL:
      if (p == nullptr) {
        std::snprintf(field, sizeof field, "FIT.%s", name);
        return refuse(field, "LOG_NORMAL needs the prior: MEAN the median (> 0, m^2/kg) and SIGMA the standard deviation of its natural log, HAS_SIGMA true");
      }
      if (!given) {
        std::snprintf(field, sizeof field, "FIT.%s.SIGMA", name);
        return refuse(field, "LOG_NORMAL needs the standard deviation of the natural log (HAS_SIGMA true)");
      }
      if (!(out.mean > 0.0)) {
        std::snprintf(field, sizeof field, "FIT.%s.MEAN", name);
        return refuse(field, "under LOG_NORMAL the MEAN is the median, > 0");
      }
      break;
    default:
      std::snprintf(field, sizeof field, "FIT.%s_FORM", name);
      return refuse(field, "GAUSSIAN_SIGNED or LOG_NORMAL");
  }
  out.form = form;
  return 0;
}

inline int read_fit(const PCFFitPolicy* f, Options& o) {
  if (f == nullptr) return 0;
  o.default_span_h = f->DEFAULT_SPAN_HOURS();
  o.minimum_span_h = f->MINIMUM_SPAN_HOURS();
  o.maximum_span_h = f->MAXIMUM_SPAN_HOURS();
  if (!(o.default_span_h > 0.0)) return refuse("FIT.DEFAULT_SPAN_HOURS", "a fit span is positive");
  if (!(o.minimum_span_h > 0.0 && o.minimum_span_h <= o.maximum_span_h))
    return refuse("FIT.MINIMUM_SPAN_HOURS", "0 < MINIMUM_SPAN_HOURS <= MAXIMUM_SPAN_HOURS");
  if (const auto* c = f->CANDIDATE_SPANS_HOURS()) {
    if (c->size() > 8) return refuse("FIT.CANDIDATE_SPANS_HOURS", "at most 8 candidate spans");
    double last = 0.0;
    for (uint32_t k = 0; k < c->size(); ++k) {
      const double s = c->Get(k);
      if (!(s > last)) return refuse("FIT.CANDIDATE_SPANS_HOURS", "the spans ascend");
      if (s < o.minimum_span_h || s > o.maximum_span_h)
        return refuse("FIT.CANDIDATE_SPANS_HOURS", "each span lies within [MINIMUM_SPAN_HOURS, MAXIMUM_SPAN_HOURS]");
      o.candidate_spans_h[k] = last = s;
    }
    o.candidate_count = static_cast<int>(c->size());
  }
  const double tail = f->TAIL_HOURS();
  if (!(tail > 0.0)) return refuse("FIT.TAIL_HOURS", "the validation tail is positive");
  fitoem::tail_minutes() = tail * 60.0;
  o.extension_margin = f->EXTENSION_MARGIN();
  if (!(o.extension_margin > 0.0 && o.extension_margin <= 1.0)) return refuse("FIT.EXTENSION_MARGIN", "a fraction in (0, 1]");
  o.has_holdout = f->HAS_HOLDOUT_HOURS();
  o.holdout_h = f->HOLDOUT_HOURS();
  if (!o.has_holdout && has(f, PCFFitPolicy::VT_HOLDOUT_HOURS) && o.holdout_h != 0.0)
    return refuse("FIT.HOLDOUT_HOURS", "set with HAS_HOLDOUT_HOURS true");
  if (o.has_holdout && !(o.holdout_h >= 0.0)) return refuse("FIT.HOLDOUT_HOURS", "hours held out are >= 0");
  o.eccentricity_threshold = f->ECCENTRICITY_THRESHOLD();
  if (!(o.eccentricity_threshold >= 0.0 && o.eccentricity_threshold < 1.0)) return refuse("FIT.ECCENTRICITY_THRESHOLD", "an eccentricity in [0, 1)");
  o.eccentric_default_span_h = f->ECCENTRIC_DEFAULT_SPAN_HOURS();
  if (!(o.eccentric_default_span_h > 0.0)) return refuse("FIT.ECCENTRIC_DEFAULT_SPAN_HOURS", "a fit span is positive");
  o.eccentric_extension_margin = f->ECCENTRIC_EXTENSION_MARGIN();
  if (!(o.eccentric_extension_margin > 0.0 && o.eccentric_extension_margin <= 1.0))
    return refuse("FIT.ECCENTRIC_EXTENSION_MARGIN", "a fraction in (0, 1]");
  o.eccentric_maximum_period_h = f->ECCENTRIC_MAXIMUM_PERIOD_HOURS();
  if (!(o.eccentric_maximum_period_h > 0.0)) return refuse("FIT.ECCENTRIC_MAXIMUM_PERIOD_HOURS", "a period is positive");
  o.implausible_rms_km = f->IMPLAUSIBLE_RMS_KM();
  if (!(o.implausible_rms_km > 0.0)) return refuse("FIT.IMPLAUSIBLE_RMS_KM", "a bound is positive");
  if (const int rc = read_prior(f->DRAG_PRIOR(), f->DRAG_PRIOR_FORM(), "DRAG_PRIOR", o.drag_prior)) return rc;
  o.drag_prior_given = f->DRAG_PRIOR() != nullptr && f->DRAG_PRIOR()->HAS_SIGMA();
  o.srp_prior_given = f->SRP_PRIOR() != nullptr && f->SRP_PRIOR()->HAS_SIGMA();
  o.weather_horizon_days = f->WEATHER_HORIZON_DAYS();
  return read_prior(f->SRP_PRIOR(), f->SRP_PRIOR_FORM(), "SRP_PRIOR", o.srp_prior);
}

inline int read_output(const PCFOutput* p, Options& o) {
  if (p == nullptr) return 0;
  switch (p->FRAME()) {
    case pcfOutputFrame_UNSPECIFIED:
    case pcfOutputFrame_TEME:
    case pcfOutputFrame_GCRF:
    case pcfOutputFrame_EME2000: o.output_frame = p->FRAME(); break;
    default: return refuse("OUTPUT.FRAME", "this module writes TEME, GCRF or EME2000 states");
  }
  o.output_step_s = p->STEP_SECONDS();
  if (!(o.output_step_s > 0.0)) return refuse("OUTPUT.STEP_SECONDS", "a positive spacing");
  o.maximum_states = p->MAXIMUM_STATES();
  if (o.maximum_states < 1 || o.maximum_states > 500000) return refuse("OUTPUT.MAXIMUM_STATES", "from 1 to this module's 500000");
  if (const auto* e = p->EPOCHS()) {
    for (uint32_t k = 0; k < e->size(); ++k) {
      double w, f;
      const flatbuffers::String* t = e->Get(k);
      if (t == nullptr || !omm::epoch(t->c_str(), t->size(), w, f)) return refuse("OUTPUT.EPOCHS", "ISO 8601 UTC times");
      if (!o.epochs_w.empty() && (w - o.epochs_w.back()) + (f - o.epochs_f.back()) < 0.0) return refuse("OUTPUT.EPOCHS", "ascending");
      o.epochs_w.push_back(w);
      o.epochs_f.push_back(f);
    }
  }
  if (p->START_TIME() != nullptr && p->START_TIME()->size() > 0) {
    if (!omm::epoch(p->START_TIME()->c_str(), p->START_TIME()->size(), o.start_w, o.start_f)) return refuse("OUTPUT.START_TIME", "an ISO 8601 UTC time");
    o.has_start = true;
  }
  if (p->STOP_TIME() != nullptr && p->STOP_TIME()->size() > 0) {
    if (!omm::epoch(p->STOP_TIME()->c_str(), p->STOP_TIME()->size(), o.stop_w, o.stop_f)) return refuse("OUTPUT.STOP_TIME", "an ISO 8601 UTC time");
    o.has_stop = true;
  }
  if (!o.epochs_w.empty() && (o.has_start || o.has_stop)) return refuse("OUTPUT.EPOCHS", "with EPOCHS, START_TIME and STOP_TIME are not read: state one or the other");
  if (o.has_start && o.has_stop && (o.stop_w - o.start_w) + (o.stop_f - o.start_f) < 0.0) return refuse("OUTPUT.STOP_TIME", "at or after START_TIME");
  return 0;
}

/// SPEC 18: OUTPUT on fit names the forecast the record carries: START_TIME and STOP_TIME, both or neither (neither:
/// none); the states between are the ephemeris block's, in the set's own frame, so EPOCHS, FRAME, STEP_SECONDS and
/// MAXIMUM_STATES away from their defaults are refused by name.
inline int read_carry(const PCFOutput* p, Options& o) {
  if (const int rc = read_output(p, o)) return rc;
  if (!o.epochs_w.empty()) return refuse("OUTPUT.EPOCHS", "fit carries the block's states from OUTPUT.START_TIME to STOP_TIME");
  if (p->FRAME() != pcfOutputFrame_UNSPECIFIED) return refuse("OUTPUT.FRAME", "a carried forecast is in the set's own TRAJ_REF_FRAME");
  if (has(p, PCFOutput::VT_STEP_SECONDS) && p->STEP_SECONDS() != 60.0) return refuse("OUTPUT.STEP_SECONDS", "fit chooses the carried segments");
  if (has(p, PCFOutput::VT_MAXIMUM_STATES) && p->MAXIMUM_STATES() != 500000) return refuse("OUTPUT.MAXIMUM_STATES", "fit chooses the carried segments");
  if (o.has_start != o.has_stop) return refuse(o.has_start ? "OUTPUT.STOP_TIME" : "OUTPUT.START_TIME", "fit carries the block's states from START_TIME to STOP_TIME: both, or neither");
  return 0;
}

/// The FORCES fields of the force model (SPEC 15, 16) on fit.
inline bool atmosphere_field(uint16_t vt) {
  return vt == PCFForceModel::VT_ATMOSPHERE_MODEL || vt == PCFForceModel::VT_WEATHER_SOURCE ||
         vt == PCFForceModel::VT_WEATHER_EXTENSION || vt == PCFForceModel::VT_DENSITY_CORRECTION ||
         vt == PCFForceModel::VT_DENSITY_CORRECTION_RELAXATION_HOURS || vt == PCFForceModel::VT_HAS_DENSITY_CORRECTION_RELAXATION_HOURS ||
         vt == PCFForceModel::VT_MAXIMUM_TESSERAL_DEGREE || vt == PCFForceModel::VT_HAS_MAXIMUM_TESSERAL_DEGREE ||
         vt == PCFForceModel::VT_MAXIMUM_DEGREE || vt == PCFForceModel::VT_HAS_MAXIMUM_DEGREE;
}

/// SPEC 16: AP's gravity terms of a fit.
inline int read_gravity_terms(const PCFForceModel* f, Forces& o) {
  if (f->HAS_MAXIMUM_TESSERAL_DEGREE()) {
    if (f->MAXIMUM_TESSERAL_DEGREE() > 70) return refuse("FORCES.MAXIMUM_TESSERAL_DEGREE", "0 to 70");
    o.tesseral = f->MAXIMUM_TESSERAL_DEGREE();
  } else if (f->MAXIMUM_TESSERAL_DEGREE() != 0) {
    return refuse("FORCES.MAXIMUM_TESSERAL_DEGREE", "set with HAS_MAXIMUM_TESSERAL_DEGREE true");
  }
  if (f->HAS_MAXIMUM_DEGREE()) {
    if (f->MAXIMUM_DEGREE() > 70) return refuse("FORCES.MAXIMUM_DEGREE", "0 to 70");
    o.zonal = f->MAXIMUM_DEGREE();
  } else if (f->MAXIMUM_DEGREE() != 0) {
    return refuse("FORCES.MAXIMUM_DEGREE", "set with HAS_MAXIMUM_DEGREE true");
  }
  return 0;
}

/// SPEC 15: the drag atmosphere of a fit: ATMOSPHERE_MODEL on the wire, JACCHIA70 or NRLMSISE00 (the record's
/// ATMOSPHERIC_MODEL {JXX,1970} or {NRLMSIS00E,2000}); WEATHER_SOURCE THEORY_FLUX_MODEL (Jacchia 1970 only) or RECORDS
/// (UNSPECIFIED: THEORY_FLUX_MODEL under JACCHIA70, RECORDS under NRLMSISE00); past the last row nothing is held.
inline int read_atmosphere(const PCFForceModel* f, Forces& o) {
  if (!has(f, PCFForceModel::VT_ATMOSPHERE_MODEL))
    return refuse("FORCES.ATMOSPHERE_MODEL", "fit states the atmosphere it fits under: JACCHIA70 or NRLMSISE00");
  switch (f->ATMOSPHERE_MODEL()) {
    case pcfAtmosphereFamily_JACCHIA70: o.msis = false; break;
    case pcfAtmosphereFamily_NRLMSISE00: o.msis = true; break;
    default: return refuse("FORCES.ATMOSPHERE_MODEL", "JACCHIA70 or NRLMSISE00");
  }
  switch (f->WEATHER_SOURCE()) {
    case pcfWeatherSource_UNSPECIFIED: o.weather_source = o.msis ? pcfWeatherSource_RECORDS : pcfWeatherSource_THEORY_FLUX_MODEL; break;
    case pcfWeatherSource_RECORDS: o.weather_source = pcfWeatherSource_RECORDS; break;
    case pcfWeatherSource_THEORY_FLUX_MODEL:
      if (o.msis) return refuse("FORCES.WEATHER_SOURCE", "NRLMSISE-00 reads daily $SPW rows (RECORDS)");
      o.weather_source = pcfWeatherSource_THEORY_FLUX_MODEL;
      break;
    default: return refuse("FORCES.WEATHER_SOURCE", "THEORY_FLUX_MODEL or RECORDS ('space_weather' $SPW rows)");
  }
  switch (f->WEATHER_EXTENSION()) {
    case pcfWeatherExtension_UNSPECIFIED:
    case pcfWeatherExtension_REFUSE: break;
    default: return refuse("FORCES.WEATHER_EXTENSION", "the rows must reach the record's horizon (FIT.WEATHER_HORIZON_DAYS); nothing is held past them");
  }
  if (f->DENSITY_CORRECTION() == pcfDensityCorrection_DCA_COMMON_MODE) {
    if (!o.msis) return refuse("FORCES.DENSITY_CORRECTION", "the open-DCA $DCL corrects NRLMSISE-00: ATMOSPHERE_MODEL NRLMSISE00");
    o.dca = true;
  } else if (f->DENSITY_CORRECTION() != pcfDensityCorrection_NONE) {
    return refuse("FORCES.DENSITY_CORRECTION", "NONE or DCA_COMMON_MODE");
  }
  const bool has_relax = f->HAS_DENSITY_CORRECTION_RELAXATION_HOURS();
  if (!has_relax && has(f, PCFForceModel::VT_DENSITY_CORRECTION_RELAXATION_HOURS) && f->DENSITY_CORRECTION_RELAXATION_HOURS() != 0.0)
    return refuse("FORCES.DENSITY_CORRECTION_RELAXATION_HOURS", "set with HAS_DENSITY_CORRECTION_RELAXATION_HOURS true");
  if (has_relax && f->DENSITY_CORRECTION_RELAXATION_HOURS() != 0.0)
    return refuse("FORCES.DENSITY_CORRECTION_RELAXATION_HOURS", "the $DCL's forecast nodes carry the decay; this module holds the last node (0)");
  return 0;
}

/// FORCES for the averaged theories: their forces are the theory's own; a FORCES table carries the required
/// EPHEMERIS_SOURCE, empty (the theory's own analytic Sun and Moon series), and on fit and propagate (`atmosphere`)
/// the drag atmosphere's fields (SPEC 15). Any other field away from its default is refused by name.
inline int read_forces(const PCFForceModel* f, bool atmosphere, Options& o) {
  if (f == nullptr) return atmosphere ? refuse("FORCES.ATMOSPHERE_MODEL", "fit states the atmosphere it fits under: JACCHIA70 or NRLMSISE00") : 0;
  for (size_t k = 0; k < sizeof kForceFields / sizeof kForceFields[0]; ++k) {
    const uint16_t vt = static_cast<uint16_t>(4 + 2 * k);
    if (vt == PCFForceModel::VT_EPHEMERIS_SOURCE || (atmosphere && atmosphere_field(vt)) || !off_default(raw(f), vt, kForceFields[k])) continue;
    char name[96];
    std::snprintf(name, sizeof name, "FORCES.%s", kForceFields[k].name);
    return refuse(name, atmosphere ? "fit states its force model by ATMOSPHERE_MODEL, WEATHER_SOURCE, DENSITY_CORRECTION, MAXIMUM_TESSERAL_DEGREE and MAXIMUM_DEGREE only"
                                   : "the averaged theories (SGP4XP) apply their own forces here; fit and propagate select the drag atmosphere");
  }
  if (f->EPHEMERIS_SOURCE() != nullptr && f->EPHEMERIS_SOURCE()->size() != 0)
    return refuse("FORCES.EPHEMERIS_SOURCE", "the averaged theories read their own analytic Sun and Moon series (leave it empty)");
  if (!atmosphere) return 0;
  if (const int rc = read_gravity_terms(f, o.forces)) return rc;
  return read_atmosphere(f, o.forces);
}

/// Reads the method's `configuration` ($PCF): 0 and the options() set, or 3 with the error set.
/// A 'configuration' frame's $PCF (plain or size-prefixed), or nullptr with the error set.
inline const PCF* pcf_of(const plugin_input_frame_t* cf) {
  const uint8_t* p = cf->payload;
  size_t len = cf->payload_length;
  flatbuffers::Verifier v(p, len);
  if (!VerifyPCFBuffer(v)) {
    flatbuffers::Verifier vs(p, len);
    if (len < 8 || !VerifySizePrefixedPCFBuffer(vs)) {
      plugin_set_error("invalid-configuration", "The 'configuration' payload is not a verifiable $PCF 1.0 record.");
      return nullptr;
    }
    p += 4;
  }
  return GetPCF(p);
}

/// SPEC 12.8: an object's $PCF on fit (every 'configuration' frame after the first) states only FIT.DRAG_PRIOR,
/// FIT.SRP_PRIOR and their forms (CONFIGURATION_ID and PROFILE, informational, may stand); anything else is refused.
inline int read_object_priors(const PCF* c, ObjectPriors& out) {
  constexpr const char* kWhat = "an object's $PCF (after the call's own) states only FIT.DRAG_PRIOR, FIT.SRP_PRIOR and their forms";
  if (c->THEORY() != pcfTheory_UNSPECIFIED || c->INTEGRATOR() != nullptr || c->FORCES() != nullptr ||
      (c->EVENTS() != nullptr && c->EVENTS()->size() != 0) || c->OUTPUT() != nullptr || c->EPOCH_STORE() != nullptr)
    return refuse("configuration", kWhat);
  const PCFFitPolicy* f = c->FIT();
  if (f == nullptr) return 0;
  if (f->CANDIDATE_SPANS_HOURS() != nullptr && f->CANDIDATE_SPANS_HOURS()->size() != 0) return refuse("configuration", kWhat);
  for (const uint16_t vt : {PCFFitPolicy::VT_DEFAULT_SPAN_HOURS, PCFFitPolicy::VT_MINIMUM_SPAN_HOURS,
                            PCFFitPolicy::VT_MAXIMUM_SPAN_HOURS,
                            PCFFitPolicy::VT_TAIL_HOURS, PCFFitPolicy::VT_EXTENSION_MARGIN, PCFFitPolicy::VT_HOLDOUT_HOURS,
                            PCFFitPolicy::VT_HAS_HOLDOUT_HOURS, PCFFitPolicy::VT_ECCENTRICITY_THRESHOLD,
                            PCFFitPolicy::VT_ECCENTRIC_DEFAULT_SPAN_HOURS, PCFFitPolicy::VT_ECCENTRIC_EXTENSION_MARGIN,
                            PCFFitPolicy::VT_ECCENTRIC_MAXIMUM_PERIOD_HOURS, PCFFitPolicy::VT_IMPLAUSIBLE_RMS_KM,
                            PCFFitPolicy::VT_WEATHER_HORIZON_DAYS})
    if (has(f, vt)) return refuse("configuration", kWhat);
  if (const int rc = read_prior(f->DRAG_PRIOR(), f->DRAG_PRIOR_FORM(), "DRAG_PRIOR", out.drag)) return rc;
  out.drag_given = f->DRAG_PRIOR() != nullptr && f->DRAG_PRIOR()->HAS_SIGMA();
  if (const int rc = read_prior(f->SRP_PRIOR(), f->SRP_PRIOR_FORM(), "SRP_PRIOR", out.srp)) return rc;
  out.srp_given = f->SRP_PRIOR() != nullptr && f->SRP_PRIOR()->HAS_SIGMA();
  return 0;
}

inline int read(Method method, bool optional = false) {
  Options& o = options();
  o = Options{};
  object_priors().clear();
  fitoem::tail_minutes() = 24.0 * 60.0;
  const plugin_input_frame_t* cf = nullptr;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (f != nullptr && f->port_id != nullptr && std::strcmp(f->port_id, "configuration") == 0) {
      if (cf == nullptr) {
        cf = f;
        continue;
      }
      // SPEC 12.8: fit takes, after the call's own, one $PCF per 'ephemeris' frame with that object's priors
      if (method != kFit) { plugin_set_error("configuration-refused", "configuration: one $PCF per call"); return 3; }
      if (f->payload == nullptr) { plugin_set_error("invalid-configuration", "An object's $PCF is empty."); return 3; }
      const PCF* oc = pcf_of(f);
      if (oc == nullptr) return 3;
      ObjectPriors op;
      if (const int rc = read_object_priors(oc, op)) return rc;
      object_priors().push_back(op);
    }
  }
  if (cf == nullptr || cf->payload == nullptr) {
    if (optional) return 0;  // every default: a lone $OCM flies
    plugin_set_error("configuration-missing", "The 'configuration' input ($PCF) is required.");
    return 3;
  }
  const PCF* c = pcf_of(cf);
  if (c == nullptr) return 3;
  const uint32_t tables = tables_of(method);
  o.theory = c->THEORY();
  switch (method) {
    case kPropagate:
    case kManeuver:
    case kEpochs:
    case kExport:
      if (o.theory != pcfTheory_UNSPECIFIED && o.theory != pcfTheory_SGP4 && o.theory != pcfTheory_SGP4XP && o.theory != pcfTheory_AP)
        return refuse("THEORY", "this module flies SGP4, SGP4XP and AP sets (UNSPECIFIED: each set's own)");
      if (c->FORCES() != nullptr) return refuse("FORCES", "the record is the one authority for its forces: a flight's $PCF carries no FORCES");
      break;
    case kFit:
      if (o.theory != pcfTheory_UNSPECIFIED && o.theory != pcfTheory_SGP4XP && o.theory != pcfTheory_AP)
        return refuse("THEORY", "fit produces SGP4XP and AP sets (UNSPECIFIED: the forces decide)");
      break;
  }
  if ((tables & kTIntegrator) && c->INTEGRATOR() != nullptr)
    return refuse("INTEGRATOR", "the averaged theories integrate on their own grid");
  if ((tables & kTEvents) && c->EVENTS() != nullptr && c->EVENTS()->size() != 0)
    return refuse("EVENTS", "this module locates no events");
  if (tables & kTFit)
    if (const int rc = read_fit(c->FIT(), o)) return rc;
  if (tables & kTOutput)
    if (const int rc = read_output(c->OUTPUT(), o)) return rc;
  if (method == kFit && c->OUTPUT() != nullptr)
    if (const int rc = read_carry(c->OUTPUT(), o)) return rc;
  if (tables & kTForces)
    if (const int rc = read_forces(c->FORCES(), method == kFit, o)) return rc;
  if (method == kFit && o.theory == pcfTheory_SGP4XP && !o.forces.stock())
    return refuse("THEORY", "SGP4XP sets fly on the theory's own forces (FORCES JACCHIA70 on its flux model, no terms, no correction)");
  if (method == kFit && o.theory == pcfTheory_AP && o.forces.stock())
    return refuse("THEORY", "an AP set is fitted under its own force model (FORCES with gravity terms, NRLMSISE00, RECORDS weather or a "
                            "density correction); these FORCES are SGP4XP's own: THEORY SGP4XP or UNSPECIFIED");
  return 0;
}

/// The flights: THEORY against a set's own MEAN_ELEMENT_THEORY (meanElementSource).
inline int check_set_theory(int met) {
  const int t = options().theory;
  if (t == pcfTheory_UNSPECIFIED) return 0;
  const int want = t == pcfTheory_SGP4 ? meanElementSource_SGP4 : t == pcfTheory_SGP4XP ? meanElementSource_SGP4XP : meanElementSource_AP;
  return met == want ? 0 : refuse("THEORY", "an input set's own theory differs (UNSPECIFIED reads each set's)");
}

}  // namespace pcf
}  // namespace sdnap
