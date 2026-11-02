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

/// The upper bound of the table: the general set of `degree` and kNearMax near-resonant terms.
constexpr int kNearMax = 500;
inline int sp_bound(int degree) {
  int c = kNearMax;
  for (int l = 2; l <= degree; ++l) c += l * (l + 1) * 3;
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
  const auto add = [&](int l, int m, int p, int q, double fv, double dfv) {
    const int w = l - 2 * p, j = w + q;
    const res::TermSet carried = res::class_terms(cls);
    for (int c = 0; c < carried.count; ++c)
      if (carried.t[c].l == l && carried.t[c].m == m && carried.t[c].p == p && carried.t[c].q == q) return;
    const double psidot = w * wdot + j * mdot + m * (node_rate - kOmegaE);
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
    if (weight == 0.0) return;
    double g0, g1;
    sp_g(l, p, q, e0, g0, g1);
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
  for (int l = 2; l <= degree; ++l)
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
          if (count >= sp_bound(degree)) break;
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

/// The zonal tail, J_l for 6 <= l <= the degree (SPEC 2 carries J2-J5), first order in the
/// rates: the secular terms of even l (p = l/2, q = 0) and the long-period terms of odd l (w = l - 2p = +-1,
/// q = -w: psi = w omega, O(e) in G and O(1) in the eccentricity vector). Per term at the epoch (float):
/// Fbar, dFbar/di, G = g0 + g1 e; G is taken at the current e.
inline int zonal_count(int degree) {
  int c = 0;
  for (int l = 6; l <= degree; ++l) c += (l & 1) ? 2 : 1;
  return c;
}

inline void zonal_visit_terms(int degree, double i0, double e0, float* F) {
  double f[72], fp[72], fm[72];
  const double h = 1e-5;
  int idx = 0;
  for (int l = 6; l <= degree; ++l) {
    for (int w = (l & 1) ? -1 : 0; w <= ((l & 1) ? 1 : 0); w += 2) {
      const int p = (l - w) / 2, q = -w;
      normalized_Fk(0, w, l, i0, f);
      normalized_Fk(0, w, l, i0 + h, fp);
      normalized_Fk(0, w, l, i0 - h, fm);
      double g0, g1;
      if (q == 0) {
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
inline void zonal_six(const float* F, int degree, const Kepler& kp, double n, double eta, double si, double ci,
                      double* six) {
  const double a = kp.a, e = kp.e < 1e-12 ? 1e-12 : kp.e;
  const double sin_i = std::fabs(si) < 1e-12 ? (si < 0.0 ? -1e-12 : 1e-12) : si;
  double sw, cw;
  fm::sincos(kp.argp, sw, cw);
  const double ia = 1.0 / a;
  double A = kMu * std::pow(ia, 7);  // mu / a^(l+1), l = 6
  double sW = 0, sE = 0, sI = 0, sA = 0;
  int idx = 0;
  for (int l = 6; l <= degree; ++l) {
    const double C = kEgmC[l][0];
    for (int w = (l & 1) ? -1 : 0; w <= ((l & 1) ? 1 : 0); w += 2) {
      const float* f = F + 4 * idx++;
      // psi = w omega; S = C cos psi (l even), C sin psi (l odd; S_l0 = 0)
      const double sp = w * sw, cp = cw;  // sin(w omega), cos(w omega) for w = +-1; w = 0: psi = 0
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

}  // namespace tess
