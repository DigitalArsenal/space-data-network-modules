// -----------------------------------------------------------------------------
// Covariance (SPEC 12): the fit's covariance carried forward by the theory's own state transition matrix.
//
// - The fit (fit_oem.inc, SGP4XP theory) forms the normal matrix of its parameters at the solution, every column a
//   central difference of the theory itself, with its priors; the inverse, the measurement variance being the post-fit
//   residual variance (above the drag the sigma the fit itself weighted the data with, SPEC 12.1), is the parameter
//   covariance. Its image at epoch (TEME position and velocity, then the solved
//   parameters) is the $OCM's COVARIANCE_DATA (LTM, CARTPV, COV_SIZE 6 plus the parameter rows), the parameter rows
//   named by COV_PARAMETER_KINDS in the fixed order of SPEC 17.1: DRAG_AREA_OVER_MASS, DRAG_AREA_OVER_MASS_RATE,
//   SRP_AREA_OVER_MASS, IN_TRACK_ACCELERATION, OUTGASSING_ACCELERATION. The fit solves BTERM and AGOM; the theories
//   have no sensitivity to the other three, so a record that carries them flies them as constant parameters: their
//   state transition columns are zero, their variances constant, their cross terms with the state carried through
//   the state columns.
// - The state transition matrix at t is the central difference of the propagated state in the parameters (the same
//   columns); the epoch covariance is mapped back to the parameters through the epoch columns (their inverse), then
//   forward: P(t) = J(t) P_p J(t)^T.
// - Process noise: errors of the mean-element rates, constant from the end of the fit arc and mapped by the same
//   columns: the eccentricity vector (s_e per day), the inclination vector (s_i per day), the mean longitude (s_l n,
//   a relative mean-motion error) and, in the drag regime, the non-gravitational n-dot (s_d = c |n-dot_ng|). The
//   sizes are fitted per regime (SGP4XP: test/covariance-realism.mjs on laser-ranged arcs apart from the held-out ones;
//   AP DRAG: SPEC 12.5's per-axis re-fit, with a scale of the floor).
// - Theory floor: the fit's residual covariance in UVW (COV_PROPAGATION FLOOR_UU_KM2 .. FLOOR_WW_KM2), added at every
//   time in the state's own UVW axes (velocity: the same scaled by the orbit's angular rate squared). The process noise
//   is COV_PROPAGATION's NOISE_* fields, with the share c and the rate it is a share of. The floor the epoch covariance
//   carries is put on by the writer and taken off by the reader at one state: an AP set's at the two-body state of its own
//   mean elements (epoch_floor_state, SPEC 12.4), an SGP4XP set's at its theory's epoch state, which is frozen.
// -----------------------------------------------------------------------------

