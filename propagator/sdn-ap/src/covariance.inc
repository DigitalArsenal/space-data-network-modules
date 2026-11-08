// -----------------------------------------------------------------------------
// Covariance (SPEC 12): the fit's covariance carried forward by the theory's own state transition matrix.
//
// - The fit (fit_oem.inc, SGP4XP theory) forms the normal matrix of its parameters at the solution, every column a
//   central difference of the theory itself, with its priors; the inverse, the measurement variance being the post-fit
//   residual variance, is the parameter covariance. Its image at epoch (TEME position and velocity, then the solved
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
//   is COV_PROPAGATION's NOISE_* fields, with the share c and the rate it is a share of.
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
  b.sats = static_cast<xpt::XpSat*>(std::calloc(static_cast<size_t>(total), sizeof(xpt::XpSat)));
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

/// A covariance-bearing set: the row, its parameter layout, the epoch covariance (COVARIANCE, 6 x 6, the floor
/// included), the consider rows, the floor and the process noise.
struct Set {
  ElementRow row{};
  fit::Options o{};
  int np = 0;
  double C[kMaxAug * kMaxAug] = {};  ///< augmented epoch covariance (np x np): state block total, then the parameters
  double log_sigma[kMaxConsider] = {};  ///< of_fit: the posterior sigma of ln B ([0]), ln AGOM ([2]) where the fit estimated the log (else 0)
  double floor[6] = {};
  double noise[5] = {};              ///< s_e, s_i (1/day), s_l (dn/n), s_d (rad/day^2), the noise start t_a (min)
  double share = 0.0;                ///< c, the share of the non-gravitational n-dot that is error
  double ng_rate = 0.0;              ///< n-dot_ng / n at epoch, 1/day: s_d = c |ng_rate| n
  int regime = 0;                    ///< 0 drag, 1 above (of_fit)
};

/// The process noise of a set (SPEC 12.5): its regime (0 perigee below kDragRegimeKm, 1 above), the non-gravitational
/// n-dot / n at epoch (1/day; the theory's epoch rates with and without BTERM) and the sizes s_e, s_i, s_l, s_d
/// with the noise start t_a (minutes), and the floor's scale k_F. False when the theory refuses the set.
inline bool noise_of(const ElementRow& row, double t_a, double& ng_rate, int& regime, double* noise, double& share, double& floor_scale) {
  ng_rate = 0.0;
  ElementRow none = row;
  none.bterm = 0.0;
  xpt::XpSat* s1 = static_cast<xpt::XpSat*>(std::calloc(1, sizeof(xpt::XpSat)));
  xpt::XpSat* s0 = static_cast<xpt::XpSat*>(std::calloc(1, sizeof(xpt::XpSat)));
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
  const double a_er = std::pow(xpt::kKe / n_min, kX2o3);
  regime = (a_er * (1.0 - row.eccentricity) - 1.0) * xpt::kRe < kDragRegimeKm ? 0 : 1;
  const auto& terms = xpt::tess::active();
  const Noise& k = (terms.tesseral || terms.zonal) ? kNoiseAP[regime] : kNoiseXP[regime];
  noise[0] = k.s_e;
  noise[1] = k.s_i;
  noise[2] = k.s_l;
  noise[3] = k.c * std::fabs(ng_rate) * n_min * kMinutesPerDay;
  noise[4] = t_a;
  share = k.c;
  floor_scale = k.k_F;
  return true;
}

/// The fit's covariance at its solution (fit_oem, SGP4XP sets): `t`, `r` the fit samples (minutes, TEME km). Fills
/// `s` (row and options as fitted) and the non-gravitational rate r_ng (1/day). False when the normal matrix is not
/// positive definite or the theory refuses a moved set.
inline bool of_fit(const ElementRow& row, const fit::Options& o, const double* t, const double* r, int count, double arc_end_min,
                   Set& s, double& ng_rate) {
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
  const double s2 = ss / static_cast<double>(nres - np);  // km^2 per residual component
  if (!(s2 > 0.0)) return false;
  for (int a = 0; a < np; ++a)
    for (int c = 0; c <= a; ++c) A[c * np + a] = A[a * np + c] = A[a * np + c] / s2;
  // the fit's priors (fit::run's cost): B_eff and AGOM, each one pseudo-observation of its own sigma
  for (int a = 0; a < np; ++a) {
    if (b.kind[a] == kKindDrag && o.drag_sigma > 0.0) A[a * np + a] += 1.0 / (o.drag_sigma * o.drag_sigma);
    if (b.kind[a] == kKindSrp && o.agom_sigma > 0.0) A[a * np + a] += 1.0 / (o.agom_sigma * o.agom_sigma);
  }
  double Pp[kMaxAug * kMaxAug];
  if (!spd_inverse(A, np, Pp)) return false;
  // the process noise and the floor's scale of the set's regime (SPEC 12.4, 12.5)
  s = Set{};
  double floor_scale = 1.0;
  if (!noise_of(row, arc_end_min, ng_rate, s.regime, s.noise, s.share, floor_scale)) return false;
  s.ng_rate = ng_rate;
  for (double& f : floor) f = f / static_cast<double>(count) * floor_scale;
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
  add_floor(floor, r0, v0, S6);
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

/// s_d against c |ng_rate| n (n in rad/day), relative: the invariant of COV_PROPAGATION.
inline bool noise_invariant(const ElementRow& row, const Set& s) {
  const double n_day = row.mean_motion_rev_day * kTwoPi;
  const double want = s.share * std::fabs(s.ng_rate) * n_day;
  return std::fabs(s.noise[3] - want) <= 1e-12 * std::fmax(std::fabs(s.noise[3]), std::fabs(want));
}

/// The covariance of an $OCM set (COVARIANCE_DATA, COV_PARAMETER_KINDS with OD_DYNAMIC_PARAMETERS' SOLVED_FOR, and
/// COV_PROPAGATION) on top of its decoded row. 1 read, 0 no COVARIANCE_DATA, -1 malformed (COV_TYPE other than
/// CARTPV, COV_ORDERING other than LTM, COV_SIZE not 6 plus the kinds, a kind outside the five of SPEC 17.1, out of
/// their fixed order or not solved for, values other than N(N+1)/2, no COV_PROPAGATION), -2 a kind UNSPECIFIED, -3
/// NOISE_NON_GRAVITATIONAL_RAD_DAY2 not NON_GRAVITATIONAL_SHARE x |NON_GRAVITATIONAL_RATE_PER_DAY| x n within 1e-12
/// relative. A row the theories have no sensitivity to (DRAG_AREA_OVER_MASS_RATE, IN_TRACK_ACCELERATION,
/// OUTGASSING_ACCELERATION) is read as a constant parameter.
inline int read(const OCM* o, const ElementRow& row, Set& s) {
  s = Set{};
  s.row = row;
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
  return 1;
}

/// A set ready to give its covariance at any time: the bank and the parameter covariance.
struct Propagator {
  Bank b;
  Set s;
  double Pp[kMaxAug * kMaxAug] = {};
  ~Propagator() { release(b); }
};

/// 0 ready; -3 the theory refuses the set or a moved one; -5 the epoch columns are singular.
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
  add_floor(s.floor, r0, v0, F);
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
  return true;
}

}  // namespace cov
}  // namespace sdnap
