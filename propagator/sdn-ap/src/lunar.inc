// -----------------------------------------------------------------------------
// SDN-AP 2h.1: Moon-centered orbits (first version). Mean equinoctial elements
// in the lunar principal-axis frame frozen at the epoch (LEI: an inertial frame,
// the DE440 PA axes at the epoch); km and seconds.
// - Lunar gravity: GRGM660PRIM (pinned, build.mjs) in the averaged rates, every
//   term of degree <= gravity_degree() with no mean anomaly in its angle
//   (j = l - 2p + q = 0, |q| <= 2), evaluated in the PA frame of the time (the
//   DE440 pole and spin from the embedded refit; the rates carried back to LEI
//   through the orbit's vectors). F at the epoch inclination (Fourier,
//   tess::normalized_Fk), G at the epoch eccentricity (Hansen), as SPEC 6.
// - SRP: SPEC 4's averaged rates with the Moon's cylindrical shadow; AGOM fitted.
// - Earth and Sun: SPEC 5's averaged quadrupole and octupole (third_body_six),
//   positions from SPEC 5's series, mean of date to J2000 by IAU 2006 precession.
// - Output: the first-order short-periodics of the terms with j != 0 to degree
//   short_degree(), |q| <= 2 (the q = +-1 terms carry the eccentricity vector's
//   O(1) part), as 2d.3b.
// - Integration: RK4 on a fixed grid of step_seconds() from the epoch, partial
//   steps to each requested time.
// Not yet: the Earth's shadow (lunar eclipses), mascon terms beyond the averaged set.
// -----------------------------------------------------------------------------

