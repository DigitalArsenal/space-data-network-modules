// -----------------------------------------------------------------------------
// SPEC 6: tesseral resonance (closed-modules main ef9e2169, amendment 5 726d6b2).
// SGP4XP integrates the class of the epoch mean motion with the functions at the
// epoch e_0, i_0 (6.3); the rates the library reports with its native elements
// take the class of the current n and the functions at the current e and i
// (amendment 5, from those readouts: 6.8, 6.9).
// A class sums exactly its SPEC 6.1 terms (l, m, p, q), k = l - 2p + q, of
// Kaula's disturbing function
//   R = sum (mu / a^(l+1)) F_lmp G_lpq S_lmpq,
//   psi = (l - 2p) omega + k M + m (Omega - theta_G(t)),
//   S = C_lm cos psi + S_lm sin psi (l - m even), -S_lm cos psi + C_lm sin psi (odd),
// with the unnormalized EGM-96 tesserals of 6.2, differentiated term by term and
// carried through Lagrange's planetary equations into the six-component set
// (6.3). F_lmp is Kaula's polynomial in sin i and cos i, its monomials built at
// compile time for the class tables.
//
// SGP4XP replicates the library (6.4): G_lpq as the Maclaurin polynomial up to
// e^26 (even q) or e^27 (odd q) at every e (tools/hansen_series.py), D_632 in
// place of dF_632/di, and the series departures that 6.4 states with values:
// the 16 h G_410 with 2 e^2 (derivative exact), the 16 h dG_40,-2/de without its
// e^13 and e^15 terms, the 1-day G_30,-1 ending at e^25, and the abs(q) = 1
// series' e^27 coefficient c_27 - 2 c_1 b_27 (main 789db82).
// -----------------------------------------------------------------------------

