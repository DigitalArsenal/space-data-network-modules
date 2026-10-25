// -----------------------------------------------------------------------------
// The invoke surface: `fit` takes $OEM ephemerides (one fit per data block:
// EPHEMERIS_DATA_LINES, TEME or Earth-fixed, UTC, km) and returns one $OMM
// SGP4XP set (BTERM and AGOM fitted, at the two-line text's digits) per
// block, its epoch the first state of the fit interval (USEABLE_START_TIME to
// USEABLE_STOP_TIME, the whole block when neither is stated); later states are
// held out and scored. Statistics go in COMMENT; USER_DEFINED_EARTH_MODEL,
// USER_DEFINED_EPOCH_TIMESTAMP and USER_DEFINED_MICROSECONDS carry the
// theory's Earth model and the epoch.
// -----------------------------------------------------------------------------

namespace sdnap {
namespace fitoem {

constexpr double kBtermPriorSigma = 0.05;  // m^2/kg: a weak prior about zero

/// DESIGN 2c.2, opt-in: the upper end of the physical B_eff range (m^2/kg); above it tau0 is fitted instead,
/// held after the arc (SDNAP_LOWERING). Off by default (B_eff free): on the experiment's FFM truth the 19
/// lowering Starlinks are plain drag at B_eff 0.52-13.6 m^2/kg; free B_eff gave a day-3 median of 7.4 km
/// against 169 km with the rule (coordinator, 2026-10-24). A 'prior' $OMM's USER_DEFINED_SDNAP_TAU0_RULE = 1
/// selects the rule for that invocation; sdnap_fit_diagnostic sets the default.
constexpr double kBeffPhysicalLimit = 0.5;
inline double& beff_rule_limit() {
  static double b = __builtin_inf();
  return b;
}
/// Diagnostic: above the drag regime, tauc/taus decaying after the arc as in it (not held).
inline bool& tau_above_regime() {
  static bool b = false;
  return b;
}
/// Diagnostic: the empirical terms fitted besides the 2c.2 rule (bit 1 tauc and taus; default on).
inline int& tau_terms() {
  static int t = 2;
  return t;
}

struct Sample {
  double whole, frac;  // split Julian date (UTC)
  double r[3], v[3];
  bool has_v;
};

/// Osculating two-body Keplerian elements of a TEME state (km, km/s), as the
/// starting set of the fit.
inline void start_row(const Sample& s, ElementRow& row) {
  const double mu = 398600.4415;
  const double* r = s.r;
  const double* v = s.v;
  const double rn = std::sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
  const double v2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  const double h[3] = {r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]};
  const double hn = std::sqrt(h[0] * h[0] + h[1] * h[1] + h[2] * h[2]);
  const double rv = r[0] * v[0] + r[1] * v[1] + r[2] * v[2];
  double ev[3];
  for (int j = 0; j < 3; ++j) ev[j] = ((v2 - mu / rn) * r[j] - rv * v[j]) / mu;
  const double e = std::sqrt(ev[0] * ev[0] + ev[1] * ev[1] + ev[2] * ev[2]);
  const double a = 1.0 / (2.0 / rn - v2 / mu);
  const double inc = std::acos(h[2] / hn);
  double node = std::atan2(h[0], -h[1]);
  const double nvec[3] = {std::cos(node), std::sin(node), 0.0};
  double argp = std::atan2((h[0] * (nvec[1] * ev[2] - nvec[2] * ev[1]) + h[1] * (nvec[2] * ev[0] - nvec[0] * ev[2]) +
                            h[2] * (nvec[0] * ev[1] - nvec[1] * ev[0])) / hn,
                           nvec[0] * ev[0] + nvec[1] * ev[1] + nvec[2] * ev[2]);
  double nu = std::atan2((h[0] * (ev[1] * r[2] - ev[2] * r[1]) + h[1] * (ev[2] * r[0] - ev[0] * r[2]) +
                          h[2] * (ev[0] * r[1] - ev[1] * r[0])) / hn,
                         ev[0] * r[0] + ev[1] * r[1] + ev[2] * r[2]);
  const double E = 2.0 * std::atan(std::sqrt((1.0 - e) / (1.0 + e)) * std::tan(nu / 2.0));
  const double M = E - e * std::sin(E);
  auto deg = [](double x) { double d = x / kDeg; d -= 360.0 * std::floor(d / 360.0); return d; };
  row.mean_motion_rev_day = std::sqrt(mu / (a * a * a)) * 86400.0 / kTwoPi;
  row.eccentricity = e;
  row.inclination_deg = inc / kDeg;
  row.raan_deg = deg(node);
  row.arg_pericenter_deg = deg(argp);
  row.mean_anomaly_deg = deg(M);
}

inline bool text_epoch(const flatbuffers::String* s, double& whole, double& frac) {
  return s != nullptr && omm::epoch(s->c_str(), s->size(), whole, frac);
}

inline double minutes_between(double w0, double f0, double w1, double f1) {
  return ((w1 - w0) + (f1 - f0)) * kMinutesPerDay;
}

/// The default fit span (DESIGN 2e.3; the experiment's fit-length study: 48 / 72 h fits cut the 72-96 h
/// error from 2.96 to 0.50 / 0.37 km against 24 h).
constexpr double kDefaultSpanMinutes = 48.0 * 60.0;
/// The validation tail of the span rule: the latest 24 h of the useable data, a day-1 prediction (a 6 h tail
/// scores the fit's short-period error and kept 48 h on 17 of 21 sphere windows: day 3 0.144 km against 0.093 with
/// 24 h; GEO and IGSO keep 48 h with either; diagnostic: sdnap_span_tail_minutes).
inline double& tail_minutes() {
  static double t = 24.0 * 60.0;
  return t;
}

/// SDN-AP's drag regime: perigee height below the density kernel's top (km).
constexpr double kDragRegimeKm = 2500.0;

}  // namespace fitoem
}  // namespace sdnap

namespace sdnap {
namespace fitoem {

/// SDN-AP's B prior from an optional 'prior' $OMM (DESIGN 2e.3, plain or size-prefixed):
/// USER_DEFINED_SDNAP_B and USER_DEFINED_SDNAP_B_SIGMA (m^2/kg). 1 found, 0 none given, -1 a 'prior'
/// payload that is not a verifiable $OMM (the caller refuses).
inline int prior_of_frames(double& b, double& sigma, bool& tau0_rule, double& beff, double& beff_sigma, bool& have_beff) {
  const uint32_t frames = plugin_get_input_count();
  bool found = false;
  for (uint32_t i = 0; i < frames; ++i) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (f == nullptr || f->port_id == nullptr || std::strcmp(f->port_id, "prior") != 0) continue;
    const uint8_t* p = f->payload;
    uint32_t n = f->payload_length;
    if (!plain_view(p, n, "$OMM")) return -1;
    flatbuffers::Verifier verifier(p, n);
    if (!VerifyOMMBuffer(verifier)) return -1;
    const auto* ud = GetOMM(p)->USER_DEFINED_PARAMETERS();
    if (ud == nullptr) continue;
    double bb = 0.0, ss = 0.0, be = 0.0, bs = 0.0;
    bool have_b = false, have_s = false, have_be = false, have_bs = false;
    for (const OMMUserDefinedParameter* q : *ud) {
      if (q == nullptr || q->PARAM_NAME() == nullptr || q->PARAM_VALUE() == nullptr) continue;
      if (std::strcmp(q->PARAM_NAME()->c_str(), "SDNAP_B") == 0) { bb = std::strtod(q->PARAM_VALUE()->c_str(), nullptr); have_b = true; }
      if (std::strcmp(q->PARAM_NAME()->c_str(), "SDNAP_B_SIGMA") == 0) { ss = std::strtod(q->PARAM_VALUE()->c_str(), nullptr); have_s = true; }
      if (std::strcmp(q->PARAM_NAME()->c_str(), "SDNAP_TAU0_RULE") == 0) tau0_rule = std::strtod(q->PARAM_VALUE()->c_str(), nullptr) != 0.0;
      if (std::strcmp(q->PARAM_NAME()->c_str(), "SDNAP_B_EFF") == 0) { be = std::strtod(q->PARAM_VALUE()->c_str(), nullptr); have_be = true; }
      if (std::strcmp(q->PARAM_NAME()->c_str(), "SDNAP_B_EFF_SIGMA") == 0) { bs = std::strtod(q->PARAM_VALUE()->c_str(), nullptr); have_bs = true; }
    }
    // a previous fit's B_eff with its sigma (as fit writes them) is the next arc's prior; a B_eff without one (a
    // launch_set first set: the launch prior, not a determination) is none (it held a 6 h fit at the launch guess:
    // day 1 13.6 against 3.4 km)
    if (have_be && have_bs && bs > 0.0) {
      beff = be;
      beff_sigma = bs;
      have_beff = true;
    }
    if (have_b && have_s && bb > 0.0 && ss > 0.0) {
      b = bb;
      sigma = ss;
      found = true;
    }
  }
  return found ? 1 : 0;
}

/// An Earth set whose fit RMS exceeds this is refused (fit-implausible), km.
constexpr double kImplausibleRmsKm = 100.0;

/// Whether a block's first state (with a velocity) has an osculating eccentricity above `e_min` about the Earth.
inline bool eccentric_block(const ephemerisDataBlock* blk, double e_min) {
  const auto* lines = blk->EPHEMERIS_DATA_LINES();
  if (lines == nullptr || lines->size() == 0) return false;
  const ephemerisDataLine* L = lines->Get(0);
  const double r[3] = {L->X(), L->Y(), L->Z()}, v[3] = {L->X_DOT(), L->Y_DOT(), L->Z_DOT()};
  if (v[0] == 0.0 && v[1] == 0.0 && v[2] == 0.0) return false;
  double el[6];
  return segment::elements_of(segment::mu_of(segment::kEarth), r, v, el) && el[1] > e_min;
}

/// The osculating period (minutes) of a block's first state about the Earth (0 when it carries no velocity).
inline double period_minutes(const ephemerisDataBlock* blk) {
  const auto* lines = blk->EPHEMERIS_DATA_LINES();
  if (lines == nullptr || lines->size() == 0) return 0.0;
  const ephemerisDataLine* L = lines->Get(0);
  const double r[3] = {L->X(), L->Y(), L->Z()}, v[3] = {L->X_DOT(), L->Y_DOT(), L->Z_DOT()};
  double el[6];
  if ((v[0] == 0.0 && v[1] == 0.0 && v[2] == 0.0) || !segment::elements_of(segment::mu_of(segment::kEarth), r, v, el) || !(el[0] > 0.0)) return 0.0;
  return kTwoPi * std::sqrt(el[0] * el[0] * el[0] / segment::mu_of(segment::kEarth)) / 60.0;
}

/// Whether a block's orbit lies beyond the reach of the averaged theories (documented rule): the first state's
/// osculating apocentre about the center beyond 250,000 km for the Earth (the Moon's attraction no longer a small
/// perturbation) or 10,000 km for the Moon (the Earth's tide over 1 % of the lunar gravity), or an open orbit. A block
/// whose first state carries no velocity stays with the averaged theory.
inline bool beyond_reach(const ephemerisDataBlock* blk, int center) {
  const auto* lines = blk->EPHEMERIS_DATA_LINES();
  if (lines == nullptr || lines->size() == 0) return false;
  const ephemerisDataLine* L = lines->Get(0);
  const double r[3] = {L->X(), L->Y(), L->Z()}, v[3] = {L->X_DOT(), L->Y_DOT(), L->Z_DOT()};
  if (v[0] == 0.0 && v[1] == 0.0 && v[2] == 0.0) return false;
  double el[6];
  if (!segment::elements_of(segment::mu_of(center), r, v, el)) return false;
  const double reach = center == segment::kEarth ? 250000.0 : 10000.0;
  return el[1] >= 1.0 || el[0] * (1.0 + el[1]) > reach;
}

}  // namespace fitoem
}  // namespace sdnap

