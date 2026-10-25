// -----------------------------------------------------------------------------
// foundation/sgp4-str3 (compiled by propagator/sdn-ap and analysis/od), part 1 of
// 2: the deep-space subroutine and the function subroutines of Spacetrack
// Report No. 3.
//
// Written clean room (task modules-sdn-ap-sgp4-from-str3-20261024) from:
//   - Hoots & Roehrich (1980), Spacetrack Report No. 3, "Models for Propagation
//     of NORAD Element Sets" (US Air Force, approved for public release; its
//     FORTRAN IV listing is a US Government work): section 10, the subroutine
//     DEEP (pp. 58-68), and section 11, ACTAN, FMOD2P and THETAG (pp. 73-75);
//   - Vallado, Crawford, Hujsak & Kelso (2006), "Revisiting Spacetrack Report
//     #3", AIAA 2006-6753 Rev 3: the text of the corrections it documents
//     (sections II.F, III, VI and Appendices D and E);
//   - SPEC.md 1.2: the 1970-referenced sidereal angle and the Earth rate.
// Structure (STR#3's): DEEP with its three entries DPINIT, DPSEC and DPPER,
// here deep_init, deep_secular and deep_periodics over one Deep record (the
// FORTRAN's saved locals). DEEP's statement-20 block, which the listing runs
// for the Sun and then the Moon, is body_terms; its "DOT TERMS CALCULATED" and
// "INTEGRATOR" blocks are resonance_rates and resonance_step. Variables carry
// STR#3's FORTRAN names in lower case. Each departure from the 1980 listing
// names its source.
// -----------------------------------------------------------------------------

