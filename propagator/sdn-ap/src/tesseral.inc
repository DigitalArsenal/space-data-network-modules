// -----------------------------------------------------------------------------
// AP (SPEC 16): an advanced propagator that builds on the entire history of astrodynamics, outside the SGP4-XP specification. What the call's $PCF FORCES selects
// (MAXIMUM_TESSERAL_DEGREE, MAXIMUM_DEGREE): tesseral gravity and the zonal tail; none of it is applied otherwise, so
// the default is SGP4XP bit for bit.
//   m-daily short-periodics: for even l and p = l/2, q = 0, Kaula's term has psi = m (Omega - theta_G): period about
//   one m-th of a day, amplitude O(e^0). With the slow elements frozen over the period (first order), Lagrange's
//   equations integrate over psi in closed form (dR/dM = dR/domega = 0, so a, n and e do not oscillate):
//     Delta i              = -m A F G S(psi) / (n a^2 eta sin i psi')
//     Delta (sin i Omega)  =  A F' G S1(psi) / (n a^2 eta psi')
//     Delta (e varpi)      = [eta A F G' / (n a^2) + e tan(i/2) A F' G / (n a^2 eta)] S1(psi) / psi'
//     Delta lambda         = [2 (l+1) A F G / (n a^2) + eta e A F G' / (n a^2 (1+eta))
//                             + tan(i/2) A F' G / (n a^2 eta)] S1(psi) / psi'
//   with A = mu / a^(l+1), F = Fbar_l,m,l/2 (normalized, at the epoch inclination, held per object), G = <(a/r)^(l+1)>
//   (closed form), S the term's Cbar/Sbar combination, S1 its antiderivative in psi, and psi' = m (Omega-dot_J2 -
//   omega_E). Added at output time to the equinoctial elements; coefficients the pinned EGM (build.mjs).
// -----------------------------------------------------------------------------

// Included inside namespace sdnap::xpt (xp_theory.inc), after resonance.inc.
namespace tess {

#include "gravity_egm.h"

/// Bake cells (SPEC 9): the caches below bake their terms at the center of the mean state's cell, so what they hold is
/// a function of the state alone, never of the states evaluated before. The cell of x among cells `tol` times the
/// power of two at or below x wide (a relative cell), and its center.
inline int64_t sp_cell_rel(double x, double tol, double& center) {
  const double w = tol * std::ldexp(1.0, std::ilogb(x));
  const double k = std::floor(x / w);
  center = (k + 0.5) * w;
  return static_cast<int64_t>(k);
}
/// The cell of x among cells w wide, and its center.
inline int64_t sp_cell_abs(double x, double w, double& center) {
  const double k = std::floor(x / w);
  center = (k + 0.5) * w;
  return static_cast<int64_t>(k);
}
/// The cell of an eccentricity for a bake whose tolerance is on e^2 (e2_tol): w_small wide in e up to
/// e_t = e2_tol / (2 w_small), then e2_tol / (2 e) wide (uniform in e^2), so the center's e^2 is within e2_tol / 2 of
/// e's and, near e = 0, the center's e within w_small / 2 of e. Returns the cell; `center` the center's e.
inline int64_t sp_cell_e(double e, double w_small, double e2_tol, double& center) {
  const double e_t = e2_tol / (2.0 * w_small), u0 = e_t / (2.0 * w_small);
  const double u = e < e_t ? e / w_small : e * e / e2_tol + u0;
  const double k = std::floor(u), uc = k + 0.5;
  center = uc * w_small < e_t ? uc * w_small : std::sqrt((uc - u0) * e2_tol);
  return static_cast<int64_t>(k);
}

/// The bracket of the mean-element grid a state's mean elements come from (xp_theory.inc sets it when it brackets a
/// time): its id (the set and the lower node), its first time and length (signed, minutes), and a, e and cos i at
/// its two nodes. The tesseral and m-daily caches bake at states on the bracket, so what they hold depends on the
/// bracket and the time alone.
struct SpAnchor {
  bool valid = false;
  uint64_t id = 0;
  double tlo = 0.0, h = 1.0;
  double a_lo = 1.0, a_hi = 1.0, e_lo = 0.0, e_hi = 0.0, c_lo = 1.0, c_hi = 1.0;
};
/// The points per level on the bracket g_sp_anchor names (sp_anchor_point), counted once per bracket: keyed by the
/// bracket, so it never outlives it.
struct SpAnchorLevels {
  uint64_t id = 0;
  double tlo = 0.0, h = 0.0;
  struct Level {
    double tol_a, tol_e, tol_c;
    bool e_sq;
    int n;
  };
  static constexpr int kLevels = 6;
  Level lv[kLevels]{};
  int count = 0;
};
inline thread_local SpAnchorLevels g_sp_anchor_levels{};
inline thread_local SpAnchor g_sp_anchor{};
/// Whether time t lies on the bracket g_sp_anchor names.
inline bool sp_anchored(double t) {
  const SpAnchor& an = g_sp_anchor;
  if (!an.valid || an.h == 0.0) return false;
  const double q = (t - an.tlo) / an.h;
  return q >= 0.0 && q <= 1.0;
}

/// The part of a bracket cut into n equal parts that holds the time at q = (t - tlo) / h, as a level's key: n * 64 + the
/// part. sp_anchor_point keys a bake with it, and the inline checks (sp_keys_hold, md_keys_hold) compare with it.
inline int64_t sp_part_key(double q, int n) {
  int k = static_cast<int>(std::floor(q * n));
  k = k < 0 ? 0 : (k >= n ? n - 1 : k);
  return static_cast<int64_t>(n) * 64 + k;
}

/// One bake level's point for time t: the bracket cut into n equal parts, n the smallest that keeps a (relative
/// tol_a), e (tol_e on e, or on e^2 when e_sq) and cos i (tol_c) within a quarter of their tolerance of the part's
/// center along the chord between the nodes, at most 64; the point is the center of t's part. The key is n * 64 + the
/// part.
inline int64_t sp_anchor_point(const SpAnchor& an, double t, double tol_a, double tol_e, bool e_sq, double tol_c, double& a_c,
                               double& e_c, double& c_c) {
  // the bracket's points one tolerance apart (each point within half a tolerance of the chord it stands for, as a cell's
  // center is), counted once per bracket and level
  SpAnchorLevels& L = g_sp_anchor_levels;
  if (L.id != an.id || L.tlo != an.tlo || L.h != an.h) {
    L.id = an.id;
    L.tlo = an.tlo;
    L.h = an.h;
    L.count = 0;
  }
  int n = 0;
  for (int j = 0; j < L.count; ++j)
    if (L.lv[j].tol_a == tol_a && L.lv[j].tol_e == tol_e && L.lv[j].tol_c == tol_c && L.lv[j].e_sq == e_sq) {
      n = L.lv[j].n;
      break;
    }
  if (n == 0) {
    const double da = std::fabs(an.a_hi - an.a_lo) / (tol_a * an.a_lo);
    const double de = e_sq ? std::fabs(an.e_hi * an.e_hi - an.e_lo * an.e_lo) / tol_e : std::fabs(an.e_hi - an.e_lo) / tol_e;
    const double dc = tol_c > 0.0 ? std::fabs(an.c_hi - an.c_lo) / tol_c : 0.0;
    const double need = std::fmax(da, std::fmax(de, dc));
    n = need < 1.0 ? 1 : (need >= 64.0 ? 64 : static_cast<int>(std::ceil(need)));
    if (L.count < SpAnchorLevels::kLevels) L.lv[L.count++] = SpAnchorLevels::Level{tol_a, tol_e, tol_c, e_sq, n};
  }
  const int64_t key = sp_part_key((t - an.tlo) / an.h, n);
  const int k = static_cast<int>(key - static_cast<int64_t>(n) * 64);
  const double q = (k + 0.5) / n;
  a_c = an.a_lo + q * (an.a_hi - an.a_lo);
  e_c = an.e_lo + q * (an.e_hi - an.e_lo);
  c_c = an.c_lo + q * (an.c_hi - an.c_lo);
  return key;
}

/// What the call selects (0: none of it). `tesseral` is the highest degree of the terms of order >= 1, `zonal` of the
/// zonal tail. Capped per family at the degree that was measured to pay. On FFM Starlink truth, day 3: m-daily 8 -> 12
/// 4.26 -> 2.03 km and 16 no better; shallow 21 / 31 / 41 / 70 2.15 / 1.89 / 2.02 / 2.03 km; zonal tail J2-J5 0.35 km,
/// to J10 0.14, to J20 0.047, to J40 0.042. On FFM's own 96 h, fit RMS of the first-order families below: without them
/// 48 to 68 m, to degree 7 24 to 42 m, to degree 12 21 to 37 m, with the near-resonant terms 15 to 20 m.
struct Terms {
  int tesseral = 0, zonal = 0;
  bool solid_tides = false;  ///< SPEC 16.14: the solid Earth tide in the rates (with the gravity terms only)
  bool slow = false;         ///< SPEC 16.18 (the low table): the slow set by size, to the field's degree (stack #477)
};
inline Terms& active() {
  static thread_local Terms t;
  return t;
}
constexpr int kMdailyCap = 12, kSpCap = 12, kShallowCap = 31;
/// The low table's fast side (SPEC 16.1, stack #477): in class 0 at or below the switch, the output table's first-order terms
/// follow the record's MAXIMUM_TESSERAL_DEGREE to kFastCap, by the table's own size cut (kSpKeepM), with |l - 2p| at most
/// kSpMaxW, and above the m-daily family's degree it also holds the m-daily terms (q = 0, l = 2p). A record that asks for
/// degree 12 or less builds the table it built before.
constexpr int kFastCap = 70, kSpMaxW = 17;
constexpr double kShallowBand = 0.045;
/// The record's span from its epoch for the fast side's band guard (sp_terms' n_end): a 72 h fit's arc and the five days
/// after it, the span xp_init lays its grid over.
constexpr double kFastSpanMinutes = 8.0 * 1440.0;
/// SPEC 16.18, the low table's part (stack #477): with Terms::slow, every term of the embedded field whose own angle rate
/// at the set's epoch is inside the shallow band (selected to kShallowSelect bands) and whose along-track amplitude through
/// the mean motion, 3 |j| A / (a psi-dot^2), reaches kSlowKeepM is carried in the rates beside the shallow set's own terms,
/// for every j >= 1 and every q, to the field's degree whatever FORCES.MAXIMUM_TESSERAL_DEGREE states (that degree governs
/// the fast terms): a commensurability's series is a cancellation, and a slow set cut at a lower degree is worse than none.
constexpr int kSlowDegree = 70;
constexpr int kSlowJMax = 6, kSlowQMax = 4;
constexpr double kSlowKeepM = 0.5;
/// The slow set's q range: |q| up to kSlowQMax from 0.6.27 (stack #477's second part; 0.6.25 landed q = 0), every term of it
/// by its own rate and size; tests only may narrow it (sdnap_slow_q_max).
inline int& slow_q_max() {
  static int q = kSlowQMax;
  return q;
}
/// Tests only (sdnap_slow_degree_cap): the slow set's degree, so a model truth cut lower is compared like with like.
inline int& slow_degree_cap() {
  static int cap = kSlowDegree;
  return cap;
}
struct ShallowTerms;
inline bool slow_holds(const ShallowTerms* held, int l, int m, int p, int q);
inline int slow_complement_lmax(const ShallowTerms* held, int degree, int8_t (&lmax)[72][35]);
inline double band_taper(double x);
constexpr double kNearBand = 0.2;   // the j = 1 orders kept above the general set's degree, in units of n
constexpr double kSpKeepM = 0.5;    // a term whose position amplitude is below this many meters is not kept: 0.2 m
                                    // gives 15 to 20 m of fit RMS, 0.5 m 16 to 21, 1 m 18 to 23, 2 m 23 to 28
/// The switch (SPEC 16.11): above this epoch eccentricity a perigee pass spreads a term over the harmonics of M; the zonal
/// tail carries every long-period term (xp_theory.inc, this constant), the perigee drag passage runs (SPEC 16.12, this
/// constant) and, in the resonance classes, the first-order tesseral families are the grid of wide_grid_build.
constexpr double kWideE = 0.3;
/// From 0.6.4 the tesseral families' switch is by the set's resonance class (res::band_of of the epoch mean motion, SPEC 6):
/// a set in no resonance band (class 0: low orbit, the LAGEOS band, orbits below 0.8 rev/day) flies the grid above this
/// eccentricity, where the first-order set fails against the full field and the grid is cheaper (SPEC 16.11); a set in a
/// resonance class (1 one-day, 2 half-day, 3 eight-hour, 4 sixteen-hour) keeps kWideE: the grid does not reach the
/// resonant share there and costs more. Read by xpt::branch_of alone (SPEC 16.7: the switch is the set's, decided at its epoch).
constexpr double kWideENonResonant = 0.05;
inline bool wide_set(int cls, double e0) { return e0 > (cls == 0 ? kWideENonResonant : kWideE); }
/// The one-day class's resonant tail (SPEC 6.1, 16.2; stack #434): k = m, degrees 5 to the cap, orders 1 to this, in the
/// rates of a one-day set below kWideE. At e at most 0.3 the amplitude cut of half_day_terms ends the tail below degree 15,
/// so no term of a higher order passes it.
constexpr int kOneDayTailMaxOrder = 16;
inline bool one_day_tail(int cls, bool wide, int degree) { return cls == 1 && !wide && degree >= 5; }

/// N_lm = sqrt((2 - delta_0m)(2l + 1)(l - m)! / (l + m)!), unnormalized = N_lm x normalized.
inline double norm_factor(int l, int m) {
  double r = (m == 0 ? 1.0 : 2.0) * (2 * l + 1);
  for (int k = l - m + 1; k <= l + m; ++k) r /= k;
  return std::sqrt(r);
}

/// The recurrence of the fully normalized associated Legendre functions Pbar_lm(x)
/// of one order m (geodesy convention, no Condon-Shortley phase):
/// Pbar_mm = K_m c^m, Pbar_m+1,m = sqrt(2m + 3) x Pbar_mm,
/// Pbar_lm = a_l x Pbar_l-1,m - b_l Pbar_l-2,m; x = sin(latitude), c = cos(latitude).
struct LegendreOrder {
  int m, lmax;
  double km;
  double a[104], b[104], d[104];  // to degree 103 (the lunar field is pinned to degree 100)
};

inline void legendre_order(int m, int lmax, LegendreOrder& L) {
  L.m = m;
  L.lmax = lmax;
  double k = 1.0;
  for (int j = 1; j <= m; ++j) k *= std::sqrt((2.0 * j + 1.0) / (2.0 * j));
  L.km = m >= 1 ? k * std::sqrt(2.0) : 1.0;  // (2 - delta_0m)
  if (m + 1 <= lmax) L.d[m + 1] = std::sqrt(2.0 * m + 3.0);
  for (int l = m + 2; l <= lmax; ++l) {
    const double lm = (double)(l - m) * (double)(l + m);
    L.a[l] = std::sqrt((2.0 * l - 1.0) * (2.0 * l + 1.0) / lm);
    L.b[l] = std::sqrt((2.0 * l + 1.0) * (l + m - 1.0) * (l - m - 1.0) / (lm * (2.0 * l - 3.0)));
    L.d[l] = std::sqrt((2.0 * l + 1.0) * lm / (2.0 * l - 1.0));
  }
}

inline void legendre_column(const LegendreOrder& L, double x, double c, double* out) {
  const int m = L.m;
  double cm = 1.0;
  for (int j = 0; j < m; ++j) cm *= c;
  out[m] = L.km * cm;
  if (L.lmax == m) return;
  out[m + 1] = std::sqrt(2.0 * m + 3.0) * x * out[m];
  for (int l = m + 2; l <= L.lmax; ++l) out[l] = L.a[l] * x * out[l - 1] - L.b[l] * out[l - 2];
}

/// Normalized inclination functions Fbar_l,m,p(i) (= N_lm F_lmp, Kaula) at
/// l - 2p = k (k >= 0; l from max(m, k) to lmax with l = k mod 2) as Fourier
/// coefficients: on a circular orbit Pbar_lm(sin i sin u) e^(i m dlambda(u)) =
/// sum_p Fbar_p e^(i (l - 2p) u) (l - m even; times -i when odd), so Fbar_p is
/// that function's coefficient at frequency l - 2p. The integrand is a
/// trigonometric polynomial of degree l: N > l + k points give the coefficient
/// exactly; the Legendre recurrence keeps it stable to degree 70.
inline constexpr double kInvM[72] = {
    0.0,        1.0 / 1.0,  1.0 / 2.0,  1.0 / 3.0,  1.0 / 4.0,  1.0 / 5.0,  1.0 / 6.0,  1.0 / 7.0,
    1.0 / 8.0,  1.0 / 9.0,  1.0 / 10.0, 1.0 / 11.0, 1.0 / 12.0, 1.0 / 13.0, 1.0 / 14.0, 1.0 / 15.0,
    1.0 / 16.0, 1.0 / 17.0, 1.0 / 18.0, 1.0 / 19.0, 1.0 / 20.0, 1.0 / 21.0, 1.0 / 22.0, 1.0 / 23.0,
    1.0 / 24.0, 1.0 / 25.0, 1.0 / 26.0, 1.0 / 27.0, 1.0 / 28.0, 1.0 / 29.0, 1.0 / 30.0, 1.0 / 31.0,
    1.0 / 32.0, 1.0 / 33.0, 1.0 / 34.0, 1.0 / 35.0, 1.0 / 36.0, 1.0 / 37.0, 1.0 / 38.0, 1.0 / 39.0,
    1.0 / 40.0, 1.0 / 41.0, 1.0 / 42.0, 1.0 / 43.0, 1.0 / 44.0, 1.0 / 45.0, 1.0 / 46.0, 1.0 / 47.0,
    1.0 / 48.0, 1.0 / 49.0, 1.0 / 50.0, 1.0 / 51.0, 1.0 / 52.0, 1.0 / 53.0, 1.0 / 54.0, 1.0 / 55.0,
    1.0 / 56.0, 1.0 / 57.0, 1.0 / 58.0, 1.0 / 59.0, 1.0 / 60.0, 1.0 / 61.0, 1.0 / 62.0, 1.0 / 63.0,
    1.0 / 64.0, 1.0 / 65.0, 1.0 / 66.0, 1.0 / 67.0, 1.0 / 68.0, 1.0 / 69.0, 1.0 / 70.0, 1.0 / 71.0,
};

inline void complex_pow(double cr, double ci, int m, double& out_c, double& out_s) {
  double r = 1.0, i = 0.0;
  int n = m;
  while (n > 0) {
    if (n & 1) {
      const double nr = r * cr - i * ci;
      i = r * ci + i * cr;
      r = nr;
    }
    n >>= 1;
    if (n > 0) {
      const double ncr = cr * cr - ci * ci;
      ci = 2.0 * cr * ci;
      cr = ncr;
    }
  }
  out_c = r;
  out_s = i;
}

inline void normalized_Fk(int m, int k, int lmax, double inc, double* F) {
  const int ak = k < 0 ? -k : k;
  const int N = lmax + ak + 2;
  double si, ci;
  fm::sincos(inc, si, ci);
  double col[104];
  LegendreOrder L;
  legendre_order(m, lmax, L);
  for (int l = 0; l <= lmax; ++l) F[l] = 0.0;
  int l0 = m > ak ? m : ak;
  if ((l0 - ak) & 1) ++l0;
  const double du = kTwoPi / N;
  double sdu, cdu, sdku, cdku;
  fm::sincos(du, sdu, cdu);
  fm::sincos(k * du, sdku, cdku);
  double su = 0.0, cu = 1.0, sku = 0.0, cku = 1.0;
  for (int j = 0; j < N; ++j) {
    if (j > 0) {
      const double nsu = su * cdu + cu * sdu;
      cu = cu * cdu - su * sdu;
      su = nsu;
      const double nsku = sku * cdku + cku * sdku;
      cku = cku * cdku - sku * sdku;
      sku = nsku;
    }
    const double x = si * su, c = std::sqrt(std::fmax(0.0, 1.0 - x * x));
    legendre_column(L, x, c, col);
    double sml = 0.0, cml = 1.0;
    if (m > 0) {
      if (c > 1e-12) {
        const double inv_c = 1.0 / c;
        complex_pow(cu * inv_c, ci * su * inv_c, m, cml, sml);
      } else {
        fm::sincos(m * std::atan2(ci * su, cu), sml, cml);
      }
    }
    for (int l = l0; l <= lmax; l += 2) {
      const double f1 = col[l] * cml, f2 = col[l] * sml;
      F[l] += ((l - m) & 1) ? f1 * sku - f2 * cku : f1 * cku + f2 * sku;
    }
  }
  const double inv_N = 1.0 / N;
  for (int l = 0; l <= lmax; ++l) F[l] *= inv_N;
}

inline void normalized_Fk3(int m, int k, int lmax, double i0, double h, double* F0, double* Fp, double* Fm) {
  const int ak = k < 0 ? -k : k;
  const int N = lmax + ak + 2;
  double si[3], ci[3];
  fm::sincos(i0, si[0], ci[0]);
  fm::sincos(i0 + h, si[1], ci[1]);
  fm::sincos(i0 - h, si[2], ci[2]);
  double* outs[3] = {F0, Fp, Fm};
  for (int s = 0; s < 3; ++s)
    for (int l = 0; l <= lmax; ++l) outs[s][l] = 0.0;
  LegendreOrder L;
  legendre_order(m, lmax, L);
  int l0 = m > ak ? m : ak;
  if ((l0 - ak) & 1) ++l0;
  const double du = kTwoPi / N;
  double sdu, cdu, sdku, cdku;
  fm::sincos(du, sdu, cdu);
  fm::sincos(k * du, sdku, cdku);
  double su = 0.0, cu = 1.0, sku = 0.0, cku = 1.0;
  double col[104];
  for (int j = 0; j < N; ++j) {
    if (j > 0) {
      const double nsu = su * cdu + cu * sdu;
      cu = cu * cdu - su * sdu;
      su = nsu;
      const double nsku = sku * cdku + cku * sdku;
      cku = cku * cdku - sku * sdku;
      sku = nsku;
    }
    for (int s = 0; s < 3; ++s) {
      const double x = si[s] * su, c = std::sqrt(std::fmax(0.0, 1.0 - x * x));
      legendre_column(L, x, c, col);
      double sml = 0.0, cml = 1.0;
      if (m > 0) {
        if (c > 1e-12) {
          const double inv_c = 1.0 / c;
          complex_pow(cu * inv_c, ci[s] * su * inv_c, m, cml, sml);
        } else {
          fm::sincos(m * std::atan2(ci[s] * su, cu), sml, cml);
        }
      }
      double* F = outs[s];
      for (int l = l0; l <= lmax; l += 2) {
        const double f1 = col[l] * cml, f2 = col[l] * sml;
        F[l] += ((l - m) & 1) ? f1 * sku - f2 * cku : f1 * cku + f2 * sku;
      }
    }
  }
  const double inv_N = 1.0 / N;
  for (int s = 0; s < 3; ++s)
    for (int l = 0; l <= lmax; ++l) outs[s][l] *= inv_N;
}

// Keyed by inclination, degree, m and NF; lives for one slow_terms_low call.
struct NormalizedFkSamples {
  struct Sample {
    double col[104], dcol[104], x, alpha_x, cml, sml, dcml, dsml;
    bool ready = false, derivative[2] = {false, false};
  };
  struct Column { int m, NF; mem::InitTable<Sample> samples; Column* next = nullptr; };
  Column* columns = nullptr;
  double inclination = 0.0;
  int degree = -1;
  ~NormalizedFkSamples() { clear(); }
  void clear() {
    while (columns) { auto* c = columns; columns = c->next; delete c; }
  }
  Sample* get(int m, int NF, int count, double i0, int lmax) {
    if (degree != -1 && (std::memcmp(&inclination, &i0, sizeof(i0)) != 0 || degree != lmax)) {
      assert(false && "inclination memo input changed");
      clear();
    }
    inclination = i0; degree = lmax;
    for (auto* c = columns; c; c = c->next) if (c->m == m && c->NF == NF) return c->samples.data;
    auto* c = mem::counted(new (std::nothrow) Column{});
    if (!c) return nullptr;
    if (!c->samples.allocate(count)) { delete c; return nullptr; }
    c->m = m; c->NF = NF; c->next = columns; columns = c;
    return c->samples.data;
  }
};

inline void normalized_Fk_dF(int m, int k, int lmax, double i0, double* F0, double* dF0, NormalizedFkSamples* shared = nullptr) {
  double si0, ci0;
  fm::sincos(i0, si0, ci0);
  if (std::fabs(ci0) < 1e-3) {
    double fp[104], fm_arr[104];
    constexpr double h = 1e-5;
    normalized_Fk3(m, k, lmax, i0, h, F0, fp, fm_arr);
    for (int l = 0; l <= lmax; ++l) dF0[l] = (fp[l] - fm_arr[l]) * (0.5 / h);
    return;
  }
  const int ak = k < 0 ? -k : k;
  const int NF = (lmax + ak + 3) & ~1;
  const int NF_HALF = NF >> 1;
  const int j_top = NF_HALF >> 1;
  for (int l = 0; l <= lmax; ++l) F0[l] = dF0[l] = 0.0;
  LegendreOrder L;
  legendre_order(m, lmax, L);
  int l0 = m > ak ? m : ak;
  if ((l0 - ak) & 1) ++l0;
  const double du = kTwoPi / NF;
  double sdu, cdu, sdku, cdku;
  fm::sincos(du, sdu, cdu);
  fm::sincos(k * du, sdku, cdku);
  double su = 0.0, cu = 1.0, sku = 0.0, cku = 1.0;
  auto* samples = shared ? shared->get(m, NF, j_top + 1, i0, lmax) : nullptr;
  for (int j = 0; j <= j_top; ++j) {
    if (j > 0) {
      const double nsu = su * cdu + cu * sdu;
      cu = cu * cdu - su * sdu;
      su = nsu;
      const double nsku = sku * cdku + cku * sdku;
      cku = cku * cdku - sku * sdku;
      sku = nsku;
    }
    NormalizedFkSamples::Sample local;
    auto& v = samples ? samples[j] : local;
    if (!v.ready) {
      const double w_j = (j == 0 || 2 * j == NF_HALF) ? 0.5 : 1.0;
      const double x = si0 * su, c2 = 1.0 - x * x, c = std::sqrt(c2);
      const double inv_c = 1.0 / c, inv_c2 = inv_c * inv_c;
      legendre_column(L, x, c, v.col);
      v.x = x;
      v.alpha_x = ci0 * su * inv_c2;
      const double beta_phi = -m * x * cu * inv_c2;
      double sml = 0.0, cml = 1.0;
      if (m > 0) complex_pow(cu * inv_c, ci0 * su * inv_c, m, cml, sml);
      cml *= w_j;
      sml *= w_j;
      v.cml = cml; v.sml = sml;
      v.dcml = -beta_phi * sml; v.dsml = beta_phi * cml;
      v.ready = true;
    }
    // Only the consumed parity is differentiated; another k can fill the other.
    if (!v.derivative[l0 & 1]) {
      const double x = v.x, alpha_x = v.alpha_x;
      if ((l0 & 1) == (m & 1)) v.dcol[m] = -alpha_x * (m * x * v.col[m]);
      int first = m + 1;
      if ((first & 1) != (l0 & 1)) ++first;
      for (int l = first; l <= lmax; l += 2) v.dcol[l] = alpha_x * (L.d[l] * v.col[l - 1] - l * x * v.col[l]);
      v.derivative[l0 & 1] = true;
    }
    const double* col = v.col;
    const double* dcol = v.dcol;
    const double cml = v.cml, sml = v.sml, dcml = v.dcml, dsml = v.dsml;
    for (int l = l0; l <= lmax; l += 2) {
      const double Pl = col[l], dPl = dcol[l];
      const double f1 = Pl * cml, f2 = Pl * sml;
      const double df1 = dPl * cml + Pl * dcml, df2 = dPl * sml + Pl * dsml;
      if ((l - m) & 1) {
        F0[l] += f1 * sku - f2 * cku;
        dF0[l] += df1 * sku - df2 * cku;
      } else {
        F0[l] += f1 * cku + f2 * sku;
        dF0[l] += df1 * cku + df2 * sku;
      }
    }
  }
  const double two_inv_NF = 2.0 / NF_HALF;
  for (int l = l0; l <= lmax; l += 2) {
    F0[l] *= two_inv_NF;
    dF0[l] *= two_inv_NF;
  }
}

/// The m-daily terms' inclination functions at the epoch inclination i0: for even
/// l = 2..degree and m = 1..l in that order, Fbar_l,m,l/2 and its derivative in i
/// in F[2 j], F[2 j + 1]; returns the term count.
/// The m-daily terms of degree 2 to `degree` (even l, m = 1..l): mdaily_terms' count.
constexpr int mdaily_term_count(int degree) {
  int count = 0;
  for (int l = 2; l <= degree; l += 2) count += l;
  return count;
}
inline int mdaily_terms(int degree, double i0, double* F) {
  int count = 0;
  double f[72], df[72];
  for (int l = 2; l <= degree; l += 2) count += l;
  for (int m = 1; m <= degree; ++m) {
    normalized_Fk_dF(m, 0, degree, i0, f, df);
    // term index of (l, m): sum over even l' < l of l', plus m - 1
    for (int l = (m + 1) / 2 * 2; l <= degree; l += 2) {
      const int j = (l - 2) * l / 4 + (m - 1);
      F[2 * j] = f[l];
      F[2 * j + 1] = df[l];
    }
  }
  return count;
}

struct MdailyEvalCache {
  const float* F = nullptr;
  uint64_t table_id = 0;
  int degree = 0;
  float f0 = -1e30f, f1 = -1e30f;
  double a = -1.0, a_bake = -1.0, e2 = -1.0;
  bool keys_valid = false;
  uint64_t anchor_id = 0;                ///< the bracket the bakes were made on (0: state cells)
  int64_t kf_a = 0, kf_e = 0, kp_a = 0;  ///< the points of the full bake (a, e^2) and of the a bake (mdaily_sync_cache)
  /// keys made on a bracket: its first time and length and the parts of each bake (md_keys_hold); false: cell keys
  bool on_bracket = false;
  double kb_tlo = 0.0, kb_h = 0.0;
  int32_t n_full = 0, n_part = 0;
  alignas(16) double c0_pair1[20][2]{};
  alignas(16) double s0_pair1[20][2]{};
  alignas(16) double c0_pair2[20][2]{};
  alignas(16) double s0_pair2[20][2]{};
  alignas(16) double dc_pair1[20][2]{};
  alignas(16) double ds_pair1[20][2]{};
  alignas(16) double dc_pair2[20][2]{};
  alignas(16) double ds_pair2[20][2]{};
  alignas(16) double c_pair1[20][2]{};
  alignas(16) double s_pair1[20][2]{};
  alignas(16) double c_pair2[20][2]{};
  alignas(16) double s_pair2[20][2]{};
  alignas(16) float c10_f[24]{}, s10_f[24]{};
  alignas(16) float c11_f[24]{}, s11_f[24]{};
  alignas(16) float c20_f[24]{}, s20_f[24]{};
  alignas(16) float c21_f[24]{}, s21_f[24]{};
};
// stack #497: the cache's rows are indexed by the order m up to the m-daily degree (kMdailyCap) and padded to quads
static_assert(kMdailyCap < 20, "MdailyEvalCache's per-order rows hold orders 1 to kMdailyCap");
static_assert(((kMdailyCap + 3) & ~3) <= 24, "MdailyEvalCache's single-precision rows hold kMdailyCap orders padded to quads");
static_assert(kMdailyCap + 1 < 72, "mdaily_terms' inclination functions hold degrees to kMdailyCap");
inline thread_local MdailyEvalCache g_mdaily_eval_cache{};
/// The set being flown keeps its own (xp_theory.inc SetCaches); nullptr: the thread's.
inline thread_local MdailyEvalCache* g_mdaily_set_cache = nullptr;
inline MdailyEvalCache& mdaily_eval_cache() { return g_mdaily_set_cache != nullptr ? *g_mdaily_set_cache : g_mdaily_eval_cache; }

/// The m-daily corrections in the six-component set (n-dot, e-dot, i-dot,
/// e varpi, sin i Omega, lambda order), first order, at the mean elements k;
/// F the object's mdaily_terms (degree even l up to `degree`).
/// The m-daily terms baked for the state (a_state, e2_state) at time t, in full (a relative 3e-5, e^2 2e-6), then in a
/// (relative 2e-6), each at a point that is a function of the state's bracket and t (sp_anchor_point), or without the
/// bracket of the state alone (the center of its cell).
[[gnu::noinline]] inline void mdaily_sync_cache(MdailyEvalCache& mc, const float* F, int degree, double a_state, double e2_state,
                                                double t, uint64_t table_id = 0) {
  double a_full, e2_full, a_part;
  int64_t kfa, kfe = 0, kpa;
  const bool anchored = sp_anchored(t);
  if (anchored) {
    double e_f, c_f, e_p, c_p;
    kfa = sp_anchor_point(g_sp_anchor, t, 3e-5, 2e-6, true, 0.0, a_full, e_f, c_f);
    e2_full = e_f * e_f;
    kpa = sp_anchor_point(g_sp_anchor, t, 2e-6, 1e30, false, 0.0, a_part, e_p, c_p);
  } else {
    kfa = sp_cell_rel(a_state, 3e-5, a_full);
    kfe = sp_cell_abs(e2_state, 2e-6, e2_full);
    kpa = sp_cell_rel(a_state, 2e-6, a_part);
  }
  const uint64_t aid = anchored ? g_sp_anchor.id : 0;
  const bool full = table_id == 0 || mc.table_id != table_id || mc.F != F || mc.degree != degree || mc.f0 != F[0] ||
                    mc.f1 != F[1] || !mc.keys_valid || mc.anchor_id != aid || kfa != mc.kf_a || kfe != mc.kf_e;
  // what md_keys_hold compares with: the keys below are the cache's when this call returns (kept, or baked now)
  mc.on_bracket = anchored;
  if (anchored) {
    mc.kb_tlo = g_sp_anchor.tlo;
    mc.kb_h = g_sp_anchor.h;
    mc.n_full = static_cast<int32_t>(kfa >> 6);
    mc.n_part = static_cast<int32_t>(kpa >> 6);
  }
  if (!full && kpa == mc.kp_a) return;
  const double a = full ? a_full : a_part, e2 = e2_full;
  auto sync_f32 = [&]() {
    if (degree <= 20) {
      const int n_quad = (degree + 3) & ~3;
      for (int m = 1; m <= degree; ++m) {
        const int idx = m - 1;
        mc.c10_f[idx] = static_cast<float>(mc.c_pair1[m][0]);
        mc.s10_f[idx] = static_cast<float>(mc.s_pair1[m][0]);
        mc.c11_f[idx] = static_cast<float>(mc.c_pair1[m][1]);
        mc.s11_f[idx] = static_cast<float>(mc.s_pair1[m][1]);
        mc.c20_f[idx] = static_cast<float>(mc.c_pair2[m][0]);
        mc.s20_f[idx] = static_cast<float>(mc.s_pair2[m][0]);
        mc.c21_f[idx] = static_cast<float>(mc.c_pair2[m][1]);
        mc.s21_f[idx] = static_cast<float>(mc.s_pair2[m][1]);
      }
      for (int idx = degree; idx < n_quad; ++idx) {
        mc.c10_f[idx] = mc.s10_f[idx] = 0.0f;
        mc.c11_f[idx] = mc.s11_f[idx] = 0.0f;
        mc.c20_f[idx] = mc.s20_f[idx] = 0.0f;
        mc.c21_f[idx] = mc.s21_f[idx] = 0.0f;
      }
    }
  };
  if (full) {
    mc.F = F;
    mc.table_id = table_id;
    mc.keys_valid = true;
    mc.anchor_id = aid;
    mc.kf_a = kfa;
    mc.kf_e = kfe;
    mc.kp_a = INT64_MIN;
    mc.degree = degree;
    mc.f0 = F[0];
    mc.f1 = F[1];
    mc.a = a;
    mc.a_bake = a;
    mc.e2 = e2;
    for (int m = 1; m <= degree; ++m) {
      mc.c0_pair1[m][0] = mc.c0_pair1[m][1] = 0.0;
      mc.s0_pair1[m][0] = mc.s0_pair1[m][1] = 0.0;
      mc.c0_pair2[m][0] = mc.c0_pair2[m][1] = 0.0;
      mc.s0_pair2[m][0] = mc.s0_pair2[m][1] = 0.0;
      mc.dc_pair1[m][0] = mc.dc_pair1[m][1] = 0.0;
      mc.ds_pair1[m][0] = mc.ds_pair1[m][1] = 0.0;
      mc.dc_pair2[m][0] = mc.dc_pair2[m][1] = 0.0;
      mc.ds_pair2[m][0] = mc.ds_pair2[m][1] = 0.0;
    }
    const double g2 = 1.0 / (1.0 - e2);
    const double ia = 1.0 / a;
    double A = kMu * ia * ia * ia;
    double W = g2 * std::sqrt(g2);
    const double e2_4 = 0.25 * e2;
    int j = 0;
    for (int l = 2; l <= degree; l += 2) {
      double Q = 1.0, dQ_oe = 0.0, term = 1.0;
      for (int s2 = 2, k_idx = 1; s2 <= l - 1; s2 += 2, ++k_idx) {
        const double step_f = static_cast<double>((l - s2 + 1) * (l - s2)) * kInvM[k_idx] * kInvM[k_idx];
        dQ_oe += (term * step_f) * (0.25 * s2);
        term *= step_f * e2_4;
        Q += term;
      }
      const double G = W * Q;
      const double dG_oe = W * ((2.0 * l - 1.0) * g2 * Q + dQ_oe);
      const double AG = A * G, AdG_oe = A * dG_oe;
      const double lp1 = static_cast<double>(l + 1);
      for (int m = 1; m <= l; ++m, ++j) {
        const double C = kEgmC[l][m], S = kEgmS[l][m];
        const double Fv = F[2 * j], dF = F[2 * j + 1];
        const bool odd = ((l - m) & 1) != 0;
        const double inv_m = kInvM[m];
        const double sc_psi = odd ? -S : C, ss_psi = odd ? C : S;
        const double sc_1 = (odd ? -C : -S) * inv_m, ss_1 = (odd ? -S : C) * inv_m;
        const double AFG = AG * Fv, AdFG = AG * dF, AFdG_oe = AdG_oe * Fv;
        const double t_c10 = AFG * sc_psi, t_s10 = AFG * ss_psi;
        const double t_c11 = (lp1 * AFG) * sc_1, t_s11 = (lp1 * AFG) * ss_1;
        const double t_c20 = AdFG * sc_1, t_s20 = AdFG * ss_1;
        const double t_c21 = AFdG_oe * sc_1, t_s21 = AFdG_oe * ss_1;
        mc.c0_pair1[m][0] += t_c10;
        mc.s0_pair1[m][0] += t_s10;
        mc.c0_pair1[m][1] += t_c11;
        mc.s0_pair1[m][1] += t_s11;
        mc.c0_pair2[m][0] += t_c20;
        mc.s0_pair2[m][0] += t_s20;
        mc.c0_pair2[m][1] += t_c21;
        mc.s0_pair2[m][1] += t_s21;
        mc.dc_pair1[m][0] += lp1 * t_c10;
        mc.ds_pair1[m][0] += lp1 * t_s10;
        mc.dc_pair1[m][1] += lp1 * t_c11;
        mc.ds_pair1[m][1] += lp1 * t_s11;
        mc.dc_pair2[m][0] += lp1 * t_c20;
        mc.ds_pair2[m][0] += lp1 * t_s20;
        mc.dc_pair2[m][1] += lp1 * t_c21;
        mc.ds_pair2[m][1] += lp1 * t_s21;
      }
      A *= ia * ia;
      W *= g2 * g2;
    }
    for (int m = 1; m <= degree; ++m) {
      mc.c_pair1[m][0] = mc.c0_pair1[m][0];
      mc.c_pair1[m][1] = mc.c0_pair1[m][1];
      mc.s_pair1[m][0] = mc.s0_pair1[m][0];
      mc.s_pair1[m][1] = mc.s0_pair1[m][1];
      mc.c_pair2[m][0] = mc.c0_pair2[m][0];
      mc.c_pair2[m][1] = mc.c0_pair2[m][1];
      mc.s_pair2[m][0] = mc.s0_pair2[m][0];
      mc.s_pair2[m][1] = mc.s0_pair2[m][1];
    }
    sync_f32();
  }
  if (kpa != mc.kp_a) {
    mc.kp_a = kpa;
    mc.a_bake = a_part;
    const double u_a = mc.a / a_part - 1.0;
#ifdef __wasm_simd128__
    const v128_t vu = wasm_f64x2_splat(u_a);
    for (int m = 1; m <= degree; ++m) {
      wasm_v128_store(mc.c_pair1[m], wasm_f64x2_add(wasm_v128_load(mc.c0_pair1[m]), wasm_f64x2_mul(wasm_v128_load(mc.dc_pair1[m]), vu)));
      wasm_v128_store(mc.s_pair1[m], wasm_f64x2_add(wasm_v128_load(mc.s0_pair1[m]), wasm_f64x2_mul(wasm_v128_load(mc.ds_pair1[m]), vu)));
      wasm_v128_store(mc.c_pair2[m], wasm_f64x2_add(wasm_v128_load(mc.c0_pair2[m]), wasm_f64x2_mul(wasm_v128_load(mc.dc_pair2[m]), vu)));
      wasm_v128_store(mc.s_pair2[m], wasm_f64x2_add(wasm_v128_load(mc.s0_pair2[m]), wasm_f64x2_mul(wasm_v128_load(mc.ds_pair2[m]), vu)));
    }
#else
    for (int m = 1; m <= degree; ++m) {
      mc.c_pair1[m][0] = mc.c0_pair1[m][0] + mc.dc_pair1[m][0] * u_a;
      mc.c_pair1[m][1] = mc.c0_pair1[m][1] + mc.dc_pair1[m][1] * u_a;
      mc.s_pair1[m][0] = mc.s0_pair1[m][0] + mc.ds_pair1[m][0] * u_a;
      mc.s_pair1[m][1] = mc.s0_pair1[m][1] + mc.ds_pair1[m][1] * u_a;
      mc.c_pair2[m][0] = mc.c0_pair2[m][0] + mc.dc_pair2[m][0] * u_a;
      mc.c_pair2[m][1] = mc.c0_pair2[m][1] + mc.dc_pair2[m][1] * u_a;
      mc.s_pair2[m][0] = mc.s0_pair2[m][0] + mc.ds_pair2[m][0] * u_a;
      mc.s_pair2[m][1] = mc.s0_pair2[m][1] + mc.ds_pair2[m][1] * u_a;
    }
#endif
    sync_f32();
  }
}

/// Whether mdaily_sync_cache would bake nothing for time t (stack #441): the cache holds F's terms, its keys were made
/// on the bracket g_sp_anchor names, and t lies in the same part of it for both bakes. The same tests and keys as
/// mdaily_sync_cache's (sp_anchored, sp_part_key), so it answers what that call would; inline, so a state that bakes
/// nothing makes no call.
[[gnu::always_inline]] inline bool md_keys_hold(const MdailyEvalCache& mc, const float* F, int degree, double t, uint64_t table_id) {
  const SpAnchor& an = g_sp_anchor;
  if (!mc.on_bracket || !mc.keys_valid || table_id == 0 || mc.table_id != table_id || mc.F != F || mc.degree != degree ||
      mc.f0 != F[0] || mc.f1 != F[1] || !an.valid || an.h == 0.0 || an.id != mc.anchor_id || an.tlo != mc.kb_tlo ||
      an.h != mc.kb_h)
    return false;
  const double q = (t - an.tlo) / an.h;
  if (!(q >= 0.0 && q <= 1.0)) return false;
  return sp_part_key(q, mc.n_full) == mc.kf_a && mc.kf_e == 0 && sp_part_key(q, mc.n_part) == mc.kp_a;
}

[[gnu::always_inline]] inline void mdaily_six(
    const float* F, int degree, double t, const Kepler& k, double n, double eta, double si,
    double ci, double theta_g0, double* six, double* sb_out = nullptr, double* cb_out = nullptr,
    float* cm_f32_out = nullptr, float* sm_f32_out = nullptr, int* cm_count_out = nullptr,
    double* cm_last_out = nullptr, double* sm_last_out = nullptr,
    const double* sb_in = nullptr, const double* cb_in = nullptr, uint64_t table_id = 0) {
  const double a = k.a, e = k.e, e2 = e * e;
  MdailyEvalCache& mc = mdaily_eval_cache();
  if (!md_keys_hold(mc, F, degree, t, table_id)) mdaily_sync_cache(mc, F, degree, a, e2, t, table_id);
  double sb, cb;
  if (sb_in != nullptr && cb_in != nullptr) {
    sb = *sb_in;
    cb = *cb_in;
  } else {
    fm::sincos_fast(k.node - (theta_g0 + kOmegaE * t), sb, cb);
  }
  if (sb_out != nullptr) {
    *sb_out = sb;
    *cb_out = cb;
  }
  double cm = 1.0, sm = 0.0;
  double s_afg_psi = 0.0, s_afg_l1 = 0.0, s_adfg = 0.0, s_afdg_oe = 0.0;
#ifdef __wasm_simd128__
  if (t != 0.0 && degree >= 2 && degree <= 20) {
    const int n_quad = (degree + 3) & ~3;
    const double c1 = cb, s1 = sb;
    const double c2 = c1 * cb - s1 * sb, s2 = s1 * cb + c1 * sb;
    const double c3 = c2 * cb - s2 * sb, s3 = s2 * cb + c2 * sb;
    const double c4 = c3 * cb - s3 * sb, s4 = s3 * cb + c3 * sb;
    v128_t v_cm = wasm_f32x4_make(static_cast<float>(c1), static_cast<float>(c2), static_cast<float>(c3), static_cast<float>(c4));
    v128_t v_sm = wasm_f32x4_make(static_cast<float>(s1), static_cast<float>(s2), static_cast<float>(s3), static_cast<float>(s4));
    const v128_t v_c4 = wasm_f32x4_splat(static_cast<float>(c4));
    const v128_t v_s4 = wasm_f32x4_splat(static_cast<float>(s4));
    v128_t a10 = wasm_f32x4_splat(0.0f), a11 = wasm_f32x4_splat(0.0f);
    v128_t a20 = wasm_f32x4_splat(0.0f), a21 = wasm_f32x4_splat(0.0f);
    for (int idx = 0;;) {
      if (cm_f32_out != nullptr) {
        wasm_v128_store(cm_f32_out + idx, v_cm);
        wasm_v128_store(sm_f32_out + idx, v_sm);
      }
      a10 = wasm_f32x4_add(a10, wasm_f32x4_add(wasm_f32x4_mul(wasm_v128_load(mc.c10_f + idx), v_cm),
                                               wasm_f32x4_mul(wasm_v128_load(mc.s10_f + idx), v_sm)));
      a11 = wasm_f32x4_add(a11, wasm_f32x4_add(wasm_f32x4_mul(wasm_v128_load(mc.c11_f + idx), v_cm),
                                               wasm_f32x4_mul(wasm_v128_load(mc.s11_f + idx), v_sm)));
      a20 = wasm_f32x4_add(a20, wasm_f32x4_add(wasm_f32x4_mul(wasm_v128_load(mc.c20_f + idx), v_cm),
                                               wasm_f32x4_mul(wasm_v128_load(mc.s20_f + idx), v_sm)));
      a21 = wasm_f32x4_add(a21, wasm_f32x4_add(wasm_f32x4_mul(wasm_v128_load(mc.c21_f + idx), v_cm),
                                               wasm_f32x4_mul(wasm_v128_load(mc.s21_f + idx), v_sm)));
      idx += 4;
      if (idx >= n_quad) break;
      const v128_t ncm = wasm_f32x4_sub(wasm_f32x4_mul(v_cm, v_c4), wasm_f32x4_mul(v_sm, v_s4));
      v_sm = wasm_f32x4_add(wasm_f32x4_mul(v_sm, v_c4), wasm_f32x4_mul(v_cm, v_s4));
      v_cm = ncm;
    }
    if (cm_f32_out != nullptr) {
      *cm_count_out = n_quad;
      *cm_last_out = wasm_f32x4_extract_lane(v_cm, 3);
      *sm_last_out = wasm_f32x4_extract_lane(v_sm, 3);
    }
    const v128_t s10_11 = wasm_f32x4_add(wasm_i32x4_shuffle(a10, a11, 0, 1, 4, 5),
                                         wasm_i32x4_shuffle(a10, a11, 2, 3, 6, 7));
    const v128_t s20_21 = wasm_f32x4_add(wasm_i32x4_shuffle(a20, a21, 0, 1, 4, 5),
                                         wasm_i32x4_shuffle(a20, a21, 2, 3, 6, 7));
    const v128_t sums = wasm_f32x4_add(wasm_i32x4_shuffle(s10_11, s20_21, 0, 2, 4, 6),
                                       wasm_i32x4_shuffle(s10_11, s20_21, 1, 3, 5, 7));
    s_afg_psi = wasm_f32x4_extract_lane(sums, 0);
    s_afg_l1 = wasm_f32x4_extract_lane(sums, 1);
    s_adfg = wasm_f32x4_extract_lane(sums, 2);
    s_afdg_oe = wasm_f32x4_extract_lane(sums, 3);
  } else {
    v128_t acc1 = wasm_f64x2_splat(0.0);
    v128_t acc2 = wasm_f64x2_splat(0.0);
    for (int m = 1; m <= degree; ++m) {
      const double ncm = cm * cb - sm * sb;
      sm = sm * cb + cm * sb;
      cm = ncm;
      if (cm_f32_out != nullptr) {
        cm_f32_out[m - 1] = static_cast<float>(cm);
        sm_f32_out[m - 1] = static_cast<float>(sm);
      }
      const v128_t v_cm = wasm_f64x2_splat(cm);
      const v128_t v_sm = wasm_f64x2_splat(sm);
      acc1 = wasm_f64x2_add(acc1, wasm_f64x2_add(wasm_f64x2_mul(wasm_v128_load(mc.c_pair1[m]), v_cm),
                                                 wasm_f64x2_mul(wasm_v128_load(mc.s_pair1[m]), v_sm)));
      acc2 = wasm_f64x2_add(acc2, wasm_f64x2_add(wasm_f64x2_mul(wasm_v128_load(mc.c_pair2[m]), v_cm),
                                                 wasm_f64x2_mul(wasm_v128_load(mc.s_pair2[m]), v_sm)));
    }
    if (cm_f32_out != nullptr) {
      *cm_count_out = degree;
      *cm_last_out = cm;
      *sm_last_out = sm;
    }
    s_afg_psi = wasm_f64x2_extract_lane(acc1, 0);
    s_afg_l1 = wasm_f64x2_extract_lane(acc1, 1);
    s_adfg = wasm_f64x2_extract_lane(acc2, 0);
    s_afdg_oe = wasm_f64x2_extract_lane(acc2, 1);
  }
#else
  for (int m = 1; m <= degree; ++m) {
    const double ncm = cm * cb - sm * sb;
    sm = sm * cb + cm * sb;
    cm = ncm;
    if (cm_f32_out != nullptr) {
      cm_f32_out[m - 1] = static_cast<float>(cm);
      sm_f32_out[m - 1] = static_cast<float>(sm);
    }
    s_afg_psi += mc.c_pair1[m][0] * cm + mc.s_pair1[m][0] * sm;
    s_afg_l1 += mc.c_pair1[m][1] * cm + mc.s_pair1[m][1] * sm;
    s_adfg += mc.c_pair2[m][0] * cm + mc.s_pair2[m][0] * sm;
    s_afdg_oe += mc.c_pair2[m][1] * cm + mc.s_pair2[m][1] * sm;
  }
  if (cm_f32_out != nullptr) {
    *cm_count_out = degree;
    *cm_last_out = cm;
    *sm_last_out = sm;
  }
#endif
  const double sin_i = std::fabs(si) < 1e-12 ? (si < 0.0 ? -1e-12 : 1e-12) : si;
  const double p = a * eta * eta;
  const double na2 = n * a * a;
#ifdef __wasm_simd128__
  const v128_t vd0 = wasm_f64x2_div(wasm_f64x2_splat(1.0), wasm_f64x2_make(p * p, eta));
  const v128_t vd2 = wasm_f64x2_div(wasm_f64x2_splat(1.0), wasm_f64x2_make(sin_i, 1.0 + eta));
  const double node_rate = -1.5 * n * kJ2 * ci * wasm_f64x2_extract_lane(vd0, 0);
  const double inv_eta = wasm_f64x2_extract_lane(vd0, 1);
  const v128_t vd1 = wasm_f64x2_div(wasm_f64x2_splat(1.0), wasm_f64x2_make(na2 * (node_rate - kOmegaE), 1.0 + ci));
  const double inv_na2_bdot = wasm_f64x2_extract_lane(vd1, 0);
  const double tanhalf = sin_i * wasm_f64x2_extract_lane(vd1, 1);
  const double dsO = (inv_na2_bdot * inv_eta) * s_adfg;
  const double th_dsO = tanhalf * dsO;
  six[2] += (-inv_na2_bdot * inv_eta * wasm_f64x2_extract_lane(vd2, 0)) * s_afg_psi;
  six[3] += e * ((eta * inv_na2_bdot) * s_afdg_oe + th_dsO);
  six[4] += dsO;
  six[5] += (2.0 * inv_na2_bdot) * s_afg_l1 + ((eta * e2 * wasm_f64x2_extract_lane(vd2, 1)) * inv_na2_bdot) * s_afdg_oe + th_dsO;
#else
  const double node_rate = -1.5 * n * kJ2 * ci / (p * p);
  const double tanhalf = sin_i / (1.0 + ci);
  const double inv_na2_bdot = 1.0 / (na2 * (node_rate - kOmegaE));
  const double inv_eta = 1.0 / eta;
  const double dsO = (inv_na2_bdot * inv_eta) * s_adfg;
  const double th_dsO = tanhalf * dsO;
  six[2] += (-inv_na2_bdot * inv_eta / sin_i) * s_afg_psi;
  six[3] += e * ((eta * inv_na2_bdot) * s_afdg_oe + th_dsO);
  six[4] += dsO;
  six[5] += (2.0 * inv_na2_bdot) * s_afg_l1 + ((eta * e2 / (1.0 + eta)) * inv_na2_bdot) * s_afdg_oe + th_dsO;
#endif
}

/// The remaining first-order tesseral terms at output time, grouped by unique (m, w, j) angle psi = w omega + j M + m beta.
/// All degrees l sharing (m, w, j) are pre-combined at the epoch (a0, e0) along with their exact first/second derivatives
/// in da = a0 / a - 1 and de = e - e0.
struct SpCoef {
  int8_t l, m, w, j;
  float f, df, g0, g1;
};

struct SpCombCoef {
  int8_t m, w, j, pad;
  float uc0, us0, dc0, ds0, dca, dsa, ec0, es0, eca, esa, ic0, is0, ica, isa, ice, ise;
};

struct EgmTables {
  double hypot_cs[72][72]{};
  double hypot_fb[72][72]{};
};
[[gnu::noinline]] inline void init_egm_tables(EgmTables& out) {
  for (int l = 0; l <= 70; ++l) {
    const double fb = std::sqrt(2.0 * (2.0 * l + 1.0));
    for (int m = 0; m <= l; ++m) {
      const double h = std::sqrt(kEgmC[l][m] * kEgmC[l][m] + kEgmS[l][m] * kEgmS[l][m]);
      out.hypot_cs[l][m] = h;
      out.hypot_fb[l][m] = h * fb;
    }
  }
}
inline const EgmTables& egm_tables() {
  static EgmTables t;
  static int32_t ready = 0;
  if (__builtin_expect(__atomic_load_n(&ready, __ATOMIC_ACQUIRE) == 0, 0)) {
    init_egm_tables(t);
    __atomic_store_n(&ready, 1, __ATOMIC_RELEASE);
  }
  return t;
}

struct SpTermsScratch {
  double Fw[3][35][72];
  alignas(16) double AB_re[18][38];
  alignas(16) double AB_im[18][38];
  alignas(16) double dAB_re[18][38];
  alignas(16) double dAB_im[18][38];
  int8_t comp_lmax[72][35];  ///< sp_terms' complement: per order m and w + 17, the highest degree of a slow-held term above the table's
};
// stack #497: the general table's rows are indexed by w + 17 and |w| for |w| up to its degree (kSpCap), the degrees to 70
static_assert(kSpCap <= 17, "SpTermsScratch's w rows (35) and |w| rows (18) hold |w| up to kSpCap");
inline thread_local SpTermsScratch* g_sp_terms_scratch_ptr = nullptr;
/// Made by pool::warm_thread before the thread's first state or initialization (stack #600). False when it cannot be had.
inline bool sp_terms_scratch_make() {
  if (g_sp_terms_scratch_ptr == nullptr) g_sp_terms_scratch_ptr = sdnap::mem::counted(new (std::nothrow) SpTermsScratch{});
  return g_sp_terms_scratch_ptr != nullptr;
}
inline SpTermsScratch& sp_terms_scratch() {
  if (__builtin_expect(!g_sp_terms_scratch_ptr, 0) && !sp_terms_scratch_make()) __builtin_trap();  // a thread warm_thread did not reach
  return *g_sp_terms_scratch_ptr;
}

/// The tables sp_terms fills at their bounds (sp_comb_bound, sp_bound), per thread (stack #477): a set's build fills them
/// here and keeps a copy at its counts. A build that took each table at its bound and cut it down after left the rest
/// free between the sets' tables, a hole the next build's bound does not fit (on 1,000 sets of a catalog mix at tesseral 31:
/// 224 MB of heap against 52 MB, 167 MB of it free inside). Grown to the largest bound this thread has asked for (755 KB at
/// tesseral 31, 3.1 MB at 70) and kept for the thread's life, as the other per-thread scratch is; never shared.
struct SpTableScratch {
  SpCombCoef* comb = nullptr;
  SpCoef* raw = nullptr;
  size_t comb_cap = 0, raw_cap = 0;
};
inline thread_local SpTableScratch g_sp_table_scratch{};
/// This thread's scratch with room for `comb` and `raw` entries, or nullptr out of memory (what it held is kept). Its
/// contents are not kept across a growth: sp_terms writes every entry it counts.
inline SpTableScratch* sp_table_scratch(size_t comb, size_t raw) {
  SpTableScratch& sc = g_sp_table_scratch;
  if (comb > sc.comb_cap) {
    SpCombCoef* p = static_cast<SpCombCoef*>(sdnap::mem::malloc(comb * sizeof(SpCombCoef)));
    if (p == nullptr) return nullptr;
    std::free(sc.comb);
    sc.comb = p;
    sc.comb_cap = comb;
  }
  if (raw > sc.raw_cap) {
    SpCoef* p = static_cast<SpCoef*>(sdnap::mem::malloc(raw * sizeof(SpCoef)));
    if (p == nullptr) return nullptr;
    std::free(sc.raw);
    sc.raw = p;
    sc.raw_cap = raw;
  }
  return &sc;
}

/// G about e0 for one term: g0 + g1 e.
inline void sp_g(int l, int p, int q, double e0, double& g0, double& g1) {
  const int w = l - 2 * p;
  if (q == 0) {
    // X^{-(l+1), w}_w to O(e^2): 1 + c2 e^2, c2 = l (l + 1) / 4 - w^2; linearized at e0
    const double c2 = 0.25 * l * (l + 1) - static_cast<double>(w) * w;
    double G, dG;
    if (e0 < 0.03) { G = 1.0 + c2 * e0 * e0; dG = 2.0 * c2 * e0; }
    else res::exact_G(l, p, 0, e0, G, dG);
    g1 = dG;
    g0 = G - dG * e0;
  } else if (e0 < 0.03) {
    // O(e): G = e ((l + 1) / 2 + q w), from (a/r)^(l+1) ~ 1 + (l + 1) e cos M and f ~ M + 2 e sin M averaged over M.
    g1 = 0.5 * (l + 1) + q * w;
    g0 = 0.0;
  } else {
    double G, dG;
    res::exact_G(l, p, q, e0, G, dG);
    g1 = dG;
    g0 = G - dG * e0;
  }
}

/// The upper bound of the table: per degree l, l orders x (min(l, kSpMaxW) + 1) w values x 3 q values (the m-daily terms
/// among them), + kNearMax, + `extra` (sp_terms' complement: at most one entry per slow-held term).
constexpr int kNearMax = 500;
inline int sp_bound(int degree, bool wide, int extra = 0) {
  int c = kNearMax + extra;
  for (int l = 2; l <= degree && !wide; ++l) c += l * ((l < kSpMaxW ? l : kSpMaxW) + 1) * 3;
  return c;
}
inline int sp_comb_bound(int degree, bool wide, int extra = 0) {
  if (wide) return kNearMax + extra;
  const int wmax = degree < kSpMaxW ? degree : kSpMaxW;
  return (degree + 3) * (2 * wmax + 1) * 3 + kNearMax + extra;
}

/// Fills out at the epoch mean motion n0, inclination i0 and eccentricity e0; returns the count. `cls`: the resonance class,
/// whose terms the rates carry and this table must not. `low`: no class and the shallow set active, so a term near
/// commensurability other than the shallow set's is kept here. `wide`: the set's branch (wide_set at its epoch, or its
/// covariance nominal's, xpt::Branch): the families are on the grid and the table holds the near-resonant terms only.
/// `slow_held` (SPEC 16.18, the low table with Terms::slow): the slow set's list; a term it holds beyond the shallow set's own
/// is the rates' inside the band, and the table keeps 1 minus the band taper of it (nothing in both places, nothing in neither).
/// `mdaily_degree`: the m-daily family's degree; an m-daily term (q = 0, l = 2p) above it is this table's (the low table's
/// fast side, a degree above kSpCap), at or below it the family's (the default: every m-daily term the family's).
/// `fast_side` (the low table with the record's degree above kSpCap): no term is carried here inside the slow band at more
/// than 1 minus the band taper of its epoch rate (a first-order term is the theory only away from commensurability; the
/// band's terms are the rates', and one the rates do not hold, under their size cut, is carried nowhere), and with
/// slow_held a slow-held term above `degree` (the slow set takes its own degree, kSlowDegree) is this table's too, by the
/// same 1 minus the band taper, for q of -1, 0 and 1. A share under 1 is cut on the term's own size.
/// `n_end` (the fast side, 0 for none): the mean motion 8 days on at the set's own drag rate at the epoch, a straight line
/// with e and i held. The table's share of a term is then the smaller of its two ends' (1 minus the larger band taper), and
/// none where the term's rate changes sign between them. For n between n0 and n_end the table and the rates (which carry a
/// band term at its current rate) never hold more than the whole term, and the table holds no term whose rate passes zero
/// (the evaluator divides by the current rate). A term the guard takes from the table is the rates' where the slow set holds
/// it and carried nowhere where it does not. Not covered: n outside [n0, n_end] (a flight before the epoch, past 8 days, or
/// decaying faster than the epoch's rate; SPEC 16.1). A set that barely decays keeps its epoch shares.
inline int sp_terms(int degree, int near_degree, int cls, bool low, bool wide, double n0, double i0, double e0, SpCombCoef* out,
                    SpCoef* raw_out = nullptr, int* raw_count_out = nullptr, const ShallowTerms* slow_held = nullptr,
                    int mdaily_degree = kFastCap + 2, bool fast_side = false, double n_end = 0.0) {
  int raw_count = 0;
  const EgmTables& egm = egm_tables();
  const double eta = std::sqrt(1.0 - e0 * e0), a0 = std::pow(kKe / n0, kX2o3), p0 = a0 * eta * eta;
  const double c0 = std::cos(i0), j2 = 1.5 * kJ2 / (p0 * p0);
  const double mdot = n0 + 0.5 * j2 * n0 * eta * (3.0 * c0 * c0 - 1.0), wdot = 0.5 * j2 * n0 * (5.0 * c0 * c0 - 1.0);
  const double node_rate = -j2 * n0 * c0;
  const double h = 1e-5, inv_2h = 1.0 / (2.0 * h);
  const double na2 = n0 * a0 * a0, keep = kSpKeepM * 1e-3 / kRe;
  const double inv_na2 = 1.0 / na2, inv_a02 = 1.0 / (a0 * a0);
  const double inv_shallow_n0 = 1.0 / (kShallowBand * n0);
  const res::TermSet carried = res::class_terms(cls);

  const double ia0 = 1.0 / a0;
  double amp0[72];
  amp0[0] = kMu * ia0;
  for (int l = 1; l <= 70; ++l) amp0[l] = amp0[l - 1] * ia0;
  const bool fast_on = fast_side && low && !wide;
  // the J2 rates at the span's end (n_end): e and i held, the drag moves n
  const bool guard = fast_on && n_end > n0;
  double mdot_e = 0.0, wdot_e = 0.0, node_e = 0.0, inv_shallow_ne = 0.0;
  if (guard) {
    const double ae = std::pow(kKe / n_end, kX2o3), pe = ae * eta * eta, j2e = 1.5 * kJ2 / (pe * pe);
    mdot_e = n_end + 0.5 * j2e * n_end * eta * (3.0 * c0 * c0 - 1.0);
    wdot_e = 0.5 * j2e * n_end * (5.0 * c0 * c0 - 1.0);
    node_e = -j2e * n_end * c0;
    inv_shallow_ne = 1.0 / (kShallowBand * n_end);
  }

  const auto weight_of = [&](int l, int m, int p, int q, double& psidot) -> double {
    const int w = l - 2 * p, j = w + q;
    if (cls == 2 && l > 5 && l <= near_degree && (m & 1) == 0 && j == m / 2) return 0.0;
    if (one_day_tail(cls, wide, near_degree) && l > 4 && l <= near_degree && m <= kOneDayTailMaxOrder && j == m) return 0.0;
    for (int c = 0; c < carried.count; ++c)
      if (carried.t[c].l == l && carried.t[c].m == m && carried.t[c].p == p && carried.t[c].q == q) return 0.0;
    psidot = w * wdot + j * mdot + m * (node_rate - kOmegaE);
    double weight = 1.0;
    const double x = std::fabs(psidot) * inv_shallow_n0;
    if (low) {
      if (slow_held != nullptr && !(q == 0 && w == 1 && j == 1) && x < 1.3 && slow_holds(slow_held, l, m, p, q)) {
        weight = 1.0 - band_taper(x);
      } else if (q == 0 && w == 1 && j == 1) {
        if (x <= 0.9) weight = 0.0;
        else if (x < 1.1) { const double c = std::cos(0.5 * kPi * (x - 0.9) / 0.2); weight = 1.0 - c * c; }
      } else if (std::fabs(psidot) < 1e-3 * n0) {
        weight = 0.0;
      } else if (fast_on) {
        weight = 1.0 - band_taper(x);
      }
    } else if (x < 1.0) {
      weight = 0.0;
    }
    if (guard && weight > 0.0) {
      const double psidot_e = w * wdot_e + j * mdot_e + m * (node_e - kOmegaE);
      if (psidot_e * psidot <= 0.0) return 0.0;
      const double t0 = band_taper(x), t1 = band_taper(std::fabs(psidot_e) * inv_shallow_ne);
      const double kept = 1.0 - (t1 > t0 ? t1 : t0);
      if (kept < weight) weight = kept;
    }
    return weight;
  };

  const double e_floor = e0 > 1e-3 ? e0 : 1e-3;
  const double e02 = e0 * e0;
  const auto can_pass = [&](int l, int m, int w, int q) {
    const int j = w + q;
    const double ap = std::fabs(w * wdot + j * mdot + m * (node_rate - kOmegaE));
    if (ap < 1e-3 * n0) return false;
    const double ll = l + 1.0;
    const double Gb = q == 0 ? 1.0 + (l * l) * e02 : ll * e_floor;
    const double a0_AFb = a0 * amp0[l] * egm.hypot_fb[l][m];
    const double lhs = a0_AFb * (Gb * (3.0 * std::abs(j) * inv_a02 + 2.0 * ll * inv_na2 * ap) +
                                 (ll * ll + l * Gb) * inv_na2 * ap);
    return lhs >= keep * ap * ap;
  };

  double si3[3], ci3[3];
  fm::sincos(i0, si3[0], ci3[0]);
  const bool analytic_df = std::fabs(ci3[0]) >= 1e-3;
  if (!analytic_df) {
    fm::sincos(i0 + h, si3[1], ci3[1]);
    fm::sincos(i0 - h, si3[2], ci3[2]);
  }

  SpTermsScratch& sp_sc = sp_terms_scratch();
  auto (&Fw)[3][35][72] = sp_sc.Fw;
  double col[104], dcol[104], cku[18], sku[18];

  // the complement: per (m, w), the highest degree above `degree` of a slow-held term of q -1, 0 or 1 (0: none)
  const bool comp_on = fast_on && slow_held != nullptr;
  int comp_m = 0;
  if (comp_on) comp_m = slow_complement_lmax(slow_held, degree, sp_sc.comp_lmax);
  const auto comp_l = [&](int m, int w) -> int { return comp_on ? sp_sc.comp_lmax[m][w + 17] : 0; };

  int count = 0;
  int max_m = low ? (near_degree > degree ? near_degree : degree) : (wide ? 0 : degree);
  if (comp_m > max_m) max_m = comp_m;
  for (int m = 1; m <= max_m; ++m) {
    const int wmax = degree < kSpMaxW ? degree : kSpMaxW;
    const int w_lo = !wide && m <= degree ? -wmax : 0;
    int w_hi = !wide && m <= degree ? wmax : 2;
    if (comp_on && m > degree && w_hi < kSlowJMax + 1) w_hi = kSlowJMax + 1;  // a slow term's w = j - q, j from 1 to kSlowJMax
    int l_max_w[35]{};
    int l_max_aw[18]{};
    int l_max_m = 0, aw_max_m = 0;
    for (int w = w_lo; w <= w_hi; ++w) {
      const int aw = w < 0 ? -w : w;
      int l0 = m > aw ? m : aw;
      if (l0 < 2) l0 = 2;
      if ((l0 - w) & 1) ++l0;
      const bool has_gen = !wide && m <= degree && aw <= degree;
      const bool has_near = low && m >= 2 && m <= near_degree && (w == 1 || w == 0 || w == 2) &&
                            (std::fabs(w * wdot + mdot + m * (node_rate - kOmegaE)) < kNearBand * n0);
      const int lc = comp_l(m, w);
      if (!has_gen && !has_near && lc == 0) continue;
      int lw = 0;
      if (has_near) {
        const int q_near = 1 - w;
        int ln0 = l0;
        while (ln0 <= degree) ln0 += 2;
        int l_top = near_degree;
        if ((l_top - ln0) & 1) --l_top;
        for (int l = l_top; l >= ln0; l -= 2) {
          if (can_pass(l, m, w, q_near)) { lw = l; break; }
        }
      }
      if (lw == 0 && has_gen) {
        int l_top = degree;
        if ((l_top - l0) & 1) --l_top;
        for (int l = l_top; l >= l0; l -= 2) {
          if (aw <= l && (can_pass(l, m, w, -1) || can_pass(l, m, w, 0) || can_pass(l, m, w, 1))) { lw = l; break; }
        }
      }
      if (lc > lw) lw = lc;
      l_max_w[w + 17] = lw;
      if (lw > 0) {
        if (lw > l_max_aw[aw]) l_max_aw[aw] = lw;
        if (lw > l_max_m) l_max_m = lw;
        if (aw > aw_max_m) aw_max_m = aw;
      }
    }
    if (l_max_m == 0) continue;

    const int NF = (l_max_m + aw_max_m + 3) & ~1;
    const int NF_HALF = NF >> 1;
    const int j_top = NF_HALF >> 1;
    const double du = kTwoPi / NF, two_inv_NF = 2.0 / NF_HALF;
    double sdu, cdu;
    fm::sincos(du, sdu, cdu);
    LegendreOrder L;
    legendre_order(m, l_max_m, L);
    auto (&AB_re)[18][38] = sp_sc.AB_re;
    auto (&AB_im)[18][38] = sp_sc.AB_im;
    auto (&dAB_re)[18][38] = sp_sc.dAB_re;
    auto (&dAB_im)[18][38] = sp_sc.dAB_im;
    alignas(16) double col_p[2][38], dcol_p[2][38];

    if (analytic_df) {
      for (int aw = 0; aw <= aw_max_m; ++aw) {
        const int k_lim = l_max_aw[aw] >> 1;
        std::memset(AB_re[aw], 0, static_cast<size_t>(k_lim + 1) * sizeof(double));
        std::memset(AB_im[aw], 0, static_cast<size_t>(k_lim + 1) * sizeof(double));
        std::memset(dAB_re[aw], 0, static_cast<size_t>(k_lim + 1) * sizeof(double));
        std::memset(dAB_im[aw], 0, static_cast<size_t>(k_lim + 1) * sizeof(double));
      }
      const double sis = si3[0], cis = ci3[0];
      double su = 0.0, cu = 1.0;
      for (int j = 0; j <= j_top; ++j) {
        if (j > 0) {
          const double nsu = su * cdu + cu * sdu;
          cu = cu * cdu - su * sdu;
          su = nsu;
        }
        const double w_j = (j == 0 || 2 * j == NF_HALF) ? 0.5 : 1.0;
        const double x = sis * su, c2_lat = 1.0 - x * x, c = std::sqrt(c2_lat);
        const double inv_c = 1.0 / c, inv_c2 = inv_c * inv_c;
        legendre_column(L, x, c, col);
        const double alpha_x = cis * su * inv_c2;
        const double beta_phi = -m * x * cu * inv_c2;
        dcol[m] = -alpha_x * (m * x * col[m]);
        for (int l = m + 1; l <= l_max_m; ++l) dcol[l] = alpha_x * (L.d[l] * col[l - 1] - l * x * col[l]);
        for (int l = m; l <= l_max_m; ++l) {
          col_p[l & 1][l >> 1] = col[l];
          dcol_p[l & 1][l >> 1] = dcol[l];
        }
        double sml = 0.0, cml = 1.0;
        if (j > 0) complex_pow(cu * inv_c, cis * su * inv_c, m, cml, sml);
        const double dcml = -beta_phi * sml, dsml = beta_phi * cml;
        cku[0] = 1.0;
        sku[0] = 0.0;
        for (int aw = 1; aw <= aw_max_m; ++aw) {
          cku[aw] = cku[aw - 1] * cu - sku[aw - 1] * su;
          sku[aw] = sku[aw - 1] * cu + cku[aw - 1] * su;
        }
        for (int aw = 0; aw <= aw_max_m; ++aw) {
          const int lim = l_max_aw[aw];
          if (lim == 0) continue;
          const double ck = cku[aw], sk = sku[aw];
          const bool odd = ((aw - m) & 1) != 0;
          const double c1 = (odd ? cml * sk : cml * ck) * w_j;
          const double c2 = (odd ? sml * ck : sml * sk) * w_j;
          const double dc1 = (odd ? dcml * sk : dcml * ck) * w_j;
          const double dc2 = (odd ? dsml * ck : dsml * sk) * w_j;
          int first = m > aw ? m : aw;
          if (first < 2) first = 2;
          if ((first - aw) & 1) ++first;
          const int p = first & 1;
          const int k_first = first >> 1, k_lim = lim >> 1;
          const double* cp_row = col_p[p];
          const double* dcp_row = dcol_p[p];
          double* re_row = AB_re[aw];
          double* im_row = AB_im[aw];
          double* dre_row = dAB_re[aw];
          double* dim_row = dAB_im[aw];
#ifdef __wasm_simd128__
          int k = k_first;
          if (k & 1) {
            const double Pl = cp_row[k], dPl = dcp_row[k];
            re_row[k] += Pl * c1;
            im_row[k] += Pl * c2;
            dre_row[k] += dPl * c1 + Pl * dc1;
            dim_row[k] += dPl * c2 + Pl * dc2;
            ++k;
          }
          const v128_t vc1 = wasm_f64x2_splat(c1), vc2 = wasm_f64x2_splat(c2);
          const v128_t vdc1 = wasm_f64x2_splat(dc1), vdc2 = wasm_f64x2_splat(dc2);
          for (; k + 1 <= k_lim; k += 2) {
            const v128_t vPl = wasm_v128_load(cp_row + k);
            const v128_t vdPl = wasm_v128_load(dcp_row + k);
            wasm_v128_store(re_row + k, wasm_f64x2_add(wasm_v128_load(re_row + k), wasm_f64x2_mul(vPl, vc1)));
            wasm_v128_store(im_row + k, wasm_f64x2_add(wasm_v128_load(im_row + k), wasm_f64x2_mul(vPl, vc2)));
            wasm_v128_store(dre_row + k, wasm_f64x2_add(wasm_v128_load(dre_row + k),
                                                        wasm_f64x2_add(wasm_f64x2_mul(vdPl, vc1), wasm_f64x2_mul(vPl, vdc1))));
            wasm_v128_store(dim_row + k, wasm_f64x2_add(wasm_v128_load(dim_row + k),
                                                        wasm_f64x2_add(wasm_f64x2_mul(vdPl, vc2), wasm_f64x2_mul(vPl, vdc2))));
          }
          if (k <= k_lim) {
            const double Pl = cp_row[k], dPl = dcp_row[k];
            re_row[k] += Pl * c1;
            im_row[k] += Pl * c2;
            dre_row[k] += dPl * c1 + Pl * dc1;
            dim_row[k] += dPl * c2 + Pl * dc2;
          }
#else
          for (int k = k_first; k <= k_lim; ++k) {
            const double Pl = cp_row[k], dPl = dcp_row[k];
            re_row[k] += Pl * c1;
            im_row[k] += Pl * c2;
            dre_row[k] += dPl * c1 + Pl * dc1;
            dim_row[k] += dPl * c2 + Pl * dc2;
          }
#endif
        }
      }
      for (int aw = 0; aw <= aw_max_m; ++aw) {
        const int lim = l_max_aw[aw];
        if (lim == 0) continue;
        const bool odd = ((aw - m) & 1) != 0;
        int first = m > aw ? m : aw;
        if (first < 2) first = 2;
        if ((first - aw) & 1) ++first;
        double* dst_pos = Fw[0][aw + 17];
        double* dst_neg = Fw[0][-aw + 17];
        double* ddst_pos = Fw[1][aw + 17];
        double* ddst_neg = Fw[1][-aw + 17];
        for (int l = first; l <= lim; l += 2) {
          const int k = l >> 1;
          const double a_val = AB_re[aw][k] * two_inv_NF, b_val = AB_im[aw][k] * two_inv_NF;
          const double da_val = dAB_re[aw][k] * two_inv_NF, db_val = dAB_im[aw][k] * two_inv_NF;
          dst_pos[l] = odd ? (a_val - b_val) : (a_val + b_val);
          ddst_pos[l] = odd ? (da_val - db_val) : (da_val + db_val);
          if (aw > 0) {
            dst_neg[l] = odd ? (-a_val - b_val) : (a_val - b_val);
            ddst_neg[l] = odd ? (-da_val - db_val) : (da_val - db_val);
          }
        }
      }
    } else {
      for (int s = 0; s < 3; ++s) {
        for (int aw = 0; aw <= aw_max_m; ++aw) {
          const int k_lim = l_max_aw[aw] >> 1;
          std::memset(AB_re[aw], 0, static_cast<size_t>(k_lim + 1) * sizeof(double));
          std::memset(AB_im[aw], 0, static_cast<size_t>(k_lim + 1) * sizeof(double));
        }
        const double sis = si3[s], cis = ci3[s];
        double su = 0.0, cu = 1.0;
        for (int j = 0; j <= j_top; ++j) {
          if (j > 0) {
            const double nsu = su * cdu + cu * sdu;
            cu = cu * cdu - su * sdu;
            su = nsu;
          }
          const double w_j = (j == 0 || 2 * j == NF_HALF) ? 0.5 : 1.0;
          const double x = sis * su, c = std::sqrt(std::fmax(0.0, 1.0 - x * x));
          legendre_column(L, x, c, col);
          for (int l = m; l <= l_max_m; ++l) col_p[l & 1][l >> 1] = col[l];
          double sml = 0.0, cml = 1.0;
          if (c > 1e-12) {
            const double inv_c = 1.0 / c;
            complex_pow(cu * inv_c, cis * su * inv_c, m, cml, sml);
          } else {
            fm::sincos(m * std::atan2(cis * su, cu), sml, cml);
          }
          cku[0] = 1.0;
          sku[0] = 0.0;
          for (int aw = 1; aw <= aw_max_m; ++aw) {
            cku[aw] = cku[aw - 1] * cu - sku[aw - 1] * su;
            sku[aw] = sku[aw - 1] * cu + cku[aw - 1] * su;
          }
          for (int aw = 0; aw <= aw_max_m; ++aw) {
            const int lim = l_max_aw[aw];
            if (lim == 0) continue;
            const double ck = cku[aw], sk = sku[aw];
            const bool odd = ((aw - m) & 1) != 0;
            const double c1 = (odd ? cml * sk : cml * ck) * w_j;
            const double c2 = (odd ? sml * ck : sml * sk) * w_j;
            int first = m > aw ? m : aw;
            if (first < 2) first = 2;
            if ((first - aw) & 1) ++first;
            const int p = first & 1;
            const int k_first = first >> 1, k_lim = lim >> 1;
            const double* cp_row = col_p[p];
            double* re_row = AB_re[aw];
            double* im_row = AB_im[aw];
            for (int k = k_first; k <= k_lim; ++k) {
              re_row[k] += cp_row[k] * c1;
              im_row[k] += cp_row[k] * c2;
            }
          }
        }
        for (int aw = 0; aw <= aw_max_m; ++aw) {
          const int lim = l_max_aw[aw];
          if (lim == 0) continue;
          const bool odd = ((aw - m) & 1) != 0;
          int first = m > aw ? m : aw;
          if (first < 2) first = 2;
          if ((first - aw) & 1) ++first;
          double* dst_pos = Fw[s][aw + 17];
          double* dst_neg = Fw[s][-aw + 17];
          for (int l = first; l <= lim; l += 2) {
            const int k = l >> 1;
            const double a_val = AB_re[aw][k] * two_inv_NF, b_val = AB_im[aw][k] * two_inv_NF;
            dst_pos[l] = odd ? (a_val - b_val) : (a_val + b_val);
            if (aw > 0) dst_neg[l] = odd ? (-a_val - b_val) : (a_val - b_val);
          }
        }
      }
    }

    for (int w = w_lo; w <= w_hi; ++w) {
      const int l_max = l_max_w[w + 17];
      if (l_max == 0) continue;
      const int aw = w < 0 ? -w : w;
      int l0 = m > aw ? m : aw;
      if (l0 < 2) l0 = 2;
      if ((l0 - w) & 1) ++l0;
      const bool has_gen = !wide && m <= degree && aw <= degree;
      const bool has_near = low && m >= 2 && m <= near_degree && (w == 1 || w == 0 || w == 2) &&
                            (std::fabs(w * wdot + mdot + m * (node_rate - kOmegaE)) < kNearBand * n0);
      const double* f = Fw[0][w + 17];
      const double* fp = Fw[1][w + 17];
      const double* fm = Fw[2][w + 17];
      const int lc = comp_l(m, w);

      for (int q = -1; q <= 1; ++q) {
        if (q == 0 && w == 0 && mdaily_degree >= degree) continue;  // every m-daily term the family's
        const int j = w + q;
        const bool q_near = has_near && (j == 1);
        if (!has_gen && !q_near && lc == 0) continue;

        double uc0 = 0, us0 = 0, dc0 = 0, ds0 = 0, dca = 0, dsa = 0;
        double ec0 = 0, es0 = 0, eca = 0, esa = 0;
        double ic0 = 0, is0 = 0, ica = 0, isa = 0, ice = 0, ise = 0;
        bool any = false;

        const int l_lim = q_near || lc > 0 ? l_max : (l_max < degree ? l_max : degree);
        for (int l = l0; l <= l_lim; l += 2) {
          if (q == 0 && w == 0 && l <= mdaily_degree) continue;  // the m-daily family's
          if (l <= degree) {
            if (!has_gen || aw > l || j < -(l + 1) || j > l + 1) continue;
          } else if (!(q_near && l <= near_degree)) {
            // above the degree: the near-resonant terms to the near degree, and the complement of a slow-held term
            if (l > lc || !slow_holds(slow_held, l, m, (l - w) / 2, q)) continue;
          }
          if (!can_pass(l, m, w, q)) continue;
          const int p = (l - w) / 2;
          double psidot = 0.0;
          const double weight = weight_of(l, m, p, q, psidot);
          if (weight == 0.0) continue;
          double g0, g1;
          sp_g(l, p, q, e0, g0, g1);
          const double fv = f[l], dfv = analytic_df ? fp[l] : (fp[l] - fm[l]) * inv_2h;
          const double G = g0 + g1 * e0;
          const double sv = egm.hypot_cs[l][m];
          const double A = amp0[l] * sv * weight;
          const double ap = std::fabs(psidot);
          const double mag = a0 * A * (std::fabs(fv * G) * (3.0 * std::abs(j) * inv_a02 + 2.0 * (l + 1) * inv_na2 * ap) +
                                       (std::fabs(fv * g1) + std::fabs(dfv * G)) * inv_na2 * ap);
          // on the fast side the cut is on the term's own size: a weight under 1 is the band taper's share of a term, kept
          // whatever the share
          if (mag < keep * ap * ap * (fast_on && weight < 1.0 ? weight : 1.0)) continue;

          const double f_w = static_cast<float>(fv * weight);
          const double df_w = static_cast<float>(dfv * weight);
          const double g0_f = static_cast<float>(g0);
          const double g1_f = static_cast<float>(g1);
          if (raw_out != nullptr) {
            raw_out[raw_count++] = SpCoef{static_cast<int8_t>(l), static_cast<int8_t>(m), static_cast<int8_t>(w),
                                          static_cast<int8_t>(j), static_cast<float>(f_w), static_cast<float>(df_w),
                                          static_cast<float>(g0_f), static_cast<float>(g1_f)};
          }
          const double G0 = g0_f + g1_f * e0;
          const double A0 = amp0[l];
          const bool odd = ((l - m) & 1) != 0;
          const double cl = odd ? -kEgmS[l][m] : kEgmC[l][m];
          const double sl = odd ? kEgmC[l][m] : kEgmS[l][m];
          const double lp1 = l + 1.0;

          const double afg = A0 * f_w * G0;
          const double afdg = A0 * f_w * g1_f;
          const double adfg = A0 * df_w * G0;
          const double adfdg = A0 * df_w * g1_f;

          uc0 += afg * cl;
          us0 += afg * sl;
          dc0 += -lp1 * afg * cl;
          ds0 += -lp1 * afg * sl;
          dca += -lp1 * l * afg * cl;
          dsa += -lp1 * l * afg * sl;
          ec0 += afdg * cl;
          es0 += afdg * sl;
          eca += lp1 * afdg * cl;
          esa += lp1 * afdg * sl;
          ic0 += adfg * cl;
          is0 += adfg * sl;
          ica += lp1 * adfg * cl;
          isa += lp1 * adfg * sl;
          ice += adfdg * cl;
          ise += adfdg * sl;
          any = true;
        }
        if (any) {
          out[count++] = SpCombCoef{
              static_cast<int8_t>(m),   static_cast<int8_t>(w),   static_cast<int8_t>(j),   0,
              static_cast<float>(uc0),  static_cast<float>(us0),  static_cast<float>(dc0),  static_cast<float>(ds0),
              static_cast<float>(dca),  static_cast<float>(dsa),  static_cast<float>(ec0),  static_cast<float>(es0),
              static_cast<float>(eca),  static_cast<float>(esa),  static_cast<float>(ic0),  static_cast<float>(is0),
              static_cast<float>(ica),  static_cast<float>(isa),  static_cast<float>(ice),  static_cast<float>(ise),
          };
        }
      }
    }
  }
  if (raw_count_out != nullptr) *raw_count_out = raw_count;
  if (count > 0) {
    static uint32_t g_sp_gen = 0;
    uint32_t gen = __atomic_add_fetch(&g_sp_gen, 1u, __ATOMIC_RELAXED);
    if (gen == 0u) gen = __atomic_add_fetch(&g_sp_gen, 1u, __ATOMIC_RELAXED);
    const int n_tag = count < 4 ? count : 4;
    for (int k = 0; k < n_tag; ++k) {
      out[k].pad = static_cast<int8_t>((gen >> (8 * k)) & 0xffu);
    }
  }
  return count;
}

alignas(16) static constexpr float kSpMSeq[76] = {
    1.0f,  2.0f,  3.0f,  4.0f,  5.0f,  6.0f,  7.0f,  8.0f,  9.0f,  10.0f, 11.0f, 12.0f, 13.0f, 14.0f, 15.0f, 16.0f,
    17.0f, 18.0f, 19.0f, 20.0f, 21.0f, 22.0f, 23.0f, 24.0f, 25.0f, 26.0f, 27.0f, 28.0f, 29.0f, 30.0f, 31.0f, 32.0f,
    33.0f, 34.0f, 35.0f, 36.0f, 37.0f, 38.0f, 39.0f, 40.0f, 41.0f, 42.0f, 43.0f, 44.0f, 45.0f, 46.0f, 47.0f, 48.0f,
    49.0f, 50.0f, 51.0f, 52.0f, 53.0f, 54.0f, 55.0f, 56.0f, 57.0f, 58.0f, 59.0f, 60.0f, 61.0f, 62.0f, 63.0f, 64.0f,
    65.0f, 66.0f, 67.0f, 68.0f, 69.0f, 70.0f, 71.0f, 72.0f, 73.0f, 74.0f, 75.0f, 76.0f};

struct alignas(16) SpRow {
  uint16_t blk_end;
  uint8_t wq0;
  uint8_t c_start;
  float wf;
  float qf;
  float jf;
};
static_assert(sizeof(SpRow) == 16, "");

/// A grouping's id (SpEvalCache::group_id), unique in the instance whichever thread groups.
inline uint64_t sp_next_group_id() {
  static uint64_t next = 1;
  return __atomic_fetch_add(&next, 1, __ATOMIC_RELAXED);
}

/// The first-order tesseral terms of one set, grouped into SIMD blocks and baked at a mean state (SPEC 16). The block
/// arrays live in one allocation (`mem`) sized for `cap_blks` blocks and `cap_rows` rows: a thread's own cache holds
/// kMaxBlks (a set's terms are grouped there), a set's cache from the pool (SetCaches) exactly its total_blks.
/// The bake points are cells of the mean state (sp_sync): the baked values are a function of the state's cells
/// alone, never of the states evaluated before.
struct SpEvalCache {
  static constexpr int kMaxBlks = 768;
  static constexpr int kMaxRows = 384;
  const SpCombCoef* F = nullptr;
  int count = 0, max_m = 0, max_aw = 0, total_blks = 0, n_rows = 0, n_res_blks = 0, n_pe_blks = 0;
  int b_fast_q0 = 0, b_fast_qm1 = 0, b_fast_qp1 = 0, b_c_q0 = 0, b_c_qm1 = 0, b_contig_end = 0;
  int seg_row_end[6]{};
  uint32_t table_tag = 0;
  float f0_uc = -1e30f, f0_ic = -1e30f, fn_uc = -1e30f;
  bool grouped_ok = false, res_overflow = false, uil_b_dirty = false;
  uint64_t group_id = 0;  ///< the grouping this cache holds (sp_rebuild_cache), kept by a set's copy of it (sp_compact_copy)
  double a0 = 0.0, e0 = 0.0, da_base = 0.0;
  double a = -1.0, e = -1.0, n = -1.0, ci = -10.0;
  double a_bake = -1.0, e_bake = -1.0, e_bake_a = -1.0, e_pe_bake = -1.0, de_pe_thresh = 5.0e-7;
  double a_res = -1.0, e_res = -1.0, ci_res = -10.0;
  // the cells the current bakes were made at (sp_sync): base (a, e^2, cos i), ae (a, e), pe (e), res (a, cos i, e^2)
  bool keys_valid = false;
  uint64_t anchor_id = 0;  ///< the bracket the bakes were made on (0: state cells)
  int64_t kb_a = 0, kb_e = 0, kb_c = 0, kae_a = 0, kae_e = 0, kpe = 0, kr_a = 0, kr_c = 0, kr_e = 0;
  /// keys made on a bracket: its first time and length and the parts of each level (sp_keys_hold; n_pe 0: no pe point
  /// in the keys); false: cell keys
  bool on_bracket = false;
  double kb_tlo = 0.0, kb_h = 0.0;
  int32_t n_base = 0, n_ae = 0, n_pe = 0, n_res = 0;
  alignas(16) float cswq_c[120]{};
  alignas(16) float cswq_s[120]{};
  int cap_blks = 0, cap_rows = 0;
  size_t mem_bytes = 0;
  uint8_t* mem = nullptr;
  float* blk_hot = nullptr;
  SpRow* rows = nullptr;
  uint16_t* res_blk = nullptr;
  uint16_t* pe_blk = nullptr;
  uint8_t* blk_is_pe = nullptr;
  uint8_t* blk_is_res = nullptr;
  uint8_t* blk_mlane = nullptr;
  uint8_t* blk_wq = nullptr;
  uint32_t* blk_active = nullptr;
  float* blk_mf = nullptr;
  float* blk_w = nullptr;
  float* blk_q = nullptr;
  float* blk_c = nullptr;     ///< the grouped coefficients; a compact cache borrows the matching thread grouping or rebuilds from F
  float* blk_p = nullptr;
  float* blk_a = nullptr;
  float* blk_e = nullptr;
  uint16_t* blk_term = nullptr;  ///< the term (index into F) of each lane
  bool compact = false;          ///< a set's cache: exactly its blocks, no blk_c
};

/// Lays the block arrays out in one zeroed 64-byte-aligned allocation for `blks` blocks and `rows` rows, with blk_c
/// when `with_c`. False out of memory (the cache keeps no storage).
inline bool sp_storage(SpEvalCache& sc, int blks, int rows, bool with_c) {
  auto up = [](size_t x) { return (x + 63u) & ~static_cast<size_t>(63u); };
  const size_t b = static_cast<size_t>(blks < 1 ? 1 : blks), r = static_cast<size_t>(rows < 1 ? 1 : rows);
  const size_t sizes[17] = {b * 32 * 4, r * sizeof(SpRow), b * 2, b * 2, b, b, b * 4, b * 4, b * 16, b * 16, b * 16,
                            b * 16, with_c ? b * 64 * 4 : 0, b * 32 * 4, b * 32 * 4, b * 16 * 4, b * 4 * 2};
  size_t off[17], total = 0;
  for (int k = 0; k < 17; ++k) { off[k] = total; total += up(sizes[k]); }
  uint8_t* m = static_cast<uint8_t*>(sdnap::mem::aligned_alloc(64, total));
  if (m == nullptr) return false;
  std::memset(m, 0, total);
  sc.mem = m;
  sc.mem_bytes = total;
  sc.cap_blks = static_cast<int>(b);
  sc.cap_rows = static_cast<int>(r);
  sc.blk_hot = reinterpret_cast<float*>(m + off[0]);
  sc.rows = reinterpret_cast<SpRow*>(m + off[1]);
  sc.res_blk = reinterpret_cast<uint16_t*>(m + off[2]);
  sc.pe_blk = reinterpret_cast<uint16_t*>(m + off[3]);
  sc.blk_is_pe = m + off[4];
  sc.blk_is_res = m + off[5];
  sc.blk_mlane = m + off[6];
  sc.blk_wq = m + off[7];
  sc.blk_active = reinterpret_cast<uint32_t*>(m + off[8]);
  sc.blk_mf = reinterpret_cast<float*>(m + off[9]);
  sc.blk_w = reinterpret_cast<float*>(m + off[10]);
  sc.blk_q = reinterpret_cast<float*>(m + off[11]);
  sc.blk_c = with_c ? reinterpret_cast<float*>(m + off[12]) : nullptr;
  sc.blk_p = reinterpret_cast<float*>(m + off[13]);
  sc.blk_a = reinterpret_cast<float*>(m + off[14]);
  sc.blk_e = reinterpret_cast<float*>(m + off[15]);
  sc.blk_term = reinterpret_cast<uint16_t*>(m + off[16]);
  sc.compact = !with_c;
  return true;
}

/// A set's cache: `src` (grouped and baked in a thread's cache) with storage for exactly its blocks and rows and
/// without blk_c. A bake borrows the matching thread grouping or rebuilds from F; a resonant-only rebuild
/// writes only resonant blocks into temporary storage. Returns nullptr out of memory.
inline SpEvalCache* sp_compact_copy(const SpEvalCache& src) {
  SpEvalCache* d = sdnap::mem::counted(new (std::nothrow) SpEvalCache(src));
  if (d == nullptr) return nullptr;
  if (!sp_storage(*d, src.total_blks, src.n_rows, false)) {
    delete d;
    return nullptr;
  }
  const size_t b = static_cast<size_t>(src.total_blks), r = static_cast<size_t>(src.n_rows);
  std::memcpy(d->blk_hot, src.blk_hot, b * 32 * sizeof(float));
  std::memcpy(d->rows, src.rows, r * sizeof(SpRow));
  std::memcpy(d->res_blk, src.res_blk, b * sizeof(uint16_t));
  std::memcpy(d->pe_blk, src.pe_blk, b * sizeof(uint16_t));
  std::memcpy(d->blk_is_pe, src.blk_is_pe, b);
  std::memcpy(d->blk_is_res, src.blk_is_res, b);
  std::memcpy(d->blk_mlane, src.blk_mlane, b * 4);
  std::memcpy(d->blk_wq, src.blk_wq, b * 4);
  std::memcpy(d->blk_active, src.blk_active, b * 4 * sizeof(uint32_t));
  std::memcpy(d->blk_mf, src.blk_mf, b * 4 * sizeof(float));
  std::memcpy(d->blk_w, src.blk_w, b * 4 * sizeof(float));
  std::memcpy(d->blk_q, src.blk_q, b * 4 * sizeof(float));
  std::memcpy(d->blk_p, src.blk_p, b * 32 * sizeof(float));
  std::memcpy(d->blk_a, src.blk_a, b * 32 * sizeof(float));
  std::memcpy(d->blk_e, src.blk_e, b * 16 * sizeof(float));
  std::memcpy(d->blk_term, src.blk_term, b * 4 * sizeof(uint16_t));
  return d;
}

inline thread_local float* g_sp_blk_c = nullptr;
/// The thread's blk_c storage (192 KiB), made ahead (pool::warm_thread: before the thread's first state or initialization,
/// and before any batch on a pool thread, stacks #487 and #600). False when it cannot be had (the failure counted). Through
/// 0.6.52 it was made at a set's first bake from its table again, a day or so into a flight, and aborted the module when
/// the memory was full by then (stack #600).
inline bool sp_blk_c_make() {
  if (g_sp_blk_c == nullptr)
    g_sp_blk_c = static_cast<float*>(sdnap::mem::aligned_alloc(64, static_cast<size_t>(SpEvalCache::kMaxBlks) * 64 * sizeof(float)));
  return g_sp_blk_c != nullptr;
}
inline float* sp_blk_c_storage() {
  if (__builtin_expect(!g_sp_blk_c, 0) && !sp_blk_c_make()) __builtin_trap();  // a thread warm_thread did not reach
  return g_sp_blk_c;
}
/// Rebuild block coefficients from F, zeroing empty vector positions. With `blocks`, write only those `count`
/// blocks; nullptr writes every block. A resonant-only bake leaves only its resonant blocks valid in this storage.
inline float* sp_blk_c(const SpEvalCache& sc, const uint16_t* blocks = nullptr, int count = 0) {
  float* const c = sp_blk_c_storage();
  const int n = blocks != nullptr ? count : sc.total_blks;
  for (int j = 0; j < n; ++j) {
    const int bi = blocks != nullptr ? static_cast<int>(blocks[j]) : j;
    for (int l = 0; l < 4; ++l) {
      float* const pc = c + bi * 64 + l;
      const int lane = bi * 4 + l;
      if (sc.blk_active[lane] == 0u) {
        for (int k = 0; k < 16; ++k) pc[4 * k] = 0.0f;
        continue;
      }
      const SpCombCoef& f = sc.F[sc.blk_term[lane]];
      pc[0] = f.uc0;   pc[4] = f.us0;   pc[8] = f.dc0;   pc[12] = f.ds0;
      pc[16] = f.dca;  pc[20] = f.dsa;  pc[24] = f.ec0;  pc[28] = f.es0;
      pc[32] = f.eca;  pc[36] = f.esa;  pc[40] = f.ic0;  pc[44] = f.is0;
      pc[48] = f.ica;  pc[52] = f.isa;  pc[56] = f.ice;  pc[60] = f.ise;
    }
  }
  return c;
}

inline void sp_cache_free(SpEvalCache* sc) {
  if (sc == nullptr) return;
  std::free(sc->mem);
  delete sc;
}

/// What grouping a set's terms needs and keeps nowhere else, per thread.
struct SpBuildScratch {
  uint16_t qw_slot[3][35][71]{};
  uint8_t qw_cnt[3][35]{};
  uint8_t fast_item[2600]{};
  uint16_t rem_items[2600]{};
};
inline thread_local SpBuildScratch* g_sp_build_scratch_ptr = nullptr;
/// Made by pool::warm_thread before the thread's first state or initialization (stack #600). False when it cannot be had.
inline bool sp_build_scratch_make() {
  if (g_sp_build_scratch_ptr == nullptr) g_sp_build_scratch_ptr = sdnap::mem::counted(new (std::nothrow) SpBuildScratch{});
  return g_sp_build_scratch_ptr != nullptr;
}
inline SpBuildScratch& sp_build_scratch() {
  if (__builtin_expect(!g_sp_build_scratch_ptr, 0) && !sp_build_scratch_make()) __builtin_trap();  // a thread warm_thread did not reach
  return *g_sp_build_scratch_ptr;
}

/// The trig of the multiples of the node's and the mean anomaly's angles for one state, per thread (the m-daily part
/// fills them, the tesseral part reads them).
struct SpTrigScratch {
  alignas(16) float cm[80]{};
  alignas(16) float sm[80]{};
};
inline thread_local SpTrigScratch g_sp_trig_scratch{};
inline float* sp_trig_cm() { return g_sp_trig_scratch.cm; }
inline float* sp_trig_sm() { return g_sp_trig_scratch.sm; }

/// The set being flown on this thread (its caches locked by xp_propagate's scope; nullptr: none): `cache` its own
/// tesseral cache, or nullptr while it holds none.
struct SpSetSlot {
  SpEvalCache* cache = nullptr;
};
inline thread_local SpSetSlot* g_sp_set_slot = nullptr;
/// The pool (xp_theory.inc): a set's own copy of `built` within the memory budget, or nullptr beyond it.
SpEvalCache* sp_pool_attach(const SpEvalCache& built);
/// The pool: a set's tesseral cache given back.
void sp_pool_release(SpEvalCache* cache);

/// A thread's own cache (kMaxBlks): where every set's terms are grouped, and the cache of the sets that hold none.
inline thread_local SpEvalCache* g_sp_eval_cache_ptr = nullptr;
/// Made by pool::warm_thread before the thread's first state or initialization (stack #600), with its storage. False when
/// either cannot be had (the failure counted; nothing kept).
inline bool sp_thread_cache_make() {
  if (g_sp_eval_cache_ptr != nullptr) return true;
  SpEvalCache* c = sdnap::mem::counted(new (std::nothrow) SpEvalCache{});
  if (c == nullptr) return false;
  if (!sp_storage(*c, SpEvalCache::kMaxBlks, SpEvalCache::kMaxRows, true)) {
    delete c;
    return false;
  }
  g_sp_eval_cache_ptr = c;
  return true;
}
inline SpEvalCache& sp_thread_cache() {
  if (__builtin_expect(!g_sp_eval_cache_ptr, 0) && !sp_thread_cache_make()) __builtin_trap();  // a thread warm_thread did not reach
  return *g_sp_eval_cache_ptr;
}

inline void sp_split16_f32(double x, float& hi, float& lo) {
  float f = static_cast<float>(x);
  uint32_t u = 0;
  std::memcpy(&u, &f, sizeof(u));
  u &= ~0xffu;
  std::memcpy(&hi, &u, sizeof(hi));
  lo = static_cast<float>(x - static_cast<double>(hi));
}

[[gnu::noinline]] inline void sp_rebuild_cache(SpEvalCache& sc, const SpCombCoef* F, int count, uint32_t tag,
                                               double a0, double e0, double ci) {
  sc.F = F;
  sc.count = count;
  sc.table_tag = tag;
  sc.a0 = a0;
  sc.e0 = e0;
  sc.f0_uc = F[0].uc0;
  sc.f0_ic = F[0].ic0;
  sc.fn_uc = F[count - 1].uc0;
  sc.a = -1.0;
  sc.keys_valid = false;
  sc.grouped_ok = false;
  sc.res_overflow = false;
  sc.n_res_blks = 0;
  sc.group_id = sp_next_group_id();
  if (count > 2600) return;
  int max_m = 0, max_aw = 0;
  bool ok = true;
  for (int idx = 0; idx < count; ++idx) {
    const SpCombCoef& f = F[idx];
    const int m = f.m, w = f.w, q = f.j - f.w;
    if (m < 1 || m > 70 || w < -17 || w > 17 || q < -1 || q > 1) { ok = false; break; }
    if (m > max_m) max_m = m;
    const int aw = w < 0 ? -w : w;
    if (aw > max_aw) max_aw = aw;
  }
  if (!ok || max_m < 1) return;
  const int m_stride = max_m + 1;
  SpBuildScratch& build = sp_build_scratch();
  auto& qw_slot = build.qw_slot;
  auto& qw_cnt = build.qw_cnt;
  for (int qi = 0; qi < 3; ++qi) {
    for (int w = -max_aw; w <= max_aw; ++w) {
      qw_cnt[qi][w + 17] = 0u;
      std::memset(qw_slot[qi][w + 17], 0xff, static_cast<size_t>(m_stride) * sizeof(uint16_t));
    }
  }
  for (int idx = 0; idx < count; ++idx) {
    const SpCombCoef& f = F[idx];
    const int m = f.m, w = f.w, q = f.j - f.w;
    const int qi = q == 0 ? 0 : (q < 0 ? 1 : 2);
    const int wi = w + 17;
    if (qw_slot[qi][wi][m] != 0xffffu) { ok = false; break; }
    qw_slot[qi][wi][m] = static_cast<uint16_t>(idx);
    ++qw_cnt[qi][wi];
  }
  if (!ok) return;
  uint8_t* const fast_item = build.fast_item;
  std::memset(fast_item, 0, static_cast<size_t>(count));
  {
    auto oct_norm = [](double x, double y) -> double {
      const double ax = std::fabs(x), ay = std::fabs(y);
      return ax > ay ? (ax + 0.41421356237309505 * ay) : (ay + 0.41421356237309505 * ax);
    };
    const double eta0_c = std::sqrt(std::fmax(1e-12, 1.0 - e0 * e0));
    const double n0_c = std::sqrt(kMu / (a0 * a0 * a0));
    const double p0_c = a0 * eta0_c * eta0_c, j2_0 = 1.5 * kJ2 / (p0_c * p0_c);
    const double nr0 = -j2_0 * n0_c * ci, wd0 = 0.5 * j2_0 * n0_c * (5.0 * ci * ci - 1.0);
    const double md0 = n0_c + 0.5 * j2_0 * n0_c * eta0_c * (3.0 * ci * ci - 1.0);
    const double bd0 = nr0 - kOmegaE;
    const double dwd0 = 3.5 * wd0, dnr0 = 3.5 * nr0, dmd0 = 1.5 * n0_c + 3.5 * (md0 - n0_c);
    const double na2_0 = n0_c * a0 * a0;
    const double alpha_A0 = -2.0 / na2_0, beta_L0 = 3.0 / (a0 * a0);
    constexpr double kPeTolEr = 8.0e-11;  // ~0.51 mm per oscillating term at de = 2.5e-5
    const double scale_I0 = a0 / (na2_0 * eta0_c);
    double max_pos_pe = 1.0e-12;
    for (int idx = 0; idx < count; ++idx) {
      const SpCombCoef& f = F[idx];
      const int m = f.m, w = f.w, j = f.j;
      const double psidot0 = w * wd0 + j * md0 + m * bd0;
      if (std::fabs(psidot0) < 1e-12) {
        max_pos_pe = 1.0e-6;
        continue;
      }
      const double ip0 = 1.0 / psidot0, abs_ip0 = std::fabs(ip0);
      const double abs_dpr0 = std::fabs((w * dwd0 + j * dmd0 + m * dnr0) * ip0);
      const double pos_pe_I = 2.5e-5 * scale_I0 * oct_norm(f.ice, f.ise) * abs_ip0;
      const double pos_pe_L = 2.5e-5 * a0 *
                              oct_norm(-alpha_A0 * f.eca - beta_L0 * j * (f.ec0 * ip0),
                                       -alpha_A0 * f.esa - beta_L0 * j * (f.es0 * ip0)) *
                              abs_ip0;
      const double pos_pe = pos_pe_I + pos_pe_L;
      const double eff_pe = (abs_ip0 >= 100.0 || abs_dpr0 >= 6.0) ? (3.0 * pos_pe) : pos_pe;
      if (eff_pe > max_pos_pe) max_pos_pe = eff_pe;
      if (abs_ip0 >= 200.0 || abs_dpr0 >= 12.0) continue;
      if (pos_pe < kPeTolEr) fast_item[idx] = 1u;
    }
    if (max_pos_pe >= 6.0e-9) {
      sc.de_pe_thresh = 1.5e-7;
    } else {
      const double raw_thresh = 5.0e-15 / max_pos_pe;
      sc.de_pe_thresh = raw_thresh < 6.0e-7 ? 6.0e-7 : (raw_thresh > 2.5e-5 ? 2.5e-5 : raw_thresh);
    }
  }
  int cur_blk = 0;
  auto alloc_blk = [&](uint8_t m0_val, uint8_t wq0_val, float wf_val, float qf_val, bool full4) -> int {
    if (cur_blk >= SpEvalCache::kMaxBlks) { ok = false; return -1; }
    const int bi = cur_blk++;
    (void)m0_val;
    (void)wq0_val;
    (void)wf_val;
    (void)qf_val;
    sc.blk_is_pe[bi] = 0u;
    if (!full4) {
      const int lo = bi * 4;
      for (int l = 0; l < 4; ++l) {
        sc.blk_mlane[lo + l] = 0u;
        sc.blk_wq[lo + l] = 20u;
        sc.blk_active[lo + l] = 0u;
        sc.blk_mf[lo + l] = 0.0f;
        sc.blk_w[lo + l] = 0.0f;
        sc.blk_q[lo + l] = 0.0f;
      }
      std::memset(sc.blk_c + static_cast<size_t>(bi) * 64u, 0, 64u * sizeof(float));
    }
    return bi;
  };
  sc.n_pe_blks = 0;
  auto store_lane = [&](int lane_idx, uint16_t it) {
    const SpCombCoef& f = F[it];
    const int m = f.m, w = f.w, q = f.j - w;
    const int qi_lane = q == 0 ? 0 : (q < 0 ? 1 : 2);
    sc.blk_mlane[lane_idx] = static_cast<uint8_t>(m - 1);
    sc.blk_wq[lane_idx] = static_cast<uint8_t>(qi_lane * 40 + (w + 20));
    sc.blk_term[lane_idx] = it;
    sc.blk_active[lane_idx] = 0xFFFFFFFFu;
    sc.blk_mf[lane_idx] = static_cast<float>(m);
    sc.blk_w[lane_idx] = static_cast<float>(w);
    sc.blk_q[lane_idx] = static_cast<float>(q);
    float* const pc = sc.blk_c + static_cast<uint32_t>(lane_idx >> 2) * 64u + (lane_idx & 3);
    pc[0] = f.uc0;   pc[4] = f.us0;   pc[8] = f.dc0;   pc[12] = f.ds0;
    pc[16] = f.dca;  pc[20] = f.dsa;  pc[24] = f.ec0;  pc[28] = f.es0;
    pc[32] = f.eca;  pc[36] = f.esa;  pc[40] = f.ic0;  pc[44] = f.is0;
    pc[48] = f.ica;  pc[52] = f.isa;  pc[56] = f.ice;  pc[60] = f.ise;
  };
  const int q_vals[3] = {0, -1, 1};
  const int n_chunks = (max_m + 3) >> 2;
  int c_ends[3] = {0, 0, 0};
  int cur_row = 0;
  for (int qi = 0; qi < 3 && ok; ++qi) {
    const int q = q_vals[qi];
    const float qf = static_cast<float>(q);
    for (int w = -max_aw; w <= max_aw && ok; ++w) {
      const int wi = w + 17;
      if (qw_cnt[qi][wi] < 2) continue;
      uint16_t* slot = qw_slot[qi][wi];
      const uint8_t wq0 = static_cast<uint8_t>(qi * 40 + (w + 20));
      const float wf = static_cast<float>(w);
      int open_row = -1;
      for (int c = 0; c < n_chunks && ok; ++c) {
        const int m0 = c << 2;
        int win_c = 0;
        for (int l = 0; l < 4; ++l) {
          const int mk = m0 + 1 + l;
          if (mk <= max_m && slot[mk] != 0xffffu) ++win_c;
        }
        bool take = (win_c >= 2);
        if (!take && win_c == 1 && open_row >= 0 && (c + 1) < n_chunks) {
          int next_c = 0;
          const int nm0 = (c + 1) << 2;
          for (int l = 0; l < 4; ++l) {
            const int mk = nm0 + 1 + l;
            if (mk <= max_m && slot[mk] != 0xffffu) ++next_c;
          }
          if (next_c >= 2) take = true;
        }
        if (take) {
          if (open_row < 0) {
            if (cur_row >= SpEvalCache::kMaxRows) { ok = false; break; }
            open_row = cur_row++;
            sc.rows[open_row].wq0 = wq0;
            sc.rows[open_row].c_start = static_cast<uint8_t>(c);
            sc.rows[open_row].wf = wf;
            sc.rows[open_row].qf = qf;
            sc.rows[open_row].jf = wf + qf;
          }
          const int bi = alloc_blk(static_cast<uint8_t>(m0), wq0, wf, qf, win_c == 4);
          if (bi < 0) break;
          bool blk_has_pe = false;
          for (int l = 0; l < 4; ++l) {
            const int mk = m0 + 1 + l;
            if (mk <= max_m && slot[mk] != 0xffffu) {
              const uint16_t it = slot[mk];
              if (fast_item[it] == 0u) blk_has_pe = true;
              store_lane(bi * 4 + l, it);
              slot[mk] = 0xffffu;
              --qw_cnt[qi][wi];
            }
          }
          if (blk_has_pe) {
            sc.pe_blk[sc.n_pe_blks++] = static_cast<uint16_t>(bi);
            sc.blk_is_pe[bi] = 1u;
          }
          sc.rows[open_row].blk_end = static_cast<uint16_t>(cur_blk);
        } else {
          open_row = -1;
        }
      }
    }
    c_ends[qi] = cur_blk;
  }
  const int b_contig_end = cur_blk;
  // Segment D: pack all remaining items densely 4 per block
  uint16_t* const rem_items = build.rem_items;
  int n_rem = 0;
  for (int qi = 0; qi < 3; ++qi) {
    for (int w = -max_aw; w <= max_aw; ++w) {
      const int wi = w + 17;
      if (qw_cnt[qi][wi] == 0) continue;
      const uint16_t* slot = qw_slot[qi][wi];
      for (int m = 1; m <= max_m; ++m) {
        if (slot[m] != 0xffffu) rem_items[n_rem++] = slot[m];
      }
    }
  }
  for (int r = 0; r < n_rem && ok; r += 4) {
    const int lim = (r + 4 <= n_rem) ? 4 : (n_rem - r);
    const int bi = alloc_blk(0xffu, 20u, 0.0f, 0.0f, lim == 4);
    if (bi < 0) break;
    bool blk_has_pe = false;
    for (int l = 0; l < lim; ++l) {
      const uint16_t it = rem_items[r + l];
      if (fast_item[it] == 0u) blk_has_pe = true;
      store_lane(bi * 4 + l, it);
    }
    if (blk_has_pe) {
      sc.pe_blk[sc.n_pe_blks++] = static_cast<uint16_t>(bi);
      sc.blk_is_pe[bi] = 1u;
    }
  }
  if (ok && cur_blk > 0) {
    sc.max_m = max_m;
    sc.max_aw = max_aw;
    sc.n_rows = cur_row;
    sc.b_fast_q0 = 0;
    sc.b_fast_qm1 = 0;
    sc.b_fast_qp1 = 0;
    sc.b_c_q0 = c_ends[0];
    sc.b_c_qm1 = c_ends[1];
    sc.b_contig_end = b_contig_end;
    sc.total_blks = cur_blk;
    sc.a_bake = -1.0;
    sc.e_bake = -1.0;
    sc.e_bake_a = -1.0;
    sc.e_pe_bake = -1.0;
    sc.a_res = -1.0;
    sc.keys_valid = false;
    sc.grouped_ok = true;
  }
}

[[gnu::noinline]] inline void sp_rebake_pe_fast(SpEvalCache& sc, double e_target) {
  const float dde_pe = static_cast<float>(e_target - sc.e_pe_bake);
  sc.e_pe_bake = e_target;
  const int np = sc.n_pe_blks;
#ifdef __wasm_simd128__
  const v128_t v_dde = wasm_f32x4_splat(dde_pe);
  for (int rk = 0; rk < np; ++rk) {
    const int bi = sc.pe_blk[rk];
    float* const pu = sc.blk_hot + bi * 32 + 8;
    const float* const pe = sc.blk_e + bi * 16;
    wasm_v128_store(pu + 8,  wasm_f32x4_add(wasm_v128_load(pu + 8),  wasm_f32x4_mul(wasm_v128_load(pe + 0),  v_dde)));
    wasm_v128_store(pu + 12, wasm_f32x4_add(wasm_v128_load(pu + 12), wasm_f32x4_mul(wasm_v128_load(pe + 4),  v_dde)));
    wasm_v128_store(pu + 16, wasm_f32x4_add(wasm_v128_load(pu + 16), wasm_f32x4_mul(wasm_v128_load(pe + 8),  v_dde)));
    wasm_v128_store(pu + 20, wasm_f32x4_add(wasm_v128_load(pu + 20), wasm_f32x4_mul(wasm_v128_load(pe + 12), v_dde)));
  }
#else
  for (int rk = 0; rk < np; ++rk) {
    const int bi = sc.pe_blk[rk];
    float* const pu = sc.blk_hot + bi * 32 + 8;
    const float* const pe = sc.blk_e + bi * 16;
    for (int l = 0; l < 16; ++l) pu[8 + l] += pe[l] * dde_pe;
  }
#endif
}

[[gnu::noinline]] inline void sp_rebake_base(SpEvalCache& sc, double a0, double e0, double a, double e,
                                             double n, double eta, double ci, double ia) {
  sc.a0 = a0;
  sc.e0 = e0;
  sc.a = a;
  sc.e = e;
  sc.n = n;
  sc.ci = ci;
  sc.n_res_blks = 0;
  sc.res_overflow = false;
  sc.uil_b_dirty = false;
  std::memset(sc.blk_is_res, 0, static_cast<size_t>(sc.total_blks));
  const double p_sl = a * eta * eta, j2 = 1.5 * kJ2 / (p_sl * p_sl);
  const double node_rate = -j2 * n * ci, wdot = 0.5 * j2 * n * (5.0 * ci * ci - 1.0);
  const double mdot = n + 0.5 * j2 * n * eta * (3.0 * ci * ci - 1.0);
  const double beta_dot = node_rate - kOmegaE;
  const double da = a0 * ia - 1.0;
  sc.da_base = da;
  const double inv_1pda = 1.0 / (1.0 + da);
  const double dwdot_ddda = 3.5 * wdot * inv_1pda;
  const double dnoder_ddda = 3.5 * node_rate * inv_1pda;
  const double dmdot_ddda = (1.5 * n + 3.5 * (mdot - n)) * inv_1pda;
  const double de = e - e0;
  const double alpha_A = -2.0 * ia / (n * a);
  const double dalpha_ddda = 0.5 * alpha_A * inv_1pda;
  const double beta_L = 3.0 * ia * ia;
  const double dbeta_ddda = 2.0 * beta_L * inv_1pda;
#ifdef __wasm_simd128__
  float mdot_hi = 0.0f, mdot_lo = 0.0f, bdot_hi = 0.0f, bdot_lo = 0.0f;
  sp_split16_f32(mdot, mdot_hi, mdot_lo);
  sp_split16_f32(beta_dot, bdot_hi, bdot_lo);
  const v128_t v_one_f = wasm_f32x4_splat(1.0f);
  const v128_t v_res_dpr = wasm_f32x4_splat(6.0f);
  const v128_t v_res_ip = wasm_f32x4_splat(250.0f);
  const v128_t v_wdot_f = wasm_f32x4_splat(static_cast<float>(wdot));
  const v128_t v_mdot_hi = wasm_f32x4_splat(mdot_hi);
  const v128_t v_mdot_lo = wasm_f32x4_splat(mdot_lo);
  const v128_t v_bdot_hi = wasm_f32x4_splat(bdot_hi);
  const v128_t v_bdot_lo = wasm_f32x4_splat(bdot_lo);
  const v128_t v_dwdot_f = wasm_f32x4_splat(static_cast<float>(dwdot_ddda));
  const v128_t v_dmdot_f = wasm_f32x4_splat(static_cast<float>(dmdot_ddda));
  const v128_t v_dnoder_f = wasm_f32x4_splat(static_cast<float>(dnoder_ddda));
  const v128_t v_da = wasm_f32x4_splat(static_cast<float>(da));
  const v128_t v_hda = wasm_f32x4_splat(static_cast<float>(0.5 * da));
  const v128_t v_de_r = wasm_f32x4_splat(static_cast<float>(de));
  const v128_t v_alpha = wasm_f32x4_splat(static_cast<float>(alpha_A));
  const v128_t v_nalpha = wasm_f32x4_splat(static_cast<float>(-alpha_A));
  const v128_t v_dalpha = wasm_f32x4_splat(static_cast<float>(dalpha_ddda));
  const v128_t v_beta_L = wasm_f32x4_splat(static_cast<float>(beta_L));
  const v128_t v_dbeta_L = wasm_f32x4_splat(static_cast<float>(dbeta_ddda));
  const int nblks = sc.total_blks;
  for (int bi = 0; bi < nblks; ++bi) {
    const int lane_off = bi * 4;
    const v128_t v_active = wasm_v128_load(sc.blk_active + lane_off);
    const v128_t v_mf = wasm_v128_load(sc.blk_mf + lane_off);
    const v128_t v_wf = wasm_v128_load(sc.blk_w + lane_off);
    const v128_t v_jf = wasm_f32x4_add(v_wf, wasm_v128_load(sc.blk_q + lane_off));
    const v128_t v_psidot = wasm_f32x4_add(
        wasm_f32x4_add(wasm_f32x4_mul(v_jf, v_mdot_hi), wasm_f32x4_mul(v_mf, v_bdot_hi)),
        wasm_f32x4_add(wasm_f32x4_add(wasm_f32x4_mul(v_jf, v_mdot_lo), wasm_f32x4_mul(v_mf, v_bdot_lo)),
                       wasm_f32x4_mul(v_wf, v_wdot_f)));
    const v128_t v_ip = wasm_v128_and(wasm_f32x4_div(v_one_f, v_psidot), v_active);
    const v128_t v_dpr = wasm_f32x4_mul(
        wasm_f32x4_add(wasm_f32x4_add(wasm_f32x4_mul(v_wf, v_dwdot_f), wasm_f32x4_mul(v_jf, v_dmdot_f)),
                       wasm_f32x4_mul(v_mf, v_dnoder_f)),
        v_ip);
    const v128_t v_bj = wasm_f32x4_mul(v_beta_L, v_jf);
    const v128_t v_dbj = wasm_f32x4_mul(v_dbeta_L, v_jf);
    if (wasm_v128_any_true(wasm_v128_or(wasm_f32x4_gt(wasm_f32x4_abs(v_dpr), v_res_dpr),
                                        wasm_f32x4_gt(wasm_f32x4_abs(v_ip), v_res_ip)))) {
      sc.res_blk[sc.n_res_blks++] = static_cast<uint16_t>(bi);
      sc.blk_is_res[bi] = 1u;
    }
    const float* const pc = sc.blk_c + bi * 64;
    float* const pp = sc.blk_p + bi * 32;
    float* const pec = sc.blk_hot + bi * 32;
    float* const pu = pec + 8;
    float* const pa = sc.blk_a + bi * 32;
    float* const pe = sc.blk_e + bi * 16;
    const v128_t uc0 = wasm_v128_load(pc + 0), us0 = wasm_v128_load(pc + 4);
    const v128_t dc0 = wasm_v128_load(pc + 8), ds0 = wasm_v128_load(pc + 12);
    const v128_t dca = wasm_v128_load(pc + 16), dsa = wasm_v128_load(pc + 20);
    const v128_t ec0 = wasm_v128_load(pc + 24), es0 = wasm_v128_load(pc + 28);
    const v128_t eca = wasm_v128_load(pc + 32), esa = wasm_v128_load(pc + 36);
    const v128_t ic0 = wasm_v128_load(pc + 40), is0 = wasm_v128_load(pc + 44);
    const v128_t ica = wasm_v128_load(pc + 48), isa = wasm_v128_load(pc + 52);
    const v128_t ice = wasm_v128_load(pc + 56), ise = wasm_v128_load(pc + 60);

    const v128_t ec = wasm_f32x4_add(ec0, wasm_f32x4_mul(eca, v_da));
    const v128_t es = wasm_f32x4_add(es0, wasm_f32x4_mul(esa, v_da));
    const v128_t uc = wasm_f32x4_add(wasm_f32x4_sub(uc0, wasm_f32x4_mul(wasm_f32x4_add(dc0, wasm_f32x4_mul(dca, v_hda)), v_da)),
                                     wasm_f32x4_mul(ec, v_de_r));
    const v128_t us = wasm_f32x4_add(wasm_f32x4_sub(us0, wasm_f32x4_mul(wasm_f32x4_add(ds0, wasm_f32x4_mul(dsa, v_hda)), v_da)),
                                     wasm_f32x4_mul(es, v_de_r));
    const v128_t ic = wasm_f32x4_add(wasm_f32x4_add(ic0, wasm_f32x4_mul(ica, v_da)), wasm_f32x4_mul(ice, v_de_r));
    const v128_t is = wasm_f32x4_add(wasm_f32x4_add(is0, wasm_f32x4_mul(isa, v_da)), wasm_f32x4_mul(ise, v_de_r));
    const v128_t duc_dda = wasm_f32x4_sub(wasm_f32x4_mul(eca, v_de_r), wasm_f32x4_add(dc0, wasm_f32x4_mul(dca, v_da)));
    const v128_t dus_dda = wasm_f32x4_sub(wasm_f32x4_mul(esa, v_de_r), wasm_f32x4_add(ds0, wasm_f32x4_mul(dsa, v_da)));
    const v128_t dc = wasm_f32x4_sub(wasm_f32x4_mul(dc0, v_da), duc_dda);
    const v128_t ds = wasm_f32x4_sub(wasm_f32x4_mul(ds0, v_da), dus_dda);

    const v128_t ec_ip = wasm_f32x4_mul(ec, v_ip), es_ip = wasm_f32x4_mul(es, v_ip);
    const v128_t uc_ip = wasm_f32x4_mul(uc, v_ip), us_ip = wasm_f32x4_mul(us, v_ip);
    const v128_t ic_ip = wasm_f32x4_mul(ic, v_ip), is_ip = wasm_f32x4_mul(is, v_ip);
    const v128_t dc_ip = wasm_f32x4_mul(dc, v_ip), ds_ip = wasm_f32x4_mul(ds, v_ip);
    const v128_t uc_ip2 = wasm_f32x4_mul(uc_ip, v_ip), us_ip2 = wasm_f32x4_mul(us_ip, v_ip);
    const v128_t lc_ip = wasm_f32x4_sub(wasm_f32x4_mul(v_alpha, dc_ip), wasm_f32x4_mul(v_bj, uc_ip2));
    const v128_t ls_ip = wasm_f32x4_sub(wasm_f32x4_mul(v_alpha, ds_ip), wasm_f32x4_mul(v_bj, us_ip2));

    wasm_v128_store(pp + 0, ec_ip);  wasm_v128_store(pec + 0, ec_ip);
    wasm_v128_store(pp + 4, es_ip);  wasm_v128_store(pec + 4, es_ip);
    wasm_v128_store(pp + 8, uc_ip);  wasm_v128_store(pu + 0, uc_ip);
    wasm_v128_store(pp + 12, us_ip); wasm_v128_store(pu + 4, us_ip);
    wasm_v128_store(pp + 16, ic_ip); wasm_v128_store(pu + 8, ic_ip);
    wasm_v128_store(pp + 20, is_ip); wasm_v128_store(pu + 12, is_ip);
    wasm_v128_store(pp + 24, lc_ip); wasm_v128_store(pu + 16, lc_ip);
    wasm_v128_store(pp + 28, ls_ip); wasm_v128_store(pu + 20, ls_ip);

    const v128_t duc_ip = wasm_f32x4_sub(wasm_f32x4_mul(duc_dda, v_ip), wasm_f32x4_mul(uc_ip, v_dpr));
    const v128_t dus_ip = wasm_f32x4_sub(wasm_f32x4_mul(dus_dda, v_ip), wasm_f32x4_mul(us_ip, v_dpr));
    const v128_t ddc_ip = wasm_f32x4_sub(wasm_f32x4_mul(wasm_f32x4_add(dc0, dca), v_ip), wasm_f32x4_mul(dc_ip, v_dpr));
    const v128_t dds_ip = wasm_f32x4_sub(wasm_f32x4_mul(wasm_f32x4_add(ds0, dsa), v_ip), wasm_f32x4_mul(ds_ip, v_dpr));
    wasm_v128_store(pa + 0, wasm_f32x4_sub(wasm_f32x4_mul(eca, v_ip), wasm_f32x4_mul(ec_ip, v_dpr)));
    wasm_v128_store(pa + 4, wasm_f32x4_sub(wasm_f32x4_mul(esa, v_ip), wasm_f32x4_mul(es_ip, v_dpr)));
    wasm_v128_store(pa + 8, duc_ip);
    wasm_v128_store(pa + 12, dus_ip);
    wasm_v128_store(pa + 16, wasm_f32x4_sub(wasm_f32x4_mul(ica, v_ip), wasm_f32x4_mul(ic_ip, v_dpr)));
    wasm_v128_store(pa + 20, wasm_f32x4_sub(wasm_f32x4_mul(isa, v_ip), wasm_f32x4_mul(is_ip, v_dpr)));
    wasm_v128_store(pa + 24, wasm_f32x4_sub(wasm_f32x4_sub(wasm_f32x4_add(wasm_f32x4_mul(v_dalpha, dc_ip), wasm_f32x4_mul(v_alpha, ddc_ip)),
                                                           wasm_f32x4_mul(v_dbj, uc_ip2)),
                                            wasm_f32x4_mul(v_bj, wasm_f32x4_mul(wasm_f32x4_sub(duc_ip, wasm_f32x4_mul(uc_ip, v_dpr)), v_ip))));
    wasm_v128_store(pa + 28, wasm_f32x4_sub(wasm_f32x4_sub(wasm_f32x4_add(wasm_f32x4_mul(v_dalpha, ds_ip), wasm_f32x4_mul(v_alpha, dds_ip)),
                                                           wasm_f32x4_mul(v_dbj, us_ip2)),
                                            wasm_f32x4_mul(v_bj, wasm_f32x4_mul(wasm_f32x4_sub(dus_ip, wasm_f32x4_mul(us_ip, v_dpr)), v_ip))));

    wasm_v128_store(pe + 0, wasm_f32x4_mul(ice, v_ip));
    wasm_v128_store(pe + 4, wasm_f32x4_mul(ise, v_ip));
    wasm_v128_store(pe + 8, wasm_f32x4_mul(wasm_f32x4_sub(wasm_f32x4_mul(v_nalpha, eca), wasm_f32x4_mul(v_bj, ec_ip)), v_ip));
    wasm_v128_store(pe + 12, wasm_f32x4_mul(wasm_f32x4_sub(wasm_f32x4_mul(v_nalpha, esa), wasm_f32x4_mul(v_bj, es_ip)), v_ip));
  }
#else
  for (int bi = 0; bi < sc.total_blks; ++bi) {
    const int lane_off = bi * 4;
    const float* const pc = sc.blk_c + bi * 64;
    float* const pp = sc.blk_p + bi * 32;
    float* const pec = sc.blk_hot + bi * 32;
    float* const pu = pec + 8;
    float* const pa = sc.blk_a + bi * 32;
    float* const pe = sc.blk_e + bi * 16;
    bool is_res = false;
    for (int l = 0; l < 4; ++l) {
      if (sc.blk_active[lane_off + l] == 0u) {
        pec[0 + l] = pec[4 + l] = 0.0f;
        for (int k = 0; k < 6; ++k) pu[k * 4 + l] = 0.0f;
        for (int k = 0; k < 8; ++k) pp[k * 4 + l] = pa[k * 4 + l] = 0.0f;
        for (int k = 0; k < 4; ++k) pe[k * 4 + l] = 0.0f;
        continue;
      }
      const double mv = sc.blk_mf[lane_off + l];
      const double wv = sc.blk_w[lane_off + l], j = wv + sc.blk_q[lane_off + l];
      const double inv_psidot = 1.0 / (wv * wdot + j * mdot + mv * beta_dot);
      const double inv_psidot2 = inv_psidot * inv_psidot;
      const double dpsidot_rel = (wv * dwdot_ddda + j * dmdot_ddda + mv * dnoder_ddda) * inv_psidot;
      if (std::fabs(dpsidot_rel) > 6.0 || std::fabs(inv_psidot) > 250.0) is_res = true;
      const double uc0 = pc[0 + l], us0 = pc[4 + l], dc0 = pc[8 + l], ds0 = pc[12 + l];
      const double dca = pc[16 + l], dsa = pc[20 + l], ec0 = pc[24 + l], es0 = pc[28 + l];
      const double eca = pc[32 + l], esa = pc[36 + l], ic0 = pc[40 + l], is0 = pc[44 + l];
      const double ica = pc[48 + l], isa = pc[52 + l], ice = pc[56 + l], ise = pc[60 + l];
      const double ec = ec0 + eca * da, es = es0 + esa * da;
      const double uc = uc0 + (-dc0 - 0.5 * dca * da) * da + ec * de;
      const double us = us0 + (-ds0 - 0.5 * dsa * da) * da + es * de;
      const double ic = ic0 + ica * da + ice * de, is = is0 + isa * da + ise * de;
      const double dc = dc0 + (dc0 + dca) * da - eca * de, ds = ds0 + (ds0 + dsa) * da - esa * de;
      const double ec_ip = ec * inv_psidot, es_ip = es * inv_psidot;
      const double uc_ip = uc * inv_psidot, us_ip = us * inv_psidot;
      const double ic_ip = ic * inv_psidot, is_ip = is * inv_psidot;
      const double dc_ip = dc * inv_psidot, ds_ip = ds * inv_psidot;
      const double duc_dda = -dc0 - dca * da + eca * de, dus_dda = -ds0 - dsa * da + esa * de;
      const double duc_ip = duc_dda * inv_psidot - uc_ip * dpsidot_rel;
      const double dus_ip = dus_dda * inv_psidot - us_ip * dpsidot_rel;
      const double ddc_ip = (dc0 + dca) * inv_psidot - dc_ip * dpsidot_rel;
      const double dds_ip = (ds0 + dsa) * inv_psidot - ds_ip * dpsidot_rel;
      const double j_uc_ip2 = j * uc * inv_psidot2, j_us_ip2 = j * us * inv_psidot2;
      const double dj_uc_ip2 = j * (duc_dda * inv_psidot - 2.0 * uc_ip * dpsidot_rel) * inv_psidot;
      const double dj_us_ip2 = j * (dus_dda * inv_psidot - 2.0 * us_ip * dpsidot_rel) * inv_psidot;
      pec[0 + l] = pp[0 + l] = static_cast<float>(ec_ip);
      pec[4 + l] = pp[4 + l] = static_cast<float>(es_ip);
      pu[0 + l] = pp[8 + l] = static_cast<float>(uc_ip);
      pu[4 + l] = pp[12 + l] = static_cast<float>(us_ip);
      pu[8 + l] = pp[16 + l] = static_cast<float>(ic_ip);
      pu[12 + l] = pp[20 + l] = static_cast<float>(is_ip);
      pu[16 + l] = pp[24 + l] = static_cast<float>(alpha_A * dc_ip - beta_L * j_uc_ip2);
      pu[20 + l] = pp[28 + l] = static_cast<float>(alpha_A * ds_ip - beta_L * j_us_ip2);
      pa[0 + l] = static_cast<float>(eca * inv_psidot - ec_ip * dpsidot_rel);
      pa[4 + l] = static_cast<float>(esa * inv_psidot - es_ip * dpsidot_rel);
      pa[8 + l] = static_cast<float>(duc_ip);
      pa[12 + l] = static_cast<float>(dus_ip);
      pa[16 + l] = static_cast<float>(ica * inv_psidot - ic_ip * dpsidot_rel);
      pa[20 + l] = static_cast<float>(isa * inv_psidot - is_ip * dpsidot_rel);
      pa[24 + l] = static_cast<float>(dalpha_ddda * dc_ip + alpha_A * ddc_ip - dbeta_ddda * j_uc_ip2 - beta_L * dj_uc_ip2);
      pa[28 + l] = static_cast<float>(dalpha_ddda * ds_ip + alpha_A * dds_ip - dbeta_ddda * j_us_ip2 - beta_L * dj_us_ip2);
      pe[0 + l] = static_cast<float>(ice * inv_psidot);
      pe[4 + l] = static_cast<float>(ise * inv_psidot);
      pe[8 + l] = static_cast<float>((-alpha_A * eca - beta_L * j * ec_ip) * inv_psidot);
      pe[12 + l] = static_cast<float>((-alpha_A * esa - beta_L * j * es_ip) * inv_psidot);
    }
    if (is_res) {
      sc.res_blk[sc.n_res_blks++] = static_cast<uint16_t>(bi);
      sc.blk_is_res[bi] = 1u;
    }
  }
#endif
  sc.a_bake = a;
  sc.e_bake = e;
  sc.e_bake_a = e;
  sc.e_pe_bake = e;
  sc.a_res = a;
  sc.e_res = e;
  sc.ci_res = ci;
}

[[gnu::noinline]] inline void sp_six_fallback(const SpEvalCache& sc, const SpCombCoef* F, int count, double a0, double e0,
                                              double a, double e, double n, double eta, double sin_i, double ci,
                                              double ia, double sb, double cb, double su1, double cu1,
                                              double sM1, double cM1, double* six, double* dsix_dlam, double* d2six_dlam2) {
  const double p_sl = a * eta * eta, j2 = 1.5 * kJ2 / (p_sl * p_sl);
  const double node_rate = -j2 * n * ci, wdot = 0.5 * j2 * n * (5.0 * ci * ci - 1.0);
  const double mdot = n + 0.5 * j2 * n * eta * (3.0 * ci * ci - 1.0);
  const double beta_dot = node_rate - kOmegaE;
  const double da = a0 * ia - 1.0, de = e - e0;
  const double alpha_A = -2.0 * ia / (n * a), beta_L = 3.0 * ia * ia;
  double cm[72], sm[72], cu_buf[35], su_buf[35];
  double* const cu = cu_buf + 17;
  double* const su = su_buf + 17;
  cm[0] = cu[0] = 1.0;
  sm[0] = su[0] = 0.0;
  const int fb_max_aw = sc.grouped_ok ? sc.max_aw : 17;
  const int fb_max_m = sc.grouped_ok ? sc.max_m : 70;
  for (int q = 1; q <= fb_max_aw; ++q) {
    cu[q] = cu[q - 1] * cu1 - su[q - 1] * su1;
    su[q] = su[q - 1] * cu1 + cu[q - 1] * su1;
    cu[-q] = cu[q];
    su[-q] = -su[q];
  }
  for (int q = 1; q <= fb_max_m; ++q) {
    cm[q] = cm[q - 1] * cb - sm[q - 1] * sb;
    sm[q] = sm[q - 1] * cb + cm[q - 1] * sb;
  }
  double sM = 0, sW = 0, sO = 0, sE = 0, sI = 0, sL = 0;
  double dsM = 0, dsW = 0, dsO = 0, dsE = 0, dsI = 0, dsL = 0;
  double d2sM = 0, d2sW = 0, d2sO = 0, d2sE = 0, d2sI = 0, d2sL = 0;
  for (int idx = 0; idx < count; ++idx) {
    const SpCombCoef& f = F[idx];
    const int m = f.m, w = f.w, j = f.j, qv = j - w;
    const double c0 = cu[w], s0 = su[w];
    const double cwjq = qv == 0 ? c0 : (qv > 0 ? c0 * cM1 - s0 * sM1 : c0 * cM1 + s0 * sM1);
    const double swjq = qv == 0 ? s0 : (qv > 0 ? s0 * cM1 + c0 * sM1 : s0 * cM1 - c0 * sM1);
    const double cp = cwjq * cm[m] - swjq * sm[m], sp = swjq * cm[m] + cwjq * sm[m];
    const double inv_p = 1.0 / (w * wdot + m * beta_dot + j * mdot);
    const double uc = (f.uc0 + (-f.dc0 - 0.5 * f.dca * da) * da + (f.ec0 + f.eca * da) * de) * inv_p;
    const double us = (f.us0 + (-f.ds0 - 0.5 * f.dsa * da) * da + (f.es0 + f.esa * da) * de) * inv_p;
    const double ec = (f.ec0 + f.eca * da) * inv_p, es = (f.es0 + f.esa * da) * inv_p;
    const double ic = (f.ic0 + f.ica * da + f.ice * de) * inv_p, is = (f.is0 + f.isa * da + f.ise * de) * inv_p;
    const double dc = f.dc0 + (f.dc0 + f.dca) * da - f.eca * de, ds = f.ds0 + (f.ds0 + f.dsa) * da - f.esa * de;
    const double lc = alpha_A * (dc * inv_p) - beta_L * (j * uc * inv_p), ls = alpha_A * (ds * inv_p) - beta_L * (j * us * inv_p);
    const double idS = uc * cp + us * sp, tE = ec * sp - es * cp, tI = ic * sp - is * cp, tL = lc * sp - ls * cp;
    sM += j * idS; sW += w * idS; sO += m * idS; sE += tE; sI += tI; sL += tL;
    if (dsix_dlam != nullptr) {
      const double didS = j * (-uc * sp + us * cp);
      dsM += j * didS; dsW += w * didS; dsO += m * didS;
      dsE += j * (ec * cp + es * sp); dsI += j * (ic * cp + is * sp); dsL += j * (lc * cp + ls * sp);
      if (d2six_dlam2 != nullptr) {
        const double nj2 = -(double)(j * j);
        d2sM += nj2 * j * idS; d2sW += nj2 * w * idS; d2sO += nj2 * m * idS;
        d2sE += nj2 * tE; d2sI += nj2 * tI; d2sL += nj2 * tL;
      }
    }
  }
  const double na2 = n * a * a, tanhalf = sin_i / (1.0 + ci);
  six[0] += -3.0 * ia * ia * sM;
  six[1] += (eta * eta * sM - eta * sW) / (na2 * e);
  six[2] += (ci * sW - sO) / (na2 * eta * sin_i);
  six[3] += (eta / na2) * sE + e * tanhalf / (na2 * eta) * sI;
  six[4] += sI / (na2 * eta);
  six[5] += sL + (eta * e / (na2 * (1.0 + eta))) * sE + (tanhalf / (na2 * eta)) * sI;
  if (dsix_dlam != nullptr) {
    dsix_dlam[0] += -3.0 * ia * ia * dsM;
    dsix_dlam[1] += (eta * eta * dsM - eta * dsW) / (na2 * e);
    dsix_dlam[2] += (ci * dsW - dsO) / (na2 * eta * sin_i);
    dsix_dlam[3] += (eta / na2) * dsE + e * tanhalf / (na2 * eta) * dsI;
    dsix_dlam[4] += dsI / (na2 * eta);
    dsix_dlam[5] += dsL + (eta * e / (na2 * (1.0 + eta))) * dsE + (tanhalf / (na2 * eta)) * dsI;
    if (d2six_dlam2 != nullptr) {
      d2six_dlam2[0] += -3.0 * ia * ia * d2sM;
      d2six_dlam2[1] += (eta * eta * d2sM - eta * d2sW) / (na2 * e);
      d2six_dlam2[2] += (ci * d2sW - d2sO) / (na2 * eta * sin_i);
      d2six_dlam2[3] += (eta / na2) * d2sE + e * tanhalf / (na2 * eta) * d2sI;
      d2six_dlam2[4] += d2sI / (na2 * eta);
      d2six_dlam2[5] += d2sL + (eta * e / (na2 * (1.0 + eta))) * d2sE + (tanhalf / (na2 * eta)) * d2sI;
    }
  }
}

[[gnu::noinline]] inline void sp_rebake_ae(SpEvalCache& sc, double a0, double a, double e, double ia,
                                           bool need_b_uil = false) {
  sc.a_bake = a;
  sc.e_bake = e;
  sc.e_bake_a = e;
  sc.e_pe_bake = e;
  sc.a_res = -1.0;
  const float dda_f32 = static_cast<float>((a0 * ia - 1.0) - sc.da_base);
  const float dde_f32 = static_cast<float>(e - sc.e);
  const int nblks = sc.total_blks;
  const int b_q0 = need_b_uil ? nblks : sc.b_fast_q0;
  const int b_qp1 = need_b_uil ? nblks : sc.b_fast_qp1;
  sc.uil_b_dirty = !need_b_uil && (sc.b_fast_qp1 > sc.b_fast_q0);
#ifdef __wasm_simd128__
  const v128_t v_dda = wasm_f32x4_splat(dda_f32);
  const v128_t v_dde = wasm_f32x4_splat(dde_f32);
  auto upd_full = [&](int bi_start, int bi_end) {
    for (int bi = bi_start; bi < bi_end; ++bi) {
      float* pec = sc.blk_hot + bi * 32;
      float* pu = pec + 8;
      const float* pp = sc.blk_p + bi * 32;
      const float* pa = sc.blk_a + bi * 32;
      const float* pe = sc.blk_e + bi * 16;
      const v128_t v_ec = wasm_f32x4_add(wasm_v128_load(pp + 0), wasm_f32x4_mul(wasm_v128_load(pa + 0), v_dda));
      const v128_t v_es = wasm_f32x4_add(wasm_v128_load(pp + 4), wasm_f32x4_mul(wasm_v128_load(pa + 4), v_dda));
      const v128_t v_uc = wasm_f32x4_add(wasm_f32x4_add(wasm_v128_load(pp + 8), wasm_f32x4_mul(wasm_v128_load(pa + 8), v_dda)), wasm_f32x4_mul(v_ec, v_dde));
      const v128_t v_us = wasm_f32x4_add(wasm_f32x4_add(wasm_v128_load(pp + 12), wasm_f32x4_mul(wasm_v128_load(pa + 12), v_dda)), wasm_f32x4_mul(v_es, v_dde));
      const v128_t v_ic = wasm_f32x4_add(wasm_f32x4_add(wasm_v128_load(pp + 16), wasm_f32x4_mul(wasm_v128_load(pa + 16), v_dda)), wasm_f32x4_mul(wasm_v128_load(pe + 0), v_dde));
      const v128_t v_is = wasm_f32x4_add(wasm_f32x4_add(wasm_v128_load(pp + 20), wasm_f32x4_mul(wasm_v128_load(pa + 20), v_dda)), wasm_f32x4_mul(wasm_v128_load(pe + 4), v_dde));
      const v128_t v_lc = wasm_f32x4_add(wasm_f32x4_add(wasm_v128_load(pp + 24), wasm_f32x4_mul(wasm_v128_load(pa + 24), v_dda)), wasm_f32x4_mul(wasm_v128_load(pe + 8), v_dde));
      const v128_t v_ls = wasm_f32x4_add(wasm_f32x4_add(wasm_v128_load(pp + 28), wasm_f32x4_mul(wasm_v128_load(pa + 28), v_dda)), wasm_f32x4_mul(wasm_v128_load(pe + 12), v_dde));
      wasm_v128_store(pec + 0, v_ec); wasm_v128_store(pec + 4, v_es);
      wasm_v128_store(pu + 0, v_uc);  wasm_v128_store(pu + 4, v_us);
      wasm_v128_store(pu + 8, v_ic);  wasm_v128_store(pu + 12, v_is);
      wasm_v128_store(pu + 16, v_lc); wasm_v128_store(pu + 20, v_ls);
    }
  };
  upd_full(0, b_q0);
  for (int bi = b_q0; bi < b_qp1; ++bi) {
    float* pec = sc.blk_hot + bi * 32;
    const float* pp = sc.blk_p + bi * 32;
    const float* pa = sc.blk_a + bi * 32;
    wasm_v128_store(pec + 0, wasm_f32x4_add(wasm_v128_load(pp + 0), wasm_f32x4_mul(wasm_v128_load(pa + 0), v_dda)));
    wasm_v128_store(pec + 4, wasm_f32x4_add(wasm_v128_load(pp + 4), wasm_f32x4_mul(wasm_v128_load(pa + 4), v_dda)));
  }
  upd_full(b_qp1, nblks);
#else
  for (int bi = 0; bi < nblks; ++bi) {
    float* pec = sc.blk_hot + bi * 32;
    const float* pp = sc.blk_p + bi * 32;
    const float* pa = sc.blk_a + bi * 32;
    for (int l = 0; l < 8; ++l) pec[l] = pp[l] + pa[l] * dda_f32;
    if (bi < b_q0 || bi >= b_qp1) {
      float* pu = pec + 8;
      const float* pe = sc.blk_e + bi * 16;
      for (int l = 0; l < 8; ++l) pu[l] = pp[8 + l] + pa[8 + l] * dda_f32 + pec[l] * dde_f32;
      for (int l = 0; l < 16; ++l) pu[8 + l] = pp[16 + l] + pa[16 + l] * dda_f32 + pe[l] * dde_f32;
    }
  }
#endif
}

[[gnu::noinline]] inline void sp_rebake_res(SpEvalCache& sc, double a0, double e0, double a, double e,
                                            double n, double eta, double ci, double ia) {
  sc.a_res = a;
  sc.e_res = e;
  sc.ci_res = ci;
  const double p_sl = a * eta * eta, j2 = 1.5 * kJ2 / (p_sl * p_sl);
  const double node_rate = -j2 * n * ci, wdot = 0.5 * j2 * n * (5.0 * ci * ci - 1.0);
  const double mdot = n + 0.5 * j2 * n * eta * (3.0 * ci * ci - 1.0);
  const double beta_dot = node_rate - kOmegaE;
  const double da = a0 * ia - 1.0, de_bake = sc.e_bake - e0;
  const float de_pe_diff_f = static_cast<float>(sc.e_pe_bake - sc.e_bake);
  const double alpha_A = -2.0 * ia / (n * a), beta_L = 3.0 * ia * ia;
#ifdef __wasm_simd128__
  float mdot_hi = 0.0f, mdot_lo = 0.0f, bdot_hi = 0.0f, bdot_lo = 0.0f;
  sp_split16_f32(mdot, mdot_hi, mdot_lo);
  sp_split16_f32(beta_dot, bdot_hi, bdot_lo);
  const v128_t v_one_f = wasm_f32x4_splat(1.0f);
  const v128_t v_wdot_f = wasm_f32x4_splat(static_cast<float>(wdot));
  const v128_t v_mdot_hi = wasm_f32x4_splat(mdot_hi);
  const v128_t v_mdot_lo = wasm_f32x4_splat(mdot_lo);
  const v128_t v_bdot_hi = wasm_f32x4_splat(bdot_hi);
  const v128_t v_bdot_lo = wasm_f32x4_splat(bdot_lo);
  const v128_t v_da = wasm_f32x4_splat(static_cast<float>(da));
  const v128_t v_hda = wasm_f32x4_splat(static_cast<float>(0.5 * da));
  const v128_t v_de_b = wasm_f32x4_splat(static_cast<float>(de_bake));
  const v128_t v_de_pe_diff = wasm_f32x4_splat(de_pe_diff_f);
  const v128_t v_alpha = wasm_f32x4_splat(static_cast<float>(alpha_A));
  const v128_t v_nalpha = wasm_f32x4_splat(static_cast<float>(-alpha_A));
  const v128_t v_beta_L = wasm_f32x4_splat(static_cast<float>(beta_L));
  for (int rk = 0; rk < sc.n_res_blks; ++rk) {
    const int bi = sc.res_blk[rk];
    const int lane_off = bi * 4;
    const v128_t v_active = wasm_v128_load(sc.blk_active + lane_off);
    const v128_t v_mf = wasm_v128_load(sc.blk_mf + lane_off);
    const v128_t v_wf = wasm_v128_load(sc.blk_w + lane_off);
    const v128_t v_jf = wasm_f32x4_add(v_wf, wasm_v128_load(sc.blk_q + lane_off));
    const v128_t v_bj = wasm_f32x4_mul(v_beta_L, v_jf);
    const v128_t v_psidot = wasm_f32x4_add(
        wasm_f32x4_add(wasm_f32x4_mul(v_jf, v_mdot_hi), wasm_f32x4_mul(v_mf, v_bdot_hi)),
        wasm_f32x4_add(wasm_f32x4_add(wasm_f32x4_mul(v_jf, v_mdot_lo), wasm_f32x4_mul(v_mf, v_bdot_lo)),
                       wasm_f32x4_mul(v_wf, v_wdot_f)));
    const v128_t v_ip = wasm_v128_and(wasm_f32x4_div(v_one_f, v_psidot), v_active);
    const float* const pc = sc.blk_c + bi * 64;
    float* const pec = sc.blk_hot + bi * 32;
    float* const pu = pec + 8;
    float* const pe = sc.blk_e + bi * 16;
    const v128_t uc0 = wasm_v128_load(pc + 0), us0 = wasm_v128_load(pc + 4);
    const v128_t dc0 = wasm_v128_load(pc + 8), ds0 = wasm_v128_load(pc + 12);
    const v128_t dca = wasm_v128_load(pc + 16), dsa = wasm_v128_load(pc + 20);
    const v128_t ec0 = wasm_v128_load(pc + 24), es0 = wasm_v128_load(pc + 28);
    const v128_t eca = wasm_v128_load(pc + 32), esa = wasm_v128_load(pc + 36);
    const v128_t ic0 = wasm_v128_load(pc + 40), is0 = wasm_v128_load(pc + 44);
    const v128_t ica = wasm_v128_load(pc + 48), isa = wasm_v128_load(pc + 52);
    const v128_t ice = wasm_v128_load(pc + 56), ise = wasm_v128_load(pc + 60);
    const v128_t ec = wasm_f32x4_add(ec0, wasm_f32x4_mul(eca, v_da));
    const v128_t es = wasm_f32x4_add(es0, wasm_f32x4_mul(esa, v_da));
    const v128_t uc_base = wasm_f32x4_sub(uc0, wasm_f32x4_mul(wasm_f32x4_add(dc0, wasm_f32x4_mul(dca, v_hda)), v_da));
    const v128_t us_base = wasm_f32x4_sub(us0, wasm_f32x4_mul(wasm_f32x4_add(ds0, wasm_f32x4_mul(dsa, v_hda)), v_da));
    const v128_t uc_b = wasm_f32x4_add(uc_base, wasm_f32x4_mul(ec, v_de_b));
    const v128_t us_b = wasm_f32x4_add(us_base, wasm_f32x4_mul(es, v_de_b));
    const v128_t ic_b = wasm_f32x4_add(wasm_f32x4_add(ic0, wasm_f32x4_mul(ica, v_da)), wasm_f32x4_mul(ice, v_de_b));
    const v128_t is_b = wasm_f32x4_add(wasm_f32x4_add(is0, wasm_f32x4_mul(isa, v_da)), wasm_f32x4_mul(ise, v_de_b));
    const v128_t duc_dda = wasm_f32x4_sub(wasm_f32x4_mul(eca, v_de_b), wasm_f32x4_add(dc0, wasm_f32x4_mul(dca, v_da)));
    const v128_t dus_dda = wasm_f32x4_sub(wasm_f32x4_mul(esa, v_de_b), wasm_f32x4_add(ds0, wasm_f32x4_mul(dsa, v_da)));
    const v128_t dc_b = wasm_f32x4_sub(wasm_f32x4_mul(dc0, v_da), duc_dda);
    const v128_t ds_b = wasm_f32x4_sub(wasm_f32x4_mul(ds0, v_da), dus_dda);
    const v128_t ec_ip = wasm_f32x4_mul(ec, v_ip), es_ip = wasm_f32x4_mul(es, v_ip);
    const v128_t uc_b_ip = wasm_f32x4_mul(uc_b, v_ip), us_b_ip = wasm_f32x4_mul(us_b, v_ip);
    v128_t ic_b_ip = wasm_f32x4_mul(ic_b, v_ip), is_b_ip = wasm_f32x4_mul(is_b, v_ip);
    v128_t lc_b_ip = wasm_f32x4_sub(wasm_f32x4_mul(v_alpha, wasm_f32x4_mul(dc_b, v_ip)), wasm_f32x4_mul(v_bj, wasm_f32x4_mul(uc_b_ip, v_ip)));
    v128_t ls_b_ip = wasm_f32x4_sub(wasm_f32x4_mul(v_alpha, wasm_f32x4_mul(ds_b, v_ip)), wasm_f32x4_mul(v_bj, wasm_f32x4_mul(us_b_ip, v_ip)));
    const v128_t pe0 = wasm_f32x4_mul(ice, v_ip);
    const v128_t pe4 = wasm_f32x4_mul(ise, v_ip);
    const v128_t pe8 = wasm_f32x4_mul(wasm_f32x4_sub(wasm_f32x4_mul(v_nalpha, eca), wasm_f32x4_mul(v_bj, ec_ip)), v_ip);
    const v128_t pe12 = wasm_f32x4_mul(wasm_f32x4_sub(wasm_f32x4_mul(v_nalpha, esa), wasm_f32x4_mul(v_bj, es_ip)), v_ip);
    if (sc.blk_is_pe[bi]) {
      ic_b_ip = wasm_f32x4_add(ic_b_ip, wasm_f32x4_mul(pe0, v_de_pe_diff));
      is_b_ip = wasm_f32x4_add(is_b_ip, wasm_f32x4_mul(pe4, v_de_pe_diff));
      lc_b_ip = wasm_f32x4_add(lc_b_ip, wasm_f32x4_mul(pe8, v_de_pe_diff));
      ls_b_ip = wasm_f32x4_add(ls_b_ip, wasm_f32x4_mul(pe12, v_de_pe_diff));
    }
    wasm_v128_store(pec + 0, ec_ip);  wasm_v128_store(pec + 4, es_ip);
    wasm_v128_store(pu + 0, uc_b_ip); wasm_v128_store(pu + 4, us_b_ip);
    wasm_v128_store(pu + 8, ic_b_ip); wasm_v128_store(pu + 12, is_b_ip);
    wasm_v128_store(pu + 16, lc_b_ip); wasm_v128_store(pu + 20, ls_b_ip);
    wasm_v128_store(pe + 0, pe0);
    wasm_v128_store(pe + 4, pe4);
    wasm_v128_store(pe + 8, pe8);
    wasm_v128_store(pe + 12, pe12);
  }
#else
  for (int rk = 0; rk < sc.n_res_blks; ++rk) {
    const int bi = sc.res_blk[rk];
    const int lane_off = bi * 4;
    const float* const pc = sc.blk_c + bi * 64;
    float* const pec = sc.blk_hot + bi * 32;
    float* const pu = pec + 8;
    float* const pe = sc.blk_e + bi * 16;
    const float dpe = sc.blk_is_pe[bi] ? de_pe_diff_f : 0.0f;
    for (int l = 0; l < 4; ++l) {
      if (sc.blk_active[lane_off + l] == 0u) continue;
      const double mv = sc.blk_mf[lane_off + l];
      const double wv = sc.blk_w[lane_off + l], j = wv + sc.blk_q[lane_off + l];
      const double inv_psidot = 1.0 / (wv * wdot + j * mdot + mv * beta_dot);
      const double inv_psidot2 = inv_psidot * inv_psidot;
      const double ec = pc[24 + l] + pc[32 + l] * da, es = pc[28 + l] + pc[36 + l] * da;
      const double uc_base = pc[0 + l] + (-pc[8 + l] - 0.5 * pc[16 + l] * da) * da;
      const double us_base = pc[4 + l] + (-pc[12 + l] - 0.5 * pc[20 + l] * da) * da;
      const double uc_b = uc_base + ec * de_bake, us_b = us_base + es * de_bake;
      const double dc_b = pc[8 + l] + (pc[8 + l] + pc[16 + l]) * da - pc[32 + l] * de_bake;
      const double ds_b = pc[12 + l] + (pc[12 + l] + pc[20 + l]) * da - pc[36 + l] * de_bake;
      const double ec_ip = ec * inv_psidot, es_ip = es * inv_psidot;
      pe[0 + l] = static_cast<float>(pc[56 + l] * inv_psidot);
      pe[4 + l] = static_cast<float>(pc[60 + l] * inv_psidot);
      pe[8 + l] = static_cast<float>((-alpha_A * pc[32 + l] - beta_L * j * ec_ip) * inv_psidot);
      pe[12 + l] = static_cast<float>((-alpha_A * pc[36 + l] - beta_L * j * es_ip) * inv_psidot);
      pec[0 + l] = static_cast<float>(ec_ip);
      pec[4 + l] = static_cast<float>(es_ip);
      pu[0 + l] = static_cast<float>(uc_b * inv_psidot);
      pu[4 + l] = static_cast<float>(us_b * inv_psidot);
      pu[8 + l] = static_cast<float>((pc[40 + l] + pc[48 + l] * da + pc[56 + l] * de_bake) * inv_psidot) + pe[0 + l] * dpe;
      pu[12 + l] = static_cast<float>((pc[44 + l] + pc[52 + l] * da + pc[60 + l] * de_bake) * inv_psidot) + pe[4 + l] * dpe;
      pu[16 + l] = static_cast<float>(alpha_A * dc_b * inv_psidot - beta_L * j * uc_b * inv_psidot2) + pe[8 + l] * dpe;
      pu[20 + l] = static_cast<float>(alpha_A * ds_b * inv_psidot - beta_L * j * us_b * inv_psidot2) + pe[12 + l] * dpe;
    }
  }
#endif
}

template <bool kNeedD2>
[[gnu::noinline]] inline void sp_six_deriv_impl(const SpEvalCache& sc, float de_f32, double a, double e, double n,
                                                double eta, double eta_m1, double ci_p0, double sin_i, double ci,
                                                double ia, double inv_1peta, const float* cswq_c, const float* cswq_s,
                                                const float* cm_f32, const float* sm_f32,
                                                double* six, double* dsix_dlam, double* d2six_dlam2) {
  const int nblks = sc.total_blks, b_contig_end = sc.b_contig_end;
  double sM = 0.0, s1_num = 0.0, s2_num = 0.0, sE = 0.0, sI = 0.0, sL = 0.0;
  double dsM = 0.0, ds1_num = 0.0, ds2_num = 0.0, dsE = 0.0, dsI = 0.0, dsL = 0.0;
  double d2sM = 0.0, d2s1_num = 0.0, d2s2_num = 0.0, d2sE = 0.0, d2sI = 0.0, d2sL = 0.0;
#ifdef __wasm_simd128__
  auto hsum_f32x4 = [](v128_t v) -> double {
    const v128_t d = wasm_f64x2_add(wasm_f64x2_promote_low_f32x4(v),
                                    wasm_f64x2_promote_low_f32x4(wasm_i64x2_shuffle(v, v, 1, 0)));
    return wasm_f64x2_extract_lane(d, 0) + wasm_f64x2_extract_lane(d, 1);
  };
  const v128_t v_de = wasm_f32x4_splat(de_f32);
  v128_t vg_w = wasm_f32x4_splat(0.0f),   vg_q = wasm_f32x4_splat(0.0f),   vg_m = wasm_f32x4_splat(0.0f);
  v128_t vg_sE = wasm_f32x4_splat(0.0f),  vg_sI = wasm_f32x4_splat(0.0f),  vg_sL = wasm_f32x4_splat(0.0f);
  v128_t vdg_w = wasm_f32x4_splat(0.0f),  vdg_q = wasm_f32x4_splat(0.0f),  vdg_m = wasm_f32x4_splat(0.0f);
  v128_t vdg_sE = wasm_f32x4_splat(0.0f), vdg_sI = wasm_f32x4_splat(0.0f), vdg_sL = wasm_f32x4_splat(0.0f);
  v128_t vd2_w = wasm_f32x4_splat(0.0f),  vd2_q = wasm_f32x4_splat(0.0f),  vd2_m = wasm_f32x4_splat(0.0f);
  v128_t vd2_sE = wasm_f32x4_splat(0.0f), vd2_sI = wasm_f32x4_splat(0.0f), vd2_sL = wasm_f32x4_splat(0.0f);
  const v128_t* vhot = reinterpret_cast<const v128_t*>(sc.blk_hot);
  const v128_t* vpe = reinterpret_cast<const v128_t*>(sc.blk_e);
  const v128_t* const vmseq_base = reinterpret_cast<const v128_t*>(kSpMSeq);
  const int nrows = sc.n_rows;
  int bi = 0;
  for (int ri = 0; ri < nrows; ++ri) {
    const SpRow& row = sc.rows[ri];
    const int bend = row.blk_end;
    const uint8_t wq0 = row.wq0;
    const v128_t cw = wasm_v128_load32_splat(cswq_c + wq0);
    const v128_t sw = wasm_v128_load32_splat(cswq_s + wq0);
    const float* pcm = cm_f32 + (static_cast<int>(row.c_start) << 2);
    const float* psm = sm_f32 + (static_cast<int>(row.c_start) << 2);
    const v128_t* pmf = vmseq_base + row.c_start;
    v128_t vr_idS = wasm_f32x4_splat(0.0f), vr_didS_u = wasm_f32x4_splat(0.0f);
    v128_t vr_m_idS = wasm_f32x4_splat(0.0f), vr_m_didS_u = wasm_f32x4_splat(0.0f);
    v128_t vr_sE = wasm_f32x4_splat(0.0f), vr_sI = wasm_f32x4_splat(0.0f), vr_sL = wasm_f32x4_splat(0.0f);
    v128_t vr_dsE = wasm_f32x4_splat(0.0f), vr_dsI = wasm_f32x4_splat(0.0f), vr_dsL = wasm_f32x4_splat(0.0f);
    for (; bi < bend; ++bi, vhot += 8, vpe += 4, pcm += 4, psm += 4, ++pmf) {
      const v128_t v_cm = wasm_v128_load(pcm), v_sm = wasm_v128_load(psm);
      const v128_t v_cp = wasm_f32x4_sub(wasm_f32x4_mul(cw, v_cm), wasm_f32x4_mul(sw, v_sm));
      const v128_t v_sp = wasm_f32x4_add(wasm_f32x4_mul(sw, v_cm), wasm_f32x4_mul(cw, v_sm));
      const v128_t v_ec = vhot[0], v_es = vhot[1];
      const v128_t v_uc = wasm_f32x4_add(vhot[2], wasm_f32x4_mul(v_ec, v_de));
      const v128_t v_us = wasm_f32x4_add(vhot[3], wasm_f32x4_mul(v_es, v_de));
      const v128_t v_ic = wasm_f32x4_add(vhot[4], wasm_f32x4_mul(vpe[0], v_de));
      const v128_t v_is = wasm_f32x4_add(vhot[5], wasm_f32x4_mul(vpe[1], v_de));
      const v128_t v_lc = wasm_f32x4_add(vhot[6], wasm_f32x4_mul(vpe[2], v_de));
      const v128_t v_ls = wasm_f32x4_add(vhot[7], wasm_f32x4_mul(vpe[3], v_de));
      const v128_t v_mf = *pmf;
      const v128_t idS_b = wasm_f32x4_add(wasm_f32x4_mul(v_uc, v_cp), wasm_f32x4_mul(v_us, v_sp));
      const v128_t didS_u = wasm_f32x4_sub(wasm_f32x4_mul(v_us, v_cp), wasm_f32x4_mul(v_uc, v_sp));
      vr_idS = wasm_f32x4_add(vr_idS, idS_b);
      vr_didS_u = wasm_f32x4_add(vr_didS_u, didS_u);
      vr_m_idS = wasm_f32x4_add(vr_m_idS, wasm_f32x4_mul(v_mf, idS_b));
      vr_m_didS_u = wasm_f32x4_add(vr_m_didS_u, wasm_f32x4_mul(v_mf, didS_u));
      vr_sE = wasm_f32x4_add(vr_sE, wasm_f32x4_sub(wasm_f32x4_mul(v_ec, v_sp), wasm_f32x4_mul(v_es, v_cp)));
      vr_sI = wasm_f32x4_add(vr_sI, wasm_f32x4_sub(wasm_f32x4_mul(v_ic, v_sp), wasm_f32x4_mul(v_is, v_cp)));
      vr_sL = wasm_f32x4_add(vr_sL, wasm_f32x4_sub(wasm_f32x4_mul(v_lc, v_sp), wasm_f32x4_mul(v_ls, v_cp)));
      vr_dsE = wasm_f32x4_add(vr_dsE, wasm_f32x4_add(wasm_f32x4_mul(v_ec, v_cp), wasm_f32x4_mul(v_es, v_sp)));
      vr_dsI = wasm_f32x4_add(vr_dsI, wasm_f32x4_add(wasm_f32x4_mul(v_ic, v_cp), wasm_f32x4_mul(v_is, v_sp)));
      vr_dsL = wasm_f32x4_add(vr_dsL, wasm_f32x4_add(wasm_f32x4_mul(v_lc, v_cp), wasm_f32x4_mul(v_ls, v_sp)));
    }
    const v128_t v_wf = wasm_v128_load32_splat(&row.wf);
    const v128_t v_qf = wasm_v128_load32_splat(&row.qf);
    const v128_t v_jf = wasm_v128_load32_splat(&row.jf);
    vg_w = wasm_f32x4_add(vg_w, wasm_f32x4_mul(v_wf, vr_idS));
    vg_q = wasm_f32x4_add(vg_q, wasm_f32x4_mul(v_qf, vr_idS));
    vg_m = wasm_f32x4_add(vg_m, vr_m_idS);
    vg_sE = wasm_f32x4_add(vg_sE, vr_sE);
    vg_sI = wasm_f32x4_add(vg_sI, vr_sI);
    vg_sL = wasm_f32x4_add(vg_sL, vr_sL);
    const v128_t vr_didS = wasm_f32x4_mul(v_jf, vr_didS_u);
    vdg_w = wasm_f32x4_add(vdg_w, wasm_f32x4_mul(v_wf, vr_didS));
    vdg_q = wasm_f32x4_add(vdg_q, wasm_f32x4_mul(v_qf, vr_didS));
    vdg_m = wasm_f32x4_add(vdg_m, wasm_f32x4_mul(v_jf, vr_m_didS_u));
    vdg_sE = wasm_f32x4_add(vdg_sE, wasm_f32x4_mul(v_jf, vr_dsE));
    vdg_sI = wasm_f32x4_add(vdg_sI, wasm_f32x4_mul(v_jf, vr_dsI));
    vdg_sL = wasm_f32x4_add(vdg_sL, wasm_f32x4_mul(v_jf, vr_dsL));
    if constexpr (kNeedD2) {
      const v128_t v_nj2 = wasm_f32x4_neg(wasm_f32x4_mul(v_jf, v_jf));
      const v128_t vr_d2idS = wasm_f32x4_mul(v_nj2, vr_idS);
      vd2_w = wasm_f32x4_add(vd2_w, wasm_f32x4_mul(v_wf, vr_d2idS));
      vd2_q = wasm_f32x4_add(vd2_q, wasm_f32x4_mul(v_qf, vr_d2idS));
      vd2_m = wasm_f32x4_add(vd2_m, wasm_f32x4_mul(v_nj2, vr_m_idS));
      vd2_sE = wasm_f32x4_add(vd2_sE, wasm_f32x4_mul(v_nj2, vr_sE));
      vd2_sI = wasm_f32x4_add(vd2_sI, wasm_f32x4_mul(v_nj2, vr_sI));
      vd2_sL = wasm_f32x4_add(vd2_sL, wasm_f32x4_mul(v_nj2, vr_sL));
    }
  }
  (void)b_contig_end;
  for (; bi < nblks; ++bi, vhot += 8, vpe += 4) {
    const int lo = bi * 4;
    const uint8_t* wqp = sc.blk_wq + lo;
    const uint8_t* mp = sc.blk_mlane + lo;
    const v128_t v_cwj = wasm_f32x4_make(cswq_c[wqp[0]], cswq_c[wqp[1]], cswq_c[wqp[2]], cswq_c[wqp[3]]);
    const v128_t v_swj = wasm_f32x4_make(cswq_s[wqp[0]], cswq_s[wqp[1]], cswq_s[wqp[2]], cswq_s[wqp[3]]);
    const v128_t v_cm  = wasm_f32x4_make(cm_f32[mp[0]],  cm_f32[mp[1]],  cm_f32[mp[2]],  cm_f32[mp[3]]);
    const v128_t v_sm  = wasm_f32x4_make(sm_f32[mp[0]],  sm_f32[mp[1]],  sm_f32[mp[2]],  sm_f32[mp[3]]);
    const v128_t v_cp = wasm_f32x4_sub(wasm_f32x4_mul(v_cwj, v_cm), wasm_f32x4_mul(v_swj, v_sm));
    const v128_t v_sp = wasm_f32x4_add(wasm_f32x4_mul(v_swj, v_cm), wasm_f32x4_mul(v_cwj, v_sm));
    const v128_t v_ec = vhot[0], v_es = vhot[1];
    const v128_t v_uc = wasm_f32x4_add(vhot[2], wasm_f32x4_mul(v_ec, v_de));
    const v128_t v_us = wasm_f32x4_add(vhot[3], wasm_f32x4_mul(v_es, v_de));
    const v128_t v_ic = wasm_f32x4_add(vhot[4], wasm_f32x4_mul(vpe[0], v_de));
    const v128_t v_is = wasm_f32x4_add(vhot[5], wasm_f32x4_mul(vpe[1], v_de));
    const v128_t v_lc = wasm_f32x4_add(vhot[6], wasm_f32x4_mul(vpe[2], v_de));
    const v128_t v_ls = wasm_f32x4_add(vhot[7], wasm_f32x4_mul(vpe[3], v_de));
    const v128_t v_wf = wasm_v128_load(sc.blk_w + lo);
    const v128_t v_qf = wasm_v128_load(sc.blk_q + lo);
    const v128_t v_jf = wasm_f32x4_add(v_wf, v_qf);
    const v128_t v_mf = wasm_v128_load(sc.blk_mf + lo);
    const v128_t idS_b = wasm_f32x4_add(wasm_f32x4_mul(v_uc, v_cp), wasm_f32x4_mul(v_us, v_sp));
    const v128_t didS_b = wasm_f32x4_mul(v_jf, wasm_f32x4_sub(wasm_f32x4_mul(v_us, v_cp), wasm_f32x4_mul(v_uc, v_sp)));
    const v128_t tE_b = wasm_f32x4_sub(wasm_f32x4_mul(v_ec, v_sp), wasm_f32x4_mul(v_es, v_cp));
    const v128_t tI_b = wasm_f32x4_sub(wasm_f32x4_mul(v_ic, v_sp), wasm_f32x4_mul(v_is, v_cp));
    const v128_t tL_b = wasm_f32x4_sub(wasm_f32x4_mul(v_lc, v_sp), wasm_f32x4_mul(v_ls, v_cp));
    vg_w = wasm_f32x4_add(vg_w, wasm_f32x4_mul(v_wf, idS_b));
    vg_q = wasm_f32x4_add(vg_q, wasm_f32x4_mul(v_qf, idS_b));
    vg_m = wasm_f32x4_add(vg_m, wasm_f32x4_mul(v_mf, idS_b));
    vg_sE = wasm_f32x4_add(vg_sE, tE_b);
    vg_sI = wasm_f32x4_add(vg_sI, tI_b);
    vg_sL = wasm_f32x4_add(vg_sL, tL_b);
    vdg_w = wasm_f32x4_add(vdg_w, wasm_f32x4_mul(v_wf, didS_b));
    vdg_q = wasm_f32x4_add(vdg_q, wasm_f32x4_mul(v_qf, didS_b));
    vdg_m = wasm_f32x4_add(vdg_m, wasm_f32x4_mul(v_mf, didS_b));
    vdg_sE = wasm_f32x4_add(vdg_sE, wasm_f32x4_mul(v_jf, wasm_f32x4_add(wasm_f32x4_mul(v_ec, v_cp), wasm_f32x4_mul(v_es, v_sp))));
    vdg_sI = wasm_f32x4_add(vdg_sI, wasm_f32x4_mul(v_jf, wasm_f32x4_add(wasm_f32x4_mul(v_ic, v_cp), wasm_f32x4_mul(v_is, v_sp))));
    vdg_sL = wasm_f32x4_add(vdg_sL, wasm_f32x4_mul(v_jf, wasm_f32x4_add(wasm_f32x4_mul(v_lc, v_cp), wasm_f32x4_mul(v_ls, v_sp))));
    if constexpr (kNeedD2) {
      const v128_t nj2 = wasm_f32x4_neg(wasm_f32x4_mul(v_jf, v_jf));
      const v128_t d2idS = wasm_f32x4_mul(nj2, idS_b);
      vd2_w = wasm_f32x4_add(vd2_w, wasm_f32x4_mul(v_wf, d2idS));
      vd2_q = wasm_f32x4_add(vd2_q, wasm_f32x4_mul(v_qf, d2idS));
      vd2_m = wasm_f32x4_add(vd2_m, wasm_f32x4_mul(v_mf, d2idS));
      vd2_sE = wasm_f32x4_add(vd2_sE, wasm_f32x4_mul(nj2, tE_b));
      vd2_sI = wasm_f32x4_add(vd2_sI, wasm_f32x4_mul(nj2, tI_b));
      vd2_sL = wasm_f32x4_add(vd2_sL, wasm_f32x4_mul(nj2, tL_b));
    }
  }
  double sum_w = hsum_f32x4(vg_w), sum_q = hsum_f32x4(vg_q), midS = hsum_f32x4(vg_m);
  sE = hsum_f32x4(vg_sE); sI = hsum_f32x4(vg_sI); sL = hsum_f32x4(vg_sL);
  double dsum_w = hsum_f32x4(vdg_w), dsum_q = hsum_f32x4(vdg_q), dmidS = hsum_f32x4(vdg_m);
  dsE = hsum_f32x4(vdg_sE); dsI = hsum_f32x4(vdg_sI); dsL = hsum_f32x4(vdg_sL);
  double d2sum_w = 0.0, d2sum_q = 0.0, d2midS = 0.0;
  if constexpr (kNeedD2) {
    d2sum_w = hsum_f32x4(vd2_w); d2sum_q = hsum_f32x4(vd2_q); d2midS = hsum_f32x4(vd2_m);
    d2sE = hsum_f32x4(vd2_sE); d2sI = hsum_f32x4(vd2_sI); d2sL = hsum_f32x4(vd2_sL);
  }
  sM = sum_w + sum_q;
  s1_num = eta * sum_q + eta_m1 * sum_w;
  s2_num = ci_p0 * sum_w - midS;
  dsM = dsum_w + dsum_q;
  ds1_num = eta * dsum_q + eta_m1 * dsum_w;
  ds2_num = ci_p0 * dsum_w - dmidS;
  if constexpr (kNeedD2) {
    d2sM = d2sum_w + d2sum_q;
    d2s1_num = eta * d2sum_q + eta_m1 * d2sum_w;
    d2s2_num = ci_p0 * d2sum_w - d2midS;
  }
#else
  (void)b_contig_end;
  double sum_w = 0.0, sum_q = 0.0, midS = 0.0;
  double dsum_w = 0.0, dsum_q = 0.0, dmidS = 0.0;
  double d2sum_w = 0.0, d2sum_q = 0.0, d2midS = 0.0;
  const float* pec = sc.blk_hot;
  const float* pu = pec + 8;
  const float* pe = sc.blk_e;
  for (int bi = 0; bi < nblks; ++bi, pec += 32, pu += 32, pe += 16) {
    const int lane_off = bi * 4;
    for (int l = 0; l < 4; ++l) {
      if (sc.blk_active[lane_off + l] == 0u) continue;
      const int m_idx = sc.blk_mlane[lane_off + l];
      const int wq_idx = sc.blk_wq[lane_off + l];
      const float cmv = cm_f32[m_idx], smv = sm_f32[m_idx];
      const float cs0 = cswq_c[wq_idx], cs1 = cswq_s[wq_idx];
      const float cp = cs0 * cmv - cs1 * smv;
      const float sp = cs1 * cmv + cs0 * smv;
      const float ec = pec[0 + l], es = pec[4 + l];
      const float uc = pu[0 + l] + ec * de_f32, us = pu[4 + l] + es * de_f32;
      const float ic = pu[8 + l] + pe[0 + l] * de_f32, is = pu[12 + l] + pe[4 + l] * de_f32;
      const float lc = pu[16 + l] + pe[8 + l] * de_f32, ls = pu[20 + l] + pe[12 + l] * de_f32;
      const double mv = sc.blk_mf[lane_off + l];
      const double wv = sc.blk_w[lane_off + l], qv = sc.blk_q[lane_off + l], jf = wv + qv;
      const double idS = uc * cp + us * sp, didS = jf * (us * cp - uc * sp);
      const double tE = ec * sp - es * cp, tI = ic * sp - is * cp, tL = lc * sp - ls * cp;
      sum_w += wv * idS; sum_q += qv * idS; midS += mv * idS;
      sE += tE; sI += tI; sL += tL;
      dsum_w += wv * didS; dsum_q += qv * didS; dmidS += mv * didS;
      dsE += jf * (ec * cp + es * sp); dsI += jf * (ic * cp + is * sp); dsL += jf * (lc * cp + ls * sp);
      if constexpr (kNeedD2) {
        const double nj2 = -(jf * jf);
        d2sum_w += nj2 * wv * idS; d2sum_q += nj2 * qv * idS; d2midS += nj2 * mv * idS;
        d2sE += nj2 * tE; d2sI += nj2 * tI; d2sL += nj2 * tL;
      }
    }
  }
  sM = sum_w + sum_q;
  s1_num = eta * sum_q + eta_m1 * sum_w; s2_num = ci_p0 * sum_w - midS;
  dsM = dsum_w + dsum_q;
  ds1_num = eta * dsum_q + eta_m1 * dsum_w; ds2_num = ci_p0 * dsum_w - dmidS;
  if constexpr (kNeedD2) {
    d2sM = d2sum_w + d2sum_q;
    d2s1_num = eta * d2sum_q + eta_m1 * d2sum_w; d2s2_num = ci_p0 * d2sum_w - d2midS;
  }
#endif
  const double na2 = n * a * a;
#ifdef __wasm_simd128__
  const v128_t v_one_d = wasm_f64x2_splat(1.0);
  const v128_t v_r1 = wasm_f64x2_div(v_one_d, wasm_f64x2_make(1.0 + ci, sin_i));
  const v128_t v_r2 = wasm_f64x2_div(v_one_d, wasm_f64x2_make(na2 * e, na2 * eta));
  const double inv_1pci = wasm_f64x2_extract_lane(v_r1, 0);
  const double inv_sini = wasm_f64x2_extract_lane(v_r1, 1);
  const double inv_na2e = wasm_f64x2_extract_lane(v_r2, 0);
  const double inv_na2eta = wasm_f64x2_extract_lane(v_r2, 1);
#else
  const double inv_1pci = 1.0 / (1.0 + ci);
  const double inv_sini = 1.0 / sin_i;
  const double inv_na2e = 1.0 / (na2 * e);
  const double inv_na2eta = 1.0 / (na2 * eta);
#endif
  const double tanhalf = sin_i * inv_1pci;
  const double k0 = -3.0 * ia * ia;
  const double k1 = eta * inv_na2e;
  const double k2 = inv_na2eta * inv_sini;
  const double kE = (eta * eta) * inv_na2eta;
  const double kEI = e * tanhalf * inv_na2eta;
  const double kLE = (e * inv_1peta) * kE;
  const double kLI = tanhalf * inv_na2eta;
  six[0] += k0 * sM;
  six[1] += k1 * s1_num;
  six[2] += k2 * s2_num;
  six[3] += kE * sE + kEI * sI;
  six[4] += inv_na2eta * sI;
  six[5] += sL + kLE * sE + kLI * sI;
  dsix_dlam[0] += k0 * dsM;
  dsix_dlam[1] += k1 * ds1_num;
  dsix_dlam[2] += k2 * ds2_num;
  dsix_dlam[3] += kE * dsE + kEI * dsI;
  dsix_dlam[4] += inv_na2eta * dsI;
  dsix_dlam[5] += dsL + kLE * dsE + kLI * dsI;
  if constexpr (kNeedD2) {
    d2six_dlam2[0] += k0 * d2sM;
    d2six_dlam2[1] += k1 * d2s1_num;
    d2six_dlam2[2] += k2 * d2s2_num;
    d2six_dlam2[3] += kE * d2sE + kEI * d2sI;
    d2six_dlam2[4] += inv_na2eta * d2sI;
    d2six_dlam2[5] += d2sL + kLE * d2sE + kLI * d2sI;
  }
}

inline void sp_six_deriv(const SpEvalCache& sc, float de_f32, double a, double e, double n,
                         double eta, double eta_m1, double ci_p0, double sin_i, double ci,
                         double ia, double inv_1peta, const float* cswq_c, const float* cswq_s,
                         const float* cm_f32, const float* sm_f32,
                         double* six, double* dsix_dlam, double* d2six_dlam2) {
  if (d2six_dlam2 != nullptr) {
    sp_six_deriv_impl<true>(sc, de_f32, a, e, n, eta, eta_m1, ci_p0, sin_i, ci, ia, inv_1peta,
                            cswq_c, cswq_s, cm_f32, sm_f32, six, dsix_dlam, d2six_dlam2);
  } else {
    sp_six_deriv_impl<false>(sc, de_f32, a, e, n, eta, eta_m1, ci_p0, sin_i, ci, ia, inv_1peta,
                             cswq_c, cswq_s, cm_f32, sm_f32, six, dsix_dlam, nullptr);
  }
}

/// Whether sc holds F's terms grouped (the set they belong to: its table, its epoch a and e).
inline bool sp_matches(const SpEvalCache& sc, const SpCombCoef* F, int count, uint32_t tag, double a0, double e0) {
  return sc.F == F && sc.count == count && sc.table_tag == tag && sc.a0 == a0 && sc.e0 == e0 && sc.grouped_ok &&
         sc.f0_uc == F[0].uc0 && sc.f0_ic == F[0].ic0 && sc.fn_uc == F[count - 1].uc0;
}

/// The cache to evaluate F with once the thread's cache `th` holds it grouped: the set's own (a copy of th, from the
/// pool) when the set being flown can hold one, else th. A set's cache for other terms is given back first.
[[gnu::noinline]] inline SpEvalCache* sp_claim(SpSetSlot* slot, SpEvalCache& th, const SpCombCoef* F, int count, uint32_t tag,
                                              double a0, double e0) {
  if (slot == nullptr) return &th;
  if (slot->cache != nullptr && !sp_matches(*slot->cache, F, count, tag, a0, e0)) {
    sp_pool_release(slot->cache);
    slot->cache = nullptr;
  }
  if (slot->cache == nullptr) slot->cache = sp_pool_attach(th);
  return slot->cache != nullptr ? slot->cache : &th;
}

[[gnu::noinline]] inline bool sp_init_or_fallback(
    SpEvalCache& sc, const SpCombCoef* F, int count, uint32_t tag, double a0, double e0, double t,
    const Kepler& kp, double a, double e, double n, double eta, double sin_i, double ci, double ia, double ci_build,
    double theta_g0, const double* sb_in, const double* cb_in, const double* su1_in, const double* cu1_in,
    const double* sM1_in, const double* cM1_in, double* six, double* dsix_dlam, double* d2six_dlam2) {
  if (sc.F != F || sc.count != count || sc.table_tag != tag || sc.a0 != a0 || sc.e0 != e0 ||
      sc.f0_uc != F[0].uc0 || sc.f0_ic != F[0].ic0 || sc.fn_uc != F[count - 1].uc0) {
    sp_rebuild_cache(sc, F, count, tag, a0, e0, ci_build);
  }
  if (!sc.grouped_ok || t == 0.0) {
    double sb, cb, su1, cu1, sM1, cM1;
    if (sb_in != nullptr && cb_in != nullptr) { sb = *sb_in; cb = *cb_in; }
    else fm::sincos(kp.node - (theta_g0 + kOmegaE * t), sb, cb);
    if (su1_in != nullptr && cu1_in != nullptr) { su1 = *su1_in; cu1 = *cu1_in; }
    else fm::sincos(kp.argp + kp.m, su1, cu1);
    if (sM1_in != nullptr && cM1_in != nullptr) { sM1 = *sM1_in; cM1 = *cM1_in; }
    else fm::sincos(kp.m, sM1, cM1);
    sp_six_fallback(sc, F, count, a0, e0, a, e, n, eta, sin_i, ci, ia, sb, cb, su1, cu1, sM1, cM1,
                    six, dsix_dlam, d2six_dlam2);
    return false;
  }
  return true;
}

[[gnu::noinline]] inline bool sp_init_or_fallback_val(
    SpEvalCache& sc, const SpCombCoef* F, int count, uint32_t tag, double a0, double e0, double t,
    double a, double e, double n, double eta, double sin_i, double ci, double ia, double ci_build,
    double sb, double cb, double su1, double cu1, double sM1, double cM1, double* six) {
  if (sc.F != F || sc.count != count || sc.table_tag != tag || sc.a0 != a0 || sc.e0 != e0 ||
      sc.f0_uc != F[0].uc0 || sc.f0_ic != F[0].ic0 || sc.fn_uc != F[count - 1].uc0) {
    sp_rebuild_cache(sc, F, count, tag, a0, e0, ci_build);
  }
  if (!sc.grouped_ok || t == 0.0) {
    sp_six_fallback(sc, F, count, a0, e0, a, e, n, eta, sin_i, ci, ia, sb, cb, su1, cu1, sM1, cM1,
                    six, nullptr, nullptr);
    return false;
  }
  return true;
}

constexpr int64_t kSpPeAtBake = INT64_MIN;  ///< the pe cell of a derivative pass: the pe blocks at the ae bake's e

/// A compact cache borrows coefficients from the thread cache when their grouping ids match; otherwise it
/// rebuilds from F. A base bake reads every block. A resonant-only bake reads only the requested blocks,
/// leaving only those blocks valid in temporary storage. Grouping writes coefficients that baking does not modify.
inline float* sp_compact_blk_c(const SpEvalCache& sc, const uint16_t* blocks = nullptr, int count = 0) {
  const SpEvalCache* th = g_sp_eval_cache_ptr;
  if (th != nullptr && th != &sc && th->blk_c != nullptr && th->grouped_ok && sc.group_id != 0 && th->group_id == sc.group_id)
    return th->blk_c;
  return sp_blk_c(sc, blocks, count);
}

/// The bakes for the state (a, e, cos i) at time t, each level at a point that is a function of the state's bracket
/// and t (SPEC 9): with the bracket (g_sp_anchor, t on it), the level's part of the bracket (sp_anchor_point); without
/// one, the center of the state's cell of that level. Levels and tolerances: base (a relative 3e-5, e^2 2e-5, cos i
/// 1.5e-4, 6e-5 from e0 0.03), ae (a relative 1.8e-6, e 2e-5), pe (e de_pe_thresh; a derivative pass keeps the pe
/// blocks at the ae bake's e), res (a relative 2e-7, e^2 1e-5, cos i 1e-6). A level baked again bakes the levels
/// above it again, the resonant blocks last. A set's cache bakes from the coefficients sp_compact_blk_c gives it for a
/// base or resonant bake. The keys it leaves are what sp_keys_hold compares with, inline, before calling it.
[[gnu::noinline]] inline void sp_sync(SpEvalCache& sc, double a0, double e0, double a, double e, double ci, double t,
                                      bool derivative) {
  const SpAnchor& an = g_sp_anchor;
  const bool anchored = sp_anchored(t);
  const uint64_t aid = anchored ? an.id : 0;
  const double ctol = e0 < 0.03 ? 1.5e-4 : 6e-5;
  double a_b, e_b, ci_b, a_ae, e_ae, c_ae, e_pe = 0.0, a_pe, c_pe;
  int64_t kba, kbe = 0, kbc = 0, kaa, kae = 0, kpe = kSpPeAtBake;
  if (anchored) {
    kba = sp_anchor_point(an, t, 3e-5, 2e-5, true, ctol, a_b, e_b, ci_b);
    kaa = sp_anchor_point(an, t, 1.8e-6, 2e-5, false, 0.0, a_ae, e_ae, c_ae);
    if (!derivative && sc.n_pe_blks > 0) kpe = sp_anchor_point(an, t, 1e30, sc.de_pe_thresh, false, 0.0, a_pe, e_pe, c_pe);
  } else {
    kba = sp_cell_rel(a, 3e-5, a_b);
    kbe = sp_cell_e(e, 2.5e-4, 2e-5, e_b);
    kbc = sp_cell_abs(ci, ctol, ci_b);
    kaa = sp_cell_rel(a, 1.8e-6, a_ae);
    kae = sp_cell_abs(e, 2e-5, e_ae);
    if (!derivative && sc.n_pe_blks > 0) kpe = sp_cell_abs(e, sc.de_pe_thresh, e_pe);
  }
  const bool fresh = !sc.keys_valid || sc.anchor_id != aid;
  const bool base = fresh || kba != sc.kb_a || kbe != sc.kb_e || kbc != sc.kb_c;
  bool ae = base || kaa != sc.kae_a || kae != sc.kae_e;
  const bool pe = ae || kpe != sc.kpe;
  if (pe && !ae && sc.e_pe_bake != sc.e_bake) ae = true;  // the pe blocks back to the ae bake's e: the ae bake again
  double a_r = 0.0, ci_r = 0.0, e_r = 0.0;
  int64_t kra = 0, krc = 0, kre = 0;
  auto res_point = [&]() {
    if (anchored) {
      kra = sp_anchor_point(an, t, 2e-7, 1e-5, true, 1e-6, a_r, e_r, ci_r);
    } else {
      kra = sp_cell_rel(a, 2e-7, a_r);
      krc = sp_cell_abs(ci, 1e-6, ci_r);
      kre = sp_cell_e(e, 1.25e-4, 1e-5, e_r);
    }
  };
  bool res = false;
  if (!base && sc.n_res_blks > 0) {
    res_point();
    res = pe || kra != sc.kr_a || krc != sc.kr_c || kre != sc.kr_e;
  }
  // what sp_keys_hold compares with: the keys the cache holds when this call returns (kept, or baked now)
  auto note_keys = [&]() {
    sc.on_bracket = anchored;
    if (!anchored) return;
    sc.kb_tlo = an.tlo;
    sc.kb_h = an.h;
    sc.n_base = static_cast<int32_t>(kba >> 6);
    sc.n_ae = static_cast<int32_t>(kaa >> 6);
    sc.n_pe = kpe != kSpPeAtBake ? static_cast<int32_t>(kpe >> 6) : 0;
    sc.n_res = sc.n_res_blks > 0 ? static_cast<int32_t>(kra >> 6) : 0;
  };
  if (!base && !ae && !pe && !res) {
    note_keys();
    return;
  }
  float* const own_c = sc.blk_c;
  if (base && sc.compact) sc.blk_c = sp_compact_blk_c(sc);
  if (base) {
    const double n_b = kKe / (a_b * std::sqrt(a_b));
    sp_rebake_base(sc, a0, e0, a_b, e_b, n_b, std::sqrt(1.0 - e_b * e_b), ci_b, 1.0 / a_b);
    if (sc.n_res_blks > 0) {
      res_point();
      res = true;
    }
  }
  if (ae) sp_rebake_ae(sc, a0, a_ae, e_ae, 1.0 / a_ae, true);
  if (pe && kpe != kSpPeAtBake) sp_rebake_pe_fast(sc, e_pe);
  if (res) {
    // a resonant bake alone reads the resonant blocks' coefficients only
    if (sc.compact && sc.blk_c == nullptr) sc.blk_c = sp_compact_blk_c(sc, sc.res_blk, sc.n_res_blks);
    const double n_r = kKe / (a_r * std::sqrt(a_r));
    sp_rebake_res(sc, a0, e0, a_r, e_r, n_r, std::sqrt(1.0 - e_r * e_r), ci_r, 1.0 / a_r);
    sc.kr_a = kra;
    sc.kr_c = krc;
    sc.kr_e = kre;
  }
  if (sc.compact) sc.blk_c = own_c;
  sc.anchor_id = aid;
  sc.kb_a = kba;
  sc.kb_e = kbe;
  sc.kb_c = kbc;
  sc.kae_a = kaa;
  sc.kae_e = kae;
  sc.kpe = kpe;
  sc.keys_valid = true;
  note_keys();
}

/// Whether sp_sync would bake nothing for time t (stack #441): the cache's keys were made on the bracket g_sp_anchor
/// names and t lies in the same part of it at every level. The same tests and keys as sp_sync's (sp_anchored,
/// sp_part_key), so it answers what that call would; inline, so a state that bakes nothing makes no call.
[[gnu::always_inline]] inline bool sp_keys_hold(const SpEvalCache& sc, double t, bool derivative) {
  const SpAnchor& an = g_sp_anchor;
  if (!sc.on_bracket || !sc.keys_valid || !an.valid || an.h == 0.0 || an.id != sc.anchor_id || an.tlo != sc.kb_tlo ||
      an.h != sc.kb_h)
    return false;
  const double q = (t - an.tlo) / an.h;
  if (!(q >= 0.0 && q <= 1.0)) return false;
  if (sp_part_key(q, sc.n_base) != sc.kb_a || sc.kb_e != 0 || sc.kb_c != 0 || sp_part_key(q, sc.n_ae) != sc.kae_a || sc.kae_e != 0)
    return false;
  if (!derivative && sc.n_pe_blks > 0) {
    if (sc.n_pe == 0 || sp_part_key(q, sc.n_pe) != sc.kpe) return false;
  } else if (sc.kpe != kSpPeAtBake) {
    return false;
  }
  return sc.n_res_blks == 0 || (sp_part_key(q, sc.n_res) == sc.kr_a && sc.kr_c == 0 && sc.kr_e == 0);
}

[[gnu::always_inline]] inline void sp_fill_trig(SpEvalCache& sc, double cb, double sb, double cu1, double su1,
                                                double cM1, double sM1, float* cm_f32, float* sm_f32,
                                                int start_m, double cm_last, double sm_last, bool has_ext_cm) {
  const int max_aw = sc.max_aw, max_m = sc.max_m;
  float* const cswq_c = sc.cswq_c;
  float* const cswq_s = sc.cswq_s;
  const float cMf = static_cast<float>(cM1), sMf = static_cast<float>(sM1);
  cswq_c[0 * 40 + 20] = 1.0f; cswq_s[0 * 40 + 20] = 0.0f;
  cswq_c[1 * 40 + 20] = cMf;  cswq_s[1 * 40 + 20] = -sMf;
  cswq_c[2 * 40 + 20] = cMf;  cswq_s[2 * 40 + 20] = sMf;
#ifdef __wasm_simd128__
  if (max_aw > 0) {
    const double u_c1 = cu1, u_s1 = su1;
    const double u_c2 = u_c1 * cu1 - u_s1 * su1, u_s2 = u_s1 * cu1 + u_c1 * su1;
    const double u_c3 = u_c2 * cu1 - u_s2 * su1, u_s3 = u_s2 * cu1 + u_c2 * su1;
    const double u_c4 = u_c3 * cu1 - u_s3 * su1, u_s4 = u_s3 * cu1 + u_c3 * su1;
    v128_t v_cu = wasm_f32x4_make(static_cast<float>(u_c1), static_cast<float>(u_c2), static_cast<float>(u_c3), static_cast<float>(u_c4));
    v128_t v_su = wasm_f32x4_make(static_cast<float>(u_s1), static_cast<float>(u_s2), static_cast<float>(u_s3), static_cast<float>(u_s4));
    const v128_t v_cu4 = wasm_f32x4_splat(static_cast<float>(u_c4));
    const v128_t v_su4 = wasm_f32x4_splat(static_cast<float>(u_s4));
    const v128_t v_cM = wasm_f32x4_splat(cMf);
    const v128_t v_sM = wasm_f32x4_splat(sMf);
    const int lim_aw = max_aw <= 16 ? max_aw : 16;
    for (int idx = 0;;) {
      const v128_t v_cc = wasm_f32x4_mul(v_cu, v_cM), v_ss = wasm_f32x4_mul(v_su, v_sM);
      const v128_t v_sc = wasm_f32x4_mul(v_su, v_cM), v_cs = wasm_f32x4_mul(v_cu, v_sM);
      const v128_t v_cwm = wasm_f32x4_add(v_cc, v_ss), v_swm = wasm_f32x4_sub(v_sc, v_cs);
      const v128_t v_cwp = wasm_f32x4_sub(v_cc, v_ss), v_swp = wasm_f32x4_add(v_sc, v_cs);
      const int pos = 21 + idx, neg = 16 - idx;
      wasm_v128_store(cswq_c + 0 * 40 + pos, v_cu);
      wasm_v128_store(cswq_s + 0 * 40 + pos, v_su);
      wasm_v128_store(cswq_c + 0 * 40 + neg, wasm_i32x4_shuffle(v_cu, v_cu, 3, 2, 1, 0));
      wasm_v128_store(cswq_s + 0 * 40 + neg, wasm_f32x4_neg(wasm_i32x4_shuffle(v_su, v_su, 3, 2, 1, 0)));
      wasm_v128_store(cswq_c + 1 * 40 + pos, v_cwm);
      wasm_v128_store(cswq_s + 1 * 40 + pos, v_swm);
      wasm_v128_store(cswq_c + 1 * 40 + neg, wasm_i32x4_shuffle(v_cwp, v_cwp, 3, 2, 1, 0));
      wasm_v128_store(cswq_s + 1 * 40 + neg, wasm_f32x4_neg(wasm_i32x4_shuffle(v_swp, v_swp, 3, 2, 1, 0)));
      wasm_v128_store(cswq_c + 2 * 40 + pos, v_cwp);
      wasm_v128_store(cswq_s + 2 * 40 + pos, v_swp);
      wasm_v128_store(cswq_c + 2 * 40 + neg, wasm_i32x4_shuffle(v_cwm, v_cwm, 3, 2, 1, 0));
      wasm_v128_store(cswq_s + 2 * 40 + neg, wasm_f32x4_neg(wasm_i32x4_shuffle(v_swm, v_swm, 3, 2, 1, 0)));
      idx += 4;
      if (idx >= lim_aw) break;
      const v128_t ncu = wasm_f32x4_sub(wasm_f32x4_mul(v_cu, v_cu4), wasm_f32x4_mul(v_su, v_su4));
      v_su = wasm_f32x4_add(wasm_f32x4_mul(v_su, v_cu4), wasm_f32x4_mul(v_cu, v_su4));
      v_cu = ncu;
    }
    if (__builtin_expect(max_aw > 16, 0)) {
      const float cu16 = cswq_c[20 + 16], su16 = cswq_s[20 + 16];
      const float cu1f = static_cast<float>(cu1), su1f = static_cast<float>(su1);
      const float c_w0 = cu16 * cu1f - su16 * su1f, s_w0 = su16 * cu1f + cu16 * su1f;
      const float cc = c_w0 * cMf, ss = s_w0 * sMf, sc_ = s_w0 * cMf, cs = c_w0 * sMf;
      const float c_wm = cc + ss, s_wm = sc_ - cs, c_wp = cc - ss, s_wp = sc_ + cs;
      cswq_c[0 * 40 + 37] = c_w0; cswq_s[0 * 40 + 37] = s_w0;
      cswq_c[0 * 40 + 3]  = c_w0; cswq_s[0 * 40 + 3]  = -s_w0;
      cswq_c[1 * 40 + 37] = c_wm; cswq_s[1 * 40 + 37] = s_wm;
      cswq_c[1 * 40 + 3]  = c_wp; cswq_s[1 * 40 + 3]  = -s_wp;
      cswq_c[2 * 40 + 37] = c_wp; cswq_s[2 * 40 + 37] = s_wp;
      cswq_c[2 * 40 + 3]  = c_wm; cswq_s[2 * 40 + 3]  = -s_wm;
    }
  }
  (void)has_ext_cm;
  if (start_m == 0) {
    const double c1 = cb, s1 = sb;
    const double c2 = c1 * cb - s1 * sb, s2 = s1 * cb + c1 * sb;
    const double c3 = c2 * cb - s2 * sb, s3 = s2 * cb + c2 * sb;
    const double c4 = c3 * cb - s3 * sb, s4 = s3 * cb + c3 * sb;
    v128_t v_cm = wasm_f32x4_make(static_cast<float>(c1), static_cast<float>(c2), static_cast<float>(c3), static_cast<float>(c4));
    v128_t v_sm = wasm_f32x4_make(static_cast<float>(s1), static_cast<float>(s2), static_cast<float>(s3), static_cast<float>(s4));
    const v128_t v_c4 = wasm_f32x4_splat(static_cast<float>(c4));
    const v128_t v_s4 = wasm_f32x4_splat(static_cast<float>(s4));
    for (int idx = 0;;) {
      wasm_v128_store(cm_f32 + idx, v_cm);
      wasm_v128_store(sm_f32 + idx, v_sm);
      idx += 4;
      if (idx >= max_m) break;
      const v128_t ncm = wasm_f32x4_sub(wasm_f32x4_mul(v_cm, v_c4), wasm_f32x4_mul(v_sm, v_s4));
      v_sm = wasm_f32x4_add(wasm_f32x4_mul(v_sm, v_c4), wasm_f32x4_mul(v_cm, v_s4));
      v_cm = ncm;
    }
  } else if (start_m >= 4 && (start_m & 3) == 0) {
    if (start_m < max_m) {
      const v128_t v_c4 = wasm_f32x4_splat(cm_f32[3]);
      const v128_t v_s4 = wasm_f32x4_splat(sm_f32[3]);
      v128_t v_cm = wasm_v128_load(cm_f32 + start_m - 4);
      v128_t v_sm = wasm_v128_load(sm_f32 + start_m - 4);
      for (int idx = start_m; idx < max_m; idx += 4) {
        const v128_t ncm = wasm_f32x4_sub(wasm_f32x4_mul(v_cm, v_c4), wasm_f32x4_mul(v_sm, v_s4));
        v_sm = wasm_f32x4_add(wasm_f32x4_mul(v_sm, v_c4), wasm_f32x4_mul(v_cm, v_s4));
        v_cm = ncm;
        wasm_v128_store(cm_f32 + idx, v_cm);
        wasm_v128_store(sm_f32 + idx, v_sm);
      }
    }
  } else {
    double cmq = cm_last, smq = sm_last;
    for (int q = start_m + 1; q <= max_m; ++q) {
      const double ncm = cmq * cb - smq * sb;
      smq = smq * cb + cmq * sb;
      cmq = ncm;
      cm_f32[q - 1] = static_cast<float>(cmq);
      sm_f32[q - 1] = static_cast<float>(smq);
    }
    const int pad_lim = (max_m + 3) & ~3;
    for (int q = max_m; q < pad_lim; ++q) cm_f32[q] = sm_f32[q] = 0.0f;
  }
#else
  double cu_w = 1.0, su_w = 0.0;
  for (int w = 1; w <= max_aw; ++w) {
    const double ncu = cu_w * cu1 - su_w * su1;
    su_w = su_w * cu1 + cu_w * su1;
    cu_w = ncu;
    const float c_w0 = static_cast<float>(cu_w), s_w0 = static_cast<float>(su_w);
    const float cc = c_w0 * cMf, ss = s_w0 * sMf, sc_ = s_w0 * cMf, cs = c_w0 * sMf;
    const float c_wm = cc + ss, s_wm = sc_ - cs, c_wp = cc - ss, s_wp = sc_ + cs;
    cswq_c[0 * 40 + 20 + w] = c_w0; cswq_s[0 * 40 + 20 + w] = s_w0;
    cswq_c[0 * 40 + 20 - w] = c_w0; cswq_s[0 * 40 + 20 - w] = -s_w0;
    cswq_c[1 * 40 + 20 + w] = c_wm; cswq_s[1 * 40 + 20 + w] = s_wm;
    cswq_c[1 * 40 + 20 - w] = c_wp; cswq_s[1 * 40 + 20 - w] = -s_wp;
    cswq_c[2 * 40 + 20 + w] = c_wp; cswq_s[2 * 40 + 20 + w] = s_wp;
    cswq_c[2 * 40 + 20 - w] = c_wm; cswq_s[2 * 40 + 20 - w] = -s_wm;
  }
  double cmq = has_ext_cm ? cm_last : 1.0;
  double smq = has_ext_cm ? sm_last : 0.0;
  for (int q = start_m + 1; q <= max_m; ++q) {
    const double ncm = cmq * cb - smq * sb;
    smq = smq * cb + cmq * sb;
    cmq = ncm;
    cm_f32[q - 1] = static_cast<float>(cmq);
    sm_f32[q - 1] = static_cast<float>(smq);
  }
  for (int q = max_m; q < 4; ++q) cm_f32[q] = sm_f32[q] = 0.0f;
#endif
}

#ifdef __wasm_simd128__
[[gnu::always_inline]] inline void sp_eval_simd_kernel(const SpEvalCache& sc, float de_f32, double out6[6]) {
  auto hsum_f32x4 = [](v128_t v) -> double {
    const v128_t d = wasm_f64x2_add(wasm_f64x2_promote_low_f32x4(v),
                                    wasm_f64x2_promote_low_f32x4(wasm_i64x2_shuffle(v, v, 1, 0)));
    return wasm_f64x2_extract_lane(d, 0) + wasm_f64x2_extract_lane(d, 1);
  };
  const float* const cswq_c = sc.cswq_c;
  const float* const cswq_s = sc.cswq_s;
  const float* const cm_f32 = sp_trig_cm();
  const float* const sm_f32 = sp_trig_sm();
  const v128_t* const vcm_base = reinterpret_cast<const v128_t*>(cm_f32);
  const v128_t* const vsm_base = reinterpret_cast<const v128_t*>(sm_f32);
  const v128_t* const vmseq_base = reinterpret_cast<const v128_t*>(kSpMSeq);
  const v128_t v_de = wasm_f32x4_splat(de_f32);
  v128_t vg_w = wasm_f32x4_splat(0.0f);
  v128_t vg_q = wasm_f32x4_splat(0.0f);
  v128_t vg_midS = wasm_f32x4_splat(0.0f), vg_sE = wasm_f32x4_splat(0.0f);
  v128_t vg_sI = wasm_f32x4_splat(0.0f),   vg_sL = wasm_f32x4_splat(0.0f);

  int bi = 0;
  const int nrows = sc.n_rows;
  const int nblks = sc.total_blks;
  const v128_t* vhot = reinterpret_cast<const v128_t*>(sc.blk_hot);

  for (int ri = 0; ri < nrows; ++ri) {
    const SpRow& row = sc.rows[ri];
    const int bend = row.blk_end;
    const uint8_t wq0 = row.wq0;
    const v128_t cw = wasm_v128_load32_splat(cswq_c + wq0);
    const v128_t sw = wasm_v128_load32_splat(cswq_s + wq0);
    const v128_t* pcm = vcm_base + row.c_start;
    const v128_t* psm = vsm_base + row.c_start;
    const v128_t* pmf = vmseq_base + row.c_start;
    v128_t vr_idS = wasm_f32x4_splat(0.0f);
    for (; bi < bend; ++bi, vhot += 8, ++pcm, ++psm, ++pmf) {
      const v128_t cm_ = *pcm, sm_ = *psm;
      const v128_t cp_ = wasm_f32x4_sub(wasm_f32x4_mul(cw, cm_), wasm_f32x4_mul(sw, sm_));
      const v128_t sp_ = wasm_f32x4_add(wasm_f32x4_mul(sw, cm_), wasm_f32x4_mul(cw, sm_));
      const v128_t ec_ = vhot[0], es_ = vhot[1];
      const v128_t uc_ = wasm_f32x4_add(vhot[2], wasm_f32x4_mul(ec_, v_de));
      const v128_t us_ = wasm_f32x4_add(vhot[3], wasm_f32x4_mul(es_, v_de));
      const v128_t idS_ = wasm_f32x4_add(wasm_f32x4_mul(uc_, cp_), wasm_f32x4_mul(us_, sp_));
      vr_idS = wasm_f32x4_add(vr_idS, idS_);
      vg_midS = wasm_f32x4_add(vg_midS, wasm_f32x4_mul(*pmf, idS_));
      vg_sE = wasm_f32x4_add(vg_sE, wasm_f32x4_sub(wasm_f32x4_mul(ec_, sp_), wasm_f32x4_mul(es_, cp_)));
      vg_sI = wasm_f32x4_add(vg_sI, wasm_f32x4_sub(wasm_f32x4_mul(vhot[4], sp_), wasm_f32x4_mul(vhot[5], cp_)));
      vg_sL = wasm_f32x4_add(vg_sL, wasm_f32x4_sub(wasm_f32x4_mul(vhot[6], sp_), wasm_f32x4_mul(vhot[7], cp_)));
    }
    vg_w = wasm_f32x4_add(vg_w, wasm_f32x4_mul(wasm_v128_load32_splat(&row.wf), vr_idS));
    vg_q = wasm_f32x4_add(vg_q, wasm_f32x4_mul(wasm_v128_load32_splat(&row.qf), vr_idS));
  }

  for (; bi < nblks; ++bi, vhot += 8) {
    const int lo = bi * 4;
    const uint8_t* wqp = sc.blk_wq + lo;
    const uint8_t* mp = sc.blk_mlane + lo;
    const v128_t v_cwj = wasm_f32x4_make(cswq_c[wqp[0]], cswq_c[wqp[1]], cswq_c[wqp[2]], cswq_c[wqp[3]]);
    const v128_t v_swj = wasm_f32x4_make(cswq_s[wqp[0]], cswq_s[wqp[1]], cswq_s[wqp[2]], cswq_s[wqp[3]]);
    const v128_t v_cm  = wasm_f32x4_make(cm_f32[mp[0]],  cm_f32[mp[1]],  cm_f32[mp[2]],  cm_f32[mp[3]]);
    const v128_t v_sm  = wasm_f32x4_make(sm_f32[mp[0]],  sm_f32[mp[1]],  sm_f32[mp[2]],  sm_f32[mp[3]]);
    const v128_t v_cp = wasm_f32x4_sub(wasm_f32x4_mul(v_cwj, v_cm), wasm_f32x4_mul(v_swj, v_sm));
    const v128_t v_sp = wasm_f32x4_add(wasm_f32x4_mul(v_swj, v_cm), wasm_f32x4_mul(v_cwj, v_sm));
    const v128_t v_ec = vhot[0], v_es = vhot[1];
    const v128_t v_uc = wasm_f32x4_add(vhot[2], wasm_f32x4_mul(v_ec, v_de));
    const v128_t v_us = wasm_f32x4_add(vhot[3], wasm_f32x4_mul(v_es, v_de));
    const v128_t v_idS = wasm_f32x4_add(wasm_f32x4_mul(v_uc, v_cp), wasm_f32x4_mul(v_us, v_sp));
    vg_w = wasm_f32x4_add(vg_w, wasm_f32x4_mul(wasm_v128_load(sc.blk_w + lo), v_idS));
    vg_q = wasm_f32x4_add(vg_q, wasm_f32x4_mul(wasm_v128_load(sc.blk_q + lo), v_idS));
    vg_midS = wasm_f32x4_add(vg_midS, wasm_f32x4_mul(wasm_v128_load(sc.blk_mf + lo), v_idS));
    vg_sE = wasm_f32x4_add(vg_sE, wasm_f32x4_sub(wasm_f32x4_mul(v_ec, v_sp), wasm_f32x4_mul(v_es, v_cp)));
    vg_sI = wasm_f32x4_add(vg_sI, wasm_f32x4_sub(wasm_f32x4_mul(vhot[4], v_sp), wasm_f32x4_mul(vhot[5], v_cp)));
    vg_sL = wasm_f32x4_add(vg_sL, wasm_f32x4_sub(wasm_f32x4_mul(vhot[6], v_sp), wasm_f32x4_mul(vhot[7], v_cp)));
  }
  out6[0] = hsum_f32x4(vg_w);
  out6[1] = hsum_f32x4(vg_q);
  out6[2] = hsum_f32x4(vg_midS);
  out6[3] = hsum_f32x4(vg_sE);
  out6[4] = hsum_f32x4(vg_sI);
  out6[5] = hsum_f32x4(vg_sL);
}
#endif

[[gnu::noinline]] inline void sp_six_with_deriv(
    const SpCombCoef* F, int count, double a0, double e0, double t, const Kepler& kp, double n, double eta,
    double si, double ci, double ci_build, double theta_g0, double* six, double* dsix_dlam, double* d2six_dlam2,
    const double* sb_in = nullptr, const double* cb_in = nullptr,
    float* cm_f32_io = nullptr, float* sm_f32_io = nullptr, int cm_in_count = 0,
    double cm_last = 1.0, double sm_last = 0.0,
    const double* su1_in = nullptr, const double* cu1_in = nullptr,
    const double* sM1_in = nullptr, const double* cM1_in = nullptr) {
  if (count <= 0) return;
  const double a = kp.a, e = kp.e < 1e-12 ? 1e-12 : kp.e;
  const double sin_i = std::fabs(si) < 1e-12 ? (si < 0.0 ? -1e-12 : 1e-12) : si;
#ifdef __wasm_simd128__
  const v128_t v_one_d = wasm_f64x2_splat(1.0);
  const v128_t v_r0 = wasm_f64x2_div(v_one_d, wasm_f64x2_make(a, 1.0 + eta));
  const double ia = wasm_f64x2_extract_lane(v_r0, 0);
  const double inv_1peta = wasm_f64x2_extract_lane(v_r0, 1);
#else
  const double ia = 1.0 / a;
  const double inv_1peta = 1.0 / (1.0 + eta);
#endif
  uint32_t tag = static_cast<uint8_t>(F[0].pad);
  if (count >= 4) {
    tag |= (static_cast<uint32_t>(static_cast<uint8_t>(F[1].pad)) << 8) |
           (static_cast<uint32_t>(static_cast<uint8_t>(F[2].pad)) << 16) |
           (static_cast<uint32_t>(static_cast<uint8_t>(F[3].pad)) << 24);
  } else {
    for (int k = 1; k < count; ++k) tag |= static_cast<uint32_t>(static_cast<uint8_t>(F[k].pad)) << (8 * k);
  }
  SpSetSlot* const slot = g_sp_set_slot;
  SpEvalCache* scp = (slot != nullptr && slot->cache != nullptr) ? slot->cache : &sp_thread_cache();
  if (__builtin_expect(t == 0.0 || !sp_matches(*scp, F, count, tag, a0, e0), 0)) {
    SpEvalCache& th = sp_thread_cache();
    if (!sp_init_or_fallback(th, F, count, tag, a0, e0, t, kp, a, e, n, eta, sin_i, ci, ia, ci_build,
                             theta_g0, sb_in, cb_in, su1_in, cu1_in, sM1_in, cM1_in, six, dsix_dlam, d2six_dlam2)) {
      return;
    }
    scp = sp_claim(slot, th, F, count, tag, a0, e0);
  }
  SpEvalCache& sc = *scp;
  if (!sp_keys_hold(sc, t, true)) sp_sync(sc, a0, e0, a, e, ci, t, true);
  double sb, cb, su1, cu1, sM1, cM1;
  if (sb_in != nullptr && cb_in != nullptr && su1_in != nullptr && cu1_in != nullptr && sM1_in != nullptr && cM1_in != nullptr) {
    sb = *sb_in; cb = *cb_in;
    su1 = *su1_in; cu1 = *cu1_in;
    sM1 = *sM1_in; cM1 = *cM1_in;
  } else {
    if (sb_in != nullptr && cb_in != nullptr) { sb = *sb_in; cb = *cb_in; }
    else fm::sincos_fast(kp.node - (theta_g0 + kOmegaE * t), sb, cb);
#ifdef __wasm_simd128__
    if (su1_in == nullptr && cu1_in == nullptr && sM1_in == nullptr && cM1_in == nullptr) {
      v128_t vs2, vc2;
      fm::sincos2_f64x2(wasm_f64x2_make(kp.argp + kp.m, kp.m), vs2, vc2);
      su1 = wasm_f64x2_extract_lane(vs2, 0); cu1 = wasm_f64x2_extract_lane(vc2, 0);
      sM1 = wasm_f64x2_extract_lane(vs2, 1); cM1 = wasm_f64x2_extract_lane(vc2, 1);
    } else
#endif
    {
      if (su1_in != nullptr && cu1_in != nullptr) { su1 = *su1_in; cu1 = *cu1_in; }
      else fm::sincos_fast(kp.argp + kp.m, su1, cu1);
      if (sM1_in != nullptr && cM1_in != nullptr) { sM1 = *sM1_in; cM1 = *cM1_in; }
      else fm::sincos_fast(kp.m, sM1, cM1);
    }
  }
  float* const cm_f32 = cm_f32_io != nullptr ? cm_f32_io : sp_trig_cm();
  float* const sm_f32 = sm_f32_io != nullptr ? sm_f32_io : sp_trig_sm();
  sp_fill_trig(sc, cb, sb, cu1, su1, cM1, sM1, cm_f32, sm_f32,
               cm_f32_io != nullptr ? cm_in_count : 0, cm_last, sm_last, cm_f32_io != nullptr);
  const float de_f32 = static_cast<float>(e - sc.e_bake);
  const double eta_m1 = -(kp.e * kp.e) * inv_1peta;
  const double ci_p0 = (ci >= 0.0 ? -(si * si) / (1.0 + ci) : (ci - 1.0)) + 1.0;
#ifdef __wasm_simd128__
  if (__builtin_expect(dsix_dlam == nullptr && d2six_dlam2 == nullptr && cm_f32_io == nullptr, 0)) {
    double out6[6];
    sp_eval_simd_kernel(sc, de_f32, out6);
    const double sum_w = out6[0], sum_q = out6[1], sum_m = out6[2];
    const double sE = out6[3], sI = out6[4], sL = out6[5];
    const double na2 = n * a * a;
    const double inv_1pci = 1.0 / (1.0 + ci), inv_sini = 1.0 / sin_i;
    const double inv_na2e = 1.0 / (na2 * e), inv_na2eta = 1.0 / (na2 * eta);
    const double sM = sum_w + sum_q;
    const double s1_num = eta * sum_q + eta_m1 * sum_w;
    const double s2_num = ci_p0 * sum_w - sum_m;
    const double tanhalf = sin_i * inv_1pci;
    const double sI_na2eta = sI * inv_na2eta;
    const double eta_sE_na2 = ((eta * eta) * inv_na2eta) * sE;
    six[0] += -3.0 * ia * ia * sM;
    six[1] += (eta * s1_num) * inv_na2e;
    six[2] += (s2_num * inv_na2eta) * inv_sini;
    six[3] += eta_sE_na2 + (e * tanhalf) * sI_na2eta;
    six[4] += sI_na2eta;
    six[5] += sL + (e * inv_1peta) * eta_sE_na2 + tanhalf * sI_na2eta;
    return;
  }
#endif
  sp_six_deriv(sc, de_f32, a, e, n, eta, eta_m1, ci_p0, sin_i, ci, ia, inv_1peta,
               sc.cswq_c, sc.cswq_s, cm_f32, sm_f32, six, dsix_dlam, d2six_dlam2);
}

/// The displacements in the six-component set (n, e, i, e varpi, sin i Omega, lambda), value-only hot path.
[[gnu::noinline]] inline void sp_six_val(
    const SpCombCoef* F, int count, double a0, double e0, double t, double kp_a, double kp_e, double n, double eta,
    double si, double ci, double ci_build, double* six,
    double sb, double cb, double su1, double cu1, double sM1, double cM1,
    int cm_in_count, double cm_last, double sm_last, bool has_ext_cm) {
  if (count <= 0) return;
  const double a = kp_a, e = kp_e < 1e-12 ? 1e-12 : kp_e;
  const double sin_i = std::fabs(si) < 1e-12 ? (si < 0.0 ? -1e-12 : 1e-12) : si;
#ifdef __wasm_simd128__
  const v128_t v_one_d = wasm_f64x2_splat(1.0);
  const v128_t v_r0 = wasm_f64x2_div(v_one_d, wasm_f64x2_make(a, 1.0 + eta));
  const double ia = wasm_f64x2_extract_lane(v_r0, 0);
  const double inv_1peta = wasm_f64x2_extract_lane(v_r0, 1);
#else
  const double ia = 1.0 / a;
  const double inv_1peta = 1.0 / (1.0 + eta);
#endif
  uint32_t tag = static_cast<uint8_t>(F[0].pad);
  if (__builtin_expect(count >= 4, 1)) {
    tag |= (static_cast<uint32_t>(static_cast<uint8_t>(F[1].pad)) << 8) |
           (static_cast<uint32_t>(static_cast<uint8_t>(F[2].pad)) << 16) |
           (static_cast<uint32_t>(static_cast<uint8_t>(F[3].pad)) << 24);
  } else {
    if (count >= 2) tag |= static_cast<uint32_t>(static_cast<uint8_t>(F[1].pad)) << 8;
    if (count == 3) tag |= static_cast<uint32_t>(static_cast<uint8_t>(F[2].pad)) << 16;
  }
  SpSetSlot* const slot = g_sp_set_slot;
  SpEvalCache* scp = (slot != nullptr && slot->cache != nullptr) ? slot->cache : &sp_thread_cache();
  if (__builtin_expect(t == 0.0 || !sp_matches(*scp, F, count, tag, a0, e0), 0)) {
    SpEvalCache& th = sp_thread_cache();
    if (!sp_init_or_fallback_val(th, F, count, tag, a0, e0, t, a, e, n, eta, sin_i, ci, ia, ci_build,
                                 sb, cb, su1, cu1, sM1, cM1, six)) {
      return;
    }
    scp = sp_claim(slot, th, F, count, tag, a0, e0);
  }
  SpEvalCache& sc = *scp;
  if (!sp_keys_hold(sc, t, false)) sp_sync(sc, a0, e0, a, e, ci, t, false);

  float* const cm_f32 = sp_trig_cm();
  float* const sm_f32 = sp_trig_sm();
  sp_fill_trig(sc, cb, sb, cu1, su1, cM1, sM1, cm_f32, sm_f32,
               has_ext_cm ? cm_in_count : 0, cm_last, sm_last, has_ext_cm);
  const float de_f32 = static_cast<float>(e - sc.e_bake);

#ifdef __wasm_simd128__
  double out6[6];
  sp_eval_simd_kernel(sc, de_f32, out6);
  const double sum_w = out6[0], sum_q = out6[1], sum_m = out6[2];
  const double sE = out6[3], sI = out6[4], sL = out6[5];
  const double na2 = n * a * a;
  const v128_t v_r1 = wasm_f64x2_div(v_one_d, wasm_f64x2_make(1.0 + ci, sin_i));
  const v128_t v_r2 = wasm_f64x2_div(v_one_d, wasm_f64x2_make(na2 * e, na2 * eta));
  const double inv_1pci = wasm_f64x2_extract_lane(v_r1, 0);
  const double inv_sini = wasm_f64x2_extract_lane(v_r1, 1);
  const double inv_na2e = wasm_f64x2_extract_lane(v_r2, 0);
  const double inv_na2eta = wasm_f64x2_extract_lane(v_r2, 1);
  const double eta_m1 = -(kp_e * kp_e) * inv_1peta;
  const double ci_p0 = (ci >= 0.0 ? -(si * si) * inv_1pci : (ci - 1.0)) + 1.0;
  const double sM = sum_w + sum_q;
  const double s1_num = eta * sum_q + eta_m1 * sum_w;
  const double s2_num = ci_p0 * sum_w - sum_m;
  const double tanhalf = sin_i * inv_1pci;
  const double sI_na2eta = sI * inv_na2eta;
  const double eta_sE_na2 = ((eta * eta) * inv_na2eta) * sE;
  six[0] += -3.0 * ia * ia * sM;
  six[1] += (eta * s1_num) * inv_na2e;
  six[2] += (s2_num * inv_na2eta) * inv_sini;
  six[3] += eta_sE_na2 + (e * tanhalf) * sI_na2eta;
  six[4] += sI_na2eta;
  six[5] += sL + (e * inv_1peta) * eta_sE_na2 + tanhalf * sI_na2eta;
#else
  const float* const cswq_c = sc.cswq_c;
  const float* const cswq_s = sc.cswq_s;
  const int nblks = sc.total_blks;
  double sM = 0.0, s1_num = 0.0, s2_num = 0.0, sE = 0.0, sI = 0.0, sL = 0.0;
  const double eta_m1 = -(kp_e * kp_e) * inv_1peta;
  const double ci_p0 = (ci >= 0.0 ? -(si * si) / (1.0 + ci) : (ci - 1.0)) + 1.0;
  double sum_w = 0.0, sum_q = 0.0, midS = 0.0;
  const float* pec = sc.blk_hot;
  const float* pu = pec + 8;
  const float* pe = sc.blk_e;
  for (int bi = 0; bi < nblks; ++bi, pec += 32, pu += 32, pe += 16) {
    const int lane_off = bi * 4;
    for (int l = 0; l < 4; ++l) {
      if (sc.blk_active[lane_off + l] == 0u) continue;
      const int m_idx = sc.blk_mlane[lane_off + l];
      const int wq_idx = sc.blk_wq[lane_off + l];
      const float cmv = cm_f32[m_idx], smv = sm_f32[m_idx];
      const float cs0 = cswq_c[wq_idx], cs1 = cswq_s[wq_idx];
      const float cp = cs0 * cmv - cs1 * smv;
      const float sp = cs1 * cmv + cs0 * smv;
      const float ec = pec[0 + l], es = pec[4 + l];
      const float idS = (pu[0 + l] + ec * de_f32) * cp + (pu[4 + l] + es * de_f32) * sp;
      sum_w += static_cast<double>(sc.blk_w[lane_off + l]) * idS;
      sum_q += static_cast<double>(sc.blk_q[lane_off + l]) * idS;
      midS += static_cast<double>(sc.blk_mf[lane_off + l]) * idS;
      sE += ec * sp - es * cp;
      sI += (pu[8 + l] + pe[0 + l] * de_f32) * sp - (pu[12 + l] + pe[4 + l] * de_f32) * cp;
      sL += (pu[16 + l] + pe[8 + l] * de_f32) * sp - (pu[20 + l] + pe[12 + l] * de_f32) * cp;
    }
  }
  sM = sum_w + sum_q;
  s1_num = eta * sum_q + eta_m1 * sum_w;
  s2_num = ci_p0 * sum_w - midS;
  const double na2 = n * a * a;
  const double tanhalf = sin_i / (1.0 + ci);
  six[0] += -3.0 * ia * ia * sM;
  six[1] += (eta * s1_num) / (na2 * e);
  six[2] += s2_num / (na2 * eta * sin_i);
  six[3] += (eta / na2) * sE + e * tanhalf / (na2 * eta) * sI;
  six[4] += sI / (na2 * eta);
  six[5] += sL + (eta * e / (na2 * (1.0 + eta))) * sE + (tanhalf / (na2 * eta)) * sI;
#endif
}

inline void sp_six(const SpCoef* F, int count, double t, const Kepler& kp, double n, double eta, double si, double ci,
                   double theta_g0, double* six) {
  const double a = kp.a, e = kp.e < 1e-12 ? 1e-12 : kp.e;
  const double sin_i = std::fabs(si) < 1e-12 ? (si < 0.0 ? -1e-12 : 1e-12) : si;
  const double p_sl = a * eta * eta, j2 = 1.5 * kJ2 / (p_sl * p_sl);
  const double node_rate = -j2 * n * ci, wdot = 0.5 * j2 * n * (5.0 * ci * ci - 1.0);
  const double mdot = n + 0.5 * j2 * n * eta * (3.0 * ci * ci - 1.0);
  double sb, cb, sw1, cw1, sM1, cM1;
  fm::sincos(kp.node - (theta_g0 + kOmegaE * t), sb, cb);
  fm::sincos(kp.argp, sw1, cw1);
  fm::sincos(kp.m, sM1, cM1);
  double cm[72], sm[72], cw[72], swv[72], cj[72], sj[72];
  cm[0] = cw[0] = cj[0] = 1.0;
  sm[0] = swv[0] = sj[0] = 0.0;
  for (int q = 1; q <= 71; ++q) {  // a table to degree 70 (the low table's fast side): m, |w| and |j| to 71
    cm[q] = cm[q - 1] * cb - sm[q - 1] * sb;
    sm[q] = sm[q - 1] * cb + cm[q - 1] * sb;
    cw[q] = cw[q - 1] * cw1 - swv[q - 1] * sw1;
    swv[q] = swv[q - 1] * cw1 + cw[q - 1] * sw1;
    cj[q] = cj[q - 1] * cM1 - sj[q - 1] * sM1;
    sj[q] = sj[q - 1] * cM1 + cj[q - 1] * sM1;
  }
  const double ia = 1.0 / a;
  double amp[72];
  amp[0] = kMu * ia;
  for (int l = 1; l <= 70; ++l) amp[l] = amp[l - 1] * ia;
  double sM = 0, sW = 0, sO = 0, sE = 0, sI = 0, sA = 0, sL = 0;
  for (int idx = 0; idx < count; ++idx) {
    const SpCoef& f = F[idx];
    const int l = f.l, m = f.m, w = f.w, j = f.j;
    const double psidot = w * wdot + j * mdot + m * (node_rate - kOmegaE);
    const int aw = w < 0 ? -w : w, aj = j < 0 ? -j : j;
    const double cww = cw[aw], sww = w < 0 ? -swv[aw] : swv[aw];
    const double cjj = cj[aj], sjj = j < 0 ? -sj[aj] : sj[aj];
    const double c1 = cww * cjj - sww * sjj, s1 = sww * cjj + cww * sjj;
    const double cp = c1 * cm[m] - s1 * sm[m], sp = s1 * cm[m] + c1 * sm[m];
    const double C = kEgmC[l][m], S0 = kEgmS[l][m];
    const bool odd = ((l - m) & 1) != 0;
    const double Sv = odd ? -S0 * cp + C * sp : C * cp + S0 * sp;
    const double dS = odd ? S0 * sp + C * cp : -C * sp + S0 * cp;
    const double iS = -dS / psidot, idS = Sv / psidot;
    const double G = f.g0 + f.g1 * e, dG = f.g1;
    const double A = amp[l];
    const double AfgidS = A * f.f * G * idS;
    sM += j * AfgidS;
    sW += w * AfgidS;
    sO += m * AfgidS;
    sE += A * f.f * dG * iS;
    sI += A * f.df * G * iS;
    sA += -(l + 1) * A * f.f * G * iS * ia;
    sL += j * A * f.f * G * dS / (psidot * psidot);
  }
  const double na2 = n * a * a;
  const double tanhalf = sin_i / (1.0 + ci);
  six[0] += -3.0 * ia * ia * sM;
  six[1] += (eta * eta * sM - eta * sW) / (na2 * e);
  six[2] += (ci * sW - sO) / (na2 * eta * sin_i);
  six[3] += (eta / na2) * sE + e * tanhalf / (na2 * eta) * sI;
  six[4] += sI / (na2 * eta);
  six[5] += -(2.0 / (n * a)) * sA + (eta * e / (na2 * (1.0 + eta))) * sE + (tanhalf / (na2 * eta)) * sI + 3.0 * ia * ia * sL;
}


/// A class's resonant tail in the rates. Half-day (cls 2): every even order m, k = m/2, degree 6..31. One-day (cls 1,
/// stack #434): every order m from 1 to kOneDayTailMaxOrder, k = m, degree 5..31. Normalized F cubic about the epoch
/// inclination; G cubic about the epoch eccentricity; a by its ratio to the epoch's.
struct HalfDayCoef {
  int8_t m, w, k, pad;
  float uc0, uce, ucee, uceee, uci, ucii, uciii, ucei, uceei, uceii, uca, ucaa, ucae, uceea, uceeea, ucai;
  float us0, use, usee, useee, usi, usii, usiii, usei, useei, useii, usa, usaa, usae, useea, useeea, usai;
};
struct HalfDayRawTerm {
  int8_t l, m, p, k;
  double f, df, ddf, dddf;
};
struct HalfDayScratch {
  double* grid = nullptr;
  size_t grid_cap = 0;
  double* values = nullptr;
  size_t values_cap = 0;
  HalfDayRawTerm* raw = nullptr;
  size_t raw_cap = 0;
};
inline thread_local HalfDayScratch g_half_day_scratch{};
inline int half_day_bound(int degree, int cls = 2) {
  return (cls == 1 ? degree + 1 : degree / 2 + 1) * (2 * degree + 1);
}
inline int half_day_terms(int degree, double i0, double e0, HalfDayCoef* out, double a0 = 1.0, int cls = 2) {
  const bool one_day = cls == 1;
  const int l_lo = one_day ? 5 : 6, m_lo = one_day ? 1 : 2, m_step = one_day ? 1 : 2;
  const int m_hi = one_day ? std::min(degree, kOneDayTailMaxOrder) : degree;
  const int k_cap = one_day ? m_hi : degree / 2;
  const EgmTables& egm = egm_tables();
  const double ia0 = 1.0 / a0;
  const double irp0 = 1.0 / (a0 * std::fmax(0.02, 1.0 - e0));
  double amp0[36], amp_rp[36];
  amp0[0] = kMu * ia0;
  amp_rp[0] = kMu * irp0;
  for (int l = 1; l <= 33; ++l) {
    amp0[l] = amp0[l - 1] * ia0;
    amp_rp[l] = amp_rp[l - 1] * irp0;
  }

  int raw_max = 0;
  for (int l = l_lo; l <= degree; ++l) raw_max += (one_day ? std::min(l, m_hi) : l / 2) * (l + 1);
  const double h = 5e-4;
  constexpr int NF = 64, NF_HALF = NF / 2;
  const int N = e0 < 0.1 ? 128 : e0 < 0.8 ? 512 : e0 < 0.95 ? 2048 : 4096;
  const int N_half = e0 < 0.05 ? 24 : (N / 2);
  const int width = 3 * (degree + 1) + 2 * (k_cap + 1);
  using RawTerm = HalfDayRawTerm;
  HalfDayScratch& sc = g_half_day_scratch;
  const size_t need_grid = static_cast<size_t>(N_half * width);
  const size_t need_vals = std::max<size_t>(5 * raw_max, 5 * 65 * 36);
  const size_t need_raw = static_cast<size_t>(raw_max > 0 ? raw_max : 1);
  if (need_grid > sc.grid_cap) {
    double* p = static_cast<double*>(sdnap::mem::realloc(sc.grid, need_grid * sizeof(double)));
    if (p == nullptr) return -1;
    sc.grid = p;
    sc.grid_cap = need_grid;
  }
  if (need_vals > sc.values_cap) {
    double* p = static_cast<double*>(sdnap::mem::realloc(sc.values, need_vals * sizeof(double)));
    if (p == nullptr) return -1;
    sc.values = p;
    sc.values_cap = need_vals;
  }
  if (need_raw > sc.raw_cap) {
    RawTerm* p = static_cast<RawTerm*>(sdnap::mem::realloc(sc.raw, need_raw * sizeof(RawTerm)));
    if (p == nullptr) return -1;
    sc.raw = p;
    sc.raw_cap = need_raw;
  }
  double* grid = sc.grid;
  double* values = sc.values;
  RawTerm* raw = sc.raw;

  double si5[5], ci5[5];
  const double incs[5] = {i0, i0 + h, i0 - h, i0 + 2.0 * h, i0 - 2.0 * h};
  for (int s = 0; s < 5; ++s) fm::sincos(incs[s], si5[s], ci5[s]);
  constexpr int J_TOP = NF_HALF / 2;
  double suN[J_TOP + 1], cuN[J_TOP + 1];
  for (int j = 0; j <= J_TOP; ++j) {
    const double u = kTwoPi * j / NF;
    fm::sincos(u, suN[j], cuN[j]);
  }
  double (*Fw)[65][36] = reinterpret_cast<double (*)[65][36]>(values);
  alignas(16) double A_p[36][2][18], B_p[36][2][18], col_p[2][18];
  double col[104], cku[36], sku[36];
  int raw_count = 0;
  int max_l_used = l_lo;
  for (int m = m_lo; m <= m_hi; m += m_step) {
    int max_l_m = 0;
    for (int l = degree; l >= std::max(l_lo, m); --l) {
      if (amp_rp[l] * egm.hypot_fb[l][m] >= 1e-19) { max_l_m = l; break; }
    }
    if (max_l_m == 0) continue;
    if (max_l_m > max_l_used) max_l_used = max_l_m;
    const int k = one_day ? m : m / 2;
    const int w_lo = e0 < 0.05 ? std::max(-max_l_m, k - 8) : -max_l_m;
    const int w_hi = e0 < 0.05 ? std::min(max_l_m, k + 8) : max_l_m;
    const int aw_max = std::max(std::abs(w_lo), std::abs(w_hi));

    LegendreOrder L;
    legendre_order(m, max_l_m, L);
    for (int s = 0; s < 5; ++s) {
      std::memset(A_p, 0, static_cast<size_t>(aw_max + 1) * sizeof(A_p[0]));
      std::memset(B_p, 0, static_cast<size_t>(aw_max + 1) * sizeof(B_p[0]));
      const double sis = si5[s], cis = ci5[s];
      for (int j = 0; j <= J_TOP; ++j) {
        const double w_j = (j == 0 || j == J_TOP) ? 0.5 : 1.0;
        const double su = suN[j], cu = cuN[j];
        const double x = sis * su, c = std::sqrt(std::fmax(0.0, 1.0 - x * x));
        legendre_column(L, x, c, col);
        const int k_top = max_l_m >> 1;
        col_p[0][k_top] = 0.0;
        col_p[1][k_top] = 0.0;
        col_p[0][k_top + 1] = 0.0;
        col_p[1][k_top + 1] = 0.0;
        for (int l = m; l <= max_l_m; ++l) col_p[l & 1][l >> 1] = col[l] * w_j;
        double sml = 0.0, cml = 1.0;
        if (c > 1e-12) {
          const double inv_c = 1.0 / c;
          complex_pow(cu * inv_c, cis * su * inv_c, m, cml, sml);
        } else {
          fm::sincos(m * std::atan2(cis * su, cu), sml, cml);
        }
        cku[0] = 1.0;
        sku[0] = 0.0;
        for (int aw = 1; aw <= aw_max; ++aw) {
          cku[aw] = cku[aw - 1] * cu - sku[aw - 1] * su;
          sku[aw] = sku[aw - 1] * cu + cku[aw - 1] * su;
        }
        for (int aw = 0; aw <= aw_max; ++aw) {
          const double ck = cku[aw], sk = sku[aw];
          // l - m odd (l = aw mod 2): the coefficient is the imaginary part. For the half-day class's even m this is aw
          // odd; the one-day class's odd m flip it
          const bool odd = ((aw + m) & 1) != 0;
          const double c1 = odd ? cml * sk : cml * ck;
          const double c2 = odd ? sml * ck : sml * sk;
          int first = std::max(l_lo, std::max(m, aw));
          if ((first - aw) & 1) ++first;
          if (first > max_l_m) continue;
          const int par = first & 1;
          const int k0 = first >> 1, k1 = (max_l_m - par) >> 1;
          double* a_row = A_p[aw][par];
          double* b_row = B_p[aw][par];
          const double* cp = col_p[par];
#ifdef __wasm_simd128__
          const v128_t vc1 = wasm_f64x2_splat(c1);
          const v128_t vc2 = wasm_f64x2_splat(c2);
          int kk = k0;
          for (; kk + 1 <= k1; kk += 2) {
            const v128_t vcp = wasm_v128_load(cp + kk);
            wasm_v128_store(a_row + kk, wasm_f64x2_add(wasm_v128_load(a_row + kk), wasm_f64x2_mul(vcp, vc1)));
            wasm_v128_store(b_row + kk, wasm_f64x2_add(wasm_v128_load(b_row + kk), wasm_f64x2_mul(vcp, vc2)));
          }
          if (kk <= k1) {
            a_row[kk] += cp[kk] * c1;
            b_row[kk] += cp[kk] * c2;
          }
#else
          for (int kk = k0; kk <= k1; ++kk) {
            a_row[kk] += cp[kk] * c1;
            b_row[kk] += cp[kk] * c2;
          }
#endif
        }
      }
      for (int aw = 0; aw <= aw_max; ++aw) {
        const bool odd = ((aw + m) & 1) != 0;
        int first = std::max(l_lo, std::max(m, aw));
        if ((first - aw) & 1) ++first;
        const int par = first & 1;
        double* dst_pos = Fw[s][aw + degree];
        double* dst_neg = Fw[s][-aw + degree];
        for (int l = first; l <= max_l_m; l += 2) {
          const int kk = l >> 1;
          const double a_val = A_p[aw][par][kk], b_val = B_p[aw][par][kk];
          dst_pos[l] = odd ? (a_val - b_val) : (a_val + b_val);
          if (aw > 0) dst_neg[l] = odd ? (-a_val - b_val) : (a_val - b_val);
        }
      }
    }
    constexpr double kTwoInvNF = 2.0 / NF_HALF;
    const double inv_12h = 1.0 / (12.0 * h), inv_12h2 = 1.0 / (12.0 * h * h), inv_2h3 = 1.0 / (2.0 * h * h * h);
    for (int w = w_lo; w <= w_hi; ++w) {
      const int aw = w < 0 ? -w : w;
      int first = std::max(l_lo, std::max(m, aw));
      if ((first - w) & 1) ++first;
      const double* f0 = Fw[0][w + degree];
      const double* fp = Fw[1][w + degree];
      const double* fm = Fw[2][w + degree];
      const double* fpp = Fw[3][w + degree];
      const double* fmm = Fw[4][w + degree];
      for (int l = first; l <= max_l_m; l += 2) {
        if (amp_rp[l] * egm.hypot_fb[l][m] < 1e-19) continue;
        const double v0 = f0[l] * kTwoInvNF, vp = fp[l] * kTwoInvNF, vm = fm[l] * kTwoInvNF;
        const double vpp = fpp[l] * kTwoInvNF, vmm = fmm[l] * kTwoInvNF;
        const int p = (l - w) / 2;
        raw[raw_count++] = RawTerm{static_cast<int8_t>(l),
                                   static_cast<int8_t>(m),
                                   static_cast<int8_t>(p),
                                   static_cast<int8_t>(k),
                                   v0,
                                   (vmm - 8.0 * vm + 8.0 * vp - vpp) * inv_12h,
                                   (-vpp + 16.0 * vp - 30.0 * v0 + 16.0 * vm - vmm) * inv_12h2,
                                   (vpp - 2.0 * vp + 2.0 * vm - vmm) * inv_2h3};
      }
    }
  }
  const double dh = std::min(5e-4, (1.0 - e0) / 4.0);
  const double inv_N = 1.0 / N_half;
  const int k_max_used = one_day ? std::min(max_l_used, m_hi) : max_l_used / 2;
  const double dE = kPi / N_half;
  double sde0, cde0, sde, cde;
  fm::sincos(0.5 * dE, sde0, cde0);
  fm::sincos(dE, sde, cde);
  const int cw_base = degree + 1;
  const int sw_base = 2 * (degree + 1);
  const int ck_base = 3 * (degree + 1);
  const int sk_base = ck_base + k_cap + 1;
  for (int off = -2; off <= 2; ++off) {
    const double e = e0 + off * dh, eta = std::sqrt(1.0 - e * e);
    double se = sde0, ce = cde0;
#ifdef __wasm_simd128__
    const v128_t v_one = wasm_f64x2_splat(1.0);
    const v128_t v_zero = wasm_f64x2_splat(0.0);
    for (int j = 0; j < N_half; j += 2) {
      const double E0 = kPi * (j + 0.5) / N_half;
      const double se0 = se, ce0 = ce;
      const double nse0 = se * cde + ce * sde;
      ce = ce * cde - se * sde;
      se = nse0;
      const double E1 = kPi * (j + 1.5) / N_half;
      const double se1 = se, ce1 = ce;
      const double nse1 = se * cde + ce * sde;
      ce = ce * cde - se * sde;
      se = nse1;
      const double ir0 = 1.0 / (1.0 - e * ce0), ir1 = 1.0 / (1.0 - e * ce1);
      const double cn0 = (ce0 - e) * ir0, sn0 = eta * se0 * ir0;
      const double cn1 = (ce1 - e) * ir1, sn1 = eta * se1 * ir1;
      double sm0, cm0, sm1, cm1;
      fm::sincos(E0 - e * se0, sm0, cm0);
      fm::sincos(E1 - e * se1, sm1, cm1);
      const v128_t v_ir = wasm_f64x2_make(ir0, ir1);
      const v128_t v_cn = wasm_f64x2_make(cn0, cn1);
      const v128_t v_sn = wasm_f64x2_make(sn0, sn1);
      const v128_t v_cm = wasm_f64x2_make(cm0, cm1);
      const v128_t v_sm = wasm_f64x2_make(sm0, sm1);
      v128_t vr = v_one, vcw = v_one, vsw = v_zero;
      wasm_v128_store(grid + cw_base * N_half + j, vcw);
      wasm_v128_store(grid + sw_base * N_half + j, vsw);
      for (int l = 1; l <= max_l_used; ++l) {
        vr = wasm_f64x2_mul(vr, v_ir);
        const v128_t ncw = wasm_f64x2_sub(wasm_f64x2_mul(vcw, v_cn), wasm_f64x2_mul(vsw, v_sn));
        vsw = wasm_f64x2_add(wasm_f64x2_mul(vsw, v_cn), wasm_f64x2_mul(vcw, v_sn));
        vcw = ncw;
        wasm_v128_store(grid + l * N_half + j, vr);
        wasm_v128_store(grid + (cw_base + l) * N_half + j, vcw);
        wasm_v128_store(grid + (sw_base + l) * N_half + j, vsw);
      }
      v128_t vck = v_one, vsk = v_zero;
      wasm_v128_store(grid + ck_base * N_half + j, vck);
      wasm_v128_store(grid + sk_base * N_half + j, vsk);
      for (int kv = 1; kv <= k_max_used; ++kv) {
        const v128_t nck = wasm_f64x2_sub(wasm_f64x2_mul(vck, v_cm), wasm_f64x2_mul(vsk, v_sm));
        vsk = wasm_f64x2_add(wasm_f64x2_mul(vsk, v_cm), wasm_f64x2_mul(vck, v_sm));
        vck = nck;
        wasm_v128_store(grid + (ck_base + kv) * N_half + j, vck);
        wasm_v128_store(grid + (sk_base + kv) * N_half + j, vsk);
      }
    }
    double* ang = grid;  // r[0] slot is unused (all raw terms have l >= 5)
    double* val_row = values + (off + 2) * raw_count;
    int q = 0;
    while (q < raw_count) {
      const int m = raw[q].m, w = raw[q].l - 2 * raw[q].p, k = raw[q].k, aw = w < 0 ? -w : w;
      int q_end = q + 1;
      while (q_end < raw_count && raw[q_end].m == m && (raw[q_end].l - 2 * raw[q_end].p) == w) ++q_end;
      const int n_l = q_end - q;
      const double* cw_p = grid + (cw_base + aw) * N_half;
      const double* sw_p = grid + (sw_base + aw) * N_half;
      const double* ck_p = grid + (ck_base + k) * N_half;
      const double* sk_p = grid + (sk_base + k) * N_half;
      if (w < 0) {
        for (int j = 0; j < N_half; j += 2) {
          wasm_v128_store(ang + j, wasm_f64x2_sub(wasm_f64x2_mul(wasm_v128_load(cw_p + j), wasm_v128_load(ck_p + j)),
                                                  wasm_f64x2_mul(wasm_v128_load(sw_p + j), wasm_v128_load(sk_p + j))));
        }
      } else {
        for (int j = 0; j < N_half; j += 2) {
          wasm_v128_store(ang + j, wasm_f64x2_add(wasm_f64x2_mul(wasm_v128_load(cw_p + j), wasm_v128_load(ck_p + j)),
                                                  wasm_f64x2_mul(wasm_v128_load(sw_p + j), wasm_v128_load(sk_p + j))));
        }
      }
      for (int idx = 0; idx < n_l; ++idx) {
        const double* rl = grid + raw[q + idx].l * N_half;
        v128_t acc0 = v_zero, acc1 = v_zero;
        int j = 0;
        for (; j + 3 < N_half; j += 4) {
          acc0 = wasm_f64x2_add(acc0, wasm_f64x2_mul(wasm_v128_load(rl + j), wasm_v128_load(ang + j)));
          acc1 = wasm_f64x2_add(acc1, wasm_f64x2_mul(wasm_v128_load(rl + j + 2), wasm_v128_load(ang + j + 2)));
        }
        for (; j < N_half; j += 2) {
          acc0 = wasm_f64x2_add(acc0, wasm_f64x2_mul(wasm_v128_load(rl + j), wasm_v128_load(ang + j)));
        }
        const v128_t acc = wasm_f64x2_add(acc0, acc1);
        val_row[q + idx] = (wasm_f64x2_extract_lane(acc, 0) + wasm_f64x2_extract_lane(acc, 1)) * inv_N;
      }
      q = q_end;
    }
#else
    for (int j = 0; j < N_half; ++j) {
      const double E = kPi * (j + 0.5) / N_half;
      const double se_j = se, ce_j = ce;
      const double nse = se * cde + ce * sde;
      ce = ce * cde - se * sde;
      se = nse;
      const double ir = 1.0 / (1.0 - e * ce_j), M = E - e * se_j;
      const double cn = (ce_j - e) * ir, sn = eta * se_j * ir;
      double sm, cm;
      fm::sincos(M, sm, cm);
      grid[(cw_base + 0) * N_half + j] = 1.0;
      grid[(sw_base + 0) * N_half + j] = 0.0;
      double rl = 1.0, cwl = 1.0, swl = 0.0;
      for (int l = 1; l <= max_l_used; ++l) {
        rl *= ir;
        const double ncwl = cwl * cn - swl * sn;
        swl = swl * cn + cwl * sn;
        cwl = ncwl;
        grid[l * N_half + j] = rl;
        grid[(cw_base + l) * N_half + j] = cwl;
        grid[(sw_base + l) * N_half + j] = swl;
      }
      grid[(ck_base + 0) * N_half + j] = 1.0;
      grid[(sk_base + 0) * N_half + j] = 0.0;
      double ckk = 1.0, skk = 0.0;
      for (int kv = 1; kv <= k_max_used; ++kv) {
        const double nckk = ckk * cm - skk * sm;
        skk = skk * cm + ckk * sm;
        ckk = nckk;
        grid[(ck_base + kv) * N_half + j] = ckk;
        grid[(sk_base + kv) * N_half + j] = skk;
      }
    }
    double* ang = grid;
    double* val_row = values + (off + 2) * raw_count;
    int q = 0;
    while (q < raw_count) {
      const int m = raw[q].m, w = raw[q].l - 2 * raw[q].p, k = raw[q].k, aw = w < 0 ? -w : w;
      int q_end = q + 1;
      while (q_end < raw_count && raw[q_end].m == m && (raw[q_end].l - 2 * raw[q_end].p) == w) ++q_end;
      const int n_l = q_end - q;
      const double* cw_p = grid + (cw_base + aw) * N_half;
      const double* sw_p = grid + (sw_base + aw) * N_half;
      const double* ck_p = grid + (ck_base + k) * N_half;
      const double* sk_p = grid + (sk_base + k) * N_half;
      for (int j = 0; j < N_half; ++j) {
        ang[j] = cw_p[j] * ck_p[j] + (w < 0 ? -sw_p[j] : sw_p[j]) * sk_p[j];
      }
      for (int idx = 0; idx < n_l; ++idx) {
        const double* rl = grid + raw[q + idx].l * N_half;
        double s = 0.0;
        for (int j = 0; j < N_half; ++j) s += rl[j] * ang[j];
        val_row[q + idx] = s * inv_N;
      }
      q = q_end;
    }
#endif
  }
  const double inv_12dh = 1.0 / (12.0 * dh), inv_12dh2 = 1.0 / (12.0 * dh * dh), inv_2dh3 = 1.0 / (2.0 * dh * dh * dh);

  int count = 0;
  int q = 0;
  while (q < raw_count) {
    const int m = raw[q].m, w = raw[q].l - 2 * raw[q].p, k = raw[q].k;
    int q_end = q + 1;
    while (q_end < raw_count && raw[q_end].m == m && (raw[q_end].l - 2 * raw[q_end].p) == w) ++q_end;
    double uc0 = 0, uce = 0, ucee = 0, uceee = 0, uci = 0, ucii = 0, uciii = 0, ucei = 0, uceei = 0, uceii = 0;
    double uca = 0, ucaa = 0, ucae = 0, uceea = 0, uceeea = 0, ucai = 0;
    double us0 = 0, use = 0, usee = 0, useee = 0, usi = 0, usii = 0, usiii = 0, usei = 0, useei = 0, useii = 0;
    double usa = 0, usaa = 0, usae = 0, useea = 0, useeea = 0, usai = 0;
    for (int idx = q; idx < q_end; ++idx) {
      const RawTerm& c = raw[idx];
      const int l = c.l;
      const double gm2 = values[idx], gm1 = values[raw_count + idx], g0 = values[2 * raw_count + idx];
      const double gp1 = values[3 * raw_count + idx], gp2 = values[4 * raw_count + idx];
      const double g1 = (gm2 - 8.0 * gm1 + 8.0 * gp1 - gp2) * inv_12dh;
      const double g2 = (-gp2 + 16.0 * gp1 - 30.0 * g0 + 16.0 * gm1 - gm2) * inv_12dh2;
      const double g3 = (gp2 - 2.0 * gp1 + 2.0 * gm1 - gm2) * inv_2dh3;
      const bool odd = ((l - m) & 1) != 0;
      const double A0 = amp0[l];
      const double cl = A0 * (odd ? -kEgmS[l][m] : kEgmC[l][m]);
      const double sl = A0 * (odd ? kEgmC[l][m] : kEgmS[l][m]);
      const double lp1 = l + 1.0, lp1_l = lp1 * l;
      const double f0g0 = c.f * g0, f0g1 = c.f * g1, f0g2 = c.f * g2, f0g3 = c.f * g3;
      const double f1g0 = c.df * g0, f2g0 = c.ddf * g0, f3g0 = c.dddf * g0;
      const double f1g1 = c.df * g1, f1g2 = c.df * g2, f2g1 = c.ddf * g1;
      uc0 += cl * f0g0;    us0 += sl * f0g0;
      uce += cl * f0g1;    use += sl * f0g1;
      ucee += cl * f0g2;   usee += sl * f0g2;
      uceee += cl * f0g3;  useee += sl * f0g3;
      uci += cl * f1g0;    usi += sl * f1g0;
      ucii += cl * f2g0;   usii += sl * f2g0;
      uciii += cl * f3g0;  usiii += sl * f3g0;
      ucei += cl * f1g1;   usei += sl * f1g1;
      uceei += cl * f1g2;  useei += sl * f1g2;
      uceii += cl * f2g1;  useii += sl * f2g1;
      uca += cl * lp1 * f0g0;    usa += sl * lp1 * f0g0;
      ucaa += cl * lp1_l * f0g0; usaa += sl * lp1_l * f0g0;
      ucae += cl * lp1 * f0g1;   usae += sl * lp1 * f0g1;
      uceea += cl * lp1 * f0g2;  useea += sl * lp1 * f0g2;
      uceeea += cl * lp1 * f0g3; useeea += sl * lp1 * f0g3;
      ucai += cl * lp1 * f1g0;   usai += sl * lp1 * f1g0;
    }
    out[count++] = HalfDayCoef{
        static_cast<int8_t>(m), static_cast<int8_t>(w), static_cast<int8_t>(k), 0,
        static_cast<float>(uc0), static_cast<float>(uce), static_cast<float>(ucee), static_cast<float>(uceee),
        static_cast<float>(uci), static_cast<float>(ucii), static_cast<float>(uciii),
        static_cast<float>(ucei), static_cast<float>(uceei), static_cast<float>(uceii),
        static_cast<float>(uca), static_cast<float>(ucaa), static_cast<float>(ucae), static_cast<float>(uceea), static_cast<float>(uceeea), static_cast<float>(ucai),
        static_cast<float>(us0), static_cast<float>(use), static_cast<float>(usee), static_cast<float>(useee),
        static_cast<float>(usi), static_cast<float>(usii), static_cast<float>(usiii),
        static_cast<float>(usei), static_cast<float>(useei), static_cast<float>(useii),
        static_cast<float>(usa), static_cast<float>(usaa), static_cast<float>(usae), static_cast<float>(useea), static_cast<float>(useeea), static_cast<float>(usai),
    };
    q = q_end;
  }
  return count;
}
struct HdGroup {
  uint16_t start, end;
  int8_t k, m, pad0, pad1;
};
struct HalfDayEvalCache {
  const HalfDayCoef* table = nullptr;
  uint64_t table_id = 0;
  int count = 0;
  int n_groups = 0;
  int n_pad = 0;
  bool grouped_ok = false;
  float f0 = 0.0f, fn = 0.0f;
  double a0 = -1.0, e0 = -1.0, i0 = -1.0;
  double a = -1.0, e = -1.0, i = -1.0;
  int max_aw = 33, max_k = 16;
  HdGroup groups[32]{};
  uint16_t slot_of[1024]{};
  uint8_t w_off[1152]{};
  alignas(16) float wf[1152]{};
  alignas(16) float b0[1152]{};
  alignas(16) float b1[1152]{};
  alignas(16) float b2[1152]{};
  alignas(16) float b3[1152]{};
  alignas(16) float b4[1152]{};
  alignas(16) float b5[1152]{};
  alignas(16) float b6[1152]{};
  alignas(16) float b7[1152]{};
};
inline thread_local HalfDayEvalCache* g_half_day_eval_cache_ptr = nullptr;
/// Made by pool::warm_thread before the thread's first state or initialization (stack #600). False when it cannot be had.
inline bool half_day_eval_cache_make() {
  if (g_half_day_eval_cache_ptr == nullptr) g_half_day_eval_cache_ptr = sdnap::mem::counted(new (std::nothrow) HalfDayEvalCache{});
  return g_half_day_eval_cache_ptr != nullptr;
}
inline HalfDayEvalCache& half_day_eval_cache() {
  if (__builtin_expect(!g_half_day_eval_cache_ptr, 0) && !half_day_eval_cache_make()) __builtin_trap();  // a thread warm_thread did not reach
  return *g_half_day_eval_cache_ptr;
}
inline int32_t& fit_grid_depth();
/// `m_per_k`: the class's m / k, 2 for the half-day tail and 1 for the one-day tail (half_day_terms).
inline void half_day_six(const HalfDayCoef* table, int count, double e0, double i0,
                        double t, const Kepler& kp, double n, double eta, double si,
                        double ci, double theta_g0, double* six, double a0 = 1.0, uint64_t table_id = 0,
                        int m_per_k = 2) {
  if (count == 0) return;
  const double a = kp.a, e = kp.e < 1e-12 ? 1e-12 : kp.e;
  const double sin_i = std::fabs(si) < 1e-12 ? (si < 0.0 ? -1e-12 : 1e-12) : si;
  const double thetag = theta_g0 + kOmegaE * t;
  const double ia = 1.0 / a;
  const double da = a0 * ia - 1.0;

  HalfDayEvalCache& hc = half_day_eval_cache();
  const bool cacheable = count <= 1024 && t != 0.0 && table_id != 0 && fit_grid_depth() == 0;
  if (cacheable &&
      (hc.table_id != table_id || hc.table != table || hc.count != count ||
       hc.f0 != table[0].uc0 || hc.fn != table[count - 1].uc0 ||
       hc.a0 != a0 || hc.e0 != e0 || hc.i0 != i0 ||
       a != hc.a || kp.e != hc.e || kp.i != hc.i)) {
    const bool new_table = (hc.table_id != table_id || hc.table != table || hc.count != count ||
                            hc.f0 != table[0].uc0 || hc.fn != table[count - 1].uc0);
    hc.table_id = table_id;
    hc.table = table;
    hc.count = count;
    hc.f0 = table[0].uc0;
    hc.fn = table[count - 1].uc0;
    hc.a0 = a0;
    hc.e0 = e0;
    hc.i0 = i0;
    hc.a = a;
    hc.e = kp.e;
    hc.i = kp.i;
    if (new_table) {
      int maw = 0, mk = 0, ng = 0, npad = 0;
      bool ok = true;
      int j = 0;
      while (j < count) {
        const int kv = table[j].k, mv = table[j].m;
        if (kv < 0 || kv > 17) { ok = false; break; }
        int j_end = j + 1;
        while (j_end < count && table[j_end].k == kv && table[j_end].m == mv) ++j_end;
        const int n_run = j_end - j;
        const int run_pad = (n_run + 3) & ~3;
        if (ng >= 32 || npad + run_pad > 1152) { ok = false; break; }
        for (int idx = 0; idx < n_run; ++idx) {
          const int wv = table[j + idx].w;
          const int aw = wv < 0 ? -wv : wv;
          if (aw > 35) { ok = false; break; }
          if (aw > maw) maw = aw;
          const int slot = npad + idx;
          hc.slot_of[j + idx] = static_cast<uint16_t>(slot);
          hc.w_off[slot] = static_cast<uint8_t>(wv + 35);
          hc.wf[slot] = static_cast<float>(wv);
        }
        if (!ok) break;
        for (int idx = n_run; idx < run_pad; ++idx) {
          const int slot = npad + idx;
          hc.w_off[slot] = 35u;
          hc.wf[slot] = 0.0f;
          hc.b0[slot] = hc.b1[slot] = hc.b2[slot] = hc.b3[slot] = 0.0f;
          hc.b4[slot] = hc.b5[slot] = hc.b6[slot] = hc.b7[slot] = 0.0f;
        }
        if (kv > mk) mk = kv;
        hc.groups[ng++] = HdGroup{static_cast<uint16_t>(npad), static_cast<uint16_t>(npad + run_pad),
                                  static_cast<int8_t>(kv), static_cast<int8_t>(mv), 0, 0};
        npad += run_pad;
        j = j_end;
      }
      hc.grouped_ok = ok;
      hc.n_groups = ok ? ng : 0;
      hc.n_pad = ok ? npad : 0;
      hc.max_aw = ok ? maw : 33;
      hc.max_k = ok ? mk : 16;
    }
    if (hc.grouped_ok) {
      const double dd = kp.e - e0, did = kp.i - i0;
      const double dd2_2 = 0.5 * dd, dd_6 = dd * (1.0 / 6.0);
      const double did2_2 = 0.5 * did, did_6 = did * (1.0 / 6.0);
      const double dd_di = dd * did, da2_2d = 0.5 * da;
      const float d = static_cast<float>(dd), di = static_cast<float>(did), daf = static_cast<float>(da);
      const float d2_2 = 0.5f * d, d_6f = d * (1.0f / 6.0f), di2_2 = 0.5f * di, neg_1pda = -(1.0f + daf);
      for (int j = 0; j < count; ++j) {
        const HalfDayCoef& c = table[j];
        const uint16_t slot = hc.slot_of[j];
        hc.b0[slot] = static_cast<float>(
            c.uc0 + dd * (c.uce + dd * (dd2_2 * c.ucee + dd_6 * c.uceee)) +
            did * (c.uci + did * (did2_2 * c.ucii + did_6 * c.uciii)) +
            dd_di * (c.ucei + dd2_2 * c.uceei + did2_2 * c.uceii) +
            da * (c.uca + da2_2d * c.ucaa + dd * (c.ucae + dd * (dd2_2 * c.uceea + dd_6 * c.uceeea)) + did * c.ucai));
        hc.b1[slot] = static_cast<float>(
            c.us0 + dd * (c.use + dd * (dd2_2 * c.usee + dd_6 * c.useee)) +
            did * (c.usi + did * (did2_2 * c.usii + did_6 * c.usiii)) +
            dd_di * (c.usei + dd2_2 * c.useei + did2_2 * c.useii) +
            da * (c.usa + da2_2d * c.usaa + dd * (c.usae + dd * (dd2_2 * c.useea + dd_6 * c.useeea)) + did * c.usai));
        hc.b2[slot] = c.uce + d * (c.ucee + d2_2 * c.uceee) + di * (c.ucei + d * c.uceei + di2_2 * c.uceii) + daf * (c.ucae + d * (c.uceea + d2_2 * c.uceeea));
        hc.b3[slot] = c.use + d * (c.usee + d2_2 * c.useee) + di * (c.usei + d * c.useei + di2_2 * c.useii) + daf * (c.usae + d * (c.useea + d2_2 * c.useeea));
        hc.b4[slot] = c.uci + di * (c.ucii + di2_2 * c.uciii) + d * (c.ucei + d2_2 * c.uceei + di * c.uceii) + daf * c.ucai;
        hc.b5[slot] = c.usi + di * (c.usii + di2_2 * c.usiii) + d * (c.usei + d2_2 * c.useei + di * c.useii) + daf * c.usai;
        hc.b6[slot] = neg_1pda * (c.uca + daf * c.ucaa + d * (c.ucae + d * (d2_2 * c.uceea + d_6f * c.uceeea)) + di * c.ucai);
        hc.b7[slot] = neg_1pda * (c.usa + daf * c.usaa + d * (c.usae + d * (d2_2 * c.useea + d_6f * c.useeea)) + di * c.usai);
      }
    }
  }

  double sw1, cw1, sT1, cT1;
  fm::sincos(kp.argp, sw1, cw1);
  fm::sincos(kp.m + (m_per_k == 1 ? 1.0 : 2.0) * (kp.node - thetag), sT1, cT1);
  double cw_buf[71], sw_buf[71], ck[18], sk[18];
  double* const cw = cw_buf + 35;
  double* const sw = sw_buf + 35;
  cw[0] = ck[0] = 1.0;
  sw[0] = sk[0] = 0.0;
  const bool fast_eval = cacheable && hc.grouped_ok;
  const int max_aw = fast_eval ? hc.max_aw : 33;
  const int max_k = fast_eval ? hc.max_k : 16;
  for (int q = 1; q <= max_aw; ++q) {
    cw[q] = cw[q - 1] * cw1 - sw[q - 1] * sw1;
    sw[q] = sw[q - 1] * cw1 + cw[q - 1] * sw1;
    cw[-q] = cw[q];
    sw[-q] = -sw[q];
  }
  for (int q = 1; q <= max_k; ++q) {
    ck[q] = ck[q - 1] * cT1 - sk[q - 1] * sT1;
    sk[q] = sk[q - 1] * cT1 + ck[q - 1] * sT1;
  }

  double sM = 0.0, sW = 0.0, sO = 0.0, sE = 0.0, sI = 0.0, sA = 0.0;
  if (fast_eval) {
#ifdef __wasm_simd128__
    alignas(8) float csw_f[71][2];
    csw_f[35][0] = 1.0f;
    csw_f[35][1] = 0.0f;
    for (int q = 1; q <= max_aw; ++q) {
      const float cwf = static_cast<float>(cw[q]), swf = static_cast<float>(sw[q]);
      csw_f[35 + q][0] = cwf;
      csw_f[35 + q][1] = swf;
      csw_f[35 - q][0] = cwf;
      csw_f[35 - q][1] = -swf;
    }
    v128_t vM = wasm_f32x4_splat(0.0f), vW = wasm_f32x4_splat(0.0f), vO = wasm_f32x4_splat(0.0f);
    v128_t vE = wasm_f32x4_splat(0.0f), vI = wasm_f32x4_splat(0.0f), vA = wasm_f32x4_splat(0.0f);
    const int ng = hc.n_groups;
    for (int gi = 0; gi < ng; ++gi) {
      const HdGroup& grp = hc.groups[gi];
      const v128_t v_ck = wasm_f32x4_splat(static_cast<float>(ck[grp.k]));
      const v128_t v_sk = wasm_f32x4_splat(static_cast<float>(sk[grp.k]));
      v128_t v_grp_fg = wasm_f32x4_splat(0.0f);
      for (int slot = grp.start; slot < grp.end; slot += 4) {
        const uint8_t* wp = hc.w_off + slot;
        v128_t w01 = wasm_v128_load64_zero(csw_f[wp[0]]);
        w01 = wasm_v128_load64_lane(csw_f[wp[1]], w01, 1);
        v128_t w23 = wasm_v128_load64_zero(csw_f[wp[2]]);
        w23 = wasm_v128_load64_lane(csw_f[wp[3]], w23, 1);
        const v128_t cww = wasm_i32x4_shuffle(w01, w23, 0, 2, 4, 6);
        const v128_t sww = wasm_i32x4_shuffle(w01, w23, 1, 3, 5, 7);
        const v128_t vcp = wasm_f32x4_sub(wasm_f32x4_mul(cww, v_ck), wasm_f32x4_mul(sww, v_sk));
        const v128_t vsp = wasm_f32x4_add(wasm_f32x4_mul(sww, v_ck), wasm_f32x4_mul(cww, v_sk));
        const v128_t fgdS = wasm_f32x4_sub(wasm_f32x4_mul(wasm_v128_load(hc.b1 + slot), vcp),
                                           wasm_f32x4_mul(wasm_v128_load(hc.b0 + slot), vsp));
        v_grp_fg = wasm_f32x4_add(v_grp_fg, fgdS);
        vW = wasm_f32x4_add(vW, wasm_f32x4_mul(wasm_v128_load(hc.wf + slot), fgdS));
        vE = wasm_f32x4_add(vE, wasm_f32x4_add(wasm_f32x4_mul(wasm_v128_load(hc.b2 + slot), vcp),
                                               wasm_f32x4_mul(wasm_v128_load(hc.b3 + slot), vsp)));
        vI = wasm_f32x4_add(vI, wasm_f32x4_add(wasm_f32x4_mul(wasm_v128_load(hc.b4 + slot), vcp),
                                               wasm_f32x4_mul(wasm_v128_load(hc.b5 + slot), vsp)));
        vA = wasm_f32x4_add(vA, wasm_f32x4_add(wasm_f32x4_mul(wasm_v128_load(hc.b6 + slot), vcp),
                                               wasm_f32x4_mul(wasm_v128_load(hc.b7 + slot), vsp)));
      }
      vM = wasm_f32x4_add(vM, wasm_f32x4_mul(wasm_f32x4_splat(static_cast<float>(grp.k)), v_grp_fg));
      vO = wasm_f32x4_add(vO, wasm_f32x4_mul(wasm_f32x4_splat(static_cast<float>(grp.m)), v_grp_fg));
    }
    auto hsum = [](v128_t v) -> double {
      const v128_t p2 = wasm_f32x4_add(v, wasm_i64x2_shuffle(v, v, 1, 0));
      const v128_t d2 = wasm_f64x2_promote_low_f32x4(p2);
      return wasm_f64x2_extract_lane(d2, 0) + wasm_f64x2_extract_lane(d2, 1);
    };
    sM = hsum(vM);
    sW = hsum(vW);
    sO = hsum(vO);
    sE = hsum(vE);
    sI = hsum(vI);
    sA = hsum(vA);
#else
    for (int gi = 0; gi < hc.n_groups; ++gi) {
      const HdGroup& grp = hc.groups[gi];
      const double ckv = ck[grp.k], skv = sk[grp.k];
      double grp_fg = 0.0;
      for (int slot = grp.start; slot < grp.end; ++slot) {
        const int w = static_cast<int>(hc.w_off[slot]) - 35;
        const double cww = cw[w], sww = sw[w];
        const double cp = cww * ckv - sww * skv;
        const double sp = sww * ckv + cww * skv;
        const double fgdS = -static_cast<double>(hc.b0[slot]) * sp + static_cast<double>(hc.b1[slot]) * cp;
        grp_fg += fgdS;
        sW += static_cast<double>(hc.wf[slot]) * fgdS;
        sE += static_cast<double>(hc.b2[slot]) * cp + static_cast<double>(hc.b3[slot]) * sp;
        sI += static_cast<double>(hc.b4[slot]) * cp + static_cast<double>(hc.b5[slot]) * sp;
        sA += static_cast<double>(hc.b6[slot]) * cp + static_cast<double>(hc.b7[slot]) * sp;
      }
      sM += grp.k * grp_fg;
      sO += grp.m * grp_fg;
    }
#endif
  } else {
    const double d = kp.e - e0, di = kp.i - i0;
    const double d2_2 = 0.5 * d, d_6 = d / 6.0;
    const double di2_2 = 0.5 * di, di_6 = di / 6.0;
    const double d_di = d * di, da2_2 = 0.5 * da, neg_1pda = -(1.0 + da);
    for (int j = 0; j < count; ++j) {
      const HalfDayCoef& c = table[j];
      const int m = c.m, k = c.k, w = c.w;
      const double cww = cw[w], sww = sw[w];
      const double cp = cww * ck[k] - sww * sk[k];
      const double sp = sww * ck[k] + cww * sk[k];
      const double phi_c = c.uc0 + d * (c.uce + d * (d2_2 * c.ucee + d_6 * c.uceee)) +
                           di * (c.uci + di * (di2_2 * c.ucii + di_6 * c.uciii)) +
                           d_di * (c.ucei + d2_2 * c.uceei + di2_2 * c.uceii) +
                           da * (c.uca + da2_2 * c.ucaa + d * (c.ucae + d * (d2_2 * c.uceea + d_6 * c.uceeea)) + di * c.ucai);
      const double phi_s = c.us0 + d * (c.use + d * (d2_2 * c.usee + d_6 * c.useee)) +
                           di * (c.usi + di * (di2_2 * c.usii + di_6 * c.usiii)) +
                           d_di * (c.usei + d2_2 * c.useei + di2_2 * c.useii) +
                           da * (c.usa + da2_2 * c.usaa + d * (c.usae + d * (d2_2 * c.useea + d_6 * c.useeea)) + di * c.usai);
      const double pe_c = c.uce + d * (c.ucee + d2_2 * c.uceee) + di * (c.ucei + d * c.uceei + di2_2 * c.uceii) + da * (c.ucae + d * (c.uceea + d2_2 * c.uceeea));
      const double pe_s = c.use + d * (c.usee + d2_2 * c.useee) + di * (c.usei + d * c.useei + di2_2 * c.useii) + da * (c.usae + d * (c.useea + d2_2 * c.useeea));
      const double pi_c = c.uci + di * (c.ucii + di2_2 * c.uciii) + d * (c.ucei + d2_2 * c.uceei + di * c.uceii) + da * c.ucai;
      const double pi_s = c.usi + di * (c.usii + di2_2 * c.usiii) + d * (c.usei + d2_2 * c.useei + di * c.useii) + da * c.usai;
      const double pa_c = neg_1pda * (c.uca + da * c.ucaa + d * (c.ucae + d * (d2_2 * c.uceea + d_6 * c.uceeea)) + di * c.ucai);
      const double pa_s = neg_1pda * (c.usa + da * c.usaa + d * (c.usae + d * (d2_2 * c.useea + d_6 * c.useeea)) + di * c.usai);
      const double fgdS = -phi_c * sp + phi_s * cp;
      sM += k * fgdS;
      sW += w * fgdS;
      sO += m * fgdS;
      sE += pe_c * cp + pe_s * sp;
      sI += pi_c * cp + pi_s * sp;
      sA += pa_c * cp + pa_s * sp;
    }
  }
  sA *= ia;
  const double na2 = n * a * a;
  const double tanhalf = sin_i / (1.0 + ci);
  six[0] += -3.0 * ia * ia * sM;
  six[1] += (eta * eta * sM - eta * sW) / (na2 * e);
  six[2] += (ci * sW - sO) / (na2 * eta * sin_i);
  six[3] += (eta / na2) * sE + e * tanhalf / (na2 * eta) * sI;
  six[4] += sI / (na2 * eta);
  six[5] += -(2.0 / (n * a)) * sA + (eta * e / (na2 * (1.0 + eta))) * sE + (tanhalf / (na2 * eta)) * sI;
}

/// SPEC 16.3: below kWideE the tail's rates also carry the long-period terms 2 <= |w| <= kTailW (w = l - 2p,
/// q = -w; even w on even l, odd w on odd l), in the rates' cached path. G of each is written e^|w| (a + b e^2), its value and
/// slope exact at the center of the epoch eccentricity cell, so it stays smooth through e = 0 (G is O(e^|w|) there; a line in e is not).
constexpr int kTailW = 6;
constexpr double kTailCell = 0.002;
inline void zonal_G(int l, int k, double e, double& G, double& dG);

/// The coefficients of e^k (a + b e^2), matching the closed form and its slope at er >= 0.01.
inline void tail_w_coefficients(int l, int k, double er, float& a, float& b) {
  if (l - 1 < k) { a = b = 0.0f; return; }
  double G, dG;
  zonal_G(l, k, er, G, dG);
  const double r = er * dG / G - k, erk = std::pow(er, k);
  a = static_cast<float>(G * (2.0 - r) / (2.0 * erk));
  b = static_cast<float>(G * r / (2.0 * erk * er * er));
}

/// A function of the state alone, independent of the epoch and the table's owner.
inline double tail_w_anchor(double e) {
  const double at = e > 0.01 ? e : 0.01;
  return kTailCell * (std::floor(at / kTailCell) + 0.5);
}
/// Closed-form coefficients depend on the cell, degree and harmonic, not on semimajor axis or inclination.
/// Keep them across rate-cache rebuilds caused by a changing semimajor axis.
struct TailWCoefficients {
  double anchor = -1.0;
  int degree = 5;
  float a[71][kTailW + 1]{}, b[71][kTailW + 1]{};
};
inline const TailWCoefficients& tail_w_moved(int degree, double anchor) {
  static thread_local TailWCoefficients c;
  if (c.anchor != anchor) { c.anchor = anchor; c.degree = 5; }
  for (int l = c.degree + 1; l <= degree; ++l)
    for (int k = (l & 1) ? 3 : 2; k <= kTailW; k += 2)
      tail_w_coefficients(l, k, anchor, c.a[l][k], c.b[l][k]);
  if (degree > c.degree) c.degree = degree;
  return c;
}
inline int tail_w_pairs(int l) {
  int c = 0;
  for (int k = (l & 1) ? 3 : 2; k <= kTailW && k <= l; k += 2) ++c;
  return c;
}
struct TailWF {
  double f[kTailW + 1][2][72];   ///< [|w|][w < 0 ? 0 : 1][l]: F_l0p at the epoch inclination
  double df[kTailW + 1][2][72];  ///< dF/di
};
inline void tail_w_F(int degree, double i0, double h, TailWF& t) {
  double fp[72], fm[72];
  for (int k = 2; k <= kTailW; ++k)
    for (int s = 0; s < 2; ++s) {
      normalized_Fk3(0, s == 0 ? -k : k, degree, i0, h, t.f[k][s], fp, fm);
      for (int l = 0; l <= degree; ++l) t.df[k][s][l] = (fp[l] - fm[l]) * (0.5 / h);
    }
}
/// Degree l's entries for |w| = k0, k0 + 2, .. (w = -k, then +k): F, dF/di, a, b.
inline void tail_w_entries(int l, int k0, double e0, const TailWF& t, float* F, int& idx) {
  const double er = tail_w_anchor(e0);
  for (int k = k0; k <= kTailW && k <= l; k += 2) {
    float a, b;
    tail_w_coefficients(l, k, er, a, b);
    for (int s = 0; s < 2; ++s) {
      float* u = F + 4 * idx++;
      u[0] = static_cast<float>(t.f[k][s][l]);
      u[1] = static_cast<float>(t.df[k][s][l]);
      u[2] = a;
      u[3] = b;
    }
  }
}

/// The zonal tail, J_l for 6 <= l <= the degree (SPEC 2 carries J2-J5), first order in the
/// rates: the secular terms of even l (p = l/2, q = 0) and the long-period terms of odd l (w = l - 2p = +-1,
/// q = -w: psi = w omega, O(e) in G and O(1) in the eccentricity vector), plus 2 <= |w| <= kTailW;
/// `wide` (epoch e above kWideE, SPEC 16.11):
/// every long-period term, w = l - 2p for p = 0..l, G = O(e^|w|). Per term at the epoch (float): Fbar, dFbar/di,
/// G = g0 + g1 e, except the low table's |w| >= 2 entries, which hold a, b for e^|w| (a + b e^2).
inline int zonal_count(int degree, bool wide) {
  int c = 0;
  for (int l = 6; l <= degree; ++l) c += wide ? l + 1 : ((l & 1) ? 2 : 1) + 2 * tail_w_pairs(l);
  return c;
}

/// G_lpq and dG/de at fixed M by the trapezoid on 256 uniform eccentric anomalies (dM = (1 - e cos E) dE; spectral for
/// these periodic integrands): the wide set's Hansen coefficients (SPEC 16.11).
inline void node_G(int l, int p, int q, double e, double& G, double& dG) {
  constexpr int N = 256;
  const int w = l - 2 * p, j = w + q;
  const double eta = std::sqrt(1.0 - e * e);
  G = 0.0;
  dG = 0.0;
  for (int k = 0; k < N; ++k) {
    const double E = kTwoPi * k / N, sE = std::sin(E), cE = std::cos(E), ar = 1.0 / (1.0 - e * cE);
    const double cf = (cE - e) * ar, sf = eta * sE * ar, M = E - e * sE;
    const double ph = w * std::atan2(sf, cf) - j * M, cp = std::cos(ph), sp = std::sin(ph);
    const double ak = std::pow(ar, l);  // (a/r)^(l+1) (1 - e cos E)
    G += ak * cp;
    dG += ak * ((l + 1) * ar * cf * cp - w * sf * (2.0 + e * cf) / (eta * eta) * sp);
  }
  G /= N;
  dG /= N;
}

/// X_0^{-(l+1),k}: average in true anomaly of (1 + e cos f)^(l-1) cos(k f), divided by
/// (1 - e^2)^(l-1/2). The finite binomial sum and its analytic derivative have positive terms.
/// k > l - 1 vanishes identically, including l = k = 6. No cancellation-prone quadrature is used.
inline void zonal_G(int l, int k, double e, double& G, double& dG) {
  G = dG = 0.0;
  if (k > l - 1) return;
  double choose = 1.0;
  for (int j = 1; j <= k; ++j) choose *= static_cast<double>(l - j) / j;
  double term = choose * std::pow(0.5 * e, k), sum = term;
  double slope = e > 0.0 ? k * term / e : (k == 1 ? 0.5 * (l - 1) : 0.0);
  for (int d = 0; 2 * d + k + 2 <= l - 1; ++d) {
    const int m = 2 * d + k;
    term *= (l - 1.0 - m) * (l - 2.0 - m) * (0.25 * e * e) / ((d + 1.0) * (d + k + 1.0));
    sum += term;
    if (e > 0.0) slope += (m + 2) * term / e;
  }
  const double eta2 = 1.0 - e * e, factor = std::pow(eta2, -(l - 0.5));
  G = factor * sum;
  dG = factor * (slope + (2 * l - 1) * e * sum / eta2);
}

/// The wide zonal table's shared samples retain separate sin/cos calls and
/// std::pow; replacing those operations would change their rounding.
// Keyed by eccentricity and l; lives for one initialization call.
struct NodeGSamples {
  struct Sample { double ar, cf, sf, M, nu; };
  double e, eta;
  mem::InitTable<Sample> samples;
  mem::InitTable<double> powers[71];
  explicit NodeGSamples(double eccentricity) : e(eccentricity), eta(std::sqrt(1.0 - e * e)) {
    constexpr int N = 256;
    if (!samples.allocate(N)) return;
    for (int k = 0; k < N; ++k) {
      const double E = kTwoPi * k / N, sE = std::sin(E), cE = std::cos(E), ar = 1.0 / (1.0 - e * cE);
      const double cf = (cE - e) * ar, sf = eta * sE * ar, M = E - e * sE;
      samples[k] = {ar, cf, sf, M, std::atan2(sf, cf)};
    }
  }
  void get(int l, int p, int q, double& G, double& dG) {
    G = dG = 0.0;
    if (samples.empty()) return;
    auto& power = powers[l];
    if (power.empty()) {
      if (!power.allocate(samples.size())) return;
      for (size_t k = 0; k < samples.size(); ++k) power[k] = std::pow(samples[k].ar, l);
    }
    const int w = l - 2 * p, j = w + q;
    G = 0.0; dG = 0.0;
    for (size_t k = 0; k < samples.size(); ++k) {
      const auto& v = samples[k];
      const double ph = w * v.nu - j * v.M, cp = std::cos(ph), sp = std::sin(ph);
      const double ak = power[k];
      G += ak * cp;
      dG += ak * ((l + 1) * v.ar * v.cf * cp - w * v.sf * (2.0 + e * v.cf) / (eta * eta) * sp);
    }
    G /= 256;
    dG /= 256;
  }
};

struct OddZonalG1 {
  bool ready = false;
  double g1[72]{};
};
inline thread_local OddZonalG1 g_odd_zonal_g1{};
[[gnu::noinline]] inline void init_odd_zonal_g1(OddZonalG1& r) {
  const auto mark = mem::thread_failures();
  res::HansenSamples samples(1e-3);
  for (int l = 7; l <= 70; l += 2) r.g1[l] = samples.get(l, (l - 1) / 2, -1) / 1e-3;
  r.ready = mem::thread_failures() == mark;
}
inline const OddZonalG1& odd_zonal_g1() {
  OddZonalG1& r = g_odd_zonal_g1;
  if (__builtin_expect(!r.ready, 0)) init_odd_zonal_g1(r);
  return r;
}

inline void zonal_visit_terms(int degree, bool wide, double i0, double e0, float* F) {
  const double h = 1e-5;
  int idx = 0;
  if (!wide) {
    const OddZonalG1& kOddG1 = odd_zonal_g1();
    double si0, ci0;
    fm::sincos(i0, si0, ci0);
    double f_even[72]{}, df_even[72]{}, f_pos1[72]{}, df_pos1[72]{};
    double f_neg1[72]{}, df_neg1[72]{};
    if (std::fabs(ci0) >= 1e-3) {
      const int NF = (degree + 4) & ~1;
      const int NF_HALF = NF >> 1;
      const int j_top = NF_HALF >> 1;
      LegendreOrder L;
      legendre_order(0, degree, L);
      const double du = kTwoPi / NF, two_inv_NF = 2.0 / NF_HALF;
      double sdu, cdu;
      fm::sincos(du, sdu, cdu);
      double su = 0.0, cu = 1.0;
      double col[104], dcol[104];
      for (int j = 0; j <= j_top; ++j) {
        if (j > 0) {
          const double nsu = su * cdu + cu * sdu;
          cu = cu * cdu - su * sdu;
          su = nsu;
        }
        const double w_j = (j == 0 || 2 * j == NF_HALF) ? 0.5 : 1.0;
        const double x = si0 * su, c2 = 1.0 - x * x, c = std::sqrt(c2);
        const double inv_c2 = 1.0 / c2;
        legendre_column(L, x, c, col);
        const double alpha_x = ci0 * su * inv_c2;
        for (int l = 1; l <= degree; ++l) dcol[l] = alpha_x * (L.d[l] * col[l - 1] - l * x * col[l]);
        for (int l = 6; l <= degree; l += 2) {
          f_even[l] += col[l] * w_j;
          df_even[l] += dcol[l] * w_j;
        }
        const double su_w = su * w_j;
        for (int l = 7; l <= degree; l += 2) {
          f_pos1[l] += col[l] * su_w;
          df_pos1[l] += dcol[l] * su_w;
        }
      }
      for (int l = 6; l <= degree; l += 2) {
        f_even[l] *= two_inv_NF;
        df_even[l] *= two_inv_NF;
      }
      for (int l = 7; l <= degree; l += 2) {
        f_pos1[l] *= two_inv_NF;
        df_pos1[l] *= two_inv_NF;
        f_neg1[l] = -f_pos1[l];
        df_neg1[l] = -df_pos1[l];
      }
    } else {
      double fp_even[72], fm_even[72], fp_neg1[72], fm_neg1[72], fp_pos1[72], fm_pos1[72];
      normalized_Fk3(0, 0, degree, i0, h, f_even, fp_even, fm_even);
      normalized_Fk3(0, -1, degree, i0, h, f_neg1, fp_neg1, fm_neg1);
      normalized_Fk3(0, 1, degree, i0, h, f_pos1, fp_pos1, fm_pos1);
      const double inv_2h = 0.5 / h;
      for (int l = 6; l <= degree; ++l) {
        df_even[l] = (fp_even[l] - fm_even[l]) * inv_2h;
        df_neg1[l] = (fp_neg1[l] - fm_neg1[l]) * inv_2h;
        df_pos1[l] = (fp_pos1[l] - fm_pos1[l]) * inv_2h;
      }
    }
    static thread_local TailWF tw;
    tail_w_F(degree, i0, h, tw);
    for (int l = 6; l <= degree; ++l) {
      if ((l & 1) == 0) {
        const double c2 = 0.25 * l * (l + 1);
        double G, dG;
        if (e0 < 0.005) { G = 1.0 + c2 * e0 * e0; dG = 2.0 * c2 * e0; }
        else res::exact_G(l, l / 2, 0, e0, G, dG);
        float* t = F + 4 * idx++;
        t[0] = static_cast<float>(f_even[l]);
        t[1] = static_cast<float>(df_even[l]);
        t[2] = static_cast<float>(G - dG * e0);
        t[3] = static_cast<float>(dG);
        tail_w_entries(l, 2, e0, tw, F, idx);
      } else {
        double g0, g1;
        if (e0 < 0.01) {
          g1 = kOddG1.g1[l];
          g0 = 0.0;
        } else {
          double G, dG;
          res::exact_G(l, (l - 1) / 2, -1, e0, G, dG);
          g1 = dG;
          g0 = G - dG * e0;
        }
        float* tn = F + 4 * idx++;
        tn[0] = static_cast<float>(f_neg1[l]);
        tn[1] = static_cast<float>(df_neg1[l]);
        tn[2] = static_cast<float>(g0);
        tn[3] = static_cast<float>(g1);
        float* tp = F + 4 * idx++;
        tp[0] = static_cast<float>(f_pos1[l]);
        tp[1] = static_cast<float>(df_pos1[l]);
        tp[2] = static_cast<float>(g0);
        tp[3] = static_cast<float>(g1);
        tail_w_entries(l, 3, e0, tw, F, idx);
      }
    }
    return;
  }
  NodeGSamples samples(e0);
  double f[72], fp[72], fm[72];
  for (int l = 6; l <= degree; ++l) {
    const int wl = l;
    for (int w = -wl; w <= wl; w += 2) {
      const int p = (l - w) / 2, q = -w;
      normalized_Fk3(0, w, l, i0, h, f, fp, fm);
      double G, dG;
      samples.get(l, p, q, G, dG);
      const double g1 = dG, g0 = G - dG * e0;
      float* t = F + 4 * idx++;
      t[0] = static_cast<float>(f[l]);
      t[1] = static_cast<float>((fp[l] - fm[l]) / (2.0 * h));
      t[2] = static_cast<float>(g0);
      t[3] = static_cast<float>(g1);
    }
  }
}

struct ZonalEvalCache {
  const float* F = nullptr;
  uint64_t table_id = 0;
  int degree = 0;
  bool eq_cut = false;
  float f0 = 0.0f, f1 = 0.0f, f2 = 0.0f, f3 = 0.0f, flast = 0.0f;
  double a_ref = -1.0;
  double e_anchor = -1.0;
  bool keys_valid = false;
  int64_t ka = 0;  ///< the bits of the a baked at (a_ref)
  double c[11 + 6 * (kTailW - 1)][3]{};
};
inline thread_local ZonalEvalCache g_zonal_eval_cache{};
inline ZonalEvalCache& zonal_eval_cache() { return g_zonal_eval_cache; }

/// The zonal tail's contribution to the six rates (n-dot, e-dot, i-dot, e varpi-dot, sin i Omega-dot,
/// lambda-dot - n), at the current mean elements.
inline void zonal_six(const float* F, int degree, bool wide, const Kepler& kp, double n, double eta, double si, double ci,
                      double* six, const double* sw_in = nullptr, const double* cw_in = nullptr, uint64_t table_id = 0,
                      double e_r = 0.01) {
  const double a = kp.a, e = kp.e < 1e-12 ? 1e-12 : kp.e;
  const double sin_i = std::fabs(si) < 1e-12 ? (si < 0.0 ? -1e-12 : 1e-12) : si;
  double sw, cw;
  if (sw_in != nullptr && cw_in != nullptr) {
    sw = *sw_in;
    cw = *cw_in;
  } else {
    fm::sincos(kp.argp, sw, cw);
  }
  const double ia = 1.0 / a;
  const double ia2 = ia * ia;
  const double ia3 = ia2 * ia;
  double A = kMu * ia3 * ia3 * ia;  // mu / a^(l+1), l = 6
  const bool eq_cut = !(std::fabs(si) > 0.02);
  const double a_cut = eq_cut ? 1e-25 : 1e-20;
  double sW = 0, sE = 0, sI = 0, sA = 0;
  if (!wide) {
    ZonalEvalCache& zc = zonal_eval_cache();
    const int last_i = 4 * zonal_count(degree, false) - 1;
    const float flast = last_i >= 0 ? F[last_i - 3] : 0.0f;
    // baked at the state's own a (only the mean-element rates read it, a few times a node step): a function of the
    // state alone
    const double a_c = a;
    const double e_anchor = tail_w_anchor(e);
    const bool reanchor = e_anchor != e_r;
    int64_t ka;
    std::memcpy(&ka, &a, sizeof ka);
    if (table_id == 0 || zc.table_id != table_id || zc.F != F || zc.degree != degree || zc.eq_cut != eq_cut ||
        zc.f0 != F[0] || zc.f1 != F[1] || zc.f2 != F[2] || zc.f3 != F[3] || zc.flast != flast ||
        !zc.keys_valid || ka != zc.ka || zc.e_anchor != e_anchor) {
      zc.table_id = table_id;
      zc.F = F;
      zc.degree = degree;
      zc.eq_cut = eq_cut;
      zc.f0 = F[0];
      zc.f1 = F[1];
      zc.f2 = F[2];
      zc.f3 = F[3];
      zc.flast = flast;
      zc.a_ref = a_c;
      zc.e_anchor = e_anchor;
      zc.ka = ka;
      zc.keys_valid = true;
      std::memset(zc.c, 0, sizeof(zc.c));
      auto add_p = [&](int idx, double val, int p) {
        zc.c[idx][0] += val;
        zc.c[idx][1] += p * val;
        zc.c[idx][2] += 0.5 * p * (p - 1) * val;
      };
      // Degree l's w = -k, +k entries at g; odd l weighs w = -k by -1 (sin w omega).
      // Outside the table's cell only G changes; the inclination factors stay shared.
      const TailWCoefficients* moved_coeff = reanchor ? &tail_w_moved(degree, e_anchor) : nullptr;
      auto add_k = [&](const float* g, double Ce, double Ce_a, int l, int k) {
        float moved[8];
        if (reanchor) {
          std::memcpy(moved, g, sizeof moved);
          moved[2] = moved_coeff->a[l][k]; moved[3] = moved_coeff->b[l][k];
          moved[6] = moved[2]; moved[7] = moved[3];
          g = moved;
        }
        const double sg = (l & 1) ? -1.0 : 1.0;
        const double pa = sg * g[0] * g[2] + static_cast<double>(g[4]) * g[6];
        const double pb = sg * g[0] * g[3] + static_cast<double>(g[4]) * g[7];
        const double ra = sg * g[1] * g[2] + static_cast<double>(g[5]) * g[6];
        const double rb = sg * g[1] * g[3] + static_cast<double>(g[5]) * g[7];
        const int b = 11 + 6 * (k - 2);
        add_p(b, Ce * pa, l + 1);
        add_p(b + 1, Ce * pb, l + 1);
        add_p(b + 2, Ce * ra, l + 1);
        add_p(b + 3, Ce * rb, l + 1);
        add_p(b + 4, Ce_a * pa, l + 2);
        add_p(b + 5, Ce_a * pb, l + 2);
      };
      const double iab = 1.0 / a_c, ia2b = iab * iab;
      const float* f = F;
      double Ar = kMu * ia2b * ia2b * ia2b * iab;  // mu / a^(l+1), l = 6, at the cell's center
      int l = 6;
      for (; l + 1 <= degree; l += 2) {
        if (Ar < a_cut) break;
        const double Ce = Ar * kEgmC[l][0];
        const double f0 = f[0], f1 = f[1], f2 = f[2], f3 = f[3];
        add_p(0, Ce * f0 * f3, l + 1);
        add_p(1, Ce * f1 * f2, l + 1);
        add_p(2, Ce * f1 * f3, l + 1);
        const double Ce_a = -(l + 1) * Ce * iab;
        add_p(3, Ce_a * f0 * f2, l + 2);
        add_p(4, Ce_a * f0 * f3, l + 2);
        for (int k = 2; k <= kTailW; k += 2) add_k(f + 4 + 8 * (k / 2 - 1), Ce, Ce_a, l, k);

        const double Co = Ar * iab * kEgmC[l + 1][0];
        const float* fn = f + 28;
        const float* fp = f + 32;
        const double fg0 = static_cast<double>(fp[0]) * fp[2] - static_cast<double>(fn[0]) * fn[2];
        const double fg1 = static_cast<double>(fp[0]) * fp[3] - static_cast<double>(fn[0]) * fn[3];
        const double ig0 = static_cast<double>(fp[1]) * fp[2] - static_cast<double>(fn[1]) * fn[2];
        const double ig1 = static_cast<double>(fp[1]) * fp[3] - static_cast<double>(fn[1]) * fn[3];
        add_p(5, Co * fg0, l + 2);
        add_p(6, Co * fg1, l + 2);
        add_p(7, Co * ig0, l + 2);
        add_p(8, Co * ig1, l + 2);
        const double Co_a = -(l + 2) * Co * iab;
        add_p(9, Co_a * fg0, l + 3);
        add_p(10, Co_a * fg1, l + 3);
        for (int k = 3; k <= kTailW; k += 2) add_k(f + 36 + 8 * ((k - 3) / 2), Co, Co_a, l + 1, k);
        f += 52;
        Ar *= ia2b;
      }
      if (l <= degree && Ar >= a_cut) {
        const double Ce = Ar * kEgmC[l][0];
        const double f0 = f[0], f1 = f[1], f2 = f[2], f3 = f[3];
        add_p(0, Ce * f0 * f3, l + 1);
        add_p(1, Ce * f1 * f2, l + 1);
        add_p(2, Ce * f1 * f3, l + 1);
        const double Ce_a = -(l + 1) * Ce * iab;
        add_p(3, Ce_a * f0 * f2, l + 2);
        add_p(4, Ce_a * f0 * f3, l + 2);
        for (int k = 2; k <= kTailW; k += 2) add_k(f + 4 + 8 * (k / 2 - 1), Ce, Ce_a, l, k);
      }
    }
    const double da = zc.a_ref * ia - 1.0;
    auto ev = [&](int idx) { return zc.c[idx][0] + da * (zc.c[idx][1] + da * zc.c[idx][2]); };
    const double odd_E = ev(6);
    const double odd_W = ev(5) + e * odd_E;
    const double odd_I = ev(7) + e * ev(8);
    const double odd_A_ia = ev(9) + e * ev(10);
    sW = odd_W * cw;
    sE = ev(0) + odd_E * sw;
    sI = (ev(1) + e * ev(2)) + odd_I * sw;
    sA = (ev(3) + e * ev(4)) + odd_A_ia * sw;
    {  // The terms 2 <= |w| <= kTailW (cos and sin of k omega).
      double ck[kTailW + 1], sk[kTailW + 1];
      ck[0] = 1.0;
      sk[0] = 0.0;
      for (int k = 1; k <= kTailW; ++k) {
        ck[k] = ck[k - 1] * cw - sk[k - 1] * sw;
        sk[k] = sk[k - 1] * cw + ck[k - 1] * sw;
      }
      const double e2 = e * e;
      double ekm1 = e;
      for (int k = 2; k <= kTailW; ++k) {
        const int b = 11 + 6 * (k - 2);
        const double ek = ekm1 * e;
        const double Pa = ev(b), Pb = ev(b + 1);
        const double Gp = (Pa + Pb * e2) * ek, dGp = (k * Pa + (k + 2) * Pb * e2) * ekm1;
        const double Gi = (ev(b + 2) + ev(b + 3) * e2) * ek, Ga = (ev(b + 4) + ev(b + 5) * e2) * ek;
        if (k & 1) {
          sW += k * Gp * ck[k];
          sE += dGp * sk[k];
          sI += Gi * sk[k];
          sA += Ga * sk[k];
        } else {
          sW += -k * Gp * sk[k];
          sE += dGp * ck[k];
          sI += Gi * ck[k];
          sA += Ga * ck[k];
        }
        ekm1 = ek;
      }
    }
  } else {
    double ck[72], sk[72];  // cos and sin of k omega, `wide`
    ck[0] = 1.0;
    sk[0] = 0.0;
    for (int k = 1; k <= degree; ++k) {
      ck[k] = ck[k - 1] * cw - sk[k - 1] * sw;
      sk[k] = sk[k - 1] * cw + ck[k - 1] * sw;
    }
    int idx = 0;
    for (int l = 6; l <= degree; ++l) {
      if (A < a_cut) break;
      const double C = kEgmC[l][0];
      const int wl = l;
      for (int w = -wl; w <= wl; w += 2) {
        const float* f = F + 4 * idx++;
        const int aw = w < 0 ? -w : w;
        const double sp = w < 0 ? -sk[aw] : sk[aw], cp = ck[aw];
        const double Sv = (l & 1) ? C * sp : (w == 0 ? C : C * cp);
        const double dS = (l & 1) ? C * cp : (w == 0 ? 0.0 : -C * sp);
        const double G = f[2] + f[3] * e, dG = f[3];
        sW += w * A * f[0] * G * dS;
        sE += A * f[0] * dG * Sv;
        sI += A * f[1] * G * Sv;
        sA += -(l + 1) * A * f[0] * G * Sv * ia;
      }
      A *= ia;
    }
  }
  const double na2 = n * a * a;
  const double tanhalf = sin_i / (1.0 + ci);
  six[1] += -eta * sW / (na2 * e);
  six[2] += ci * sW / (na2 * eta * sin_i);
  six[3] += (eta / na2) * sE + e * tanhalf / (na2 * eta) * sI;
  six[4] += sI / (na2 * eta);
  six[5] += -(2.0 / (n * a)) * sA + (eta * e / (na2 * (1.0 + eta))) * sE + (tanhalf / (na2 * eta)) * sI;
}

/// The shallow resonant terms. For k = 1 and each order m whose angle psi = k (omega + M) + m (Omega - theta) (q = 0,
/// l - 2p = k) drifts slower than kShallowBand x n, the terms of degree l = max(m, k).. the degree with l = k mod 2: F and
/// dF/di at the epoch inclination, G (and dG) at the epoch eccentricity, as SPEC 6 fixes them; integrated with the rates
/// (the grid resolves periods of 1 / band orbits). Until stack #477 a comment here said k = 2 and 3 "do not pay (2.13 against
/// 2.03 km at day 3)": that was a series cut at degree 31 against a 70 x 70 truth, which loses a cancellation. With
/// Terms::slow the slow set's terms follow these (kSlowDegree above): every j and q, to the field's degree, by size.
constexpr int kShallowMax = 2048;  // the largest low-table list (|q| up to 4) is 971 terms (test/slow-set-partition's sweep)

/// A shallow term as held per object (16 bytes): the Kaula indices and the epoch products in float; the
/// field coefficients are the pinned table's.
struct ShallowCoef {
  int8_t l, m, p, k;
  float fg, fdg, dfg;
};

inline res::ResCoef expand(const ShallowCoef& c) {
  res::ResCoef r{};
  r.l = c.l;
  r.m = c.m;
  r.p = c.p;
  r.k = c.k;
  r.odd = static_cast<int8_t>((c.l - c.m) & 1);
  r.C = kEgmC[c.l][c.m];
  r.S = kEgmS[c.l][c.m];
  r.fg = c.fg;
  r.fdg = c.fdg;
  r.dfg = c.dfg;
  return r;
}

struct ShallowTerms {  // the epoch scratch; xp_init keeps count entries
  int count;
  int old_count;  ///< the shallow set's own terms (the first old_count); the slow set's follow (Terms::slow)
  int over;       ///< the terms the rules select that the list could not hold (kShallowMax): 0 on every set the tests sweep
  res::ResCoef c[kShallowMax];
};
/// The epoch scratch on its thread (about 120 kB: not on the stack).
inline ShallowTerms& shallow_scratch() {
  static thread_local ShallowTerms s;
  return s;
}

/// The J2 secular rates (rad/min) at mean motion n, e and i: the commensurability of a shallow term.
struct SecularRates {
  double node, argp, mdot;
};
inline SecularRates secular_rates(double n, double e, double i) {
  const double a = std::pow(kKe / n, kX2o3), eta = std::sqrt(1.0 - e * e), p = a * eta * eta;
  const double ci = std::cos(i), j2 = 1.5 * kJ2 / (p * p);
  return {-j2 * n * ci, 0.5 * j2 * n * (5.0 * ci * ci - 1.0), n + 0.5 * j2 * n * eta * (3.0 * ci * ci - 1.0)};
}

/// The weight of a shallow (k, m) at the current elements: x = |psi-dot| / (band n), 1 below 0.9, a cos^2 taper to 0
/// at 1.1 (the hard band's cut at 1 made smooth, so a term crossing it as drag raises n fades instead of switching);
/// terms are kept at initialization out to kShallowSelect bands for that.
constexpr double kShallowSelect = 1.3;
/// The taper of x = |psi-dot| / (band n): 1 below 0.9, cos^2 to 0 at 1.1. The output table holds 1 minus it of a term the
/// rates carry (SPEC 16.18).
inline double band_taper(double x) {
  if (x <= 0.9) return 1.0;
  if (x >= 1.1) return 0.0;
  const double c = std::cos(0.5 * kPi * (x - 0.9) / 0.2);
  return c * c;
}
/// A term's own weight: (k = j, m, w = l - 2p); w = k is the shallow set's q = 0 term, its rate in the form it always had.
inline double shallow_weight(const SecularRates& sr, int k, int m, double n, int w) {
  const double psidot = w == k ? k * (sr.mdot + sr.argp) + m * (sr.node - kOmegaE) : w * sr.argp + k * sr.mdot + m * (sr.node - kOmegaE);
  return band_taper(std::fabs(psidot) / (kShallowBand * n));
}
inline double shallow_weight(const SecularRates& sr, int k, int m, double n) { return shallow_weight(sr, k, m, n, k); }

struct ShallowGroupPoly {
  int16_t k, m, w;
  double c[12][3];
};
struct ShallowEvalCache {
  static constexpr int kMaxGroups = 512;  // the slow set's (j, m, w) groups with |q| up to 4 (128 held q = 0's)
  const ShallowCoef* table = nullptr;
  uint64_t table_id = 0;
  int count = 0;
  int8_t l0 = 0, m0 = 0, llast = 0;
  float fg0 = 0.0f, fglast = 0.0f;
  double a_ref = -1.0;
  bool keys_valid = false;
  int64_t ka = 0;  ///< the bits of the a baked at (a_ref)
  int n_groups = 0;
  bool ok = false;
  ShallowGroupPoly groups[kMaxGroups]{};
};
inline thread_local ShallowEvalCache g_shallow_eval_cache{};
inline ShallowEvalCache& shallow_eval_cache() { return g_shallow_eval_cache; }

inline void shallow_six(const ShallowCoef* table, int count, double e0, double i0, double t, const Kepler& kp,
                        double a, double n, double eta, double si, double ci, double theta_g0, double* six,
                        uint64_t table_id = 0) {
  if (count <= 0) return;
  const double e = kp.e < 1e-12 ? 1e-12 : kp.e;
  const double sin_i = std::fabs(si) < 1e-12 ? (si < 0.0 ? -1e-12 : 1e-12) : si;
  const double p_sl = a * eta * eta, j2 = 1.5 * kJ2 / (p_sl * p_sl);
  const SecularRates sr{-j2 * n * ci, 0.5 * j2 * n * (5.0 * ci * ci - 1.0), n + 0.5 * j2 * n * eta * (3.0 * ci * ci - 1.0)};
  const double de = kp.e - e0, di = kp.i - i0;
  const double thetag = theta_g0 + kOmegaE * t;
  const double ia = 1.0 / a;
  ShallowEvalCache& cache = shallow_eval_cache();
  // baked at the state's own a (only the mean-element rates read it, a few times a node step): a function of the state
  // alone
  const double a_c = a;
  int64_t ka;
  std::memcpy(&ka, &a, sizeof ka);
  if (table_id == 0 || cache.table_id != table_id || cache.table != table || cache.count != count ||
      cache.l0 != table[0].l || cache.m0 != table[0].m || cache.fg0 != table[0].fg ||
      cache.llast != table[count - 1].l || cache.fglast != table[count - 1].fg ||
      !cache.keys_valid || ka != cache.ka) {
    cache.table_id = table_id;
    cache.table = table;
    cache.count = count;
    cache.l0 = table[0].l;
    cache.m0 = table[0].m;
    cache.fg0 = table[0].fg;
    cache.llast = table[count - 1].l;
    cache.fglast = table[count - 1].fg;
    cache.a_ref = a_c;
    cache.ka = ka;
    cache.keys_valid = true;
    cache.n_groups = 0;
    cache.ok = true;
    const double iab = 1.0 / a_c;
    double amp0[71];
    amp0[0] = kMu * iab;
    int lmax = 0;
    for (int j = 0; j < count; ++j) {
      if (table[j].l > lmax) lmax = table[j].l;
    }
    for (int l = 1; l <= lmax; ++l) amp0[l] = amp0[l - 1] * iab;
    int idx = 0;
    while (idx < count) {
      const int k = table[idx].k, m = table[idx].m, w = table[idx].l - 2 * table[idx].p;
      int end = idx + 1;
      while (end < count && table[end].k == k && table[end].m == m && (table[end].l - 2 * table[end].p) == w) ++end;
      if (cache.n_groups >= ShallowEvalCache::kMaxGroups) {
        cache.ok = false;
        break;
      }
      ShallowGroupPoly& gp = cache.groups[cache.n_groups++];
      gp.k = static_cast<int16_t>(k);
      gp.m = static_cast<int16_t>(m);
      gp.w = static_cast<int16_t>(w);
      std::memset(gp.c, 0, sizeof(gp.c));
      auto add_p = [&](int ci_idx, double val, int p) {
        gp.c[ci_idx][0] += val;
        gp.c[ci_idx][1] += p * val;
        gp.c[ci_idx][2] += 0.5 * p * (p - 1) * val;
      };
      for (int j = idx; j < end; ++j) {
        const ShallowCoef& sc = table[j];
        const int l = sc.l;
        const bool odd = ((l - m) & 1) != 0;
        const double C = kEgmC[l][m], S_c = kEgmS[l][m];
        const double Rc = odd ? -S_c : C, Rs = odd ? C : S_c;
        const double A0 = amp0[l];
        const double Aa0 = -(l + 1) * A0 * iab;
        add_p(0, A0 * sc.fg * Rc, l + 1);
        add_p(1, A0 * sc.fg * Rs, l + 1);
        add_p(2, A0 * sc.fdg * Rc, l + 1);
        add_p(3, A0 * sc.fdg * Rs, l + 1);
        add_p(4, A0 * sc.dfg * Rc, l + 1);
        add_p(5, A0 * sc.dfg * Rs, l + 1);
        add_p(6, Aa0 * sc.fg * Rc, l + 2);
        add_p(7, Aa0 * sc.fg * Rs, l + 2);
        add_p(8, Aa0 * sc.fdg * Rc, l + 2);
        add_p(9, Aa0 * sc.fdg * Rs, l + 2);
        add_p(10, Aa0 * sc.dfg * Rc, l + 2);
        add_p(11, Aa0 * sc.dfg * Rs, l + 2);
      }
      idx = end;
    }
  }
  double sM = 0.0, sW = 0.0, sO = 0.0, sE = 0.0, sI = 0.0, sA = 0.0;
  if (cache.ok) {
    const double da = cache.a_ref * ia - 1.0;
    for (int gi = 0; gi < cache.n_groups; ++gi) {
      const ShallowGroupPoly& gp = cache.groups[gi];
      const double wgt = shallow_weight(sr, gp.k, gp.m, n, gp.w);
      if (wgt > 0.0) {
        double sp = 0.0, cp = 1.0;
        fm::sincos(gp.w * kp.argp + gp.k * kp.m + gp.m * (kp.node - thetag), sp, cp);
        auto ev = [&](int ci_idx) { return gp.c[ci_idx][0] + da * (gp.c[ci_idx][1] + da * gp.c[ci_idx][2]); };
        const double fdg_c = ev(2), fdg_s = ev(3);
        const double dfg_c = ev(4), dfg_s = ev(5);
        const double fg_c = ev(0) + de * fdg_c + di * dfg_c;
        const double fg_s = ev(1) + de * fdg_s + di * dfg_s;
        const double afg_c = ev(6) + de * ev(8) + di * ev(10);
        const double afg_s = ev(7) + de * ev(9) + di * ev(11);
        const double fgdS = wgt * (fg_s * cp - fg_c * sp);
        sM += gp.k * fgdS;
        sW += gp.w * fgdS;
        sO += gp.m * fgdS;
        sE += wgt * (fdg_c * cp + fdg_s * sp);
        sI += wgt * (dfg_c * cp + dfg_s * sp);
        sA += wgt * (afg_c * cp + afg_s * sp);
      }
    }
  } else {
    double amp[71];
    amp[0] = kMu * ia;
    int lmax = 0;
    for (int j = 0; j < count; ++j) {
      if (table[j].l > lmax) lmax = table[j].l;
    }
    for (int l = 1; l <= lmax; ++l) amp[l] = amp[l - 1] * ia;
    int idx = 0;
    while (idx < count) {
      const int k = table[idx].k, m = table[idx].m;
      int end = idx + 1;
      while (end < count && table[end].k == k && table[end].m == m) ++end;
      // each term's own weight: the shallow set's (w = k) as it always was, the slow set's by its own rate (SPEC 16.18)
      const double wgt_k = shallow_weight(sr, k, m, n);
      {
        int last_w = 0x7fff;
        double sp = 0.0, cp = 1.0, wgt = wgt_k;
        for (int j = idx; j < end; ++j) {
          const ShallowCoef& sc = table[j];
          const int l = sc.l, w = l - 2 * sc.p;
          if (w != last_w) {
            wgt = w == k ? wgt_k : shallow_weight(sr, k, m, n, w);
            if (wgt > 0.0) fm::sincos(w * kp.argp + k * kp.m + m * (kp.node - thetag), sp, cp);
            last_w = w;
          }
          if (!(wgt > 0.0)) continue;
          const bool odd = ((l - m) & 1) != 0;
          const double C = kEgmC[l][m], S_c = kEgmS[l][m];
          const double Sv = odd ? -S_c * cp + C * sp : C * cp + S_c * sp;
          const double dSv = odd ? S_c * sp + C * cp : -C * sp + S_c * cp;
          const double A = amp[l] * wgt;
          const double fg = sc.fg + sc.fdg * de + sc.dfg * di;
          const double fgdS = A * fg * dSv;
          sM += k * fgdS;
          sW += w * fgdS;
          sO += m * fgdS;
          sE += A * sc.fdg * Sv;
          sI += A * sc.dfg * Sv;
          sA += -(l + 1) * A * fg * Sv * ia;
        }
      }
      idx = end;
    }
  }
  const double na2 = n * a * a;
  const double tanhalf = sin_i / (1.0 + ci);
  six[0] += -3.0 * ia * ia * sM;
  six[1] += (eta * eta * sM - eta * sW) / (na2 * e);
  six[2] += (ci * sW - sO) / (na2 * eta * sin_i);
  six[3] += (eta / na2) * sE + e * tanhalf / (na2 * eta) * sI;
  six[4] += sI / (na2 * eta);
  six[5] += -(2.0 / (n * a)) * sA + (eta * e / (na2 * (1.0 + eta))) * sE + (tanhalf / (na2 * eta)) * sI;
}

inline int shallow_terms(int degree, double n, double e0, double i0, ShallowTerms& out) {
  out.count = 0;
  out.over = 0;
  const int lmax = degree > 70 ? 70 : degree;
  if (lmax < 2) return 0;
  const SecularRates sr = secular_rates(n, e0, i0);
  constexpr int k = 1;  // k = 2, 3 do not pay (2.13 against 2.03 km at day 3)
  double F[72], dF[72];
  for (int m = 2; m <= lmax; ++m) {
    const double psidot = k * (sr.mdot + sr.argp) + m * (sr.node - kOmegaE);
    if (!(std::fabs(psidot) < kShallowSelect * kShallowBand * n)) continue;
    normalized_Fk_dF(m, k, lmax, i0, F, dF);
    int l0 = m > k ? m : k;
    if ((l0 - k) & 1) ++l0;
    for (int l = l0; l <= lmax; l += 2) {
      if (out.count >= kShallowMax) { ++out.over; continue; }
      const int pp = (l - k) / 2;
      double G, dG;
      if (e0 < 0.03) {
        const double lp = static_cast<double>(l);
        const double c2 = 0.25 * lp * (lp + 1.0) - static_cast<double>(k) * k;
        const double c4 = (lp * (lp + 1.0) * (lp + 2.0) * (lp + 3.0) - (8.0 * lp * (lp + 2.0) + 1.0)) * (1.0 / 64.0);
        const double e2 = e0 * e0;
        G = 1.0 + e2 * (c2 + c4 * e2);
        dG = (e0 >= 2e-4 || l <= 5) ? e0 * (2.0 * c2 + 4.0 * c4 * e2) : 0.0;
      } else {
        res::exact_G(l, pp, 0, e0, G, dG);
      }
      res::ResCoef& c = out.c[out.count++];
      c.l = static_cast<int8_t>(l);
      c.m = static_cast<int8_t>(m);
      c.p = static_cast<int8_t>(pp);
      c.k = static_cast<int8_t>(k);
      c.odd = static_cast<int8_t>((l - m) & 1);
      c.C = kEgmC[l][m];
      c.S = kEgmS[l][m];
      c.fg = F[l] * G;
      c.fdg = F[l] * dG;
      c.dfg = dF[l] * G;
    }
  }
  out.old_count = out.count;
  return out.count;
}

/// A term's angle rate (rad/min) at the J2 secular rates: psi-dot = w omega-dot + j M-dot + m (Omega-dot - theta-dot).
inline double slow_rate(const SecularRates& sr, int w, int j, int m) { return w * sr.argp + j * sr.mdot + m * (sr.node - kOmegaE); }

/// The field magnitudes retain std::hypot's rounding, including its scaling.
inline double slow_field_magnitude(int l, int m) {
  struct Table { double value[71][71]{}; bool ready[71][71]{}; };
  static thread_local Table table;
  if (!table.ready[l][m]) {
    table.value[l][m] = std::hypot(kEgmC[l][m], kEgmS[l][m]);
    table.ready[l][m] = true;
  }
  return table.value[l][m];
}

/// A slow term's along-track amplitude through the mean motion (m): 3 |j| A / (a psi-dot^2), A = mu / a^(l+1) |F G| |C, S|
/// (the potential's coefficient of the term), at the epoch elements.
inline double slow_size_m(int l, int m, int j, double fg, double a, double psidot, double amplitude = -1.0) {
  double amp = amplitude;
  if (amp < 0.0) {
    amp = kMu / a;
    for (int k = 0; k < l; ++k) amp /= a;
  }
  const double A = amp * std::fabs(fg) * slow_field_magnitude(l, m);
  const double pd = std::fabs(psidot) > 1e-15 ? std::fabs(psidot) : 1e-15;
  return 3.0 * std::abs(j) * A / (a * pd * pd) * kRe * 1e3;
}

/// A slow term's size through the eccentricity vector (m): the forced e-vector amplitude A_e / (n a^2 |psi-dot|), A_e =
/// mu / a^(l+1) |F dG/de| |C, S|, times 2 a (once per revolution along track; a radially). A term of q other than 0 has G of
/// order e^|q|, so its size through the mean motion vanishes as e does while this one does not: at e 0 a q = +-1 term acts on
/// the orbit through e and omega alone.
inline double slow_size_e_m(int l, int m, double fdg, double a, double n, double psidot, double amplitude = -1.0) {
  double amp = amplitude;
  if (amp < 0.0) {
    amp = kMu / a;
    for (int k = 0; k < l; ++k) amp /= a;
  }
  const double A = amp * std::fabs(fdg) * slow_field_magnitude(l, m);
  const double pd = std::fabs(psidot) > 1e-15 ? std::fabs(psidot) : 1e-15;
  return 2.0 * A / (n * a * pd) * kRe * 1e3;
}

/// The forecast the field's census sizes a term over (SPEC 16.20): 5 days, in minutes.
constexpr double kCensusSpanMin = 5.0 * 1440.0;
/// A term's size for the field's census (SPEC 16.20, m), A = mu / a^(l+1) |C, S| (`A`): the output table's measure at full
/// weight (sp_terms' cut) with the eccentricity vector's part counted along track (twice its radial part, as slow_size_e_m),
/// a A [|F G| (3 |j| / (a^2 psi-dot^2) + 2 (l + 1) / (n a^2 |psi-dot|)) + (2 |F dG/de| + |dF/di G|) / (n a^2 |psi-dot|)],
/// with |psi-dot| at least 2 / kCensusSpanMin: a term slower than that grows over the forecast, not past it. Through the mean
/// motion it is the slow set's measure (slow_size_m) where the term is not that slow.
inline double census_size_m(int l, int j, double A, double F, double dF, double G, double dG, double a, double n, double psidot) {
  const double ap = std::fmax(std::fabs(psidot), 2.0 / kCensusSpanMin);
  const double na2 = n * a * a;
  return a * A * (std::fabs(F * G) * (3.0 * std::abs(j) / (a * a * ap * ap) + 2.0 * (l + 1) / (na2 * ap)) +
                  (2.0 * std::fabs(F * dG) + std::fabs(dF * G)) / (na2 * ap)) * kRe * 1e3;
}

/// A slow term's G_lpq and dG/de at the epoch e (SPEC 16.18). q = 0 under e 0.03: the series to e^4. Otherwise res::exact_G,
/// whose dG below e 2e-4 is a tabulated Hansen series's, or 0 where none is tabulated (degrees above 5): there the slow set
/// takes dG as the central difference of exact_G's own G over e0 +- 2e-4 (G is analytic in e, odd or even in it with q). A term
/// of |q| 1 has G = e (l + 1 + 2 q w) / 2 + O(e^3) at small e, so its dG/de, which drives the eccentricity vector, stays of
/// order l as e goes to 0 while its G vanishes.
inline void slow_G(int l, int p, int q, int j, double e0, double& G, double& dG) {
  if (q == 0 && e0 < 0.03) {
    const double lp = static_cast<double>(l);
    const double c2 = 0.25 * lp * (lp + 1.0) - static_cast<double>(j) * j;
    const double c4 = (lp * (lp + 1.0) * (lp + 2.0) * (lp + 3.0) - (8.0 * lp * (lp + 2.0) + 1.0)) * (1.0 / 64.0);
    const double e2 = e0 * e0;
    G = 1.0 + e2 * (c2 + c4 * e2);
    dG = (e0 >= 2e-4 || l <= 5) ? e0 * (2.0 * c2 + 4.0 * c4 * e2) : 0.0;
    return;
  }
  res::exact_G(l, p, q, e0, G, dG);
  if (q != 0 && e0 < 2e-4) {
    constexpr double h = 2e-4;
    double Gp, Gm, d;
    res::exact_G(l, p, q, e0 + h, Gp, d);
    res::exact_G(l, p, q, e0 - h, Gm, d);
    dG = (Gp - Gm) / (2.0 * h);
  }
}

/// Per-eccentricity samples for the low slow set. Each recurrence, power and sum
/// uses exact_G's operand order; only values independent of a term are shared.
// Keyed by eccentricity, l, j and w; lives for one initialization call.
struct SlowExactSamples {
  struct Sample { double ar, cE, sE, cf, sf, M; };
  struct Pair { double c, s; };
  double e, inv_eta;
  mem::InitTable<Sample> samples;
  mem::InitTable<double> powers[71];
  mem::InitTable<Pair> phases[kSlowJMax + 1], waves[kSlowJMax + 2 * kSlowQMax + 1];
  explicit SlowExactSamples(double eccentricity) : e(eccentricity) {
    const int N = e < 0.01 ? 32 : e < 0.1 ? 64 : e < 0.8 ? 128 : (e < 0.95 ? 512 : 4096);
    const double eta = std::sqrt(1.0 - e * e);
    inv_eta = 1.0 / eta;
    const double dE = kTwoPi / N;
    double sdE, cdE, sE, cE;
    fm::sincos(dE, sdE, cdE);
    fm::sincos(0.5 * dE, sE, cE);
    double E = 0.5 * dE;
    if (!samples.allocate(N / 2)) return;
    for (int i = 0; i < N / 2; ++i) {
      if (i > 0) {
        const double nsE = sE * cdE + cE * sdE;
        cE = cE * cdE - sE * sdE;
        sE = nsE;
        E += dE;
      }
      const double ar = 1.0 / (1.0 - e * cE);
      samples[i] = {ar, cE, sE, (cE - e) * ar, eta * sE * ar, E - e * sE};
    }
  }
  void exact(int l, int p, int q, double& G, double& dG) {
    G = dG = 0.0;
    if (samples.empty()) return;
    const int w = l - 2 * p, j = w + q, aw = w < 0 ? -w : w;
    auto& wave = waves[w + kSlowQMax];
    auto& phase = phases[j];
    auto& power = powers[l];
    if (wave.empty()) {
      if (!wave.allocate(samples.size())) return;
      for (size_t i = 0; i < samples.size(); ++i) {
        const auto& v = samples[i];
        Pair z; res::cpow_uint(v.cf, w < 0 ? -v.sf : v.sf, aw, z.c, z.s); wave[i] = z;
      }
    }
    if (phase.empty()) {
      if (!phase.allocate(samples.size())) return;
      for (size_t i = 0; i < samples.size(); ++i) {
        Pair z; fm::sincos(j * samples[i].M, z.s, z.c); phase[i] = z;
      }
    }
    if (power.empty()) {
      if (!power.allocate(samples.size())) return;
      for (size_t i = 0; i < samples.size(); ++i) power[i] = res::pow_uint(samples[i].ar, l);
    }
    double sumG = 0.0, sumdG = 0.0;
    for (size_t i = 0; i < samples.size(); ++i) {
      const auto& v = samples[i];
      const double cp = wave[i].c * phase[i].c + wave[i].s * phase[i].s;
      const double sp = wave[i].s * phase[i].c - wave[i].c * phase[i].s;
      const double ak = power[i];
      sumG += ak * cp;
      sumdG += ak * (l * v.ar * v.cE * cp - (w * v.ar * inv_eta + j) * v.sE * sp);
    }
    const double inv_halfN = 1.0 / static_cast<int>(samples.size());
    G = sumG * inv_halfN;
    if (e >= 2e-4 && e + 2e-4 < 1.0) dG = sumdG * inv_halfN;
    else {
      double Gs;
      const res::HansenSeries* hs = res::hansen_series(l, p, q);
      if (hs != nullptr) res::series_G(*hs, e, Gs, dG);
      else dG = 0.0;
    }
  }
};

/// The low set's memo excludes m, which enters neither G nor its derivative.
// Keyed by fixed eccentricity and (j, q, l); lives for one initialization call.
struct SlowGMemo {
  struct Value { bool ready = false; double G, dG; };
  mem::InitTable<Value> values;
  std::unique_ptr<SlowExactSamples> center, plus, minus;
  explicit SlowGMemo() { values.allocate((kSlowJMax + 1) * (2 * kSlowQMax + 1) * 71); }
  void get(int l, int p, int q, int j, double e, double& G, double& dG) {
    G = dG = 0.0;
    if (values.empty()) return;
    auto& v = values[(j * (2 * kSlowQMax + 1) + q + kSlowQMax) * 71 + l];
    if (!v.ready) {
      if (q == 0 && e < 0.03) slow_G(l, p, q, j, e, v.G, v.dG);
      else {
        if (!center) center.reset(mem::counted(new (std::nothrow) SlowExactSamples(e)));
        if (!center) return;
        center->exact(l, p, q, v.G, v.dG);
        if (q != 0 && e < 2e-4) {
          constexpr double h = 2e-4;
          if (!plus) { plus.reset(mem::counted(new (std::nothrow) SlowExactSamples(e + h))); minus.reset(mem::counted(new (std::nothrow) SlowExactSamples(e - h))); }
          if (!plus || !minus) return;
          double Gp, Gm, d;
          plus->exact(l, p, q, Gp, d); minus->exact(l, p, q, Gm, d);
          v.dG = (Gp - Gm) / (2.0 * h);
        }
      }
      v.ready = true;
    }
    G = v.G; dG = v.dG;
  }
};

/// The slow set's own terms (SPEC 16.18, the low table; Terms::slow), appended to the shallow set's: every (l, m, p, q) of the
/// field to slow_degree_cap() with j = l - 2p + q from 1 to kSlowJMax and |q| up to slow_q_max() (0 as it lands) whose own rate is inside
/// kShallowSelect bands at the epoch and whose size reaches kSlowKeepM, except the shallow set's own (j = 1, q = 0, to its
/// degree). Ordered by (j, m, q), each run one (j, m, w) group of the evaluation. Returns the count of the whole list.
inline int slow_terms_low(int shallow_degree, double n, double e0, double i0, ShallowTerms& out) {
  const int L = slow_degree_cap() < kSlowDegree ? slow_degree_cap() : kSlowDegree;
  if (L < 2) return out.count;
  const SecularRates sr = secular_rates(n, e0, i0);
  const double a = std::pow(kKe / n, kX2o3), band = kShallowSelect * kShallowBand * n;
  const int qmax = slow_q_max() < 0 ? 0 : slow_q_max() > kSlowQMax ? kSlowQMax : slow_q_max();
  const auto mem_mark = mem::thread_failures();
  SlowGMemo gmemo;
  if (mem::thread_failures() != mem_mark) return -1;
  NormalizedFkSamples inclination;
  double amplitudes[71];
  amplitudes[0] = kMu / a;
  for (int l = 1; l <= L; ++l) amplitudes[l] = amplitudes[l - 1] / a;
  double F[72], dF[72];
  for (int j = 1; j <= kSlowJMax; ++j)
    for (int m = 2; m <= L; ++m)
      for (int q = -qmax; q <= qmax; ++q) {
        const int w = j - q;
        const double psidot = slow_rate(sr, w, j, m);
        if (!(std::fabs(psidot) < band)) continue;
        const int aw = w < 0 ? -w : w;
        int l0 = m > aw ? m : aw;
        if (l0 < 2) l0 = 2;
        if ((l0 - w) & 1) ++l0;
        if (l0 > L) continue;
        // a family whose series the embedded field ends after one or two degrees (leading degree 69 or 70): left out, a limit of
        // the field, not of the method (AP and a numerical propagator at 70 x 70 would both hold a series the real field continues)
        if (l0 >= kSlowDegree - 1) continue;
        normalized_Fk_dF(m, w, L, i0, F, dF, &inclination);
        if (mem::thread_failures() != mem_mark) return -1;
        for (int l = l0; l <= L; l += 2) {
          if (j == 1 && q == 0 && l <= shallow_degree) continue;  // the shallow set's own term
          const int pp = (l - w) / 2;
          if (pp < 0 || pp > l) continue;
          double G, dG;
          gmemo.get(l, pp, q, j, e0, G, dG);
          if (mem::thread_failures() != mem_mark) return -1;
          // the larger of its size through the mean motion and through the eccentricity vector reaches the cut
          if (slow_size_m(l, m, j, F[l] * G, a, psidot, amplitudes[l]) < kSlowKeepM && slow_size_e_m(l, m, F[l] * dG, a, n, psidot, amplitudes[l]) < kSlowKeepM) continue;
          if (out.count >= kShallowMax) { ++out.over; continue; }  // counted: the diagnostic lists such a term as code 7
          res::ResCoef& c = out.c[out.count++];
          c.l = static_cast<int8_t>(l);
          c.m = static_cast<int8_t>(m);
          c.p = static_cast<int8_t>(pp);
          c.k = static_cast<int8_t>(j);
          c.odd = static_cast<int8_t>((l - m) & 1);
          c.C = kEgmC[l][m];
          c.S = kEgmS[l][m];
          c.fg = F[l] * G;
          c.fdg = F[l] * dG;
          c.dfg = dF[l] * G;
        }
      }
  return out.count;
}

/// Every class above its eccentricity switch outside low orbit (SPEC 16.18; stack #473): the slow terms its own rates do not
/// carry, in the rates. Every (l, m, p, q) of the field to `degree` (the grid's: a family's slow harmonics without its fast
/// ones, which nothing carries above the grid's degree, put a transfer orbit further from the numerical propagator, 134 to
/// 165 m at degree 31) whose own rate at the epoch (J2 secular rates, as
/// the grid takes them) is inside kShallowSelect bands and whose size reaches kSlowKeepM, except the class's terms, the
/// half-day class's tail (16.2) and the m-daily terms (w = j = 0); the grid leaves out band_taper of each slow harmonic, the
/// share these carry (wide_families). The angle's own rate is the flight's (the Sun and Moon move omega and Omega on a high
/// orbit as much as J2 does), which a first-order term on the grid cannot follow. Ordered by (m, w, j), each run of l one
/// group of the evaluation (wide_slow_six); j at most 127 (the table's index). *out (malloc'd, the caller's) holds the
/// terms; returns their count, or -1 out of memory.
inline int slow_terms_wide(int degree, int cls, double n, double e0, double i0, res::ResCoef** out) {
  *out = nullptr;
  int count = 0, room = 0;
  const int L = degree < slow_degree_cap() ? degree : slow_degree_cap();
  const SecularRates sr = secular_rates(n, e0, i0);
  const double a = std::pow(kKe / n, kX2o3), band = kShallowSelect * kShallowBand * n;
  const res::TermSet carried = res::class_terms(cls);
  double amplitudes[71];
  amplitudes[0] = kMu / a;
  for (int l = 1; l <= L; ++l) amplitudes[l] = amplitudes[l - 1] / a;
  double F[72], dF[72];
  for (int m = 1; m <= L; ++m)
    for (int w = -L; w <= L; ++w) {
      const int aw = w < 0 ? -w : w;
      int l0 = m > aw ? m : aw;
      if (l0 < 2) l0 = 2;
      if ((l0 - aw) & 1) ++l0;
      if (l0 > L || l0 >= kSlowDegree - 1) continue;  // a family the embedded field ends at once (slow_terms_low)
      const double nu = -(w * sr.argp + m * (sr.node - kOmegaE)) / sr.mdot;
      const int jlo = static_cast<int>(std::floor(nu - band / sr.mdot)) - 1, jhi = static_cast<int>(std::ceil(nu + band / sr.mdot)) + 1;
      bool any = false;
      for (int j = jlo; j <= jhi && !any; ++j) any = std::fabs(slow_rate(sr, w, j, m)) < band && !(w == 0 && j == 0);
      if (!any) continue;
      normalized_Fk_dF(m, w, L, i0, F, dF);
      for (int j = jlo; j <= jhi; ++j) {
        const double psidot = slow_rate(sr, w, j, m);
        if (!(std::fabs(psidot) < band) || (w == 0 && j == 0) || j < -127 || j > 127) continue;
        const int q = j - w;
        for (int l = l0; l <= L; l += 2) {
          const int pp = (l - w) / 2;
          if (pp < 0 || pp > l) continue;
          bool own = cls == 2 && l > 5 && (m & 1) == 0 && j == m / 2;
          for (int t = 0; t < carried.count && !own; ++t)
            own = carried.t[t].l == l && carried.t[t].m == m && carried.t[t].p == pp && carried.t[t].q == q;
          if (own) continue;
          double G, dG;
          res::exact_G(l, pp, q, e0, G, dG);
          if (!std::isfinite(F[l] * G) || !std::isfinite(F[l] * dG) || !std::isfinite(dF[l] * G)) continue;
          if (!(slow_size_m(l, m, j, F[l] * G, a, psidot, amplitudes[l]) >= kSlowKeepM)) continue;
          if (count == room) {
            room = room == 0 ? 256 : 2 * room;
            res::ResCoef* grown = static_cast<res::ResCoef*>(sdnap::mem::realloc(*out, static_cast<size_t>(room) * sizeof(res::ResCoef)));
            if (grown == nullptr) {
              std::free(*out);
              *out = nullptr;
              return -1;
            }
            *out = grown;
          }
          res::ResCoef& c = (*out)[count++];
          c.l = static_cast<int8_t>(l);
          c.m = static_cast<int8_t>(m);
          c.p = static_cast<int8_t>(pp);
          c.k = static_cast<int8_t>(j);
          c.odd = static_cast<int8_t>((l - m) & 1);
          c.C = kEgmC[l][m];
          c.S = kEgmS[l][m];
          c.fg = F[l] * G;
          c.fdg = F[l] * dG;
          c.dfg = dF[l] * G;
        }
      }
    }
  return count;
}

/// SPEC 16.18 (stack #473): the rates of a set's slow terms above its switch (slow_terms_wide), Lagrange's equations at the
/// current elements with F G moved linearly from e_0 and i_0, each (j, m, w) weighted by band_taper of its own rate at the
/// J2 secular rates (the grid leaves out the rest of each harmonic, wide_families); in double, as the terms' F G reach the
/// float's range at high degree and eccentricity.
inline void wide_slow_six(const res::ResCoef* table, int count, double e0, double i0, double t, const Kepler& kp, double a,
                          double n, double eta, double si, double ci, double theta_g0, double* six) {
  if (count <= 0) return;
  const double e = kp.e < 1e-12 ? 1e-12 : kp.e;
  const double sin_i = std::fabs(si) < 1e-12 ? (si < 0.0 ? -1e-12 : 1e-12) : si;
  const double p_sl = a * eta * eta, j2 = 1.5 * kJ2 / (p_sl * p_sl);
  const SecularRates sr{-j2 * n * ci, 0.5 * j2 * n * (5.0 * ci * ci - 1.0), n + 0.5 * j2 * n * eta * (3.0 * ci * ci - 1.0)};
  const double de = kp.e - e0, di = kp.i - i0, thetag = theta_g0 + kOmegaE * t, ia = 1.0 / a;
  double amp[72];
  amp[0] = kMu * ia;
  for (int l = 1; l <= 71; ++l) amp[l] = amp[l - 1] * ia;
  double sM = 0.0, sW = 0.0, sO = 0.0, sE = 0.0, sI = 0.0, sA = 0.0;
  int gk = 0x7fff, gm = 0x7fff, gw = 0x7fff;
  double wgt = 0.0, sp = 0.0, cp = 1.0;
  for (int q = 0; q < count; ++q) {
    const res::ResCoef& c = table[q];
    const int l = c.l, m = c.m, k = c.k, w = l - 2 * c.p;
    if (k != gk || m != gm || w != gw) {
      gk = k;
      gm = m;
      gw = w;
      wgt = band_taper(std::fabs(slow_rate(sr, w, k, m)) / (kShallowBand * n));
      if (wgt > 0.0) fm::sincos(w * kp.argp + k * kp.m + m * (kp.node - thetag), sp, cp);
    }
    if (!(wgt > 0.0)) continue;
    const double Sv = c.odd ? -c.S * cp + c.C * sp : c.C * cp + c.S * sp;
    const double dSv = c.odd ? c.S * sp + c.C * cp : -c.C * sp + c.S * cp;
    const double A = amp[l] * wgt;
    const double fg = c.fg + c.fdg * de + c.dfg * di;
    const double fgdS = A * fg * dSv;
    sM += k * fgdS;
    sW += w * fgdS;
    sO += m * fgdS;
    sE += A * c.fdg * Sv;
    sI += A * c.dfg * Sv;
    sA += -(l + 1) * A * fg * Sv * ia;
  }
  const double na2 = n * a * a, tanhalf = sin_i / (1.0 + ci);
  six[0] += -3.0 * ia * ia * sM;
  six[1] += (eta * eta * sM - eta * sW) / (na2 * e);
  six[2] += (ci * sW - sO) / (na2 * eta * sin_i);
  six[3] += (eta / na2) * sE + e * tanhalf / (na2 * eta) * sI;
  six[4] += sI / (na2 * eta);
  six[5] += -(2.0 / (n * a)) * sA + (eta * e / (na2 * (1.0 + eta))) * sE + (tanhalf / (na2 * eta)) * sI;
}

/// Whether the slow set's list holds (l, m, p, q) beyond the shallow set's own terms (the output table yields it).
inline bool slow_holds(const ShallowTerms* held, int l, int m, int p, int q) {
  if (held == nullptr) return false;
  for (int k = held->old_count; k < held->count; ++k) {
    const res::ResCoef& c = held->c[k];
    if (c.l == l && c.m == m && c.p == p && c.k - (c.l - 2 * c.p) == q) return true;
  }
  return false;
}
/// sp_terms' complement (the low table's fast side): per order m and w + 17, the highest degree above `degree` of a term the
/// slow set holds beyond the shallow set's with q of -1, 0 or 1 (0: none); returns the highest such order.
inline int slow_complement_lmax(const ShallowTerms* held, int degree, int8_t (&lmax)[72][35]) {
  std::memset(lmax, 0, sizeof(lmax));
  int top = 0;
  for (int k = held->old_count; k < held->count; ++k) {
    const res::ResCoef& c = held->c[k];
    const int l = c.l, m = c.m, w = c.l - 2 * c.p, q = c.k - w;
    if (l <= degree || l > kFastCap || m < 1 || m > kFastCap || q < -1 || q > 1 || w < -kSpMaxW || w > kSpMaxW) continue;
    if (l > lmax[m][w + 17]) lmax[m][w + 17] = static_cast<int8_t>(l);
    if (m > top) top = m;
  }
  return top;
}

/// SPEC 16.18's diagnostic, the low table (sdnap_slow_terms): every term of j = 1 to kSlowJMax, |q| up to kSlowQMax, orders
/// and degrees to 70 whose own rate at the epoch is inside kShallowSelect bands, for a set of epoch mean motion n (rad/min), e,
/// i (rad) and the stated tesseral degree `cap`. Rows of 8 doubles: l, m, p, q, psi-dot / n, the carrier (1 the rates,
/// 3 the output table, 0 nowhere: under the table's 1e-3 n floor, 4 nowhere: above the slow set's degree or in a family whose
/// leading degree is 69 or 70 (the embedded field ends its series at once), 5 nowhere: under
/// the size cut, 6 nowhere: a q outside the slow set's q range, at or above the size cut, 7 nowhere: a term the rules select
/// that the list's capacity (kShallowMax) could not hold, 0 rows on every set the tests sweep), the rates'
/// weight w (the band taper at these elements; the output table holds 1 - w of a term the rates carry) and the term's size (m,
/// slow_size_m). At most max_rows written; returns the count of all rows.
inline int slow_listing_low(int cap, double n, double e0, double i0, double* rows, int max_rows) {
  const int sd = cap > kShallowCap ? kShallowCap : cap;
  ShallowTerms& sc = shallow_scratch();
  shallow_terms(sd, n, e0, i0, sc);
  slow_terms_low(sd, n, e0, i0, sc);
  const SecularRates sr = secular_rates(n, e0, i0);
  const double a = std::pow(kKe / n, kX2o3), band = kShallowBand * n;
  const int Lcap = slow_degree_cap() < kSlowDegree ? slow_degree_cap() : kSlowDegree;
  double F[72], dF[72];
  int count = 0;
  const auto emit = [&](int l, int m, int p, int q, double psidot, int carrier, double w, double size) {
    if (count < max_rows) {
      double* r = rows + 8 * count;
      r[0] = l; r[1] = m; r[2] = p; r[3] = q; r[4] = psidot / n; r[5] = carrier; r[6] = w; r[7] = size;
    }
    ++count;
  };
  for (int j = 1; j <= kSlowJMax; ++j)
    for (int m = 2; m <= kSlowDegree; ++m)
      for (int q = -kSlowQMax; q <= kSlowQMax; ++q) {
        const int w = j - q;
        const double psidot = slow_rate(sr, w, j, m);
        if (!(std::fabs(psidot) < kShallowSelect * band)) continue;
        const int aw = w < 0 ? -w : w;
        int l0 = m > aw ? m : aw;
        if (l0 < 2) l0 = 2;
        if ((l0 - w) & 1) ++l0;
        if (l0 > kSlowDegree) continue;
        normalized_Fk_dF(m, w, kSlowDegree, i0, F, dF);
        const double wt = band_taper(std::fabs(psidot) / band);
        for (int l = l0; l <= kSlowDegree; l += 2) {
          const int p = (l - w) / 2;
          if (p < 0 || p > l) continue;
          double G, dG;
          slow_G(l, p, q, j, e0, G, dG);  // as slow_terms_low takes it
          // the larger of the term's sizes through the mean motion and through the eccentricity vector (slow_terms_low's cut)
          const double size = std::max(slow_size_m(l, m, j, F[l] * G, a, psidot), slow_size_e_m(l, m, F[l] * dG, a, n, psidot));
          bool held = false;
          for (int k = 0; !held && k < sc.count; ++k) {
            const res::ResCoef& c = sc.c[k];
            held = c.l == l && c.m == m && c.p == p && c.k == j && c.k - (c.l - 2 * c.p) == q;
          }
          if (held) { emit(l, m, p, q, psidot, 1, wt, size); continue; }
          // above the slow set's degree, or a family whose series the field ends at once (leading degree 69 or 70)
          if (l > Lcap || l0 >= kSlowDegree - 1) { emit(l, m, p, q, psidot, 4, 0.0, size); continue; }
          // a term the shallow set's or the slow set's rule selects that the list could not hold (kShallowMax)
          if ((j == 1 && q == 0 && l <= sd) || (std::abs(q) <= slow_q_max() && size >= kSlowKeepM)) { emit(l, m, p, q, psidot, 7, 0.0, size); continue; }
          const bool on_table = j == 1 && (q >= -1 && q <= 1) && m <= sd && l <= sd;
          if (on_table && std::fabs(psidot) >= 1e-3 * n) { emit(l, m, p, q, psidot, 3, 0.0, size); continue; }
          if (on_table) { emit(l, m, p, q, psidot, 0, 0.0, size); continue; }
          if (std::abs(q) > slow_q_max() && size >= kSlowKeepM) { emit(l, m, p, q, psidot, 6, 0.0, size); continue; }
          emit(l, m, p, q, psidot, 5, 0.0, size);
        }
      }
  return count;
}

/// Where a set on the grid (above its eccentricity switch, outside low orbit) carries each slow tesseral term, by the grid's
/// own rules (wide_families; SPEC 16.18): every (l, m, p, q) of degree 2 to `cap` whose angle drifts slower than kShallowBand n
/// at the set's epoch (J2 secular rates, as the grid takes them). Row of 8 (16.18's): l, m, p, q, psi-dot / n, carrier
/// (1 the rates: the class's own terms, or every other at or above kSlowKeepM, slow_terms_wide; 4 carried nowhere: above the
/// grid's degree, kSpCap, or j beyond 127; 5 carried nowhere: under the size cut), the rates' weight w (1 for the class's
/// terms, band_taper of the term's rate for the others, the grid holding 1 - w) and the term's size (slow_size_m, G exact
/// at the epoch e).
/// Writes at most max_rows rows; returns the count of all of them, or -1 for a set it does not cover. `cls` the epoch class
/// (res::band_of), n rad/min, inc rad. A diagnostic: no flight reads it.
inline int slow_terms(int cap, int cls, double n, double e, double inc, double* rows, int max_rows) {
  const bool low = cls == 0 && kTwoPi / n < kLongPeriodMinutes;
  if (!wide_set(cls, e) || low) return -1;
  const SecularRates sr = secular_rates(n, e, inc);
  const double a = std::pow(kKe / n, kX2o3), band = kShallowBand * n;
  const res::TermSet carried = res::class_terms(cls);
  const int grid_degree = cap > kSpCap ? kSpCap : cap;
  double F[72], dF[72];
  int count = 0;
  for (int m = 1; m <= cap; ++m)
    for (int w = -cap; w <= cap; ++w) {
      const double nu = -(w * sr.argp + m * (sr.node - kOmegaE)) / sr.mdot;
      const int jlo = static_cast<int>(std::floor(nu - band / sr.mdot)) - 1;
      const int jhi = static_cast<int>(std::ceil(nu + band / sr.mdot)) + 1;
      bool any = false;
      for (int j = jlo; j <= jhi && !any; ++j) any = std::fabs(slow_rate(sr, w, j, m)) < band && !(w == 0 && j == 0);
      const int aw = w < 0 ? -w : w;
      int l0 = m > aw ? m : aw;
      if (l0 < 2) l0 = 2;
      if ((l0 - aw) & 1) ++l0;
      if (!any || l0 > cap) continue;
      normalized_Fk_dF(m, w, cap, inc, F, dF);
      for (int l = l0; l <= cap; l += 2) {
        const int p = (l - w) / 2;
        for (int j = jlo; j <= jhi; ++j) {
          const double psidot = slow_rate(sr, w, j, m);
          if (!(std::fabs(psidot) < band) || (w == 0 && j == 0)) continue;
          const int q = j - w;
          int where = -1;
          for (int t = 0; t < carried.count && where < 0; ++t)
            if (carried.t[t].l == l && carried.t[t].m == m && carried.t[t].p == p && carried.t[t].q == q) where = 1;
          if (where < 0 && cls == 2 && l > 5 && (m & 1) == 0 && j == m / 2) where = 1;  // the half-day tail (16.2)
          const bool own = where == 1;
          double G, dG;
          res::exact_G(l, p, q, e, G, dG);
          const double size = slow_size_m(l, m, j, F[l] * G, a, psidot);
          // every other slow term: the rates (slow_terms_wide) at or above the size cut, nowhere under it (stack #473)
          if (where < 0) where = l > grid_degree || j < -127 || j > 127 ? 4 : size >= kSlowKeepM ? 1 : 5;
          if (count < max_rows) {
            double* r = rows + 8 * count;
            r[0] = l; r[1] = m; r[2] = p; r[3] = q; r[4] = psidot / n; r[5] = where;
            r[6] = own ? 1.0 : where == 1 ? band_taper(std::fabs(psidot) / band) : 0.0;
            r[7] = size;
          }
          ++count;
        }
      }
    }
  return count;
}

/// Above kWideE (SPEC 16.11) the first-order tesseral short-periodics of degree 2 to kSpCap are not a series in M. For each
/// (l, m, p), sum_q G_lpq e^{i (w + q) M} = (a/r)^(l+1) e^{i w f}, so each (m, w) family's displacement is a periodic
/// function of the anomaly, complete in j: built on kGridNE uniform eccentric anomalies from the family's forcing (Lagrange's
/// equations), integrated by H = e^{-i nu e sin E} IFFT(FFT(R (1 - e cos E) e^{i nu e sin E}) / (i (k - nu))) / M-dot with
/// nu = -(w omega-dot + m (Omega-dot - omega_E)) / M-dot, the harmonics the table's rules leave out (m-daily, the class's, the
/// half-day class's tail, |psi-dot| < kShallowBand n) subtracted, and kept on kGridN of them (single precision) with its first derivatives in e, i and
/// a / a0 on kGridD (half precision).
constexpr int kGridN = 128, kGridNE = 128, kGridD = 64;
constexpr double kGridDe = 1e-4, kGridDi = 1e-4, kGridDa = 1e-5;  // the forward differences of the derivative grids
/// A grid is built at the set's mean elements at every kGridEvery minutes from its epoch (the same nodes for every set of a fit) and
/// blended linearly into the next node's over the last kGridBlend of each interval.
constexpr double kGridEvery = 48.0 * 60.0, kGridBlend = 0.2;
/// A copy initialized inside its nominal set's xpt::GridShareScope reads the nominal's grids, linearly in the offsets, when its mean
/// elements lie this close to theirs (the covariance's sigma sets); otherwise it takes its own.
constexpr double kShareE = 3e-4, kShareI = 1e-4, kShareA = 1e-4;
struct WideGrid {
  int degree;         // the families' highest degree
  int count;          // (m, w) families
  double n, e, i, a;  // the mean elements it was built at
  int8_t* m;
  int8_t* w;
  float* v;           // count x 6 x kGridN x (re, im, slope re, slope im): the value and its slope in E per node
  uint16_t* dv;       // count x 3 (d/de, d/di, d/(da/a)) x 6 x kGridD x (re, im), half precision
  size_t alloc_bytes; // the bytes the grid holds as allocated: its block (sized for every family of its degree) and the WideGrid
};

/// IEEE half precision, round to nearest even; finite inputs below 65504 in magnitude.
inline uint16_t to_half(float f) {
  uint32_t x;
  std::memcpy(&x, &f, 4);
  const uint32_t sign = (x >> 16) & 0x8000u;
  const int32_t exp = static_cast<int32_t>((x >> 23) & 0xff) - 127 + 15;
  uint32_t mant = x & 0x7fffffu;
  if (exp <= 0) {
    if (exp < -10) return static_cast<uint16_t>(sign);
    mant |= 0x800000u;
    const int shift = 14 - exp;
    uint32_t h = mant >> shift;
    const uint32_t rem = mant & ((1u << shift) - 1), half = 1u << (shift - 1);
    if (rem > half || (rem == half && (h & 1u))) ++h;
    return static_cast<uint16_t>(sign | h);
  }
  if (exp >= 31) return static_cast<uint16_t>(sign | 0x7bffu);
  uint32_t h = (static_cast<uint32_t>(exp) << 10) | (mant >> 13);
  const uint32_t rem = mant & 0x1fffu;
  if (rem > 0x1000u || (rem == 0x1000u && (h & 1u))) ++h;
  return static_cast<uint16_t>(sign | h);
}
inline float from_half(uint16_t h) {
  const uint32_t sign = static_cast<uint32_t>(h & 0x8000u) << 16;
  int32_t exp = (h >> 10) & 0x1f;
  uint32_t mant = h & 0x3ffu;
  uint32_t x;
  if (exp == 0) {
    if (mant == 0) x = sign;
    else {
      exp = 1;
      while ((mant & 0x400u) == 0) { mant <<= 1; --exp; }
      mant &= 0x3ffu;
      x = sign | (static_cast<uint32_t>(exp - 15 + 127) << 23) | (mant << 13);
    }
  } else {
    x = sign | (static_cast<uint32_t>(exp - 15 + 127) << 23) | (mant << 13);
  }
  float f;
  std::memcpy(&f, &x, 4);
  return f;
}
/// from_half for every half, filled once (idempotent: concurrent fillers write the same values).
inline const float* half_table() {
  static float table[65536];
  static int32_t ready = 0;
  if (__atomic_load_n(&ready, __ATOMIC_ACQUIRE) == 0) {
    for (uint32_t h = 0; h < 65536; ++h) table[h] = from_half(static_cast<uint16_t>(h));
    __atomic_store_n(&ready, 1, __ATOMIC_RELEASE);
  }
  return table;
}

inline void fft_inplace(double* re, double* im, int n, bool inverse) {
  for (int i = 1, j = 0; i < n; ++i) {
    int bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { std::swap(re[i], re[j]); std::swap(im[i], im[j]); }
  }
  for (int len = 2; len <= n; len <<= 1) {
    const double ang = (inverse ? 2.0 : -2.0) * kPi / len;
    const double wr = std::cos(ang), wi = std::sin(ang);
    for (int i = 0; i < n; i += len) {
      double cr = 1.0, ci = 0.0;
      for (int j = 0; j < len / 2; ++j) {
        const int a = i + j, b = a + len / 2;
        const double vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr; im[a] += vi;
        const double t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/// The share of the harmonic (l, m, p, q = j - w) that a family grid leaves out of its forcing (sp_terms' weight_of, 1 - its
/// weight, harmonic by harmonic), carried elsewhere: the m-daily terms (w = j = 0); the half-day tail, in the half-day class's
/// rates (16.2); the class's terms (`carried`); and inside the slow band (`in_band`, |psi-dot| = `ap` within the family's
/// kShallowBand n), in low orbit (class 0, a period below 1,100 min: `low`) only the shallow set's terms (q = 0, w = j = 1, which
/// the rates carry with the same taper) and the terms slower than 1e-3 n; above the switch, in every class, the share the
/// rates carry, band_taper (slow_terms_wide, stack #473). The grid builds on it and the field's census (16.20) reads it.
inline double wide_left_out(int cls, bool low, const res::TermSet& carried, int l, int m, int p, int w, int j, bool in_band,
                            double ap, double n) {
  const int q = j - w;
  double out_ = w == 0 && j == 0 ? 1.0 : 0.0;
  if (cls == 2 && l > 5 && (m & 1) == 0 && j == m / 2) out_ = 1.0;
  for (int t = 0; t < carried.count && out_ == 0.0; ++t)
    if (carried.t[t].l == l && carried.t[t].m == m && carried.t[t].p == p && carried.t[t].q == q) out_ = 1.0;
  if (out_ == 0.0 && in_band) {
    const double x = ap / (kShallowBand * n);
    // above the switch every class carries every other slow term in its rates too (slow_terms_wide, stack #473): the grid
    // leaves out the share the rates carry, band_taper (SPEC 16.18 states the one-day class's rule before it)
    if (!low) out_ = band_taper(x);
    else if (q == 0 && w == 1 && j == 1) {
      const double cc = std::cos(0.5 * kPi * (x - 0.9) / 0.2);
      out_ = x <= 0.9 ? 1.0 : x < 1.1 ? cc * cc : 0.0;
    } else out_ = ap < 1e-3 * n ? 1.0 : 0.0;
  }
  return out_;
}

/// One set of family grids at (n, e, i): out[f][6][kGridN] complex (re, im interleaved), families in (m, w) order with any
/// forcing; returns the count. `cls`: the class whose terms the rates carry.
inline int wide_families(int degree, int cls, double n, double e, double inc, int8_t* fm_out, int8_t* fw_out, double* out) {
  const double eta = std::sqrt(1.0 - e * e), a = std::pow(kKe / n, kX2o3), p0 = a * eta * eta;
  const double c = std::cos(inc), si = std::sin(inc), j2 = 1.5 * kJ2 / (p0 * p0);
  const double mdot = n + 0.5 * j2 * n * eta * (3.0 * c * c - 1.0), wdot = 0.5 * j2 * n * (5.0 * c * c - 1.0);
  const double node_rate = -j2 * n * c, na2 = n * a * a;
  constexpr int NE = kGridNE;
  // every array of the anomalies on the heap (stack #497: no array sized by the node count on the stack): the 11 complex
  // working rows, then E, M, cos f, sin f, a/r, sin E, f and the phase's cosine and sine
  double* ws = static_cast<double*>(sdnap::mem::malloc(static_cast<size_t>(11 * 2 + 9) * NE * sizeof(double)));
  if (ws == nullptr) return -1;
  double* const E = ws + 22 * NE;
  double* const M = E + NE;
  double* const cf = M + NE;
  double* const sf = cf + NE;
  double* const ar = sf + NE;
  double* const sE = ar + NE;
  double* const fwang = sE + NE;
  double* const cph_ = fwang + NE;
  double* const sph_ = cph_ + NE;
  for (int k = 0; k < NE; ++k) {
    E[k] = kTwoPi * k / NE;
    sE[k] = std::sin(E[k]);
    M[k] = E[k] - e * sE[k];
    ar[k] = 1.0 / (1.0 - e * std::cos(E[k]));
    cf[k] = (std::cos(E[k]) - e) * ar[k];
    sf[k] = eta * sE[k] * ar[k];
    fwang[k] = std::atan2(sf[k], cf[k]);
  }
  const res::TermSet carried = res::class_terms(cls);
  const bool low = cls == 0 && kTwoPi / n < kLongPeriodMinutes;  // sp_terms' `low`: no class, the shallow set active
  const double h = 1e-5;
  double f[72], fp[72], fmn[72];
  double (*gr)[2][NE] = reinterpret_cast<double (*)[2][NE]>(ws);           // g', g, g_e, g_i, g_a
  double (*D)[2][NE] = reinterpret_cast<double (*)[2][NE]>(ws + 5 * 2 * NE);  // their transforms and H[H[g]]
  double (*X)[NE] = reinterpret_cast<double (*)[NE]>(ws + 10 * 2 * NE);
  int count = 0;
  for (int m = 1; m <= degree; ++m)
    for (int w = -degree; w <= degree; ++w) {
      for (int z = 0; z < 5; ++z) for (int q = 0; q < NE; ++q) gr[z][0][q] = gr[z][1][q] = 0.0;  // g', g, g_e, g_i, g_a
      int l0 = m > (w < 0 ? -w : w) ? m : (w < 0 ? -w : w);
      if (l0 < 2) l0 = 2;
      if (((l0 - w) & 1) != 0) ++l0;
      if (l0 > degree) continue;
      normalized_Fk(m, w, degree, inc, f);
      normalized_Fk(m, w, degree, inc + h, fp);
      normalized_Fk(m, w, degree, inc - h, fmn);
      const double nu = -(w * wdot + m * (node_rate - kOmegaE)) / mdot;
      // per degree: A (Cbar - i Sbar) for even l - m, A (-Sbar - i Cbar) for odd, times Fbar and dFbar/di
      double Sr[72], Si[72], Fl[72], dFl[72];
      for (int l = l0; l <= degree; l += 2) {
        const bool odd = ((l - m) & 1) != 0;
        const double A = kMu * std::pow(1.0 / a, l + 1);
        Sr[l] = A * (odd ? -kEgmS[l][m] : kEgmC[l][m]);
        Si[l] = A * (odd ? -kEgmC[l][m] : -kEgmS[l][m]);
        Fl[l] = f[l];
        dFl[l] = (fp[l] - fmn[l]) / (2.0 * h);
      }
      for (int q = 0; q < NE; ++q) {
        // the sums over l of (a/r)^(l+1) times the degree's coefficients, then e^{i w f} once
        double p = std::pow(ar[q], l0 + 1);
        const double ar2 = ar[q] * ar[q];
        double s0r = 0, s0i = 0, sir = 0, sii = 0, sar = 0, sai = 0, skr = 0, ski = 0;
        for (int l = l0; l <= degree; l += 2) {
          const double br = Sr[l] * p, bi = Si[l] * p;
          s0r += Fl[l] * br; s0i += Fl[l] * bi;                          // g
          skr += (l + 1) * Fl[l] * br; ski += (l + 1) * Fl[l] * bi;      // sum (l + 1) g_l
          sir += dFl[l] * br; sii += dFl[l] * bi;                        // g_i
          sar += -(l + 1) / a * Fl[l] * br; sai += -(l + 1) / a * Fl[l] * bi;  // g_a
          p *= ar2;
        }
        const double ang = w * fwang[q], cw = std::cos(ang), sw = std::sin(ang);
        const auto rot = [&](double xr, double xi, double& yr, double& yi) { yr = xr * cw - xi * sw; yi = xr * sw + xi * cw; };
        double gR, gI, kR, kI;
        rot(s0r, s0i, gR, gI);
        rot(skr, ski, kR, kI);
        gr[1][0][q] = gR; gr[1][1][q] = gI;
        rot(sir, sii, gr[3][0][q], gr[3][1][q]);
        rot(sar, sai, gr[4][0][q], gr[4][1][q]);
        // d/dM: (a/r)^2 (-(l + 1) e sin E + i w eta) per degree
        gr[0][0][q] = ar2 * (-e * sE[q] * kR - w * eta * gI);
        gr[0][1][q] = ar2 * (-e * sE[q] * kI + w * eta * gR);
        // d/de: (l + 1) (a/r) cos f + i w sin f (2 + e cos f) / eta^2 per degree
        const double ei = w * sf[q] * (2.0 + e * cf[q]) / (eta * eta);
        gr[2][0][q] = ar[q] * cf[q] * kR - ei * gI;
        gr[2][1][q] = ar[q] * cf[q] * kI + ei * gR;
      }
      // the harmonics the table's rules leave out (sp_terms' weight_of, the same rule harmonic by harmonic: 0.6.3 to 0.6.10 left
      // the whole slow band out in low orbit too, where neither the table nor the shallow set carries its q != 0 terms; #393),
      // from each forcing function: m-daily (w = j = 0), the class's, the half-day
      // tail, the slow band
      for (int l = l0; l <= degree; l += 2) {
        const int p = (l - w) / 2;
        const double F = f[l], dF = (fp[l] - fmn[l]) / (2.0 * h);
        const bool odd = ((l - m) & 1) != 0;
        const double A = kMu * std::pow(1.0 / a, l + 1);
        const double Sr = A * (odd ? -kEgmS[l][m] : kEgmC[l][m]), Si = A * (odd ? -kEgmC[l][m] : -kEgmS[l][m]);
        const int jlo = static_cast<int>(std::floor(nu - kShallowBand * n / mdot)) - 1, jhi = static_cast<int>(std::ceil(nu + kShallowBand * n / mdot)) + 1;
        for (int j = -(degree + 64); j <= degree + 64; ++j) {
          const double out_ = wide_left_out(cls, low, carried, l, m, p, w, j, j >= jlo && j <= jhi,
                                            std::fabs(w * wdot + j * mdot + m * (node_rate - kOmegaE)), n);
          if (out_ == 0.0) continue;
          // G and dG/de at fixed M by the trapezoid on the E nodes (dM = (1 - e cos E) dE; spectral for these periodic integrands)
          double G = 0.0, dG = 0.0;
          for (int k = 0; k < NE; ++k) {
            const double ph = w * fwang[k] - j * M[k], cp = std::cos(ph), sp = std::sin(ph);
            const double ak = std::pow(ar[k], l);  // (a/r)^(l+1) (1 - e cos E)
            G += ak * cp;
            dG += ak * ((l + 1) * ar[k] * cf[k] * cp - w * sf[k] * (2.0 + e * cf[k]) / (eta * eta) * sp);
          }
          G /= NE;
          dG /= NE;
          // the harmonic's part of g', g, g_e, g_i, g_a: i j Z, Z, Z_e, Z_i, -(l + 1) / a Z
          const double Fo = out_ * F, dFo = out_ * dF;
          const double Z[5][2] = {{-j * Fo * G * Si, j * Fo * G * Sr}, {Fo * G * Sr, Fo * G * Si}, {Fo * dG * Sr, Fo * dG * Si},
                                  {dFo * G * Sr, dFo * G * Si}, {-(l + 1) / a * Fo * G * Sr, -(l + 1) / a * Fo * G * Si}};
          for (int k = 0; k < NE; ++k) {
            const double cj = std::cos(j * M[k]), sj = std::sin(j * M[k]);
            for (int z = 0; z < 5; ++z) { gr[z][0][k] -= Z[z][0] * cj - Z[z][1] * sj; gr[z][1][k] -= Z[z][0] * sj + Z[z][1] * cj; }
          }
        }
      }
      // H = e^{-i nu e sin E} IFFT(FFT(R (1 - e cos E) e^{i nu e sin E}) / (i (k - nu))) / mdot
      for (int q = 0; q < NE; ++q) { cph_[q] = std::cos(nu * e * sE[q]); sph_[q] = std::sin(nu * e * sE[q]); }
      const auto op = [&](double (*r)[NE], double (*o)[NE]) {
        for (int q = 0; q < NE; ++q) {
          const double wgt = 1.0 / ar[q], cph = cph_[q], sph = sph_[q];
          X[0][q] = wgt * (r[0][q] * cph - r[1][q] * sph);
          X[1][q] = wgt * (r[0][q] * sph + r[1][q] * cph);
        }
        fft_inplace(X[0], X[1], NE, false);
        for (int k = 0; k < NE; ++k) {
          const double d = (k < NE / 2 ? k : k - NE) - nu;  // divide by i d NE
          const double xr = X[0][k], xi = X[1][k];
          X[0][k] = xi / (d * NE);
          X[1][k] = -xr / (d * NE);
        }
        fft_inplace(X[0], X[1], NE, true);
        for (int q = 0; q < NE; ++q) {
          const double cph = cph_[q], sph = sph_[q];
          o[0][q] = (X[0][q] * cph + X[1][q] * sph) / mdot;
          o[1][q] = (X[1][q] * cph - X[0][q] * sph) / mdot;
        }
      };
      // five transforms: H[g], H[g_e], H[g_i], H[g_a], H[H[g]]; H[g'] = g / M-dot + i nu H[g] (the M-derivative's integral)
      op(gr[1], D[0]);
      op(gr[2], D[1]);
      op(gr[3], D[2]);
      op(gr[4], D[3]);
      op(D[0], D[4]);
      // six components (n, e, i, e varpi, sin i Omega, lambda) on every (NE / kGridN)-th node; i x: (re, im) -> (-im, re)
      double* o = out + static_cast<size_t>(count) * 6 * kGridN * 2;
      const double ka = 2.0 / (n * a), ke1 = eta * eta / (na2 * e), ke2 = eta / (na2 * e), ki = (c * w - m) / (na2 * eta * si);
      const double kO = 1.0 / (na2 * eta * si), kw = c / (na2 * eta * si);
      for (int gq = 0; gq < kGridN; ++gq) {
        const int q = gq * (NE / kGridN);
        const double Hgr = D[0][0][q], Hgi = D[0][1][q], Her = D[1][0][q], Hei = D[1][1][q], Hir = D[2][0][q], Hii = D[2][1][q];
        const double Har = D[3][0][q], Hai = D[3][1][q], HHr = D[4][0][q], HHi = D[4][1][q];
        const double HMr = gr[1][0][q] / mdot - nu * Hgi, HMi = gr[1][1][q] / mdot + nu * Hgr;  // H[g']
        const double HHMr = Hgr / mdot - nu * HHi, HHMi = Hgi / mdot + nu * HHr;                // H[H[g']]
        const double da[2] = {ka * HMr, ka * HMi};
        const double de[2] = {ke1 * HMr + ke2 * w * Hgi, ke1 * HMi - ke2 * w * Hgr};
        const double di[2] = {-ki * Hgi, ki * Hgr};
        const double dO[2] = {kO * Hir, kO * Hii};
        const double dw[2] = {ke2 * Her - kw * Hir, ke2 * Hei - kw * Hii};
        const double dM[2] = {-ka * Har - ke1 * Her - 3.0 / (a * a) * HHMr, -ka * Hai - ke1 * Hei - 3.0 / (a * a) * HHMi};
        for (int ri = 0; ri < 2; ++ri) {
          const double six[6] = {-1.5 * n / a * da[ri], de[ri], di[ri], e * (dw[ri] + dO[ri]), si * dO[ri], dM[ri] + dw[ri] + dO[ri]};
          for (int z = 0; z < 6; ++z) o[(z * kGridN + gq) * 2 + ri] = six[z];
        }
      }
      fm_out[count] = static_cast<int8_t>(m);
      fw_out[count] = static_cast<int8_t>(w);
      ++count;
    }
  std::free(ws);
  return count;
}

/// The grid of an object above kWideE at its mean elements (n, e, i), with its derivative grids; false out of memory.
/// The build's two double-precision family sets, kept for the module's life and lent to one build at a time (no repeated large
/// allocations, so held grids do not fragment the heap).
struct BuildScratch {
  int32_t word;
  size_t size;
  double* sp;
  double* sn;
};
inline BuildScratch& build_scratch() {
  static BuildScratch s{};
  return s;
}

inline bool wide_grid_build(int degree, int cls, double n, double e, double inc, WideGrid& g) {
  const int cap = degree * (2 * degree + 1);
  const size_t per = static_cast<size_t>(6) * kGridN * 2, one = static_cast<size_t>(cap) * per;
  const size_t dper = static_cast<size_t>(6) * kGridD * 2;
  // one block per grid: the value, the derivative grids and the family indices (a held grid is one allocation)
  const size_t per4 = 2 * per;  // a family's values with their slopes interleaved
  const size_t vb = static_cast<size_t>(cap) * per4 * sizeof(float), db = static_cast<size_t>(cap) * 3 * dper * sizeof(uint16_t);
  char* block = static_cast<char*>(sdnap::mem::malloc(vb + db + 2 * static_cast<size_t>(cap)));
  float* v = reinterpret_cast<float*>(block);
  uint16_t* dv = block != nullptr ? reinterpret_cast<uint16_t*>(block + vb) : nullptr;
  int8_t* fm = block != nullptr ? reinterpret_cast<int8_t*>(block + vb + db) : nullptr;
  int8_t* fw = block != nullptr ? fm + cap : nullptr;
  int8_t* sm = static_cast<int8_t*>(sdnap::mem::malloc(2 * cap));
  BuildScratch& bs = build_scratch();
  for (int32_t expected = 0; !__atomic_compare_exchange_n(&bs.word, &expected, 1, false, __ATOMIC_ACQUIRE, __ATOMIC_RELAXED);) expected = 0;
  const auto release = [&]() { __atomic_store_n(&bs.word, 0, __ATOMIC_RELEASE); };
  if (bs.size < one) {
    std::free(bs.sp);
    std::free(bs.sn);
    bs.sp = static_cast<double*>(sdnap::mem::malloc(one * sizeof(double)));
    bs.sn = static_cast<double*>(sdnap::mem::malloc(one * sizeof(double)));
    bs.size = bs.sp != nullptr && bs.sn != nullptr ? one : 0;
  }
  double* sp = bs.sp;
  double* sn = bs.sn;
  const auto fail = [&]() { release(); std::free(block); std::free(sm); return false; };
  if (bs.size < one || block == nullptr || sm == nullptr) return fail();
  const int count = wide_families(degree, cls, n, e, inc, fm, fw, sn);
  if (count < 0) return fail();
  // each node's value and its slope in E (per node spacing), the fourth-order central difference of its four neighbours on
  // the periodic grid from the values in double, interleaved (re, im, slope re, slope im) for wide_six's cubic Hermite
  for (int f = 0; f < count; ++f)
    for (int z = 0; z < 6; ++z)
      for (int ri = 0; ri < 2; ++ri) {
        const double* row = sn + static_cast<size_t>(f) * per + static_cast<size_t>(z) * kGridN * 2 + ri;
        float* out = v + static_cast<size_t>(f) * per4 + static_cast<size_t>(z) * kGridN * 4 + ri;
        for (int k = 0; k < kGridN; ++k) {
          const auto at = [&](int j) { return row[static_cast<size_t>((k + j + kGridN) & (kGridN - 1)) * 2]; };
          out[static_cast<size_t>(k) * 4] = static_cast<float>(at(0));
          out[static_cast<size_t>(k) * 4 + 2] = static_cast<float>((at(-2) - 8.0 * at(-1) + 8.0 * at(1) - at(2)) / 12.0);
        }
      }
  // the derivative grids, one forward difference at a time: e, i, a / a; every (kGridN / kGridD)-th node
  const double hp[3][3] = {{n, e + kGridDe, inc}, {n, e, inc + kGridDi}, {n / std::pow(1.0 + kGridDa, 1.5), e, inc}};
  const double step[3] = {kGridDe, kGridDi, kGridDa};
  constexpr int skip = kGridN / kGridD;
  for (int d = 0; d < 3; ++d) {
    if (wide_families(degree, cls, hp[d][0], hp[d][1], hp[d][2], sm, sm + cap, sp) != count) return fail();
    for (int f = 0; f < count; ++f)
      for (int z = 0; z < 6; ++z)
        for (int k = 0; k < kGridD; ++k)
          for (int ri = 0; ri < 2; ++ri) {
            const size_t at = f * per + (static_cast<size_t>(z) * kGridN + k * skip) * 2 + ri;
            dv[(static_cast<size_t>(f) * 3 + d) * dper + (static_cast<size_t>(z) * kGridD + k) * 2 + ri] =
                to_half(static_cast<float>((sp[at] - sn[at]) / step[d]));
          }
  }
  release();
  std::free(sm);
  g.degree = degree; g.count = count; g.m = fm; g.w = fw; g.v = v; g.dv = dv;
  g.alloc_bytes = sizeof(WideGrid) + vb + db + 2 * static_cast<size_t>(cap);  // the block as allocated, with the WideGrid
  g.n = n; g.e = e; g.i = inc; g.a = std::pow(kKe / n, kX2o3);
  return true;
}

inline void wide_grid_release(WideGrid& g) {
  std::free(g.v);  // the grid's one block (value, derivative grids, family indices)
  g.m = g.w = nullptr; g.v = nullptr; g.dv = nullptr; g.count = 0;
}

/// A grid's bytes (the values with their slopes, and the derivative grids).
inline size_t wide_grid_bytes(const WideGrid& g) {
  return static_cast<size_t>(g.count) * (6 * kGridN * 4 * sizeof(float) + 3 * 6 * kGridD * 2 * sizeof(uint16_t));
}
/// The bytes a grid of `degree` allocates (WideGrid::alloc_bytes): its block, sized for every family (m, w) of degree 2 to
/// `degree` with their indices, and the WideGrid.
constexpr size_t wide_grid_bytes_bound(int degree) {
  return sizeof(WideGrid) + static_cast<size_t>(degree) * static_cast<size_t>(2 * degree + 1) *
                                (6 * kGridN * 4 * sizeof(float) + 3 * 6 * kGridD * 2 * sizeof(uint16_t) + 2);
}
/// The largest grid a set builds (SPEC 16.11): degree kSpCap on kGridN anomalies (5.1 MB at 12 and 128).
constexpr size_t kGridMaxBytes = wide_grid_bytes_bound(kSpCap);

/// Grids held by exact key: each counted, freed when its last holder drops it, the kGridIdle most recently dropped kept until other
/// grids are built (a grid a fit built is freed at once).
struct GridSlot {
  WideGrid* g;
  int cls, refs;
  uint32_t stamp;  // when it last became idle
  bool transient;  // built inside a fit: freed when its last holder drops it, never kept idle
};
/// Idle grids kept: a catalog refresh finds its objects' grids; the least recently used goes first. kGridSlots bounds every grid
/// held. SPEC 16.11 (stack #497): the cache is also bounded by bytes, live and idle together (kGridCacheBytes by default,
/// sdnap_wide_grid_budget sets it): an idle grid is freed while the cache's bytes, with the grid about to be built, exceed the
/// bound; a grid in use is never freed. A grid at the tesseral cap (12 above the switch) on 128 anomalies is at most
/// kGridMaxBytes. The bound changes which grids are kept, never a grid's bytes: a grid is a pure function of its key.
constexpr int kGridIdle = 128, kGridSlots = 256;
constexpr size_t kGridCacheBytes = static_cast<size_t>(512) << 20;
static_assert(kGridMaxBytes * 64 <= kGridCacheBytes, "the cache's default bound holds at least 64 of the largest grids");
struct GridCache {
  int32_t word;
  int count;
  uint32_t clock;
  size_t bytes;                     // the held grids' allocated bytes (WideGrid::alloc_bytes), live and idle
  size_t budget = kGridCacheBytes;  // the bound on them (sdnap_wide_grid_budget, under the lock)
  GridSlot slot[kGridSlots];
};
/// Frees the least recently used idle grid while more than `keep` are idle or the held bytes with `extra` more exceed the
/// budget (the cache's lock held).
inline void evict_idle(struct GridCache& c, int keep, size_t extra = 0);
inline GridCache& grid_cache() {
  static GridCache c{};
  return c;
}
inline void cache_lock(int32_t* w) {
  int32_t expected = 0;
  while (!__atomic_compare_exchange_n(w, &expected, 1, false, __ATOMIC_ACQUIRE, __ATOMIC_RELAXED)) expected = 0;
}
inline void cache_unlock(int32_t* w) { __atomic_store_n(w, 0, __ATOMIC_RELEASE); }
inline void free_grid(WideGrid* g) {
  wide_grid_release(*g);
  std::free(g);
}

/// The fit's scope (SPEC 16.11): while a FitGridScope lives on a thread, a grid built by a set initialized there (a fit's nominal,
/// trial steps and copies, all made on the fit's calling thread; the pool's threads serve batch flights only) is freed when its last
/// holder drops it, never kept idle. Nesting counts; the guard clears on every exit from its scope.
inline thread_local int32_t g_fit_grid_depth = 0;
inline int32_t& fit_grid_depth() {
  return g_fit_grid_depth;
}
struct FitGridScope {
  FitGridScope() { ++fit_grid_depth(); }
  ~FitGridScope() { --fit_grid_depth(); }
  FitGridScope(const FitGridScope&) = delete;
  FitGridScope& operator=(const FitGridScope&) = delete;
};
inline bool fit_grids_now() { return fit_grid_depth() > 0; }

/// Grid lookups since the last reset: [0] by sets outside a fit, [1] by a fit's sets (SPEC 16.11; read by sdnap_wide_grid_stats).
inline int64_t* grid_counts() {
  static int64_t counts[3] = {0, 0, 0};  // [2] the grids built since the instance began
  return counts;
}

struct GridCache;
inline GridCache& grid_cache();
inline void cache_contents(double& slots, double& bytes);

/// SPEC 16.11: out[0] the grids the cache holds, out[1] their bytes and out[2] the grids built since the instance began.
extern "C" __attribute__((export_name("sdnap_wide_grid_cache"))) int32_t sdnap_wide_grid_cache(double* out) {
  cache_contents(out[0], out[1]);
  out[2] = static_cast<double>(__atomic_load_n(&grid_counts()[2], __ATOMIC_RELAXED));
  return 0;
}

/// SPEC 16.11: out[0] the grid lookups by sets outside a fit and out[1] those by a fit's sets since the last reset; reset != 0
/// zeroes them after reading.
extern "C" __attribute__((export_name("sdnap_wide_grid_stats"))) int32_t sdnap_wide_grid_stats(int32_t reset, double* out) {
  int64_t* c = grid_counts();
  out[0] = static_cast<double>(__atomic_load_n(&c[0], __ATOMIC_RELAXED));
  out[1] = static_cast<double>(__atomic_load_n(&c[1], __ATOMIC_RELAXED));
  if (reset != 0) {
    __atomic_store_n(&c[0], 0, __ATOMIC_RELAXED);
    __atomic_store_n(&c[1], 0, __ATOMIC_RELAXED);
  }
  return 0;
}

/// The grid keyed by (degree, class, n, e, i), bitwise: a live or idle one with that key, else a new one; nullptr out of memory. A
/// grid is a pure function of its key, so a hit and a rebuild give the same bytes. `transient` (a fit's set): a grid it builds is
/// freed when its last holder drops it, never kept idle.
inline WideGrid* wide_grid_acquire(int degree, int cls, double n, double e, double inc, bool transient = false) {
  __atomic_add_fetch(transient ? &grid_counts()[1] : &grid_counts()[0], 1, __ATOMIC_RELAXED);
  GridCache& c = grid_cache();
  cache_lock(&c.word);
  for (int k = 0; k < c.count; ++k) {
    const WideGrid& g = *c.slot[k].g;
    if (g.degree == degree && c.slot[k].cls == cls && n == g.n && e == g.e && inc == g.i) {
      ++c.slot[k].refs;
      WideGrid* hit = c.slot[k].g;
      cache_unlock(&c.word);
      return hit;
    }
  }
  // a build: the least recently used idle grid goes first beyond kGridIdle - 1, and while the held bytes with this grid's
  // largest size exceed the budget, so a worker holds a bounded number and the instance a bounded size
  evict_idle(c, kGridIdle - 1, wide_grid_bytes_bound(degree));
  cache_unlock(&c.word);
  WideGrid* g = static_cast<WideGrid*>(sdnap::mem::calloc(1, sizeof(WideGrid)));
  if (g == nullptr) return nullptr;
  if (!wide_grid_build(degree, cls, n, e, inc, *g)) { std::free(g); return nullptr; }
  __atomic_add_fetch(&grid_counts()[2], 1, __ATOMIC_RELAXED);
  cache_lock(&c.word);
  if (c.count < kGridSlots) {
    c.slot[c.count++] = GridSlot{g, cls, 1, 0, transient};
    c.bytes += g->alloc_bytes;
    cache_unlock(&c.word);
    return g;
  }
  cache_unlock(&c.word);
  free_grid(g);
  return nullptr;
}

/// SPEC 16.11: the cache's byte bound. bytes of 1 or more sets it (whole bytes, at most the address space: SIZE_MAX); a smaller
/// value only reads. out[0] the bound, out[1] the held bytes, out[2] the grids held, out[3] those idle (held by no set).
extern "C" __attribute__((export_name("sdnap_wide_grid_budget"))) int32_t sdnap_wide_grid_budget(double bytes, double* out) {
  GridCache& c = grid_cache();
  cache_lock(&c.word);
  if (bytes >= 1.0) {
    constexpr double kMax = static_cast<double>(SIZE_MAX);
    c.budget = bytes >= kMax ? SIZE_MAX : static_cast<size_t>(bytes);
    evict_idle(c, kGridIdle);
  }
  if (out != nullptr) {
    int idle = 0;
    for (int k = 0; k < c.count; ++k) idle += c.slot[k].refs == 0 ? 1 : 0;
    out[0] = static_cast<double>(c.budget);
    out[1] = static_cast<double>(c.bytes);
    out[2] = static_cast<double>(c.count);
    out[3] = static_cast<double>(idle);
  }
  cache_unlock(&c.word);
  return 0;
}

/// Adds a holder to a grid already held.
/// A held grid's bytes shared among its holders (a grid of one exact key serves every set that asks for it).
inline double wide_grid_share(const WideGrid* g) {
  if (g == nullptr) return 0.0;
  GridCache& c = grid_cache();
  cache_lock(&c.word);
  int refs = 1;
  for (int k = 0; k < c.count; ++k)
    if (c.slot[k].g == g) { refs = c.slot[k].refs > 0 ? c.slot[k].refs : 1; break; }
  cache_unlock(&c.word);
  return static_cast<double>(sizeof(WideGrid) + wide_grid_bytes(*g)) / refs;
}

inline void wide_grid_ref(WideGrid* g) {
  GridCache& c = grid_cache();
  cache_lock(&c.word);
  for (int k = 0; k < c.count; ++k)
    if (c.slot[k].g == g) { ++c.slot[k].refs; break; }
  cache_unlock(&c.word);
}

/// Drops a holder; the last holder's grid stays idle until the next build.
inline void wide_grid_drop(WideGrid* g) {
  if (g == nullptr) return;
  GridCache& c = grid_cache();
  cache_lock(&c.word);
  for (int k = 0; k < c.count; ++k)
    if (c.slot[k].g == g) {
      if (--c.slot[k].refs == 0) {
        if (c.slot[k].transient) {  // built inside a fit: not kept idle
          c.bytes -= c.slot[k].g->alloc_bytes;
          free_grid(c.slot[k].g);
          c.slot[k] = c.slot[--c.count];
        } else {
          c.slot[k].stamp = ++c.clock;
          evict_idle(c, kGridIdle);
        }
      }
      break;
    }
  cache_unlock(&c.word);
}

inline void cache_contents(double& slots, double& bytes) {
  GridCache& c = grid_cache();
  cache_lock(&c.word);
  slots = c.count;
  bytes = 0.0;
  bytes = static_cast<double>(c.bytes);  // the same count sdnap_wide_grid_budget reports: each grid's allocated bytes
  cache_unlock(&c.word);
}

inline void evict_idle(GridCache& c, int keep, size_t extra) {
  for (;;) {
    int idle = 0, oldest = -1;
    for (int k = 0; k < c.count; ++k)
      if (c.slot[k].refs == 0) {
        ++idle;
        if (oldest < 0 || c.slot[k].stamp < c.slot[oldest].stamp) oldest = k;
      }
    if (oldest < 0 || (idle <= keep && c.bytes + extra <= c.budget)) return;
    c.bytes -= c.slot[oldest].g->alloc_bytes;
    free_grid(c.slot[oldest].g);
    c.slot[oldest] = c.slot[--c.count];
  }
}


/// The displacements in the six-component set, the grid's cubic in E at the current anomaly times e^{i (w omega + m beta)}.
/// `a_ref` > 0: the offset in a is a_ref's, not the current mean a's (the long-period regime with the Sun and Moon, SPEC 16.11).
inline void wide_six(const WideGrid& g, double t, const Kepler& kp, double theta_g0, double* six,
                     double E_in = std::numeric_limits<double>::quiet_NaN(), double* dsix_dlam = nullptr, double weight = 1.0,
                     double a_ref = 0.0) {
  const double de = kp.e - g.e, di = kp.i - g.i, da = (a_ref > 0.0 ? a_ref : kp.a) / g.a - 1.0;
  double E = E_in;
  if (!(E == E)) {
    E = kp.m;
    for (int it = 0; it < 50; ++it) {
      double sE, cE;
      fm::sincos(E, sE, cE);
      const double d = (E - kp.e * sE - kp.m) / (1.0 - kp.e * cE);
      E -= d;
      if (std::fabs(d) < 1e-14) break;
    }
  }
  E = std::fmod(E, kTwoPi);
  if (E < 0.0) E += kTwoPi;
  const double dE_dlam = dsix_dlam != nullptr ? (1.0 / (1.0 - kp.e * std::cos(E))) : 0.0;
  // Read continuously with its slope from one cell to the next (SPEC 16.11; through 0.6.13 the four-point Lagrange cubic,
  // whose slope stepped at every node). The value: the cubic Hermite between nodes i1 and i1 + 1 on the two values and
  // the two slopes the build stored beside them (wide_grid_build: the fourth-order central difference, single precision). The
  // derivative grids in e, i and a / a: the four-point Catmull-Rom cubic.
  const double xn = E / kTwoPi * kGridN;
  const int in1 = static_cast<int>(xn);
  const double un = xn - in1, un2 = un * un, un3 = un2 * un;
  const int idx[2] = {in1 & (kGridN - 1), (in1 + 1) & (kGridN - 1)};
  const double h00 = 2.0 * un3 - 3.0 * un2 + 1.0, h10 = un3 - 2.0 * un2 + un, h01 = -2.0 * un3 + 3.0 * un2, h11 = un3 - un2;
  const double sn_ = (kGridN / kTwoPi) * dE_dlam;
  const double d00 = sn_ * (6.0 * un2 - 6.0 * un), d10 = sn_ * (3.0 * un2 - 4.0 * un + 1.0), d01 = -d00,
               d11 = sn_ * (3.0 * un2 - 2.0 * un);
  const double xd = E / kTwoPi * kGridD;
  const int id1 = static_cast<int>(xd);
  const double ud = xd - id1, ud2 = ud * ud, ud3 = ud2 * ud;
  int jdx[4];
  for (int k = 0; k < 4; ++k) jdx[k] = (id1 - 1 + k + kGridD) & (kGridD - 1);
  const double wd[4] = {0.5 * (-ud3 + 2.0 * ud2 - ud), 0.5 * (3.0 * ud3 - 5.0 * ud2 + 2.0), 0.5 * (-3.0 * ud3 + 4.0 * ud2 + ud),
                        0.5 * (ud3 - ud2)};
  const double sd_ = (kGridD / kTwoPi) * dE_dlam;
  const double dwd[4] = {sd_ * 0.5 * (-3.0 * ud2 + 4.0 * ud - 1.0), sd_ * 0.5 * (9.0 * ud2 - 10.0 * ud),
                         sd_ * 0.5 * (-9.0 * ud2 + 8.0 * ud + 1.0), sd_ * 0.5 * (3.0 * ud2 - 2.0 * ud)};
  const double off[3] = {de, di, da};
  const double beta = kp.node - (theta_g0 + kOmegaE * t);
  double sb, cb, sw1, cw1;
  fm::sincos(beta, sb, cb);
  fm::sincos(kp.argp, sw1, cw1);
  static_assert(kSpCap < 36, "wide_six's multiples of the angles hold orders and w to the grid's degree (kSpCap)");
  double cm[36], sm[36], cw[36], sw[36];
  cm[0] = cw[0] = 1.0;
  sm[0] = sw[0] = 0.0;
  for (int q = 1; q <= 33; ++q) {
    cm[q] = cm[q - 1] * cb - sm[q - 1] * sb;
    sm[q] = sm[q - 1] * cb + cm[q - 1] * sb;
    cw[q] = cw[q - 1] * cw1 - sw[q - 1] * sw1;
    sw[q] = sw[q - 1] * cw1 + cw[q - 1] * sw1;
  }
  const size_t per4 = static_cast<size_t>(6) * kGridN * 4, dper = static_cast<size_t>(6) * kGridD * 2;
  const float* half = half_table();
  for (int f = 0; f < g.count; ++f) {
    const float* v = g.v + static_cast<size_t>(f) * per4;
    const uint16_t* dv = g.dv + static_cast<size_t>(f) * 3 * dper;
    const int wf = g.w[f], mf = g.m[f], aw = wf < 0 ? -wf : wf;
    const double cww = cw[aw], sww = wf < 0 ? -sw[aw] : sw[aw];
    const double cph = (cww * cm[mf] - sww * sm[mf]) * weight, sph = (sww * cm[mf] + cww * sm[mf]) * weight;
    for (int z = 0; z < 6; ++z) {
      const float* p0 = v + (static_cast<size_t>(z) * kGridN + idx[0]) * 4;
      const float* p1 = v + (static_cast<size_t>(z) * kGridN + idx[1]) * 4;
      const double s0r = p0[2], s0i = p0[3], s1r = p1[2], s1i = p1[3];
      double hr = h00 * p0[0] + h01 * p1[0] + h10 * s0r + h11 * s1r;
      double hi = h00 * p0[1] + h01 * p1[1] + h10 * s0i + h11 * s1i;
      for (int d = 0; d < 3; ++d) {
        const double od = off[d];
        for (int k = 0; k < 4; ++k) {
          const size_t at = d * dper + (static_cast<size_t>(z) * kGridD + jdx[k]) * 2;
          hr += od * wd[k] * half[dv[at]];
          hi += od * wd[k] * half[dv[at + 1]];
        }
      }
      six[z] += hr * cph - hi * sph;
      if (dsix_dlam != nullptr) {
        double dhr = d00 * p0[0] + d01 * p1[0] + d10 * s0r + d11 * s1r;
        double dhi = d00 * p0[1] + d01 * p1[1] + d10 * s0i + d11 * s1i;
        for (int d = 0; d < 3; ++d) {
          const double od = off[d];
          for (int k = 0; k < 4; ++k) {
            const size_t at = d * dper + (static_cast<size_t>(z) * kGridD + jdx[k]) * 2;
            dhr += od * dwd[k] * half[dv[at]];
            dhi += od * dwd[k] * half[dv[at + 1]];
          }
        }
        dsix_dlam[z] += dhr * cph - dhi * sph;
      }
    }
  }
}

}  // namespace tess