/// SDN-AP 2h.1: the fit of a Moon-centered block (fit_sdnap): ICRF / J2000 axes (GCRF, ICRF, EME2000, J2000 are
/// taken as the J2000 axes at the Moon; the 23 mas frame bias is 0.2 m there), UTC; the fit interval USEABLE_START_TIME
/// to USEABLE_STOP_TIME or the whole block; one $OMM (CENTER_NAME MOON, REFERENCE_FRAME ICRF, J2000-referred mean
/// elements, MEAN_ELEMENT_THEORY SDNAP, USER_DEFINED_SDNAP_REGIME = MOON and the term-set degrees) and one $OBD.
/// One fitted set of a non-geocentric block, as fit_sdnap emits it: the $OMM (ICRF, UTC; the SGP4XP theory code with
/// MEAN_ELEMENT_THEORY SDNAP) and its $OBD.
struct SetOut {
  const char* center = "MOON";
  double whole = 0.0, frac = 0.0;
  double el[6] = {};  ///< MEAN_MOTION rev/day, ECCENTRICITY, INCLINATION, RA_OF_ASC_NODE, ARG_OF_PERICENTER, MEAN_ANOMALY (deg)
  double sma = 0.0, gm = 0.0;  ///< SEMI_MAJOR_AXIS (km) and GM (km^3/s^2) when nonzero
  std::vector<std::pair<std::string, std::string>> user;
  std::string comment, method_source;
  double fit_seconds = 0.0, rms = 0.0;
  uint32_t count = 0;
  void text(const char* name, const char* value) { user.emplace_back(name, value); }
  void number(const char* name, double value) {
    char v[64];
    std::snprintf(v, sizeof v, "%.17g", value);
    user.emplace_back(name, v);
  }
};

static int emit_set(const OEM* oem, const ephemerisDataBlock* blk, const SetOut& o) {
  using namespace sdnap;
  flatbuffers::FlatBufferBuilder fbb(1024);
  char epoch_text[48];
  oem::iso_text(o.whole, o.frac, 0.0, epoch_text, sizeof epoch_text);
  std::vector<flatbuffers::Offset<OMMUserDefinedParameter>> ps;
  for (const auto& kv : o.user) ps.push_back(CreateOMMUserDefinedParameterDirect(fbb, kv.first.c_str(), kv.second.c_str()));
  const auto s_user = fbb.CreateVector(ps);
  const auto s_epoch = fbb.CreateString(epoch_text);
  const auto s_comment = fbb.CreateString(o.comment);
  const auto s_center = fbb.CreateString(o.center);
  const auto s_orig = oem->ORIGINATOR() != nullptr ? fbb.CreateString(oem->ORIGINATOR()->c_str()) : fbb.CreateString("SDN");
  const auto s_frame = CreateRFMDirect(fbb, RFMUnion_CelestialFrameWrapper, CreateCelestialFrameWrapper(fbb, CelestialFrame_ICRF).Union(), 0, "ICRF");
  const CAT* object = blk->OBJECT();
  const uint32_t norad = object != nullptr ? object->NORAD_CAT_ID() : 0;
  const auto s_object_id = object != nullptr && object->OBJECT_ID() != nullptr ? fbb.CreateString(object->OBJECT_ID()->c_str()) : 0;
  const auto s_object_name = object != nullptr && object->OBJECT_NAME() != nullptr ? fbb.CreateString(object->OBJECT_NAME()->c_str()) : 0;
  OMMBuilder b(fbb);
  b.add_ORIGINATOR(s_orig);
  b.add_CENTER_NAME(s_center);
  b.add_REFERENCE_FRAME(s_frame);
  b.add_TIME_SYSTEM(timingStandard_UTC);
  b.add_MEAN_ELEMENT_THEORY(meanElementSource_SDNAP);
  if (norad != 0) b.add_NORAD_CAT_ID(norad);
  if (!s_object_id.IsNull()) b.add_OBJECT_ID(s_object_id);
  if (!s_object_name.IsNull()) b.add_OBJECT_NAME(s_object_name);
  b.add_COMMENT(s_comment);
  b.add_EPOCH(s_epoch);
  if (o.sma != 0.0) b.add_SEMI_MAJOR_AXIS(o.sma);
  b.add_MEAN_MOTION(o.el[0]);
  b.add_ECCENTRICITY(o.el[1]);
  b.add_INCLINATION(o.el[2]);
  b.add_RA_OF_ASC_NODE(o.el[3]);
  b.add_ARG_OF_PERICENTER(o.el[4]);
  b.add_MEAN_ANOMALY(o.el[5]);
  if (o.gm != 0.0) b.add_GM(o.gm);
  b.add_USER_DEFINED_PARAMETERS(s_user);
  FinishOMMBuffer(fbb, b.Finish());
  if (plugin_push_output("elements", "OMM.fbs", "$OMM", fbb.GetBufferPointer(), fbb.GetSize()) < 0) {
    plugin_set_error("output-failed", "The $OMM could not be emitted.");
    return 3;
  }
  flatbuffers::FlatBufferBuilder ob(512);
  char end_text[48];
  oem::iso_text(o.whole, o.frac, o.fit_seconds / 60.0, end_text, sizeof end_text);
  const auto o_start = ob.CreateString(epoch_text);
  const auto o_end = ob.CreateString(end_text);
  const auto o_source = ob.CreateString(o.method_source);
  OBDBuilder d(ob);
  if (norad != 0) d.add_SAT_NO(norad);
  d.add_START_TIME(o_start);
  d.add_END_TIME(o_end);
  d.add_METHOD(odMethod_BATCH_LEAST_SQUARES);
  d.add_METHOD_SOURCE(o_source);
  d.add_FIT_SPAN(o.fit_seconds / 86400.0);
  d.add_WRMS(o.rms);
  d.add_NUM_ACCEPTED_OBS(static_cast<int32_t>(o.count));
  FinishOBDBuffer(ob, d.Finish());
  if (plugin_push_output("determination", "OBD.fbs", "$OBD", ob.GetBufferPointer(), ob.GetSize()) < 0) {
    plugin_set_error("output-failed", "The $OBD could not be emitted.");
    return 3;
  }
  return 0;
}

