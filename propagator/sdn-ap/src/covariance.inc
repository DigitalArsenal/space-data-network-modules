// -----------------------------------------------------------------------------
// Covariance (SPEC 12): the fit's covariance carried forward by the theory's own state transition matrix.
//
// - The fit (fit_oem.inc, SDN-AP theory) forms the normal matrix of its parameters at the solution, every column a
//   central difference of the theory itself, with its priors; the inverse, the measurement variance being the post-fit
//   residual variance, is the parameter covariance. Its image at epoch (TEME position and velocity) is the $OMM's
//   COVARIANCE; the non-element parameters (B_eff, AGOM, tau) travel as USER_DEFINED_SDNAP_COV_x rows: their covariance
//   with the epoch state and with each other.
// - The state transition matrix at t is the central difference of the propagated state in the parameters (the same
//   columns); the epoch covariance is mapped back to the parameters through the epoch columns (their inverse), then
//   forward: P(t) = J(t) P_p J(t)^T.
// - Process noise: errors of the mean-element rates, constant from the end of the fit arc and mapped by the same
//   columns: the eccentricity vector (s_e per day), the inclination vector (s_i per day), the mean longitude (s_l n,
//   a relative mean-motion error) and, in the drag regime, the non-gravitational n-dot (s_d = c |n-dot_ng|). The
//   sizes are fitted per theory (SDN-AP, SGP4XP) and regime (test/covariance-realism.mjs) on laser-ranged arcs apart
//   from the held-out ones.
// - Theory floor: the fit's residual covariance in UVW (USER_DEFINED_SDNAP_COV_FLOOR_UVW), added at every time in the
//   state's own UVW axes (velocity: the same scaled by the orbit's angular rate squared).
// -----------------------------------------------------------------------------