namespace sdnap {
namespace lunar {

#include "lunar_data.h"

using xpt::Kepler;
using xpt::AngleTrig;

constexpr double kMu = kLunarGmKm3s2;     // km^3/s^2
constexpr double kR = kLunarRadiusKm;     // km
constexpr double kMuEarthOverMoon = 398600.4418 / kLunarGmKm3s2;
constexpr double kMuSunOverMoon = 1.32712440018e11 / kLunarGmKm3s2;
constexpr double kEarthRadiusKm = 6378.135;  // SPEC 5's series are in these units

inline int& gravity_degree() {
  static int d = 70;  // measured (LRO, Danuri, 8 windows each, day 3): degree 30 3.72 / 6.29 km, 50 1.95 / 5.88, 70 1.83 / 4.03
  return d;
}
inline int& short_degree() {
  static int d = 8;   // measured (LRO): fit RMS 0.39 km with none, 0.15 at degree 4, 0.12 at 8
  return d;
}
inline int& eccentricity_order() {  // |q| of the averaged set (G_lpq ~ (l e)^|q|: Danuri at e 0.04 needs more)
  static int q = 2;
  return q;
}
inline double& step_seconds() {
  static double h = 240.0;
  return h;
}

inline double lc(int l, int m) { return kLunarC[l * (l + 1) / 2 + m]; }
inline double ls(int l, int m) { return kLunarS[l * (l + 1) / 2 + m]; }

/// TDB seconds from J2000 at the UTC split Julian date (TT; TDB - TT < 2 ms).
inline double et_of(double whole, double frac) {
  double tai1, tai2, tt1, tt2;
  if (eraUtctai(whole, frac, &tai1, &tai2) < 0) return __builtin_nan("");
  eraTaitt(tai1, tai2, &tt1, &tt2);
  return ((tt1 - 2451545.0) + tt2) * 86400.0;
}

/// Three Chebyshev components at et from an embedded refit (records of record_s seconds from start, 3 x (degree + 1)
/// coefficients each); false outside its span.
inline bool cheb3(const double* coef, double start, double record_s, int records, int degree, double et, double* out) {
  const double u = (et - start) / record_s;
  if (!(u >= 0.0) || u >= records) return false;
  const int r = static_cast<int>(u);
  const double x = (et - (start + (r + 0.5) * record_s)) / (0.5 * record_s);
  for (int c = 0; c < 3; ++c) {
    const double* k = coef + (r * 3 + c) * (degree + 1);
    double t0 = 1.0, t1 = x, sum = k[0] + k[1] * x;
    for (int j = 2; j <= degree; ++j) {
      const double t2 = 2.0 * x * t1 - t0;
      sum += k[j] * t2;
      t0 = t1;
      t1 = t2;
    }
    out[c] = sum;
  }
  return true;
}

/// DE440 PA Euler angles (phi, theta, psi; 3-1-3 from J2000) at et from the embedded refit; false outside its span.
inline bool pa_angles(double et, double* ang) {
  return cheb3(kLunarPa, kLunarPaStartEt, kLunarPaRecordSeconds, kLunarPaRecords, kLunarPaDegree, et, ang);
}

/// DE440 geocentric Moon and Sun (km, J2000 = ICRF axes) at et from the embedded refits; false outside the span.
inline bool de_moon(double et, double* r) { return cheb3(kDeMoon, kDeStartEt, kDeMoonRecordSeconds, kDeMoonRecords, kDeMoonDegree, et, r); }
inline bool de_sun(double et, double* r) { return cheb3(kDeSun, kDeStartEt, kDeSunRecordSeconds, kDeSunRecords, kDeSunDegree, et, r); }

/// The J2000 -> PA rotation R3(psi) R1(theta) R3(phi).
inline bool j2000_to_pa(double et, double M[3][3]) {
  double a[3];
  if (!pa_angles(et, a)) return false;
  const double cf = std::cos(a[0]), sf = std::sin(a[0]), ct = std::cos(a[1]), st = std::sin(a[1]);
  const double cp = std::cos(a[2]), sp = std::sin(a[2]);
  // R1(theta) R3(phi)
  const double B[3][3] = {{cf, sf, 0.0}, {-ct * sf, ct * cf, st}, {st * sf, -st * cf, ct}};
  for (int j = 0; j < 3; ++j) {
    M[0][j] = cp * B[0][j] + sp * B[1][j];
    M[1][j] = -sp * B[0][j] + cp * B[1][j];
    M[2][j] = B[2][j];
  }
  return true;
}

inline void mul(const double M[3][3], const double* v, double* o) {
  for (int i = 0; i < 3; ++i) o[i] = M[i][0] * v[0] + M[i][1] * v[1] + M[i][2] * v[2];
}
inline void mul_t(const double M[3][3], const double* v, double* o) {
  for (int i = 0; i < 3; ++i) o[i] = M[0][i] * v[0] + M[1][i] * v[1] + M[2][i] * v[2];
}

/// One term of a lunar set: Kaula indices and the epoch products (float).
struct Term {
  int8_t l, m, p, q;
  float fg, fdg, dfg;
};

struct Sat {
  double epoch_whole = 0, epoch_frac = 0, et0 = 0;
  double M[3][3] = {};      // J2000 -> LEI (the PA axes at the epoch)
  double y0[6] = {};        // mean equinoctial at the epoch: n (rad/s), af, ag, chi, psi, lambda
  std::vector<Term> avg;    // averaged gravity terms
  std::vector<Term> sp;     // short-periodic terms (output time)
  double agom = 0.0;        // C_R A / m, m^2/kg (SRP; fitted)
  int ok = 0;
};

inline double a_of(double n) { return std::cbrt(kMu / (n * n)); }

/// theta_M: the PA x axis at et in LEI (angle from the LEI x axis about its z axis).
inline double theta_of(const Sat& s, double et) {
  double P[3][3];
  if (!j2000_to_pa(et, P)) return __builtin_nan("");
  const double x[3] = {P[0][0], P[0][1], P[0][2]};  // the PA x axis in J2000
  double v[3];
  mul(s.M, x, v);
  return std::atan2(v[1], v[0]);
}

/// The averaged and short-periodic term sets at the epoch elements.
inline void build_terms(Sat& s) {
  const Kepler k = xpt::kepler_of(s.y0, a_of(s.y0[xpt::kN]));
  const double i0 = k.i, e0 = k.e;
  const int L = gravity_degree() > kLunarDegree ? kLunarDegree : gravity_degree();
  double f[104], fp[104], fm[104];
  const double h = 1e-5;
  s.avg.clear();
  const int Q = eccentricity_order();
  for (int m = 0; m <= L && L <= kLunarDegree; ++m)
    for (int w = -Q; w <= Q; ++w) {
      int l0 = m > (w < 0 ? -w : w) ? m : (w < 0 ? -w : w);
      if (l0 < 2) l0 = 2;
      if (((l0 - w) & 1) != 0) ++l0;
      if (l0 > L) continue;
      xpt::tess::normalized_Fk(m, w, L, i0, f);
      xpt::tess::normalized_Fk(m, w, L, i0 + h, fp);
      xpt::tess::normalized_Fk(m, w, L, i0 - h, fm);
      for (int l = l0; l <= L; l += 2) {
        const int p = (l - w) / 2, q = -w;
        double G, dG;
        xpt::res::exact_G(l, p, q, e0 < 1e-6 ? 1e-6 : e0, G, dG);
        s.avg.push_back(Term{static_cast<int8_t>(l), static_cast<int8_t>(m), static_cast<int8_t>(p), static_cast<int8_t>(q),
                             static_cast<float>(f[l] * G), static_cast<float>(f[l] * dG),
                             static_cast<float>((fp[l] - fm[l]) / (2.0 * h) * G)});
      }
    }
  s.sp.clear();
  const int Ls = short_degree();
  for (int l = 2; l <= Ls; ++l)
    for (int m = 0; m <= l; ++m)
      for (int p = 0; p <= l; ++p)
        for (int q = -2; q <= 2; ++q) {
          const int w = l - 2 * p, j = w + q;
          if (j == 0) continue;           // in the averaged rates
          // q = +-1 carry the O(1) eccentricity-vector part (Lagrange's 1/e) with the 2/rev q = 0 part: one set
          xpt::tess::normalized_Fk(m, w, l, i0, f);
          xpt::tess::normalized_Fk(m, w, l, i0 + h, fp);
          xpt::tess::normalized_Fk(m, w, l, i0 - h, fm);
          double G, dG;
          xpt::res::exact_G(l, p, q, e0 < 1e-6 ? 1e-6 : e0, G, dG);
          s.sp.push_back(Term{static_cast<int8_t>(l), static_cast<int8_t>(m), static_cast<int8_t>(p), static_cast<int8_t>(q),
                              static_cast<float>(f[l] * G), static_cast<float>(f[l] * dG),
                              static_cast<float>((fp[l] - fm[l]) / (2.0 * h) * G)});
        }
}

/// Lagrange's six (n-dot, e-dot, i-dot, e varpi-dot, sin i Omega-dot, lambda-dot - n) of a term list, or with
/// integrate the first-order displacement (S and dS replaced by their time integrals over psi-dot).
inline void terms_six(const std::vector<Term>& ts, const Kepler& kp, double n, double theta, double theta_dot,
                      bool integrate, double* six) {
  const double a = kp.a, e = kp.e < 1e-12 ? 1e-12 : kp.e;
  const double eta = std::sqrt(1.0 - e * e);
  double si, ci;
  fm::sincos(kp.i, si, ci);
  const double sin_i = std::fabs(si) < 1e-12 ? (si < 0.0 ? -1e-12 : 1e-12) : si;
  const double ia = 1.0 / a;
  double amp[104];
  amp[0] = kMu * ia;
  const double rr = kR * ia;
  for (int l = 1; l <= kLunarDegree; ++l) amp[l] = amp[l - 1] * rr;  // mu / a (R/a)^l
  // secular J2 rates for the short-periodic frequencies
  const double p_sl = a * eta * eta, j2 = -1.5 * lc(2, 0) * std::sqrt(5.0) * (kR / p_sl) * (kR / p_sl);
  const double node_rate = -j2 * n * ci, wdot = 0.5 * j2 * n * (5.0 * ci * ci - 1.0);
  const double mdot = n + 0.5 * j2 * n * eta * (3.0 * ci * ci - 1.0);
  double sM = 0, sW = 0, sO = 0, sE = 0, sI = 0, sA = 0, sL = 0;
  // the angle's multiples by recurrence (one sine and cosine each of omega, M and Omega - theta per call)
  constexpr int kW = 16, kB = kLunarDegree + 1;
  double cw[kW + 1], sw[kW + 1], cj[kW + 1], sj[kW + 1], cb[kB + 1], sb[kB + 1];
  {
    double s1, c1;
    fm::sincos(kp.argp, s1, c1);
    cw[0] = 1.0; sw[0] = 0.0;
    for (int q = 1; q <= kW; ++q) { cw[q] = cw[q - 1] * c1 - sw[q - 1] * s1; sw[q] = sw[q - 1] * c1 + cw[q - 1] * s1; }
    fm::sincos(kp.m, s1, c1);
    cj[0] = 1.0; sj[0] = 0.0;
    for (int q = 1; q <= kW; ++q) { cj[q] = cj[q - 1] * c1 - sj[q - 1] * s1; sj[q] = sj[q - 1] * c1 + cj[q - 1] * s1; }
    fm::sincos(kp.node - theta, s1, c1);
    cb[0] = 1.0; sb[0] = 0.0;
    for (int q = 1; q <= kB; ++q) { cb[q] = cb[q - 1] * c1 - sb[q - 1] * s1; sb[q] = sb[q - 1] * c1 + cb[q - 1] * s1; }
  }
  for (const Term& c : ts) {
    const int w = c.l - 2 * c.p, j = w + c.q;
    double sp, cp;
    if (w >= -kW && w <= kW && j >= -kW && j <= kW) {
      const int aw = w < 0 ? -w : w, aj = j < 0 ? -j : j;
      const double c_w = cw[aw], s_w = w < 0 ? -sw[aw] : sw[aw], c_j = cj[aj], s_j = j < 0 ? -sj[aj] : sj[aj];
      const double c12 = c_w * c_j - s_w * s_j, s12 = s_w * c_j + c_w * s_j;
      cp = c12 * cb[c.m] - s12 * sb[c.m];
      sp = s12 * cb[c.m] + c12 * sb[c.m];
    } else {
      fm::sincos(w * kp.argp + j * kp.m + c.m * (kp.node - theta), sp, cp);
    }
    const double C = lc(c.l, c.m), S0 = ls(c.l, c.m);
    const bool odd = ((c.l - c.m) & 1) != 0;
    double Sv = odd ? -S0 * cp + C * sp : C * cp + S0 * sp;
    double dS = odd ? S0 * sp + C * cp : -C * sp + S0 * cp;
    const double A = amp[c.l];
    if (integrate) {
      const double psidot = w * wdot + j * mdot + c.m * (node_rate - theta_dot);
      sL += j * A * c.fg * dS / (psidot * psidot);
      const double iS = -dS / psidot, idS = Sv / psidot;
      Sv = iS;
      dS = idS;
    }
    const double fgdS = A * c.fg * dS;
    sM += j * fgdS;
    sW += w * fgdS;
    sO += c.m * fgdS;
    sE += A * c.fdg * Sv;
    sI += A * c.dfg * Sv;
    sA += -(c.l + 1) * A * c.fg * Sv * ia;
  }
  const double na2 = n * a * a;
  const double tanhalf = sin_i / (1.0 + ci);
  six[0] += -3.0 * ia * ia * sM;
  six[1] += (eta * eta * sM - eta * sW) / (na2 * e);
  six[2] += (ci * sW - sO) / (na2 * eta * sin_i);
  six[3] += (eta / na2) * sE + e * tanhalf / (na2 * eta) * sI;
  six[4] += sI / (na2 * eta);
  six[5] += -(2.0 / (n * a)) * sA + (eta * e / (na2 * (1.0 + eta))) * sE + (tanhalf / (na2 * eta)) * sI +
            (integrate ? 3.0 * ia * ia * sL : 0.0);
}

/// The orbit's perifocal vectors of (i, node, argp) and back.
inline void orbit_vectors(double i, double node, double argp, double* P, double* Q, double* W) {
  const double co = std::cos(node), so = std::sin(node), cw = std::cos(argp), sw = std::sin(argp), ci = std::cos(i), si = std::sin(i);
  P[0] = cw * co - sw * so * ci; P[1] = cw * so + sw * co * ci; P[2] = sw * si;
  Q[0] = -sw * co - cw * so * ci; Q[1] = -sw * so + cw * co * ci; Q[2] = cw * si;
  W[0] = so * si; W[1] = -co * si; W[2] = ci;
}
inline void angles_of(const double* P, const double* Q, const double* W, double& i, double& node, double& argp) {
  i = std::acos(std::fmax(-1.0, std::fmin(1.0, W[2])));
  node = xpt::wrap(std::atan2(W[0], -W[1]));
  argp = xpt::wrap(std::atan2(P[2], Q[2]));
}

/// Earth and Sun from the Moon at et, unit vectors in LEI and distances (km).
inline void third_bodies(const Sat& s, double et, double ue[3], double& re, double us[3], double& rs) {
  const double d50 = (et - 69.184) / 86400.0 + (2451545.0 - 2433282.5);  // days from 1950 January 0.0 (UTC ~ TT - 69 s)
  const xpt::Bodies b = xpt::bodies_at(d50);
  // mean equator and equinox of date -> J2000 (IAU 2006 bias-precession, transposed)
  double gamb, phib, psib, epsa, P[3][3];
  const double tt = 2451545.0 + et / 86400.0;
  eraPfw06(tt, 0.0, &gamb, &phib, &psib, &epsa);
  eraFw2m(gamb, phib, psib, epsa, P);  // GCRS -> mean of date (with bias)
  const double moon_mod[3] = {b.moon_u.x * b.moon_r, b.moon_u.y * b.moon_r, b.moon_u.z * b.moon_r};
  const double sun_mod[3] = {b.sun_u.x * b.sun_r, b.sun_u.y * b.sun_r, b.sun_u.z * b.sun_r};
  double moon_j2k[3], sun_j2k[3];
  mul_t(P, moon_mod, moon_j2k);
  mul_t(P, sun_mod, sun_j2k);
  double e_j2k[3] = {-moon_j2k[0], -moon_j2k[1], -moon_j2k[2]};
  double s_j2k[3] = {sun_j2k[0] - moon_j2k[0], sun_j2k[1] - moon_j2k[1], sun_j2k[2] - moon_j2k[2]};
  mul(s.M, e_j2k, ue);
  mul(s.M, s_j2k, us);
  re = std::sqrt(ue[0] * ue[0] + ue[1] * ue[1] + ue[2] * ue[2]);
  rs = std::sqrt(us[0] * us[0] + us[1] * us[1] + us[2] * us[2]);
  for (int c = 0; c < 3; ++c) { ue[c] /= re; us[c] /= rs; }
  re *= kEarthRadiusKm;
  rs *= kEarthRadiusKm;
}

/// d y / d t (per second) at t seconds from the epoch.
inline bool rates(const Sat& s, double t, const double* y, double* out) {
  const double n = y[xpt::kN];
  if (!(n > 0.0)) return false;
  const double a = a_of(n);
  const Kepler k = xpt::kepler_of(y, a);
  if (!(k.e < 0.9)) return false;
  const AngleTrig g = xpt::angle_trig(k);
  const double et = s.et0 + t;
  // the gravity in the PA frame of the time (its pole and spin from the DE440 refit), the rates carried back to
  // LEI through the orbit's vectors (a 60 s finite step of the PA-frame elements)
  double P0[3][3];
  if (!j2000_to_pa(et, P0)) return false;
  double R[3][3];  // LEI -> PA(t) = M_PA(t) M_LEI^T
  for (int r = 0; r < 3; ++r)
    for (int c = 0; c < 3; ++c) R[r][c] = P0[r][0] * s.M[c][0] + P0[r][1] * s.M[c][1] + P0[r][2] * s.M[c][2];
  double Pv[3], Qv[3], Wv[3], Pp[3], Qp[3], Wp[3];
  orbit_vectors(k.i, k.node, k.argp, Pv, Qv, Wv);
  mul(R, Pv, Pp);
  mul(R, Qv, Qp);
  mul(R, Wv, Wp);
  Kepler kp = k;
  angles_of(Pp, Qp, Wp, kp.i, kp.node, kp.argp);
  double six_pa[6] = {0, 0, 0, 0, 0, 0};
  terms_six(s.avg, kp, n, 0.0, 0.0, false, six_pa);
  double yp[6], dyp[6], yp1[6];
  xpt::equinoctial_of(n, kp.e, kp.i, kp.node, kp.argp, kp.m, yp);
  xpt::six_to_equinoctial(xpt::angle_trig(kp), six_pa, dyp);
  const double dt = 60.0;
  for (int j = 0; j < 6; ++j) yp1[j] = yp[j] + dt * dyp[j];
  double grav[6];
  {
    const Kepler k1 = xpt::kepler_of(yp1, a_of(yp1[xpt::kN]));
    double P1[3], Q1[3], W1[3], Pl[3], Ql[3], Wl[3], y1[6];
    orbit_vectors(k1.i, k1.node, k1.argp, P1, Q1, W1);
    mul_t(R, P1, Pl);
    mul_t(R, Q1, Ql);
    mul_t(R, W1, Wl);
    double il, nl, wl;
    angles_of(Pl, Ql, Wl, il, nl, wl);
    xpt::equinoctial_of(yp1[xpt::kN], k1.e, il, nl, wl, k1.m, y1);
    double y0l[6];
    xpt::equinoctial_of(n, k.e, k.i, k.node, k.argp, k.m, y0l);
    for (int j = 0; j < 6; ++j) {
      double d = y1[j] - y0l[j];
      if (j == xpt::kLam) d -= kTwoPi * std::round(d / kTwoPi);
      grav[j] = d / dt;
    }
  }
  double six[6] = {0, 0, 0, 0, 0, 0};
  // third bodies (SPEC 5 averaged)
  double ue[3], us[3], re, rsun;
  third_bodies(s, et, ue, re, us, rsun);
  const double eta = std::sqrt(1.0 - k.e * k.e);
  double coef[96];
  xpt::third_body_six_coefs(k.e, n, eta, k.i, k.argp, coef);
  const xpt::Perifocal pf = xpt::perifocal_of(g);
  const double ms[2] = {kMuEarthOverMoon, kMuSunOverMoon}, rb[2] = {re, rsun};
  const xpt::Vec3 ub[2] = {{ue[0], ue[1], ue[2]}, {us[0], us[1], us[2]}};
  for (int j = 0; j < 2; ++j) {
    double A, B, C;
    xpt::direction_cosines(pf, ub[j], A, B, C);
    const double ar = a / rb[j];
    const double C2 = ms[j] * ar * ar * ar * n;
    xpt::third_body_six(coef, A, B, C, C2, C2 * ar, six);
  }
  xpt::six_to_equinoctial(g, six, out);
  for (int j = 0; j < 6; ++j) out[j] += grav[j];  // the lunar gravity's rates, carried back to LEI
  out[xpt::kLam] += n;
  // SRP (SPEC 4's averaged rates, the Moon's cylindrical shadow; the Earth's shadow, a lunar eclipse, is left out)
  if (s.agom != 0.0) {
    double A, B, C;
    xpt::direction_cosines(pf, ub[1], A, B, C);
    const double rs_au = rsun / xpt::kAu;
    const double Fs = xpt::kSrpPressure * s.agom / (1000.0 * rs_au * rs_au);  // km/s^2
    const double p = a * (1.0 - k.e * k.e) / kR;                               // in lunar radii
    double E1, E2, d[6];
    if (xpt::sunlit_arc(A, B, k.e, p, E1, E2)) xpt::srp_rates_arc(k.e, eta, k.argp, k.node, k.i, a, n, E1, E2, A, B, C, Fs, d);
    else xpt::srp_rates_sunlit(k.e, eta, k.argp, k.node, k.i, a, n, A, B, C, Fs, d);
    for (int j = 0; j < 6; ++j) out[j] += d[j];
  }
  for (int j = 0; j < 6; ++j)
    if (!std::isfinite(out[j])) return false;
  return true;
}

/// One RK4 step of h from (tc, y) into out.
inline bool rk4(const Sat& s, double tc, const double* y, double h, double* out) {
  double k1[6], k2[6], k3[6], k4[6], z[6];
  if (!rates(s, tc, y, k1)) return false;
  for (int j = 0; j < 6; ++j) z[j] = y[j] + 0.5 * h * k1[j];
  if (!rates(s, tc + 0.5 * h, z, k2)) return false;
  for (int j = 0; j < 6; ++j) z[j] = y[j] + 0.5 * h * k2[j];
  if (!rates(s, tc + 0.5 * h, z, k3)) return false;
  for (int j = 0; j < 6; ++j) z[j] = y[j] + h * k3[j];
  if (!rates(s, tc + h, z, k4)) return false;
  for (int j = 0; j < 6; ++j) out[j] = y[j] + h * (k1[j] + 2.0 * k2[j] + 2.0 * k3[j] + k4[j]) / 6.0;
  return true;
}

/// Mean elements at t (seconds from the epoch) by RK4 steps of step_seconds() on the epoch's grid, the last partial.
inline bool mean_at(const Sat& s, double t, double* y) {
  for (int j = 0; j < 6; ++j) y[j] = s.y0[j];
  const double h0 = step_seconds() * (t < 0 ? -1.0 : 1.0);
  double tc = 0.0;
  while (std::fabs(t - tc) > 1e-9) {
    const double h = std::fabs(t - tc) < std::fabs(h0) ? t - tc : h0;
    if (!rk4(s, tc, y, h, y)) return false;
    tc += h;
  }
  return true;
}

/// Kepler: osculating equinoctial (km, s) to position and velocity in LEI.
inline bool state_of(const double* y, double* r, double* v) {
  const double n = y[xpt::kN], a = a_of(n);
  const Kepler k = xpt::kepler_of(y, a);
  if (!(k.e < 1.0)) return false;
  double E = k.m + k.e * std::sin(k.m);
  for (int it = 0; it < 30; ++it) {
    const double d = (E - k.e * std::sin(E) - k.m) / (1.0 - k.e * std::cos(E));
    E -= d;
    if (std::fabs(d) < 1e-15) break;
  }
  const double cE = std::cos(E), sE = std::sin(E), eta = std::sqrt(1.0 - k.e * k.e);
  const double xp = a * (cE - k.e), yp = a * eta * sE;
  const double rr = a * (1.0 - k.e * cE);
  const double vxp = -a * n * sE * a / rr, vyp = a * n * eta * cE * a / rr;
  const AngleTrig g = xpt::angle_trig(k);
  const xpt::Perifocal pf = xpt::perifocal_of(g);
  r[0] = xp * pf.P.x + yp * pf.Q.x; r[1] = xp * pf.P.y + yp * pf.Q.y; r[2] = xp * pf.P.z + yp * pf.Q.z;
  v[0] = vxp * pf.P.x + vyp * pf.Q.x; v[1] = vxp * pf.P.y + vyp * pf.Q.y; v[2] = vxp * pf.P.z + vyp * pf.Q.z;
  return true;
}

/// Moon-centered J2000 position and velocity (km, km/s) from the mean elements y at t seconds from the epoch.
inline bool osculating(const Sat& s, double t, double* y, double* r, double* v) {
  if (!s.sp.empty()) {
    const double n = y[xpt::kN];
    const Kepler k = xpt::kepler_of(y, a_of(n));
    const double et = s.et0 + t;
    const double theta = theta_of(s, et), theta2 = theta_of(s, et + 60.0);
    double dth = theta2 - theta;
    dth -= kTwoPi * std::round(dth / kTwoPi);
    double six[6] = {0, 0, 0, 0, 0, 0};
    terms_six(s.sp, k, n, theta, dth / 60.0, true, six);
    double d[6];
    xpt::six_to_equinoctial(xpt::angle_trig(k), six, d);
    for (int j = 0; j < 6; ++j) y[j] += d[j];
  }
  double rl[3], vl[3];
  if (!state_of(y, rl, vl)) return false;
  mul_t(s.M, rl, r);
  mul_t(s.M, vl, v);
  return true;
}

inline bool position_at(const Sat& s, double t, double* r, double* v) {
  double y[6];
  return mean_at(s, t, y) && osculating(s, t, y, r, v);
}

/// Mean elements at ascending times t >= 0 on the step_seconds() grid: RK4 between nodes, cubic Hermite between
/// a node pair (the rates at both nodes); calls back with (index, mean elements).
template <class Fn>
inline bool dense_means(const Sat& s, const double* t, int count, Fn&& fn) {
  const double h = step_seconds();
  double y0[6], f0[6], y1[6], f1[6], z[6];
  for (int j = 0; j < 6; ++j) y0[j] = s.y0[j];
  double t0 = 0.0;
  if (!rates(s, t0, y0, f0)) return false;
  if (!rk4(s, t0, y0, h, y1) || !rates(s, t0 + h, y1, f1)) return false;
  for (int k = 0; k < count; ++k) {
    if (t[k] < 0.0) {
      if (!mean_at(s, t[k], z)) return false;
      if (!fn(k, z)) return false;
      continue;
    }
    while (t[k] > t0 + h) {
      for (int j = 0; j < 6; ++j) { y0[j] = y1[j]; f0[j] = f1[j]; }
      t0 += h;
      if (!rk4(s, t0, y0, h, y1) || !rates(s, t0 + h, y1, f1)) return false;
    }
    const double u = (t[k] - t0) / h, u2 = u * u, u3 = u2 * u;
    const double h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    for (int j = 0; j < 6; ++j) z[j] = h00 * y0[j] + h10 * h * f0[j] + h01 * y1[j] + h11 * h * f1[j];
    if (!fn(k, z)) return false;
  }
  return true;
}

/// States (6 doubles each: km, km/s, J2000) at ascending times (dense_means).
inline bool states(const Sat& s, const double* t, int count, double* out) {
  return dense_means(s, t, count, [&](int k, double* z) {
    double r[3], v[3];
    if (!osculating(s, t[k], z, r, v)) return false;
    for (int c = 0; c < 3; ++c) { out[6 * k + c] = r[c]; out[6 * k + 3 + c] = v[c]; }
    return true;
  });
}

/// Positions (3 doubles each) at ascending times.
inline bool positions(const Sat& s, const double* t, int count, double* out) {
  return dense_means(s, t, count, [&](int k, double* z) {
    double r[3], v[3];
    if (!osculating(s, t[k], z, r, v)) return false;
    out[3 * k] = r[0]; out[3 * k + 1] = r[1]; out[3 * k + 2] = r[2];
    return true;
  });
}

/// Equinoctial elements (LEI) of a J2000 state (two-body, the Moon's mu).
inline bool elements_of_state(const Sat& s, const double* r_j2k, const double* v_j2k, double* y) {
  double r[3], v[3];
  mul(s.M, r_j2k, r);
  mul(s.M, v_j2k, v);
  const double rn = std::sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
  const double v2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  const double a = 1.0 / (2.0 / rn - v2 / kMu);
  if (!(a > 0.0)) return false;
  const double hx = r[1] * v[2] - r[2] * v[1], hy = r[2] * v[0] - r[0] * v[2], hz = r[0] * v[1] - r[1] * v[0];
  const double hn = std::sqrt(hx * hx + hy * hy + hz * hz);
  const double inc = std::acos(hz / hn), node = std::atan2(hx, -hy);
  const double rv = r[0] * v[0] + r[1] * v[1] + r[2] * v[2];
  double ev[3];
  for (int c = 0; c < 3; ++c) ev[c] = ((v2 - kMu / rn) * r[c] - rv * v[c]) / kMu;
  const double e = std::sqrt(ev[0] * ev[0] + ev[1] * ev[1] + ev[2] * ev[2]);
  // argument of pericenter and true anomaly in the orbit plane
  const double nx = std::cos(node), ny = std::sin(node);
  const double cw_ = (nx * ev[0] + ny * ev[1]) / (e > 0 ? e : 1), sw_ = (ev[2] / (e > 0 ? e : 1)) / std::sin(inc);
  const double argp = std::atan2(sw_, cw_);
  const double cu = (nx * r[0] + ny * r[1]) / rn, su = (r[2] / rn) / std::sin(inc);
  const double u = std::atan2(su, cu), f = u - argp;
  const double E = 2.0 * std::atan(std::sqrt((1.0 - e) / (1.0 + e)) * std::tan(0.5 * f));
  const double M = E - e * std::sin(E);
  xpt::equinoctial_of(std::sqrt(kMu / (a * a * a)), e, inc, node, argp, M, y);
  return true;
}

/// The epoch set as J2000-referred Keplerian mean elements (rad; n in rad/s), for the $OMM.
inline void j2000_elements(const Sat& s, double& n, double& e, double& i, double& node, double& argp, double& M) {
  const Kepler k = xpt::kepler_of(s.y0, a_of(s.y0[xpt::kN]));
  double P[3], Q[3], W[3], Pj[3], Qj[3], Wj[3];
  orbit_vectors(k.i, k.node, k.argp, P, Q, W);
  mul_t(s.M, P, Pj);
  mul_t(s.M, Q, Qj);
  mul_t(s.M, W, Wj);
  angles_of(Pj, Qj, Wj, i, node, argp);
  n = s.y0[xpt::kN];
  e = k.e;
  M = k.m;
}

inline bool init(Sat& s, double whole, double frac, const double* y0);

/// A set from J2000-referred Keplerian mean elements at the UTC split Julian date.
inline bool init_j2000(Sat& s, double whole, double frac, double n, double e, double i, double node, double argp, double M) {
  Sat probe;
  probe.et0 = et_of(whole, frac);
  if (!std::isfinite(probe.et0) || !j2000_to_pa(probe.et0, probe.M)) return false;
  double P[3], Q[3], W[3], Pl[3], Ql[3], Wl[3], il, nl, wl, y[6];
  orbit_vectors(i, node, argp, P, Q, W);
  mul(probe.M, P, Pl);
  mul(probe.M, Q, Ql);
  mul(probe.M, W, Wl);
  angles_of(Pl, Ql, Wl, il, nl, wl);
  xpt::equinoctial_of(n, e, il, nl, wl, M, y);
  return init(s, whole, frac, y);
}

inline bool init(Sat& s, double whole, double frac, const double* y0) {
  s.epoch_whole = whole;
  s.epoch_frac = frac;
  s.et0 = et_of(whole, frac);
  if (!std::isfinite(s.et0) || !j2000_to_pa(s.et0, s.M)) return false;
  for (int j = 0; j < 6; ++j) s.y0[j] = y0[j];
  build_terms(s);
  s.ok = 1;
  return true;
}

/// Levenberg-Marquardt on the six mean elements against J2000 positions (km) at t (s from the epoch); numerical
/// Jacobian. Returns the RMS (km) or a negative number.
inline double fit(Sat& s, const double* t, const double* pos, int count, int iterations) {
  std::vector<double> res(3 * count), trial(3 * count), J(3 * count * 6);
  std::vector<double> p3(3 * count);
  auto residuals = [&](const Sat& q, std::vector<double>& out) {
    if (!positions(q, t, count, p3.data())) return false;
    for (int k = 0; k < 3 * count; ++k) out[k] = p3[k] - pos[k];
    return true;
  };
  auto cost = [&](const std::vector<double>& v) { double c = 0; for (double x : v) c += x * x; return c; };
  if (!residuals(s, res)) return -1.0;
  double c0 = cost(res), lambda = 1e-3;
  constexpr int NP = 7;
  const double step[NP] = {1e-10, 1e-7, 1e-7, 1e-7, 1e-7, 1e-7, 1e-3};
  J.assign(3 * count * NP, 0.0);
  for (int it = 0; it < iterations; ++it) {
    for (int p = 0; p < NP; ++p) {
      Sat q = s;
      if (p < 6) q.y0[p] += step[p];
      else q.agom += step[p];
      if (!residuals(q, trial)) return -1.0;
      for (int k = 0; k < 3 * count; ++k) J[k * NP + p] = (trial[k] - res[k]) / step[p];
    }
    double N[NP * NP] = {}, g[NP] = {};
    for (int k = 0; k < 3 * count; ++k)
      for (int i = 0; i < NP; ++i) {
        g[i] += J[k * NP + i] * res[k];
        for (int j = 0; j < NP; ++j) N[i * NP + j] += J[k * NP + i] * J[k * NP + j];
      }
    // a weak prior on AGOM (0 +- 0.1 m^2/kg) for conditioning
    N[(NP - 1) * NP + NP - 1] += 1.0 / (0.1 * 0.1);
    g[NP - 1] += s.agom / (0.1 * 0.1);
    bool improved = false;
    for (int tries = 0; tries < 8 && !improved; ++tries) {
      double A[NP * NP], b[NP];
      for (int i = 0; i < NP * NP; ++i) A[i] = N[i];
      for (int i = 0; i < NP; ++i) { A[i * NP + i] *= 1.0 + lambda; b[i] = -g[i]; }
      // Gaussian elimination
      for (int c = 0; c < NP; ++c) {
        int pv = c;
        for (int r = c + 1; r < NP; ++r) if (std::fabs(A[r * NP + c]) > std::fabs(A[pv * NP + c])) pv = r;
        for (int j = 0; j < NP; ++j) std::swap(A[c * NP + j], A[pv * NP + j]);
        std::swap(b[c], b[pv]);
        if (A[c * NP + c] == 0.0) break;
        for (int r = c + 1; r < NP; ++r) {
          const double f = A[r * NP + c] / A[c * NP + c];
          for (int j = c; j < NP; ++j) A[r * NP + j] -= f * A[c * NP + j];
          b[r] -= f * b[c];
        }
      }
      double dx[NP];
      for (int c = NP - 1; c >= 0; --c) {
        double sum = b[c];
        for (int j = c + 1; j < NP; ++j) sum -= A[c * NP + j] * dx[j];
        dx[c] = sum / A[c * NP + c];
      }
      Sat q = s;
      for (int p = 0; p < 6; ++p) q.y0[p] += dx[p];
      q.agom += dx[NP - 1];
      build_terms(q);
      if (residuals(q, trial) && cost(trial) < c0) {
        s = q;
        res = trial;
        const double c1 = cost(trial);
        const bool converged = (c0 - c1) < 1e-10 * c0;
        c0 = c1;
        lambda *= 0.3;
        improved = true;
        if (converged) it = iterations;
      } else {
        lambda *= 10.0;
      }
    }
    if (!improved) break;
  }
  return std::sqrt(c0 / count);
}

}  // namespace lunar
}  // namespace sdnap