namespace sdnap {
namespace cov {

/// Process noise per regime (SPEC 12.5): s_e, s_i (1/day), s_l (dn/n), c (the share of the non-gravitational n-dot) and
/// k_F, the scale of the fit's residual covariance taken as the floor (SPEC 12.4).
struct Noise {
  double s_e, s_i, s_l, c, k_F;
};
/// SGP4XP's, [regime: 0 perigee below kDragRegimeKm, 1 above]
constexpr Noise kNoiseXP[2] = {{2.813e-06, 7.432e-06, 8.505e-07, 1.275e-06, 1.0}, {2.308e-07, 3.752e-07, 2.666e-07, 0, 1.0}};
/// AP's: DRAG re-fitted per axis 2026-11-05 (SPEC 12.5; realism not met), ABOVE the 2026-11-03 minimax row.
constexpr Noise kNoiseAP[2] = {
    {1.8579913326733934e-07, 1.12761105007012e-06, 7.647194501793458e-07, 0.112126311682426, 1.5127596877626373},
    {9.696153866117182e-07, 8.153112791954473e-07, 4.753573962018311e-06, 0, 1.0}};
constexpr double kDragRegimeKm = 2500.0;  ///< the noise regimes' split: perigee height
/// SPEC 12.5: the radial floor's sigma factor of an AP set in the low table whose record states a tesseral degree above
/// kSpCap (the output table's fast side, SPEC 16.1, stack #477). The floor is the fit's residual covariance, and the fast
/// side fits the arc closer, so the floor fell by 10 to 45 %; the factor is the maximum-likelihood fit of the radial
/// |z| on 326 choice windows of 0.6.42's own flights of records at tesseral 31 / zonal 70 with the factor off, judged on
/// 422 others (exp(0.095), at steps of 0.005 in its logarithm; stack #477). The in-track and cross-track floors keep k_F
/// alone. It acts in the DRAG regime only (perigee below kDragRegimeKm), where it is fitted and judged.
constexpr double kFloorRadialFastSide = 1.0996588551261028;
/// SPEC 12.5: the DRAG row's s_i factor for an AP record whose stated zonal degree is kSiZonalDegree (stack #531). The
/// row's s_i was fitted on records at zonal degree 20, whose node drifts by the zonal terms of degree 21 to 70 they leave
/// out; a record at 70 carries them, and at today's s_i its stated cross-track is about 2 to 5 times too wide. The factor is
/// the maximum-likelihood fit of the cross-track |z| on the 326 choice windows of 0.6.42's own flights of records at
/// tesseral 31 / zonal 70 (exp(-2.2), on a grid of 0.005 in its logarithm), judged on the 422 others. A record at any other
/// zonal degree keeps today's s_i.
constexpr double kSiZonal70 = 0.11080315836233387;
constexpr int kSiZonalDegree = 70;
/// SPEC 12.5: the DRAG row's drag share c on strong drag (stack #568). The key is the record's own stated drag rate,
/// COV_PROPAGATION.NON_GRAVITATIONAL_RATE_PER_DAY |r|; the share is c (1 + (kDragShareStrong - 1) S(|r|)), S a cos^2 step in
/// log10 |r| centred on kDragKeyMid with half-width kDragKeyHalfDecades, fixed from the keys alone before any fit: the
/// registered windows' weak-drag records state at most 6.94e-7 per day and their strong-drag records at least 2.61e-6, so S is 0
/// at or below 7.6e-7 (no weak-drag record changes) and 1 at or above 2.4e-6, and no window of the set is on the slope. The
/// factor is the maximum-likelihood fit of the radial and in-track |z| (days 1 to 7) on the 236 strong-drag 2025 choice windows
/// of 0.6.43's own flights at tesseral 31 / zonal 70 (exp(0.150), on a grid of 0.005 in its logarithm), judged on strong drag
/// 2026. It acts where it is fitted: an AP set in the DRAG regime in the low table above kSpCap (low_fast_side).
constexpr double kDragShareStrong = 1.1618342427282831;
constexpr double kDragKeyMid = 1.35e-6;
constexpr double kDragKeyHalfDecades = 0.25;
/// S(|r|) of kDragShareStrong: 0 at or below kDragKeyMid 10^-kDragKeyHalfDecades, 1 at or above kDragKeyMid
/// 10^kDragKeyHalfDecades, 1 - cos^2 of the fraction of the way across in log10 |r| between.
inline double drag_key_step(double rate_per_day) {
  const double r = std::fabs(rate_per_day);
  if (!(r > 0.0)) return 0.0;
  const double x = std::log10(r / kDragKeyMid);
  if (x <= -kDragKeyHalfDecades) return 0.0;
  if (x >= kDragKeyHalfDecades) return 1.0;
  const double c = std::cos(0.5 * kPi * (x + kDragKeyHalfDecades) / (2.0 * kDragKeyHalfDecades));
  return 1.0 - c * c;
}

/// SPEC 12.4 (stack #551): the first release whose AP records carry their epoch floor at the two-body state of their
/// mean elements. An AP record another producer, or this module before it, wrote carries its floor at its writer's
/// theory state: its covariance is refused by name (kFloorRefusal), its states fly.
constexpr int kEpochFloorSince[3] = {0, 6, 39};
constexpr const char* kFloorRefusal = "cov-floor-at-theory-state";
/// SPEC 12.4: the PRODUCER the gate reads, this module's id and a space before X.Y.Z (ocm.inc asserts it is ocm::kModuleId's).
constexpr char kFloorProducerPrefix[] = "com.spacedatanetwork.sdn-ap-propagator ";
constexpr const char* kFloorRefusalNote =
    "cov-floor-at-theory-state: the covariance is refused and the states fly. The record's epoch covariance carries its "
    "floor at its writer's theory state (an AP record written before SPEC 12.4's epoch floor at the two-body state of "
    "its mean elements, sdn-ap 0.6.39); fitted again, the set carries its covariance.";

/// SPEC 12.4: the state an AP set's epoch floor is put on and taken off at: the two-body state of the set's own mean
/// elements (TEME, km and km/s; SPEC 1.3's k_e and radius, a = (k_e / n)^(2/3), no recovery), a fixed formula on the
/// record's written numbers, so that the writer and every reader take the same floor whatever their theory's epoch state.
inline bool epoch_floor_state(const ElementRow& row, double r[3], double v[3]) {
  const double n = row.mean_motion_rev_day * (2.0 * kPi) / kMinutesPerDay;  // rad/min
  if (!(n > 0.0)) return false;
  const double mu_km = xpt::kMu * xpt::kRe * xpt::kRe * xpt::kRe / 3600.0;  // km^3/s^2
  const double el[6] = {std::cbrt(xpt::kMu / (n * n)) * xpt::kRe, row.eccentricity, row.inclination_deg * kDeg,
                        row.raan_deg * kDeg, row.arg_pericenter_deg * kDeg, row.mean_anomaly_deg * kDeg};
  return twobody::state_of(mu_km, el, r, v);
}

/// SPEC 12.4: whether an AP record's epoch covariance carries its floor at the two-body state of its mean elements: its
/// PROVENANCE.PRODUCER is exactly "com.spacedatanetwork.sdn-ap-propagator X.Y.Z" (three decimal integers, nothing after
/// them) with X.Y.Z at kEpochFloorSince or later, compared part by part as numbers. Any other text, or none, is not.
inline bool floor_at_mean_elements(const OCM* o) {
  const PVN* pv = o->PROVENANCE();
  const flatbuffers::String* pr = pv == nullptr ? nullptr : pv->PRODUCER();
  constexpr size_t n = sizeof kFloorProducerPrefix - 1;
  if (pr == nullptr || pr->size() <= n || std::strncmp(pr->c_str(), kFloorProducerPrefix, n) != 0) return false;
  int v[3] = {0, 0, 0};
  const char* c = pr->c_str() + n;
  for (int k = 0; k < 3; ++k) {
    if (*c < '0' || *c > '9') return false;
    long x = 0;
    while (*c >= '0' && *c <= '9' && x < 100000) x = 10 * x + (*c++ - '0');
    if (*c >= '0' && *c <= '9') return false;
    v[k] = static_cast<int>(x);
    if (k < 2 && *c++ != '.') return false;
  }
  if (*c != '\0') return false;
  for (int k = 0; k < 3; ++k)
    if (v[k] != kEpochFloorSince[k]) return v[k] > kEpochFloorSince[k];
  return true;
}

/// The regime of a set: 0 (DRAG) its perigee height below kDragRegimeKm, 1 (ABOVE) at or above it, where the theory's
/// density is 1e-20 kg/m^3 at every point of the orbit (SPEC 3.3) and drag does not act. One function for the regime
/// the record states (SPEC 12.5) and for the weighting of the fit (SPEC 12.1).
inline int regime_of(const ElementRow& row) {
  const double n_min = row.mean_motion_rev_day * kTwoPi / kMinutesPerDay;
  const double a_er = std::pow(xpt::kKe / n_min, kX2o3);
  return (a_er * (1.0 - row.eccentricity) - 1.0) * xpt::kRe < kDragRegimeKm ? 0 : 1;
}

/// SPEC 12.5, 16.1: an AP set of the low table's fast side (the record states a tesseral degree above kSpCap; class 0, not
/// the long-period regime, at or below its eccentricity switch), where kFloorRadialFastSide and kDragShareStrong are fitted.
inline bool low_fast_side(const ElementRow& row) {
  const xpt::Branch br = xpt::branch_of(row.mean_motion_rev_day * kTwoPi / kMinutesPerDay, row.eccentricity, true);
  return xpt::tess::active().tesseral > xpt::tess::kSpCap && br.resonance == 0 && !br.long_period && br.wide_tess == 0;
}

/// SPEC 12.5, above the drag: the class of a set by its own elements: HEO above e 0.3 (strictly, as the theory's switches,
/// so a set at exactly 0.3 is the below side's in theory and class alike; stack #504); otherwise geosynchronous
/// under 1.5 rev/day, medium Earth orbit under 4 rev/day, and the LAGEOS class above (LAGEOS, LARES-2).
enum AboveClass { kAboveHeo = 0, kAboveGso = 1, kAboveMeo = 2, kAboveLageos = 3 };
inline int above_class(const ElementRow& row) {
  if (row.eccentricity > xpt::tess::kWideE) return kAboveHeo;
  if (row.mean_motion_rev_day < 1.5) return kAboveGso;
  if (row.mean_motion_rev_day < 4.0) return kAboveMeo;
  return kAboveLageos;
}
/// SPEC 12.5, a class's process noise above the drag (stack #433, 2026-11-11): s_e, s_i (1/day), s_l (dn/n) and k, the
/// size of the non-gravitational n-dot per unit of the set's radiation term, s_d = k |AGOM| / a (rad/day^2; AGOM in
/// m^2/kg, a in Earth radii): the unmodeled force above the drag is radiation pressure, which scales with the area to
/// mass. Fitted on fits to precise orbits (experiments headline-loop, sdn-ap 0.6.15), the row applies only inside its
/// calibrated condition: the data sigma the fit weighted with (12.1) and the fit's span within those of the calibration
/// fits. Outside it, and in a class with no fitted row (fitted false), the regime's row of kNoiseAP / kNoiseXP stands.
struct AboveRow {
  bool fitted;
  double s_e, s_i, s_l, k;
  double sigma_lo_km, sigma_hi_km;  ///< the calibration fits' data sigma, km
  double span_lo_h, span_hi_h;      ///< the calibration fits' spans, hours
};
// LAGEOS: LAGEOS-1, LAGEOS-2, LARES-2, 32 windows of 72 h; k the one k of the LAGEOS, medium Earth orbit and
// geosynchronous classes (1.415e-5 AP, 3.216e-5 SGP4XP); s_e, s_i, s_l fitted so that every regime's 99th percentile of
// |z| per axis and lead is at most 2.9. The bounds are the calibration fits' data sigma (rounded outward) and 0.9 to
// 1.05 times their spans. HEO, geosynchronous and medium Earth orbit keep the ABOVE row for now (SPEC 12.5).
constexpr AboveRow kAboveAP[4] = {
    {false, 0, 0, 0, 0, 0, 0, 0, 0},  // HEO
    {false, 0, 0, 0, 0, 0, 0, 0, 0},  // geosynchronous
    {false, 0, 0, 0, 0, 0, 0, 0, 0},  // medium Earth orbit
    {true, 1.1374623058968726e-08, 8.083584088270014e-08, 3.831472309446551e-09, 1.415e-05, 0.00243, 0.00276, 64.8, 75.6}};  // LAGEOS
constexpr AboveRow kAboveXP[4] = {
    {false, 0, 0, 0, 0, 0, 0, 0, 0},
    {false, 0, 0, 0, 0, 0, 0, 0, 0},
    {false, 0, 0, 0, 0, 0, 0, 0, 0},
    {true, 2.463673468245377e-07, 6.564224575525169e-07, 5.502200043625398e-08, 3.216e-05, 0.0588, 0.0769, 64.8, 75.6}};

/// SPEC 12.8 "The drag term's stated width on a 71 h arc" (stack #489, #463): an AP set under NRLMSISE-00 on the 71 h
/// default (e 0.3 or below, perigee 600 to 2,500 km, BTERM's default prior: median 0.008, sigma of the log 10 ln 10),
/// fitted at the data's own sigma over a span inside a row, states BTERM's sigma of ln as the arc's information over m^2
/// combined with the prior's, and never more than the row's cap: the spread of ln B over the measured population (the
/// numerical propagator's 72 h terms), where an arc that cannot see the term would otherwise state the prior's 10 ln 10.
/// The width is on BTERM's diagonal alone and named in a second COV_REALISM entry (kWidthTagPrefix, the rule's number, m,
/// the prior's sigma, the cap and, where the cap binds, the formal sigma). It is stated, not mapped: a reader that knows
/// the rule derives m, the prior's sigma and the cap from the record's own fields, checks them against the entry's text,
/// recovers the formal variance and maps that; any other reader maps the matrix as stated and says so. A changed table
/// is a new rule number.
struct WidthRow {
  double hp_lo_km, hp_hi_km, span_lo_h, span_hi_h, m, cap;
};
constexpr WidthRow kWidth1[] = {{600.0, 2500.0, 71.0, 75.6, 3.14, 1.09}};
constexpr const char* kWidthTagPrefix = "sdn-ap drag-term width ";
constexpr const char* kWidthCappedMark = "; capped, formal sigma of ln ";
constexpr double kWidthWideLn10 = 23.02585092994045684;  ///< pcf::kDragPriorWideLogSigma, the 71 h default's sigma of the log

/// Width 1's m, the prior's sigma of the log and the cap for a set, from its own elements and span (hours); false
/// outside the rule.
inline bool width1_of(const ElementRow& row, double span_h, bool msis, double& m, double& sigma_p, double& cap) {
  if (!msis || !(row.mean_motion_rev_day > 0.0) || row.eccentricity > xpt::tess::kWideE) return false;
  const double n_min = row.mean_motion_rev_day * kTwoPi / kMinutesPerDay;
  const double a_km = std::pow(xpt::kKe / n_min, kX2o3) * xpt::kRe;
  const double hp = a_km * (1.0 - row.eccentricity) - xpt::kRe;
  for (const WidthRow& w : kWidth1)
    if (hp >= w.hp_lo_km && hp < w.hp_hi_km && span_h >= w.span_lo_h && span_h <= w.span_hi_h) {
      m = w.m;
      sigma_p = kWidthWideLn10;
      cap = w.cap;
      return true;
    }
  return false;
}
/// The COV_REALISM MODEL_ID that names width 1 with its figures; `formal` the formal sigma of ln where the cap binds, 0
/// where it does not.
inline void width1_text(double m, double sigma_p, double cap, double formal, char* out, size_t n) {
  if (formal > 0.0)
    std::snprintf(out, n, "%s1: m %.6g, prior sigma %.6g, cap %.6g%s%.17g; stated, not mapped", kWidthTagPrefix, m, sigma_p, cap, kWidthCappedMark,
                  formal);
  else
    std::snprintf(out, n, "%s1: m %.6g, prior sigma %.6g, cap %.6g; stated, not mapped", kWidthTagPrefix, m, sigma_p, cap);
}
/// Width 1's stated variance of ln B from the formal one (`var_f`, the fit's posterior with the prior `sigma_p`): the
/// arc's information over m^2 combined with the prior's, at most cap^2. `capped` says where the cap binds.
inline double width1_stated(double var_f, double m, double sigma_p, double cap, bool& capped) {
  const double var_p = sigma_p * sigma_p, info_arc = std::fmax(0.0, 1.0 / var_f - 1.0 / var_p);
  const double var_h = 1.0 / (info_arc / (m * m) + 1.0 / var_p);
  capped = var_h > cap * cap;
  return capped ? cap * cap : var_h;
}

constexpr int kMaxConsider = 5;
constexpr int kMaxAug = 6 + kMaxConsider;
static_assert(kMaxAug == fit::kMaxParams, "the augmented state is the fit's parameter vector");
/// The parameter rows (SPEC 17.1), in params_of order, kind 6 + index: the prwDynamicParameter, the name, the unit and
/// whether the theories are sensitive to it (a modeled parameter has a state transition column).
constexpr int kKindDrag = 6, kKindDragRate = 7, kKindSrp = 8, kKindThrust = 9, kKindOutgassing = 10;
struct Parameter {
  prwDynamicParameter kind;
  const char* name;
  const char* units;
  bool modeled;
};
constexpr Parameter kParameters[kMaxConsider] = {
    {prwDynamicParameter_DRAG_AREA_OVER_MASS, "DRAG_AREA_OVER_MASS", "m**2/kg", true},
    {prwDynamicParameter_DRAG_AREA_OVER_MASS_RATE, "DRAG_AREA_OVER_MASS_RATE", "m**2/kg/s", false},
    {prwDynamicParameter_SRP_AREA_OVER_MASS, "SRP_AREA_OVER_MASS", "m**2/kg", true},
    {prwDynamicParameter_IN_TRACK_ACCELERATION, "IN_TRACK_ACCELERATION", "m/s**2", false},
    {prwDynamicParameter_OUTGASSING_ACCELERATION, "OUTGASSING_ACCELERATION", "km/s**2", false}};
inline prwDynamicParameter consider_kind(int kind) { return kParameters[kind - 6].kind; }
inline const char* consider_name(int kind) { return kParameters[kind - 6].name; }
inline const char* consider_units(int kind) { return kParameters[kind - 6].units; }
inline bool modeled(int kind) { return kind < 6 || kParameters[kind - 6].modeled; }
/// The kind (6 + index) of a prwDynamicParameter, or -1 for one outside the five.
inline int kind_of(int parameter) {
  for (int c = 0; c < kMaxConsider; ++c)
    if (kParameters[c].kind == parameter) return 6 + c;
  return -1;
}
/// The kind (6 + index) of a parameter name, or -1 for one outside the five.
inline int kind_named(const char* name) {
  for (int c = 0; name != nullptr && c < kMaxConsider; ++c)
    if (std::strcmp(kParameters[c].name, name) == 0) return 6 + c;
  return -1;
}

/// Kinds of the parameter vector of options `o` (params_of order): 0-5 af, ag, chi, psi, lambda, n; then 6 BTERM,
/// 7 BDOT, 8 AGOM, 9 in-track thrust, 10 outgassing, those the options carry.
inline int kinds_of(const fit::Options& o, int* kind) {
  int np = 0;
  for (; np < 6; ++np) kind[np] = np;
  if (o.fit_drag) kind[np++] = kKindDrag;
  if (o.fit_bdot) kind[np++] = kKindDragRate;
  if (o.fit_agom) kind[np++] = kKindSrp;
  if (o.fit_thrust) kind[np++] = kKindThrust;
  if (o.fit_outgassing) kind[np++] = kKindOutgassing;
  return np;
}

inline double step_of(int kind, double v) {
  if (kind < 5) return 1e-6;                    // af, ag, chi, psi; lambda (rad)
  if (kind == 5) return 1e-7 * std::fabs(v);    // n (rad/min)
  return std::fmax(1e-3 * std::fabs(v), 1e-5);  // m^2/kg
}

/// The theory at the set and at the set moved by +-h in each modeled parameter (AGOM forward only where -h would
/// switch SRP off: the theory reads AGOM <= 0 as none); a parameter the theories have no sensitivity to has no moved
/// sets and a zero column.
struct Bank {
  int np = 0;
  int kind[fit::kMaxParams] = {};
  int slot[fit::kMaxParams] = {};  ///< the moved sets of parameter j: [1 + 2 slot] +h_j, [2 + 2 slot] -h_j; -1 none
  double h[fit::kMaxParams] = {};
  bool central[fit::kMaxParams] = {};
  double x[fit::kMaxParams] = {};
  fit::Options o{};
  xpt::XpSat* sats = nullptr;  ///< [0] the set, then the moved sets
  int count = 0;
};

inline void release(Bank& b) {
  for (int i = 0; b.sats != nullptr && i < b.count; ++i) xpt::xp_release(b.sats[i]);
  std::free(b.sats);
  b.sats = nullptr;
  b.count = 0;
}

inline bool init(const ElementRow& row, const fit::Options& o, Bank& b, xpt::XpSat* nominal = nullptr) {
  release(b);
  b.o = o;
  b.np = kinds_of(o, b.kind);
  fit::params_of(row, o, b.x);
  int moved = 0;
  for (int j = 0; j < b.np; ++j) b.slot[j] = modeled(b.kind[j]) ? moved++ : -1;
  const int total = 1 + 2 * moved;
  b.sats = static_cast<xpt::XpSat*>(sdnap::mem::calloc(static_cast<size_t>(total), sizeof(xpt::XpSat)));
  if (b.sats == nullptr) return false;
  drag::table();
  auto start = [&](const double* x, int slot) {
    ElementRow r = row;
    fit::row_of(x, o, r);
    const bool ok = xpt::xp_init(elements_of(r), b.sats[slot]) == kPropOk;
    if (slot + 1 > b.count) b.count = slot + 1;
    return ok;
  };
  if (nominal != nullptr && xpt::is_ap_ctx(nominal->ctx)) {
    b.sats[0] = *nominal;
    *nominal = xpt::XpSat{};
    b.count = 1;
    if (b.sats[0].init_error != 0) return false;
  } else {
    if (!start(b.x, 0)) return false;
  }
  // the sigma sets read the nominal's grids above e 0.3 (SPEC 16.11)
  xpt::GridShareScope share(&b.sats[0]);
  xpt::CovBankScope cov_share(&b.sats[0]);
  for (int j = 0; j < b.np; ++j) {
    if (b.slot[j] < 0) continue;
    b.h[j] = step_of(b.kind[j], b.x[j]);
    b.central[j] = !(b.kind[j] == kKindSrp && !o.agom_log && b.x[j] - b.h[j] <= 0.0);  // ln AGOM moves both ways
    double xp[fit::kMaxParams], xm[fit::kMaxParams];
    for (int q = 0; q < b.np; ++q) xp[q] = xm[q] = b.x[q];
    xp[j] += b.h[j];
    if (!start(xp, 1 + 2 * b.slot[j])) return false;
    if (b.central[j] || !xpt::is_ap_ctx(b.sats[0].ctx)) {
      xm[j] -= b.central[j] ? b.h[j] : 0.0;
      if (!start(xm, 2 + 2 * b.slot[j])) return false;
    } else if (2 + 2 * b.slot[j] + 1 > b.count) {
      b.count = 2 + 2 * b.slot[j] + 1;
    }
  }
  return true;
}

/// The set's state at t (TEME km, km/s) and J = d state / d parameters (6 x np, row-major; a parameter the theories
/// have no sensitivity to: a zero column).
inline bool at(Bank& b, double t, double r[3], double v[3], double* J, int32_t* nom_status = nullptr) {
  return xpt::xp_propagate_cov_at(b.sats, b.np, b.slot, b.central, b.h, t, r, v, J, nom_status);
}

/// Symmetric positive definite inverse (n <= kMaxAug) by Cholesky; false when not positive definite.
inline bool spd_inverse(const double* A, int n, double* out) {
  double L[kMaxAug * kMaxAug] = {};
  for (int j = 0; j < n; ++j) {
    double d = A[j * n + j];
    for (int k = 0; k < j; ++k) d -= L[j * n + k] * L[j * n + k];
    if (!(d > 0.0)) return false;
    L[j * n + j] = std::sqrt(d);
    for (int i = j + 1; i < n; ++i) {
      double s = A[i * n + j];
      for (int k = 0; k < j; ++k) s -= L[i * n + k] * L[j * n + k];
      L[i * n + j] = s / L[j * n + j];
    }
  }
  for (int c = 0; c < n; ++c) {
    double y[kMaxAug];
    for (int i = 0; i < n; ++i) {
      double s = i == c ? 1.0 : 0.0;
      for (int k = 0; k < i; ++k) s -= L[i * n + k] * y[k];
      y[i] = s / L[i * n + i];
    }
    for (int i = n - 1; i >= 0; --i) {
      double s = y[i];
      for (int k = i + 1; k < n; ++k) s -= L[k * n + i] * y[k];
      y[i] = s / L[i * n + i];
    }
    for (int i = 0; i < n; ++i) out[i * n + c] = y[i];
  }
  for (int i = 0; i < n; ++i)
    for (int j = 0; j < i; ++j) out[i * n + j] = out[j * n + i] = 0.5 * (out[i * n + j] + out[j * n + i]);
  return true;
}

/// General 6 x 6 inverse by Gauss-Jordan with partial pivoting.
inline bool inverse6(const double* A, double* out) {
  double M[6][12];
  for (int i = 0; i < 6; ++i)
    for (int j = 0; j < 12; ++j) M[i][j] = j < 6 ? A[i * 6 + j] : (j - 6 == i ? 1.0 : 0.0);
  for (int c = 0; c < 6; ++c) {
    int p = c;
    for (int i = c + 1; i < 6; ++i)
      if (std::fabs(M[i][c]) > std::fabs(M[p][c])) p = i;
    if (!(std::fabs(M[p][c]) > 0.0)) return false;
    if (p != c)
      for (int j = 0; j < 12; ++j) std::swap(M[p][j], M[c][j]);
    const double d = M[c][c];
    for (int j = 0; j < 12; ++j) M[c][j] /= d;
    for (int i = 0; i < 6; ++i) {
      if (i == c) continue;
      const double f = M[i][c];
      if (f != 0.0)
        for (int j = 0; j < 12; ++j) M[i][j] -= f * M[c][j];
    }
  }
  for (int i = 0; i < 6; ++i)
    for (int j = 0; j < 6; ++j) out[i * 6 + j] = M[i][6 + j];
  return true;
}

/// A TEME vector in the UVW axes of the state (r, v) (U radial, V in-track, W along r x v).
inline void to_uvw(const double r[3], const double v[3], const double* vec, double* out) {
  double basis[3][3];
  for (int a = 0; a < 3; ++a) {
    const double e[3] = {a == 0 ? 1.0 : 0.0, a == 1 ? 1.0 : 0.0, a == 2 ? 1.0 : 0.0};
    events::uvw_to_teme(r, v, e, basis[a]);
  }
  for (int a = 0; a < 3; ++a) out[a] = vec[0] * basis[a][0] + vec[1] * basis[a][1] + vec[2] * basis[a][2];
}

/// The theory floor at the state (r, v): the UVW covariance F (lower triangle uu, vu, vv, wu, wv, ww; km^2) in TEME
/// axes, added to P (6 x 6): position F, velocity F times the angular rate squared.
inline void add_floor(const double* F, const double r[3], const double v[3], double* P, bool fast_ap = false) {
  if (!fast_ap) {
    double basis[3][3];
    for (int a = 0; a < 3; ++a) {
      const double e[3] = {a == 0 ? 1.0 : 0.0, a == 1 ? 1.0 : 0.0, a == 2 ? 1.0 : 0.0};
      events::uvw_to_teme(r, v, e, basis[a]);
    }
    const double M[3][3] = {{F[0], F[1], F[3]}, {F[1], F[2], F[4]}, {F[3], F[4], F[5]}};
    const double h[3] = {r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]};
    const double rr = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
    const double w = std::sqrt(h[0] * h[0] + h[1] * h[1] + h[2] * h[2]) / rr;  // rad/s
    for (int i = 0; i < 3; ++i)
      for (int j = 0; j < 3; ++j) {
        double s = 0.0;
        for (int a = 0; a < 3; ++a)
          for (int c = 0; c < 3; ++c) s += basis[a][i] * M[a][c] * basis[c][j];
        P[i * 6 + j] += s;
        P[(3 + i) * 6 + 3 + j] += w * w * s;
      }
    return;
  }
  if ((F[0] == 0.0) && (F[1] == 0.0) && (F[2] == 0.0) && (F[3] == 0.0) && (F[4] == 0.0) && (F[5] == 0.0)) return;
  const double rr = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
  const double inv_rn = 1.0 / std::sqrt(rr);
  const double U0 = r[0] * inv_rn, U1 = r[1] * inv_rn, U2 = r[2] * inv_rn;
  const double h0 = r[1] * v[2] - r[2] * v[1], h1 = r[2] * v[0] - r[0] * v[2], h2 = r[0] * v[1] - r[1] * v[0];
  const double hh = h0 * h0 + h1 * h1 + h2 * h2;
  const double inv_wn = 1.0 / std::sqrt(hh);
  const double W0 = h0 * inv_wn, W1 = h1 * inv_wn, W2 = h2 * inv_wn;
  const double V0 = W1 * U2 - W2 * U1, V1 = W2 * U0 - W0 * U2, V2 = W0 * U1 - W1 * U0;
  const double B[3][3] = {{U0, U1, U2}, {V0, V1, V2}, {W0, W1, W2}};
  const double M[3][3] = {{F[0], F[1], F[3]}, {F[1], F[2], F[4]}, {F[3], F[4], F[5]}};
  const double w2 = hh / (rr * rr);
  double BM[3][3];
  for (int i = 0; i < 3; ++i)
    for (int c = 0; c < 3; ++c)
      BM[i][c] = B[0][i] * M[0][c] + B[1][i] * M[1][c] + B[2][i] * M[2][c];
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j <= i; ++j) {
      const double s = BM[i][0] * B[0][j] + BM[i][1] * B[1][j] + BM[i][2] * B[2][j];
      P[i * 6 + j] += s;
      P[(3 + i) * 6 + 3 + j] += w2 * s;
      if (j != i) {
        P[j * 6 + i] += s;
        P[(3 + j) * 6 + 3 + i] += w2 * s;
      }
    }
  }
}