namespace sdnap {
namespace cov {

/// Process noise per regime (SPEC 12.5): s_e, s_i (1/day), s_l (dn/n) and c (the share of the non-gravitational n-dot),
/// fitted by `test/covariance-realism.mjs --set calibration` (test/results/covariance-calibration.json).
struct Noise {
  double s_e, s_i, s_l, c;
};
/// [theory: 0 SDN-AP, 1 SGP4XP][regime: 0 perigee below kDragRegimeKm, 1 above]
constexpr Noise kNoise[2][2] = {{{1.963e-06, 2.69e-07, 2.371e-13, 1.928}, {1.358e-06, 3.652e-07, 5.328e-08, 0}},
                                 {{2.813e-06, 7.432e-06, 8.505e-07, 1.275e-06}, {2.308e-07, 3.752e-07, 2.666e-07, 0}}};
constexpr double kDragRegimeKm = 2500.0;  ///< the noise regimes' split: perigee height (the density kernel's top)

constexpr int kMaxConsider = 5;
constexpr int kMaxAug = 6 + kMaxConsider;
static_assert(kMaxAug == fit::kMaxParams, "the augmented state is the fit's parameter vector");
/// The consider rows, in params_of order (kind 6 + index).
inline const char* consider_name(int kind) {
  static const char* const names[kMaxConsider] = {"SDNAP_COV_DRAG", "SDNAP_COV_AGOM", "SDNAP_COV_TAU0", "SDNAP_COV_TAUC",
                                                  "SDNAP_COV_TAUS"};
  return kind >= 6 && kind < 6 + kMaxConsider ? names[kind - 6] : "";
}

/// Kinds of the parameter vector of options `o` (params_of order): 0-5 af, ag, chi, psi, lambda, n; 6 B_eff; 7 AGOM;
/// 8 tau0; 9 tauc; 10 taus.
inline int kinds_of(const fit::Options& o, int* kind) {
  int np = 0;
  for (; np < 6; ++np) kind[np] = np;
  if (o.fit_drag) kind[np++] = 6;
  if (o.fit_agom) kind[np++] = 7;
  if (o.fit_tau & 1) kind[np++] = 8;
  if (o.fit_tau & 2) {
    kind[np++] = 9;
    kind[np++] = 10;
  }
  return np;
}

inline double step_of(int kind, double v) {
  if (kind < 5) return 1e-6;                    // af, ag, chi, psi; lambda (rad)
  if (kind == 5) return 1e-7 * std::fabs(v);    // n (rad/min)
  if (kind <= 7) return std::fmax(1e-3 * std::fabs(v), 1e-5);  // m^2/kg
  return std::fmax(1e-3 * std::fabs(v), 1e-10);                 // m/s^2
}

/// The theory at the set and at the set moved by +-h in each parameter (AGOM forward only where -h would switch SRP
/// off: the theory reads AGOM <= 0 as none).
struct Bank {
  int np = 0;
  int kind[fit::kMaxParams] = {};
  double h[fit::kMaxParams] = {};
  bool central[fit::kMaxParams] = {};
  double x[fit::kMaxParams] = {};
  fit::Options o{};
  xpt::XpSat* sats = nullptr;  ///< [0] the set, [1 + 2j] +h_j, [2 + 2j] -h_j
  int count = 0;
};

inline void release(Bank& b) {
  for (int i = 0; b.sats != nullptr && i < b.count; ++i) xpt::xp_release(b.sats[i]);
  std::free(b.sats);
  b.sats = nullptr;
  b.count = 0;
}

inline bool init(const ElementRow& row, const fit::Options& o, Bank& b) {
  release(b);
  b.o = o;
  b.np = kinds_of(o, b.kind);
  fit::params_of(row, o, b.x);
  const int total = 1 + 2 * b.np;
  b.sats = static_cast<xpt::XpSat*>(std::calloc(static_cast<size_t>(total), sizeof(xpt::XpSat)));
  if (b.sats == nullptr) return false;
  drag::table();
  auto start = [&](const double* x, int slot) {
    ElementRow r = row;
    fit::row_of(x, o, r);
    const bool ok = xpt::xp_init(elements_of(r), b.sats[slot]) == kPropOk;
    b.count = slot + 1;
    return ok;
  };
  if (!start(b.x, 0)) return false;
  for (int j = 0; j < b.np; ++j) {
    b.h[j] = step_of(b.kind[j], b.x[j]);
    b.central[j] = !(b.kind[j] == 7 && b.x[j] - b.h[j] <= 0.0);
    double xp[fit::kMaxParams], xm[fit::kMaxParams];
    for (int q = 0; q < b.np; ++q) xp[q] = xm[q] = b.x[q];
    xp[j] += b.h[j];
    xm[j] -= b.central[j] ? b.h[j] : 0.0;
    if (!start(xp, 1 + 2 * j) || !start(xm, 2 + 2 * j)) return false;
  }
  return true;
}

/// The set's state at t (TEME km, km/s) and J = d state / d parameters (6 x np, row-major).
inline bool at(Bank& b, double t, double r[3], double v[3], double* J) {
  if (xpt::xp_propagate(b.sats[0], t, r, v) != kPropOk) return false;
  for (int j = 0; j < b.np; ++j) {
    double rp[3], vp[3], rm[3], vm[3];
    if (xpt::xp_propagate(b.sats[1 + 2 * j], t, rp, vp) != kPropOk) return false;
    if (xpt::xp_propagate(b.sats[2 + 2 * j], t, rm, vm) != kPropOk) return false;
    const double d = b.central[j] ? 2.0 * b.h[j] : b.h[j];
    for (int c = 0; c < 3; ++c) {
      J[c * b.np + j] = (rp[c] - rm[c]) / d;
      J[(3 + c) * b.np + j] = (vp[c] - vm[c]) / d;
    }
  }
  return true;
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
inline void add_floor(const double* F, const double r[3], const double v[3], double* P) {
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
}

/// A covariance-bearing set: the row, its parameter layout, the epoch covariance (COVARIANCE, 6 x 6, the floor
/// included), the consider rows, the floor and the process noise.
struct Set {
  ElementRow row{};
  fit::Options o{};
  int np = 0;
  double C[kMaxAug * kMaxAug] = {};  ///< augmented epoch covariance (np x np): state block total, then consider
  double floor[6] = {};
  double noise[5] = {};              ///< s_e, s_i (1/day), s_l (dn/n), s_d (rad/day^2), the noise start t_a (min)
  int regime = 0;                    ///< 0 drag, 1 above (of_fit)
};

/// The fit's covariance at its solution (fit_oem, SDN-AP sets): `t`, `r` the fit samples (minutes, TEME km). Fills
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
    if (b.kind[a] == 6 && o.drag_sigma > 0.0) A[a * np + a] += 1.0 / (o.drag_sigma * o.drag_sigma);
    if (b.kind[a] == 7 && o.agom_sigma > 0.0) A[a * np + a] += 1.0 / (o.agom_sigma * o.agom_sigma);
  }
  double Pp[kMaxAug * kMaxAug];
  if (!spd_inverse(A, np, Pp)) return false;
  for (double& f : floor) f /= static_cast<double>(count);
  // epoch image: state block J0 Pp J0^T + floor, cross J0 Pp, consider Pp
  double r0[3], v0[3];
  if (!at(b, 0.0, r0, v0, J)) return false;
  s = Set{};
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
  for (int k = 0; k < 6; ++k) s.floor[k] = floor[k];
  // the non-gravitational n-dot / n at epoch (B_eff, tau): the theory's epoch rates with and without them
  ng_rate = 0.0;
  {
    ElementRow none = row;
    none.bterm = 0.0;
    none.tau0 = none.tauc = none.taus = 0.0;
    xpt::XpSat* s0 = static_cast<xpt::XpSat*>(std::calloc(1, sizeof(xpt::XpSat)));
    if (s0 != nullptr && xpt::xp_init(elements_of(none), *s0) == kPropOk && b.sats[0].epoch.y[xpt::kN] > 0.0)
      ng_rate = (b.sats[0].epoch.f[xpt::kN] - s0->epoch.f[xpt::kN]) / b.sats[0].epoch.y[xpt::kN] * kMinutesPerDay;
    if (s0 != nullptr) xpt::xp_release(*s0);
    std::free(s0);
  }
  const double a_er = std::pow(xpt::kKe / b.x[5], kX2o3);
  s.regime = (a_er * (1.0 - row.eccentricity) - 1.0) * xpt::kRe < kDragRegimeKm ? 0 : 1;
  const Noise& k = kNoise[row.theory == kTheorySdnAp ? 0 : 1][s.regime];
  const double n_day = b.x[5] * kMinutesPerDay;
  s.noise[4] = arc_end_min;
  s.noise[0] = k.s_e;
  s.noise[1] = k.s_i;
  s.noise[2] = k.s_l;
  s.noise[3] = k.c * std::fabs(ng_rate) * n_day;
  return true;
}

/// Reads the covariance of an $OMM (COVARIANCE and the USER_DEFINED_SDNAP_COV_x rows) on top of its decoded row.
/// 1 read, 0 no COVARIANCE, -1 malformed (a consider row of the wrong length, a COVARIANCE of other than 21 values).
inline int read(const uint8_t* buf, uint32_t len, const ElementRow& row, Set& s) {
  s = Set{};
  s.row = row;
  const uint8_t* p = buf;
  uint32_t n = len;
  if (!plain_view(p, n, "$OMM")) return -1;
  flatbuffers::Verifier verifier(p, n);
  if (!VerifyOMMBuffer(verifier)) return -1;
  const OMM* omm = GetOMM(p);
  const auto* cv = omm->COVARIANCE();
  if (cv == nullptr || cv->size() == 0) return 0;
  if (cv->size() != 21) return -1;
  // consider rows present
  const flatbuffers::String* rows[kMaxConsider] = {};
  if (const auto* ud = omm->USER_DEFINED_PARAMETERS()) {
    for (const OMMUserDefinedParameter* q : *ud) {
      if (q == nullptr || q->PARAM_NAME() == nullptr || q->PARAM_VALUE() == nullptr) continue;
      const char* name = q->PARAM_NAME()->c_str();
      for (int k = 0; k < kMaxConsider; ++k)
        if (std::strcmp(name, consider_name(6 + k)) == 0) rows[k] = q->PARAM_VALUE();
      const bool floor = std::strcmp(name, "SDNAP_COV_FLOOR_UVW") == 0, noise = std::strcmp(name, "SDNAP_COV_NOISE") == 0;
      if (floor || noise) {
        const char* c = q->PARAM_VALUE()->c_str();
        char* end = nullptr;
        for (int k = 0; k < (floor ? 6 : 5); ++k) {
          (floor ? s.floor : s.noise)[k] = std::strtod(c, &end);
          if (end == c) return -1;
          c = end;
        }
      }
    }
  }
  if ((rows[3] == nullptr) != (rows[4] == nullptr)) return -1;
  s.o.fit_drag = rows[0] != nullptr;
  s.o.fit_agom = rows[1] != nullptr;
  s.o.fit_tau = (rows[2] != nullptr ? 1 : 0) | (rows[3] != nullptr ? 2 : 0);
  int kind[fit::kMaxParams];
  s.np = kinds_of(s.o, kind);
  const int np = s.np;
  int k21 = 0;
  for (int i = 0; i < 6; ++i)
    for (int j = 0; j <= i; ++j) s.C[i * np + j] = s.C[j * np + i] = cv->Get(k21++);
  for (int a = 6; a < np; ++a) {
    const char* c = rows[kind[a] - 6]->c_str();
    char* end = nullptr;
    for (int j = 0; j <= a; ++j) {
      const double v = std::strtod(c, &end);
      if (end == c) return -1;
      c = end;
      s.C[a * np + j] = s.C[j * np + a] = v;
    }
    while (*c == ' ') ++c;
    if (*c != '\0') return -1;
  }
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
inline int prepare(const Set& s, Propagator& p) {
  p.s = s;
  if (!init(s.row, s.o, p.b)) return -3;
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
inline bool eval(Propagator& p, double t, double r[3], double v[3], double* P) {
  const int np = p.b.np;
  double J[6 * kMaxAug];
  if (!at(p.b, t, r, v, J)) return false;
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
  add_floor(p.s.floor, r, v, P);
  for (int i = 0; i < 6; ++i)
    for (int j = 0; j < i; ++j) P[i * 6 + j] = P[j * 6 + i] = 0.5 * (P[i * 6 + j] + P[j * 6 + i]);
  return true;
}

}  // namespace cov
}  // namespace sdnap
