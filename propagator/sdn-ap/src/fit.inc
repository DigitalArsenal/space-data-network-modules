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
// The cost is sum |e_k|^2 / sigma_r^2 plus the priors (SPEC 12.1): sigma_r the
// data's own sigma per position component, from the fit's residual scatter
// (reweight), never the unit of the residual.
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

struct Result {
  int32_t status;       ///< 0 converged, 1 stopped at the iteration limit, < 0 refused (-4 a parameter not modeled)
  int32_t iterations;
  double rms_km;        ///< position rms over the samples
  double max_km;
};

/// SPEC 12.1, the weighting: the data term of the cost is sum |e_k|^2 / sigma_r^2, sigma_r (km, per TEME position
/// component) the data's own sigma. A fit's first pass weighs at kUnitSigmaKm; reweight() then redoes it at
/// sigma_r = max(s, stated, kDataSigmaFloorKm), s the pass's residual scatter, until sigma_r moves by at most
/// kSigmaTolerance of the sigma the pass weighted with (at most kSigmaPasses passes). Below the floor, a millimeter, the
/// residual is the theory's arithmetic, not the data.
constexpr double kUnitSigmaKm = 1.0;
constexpr double kDataSigmaFloorKm = 1e-6;
constexpr double kSigmaTolerance = 0.1;
constexpr int kSigmaPasses = 8;
/// A pass weighted at the data sigma has its cost in chi-square units: it has converged when a step lowers the cost by
/// less than this (a move of about 0.001 posterior sigma), as well as by less than 1e-10 of it.
constexpr double kChiSquareTolerance = 1e-6;
/// With the consider block (Consider) the scale moves B along the (ln B, in-track) valley slowly: up to this many passes,
/// until sigma_r moves by at most 1 % of the sigma the pass weighted with.
constexpr int kSigmaPassesConsider = 40;
constexpr double kSigmaToleranceConsider = 0.01;

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