/// Diagnostic and first interface of the Moon-centered theory (2h.1): fit the mean elements to `nfit` J2000
/// Moon-centered positions (km) at `t_fit` seconds from the epoch (UTC split Julian date), then write the fitted
/// set's positions at `t_out` seconds into `out` (3 doubles each). `degrees` = gravity degree + 256 x short
/// degree (0 keeps them). Returns the fit RMS (km), negative on refusal.
SDNAP_EXPORT("sdnap_lunar_fit_predict")
double sdnap_lunar_fit_predict(double whole, double frac, const double* t_fit, const double* pos_fit, const double* vel0,
                               int32_t nfit, const double* t_out, int32_t nout, double* out, int32_t degrees) {
  using namespace sdnap::lunar;
  if (degrees > 0) {
    gravity_degree() = degrees & 0xff;
    short_degree() = (degrees >> 8) & 0xff;
    if ((degrees >> 16) & 0xff) eccentricity_order() = (degrees >> 16) & 0xff;
  }
  Sat s;
  double y0[6];
  // starting set: the first state, read as mean
  {
    Sat probe;
    probe.et0 = et_of(whole, frac);
    if (!std::isfinite(probe.et0) || !j2000_to_pa(probe.et0, probe.M)) return -2.0;
    if (!elements_of_state(probe, pos_fit, vel0, y0)) return -3.0;
  }
  if (!init(s, whole, frac, y0)) return -2.0;
  const double rms = fit(s, t_fit, pos_fit, nfit, 25);
  if (rms < 0) return rms;
  if (!positions(s, t_out, nout, out)) return -4.0;
  return rms;
}

/// Diagnostic: the DE440 PA Euler angles (radians) at the UTC split Julian date; false outside the embedded span.
SDNAP_EXPORT("sdnap_lunar_pa_angles")
int32_t sdnap_lunar_pa_angles(double whole, double frac, double* out) {
  return sdnap::lunar::pa_angles(sdnap::lunar::et_of(whole, frac), out) ? 1 : 0;
}
