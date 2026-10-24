// -----------------------------------------------------------------------------
// SDN-AP 2d (DESIGN): tesseral m-daily short-periodics. For even l and
// p = l/2, q = 0, Kaula's term has psi = m (Omega - theta_G): period about one
// m-th of a day, amplitude O(e^0). With the slow elements frozen over the
// period (first order), Lagrange's equations integrate over psi in closed form
// (dR/dM = dR/domega = 0, so a, n and e do not oscillate):
//   Delta i              = -m A F G S(psi) / (n a^2 eta sin i psi')
//   Delta (sin i Omega)  =  A F' G S1(psi) / (n a^2 eta psi')
//   Delta (e varpi)      = [eta A F G' / (n a^2) + e tan(i/2) A F' G / (n a^2 eta)] S1(psi) / psi'
//   Delta lambda         = [2 (l+1) A F G / (n a^2) + eta e A F G' / (n a^2 (1+eta))
//                           + tan(i/2) A F' G / (n a^2 eta)] S1(psi) / psi'
// with A = mu / a^(l+1), F = Fbar_l,m,l/2 (normalized, at the epoch inclination,
// held per object), G = <(a/r)^(l+1)> (closed form), S the term's Cbar/Sbar combination,
// S1 its antiderivative in psi, and psi' = m (Omega-dot_J2 - omega_E). Added at
// output time to the equinoctial elements (SDN-AP only), coefficients the pinned
// EGM (build.mjs).
// -----------------------------------------------------------------------------

