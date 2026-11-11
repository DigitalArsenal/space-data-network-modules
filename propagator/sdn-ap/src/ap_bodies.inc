// -----------------------------------------------------------------------------
// AP's Sun and Moon (SPEC 16.15). SGP4XP keeps SPEC 5's series (bodies_at, sun_at) bit for bit; every AP path reads
// these. The series are a least-squares fit to DE440 (tools/ap-bodies-fit.mjs; the coefficients in
// ap_bodies_series.inc): the Moon's longitude, latitude and distance, and the Earth-Moon barycenter's Sun, referred to
// the mean ecliptic and equinox of date, as trigonometric series in the Delaunay arguments and the planetary mean
// longitudes of the IERS Conventions (2010) eq. 5.43 and 5.44 (Simon et al. 1994), at TT. The geocentric Sun is the
// barycenter's plus the Earth's offset from the barycenter, mu_M / (mu_E + mu_M) times the Moon (DE440's masses). Both
// are carried to TEME of date: the mean obliquity of IAU 2006, the fourteen largest luni-solar terms of IAU 2000B's
// nutation (McCarthy and Luzum 2003; the IERS Conventions (2010) Table 5.3a), and the equation of the equinoxes.
// The time argument is TT from UTC through ERFA's leap-second table (frames::utc_to_tt, gcrf.inc).
// -----------------------------------------------------------------------------

/// A series argument: the sum of m[q] times fundamental argument k[q] over q < n.
struct ApbArg {
  uint8_t n;
  uint8_t k[5];
  int8_t m[5];
};
/// One coefficient record: coordinate `coord` += (s + tau ts) sin(arg) + (c + tau tc) cos(arg), tau = T - kApbTc.
/// Coordinates: 0 the Moon's longitude from F + Omega (arcsec), 1 its latitude (arcsec), 2 its distance (km); 3 the
/// barycenter's Sun's longitude from F - D + Omega (arcsec), 4 its latitude (arcsec), 5 its distance (km).
struct ApbCoef {
  uint16_t arg;
  uint8_t coord;
  double s, c, ts, tc;
};

#include "ap_bodies_series.inc"

/// The fundamental arguments (radians) at T Julian centuries TT from J2000, in the order of the series: D, l, l', F,
/// Omega (IERS 2010 eq. 5.43, arcsec polynomials), the mean longitudes of Venus, the Earth, Mars, Jupiter and Saturn
/// (eq. 5.44), and Meeus's (1998, ch. 47) A2 and A3.
inline void apb_fundamentals(double T, double* f) {
  auto as = [](double x) { return std::fmod(x, 1296000.0) * kArcsec; };
  f[0] = as(1072260.703692 + T * (1602961601.2090 + T * (-6.3706 + T * (0.006593 + T * (-0.00003169)))));
  f[1] = as(485868.249036 + T * (1717915923.2178 + T * (31.8792 + T * (0.051635 + T * (-0.00024470)))));
  f[2] = as(1287104.793048 + T * (129596581.0481 + T * (-0.5532 + T * (0.000136 + T * (-0.00001149)))));
  f[3] = as(335779.526232 + T * (1739527262.8478 + T * (-12.7512 + T * (-0.001037 + T * (0.00000417)))));
  f[4] = as(450160.398036 + T * (-6962890.5431 + T * (7.4722 + T * (0.007702 + T * (-0.00005939)))));
  f[5] = std::fmod(3.176146697 + 1021.3285546211 * T, kTwoPi);
  f[6] = std::fmod(1.753470314 + 628.3075849991 * T, kTwoPi);
  f[7] = std::fmod(6.203480913 + 334.0612426700 * T, kTwoPi);
  f[8] = std::fmod(0.599546497 + 52.9690962641 * T, kTwoPi);
  f[9] = std::fmod(0.874016757 + 21.3299104960 * T, kTwoPi);
  f[10] = std::fmod(53.09 + 479264.290 * T, 360.0) * kDeg;
  f[11] = std::fmod(313.45 + 481266.484 * T, 360.0) * kDeg;
}