/// The states of an inertial block (ICRF / GCRF / EME2000 / J2000 axes, all taken as the DE440 ICRF axes; UTC)
/// inside USEABLE_START_TIME .. USEABLE_STOP_TIME: times (s from the first), positions (km) and velocities (km/s;
/// central differences of the positions when a block carries none) and the first epoch. 0 or a named refusal (3).
static int read_inertial_block(const ephemerisDataBlock* blk, const char* who, std::vector<double>& t, std::vector<double>& pos,
                               std::vector<double>& vel, double& e_w, double& e_f) {
  using namespace sdnap;
  char why[200];
  const oem::Axes axes = oem::axes_of(blk->REFERENCE_FRAME());
  if (axes == oem::Axes::Undeclared) {
    std::snprintf(why, sizeof why, "A %s block declares no REFERENCE_FRAME; the fit assumes none.", who);
    plugin_set_error("reference-frame-undeclared", why);
    return 3;
  }
  if (axes != oem::Axes::Gcrf && axes != oem::Axes::Eme2000) {
    std::snprintf(why, sizeof why, "%s blocks are fitted in ICRF or J2000 axes.", who);
    plugin_set_error("unsupported-frame", why);
    return 3;
  }
  if (blk->TIME_SYSTEM() != timingStandard_UTC) {
    plugin_set_error("unsupported-time-system", "Only UTC ephemerides are fitted.");
    return 3;
  }
  const auto* lines = blk->EPHEMERIS_DATA_LINES();
  const uint32_t n = lines == nullptr ? 0 : lines->size();
  double us_w = 0, us_f = 0, ue_w = 0, ue_f = 0;
  const bool has_start = blk->USEABLE_START_TIME() != nullptr && fitoem::text_epoch(blk->USEABLE_START_TIME(), us_w, us_f);
  const bool has_stop = blk->USEABLE_STOP_TIME() != nullptr && fitoem::text_epoch(blk->USEABLE_STOP_TIME(), ue_w, ue_f);
  bool have_epoch = false, have_velocity = false;
  for (uint32_t k = 0; k < n; ++k) {
    const ephemerisDataLine* L = lines->Get(k);
    double w, f;
    if (!fitoem::text_epoch(L->EPOCH(), w, f)) {
      plugin_set_error("invalid-oem", "A state has no readable EPOCH.");
      return 3;
    }
    if (has_start && fitoem::minutes_between(us_w, us_f, w, f) < 0.0) continue;
    if (has_stop && fitoem::minutes_between(ue_w, ue_f, w, f) > 0.0) continue;
    if (!have_epoch) {
      e_w = w;
      e_f = f;
      have_epoch = true;
    }
    t.push_back(fitoem::minutes_between(e_w, e_f, w, f) * 60.0);
    pos.push_back(L->X());
    pos.push_back(L->Y());
    pos.push_back(L->Z());
    vel.push_back(L->X_DOT());
    vel.push_back(L->Y_DOT());
    vel.push_back(L->Z_DOT());
    have_velocity = have_velocity || L->X_DOT() != 0.0 || L->Y_DOT() != 0.0 || L->Z_DOT() != 0.0;
  }
  if (t.size() < 8) {
    plugin_set_error("too-few-states", "The fit interval holds fewer than 8 states.");
    return 3;
  }
  for (size_t k = 1; k < t.size(); ++k)
    if (!(t[k] > t[k - 1])) {
      plugin_set_error("invalid-oem", "The block's states do not ascend in time.");
      return 3;
    }
  if (!have_velocity) {
    const size_t m = t.size();
    for (size_t k = 0; k < m; ++k) {
      const size_t a = k == 0 ? 0 : k - 1, b = k + 1 == m ? k : k + 1;
      for (int c = 0; c < 3; ++c) vel[3 * k + c] = (pos[3 * b + c] - pos[3 * a + c]) / (t[b] - t[a]);
    }
  }
  return 0;
}

static int lunar_fit_block(const OEM* oem, const ephemerisDataBlock* blk) {
  using namespace sdnap;
  std::vector<double> t, pos, vel;
  double e_w = 0, e_f = 0;
  if (const int rc = read_inertial_block(blk, "Moon-centered", t, pos, vel, e_w, e_f)) return rc;
  const double v0[3] = {vel[0], vel[1], vel[2]};
  lunar::Sat probe;
  probe.et0 = lunar::et_of(e_w, e_f);
  double y0[6];
  if (!std::isfinite(probe.et0) || !lunar::j2000_to_pa(probe.et0, probe.M) || !lunar::elements_of_state(probe, pos.data(), v0, y0)) {
    plugin_set_error("element-set-refused", "The block's epoch is outside the embedded lunar orientation span or its first state is not a bound Moon orbit.");
    return 3;
  }
  lunar::Sat s;
  if (!lunar::init(s, e_w, e_f, y0)) {
    plugin_set_error("element-set-refused", "The lunar set could not be initialized.");
    return 3;
  }
  double rms = lunar::fit(s, t.data(), pos.data(), static_cast<int>(t.size()), 25);
  if (!(rms >= 0.0)) {
    plugin_set_error("fit-failed", "The fit did not converge on the block.");
    return 3;
  }
  // A maneuver inside the arc, from the residual structure (documented rule): each half fitted on its own; when the
  // whole arc's RMS exceeds 3 x the cleaner half's RMS + 0.05 km, one set does not hold across the arc. The burn's
  // epoch is then the arg max of the six-element GLR on the whole-arc set's residuals, profiled over the epoch
  // elements (lunar::locate_burn, at least 2 h of data before and 6 h after it), and the joint segment fit estimates the
  // pre-burn set, AGOM and the impulse over the whole arc (lunar::joint_fit); its post-burn set is the result when its
  // RMS is within max(2 x, 0.05 km more than) the cleaner half's. Otherwise the set is refitted on the longest latest
  // segment (the last 3/4, 2/3, 1/2, 1/3 or 1/4 of the arc, at least 6 h) within that bound. Either carries
  // USER_DEFINED_SDNAP_MANEUVER_BEFORE_SECONDS (the post-burn set's epoch from the arc's first epoch); with neither the
  // block is refused by name (maneuver-suspected: the set would have to cross the maneuver).
  double maneuver_before = -1.0;
  double joint_dv[3] = {0, 0, 0}, joint_lambda = -1.0;
  size_t fitted_states = t.size();
  double fitted_seconds = t.back() - t.front();
  if (t.back() - t.front() >= 8.0 * 3600.0) {
    auto fit_part = [&](size_t from, size_t to, lunar::Sat& out) -> double {
      std::vector<double> tp(t.begin() + from, t.begin() + to), pp(pos.begin() + 3 * from, pos.begin() + 3 * to);
      const double t0 = tp.front();
      for (double& x : tp) x -= t0;
      double y[6];
      if (!lunar::mean_at(s, t0, y)) return -1.0;
      out = s;
      out.epoch_frac = e_f + t0 / 86400.0;
      out.et0 = s.et0 + t0;
      for (int j = 0; j < 6; ++j) out.y0[j] = y[j];
      lunar::build_terms(out);
      return lunar::fit(out, tp.data(), pp.data(), static_cast<int>(tp.size()), 15);
    };
    const size_t half = t.size() / 2;
    lunar::Sat sa, sb;
    const double ra = fit_part(0, half, sa), rb = fit_part(half, t.size(), sb);
    const double ref = ra >= 0.0 && rb >= 0.0 ? std::fmin(ra, rb) : -1.0;
    bool joint = false;
    if (ref >= 0.0 && rms > 3.0 * ref + 0.05) {
      lunar::Burn burn;
      if (lunar::locate_burn(s, t.data(), pos.data(), static_cast<int>(t.size()), 2.0 * 3600.0, 6.0 * 3600.0, burn)) {
        lunar::Sat pre = s, post;
        double dv[3] = {burn.dv[0], burn.dv[1], burn.dv[2]};
        const double jr = lunar::joint_fit(pre, burn.t_b, t.data(), pos.data(), static_cast<int>(t.size()), dv, post, 6);
        if (jr >= 0.0 && jr <= std::fmax(2.0 * ref, ref + 0.05)) {
          joint = true;
          s = post;
          rms = jr;
          maneuver_before = burn.t_b;
          e_f += burn.t_b / 86400.0;
          for (int c = 0; c < 3; ++c) joint_dv[c] = dv[c];
          joint_lambda = burn.lambda;
        }
      }
    }
    if (!joint && ref >= 0.0 && rms > 3.0 * ref + 0.05) {
      const size_t starts[5] = {t.size() / 4, t.size() / 3, t.size() / 2, (2 * t.size()) / 3, (3 * t.size()) / 4};
      int pick = -1;
      lunar::Sat seg;
      double seg_rms = -1.0;
      for (int c = 0; c < 5 && pick < 0; ++c) {
        if (t.back() - t[starts[c]] < 6.0 * 3600.0) break;
        lunar::Sat trial;
        const double rr = starts[c] == half ? rb : fit_part(starts[c], t.size(), trial);
        if (starts[c] == half) trial = sb;
        if (rr >= 0.0 && rr <= std::fmax(2.0 * ref, ref + 0.05)) {
          pick = c;
          seg = trial;
          seg_rms = rr;
        }
      }
      if (pick < 0) {
        char why[220];
        std::snprintf(why, sizeof why, "A maneuver is likely inside the arc (fit RMS %.3f km against %.3f and %.3f km for its halves) and no latest segment of 6 h holds; fit the segments apart.", rms, ra, rb);
        plugin_set_error("maneuver-suspected", why);
        return 3;
      }
      const size_t from = starts[pick];
      s = seg;
      rms = seg_rms;
      maneuver_before = t[from];
      e_f += t[from] / 86400.0;
      std::vector<double> tb(t.begin() + from, t.end());
      for (double& x : tb) x -= maneuver_before;
      t.swap(tb);
      fitted_states = t.size();
      fitted_seconds = t.back() - t.front();
    }
  }
  double nn, e, inc, node, argp, M;
  lunar::j2000_elements(s, nn, e, inc, node, argp, M);
  SetOut o;
  o.center = "MOON";
  o.whole = e_w;
  o.frac = e_f;
  const double deg = 180.0 / kPi;
  o.el[0] = nn * 86400.0 / kTwoPi; o.el[1] = e; o.el[2] = inc * deg; o.el[3] = node * deg; o.el[4] = argp * deg; o.el[5] = M * deg;
  char comment[480];
  int cl = std::snprintf(comment, sizeof comment,
                "SDN-AP fit: theory SDN-AP, Moon-centered (2h.1: GRGM660PRIM averaged to degree %d, short-periodics to degree %d, SRP with the Moon's shadow, AGOM %.5f m^2/kg); %u states fitted; fit RMS %.6f km",
                lunar::gravity_degree(), lunar::short_degree(), s.agom, static_cast<unsigned>(fitted_states), rms);
  if (joint_lambda >= 0.0 && cl > 0 && cl < static_cast<int>(sizeof comment))
    std::snprintf(comment + cl, sizeof comment - cl, "; joint segment fit across a maneuver %.3f h into the arc (GLR epoch, Lambda %.1f): dv U %.2f V %.2f W %.2f mm/s",
                  maneuver_before / 3600.0, joint_lambda, 1e6 * joint_dv[0], 1e6 * joint_dv[1], 1e6 * joint_dv[2]);
  o.comment = comment;
  o.method_source = "sdn-ap-propagator fit (THEORY SDNAP): Levenberg-Marquardt on Moon-centered J2000 position residuals, unit weights, km; theory SDN-AP, Moon-centered (2h.1)";
  o.text("SDNAP_REGIME", "MOON");
  o.number("SDNAP_LUNAR_DEGREE", lunar::gravity_degree());
  o.number("SDNAP_LUNAR_SHORT_DEGREE", lunar::short_degree());
  o.number("SDNAP_LUNAR_ECC_ORDER", lunar::eccentricity_order());
  o.number("SDNAP_AGOM", s.agom);
  if (maneuver_before >= 0.0) o.number("SDNAP_MANEUVER_BEFORE_SECONDS", maneuver_before);
  o.fit_seconds = fitted_seconds;
  o.count = static_cast<uint32_t>(fitted_states);
  o.rms = rms;
  return emit_set(oem, blk, o);
}

