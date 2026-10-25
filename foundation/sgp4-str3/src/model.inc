// -----------------------------------------------------------------------------
// foundation/sgp4-str3 (compiled by propagator/sdn-ap and analysis/od), part 2 of
// 2: the SGP4 and SDP4 models of Spacetrack Report No. 3 for one element set: the element record, the initialization section,
// propagation, and the resonance checkpoints.
//
// Written clean room (task modules-sdn-ap-sgp4-from-str3-20261024) from
// Hoots & Roehrich (1980), Spacetrack Report No. 3, sections 6 (SGP4,
// pp. 10-20), 7 (SDP4, pp. 21-30) and 11-12 (the driver's constants and units,
// pp. 70-78), and the corrections Vallado, Crawford, Hujsak & Kelso (2006),
// AIAA 2006-6753 Rev 3, document in its text (sections III and VI, Appendix
// D); each departure from the 1980 listing names its source.
// Structure (STR#3's): the subroutines SGP4 and SDP4 as one model, as the
// report's driver selects them (SDP4 for periods of 225 minutes or more,
// p. 71): sat_init is their IFLAG = 1 initialization section (with the shared
// recovery of the original mean motion, recover), sat_propagate their
// time-dependent part, and osculate the long-period periodics, Kepler's
// equation, the short-period periodics and the orientation vectors that both
// listings carry unchanged (pp. 18-20 and 28-30). Variables carry STR#3's
// FORTRAN names in lower case.
// -----------------------------------------------------------------------------

