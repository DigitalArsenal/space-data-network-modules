// AP: the first-order short-period terms of the zonal harmonics J3 to J5 (SPEC 8, 16.3; stack #451). Closed form in the
// true anomaly, exact in the eccentricity. Included by xp_theory.inc inside sdnap::xpt (kMu, kJ3..kJ5, kAf..kN).
//
// For degree l the generating function is W_l = (1/n) int (R_l - <R_l>_M) dM, R_l = -mu J_l r^-(l+1) P_l(sin i sin u)
// (Earth radii, minutes). With dM = (r/a)^2 / eta df, R_l dM = K_l Q_l(f) df, K_l = -mu J_l a^-(l+1) eta^-(2l-1), and
//   Q_l = (1 + e cos f)^(l-1) P_l(s sin(omega + f)),
// a finite trigonometric polynomial in f and omega:
//   P_l(s sin u) = sum_k A_k(s) T(k u), T = sin for odd l and cos for even l;
//   (1 + e cos f)^(l-1) = sum_j B_j(e) cos(j f);
//   T(k u) cos(j f) = (T(k omega + (k + j) f) + T(k omega + (k - j) f)) / 2.
// So W_l = (K_l / n) [S(f) + c0 (f - M) + C]:
//   S is the antiderivative of Q - c0 with zero mean over f;
//   c0 is the f-mean of Q (its terms with no f);
//   C = -<S>_M, from <e^{i m f}>_M = (-beta)^|m| (1 + |m| eta), beta = e / (1 + eta).
// The corrections are Lagrange's planetary equations applied to W. They are written for (af, ag, chi, psi, lambda, n) in
// forms regular at small e and small i:
//   e dvarpi = (eta/D) W_e + e tan(i/2) W_i / (D eta);   d tan(i/2) = cos i (W_omega / sin i) / (D eta (1 + cos i));
//   tan(i/2) dOmega = W_i / (D eta (1 + cos i));   dlambda = -2 W_a / (n a) + eta e W_e / (D (1 + eta)) + tan(i/2) W_i / (D eta);
// with D = n a^2. W_omega / sin i is exact: every term that depends on omega carries s^k, k >= 1.
// Against two-body plus J3 to J5 integrated over one orbit (RK4, the mean elements drifting at the same closed form's
// first-order rates), the terms agree to 0.1 to 0.4 mm RMS from e 0.001 to 0.83 (SPEC 16.3,
// test/zonal-short-period.e2e.mjs).
/// Above this epoch inclination (179 deg) a set takes no zonal short-period terms: within 1 deg of a retrograde equatorial
/// orbit tan(i/2) diverges and the first-order corrections to chi and psi stop being small (6 cm at 179 deg, 14 m at 179.9).
constexpr double kZonalSpMaxIncl = 179.0 * 3.14159265358979323846 / 180.0;