inline bool residuals(const ElementRow& row, const double* t, const double* r, int count, double* res) {
  Elements e = elements_of(row);
  xpt::XpSat* s = static_cast<xpt::XpSat*>(std::malloc(sizeof(xpt::XpSat)));
  if (s == nullptr) return false;
  bool ok = xpt::xp_init(e, *s) == kPropOk;
  for (int k = 0; ok && k < count; ++k) {
    double rm[3], vm[3];
    if (xpt::xp_propagate(*s, t[k], rm, vm) != kPropOk) { ok = false; break; }
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

/// The parameter vector of a row: af, ag, chi, psi, lambda0, n, then in the fixed order [drag], [drag rate], [agom],
/// [thrust], [outgassing]; the drag and AGOM terms as their natural logs under drag_log / agom_log. A parameter the
/// theories have no sensitivity to holds 0 (a row carries no value for it; a covariance set's constant row).
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
}

/// SPEC 12.1, the theory's rate errors as consider parameters (an AP fit): the residual's covariance is
/// R = sigma^2 (I + G K^2 G^T), G five columns built from the element columns of the Jacobian with time counted from the
/// end of the arc (tau = t - t_end): an in-track rate-of-rate (1/2 tau^2 dr/dlambda + tau (dr/dn - t dr/dlambda), per
/// km/day^2 of in-track acceleration), the eccentricity-vector rates (tau dr/daf, tau dr/dag, per km/day of a de) and the
/// inclination-vector rates (tau dr/dchi, tau dr/dpsi, per km/day); K = diag(kappa_n, kappa_e, kappa_e, kappa_i, kappa_i)
/// their sizes per unit sigma. The fit minimizes min_c [|rho + G c|^2 + c^T K^-2 c] / sigma^2 plus the priors: the normal
/// matrix is the parameters' plus the five c, and everything scales with sigma, so on exact data the block vanishes.
constexpr int kConsider = 5;
constexpr int kMaxAugmented = kMaxParams + kConsider;
struct Consider {
  bool on = false;
  bool free = false;           ///< no penalty on c (K infinite): the calibration of kappa
  double kappa[3] = {};        ///< per unit sigma: in-track rate-of-rate (1/day^2), e-vector and i-vector rates (1/day)
  double t_end_min = 0.0;      ///< the columns' time origin, minutes from the epoch: the fit arc's end
  // out of run(): the profiled consider coefficients at the solution and the profiled residual sum
  double c[kConsider] = {};    ///< km/day^2, then km/day x 4
  double rss_km2 = 0.0;
  // the hold rule's outcome (fit_oem): a term held at its prior mean, and the prior sigma its covariance row carries
  bool held_drag = false, held_agom = false;
  double held_drag_sigma = 0.0, held_agom_sigma = 0.0;
};

/// The consider columns' contribution of one position component: `Jc` the component's element columns (km per unit of
/// af, ag, chi, psi, lambda0 in rad, n in rad/min, contiguous), at t minutes from the epoch; `g` receives the five values
/// (km per unit c).
inline void consider_row(const double* Jc, double t_min, double t_end_min, double a_km, double g[kConsider]) {
  const double tau = (t_min - t_end_min) / kMinutesPerDay;  // days
  const double dn0 = tau / (a_km * kMinutesPerDay);         // rad/min of n per km/day^2, at t
  g[0] = Jc[5] * dn0 + Jc[4] * (0.5 * tau * tau / a_km - t_min * dn0);
  g[1] = Jc[0] * tau / a_km;
  g[2] = Jc[1] * tau / a_km;
  g[3] = Jc[2] * tau / a_km;
  g[4] = Jc[3] * tau / a_km;
}

/// The consider penalty 1 / kappa^2 of each of the five c (0 when free).
inline void consider_weights(const Consider& cons, double k_inv2[kConsider]) {
  const double k[kConsider] = {cons.kappa[0], cons.kappa[1], cons.kappa[1], cons.kappa[2], cons.kappa[2]};
  for (int i = 0; i < kConsider; ++i) k_inv2[i] = cons.free || !(k[i] > 0.0) ? 0.0 : 1.0 / (k[i] * k[i]);
}

/// The kappa table: per calibration orbit (semi-major axis km, eccentricity, inclination deg) the rate-error sizes per
/// unit sigma at arc lengths T (days), measured by test/consider-calibration.mjs on the project's own controlled truth
/// (propagator/ffm: EGM96 70 x 70 below a = 9,000 km and 31 x 31 above, the Sun and the Moon from DE440, no drag, no
/// radiation pressure; four epochs, 2026-06-20 to 10-03; every window of 1, 2, 3 and 5 days ending on a whole day of 11
/// days): kappa_n = rms(c_n) / rms(sigma), kappa_e and kappa_i the same of the vector rates' magnitudes. The windows, the
/// builds' SHA-256 and the truth's are in test/results/consider-calibration.json.
struct KappaNode {
  double a_km, e, inc_deg;
  int nt;
  double T[6], kn[6], ke[6], ki[6];
};
constexpr KappaNode kKappaNodes[] = {
    {6778.0, 0.001, 28.5, 4, {1, 2, 3, 5}, {29.7, 2.35, 1.2, 0.49}, {1.96, 1.17, 1.09, 0.979}, {0.672, 0.349, 0.313, 0.275}},  // leo-400-28
    {6928.0, 0.0012, 53, 4, {1, 2, 3, 5}, {4.42, 2.81, 2.38, 1.44}, {1.62, 0.753, 0.579, 0.452}, {0.525, 0.171, 0.164, 0.157}},  // leo-550-53
    {7028.0, 0.001, 97.9, 4, {1, 2, 3, 5}, {13.4, 4.61, 1.09, 0.668}, {1.01, 0.275, 0.184, 0.187}, {0.629, 0.219, 0.125, 0.0679}},  // leo-650-98
    {7128.0, 0.0011, 74, 4, {1, 2, 3, 5}, {9.25, 2.27, 0.981, 0.759}, {0.997, 0.437, 0.337, 0.302}, {0.598, 0.152, 0.0729, 0.0457}},  // leo-750-74
    {7278.0, 0.001, 99, 4, {1, 2, 3, 5}, {9.3, 4.11, 3.98, 3.48}, {0.775, 0.302, 0.219, 0.168}, {0.685, 0.286, 0.261, 0.235}},  // leo-900-99
    {7478.0, 0.0009, 89, 4, {1, 2, 3, 5}, {4.14, 1.38, 0.979, 0.334}, {0.316, 0.0811, 0.0707, 0.07}, {0.399, 0.138, 0.0949, 0.0767}},  // leo-1100-89
    {7878.0, 0.001, 52, 4, {1, 2, 3, 5}, {3.98, 0.552, 0.191, 0.0997}, {0.393, 0.213, 0.137, 0.0668}, {0.253, 0.0819, 0.0396, 0.0291}},  // leo-1500-52
    {7450.0, 0.04, 63, 4, {1, 2, 3, 5}, {12.4, 2.21, 1.37, 0.407}, {0.714, 0.495, 0.453, 0.432}, {0.156, 0.119, 0.105, 0.102}},  // leo-e04-63
    {8878.0, 0.001, 70, 4, {1, 2, 3, 5}, {2.26, 0.382, 0.18, 0.0407}, {0.283, 0.112, 0.0579, 0.0135}, {0.131, 0.0767, 0.0495, 0.0444}},  // leo-2500-70
    {11378.0, 0.004, 110, 4, {1, 2, 3, 5}, {2.02, 0.277, 0.0992, 0.0441}, {0.608, 0.131, 0.0511, 0.0241}, {0.887, 0.163, 0.0823, 0.0885}},  // meo-5000-110
    {16378.0, 0.002, 45, 4, {1, 2, 3, 5}, {4.97, 0.443, 0.179, 0.0885}, {0.84, 0.17, 0.0909, 0.0666}, {0.292, 0.0772, 0.0692, 0.0723}},  // meo-10000-45
    {23000.0, 0.002, 40, 4, {1, 2, 3, 5}, {30.6, 4.72, 1.38, 1.26}, {0.618, 0.24, 0.134, 0.105}, {0.242, 0.0981, 0.0635, 0.0564}},  // meo-23000-40
    {27900.0, 0.003, 52, 4, {1, 2, 3, 5}, {4.57, 0.975, 0.336, 0.273}, {1.31, 0.185, 0.171, 0.131}, {0.229, 0.151, 0.147, 0.131}},  // meo-27900-52
    {42164.0, 0.0004, 2, 4, {1, 2, 3, 5}, {61.4, 3.64, 3.59, 3.34}, {9.64, 0.518, 0.435, 0.36}, {4.17, 1.53, 1.32, 1.13}},  // geo-2
    {42164.0, 0.002, 30, 4, {1, 2, 3, 5}, {90.9, 4.71, 4.06, 3.44}, {12, 0.833, 0.655, 0.442}, {2, 1.31, 1.21, 1}},  // geo-30
    {42164.0, 0.07, 43, 4, {1, 2, 3, 5}, {141, 1.39, 1.07, 0.869}, {12.5, 0.589, 0.474, 0.371}, {0.974, 0.685, 0.658, 0.566}},  // geo-e07-43
};
/// The kernel widths: in ln a, inclination (deg) and eccentricity.
constexpr double kKappaWidthLnA = 0.05, kKappaWidthInc = 20.0, kKappaWidthE = 0.1;

/// kappa (n, e, i) of an orbit and an arc of `arc_days`: at each calibration orbit linear in ln kappa against ln T
/// (held at the end values outside the calibrated arcs), then a Gaussian kernel over (ln a, i, e) about the calibration
/// orbits, normalized: continuous in every argument, so no class boundary moves the weighting by a step.
inline void consider_kappa(double a_km, double e, double inc_deg, double arc_days, double kappa[3]) {
  constexpr int nn = static_cast<int>(sizeof kKappaNodes / sizeof kKappaNodes[0]);
  double d2[nn], dmin = 1e300;
  for (int j = 0; j < nn; ++j) {
    const KappaNode& q = kKappaNodes[j];
    const double da = std::log(a_km / q.a_km) / kKappaWidthLnA, di = (inc_deg - q.inc_deg) / kKappaWidthInc, de = (e - q.e) / kKappaWidthE;
    d2[j] = da * da + di * di + de * de;
    dmin = std::fmin(dmin, d2[j]);
  }
  const double lt = std::log(std::fmax(arc_days, 1e-3));
  double acc[3] = {}, sw = 0.0;
  for (int j = 0; j < nn; ++j) {
    const KappaNode& q = kKappaNodes[j];
    const double wj = std::exp(-0.5 * (d2[j] - dmin));
    if (!(wj > 1e-12)) continue;
    const double* tabs[3] = {q.kn, q.ke, q.ki};
    for (int c = 0; c < 3; ++c) {
      double v;
      if (q.nt == 1 || lt <= std::log(q.T[0])) v = std::log(tabs[c][0]);
      else if (lt >= std::log(q.T[q.nt - 1])) v = std::log(tabs[c][q.nt - 1]);
      else {
        int m = 0;
        while (m + 2 < q.nt && lt > std::log(q.T[m + 1])) ++m;
        const double l0 = std::log(q.T[m]), l1 = std::log(q.T[m + 1]), f = (lt - l0) / (l1 - l0);
        v = (1.0 - f) * std::log(tabs[c][m]) + f * std::log(tabs[c][m + 1]);
      }
      acc[c] += wj * v;
    }
    sw += wj;
  }
  for (int c = 0; c < 3; ++c) kappa[c] = std::exp(acc[c] / sw);
}

/// The semi-major axis (km) of a mean motion in rad/min.
inline double semi_major_km(double n_rad_min) { return std::pow(xpt::kKe / n_rad_min, kX2o3) * xpt::kRe; }

/// The finite-difference fallback of run(): where no step along the analytic Jacobian (two-body motion with the J2
/// secular drifts, the drag column through n-dot) lowers the cost, the element and drag columns are taken again by
/// one-sided differences of the theory itself before the fit stops. Set by the caller for the fits that need it (an
/// eccentric orbit's arc of several revolutions, where the analytic columns leave the LM short of the minimum).
inline bool& jacobian_fallback() {
  static bool b = false;
  return b;
}

/// Levenberg-Marquardt. `row` holds the starting set (epoch, theory and the
/// fixed terms) and receives the fitted one. The cost is sum |e_k|^2 / sigma_km^2 plus the priors; `data_sigma` marks
/// sigma_km as the data's own (the cost then in chi-square units, kChiSquareTolerance its stop). With `cons` on, the
/// residual sum is the profiled min_c |e + G c|^2 + c^T K^-2 c and the normal matrix carries the five c (Consider);
/// cons->c and cons->rss_km2 receive them at the solution.
inline Result run(ElementRow& row, const double* t, const double* r, int count, const Options& o, double sigma_km = kUnitSigmaKm,
                  bool data_sigma = false, Consider* cons = nullptr) {
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
  double* jac = static_cast<double*>(std::malloc(sizeof(double) * nres * kMaxParams));
  auto release = [&]() { std::free(res); std::free(trial); std::free(jac); };
  if (res == nullptr || trial == nullptr || jac == nullptr) {
    release();
    out.status = -1;
    return out;
  }
  const bool prior = o.fit_drag && o.drag_sigma > 0.0;
  const int agom_index = o.fit_drag ? 7 : 6;
  const bool agom_prior = o.fit_agom && o.agom_sigma > 0.0;
  const double w = 1.0 / (sigma_km * sigma_km);  // the data's weight, 1 / sigma_r^2 (km^-2)
  // the consider block: G (nres x 5, built each iteration from the analytic element columns), its Gram matrix with the
  // penalty, GG = G^T G + K^-2 (5 x 5)
  const bool cons_on = cons != nullptr && cons->on;
  double* gcol = cons_on ? static_cast<double*>(std::calloc(static_cast<size_t>(nres) * kConsider, sizeof(double))) : nullptr;
  if (cons_on && gcol == nullptr) {
    release();
    out.status = -1;
    return out;
  }
  double k_inv2[kConsider] = {}, GG[kConsider * kConsider] = {};
  if (cons_on) consider_weights(*cons, k_inv2);
  // the profiled residual sum of rr: min_c |rr + G c|^2 + c^T K^-2 c = rr.rr + c.b, b = G^T rr, c = -GG^-1 b
  auto profiled = [&](const double* rr, double* c_out) {
    double ss = 0.0;
    for (int i = 0; i < nres; ++i) ss += rr[i] * rr[i];
    if (!cons_on) return ss;
    double b[kConsider] = {}, M[kConsider * kConsider], c[kConsider];
    for (int i = 0; i < nres; ++i)
      for (int q = 0; q < kConsider; ++q) b[q] += gcol[i * kConsider + q] * rr[i];
    for (int q = 0; q < kConsider * kConsider; ++q) M[q] = GG[q];
    for (int q = 0; q < kConsider; ++q) c[q] = -b[q];
    if (!solve(M, c, kConsider)) return ss;
    double cb = 0.0;
    for (int q = 0; q < kConsider; ++q) cb += c[q] * b[q];
    if (c_out != nullptr)
      for (int q = 0; q < kConsider; ++q) c_out[q] = c[q];
    return ss + cb;
  };
  auto cost_of = [&](const double* rr, const double* xx) {
    double c = profiled(rr, nullptr) * w;
    if (prior) {
      const double d = (xx[6] - o.drag_prior) / o.drag_sigma;
      c += d * d;
    }
    if (agom_prior) {
      const double d = (xx[agom_index] - o.agom_prior) / o.agom_sigma;
      c += d * d;
    }
    return c;
  };
  ElementRow work = row;
  row_of(x, o, work);
  if (!residuals(work, t, r, count, res)) {
    release();
    std::free(gcol);
    out.status = -2;
    return out;
  }
  double cost = cost_of(res, x);  // with the consider block, set again once its columns exist (each iteration)
  const int na = np + (cons_on ? kConsider : 0);
  double mu = 1e-3;
  bool converged = false;
  int it = 0;
  int fd_used = 0;
  for (; it < max_it && !converged; ++it) {
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
    if (cons_on) {
      // the consider columns from this iteration's analytic element columns (the theory's own columns, six more flights an
      // iteration, moved B by under 0.3 % on the exact-model rows), then the cost on them
      const double a_km = semi_major_km(x[5]);
      for (int k = 0; k < count; ++k)
        for (int c = 0; c < 3; ++c)
          consider_row(&jac[(3 * k + c) * kMaxParams], t[k], cons->t_end_min, a_km, &gcol[(3 * k + c) * kConsider]);
      for (int q = 0; q < kConsider * kConsider; ++q) GG[q] = 0.0;
      for (int i = 0; i < nres; ++i)
        for (int p = 0; p < kConsider; ++p)
          for (int q = 0; q <= p; ++q) GG[p * kConsider + q] += gcol[i * kConsider + p] * gcol[i * kConsider + q];
      for (int p = 0; p < kConsider; ++p) {
        GG[p * kConsider + p] += k_inv2[p];
        for (int q = 0; q < p; ++q) GG[q * kConsider + p] = GG[p * kConsider + q];
      }
      cost = cost_of(res, x);
    }
    // the element and drag columns by one-sided differences of the theory (the fall-back below; with the consider block
    // on every iteration: the block takes the analytic columns' quadratic and rate shapes, so what separates BTERM from
    // it is the part of the theory's own drag signature they do not carry, which the analytic column gets wrong)
    auto fd_columns = [&]() {
      const int analytic = o.fit_drag ? 7 : 6;
      for (int a = 0; a < analytic; ++a) {
        // (with the consider block the drag step is 0.1 % of the term, so the column's own curvature does not set where the
        // fit stops)
        const double h = a < 5 ? 1e-7 : a == 5 ? 1e-7 * std::fabs(x[5])
                       : cons_on ? (o.drag_log ? 1e-3 : std::fmax(1e-3 * std::fabs(x[6]), 1e-7))
                                 : std::fabs(x[6]) * 0.01 > 1e-5 ? std::fabs(x[6]) * 0.01 : 1e-5;
        double xh[kMaxParams];
        for (int q = 0; q < np; ++q) xh[q] = x[q];
        xh[a] += h;
        ElementRow bumped = work;
        row_of(xh, o, bumped);
        if (!residuals(bumped, t, r, count, trial)) return false;
        for (int i = 0; i < nres; ++i) jac[i * kMaxParams + a] = (trial[i] - res[i]) / h;
      }
      return true;
    };
    if (cons_on && jacobian_fallback()) fd_columns();
    if (o.fit_agom) {
      ElementRow bumped = work;
      const double step = std::fabs(work.agom) * 0.01 > 1e-4 ? std::fabs(work.agom) * 0.01 : 1e-4;
      // the theory reads AGOM <= 0 as no radiation pressure: an AP fit (the consider estimator) at AGOM <= 0 takes the
      // slope on the side where the term acts, from 0, so the hold rule never reads the flat side as no information
      bumped.agom = (cons_on && !o.agom_log ? std::fmax(work.agom, 0.0) : work.agom) + step;
      const NominalSat nominal(work);
      xpt::GridShareScope share(nominal.s);  // SPEC 16.11: the column's copy reads the iteration's nominal grids
      if (residuals(bumped, t, r, count, trial)) {
        if (o.agom_log)  // per unit ln AGOM: AGOM times the column per unit AGOM
          for (int i = 0; i < nres; ++i) jac[i * kMaxParams + agom_index] = work.agom * ((trial[i] - res[i]) / step);
        else
          for (int i = 0; i < nres; ++i) jac[i * kMaxParams + agom_index] = (trial[i] - res[i]) / step;
      }
    }
    // the normal matrix, na x na: the parameters, then (with the consider block) the five c, every row in units of the
    // cost (the data over sigma^2, the c penalty K^-2 over sigma^2, the priors as they are)
    double A[kMaxAugmented * kMaxAugmented] = {}, g[kMaxAugmented] = {};
    auto normal = [&]() {
    for (int q = 0; q < kMaxAugmented * kMaxAugmented; ++q) A[q] = 0.0;
    for (int q = 0; q < kMaxAugmented; ++q) g[q] = 0.0;
    for (int i = 0; i < nres; ++i) {
      for (int a = 0; a < np; ++a) {
        g[a] -= jac[i * kMaxParams + a] * res[i];
        for (int b = 0; b <= a; ++b) A[a * na + b] += jac[i * kMaxParams + a] * jac[i * kMaxParams + b];
      }
      if (cons_on)
        for (int q = 0; q < kConsider; ++q) {
          const double gq = gcol[i * kConsider + q];
          g[np + q] -= gq * res[i];
          for (int a = 0; a < np; ++a) A[(np + q) * na + a] += gq * jac[i * kMaxParams + a];
        }
    }
    if (cons_on)
      for (int p = 0; p < kConsider; ++p)
        for (int q = 0; q <= p; ++q) A[(np + p) * na + np + q] = GG[p * kConsider + q];
    for (int a = 0; a < na; ++a) {
      g[a] *= w;
      for (int b = 0; b <= a; ++b) A[a * na + b] *= w;
    }
    if (prior) {
      A[6 * na + 6] += 1.0 / (o.drag_sigma * o.drag_sigma);
      g[6] -= (x[6] - o.drag_prior) / (o.drag_sigma * o.drag_sigma);
    }
    if (agom_prior) {
      A[agom_index * na + agom_index] += 1.0 / (o.agom_sigma * o.agom_sigma);
      g[agom_index] -= (x[agom_index] - o.agom_prior) / (o.agom_sigma * o.agom_sigma);
    }
    for (int a = 0; a < na; ++a)
      for (int b = 0; b < a; ++b) A[b * na + a] = A[a * na + b];
    };
    normal();
    bool improved = false;
    auto attempt = [&]() {
    for (int tries = 0; tries < 12 && !improved; ++tries) {
      double M[kMaxAugmented * kMaxAugmented], dx[kMaxAugmented];
      for (int a = 0; a < na * na; ++a) M[a] = A[a];
      for (int a = 0; a < na; ++a) {
        if (a < np) M[a * na + a] *= (1.0 + mu);  // the damping on the parameters; the c are linear
        dx[a] = g[a];
      }
      if (solve(M, dx, na)) {
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
    if (!improved && jacobian_fallback() && !cons_on && fd_used < 2) {
      ++fd_used;
      // the element and drag columns by one-sided differences of the theory, then the same trial
      if (fd_columns()) {
        normal();
        mu = 1e-3;
        attempt();
      }
    }
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
  out.status = converged ? 0 : 1;
  if (cons_on) cons->rss_km2 = profiled(res, cons->c);
  release();
  std::free(gcol);
  return out;
}

/// The number of parameters of options `o` (params_of): the six elements and those of the dynamical terms it carries.
inline int param_count(const Options& o) {
  return 6 + (o.fit_drag ? 1 : 0) + (o.fit_bdot ? 1 : 0) + (o.fit_agom ? 1 : 0) + (o.fit_thrust ? 1 : 0) + (o.fit_outgassing ? 1 : 0);
}

/// SPEC 12.1: the data sigma of a fit over `count` states (km per TEME position component): max(s, stated_km,
/// kDataSigmaFloorKm), s = sqrt(sum |e_k|^2 / (3N - dim p)) the post-fit residual scatter and stated_km the input's
/// own sigma (0: none stated).
inline double data_sigma_km(const Result& res, int count, const Options& o, double stated_km) {
  const int dof = 3 * count - param_count(o);
  const double s = dof > 0 ? res.rms_km * std::sqrt(static_cast<double>(count) / dof) : res.rms_km;
  return std::fmax(std::fmax(s, stated_km), kDataSigmaFloorKm);
}

/// SPEC 12.1: the fit at the data's own sigma. `row` and `res` hold a fit weighted at `sigma_km`; while its data sigma
/// differs from `sigma_km` by more than kSigmaTolerance of it, the fit is redone from the last set at the data sigma (at
/// most kSigmaPasses times). `row`, `res` and `sigma_km` take the last fit, whose iterations add to `iterations`; a
/// refit the theory refuses leaves the one before.
inline void reweight(ElementRow& row, const double* t, const double* r, int count, const Options& o, double stated_km, Result& res,
                     double& sigma_km, int& iterations, Consider* cons = nullptr) {
  // near the minimum the analytic columns (two-body motion, J2 secular, the drag column through n-dot) stop short of
  // it once the data outweigh the priors: these passes take the theory's own columns where no analytic step helps
  struct FallbackScope {
    bool prev;
    FallbackScope() : prev(jacobian_fallback()) { jacobian_fallback() = true; }
    ~FallbackScope() { jacobian_fallback() = prev; }
  } fallback_scope;
  const bool with_c = cons != nullptr && cons->on;
  const int dof = 3 * count - param_count(o);
  // with the consider block the scale is that of the profiled residual sum, sigma^2 = min_c [...] / (3N - dim p), and the
  // first pass always runs (the stages before it carry no block)
  auto sigma_of = [&](bool profiled_rss) {
    if (!profiled_rss) return data_sigma_km(res, count, o, stated_km);
    const double s = std::sqrt(std::fmax(cons->rss_km2, 0.0) / (dof > 0 ? dof : 1));
    return std::fmax(std::fmax(s, stated_km), kDataSigmaFloorKm);
  };
  const int passes = with_c ? kSigmaPassesConsider : kSigmaPasses;
  const double tolerance = with_c ? kSigmaToleranceConsider : kSigmaTolerance;
  bool profiled_rss = false;
  for (int pass = 0; pass < passes; ++pass) {
    const double next = sigma_of(profiled_rss);
    if (!(with_c && pass == 0) && std::fabs(next - sigma_km) <= tolerance * sigma_km) return;
    ElementRow trial = row;
    const Result again = run(trial, t, r, count, o, next, true, with_c ? cons : nullptr);
    iterations += again.iterations;
    if (again.status < 0) return;
    row = trial;
    res = again;
    sigma_km = next;
    profiled_rss = with_c;
  }
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