/// The Sun and Moon of AP at d50 (days from 1950 January 0.0 UTC): unit vectors in TEME of date and distances (ER).
inline Bodies ap_bodies_at(double d50) {
  const double fd = std::floor(d50);
  double tt1, tt2;
  frames::utc_to_tt(sdnap::kJd1950 + fd, d50 - fd, tt1, tt2);
  const double T = ((tt1 - 2451545.0) + tt2) / 36525.0, tau = T - kApbTc;
  double f[kApbFund];
  apb_fundamentals(T, f);
  // e^{i j f_k}, j = 0 .. kApbMaxMult
  Cx P[kApbFund][kApbMaxMult + 1];
  for (int k = 0; k < kApbFund; ++k) {
    P[k][0] = {1.0, 0.0};
    fm::sincos(f[k], P[k][1].s, P[k][1].c);
    for (int j = 2; j <= kApbMaxMultOf[k]; ++j) P[k][j] = cmul(P[k][j - 1], P[k][1]);
  }
  auto pw = [&](int k, int m) { const Cx p = P[k][m < 0 ? -m : m]; return m < 0 ? Cx{p.c, -p.s} : p; };
  double S[kApbArgs], C[kApbArgs];
  for (int a = 0; a < kApbArgs; ++a) {
    const ApbArg& g = kApbArg[a];
    Cx z = pw(g.k[0], g.m[0]);
    for (int q = 1; q < g.n; ++q) z = cmul(z, pw(g.k[q], g.m[q]));
    S[a] = z.s;
    C[a] = z.c;
  }
  double acc[6];
  for (int c = 0; c < 6; ++c) acc[c] = kApbPoly[c][0] + tau * (kApbPoly[c][1] + tau * kApbPoly[c][2]);
  for (int r = 0; r < kApbCoefs; ++r) {
    const ApbCoef& q = kApbCoef[r];
    acc[q.coord] += (q.s + tau * q.ts) * S[q.arg] + (q.c + tau * q.tc) * C[q.arg];
  }
  // the mean ecliptic of date: Moon and barycenter's Sun; the Earth's Sun adds the Earth -> barycenter offset
  constexpr double kMuRatio = 4902.800118 / (398600.435507 + 4902.800118);  // DE440 GM of the Moon / (Earth + Moon)
  auto ecl = [](double lon, double lat, double r, Vec3& out) {
    double sl, cl, sb, cb;
    fm::sincos(lon, sl, cl);
    fm::sincos(lat, sb, cb);
    out = {r * cb * cl, r * cb * sl, r * sb};
  };
  Vec3 moon, sun;
  ecl(f[3] + f[4] + acc[0] * kArcsec, acc[1] * kArcsec, acc[2], moon);
  ecl(f[3] - f[0] + f[4] + acc[3] * kArcsec, acc[4] * kArcsec, acc[5], sun);
  sun = sun + kMuRatio * moon;
  // nutation: multipliers of (l, l', F, D, Omega); dpsi = (A + A1 T) sin + A2 cos, deps = (B + B1 T) cos + B2 sin, arcsec
  struct Nut { int8_t m[5]; double a, a1, a2, b, b1, b2; };
  static constexpr Nut kNut[14] = {
      {{0, 0, 0, 0, 1}, -17.2064161, -0.0174666, 0.0033386, 9.2052331, 0.0009086, 0.0015377},
      {{0, 0, 2, -2, 2}, -1.3170906, -0.0001675, -0.0013696, 0.5730336, -0.0003015, -0.0004587},
      {{0, 0, 2, 0, 2}, -0.2276413, -0.0000234, 0.0002796, 0.0978459, -0.0000485, 0.0001374},
      {{0, 0, 0, 0, 2}, 0.2074554, 0.0000207, -0.0000698, -0.0897492, 0.0000470, -0.0000291},
      {{0, 1, 0, 0, 0}, 0.1475877, -0.0003633, 0.0011817, 0.0073871, -0.0000184, -0.0001924},
      {{0, 1, 2, -2, 2}, -0.0516821, 0.0001226, -0.0000524, 0.0224386, -0.0000677, -0.0000174},
      {{1, 0, 0, 0, 0}, 0.0711159, 0.0000073, -0.0000872, -0.0006750, 0.0, 0.0000358},
      {{0, 0, 2, 0, 1}, -0.0387298, -0.0000367, 0.0000380, 0.0200728, 0.0000018, 0.0000318},
      {{1, 0, 2, 0, 2}, -0.0301461, -0.0000036, 0.0000816, 0.0129025, -0.0000063, 0.0000367},
      {{0, -1, 2, -2, 2}, 0.0215829, -0.0000494, 0.0000111, -0.0095929, 0.0000299, 0.0000132},
      {{0, 0, 2, -2, 1}, 0.0128227, 0.0000137, 0.0000181, -0.0068982, -0.0000009, 0.0000039},
      {{-1, 0, 2, 0, 2}, 0.0123457, 0.0000011, 0.0000019, -0.0053311, 0.0000032, -0.0000004},
      {{-1, 0, 0, 2, 0}, 0.0156994, 0.0000010, -0.0000168, -0.0001235, 0.0, 0.0000082},
      {{1, 0, 0, 0, 1}, 0.0063110, 0.0000063, 0.0000027, -0.0033228, 0.0, -0.0000009},
  };
  static constexpr int kDel[5] = {1, 2, 3, 0, 4};  // l, l', F, D, Omega in the series' order
  double dpsi = 0.0, deps = 0.0;
  for (const Nut& n : kNut) {
    Cx z = {1.0, 0.0};
    for (int q = 0; q < 5; ++q)
      if (n.m[q] != 0) z = cmul(z, pw(kDel[q], n.m[q]));
    dpsi += (n.a + n.a1 * T) * z.s + n.a2 * z.c;
    deps += (n.b + n.b1 * T) * z.c + n.b2 * z.s;
  }
  dpsi *= kArcsec;
  deps *= kArcsec;
  const double eps_a = (84381.406 + T * (-46.836769 + T * (-0.0001831 + T * (0.00200340 + T * (-0.000000576 - 0.0000000434 * T))))) * kArcsec;
  double sp, cp, se, ce, sa, ca, sq, cq;
  fm::sincos(dpsi, sp, cp);
  fm::sincos(eps_a + deps, se, ce);
  fm::sincos(eps_a, sa, ca);
  fm::sincos(dpsi * ca, sq, cq);  // the equation of the equinoxes
  auto teme = [&](Vec3 v) {
    const double x0 = cp * v.x - sp * v.y, y0 = sp * v.x + cp * v.y;  // true longitude: + dpsi
    const double y1 = ce * y0 - se * v.z, z1 = se * y0 + ce * v.z;      // true equator: true obliquity
    return Vec3{cq * x0 + sq * y1, -sq * x0 + cq * y1, z1};             // TEME: right ascension less the equation
  };
  Bodies b{};
  const Vec3 mt = teme(moon), st = teme(sun);
  const double mr = norm(mt), sr = norm(st);
  b.moon_r = mr / kRe;
  b.moon_u = (1.0 / mr) * mt;
  b.sun_r = sr / kRe;
  b.sun_u = (1.0 / sr) * st;
  return b;
}