namespace sdnap {

/// The two operating modes of AIAA 2006-6753 Rev 3: AFSPC compatibility (the
/// module's mode; Appendix E's results are run in it) and the paper's
/// improved mode. They differ in the sidereal angle at epoch (section II.F)
/// and in the reductions of DPPER's node (section III).
enum class Sgp4Mode : uint8_t { kAfspc = 0, kImproved = 1 };

/// A Julian date as the store holds epochs: the integer + 0.5 part and the
/// fraction of a day (both exact).
inline void split_jd(double jd, double& whole, double& frac) {
  whole = std::floor(jd - 0.5) + 0.5;
  frac = jd - whole;
}

/// Greenwich at epoch, radians in [0, 2 pi), AFSPC mode (STR#3's THETAG with
/// the 1970 January 0.0 series AIAA 2006-6753 II.F prints, SPEC.md 1.2):
/// d = d50 - 7305 days since 1970 January 0.0, d_i its whole days (toward
/// zero) and d_f the rest; theta = THGR70 + C1 d_i + (C1 + 2 pi) d_f + FK5R d^2.
inline double gsto_afspc(double d50) {
  constexpr double kC1 = 1.72027916940703639e-2;     // rad/day
  constexpr double kThgr70 = 1.7321343856509374;      // rad
  constexpr double kFk5r = 5.07551419432269442e-15;   // rad/day^2
  const double ts70 = d50 - 7305.0;
  const double ds70 = std::trunc(ts70);
  const double tfrac = ts70 - ds70;
  const double c1p2p = kC1 + kTwoPi;
  double thgr = std::fmod(kThgr70 + kC1 * ds70 + c1p2p * tfrac + ts70 * ts70 * kFk5r, kTwoPi);
  if (thgr < 0.0) thgr += kTwoPi;
  return thgr;
}

namespace str3 {

/// Greenwich at epoch, improved mode: IAU 1982 mean sidereal time, AIAA
/// 2006-6753 II.F Eq. (2), in seconds of time at UT1 (taken as UTC), then
/// radians in [0, 2 pi).
inline double gmst_iau82(double jd_whole, double jd_frac) {
  const double tut1 = ((jd_whole - 2451545.0) + jd_frac) / 36525.0;
  const double seconds = 67310.54841 + (876600.0 * 3600.0 + 8640184.812866) * tut1 + 0.093104 * tut1 * tut1 -
                         6.2e-6 * tut1 * tut1 * tut1;
  double theta = std::fmod(seconds * (kTwoPi / 86400.0), kTwoPi);
  if (theta < 0.0) theta += kTwoPi;
  return theta;
}

/// STR#3's FMOD2P (p. 74): an angle reduced to [0, 2 pi), by the intrinsic MOD
/// (AIAA 2006-6753 III: intrinsic functions replace the user-written routines).
inline double fmod2p(double x) {
  double r = std::fmod(x, kTwoPi);
  if (r < 0.0) r += kTwoPi;
  return r;
}

// DEEP's DATA statements (STR#3 p. 59), in double precision (AIAA 2006-6753 III).
constexpr double kZns = 1.19459e-5, kC1ss = 2.9864797e-6, kZes = 0.01675;
constexpr double kZnl = 1.5835218e-4, kC1l = 4.7968065e-7, kZel = 0.05490;
constexpr double kZcosis = 0.91744867, kZsinis = 0.39785416, kZsings = -0.98088458, kZcosgs = 0.1945905;
constexpr double kQ22 = 1.7891679e-6, kQ31 = 2.1460748e-6, kQ33 = 2.2123015e-7;
constexpr double kG22 = 5.7686396, kG32 = 0.95240898, kG44 = 1.8014998, kG52 = 1.0508330, kG54 = 4.4108898;
constexpr double kRoot22 = 1.7891679e-6, kRoot32 = 3.7393792e-7, kRoot44 = 7.3636953e-9;
constexpr double kRoot52 = 1.1428639e-7, kRoot54 = 2.1765803e-9;
/// THDT, the Earth's rotation in rad/min: STR#3's 4.3752691E-3 to the precision
/// of SPEC.md 1.2 (AIAA 2006-6753 VI.B: RPTIM 0.004 375 269 088 02).
constexpr double kThdt = 4.37526908801129966e-3;
// Synchronous resonance phases (STR#3 p. 64).
constexpr double kFasx2 = 0.13130908, kFasx4 = 2.8843198, kFasx6 = 0.37448087;
// The integrator (STR#3 p. 64): steps of 720 minutes, STEP2 = 720^2 / 2.
constexpr double kStepp = 720.0, kStepn = -720.0, kStep2 = 259200.0;
// Inclination limits: SH dropped below 3 degrees (STR#3 p. 61) and, in the
// improved mode, within 3 degrees of 180 as well (AIAA 2006-6753 VI.A); the
// AFSPC mode keeps SH there, as the operational library does (black box: from
// 177 to 179.9999 degrees it reproduces the reference within 1e-6 m, against
// 1.6 to 13 km with the term dropped). The Lyddane modification below 0.2 rad
// (STR#3 p. 67).
constexpr double kShInclination = 5.2359877e-2, kLyddaneInclination = 0.2;

/// One body's lunar-solar periodic coefficients: the Sun's SE2, SE3, SI2, SI3,
/// SL2, SL3, SL4, SGH2, SGH3, SGH4, SH2, SH3, or the Moon's EE2, E3, XI2, XI3,
/// XL2, XL3, XL4, XGH2, XGH3, XGH4, XH2, XH3 (STR#3 pp. 61-62).
struct BodyPeriodics {
  double e2, e3, i2, i3, l2, l3, l4, gh2, gh3, gh4, h2, h3;
};

/// What one pass of DEEP's statement-20 block yields: the body's secular rates
/// SE, SI, SL, SGH and SH and its periodic coefficients.
struct BodyTerms {
  double se, si, sl, sgh, sh;
  BodyPeriodics p;
};

/// DPINIT's arguments (STR#3 p. 59: EQSQ, SINIQ, COSIQ, RTEQSQ, AO, COSQ2,
/// SINOMO, COSOMO, BSQ, XLLDOT, OMGDT, XNODOT, XNODP) and what DEEP reads of
/// COMMON E1: the epoch (as split Julian date and DS50) and the elements.
struct DeepArgs {
  double jd_whole, jd_frac, ds50;
  double eo, xincl, xnodeo, omegao, xmo;
  double eqsq, siniq, cosiq, rteqsq, ao, cosq2, sinomo, cosomo, bsq, xlldot, omgdt, xnodot, xnodp;
};

/// DEEP's saved quantities, from DPINIT on.
struct Deep {
  BodyPeriodics sun, moon;
  double zmos, zmol;               ///< the Sun's and the Moon's mean anomalies at epoch
  double sse, ssi, ssl, ssg, ssh;  ///< lunar-solar secular rates of e, i, M, omega and Omega
  double thgr;                     ///< Greenwich at epoch
  double siniq, cosiq;             ///< the epoch inclination's sine and cosine
  // resonance (STR#3 pp. 62-64)
  double xlamo;                    ///< the resonance angle at epoch
  double xfact;                    ///< its rate less the mean motion
  double xnq;                      ///< the mean motion at epoch (XNODP)
  double omegaq, omgdt;            ///< perigee at epoch and its secular rate
  double d[10];                    ///< 12 h: D2201 D2211 D3210 D3222 D4410 D4422 D5220 D5232 D5421 D5433; 24 h: DEL1..DEL3
  uint8_t iresfl;                  ///< resonant (STR#3 IRESFL)
  uint8_t isynfl;                  ///< synchronous, else twelve-hour (STR#3 ISYNFL)
};

/// DEEP's statement-20 block for one body (STR#3 pp. 60-61). zcosg .. zsinh
/// place the body's orbit against the satellite's, cc is its strength, zn its
/// mean motion and ze its eccentricity; xnoi = 1 / XNQ.
inline BodyTerms body_terms(const DeepArgs& g, Sgp4Mode mode, double xnoi, double zcosg, double zsing, double zcosi, double zsini,
                            double zcosh, double zsinh, double cc, double zn, double ze) {
  const double eq = g.eo, eqsq = g.eqsq, bsq = g.bsq, rteqsq = g.rteqsq;
  const double siniq = g.siniq, cosiq = g.cosiq, sinomo = g.sinomo, cosomo = g.cosomo;
  const double a1 = zcosg * zcosh + zsing * zcosi * zsinh;
  const double a3 = -zsing * zcosh + zcosg * zcosi * zsinh;
  const double a7 = -zcosg * zsinh + zsing * zcosi * zcosh;
  const double a8 = zsing * zsini;
  const double a9 = zsing * zsinh + zcosg * zcosi * zcosh;
  const double a10 = zcosg * zsini;
  const double a2 = cosiq * a7 + siniq * a8;
  const double a4 = cosiq * a9 + siniq * a10;
  const double a5 = -siniq * a7 + cosiq * a8;
  const double a6 = -siniq * a9 + cosiq * a10;
  const double x1 = a1 * cosomo + a2 * sinomo;
  const double x2 = a3 * cosomo + a4 * sinomo;
  const double x3 = -a1 * sinomo + a2 * cosomo;
  const double x4 = -a3 * sinomo + a4 * cosomo;
  const double x5 = a5 * sinomo;
  const double x6 = a6 * sinomo;
  const double x7 = a5 * cosomo;
  const double x8 = a6 * cosomo;
  const double z31 = 12.0 * x1 * x1 - 3.0 * x3 * x3;
  const double z32 = 24.0 * x1 * x2 - 6.0 * x3 * x4;
  const double z33 = 12.0 * x2 * x2 - 3.0 * x4 * x4;
  double z1 = 3.0 * (a1 * a1 + a2 * a2) + z31 * eqsq;
  double z2 = 6.0 * (a1 * a3 + a2 * a4) + z32 * eqsq;
  double z3 = 3.0 * (a3 * a3 + a4 * a4) + z33 * eqsq;
  const double z11 = -6.0 * a1 * a5 + eqsq * (-24.0 * x1 * x7 - 6.0 * x3 * x5);
  const double z12 = -6.0 * (a1 * a6 + a3 * a5) + eqsq * (-24.0 * (x2 * x7 + x1 * x8) - 6.0 * (x3 * x6 + x4 * x5));
  const double z13 = -6.0 * a3 * a6 + eqsq * (-24.0 * x2 * x8 - 6.0 * x4 * x6);
  const double z21 = 6.0 * a2 * a5 + eqsq * (24.0 * x1 * x5 - 6.0 * x3 * x7);
  const double z22 = 6.0 * (a4 * a5 + a2 * a6) + eqsq * (24.0 * (x2 * x5 + x1 * x6) - 6.0 * (x4 * x7 + x3 * x8));
  const double z23 = 6.0 * a4 * a6 + eqsq * (24.0 * x2 * x6 - 6.0 * x4 * x8);
  z1 = z1 + z1 + bsq * z31;
  z2 = z2 + z2 + bsq * z32;
  z3 = z3 + z3 + bsq * z33;
  const double s3 = cc * xnoi;
  const double s2 = -0.5 * s3 / rteqsq;
  const double s4 = s3 * rteqsq;
  const double s1 = -15.0 * eq * s4;
  const double s5 = x1 * x3 + x2 * x4;
  const double s6 = x2 * x3 + x1 * x4;
  const double s7 = x2 * x4 - x1 * x3;
  BodyTerms b;
  b.se = s1 * zn * s5;
  b.si = s2 * zn * (z11 + z13);
  b.sl = -zn * s3 * (z1 + z3 - 14.0 - 6.0 * eqsq);
  b.sgh = s4 * zn * (z31 + z33 - 6.0);
  b.sh = -zn * s2 * (z21 + z23);
  if (g.xincl < kShInclination || (mode == Sgp4Mode::kImproved && g.xincl > kPi - kShInclination)) b.sh = 0.0;
  b.p.e2 = 2.0 * s1 * s6;
  b.p.e3 = 2.0 * s1 * s7;
  b.p.i2 = 2.0 * s2 * z12;
  b.p.i3 = 2.0 * s2 * (z13 - z11);
  b.p.l2 = -2.0 * s3 * z2;
  b.p.l3 = -2.0 * s3 * (z3 - z1);
  b.p.l4 = -2.0 * s3 * (-21.0 - 9.0 * eqsq) * ze;
  b.p.gh2 = 2.0 * s4 * z32;
  b.p.gh3 = 2.0 * s4 * (z33 - z31);
  b.p.gh4 = -18.0 * s4 * ze;
  b.p.h2 = -2.0 * s2 * z22;
  b.p.h3 = -2.0 * s2 * (z23 - z21);
  return b;
}

/// DPINIT (STR#3 pp. 59-64): Greenwich and the Sun and Moon at epoch, the
/// lunar-solar secular rates and periodic coefficients, and the resonance
/// terms of 24-hour and 12-hour orbits.
inline void deep_init(Deep& d, const DeepArgs& g, Sgp4Mode mode) {
  d = Deep{};
  d.thgr = mode == Sgp4Mode::kAfspc ? gsto_afspc(g.ds50) : gmst_iau82(g.jd_whole, g.jd_frac);
  d.siniq = g.siniq;
  d.cosiq = g.cosiq;
  const double eq = g.eo;
  d.xnq = g.xnodp;
  const double aqnv = 1.0 / g.ao;
  d.omegaq = g.omegao;
  d.omgdt = g.omgdt;
  const double xpidot = g.omgdt + g.xnodot;
  const double sinq = std::sin(g.xnodeo);
  const double cosq = std::cos(g.xnodeo);

  // INITIALIZE LUNAR SOLAR TERMS (statement 5): the Moon's node, inclination and
  // argument, the Sun's and Moon's mean anomalies, at DAY days from 1900 January 0.5
  const double day = g.ds50 + 18261.5;
  const double xnodce = 4.5236020 - 9.2422029e-4 * day;
  const double stem = std::sin(xnodce);
  const double ctem = std::cos(xnodce);
  const double zcosil = 0.91375164 - 0.03568096 * ctem;
  const double zsinil = std::sqrt(1.0 - zcosil * zcosil);
  const double zsinhl = 0.089683511 * stem / zsinil;
  const double zcoshl = std::sqrt(1.0 - zsinhl * zsinhl);
  const double c = 4.7199672 + 0.22997150 * day;
  const double gam = 5.8351514 + 0.0019443680 * day;
  d.zmol = fmod2p(c - gam);
  double zx = 0.39785416 * stem / zsinil;
  const double zy = zcoshl * ctem + 0.91744867 * zsinhl * stem;
  zx = std::atan2(zx, zy);
  zx = gam + zx - xnodce;
  const double zcosgl = std::cos(zx);
  const double zsingl = std::sin(zx);
  d.zmos = fmod2p(6.2565837 + 0.017201977 * day);

  // DO SOLAR TERMS (statement 10), then DO LUNAR TERMS (statement 30)
  const double xnoi = 1.0 / d.xnq;
  const BodyTerms sun = body_terms(g, mode, xnoi, kZcosgs, kZsings, kZcosis, kZsinis, cosq, sinq, kC1ss, kZns, kZes);
  const BodyTerms moon = body_terms(g, mode, xnoi, zcosgl, zsingl, zcosil, zsinil, zcoshl * cosq + zsinhl * sinq,
                                    sinq * zcoshl - cosq * zsinhl, kC1l, kZnl, kZel);
  d.sun = sun.p;
  d.moon = moon.p;
  // SSH = SH / SINIQ: SH is zero at the inclinations where SINIQ can vanish (AIAA 2006-6753 VI.A)
  const double siniq = g.siniq, cosiq = g.cosiq;
  d.sse = sun.se;
  d.ssi = sun.si;
  d.ssl = sun.sl;
  d.ssh = siniq != 0.0 ? sun.sh / siniq : 0.0;
  d.ssg = sun.sgh - cosiq * d.ssh;
  d.sse = d.sse + moon.se;
  d.ssi = d.ssi + moon.si;
  d.ssl = d.ssl + moon.sl;
  d.ssg = d.ssg + moon.sgh - (siniq != 0.0 ? cosiq / siniq * moon.sh : 0.0);
  d.ssh = d.ssh + (siniq != 0.0 ? moon.sh / siniq : 0.0);

  // GEOPOTENTIAL RESONANCE INITIALIZATION FOR 12 HOUR ORBITS (statement 40)
  d.iresfl = 0;
  d.isynfl = 0;
  const double xnq = d.xnq, eqsq = g.eqsq, cosq2 = g.cosq2;
  double bfact;
  if (xnq < 0.0052359877 && xnq > 0.0034906585) {
    // SYNCHRONOUS RESONANCE TERMS INITIALIZATION (statement 70)
    d.iresfl = 1;
    d.isynfl = 1;
    const double g200 = 1.0 + eqsq * (-2.5 + 0.8125 * eqsq);
    const double g310 = 1.0 + 2.0 * eqsq;
    const double g300 = 1.0 + eqsq * (-6.0 + 6.60937 * eqsq);
    const double f220 = 0.75 * (1.0 + cosiq) * (1.0 + cosiq);
    const double f311 = 0.9375 * siniq * siniq * (1.0 + 3.0 * cosiq) - 0.75 * (1.0 + cosiq);
    double f330 = 1.0 + cosiq;
    f330 = 1.875 * f330 * f330 * f330;
    double del1 = 3.0 * xnq * xnq * aqnv * aqnv;
    d.d[1] = 2.0 * del1 * f220 * g200 * kQ22;
    d.d[2] = 3.0 * del1 * f330 * g300 * kQ33 * aqnv;
    del1 = del1 * f311 * g310 * kQ31 * aqnv;
    d.d[0] = del1;
    d.xlamo = g.xmo + g.xnodeo + g.omegao - d.thgr;
    bfact = g.xlldot + xpidot - kThdt;
    bfact = bfact + d.ssl + d.ssg + d.ssh;
  } else {
    if (xnq < 8.26e-3 || xnq > 9.24e-3) return;
    if (eq < 0.5) return;
    d.iresfl = 1;
    const double eoc = eq * eqsq;
    const double g201 = -0.306 - (eq - 0.64) * 0.440;
    double g211, g310, g322, g410, g422, g520, g533, g521, g532;
    if (eq <= 0.65) {
      g211 = 3.616 - 13.247 * eq + 16.290 * eqsq;
      g310 = -19.302 + 117.390 * eq - 228.419 * eqsq + 156.591 * eoc;
      g322 = -18.9068 + 109.7927 * eq - 214.6334 * eqsq + 146.5816 * eoc;
      g410 = -41.122 + 242.694 * eq - 471.094 * eqsq + 313.953 * eoc;
      g422 = -146.407 + 841.880 * eq - 1629.014 * eqsq + 1083.435 * eoc;
      // STR#3 p. 63 prints -5740 for the e^2 coefficient; the reference uses -5740.032 (black box: scanned on
      // AIAA 2006-6753 App. D set 26975, e = 0.56: 7.6 cm at -5740, 4.7 mm at -5740.03, 17 um at -5740.032)
      g520 = -532.114 + 3017.977 * eq - 5740.032 * eqsq + 3708.276 * eoc;
    } else {
      g211 = -72.099 + 331.819 * eq - 508.738 * eqsq + 266.724 * eoc;
      g310 = -346.844 + 1582.851 * eq - 2415.925 * eqsq + 1246.113 * eoc;
      g322 = -342.585 + 1554.908 * eq - 2366.899 * eqsq + 1215.972 * eoc;
      g410 = -1052.797 + 4758.686 * eq - 7193.992 * eqsq + 3651.957 * eoc;
      g422 = -3581.69 + 16178.11 * eq - 24462.77 * eqsq + 12422.52 * eoc;
      if (eq <= 0.715) g520 = 1464.74 - 4664.75 * eq + 3763.64 * eqsq;
      else g520 = -5149.66 + 29936.92 * eq - 54087.36 * eqsq + 31324.56 * eoc;
    }
    if (eq < 0.7) {
      g533 = -919.2277 + 4988.61 * eq - 9064.77 * eqsq + 5542.21 * eoc;
      g521 = -822.71072 + 4568.6173 * eq - 8491.4146 * eqsq + 5337.524 * eoc;
      g532 = -853.666 + 4690.25 * eq - 8624.77 * eqsq + 5341.4 * eoc;
    } else {
      g533 = -37995.78 + 161616.52 * eq - 229838.2 * eqsq + 109377.94 * eoc;
      g521 = -51752.104 + 218913.95 * eq - 309468.16 * eqsq + 146349.42 * eoc;
      g532 = -40023.88 + 170470.89 * eq - 242699.48 * eqsq + 115605.82 * eoc;
    }
    const double sini2 = siniq * siniq;
    const double f220 = 0.75 * (1.0 + 2.0 * cosiq + cosq2);
    const double f221 = 1.5 * sini2;
    const double f321 = 1.875 * siniq * (1.0 - 2.0 * cosiq - 3.0 * cosq2);
    const double f322 = -1.875 * siniq * (1.0 + 2.0 * cosiq - 3.0 * cosq2);
    const double f441 = 35.0 * sini2 * f220;
    const double f442 = 39.3750 * sini2 * sini2;
    const double f522 = 9.84375 * siniq * (sini2 * (1.0 - 2.0 * cosiq - 5.0 * cosq2) +
                                           0.33333333 * (-2.0 + 4.0 * cosiq + 6.0 * cosq2));
    const double f523 = siniq * (4.92187512 * sini2 * (-2.0 - 4.0 * cosiq + 10.0 * cosq2) +
                                 6.56250012 * (1.0 + 2.0 * cosiq - 3.0 * cosq2));
    const double f542 = 29.53125 * siniq * (2.0 - 8.0 * cosiq + cosq2 * (-12.0 + 8.0 * cosiq + 10.0 * cosq2));
    const double f543 = 29.53125 * siniq * (-2.0 - 8.0 * cosiq + cosq2 * (12.0 + 8.0 * cosiq - 10.0 * cosq2));
    const double xno2 = xnq * xnq;
    const double ainv2 = aqnv * aqnv;
    double temp1 = 3.0 * xno2 * ainv2;
    double temp = temp1 * kRoot22;
    d.d[0] = temp * f220 * g201;   // D2201
    d.d[1] = temp * f221 * g211;   // D2211
    temp1 = temp1 * aqnv;
    temp = temp1 * kRoot32;
    d.d[2] = temp * f321 * g310;   // D3210
    d.d[3] = temp * f322 * g322;   // D3222
    temp1 = temp1 * aqnv;
    temp = 2.0 * temp1 * kRoot44;
    d.d[4] = temp * f441 * g410;   // D4410
    d.d[5] = temp * f442 * g422;   // D4422
    temp1 = temp1 * aqnv;
    temp = temp1 * kRoot52;
    d.d[6] = temp * f522 * g520;   // D5220
    d.d[7] = temp * f523 * g532;   // D5232
    temp = 2.0 * temp1 * kRoot54;
    d.d[8] = temp * f542 * g521;   // D5421
    d.d[9] = temp * f543 * g533;   // D5433
    d.xlamo = g.xmo + g.xnodeo + g.xnodeo - d.thgr - d.thgr;
    bfact = g.xlldot + g.xnodot + g.xnodot - kThdt - kThdt;
    bfact = bfact + d.ssl + d.ssh + d.ssh;
  }
  // statement 80
  d.xfact = bfact - xnq;
}

/// The resonance integrator's state: angle XLI and mean motion XNI at ATIME
/// minutes from epoch.
struct ResState {
  double xli, xni, atime;
};

/// The resonance rates at a state (STR#3 statements 150-154, "DOT TERMS
/// CALCULATED"): XNDOT, its time derivative XNDDT, and XLDOT.
struct ResRates {
  double xndot, xnddt, xldot;
};

inline ResRates resonance_rates(const Deep& d, const ResState& s) {
  ResRates r;
  const double xli = s.xli;
  if (d.isynfl) {
    r.xndot = d.d[0] * std::sin(xli - kFasx2) + d.d[1] * std::sin(2.0 * (xli - kFasx4)) +
              d.d[2] * std::sin(3.0 * (xli - kFasx6));
    r.xnddt = d.d[0] * std::cos(xli - kFasx2) + 2.0 * d.d[1] * std::cos(2.0 * (xli - kFasx4)) +
              3.0 * d.d[2] * std::cos(3.0 * (xli - kFasx6));
  } else {
    const double xomi = d.omegaq + d.omgdt * s.atime;
    const double x2omi = xomi + xomi;
    const double x2li = xli + xli;
    r.xndot = d.d[0] * std::sin(x2omi + xli - kG22) + d.d[1] * std::sin(xli - kG22) +
              d.d[2] * std::sin(xomi + xli - kG32) + d.d[3] * std::sin(-xomi + xli - kG32) +
              d.d[4] * std::sin(x2omi + x2li - kG44) + d.d[5] * std::sin(x2li - kG44) +
              d.d[6] * std::sin(xomi + xli - kG52) + d.d[7] * std::sin(-xomi + xli - kG52) +
              d.d[8] * std::sin(xomi + x2li - kG54) + d.d[9] * std::sin(-xomi + x2li - kG54);
    r.xnddt = d.d[0] * std::cos(x2omi + xli - kG22) + d.d[1] * std::cos(xli - kG22) +
              d.d[2] * std::cos(xomi + xli - kG32) + d.d[3] * std::cos(-xomi + xli - kG32) +
              d.d[6] * std::cos(xomi + xli - kG52) + d.d[7] * std::cos(-xomi + xli - kG52) +
              2.0 * (d.d[4] * std::cos(x2omi + x2li - kG44) + d.d[5] * std::cos(x2li - kG44) +
                     d.d[8] * std::cos(xomi + x2li - kG54) + d.d[9] * std::cos(-xomi + x2li - kG54));
  }
  r.xldot = s.xni + d.xfact;
  r.xnddt = r.xnddt * r.xldot;
  return r;
}

/// One integrator step of DELT minutes (STR#3 statements 160-165).
inline void resonance_step(const Deep& d, ResState& s, double delt) {
  const ResRates r = resonance_rates(d, s);
  s.xli = s.xli + r.xldot * delt + r.xndot * kStep2;
  s.xni = s.xni + r.xndot * delt + r.xnddt * kStep2;
  s.atime = s.atime + delt;
}

/// The number of 720-minute steps STR#3's integrator takes from the epoch
/// towards t: it steps while |t - ATIME| >= 720 (exact for multiples of 720).
inline uint32_t resonance_steps(double t) {
  const double at = std::fabs(t);
  double k = std::floor(at / kStepp);
  while (k > 0.0 && kStepp * k > at) k -= 1.0;
  while (kStepp * (k + 1.0) <= at) k += 1.0;
  return static_cast<uint32_t>(k);
}

/// The integrator state at t's last node: the epoch, a checkpoint (`nodes`:
/// per node k = 1..count, XLI and XNI after k steps forward, then after k steps
/// back), and the steps beyond the last checkpoint. Always from the epoch,
/// whatever the order of the calls (AIAA 2006-6753 VI.D).
inline ResState resonance_node(const Deep& d, const double* nodes, uint32_t count, double t) {
  ResState s{d.xlamo, d.xnq, 0.0};
  const uint32_t steps = resonance_steps(t);
  const double delt = t > 0.0 ? kStepp : kStepn;
  uint32_t done = 0;
  if (nodes != nullptr && count > 0 && steps > 0) {
    done = steps < count ? steps : count;
    const double* n = nodes + 4u * (done - 1u) + (t > 0.0 ? 0u : 2u);
    s.xli = n[0];
    s.xni = n[1];
    s.atime = delt * static_cast<double>(done);
  }
  for (; done < steps; ++done) resonance_step(d, s, delt);
  return s;
}

/// DPSEC (STR#3 p. 65): the lunar-solar secular terms added to M (xll), omega
/// (omgasm) and Omega (xnodes); e (em) and i (xinc) at t; for resonant orbits
/// the integrated resonance gives the mean motion (xn) and M. The negative
/// inclination is not corrected here (AIAA 2006-6753 VI.C: after the periodics).
inline void deep_secular(const Deep& d, double eo, double xincl, const double* nodes, uint32_t count, double t,
                         double& xll, double& omgasm, double& xnodes, double& em, double& xinc, double& xn) {
  xll = xll + d.ssl * t;
  omgasm = omgasm + d.ssg * t;
  xnodes = xnodes + d.ssh * t;
  em = eo + d.sse * t;
  xinc = xincl + d.ssi * t;
  if (!d.iresfl) return;
  const ResState s = resonance_node(d, nodes, count, t);
  const double ft = t - s.atime;
  const ResRates r = resonance_rates(d, s);
  xn = s.xni + r.xndot * ft + r.xnddt * ft * ft * 0.5;
  const double xl = s.xli + r.xldot * ft + r.xndot * ft * ft * 0.5;
  const double temp = -xnodes + d.thgr + t * kThdt;
  xll = d.isynfl ? xl - omgasm + temp : xl + temp + temp;
}

/// DPPER (STR#3 pp. 67-68): the lunar-solar periodics at t added to e (em), i
/// (xinc), omega (omgasm), Omega (xnodes) and M (xll), with AIAA 2006-6753's
/// corrections (section III): computed at every call (no 30-minute reuse); the
/// Lyddane choice made on the perturbed inclination (as Appendix E's results);
/// the node taken by the intrinsic MOD and ATAN2, the new node within pi of
/// the old (the "Lyddane bug"), both non-negative in AFSPC mode.
inline void deep_periodics(const Deep& d, Sgp4Mode mode, double t, double& em, double& xinc, double& omgasm,
                           double& xnodes, double& xll) {
  // the Sun (statement 205), then the Moon
  double zm = d.zmos + kZns * t;
  double zf = zm + 2.0 * kZes * std::sin(zm);
  double sinzf = std::sin(zf);
  double f2 = 0.5 * sinzf * sinzf - 0.25;
  double f3 = -0.5 * sinzf * std::cos(zf);
  const double ses = d.sun.e2 * f2 + d.sun.e3 * f3;
  const double sis = d.sun.i2 * f2 + d.sun.i3 * f3;
  const double sls = d.sun.l2 * f2 + d.sun.l3 * f3 + d.sun.l4 * sinzf;
  const double sghs = d.sun.gh2 * f2 + d.sun.gh3 * f3 + d.sun.gh4 * sinzf;
  const double shs = d.sun.h2 * f2 + d.sun.h3 * f3;
  zm = d.zmol + kZnl * t;
  zf = zm + 2.0 * kZel * std::sin(zm);
  sinzf = std::sin(zf);
  f2 = 0.5 * sinzf * sinzf - 0.25;
  f3 = -0.5 * sinzf * std::cos(zf);
  const double sel = d.moon.e2 * f2 + d.moon.e3 * f3;
  const double sil = d.moon.i2 * f2 + d.moon.i3 * f3;
  const double sll = d.moon.l2 * f2 + d.moon.l3 * f3 + d.moon.l4 * sinzf;
  const double sghl = d.moon.gh2 * f2 + d.moon.gh3 * f3 + d.moon.gh4 * sinzf;
  const double shl = d.moon.h2 * f2 + d.moon.h3 * f3;
  const double pe = ses + sel;
  const double pinc = sis + sil;
  const double pl = sls + sll;
  double pgh = sghs + sghl;
  double ph = shs + shl;
  xinc = xinc + pinc;
  em = em + pe;
  // the inclination's terms at the perturbed inclination (AIAA 2006-6753 III)
  const double sinis = std::sin(xinc);
  const double cosis = std::cos(xinc);
  if (xinc >= kLyddaneInclination) {
    // APPLY PERIODICS DIRECTLY
    ph = ph / sinis;
    pgh = pgh - cosis * ph;
    omgasm = omgasm + pgh;
    xnodes = xnodes + ph;
    xll = xll + pl;
    return;
  }
  // APPLY PERIODICS WITH LYDDANE MODIFICATION
  const bool afspc = mode == Sgp4Mode::kAfspc;
  const double sinok = std::sin(xnodes);
  const double cosok = std::cos(xnodes);
  double alfdp = sinis * sinok;
  double betdp = sinis * cosok;
  const double dalf = ph * cosok + pinc * cosis * sinok;
  const double dbet = -ph * sinok + pinc * cosis * cosok;
  alfdp = alfdp + dalf;
  betdp = betdp + dbet;
  double node = std::fmod(xnodes, kTwoPi);
  if (afspc && node < 0.0) node += kTwoPi;
  double xls = xll + omgasm + cosis * node;
  const double dls = pl + pgh - pinc * node * sinis;
  xls = xls + dls;
  double nodek = std::atan2(alfdp, betdp);
  if (afspc && nodek < 0.0) nodek += kTwoPi;
  if (std::fabs(node - nodek) > kPi) nodek = nodek < node ? nodek + kTwoPi : nodek - kTwoPi;
  xll = xll + pl;
  omgasm = xls - xll - cosis * nodek;
  xnodes = nodek;
}

}  // namespace str3
}  // namespace sdnap
