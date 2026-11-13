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
//            instantaneous point-mass Gauss equations.
//            AP reads its own Sun and Moon (SPEC 16.17,
//            ap_bodies.inc), never bodies_at or sun_at
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

#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif

namespace sdnap {
namespace frames {
inline void teme_drift(double epoch_whole, double epoch_frac, double t_minutes, double r[3], double v[3]);  // gcrf.inc
inline bool teme_drift_matrix(double epoch_whole, double epoch_frac, double t_minutes, double R[3][3]);
inline void apply_drift(const double R[3][3], double r[3], double v[3]);
inline int utc_to_tt(double whole, double frac, double& tt1, double& tt2);
}  // namespace frames
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

inline double fast_wrap(double x) {
  constexpr double kInvTwoPi = 1.0 / kTwoPi;
  double r = x - kTwoPi * std::floor(x * kInvTwoPi);
  if (r >= kTwoPi) r -= kTwoPi;
  if (r < 0.0) r += kTwoPi;
  return r;
}

inline double fast_a_from_n(double n) {
  const double x = kMu / (n * n);
  uint64_t u = 0;
  std::memcpy(&u, &x, 8);
  u = u / 3 + 0x2a9f7893e46d0000ULL;
  double a = 0.0;
  std::memcpy(&a, &u, 8);
  double a3 = a * a * a;
  a = a * (a3 + 2.0 * x) / (2.0 * a3 + x);
  a3 = a * a * a;
  a = a * (a3 + 2.0 * x) / (2.0 * a3 + x);
  return a;
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

inline void sun_at(double d50, Vec3& sun_u, double& sun_r, Cx* pm_out = nullptr, double* ce_out = nullptr,
                   double* se_out = nullptr) {
  const double T = (d50 - 18263.5) / 36525.0;
  const double ms = (357.52772333333 + 35999.05034 * T - 1.6027777777777777e-4 * T * T -
                     3.3333333333333e-6 * T * T * T) * kDeg;
  const double e = 0.01670832 - 4.2229e-5 * T - 1.26e-7 * T * T;
  const double varpi = (282.938346111111 + 1.71945722222222 * T + 4.62777777777776e-4 * T * T +
                        3.3333333333333e-6 * T * T * T) * kDeg;
  const double eps = (23.4392635861111 - 0.0130253805555555 * T - 1.30555555555555e-7 * T * T +
                      5.02777777777776e-7 * T * T * T) * kDeg;
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
  sun_u = {cl, sl * ce, sl * se};
  const double roa = 1.0 + e2 / 2.0 - (e - 3.0 * e3 / 8.0 + 5.0 * e5 / 192.0) * pm[1].c - (e2 / 2.0 - e4 / 3.0) * pm[2].c -
                     (3.0 * e3 / 8.0 - 45.0 * e5 / 128.0) * pm[3].c - (e4 / 3.0) * pm[4].c - (125.0 * e5 / 384.0) * pm[5].c;
  sun_r = kAu * roa / kRe;
  if (pm_out != nullptr) {
    pm_out[1] = pm[1];
    pm_out[2] = pm[2];
  }
  if (ce_out != nullptr) *ce_out = ce;
  if (se_out != nullptr) *se_out = se;
}

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

#include "ap_bodies.inc"

/// AP's Sun and Moon at any time (SPEC 16.17): the quintic through ap_bodies_at at the six nodes about it, the nodes on
/// an absolute grid every kApBodiesNodeHours of UTC (node k at k kApBodiesNodeHours hours from 1950 January 0.0), the
/// unit vectors renormalized to first order. Every node is a function of its time alone. Each thread keeps the nodes it
/// has read in a store of kApBodiesStoreSlots slots, by node index (85 days at 8 h), and the six of its last read in a
/// window: no set fills or owns a node, a node is never shared between threads (so no race), and every set and every
/// thread reads the same numbers in any order.
inline constexpr double kApBodiesNodeHours = 8.0;
inline constexpr int kApBodiesStoreSlots = 256;
struct ApBodiesNode {
  int64_t key = std::numeric_limits<int64_t>::min();  // the node index held, or none
  Bodies b{};
};
inline thread_local ApBodiesNode* g_ap_bodies_store = nullptr;
/// The thread's node store, made on first use or ahead (pool::warm_thread: a pool thread makes its caches before any
/// batch, stack #487).
inline void ap_bodies_store_make() {
  if (g_ap_bodies_store == nullptr) g_ap_bodies_store = new ApBodiesNode[kApBodiesStoreSlots];
}
inline const Bodies& ap_bodies_node(int64_t k) {
  if (__builtin_expect(g_ap_bodies_store == nullptr, 0)) ap_bodies_store_make();
  ApBodiesNode& s = g_ap_bodies_store[static_cast<uint64_t>(k) & (kApBodiesStoreSlots - 1)];
  if (s.key != k) {
    s.b = ap_bodies_at(static_cast<double>(k) * (kApBodiesNodeHours / 24.0));
    s.key = k;
  }
  return s.b;
}
struct alignas(16) BodiesHourCache {
  alignas(16) Bodies b[6]{};
  int64_t hkey = std::numeric_limits<int64_t>::min();  // the node interval held, or none
};
inline thread_local BodiesHourCache g_bodies_hour_cache{};

inline Bodies bodies_at_ap(double d50) {
  BodiesHourCache& bc = g_bodies_hour_cache;
  const double h = d50 * (24.0 / kApBodiesNodeHours);
  const double hfloor = std::floor(h);
  const int64_t hkey = static_cast<int64_t>(hfloor);
  if (__builtin_expect(bc.hkey != hkey, 0)) {
    if (bc.hkey != std::numeric_limits<int64_t>::min() && hkey == bc.hkey + 1) {
      for (int q = 0; q < 5; ++q) bc.b[q] = bc.b[q + 1];
      bc.b[5] = ap_bodies_node(hkey + 3);
    } else if (bc.hkey != std::numeric_limits<int64_t>::min() && hkey == bc.hkey - 1) {
      for (int q = 5; q > 0; --q) bc.b[q] = bc.b[q - 1];
      bc.b[0] = ap_bodies_node(hkey - 2);
    } else {
      for (int q = 0; q < 6; ++q) bc.b[q] = ap_bodies_node(hkey - 2 + q);
    }
    bc.hkey = hkey;
  }
  // Lagrange weights on the nodes hkey - 2 .. hkey + 3 at hkey + u
  const double u = h - hfloor;
  constexpr double kInvDen[6] = {-1.0 / 120.0, 1.0 / 24.0, -1.0 / 12.0, 1.0 / 12.0, -1.0 / 24.0, 1.0 / 120.0};
  const double d[6] = {u + 2.0, u + 1.0, u, u - 1.0, u - 2.0, u - 3.0};
  double w[6];
  for (int q = 0; q < 6; ++q) {
    double p = kInvDen[q];
    for (int r = 0; r < 6; ++r)
      if (r != q) p *= d[r];
    w[q] = p;
  }
  alignas(16) Bodies out{};
#ifdef __wasm_simd128__
  double* po = &out.sun_u.x;
  for (int c = 0; c < 8; c += 2) {
    v128_t s = wasm_f64x2_mul(wasm_f64x2_splat(w[0]), wasm_v128_load(&bc.b[0].sun_u.x + c));
    for (int q = 1; q < 6; ++q) s = wasm_f64x2_add(s, wasm_f64x2_mul(wasm_f64x2_splat(w[q]), wasm_v128_load(&bc.b[q].sun_u.x + c)));
    wasm_v128_store(po + c, s);
  }
#else
  double* po = &out.sun_u.x;
  for (int c = 0; c < 8; ++c) {
    double s = 0.0;
    for (int q = 0; q < 6; ++q) s += w[q] * (&bc.b[q].sun_u.x)[c];
    po[c] = s;
  }
#endif
  const double sn2 = out.sun_u.x * out.sun_u.x + out.sun_u.y * out.sun_u.y + out.sun_u.z * out.sun_u.z;
  const double sinv = 1.5 - 0.5 * sn2;
  out.sun_u = {out.sun_u.x * sinv, out.sun_u.y * sinv, out.sun_u.z * sinv};
  const double mn2 = out.moon_u.x * out.moon_u.x + out.moon_u.y * out.moon_u.y + out.moon_u.z * out.moon_u.z;
  const double minv = 1.5 - 0.5 * mn2;
  out.moon_u = {out.moon_u.x * minv, out.moon_u.y * minv, out.moon_u.z * minv};
  return out;
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
  double a, n, e2, eta, c, ic;
};

inline Frame frame_of(const double* y) {
  Frame fr{};
  const double chi = y[kChi], psi = y[kPsi];
  fr.c = 1.0 + chi * chi + psi * psi;
  const double ic = 1.0 / fr.c;
  fr.ic = ic;
  fr.f = {(1.0 - chi * chi + psi * psi) * ic, 2.0 * chi * psi * ic, -2.0 * chi * ic};
  fr.g = {2.0 * chi * psi * ic, (1.0 + chi * chi - psi * psi) * ic, 2.0 * psi * ic};
  fr.w = {2.0 * chi * ic, -2.0 * psi * ic, (1.0 - chi * chi - psi * psi) * ic};
  fr.n = y[kN];
  fr.a = std::pow(kKe / fr.n, kX2o3);
  fr.e2 = y[kAf] * y[kAf] + y[kAg] * y[kAg];
  fr.eta = std::sqrt(1.0 - fr.e2);
  return fr;
}

inline Frame frame_of_fast(const double* y) {
  Frame fr{};
  const double chi = y[kChi], psi = y[kPsi];
  fr.c = 1.0 + chi * chi + psi * psi;
  const double ic = 1.0 / fr.c;
  fr.ic = ic;
  fr.f = {(1.0 - chi * chi + psi * psi) * ic, 2.0 * chi * psi * ic, -2.0 * chi * ic};
  fr.g = {2.0 * chi * psi * ic, (1.0 + chi * chi - psi * psi) * ic, 2.0 * psi * ic};
  fr.w = {2.0 * chi * ic, -2.0 * psi * ic, (1.0 - chi * chi - psi * psi) * ic};
  fr.n = y[kN];
  fr.a = fast_a_from_n(fr.n);
  fr.e2 = y[kAf] * y[kAf] + y[kAg] * y[kAg];
  fr.eta = std::sqrt(1.0 - fr.e2);
  return fr;
}

/// Position and velocity (ER, ER/min) at eccentric longitude F.
inline void state_at_scF(const double* y, const Frame& fr, double sf, double cf, Vec3& r, Vec3& v, double& r_over_a) {
  const double k = y[kAf], h = y[kAg];
  const double beta = 1.0 / (1.0 + fr.eta);
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

inline void state_at_F(const double* y, const Frame& fr, double F, Vec3& r, Vec3& v, double& r_over_a) {
  double sf, cf;
  fm::sincos(F, sf, cf);
  state_at_scF(y, fr, sf, cf, r, v, r_over_a);
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

#ifdef __wasm_simd128__
struct F64x2 {
  v128_t v;
  F64x2() = default;
  constexpr F64x2(v128_t x) : v(x) {}
  explicit F64x2(double s) : v(wasm_f64x2_splat(s)) {}
  F64x2(double a, double b) : v(wasm_f64x2_make(a, b)) {}
  double lo() const { return wasm_f64x2_extract_lane(v, 0); }
  double hi() const { return wasm_f64x2_extract_lane(v, 1); }
};
[[gnu::always_inline]] inline F64x2 operator+(F64x2 a, F64x2 b) { return F64x2(wasm_f64x2_add(a.v, b.v)); }
[[gnu::always_inline]] inline F64x2 operator-(F64x2 a, F64x2 b) { return F64x2(wasm_f64x2_sub(a.v, b.v)); }
[[gnu::always_inline]] inline F64x2 operator-(F64x2 a) { return F64x2(wasm_f64x2_neg(a.v)); }
[[gnu::always_inline]] inline F64x2 operator*(F64x2 a, F64x2 b) { return F64x2(wasm_f64x2_mul(a.v, b.v)); }
[[gnu::always_inline]] inline F64x2 operator/(F64x2 a, F64x2 b) { return F64x2(wasm_f64x2_div(a.v, b.v)); }
[[gnu::always_inline]] inline F64x2 operator+(double a, F64x2 b) { return F64x2(a) + b; }
[[gnu::always_inline]] inline F64x2 operator+(F64x2 a, double b) { return a + F64x2(b); }
[[gnu::always_inline]] inline F64x2 operator-(double a, F64x2 b) { return F64x2(a) - b; }
[[gnu::always_inline]] inline F64x2 operator-(F64x2 a, double b) { return a - F64x2(b); }
[[gnu::always_inline]] inline F64x2 operator*(double a, F64x2 b) { return F64x2(a) * b; }
[[gnu::always_inline]] inline F64x2 operator*(F64x2 a, double b) { return a * F64x2(b); }
[[gnu::always_inline]] inline F64x2 f64x2_sqrt(F64x2 a) { return F64x2(wasm_f64x2_sqrt(a.v)); }

#endif

inline void lp_third_body_gauss_ap(const double* y, const Frame& fr, double sf, double cf,
                                   const Bodies& b, double tb[6]) {
  const double k = y[kAf], h = y[kAg], chi = y[kChi], psi = y[kPsi];
  const double roa = 1.0 - k * cf - h * sf;
  const double rn = fr.a * roa;
  const double op_eta = 1.0 + fr.eta;
  const double na = fr.n * fr.a;
#ifdef __wasm_simd128__
  const v128_t vinv = wasm_f64x2_div(wasm_f64x2_splat(1.0), wasm_f64x2_make(op_eta * rn, na * fr.eta));
  const double inv_p1 = wasm_f64x2_extract_lane(vinv, 0);
  const double inv_na_eta = wasm_f64x2_extract_lane(vinv, 1);
  const double beta = inv_p1 * rn;
  const double inv_rn = inv_p1 * op_eta;
#else
  const double beta = 1.0 / op_eta;
  const double inv_rn = 1.0 / rn;
  const double inv_na_eta = 1.0 / (na * fr.eta);
#endif
  const double inv_a = inv_rn * roa;
  const double inv_na = inv_na_eta * fr.eta;
  const double inv_eta = inv_na_eta * na;
  const double inv_hn = inv_na_eta * inv_a;

  const double c_xx = 1.0 - h * h * beta, c_xy = h * k * beta, c_yy = 1.0 - k * k * beta;
  const double X = fr.a * (c_xx * cf + c_xy * sf - k);
  const double Y = fr.a * (c_xy * cf + c_yy * sf - h);
  const double s_vel = na * fr.a * inv_rn;
  const double Xd = s_vel * (c_xy * cf - c_xx * sf);
  const double Yd = s_vel * (c_yy * cf - c_xy * sf);

  const Vec3 sv_s = b.sun_r * b.sun_u;
  const Vec3 sv_m = b.moon_r * b.moon_u;
  const double xs0 = dot(sv_s, fr.f), ys0 = dot(sv_s, fr.g), zs0 = dot(sv_s, fr.w);
  const double xm0 = dot(sv_m, fr.f), ym0 = dot(sv_m, fr.g), zm0 = dot(sv_m, fr.w);
  const double ds_f = xs0 - X, ds_g = ys0 - Y;
  const double dm_f = xm0 - X, dm_g = ym0 - Y;
#ifdef __wasm_simd128__
  const v128_t vd2 = wasm_f64x2_make(ds_f * ds_f + ds_g * ds_g + zs0 * zs0,
                                     dm_f * dm_f + dm_g * dm_g + zm0 * zm0);
  const v128_t vdn = wasm_f64x2_sqrt(vd2);
  const v128_t vsr = wasm_f64x2_make(b.sun_r, b.moon_r);
  const v128_t vden_d = wasm_f64x2_mul(vd2, vdn);
  const v128_t vden_s = wasm_f64x2_mul(wasm_f64x2_mul(vsr, vsr), vsr);
  const v128_t vinv_ds = wasm_f64x2_div(wasm_f64x2_make(kSunMass * kMu, kMoonMass * kMu),
                                        wasm_f64x2_mul(vden_d, vden_s));
  const v128_t vc_dir = wasm_f64x2_mul(vinv_ds, vden_s);
  const v128_t vc_ind = wasm_f64x2_mul(vinv_ds, vden_d);
  const double c_dir_s = wasm_f64x2_extract_lane(vc_dir, 0), c_dir_m = wasm_f64x2_extract_lane(vc_dir, 1);
  const double c_ind_s = wasm_f64x2_extract_lane(vc_ind, 0), c_ind_m = wasm_f64x2_extract_lane(vc_ind, 1);
#else
  const double dsn = std::sqrt(ds_f * ds_f + ds_g * ds_g + zs0 * zs0);
  const double dmn = std::sqrt(dm_f * dm_f + dm_g * dm_g + zm0 * zm0);
  const double c_dir_s = (kSunMass * kMu) / (dsn * dsn * dsn);
  const double c_ind_s = (kSunMass * kMu) / (b.sun_r * b.sun_r * b.sun_r);
  const double c_dir_m = (kMoonMass * kMu) / (dmn * dmn * dmn);
  const double c_ind_m = (kMoonMass * kMu) / (b.moon_r * b.moon_r * b.moon_r);
#endif
  const double df = (c_dir_s * ds_f - c_ind_s * xs0) + (c_dir_m * dm_f - c_ind_m * xm0);
  const double dg = (c_dir_s * ds_g - c_ind_s * ys0) + (c_dir_m * dm_g - c_ind_m * ym0);
  const double W = (c_dir_s - c_ind_s) * zs0 + (c_dir_m - c_ind_m) * zm0;

  const double xu = X * inv_rn, yu = Y * inv_rn;
  const double R = df * xu + dg * yu;
  const double S = dg * xu - df * yu;
  const double vd = Xd * df + Yd * dg;
  constexpr double kInvMu = 1.0 / kMu;
  const double adot = (2.0 * kInvMu) * fr.a * fr.a * vd;
  const double rd = X * df + Y * dg;
  const double rv = X * Xd + Y * Yd;
  const double two_vd = 2.0 * vd;
  const double edot_f = kInvMu * (two_vd * X - rd * Xd - rv * df);
  const double edot_g = kInvMu * (two_vd * Y - rd * Yd - rv * dg);
  const double c_W = (0.5 * fr.c * inv_hn) * W;
  const double omega_rot = (chi * X - psi * Y) * W * inv_hn;
  const double er = k * xu + h * yu;
  const double es = h * xu - k * yu;
  const double inv_p = inv_a * inv_eta * inv_eta;

  tb[kAf] = edot_f + h * omega_rot;
  tb[kAg] = edot_g - k * omega_rot;
  tb[kChi] = c_W * Y;
  tb[kPsi] = c_W * X;
  tb[kLam] = -(2.0 * roa * inv_na) * R - (fr.eta * inv_na * beta) * (er * R + (1.0 + rn * inv_p) * es * S) - omega_rot;
  tb[kN] = -1.5 * fr.n * inv_a * adot;
}

template <int K>
inline double ipow(double x) {
  double r = 1.0;
  for (int k = 0; k < K; ++k) r *= x;
  return r;
}

#include "xp_spec_terms.inc"

[[gnu::always_inline]] inline void srp_output_ap(double e, double eta, double sE1, double cE1, double sw1, double cw1,
                                                 double sO1, double cO1, double sinc1, double cinc1, double a, double n,
                                                 double A, double B, double Cw, double Fs, double* d) {
  const double cEw = cE1 * cw1 - sE1 * sw1, sEw = sE1 * cw1 + cE1 * sw1;
  const double cOw = cw1 * cO1 - sw1 * sO1, sOw = sw1 * cO1 + cw1 * sO1;
  const double cE2 = cE1 * cE1 - sE1 * sE1, sE2 = sE1 * cE1 + cE1 * sE1;
  const double cmE_Ow = cE1 * cOw + sE1 * sOw, smE_Ow = cE1 * sOw - sE1 * cOw;
  const double cpE_Ow = cE1 * cOw - sE1 * sOw, spE_Ow = sE1 * cOw + cE1 * sOw;
  const double cm2E_Ow = cE2 * cOw + sE2 * sOw, sm2E_Ow = cE2 * sOw - sE2 * cOw;
  const double cp2E_Ow = cE2 * cOw - sE2 * sOw, sp2E_Ow = sE2 * cOw + cE2 * sOw;
  const double e2 = e * e, e3 = e2 * e, e4 = e2 * e2;
  const double sE1_2 = sE1 * sE1, cE1_2 = cE1 * cE1;
#ifdef __wasm_simd128__
  const v128_t vd_one = wasm_f64x2_splat(1.0);
  const double an = a * n, an2 = an * n;
  const v128_t v_inv0 = wasm_f64x2_div(vd_one, wasm_f64x2_make(an, an2 * eta));
  const v128_t v_inv1 = wasm_f64x2_div(vd_one, wasm_f64x2_make(cinc1 + 1.0, e2 - eta - 1.0));
  const double inv_an = wasm_f64x2_extract_lane(v_inv0, 0);
  const double inv_eta_an2 = wasm_f64x2_extract_lane(v_inv0, 1);
  const double inv_an2 = inv_eta_an2 * eta;
  const double inv_cinc1 = wasm_f64x2_extract_lane(v_inv1, 0);
  const double inv_eem1 = wasm_f64x2_extract_lane(v_inv1, 1);
#else
  const double inv_an = 1.0 / (a * n);
  const double inv_an2 = inv_an / n;
  const double inv_eta_an2 = inv_an2 / eta;
  const double inv_cinc1 = 1.0 / (cinc1 + 1.0);
  const double inv_eem1 = 1.0 / (e2 - eta - 1.0);
#endif
  d[4] = Fs * (
        A * ((-(4.0 * e4 + 6.0 * e3 * cE1 - 5.0 * e2 * eta - 14.0 * e2 - 5.0 * e * eta * cE1 - 6.0 * e * cE1 + 10.0 * eta + 10.0)) * sE1 * 0.5 * inv_an2 * inv_eem1)
        + B * ((-(10.0 * e3 * eta * sE1_2 - 5.0 * e3 * eta + 10.0 * e3 * sE1_2 - 5.0 * e3 + 16.0 * e2 * eta * cE1 + 20.0 * e2 * cE1 - 12.0 * e * eta * sE1_2 + 6.0 * e * eta - 10.0 * e * sE1_2 + 5.0 * e - 20.0 * eta * cE1 - 20.0 * cE1)) * 0.25 * inv_an2 * inv_eem1)
        + Cw * ((2.0 * e3 * sE1_2 * cw1 - e3 * cw1 - 2.0 * e2 * eta * sE1 * sw1 - 2.0 * e2 * sE1 * sw1 + 4.0 * e2 * cE1 * cw1 - 2.0 * e * eta * sE1 * sEw + e * eta * cw1 - 2.0 * e * sE1 * sEw + e * cw1 - 4.0 * eta * cEw - 4.0 * cEw) * sinc1 * 0.25 * inv_an2 * inv_cinc1 * inv_eem1));
  d[5] = Fs * (A * (3.0 * cE1 * inv_an) + B * (3.0 * eta * sE1 * inv_an));
  d[2] = Fs * Cw * ((4.0 * e2 * sE1 * sOw - 4.0 * e * eta * cE1_2 * cOw + 2.0 * e * eta * cOw + e * (cm2E_Ow - cp2E_Ow) + 8.0 * eta * cE1 * cOw - 8.0 * sE1 * sOw) * 0.125 * inv_eta_an2 * inv_cinc1);
  d[3] = Fs * Cw * ((4.0 * e2 * sE1 * cOw - 4.0 * e * eta * sE1_2 * sOw + 2.0 * e * eta * sOw + e * (sp2E_Ow - sm2E_Ow) - 8.0 * eta * sOw * cE1 - 8.0 * sE1 * cOw) * 0.125 * inv_eta_an2 * inv_cinc1);
  d[0] = Fs * (
        A * ((e2 - 1.0) * (e * (cmE_Ow - cpE_Ow) + cp2E_Ow) * 0.25 * inv_eta_an2)
        + B * ((2.0 * e3 * (smE_Ow - spE_Ow) + e2 * (sp2E_Ow - sm2E_Ow) + 8.0 * e * eta * sOw * cE1 + 2.0 * e * (spE_Ow - smE_Ow) + 4.0 * eta * sE1_2 * sOw - 2.0 * eta * sOw + sm2E_Ow - sp2E_Ow) * 0.125 * inv_eta_an2)
        + Cw * ((-e) * (2.0 * e2 * sE1 * sw1 * sOw - 2.0 * e * eta * sO1 * cE1_2 + e * eta * sO1 - 2.0 * e * eta * sw1 * cE1_2 * cOw + e * eta * sw1 * cOw + 2.0 * e * sE1 * sw1 * sOw * cE1 + 4.0 * eta * sO1 * cE1 + 4.0 * eta * sw1 * cE1 * cOw - 4.0 * sE1 * sw1 * sOw) * sinc1 * 0.25 * inv_eta_an2 * inv_cinc1));
  d[1] = Fs * (
        A * ((e2 - 1.0) * (e * (smE_Ow - spE_Ow) + sp2E_Ow) * 0.25 * inv_eta_an2)
        + B * ((-(2.0 * e3 * (cmE_Ow - cpE_Ow) + e2 * (cp2E_Ow - cm2E_Ow) + 8.0 * e * eta * cE1 * cOw + 2.0 * e * (cpE_Ow - cmE_Ow) + 4.0 * eta * sE1_2 * cOw - 2.0 * eta * cOw + cm2E_Ow - cp2E_Ow)) * 0.125 * inv_eta_an2)
        + Cw * (e * (2.0 * e2 * sE1 * sw1 * cOw - 2.0 * e * eta * sE1_2 * sw1 * sOw + 2.0 * e * eta * sE1_2 * cO1 + e * eta * sw1 * sOw - e * eta * cO1 + 2.0 * e * sE1 * sw1 * cE1 * cOw - 4.0 * eta * sw1 * sOw * cE1 + 4.0 * eta * cE1 * cO1 - 4.0 * sE1 * sw1 * cOw) * sinc1 * 0.25 * inv_eta_an2 * inv_cinc1));
}

inline void srp_rates_sunlit_ap(double e, double eta, double sw1, double cw1, double sO1, double cO1, double sinc1, double cinc1,
                                double a, double n, double A, double B, double Cw, double Fs, double* d) {
  const double cOw = cw1 * cO1 - sw1 * sO1, sOw = sw1 * cO1 + cw1 * sO1;
  const double e2 = e * e;
  const double inv_2an = 0.5 / (a * n);
  const double inv_2ean = inv_2an / eta;
  const double inv_cinc1 = 1.0 / (cinc1 + 1.0);
  const double inv_eem1 = 1.0 / (e2 - eta - 1.0);
  d[4] = Fs * (A * ((-3.0) * e * (2.0 * e2 - 3.0 * eta - 2.0) * inv_2an * inv_eem1)
        + Cw * ((-3.0) * e * (eta + 1.0) * sinc1 * sw1 * inv_2an * inv_cinc1 * inv_eem1));
  d[5] = 0.0;
  d[2] = Fs * Cw * (3.0 * e * sOw * inv_2ean * inv_cinc1);
  d[3] = Fs * Cw * (3.0 * e * cOw * inv_2ean * inv_cinc1);
  d[0] = Fs * (A * ((-3.0) * eta * sOw * inv_2an) + B * ((-3.0) * eta * cOw * inv_2an)
        + Cw * ((-3.0) * e2 * sinc1 * sw1 * sOw * inv_2ean * inv_cinc1));
  d[1] = Fs * (A * (3.0 * eta * cOw * inv_2an) + B * ((-3.0) * eta * sOw * inv_2an)
        + Cw * (3.0 * e2 * sinc1 * sw1 * cOw * inv_2ean * inv_cinc1));
}

inline void srp_rates_arc_ap(double e, double eta, double sw1, double cw1, double sO1, double cO1, double sinc1, double cinc1,
                             double a, double n, double E1, double E2, double s1, double c1, double s2, double c2,
                             double A, double B, double Cw, double Fs, double* d) {
  const double s2_1 = s1 * c1 + c1 * s1, c2_1 = c1 * c1 - s1 * s1;
  const double s2_2 = s2 * c2 + c2 * s2, c2_2 = c2 * c2 - s2 * s2;
  const double c1mw = c1 * cw1 + s1 * sw1, c2mw = c2 * cw1 + s2 * sw1;
  const double s1pw = s1 * cw1 + c1 * sw1, c1pw = c1 * cw1 - s1 * sw1;
  const double s2pw = s2 * cw1 + c2 * sw1, c2pw = c2 * cw1 - s2 * sw1;
  const double cOw = cw1 * cO1 - sw1 * sO1, sOw = sw1 * cO1 + cw1 * sO1;
  const double cmE1_Ow = c1 * cOw + s1 * sOw, cpE1_Ow = c1 * cOw - s1 * sOw;
  const double smE1_Ow = c1 * sOw - s1 * cOw, spE1_Ow = s1 * cOw + c1 * sOw;
  const double cmE2_Ow = c2 * cOw + s2 * sOw, cpE2_Ow = c2 * cOw - s2 * sOw;
  const double smE2_Ow = c2 * sOw - s2 * cOw, spE2_Ow = s2 * cOw + c2 * sOw;
  const double cm2E1_Ow = c2_1 * cOw + s2_1 * sOw, cp2E1_Ow = c2_1 * cOw - s2_1 * sOw;
  const double sm2E1_Ow = c2_1 * sOw - s2_1 * cOw, sp2E1_Ow = s2_1 * cOw + c2_1 * sOw;
  const double cm2E2_Ow = c2_2 * cOw + s2_2 * sOw, cp2E2_Ow = c2_2 * cOw - s2_2 * sOw;
  const double sm2E2_Ow = c2_2 * sOw - s2_2 * cOw, sp2E2_Ow = s2_2 * cOw + c2_2 * sOw;
  const double e2 = e * e, e3 = e2 * e, e4 = e2 * e2;
  const double s1_2 = s1 * s1, s2_sq = s2 * s2;
  const double inv_pian = 1.0 / (kPi * a * n);
  const double inv_piean = inv_pian / eta;
  const double inv_cinc1 = 1.0 / (cinc1 + 1.0);
  const double inv_eem1 = 1.0 / (e2 - eta - 1.0);
  d[4] = Fs * (
        A * ((-((-12.0) * E1 * e3 + 18.0 * E1 * e * eta + 12.0 * E1 * e + 12.0 * E2 * e3 - 18.0 * E2 * e * eta - 12.0 * E2 * e + 4.0 * e4 * (s1 - s2) - 6.0 * e3 * (s2_1 - s2_2) - 8.0 * e2 * eta * (s1 - s2) + 16.0 * e2 * (s1 - s2) + 5.0 * e * eta * (s2_1 - s2_2) + 6.0 * e * (s2_1 - s2_2) - 20.0 * eta * (s1 - s2) - 20.0 * (s1 - s2))) * 0.125 * inv_pian * inv_eem1)
        + B * ((5.0 * e3 * eta * (s1_2 - s2_sq) + 5.0 * e3 * (s1_2 - s2_sq) + 8.0 * e2 * eta * (c1 - c2) + 10.0 * e2 * (c1 - c2) - 6.0 * e * eta * (s1_2 - s2_sq) - 5.0 * e * (s1_2 - s2_sq) - 10.0 * eta * (c1 - c2) - 10.0 * (c1 - c2)) * 0.25 * inv_pian * inv_eem1)
        + Cw * ((-((-3.0) * E1 * e * eta * sw1 - 3.0 * E1 * e * sw1 + 3.0 * E2 * e * eta * sw1 + 3.0 * E2 * e * sw1 + e3 * (s1_2 - s2_sq) * cw1 + 2.0 * e2 * eta * (s1 - s2) * sw1 + 2.0 * e2 * (c1mw - c2mw) - e * eta * (s1 * s1pw - s2 * s2pw) - e * (s1 * s1pw - s2 * s2pw) - 2.0 * eta * (c1pw - c2pw) - 2.0 * (c1pw - c2pw))) * sinc1 * 0.25 * inv_pian * inv_cinc1 * inv_eem1));
  d[5] = Fs * (A * ((-3.0) * (c1 - c2) / (2.0 * kPi * a)) + B * ((-3.0) * eta * (s1 - s2) / (2.0 * kPi * a)));
  d[2] = Fs * Cw * (((-12.0) * E1 * e * sOw + 12.0 * E2 * e * sOw + 8.0 * e2 * (s1 - s2) * sOw - 4.0 * e * eta * (s1_2 - s2_sq) * cOw - e * cm2E1_Ow + e * cp2E1_Ow + e * cm2E2_Ow - e * cp2E2_Ow - 8.0 * eta * (c1 - c2) * cOw + 8.0 * (s1 - s2) * sOw) * 0.0625 * inv_piean * inv_cinc1);
  d[3] = Fs * Cw * (((-12.0) * E1 * e * cOw + 12.0 * E2 * e * cOw + 8.0 * e2 * (s1 - s2) * cOw + 4.0 * e * eta * (s1_2 - s2_sq) * sOw + e * sm2E1_Ow - e * sp2E1_Ow - e * sm2E2_Ow + e * sp2E2_Ow + 8.0 * eta * sOw * (c1 - c2) + 8.0 * (s1 - s2) * cOw) * 0.0625 * inv_piean * inv_cinc1);
  d[0] = Fs * (
        A * ((e2 - 1.0) * ((-6.0) * E1 * sOw + 6.0 * E2 * sOw + 2.0 * e * (cmE1_Ow - cpE1_Ow - cmE2_Ow + cpE2_Ow) - cp2E1_Ow + cp2E2_Ow) * 0.125 * inv_piean)
        + B * ((-(12.0 * (E1 - E2) * (e2 - 1.0) * cOw + 8.0 * e3 * (smE1_Ow - spE1_Ow - smE2_Ow + spE2_Ow) + e2 * (-sm2E1_Ow + sp2E1_Ow + sm2E2_Ow - sp2E2_Ow) + 8.0 * e * eta * sOw * (c1 - c2) + 8.0 * e * (-smE1_Ow + spE1_Ow + smE2_Ow - spE2_Ow) + 4.0 * eta * (s1_2 - s2_sq) * sOw + sm2E1_Ow - sp2E1_Ow - sm2E2_Ow + sp2E2_Ow)) * 0.0625 * inv_piean)
        + Cw * ((-e) * ((-3.0) * (E1 - E2) * e * sw1 * sOw + 2.0 * e2 * (s1 - s2) * sw1 * sOw - e * eta * (s1_2 - s2_sq) * (sO1 + sw1 * cOw) - e * sw1 * sOw * (s1 * c1 - s2 * c2) - 2.0 * eta * (c1 - c2) * (sO1 + sw1 * cOw) + 2.0 * (s1 - s2) * sw1 * sOw) * sinc1 * 0.25 * inv_piean * inv_cinc1));
  d[1] = Fs * (
        A * ((e2 - 1.0) * (6.0 * (E1 - E2) * cOw + 2.0 * e * (smE1_Ow - spE1_Ow - smE2_Ow + spE2_Ow) - sp2E1_Ow + sp2E2_Ow) * 0.125 * inv_piean)
        + B * (((-12.0) * (E1 - E2) * (e2 - 1.0) * sOw + 8.0 * e3 * (cmE1_Ow - cpE1_Ow - cmE2_Ow + cpE2_Ow) + e2 * (-cm2E1_Ow + cp2E1_Ow + cm2E2_Ow - cp2E2_Ow) + 8.0 * e * eta * (c1 - c2) * cOw + 8.0 * e * (-cmE1_Ow + cpE1_Ow + cmE2_Ow - cpE2_Ow) + 4.0 * eta * (s1_2 - s2_sq) * cOw + cm2E1_Ow - cp2E1_Ow - cm2E2_Ow + cp2E2_Ow) * 0.0625 * inv_piean)
        + Cw * (e * ((-3.0) * (E1 - E2) * e * sw1 * cOw + 2.0 * e2 * (s1 - s2) * sw1 * cOw + e * eta * (s1_2 - s2_sq) * (sw1 * sOw - cO1) - e * sw1 * cOw * (s1 * c1 - s2 * c2) + 2.0 * eta * (c1 - c2) * (sw1 * sOw - cO1) + 2.0 * (s1 - s2) * sw1 * cOw) * sinc1 * 0.25 * inv_piean * inv_cinc1));
}

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

/// SPEC 3.4: the geodetic height (km) at a node of geocentric latitude (sine sp, non-negative cosine cp) and radius r
/// (ER), with the terms the geodetic latitude takes.
struct NodeHeight {
  double Nn, n0, W1, h;
};
inline NodeHeight node_height(double sp, double cp, double r) {
  const double f = kFlattening, eps2 = f * (2.0 - f);
  const double Nn = eps2 * sp * cp, n0 = 1.0 - eps2 * cp * cp, W0 = std::sqrt(1.0 - eps2 * sp * sp);
  const double t1 = Nn / (n0 + W0 * (r - W0));
  // sin(phic + atan t1) = (sin phic + cos phic t1) / sqrt(1 + t1^2)
  const double q1 = std::sqrt(1.0 + t1 * t1);
  const double s1 = (sp + cp * t1) / q1;
  const double W1 = std::sqrt(1.0 - eps2 * s1 * s1);
  return {Nn, n0, W1, kRe * (r / q1 - W1)};
}

/// SPEC 3.4: the geodetic latitude (rad) of that node.
inline double geodetic_latitude(double sp, const NodeHeight& nh) { return std::asin(sp) + std::atan(nh.Nn / (nh.n0 + nh.W1 * nh.h / kRe)); }

/// The density (kg/m^3) at a node: rho = 1e-20 above 2500 km (SPEC 3.3, amendment 6); below it the theory's own
/// (SPEC 3.2, 3.3: atmosphere null or Jacchia 1970, date terms dt) or NRLMSISE-00 on `drivers` times `dca` (atmosphere.inc;
/// below 10 km the 10 km value, as the theory's table). alpha is the node's TEME right ascension, theta_g the Greenwich
/// angle, H the Sun-relative hour angle.
inline double node_density(const atm::Atmosphere* atmosphere, const drag::DateTerms& dt, const drag::Flux& drivers, double dca,
                           double d50, double sp, double cp, double sdsun, double cdsun, double H, double alpha, double theta_g,
                           const NodeHeight& nh) {
  if (!(nh.h <= 2500.0)) return 1e-20;
  if (atmosphere == nullptr || atmosphere->model == atm::kJacchia70) {
    const double tinf = drag::exospheric_temperature(dt, sp, cp, sdsun, cdsun, H);
    // the geodetic latitude enters only the seasonal-latitudinal term (90 < h < 300 km)
    const double phig = (nh.h > 90.0 && nh.h < 300.0) ? geodetic_latitude(sp, nh) : 0.0;
    return drag::density(dt, tinf, nh.h, phig);
  }
  return atm::msis_density(d50, geodetic_latitude(sp, nh), atm::wrap_pi(alpha - theta_g), nh.h < 10.0 ? 10.0 : nh.h, drivers) * dca;
}

/// SPEC 3.4 (side A at 22570b7): the drag rates as stated there, from 13-point
/// Gauss-Legendre sums over the perigee arc at the J2-corrected radius:
/// geodetic height, the diurnal term at the geocentric latitude, the seasonal
/// term at the geodetic latitude, the co-rotation speed factor V; rho = 0
/// above 2500 km; the acceleration -(1/2) rho B |v_rel| v_rel, B = C_D A/m.
/// `atmosphere` (null: the theory's own) selects the density (node_density); theta_g is the Greenwich angle at d50.
/// AP above e 0.3 (SPEC 16.12, `pass`): d50 and theta_g are those of a perigee passage, each node takes the Earth angle and
/// date of its own time on that pass (M(nu) / n after perigee), the arcs beyond nu_c to apogee are added (13 nodes each,
/// nu = nu_c + (pi - nu_c) s^2), and `scale` multiplies the rates; `width`, when given there, receives the pass's width in
/// the mean anomaly: the RMS of M(nu) over the perigee arc's nodes, each weighted by its share of the pass's sums.
constexpr double kDragGx[13] = {-0.98418305471858814, -0.91759839922297803, -0.80157809073330988,
                                -0.64234933944034023, -0.44849275103644692, -0.23045831595513480, 0.0,
                                0.23045831595513480, 0.44849275103644692, 0.64234933944034023,
                                0.80157809073330988, 0.91759839922297803, 0.98418305471858814};
constexpr double kDragGw[13] = {0.040484004765315877, 0.092121499837728452, 0.13887351021978719,
                                0.17814598076194571, 0.20781604753688851, 0.22628318026289720,
                                0.23255155323087390, 0.22628318026289720, 0.20781604753688851,
                                0.17814598076194571, 0.13887351021978719, 0.092121499837728452,
                                0.040484004765315877};
struct GxPiTrig {
  double c[13]{}, s[13]{};
};
inline constexpr GxPiTrig kGxPiTrig = []() constexpr {
  GxPiTrig t{};
  for (int j = 0; j < 13; ++j) fm::sincos(kPi * kDragGx[j], t.s[j], t.c[j]);
  return t;
}();

inline void drag_rates(const double* y, const Frame& fr, const Kepler& k, const AngleTrig& ag, double bterm,
                       const Bodies& b, double d50, const atm::Atmosphere* atmosphere, double theta_g, double* out,
                       bool pass = false, double scale = 1.0, bool ap_fast = false, double* width = nullptr) {
  (void)y;
  if (width != nullptr) *width = 0.0;
  const double* const gx = kDragGx;
  const double* const gw = kDragGw;
  const double e = k.e, a = fr.a, n = fr.n, eta = fr.eta;
  const double p = a * eta * eta;
  const double th = ag.ci, si = ag.si;
  const double f = kFlattening;
  // arc
  const double rp = a * (1.0 - e);
  const double hp = kRe * (rp - 1.0 + f * si * si * ag.sw * ag.sw);
  if (ap_fast && !pass && hp > 2550.0 && std::fabs(bterm) < 10.0) return;
  const double bb = hp < 90.0 ? 90.0 : (hp > 900.0 ? 900.0 : hp);
  const double band = bb * (-3.130124 + bb * (0.061710434 + bb * (-3.4111266e-4 + bb * (8.7321429e-7 +
                      bb * (-1.122534e-9 + bb * (7.1123451e-13 + bb * -1.776575e-16)))))) / kRe;
  double nuc = kPi;
  if (band < 2.0 * a * e) {
    const double c = (rp * e - band) / (e * (rp + band));
    nuc = std::acos(c < -1.0 ? -1.0 : (c > 1.0 ? 1.0 : c));
  }
  const double q = kOmegaE * eta * eta * eta / n;
  const double cj2 = kJ2 / (4.0 * p);
  const GxPiTrig& pt = kGxPiTrig;
  double G = 0, SD = 0, Se = 0, Ssu = 0, Sn = 0, Snc = 0, Suu = 0, Ss = 0, Sw = 0;
  if (ap_fast && !pass && hp > 2550.0) {
    for (int j = 0; j < 13; ++j) {
      double sn, cn;
      if (nuc == kPi) {
        cn = pt.c[j];
        sn = pt.s[j];
      } else {
        fm::sincos(nuc * gx[j], sn, cn);
      }
      const double cu = ag.cw * cn - ag.sw * sn, su = ag.sw * cn + ag.cw * sn;
      const double Dn = 1.0 + e * cn;
      const double iD2 = 1.0 / (Dn * Dn);
      const double sp = si * su, cp2 = 1.0 - sp * sp;
      const double V = std::sqrt(1.0 + 2.0 * e * cn + e * e - 2.0 * q * th + q * q * cp2 * iD2);
      const double K = gw[j] * 1e-20 * V * iD2;
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
  } else {
    // the drivers: SPEC 3.1's generic flux model, or the atmosphere's measured rows (atmosphere.inc)
    const bool generic = atmosphere == nullptr || !atmosphere->measured;
    const drag::Flux fl = generic ? drag::flux_at(d50) : atm::drivers_at(*atmosphere, d50);
    const double dca = atmosphere != nullptr && !atmosphere->dca_d50.empty() ? atm::dca_scale(*atmosphere, d50) : 1.0;
    if (!pass && nuc == kPi && atmosphere != nullptr && atmosphere->model == atm::kNrlmsise00) {
      const atm::ThermoTimeCache& tc = atm::prepare_msis_time(d50, fl);
      double s_thg = 0.0, c_thg = 1.0;
      const double s_ut = tc.s_ut_pi12, c_ut = tc.c_ut_pi12;
      if (ap_fast) {
        fm::sincos(theta_g, s_thg, c_thg);
      }
      const double cj2_c = cj2 * (1.0 - th * th);
      const double cj2_s = cj2 * (3.0 * th * th - 1.0);
      const double inv_1peta = 1.0 / (1.0 + eta);
      const double ve_const = 1.0 + e * e - 2.0 * q * th;
      const double q2 = q * q;
#if defined(__wasm_simd128__)
      if (ap_fast && hp > 355.0 && a * (1.0 + e) < 1.0 + (2470.0 / kRe) && std::fabs(th) > 1e-6) {
        alignas(16) float hi_c[16], hi_s[16], hi_slon[16], hi_clon[16], hi_stloc[16], hi_ctloc[16];
        alignas(16) double hi_h[16], rho_arr[16], Kw_a[14], cu_a[14], su_a[14];
        double Dn_p[7], iD_p[7], iD2_p[7];
        constexpr double eps2 = kFlattening * (2.0 - kFlattening);
        constexpr double kEpsDgtr = 1.74533e-2 / kDeg - 1.0;
        constexpr double kEpsHr = 0.2618 - kPi / 12.0;
        const v128_t vd_one = wasm_f64x2_splat(1.0);
        const v128_t vd_half = wasm_f64x2_splat(0.5);
        const v128_t vd_eps2 = wasm_f64x2_splat(eps2);
        const v128_t vd_si = wasm_f64x2_splat(si);
        const v128_t vd_cj2_c = wasm_f64x2_splat(cj2_c);
        const v128_t vd_cO = wasm_f64x2_splat(ag.cO), vd_sO = wasm_f64x2_splat(ag.sO);
        const v128_t vd_cO_th = wasm_f64x2_splat(ag.cO * th), vd_sO_th = wasm_f64x2_splat(ag.sO * th);
        const v128_t vd_cthg = wasm_f64x2_splat(c_thg), vd_sthg = wasm_f64x2_splat(s_thg);
        const v128_t vd_cut = wasm_f64x2_splat(c_ut), vd_sut = wasm_f64x2_splat(s_ut);
        const v128_t vd_sechr = wasm_f64x2_splat(tc.sec_hr);
        const v128_t vd_zero = wasm_f64x2_splat(0.0);

        for (int j = 0; j <= 6; ++j) {
          const double cn = pt.c[j], sn = pt.s[j];
          const double ecn = e * cn;
          const double Dn = 1.0 + ecn;
          const double iD = 1.0 / Dn, iD2 = iD * iD;
          Dn_p[j] = Dn;
          iD_p[j] = iD;
          iD2_p[j] = iD2;
          const double rb = p * iD - cj2_s * (ecn * inv_1peta + 2.0 * eta * iD + 1.0);
          const double cw_cn = ag.cw * cn, sw_sn = ag.sw * sn;
          const double sw_cn = ag.sw * cn, cw_sn = ag.cw * sn;
          const v128_t vcu = wasm_f64x2_make(cw_cn - sw_sn, cw_cn + sw_sn);
          const v128_t vsu = wasm_f64x2_make(sw_cn + cw_sn, sw_cn - cw_sn);
          wasm_v128_store(cu_a + 2 * j, vcu);
          wasm_v128_store(su_a + 2 * j, vsu);

          const v128_t vc2u = wasm_f64x2_sub(wasm_f64x2_mul(vcu, vcu), wasm_f64x2_mul(vsu, vsu));
          const v128_t vr = wasm_f64x2_add(wasm_f64x2_splat(rb), wasm_f64x2_mul(vd_cj2_c, vc2u));
          const v128_t vsp = wasm_f64x2_mul(vd_si, vsu);
          const v128_t vsp2 = wasm_f64x2_mul(vsp, vsp);
          const v128_t vcp2 = wasm_f64x2_sub(vd_one, vsp2);
          const v128_t vcp = wasm_f64x2_sqrt(vcp2);
          const v128_t vinv_cp = wasm_f64x2_div(vd_one, vcp);

          const v128_t vV = wasm_f64x2_sqrt(
              wasm_f64x2_add(wasm_f64x2_splat(ve_const + 2.0 * ecn), wasm_f64x2_mul(wasm_f64x2_splat(q2 * iD2), vcp2)));
          wasm_v128_store(Kw_a + 2 * j, wasm_f64x2_mul(wasm_f64x2_splat(gw[j] * iD2), vV));

          const v128_t vNn = wasm_f64x2_mul(vd_eps2, wasm_f64x2_mul(vsp, vcp));
          const v128_t vn0 = wasm_f64x2_sub(vd_one, wasm_f64x2_mul(vd_eps2, vcp2));
          const v128_t vu0 = wasm_f64x2_mul(vd_eps2, vsp2);
          const v128_t vW0 = wasm_f64x2_sub(
              vd_one,
              wasm_f64x2_mul(vu0, wasm_f64x2_add(vd_half,
                                                 wasm_f64x2_mul(vu0, wasm_f64x2_add(wasm_f64x2_splat(0.125),
                                                                                    wasm_f64x2_mul(vu0, wasm_f64x2_add(wasm_f64x2_splat(0.0625),
                                                                                                                       wasm_f64x2_mul(wasm_f64x2_splat(5.0 / 128.0), vu0))))))));
          const v128_t vt1 = wasm_f64x2_div(vNn, wasm_f64x2_add(vn0, wasm_f64x2_mul(vW0, wasm_f64x2_sub(vr, vW0))));
          const v128_t vt1_2 = wasm_f64x2_mul(vt1, vt1);
          const v128_t vinv_q1 = wasm_f64x2_sub(
              vd_one, wasm_f64x2_mul(vt1_2, wasm_f64x2_sub(vd_half, wasm_f64x2_mul(wasm_f64x2_splat(0.375), vt1_2))));
          const v128_t vs1 = wasm_f64x2_mul(wasm_f64x2_add(vsp, wasm_f64x2_mul(vcp, vt1)), vinv_q1);
          const v128_t vu1 = wasm_f64x2_mul(vd_eps2, wasm_f64x2_mul(vs1, vs1));
          const v128_t vW1 = wasm_f64x2_sub(
              vd_one,
              wasm_f64x2_mul(vu1, wasm_f64x2_add(vd_half,
                                                 wasm_f64x2_mul(vu1, wasm_f64x2_add(wasm_f64x2_splat(0.125),
                                                                                    wasm_f64x2_mul(vu1, wasm_f64x2_add(wasm_f64x2_splat(0.0625),
                                                                                                                       wasm_f64x2_mul(wasm_f64x2_splat(5.0 / 128.0), vu1))))))));
          const v128_t vh_re = wasm_f64x2_sub(wasm_f64x2_mul(vr, vinv_q1), vW1);
          wasm_v128_store(hi_h + 2 * j, wasm_f64x2_mul(wasm_f64x2_splat(kRe), vh_re));

          const v128_t vtd = wasm_f64x2_div(vNn, wasm_f64x2_add(vn0, wasm_f64x2_mul(vW1, vh_re)));
          const v128_t vtd2 = wasm_f64x2_mul(vtd, vtd);
          const v128_t vdlat = wasm_f64x2_mul(
              vtd, wasm_f64x2_sub(vd_one, wasm_f64x2_mul(vtd2, wasm_f64x2_sub(wasm_f64x2_splat(1.0 / 3.0),
                                                                               wasm_f64x2_mul(wasm_f64x2_splat(0.2), vtd2)))));
          const v128_t vphi_est = wasm_f64x2_mul(
              vsp, wasm_f64x2_sub(wasm_f64x2_splat(0.5 * kPi), wasm_f64x2_mul(wasm_f64x2_splat(0.5 * kPi - 1.0), vcp)));
          const v128_t vdlat_tot = wasm_f64x2_add(
              vdlat, wasm_f64x2_mul(wasm_f64x2_splat(kEpsDgtr), wasm_f64x2_add(vphi_est, vdlat)));
          const v128_t vdlat2 = wasm_f64x2_mul(vdlat_tot, vdlat_tot);
          const v128_t vcdlat = wasm_f64x2_sub(
              vd_one, wasm_f64x2_mul(vdlat2, wasm_f64x2_sub(vd_half, wasm_f64x2_mul(wasm_f64x2_splat(1.0 / 24.0), vdlat2))));
          const v128_t vsdlat = wasm_f64x2_mul(
              vdlat_tot, wasm_f64x2_sub(vd_one, wasm_f64x2_mul(wasm_f64x2_splat(1.0 / 6.0), vdlat2)));
          const v128_t out_c = wasm_f64x2_add(wasm_f64x2_mul(vsp, vcdlat), wasm_f64x2_mul(vcp, vsdlat));
          const v128_t out_s = wasm_f64x2_sub(wasm_f64x2_mul(vcp, vcdlat), wasm_f64x2_mul(vsp, vsdlat));

          const v128_t vc_ra = wasm_f64x2_mul(
              wasm_f64x2_sub(wasm_f64x2_mul(vd_cO, vcu), wasm_f64x2_mul(vd_sO_th, vsu)), vinv_cp);
          const v128_t vs_ra = wasm_f64x2_mul(
              wasm_f64x2_add(wasm_f64x2_mul(vd_sO, vcu), wasm_f64x2_mul(vd_cO_th, vsu)), vinv_cp);
          const v128_t vclong0 = wasm_f64x2_add(wasm_f64x2_mul(vc_ra, vd_cthg), wasm_f64x2_mul(vs_ra, vd_sthg));
          const v128_t vslong0 = wasm_f64x2_sub(wasm_f64x2_mul(vs_ra, vd_cthg), wasm_f64x2_mul(vc_ra, vd_sthg));
          const v128_t vax = wasm_f64x2_abs(vclong0), vay = wasm_f64x2_abs(vslong0);
          const v128_t vswp = wasm_f64x2_gt(vay, vax);
          const v128_t vz_at = wasm_f64x2_div(wasm_f64x2_min(vax, vay), wasm_f64x2_max(vax, vay));
          const v128_t vz2 = wasm_f64x2_mul(vz_at, vz_at);
          v128_t vang = wasm_f64x2_mul(
              vz_at,
              wasm_f64x2_add(wasm_f64x2_splat(0.99997726),
                             wasm_f64x2_mul(vz2, wasm_f64x2_add(wasm_f64x2_splat(-0.33262347),
                                                                wasm_f64x2_mul(vz2, wasm_f64x2_add(wasm_f64x2_splat(0.19354346),
                                                                                                   wasm_f64x2_mul(vz2, wasm_f64x2_add(wasm_f64x2_splat(-0.11643287),
                                                                                                                                      wasm_f64x2_mul(vz2, wasm_f64x2_add(wasm_f64x2_splat(0.05265332),
                                                                                                                                                                         wasm_f64x2_mul(wasm_f64x2_splat(-0.01172120), vz2)))))))))));
          vang = wasm_v128_bitselect(wasm_f64x2_sub(wasm_f64x2_splat(0.5 * kPi), vang), vang, vswp);
          vang = wasm_v128_bitselect(wasm_f64x2_sub(wasm_f64x2_splat(kPi), vang), vang, wasm_f64x2_lt(vclong0, vd_zero));
          const v128_t vlon = wasm_v128_bitselect(wasm_f64x2_neg(vang), vang, wasm_f64x2_lt(vslong0, vd_zero));
          const v128_t vdlon = wasm_f64x2_mul(wasm_f64x2_splat(kEpsDgtr), vlon);
          const v128_t out_clon = wasm_f64x2_sub(vclong0, wasm_f64x2_mul(vdlon, vslong0));
          const v128_t out_slon = wasm_f64x2_add(vslong0, wasm_f64x2_mul(vdlon, vclong0));

          v128_t vlst = wasm_f64x2_add(vd_sechr, wasm_f64x2_mul(vlon, wasm_f64x2_splat(12.0 / kPi)));
          vlst = wasm_f64x2_sub(vlst, wasm_f64x2_mul(wasm_f64x2_splat(24.0),
                                                     wasm_f64x2_floor(wasm_f64x2_mul(vlst, wasm_f64x2_splat(1.0 / 24.0)))));
          const v128_t vctloc0 = wasm_f64x2_sub(wasm_f64x2_mul(vd_cut, vclong0), wasm_f64x2_mul(vd_sut, vslong0));
          const v128_t vstloc0 = wasm_f64x2_add(wasm_f64x2_mul(vd_sut, vclong0), wasm_f64x2_mul(vd_cut, vslong0));
          const v128_t vdtloc = wasm_f64x2_mul(wasm_f64x2_splat(kEpsHr), vlst);
          const v128_t out_ctloc = wasm_f64x2_sub(vctloc0, wasm_f64x2_mul(vdtloc, vstloc0));
          const v128_t out_stloc = wasm_f64x2_add(vstloc0, wasm_f64x2_mul(vdtloc, vctloc0));

          const int off2 = 2 * j;
          wasm_v128_store64_lane(hi_c + off2, wasm_f32x4_demote_f64x2_zero(out_c), 0);
          wasm_v128_store64_lane(hi_s + off2, wasm_f32x4_demote_f64x2_zero(out_s), 0);
          wasm_v128_store64_lane(hi_slon + off2, wasm_f32x4_demote_f64x2_zero(out_slon), 0);
          wasm_v128_store64_lane(hi_clon + off2, wasm_f32x4_demote_f64x2_zero(out_clon), 0);
          wasm_v128_store64_lane(hi_stloc + off2, wasm_f32x4_demote_f64x2_zero(out_stloc), 0);
          wasm_v128_store64_lane(hi_ctloc + off2, wasm_f32x4_demote_f64x2_zero(out_ctloc), 0);
        }
        hi_c[14] = hi_c[15] = hi_c[12];
        hi_s[14] = hi_s[15] = hi_s[12];
        hi_slon[14] = hi_slon[15] = hi_slon[12];
        hi_clon[14] = hi_clon[15] = hi_clon[12];
        hi_stloc[14] = hi_stloc[15] = hi_stloc[12];
        hi_ctloc[14] = hi_ctloc[15] = hi_ctloc[12];
        hi_h[14] = hi_h[15] = hi_h[12];
        atm::msis_density_hi_trig4(tc, hi_c + 0, hi_s + 0, hi_slon + 0, hi_clon + 0, hi_stloc + 0, hi_ctloc + 0, hi_h + 0, 4, rho_arr + 0);
        atm::msis_density_hi_trig4(tc, hi_c + 4, hi_s + 4, hi_slon + 4, hi_clon + 4, hi_stloc + 4, hi_ctloc + 4, hi_h + 4, 4, rho_arr + 4);
        atm::msis_density_hi_trig4(tc, hi_c + 8, hi_s + 8, hi_slon + 8, hi_clon + 8, hi_stloc + 8, hi_ctloc + 8, hi_h + 8, 4, rho_arr + 8);
        atm::msis_density_hi_trig4(tc, hi_c + 12, hi_s + 12, hi_slon + 12, hi_clon + 12, hi_stloc + 12, hi_ctloc + 12, hi_h + 12, 1, rho_arr + 12);
        for (int j = 0; j < 6; ++j) {
          const double cn = pt.c[j], sn = pt.s[j];
          const double Dn = Dn_p[j], iD = iD_p[j], iD2 = iD2_p[j];
          const double K0 = Kw_a[2 * j] * rho_arr[2 * j] * dca;
          const double K1 = Kw_a[2 * j + 1] * rho_arr[2 * j + 1] * dca;
          const double Ksum = K0 + K1, Kdiff = K0 - K1;
          const double cu0 = cu_a[2 * j], cu1 = cu_a[2 * j + 1];
          const double su0 = su_a[2 * j], su1 = su_a[2 * j + 1];
          G += Ksum;
          SD += Ksum * Dn;
          Se += Ksum * (e + cn);
          Ssu += (K0 * su0 * cu0 + K1 * su1 * cu1) * iD2;
          Sn += Kdiff * sn * iD;
          Snc += Kdiff * sn * cn * iD2;
          Suu += (K0 * cu0 * cu0 + K1 * cu1 * cu1) * iD2;
          Ss += Kdiff * sn * (1.0 - q * th * iD2);
          Sw += Ksum * (Dn * cn + e + cn) * iD2;
        }
        {
          const double Dn6 = Dn_p[6], iD2_6 = iD2_p[6];
          const double cu6 = ag.cw, su6 = ag.sw;
          const double K6 = Kw_a[12] * rho_arr[12] * dca;
          G += K6;
          SD += K6 * Dn6;
          Se += K6 * (e + 1.0);
          Ssu += K6 * su6 * cu6 * iD2_6;
          Suu += K6 * cu6 * cu6 * iD2_6;
          Sw += K6 * (Dn6 + e + 1.0) * iD2_6;
        }
      } else
#endif
      {
        alignas(16) float hi_c[16], hi_s[16], hi_slon[16], hi_clon[16], hi_stloc[16], hi_ctloc[16];
        alignas(16) double hi_h[16];
        int hi_j[13];
        int n_hi = 0;
        double rho_arr[13];
        double Dn_a[13], iD_a[13], iD2_a[13], r_base_a[13], cu_a[13], su_a[13], Kw_a[13];
        for (int j = 0; j <= 6; ++j) {
          const double cn = pt.c[j];
          const double Dn = 1.0 + e * cn;
          const double iD = 1.0 / Dn, iD2 = iD * iD;
          const double rb = p * iD - cj2_s * (e * cn * inv_1peta + 2.0 * eta * iD + 1.0);
          Dn_a[j] = Dn_a[12 - j] = Dn;
          iD_a[j] = iD_a[12 - j] = iD;
          iD2_a[j] = iD2_a[12 - j] = iD2;
          r_base_a[j] = r_base_a[12 - j] = rb;
        }
        for (int j = 0; j < 13; ++j) {
          const double cn = pt.c[j], sn = pt.s[j];
          const double cu = ag.cw * cn - ag.sw * sn, su = ag.sw * cn + ag.cw * sn;
          const double iD2 = iD2_a[j];
          const double c2u = cu * cu - su * su;
          const double r = r_base_a[j] + cj2_c * c2u;
          const double sp = si * su, cp2 = 1.0 - sp * sp, cp = std::sqrt(cp2);
          NodeHeight nh;
          if (ap_fast) {
            constexpr double eps2 = kFlattening * (2.0 - kFlattening);
            const double Nn = eps2 * sp * cp, n0 = 1.0 - eps2 * cp2;
            const double u0 = eps2 * sp * sp;
            const double W0 = 1.0 - u0 * (0.5 + u0 * (0.125 + u0 * (0.0625 + (5.0 / 128.0) * u0)));
            const double t1 = Nn / (n0 + W0 * (r - W0));
            const double t1_2 = t1 * t1;
            const double inv_q1 = 1.0 - t1_2 * (0.5 - 0.375 * t1_2);
            const double s1 = (sp + cp * t1) * inv_q1;
            const double u1 = eps2 * s1 * s1;
            const double W1 = 1.0 - u1 * (0.5 + u1 * (0.125 + u1 * (0.0625 + (5.0 / 128.0) * u1)));
            nh = {Nn, n0, W1, kRe * (r * inv_q1 - W1)};
          } else {
            nh = node_height(sp, cp, r);
          }
          cu_a[j] = cu;
          su_a[j] = su;
          const double V = std::sqrt(ve_const + 2.0 * e * cn + q2 * cp2 * iD2);
          Kw_a[j] = gw[j] * V * iD2;
          if (nh.h > 2500.0) {
            rho_arr[j] = 1e-20;
          } else if (ap_fast && nh.h > 325.0 && cp > 1e-12) {
            constexpr double kEpsDgtr = 1.74533e-2 / kDeg - 1.0;
            constexpr double kEpsHr = 0.2618 - kPi / 12.0;
            const double td = nh.Nn / (nh.n0 + nh.W1 * nh.h * (1.0 / kRe));
            const double td2 = td * td;
            const double dlat = td * (1.0 - td2 * ((1.0 / 3.0) - 0.2 * td2));
            const double phi_est = sp * (0.5 * kPi - (0.5 * kPi - 1.0) * cp);
            const double dlat_tot = dlat + kEpsDgtr * (phi_est + dlat);
            const double dlat2 = dlat_tot * dlat_tot;
            const double cdlat = 1.0 - dlat2 * (0.5 - (1.0 / 24.0) * dlat2);
            const double sdlat = dlat_tot * (1.0 - (1.0 / 6.0) * dlat2);
            hi_c[n_hi] = static_cast<float>(sp * cdlat + cp * sdlat);
            hi_s[n_hi] = static_cast<float>(cp * cdlat - sp * sdlat);
            const double inv_cp = 1.0 / cp;
            const double c_ra = (ag.cO * cu - ag.sO * su * th) * inv_cp;
            const double s_ra = (ag.sO * cu + ag.cO * su * th) * inv_cp;
            const double clong0 = c_ra * c_thg + s_ra * s_thg;
            const double slong0 = s_ra * c_thg - c_ra * s_thg;
            const double ax = std::fabs(clong0), ay = std::fabs(slong0);
            const bool swp = ay > ax;
            const double z_at = (swp ? ax : ay) / (swp ? ay : ax);
            const double z2_at = z_at * z_at;
            double ang = z_at * (0.99997726 + z2_at * (-0.33262347 + z2_at * (0.19354346 + z2_at * (-0.11643287 + z2_at * (0.05265332 - 0.01172120 * z2_at)))));
            if (swp) ang = (0.5 * kPi) - ang;
            if (clong0 < 0.0) ang = kPi - ang;
            const double lon = slong0 < 0.0 ? -ang : ang;
            const double dlon = kEpsDgtr * lon;
            hi_clon[n_hi] = static_cast<float>(clong0 - dlon * slong0);
            hi_slon[n_hi] = static_cast<float>(slong0 + dlon * clong0);
            double lst = tc.sec_hr + lon * (12.0 / kPi);
            lst -= 24.0 * std::floor(lst * (1.0 / 24.0));
            const double ctloc0 = c_ut * clong0 - s_ut * slong0;
            const double stloc0 = s_ut * clong0 + c_ut * slong0;
            const double dtloc = kEpsHr * lst;
            hi_ctloc[n_hi] = static_cast<float>(ctloc0 - dtloc * stloc0);
            hi_stloc[n_hi] = static_cast<float>(stloc0 + dtloc * ctloc0);
            hi_h[n_hi] = nh.h;
            hi_j[n_hi] = j;
            ++n_hi;
          } else {
            const double alpha = fm::atan2(ag.sO * cu + ag.cO * su * th, ag.cO * cu - ag.sO * su * th);
            const double td = nh.Nn / (nh.n0 + nh.W1 * nh.h * (1.0 / kRe));
            const double lat = fm::atan2(sp, cp) + td * (1.0 - (1.0 / 3.0) * td * td);
            rho_arr[j] = atm::msis_density_prepared(tc, lat, atm::wrap_pi(alpha - theta_g), nh.h < 10.0 ? 10.0 : nh.h, fl) * dca;
          }
        }
        if (n_hi > 0) {
          const int pad_hi = (n_hi + 3) & ~3;
          for (int p_i = n_hi; p_i < pad_hi; ++p_i) {
            hi_c[p_i] = hi_c[n_hi - 1];
            hi_s[p_i] = hi_s[n_hi - 1];
            hi_slon[p_i] = hi_slon[n_hi - 1];
            hi_clon[p_i] = hi_clon[n_hi - 1];
            hi_stloc[p_i] = hi_stloc[n_hi - 1];
            hi_ctloc[p_i] = hi_ctloc[n_hi - 1];
            hi_h[p_i] = hi_h[n_hi - 1];
          }
          for (int k_hi = 0; k_hi < n_hi; k_hi += 4) {
            const int rem = n_hi - k_hi < 4 ? (n_hi - k_hi) : 4;
            alignas(16) double rho_q[4];
            atm::msis_density_hi_trig4(tc, hi_c + k_hi, hi_s + k_hi, hi_slon + k_hi, hi_clon + k_hi,
                                       hi_stloc + k_hi, hi_ctloc + k_hi, hi_h + k_hi, rem, rho_q);
            for (int lane = 0; lane < rem; ++lane) {
              rho_arr[hi_j[k_hi + lane]] = rho_q[lane] * dca;
            }
          }
        }
        for (int j = 0; j < 13; ++j) {
          const double Dn = Dn_a[j], cn = pt.c[j], sn = pt.s[j], cu = cu_a[j], su = su_a[j], iD2 = iD2_a[j];
          const double K = Kw_a[j] * rho_arr[j];
          G += K;
          SD += K * Dn;
          Se += K * (e + cn);
          Ssu += K * su * cu * iD2;
          Sn += K * sn * iD_a[j];
          Snc += K * sn * cn * iD2;
          Suu += K * cu * cu * iD2;
          Ss += K * sn * (1.0 - q * th * iD2);
          Sw += K * (Dn * cn + e + cn) * iD2;
        }
      }
    } else {
      // Jacchia 1970's date terms and the Sun's direction (node_density reads them for that model only)
      const bool j70 = atmosphere == nullptr || atmosphere->model == atm::kJacchia70;
      drag::DateTerms dt{};
      double sdsun = 0.0, cdsun = 1.0, rasun = 0.0;
      if (j70) {
        double D, N;
        drag::day_of_year(d50, D, N);
        dt = drag::date_terms(fl, D, N);
        sdsun = b.sun_u.z;  // the Sun's declination
        cdsun = std::sqrt(1.0 - b.sun_u.z * b.sun_u.z);
        rasun = std::atan2(b.sun_u.y, b.sun_u.x);
      }
      const double ve = std::sqrt((1.0 - e) / (1.0 + e));
      // the pass's width (`width`): the perigee arc's nodes' second moment of M(nu), each weighted by its K
      bool core = width != nullptr;
      double Wk = 0.0, Wm2 = 0.0;
      const auto node = [&](double nu, double w) {
        double sn, cn;
        fm::sincos(nu, sn, cn);
        const double cu = ag.cw * cn - ag.sw * sn, su = ag.sw * cn + ag.cw * sn;  // u = omega + nu
        const double Dn = 1.0 + e * cn;
        const double c2u = cu * cu - su * su;
        const double r = p / Dn + cj2 * ((1.0 - th * th) * c2u - (3.0 * th * th - 1.0) * (e * cn / (1.0 + eta) + 2.0 * eta / Dn + 1.0));
        // geocentric latitude phi' = arcsin(sin i sin u), carried as its sine and (non-negative) cosine
        const double sp = si * su, cp = std::sqrt(1.0 - sp * sp);
        const NodeHeight nh = node_height(sp, cp, r);
        // above 2500 km (node_density's own test) the density is 1e-20 whatever the node's direction and time
        double rho = 1e-20;
        if (nh.h <= 2500.0) {
          const double alpha = std::atan2(ag.sO * cu + ag.cO * su * th, ag.cO * cu - ag.sO * su * th);
          double H = 0.0;
          if (j70) {
            H = alpha - rasun;
            H -= kTwoPi * std::floor(H / kTwoPi);
          }
          double d50n = d50, thn = theta_g;
          if (pass) {
            // the node's time after perigee: M(nu) / n, E = 2 atan(sqrt((1 - e) / (1 + e)) tan(nu / 2))
            const double E = 2.0 * std::atan(ve * std::tan(0.5 * nu));
            const double tau = (E - e * std::sin(E)) / n;
            d50n = d50 + tau / kMinutesPerDay;
            thn = theta_g + kOmegaE * tau;
          }
          rho = node_density(atmosphere, dt, fl, dca, d50n, sp, cp, sdsun, cdsun, H, alpha, thn, nh);
        }
        // above e 0.3 (`pass`) the co-rotating air at the node's radius r rather than the mean orbit's p / D
        const double rr = pass ? r * Dn / p : 1.0;
        const double V = pass ? std::sqrt(1.0 + 2.0 * e * cn + e * e - 2.0 * q * th * rr + q * q * cp * cp * rr * rr / (Dn * Dn))
                              : std::sqrt(1.0 + 2.0 * e * cn + e * e - 2.0 * q * th + q * q * cp * cp / (Dn * Dn));
        const double K = w * rho * V / (Dn * Dn);
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
        if (core) {
          const double E = 2.0 * std::atan(ve * std::tan(0.5 * nu));
          const double Mn = E - e * std::sin(E);
          Wk += K;
          Wm2 += K * Mn * Mn;
        }
      };
      for (int j = 0; j < 13; ++j) node(nuc * gx[j], gw[j]);
      if (core && Wk > 0.0) *width = std::sqrt(Wm2 / Wk);
      core = false;
      if (pass && nuc < kPi) {
        // the arcs nu_c < |nu| < pi: int g dnu = sum w_j (pi - nu_c) s_j g(nu_j), s_j = (x_j + 1) / 2, in the units of the
        // perigee arc's sums (whose integral is nu_c sum w_j g)
        for (int j = 0; j < 13; ++j) {
          const double sj = 0.5 * (gx[j] + 1.0);
          const double nu = nuc + (kPi - nuc) * sj * sj, w = gw[j] * (kPi - nuc) * sj / nuc;
          node(nu, w);
          node(-nu, w);
        }
      }
    }
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
  for (int m = 0; m < 6; ++m) out[m] += scale * d[m];
}

/// SPEC 4 (amendment 3): cbrt(x) = sign(x) |pow(|x|, 1/3)|, 1/3 the double 0.3333333333333333.
inline double cube_root(double x) {
  const double r = std::fabs(std::pow(std::fabs(x), 0.3333333333333333));
  return x < 0.0 ? -r : r;
}

inline thread_local double g_shadow_margin_slot = 0.0;
inline thread_local double g_shadow_margin2 = 0.0;
inline thread_local double g_shadow_margin_nu = 0.0;
inline double g_shadow_threshold = 1e-12;
inline int g_shadow_envelope = 0;

/// Diagnostics (sdnap_shadow_margin): the smallest |S(nu)| over the candidates with n(nu) < 0 at the last shadow
/// evaluation of this thread.
inline double& shadow_margin_slot() { return g_shadow_margin_slot; }

/// The second smallest |S| over the candidates with n < 0 (diagnostics: a near-miss second boundary).
inline double& shadow_margin2() { return g_shadow_margin2; }

/// The true anomaly of the candidate that set shadow_margin_slot (diagnostics).
inline double& shadow_margin_nu() { return g_shadow_margin_nu; }

/// SPEC 4's boundary test |S| < 1e-12 (diagnostics may move it: sdnap_shadow_policy 3 takes no boundary at all).
inline double& shadow_threshold() { return g_shadow_threshold; }

/// SPEC 4 (amendment 6) rounding-limited decisions, for the conformance envelope: 0 the sequence as written; 1 every
/// rounding-limited decision taken as a sunlit arc, 2 as wholly sunlit. A decision is rounding-limited when a candidate
/// with n < 0 has 1e-13 <= |S| <= 1e-11, or when moving each input (a, e, i, Omega, omega, the Sun direction) by up to
/// 8 units in the last place changes it; the setting holds for every rate evaluation, nodes and stages included.
inline int& shadow_envelope() { return g_shadow_envelope; }

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

/// The shadow from caller-supplied direction cosines.
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

/// SPEC 16.15: AP's shadow. Section 4's cylindrical shadow of radius R_E on the current mean orbit, with its boundaries
/// continuous functions of the elements (section 4's closed form and its 1e-12 test decide by rounding where a boundary
/// lies near an apse, and nearly always at geosynchronous radius). A, B the Sun's direction cosines on P and Q,
/// F = A^2 + B^2, the Sun's direction in the orbit plane at phi (cos phi = A / sqrt F, sin phi = B / sqrt F) and
/// u = nu - phi - pi the angle from the anti-Sun direction: the night half is |u| < pi/2 (n = -sqrt(F) cos u < 0), the
/// shadow is where S(u) = p^2 F cos^2 u + d^2 - p^2 > 0 (d = 1 + e cos nu), and S < 0 at both terminators (u = +-pi/2,
/// S = d^2 - p^2: the perigee is above the surface). S's largest value on the night half decides (found from u = 0, the
/// nine points u = j pi/10, |j| <= 4, and Newton's method on S' kept inside the neighbors of the best one): not above 0,
/// wholly sunlit; above 0, at some u_s, the entry is the root of S on (-pi/2, u_s) and the exit the root on (u_s, pi/2),
/// each by Newton's method kept inside its bracket (bisection where a step leaves it) to full precision. No tolerance
/// decides the branch: as the orbit leaves the season the two roots merge and the sunlit-arc rates, over E2 - E1 = 2 pi,
/// are those of the wholly sunlit orbit. One sunlit arc per revolution, as section 4. True with the arc E1 (exit) .. E2
/// (entry, + 2 pi when not above E1) and their sines and cosines; false: wholly sunlit.
inline bool shadow_arc_ap(double A, double B, double e, double eta, double p, double& E1, double& E2,
                          double& sE1, double& cE1, double& sE2, double& cE2) {
  const double F = A * A + B * B;
  const double a_min = p / (1.0 + e);
  // no point of the orbit can be in the cylinder: S <= p^2 F + (1 + e)^2 - p^2 < 0
  if (!(F > 0.0) || (F < 1.0 && (1.0 - F) * a_min * a_min > 1.000002)) return false;
  const double c = std::sqrt(F), cph = A / c, sph = B / c, pp = p * p, k2 = pp * F;
  struct Pt {
    double S, dS, d2S, cn, sn;
  };
  // S, dS/du, d2S/du2 and cos nu, sin nu at u (cos nu = -(cos phi cos u - sin phi sin u), sin nu = -(sin phi cos u +
  // cos phi sin u))
  auto at = [&](double u) {
    double su, cu;
    fm::sincos(u, su, cu);
    Pt q;
    q.cn = sph * su - cph * cu;
    q.sn = -(sph * cu + cph * su);
    const double d = 1.0 + e * q.cn;
    q.S = (d * d - pp) + k2 * (cu * cu);
    q.dS = -2.0 * (k2 * (cu * su) + e * d * q.sn);
    q.d2S = -2.0 * k2 * (cu * cu - su * su) + 2.0 * e * (e * q.sn * q.sn - d * q.cn);
    return q;
  };
  constexpr double kHalfPi = 0.5 * kPi, kStep = 0.1 * kPi;
  double us = 0.0;
  Pt q = at(0.0);
  if (!(q.S > 0.0)) {
    int best = 0;
    for (int j = -4; j <= 4; ++j) {
      if (j == 0) continue;
      const Pt t = at(j * kStep);
      if (t.S > q.S) { q = t; best = j; }
    }
    us = best * kStep;
    // the largest S near the best point: Newton's method on S', kept inside the best point's neighbors, until S > 0
    // or S' vanishes
    double lo = std::fmax(-kHalfPi, us - kStep), hi = std::fmin(kHalfPi, us + kStep);
    for (int it = 0; it < 80 && !(q.S > 0.0); ++it) {
      if (q.dS > 0.0) lo = us;
      else hi = us;
      double un = q.d2S < 0.0 ? us - q.dS / q.d2S : 0.5 * (lo + hi);
      if (!(un > lo && un < hi)) un = 0.5 * (lo + hi);
      const bool last = std::fabs(un - us) <= 1e-15 || hi - lo <= 1e-15;
      us = un;
      q = at(us);
      if (last) break;
    }
    if (!(q.S > 0.0)) return false;
  }
  // the root of S between u_neg (S < 0) and u_pos (S > 0), from u0
  auto root = [&](double u_neg, double u_pos, double u0) {
    double u = u0;
    for (int it = 0; it < 100; ++it) {
      const Pt t = at(u);
      if (t.S == 0.0) return t;
      if (t.S < 0.0) u_neg = u;
      else u_pos = u;
      const double lo = std::fmin(u_neg, u_pos), hi = std::fmax(u_neg, u_pos);
      double un = t.dS != 0.0 ? u - t.S / t.dS : 0.5 * (lo + hi);
      if (!(un > lo && un < hi)) un = 0.5 * (lo + hi);
      if (std::fabs(un - u) <= 1e-15 || hi - lo <= 1e-15) return at(un);
      u = un;
    }
    return at(u);
  };
  // the start from the circular orbit's boundary: k2 cos^2 u = p^2 - d^2 with d held at u_s
  const double ds = 1.0 + e * q.cn;
  const double c0 = std::sqrt(std::fmax(0.0, std::fmin(1.0, (pp - ds * ds) / k2)));
  const double u0 = std::acos(c0);
  const double ue = -u0 > -kHalfPi && -u0 < us ? -u0 : 0.5 * (us - kHalfPi);
  const double ux = u0 > us && u0 < kHalfPi ? u0 : 0.5 * (us + kHalfPi);
  const Pt entry = root(-kHalfPi, us, ue), exit = root(kHalfPi, us, ux);
  constexpr double kTwoPiD = 6.283185307179586;
  const double inv_d1 = 1.0 / (1.0 + e * exit.cn);
  sE1 = eta * exit.sn * inv_d1;
  cE1 = (e + exit.cn) * inv_d1;
  E1 = std::atan2(sE1, cE1);
  if (E1 < 0.0) E1 += kTwoPiD;
  const double inv_d2 = 1.0 / (1.0 + e * entry.cn);
  sE2 = eta * entry.sn * inv_d2;
  cE2 = (e + entry.cn) * inv_d2;
  E2 = std::atan2(sE2, cE2);
  if (E2 < 0.0) E2 += kTwoPiD;
  if (E2 <= E1) E2 += kTwoPiD;
  return true;
}

/// SPEC 16.15 diagnostics: section 4's sphere (the force P AGOM (1 AU / r_sun)^2 away from the Sun) averaged over one
/// revolution of the mean orbit y, the Sun held fixed (unit vector s, distance sun_r in R_E), by the Gauss equations at
/// the midpoints of nq equal steps of the eccentric longitude weighted by r / a; lambda's rate also carries section 4's
/// periodic mean-motion term Delta n = 3 F_s (A cos E + B eta sin E) / (a n) averaged over the whole revolution, as AP's
/// mean longitude does (16.16; A, B the Sun's direction cosines on P and Q). shape 1: section 4's cylinder of radius R_E, a step its boundary crosses split
/// where the boundary is (bisection on the position's own test, n < 0 and |r x s| < R_E); shape 2: a cone, the
/// illuminated fraction of the Sun's disc (radius kSunRadiusKm) behind the Earth's (radius R_E) as seen from the
/// satellite, a step not wholly lit or wholly dark at both ends taken in 64 equal parts. out: the six rates in the state
/// order, per minute (lambda's without n).
constexpr double kSunRadiusKm = 695700.0;
inline void srp_average_numeric(const double* y, const Frame& fr, const Kepler& k, Vec3 s, double sun_r, double agom,
                                int shape, int nq, double A, double B, double* out) {
  for (int m = 0; m < 6; ++m) out[m] = 0.0;
  const double rs_au = sun_r * kRe / kAu;
  const double Fs = kSrpPressure * agom * 3600.0 / (1000.0 * kRe * rs_au * rs_au);
  const Vec3 acc = (-Fs) * s, sun = sun_r * s;
  const double varpi = std::atan2(y[kAg], y[kAf]), dn_a = 3.0 * Fs * A / (k.a * fr.n), dn_b = 3.0 * Fs * B * fr.eta / (k.a * fr.n);
  const double r_sun = kSunRadiusKm / kRe;
  // the illuminated fraction at eccentric longitude F
  auto lit = [&](double F) {
    Vec3 r, v;
    double roa;
    state_at_F(y, fr, F, r, v, roa);
    if (shape == 1) {
      const double rs = dot(r, s);
      return rs < 0.0 && dot(r, r) - rs * rs < 1.0 ? 0.0 : 1.0;
    }
    const Vec3 d = sun - r;
    const double rn = norm(r), dn = norm(d);
    const double a = std::asin(std::fmin(1.0, r_sun / dn)), b = std::asin(std::fmin(1.0, 1.0 / rn));
    const double c = std::acos(std::fmax(-1.0, std::fmin(1.0, -dot(r, d) / (rn * dn))));
    if (c >= a + b) return 1.0;
    if (c <= b - a) return 0.0;
    if (c <= a - b) return 1.0 - (b * b) / (a * a);
    const double x = (c * c + a * a - b * b) / (2.0 * c), yy = std::sqrt(std::fmax(0.0, a * a - x * x));
    const double area = a * a * std::acos(std::fmax(-1.0, std::fmin(1.0, x / a))) + b * b * std::acos(std::fmax(-1.0, std::fmin(1.0, (c - x) / b))) - c * yy;
    return 1.0 - area / (kPi * a * a);
  };
  auto add = [&](double F, double w) {
    Vec3 r, v;
    double roa, g[6];
    state_at_F(y, fr, F, r, v, roa);
    gauss(y, fr, r, v, acc, g);
    for (int m = 0; m < 6; ++m) out[m] += w * roa * g[m];
  };
  const int N = nq > 0 ? nq : 4096;
  const double h = kTwoPi / N;
  for (int j = 0; j < N; ++j) {
    // lambda: Delta n over the whole revolution (16.16)
    Vec3 r, v;
    double roa;
    const double Fm = (j + 0.5) * h;
    state_at_F(y, fr, Fm, r, v, roa);
    out[kLam] += h * roa * (dn_a * std::cos(Fm - varpi) + dn_b * std::sin(Fm - varpi));
  }
  for (int j = 0; j < N; ++j) {
    const double F0 = j * h, F1 = F0 + h;
    const double l0 = lit(F0), l1 = lit(F1);
    if (l0 == l1 && (l0 == 0.0 || l0 == 1.0)) {
      if (l0 == 1.0) add(F0 + 0.5 * h, h);
      continue;
    }
    if (shape == 1) {
      double lo = F0, hi = F1;
      for (int it = 0; it < 60; ++it) {
        const double mid = 0.5 * (lo + hi);
        if (lit(mid) == l0) lo = mid;
        else hi = mid;
      }
      const double Fb = 0.5 * (lo + hi);
      if (l0 == 1.0) add(0.5 * (F0 + Fb), Fb - F0);
      else add(0.5 * (Fb + F1), F1 - Fb);
      continue;
    }
    const double hs = h / 64.0;
    for (int q = 0; q < 64; ++q) {
      const double Fm = F0 + (q + 0.5) * hs, f = lit(Fm);
      if (f > 0.0) add(Fm, f * hs);
    }
  }
  for (int m = 0; m < 6; ++m) out[m] /= kTwoPi;
}

/// AP's shadow decision (SPEC 16.15) at direction cosines A, B: shadow_arc_ap, or wholly sunlit under the diagnostic
/// that takes no boundary at all (sdnap_shadow_policy 3, threshold 0).
inline bool ap_sunlit_arc(double A, double B, double e, double eta, double p, double& E1, double& E2, double& sE1,
                          double& cE1, double& sE2, double& cE2) {
  if (shadow_threshold() == 0.0) return false;
  return shadow_arc_ap(A, B, e, eta, p, E1, E2, sE1, cE1, sE2, cE2);
}

/// SPEC 16.16: what an AP set's mean longitude adds to section 4's sunlit-arc rate. Section 4's rate of lambda over a
/// sunlit arc counts the output-time mean-motion term Delta n = 3 F_s (A cos E + B eta sin E) / (a n) on the sunlit arc
/// only, while section 4's output-time terms map n_osc = n_mean + Delta n over the whole revolution (they carry no
/// shadow): the mean longitude takes Delta n over the whole revolution, so its share over the shadow is added,
/// (1 / 2 pi) int_{E2}^{E1 + 2 pi} Delta n (1 - e cos E) dE = 3 F_s / (2 pi a n) [G(E1 + 2 pi) - G(E2)],
/// G(E) = A sin E - B eta cos E - e (A (E / 2 + sin E cos E / 2) + B eta sin^2 E / 2); 0 as the shadow vanishes.
inline double ap_lambda_shadow_dn(double A, double B, double e, double eta, double a, double n, double Fs, double E1,
                                  double E2) {
  auto G = [&](double E) {
    double s, c;
    fm::sincos(E, s, c);
    return A * s - B * eta * c - e * (A * (0.5 * E + 0.5 * s * c) + B * eta * 0.5 * s * s);
  };
  return 3.0 * Fs / (kTwoPi * a * n) * (G(E1 + kTwoPi) - G(E2));
}

/// SPEC 4 averaged SRP rates on the current mean orbit (Sun held fixed over
/// the orbit): the explicit formulas of the wholly sunlit orbit or of the sunlit
/// arc E1 .. E2 (xp_spec_terms.inc), added to the rates in the state order. An AP set (ap_set) takes AP's shadow
/// (SPEC 16.15) and, where `ap` and its angles allow, AP's arrangement of the same formulas; SGP4XP section 4's. An
/// AP set's mean longitude over a sunlit arc also takes ap_lambda_shadow_dn (SPEC 16.16).
inline void srp_rates(const double* /*y*/, const Frame& fr, const Kepler& k, const Perifocal& pf, double agom,
                      const Bodies& b, double* out, const AngleTrig* ag_opt = nullptr, bool ap = false,
                      bool* sunlit_safe = nullptr, bool ap_set = false) {
  double A, B, C;
  direction_cosines(pf, b.sun_u, A, B, C);
  if (sunlit_safe != nullptr) {
    const double F_sun = A * A + B * B, a_min = k.a * (1.0 - k.e);
    *sunlit_safe = F_sun < 1.0 && (1.0 - F_sun) * a_min * a_min > 1.01;
  }
  const double rs_au = b.sun_r * kRe / kAu;
  const double Fs = kSrpPressure * agom * 3600.0 / (1000.0 * kRe * rs_au * rs_au);
  double E1, E2, d[6];
  if (ap_set) {
    double sE1, cE1, sE2, cE2;
    const bool arc = ap_sunlit_arc(A, B, k.e, fr.eta, (1.0 - fr.e2) * k.a, E1, E2, sE1, cE1, sE2, cE2);
    if (ap && ag_opt != nullptr && (!fr.e2 || k.a < 5.0 || ag_opt->si > 0.02)) {
      if (arc) {
        srp_rates_arc_ap(k.e, fr.eta, ag_opt->sw, ag_opt->cw, ag_opt->sO, ag_opt->cO, ag_opt->si, ag_opt->ci,
                         k.a, fr.n, E1, E2, sE1, cE1, sE2, cE2, A, B, C, Fs, d);
      } else {
        srp_rates_sunlit_ap(k.e, fr.eta, ag_opt->sw, ag_opt->cw, ag_opt->sO, ag_opt->cO, ag_opt->si, ag_opt->ci,
                            k.a, fr.n, A, B, C, Fs, d);
      }
    } else if (arc) {
      srp_rates_arc(k.e, fr.eta, k.argp, k.node, k.i, k.a, fr.n, E1, E2, A, B, C, Fs, d);
    } else {
      srp_rates_sunlit(k.e, fr.eta, k.argp, k.node, k.i, k.a, fr.n, A, B, C, Fs, d);
    }
    if (arc) d[kLam] += ap_lambda_shadow_dn(A, B, k.e, fr.eta, k.a, fr.n, Fs, E1, E2);
  } else if (xp_shadow(k, b.sun_u, E1, E2)) {
    srp_rates_arc(k.e, fr.eta, k.argp, k.node, k.i, k.a, fr.n, E1, E2, A, B, C, Fs, d);
  } else {
    srp_rates_sunlit(k.e, fr.eta, k.argp, k.node, k.i, k.a, fr.n, A, B, C, Fs, d);
  }
  for (int m = 0; m < 6; ++m) out[m] += d[m];
}

#include "resonance.inc"
#include "tesseral.inc"

struct XpSat;

inline uint64_t next_ctx_id() {
  static uint64_t next = 1;
  return __atomic_fetch_add(&next, 1, __ATOMIC_RELAXED);
}

/// A set's branch (SPEC 16.7, 17.7): the switches its epoch mean motion n0 (rad/min) and eccentricity e0 decide once, for
/// the whole flight. AP's mean elements are defined per branch: two sets on different branches are different orbits, never
/// differenced or blended. The eccentricity switches exist only with AP's terms selected (`ap`).
struct Branch {
  int8_t resonance = 0;     ///< SPEC 6 class (res::band_of)
  uint8_t long_period = 0;  ///< period >= 1100 min (SPEC 5, 9)
  uint8_t wide_tess = 0;    ///< AP: the first-order tesseral families on the grid (tess::wide_set: 0.05 in class 0, else 0.3)
  uint8_t wide_e = 0;       ///< AP: e0 above tess::kWideE, the zonal tail's every long-period term and the perigee drag passage
  uint8_t series_e = 0;     ///< AP: e0 above res::kSeriesE, the class's G about e0 (SPEC 6.4)
  /// The long-period regime's step, minutes (SPEC 9, 16.10): 95, AP's one-day class 38, and an AP set above e0 0.3 at most
  /// half the perigee pass's time scale (1 - e0)^(3/2) / n0. Not a switch: a moved set flies its nominal's, as the rest.
  double lp_step = kLongPeriodStep;
  bool operator==(const Branch& o) const {
    return resonance == o.resonance && long_period == o.long_period && wide_tess == o.wide_tess && wide_e == o.wide_e &&
           series_e == o.series_e;
  }
  bool operator!=(const Branch& o) const { return !(*this == o); }
};
inline Branch branch_of(double n0, double e0, bool ap) {
  Branch b;
  b.resonance = static_cast<int8_t>(res::band_of(n0));
  b.long_period = (kTwoPi / n0) >= kLongPeriodMinutes ? 1 : 0;
  if (ap) {
    b.wide_tess = tess::wide_set(b.resonance, e0) ? 1 : 0;
    b.wide_e = e0 > tess::kWideE ? 1 : 0;
    b.series_e = e0 > res::kSeriesE ? 1 : 0;  // strictly above, as the other two: e0 exactly 0.3 is the below side (stack #504)
  }
  if (b.long_period && ap) {
    b.lp_step = b.resonance == 1 ? 38.0 : kLongPeriodStep;
    if (b.wide_e) b.lp_step = std::fmin(b.lp_step, 0.5 * std::pow(1.0 - e0, 1.5) / n0);
  }
  return b;
}
/// The switch two branches differ by, in words.
inline const char* switch_name(const Branch& a, const Branch& b) {
  if (a.long_period != b.long_period) return "1,100-minute regime limit";
  if (a.resonance != b.resonance) return "resonance class limit";
  if (a.wide_tess != b.wide_tess) return "eccentricity switch of the first-order tesseral families";
  return "eccentricity switch at 0.3";
}
/// The switch whose limit lies within eps_n (relative, in n0) or eps_e (in e0) of the epoch elements, or nullptr.
inline const char* switch_near(double n0, double e0, bool ap, double eps_n = 1e-3, double eps_e = 1e-3) {
  const Branch b = branch_of(n0, e0, ap);
  const Branch q[4] = {branch_of(n0 * (1.0 - eps_n), e0, ap), branch_of(n0 * (1.0 + eps_n), e0, ap),
                       branch_of(n0, e0 > eps_e ? e0 - eps_e : 0.0, ap), branch_of(n0, e0 + eps_e, ap)};
  for (const Branch& o : q)
    if (o != b) return switch_name(b, o);
  return nullptr;
}

/// Per-object constants of the rate function.
struct RateContext {
  uint64_t ctx_id;
  uint64_t cov_anchor_id;
  double d50_epoch;
  tess::Terms selected_terms;  ///< AP force selection
  double bterm, agom;
  double rad_y0;        ///< AP: the radiation term Y0 beside the sphere, m/s^2 (SPEC 16.13); 0: none
  uint8_t solid_tides;  ///< AP: the solid Earth tide in the rates (SPEC 16.14)
  double tide_k1[2];    ///< AP: step 2's diurnal band at the epoch, the tensor's xz and yz (ER^5/min^2; SPEC 16.14)
  uint8_t long_period;  ///< epoch period >= 1100 min (SPEC 5, 9)
  int8_t resonance;     ///< SPEC 6 class at the epoch (0 none, 1 one-day, 2 half-day, 3 eight-hour, 4 sixteen-hour), held
                        ///< for the whole flight in both theories (SPEC 6 Bands, 16.7)
  Branch branch;        ///< the switches the epoch elements decided (resonance and long_period are its first two)
  const res::ResCoef* res_epoch;   ///< SGP4XP: the epoch class's terms at e_0, i_0, integrated (owned, xp_release)
  int32_t res_count;
  double theta_g0;      ///< Greenwich angle at epoch (SPEC 1.2)
  const atm::Atmosphere* atmosphere;  ///< the drag's atmosphere (null: the theory's own, SPEC 3; atmosphere.inc)
  double e0, i0, a0, n0;              ///< AP: epoch e, i (rad), a (ER), n (rad/min)
  double hd_e0, hd_i0, hd_a0;         ///< AP: reference e, i and a of half_day table
  const tess::HalfDayCoef* half_day;  ///< AP degree 6..31 resonant tail (owned)
  int32_t half_day_count;
  uint8_t shared_mask;                ///< bitmask of borrowed pointers from anchor (not freed by xp_release); bit 128 (wide_slow) is
                                      ///< its last free bit: the next shared table needs a wider mask
  uint8_t ap_resonance;               ///< AP: the epoch class's terms, functions at the current elements (SPEC 16.2, 16.7)
  uint8_t ap_frame;                   ///< AP: selected epoch-axis branch needs TEME-of-date output correction (SPEC 16.4)
  uint8_t ap_third_body;              ///< AP: the third bodies' degree 4-10 averaged rates and degree 2-10 short-period
                                      ///< terms by quadrature (SPEC 5.4, 16.8)
  const res::GTaylor* res_taylor;     ///< AP: the epoch class's G about e_0 > res::kSeriesE (owned, xp_release)
  const tess::ShallowCoef* shallow;   ///< AP: shallow resonant terms, in the rates (owned, xp_release)
  int32_t shallow_count;
  int32_t slow_extra;                 ///< SPEC 16.18: of shallow_count, the slow set's own terms (beyond the shallow set's)
  const res::ResCoef* wide_slow;      ///< AP above the switch outside low orbit: the other slow terms, in the rates (owned, xp_release; stack #473)
  int32_t wide_slow_count;
  const float* zt;                    ///< AP: zonal tail, in the rates: Fbar, dFbar, g0, g1 (owned, xp_release)
  int32_t zt_degree;
  double zt_er;                       ///< AP: eccentricity anchor of the shared zonal tail's |w| >= 2 coefficients
  uint8_t zt_wide;                    ///< AP: the tail carries every long-period term (tess::kWideE, SPEC 16.11)
  uint8_t drag_pass;                  ///< AP: epoch e above tess::kWideE, the drag rates of the perigee passages (SPEC 16.12)
  const float* mdaily;                ///< AP: m-daily Fbar, dFbar/di pairs, at output time (owned, xp_release)
  int32_t mdaily_degree;
  const tess::SpCoef* sp;             ///< AP: the other first-order tesseral terms, at output time (owned, xp_release)
  int32_t sp_count;
  const tess::SpCombCoef* sp_comb;    ///< AP: combined (l, m, k) first-order tesseral terms for fast SIMD evaluation
  int32_t sp_comb_count;
  double sp_ci0;                      ///< cos i of the set whose epoch built sp_comb: the cos i its grouping uses

  const tess::SpCoef* sp_orig;        ///< AP: original sp pointer for diagnostic override detection
  int32_t sp_orig_count;
  tess::WideGrid* wide;               ///< AP above tess::kWideE: the first-order tesseral families' grid (SPEC 16.11)
  uint8_t wide_owned;                 ///< this context drops its reference to `wide` (xp_release)
  const tess::WideGrid* wide_next;    ///< a call's next schedule node's grid (xp_propagate), blended in by wide_blend
  double wide_blend;
  uint8_t wide_fit;                   ///< initialized inside a tess::FitGridScope: the grids it builds are not kept idle
  double wide_a;                      ///< the long-period regime with the Sun and Moon: the epoch's a, every node's and the grid's a offset (SPEC 16.11); 0 otherwise
  uint8_t is_cov_sigma;               ///< non-zero if initialized inside CovBankScope as a covariance sigma satellite
  XpSat* wide_anchor;                 ///< the nominal set whose grids this copy reads (GridShareScope); nullptr: its own
};

inline uint64_t hd_table_id(const RateContext& ctx) { return (ctx.shared_mask & 1) ? ctx.cov_anchor_id : ctx.ctx_id; }
inline uint64_t sh_table_id(const RateContext& ctx) { return (ctx.shared_mask & 8) ? ctx.cov_anchor_id : ctx.ctx_id; }
inline uint64_t zt_table_id(const RateContext& ctx) { return (ctx.shared_mask & 16) ? ctx.cov_anchor_id : ctx.ctx_id; }
inline uint64_t md_table_id(const RateContext& ctx) { return (ctx.shared_mask & 32) ? ctx.cov_anchor_id : ctx.ctx_id; }

inline bool is_ap_ctx(const RateContext& ctx) {
  return ctx.ap_third_body != 0 || ctx.ap_resonance != 0 || ctx.ap_frame != 0;
}

/// Stack #583: whether xp_init keeps the output table's raw term list (RateContext::sp) beside its combined entries. A flight
/// reads the combined table alone, so a stored or flown set does not keep it; the field census (census_rows reads each term's
/// weight from it) sets it for the set it builds (KeepSpRaw), per thread.
inline bool& keep_sp_raw() {
  static thread_local bool keep = false;
  return keep;
}
struct KeepSpRaw {
  bool prev;
  KeepSpRaw() : prev(keep_sp_raw()) { keep_sp_raw() = true; }
  ~KeepSpRaw() { keep_sp_raw() = prev; }
  KeepSpRaw(const KeepSpRaw&) = delete;
  KeepSpRaw& operator=(const KeepSpRaw&) = delete;
};

/// SPEC 16.23 (stack #503, #532): the constant radial term the zonal theory leaves out, R_E, for the mean semi-major axis a
/// (R_E) and cos^2 of the mean inclination. Held to the dynamics' mean rates, the theory's mean radius of a near-circular
/// orbit sits (R_E^4 / a^3) [J2^2 (199 c^4 - 80 c^2 + 25) / 32 - J4 (15/64)(35 s^4 - 40 s^2 + 8)] above the true one (c, s
/// the cosine and sine of i; J2 and J4 of 1.3): the J4 part first order, the J2^2 part exact at i = 0 (9/2) and fitted
/// to the dynamics' second order elsewhere (25/32 at i = 90 deg, exact 13/16). AP's output adds its negative, at the
/// same osculating energy, at every eccentricity (its eccentric terms are stack #532).
inline double zonal_radius_term(double a, double c2) {
  const double s2 = 1.0 - c2, ia = 1.0 / a;
  return -(ia * ia * ia) * (kJ2 * kJ2 * (199.0 * c2 * c2 - 80.0 * c2 + 25.0) * (1.0 / 32.0) -
                            kJ4 * (15.0 / 64.0) * (35.0 * s2 * s2 - 40.0 * s2 + 8.0));
}

/// SPEC 16.23: the factor on the transverse speed rf (R_E/min) of a state at radius r (R_E) moved radially by d (R_E) that
/// keeps its osculating energy, rf^2 / 2 + rdot^2 / 2 - mu / r (the radial speed kept): sqrt(1 - 2 mu d / (r (r + d) rf^2)).
inline double energy_speed_factor(double r, double d, double rf) {
  const double q = 1.0 - 2.0 * kMu * d / (r * (r + d) * rf * rf);
  return q > 0.0 ? std::sqrt(q) : 1.0;
}

/// SPEC 16.23: a Cartesian state (km, km/s) moved radially by d km at the same osculating energy: the position along r-hat
/// by d, the transverse velocity scaled by energy_speed_factor, the radial velocity kept.
inline void radial_shift(double r[3], double v[3], double d) {
  const double rn = std::sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
  if (!(rn > 0.0)) return;
  const double vr = (r[0] * v[0] + r[1] * v[1] + r[2] * v[2]) / rn;
  double vt2 = 0.0;
  for (int j = 0; j < 3; ++j) { const double vt = v[j] - vr * r[j] / rn; vt2 += vt * vt; }
  if (!(vt2 > 0.0)) return;
  constexpr double kMinPerS = 60.0;
  const double f = energy_speed_factor(rn / kRe, d / kRe, std::sqrt(vt2) * kMinPerS / kRe);
  for (int j = 0; j < 3; ++j) {
    const double rh = r[j] / rn, vt = v[j] - vr * rh;
    r[j] += d * rh;
    v[j] += (f - 1.0) * vt;
  }
}

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

/// AP (SPEC 16.8): a body's tidal acceleration at r of Legendre degrees lo to hi (ER/min^2):
/// mu_b r^(l-1) / r_b^(l+1) [(l P_l - u P_l') r_hat + P_l' s_hat], u = r_hat . s_hat.
constexpr int kThirdBodyTailDegree = 10;
constexpr int kThirdBodyTailNodes = 32;
inline constexpr double kInvLp1[17] = {
    1.0,        1.0 / 2.0,  1.0 / 3.0,  1.0 / 4.0,  1.0 / 5.0,  1.0 / 6.0,
    1.0 / 7.0,  1.0 / 8.0,  1.0 / 9.0,  1.0 / 10.0, 1.0 / 11.0, 1.0 / 12.0,
    1.0 / 13.0, 1.0 / 14.0, 1.0 / 15.0, 1.0 / 16.0, 1.0 / 17.0,
};
inline Vec3 tidal_tail(Vec3 r, Vec3 su, double sr, double mass_ratio, int lo, int hi) {
  const double rn = norm(r);
  const Vec3 ru = (1.0 / rn) * r;
  const double u = dot(ru, su), x = rn / sr;
  double pm = 1.0, p = u, dm = 0.0, dp = 1.0, xp = 1.0, ar = 0.0, as = 0.0;
  for (int l = 1; l < hi; ++l) {
    const double pn = ((2 * l + 1) * u * p - l * pm) * kInvLp1[l];
    const double dn = dm + (2 * l + 1) * p;  // P'_{l+1} = P'_{l-1} + (2l + 1) P_l
    pm = p;
    p = pn;
    dm = dp;
    dp = dn;
    xp *= x;  // (r / r_b)^(L - 1), L = l + 1
    const int L = l + 1;
    if (L >= lo) {
      ar += xp * (L * p - u * dp);
      as += xp * dp;
    }
  }
  const double k = mass_ratio * kMu / (sr * sr);
  return (k * ar) * ru + (k * as) * su;
}

struct NodeTrig {
  alignas(16) double c[kThirdBodyTailNodes]{}, s[kThirdBodyTailNodes]{};  ///< cos, sin of 2 pi k / kThirdBodyTailNodes
  alignas(16) double c16[16]{}, s16[16]{};                                ///< cos, sin of 2 pi k / 16
  alignas(16) double cm[17][kThirdBodyTailNodes]{};                       ///< cos(m * F_j)
  alignas(16) double sm[17][kThirdBodyTailNodes]{};                       ///< sin(m * F_j)
};
inline constexpr NodeTrig kNodeTrig = []() constexpr {
  NodeTrig r{};
  for (int k = 0; k < kThirdBodyTailNodes; ++k) {
    fm::sincos(kTwoPi * k / kThirdBodyTailNodes, r.s[k], r.c[k]);
  }
  r.c[0] = 1.0;
  r.s[0] = 0.0;
  r.c[kThirdBodyTailNodes / 4] = 0.0;
  r.s[kThirdBodyTailNodes / 4] = 1.0;
  r.c[kThirdBodyTailNodes / 2] = -1.0;
  r.s[kThirdBodyTailNodes / 2] = 0.0;
  r.c[(3 * kThirdBodyTailNodes) / 4] = 0.0;
  r.s[(3 * kThirdBodyTailNodes) / 4] = -1.0;
  for (int k = 0; k < 16; ++k) {
    r.c16[k] = r.c[2 * k];
    r.s16[k] = r.s[2 * k];
  }
  for (int m = 0; m <= 16; ++m) {
    for (int j = 0; j < kThirdBodyTailNodes; ++j) {
      const int idx = (j * m) & (kThirdBodyTailNodes - 1);
      r.cm[m][j] = r.c[idx];
      r.sm[m][j] = r.s[idx];
    }
  }
  return r;
}();
inline const NodeTrig& node_trig() { return kNodeTrig; }

/// The Gauss rates (state order) of the Sun's and the Moon's tidal terms of degree lo to hi on the mean orbit at the
/// eccentric longitudes F_j = 2 pi j / kThirdBodyTailNodes, each body at its position in b, and the weights r/a.
struct TailSamples {
  alignas(16) double f[6][kThirdBodyTailNodes];
  alignas(16) double w[kThirdBodyTailNodes];
};
inline void tail_samples(const double* y, const Frame& fr, const Bodies& b, int lo, int hi, TailSamples& s) {
  const NodeTrig& nt = node_trig();
  const double k = y[kAf], h = y[kAg], chi = y[kChi], psi = y[kPsi];
  const double beta = 1.0 / (1.0 + fr.eta);
  const double c_xx = 1.0 - h * h * beta;
  const double c_xy = h * k * beta;
  const double c_yy = 1.0 - k * k * beta;
  const double na = fr.n * fr.a;
  const double na2 = na * fr.a;
  const double hn = na2 * fr.eta;
  const double inv_hn = 1.0 / hn;
  const double inv_mu = 1.0 / kMu;
  const double two_a2_mu = 2.0 * fr.a * fr.a * inv_mu;
  const double neg_3n_2a = -1.5 * fr.n / fr.a;
  const double p = fr.a * fr.eta * fr.eta;
  const double inv_p = 1.0 / p;
  const double two_inv_na2 = 2.0 / na2;
  const double eta_na_1peta = fr.eta / (na * (1.0 + fr.eta));
  const double c_half_inv_hn = 0.5 * fr.c * inv_hn;

  const double suf = dot(b.sun_u, fr.f), sug = dot(b.sun_u, fr.g), suw = dot(b.sun_u, fr.w);
  const double muf = dot(b.moon_u, fr.f), mug = dot(b.moon_u, fr.g), muw = dot(b.moon_u, fr.w);
  const double inv_sr = 1.0 / b.sun_r, inv_mr = 1.0 / b.moon_r;
  const double k_sun = kSunMass * kMu * inv_sr * inv_sr;
  const double k_moon = kMoonMass * kMu * inv_mr * inv_mr;

  const int hi_m = fr.a < 1.6 ? std::min(hi, 5) : (fr.a < 5.0 ? std::min(hi, 7) : hi);
  const int hi_s = lo >= 4 ? 1 : std::min(hi, 3);

#ifdef __wasm_simd128__
  const v128_t v_one = wasm_f64x2_splat(1.0);
  const v128_t v_two = wasm_f64x2_splat(2.0);
  const v128_t v_zero = wasm_f64x2_splat(0.0);
  const v128_t v_k = wasm_f64x2_splat(k), v_h = wasm_f64x2_splat(h);
  const v128_t v_chi = wasm_f64x2_splat(chi), v_psi = wasm_f64x2_splat(psi);
  const v128_t v_a = wasm_f64x2_splat(fr.a), v_na2 = wasm_f64x2_splat(na2);
  const v128_t v_cxx = wasm_f64x2_splat(c_xx), v_cxy = wasm_f64x2_splat(c_xy), v_cyy = wasm_f64x2_splat(c_yy);
  const v128_t v_inv_hn = wasm_f64x2_splat(inv_hn), v_inv_mu = wasm_f64x2_splat(inv_mu);
  const v128_t v_two_a2_mu = wasm_f64x2_splat(two_a2_mu), v_neg_3n_2a = wasm_f64x2_splat(neg_3n_2a);
  const v128_t v_inv_p = wasm_f64x2_splat(inv_p), v_two_inv_na2 = wasm_f64x2_splat(two_inv_na2);
  const v128_t v_eta_na_1peta = wasm_f64x2_splat(eta_na_1peta), v_c_half_inv_hn = wasm_f64x2_splat(c_half_inv_hn);
  const v128_t v_suf = wasm_f64x2_splat(suf), v_sug = wasm_f64x2_splat(sug), v_suw = wasm_f64x2_splat(suw);
  const v128_t v_muf = wasm_f64x2_splat(muf), v_mug = wasm_f64x2_splat(mug), v_muw = wasm_f64x2_splat(muw);
  const v128_t v_inv_sr = wasm_f64x2_splat(inv_sr), v_inv_mr = wasm_f64x2_splat(inv_mr);
  const v128_t v_ksun = wasm_f64x2_splat(k_sun), v_kmoon = wasm_f64x2_splat(k_moon);

  for (int j = 0; j < kThirdBodyTailNodes; j += 2) {
    const v128_t cf = wasm_v128_load(nt.c + j);
    const v128_t sf = wasm_v128_load(nt.s + j);
    const v128_t roa = wasm_f64x2_sub(wasm_f64x2_sub(v_one, wasm_f64x2_mul(v_k, cf)), wasm_f64x2_mul(v_h, sf));
    wasm_v128_store(s.w + j, roa);
    const v128_t rn = wasm_f64x2_mul(v_a, roa);
    const v128_t inv_rn = wasm_f64x2_div(v_one, rn);
    const v128_t X = wasm_f64x2_mul(v_a, wasm_f64x2_sub(wasm_f64x2_add(wasm_f64x2_mul(v_cxx, cf), wasm_f64x2_mul(v_cxy, sf)), v_k));
    const v128_t Y = wasm_f64x2_mul(v_a, wasm_f64x2_sub(wasm_f64x2_add(wasm_f64x2_mul(v_cxy, cf), wasm_f64x2_mul(v_cyy, sf)), v_h));
    const v128_t xu = wasm_f64x2_mul(X, inv_rn);
    const v128_t yu = wasm_f64x2_mul(Y, inv_rn);
    const v128_t v_scale = wasm_f64x2_mul(v_na2, inv_rn);
    const v128_t Xd = wasm_f64x2_mul(v_scale, wasm_f64x2_sub(wasm_f64x2_mul(v_cxy, cf), wasm_f64x2_mul(v_cxx, sf)));
    const v128_t Yd = wasm_f64x2_mul(v_scale, wasm_f64x2_sub(wasm_f64x2_mul(v_cyy, cf), wasm_f64x2_mul(v_cxy, sf)));

    v128_t ars = v_zero, ass = v_zero;
    if (hi_s > 1) {
      const v128_t us = wasm_f64x2_add(wasm_f64x2_mul(xu, v_suf), wasm_f64x2_mul(yu, v_sug));
      const v128_t xs = wasm_f64x2_mul(rn, v_inv_sr);
      v128_t pms = v_one, ps = us, dms = v_zero, dps = v_one, xps = v_one;
      for (int l = 1; l < hi_s; ++l) {
        const v128_t vc2l1 = wasm_f64x2_splat(static_cast<double>(2 * l + 1));
        const v128_t vl = wasm_f64x2_splat(static_cast<double>(l));
        const v128_t vilp1 = wasm_f64x2_splat(kInvLp1[l]);
        const v128_t pns = wasm_f64x2_mul(wasm_f64x2_sub(wasm_f64x2_mul(wasm_f64x2_mul(vc2l1, us), ps), wasm_f64x2_mul(vl, pms)), vilp1);
        const v128_t dns = wasm_f64x2_add(dms, wasm_f64x2_mul(vc2l1, ps));
        pms = ps;
        ps = pns;
        dms = dps;
        dps = dns;
        xps = wasm_f64x2_mul(xps, xs);
        const int L = l + 1;
        if (L >= lo) {
          const v128_t vL = wasm_f64x2_splat(static_cast<double>(L));
          ars = wasm_f64x2_add(ars, wasm_f64x2_mul(xps, wasm_f64x2_sub(wasm_f64x2_mul(vL, ps), wasm_f64x2_mul(us, dps))));
          ass = wasm_f64x2_add(ass, wasm_f64x2_mul(xps, dps));
        }
      }
    }

    const v128_t um = wasm_f64x2_add(wasm_f64x2_mul(xu, v_muf), wasm_f64x2_mul(yu, v_mug));
    const v128_t xm = wasm_f64x2_mul(rn, v_inv_mr);
    v128_t pmm = v_one, pm = um, dmm = v_zero, dpm = v_one, xpm = v_one, arm = v_zero, asm_ = v_zero;
    for (int l = 1; l < hi_m; ++l) {
      const v128_t vc2l1 = wasm_f64x2_splat(static_cast<double>(2 * l + 1));
      const v128_t vl = wasm_f64x2_splat(static_cast<double>(l));
      const v128_t vilp1 = wasm_f64x2_splat(kInvLp1[l]);
      const v128_t pnm = wasm_f64x2_mul(wasm_f64x2_sub(wasm_f64x2_mul(wasm_f64x2_mul(vc2l1, um), pm), wasm_f64x2_mul(vl, pmm)), vilp1);
      const v128_t dnm = wasm_f64x2_add(dmm, wasm_f64x2_mul(vc2l1, pm));
      pmm = pm;
      pm = pnm;
      dmm = dpm;
      dpm = dnm;
      xpm = wasm_f64x2_mul(xpm, xm);
      const int L = l + 1;
      if (L >= lo) {
        const v128_t vL = wasm_f64x2_splat(static_cast<double>(L));
        arm = wasm_f64x2_add(arm, wasm_f64x2_mul(xpm, wasm_f64x2_sub(wasm_f64x2_mul(vL, pm), wasm_f64x2_mul(um, dpm))));
        asm_ = wasm_f64x2_add(asm_, wasm_f64x2_mul(xpm, dpm));
      }
    }

    const v128_t k_ar = wasm_f64x2_add(wasm_f64x2_mul(v_ksun, ars), wasm_f64x2_mul(v_kmoon, arm));
    const v128_t k_as_s = wasm_f64x2_mul(v_ksun, ass);
    const v128_t k_as_m = wasm_f64x2_mul(v_kmoon, asm_);
    const v128_t df = wasm_f64x2_add(wasm_f64x2_mul(k_ar, xu), wasm_f64x2_add(wasm_f64x2_mul(k_as_s, v_suf), wasm_f64x2_mul(k_as_m, v_muf)));
    const v128_t dg = wasm_f64x2_add(wasm_f64x2_mul(k_ar, yu), wasm_f64x2_add(wasm_f64x2_mul(k_as_s, v_sug), wasm_f64x2_mul(k_as_m, v_mug)));
    const v128_t W = wasm_f64x2_add(wasm_f64x2_mul(k_as_s, v_suw), wasm_f64x2_mul(k_as_m, v_muw));

    const v128_t R = wasm_f64x2_add(wasm_f64x2_mul(df, xu), wasm_f64x2_mul(dg, yu));
    const v128_t S = wasm_f64x2_sub(wasm_f64x2_mul(dg, xu), wasm_f64x2_mul(df, yu));
    const v128_t vd = wasm_f64x2_add(wasm_f64x2_mul(Xd, df), wasm_f64x2_mul(Yd, dg));
    const v128_t adot = wasm_f64x2_mul(v_two_a2_mu, vd);
    const v128_t rd = wasm_f64x2_add(wasm_f64x2_mul(X, df), wasm_f64x2_mul(Y, dg));
    const v128_t rv = wasm_f64x2_add(wasm_f64x2_mul(X, Xd), wasm_f64x2_mul(Y, Yd));
    const v128_t two_vd = wasm_f64x2_mul(v_two, vd);
    const v128_t edot_f = wasm_f64x2_mul(v_inv_mu, wasm_f64x2_sub(wasm_f64x2_sub(wasm_f64x2_mul(two_vd, X), wasm_f64x2_mul(rd, Xd)), wasm_f64x2_mul(rv, df)));
    const v128_t edot_g = wasm_f64x2_mul(v_inv_mu, wasm_f64x2_sub(wasm_f64x2_sub(wasm_f64x2_mul(two_vd, Y), wasm_f64x2_mul(rd, Yd)), wasm_f64x2_mul(rv, dg)));
    const v128_t c_W = wasm_f64x2_mul(v_c_half_inv_hn, W);
    const v128_t chid = wasm_f64x2_mul(c_W, Y);
    const v128_t psid = wasm_f64x2_mul(c_W, X);
    const v128_t omega_rot = wasm_f64x2_mul(wasm_f64x2_mul(wasm_f64x2_sub(wasm_f64x2_mul(v_chi, X), wasm_f64x2_mul(v_psi, Y)), W), v_inv_hn);
    const v128_t er = wasm_f64x2_add(wasm_f64x2_mul(v_k, xu), wasm_f64x2_mul(v_h, yu));
    const v128_t es = wasm_f64x2_sub(wasm_f64x2_mul(v_h, xu), wasm_f64x2_mul(v_k, yu));

    wasm_v128_store(s.f[kAf] + j, wasm_f64x2_add(edot_f, wasm_f64x2_mul(v_h, omega_rot)));
    wasm_v128_store(s.f[kAg] + j, wasm_f64x2_sub(edot_g, wasm_f64x2_mul(v_k, omega_rot)));
    wasm_v128_store(s.f[kChi] + j, chid);
    wasm_v128_store(s.f[kPsi] + j, psid);
    const v128_t lam_t1 = wasm_f64x2_mul(v_two_inv_na2, wasm_f64x2_mul(rn, R));
    const v128_t lam_t2 = wasm_f64x2_mul(v_eta_na_1peta,
                                         wasm_f64x2_add(wasm_f64x2_mul(er, R),
                                                        wasm_f64x2_mul(wasm_f64x2_add(v_one, wasm_f64x2_mul(rn, v_inv_p)),
                                                                       wasm_f64x2_mul(es, S))));
    wasm_v128_store(s.f[kLam] + j, wasm_f64x2_sub(wasm_f64x2_neg(wasm_f64x2_add(lam_t1, lam_t2)), omega_rot));
    wasm_v128_store(s.f[kN] + j, wasm_f64x2_mul(v_neg_3n_2a, adot));
  }
#else
  for (int j = 0; j < kThirdBodyTailNodes; ++j) {
    const double cf = nt.c[j], sf = nt.s[j];
    const double roa = 1.0 - k * cf - h * sf;
    s.w[j] = roa;
    const double rn = fr.a * roa;
    const double inv_rn = 1.0 / rn;
    const double X = fr.a * (c_xx * cf + c_xy * sf - k);
    const double Y = fr.a * (c_xy * cf + c_yy * sf - h);
    const double xu = X * inv_rn, yu = Y * inv_rn;
    const double v_scale = na2 * inv_rn;
    const double Xd = v_scale * (c_xy * cf - c_xx * sf);
    const double Yd = v_scale * (c_yy * cf - c_xy * sf);

    double ars = 0.0, ass = 0.0;
    if (hi_s > 1) {
      const double us = xu * suf + yu * sug, xs = rn * inv_sr;
      double pms = 1.0, ps = us, dms = 0.0, dps = 1.0, xps = 1.0;
      for (int l = 1; l < hi_s; ++l) {
        const double c2l1 = 2 * l + 1;
        const double pns = (c2l1 * us * ps - l * pms) * kInvLp1[l];
        const double dns = dms + c2l1 * ps;
        pms = ps;
        ps = pns;
        dms = dps;
        dps = dns;
        xps *= xs;
        const int L = l + 1;
        if (L >= lo) {
          ars += xps * (L * ps - us * dps);
          ass += xps * dps;
        }
      }
    }
    const double um = xu * muf + yu * mug, xm = rn * inv_mr;
    double pmm = 1.0, pm = um, dmm = 0.0, dpm = 1.0, xpm = 1.0, arm = 0.0, asm_ = 0.0;
    for (int l = 1; l < hi_m; ++l) {
      const double c2l1 = 2 * l + 1;
      const double pnm = (c2l1 * um * pm - l * pmm) * kInvLp1[l];
      const double dnm = dmm + c2l1 * pm;
      pmm = pm;
      pm = pnm;
      dmm = dpm;
      dpm = dnm;
      xpm *= xm;
      const int L = l + 1;
      if (L >= lo) {
        arm += xpm * (L * pm - um * dpm);
        asm_ += xpm * dpm;
      }
    }
    const double k_ar = k_sun * ars + k_moon * arm;
    const double k_as_s = k_sun * ass, k_as_m = k_moon * asm_;
    const double df = k_ar * xu + k_as_s * suf + k_as_m * muf;
    const double dg = k_ar * yu + k_as_s * sug + k_as_m * mug;
    const double W = k_as_s * suw + k_as_m * muw;

    const double R = df * xu + dg * yu;
    const double S = -df * yu + dg * xu;
    const double vd = Xd * df + Yd * dg;
    const double adot = two_a2_mu * vd;
    const double rd = X * df + Y * dg;
    const double rv = X * Xd + Y * Yd;
    const double edot_f = inv_mu * (2.0 * vd * X - rd * Xd - rv * df);
    const double edot_g = inv_mu * (2.0 * vd * Y - rd * Yd - rv * dg);
    const double chid = c_half_inv_hn * W * Y;
    const double psid = c_half_inv_hn * W * X;
    const double omega_rot = (chi * X - psi * Y) * W * inv_hn;
    const double er = k * xu + h * yu;
    const double es = -k * yu + h * xu;

    s.f[kAf][j] = edot_f + h * omega_rot;
    s.f[kAg][j] = edot_g - k * omega_rot;
    s.f[kChi][j] = chid;
    s.f[kPsi][j] = psid;
    s.f[kLam][j] = -two_inv_na2 * rn * R - eta_na_1peta * (er * R + (1.0 + rn * inv_p) * es * S) - omega_rot;
    s.f[kN][j] = neg_3n_2a * adot;
  }
#endif
}

/// AP (SPEC 16.8): the Sun's and the Moon's tidal terms of degree 4 to kThirdBodyTailDegree, averaged over the mean
/// longitude as SPEC 5 averages degrees 2 and 3 (each body held at its position at the stage time): the Gauss rates on
/// the mean orbit at kThirdBodyTailNodes eccentric longitudes weighted by r/a (d lambda = (r/a) dF), added to `out`.
inline void third_body_tail(const double* y, const Frame& fr, const Bodies& b, double* out) {
  TailSamples s;
  tail_samples(y, fr, b, 4, kThirdBodyTailDegree, s);
  constexpr double kInvN = 1.0 / kThirdBodyTailNodes;
#ifdef __wasm_simd128__
  for (int m = 0; m < 6; ++m) {
    v128_t acc0 = wasm_f64x2_splat(0.0);
    v128_t acc1 = wasm_f64x2_splat(0.0);
    const double* fm = s.f[m];
    for (int j = 0; j < kThirdBodyTailNodes; j += 4) {
      acc0 = wasm_f64x2_add(acc0, wasm_f64x2_mul(wasm_v128_load(s.w + j), wasm_v128_load(fm + j)));
      acc1 = wasm_f64x2_add(acc1, wasm_f64x2_mul(wasm_v128_load(s.w + j + 2), wasm_v128_load(fm + j + 2)));
    }
    const v128_t sum = wasm_f64x2_add(acc0, acc1);
    out[m] += (wasm_f64x2_extract_lane(sum, 0) + wasm_f64x2_extract_lane(sum, 1)) * kInvN;
  }
#else
  for (int m = 0; m < 6; ++m) {
    double sum = 0.0;
    for (int j = 0; j < kThirdBodyTailNodes; ++j) sum += s.w[j] * s.f[m][j];
    out[m] += sum * kInvN;
  }
#endif
}

/// The integral from 0 to F of a zero-mean function g sampled at the nodes F_j = 2 pi j / N (its trigonometric
/// interpolant, integrated term by term), at F and at every node.
struct NodeIntegral {
  double at;                           ///< at F
  double nodes[kThirdBodyTailNodes];   ///< at each node
};
inline NodeIntegral integrate_nodes(const double* g, double F) {
  constexpr int N = kThirdBodyTailNodes, M = N / 2;
  const NodeTrig& t = node_trig();
  NodeIntegral out{};
  double sF, cF;
  fm::sincos(F, sF, cF);
  double sm = 0.0, cm = 1.0;  // sin mF, cos mF
  for (int m = 1; m <= M; ++m) {
    const double s1 = sm * cF + cm * sF;
    cm = cm * cF - sm * sF;
    sm = s1;
    double a = 0.0, bm = 0.0;
    for (int j = 0, k = 0; j < N; ++j, k = (k + m) % N) {
      a += g[j] * t.c[k];
      bm += g[j] * t.s[k];
    }
    // the Nyquist term (m = N / 2) carries half the cosine sum and no sine
    const double scale = m == M ? 1.0 / N : 2.0 / N;
    a *= scale;
    bm = m == M ? 0.0 : bm * scale;
    out.at += (a * sm + bm * (1.0 - cm)) / m;
    for (int j = 0, k = 0; j < N; ++j, k = (k + m) % N) out.nodes[j] += (a * t.s[k] + bm * (1.0 - t.c[k])) / m;
  }
  return out;
}

/// AP (SPEC 5.4, 16.8): the short-period terms of the tidal terms of degree lo to hi at the eccentric longitude F of the
/// mean orbit, each body held at its output-time position: for every element the integral over the mean longitude of
/// its rate less the average (zero mean over the orbit), divided by n; the mean longitude also takes the integral of
/// the mean motion's own short-period term. Added to `d` (state order).
inline void tbsp_coefs(const double* y, const Frame& fr, const Bodies& b, int lo, int hi,
                       double A[6][kThirdBodyTailNodes / 2 + 1], double B[6][kThirdBodyTailNodes / 2 + 1]) {
  constexpr int N = kThirdBodyTailNodes, M = N / 2, Q = N / 4;
  constexpr double kInvN = 1.0 / N;
  constexpr double kTwoOverN = 2.0 / N;
  TailSamples s;
  tail_samples(y, fr, b, lo, hi, s);
  const NodeTrig& nt = node_trig();
  const double inv_n = 1.0 / fr.n;
  const double scale_ab = kTwoOverN * inv_n;
  const double k = y[kAf], h = y[kAg];

  for (int m = 0; m < 6; ++m) {
    const double* fm = s.f[m];
    alignas(16) double g[N];
#ifdef __wasm_simd128__
    v128_t m0 = wasm_f64x2_splat(0.0), m1 = wasm_f64x2_splat(0.0);
    for (int j = 0; j < N; j += 4) {
      m0 = wasm_f64x2_add(m0, wasm_f64x2_mul(wasm_v128_load(s.w + j), wasm_v128_load(fm + j)));
      m1 = wasm_f64x2_add(m1, wasm_f64x2_mul(wasm_v128_load(s.w + j + 2), wasm_v128_load(fm + j + 2)));
    }
    const v128_t ms = wasm_f64x2_add(m0, m1);
    const double mean = (wasm_f64x2_extract_lane(ms, 0) + wasm_f64x2_extract_lane(ms, 1)) * kInvN;
    const v128_t v_mean = wasm_f64x2_splat(mean);
    for (int j = 0; j < N; j += 2) {
      wasm_v128_store(g + j, wasm_f64x2_mul(wasm_f64x2_sub(wasm_v128_load(fm + j), v_mean), wasm_v128_load(s.w + j)));
    }
#else
    double mean = 0.0;
    for (int j = 0; j < N; ++j) mean += s.w[j] * fm[j];
    mean *= kInvN;
    for (int j = 0; j < N; ++j) g[j] = (fm[j] - mean) * s.w[j];
#endif

    double gp[M + 1], gm[M];
    gp[0] = g[0];
    gp[M] = g[M];
    for (int j = 1; j < M; ++j) {
      gp[j] = g[j] + g[N - j];
      gm[j] = g[j] - g[N - j];
    }
    alignas(16) double gpe[Q + 2], gpo[Q], gme[Q], gmo[Q + 2];
    gpe[0] = gp[0] + gp[M];
    gpo[0] = gp[0] - gp[M];
    gme[0] = 0.0;
    gmo[0] = 0.0;
    gpe[Q] = gp[Q];
    gmo[Q] = gm[Q];
    for (int j = 1; j < Q; ++j) {
      gpe[j] = gp[j] + gp[M - j];
      gpo[j] = gp[j] - gp[M - j];
      gme[j] = gm[j] - gm[M - j];
      gmo[j] = gm[j] + gm[M - j];
    }

    A[m][0] = 0.0;
    B[m][0] = 0.0;
#ifdef __wasm_simd128__
    const v128_t gpe0 = wasm_v128_load(gpe + 0), gpe2 = wasm_v128_load(gpe + 2), gpe4 = wasm_v128_load(gpe + 4), gpe6 = wasm_v128_load(gpe + 6);
    const v128_t gme0 = wasm_v128_load(gme + 0), gme2 = wasm_v128_load(gme + 2), gme4 = wasm_v128_load(gme + 4), gme6 = wasm_v128_load(gme + 6);
    const v128_t gpo0 = wasm_v128_load(gpo + 0), gpo2 = wasm_v128_load(gpo + 2), gpo4 = wasm_v128_load(gpo + 4), gpo6 = wasm_v128_load(gpo + 6);
    const v128_t gmo0 = wasm_v128_load(gmo + 0), gmo2 = wasm_v128_load(gmo + 2), gmo4 = wasm_v128_load(gmo + 4), gmo6 = wasm_v128_load(gmo + 6);
    for (int r = 1; r < M; ++r) {
      const double* cmr = nt.cm[r];
      const double* smr = nt.sm[r];
      double ar, br;
      if ((r & 1) == 0) {
        const v128_t va = wasm_f64x2_add(wasm_f64x2_add(wasm_f64x2_mul(gpe0, wasm_v128_load(cmr + 0)), wasm_f64x2_mul(gpe2, wasm_v128_load(cmr + 2))),
                                         wasm_f64x2_add(wasm_f64x2_mul(gpe4, wasm_v128_load(cmr + 4)), wasm_f64x2_mul(gpe6, wasm_v128_load(cmr + 6))));
        const v128_t vb = wasm_f64x2_add(wasm_f64x2_add(wasm_f64x2_mul(gme0, wasm_v128_load(smr + 0)), wasm_f64x2_mul(gme2, wasm_v128_load(smr + 2))),
                                         wasm_f64x2_add(wasm_f64x2_mul(gme4, wasm_v128_load(smr + 4)), wasm_f64x2_mul(gme6, wasm_v128_load(smr + 6))));
        ar = (wasm_f64x2_extract_lane(va, 0) + wasm_f64x2_extract_lane(va, 1)) + ((r & 2) ? -gpe[Q] : gpe[Q]);
        br = wasm_f64x2_extract_lane(vb, 0) + wasm_f64x2_extract_lane(vb, 1);
      } else {
        const v128_t va = wasm_f64x2_add(wasm_f64x2_add(wasm_f64x2_mul(gpo0, wasm_v128_load(cmr + 0)), wasm_f64x2_mul(gpo2, wasm_v128_load(cmr + 2))),
                                         wasm_f64x2_add(wasm_f64x2_mul(gpo4, wasm_v128_load(cmr + 4)), wasm_f64x2_mul(gpo6, wasm_v128_load(cmr + 6))));
        const v128_t vb = wasm_f64x2_add(wasm_f64x2_add(wasm_f64x2_mul(gmo0, wasm_v128_load(smr + 0)), wasm_f64x2_mul(gmo2, wasm_v128_load(smr + 2))),
                                         wasm_f64x2_add(wasm_f64x2_mul(gmo4, wasm_v128_load(smr + 4)), wasm_f64x2_mul(gmo6, wasm_v128_load(smr + 6))));
        ar = wasm_f64x2_extract_lane(va, 0) + wasm_f64x2_extract_lane(va, 1);
        br = (wasm_f64x2_extract_lane(vb, 0) + wasm_f64x2_extract_lane(vb, 1)) + ((r & 2) ? -gmo[Q] : gmo[Q]);
      }
      A[m][r] = ar * scale_ab;
      B[m][r] = br * scale_ab;
    }
    const v128_t vs = wasm_f64x2_add(wasm_f64x2_add(gpe0, gpe2), wasm_f64x2_add(gpe4, gpe6));
    const double aM = wasm_f64x2_extract_lane(vs, 0) - wasm_f64x2_extract_lane(vs, 1) + gpe[Q];
#else
    for (int r = 1; r < M; ++r) {
      double ar, br;
      if ((r & 1) == 0) {
        ar = gpe[0] + ((r & 2) ? -gpe[Q] : gpe[Q]);
        br = 0.0;
        for (int j = 1; j < Q; ++j) {
          ar += gpe[j] * nt.cm[r][j];
          br += gme[j] * nt.sm[r][j];
        }
      } else {
        ar = gpo[0];
        br = ((r & 2) ? -gmo[Q] : gmo[Q]);
        for (int j = 1; j < Q; ++j) {
          ar += gpo[j] * nt.cm[r][j];
          br += gmo[j] * nt.sm[r][j];
        }
      }
      A[m][r] = ar * scale_ab;
      B[m][r] = br * scale_ab;
    }
    double aM = gpe[0] + gpe[Q];
    for (int j = 1; j < Q; ++j) aM += (j & 1) ? -gpe[j] : gpe[j];
#endif
    A[m][M] = aM * scale_ab;
    B[m][M] = 0.0;
  }

  double C[M + 1]{}, S[M + 1]{};
  for (int r = 1; r < M; ++r) {
    const double inv_r = kInvLp1[r - 1];
    C[r] = -B[kN][r] * inv_r;
    S[r] = A[kN][r] * inv_r;
  }
  C[0] = 0.5 * (k * C[1] + h * S[1]);
  A[kLam][1] += (C[1] - k * C[0] - 0.5 * k * C[2] - 0.5 * h * S[2]) * inv_n;
  B[kLam][1] += (S[1] - h * C[0] - 0.5 * k * S[2] + 0.5 * h * C[2]) * inv_n;
  for (int r = 2; r < M; ++r) {
    A[kLam][r] += (C[r] - 0.5 * k * (C[r - 1] + C[r + 1]) + 0.5 * h * (S[r - 1] - S[r + 1])) * inv_n;
    B[kLam][r] += (S[r] - 0.5 * k * (S[r - 1] + S[r + 1]) - 0.5 * h * (C[r - 1] - C[r + 1])) * inv_n;
  }
  A[kLam][M] += (-k * C[M - 1] + h * S[M - 1]) * inv_n;
}

inline void eval_tbsp(const double* y, double F, const double A[6][kThirdBodyTailNodes / 2 + 1],
                      const double B[6][kThirdBodyTailNodes / 2 + 1], double* d, double* dd_dlam = nullptr,
                      const double* sF_in = nullptr, const double* cF_in = nullptr) {
  constexpr int M = kThirdBodyTailNodes / 2;
  const double k = y[kAf], h = y[kAg];
  const int r_max = (dd_dlam == nullptr && (k * k + h * h < 4e-4))
                        ? (y[kN] > 0.035 ? 5 : (y[kN] > 0.015 ? 6 : (y[kN] > 0.006 ? 7 : M)))
                        : M;
  double sF, cF;
  if (sF_in != nullptr && cF_in != nullptr) {
    sF = *sF_in;
    cF = *cF_in;
  } else {
    fm::sincos(F, sF, cF);
  }
  double alpha[M + 1], beta[M + 1];
  double sm = 0.0, cm = 1.0;
  if (dd_dlam == nullptr) {
    for (int m = 1; m <= r_max; ++m) {
      const double s1 = sm * cF + cm * sF;
      cm = cm * cF - sm * sF;
      sm = s1;
      const double inv_m = kInvLp1[m - 1];
      alpha[m] = sm * inv_m;
      beta[m] = -cm * inv_m;
    }
    alpha[1] += 0.5 * h;
    beta[1] -= 0.5 * k;
    if (r_max == M) {
      alpha[M] *= 0.5;
      beta[M] = 0.0;
    }
    for (int m = 0; m < 6; ++m) {
      double acc = 0.0;
      for (int r = 1; r <= r_max; ++r) acc += alpha[r] * A[m][r] + beta[r] * B[m][r];
      d[m] += acc;
    }
    return;
  }
  const double dF_dlam = 1.0 / (1.0 - k * cF - h * sF);
  double dalpha[M + 1], dbeta[M + 1];
  for (int m = 1; m <= r_max; ++m) {
    const double s1 = sm * cF + cm * sF;
    cm = cm * cF - sm * sF;
    sm = s1;
    const double inv_m = kInvLp1[m - 1];
    alpha[m] = sm * inv_m;
    beta[m] = -cm * inv_m;
    dalpha[m] = cm * dF_dlam;
    dbeta[m] = sm * dF_dlam;
  }
  alpha[1] += 0.5 * h;
  beta[1] -= 0.5 * k;
  if (r_max == M) {
    alpha[M] *= 0.5;
    beta[M] = 0.0;
    dalpha[M] *= 0.5;
    dbeta[M] = 0.0;
  }
  for (int m = 0; m < 6; ++m) {
    double acc = 0.0, dacc = 0.0;
    for (int r = 1; r <= r_max; ++r) {
      acc += alpha[r] * A[m][r] + beta[r] * B[m][r];
      dacc += dalpha[r] * A[m][r] + dbeta[r] * B[m][r];
    }
    d[m] += acc;
    dd_dlam[m] += dacc;
  }
}

[[gnu::always_inline]] inline void eval_tbsp_lerp_f32(
    const double* y, double F, float u_f,
    const float AT0_f[kThirdBodyTailNodes / 2 + 1][8],
    const float BT0_f[kThirdBodyTailNodes / 2 + 1][8],
    const float dAT_f[kThirdBodyTailNodes / 2 + 1][8],
    const float dBT_f[kThirdBodyTailNodes / 2 + 1][8],
    double* d, const double* sF_in = nullptr, const double* cF_in = nullptr, int rows = kThirdBodyTailNodes / 2) {
  constexpr int M = kThirdBodyTailNodes / 2;
  const double k = y[kAf], h = y[kAg];
  // no row above those the tables hold (ActiveBracket::rows; zero there, so the sum is the same bits)
  const int r_max = std::min(rows, (k * k + h * h < 4e-4)
                                       ? (y[kN] > 0.035 ? 5 : (y[kN] > 0.015 ? 6 : (y[kN] > 0.006 ? 7 : M)))
                                       : M);
  double sF, cF;
  if (sF_in != nullptr && cF_in != nullptr) {
    sF = *sF_in;
    cF = *cF_in;
  } else {
    fm::sincos_fast(F, sF, cF);
  }
#ifdef __wasm_simd128__
  const v128_t va1 = wasm_f32x4_splat(static_cast<float>(sF + 0.5 * h));
  const v128_t vb1 = wasm_f32x4_splat(static_cast<float>(-cF - 0.5 * k));
  v128_t a0_lo = wasm_f32x4_add(wasm_f32x4_mul(va1, wasm_v128_load(AT0_f[1] + 0)),
                                wasm_f32x4_mul(vb1, wasm_v128_load(BT0_f[1] + 0)));
  v128_t a0_hi = wasm_f32x4_add(wasm_f32x4_mul(va1, wasm_v128_load(AT0_f[1] + 4)),
                                wasm_f32x4_mul(vb1, wasm_v128_load(BT0_f[1] + 4)));
  v128_t da_lo = wasm_f32x4_add(wasm_f32x4_mul(va1, wasm_v128_load(dAT_f[1] + 0)),
                                wasm_f32x4_mul(vb1, wasm_v128_load(dBT_f[1] + 0)));
  v128_t da_hi = wasm_f32x4_add(wasm_f32x4_mul(va1, wasm_v128_load(dAT_f[1] + 4)),
                                wasm_f32x4_mul(vb1, wasm_v128_load(dBT_f[1] + 4)));
  double sm = sF, cm = cF;
  const int r_loop_end = r_max == M ? M - 1 : r_max;
  for (int r = 2; r <= r_loop_end; ++r) {
    const double s1 = sm * cF + cm * sF;
    cm = cm * cF - sm * sF;
    sm = s1;
    const double inv_r = kInvLp1[r - 1];
    const v128_t va = wasm_f32x4_splat(static_cast<float>(sm * inv_r));
    const v128_t vb = wasm_f32x4_splat(static_cast<float>(-cm * inv_r));
    a0_lo = wasm_f32x4_add(a0_lo, wasm_f32x4_add(wasm_f32x4_mul(va, wasm_v128_load(AT0_f[r] + 0)),
                                                 wasm_f32x4_mul(vb, wasm_v128_load(BT0_f[r] + 0))));
    a0_hi = wasm_f32x4_add(a0_hi, wasm_f32x4_add(wasm_f32x4_mul(va, wasm_v128_load(AT0_f[r] + 4)),
                                                 wasm_f32x4_mul(vb, wasm_v128_load(BT0_f[r] + 4))));
    da_lo = wasm_f32x4_add(da_lo, wasm_f32x4_add(wasm_f32x4_mul(va, wasm_v128_load(dAT_f[r] + 0)),
                                                 wasm_f32x4_mul(vb, wasm_v128_load(dBT_f[r] + 0))));
    da_hi = wasm_f32x4_add(da_hi, wasm_f32x4_add(wasm_f32x4_mul(va, wasm_v128_load(dAT_f[r] + 4)),
                                                 wasm_f32x4_mul(vb, wasm_v128_load(dBT_f[r] + 4))));
  }
  if (r_max == M) {
    const double s1 = sm * cF + cm * sF;
    const v128_t vaM = wasm_f32x4_splat(static_cast<float>(0.5 * s1 * kInvLp1[M - 1]));
    a0_lo = wasm_f32x4_add(a0_lo, wasm_f32x4_mul(vaM, wasm_v128_load(AT0_f[M] + 0)));
    a0_hi = wasm_f32x4_add(a0_hi, wasm_f32x4_mul(vaM, wasm_v128_load(AT0_f[M] + 4)));
    da_lo = wasm_f32x4_add(da_lo, wasm_f32x4_mul(vaM, wasm_v128_load(dAT_f[M] + 0)));
    da_hi = wasm_f32x4_add(da_hi, wasm_f32x4_mul(vaM, wasm_v128_load(dAT_f[M] + 4)));
  }
  const v128_t vu = wasm_f32x4_splat(u_f);
  const v128_t res_lo = wasm_f32x4_add(a0_lo, wasm_f32x4_mul(vu, da_lo));
  const v128_t res_hi = wasm_f32x4_add(a0_hi, wasm_f32x4_mul(vu, da_hi));
  wasm_v128_store(d + 0, wasm_f64x2_add(wasm_v128_load(d + 0), wasm_f64x2_promote_low_f32x4(res_lo)));
  wasm_v128_store(d + 2, wasm_f64x2_add(wasm_v128_load(d + 2), wasm_f64x2_promote_low_f32x4(wasm_i64x2_shuffle(res_lo, res_lo, 1, 1))));
  wasm_v128_store(d + 4, wasm_f64x2_add(wasm_v128_load(d + 4), wasm_f64x2_promote_low_f32x4(res_hi)));
#else
  float alpha_f[M + 1], beta_f[M + 1];
  double sm = 0.0, cm = 1.0;
  for (int m = 1; m <= r_max; ++m) {
    const double s1 = sm * cF + cm * sF;
    cm = cm * cF - sm * sF;
    sm = s1;
    const double inv_m = kInvLp1[m - 1];
    alpha_f[m] = static_cast<float>(sm * inv_m);
    beta_f[m] = static_cast<float>(-cm * inv_m);
  }
  alpha_f[1] += static_cast<float>(0.5 * h);
  beta_f[1] -= static_cast<float>(0.5 * k);
  if (r_max == M) {
    alpha_f[M] *= 0.5f;
    beta_f[M] = 0.0f;
  }
  for (int m = 0; m < 6; ++m) {
    float acc0 = 0.0f, dacc = 0.0f;
    for (int r = 1; r <= r_max; ++r) {
      acc0 += alpha_f[r] * AT0_f[r][m] + beta_f[r] * BT0_f[r][m];
      dacc += alpha_f[r] * dAT_f[r][m] + beta_f[r] * dBT_f[r][m];
    }
    d[m] += static_cast<double>(acc0 + u_f * dacc);
  }
#endif
}

inline void eval_tbsp_lerp(const double* y, double F, double w0, double w1,
                           const double AT0[kThirdBodyTailNodes / 2 + 1][6],
                           const double BT0[kThirdBodyTailNodes / 2 + 1][6],
                           const double AT1[kThirdBodyTailNodes / 2 + 1][6],
                           const double BT1[kThirdBodyTailNodes / 2 + 1][6],
                           double* d, double* dd_dlam = nullptr,
                           const double* sF_in = nullptr, const double* cF_in = nullptr, int rows = kThirdBodyTailNodes / 2) {
  constexpr int M = kThirdBodyTailNodes / 2;
  const double k = y[kAf], h = y[kAg];
  // no row above those the tables hold (ActiveBracket::rows; zero there, so the sum is the same bits): the derivative
  // pass read all 16 rows, past a 16-node build's 5 to 7 (stack #475)
  const int r_max = std::min(rows, (dd_dlam == nullptr && (k * k + h * h < 4e-4))
                                       ? (y[kN] > 0.035 ? 5 : (y[kN] > 0.015 ? 6 : (y[kN] > 0.006 ? 7 : M)))
                                       : M);
  double sF, cF;
  if (sF_in != nullptr && cF_in != nullptr) {
    sF = *sF_in;
    cF = *cF_in;
  } else {
    fm::sincos(F, sF, cF);
  }
  double alpha[M + 1], beta[M + 1];
  double sm = 0.0, cm = 1.0;
  if (dd_dlam == nullptr) {
    for (int m = 1; m <= r_max; ++m) {
      const double s1 = sm * cF + cm * sF;
      cm = cm * cF - sm * sF;
      sm = s1;
      const double inv_m = kInvLp1[m - 1];
      alpha[m] = sm * inv_m;
      beta[m] = -cm * inv_m;
    }
    alpha[1] += 0.5 * h;
    beta[1] -= 0.5 * k;
    if (r_max == M) {
      alpha[M] *= 0.5;
      beta[M] = 0.0;
    }
#ifdef __wasm_simd128__
    v128_t a0_01 = wasm_f64x2_splat(0.0), a0_23 = wasm_f64x2_splat(0.0), a0_45 = wasm_f64x2_splat(0.0);
    v128_t a1_01 = wasm_f64x2_splat(0.0), a1_23 = wasm_f64x2_splat(0.0), a1_45 = wasm_f64x2_splat(0.0);
    for (int r = 1; r <= r_max; ++r) {
      const v128_t va = wasm_f64x2_splat(alpha[r]);
      const v128_t vb = wasm_f64x2_splat(beta[r]);
      a0_01 = wasm_f64x2_add(a0_01, wasm_f64x2_add(wasm_f64x2_mul(va, wasm_v128_load(AT0[r] + 0)), wasm_f64x2_mul(vb, wasm_v128_load(BT0[r] + 0))));
      a0_23 = wasm_f64x2_add(a0_23, wasm_f64x2_add(wasm_f64x2_mul(va, wasm_v128_load(AT0[r] + 2)), wasm_f64x2_mul(vb, wasm_v128_load(BT0[r] + 2))));
      a0_45 = wasm_f64x2_add(a0_45, wasm_f64x2_add(wasm_f64x2_mul(va, wasm_v128_load(AT0[r] + 4)), wasm_f64x2_mul(vb, wasm_v128_load(BT0[r] + 4))));
      a1_01 = wasm_f64x2_add(a1_01, wasm_f64x2_add(wasm_f64x2_mul(va, wasm_v128_load(AT1[r] + 0)), wasm_f64x2_mul(vb, wasm_v128_load(BT1[r] + 0))));
      a1_23 = wasm_f64x2_add(a1_23, wasm_f64x2_add(wasm_f64x2_mul(va, wasm_v128_load(AT1[r] + 2)), wasm_f64x2_mul(vb, wasm_v128_load(BT1[r] + 2))));
      a1_45 = wasm_f64x2_add(a1_45, wasm_f64x2_add(wasm_f64x2_mul(va, wasm_v128_load(AT1[r] + 4)), wasm_f64x2_mul(vb, wasm_v128_load(BT1[r] + 4))));
    }
    const v128_t vw0 = wasm_f64x2_splat(w0), vw1 = wasm_f64x2_splat(w1);
    wasm_v128_store(d + 0, wasm_f64x2_add(wasm_v128_load(d + 0), wasm_f64x2_add(wasm_f64x2_mul(vw0, a0_01), wasm_f64x2_mul(vw1, a1_01))));
    wasm_v128_store(d + 2, wasm_f64x2_add(wasm_v128_load(d + 2), wasm_f64x2_add(wasm_f64x2_mul(vw0, a0_23), wasm_f64x2_mul(vw1, a1_23))));
    wasm_v128_store(d + 4, wasm_f64x2_add(wasm_v128_load(d + 4), wasm_f64x2_add(wasm_f64x2_mul(vw0, a0_45), wasm_f64x2_mul(vw1, a1_45))));
#else
    for (int m = 0; m < 6; ++m) {
      double acc0 = 0.0, acc1 = 0.0;
      for (int r = 1; r <= r_max; ++r) {
        acc0 += alpha[r] * AT0[r][m] + beta[r] * BT0[r][m];
        acc1 += alpha[r] * AT1[r][m] + beta[r] * BT1[r][m];
      }
      d[m] += w0 * acc0 + w1 * acc1;
    }
#endif
    return;
  }
  const double dF_dlam = 1.0 / (1.0 - k * cF - h * sF);
  double dalpha[M + 1], dbeta[M + 1];
  for (int m = 1; m <= r_max; ++m) {
    const double s1 = sm * cF + cm * sF;
    cm = cm * cF - sm * sF;
    sm = s1;
    const double inv_m = kInvLp1[m - 1];
    alpha[m] = sm * inv_m;
    beta[m] = -cm * inv_m;
    dalpha[m] = cm * dF_dlam;
    dbeta[m] = sm * dF_dlam;
  }
  alpha[1] += 0.5 * h;
  beta[1] -= 0.5 * k;
  if (r_max == M) {
    alpha[M] *= 0.5;
    beta[M] = 0.0;
    dalpha[M] *= 0.5;
    dbeta[M] = 0.0;
  }
#ifdef __wasm_simd128__
  v128_t a0_01 = wasm_f64x2_splat(0.0), a0_23 = wasm_f64x2_splat(0.0), a0_45 = wasm_f64x2_splat(0.0);
  v128_t a1_01 = wasm_f64x2_splat(0.0), a1_23 = wasm_f64x2_splat(0.0), a1_45 = wasm_f64x2_splat(0.0);
  v128_t da0_01 = wasm_f64x2_splat(0.0), da0_23 = wasm_f64x2_splat(0.0), da0_45 = wasm_f64x2_splat(0.0);
  v128_t da1_01 = wasm_f64x2_splat(0.0), da1_23 = wasm_f64x2_splat(0.0), da1_45 = wasm_f64x2_splat(0.0);
  for (int r = 1; r <= r_max; ++r) {
    const v128_t va = wasm_f64x2_splat(alpha[r]), vb = wasm_f64x2_splat(beta[r]);
    const v128_t vda = wasm_f64x2_splat(dalpha[r]), vdb = wasm_f64x2_splat(dbeta[r]);
    const v128_t at0_01 = wasm_v128_load(AT0[r] + 0), bt0_01 = wasm_v128_load(BT0[r] + 0);
    const v128_t at0_23 = wasm_v128_load(AT0[r] + 2), bt0_23 = wasm_v128_load(BT0[r] + 2);
    const v128_t at0_45 = wasm_v128_load(AT0[r] + 4), bt0_45 = wasm_v128_load(BT0[r] + 4);
    const v128_t at1_01 = wasm_v128_load(AT1[r] + 0), bt1_01 = wasm_v128_load(BT1[r] + 0);
    const v128_t at1_23 = wasm_v128_load(AT1[r] + 2), bt1_23 = wasm_v128_load(BT1[r] + 2);
    const v128_t at1_45 = wasm_v128_load(AT1[r] + 4), bt1_45 = wasm_v128_load(BT1[r] + 4);
    a0_01 = wasm_f64x2_add(a0_01, wasm_f64x2_add(wasm_f64x2_mul(va, at0_01), wasm_f64x2_mul(vb, bt0_01)));
    a0_23 = wasm_f64x2_add(a0_23, wasm_f64x2_add(wasm_f64x2_mul(va, at0_23), wasm_f64x2_mul(vb, bt0_23)));
    a0_45 = wasm_f64x2_add(a0_45, wasm_f64x2_add(wasm_f64x2_mul(va, at0_45), wasm_f64x2_mul(vb, bt0_45)));
    a1_01 = wasm_f64x2_add(a1_01, wasm_f64x2_add(wasm_f64x2_mul(va, at1_01), wasm_f64x2_mul(vb, bt1_01)));
    a1_23 = wasm_f64x2_add(a1_23, wasm_f64x2_add(wasm_f64x2_mul(va, at1_23), wasm_f64x2_mul(vb, bt1_23)));
    a1_45 = wasm_f64x2_add(a1_45, wasm_f64x2_add(wasm_f64x2_mul(va, at1_45), wasm_f64x2_mul(vb, bt1_45)));
    da0_01 = wasm_f64x2_add(da0_01, wasm_f64x2_add(wasm_f64x2_mul(vda, at0_01), wasm_f64x2_mul(vdb, bt0_01)));
    da0_23 = wasm_f64x2_add(da0_23, wasm_f64x2_add(wasm_f64x2_mul(vda, at0_23), wasm_f64x2_mul(vdb, bt0_23)));
    da0_45 = wasm_f64x2_add(da0_45, wasm_f64x2_add(wasm_f64x2_mul(vda, at0_45), wasm_f64x2_mul(vdb, bt0_45)));
    da1_01 = wasm_f64x2_add(da1_01, wasm_f64x2_add(wasm_f64x2_mul(vda, at1_01), wasm_f64x2_mul(vdb, bt1_01)));
    da1_23 = wasm_f64x2_add(da1_23, wasm_f64x2_add(wasm_f64x2_mul(vda, at1_23), wasm_f64x2_mul(vdb, bt1_23)));
    da1_45 = wasm_f64x2_add(da1_45, wasm_f64x2_add(wasm_f64x2_mul(vda, at1_45), wasm_f64x2_mul(vdb, bt1_45)));
  }
  const v128_t vw0 = wasm_f64x2_splat(w0), vw1 = wasm_f64x2_splat(w1);
  wasm_v128_store(d + 0, wasm_f64x2_add(wasm_v128_load(d + 0), wasm_f64x2_add(wasm_f64x2_mul(vw0, a0_01), wasm_f64x2_mul(vw1, a1_01))));
  wasm_v128_store(d + 2, wasm_f64x2_add(wasm_v128_load(d + 2), wasm_f64x2_add(wasm_f64x2_mul(vw0, a0_23), wasm_f64x2_mul(vw1, a1_23))));
  wasm_v128_store(d + 4, wasm_f64x2_add(wasm_v128_load(d + 4), wasm_f64x2_add(wasm_f64x2_mul(vw0, a0_45), wasm_f64x2_mul(vw1, a1_45))));
  wasm_v128_store(dd_dlam + 0, wasm_f64x2_add(wasm_v128_load(dd_dlam + 0), wasm_f64x2_add(wasm_f64x2_mul(vw0, da0_01), wasm_f64x2_mul(vw1, da1_01))));
  wasm_v128_store(dd_dlam + 2, wasm_f64x2_add(wasm_v128_load(dd_dlam + 2), wasm_f64x2_add(wasm_f64x2_mul(vw0, da0_23), wasm_f64x2_mul(vw1, da1_23))));
  wasm_v128_store(dd_dlam + 4, wasm_f64x2_add(wasm_v128_load(dd_dlam + 4), wasm_f64x2_add(wasm_f64x2_mul(vw0, da0_45), wasm_f64x2_mul(vw1, da1_45))));
#else
  for (int m = 0; m < 6; ++m) {
    double acc0 = 0.0, acc1 = 0.0, dacc0 = 0.0, dacc1 = 0.0;
    for (int r = 1; r <= r_max; ++r) {
      acc0 += alpha[r] * AT0[r][m] + beta[r] * BT0[r][m];
      acc1 += alpha[r] * AT1[r][m] + beta[r] * BT1[r][m];
      dacc0 += dalpha[r] * AT0[r][m] + dbeta[r] * BT0[r][m];
      dacc1 += dalpha[r] * AT1[r][m] + dbeta[r] * BT1[r][m];
    }
    d[m] += w0 * acc0 + w1 * acc1;
    dd_dlam[m] += w0 * dacc0 + w1 * dacc1;
  }
#endif
}

struct Node {
  double t;        ///< minutes from epoch
  double y[6];
  double f[6];
  double yu[6];    ///< the state its step's last stage was evaluated at, before the step's corrections (rk3); the epoch's own
  int32_t index;   ///< signed node index (negative: backward)
};

/// Cubic Hermite interpolation between nodes a and b (SPEC 9).
inline void hermite(const Node& a, const Node& b, double t, double* y) {
  const double h = b.t - a.t;
  const double q = (t - a.t) / h;
  if (q == 0.0) {
    for (int j = 0; j < 6; ++j) y[j] = a.y[j];
    return;
  }
  const double omq = 1.0 - q;
  const double h00 = (1.0 + 2.0 * q) * omq * omq;
  const double h10h = (q * omq * omq) * h;
  const double h01 = q * q * (3.0 - 2.0 * q);
  const double h11h = (q * q * (q - 1.0)) * h;
#ifdef __wasm_simd128__
  const v128_t v00 = wasm_f64x2_splat(h00), v10 = wasm_f64x2_splat(h10h);
  const v128_t v01 = wasm_f64x2_splat(h01), v11 = wasm_f64x2_splat(h11h);
  for (int j = 0; j < 6; j += 2) {
    const v128_t p0 = wasm_f64x2_add(wasm_f64x2_mul(v00, wasm_v128_load(a.y + j)),
                                     wasm_f64x2_mul(v10, wasm_v128_load(a.f + j)));
    const v128_t p1 = wasm_f64x2_add(p0, wasm_f64x2_mul(v01, wasm_v128_load(b.y + j)));
    wasm_v128_store(y + j, wasm_f64x2_add(p1, wasm_f64x2_mul(v11, wasm_v128_load(b.f + j))));
  }
#else
  for (int j = 0; j < 6; ++j) y[j] = h00 * a.y[j] + h10h * a.f[j] + h01 * b.y[j] + h11h * b.f[j];
#endif
  if (!(y[kN] > 0.0))
    for (int j = 0; j < 6; ++j) y[j] = omq * a.y[j] + q * b.y[j];
}

struct ActiveBracket {
  uint64_t ctx_id = 0;
  double d50_epoch = -1e30;
  double epoch_y[6]{};
  Node lo{};
  Node hi{};
  bool valid = false;
  bool has_t1 = false;
  int sub_idx = -1;
  double t0 = 0.0, t1 = 0.0;
  double sub_t_lo = 0.0, sub_t_hi = -1.0, inv_dt = 0.0;
  Vec3 sun_u0{}, sun_u1{}, dsun_u{};
  double sun_r0 = 0.0, sun_r1 = 0.0, dsun_r = 0.0;
  /// The rows 1..rows0 of AT0/BT0 and 1..rows1 of AT1/BT1 the sub-interval's tables were built with (the 16-node tables
  /// 5 to 7, the full ones kThirdBodyTailNodes / 2); every row above is zero. `rows` is the larger: the evaluators read no
  /// row above it (stack #475: a row above a 16-node build held what the set flown before had left there).
  int rows0 = 0, rows1 = 0, rows = 0;
  alignas(16) double AT0[kThirdBodyTailNodes / 2 + 1][6]{};
  alignas(16) double BT0[kThirdBodyTailNodes / 2 + 1][6]{};
  alignas(16) double AT1[kThirdBodyTailNodes / 2 + 1][6]{};
  alignas(16) double BT1[kThirdBodyTailNodes / 2 + 1][6]{};
  alignas(16) float AT0_f[kThirdBodyTailNodes / 2 + 1][8]{};
  alignas(16) float BT0_f[kThirdBodyTailNodes / 2 + 1][8]{};
  alignas(16) float dAT_f[kThirdBodyTailNodes / 2 + 1][8]{};
  alignas(16) float dBT_f[kThirdBodyTailNodes / 2 + 1][8]{};
};
inline thread_local ActiveBracket g_active_bracket{};
/// The set being flown keeps its own (SetCaches); nullptr: the thread's.
inline thread_local ActiveBracket* g_active_bracket_set = nullptr;
inline ActiveBracket& active_bracket() { return g_active_bracket_set != nullptr ? *g_active_bracket_set : g_active_bracket; }

inline void tbsp_coefs_leo16_transposed(const double* y, const Frame& fr, const Bodies& b,
                                        double AT[kThirdBodyTailNodes / 2 + 1][6],
                                        double BT[kThirdBodyTailNodes / 2 + 1][6],
                                        bool inc_l4 = false, bool inc_l5 = false) {
  constexpr int N16 = 16, M16 = 8, Q16 = 4;
  constexpr double kInv16 = 1.0 / 16.0;
  constexpr double kTwoOver16 = 2.0 / 16.0;
  const NodeTrig& nt = node_trig();
  const double k = y[kAf], h = y[kAg], chi = y[kChi], psi = y[kPsi];
  const double beta = 1.0 / (1.0 + fr.eta);
  const double c_xx = 1.0 - h * h * beta;
  const double c_xy = h * k * beta;
  const double c_yy = 1.0 - k * k * beta;
  const double na = fr.n * fr.a;
  const double na2 = na * fr.a;
  const double hn = na2 * fr.eta;
  const double inv_hn = 1.0 / hn;
  const double inv_mu = 1.0 / kMu;
  const double two_a2_mu = 2.0 * fr.a * fr.a * inv_mu;
  const double neg_3n_2a = -1.5 * fr.n / fr.a;
  const double p = fr.a * fr.eta * fr.eta;
  const double inv_p = 1.0 / p;
  const double two_inv_na2 = 2.0 / na2;
  const double eta_na_1peta = fr.eta / (na * (1.0 + fr.eta));
  const double c_half_inv_hn = 0.5 * fr.c * inv_hn;

  const double suf = dot(b.sun_u, fr.f), sug = dot(b.sun_u, fr.g), suw = dot(b.sun_u, fr.w);
  const double muf = dot(b.moon_u, fr.f), mug = dot(b.moon_u, fr.g), muw = dot(b.moon_u, fr.w);
  const double inv_sr = 1.0 / b.sun_r, inv_mr = 1.0 / b.moon_r;
  const double k_sun = kSunMass * kMu * inv_sr * inv_sr;
  const double k_moon = kMoonMass * kMu * inv_mr * inv_mr;

  alignas(16) double sf16[6][N16];
  alignas(16) double sw16[N16];

#ifdef __wasm_simd128__
  const v128_t v_one = wasm_f64x2_splat(1.0), v_two = wasm_f64x2_splat(2.0), v_three = wasm_f64x2_splat(3.0);
  const v128_t v_five = wasm_f64x2_splat(5.0), v_half = wasm_f64x2_splat(0.5), v_third = wasm_f64x2_splat(1.0 / 3.0);
  const v128_t v_k = wasm_f64x2_splat(k), v_h = wasm_f64x2_splat(h);
  const v128_t v_chi = wasm_f64x2_splat(chi), v_psi = wasm_f64x2_splat(psi);
  const v128_t v_a = wasm_f64x2_splat(fr.a), v_na2 = wasm_f64x2_splat(na2);
  const v128_t v_cxx = wasm_f64x2_splat(c_xx), v_cxy = wasm_f64x2_splat(c_xy), v_cyy = wasm_f64x2_splat(c_yy);
  const v128_t v_inv_hn = wasm_f64x2_splat(inv_hn), v_inv_mu = wasm_f64x2_splat(inv_mu);
  const v128_t v_two_a2_mu = wasm_f64x2_splat(two_a2_mu), v_neg_3n_2a = wasm_f64x2_splat(neg_3n_2a);
  const v128_t v_inv_p = wasm_f64x2_splat(inv_p), v_two_inv_na2 = wasm_f64x2_splat(two_inv_na2);
  const v128_t v_eta_na_1peta = wasm_f64x2_splat(eta_na_1peta), v_c_half_inv_hn = wasm_f64x2_splat(c_half_inv_hn);
  const v128_t v_suf = wasm_f64x2_splat(suf), v_sug = wasm_f64x2_splat(sug), v_suw = wasm_f64x2_splat(suw);
  const v128_t v_muf = wasm_f64x2_splat(muf), v_mug = wasm_f64x2_splat(mug), v_muw = wasm_f64x2_splat(muw);
  const v128_t v_inv_sr = wasm_f64x2_splat(inv_sr), v_inv_mr = wasm_f64x2_splat(inv_mr);
  const v128_t v_ksun = wasm_f64x2_splat(k_sun), v_kmoon = wasm_f64x2_splat(k_moon);

  for (int j = 0; j < N16; j += 2) {
    const v128_t cf = wasm_v128_load(nt.c16 + j);
    const v128_t sf = wasm_v128_load(nt.s16 + j);
    const v128_t roa = wasm_f64x2_sub(wasm_f64x2_sub(v_one, wasm_f64x2_mul(v_k, cf)), wasm_f64x2_mul(v_h, sf));
    wasm_v128_store(sw16 + j, roa);
    const v128_t rn = wasm_f64x2_mul(v_a, roa);
    const v128_t inv_rn = wasm_f64x2_div(v_one, rn);
    const v128_t X = wasm_f64x2_mul(v_a, wasm_f64x2_sub(wasm_f64x2_add(wasm_f64x2_mul(v_cxx, cf), wasm_f64x2_mul(v_cxy, sf)), v_k));
    const v128_t Y = wasm_f64x2_mul(v_a, wasm_f64x2_sub(wasm_f64x2_add(wasm_f64x2_mul(v_cxy, cf), wasm_f64x2_mul(v_cyy, sf)), v_h));
    const v128_t xu = wasm_f64x2_mul(X, inv_rn), yu = wasm_f64x2_mul(Y, inv_rn);
    const v128_t v_scale = wasm_f64x2_mul(v_na2, inv_rn);
    const v128_t Xd = wasm_f64x2_mul(v_scale, wasm_f64x2_sub(wasm_f64x2_mul(v_cxy, cf), wasm_f64x2_mul(v_cxx, sf)));
    const v128_t Yd = wasm_f64x2_mul(v_scale, wasm_f64x2_sub(wasm_f64x2_mul(v_cyy, cf), wasm_f64x2_mul(v_cxy, sf)));

    // Sun l = 2, 3 (+ optional l = 4 on high MEO / GEO)
    const v128_t us = wasm_f64x2_add(wasm_f64x2_mul(xu, v_suf), wasm_f64x2_mul(yu, v_sug));
    const v128_t xs1 = wasm_f64x2_mul(rn, v_inv_sr), xs2 = wasm_f64x2_mul(xs1, xs1);
    const v128_t p2s = wasm_f64x2_mul(wasm_f64x2_sub(wasm_f64x2_mul(v_three, wasm_f64x2_mul(us, us)), v_one), v_half);
    const v128_t dp2s = wasm_f64x2_mul(v_three, us);
    const v128_t p3s = wasm_f64x2_mul(wasm_f64x2_sub(wasm_f64x2_mul(wasm_f64x2_mul(v_five, us), p2s), wasm_f64x2_mul(v_two, us)), v_third);
    const v128_t dp3s = wasm_f64x2_add(v_one, wasm_f64x2_mul(v_five, p2s));
    v128_t ars = wasm_f64x2_add(wasm_f64x2_mul(xs1, wasm_f64x2_sub(wasm_f64x2_mul(v_two, p2s), wasm_f64x2_mul(us, dp2s))),
                                wasm_f64x2_mul(xs2, wasm_f64x2_sub(wasm_f64x2_mul(v_three, p3s), wasm_f64x2_mul(us, dp3s))));
    v128_t ass = wasm_f64x2_add(wasm_f64x2_mul(xs1, dp2s), wasm_f64x2_mul(xs2, dp3s));
    if (inc_l5) {
      const v128_t xs3 = wasm_f64x2_mul(xs2, xs1);
      const v128_t p4s = wasm_f64x2_mul(wasm_f64x2_sub(wasm_f64x2_mul(wasm_f64x2_splat(7.0), wasm_f64x2_mul(us, p3s)),
                                                       wasm_f64x2_mul(v_three, p2s)),
                                        wasm_f64x2_splat(0.25));
      const v128_t dp4s = wasm_f64x2_add(wasm_f64x2_mul(wasm_f64x2_splat(7.0), p3s), dp2s);
      ars = wasm_f64x2_add(ars, wasm_f64x2_mul(xs3, wasm_f64x2_sub(wasm_f64x2_mul(wasm_f64x2_splat(4.0), p4s),
                                                                   wasm_f64x2_mul(us, dp4s))));
      ass = wasm_f64x2_add(ass, wasm_f64x2_mul(xs3, dp4s));
    }

    // Moon l = 2, 3 (+ optional l = 4..6 on MEO / GEO)
    const v128_t um = wasm_f64x2_add(wasm_f64x2_mul(xu, v_muf), wasm_f64x2_mul(yu, v_mug));
    const v128_t xm1 = wasm_f64x2_mul(rn, v_inv_mr), xm2 = wasm_f64x2_mul(xm1, xm1);
    const v128_t p2m = wasm_f64x2_mul(wasm_f64x2_sub(wasm_f64x2_mul(v_three, wasm_f64x2_mul(um, um)), v_one), v_half);
    const v128_t dp2m = wasm_f64x2_mul(v_three, um);
    const v128_t p3m = wasm_f64x2_mul(wasm_f64x2_sub(wasm_f64x2_mul(wasm_f64x2_mul(v_five, um), p2m), wasm_f64x2_mul(v_two, um)), v_third);
    const v128_t dp3m = wasm_f64x2_add(v_one, wasm_f64x2_mul(v_five, p2m));
    v128_t arm = wasm_f64x2_add(wasm_f64x2_mul(xm1, wasm_f64x2_sub(wasm_f64x2_mul(v_two, p2m), wasm_f64x2_mul(um, dp2m))),
                                wasm_f64x2_mul(xm2, wasm_f64x2_sub(wasm_f64x2_mul(v_three, p3m), wasm_f64x2_mul(um, dp3m))));
    v128_t asm_ = wasm_f64x2_add(wasm_f64x2_mul(xm1, dp2m), wasm_f64x2_mul(xm2, dp3m));
    if (inc_l4) {
      const v128_t xm3 = wasm_f64x2_mul(xm2, xm1);
      const v128_t p4m = wasm_f64x2_mul(wasm_f64x2_sub(wasm_f64x2_mul(wasm_f64x2_splat(7.0), wasm_f64x2_mul(um, p3m)),
                                                       wasm_f64x2_mul(v_three, p2m)),
                                        wasm_f64x2_splat(0.25));
      const v128_t dp4m = wasm_f64x2_add(wasm_f64x2_mul(wasm_f64x2_splat(7.0), p3m), dp2m);
      arm = wasm_f64x2_add(arm, wasm_f64x2_mul(xm3, wasm_f64x2_sub(wasm_f64x2_mul(wasm_f64x2_splat(4.0), p4m),
                                                                   wasm_f64x2_mul(um, dp4m))));
      asm_ = wasm_f64x2_add(asm_, wasm_f64x2_mul(xm3, dp4m));
      if (inc_l5) {
        const v128_t xm4 = wasm_f64x2_mul(xm2, xm2);
        const v128_t p5m = wasm_f64x2_mul(wasm_f64x2_sub(wasm_f64x2_mul(wasm_f64x2_splat(9.0), wasm_f64x2_mul(um, p4m)),
                                                         wasm_f64x2_mul(wasm_f64x2_splat(4.0), p3m)),
                                          wasm_f64x2_splat(0.2));
        const v128_t dp5m = wasm_f64x2_add(wasm_f64x2_mul(wasm_f64x2_splat(9.0), p4m), dp3m);
        arm = wasm_f64x2_add(arm, wasm_f64x2_mul(xm4, wasm_f64x2_sub(wasm_f64x2_mul(v_five, p5m),
                                                                     wasm_f64x2_mul(um, dp5m))));
        asm_ = wasm_f64x2_add(asm_, wasm_f64x2_mul(xm4, dp5m));
        const v128_t xm5 = wasm_f64x2_mul(xm4, xm1);
        const v128_t p6m = wasm_f64x2_mul(wasm_f64x2_sub(wasm_f64x2_mul(wasm_f64x2_splat(11.0), wasm_f64x2_mul(um, p5m)),
                                                         wasm_f64x2_mul(v_five, p4m)),
                                          wasm_f64x2_splat(1.0 / 6.0));
        const v128_t dp6m = wasm_f64x2_add(wasm_f64x2_mul(wasm_f64x2_splat(11.0), p5m), dp4m);
        arm = wasm_f64x2_add(arm, wasm_f64x2_mul(xm5, wasm_f64x2_sub(wasm_f64x2_mul(wasm_f64x2_splat(6.0), p6m),
                                                                     wasm_f64x2_mul(um, dp6m))));
        asm_ = wasm_f64x2_add(asm_, wasm_f64x2_mul(xm5, dp6m));
      }
    }

    const v128_t k_ar = wasm_f64x2_add(wasm_f64x2_mul(v_ksun, ars), wasm_f64x2_mul(v_kmoon, arm));
    const v128_t k_as_s = wasm_f64x2_mul(v_ksun, ass), k_as_m = wasm_f64x2_mul(v_kmoon, asm_);
    const v128_t df = wasm_f64x2_add(wasm_f64x2_mul(k_ar, xu), wasm_f64x2_add(wasm_f64x2_mul(k_as_s, v_suf), wasm_f64x2_mul(k_as_m, v_muf)));
    const v128_t dg = wasm_f64x2_add(wasm_f64x2_mul(k_ar, yu), wasm_f64x2_add(wasm_f64x2_mul(k_as_s, v_sug), wasm_f64x2_mul(k_as_m, v_mug)));
    const v128_t W = wasm_f64x2_add(wasm_f64x2_mul(k_as_s, v_suw), wasm_f64x2_mul(k_as_m, v_muw));

    const v128_t R = wasm_f64x2_add(wasm_f64x2_mul(df, xu), wasm_f64x2_mul(dg, yu));
    const v128_t S = wasm_f64x2_sub(wasm_f64x2_mul(dg, xu), wasm_f64x2_mul(df, yu));
    const v128_t vd = wasm_f64x2_add(wasm_f64x2_mul(Xd, df), wasm_f64x2_mul(Yd, dg));
    const v128_t adot = wasm_f64x2_mul(v_two_a2_mu, vd);
    const v128_t rd = wasm_f64x2_add(wasm_f64x2_mul(X, df), wasm_f64x2_mul(Y, dg));
    const v128_t rv = wasm_f64x2_add(wasm_f64x2_mul(X, Xd), wasm_f64x2_mul(Y, Yd));
    const v128_t two_vd = wasm_f64x2_mul(v_two, vd);
    const v128_t edot_f = wasm_f64x2_mul(v_inv_mu, wasm_f64x2_sub(wasm_f64x2_sub(wasm_f64x2_mul(two_vd, X), wasm_f64x2_mul(rd, Xd)), wasm_f64x2_mul(rv, df)));
    const v128_t edot_g = wasm_f64x2_mul(v_inv_mu, wasm_f64x2_sub(wasm_f64x2_sub(wasm_f64x2_mul(two_vd, Y), wasm_f64x2_mul(rd, Yd)), wasm_f64x2_mul(rv, dg)));
    const v128_t c_W = wasm_f64x2_mul(v_c_half_inv_hn, W);
    const v128_t omega_rot = wasm_f64x2_mul(wasm_f64x2_mul(wasm_f64x2_sub(wasm_f64x2_mul(v_chi, X), wasm_f64x2_mul(v_psi, Y)), W), v_inv_hn);
    const v128_t er = wasm_f64x2_add(wasm_f64x2_mul(v_k, xu), wasm_f64x2_mul(v_h, yu));
    const v128_t es = wasm_f64x2_sub(wasm_f64x2_mul(v_h, xu), wasm_f64x2_mul(v_k, yu));

    wasm_v128_store(sf16[kAf] + j, wasm_f64x2_add(edot_f, wasm_f64x2_mul(v_h, omega_rot)));
    wasm_v128_store(sf16[kAg] + j, wasm_f64x2_sub(edot_g, wasm_f64x2_mul(v_k, omega_rot)));
    wasm_v128_store(sf16[kChi] + j, wasm_f64x2_mul(c_W, Y));
    wasm_v128_store(sf16[kPsi] + j, wasm_f64x2_mul(c_W, X));
    const v128_t lam_t1 = wasm_f64x2_mul(v_two_inv_na2, wasm_f64x2_mul(rn, R));
    const v128_t lam_t2 = wasm_f64x2_mul(v_eta_na_1peta,
                                         wasm_f64x2_add(wasm_f64x2_mul(er, R),
                                                        wasm_f64x2_mul(wasm_f64x2_add(v_one, wasm_f64x2_mul(rn, v_inv_p)),
                                                                       wasm_f64x2_mul(es, S))));
    wasm_v128_store(sf16[kLam] + j, wasm_f64x2_sub(wasm_f64x2_neg(wasm_f64x2_add(lam_t1, lam_t2)), omega_rot));
    wasm_v128_store(sf16[kN] + j, wasm_f64x2_mul(v_neg_3n_2a, adot));
  }
#else
  for (int j = 0; j < N16; ++j) {
    const double cf = nt.c16[j], sf = nt.s16[j];
    const double roa = 1.0 - k * cf - h * sf;
    sw16[j] = roa;
    const double rn = fr.a * roa, inv_rn = 1.0 / rn;
    const double X = fr.a * (c_xx * cf + c_xy * sf - k), Y = fr.a * (c_xy * cf + c_yy * sf - h);
    const double xu = X * inv_rn, yu = Y * inv_rn, v_scale = na2 * inv_rn;
    const double Xd = v_scale * (c_xy * cf - c_xx * sf), Yd = v_scale * (c_yy * cf - c_xy * sf);
    const double us = xu * suf + yu * sug, xs1 = rn * inv_sr, xs2 = xs1 * xs1;
    const double p2s = 0.5 * (3.0 * us * us - 1.0), dp2s = 3.0 * us;
    const double p3s = (5.0 * us * p2s - 2.0 * us) / 3.0, dp3s = 1.0 + 5.0 * p2s;
    double ars = xs1 * (2.0 * p2s - us * dp2s) + xs2 * (3.0 * p3s - us * dp3s);
    double ass = xs1 * dp2s + xs2 * dp3s;
    if (inc_l5) {
      const double xs3 = xs2 * xs1;
      const double p4s = 0.25 * (7.0 * us * p3s - 3.0 * p2s), dp4s = 7.0 * p3s + dp2s;
      ars += xs3 * (4.0 * p4s - us * dp4s);
      ass += xs3 * dp4s;
    }
    const double um = xu * muf + yu * mug, xm1 = rn * inv_mr, xm2 = xm1 * xm1;
    const double p2m = 0.5 * (3.0 * um * um - 1.0), dp2m = 3.0 * um;
    const double p3m = (5.0 * um * p2m - 2.0 * um) / 3.0, dp3m = 1.0 + 5.0 * p2m;
    double arm = xm1 * (2.0 * p2m - um * dp2m) + xm2 * (3.0 * p3m - um * dp3m);
    double asm_ = xm1 * dp2m + xm2 * dp3m;
    if (inc_l4) {
      const double xm3 = xm2 * xm1;
      const double p4m = 0.25 * (7.0 * um * p3m - 3.0 * p2m), dp4m = 7.0 * p3m + dp2m;
      arm += xm3 * (4.0 * p4m - um * dp4m);
      asm_ += xm3 * dp4m;
      if (inc_l5) {
        const double xm4 = xm2 * xm2, xm5 = xm4 * xm1;
        const double p5m = 0.2 * (9.0 * um * p4m - 4.0 * p3m), dp5m = 9.0 * p4m + dp3m;
        const double p6m = (11.0 * um * p5m - 5.0 * p4m) * (1.0 / 6.0), dp6m = 11.0 * p5m + dp4m;
        arm += xm4 * (5.0 * p5m - um * dp5m) + xm5 * (6.0 * p6m - um * dp6m);
        asm_ += xm4 * dp5m + xm5 * dp6m;
      }
    }
    const double k_ar = k_sun * ars + k_moon * arm, k_as_s = k_sun * ass, k_as_m = k_moon * asm_;
    const double df = k_ar * xu + k_as_s * suf + k_as_m * muf, dg = k_ar * yu + k_as_s * sug + k_as_m * mug;
    const double W = k_as_s * suw + k_as_m * muw;
    const double R = df * xu + dg * yu, S = -df * yu + dg * xu;
    const double vd = Xd * df + Yd * dg, adot = two_a2_mu * vd;
    const double rd = X * df + Y * dg, rv = X * Xd + Y * Yd;
    const double omega_rot = (chi * X - psi * Y) * W * inv_hn;
    const double er = k * xu + h * yu, es = -k * yu + h * xu;
    sf16[kAf][j] = inv_mu * (2.0 * vd * X - rd * Xd - rv * df) + h * omega_rot;
    sf16[kAg][j] = inv_mu * (2.0 * vd * Y - rd * Yd - rv * dg) - k * omega_rot;
    sf16[kChi][j] = c_half_inv_hn * W * Y;
    sf16[kPsi][j] = c_half_inv_hn * W * X;
    sf16[kLam][j] = -two_inv_na2 * rn * R - eta_na_1peta * (er * R + (1.0 + rn * inv_p) * es * S) - omega_rot;
    sf16[kN][j] = neg_3n_2a * adot;
  }
#endif

  const int r_top = inc_l5 ? 7 : (inc_l4 ? 6 : 5);
  const double inv_n = 1.0 / fr.n;
  const double scale_ab = kTwoOver16 * inv_n;
  constexpr double kC1 = 0.92387953251128675613;  // cos(pi / 8)
  constexpr double kS1 = 0.38268343236508977173;  // sin(pi / 8)
  constexpr double kC2 = 0.70710678118654752440;  // cos(pi / 4)
  double A6[6][9]{}, B6[6][9]{};
  for (int m = 0; m < 6; ++m) {
    const double* fm = sf16[m];
    alignas(16) double g[N16];
#ifdef __wasm_simd128__
    v128_t m0 = wasm_f64x2_splat(0.0), m1 = wasm_f64x2_splat(0.0);
    for (int j = 0; j < N16; j += 4) {
      m0 = wasm_f64x2_add(m0, wasm_f64x2_mul(wasm_v128_load(sw16 + j), wasm_v128_load(fm + j)));
      m1 = wasm_f64x2_add(m1, wasm_f64x2_mul(wasm_v128_load(sw16 + j + 2), wasm_v128_load(fm + j + 2)));
    }
    const v128_t ms = wasm_f64x2_add(m0, m1);
    const double mean = (wasm_f64x2_extract_lane(ms, 0) + wasm_f64x2_extract_lane(ms, 1)) * kInv16;
    const v128_t v_mean = wasm_f64x2_splat(mean);
    for (int j = 0; j < N16; j += 2) {
      wasm_v128_store(g + j, wasm_f64x2_mul(wasm_f64x2_sub(wasm_v128_load(fm + j), v_mean), wasm_v128_load(sw16 + j)));
    }
#else
    double mean = 0.0;
    for (int j = 0; j < N16; ++j) mean += sw16[j] * fm[j];
    mean *= kInv16;
    for (int j = 0; j < N16; ++j) g[j] = (fm[j] - mean) * sw16[j];
#endif
    double gp[M16 + 1], gm[M16];
    gp[0] = g[0];
    gp[M16] = g[M16];
    for (int j = 1; j < M16; ++j) {
      gp[j] = g[j] + g[N16 - j];
      gm[j] = g[j] - g[N16 - j];
    }
    const double gpe0 = gp[0] + gp[8], gpo0 = gp[0] - gp[8], gp4 = gp[4], gm4 = gm[4];
    const double gpe1 = gp[1] + gp[7], gpo1 = gp[1] - gp[7], gme1 = gm[1] - gm[7], gmo1 = gm[1] + gm[7];
    const double gpe2 = gp[2] + gp[6], gpo2 = gp[2] - gp[6], gme2 = gm[2] - gm[6], gmo2 = gm[2] + gm[6];
    const double gpe3 = gp[3] + gp[5], gpo3 = gp[3] - gp[5], gme3 = gm[3] - gm[5], gmo3 = gm[3] + gm[5];

    const double c2_gpo2 = kC2 * gpo2;
    const double c2_gmo2 = kC2 * gmo2;
    const double c2_gpe13 = kC2 * (gpe1 - gpe3);
    const double c2_gme13 = kC2 * (gme1 + gme3);
    A6[m][1] = (gpo0 + kC1 * gpo1 + c2_gpo2 + kS1 * gpo3) * scale_ab;
    B6[m][1] = (kS1 * gmo1 + c2_gmo2 + kC1 * gmo3 + gm4) * scale_ab;
    A6[m][2] = (gpe0 - gp4 + c2_gpe13) * scale_ab;
    B6[m][2] = (gme2 + c2_gme13) * scale_ab;
    A6[m][3] = (gpo0 + kS1 * gpo1 - c2_gpo2 - kC1 * gpo3) * scale_ab;
    B6[m][3] = (kC1 * gmo1 + c2_gmo2 - kS1 * gmo3 - gm4) * scale_ab;
    A6[m][4] = (gpe0 + gp4 - gpe2) * scale_ab;
    B6[m][4] = (gme1 - gme3) * scale_ab;
    A6[m][5] = (gpo0 - kS1 * gpo1 - c2_gpo2 + kC1 * gpo3) * scale_ab;
    B6[m][5] = (kC1 * gmo1 - c2_gmo2 - kS1 * gmo3 + gm4) * scale_ab;
    if (inc_l4 || m == kN) {
      A6[m][6] = (gpe0 - gp4 - c2_gpe13) * scale_ab;
      B6[m][6] = (-gme2 + c2_gme13) * scale_ab;
    }
    if (inc_l5 || (inc_l4 && m == kN)) {
      A6[m][7] = (gpo0 - kC1 * gpo1 + c2_gpo2 - kS1 * gpo3) * scale_ab;
      B6[m][7] = (kS1 * gmo1 - c2_gmo2 + kC1 * gmo3 - gm4) * scale_ab;
    }
    if (inc_l5 && m == kN) {
      A6[kN][8] = 0.5 * (gpe0 + gp4 + gpe2 - gpe1 - gpe3) * scale_ab;
      B6[kN][8] = 0.0;
    }
  }
  double C[9]{}, S[9]{};
  for (int r = 1; r <= r_top + 1; ++r) {
    const double inv_r = kInvLp1[r - 1];
    C[r] = -B6[kN][r] * inv_r;
    S[r] = A6[kN][r] * inv_r;
  }
  C[0] = 0.5 * (k * C[1] + h * S[1]);
  A6[kLam][1] += (C[1] - k * C[0] - 0.5 * k * C[2] - 0.5 * h * S[2]) * inv_n;
  B6[kLam][1] += (S[1] - h * C[0] - 0.5 * k * S[2] + 0.5 * h * C[2]) * inv_n;
  for (int r = 2; r <= r_top; ++r) {
    A6[kLam][r] += (C[r] - 0.5 * k * (C[r - 1] + C[r + 1]) + 0.5 * h * (S[r - 1] - S[r + 1])) * inv_n;
    B6[kLam][r] += (S[r] - 0.5 * k * (S[r - 1] + S[r + 1]) - 0.5 * h * (C[r - 1] - C[r + 1])) * inv_n;
  }
  for (int r = 1; r <= r_top; ++r) {
    for (int m = 0; m < 6; ++m) {
      AT[r][m] = A6[m][r];
      BT[r][m] = B6[m][r];
    }
  }
  // the rows above r_top zero, as the full tables' (tbsp_coefs_transposed) and a fresh table's are: a table is all its
  // builder's (stack #475)
  for (int r = r_top + 1; r <= kThirdBodyTailNodes / 2; ++r) {
    for (int m = 0; m < 6; ++m) {
      AT[r][m] = 0.0;
      BT[r][m] = 0.0;
    }
  }
}

inline void tbsp_coefs_transposed(const double* y, const Frame& frm, const Bodies& b, int lo, int hi,
                                  double AT[kThirdBodyTailNodes / 2 + 1][6],
                                  double BT[kThirdBodyTailNodes / 2 + 1][6]) {
  constexpr int M = kThirdBodyTailNodes / 2;
  double A[6][M + 1], B[6][M + 1];
  tbsp_coefs(y, frm, b, lo, hi, A, B);
  for (int r = 1; r <= M; ++r) {
    for (int m = 0; m < 6; ++m) {
      AT[r][m] = A[m][r];
      BT[r][m] = B[m][r];
    }
  }
}

[[gnu::noinline]] inline void third_body_short_period_slow(
    const double* y, const Bodies* b_opt, double F, int lo, int hi,
    double* d, double* dd_dlam, double d50_epoch, double t,
    const double* sF_in, const double* cF_in, uint64_t ctx_id = 0) {
  constexpr int M = kThirdBodyTailNodes / 2;
  const double e2 = y[kAf] * y[kAf] + y[kAg] * y[kAg];
  const bool use_fast16 = t != 0.0 && lo == 2 && hi == kThirdBodyTailDegree && y[kN] > 0.006 && e2 < 4e-4;
  const bool inc_l4 = y[kN] <= 0.035;
  const bool inc_l5 = y[kN] <= 0.015;
  ActiveBracket& ab = active_bracket();
  if (lo == 2 && hi == kThirdBodyTailDegree && t != 0.0 && ctx_id != 0 && ab.valid && ab.ctx_id == ctx_id &&
      ab.d50_epoch == d50_epoch) {
    const double t_min = std::fmin(ab.lo.t, ab.hi.t), t_max = std::fmax(ab.lo.t, ab.hi.t);
    const double span = ab.hi.t - ab.lo.t;
    if (t >= t_min && t <= t_max && std::fabs(span) > 1e-6) {
      // the bracket's choices, from its lower node: its sub-intervals, its tables' builder and their rows are the
      // bracket's, whichever of its states is asked first (stack #475: taken from the state asked first, a set at
      // n 0.035 rad/min had 32 of 2,016 states that depended on the order they were asked in)
      const double* yl = ab.lo.y;
      const double e2_b = yl[kAf] * yl[kAf] + yl[kAg] * yl[kAg];
      const bool fast16_b = yl[kN] > 0.006 && e2_b < 4e-4;
      const bool l4_b = yl[kN] <= 0.035, l5_b = yl[kN] <= 0.015;
      const double max_sub = (yl[kN] > 0.035 && e2_b < 0.01)
                                 ? 250.0
                                 : (yl[kN] > 0.020 && e2_b < 0.01 ? 120.0 : (yl[kN] < 0.015 ? 45.0 : 90.0));
      const int n_sub = std::max(1, static_cast<int>(std::ceil(std::fabs(span) / max_sub)));
      const double step = span / n_sub;
      int idx = static_cast<int>(std::floor((t - ab.lo.t) / step));
      if (idx < 0) idx = 0;
      if (idx >= n_sub) idx = n_sub - 1;
      if (ab.sub_idx != idx) {
        const double ta = ab.lo.t + idx * step;
        const double tb = idx + 1 == n_sub ? ab.hi.t : ab.lo.t + (idx + 1) * step;
        // the rows a table built now holds (the 16-node tables zero the rows above them)
        const int rows_built = fast16_b ? (l5_b ? 7 : (l4_b ? 6 : 5)) : M;
        // the previous sub-interval's AT1 is this one's AT0 when it is at this one's start and its builder is this one's
        if (ab.has_t1 && std::fabs(ab.t1 - ta) < 1e-9 && ab.rows1 == rows_built) {
          ab.sun_u0 = ab.sun_u1;
          ab.sun_r0 = ab.sun_r1;
          // the whole tables: AT1 was built by its own call, which may have held other rows than this one's
          std::memcpy(ab.AT0, ab.AT1, sizeof(ab.AT0));
          std::memcpy(ab.BT0, ab.BT1, sizeof(ab.BT0));
          ab.rows0 = ab.rows1;
        } else if (idx == 0) {
          ab.rows0 = rows_built;
          const Bodies ba = bodies_at_ap(d50_epoch + ta / kMinutesPerDay);
          ab.sun_u0 = ba.sun_u;
          ab.sun_r0 = ba.sun_r;
          if (fast16_b) tbsp_coefs_leo16_transposed(ab.lo.y, frame_of_fast(ab.lo.y), ba, ab.AT0, ab.BT0, l4_b, l5_b);
          else tbsp_coefs_transposed(ab.lo.y, frame_of_fast(ab.lo.y), ba, lo, hi, ab.AT0, ab.BT0);
        } else {
          ab.rows0 = rows_built;
          double ya[6];
          hermite(ab.lo, ab.hi, ta, ya);
          const Bodies ba = bodies_at_ap(d50_epoch + ta / kMinutesPerDay);
          ab.sun_u0 = ba.sun_u;
          ab.sun_r0 = ba.sun_r;
          if (fast16_b) tbsp_coefs_leo16_transposed(ya, frame_of_fast(ya), ba, ab.AT0, ab.BT0, l4_b, l5_b);
          else tbsp_coefs_transposed(ya, frame_of_fast(ya), ba, lo, hi, ab.AT0, ab.BT0);
        }
        if (idx + 1 == n_sub) {
          const Bodies bb = bodies_at_ap(d50_epoch + tb / kMinutesPerDay);
          ab.sun_u1 = bb.sun_u;
          ab.sun_r1 = bb.sun_r;
          if (fast16_b) tbsp_coefs_leo16_transposed(ab.hi.y, frame_of_fast(ab.hi.y), bb, ab.AT1, ab.BT1, l4_b, l5_b);
          else tbsp_coefs_transposed(ab.hi.y, frame_of_fast(ab.hi.y), bb, lo, hi, ab.AT1, ab.BT1);
        } else {
          double yb[6];
          hermite(ab.lo, ab.hi, tb, yb);
          const Bodies bb = bodies_at_ap(d50_epoch + tb / kMinutesPerDay);
          ab.sun_u1 = bb.sun_u;
          ab.sun_r1 = bb.sun_r;
          if (fast16_b) tbsp_coefs_leo16_transposed(yb, frame_of_fast(yb), bb, ab.AT1, ab.BT1, l4_b, l5_b);
          else tbsp_coefs_transposed(yb, frame_of_fast(yb), bb, lo, hi, ab.AT1, ab.BT1);
        }
        ab.rows1 = rows_built;
        ab.rows = std::max(ab.rows0, ab.rows1);
        ab.dsun_u = ab.sun_u1 - ab.sun_u0;
        ab.dsun_r = ab.sun_r1 - ab.sun_r0;
        // the single-precision tables: every row the double ones hold, zero above
        for (int r = 1; r <= M; ++r) {
          const bool held = r <= ab.rows;
          for (int m = 0; m < 6; ++m) {
            ab.AT0_f[r][m] = held ? static_cast<float>(ab.AT0[r][m]) : 0.0f;
            ab.BT0_f[r][m] = held ? static_cast<float>(ab.BT0[r][m]) : 0.0f;
            ab.dAT_f[r][m] = held ? static_cast<float>(ab.AT1[r][m] - ab.AT0[r][m]) : 0.0f;
            ab.dBT_f[r][m] = held ? static_cast<float>(ab.BT1[r][m] - ab.BT0[r][m]) : 0.0f;
          }
          ab.AT0_f[r][6] = ab.AT0_f[r][7] = 0.0f;
          ab.BT0_f[r][6] = ab.BT0_f[r][7] = 0.0f;
          ab.dAT_f[r][6] = ab.dAT_f[r][7] = 0.0f;
          ab.dBT_f[r][6] = ab.dBT_f[r][7] = 0.0f;
        }
        ab.t0 = ta;
        ab.t1 = tb;
        ab.sub_t_lo = std::fmin(ta, tb);
        ab.sub_t_hi = std::fmax(ta, tb);
        ab.inv_dt = 1.0 / (tb - ta);
        ab.has_t1 = true;
        ab.sub_idx = idx;
      }
      const double u = (t - ab.t0) * ab.inv_dt;
      if (dd_dlam == nullptr) {
        eval_tbsp_lerp_f32(y, F, static_cast<float>(u), ab.AT0_f, ab.BT0_f, ab.dAT_f, ab.dBT_f, d, sF_in, cF_in, ab.rows);
      } else {
        eval_tbsp_lerp(y, F, 1.0 - u, u, ab.AT0, ab.BT0, ab.AT1, ab.BT1, d, dd_dlam, sF_in, cF_in, ab.rows);
      }
      return;
    }
  }
  const Bodies b_local = b_opt != nullptr ? *b_opt : bodies_at_ap(d50_epoch + t / kMinutesPerDay);
  if (use_fast16) {
    alignas(16) double AT[M + 1][6]{}, BT[M + 1][6]{};
    tbsp_coefs_leo16_transposed(y, frame_of_fast(y), b_local, AT, BT, inc_l4, inc_l5);
    eval_tbsp_lerp(y, F, 1.0, 0.0, AT, BT, AT, BT, d, dd_dlam, sF_in, cF_in);
    return;
  }
  double A[6][M + 1], B[6][M + 1];
  tbsp_coefs(y, frame_of_fast(y), b_local, lo, hi, A, B);
  eval_tbsp(y, F, A, B, d, dd_dlam, sF_in, cF_in);
}

[[gnu::always_inline]] inline void third_body_short_period(
    const double* y, const Bodies* b_opt, double F, int lo, int hi,
    double* d, double* dd_dlam = nullptr, double d50_epoch = -1e30, double t = 0.0,
    const double* sF_in = nullptr, const double* cF_in = nullptr, uint64_t ctx_id = 0) {
  ActiveBracket& ab = active_bracket();
  if (__builtin_expect(dd_dlam == nullptr && t != 0.0 && lo == 2 && hi == kThirdBodyTailDegree &&
                           ctx_id != 0 && ab.valid && ab.has_t1 && ab.ctx_id == ctx_id && ab.d50_epoch == d50_epoch &&
                           t >= ab.sub_t_lo && t <= ab.sub_t_hi,
                       1)) {
    const double u = (t - ab.t0) * ab.inv_dt;
    eval_tbsp_lerp_f32(y, F, static_cast<float>(u), ab.AT0_f, ab.BT0_f, ab.dAT_f, ab.dBT_f, d, sF_in, cF_in, ab.rows);
    return;
  }
  third_body_short_period_slow(y, b_opt, F, lo, hi, d, dd_dlam, d50_epoch, t, sF_in, cF_in, ctx_id);
}

inline void third_body_short_period(const double* y, const Frame&, const Bodies& b, double F, int lo, int hi, double* d) {
  third_body_short_period_slow(y, &b, F, lo, hi, d, nullptr, -1e30, 0.0, nullptr, nullptr);
}

/// The eccentric longitude F of an equinoctial state: lambda = F + ag cos F - af sin F (Halley iteration).
inline double eccentric_longitude(const double* y) {
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
  return F;
}

/// The drag's part of the averaged rates (SPEC 3.4), added to `out`. AP above e 0.3 (SPEC 16.12): the mean of the
/// perigee passages before and after t, each at its own time.
inline void drag_part(const RateContext& ctx, double t, const double* y, const Frame& fr, const Kepler& k, const AngleTrig& ag,
                      const Bodies& b, double* out) {
  if (ctx.drag_pass) {
    const double tp = t - k.m / fr.n, period = kTwoPi / fr.n;
    for (int s = 0; s < 2; ++s) {
      const double tq = tp + s * period;
      drag_rates(y, fr, k, ag, ctx.bterm, b, ctx.d50_epoch + tq / kMinutesPerDay, ctx.atmosphere, ctx.theta_g0 + kOmegaE * tq,
                 out, true, 0.5);
    }
  } else {
    drag_rates(y, fr, k, ag, ctx.bterm, b, ctx.d50_epoch + t / kMinutesPerDay, ctx.atmosphere, ctx.theta_g0 + kOmegaE * t, out,
               false, 1.0, ctx.ap_third_body != 0);
  }
}

/// AP above e 0.3 (SPEC 16.12): the two passages drag_part averages, apart, for the output's drag steps: v[0..5] the full
/// rates of the passage before t (at t - M/n), v[6..11] those of the next, v[12] and v[13] their widths in the mean anomaly.
constexpr int kDragPassValues = 14;
inline void drag_passes(const RateContext& ctx, double t, const double* y, const Frame& fr, const Kepler& k,
                        const AngleTrig& ag, const Bodies& b, double* v) {
  const double tp = t - k.m / fr.n, period = kTwoPi / fr.n;
  for (int j = 0; j < kDragPassValues; ++j) v[j] = 0.0;
  for (int s = 0; s < 2; ++s) {
    const double tq = tp + s * period;
    drag_rates(y, fr, k, ag, ctx.bterm, b, ctx.d50_epoch + tq / kMinutesPerDay, ctx.atmosphere, ctx.theta_g0 + kOmegaE * tq,
               v + 6 * s, true, 1.0, false, v + 12 + s);
  }
}

/// Diagnostics (SPEC 16.12): the drag's averaged rates at mean state y and time t (`theory`, state order) against an
/// independent integral over the same passes: the Gauss equations of -(1/2) rho B |v_rel| v_rel along the mean orbit, the
/// density (node_density) and the co-rotating air at the radius of SPEC 3.4 (mean orbit plus the J2 short-period radius),
/// each sample at its own time, `samples` points of composite Simpson in the mean anomaly over each pass (`check`).
inline bool drag_orbit_check(const RateContext& ctx, double t, const double* y, int samples, double* theory, double* check) {
  for (int j = 0; j < 6; ++j) theory[j] = check[j] = 0.0;
  if (!(ctx.bterm > 0.0) || state_test(ctx, y) != 0) return false;
  const Frame fr = frame_of(y);
  const Kepler k = kepler_of(y, fr.a);
  const AngleTrig ag = angle_trig(k);
  // the Sun the set's flights read (an AP set's own, SPEC 16.17)
  const Bodies b = ctx.ap_third_body ? bodies_at_ap(ctx.d50_epoch + t / kMinutesPerDay) : bodies_at(ctx.d50_epoch + t / kMinutesPerDay);
  drag_part(ctx, t, y, fr, k, ag, b, theory);
  const int N = samples < 2 ? 2 : samples & ~1;
  const double e = k.e, n = fr.n, eta = fr.eta, p = fr.a * eta * eta, th = ag.ci, cj2 = kJ2 / (4.0 * p);
  const double sdsun = b.sun_u.z, cdsun = std::sqrt(1.0 - b.sun_u.z * b.sun_u.z), rasun = std::atan2(b.sun_u.y, b.sun_u.x);
  const int passes = ctx.drag_pass ? 2 : 1;
  const double tp = ctx.drag_pass ? t - k.m / n : t, period = kTwoPi / n;
  const double varpi = k.argp + k.node;
  for (int s = 0; s < passes; ++s) {
    const double t0 = tp + s * period;
    for (int q = 0; q <= N; ++q) {
      const double M = -kPi + kTwoPi * q / N;
      // eccentric anomaly, then the eccentric longitude F = E + varpi of state_at_F
      double E = M + e * std::sin(M);
      for (int it = 0; it < 50; ++it) {
        const double dE = (E - e * std::sin(E) - M) / (1.0 - e * std::cos(E));
        E -= dE;
        if (std::fabs(dE) < 1e-15) break;
      }
      Vec3 r, v;
      double roa;
      state_at_F(y, fr, E + varpi, r, v, roa);
      const double nu = 2.0 * std::atan2(std::sqrt(1.0 + e) * std::sin(0.5 * E), std::sqrt(1.0 - e) * std::cos(0.5 * E));
      double sn, cn;
      fm::sincos(nu, sn, cn);
      const double cu = ag.cw * cn - ag.sw * sn, su = ag.sw * cn + ag.cw * sn;
      const double Dn = 1.0 + e * cn;
      const double rj = p / Dn + cj2 * ((1.0 - th * th) * (cu * cu - su * su) - (3.0 * th * th - 1.0) * (e * cn / (1.0 + eta) + 2.0 * eta / Dn + 1.0));
      const Vec3 rs = (rj / norm(r)) * r;  // the density's and the co-rotating air's radius; the lever arms keep the mean orbit's
      // the time ctx's rates use: drag_pass, the sample's own time on the pass; otherwise the rate's time t
      const double ts = ctx.drag_pass ? t0 + M / n : t;
      const double d50 = ctx.d50_epoch + ts / kMinutesPerDay, theta_g = ctx.theta_g0 + kOmegaE * ts;
      const bool generic = ctx.atmosphere == nullptr || !ctx.atmosphere->measured;
      const drag::Flux fl = generic ? drag::flux_at(ctx.drag_pass ? ctx.d50_epoch + t0 / kMinutesPerDay : d50)
                                    : atm::drivers_at(*ctx.atmosphere, ctx.drag_pass ? ctx.d50_epoch + t0 / kMinutesPerDay : d50);
      double D, Nd;
      drag::day_of_year(ctx.drag_pass ? ctx.d50_epoch + t0 / kMinutesPerDay : d50, D, Nd);
      const drag::DateTerms dt = drag::date_terms(fl, D, Nd);
      const double dca = ctx.atmosphere != nullptr && !ctx.atmosphere->dca_d50.empty()
                             ? atm::dca_scale(*ctx.atmosphere, ctx.drag_pass ? ctx.d50_epoch + t0 / kMinutesPerDay : d50) : 1.0;
      const double sp = rs.z / rj, cp = std::sqrt(1.0 - sp * sp);
      const NodeHeight nh = node_height(sp, cp, rj);
      const double alpha = std::atan2(rs.y, rs.x);
      double H = alpha - rasun;
      H -= kTwoPi * std::floor(H / kTwoPi);
      const double rho = node_density(ctx.atmosphere, dt, fl, dca, d50, sp, cp, sdsun, cdsun, H, alpha, theta_g, nh);
      const Vec3 vrel = {v.x + kOmegaE * rs.y, v.y - kOmegaE * rs.x, v.z};
      const double c = -0.5 * rho * ctx.bterm * kRe * 1000.0 * norm(vrel);
      double g[6];
      gauss(y, fr, r, v, c * vrel, g);
      const double wq = (q == 0 || q == N) ? 1.0 : (q % 2 ? 4.0 : 2.0);
      for (int j = 0; j < 6; ++j) check[j] += wq * g[j] / (3.0 * N) / passes;
    }
  }
  return true;
}

/// The nominal's parts of its epoch rates that rk3 holds over its first step (SPEC 9); a covariance's moved sets read
/// none of it (stack #491: each is flown on its own).
struct EpochAux {
  uint64_t ctx_id = 0;
  double tb[6]{};
  double drag_unit[6]{};
  double srp_unit[6]{};
  double six_tail[6]{};
  double tail_eq[6]{};
  bool valid = false;
  bool has_tb = false;
  bool has_drag = false;
  bool has_srp = false;
  bool srp_sunlit_safe = false;
  bool has_tail = false;
  bool has_tail_eq = false;
};
inline thread_local EpochAux g_epoch_aux{};
inline EpochAux& epoch_aux() { return g_epoch_aux; }

/// A step's stage parts, recorded by the set being stepped for its own rk3 (SPEC 9).
struct CovStageAux {
  uint32_t gen = 0;
  double tb[6]{};
  double drag_unit[6]{};
  double srp_unit[6]{};
  double six_tail[6]{};
  double tail_eq[6]{};
  bool has_tb = false;
  bool has_drag = false;
  bool has_srp = false;
  bool srp_sunlit_safe = false;
  bool has_tail = false;
  bool has_tail_eq = false;
};
struct CovStepAux {
  CovStageAux st[3];
};
/// The thread's step parts of the set it steps (anchor_id: its ctx_id; gen: bumped when another set or another epoch
/// takes it). Through 0.6.20 a covariance's moved sets read the nominal's parts here plus their own held differences,
/// so their flight, and the covariance, depended on what the thread had flown before (stack #491).
struct CovGridCache {
  static constexpr int kMaxCovSteps = 420;
  uint32_t gen = 1;
  uint64_t anchor_id = 0;
  double d50_epoch = -1e30;
  double n0 = 0.0;
  double epoch_f0 = 0.0;
  double epoch_bterm = -1.0;
  double epoch_agom = -1.0;
  double epoch_rad_y0 = 0.0;  ///< SPEC 16.13: the Y0 the cached stages were flown with
  double epoch_tb[6]{};
  double epoch_drag_unit[6]{};
  double epoch_srp_unit[6]{};
  double epoch_six_tail[6]{};
  double epoch_tail_eq[6]{};
  bool has_epoch_tb = false;
  bool has_epoch_drag = false;
  bool has_epoch_srp = false;
  bool epoch_srp_safe = false;
  bool has_epoch_tail_eq = false;
  CovStepAux steps[2][kMaxCovSteps]{};
};
inline thread_local CovGridCache* g_cov_grid_cache_ptr = nullptr;
inline CovGridCache& cov_grid_cache() {
  if (__builtin_expect(!g_cov_grid_cache_ptr, 0)) g_cov_grid_cache_ptr = new CovGridCache{};
  return *g_cov_grid_cache_ptr;
}

struct Rk3StageOverride {
  const double* tb = nullptr;
  const double* drag = nullptr;
  const double* tail_eq = nullptr;
  const double* srp = nullptr;
  double* tb_out = nullptr;
  double* drag_out = nullptr;
  double* tail_eq_out = nullptr;
  double* six_tail_out = nullptr;
  double* srp_out = nullptr;
};

inline void zonal_six_ap(double e, double n, double s, double c, double eta, double p, double sw1, double cw1, double inv_cp1, double* six) {
  const double cw1_2 = cw1 * cw1;
  const double cw2 = cw1_2 - sw1 * sw1, sw2 = 2.0 * sw1 * cw1;
  const double cw3 = cw2 * cw1 - sw2 * sw1, sw3 = sw2 * cw1 + cw2 * sw1;
  const double cw4 = cw3 * cw1 - sw3 * sw1;
  const double sinc2 = 2.0 * s * c;
  const double e2 = e * e, e4 = e2 * e2, em1p1 = (e - 1.0) * (e + 1.0);
  const double s2 = s * s, s4 = s2 * s2;
  const double c2 = c * c, c3 = c2 * c, c4 = c2 * c2, c5 = c4 * c;
  const double ep_den = (-e2) + eta + 1.0;
#ifdef __wasm_simd128__
  const v128_t vinv = wasm_f64x2_div(wasm_f64x2_splat(1.0), wasm_f64x2_make(p, em1p1 * ep_den));
  const double inv_p = wasm_f64x2_extract_lane(vinv, 0);
  const double inv_prod = wasm_f64x2_extract_lane(vinv, 1);
  const double inv_e2m1 = inv_prod * ep_den;
  const double inv_ep = inv_prod * em1p1;
#else
  const double inv_p = 1.0 / p;
  const double inv_e2m1 = 1.0 / em1p1;
  const double inv_ep = 1.0 / ep_den;
#endif
  const double inv_p2 = inv_p * inv_p, inv_p3 = inv_p2 * inv_p, inv_p4 = inv_p2 * inv_p2, inv_p5 = inv_p4 * inv_p;
  const double j5_poly1 = 126.0 * c4 * e2 * cw1 - 63.0 * c4 * e2 * cw3 + 168.0 * c4 * cw1 - 84.0 * c2 * e2 * cw1 +
                          70.0 * c2 * e2 * cw3 - 112.0 * c2 * cw1 + 6.0 * e2 * cw1 - 7.0 * e2 * cw3 + 8.0 * cw1;
  const double edot =
      (kJ2 * kJ2) * ((-3.0 / 32.0) * e * n * s2 * em1p1 * (15.0 * s2 - 14.0) * sw2 * inv_p4)
      + kJ3 * ((-3.0 / 8.0) * n * s * em1p1 * (5.0 * s2 - 4.0) * cw1 * inv_p3)
      + kJ4 * ((-15.0 / 32.0) * e * n * s2 * em1p1 * (7.0 * s2 - 6.0) * sw2 * inv_p4)
      + kJ5 * ((-15.0 / 256.0) * n * s * em1p1 * j5_poly1 * inv_p5);
  const double idot =
      (kJ2 * kJ2) * ((3.0 / 64.0) * e2 * n * (14.0 - 15.0 * s2) * sinc2 * sw2 * inv_p4)
      + kJ3 * ((3.0 / 8.0) * c * e * n * (4.0 - 5.0 * s2) * cw1 * inv_p3)
      + kJ4 * ((15.0 / 64.0) * e2 * n * (6.0 - 7.0 * s2) * sinc2 * sw2 * inv_p4)
      + kJ5 * ((-15.0 / 256.0) * c * e * n * j5_poly1 * inv_p5);
  const double evdot =
      kJ2 * ((3.0 / 4.0) * e * n * ((-2.0) * c - 5.0 * s2 + 4.0) * inv_p2)
      + (kJ2 * kJ2) * ((3.0 / 128.0) * e * n * (240.0 * c * e2 * s2 * cw1_2 - 140.0 * c * e2 * s2 - 112.0 * c * e2 * cw1_2 + 40.0 * c * e2 + 144.0 * c * eta * s2 - 96.0 * c * eta + 160.0 * c * s2 - 144.0 * c + 540.0 * e2 * s4 * cw1_2 - 315.0 * e2 * s4 - 632.0 * e2 * s2 * cw1_2 + 280.0 * e2 * s2 + 112.0 * e2 * cw1_2 + 360.0 * eta * s4 - 528.0 * eta * s2 + 192.0 * eta + 120.0 * s4 * cw1_2 + 370.0 * s4 - 112.0 * s2 * cw1_2 - 768.0 * s2 + 384.0) * inv_p4)
      + kJ3 * ((3.0 / 8.0) * n * s * (5.0 * c3 * e2 - 10.0 * c2 * e2 - 30.0 * c * e2 * s2 + 15.0 * c * e2 - 5.0 * c * s2 + 4.0 * c - 30.0 * e2 * s2 + 26.0 * e2 - 5.0 * s2 + 4.0) * sw1 * inv_p3 * inv_cp1)
      + kJ4 * ((15.0 / 128.0) * e * n * (56.0 * c * e2 * s2 * cw2 - 84.0 * c * e2 * s2 - 24.0 * c * e2 * cw2 + 48.0 * c * e2 - 56.0 * c * s2 + 32.0 * c + 126.0 * e2 * s4 * cw2 - 189.0 * e2 * s4 - 140.0 * e2 * s2 * cw2 + 252.0 * e2 * s2 + 24.0 * e2 * cw2 - 72.0 * e2 + 28.0 * s4 * cw2 - 196.0 * s4 - 24.0 * s2 * cw2 + 248.0 * s2 - 64.0) * inv_p4)
      + kJ5 * ((5.0 / 256.0) * n * s * ((-2646.0) * c5 * e4 * sw1 + 441.0 * c5 * e4 * sw3 - 5670.0 * c5 * e2 * sw1 + 189.0 * c5 * e2 * sw3 - 504.0 * c5 * sw1 - 2268.0 * c4 * e4 * sw1 + 378.0 * c4 * e4 * sw3 - 5166.0 * c4 * e2 * sw1 + 189.0 * c4 * e2 * sw3 - 504.0 * c4 * sw1 + 1512.0 * c3 * e4 * s2 * sw1 - 252.0 * c3 * e4 * s2 * sw3 + 1764.0 * c3 * e4 * sw1 - 490.0 * c3 * e4 * sw3 + 2016.0 * c3 * e2 * s2 * sw1 + 3780.0 * c3 * e2 * sw1 - 210.0 * c3 * e2 * sw3 + 336.0 * c3 * sw1 + 1512.0 * c2 * e4 * sw1 - 420.0 * c2 * e4 * sw3 + 3444.0 * c2 * e2 * sw1 - 210.0 * c2 * e2 * sw3 + 336.0 * c2 * sw1 - 504.0 * c * e4 * s2 * sw1 + 140.0 * c * e4 * s2 * sw3 - 126.0 * c * e4 * sw1 + 49.0 * c * e4 * sw3 - 672.0 * c * e2 * s2 * sw1 - 270.0 * c * e2 * sw1 + 21.0 * c * e2 * sw3 - 24.0 * c * sw1 - 108.0 * e4 * sw1 + 42.0 * e4 * sw3 - 246.0 * e2 * sw1 + 21.0 * e2 * sw3 - 24.0 * sw1) * inv_p5 * inv_cp1);
  const double sodot =
      kJ2 * ((-3.0 / 2.0) * c * n * s * inv_p2)
      + (kJ2 * kJ2) * ((3.0 / 32.0) * c * n * s * (30.0 * e2 * s2 * cw2 - 5.0 * e2 * s2 - 14.0 * e2 * cw2 - 4.0 * e2 + 36.0 * eta * s2 - 24.0 * eta + 40.0 * s2 - 36.0) * inv_p4)
      + kJ3 * ((3.0 / 8.0) * c * e * n * (4.0 - 15.0 * s2) * sw1 * inv_p3)
      + kJ4 * ((15.0 / 32.0) * c * n * s * (14.0 * e2 * s2 * cw2 - 21.0 * e2 * s2 - 6.0 * e2 * cw2 + 12.0 * e2 - 14.0 * s2 + 8.0) * inv_p4)
      + kJ5 * ((5.0 / 256.0) * c * e * n * ((-378.0) * c4 * e2 * sw1 + 63.0 * c4 * e2 * sw3 - 504.0 * c4 * sw1 + 1512.0 * c2 * e2 * s2 * sw1 - 252.0 * c2 * e2 * s2 * sw3 + 252.0 * c2 * e2 * sw1 - 70.0 * c2 * e2 * sw3 + 2016.0 * c2 * s2 * sw1 + 336.0 * c2 * sw1 - 504.0 * e2 * s2 * sw1 + 140.0 * e2 * s2 * sw3 - 18.0 * e2 * sw1 + 7.0 * e2 * sw3 - 672.0 * s2 * sw1 - 24.0 * sw1) * inv_p5);
  const double ldot =
      kJ2 * ((3.0 / 4.0) * n * ((-2.0) * c - 3.0 * eta * s2 + 2.0 * eta - 5.0 * s2 + 4.0) * inv_p2)
      + (kJ2 * kJ2) * ((3.0 / 1024.0) * n * (960.0 * c * e4 * s2 * cw2 - 160.0 * c * e4 * s2 - 448.0 * c * e4 * cw2 - 128.0 * c * e4 + 1152.0 * c * e2 * eta * s2 - 768.0 * c * e2 * eta - 960.0 * c * e2 * s2 * cw2 + 1440.0 * c * e2 * s2 + 448.0 * c * e2 * cw2 - 1024.0 * c * e2 - 1152.0 * c * eta * s2 + 768.0 * c * eta - 1280.0 * c * s2 + 1152.0 * c + 2256.0 * e4 * eta * s4 * cw2 - 27.0 * e4 * eta * s4 * cw4 - 806.0 * e4 * eta * s4 - 2016.0 * e4 * eta * s2 * cw2 - 80.0 * e4 * eta * s2 + 368.0 * e4 * eta + 2160.0 * e4 * s4 * cw2 - 1512.0 * e4 * s4 - 2528.0 * e4 * s2 * cw2 + 1248.0 * e4 * s2 + 448.0 * e4 * cw2 - 64.0 * e4 + 288.0 * e2 * eta * s4 * cw2 + 1312.0 * e2 * eta * s4 + 448.0 * e2 * eta * s2 * cw2 - 3584.0 * e2 * eta * s2 + 1280.0 * e2 * eta - 1680.0 * e2 * s4 * cw2 + 6104.0 * e2 * s4 + 2080.0 * e2 * s2 * cw2 - 9376.0 * e2 * s2 - 448.0 * e2 * cw2 + 3648.0 * e2 + 480.0 * eta * s4 * cw2 - 6176.0 * eta * s4 - 448.0 * eta * s2 * cw2 + 8704.0 * eta * s2 - 3328.0 * eta - 480.0 * s4 * cw2 - 4592.0 * s4 + 448.0 * s2 * cw2 + 8128.0 * s2 - 3584.0) * inv_p4 * inv_e2m1)
      + kJ3 * ((-3.0 / 8.0) * e * n * s * (5.0 * c3 * e2 - 5.0 * c3 * eta - 5.0 * c3 - 10.0 * c2 * e2 + 10.0 * c2 * eta + 10.0 * c2 - 20.0 * c * e2 * eta * s2 + 16.0 * c * e2 * eta - 50.0 * c * e2 * s2 + 31.0 * c * e2 + 55.0 * c * eta * s2 - 35.0 * c * eta + 50.0 * c * s2 - 31.0 * c - 20.0 * e2 * eta * s2 + 16.0 * e2 * eta - 50.0 * e2 * s2 + 42.0 * e2 + 55.0 * eta * s2 - 46.0 * eta + 50.0 * s2 - 42.0) * sw1 * inv_p3 * inv_cp1 * inv_ep)
      + kJ4 * ((15.0 / 128.0) * n * (56.0 * c * e2 * s2 * cw2 - 84.0 * c * e2 * s2 - 24.0 * c * e2 * cw2 + 48.0 * c * e2 - 56.0 * c * s2 + 32.0 * c + 70.0 * e2 * eta * s4 * cw2 - 105.0 * e2 * eta * s4 - 60.0 * e2 * eta * s2 * cw2 + 120.0 * e2 * eta * s2 - 24.0 * e2 * eta + 126.0 * e2 * s4 * cw2 - 189.0 * e2 * s4 - 140.0 * e2 * s2 * cw2 + 252.0 * e2 * s2 + 24.0 * e2 * cw2 - 72.0 * e2 - 28.0 * eta * s4 * cw2 + 24.0 * eta * s2 * cw2 + 28.0 * s4 * cw2 - 196.0 * s4 - 24.0 * s2 * cw2 + 248.0 * s2 - 64.0) * inv_p4)
      + kJ5 * ((5.0 / 256.0) * e * n * s * (2268.0 * c5 * e4 * eta * sw1 - 378.0 * c5 * e4 * eta * sw3 + 4914.0 * c5 * e4 * sw1 - 819.0 * c5 * e4 * sw3 - 4032.0 * c5 * e2 * eta * sw1 + 1008.0 * c5 * e2 * eta * sw3 + 1638.0 * c5 * e2 * sw1 + 819.0 * c5 * e2 * sw3 - 7056.0 * c5 * eta * sw1 - 6552.0 * c5 * sw1 + 2268.0 * c4 * e4 * eta * sw1 - 378.0 * c4 * e4 * eta * sw3 + 4536.0 * c4 * e4 * sw1 - 756.0 * c4 * e4 * sw3 - 3654.0 * c4 * e2 * eta * sw1 + 945.0 * c4 * e2 * eta * sw3 + 1512.0 * c4 * e2 * sw1 + 756.0 * c4 * e2 * sw3 - 6552.0 * c4 * eta * sw1 - 6048.0 * c4 * sw1 - 1512.0 * c3 * e4 * eta * sw1 + 420.0 * c3 * e4 * eta * sw3 - 1512.0 * c3 * e4 * s2 * sw1 + 252.0 * c3 * e4 * s2 * sw3 - 3276.0 * c3 * e4 * sw1 + 910.0 * c3 * e4 * sw3 + 1512.0 * c3 * e2 * eta * s2 * sw1 - 252.0 * c3 * e2 * eta * s2 * sw3 + 2688.0 * c3 * e2 * eta * sw1 - 1120.0 * c3 * e2 * eta * sw3 - 504.0 * c3 * e2 * s2 * sw1 - 252.0 * c3 * e2 * s2 * sw3 - 1092.0 * c3 * e2 * sw1 - 910.0 * c3 * e2 * sw3 + 2016.0 * c3 * eta * s2 * sw1 + 4704.0 * c3 * eta * sw1 + 2016.0 * c3 * s2 * sw1 + 4368.0 * c3 * sw1 - 1512.0 * c2 * e4 * eta * sw1 + 420.0 * c2 * e4 * eta * sw3 - 3024.0 * c2 * e4 * sw1 + 840.0 * c2 * e4 * sw3 + 2436.0 * c2 * e2 * eta * sw1 - 1050.0 * c2 * e2 * eta * sw3 - 1008.0 * c2 * e2 * sw1 - 840.0 * c2 * e2 * sw3 + 4368.0 * c2 * eta * sw1 + 4032.0 * c2 * sw1 + 108.0 * c * e4 * eta * sw1 - 42.0 * c * e4 * eta * sw3 + 504.0 * c * e4 * s2 * sw1 - 140.0 * c * e4 * s2 * sw3 + 234.0 * c * e4 * sw1 - 91.0 * c * e4 * sw3 - 504.0 * c * e2 * eta * s2 * sw1 + 140.0 * c * e2 * eta * s2 * sw3 - 192.0 * c * e2 * eta * sw1 + 112.0 * c * e2 * eta * sw3 + 168.0 * c * e2 * s2 * sw1 + 140.0 * c * e2 * s2 * sw3 + 78.0 * c * e2 * sw1 + 91.0 * c * e2 * sw3 - 672.0 * c * eta * s2 * sw1 - 336.0 * c * eta * sw1 - 672.0 * c * s2 * sw1 - 312.0 * c * sw1 + 108.0 * e4 * eta * sw1 - 42.0 * e4 * eta * sw3 + 216.0 * e4 * sw1 - 84.0 * e4 * sw3 - 174.0 * e2 * eta * sw1 + 105.0 * e2 * eta * sw3 + 72.0 * e2 * sw1 + 84.0 * e2 * sw3 - 312.0 * eta * sw1 - 288.0 * sw1) * inv_p5 * inv_cp1 * inv_ep);
  six[0] = 0.0;
  six[1] = edot;
  six[2] = idot;
  six[3] = evdot;
  six[4] = sodot;
  six[5] = ldot;
}

inline void third_body_six_coefs_ap(double e, double eta, double sinc1, double inv_cp1, double sw1, double cw1, double* coef) {
  const double e2 = e * e, em1p1 = (e - 1.0) * (e + 1.0);
#ifdef __wasm_simd128__
  const v128_t vinv = wasm_f64x2_div(wasm_f64x2_splat(1.0), wasm_f64x2_make(eta, eta + 1.0));
  const double inv_eta = wasm_f64x2_extract_lane(vinv, 0);
  const double inv_ep1 = wasm_f64x2_extract_lane(vinv, 1);
#else
  const double inv_eta = 1.0 / eta, inv_ep1 = 1.0 / (eta + 1.0);
#endif
  const double sc_eta = sinc1 * inv_eta * inv_cp1;
  coef[0] = (-7.5) * e * eta;
  coef[1] = (75.0 / 16.0) * eta * (6.0 * e2 + 1.0);
  coef[2] = (-75.0 / 16.0) * eta * em1p1;
  coef[3] = (-15.0 / 16.0) * eta * (3.0 * e2 + 4.0);
  coef[4] = 1.5 * (4.0 * e2 + 1.0) * cw1 * inv_eta;
  coef[5] = 1.5 * em1p1 * sw1 * inv_eta;
  coef[6] = (-75.0 / 16.0) * e * (4.0 * e2 + 3.0) * cw1 * inv_eta;
  coef[7] = (-75.0 / 8.0) * e * em1p1 * sw1 * inv_eta;
  coef[8] = (75.0 / 16.0) * e * em1p1 * cw1 * inv_eta;
  coef[9] = (15.0 / 16.0) * e * (3.0 * e2 + 4.0) * cw1 * inv_eta;
  coef[10] = 6.0 * e * eta;
  coef[11] = (-1.5) * e * eta;
  coef[12] = 1.5 * e * (4.0 * e2 + 1.0) * sw1 * sc_eta;
  coef[13] = (-1.5) * e * em1p1 * cw1 * sc_eta;
  coef[14] = (-1.5) * e * eta;
  coef[15] = (-75.0 / 16.0) * eta * (4.0 * e2 + 1.0);
  coef[16] = (75.0 / 16.0) * eta * (3.0 * e2 - 1.0);
  coef[17] = (-75.0 / 16.0) * e2 * (4.0 * e2 + 3.0) * sw1 * sc_eta;
  coef[18] = (75.0 / 8.0) * e2 * em1p1 * cw1 * sc_eta;
  coef[19] = (75.0 / 16.0) * e2 * em1p1 * sw1 * sc_eta;
  coef[20] = (15.0 / 16.0) * eta * (9.0 * e2 + 4.0);
  coef[21] = (15.0 / 16.0) * e2 * (3.0 * e2 + 4.0) * sw1 * sc_eta;
  coef[22] = 1.5 * (4.0 * e2 + 1.0) * sw1 * inv_eta;
  coef[23] = (-1.5) * em1p1 * cw1 * inv_eta;
  coef[24] = (-75.0 / 16.0) * e * (4.0 * e2 + 3.0) * sw1 * inv_eta;
  coef[25] = (75.0 / 8.0) * e * em1p1 * cw1 * inv_eta;
  coef[26] = (75.0 / 16.0) * e * em1p1 * sw1 * inv_eta;
  coef[27] = (15.0 / 16.0) * e * (3.0 * e2 + 4.0) * sw1 * inv_eta;
  coef[28] = (-3.0) * (2.0 * e2 * eta + 4.0 * e2 + eta + 1.0) * inv_ep1;
  coef[29] = 1.5 * (e2 * eta + 2.0 * e2 - 2.0 * eta - 2.0) * inv_ep1;
  coef[30] = 1.5 * (4.0 * e2 + 1.0) * sw1 * sc_eta;
  coef[31] = (-1.5) * em1p1 * cw1 * sc_eta;
  coef[32] = 0.5 * (3.0 * e2 * eta + 6.0 * e2 + 4.0 * eta + 4.0) * inv_ep1;
  coef[33] = (75.0 / 16.0) * e * (4.0 * e2 * eta + 8.0 * e2 + 5.0 * eta + 6.0) * inv_ep1;
  coef[34] = (-75.0 / 16.0) * e * (3.0 * e2 * eta + 6.0 * e2 - 5.0 * eta - 6.0) * inv_ep1;
  coef[35] = (-75.0 / 16.0) * e * (4.0 * e2 + 3.0) * sw1 * sc_eta;
  coef[36] = (75.0 / 8.0) * e * em1p1 * cw1 * sc_eta;
  coef[37] = (75.0 / 16.0) * e * em1p1 * sw1 * sc_eta;
  coef[38] = (-15.0 / 16.0) * e * (9.0 * e2 * eta + 18.0 * e2 + 20.0 * eta + 24.0) * inv_ep1;
  coef[39] = (15.0 / 16.0) * e * (3.0 * e2 + 4.0) * sw1 * sc_eta;
}

// --- AP (SPEC 16.14): the solid Earth tide ---------------------------------------------------------------------------
namespace tide {

/// IERS Conventions (2010) Table 6.3, the anelastic Love numbers of degree 2: Re k20, and |k21|, |k22| with the cosine and
/// sine of -arg(k2m) / m, the angle (rad) by which each order's bulge leads the body (Im k21 -0.00144, Im k22 -0.00130).
constexpr double kK20 = 0.30190;
constexpr double kK21 = 0.29830347567535986, kC21 = 0.9999883485254338, kS21 = 0.004827298765929014;
constexpr double kK22 = 0.30102280710936175, kC22 = 0.9999976686877476, kS22 = 0.0021593098596026012;

/// IERS Conventions (2010) Table 6.5a, step 2's corrections to k21 (the diurnal band): the multipliers of the Delaunay
/// arguments (l, l', F, D, Omega) and the in-phase and out-of-phase amplitudes (1e-12).
struct Band {
  int8_t n[5];
  double ip, op;
};
constexpr Band kK21Band[] = {
    {{2, 0, 2, 0, 2}, -0.1, 0.0},    {{0, 0, 2, 2, 2}, -0.1, 0.0},    {{1, 0, 2, 0, 1}, -0.1, 0.0},
    {{1, 0, 2, 0, 2}, -0.7, 0.1},    {{-1, 0, 2, 2, 2}, -0.1, 0.0},   {{0, 0, 2, 0, 1}, -1.3, 0.1},
    {{0, 0, 2, 0, 2}, -6.8, 0.6},    {{0, 0, 0, 2, 0}, 0.1, 0.0},     {{1, 0, 2, -2, 2}, 0.1, 0.0},
    {{-1, 0, 2, 0, 1}, 0.1, 0.0},    {{-1, 0, 2, 0, 2}, 0.4, 0.0},    {{1, 0, 0, 0, 0}, 1.3, -0.1},
    {{1, 0, 0, 0, 1}, 0.3, 0.0},     {{-1, 0, 0, 2, 0}, 0.3, 0.0},    {{-1, 0, 0, 2, 1}, 0.1, 0.0},
    {{0, 1, 2, -2, 2}, -1.9, 0.1},   {{0, 0, 2, -2, 1}, 0.5, 0.0},    {{0, 0, 2, -2, 2}, -43.4, 2.9},
    {{0, -1, 2, -2, 2}, 0.6, 0.0},   {{0, 1, 0, 0, 0}, 1.6, -0.1},    {{-2, 0, 2, 0, 1}, 0.1, 0.0},
    {{0, 0, 0, 0, -2}, 0.1, 0.0},    {{0, 0, 0, 0, -1}, -8.8, 0.5},   {{0, 0, 0, 0, 0}, 470.9, -30.2},
    {{0, 0, 0, 0, 1}, 68.1, -4.6},   {{0, 0, 0, 0, 2}, -1.6, 0.1},    {{-1, 0, 0, 1, 0}, 0.1, 0.0},
    {{0, -1, 0, 0, -1}, -0.1, 0.0},  {{0, -1, 0, 0, 0}, -20.6, -0.3}, {{0, 1, -2, 2, -2}, 0.3, 0.0},
    {{0, -1, 0, 0, 1}, -0.3, 0.0},   {{-2, 0, 0, 2, 0}, -0.2, 0.0},   {{-2, 0, 0, 2, 1}, -0.1, 0.0},
    {{0, 0, -2, 2, -2}, -5.0, 0.3},  {{0, 0, -2, 2, -1}, 0.2, 0.0},   {{0, -1, -2, 2, -2}, -0.2, 0.0},
    {{1, 0, 0, -2, 0}, -0.5, 0.0},   {{1, 0, 0, -2, 1}, -0.1, 0.0},   {{-1, 0, 0, 0, -1}, 0.1, 0.0},
    {{-1, 0, 0, 0, 0}, -2.1, 0.1},   {{-1, 0, 0, 0, 1}, -0.4, 0.0},   {{0, 0, 0, -2, 0}, -0.2, 0.0},
    {{-2, 0, 0, 0, 0}, -0.1, 0.0},   {{0, 0, -2, 0, -2}, -0.6, 0.0},  {{0, 0, -2, 0, -1}, -0.4, 0.0},
    {{0, 0, -2, 0, 0}, -0.1, 0.0},   {{-1, 0, -2, 0, -2}, -0.1, 0.0}, {{-1, 0, -2, 0, -1}, -0.1, 0.0}};

/// Step 2's diurnal band at d50 (days from 1950 January 0.0), in the set's axes, into `out` (the tensor's xz and yz,
/// ER^5/min^2). The Earth-fixed corrections dC21, dS21 at theta = (GMST + pi) - N.F, seen from inertial axes, are
/// C' cos(alpha) + S' sin(alpha) in right ascension with C' = sum(ip sin b - op cos b), S' = -sum(ip cos b + op sin b),
/// b = N.F (GMST cancels): a term fixed in inertial axes but for b. Its potential (mu / r) (R / r)^2 sqrt(15) sin(phi)
/// cos(phi) (C' cos alpha + S' sin alpha) is r^-3 r.T.r with T_xz = (sqrt(15) / 2) mu C', T_yz = (sqrt(15) / 2) mu S'. It is
/// evaluated once, at the epoch: over 10 days b moves the band by under 3e-12 of its 5e-10 (the P1 line, 2 L_sun).
inline void diurnal_band(double d50, double out[2]) {
  const double T = (d50 - 18263.5) / 36525.0;
  // IERS Conventions (2010) eq. 5.43 to T^2: l, l', F, D, Omega (arcseconds)
  const double arg[5] = {(134.96340251 * 3600.0 + (1717915923.2178 + 31.8792 * T) * T) * kArcsec,
                         (357.52910918 * 3600.0 + (129596581.0481 - 0.5532 * T) * T) * kArcsec,
                         (93.27209062 * 3600.0 + (1739527262.8478 - 12.7512 * T) * T) * kArcsec,
                         (297.85019547 * 3600.0 + (1602961601.2090 - 6.3706 * T) * T) * kArcsec,
                         (125.04455501 * 3600.0 + (-6962890.5431 + 7.4722 * T) * T) * kArcsec};
  double c = 0.0, s = 0.0;
  for (const Band& w : kK21Band) {
    double b = 0.0;
    for (int i = 0; i < 5; ++i) b += w.n[i] * arg[i];
    const double sb = std::sin(b), cb = std::cos(b);
    c += w.ip * sb - w.op * cb;
    s -= w.ip * cb + w.op * sb;
  }
  constexpr double k = 1.9364916731037085 * kMu * 1e-12;  // sqrt(15) / 2 mu R^2 (R 1 ER), the amplitudes in 1e-12
  out[0] = k * c;
  out[1] = k * s;
}

/// The tide's averaged rates, added to the equinoctial rates `out` of the state y (frame fr, its a, n, e2, eta and axes),
/// with the bodies b of the stage and the band k1 (diurnal_band). The potential of the degree-2 tide is r^-3 r.T.r, T the
/// symmetric traceless tensor (ER^5/min^2) of the two bodies' (3/2) mu_b R^5 / r_b^3 (s s^T - I/3), each order m of it (zz;
/// xz, yz; xx - yy, xy about the Earth's axis) weighted by its k2m and turned by its lead, plus the band. With W the orbit
/// normal, g = T W and P = W.g, its average over the mean anomaly is -P / (2 a^3 eta^3); with D = 1 / (n a^5 eta^4), N the
/// node and M the in-plane direction 90 deg past it: di/dt = D g.N, sin i dOmega/dt = D g.M, d varpi/dt = D (tan(i/2) g.M
/// - 1.5 P), d lambda/dt - n = D (tan(i/2) g.M - 3 eta P - 1.5 e^2 P / (1 + eta)); e and n do not move. In the equinoctial
/// axes N sin Omega + M cos Omega = fr.g and N cos Omega - M sin Omega = fr.f, so chi-dot = D g.fr.g / (1 + cos i) and
/// psi-dot = D g.fr.f / (1 + cos i), regular at i = 0 as tan(i/2) M is.
inline void rates_eq(const double k1[2], const Bodies& b, const double* y, const Frame& fr, double* out) {
  double txx = 0.0, tyy = 0.0, tzz = 0.0, txy = 0.0, txz = k1[0], tyz = k1[1];
  const Vec3 us[2] = {b.sun_u, b.moon_u};
  const double rs[2] = {b.sun_r, b.moon_r}, ms[2] = {kSunMass, kMoonMass};
  for (int j = 0; j < 2; ++j) {
    const Vec3 u = us[j];
    const double kappa = 1.5 * ms[j] * kMu / (rs[j] * rs[j] * rs[j]);
    const double c0 = kappa * kK20 * (u.z * u.z - 1.0 / 3.0);
    txx -= 0.5 * c0;
    tyy -= 0.5 * c0;
    tzz += c0;
    const double c1 = kappa * kK21 * u.z;
    txz += c1 * (u.x * kC21 - u.y * kS21);
    tyz += c1 * (u.x * kS21 + u.y * kC21);
    const double x2 = u.x * kC22 - u.y * kS22, y2 = u.x * kS22 + u.y * kC22, c2 = kappa * kK22;
    const double d2 = 0.5 * c2 * (x2 * x2 - y2 * y2);
    txx += d2;
    tyy -= d2;
    txy += c2 * x2 * y2;
  }
  const Vec3 W = fr.w;
  const Vec3 g = {txx * W.x + txy * W.y + txz * W.z, txy * W.x + tyy * W.y + tyz * W.z, txz * W.x + tyz * W.y + tzz * W.z};
  const double chi = y[kChi], psi = y[kPsi], ci = W.z;
  const Vec3 tM = {-ci * chi, ci * psi, 2.0 * (chi * chi + psi * psi) * fr.ic};  // tan(i/2) M
  const double P = dot(W, g), gT = dot(g, tM);
  const double a2 = fr.a * fr.a, one_e2 = 1.0 - fr.e2;
  const double D = 1.0 / (fr.n * a2 * a2 * fr.a * one_e2 * one_e2);
  const double h = 0.5 * fr.c * D;  // D / (1 + cos i)
  out[kChi] += h * dot(g, fr.g);
  out[kPsi] += h * dot(g, fr.f);
  const double wdot = D * (gT - 1.5 * P);
  out[kAf] -= y[kAg] * wdot;
  out[kAg] += y[kAf] * wdot;
  out[kLam] += D * (gT - P * (3.0 * fr.eta + 1.5 * fr.e2 / (1.0 + fr.eta)));
}

}  // namespace tide

[[gnu::noinline]] inline int32_t output_j2_osc(const double* y, double Ewarm, double r_out[3], double v_out[3]);

/// SPEC 16.22: AP in the long-period regime above e 0.3, where its Sun and Moon go through the output map (16.19), takes radiation
/// pressure the same way: neither SPEC 4's orbit-averaged rates nor its first-order periodic output terms carry it there.
inline bool lp_radiation_through_output(const RateContext& ctx) {
  return ctx.long_period && ctx.ap_third_body && ctx.branch.wide_e;
}

/// SPEC 4's two carriers of radiation pressure, everywhere else (16.22): its orbit-averaged rates and its first-order periodic
/// output terms. The gates read these, and so does the field's census (16.20), so a set's partition is the one it flies.
inline bool radiation_averaged(const RateContext& ctx) { return !lp_radiation_through_output(ctx); }
inline bool radiation_periodic(const RateContext& ctx) { return !lp_radiation_through_output(ctx); }

/// SPEC 16.22: the share of the time window [-w, w] about now that a satellite at r (Earth radii) moving at v (straight; v per
/// the unit of w) spends outside AP's shadow (16.15: the cylinder of radius R_E behind the Earth, toward -s). The integrator
/// takes the long-period regime's step across a shadow boundary, so the force is the window's share of light, not a step.
inline double radiation_lit_share(Vec3 r, Vec3 v, Vec3 s, double w) {
  const Vec3 rc = cross(r, s), vc = cross(v, s);
  const double A = dot(vc, vc), B = 2.0 * dot(rc, vc), C = dot(rc, rc) - 1.0;
  double lo = -w, hi = w;
  if (A > 0.0) {
    const double disc = B * B - 4.0 * A * C;
    if (!(disc > 0.0)) return 1.0;
    const double q = std::sqrt(disc);
    lo = std::fmax(lo, (-B - q) / (2.0 * A));
    hi = std::fmin(hi, (-B + q) / (2.0 * A));
  } else if (C >= 0.0) {
    return 1.0;
  }
  const double a0 = dot(r, s), a1 = dot(v, s);
  if (a1 > 0.0) hi = std::fmin(hi, -a0 / a1);
  else if (a1 < 0.0) lo = std::fmax(lo, -a0 / a1);
  else if (a0 >= 0.0) return 1.0;
  if (!(hi > lo)) return 1.0;
  return std::fmax(0.0, 1.0 - (hi - lo) / (2.0 * w));
}

/// SPEC 16.22: AP's radiation pressure at a position r (Earth radii from the Earth's center) moving at v: the cannonball
/// acceleration away from the Sun, SPEC 4's pressure kSrpPressure at 1 AU over the square of the Sun-to-satellite distance,
/// times agom (Cr A/m, m^2/kg), and times the share of the window [-w, w] spent outside AP's shadow. Earth radii per minute
/// squared.
inline Vec3 radiation_accel(Vec3 r, Vec3 v, double w, const Bodies& b, double agom) {
  const double lit = radiation_lit_share(r, v, b.sun_u, w);
  if (!(lit > 0.0)) return Vec3{0.0, 0.0, 0.0};
  const Vec3 rel = r - b.sun_r * b.sun_u;
  const double rr = norm(rel), rs_au = rr * kRe / kAu;
  const double Fs = kSrpPressure * agom * 3600.0 / (1000.0 * kRe * rs_au * rs_au);
  return (lit * Fs / rr) * rel;
}

/// AP in the long-period regime above e 0.3 (SPEC 16.19): the Sun's and Moon's rates of the mean elements y, and with agom > 0
/// radiation pressure's (16.22), the rates that move AP's
/// osculating state there (SPEC 8's J2 output, output_j2_osc) by the bodies' point-mass acceleration at that state:
/// J m = (0, a), J the output's Jacobian in the six elements (forward differences), solved by Gaussian elimination with
/// partial pivoting. The Gauss equations at the mean state alone move the J2 output by J2's short-period Jacobian times
/// the bodies' rates as well, a velocity of the bodies' order times J2 at once. False when the output or the solve fails
/// (the caller keeps the Gauss rates).
inline bool lp_third_body_through_output(const double* y, const Bodies& b, double tb[6], double agom, double half_window_s) {
  double x0[6], J[6][7];
  // the base state, and the eccentric anomaly every column starts its Kepler equation from
  const Kepler k0 = kepler_of(y);
  if (!(k0.e < 1.0)) return false;
  double E = k0.m + k0.e * std::sin(k0.m);
  for (int it = 0; it < 30; ++it) {
    const double dE = (E - k0.e * std::sin(E) - k0.m) / (1.0 - k0.e * std::cos(E));
    E -= dE;
    if (std::fabs(dE) < 1e-15) break;
  }
  if (output_j2_osc(y, E, x0, x0 + 3) != kPropOk) return false;
  for (int c = 0; c < 6; ++c) {
    const double h = c == kN ? 1e-7 * y[kN] : 1e-7;
    double yc[6], xc[6];
    for (int j = 0; j < 6; ++j) yc[j] = y[j];
    yc[c] += h;
    if (output_j2_osc(yc, E, xc, xc + 3) != kPropOk) return false;
    for (int q = 0; q < 6; ++q) J[q][c] = (xc[q] - x0[q]) / h;
  }
  // the bodies' acceleration at the osculating position, km/s^2 (output_j2_osc's km and km/s)
  const Vec3 r{x0[0] / kRe, x0[1] / kRe, x0[2] / kRe};
  Vec3 d = third_body_accel(r, b.sun_u, b.sun_r, kSunMass) + third_body_accel(r, b.moon_u, b.moon_r, kMoonMass);
  if (agom > 0.0) d = d + radiation_accel(r, Vec3{x0[3] / kRe, x0[4] / kRe, x0[5] / kRe}, half_window_s, b, agom);
  const double s = kRe / 3600.0;
  J[0][6] = J[1][6] = J[2][6] = 0.0;
  J[3][6] = d.x * s;
  J[4][6] = d.y * s;
  J[5][6] = d.z * s;
  for (int c = 0; c < 6; ++c) {
    int p = c;
    for (int q = c + 1; q < 6; ++q)
      if (std::fabs(J[q][c]) > std::fabs(J[p][c])) p = q;
    if (p != c)
      for (int j = 0; j < 7; ++j) std::swap(J[p][j], J[c][j]);
    if (!(J[c][c] != 0.0)) return false;
    for (int q = c + 1; q < 6; ++q) {
      const double f = J[q][c] / J[c][c];
      for (int j = c; j < 7; ++j) J[q][j] -= f * J[c][j];
    }
  }
  double m[6];
  for (int c = 5; c >= 0; --c) {
    double x = J[c][6];
    for (int j = c + 1; j < 6; ++j) x -= J[c][j] * m[j];
    m[c] = x / J[c][c];
  }
  for (int j = 0; j < 6; ++j) {
    if (!std::isfinite(m[j])) return false;
    tb[j] = 60.0 * m[j];  // per second to per minute
  }
  return true;
}

/// The averaged rates f(t, y) of SPEC 9: false when the state fails the 9.9 tests (state_test). AP sums the epoch
/// class's terms whatever the current mean motion (SPEC 16.7): the class is the record's, decided at its epoch.
inline bool rates(const RateContext& ctx, double t, const double* y, double* out,
                  int dir_idx = 0, int step_idx = 0, int stage_idx = -1,
                  const Rk3StageOverride* ov = nullptr) {
  if (state_test(ctx, y) != 0) return false;
  const int cls = ctx.ap_resonance ? ctx.resonance : 0;
  const bool fast_ap = ctx.ap_third_body && (!ctx.long_period || ctx.i0 > 0.02);
  const Frame fr = fast_ap ? frame_of_fast(y) : frame_of(y);

  CovGridCache& cgc = cov_grid_cache();
  EpochAux& ea = epoch_aux();
  const bool ap_ctx = is_ap_ctx(ctx);
  // A covariance's moved set is flown on its own (stack #491): it reads nothing the nominal or another set left in
  // this thread's caches; only the nominal records the parts its own rk3 holds over a step (SPEC 9)
  const bool is_sigma = ap_ctx && (ctx.is_cov_sigma != 0);
  const bool record_epoch_aux = ap_ctx && !is_sigma && stage_idx == -1 && t == 0.0;
  CovStageAux* csa = (ap_ctx && !is_sigma && stage_idx >= 0 && step_idx > 0 && step_idx < CovGridCache::kMaxCovSteps)
                         ? &cgc.steps[dir_idx][step_idx].st[stage_idx]
                         : nullptr;
  const bool record_stage_aux = csa != nullptr && cgc.anchor_id == ctx.ctx_id;
  const bool skip_tail = ov != nullptr && ov->tail_eq != nullptr;
  const bool cache_geo_res = ctx.ap_resonance != 0 && ctx.i0 > 0.02;

  Kepler k{};
  AngleTrig ag{};
  double s = 0.0, c = 1.0;
  const double t2_ap = y[kChi] * y[kChi] + y[kPsi] * y[kPsi];
  if (fast_ap && fr.e2 > 1e-24 && t2_ap > 1e-24 && fr.e2 < 1.0) {
    k.a = fr.a;
#ifdef __wasm_simd128__
    const v128_t vet = wasm_f64x2_sqrt(wasm_f64x2_make(fr.e2, t2_ap));
    const v128_t viv = wasm_f64x2_div(wasm_f64x2_splat(1.0), vet);
    k.e = wasm_f64x2_extract_lane(vet, 0);
    const double t_inc = wasm_f64x2_extract_lane(vet, 1);
    const double inv_e = wasm_f64x2_extract_lane(viv, 0);
    const double inv_t = wasm_f64x2_extract_lane(viv, 1);
#else
    k.e = std::sqrt(fr.e2);
    const double t_inc = std::sqrt(t2_ap);
    const double inv_t = 1.0 / t_inc;
    const double inv_e = 1.0 / k.e;
#endif
    ag.ci = fr.w.z;
    ag.si = 2.0 * t_inc * fr.ic;
    ag.sO = y[kChi] * inv_t;
    ag.cO = y[kPsi] * inv_t;
    const double cv = y[kAf] * inv_e, sv = y[kAg] * inv_e;
    ag.cw = cv * ag.cO + sv * ag.sO;
    ag.sw = sv * ag.cO - cv * ag.sO;
    const bool need_tail_angles =
        !skip_tail && ((cls != 0) || (ctx.shallow != nullptr) || (ctx.wide_slow != nullptr) || (ctx.zt_wide != 0));
    const bool need_k_angles = (ctx.res_epoch != nullptr) || (ctx.drag_pass != 0) || need_tail_angles ||
                               (ctx.ap_resonance && cls != 0 && !(cls == 1 && cache_geo_res)) ||
                               (ctx.agom > 0.0 && fr.e2 != 0.0 && k.a >= 5.0 && ag.si <= 0.02) ||
                               (shadow_envelope() != 0);
    if (need_k_angles) {
      const double varpi = fm::atan2(y[kAg], y[kAf]);
      const double node_raw = fm::atan2(y[kChi], y[kPsi]);
      k.node = fast_wrap(node_raw);
      k.argp = fast_wrap(varpi - node_raw);
      k.m = fast_wrap(y[kLam] - varpi);
      k.i = 2.0 * fm::atan(t_inc);
    }
    s = ag.si;
    c = ag.ci;
  } else {
    k = kepler_of(y, fr.a);
    s = std::sin(k.i);
    c = std::cos(k.i);
    ag = angle_trig(k);
  }
  // SGP4XP's zonal rates take p = a (1 - e e) with e the square root of af^2 + ag^2 (its conformance digest, SPEC 16.4);
  // AP's take af^2 + ag^2 as summed (0.6.5). The two differ by up to a unit in the last place.
  const double p = ap_ctx ? fr.a * (1.0 - fr.e2) : fr.a * (1.0 - k.e * k.e);
  const double inv_cp1 = 0.5 * fr.c;
  double six[6] = {0, 0, 0, 0, 0, 0};
  if (fast_ap) zonal_six_ap(k.e, fr.n, s, c, fr.eta, p, ag.sw, ag.cw, inv_cp1, six);
  else zonal_six(k.e, fr.n, s, c, fr.eta, p, k.argp, k.i, six);

  const Bodies b = ctx.ap_third_body ? bodies_at_ap(ctx.d50_epoch + t / kMinutesPerDay) : bodies_at(ctx.d50_epoch + t / kMinutesPerDay);
  if (record_epoch_aux) {
    ea.ctx_id = ctx.ctx_id;
    ea.valid = true;
    ea.has_tb = false;
    ea.has_drag = false;
    ea.has_srp = false;
    ea.srp_sunlit_safe = false;
    ea.has_tail = false;
    ea.has_tail_eq = false;
  } else if (record_stage_aux) {
    csa->gen = cgc.gen;
    csa->has_tb = false;
    csa->has_drag = false;
    csa->has_srp = false;
    csa->srp_sunlit_safe = false;
    csa->has_tail = false;
    csa->has_tail_eq = false;
  }

  const Perifocal pf = perifocal_of(ag);
  if (!ctx.long_period) {
    const Vec3 us[2] = {b.sun_u, b.moon_u};
    const double rs[2] = {b.sun_r, b.moon_r}, ms[2] = {kSunMass, kMoonMass};
    double coef[kThird_body_sixCoefs];
    if (fast_ap) third_body_six_coefs_ap(k.e, fr.eta, ag.si, inv_cp1, ag.sw, ag.cw, coef);
    else third_body_six_coefs(k.e, fr.n, fr.eta, k.i, k.argp, coef);
    for (int j = 0; j < 2; ++j) {
      double A, B, C;
      direction_cosines(pf, us[j], A, B, C);
      const double ar = fr.a / rs[j];
      const double C2 = ms[j] * ar * ar * ar * fr.n;
      third_body_six(coef, A, B, C, C2, C2 * ar, six);
    }
  }
  // SGP4XP integrates the epoch class with its functions at e_0, i_0 (SPEC 6.3; a native report is a fresh
  // initialization at its time, abi.inc)
  if (ctx.res_epoch != nullptr) res::resonance_six(ctx.res_epoch, ctx.res_count, t, k, fr.n, fr.eta, ag.si, ag.ci, ctx.theta_g0, six);
  if (ctx.ap_resonance) {
    if (cls != 0 && !(cls == 1 && cache_geo_res)) {
      res::ResCoef terms[29];
      const int count = res::ap_terms(cls, k.e, ag.si, ag.ci, ctx.res_taylor, ctx.resonance, ctx.e0, terms);
      if (ctx.i0 > 0.02) res::resonance_six_ap(terms, count, t, k, fr.n, fr.eta, ag.si, ag.ci, ctx.theta_g0, six);
      else res::resonance_six(terms, count, t, k, fr.n, fr.eta, ag.si, ag.ci, ctx.theta_g0, six);
    }
  }
  auto eval_tail = [&](double* dst) {
    if (cls == 1 && cache_geo_res) {
      res::ResCoef terms[29];
      const int count = res::ap_terms(cls, k.e, ag.si, ag.ci, ctx.res_taylor, ctx.resonance, ctx.e0, terms);
      res::resonance_six_ap(terms, count, t, k, fr.n, fr.eta, ag.si, ag.ci, ctx.theta_g0, dst);
    }
    if (ctx.ap_resonance && (cls == 2 || cls == 1) && ctx.half_day != nullptr) {
      tess::half_day_six(ctx.half_day, ctx.half_day_count, ctx.hd_e0, ctx.hd_i0, t, k,
                         fr.n, fr.eta, ag.si, ag.ci, ctx.theta_g0, dst, ctx.hd_a0, hd_table_id(ctx), cls == 1 ? 1 : 2);
    }
    if (ctx.shallow != nullptr) {
      tess::shallow_six(ctx.shallow, ctx.shallow_count, ctx.e0, ctx.i0, t, k, fr.a, fr.n, fr.eta, ag.si, ag.ci,
                        ctx.theta_g0, dst, sh_table_id(ctx));
    }
    if (ctx.wide_slow != nullptr)
      tess::wide_slow_six(ctx.wide_slow, ctx.wide_slow_count, ctx.e0, ctx.i0, t, k, fr.a, fr.n, fr.eta, ag.si, ag.ci, ctx.theta_g0, dst);
    if (ctx.zt != nullptr)
      tess::zonal_six(ctx.zt, ctx.zt_degree, ctx.zt_wide != 0, k, fr.n, fr.eta, ag.si, ag.ci, dst, &ag.sw, &ag.cw,
                      zt_table_id(ctx), ctx.zt_er);
  };
  if (!skip_tail) {
    if (record_epoch_aux || record_stage_aux || (ov != nullptr && ov->tail_eq_out != nullptr)) {
      double six_before_tail[6];
      for (int m = 0; m < 6; ++m) six_before_tail[m] = six[m];
      eval_tail(six);
      double st_tail[6];
      for (int m = 0; m < 6; ++m) st_tail[m] = six[m] - six_before_tail[m];
      double teq[6];
      const bool need_teq = ctx.long_period && ctx.ap_third_body;
      if (need_teq || (ov != nullptr && ov->tail_eq_out != nullptr)) {
        six_to_equinoctial(ag, st_tail, teq);
      }
      if (ov != nullptr && ov->tail_eq_out != nullptr) {
        for (int m = 0; m < 6; ++m) ov->tail_eq_out[m] = teq[m];
      }
      if (ov != nullptr && ov->six_tail_out != nullptr) {
        for (int m = 0; m < 6; ++m) ov->six_tail_out[m] = st_tail[m];
      }
      if (record_epoch_aux) {
        for (int m = 0; m < 6; ++m) ea.six_tail[m] = st_tail[m];
        ea.has_tail = true;
        if (need_teq) {
          for (int m = 0; m < 6; ++m) ea.tail_eq[m] = teq[m];
          ea.has_tail_eq = true;
        }
      } else if (record_stage_aux) {
        for (int m = 0; m < 6; ++m) csa->six_tail[m] = st_tail[m];
        csa->has_tail = true;
        if (need_teq) {
          for (int m = 0; m < 6; ++m) csa->tail_eq[m] = teq[m];
          csa->has_tail_eq = true;
        }
      }
    } else {
      eval_tail(six);
    }
  }
  six_to_equinoctial(ag, six, out);
  out[kLam] += fr.n;  // the set carries lambda-dot - n
  // SPEC 16.14: the solid Earth tide, closed form at this state (every regime; nothing at output time)
  if (ctx.solid_tides) tide::rates_eq(ctx.tide_k1, b, y, fr, out);
  if (skip_tail) {
    for (int m = 0; m < 6; ++m) out[m] += ov->tail_eq[m];
  }
  if (ctx.ap_third_body && !ctx.long_period) {
    if (ov != nullptr && ov->tb != nullptr) {
      for (int m = 0; m < 6; ++m) out[m] += ov->tb[m];
      if (record_stage_aux) {
        for (int m = 0; m < 6; ++m) csa->tb[m] = ov->tb[m];
        csa->has_tb = true;
      }
    } else {
      double tb[6] = {0, 0, 0, 0, 0, 0};
      third_body_tail(y, fr, b, tb);
      for (int m = 0; m < 6; ++m) out[m] += tb[m];
      if (ov != nullptr && ov->tb_out != nullptr) {
        for (int m = 0; m < 6; ++m) ov->tb_out[m] = tb[m];
      }
      if (record_epoch_aux) {
        for (int m = 0; m < 6; ++m) ea.tb[m] = tb[m];
        ea.has_tb = true;
      } else if (record_stage_aux) {
        for (int m = 0; m < 6; ++m) csa->tb[m] = tb[m];
        csa->has_tb = true;
      }
    }
  }
  if (ctx.long_period) {
    {
      // Instantaneous geometry: the satellite from the equinoctial Kepler
      // equation lambda = F + ag cos F - af sin F (Halley iteration, at most 25 steps).
      const double lam = y[kLam];
      double F = 0.0, sF_lp = 0.0, cF_lp = 1.0;
      const bool ap_lp_fast = ctx.ap_third_body && ctx.i0 > 0.02;
      if (ap_lp_fast && fr.e2 <= 3e-4) {
        double s0, c0;
        fm::sincos_fast(lam, s0, c0);
        const double es = y[kAf] * s0 - y[kAg] * c0;
        const double ec = y[kAf] * c0 + y[kAg] * s0;
        const double inv_ome0 = 1.0 / (1.0 - ec);
        const double r1 = es * inv_ome0;
        const double rc = ec * inv_ome0;
        const double r1_2 = r1 * r1;
        const double u = r1 * (1.0 - r1_2 * (0.5 + (1.0 / 6.0) * rc - (13.0 / 24.0) * r1_2));
        F = lam + u;
        const double u2 = u * u;
        const double cu = 1.0 - 0.5 * u2 * (1.0 - (1.0 / 12.0) * u2);
        const double su = u * (1.0 - (1.0 / 6.0) * u2 * (1.0 - 0.05 * u2));
        sF_lp = s0 * cu + c0 * su;
        cF_lp = c0 * cu - s0 * su;
      } else {
        if (ap_lp_fast) {
          double s0, c0;
          fm::sincos_fast(lam, s0, c0);
          F = lam + y[kAf] * s0 - y[kAg] * c0;
        } else {
          F = lam;
        }
        double last_dF = 1.0;
        for (int it = 0; it < 25; ++it) {
          if (ap_lp_fast) fm::sincos_fast(F, sF_lp, cF_lp);
          else fm::sincos(F, sF_lp, cF_lp);
          const double fv = F + y[kAg] * cF_lp - y[kAf] * sF_lp - lam;
          const double f1 = 1.0 - y[kAg] * sF_lp - y[kAf] * cF_lp;
          const double f2 = -y[kAg] * cF_lp + y[kAf] * sF_lp;
          const double dF = -fv / (f1 - 0.5 * fv * f2 / f1);
          F += dF;
          last_dF = dF;
          if (std::fabs(dF) < 1e-14) {
            if (ap_lp_fast) {
              const double s_old = sF_lp;
              sF_lp = s_old + cF_lp * dF;
              cF_lp = cF_lp - s_old * dF;
              last_dF = 0.0;
            }
            break;
          }
        }
        if (ap_lp_fast && last_dF != 0.0) fm::sincos_fast(F, sF_lp, cF_lp);
      }
      double tb[6];
      // AP above e 0.3: the rates that move its osculating output by the bodies' acceleration (SPEC 16.19); below it (the
      // effect is a few m there, the cost is not), SGP4XP, or where that fails: the Gauss equations at the mean state
      // and radiation pressure with them (SPEC 16.22): through the output map, or where that fails at the mean state
      const bool lp_radiation = ctx.agom > 0.0 && lp_radiation_through_output(ctx);
      const bool through_output = ctx.ap_third_body && ctx.branch.wide_e && lp_third_body_through_output(y, b, tb, lp_radiation ? ctx.agom : 0.0, 30.0 * ctx.branch.lp_step);
      if (through_output) {
        // tb holds them
      } else if (ap_lp_fast) {
        lp_third_body_gauss_ap(y, fr, sF_lp, cF_lp, b, tb);
        if (lp_radiation) {
          Vec3 r, v;
          double roa, tr[6];
          state_at_F(y, fr, F, r, v, roa);
          gauss(y, fr, r, v, radiation_accel(r, v, 0.5 * ctx.branch.lp_step, b, ctx.agom), tr);
          for (int j = 0; j < 6; ++j) tb[j] += tr[j];
        }
      } else {
        Vec3 r, v;
        double roa;
        state_at_F(y, fr, F, r, v, roa);
        Vec3 d = third_body_accel(r, b.sun_u, b.sun_r, kSunMass) +
                 third_body_accel(r, b.moon_u, b.moon_r, kMoonMass);
        if (lp_radiation) d = d + radiation_accel(r, v, 0.5 * ctx.branch.lp_step, b, ctx.agom);
        gauss(y, fr, r, v, d, tb);
      }
      for (int j = 0; j < 6; ++j) out[j] += tb[j];
      if (record_epoch_aux) {
        for (int j = 0; j < 6; ++j) ea.tb[j] = tb[j];
        ea.has_tb = true;
      } else if (record_stage_aux) {
        for (int j = 0; j < 6; ++j) csa->tb[j] = tb[j];
        csa->has_tb = true;
      }
    }
  }
  // SPEC 4's orbit-averaged radiation rates, except where it goes through the output map (16.22)
  if (ctx.agom > 0.0 && radiation_averaged(ctx)) {
    if (!ap_ctx) {
      srp_rates(y, fr, k, pf, ctx.agom, b, out);
    } else {
    const bool ap_srp = ctx.ap_third_body && (!ctx.long_period || ctx.i0 > 0.02);
    if (ov != nullptr && ov->srp != nullptr) {
      for (int m = 0; m < 6; ++m) out[m] += ov->srp[m];
    } else {
      double ds[6] = {0, 0, 0, 0, 0, 0};
      bool sunlit_safe = false;
      srp_rates(y, fr, k, pf, ctx.agom, b, ds, &ag, ap_srp, &sunlit_safe, true);
      for (int m = 0; m < 6; ++m) out[m] += ds[m];
      if (ov != nullptr && ov->srp_out != nullptr) {
        for (int m = 0; m < 6; ++m) ov->srp_out[m] = ds[m];
      }
      if (record_epoch_aux) {
        const double inv_agom = 1.0 / ctx.agom;
        for (int m = 0; m < 6; ++m) ea.srp_unit[m] = ds[m] * inv_agom;
        ea.has_srp = true;
        ea.srp_sunlit_safe = sunlit_safe;
      } else if (record_stage_aux) {
        const double inv_agom = 1.0 / ctx.agom;
        for (int m = 0; m < 6; ++m) csa->srp_unit[m] = ds[m] * inv_agom;
        csa->has_srp = true;
        csa->srp_sunlit_safe = sunlit_safe;
      }
    }
    }
  }
  if (ctx.bterm > 0.0) {
    if (ov != nullptr && ov->drag != nullptr) {
      for (int m = 0; m < 6; ++m) out[m] += ov->drag[m];
    } else if (!ctx.drag_pass && (record_epoch_aux || record_stage_aux || (ov != nullptr && ov->drag_out != nullptr))) {
      double dd[6] = {0, 0, 0, 0, 0, 0};
      drag_part(ctx, t, y, fr, k, ag, b, dd);
      const double inv_b = 1.0 / ctx.bterm;
      if (ov != nullptr && ov->drag_out != nullptr) {
        for (int m = 0; m < 6; ++m) ov->drag_out[m] = dd[m];
      }
      for (int m = 0; m < 6; ++m) {
        out[m] += dd[m];
        const double du = dd[m] * inv_b;
        if (record_epoch_aux) ea.drag_unit[m] = du;
        else if (record_stage_aux) csa->drag_unit[m] = du;
      }
      if (record_epoch_aux) ea.has_drag = true;
      else if (record_stage_aux) csa->has_drag = true;
    } else {
      drag_part(ctx, t, y, fr, k, ag, b, out);
    }
  }
  return true;
}

// --- SPEC 9: the grid ---------------------------------------------------------

/// One third-order Runge-Kutta step of length h from node `a` (SPEC 9): 0, or kStageFailed when a stage's rates fail
/// (the step's fallbacks apply), kNodeFailed when the new node's own rates do (SPEC 8.4: the node cannot be used).
constexpr int kStageFailed = 1, kNodeFailed = 2;
inline int rk3(const RateContext& ctx, const Node& a, double h, Node& out) {
  const int di = out.index >= 0 ? 0 : 1;
  const int idx = std::abs(out.index);
  const int a_idx = std::abs(a.index);
  CovGridCache& cgc = cov_grid_cache();
  // A step depends on its first node alone, never on which sets stepped before it on this thread or what the step
  // before it left (SPEC 9): the parts of node a's rates the stages hold fixed (third body, drag, SRP, the zonal tail)
  // are evaluated from node a itself at the start of every step: here the epoch's (EpochAux), below a later node's.
  if (is_ap_ctx(ctx) && !ctx.is_cov_sigma && a_idx == 0) {
    double f_epoch[6];
    rates(ctx, 0.0, a.yu, f_epoch);
  }
  if (is_ap_ctx(ctx) && !ctx.is_cov_sigma &&
      (cgc.anchor_id != ctx.ctx_id || cgc.d50_epoch != ctx.d50_epoch || std::fabs(cgc.n0 - ctx.n0) > 1e-9 ||
       (a_idx == 0 && (cgc.epoch_f0 != a.f[0] || cgc.epoch_bterm != ctx.bterm || cgc.epoch_agom != ctx.agom ||
                       cgc.epoch_rad_y0 != ctx.rad_y0)))) {
    if (++cgc.gen == 0) cgc.gen = 1;
    cgc.anchor_id = ctx.ctx_id;
    cgc.d50_epoch = ctx.d50_epoch;
    cgc.n0 = ctx.n0;
    if (a_idx == 0) {
      cgc.epoch_f0 = a.f[0];
      cgc.epoch_bterm = ctx.bterm;
      cgc.epoch_agom = ctx.agom;
      cgc.epoch_rad_y0 = ctx.rad_y0;
    }
    const EpochAux& ea = epoch_aux();
    const bool same_ep = ea.valid && ea.ctx_id == ctx.ctx_id;
    cgc.has_epoch_tb = same_ep && ea.has_tb;
    if (cgc.has_epoch_tb) {
      for (int m = 0; m < 6; ++m) cgc.epoch_tb[m] = ea.tb[m];
    }
    cgc.has_epoch_drag = same_ep && ea.has_drag;
    if (cgc.has_epoch_drag) {
      for (int m = 0; m < 6; ++m) cgc.epoch_drag_unit[m] = ea.drag_unit[m];
    }
    cgc.has_epoch_srp = same_ep && ea.has_srp;
    cgc.epoch_srp_safe = same_ep && ea.srp_sunlit_safe;
    if (cgc.has_epoch_srp) {
      for (int m = 0; m < 6; ++m) cgc.epoch_srp_unit[m] = ea.srp_unit[m];
    }
    cgc.has_epoch_tail_eq = same_ep && ea.has_tail && ea.has_tail_eq;
    if (cgc.has_epoch_tail_eq) {
      for (int m = 0; m < 6; ++m) {
        cgc.epoch_six_tail[m] = ea.six_tail[m];
        cgc.epoch_tail_eq[m] = ea.tail_eq[m];
      }
    }
  }

  // a later node: the last stage of the step that made it, evaluated again at the state it was evaluated at (yu,
  // before that step's corrections), which leaves exactly what that step left
  if (is_ap_ctx(ctx) && !ctx.is_cov_sigma && a_idx > 0 && a_idx < CovGridCache::kMaxCovSteps) {
    double f_node[6];
    rates(ctx, a.t, a.yu, f_node, di, a_idx, 2, nullptr);
  }
  Rk3StageOverride ov_stage{};
  bool any_ov = false;
  if (!ctx.is_cov_sigma && !ctx.long_period && ctx.resonance == 0 && std::fabs(h) <= 300.0 && ctx.ap_third_body) {
    if (a_idx == 0 && cgc.has_epoch_tb) {
      ov_stage.tb = cgc.epoch_tb;
      any_ov = true;
    } else if (a_idx > 0 && a_idx < CovGridCache::kMaxCovSteps &&
               cgc.steps[di][a_idx].st[2].gen == cgc.gen && cgc.steps[di][a_idx].st[2].has_tb) {
      ov_stage.tb = cgc.steps[di][a_idx].st[2].tb;
      any_ov = true;
    }
  }

  const double* six_tail_a = nullptr;
  double srp_a[6]{};
  const double* srp_a_unit = nullptr;
  if (!ctx.is_cov_sigma && ctx.long_period && ctx.ap_third_body && ctx.i0 > 0.02 && std::fabs(h) <= 45.0) {
    if (a_idx == 0 && cgc.has_epoch_tail_eq) {
      ov_stage.tail_eq = cgc.epoch_tail_eq;
      six_tail_a = cgc.epoch_six_tail;
      any_ov = true;
      if (ctx.agom > 0.0 && cgc.has_epoch_srp && cgc.epoch_srp_safe) {
        srp_a_unit = cgc.epoch_srp_unit;
      }
    } else if (a_idx > 0 && a_idx < CovGridCache::kMaxCovSteps &&
               cgc.steps[di][a_idx].st[2].gen == cgc.gen &&
               cgc.steps[di][a_idx].st[2].has_tail && cgc.steps[di][a_idx].st[2].has_tail_eq) {
      ov_stage.tail_eq = cgc.steps[di][a_idx].st[2].tail_eq;
      six_tail_a = cgc.steps[di][a_idx].st[2].six_tail;
      any_ov = true;
      if (ctx.agom > 0.0 && cgc.steps[di][a_idx].st[2].has_srp && cgc.steps[di][a_idx].st[2].srp_sunlit_safe) {
        srp_a_unit = cgc.steps[di][a_idx].st[2].srp_unit;
      }
    }
    if (srp_a_unit != nullptr) {
      for (int m = 0; m < 6; ++m) srp_a[m] = srp_a_unit[m] * ctx.agom;
      ov_stage.srp = srp_a;
    }
  }

  const double* drag_a_unit = nullptr;
  bool drag_linear_1stage = false;
  double drag_u0[6]{}, drag_u38[6]{}, drag_s0[6]{}, drag_s1[6]{};
  double dca_s0 = 1.0, inv_dca_s0 = 1.0, dca_s1 = 1.0, inv_dca_1 = 1.0;
  if (!ctx.is_cov_sigma && !ctx.long_period && !ctx.drag_pass && ctx.bterm > 0.0 && ctx.ap_third_body &&
      ctx.atmosphere != nullptr && ctx.atmosphere->model == atm::kNrlmsise00 && std::fabs(h) <= 250.0) {
    const double d50_a = ctx.d50_epoch + a.t * (1.0 / kMinutesPerDay);
    const double d50_b = ctx.d50_epoch + (a.t + h) * (1.0 / kMinutesPerDay);
    if (static_cast<int32_t>(std::floor(d50_a + 33281.0)) == static_cast<int32_t>(std::floor(d50_b + 33281.0))) {
      if (a_idx == 0 && cgc.has_epoch_drag) {
        drag_a_unit = cgc.epoch_drag_unit;
      } else if (a_idx > 0 && a_idx < CovGridCache::kMaxCovSteps &&
                 cgc.steps[di][a_idx].st[2].gen == cgc.gen && cgc.steps[di][a_idx].st[2].has_drag) {
        drag_a_unit = cgc.steps[di][a_idx].st[2].drag_unit;
      }
      if (drag_a_unit != nullptr) {
        const double dn_drag = std::fabs(drag_a_unit[kN] * ctx.bterm);
        const double e2_a = a.y[kAf] * a.y[kAf] + a.y[kAg] * a.y[kAg];
        const bool allow_1stage = (dn_drag < 5.0e-15);
        const bool allow_2stage = (dn_drag < 7.0e-12) && (std::fabs(h) <= 120.0 || e2_a >= 1.0e-6);
        if (!allow_1stage && !allow_2stage) {
          drag_a_unit = nullptr;
        } else {
          double inv_dca_0 = 1.0;
          if (!ctx.atmosphere->dca_d50.empty()) {
            inv_dca_0 = 1.0 / atm::dca_scale(*ctx.atmosphere, d50_a);
            dca_s0 = atm::dca_scale(*ctx.atmosphere, ctx.d50_epoch + (a.t + (3.0 / 8.0) * h) * (1.0 / kMinutesPerDay));
            inv_dca_s0 = 1.0 / dca_s0;
            dca_s1 = atm::dca_scale(*ctx.atmosphere, ctx.d50_epoch + (a.t + (25.0 / 32.0) * h) * (1.0 / kMinutesPerDay));
            inv_dca_1 = 1.0 / atm::dca_scale(*ctx.atmosphere, d50_b);
          }
          drag_linear_1stage = allow_1stage;
          const double b_inv_dca0 = ctx.bterm * inv_dca_0;
          for (int m = 0; m < 6; ++m) {
            drag_u0[m] = drag_a_unit[m] * b_inv_dca0;
            if (drag_linear_1stage) {
              drag_s0[m] = drag_u0[m] * dca_s0;
              drag_s1[m] = drag_u0[m] * dca_s1;
            }
          }
          if (drag_linear_1stage) {
            ov_stage.drag = drag_s0;
          } else {
            ov_stage.drag_out = drag_s0;
          }
          any_ov = true;
        }
      }
    }
  }

  const Rk3StageOverride* ov_ptr = any_ov ? &ov_stage : nullptr;
  double y2[6], y4[6], k2[6], k4[6];
  for (int j = 0; j < 6; ++j) y2[j] = a.y[j] + (3.0 / 8.0) * h * a.f[j];
  if (!rates(ctx, a.t + (3.0 / 8.0) * h, y2, k2, di, idx, 0, ov_ptr)) return kStageFailed;
  // k3 (SPEC 9): its rates do not enter the update, but its state is tested like the others
  double y3[6];
  for (int j = 0; j < 6; ++j) y3[j] = a.y[j] + (9.0 / 16.0) * h * k2[j];
  if (state_test(ctx, y3) != 0) return kStageFailed;
  if (drag_a_unit != nullptr) {
    ov_stage.drag_out = nullptr;
    if (!drag_linear_1stage) {
      for (int m = 0; m < 6; ++m) {
        drag_u38[m] = drag_s0[m] * inv_dca_s0;
        const double u_pred = drag_u0[m] + (25.0 / 12.0) * (drag_u38[m] - drag_u0[m]);
        drag_s1[m] = u_pred * dca_s1;
      }
    }
    ov_stage.drag = drag_s1;
  }
  for (int j = 0; j < 6; ++j) y4[j] = a.y[j] + h * (-(125.0 / 672.0) * a.f[j] + (325.0 / 336.0) * k2[j]);
  if (!rates(ctx, a.t + (25.0 / 32.0) * h, y4, k4, di, idx, 1, ov_ptr)) return kStageFailed;
  for (int j = 0; j < 6; ++j)
    out.y[j] = a.y[j] + h * ((37.0 / 225.0) * a.f[j] + (44.0 / 117.0) * k2[j] + (448.0 / 975.0) * k4[j]);
  out.t = a.t + h;
  for (int j = 0; j < 6; ++j) out.yu[j] = out.y[j];
  if (any_ov) {
    double tb_out[6]{}, drag_out[6]{}, tail_eq_out[6]{}, six_tail_out[6]{}, srp_out[6]{};
    Rk3StageOverride ov_end{};
    if (ov_stage.tb != nullptr) ov_end.tb_out = tb_out;
    if (ov_stage.drag != nullptr) ov_end.drag_out = drag_out;
    if (ov_stage.tail_eq != nullptr) {
      ov_end.tail_eq_out = tail_eq_out;
      ov_end.six_tail_out = six_tail_out;
    }
    if (ov_stage.srp != nullptr) ov_end.srp_out = srp_out;
    if (!rates(ctx, out.t, out.y, out.f, di, idx, 2, &ov_end)) return kNodeFailed;
    const bool in_cache = idx > 0 && idx < CovGridCache::kMaxCovSteps;
    if (ov_stage.tb != nullptr) {
      for (int j = 0; j < 6; ++j) {
        const double dtb = tb_out[j] - ov_stage.tb[j];
        out.y[j] += (1873.0 / 3744.0) * h * dtb;
        if (in_cache) {
          cgc.steps[di][idx].st[0].tb[j] = ov_stage.tb[j] + (3.0 / 8.0) * dtb;
          cgc.steps[di][idx].st[1].tb[j] = ov_stage.tb[j] + (25.0 / 32.0) * dtb;
        }
      }
      out.y[kLam] += (1.0 / 6.0) * h * h * (tb_out[kN] - ov_stage.tb[kN]);
      out.f[kLam] += (1873.0 / 3744.0) * h * (tb_out[kN] - ov_stage.tb[kN]);
    }
    if (drag_a_unit != nullptr) {
      const double inv_b = 1.0 / ctx.bterm;
      if (drag_linear_1stage) {
        const double w_du = (11.0 / 78.0) * dca_s0 + (28.0 / 78.0) * dca_s1;
        const double du_n = drag_out[kN] * inv_dca_1 - drag_u0[kN];
        for (int j = 0; j < 6; ++j) {
          const double du = drag_out[j] * inv_dca_1 - drag_u0[j];
          out.y[j] += w_du * h * du;
          if (in_cache) {
            cgc.steps[di][idx].st[0].drag_unit[j] = (drag_u0[j] + (3.0 / 8.0) * du) * (dca_s0 * inv_b);
            cgc.steps[di][idx].st[1].drag_unit[j] = (drag_u0[j] + (25.0 / 32.0) * du) * (dca_s1 * inv_b);
          }
        }
        if (in_cache) {
          cgc.steps[di][idx].st[0].has_drag = true;
          cgc.steps[di][idx].st[1].has_drag = true;
        }
        out.y[kLam] += (1.0 / 6.0) * dca_s0 * h * h * du_n;
        out.f[kLam] += w_du * h * du_n;
      } else {
        double dd1_n = 0.0;
        for (int j = 0; j < 6; ++j) {
          const double u1 = drag_out[j] * inv_dca_1;
          const double u_quad = (-91.0 / 384.0) * drag_u0[j] + (280.0 / 384.0) * drag_u38[j] + (195.0 / 384.0) * u1;
          const double d_quad = u_quad * dca_s1;
          const double dd1 = d_quad - drag_s1[j];
          out.y[j] += (448.0 / 975.0) * h * dd1;
          if (j == kN) dd1_n = dd1;
          if (in_cache) {
            cgc.steps[di][idx].st[1].drag_unit[j] = d_quad * inv_b;
          }
        }
        if (in_cache) {
          cgc.steps[di][idx].st[1].has_drag = true;
        }
        out.f[kLam] += (448.0 / 975.0) * h * dd1_n;
      }
    }
    double d_extra[6]{};
    bool has_extra = false;
    if (ov_stage.tail_eq != nullptr) {
      has_extra = true;
      for (int j = 0; j < 6; ++j) {
        const double dteq = tail_eq_out[j] - ov_stage.tail_eq[j];
        d_extra[j] += dteq;
        if (in_cache) {
          cgc.steps[di][idx].st[0].tail_eq[j] = ov_stage.tail_eq[j] + (3.0 / 8.0) * dteq;
          cgc.steps[di][idx].st[1].tail_eq[j] = ov_stage.tail_eq[j] + (25.0 / 32.0) * dteq;
        }
        if (in_cache && six_tail_a != nullptr) {
          const double dst = six_tail_out[j] - six_tail_a[j];
          cgc.steps[di][idx].st[0].six_tail[j] = six_tail_a[j] + (3.0 / 8.0) * dst;
          cgc.steps[di][idx].st[1].six_tail[j] = six_tail_a[j] + (25.0 / 32.0) * dst;
        }
      }
      if (in_cache) {
        cgc.steps[di][idx].st[0].has_tail_eq = true;
        cgc.steps[di][idx].st[1].has_tail_eq = true;
      }
      if (in_cache && six_tail_a != nullptr) {
        cgc.steps[di][idx].st[0].has_tail = true;
        cgc.steps[di][idx].st[1].has_tail = true;
      }
    }
    if (ov_stage.srp != nullptr) {
      has_extra = true;
      const double inv_agom = 1.0 / ctx.agom;
      for (int j = 0; j < 6; ++j) {
        const double dsrp = srp_out[j] - srp_a[j];
        d_extra[j] += dsrp;
        if (in_cache) {
          const double dsu = dsrp * inv_agom;
          cgc.steps[di][idx].st[0].srp_unit[j] = srp_a_unit[j] + (3.0 / 8.0) * dsu;
          cgc.steps[di][idx].st[1].srp_unit[j] = srp_a_unit[j] + (25.0 / 32.0) * dsu;
        }
      }
      if (in_cache) {
        cgc.steps[di][idx].st[0].has_srp = true;
        cgc.steps[di][idx].st[1].has_srp = true;
      }
    }
    if (has_extra) {
      for (int j = 0; j < 6; ++j) out.y[j] += 0.5 * h * d_extra[j];
      out.y[kLam] += (1.0 / 6.0) * h * h * d_extra[kN];
      out.f[kLam] += 0.5 * h * d_extra[kN];
    }
    return 0;
  }
  return rates(ctx, out.t, out.y, out.f, di, idx, 2, nullptr) ? 0 : kNodeFailed;
}

/// The node after `a` in direction dir (+1, -1), with the SPEC 9 fallbacks.
// AP's epoch one-day class needs a finer grid for the lunar-solar rates, and above e0 0.3 a step that resolves the perigee
// pass, where the long-period regime's third-body acceleration changes fastest (Branch::lp_step). Keep the XP grid bit-exact;
// the cache span uses the same selected step.
inline double long_period_step(const RateContext& ctx) { return ctx.branch.lp_step; }

/// The averaged regime's grid step (SPEC 9): two revolutions; AP's half-day class (SPEC 16.10) at most a 32nd of the
/// period of its resonant angle lambda - 2 theta, 2 pi / |n - 2 omega_E|, which near the commensurability leaves the
/// two revolutions and away from it (a GTO at 2.40 rev/day: 2.5 days) resolves the class terms.
inline double averaged_step(const RateContext& ctx, double n) {
  const double two_revolutions = 2.0 * kTwoPi / n;
  if (!(ctx.ap_frame && ctx.resonance == 2)) return two_revolutions;
  const double slip = std::fabs(n - 2.0 * kOmegaE);
  return slip > 0.0 ? std::fmin(two_revolutions, kTwoPi / slip / 32.0) : two_revolutions;
}

// --- SPEC 16.13: the radiation term Y0 (AP) ---------------------------------------

/// SPEC 16.13: the block Y0's averaged rates are applied in, minutes, and the quadrature's panels: 3-point Gauss-Legendre,
/// graded by kY0Grade from the Sun's elevation above the orbit plane (not below kY0MinScale) out to a quarter
/// revolution; no grading from kY0NoGrade up (rad).
constexpr double kY0BlockMinutes = 360.0;
constexpr double kY0MinScale = 0.01, kY0Grade = 4.0, kY0NoGrade = 0.5;
constexpr double kGl3X[3] = {-0.774596669241483377036, 0.0, 0.774596669241483377036};
constexpr double kGl3W[3] = {5.0 / 9.0, 8.0 / 9.0, 5.0 / 9.0};

/// SPEC 16.13: the sunlit arc of the mean orbit y (eccentric anomalies E1 .. E2 from the perigee; false: wholly sunlit) as
/// the sphere's rates decide it for an AP set (rates, srp_rates): AP's shadow (SPEC 16.15), for every AP set.
inline bool y0_sunlit_arc(const RateContext& /*ctx*/, const double* y, const Frame& fr, Vec3 su, double& E1, double& E2) {
  const Kepler kp = kepler_of(y, fr.a);
  const AngleTrig ag = angle_trig(kp);
  double A, B, C, sE1, cE1, sE2, cE2;
  direction_cosines(perifocal_of(ag), su, A, B, C);
  return ap_sunlit_arc(A, B, kp.e, fr.eta, (1.0 - fr.e2) * kp.a, E1, E2, sE1, cE1, sE2, cE2);
}

/// SPEC 16.13: the Gauss rates (state order, lambda's without n) of a unit acceleration (ER/min^2) along ECOM2's Y axis,
/// eY = unit(eD x r) with eD the Sun's direction (Arnold et al. 2015, eq. 1; propagator/ffm lib/gnss_srp.h), averaged
/// over the mean anomaly of the mean orbit y on the arc the sphere's rates count as sunlit (y0_sunlit_arc, SPEC 4).
/// With s the Sun's unit vector on the radial, transverse and normal axes (cd, sd, sw), eY = (sw t - sd w) / N,
/// N = |s x r_hat| = sqrt(1 - cd^2) (with S the Sun's position, eD x r = (S - r) x r / |S - r| = S x r / |S - r|: eY is
/// unit(s x r) exactly, no parallax): the integrand turns within an angle
/// of the Sun's elevation above the orbit plane where the satellite passes the Sun's direction and its opposite, so the
/// panels are graded about those two points.
inline void y0_unit_rates(const RateContext& ctx, const double* y, const Frame& fr, Vec3 su, double* u) {
  for (int j = 0; j < 6; ++j) u[j] = 0.0;
  const double k = y[kAf], h = y[kAg], chi = y[kChi], psi = y[kPsi];
  const double eta = fr.eta;
  const double sf = dot(su, fr.f), sg = dot(su, fr.g), sw = dot(su, fr.w);
  double E1 = 0.0, E2 = 0.0;
  const bool arc = y0_sunlit_arc(ctx, y, fr, su, E1, E2);
  const double beta = 1.0 / (1.0 + eta);
  const double c_xx = 1.0 - h * h * beta, c_xy = h * k * beta, c_yy = 1.0 - k * k * beta;
  // the eccentric longitude of a true longitude (its cosine and sine)
  auto ecc_longitude = [&](double cL, double sL) {
    const double roa = eta * eta / (1.0 + k * cL + h * sL);
    const double X = roa * cL + k, Y = roa * sL + h;
    return std::atan2(c_xx * Y - c_xy * X, c_yy * X - c_xy * Y);
  };
  const double cb = std::sqrt(sf * sf + sg * sg);  // cosine of the Sun's elevation above the orbit plane
  double centers[2] = {0.0, kPi};
  if (cb > 1e-9) {
    centers[0] = ecc_longitude(sf / cb, sg / cb);
    centers[1] = ecc_longitude(-sf / cb, -sg / cb);
  }
  double F1, F2;
  if (arc) {
    const double varpi = std::atan2(h, k);  // the perigee's longitude (0 for a circular orbit, as kepler_of)
    F1 = E1 + varpi;
    F2 = E2 + varpi;
  } else {
    F1 = centers[0] - kPi;
    F2 = centers[0] + kPi;
  }
  // the panels' ends: the arc's, and about each of the two points the quarter revolution and the graded offsets
  double pts[80];
  int np = 0;
  pts[np++] = F1;
  pts[np++] = F2;
  const double scale = std::fmax(std::atan2(std::fabs(sw), cb), kY0MinScale);
  for (const double c0 : centers) {
    const double c = c0 + kTwoPi * std::ceil((F1 - c0) / kTwoPi);  // in [F1, F1 + 2 pi); its neighbors reach into the arc too
    for (int shift = -1; shift <= 1; ++shift) {
      const double cs = c + kTwoPi * shift;
      auto add = [&](double p) {
        if (p > F1 && p < F2 && np < 80) pts[np++] = p;
      };
      add(cs);
      add(cs - 0.5 * kPi);
      add(cs + 0.5 * kPi);
      if (scale < kY0NoGrade)
        for (double off = scale; off < 0.5 * kPi; off *= kY0Grade) {
          add(cs - off);
          add(cs + off);
        }
    }
  }
  for (int i = 1; i < np; ++i) {  // few points: insertion sort
    const double p = pts[i];
    int j = i - 1;
    for (; j >= 0 && pts[j] > p; --j) pts[j + 1] = pts[j];
    pts[j + 1] = p;
  }
  const double na = fr.n * fr.a, na2 = na * fr.a, hn = na2 * eta;
  const double inv_hn = 1.0 / hn, inv_mu = 1.0 / kMu;
  const double two_a2_mu = 2.0 * fr.a * fr.a * inv_mu, neg_3n_2a = -1.5 * fr.n / fr.a;
  const double inv_p = 1.0 / (fr.a * eta * eta);
  const double eta_na_1peta = eta / (na * (1.0 + eta)), c_half_inv_hn = 0.5 * fr.c * inv_hn;
  for (int q = 0; q + 1 < np; ++q) {
    const double half = 0.5 * (pts[q + 1] - pts[q]), mid = 0.5 * (pts[q + 1] + pts[q]);
    if (!(half > 0.5e-9)) continue;  // two ends that coincide
    for (int g = 0; g < 3; ++g) {
      double sF, cF;
      fm::sincos(mid + half * kGl3X[g], sF, cF);
      const double roa = 1.0 - k * cF - h * sF;
      const double X = fr.a * (c_xx * cF + c_xy * sF - k), Y = fr.a * (c_xy * cF + c_yy * sF - h);
      const double rn = fr.a * roa, inv_rn = 1.0 / rn;
      const double xu = X * inv_rn, yu = Y * inv_rn;
      const double v_scale = na2 * inv_rn;
      const double Xd = v_scale * (c_xy * cF - c_xx * sF), Yd = v_scale * (c_yy * cF - c_xy * sF);
      // the Sun on the radial and transverse axes; eY's transverse and normal components (it has no radial one)
      const double cd = xu * sf + yu * sg, sd = xu * sg - yu * sf;
      const double inv_N = 1.0 / std::sqrt(std::fmax(1.0 - cd * cd, 1e-24));
      const double S = sw * inv_N, W = -sd * inv_N;
      const double df = -S * yu, dg = S * xu;
      // Gauss's equations (tail_samples), the radial component zero
      const double vd = Xd * df + Yd * dg;
      const double rv = X * Xd + Y * Yd;
      const double edot_f = inv_mu * (2.0 * vd * X - rv * df);
      const double edot_g = inv_mu * (2.0 * vd * Y - rv * dg);
      const double omega_rot = (chi * X - psi * Y) * W * inv_hn;
      const double es = h * xu - k * yu;
      const double w = kGl3W[g] * half * roa * (1.0 / kTwoPi);  // d lambda = (r / a) dF, over one revolution
      u[kAf] += w * (edot_f + h * omega_rot);
      u[kAg] += w * (edot_g - k * omega_rot);
      u[kChi] += w * (c_half_inv_hn * W * Y);
      u[kPsi] += w * (c_half_inv_hn * W * X);
      u[kLam] += w * (-eta_na_1peta * (1.0 + rn * inv_p) * es * S - omega_rot);
      u[kN] += w * (neg_3n_2a * two_a2_mu * vd);
    }
  }
}

/// SPEC 16.13: Y0's part of a step from node `a` to `out`. Its averaged rates change over days (with the Sun's direction
/// from the orbit plane), so they are not put through the rate function: each block of kY0BlockMinutes (the first, at
/// the epoch, half of one) acts at its center c, through one quadrature at the state there (the cubic between the two
/// nodes) with the Sun there, added to the node the step arrives at: every element by its rate times the block, lambda
/// also by the block's change of n over the time from c to the node. A step that passes no center adds nothing; the
/// mean elements are off by at most half a block's worth of the rates between centers (0.2 m at 1e-9 m/s^2). A pure
/// function of the two nodes: the same grid whatever the order of requests.
inline void y0_blocks(const RateContext& ctx, const Node& a, Node& out) {
  const double dir = out.t >= a.t ? 1.0 : -1.0;
  const double ta = dir * a.t, tb = dir * out.t;  // forward in the direction of the step
  const Node b0 = out;
  const double acc = ctx.rad_y0 * 3600.0 / (1000.0 * kRe);  // m/s^2 in ER/min^2
  double add[6] = {0, 0, 0, 0, 0, 0};
  auto block = [&](double c, double length) {
    if (!(c > ta && c <= tb)) return;
    const double tc = dir * c;
    double yc[6], unit[6];
    hermite(a, b0, tc, yc);
    const Vec3 su = bodies_at_ap(ctx.d50_epoch + tc / kMinutesPerDay).sun_u;  // AP only (rad_y0 is AP's)
    y0_unit_rates(ctx, yc, frame_of(yc), su, unit);
    const double scale = dir * length * acc;
    for (int j = 0; j < 6; ++j) add[j] += scale * unit[j];
    add[kLam] += scale * unit[kN] * (out.t - tc);
  };
  block(0.25 * kY0BlockMinutes, 0.5 * kY0BlockMinutes);
  for (double j = std::floor(ta / kY0BlockMinutes) + 1.0; j * kY0BlockMinutes <= tb; j += 1.0) block(j * kY0BlockMinutes, kY0BlockMinutes);
  for (int j = 0; j < 6; ++j) out.y[j] += add[j];
  out.f[kLam] += add[kN];  // lambda's rate carries n
}

inline bool next_node(const RateContext& ctx, const Node& a, int dir, Node& out) {
  double h;
  if (ctx.long_period)
    h = long_period_step(ctx);
  else
    h = averaged_step(ctx, a.y[kN]);
  out.index = a.index + dir;
  // a failed stage retries the step once at 90 minutes; a node whose own rates fail, or a step that still fails, ends
  // the grid: every time after the last good node is refused (SPEC 8.4, 9). 9.9 has no further fallback
  int st = rk3(ctx, a, dir * h, out);
  if (st == kStageFailed && h > 90.0) {
    h = 90.0;
    st = rk3(ctx, a, dir * h, out);
  }
  if (st != 0) return false;
  if (ctx.rad_y0 != 0.0) y0_blocks(ctx, a, out);  // SPEC 16.13
  return true;
}

// --- SPEC 8: osculating output ------------------------------------------------

/// Osculating Kepler solves (stack #550; SPEC 16.21) of every caller (output states, covariance sigma points, fit evaluations,
/// the long-period regime's output Jacobian), read and reset by sdnap_kepler_unconverged:
/// [0] AP's (output_impl) whose Newton ended its 30 steps with a last step of 1e-12 or more (far from the root), which then
///     take the bisection;
/// [1] section 8's (output_j2_osc) that ended so, which then take the bisection;
/// [2] AP's whose Newton ended its 30 steps within 1e-12 of the root (the tolerance meeting rounding), solved, their sine and
///     cosine taken from that E.
inline uint32_t g_kepler_unconverged[3] = {0, 0, 0};

[[gnu::noinline]] inline int32_t output_j2_osc(const double* y, double Ewarm, double r_out[3], double v_out[3]) {
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
  bool met = false;
  double last = 0.0;
  for (int it = 0; it < 30; ++it) {
    double sEi, cEi;
    fm::sincos(E, sEi, cEi);
    const double dE = (E - e * sEi - k.m) / (1.0 - e * cEi);
    E -= dE;
    last = dE;
    if (std::fabs(dE) < 1e-15) {
      met = true;
      break;
    }
  }
  if (!met && std::fabs(last) >= 1e-12) {
    // stack #550, SPEC 16.21: Newton ended its 30 steps with its last step 1e-12 or more (for the milliseconds of a perigee passage in which
    // the warm start's anomaly and k.m lie either side of 0 it starts a turn from k.m and, unless its step 2 pi / (1 - e cos E)
    // is a whole number of turns, never converges): counted, and E taken by bisection on [k.m - e, k.m + e], where
    // E - e sin E - k.m, increasing, changes sign. Every solve that converges is 0.6.37's bit for bit (one that converges a
    // turn from k.m has the same sine and cosine), and an ending within rounding of the root stands, its sine and cosine
    // taken below.
    __atomic_fetch_add(&g_kepler_unconverged[1], 1u, __ATOMIC_RELAXED);
    double lo = k.m - e, hi = k.m + e;
    for (int b = 0; b < 128 && hi - lo > 1e-15 * (1.0 + std::fabs(k.m)); ++b) {
      const double mid = 0.5 * (lo + hi);
      if (mid - e * std::sin(mid) - k.m < 0.0) lo = mid;
      else hi = mid;
    }
    E = 0.5 * (lo + hi);
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
  // a mean perigee below the surface: SGP4XP serves the state as the library does (SPEC 8.4: the 150 km perigee set is
  // served to its first node with the native elements there already refused)
  return kPropOk;
}

[[gnu::noinline]] inline int32_t output_xp(const RateContext& ctx, double t, const double* ym, double r_out[3], double v_out[3],
                                           const Bodies* shared, double* d_srp_unit_out = nullptr,
                                           const double* d_srp_unit_in = nullptr) {
  if (!(ym[kN] > 0.0)) return kPropMeanMotion;
  double y[6] = {ym[0], ym[1], ym[2], ym[3], ym[4], ym[5]};
  if (d_srp_unit_out != nullptr) {
    for (int j = 0; j < 6; ++j) d_srp_unit_out[j] = 0.0;
  }
  const bool use_shared_srp = (d_srp_unit_in != nullptr);
  if (use_shared_srp && ctx.agom > 0.0) {
    for (int j = 0; j < 6; ++j) y[j] += d_srp_unit_in[j] * ctx.agom;
  }
  double Ewarm = std::numeric_limits<double>::quiet_NaN();
  const bool need_first = !ctx.long_period || (ctx.agom > 0.0 && !use_shared_srp && radiation_periodic(ctx));
  if (need_first) {
    const Kepler km = kepler_of(ym);
    if ((!ctx.long_period || ctx.agom > 0.0) && !(km.e < 1.0)) return kPropEccentricity;
    const double etam = km.e < 1.0 ? std::sqrt(1.0 - km.e * km.e) : 0.0;
    const AngleTrig agm = km.e < 1.0 ? angle_trig(km) : AngleTrig{};
    double sEm = 0.0, cEm = 1.0;
    double Em = km.m + km.e * std::sin(km.m);
    for (int it = 0; it < 30; ++it) {
      fm::sincos(Em, sEm, cEm);
      const double dE = (Em - km.e * sEm - km.m) / (1.0 - km.e * cEm);
      Em -= dE;
      if (std::fabs(dE) < 1e-15) break;
    }
    const double n = ym[kN];
    Perifocal pfm{};
    bool have_pfm = false;
    Vec3 sun_u{};
    double sun_r = 0.0;
    bool have_sun = false;
    if (!ctx.long_period) {
      const Bodies b = shared != nullptr ? *shared : bodies_at(ctx.d50_epoch + t / kMinutesPerDay);
      pfm = perifocal_of(agm);
      have_pfm = true;
      sun_u = b.sun_u;
      sun_r = b.sun_r;
      have_sun = true;
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
    // SPEC 4's first-order periodic radiation terms, except where radiation goes through the output map (16.22)
    if (ctx.agom > 0.0 && !use_shared_srp && radiation_periodic(ctx)) {
      if (!have_pfm) pfm = perifocal_of(agm);
      if (!have_sun) {
        if (shared != nullptr) {
          sun_u = shared->sun_u;
          sun_r = shared->sun_r;
        } else {
          sun_at(ctx.d50_epoch + t / kMinutesPerDay, sun_u, sun_r);
        }
      }
      double A, B, C;
      direction_cosines(pfm, sun_u, A, B, C);
      const double rs_au = sun_r * kRe / kAu;
      const double Fs = kSrpPressure * ctx.agom * 3600.0 / (1000.0 * kRe * rs_au * rs_au);
      double ds[6];
      srp_output(km.e, etam, Em, km.argp, km.node, km.i, km.a, n, A, B, C, Fs, ds);
      for (int j = 0; j < 6; ++j) y[j] += ds[j];
      if (d_srp_unit_out != nullptr) {
        const double inv_agom = 1.0 / ctx.agom;
        for (int j = 0; j < 6; ++j) d_srp_unit_out[j] = ds[j] * inv_agom;
      }
    }
    if (!(y[kN] > 0.0)) return kPropMeanMotion;
    Ewarm = Em;
  } else {
    if ((!ctx.long_period || ctx.agom > 0.0) && !(ym[kAf] * ym[kAf] + ym[kAg] * ym[kAg] < 1.0))
      return kPropEccentricity;
    if (use_shared_srp && !(y[kN] > 0.0)) return kPropMeanMotion;
  }
  return output_j2_osc(y, Ewarm, r_out, v_out);
}

/// The two passages' drag rates and widths of a state (drag_passes) from its segment's polynomial (drag_pass_rates) for
/// output_drag_pass, set by xp_propagate_impl around the output of that state (of set ctx_id at t); otherwise
/// output_drag_pass evaluates them at the state.
struct DragPassRates {
  uint64_t ctx_id;
  double t;
  double v[kDragPassValues];
};
inline thread_local const DragPassRates* g_drag_pass_rates = nullptr;

[[gnu::noinline]] inline void output_drag_pass(const RateContext& ctx, double t, const double* ym,
                                               const Bodies* shared, double* y) {
  const Frame frm = frame_of(ym);
  const Kepler km = kepler_of(ym, frm.a);
  double v[kDragPassValues];
  const DragPassRates* held = g_drag_pass_rates;
  if (held != nullptr && held->ctx_id == ctx.ctx_id && held->t == t) {
    for (int j = 0; j < kDragPassValues; ++j) v[j] = held->v[j];
  } else {
    const Bodies b = shared != nullptr ? *shared : bodies_at_ap(ctx.d50_epoch + t / kMinutesPerDay);  // AP only
    drag_passes(ctx, t, ym, frm, km, angle_trig(km), b, v);
  }
  // SPEC 16.12's drag steps. The osculating elements change by each pass's whole effect, 2 pi p / n, over the pass,
  // the cumulative of a normal distribution in M of the pass's width; the mean elements ramp by the two passes' mean.
  // Their difference over the revolution, M in [0, 2 pi) from the pass p to the pass q:
  //   (pi p - (p + q) M / 2 + pi (q erfc(V) - p erfc(U))) / n, U = M / (sqrt2 s_p), V = (2 pi - M) / (sqrt2 s_q),
  // zero at either perigee and continuous with its slope from one revolution to the next; lambda adds n's own difference
  // integrated over time, (2 pi / n^2)(p_n (M/2 - pi/6) + (q_n - p_n) M/6 - (p_n + q_n) M^2/(8 pi)
  // + (p_n s_p ierfc(U) + q_n s_q ierfc(V)) / sqrt2), ierfc(x) = exp(-x^2)/sqrt(pi) - x erfc(x), continuous likewise.
  // With p = q and no width these are 0.6.9's sawtooth (pi - M) p / n and (p_n / n^2)(pi M - M^2/2 - pi^2/3).
  // A width is held below pi/4, where the step has settled (erfc 5.6) before the next perigee.
  const double* p = v;
  const double* q = v + 6;
  constexpr double kSqrt2 = 1.4142135623730951, kInvSqrtPi = 0.56418958354775628;
  const double sp = std::fmin(std::fmax(v[12], 1e-9), 0.25 * kPi), sq = std::fmin(std::fmax(v[13], 1e-9), 0.25 * kPi);
  const double M = km.m, n = ym[kN];
  const double U = M / (kSqrt2 * sp), V = (kTwoPi - M) / (kSqrt2 * sq);
  double eU = 0.0, eV = 0.0, iU = 0.0, iV = 0.0;
  if (U < 6.0) {
    eU = std::erfc(U);
    iU = std::exp(-U * U) * kInvSqrtPi - U * eU;
  }
  if (V < 6.0) {
    eV = std::erfc(V);
    iV = std::exp(-V * V) * kInvSqrtPi - V * eV;
  }
  for (int j = 0; j < 6; ++j) y[j] += (kPi * p[j] - 0.5 * (p[j] + q[j]) * M + kPi * (q[j] * eV - p[j] * eU)) / n;
  y[kLam] += kTwoPi / (n * n) *
             (p[kN] * (0.5 * M - kPi / 6.0) + (q[kN] - p[kN]) * M / 6.0 - (p[kN] + q[kN]) * M * M / (8.0 * kPi) +
              (p[kN] * sp * iU + q[kN] * sq * iV) / kSqrt2);
}

struct CovNomOsc {
  double a0 = 0.0;
  double n0 = 0.0;
  double inv_n0 = 0.0;
  double lam0 = 0.0;
  double dF0 = 0.0;
  double sF0 = 0.0;
  double cF0 = 1.0;
  double tv0 = 0.0;
  double phi_v0 = 0.0;
  bool valid = false;
};

/// TEME position (km) and velocity (km/s) of the mean equinoctial state y.
/// `shared`, when given, holds the Sun and Moon at the output time (a batch at
/// one time evaluates them once for every object).
template <bool kCov>
inline int32_t output_impl(const RateContext& ctx, double t, const double* ym, double r_out[3], double v_out[3],
                           const Bodies* shared, double* d_3b_out = nullptr, double* dd_3b_dlam_out = nullptr,
                           double* d_sp_out = nullptr, double* dd_sp_dlam_out = nullptr,
                           const double* d_3b_in = nullptr, const double* dd_3b_dlam_in = nullptr,
                           const double* d_sp_in = nullptr, const double* dd_sp_dlam_in = nullptr, double dlam = 0.0,
                           double* d2_sp_dlam2_out = nullptr, const double* d2_sp_dlam2_in = nullptr,
                           double* d_srp_unit_out = nullptr, const double* d_srp_unit_in = nullptr,
                           double* E_osc_out = nullptr, double* sE_osc_out = nullptr, double* cE_osc_out = nullptr,
                           double E_osc_in = std::numeric_limits<double>::quiet_NaN(),
                           double sE_osc_in = 0.0, double cE_osc_in = 1.0,
                           double* lam_ref_out = nullptr, double* sLam_ref_out = nullptr, double* cLam_ref_out = nullptr,
                           double lam_ref_in = std::numeric_limits<double>::quiet_NaN(),
                           double sLam_ref_in = 0.0, double cLam_ref_in = 1.0,
                           CovNomOsc* nom_osc_out = nullptr) {
  if (__builtin_expect(!ctx.ap_third_body, 0)) {
    if constexpr (kCov) {
      return output_xp(ctx, t, ym, r_out, v_out, shared, d_srp_unit_out, d_srp_unit_in);
    } else {
      return output_xp(ctx, t, ym, r_out, v_out, shared);
    }
  }
  if (!(ym[kN] > 0.0)) return kPropMeanMotion;
  double y[6] = {ym[0], ym[1], ym[2], ym[3], ym[4], ym[5]};
  bool use_shared_3b = false;
  bool use_shared_sp = false;
  bool use_shared_srp = false;
  if constexpr (kCov) {
    if (d_3b_out != nullptr && dd_3b_dlam_out != nullptr) {
      for (int j = 0; j < 6; ++j) d_3b_out[j] = dd_3b_dlam_out[j] = 0.0;
    }
    if (d_sp_out != nullptr && dd_sp_dlam_out != nullptr) {
      for (int j = 0; j < 6; ++j) d_sp_out[j] = dd_sp_dlam_out[j] = 0.0;
      if (d2_sp_dlam2_out != nullptr) {
        for (int j = 0; j < 6; ++j) d2_sp_dlam2_out[j] = 0.0;
      }
    }
    if (d_srp_unit_out != nullptr) {
      for (int j = 0; j < 6; ++j) d_srp_unit_out[j] = 0.0;
    }
    use_shared_3b = (d_3b_in != nullptr && dd_3b_dlam_in != nullptr);
    use_shared_sp = (d_sp_in != nullptr && dd_sp_dlam_in != nullptr);
    use_shared_srp = (d_srp_unit_in != nullptr);
    if (use_shared_3b) {
      for (int j = 0; j < 6; ++j) y[j] += d_3b_in[j] + dd_3b_dlam_in[j] * dlam;
    }
    if (use_shared_sp) {
      if (d2_sp_dlam2_in != nullptr) {
        for (int j = 0; j < 6; ++j) y[j] += d_sp_in[j] + (dd_sp_dlam_in[j] + 0.5 * d2_sp_dlam2_in[j] * dlam) * dlam;
      } else {
        for (int j = 0; j < 6; ++j) y[j] += d_sp_in[j] + dd_sp_dlam_in[j] * dlam;
      }
    }
    if (use_shared_srp && ctx.agom > 0.0) {
      for (int j = 0; j < 6; ++j) y[j] += d_srp_unit_in[j] * ctx.agom;
    }
  }
  double Ewarm = kCov ? E_osc_in : std::numeric_limits<double>::quiet_NaN();
  double sEwarm = kCov ? sE_osc_in : 0.0, cEwarm = kCov ? cE_osc_in : 1.0;
  const bool fast_ang = (t != 0.0) || !ctx.long_period || ctx.i0 > 0.02;
  const bool has_sp_orig =
      (ctx.sp_comb != nullptr) && (ctx.sp_comb_count > 0) && (ctx.sp == ctx.sp_orig) && (ctx.sp_count == ctx.sp_orig_count);
  const bool has_sp_custom =
      (ctx.sp != ctx.sp_orig || ctx.sp_count != ctx.sp_orig_count) && (ctx.sp != nullptr) && (ctx.sp_count > 0);
  const bool has_sp_any = has_sp_orig || has_sp_custom;
  const bool need_first = (!ctx.long_period && !use_shared_3b) || (ctx.agom > 0.0 && !use_shared_srp && radiation_periodic(ctx));
  const bool need_tess = !use_shared_sp && (ctx.mdaily != nullptr || has_sp_any || ctx.wide != nullptr);
  Kepler km{};
  double etam = 0.0;
  AngleTrig agm{};
  bool have_lam_m = false, have_m0 = false, have_th_pre = false, have_cv_m = false;
  double sLam_m = 0.0, cLam_m = 1.0, sm0_m = 0.0, cm0_m = 1.0, cv_m = 1.0, sv_m = 0.0, inv_opc_m = 0.0;
  double sth_pre = 0.0, cth_pre = 1.0;
  if (need_first || need_tess) {
    const double e2m = ym[kAf] * ym[kAf] + ym[kAg] * ym[kAg];
    const double t2m = ym[kChi] * ym[kChi] + ym[kPsi] * ym[kPsi];
    if ((!ctx.long_period || ctx.agom > 0.0) && !(e2m < 1.0)) return kPropEccentricity;
    if (__builtin_expect(e2m > 1e-24 && t2m > 1e-24 && e2m < 1.0, 1)) {
      km.a = fast_a_from_n(ym[kN]);
#ifdef __wasm_simd128__
      const v128_t vsqm = wasm_f64x2_sqrt(wasm_f64x2_make(e2m, 1.0 - e2m));
      km.e = wasm_f64x2_extract_lane(vsqm, 0);
      etam = wasm_f64x2_extract_lane(vsqm, 1);
      const double t_inc = std::sqrt(t2m);
      const v128_t vinvm = wasm_f64x2_div(wasm_f64x2_splat(1.0), wasm_f64x2_make(1.0 + t2m, t_inc));
      const double inv_1pt2 = wasm_f64x2_extract_lane(vinvm, 0);
      const double inv_t = wasm_f64x2_extract_lane(vinvm, 1);
#else
      km.e = std::sqrt(e2m);
      etam = std::sqrt(1.0 - e2m);
      const double t_inc = std::sqrt(t2m);
      const double inv_1pt2 = 1.0 / (1.0 + t2m);
      const double inv_t = 1.0 / t_inc;
#endif
      agm.ci = (1.0 - t2m) * inv_1pt2;
      agm.si = 2.0 * t_inc * inv_1pt2;
      agm.sO = ym[kChi] * inv_t;
      agm.cO = ym[kPsi] * inv_t;
      const double inv_em = 1.0 / km.e;
      cv_m = ym[kAf] * inv_em;
      sv_m = ym[kAg] * inv_em;
      inv_opc_m = 0.5 * (1.0 + t2m);
      have_cv_m = true;
      agm.cw = cv_m * agm.cO + sv_m * agm.sO;
      agm.sw = sv_m * agm.cO - cv_m * agm.sO;
      if (fast_ang && t != 0.0 && ctx.wide == nullptr && km.e <= 0.08 && !has_sp_custom) {
#ifdef __wasm_simd128__
        if (need_tess) {
          fm::sincos2_f64x2(ym[kLam], ctx.theta_g0 + kOmegaE * t, sLam_m, cLam_m, sth_pre, cth_pre);
          have_th_pre = true;
        } else {
          fm::sincos_fast(ym[kLam], sLam_m, cLam_m);
        }
#else
        fm::sincos_fast(ym[kLam], sLam_m, cLam_m);
#endif
        have_lam_m = true;
        sm0_m = sLam_m * cv_m - cLam_m * sv_m;
        cm0_m = cLam_m * cv_m + sLam_m * sv_m;
        have_m0 = true;
        if constexpr (kCov) {
          if (lam_ref_out != nullptr) {
            *lam_ref_out = ym[kLam];
            *sLam_ref_out = sLam_m;
            *cLam_ref_out = cLam_m;
          }
        }
      } else {
        const double varpi = fast_ang ? fm::atan2(ym[kAg], ym[kAf]) : std::atan2(ym[kAg], ym[kAf]);
        const double node_raw = fast_ang ? fm::atan2(ym[kChi], ym[kPsi]) : std::atan2(ym[kChi], ym[kPsi]);
        km.node = fast_wrap(node_raw);
        km.argp = fast_wrap(varpi - node_raw);
        km.m = fast_wrap(ym[kLam] - varpi);
        if (ctx.wide != nullptr) km.i = 2.0 * (fast_ang ? fm::atan(t_inc) : std::atan(t_inc));
      }
    } else {
      km = kepler_of(ym, fast_a_from_n(ym[kN]));
      if (km.e < 1.0) {
        etam = std::sqrt(1.0 - km.e * km.e);
        agm = angle_trig(km);
      }
    }
  } else if (!ctx.long_period || ctx.agom > 0.0) {
    if (!(ym[kAf] * ym[kAf] + ym[kAg] * ym[kAg] < 1.0)) return kPropEccentricity;
  }
  if (need_first) {
    double sEm = 0.0, cEm = 1.0;
    double Em = 0.0;
    bool have_F_trig = false;
    double sF_m = 0.0, cF_m = 1.0;
    if (have_m0) {
      const double inv_ome0 = 1.0 / (1.0 - km.e * cm0_m);
      const double r1 = (km.e * sm0_m) * inv_ome0;
      const double rc = (km.e * cm0_m) * inv_ome0;
      const double r1_2 = r1 * r1;
      const double u0 = r1 * (1.0 - r1_2 * (0.5 + (1.0 / 6.0) * rc - (13.0 / 24.0) * r1_2));
      const double u2 = u0 * u0;
      const double cu0 = 1.0 - u2 * (0.5 - u2 * ((1.0 / 24.0) - u2 * (1.0 / 720.0)));
      const double su0 = u0 * (1.0 - u2 * ((1.0 / 6.0) - u2 * ((1.0 / 120.0) - u2 * (1.0 / 5040.0))));
      sEm = sm0_m * cu0 + cm0_m * su0;
      cEm = cm0_m * cu0 - sm0_m * su0;
      if (km.e > 0.012) {
        const double du = (u0 - km.e * sEm) / (1.0 - km.e * cEm);
        const double h2 = 0.5 * du * du, s_prev = sEm;
        sEm = s_prev * (1.0 - h2) - cEm * du;
        cEm = cEm * (1.0 - h2) + s_prev * du;
      }
    } else if (fast_ang && ctx.wide == nullptr && km.e <= (ctx.long_period ? 0.008 : 0.018)) {
      double sm0, cm0;
      fm::sincos_fast(km.m, sm0, cm0);
      const double inv_ome0 = 1.0 / (1.0 - km.e * cm0);
      const double r1 = (km.e * sm0) * inv_ome0;
      const double rc = (km.e * cm0) * inv_ome0;
      const double r1_2 = r1 * r1;
      const double u = r1 * (1.0 - r1_2 * (0.5 + (1.0 / 6.0) * rc - (13.0 / 24.0) * r1_2));
      Em = km.m + u;
      const double u2 = u * u;
      const double cu = 1.0 - 0.5 * u2 * (1.0 - (1.0 / 12.0) * u2);
      const double su = u * (1.0 - (1.0 / 6.0) * u2 * (1.0 - 0.05 * u2));
      sEm = sm0 * cu + cm0 * su;
      cEm = cm0 * cu - sm0 * su;
    } else if (fast_ang) {
      double sm0, cm0;
      fm::sincos_fast(km.m, sm0, cm0);
      Em = km.m + km.e * sm0 * (1.0 + km.e * (cm0 + 0.5 * km.e * (3.0 * cm0 * cm0 - 1.0)));
      double last_dE = 1.0;
      for (int it = 0; it < 30; ++it) {
        fm::sincos_fast(Em, sEm, cEm);
        const double dE = (Em - km.e * sEm - km.m) / (1.0 - km.e * cEm);
        Em -= dE;
        last_dE = dE;
        if (std::fabs(dE) < 5e-6 && km.e * dE * dE < (1.0 - km.e) * 1e-15) {
          const double h2 = 0.5 * dE * dE, s0 = sEm;
          sEm = s0 * (1.0 - h2) - cEm * dE;
          cEm = cEm * (1.0 - h2) + s0 * dE;
          last_dE = 0.0;
          break;
        }
      }
      if (std::fabs(last_dE) >= 1e-8) fm::sincos_fast(Em, sEm, cEm);
    } else {
      Em = km.m + km.e * std::sin(km.m);
      double last_dE = 1.0;
      for (int it = 0; it < 30; ++it) {
        fm::sincos(Em, sEm, cEm);
        const double dE = (Em - km.e * sEm - km.m) / (1.0 - km.e * cEm);
        Em -= dE;
        last_dE = dE;
        if (std::fabs(dE) < 1e-15) {
          const double s0 = sEm;
          sEm = s0 - cEm * dE;
          cEm = cEm + s0 * dE;
          break;
        }
      }
      if (std::fabs(last_dE) >= 1e-8) fm::sincos(Em, sEm, cEm);
    }
    if (have_cv_m) {
      sF_m = sEm * cv_m + cEm * sv_m;
      cF_m = cEm * cv_m - sEm * sv_m;
      have_F_trig = true;
    }
    const double n = ym[kN];
    if (!ctx.long_period && !use_shared_3b) {
      double d[6] = {0, 0, 0, 0, 0, 0};
      third_body_short_period(ym, shared, have_F_trig ? 0.0 : (Em + km.argp + km.node), 2, kThirdBodyTailDegree, d,
                              kCov ? dd_3b_dlam_out : nullptr,
                              ctx.d50_epoch, t, have_F_trig ? &sF_m : nullptr, have_F_trig ? &cF_m : nullptr,
                              ctx.ctx_id);
      for (int j = 0; j < 6; ++j) y[j] += d[j];
      if constexpr (kCov) {
        if (d_3b_out != nullptr) {
          for (int j = 0; j < 6; ++j) d_3b_out[j] += d[j];
        }
      }
    }
    // SPEC 4's first-order periodic radiation terms, except where radiation goes through the output map (16.22)
    if (ctx.agom > 0.0 && !use_shared_srp && radiation_periodic(ctx)) {
      const Perifocal pfm = perifocal_of(agm);
      Vec3 sun_u{};
      double sun_r = 0.0;
      if (shared != nullptr) {
        sun_u = shared->sun_u;
        sun_r = shared->sun_r;
      } else {
        const ActiveBracket& ab = active_bracket();
        if (__builtin_expect(t != 0.0 && ab.valid && ab.has_t1 && ab.ctx_id == ctx.ctx_id &&
                                 ab.d50_epoch == ctx.d50_epoch &&
                                 t >= ab.sub_t_lo && t <= ab.sub_t_hi,
                             1)) {
          const double u_ab = (t - ab.t0) * ab.inv_dt;
          sun_u = ab.sun_u0 + u_ab * ab.dsun_u;
          sun_r = ab.sun_r0 + u_ab * ab.dsun_r;
        } else {
          const Bodies b = bodies_at_ap(ctx.d50_epoch + t / kMinutesPerDay);
          sun_u = b.sun_u;
          sun_r = b.sun_r;
        }
      }
      double A, B, C;
      direction_cosines(pfm, sun_u, A, B, C);
      const double rs_au = sun_r * kRe / kAu;
      const double Fs = kSrpPressure * ctx.agom * 3600.0 / (1000.0 * kRe * rs_au * rs_au);
      double ds[6];
      srp_output_ap(km.e, etam, sEm, cEm, agm.sw, agm.cw, agm.sO, agm.cO, agm.si, agm.ci, km.a, n, A, B, C, Fs, ds);
      for (int j = 0; j < 6; ++j) y[j] += ds[j];
      if constexpr (kCov) {
        if (d_srp_unit_out != nullptr) {
          const double inv_agom = 1.0 / ctx.agom;
          for (int j = 0; j < 6; ++j) d_srp_unit_out[j] = ds[j] * inv_agom;
        }
      }
    }
    if (!(y[kN] > 0.0)) return kPropMeanMotion;
    if (!have_m0) {
      Ewarm = Em;
      sEwarm = sEm;
      cEwarm = cEm;
    }
  } else if constexpr (kCov) {
    if ((use_shared_3b || use_shared_sp || use_shared_srp) && !(y[kN] > 0.0)) {
      return kPropMeanMotion;
    }
  }
  if (need_tess && km.e < 1.0) {
    float* const cm_f32_buf = tess::sp_trig_cm();
    float* const sm_f32_buf = tess::sp_trig_sm();
    int cm_cnt = 0;
    double cm_last = 1.0, sm_last = 0.0;
    const bool has_md = ctx.mdaily != nullptr;
    const bool has_sp = has_sp_orig;
    double sb_pre = 0.0, cb_pre = 1.0, su1_pre = 0.0, cu1_pre = 1.0, sM1_pre = sm0_m, cM1_pre = cm0_m;
    if (__builtin_expect(have_m0, 1)) {
      double sth = sth_pre, cth = cth_pre;
      if (!have_th_pre) fm::sincos_fast(ctx.theta_g0 + kOmegaE * t, sth, cth);
      sb_pre = agm.sO * cth - agm.cO * sth;
      cb_pre = agm.cO * cth + agm.sO * sth;
      su1_pre = agm.sw * cm0_m + agm.cw * sm0_m;
      cu1_pre = agm.cw * cm0_m - agm.sw * sm0_m;
    } else {
      fm::sincos_fast(km.node - (ctx.theta_g0 + kOmegaE * t), sb_pre, cb_pre);
      if (has_sp) fm::sincos2_f64x2(km.argp + km.m, km.m, su1_pre, cu1_pre, sM1_pre, cM1_pre);
    }
    const uint64_t mdt_id = md_table_id(ctx);
    if constexpr (kCov) {
      if (d_sp_out != nullptr && dd_sp_dlam_out != nullptr) {
        double six_sp[6] = {0, 0, 0, 0, 0, 0}, dsix_sp[6] = {0, 0, 0, 0, 0, 0}, d2six_sp[6] = {0, 0, 0, 0, 0, 0};
        double sb_t = sb_pre, cb_t = cb_pre;
        if (has_md) {
          tess::mdaily_six(ctx.mdaily, ctx.mdaily_degree, t, km, ym[kN], etam, agm.si, agm.ci, ctx.theta_g0, six_sp, &sb_t, &cb_t,
                           has_sp ? cm_f32_buf : nullptr, has_sp ? sm_f32_buf : nullptr,
                           has_sp ? &cm_cnt : nullptr, has_sp ? &cm_last : nullptr, has_sp ? &sm_last : nullptr,
                           &sb_pre, &cb_pre, mdt_id);
        }
        if (has_sp) {
          tess::sp_six_with_deriv(ctx.sp_comb, ctx.sp_comb_count, ctx.a0, ctx.e0, t, km, ym[kN], etam, agm.si, agm.ci, ctx.sp_ci0, ctx.theta_g0,
                                  six_sp, dsix_sp, d2_sp_dlam2_out != nullptr ? d2six_sp : nullptr,
                                  &sb_t, &cb_t,
                                  has_md ? cm_f32_buf : nullptr, has_md ? sm_f32_buf : nullptr, cm_cnt, cm_last, sm_last,
                                  &su1_pre, &cu1_pre, &sM1_pre, &cM1_pre);
        } else if (has_sp_custom) {
          tess::sp_six(ctx.sp, ctx.sp_count, t, km, ym[kN], etam, agm.si, agm.ci, ctx.theta_g0, six_sp);
        }
        if (ctx.wide != nullptr) {
          if (ctx.wide_next != nullptr && ctx.wide_blend > 0.0) {
            tess::wide_six(*ctx.wide, t, km, ctx.theta_g0, six_sp, Ewarm, dsix_sp, 1.0 - ctx.wide_blend, ctx.wide_a);
            tess::wide_six(*ctx.wide_next, t, km, ctx.theta_g0, six_sp, Ewarm, dsix_sp, 1.0 - (1.0 - ctx.wide_blend), ctx.wide_a);
          } else {
            tess::wide_six(*ctx.wide, t, km, ctx.theta_g0, six_sp, Ewarm, dsix_sp, 1.0, ctx.wide_a);
          }
        }
        auto conv_six = [&](const double* sx, double* eq) {
          if (__builtin_expect(have_cv_m, 1)) {
            eq[kAf] = sx[1] * cv_m - sx[3] * sv_m;
            eq[kAg] = sx[1] * sv_m + sx[3] * cv_m;
            eq[kChi] = (sx[2] * agm.sO + sx[4] * agm.cO) * inv_opc_m;
            eq[kPsi] = (sx[2] * agm.cO - sx[4] * agm.sO) * inv_opc_m;
            eq[kLam] = sx[5];
            eq[kN] = sx[0];
          } else {
            six_to_equinoctial(agm, sx, eq);
          }
        };
        double d_sp[6], dd_sp[6];
        conv_six(six_sp, d_sp);
        conv_six(dsix_sp, dd_sp);
        for (int j = 0; j < 6; ++j) {
          y[j] += d_sp[j];
          d_sp_out[j] += d_sp[j];
          dd_sp_dlam_out[j] += dd_sp[j];
        }
        if (d2_sp_dlam2_out != nullptr) {
          double d2d_sp[6];
          conv_six(d2six_sp, d2d_sp);
          for (int j = 0; j < 6; ++j) d2_sp_dlam2_out[j] += d2d_sp[j];
        }
      } else {
        double six[6] = {0, 0, 0, 0, 0, 0};
        double sb_t = sb_pre, cb_t = cb_pre;
        if (has_md)
          tess::mdaily_six(ctx.mdaily, ctx.mdaily_degree, t, km, ym[kN], etam, agm.si, agm.ci,
                           ctx.theta_g0, six, &sb_t, &cb_t,
                           has_sp ? cm_f32_buf : nullptr, has_sp ? sm_f32_buf : nullptr,
                           has_sp ? &cm_cnt : nullptr, has_sp ? &cm_last : nullptr, has_sp ? &sm_last : nullptr,
                           &sb_pre, &cb_pre, mdt_id);
        if (has_sp)
          tess::sp_six_val(ctx.sp_comb, ctx.sp_comb_count, ctx.a0, ctx.e0, t, km.a, km.e, ym[kN], etam, agm.si, agm.ci, ctx.sp_ci0, six,
                           sb_t, cb_t, su1_pre, cu1_pre, sM1_pre, cM1_pre, cm_cnt, cm_last, sm_last, has_md);
        else if (has_sp_custom)
          tess::sp_six(ctx.sp, ctx.sp_count, t, km, ym[kN], etam, agm.si, agm.ci, ctx.theta_g0, six);
        if (ctx.wide != nullptr) {
          if (ctx.wide_next != nullptr && ctx.wide_blend > 0.0) {
            tess::wide_six(*ctx.wide, t, km, ctx.theta_g0, six, Ewarm, nullptr, 1.0 - ctx.wide_blend, ctx.wide_a);
            tess::wide_six(*ctx.wide_next, t, km, ctx.theta_g0, six, Ewarm, nullptr, ctx.wide_blend, ctx.wide_a);
          } else {
            tess::wide_six(*ctx.wide, t, km, ctx.theta_g0, six, Ewarm, nullptr, 1.0, ctx.wide_a);
          }
        }
        if (__builtin_expect(have_cv_m, 1)) {
          y[kAf] += six[1] * cv_m - six[3] * sv_m;
          y[kAg] += six[1] * sv_m + six[3] * cv_m;
          y[kChi] += (six[2] * agm.sO + six[4] * agm.cO) * inv_opc_m;
          y[kPsi] += (six[2] * agm.cO - six[4] * agm.sO) * inv_opc_m;
          y[kLam] += six[5];
          y[kN] += six[0];
        } else {
          double d[6];
          six_to_equinoctial(agm, six, d);
          for (int j = 0; j < 6; ++j) y[j] += d[j];
        }
      }
    } else {
      double six[6] = {0, 0, 0, 0, 0, 0};
      double sb_t = sb_pre, cb_t = cb_pre;
      if (has_md)
        tess::mdaily_six(ctx.mdaily, ctx.mdaily_degree, t, km, ym[kN], etam, agm.si, agm.ci,
                         ctx.theta_g0, six, &sb_t, &cb_t,
                         has_sp ? cm_f32_buf : nullptr, has_sp ? sm_f32_buf : nullptr,
                         has_sp ? &cm_cnt : nullptr, has_sp ? &cm_last : nullptr, has_sp ? &sm_last : nullptr,
                         &sb_pre, &cb_pre, mdt_id);
      if (has_sp)
        tess::sp_six_val(ctx.sp_comb, ctx.sp_comb_count, ctx.a0, ctx.e0, t, km.a, km.e, ym[kN], etam, agm.si, agm.ci, ctx.sp_ci0, six,
                         sb_t, cb_t, su1_pre, cu1_pre, sM1_pre, cM1_pre, cm_cnt, cm_last, sm_last, has_md);
      else if (has_sp_custom)
        tess::sp_six(ctx.sp, ctx.sp_count, t, km, ym[kN], etam, agm.si, agm.ci, ctx.theta_g0, six);
      if (ctx.wide != nullptr) {
        if (ctx.wide_next != nullptr && ctx.wide_blend > 0.0) {
          tess::wide_six(*ctx.wide, t, km, ctx.theta_g0, six, Ewarm, nullptr, 1.0 - ctx.wide_blend, ctx.wide_a);
          tess::wide_six(*ctx.wide_next, t, km, ctx.theta_g0, six, Ewarm, nullptr, ctx.wide_blend, ctx.wide_a);
        } else {
          tess::wide_six(*ctx.wide, t, km, ctx.theta_g0, six, Ewarm, nullptr, 1.0, ctx.wide_a);
        }
      }
      if (__builtin_expect(have_cv_m, 1)) {
        y[kAf] += six[1] * cv_m - six[3] * sv_m;
        y[kAg] += six[1] * sv_m + six[3] * cv_m;
        y[kChi] += (six[2] * agm.sO + six[4] * agm.cO) * inv_opc_m;
        y[kPsi] += (six[2] * agm.cO - six[4] * agm.sO) * inv_opc_m;
        y[kLam] += six[5];
        y[kN] += six[0];
      } else {
        double d[6];
        six_to_equinoctial(agm, six, d);
        for (int j = 0; j < 6; ++j) y[j] += d[j];
      }
    }
  }
  if (__builtin_expect(ctx.drag_pass && ctx.bterm > 0.0, 0)) {
    output_drag_pass(ctx, t, ym, shared, y);
  }
  const double e2 = y[kAf] * y[kAf] + y[kAg] * y[kAg];
  const double t2 = y[kChi] * y[kChi] + y[kPsi] * y[kPsi];
  if (!(e2 < 1.0)) return kPropEccentricity;
  if (!std::isfinite(y[kLam]) || std::fabs(y[kLam]) > 1e10) return kPropEccentricity;
  if (__builtin_expect(e2 > 1e-24 && t2 > 1e-24, 1)) {
    double a;
    if (km.a > 0.0) {
      const double du_n = (y[kN] - ym[kN]) / ym[kN];
      a = std::fabs(du_n) < 2e-3
              ? km.a * (1.0 + du_n * (-(2.0 / 3.0) + du_n * ((5.0 / 9.0) + du_n * (-(40.0 / 81.0) + du_n * (110.0 / 243.0)))))
              : fast_a_from_n(y[kN]);
    } else {
      a = fast_a_from_n(y[kN]);
    }
    const double om_e2 = 1.0 - e2;
    const double p = a * om_e2;
#ifdef __wasm_simd128__
    const v128_t vsq = wasm_f64x2_sqrt(wasm_f64x2_make(e2, om_e2));
    const double e = wasm_f64x2_extract_lane(vsq, 0);
    const double eta = wasm_f64x2_extract_lane(vsq, 1);
    const double t_inc = std::sqrt(t2);
    const v128_t vinv_t = wasm_f64x2_div(wasm_f64x2_splat(1.0), wasm_f64x2_make(1.0 + t2, t_inc));
    const v128_t vinv_ee = wasm_f64x2_div(wasm_f64x2_splat(1.0), vsq);
    const v128_t vinv_ep = wasm_f64x2_div(wasm_f64x2_splat(1.0), wasm_f64x2_make(1.0 + eta, p));
    const double inv_1pt2 = wasm_f64x2_extract_lane(vinv_t, 0);
    const double inv_t = wasm_f64x2_extract_lane(vinv_t, 1);
    const double inv_e = wasm_f64x2_extract_lane(vinv_ee, 0);
    const double inv_eta = wasm_f64x2_extract_lane(vinv_ee, 1);
    const double inv_1peta = wasm_f64x2_extract_lane(vinv_ep, 0);
    const double inv_p = wasm_f64x2_extract_lane(vinv_ep, 1);
#else
    const double e = std::sqrt(e2);
    const double eta = std::sqrt(om_e2);
    const double t_inc = std::sqrt(t2);
    const double inv_1pt2 = 1.0 / (1.0 + t2);
    const double inv_t = 1.0 / t_inc;
    const double inv_e = 1.0 / e;
    const double inv_eta = 1.0 / eta;
    const double inv_1peta = 1.0 / (1.0 + eta);
    const double inv_p = 1.0 / p;
#endif
    const double th = (1.0 - t2) * inv_1pt2;
    const double si = 2.0 * t_inc * inv_1pt2;
    const double sO = y[kChi] * inv_t, cO = y[kPsi] * inv_t;
    const double cv = y[kAf] * inv_e, sv = y[kAg] * inv_e;
    const double cw = cv * cO + sv * sO, sw = sv * cO - cv * sO;
    double E = 0.0, sE = 0.0, cE = 1.0;
    double dF_osc = 0.0;
    if (fast_ang && t != 0.0 && e <= 0.08) {
      double sLam, cLam;
      const double lref = kCov ? (have_lam_m ? ym[kLam] : lam_ref_in) : (have_lam_m ? ym[kLam] : std::numeric_limits<double>::quiet_NaN());
      if (lref == lref && std::fabs(y[kLam] - lref) < 0.02) {
        const double slref = kCov ? (have_lam_m ? sLam_m : sLam_ref_in) : sLam_m;
        const double clref = kCov ? (have_lam_m ? cLam_m : cLam_ref_in) : cLam_m;
        const double dl = y[kLam] - lref;
        const double dl2 = dl * dl;
        const double cdl = 1.0 - dl2 * (0.5 - dl2 * (1.0 / 24.0));
        const double sdl = dl * (1.0 - dl2 * ((1.0 / 6.0) - dl2 * (1.0 / 120.0)));
        sLam = slref * cdl + clref * sdl;
        cLam = clref * cdl - slref * sdl;
      } else {
        fm::sincos_fast(y[kLam], sLam, cLam);
      }
      const double sm_osc = sLam * cv - cLam * sv;
      const double cm_osc = cLam * cv + sLam * sv;
      const double inv_ome0 = 1.0 / (1.0 - e * cm_osc);
      const double r1 = (e * sm_osc) * inv_ome0;
      const double rc = (e * cm_osc) * inv_ome0;
      const double r1_2 = r1 * r1;
      const double u0 = r1 * (1.0 - r1_2 * (0.5 + (1.0 / 6.0) * rc - (13.0 / 24.0) * r1_2));
      const double u2 = u0 * u0;
      const double cu0 = 1.0 - u2 * (0.5 - u2 * ((1.0 / 24.0) - u2 * (1.0 / 720.0)));
      const double su0 = u0 * (1.0 - u2 * ((1.0 / 6.0) - u2 * ((1.0 / 120.0) - u2 * (1.0 / 5040.0))));
      sE = sm_osc * cu0 + cm_osc * su0;
      cE = cm_osc * cu0 - sm_osc * su0;
      dF_osc = u0;
      if (e > 0.008) {
        const double du = (u0 - e * sE) / (1.0 - e * cE);
        const double h2 = 0.5 * du * du, s_prev = sE;
        sE = s_prev * (1.0 - h2) - cE * du;
        cE = cE * (1.0 - h2) + s_prev * du;
        dF_osc = u0 - du;
      }
      if constexpr (kCov) {
        if (E_osc_out != nullptr) {
          *E_osc_out = std::numeric_limits<double>::quiet_NaN();
          *sE_osc_out = sE;
          *cE_osc_out = cE;
        }
      }
    } else {
      const double varpi = fast_ang ? fm::atan2(y[kAg], y[kAf]) : std::atan2(y[kAg], y[kAf]);
      const double m_ang = fast_wrap(y[kLam] - varpi);
      bool solved_kepler = false;
      if (fast_ang && Ewarm == Ewarm) {
        double dm = m_ang - (Ewarm - e * sEwarm);
        dm -= kTwoPi * std::floor((dm + kPi) * (1.0 / kTwoPi));
        const double f1 = 1.0 - e * cEwarm;
        const double r1 = dm / f1;
        if (std::fabs(r1) < 0.004) {
          const double f2 = e * sEwarm;
          const double f3 = e * cEwarm;
          const double inv_f1 = 1.0 / f1;
          const double f2_o_f1 = f2 * inv_f1;
          const double u = r1 * (1.0 - 0.5 * r1 * f2_o_f1 + r1 * r1 * (0.5 * f2_o_f1 * f2_o_f1 - (1.0 / 6.0) * f3 * inv_f1));
          E = Ewarm + u;
          const double u2 = u * u;
          const double cu = 1.0 - 0.5 * u2 * (1.0 - (1.0 / 12.0) * u2);
          const double su = u * (1.0 - (1.0 / 6.0) * u2 * (1.0 - 0.05 * u2));
          sE = sEwarm * cu + cEwarm * su;
          cE = cEwarm * cu - sEwarm * su;
          solved_kepler = true;
        }
      }
      if (!solved_kepler && fast_ang && e <= (ctx.long_period ? 0.008 : 0.018)) {
        double sm0, cm0;
        fm::sincos_fast(m_ang, sm0, cm0);
        const double inv_ome0 = 1.0 / (1.0 - e * cm0);
        const double r1 = (e * sm0) * inv_ome0;
        const double rc = (e * cm0) * inv_ome0;
        const double r1_2 = r1 * r1;
        const double u = r1 * (1.0 - r1_2 * (0.5 + (1.0 / 6.0) * rc - (13.0 / 24.0) * r1_2));
        E = m_ang + u;
        const double u2 = u * u;
        const double cu = 1.0 - 0.5 * u2 * (1.0 - (1.0 / 12.0) * u2);
        const double su = u * (1.0 - (1.0 / 6.0) * u2 * (1.0 - 0.05 * u2));
        sE = sm0 * cu + cm0 * su;
        cE = cm0 * cu - sm0 * su;
        solved_kepler = true;
      }
      // the mean anomaly Newton solves for: m_ang on the warm start's branch (stack #550). For a few seconds of a perigee
      // passage the mean and the osculating anomaly lie either side of 0; there m_ang is 2 pi from the start's branch, and
      // Newton, solving for it, stepped about 4 pi each iteration and left E off by up to 3e-3 rad after its 30.
      double m_t = m_ang;
      if (!solved_kepler) {
        if (Ewarm == Ewarm) {
          double dm = m_ang - (Ewarm - e * sEwarm);
          dm -= kTwoPi * std::floor((dm + kPi) * (1.0 / kTwoPi));
          m_t = m_ang + kTwoPi * std::round(((Ewarm - e * sEwarm) - m_ang) * (1.0 / kTwoPi));
          E = fast_ang ? (Ewarm + dm / (1.0 - e * cEwarm)) : (Ewarm + dm);
        } else if (fast_ang) {
          double sm0, cm0;
          fm::sincos_fast(m_ang, sm0, cm0);
          E = m_ang + e * sm0 * (1.0 + e * (cm0 + 0.5 * e * (3.0 * cm0 * cm0 - 1.0)));
        } else {
          E = m_ang + e * std::sin(m_ang);
        }
        double last_dE = 1.0;
        for (int it = 0; it < 30; ++it) {
          double sEi, cEi;
          if (fast_ang) fm::sincos_fast(E, sEi, cEi);
          else fm::sincos(E, sEi, cEi);
          const double dE = (E - e * sEi - m_t) / (1.0 - e * cEi);
          E -= dE;
          last_dE = dE;
          if (fast_ang ? (std::fabs(dE) < 5e-6 && e * dE * dE < (1.0 - e) * 1e-15) : (std::fabs(dE) < 1e-15)) {
            const double h2 = 0.5 * dE * dE;
            sE = sEi * (1.0 - h2) - cEi * dE;
            cE = cEi * (1.0 - h2) + sEi * dE;
            last_dE = 0.0;
            break;
          }
        }
        if (last_dE != 0.0 && std::fabs(last_dE) < 1e-12) {
          // Newton ended its 30 steps within rounding of the root (stack #550: the 1e-15 tolerance of the non-fast path can
          // cycle between neighboring doubles of E; through 0.6.36 the sine and cosine were then left at 0 and 1, a perigee
          // state): solved, its sine and cosine taken from E, counted apart
          __atomic_fetch_add(&g_kepler_unconverged[2], 1u, __ATOMIC_RELAXED);
          if (fast_ang) fm::sincos_fast(E, sE, cE);
          else fm::sincos(E, sE, cE);
        } else if (last_dE != 0.0) {
          // Newton ended its 30 steps far from the root (through 0.6.36 E was then taken as it stood): counted, and E taken by
          // bisection on [m_t - e, m_t + e], where E - e sin E - m_t, increasing, changes sign
          __atomic_fetch_add(&g_kepler_unconverged[0], 1u, __ATOMIC_RELAXED);
          double lo = m_t - e, hi = m_t + e;
          for (int b = 0; b < 128 && hi - lo > 1e-15 * (1.0 + std::fabs(m_t)); ++b) {
            const double mid = 0.5 * (lo + hi);
            if (mid - e * std::sin(mid) - m_t < 0.0) lo = mid;
            else hi = mid;
          }
          E = 0.5 * (lo + hi);
          fm::sincos(E, sE, cE);
        }
      }
      dF_osc = fast_wrap(E - m_ang);
      if constexpr (kCov) {
        if (E_osc_out != nullptr) {
          *E_osc_out = E;
          *sE_osc_out = sE;
          *cE_osc_out = cE;
        }
      }
    }
    const double ome = 1.0 - e * cE;
#ifdef __wasm_simd128__
    const v128_t vinv_ome = wasm_f64x2_div(wasm_f64x2_splat(1.0), wasm_f64x2_make(ome, ome + eta));
    const double inv_ome = wasm_f64x2_extract_lane(vinv_ome, 0);
    const double tv = (e * sE) * wasm_f64x2_extract_lane(vinv_ome, 1);
#else
    const double inv_ome = 1.0 / ome;
    const double tv = (e * sE) / (ome + eta);
#endif
    const double snu = eta * sE * inv_ome, cnu = (cE - e) * inv_ome;
    const double r = a * ome;
    const double th2 = th * th;
    const double c = 0.25 * kJ2 * inv_p, d = c * inv_p;
    const double beta = e * inv_1peta;
    double phi_v = 0.0;
    if (std::fabs(tv) < 0.06) {
      const double tv2 = tv * tv;
      phi_v = tv * (1.0 - tv2 * ((1.0 / 3.0) - tv2 * ((1.0 / 5.0) - tv2 * (1.0 / 7.0))));
    } else {
      phi_v = fast_ang ? fm::atan(tv) : std::atan(tv);
    }
    if constexpr (kCov) {
      if (nom_osc_out != nullptr) {
        nom_osc_out->a0 = a;
        nom_osc_out->n0 = y[kN];
        nom_osc_out->inv_n0 = 1.0 / y[kN];
        nom_osc_out->lam0 = y[kLam];
        nom_osc_out->dF0 = dF_osc;
        nom_osc_out->sF0 = sE * cv + cE * sv;
        nom_osc_out->cF0 = cE * cv - sE * sv;
        nom_osc_out->tv0 = tv;
        nom_osc_out->phi_v0 = phi_v;
        nom_osc_out->valid = true;
      }
    }
    const double eoc = e * sE + 2.0 * phi_v;
    const double Qw = eoc + e * snu;
    const double n_a = y[kN];
    const double c2w = cw * cw - sw * sw, s2w = 2.0 * sw * cw;
    const double c2n = cnu * cnu - snu * snu, s2n = 2.0 * snu * cnu;
    const double c3n = c2n * cnu - s2n * snu, s3n = s2n * cnu + c2n * snu;
    const double c2u = c2w * c2n - s2w * s2n, s2u = s2w * c2n + c2w * s2n;
    const double cw1 = c2w * cnu - s2w * snu, sw1 = s2w * cnu + c2w * snu;
    const double cw3 = c2w * c3n - s2w * s3n, sw3 = s2w * c3n + c2w * s3n;
    const double dr = c * ((1.0 - th2) * c2u - (beta * cnu + 2.0 * ome * inv_eta + 1.0) * (3.0 * th2 - 1.0));
    const double di = d * th * si * (3.0 * c2u + e * (3.0 * cw1 + cw3));
    const double dnode = d * th * (3.0 * s2u - 6.0 * Qw + e * (3.0 * sw1 + sw3));
    const double du = d * ((1.0 - eta) * (3.0 * th2 - 1.0) * snu * (beta + cnu) - 3.0 * (1.0 - 5.0 * th2) * Qw +
                           0.5 * (1.0 - 7.0 * th2) * s2u +
                           e * ((2.0 - 5.0 * th2) * sw1 - th2 * sw3));
    const double aor = inv_ome;
    const double aor2 = aor * aor;
    const double rdot0 = n_a * a * e * snu * inv_eta;
    const double rfdot0 = n_a * a * eta * aor;
    const double drdot = eta * (-2.0 * c * n_a * aor2 * (1.0 - th2) * s2u +
                                c * n_a * e * snu * (3.0 * th2 - 1.0) * (aor2 * inv_1peta + inv_eta * inv_eta * inv_eta));
    const double drfdot = eta * (-n_a * aor2 * dr +
                                 n_a * (a * aor) * d * si * si * (3.0 * c2u + e * (3.0 * cw1 + cw3)));
    // SPEC 16.23: the zonal theory's constant radial term, at the same osculating energy (the transverse speed moves with it)
    const double dr2 = zonal_radius_term(a, th * th), rk0 = r + dr, rf0 = rfdot0 + drfdot;
    const double rk = rk0 + dr2, rdotk = rdot0 + drdot, rfdotk = rf0 * energy_speed_factor(rk0, dr2, rf0);
    const double cu0 = cw * cnu - sw * snu, su0 = sw * cnu + cw * snu;
    double sinsu, cossu, snod, cnod, sini, cosi;
    if (__builtin_expect(std::fabs(du) < 0.02 && std::fabs(dnode) < 0.02 && std::fabs(di) < 0.02, 1)) {
#ifdef __wasm_simd128__
      const v128_t vang = wasm_f64x2_make(du, dnode);
      const v128_t va2 = wasm_f64x2_mul(vang, vang);
      const v128_t vc = wasm_f64x2_sub(wasm_f64x2_splat(1.0),
                                       wasm_f64x2_mul(va2, wasm_f64x2_sub(wasm_f64x2_splat(0.5),
                                                                          wasm_f64x2_mul(va2, wasm_f64x2_splat(1.0 / 24.0)))));
      const v128_t vs_a = wasm_f64x2_mul(vang,
                                         wasm_f64x2_sub(wasm_f64x2_splat(1.0),
                                                        wasm_f64x2_mul(va2, wasm_f64x2_sub(wasm_f64x2_splat(1.0 / 6.0),
                                                                                           wasm_f64x2_mul(va2, wasm_f64x2_splat(1.0 / 120.0))))));
      const v128_t vc0 = wasm_f64x2_make(cu0, cO);
      const v128_t vs0 = wasm_f64x2_make(su0, sO);
      const v128_t vcos = wasm_f64x2_sub(wasm_f64x2_mul(vc0, vc), wasm_f64x2_mul(vs0, vs_a));
      const v128_t vsin = wasm_f64x2_add(wasm_f64x2_mul(vs0, vc), wasm_f64x2_mul(vc0, vs_a));
      cossu = wasm_f64x2_extract_lane(vcos, 0);
      cnod = wasm_f64x2_extract_lane(vcos, 1);
      sinsu = wasm_f64x2_extract_lane(vsin, 0);
      snod = wasm_f64x2_extract_lane(vsin, 1);
      const double di2 = di * di;
      const double cdi = 1.0 - di2 * (0.5 - di2 * (1.0 / 24.0));
      const double sdi = di * (1.0 - di2 * ((1.0 / 6.0) - di2 * (1.0 / 120.0)));
      cosi = th * cdi - si * sdi;
      sini = si * cdi + th * sdi;
#else
      const double du2 = du * du, dn2 = dnode * dnode, di2 = di * di;
      const double cdu = 1.0 - du2 * (0.5 - du2 * (1.0 / 24.0));
      const double sdu = du * (1.0 - du2 * ((1.0 / 6.0) - du2 * (1.0 / 120.0)));
      const double cdn = 1.0 - dn2 * (0.5 - dn2 * (1.0 / 24.0));
      const double sdn = dnode * (1.0 - dn2 * ((1.0 / 6.0) - dn2 * (1.0 / 120.0)));
      const double cdi = 1.0 - di2 * (0.5 - di2 * (1.0 / 24.0));
      const double sdi = di * (1.0 - di2 * ((1.0 / 6.0) - di2 * (1.0 / 120.0)));
      cossu = cu0 * cdu - su0 * sdu;
      sinsu = su0 * cdu + cu0 * sdu;
      cnod = cO * cdn - sO * sdn;
      snod = sO * cdn + cO * sdn;
      cosi = th * cdi - si * sdi;
      sini = si * cdi + th * sdi;
#endif
    } else {
      const double node_ang = fast_ang ? fm::atan2(y[kChi], y[kPsi]) : std::atan2(y[kChi], y[kPsi]);
      const double ik = 2.0 * (fast_ang ? fm::atan(t_inc) : std::atan(t_inc)) + di;
      fm::sincos((fast_ang ? fm::atan2(su0, cu0) : std::atan2(su0, cu0)) + du, sinsu, cossu);
      fm::sincos(node_ang + dnode, snod, cnod);
      fm::sincos(ik, sini, cosi);
    }
    const double rk_re = rk * kRe;
    const double vs = kRe / 60.0;
    const double rdk_vs = rdotk * vs, rfdk_vs = rfdotk * vs;
#ifdef __wasm_simd128__
    const v128_t v_csn = wasm_f64x2_make(cnod, snod);
    const v128_t v_xm = wasm_f64x2_mul(wasm_f64x2_make(-snod, cnod), wasm_f64x2_splat(cosi));
    const v128_t v_ssu = wasm_f64x2_splat(sinsu);
    const v128_t v_csu = wasm_f64x2_splat(cossu);
    const v128_t v_uxy = wasm_f64x2_add(wasm_f64x2_mul(v_xm, v_ssu), wasm_f64x2_mul(v_csn, v_csu));
    const v128_t v_vxy = wasm_f64x2_sub(wasm_f64x2_mul(v_xm, v_csu), wasm_f64x2_mul(v_csn, v_ssu));
    wasm_v128_store(r_out, wasm_f64x2_mul(v_uxy, wasm_f64x2_splat(rk_re)));
    r_out[2] = rk_re * (sini * sinsu);
    wasm_v128_store(v_out, wasm_f64x2_add(wasm_f64x2_mul(v_uxy, wasm_f64x2_splat(rdk_vs)),
                                           wasm_f64x2_mul(v_vxy, wasm_f64x2_splat(rfdk_vs))));
    v_out[2] = rdk_vs * (sini * sinsu) + rfdk_vs * (sini * cossu);
#else
    const double xmx = -snod * cosi, xmy = cnod * cosi;
    const double ux = xmx * sinsu + cnod * cossu, uy = xmy * sinsu + snod * cossu, uz = sini * sinsu;
    const double vx = xmx * cossu - cnod * sinsu, vy = xmy * cossu - snod * sinsu, vz = sini * cossu;
    r_out[0] = rk_re * ux;
    r_out[1] = rk_re * uy;
    r_out[2] = rk_re * uz;
    v_out[0] = rdk_vs * ux + rfdk_vs * vx;
    v_out[1] = rdk_vs * uy + rfdk_vs * vy;
    v_out[2] = rdk_vs * uz + rfdk_vs * vz;
#endif
    return kPropOk;
  }
  const int32_t rc = output_j2_osc(y, Ewarm, r_out, v_out);
  if (rc == kPropOk) {
    // SPEC 16.23: the constant radial term on this path too (where e^2 or tan^2(i/2) is at most 1e-24)
    const double t2f = y[kChi] * y[kChi] + y[kPsi] * y[kPsi], thf = (1.0 - t2f) / (1.0 + t2f);
    radial_shift(r_out, v_out, zonal_radius_term(fast_a_from_n(y[kN]), thf * thf) * kRe);
  }
  return rc;
}

inline int32_t output(const RateContext& ctx, double t, const double* ym, double r_out[3], double v_out[3],
                      const Bodies* shared) {
  return output_impl<false>(ctx, t, ym, r_out, v_out, shared);
}

inline int32_t output(const RateContext& ctx, double t, const double* ym, double r_out[3], double v_out[3],
                      const Bodies* shared, double* d_3b_out, double* dd_3b_dlam_out = nullptr,
                      double* d_sp_out = nullptr, double* dd_sp_dlam_out = nullptr,
                      const double* d_3b_in = nullptr, const double* dd_3b_dlam_in = nullptr,
                      const double* d_sp_in = nullptr, const double* dd_sp_dlam_in = nullptr, double dlam = 0.0,
                      double* d2_sp_dlam2_out = nullptr, const double* d2_sp_dlam2_in = nullptr,
                      double* d_srp_unit_out = nullptr, const double* d_srp_unit_in = nullptr,
                      double* E_osc_out = nullptr, double* sE_osc_out = nullptr, double* cE_osc_out = nullptr,
                      double E_osc_in = std::numeric_limits<double>::quiet_NaN(),
                      double sE_osc_in = 0.0, double cE_osc_in = 1.0,
                      double* lam_ref_out = nullptr, double* sLam_ref_out = nullptr, double* cLam_ref_out = nullptr,
                      double lam_ref_in = std::numeric_limits<double>::quiet_NaN(),
                      double sLam_ref_in = 0.0, double cLam_ref_in = 1.0,
                      CovNomOsc* nom_osc_out = nullptr) {
  return output_impl<true>(ctx, t, ym, r_out, v_out, shared, d_3b_out, dd_3b_dlam_out, d_sp_out, dd_sp_dlam_out,
                           d_3b_in, dd_3b_dlam_in, d_sp_in, dd_sp_dlam_in, dlam, d2_sp_dlam2_out, d2_sp_dlam2_in,
                           d_srp_unit_out, d_srp_unit_in, E_osc_out, sE_osc_out, cE_osc_out, E_osc_in, sE_osc_in, cE_osc_in,
                           lam_ref_out, sLam_ref_out, cLam_ref_out, lam_ref_in, sLam_ref_in, cLam_ref_in, nom_osc_out);
}

// --- Per-object record and node cache --------------------------------------------

/// Sparse checkpoints per direction and the stride between them is chosen at
/// ingest so that kSparse checkpoints span about 8 days; the window holds the
/// latest bracket of each direction. 96 + 2 * 2 * 112 + 2 * kSparse * 112 bytes.
constexpr int kSparse = 12;

/// AP above e 0.3 (SPEC 16.12): the drag rates the output of a state adds (output_drag_pass) over the last two segments
/// flown, a segment the part of one revolution (keyed by its perigee time tp) inside one bracket of the mean-element grid
/// (keyed by its lower node's time): drag_passes at kPoints times of the segment (drag_pass_rates).
struct DragPassCache {
  static constexpr int kPoints = 3;
  int32_t lock;
  int32_t next;
  int32_t held[2];
  double tp[2], node_t[2];
  double tk[2][kPoints];
  double v[2][kPoints][kDragPassValues];
};

/// What a set in a store keeps of the evaluation caches between its states (SPEC 9): the third-body tables of its
/// bracket, its m-daily terms and its tesseral terms, held from the pool within its memory budget (CachePool). A set
/// without them uses the thread's, as every set did before 0.6.18.
/// One direction's grid nodes, contiguous from the epoch (node k at position k - 1), up to the checkpoint span: a time
/// in it is a lookup, never a re-integration (run_bracket).
struct NodeRun {
  Node* nodes = nullptr;
  Node base{};          ///< the run's first node: the epoch, a checkpoint or the window's (node k of the run is nodes[k - 1])
  int32_t count = 0, cap = 0;
  int32_t hint = 0;     ///< the lower node of the last bracket (0: the base)
  bool based = false;   ///< base is set
  bool ended = false;   ///< the grid ends after the last node (a node that is not a number or does not advance)
};

/// a, e and cos i at a bracket's two nodes (set_sp_anchor) with the ten mean components they are computed from (n, af,
/// ag, chi and psi at each node): the bracket's later states read them back instead of computing them again (two pow a
/// state, stack #441). Keyed on those components bit for bit, so it gives what they give, whatever was flown before.
/// It is not the anchor: sp_anchored never reads it, and g_sp_anchor is set only by the call that brackets the time
/// (xp_propagate_impl's AnchorScope clears it on entry).
struct AnchorMemo {
  bool valid = false;
  double in[10]{};
  double a_lo = 1.0, e_lo = 0.0, c_lo = 1.0, a_hi = 1.0, e_hi = 0.0, c_hi = 1.0;
};
/// The thread's, for a set flown without its caches.
inline thread_local AnchorMemo g_anchor_memo{};

struct SetCaches {
  ActiveBracket ab;
  tess::MdailyEvalCache md;
  tess::SpSetSlot sp;
  AnchorMemo anchor;   ///< written only while the flying thread holds the set's cache_lock (SetScope)
  NodeRun run[2];      ///< forward, backward
  uint64_t stamp = 0;  ///< the pool's clock when the set was last flown
  uint64_t prev = 0;   ///< the stamp of the flight before
  uint64_t bytes = 0;  ///< what the pool counts for it (with the node runs)
};

struct XpSat {
  uint32_t norad;
  int32_t init_error;
  int32_t lock;
  int32_t stride;
  uint8_t pooled;      ///< a store's set: it may hold SetCaches (xp_set_pooled)
  int32_t cache_lock;  ///< held by the thread flying the set with its caches, or by the pool reclaiming them
  int32_t pool_index;  ///< its place in the pool's holders
  SetCaches* caches;
  uint64_t asked;      ///< the pool's clock when it last asked for caches and had none (0: never)
  RateContext ctx;
  double epoch_jd_whole, epoch_jd_frac;
  Node epoch;
  Node window[2][2];          ///< [direction][0: lower, 1: upper] latest bracket
  int32_t window_valid[2];
  int32_t sparse_count[2];    ///< checkpoints held per direction (index stride * (k + 1))
  Node sparse[2][kSparse];
  double decay_t[2];          ///< SPEC 16.25 (stack #564): an AP set's decay crossing per direction (minutes from epoch), once found
  int8_t decay_found[2];      ///< 1 once the grid's nodes in that direction reached the crossing: every later time is decayed
  int32_t wide_lock;          ///< AP above tess::kWideE: the schedule nodes' grids this set holds (SPEC 16.11)
  tess::WideGrid* wide_node[2];
  int32_t wide_node_j[2];
  DragPassCache drag_pass;
};
inline void pool_release(XpSat& s);
/// A store's AP set (the epoch store's and the row store's): it may keep its caches between states (SetCaches). An
/// SGP4XP set reads none of them and keeps none.
inline void xp_set_pooled(XpSat& s) {
  if (s.init_error == 0 && is_ap_ctx(s.ctx)) s.pooled = 1;
}

/// SPEC 16.11: the nominal set whose grids the copies initialized on this thread while a GridShareScope lives read (the covariance's
/// sigma sets); nullptr outside one.
inline thread_local XpSat* g_grid_share_anchor = nullptr;
inline XpSat*& grid_share_anchor() { return g_grid_share_anchor; }
struct GridShareScope {
  XpSat* prev;
  explicit GridShareScope(XpSat* nominal) : prev(grid_share_anchor()) { grid_share_anchor() = nominal; }
  ~GridShareScope() { grid_share_anchor() = prev; }
  GridShareScope(const GridShareScope&) = delete;
  GridShareScope& operator=(const GridShareScope&) = delete;
};

inline thread_local XpSat* g_cov_bank_anchor = nullptr;
inline XpSat*& cov_bank_anchor() { return g_cov_bank_anchor; }
struct CovBankScope {
  XpSat* prev;
  explicit CovBankScope(XpSat* nominal) : prev(cov_bank_anchor()) { cov_bank_anchor() = nominal; }
  ~CovBankScope() { cov_bank_anchor() = prev; }
  CovBankScope(const CovBankScope&) = delete;
  CovBankScope& operator=(const CovBankScope&) = delete;
};

/// SPEC 16.7: while a BranchScope lives on a thread, a set initialized there takes this branch instead of its own epoch
/// elements' (a covariance's moved set still takes its nominal's): every trial set of a fit (fit::run) flies one branch's
/// theory, so the fit's objective is smooth.
inline thread_local const Branch* g_branch_pin = nullptr;
struct BranchScope {
  const Branch* prev;
  explicit BranchScope(const Branch* b) : prev(g_branch_pin) { g_branch_pin = b; }
  ~BranchScope() { g_branch_pin = prev; }
  BranchScope(const BranchScope&) = delete;
  BranchScope& operator=(const BranchScope&) = delete;
};

/// AP: the per-object tables of what the call selected (tess::active()); nothing without a selection. False out of memory.
/// The eccentricity switches are s.ctx.branch's (xp_init), never e.eo's own.
inline bool ap_init(const Elements& e, double n0, int8_t res, XpSat& s) {
  const tess::Terms& t = s.ctx.selected_terms;
  const Branch& br = s.ctx.branch;
  s.ctx.n0 = n0;
  s.ctx.a0 = std::pow(kKe / n0, kX2o3);
  s.ctx.hd_e0 = e.eo;
  s.ctx.hd_i0 = e.xincl;
  s.ctx.hd_a0 = s.ctx.a0;
  XpSat* anchor = cov_bank_anchor();
  if (anchor == &s) anchor = nullptr;
  XpSat* grid_anchor = grid_share_anchor();
  if (grid_anchor == &s) grid_anchor = nullptr;
  s.ctx.cov_anchor_id = anchor != nullptr ? anchor->ctx.ctx_id : s.ctx.ctx_id;
  s.ctx.is_cov_sigma = anchor != nullptr ? 1 : 0;
  const bool same_res = anchor != nullptr && anchor->ctx.resonance == res && anchor->ctx.long_period == s.ctx.long_period;
  const bool within_share = same_res && std::fabs(e.eo - anchor->ctx.e0) <= tess::kShareE &&
                            std::fabs(e.xincl - anchor->ctx.i0) <= tess::kShareI &&
                            std::fabs(s.ctx.a0 / anchor->ctx.a0 - 1.0) <= tess::kShareA;
  const bool same_inc = anchor != nullptr && e.xincl == anchor->ctx.i0;
  // Every AP set carries its epoch-axis states to TEME of date (SPEC 16.4): the long-period regime's class 0 sets too, from
  // 0.6.34; through 0.6.33 that branch left the turn from TEME of the epoch to TEME of the date in its output.
  // This one ingest-time policy is shared by fit residuals and every flight.
  // The one writer of ap_frame, ap_third_body and ap_resonance (xp_init zeroes them first): the other two are set only
  // when ap_third_body is, so ap_third_body != 0 exactly when is_ap_ctx. The callers that choose AP's Sun and Moon
  // (bodies_at_ap, SPEC 16.17) by ap_third_body rely on it.
  s.ctx.ap_frame = t.tesseral > 0 || t.zonal > 0;
  s.ctx.ap_third_body = t.tesseral > 0 || t.zonal > 0;
  s.ctx.drag_pass = s.ctx.ap_third_body && br.wide_e ? 1 : 0;
  // SPEC 16.11: in the long-period regime the Sun and Moon move the mean motion along each revolution, so the grid keeps the
  // epoch's (the same expression as the grid's own a, so a set's own grid has no offset in a)
  s.ctx.wide_a = s.ctx.long_period && s.ctx.ap_third_body ? std::pow(kKe / n0, kX2o3) : 0.0;
  if (t.tesseral > 0) {
    s.ctx.ap_resonance = 1;
    if (res != 0 && br.series_e && e.eo + 1e-3 < 1.0) {
      if (within_share && anchor->ctx.res_taylor != nullptr) {
        s.ctx.res_taylor = anchor->ctx.res_taylor;
        s.ctx.e0 = anchor->ctx.e0;
        s.ctx.shared_mask |= 4;
      } else {
        const res::TermSet ts = res::class_terms(res);
        res::GTaylor* g = static_cast<res::GTaylor*>(sdnap::mem::malloc(ts.count * sizeof(res::GTaylor)));
        if (g == nullptr) return false;
        for (int j = 0; j < ts.count; ++j) g[j] = res::g_taylor(ts.t[j].l, ts.t[j].p, ts.t[j].q, e.eo);
        s.ctx.res_taylor = g;
      }
    }
  }
  const int md = (t.tesseral > tess::kMdailyCap ? tess::kMdailyCap : t.tesseral) & ~1;
  if (md >= 2) {
    if (same_inc && anchor->ctx.mdaily != nullptr && anchor->ctx.mdaily_degree == md) {
      s.ctx.mdaily = anchor->ctx.mdaily;
      s.ctx.mdaily_degree = md;
      s.ctx.shared_mask |= 32;
    } else {
      // the terms' inclination functions in double on the heap (stack #497: sized by the degree, never on the stack)
      double* scratch = static_cast<double*>(sdnap::mem::malloc(2 * static_cast<size_t>(tess::mdaily_term_count(md)) * sizeof(double)));
      if (scratch == nullptr) return false;
      const int count = tess::mdaily_terms(md, e.xincl, scratch);
      float* kept = static_cast<float*>(sdnap::mem::malloc(2 * count * sizeof(float)));
      if (kept == nullptr) {
        std::free(scratch);
        return false;
      }
      for (int q = 0; q < 2 * count; ++q) kept[q] = static_cast<float>(scratch[q]);
      std::free(scratch);
      s.ctx.mdaily = kept;
      s.ctx.mdaily_degree = md;
    }
  }
  // SPEC 16.18, the low table (stack #477): with Terms::slow the slow set's list (the shallow set's terms, then its own) is
  // built before the output table, which yields every term the list holds beyond the shallow set's
  tess::ShallowTerms* slow_list = nullptr;
  {
    const int sd0 = t.tesseral > tess::kShallowCap ? tess::kShallowCap : t.tesseral;
    if (t.slow && sd0 >= 2 && res == 0 && !s.ctx.long_period && br.wide_tess == 0) {
      tess::ShallowTerms& sc = tess::shallow_scratch();
      tess::shallow_terms(sd0, n0, e.eo, e.xincl, sc);
      tess::slow_terms_low(sd0, n0, e.eo, e.xincl, sc);
      if (sc.count > sc.old_count) slow_list = &sc;
      s.ctx.slow_extra = sc.count - sc.old_count;
    }
  }
  // the low table's fast side (stack #477): class 0 at or below the switch follows the record's degree to kFastCap; every
  // other branch keeps kSpCap (above the switch the families are the grid's, 16.11)
  const bool fast_low = res == 0 && !s.ctx.long_period && br.wide_tess == 0;
  const int sp_cap = fast_low ? tess::kFastCap : tess::kSpCap;
  const int spd = t.tesseral > sp_cap ? sp_cap : t.tesseral;
  if (spd >= 2) {
    const int nd = t.tesseral > tess::kShallowCap ? tess::kShallowCap : t.tesseral;
    const bool wide_sp = br.wide_tess != 0;
    // the anchor's table (its raw list kept or not: stack #583), unless a caller swapped in other terms
    if (within_share && same_inc && anchor->ctx.sp_comb != nullptr &&
        anchor->ctx.sp == anchor->ctx.sp_orig && anchor->ctx.sp_count == anchor->ctx.sp_orig_count &&
        wide_sp == (anchor->ctx.branch.wide_tess != 0)) {
      s.ctx.sp_comb = anchor->ctx.sp_comb;
      s.ctx.sp_comb_count = anchor->ctx.sp_comb_count;
      s.ctx.sp = anchor->ctx.sp_orig;
      s.ctx.sp_count = anchor->ctx.sp_orig_count;
      s.ctx.sp_orig = anchor->ctx.sp_orig;
      s.ctx.sp_orig_count = anchor->ctx.sp_orig_count;
      s.ctx.sp_ci0 = anchor->ctx.sp_ci0;
      s.ctx.a0 = anchor->ctx.a0;
      s.ctx.e0 = anchor->ctx.e0;
      s.ctx.shared_mask |= 64;
    } else {
      // on the fast side the table also holds the complement of the slow set's terms above the record's degree (the slow
      // set takes its own degree): at most one entry each
      const bool fast_side = spd > tess::kSpCap;
      const int extra = fast_side && slow_list != nullptr ? slow_list->count - slow_list->old_count : 0;
      // filled in this thread's scratch at the bounds, kept at the counts (tess::SpTableScratch: no hole left behind). The
      // raw term list only where the census builds the set (keep_sp_raw, stack #583): a flight reads the combined table alone
      const bool raw = keep_sp_raw();
      tess::SpTableScratch* table = tess::sp_table_scratch(static_cast<size_t>(tess::sp_comb_bound(spd, wide_sp, extra)),
                                                           raw ? static_cast<size_t>(tess::sp_bound(spd, wide_sp, extra)) : 0u);
      if (table == nullptr) return false;
      int raw_count = 0;
      // the fast side's band guard (sp_terms' n_end): the mean motion at the record's span's end at the set's own drag rate at
      // its epoch
      double n_end = 0.0;
      if (fast_side && s.ctx.bterm > 0.0) {
        double y0[6], dd[6] = {0, 0, 0, 0, 0, 0};
        equinoctial_of(n0, e.eo, e.xincl, e.xnodeo, e.omegao, e.xmo, y0);
        const Frame fr0 = frame_of(y0);
        const Kepler k0 = kepler_of(y0, fr0.a);
        drag_part(s.ctx, 0.0, y0, fr0, k0, angle_trig(k0), s.ctx.ap_third_body ? bodies_at_ap(s.ctx.d50_epoch) : bodies_at(s.ctx.d50_epoch), dd);
        if (std::isfinite(dd[kN]) && dd[kN] > 0.0) n_end = n0 + dd[kN] * tess::kFastSpanMinutes;
      }
      const int comb_count =
          tess::sp_terms(spd, nd, res, res == 0 && !s.ctx.long_period, wide_sp, n0, e.xincl, e.eo, table->comb, raw ? table->raw : nullptr,
                         &raw_count, slow_list, fast_side ? md : tess::kFastCap + 2, fast_side, n_end);
      tess::SpCombCoef* comb_kept =
          static_cast<tess::SpCombCoef*>(sdnap::mem::malloc((comb_count > 0 ? comb_count : 1) * sizeof(tess::SpCombCoef)));
      if (comb_kept == nullptr) return false;
      tess::SpCoef* raw_kept = nullptr;
      if (raw) {
        raw_kept = static_cast<tess::SpCoef*>(sdnap::mem::malloc((raw_count > 0 ? raw_count : 1) * sizeof(tess::SpCoef)));
        if (raw_kept == nullptr) {
          std::free(comb_kept);
          return false;
        }
      }
      if (comb_count > 0) std::memcpy(comb_kept, table->comb, static_cast<size_t>(comb_count) * sizeof(tess::SpCombCoef));
      if (raw_kept != nullptr && raw_count > 0) std::memcpy(raw_kept, table->raw, static_cast<size_t>(raw_count) * sizeof(tess::SpCoef));
      s.ctx.sp_comb = comb_kept;
      s.ctx.sp_comb_count = comb_count;
      s.ctx.sp_ci0 = std::cos(e.xincl);
      s.ctx.sp = raw_kept;
      s.ctx.sp_count = raw_count;
      s.ctx.sp_orig = raw_kept;
      s.ctx.sp_orig_count = raw_count;
    }
    if (wide_sp && s.ctx.wide == nullptr) {
      // SPEC 16.11: the families of degree 2 to spd as a grid in E, by exact key (the switch by class: tess::wide_set); a copy inside its nominal's GridShareScope reads
      // the nominal's grid when within the share range
      const tess::WideGrid* ag = grid_anchor != nullptr ? grid_anchor->ctx.wide : nullptr;
      if (ag != nullptr && ag->degree == spd && grid_anchor->ctx.resonance == res && std::fabs(e.eo - ag->e) <= tess::kShareE &&
          std::fabs(e.xincl - ag->i) <= tess::kShareI && std::fabs(s.ctx.a0 / ag->a - 1.0) <= tess::kShareA) {
        tess::wide_grid_ref(grid_anchor->ctx.wide);
        s.ctx.wide = grid_anchor->ctx.wide;
        s.ctx.wide_anchor = grid_anchor;
      } else {
        tess::WideGrid* g = tess::wide_grid_acquire(spd, res, n0, e.eo, e.xincl, s.ctx.wide_fit != 0);
        if (g == nullptr) return false;
        s.ctx.wide = g;
      }
      s.ctx.wide_owned = 1;
    }
  }
  const int zd = t.zonal > 70 ? 70 : t.zonal;
  if (zd >= 6) {
    const bool wide = br.wide_e != 0;
    if (same_inc && std::fabs(e.eo - anchor->ctx.e0) <= tess::kShareE &&
        anchor->ctx.zt != nullptr && anchor->ctx.zt_degree == zd && anchor->ctx.zt_wide == (wide ? 1 : 0)) {
      s.ctx.zt = anchor->ctx.zt;
      s.ctx.zt_er = anchor->ctx.zt_er;
      s.ctx.zt_degree = zd;
      s.ctx.zt_wide = wide ? 1 : 0;
      s.ctx.shared_mask |= 16;
    } else {
      const int zc = tess::zonal_count(zd, wide);
      float* kept = static_cast<float*>(sdnap::mem::malloc(4 * zc * sizeof(float)));
      if (kept == nullptr) return false;
      tess::zonal_visit_terms(zd, wide, e.xincl, e.eo, kept);
      s.ctx.zt = kept;
      s.ctx.zt_er = tess::tail_w_anchor(e.eo);
      s.ctx.zt_degree = zd;
      s.ctx.zt_wide = wide ? 1 : 0;
    }
  }
  const int sd = t.tesseral > tess::kShallowCap ? tess::kShallowCap : t.tesseral;
  // the class's resonant tail in the rates (SPEC 16.2): half-day degrees 6 to sd; one-day degrees 5 to sd below kWideE
  // (stack #434), the terms sp_terms then leaves out of the output table
  if ((res == 2 && sd >= 6) || tess::one_day_tail(res, br.wide_tess != 0, sd)) {
    if (same_res && anchor->ctx.half_day != nullptr && std::fabs(e.eo - anchor->ctx.hd_e0) <= tess::kShareE &&
        std::fabs(e.xincl - anchor->ctx.hd_i0) <= tess::kShareI && std::fabs(s.ctx.a0 / anchor->ctx.hd_a0 - 1.0) <= tess::kShareA) {
      s.ctx.half_day = anchor->ctx.half_day;
      s.ctx.half_day_count = anchor->ctx.half_day_count;
      s.ctx.hd_e0 = anchor->ctx.hd_e0;
      s.ctx.hd_i0 = anchor->ctx.hd_i0;
      s.ctx.hd_a0 = anchor->ctx.hd_a0;
      s.ctx.shared_mask |= 1;
    } else {
      tess::HalfDayCoef* table = static_cast<tess::HalfDayCoef*>(sdnap::mem::malloc(tess::half_day_bound(sd, res) * sizeof(tess::HalfDayCoef)));
      if (table == nullptr) return false;
      s.ctx.half_day_count = tess::half_day_terms(sd, e.xincl, e.eo, table, s.ctx.hd_a0, res);
      if (s.ctx.half_day_count < 0) { std::free(table); return false; }
      // each tail keeps what it filled (stack #583): the one-day tail's amplitude cut leaves a few hundred of the bound's 2,016
      // entries at degree 31, the half-day tail about 119 of its 1,008; the entries are unchanged, only the unused bound goes
      if (s.ctx.half_day_count > 0)
        if (void* kept = sdnap::mem::realloc(table, static_cast<size_t>(s.ctx.half_day_count) * sizeof(tess::HalfDayCoef)))
          table = static_cast<tess::HalfDayCoef*>(kept);
      s.ctx.half_day = table;
    }
  }
  // SPEC 16.18 (stack #473): above its switch outside low orbit every class carries its other slow terms in the rates
  if (sd >= 2 && br.wide_tess != 0 && !(res == 0 && !s.ctx.long_period)) {
    if (within_share && anchor->ctx.wide_slow != nullptr) {
      s.ctx.wide_slow = anchor->ctx.wide_slow;
      s.ctx.wide_slow_count = anchor->ctx.wide_slow_count;
      s.ctx.e0 = anchor->ctx.e0;
      s.ctx.i0 = anchor->ctx.i0;
      s.ctx.shared_mask |= 128;
    } else {
      res::ResCoef* list = nullptr;
      const int count = tess::slow_terms_wide(spd, res, n0, e.eo, e.xincl, &list);
      if (count < 0) return false;
      s.ctx.wide_slow = list;
      s.ctx.wide_slow_count = count;
    }
  }
  if (sd >= 2 && res == 0 && !s.ctx.long_period) {
    if (within_share && anchor->ctx.shallow != nullptr) {
      s.ctx.shallow = anchor->ctx.shallow;
      s.ctx.shallow_count = anchor->ctx.shallow_count;
      s.ctx.e0 = anchor->ctx.e0;
      s.ctx.i0 = anchor->ctx.i0;
      s.ctx.shared_mask |= 8;
    } else {
      tess::ShallowTerms& scratch = tess::shallow_scratch();
      const int count = slow_list != nullptr ? scratch.count : tess::shallow_terms(sd, n0, e.eo, e.xincl, scratch);
      if (count > 0) {
        tess::ShallowCoef* kept = static_cast<tess::ShallowCoef*>(sdnap::mem::malloc(count * sizeof(tess::ShallowCoef)));
        if (kept == nullptr) return false;
        for (int j = 0; j < count; ++j)
          kept[j] = tess::ShallowCoef{scratch.c[j].l, scratch.c[j].m, scratch.c[j].p, scratch.c[j].k, static_cast<float>(scratch.c[j].fg),
                                      static_cast<float>(scratch.c[j].fdg), static_cast<float>(scratch.c[j].dfg)};
        s.ctx.shallow = kept;
        s.ctx.shallow_count = count;
      }
    }
  }
  return true;
}

/// SPEC 16.13, the transport of Y0: an AP set's radiation term Y0 (ECOM2, m/s^2) has no field of its own in the 112-byte
/// ElementRow (an ABI the engine reads) or in Elements, so inside the module it rides in the slot of SGP4's first
/// derivative of the mean motion (ElementRow.mean_motion_dot, Elements.ndot_rev_day2), which an SGP4XP or AP set does
/// not have (SPEC 1.1). It enters only from the record's ORBIT_DETERMINATION.OD_DYNAMIC_PARAMETERS (ocm.inc); a row
/// from outside the module of theory SGP4XP with that slot not 0 is refused (abi.inc), as the $OCM decoder refuses
/// MEAN_MOTION_DOT on an SGP4XP or AP set. Only a set flown with AP's terms reads it (xp_init); 0 is no such term. These
/// accessors, and radiation_y0 of an ElementRow (store.inc), are the only readers and writers of the slot for Y0.
inline double radiation_y0(const Elements& e) { return e.ndot_rev_day2; }
inline double& radiation_y0(Elements& e) { return e.ndot_rev_day2; }

/// Inside a tess::FitGridScope (SPEC 16.11) the grids this set builds above tess::kWideE are freed with it, never kept idle.
inline void xp_release(XpSat& s);
/// SPEC 1.6 (stack #497): a set that fails after ap_init took memory releases it here, on every failing return, so a caller
/// that frees the XpSat without xp_release leaks no table and no grid reference (a referenced grid is never evicted).
inline int32_t xp_init_refused(XpSat& s) {
  xp_release(s);
  s.init_error = kPropRefused;
  return kPropRefused;
}
inline void decay_epoch(XpSat& s);  // SPEC 16.25, below
inline int32_t xp_init(const Elements& e, XpSat& s) {
  s = XpSat{};
  s.ctx.ctx_id = next_ctx_id();
  s.ctx.cov_anchor_id = s.ctx.ctx_id;
  s.ctx.wide_fit = tess::fit_grids_now() ? 1 : 0;
  s.norad = e.norad;
  s.epoch_jd_whole = e.epoch_jd_whole;
  s.epoch_jd_frac = e.epoch_jd_frac;
  s.ctx.d50_epoch = (e.epoch_jd_whole - kJd1950) + e.epoch_jd_frac;
  s.ctx.bterm = e.bterm;
  s.ctx.agom = e.agom;
  if (!(e.xno > 0.0) || !(e.eo >= 0.0) || !(e.eo < 1.0) || !std::isfinite(e.xincl)) {
    s.init_error = kPropRefused;
    return kPropRefused;
  }
  // the equinoctial state's domain (SPEC 1.5: direct/retrograde factor +1, i < 180 deg): chi and psi carry tan(i/2),
  // unbounded at 180 deg, where the state and its rates are not numbers
  if (!(e.xincl >= 0.0) || !(e.xincl < kPi)) {
    s.init_error = kPropRefused;
    return kPropRefused;
  }
  const double n0 = e.xno;  // Brouwer (SPEC 1.1)
  s.ctx.selected_terms = tess::active();
  // the branch, once, from the epoch elements (SPEC 6 Bands, 16.7); a covariance's moved set (inside its nominal's
  // CovBankScope) takes its nominal's, so the columns difference one branch's theory (SPEC 12.3); a fit's trial set inside
  // a BranchScope takes the pinned one
  const XpSat* nominal = cov_bank_anchor();
  s.ctx.branch = nominal != nullptr && nominal != &s ? nominal->ctx.branch
                 : g_branch_pin != nullptr          ? *g_branch_pin
                                                    : branch_of(n0, e.eo, s.ctx.selected_terms.tesseral > 0 || s.ctx.selected_terms.zonal > 0);
  s.ctx.long_period = s.ctx.branch.long_period;
  const int8_t res = s.ctx.branch.resonance;  // the epoch class (SPEC 6 bands)
  s.ctx.resonance = res;
  s.ctx.theta_g0 = gsto_afspc(s.ctx.d50_epoch);
  s.ctx.atmosphere = atm::active();  // the call's atmosphere, if it selected one (atmosphere.inc)
  s.ctx.e0 = e.eo;
  s.ctx.i0 = e.xincl;
  if (!ap_init(e, n0, res, s)) return xp_init_refused(s);
  // SPEC 16.13: an AP set's radiation term Y0 (m/s^2; radiation_y0 above); SGP4XP flies none
  s.ctx.rad_y0 = s.ctx.ap_third_body ? radiation_y0(e) : 0.0;
  if (!std::isfinite(s.ctx.rad_y0)) return xp_init_refused(s);
  // SPEC 16.14: an AP set's solid Earth tide, with its diurnal band at the epoch; SGP4XP flies none
  s.ctx.solid_tides = s.ctx.ap_third_body && s.ctx.selected_terms.solid_tides ? 1 : 0;
  if (s.ctx.solid_tides) tide::diurnal_band(s.ctx.d50_epoch, s.ctx.tide_k1);
  if (res != 0 && !s.ctx.ap_resonance) {
    // SGP4XP: the epoch class's terms at e_0, i_0 (SPEC 6.3), the library's functions (6.4)
    res::ResCoef* rc = static_cast<res::ResCoef*>(sdnap::mem::malloc(res::class_terms(res).count * sizeof(res::ResCoef)));
    if (rc == nullptr) return xp_init_refused(s);
    s.ctx.res_count = res::current_terms(res, e.eo, std::sin(e.xincl), std::cos(e.xincl), rc);
    s.ctx.res_epoch = rc;
  }
  equinoctial_of(n0, e.eo, e.xincl, e.xnodeo, e.omegao, e.xmo, s.epoch.y);
  for (int j = 0; j < 6; ++j) s.epoch.yu[j] = s.epoch.y[j];
  XpSat* anchor = cov_bank_anchor();
  if (is_ap_ctx(s.ctx) && anchor != nullptr && anchor != &s) {
    const ptrdiff_t diff = &s - anchor;
    if (diff >= 1 && diff < 18) {
      const int slot = static_cast<int>(diff);
      const bool same_plane = (s.epoch.y[2] == anchor->epoch.y[2] && s.epoch.y[3] == anchor->epoch.y[3]);
      const bool same_slow = same_plane && (s.epoch.y[0] == anchor->epoch.y[0] && s.epoch.y[1] == anchor->epoch.y[1] &&
                                            s.epoch.y[5] == anchor->epoch.y[5]);
      const bool same_all6 = same_slow && (s.epoch.y[4] == anchor->epoch.y[4]) && (s.ctx.agom == anchor->ctx.agom) &&
                             (s.ctx.rad_y0 == anchor->ctx.rad_y0);
      s.ctx.is_cov_sigma =
          static_cast<uint8_t>(slot | (same_slow ? 32 : 0) | (same_all6 ? 64 : 0) | (same_plane ? 128 : 0));
    } else {
      s.ctx.is_cov_sigma = 0;
    }
  } else {
    s.ctx.is_cov_sigma = 0;
  }
  s.epoch.t = 0.0;
  s.epoch.index = 0;
  bool finite = rates(s.ctx, 0.0, s.epoch.y, s.epoch.f);
  for (int j = 0; finite && j < 6; ++j) finite = std::isfinite(s.epoch.y[j]) && std::isfinite(s.epoch.f[j]);
  if (!finite) return xp_init_refused(s);  // an epoch state or rate that is not a number never starts a grid
  const double step = s.ctx.long_period ? long_period_step(s.ctx) : averaged_step(s.ctx, n0);
  const double span = 8.0 * kMinutesPerDay;
  int32_t stride = static_cast<int32_t>(std::ceil(span / (kSparse * step)));
  s.stride = stride < 1 ? 1 : stride;
  decay_epoch(s);  // SPEC 16.25: an epoch past the rule is decayed at every time (one test of the epoch node: its drag part where the gate passes)
  return kPropOk;
}

/// Frees what xp_init allocated (the resonance expansion); the XpSat stays usable
/// for nothing but a new xp_init.
inline void xp_release(XpSat& s) {
  pool_release(s);
  if (!(s.ctx.shared_mask & 1)) std::free(const_cast<tess::HalfDayCoef*>(s.ctx.half_day));
  s.ctx.half_day = nullptr;
  s.ctx.half_day_count = 0;
  if (!(s.ctx.shared_mask & 2)) std::free(const_cast<res::ResCoef*>(s.ctx.res_epoch));
  s.ctx.res_epoch = nullptr;
  s.ctx.res_count = 0;
  if (!(s.ctx.shared_mask & 4)) std::free(const_cast<res::GTaylor*>(s.ctx.res_taylor));
  s.ctx.res_taylor = nullptr;
  if (!(s.ctx.shared_mask & 8)) std::free(const_cast<tess::ShallowCoef*>(s.ctx.shallow));
  s.ctx.shallow = nullptr;
  s.ctx.shallow_count = 0;
  if (!(s.ctx.shared_mask & 128)) std::free(const_cast<res::ResCoef*>(s.ctx.wide_slow));
  s.ctx.wide_slow = nullptr;
  s.ctx.wide_slow_count = 0;
  if (!(s.ctx.shared_mask & 16)) std::free(const_cast<float*>(s.ctx.zt));
  s.ctx.zt = nullptr;
  if (!(s.ctx.shared_mask & 32)) std::free(const_cast<float*>(s.ctx.mdaily));
  s.ctx.mdaily = nullptr;
  if (!(s.ctx.shared_mask & 64)) {
    std::free(const_cast<tess::SpCoef*>(s.ctx.sp_orig != nullptr ? s.ctx.sp_orig : s.ctx.sp));
    std::free(const_cast<tess::SpCombCoef*>(s.ctx.sp_comb));
  }
  s.ctx.sp = nullptr;
  s.ctx.sp_count = 0;
  s.ctx.sp_orig = nullptr;
  s.ctx.sp_orig_count = 0;
  s.ctx.sp_comb = nullptr;
  s.ctx.sp_comb_count = 0;
  s.ctx.shared_mask = 0;
  if (s.ctx.wide_owned) tess::wide_grid_drop(s.ctx.wide);
  for (int k = 0; k < 2; ++k) {
    tess::wide_grid_drop(s.wide_node[k]);
    s.wide_node[k] = nullptr;
  }
  s.ctx.wide = nullptr;
  s.ctx.wide_owned = 0;
}

/// SPEC 16.20, the field's census (stack #503). The |q| it lists to: the slow set's at or below class 0's switch, then wider.
inline int census_q_max(double e) { return e <= tess::kWideENonResonant ? tess::kSlowQMax : e <= tess::kWideE ? 8 : 12; }

/// The census's rows for a set `s` that ap_init built: every tesseral term (l, m, p, q) of the embedded field, order 1 to 70,
/// degree to 70, |q| up to census_q_max(e), whose size (tess::census_size_m) reaches `cut` m, with the weight each carrier the
/// set built holds of it, read from the set's own tables: the rates (the shallow and slow list with its band taper, the wide slow list above the switch, the class's
/// terms, the half-day and one-day tails), the output table (its entries' weights), the m-daily family, the family grid
/// (1 - tess::wide_left_out). Row of 10: l, m, p, q, psi-dot / n, the code, the rates' weight, the weight of all carriers, the
/// size (m), the term's period (days). Codes: carried once (the weights sum to 1 within 1e-3): 1 the rates, 2 the grid, 3 the output table, 8 the m-daily
/// family, 11 the rates and the output table between them, 12 the rates and the grid between them (the band taper); carried nowhere, by the carrier the term's rate and degree give it:
/// 20 above its degree, 21 under its rate floor (or out of the grid's slow band), 22 outside its q range (or its j range),
/// 23 under its own size cut, 24 partly (the weights sum to less than 1 and the share left out reaches the cut); 30 twice
/// (they sum to more than 1).
inline int census_rows(const XpSat& s, int cap, double n, double e, double inc, double cut, double* rows, int max_rows) {
  const RateContext& c = s.ctx;
  const int8_t cls = c.resonance;
  const tess::SecularRates sr = tess::secular_rates(n, e, inc);
  const double a = std::pow(kKe / n, kX2o3), band = tess::kShallowBand * n;
  const bool low = cls == 0 && !c.long_period;  // sp_terms' and wide_families' `low`
  const bool low_table = low && c.branch.wide_tess == 0;
  const int Q = census_q_max(e);
  const res::TermSet carried = c.ap_resonance && cls != 0 ? res::class_terms(cls) : res::TermSet{0, nullptr};
  const res::TermSet grid_carried = res::class_terms(cls);
  const int sd = cap > tess::kShallowCap ? tess::kShallowCap : cap;  // the near degree and the tails' (ap_init)
  // the output table's general degree (ap_init's spd: the low table's fast side follows the record to kFastCap, stack #477)
  const int table_cap = low_table ? tess::kFastCap : tess::kSpCap;
  const int table_degree = cap > table_cap ? table_cap : cap;
  const tess::WideGrid* grid = c.wide;
  double F[72], dF[72], G[72][25], dG[72][25], amp[72];
  amp[0] = kMu / a;
  for (int l = 1; l <= 70; ++l) amp[l] = amp[l - 1] / a;  // mu / a^(l+1)
  int count = 0;
  for (int w = -70; w <= 70; ++w) {
    const int aw = w < 0 ? -w : w;
    int lw = aw > 2 ? aw : 2;
    if ((lw - w) & 1) ++lw;
    if (lw > 70) continue;
    for (int l = lw; l <= 70; l += 2) {
      const int p = (l - w) / 2;
      for (int q = -Q; q <= Q; ++q) tess::slow_G(l, p, q, w + q, e, G[l][q + Q], dG[l][q + Q]);
    }
    for (int m = 1; m <= 70; ++m) {
      int l0 = m > lw ? m : lw;
      if ((l0 - w) & 1) ++l0;
      if (l0 > 70) continue;
      tess::normalized_Fk_dF(m, w, 70, inc, F, dF);
      const double nu = -(w * sr.argp + m * (sr.node - kOmegaE)) / sr.mdot;
      const int jlo = static_cast<int>(std::floor(nu - band / sr.mdot)) - 1, jhi = static_cast<int>(std::ceil(nu + band / sr.mdot)) + 1;
      bool on_grid = false;
      if (grid != nullptr)
        for (int k = 0; k < grid->count && !on_grid; ++k) on_grid = grid->m[k] == m && grid->w[k] == w;
      for (int l = l0; l <= 70; l += 2) {
        const int p = (l - w) / 2;
        const double A = amp[l] * std::hypot(tess::kEgmC[l][m], tess::kEgmS[l][m]);
        for (int q = -Q; q <= Q; ++q) {
          const int j = w + q;
          const double psidot = tess::slow_rate(sr, w, j, m), ap = std::fabs(psidot);
          const double size = tess::census_size_m(l, j, A, F[l], dF[l], G[l][q + Q], dG[l][q + Q], a, n, psidot);
          if (!(size >= cut)) continue;
          // the rates: the shallow and slow list, the class's terms, the tails
          double wr = 0.0;
          for (int k = 0; k < c.shallow_count; ++k) {
            const tess::ShallowCoef& t = c.shallow[k];
            if (t.l == l && t.m == m && t.p == p && t.k == j) { wr += tess::shallow_weight(sr, j, m, n, w); break; }
          }
          // above the switch, the wide slow list (slow_terms_wide), each term by band_taper of its own rate (wide_slow_six)
          for (int k = 0; k < c.wide_slow_count; ++k) {
            const res::ResCoef& t = c.wide_slow[k];
            if (t.l == l && t.m == m && t.p == p && t.k == j) { wr += tess::band_taper(ap / band); break; }
          }
          for (int t = 0; t < carried.count; ++t)
            if (carried.t[t].l == l && carried.t[t].m == m && carried.t[t].p == p && carried.t[t].q == q) wr += 1.0;
          if (c.half_day != nullptr) {
            if (cls == 2 && l > 5 && l <= sd && (m & 1) == 0 && j == m / 2) wr += 1.0;
            if (cls == 1 && l > 4 && l <= sd && m <= tess::kOneDayTailMaxOrder && j == m) wr += 1.0;
          }
          // the output table, by its entries' weights (each entry holds F times its weight)
          double wt = 0.0;
          for (int k = 0; k < c.sp_count; ++k) {
            const tess::SpCoef& t = c.sp[k];
            if (t.l == l && t.m == m && t.w == w && t.j == j) { wt += std::fabs(F[l]) > 1e-30 ? t.f / F[l] : 1.0; break; }
          }
          const double wm = c.mdaily != nullptr && w == 0 && j == 0 && l <= c.mdaily_degree ? 1.0 : 0.0;
          const double wg = on_grid && l <= grid->degree
                                ? 1.0 - tess::wide_left_out(cls, low, grid_carried, l, m, p, w, j, j >= jlo && j <= jhi, ap, n)
                                : 0.0;
          const double total = wr + wt + wm + wg;
          int code;
          // a share left out whose own size, (1 - total) times the term's, is under the cut counts as carried (the cut applies
          // to what is left out, as the output table's weighted cut does)
          if (total > 1.0 + 1e-3) code = 30;
          else if (total >= 1.0 - 1e-3 || (total > 1e-3 && (1.0 - total) * size < cut)) {
            const int carriers = (wr > 1e-6) + (wt > 1e-6) + (wm > 1e-6) + (wg > 1e-6);
            code = carriers > 1 ? (carriers == 2 && wr > 1e-6 && wt > 1e-6 ? 11 : carriers == 2 && wr > 1e-6 && wg > 1e-6 ? 12 : 30)
                   : wr > 1e-6 ? 1 : wg > 1e-6 ? 2 : wt > 1e-6 ? 3 : 8;
          } else if (total > 1e-3) code = 24;
          else if (low_table && ap < 1.1 * band) {
            // the slow set's (the rates hold a term below 1.1 bands, the output table above): its degree (and the families the
            // field ends at once), its q and j ranges, its size cut
            code = l0 >= tess::kSlowDegree - 1 || l > tess::slow_degree_cap() ? 20
                   : (std::abs(q) > tess::slow_q_max() || j < 1 || j > tess::kSlowJMax) ? 22 : 23;
          } else if (grid != nullptr) {
            // above the switch outside low orbit a slow term is the wide slow list's (slow_terms_wide, by its own size cut)
            code = l > grid->degree ? 20 : !low && ap < tess::kShallowSelect * band ? 23 : 21;
          } else {
            // the output table's: its degree, its q range, its floor (1e-3 n in low orbit, the band elsewhere), its size cut
            const bool under_floor = low ? ap < 1e-3 * n : ap < band;
            code = l > table_degree ? 20 : std::abs(q) > 1 ? 22 : under_floor ? 21 : 23;
          }
          if (count < max_rows) {
            double* r = rows + 10 * count;
            r[0] = l; r[1] = m; r[2] = p; r[3] = q; r[4] = psidot / n; r[5] = code; r[6] = wr; r[7] = total; r[8] = size;
            r[9] = ap > 0.0 ? kTwoPi / ap / 1440.0 : 1e30;  // the term's period, days
          }
          ++count;
        }
      }
    }
  }
  return count;
}

/// SPEC 16.20, 16.22: the census's one row beside the field, radiation pressure's (l -1, m 0, p 0, q 0, no rate), from the
/// carriers a set builds: code 4 through the output map, 13 by SPEC 4's averaged rates and periodic output terms between
/// them, 30 by both, 24 by one of SPEC 4's two alone. Its size is a Cr A/m of 0.01 m^2/kg at 1 AU over the 5-day forecast,
/// a t^2 / 2 (4,199 m). Returns the count with it.
inline int census_radiation_row(const RateContext& ctx, int count, double* rows, int max_rows) {
  const bool through = lp_radiation_through_output(ctx), averaged = radiation_averaged(ctx), periodic = radiation_periodic(ctx);
  const int code = through ? (averaged || periodic ? 30 : 4) : (averaged && periodic ? 13 : (averaged || periodic ? 24 : 20));
  if (count < max_rows) {
    double* r = rows + 10 * count;
    const double t = 5.0 * 86400.0;
    r[0] = -1; r[1] = 0; r[2] = 0; r[3] = 0; r[4] = 0; r[5] = code;
    r[6] = through || averaged ? 1.0 : 0.0;
    r[7] = code == 30 ? 2.0 : (code == 4 || code == 13 ? 1.0 : (code == 24 ? 0.5 : 0.0));
    r[8] = 0.5 * kSrpPressure * 0.01 * t * t;
    r[9] = 1e30;
  }
  return count + 1;
}

/// SPEC 16.20: the census for a set of epoch mean motion n (rad/min), e, i (rad) whose record states MAXIMUM_TESSERAL_DEGREE
/// `cap` with the slow set (a fit's record), built as a flight builds it (ap_init) and released. -1 for elements it refuses.
inline int field_census(int cap, double n, double e, double inc, double cut, double* rows, int max_rows) {
  if (!(n > 0.0) || !(e >= 0.0 && e < 1.0) || !(inc >= 0.0 && inc < kPi) || cap < 2 || cap > 70 || !(cut > 0.0)) return -1;
  Elements el{};
  el.epoch_jd_whole = 2461000.5;
  el.xno = n;
  el.eo = e;
  el.xincl = inc;
  XpSat* sp = static_cast<XpSat*>(sdnap::mem::malloc(sizeof(XpSat)));
  if (sp == nullptr) return -1;
  new (sp) XpSat{};
  XpSat& s = *sp;
  s.ctx.ctx_id = next_ctx_id();
  s.ctx.cov_anchor_id = s.ctx.ctx_id;
  s.ctx.selected_terms = tess::Terms{};
  s.ctx.selected_terms.tesseral = cap;
  s.ctx.selected_terms.slow = true;
  s.ctx.branch = branch_of(n, e, true);
  s.ctx.long_period = s.ctx.branch.long_period;
  s.ctx.resonance = s.ctx.branch.resonance;
  s.ctx.e0 = e;
  s.ctx.i0 = inc;
  int count = -1;
  {
    const KeepSpRaw keep;  // the census reads the table's terms one by one (stack #583)
    if (ap_init(el, n, s.ctx.resonance, s)) count = census_rows(s, cap, n, e, inc, cut, rows, max_rows);
  }
  if (count >= 0) count = census_radiation_row(s.ctx, count, rows, max_rows);
  xp_release(s);
  s.~XpSat();
  std::free(sp);
  return count;
}

inline void lock(int32_t* word) {
  int32_t expected = 0;
  while (!__atomic_compare_exchange_n(word, &expected, 1, false, __ATOMIC_ACQUIRE, __ATOMIC_RELAXED)) expected = 0;
}
inline void unlock(int32_t* word) { __atomic_store_n(word, 0, __ATOMIC_RELEASE); }
inline bool try_lock(int32_t* word) {
  int32_t expected = 0;
  return __atomic_compare_exchange_n(word, &expected, 1, false, __ATOMIC_ACQUIRE, __ATOMIC_RELAXED);
}

/// The sets' caches (SPEC 9): every SetCaches and the tesseral caches they hold count against one budget (default
/// 256 MB; cache_budget_mb). The pool's clock ticks at every ask for room; a holder's stamp is the clock when it was
/// last flown. A set that needs room takes free room, or reclaims the holders flown least recently, but only those not
/// flown since its own previous ask: a steady cycle over more sets than fit keeps its holders (each was flown within
/// the cycle) and the others fly on the thread's caches, while holders no longer flown give way. Never one being flown.
/// Its counts: sets holding caches, of them holding tesseral caches, bundles reclaimed, bundles and tesseral caches
/// refused (no room even after reclaiming), tesseral caches made.
struct CachePool {
  int32_t lock = 0;
  uint64_t budget = 256ull << 20;
  uint64_t held = 0;
  uint64_t clock = 1;
  uint64_t floor = 0;  ///< no holder's stamp is below it (a lower bound, raised by each search for room)
  const XpSat* last = nullptr;  ///< the set that asked last
  uint64_t sp_holders = 0, reclaimed = 0, refused = 0, sp_refused = 0, sp_made = 0;
  std::vector<XpSat*> holders;
  std::vector<XpSat*> order;  ///< pool_reclaim_locked's scratch, its capacity kept with the holders' (pool_room)
};

/// Stack #487 (SPEC 9): inside a threaded batch (pool::run, from the workers' wake to the last one done) the module's
/// memory does not grow. While this flag is set, sbrk refuses every growth (pool.inc), on every thread, and a block that
/// would have needed new pages is not given: the set's caches fall back to the thread's, and a row whose state needed
/// such a block is computed again by the calling thread after the batch (pool::run's deferral).
inline int32_t g_batch_running = 0;
/// Set by sbrk when it refuses on this thread; the row being computed reads and clears it (run_chunk).
inline thread_local int32_t g_alloc_refused = 0;
/// The pool's counts (sdnap_pool_stats): threaded batches run, growths refused, rows deferred to the calling thread,
/// batches after which the calling thread saw a larger memory (the invariant broken: 0), the pool declared dead, the
/// last reserve (bytes); the waits for a thread's view of the memory (pool::await_view) that had to yield, and the
/// most yields one took.
struct BatchStats {
  uint64_t batches = 0, refused = 0, deferred = 0, grew = 0, dead = 0, reserve = 0;
  uint64_t views = 0, view_yields_max = 0;
};
inline BatchStats& batch_stats() {
  static BatchStats s;
  return s;
}
inline void atomic_max_u64(uint64_t* word, uint64_t v) {
  uint64_t old = __atomic_load_n(word, __ATOMIC_SEQ_CST);
  while (v > old && !__atomic_compare_exchange_n(word, &old, v, false, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST)) {
  }
}
/// One wait for a thread's view that yielded `yields` times (pool::await_view; any thread).
inline void batch_view_waited(uint64_t yields) {
  BatchStats& s = batch_stats();
  __atomic_add_fetch(&s.views, 1, __ATOMIC_SEQ_CST);
  atomic_max_u64(&s.view_yields_max, yields);
}
inline bool batch_running() { return __atomic_load_n(&g_batch_running, __ATOMIC_SEQ_CST) != 0; }
inline CachePool& cache_pool() {
  static CachePool p;
  return p;
}
inline thread_local XpSat* g_flown_set = nullptr;  ///< the set whose caches this thread holds (SetScope), or nullptr

inline uint64_t sp_cache_bytes(const tess::SpEvalCache* c) { return c != nullptr ? sizeof(tess::SpEvalCache) + c->mem_bytes : 0; }

/// Under the pool's lock: frees s's caches (it holds them; the caller holds its cache_lock or owns it).
inline void pool_drop_locked(CachePool& p, XpSat& s) {
  SetCaches* c = s.caches;
  if (c == nullptr) return;
  if (c->sp.cache != nullptr) {
    p.held -= sp_cache_bytes(c->sp.cache);
    p.sp_holders -= 1;
    tess::sp_cache_free(c->sp.cache);
  }
  p.held -= c->bytes;
  for (NodeRun& r : c->run) std::free(r.nodes);
  const int32_t i = s.pool_index;
  XpSat* last = p.holders.back();
  p.holders[static_cast<size_t>(i)] = last;
  last->pool_index = i;
  p.holders.pop_back();
  delete c;
  s.caches = nullptr;
  s.pool_index = -1;
}

/// Whether `need` more bytes could fit, read without the pool's lock: free room, or a holder that may have been flown
/// last before `before` (the floor is a lower bound, so a false yes costs one search under the lock). Read unlocked, a
/// count may be stale: the answer only picks between the set's caches and the thread's, which give the same states.
inline bool pool_may_fit(const CachePool& p, uint64_t need, uint64_t before) {
  return __atomic_load_n(&p.held, __ATOMIC_RELAXED) + need <= __atomic_load_n(&p.budget, __ATOMIC_RELAXED) ||
         __atomic_load_n(&p.floor, __ATOMIC_RELAXED) < before;
}

/// Whether s asked last as well, no other set having asked since: a set flown in a run of its own states is served by the
/// thread's caches, which still hold it, so it takes free room only and reclaims no other set's (object-major flight of
/// more sets than fit would otherwise move every set's caches in and out once).
inline bool pool_asked_again(CachePool& p, const XpSat& s) {
  return __atomic_exchange_n(&p.last, &s, __ATOMIC_RELAXED) == &s;
}

/// Under the pool's lock: frees the caches of the sets flown longest ago, of those last flown before `before` (not
/// `keep`, none being flown), until `need` more bytes fit with an eighth of the budget to spare. Whether they fit.
inline bool pool_reclaim_locked(CachePool& p, uint64_t need, const XpSat* keep, uint64_t before) {
  if (p.held + need <= p.budget) return true;
  if (p.floor >= before) return false;
  // the scratch's room is kept with the holders' (pool_room), so filling it never allocates; inside a threaded batch a
  // candidate beyond its room is left out rather than grow anything (stack #487)
  std::vector<XpSat*>& order = p.order;
  order.clear();
  for (XpSat* v : p.holders)
    if (v->caches->stamp < before && v != keep) {
      if (order.size() == order.capacity() && batch_running()) break;
      order.push_back(v);
    }
  std::sort(order.begin(), order.end(), [](const XpSat* x, const XpSat* y) { return x->caches->stamp < y->caches->stamp; });
  const uint64_t target = p.budget - std::min(p.budget, std::max(need, p.budget / 8));
  for (XpSat* v : order) {
    if (p.held + need <= p.budget && p.held <= target) break;
    if (!try_lock(&v->cache_lock)) continue;
    pool_drop_locked(p, *v);
    p.reclaimed += 1;
    unlock(&v->cache_lock);
  }
  // the holders left: their lowest stamp (a holder reclaimed had the lowest; one skipped keeps the bound safe)
  uint64_t left = UINT64_MAX;
  for (XpSat* v : p.holders) left = std::min(left, v->caches->stamp);
  p.floor = p.holders.empty() ? __atomic_load_n(&p.clock, __ATOMIC_RELAXED) : std::max(p.floor, left);
  return p.held + need <= p.budget;
}

/// Sets the pool's budget to `megabytes` (0 keeps it) and returns it in MB; a smaller budget reclaims at once, the sets
/// flown longest ago first (not one being flown). No export calls it: configuration reaches the module as a typed
/// message, and none carries the budget yet; test builds (test/lib/ap-diagnostic.mjs) and benchmarks link it.
inline uint32_t cache_budget_mb(uint32_t megabytes) {
  CachePool& p = cache_pool();
  lock(&p.lock);
  if (megabytes > 0) {
    p.budget = static_cast<uint64_t>(megabytes) << 20;
    pool_reclaim_locked(p, 0, nullptr, UINT64_MAX);
  }
  const uint32_t mb = static_cast<uint32_t>(p.budget >> 20);
  unlock(&p.lock);
  return mb;
}

/// s's caches, made within the budget (s's cache_lock held by the caller); nullptr when there is no room. A first ask
/// takes free room only; a later one may reclaim holders not flown since s's previous ask.
inline SetCaches* pool_caches_for(XpSat& s) {
  if (s.caches != nullptr) return s.caches;
  CachePool& p = cache_pool();
  const uint64_t need = sizeof(SetCaches);
  const uint64_t tick = __atomic_add_fetch(&p.clock, 1, __ATOMIC_RELAXED);
  const uint64_t before = pool_asked_again(p, s) ? 0 : s.asked;
  s.asked = tick;
  if (!pool_may_fit(p, need, before)) {
    __atomic_add_fetch(&p.refused, 1, __ATOMIC_RELAXED);
    return nullptr;
  }
  lock(&p.lock);
  SetCaches* c = nullptr;
  // inside a threaded batch the holders' list may not grow past the room kept for it (pool_room): no room, no caches
  const bool listed = !(p.holders.size() == p.holders.capacity() && batch_running());
  if (listed && pool_reclaim_locked(p, need, &s, before)) c = sdnap::mem::counted(new (std::nothrow) SetCaches{});
  if (c != nullptr) {
    c->bytes = need;
    // SetScope moves the stamp to prev as the flight starts: the set's previous ask (0: none), so the tesseral cache and
    // the runs it makes in this flight take room only from holders not flown since then
    c->stamp = c->prev = before;
    p.held += need;
    s.pool_index = static_cast<int32_t>(p.holders.size());
    p.holders.push_back(&s);
    s.caches = c;
  } else {
    __atomic_add_fetch(&p.refused, 1, __ATOMIC_RELAXED);
  }
  unlock(&p.lock);
  return c;
}

/// Before a threaded batch, on the calling thread (stack #487): room in the pool's two lists for `more` sets, so that no
/// worker grows them, and the bytes the pool may still take (its budget less what it holds), which bounds what the
/// batch's sets can allocate for their caches.
inline uint64_t pool_room(size_t more) {
  CachePool& p = cache_pool();
  lock(&p.lock);
  const size_t want = p.holders.size() + more;
  if (p.holders.capacity() < want) p.holders.reserve(want);
  if (p.order.capacity() < p.holders.capacity()) p.order.reserve(p.holders.capacity());
  const uint64_t free = p.budget > p.held ? p.budget - p.held : 0;
  unlock(&p.lock);
  return free;
}

extern "C" size_t malloc_usable_size(void*);

/// What one set holds in memory: the XpSat, the term tables it owns (malloc_usable_size: as the allocator holds them;
/// a table it shares with another set counts there), the grid of its tesseral families it owns, and its caches from the
/// pool (SetCaches with its node runs and tesseral cache).
inline uint64_t xp_bytes(const XpSat& s) {
  auto u = [](const void* p) -> uint64_t { return p != nullptr ? malloc_usable_size(const_cast<void*>(p)) : 0u; };
  const RateContext& c = s.ctx;
  uint64_t b = sizeof(XpSat);
  if (!(c.shared_mask & 1)) b += u(c.half_day);
  if (!(c.shared_mask & 2)) b += u(c.res_epoch);
  if (!(c.shared_mask & 4)) b += u(c.res_taylor);
  if (!(c.shared_mask & 8)) b += u(c.shallow);
  if (!(c.shared_mask & 128)) b += u(c.wide_slow);
  if (!(c.shared_mask & 16)) b += u(c.zt);
  if (!(c.shared_mask & 32)) b += u(c.mdaily);
  if (!(c.shared_mask & 64)) b += u(c.sp_orig != nullptr ? c.sp_orig : c.sp) + u(c.sp_comb);
  // its grid of the tesseral families (SPEC 16.11) and the node grids it holds: each one block, shared among the sets
  // holding it (a grid of one exact key serves them all)
  double grids = 0.0;
  if (c.wide != nullptr && c.wide_owned && c.wide_anchor == nullptr) grids += tess::wide_grid_share(c.wide);
  for (const tess::WideGrid* g : s.wide_node) grids += tess::wide_grid_share(g);
  b += static_cast<uint64_t>(grids);
  if (s.caches != nullptr) b += s.caches->bytes + sp_cache_bytes(s.caches->sp.cache);
  return b;
}

/// Frees s's caches (xp_release).
inline void pool_release(XpSat& s) {
  if (s.caches == nullptr) return;
  CachePool& p = cache_pool();
  lock(&p.lock);
  pool_drop_locked(p, s);
  unlock(&p.lock);
}

/// While a set is flown: the caches it keeps (when it is a store's set, not a covariance's moved copy, and no other
/// thread holds them) stand in for the thread's; otherwise the thread's. Restores the caller's on exit.
struct SetScope {
  ActiveBracket* ab = g_active_bracket_set;
  tess::MdailyEvalCache* md = tess::g_mdaily_set_cache;
  tess::SpSetSlot* sp = tess::g_sp_set_slot;
  XpSat* flown = g_flown_set;
  XpSat* held = nullptr;
  explicit SetScope(XpSat& s) {
    g_active_bracket_set = nullptr;
    tess::g_mdaily_set_cache = nullptr;
    tess::g_sp_set_slot = nullptr;
    g_flown_set = nullptr;
    if (!s.pooled || s.ctx.is_cov_sigma != 0 || !try_lock(&s.cache_lock)) return;
    SetCaches* c = pool_caches_for(s);
    if (c == nullptr) {
      unlock(&s.cache_lock);
      return;
    }
    held = &s;
    c->prev = c->stamp;
    c->stamp = __atomic_load_n(&cache_pool().clock, __ATOMIC_RELAXED);
    g_active_bracket_set = &c->ab;
    tess::g_mdaily_set_cache = &c->md;
    tess::g_sp_set_slot = &c->sp;
    g_flown_set = &s;
  }
  ~SetScope() {
    g_active_bracket_set = ab;
    tess::g_mdaily_set_cache = md;
    tess::g_sp_set_slot = sp;
    g_flown_set = flown;
    if (held != nullptr) unlock(&held->cache_lock);
  }
  SetScope(const SetScope&) = delete;
  SetScope& operator=(const SetScope&) = delete;
};

namespace tess {
SpEvalCache* sp_pool_attach(const SpEvalCache& built) {
  XpSat* s = g_flown_set;
  if (s == nullptr || s->caches == nullptr) return nullptr;
  CachePool& p = cache_pool();
  // room from holders not flown since this set's previous flight (CachePool), checked before the copy is made
  const uint64_t before = pool_asked_again(p, *s) ? 0 : s->caches->prev;
  __atomic_add_fetch(&p.clock, 1, __ATOMIC_RELAXED);
  if (!pool_may_fit(p, sizeof(SpEvalCache) + built.mem_bytes, before)) {
    __atomic_add_fetch(&p.sp_refused, 1, __ATOMIC_RELAXED);
    return nullptr;
  }
  SpEvalCache* d = sp_compact_copy(built);
  if (d == nullptr) return nullptr;
  const uint64_t need = sp_cache_bytes(d);
  lock(&p.lock);
  const bool room = pool_reclaim_locked(p, need, s, before);
  if (room) {
    p.held += need;
    p.sp_holders += 1;
    p.sp_made += 1;
  } else {
    __atomic_add_fetch(&p.sp_refused, 1, __ATOMIC_RELAXED);
  }
  unlock(&p.lock);
  if (!room) {
    sp_cache_free(d);
    return nullptr;
  }
  return d;
}
void sp_pool_release(SpEvalCache* cache) {
  if (cache == nullptr) return;
  CachePool& p = cache_pool();
  lock(&p.lock);
  p.held -= sp_cache_bytes(cache);
  p.sp_holders -= 1;
  unlock(&p.lock);
  sp_cache_free(cache);
}
}  // namespace tess

/// Room for `want` nodes in run r of s's caches, charged to the pool. False when the pool has none.
inline bool run_grow(XpSat& s, SetCaches& c, NodeRun& r, int32_t want) {
  const uint64_t delta = static_cast<uint64_t>(want - r.cap) * sizeof(Node);
  CachePool& p = cache_pool();
  // room from holders not flown since this set's previous flight (CachePool)
  __atomic_add_fetch(&p.clock, 1, __ATOMIC_RELAXED);
  const uint64_t before = pool_asked_again(p, s) ? 0 : c.prev;
  if (!pool_may_fit(p, delta, before)) {
    __atomic_add_fetch(&p.refused, 1, __ATOMIC_RELAXED);
    return false;
  }
  lock(&p.lock);
  const bool room = pool_reclaim_locked(p, delta, &s, before);
  if (room) {
    p.held += delta;
    c.bytes += delta;
  } else {
    __atomic_add_fetch(&p.refused, 1, __ATOMIC_RELAXED);
  }
  unlock(&p.lock);
  if (!room) return false;
  Node* grown = static_cast<Node*>(sdnap::mem::realloc(r.nodes, static_cast<size_t>(want) * sizeof(Node)));
  if (grown == nullptr) {
    lock(&p.lock);
    p.held -= delta;
    c.bytes -= delta;
    unlock(&p.lock);
    return false;
  }
  r.nodes = grown;
  r.cap = want;
  return true;
}

/// SPEC 16.25 (stack #564): where an AP flight ends, decayed. (b) the mean perigee height a (1 - e) - R_E under kDecayFloorKm;
/// (a) with drag, more perigee radius lost over one revolution, or over the grid's next step where that is longer,
/// max(0, -d(a (1 - e))/dt_drag) max(P, h), than one density scale height H at the mean perigee (the set's own atmosphere and weather):
/// past it the averaged rates no longer describe the orbit, and the grid's next node is not an orbit (stack #564's seeds: the
/// last node before the jump loses 0.58 H a revolution and 1.15 H over its 2.9 h step; the node after it has its perigee at
/// -283 km). H is looked up only once the loss passes kDecayTestKm (below it no height the atmospheres reach has H under it).
constexpr double kDecayFloorKm = 100.0;
constexpr double kDecayTestKm = 5.0;
/// The density (kg/m^3) at geocentric radius rr (ER) along the unit direction pu (TEME) at t: node_density's, the set's own
/// atmosphere and weather at that time.
inline double decay_density(const RateContext& ctx, double t, const Vec3& pu, double rr) {
  const Vec3 rs = rr * pu;
  const double d50 = ctx.d50_epoch + t / kMinutesPerDay, theta_g = ctx.theta_g0 + kOmegaE * t;
  const Bodies b = ctx.ap_third_body ? bodies_at_ap(d50) : bodies_at(d50);
  const double sdsun = b.sun_u.z, cdsun = std::sqrt(std::fmax(0.0, 1.0 - sdsun * sdsun)), rasun = std::atan2(b.sun_u.y, b.sun_u.x);
  const bool generic = ctx.atmosphere == nullptr || !ctx.atmosphere->measured;
  const drag::Flux fl = generic ? drag::flux_at(d50) : atm::drivers_at(*ctx.atmosphere, d50);
  double D, Nd;
  drag::day_of_year(d50, D, Nd);
  const drag::DateTerms dt = drag::date_terms(fl, D, Nd);
  const double dca = ctx.atmosphere != nullptr && !ctx.atmosphere->dca_d50.empty() ? atm::dca_scale(*ctx.atmosphere, d50) : 1.0;
  const double sp = rs.z / rr, cp = std::sqrt(std::fmax(0.0, 1.0 - sp * sp));
  const NodeHeight nh = node_height(sp, cp, rr);
  const double alpha = std::atan2(rs.y, rs.x);
  double H = alpha - rasun;
  H -= kTwoPi * std::floor(H / kTwoPi);
  return node_density(ctx.atmosphere, dt, fl, dca, d50, sp, cp, sdsun, cdsun, H, alpha, theta_g, nh);
}
/// The drag's own part of the averaged rates (SPEC 3.4) at mean state y and time t, `out` in state order (zero where the set has no
/// drag or the state fails the 9.9 tests): the same call the rates make for their drag term, and no other force.
inline bool drag_rates_at(const RateContext& ctx, double t, const double* y, double* out) {
  for (int j = 0; j < 6; ++j) out[j] = 0.0;
  if (!(ctx.bterm > 0.0) || state_test(ctx, y) != 0) return false;
  const Frame fr = frame_of(y);
  const Kepler k = kepler_of(y, fr.a);
  const AngleTrig ag = angle_trig(k);
  const Bodies b = ctx.ap_third_body ? bodies_at_ap(ctx.d50_epoch + t / kMinutesPerDay) : bodies_at(ctx.d50_epoch + t / kMinutesPerDay);
  drag_part(ctx, t, y, fr, k, ag, b, out);
  return true;
}
/// A node's two decay tests as quantities that cross 0 at the rule: qb = kDecayFloorKm - h_p (km), qa = ln(loss / H), loss the
/// perigee radius's fall by DRAG over one revolution or over the grid's next step where that is longer (the drag's own da/dt (1 - e)
/// less a de/dt, counted only where it lowers the perigee: the Sun and Moon move the mean perigee of a highly eccentric orbit by more
/// than a scale height a revolution, and a perigee that rises or falls under them is not decay) (-1e300 without drag, under
/// kDecayTestKm unless `full`, or where the atmosphere gives no gradient). Decayed when either is 0 or more. The loss is the drag
/// term's own mean rates, evaluated at the node (a full drag_part); the node's whole rates only gate that evaluation (below).
struct DecayQ {
  double qa, qb;
};
inline DecayQ decay_q(const RateContext& ctx, const Node& nd, bool full) {
  const double* y = nd.y;
  const Frame fr = frame_of(y);
  const double e = std::sqrt(fr.e2), a = fr.a, n = fr.n;
  DecayQ q{-1e300, kDecayFloorKm - (a * (1.0 - e) - 1.0) * kRe};
  if (!(ctx.bterm > 0.0) || !(n > 0.0)) return q;
  const double adot = -kX2o3 * a / n * nd.f[kN];
  const double edot = e > 0.0 ? (y[kAf] * nd.f[kAf] + y[kAg] * nd.f[kAg]) / e : 0.0;
  // km per revolution, or per grid step where the step is longer: the averaged rates must follow the decay over the step the
  // grid takes next from this node (next_node's)
  const double step = ctx.long_period ? long_period_step(ctx) : averaged_step(ctx, n);
  // the gate uses the magnitudes of the whole rates' two perigee terms. The Sun and Moon can open it on an eccentric set that
  // never decays, adding a drag evaluation at each node; the drag-only loss below decides the rule, not this gate.
  const double reach = (std::fabs(adot * (1.0 - e)) + std::fabs(a * edot)) * std::fmax(kTwoPi / n, step) * kRe;
  if (!(reach > 0.0) || (!full && !(reach > kDecayTestKm))) return q;
  double dd[6];
  if (!drag_rates_at(ctx, nd.t, y, dd)) return q;
  const double adot_d = -kX2o3 * a / n * dd[kN];
  const double edot_d = e > 0.0 ? (y[kAf] * dd[kAf] + y[kAg] * dd[kAg]) / e : 0.0;
  const double loss = std::fmax(0.0, -(adot_d * (1.0 - e) - a * edot_d)) * std::fmax(kTwoPi / n, step) * kRe;
  if (!(loss > 0.0) || (!full && !(loss > kDecayTestKm))) return q;
  const Kepler k = kepler_of(y, fr.a);
  Vec3 r, v;
  double roa;
  state_at_F(y, fr, k.argp + k.node, r, v, roa);  // the mean perigee (E = 0)
  const Vec3 pu = (1.0 / norm(r)) * r;
  const double rp = a * (1.0 - e), dr = 1.0 / kRe;
  const double lo = decay_density(ctx, nd.t, pu, rp - dr), hi = decay_density(ctx, nd.t, pu, rp + dr);
  if (!(lo > hi) || !(hi > 0.0)) return q;
  q.qa = std::log(loss * std::log(lo / hi) / 2.0);  // ln(loss / H), H = 2 km / ln(rho(h - 1) / rho(h + 1))
  return q;
}
inline bool decayed(const DecayQ& q) { return q.qa >= 0.0 || q.qb >= 0.0; }
/// The crossing's time between node a (not decayed) and node b (decayed), direction dir: the earlier of the two tests' roots,
/// each linear in its quantity between the two nodes (the nodes' two tests, the earlier node's evaluated in full); a test already met at a gives a's time.
inline double decay_cross_t(const RateContext& ctx, const Node& a, const Node& b, const DecayQ& qb, int dir) {
  const DecayQ qa = decay_q(ctx, a, true);
  auto root = [&](double x0, double x1) {
    if (x0 >= 0.0) return a.t;
    const double u = x1 > x0 ? -x0 / (x1 - x0) : 1.0;
    return a.t + (b.t - a.t) * (u < 0.0 ? 0.0 : u > 1.0 ? 1.0 : u);
  };
  double t = b.t;
  if (qb.qb >= 0.0) t = root(qa.qb, qb.qb);
  if (qb.qa >= 0.0) {
    const double ta = root(qa.qa, qb.qa);
    if (dir * ta < dir * t) t = ta;
  }
  return t;
}
/// SPEC 16.25: test a new node of s's grid in direction di (dir), from cur; on the crossing record its time once. True when the
/// grid ends at this node (the crossing lies between cur and nxt).
inline bool decay_node(XpSat& s, int dir, int di, const Node& cur, const Node& nxt) {
  if (!is_ap_ctx(s.ctx)) return false;
  // found before (a run started again from an earlier node): the grid ends at the first node at or past the crossing
  if (s.decay_found[di]) return dir * nxt.t >= dir * s.decay_t[di];
  const DecayQ q = decay_q(s.ctx, nxt, false);
  if (!decayed(q)) return false;
  s.decay_t[di] = decay_cross_t(s.ctx, cur, nxt, q, dir);
  s.decay_found[di] = 1;
  return true;
}
/// SPEC 16.25: t lies past s's decay crossing (on t's side of the epoch, the crossing already found).
inline bool decay_past(const XpSat& s, double t) {
  const int di = t >= 0.0 ? 0 : 1, dir = t >= 0.0 ? 1 : -1;
  return s.decay_found[di] == 2 || (s.decay_found[di] && dir * t > dir * s.decay_t[di]);
}
/// SPEC 16.25: the epoch-decayed set (decay_found 2, written in xp_init before the set is shared): the only state of the crossing a
/// thread may read without the set's lock, since decay_t and decay_found of a found crossing are stored by whichever worker's
/// node run reaches it, under the lock.
inline bool decay_at_epoch(const XpSat& s, double t) { return s.decay_found[t >= 0.0 ? 0 : 1] == 2; }
/// decay_past and the crossing's minute, read under the set's lock (a shared set: the epoch store's, a batch's).
inline bool decay_crossing(XpSat& s, double t, double& tc) {
  lock(&s.lock);
  const bool past = decay_past(s, t);
  tc = s.decay_t[t >= 0.0 ? 0 : 1];
  unlock(&s.lock);
  return past;
}
/// SPEC 16.25: an AP set whose epoch already meets the rule is decayed at every time, its epoch too (decay_found 2).
inline void decay_epoch(XpSat& s) {
  if (!is_ap_ctx(s.ctx) || !decayed(decay_q(s.ctx, s.epoch, false))) return;
  for (int di = 0; di < 2; ++di) {
    s.decay_t[di] = 0.0;
    s.decay_found[di] = 2;
  }
}

/// The bracket of t from s's node run in direction dir (s's caches held by this thread): 1 found (lo, hi point into the
/// run or at its base), 0 the grid ends before t, -1 t lies beyond the checkpoint span or the pool has no room (the
/// checkpoints answer). The run is extended to t as bracket_ptr would integrate, filling the same checkpoints. A run
/// starts from the latest node known at or before t (the epoch, a checkpoint, the window's), and again when t precedes
/// its start: every one is a node of the one grid (a step depends on its first node alone, rk3), so the run's nodes
/// are the grid's whichever node it starts from, and a set whose caches were reclaimed refills from where it was flown.
inline int run_bracket(XpSat& s, SetCaches& c, int dir, int di, double t, const Node*& lo, const Node*& hi) {
  NodeRun& r = c.run[di];
  const double at = dir * t;
  auto beyond = [&](const Node& n) { return dir * n.t > at; };
  if (!r.based || beyond(r.base)) {
    Node cur = s.epoch;
    for (int k = 0; k < s.sparse_count[di]; ++k) {
      if (beyond(s.sparse[di][k])) break;
      cur = s.sparse[di][k];
    }
    if (s.window_valid[di]) {
      if (!beyond(s.window[di][1]) && dir * s.window[di][1].index > dir * cur.index)
        cur = s.window[di][1];
      else if (!beyond(s.window[di][0]) && dir * s.window[di][0].index > dir * cur.index)
        cur = s.window[di][0];
    }
    r.base = cur;
    r.based = true;
    r.count = 0;
    r.hint = 0;
    r.ended = false;
  }
  // nodes the run may hold: up to the checkpoint span from the epoch
  const int32_t limit = kSparse * s.stride - dir * r.base.index;
  while (r.count == 0 || !beyond(r.nodes[r.count - 1])) {
    if (r.ended) return 0;
    if (r.count >= limit) return -1;
    if (r.count == r.cap && !run_grow(s, c, r, std::min(limit, std::max(16, 2 * r.cap)))) return -1;
    const Node& cur = r.count > 0 ? r.nodes[r.count - 1] : r.base;
    Node nxt;
    // a node that is not a number, or does not advance, ends the grid: every later time is refused, never looped on
    if (!next_node(s.ctx, cur, dir, nxt) || !std::isfinite(nxt.t) || !(dir * nxt.t > dir * cur.t)) {
      r.ended = true;
      return 0;
    }
    const int32_t idx = dir * nxt.index;
    if (idx % s.stride == 0) {
      const int32_t slot = idx / s.stride - 1;
      if (slot == s.sparse_count[di] && slot < kSparse) {
        s.sparse[di][slot] = nxt;
        s.sparse_count[di] = slot + 1;
      }
    }
    r.nodes[r.count++] = nxt;
    // SPEC 16.25: an AP set's grid ends at the node past its decay crossing (the node is kept: the times before the crossing
    // bracket on it as before)
    if (decay_node(s, dir, di, cur, nxt)) r.ended = true;
  }
  auto node_at = [&](int k) -> const Node& { return k == 0 ? r.base : r.nodes[k - 1]; };
  int k = r.hint;
  if (!(k >= 0 && k < r.count && !beyond(node_at(k)) && beyond(node_at(k + 1)))) {
    int k_lo = 0, k_hi = r.count;  // node_at(k_lo) is not beyond t, node_at(k_hi) is
    while (k_hi - k_lo > 1) {
      const int mid = (k_lo + k_hi) / 2;
      if (beyond(node_at(mid))) k_hi = mid;
      else k_lo = mid;
    }
    k = k_lo;
    r.hint = k;
  }
  // the window holds the bracket, as bracket_ptr leaves it (drag_pass_rates reads it)
  const Node& nlo = node_at(k);
  if (!s.window_valid[di] || s.window[di][0].index != nlo.index) {
    s.window[di][0] = nlo;
    s.window[di][1] = node_at(k + 1);
    s.window_valid[di] = 1;
  }
  lo = &s.window[di][0];
  hi = &s.window[di][1];
  return 1;
}

/// The bracketing nodes of t (lower, upper in the direction of t). A set flown with its caches finds t in its node run
/// (run_bracket); otherwise, and beyond the run's span, the latest bracket or the furthest checkpoint at or before t
/// and integration from it, which fills the checkpoints. The nodes do not depend on the order of requests (SPEC 9).
inline bool bracket_ptr(XpSat& s, double t, const Node*& lo, const Node*& hi) {
  const int dir = t >= 0.0 ? 1 : -1;
  const int di = dir > 0 ? 0 : 1;
  const double at = dir * t;
  auto beyond = [&](const Node& n) { return dir * n.t > at; };
  if (decay_past(s, t)) return false;  // SPEC 16.25: past a crossing already found, no node is integrated
  if (g_flown_set == &s && s.caches != nullptr) {
    const int rc = run_bracket(s, *s.caches, dir, di, t, lo, hi);
    if (rc >= 0) return rc == 1;
  }
  // window hit
  if (s.window_valid[di] && !beyond(s.window[di][0]) && beyond(s.window[di][1])) {
    lo = &s.window[di][0];
    hi = &s.window[di][1];
    return true;
  }
  // start: the furthest known node at or before t
  Node cur = s.epoch;
  for (int k = 0; k < s.sparse_count[di]; ++k) {
    if (beyond(s.sparse[di][k])) break;
    cur = s.sparse[di][k];
  }
  if (s.window_valid[di]) {
    if (!beyond(s.window[di][1]) && dir * s.window[di][1].index > dir * cur.index)
      cur = s.window[di][1];
    else if (!beyond(s.window[di][0]) && dir * s.window[di][0].index > dir * cur.index)
      cur = s.window[di][0];
  }
  Node nxt;
  for (;;) {
    if (!next_node(s.ctx, cur, dir, nxt)) return false;
    // a node that is not a number, or does not advance, ends the grid: every later time is refused, never looped on
    if (!std::isfinite(nxt.t) || !(dir * nxt.t > dir * cur.t)) return false;
    const int32_t idx = dir * nxt.index;
    if (idx % s.stride == 0) {
      const int32_t slot = idx / s.stride - 1;
      if (slot == s.sparse_count[di] && slot < kSparse) {
        s.sparse[di][slot] = nxt;
        s.sparse_count[di] = slot + 1;
      }
    }
    // SPEC 16.25: the grid ends at the node past an AP set's decay crossing; a time past that node has no bracket
    const bool ends = decay_node(s, dir, di, cur, nxt);
    if (beyond(nxt)) break;
    if (ends) return false;
    cur = nxt;
  }
  s.window[di][0] = cur;
  s.window[di][1] = nxt;
  s.window_valid[di] = 1;
  lo = &s.window[di][0];
  hi = &s.window[di][1];
  return true;
}

inline bool bracket(XpSat& s, double t, Node& lo, Node& hi) {
  const Node *lo_p = nullptr, *hi_p = nullptr;
  if (!bracket_ptr(s, t, lo_p, hi_p)) return false;
  lo = *lo_p;
  hi = *hi_p;
  return true;
}

inline void update_active_bracket(const XpSat& s, const Node& lo, const Node& hi) {
  ActiveBracket& ab = active_bracket();
  const bool same_sat = ab.valid && ab.ctx_id == s.ctx.ctx_id;
  if (!same_sat || ab.lo.index != lo.index || ab.hi.index != hi.index) {
    if (!same_sat || ab.hi.index != lo.index || ab.hi.y[kN] != lo.y[kN]) {
      ab.has_t1 = false;
    }
    if (!same_sat) {
      ab.ctx_id = s.ctx.ctx_id;
      for (int j = 0; j < 6; ++j) ab.epoch_y[j] = s.epoch.y[j];
    }
    ab.d50_epoch = s.ctx.d50_epoch;
    ab.lo = lo;
    ab.hi = hi;
    ab.valid = true;
    ab.sub_idx = -1;
    ab.sub_t_lo = 0.0;
    ab.sub_t_hi = -1.0;
  }
}

/// The bracket the tesseral cache bakes on (tess::SpAnchor, SPEC 9): set's lo and hi nodes, a, e and cos i at each.
inline void set_sp_anchor(const XpSat& s, const Node& lo, const Node& hi) {
  tess::SpAnchor& an = tess::g_sp_anchor;
  const uint64_t id = (s.ctx.ctx_id << 32) ^ static_cast<uint32_t>(lo.index);
  if (an.valid && an.id == id && an.tlo == lo.t && an.h == hi.t - lo.t) return;
  auto at = [](const Node& q, double& a, double& e, double& c) {
    a = std::pow(kKe / q.y[kN], kX2o3);
    e = std::sqrt(q.y[kAf] * q.y[kAf] + q.y[kAg] * q.y[kAg]);
    const double t2 = q.y[kChi] * q.y[kChi] + q.y[kPsi] * q.y[kPsi];
    c = (1.0 - t2) / (1.0 + t2);
  };
  if (!is_ap_ctx(s.ctx)) {
    at(lo, an.a_lo, an.e_lo, an.c_lo);
    at(hi, an.a_hi, an.e_hi, an.c_hi);
  } else {
    // AP's set memo while this thread holds its caches, else the thread's own
    AnchorMemo& m = g_flown_set == &s && s.caches != nullptr ? s.caches->anchor : g_anchor_memo;
    const double in[10] = {lo.y[kN], lo.y[kAf], lo.y[kAg], lo.y[kChi], lo.y[kPsi],
                           hi.y[kN], hi.y[kAf], hi.y[kAg], hi.y[kChi], hi.y[kPsi]};
    if (!m.valid || std::memcmp(m.in, in, sizeof in) != 0) {
      at(lo, m.a_lo, m.e_lo, m.c_lo);
      at(hi, m.a_hi, m.e_hi, m.c_hi);
      std::memcpy(m.in, in, sizeof in);
      m.valid = true;
    }
    an.a_lo = m.a_lo;
    an.e_lo = m.e_lo;
    an.c_lo = m.c_lo;
    an.a_hi = m.a_hi;
    an.e_hi = m.e_hi;
    an.c_hi = m.c_hi;
  }
  an.id = id;
  an.tlo = lo.t;
  an.h = hi.t - lo.t;
  an.valid = true;
}

/// Mean equinoctial state at t on a caller-private XpSat (lock-free, zero Node copies).
inline bool mean_at_local(XpSat& s, double t, double* y) {
  if (decay_past(s, t)) return false;  // SPEC 16.25
  if (t == 0.0) {
    // stack #491: the epoch has no bracket; what output bakes there (the m-daily and tesseral terms) is the state's own,
    // never the bracket of whichever set this thread flew last
    tess::g_sp_anchor.valid = false;
    for (int j = 0; j < 6; ++j) y[j] = s.epoch.y[j];
    return true;
  }
  const Node *lo = nullptr, *hi = nullptr;
  if (!bracket_ptr(s, t, lo, hi) || decay_past(s, t)) return false;  // SPEC 16.25: a crossing this bracket found
  if (!s.ctx.is_cov_sigma) update_active_bracket(s, *lo, *hi);
  set_sp_anchor(s, *lo, *hi);
  hermite(*lo, *hi, t, y);
  return true;
}

/// Mean equinoctial state at t (minutes from epoch).
inline bool mean_at(XpSat& s, double t, double* y) {
  if (decay_at_epoch(s, t)) return false;  // SPEC 16.25: a crossing found by a node run is tested under the lock below
  if (t == 0.0) {
    tess::g_sp_anchor.valid = false;  // stack #491, as mean_at_local
    for (int j = 0; j < 6; ++j) y[j] = s.epoch.y[j];
    return true;
  }
  Node lo, hi;
  lock(&s.lock);
  const bool ok = bracket(s, t, lo, hi) && !decay_past(s, t);
  unlock(&s.lock);
  if (!ok) return false;
  if (!s.ctx.is_cov_sigma) update_active_bracket(s, lo, hi);
  set_sp_anchor(s, lo, hi);
  hermite(lo, hi, t, y);
  return true;
}

/// The mean state at t for a state flown at another time (a schedule node's grid, wide_node): the brackets and caches
/// that time's output reads (the window, the third-body bracket, the tesseral anchor) are left as they were, so the
/// output does not depend on whether the grid had to be built.
inline bool mean_at_aside(XpSat& s, double t, double* y) {
  if (decay_at_epoch(s, t)) return false;  // SPEC 16.25, as mean_at
  if (t == 0.0) {
    for (int j = 0; j < 6; ++j) y[j] = s.epoch.y[j];
    return true;
  }
  Node lo, hi;
  lock(&s.lock);
  Node window[2][2];
  int32_t window_valid[2];
  std::memcpy(window, s.window, sizeof window);
  std::memcpy(window_valid, s.window_valid, sizeof window_valid);
  const bool ok = bracket(s, t, lo, hi) && !decay_past(s, t);
  std::memcpy(s.window, window, sizeof window);
  std::memcpy(s.window_valid, window_valid, sizeof window_valid);
  unlock(&s.lock);
  if (!ok) return false;
  hermite(lo, hi, t, y);
  return true;
}

/// SPEC 1.5 (amendment 6): the rates of a native-element report at t, a fresh initialization at t: a set with epoch t
/// made from the mean elements y there (same B and AGOM, full precision), initialized (its resonance class and F, G
/// from those elements, theta_G the 1.2 value at t), its epoch rates.
inline bool report_rates(const XpSat& s, double t, const double* y, double* f) {
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
  radiation_y0(e) = s.ctx.rad_y0;  // SPEC 16.13: an AP set's Y0 (it does not enter the epoch rates: y0_blocks)
  const Kepler k = kepler_of(y);
  if (k.a * (1.0 - k.e) < 1.0) return false;  // a later report whose mean perigee is below the surface: code 2 (8.4)
  e.xno = y[kN];
  e.eo = k.e;
  e.xincl = k.i;
  e.xnodeo = k.node;
  e.omegao = k.argp;
  e.xmo = k.m;
  XpSat* x = static_cast<XpSat*>(sdnap::mem::calloc(1, sizeof(XpSat)));
  if (x == nullptr) return false;
  const atm::Atmosphere* prev_atm = atm::active();
  atm::active() = s.ctx.atmosphere;
  const bool ok = xp_init(e, *x) == kPropOk;
  atm::active() = prev_atm;
  if (ok)
    for (int j = 0; j < 6; ++j) f[j] = x->epoch.f[j];
  xp_release(*x);
  std::free(x);
  return ok;
}

/// AP above tess::kWideE (SPEC 16.11): the grid of schedule node j, built at the set's mean elements at j kGridEvery (node 0: the
/// set's own), at the epoch's mean motion in the long-period regime with the Sun and Moon (RateContext::wide_a); `held` says
/// whether the caller drops it. False when the mean elements there are not numbers or out of memory.
inline bool wide_node(XpSat& s, int j, tess::WideGrid*& out, bool& held) {
  held = false;
  if (j == 0) { out = s.ctx.wide; return true; }
  if (s.ctx.wide_anchor != nullptr) return wide_node(*s.ctx.wide_anchor, j, out, held);  // a copy reads its nominal's nodes
  // the set keeps its last two nodes' grids; a hit adds the caller as a holder
  lock(&s.wide_lock);
  for (int k = 0; k < 2; ++k)
    if (s.wide_node[k] != nullptr && s.wide_node_j[k] == j) {
      out = s.wide_node[k];
      tess::wide_grid_ref(out);
      unlock(&s.wide_lock);
      held = true;
      return true;
    }
  unlock(&s.wide_lock);
  double yj[6];
  if (!mean_at_aside(s, j * tess::kGridEvery, yj) || !(yj[kN] > 0.0)) return false;
  const Kepler k = kepler_of(yj);
  if (!(k.e < 1.0)) return false;
  out = tess::wide_grid_acquire(s.ctx.wide->degree, s.ctx.resonance, s.ctx.wide_a > 0.0 ? s.ctx.wide->n : yj[kN], k.e, k.i,
                                s.ctx.wide_fit != 0);
  if (out == nullptr) return false;
  held = true;
  // keep it in the slot farther from j
  tess::wide_grid_ref(out);
  lock(&s.wide_lock);
  const int slot = s.wide_node[0] == nullptr ? 0 : s.wide_node[1] == nullptr ? 1
                   : (std::abs(s.wide_node_j[0] - j) >= std::abs(s.wide_node_j[1] - j) ? 0 : 1);
  tess::WideGrid* old = s.wide_node[slot];
  s.wide_node[slot] = out;
  s.wide_node_j[slot] = j;
  unlock(&s.wide_lock);
  tess::wide_grid_drop(old);
  return true;
}

/// AP above e 0.3 (SPEC 16.12): the drag rates output_drag_pass adds to the state at t (mean state y there, the bracket
/// mean_at left in the window), without the 78 atmosphere nodes of drag_part at every state. Within one revolution (from
/// the perigee tp before t to the next) drag_part's two passes are the same, and within one bracket of the grid the mean
/// state is one cubic (hermite), so on their intersection, the segment, drag_part's rates are a smooth function of t:
/// they are taken as the polynomial through drag_part at kPoints times of the segment, each at the bracket's own mean
/// state there (the state that time's output flies). kPoints evaluations serve every state of the segment; the largest
/// difference from drag_part at every state is stated by test/kernel-cost.mjs --diff. False (the state evaluates its own)
/// at the epoch, when the window does not bracket t, or when a point of the segment falls in another revolution.
inline bool drag_pass_rates(XpSat& s, double t, const double* y, DragPassRates& out) {
  if (t == 0.0) return false;
  const Frame fr = frame_of(y);
  const Kepler k = kepler_of(y, fr.a);
  if (!(k.e < 1.0) || !(fr.n > 0.0)) return false;
  const double tp_state = t - k.m / fr.n;
  constexpr int K = DragPassCache::kPoints;
  const int di = t >= 0.0 ? 0 : 1;
  const double dir = t >= 0.0 ? 1.0 : -1.0;
  lock(&s.lock);
  const bool valid = s.window_valid[di] != 0;
  const Node lo = s.window[di][0], hi = s.window[di][1];
  unlock(&s.lock);
  if (!valid || !(dir * lo.t <= dir * t && dir * t < dir * hi.t)) return false;
  // the revolution's perigee time and period from the bracket's lower node, the same for every state of the revolution
  // (a state's own differ by its mean anomaly's drift and its mean motion, so the first state asked would set the
  // segment)
  double tp, period;
  {
    const Frame flo = frame_of(lo.y);
    const Kepler klo = kepler_of(lo.y, flo.a);
    if (!(klo.e < 1.0) || !(flo.n > 0.0)) return false;
    period = kTwoPi / flo.n;
    const double tp_lo = lo.t - klo.m / flo.n;
    tp = tp_lo + std::round((tp_state - tp_lo) / period) * period;
  }
  out.ctx_id = s.ctx.ctx_id;
  out.t = t;
  DragPassCache& c = s.drag_pass;
  // the Lagrange polynomial through the segment's points, at t
  auto take = [&](int q) {
    for (int j = 0; j < kDragPassValues; ++j) out.v[j] = 0.0;
    for (int i = 0; i < K; ++i) {
      double w = 1.0;
      for (int m = 0; m < K; ++m)
        if (m != i) w *= (t - c.tk[q][m]) / (c.tk[q][i] - c.tk[q][m]);
      for (int j = 0; j < kDragPassValues; ++j) out.v[j] += w * c.v[q][i][j];
    }
  };
  lock(&c.lock);
  for (int q = 0; q < 2; ++q)
    if (c.held[q] && c.node_t[q] == lo.t && std::fabs(c.tp[q] - tp) <= 0.125 * period) {
      take(q);
      unlock(&c.lock);
      return true;
    }
  unlock(&c.lock);
  // the segment: the revolution's stretch inside the bracket; drag_part at its points s0 + (i + 1/2) (s1 - s0) / K
  const double s0 = std::fmax(std::fmin(lo.t, hi.t), tp), s1 = std::fmin(std::fmax(lo.t, hi.t), tp + period);
  if (!(s1 > s0)) return false;
  double tk[K], fk[K][kDragPassValues];
  for (int i = 0; i < K; ++i) {
    tk[i] = s0 + ((i + 0.5) / K) * (s1 - s0);
    double yx[6];
    hermite(lo, hi, tk[i], yx);
    if (!(yx[kN] > 0.0)) return false;
    const Frame fx = frame_of(yx);
    const Kepler kx = kepler_of(yx, fx.a);
    if (!(kx.e < 1.0) || std::fabs(tk[i] - kx.m / fx.n - tp) > 0.125 * period) return false;
    drag_passes(s.ctx, tk[i], yx, fx, kx, angle_trig(kx), bodies_at_ap(s.ctx.d50_epoch + tk[i] / kMinutesPerDay), fk[i]);
  }
  lock(&c.lock);
  const int q = c.next;
  c.next ^= 1;
  c.held[q] = 1;
  c.node_t[q] = lo.t;
  c.tp[q] = tp;
  for (int i = 0; i < K; ++i) {
    c.tk[q][i] = tk[i];
    for (int j = 0; j < kDragPassValues; ++j) c.v[q][i][j] = fk[i][j];
  }
  take(q);
  unlock(&c.lock);
  return true;
}

inline int32_t xp_propagate_impl(XpSat& s, double t, double r[3], double v[3], const Bodies* shared, bool local_sat) {
  if (s.init_error != 0) return kPropRefused;
  SetScope set_scope(s);
  // the bracket this state's tesseral bakes are made on: set by mean_at, the caller's restored on return
  struct AnchorScope {
    tess::SpAnchor saved = tess::g_sp_anchor;
    AnchorScope() { tess::g_sp_anchor.valid = false; }
    ~AnchorScope() { tess::g_sp_anchor = saved; }
  } anchor_scope;
  double y[6];
  // SPEC 16.25: a time past an AP set's decay crossing is refused as decayed (status 4)
  if (!(local_sat ? mean_at_local(s, t, y) : mean_at(s, t, y))) {
    // a caller-private set is read directly; a shared one under its lock (a crossing found by another worker after this
    // call's own refusal is then read whole: decay_t is stored before decay_found, both under that lock)
    double tc;
    const bool past = local_sat ? decay_past(s, t) : decay_crossing(s, t, tc);
    return past ? kPropDecayed : kPropMeanMotion;
  }
  // AP above e 0.3: the drag rates output_drag_pass adds, from the state's segment; a fit (inside its tess::FitGridScope)
  // keeps drag_part at each of its states, so the sets it writes do not depend on the segments
  DragPassRates pass_rates;
  const bool held = s.ctx.drag_pass && s.ctx.bterm > 0.0 && !tess::fit_grids_now() && drag_pass_rates(s, t, y, pass_rates);
  struct Held {
    explicit Held(const DragPassRates* p) { g_drag_pass_rates = p; }
    ~Held() { g_drag_pass_rates = nullptr; }
  } scope(held ? &pass_rates : nullptr);
  int32_t status;
  if (s.ctx.wide != nullptr && s.ctx.wide_owned) {
    // the nodes around t, the same for every set of a fit; the context per call, so concurrent calls on one set share nothing
    // node j covers |t| from |j| kGridEvery away from the epoch, on t's side; it blends into the next node outward
    const double x = t / tess::kGridEvery;
    const int j = t >= 0.0 ? static_cast<int>(std::floor(x)) : static_cast<int>(std::ceil(x));
    const int next = t >= 0.0 ? j + 1 : j - 1;
    const double u = std::fabs(x - j);
    const double blend = u < 1.0 - tess::kGridBlend ? 0.0 : (u - (1.0 - tess::kGridBlend)) / tess::kGridBlend;
    tess::WideGrid* g0 = nullptr;
    tess::WideGrid* g1 = nullptr;
    bool h0 = false, h1 = false;
    double blend_use = blend;
    bool nodes_ok = wide_node(s, j, g0, h0);
    if (nodes_ok && blend_use > 0.0 && !wide_node(s, next, g1, h1)) {
      // SPEC 16.25: the next schedule node lies past the set's decay crossing (asking for it is what ran the grid there and found
      // the crossing, so this holds in any call order): the state is answered from this node's grid alone, never refused
      double tc = 0.0;
      // the crossing of the set that owns the grid (a copy built in a grid-sharing scope reads its anchor's nodes: wide_node asked the anchor)
      XpSat& owner = s.ctx.wide_anchor != nullptr ? *s.ctx.wide_anchor : s;
      if (is_ap_ctx(s.ctx) && decay_crossing(owner, next * tess::kGridEvery, tc)) { g1 = nullptr; blend_use = 0.0; }
      else nodes_ok = false;
    }
    if (!nodes_ok) {
      if (h0) tess::wide_grid_drop(g0);
      return kPropRefused;
    }
    RateContext c = s.ctx;
    c.wide = g0;
    c.wide_next = g1;
    c.wide_blend = blend_use;
    status = output(c, t, y, r, v, shared);
    if (h0) tess::wide_grid_drop(g0);
    if (h1) tess::wide_grid_drop(g1);
  } else {
    status = output(s.ctx, t, y, r, v, shared);
  }
  if (status == kPropOk && s.ctx.ap_frame) frames::teme_drift(s.epoch_jd_whole, s.epoch_jd_frac, t, r, v);
  return status;
}

inline int32_t xp_propagate(XpSat& s, double t, double r[3], double v[3], const Bodies* shared = nullptr) {
  return xp_propagate_impl(s, t, r, v, shared, false);
}

inline int32_t xp_propagate_local(XpSat& s, double t, double r[3], double v[3], const Bodies* shared = nullptr) {
  return xp_propagate_impl(s, t, r, v, shared, true);
}

#ifdef __wasm_simd128__
[[gnu::noinline]] inline int eval_cov_pair_j2_fast(
    XpSat& s0, XpSat& sp, XpSat& sm, double t, const double* ym0, const CovNomOsc& nom_osc,
    bool can_share_3b, bool can_share_sp, bool can_share_srp,
    const double* d_3b0, const double* dd_3b_dlam,
    const double* d_sp0, const double* dd_sp_dlam, const double* d2_sp_dlam2,
    const double* d_srp_unit0, bool has_drift, const double R_drift[3][3],
    double inv_d, double* J, int np, int col_j) {
  if (!nom_osc.valid || t == 0.0 || !s0.ctx.ap_third_body || s0.ctx.drag_pass) return 0;
  if (sp.init_error != 0 || sm.init_error != 0) return -1;
  if (sp.ctx.ap_frame != sm.ctx.ap_frame ||
      (sp.ctx.drag_pass && sp.ctx.bterm > 0.0) || (sm.ctx.drag_pass && sm.ctx.bterm > 0.0))
    return 0;
  double ym_p[6], ym_m[6];
  // each moved set flown on its own (stack #491)
  if (!mean_at_local(sp, t, ym_p) || !mean_at_local(sm, t, ym_m)) return -1;
  const bool same_cls_p = sp.ctx.long_period == s0.ctx.long_period && sp.ctx.resonance == s0.ctx.resonance &&
                          (sp.ctx.wide == nullptr || sp.ctx.wide_anchor == &s0);
  const bool same_cls_m = sm.ctx.long_period == s0.ctx.long_period && sm.ctx.resonance == s0.ctx.resonance &&
                          (sm.ctx.wide == nullptr || sm.ctx.wide_anchor == &s0);
  if (!same_cls_p || !same_cls_m) return 0;
  if (!s0.ctx.long_period && !can_share_3b) return 0;
  const double plane_lim = (s0.ctx.i0 > 0.02 ? 0.005 : 0.0005) * s0.ctx.i0;
  const bool small_plane =
      (s0.ctx.i0 > 1e-5) &&
      (std::fabs(ym_p[kChi] - ym0[kChi]) + std::fabs(ym_p[kPsi] - ym0[kPsi])) < plane_lim &&
      (std::fabs(ym_m[kChi] - ym0[kChi]) + std::fabs(ym_m[kPsi] - ym0[kPsi])) < plane_lim;
  const double dlam_p = ym_p[kLam] - ym0[kLam], dlam_m = ym_m[kLam] - ym0[kLam];
  // the output table by its combined entries (a set keeps its raw term list only for the census: stack #583)
  const bool need_sp_any = (sp.ctx.mdaily != nullptr || sp.ctx.sp_comb != nullptr || sp.ctx.wide != nullptr ||
                            sm.ctx.mdaily != nullptr || sm.ctx.sp_comb != nullptr || sm.ctx.wide != nullptr);
  if (need_sp_any && !(can_share_sp && small_plane && std::fabs(dlam_p) < 0.15 && std::fabs(dlam_m) < 0.15))
    return 0;
  const bool need_srp_any = (sp.ctx.agom > 0.0 || sm.ctx.agom > 0.0);
  if (need_srp_any && !(can_share_srp && small_plane)) return 0;

  const v128_t vdlam = wasm_f64x2_make(dlam_p, dlam_m);
  const v128_t vagom = wasm_f64x2_make(sp.ctx.agom, sm.ctx.agom);
  v128_t vy[6];
  for (int m = 0; m < 6; ++m) {
    v128_t v = wasm_f64x2_make(ym_p[m], ym_m[m]);
    if (can_share_3b) {
      v = wasm_f64x2_add(v, wasm_f64x2_add(wasm_f64x2_splat(d_3b0[m]),
                                           wasm_f64x2_mul(wasm_f64x2_splat(dd_3b_dlam[m]), vdlam)));
    }
    if (need_sp_any) {
      const v128_t vsp_lin = wasm_f64x2_add(wasm_f64x2_splat(dd_sp_dlam[m]),
                                            wasm_f64x2_mul(wasm_f64x2_splat(0.5 * d2_sp_dlam2[m]), vdlam));
      v = wasm_f64x2_add(v, wasm_f64x2_add(wasm_f64x2_splat(d_sp0[m]), wasm_f64x2_mul(vsp_lin, vdlam)));
    }
    if (need_srp_any) {
      v = wasm_f64x2_add(v, wasm_f64x2_mul(wasm_f64x2_splat(d_srp_unit0[m]), vagom));
    }
    vy[m] = v;
  }

  const double yn_p = wasm_f64x2_extract_lane(vy[kN], 0), yn_m = wasm_f64x2_extract_lane(vy[kN], 1);
  if (!(yn_p > 0.0 && yn_m > 0.0)) return 0;
  const v128_t ve2 = wasm_f64x2_add(wasm_f64x2_mul(vy[kAf], vy[kAf]), wasm_f64x2_mul(vy[kAg], vy[kAg]));
  const v128_t vt2 = wasm_f64x2_add(wasm_f64x2_mul(vy[kChi], vy[kChi]), wasm_f64x2_mul(vy[kPsi], vy[kPsi]));
  const double e2_p = wasm_f64x2_extract_lane(ve2, 0), e2_m = wasm_f64x2_extract_lane(ve2, 1);
  const double t2_p = wasm_f64x2_extract_lane(vt2, 0), t2_m = wasm_f64x2_extract_lane(vt2, 1);
  if (!(e2_p > 1e-24 && e2_m > 1e-24 && e2_p < 0.90 && e2_m < 0.90 && t2_p > 1e-24 && t2_m > 1e-24)) return 0;

  const v128_t vdu_n = wasm_f64x2_mul(wasm_f64x2_sub(vy[kN], wasm_f64x2_splat(nom_osc.n0)),
                                      wasm_f64x2_splat(nom_osc.inv_n0));
  if (!(std::fabs(wasm_f64x2_extract_lane(vdu_n, 0)) < 2e-3 &&
        std::fabs(wasm_f64x2_extract_lane(vdu_n, 1)) < 2e-3))
    return 0;

  const v128_t vone = wasm_f64x2_splat(1.0);
  const v128_t va_poly = wasm_f64x2_add(
      vone,
      wasm_f64x2_mul(vdu_n, wasm_f64x2_add(
          wasm_f64x2_splat(-2.0 / 3.0),
          wasm_f64x2_mul(vdu_n, wasm_f64x2_add(
              wasm_f64x2_splat(5.0 / 9.0),
              wasm_f64x2_mul(vdu_n, wasm_f64x2_add(
                  wasm_f64x2_splat(-40.0 / 81.0),
                  wasm_f64x2_mul(vdu_n, wasm_f64x2_splat(110.0 / 243.0)))))))));
  const v128_t va = wasm_f64x2_mul(wasm_f64x2_splat(nom_osc.a0), va_poly);
  const v128_t vom_e2 = wasm_f64x2_sub(vone, ve2);
  const v128_t vp = wasm_f64x2_mul(va, vom_e2);
  const v128_t ve = wasm_f64x2_sqrt(ve2);
  const v128_t veta = wasm_f64x2_sqrt(vom_e2);
  const v128_t vt_inc = wasm_f64x2_sqrt(vt2);
  const v128_t v1pt2 = wasm_f64x2_add(vone, vt2);
  const v128_t v1peta = wasm_f64x2_add(vone, veta);
  const v128_t vinv_1pt2 = wasm_f64x2_div(vone, v1pt2);
  const v128_t vinv_t = wasm_f64x2_div(vone, vt_inc);
  const v128_t vinv_e = wasm_f64x2_div(vone, ve);
  const v128_t vinv_eta = wasm_f64x2_div(vone, veta);
  const v128_t vinv_ep = wasm_f64x2_div(vone, wasm_f64x2_mul(v1peta, vp));
  const v128_t vinv_1peta = wasm_f64x2_mul(vinv_ep, vp);
  const v128_t vinv_p = wasm_f64x2_mul(vinv_ep, v1peta);

  const v128_t vsF0 = wasm_f64x2_splat(nom_osc.sF0);
  const v128_t vcF0 = wasm_f64x2_splat(nom_osc.cF0);
  const v128_t vdlam_osc = wasm_f64x2_sub(vy[kLam], wasm_f64x2_splat(nom_osc.lam0));
  const v128_t vesF0 = wasm_f64x2_sub(wasm_f64x2_mul(vy[kAf], vsF0), wasm_f64x2_mul(vy[kAg], vcF0));
  const v128_t vecF0 = wasm_f64x2_add(wasm_f64x2_mul(vy[kAf], vcF0), wasm_f64x2_mul(vy[kAg], vsF0));
  const v128_t vdm = wasm_f64x2_add(wasm_f64x2_sub(vdlam_osc, wasm_f64x2_splat(nom_osc.dF0)), vesF0);
  const v128_t vf1 = wasm_f64x2_sub(vone, vecF0);
  const v128_t vinv_f1 = wasm_f64x2_div(vone, vf1);
  const v128_t vr1 = wasm_f64x2_mul(vdm, vinv_f1);
  const double r1_p = wasm_f64x2_extract_lane(vr1, 0), r1_m = wasm_f64x2_extract_lane(vr1, 1);
  if (!(std::fabs(r1_p) < 0.08 && std::fabs(r1_m) < 0.08))
    return 0;
  const v128_t vf2_o_f1 = wasm_f64x2_mul(vesF0, vinv_f1);
  const v128_t vf3_o_f1 = wasm_f64x2_mul(vecF0, vinv_f1);
  const v128_t vr1_2 = wasm_f64x2_mul(vr1, vr1);
  const v128_t vu0 = wasm_f64x2_mul(
      vr1,
      wasm_f64x2_add(wasm_f64x2_sub(vone, wasm_f64x2_mul(wasm_f64x2_splat(0.5), wasm_f64x2_mul(vr1, vf2_o_f1))),
                     wasm_f64x2_mul(vr1_2, wasm_f64x2_sub(wasm_f64x2_mul(wasm_f64x2_splat(0.5), wasm_f64x2_mul(vf2_o_f1, vf2_o_f1)),
                                                          wasm_f64x2_mul(wasm_f64x2_splat(1.0 / 6.0), vf3_o_f1)))));
  const v128_t vu2 = wasm_f64x2_mul(vu0, vu0);
  const v128_t vcu0_k = wasm_f64x2_sub(
      vone,
      wasm_f64x2_mul(vu2, wasm_f64x2_sub(wasm_f64x2_splat(0.5),
                                         wasm_f64x2_mul(vu2, wasm_f64x2_sub(wasm_f64x2_splat(1.0 / 24.0),
                                                                            wasm_f64x2_mul(vu2, wasm_f64x2_splat(1.0 / 720.0)))))));
  const v128_t vsu0_k = wasm_f64x2_mul(
      vu0,
      wasm_f64x2_sub(vone,
                     wasm_f64x2_mul(vu2, wasm_f64x2_sub(wasm_f64x2_splat(1.0 / 6.0),
                                                        wasm_f64x2_mul(vu2, wasm_f64x2_sub(wasm_f64x2_splat(1.0 / 120.0),
                                                                                           wasm_f64x2_mul(vu2, wasm_f64x2_splat(1.0 / 5040.0))))))));
  v128_t vsF = wasm_f64x2_add(wasm_f64x2_mul(vsF0, vcu0_k), wasm_f64x2_mul(vcF0, vsu0_k));
  v128_t vcF = wasm_f64x2_sub(wasm_f64x2_mul(vcF0, vcu0_k), wasm_f64x2_mul(vsF0, vsu0_k));
  if (e2_p > 1.6e-5 || e2_m > 1.6e-5 || std::fabs(r1_p) > 0.003 || std::fabs(r1_m) > 0.003) {
    const v128_t vesF1 = wasm_f64x2_sub(wasm_f64x2_mul(vy[kAf], vsF), wasm_f64x2_mul(vy[kAg], vcF));
    const v128_t vecF1 = wasm_f64x2_add(wasm_f64x2_mul(vy[kAf], vcF), wasm_f64x2_mul(vy[kAg], vsF));
    const v128_t vfv1 = wasm_f64x2_sub(wasm_f64x2_add(wasm_f64x2_sub(wasm_f64x2_splat(nom_osc.dF0), vdlam_osc), vu0), vesF1);
    const v128_t vduF = wasm_f64x2_div(vfv1, wasm_f64x2_sub(vone, vecF1));
    const v128_t vh2 = wasm_f64x2_sub(vone, wasm_f64x2_mul(wasm_f64x2_splat(0.5), wasm_f64x2_mul(vduF, vduF)));
    const v128_t vs_prev = vsF;
    vsF = wasm_f64x2_sub(wasm_f64x2_mul(vs_prev, vh2), wasm_f64x2_mul(vcF, vduF));
    vcF = wasm_f64x2_add(wasm_f64x2_mul(vcF, vh2), wasm_f64x2_mul(vs_prev, vduF));
  }

  const v128_t vth = wasm_f64x2_mul(wasm_f64x2_sub(vone, vt2), vinv_1pt2);
  const v128_t vsi = wasm_f64x2_mul(wasm_f64x2_add(vt_inc, vt_inc), vinv_1pt2);
  const v128_t vsO = wasm_f64x2_mul(vy[kChi], vinv_t);
  const v128_t vcO = wasm_f64x2_mul(vy[kPsi], vinv_t);
  const v128_t vcv = wasm_f64x2_mul(vy[kAf], vinv_e);
  const v128_t vsv = wasm_f64x2_mul(vy[kAg], vinv_e);
  const v128_t vcw = wasm_f64x2_add(wasm_f64x2_mul(vcv, vcO), wasm_f64x2_mul(vsv, vsO));
  const v128_t vsw = wasm_f64x2_sub(wasm_f64x2_mul(vsv, vcO), wasm_f64x2_mul(vcv, vsO));
  const v128_t vsE = wasm_f64x2_sub(wasm_f64x2_mul(vsF, vcv), wasm_f64x2_mul(vcF, vsv));
  const v128_t vcE = wasm_f64x2_add(wasm_f64x2_mul(vcF, vcv), wasm_f64x2_mul(vsF, vsv));

  const v128_t vesE = wasm_f64x2_mul(ve, vsE);
  const v128_t vome = wasm_f64x2_sub(vone, wasm_f64x2_mul(ve, vcE));
  const v128_t vinv_ome = wasm_f64x2_div(vone, vome);
  const v128_t vtv = wasm_f64x2_div(vesE, wasm_f64x2_add(vome, veta));
  const double tv_p = wasm_f64x2_extract_lane(vtv, 0), tv_m = wasm_f64x2_extract_lane(vtv, 1);
  v128_t vphi_v;
  if (std::fabs(tv_p) < 0.06 && std::fabs(tv_m) < 0.06) {
    const v128_t vtv2 = wasm_f64x2_mul(vtv, vtv);
    vphi_v = wasm_f64x2_mul(
        vtv,
        wasm_f64x2_sub(vone, wasm_f64x2_mul(vtv2, wasm_f64x2_sub(wasm_f64x2_splat(1.0 / 3.0),
                                                                 wasm_f64x2_mul(vtv2, wasm_f64x2_sub(wasm_f64x2_splat(1.0 / 5.0),
                                                                                                     wasm_f64x2_mul(vtv2, wasm_f64x2_splat(1.0 / 7.0))))))));
  } else {
    const v128_t vdtv = wasm_f64x2_sub(vtv, wasm_f64x2_splat(nom_osc.tv0));
    const v128_t vden_tv = wasm_f64x2_add(vone, wasm_f64x2_mul(wasm_f64x2_splat(nom_osc.tv0), vtv));
    const v128_t vz = wasm_f64x2_div(vdtv, vden_tv);
    if (!(std::fabs(wasm_f64x2_extract_lane(vz, 0)) < 0.02 &&
          std::fabs(wasm_f64x2_extract_lane(vz, 1)) < 0.02))
      return 0;
    const v128_t vz2 = wasm_f64x2_mul(vz, vz);
    const v128_t vdphi = wasm_f64x2_mul(
        vz,
        wasm_f64x2_sub(vone, wasm_f64x2_mul(vz2, wasm_f64x2_sub(wasm_f64x2_splat(1.0 / 3.0),
                                                                wasm_f64x2_mul(vz2, wasm_f64x2_sub(wasm_f64x2_splat(1.0 / 5.0),
                                                                                                    wasm_f64x2_mul(vz2, wasm_f64x2_splat(1.0 / 7.0))))))));
    vphi_v = wasm_f64x2_add(wasm_f64x2_splat(nom_osc.phi_v0), vdphi);
  }

  const v128_t vsnu = wasm_f64x2_mul(wasm_f64x2_mul(veta, vsE), vinv_ome);
  const v128_t vcnu = wasm_f64x2_mul(wasm_f64x2_sub(vcE, ve), vinv_ome);
  const v128_t vr = wasm_f64x2_mul(va, vome);
  const v128_t vth2 = wasm_f64x2_mul(vth, vth);
  const v128_t vc_j2 = wasm_f64x2_mul(wasm_f64x2_splat(0.25 * kJ2), vinv_p);
  const v128_t vd_j2 = wasm_f64x2_mul(vc_j2, vinv_p);
  const v128_t vbeta = wasm_f64x2_mul(ve, vinv_1peta);
  const v128_t vesnu = wasm_f64x2_mul(ve, vsnu);
  const v128_t vQw = wasm_f64x2_add(wasm_f64x2_add(vesE, wasm_f64x2_add(vphi_v, vphi_v)), vesnu);
  const v128_t vn_a = vy[kN];

  const v128_t vc2w = wasm_f64x2_sub(wasm_f64x2_mul(vcw, vcw), wasm_f64x2_mul(vsw, vsw));
  const v128_t vs2w = wasm_f64x2_mul(wasm_f64x2_add(vsw, vsw), vcw);
  const v128_t vc2n = wasm_f64x2_sub(wasm_f64x2_mul(vcnu, vcnu), wasm_f64x2_mul(vsnu, vsnu));
  const v128_t vs2n = wasm_f64x2_mul(wasm_f64x2_add(vsnu, vsnu), vcnu);
  const v128_t vc3n = wasm_f64x2_sub(wasm_f64x2_mul(vc2n, vcnu), wasm_f64x2_mul(vs2n, vsnu));
  const v128_t vs3n = wasm_f64x2_add(wasm_f64x2_mul(vs2n, vcnu), wasm_f64x2_mul(vc2n, vsnu));
  const v128_t vc2u = wasm_f64x2_sub(wasm_f64x2_mul(vc2w, vc2n), wasm_f64x2_mul(vs2w, vs2n));
  const v128_t vs2u = wasm_f64x2_add(wasm_f64x2_mul(vs2w, vc2n), wasm_f64x2_mul(vc2w, vs2n));
  const v128_t vcw1 = wasm_f64x2_sub(wasm_f64x2_mul(vc2w, vcnu), wasm_f64x2_mul(vs2w, vsnu));
  const v128_t vsw1 = wasm_f64x2_add(wasm_f64x2_mul(vs2w, vcnu), wasm_f64x2_mul(vc2w, vsnu));
  const v128_t vcw3 = wasm_f64x2_sub(wasm_f64x2_mul(vc2w, vc3n), wasm_f64x2_mul(vs2w, vs3n));
  const v128_t vsw3 = wasm_f64x2_add(wasm_f64x2_mul(vs2w, vc3n), wasm_f64x2_mul(vc2w, vs3n));

  const v128_t v1mth2 = wasm_f64x2_sub(vone, vth2);
  const v128_t v3th2m1 = wasm_f64x2_sub(wasm_f64x2_mul(wasm_f64x2_splat(3.0), vth2), vone);
  const v128_t vc_sum = wasm_f64x2_add(wasm_f64x2_mul(wasm_f64x2_splat(3.0), vc2u),
                                       wasm_f64x2_mul(ve, wasm_f64x2_add(wasm_f64x2_mul(wasm_f64x2_splat(3.0), vcw1), vcw3)));
  const v128_t vdr = wasm_f64x2_mul(
      vc_j2,
      wasm_f64x2_sub(wasm_f64x2_mul(v1mth2, vc2u),
                     wasm_f64x2_mul(wasm_f64x2_add(wasm_f64x2_add(wasm_f64x2_mul(vbeta, vcnu),
                                                                  wasm_f64x2_mul(wasm_f64x2_add(vome, vome), vinv_eta)),
                                                   vone),
                                    v3th2m1)));
  const v128_t vdi = wasm_f64x2_mul(wasm_f64x2_mul(vd_j2, wasm_f64x2_mul(vth, vsi)), vc_sum);
  const v128_t vdnode = wasm_f64x2_mul(
      wasm_f64x2_mul(vd_j2, vth),
      wasm_f64x2_add(wasm_f64x2_sub(wasm_f64x2_mul(wasm_f64x2_splat(3.0), vs2u),
                                    wasm_f64x2_mul(wasm_f64x2_splat(6.0), vQw)),
                     wasm_f64x2_mul(ve, wasm_f64x2_add(wasm_f64x2_mul(wasm_f64x2_splat(3.0), vsw1), vsw3))));
  const v128_t vdu = wasm_f64x2_mul(
      vd_j2,
      wasm_f64x2_add(
          wasm_f64x2_add(
              wasm_f64x2_sub(wasm_f64x2_mul(wasm_f64x2_mul(wasm_f64x2_sub(vone, veta), v3th2m1),
                                            wasm_f64x2_mul(vsnu, wasm_f64x2_add(vbeta, vcnu))),
                             wasm_f64x2_mul(wasm_f64x2_mul(wasm_f64x2_splat(3.0),
                                                           wasm_f64x2_sub(vone, wasm_f64x2_mul(wasm_f64x2_splat(5.0), vth2))),
                                            vQw)),
              wasm_f64x2_mul(wasm_f64x2_mul(wasm_f64x2_splat(0.5),
                                            wasm_f64x2_sub(vone, wasm_f64x2_mul(wasm_f64x2_splat(7.0), vth2))),
                             vs2u)),
          wasm_f64x2_mul(ve, wasm_f64x2_sub(wasm_f64x2_mul(wasm_f64x2_sub(wasm_f64x2_splat(2.0),
                                                                          wasm_f64x2_mul(wasm_f64x2_splat(5.0), vth2)),
                                                           vsw1),
                                            wasm_f64x2_mul(vth2, vsw3)))));

  if (!(std::fabs(wasm_f64x2_extract_lane(vdu, 0)) < 0.02 &&
        std::fabs(wasm_f64x2_extract_lane(vdu, 1)) < 0.02 &&
        std::fabs(wasm_f64x2_extract_lane(vdnode, 0)) < 0.02 &&
        std::fabs(wasm_f64x2_extract_lane(vdnode, 1)) < 0.02 &&
        std::fabs(wasm_f64x2_extract_lane(vdi, 0)) < 0.02 &&
        std::fabs(wasm_f64x2_extract_lane(vdi, 1)) < 0.02))
    return 0;

  const v128_t vaor = vinv_ome;
  const v128_t vaor2 = wasm_f64x2_mul(vaor, vaor);
  const v128_t vna = wasm_f64x2_mul(vn_a, va);
  const v128_t vrdot0 = wasm_f64x2_mul(wasm_f64x2_mul(vna, vesnu), vinv_eta);
  const v128_t vrfdot0 = wasm_f64x2_mul(wasm_f64x2_mul(vna, veta), vaor);
  const v128_t vinv_eta3 = wasm_f64x2_mul(wasm_f64x2_mul(vinv_eta, vinv_eta), vinv_eta);
  const v128_t vdrdot = wasm_f64x2_mul(
      veta,
      wasm_f64x2_add(wasm_f64x2_mul(wasm_f64x2_mul(wasm_f64x2_splat(-2.0), wasm_f64x2_mul(vc_j2, vn_a)),
                                    wasm_f64x2_mul(vaor2, wasm_f64x2_mul(v1mth2, vs2u))),
                     wasm_f64x2_mul(wasm_f64x2_mul(wasm_f64x2_mul(vc_j2, vn_a), wasm_f64x2_mul(vesnu, v3th2m1)),
                                    wasm_f64x2_add(wasm_f64x2_mul(vaor2, vinv_1peta), vinv_eta3))));
  const v128_t vdrfdot = wasm_f64x2_mul(
      veta,
      wasm_f64x2_add(wasm_f64x2_neg(wasm_f64x2_mul(wasm_f64x2_mul(vn_a, vaor2), vdr)),
                     wasm_f64x2_mul(wasm_f64x2_mul(wasm_f64x2_mul(vna, vaor), wasm_f64x2_mul(vd_j2, wasm_f64x2_mul(vsi, vsi))),
                                    vc_sum)));

  // SPEC 16.23: the sigma sets take the nominal's constant radial term, each at its own a and inclination
  const v128_t vdr2 = wasm_f64x2_make(zonal_radius_term(wasm_f64x2_extract_lane(va, 0), wasm_f64x2_extract_lane(vth2, 0)),
                                     zonal_radius_term(wasm_f64x2_extract_lane(va, 1), wasm_f64x2_extract_lane(vth2, 1)));
  const v128_t vrk0 = wasm_f64x2_add(vr, vdr);
  const v128_t vrk_re = wasm_f64x2_mul(wasm_f64x2_add(vrk0, vdr2), wasm_f64x2_splat(kRe));
  const v128_t vvs = wasm_f64x2_splat(kRe / 60.0);
  const v128_t vrdk_vs = wasm_f64x2_mul(wasm_f64x2_add(vrdot0, vdrdot), vvs);
  const v128_t vrf0 = wasm_f64x2_add(vrfdot0, vdrfdot);
  const v128_t vef = wasm_f64x2_make(
      energy_speed_factor(wasm_f64x2_extract_lane(vrk0, 0), wasm_f64x2_extract_lane(vdr2, 0), wasm_f64x2_extract_lane(vrf0, 0)),
      energy_speed_factor(wasm_f64x2_extract_lane(vrk0, 1), wasm_f64x2_extract_lane(vdr2, 1), wasm_f64x2_extract_lane(vrf0, 1)));
  const v128_t vrfdk_vs = wasm_f64x2_mul(wasm_f64x2_mul(vrf0, vef), vvs);

  const v128_t vcu0 = wasm_f64x2_sub(wasm_f64x2_mul(vcw, vcnu), wasm_f64x2_mul(vsw, vsnu));
  const v128_t vsu0 = wasm_f64x2_add(wasm_f64x2_mul(vsw, vcnu), wasm_f64x2_mul(vcw, vsnu));
  const v128_t vdu2 = wasm_f64x2_mul(vdu, vdu);
  const v128_t vdn2 = wasm_f64x2_mul(vdnode, vdnode);
  const v128_t vdi2 = wasm_f64x2_mul(vdi, vdi);
  const v128_t vcdu = wasm_f64x2_sub(vone, wasm_f64x2_mul(vdu2, wasm_f64x2_sub(wasm_f64x2_splat(0.5), wasm_f64x2_mul(vdu2, wasm_f64x2_splat(1.0 / 24.0)))));
  const v128_t vsdu = wasm_f64x2_mul(vdu, wasm_f64x2_sub(vone, wasm_f64x2_mul(vdu2, wasm_f64x2_sub(wasm_f64x2_splat(1.0 / 6.0), wasm_f64x2_mul(vdu2, wasm_f64x2_splat(1.0 / 120.0))))));
  const v128_t vcdn = wasm_f64x2_sub(vone, wasm_f64x2_mul(vdn2, wasm_f64x2_sub(wasm_f64x2_splat(0.5), wasm_f64x2_mul(vdn2, wasm_f64x2_splat(1.0 / 24.0)))));
  const v128_t vsdn = wasm_f64x2_mul(vdnode, wasm_f64x2_sub(vone, wasm_f64x2_mul(vdn2, wasm_f64x2_sub(wasm_f64x2_splat(1.0 / 6.0), wasm_f64x2_mul(vdn2, wasm_f64x2_splat(1.0 / 120.0))))));
  const v128_t vcdi = wasm_f64x2_sub(vone, wasm_f64x2_mul(vdi2, wasm_f64x2_sub(wasm_f64x2_splat(0.5), wasm_f64x2_mul(vdi2, wasm_f64x2_splat(1.0 / 24.0)))));
  const v128_t vsdi = wasm_f64x2_mul(vdi, wasm_f64x2_sub(vone, wasm_f64x2_mul(vdi2, wasm_f64x2_sub(wasm_f64x2_splat(1.0 / 6.0), wasm_f64x2_mul(vdi2, wasm_f64x2_splat(1.0 / 120.0))))));

  const v128_t vcossu = wasm_f64x2_sub(wasm_f64x2_mul(vcu0, vcdu), wasm_f64x2_mul(vsu0, vsdu));
  const v128_t vsinsu = wasm_f64x2_add(wasm_f64x2_mul(vsu0, vcdu), wasm_f64x2_mul(vcu0, vsdu));
  const v128_t vcnod = wasm_f64x2_sub(wasm_f64x2_mul(vcO, vcdn), wasm_f64x2_mul(vsO, vsdn));
  const v128_t vsnod = wasm_f64x2_add(wasm_f64x2_mul(vsO, vcdn), wasm_f64x2_mul(vcO, vsdn));
  const v128_t vcosi = wasm_f64x2_sub(wasm_f64x2_mul(vth, vcdi), wasm_f64x2_mul(vsi, vsdi));
  const v128_t vsini = wasm_f64x2_add(wasm_f64x2_mul(vsi, vcdi), wasm_f64x2_mul(vth, vsdi));

  const v128_t vxmx = wasm_f64x2_neg(wasm_f64x2_mul(vsnod, vcosi));
  const v128_t vxmy = wasm_f64x2_mul(vcnod, vcosi);
  const v128_t vux = wasm_f64x2_add(wasm_f64x2_mul(vxmx, vsinsu), wasm_f64x2_mul(vcnod, vcossu));
  const v128_t vuy = wasm_f64x2_add(wasm_f64x2_mul(vxmy, vsinsu), wasm_f64x2_mul(vsnod, vcossu));
  const v128_t vuz = wasm_f64x2_mul(vsini, vsinsu);
  const v128_t vvx = wasm_f64x2_sub(wasm_f64x2_mul(vxmx, vcossu), wasm_f64x2_mul(vcnod, vsinsu));
  const v128_t vvy = wasm_f64x2_sub(wasm_f64x2_mul(vxmy, vcossu), wasm_f64x2_mul(vsnod, vsinsu));
  const v128_t vvz = wasm_f64x2_mul(vsini, vcossu);

  const v128_t vrx = wasm_f64x2_mul(vrk_re, vux);
  const v128_t vry = wasm_f64x2_mul(vrk_re, vuy);
  const v128_t vrz = wasm_f64x2_mul(vrk_re, vuz);
  const v128_t vvox = wasm_f64x2_add(wasm_f64x2_mul(vrdk_vs, vux), wasm_f64x2_mul(vrfdk_vs, vvx));
  const v128_t vvoy = wasm_f64x2_add(wasm_f64x2_mul(vrdk_vs, vuy), wasm_f64x2_mul(vrfdk_vs, vvy));
  const v128_t vvoz = wasm_f64x2_add(wasm_f64x2_mul(vrdk_vs, vuz), wasm_f64x2_mul(vrfdk_vs, vvz));

  alignas(16) double dr[3] = {
      (wasm_f64x2_extract_lane(vrx, 0) - wasm_f64x2_extract_lane(vrx, 1)) * inv_d,
      (wasm_f64x2_extract_lane(vry, 0) - wasm_f64x2_extract_lane(vry, 1)) * inv_d,
      (wasm_f64x2_extract_lane(vrz, 0) - wasm_f64x2_extract_lane(vrz, 1)) * inv_d,
  };
  alignas(16) double dv[3] = {
      (wasm_f64x2_extract_lane(vvox, 0) - wasm_f64x2_extract_lane(vvox, 1)) * inv_d,
      (wasm_f64x2_extract_lane(vvoy, 0) - wasm_f64x2_extract_lane(vvoy, 1)) * inv_d,
      (wasm_f64x2_extract_lane(vvoz, 0) - wasm_f64x2_extract_lane(vvoz, 1)) * inv_d,
  };
  if (sp.ctx.ap_frame && has_drift) frames::apply_drift(R_drift, dr, dv);
  for (int c = 0; c < 3; ++c) {
    J[c * np + col_j] = dr[c];
    J[(3 + c) * np + col_j] = dv[c];
  }
  return 1;
}
#endif

inline bool xp_propagate_cov_at(XpSat* sats, int np, const int* slot, const bool* central, const double* h,
                                double t, double r[3], double v[3], double* J, int32_t* nom_status = nullptr) {
  XpSat& s0 = sats[0];
  if (!is_ap_ctx(s0.ctx)) {
    const int32_t st0 = xp_propagate(s0, t, r, v);
    if (nom_status != nullptr) *nom_status = st0;
    if (st0 != kPropOk) return false;
    for (int j = 0; j < np; ++j) {
      if (slot[j] < 0) {
        for (int c = 0; c < 6; ++c) J[c * np + j] = 0.0;
        continue;
      }
      double rp[3], vp[3], rm[3], vm[3];
      if (xp_propagate(sats[1 + 2 * slot[j]], t, rp, vp) != kPropOk) return false;
      if (xp_propagate(sats[2 + 2 * slot[j]], t, rm, vm) != kPropOk) return false;
      const double d = central[j] ? 2.0 * h[j] : h[j];
      for (int c = 0; c < 3; ++c) {
        J[c * np + j] = (rp[c] - rm[c]) / d;
        J[(3 + c) * np + j] = (vp[c] - vm[c]) / d;
      }
    }
    return true;
  }
  if (s0.init_error != 0) {
    if (nom_status != nullptr) *nom_status = kPropRefused;
    return false;
  }
  double ym0[6];
  if (!mean_at_local(s0, t, ym0)) {
    if (nom_status != nullptr) *nom_status = kPropMeanMotion;
    return false;
  }
  const Bodies shared = s0.ctx.ap_third_body ? bodies_at_ap(s0.ctx.d50_epoch + t / kMinutesPerDay)
                                             : bodies_at(s0.ctx.d50_epoch + t / kMinutesPerDay);
  const bool can_share_3b = (t != 0.0) && !s0.ctx.long_period && s0.ctx.ap_third_body;
  const bool can_share_sp = (t != 0.0) && (s0.ctx.mdaily != nullptr || s0.ctx.sp_comb != nullptr || s0.ctx.wide != nullptr);
  const bool can_share_srp = (t != 0.0) && s0.ctx.agom > 0.0;
  double d_3b0[6] = {0, 0, 0, 0, 0, 0}, dd_3b_dlam[6] = {0, 0, 0, 0, 0, 0};
  double d_sp0[6] = {0, 0, 0, 0, 0, 0}, dd_sp_dlam[6] = {0, 0, 0, 0, 0, 0}, d2_sp_dlam2[6] = {0, 0, 0, 0, 0, 0};
  double d_srp_unit0[6] = {0, 0, 0, 0, 0, 0};
  double E0_osc = std::numeric_limits<double>::quiet_NaN(), sE0_osc = 0.0, cE0_osc = 1.0;
  double lam0_ref = std::numeric_limits<double>::quiet_NaN(), sLam0_ref = 0.0, cLam0_ref = 1.0;
  CovNomOsc nom_osc{};
  double* const pE0 = s0.ctx.ap_third_body ? &E0_osc : nullptr;
  double* const psE0 = s0.ctx.ap_third_body ? &sE0_osc : nullptr;
  double* const pcE0 = s0.ctx.ap_third_body ? &cE0_osc : nullptr;
  double* const plam0 = s0.ctx.ap_third_body ? &lam0_ref : nullptr;
  double* const psLam0 = s0.ctx.ap_third_body ? &sLam0_ref : nullptr;
  double* const pcLam0 = s0.ctx.ap_third_body ? &cLam0_ref : nullptr;
  CovNomOsc* const pNomOsc = s0.ctx.ap_third_body ? &nom_osc : nullptr;
  int32_t st0;
  if (s0.ctx.wide != nullptr && s0.ctx.wide_owned) {
    const double x = t / tess::kGridEvery;
    const int jn = t >= 0.0 ? static_cast<int>(std::floor(x)) : static_cast<int>(std::ceil(x));
    const int next = t >= 0.0 ? jn + 1 : jn - 1;
    const double u = std::fabs(x - jn);
    const double blend = u < 1.0 - tess::kGridBlend ? 0.0 : (u - (1.0 - tess::kGridBlend)) / tess::kGridBlend;
    tess::WideGrid* g0 = nullptr;
    tess::WideGrid* g1 = nullptr;
    bool h0 = false, h1 = false;
    double blend_use = blend;
    bool nodes_ok = wide_node(s0, jn, g0, h0);
    if (nodes_ok && blend_use > 0.0 && !wide_node(s0, next, g1, h1)) {
      double tc = 0.0;  // SPEC 16.25, as xp_propagate_impl: the next node past the crossing, the state from this node's grid alone
      XpSat& owner = s0.ctx.wide_anchor != nullptr ? *s0.ctx.wide_anchor : s0;  // the set that owns the grid
      if (is_ap_ctx(s0.ctx) && decay_crossing(owner, next * tess::kGridEvery, tc)) { g1 = nullptr; blend_use = 0.0; }
      else nodes_ok = false;
    }
    if (!nodes_ok) {
      if (h0) tess::wide_grid_drop(g0);
      if (nom_status != nullptr) *nom_status = kPropRefused;
      return false;
    }
    RateContext c = s0.ctx;
    c.wide = g0;
    c.wide_next = g1;
    c.wide_blend = blend_use;
    st0 = output(c, t, ym0, r, v, &shared, can_share_3b ? d_3b0 : nullptr, can_share_3b ? dd_3b_dlam : nullptr,
                 can_share_sp ? d_sp0 : nullptr, can_share_sp ? dd_sp_dlam : nullptr,
                 nullptr, nullptr, nullptr, nullptr, 0.0,
                 can_share_sp ? d2_sp_dlam2 : nullptr, nullptr,
                 can_share_srp ? d_srp_unit0 : nullptr, nullptr,
                 pE0, psE0, pcE0, std::numeric_limits<double>::quiet_NaN(), 0.0, 1.0,
                 plam0, psLam0, pcLam0, std::numeric_limits<double>::quiet_NaN(), 0.0, 1.0, pNomOsc);
    if (h0) tess::wide_grid_drop(g0);
    if (h1) tess::wide_grid_drop(g1);
  } else {
    st0 = output(s0.ctx, t, ym0, r, v, &shared, can_share_3b ? d_3b0 : nullptr, can_share_3b ? dd_3b_dlam : nullptr,
                 can_share_sp ? d_sp0 : nullptr, can_share_sp ? dd_sp_dlam : nullptr,
                 nullptr, nullptr, nullptr, nullptr, 0.0,
                 can_share_sp ? d2_sp_dlam2 : nullptr, nullptr,
                 can_share_srp ? d_srp_unit0 : nullptr, nullptr,
                 pE0, psE0, pcE0, std::numeric_limits<double>::quiet_NaN(), 0.0, 1.0,
                 plam0, psLam0, pcLam0, std::numeric_limits<double>::quiet_NaN(), 0.0, 1.0, pNomOsc);
  }
  if (nom_status != nullptr) *nom_status = st0;
  if (st0 != kPropOk) return false;
  double R_drift[3][3];
  const bool has_drift = s0.ctx.ap_frame && frames::teme_drift_matrix(s0.epoch_jd_whole, s0.epoch_jd_frac, t, R_drift);
  if (has_drift) frames::apply_drift(R_drift, r, v);

  auto eval_sigma = [&](XpSat& ss, int param_idx, double rs[3], double vs[3]) -> bool {
    (void)param_idx;
    if (ss.init_error != 0) return false;
    double yms[6];
    if (!mean_at_local(ss, t, yms)) return false;
    const bool same_cls = ss.ctx.long_period == s0.ctx.long_period && ss.ctx.resonance == s0.ctx.resonance &&
                          (ss.ctx.wide == nullptr || ss.ctx.wide_anchor == &s0);
    const bool small_plane_diff =
        (s0.ctx.i0 > 0.02) &&
        (std::fabs(yms[kChi] - ym0[kChi]) + std::fabs(yms[kPsi] - ym0[kPsi])) < 0.005 * s0.ctx.i0;
    const double dlam = yms[kLam] - ym0[kLam];
    const bool share_3b = can_share_3b && same_cls;
    const bool share_sp = can_share_sp && same_cls && small_plane_diff && (std::fabs(dlam) < 0.15);
    const bool share_srp = can_share_srp && same_cls && small_plane_diff;
    if (share_3b || share_sp || share_srp) {
      if (output(ss.ctx, t, yms, rs, vs, &shared, nullptr, nullptr, nullptr, nullptr,
                 share_3b ? d_3b0 : nullptr, share_3b ? dd_3b_dlam : nullptr,
                 share_sp ? d_sp0 : nullptr, share_sp ? dd_sp_dlam : nullptr,
                 dlam, nullptr, share_sp ? d2_sp_dlam2 : nullptr,
                 nullptr, share_srp ? d_srp_unit0 : nullptr,
                 nullptr, nullptr, nullptr, E0_osc, sE0_osc, cE0_osc,
                 nullptr, nullptr, nullptr, lam0_ref, sLam0_ref, cLam0_ref) != kPropOk)
        return false;
      if (ss.ctx.ap_frame && has_drift) frames::apply_drift(R_drift, rs, vs);
      return true;
    }
    return xp_propagate_local(ss, t, rs, vs, &shared) == kPropOk;
  };

  const double e0_ym = std::sqrt(ym0[kAf] * ym0[kAf] + ym0[kAg] * ym0[kAg]);
  const bool zero_drag_orbit =
      !s0.ctx.drag_pass && s0.ctx.ap_third_body &&
      s0.ctx.a0 * (1.0 - s0.ctx.e0) > 1.50 &&
      (nom_osc.valid ? nom_osc.a0 : s0.ctx.a0) * (1.0 - e0_ym) > 1.48 &&
      std::fabs(s0.ctx.bterm) < 10.0;

  for (int j = 0; j < np; ++j) {
    if (slot[j] < 0) {
      for (int c = 0; c < 6; ++c) J[c * np + j] = 0.0;
      continue;
    }
    XpSat& sp_sat = sats[1 + 2 * slot[j]];
    if (zero_drag_orbit && (sp_sat.ctx.is_cov_sigma & 64) != 0 &&
        !sp_sat.ctx.drag_pass && std::fabs(sp_sat.ctx.bterm) < 10.0 &&
        (!central[j] || ((sats[2 + 2 * slot[j]].ctx.is_cov_sigma & 64) != 0 &&
                         !sats[2 + 2 * slot[j]].ctx.drag_pass &&
                         std::fabs(sats[2 + 2 * slot[j]].ctx.bterm) < 10.0))) {
      for (int c = 0; c < 6; ++c) J[c * np + j] = 0.0;
      continue;
    }
    const double d = central[j] ? 2.0 * h[j] : h[j];
    const double inv_d = 1.0 / d;
#ifdef __wasm_simd128__
    if (central[j]) {
      const int fast_rc = eval_cov_pair_j2_fast(
          s0, sp_sat, sats[2 + 2 * slot[j]], t, ym0, nom_osc,
          can_share_3b, can_share_sp, can_share_srp,
          d_3b0, dd_3b_dlam, d_sp0, dd_sp_dlam, d2_sp_dlam2, d_srp_unit0,
          has_drift, R_drift, inv_d, J, np, j);
      if (fast_rc > 0) continue;
      if (fast_rc < 0) return false;
    }
#endif
    double rp[3], vp[3], rm[3], vm[3];
    if (!eval_sigma(sp_sat, j, rp, vp)) return false;
    if (central[j]) {
      if (!eval_sigma(sats[2 + 2 * slot[j]], j, rm, vm)) return false;
    } else {
      for (int c = 0; c < 3; ++c) { rm[c] = r[c]; vm[c] = v[c]; }
    }
    for (int c = 0; c < 3; ++c) {
      J[c * np + j] = (rp[c] - rm[c]) * inv_d;
      J[(3 + c) * np + j] = (vp[c] - vm[c]) * inv_d;
    }
  }
  return true;
}

}  // namespace xpt
}  // namespace sdnap
