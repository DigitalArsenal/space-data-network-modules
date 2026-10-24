// -----------------------------------------------------------------------------
// The public base: SGP4/SDP4 after Hoots & Roehrich (SPACETRACK REPORT No. 3,
// 1980) and Vallado, Crawford, Hujsak & Kelso, "Revisiting Spacetrack Report
// #3" (AIAA 2006-6753), AFSPC operations mode. Written for this module:
// propagation is a pure function of the stored element record (no state is
// written while propagating) and the deep-space resonance integrator reads
// per-object checkpoints. SGP4XP sets have their own theory (xp_theory.inc).
// -----------------------------------------------------------------------------

namespace sdnap {

/// One element set as ingested (any theory). Angles in radians, mean motion
/// in rad/min, epoch as a split Julian date (UTC).
/// SDN-AP set flags (ElementRow::flags, Elements::flags).
constexpr uint32_t kFlagLowering = 1u;  ///< DESIGN 2c.2: B_eff outside the physical range, tau0 fitted; it persists after the arc
constexpr uint32_t kFlagTauHeld = 2u;   ///< above the drag regime: tauc and taus carry SRP's once-per-revolution part, held after the arc

struct Elements {
  double epoch_jd_whole;  ///< integer + 0.5 part of the epoch Julian date
  double epoch_jd_frac;   ///< remaining fraction of a day
  double no_kozai;        ///< mean motion as carried by the set, rad/min
  double ecco, inclo, nodeo, argpo, mo;
  double bstar;           ///< SGP4: B*, 1/earth radii
  double ndot, nddot;     ///< SGP4: carried, unused by the theory
  double bterm;           ///< SGP4-XP: ballistic coefficient Cd A / m, m^2/kg
  double agom;            ///< SGP4-XP: solar radiation pressure coefficient Cr A / m, m^2/kg
  uint32_t norad;
  int32_t theory;
  double kappa, tau0, tauc, taus, arc_end_min;  ///< SDN-AP (DESIGN 2b, 2c)
  uint32_t flags;                               ///< SDN-AP: kFlagLowering
};

/// The propagation record of one object. Everything propagation reads; it is
/// written once, at ingest.
struct Sat {
  // identity and theory
  uint32_t norad;
  int32_t theory;
  int32_t init_error;     ///< nonzero: the set was refused at ingest
  uint8_t deep;           ///< SDP4 (deep-space) branch
  uint8_t isimp;          ///< simplified drag
  int8_t irez;            ///< 0 none, 1 one-day, 2 half-day resonance
  uint8_t pad;
  uint32_t checkpoint_base;   ///< first resonance checkpoint (pairs xli, xni)
  uint32_t checkpoint_count;  ///< forward checkpoints held (and as many backward)

