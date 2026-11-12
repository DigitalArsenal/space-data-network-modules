// -----------------------------------------------------------------------------
// fit: an ephemeris (TEME states at minutes from a reference epoch) to an
// element set of the SGP4XP theory by Levenberg-Marquardt.
//
// The residuals are the theory's own (each iteration ingests the trial set and
// propagates it to every sample); the Jacobian is analytic: the exact
// derivatives, by forward-mode differentiation, of the two-body motion with
// the J2 secular drift of the node, the perigee and the mean longitude, in the
// equinoctial elements of SPEC 1.5, plus the drag column through the
// mean-motion rate per unit B. Priors (DESIGN 2e.3) enter as extra rows.
// The cost is sum |e_k|^2 / sigma^2 plus the priors (SPEC 12.1): sigma is 1 km
// in the staged passes and, for a set above the drag, the data's own sigma in
// the passes of reweight().
// -----------------------------------------------------------------------------

namespace sdnap {
namespace fit {

/// Forward-mode dual number with up to 11 partials: the six elements and the five dynamical parameters (SPEC 17.1).
constexpr int kMaxParams = 11;
struct Dual {
  double v;
  double d[kMaxParams];
};
inline Dual dconst(double v) { Dual r{}; r.v = v; return r; }
inline Dual dvar(double v, int k) { Dual r{}; r.v = v; r.d[k] = 1.0; return r; }
inline Dual operator+(Dual a, Dual b) { Dual r{}; r.v = a.v + b.v; for (int k = 0; k < kMaxParams; ++k) r.d[k] = a.d[k] + b.d[k]; return r; }
inline Dual operator-(Dual a, Dual b) { Dual r{}; r.v = a.v - b.v; for (int k = 0; k < kMaxParams; ++k) r.d[k] = a.d[k] - b.d[k]; return r; }
inline Dual operator*(Dual a, Dual b) { Dual r{}; r.v = a.v * b.v; for (int k = 0; k < kMaxParams; ++k) r.d[k] = a.d[k] * b.v + a.v * b.d[k]; return r; }
inline Dual operator*(double s, Dual a) { Dual r{}; r.v = s * a.v; for (int k = 0; k < kMaxParams; ++k) r.d[k] = s * a.d[k]; return r; }
inline Dual operator/(Dual a, Dual b) {
  Dual r{};
  r.v = a.v / b.v;
  for (int k = 0; k < kMaxParams; ++k) r.d[k] = (a.d[k] * b.v - a.v * b.d[k]) / (b.v * b.v);
  return r;
}
inline Dual dsqrt(Dual a) { Dual r{}; r.v = std::sqrt(a.v); for (int k = 0; k < kMaxParams; ++k) r.d[k] = a.d[k] / (2.0 * r.v); return r; }
inline Dual dsin(Dual a) { Dual r{}; r.v = std::sin(a.v); const double c = std::cos(a.v); for (int k = 0; k < kMaxParams; ++k) r.d[k] = c * a.d[k]; return r; }
inline Dual dcos(Dual a) { Dual r{}; r.v = std::cos(a.v); const double s = -std::sin(a.v); for (int k = 0; k < kMaxParams; ++k) r.d[k] = s * a.d[k]; return r; }
inline Dual dpow(Dual a, double p) { Dual r{}; r.v = std::pow(a.v, p); const double dv = p * std::pow(a.v, p - 1.0); for (int k = 0; k < kMaxParams; ++k) r.d[k] = dv * a.d[k]; return r; }

/// Two-body position (ER) of mean equinoctial elements y (af, ag, chi, psi,
/// lambda0, n) at t minutes with the J2 secular rates and a mean-motion rate
/// ndot (rad/min^2): the model whose derivatives form the Jacobian.
inline void model_position(const Dual* y, double t, Dual ndot, Dual out[3]) {
  using namespace xpt;
  const Dual af = y[0], ag = y[1], chi = y[2], psi = y[3], lam0 = y[4], n = y[5];
  const Dual a = dpow(dconst(kKe) / n, kX2o3);
  const Dual e2 = af * af + ag * ag;
  const Dual eta = dsqrt(dconst(1.0) - e2);
  const Dual t2 = chi * chi + psi * psi;
  const Dual ci = (dconst(1.0) - t2) / (dconst(1.0) + t2);
  const Dual p = a * eta * eta;
  const Dual k2n = (0.75 * kJ2) * n / (p * p);
  // J2 secular: node, perigee and mean-longitude drifts
  const Dual nodedot = dconst(-2.0) * k2n * ci;
  const Dual argpdot = k2n * (dconst(5.0) * ci * ci - dconst(1.0));
  const Dual mdot = n + k2n * eta * (dconst(3.0) * ci * ci - dconst(1.0));
  const Dual tt = dconst(t);
  const Dual dO = nodedot * tt, dvarpi = (argpdot + nodedot) * tt;
  // rotate the e-vector by dvarpi and the inclination vector by dO
  const Dual cv = dcos(dvarpi), sv = dsin(dvarpi), cO = dcos(dO), sO = dsin(dO);
  const Dual k = af * cv - ag * sv, h = af * sv + ag * cv;
  const Dual q = psi * cO - chi * sO, pp = psi * sO + chi * cO;  // psi = q, chi = p
  const Dual lam = lam0 + (mdot + argpdot + nodedot) * tt + 0.5 * ndot * tt * tt;
  // eccentric longitude
  double Fv = lam.v;
  for (int it = 0; it < 30; ++it) {
    const double f = Fv + h.v * std::cos(Fv) - k.v * std::sin(Fv) - lam.v;
    const double fp = 1.0 - h.v * std::sin(Fv) - k.v * std::cos(Fv);
    const double dF = f / fp;
    Fv -= dF;
    if (std::fabs(dF) < 1e-15) break;
  }
  // implicit derivative: dF = (dlam - cos F dh + sin F dk) / (1 - h sin F - k cos F)
  const double cF = std::cos(Fv), sF = std::sin(Fv);
  const double den = 1.0 - h.v * sF - k.v * cF;
  Dual F{};
  F.v = Fv;
  for (int j = 0; j < kMaxParams; ++j) F.d[j] = (lam.d[j] - cF * h.d[j] + sF * k.d[j]) / den;
  const Dual cFd = dcos(F), sFd = dsin(F);
  const Dual beta = dconst(1.0) / (dconst(1.0) + eta);
  const Dual X = a * ((dconst(1.0) - h * h * beta) * cFd + h * k * beta * sFd - k);
  const Dual Y = a * ((dconst(1.0) - k * k * beta) * sFd + h * k * beta * cFd - h);
  const Dual C = dconst(1.0) + pp * pp + q * q;
  const Dual fx = (dconst(1.0) - pp * pp + q * q) / C, fy = dconst(2.0) * pp * q / C, fz = dconst(-2.0) * pp / C;
  const Dual gx = dconst(2.0) * pp * q / C, gy = (dconst(1.0) + pp * pp - q * q) / C, gz = dconst(2.0) * q / C;
  out[0] = X * fx + Y * gx;
  out[1] = X * fy + Y * gy;
  out[2] = X * fz + Y * gz;
}

/// Fit options (56 bytes, sdnap_fit). A parameter with its `_log` flag set is estimated as its natural log ($PCF
/// FIT.DRAG_PRIOR_FORM / SRP_PRIOR_FORM LOG_NORMAL): the iteration steps in the log, so the parameter is never <= 0,
/// and its prior mean and sigma are those of the log (the mean the log of the median). fit_bdot, fit_thrust and
/// fit_outgassing (one byte each after fit_agom) ask for DRAG_AREA_OVER_MASS_RATE, IN_TRACK_ACCELERATION and
/// OUTGASSING_ACCELERATION: the theories have no sensitivity to them and the force model does not change (SPEC 17.2),
/// so a fit with one set is refused parameter-not-modeled:<NAME>. In a covariance set (covariance.inc) the same flags
/// mark the record's constant-parameter rows.
struct Options {
  int32_t fit_drag;        ///< fit B (SGP4XP BTERM)
  int32_t max_iterations;  ///< 0: 30
  double drag_prior;       ///< prior mean of the drag term (DESIGN 2e.3); of ln B under drag_log
  double drag_sigma;       ///< its sigma; <= 0: no prior
  int32_t fit_agom;        ///< fit AGOM (its column by a finite difference of the theory)
  int8_t fit_bdot;         ///< DRAG_AREA_OVER_MASS_RATE (m^2/kg/s): refused, not modeled
  int8_t fit_thrust;       ///< IN_TRACK_ACCELERATION (m/s^2): refused, not modeled
  int8_t fit_outgassing;   ///< OUTGASSING_ACCELERATION (km/s^2): refused, not modeled
  int8_t fit_y0;           ///< SPEC 16.13: an AP set's radiation term Y0 (ECOM2_Y0), the fit method's only (fit_oem, $PCF
                           ///< FORCES.ECOM2; prior y0_prior()); sdnap_fit refuses it (its rows do not carry Y0)
  double agom_prior;       ///< prior mean of AGOM; of ln AGOM under agom_log
  double agom_sigma;       ///< its sigma; <= 0: no prior
  int32_t drag_log;        ///< 1: the drag parameter is ln B (B > 0 at the start)
  int32_t agom_log;        ///< 1: the AGOM parameter is ln AGOM (AGOM > 0 at the start)
};
static_assert(sizeof(Options) == 56, "fit Options are 56 bytes");

/// The first parameter a fit asks for that the theories have no sensitivity to (DRAG_AREA_OVER_MASS_RATE,
/// IN_TRACK_ACCELERATION, OUTGASSING_ACCELERATION, in the fixed order), or nullptr.
inline const char* not_modeled(const Options& o) {
  if (o.fit_bdot) return "DRAG_AREA_OVER_MASS_RATE";
  if (o.fit_thrust) return "IN_TRACK_ACCELERATION";
  if (o.fit_outgassing) return "OUTGASSING_ACCELERATION";
  return nullptr;
}

/// The refusal code of options `o` (parameter-not-modeled:<NAME>), or nullptr when the fit runs.
inline const char* refusal(const Options& o) {
  if (o.fit_bdot) return "parameter-not-modeled:DRAG_AREA_OVER_MASS_RATE";
  if (o.fit_thrust) return "parameter-not-modeled:IN_TRACK_ACCELERATION";
  if (o.fit_outgassing) return "parameter-not-modeled:OUTGASSING_ACCELERATION";
  return nullptr;
}

/// SPEC 16.25: the pass stopped because one of its Jacobian columns could not be differenced in either direction (both sets
/// refused as decayed inside the arc): no step was tested, so it is not converged.
constexpr int32_t kColumnRefused = 2;

struct Result {
  int32_t status;       ///< 0 converged, 1 stopped at the iteration limit, 2 kColumnRefused, < 0 refused (-4 a parameter
                        ///< not modeled, -5 kBranchLimit)
  int32_t iterations;
  double rms_km;        ///< position rms over the samples
  double max_km;
  bool held_at_switch = false;  ///< SPEC 16.7: the set is held at an eccentricity switch on its own branch (run)
};

/// SPEC 12.1, the weighting: the data term of the cost is sum |e_k|^2 / sigma^2, sigma in km per TEME position
/// component. The staged passes weigh at kUnitSigmaKm. For a set above the drag, reweight() then redoes the whole-arc
/// fit at the data's own sigma, sigma_r = max(s, stated, kDataSigmaFloorKm), s the pass's residual scatter, until
/// sigma_r moves by at most kSigmaTolerance of the sigma the pass weighted with (at most kSigmaPasses passes). Below
/// the floor, a millimeter, the residual is the theory's arithmetic, not the data.
constexpr double kUnitSigmaKm = 1.0;
constexpr double kDataSigmaFloorKm = 1e-6;
constexpr double kSigmaTolerance = 0.1;
constexpr int kSigmaPasses = 8;
/// A pass weighted at the data's sigma has its cost in chi-square units: it has converged when a step lowers the cost
/// by less than this (a move of about 0.001 posterior sigma), as well as by less than 1e-10 of it.
constexpr double kChiSquareTolerance = 1e-6;
/// SPEC 12.1, the iteration ceiling of a pass. A pass ends when it converges (above), or at its ceiling with the cost still
/// falling, the record then stating CONVERGED false. A fit that solves no drag term (the set above the drag, or a drag term
/// its prior holds, fitoem::drag_held) has kPassCeiling a pass, which no measured fit reaches; a fit that solves a drag term
/// keeps kDragPassCeiling, the ceiling of every version before: there the cost is flat along the drag term, so the iteration
/// count, not the data, picks the point (stack #541). g_ceiling_met counts the passes that ended at a ceiling: [0] at
/// kPassCeiling, [1] at any other (kDragPassCeiling, or an sdnap_fit caller's own).
constexpr int kPassCeiling = 1000;
constexpr int kDragPassCeiling = 40;
inline uint32_t g_ceiling_met[2] = {0, 0};

/// Residuals of the trial row: model minus observed, km, 3 per sample.
/// SPEC 16.11: an iteration's nominal set, held while its copies are built inside its xpt::GridShareScope (nullptr when it does not
/// initialize: its copies then take their own grids).
struct NominalSat {
  xpt::XpSat* s = nullptr;
  explicit NominalSat(const ElementRow& row) {
    s = static_cast<xpt::XpSat*>(std::malloc(sizeof(xpt::XpSat)));
    if (s != nullptr && xpt::xp_init(elements_of(row), *s) != kPropOk) { std::free(s); s = nullptr; }
  }
  ~NominalSat() {
    if (s != nullptr) { xpt::xp_release(*s); std::free(s); }
  }
  NominalSat(const NominalSat&) = delete;
  NominalSat& operator=(const NominalSat&) = delete;
};

/// `ap_decayed`, when given, is set where the set was refused as decayed inside the arc (SPEC 16.25: an AP set that crosses the
/// rule); any other refusal, and every SGP4XP one, leaves it false.
inline bool residuals(const ElementRow& row, const double* t, const double* r, int count, double* res, bool* ap_decayed = nullptr) {
  Elements e = elements_of(row);
  xpt::XpSat* s = static_cast<xpt::XpSat*>(std::malloc(sizeof(xpt::XpSat)));
  if (s == nullptr) return false;
  if (ap_decayed != nullptr) *ap_decayed = false;
  bool ok = xpt::xp_init(e, *s) == kPropOk;
  for (int k = 0; ok && k < count; ++k) {
    double rm[3], vm[3];
    const int32_t st = xpt::xp_propagate(*s, t[k], rm, vm);
    if (st != kPropOk) {
      if (ap_decayed != nullptr && st == kPropDecayed && xpt::is_ap_ctx(s->ctx)) *ap_decayed = true;
      ok = false;
      break;
    }
    for (int j = 0; j < 3; ++j) res[3 * k + j] = rm[j] - r[3 * k + j];
  }
  xpt::xp_release(*s);
  std::free(s);
  return ok;
}

/// Solve the symmetric positive system A x = b (n <= kMaxParams) by Cholesky.
inline bool solve(double* A, double* b, int n) {
  for (int j = 0; j < n; ++j) {
    double d = A[j * n + j];
    for (int k = 0; k < j; ++k) d -= A[j * n + k] * A[j * n + k];
    if (!(d > 0.0)) return false;
    d = std::sqrt(d);
    A[j * n + j] = d;
    for (int i = j + 1; i < n; ++i) {
      double s = A[i * n + j];
      for (int k = 0; k < j; ++k) s -= A[i * n + k] * A[j * n + k];
      A[i * n + j] = s / d;
    }
  }
  for (int i = 0; i < n; ++i) {
    double s = b[i];
    for (int k = 0; k < i; ++k) s -= A[i * n + k] * b[k];
    b[i] = s / A[i * n + i];
  }
  for (int i = n - 1; i >= 0; --i) {
    double s = b[i];
    for (int k = i + 1; k < n; ++k) s -= A[k * n + i] * b[k];
    b[i] = s / A[i * n + i];
  }
  return true;
}

/// SPEC 16.13: Y0's unit in the parameter vector, m/s^2 (the normal matrix stays conditioned: an arc's column per unit is
/// of the order of the elements').
constexpr double kY0Unit = 1e-9;

/// SPEC 16.13: Y0's prior, in kY0Unit: mean the value FORCES.ECOM2 states (Y0_M_S2, the start), sigma kY0PriorSigma. Set by
/// the fit method for its call (fit_oem); one value for every fit of the call.
struct Y0Prior {
  double mean = 0.0, sigma = 1.0;
};
inline Y0Prior& y0_prior() {
  static Y0Prior p;
  return p;
}

/// The parameter vector of a row: af, ag, chi, psi, lambda0, n, then in the fixed order [drag], [drag rate], [agom],
/// [thrust], [outgassing], [Y0]; the drag and AGOM terms as their natural logs under drag_log / agom_log, Y0 in kY0Unit.
/// A parameter the theories have no sensitivity to holds 0 (a row carries no value for it; a covariance set's constant
/// row).
inline int params_of(const ElementRow& row, const Options& o, double* x) {
  const double n = row.mean_motion_rev_day * kTwoPi / kMinutesPerDay;
  double y[6];
  xpt::equinoctial_of(n, row.eccentricity, row.inclination_deg * kDeg, row.raan_deg * kDeg,
                      row.arg_pericenter_deg * kDeg, row.mean_anomaly_deg * kDeg, y);
  x[0] = y[xpt::kAf]; x[1] = y[xpt::kAg]; x[2] = y[xpt::kChi]; x[3] = y[xpt::kPsi]; x[4] = y[xpt::kLam]; x[5] = y[xpt::kN];
  int np = 6;
  if (o.fit_drag) x[np++] = o.drag_log ? std::log(row.bterm) : row.bterm;
  if (o.fit_bdot) x[np++] = 0.0;
  if (o.fit_agom) x[np++] = o.agom_log ? std::log(row.agom) : row.agom;
  if (o.fit_thrust) x[np++] = 0.0;
  if (o.fit_outgassing) x[np++] = 0.0;
  if (o.fit_y0 && np < kMaxParams) x[np++] = radiation_y0(row) / kY0Unit;
  return np;
}

inline void row_of(const double* x, const Options& o, ElementRow& row) {
  double y[6] = {x[0], x[1], x[2], x[3], x[4], x[5]};
  const xpt::Kepler k = xpt::kepler_of(y);
  row.mean_motion_rev_day = x[5] * kMinutesPerDay / kTwoPi;
  row.eccentricity = k.e;
  row.inclination_deg = k.i / kDeg;
  row.raan_deg = k.node / kDeg;
  row.arg_pericenter_deg = k.argp / kDeg;
  row.mean_anomaly_deg = k.m / kDeg;
  int np = 6;
  if (o.fit_drag) {
    const double v = x[np++];
    row.bterm = o.drag_log ? std::exp(v) : v;
  }
  if (o.fit_bdot) ++np;
  if (o.fit_agom) {
    const double v = x[np++];
    row.agom = o.agom_log ? std::exp(v) : v;
  }
  if (o.fit_thrust) ++np;
  if (o.fit_outgassing) ++np;
  if (o.fit_y0 && np < kMaxParams) radiation_y0(row) = x[np++] * kY0Unit;
}

/// SPEC 12.1: one prior of a fit, a pseudo-observation of the parameter at `index` of the vector (params_of order).
struct PriorTerm {
  int index;
  double mean, sigma;
};
/// The priors of options `o`, in the fixed order (drag, AGOM, Y0), each with its index in the parameter vector: the one
/// statement of the priors that the cost and the normal equations (run_free) and the covariance (cov::of_fit) read.
/// Returns their count (at most 3).
inline int priors_of(const Options& o, PriorTerm* out) {
  int n = 0, np = 6;
  if (o.fit_drag) {
    if (o.drag_sigma > 0.0) out[n++] = {np, o.drag_prior, o.drag_sigma};
    ++np;
  }
  if (o.fit_bdot) ++np;
  if (o.fit_agom) {
    if (o.agom_sigma > 0.0) out[n++] = {np, o.agom_prior, o.agom_sigma};
    ++np;
  }
  if (o.fit_thrust) ++np;
  if (o.fit_outgassing) ++np;
  if (o.fit_y0 && np < kMaxParams && y0_prior().sigma > 0.0) out[n++] = {np, y0_prior().mean, y0_prior().sigma};
  return n;
}

/// The finite-difference fallback of run(): where no step along the analytic Jacobian (two-body motion with the J2
/// secular drifts, the drag column through n-dot) lowers the cost, the element and drag columns are taken again by
/// one-sided differences of the theory itself before the fit stops. Set by the caller for the fits that need it (an
/// eccentric orbit's arc of several revolutions, where the analytic columns leave the LM short of the minimum).
inline bool& jacobian_fallback() {
  static bool b = false;
  return b;
}

/// Levenberg-Marquardt. `row` holds the starting set (epoch, theory and the
/// fixed terms) and receives the fitted one. Each trial set flies its own branch unless a BranchScope pins one (run).
/// The cost is sum |e_k|^2 / sigma_km^2 plus the priors; `data_sigma` marks sigma_km as the data's own (the cost then
/// in chi-square units, kChiSquareTolerance its stop). At kUnitSigmaKm the weight is 1 and every sum is as without it.
inline Result run_free(ElementRow& row, const double* t, const double* r, int count, const Options& o, double sigma_km = kUnitSigmaKm,
                       bool data_sigma = false) {
  Result out{};
  // SPEC 17.2: a parameter the theories have no sensitivity to is refused, never fitted
  if (not_modeled(o) != nullptr) {
    out.status = -4;
    return out;
  }
  // a parameter estimated as its log starts positive (its prior's median)
  if ((o.fit_drag && o.drag_log && !(row.bterm > 0.0)) || (o.fit_agom && o.agom_log && !(row.agom > 0.0))) {
    out.status = -3;
    return out;
  }
  const int nres = 3 * count;
  const int max_it = o.max_iterations > 0 ? o.max_iterations : 30;
  double x[kMaxParams];
  const int np = params_of(row, o, x);
  double* res = static_cast<double*>(std::malloc(sizeof(double) * nres));
  double* trial = static_cast<double*>(std::malloc(sizeof(double) * nres));
  // zeroed: a column whose difference is refused (SPEC 16.25) is never read before it is written
  double* jac = static_cast<double*>(std::calloc(static_cast<size_t>(nres) * kMaxParams, sizeof(double)));
  auto release = [&]() { std::free(res); std::free(trial); std::free(jac); };
  if (res == nullptr || trial == nullptr || jac == nullptr) {
    release();
    out.status = -1;
    return out;
  }
  const int agom_index = o.fit_drag ? 7 : 6;
  // SPEC 16.13: Y0's column follows every other parameter's (params_of)
  const int y0_index = 6 + (o.fit_drag ? 1 : 0) + (o.fit_bdot ? 1 : 0) + (o.fit_agom ? 1 : 0) + (o.fit_thrust ? 1 : 0) + (o.fit_outgassing ? 1 : 0);
  PriorTerm priors[3];
  const int n_priors = priors_of(o, priors);
  const double w = 1.0 / (sigma_km * sigma_km);  // the data's weight, 1 / sigma^2 (km^-2)
  auto cost_of = [&](const double* rr, const double* xx) {
    double c = 0.0;
    for (int i = 0; i < nres; ++i) c += rr[i] * rr[i];
    c *= w;
    for (int q = 0; q < n_priors; ++q) {
      const double d = (xx[priors[q].index] - priors[q].mean) / priors[q].sigma;
      c += d * d;
    }
    return c;
  };
  ElementRow work = row;
  row_of(x, o, work);
  if (!residuals(work, t, r, count, res)) {
    release();
    out.status = -2;
    return out;
  }
  double cost = cost_of(res, x);
  double mu = 1e-3;
  bool converged = false;
  bool stopped_on_column = false;
  bool column_refused = false;
  int it = 0;
  int fd_used = 0;
  for (; it < max_it && !converged; ++it) {
    column_refused = false;
    // n-dot per unit drag term from the theory's own rate function at epoch
    double ndot_per_drag = 0.0;
    if (o.fit_drag) {
      ElementRow probe = work;
      if (probe.bterm == 0.0) probe.bterm = 1e-3;
      Elements e = elements_of(probe);
      xpt::XpSat* s = static_cast<xpt::XpSat*>(std::malloc(sizeof(xpt::XpSat)));
      if (s != nullptr && xpt::xp_init(e, *s) == kPropOk) {
        ElementRow none = probe;
        none.bterm = 0.0;
        Elements e0 = elements_of(none);
        xpt::GridShareScope share(s);  // SPEC 16.11: the drag-free copy reads the probe's grids
        xpt::XpSat* s0 = static_cast<xpt::XpSat*>(std::malloc(sizeof(xpt::XpSat)));
        if (s0 != nullptr && xpt::xp_init(e0, *s0) == kPropOk)
          ndot_per_drag = (s->epoch.f[xpt::kN] - s0->epoch.f[xpt::kN]) / probe.bterm;
        if (s0 != nullptr) xpt::xp_release(*s0);
        std::free(s0);
      }
      if (s != nullptr) xpt::xp_release(*s);
      std::free(s);
    }
    for (int k = 0; k < count; ++k) {
      Dual y[6];
      for (int j = 0; j < 6; ++j) y[j] = dvar(x[j], j);
      Dual ndot = dconst(0.0);
      if (o.fit_drag) {
        // per unit B; per unit ln B (B times it) when the parameter is ln B
        ndot.v = work.bterm * ndot_per_drag;
        ndot.d[6] = o.drag_log ? work.bterm * ndot_per_drag : ndot_per_drag;
      }
      Dual pos[3];
      model_position(y, t[k], ndot, pos);
      const int analytic = o.fit_drag ? 7 : 6;
      for (int c = 0; c < 3; ++c)
        for (int j = 0; j < analytic; ++j) jac[(3 * k + c) * kMaxParams + j] = pos[c].d[j] * xpt::kRe;
    }
    if (o.fit_agom) {
      ElementRow bumped = work;
      const double step = std::fabs(work.agom) * 0.01 > 1e-4 ? std::fabs(work.agom) * 0.01 : 1e-4;
      bumped.agom = work.agom + step;
      const NominalSat nominal(work);
      xpt::GridShareScope share(nominal.s);  // SPEC 16.11: the column's copy reads the iteration's nominal grids
      bool decayed = false;
      double sign = 1.0, used = step;
      bool column_ok = residuals(bumped, t, r, count, trial, &decayed);
      if (!column_ok && decayed) {
        // SPEC 16.25: the bump lies past the decay rule: the difference below the iterate is the same column where the set below is
        // on the iterate's curve: an AGOM at or under 0 switches the radiation off (not a point of the same curve), so the step
        // below is at most half the iterate's AGOM and there is none where the iterate's AGOM is not positive
        const double below = work.agom > 0.0 ? std::fmin(step, 0.5 * work.agom) : 0.0;
        if (below > 0.0) {
          bumped.agom = work.agom - below;
          sign = -1.0;
          used = below;
          column_ok = residuals(bumped, t, r, count, trial);
        }
        if (!column_ok) {
          column_refused = true;
          for (int i = 0; i < nres; ++i) jac[i * kMaxParams + agom_index] = 0.0;
        }
      }
      if (column_ok) {
        if (o.agom_log)  // per unit ln AGOM: AGOM times the column per unit AGOM
          for (int i = 0; i < nres; ++i) jac[i * kMaxParams + agom_index] = work.agom * ((trial[i] - res[i]) / (sign * used));
        else
          for (int i = 0; i < nres; ++i) jac[i * kMaxParams + agom_index] = (trial[i] - res[i]) / (sign * used);
      }
    }
    if (o.fit_y0 && y0_index < np) {
      // SPEC 16.13: Y0's column, as AGOM's: a one-sided difference of the theory each iteration, per kY0Unit
      ElementRow bumped = work;
      const double step = std::fmax(std::fabs(x[y0_index]) * 0.01, 0.1);
      radiation_y0(bumped) = (x[y0_index] + step) * kY0Unit;
      const NominalSat nominal(work);
      xpt::GridShareScope share(nominal.s);  // SPEC 16.11: the column's copy reads the iteration's nominal grids
      bool decayed = false;
      double sign = 1.0;
      bool column_ok = residuals(bumped, t, r, count, trial, &decayed);
      if (!column_ok && decayed) {
        // SPEC 16.25: as AGOM's column, the difference below the iterate
        radiation_y0(bumped) = (x[y0_index] - step) * kY0Unit;
        sign = -1.0;
        column_ok = residuals(bumped, t, r, count, trial);
        if (!column_ok) {
          column_refused = true;
          for (int i = 0; i < nres; ++i) jac[i * kMaxParams + y0_index] = 0.0;
        }
      }
      if (column_ok)
        for (int i = 0; i < nres; ++i) jac[i * kMaxParams + y0_index] = (trial[i] - res[i]) / (sign * step);
    }
    double A[kMaxParams * kMaxParams] = {}, g[kMaxParams] = {};
    auto normal = [&]() {
    for (int q = 0; q < kMaxParams * kMaxParams; ++q) A[q] = 0.0;
    for (int q = 0; q < kMaxParams; ++q) g[q] = 0.0;
    for (int i = 0; i < nres; ++i)
      for (int a = 0; a < np; ++a) {
        g[a] -= jac[i * kMaxParams + a] * res[i];
        for (int b = 0; b <= a; ++b) A[a * np + b] += jac[i * kMaxParams + a] * jac[i * kMaxParams + b];
      }
    for (int a = 0; a < np; ++a) {
      g[a] *= w;
      for (int b = 0; b <= a; ++b) A[a * np + b] *= w;
    }
    for (int q = 0; q < n_priors; ++q) {
      const int i = priors[q].index;
      const double s2 = priors[q].sigma * priors[q].sigma;
      A[i * np + i] += 1.0 / s2;
      g[i] -= (x[i] - priors[q].mean) / s2;
    }
    for (int a = 0; a < np; ++a)
      for (int b = 0; b < a; ++b) A[b * np + a] = A[a * np + b];
    };
    normal();
    bool improved = false;
    auto attempt = [&]() {
    for (int tries = 0; tries < 12 && !improved; ++tries) {
      double M[kMaxParams * kMaxParams], dx[kMaxParams];
      for (int a = 0; a < np * np; ++a) M[a] = A[a];
      for (int a = 0; a < np; ++a) {
        M[a * np + a] *= (1.0 + mu);
        dx[a] = g[a];
      }
      if (solve(M, dx, np)) {
        double xt[kMaxParams];
        for (int a = 0; a < np; ++a) xt[a] = x[a] + dx[a];
        ElementRow cand = work;
        row_of(xt, o, cand);
        if (residuals(cand, t, r, count, trial)) {
          const double c = cost_of(trial, xt);
          if (c < cost) {
            const double drop = cost - c, rel = drop / cost;
            for (int a = 0; a < np; ++a) x[a] = xt[a];
            for (int i = 0; i < nres; ++i) res[i] = trial[i];
            work = cand;
            cost = c;
            mu = mu * 0.3 > 1e-12 ? mu * 0.3 : 1e-12;
            improved = true;
            if (rel < 1e-10 || (data_sigma && drop < kChiSquareTolerance)) converged = true;
            continue;
          }
        }
      }
      mu *= 10.0;
    }
    };
    attempt();
    if (!improved && jacobian_fallback() && fd_used < 2) {
      ++fd_used;
      // the element and drag columns by one-sided differences of the theory, then the same trial
      const int analytic = o.fit_drag ? 7 : 6;
      bool fd_ok = true, decayed_column = false;
      {
        // SPEC 16.7: every moved set flies the iterate's branch (the pinned one inside a settle pass), so no column
        // differences two branches
        const xpt::Branch wb = xpt::g_branch_pin != nullptr ? *xpt::g_branch_pin : row_branch(work);
        const xpt::BranchScope pin(&wb);
        for (int a = 0; a < analytic && fd_ok; ++a) {
          const double h = a < 5 ? 1e-7 : a == 5 ? 1e-7 * std::fabs(x[5]) : std::fabs(x[6]) * 0.01 > 1e-5 ? std::fabs(x[6]) * 0.01 : 1e-5;
          double xh[kMaxParams];
          for (int q = 0; q < np; ++q) xh[q] = x[q];
          xh[a] += h;
          ElementRow bumped = work;
          row_of(xh, o, bumped);
          bool decayed = false;
          fd_ok = residuals(bumped, t, r, count, trial, &decayed);
          if (fd_ok) {
            for (int i = 0; i < nres; ++i) jac[i * kMaxParams + a] = (trial[i] - res[i]) / h;
          } else if (decayed) {
            // SPEC 16.25: the bump lies on the decayed side of the rule (a set that crosses inside the arc is refused), which
            // says nothing about the column: the difference taken below the iterate, (res - trial) / h, is the same column
            // (a refusal elsewhere, and both sides refused, still end the fallback as before)
            xh[a] = x[a] - h;
            ElementRow below = work;
            row_of(xh, o, below);
            fd_ok = residuals(below, t, r, count, trial);
            if (fd_ok)
              for (int i = 0; i < nres; ++i) jac[i * kMaxParams + a] = (res[i] - trial[i]) / h;
            else
              decayed_column = true;
          }
        }
      }
      if (fd_ok) {
        normal();
        mu = 1e-3;
        attempt();
      } else if (decayed_column) {
        column_refused = true;
      }
    }
    // SPEC 16.25: a pass that could not difference a column in either direction tested no step: it is not at a minimum
    // an iteration with a column refused on both sides cannot declare convergence (its small step was taken on a Jacobian without that column)
    if (converged && column_refused) { converged = false; stopped_on_column = true; ++it; break; }
    if (!improved && column_refused) { stopped_on_column = true; ++it; break; }  // the pass made this iteration: counted as a converged pass counts its last
    if (!improved) converged = true;  // no step lowers the cost: at the minimum
  }
  double ss = 0.0, mx = 0.0;
  for (int k = 0; k < count; ++k) {
    const double d = std::sqrt(res[3 * k] * res[3 * k] + res[3 * k + 1] * res[3 * k + 1] + res[3 * k + 2] * res[3 * k + 2]);
    ss += d * d;
    if (d > mx) mx = d;
  }
  row = work;
  out.rms_km = std::sqrt(ss / (count > 0 ? count : 1));
  out.max_km = mx;
  out.iterations = it;
  out.status = converged ? 0 : (stopped_on_column ? kColumnRefused : 1);
  if (!converged && !stopped_on_column) __atomic_fetch_add(&g_ceiling_met[max_it >= kPassCeiling ? 0 : 1], 1u, __ATOMIC_RELAXED);
  release();
  return out;
}

/// SPEC 16.7: a fit whose least-squares set lies on a switch (on each side the best set lies across it).
constexpr int32_t kBranchLimit = -5;
/// SPEC 16.7: a fitted set this close to a switch (relative in n, absolute in e) is on it.
constexpr double kOnSwitch = 1e-8;
/// SPEC 16.7: the set lies on a switch of eccentricity (its branch differs within kOnSwitch below and above its e) and on
/// no limit in n (its branch is its own within kOnSwitch relative below and above its n): a set on both is at a limit in n.
inline bool on_eccentricity_switch_only(const Elements& e) {
  const bool ap = ap_selected();
  const xpt::Branch b = xpt::branch_of(e.xno, e.eo, ap);
  if (xpt::branch_of(e.xno * (1.0 - kOnSwitch), e.eo, ap) != b || xpt::branch_of(e.xno * (1.0 + kOnSwitch), e.eo, ap) != b) return false;
  return xpt::branch_of(e.xno, e.eo > kOnSwitch ? e.eo - kOnSwitch : 0.0, ap) != xpt::branch_of(e.xno, e.eo + kOnSwitch, ap);
}

/// Levenberg-Marquardt with the branch settled (SPEC 16.7: AP's elements are defined per branch, so the objective jumps
/// at a switch and a free fit can stop on it: its trial steps across are refused until it creeps onto the limit, within
/// about 1e-15). Off every switch (more than 1e-8 relative in n, 1e-8 in e) run_free's set as it is, bit for bit. On one,
/// the fit again from that set with every trial set pinned to its branch: when its minimum stays on the
/// branch, the free set stands unless the pinned one's RMS is lower by more than 1e-9 relative (a free fit stalled short
/// of the branch's minimum); a minimum across the switch is fitted again pinned to the branch it reached, and its minimum
/// is the answer when it stays there. Otherwise, at an eccentricity switch with no limit in n near, the free set stands,
/// held at the switch on its own branch (`held_at_switch`; stack #504: the fit ends on one side); at a limit in n, status
/// kBranchLimit, `row` the last set reached. `sigma_km` and `data_sigma` as run_free's.
inline Result run(ElementRow& row, const double* t, const double* r, int count, const Options& o, double sigma_km = kUnitSigmaKm,
                  bool data_sigma = false) {
  Result out = run_free(row, t, r, count, o, sigma_km, data_sigma);
  const Elements e = elements_of(row);
  if (out.status < 0 || xpt::switch_near(e.xno, e.eo, ap_selected(), kOnSwitch, kOnSwitch) == nullptr) return out;
  const ElementRow free_row = row;
  const Result free_out = out;
  xpt::Branch b = row_branch(row);
  for (int pass = 0; pass < 2; ++pass) {
    ElementRow w = row;
    Result res;
    {
      const xpt::BranchScope pin(&b);
      res = run_free(w, t, r, count, o, sigma_km, data_sigma);
    }
    if (res.status < 0) return res;
    const xpt::Branch reached = row_branch(w);
    if (reached == b) {
      if (pass == 0 && !(res.rms_km < out.rms_km * (1.0 - 1e-9))) {
        row = free_row;  // the pinned fit confirms the free one, to the fit's own tolerance
        return out;
      }
      row = w;
      return res;
    }
    row = w;
    b = reached;
    out = res;
  }
  // both branches' least-squares sets lie across the switch. At an eccentricity switch (0.3, or the first-order tesseral
  // families': 0.05 in class 0, 0.3 in every other class) with no limit in n near, the fit ends on one side: the free set,
  // which its refused trial steps hold at the switch on its own branch, stands, and its record's branch is that of its own
  // epoch eccentricity (stack #504)
  if (on_eccentricity_switch_only(elements_of(free_row))) {
    row = free_row;
    out = free_out;
    out.held_at_switch = true;
    return out;
  }
  out.status = kBranchLimit;
  return out;
}

/// The number of parameters of options `o` (params_of): the six elements and those of the dynamical terms it carries
/// (Y0 included: the scatter's degrees of freedom count it).
inline int param_count(const Options& o) {
  return 6 + (o.fit_drag ? 1 : 0) + (o.fit_bdot ? 1 : 0) + (o.fit_agom ? 1 : 0) + (o.fit_thrust ? 1 : 0) + (o.fit_outgassing ? 1 : 0) +
         (o.fit_y0 ? 1 : 0);
}

/// SPEC 12.1: the data's sigma of a fit over `count` states (km per TEME position component): max(s, stated_km,
/// kDataSigmaFloorKm), s = sqrt(sum |e_k|^2 / (3N - dim p)) the post-fit residual scatter and stated_km the input's
/// own sigma (0: none stated).
inline double data_sigma_km(const Result& res, int count, const Options& o, double stated_km) {
  const int dof = 3 * count - param_count(o);
  const double s = dof > 0 ? res.rms_km * std::sqrt(static_cast<double>(count) / dof) : res.rms_km;
  return std::fmax(std::fmax(s, stated_km), kDataSigmaFloorKm);
}

/// SPEC 12.1: the fit at the data's own sigma. `row` and `res` hold a fit weighted at `sigma_km`; while its data sigma
/// differs from `sigma_km` by more than kSigmaTolerance of it, the fit is redone from the last set at the data sigma
/// (at most kSigmaPasses times). `row`, `res` and `sigma_km` take the last fit, whose iterations add to `iterations`;
/// a refit the theory refuses, or one that ends at a limit in n (kBranchLimit), leaves the one before; one held at an
/// eccentricity switch (run's held_at_switch) is kept.
inline void reweight(ElementRow& row, const double* t, const double* r, int count, const Options& o, double stated_km, Result& res,
                     double& sigma_km, int& iterations) {
  // once the data outweigh the priors the analytic columns (two-body motion, the J2 secular drifts, the drag column
  // through n-dot) stop short of the minimum: these passes take the theory's own columns where no analytic step helps
  struct FallbackScope {
    bool prev;
    FallbackScope() : prev(jacobian_fallback()) { jacobian_fallback() = true; }
    ~FallbackScope() { jacobian_fallback() = prev; }
  } fallback_scope;
  for (int pass = 0; pass < kSigmaPasses; ++pass) {
    const double next = data_sigma_km(res, count, o, stated_km);
    if (std::fabs(next - sigma_km) <= kSigmaTolerance * sigma_km) return;
    ElementRow trial = row;
    const Result again = run(trial, t, r, count, o, next, true);
    iterations += again.iterations;
    if (again.status < 0) return;
    row = trial;
    res = again;
    sigma_km = next;
  }
}

/// The named refusal of a fit that ends at kBranchLimit (`row` its last set).
inline int refuse_branch_limit(const ElementRow& row) {
  const Elements e = elements_of(row);
  const char* name = xpt::switch_near(e.xno, e.eo, ap_selected());
  char why[480];
  std::snprintf(why, sizeof why,
                "The arc's least-squares set lies on the %s (mean motion %.10f rev/day, eccentricity %.8f): on each side the "
                "best set lies across it, and AP's elements are defined per branch (SPEC 16.7). Fit another span or epoch "
                "($PCF FIT.DEFAULT_SPAN_HOURS, or the block's USEABLE_START_TIME and USEABLE_STOP_TIME).",
                name != nullptr ? name : "switch", row.mean_motion_rev_day, row.eccentricity);
  plugin_set_error("fit-at-branch-limit", why);
  return 3;
}

/// The two-line text's digits: mean motion 1e-8 rev/day, eccentricity 1e-7,
/// angles 1e-4 deg, BTERM and AGOM five significant digits (+-0.NNNNN+-E).
inline double round_to(double v, double unit) { return std::round(v / unit) * unit; }
inline double exp_unit(double v) {
  if (v == 0.0) return 1e-10;
  const int e = static_cast<int>(std::floor(std::log10(std::fabs(v)))) + 1;
  return std::pow(10.0, e - 5);
}

/// Rounds the fitted set to the two-line text and searches the lattice of the
/// text's digits (coordinate steps of one unit in the last digit) for the
/// representable set of least cost: the set the Space Force library reads.
inline Result tle_lattice(ElementRow& row, const double* t, const double* r, int count, const Options& o) {
  Result out{};
  const int nres = 3 * count;
  std::vector<double> res(nres);
  auto cost = [&](const ElementRow& w) {
    if (!residuals(w, t, r, count, res.data())) return 1e300;
    double c = 0.0;
    for (int i = 0; i < nres; ++i) c += res[i] * res[i];
    return c;
  };
  ElementRow best = row;
  best.mean_motion_rev_day = round_to(row.mean_motion_rev_day, 1e-8);
  best.eccentricity = round_to(row.eccentricity, 1e-7);
  best.inclination_deg = round_to(row.inclination_deg, 1e-4);
  best.raan_deg = round_to(row.raan_deg, 1e-4);
  best.arg_pericenter_deg = round_to(row.arg_pericenter_deg, 1e-4);
  best.mean_anomaly_deg = round_to(row.mean_anomaly_deg, 1e-4);
  best.bterm = round_to(row.bterm, exp_unit(row.bterm));
  best.agom = round_to(row.agom, exp_unit(row.agom));
  // a term its prior pins within one unit of its last digit (the prior's sigma in the term's units, sigma of the log
  // times the term under the log, at most that unit) keeps the fit's value at the text's digits: the search, which
  // weighs the residuals alone, never steps it against its prior
  auto pinned = [&](int32_t fitted, int32_t log_form, double sigma, double value) {
    return fitted && sigma > 0.0 && (log_form ? sigma * std::fabs(value) : sigma) <= exp_unit(value);
  };
  const bool hold_drag = pinned(o.fit_drag, o.drag_log, o.drag_sigma, best.bterm);
  const bool hold_agom = pinned(o.fit_agom, o.agom_log, o.agom_sigma, best.agom);
  double c = cost(best);
  for (int pass = 0; pass < 4; ++pass) {
    bool moved = false;
    for (int k = 0; k < 8; ++k) {
      if (k == 6 && (!o.fit_drag || hold_drag)) continue;
      if (k == 7 && (!o.fit_agom || hold_agom)) continue;
      for (int dir = -1; dir <= 1; dir += 2) {
        ElementRow cand = best;
        switch (k) {
          case 0: cand.mean_motion_rev_day += dir * 1e-8; break;
          case 1: cand.eccentricity += dir * 1e-7; break;
          case 2: cand.inclination_deg += dir * 1e-4; break;
          case 3: cand.raan_deg += dir * 1e-4; break;
          case 4: cand.arg_pericenter_deg += dir * 1e-4; break;
          case 5: cand.mean_anomaly_deg += dir * 1e-4; break;
          case 6: cand.bterm += dir * exp_unit(best.bterm); break;
          default: cand.agom += dir * exp_unit(best.agom); break;
        }
        if (cand.eccentricity < 0.0) continue;
        if ((o.drag_log && !(cand.bterm > 0.0)) || (o.agom_log && !(cand.agom > 0.0))) continue;  // a log-estimated term stays > 0
        const double cc = cost(cand);
        if (cc < c) { c = cc; best = cand; moved = true; }
      }
    }
    if (!moved) break;
  }
  cost(best);
  double ss = 0.0, mx = 0.0;
  for (int kk = 0; kk < count; ++kk) {
    const double d = std::sqrt(res[3 * kk] * res[3 * kk] + res[3 * kk + 1] * res[3 * kk + 1] + res[3 * kk + 2] * res[3 * kk + 2]);
    ss += d * d;
    if (d > mx) mx = d;
  }
  row = best;
  out.rms_km = std::sqrt(ss / (count > 0 ? count : 1));
  out.max_km = mx;
  return out;
}

}  // namespace fit
}  // namespace sdnap
