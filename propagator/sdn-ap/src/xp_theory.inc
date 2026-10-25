// -----------------------------------------------------------------------------
// SGP4XP: the semi-analytic theory of SPEC.md (side A, branch
// task/modules-xp-clean-room-spec-20261023 at 3f924e59, library 9.9). The six
// mean equinoctial elements (SPEC 1.5) are integrated under averaged rates
// (SPEC 2-7) on a grid of nodes anchored at the epoch (SPEC 9); a time is the
// cubic Hermite interpolant of its two nodes, carried to the osculating state
// by the short-period terms (SPEC 8) in TEME (SPEC 10).
//
// Units: Earth radii and minutes; angles in radians; the mean longitude is
// carried unwrapped (continuous) so that it interpolates.
//
// State of each section here:
//   1.1-1.5  conventions, constants, native elements      implemented
//   2        zonal rates: SPEC 2's explicit J2-J5 rates   implemented
//            (xp_spec_terms.inc)
//   3        drag: SPEC flux model and J70 temperature;   implemented: 3.7
//            the density table of SR 313 Table 6 as       rows to 1e-9 except
//            printed (j70_table6.inc) with USSA 1976      the library's own
//            below 90 km; the seasonal-latitudinal term   isolated +0.001
//            (cos^2 of the geodetic latitude, sign of     entries
//            the hemisphere); the SPEC 3.4 arc and
//            13-point Gauss-Legendre orbit average
//   4        SRP P AGOM (1 AU/r)^2 away from the Sun;     implemented: the 4
//            the cylindrical shadow by SPEC 4's closed-   and 4.4 vectors to
//            form quartic and 1e-12 boundary test; the    round-off
//            explicit averaged rates (wholly sunlit or
//            sunlit arc) and the output-time terms
//            (xp_spec_terms.inc)
//   5        Sun and Moon (SPEC formulas); averaged       implemented
//            regime: SPEC 5's quadrupole and octupole
//            rates and the 5.4 output-time corrections;
//            long-period regime: instantaneous point
//            masses in the Gauss equations
//            averaged over the orbit; long-period regime,
//            instantaneous point-mass Gauss equations
//   6        resonance (resonance.inc): SPEC bands, the   structure and G_lpq
//            EGM-96 harmonics per class, Kaula F_lmp,     series in; the rate
//            the classes' G_lpq e^28 series, Lagrange     equations SPEC-open:
//            rates in the six-component set               no terms yet
//   7        VDS = the 1100-minute class                  as SPEC 5/9
//   8        J2 short-periodics, osculating output        implemented
//   9        grid, third-order Runge-Kutta, fallbacks,    implemented
//            cubic Hermite
//   10       TEME km, km/s                                implemented
// -----------------------------------------------------------------------------