namespace sdnap {

/// One mean element set as the store ingests it (radians, rad/min). The
/// classical elements carry the names of STR#3's COMMON E1.
struct Elements {
  double epoch_jd_whole;   ///< epoch, integer + 0.5 part of the Julian date (UTC)
  double epoch_jd_frac;    ///< epoch, fraction of a day
  double xno;              ///< mean motion as the set carries it, rad/min (SGP4: Kozai, n_o; SGP4-XP: Brouwer)
  double eo;               ///< eccentricity
  double xincl;            ///< inclination
  double xnodeo;           ///< right ascension of the ascending node
  double omegao;           ///< argument of perigee
  double xmo;              ///< mean anomaly
  double bstar;            ///< SGP4: B*, 1/earth radii
  double ndot_rev_day2;    ///< first derivative of the mean motion as carried, rev/day^2 (not used by SGP4)
  double nddot_rev_day3;   ///< second derivative as carried, rev/day^3 (not used by SGP4)
  double bterm;            ///< SGP4-XP: m^2/kg; SDN-AP: B_eff, signed
  double agom;             ///< SGP4-XP, SDN-AP: m^2/kg
  uint32_t norad;
  int32_t theory;          ///< sdnap::Theory
  double kappa, tau0, tauc, taus, arc_end_min;  ///< SDN-AP (DESIGN 2b, 2c)
  uint32_t flags;          ///< SDN-AP: kFlagLowering, kFlagTauHeld
};

/// Status of one object at one time.
constexpr int32_t kPropOk = 0;
constexpr int32_t kPropRefused = 1;      ///< the set describes no orbit the theory propagates
constexpr int32_t kPropMeanMotion = 2;   ///< the mean motion is not positive
constexpr int32_t kPropEccentricity = 3; ///< the eccentricity leaves its range, or the semi-latus rectum is negative
constexpr int32_t kPropDecayed = 4;      ///< the radius is below one Earth radius

/// SDN-AP element flags.
constexpr uint32_t kFlagLowering = 1u;   ///< 2c.2: tau0 selected; the thrust persists after the arc
constexpr uint32_t kFlagTauHeld = 2u;    ///< above the drag regime: tauc and taus held after the arc

/// Resonance checkpoints per direction: the integrator's state at every
/// 720-minute node for 32 days each way (4 doubles per node: forward XLI and
/// XNI, then backward XLI and XNI).
constexpr uint32_t kCheckpointNodes = 64;

/// The inclination-dependent coefficients the osculation part reads: at the
/// epoch inclination for SGP4, at the perturbed one for SDP4 (AIAA 2006-6753
/// III: terms of the Keplerian orbit re-computed from the perturbed values).
struct Inclination {
  double cosio, sinio, x3thm1, x1mth2, x7thm1, xlcof, aycof;
};

/// One SGP4/SDP4 object.
struct Sat {
  double epoch_jd_whole, epoch_jd_frac;
  int32_t init_error;
  uint32_t checkpoint_base, checkpoint_count;
  Sgp4Mode mode;
  uint8_t ideep;   ///< STR#3 driver IDEEP: SDP4 (period >= 225 minutes)
  uint8_t isimp;   ///< STR#3 ISIMP: perigee below 220 km, the truncated drag equations
  // COMMON C1 (STR#3 p. 70): the gravity model in Earth radii and minutes
  double xke, ck2, ck4, a3ovk2, xkmper;
  // COMMON E1: the epoch elements
  double xmo, xnodeo, omegao, eo, xincl, bstar;
  // the initialized quantities (STR#3 pp. 16-18, 27-28)
  double xnodp, aodp, eta;
  Inclination epoch;
  double c1, c4, c5, xmdot, omgdot, xnodot, omgcof, xmcof, xnodcf, t2cof, delmo, sinmo;
  double d2, d3, d4, t3cof, t4cof, t5cof;
  str3::Deep deep;
};

namespace str3 {

/// The secular update gives these to the osculation part.
struct MeanState {
  double a, e, xl, omega, xnode, xinc, xn;
};

/// The inclination-dependent coefficients at inclination xinc (STR#3 pp. 16-17).
inline Inclination inclination_terms(double xinc, double a3ovk2) {
  Inclination c;
  c.cosio = std::cos(xinc);
  c.sinio = std::sin(xinc);
  const double theta2 = c.cosio * c.cosio;
  c.x3thm1 = 3.0 * theta2 - 1.0;
  c.x1mth2 = 1.0 - theta2;
  c.x7thm1 = 7.0 * theta2 - 1.0;
  // XLCOF divides by 1 + cos i: held finite at 180 degrees (AIAA 2006-6753 VI.A)
  const double one_plus = 1.0 + c.cosio;
  const double divisor = std::fabs(one_plus) > 1.5e-12 ? one_plus : 1.5e-12;
  c.xlcof = 0.125 * a3ovk2 * c.sinio * (3.0 + 5.0 * c.cosio) / divisor;
  c.aycof = 0.25 * a3ovk2 * c.sinio;
  return c;
}

/// LONG PERIOD PERIODICS, SOLVE KEPLERS EQUATION, SHORT PERIOD PRELIMINARY
/// QUANTITIES, UPDATE FOR SHORT PERIODICS, ORIENTATION VECTORS and POSITION AND
/// VELOCITY (STR#3 pp. 18-20, the same at pp. 29-30): TEME km and km/s.
inline int32_t osculate(const Sat& s, const MeanState& m, const Inclination& c, double r[3], double v[3]) {
  const double a = m.a, e = m.e, xnode = m.xnode, xn = m.xn;
  const double beta = std::sqrt(1.0 - e * e);
  const double axn = e * std::cos(m.omega);
  double temp = 1.0 / (a * beta * beta);
  const double xll = temp * c.xlcof * axn;
  const double aynl = temp * c.aycof;
  const double xlt = m.xl + xll;
  const double ayn = e * std::sin(m.omega) + aynl;

  // Kepler's equation for E + omega: tolerance 1e-12 (AIAA 2006-6753 III), the
  // correction limited to 0.95 rad (VI.E: a limit of 0.9 - 1.0), ten iterations
  // at most (STR#3); the last iterate's sine and cosine are kept, as STR#3 does
  const double capu = fmod2p(xlt - xnode);
  double temp2 = capu;
  double sinepw = 0.0, cosepw = 1.0, temp3 = 0.0, temp4 = 0.0, temp5 = 0.0, temp6 = 0.0;
  for (int i = 1; i <= 10; ++i) {
    sinepw = std::sin(temp2);
    cosepw = std::cos(temp2);
    temp3 = axn * sinepw;
    temp4 = ayn * cosepw;
    temp5 = axn * cosepw;
    temp6 = ayn * sinepw;
    double delta = (capu - temp4 + temp3 - temp2) / (1.0 - temp5 - temp6);
    if (std::fabs(delta) >= 0.95) delta = delta > 0.0 ? 0.95 : -0.95;
    if (std::fabs(delta) < 1.0e-12) break;
    temp2 = temp2 + delta;
  }

  const double ecose = temp5 + temp6;
  const double esine = temp3 - temp4;
  const double elsq = axn * axn + ayn * ayn;
  temp = 1.0 - elsq;
  const double pl = a * temp;
  if (pl < 0.0) return kPropEccentricity;  // AIAA 2006-6753 App. D: the semi-latus rectum trap
  const double rr = a * (1.0 - ecose);
  double temp1 = 1.0 / rr;
  const double rdot = s.xke * std::sqrt(a) * esine * temp1;
  const double rfdot = s.xke * std::sqrt(pl) * temp1;
  temp2 = a * temp1;
  const double betal = std::sqrt(temp);
  temp3 = 1.0 / (1.0 + betal);
  const double cosu = temp2 * (cosepw - axn + ayn * esine * temp3);
  const double sinu = temp2 * (sinepw - ayn - axn * esine * temp3);
  const double u = std::atan2(sinu, cosu);
  const double sin2u = 2.0 * sinu * cosu;
  const double cos2u = 2.0 * cosu * cosu - 1.0;
  temp = 1.0 / pl;
  temp1 = s.ck2 * temp;
  temp2 = temp1 * temp;

  const double rk = rr * (1.0 - 1.5 * temp2 * betal * c.x3thm1) + 0.5 * temp1 * c.x1mth2 * cos2u;
  const double uk = u - 0.25 * temp2 * c.x7thm1 * sin2u;
  const double xnodek = xnode + 1.5 * temp2 * c.cosio * sin2u;
  const double xinck = m.xinc + 1.5 * temp2 * c.cosio * c.sinio * cos2u;
  const double rdotk = rdot - xn * temp1 * c.x1mth2 * sin2u;
  const double rfdotk = rfdot + xn * temp1 * (c.x1mth2 * cos2u + 1.5 * c.x3thm1);
  if (rk < 1.0) return kPropDecayed;  // AIAA 2006-6753 VI.A: the decay check on the radius

  const double sinuk = std::sin(uk);
  const double cosuk = std::cos(uk);
  const double sinik = std::sin(xinck);
  const double cosik = std::cos(xinck);
  const double sinnok = std::sin(xnodek);
  const double cosnok = std::cos(xnodek);
  const double xmx = -sinnok * cosik;
  const double xmy = cosnok * cosik;
  const double ux = xmx * sinuk + cosnok * cosuk;
  const double uy = xmy * sinuk + sinnok * cosuk;
  const double uz = sinik * sinuk;
  const double vx = xmx * cosuk - cosnok * sinuk;
  const double vy = xmy * cosuk - sinnok * sinuk;
  const double vz = sinik * cosuk;
  // the driver's units (STR#3 p. 71): km, and km/s from Earth radii per minute
  r[0] = rk * ux * s.xkmper;
  r[1] = rk * uy * s.xkmper;
  r[2] = rk * uz * s.xkmper;
  v[0] = (rdotk * ux + rfdotk * vx) * s.xkmper * 1440.0 / 86400.0;
  v[1] = (rdotk * uy + rfdotk * vy) * s.xkmper * 1440.0 / 86400.0;
  v[2] = (rdotk * uz + rfdotk * vz) * s.xkmper * 1440.0 / 86400.0;
  if (!(std::isfinite(r[0]) && std::isfinite(r[1]) && std::isfinite(r[2]) && std::isfinite(v[0]) &&
        std::isfinite(v[1]) && std::isfinite(v[2])))
    return kPropEccentricity;
  return kPropOk;
}

/// RECOVER ORIGINAL MEAN MOTION (XNODP) AND SEMIMAJOR AXIS (AODP) FROM INPUT
/// ELEMENTS (STR#3 p. 10, listing p. 16).
struct Recovered {
  double cosio, theta2, x3thm1, eosq, betao2, betao, xnodp, aodp;
};

inline Recovered recover(double xke, double ck2, double xno, double eo, double xincl) {
  Recovered q;
  const double a1 = std::pow(xke / xno, kX2o3);
  q.cosio = std::cos(xincl);
  q.theta2 = q.cosio * q.cosio;
  q.x3thm1 = 3.0 * q.theta2 - 1.0;
  q.eosq = eo * eo;
  q.betao2 = 1.0 - q.eosq;
  q.betao = std::sqrt(q.betao2);
  const double del1 = 1.5 * ck2 * q.x3thm1 / (a1 * a1 * q.betao * q.betao2);
  const double ao = a1 * (1.0 - del1 * (0.5 * kX2o3 + del1 * (1.0 + 134.0 / 81.0 * del1)));
  const double delo = 1.5 * ck2 * q.x3thm1 / (ao * ao * q.betao * q.betao2);
  q.xnodp = xno / (1.0 + delo);
  // a''o by Kepler's third law from n''o, the form STR#3's SDP4 gives A at every time (p. 28); its
  // ao / (1 - deltao) (p. 10) agrees to 1e-12 while deltao is small and parts from it as e nears 1 (11 km at
  // e = 0.995): the reference forms a''o this way (black box, AIAA 2006-6753 App. D set 33333)
  q.aodp = std::pow(xke / q.xnodp, kX2o3);
  return q;
}

}  // namespace str3

/// STR#3's initialization section (IFLAG = 1; SGP4 pp. 16-18, SDP4 pp. 27-28)
/// for one set under gravity model g. Returns kPropOk, or kPropRefused (and
/// sets init_error) for a set no theory propagates.
inline int32_t sat_init(const Elements& e, const Gravity& g, Sat& s, Sgp4Mode mode = Sgp4Mode::kAfspc) {
  s = Sat{};
  s.epoch_jd_whole = e.epoch_jd_whole;
  s.epoch_jd_frac = e.epoch_jd_frac;
  s.mode = mode;
  const bool finite = std::isfinite(e.epoch_jd_whole) && std::isfinite(e.epoch_jd_frac) && std::isfinite(e.xincl) &&
                      std::isfinite(e.xnodeo) && std::isfinite(e.omegao) && std::isfinite(e.xmo) &&
                      std::isfinite(e.bstar);
  if (!finite || !(e.xno > 0.0) || !(e.eo >= 0.0) || !(e.eo < 1.0)) {
    s.init_error = kPropRefused;
    return kPropRefused;
  }
  // the driver's constants (STR#3 p. 70; AIAA 2006-6753 VI.B Table 2): Earth radii and minutes, AE = 1
  constexpr double qo = 120.0, so = 78.0;
  s.xke = g.xke;
  s.xkmper = g.radius_km;
  s.ck2 = 0.5 * g.j2;
  s.ck4 = -0.375 * g.j4;
  const double xj3 = g.j3;
  const double qoms = (qo - so) / g.radius_km;
  const double qoms2t = qoms * qoms * (qoms * qoms);
  const double ss = 1.0 + so / g.radius_km;
  s.a3ovk2 = -xj3 / s.ck2;
  s.xmo = e.xmo;
  s.xnodeo = e.xnodeo;
  s.omegao = e.omegao;
  s.eo = e.eo;
  s.xincl = e.xincl;
  s.bstar = e.bstar;
  const double eo = e.eo;

  const str3::Recovered q = str3::recover(s.xke, s.ck2, e.xno, eo, e.xincl);
  s.xnodp = q.xnodp;
  s.aodp = q.aodp;
  const double aodp = q.aodp, xnodp = q.xnodp, betao = q.betao, betao2 = q.betao2, theta2 = q.theta2;
  s.ideep = kTwoPi / xnodp >= 225.0 ? 1 : 0;

  // ISIMP: perigee below 220 km (SGP4); SDP4 carries the truncated drag terms only
  s.isimp = (aodp * (1.0 - eo) < 220.0 / s.xkmper + 1.0) || s.ideep ? 1 : 0;
  // FOR PERIGEE BELOW 156 KM, THE VALUES OF S AND QOMS2T ARE ALTERED
  double s4 = ss;
  double qoms24 = qoms2t;
  const double perige = (aodp * (1.0 - eo) - 1.0) * s.xkmper;
  if (perige < 156.0) {
    s4 = perige > 98.0 ? perige - 78.0 : 20.0;
    const double q4 = (120.0 - s4) / s.xkmper;
    qoms24 = q4 * q4 * (q4 * q4);
    s4 = s4 / s.xkmper + 1.0;
  }
  const double pinvsq = 1.0 / (aodp * aodp * betao2 * betao2);
  const double tsi = 1.0 / (aodp - s4);
  const double eta = aodp * eo * tsi;
  s.eta = eta;
  const double etasq = eta * eta;
  const double eeta = eo * eta;
  const double psisq = std::fabs(1.0 - etasq);
  const double tsi2 = tsi * tsi;
  const double coef = qoms24 * (tsi2 * tsi2);
  const double coef1 = coef / std::pow(psisq, 3.5);
  const double c2 = coef1 * xnodp *
                    (aodp * (1.0 + 1.5 * etasq + eeta * (4.0 + etasq)) +
                     0.75 * s.ck2 * tsi / psisq * q.x3thm1 * (8.0 + 3.0 * etasq * (8.0 + etasq)));
  s.c1 = s.bstar * c2;
  s.epoch = str3::inclination_terms(e.xincl, s.a3ovk2);
  const double sinio = s.epoch.sinio, cosio = s.epoch.cosio;
  // C3 and the delta-M coefficient divide by e: dropped for e <= 1e-4. STR#3 computes both for every e; AIAA 2006-6753
  // drops them for set 28057 (e = 8.84e-5, "< 1.0e-4"), and the reference drops them at e = 1e-4 itself.
  const bool small_e = eo <= 1.0e-4;
  const double c3 = small_e ? 0.0 : coef * tsi * s.a3ovk2 * xnodp * sinio / eo;
  const double x1mth2 = s.epoch.x1mth2;
  s.c4 = 2.0 * xnodp * coef1 * aodp * betao2 *
         (eta * (2.0 + 0.5 * etasq) + eo * (0.5 + 2.0 * etasq) -
          2.0 * s.ck2 * tsi / (aodp * psisq) *
              (-3.0 * q.x3thm1 * (1.0 - 2.0 * eeta + etasq * (1.5 - 0.5 * eeta)) +
               0.75 * x1mth2 * (2.0 * etasq - eeta * (1.0 + etasq)) * std::cos(2.0 * e.omegao)));
  s.c5 = 2.0 * coef1 * aodp * betao2 * (1.0 + 2.75 * (etasq + eeta) + eeta * etasq);
  const double theta4 = theta2 * theta2;
  const double temp1 = 3.0 * s.ck2 * pinvsq * xnodp;
  const double temp2 = temp1 * s.ck2 * pinvsq;
  const double temp3 = 1.25 * s.ck4 * pinvsq * pinvsq * xnodp;
  s.xmdot = xnodp + 0.5 * temp1 * betao * q.x3thm1 + 0.0625 * temp2 * betao * (13.0 - 78.0 * theta2 + 137.0 * theta4);
  const double x1m5th = 1.0 - 5.0 * theta2;
  s.omgdot = -0.5 * temp1 * x1m5th + 0.0625 * temp2 * (7.0 - 114.0 * theta2 + 395.0 * theta4) +
             temp3 * (3.0 - 36.0 * theta2 + 49.0 * theta4);
  const double xhdot1 = -temp1 * cosio;
  s.xnodot = xhdot1 + (0.5 * temp2 * (4.0 - 19.0 * theta2) + 2.0 * temp3 * (3.0 - 7.0 * theta2)) * cosio;
  s.omgcof = s.bstar * c3 * std::cos(e.omegao);
  s.xmcof = small_e ? 0.0 : -kX2o3 * coef * s.bstar / eeta;
  s.xnodcf = 3.5 * betao2 * xhdot1 * s.c1;
  s.t2cof = 1.5 * s.c1;
  const double q1 = 1.0 + eta * std::cos(e.xmo);
  s.delmo = q1 * q1 * q1;
  s.sinmo = std::sin(e.xmo);
  if (!s.isimp) {
    const double c1sq = s.c1 * s.c1;
    s.d2 = 4.0 * aodp * tsi * c1sq;
    const double temp = s.d2 * tsi * s.c1 / 3.0;
    s.d3 = (17.0 * aodp + s4) * temp;
    s.d4 = 0.5 * temp * aodp * tsi * (221.0 * aodp + 31.0 * s4) * s.c1;
    s.t3cof = s.d2 + 2.0 * c1sq;
    s.t4cof = 0.25 * (3.0 * s.d3 + s.c1 * (12.0 * s.d2 + 10.0 * c1sq));
    s.t5cof = 0.2 * (3.0 * s.d4 + 12.0 * s.c1 * s.d3 + 6.0 * s.d2 * s.d2 + 15.0 * c1sq * (2.0 * s.d2 + c1sq));
  }
  if (s.ideep) {
    // CALL DPINIT(EOSQ, SINIO, COSIO, BETAO, AODP, THETA2, SING, COSG, BETAO2, XMDOT, OMGDOT, XNODOT, XNODP)
    str3::DeepArgs g2;
    g2.jd_whole = e.epoch_jd_whole;
    g2.jd_frac = e.epoch_jd_frac;
    g2.ds50 = (e.epoch_jd_whole - kJd1950) + e.epoch_jd_frac;
    g2.eo = eo;
    g2.xincl = e.xincl;
    g2.xnodeo = e.xnodeo;
    g2.omegao = e.omegao;
    g2.xmo = e.xmo;
    g2.eqsq = q.eosq;
    g2.siniq = sinio;
    g2.cosiq = cosio;
    g2.rteqsq = betao;
    g2.ao = aodp;
    g2.cosq2 = theta2;
    g2.sinomo = std::sin(e.omegao);
    g2.cosomo = std::cos(e.omegao);
    g2.bsq = betao2;
    g2.xlldot = s.xmdot;
    g2.omgdt = s.omgdot;
    g2.xnodot = s.xnodot;
    g2.xnodp = xnodp;
    str3::deep_init(s.deep, g2, mode);
  }
  const bool usable = std::isfinite(s.c1) && std::isfinite(s.c4) && std::isfinite(s.xmdot) &&
                      std::isfinite(s.omgdot) && std::isfinite(s.xnodot) && std::isfinite(s.aodp);
  if (!usable) {
    s.init_error = kPropRefused;
    return kPropRefused;
  }
  return kPropOk;
}

/// STR#3's time-dependent part (SGP4 pp. 18-20, SDP4 pp. 28-30): TEME km and
/// km/s at tsince minutes from epoch. `nodes`: the object's resonance
/// checkpoints (fill_checkpoints), or nullptr. The same result for the same
/// time whatever was asked before.
inline int32_t sat_propagate(const Sat& s, const double* nodes, double tsince, double r[3], double v[3]) {
  if (s.init_error != 0) return kPropRefused;
  const double t = tsince;
  // UPDATE FOR SECULAR GRAVITY AND ATMOSPHERIC DRAG
  const double xmdf = s.xmo + s.xmdot * t;
  const double omgadf = s.omegao + s.omgdot * t;
  const double xnoddf = s.xnodeo + s.xnodot * t;
  const double tsq = t * t;
  const double xnode = xnoddf + s.xnodcf * tsq;
  double tempa = 1.0 - s.c1 * t;
  double tempe = s.bstar * s.c4 * t;
  double templ = s.t2cof * tsq;
  str3::MeanState m;
  if (!s.ideep) {
    double omega = omgadf;
    double xmp = xmdf;
    if (!s.isimp) {
      const double delomg = s.omgcof * t;
      const double q = 1.0 + s.eta * std::cos(xmdf);
      const double delm = s.xmcof * (q * q * q - s.delmo);
      const double temp = delomg + delm;
      xmp = xmdf + temp;
      omega = omgadf - temp;
      const double tcube = tsq * t;
      const double tfour = t * tcube;
      tempa = tempa - s.d2 * tsq - s.d3 * tcube - s.d4 * tfour;
      tempe = tempe + s.bstar * s.c5 * (std::sin(xmp) - s.sinmo);
      templ = templ + s.t3cof * tcube + tfour * (s.t4cof + t * s.t5cof);
    }
    m.a = s.aodp * (tempa * tempa);
    m.e = s.eo - tempe;
    m.xl = xmp + omega + xnode + s.xnodp * templ;
    m.omega = omega;
    m.xnode = xnode;
    m.xinc = s.xincl;
  } else {
    // CALL DPSEC(XMDF, OMGADF, XNODE, EM, XINC, XN, TSINCE)
    double xll = xmdf, omgasm = omgadf, xnodes = xnode, em = 0.0, xinc = 0.0, xn = s.xnodp;
    str3::deep_secular(s.deep, s.eo, s.xincl, nodes, nodes != nullptr ? s.checkpoint_count : 0u, t, xll, omgasm,
                       xnodes, em, xinc, xn);
    if (!(xn > 0.0)) return kPropMeanMotion;  // AIAA 2006-6753 App. D: the mean-motion trap
    m.a = std::pow(s.xke / xn, kX2o3) * (tempa * tempa);
    m.e = em - tempe;
    m.xl = xll;  // M; the periodics are added below
    m.omega = omgasm;
    m.xnode = xnodes;
    m.xinc = xinc;
  }
  // the eccentricity after drag (AIAA 2006-6753 App. D, sets 28350 and 22312: "modified eccentricity too low")
  if (!(m.e < 1.0) || m.e < -0.001) return kPropEccentricity;
  if (m.e < 1.0e-6) m.e = 1.0e-6;
  if (!(m.a > 0.0)) return kPropDecayed;
  Inclination c = s.epoch;
  if (s.ideep) {
    double xmam = m.xl + s.xnodp * templ;
    // CALL DPPER(E, XINC, OMGADF, XNODE, XMAM)
    str3::deep_periodics(s.deep, s.mode, t, m.e, m.xinc, m.omega, m.xnode, xmam);
    // a negative inclination becomes positive with the node turned half a revolution (AIAA 2006-6753 VI.C)
    if (m.xinc < 0.0) {
      m.xinc = -m.xinc;
      m.xnode = m.xnode + kPi;
      m.omega = m.omega - kPi;
    }
    if (m.e < 0.0 || m.e > 1.0) return kPropEccentricity;  // AIAA 2006-6753 App. D: the perturbed-eccentricity trap
    m.xl = xmam + m.omega + m.xnode;
    c = str3::inclination_terms(m.xinc, s.a3ovk2);
  }
  m.xn = s.xke / std::pow(m.a, 1.5);
  return str3::osculate(s, m, c, r, v);
}

/// The resonance checkpoints of a resonant SDP4 object: the integrator's
/// state after k = 1..count steps of 720 minutes forward and back from the
/// epoch, 4 doubles per node.
inline void fill_checkpoints(const Sat& s, double* nodes, uint32_t count) {
  if (nodes == nullptr || !s.ideep || !s.deep.iresfl) return;
  for (int dir = 0; dir < 2; ++dir) {
    str3::ResState st{s.deep.xlamo, s.deep.xnq, 0.0};
    const double delt = dir == 0 ? str3::kStepp : str3::kStepn;
    for (uint32_t k = 0; k < count; ++k) {
      str3::resonance_step(s.deep, st, delt);
      nodes[4u * k + 2u * static_cast<uint32_t>(dir)] = st.xli;
      nodes[4u * k + 2u * static_cast<uint32_t>(dir) + 1u] = st.xni;
    }
  }
}

}  // namespace sdnap