// Included inside namespace sdnap::xpt (xp_theory.inc).
namespace res {

#include "xp_hansen_series.inc"

struct Harmonic {
  int8_t l, m;
  double C, S;  // unnormalized EGM-96 (SPEC 6.2)
};

inline const Harmonic& harmonic(int l, int m) {
  static const Harmonic table[] = {
      {2, 2, 1.57446037456404e-6, -9.03803806638557e-7}, {3, 1, 2.19263852916859e-6, 2.68424890296779e-7},
      {3, 2, 3.08989206880511e-7, -2.11437612437343e-7}, {3, 3, 1.00548778064384e-7, 1.97222559005906e-7},
      {4, 1, -5.08799360403833e-7, -4.49144872839336e-7}, {4, 2, 7.84175859843762e-8, 1.48177868295612e-7},
      {4, 3, 5.92099402629132e-8, -1.20077667633627e-8}, {4, 4, -3.98407411766274e-9, 6.52571425370430e-9},
      {5, 2, 1.05587168390898e-7, -5.23291936216342e-8}, {5, 3, -1.49300637492288e-8, -7.09734236889537e-9},
      {5, 4, -2.29930029012696e-9, 3.86712335850938e-10}, {6, 3, 1.18542072651316e-9, 1.87163685038141e-10},
  };
  for (const Harmonic& h : table)
    if (h.l == l && h.m == m) return h;
  return table[0];  // unreachable: every term's (l, m) is in the table
}

struct TermSet {
  int count;
  const ResonantTerm* t;
};

/// The SPEC 6.1 terms of a class (1 one-day, 2 half-day, 3 eight-hour, 4 sixteen-hour).
inline TermSet class_terms(int cls) {
  switch (cls) {
    case 1: return {int(sizeof(kTerms_one_day) / sizeof(ResonantTerm)), kTerms_one_day};
    case 2: return {int(sizeof(kTerms_half_day) / sizeof(ResonantTerm)), kTerms_half_day};
    case 3: return {int(sizeof(kTerms_eight_hour) / sizeof(ResonantTerm)), kTerms_eight_hour};
    case 4: return {int(sizeof(kTerms_sixteen_hour) / sizeof(ResonantTerm)), kTerms_sixteen_hour};
    default: return {0, nullptr};
  }
}

inline constexpr double factorial(int k) {
  double f = 1.0;
  for (int j = 2; j <= k; ++j) f *= j;
  return f;
}

inline constexpr double binomial(int n, int k) {
  if (k < 0 || k > n || n < 0) return 0.0;
  return factorial(n) / (factorial(k) * factorial(n - k));
}

/// Kaula's inclination function F_lmp(i) and its exact derivative (SPEC 6.4),
/// from sin i and cos i.
inline void kaula_F(int l, int m, int p, double si, double ci, double& F, double& dF) {
  F = 0.0;
  dF = 0.0;
  const int k = (l - m) / 2;
  const int tmax = p < k ? p : k;
  for (int t = 0; t <= tmax; ++t) {
    const int a = l - m - 2 * t;
    const double lead = factorial(2 * l - 2 * t) / (factorial(t) * factorial(l - t) * factorial(a) * std::pow(2.0, 2 * l - 2 * t));
    for (int s = 0; s <= m; ++s) {
      double inner = 0.0;
      for (int c = 0; c <= a + s; ++c) {
        const double term = binomial(a + s, c) * binomial(m - s, p - t - c);
        if (term != 0.0) inner += ((c - k) % 2 == 0 ? 1.0 : -1.0) * term;
      }
      if (inner == 0.0) continue;
      const double coef = lead * binomial(m, s) * inner;
      // sin^a cos^s and its derivative a sin^(a-1) cos^(s+1) - s sin^(a+1) cos^(s-1)
      F += coef * std::pow(si, a) * std::pow(ci, s);
      double d = 0.0;
      if (a > 0) d += a * std::pow(si, a - 1) * std::pow(ci, s + 1);
      if (s > 0) d -= s * std::pow(si, a + 1) * std::pow(ci, s - 1);
      dF += coef * d;
    }
  }
}

/// F_lmp(i) as monomials coef sin^a i cos^s i, in kaula_F's order and with its coefficients. The class tables have
/// l - m <= 3, so t <= 1 and at most 2 (m + 1) monomials.
struct KaulaMono {
  double coef;
  int8_t a, s;
};
struct KaulaPoly {
  int8_t count;
  KaulaMono m[10];
};
inline constexpr double power_of_two(int k) {
  double r = 1.0;
  for (int j = 0; j < k; ++j) r *= 2.0;
  return r;
}
inline constexpr KaulaPoly kaula_poly(int l, int m, int p) {
  KaulaPoly out{};
  const int k = (l - m) / 2;
  const int tmax = p < k ? p : k;
  for (int t = 0; t <= tmax; ++t) {
    const int a = l - m - 2 * t;
    const double lead = factorial(2 * l - 2 * t) / (factorial(t) * factorial(l - t) * factorial(a) * power_of_two(2 * l - 2 * t));
    for (int s = 0; s <= m; ++s) {
      double inner = 0.0;
      for (int c = 0; c <= a + s; ++c) {
        const double term = binomial(a + s, c) * binomial(m - s, p - t - c);
        if (term != 0.0) inner += ((c - k) % 2 == 0 ? 1.0 : -1.0) * term;
      }
      if (inner == 0.0) continue;
      out.m[out.count].coef = lead * binomial(m, s) * inner;
      out.m[out.count].a = static_cast<int8_t>(a);
      out.m[out.count].s = static_cast<int8_t>(s);
      ++out.count;
    }
  }
  return out;
}
template <int N>
struct ClassPolys {
  KaulaPoly f[N];
};
template <int N>
inline constexpr ClassPolys<N> class_polys(const ResonantTerm (&ts)[N]) {
  ClassPolys<N> out{};
  for (int j = 0; j < N; ++j) out.f[j] = kaula_poly(ts[j].l, ts[j].m, ts[j].p);
  return out;
}
inline constexpr auto kPolys_one_day = class_polys(kTerms_one_day);
inline constexpr auto kPolys_half_day = class_polys(kTerms_half_day);
inline constexpr auto kPolys_eight_hour = class_polys(kTerms_eight_hour);
inline constexpr auto kPolys_sixteen_hour = class_polys(kTerms_sixteen_hour);
inline const KaulaPoly* class_polys_of(int cls) {
  switch (cls) {
    case 1: return kPolys_one_day.f;
    case 2: return kPolys_half_day.f;
    case 3: return kPolys_eight_hour.f;
    case 4: return kPolys_sixteen_hour.f;
    default: return nullptr;
  }
}

/// F and dF/di from the monomials, sp[j] = sin^j i, cp[j] = cos^j i.
inline void kaula_eval(const KaulaPoly& P, const double* sp, const double* cp, double& F, double& dF) {
  F = 0.0;
  dF = 0.0;
  for (int q = 0; q < P.count; ++q) {
    const KaulaMono& mo = P.m[q];
    F += mo.coef * sp[mo.a] * cp[mo.s];
    double d = 0.0;
    if (mo.a > 0) d += mo.a * sp[mo.a - 1] * cp[mo.s + 1];
    if (mo.s > 0) d -= mo.s * sp[mo.a + 1] * cp[mo.s - 1];
    dF += mo.coef * d;
  }
}

/// The SPEC 6 band of a mean motion n (rad/min), in the bands' order: 1 one-day, 2 half-day, 3 eight-hour,
/// 4 sixteen-hour, 0 none. The six limits are 0.8, 1.2, 1.6, 2.4, 3.6 and 1.8 times 2 pi / 1436 rad/min to eight digits.
inline int band_of(double n) {
  if (n > 0.0035003818 && n < 0.0052505727) return 1;
  if (n >= 0.0070007636 && n <= 0.0105011454) return 2;
  if (n > 0.0105011454 && n <= 0.015751718) return 3;
  if (n >= 0.0052505727 && n <= 0.007875859) return 4;
  return 0;
}

/// The library's stand-in for dF_632/di (SPEC 6.4), with c = cos i, s = sin i.
inline double library_D632(double si, double ci) {
  const double c = ci, c2 = c * c, c3 = c2 * c, c4 = c2 * c2, c5 = c4 * c, c6 = c3 * c3;
  return (259875.0 * c6 + 259875.0 * c5 - 390285.0 * c4 - 372330.0 * c3 + 155925.0 * c2 + 127575.0 * c - 10395.0) / 128.0 -
         (2835.0 / 8.0) * si * c * (1.0 + c);
}

/// The Maclaurin polynomial of G_lpq and its derivative (SPEC 6.4), Horner in e^2.
/// `drop_last` leaves out the highest term of G (not of dG); `skip_d` lists up to
/// two powers of e absent from dG.
/// The library's e^27 coefficient of an abs(q) = 1 series (SPEC 6.4): c_27 - 2 c_1 b_27, b_27 = C_13 / 2^27 the e^27
/// coefficient of beta = e / (1 + sqrt(1 - e^2)), as if the expansion in beta stopped after e^25.
constexpr double kB27 = 742900.0 / 134217728.0;
inline double library_coef(const HansenSeries& h, int j) {
  if ((h.q == 1 || h.q == -1) && h.lead + 2 * j == 27) return h.c[j] - 2.0 * h.c[0] * kB27;
  return h.c[j];
}

inline void series_G(const HansenSeries& h, double e, double& G, double& dG, bool drop_last = false,
                     int skip_d0 = -1, int skip_d1 = -1, bool library = false) {
  const double e2 = e * e;
  double lead = 1.0;
  for (int j = 0; j < h.lead; ++j) lead *= e;
  G = 0.0;
  dG = 0.0;
  auto coef_of = [&](int j) { return library ? library_coef(h, j) : h.c[j]; };
  const int nG = drop_last ? h.count - 1 : h.count;
  for (int j = nG - 1; j >= 0; --j) G = G * e2 + coef_of(j);
  G *= lead;
  // dG/de = sum (lead + 2j) c_j e^(lead + 2j - 1)
  for (int j = h.count - 1; j >= 0; --j) {
    const int power = h.lead + 2 * j - 1;  // power of e in this derivative term
    const double coef = (power == skip_d0 || power == skip_d1) ? 0.0 : (h.lead + 2 * j) * coef_of(j);
    dG = dG * e2 + coef;
  }
  // the lowest derivative power is lead - 1 (lead >= 1) or 1 (lead = 0, whose j = 0 term vanishes)
  if (h.lead >= 1) {
    double lm1 = 1.0;
    for (int j = 0; j < h.lead - 1; ++j) lm1 *= e;
    dG *= lm1;
  } else {
    // lead 0: the j = 0 coefficient is 0 * c_0, so dG / e is the polynomial in e^2 starting at j = 1
    dG = 0.0;
    for (int j = h.count - 1; j >= 1; --j) {
      const int power = 2 * j - 1;
      const double coef = (power == skip_d0 || power == skip_d1) ? 0.0 : (2 * j) * coef_of(j);
      dG = dG * e2 + coef;
    }
    dG *= e;
  }
}

/// The Maclaurin series of G_lpq, or nullptr when no class uses it.
inline const HansenSeries* hansen_series(int l, int p, int q) {
  for (int i = 0; i < kHansenCount; ++i)
    if (kHansen[i].l == l && kHansen[i].p == p && kHansen[i].q == q) return &kHansen[i];
  return nullptr;
}

/// Kaula's eccentricity function G_lpq(e) itself, the Hansen coefficient
/// X_{l-2p+q}^{-(l+1), l-2p}(e) = (1/2 pi) Int (a/r)^(l+1) cos((l-2p) f - (l-2p+q) M) dM,
/// by the trapezoid rule in eccentric anomaly (geometric convergence: the
/// e^s cos(s E) content falls below rounding well inside N samples).
inline double hansen_G(int l, int p, int q, double e) {
  const int kN = e < 0.01 ? 32 : e < 0.1 ? 64 : e < 0.8 ? 128 : (e < 0.95 ? 512 : 4096);
  const double eta = std::sqrt(1.0 - e * e);
  const int j = l - 2 * p, k = l - 2 * p + q;
  double sum = 0.0;
  for (int i = 0; i < kN; ++i) {
    const double E = kTwoPi * (i + 0.5) / kN;
    double sE, cE;
    fm::sincos(E, sE, cE);
    const double roa = 1.0 - e * cE;
    const double nu = std::atan2(eta * sE, cE - e);
    const double M = E - e * sE;
    const double ir = 1.0 / roa;
    double aor = ir;
    for (int m = 1; m <= l; ++m) aor *= ir;
    sum += aor * std::cos(j * nu - k * M) * roa;  // dM = (1 - e cos E) dE
  }
  return sum / kN;
}

/// One term's parts (SPEC 6.3): the integers, the tesserals and F G, F dG/de, dF/di G at the elements evaluated.
struct ResCoef {
  int8_t l, m, p, k;
  int8_t odd;  ///< l - m odd
  double C, S;
  double fg, fdg, dfg;
};

/// The terms of class `cls` at the current e and i (SPEC 6.3, amendment 5): the integers, the tesserals and F G,
/// F dG/de, dF/di G, as the SGP4XP library computes them (SPEC 6.4). si, ci: sin i and cos i. Returns the count written
/// (at most 29).
inline int current_terms(int cls, double e, double si, double ci, ResCoef* out) {
  const TermSet ts = class_terms(cls);
  const KaulaPoly* polys = class_polys_of(cls);
  if (polys == nullptr) return 0;
  double sp[8], cp[8];
  sp[0] = 1.0;
  cp[0] = 1.0;
  sp[1] = si;
  cp[1] = ci;
  for (int j = 2; j < 8; ++j) {
    sp[j] = sp[j - 1] * si;
    cp[j] = cp[j - 1] * ci;
  }
  for (int j = 0; j < ts.count; ++j) {
    const ResonantTerm& t = ts.t[j];
    const Harmonic& hm = harmonic(t.l, t.m);
    double F, dF, G, dG;
    kaula_eval(polys[j], sp, cp, F, dF);
    const HansenSeries& hs = kHansen[t.hansen];
    if (t.l == 6 && t.m == 3 && t.p == 2) dF = library_D632(si, ci);
    if (cls == 1 && t.l == 3 && t.p == 0 && t.q == -1) {
      series_G(hs, e, G, dG, /*drop_last=*/true, -1, -1, true);  // G_30,-1 ends at e^25; dG keeps 27 (c27 + 2 b27) e^26
    } else if (cls == 4 && t.l == 4 && t.p == 0 && t.q == -2) {
      series_G(hs, e, G, dG, false, 13, 15, true);  // dG_40,-2/de without e^13, e^15
    } else {
      series_G(hs, e, G, dG, false, -1, -1, true);
      if (cls == 4 && t.l == 4 && t.p == 1 && t.q == 0) G += e * e;  // G_410 with 2 e^2
    }
    ResCoef& c = out[j];
    c.l = t.l;
    c.m = t.m;
    c.p = t.p;
    c.k = t.k;
    c.odd = static_cast<int8_t>((t.l - t.m) & 1);
    c.C = hm.C;
    c.S = hm.S;
    c.fg = F * G;
    c.fdg = F * dG;
    c.dfg = dF * G;
  }
  return ts.count;
}

/// The resonance contribution to the six rates (n-dot, e-dot, i-dot,
/// e varpi-dot, sin i Omega-dot, lambda-dot - n) at the current mean elements
/// kp, time t (minutes from epoch); theta_g0 the Greenwich angle at epoch (1.2).
/// The terms (coefs, count) in Lagrange's equations (SPEC 6.3).
inline void resonance_six(const ResCoef* coefs, int count, double t, const Kepler& kp, double n, double eta, double si,
                          double ci, double theta_g0, double* six) {
  if (count == 0) return;
  const double a = kp.a, e = kp.e < 1e-12 ? 1e-12 : kp.e;
  const double sin_i = std::fabs(si) < 1e-12 ? (si < 0.0 ? -1e-12 : 1e-12) : si;
  const double thetag = theta_g0 + kOmegaE * t;
  const double ia = 1.0 / a;
  double amp[71];  // mu / a^(l+1)
  amp[0] = kMu * ia;
  int lmax = 0;
  for (int j = 0; j < count; ++j) lmax = coefs[j].l > lmax ? coefs[j].l : lmax;
  for (int l = 1; l <= lmax; ++l) amp[l] = amp[l - 1] * ia;
  double sM = 0.0, sW = 0.0, sO = 0.0, sE = 0.0, sI = 0.0, sA = 0.0;
  int last_w = 0x7fff, last_k = 0, last_m = 0;  // consecutive terms of one angle share its sine and cosine
  double sp = 0.0, cp = 1.0;
  for (int j = 0; j < count; ++j) {
    const ResCoef& c = coefs[j];
    const int w = c.l - 2 * c.p;
    if (w != last_w || c.k != last_k || c.m != last_m) {
      const double psi = w * kp.argp + c.k * kp.m + c.m * (kp.node - thetag);
      fm::sincos(psi, sp, cp);
      last_w = w;
      last_k = c.k;
      last_m = c.m;
    }
    const double S = c.odd ? -c.S * cp + c.C * sp : c.C * cp + c.S * sp;
    const double dS = c.odd ? c.S * sp + c.C * cp : -c.C * sp + c.S * cp;
    const double A = amp[c.l];
    const double fgdS = A * c.fg * dS;
    sM += c.k * fgdS;
    sW += (c.l - 2 * c.p) * fgdS;
    sO += c.m * fgdS;
    sE += A * c.fdg * S;
    sI += A * c.dfg * S;
    sA += -(c.l + 1) * A * c.fg * S * ia;
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

}  // namespace res