/// SDN-AP 2h.2 / 2h.3 / 2h.5: the segment-set fit of a cislunar (Earth- or Moon-centered, beyond the averaged
/// theories' reach) or heliocentric block: the latest segment by the documented rule (segment::choose_segment, the
/// set's epoch carried past a detected burn or thrust change), one $OMM (CENTER_NAME the block's, REFERENCE_FRAME
/// ICRF, the epoch state's osculating elements with SEMI_MAJOR_AXIS and GM, MEAN_ELEMENT_THEORY SDNAP,
/// USER_DEFINED_SDNAP_REGIME = CISLUNAR or HELIO and the force-model parameters) and one $OBD.
static int segment_fit_block(const OEM* oem, const ephemerisDataBlock* blk, int center) {
  using namespace sdnap;
  std::vector<double> t, pos, vel;
  double e_w = 0, e_f = 0;
  const char* who = center == segment::kSun ? "Sun-centered" : center == segment::kMoon ? "Moon-centered" : "Earth-centered cislunar";
  if (const int rc = read_inertial_block(blk, who, t, pos, vel, e_w, e_f)) return rc;
  const int n = static_cast<int>(t.size());
  double r0[3], v0[3], rms = -1.0, extra[7] = {0, 0, 0, 0, 0, 0, 0};
  int first = 0;
  std::vector<double> table;
  if (center == segment::kSun) {
    helio::Sat sat;
    const double et_arc = lunar::et_of(e_w, e_f);
    rms = helio::fit_cruise(et_arc, t.data(), pos.data(), vel.data(), n, t.back(), 13, true, sat, first, table);
    if (rms == -3.0) {
      plugin_set_error("element-set-refused", "The block lies outside the embedded DE440 planet span (2012-2029).");
      return 3;
    }
    if (rms == -5.0) {
      plugin_set_error("inside-sphere-of-influence", "The block ends inside a planet's sphere of influence; a planet-centered set is not fitted here (SUN sets end at the sphere's edge).");
      return 3;
    }
    for (int c = 0; c < 3; ++c) { r0[c] = sat.r0[c]; v0[c] = sat.v0[c]; extra[1 + c] = sat.rtn[c]; extra[4 + c] = sat.rtn_rate[c]; }
    extra[0] = sat.beta;
  } else {
    const double et_arc = lunar::et_of(e_w, e_f);
    cislunar::Seg base, seg;
    base.moon = center == segment::kMoon;
    if (base.moon) {
      double Mpa[3][3];
      if (!std::isfinite(et_arc) || !lunar::j2000_to_pa(et_arc, Mpa)) {
        plugin_set_error("element-set-refused", "The block's epoch is outside the embedded lunar orientation and ephemeris span (2022-2029).");
        return 3;
      }
      for (int c = 0; c < 3; ++c) base.pole[c] = Mpa[2][c];
    }
    rms = cislunar::fit_segmented(base, et_arc, t.data(), pos.data(), vel.data(), n, t.front(), t.back(), 7, true, seg, first);
    if (rms == -3.0) {
      plugin_set_error("element-set-refused", "The block lies outside the embedded DE440 Moon and Sun span (2022-2029).");
      return 3;
    }
    for (int c = 0; c < 3; ++c) { r0[c] = seg.r0[c]; v0[c] = seg.v0[c]; }
    extra[0] = seg.agom;
  }
  if (!(rms >= 0.0)) {
    plugin_set_error("fit-failed", "The fit did not converge on the block.");
    return 3;
  }
  const double mu = segment::mu_of(center);
  double el[6];
  if (!segment::elements_of(mu, r0, v0, el)) {
    plugin_set_error("element-set-refused", "The fitted state has no osculating elements (a parabolic or degenerate state).");
    return 3;
  }
  SetOut o;
  o.center = segment::name_of(center);
  o.whole = e_w;
  o.frac = e_f + t[first] / 86400.0;
  const double deg = 180.0 / kPi;
  o.el[0] = std::sqrt(mu / std::fabs(el[0] * el[0] * el[0])) * 86400.0 / kTwoPi;
  o.el[1] = el[1]; o.el[2] = el[2] * deg; o.el[3] = el[3] * deg; o.el[4] = el[4] * deg; o.el[5] = el[5] * deg;
  o.sma = el[0];
  o.gm = mu;
  char comment[360];
  if (center == segment::kSun)
    std::snprintf(comment, sizeof comment,
                  "SDN-AP fit: theory SDN-AP, heliocentric segment (2h.3: mu_Sun (1 - beta), beta %.3e; RTN acceleration a0 + a1 t); %d states fitted over %.1f h (segment start %.1f h into the %.1f h arc); fit RMS %.6f km",
                  extra[0], n - first, (t.back() - t[first]) / 3600.0, t[first] / 3600.0, t.back() / 3600.0, rms);
  else
    std::snprintf(comment, sizeof comment,
                  "SDN-AP fit: theory SDN-AP, cislunar segment about the %s (2h.2: DE440 %s and Sun, J2, SRP AGOM %.5f m^2/kg); %d states fitted over %.1f h (segment start %.1f h into the %.1f h arc); fit RMS %.6f km",
                  center == segment::kMoon ? "Moon" : "Earth", center == segment::kMoon ? "Earth" : "Moon", extra[0], n - first, (t.back() - t[first]) / 3600.0,
                  t[first] / 3600.0, t.back() / 3600.0, rms);
  o.comment = comment;
  o.method_source = center == segment::kSun
                        ? "sdn-ap-propagator fit (THEORY SDNAP): Levenberg-Marquardt on Sun-centered ICRF position residuals, unit weights, km; theory SDN-AP, heliocentric segment (2h.3)"
                        : "sdn-ap-propagator fit (THEORY SDNAP): Levenberg-Marquardt on ICRF position residuals, unit weights, km; theory SDN-AP, cislunar segment (2h.2)";
  o.text("SDNAP_REGIME", center == segment::kSun ? "HELIO" : "CISLUNAR");
  if (center == segment::kSun) {
    o.number("SDNAP_BETA", extra[0]);
    o.number("SDNAP_RTN_R", extra[1]);
    o.number("SDNAP_RTN_T", extra[2]);
    o.number("SDNAP_RTN_N", extra[3]);
    o.number("SDNAP_RTN_RATE_R", extra[4]);
    o.number("SDNAP_RTN_RATE_T", extra[5]);
    o.number("SDNAP_RTN_RATE_N", extra[6]);
  } else {
    o.number("SDNAP_AGOM", extra[0]);
  }
  if (first > 0) o.number("SDNAP_MANEUVER_BEFORE_SECONDS", t[first]);
  o.number("SDNAP_ARC_END_SECONDS", t.back() - t[first]);
  o.fit_seconds = t.back() - t[first];
  o.count = static_cast<uint32_t>(n - first);
  o.rms = rms;
  return emit_set(oem, blk, o);
}