/// SPEC 12.4: the state the epoch floor is put on and taken off at: an AP record's (ap: its MEAN_ELEMENT_THEORY AP) the
/// two-body state of its mean elements (epoch_floor_state), any other the theory's epoch state (r0, v0). The writer
/// (of_fit), the reader (prepare) and the test hook (epoch_floor_parts) all take it from this one function.
inline bool epoch_floor_at(const ElementRow& row, bool ap, const double r0[3], const double v0[3], double rf[3], double vf[3]) {
  if (ap) return epoch_floor_state(row, rf, vf);
  for (int k = 0; k < 3; ++k) {
    rf[k] = r0[k];
    vf[k] = v0[k];
  }
  return true;
}

/// SPEC 12.4: the floor the epoch covariance carries, added to P (6 x 6), at the state epoch_floor_at chooses.
inline bool epoch_floor(const ElementRow& row, bool ap, const double* floor, const double r0[3], const double v0[3], double* P) {
  double rf[3], vf[3];
  if (!epoch_floor_at(row, ap, r0, v0, rf, vf)) return false;
  add_floor(floor, rf, vf, P);
  return true;
}

/// A covariance-bearing set: the row, its parameter layout, the epoch covariance (COVARIANCE, 6 x 6, the floor
/// included), the consider rows, the floor and the process noise.
struct Set {
  ElementRow row{};
  fit::Options o{};
  int np = 0;
  bool ap = false;  ///< SPEC 12.4: the record's MEAN_ELEMENT_THEORY is AP, so its epoch floor is at the two-body state
  double C[kMaxAug * kMaxAug] = {};  ///< augmented epoch covariance (np x np): state block total, then the parameters
  double log_sigma[kMaxConsider] = {};  ///< of_fit: the posterior sigma of ln B ([0]), ln AGOM ([2]) where the fit estimated the log (else 0)
  double floor[6] = {};
  double noise[5] = {};              ///< s_e, s_i (1/day), s_l (dn/n), s_d (rad/day^2), the noise start t_a (min)
  double share = 0.0;                ///< c, the share of the non-gravitational n-dot that is error
  double ng_rate = 0.0;              ///< n-dot_ng / n at epoch, 1/day: s_d = c |ng_rate| n
  int regime = 0;                    ///< 0 drag, 1 above (of_fit)
  int width_index = -1;              ///< read: BTERM's row where a named width rule's formal variance was recovered
  double width_stated = 0.0;         ///< read: the record's stated BTERM variance there (the augmented output's)
  char width_note[240] = {};         ///< read: a width the reader maps as stated, and why (the flight's COMMENT)
};

