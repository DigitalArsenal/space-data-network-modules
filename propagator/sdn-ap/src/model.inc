// -----------------------------------------------------------------------------
// Ingest (sgp4init) and propagation (sgp4) of one object.
//
// Random access in time: the only integrated quantity of the theory is the
// deep-space resonance state (xli, xni), stepped from epoch in fixed
// 720-minute steps. Its values at the step nodes are checkpoints, computed
// at ingest for kCheckpointNodes nodes each way; a time within that span
// costs no integration at all (one Taylor step from its node), a time beyond
// it integrates from the last checkpoint. The state at a node does not depend
// on which times were asked before, so neither does any result.
// -----------------------------------------------------------------------------

namespace sdnap {

/// Checkpoints held each way from epoch per resonant object (32 days).
constexpr uint32_t kCheckpointNodes = 64;

inline void split_jd(double jd, double& whole, double& frac) {
  whole = std::floor(jd - 0.5) + 0.5;
  frac = jd - whole;
}

/// Greenwich mean sidereal time at the epoch, AFSPC form (days from 1950).
inline double gsto_afspc(double epoch1950) {
  const double ts70 = epoch1950 - 7305.0;
  const double ds70 = std::floor(ts70 + 1.0e-8);
  const double tfrac = ts70 - ds70;
  const double c1 = 1.72027916940703639e-2;
  const double thgr70 = 1.7321343856509374;
  const double fk5r = 5.07551419432269442e-15;
  const double c1p2p = c1 + kTwoPi;
  double gsto = std::fmod(thgr70 + c1 * ds70 + c1p2p * tfrac + ts70 * ts70 * fk5r, kTwoPi);
  if (gsto < 0.0) gsto += kTwoPi;
  return gsto;
}

/// sgp4init. Returns 0, or a PropError when the set is refused.
inline int32_t sat_init(const Elements& e, const Gravity& g, Sat& s) {
  s = Sat{};
  s.norad = e.norad;
  s.theory = e.theory;
  s.epoch_jd_whole = e.epoch_jd_whole;
  s.epoch_jd_frac = e.epoch_jd_frac;
  s.xke = g.xke;
  s.j2 = g.j2;
  s.j3oj2 = g.j3oj2;
  s.radius_km = g.radius_km;
  s.vkmpersec = g.radius_km * g.xke / 60.0;
  s.ecco = e.ecco;
  s.inclo = e.inclo;
  s.nodeo = e.nodeo;
  s.argpo = e.argpo;
  s.mo = e.mo;
  s.bstar = e.bstar;
  const double epoch1950 = (e.epoch_jd_whole - kJd1950) + e.epoch_jd_frac;

  if (!(e.no_kozai > 0.0) || !(e.ecco >= 0.0) || !(e.ecco < 1.0) || !std::isfinite(e.inclo)) {
    s.init_error = kPropRefused;
    return kPropRefused;
  }

  // initl
  const double ss = 78.0 / g.radius_km + 1.0;
  const double qzms2ttemp = (120.0 - 78.0) / g.radius_km;
  const double qzms2t = qzms2ttemp * qzms2ttemp * qzms2ttemp * qzms2ttemp;
  const double eccsq = s.ecco * s.ecco;
  const double omeosq = 1.0 - eccsq;
  const double rteosq = std::sqrt(omeosq);
  const double cosio = std::cos(s.inclo);
  const double cosio2 = cosio * cosio;
  double no = e.no_kozai;
  {
    const double ak = std::pow(g.xke / no, kX2o3);
    const double d1 = 0.75 * g.j2 * (3.0 * cosio2 - 1.0) / (rteosq * omeosq);
    double del = d1 / (ak * ak);
    const double adel = ak * (1.0 - del * del - del * (1.0 / 3.0 + 134.0 * del * del / 81.0));
    del = d1 / (adel * adel);
    no = no / (1.0 + del);
  }
  s.no_unkozai = no;
  const double ao = std::pow(g.xke / no, kX2o3);
  const double sinio = std::sin(s.inclo);
  const double po = ao * omeosq;
  const double con42 = 1.0 - 5.0 * cosio2;
  s.con41 = -con42 - cosio2 - cosio2;
  const double posq = po * po;
  const double rp = ao * (1.0 - s.ecco);
  s.gsto = gsto_afspc(epoch1950);
  s.sinio = sinio;
  s.cosio = cosio;

  s.isimp = 0;
  if (rp < (220.0 / g.radius_km + 1.0)) s.isimp = 1;
  double sfour = ss;
  double qzms24 = qzms2t;
  const double perige = (rp - 1.0) * g.radius_km;
  if (perige < 156.0) {
    sfour = perige - 78.0;
    if (perige < 98.0) sfour = 20.0;
    const double qzms24temp = (120.0 - sfour) / g.radius_km;
    qzms24 = qzms24temp * qzms24temp * qzms24temp * qzms24temp;
    sfour = sfour / g.radius_km + 1.0;
  }
  const double pinvsq = 1.0 / posq;
  const double tsi = 1.0 / (ao - sfour);
  s.eta = ao * s.ecco * tsi;
  const double etasq = s.eta * s.eta;
  const double eeta = s.ecco * s.eta;
  const double psisq = std::fabs(1.0 - etasq);
  const double coef = qzms24 * std::pow(tsi, 4.0);
  const double coef1 = coef / std::pow(psisq, 3.5);
  const double cc2 = coef1 * no *
                     (ao * (1.0 + 1.5 * etasq + eeta * (4.0 + etasq)) +
                      0.375 * g.j2 * tsi / psisq * s.con41 * (8.0 + 3.0 * etasq * (8.0 + etasq)));
  s.cc1 = s.bstar * cc2;
  double cc3 = 0.0;
  if (s.ecco > 1.0e-4) cc3 = -2.0 * coef * tsi * g.j3oj2 * no * sinio / s.ecco;
  s.x1mth2 = 1.0 - cosio2;
  s.cc4 = 2.0 * no * coef1 * ao * omeosq *
          (s.eta * (2.0 + 0.5 * etasq) + s.ecco * (0.5 + 2.0 * etasq) -
           g.j2 * tsi / (ao * psisq) *
               (-3.0 * s.con41 * (1.0 - 2.0 * eeta + etasq * (1.5 - 0.5 * eeta)) +
                0.75 * s.x1mth2 * (2.0 * etasq - eeta * (1.0 + etasq)) * std::cos(2.0 * s.argpo)));
  s.cc5 = 2.0 * coef1 * ao * omeosq * (1.0 + 2.75 * (etasq + eeta) + eeta * etasq);
  const double cosio4 = cosio2 * cosio2;
  const double temp1 = 1.5 * g.j2 * pinvsq * no;
  const double temp2 = 0.5 * temp1 * g.j2 * pinvsq;
  const double temp3 = -0.46875 * g.j4 * pinvsq * pinvsq * no;
  s.mdot = no + 0.5 * temp1 * rteosq * s.con41 +
           0.0625 * temp2 * rteosq * (13.0 - 78.0 * cosio2 + 137.0 * cosio4);
  s.argpdot = -0.5 * temp1 * con42 + 0.0625 * temp2 * (7.0 - 114.0 * cosio2 + 395.0 * cosio4) +
              temp3 * (3.0 - 36.0 * cosio2 + 49.0 * cosio4);
  const double xhdot1 = -temp1 * cosio;
  s.nodedot = xhdot1 + (0.5 * temp2 * (4.0 - 19.0 * cosio2) + 2.0 * temp3 * (3.0 - 7.0 * cosio2)) * cosio;
  const double xpidot = s.argpdot + s.nodedot;
  s.omgcof = s.bstar * cc3 * std::cos(s.argpo);
  s.xmcof = 0.0;
  if (s.ecco > 1.0e-4) s.xmcof = -kX2o3 * coef * s.bstar / eeta;
  s.nodecf = 3.5 * omeosq * xhdot1 * s.cc1;
  s.t2cof = 1.5 * s.cc1;
  if (std::fabs(cosio + 1.0) > 1.5e-12)
    s.xlcof = -0.25 * g.j3oj2 * sinio * (3.0 + 5.0 * cosio) / (1.0 + cosio);
  else
    s.xlcof = -0.25 * g.j3oj2 * sinio * (3.0 + 5.0 * cosio) / 1.5e-12;
  s.aycof = -0.5 * g.j3oj2 * sinio;
  const double delmotemp = 1.0 + s.eta * std::cos(s.mo);
  s.delmo = delmotemp * delmotemp * delmotemp;
  s.sinmao = std::sin(s.mo);
  s.x7thm1 = 7.0 * cosio2 - 1.0;

  const bool deep = (2.0 * kPi / no) >= 225.0;
  if (deep) {
    s.deep = 1;
    s.isimp = 1;
    DsCom d{};
    dscom(epoch1950, s.ecco, s.argpo, 0.0, s.inclo, s.nodeo, no, s, d);
    dsinit(s, d, eccsq, xpidot);
  }

  if (s.isimp != 1) {
    const double cc1sq = s.cc1 * s.cc1;
    s.d2 = 4.0 * ao * tsi * cc1sq;
    const double temp = s.d2 * tsi * s.cc1 / 3.0;
    s.d3 = (17.0 * ao + sfour) * temp;
    s.d4 = 0.5 * temp * ao * tsi * (221.0 * ao + 31.0 * sfour) * s.cc1;
    s.t3cof = s.d2 + 2.0 * cc1sq;
    s.t4cof = 0.25 * (3.0 * s.d3 + s.cc1 * (12.0 * s.d2 + 10.0 * cc1sq));
    s.t5cof = 0.2 * (3.0 * s.d4 + 12.0 * s.cc1 * s.d3 + 6.0 * s.d2 * s.d2 +
                     15.0 * cc1sq * (2.0 * s.d2 + cc1sq));
  }
  return kPropOk;
}

/// Fills the resonance checkpoints of a resonant object: nodes 1..n forward
/// (pairs xli, xni at +k * 720 min) then 1..n backward.
inline void fill_checkpoints(const Sat& s, double* nodes, uint32_t n) {
  for (int dir = 0; dir < 2; ++dir) {
    const double delt = dir == 0 ? kResStep : -kResStep;
    double xli = s.xlamo, xni = s.no_unkozai, atime = 0.0;
    double* out = nodes + 2 * n * dir;
    for (uint32_t k = 1; k <= n; ++k) {
      resonance_step(s, delt, atime, xli, xni);
      atime = atime + delt;
      out[2 * (k - 1)] = xli;
      out[2 * (k - 1) + 1] = xni;
    }
  }
}

/// sgp4. TEME position (km) and velocity (km/s) at `t` minutes from epoch.
/// Pure: reads the record and its checkpoints, writes only r and v.
inline int32_t sat_propagate(const Sat& s, const double* nodes, double t, double r[3], double v[3]) {
  if (s.init_error != 0) return kPropRefused;

  const double xmdf = s.mo + s.mdot * t;
  const double argpdf = s.argpo + s.argpdot * t;
  const double nodedf = s.nodeo + s.nodedot * t;
  double argpm = argpdf;
  double mm = xmdf;
  const double t2 = t * t;
  double nodem = nodedf + s.nodecf * t2;
  double tempa = 1.0 - s.cc1 * t;
  double tempe = s.bstar * s.cc4 * t;
  double templ = s.t2cof * t2;

  if (s.isimp != 1) {
    const double delomg = s.omgcof * t;
    const double delmtemp = 1.0 + s.eta * std::cos(xmdf);
    const double delm = s.xmcof * (delmtemp * delmtemp * delmtemp - s.delmo);
    const double temp = delomg + delm;
    mm = xmdf + temp;
    argpm = argpdf - temp;
    const double t3 = t2 * t;
    const double t4 = t3 * t;
    tempa = tempa - s.d2 * t2 - s.d3 * t3 - s.d4 * t4;
    tempe = tempe + s.bstar * s.cc5 * (std::sin(mm) - s.sinmao);
    templ = templ + s.t3cof * t3 + t4 * (s.t4cof + t * s.t5cof);
  }

  double nm = s.no_unkozai;
  double em = s.ecco;
  double inclm = s.inclo;
  if (s.deep) {
    // dspace: secular lunar-solar rates and the resonance state.
    const double rptim = 4.37526908801129966e-3;
    const double theta = std::fmod(s.gsto + t * rptim, kTwoPi);
    em = em + s.dedt * t;
    inclm = inclm + s.didt * t;
    argpm = argpm + s.domdt * t;
    nodem = nodem + s.dnodt * t;
    mm = mm + s.dmdt * t;
    if (s.irez != 0) {
      const double delt = t > 0.0 ? kResStep : -kResStep;
      const double at = std::fabs(t);
      double kf = std::floor(at / kResStep);
      while (kf > 0.0 && at - kf * kResStep < 0.0) kf -= 1.0;
      while (at - (kf + 1.0) * kResStep >= 0.0) kf += 1.0;
      const uint32_t k = static_cast<uint32_t>(kf);
      double xli = s.xlamo, xni = s.no_unkozai;
      uint32_t from = 0;
      if (k > 0 && nodes != nullptr && s.checkpoint_count > 0) {
        from = k < s.checkpoint_count ? k : s.checkpoint_count;
        const double* side = nodes + (t > 0.0 ? 0 : 2 * s.checkpoint_count);
        xli = side[2 * (from - 1)];
        xni = side[2 * (from - 1) + 1];
      }
      double atime = static_cast<double>(from) * delt;
      for (uint32_t i = from; i < k; ++i) {
        resonance_step(s, delt, atime, xli, xni);
        atime = atime + delt;
      }
      const ResDots dots = resonance_dots(s, atime, xli, xni);
      const double ft = t - atime;
      nm = xni + dots.xndt * ft + dots.xnddt * ft * ft * 0.5;
      const double xl = xli + dots.xldot * ft + dots.xndt * ft * ft * 0.5;
      double dndt;
      if (s.irez != 1) {
        mm = xl - 2.0 * nodem + 2.0 * theta;
        dndt = nm - s.no_unkozai;
      } else {
        mm = xl - nodem - argpm + theta;
        dndt = nm - s.no_unkozai;
      }
      nm = s.no_unkozai + dndt;
    }
  }

  if (nm <= 0.0) return kPropMeanMotion;
  const double am = std::pow(s.xke / nm, kX2o3) * tempa * tempa;
  nm = s.xke / std::pow(am, 1.5);
  em = em - tempe;
  if ((em >= 1.0) || (em < -0.001)) return kPropEccentricity;
  if (em < 1.0e-6) em = 1.0e-6;
  mm = mm + s.no_unkozai * templ;
  double xlm = mm + argpm + nodem;

  nodem = std::fmod(nodem, kTwoPi);
  argpm = std::fmod(argpm, kTwoPi);
  xlm = std::fmod(xlm, kTwoPi);
  mm = std::fmod(xlm - argpm - nodem, kTwoPi);

  double sinim, cosim;
  if (s.deep) {
    sinim = std::sin(inclm);
    cosim = std::cos(inclm);
  } else {
    sinim = s.sinio;
    cosim = s.cosio;
  }

  double ep = em, xincp = inclm, argpp = argpm, nodep = nodem, mp = mm;
  double sinip = sinim, cosip = cosim;
  double aycof = s.aycof, xlcof = s.xlcof, con41 = s.con41, x1mth2 = s.x1mth2, x7thm1 = s.x7thm1;
  if (s.deep) {
    dpper(s, t, ep, xincp, nodep, argpp, mp);
    if (xincp < 0.0) {
      xincp = -xincp;
      nodep = nodep + kPi;
      argpp = argpp - kPi;
    }
    if ((ep < 0.0) || (ep > 1.0)) return kPropPerturbedEcc;
    sinip = std::sin(xincp);
    cosip = std::cos(xincp);
    aycof = -0.5 * s.j3oj2 * sinip;
    if (std::fabs(cosip + 1.0) > 1.5e-12)
      xlcof = -0.25 * s.j3oj2 * sinip * (3.0 + 5.0 * cosip) / (1.0 + cosip);
    else
      xlcof = -0.25 * s.j3oj2 * sinip * (3.0 + 5.0 * cosip) / 1.5e-12;
  }
  const double axnl = ep * std::cos(argpp);
  double temp = 1.0 / (am * (1.0 - ep * ep));
  const double aynl = ep * std::sin(argpp) + temp * aycof;
  const double xl = mp + argpp + nodep + temp * xlcof * axnl;

  // Kepler's equation
  const double u = std::fmod(xl - nodep, kTwoPi);
  double eo1 = u;
  double tem5 = 9999.9;
  double sineo1 = 0.0, coseo1 = 0.0;
  for (int ktr = 1; std::fabs(tem5) >= 1.0e-12 && ktr <= 10; ++ktr) {
    sineo1 = std::sin(eo1);
    coseo1 = std::cos(eo1);
    tem5 = 1.0 - coseo1 * axnl - sineo1 * aynl;
    tem5 = (u - aynl * coseo1 + axnl * sineo1 - eo1) / tem5;
    if (std::fabs(tem5) >= 0.95) tem5 = tem5 > 0.0 ? 0.95 : -0.95;
    eo1 = eo1 + tem5;
  }

  const double ecose = axnl * coseo1 + aynl * sineo1;
  const double esine = axnl * sineo1 - aynl * coseo1;
  const double el2 = axnl * axnl + aynl * aynl;
  const double pl = am * (1.0 - el2);
  if (pl < 0.0) return kPropSemiLatus;
  const double rl = am * (1.0 - ecose);
  const double rdotl = std::sqrt(am) * esine / rl;
  const double rvdotl = std::sqrt(pl) / rl;
  const double betal = std::sqrt(1.0 - el2);
  temp = esine / (1.0 + betal);
  const double sinu = am / rl * (sineo1 - aynl - axnl * temp);
  const double cosu = am / rl * (coseo1 - axnl + aynl * temp);
  double su = std::atan2(sinu, cosu);
  const double sin2u = (cosu + cosu) * sinu;
  const double cos2u = 1.0 - 2.0 * sinu * sinu;
  temp = 1.0 / pl;
  const double temp1 = 0.5 * s.j2 * temp;
  const double temp2 = temp1 * temp;

  if (s.deep) {
    const double cosisq = cosip * cosip;
    con41 = 3.0 * cosisq - 1.0;
    x1mth2 = 1.0 - cosisq;
    x7thm1 = 7.0 * cosisq - 1.0;
  }
  const double mrt = rl * (1.0 - 1.5 * temp2 * betal * con41) + 0.5 * temp1 * x1mth2 * cos2u;
  su = su - 0.25 * temp2 * x7thm1 * sin2u;
  const double xnode = nodep + 1.5 * temp2 * cosip * sin2u;
  const double xinc = xincp + 1.5 * temp2 * cosip * sinip * cos2u;
  const double mvt = rdotl - nm * temp1 * x1mth2 * sin2u / s.xke;
  const double rvdot = rvdotl + nm * temp1 * (x1mth2 * cos2u + 1.5 * con41) / s.xke;

  const double sinsu = std::sin(su);
  const double cossu = std::cos(su);
  const double snod = std::sin(xnode);
  const double cnod = std::cos(xnode);
  const double sini = std::sin(xinc);
  const double cosi = std::cos(xinc);
  const double xmx = -snod * cosi;
  const double xmy = cnod * cosi;
  const double ux = xmx * sinsu + cnod * cossu;
  const double uy = xmy * sinsu + snod * cossu;
  const double uz = sini * sinsu;
  const double vx = xmx * cossu - cnod * sinsu;
  const double vy = xmy * cossu - snod * sinsu;
  const double vz = sini * cossu;

  r[0] = (mrt * ux) * s.radius_km;
  r[1] = (mrt * uy) * s.radius_km;
  r[2] = (mrt * uz) * s.radius_km;
  v[0] = (mvt * ux + rvdot * vx) * s.vkmpersec;
  v[1] = (mvt * uy + rvdot * vy) * s.vkmpersec;
  v[2] = (mvt * uz + rvdot * vz) * s.vkmpersec;

  if (mrt < 1.0) return kPropDecayed;
  return kPropOk;
}

}  // namespace sdnap