// Included inside namespace sdnap::xpt (xp_theory.inc), after resonance.inc.
namespace tess {

#include "gravity_egm.h"

/// SDN-AP's resonance classes and shallow terms on ($PCF MEAN_ELEMENT.ENABLE_RESONANCE).
inline bool& resonance_on() {
  static bool on = true;
  return on;
}

/// Highest even degree of the m-daily set (diagnostic: sdnap_mdaily_degree); 0 off.
inline int& mdaily_degree() {
  static int d = 12;  // measured: 8 -> 12 pays (FFM Starlink day 3 4.26 -> 2.03 km), 16 does not (2.22)
  return d;
}

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
      if (s2 > 0) dQ += binom * central * s2 * es / e;
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

/// SDN-AP 2d.3b: the remaining first-order tesseral terms at output time, Kaula's (l, m, p, q) with
/// q in {-1, 0, 1}, 2 <= l <= sp_degree(), 1 <= m <= l, except the m-daily set (q = 0, l = 2p) and the
/// shallow band: psi = w omega + j M + m (Omega - theta_G), w = l - 2p, j = w + q. The rates of
/// res::resonance_six integrated over psi with the slow elements frozen (int dS dt = S / psi-dot, int S dt
/// = -dS / psi-dot), plus the mean longitude's second integral of the n oscillation, 3 j A F G dS /
/// (a^2 psi-dot^2). The q = +-1 terms are O(e) in G but O(1) in the eccentricity vector (Lagrange's 1/e):
/// for odd l with j = 0 they oscillate at the m-daily frequency, amplified by n / psi-dot. sp_mask() picks
/// the families: 1 q = 0 with j != 0, 2 q = +-1 with j = 0, 4 q = +-1 with j != 0. Per term at the epoch
/// (float): Fbar, dFbar/di and G(e) = g0 + g1 e linearized there (g0 = 0 for q = +-1 at small e).
inline int& sp_degree() {
  static int d = 7;  // measured (FFM Starlink, 29 windows, day 3): 1.54 -> 0.97 km with family 2 to l = 7
  return d;
}
inline int& sp_mask() {
  static int k = 2;  // family 2 (q = +-1, j = 0); families 1 and 4 pay little for their bytes (0.97 -> 0.85 km, 31 KB)
  return k;
}
inline double& shallow_band();

/// Visits the (l, m, p, q) of the set in its fixed order.
template <class Fn>
inline void sp_visit(int degree, int mask, Fn&& fn) {
  for (int l = 2; l <= degree; ++l)
    for (int m = 1; m <= l; ++m)
      for (int p = 0; p <= l; ++p)
        for (int q = -1; q <= 1; ++q) {
          const int w = l - 2 * p, j = w + q;
          if (q == 0 && w == 0) continue;  // the m-daily set
          const int family = q == 0 ? 1 : (j == 0 ? 2 : 4);
          if (!(mask & family)) continue;
          if (j < -(l + 1) || j > l + 1) continue;
          fn(l, m, p, q);
        }
}

inline int sp_count(int degree, int mask) {
  int c = 0;
  sp_visit(degree, mask, [&](int, int, int, int) { ++c; });
  return c;
}

/// Fills F (4 floats a term) at the epoch mean motion n0, inclination i0 and eccentricity e0.
inline int sp_terms(int degree, int mask, double n0, double i0, double e0, float* F) {
  const double eta = std::sqrt(1.0 - e0 * e0), a0 = std::pow(kKe / n0, kX2o3), p0 = a0 * eta * eta;
  const double c0 = std::cos(i0), j2 = 1.5 * kJ2 / (p0 * p0);
  const double mdot = n0 + 0.5 * j2 * n0 * eta * (3.0 * c0 * c0 - 1.0), wdot = 0.5 * j2 * n0 * (5.0 * c0 * c0 - 1.0);
  const double node_rate = -j2 * n0 * c0;
  int idx = 0;
  int cached_m = -1, cached_w = 99, cached_l = -1;
  double f[72], fp[72], fm[72];
  const double h = 1e-5;
  sp_visit(degree, mask, [&](int l, int m, int p, int q) {
    const int w = l - 2 * p, j = w + q;
    if (m != cached_m || w != cached_w || l != cached_l) {
      normalized_Fk(m, w, l, i0, f);
      normalized_Fk(m, w, l, i0 + h, fp);
      normalized_Fk(m, w, l, i0 - h, fm);
      cached_m = m;
      cached_w = w;
      cached_l = l;
    }
    double g0, g1;
    if (q == 0) {
      // X^{-(l+1), w}_w to O(e^2): 1 + c2 e^2, c2 = l (l + 1) / 4 - w^2; linearized at e0
      const double c2 = 0.25 * l * (l + 1) - static_cast<double>(w) * w;
      double G, dG;
      if (e0 < 0.005) { G = 1.0 + c2 * e0 * e0; dG = 2.0 * c2 * e0; }
      else res::exact_G(l, p, 0, e0, G, dG);
      g1 = dG;
      g0 = G - dG * e0;
    } else if (e0 < 0.01) {
      // O(e): G = c e, the slope from the Hansen coefficient at e = 1e-3
      g1 = res::hansen_G(l, p, q, 1e-3) / 1e-3;
      g0 = 0.0;
    } else {
      double G, dG;
      res::exact_G(l, p, q, e0, G, dG);
      g1 = dG;
      g0 = G - dG * e0;
    }
    const bool shallow = std::fabs(w * wdot + j * mdot + m * (node_rate - kOmegaE)) < shallow_band() * n0;
    float* t = F + 4 * idx++;
    t[0] = shallow ? 0.0f : static_cast<float>(f[l]);
    t[1] = static_cast<float>((fp[l] - fm[l]) / (2.0 * h));
    t[2] = static_cast<float>(g0);
    t[3] = static_cast<float>(g1);
  });
  return idx;
}

/// The displacements in the six-component set (n, e, i, e varpi, sin i Omega, lambda), first order.
inline void sp_six(const float* F, int degree, int mask, double t, const Kepler& kp, double n, double eta, double si,
                   double ci, double theta_g0, double* six) {
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
  for (int q = 1; q <= degree + 1; ++q) {
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
  for (int l = 1; l <= degree; ++l) amp[l] = amp[l - 1] * ia;
  double sM = 0, sW = 0, sO = 0, sE = 0, sI = 0, sA = 0, sL = 0;
  int idx = 0;
  sp_visit(degree, mask, [&](int l, int m, int p, int q) {
    const float* f = F + 4 * idx++;
    if (f[0] == 0.0f) return;
    const int w = l - 2 * p, j = w + q;
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
    const double G = f[2] + f[3] * e, dG = f[3];
    const double A = amp[l];
    const double AfgidS = A * f[0] * G * idS;
    sM += j * AfgidS;
    sW += w * AfgidS;
    sO += m * AfgidS;
    sE += A * f[0] * dG * iS;
    sI += A * f[1] * G * iS;
    sA += -(l + 1) * A * f[0] * G * iS * ia;
    sL += j * A * f[0] * G * dS / (psidot * psidot);
  });
  const double na2 = n * a * a;
  const double tanhalf = sin_i / (1.0 + ci);
  six[0] += -3.0 * ia * ia * sM;
  six[1] += (eta * eta * sM - eta * sW) / (na2 * e);
  six[2] += (ci * sW - sO) / (na2 * eta * sin_i);
  six[3] += (eta / na2) * sE + e * tanhalf / (na2 * eta) * sI;
  six[4] += sI / (na2 * eta);
  six[5] += -(2.0 / (n * a)) * sA + (eta * e / (na2 * (1.0 + eta))) * sE + (tanhalf / (na2 * eta)) * sI + 3.0 * ia * ia * sL;
}

/// SDN-AP 2d.6: the zonal tail, J_l for 6 <= l <= zonal_degree() (SPEC 2 carries J2-J5), first order in the
/// rates: the secular terms of even l (p = l/2, q = 0) and the long-period terms of odd l (w = l - 2p = +-1,
/// q = -w: psi = w omega, O(e) in G and O(1) in the eccentricity vector). Per term at the epoch (float):
/// Fbar, dFbar/di, G = g0 + g1 e; G is taken at the current e.
inline int& zonal_degree() {
  static int d = 20;  // measured on the zonal-only FFM truth (52350, day 3): J2-J5 0.35 km, to J10 0.14, to J20 0.047, to J40 0.042
  return d;
}

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

/// SDN-AP 2d.5: the shallow resonant terms. For each k = 1..3 and order m whose
/// angle psi = k (omega + M) + m (Omega - theta) (q = 0, l - 2p = k) drifts
/// slower than shallow_band() x n, the terms of degree l = max(m, k)..
/// shallow_degree() with l = k mod 2: F and dF/di at the epoch inclination, G
/// (and dG) at the epoch eccentricity, as SPEC 6 fixes them; integrated with the
/// rates (the grid resolves periods of 1 / band orbits).
inline int& shallow_degree() {
  static int d = 31;  // measured: 21 / 31 / 41 / 70 give 2.15 / 1.89 / 2.02 / 2.03 km at day 3 (FFM Starlink)
  return d;
}
inline double& shallow_band() {
  static double b = 0.045;
  return b;
}
inline int& shallow_only_m() {  // diagnostic: keep one order m > 0, orders >= -m < 0, all 0
  static int m = 0;
  return m;
}
inline int& step_divisor() {  // diagnostic: SDN-AP grid step = 2 orbits / divisor
  static int d = 1;
  return d;
}
inline int& shallow_kmax() {
  static int k = 1;  // measured: k = 2, 3 do not pay (2.13 against 2.03 km at day 3)
  return k;
}

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

/// The near-resonant terms' displacements in the six-component set, first order (as sp_six, q = 0).
inline void near_six(const ShallowCoef* cs, int count, double t, const Kepler& kp, double n, double eta, double si,
                     double ci, double theta_g0, double* six) {
  const double a = kp.a, e = kp.e < 1e-12 ? 1e-12 : kp.e;
  const double sin_i = std::fabs(si) < 1e-12 ? (si < 0.0 ? -1e-12 : 1e-12) : si;
  const double p_sl = a * eta * eta, j2 = 1.5 * kJ2 / (p_sl * p_sl);
  const double node_rate = -j2 * n * ci, wdot = 0.5 * j2 * n * (5.0 * ci * ci - 1.0);
  const double udot = n + 0.5 * j2 * n * eta * (3.0 * ci * ci - 1.0) + wdot;
  const double thetag = theta_g0 + kOmegaE * t;
  const double ia = 1.0 / a;
  double amp[72];
  amp[0] = kMu * ia;
  for (int l = 1; l <= 70; ++l) amp[l] = amp[l - 1] * ia;
  double sM = 0, sW = 0, sO = 0, sE = 0, sI = 0, sA = 0, sL = 0;
  int last_k = 0, last_m = 0;
  double sp = 0.0, cp = 1.0;
  for (int q = 0; q < count; ++q) {
    const ShallowCoef& c = cs[q];
    if (c.k != last_k || c.m != last_m) {
      fm::sincos(c.k * (kp.argp + kp.m) + c.m * (kp.node - thetag), sp, cp);
      last_k = c.k;
      last_m = c.m;
    }
    const double psidot = c.k * udot + c.m * (node_rate - kOmegaE);
    const double C = kEgmC[c.l][c.m], S0 = kEgmS[c.l][c.m];
    const bool odd = ((c.l - c.m) & 1) != 0;
    const double Sv = odd ? -S0 * cp + C * sp : C * cp + S0 * sp;
    const double dS = odd ? S0 * sp + C * cp : -C * sp + S0 * cp;
    const double iS = -dS / psidot, idS = Sv / psidot;
    const double A = amp[c.l];
    const double AfgidS = A * c.fg * idS;
    sM += c.k * AfgidS;
    sW += c.k * AfgidS;
    sO += c.m * AfgidS;
    sE += A * c.fdg * iS;
    sI += A * c.dfg * iS;
    sA += -(c.l + 1) * A * c.fg * iS * ia;
    sL += c.k * A * c.fg * dS / (psidot * psidot);
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

struct ShallowTerms {  // the epoch scratch; xp_init keeps count entries
  int count;
  res::ResCoef c[kShallowMax];
};

/// SDN-AP 2d.5b: the near-resonant terms just outside the shallow band (shallow_band() <= |psi-dot| / n <
/// near_band(), the same k, q = 0, l and m sets): first order at output time, amplified by (n / psi-dot)^2.
inline double& near_band() {
  static double b = 0.0;  // diagnostic until measured (0: none)
  return b;
}
constexpr int kNearMax = 96;

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
  const double x = std::fabs(psidot) / (shallow_band() * n);
  if (x <= 0.9) return 1.0;
  if (x >= 1.1) return 0.0;
  const double c = std::cos(0.5 * kPi * (x - 0.9) / 0.2);
  return c * c;
}

inline int shallow_terms(double n, double e0, double i0, ShallowTerms& out, ShallowTerms* near = nullptr) {
  out.count = 0;
  if (near != nullptr) near->count = 0;
  const int lmax = shallow_degree() > 70 ? 70 : shallow_degree();
  if (lmax < 2) return 0;
  const SecularRates sr = secular_rates(n, e0, i0);
  for (int k = 1; k <= shallow_kmax(); ++k)
    for (int m = 2; m <= lmax; ++m) {
      const double psidot = k * (sr.mdot + sr.argp) + m * (sr.node - kOmegaE);
      const bool in_band = std::fabs(psidot) < kShallowSelect * shallow_band() * n;
      const bool near_term = !in_band && near != nullptr && std::fabs(psidot) < near_band() * n;
      if (!in_band && !near_term) continue;
      ShallowTerms& dst = in_band ? out : *near;
      const int cap = in_band ? kShallowMax : kNearMax;
      if (shallow_only_m() > 0 && m != shallow_only_m()) continue;
      if (shallow_only_m() < 0 && m < -shallow_only_m()) continue;
      double F[72], Fp[72], Fm[72];
      const double h = 1e-5;
      normalized_Fk(m, k, lmax, i0, F);
      normalized_Fk(m, k, lmax, i0 + h, Fp);
      normalized_Fk(m, k, lmax, i0 - h, Fm);
      int l0 = m > k ? m : k;
      if ((l0 - k) & 1) ++l0;
      for (int l = l0; l <= lmax; l += 2) {
        if (dst.count >= cap) break;
        const int pp = (l - k) / 2;
        double G, dG;
        res::exact_G(l, pp, 0, e0, G, dG);
        res::ResCoef& c = dst.c[dst.count++];
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