/// The process noise of a set (SPEC 12.5): its regime (0 perigee below kDragRegimeKm, 1 above), the non-gravitational
/// n-dot / n at epoch (1/day; the theory's epoch rates with and without BTERM) and the sizes s_e, s_i, s_l, s_d
/// with the noise start t_a (minutes), and the floor's scale k_F. Above the drag a set inside its class's calibrated
/// condition (`sigma_km` the data sigma its fit weighted with, 0 for none; `span_h` the fit's span) takes the class's
/// row (kAboveAP, kAboveXP). False when the theory refuses the set.
inline bool noise_of(const ElementRow& row, double t_a, double sigma_km, double span_h, double& ng_rate, int& regime, double* noise,
                     double& share, double& floor_scale) {
  ng_rate = 0.0;
  ElementRow none = row;
  none.bterm = 0.0;
  xpt::XpSat* s1 = static_cast<xpt::XpSat*>(sdnap::mem::calloc(1, sizeof(xpt::XpSat)));
  xpt::XpSat* s0 = static_cast<xpt::XpSat*>(sdnap::mem::calloc(1, sizeof(xpt::XpSat)));
  drag::table();
  const bool ok = s1 != nullptr && s0 != nullptr && xpt::xp_init(elements_of(row), *s1) == kPropOk;
  if (ok && xpt::xp_init(elements_of(none), *s0) == kPropOk && s1->epoch.y[xpt::kN] > 0.0)
    ng_rate = (s1->epoch.f[xpt::kN] - s0->epoch.f[xpt::kN]) / s1->epoch.y[xpt::kN] * kMinutesPerDay;
  if (s1 != nullptr) xpt::xp_release(*s1);
  if (s0 != nullptr) xpt::xp_release(*s0);
  std::free(s1);
  std::free(s0);
  if (!ok) return false;
  const double n_min = row.mean_motion_rev_day * kTwoPi / kMinutesPerDay;
  regime = regime_of(row);
  const auto& terms = xpt::tess::active();
  const bool ap = terms.tesseral || terms.zonal;
  const Noise& k = ap ? kNoiseAP[regime] : kNoiseXP[regime];
  noise[0] = k.s_e;
  // the DRAG row's s_i at a record's zonal degree 70 (kSiZonal70, SPEC 12.5)
  noise[1] = ap && regime == 0 && terms.zonal == kSiZonalDegree ? k.s_i * kSiZonal70 : k.s_i;
  noise[2] = k.s_l;
  // the drag share on strong drag (kDragShareStrong, SPEC 12.5), keyed on the drag rate the record states
  share = ap && regime == 0 && low_fast_side(row) ? k.c * (1.0 + (kDragShareStrong - 1.0) * drag_key_step(ng_rate)) : k.c;
  noise[3] = share * std::fabs(ng_rate) * n_min * kMinutesPerDay;
  noise[4] = t_a;
  floor_scale = k.k_F;
  if (regime == 1) {
    const AboveRow& a = (ap ? kAboveAP : kAboveXP)[above_class(row)];
    if (a.fitted && sigma_km >= a.sigma_lo_km && sigma_km <= a.sigma_hi_km && span_h >= a.span_lo_h && span_h <= a.span_hi_h) {
      const double a_er = std::pow(xpt::kKe / n_min, kX2o3);
      noise[0] = a.s_e;
      noise[1] = a.s_i;
      noise[2] = a.s_l;
      noise[3] = a.k * std::fabs(row.agom) / a_er;
      share = 0.0;  // above the drag s_d is the class's k |AGOM| / a, not a share of the non-gravitational rate
      floor_scale = 1.0;
    }
  }
  return true;
}

