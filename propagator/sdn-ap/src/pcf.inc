// -----------------------------------------------------------------------------
// $PCF 1.0 (SDS 1.264.0): the required `configuration` input of every method
// with options. A method reads THEORY and its own tables:
//   propagate, maneuver   MEAN_ELEMENT, SEGMENTS, OUTPUT, FORCES, INTEGRATOR, EVENTS
//   fit                   FIT, MEAN_ELEMENT, SEGMENTS, FORCES, INTEGRATOR
//   detect_maneuvers      MEAN_ELEMENT, MANEUVER_DETECTION, INTEGRATOR
//   reentry               REENTRY, MEAN_ELEMENT, FORCES, INTEGRATOR
//   launch_set, launch_batch  LAUNCH, MEAN_ELEMENT
// and leaves the other tables to the methods that read them. Fields left unset
// take the defaults schema/PCF/main.fbs documents (each equal to this module's
// own); a field set to a value this module cannot apply is refused by name
// (configuration-refused). Each command invocation is a fresh instance: the
// values below live for one call.
// -----------------------------------------------------------------------------

inline double& glr_threshold();

namespace sdnap {
namespace fitoem {
inline double& beff_rule_limit();
inline bool& tau_above_regime();
inline int& tau_terms();
inline double& tail_minutes();
}  // namespace fitoem

namespace pcf {

enum Method : uint32_t { kPropagate, kManeuver, kFit, kDetect, kReentry, kLaunchSet, kLaunchBatch };

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
  // MANEUVER_DETECTION
  bool white_innovations = false;
  uint32_t margin_states = 12, minimum_states = 48;
  double refine_window_h = 2.0;
  // REENTRY
  double reentry_altitude_km = 80.0, handoff_perigee_km = 180.0, handoff_decay_ratio = 0.05;
  double handoff_collapse = 0.01, handoff_minimum_e = 0.01, node_step_min = 30.0, horizon_days = 120.0;
  double window_density_sigma = 0.15, window_correlation_days = 2.0, window_ballistic_sigma = 0.05;
  bool window_ballistic_set = false;
  double osculating_step_s = 10.0;
  // LAUNCH
  double launch_drag_prior = 0.01, launch_srp_prior = 0.01, separation_sigma_m_s = 1.0, batch_mean_sigma = 1.0;
  bool launch_drag_set = false, launch_srp_set = false, has_shrink = false;
  double shrink_sigma = 0.0;
  // OUTPUT
  int output_frame = pcfOutputFrame_UNSPECIFIED;
  double output_step_s = 60.0;
  uint32_t maximum_states = 500000;
  // MEAN_ELEMENT (the rest are the theory's own singletons): the first field set off its default, refused for an
  // SGP4 or SGP4XP set; FORCES.EMPIRICAL_TERMS likewise (SDN-AP's terms)
  double drag_regime_km = 2500.0;
  const char* mean_set = nullptr;
  bool empirical_set = false;
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
enum Table : uint32_t {
  kTFit = 1, kTMean = 2, kTSegments = 4, kTDetect = 8, kTReentry = 16, kTLaunch = 32, kTOutput = 64, kTForces = 128,
  kTIntegrator = 256, kTEvents = 512
};
inline uint32_t tables_of(Method m) {
  switch (m) {
    case kPropagate:
    case kManeuver: return kTMean | kTSegments | kTOutput | kTForces | kTIntegrator | kTEvents;
    case kFit: return kTFit | kTMean | kTSegments | kTForces | kTIntegrator;
    case kDetect: return kTMean | kTDetect | kTIntegrator;
    case kReentry: return kTReentry | kTMean | kTForces | kTIntegrator;
    case kLaunchSet:
    case kLaunchBatch: return kTLaunch | kTMean;
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

/// MEAN_ELEMENT: SDN-AP's truncations and switches (SGP4XP's are fixed by its specification).
inline int read_mean(const PCFMeanElementOptions* m, bool sgp4xp_only, Options& o) {
  if (m == nullptr) return 0;
  struct Slot { uint16_t vt; const char* name; };
  {
    static const Slot slots[] = {
        {PCFMeanElementOptions::VT_M_DAILY_MAXIMUM_DEGREE, "MEAN_ELEMENT.M_DAILY_MAXIMUM_DEGREE"},
        {PCFMeanElementOptions::VT_ZONAL_MAXIMUM_DEGREE, "MEAN_ELEMENT.ZONAL_MAXIMUM_DEGREE"},
        {PCFMeanElementOptions::VT_SHORT_PERIODIC_MAXIMUM_DEGREE, "MEAN_ELEMENT.SHORT_PERIODIC_MAXIMUM_DEGREE"},
        {PCFMeanElementOptions::VT_ENABLE_RESONANCE, "MEAN_ELEMENT.ENABLE_RESONANCE"},
        {PCFMeanElementOptions::VT_RESONANCE_MAXIMUM_DEGREE, "MEAN_ELEMENT.RESONANCE_MAXIMUM_DEGREE"},
        {PCFMeanElementOptions::VT_RESONANCE_BAND, "MEAN_ELEMENT.RESONANCE_BAND"},
        {PCFMeanElementOptions::VT_RESONANCE_MAXIMUM_K, "MEAN_ELEMENT.RESONANCE_MAXIMUM_K"},
        {PCFMeanElementOptions::VT_NEAR_RESONANCE_BAND, "MEAN_ELEMENT.NEAR_RESONANCE_BAND"},
        {PCFMeanElementOptions::VT_GRID_STEP_DIVISOR, "MEAN_ELEMENT.GRID_STEP_DIVISOR"},
        {PCFMeanElementOptions::VT_DENSITY_KERNEL, "MEAN_ELEMENT.DENSITY_KERNEL"},
        {PCFMeanElementOptions::VT_DRAG_REGIME_PERIGEE_KM, "MEAN_ELEMENT.DRAG_REGIME_PERIGEE_KM"}};
    const bool differs[] = {m->M_DAILY_MAXIMUM_DEGREE() != 12, m->ZONAL_MAXIMUM_DEGREE() != 20,
                            m->SHORT_PERIODIC_MAXIMUM_DEGREE() != 7, !m->ENABLE_RESONANCE(),
                            m->RESONANCE_MAXIMUM_DEGREE() != 31, m->RESONANCE_BAND() != 0.045,
                            m->RESONANCE_MAXIMUM_K() != 1, m->NEAR_RESONANCE_BAND() != 0.0,
                            m->GRID_STEP_DIVISOR() != 1, !m->DENSITY_KERNEL(), m->DRAG_REGIME_PERIGEE_KM() != 2500.0};
    for (size_t k = 0; k < sizeof slots / sizeof slots[0] && o.mean_set == nullptr; ++k)
      if (has(m, slots[k].vt) && differs[k]) o.mean_set = slots[k].name;
    if (sgp4xp_only && o.mean_set != nullptr) return refuse(o.mean_set, "SGP4XP's truncations and switches are fixed by its specification");
    if (sgp4xp_only) return 0;
  }
  const int md = m->M_DAILY_MAXIMUM_DEGREE();
  if (md > 16 || (md & 1) != 0) return refuse("MEAN_ELEMENT.M_DAILY_MAXIMUM_DEGREE", "an even degree from 0 to 16");
  const int zd = m->ZONAL_MAXIMUM_DEGREE();
  if (zd < 6 || zd > 70) return refuse("MEAN_ELEMENT.ZONAL_MAXIMUM_DEGREE", "a degree from 6 to 70");
  const int sd = m->SHORT_PERIODIC_MAXIMUM_DEGREE();
  if (sd < 2 || sd > 16) return refuse("MEAN_ELEMENT.SHORT_PERIODIC_MAXIMUM_DEGREE", "a degree from 2 to 16");
  const int rd = m->RESONANCE_MAXIMUM_DEGREE();
  if (rd < 3 || rd > 69 || (rd & 1) == 0) return refuse("MEAN_ELEMENT.RESONANCE_MAXIMUM_DEGREE", "an odd degree from 3 to 69");
  const double band = m->RESONANCE_BAND();
  if (!(band > 0.0 && band < 0.5)) return refuse("MEAN_ELEMENT.RESONANCE_BAND", "a fraction of the mean motion in (0, 0.5)");
  const int kmax = m->RESONANCE_MAXIMUM_K();
  if (kmax < 1 || kmax > 3) return refuse("MEAN_ELEMENT.RESONANCE_MAXIMUM_K", "a multiple from 1 to 3");
  const double near = m->NEAR_RESONANCE_BAND();
  if (!(near >= 0.0 && near < 0.5)) return refuse("MEAN_ELEMENT.NEAR_RESONANCE_BAND", "a fraction of the mean motion in [0, 0.5)");
  const int div = m->GRID_STEP_DIVISOR();
  if (div < 1 || div > 16) return refuse("MEAN_ELEMENT.GRID_STEP_DIVISOR", "a divisor from 1 to 16");
  const double regime = m->DRAG_REGIME_PERIGEE_KM();
  if (!(regime > 0.0 && regime <= 2500.0))
    return refuse("MEAN_ELEMENT.DRAG_REGIME_PERIGEE_KM", "a height in (0, 2500] km: the density kernel ends at 2500 km");
  xpt::tess::mdaily_degree() = md;
  xpt::tess::zonal_degree() = zd;
  xpt::tess::sp_degree() = sd;
  xpt::tess::resonance_on() = m->ENABLE_RESONANCE();
  xpt::tess::shallow_degree() = m->ENABLE_RESONANCE() ? rd : 0;
  xpt::tess::shallow_band() = band;
  xpt::tess::shallow_kmax() = kmax;
  xpt::tess::near_band() = m->ENABLE_RESONANCE() ? near : 0.0;
  xpt::tess::step_divisor() = div;
  sdn::environment().kernel = m->DENSITY_KERNEL() ? 1 : 0;
  o.drag_regime_km = regime;
  return 0;
}

inline int read_segments(const PCFSegmentOptions* s) {
  if (s == nullptr) return 0;
  const int gd = s->MOON_GRAVITY_MAXIMUM_DEGREE();
  if (gd < 2 || gd > 70) return refuse("SEGMENTS.MOON_GRAVITY_MAXIMUM_DEGREE", "a degree from 2 to 70 (the module's GRGM660PRIM table ends at 70)");
  const int sd = s->MOON_SHORT_PERIODIC_MAXIMUM_DEGREE();
  if (sd > gd) return refuse("SEGMENTS.MOON_SHORT_PERIODIC_MAXIMUM_DEGREE", "a degree up to MOON_GRAVITY_MAXIMUM_DEGREE");
  const int eo = s->MOON_ECCENTRICITY_ORDER();
  if (eo > 8) return refuse("SEGMENTS.MOON_ECCENTRICITY_ORDER", "an order from 0 to 8");
  const double ms = s->MOON_STEP_SECONDS();
  if (!(ms >= 10.0 && ms <= 3600.0)) return refuse("SEGMENTS.MOON_STEP_SECONDS", "a step from 10 to 3600 s");
  if (has(s, PCFSegmentOptions::VT_CISLUNAR_STEP_SECONDS) && s->CISLUNAR_STEP_SECONDS() != 60.0)
    return refuse("SEGMENTS.CISLUNAR_STEP_SECONDS", "the cislunar integration steps 60 s");
  if (has(s, PCFSegmentOptions::VT_HELIOCENTRIC_STEP_SECONDS) && s->HELIOCENTRIC_STEP_SECONDS() != 1800.0)
    return refuse("SEGMENTS.HELIOCENTRIC_STEP_SECONDS", "the heliocentric integration steps 1800 s");
  if (has(s, PCFSegmentOptions::VT_CISLUNAR_MINIMUM_SEGMENT_HOURS) && s->CISLUNAR_MINIMUM_SEGMENT_HOURS() != 6.0)
    return refuse("SEGMENTS.CISLUNAR_MINIMUM_SEGMENT_HOURS", "the cislunar segments are at least 6 h");
  const double factor = s->SEGMENT_RMS_FACTOR(), margin = s->SEGMENT_RMS_MARGIN_KM();
  if (!(factor >= 1.0)) return refuse("SEGMENTS.SEGMENT_RMS_FACTOR", "a factor >= 1");
  if (!(margin >= 0.0)) return refuse("SEGMENTS.SEGMENT_RMS_MARGIN_KM", "a margin >= 0 km");
  segment::rms_factor() = factor;
  segment::rms_margin_km() = margin;
  lunar::gravity_degree() = gd;
  lunar::short_degree() = sd;
  lunar::eccentricity_order() = eo;
  lunar::step_seconds() = ms;
  return 0;
}

inline int read_detect(const PCFManeuverDetection* d, Options& o) {
  if (d == nullptr) return 0;
  if (d->FALSE_ALARMS_PER_OBJECT_YEAR() != 1.0)
    return refuse("MANEUVER_DETECTION.FALSE_ALARMS_PER_OBJECT_YEAR", "the threshold is calibrated for 1 per object-year; this module does not recalibrate");
  switch (d->CORRELATION_MODEL()) {
    case pcfInnovationCorrelation_UNSPECIFIED:
    case pcfInnovationCorrelation_ONE_SAMPLE_PER_REVOLUTION: o.white_innovations = false; break;
    case pcfInnovationCorrelation_WHITE: o.white_innovations = true; break;
    default: return refuse("MANEUVER_DETECTION.CORRELATION_MODEL", "this module weights WHITE or ONE_SAMPLE_PER_REVOLUTION");
  }
  const double thr = d->THRESHOLD();
  if (!(thr > 0.0)) return refuse("MANEUVER_DETECTION.THRESHOLD", "a positive Lambda");
  glr_threshold() = thr;
  o.margin_states = d->MARGIN_STATES();
  if (o.margin_states < 1) return refuse("MANEUVER_DETECTION.MARGIN_STATES", "at least 1 state");
  o.refine_window_h = d->REFINE_WINDOW_HOURS();
  if (!(o.refine_window_h > 0.0)) return refuse("MANEUVER_DETECTION.REFINE_WINDOW_HOURS", "a positive half-width");
  o.minimum_states = d->MINIMUM_STATES();
  if (o.minimum_states < 2 * o.margin_states + 8)
    return refuse("MANEUVER_DETECTION.MINIMUM_STATES", "at least 2 x MARGIN_STATES + 8 states");
  return 0;
}

inline int read_reentry(const PCFReentry* r, Options& o) {
  if (r == nullptr) return 0;
  o.reentry_altitude_km = r->ALTITUDE_KM();
  o.handoff_perigee_km = r->HANDOFF_PERIGEE_ALTITUDE_KM();
  if (!(o.reentry_altitude_km >= 10.0 && o.reentry_altitude_km <= 150.0)) return refuse("REENTRY.ALTITUDE_KM", "an altitude from 10 to 150 km");
  if (!(o.handoff_perigee_km > o.reentry_altitude_km && o.handoff_perigee_km <= 1000.0))
    return refuse("REENTRY.HANDOFF_PERIGEE_ALTITUDE_KM", "above ALTITUDE_KM and at most 1000 km");
  o.handoff_decay_ratio = r->HANDOFF_DECAY_RATIO();
  if (!(o.handoff_decay_ratio > 0.0 && o.handoff_decay_ratio <= 1.0)) return refuse("REENTRY.HANDOFF_DECAY_RATIO", "a fraction in (0, 1]");
  o.handoff_collapse = r->HANDOFF_ECCENTRICITY_COLLAPSE();
  if (!(o.handoff_collapse > 0.0 && o.handoff_collapse <= 1.0)) return refuse("REENTRY.HANDOFF_ECCENTRICITY_COLLAPSE", "a fraction in (0, 1]");
  o.handoff_minimum_e = r->HANDOFF_MINIMUM_ECCENTRICITY();
  if (!(o.handoff_minimum_e >= 0.0 && o.handoff_minimum_e < 1.0)) return refuse("REENTRY.HANDOFF_MINIMUM_ECCENTRICITY", "an eccentricity in [0, 1)");
  o.node_step_min = r->NODE_STEP_MINUTES();
  if (!(o.node_step_min >= 1.0 && o.node_step_min <= 1440.0)) return refuse("REENTRY.NODE_STEP_MINUTES", "a spacing from 1 to 1440 minutes");
  o.horizon_days = r->HORIZON_DAYS();
  if (!(o.horizon_days > 0.0 && o.horizon_days <= 3650.0)) return refuse("REENTRY.HORIZON_DAYS", "a look-ahead in (0, 3650] days");
  switch (r->WINDOW_METHOD()) {
    case pcfReentryWindowMethod_UNSPECIFIED:
    case pcfReentryWindowMethod_LINEAR: break;
    default: return refuse("REENTRY.WINDOW_METHOD", "this module computes the LINEAR window (DESIGN 5.2.3, eq. 20)");
  }
  o.window_density_sigma = r->WINDOW_DENSITY_SIGMA();
  if (!(o.window_density_sigma >= 0.0)) return refuse("REENTRY.WINDOW_DENSITY_SIGMA", "a sigma >= 0");
  o.window_correlation_days = r->WINDOW_CORRELATION_DAYS();
  if (!(o.window_correlation_days > 0.0)) return refuse("REENTRY.WINDOW_CORRELATION_DAYS", "a positive time");
  o.window_ballistic_set = has(r, PCFReentry::VT_WINDOW_BALLISTIC_SIGMA);
  o.window_ballistic_sigma = r->WINDOW_BALLISTIC_SIGMA();
  if (!(o.window_ballistic_sigma >= 0.0)) return refuse("REENTRY.WINDOW_BALLISTIC_SIGMA", "a sigma >= 0");
  o.osculating_step_s = r->OSCULATING_STEP_SECONDS();
  if (!(o.osculating_step_s >= 0.5 && o.osculating_step_s <= 60.0)) return refuse("REENTRY.OSCULATING_STEP_SECONDS", "a step from 0.5 to 60 s");
  return 0;
}

inline int read_launch(const PCFLaunch* l, Options& o) {
  if (l == nullptr) return 0;
  o.launch_drag_set = has(l, PCFLaunch::VT_DRAG_AREA_OVER_MASS_PRIOR_M2_KG);
  o.launch_srp_set = has(l, PCFLaunch::VT_SRP_AREA_OVER_MASS_PRIOR_M2_KG);
  o.launch_drag_prior = l->DRAG_AREA_OVER_MASS_PRIOR_M2_KG();
  o.launch_srp_prior = l->SRP_AREA_OVER_MASS_PRIOR_M2_KG();
  if (!(o.launch_drag_prior >= 0.0)) return refuse("LAUNCH.DRAG_AREA_OVER_MASS_PRIOR_M2_KG", "a ratio >= 0");
  if (!(o.launch_srp_prior >= 0.0)) return refuse("LAUNCH.SRP_AREA_OVER_MASS_PRIOR_M2_KG", "a ratio >= 0");
  o.separation_sigma_m_s = l->SEPARATION_SIGMA_M_S();
  if (!(o.separation_sigma_m_s > 0.0)) return refuse("LAUNCH.SEPARATION_SIGMA_M_S", "a positive sigma");
  o.has_shrink = l->HAS_SHRINK_SIGMA_M2_KG();
  o.shrink_sigma = l->SHRINK_SIGMA_M2_KG();
  if (!o.has_shrink && has(l, PCFLaunch::VT_SHRINK_SIGMA_M2_KG) && o.shrink_sigma != 0.0)
    return refuse("LAUNCH.SHRINK_SIGMA_M2_KG", "set with HAS_SHRINK_SIGMA_M2_KG true");
  if (o.has_shrink && !(o.shrink_sigma > 0.0)) return refuse("LAUNCH.SHRINK_SIGMA_M2_KG", "a positive sigma");
  o.batch_mean_sigma = l->BATCH_MEAN_SIGMA_M2_KG();
  if (!(o.batch_mean_sigma > 0.0)) return refuse("LAUNCH.BATCH_MEAN_SIGMA_M2_KG", "a positive sigma");
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

/// FORCES for the averaged theories: their forces are the theory's own; a FORCES table carries only
/// EMPIRICAL_TERMS, the density-correction relaxation (0: held, as this module does) and the required
/// EPHEMERIS_SOURCE, empty (the theory's own analytic Sun and Moon series).
inline int read_forces(const PCFForceModel* f, Options& o) {
  if (f == nullptr) return 0;
  for (size_t k = 0; k < sizeof kForceFields / sizeof kForceFields[0]; ++k) {
    const uint16_t vt = static_cast<uint16_t>(4 + 2 * k);
    if (vt == PCFForceModel::VT_EMPIRICAL_TERMS || vt == PCFForceModel::VT_EPHEMERIS_SOURCE ||
        vt == PCFForceModel::VT_DENSITY_CORRECTION_RELAXATION_HOURS || vt == PCFForceModel::VT_HAS_DENSITY_CORRECTION_RELAXATION_HOURS ||
        !off_default(raw(f), vt, kForceFields[k]))
      continue;
    char name[96];
    std::snprintf(name, sizeof name, "FORCES.%s", kForceFields[k].name);
    return refuse(name, "the averaged theories (SGP4XP, SDNAP) apply their own forces; FORCES carries only EMPIRICAL_TERMS");
  }
  if (f->EPHEMERIS_SOURCE() != nullptr && f->EPHEMERIS_SOURCE()->size() != 0)
    return refuse("FORCES.EPHEMERIS_SOURCE", "the averaged theories read their own analytic Sun and Moon series (leave it empty)");
  if (f->HAS_DENSITY_CORRECTION_RELAXATION_HOURS() && f->DENSITY_CORRECTION_RELAXATION_HOURS() != 0.0)
    return refuse("FORCES.DENSITY_CORRECTION_RELAXATION_HOURS", "this module holds the last density-correction node (0)");
  if (const PCFEmpiricalTerms* e = f->EMPIRICAL_TERMS()) {
    o.empirical_set = true;
    fitoem::tau_terms() = e->ONCE_PER_REVOLUTION() ? 2 : 0;
    if (e->HAS_TAU0_RULE_LIMIT_M2_KG()) {
      if (!(e->TAU0_RULE_LIMIT_M2_KG() > 0.0)) return refuse("FORCES.EMPIRICAL_TERMS.TAU0_RULE_LIMIT_M2_KG", "a positive limit");
      fitoem::beff_rule_limit() = e->TAU0_RULE_LIMIT_M2_KG();
    } else {
      fitoem::beff_rule_limit() = __builtin_inf();
    }
    fitoem::tau_above_regime() = !e->HELD_ABOVE_DRAG_REGIME();
    const double ph = e->PERSISTENCE_HOURS();
    if (!(ph > 0.0)) return refuse("FORCES.EMPIRICAL_TERMS.PERSISTENCE_HOURS", "a positive time");
    sdn::tau_persistence_minutes() = ph * 60.0;
  }
  return 0;
}

/// Reads the method's `configuration` ($PCF): 0 and the options() set, or 3 with the error set.
inline int read(Method method) {
  Options& o = options();
  o = Options{};
  // the theory's own values of the singletons a table writes
  xpt::tess::mdaily_degree() = 12;
  xpt::tess::zonal_degree() = 20;
  xpt::tess::sp_degree() = 7;
  xpt::tess::resonance_on() = true;
  xpt::tess::shallow_degree() = 31;
  xpt::tess::shallow_band() = 0.045;
  xpt::tess::shallow_kmax() = 1;
  xpt::tess::near_band() = 0.0;
  xpt::tess::step_divisor() = 1;
  sdn::environment().kernel = 1;
  lunar::gravity_degree() = 70;
  lunar::short_degree() = 8;
  lunar::eccentricity_order() = 2;
  lunar::step_seconds() = 240.0;
  segment::rms_factor() = 2.0;
  segment::rms_margin_km() = 0.05;
  sdn::tau_persistence_minutes() = 1440.0;
  fitoem::tail_minutes() = 24.0 * 60.0;
  fitoem::tau_terms() = 2;
  fitoem::beff_rule_limit() = __builtin_inf();
  fitoem::tau_above_regime() = false;
  glr_threshold() = 20.0;
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
    case kReentry:
      if (o.theory == pcfTheory_FFM || o.theory == pcfTheory_KEPLER || o.theory > pcfTheory_KEPLER)
        return refuse("THEORY", "this module propagates SGP4, SGP4XP and SDNAP sets (UNSPECIFIED: each set's own)");
      if (method == kReentry && o.theory == pcfTheory_SGP4) return refuse("THEORY", "reentry is predicted for SGP4XP and SDNAP sets");
      break;
    case kFit:
      if (o.theory != pcfTheory_UNSPECIFIED && o.theory != pcfTheory_SGP4XP && o.theory != pcfTheory_SDNAP)
        return refuse("THEORY", "fit produces SGP4XP (UNSPECIFIED) or SDNAP sets");
      break;
    case kDetect:
    case kLaunchSet:
    case kLaunchBatch:
      if (o.theory != pcfTheory_UNSPECIFIED && o.theory != pcfTheory_SDNAP)
        return refuse("THEORY", "this method works with SDNAP sets (UNSPECIFIED: SDNAP)");
      break;
  }
  const bool sgp4xp_only = method == kFit && o.theory != pcfTheory_SDNAP;
  if ((tables & kTIntegrator) && c->INTEGRATOR() != nullptr)
    return refuse("INTEGRATOR", "the averaged theories integrate on their own grid (MEAN_ELEMENT.GRID_STEP_DIVISOR; REENTRY.OSCULATING_STEP_SECONDS)");
  if ((tables & kTEvents) && c->EVENTS() != nullptr && c->EVENTS()->size() != 0)
    return refuse("EVENTS", "this module locates no events");
  if (tables & kTFit)
    if (const int rc = read_fit(c->FIT(), o)) return rc;
  if (tables & kTMean)
    if (const int rc = read_mean(c->MEAN_ELEMENT(), sgp4xp_only, o)) return rc;
  if (tables & kTSegments)
    if (const int rc = read_segments(c->SEGMENTS())) return rc;
  if (tables & kTDetect)
    if (const int rc = read_detect(c->MANEUVER_DETECTION(), o)) return rc;
  if (tables & kTReentry)
    if (const int rc = read_reentry(c->REENTRY(), o)) return rc;
  if (tables & kTLaunch)
    if (const int rc = read_launch(c->LAUNCH(), o)) return rc;
  if (tables & kTOutput)
    if (const int rc = read_output(c->OUTPUT(), o)) return rc;
  if (tables & kTForces) {
    if (sgp4xp_only && c->FORCES() != nullptr && c->FORCES()->EMPIRICAL_TERMS() != nullptr)
      return refuse("FORCES.EMPIRICAL_TERMS", "SGP4XP carries no empirical terms");
    if (const int rc = read_forces(c->FORCES(), o)) return rc;
  }
  return 0;
}

/// propagate, maneuver, reentry: THEORY against a set's own theory (kTheory*).
inline int check_set_theory(int set_theory) {
  const Options& o = options();
  if (o.theory != pcfTheory_UNSPECIFIED) {
    const int want = o.theory == pcfTheory_SGP4 ? kTheorySgp4 : o.theory == pcfTheory_SGP4XP ? kTheorySgp4Xp : kTheorySdnAp;
    if (set_theory != want) return refuse("THEORY", "an input set's own theory differs (UNSPECIFIED reads each set's)");
  }
  if (set_theory != kTheorySdnAp && o.mean_set != nullptr)
    return refuse(o.mean_set, "an SGP4 or SGP4XP set's truncations and switches are fixed by its specification");
  if (set_theory != kTheorySdnAp && o.empirical_set)
    return refuse("FORCES.EMPIRICAL_TERMS", "an SGP4 or SGP4XP set carries no empirical terms");
  return 0;
}

}  // namespace pcf
}  // namespace sdnap