namespace zsp {

constexpr int kMaxL = 5;
/// a[l][k][p]: A_k(s) = sum_p a[l][k][p] s^p; b[l][j][q]: B_j(e) = sum_q b[l][j][q] e^q.
struct Tables {
  double a[kMaxL + 1][kMaxL + 1][kMaxL + 1];
  double b[kMaxL + 1][kMaxL + 1][kMaxL + 1];
};
constexpr double binom(int n, int k) {
  if (k < 0 || k > n) return 0.0;
  double r = 1.0;
  for (int t = 1; t <= k; ++t) r = r * (n - k + t) / t;
  return r;
}
constexpr Tables make_tables() {
  Tables T{};
  // Legendre coefficients by (n + 1) P_{n+1} = (2n + 1) x P_n - n P_{n-1}
  double c[kMaxL + 1][kMaxL + 1] = {};
  c[0][0] = 1.0;
  c[1][1] = 1.0;
  for (int n = 1; n < kMaxL; ++n)
    for (int p = 0; p <= n + 1; ++p) c[n + 1][p] = ((2.0 * n + 1.0) * (p > 0 ? c[n][p - 1] : 0.0) - n * c[n - 1][p]) / (n + 1.0);
  // sin^p u in multiple angles (sines of odd multiples for odd p, cosines of even multiples for even p)
  double t[kMaxL + 1][kMaxL + 1] = {};
  for (int p = 0; p <= kMaxL; ++p) {
    double pw = 1.0;
    for (int q = 0; q < p; ++q) pw *= 2.0;
    if (p % 2 == 1) {
      for (int q = 0; q <= (p - 1) / 2; ++q) t[p][p - 2 * q] += 2.0 / pw * (((p - 1) / 2 - q) % 2 ? -1.0 : 1.0) * binom(p, q);
    } else {
      t[p][0] += binom(p, p / 2) / pw;
      for (int q = 0; q < p / 2; ++q) t[p][p - 2 * q] += 2.0 / pw * ((p / 2 - q) % 2 ? -1.0 : 1.0) * binom(p, q);
    }
  }
  // cos^q f in multiple angles
  double u[kMaxL + 1][kMaxL + 1] = {};
  for (int q = 0; q <= kMaxL; ++q) {
    double pw = 1.0;
    for (int r = 0; r < q; ++r) pw *= 2.0;
    for (int r = 0; r <= q; ++r) {
      const int j = q - 2 * r;
      u[q][j < 0 ? -j : j] += binom(q, r) / pw;
    }
  }
  for (int l = 2; l <= kMaxL; ++l) {
    for (int k = 0; k <= l; ++k)
      for (int p = 0; p <= l; ++p) T.a[l][k][p] = c[l][p] * t[p][k];
    for (int j = 0; j < l; ++j)
      for (int q = 0; q < l; ++q) T.b[l][j][q] = binom(l - 1, q) * u[q][j];
  }
  return T;
}
inline constexpr Tables kT = make_tables();
inline constexpr double kJ[kMaxL + 1] = {0.0, 0.0, kJ2, kJ3, kJ4, kJ5};

/// The corrections d (af, ag, chi, psi, lambda, n) of degrees lo..hi at mean Keplerian elements: a (Earth radii), n
/// (rad/min), e, eta, the sines and cosines of i, Omega, omega and f, and f - M in (-pi, pi]. With `rates`, also the
/// first-order rates of <R> in the same six elements (a check's: the theory's rates carry these terms in section 2).
inline void terms(int lo, int hi, double a, double n, double e, double eta, double si, double ci, double sO, double cO, double sw,
                  double cw, double sf, double cf, double f_m, double* d, double* rates = nullptr) {
  double cwk[kMaxL + 1], swk[kMaxL + 1];  // cos, sin k omega
  cwk[0] = 1.0;
  swk[0] = 0.0;
  for (int k = 1; k <= hi; ++k) {
    cwk[k] = cwk[k - 1] * cw - swk[k - 1] * sw;
    swk[k] = swk[k - 1] * cw + cwk[k - 1] * sw;
  }
  constexpr int kOff = kMaxL - 1;  // cos, sin m f for m = -(hi - 1)..(2 hi - 1) at kOff + m
  double cfm[3 * kMaxL], sfm[3 * kMaxL];
  cfm[kOff] = 1.0;
  sfm[kOff] = 0.0;
  for (int m = 1; m <= 2 * hi - 1; ++m) {
    cfm[kOff + m] = cfm[kOff + m - 1] * cf - sfm[kOff + m - 1] * sf;
    sfm[kOff + m] = sfm[kOff + m - 1] * cf + cfm[kOff + m - 1] * sf;
  }
  for (int m = 1; m <= hi - 1; ++m) {
    cfm[kOff - m] = cfm[kOff + m];
    sfm[kOff - m] = -sfm[kOff + m];
  }
  // X_m = <cos m f>_M = (-beta)^m (1 + m eta) and its derivative in e
  const double beta = e / (1.0 + eta), dbeta = 1.0 / (eta * (1.0 + eta)), deta = -e / eta;
  double X[2 * kMaxL], Xe[2 * kMaxL];
  {
    double pb = 1.0, pbm = 0.0;  // (-beta)^m, (-beta)^(m - 1)
    for (int m = 0; m < 2 * hi; ++m) {
      X[m] = pb * (1.0 + m * eta);
      Xe[m] = -m * pbm * dbeta * (1.0 + m * eta) + pb * m * deta;
      pbm = pb;
      pb *= -beta;
    }
  }
  const double ecf = e * cf, su = sw * cf + cw * sf, eta2 = eta * eta, inv_eta2 = 1.0 / eta2;
  const double fe = sf * (2.0 + ecf) * inv_eta2;  // df/de at fixed M
  const double inv_a = 1.0 / a, inv_eta = 1.0 / eta, inv_n = 1.0 / n;
  constexpr double kInvM[3 * kMaxL] = {0.0, 1.0, 1.0 / 2, 1.0 / 3, 1.0 / 4, 1.0 / 5, 1.0 / 6, 1.0 / 7, 1.0 / 8, 1.0 / 9,
                                       1.0 / 10, 1.0 / 11, 1.0 / 12, 1.0 / 13, 1.0 / 14};
  double Wt = 0, WMt = 0, Wwst = 0, Wst = 0, Wet = 0, Wat = 0;
  double Rws = 0, Rs = 0, Re = 0, Ra = 0;
  // K_l = -mu J_l a^-(l+1) eta^-(2l-1), from the powers of 1/a and 1/eta
  double pa = inv_a * inv_a * inv_a, pe = inv_eta * inv_eta * inv_eta;  // l = 2
  for (int l = 2; l < lo; ++l) { pa *= inv_a; pe *= inv_eta2; }
  for (int l = lo; l <= hi; ++l) {
    pa *= inv_a;
    pe *= inv_eta2;
    const double K = -kMu * kJ[l] * pa * pe;
    const double Kn = K * inv_n;
    const bool odd = (l & 1) != 0;
    double A[kMaxL + 1], As[kMaxL + 1], Aw[kMaxL + 1];  // A_k, dA_k/ds, A_k / s
    for (int k = 0; k <= l; ++k) {
      double v = kT.a[l][k][0], vs = 0.0, vw = 0.0, spm = 1.0;  // s^(p - 1)
      for (int p = 1; p <= l; ++p) {
        const double c = kT.a[l][k][p];
        v += c * spm * si;
        vs += p * c * spm;
        vw += c * spm;
        spm *= si;
      }
      A[k] = v;
      As[k] = vs;
      Aw[k] = vw;
    }
    double B[kMaxL], Be[kMaxL];  // B_j, dB_j/de
    for (int j = 0; j < l; ++j) {
      double v = 0.0, ve = 0.0, eq = 1.0, eqm = 0.0;
      for (int q = 0; q < l; ++q) {
        const double c = kT.b[l][j][q];
        v += c * eq;
        ve += q * c * eqm;
        eqm = eq;
        eq *= e;
      }
      B[j] = v;
      Be[j] = ve;
    }
    double S = 0, Se = 0, Ss = 0, Sws = 0, c0 = 0, c0e = 0, c0s = 0, c0ws = 0, C = 0, Ce = 0, Cs = 0, Cws = 0;
    for (int k = odd ? 1 : 0; k <= l; k += 2) {
      for (int j = 0; j < l; ++j) {
        const double w = j == 0 ? 1.0 : 0.5;
        for (int sgn = (j == 0 ? 1 : -1); sgn <= 1; sgn += 2) {
          const int m = k + sgn * j;
          const double AB = w * A[k] * B[j], ABe = w * A[k] * Be[j], ABs = w * As[k] * B[j], ABw = w * Aw[k] * B[j] * k;
          if (m == 0) {
            if (odd) {
              c0 += AB * swk[k]; c0e += ABe * swk[k]; c0s += ABs * swk[k]; c0ws += ABw * cwk[k];
            } else {
              c0 += AB * cwk[k]; c0e += ABe * cwk[k]; c0s += ABs * cwk[k]; c0ws -= ABw * swk[k];
            }
            continue;
          }
          const double cp = cwk[k] * cfm[kOff + m] - swk[k] * sfm[kOff + m];  // cos, sin (k omega + m f)
          const double sp = swk[k] * cfm[kOff + m] + cwk[k] * sfm[kOff + m];
          const int am = m < 0 ? -m : m;
          const double im = m < 0 ? -kInvM[am] : kInvM[am];
          if (odd) {  // T = sin: int sin(phi) df = -cos(phi) / m
            S -= AB * cp * im; Se -= ABe * cp * im; Ss -= ABs * cp * im; Sws += ABw * sp * im;
            C += AB * cwk[k] * X[am] * im;
            Ce += (ABe * X[am] + AB * Xe[am]) * cwk[k] * im;
            Cs += ABs * X[am] * cwk[k] * im;
            Cws -= ABw * X[am] * swk[k] * im;
          } else {  // T = cos: int cos(phi) df = sin(phi) / m
            S += AB * sp * im; Se += ABe * sp * im; Ss += ABs * sp * im; Sws += ABw * cp * im;
            C -= AB * swk[k] * X[am] * im;
            Ce -= (ABe * X[am] + AB * Xe[am]) * swk[k] * im;
            Cs -= ABs * X[am] * swk[k] * im;
            Cws -= ABw * X[am] * cwk[k] * im;
          }
        }
      }
    }
    // Q itself, directly: (1 + e cos f)^(l-1) P_l(s sin u)
    const double x = si * su;
    double Pm = 1.0, P = x;
    for (int nn = 1; nn < l; ++nn) {
      const double nx = ((2.0 * nn + 1.0) * x * P - nn * Pm) / (nn + 1.0);
      Pm = P;
      P = nx;
    }
    double wl = 1.0;
    for (int q = 0; q < l - 1; ++q) wl *= 1.0 + ecf;
    const double Q = wl * P;
    const double W = Kn * (S + c0 * f_m + C);
    Wt += W;
    WMt += Kn * (Q * (1.0 + ecf) * (1.0 + ecf) / (eta2 * eta) - c0);
    Wwst += Kn * (Sws + c0ws * f_m + Cws);
    Wst += Kn * (Ss + c0s * f_m + Cs);
    Wet += (2.0 * l - 1.0) * e / eta2 * W + Kn * (Se + Q * fe + c0e * f_m + Ce);
    Wat += -(l - 0.5) * W / a;
    if (rates != nullptr) {
      Rws += K * c0ws;
      Rs += K * c0s;
      Re += K * ((2.0 * l - 1.0) * e / eta2 * c0 + c0e);
      Ra += -(l + 1.0) / a * K * c0;
    }
  }
  (void)Wt;
  const double D = n * a * a, ti = si / (1.0 + ci), cv = cw * cO - sw * sO, sv = sw * cO + cw * sO;
  const auto put = [&](double WM, double Wws, double Ws, double We, double Wa, double* out) {
    const double Wi = Ws * ci;
    const double de = eta / (D * e) * (eta * WM - si * Wws);
    const double edw = eta / D * We + e * ti / (D * eta) * Wi;
    const double dT = ci * Wws / (D * eta * (1.0 + ci));
    const double tdO = Wi / (D * eta * (1.0 + ci));
    out[kAf] = de * cv - edw * sv;
    out[kAg] = de * sv + edw * cv;
    out[kChi] = dT * sO + tdO * cO;
    out[kPsi] = dT * cO - tdO * sO;
    out[kLam] = -2.0 * Wa / (n * a) + eta * e / (D * (1.0 + eta)) * We + ti * Wi / (D * eta);
    out[kN] = -1.5 * n * (2.0 * WM / (n * a)) / a;
  };
  put(WMt, Wwst, Wst, Wet, Wat, d);
  if (rates != nullptr) put(0.0, Rws, Rs, Re, Ra, rates);
}

// ---- The same terms as trigonometric polynomials in f: the coefficients depend on the slow elements only ----------------

constexpr int kHarm = 2 * kMaxL + 1;  // the highest harmonic of f in a correction (Q (1 + e cos f)^2 and Q df/de at l = 5)
/// sum_m c[m] cos(m f) + sum_m s[m] sin(m f) + r (f - M)
struct Poly {
  double c[kHarm + 1];
  double s[kHarm + 1];
  double r;
};
/// The six corrections (af, ag, chi, psi, lambda, n) as polynomials in f at fixed slow elements.
struct Coefs {
  Poly d[6];
};
inline void poly_zero(Poly& p) {
  for (int m = 0; m <= kHarm; ++m) p.c[m] = p.s[m] = 0.0;
  p.r = 0.0;
}
/// p += w cos(phi + m f), phi given by its cosine and sine
inline void add_cos(Poly& p, int m, double w, double cphi, double sphi) {
  const int am = m < 0 ? -m : m;
  p.c[am] += w * cphi;
  if (am != 0) p.s[am] -= (m < 0 ? -1.0 : 1.0) * w * sphi;
}
/// p += w sin(phi + m f)
inline void add_sin(Poly& p, int m, double w, double cphi, double sphi) {
  const int am = m < 0 ? -m : m;
  p.c[am] += w * sphi;
  if (am != 0) p.s[am] += (m < 0 ? -1.0 : 1.0) * w * cphi;
}
/// out += w * p * cos(q f) (or sin(q f) when `sine`), the products folded onto harmonics 0..kHarm
inline void add_product(Poly& out, const Poly& p, int q, bool sine, double w) {
  for (int m = 0; m <= kHarm; ++m) {
    const double cm = p.c[m] * w * 0.5, sm = p.s[m] * w * 0.5;
    if (cm == 0.0 && sm == 0.0) continue;
    if (!sine) {  // cos m cos q = (cos(m+q) + cos(m-q)) / 2; sin m cos q = (sin(m+q) + sin(m-q)) / 2
      if (m + q <= kHarm) { out.c[m + q] += cm; out.s[m + q] += sm; }
      const int d = m - q;
      out.c[d < 0 ? -d : d] += cm;
      if (d != 0) out.s[d < 0 ? -d : d] += (d < 0 ? -sm : sm);
    } else {  // cos m sin q = (sin(m+q) - sin(m-q)) / 2; sin m sin q = (cos(m-q) - cos(m+q)) / 2
      if (m + q <= kHarm) { out.s[m + q] += cm; out.c[m + q] -= sm; }
      const int d = m - q;
      if (d != 0) out.s[d < 0 ? -d : d] -= (d < 0 ? -cm : cm);
      out.c[d < 0 ? -d : d] += sm;
    }
  }
}
inline void poly_axpy(Poly& out, double w, const Poly& p) {
  for (int m = 0; m <= kHarm; ++m) { out.c[m] += w * p.c[m]; out.s[m] += w * p.s[m]; }
  out.r += w * p.r;
}

/// The coefficients of the corrections of degrees lo..hi at the slow mean elements (as terms()'s arguments, without f).
inline void coefs(int lo, int hi, double a, double n, double e, double eta, double si, double ci, double sO, double cO, double sw,
                  double cw, Coefs& out) {
  double cwk[kMaxL + 1], swk[kMaxL + 1];
  cwk[0] = 1.0;
  swk[0] = 0.0;
  for (int k = 1; k <= hi; ++k) {
    cwk[k] = cwk[k - 1] * cw - swk[k - 1] * sw;
    swk[k] = swk[k - 1] * cw + cwk[k - 1] * sw;
  }
  const double beta = e / (1.0 + eta), dbeta = 1.0 / (eta * (1.0 + eta)), deta = -e / eta;
  double X[2 * kMaxL], Xe[2 * kMaxL];
  {
    double pb = 1.0, pbm = 0.0;
    for (int m = 0; m < 2 * hi; ++m) {
      X[m] = pb * (1.0 + m * eta);
      Xe[m] = -m * pbm * dbeta * (1.0 + m * eta) + pb * m * deta;
      pbm = pb;
      pb *= -beta;
    }
  }
  const double eta2 = eta * eta, inv_eta2 = 1.0 / eta2, inv_a = 1.0 / a, inv_eta = 1.0 / eta, inv_n = 1.0 / n;
  constexpr double kInvM[3 * kMaxL] = {0.0, 1.0, 1.0 / 2, 1.0 / 3, 1.0 / 4, 1.0 / 5, 1.0 / 6, 1.0 / 7, 1.0 / 8, 1.0 / 9,
                                       1.0 / 10, 1.0 / 11, 1.0 / 12, 1.0 / 13, 1.0 / 14};
  Poly WM, Wws, Ws, We, Wa;  // the channels, summed over the degrees
  poly_zero(WM); poly_zero(Wws); poly_zero(Ws); poly_zero(We); poly_zero(Wa);
  double pa = inv_a * inv_a * inv_a, pe = inv_eta * inv_eta * inv_eta;
  for (int l = 2; l < lo; ++l) { pa *= inv_a; pe *= inv_eta2; }
  for (int l = lo; l <= hi; ++l) {
    pa *= inv_a;
    pe *= inv_eta2;
    const double Kn = -kMu * kJ[l] * pa * pe * inv_n;
    const bool odd = (l & 1) != 0;
    double A[kMaxL + 1], As[kMaxL + 1], Aw[kMaxL + 1];
    for (int k = 0; k <= l; ++k) {
      double v = kT.a[l][k][0], vs = 0.0, vw = 0.0, spm = 1.0;
      for (int p = 1; p <= l; ++p) { const double c = kT.a[l][k][p]; v += c * spm * si; vs += p * c * spm; vw += c * spm; spm *= si; }
      A[k] = v; As[k] = vs; Aw[k] = vw;
    }
    double B[kMaxL], Be[kMaxL];
    for (int j = 0; j < l; ++j) {
      double v = 0.0, ve = 0.0, eq = 1.0, eqm = 0.0;
      for (int q = 0; q < l; ++q) { const double c = kT.b[l][j][q]; v += c * eq; ve += q * c * eqm; eqm = eq; eq *= e; }
      B[j] = v; Be[j] = ve;
    }
    // per degree: S (+ c0 (f - M) + C) and its partials, and Q itself
    Poly S, Se, Ss, Sws, Q;
    poly_zero(S); poly_zero(Se); poly_zero(Ss); poly_zero(Sws); poly_zero(Q);
    double c0 = 0, c0e = 0, c0s = 0, c0ws = 0, C = 0, Ce = 0, Cs = 0, Cws = 0;
    for (int k = odd ? 1 : 0; k <= l; k += 2) {
      for (int j = 0; j < l; ++j) {
        const double w = j == 0 ? 1.0 : 0.5;
        for (int sgn = (j == 0 ? 1 : -1); sgn <= 1; sgn += 2) {
          const int m = k + sgn * j;
          const double AB = w * A[k] * B[j], ABe = w * A[k] * Be[j], ABs = w * As[k] * B[j], ABw = w * Aw[k] * B[j] * k;
          if (odd) add_sin(Q, m, AB, cwk[k], swk[k]);
          else add_cos(Q, m, AB, cwk[k], swk[k]);
          if (m == 0) {
            if (odd) { c0 += AB * swk[k]; c0e += ABe * swk[k]; c0s += ABs * swk[k]; c0ws += ABw * cwk[k]; }
            else { c0 += AB * cwk[k]; c0e += ABe * cwk[k]; c0s += ABs * cwk[k]; c0ws -= ABw * swk[k]; }
            continue;
          }
          const int am = m < 0 ? -m : m;
          const double im = m < 0 ? -kInvM[am] : kInvM[am];
          if (odd) {  // S: -cos(phi)/m; d/domega: +k sin(phi)/m; C: +cos(k omega) X/m
            add_cos(S, m, -AB * im, cwk[k], swk[k]);
            add_cos(Se, m, -ABe * im, cwk[k], swk[k]);
            add_cos(Ss, m, -ABs * im, cwk[k], swk[k]);
            add_sin(Sws, m, ABw * im, cwk[k], swk[k]);
            C += AB * cwk[k] * X[am] * im;
            Ce += (ABe * X[am] + AB * Xe[am]) * cwk[k] * im;
            Cs += ABs * X[am] * cwk[k] * im;
            Cws -= ABw * X[am] * swk[k] * im;
          } else {  // S: sin(phi)/m; d/domega: k cos(phi)/m; C: -sin(k omega) X/m
            add_sin(S, m, AB * im, cwk[k], swk[k]);
            add_sin(Se, m, ABe * im, cwk[k], swk[k]);
            add_sin(Ss, m, ABs * im, cwk[k], swk[k]);
            add_cos(Sws, m, ABw * im, cwk[k], swk[k]);
            C -= AB * swk[k] * X[am] * im;
            Ce -= (ABe * X[am] + AB * Xe[am]) * swk[k] * im;
            Cs -= ABs * X[am] * swk[k] * im;
            Cws -= ABw * X[am] * cwk[k] * im;
          }
        }
      }
    }
    // W = Kn (S + c0 (f - M) + C) and the channels
    Poly W;
    poly_zero(W);
    poly_axpy(W, Kn, S);
    W.c[0] += Kn * C;
    W.r += Kn * c0;
    // W_M = Kn (Q (1 + e cos f)^2 / eta^3 - c0); (1 + e cos f)^2 = 1 + e^2/2 + 2 e cos f + (e^2/2) cos 2f
    const double ke = Kn * inv_eta2 * inv_eta;
    poly_axpy(WM, ke * (1.0 + 0.5 * e * e), Q);
    add_product(WM, Q, 1, false, ke * 2.0 * e);
    add_product(WM, Q, 2, false, ke * 0.5 * e * e);
    WM.c[0] -= Kn * c0;
    // W_omega / s, W_s
    poly_axpy(Wws, Kn, Sws);
    Wws.c[0] += Kn * Cws;
    Wws.r += Kn * c0ws;
    poly_axpy(Ws, Kn, Ss);
    Ws.c[0] += Kn * Cs;
    Ws.r += Kn * c0s;
    // W_e = (2l - 1) e / eta^2 W + Kn (S_e + Q f_e + c0_e (f - M) + C_e), f_e = (2 sin f + (e/2) sin 2f) / eta^2
    poly_axpy(We, (2.0 * l - 1.0) * e * inv_eta2, W);
    poly_axpy(We, Kn, Se);
    add_product(We, Q, 1, true, Kn * 2.0 * inv_eta2);
    add_product(We, Q, 2, true, Kn * 0.5 * e * inv_eta2);
    We.c[0] += Kn * Ce;
    We.r += Kn * c0e;
    // W_a = -(l - 1/2) W / a
    poly_axpy(Wa, -(l - 0.5) * inv_a, W);
  }
  // the corrections, as terms() puts them
  const double D = n * a * a, ti = si / (1.0 + ci), cv = cw * cO - sw * sO, sv = sw * cO + cw * sO;
  Poly de, edw, dT, tdO, dl, da;
  poly_zero(de); poly_zero(edw); poly_zero(dT); poly_zero(tdO); poly_zero(dl); poly_zero(da);
  poly_axpy(de, eta * eta / (D * e), WM);
  poly_axpy(de, -eta * si / (D * e), Wws);
  poly_axpy(edw, eta / D, We);
  poly_axpy(edw, e * ti * ci / (D * eta), Ws);
  poly_axpy(dT, ci / (D * eta * (1.0 + ci)), Wws);
  poly_axpy(tdO, ci / (D * eta * (1.0 + ci)), Ws);
  poly_axpy(dl, -2.0 / (n * a), Wa);
  poly_axpy(dl, eta * e / (D * (1.0 + eta)), We);
  poly_axpy(dl, ti * ci / (D * eta), Ws);
  poly_axpy(da, 2.0 / (n * a), WM);
  for (int j = 0; j < 6; ++j) poly_zero(out.d[j]);
  poly_axpy(out.d[kAf], cv, de);
  poly_axpy(out.d[kAf], -sv, edw);
  poly_axpy(out.d[kAg], sv, de);
  poly_axpy(out.d[kAg], cv, edw);
  poly_axpy(out.d[kChi], sO, dT);
  poly_axpy(out.d[kChi], cO, tdO);
  poly_axpy(out.d[kPsi], cO, dT);
  poly_axpy(out.d[kPsi], -sO, tdO);
  poly_axpy(out.d[kLam], 1.0, dl);
  poly_axpy(out.d[kN], -1.5 * n / a, da);
}

/// The corrections from their coefficients at the state's true anomaly (sin f, cos f) and f - M.
inline void eval(const Coefs& k, double sf, double cf, double f_m, double* d) {
  double cm[kHarm + 1], sm[kHarm + 1];
  cm[0] = 1.0;
  sm[0] = 0.0;
  for (int m = 1; m <= kHarm; ++m) {
    cm[m] = cm[m - 1] * cf - sm[m - 1] * sf;
    sm[m] = sm[m - 1] * cf + cm[m - 1] * sf;
  }
  for (int j = 0; j < 6; ++j) {
    const Poly& p = k.d[j];
    double v = p.c[0] + p.r * f_m;
    for (int m = 1; m <= kHarm; ++m) v += p.c[m] * cm[m] + p.s[m] * sm[m];
    d[j] = v;
  }
}

/// The corrections at mean equinoctial elements y (SPEC 1.5), degrees 3..hi. Below e 1e-9 the elements are read at
/// e = 1e-9 (the terms are continuous there; e = 0 itself leaves the anomaly undefined).
inline void of_equinoctial(const double* y, int hi, double* d, double* rates = nullptr) {
  constexpr double kEMin = 1e-9;
  double af = y[kAf], ag = y[kAg];
  double e = std::sqrt(af * af + ag * ag);
  double cv = 1.0, sv = 0.0;
  if (e > 0.0) { cv = af / e; sv = ag / e; }
  if (e < kEMin) e = kEMin;
  const double eta = std::sqrt((1.0 - e) * (1.0 + e));
  const double t2 = y[kChi] * y[kChi] + y[kPsi] * y[kPsi], tt = std::sqrt(t2);
  double sO = 0.0, cO = 1.0;
  if (tt > 0.0) { sO = y[kChi] / tt; cO = y[kPsi] / tt; }
  const double ci = (1.0 - t2) / (1.0 + t2), si = 2.0 * tt / (1.0 + t2);
  const double cw = cv * cO + sv * sO, sw = sv * cO - cv * sO;  // omega = varpi - Omega
  const double n = y[kN], a = std::cbrt(kMu / (n * n));
  // M = lambda - varpi; Kepler's equation by Newton from E = M + e sin M
  const double varpi = std::atan2(sv, cv);
  const double M = std::remainder(y[kLam] - varpi, 2.0 * 3.14159265358979323846);
  double E = M + e * std::sin(M);
  for (int it = 0; it < 50; ++it) {
    const double dE = (E - e * std::sin(E) - M) / (1.0 - e * std::cos(E));
    E -= dE;
    if (std::fabs(dE) < 1e-15) break;
  }
  const double sE = std::sin(E), cE = std::cos(E), den = 1.0 - e * cE;
  const double cf = (cE - e) / den, sf = eta * sE / den;
  const double f_m = std::remainder(std::atan2(sf, cf) - M, 2.0 * 3.14159265358979323846);
  terms(3, hi, a, n, e, eta, si, ci, sO, cO, sw, cw, sf, cf, f_m, d, rates);
}

}  // namespace zsp