/// The fit of every 'ephemeris' block: SGP4XP (theory 4, `fit`) or SDN-AP (theory 16, `fit_sdnap`).
static int fit_blocks(bool sdnap_mode) {
  using namespace sdnap;
  plugin_reset_output_state();
  bool have_b_prior = false, tau0_rule = false, have_beff_prior = false;
  double b_prior = 0.0, b_prior_sigma = 0.0, beff_prior = 0.0, beff_prior_sigma = 0.0;
  if (sdnap_mode) {
    // the environment of this invocation (FFM's reading), then the B prior
    bool have_spw = false, have_dcl = false;
    const int st = envload::apply_frames(have_spw, have_dcl);
    if (st != 0) return st;
    const int prior = fitoem::prior_of_frames(b_prior, b_prior_sigma, tau0_rule, beff_prior, beff_prior_sigma, have_beff_prior);
    if (prior < 0) {
      plugin_set_error("invalid-prior", "A 'prior' payload is not a verifiable SDS $OMM.");
      return 3;
    }
    have_b_prior = prior > 0;
  }
  const pcf::Options& po = pcf::options();
  if (po.drag_prior_set && have_beff_prior)
    return pcf::refuse("FIT.DRAG_PRIOR", "a 'prior' $OMM gives the B_eff prior (USER_DEFINED_SDNAP_B_EFF)");
  const uint32_t frames = plugin_get_input_count();
  uint32_t blocks_done = 0;
  for (uint32_t fi = 0; fi < frames; ++fi) {
    const plugin_input_frame_t* f = plugin_get_input_frame(fi);
    if (f == nullptr || f->port_id == nullptr || std::strcmp(f->port_id, "ephemeris") != 0) continue;
    const uint8_t* payload = f->payload;
    uint32_t payload_length = f->payload_length;
    if (!plain_view(payload, payload_length, "$OEM")) {
      plugin_set_error("invalid-oem", "An 'ephemeris' payload is not an SDS $OEM (plain or size-prefixed).");
      return 3;
    }
    flatbuffers::Verifier verifier(payload, payload_length);
    if (!VerifyOEMBuffer(verifier)) {
      plugin_set_error("invalid-oem", "An 'ephemeris' $OEM does not verify.");
      return 3;
    }
    const OEM* oem = GetOEM(payload);
    const auto* blocks = oem->EPHEMERIS_DATA_BLOCK();
    if (blocks == nullptr) continue;
    for (const ephemerisDataBlock* blk : *blocks) {
      // the block's center: Earth (the theories here are geocentric; a Moon-centered or heliocentric block is
      // refused by name, never read as geocentric)
      if (blk->CENTER_NAME() != nullptr && blk->CENTER_NAME()->size() > 0 && !oem::same_text(blk->CENTER_NAME()->c_str(), "EARTH")) {
        const bool moon = oem::same_text(blk->CENTER_NAME()->c_str(), "MOON"), sun = oem::same_text(blk->CENTER_NAME()->c_str(), "SUN");
        if (sdnap_mode && (moon || sun)) {
          // the Moon: the averaged theory (2h.1) for orbits inside its reach, a cislunar segment beyond (2h.2)
          const int rc = sun ? segment_fit_block(oem, blk, segment::kSun)
                             : fitoem::beyond_reach(blk, segment::kMoon) ? segment_fit_block(oem, blk, segment::kMoon) : lunar_fit_block(oem, blk);
          if (rc != 0) return rc;
          ++blocks_done;
          continue;
        }
        plugin_set_error("unsupported-center", sdnap_mode ? "An 'ephemeris' block is centered neither on the Earth, the Moon nor the Sun (CENTER_NAME)."
                                                          : "An 'ephemeris' block is not centered on the Earth (CENTER_NAME); fit (SGP4XP) is geocentric, fit_sdnap also fits Moon- and Sun-centered blocks.");
        return 3;
      }
      if (sdnap_mode && fitoem::beyond_reach(blk, segment::kEarth)) {
        // an Earth orbit reaching the Moon's distance: a cislunar segment (2h.2), not the near-Earth theory
        const int rc = segment_fit_block(oem, blk, segment::kEarth);
        if (rc != 0) return rc;
        ++blocks_done;
        continue;
      }
      // the block's declared axes: the enumeration, the coordinate system or REFERENCE_FRAME.NAME; never assumed
      const oem::Axes axes = oem::axes_of(blk->REFERENCE_FRAME());
      if (axes == oem::Axes::Undeclared) {
        plugin_set_error("reference-frame-undeclared",
                         "An 'ephemeris' block declares no REFERENCE_FRAME (enumeration, coordinate system or NAME); the fit assumes none.");
        return 3;
      }
      if (axes == oem::Axes::Conflict) {
        plugin_set_error("reference-frame-conflict", "An 'ephemeris' block's REFERENCE_FRAME enumeration and NAME disagree.");
        return 3;
      }
      if (axes == oem::Axes::Other) {
        plugin_set_error("unsupported-frame",
                         "TEME, GCRF (ICRF), EME2000 (J2000) and Earth-fixed (ITRF, ECEF, WGS84) ephemerides are fitted.");
        return 3;
      }
      const bool earth_fixed = axes == oem::Axes::EarthFixed;
      const bool eme2000 = axes == oem::Axes::Eme2000;
      const bool gcrf = axes == oem::Axes::Gcrf || eme2000;
      double bias[3][3];
      if (eme2000) frames::frame_bias(bias);
      if (blk->TIME_SYSTEM() != timingStandard_UTC) {
        plugin_set_error("unsupported-time-system", "Only UTC ephemerides are fitted.");
        return 3;
      }
      const auto* lines = blk->EPHEMERIS_DATA_LINES();
      const uint32_t n = lines == nullptr ? 0 : lines->size();
      if (n < 8) {
        plugin_set_error("too-few-states", "A block needs at least 8 states.");
        return 3;
      }
      std::vector<fitoem::Sample> all(n);
      for (uint32_t k = 0; k < n; ++k) {
        const ephemerisDataLine* L = lines->Get(k);
        fitoem::Sample& s = all[k];
        if (!fitoem::text_epoch(L->EPOCH(), s.whole, s.frac)) {
          plugin_set_error("invalid-oem", "A state has no readable EPOCH.");
          return 3;
        }
        s.r[0] = L->X(); s.r[1] = L->Y(); s.r[2] = L->Z();
        s.v[0] = L->X_DOT(); s.v[1] = L->Y_DOT(); s.v[2] = L->Z_DOT();
        s.has_v = s.v[0] != 0.0 || s.v[1] != 0.0 || s.v[2] != 0.0;
        if (eme2000) {
          // GCRF = B^T EME2000 (the IAU 2006 frame bias), then as GCRF
          const double r0[3] = {s.r[0], s.r[1], s.r[2]}, v0[3] = {s.v[0], s.v[1], s.v[2]};
          frames::apply_transpose(bias, r0, s.r);
          frames::apply_transpose(bias, v0, s.v);
        }
        if (gcrf) {
          // TEME = R3(GAST06 - GMST82) NPB06 GCRF (gcrf.inc; IAU 2006/2000A through the pinned ERFA).
          double m[3][3];
          if (frames::gcrf_to_teme(s.whole, s.frac, m) < 0) {
            plugin_set_error("invalid-oem", "A GCRF state's UTC is outside ERFA's calendar.");
            return 3;
          }
          const double r0[3] = {s.r[0], s.r[1], s.r[2]}, v0[3] = {s.v[0], s.v[1], s.v[2]};
          frames::apply(m, r0, s.r);
          frames::apply(m, v0, s.v);
        } else if (earth_fixed) {
          // TEME = R3(-GMST82) (pseudo-)Earth-fixed; UT1 = UTC and the pole at its mean position, as without $EOP.
          const double th = gmst(s.whole, s.frac);
          const double c = std::cos(th), sn = std::sin(th);
          const double x = s.r[0], y = s.r[1];
          const double vx = s.v[0] - kEarthRotationRate * y, vy = s.v[1] + kEarthRotationRate * x;
          s.r[0] = c * x - sn * y;
          s.r[1] = sn * x + c * y;
          s.v[0] = c * vx - sn * vy;
          s.v[1] = sn * vx + c * vy;
        }
      }
      // fit interval
      double us_w = all[0].whole, us_f = all[0].frac, ue_w = all[n - 1].whole, ue_f = all[n - 1].frac;
      bool held_out_rule = false;
      const bool start_given = blk->USEABLE_START_TIME() != nullptr && fitoem::text_epoch(blk->USEABLE_START_TIME(), us_w, us_f);
      if (blk->USEABLE_STOP_TIME() != nullptr) held_out_rule = fitoem::text_epoch(blk->USEABLE_STOP_TIME(), ue_w, ue_f);
      if (po.has_holdout) {
        // $PCF FIT.HOLDOUT_HOURS: the fit ends that long before the data does (the block's own USEABLE_STOP_TIME
        // would say otherwise: refused by name)
        if (held_out_rule) return pcf::refuse("FIT.HOLDOUT_HOURS", "the ephemeris block gives its USEABLE_STOP_TIME");
        ue_w = all[n - 1].whole;
        ue_f = all[n - 1].frac - po.holdout_h / 24.0;
        held_out_rule = po.holdout_h > 0.0;
      }
      // DESIGN 2e.3 fit span, the documented rule: USEABLE_START_TIME to the end of the useable interval when it is
      // given; otherwise the latest 48 h, extended to 72 h and then 120 h while the drag is stable, judged on the
      // data: an extension is kept when its fit RMS is at most max(1.2 x, 0.02 km more than) the 48 h fit's (one
      // set of drag parameters holds over the longer arc); the first that is not, or that the data cannot cover,
      // ends the extension. Measured: 48 / 72 / 120 h arcs cut the laser-ranged spheres' day 3 from 0.30 (24 h) to
      // 0.12 / 0.11 / 0.07 km and Starlink's 72-96 h error from 0.96 to 0.225 / 0.122 km.
      uint32_t last_useable = n - 1;
      while (held_out_rule && last_useable > 0 &&
             fitoem::minutes_between(ue_w, ue_f, all[last_useable].whole, all[last_useable].frac) > 0.0) --last_useable;
      struct Pass {
        std::vector<double> t_fit, r_fit, t_out, r_out;
        uint32_t first = 0;
        fitoem::Sample e0{};
        ElementRow row{};
        fit::Options opt{};
        fit::Result res{};
        int iterations = 0;
        double first_pass_rms = 0.0;
        double variances[fit::kMaxParams] = {};
        bool tau0_selected = false;
      };
      // span_minutes ending at all[end_index]; the states after it held out (the validation tail)
      auto run_pass = [&](double span_minutes, Pass& P, uint32_t end_index) -> int {
        const double saved_w = ue_w, saved_f = ue_f;
        const bool saved_rule = held_out_rule;
        if (end_index < last_useable) {
          ue_w = all[end_index].whole;
          ue_f = all[end_index].frac;
          held_out_rule = true;
        }
        struct Restore {
          double& w; double& f; bool& r; double w0, f0; bool r0;
          ~Restore() { w = w0; f = f0; r = r0; }
        } restore{ue_w, ue_f, held_out_rule, saved_w, saved_f, saved_rule};
        if (!start_given) {
          us_w = all[end_index].whole;
          us_f = all[end_index].frac - span_minutes / kMinutesPerDay;
        }
        uint32_t first = 0;
        while (first < n && fitoem::minutes_between(us_w, us_f, all[first].whole, all[first].frac) < (start_given ? 0.0 : -1e-6)) ++first;
        std::vector<double> t_fit, r_fit, t_out, r_out;
        fitoem::Sample e0 = all[first < n ? first : 0];
        e0.frac = std::round(e0.frac * 1e8) / 1e8;  // the two-line text's epoch resolution
        for (uint32_t k = first; k < n; ++k) {
          const double t = fitoem::minutes_between(e0.whole, e0.frac, all[k].whole, all[k].frac);
          const bool in_fit = !held_out_rule || fitoem::minutes_between(ue_w, ue_f, all[k].whole, all[k].frac) <= 0.0;
          std::vector<double>& tt = in_fit ? t_fit : t_out;
          std::vector<double>& rr = in_fit ? r_fit : r_out;
          tt.push_back(t);
          rr.insert(rr.end(), all[k].r, all[k].r + 3);
        }
        if (t_fit.size() < 8) return 1;
        // starting set from the first state (velocity from the neighbors when absent)
        fitoem::Sample s0 = e0;
        if (!s0.has_v && first + 1 < n) {
          const fitoem::Sample& s1 = all[first + 1];
          const double dt = fitoem::minutes_between(s0.whole, s0.frac, s1.whole, s1.frac) * 60.0;
          for (int j = 0; j < 3; ++j) s0.v[j] = (s1.r[j] - s0.r[j]) / dt;
        }
        ElementRow row{};
        row.epoch_jd_whole = e0.whole;
        row.epoch_jd_frac = e0.frac;
        row.theory = sdnap_mode ? kTheorySdnAp : kTheorySgp4Xp;
        fitoem::start_row(s0, row);
        if (sdnap_mode) row.arc_end_min = t_fit.back();  // DESIGN 2c: g(t) = 1 on the fit arc
        // the arc grown from two revolutions to the whole fit interval
        fit::Options opt{};
        opt.max_iterations = 40;
        fit::Result res{};
        int iterations = 0;
        const double period = kMinutesPerDay / row.mean_motion_rev_day;
        size_t short_n = 0;
        while (short_n < t_fit.size() && t_fit[short_n] <= 2.0 * period) ++short_n;
        if (short_n >= 8 && short_n < t_fit.size()) {
          res = fit::run(row, t_fit.data(), r_fit.data(), static_cast<int>(short_n), opt);
          iterations += res.iterations;
        }
        // SDN-AP: the drag and the empirical terms act only where the density does (perigee below the
        // kernel's 2500 km top): above it B_eff and tau stay zero, so SRP is carried by AGOM, not aliased into
        // tauc/taus (GNSS: AGOM fell to ~0 with tau free and the day-3 error grew past XP's)
        const double a_er = std::pow(xpt::kKe / (row.mean_motion_rev_day * kTwoPi / kMinutesPerDay), kX2o3);
        const bool drag_regime = !sdnap_mode || (a_er * (1.0 - row.eccentricity) - 1.0) * xpt::kRe < po.drag_regime_km;
        if (!drag_regime) row.bterm = 0.0;
        opt.fit_drag = drag_regime ? 1 : 0;
        // DESIGN 2e.3: a previous set's B_eff carried as the prior (a 'prior' $OMM with USER_DEFINED_SDNAP_B_EFF and
        // _B_EFF_SIGMA, as fit_sdnap writes them), its sigma floored at 10 % of the value (the random walk between
        // arcs); without one a loose 0 +- 1 m^2/kg for conditioning only
        opt.drag_prior = po.drag_prior_set ? po.drag_prior_mean : sdnap_mode && have_beff_prior ? beff_prior : 0.0;
        // SDN-AP: B_eff free and signed (DESIGN 2b.6; a loose prior only for conditioning); SGP4XP: a weak prior
        opt.drag_sigma = po.drag_prior_set ? po.drag_prior_sigma
                         : !sdnap_mode ? fitoem::kBtermPriorSigma
                         : have_beff_prior ? std::fmax(std::fmax(beff_prior_sigma, 0.1 * std::fabs(beff_prior)), 1e-5) : 1.0;
        // grown by threes in between (2, 6, 18 ... revolutions), each stage from the last: from a drag-free start the
        // whole arc of a fast decay lies far outside the linear range (an e 0.03 orbit at 175 km loses 15 km of a in
        // 48 h, some 2,000 km along-track), and the single jump stalled on a wrong minimum (fit RMS 7 to 9 km)
        for (double span = 6.0 * period;; span *= 3.0) {
          size_t k = 0;
          while (k < t_fit.size() && t_fit[k] <= span) ++k;
          if (k >= t_fit.size()) break;
          if (k < 8) continue;
          ElementRow trial = row;
          const fit::Result stage = fit::run(trial, t_fit.data(), r_fit.data(), static_cast<int>(k), opt);
          iterations += stage.iterations;
          if (stage.status >= 0) row = trial;
        }
        res = fit::run(row, t_fit.data(), r_fit.data(), static_cast<int>(t_fit.size()), opt);
        iterations += res.iterations;
        const double first_pass_rms = res.rms_km;
        opt.fit_agom = 1;
        opt.agom_prior = po.srp_prior_mean;  // $PCF FIT.SRP_PRIOR, default 0 +- 0.05 m^2/kg
        opt.agom_sigma = po.srp_prior_sigma;
        double variances[fit::kMaxParams] = {};
        bool tau0_selected = false;
        if (sdnap_mode) {
          // DESIGN 2c: tauc and taus in the drag regime with the Gauss-Markov decay after the arc; above it they
          // carry SRP's once-per-revolution part (with AGOM) and are held after the arc (GNSS, 51 windows, day 3:
          // 0.175 km against 0.217 with them off and 0.241 decaying; SGP4XP 0.221)
          opt.fit_tau = fitoem::tau_terms();
          if (!drag_regime && !fitoem::tau_above_regime()) row.flags |= kFlagTauHeld;
          res = fit::run(row, t_fit.data(), r_fit.data(), static_cast<int>(t_fit.size()), opt, variances);
          iterations += res.iterations;
          // DESIGN 2c.2 selection rule (fixed in advance): B_eff above 0.5 m^2/kg is outside the physical range: tau0
          // free instead, B at its prior (or zero without one)
          const double limit = tau0_rule ? fitoem::kBeffPhysicalLimit : fitoem::beff_rule_limit();
          if (row.bterm > limit) {
            tau0_selected = true;
            row.flags |= kFlagLowering;
            row.bterm = have_b_prior ? b_prior : 0.0;
            opt.fit_drag = 0;
            opt.fit_tau = 1 | fitoem::tau_terms();
            res = fit::run(row, t_fit.data(), r_fit.data(), static_cast<int>(t_fit.size()), opt, variances);
            iterations += res.iterations;
          }
        } else {
          res = fit::run(row, t_fit.data(), r_fit.data(), static_cast<int>(t_fit.size()), opt);
          iterations += res.iterations;
        }
        if (res.status < 0) return 2;
        P.t_fit = std::move(t_fit);
        P.r_fit = std::move(r_fit);
        P.t_out = std::move(t_out);
        P.r_out = std::move(r_out);
        P.first = first;
        P.e0 = e0;
        P.row = row;
        P.opt = opt;
        P.res = res;
        P.iterations = iterations;
        P.first_pass_rms = first_pass_rms;
        for (int q = 0; q < fit::kMaxParams; ++q) P.variances[q] = variances[q];
        P.tau0_selected = tau0_selected;
        return 0;
      };
      // the default span: 48 h; 24 h for eccentric orbits (e > 0.5: the lane's THEMIS and Chandra windows lost
      // 0.31 / 1.37 / 2.38 -> 0.51 / 1.72 / 2.98 km at 48 h), a longer span there only when it predicts the tail
      // at least 30 % better (10 % for the others)
      // ($PCF FIT: DEFAULT_SPAN_HOURS, ECCENTRICITY_THRESHOLD, ECCENTRIC_DEFAULT_SPAN_HOURS, CANDIDATE_SPANS_HOURS,
      // EXTENSION_MARGIN, ECCENTRIC_EXTENSION_MARGIN, ECCENTRIC_MAXIMUM_PERIOD_HOURS, TAIL_HOURS)
      const bool eccentric = fitoem::eccentric_block(blk, po.eccentricity_threshold);
      const double default_span = (eccentric ? po.eccentric_default_span_h : po.default_span_h) * 60.0;
      // an eccentric orbit's fits take the finite-difference columns where the analytic ones stall (fit::run)
      struct FallbackScope {
        bool prev;
        explicit FallbackScope(bool on) : prev(fit::jacobian_fallback()) { fit::jacobian_fallback() = on; }
        ~FallbackScope() { fit::jacobian_fallback() = prev; }
      } fallback_scope{eccentric};
      Pass chosen;
      {
        const int rc = run_pass(default_span, chosen, last_useable);
        if (rc == 1) {
          plugin_set_error("too-few-states", "The fit interval holds fewer than 8 states.");
          return 3;
        }
        if (rc == 2) {
          plugin_set_error("fit-failed", "The fit did not converge on the block.");
          return 3;
        }
      }
      double span_used = start_given ? -1.0 : default_span;
      if (!start_given) {
        // the extension validated on the data: each span (48, 72, 120 h) fitted to the data before the latest
        // tail_minutes() and scored on that tail; the span with the smallest tail error (a longer one only when it is
        // at least 10 % better than the best shorter one) is refitted on all the data
        const double data_minutes =
            fitoem::minutes_between(all[0].whole, all[0].frac, all[last_useable].whole, all[last_useable].frac);
        uint32_t tail_start = last_useable;
        while (tail_start > 0 && fitoem::minutes_between(all[tail_start].whole, all[tail_start].frac, all[last_useable].whole,
                                                         all[last_useable].frac) < fitoem::tail_minutes()) --tail_start;
        double best_err = 1e300, best_span = default_span;
        double spans[9];
        int nspans = 0;
        if (po.candidate_count > 0) {
          for (int k = 0; k < po.candidate_count; ++k) spans[nspans++] = po.candidate_spans_h[k] * 60.0;
        } else {
          if (eccentric) spans[nspans++] = 24.0 * 60.0;
          for (const double h : {48.0, 72.0, 120.0}) spans[nspans++] = h * 60.0;
        }
        // an eccentric orbit of more than 36 h (Chandra's 64 h: a 24 h tail is under half a revolution, and the lane's
        // and this module's Chandra windows are best at 24 h) keeps its default span
        if (eccentric && fitoem::period_minutes(blk) > po.eccentric_maximum_period_h * 60.0)
          while (nspans > 0 && spans[nspans - 1] > default_span + 1e-6) --nspans;
        for (int si = 0; si < nspans; ++si) {
          const double span = spans[si];
          if (data_minutes < span + fitoem::tail_minutes() - 1e-6) break;
          Pass v;
          if (run_pass(span, v, tail_start) != 0 || v.t_out.empty()) break;
          std::vector<double> rr(v.r_out.size());
          if (!fit::residuals(v.row, v.t_out.data(), v.r_out.data(), static_cast<int>(v.t_out.size()), rr.data())) break;
          double ss = 0.0;
          for (double x : rr) ss += x * x;
          const double err = std::sqrt(ss / static_cast<double>(v.t_out.size()));
          if (err < (eccentric ? po.eccentric_extension_margin : po.extension_margin) * best_err || best_err >= 1e300) {
            best_err = err;
            best_span = span;
          }
        }
        if (best_span > default_span) {
          Pass f;
          if (run_pass(best_span, f, last_useable) == 0) {
            chosen = std::move(f);
            span_used = best_span;
          }
        }
      }
      // a fit beyond the implausibility bound on that span (a decaying object's element-set pseudo-observations, an
      // arc across a burn): the latest half of the span, down to FIT.MINIMUM_SPAN_HOURS, before refusing
      if (!start_given) {
        for (double span = span_used / 2.0; !(chosen.res.rms_km <= po.implausible_rms_km) && span >= po.minimum_span_h * 60.0 - 1e-6; span /= 2.0) {
          Pass f;
          if (run_pass(span, f, last_useable) == 0) {
            chosen = std::move(f);
            span_used = span;
          }
        }
      }
      std::vector<double>& t_fit = chosen.t_fit;
      std::vector<double>& r_fit = chosen.r_fit;
      std::vector<double>& t_out = chosen.t_out;
      std::vector<double>& r_out = chosen.r_out;
      const uint32_t first = chosen.first;
      const fitoem::Sample& e0 = chosen.e0;
      ElementRow& row = chosen.row;
      fit::Options& opt = chosen.opt;
      fit::Result& res = chosen.res;
      const int iterations = chosen.iterations;
      const double first_pass_rms = chosen.first_pass_rms;
      double* variances = chosen.variances;
      const bool tau0_selected = chosen.tau0_selected;
      // SGP4XP: the set the library reads, at the two-line text's digits searched on their lattice;
      // SDN-AP: full precision (no two-line text)
      double best_pass_rms = std::fmin(first_pass_rms, res.rms_km);
      if (!sdnap_mode) {
        const fit::Result lat = fit::tle_lattice(row, t_fit.data(), r_fit.data(), static_cast<int>(t_fit.size()), opt);
        best_pass_rms = std::fmin(best_pass_rms, lat.rms_km);
        res.rms_km = lat.rms_km;
        res.max_km = lat.max_km;
      }
      // SDN-AP 2b.2: kappa = 1 - B_eff / B_prior, sigma_kappa^2 = (B_eff/B^2)^2 sigma_B^2 + sigma_Beff^2 / B^2
      double kappa = 0.0, kappa_sigma = 0.0, beff_sigma = 0.0;
      if (sdnap_mode && !tau0_selected) {
        beff_sigma = std::sqrt(std::fmax(0.0, variances[6]));
        if (have_b_prior) {
          kappa = 1.0 - row.bterm / b_prior;
          const double a = row.bterm / (b_prior * b_prior);
          kappa_sigma = std::sqrt(a * a * b_prior_sigma * b_prior_sigma + beff_sigma * beff_sigma / (b_prior * b_prior));
          row.kappa = kappa;
        }
      }
      // SPEC 12: the fit's covariance at its solution (SDN-AP and SGP4XP sets, the latter at the two-line digits), its
      // epoch image the $OMM's COVARIANCE
      cov::Set fit_cov;
      double ng_rate = 0.0;
      const bool have_cov = cov::of_fit(row, opt, t_fit.data(), r_fit.data(), static_cast<int>(t_fit.size()), t_fit.back(), fit_cov, ng_rate);
      // held-out score
      double held_rms = 0.0, held_lead_days = 0.0;
      for (double t : t_out) held_lead_days += (t - t_fit.back()) / kMinutesPerDay;
      if (!t_out.empty()) held_lead_days /= static_cast<double>(t_out.size());
      if (!t_out.empty()) {
        std::vector<double> rr(r_out.size());
        if (fit::residuals(row, t_out.data(), r_out.data(), static_cast<int>(t_out.size()), rr.data())) {
          double ss = 0.0;
          for (size_t k = 0; k < t_out.size(); ++k) ss += rr[3 * k] * rr[3 * k] + rr[3 * k + 1] * rr[3 * k + 1] + rr[3 * k + 2] * rr[3 * k + 2];
          held_rms = std::sqrt(ss / static_cast<double>(t_out.size()));
        }
      }
      if (!(res.rms_km <= po.implausible_rms_km)) {
        // the theory does not hold across the arc (a burn, a transfer, a hand-off between centers): no set is
        // better than one that cannot propagate (the lane's Artemis II window: 38,030 km)
        char why[200];
        std::snprintf(why, sizeof why, "The fit's RMS is %.3f km, beyond the %.0f km bound of an Earth set (FIT.IMPLAUSIBLE_RMS_KM): the arc does not hold one set.", res.rms_km,
                      po.implausible_rms_km);
        plugin_set_error("fit-implausible", why);
        return 3;
      }
      // $OMM
      flatbuffers::FlatBufferBuilder fbb(1024);
      char epoch_text[48];
      oem::iso_text(row.epoch_jd_whole, row.epoch_jd_frac, 0.0, epoch_text, sizeof epoch_text);
      char comment[400];
      std::snprintf(comment, sizeof comment,
                    sdnap_mode ? "SDN-AP fit: theory SDN-AP, full precision; %u states fitted, %u held out; fit RMS %.6f km, max %.6f km; held-out RMS %.6f km; %d iterations; span %.3f h (%s)%s"
                               : "SDN-AP fit: theory SGP4XP, two-line digits; %u states fitted, %u held out; fit RMS %.6f km, max %.6f km; held-out RMS %.6f km; %d iterations; span %.3f h (%s)%s",
                    static_cast<unsigned>(t_fit.size()), static_cast<unsigned>(t_out.size()), res.rms_km, res.max_km, held_rms,
                    iterations, t_fit.back() / 60.0, start_given ? "USEABLE_START_TIME" : span_used > default_span ? "extended: better on the latest tail" : span_used < default_span ? "shortened: the default span held no plausible set" : eccentric ? "default for an eccentric orbit (FIT.ECCENTRIC_DEFAULT_SPAN_HOURS)" : "default (FIT.DEFAULT_SPAN_HOURS)",
                    sdnap_mode && (row.flags & kFlagLowering) ? "; LOWERING: B_eff above the 2c.2 limit, tau0 fitted and held after the arc" : "");
      const auto s_epoch = fbb.CreateString(epoch_text);
      const auto s_comment = fbb.CreateString(comment);
      const auto s_center = fbb.CreateString("EARTH");
      const auto s_model = fbb.CreateString("EGM-96");
      const auto s_orig = oem->ORIGINATOR() != nullptr ? fbb.CreateString(oem->ORIGINATOR()->c_str()) : fbb.CreateString("SDN");
      const auto s_frame = CreateRFMDirect(fbb, RFMUnion_NONE, 0, 0, "TEME");
      const CAT* object = blk->OBJECT();
      const uint32_t norad = object != nullptr ? object->NORAD_CAT_ID() : 0;
      const auto s_object_id = object != nullptr && object->OBJECT_ID() != nullptr ? fbb.CreateString(object->OBJECT_ID()->c_str()) : 0;
      const auto s_object_name = object != nullptr && object->OBJECT_NAME() != nullptr ? fbb.CreateString(object->OBJECT_NAME()->c_str()) : 0;
      const double unix_seconds = ((row.epoch_jd_whole - 2440587.5) + row.epoch_jd_frac) * 86400.0;
      const double whole_seconds = std::floor(unix_seconds);
      // SDN-AP's terms without an $OMM field as USER_DEFINED_x (MEAN_ELEMENT_THEORY SDNAP); the covariance rows (SPEC 12)
      flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<OMMUserDefinedParameter>>> s_user = 0;
      if (sdnap_mode || have_cov) {
        std::vector<flatbuffers::Offset<OMMUserDefinedParameter>> ps;
        char v[64];
        auto put = [&](const char* name, double value) {
          std::snprintf(v, sizeof v, "%.17g", value);
          ps.push_back(CreateOMMUserDefinedParameterDirect(fbb, name, v));
        };
        if (sdnap_mode) {
          put("SDNAP_B_EFF", row.bterm);
          put("SDNAP_B_EFF_SIGMA", beff_sigma);
          if (have_b_prior && !tau0_selected) {
            put("SDNAP_B", b_prior);
            put("SDNAP_B_SIGMA", b_prior_sigma);
            put("SDNAP_KAPPA", kappa);
            put("SDNAP_KAPPA_SIGMA", kappa_sigma);
          }
          put("SDNAP_TAU0", row.tau0);
          put("SDNAP_TAUC", row.tauc);
          put("SDNAP_TAUS", row.taus);
          put("SDNAP_ARC_END_MIN", row.arc_end_min);
          if (row.flags & kFlagLowering) put("SDNAP_LOWERING", 1.0);
          if (row.flags & kFlagTauHeld) put("SDNAP_TAU_HELD", 1.0);
        }
        if (have_cov) {
          auto put_list = [&](const char* name, const double* values, int count) {
            std::string text;
            char one[32];
            for (int k = 0; k < count; ++k) {
              std::snprintf(one, sizeof one, k == 0 ? "%.17g" : " %.17g", values[k]);
              text += one;
            }
            ps.push_back(CreateOMMUserDefinedParameterDirect(fbb, name, text.c_str()));
          };
          int kind[fit::kMaxParams];
          const int np = cov::kinds_of(fit_cov.o, kind);
          for (int a = 6; a < np; ++a) {
            double values[fit::kMaxParams];
            for (int j = 0; j <= a; ++j) values[j] = fit_cov.C[a * np + j];
            put_list(cov::consider_name(kind[a]), values, a + 1);
          }
          put_list("SDNAP_COV_FLOOR_UVW", fit_cov.floor, 6);
          put_list("SDNAP_COV_NOISE", fit_cov.noise, 5);
          put("SDNAP_COV_NG_RATE", ng_rate);
          ps.push_back(CreateOMMUserDefinedParameterDirect(fbb, "SDNAP_COV_REGIME", fit_cov.regime == 0 ? "DRAG" : "ABOVE"));
        }
        s_user = fbb.CreateVector(ps);
      }
      flatbuffers::Offset<flatbuffers::Vector<double>> s_cov = 0;
      flatbuffers::Offset<RFM> s_cov_frame = 0;
      if (have_cov) {
        double c21[21];
        int k21 = 0;
        for (int i = 0; i < 6; ++i)
          for (int j = 0; j <= i; ++j) c21[k21++] = fit_cov.C[i * fit_cov.np + j];
        s_cov = fbb.CreateVector(c21, 21);
        s_cov_frame = CreateRFMDirect(fbb, RFMUnion_NONE, 0, 0, "TEME");
      }
      OMMBuilder b(fbb);
      b.add_ORIGINATOR(s_orig);
      b.add_CENTER_NAME(s_center);
      b.add_REFERENCE_FRAME(s_frame);
      b.add_TIME_SYSTEM(timingStandard_UTC);
      b.add_MEAN_ELEMENT_THEORY(sdnap_mode ? meanElementSource_SDNAP : meanElementSource_SGP4XP);
      if (norad != 0) b.add_NORAD_CAT_ID(norad);
      if (!s_object_id.IsNull()) b.add_OBJECT_ID(s_object_id);
      if (!s_object_name.IsNull()) b.add_OBJECT_NAME(s_object_name);
      b.add_COMMENT(s_comment);
      b.add_EPOCH(s_epoch);
      b.add_MEAN_MOTION(row.mean_motion_rev_day);
      b.add_ECCENTRICITY(row.eccentricity);
      b.add_INCLINATION(row.inclination_deg);
      b.add_RA_OF_ASC_NODE(row.raan_deg);
      b.add_ARG_OF_PERICENTER(row.arg_pericenter_deg);
      b.add_MEAN_ANOMALY(row.mean_anomaly_deg);
      b.add_BSTAR(row.bterm);
      b.add_MEAN_MOTION_DDOT(row.agom);
      b.add_USER_DEFINED_EARTH_MODEL(s_model);
      b.add_USER_DEFINED_EPOCH_TIMESTAMP(whole_seconds);
      b.add_USER_DEFINED_MICROSECONDS(std::round((unix_seconds - whole_seconds) * 1e6));
      if (!s_user.IsNull()) b.add_USER_DEFINED_PARAMETERS(s_user);
      if (have_cov) {
        b.add_COV_REFERENCE_FRAME(s_cov_frame);
        b.add_COVARIANCE(s_cov);
      }
      FinishOMMBuffer(fbb, b.Finish());
      if (plugin_push_output("elements", "OMM.fbs", "$OMM", fbb.GetBufferPointer(), fbb.GetSize()) < 0) {
        plugin_set_error("output-failed", "The $OMM could not be emitted.");
        return 3;
      }
      // $OBD: the determination behind the set
      {
        flatbuffers::FlatBufferBuilder ob(512);
        char start_text[48], end_text[48];
        const fitoem::Sample& fs = all[first < n ? first : 0];
        oem::iso_text(fs.whole, fs.frac, 0.0, start_text, sizeof start_text);
        const double fit_end_min = t_fit.back();
        oem::iso_text(e0.whole, e0.frac, fit_end_min, end_text, sizeof end_text);
        const auto o_start = ob.CreateString(start_text);
        const auto o_end = ob.CreateString(end_text);
        const auto o_from = ob.CreateString(epoch_text);
        const auto o_source = ob.CreateString(sdnap_mode
            ? "sdn-ap-propagator fit (THEORY SDNAP): Levenberg-Marquardt on TEME position residuals, unit weights, km; theory SDN-AP (signed B_eff, tauc and taus, tau0 by the 2c.2 rule, kappa from the B prior)"
            : "sdn-ap-propagator fit: Levenberg-Marquardt on TEME position residuals, unit weights, km; theory SGP4XP at the two-line text's digits");
        const auto o_bmodel = ob.CreateString(sdnap_mode ? "B_eff = (1 - kappa) B (SDN-AP 2b), signed, free" : "BTERM (SGP4XP), prior 0 +- 0.05 m^2/kg");
        const auto o_amodel = ob.CreateString("AGOM (SGP4XP), prior 0 +- 0.05 m^2/kg");
        const auto o_object = object != nullptr && object->OBJECT_ID() != nullptr ? ob.CreateString(object->OBJECT_ID()->c_str()) : 0;
        const auto o_types = ob.CreateVectorOfStrings(std::vector<std::string>{"POSITION"});
        OBDBuilder d(ob);
        if (norad != 0) d.add_SAT_NO(norad);
        if (!o_object.IsNull()) d.add_ORIG_OBJECT_ID(o_object);
        d.add_START_TIME(o_start);
        d.add_END_TIME(o_end);
        d.add_METHOD(odMethod_BATCH_LEAST_SQUARES);
        d.add_METHOD_SOURCE(o_source);
        d.add_TIME_SPAN(fitoem::minutes_between(all[0].whole, all[0].frac, all[n - 1].whole, all[n - 1].frac) / kMinutesPerDay);
        d.add_FIT_SPAN((t_fit.back() - t_fit.front()) / kMinutesPerDay);
        d.add_EFFECTIVE_FROM(o_from);
        d.add_WRMS(res.rms_km);
        d.add_FIRST_PASS_WRMS(first_pass_rms);
        d.add_BEST_PASS_WRMS(best_pass_rms);
        if (!t_out.empty() && held_lead_days > 0.0) d.add_ERROR_GROWTH_RATE(std::fmax(0.0, held_rms - res.rms_km) / held_lead_days);
        d.add_BALLISTIC_COEFF_EST(!tau0_selected);
        d.add_BALLISTIC_COEFF_MODEL(o_bmodel);
        d.add_AGOM_EST(true);
        d.add_AGOM_MODEL(o_amodel);
        d.add_RMS_CONVERGENCE_CRITERIA(1e-10);
        d.add_NUM_ITERATIONS(static_cast<uint16_t>(iterations > 65535 ? 65535 : iterations));
        d.add_NUM_ACCEPTED_OBS(static_cast<uint32_t>(t_fit.size()));
        d.add_NUM_REJECTED_OBS(0);
        d.add_ACCEPTED_OB_TYPS(o_types);
        FinishOBDBuffer(ob, d.Finish());
        if (plugin_push_output("determination", "OBD.fbs", "$OBD", ob.GetBufferPointer(), ob.GetSize()) < 0) {
          plugin_set_error("output-failed", "The $OBD could not be emitted.");
          return 3;
        }
      }
      ++blocks_done;
    }
  }
  if (blocks_done == 0) {
    plugin_set_error("missing-oem", "An 'ephemeris' $OEM with a data block is required.");
    return 3;
  }
  return 0;
}