  double epoch_jd_whole, epoch_jd_frac;
  // gravity
  double xke, j2, j3oj2, radius_km, vkmpersec;
  // elements at epoch
  double ecco, inclo, nodeo, argpo, mo, no_unkozai, bstar;
  // near-earth secular and drag
  double mdot, argpdot, nodedot, nodecf, cc1, cc4, cc5, omgcof, xmcof, eta, delmo, sinmao;
  double t2cof, t3cof, t4cof, t5cof, d2, d3, d4;
  double aycof, xlcof, con41, x1mth2, x7thm1, sinio, cosio;
  // deep space: lunar-solar periodics
  double e3, ee2, se2, se3, sgh2, sgh3, sgh4, sh2, sh3, si2, si3, sl2, sl3, sl4;
  double xgh2, xgh3, xgh4, xh2, xh3, xi2, xi3, xl2, xl3, xl4, zmol, zmos, gsto;
  // deep space: secular rates and resonance
  double dedt, didt, dmdt, dnodt, domdt;
  double d2201, d2211, d3210, d3222, d4410, d4422, d5220, d5232, d5421, d5433;
  double del1, del2, del3, xfact, xlamo;
};

/// Error classes of a propagation (Vallado's error codes, as negative ABI-side
/// classes are mapped in abi.inc).
enum PropError : int32_t {
  kPropOk = 0,
  kPropEccentricity = 1,   ///< mean eccentricity out of range
  kPropMeanMotion = 2,     ///< mean motion not positive
  kPropPerturbedEcc = 3,   ///< perturbed eccentricity out of range
  kPropSemiLatus = 4,      ///< semi-latus rectum negative
  kPropDecayed = 6,        ///< below the surface
  kPropRefused = 7,        ///< set refused at ingest
};

// --- SDP4 lunar-solar terms (Vallado dscom) ---------------------------------
struct DsCom {
  double snodm, cnodm, sinim, cosim, sinomm, cosomm, day, em, emsq, gam, rtemsq;
  double s1, s2, s3, s4, s5, s6, s7, ss1, ss2, ss3, ss4, ss5, ss6, ss7;
  double sz1, sz2, sz3, sz11, sz12, sz13, sz21, sz22, sz23, sz31, sz32, sz33;
  double z1, z2, z3, z11, z12, z13, z21, z22, z23, z31, z32, z33, nm;
};

inline void dscom(double epoch, double ep, double argpp, double tc, double inclp, double nodep,
                  double np, Sat& s, DsCom& d) {
  const double zes = 0.01675, zel = 0.05490, c1ss = 2.9864797e-6, c1l = 4.7968065e-7;
  const double zsinis = 0.39785416, zcosis = 0.91744867, zcosgs = 0.1945905, zsings = -0.98088458;

  d.nm = np;
  d.em = ep;
  d.snodm = std::sin(nodep);
  d.cnodm = std::cos(nodep);
  d.sinomm = std::sin(argpp);
  d.cosomm = std::cos(argpp);
  d.sinim = std::sin(inclp);
  d.cosim = std::cos(inclp);
  d.emsq = d.em * d.em;
  const double betasq = 1.0 - d.emsq;
  d.rtemsq = std::sqrt(betasq);

  d.day = epoch + 18261.5 + tc / 1440.0;
  const double xnodce = std::fmod(4.5236020 - 9.2422029e-4 * d.day, kTwoPi);
  const double stem = std::sin(xnodce);
  const double ctem = std::cos(xnodce);
  const double zcosil = 0.91375164 - 0.03568096 * ctem;
  const double zsinil = std::sqrt(1.0 - zcosil * zcosil);
  const double zsinhl = 0.089683511 * stem / zsinil;
  const double zcoshl = std::sqrt(1.0 - zsinhl * zsinhl);
  d.gam = 5.8351514 + 0.0019443680 * d.day;
  double zx = 0.39785416 * stem / zsinil;
  const double zy = zcoshl * ctem + 0.91744867 * zsinhl * stem;
  zx = std::atan2(zx, zy);
  zx = d.gam + zx - xnodce;
  const double zcosgl = std::cos(zx);
  const double zsingl = std::sin(zx);

  double zcosg = zcosgs, zsing = zsings, zcosi = zcosis, zsini = zsinis;
  double zcosh = d.cnodm, zsinh = d.snodm, cc = c1ss;
  const double xnoi = 1.0 / d.nm;

  for (int lsflg = 1; lsflg <= 2; ++lsflg) {
    const double a1 = zcosg * zcosh + zsing * zcosi * zsinh;
    const double a3 = -zsing * zcosh + zcosg * zcosi * zsinh;
    const double a7 = -zcosg * zsinh + zsing * zcosi * zcosh;
    const double a8 = zsing * zsini;
    const double a9 = zsing * zsinh + zcosg * zcosi * zcosh;
    const double a10 = zcosg * zsini;
    const double a2 = d.cosim * a7 + d.sinim * a8;
    const double a4 = d.cosim * a9 + d.sinim * a10;
    const double a5 = -d.sinim * a7 + d.cosim * a8;
    const double a6 = -d.sinim * a9 + d.cosim * a10;

    const double x1 = a1 * d.cosomm + a2 * d.sinomm;
    const double x2 = a3 * d.cosomm + a4 * d.sinomm;
    const double x3 = -a1 * d.sinomm + a2 * d.cosomm;
    const double x4 = -a3 * d.sinomm + a4 * d.cosomm;
    const double x5 = a5 * d.sinomm;
    const double x6 = a6 * d.sinomm;
    const double x7 = a5 * d.cosomm;
    const double x8 = a6 * d.cosomm;

    d.z31 = 12.0 * x1 * x1 - 3.0 * x3 * x3;
    d.z32 = 24.0 * x1 * x2 - 6.0 * x3 * x4;
    d.z33 = 12.0 * x2 * x2 - 3.0 * x4 * x4;
    d.z1 = 3.0 * (a1 * a1 + a2 * a2) + d.z31 * d.emsq;
    d.z2 = 6.0 * (a1 * a3 + a2 * a4) + d.z32 * d.emsq;
    d.z3 = 3.0 * (a3 * a3 + a4 * a4) + d.z33 * d.emsq;
    d.z11 = -6.0 * a1 * a5 + d.emsq * (-24.0 * x1 * x7 - 6.0 * x3 * x5);
    d.z12 = -6.0 * (a1 * a6 + a3 * a5) + d.emsq * (-24.0 * (x2 * x7 + x1 * x8) - 6.0 * (x3 * x6 + x4 * x5));
    d.z13 = -6.0 * a3 * a6 + d.emsq * (-24.0 * x2 * x8 - 6.0 * x4 * x6);
    d.z21 = 6.0 * a2 * a5 + d.emsq * (24.0 * x1 * x5 - 6.0 * x3 * x7);
    d.z22 = 6.0 * (a4 * a5 + a2 * a6) + d.emsq * (24.0 * (x2 * x5 + x1 * x6) - 6.0 * (x4 * x7 + x3 * x8));
    d.z23 = 6.0 * a4 * a6 + d.emsq * (24.0 * x2 * x6 - 6.0 * x4 * x8);
    d.z1 = d.z1 + d.z1 + betasq * d.z31;
    d.z2 = d.z2 + d.z2 + betasq * d.z32;
    d.z3 = d.z3 + d.z3 + betasq * d.z33;
    d.s3 = cc * xnoi;
    d.s2 = -0.5 * d.s3 / d.rtemsq;
    d.s4 = d.s3 * d.rtemsq;
    d.s1 = -15.0 * d.em * d.s4;
    d.s5 = x1 * x3 + x2 * x4;
    d.s6 = x2 * x3 + x1 * x4;
    d.s7 = x2 * x4 - x1 * x3;

    if (lsflg == 1) {
      d.ss1 = d.s1; d.ss2 = d.s2; d.ss3 = d.s3; d.ss4 = d.s4; d.ss5 = d.s5; d.ss6 = d.s6; d.ss7 = d.s7;
      d.sz1 = d.z1; d.sz2 = d.z2; d.sz3 = d.z3;
      d.sz11 = d.z11; d.sz12 = d.z12; d.sz13 = d.z13;
      d.sz21 = d.z21; d.sz22 = d.z22; d.sz23 = d.z23;
      d.sz31 = d.z31; d.sz32 = d.z32; d.sz33 = d.z33;
      zcosg = zcosgl;
      zsing = zsingl;
      zcosi = zcosil;
      zsini = zsinil;
      zcosh = zcoshl * d.cnodm + zsinhl * d.snodm;
      zsinh = d.snodm * zcoshl - d.cnodm * zsinhl;
      cc = c1l;
    }
  }

  s.zmol = std::fmod(4.7199672 + 0.22997150 * d.day - d.gam, kTwoPi);
  s.zmos = std::fmod(6.2565837 + 0.017201977 * d.day, kTwoPi);

  s.se2 = 2.0 * d.ss1 * d.ss6;
  s.se3 = 2.0 * d.ss1 * d.ss7;
  s.si2 = 2.0 * d.ss2 * d.sz12;
  s.si3 = 2.0 * d.ss2 * (d.sz13 - d.sz11);
  s.sl2 = -2.0 * d.ss3 * d.sz2;
  s.sl3 = -2.0 * d.ss3 * (d.sz3 - d.sz1);
  s.sl4 = -2.0 * d.ss3 * (-21.0 - 9.0 * d.emsq) * zes;
  s.sgh2 = 2.0 * d.ss4 * d.sz32;
  s.sgh3 = 2.0 * d.ss4 * (d.sz33 - d.sz31);
  s.sgh4 = -18.0 * d.ss4 * zes;
  s.sh2 = -2.0 * d.ss2 * d.sz22;
  s.sh3 = -2.0 * d.ss2 * (d.sz23 - d.sz21);

  s.ee2 = 2.0 * d.s1 * d.s6;
  s.e3 = 2.0 * d.s1 * d.s7;
  s.xi2 = 2.0 * d.s2 * d.z12;
  s.xi3 = 2.0 * d.s2 * (d.z13 - d.z11);
  s.xl2 = -2.0 * d.s3 * d.z2;
  s.xl3 = -2.0 * d.s3 * (d.z3 - d.z1);
  s.xl4 = -2.0 * d.s3 * (-21.0 - 9.0 * d.emsq) * zel;
  s.xgh2 = 2.0 * d.s4 * d.z32;
  s.xgh3 = 2.0 * d.s4 * (d.z33 - d.z31);
  s.xgh4 = -18.0 * d.s4 * zel;
  s.xh2 = -2.0 * d.s2 * d.z22;
  s.xh3 = -2.0 * d.s2 * (d.z23 - d.z21);
}

// --- SDP4 lunar-solar periodics (Vallado dpper, AFSPC mode) ----------------
// The epoch values (peo ... pho) are zero in this formulation, so the
// periodics are applied in full at every time.
inline void dpper(const Sat& s, double t, double& ep, double& inclp, double& nodep, double& argpp,
                  double& mp) {
  const double zns = 1.19459e-5, zes = 0.01675, znl = 1.5835218e-4, zel = 0.05490;

  double zm = s.zmos + zns * t;
  double zf = zm + 2.0 * zes * std::sin(zm);
  double sinzf = std::sin(zf);
  double f2 = 0.5 * sinzf * sinzf - 0.25;
  double f3 = -0.5 * sinzf * std::cos(zf);
  const double ses = s.se2 * f2 + s.se3 * f3;
  const double sis = s.si2 * f2 + s.si3 * f3;
  const double sls = s.sl2 * f2 + s.sl3 * f3 + s.sl4 * sinzf;
  const double sghs = s.sgh2 * f2 + s.sgh3 * f3 + s.sgh4 * sinzf;
  const double shs = s.sh2 * f2 + s.sh3 * f3;
  zm = s.zmol + znl * t;
  zf = zm + 2.0 * zel * std::sin(zm);
  sinzf = std::sin(zf);
  f2 = 0.5 * sinzf * sinzf - 0.25;
  f3 = -0.5 * sinzf * std::cos(zf);
  const double sel = s.ee2 * f2 + s.e3 * f3;
  const double sil = s.xi2 * f2 + s.xi3 * f3;
  const double sll = s.xl2 * f2 + s.xl3 * f3 + s.xl4 * sinzf;
  const double sghl = s.xgh2 * f2 + s.xgh3 * f3 + s.xgh4 * sinzf;
  const double shll = s.xh2 * f2 + s.xh3 * f3;
  const double pe = ses + sel;
  const double pinc = sis + sil;
  const double pl = sls + sll;
  double pgh = sghs + sghl;
  double ph = shs + shll;

  inclp = inclp + pinc;
  ep = ep + pe;
  const double sinip = std::sin(inclp);
  const double cosip = std::cos(inclp);

  if (inclp >= 0.2) {
    ph = ph / sinip;
    pgh = pgh - cosip * ph;
    argpp = argpp + pgh;
    nodep = nodep + ph;
    mp = mp + pl;
  } else {
    // Lyddane modification for low inclination.
    const double sinop = std::sin(nodep);
    const double cosop = std::cos(nodep);
    double alfdp = sinip * sinop;
    double betdp = sinip * cosop;
    const double dalf = ph * cosop + pinc * cosip * sinop;
    const double dbet = -ph * sinop + pinc * cosip * cosop;
    alfdp = alfdp + dalf;
    betdp = betdp + dbet;
    nodep = std::fmod(nodep, kTwoPi);
    if (nodep < 0.0) nodep += kTwoPi;  // AFSPC mode
    double xls = mp + argpp + cosip * nodep;
    const double dls = pl + pgh - pinc * nodep * sinip;
    xls = xls + dls;
    const double xnoh = nodep;
    nodep = std::atan2(alfdp, betdp);
    if (nodep < 0.0) nodep += kTwoPi;  // AFSPC mode
    if (std::fabs(xnoh - nodep) > kPi) {
      if (nodep < xnoh)
        nodep = nodep + kTwoPi;
      else
        nodep = nodep - kTwoPi;
    }
    mp = mp + pl;
    argpp = xls - mp - cosip * nodep;
  }
}

// --- SDP4 deep-space secular rates and resonance setup (Vallado dsinit) ----
inline void dsinit(Sat& s, const DsCom& d, double eccsq, double xpidot) {
  const double q22 = 1.7891679e-6, q31 = 2.1460748e-6, q33 = 2.2123015e-7;
  const double root22 = 1.7891679e-6, root44 = 7.3636953e-9, root54 = 2.1765803e-9;
  const double rptim = 4.37526908801129966e-3;
  const double root32 = 3.7393792e-7, root52 = 1.1428639e-7;
  const double znl = 1.5835218e-4, zns = 1.19459e-5;

  const double nm = d.nm;
  double em = d.em;
  double emsq = d.emsq;
  const double cosim = d.cosim, sinim = d.sinim;
  const double inclm = s.inclo;

  s.irez = 0;
  if ((nm < 0.0052359877) && (nm > 0.0034906585)) s.irez = 1;
  if ((nm >= 8.26e-3) && (nm <= 9.24e-3) && (em >= 0.5)) s.irez = 2;

  const double ses = d.ss1 * zns * d.ss5;
  const double sis = d.ss2 * zns * (d.sz11 + d.sz13);
  const double sls = -zns * d.ss3 * (d.sz1 + d.sz3 - 14.0 - 6.0 * emsq);
  const double sghs = d.ss4 * zns * (d.sz31 + d.sz33 - 6.0);
  double shs = -zns * d.ss2 * (d.sz21 + d.sz23);
  if ((inclm < 5.2359877e-2) || (inclm > kPi - 5.2359877e-2)) shs = 0.0;
  if (sinim != 0.0) shs = shs / sinim;
  const double sgs = sghs - cosim * shs;

  s.dedt = ses + d.s1 * znl * d.s5;
  s.didt = sis + d.s2 * znl * (d.z11 + d.z13);
  s.dmdt = sls - znl * d.s3 * (d.z1 + d.z3 - 14.0 - 6.0 * emsq);
  const double sghl = d.s4 * znl * (d.z31 + d.z33 - 6.0);
  double shll = -znl * d.s2 * (d.z21 + d.z23);
  if ((inclm < 5.2359877e-2) || (inclm > kPi - 5.2359877e-2)) shll = 0.0;
  s.domdt = sgs + sghl;
  s.dnodt = shs;
  if (sinim != 0.0) {
    s.domdt = s.domdt - cosim / sinim * shll;
    s.dnodt = s.dnodt + shll / sinim;
  }

  const double theta = std::fmod(s.gsto, kTwoPi);  // tc = 0 at ingest

  if (s.irez != 0) {
    const double aonv = std::pow(nm / s.xke, kX2o3);
    if (s.irez == 2) {
      const double cosisq = cosim * cosim;
      const double emo = em;
      em = s.ecco;
      const double emsqo = emsq;
      emsq = eccsq;
      const double eoc = em * emsq;
      const double g201 = -0.306 - (em - 0.64) * 0.440;
      double g211, g310, g322, g410, g422, g520, g521, g532, g533;
      if (em <= 0.65) {
        g211 = 3.616 - 13.2470 * em + 16.2900 * emsq;
        g310 = -19.302 + 117.3900 * em - 228.4190 * emsq + 156.5910 * eoc;
        g322 = -18.9068 + 109.7927 * em - 214.6334 * emsq + 146.5816 * eoc;
        g410 = -41.122 + 242.6940 * em - 471.0940 * emsq + 313.9530 * eoc;
        g422 = -146.407 + 841.8800 * em - 1629.014 * emsq + 1083.4350 * eoc;
        g520 = -532.114 + 3017.977 * em - 5740.032 * emsq + 3708.2760 * eoc;
      } else {
        g211 = -72.099 + 331.819 * em - 508.738 * emsq + 266.724 * eoc;
        g310 = -346.844 + 1582.851 * em - 2415.925 * emsq + 1246.113 * eoc;
        g322 = -342.585 + 1554.908 * em - 2366.899 * emsq + 1215.972 * eoc;
        g410 = -1052.797 + 4758.686 * em - 7193.992 * emsq + 3651.957 * eoc;
        g422 = -3581.690 + 16178.110 * em - 24462.770 * emsq + 12422.520 * eoc;
        if (em > 0.715)
          g520 = -5149.66 + 29936.92 * em - 54087.36 * emsq + 31324.56 * eoc;
        else
          g520 = 1464.74 - 4664.75 * em + 3763.64 * emsq;
      }
      if (em < 0.7) {
        g533 = -919.22770 + 4988.6100 * em - 9064.7700 * emsq + 5542.21 * eoc;
        g521 = -822.71072 + 4568.6173 * em - 8491.4146 * emsq + 5337.524 * eoc;
        g532 = -853.66600 + 4690.2500 * em - 8624.7700 * emsq + 5341.4 * eoc;
      } else {
        g533 = -37995.780 + 161616.52 * em - 229838.20 * emsq + 109377.94 * eoc;
        g521 = -51752.104 + 218913.95 * em - 309468.16 * emsq + 146349.42 * eoc;
        g532 = -40023.880 + 170470.89 * em - 242699.48 * emsq + 115605.82 * eoc;
      }
      const double sini2 = sinim * sinim;
      const double f220 = 0.75 * (1.0 + 2.0 * cosim + cosisq);
      const double f221 = 1.5 * sini2;
      const double f321 = 1.875 * sinim * (1.0 - 2.0 * cosim - 3.0 * cosisq);
      const double f322 = -1.875 * sinim * (1.0 + 2.0 * cosim - 3.0 * cosisq);
      const double f441 = 35.0 * sini2 * f220;
      const double f442 = 39.3750 * sini2 * sini2;
      const double f522 = 9.84375 * sinim *
                          (sini2 * (1.0 - 2.0 * cosim - 5.0 * cosisq) +
                           0.33333333 * (-2.0 + 4.0 * cosim + 6.0 * cosisq));
      const double f523 = sinim * (4.92187512 * sini2 * (-2.0 - 4.0 * cosim + 10.0 * cosisq) +
                                   6.56250012 * (1.0 + 2.0 * cosim - 3.0 * cosisq));
      const double f542 = 29.53125 * sinim *
                          (2.0 - 8.0 * cosim + cosisq * (-12.0 + 8.0 * cosim + 10.0 * cosisq));
      const double f543 = 29.53125 * sinim *
                          (-2.0 - 8.0 * cosim + cosisq * (12.0 + 8.0 * cosim - 10.0 * cosisq));
      const double xno2 = nm * nm;
      const double ainv2 = aonv * aonv;
      double temp1 = 3.0 * xno2 * ainv2;
      double temp = temp1 * root22;
      s.d2201 = temp * f220 * g201;
      s.d2211 = temp * f221 * g211;
      temp1 = temp1 * aonv;
      temp = temp1 * root32;
      s.d3210 = temp * f321 * g310;
      s.d3222 = temp * f322 * g322;
      temp1 = temp1 * aonv;
      temp = 2.0 * temp1 * root44;
      s.d4410 = temp * f441 * g410;
      s.d4422 = temp * f442 * g422;
      temp1 = temp1 * aonv;
      temp = temp1 * root52;
      s.d5220 = temp * f522 * g520;
      s.d5232 = temp * f523 * g532;
      temp = 2.0 * temp1 * root54;
      s.d5421 = temp * f542 * g521;
      s.d5433 = temp * f543 * g533;
      s.xlamo = std::fmod(s.mo + s.nodeo + s.nodeo - theta - theta, kTwoPi);
      s.xfact = s.mdot + s.dmdt + 2.0 * (s.nodedot + s.dnodt - rptim) - s.no_unkozai;
      em = emo;
      emsq = emsqo;
    }
    if (s.irez == 1) {
      const double g200 = 1.0 + emsq * (-2.5 + 0.8125 * emsq);
      const double g310 = 1.0 + 2.0 * emsq;
      const double g300 = 1.0 + emsq * (-6.0 + 6.60937 * emsq);
      const double f220 = 0.75 * (1.0 + cosim) * (1.0 + cosim);
      const double f311 = 0.9375 * sinim * sinim * (1.0 + 3.0 * cosim) - 0.75 * (1.0 + cosim);
      double f330 = 1.0 + cosim;
      f330 = 1.875 * f330 * f330 * f330;
      s.del1 = 3.0 * nm * nm * aonv * aonv;
      s.del2 = 2.0 * s.del1 * f220 * g200 * q22;
      s.del3 = 3.0 * s.del1 * f330 * g300 * q33 * aonv;
      s.del1 = s.del1 * f311 * g310 * q31 * aonv;
      s.xlamo = std::fmod(s.mo + s.nodeo + s.argpo - theta, kTwoPi);
      s.xfact = s.mdot + xpidot - rptim + s.dmdt + s.domdt + s.dnodt - s.no_unkozai;
    }
  }
}

// --- Resonance integrator (Euler-Maclaurin, 720-minute steps) --------------
constexpr double kResStep = 720.0;
constexpr double kResStep2 = 259200.0;  // step^2 / 2

struct ResDots {
  double xndt, xldot, xnddt;
};

inline ResDots resonance_dots(const Sat& s, double atime, double xli, double xni) {
  const double fasx2 = 0.13130908, fasx4 = 2.8843198, fasx6 = 0.37448087;
  const double g22 = 5.7686396, g32 = 0.95240898, g44 = 1.8014998, g52 = 1.0508330, g54 = 4.4108898;
  ResDots r{};
  if (s.irez != 2) {
    r.xndt = s.del1 * std::sin(xli - fasx2) + s.del2 * std::sin(2.0 * (xli - fasx4)) +
             s.del3 * std::sin(3.0 * (xli - fasx6));
    r.xldot = xni + s.xfact;
    r.xnddt = s.del1 * std::cos(xli - fasx2) + 2.0 * s.del2 * std::cos(2.0 * (xli - fasx4)) +
              3.0 * s.del3 * std::cos(3.0 * (xli - fasx6));
    r.xnddt = r.xnddt * r.xldot;
  } else {
    const double xomi = s.argpo + s.argpdot * atime;
    const double x2omi = xomi + xomi;
    const double x2li = xli + xli;
    r.xndt = s.d2201 * std::sin(x2omi + xli - g22) + s.d2211 * std::sin(xli - g22) +
             s.d3210 * std::sin(xomi + xli - g32) + s.d3222 * std::sin(-xomi + xli - g32) +
             s.d4410 * std::sin(x2omi + x2li - g44) + s.d4422 * std::sin(x2li - g44) +
             s.d5220 * std::sin(xomi + xli - g52) + s.d5232 * std::sin(-xomi + xli - g52) +
             s.d5421 * std::sin(xomi + x2li - g54) + s.d5433 * std::sin(-xomi + x2li - g54);
    r.xldot = xni + s.xfact;
    r.xnddt = s.d2201 * std::cos(x2omi + xli - g22) + s.d2211 * std::cos(xli - g22) +
              s.d3210 * std::cos(xomi + xli - g32) + s.d3222 * std::cos(-xomi + xli - g32) +
              s.d5220 * std::cos(xomi + xli - g52) + s.d5232 * std::cos(-xomi + xli - g52) +
              2.0 * (s.d4410 * std::cos(x2omi + x2li - g44) + s.d4422 * std::cos(x2li - g44) +
                     s.d5421 * std::cos(xomi + x2li - g54) + s.d5433 * std::cos(-xomi + x2li - g54));
    r.xnddt = r.xnddt * r.xldot;
  }
  return r;
}

/// One integrator step from node `k` (atime = k * delt) to node k + 1.
inline void resonance_step(const Sat& s, double delt, double atime, double& xli, double& xni) {
  const ResDots r = resonance_dots(s, atime, xli, xni);
  xli = xli + r.xldot * delt + r.xndt * kResStep2;
  xni = xni + r.xndt * delt + r.xnddt * kResStep2;
}

}  // namespace sdnap