/// The fit's covariance at its solution (fit_oem, SGP4XP sets): `t`, `r` the fit samples (minutes, TEME km),
/// `sigma_km` the data sigma the fit weighted them with where it weighted at the data's own (fit::reweight, a set above
/// the drag; SPEC 12.1), 0 where it did not (the post-fit residual scatter is then taken here). Fills `s` (row and
/// options as fitted) and the non-gravitational rate r_ng (1/day). False when the normal matrix is not positive
/// definite or the theory refuses a moved set.
inline bool of_fit(const ElementRow& row, const fit::Options& fitted, const double* t, const double* r, int count, double arc_end_min,
                   double sigma_km, Set& s, double& ng_rate, bool ap) {
  // SPEC 16.13, 17.1: an AP set's radiation term Y0 is no row of the covariance: the moved sets fly the solved Y0 the row
  // carries, held
  fit::Options o = fitted;
  o.fit_y0 = 0;
  Bank b;
  struct Scope {
    Bank& b;
    ~Scope() { release(b); }
  } scope{b};
  if (count < 8 || !init(row, o, b)) return false;
  const int np = b.np;
  double A[kMaxAug * kMaxAug] = {};
  double floor[6] = {};
  double ss = 0.0;
  double J[6 * kMaxAug];
  for (int k = 0; k < count; ++k) {
    double rm[3], vm[3];
    if (!at(b, t[k], rm, vm, J)) return false;
    const double e[3] = {rm[0] - r[3 * k], rm[1] - r[3 * k + 1], rm[2] - r[3 * k + 2]};
    ss += e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
    double u[3];
    to_uvw(rm, vm, e, u);
    floor[0] += u[0] * u[0];
    floor[1] += u[1] * u[0];
    floor[2] += u[1] * u[1];
    floor[3] += u[2] * u[0];
    floor[4] += u[2] * u[1];
    floor[5] += u[2] * u[2];
    for (int a = 0; a < np; ++a)
      for (int c = 0; c <= a; ++c) A[a * np + c] += J[0 * np + a] * J[0 * np + c] + J[1 * np + a] * J[1 * np + c] + J[2 * np + a] * J[2 * np + c];
  }
  const int nres = 3 * count;
  if (nres <= np) return false;
  // km^2 per residual component: the data variance the fit weighted with, so that P_p is the inverse curvature of the
  // cost the fit minimized (SPEC 12.1); the post-fit residual variance where the fit weighed at 1 km
  const double s2 = sigma_km > 0.0 ? sigma_km * sigma_km : ss / static_cast<double>(nres - np);
  if (!(s2 > 0.0)) return false;
  for (int a = 0; a < np; ++a)
    for (int c = 0; c <= a; ++c) A[c * np + a] = A[a * np + c] = A[a * np + c] / s2;
  // the fit's priors (fit::priors_of, the statement fit::run's cost reads): each one pseudo-observation of its own sigma
  fit::PriorTerm priors[3];
  for (int q = 0, n_priors = fit::priors_of(o, priors); q < n_priors; ++q) {
    const int a = priors[q].index;
    if (a < np) A[a * np + a] += 1.0 / (priors[q].sigma * priors[q].sigma);
  }
  double Pp[kMaxAug * kMaxAug];
  if (!spd_inverse(A, np, Pp)) return false;
  // the process noise and the floor's scale of the set's regime (SPEC 12.4, 12.5)
  s = Set{};
  double floor_scale = 1.0;
  const double span_h = (t[count - 1] - t[0]) / 60.0;
  if (!noise_of(row, arc_end_min, sigma_km, span_h, ng_rate, s.regime, s.noise, s.share, floor_scale)) return false;
  s.ng_rate = ng_rate;
  for (double& f : floor) f = f / static_cast<double>(count) * floor_scale;
  // the low table's fast side (SPEC 12.5, 16.1): the radial floor's sigma times kFloorRadialFastSide, D F D with
  // D = diag(f, 1, 1) in UVW (UU by f^2, VU and WU by f), in the DRAG regime (perigee below kDragRegimeKm), where the
  // factor is fitted and judged
  if (s.regime == 0 && low_fast_side(row)) {
    const double f = kFloorRadialFastSide;
    floor[0] *= f * f;
    floor[1] *= f;
    floor[3] *= f;
  }
  // epoch image: state block J0 Pp J0^T + floor, cross J0 Pp, consider Pp
  double r0[3], v0[3];
  if (!at(b, 0.0, r0, v0, J)) return false;
  s.row = row;
  s.o = o;
  s.np = np;
  for (int i = 0; i < 6; ++i)
    for (int c = 6; c < np; ++c) {
      double jp = 0.0;
      for (int a = 0; a < np; ++a) jp += J[i * np + a] * Pp[a * np + c];
      s.C[i * np + c] = s.C[c * np + i] = jp;  // the epoch state with consider c
    }
  double S6[36] = {};
  for (int i = 0; i < 6; ++i)
    for (int j = 0; j < 6; ++j) {
      double v = 0.0;
      for (int a = 0; a < np; ++a)
        for (int c = 0; c < np; ++c) v += J[i * np + a] * Pp[a * np + c] * J[j * np + c];
      S6[i * 6 + j] = v;
    }
  // SPEC 12.4: the epoch floor at the state every reader takes it off at (epoch_floor: an AP record's at the two-body
  // state of the mean elements it writes)
  s.ap = ap;
  if (!epoch_floor(row, ap, floor, r0, v0, S6)) return false;
  for (int i = 0; i < 6; ++i)
    for (int j = 0; j < 6; ++j) s.C[i * np + j] = 0.5 * (S6[i * 6 + j] + S6[j * 6 + i]);
  for (int a = 6; a < np; ++a)
    for (int c = 6; c < np; ++c) s.C[a * np + c] = Pp[a * np + c];
  // a term the fit estimated as its log: the posterior of ln B (ln AGOM) carried to B (AGOM) by the Jacobian (the delta
  // method, sigma_B = B sigma_lnB), its rows and columns times the term; the set's consider rows are in m^2/kg
  for (int c = 6; c < np; ++c) {
    const bool log_term = (b.kind[c] == kKindDrag && o.drag_log) || (b.kind[c] == kKindSrp && o.agom_log);
    if (!log_term) continue;
    s.log_sigma[b.kind[c] - 6] = std::sqrt(Pp[c * np + c]);
    const double scale = b.kind[c] == kKindDrag ? row.bterm : row.agom;
    for (int i = 0; i < np; ++i) {
      s.C[i * np + c] *= scale;
      s.C[c * np + i] *= scale;  // the diagonal term twice: scale squared
    }
  }
  s.o.drag_log = 0;
  s.o.agom_log = 0;
  for (int k = 0; k < 6; ++k) s.floor[k] = floor[k];
  return true;
}