namespace sdnap {
namespace xpt {

constexpr double kKe = 0.074366859954178854;     // SPEC 1.3
constexpr double kMu = kKe * kKe;                 // ER^3/min^2
constexpr double kRe = 6378.1363;                 // km
constexpr double kJ2 = 1.08262668355315e-3;
constexpr double kJ3 = -2.53265648533224e-6;
constexpr double kJ4 = -1.619621591367e-6;
constexpr double kJ5 = -2.27296082868698e-7;
constexpr double kOmegaE = 4.37526908801129966e-3;  // rad/min (SPEC 1.2)
constexpr double kLongPeriodMinutes = 1100.0;       // SPEC 5, 7, 9
constexpr double kLongPeriodStep = 95.0;            // SPEC 9
constexpr double kAu = 149597870.0;                 // km
constexpr double kSunMass = 332946.038;             // Sun/Earth (SPEC 5)
// Moon/Earth (SPEC 5 lists 0.0123 and 0.012300034 "in places"): the section 5.3, 6.3, 6.4 and 10 vectors
// reproduce to 1e-12 with 0.012300034 in every path (averaged and instantaneous rates, output-time terms).
constexpr double kMoonMass = 0.012300034;
constexpr double kFlattening = 3.3528197529902951e-3;  // SPEC 1.3
constexpr double kSrpPressure = 4.5e-6;             // N/m^2 (SPEC 4)
constexpr double kArcsec = 4.84813681109536e-6;  // SPEC 5


struct Vec3 {
  double x, y, z;
};
inline Vec3 operator+(Vec3 a, Vec3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
inline Vec3 operator-(Vec3 a, Vec3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
inline Vec3 operator*(double s, Vec3 a) { return {s * a.x, s * a.y, s * a.z}; }
inline double dot(Vec3 a, Vec3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline Vec3 cross(Vec3 a, Vec3 b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
inline double norm(Vec3 a) { return std::sqrt(dot(a, a)); }

/// Mean equinoctial elements (SPEC 1.5): af, ag, chi, psi, lambda (rad,
/// unwrapped), n (rad/min).
enum { kAf = 0, kAg = 1, kChi = 2, kPsi = 3, kLam = 4, kN = 5 };

struct Kepler {
  double a, e, i, node, argp, m;  // radians; angles in [0, 2 pi)
};

inline double wrap(double x) {
  double r = std::fmod(x, kTwoPi);
  if (r < 0.0) r += kTwoPi;
  return r;
}

inline Kepler kepler_of(const double* y, double a) {
  Kepler k{};
  k.a = a;
  k.e = std::sqrt(y[kAf] * y[kAf] + y[kAg] * y[kAg]);
  const double varpi = std::atan2(y[kAg], y[kAf]);
  const double node = std::atan2(y[kChi], y[kPsi]);
  k.node = wrap(node);
  k.i = 2.0 * std::atan(std::sqrt(y[kChi] * y[kChi] + y[kPsi] * y[kPsi]));
  // SPEC 3.4: omega = atan2(a_g, a_f) - atan2(chi, psi), then reduced to [0, 2 pi) (a negative rounding residue
  // becomes 2 pi, whose sine is negative: the order matters for the seasonal term's hemisphere)
  k.argp = wrap(varpi - node);
  k.m = wrap(y[kLam] - varpi);
  return k;
}

inline Kepler kepler_of(const double* y) { return kepler_of(y, std::pow(kKe / y[kN], kX2o3)); }

inline void equinoctial_of(double n, double e, double i, double node, double argp, double m, double* y) {
  const double varpi = argp + node;
  const double t = std::tan(0.5 * i);
  y[kAf] = e * std::cos(varpi);
  y[kAg] = e * std::sin(varpi);
  y[kChi] = t * std::sin(node);
  y[kPsi] = t * std::cos(node);
  y[kLam] = m + varpi;
  y[kN] = n;
}

// --- SPEC 5: Sun and Moon -----------------------------------------------------

/// Sun: unit vector (mean equator and equinox of date) and distance (ER) at
/// d50 (days from 1950 January 0.0 UTC); also the obliquity and the solar mean
/// anomaly (radians) for the Moon.
struct Bodies {
  Vec3 sun_u;
  double sun_r;
  Vec3 moon_u;
  double moon_r;
};

struct Cx {
  double c, s;
};
inline Cx cmul(Cx a, Cx b) { return {a.c * b.c - a.s * b.s, a.s * b.c + a.c * b.s}; }

/// Sun and Moon at d50 (SPEC 5). The periodic series are evaluated with the
/// sines and cosines of the fundamental arguments and their integer
/// combinations built by complex multiplication.
inline Bodies bodies_at(double d50) {
  Bodies b{};
  const double T = (d50 - 18263.5) / 36525.0;
  const double ms = (357.52772333333 + 35999.05034 * T - 1.6027777777777777e-4 * T * T -
                     3.3333333333333e-6 * T * T * T) * kDeg;
  const double e = 0.01670832 - 4.2229e-5 * T - 1.26e-7 * T * T;
  const double varpi = (282.938346111111 + 1.71945722222222 * T + 4.62777777777776e-4 * T * T +
                        3.3333333333333e-6 * T * T * T) * kDeg;
  const double eps = (23.4392635861111 - 0.0130253805555555 * T - 1.30555555555555e-7 * T * T +
                      5.02777777777776e-7 * T * T * T) * kDeg;
  // multiples of the solar mean anomaly
  Cx pm[6];
  pm[0] = {1.0, 0.0};
  fm::sincos(ms, pm[1].s, pm[1].c);
  for (int k = 2; k <= 5; ++k) pm[k] = cmul(pm[k - 1], pm[1]);
  const double e2 = e * e, e3 = e2 * e, e4 = e3 * e, e5 = e4 * e;
  const double nu = ms + (2.0 * e - e3 / 4.0 + 5.0 * e5 / 96.0) * pm[1].s + (5.0 * e2 / 4.0 - 11.0 * e4 / 24.0) * pm[2].s +
                    (13.0 * e3 / 12.0 - 43.0 * e5 / 64.0) * pm[3].s + (103.0 * e4 / 96.0) * pm[4].s +
                    (1097.0 * e5 / 960.0) * pm[5].s;
  const double lam = nu + varpi;
  double ce, se, cl, sl;
  fm::sincos(eps, se, ce);
  fm::sincos(lam, sl, cl);
  b.sun_u = {cl, sl * ce, sl * se};
  const double roa = 1.0 + e2 / 2.0 - (e - 3.0 * e3 / 8.0 + 5.0 * e5 / 192.0) * pm[1].c - (e2 / 2.0 - e4 / 3.0) * pm[2].c -
                     (3.0 * e3 / 8.0 - 45.0 * e5 / 128.0) * pm[3].c - (e4 / 3.0) * pm[4].c - (125.0 * e5 / 384.0) * pm[5].c;
  b.sun_r = kAu * roa / kRe;

  // Moon (SPEC 5): IAU 1980 fundamental arguments, Brown's main terms.
  const double l = std::fmod(485866.733 + 1717915922.633 * T + 31.31 * T * T + 0.064 * T * T * T, 1296000.0) * kArcsec;
  const double L0 = std::fmod(785939.157 + 1732564372.598 * T - 5.802 * T * T + 0.019 * T * T * T, 1296000.0) * kArcsec;
  const double D = std::fmod(1072261.307 + 1602961601.328 * T - 6.891 * T * T + 0.019 * T * T * T, 1296000.0) * kArcsec;
  const double F = std::fmod(335778.877 + 1739527263.137 * T - 13.257 * T * T + 0.011 * T * T * T, 1296000.0) * kArcsec;
  // powers -K..K of e^{i l}, e^{i D}, e^{i F}, e^{i l'} (l' = the solar mean anomaly)
  Cx pl[7], pd[9], pf[5], pp[5];
  auto powers = [](double angle, Cx* out, int K) {
    out[K] = {1.0, 0.0};
    Cx one;
    fm::sincos(angle, one.s, one.c);
    for (int k = 1; k <= K; ++k) {
      out[K + k] = k == 1 ? one : cmul(out[K + k - 1], one);
      out[K - k] = {out[K + k].c, -out[K + k].s};
    }
  };
  powers(l, pl, 3);
  powers(D, pd, 4);
  powers(F, pf, 2);
  pp[2] = {1.0, 0.0};
  pp[3] = pm[1];
  pp[4] = pm[2];
  pp[1] = {pm[1].c, -pm[1].s};
  pp[0] = {pm[2].c, -pm[2].s};
  // e^{i (a l + b D + c F + d l')}
  auto arg = [&](int a, int bb, int c, int d) { return cmul(cmul(pl[a + 3], pd[bb + 4]), cmul(pf[c + 2], pp[d + 2])); };
  const double dl = 22639.5 * arg(1, 0, 0, 0).s - 4586.465 * arg(1, -2, 0, 0).s + 2369.912 * arg(0, 2, 0, 0).s +
                    769.016 * arg(2, 0, 0, 0).s - 668.146 * arg(0, 0, 0, 1).s - 411.608 * arg(0, 0, 2, 0).s -
                    211.656 * arg(2, -2, 0, 0).s - 205.962 * arg(1, -2, 0, 1).s + 191.953 * arg(1, 2, 0, 0).s -
                    165.145 * arg(0, -2, 0, 1).s + 147.687 * arg(1, 0, 0, -1).s - 125.154 * arg(0, 1, 0, 0).s -
                    109.673 * arg(1, 0, 0, 1).s;
  const double lon = L0 + dl * kArcsec;
  const double S = F + (22609.07 * arg(1, 0, 0, 0).s - 4578.13 * arg(1, -2, 0, 0).s + 2373.36 * arg(0, 2, 0, 0).s +
                        767.96 * arg(2, 0, 0, 0).s + 192.72 * arg(1, 2, 0, 0).s - 182.36 * arg(1, -2, 0, 1).s -
                        165.06 * arg(0, -2, 0, 1).s - 152.53 * arg(2, -2, 0, 0).s - 138.76 * arg(-1, 0, 0, 1).s -
                        126.98 * arg(0, 0, 0, 1).s - 115.18 * arg(1, 0, 0, 1).s - 112.79 * arg(0, 1, 0, 0).s) * kArcsec;
  const double g = 1.00000271 - 1.39978e-4 * (0.53858 * std::cos(3.040944319 - 9.253193406 * T) +
                                             3.33179 * std::cos(4.523601504 - 9.242202921 * T) +
                                             0.064043 * std::cos(3.295762417 - 9.246503573 * T));
  Cx s1;
  fm::sincos(S, s1.s, s1.c);
  const Cx s2 = cmul(s1, s1), s3 = cmul(s2, s1), s5 = cmul(s3, s2);
  const double lat = 0.089785955 * g * s1.s - 3.02572e-5 * g * g * g * s3.s + 1.94e-8 * g * g * g * g * g * s5.s -
                     0.00255045 * arg(0, -2, 1, 0).s;
  const double par = (3422.7 + 186.5398 * arg(1, 0, 0, 0).c + 34.3117 * arg(1, -2, 0, 0).c + 28.2333 * arg(0, 2, 0, 0).c +
                      10.1657 * arg(2, 0, 0, 0).c + 3.0861 * arg(1, 2, 0, 0).c + 1.9178 * arg(0, -2, 0, 1).c +
                      1.4437 * arg(1, -2, 0, 1).c + 1.1528 * arg(1, 0, 0, -1).c - 0.9781 * arg(0, 1, 0, 0).c -
                      0.949 * arg(1, 0, 0, 1).c - 0.7136 * arg(1, 0, -2, 0).c + 0.6215 * arg(3, 0, 0, 0).c +
                      0.6008 * arg(1, -4, 0, 0).c - 0.3997 * arg(0, 0, 0, 1).c + 0.3722 * arg(2, -4, 0, 0).c -
                      0.3039 * arg(2, -2, 0, 0).c - 0.3 * arg(0, 2, 0, 1).c + 0.2833 * arg(2, 2, 0, 0).c +
                      0.2607 * arg(0, 4, 0, 0).c + 0.2302 * arg(1, 2, 0, -1).c - 0.2257 * arg(1, -2, 0, -1).c +
                      0.1494 * arg(0, 1, 0, 1).c + 0.1268 * arg(2, 0, 0, -1).c - 0.1187 * arg(3, -2, 0, 0).c -
                      0.1093 * arg(1, 1, 0, 0).c - 0.1052 * arg(0, -2, 2, 0).c - 0.1038 * arg(2, 0, 0, 1).c) * kArcsec;
  const double sp = std::sin(par);
  double cb, sb, clon, slon;
  fm::sincos(lat, sb, cb);
  fm::sincos(lon, slon, clon);
  const Vec3 pos = {cb * clon / sp, (cb * slon * ce - sb * se) / sp, (cb * slon * se + sb * ce) / sp};
  b.moon_r = norm(pos);
  b.moon_u = (1.0 / b.moon_r) * pos;
  return b;
}

/// Point-mass third-body acceleration at r (ER/min^2), the direct minus the
/// indirect term.
inline Vec3 third_body_accel(Vec3 r, Vec3 su, double sr, double mass_ratio) {
  const double mu_b = mass_ratio * kMu;
  const Vec3 sv = sr * su;
  const Vec3 d = sv - r;
  const double dn = norm(d);
  return mu_b * ((1.0 / (dn * dn * dn)) * d - (1.0 / (sr * sr * sr)) * sv);
}

// --- Rates --------------------------------------------------------------------

/// The equinoctial frame and orbit geometry of a state.
struct Frame {
  Vec3 f, g, w;
  double a, n, e2, eta, c;
};

inline Frame frame_of(const double* y) {
  Frame fr{};
  const double chi = y[kChi], psi = y[kPsi];
  fr.c = 1.0 + chi * chi + psi * psi;
  const double ic = 1.0 / fr.c;
  fr.f = {(1.0 - chi * chi + psi * psi) * ic, 2.0 * chi * psi * ic, -2.0 * chi * ic};
  fr.g = {2.0 * chi * psi * ic, (1.0 + chi * chi - psi * psi) * ic, 2.0 * psi * ic};
  fr.w = {2.0 * chi * ic, -2.0 * psi * ic, (1.0 - chi * chi - psi * psi) * ic};
  fr.n = y[kN];
  fr.a = std::pow(kKe / fr.n, kX2o3);
  fr.e2 = y[kAf] * y[kAf] + y[kAg] * y[kAg];
  fr.eta = std::sqrt(1.0 - fr.e2);
  return fr;
}

/// Position and velocity (ER, ER/min) at eccentric longitude F.
inline void state_at_F(const double* y, const Frame& fr, double F, Vec3& r, Vec3& v, double& r_over_a) {
  const double k = y[kAf], h = y[kAg];
  const double beta = 1.0 / (1.0 + fr.eta);
  double sf, cf;
  fm::sincos(F, sf, cf);
  const double X = fr.a * ((1.0 - h * h * beta) * cf + h * k * beta * sf - k);
  const double Y = fr.a * ((1.0 - k * k * beta) * sf + h * k * beta * cf - h);
  r_over_a = 1.0 - k * cf - h * sf;
  const double rn = fr.a * r_over_a;
  const double s = fr.n * fr.a * fr.a / rn;
  const double Xd = s * (h * k * beta * cf - (1.0 - h * h * beta) * sf);
  const double Yd = s * ((1.0 - k * k * beta) * cf - h * k * beta * sf);
  r = X * fr.f + Y * fr.g;
  v = Xd * fr.f + Yd * fr.g;
}

/// Gauss equations: the rates of the six equinoctial elements under the
/// perturbing acceleration d at state (r, v). Nonsingular in e and i.
inline void gauss(const double* y, const Frame& fr, Vec3 r, Vec3 v, Vec3 d, double* out) {
  const double rn = norm(r);
  const Vec3 rh = (1.0 / rn) * r;
  const Vec3 hv = cross(r, v);
  const double hn = norm(hv);
  const Vec3 w = (1.0 / hn) * hv;
  const Vec3 sh = cross(w, rh);
  const double R = dot(d, rh), S = dot(d, sh), W = dot(d, w);
  const double vd = dot(v, d);
  const double adot = 2.0 * fr.a * fr.a * vd / kMu;
  const Vec3 edot = (1.0 / kMu) * ((2.0 * vd) * r - dot(r, d) * v - dot(r, v) * d);
  const Vec3 hdot = cross(r, d);
  const Vec3 wdot = (1.0 / hn) * (hdot - dot(w, hdot) * w);
  const double opz = 1.0 + w.z;
  const double chid = (wdot.x * opz - w.x * wdot.z) / (opz * opz);
  const double psid = -(wdot.y * opz - w.y * wdot.z) / (opz * opz);
  // frame rotation
  const double chi = y[kChi], psi = y[kPsi];
  const double cdot = 2.0 * chi * chid + 2.0 * psi * psid;
  const Vec3 nfd = {-2.0 * chi * chid + 2.0 * psi * psid, 2.0 * (chid * psi + chi * psid), -2.0 * chid};
  const Vec3 ngd = {2.0 * (chid * psi + chi * psid), 2.0 * chi * chid - 2.0 * psi * psid, 2.0 * psid};
  const Vec3 fdot = (1.0 / fr.c) * (nfd - cdot * fr.f);
  const Vec3 gdot = (1.0 / fr.c) * (ngd - cdot * fr.g);
  const Vec3 ev = y[kAf] * fr.f + y[kAg] * fr.g;
  out[kAf] = dot(edot, fr.f) + dot(ev, fdot);
  out[kAg] = dot(edot, fr.g) + dot(ev, gdot);
  out[kChi] = chid;
  out[kPsi] = psid;
  const double p = fr.a * fr.eta * fr.eta;
  const double er = dot(ev, rh), es = dot(ev, sh);
  const double na = fr.n * fr.a;
  out[kLam] = -(2.0 * rn / (na * fr.a)) * R - (fr.eta / (na * (1.0 + fr.eta))) * (er * R + (1.0 + rn / p) * es * S) +
              (rn / fr.a) * rh.z * W / ((1.0 + w.z) * na * fr.eta);
  out[kN] = -1.5 * fr.n / fr.a * adot;
}

template <int K>
inline double ipow(double x) {
  double r = 1.0;
  for (int k = 0; k < K; ++k) r *= x;
  return r;
}

#include "xp_spec_terms.inc"

/// The six-component set (n-dot, e-dot, i-dot, e varpi-dot, sin i Omega-dot,
/// lambda-dot - n) carried to the equinoctial rates (SPEC 1.5, 2).
struct AngleTrig {
  double cw, sw, cO, sO, ci, si;
};

inline AngleTrig angle_trig(const Kepler& k) {
  AngleTrig g{};
  fm::sincos(k.argp, g.sw, g.cw);
  fm::sincos(k.node, g.sO, g.cO);
  fm::sincos(k.i, g.si, g.ci);
  return g;
}

inline void six_to_equinoctial(const AngleTrig& g, const double* six, double* out) {
  const double cv = g.cO * g.cw - g.sO * g.sw, sv = g.sO * g.cw + g.cO * g.sw;  // varpi = omega + Omega
  const double cO = g.cO, sO = g.sO;
  const double opc = 1.0 + g.ci;
  out[kAf] = six[1] * cv - six[3] * sv;
  out[kAg] = six[1] * sv + six[3] * cv;
  out[kChi] = (six[2] * sO + six[4] * cO) / opc;
  out[kPsi] = (six[2] * cO - six[4] * sO) / opc;
  out[kLam] = six[5];
  out[kN] = six[0];
}

/// The satellite's perigee frame P, Q, W (SPEC 5), once per evaluation.
struct Perifocal {
  Vec3 P, Q, W;
};

inline Perifocal perifocal_of(const AngleTrig& g) {
  const double co = g.cO, so = g.sO, cw = g.cw, sw = g.sw, ci = g.ci, si = g.si;
  Perifocal f{};
  f.P = {cw * co - sw * so * ci, cw * so + sw * co * ci, sw * si};
  f.Q = {-sw * co - cw * so * ci, -sw * so + cw * co * ci, cw * si};
  f.W = {so * si, -co * si, ci};
  return f;
}

/// The body's direction cosines on the satellite's perigee frame (SPEC 5).
inline void direction_cosines(const Perifocal& f, Vec3 su, double& A, double& B, double& C) {
  A = dot(su, f.P);
  B = dot(su, f.Q);
  C = dot(su, f.W);
}

/// SPEC 3.4 (side A at 22570b7): the drag rates as stated there, from 13-point
/// Gauss-Legendre sums over the perigee arc at the J2-corrected radius:
/// geodetic height, the diurnal term at the geocentric latitude, the seasonal
/// term at the geodetic latitude, the co-rotation speed factor V; rho = 0
/// above 2500 km; the acceleration -(1/2) rho B |v_rel| v_rel, B = C_D A/m.
inline void drag_rates(const double* y, const Frame& fr, const Kepler& k, const AngleTrig& ag, double bterm,
                       const Bodies& b, double d50, double* out) {
  static const double gx[13] = {-0.98418305471858814, -0.91759839922297803, -0.80157809073330988,
                                -0.64234933944034023, -0.44849275103644692, -0.23045831595513480, 0.0,
                                0.23045831595513480, 0.44849275103644692, 0.64234933944034023,
                                0.80157809073330988, 0.91759839922297803, 0.98418305471858814};
  static const double gw[13] = {0.040484004765315877, 0.092121499837728452, 0.13887351021978719,
                                0.17814598076194571, 0.20781604753688851, 0.22628318026289720,
                                0.23255155323087390, 0.22628318026289720, 0.20781604753688851,
                                0.17814598076194571, 0.13887351021978719, 0.092121499837728452,
                                0.040484004765315877};
  const double e = k.e, a = fr.a, n = fr.n, eta = fr.eta;
  const double p = a * eta * eta;
  const double th = ag.ci, si = ag.si;
  const double f = kFlattening, eps2 = f * (2.0 - f);
  // arc
  const double rp = a * (1.0 - e);
  const double hp = kRe * (rp - 1.0 + f * si * si * ag.sw * ag.sw);
  const double bb = hp < 90.0 ? 90.0 : (hp > 900.0 ? 900.0 : hp);
  const double band = bb * (-3.130124 + bb * (0.061710434 + bb * (-3.4111266e-4 + bb * (8.7321429e-7 +
                      bb * (-1.122534e-9 + bb * (7.1123451e-13 + bb * -1.776575e-16)))))) / kRe;
  double nuc = kPi;
  if (band < 2.0 * a * e) {
    const double c = (rp * e - band) / (e * (rp + band));
    nuc = std::acos(c < -1.0 ? -1.0 : (c > 1.0 ? 1.0 : c));
  }
  const drag::Flux fl = drag::flux_at(d50);
  double D, N;
  drag::day_of_year(d50, D, N);
  const drag::DateTerms dt = drag::date_terms(fl, D, N);
  const double sdsun = b.sun_u.z, cdsun = std::sqrt(1.0 - b.sun_u.z * b.sun_u.z);  // the Sun's declination
  const double rasun = std::atan2(b.sun_u.y, b.sun_u.x);
  const double q = kOmegaE * eta * eta * eta / n;
  const double cj2 = kJ2 / (4.0 * p);
  double G = 0, SD = 0, Se = 0, Ssu = 0, Sn = 0, Snc = 0, Suu = 0, Ss = 0, Sw = 0;
  for (int j = 0; j < 13; ++j) {
    const double nu = nuc * gx[j];
    double sn, cn;
    fm::sincos(nu, sn, cn);
    const double cu = ag.cw * cn - ag.sw * sn, su = ag.sw * cn + ag.cw * sn;  // u = omega + nu
    const double Dn = 1.0 + e * cn;
    const double c2u = cu * cu - su * su;
    const double r = p / Dn + cj2 * ((1.0 - th * th) * c2u - (3.0 * th * th - 1.0) * (e * cn / (1.0 + eta) + 2.0 * eta / Dn + 1.0));
    // geocentric latitude phi' = arcsin(sin i sin u), carried as its sine and (non-negative) cosine
    const double sp = si * su, cp = std::sqrt(1.0 - sp * sp);
    const double Nn = eps2 * sp * cp, n0 = 1.0 - eps2 * cp * cp, W0 = std::sqrt(1.0 - eps2 * sp * sp);
    const double t1 = Nn / (n0 + W0 * (r - W0));
    // sin(phic + atan t1) = (sin phic + cos phic t1) / sqrt(1 + t1^2)
    const double q1 = std::sqrt(1.0 + t1 * t1);
    const double s1 = (sp + cp * t1) / q1;
    const double W1 = std::sqrt(1.0 - eps2 * s1 * s1);
    const double h = kRe * (r / q1 - W1);
    double H = std::atan2(ag.sO * cu + ag.cO * su * th, ag.cO * cu - ag.sO * su * th) - rasun;
    H -= kTwoPi * std::floor(H / kTwoPi);
    double rho = 1e-20;  // SPEC 3.3 (amendment 6): above 2500 km
    if (h <= 2500.0) {
      const double tinf = drag::exospheric_temperature(dt, sp, cp, sdsun, cdsun, H);
      // the geodetic latitude enters only the seasonal-latitudinal term (90 < h < 300 km)
      const double phig = (h > 90.0 && h < 300.0) ? std::asin(sp) + std::atan(Nn / (n0 + W1 * h / kRe)) : 0.0;
      rho = drag::density(dt, tinf, h, phig);
    }
    const double V = std::sqrt(1.0 + 2.0 * e * cn + e * e - 2.0 * q * th + q * q * cp * cp / (Dn * Dn));
    const double K = gw[j] * rho * V / (Dn * Dn);
    const double iD2 = 1.0 / (Dn * Dn);
    G += K;
    SD += K * Dn;
    Se += K * (e + cn);
    Ssu += K * su * cu * iD2;
    Sn += K * sn / Dn;
    Snc += K * sn * cn * iD2;
    Suu += K * cu * cu * iD2;
    Ss += K * sn * (1.0 - q * th * iD2);
    Sw += K * (Dn * cn + e + cn) * iD2;
  }
  const double P = 500.0 * kRe * nuc / kPi;
  const double Ar = eta * eta * n * a / 2.0, oa = q * th;
  const double PB = P * bterm;
  double six[6];
  six[0] = PB * 3.0 * n * (n * a / 2.0) * (SD + e * Se - oa * G);
  six[1] = PB * Ar * (oa * Sw - 2.0 * Se);
  six[2] = -PB * si * q * Ar * Suu;
  // The cross-track force's node rate is Omega-dot = -P B q A_r S_su (Gauss: r sin u W / (n a^2 eta sin i), the
  // co-rotation W carrying sin i), and it enters varpi = omega + Omega and lambda as (1 - cos i) Omega-dot. SPEC 3.4
  // writes sin i Omega-dot without the sin i and keeps only the -cos i part in e varpi-dot and lambda-dot; the
  // library's drag rates at its own states along the ten 3.13 sets (580 hourly states) fit these forms with
  // coefficients 1.00000 (median residual 8e-10 relative), 3.4 as written misses lambda-dot by 0.9 to 2.5 times.
  six[3] = PB * (e * (oa - q) * Ar * Ssu + e * oa * Ar * Snc - 2.0 * Ar * Ss);
  six[4] = -PB * q * si * Ar * Ssu;
  six[5] = PB * ((oa - q) * Ar * Ssu + 2.0 * eta * e * Ar * Sn + (1.0 - eta) * oa * Ar * Snc - (2.0 * e * Ar / (1.0 + eta)) * Ss);
  double d[6];
  six_to_equinoctial(ag, six, d);
  for (int m = 0; m < 6; ++m) out[m] += d[m];
}

/// SDN-AP 2a (DESIGN 2a.1, 2a.2): drag on NRLMSISE-00 x exp(s(t)) with
/// a_D = -(1/2) B_eff rho |v_r| v_r, v_r = v - omega_E x r, averaged by the
/// K-point trapezoid in eccentric anomaly (near-circular) or the SPEC 3.4
/// perigee band (z = a e / H >= 3). theta_g: Greenwich angle at the time.
inline void sdnap_drag_rates(const double* y, const Frame& fr, const Kepler& k, const AngleTrig& ag, double beff,
                             double theta_g, double d50, double* out) {
  const Perifocal pf = perifocal_of(ag);
  const double a = fr.a, e = k.e, eta = fr.eta, n = fr.n;
  double D, N;
  drag::day_of_year(d50, D, N);
  const int doy = static_cast<int>(std::floor(D)) + 1;
  const double sec = (D - std::floor(D)) * 86400.0;
  const double scale = -0.5 * beff * kRe * 1000.0;
  kernel::Pair kp{};
  const bool use_kernel = sdn::environment().kernel && kernel::prepare() && kernel::acquire_pair(d50, kp);
  // the density is taken at the osculating radius: the mean orbit's plus the first-order J2 short-period terms (the
  // arrangement of SPEC 3.4 / the SGP4 final step), whose constant part sets the mean height a few hundred meters off
  // the mean elements' (at 53 deg -0.43 km at 300 km: about 1 % of the density, which fitted B_eff took up)
  const double p_mean = a * eta * eta, cj2 = kJ2 / (4.0 * p_mean), th = ag.ci;
  auto osc_scale = [&](double cn, double sn) {
    const double Dn = 1.0 + e * cn, r = p_mean / Dn;
    const double cu = ag.cw * cn - ag.sw * sn, su = ag.sw * cn + ag.cw * sn;
    const double c2u = cu * cu - su * su;
    const double dr = cj2 * ((1.0 - th * th) * c2u - (3.0 * th * th - 1.0) * (e * cn / (1.0 + eta) + 2.0 * eta / Dn + 1.0));
    return (r + dr) / r;
  };
  auto node = [&](Vec3 rv, Vec3 vv, double w, double* acc, double rscale) {
    const Vec3 rd = rscale * rv;
    double lon = std::atan2(rd.y, rd.x) - theta_g;
    lon -= kTwoPi * std::floor((lon + kPi) / kTwoPi);
    double rho;
    if (use_kernel) {
      const double rr = norm(rd);
      rho = kernel::density(kp, rr, std::asin(rd.z / rr), lon);
    } else {
      double phi, h;
      drag::geodetic(rd.x, rd.y, rd.z, phi, h);
      rho = h > 2500.0 ? 0.0 : sdn::msis_density(phi, lon, h, doy, sec, d50);
    }
    const Vec3 vrel = {vv.x + kOmegaE * rv.y, vv.y - kOmegaE * rv.x, vv.z};
    const Vec3 d = (scale * rho * norm(vrel)) * vrel;
    double g[6];
    gauss(y, fr, rv, vv, d, g);
    for (int m = 0; m < 6; ++m) acc[m] += w * g[m];
  };
  double acc[6] = {0, 0, 0, 0, 0, 0};
  const double z = a * kRe * e / sdn::kScaleHeightKm;
  if (z < 3.0) {
    for (int j = 0; j < sdn::kTrapezoid; ++j) {
      const double E = kTwoPi * j / sdn::kTrapezoid;
      double sE, cE;
      fm::sincos(E, sE, cE);
      const double ome = 1.0 - e * cE;
      const Vec3 rv = (a * (cE - e)) * pf.P + (a * eta * sE) * pf.Q;
      const Vec3 vv = (-a * n * sE / ome) * pf.P + (a * n * eta * cE / ome) * pf.Q;
      node(rv, vv, ome / sdn::kTrapezoid, acc, osc_scale((cE - e) / ome, eta * sE / ome));
    }
  } else {
    static const double gx[13] = {-0.98418305471858814, -0.91759839922297803, -0.80157809073330988,
                                  -0.64234933944034023, -0.44849275103644692, -0.23045831595513480, 0.0,
                                  0.23045831595513480, 0.44849275103644692, 0.64234933944034023,
                                  0.80157809073330988, 0.91759839922297803, 0.98418305471858814};
    static const double gw[13] = {0.040484004765315877, 0.092121499837728452, 0.13887351021978719,
                                  0.17814598076194571, 0.20781604753688851, 0.22628318026289720,
                                  0.23255155323087390, 0.22628318026289720, 0.20781604753688851,
                                  0.17814598076194571, 0.13887351021978719, 0.092121499837728452,
                                  0.040484004765315877};
    const double p = a * eta * eta, rp = a * (1.0 - e);
    const double hp = kRe * (rp - 1.0 + kFlattening * ag.si * ag.si * ag.sw * ag.sw);
    const double bb = hp < 90.0 ? 90.0 : (hp > 900.0 ? 900.0 : hp);
    const double band = bb * (-3.130124 + bb * (0.061710434 + bb * (-3.4111266e-4 + bb * (8.7321429e-7 +
                        bb * (-1.122534e-9 + bb * (7.1123451e-13 + bb * -1.776575e-16)))))) / kRe;
    double nuc = kPi;
    if (band < 2.0 * a * e) {
      const double c = (rp * e - band) / (e * (rp + band));
      nuc = std::acos(c < -1.0 ? -1.0 : (c > 1.0 ? 1.0 : c));
    }
    const double vs = std::sqrt(kMu / p);
    for (int j = 0; j < 13; ++j) {
      double sn, cn;
      fm::sincos(nuc * gx[j], sn, cn);
      const double r = p / (1.0 + e * cn);
      const Vec3 rv = (r * cn) * pf.P + (r * sn) * pf.Q;
      const Vec3 vv = (-vs * sn) * pf.P + (vs * (e + cn)) * pf.Q;
      node(rv, vv, gw[j] * (r / a) * (r / a) / eta * nuc / kTwoPi, acc, osc_scale(cn, sn));
    }
  }
  if (use_kernel) kernel::release_pair(kp);
  for (int m = 0; m < 6; ++m) out[m] += acc[m];
}

/// SDN-AP 2c (DESIGN eq. 7): empirical transverse accelerations (ER/min^2)
/// tau0 + tauc cos u + taus sin u, weighted by g(t), near-circular averaged
/// rates: n-dot = -3 tau0 g / a, d(a_f + i a_g)/dt = e^{i Omega} (tauc + i taus) g / (n a).
/// Diagnostic: tauc and taus held after the arc (g = 1) instead of the 2c Gauss-Markov decay.
inline bool& tau_persist() {
  static bool p = false;
  return p;
}

inline void tau_rates(double tau0, double tauc, double taus, double arc_end, uint8_t lowering, uint8_t tau_held,
                      double t, const Frame& fr, const AngleTrig& ag, double* out) {
  if (tau0 == 0.0 && tauc == 0.0 && taus == 0.0) return;
  const double decay = std::fabs(t) <= arc_end ? 1.0 : std::exp(-(std::fabs(t) - arc_end) / sdn::tau_persistence_minutes());
  const double g = tau_held || tau_persist() ? 1.0 : decay;
  const double na = fr.n * fr.a;
  // 2c.2: a lowering (or raising) object's thrust is sustained, so tau0 keeps g = 1 after the arc
  out[kN] += -3.0 * tau0 * (lowering ? 1.0 : decay) / fr.a;
  out[kAf] += (ag.cO * tauc - ag.sO * taus) * g / na;
  out[kAg] += (ag.sO * tauc + ag.cO * taus) * g / na;
}

/// SPEC 4 (amendment 3): cbrt(x) = sign(x) |pow(|x|, 1/3)|, 1/3 the double 0.3333333333333333.
inline double cube_root(double x) {
  const double r = std::fabs(std::pow(std::fabs(x), 0.3333333333333333));
  return x < 0.0 ? -r : r;
}

/// Diagnostics (sdnap_shadow_margin): the smallest |S(nu)| over the candidates with n(nu) < 0 at the last shadow
/// evaluation of this thread.
inline double& shadow_margin_slot() {
  static thread_local double m = 0.0;
  return m;
}

/// The second smallest |S| over the candidates with n < 0 (diagnostics: a near-miss second boundary).
inline double& shadow_margin2() {
  static thread_local double m = 0.0;
  return m;
}

/// The true anomaly of the candidate that set shadow_margin_slot (diagnostics).
inline double& shadow_margin_nu() {
  static thread_local double nu = 0.0;
  return nu;
}

/// SPEC 4's boundary test |S| < 1e-12 (diagnostics may move it: sdnap_shadow_policy 3 takes no boundary at all).
inline double& shadow_threshold() {
  static double t = 1e-12;
  return t;
}

/// SPEC 4 (amendment 6) rounding-limited decisions, for the conformance envelope: 0 the sequence as written; 1 every
/// rounding-limited decision taken as a sunlit arc, 2 as wholly sunlit. A decision is rounding-limited when a candidate
/// with n < 0 has 1e-13 <= |S| <= 1e-11, or when moving each input (a, e, i, Omega, omega, the Sun direction) by up to
/// 8 units in the last place changes it; the setting holds for every rate evaluation, nodes and stages included.
inline int& shadow_envelope() {
  static int e = 0;
  return e;
}

/// SPEC 4 shadow (Escobal 1965, 5.3; cylindrical shadow of radius R_E), amendment 3: the library's closed-form
/// sequence, steps 2 to 8, every operation in the stated order (no fused operations on wasm32; std:: pow, sqrt,
/// cbrt as above, atan2, acos, cos, sin, tan, atan). A, B the Sun's direction cosines on P and Q (step 1), e and
/// p = (1 - e e) a in R_E. True when the orbit has a sunlit arc E1 (exit) .. E2 (entry, + 2 pi below E1); false:
/// wholly sunlit.
inline bool shadow_sequence(double A, double B, double e, double p, double& E1, double& E2, double threshold = shadow_threshold()) {
  shadow_margin_slot() = 1e300;
  shadow_margin2() = 1e300;
  // 2. quartic coefficients
  const double G = B * B, H = A * A, F = G + H, e2 = e * e;
  const double j = (1.0 / p) * (1.0 / p), h = j * j, k = G - H, g = 1.0 - G, m = j * (-2.0);
  const double c4 = (F * F + (h * e2) * e2) + e2 * (k * m);
  const double c3 = (e * e2) * (4.0 * h) + (e * (-4.0 * j)) * k;
  const double c2 = ((((H * (-4.0)) * G + (k + k) * g) + (g * m) * e2) + (6.0 * h) * e2) + k * m;
  const double c1 = (4.0 * h) * e + (e * (-4.0 * j)) * g;
  const double c0 = ((g * m + h) + g * g);
  if (c4 == 0.0) return false;
  // 3. monic and depressed
  const double a3 = c3 / c4, a2 = c2 / c4, a1 = c1 / c4, a0 = c0 / c4;
  const double f = a3 * (-0.25), f2 = f * f, f3 = std::pow(f, 3.0), f4 = std::pow(f, 4.0), b3 = 3.0 * a3;
  const double P = (a2 + 6.0 * f2) + b3 * f;
  const double Q = ((a1 + (a2 + a2) * f) + 4.0 * f3) + b3 * f2;
  const double W = (((((a0 + a1 * f) + a2 * f2) + f4) + a3 * f3) * (-4.0)) + P * P;
  // 4. the depressed resolvent cubic t^3 + s1 t + s3 = 0
  const double s3 = (((Q * Q) * (-27.0) + std::pow(P, 3.0) * 16.0) + (P * (-18.0)) * W) / 27.0;
  const double s1 = (3.0 * W + (P * P) * (-4.0)) / 3.0;
  const double D = (s3 * s3) * 0.25 + std::pow(s1, 3.0) / 27.0;
  double t1, t2, t3;
  if (D > 0.0) {
    t1 = cube_root(s3 * (-0.5) + std::sqrt(D)) + cube_root(s3 * (-0.5) - std::sqrt(D));
    t2 = t3 = 0.0;  // zeros stand in for the complex pair
  } else if (D == 0.0) {
    t1 = 2.0 * cube_root(s3 * (-0.5));
    t2 = t3 = cube_root(s3 * 0.5);
  } else if (D < 0.0) {
    const double w = std::sqrt(std::pow(-s1, 3.0) / 27.0), c = -s3 / (w + w);
    const double phi = std::atan2(std::sqrt(1.0 - c * c), c) / 3.0, u = 2.0 * std::sqrt(s1 / (-3.0));
    t1 = u * std::cos(phi);
    t2 = u * std::cos(phi + 2.0943951023931953);
    t3 = u * std::cos(phi + 4.1887902047863905);
  } else {
    t1 = t2 = t3 = 0.0;  // D not a number
  }
  // 5. the resolvent root
  const double z1 = (P * (-2.0)) / 3.0 + t1, z2 = (P * (-2.0)) / 3.0 + t2, z3 = (P * (-2.0)) / 3.0 + t3;
  double z = z2 > z3 ? z2 : z3;
  z = z1 > z ? z1 : z;
  if (z < 0.0) return false;
  // 6. the quadratic factors
  const double r = std::sqrt(z), q = Q / r;
  const double D1 = ((((P + z) - q) * 0.5) * (-4.0)) + z, D2 = ((((P + z) + q) * 0.5) * (-4.0)) + z;
  double ys[4];
  int ny = 0;
  if (D1 >= 0.0) {
    ys[ny++] = (std::sqrt(D1) - r) * 0.5;
    ys[ny++] = (-r - std::sqrt(D1)) * 0.5;
  }
  if (D2 >= 0.0) {
    ys[ny++] = (r + std::sqrt(D2)) * 0.5;
    ys[ny++] = (r - std::sqrt(D2)) * 0.5;
  }
  double nus[8];
  int nn = 0;
  for (int q2 = 0; q2 < ny; ++q2) {
    const double x = f + ys[q2];
    if (!(x >= -1.0 && x <= 1.0)) continue;
    nus[nn++] = std::acos(x);
  }
  // 7. candidates: the nu, then 2 pi - nu for each, every angle in [0, 2 pi)
  constexpr double kTwoPiD = 6.283185307179586;
  auto reduce = [&](double a) {
    if (std::fabs(a) >= kTwoPiD) a = std::fmod(a, kTwoPiD);
    if (a < 0.0) a += kTwoPiD;
    return a;
  };
  const int base = nn;
  for (int q2 = 0; q2 < base; ++q2) nus[nn++] = kTwoPiD - nus[q2];
  double nu_entry = 0.0, nu_exit = 0.0;
  int found = 0;
  const double pp = p * p;
  for (int q2 = 0; q2 < nn; ++q2) {
    const double nu = reduce(nus[q2]);
    const double cn = std::cos(nu), sn = std::sin(nu);
    const double n = A * cn + B * sn, d = e * cn + 1.0;
    const double S = ((pp * n) * n + d * d) - pp;
    if (n < 0.0 && std::fabs(S) < shadow_margin_slot()) { shadow_margin2() = shadow_margin_slot(); shadow_margin_slot() = std::fabs(S); shadow_margin_nu() = nu; }
    else if (n < 0.0 && std::fabs(S) < shadow_margin2()) shadow_margin2() = std::fabs(S);
    if (!(n < 0.0 && std::fabs(S) < threshold)) continue;
    ++found;
    if (found > 2) continue;  // later boundaries are ignored
    const double dS = ((e * d) * (-2.0)) * sn + (((-A) * sn + B * cn) * pp) * (n + n);
    if (dS > 0.0) nu_entry = nu;
    else nu_exit = nu;
  }
  if (found < 2) return false;
  // 8. eccentric anomalies
  const double kk = std::sqrt((1.0 - e) / (e + 1.0));
  auto ecc = [&](double nu) { return reduce(2.0 * std::atan(std::tan(nu / 2.0) * kk)); };
  E1 = ecc(nu_exit);
  E2 = ecc(nu_entry);
  if (E2 < E1) E2 += kTwoPiD;
  if (std::fabs(E2 - E1) < 1e-12) return false;
  return true;
}

/// The shadow from caller-supplied direction cosines (the Moon-centred SRP of SDN-AP 2h.1 reuses it).
inline bool sunlit_arc(double A, double B, double e, double p, double& E1, double& E2) { return shadow_sequence(A, B, e, p, E1, E2); }

/// SPEC 4 step 1 (amendment 3): the Sun's direction cosines A (on P) and B (on Q) from the current mean elements
/// recovered as SPEC 3.4 does (kepler_of), in the stated order, then the sequence with p = (1 - e e) a.
inline bool xp_shadow_once(const Kepler& k, const Vec3& s, double& E1, double& E2, double threshold) {
  const double cw = std::cos(k.argp), sw = std::sin(k.argp), cO = std::cos(k.node), sO = std::sin(k.node);
  const double ci = std::cos(k.i), si = std::sin(k.i);
  const double B = ((cw * si) * s.z + s.x * ((cO * (-sw)) - ci * (cw * sO))) + s.y * (ci * (cw * cO) - sO * sw);
  const double A = ((sw * si) * s.z + s.x * ((cw * cO) - ci * (sO * sw))) + s.y * ((cw * sO) + (ci * sw) * cO);
  const double e2 = k.e * k.e;
  return shadow_sequence(A, B, k.e, (1.0 - e2) * k.a, E1, E2, threshold);
}

/// x moved by `units` units in the last place (signed).
inline double ulps(double x, int units) {
  const double to = units > 0 ? std::numeric_limits<double>::infinity() : -std::numeric_limits<double>::infinity();
  for (int q = 0; q < (units > 0 ? units : -units); ++q) x = std::nextafter(x, to);
  return x;
}

inline bool xp_shadow(const Kepler& k, const Vec3& s, double& E1, double& E2) {
  const int env = shadow_envelope();
  const bool nominal = xp_shadow_once(k, s, E1, E2, shadow_threshold());
  if (env == 0) return nominal;
  bool any_arc = nominal, any_sunlit = !nominal;
  double arc1 = E1, arc2 = E2;
  auto consider = [&](bool arc, double e1, double e2) {
    if (arc) {
      if (!any_arc) { arc1 = e1; arc2 = e2; }
      any_arc = true;
    } else {
      any_sunlit = true;
    }
  };
  double e1, e2;
  consider(xp_shadow_once(k, s, e1, e2, 1e-11), e1, e2);  // (a): candidates up to 1e-11 as boundaries
  consider(xp_shadow_once(k, s, e1, e2, 1e-13), e1, e2);  //      and those from 1e-13 not
  for (int q = 0; q < 8; ++q)                               // (b): each input +-8 units in the last place
    for (int sgn = -1; sgn <= 1; sgn += 2) {
      Kepler kq = k;
      Vec3 sq = s;
      double* v = q == 0 ? &kq.a : q == 1 ? &kq.e : q == 2 ? &kq.i : q == 3 ? &kq.node : q == 4 ? &kq.argp : q == 5 ? &sq.x : q == 6 ? &sq.y : &sq.z;
      *v = ulps(*v, 8 * sgn);
      consider(xp_shadow_once(kq, sq, e1, e2, shadow_threshold()), e1, e2);
    }
  if (env == 1 && any_arc) { E1 = arc1; E2 = arc2; return true; }
  if (env == 2 && any_sunlit) return false;
  return nominal;
}

/// SPEC 4 averaged SRP rates on the current mean orbit (Sun held fixed over
/// the orbit): the explicit formulas of the wholly sunlit orbit or of the sunlit
/// arc E1 .. E2 (xp_spec_terms.inc), added to the rates in the state order.
inline void srp_rates(const double* /*y*/, const Frame& fr, const Kepler& k, const Perifocal& pf, double agom,
                      const Bodies& b, double* out) {
  double A, B, C;
  direction_cosines(pf, b.sun_u, A, B, C);
  const double rs_au = b.sun_r * kRe / kAu;
  const double Fs = kSrpPressure * agom * 3600.0 / (1000.0 * kRe * rs_au * rs_au);
  double E1, E2, d[6];
  if (xp_shadow(k, b.sun_u, E1, E2)) {
    srp_rates_arc(k.e, fr.eta, k.argp, k.node, k.i, k.a, fr.n, E1, E2, A, B, C, Fs, d);
  } else {
    srp_rates_sunlit(k.e, fr.eta, k.argp, k.node, k.i, k.a, fr.n, A, B, C, Fs, d);
  }
  for (int m = 0; m < 6; ++m) out[m] += d[m];
}

#include "resonance.inc"
#include "tesseral.inc"

/// Per-object constants of the rate function.
struct RateContext {
  double d50_epoch;
  double bterm, agom;
  uint8_t long_period;  ///< epoch period >= 1100 min (SPEC 5, 9)
  int8_t resonance;     ///< SPEC 6 class at the epoch (0 none, 1 one-day, 2 half-day, 3 eight-hour, 4 sixteen-hour)
  const res::ResCoef* res_epoch;   ///< SGP4XP: the epoch class's terms at e_0, i_0, integrated (owned, xp_release)
  int32_t res_count;
  const res::GTaylor* res_taylor;  ///< SDN-AP: the epoch class's G about e_0 >= res::kSeriesE (owned, xp_release)
  double e0, i0;        ///< epoch e and i (rad): SDN-AP's shallow terms to first order about them
  uint8_t sdnap;        ///< SDN-AP theory (DESIGN 2): NRLMSISE-00 drag, signed B_eff, tau terms
  double theta_g0;      ///< Greenwich angle at epoch (SPEC 1.2)
  double tau0, tauc, taus;  ///< SDN-AP 2c, ER/min^2
  double arc_end;           ///< SDN-AP 2c: end of the fit arc, minutes
  uint8_t drag_nodes;       ///< SDN-AP in the drag regime: nodes at the density kernel's times
  uint8_t lowering;         ///< SDN-AP 2c.2: tau0 persists after the arc (kFlagLowering)
  uint8_t tau_held;         ///< SDN-AP above the drag regime: tauc and taus held after the arc (kFlagTauHeld)
  const tess::ShallowCoef* shallow;  ///< SDN-AP 2d.5 shallow resonant terms (owned, xp_release)
  const tess::ShallowCoef* near;     ///< SDN-AP 2d.5b near-resonant terms, output time (owned, xp_release)
  int32_t near_count;
  int32_t shallow_count;
  const float* mdaily;          ///< SDN-AP 2d m-daily Fbar, dFbar/di pairs, float (owned, xp_release)
  int32_t mdaily_degree;
  const float* zt;              ///< SDN-AP 2d.6 zonal tail: Fbar, dFbar, g0, g1 (owned, xp_release)
  int32_t zt_degree;
  const float* sp;              ///< SDN-AP 2d.3b terms: Fbar, dFbar, g0, g1 (owned, xp_release)
  int16_t sp_degree;
  int16_t sp_mask;
};

/// SPEC 9 (amendment 6): the tests every rate evaluation applies to the state it is given (k2, k3, k4 and the new
/// node's): an eccentricity above 1 (code 4), a mean motion zero or negative (9), and with drag 1 - e^2 at or below
/// 1e-12 (10); comparisons, so a NaN passes. 0 when the state passes.
inline int state_test(const RateContext& ctx, const double* y) {
  const double e2 = y[kAf] * y[kAf] + y[kAg] * y[kAg];
  if (std::sqrt(e2) > 1.0) return 4;
  if (y[kN] <= 0.0) return 9;
  if (ctx.bterm > 0.0 && 1.0 - e2 <= 1e-12) return 10;
  return 0;
}

/// The averaged rates f(t, y) of SPEC 9. SGP4XP: false when the state fails the 9.9 tests (state_test); SDN-AP: when
/// it is not elliptic with a positive mean motion, or a rate is not finite.
inline bool rates(const RateContext& ctx, double t, const double* y, double* out) {
  const Frame fr = frame_of(y);
  if (ctx.sdnap ? (!(fr.n > 0.0) || !(fr.e2 < 1.0)) : state_test(ctx, y) != 0) return false;
  const Kepler k = kepler_of(y, fr.a);
  const double s = std::sin(k.i), c = std::cos(k.i);
  const double p = fr.a * (1.0 - k.e * k.e);
  double six[6] = {0, 0, 0, 0, 0, 0};
  zonal_six(k.e, fr.n, s, c, fr.eta, p, k.argp, k.i, six);
  const Bodies b = bodies_at(ctx.d50_epoch + t / kMinutesPerDay);
  const AngleTrig ag = angle_trig(k);
  const Perifocal pf = perifocal_of(ag);
  if (!ctx.long_period) {
    const Vec3 us[2] = {b.sun_u, b.moon_u};
    const double rs[2] = {b.sun_r, b.moon_r}, ms[2] = {kSunMass, kMoonMass};
    double coef[kThird_body_sixCoefs];
    third_body_six_coefs(k.e, fr.n, fr.eta, k.i, k.argp, coef);
    for (int j = 0; j < 2; ++j) {
      double A, B, C;
      direction_cosines(pf, us[j], A, B, C);
      const double ar = fr.a / rs[j];
      const double C2 = ms[j] * ar * ar * ar * fr.n;
      third_body_six(coef, A, B, C, C2, C2 * ar, six);
    }
  }
  if (!ctx.sdnap) {
    // SGP4XP integrates the epoch class with its functions at e_0, i_0 (SPEC 6.3; a native report is a fresh
    // initialization at its time, abi.inc)
    if (ctx.res_epoch != nullptr) res::resonance_six(ctx.res_epoch, ctx.res_count, t, k, fr.n, fr.eta, ag.si, ag.ci, ctx.theta_g0, six);
  } else {
    // SDN-AP: the class of the current n, its terms at the current e and i
    const int cls = tess::resonance_on() ? res::band_of(fr.n) : 0;
    if (cls != 0) {
      res::ResCoef terms[29];
      const int count = res::current_terms(cls, k.e, ag.si, ag.ci, !ctx.sdnap, ctx.res_taylor, ctx.resonance, ctx.e0, terms);
      res::resonance_six(terms, count, t, k, fr.n, fr.eta, ag.si, ag.ci, ctx.theta_g0, six);
    }
  }
  if (ctx.shallow != nullptr) {
    // SDN-AP 2d.5, following the current elements: F G to first order about the epoch e and i, and each (k, m)
    // weighted by the current distance from commensurability (tess::shallow_weight), so the term set does not depend
    // on the epoch it was taken at (a set re-epoched by a map keeps the same rates)
    res::ResCoef terms[tess::kShallowMax];
    const double de = k.e - ctx.e0, di = k.i - ctx.i0;
    const tess::SecularRates sr = tess::secular_rates(fr.n, k.e, k.i);
    int last_k = 0, last_m = 0;
    double wgt = 1.0;
    for (int j = 0; j < ctx.shallow_count; ++j) {
      terms[j] = tess::expand(ctx.shallow[j]);
      if (terms[j].k != last_k || terms[j].m != last_m) {
        last_k = terms[j].k;
        last_m = terms[j].m;
        wgt = tess::shallow_weight(sr, last_k, last_m, fr.n);
      }
      terms[j].fg = (terms[j].fg + terms[j].fdg * de + terms[j].dfg * di) * wgt;
      terms[j].fdg *= wgt;
      terms[j].dfg *= wgt;
    }
    res::resonance_six(terms, ctx.shallow_count, t, k, fr.n, fr.eta, ag.si, ag.ci, ctx.theta_g0, six);
  }
  if (ctx.zt != nullptr) tess::zonal_six(ctx.zt, ctx.zt_degree, k, fr.n, fr.eta, ag.si, ag.ci, six);
  six_to_equinoctial(ag, six, out);
  out[kLam] += fr.n;  // the set carries lambda-dot - n
  if (ctx.long_period) {
    // Instantaneous geometry: the satellite from the equinoctial Kepler
    // equation lambda = F + ag cos F - af sin F (Halley iteration, at most 25 steps).
    const double lam = y[kLam];
    double F = lam;
    for (int it = 0; it < 25; ++it) {
      double sF, cF;
      fm::sincos(F, sF, cF);
      const double fv = F + y[kAg] * cF - y[kAf] * sF - lam;
      const double f1 = 1.0 - y[kAg] * sF - y[kAf] * cF;
      const double f2 = -y[kAg] * cF + y[kAf] * sF;
      const double dF = -fv / (f1 - 0.5 * fv * f2 / f1);
      F += dF;
      if (std::fabs(dF) < 1e-14) break;
    }
    Vec3 r, v;
    double roa;
    state_at_F(y, fr, F, r, v, roa);
    const Vec3 d = third_body_accel(r, b.sun_u, b.sun_r, kSunMass) +
                   third_body_accel(r, b.moon_u, b.moon_r, kMoonMass);
    double tb[6];
    gauss(y, fr, r, v, d, tb);
    for (int j = 0; j < 6; ++j) out[j] += tb[j];
  }
  if (ctx.agom > 0.0) srp_rates(y, fr, k, pf, ctx.agom, b, out);
  if (ctx.sdnap) {
    if (ctx.bterm != 0.0) sdnap_drag_rates(y, fr, k, ag, ctx.bterm, ctx.theta_g0 + kOmegaE * t, ctx.d50_epoch + t / kMinutesPerDay, out);
    tau_rates(ctx.tau0, ctx.tauc, ctx.taus, ctx.arc_end, ctx.lowering, ctx.tau_held, t, fr, ag, out);
  } else if (ctx.bterm > 0.0) {
    drag_rates(y, fr, k, ag, ctx.bterm, b, ctx.d50_epoch + t / kMinutesPerDay, out);
  }
  if (ctx.sdnap)
    for (int j = 0; j < 6; ++j)
      if (!std::isfinite(out[j])) return false;
  return true;
}

// --- SPEC 9: the grid ---------------------------------------------------------

struct Node {
  double t;        ///< minutes from epoch
  double y[6];
  double f[6];
  int32_t index;   ///< signed node index (negative: backward)
  int32_t mode;    ///< 0 normal, 1 30-minute fallback for the remaining nodes
};

constexpr double kKernelStepDays = 0.125;  ///< the density kernel's time step (density_kernel.inc), from 0 UT
/// One third-order Runge-Kutta step of length h from node `a` (SPEC 9): 0, or kStageFailed when a stage's rates fail
/// (the step's fallbacks apply), kNodeFailed when the new node's own rates do (SPEC 8.4: the node cannot be used).
constexpr int kStageFailed = 1, kNodeFailed = 2;
inline int rk3(const RateContext& ctx, const Node& a, double h, Node& out) {
  double y2[6], y4[6], k2[6], k4[6];
  for (int j = 0; j < 6; ++j) y2[j] = a.y[j] + (3.0 / 8.0) * h * a.f[j];
  if (!rates(ctx, a.t + (3.0 / 8.0) * h, y2, k2)) return kStageFailed;
  if (!ctx.sdnap) {
    // k3 (SPEC 9): its rates do not enter the update, but its state is tested like the others
    double y3[6];
    for (int j = 0; j < 6; ++j) y3[j] = a.y[j] + (9.0 / 16.0) * h * k2[j];
    if (state_test(ctx, y3) != 0) return kStageFailed;
  }
  for (int j = 0; j < 6; ++j) y4[j] = a.y[j] + h * (-(125.0 / 672.0) * a.f[j] + (325.0 / 336.0) * k2[j]);
  if (!rates(ctx, a.t + (25.0 / 32.0) * h, y4, k4)) return kStageFailed;
  for (int j = 0; j < 6; ++j)
    out.y[j] = a.y[j] + h * ((37.0 / 225.0) * a.f[j] + (44.0 / 117.0) * k2[j] + (448.0 / 975.0) * k4[j]);
  out.t = a.t + h;
  return rates(ctx, out.t, out.y, out.f) ? 0 : kNodeFailed;
}

/// The node after `a` in direction dir (+1, -1), with the SPEC 9 fallbacks.
inline bool next_node(const RateContext& ctx, const Node& a, int dir, Node& out) {
  double h;
  if (a.mode == 1)
    h = 30.0;
  else if (ctx.long_period)
    h = kLongPeriodStep;
  else
    h = 2.0 * kTwoPi / a.y[kN] / (ctx.sdnap ? tess::step_divisor() : 1);
  out.mode = a.mode;
  out.index = a.index + dir;
  if (ctx.sdnap && ctx.drag_nodes) {
    // SDN-AP in the drag regime: a node at every density-kernel time (3-hourly in UT, 2a.4), where the drag rates have
    // their kinks (the kernel linear in time between its grids) and, at 0 UT, the daily space weather its jump, so that
    // no step integrates across one (a set re-epoched by a map then shares those nodes)
    const double here = (ctx.d50_epoch + a.t / kMinutesPerDay) / kKernelStepDays;
    const double next = dir > 0 ? std::floor(here + 1e-9) + 1.0 : std::ceil(here - 1e-9) - 1.0;
    const double to = std::fabs(next - here) * kKernelStepDays * kMinutesPerDay;
    if (to > 1e-6 && to < h) h = to;
  }
  if (ctx.sdnap) {
    // and at the end of the fit arc, where the empirical terms' g(t) turns from 1 to its decay
    if (ctx.tau0 != 0.0 || ctx.tauc != 0.0 || ctx.taus != 0.0) {
      const double te = dir * (ctx.arc_end - a.t);
      if (te > 1e-6 && te < h) h = te;
    }
  }
  // a failed stage retries the step once at 90 minutes; a node whose own rates fail, or a step that still fails, ends
  // the grid: every time after the last good node is refused (SPEC 8.4, 9). 9.9 has no further fallback; SDN-AP keeps
  // 30-minute steps for the remaining nodes after a failed retry
  int st = rk3(ctx, a, dir * h, out);
  if (st != kStageFailed) return st == 0;
  if (h > 90.0) {
    h = 90.0;
    st = rk3(ctx, a, dir * h, out);
    if (st != kStageFailed) return st == 0;
  }
  if (ctx.sdnap && h > 30.0) {
    out.mode = 1;
    return rk3(ctx, a, dir * 30.0, out) == 0;
  }
  return false;
}

/// Cubic Hermite interpolation between nodes a and b (SPEC 9).
inline void hermite(const Node& a, const Node& b, double t, double* y) {
  const double h = b.t - a.t;
  const double q = (t - a.t) / h;
  if (q == 0.0) {
    for (int j = 0; j < 6; ++j) y[j] = a.y[j];
    return;
  }
  const double h00 = (1.0 + 2.0 * q) * (1.0 - q) * (1.0 - q);
  const double h10 = q * (1.0 - q) * (1.0 - q);
  const double h01 = q * q * (3.0 - 2.0 * q);
  const double h11 = q * q * (q - 1.0);
  for (int j = 0; j < 6; ++j) y[j] = h00 * a.y[j] + h10 * h * a.f[j] + h01 * b.y[j] + h11 * h * b.f[j];
  if (!(y[kN] > 0.0))
    for (int j = 0; j < 6; ++j) y[j] = (1.0 - q) * a.y[j] + q * b.y[j];
}

// --- SPEC 8: osculating output ------------------------------------------------

/// TEME position (km) and velocity (km/s) of the mean equinoctial state y.
/// `shared`, when given, holds the Sun and Moon at the output time (a batch at
/// one time evaluates them once for every object).
inline int32_t output(const RateContext& ctx, double t, const double* ym, double r_out[3], double v_out[3],
                      const Bodies* shared) {
  if (!(ym[kN] > 0.0)) return kPropMeanMotion;
  double y[6] = {ym[0], ym[1], ym[2], ym[3], ym[4], ym[5]};
  double Ewarm = std::numeric_limits<double>::quiet_NaN();
  if (!ctx.long_period || ctx.agom > 0.0) {
    const Kepler km = kepler_of(ym);
    if (!(km.e < 1.0)) return kPropEccentricity;
    double Em = km.m + km.e * std::sin(km.m);
    for (int it = 0; it < 30; ++it) {
      double sEm, cEm;
      fm::sincos(Em, sEm, cEm);
      const double dE = (Em - km.e * sEm - km.m) / (1.0 - km.e * cEm);
      Em -= dE;
      if (std::fabs(dE) < 1e-15) break;
    }
    const Bodies b = shared != nullptr ? *shared : bodies_at(ctx.d50_epoch + t / kMinutesPerDay);
    const double n = ym[kN], etam = std::sqrt(1.0 - km.e * km.e);
    const AngleTrig agm = angle_trig(km);
    const Perifocal pfm = perifocal_of(agm);
    if (!ctx.long_period) {
      // SPEC 5.4: the Sun and Moon output-time corrections, added to the
      // equinoctial elements before the short-period step.
      const Vec3 us[2] = {b.sun_u, b.moon_u};
      const double rs[2] = {b.sun_r, b.moon_r}, ms[2] = {kSunMass, kMoonMass};
      double six[6] = {0, 0, 0, 0, 0, 0};
      double coef[kOutput_sixCoefs];
      output_six_coefs(km.e, n, etam, km.i, km.argp, Em, coef);
      for (int j = 0; j < 2; ++j) {
        double A, B, C;
        direction_cosines(pfm, us[j], A, B, C);
        const double ar = km.a / rs[j];
        const double C2 = ms[j] * ar * ar * ar * n;
        output_six(coef, A, B, C, C2, C2 * ar, six);
      }
      double d[6];
      six_to_equinoctial(agm, six, d);
      for (int j = 0; j < 6; ++j) y[j] += d[j];
    }
    if (ctx.agom > 0.0) {
      // SPEC 4: the output-time SRP corrections, after those of 5.4.
      double A, B, C;
      direction_cosines(pfm, b.sun_u, A, B, C);
      const double rs_au = b.sun_r * kRe / kAu;
      const double Fs = kSrpPressure * ctx.agom * 3600.0 / (1000.0 * kRe * rs_au * rs_au);
      double ds[6];
      srp_output(km.e, etam, Em, km.argp, km.node, km.i, km.a, n, A, B, C, Fs, ds);
      for (int j = 0; j < 6; ++j) y[j] += ds[j];
    }
    if (!(y[kN] > 0.0)) return kPropMeanMotion;
    Ewarm = Em;
  }
  if (ctx.mdaily != nullptr || ctx.sp != nullptr || ctx.near != nullptr) {
    // SDN-AP 2d: the tesseral m-daily short-periodics, first order at the mean elements
    const Kepler km = kepler_of(ym);
    if (km.e < 1.0) {
      const AngleTrig agm = angle_trig(km);
      double six[6] = {0, 0, 0, 0, 0, 0};
      if (ctx.mdaily != nullptr)
        tess::mdaily_six(ctx.mdaily, ctx.mdaily_degree, t, km, ym[kN], std::sqrt(1.0 - km.e * km.e), agm.si, agm.ci,
                         ctx.theta_g0, six);
      if (ctx.sp != nullptr)
        tess::sp_six(ctx.sp, ctx.sp_degree, ctx.sp_mask, t, km, ym[kN], std::sqrt(1.0 - km.e * km.e), agm.si, agm.ci,
                     ctx.theta_g0, six);
      if (ctx.near != nullptr)
        tess::near_six(ctx.near, ctx.near_count, t, km, ym[kN], std::sqrt(1.0 - km.e * km.e), agm.si, agm.ci, ctx.theta_g0, six);
      double d[6];
      six_to_equinoctial(agm, six, d);
      for (int j = 0; j < 6; ++j) y[j] += d[j];
    }
  }
  const Kepler k = kepler_of(y);
  if (!(k.e < 1.0)) return kPropEccentricity;
  if (!std::isfinite(y[kLam]) || std::fabs(y[kLam]) > 1e10) return kPropEccentricity;
  const double e = k.e;
  // Kepler's equation M = E - e sin E (Newton, to machine precision), started
  // from the mean solution when the Sun and Moon corrections were applied.
  double E = k.m + e * std::sin(k.m);
  if (Ewarm == Ewarm) {
    double dm = k.m - (Ewarm - e * std::sin(Ewarm));
    dm -= kTwoPi * std::floor((dm + kPi) / kTwoPi);
    E = Ewarm + dm;
  }
  for (int it = 0; it < 30; ++it) {
    double sEi, cEi;
    fm::sincos(E, sEi, cEi);
    const double dE = (E - e * sEi - k.m) / (1.0 - e * cEi);
    E -= dE;
    if (std::fabs(dE) < 1e-15) break;
  }
  const double eta = std::sqrt(1.0 - e * e);
  double sE, cE;
  fm::sincos(E, sE, cE);
  const double ome = 1.0 - e * cE;
  const double snu = eta * sE / ome, cnu = (cE - e) / ome;
  const double nu = std::atan2(snu, cnu);
  const double a = k.a;
  const double p = a * eta * eta;
  const double r = p / (1.0 + e * cnu);
  const double th = std::cos(k.i), si = std::sin(k.i);
  const double th2 = th * th;
  const double u = k.argp + nu;
  const double c = kJ2 / (4.0 * p), d = kJ2 / (4.0 * p * p);
  // Q = (nu - M) + e sin nu, nu - M the equation of the center in (-pi, pi].
  double eoc = nu - k.m;
  eoc -= kTwoPi * std::floor((eoc + kPi) / kTwoPi);
  const double Qw = eoc + e * snu;
  const double n_a = kKe / (a * std::sqrt(a));
  double c2w, s2w;
  fm::sincos(2.0 * k.argp, s2w, c2w);
  const double c2n = cnu * cnu - snu * snu, s2n = 2.0 * snu * cnu;
  const double c3n = c2n * cnu - s2n * snu, s3n = s2n * cnu + c2n * snu;
  const double c2u = c2w * c2n - s2w * s2n, s2u = s2w * c2n + c2w * s2n;
  const double cw1 = c2w * cnu - s2w * snu, sw1 = s2w * cnu + c2w * snu;
  const double cw3 = c2w * c3n - s2w * s3n, sw3 = s2w * c3n + c2w * s3n;
  const double dr = c * ((1.0 - th2) * c2u - (e * cnu / (1.0 + eta) + 2.0 * r / (a * eta) + 1.0) * (3.0 * th2 - 1.0));
  const double di = d * th * si * (3.0 * c2u + e * (3.0 * cw1 + cw3));
  const double dnode = d * th * (3.0 * s2u - 6.0 * Qw + e * (3.0 * sw1 + sw3));
  const double du = d * ((1.0 - eta) * (3.0 * th2 - 1.0) * snu * (e / (1.0 + eta) + cnu) - 3.0 * (1.0 - 5.0 * th2) * Qw +
                         0.5 * (1.0 - 7.0 * th2) * s2u +
                         e * ((2.0 - 5.0 * th2) * sw1 - th2 * sw3));
  const double aor = a / r;
  const double rdot0 = n_a * a * e * snu / eta;
  const double rfdot0 = n_a * a * a * eta / r;
  const double drdot = eta * (-2.0 * c * n_a * aor * aor * (1.0 - th2) * s2u +
                              c * n_a * e * snu * (3.0 * th2 - 1.0) * (aor * aor / (1.0 + eta) + 1.0 / (eta * eta * eta)));
  const double drfdot = eta * (-n_a * aor * aor * dr +
                               n_a * (a * a / r) * d * si * si * (3.0 * c2u + e * (3.0 * cw1 + cw3)));
  const double rk = r + dr, uk = u + du, nodek = k.node + dnode, ik = k.i + di;
  const double rdotk = rdot0 + drdot, rfdotk = rfdot0 + drfdot;
  double sinsu, cossu, snod, cnod, sini, cosi;
  fm::sincos(uk, sinsu, cossu);
  fm::sincos(nodek, snod, cnod);
  fm::sincos(ik, sini, cosi);
  const double xmx = -snod * cosi, xmy = cnod * cosi;
  const double ux = xmx * sinsu + cnod * cossu, uy = xmy * sinsu + snod * cossu, uz = sini * sinsu;
  const double vx = xmx * cossu - cnod * sinsu, vy = xmy * cossu - snod * sinsu, vz = sini * cossu;
  r_out[0] = rk * ux * kRe;
  r_out[1] = rk * uy * kRe;
  r_out[2] = rk * uz * kRe;
  const double vs = kRe / 60.0;
  v_out[0] = (rdotk * ux + rfdotk * vx) * vs;
  v_out[1] = (rdotk * uy + rfdotk * vy) * vs;
  v_out[2] = (rdotk * uz + rfdotk * vz) * vs;
  // a mean perigee below the surface: SDN-AP refuses the state; SGP4XP serves it as the library does (SPEC 8.4: the
  // 150 km perigee set is served to its first node with the native elements there already refused)
  if (ctx.sdnap && a * (1.0 - e) < 1.0) return kPropDecayed;
  return kPropOk;
}

// --- Per-object record and node cache --------------------------------------------

/// Sparse checkpoints per direction and the stride between them is chosen at
/// ingest so that kSparse checkpoints span about 8 days; the window holds the
/// latest bracket of each direction. 96 + 2 * 2 * 112 + 2 * kSparse * 112 bytes.
constexpr int kSparse = 12;

struct XpSat {
  uint32_t norad;
  int32_t init_error;
  int32_t lock;
  int32_t stride;
  RateContext ctx;
  double epoch_jd_whole, epoch_jd_frac;
  Node epoch;
  Node window[2][2];          ///< [direction][0: lower, 1: upper] latest bracket
  int32_t window_valid[2];
  int32_t sparse_count[2];    ///< checkpoints held per direction (index stride * (k + 1))
  Node sparse[2][kSparse];
};

inline int32_t xp_init(const Elements& e, XpSat& s) {
  s = XpSat{};
  s.norad = e.norad;
  s.epoch_jd_whole = e.epoch_jd_whole;
  s.epoch_jd_frac = e.epoch_jd_frac;
  s.ctx.d50_epoch = (e.epoch_jd_whole - kJd1950) + e.epoch_jd_frac;
  s.ctx.bterm = e.bterm;
  s.ctx.agom = e.agom;
  if (!(e.no_kozai > 0.0) || !(e.ecco >= 0.0) || !(e.ecco < 1.0) || !std::isfinite(e.inclo)) {
    s.init_error = kPropRefused;
    return kPropRefused;
  }
  const double n0 = e.no_kozai;  // Brouwer (SPEC 1.1)
  s.ctx.long_period = (kTwoPi / n0) >= kLongPeriodMinutes ? 1 : 0;
  const int8_t res = static_cast<int8_t>(res::band_of(n0));  // the epoch class (SPEC 6 bands)
  s.ctx.resonance = res;
  s.ctx.e0 = e.ecco;
  s.ctx.i0 = e.inclo;
  s.ctx.theta_g0 = gsto_afspc(s.ctx.d50_epoch);
  if (e.theory == kTheorySdnAp) {
    const double accel = 3600.0 / (1000.0 * kRe);  // m/s^2 -> ER/min^2
    s.ctx.sdnap = 1;
    {
      // the drag regime: perigee below the density's 2500 km top, B_eff set
      const double a_er = std::pow(kKe / n0, kX2o3);
      s.ctx.drag_nodes = e.bterm != 0.0 && (a_er * (1.0 - e.ecco) - 1.0) * kRe < 2500.0 ? 1 : 0;
    }
    s.ctx.tau0 = e.tau0 * accel;
    s.ctx.tauc = e.tauc * accel;
    s.ctx.taus = e.taus * accel;
    s.ctx.arc_end = e.arc_end_min;
    s.ctx.lowering = (e.flags & kFlagLowering) ? 1 : 0;
    s.ctx.tau_held = (e.flags & kFlagTauHeld) ? 1 : 0;
    const int md = tess::mdaily_degree() > 16 ? 16 : tess::mdaily_degree() & ~1;
    if (md >= 2) {
      double scratch[2 * 72];
      const int count = tess::mdaily_terms(md, e.inclo, scratch);
      float* kept = static_cast<float*>(std::malloc(2 * count * sizeof(float)));
      if (kept == nullptr) {
        s.init_error = kPropRefused;
        return kPropRefused;
      }
      for (int q = 0; q < 2 * count; ++q) kept[q] = static_cast<float>(scratch[q]);
      s.ctx.mdaily = kept;
      s.ctx.mdaily_degree = md;
    }
    const int zd = tess::zonal_degree() > 70 ? 70 : tess::zonal_degree();
    if (zd >= 6) {
      const int count = tess::zonal_count(zd);
      float* kept = static_cast<float*>(std::malloc(4 * count * sizeof(float)));
      if (kept == nullptr) {
        s.init_error = kPropRefused;
        return kPropRefused;
      }
      tess::zonal_visit_terms(zd, e.inclo, e.ecco, kept);
      s.ctx.zt = kept;
      s.ctx.zt_degree = zd;
    }
    const int spd = tess::sp_degree() > 16 ? 16 : tess::sp_degree();
    if (spd >= 2) {
      const int mask = tess::sp_mask();
      const int count = tess::sp_count(spd, mask);
      float* kept = static_cast<float*>(std::malloc(4 * (count > 0 ? count : 1) * sizeof(float)));
      if (kept == nullptr) {
        s.init_error = kPropRefused;
        return kPropRefused;
      }
      tess::sp_terms(spd, mask, n0, e.inclo, e.ecco, kept);
      s.ctx.sp = kept;
      s.ctx.sp_degree = static_cast<int16_t>(spd);
      s.ctx.sp_mask = static_cast<int16_t>(mask);
    }
    if (res == 0 && !s.ctx.long_period) {
      tess::ShallowTerms scratch, near_scratch;
      const int count = tess::shallow_terms(n0, e.ecco, e.inclo, scratch, &near_scratch);
      if (near_scratch.count > 0) {
        tess::ShallowCoef* kept = static_cast<tess::ShallowCoef*>(std::malloc(near_scratch.count * sizeof(tess::ShallowCoef)));
        if (kept == nullptr) {
          s.init_error = kPropRefused;
          return kPropRefused;
        }
        for (int j = 0; j < near_scratch.count; ++j)
          kept[j] = tess::ShallowCoef{near_scratch.c[j].l, near_scratch.c[j].m, near_scratch.c[j].p, near_scratch.c[j].k,
                                      static_cast<float>(near_scratch.c[j].fg), static_cast<float>(near_scratch.c[j].fdg),
                                      static_cast<float>(near_scratch.c[j].dfg)};
        s.ctx.near = kept;
        s.ctx.near_count = near_scratch.count;
      }
      if (count > 0) {
        tess::ShallowCoef* kept = static_cast<tess::ShallowCoef*>(std::malloc(count * sizeof(tess::ShallowCoef)));
        if (kept == nullptr) {
          s.init_error = kPropRefused;
          return kPropRefused;
        }
        for (int j = 0; j < count; ++j)
          kept[j] = tess::ShallowCoef{scratch.c[j].l, scratch.c[j].m, scratch.c[j].p, scratch.c[j].k, static_cast<float>(scratch.c[j].fg),
                                      static_cast<float>(scratch.c[j].fdg), static_cast<float>(scratch.c[j].dfg)};
        s.ctx.shallow = kept;
        s.ctx.shallow_count = count;
      }
    }
  }
  if (res != 0 && e.theory != kTheorySdnAp) {
    // SGP4XP: the epoch class's terms at e_0, i_0 (SPEC 6.3), the library's functions (6.4)
    res::ResCoef* rc = static_cast<res::ResCoef*>(std::malloc(res::class_terms(res).count * sizeof(res::ResCoef)));
    if (rc == nullptr) {
      s.init_error = kPropRefused;
      return kPropRefused;
    }
    s.ctx.res_count = res::current_terms(res, e.ecco, std::sin(e.inclo), std::cos(e.inclo), true, nullptr, 0, 0.0, rc);
    s.ctx.res_epoch = rc;
  }
  if (res != 0 && e.theory == kTheorySdnAp && e.ecco >= res::kSeriesE && e.ecco + 1e-3 < 1.0) {
    // SDN-AP above the polynomial's range: the epoch class's G about e_0 (the terms follow the current e, 6.3)
    const res::TermSet ts = res::class_terms(res);
    res::GTaylor* g = static_cast<res::GTaylor*>(std::malloc(ts.count * sizeof(res::GTaylor)));
    if (g == nullptr) {
      s.init_error = kPropRefused;
      return kPropRefused;
    }
    for (int j = 0; j < ts.count; ++j) g[j] = res::g_taylor(ts.t[j].l, ts.t[j].p, ts.t[j].q, e.ecco);
    s.ctx.res_taylor = g;
  }
  equinoctial_of(n0, e.ecco, e.inclo, e.nodeo, e.argpo, e.mo, s.epoch.y);
  s.epoch.t = 0.0;
  s.epoch.index = 0;
  s.epoch.mode = 0;
  if (!rates(s.ctx, 0.0, s.epoch.y, s.epoch.f)) {
    s.init_error = kPropRefused;
    return kPropRefused;
  }
  const double step = s.ctx.long_period ? kLongPeriodStep : 2.0 * kTwoPi / n0;
  const double span = 8.0 * kMinutesPerDay;
  int32_t stride = static_cast<int32_t>(std::ceil(span / (kSparse * step)));
  s.stride = stride < 1 ? 1 : stride;
  return kPropOk;
}

/// Frees what xp_init allocated (the resonance expansion, the SDN-AP tables); the XpSat stays usable
/// for nothing but a new xp_init.
inline void xp_release(XpSat& s) {
  std::free(const_cast<res::ResCoef*>(s.ctx.res_epoch));
  s.ctx.res_epoch = nullptr;
  s.ctx.res_count = 0;
  std::free(const_cast<res::GTaylor*>(s.ctx.res_taylor));
  s.ctx.res_taylor = nullptr;
  std::free(const_cast<tess::ShallowCoef*>(s.ctx.shallow));
  std::free(const_cast<tess::ShallowCoef*>(s.ctx.near));
  s.ctx.near = nullptr;
  s.ctx.near_count = 0;
  s.ctx.shallow = nullptr;
  s.ctx.shallow_count = 0;
  std::free(const_cast<float*>(s.ctx.mdaily));
  s.ctx.mdaily = nullptr;
  s.ctx.mdaily_degree = 0;
  std::free(const_cast<float*>(s.ctx.zt));
  s.ctx.zt = nullptr;
  s.ctx.zt_degree = 0;
  std::free(const_cast<float*>(s.ctx.sp));
  s.ctx.sp = nullptr;
  s.ctx.sp_degree = 0;
}

inline void lock(int32_t* word) {
  int32_t expected = 0;
  while (!__atomic_compare_exchange_n(word, &expected, 1, false, __ATOMIC_ACQUIRE, __ATOMIC_RELAXED)) expected = 0;
}
inline void unlock(int32_t* word) { __atomic_store_n(word, 0, __ATOMIC_RELEASE); }

/// The bracketing nodes of t (lower, upper in the direction of t). Lazily
/// fills the checkpoints; any order of requests gives the same nodes.
inline bool bracket(XpSat& s, double t, Node& lo, Node& hi) {
  const int dir = t >= 0.0 ? 1 : -1;
  const int di = dir > 0 ? 0 : 1;
  const double at = dir * t;
  auto beyond = [&](const Node& n) { return dir * n.t > at; };
  // window hit
  if (s.window_valid[di] && !beyond(s.window[di][0]) && beyond(s.window[di][1])) {
    lo = s.window[di][0];
    hi = s.window[di][1];
    return true;
  }
  // start: the furthest known node at or before t
  Node cur = s.epoch;
  for (int k = 0; k < s.sparse_count[di]; ++k) {
    if (beyond(s.sparse[di][k])) break;
    cur = s.sparse[di][k];
  }
  if (s.window_valid[di] && !beyond(s.window[di][0]) && dir * s.window[di][0].index > dir * cur.index)
    cur = s.window[di][0];
  Node nxt;
  for (;;) {
    if (!next_node(s.ctx, cur, dir, nxt)) return false;
    const int32_t idx = dir * nxt.index;
    if (idx % s.stride == 0) {
      const int32_t slot = idx / s.stride - 1;
      if (slot == s.sparse_count[di] && slot < kSparse) {
        s.sparse[di][slot] = nxt;
        s.sparse_count[di] = slot + 1;
      }
    }
    if (beyond(nxt)) break;
    cur = nxt;
  }
  s.window[di][0] = cur;
  s.window[di][1] = nxt;
  s.window_valid[di] = 1;
  lo = cur;
  hi = nxt;
  return true;
}

/// Mean equinoctial state at t (minutes from epoch).
inline bool mean_at(XpSat& s, double t, double* y) {
  if (t == 0.0) {
    for (int j = 0; j < 6; ++j) y[j] = s.epoch.y[j];
    return true;
  }
  Node lo, hi;
  lock(&s.lock);
  const bool ok = bracket(s, t, lo, hi);
  unlock(&s.lock);
  if (!ok) return false;
  hermite(lo, hi, t, y);
  return true;
}

/// SPEC 1.5 (amendment 6): the rates of a native-element report at t, a fresh initialization at t: a set with epoch t
/// made from the mean elements y there (same B and AGOM, full precision), initialized (its resonance class and F, G
/// from those elements, theta_G the 1.2 value at t), its epoch rates. SDN-AP reports its own rate function.
inline bool report_rates(const XpSat& s, double t, const double* y, double* f) {
  if (s.ctx.sdnap) return rates(s.ctx, t, y, f);
  if (t == 0.0) {  // the set's own epoch
    for (int j = 0; j < 6; ++j) f[j] = s.epoch.f[j];
    return true;
  }
  Elements e{};
  const double frac = s.epoch_jd_frac + t / kMinutesPerDay, whole = std::floor(frac);
  e.epoch_jd_whole = s.epoch_jd_whole + whole;
  e.epoch_jd_frac = frac - whole;
  e.theory = kTheorySgp4Xp;
  e.norad = s.norad;
  e.bterm = s.ctx.bterm;
  e.agom = s.ctx.agom;
  const Kepler k = kepler_of(y);
  if (k.a * (1.0 - k.e) < 1.0) return false;  // a later report whose mean perigee is below the surface: code 2 (8.4)
  e.no_kozai = y[kN];
  e.ecco = k.e;
  e.inclo = k.i;
  e.nodeo = k.node;
  e.argpo = k.argp;
  e.mo = k.m;
  XpSat* x = static_cast<XpSat*>(std::calloc(1, sizeof(XpSat)));
  if (x == nullptr) return false;
  const bool ok = xp_init(e, *x) == kPropOk;
  if (ok)
    for (int j = 0; j < 6; ++j) f[j] = x->epoch.f[j];
  xp_release(*x);
  std::free(x);
  return ok;
}

inline int32_t xp_propagate(XpSat& s, double t, double r[3], double v[3], const Bodies* shared = nullptr) {
  if (s.init_error != 0) return kPropRefused;
  double y[6];
  if (!mean_at(s, t, y)) return kPropMeanMotion;
  return output(s.ctx, t, y, r, v, shared);
}

}  // namespace xpt
}  // namespace sdnap
