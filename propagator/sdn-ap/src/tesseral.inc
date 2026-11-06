// -----------------------------------------------------------------------------
// AP (SPEC 16): SGP4XP with parts replaced, outside the SGP4-XP specification. What the call's $PCF FORCES selects
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

/// What the call selects (0: none of it). `tesseral` is the highest degree of the terms of order >= 1, `zonal` of the
/// zonal tail. Capped per family at the degree that was measured to pay. On FFM Starlink truth, day 3: m-daily 8 -> 12
/// 4.26 -> 2.03 km and 16 no better; shallow 21 / 31 / 41 / 70 2.15 / 1.89 / 2.02 / 2.03 km; zonal tail J2-J5 0.35 km,
/// to J10 0.14, to J20 0.047, to J40 0.042. On FFM's own 96 h, fit RMS of the first-order families below: without them
/// 48 to 68 m, to degree 7 24 to 42 m, to degree 12 21 to 37 m, with the near-resonant terms 15 to 20 m.
struct Terms {
  int tesseral = 0, zonal = 0;
};
inline Terms& active() {
  static Terms t;
  return t;
}
constexpr int kMdailyCap = 12, kSpCap = 12, kShallowCap = 31;
constexpr double kShallowBand = 0.045;
constexpr double kNearBand = 0.2;   // the j = 1 orders kept above the general set's degree, in units of n
constexpr double kSpKeepM = 0.5;    // a term whose position amplitude is below this many meters is not kept: 0.2 m
                                    // gives 15 to 20 m of fit RMS, 0.5 m 16 to 21, 1 m 18 to 23, 2 m 23 to 28
/// The switch (SPEC 16.11), read here only: above this epoch eccentricity a perigee pass spreads a term over the harmonics of
/// M; the zonal tail carries every long-period term and the first-order tesseral families are the grid of wide_grid_build.
constexpr double kWideE = 0.3;

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
  double a[104], b[104];  // to degree 103 (the lunar field is pinned to degree 100)
};