/// The model the process noise of a set comes from (COV_REALISM[0].MODEL_ID) and its regime's name (REGIME).
inline const char* noise_model_id() { return xpt::tess::active().tesseral || xpt::tess::active().zonal ? "sdn-ap AP process noise" : "sdn-ap SGP4XP process noise"; }
inline const char* regime_name(int regime) { return regime == 0 ? "DRAG" : "ABOVE"; }

/// s_d against c |ng_rate| n (n in rad/day), relative: the invariant of COV_PROPAGATION under the drag. Above the drag
/// s_d is the record's own statement (this module writes k |AGOM| / a, SPEC 12.5): finite and not negative.
inline bool noise_invariant(const ElementRow& row, const Set& s) {
  if (regime_of(row) == 1) return std::isfinite(s.noise[3]) && s.noise[3] >= 0.0;
  const double n_day = row.mean_motion_rev_day * kTwoPi;
  const double want = s.share * std::fabs(s.ng_rate) * n_day;
  return std::fabs(s.noise[3] - want) <= 1e-12 * std::fmax(std::fabs(s.noise[3]), std::fabs(want));
}

/// The covariance of an $OCM set (COVARIANCE_DATA, COV_PARAMETER_KINDS with OD_DYNAMIC_PARAMETERS' SOLVED_FOR, and
/// COV_PROPAGATION) on top of its decoded row. 1 read, 0 no COVARIANCE_DATA, -1 malformed (COV_TYPE other than
/// CARTPV, COV_ORDERING other than LTM, COV_SIZE not 6 plus the kinds, a kind outside the five of SPEC 17.1, out of
/// their fixed order or not solved for, values other than N(N+1)/2, no COV_PROPAGATION), -2 a kind UNSPECIFIED, -3
/// NOISE_NON_GRAVITATIONAL_RAD_DAY2 not NON_GRAVITATIONAL_SHARE x |NON_GRAVITATIONAL_RATE_PER_DAY| x n within 1e-12
/// relative, -4 an AP record whose epoch floor is not at its mean elements' two-body state (written before
/// kEpochFloorSince or by another producer, SPEC 12.4: its covariance refused by name, kFloorRefusal, its states flown).
/// A row the theories have no sensitivity to (DRAG_AREA_OVER_MASS_RATE, IN_TRACK_ACCELERATION, OUTGASSING_ACCELERATION)
/// is read as a constant parameter.
inline int read(const OCM* o, const ElementRow& row, Set& s) {
  s = Set{};
  s.row = row;
  const OCMMeanElements* me = o->MEAN_ELEMENTS();
  s.ap = me != nullptr && me->MEAN_ELEMENT_THEORY() == meanElementSource_AP;
  const auto* cv = o->COVARIANCE_DATA();
  if (cv == nullptr || cv->size() == 0) return 0;
  if ((o->COV_TYPE() != nullptr && std::strcmp(o->COV_TYPE()->c_str(), "CARTPV") != 0) || o->COV_ORDERING() != covarianceOrdering_LTM) return -1;
  const auto* kinds = o->COV_PARAMETER_KINDS();
  const uint32_t nk = kinds == nullptr ? 0 : kinds->size();
  if (nk > static_cast<uint32_t>(kMaxConsider) || o->COV_SIZE() != 6 + nk) return -1;
  // the rows in the fixed order, each a parameter the determination solved for (OD_DYNAMIC_PARAMETERS by PARAMETER,
  // SOLVED_FOR)
  int last = 5;
  for (uint32_t k = 0; k < nk; ++k) {
    const int parameter = kinds->Get(k);
    if (parameter == prwDynamicParameter_UNSPECIFIED) return -2;
    const int kind = kind_of(parameter);
    if (kind <= last) return -1;
    last = kind;
    bool solved = false;
    if (o->ORBIT_DETERMINATION() != nullptr && o->ORBIT_DETERMINATION()->OD_DYNAMIC_PARAMETERS() != nullptr)
      for (const OCMDynamicParameter* p : *o->ORBIT_DETERMINATION()->OD_DYNAMIC_PARAMETERS())
        if (p != nullptr && p->PARAMETER() == parameter) solved = p->SOLVED_FOR();
    if (!solved) return -1;
    if (kind == kKindDrag) s.o.fit_drag = 1;
    if (kind == kKindDragRate) s.o.fit_bdot = 1;
    if (kind == kKindSrp) s.o.fit_agom = 1;
    if (kind == kKindThrust) s.o.fit_thrust = 1;
    if (kind == kKindOutgassing) s.o.fit_outgassing = 1;
  }
  const uint32_t N = 6 + nk;
  if (cv->size() != N * (N + 1) / 2) return -1;
  const OCMCovariancePropagation* cp = o->COV_PROPAGATION();
  if (cp == nullptr) return -1;
  int kind[fit::kMaxParams];
  s.np = kinds_of(s.o, kind);
  const int np = s.np;
  // the record's rows are the parameter vector's (params_of order: elements, then the fixed order)
  uint32_t q = 0;
  for (int i = 0; i < np; ++i)
    for (int j = 0; j <= i; ++j) {
      const double v = cv->Get(q++);
      if (!std::isfinite(v)) return -1;
      s.C[i * np + j] = s.C[j * np + i] = v;
    }
  const double floor[6] = {cp->FLOOR_UU_KM2(), cp->FLOOR_VU_KM2(), cp->FLOOR_VV_KM2(), cp->FLOOR_WU_KM2(), cp->FLOOR_WV_KM2(), cp->FLOOR_WW_KM2()};
  for (int k = 0; k < 6; ++k) s.floor[k] = floor[k];
  s.noise[0] = cp->NOISE_ECCENTRICITY_PER_DAY();
  s.noise[1] = cp->NOISE_INCLINATION_PER_DAY();
  s.noise[2] = cp->NOISE_MEAN_MOTION_RELATIVE();
  s.noise[3] = cp->NOISE_NON_GRAVITATIONAL_RAD_DAY2();
  s.noise[4] = cp->NOISE_START_MINUTES();
  s.share = cp->NON_GRAVITATIONAL_SHARE();
  s.ng_rate = cp->NON_GRAVITATIONAL_RATE_PER_DAY();
  if (!noise_invariant(row, s)) return -3;
  // SPEC 12.8: a record that states BTERM's width by a named rule. Width 1: m, the prior's sigma and the cap derived from
  // the record's own fields (its elements, ACTUAL_OD_SPAN, its atmosphere) and checked against the entry's text; then the
  // formal variance mapped in place of the stated one: where the cap does not bind, 1 / s_f^2 = m^2 (1 / s^2 - 1 / s_p^2)
  // + 1 / s_p^2; where it binds, the formal sigma the entry states, checked to reach the cap. Any other rule, or a text
  // that does not match, maps the matrix as stated and says so.
  if (o->COV_REALISM() != nullptr)
    for (const CVR* cr : *o->COV_REALISM()) {
      if (cr == nullptr || cr->MODEL_ID() == nullptr) continue;
      const char* id = cr->MODEL_ID()->c_str();
      const size_t pl = std::strlen(kWidthTagPrefix);
      if (std::strncmp(id, kWidthTagPrefix, pl) != 0) continue;
      const char* why = nullptr;
      int at = -1;
      for (int a = 6; a < np; ++a)
        if (kind[a] == kKindDrag) at = a;
      const Perturbations* pt = o->PERTURBATIONS();
      const bool msis = pt != nullptr && pt->ATMOSPHERIC_MODEL() != nullptr && pt->ATMOSPHERIC_MODEL()->MODEL() == AtmosphericModelFamily_NRLMSIS00E &&
                        pt->ATMOSPHERIC_MODEL()->YEAR() == 2000;
      const double span_h = o->ORBIT_DETERMINATION() != nullptr ? o->ORBIT_DETERMINATION()->ACTUAL_OD_SPAN() * 24.0 : 0.0;
      double m = 0.0, sp = 0.0, cap = 0.0, formal = 0.0;
      const char* mark = std::strstr(id, kWidthCappedMark);
      if (mark != nullptr) formal = std::strtod(mark + std::strlen(kWidthCappedMark), nullptr);
      char expected[200];
      if (std::strncmp(id + pl, "1:", 2) != 0) why = "a rule this reader does not know";
      else if (at < 0 || !(row.bterm > 0.0)) why = "no BTERM row";
      else if (!width1_of(row, span_h, msis, m, sp, cap)) why = "the record is outside the rule";
      else if (mark != nullptr && !(formal > 0.0 && std::isfinite(formal))) why = "the entry's formal sigma does not read";
      else {
        width1_text(m, sp, cap, formal, expected, sizeof expected);
        if (std::strcmp(id, expected) != 0) why = "the entry's figures are not the rule's for this record";
      }
      if (why == nullptr) {
        const double b2 = row.bterm * row.bterm, sh2 = s.C[at * np + at] / b2, sp2 = sp * sp;
        double var_f = 0.0;
        if (mark != nullptr) {
          bool capped = false;
          width1_stated(formal * formal, m, sp, cap, capped);
          if (!capped || std::fabs(sh2 - cap * cap) > 1e-9 * cap * cap) why = "the stated width is not the cap the entry names";
          else var_f = formal * formal;
        } else {
          const double inv_f = m * m * (1.0 / sh2 - 1.0 / sp2) + 1.0 / sp2;
          if (!(inv_f > 0.0) || !(sh2 > 0.0) || sh2 > cap * cap * (1.0 + 1e-9)) why = "the stated width does not invert";
          else var_f = 1.0 / inv_f;
        }
        if (why == nullptr) {
          s.width_index = at;
          s.width_stated = s.C[at * np + at];
          s.C[at * np + at] = b2 * var_f;
        }
      }
      if (why != nullptr) std::snprintf(s.width_note, sizeof s.width_note, "covariance: %s: mapped as stated (%s)", id, why);
      break;
    }
  // SPEC 12.4: an AP record's floor at its writer's theory state cannot be taken off at this build's
  if (s.ap && !floor_at_mean_elements(o)) return -4;
  return 1;
}