/// The fit: $PCF THEORY UNSPECIFIED or SGP4XP fits SGP4XP sets (the two-line digits); SDNAP fits SDN-AP sets (theory
/// 16) with the environment inputs of this invocation, B_eff signed, tauc/taus and the 2c.2 tau0 rule, kappa from an
/// optional B prior, full-precision output.
extern "C" int fit(void) {
  plugin_reset_output_state();
  if (const int rc = sdnap::pcf::read(sdnap::pcf::kFit)) return rc;
  return fit_blocks(sdnap::pcf::options().theory == pcfTheory_SDNAP);
}

// Diagnostic: the default DESIGN 2c.2 B_eff limit of fit_sdnap (m^2/kg x 1e-3: 500 the rule, > 1e6 off as
// shipped; <= 0 leaves it) and the tauc/taus fit (tau_terms 2 on, 0 off, < 0 leaves it); returns the previous
// limit (2^31 - 1 when off).
SDNAP_EXPORT("sdnap_fit_diagnostic")
int32_t sdnap_fit_diagnostic(int32_t beff_limit_e3, int32_t tau_terms);

// Diagnostic: the span rule's validation tail (minutes; <= 0 leaves it); returns the previous.
SDNAP_EXPORT("sdnap_span_tail_minutes")
double sdnap_span_tail_minutes(double minutes) {
  const double previous = sdnap::fitoem::tail_minutes();
  if (minutes > 0.0) sdnap::fitoem::tail_minutes() = minutes;
  return previous;
}

// Diagnostic: above the drag regime, tauc/taus decaying after the arc (bit 0); every set's held (bit 1).
SDNAP_EXPORT("sdnap_tau_diagnostic")
void sdnap_tau_diagnostic(int32_t flags) {
  sdnap::fitoem::tau_above_regime() = (flags & 1) != 0;
  sdnap::xpt::tau_persist() = (flags & 2) != 0;
}

int32_t sdnap_fit_diagnostic(int32_t beff_limit_e3, int32_t tau_terms) {
  const double was = sdnap::fitoem::beff_rule_limit();
  const int32_t previous = was * 1000.0 < 2147483647.0 ? static_cast<int32_t>(was * 1000.0 + 0.5) : 2147483647;
  if (beff_limit_e3 > 1000000) sdnap::fitoem::beff_rule_limit() = __builtin_inf();
  else if (beff_limit_e3 > 0) sdnap::fitoem::beff_rule_limit() = beff_limit_e3 * 1e-3;
  if (tau_terms >= 0) sdnap::fitoem::tau_terms() = tau_terms & 2;
  return previous;
}