inline void legendre_order(int m, int lmax, LegendreOrder& L) {
  L.m = m;
  L.lmax = lmax;
  double k = 1.0;
  for (int j = 1; j <= m; ++j) k *= std::sqrt((2.0 * j + 1.0) / (2.0 * j));
  L.km = m >= 1 ? k * std::sqrt(2.0) : 1.0;  // (2 - delta_0m)
  for (int l = m + 2; l <= lmax; ++l) {
    const double lm = (double)(l - m) * (double)(l + m);
    L.a[l] = std::sqrt((2.0 * l - 1.0) * (2.0 * l + 1.0) / lm);
    L.b[l] = std::sqrt((2.0 * l + 1.0) * (l + m - 1.0) * (l - m - 1.0) / (lm * (2.0 * l - 3.0)));
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
  for (int j = 0; j < N; ++j) {
    const double u = kTwoPi * j / N;
    double su, cu, sku, cku;
    fm::sincos(u, su, cu);
    fm::sincos(k * u, sku, cku);
    const double x = si * su, c = std::sqrt(std::fmax(0.0, 1.0 - x * x));
    legendre_column(L, x, c, col);
    double sml, cml;
    fm::sincos(m * std::atan2(ci * su, cu), sml, cml);
    for (int l = l0; l <= lmax; l += 2) {
      const double f1 = col[l] * cml, f2 = col[l] * sml;
      F[l] += ((l - m) & 1) ? f1 * sku - f2 * cku : f1 * cku + f2 * sku;
    }
  }
  for (int l = 0; l <= lmax; ++l) F[l] /= N;
}

/// The m-daily terms' inclination functions at the epoch inclination i0: for even
/// l = 2..degree and m = 1..l in that order, Fbar_l,m,l/2 and its derivative in i
/// (central difference) in F[2 j], F[2 j + 1]; returns the term count.
inline int mdaily_terms(int degree, double i0, double* F) {
  int count = 0;
  double f[72], fp[72], fm[72];
  const double h = 1e-5;
  for (int l = 2; l <= degree; l += 2) count += l;
  for (int m = 1; m <= degree; ++m) {
    normalized_Fk(m, 0, degree, i0, f);
    normalized_Fk(m, 0, degree, i0 + h, fp);
    normalized_Fk(m, 0, degree, i0 - h, fm);
    // term index of (l, m): sum over even l' < l of l', plus m - 1
    for (int l = (m + 1) / 2 * 2; l <= degree; l += 2) {
      const int j = (l - 2) * l / 4 + (m - 1);
      F[2 * j] = f[l];
      F[2 * j + 1] = (fp[l] - fm[l]) / (2.0 * h);
    }
  }
  return count;
}

/// The m-daily corrections in the six-component set (n-dot, e-dot, i-dot,
/// e varpi, sin i Omega, lambda order), first order, at the mean elements k;
/// F the object's mdaily_terms (degree even l up to `degree`).
inline void mdaily_six(const float* F, int degree, double t, const Kepler& k, double n, double eta, double si,
                       double ci, double theta_g0, double* six) {
  const double a = k.a, e = k.e;
  const double sin_i = std::fabs(si) < 1e-12 ? 1e-12 : si;
  const double p = a * eta * eta;
  const double node_rate = -1.5 * n * kJ2 * ci / (p * p);  // J2 secular Omega-dot, rad/min
  const double na2 = n * a * a, tanhalf = sin_i / (1.0 + ci);
  const double g2 = 1.0 / (1.0 - e * e);
  double sb, cb;  // beta = Omega - theta_G; the m multiples by recurrence
  fm::sincos(k.node - (theta_g0 + kOmegaE * t), sb, cb);
  double cm[72], sm[72];
  cm[0] = 1.0;
  sm[0] = 0.0;
  for (int m = 1; m <= degree; ++m) {
    cm[m] = cm[m - 1] * cb - sm[m - 1] * sb;
    sm[m] = sm[m - 1] * cb + cm[m - 1] * sb;
  }
  double dlam = 0.0, di = 0.0, dsO = 0.0, dev = 0.0;
  const double ia = 1.0 / a;
  double A = kMu * ia * ia * ia;     // mu / a^(l+1), l = 2
  double W = g2 * std::sqrt(g2);      // (1 - e^2)^-(l - 1/2), l = 2
  int j = 0;
  for (int l = 2; l <= degree; l += 2) {
    // G = <(a/r)^(l+1)> = (1 - e^2)^-(l - 1/2) Q(e), Q = sum over even s of C(l-1, s) C(s, s/2) (e/2)^s
    double Q = 0.0, dQ = 0.0, binom = 1.0, es = 1.0;  // binom = C(l-1, s), es = (e/2)^s
    for (int s2 = 0; s2 <= l - 1; s2 += 2) {
      double central = 1.0;  // C(s, s/2)
      for (int r = 1; r <= s2 / 2; ++r) central = central * (s2 / 2 + r) / r;
      Q += binom * central * es;
      if (s2 > 0 && e > 0.0) dQ += binom * central * s2 * es / e;  // 0 at e = 0 (every term has a factor e)
      binom = binom * (l - 1 - s2) * (l - 2 - s2) / ((s2 + 1.0) * (s2 + 2.0));
      es *= 0.25 * e * e;
    }
    const double G = W * Q;
    const double dG = W * ((2.0 * l - 1.0) * e * g2 * Q + dQ);
    for (int m = 1; m <= l; ++m, ++j) {
      const double C = kEgmC[l][m], S = kEgmS[l][m];
      const double Fv = F[2 * j], dF = F[2 * j + 1];
      const double psidot = m * (node_rate - kOmegaE);
      const bool odd = ((l - m) & 1) != 0;
      const double Spsi = odd ? -S * cm[m] + C * sm[m] : C * cm[m] + S * sm[m];
      const double S1 = odd ? -S * sm[m] - C * cm[m] : C * sm[m] - S * cm[m];
      const double AFG = A * Fv * G, AdFG = A * dF * G, AFdG = A * Fv * dG;
      di += -m * AFG * Spsi / (na2 * eta * sin_i * psidot);
      dsO += AdFG * S1 / (na2 * eta * psidot);
      dev += (eta * AFdG / na2 + e * tanhalf * AdFG / (na2 * eta)) * S1 / psidot;
      dlam += (2.0 * (l + 1) * AFG / na2 + eta * e * AFdG / (na2 * (1.0 + eta)) + tanhalf * AdFG / (na2 * eta)) * S1 / psidot;
    }
    A *= ia * ia;
    W *= g2 * g2;
  }
  six[2] += di;
  six[3] += dev;
  six[4] += dsO;
  six[5] += dlam;
}

/// The remaining first-order tesseral terms at output time, Kaula's (l, m, p, q) with q in {-1, 0, 1}: every term of
/// degree 2 to the general degree except the m-daily set (q = 0, l = 2p), and the near-resonant terms above that degree
/// (below). psi = w omega + j M + m (Omega - theta_G), w = l - 2p, j = w + q. The rates of res::resonance_six integrated
/// over psi with the slow elements frozen (int dS dt = S / psi-dot, int S dt = -dS / psi-dot), plus the mean longitude's
/// second integral of the n oscillation, 3 j A F G dS / (a^2 psi-dot^2). The q = +-1 terms are O(e) in G but O(1) in the
/// eccentricity vector (Lagrange's 1/e). Per term at the epoch: Fbar, dFbar/di and G(e) = g0 + g1 e linearized there
/// (g0 = 0 for q = +-1 at small e). A term the rates carry (the shallow set, by the same taper) or whose position
/// amplitude is below kSpKeepM is not kept.
struct SpCoef {
  int8_t l, m, w, j;
  float f, df, g0, g1;
};

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

/// The upper bound of the table: the general set of `degree` (none when `wide`: the grid carries it) and kNearMax near-resonant terms.
constexpr int kNearMax = 500;
inline int sp_bound(int degree, bool wide) {
  int c = kNearMax;
  for (int l = 2; l <= degree && !wide; ++l) c += l * (l + 1) * 3;
  return c;
}

/// Fills out at the epoch mean motion n0, inclination i0 and eccentricity e0; returns the count. `cls`: the resonance class,
/// whose terms the rates carry and this table must not. `low`: no class and the shallow set active, so a term near
/// commensurability other than the shallow set's is kept here.
inline int sp_terms(int degree, int near_degree, int cls, bool low, double n0, double i0, double e0, SpCoef* out) {
  const double eta = std::sqrt(1.0 - e0 * e0), a0 = std::pow(kKe / n0, kX2o3), p0 = a0 * eta * eta;
  const double c0 = std::cos(i0), j2 = 1.5 * kJ2 / (p0 * p0);
  const double mdot = n0 + 0.5 * j2 * n0 * eta * (3.0 * c0 * c0 - 1.0), wdot = 0.5 * j2 * n0 * (5.0 * c0 * c0 - 1.0);
  const double node_rate = -j2 * n0 * c0;
  const double h = 1e-5;
  const double na2 = n0 * a0 * a0, keep = kSpKeepM * 1e-3 / kRe;
  int count = 0;
  const bool wide = e0 > kWideE;
  // The term's weight (0: not kept here) and its angle rate.
  const auto weight_of = [&](int l, int m, int p, int q, double& psidot) -> double {
    const int w = l - 2 * p, j = w + q;
    // The half-day tail is integrated, including away from exact commensurability.
    if (cls == 2 && l > 5 && l <= near_degree && (m & 1) == 0 && j == m / 2) return 0.0;
    const res::TermSet carried = res::class_terms(cls);
    for (int c = 0; c < carried.count; ++c)
      if (carried.t[c].l == l && carried.t[c].m == m && carried.t[c].p == p && carried.t[c].q == q) return 0.0;
    psidot = w * wdot + j * mdot + m * (node_rate - kOmegaE);
    double weight = 1.0;
    const double x = std::fabs(psidot) / (kShallowBand * n0);
    if (low) {
      if (q == 0 && w == 1 && j == 1) {
        if (x <= 0.9) weight = 0.0;
        else if (x < 1.1) { const double c = std::cos(0.5 * kPi * (x - 0.9) / 0.2); weight = 1.0 - c * c; }
      } else if (std::fabs(psidot) < 1e-3 * n0) {
        weight = 0.0;
      }
    } else if (x < 1.0) {
      weight = 0.0;
    }
    return weight;
  };
  const auto put = [&](int l, int m, int p, int q, double fv, double dfv, double g0, double g1, double weight,
                       double psidot) {
    const int w = l - 2 * p, j = w + q;
    const double G = g0 + g1 * e0;
    const double sv = std::hypot(kEgmC[l][m], kEgmS[l][m]);
    const double A = kMu * std::pow(1.0 / a0, l + 1) * sv * weight;
    const double ap = std::fabs(psidot);
    const double mag = a0 * A * (std::fabs(fv * G) * (3.0 * std::abs(j) / (a0 * a0 * ap * ap) + 2.0 * (l + 1) / (na2 * ap)) +
                                 std::fabs(fv * g1) / (na2 * ap) + std::fabs(dfv * G) / (na2 * ap));
    if (mag < keep) return;
    out[count++] = SpCoef{static_cast<int8_t>(l), static_cast<int8_t>(m), static_cast<int8_t>(w), static_cast<int8_t>(j),
                          static_cast<float>(fv * weight), static_cast<float>(dfv * weight), static_cast<float>(g0), static_cast<float>(g1)};
  };
  const auto add = [&](int l, int m, int p, int q, double fv, double dfv) {
    double psidot = 0.0;
    const double weight = weight_of(l, m, p, q, psidot);
    if (weight == 0.0) return;
    double g0, g1;
    sp_g(l, p, q, e0, g0, g1);
    put(l, m, p, q, fv, dfv, g0, g1, weight, psidot);
  };
  double f[72], fp[72], fm[72];
  // A term cannot pass `keep` if this bound on its amplitude does not: Fbar <= sqrt(2 (2 l + 1)), dFbar/di <= l Fbar,
  // G <= 1 + (l e0)^2 for q = 0 and (l + 1) e0 otherwise, dG/de <= (l + 1)^2. Saves the inclination functions and Hansen
  // coefficients of the terms that would be dropped.
  const auto can_pass = [&](int l, int m, int w, int q) {
    const int j = w + q;
    const double ap = std::fabs(w * wdot + j * mdot + m * (node_rate - kOmegaE));
    if (ap < 1e-3 * n0) return false;
    const double ll = l + 1.0, Fb = std::sqrt(2.0 * (2.0 * l + 1.0));
    const double Gb = q == 0 ? 1.0 + l * l * e0 * e0 : ll * (e0 > 1e-3 ? e0 : 1e-3);
    const double A = kMu * std::pow(1.0 / a0, l + 1) * std::hypot(kEgmC[l][m], kEgmS[l][m]);
    const double bound = a0 * A * Fb * (Gb * (3.0 * std::abs(j) / (a0 * a0 * ap * ap) + 2.0 * ll / (na2 * ap)) + ll * ll / (na2 * ap) + l * Gb / (na2 * ap));
    return bound >= keep;
  };
  // Above kWideE the general set is the grid of wide_grid_build (SPEC 16.11); the table keeps the near-resonant terms below.
  for (int l = 2; l <= degree && !wide; ++l)
    for (int m = 1; m <= l; ++m)
      for (int p = 0; p <= l; ++p) {
        const int w = l - 2 * p;
        if (!can_pass(l, m, w, -1) && !can_pass(l, m, w, 0) && !can_pass(l, m, w, 1)) continue;
        normalized_Fk(m, w, l, i0, f);
        // dFbar/di only for a term that passes the bound at this q.
        double dfv = 0.0;
        bool have_df = false;
        for (int q = -1; q <= 1; ++q) {
          const int j = w + q;
          if (q == 0 && w == 0) continue;  // the m-daily set
          if (j < -(l + 1) || j > l + 1) continue;
          if (!can_pass(l, m, w, q)) continue;
          if (!have_df) {
            normalized_Fk(m, w, l, i0 + h, fp);
            normalized_Fk(m, w, l, i0 - h, fm);
            dfv = (fp[l] - fm[l]) / (2.0 * h);
            have_df = true;
          }
          add(l, m, p, q, f[l], dfv);
        }
      }
  if (low) {
    // Above that degree, j = 1 near commensurability: q = 0 with w = 1 (odd l) outside the shallow band, and q = +-1 with
    // w = 0 or 2 (even l), O(e) in G, O(1) in the eccentricity vector, amplified by n / psi-dot.
    static constexpr int kW[3] = {1, 0, 2}, kQ[3] = {0, 1, -1};
    for (int m = 2; m <= near_degree; ++m)
      for (int fam = 0; fam < 3; ++fam) {
        const int w = kW[fam], q = kQ[fam];
        const double psidot = w * wdot + mdot + m * (node_rate - kOmegaE);
        if (!(std::fabs(psidot) < kNearBand * n0)) continue;
        normalized_Fk(m, w, near_degree, i0, f);
        normalized_Fk(m, w, near_degree, i0 + h, fp);
        normalized_Fk(m, w, near_degree, i0 - h, fm);
        int l0 = m > w ? m : w;
        if ((l0 - w) & 1) ++l0;
        for (int l = l0; l <= near_degree; l += 2) {
          if (l <= degree || !can_pass(l, m, w, q)) continue;
          if (count >= sp_bound(degree, wide)) break;
          add(l, m, (l - w) / 2, q, f[l], (fp[l] - fm[l]) / (2.0 * h));
        }
      }
  }
  return count;
}

/// The displacements in the six-component set (n, e, i, e varpi, sin i Omega, lambda), first order.
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
  for (int q = 1; q <= 33; ++q) {
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
  for (int l = 1; l <= 33; ++l) amp[l] = amp[l - 1] * ia;
  double sM = 0, sW = 0, sO = 0, sE = 0, sI = 0, sA = 0, sL = 0;
  for (int idx = 0; idx < count; ++idx) {
    const SpCoef& f = F[idx];
    const int l = f.l, m = f.m, w = f.w, j = f.j;
    const double psidot = w * wdot + j * mdot + m * (node_rate - kOmegaE);
    const int aw = w < 0 ? -w : w, aj = j < 0 ? -j : j;
    const double cww = cw[aw], sww = w < 0 ? -swv[aw] : swv[aw];
    const double cjj = cj[aj], sjj = j < 0 ? -sj[aj] : sj[aj];
    // psi = w omega + j M + m beta
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

/// Half-day resonant tail: every even order m, k=m/2, degree 6..31.
/// Normalized F and dF/di at the epoch; G is cubic about the epoch eccentricity.
struct HalfDayCoef {
  int8_t l, m, p, k;
  double f, df, ddf, dddf;
  res::GTaylor g;
};
inline int half_day_bound(int degree) {
  int count = 0;
  for (int l = 6; l <= degree; ++l) count += (l / 2) * (l + 1);
  return count;
}
inline int half_day_terms(int degree, double i0, double e0, HalfDayCoef* out) {
  int count = 0;
  double f[72], fp[72], fm[72], fpp[72], fmm[72];
  const double h = 5e-4;
  // Adjacent degrees share one angle in resonance_six.
  for (int m = 2; m <= degree; m += 2) {
    for (int w = -degree; w <= degree; ++w) {
      normalized_Fk(m, w, degree, i0, f);
      normalized_Fk(m, w, degree, i0 + h, fp);
      normalized_Fk(m, w, degree, i0 - h, fm);
      normalized_Fk(m, w, degree, i0 + 2*h, fpp);
      normalized_Fk(m, w, degree, i0 - 2*h, fmm);
      int first = std::max(6, std::max(m, std::abs(w)));
      if ((first - w) & 1) ++first;
      for (int l = first; l <= degree; l += 2) {
        const int p = (l - w) / 2, k = m / 2;
        out[count++] = HalfDayCoef{static_cast<int8_t>(l), static_cast<int8_t>(m),
          static_cast<int8_t>(p), static_cast<int8_t>(k), f[l],
          (fmm[l]-8*fm[l]+8*fp[l]-fpp[l])/(12*h),
          (-fpp[l]+16*fp[l]-30*f[l]+16*fm[l]-fmm[l])/(12*h*h),
          (fpp[l]-2*fp[l]+2*fm[l]-fmm[l])/(2*h*h*h), res::GTaylor{}};
      }
    }
  }
  // Share the eccentric-anomaly quadrature across every coefficient. Each
  // sample's anomaly, radial powers and Fourier factors are evaluated once.
  const int N = e0 < 0.1 ? 128 : e0 < 0.8 ? 512 : e0 < 0.95 ? 2048 : 4096;
  const int width = 3 * (degree + 1) + 2 * (degree / 2 + 1);
  double* grid = static_cast<double*>(std::malloc(N * width * sizeof(double)));
  double* values = static_cast<double*>(std::malloc(5 * count * sizeof(double)));
  if (grid == nullptr || values == nullptr) { std::free(grid); std::free(values); return -1; }
  const double dh = std::min(5e-4, (1.0-e0)/4.0);
  for (int off = -2; off <= 2; ++off) {
    const double e = e0 + off * dh, eta = std::sqrt(1.0-e*e);
    for (int j = 0; j < N; ++j) {
      const double E = kTwoPi*(j+0.5)/N;
      double se, ce; fm::sincos(E,se,ce);
      const double ir = 1.0/(1.0-e*ce), nu = std::atan2(eta*se,ce-e), M = E-e*se;
      double sn, cn, sm, cm; fm::sincos(nu,sn,cn); fm::sincos(M,sm,cm);
      double* r = grid+j*width;
      double* cw = r+degree+1; double* sw = cw+degree+1;
      double* ck = sw+degree+1; double* sk = ck+degree/2+1;
      r[0]=cw[0]=ck[0]=1.0; sw[0]=sk[0]=0.0;
      for (int l=1;l<=degree;++l) {
        r[l]=r[l-1]*ir; cw[l]=cw[l-1]*cn-sw[l-1]*sn; sw[l]=sw[l-1]*cn+cw[l-1]*sn;
      }
      for (int k=1;k<=degree/2;++k) { ck[k]=ck[k-1]*cm-sk[k-1]*sm; sk[k]=sk[k-1]*cm+ck[k-1]*sm; }
    }
    for (int q=0;q<count;++q) {
      const HalfDayCoef& c=out[q]; const int w=c.l-2*c.p, aw=std::abs(w);
      double sum=0.0;
      for (int j=0;j<N;++j) {
        const double* r=grid+j*width; const double* cw=r+degree+1; const double* sw=cw+degree+1;
        const double* ck=sw+degree+1; const double* sk=ck+degree/2+1;
        sum+=r[c.l]*(cw[aw]*ck[c.k]+(w<0?-sw[aw]:sw[aw])*sk[c.k]);
      }
      values[(off+2)*count+q]=sum/N;
    }
  }
  for(int j=0;j<count;++j) {
    const double gm2=values[j],gm1=values[count+j],g0=values[2*count+j],gp1=values[3*count+j],gp2=values[4*count+j];
    out[j].g=res::GTaylor{g0,(gm2-8*gm1+8*gp1-gp2)/(12*dh),
      (-gp2+16*gp1-30*g0+16*gm1-gm2)/(12*dh*dh),(gp2-2*gp1+2*gm1-gm2)/(2*dh*dh*dh)};
  }
  std::free(grid); std::free(values);
  return count;
}
inline void half_day_six(const HalfDayCoef* table, int count, double e0, double i0,
                        double t, const Kepler& k, double n, double eta, double si,
                        double ci, double theta, double* six) {
  // Fixed-size blocks retain bounded stack usage; coefficients remain per object.
  constexpr int block = 64;
  res::ResCoef terms[block];
  const double d = k.e - e0, di = k.i - i0;
  for (int first = 0; first < count; first += block) {
    const int size = std::min(block, count - first);
    for (int j = 0; j < size; ++j) {
      const HalfDayCoef& c = table[first+j];
      const double G = c.g.g0+d*(c.g.g1+d*(0.5*c.g.g2+d*c.g.g3/6.0));
      const double dG = c.g.g1+d*(c.g.g2+0.5*d*c.g.g3);
      const double F = c.f+di*(c.df+di*(0.5*c.ddf+di*c.dddf/6.0));
      const double dF = c.df+di*(c.ddf+0.5*di*c.dddf);
      terms[j] = res::ResCoef{c.l,c.m,c.p,c.k,static_cast<int8_t>((c.l-c.m)&1),
        kEgmC[c.l][c.m],kEgmS[c.l][c.m],F*G,F*dG,dF*G};
    }
    res::resonance_six(terms,size,t,k,n,eta,si,ci,theta,six);
  }
}

/// The zonal tail, J_l for 6 <= l <= the degree (SPEC 2 carries J2-J5), first order in the
/// rates: the secular terms of even l (p = l/2, q = 0) and the long-period terms of odd l (w = l - 2p = +-1,
/// q = -w: psi = w omega, O(e) in G and O(1) in the eccentricity vector); `wide` (epoch e above kWideE, SPEC 16.11):
/// every long-period term, w = l - 2p for p = 0..l, G = O(e^|w|). Per term at the epoch (float): Fbar, dFbar/di,
/// G = g0 + g1 e; G is taken at the current e.
inline int zonal_count(int degree, bool wide) {
  int c = 0;
  for (int l = 6; l <= degree; ++l) c += wide ? l + 1 : (l & 1) ? 2 : 1;
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

inline void zonal_visit_terms(int degree, bool wide, double i0, double e0, float* F) {
  double f[72], fp[72], fm[72];
  const double h = 1e-5;
  int idx = 0;
  for (int l = 6; l <= degree; ++l) {
    const int wl = wide ? l : (l & 1);
    for (int w = -wl; w <= wl; w += 2) {
      const int p = (l - w) / 2, q = -w;
      normalized_Fk(0, w, l, i0, f);
      normalized_Fk(0, w, l, i0 + h, fp);
      normalized_Fk(0, w, l, i0 - h, fm);
      double g0, g1;
      if (wide) {
        double G, dG;
        node_G(l, p, q, e0, G, dG);
        g1 = dG;
        g0 = G - dG * e0;
      } else if (q == 0) {
        const double c2 = 0.25 * l * (l + 1);
        double G, dG;
        if (e0 < 0.005) { G = 1.0 + c2 * e0 * e0; dG = 2.0 * c2 * e0; }
        else res::exact_G(l, p, 0, e0, G, dG);
        g1 = dG;
        g0 = G - dG * e0;
      } else if (e0 < 0.01) {
        g1 = res::hansen_G(l, p, q, 1e-3) / 1e-3;
        g0 = 0.0;
      } else {
        double G, dG;
        res::exact_G(l, p, q, e0, G, dG);
        g1 = dG;
        g0 = G - dG * e0;
      }
      float* t = F + 4 * idx++;
      t[0] = static_cast<float>(f[l]);
      t[1] = static_cast<float>((fp[l] - fm[l]) / (2.0 * h));
      t[2] = static_cast<float>(g0);
      t[3] = static_cast<float>(g1);
    }
  }
}

/// The zonal tail's contribution to the six rates (n-dot, e-dot, i-dot, e varpi-dot, sin i Omega-dot,
/// lambda-dot - n), at the current mean elements.
inline void zonal_six(const float* F, int degree, bool wide, const Kepler& kp, double n, double eta, double si, double ci,
                      double* six) {
  const double a = kp.a, e = kp.e < 1e-12 ? 1e-12 : kp.e;
  const double sin_i = std::fabs(si) < 1e-12 ? (si < 0.0 ? -1e-12 : 1e-12) : si;
  double sw, cw;
  fm::sincos(kp.argp, sw, cw);
  double ck[72], sk[72];  // cos and sin of k omega, `wide`
  ck[0] = 1.0;
  sk[0] = 0.0;
  for (int k = 1; wide && k <= degree; ++k) {
    ck[k] = ck[k - 1] * cw - sk[k - 1] * sw;
    sk[k] = sk[k - 1] * cw + ck[k - 1] * sw;
  }
  const double ia = 1.0 / a;
  double A = kMu * std::pow(ia, 7);  // mu / a^(l+1), l = 6
  double sW = 0, sE = 0, sI = 0, sA = 0;
  int idx = 0;
  for (int l = 6; l <= degree; ++l) {
    const double C = kEgmC[l][0];
    const int wl = wide ? l : (l & 1);
    for (int w = -wl; w <= wl; w += 2) {
      const float* f = F + 4 * idx++;
      // psi = w omega; S = C cos psi (l even), C sin psi (l odd; S_l0 = 0)
      const int aw = w < 0 ? -w : w;
      const double sp = wide ? (w < 0 ? -sk[aw] : sk[aw]) : w * sw, cp = wide ? ck[aw] : cw;
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
  const double na2 = n * a * a;
  const double tanhalf = sin_i / (1.0 + ci);
  six[1] += -eta * sW / (na2 * e);
  six[2] += ci * sW / (na2 * eta * sin_i);
  six[3] += (eta / na2) * sE + e * tanhalf / (na2 * eta) * sI;
  six[4] += sI / (na2 * eta);
  six[5] += -(2.0 / (n * a)) * sA + (eta * e / (na2 * (1.0 + eta))) * sE + (tanhalf / (na2 * eta)) * sI;
}

/// The shallow resonant terms. For each k = 1..3 and order m whose
/// angle psi = k (omega + M) + m (Omega - theta) (q = 0, l - 2p = k) drifts
/// slower than kShallowBand x n, the terms of degree l = max(m, k)..
/// the degree with l = k mod 2: F and dF/di at the epoch inclination, G
/// (and dG) at the epoch eccentricity, as SPEC 6 fixes them; integrated with the
/// rates (the grid resolves periods of 1 / band orbits).
constexpr int kShallowMax = 160;

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
  res::ResCoef c[kShallowMax];
};

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
inline double shallow_weight(const SecularRates& sr, int k, int m, double n) {
  const double psidot = k * (sr.mdot + sr.argp) + m * (sr.node - kOmegaE);
  const double x = std::fabs(psidot) / (kShallowBand * n);
  if (x <= 0.9) return 1.0;
  if (x >= 1.1) return 0.0;
  const double c = std::cos(0.5 * kPi * (x - 0.9) / 0.2);
  return c * c;
}

inline int shallow_terms(int degree, double n, double e0, double i0, ShallowTerms& out) {
  out.count = 0;
  const int lmax = degree > 70 ? 70 : degree;
  if (lmax < 2) return 0;
  const SecularRates sr = secular_rates(n, e0, i0);
  constexpr int k = 1;  // k = 2, 3 do not pay (2.13 against 2.03 km at day 3)
  for (int m = 2; m <= lmax; ++m) {
    const double psidot = k * (sr.mdot + sr.argp) + m * (sr.node - kOmegaE);
    if (!(std::fabs(psidot) < kShallowSelect * kShallowBand * n)) continue;
    double F[72], Fp[72], Fm[72];
    const double h = 1e-5;
    normalized_Fk(m, k, lmax, i0, F);
    normalized_Fk(m, k, lmax, i0 + h, Fp);
    normalized_Fk(m, k, lmax, i0 - h, Fm);
    int l0 = m > k ? m : k;
    if ((l0 - k) & 1) ++l0;
    for (int l = l0; l <= lmax; l += 2) {
      if (out.count >= kShallowMax) break;
      const int pp = (l - k) / 2;
      double G, dG;
      res::exact_G(l, pp, 0, e0, G, dG);
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
      c.dfg = (Fp[l] - Fm[l]) / (2.0 * h) * G;
    }
  }
  return out.count;
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
/// Sets whose mean elements lie this close to a held grid's share it, read linearly in the offsets (a set's perturbed copies for
/// its partials and covariance share the set's grid).
constexpr double kShareE = 3e-4, kShareI = 1e-4, kShareA = 1e-4;
struct WideGrid {
  int degree;         // the families' highest degree
  int count;          // (m, w) families
  double n, e, i, a;  // the mean elements it was built at
  int8_t* m;
  int8_t* w;
  float* v;           // count x 6 x kGridN x (re, im): the value
  uint16_t* dv;       // count x 3 (d/de, d/di, d/(da/a)) x 6 x kGridD x (re, im), half precision
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

/// One set of family grids at (n, e, i): out[f][6][kGridN] complex (re, im interleaved), families in (m, w) order with any
/// forcing; returns the count. `cls`: the class whose terms the rates carry.
inline int wide_families(int degree, int cls, double n, double e, double inc, int8_t* fm_out, int8_t* fw_out, double* out) {
  const double eta = std::sqrt(1.0 - e * e), a = std::pow(kKe / n, kX2o3), p0 = a * eta * eta;
  const double c = std::cos(inc), si = std::sin(inc), j2 = 1.5 * kJ2 / (p0 * p0);
  const double mdot = n + 0.5 * j2 * n * eta * (3.0 * c * c - 1.0), wdot = 0.5 * j2 * n * (5.0 * c * c - 1.0);
  const double node_rate = -j2 * n * c, na2 = n * a * a;
  constexpr int NE = kGridNE;
  double E[NE], M[NE], cf[NE], sf[NE], ar[NE], sE[NE], fwang[NE];
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
  const double h = 1e-5;
  double f[72], fp[72], fmn[72];
  double* ws = static_cast<double*>(std::malloc(static_cast<size_t>(11) * 2 * NE * sizeof(double)));
  if (ws == nullptr) return -1;
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
      // the harmonics the table's rules leave out, from each forcing function: m-daily (w = j = 0), the class's, the half-day
      // tail, the slow band
      for (int l = l0; l <= degree; l += 2) {
        const int p = (l - w) / 2;
        const double F = f[l], dF = (fp[l] - fmn[l]) / (2.0 * h);
        const bool odd = ((l - m) & 1) != 0;
        const double A = kMu * std::pow(1.0 / a, l + 1);
        const double Sr = A * (odd ? -kEgmS[l][m] : kEgmC[l][m]), Si = A * (odd ? -kEgmC[l][m] : -kEgmS[l][m]);
        const int jlo = static_cast<int>(std::floor(nu - kShallowBand * n / mdot)) - 1, jhi = static_cast<int>(std::ceil(nu + kShallowBand * n / mdot)) + 1;
        for (int j = -(degree + 64); j <= degree + 64; ++j) {
          const int q = j - w;
          bool out_ = w == 0 && j == 0;
          // the half-day tail, carried in the half-day class's rates (16.2; sp_terms leaves it out of the table the same way)
          if (cls == 2 && l > 5 && (m & 1) == 0 && j == m / 2) out_ = true;
          for (int t = 0; t < carried.count && !out_; ++t)
            if (carried.t[t].l == l && carried.t[t].m == m && carried.t[t].p == p && carried.t[t].q == q) out_ = true;
          if (!out_ && j >= jlo && j <= jhi) out_ = std::fabs(w * wdot + j * mdot + m * (node_rate - kOmegaE)) < kShallowBand * n;
          if (!out_) continue;
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
          const double Z[5][2] = {{-j * F * G * Si, j * F * G * Sr}, {F * G * Sr, F * G * Si}, {F * dG * Sr, F * dG * Si},
                                  {dF * G * Sr, dF * G * Si}, {-(l + 1) / a * F * G * Sr, -(l + 1) / a * F * G * Si}};
          for (int k = 0; k < NE; ++k) {
            const double cj = std::cos(j * M[k]), sj = std::sin(j * M[k]);
            for (int z = 0; z < 5; ++z) { gr[z][0][k] -= Z[z][0] * cj - Z[z][1] * sj; gr[z][1][k] -= Z[z][0] * sj + Z[z][1] * cj; }
          }
        }
      }
      // H = e^{-i nu e sin E} IFFT(FFT(R (1 - e cos E) e^{i nu e sin E}) / (i (k - nu))) / mdot
      double cph_[NE], sph_[NE];
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
  const size_t vb = static_cast<size_t>(cap) * per * sizeof(float), db = static_cast<size_t>(cap) * 3 * dper * sizeof(uint16_t);
  char* block = static_cast<char*>(std::malloc(vb + db + 2 * static_cast<size_t>(cap)));
  float* v = reinterpret_cast<float*>(block);
  uint16_t* dv = block != nullptr ? reinterpret_cast<uint16_t*>(block + vb) : nullptr;
  int8_t* fm = block != nullptr ? reinterpret_cast<int8_t*>(block + vb + db) : nullptr;
  int8_t* fw = block != nullptr ? fm + cap : nullptr;
  int8_t* sm = static_cast<int8_t*>(std::malloc(2 * cap));
  BuildScratch& bs = build_scratch();
  for (int32_t expected = 0; !__atomic_compare_exchange_n(&bs.word, &expected, 1, false, __ATOMIC_ACQUIRE, __ATOMIC_RELAXED);) expected = 0;
  const auto release = [&]() { __atomic_store_n(&bs.word, 0, __ATOMIC_RELEASE); };
  if (bs.size < one) {
    std::free(bs.sp);
    std::free(bs.sn);
    bs.sp = static_cast<double*>(std::malloc(one * sizeof(double)));
    bs.sn = static_cast<double*>(std::malloc(one * sizeof(double)));
    bs.size = bs.sp != nullptr && bs.sn != nullptr ? one : 0;
  }
  double* sp = bs.sp;
  double* sn = bs.sn;
  const auto fail = [&]() { release(); std::free(block); std::free(sm); return false; };
  if (bs.size < one || block == nullptr || sm == nullptr) return fail();
  const int count = wide_families(degree, cls, n, e, inc, fm, fw, sn);
  if (count < 0) return fail();
  for (int f = 0; f < count; ++f)
    for (size_t k = 0; k < per; ++k) v[static_cast<size_t>(f) * per + k] = static_cast<float>(sn[f * per + k]);
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
  g.n = n; g.e = e; g.i = inc; g.a = std::pow(kKe / n, kX2o3);
  return true;
}

inline void wide_grid_release(WideGrid& g) {
  std::free(g.v);  // the grid's one block (value, derivative grids, family indices)
  g.m = g.w = nullptr; g.v = nullptr; g.dv = nullptr; g.count = 0;
}

/// A grid's bytes (value and derivative grids).
inline size_t wide_grid_bytes(const WideGrid& g) {
  return static_cast<size_t>(g.count) * (6 * kGridN * 2 * sizeof(float) + 3 * 6 * kGridD * 2 * sizeof(uint16_t));
}

/// Grids are shared by sets within kShareE, kShareI, kShareA of a held grid's elements: each counted, freed when its last holder
/// drops it, the kGridIdle most recently dropped kept until other grids are built.
struct GridSlot {
  WideGrid* g;
  int cls, refs;
  uint32_t stamp;  // when it last became idle
};
/// Idle grids kept (3.1 MB each): a catalog refresh finds its objects' grids; the oldest goes first. kGridSlots bounds every grid held.
constexpr int kGridIdle = 128, kGridSlots = 256;
struct GridCache {
  int32_t word;
  int count;
  uint32_t clock;
  GridSlot slot[kGridSlots];
};
/// Frees the oldest idle grid while more than `keep` are idle (the cache's lock held).
inline void evict_idle(struct GridCache& c, int keep);
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

/// A grid for (n, e, i): a live or idle one whose sharing range holds the elements, else a new one; nullptr out of memory.
inline WideGrid* wide_grid_acquire(int degree, int cls, double n, double e, double inc) {
  GridCache& c = grid_cache();
  const double a = std::pow(kKe / n, kX2o3);
  cache_lock(&c.word);
  for (int k = 0; k < c.count; ++k) {
    const WideGrid& g = *c.slot[k].g;
    if (g.degree == degree && c.slot[k].cls == cls && std::fabs(e - g.e) <= kShareE && std::fabs(inc - g.i) <= kShareI &&
        std::fabs(a / g.a - 1.0) <= kShareA) {
      ++c.slot[k].refs;
      WideGrid* hit = c.slot[k].g;
      cache_unlock(&c.word);
      return hit;
    }
  }
  // a build: the oldest idle grid goes first beyond kGridIdle - 1, so a worker holds a bounded number
  evict_idle(c, kGridIdle - 1);
  cache_unlock(&c.word);
  WideGrid* g = static_cast<WideGrid*>(std::calloc(1, sizeof(WideGrid)));
  if (g == nullptr) return nullptr;
  if (!wide_grid_build(degree, cls, n, e, inc, *g)) { std::free(g); return nullptr; }
  cache_lock(&c.word);
  if (c.count < kGridSlots) {
    c.slot[c.count++] = GridSlot{g, cls, 1, 0};
    cache_unlock(&c.word);
    return g;
  }
  cache_unlock(&c.word);
  free_grid(g);
  return nullptr;
}

/// Adds a holder to a grid already held.
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
        c.slot[k].stamp = ++c.clock;
        evict_idle(c, kGridIdle);
      }
      break;
    }
  cache_unlock(&c.word);
}

inline void evict_idle(GridCache& c, int keep) {
  for (;;) {
    int idle = 0, oldest = -1;
    for (int k = 0; k < c.count; ++k)
      if (c.slot[k].refs == 0) {
        ++idle;
        if (oldest < 0 || c.slot[k].stamp < c.slot[oldest].stamp) oldest = k;
      }
    if (idle <= keep || oldest < 0) return;
    free_grid(c.slot[oldest].g);
    c.slot[oldest] = c.slot[--c.count];
  }
}


/// The displacements in the six-component set, the grid's cubic in E at the current anomaly times e^{i (w omega + m beta)}.
inline void wide_six(const WideGrid& g, double t, const Kepler& kp, double theta_g0, double* six) {
  const double de = kp.e - g.e, di = kp.i - g.i, da = kp.a / g.a - 1.0;
  double E = kp.m;
  for (int it = 0; it < 50; ++it) {
    const double d = (E - kp.e * std::sin(E) - kp.m) / (1.0 - kp.e * std::cos(E));
    E -= d;
    if (std::fabs(d) < 1e-14) break;
  }
  E = std::fmod(E, kTwoPi);
  if (E < 0.0) E += kTwoPi;
  // the four-point periodic cubic on N nodes at E: node indices and weights
  const auto cubic = [&](int N, int* idx, double* wt) {
    const double x = E / kTwoPi * N;
    int i1 = static_cast<int>(x);
    const double u = x - i1;
    idx[0] = (i1 - 1 + N) % N; idx[1] = i1 % N; idx[2] = (i1 + 1) % N; idx[3] = (i1 + 2) % N;
    wt[0] = -u * (u - 1.0) * (u - 2.0) / 6.0; wt[1] = (u + 1.0) * (u - 1.0) * (u - 2.0) / 2.0;
    wt[2] = -(u + 1.0) * u * (u - 2.0) / 2.0; wt[3] = (u + 1.0) * u * (u - 1.0) / 6.0;
  };
  int idx[4], jdx[4];
  double wt[4], wd[4];
  cubic(kGridN, idx, wt);
  cubic(kGridD, jdx, wd);
  const double off[3] = {de, di, da};
  const double beta = kp.node - (theta_g0 + kOmegaE * t);
  const size_t per = static_cast<size_t>(6) * kGridN * 2, dper = static_cast<size_t>(6) * kGridD * 2;
  const float* half = half_table();
  for (int f = 0; f < g.count; ++f) {
    const float* v = g.v + static_cast<size_t>(f) * per;
    const uint16_t* dv = g.dv + static_cast<size_t>(f) * 3 * dper;
    const double ph = g.w[f] * kp.argp + g.m[f] * beta, cph = std::cos(ph), sph = std::sin(ph);
    for (int z = 0; z < 6; ++z) {
      double hr = 0.0, hi = 0.0;
      for (int k = 0; k < 4; ++k) {
        const size_t at = (static_cast<size_t>(z) * kGridN + idx[k]) * 2;
        hr += wt[k] * v[at];
        hi += wt[k] * v[at + 1];
      }
      for (int d = 0; d < 3; ++d)
        for (int k = 0; k < 4; ++k) {
          const size_t at = d * dper + (static_cast<size_t>(z) * kGridD + jdx[k]) * 2;
          hr += off[d] * wd[k] * half[dv[at]];
          hi += off[d] * wd[k] * half[dv[at + 1]];
        }
      six[z] += hr * cph - hi * sph;
    }
  }
}

}  // namespace tess