/// A set ready to give its covariance at any time: the bank and the parameter covariance.
struct Propagator {
  Bank b;
  Set s;
  double Pp[kMaxAug * kMaxAug] = {};
  ~Propagator() { release(b); }
};

/// 0 ready; -3 the theory refuses the set or a moved one; -5 the epoch columns are singular. The floor comes off the
/// epoch covariance at the state the writer put it on at (SPEC 12.4: an AP set's at the two-body state of its mean
/// elements); the floor at every time (eval) is the flown state's.
inline int prepare(const Set& s, Propagator& p, xpt::XpSat* nominal = nullptr) {
  p.s = s;
  if (!init(s.row, s.o, p.b, nominal)) return -3;
  const int np = p.b.np;
  double J[6 * kMaxAug], r0[3], v0[3];
  if (!at(p.b, 0.0, r0, v0, J)) return -3;
  // the epoch covariance less the floor, in the state block
  double C[kMaxAug * kMaxAug];
  for (int q = 0; q < np * np; ++q) C[q] = s.C[q];
  double F[36] = {};
  if (!epoch_floor(s.row, s.ap, s.floor, r0, v0, F)) return -3;
  for (int i = 0; i < 6; ++i)
    for (int j = 0; j < 6; ++j) C[i * np + j] -= F[i * 6 + j];
  // T: parameters from (epoch state, consider): the inverse of the epoch element columns
  double Jx[36], inv[36];
  for (int i = 0; i < 6; ++i)
    for (int j = 0; j < 6; ++j) Jx[i * 6 + j] = J[i * np + j];
  if (!inverse6(Jx, inv)) return -5;
  double T[kMaxAug * kMaxAug] = {};
  for (int i = 0; i < 6; ++i) {
    for (int j = 0; j < 6; ++j) T[i * np + j] = inv[i * 6 + j];
    for (int c = 6; c < np; ++c) {
      double v = 0.0;
      for (int k = 0; k < 6; ++k) v -= inv[i * 6 + k] * J[k * np + c];
      T[i * np + c] = v;
    }
  }
  for (int c = 6; c < np; ++c) T[c * np + c] = 1.0;
  double TC[kMaxAug * kMaxAug] = {};
  for (int i = 0; i < np; ++i)
    for (int j = 0; j < np; ++j) {
      double v = 0.0;
      for (int k = 0; k < np; ++k) v += T[i * np + k] * C[k * np + j];
      TC[i * np + j] = v;
    }
  for (int i = 0; i < np; ++i)
    for (int j = 0; j < np; ++j) {
      double v = 0.0;
      for (int k = 0; k < np; ++k) v += TC[i * np + k] * T[j * np + k];
      p.Pp[i * np + j] = v;
    }
  for (int i = 0; i < np; ++i)
    for (int j = 0; j < i; ++j) p.Pp[i * np + j] = p.Pp[j * np + i] = 0.5 * (p.Pp[i * np + j] + p.Pp[j * np + i]);
  return 0;
}

