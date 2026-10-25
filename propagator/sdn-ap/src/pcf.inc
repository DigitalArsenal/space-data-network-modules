// -----------------------------------------------------------------------------
// $PCF 1.0.4 (SDS 1.270.0): the required `configuration` input of every method
// with options. A method reads THEORY and its own tables:
//   propagate, maneuver   MEAN_ELEMENT, OUTPUT, FORCES, INTEGRATOR, EVENTS
//   fit                   FIT, MEAN_ELEMENT, FORCES, INTEGRATOR
//   load_epochs, propagate_epochs  EPOCH_STORE and propagate's tables
// and leaves the other tables to the methods that read them. Fields left unset
// take the defaults schema/PCF/main.fbs documents (each equal to this module's
// own, so a table whose fields are all unset reads as an absent one); a field
// set to a value this module cannot apply is refused by name
// (configuration-refused). Each command invocation is a fresh instance: the
// values below live for one call.
// -----------------------------------------------------------------------------

namespace sdnap {
namespace fitoem {
inline double& tail_minutes();
}  // namespace fitoem

namespace pcf {

enum Method : uint32_t { kPropagate, kManeuver, kFit };

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
  bool drag_prior_set = false, srp_prior_set = false;
  double drag_prior_mean = 0.0, drag_prior_sigma = 0.0, srp_prior_mean = 0.0, srp_prior_sigma = 0.05;
  // OUTPUT
  int output_frame = pcfOutputFrame_UNSPECIFIED;
  double output_step_s = 60.0;
  uint32_t maximum_states = 500000;
};
inline Options& options() {
  static Options o;
  return o;
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
    {"HAS_DENSITY_CORRECTION_RELAXATION_HOURS", Kind::U8, 0}, {"NEUTRAL_WIND", Kind::U8, 0}, {"EMPIRICAL_TERMS", Kind::Tab, 0}};

static_assert(sizeof kForceFields / sizeof kForceFields[0] == 50 && PCFForceModel::VT_EMPIRICAL_TERMS == 4 + 2 * 49 &&
                  PCFForceModel::VT_EPHEMERIS_SOURCE == 4 + 2 * 21 && PCFForceModel::VT_THIRD_BODY_IDS == 4 + 2 * 12,
              "kForceFields follows PCFForceModel's declaration order");

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
enum Table : uint32_t { kTFit = 1, kTMean = 2, kTOutput = 4, kTForces = 8, kTIntegrator = 16, kTEvents = 32 };
inline uint32_t tables_of(Method m) {
  switch (m) {
    case kPropagate:
    case kManeuver: return kTMean | kTOutput | kTForces | kTIntegrator | kTEvents;
    case kFit: return kTFit | kTMean | kTForces | kTIntegrator;
  }
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
  if (const PCFGaussianPrior* p = f->DRAG_PRIOR()) {
    if (p->HAS_SIGMA()) {
      if (!(p->SIGMA() > 0.0)) return refuse("FIT.DRAG_PRIOR.SIGMA", "a sigma is positive");
      o.drag_prior_set = true;
      o.drag_prior_mean = p->MEAN();
      o.drag_prior_sigma = p->SIGMA();
    } else if (p->MEAN() != 0.0) {
      return refuse("FIT.DRAG_PRIOR.MEAN", "a prior mean comes with its SIGMA (HAS_SIGMA true)");
    }
  }
  if (const PCFGaussianPrior* p = f->SRP_PRIOR()) {
    if (p->HAS_SIGMA()) {
      if (!(p->SIGMA() > 0.0)) return refuse("FIT.SRP_PRIOR.SIGMA", "a sigma is positive");
      o.srp_prior_set = true;
      o.srp_prior_mean = p->MEAN();
      o.srp_prior_sigma = p->SIGMA();
    } else if (p->MEAN() != 0.0) {
      return refuse("FIT.SRP_PRIOR.MEAN", "a prior mean comes with its SIGMA (HAS_SIGMA true)");
    }
  }
  return 0;
}

/// MEAN_ELEMENT holds the truncations and switches of a theory this module does not carry; SGP4 and SGP4XP are fixed by
/// their specifications, so a field away from its documented default is refused by name.
inline int read_mean(const PCFMeanElementOptions* m) {
  if (m == nullptr) return 0;
  struct Slot { uint16_t vt; const char* name; bool differs; };
  const Slot slots[] = {
      {PCFMeanElementOptions::VT_M_DAILY_MAXIMUM_DEGREE, "MEAN_ELEMENT.M_DAILY_MAXIMUM_DEGREE", m->M_DAILY_MAXIMUM_DEGREE() != 12},
      {PCFMeanElementOptions::VT_ZONAL_MAXIMUM_DEGREE, "MEAN_ELEMENT.ZONAL_MAXIMUM_DEGREE", m->ZONAL_MAXIMUM_DEGREE() != 20},
      {PCFMeanElementOptions::VT_SHORT_PERIODIC_MAXIMUM_DEGREE, "MEAN_ELEMENT.SHORT_PERIODIC_MAXIMUM_DEGREE", m->SHORT_PERIODIC_MAXIMUM_DEGREE() != 7},
      {PCFMeanElementOptions::VT_ENABLE_RESONANCE, "MEAN_ELEMENT.ENABLE_RESONANCE", !m->ENABLE_RESONANCE()},
      {PCFMeanElementOptions::VT_RESONANCE_MAXIMUM_DEGREE, "MEAN_ELEMENT.RESONANCE_MAXIMUM_DEGREE", m->RESONANCE_MAXIMUM_DEGREE() != 31},
      {PCFMeanElementOptions::VT_RESONANCE_BAND, "MEAN_ELEMENT.RESONANCE_BAND", m->RESONANCE_BAND() != 0.045},
      {PCFMeanElementOptions::VT_RESONANCE_MAXIMUM_K, "MEAN_ELEMENT.RESONANCE_MAXIMUM_K", m->RESONANCE_MAXIMUM_K() != 1},
      {PCFMeanElementOptions::VT_NEAR_RESONANCE_BAND, "MEAN_ELEMENT.NEAR_RESONANCE_BAND", m->NEAR_RESONANCE_BAND() != 0.0},
      {PCFMeanElementOptions::VT_GRID_STEP_DIVISOR, "MEAN_ELEMENT.GRID_STEP_DIVISOR", m->GRID_STEP_DIVISOR() != 1},
      {PCFMeanElementOptions::VT_DENSITY_KERNEL, "MEAN_ELEMENT.DENSITY_KERNEL", !m->DENSITY_KERNEL()},
      {PCFMeanElementOptions::VT_DRAG_REGIME_PERIGEE_KM, "MEAN_ELEMENT.DRAG_REGIME_PERIGEE_KM", m->DRAG_REGIME_PERIGEE_KM() != 2500.0}};
  for (const Slot& k : slots)
    if (has(m, k.vt) && k.differs) return refuse(k.name, "SGP4's and SGP4XP's truncations and switches are fixed by their specifications");
  return 0;
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
  return 0;
}

/// FORCES for the averaged theories: their forces are the theory's own; a FORCES table carries only the required
/// EPHEMERIS_SOURCE, empty (the theory's own analytic Sun and Moon series). A field away from its default, the
/// EMPIRICAL_TERMS table and the density-correction relaxation (a theory this module does not carry) included, is
/// refused by name; an EMPIRICAL_TERMS table at its defaults reads as an absent one.
inline int read_forces(const PCFForceModel* f) {
  if (f == nullptr) return 0;
  for (size_t k = 0; k < sizeof kForceFields / sizeof kForceFields[0]; ++k) {
    const uint16_t vt = static_cast<uint16_t>(4 + 2 * k);
    if (vt == PCFForceModel::VT_EMPIRICAL_TERMS || vt == PCFForceModel::VT_EPHEMERIS_SOURCE || !off_default(raw(f), vt, kForceFields[k])) continue;
    char name[96];
    std::snprintf(name, sizeof name, "FORCES.%s", kForceFields[k].name);
    return refuse(name, "the averaged theories (SGP4XP) apply their own forces; FORCES carries no field of its own");
  }
  if (f->EPHEMERIS_SOURCE() != nullptr && f->EPHEMERIS_SOURCE()->size() != 0)
    return refuse("FORCES.EPHEMERIS_SOURCE", "the averaged theories read their own analytic Sun and Moon series (leave it empty)");
  if (const PCFEmpiricalTerms* e = f->EMPIRICAL_TERMS()) {
    // the first field off its default (a table at its defaults reads as an absent one)
    const char* off = !e->ONCE_PER_REVOLUTION() ? "FORCES.EMPIRICAL_TERMS.ONCE_PER_REVOLUTION"
                      : e->HAS_TAU0_RULE_LIMIT_M2_KG() ? "FORCES.EMPIRICAL_TERMS.HAS_TAU0_RULE_LIMIT_M2_KG"
                      : !e->HELD_ABOVE_DRAG_REGIME() ? "FORCES.EMPIRICAL_TERMS.HELD_ABOVE_DRAG_REGIME"
                      : e->PERSISTENCE_HOURS() != 24.0 ? "FORCES.EMPIRICAL_TERMS.PERSISTENCE_HOURS" : nullptr;
    if (off != nullptr) return refuse(off, "SGP4XP carries no empirical terms");
  }
  return 0;
}

/// Reads the method's `configuration` ($PCF): 0 and the options() set, or 3 with the error set.
inline int read(Method method) {
  Options& o = options();
  o = Options{};
  fitoem::tail_minutes() = 24.0 * 60.0;
  const plugin_input_frame_t* cf = nullptr;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (f != nullptr && f->port_id != nullptr && std::strcmp(f->port_id, "configuration") == 0) {
      if (cf != nullptr) { plugin_set_error("configuration-refused", "configuration: one $PCF per call"); return 3; }
      cf = f;
    }
  }
  if (cf == nullptr || cf->payload == nullptr) {
    plugin_set_error("configuration-missing", "The 'configuration' input ($PCF 1.0) is required.");
    return 3;
  }
  const uint8_t* p = cf->payload;
  size_t len = cf->payload_length;
  {
    flatbuffers::Verifier v(p, len);
    if (!VerifyPCFBuffer(v)) {
      flatbuffers::Verifier vs(p, len);
      if (len < 8 || !VerifySizePrefixedPCFBuffer(vs)) {
        plugin_set_error("invalid-configuration", "The 'configuration' payload is not a verifiable $PCF 1.0 record.");
        return 3;
      }
      p += 4;
      len -= 4;
    }
  }
  const PCF* c = GetPCF(p);
  const uint32_t tables = tables_of(method);
  o.theory = c->THEORY();
  switch (method) {
    case kPropagate:
    case kManeuver:
      if (o.theory != pcfTheory_UNSPECIFIED && o.theory != pcfTheory_SGP4 && o.theory != pcfTheory_SGP4XP)
        return refuse("THEORY", "this module propagates SGP4 and SGP4XP sets (UNSPECIFIED: each set's own)");
      break;
    case kFit:
      if (o.theory != pcfTheory_UNSPECIFIED && o.theory != pcfTheory_SGP4XP) return refuse("THEORY", "fit produces SGP4XP sets (UNSPECIFIED: SGP4XP)");
      break;
  }
  if ((tables & kTIntegrator) && c->INTEGRATOR() != nullptr)
    return refuse("INTEGRATOR", "the averaged theories integrate on their own grid");
  if ((tables & kTEvents) && c->EVENTS() != nullptr && c->EVENTS()->size() != 0)
    return refuse("EVENTS", "this module locates no events");
  if (tables & kTFit)
    if (const int rc = read_fit(c->FIT(), o)) return rc;
  if (tables & kTMean)
    if (const int rc = read_mean(c->MEAN_ELEMENT())) return rc;
  if (tables & kTOutput)
    if (const int rc = read_output(c->OUTPUT(), o)) return rc;
  if (tables & kTForces)
    if (const int rc = read_forces(c->FORCES())) return rc;
  return 0;
}

/// propagate, maneuver: THEORY against a set's own theory (kTheory*).
inline int check_set_theory(int set_theory) {
  const Options& o = options();
  if (o.theory != pcfTheory_UNSPECIFIED) {
    const int want = o.theory == pcfTheory_SGP4 ? kTheorySgp4 : kTheorySgp4Xp;
    if (set_theory != want) return refuse("THEORY", "an input set's own theory differs (UNSPECIFIED reads each set's)");
  }
  return 0;
}

}  // namespace pcf
}  // namespace sdnap