/// The state (TEME km, km/s) and its 6 x 6 covariance (row-major; km^2, km^2/s, km^2/s^2) at `t` minutes from epoch.
/// SPEC 12.4, for test/epoch-floor.e2e.mjs: a prepared set's epoch floor in parts, 150 doubles in `out`: the state the
/// floor comes off at (6: the two-body state of an AP record, else the theory's epoch state), the flown epoch state (6),
/// F there and F at the flown state (36 each, 6 x 6 row-major) and the epoch covariance's state block less the first (36).
inline bool epoch_floor_parts(Propagator& p, double* out) {
  const Set& s = p.s;
  double J[6 * kMaxAug], r0[3], v0[3];
  if (!at(p.b, 0.0, r0, v0, J)) return false;
  double rf[3], vf[3];
  if (!epoch_floor_at(s.row, s.ap, r0, v0, rf, vf)) return false;
  double Ff[36] = {}, F0[36] = {};
  add_floor(s.floor, rf, vf, Ff);
  add_floor(s.floor, r0, v0, F0);
  for (int k = 0; k < 3; ++k) { out[k] = rf[k]; out[3 + k] = vf[k]; out[6 + k] = r0[k]; out[9 + k] = v0[k]; }
  for (int q = 0; q < 36; ++q) { out[12 + q] = Ff[q]; out[48 + q] = F0[q]; }
  for (int i = 0; i < 6; ++i)
    for (int j = 0; j < 6; ++j) out[84 + i * 6 + j] = s.C[i * s.np + j] - Ff[i * 6 + j];
  return true;
}

inline bool eval(Propagator& p, double t, double r[3], double v[3], double* P, double* J_out = nullptr, int32_t* nom_status = nullptr) {
  const int np = p.b.np;
  double J_buf[6 * kMaxAug];
  double* J = J_out != nullptr ? J_out : J_buf;
  if (!at(p.b, t, r, v, J, nom_status)) return false;
  const bool fast_ap = xpt::is_ap_ctx(p.b.sats[0].ctx);
  if (fast_ap) {
    double JP[6][kMaxAug];
    for (int i = 0; i < 6; ++i) {
      const double* const Ji = J + i * np;
#ifdef __wasm_simd128__
      int c = 0;
      for (; c + 1 < np; c += 2) {
        v128_t acc = wasm_f64x2_splat(0.0);
        for (int a = 0; a < np; ++a) {
          acc = wasm_f64x2_add(acc, wasm_f64x2_mul(wasm_f64x2_splat(Ji[a]), wasm_v128_load(p.Pp + a * np + c)));
        }
        wasm_v128_store(JP[i] + c, acc);
      }
      if (c < np) {
        double acc = 0.0;
        for (int a = 0; a < np; ++a) acc += Ji[a] * p.Pp[a * np + c];
        JP[i][c] = acc;
      }
#else
      for (int c = 0; c < np; ++c) {
        double acc = 0.0;
        for (int a = 0; a < np; ++a) acc += Ji[a] * p.Pp[a * np + c];
        JP[i][c] = acc;
      }
#endif
    }
    for (int i = 0; i < 6; ++i) {
      const double* const JPi = JP[i];
      for (int j = 0; j <= i; ++j) {
        const double* const Jj = J + j * np;
        double s = 0.0;
        for (int c = 0; c < np; ++c) s += JPi[c] * Jj[c];
        P[i * 6 + j] = P[j * 6 + i] = s;
      }
    }
  } else {
    for (int i = 0; i < 6; ++i)
      for (int j = 0; j <= i; ++j) {
        double s = 0.0;
        for (int a = 0; a < np; ++a) {
          double ja = 0.0;
          for (int c = 0; c < np; ++c) ja += p.Pp[a * np + c] * J[j * np + c];
          s += J[i * np + a] * ja;
        }
        P[i * 6 + j] = P[j * 6 + i] = s;
      }
  }
  // process noise (SPEC 12.5): rate errors constant from the end of the fit arc (from the epoch backward before it)
  const double t_a = p.s.noise[4];
  const double start = t > t_a ? t_a : t < 0.0 ? 0.0 : t;
  const double d = (t - start) / kMinutesPerDay;  // days, signed
  if (d != 0.0) {
    const double n_min = p.b.x[5], n_day = n_min * kMinutesPerDay;
    auto add = [&](const double* g) {
      for (int i = 0; i < 6; ++i)
        for (int j = 0; j < 6; ++j) P[i * 6 + j] += g[i] * g[j];
    };
    double g[6];
    // eccentricity and inclination vectors: d p = s d per component
    const double sizes[4] = {p.s.noise[0], p.s.noise[0], p.s.noise[1], p.s.noise[1]};
    for (int k = 0; k < 4; ++k) {
      if (sizes[k] == 0.0) continue;
      for (int i = 0; i < 6; ++i) g[i] = J[i * np + k] * sizes[k] * d;
      add(g);
    }
    // mean longitude: d lambda = s_l n d
    if (p.s.noise[2] != 0.0) {
      for (int i = 0; i < 6; ++i) g[i] = J[i * np + 4] * p.s.noise[2] * n_day * d;
      add(g);
    }
    // non-gravitational n-dot: d n(t) = s_d d, d lambda(t) = s_d d^2 / 2, as the epoch lambda0 and n that give them at t
    if (p.s.noise[3] != 0.0) {
      const double dn0 = p.s.noise[3] * d / kMinutesPerDay;  // rad/min
      const double dl0 = 0.5 * p.s.noise[3] * d * d - t * dn0;
      for (int i = 0; i < 6; ++i) g[i] = J[i * np + 4] * dl0 + J[i * np + 5] * dn0;
      add(g);
    }
  }
  add_floor(p.s.floor, r, v, P, fast_ap);
  for (int i = 0; i < 6; ++i)
    for (int j = 0; j < i; ++j) P[i * 6 + j] = P[j * 6 + i] = 0.5 * (P[i * 6 + j] + P[j * 6 + i]);
  return true;
}

/// The augmented covariance at `t` (SPEC 17.5): the state (TEME km, km/s) and the np x np covariance (row-major) of
/// the state and the record's parameter rows, np = COV_SIZE: the state block as eval gives it (the process noise and
/// the floor included), the state-parameter block J(t) P_p[:, c] and the parameter block P_p, constant in time (a
/// parameter the theories have no sensitivity to keeps its variance, its cross terms carried by the state columns).
inline bool eval_full(Propagator& p, double t, double r[3], double v[3], double* P) {
  const int np = p.b.np;
  double S6[36], J[6 * kMaxAug];
  if (!eval(p, t, r, v, S6, J)) return false;
  for (int i = 0; i < 6; ++i)
    for (int j = 0; j < 6; ++j) P[i * np + j] = S6[i * 6 + j];
  for (int i = 0; i < 6; ++i)
    for (int c = 6; c < np; ++c) {
      double x = 0.0;
      for (int a = 0; a < np; ++a) x += J[i * np + a] * p.Pp[a * np + c];
      P[i * np + c] = P[c * np + i] = x;
    }
  for (int a = 6; a < np; ++a)
    for (int c = 6; c < np; ++c) P[a * np + c] = p.Pp[a * np + c];
  // a width stated and not mapped (SPEC 12.8): the parameter block states the record's own BTERM variance
  if (p.s.width_index >= 6 && p.s.width_index < np) P[p.s.width_index * np + p.s.width_index] = p.s.width_stated;
  return true;
}

}  // namespace cov
}  // namespace sdnap
