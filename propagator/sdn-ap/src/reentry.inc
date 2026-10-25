// -----------------------------------------------------------------------------
// The `reentry` method (DESIGN 5.2): an Earth SGP4XP or SDN-AP set walked along
// its mean trajectory until an averaging limit trips (18):
//   C1  eps1 = 4 pi |a-dot| / (n H(h_p)) > 0.05   decay over an RK step against the scale height
//   C2  h_p < 180 km                               perigee height
//   C3  |Delta(ae)_rev| / (ae) > 0.01, e > 0.01    eccentricity collapsing per revolution
// then handed off, one way, to the module's osculating integration (5.2.2:
// EGM96 20 x 20, Sun and Moon, NRLMSISE-00 x exp(s) with the set's B_eff,
// SRP) down to the reentry altitude (80 km). The window (20): sigma_L^2 / L^2 =
// (sigma_B/B)^2 + sigma_d^2 (2 tau / L)(1 - (tau / L)(1 - e^(-L/tau))), sigma_d
// 15 %, tau 2 days, sigma_B/B from USER_DEFINED_SDNAP_B_EFF_SIGMA or 5 %. Out:
// one $RDM (BALLISTIC_COEFF = 1 / B_eff, kg/m^2).
// -----------------------------------------------------------------------------

namespace sdnap {
namespace reentry {

// C1-C4, the altitude, the node step, the horizon, the window's sigmas and the osculating step are the call's $PCF
// REENTRY values (defaults 180 km, 80 km, 0.05, 0.01 with e > 0.01, 0.5 km with e > 0.02, 30 min, 120 d,
// 0.15 / 2 d / 0.05, 10 s). C4 (eccentric orbits, e > HANDOFF_SAWTOOTH_MINIMUM_ECCENTRICITY): drag acts mostly in the
// perigee pass, so the osculating a steps at each pass and a mean theory misses an along-track sawtooth of
// (3 pi / 8) |Delta a per revolution|; the hand-off when that passes HANDOFF_SAWTOOTH_KM (by default half the 1 km the
// averaged phase is held to).

struct Handoff {
  double t = 0.0;     ///< minutes from the set's epoch
  int criterion = 0;  ///< 1 C1, 2 C2, 3 C3, 4 C4, 5 the theory refused the next node, 0 none within the horizon
  double perigee_km = 0.0, eps1 = 0.0;
};

/// The density scale height (km) at height h (km) from NRLMSISE-00 x exp(s) at the time d50 (equator, 0 deg).
inline double scale_height(double h, double d50) {
  double D, N;
  drag::day_of_year(d50, D, N);
  const int doy = static_cast<int>(std::floor(D)) + 1;
  const double sec = (D - std::floor(D)) * 86400.0;
  const double r1 = sdn::msis_density(0.0, 0.0, h, doy, sec, d50), r2 = sdn::msis_density(0.0, 0.0, h + 10.0, doy, sec, d50);
  return r1 > 0.0 && r2 > 0.0 && r1 > r2 ? 10.0 / std::log(r1 / r2) : 50.0;
}

/// The first node (every `step` minutes) where an averaging limit trips, up to `horizon` minutes.
inline Handoff find_handoff(xpt::XpSat& s, double step, double horizon) {
  const pcf::Options& o = pcf::options();
  Handoff h;
  for (double t = 0.0; t <= horizon; t += step) {
    double y[6], f[6];
    if (!xpt::mean_at(s, t, y) || !xpt::rates(s.ctx, t, y, f)) { h.t = std::max(0.0, t - step); h.criterion = 5; return h; }
    const xpt::Frame fr = xpt::frame_of(y);
    const double e = std::sqrt(y[xpt::kAf] * y[xpt::kAf] + y[xpt::kAg] * y[xpt::kAg]);
    const double hp = (fr.a * (1.0 - e) - 1.0) * xpt::kRe;
    const double n = y[xpt::kN], ndot = f[xpt::kN];
    const double adot = -(2.0 / 3.0) * fr.a / n * ndot;  // ER/min
    const double d50 = s.ctx.d50_epoch + t / kMinutesPerDay;
    const double H = scale_height(std::max(hp, 80.0), d50);
    const double eps1 = 4.0 * kPi * std::fabs(adot) * xpt::kRe / (n * H);
    double c3 = 0.0;
    if (e > o.handoff_minimum_e) {
      const double edot = (y[xpt::kAf] * f[xpt::kAf] + y[xpt::kAg] * f[xpt::kAg]) / e;
      const double ae_dot = adot * e + fr.a * edot;
      c3 = std::fabs(ae_dot * kTwoPi / n) / (fr.a * e);
    }
    h.t = t;
    h.perigee_km = hp;
    h.eps1 = eps1;
    if (eps1 > o.handoff_decay_ratio) { h.criterion = 1; return h; }
    if (hp < o.handoff_perigee_km) { h.criterion = 2; return h; }
    if (e > o.handoff_minimum_e && c3 > o.handoff_collapse) { h.criterion = 3; return h; }
    if (e > o.handoff_sawtooth_minimum_e && (3.0 * kPi / 8.0) * std::fabs(adot) * (kTwoPi / n) * xpt::kRe > o.handoff_sawtooth_km) {
      h.criterion = 4;
      return h;
    }
  }
  h.criterion = 0;
  return h;
}

/// The window's fractional 1-sigma (20).
inline double window_fraction(double L_days, double sigma_b) {
  const double r = pcf::options().window_correlation_days / L_days, sd = pcf::options().window_density_sigma;
  const double dens = sd * sd * 2.0 * r * (1.0 - r * (1.0 - std::exp(-1.0 / r)));
  return std::sqrt(sigma_b * sigma_b + dens);
}

/// Osculating integration from the TEME state y0 at the split JD (w, f) down to the reentry altitude, in chunks of 10 s
/// outputs (an hour above 150 km, a minute below it, so that no chunk runs on far below the crossing, where the
/// state leaves the atmosphere's model), up to `max_days`. On success t_r (s from (w, f)), the state there and the
/// geodetic latitude and longitude (deg).
inline bool integrate_down(const osc::Model& base, const double* y0, double max_days, double& t_r, double* xr, double& lat, double& lon) {
  double y[6];
  for (int c = 0; c < 6; ++c) y[c] = y0[c];
  double t0 = 0.0, last_h = 1e9;
  const double hs = pcf::options().osculating_step_s, alt = pcf::options().reentry_altitude_km;
  const int hour_steps = std::max(1, static_cast<int>(std::lround(3600.0 / hs))), minute_steps = std::max(1, static_cast<int>(std::lround(60.0 / hs)));
  std::vector<double> ts(hour_steps + 1), out(6 * (hour_steps + 1));
  while (t0 < max_days * 86400.0) {
    // minute chunks once the osculating perigee is below 150 km (an eccentric orbit dives there within an hour)
    const double rr = std::sqrt(y[0] * y[0] + y[1] * y[1] + y[2] * y[2]), vv2 = y[3] * y[3] + y[4] * y[4] + y[5] * y[5];
    const double mu = 398600.4418, sma = 1.0 / (2.0 / rr - vv2 / mu);
    const double hx[3] = {y[1] * y[5] - y[2] * y[4], y[2] * y[3] - y[0] * y[5], y[0] * y[4] - y[1] * y[3]};
    const double ecc = std::sqrt(std::fmax(0.0, 1.0 - (hx[0] * hx[0] + hx[1] * hx[1] + hx[2] * hx[2]) / (mu * sma)));
    const double perigee_km = sma > 0.0 ? sma * (1.0 - ecc) - xpt::kRe : 0.0;
    const int steps = last_h > 150.0 && perigee_km > 150.0 ? hour_steps : minute_steps;
    osc::Model m = base;
    m.jd_frac = base.jd_frac + t0 / 86400.0;
    for (int k = 0; k <= steps; ++k) ts[k] = hs * k;
    if (!osc::states(m, y, nullptr, 0, ts.data(), steps + 1, out.data(), hs)) {
      // a chunk that ran into the ground (a high B_eff falls through 80 km within the hour): again in minute chunks
      if (steps == minute_steps) return false;
      last_h = 0.0;
      continue;
    }
    double prev_h = 1e9;
    for (int k = 0; k <= steps; ++k) {
      const double* q = out.data() + 6 * k;
      double phi, h;
      drag::geodetic(q[0] / xpt::kRe, q[1] / xpt::kRe, q[2] / xpt::kRe, phi, h);
      if (h <= alt) {
        // linear in height between the outputs
        const double w = k == 0 || prev_h == 1e9 ? 0.0 : (prev_h - alt) / (prev_h - h);
        const double* p = out.data() + 6 * (k > 0 ? k - 1 : 0);
        for (int c = 0; c < 6; ++c) xr[c] = p[c] + w * (q[c] - p[c]);
        t_r = t0 + hs * (k > 0 ? k - 1 : 0) + w * hs;
        double ph, hh;
        drag::geodetic(xr[0] / xpt::kRe, xr[1] / xpt::kRe, xr[2] / xpt::kRe, ph, hh);
        const double theta = gmst(base.jd_whole, base.jd_frac + t_r / 86400.0);
        double l = std::atan2(xr[1], xr[0]) - theta;
        l -= kTwoPi * std::floor((l + kPi) / kTwoPi);
        lat = ph / kDeg;
        lon = l / kDeg;
        return true;
      }
      prev_h = h;
      last_h = h;
    }
    for (int c = 0; c < 6; ++c) y[c] = out[6 * steps + c];
    t0 += hs * steps;
  }
  return false;
}

}  // namespace reentry
}  // namespace sdnap

extern "C" int reentry(void) {
  using namespace sdnap;
  plugin_reset_output_state();
  if (const int rc = pcf::read(pcf::kReentry)) return rc;
  const pcf::Options& po = pcf::options();
  bool have_spw = false, have_dcl = false;
  if (const int st = envload::apply_frames(have_spw, have_dcl)) return st;
  const uint32_t frames = plugin_get_input_count();
  for (uint32_t fi = 0; fi < frames; ++fi) {
    const plugin_input_frame_t* f = plugin_get_input_frame(fi);
    if (f == nullptr || f->port_id == nullptr || std::strcmp(f->port_id, "omm") != 0) continue;
    ElementRow row{};
    if (!omm::decode(f->payload, f->payload_length, row)) {
      plugin_set_error(omm::center_refused() ? "unsupported-center" : "invalid-omm", "Reentry is predicted for Earth SGP4XP or SDN-AP $OMM sets.");
      return 3;
    }
    const uint8_t* p = f->payload;
    if (f->payload_length >= 12 && std::memcmp(p + 4, "$OMM", 4) != 0 && std::memcmp(p + 8, "$OMM", 4) == 0) p += 4;
    const OMM* rec = GetOMM(p);
    // sigma_B / B: REENTRY.WINDOW_BALLISTIC_SIGMA when set, else the set's own fitted USER_DEFINED_SDNAP_B_EFF_SIGMA,
    // else the default 0.05
    double sigma_b = po.window_ballistic_sigma;
    if (!po.window_ballistic_set)
      if (const auto* ud = rec->USER_DEFINED_PARAMETERS())
        for (const OMMUserDefinedParameter* q : *ud)
          if (q != nullptr && q->PARAM_NAME() != nullptr && q->PARAM_VALUE() != nullptr && std::strcmp(q->PARAM_NAME()->c_str(), "SDNAP_B_EFF_SIGMA") == 0 && row.bterm != 0.0)
            sigma_b = std::fabs(std::strtod(q->PARAM_VALUE()->c_str(), nullptr) / row.bterm);
    const Elements e = elements_of(row);
    if (e.theory != kTheorySgp4Xp && e.theory != kTheorySdnAp) { plugin_set_error("unsupported-theory", "Reentry is predicted for SGP4XP and SDN-AP sets."); return 3; }
    if (const int tc = pcf::check_set_theory(e.theory)) return tc;
    // a lowering set (2c.2: tau0 fitted, sustained after the arc) decays by its thrust, B_eff at its prior
    const bool lowering = e.theory == kTheorySdnAp && (e.flags & kFlagLowering) != 0 && e.tau0 < 0.0;
    if (!(e.bterm > 0.0) && !lowering) {
      plugin_set_error("no-drag", "The set carries no positive B_eff (BSTAR as BTERM) and no lowering thrust (USER_DEFINED_SDNAP_LOWERING with a negative _TAU0); it does not decay.");
      return 3;
    }
    xpt::XpSat* s = static_cast<xpt::XpSat*>(std::calloc(1, sizeof(xpt::XpSat)));
    drag::table();
    if (s == nullptr || xpt::xp_init(e, *s) != kPropOk) {
      if (s != nullptr) { xpt::xp_release(*s); std::free(s); }
      plugin_set_error("element-set-refused", "The set is refused at initialization.");
      return 3;
    }
    const reentry::Handoff h = reentry::find_handoff(*s, po.node_step_min, po.horizon_days * kMinutesPerDay);
    double xh[6];
    const bool have_state = h.criterion != 0 && xpt::xp_propagate(*s, h.t, xh, xh + 3) == kPropOk;
    xpt::xp_release(*s);
    std::free(s);
    if (h.criterion == 0) {
      char why[160];
      std::snprintf(why, sizeof why, "No averaging limit trips within %g days (REENTRY.HORIZON_DAYS): no reentry predicted in that horizon.", po.horizon_days);
      plugin_set_error("no-reentry", why);
      return 3;
    }
    if (!have_state) { plugin_set_error("handoff-failed", "The set gives no state at the hand-off."); return 3; }
    osc::Model m;
    m.jd_whole = e.epoch_jd_whole;
    m.jd_frac = e.epoch_jd_frac + h.t / kMinutesPerDay;
    m.bterm = std::fmax(e.bterm, 0.0);
    m.agom = e.agom;
    if (lowering) m.sustained_v = e.tau0 * 1e-3;  // m/s^2 -> km/s^2, along V as the averaged phase carries it
    double t_r = 0.0, xr[6], lat = 0.0, lon = 0.0;
    // the reentry within the horizon of the set's epoch (REENTRY.HORIZON_DAYS)
    if (!reentry::integrate_down(m, xh, po.horizon_days - h.t / kMinutesPerDay, t_r, xr, lat, lon)) {
      char why[260];
      static const char* const names[] = {"none", "C1", "C2", "C3", "C4", "the theory refusing the next node"};
      std::snprintf(why, sizeof why, "The osculating integration from the hand-off (%.3f d after the set's epoch, %s, perigee %.1f km) does not reach %.0f km within the %g-day horizon (REENTRY.HORIZON_DAYS).",
                    h.t / kMinutesPerDay, names[h.criterion], h.perigee_km, po.reentry_altitude_km, po.horizon_days);
      plugin_set_error("reentry-not-reached", why);
      return 3;
    }
    // the window, the time to go measured from the data cutoff: the fit arc's end (USER_DEFINED_SDNAP_ARC_END_MIN after
    // the set's epoch, where a fit sets its epoch at the arc's start), the epoch for a set without one; measured from
    // the epoch, a 48-120 h arc kept the window's 1 sigma above 6 h in the last hours (M29)
    const double cutoff_min = e.arc_end_min > 0.0 && e.arc_end_min * 60.0 < h.t * 60.0 + t_r ? e.arc_end_min : 0.0;
    const double L_days = (h.t * 60.0 + t_r - cutoff_min * 60.0) / 86400.0, life_days = (h.t * 60.0 + t_r) / 86400.0;
    const double frac_sigma = reentry::window_fraction(L_days, sigma_b);
    const double sigma_days = frac_sigma * L_days;
    char t_text[48], w0[48], w1[48], hand[48], comment[400], method[260], source[160];
    oem::iso_text(m.jd_whole, m.jd_frac, t_r / 60.0, t_text, sizeof t_text);
    oem::iso_text(m.jd_whole, m.jd_frac, t_r / 60.0 - sigma_days * kMinutesPerDay, w0, sizeof w0);
    oem::iso_text(m.jd_whole, m.jd_frac, t_r / 60.0 + sigma_days * kMinutesPerDay, w1, sizeof w1);
    oem::iso_text(m.jd_whole, m.jd_frac, 0.0, hand, sizeof hand);
    static const char* kWhy[] = {"none", "C1 decay over a step against the scale height", "C2 perigee below the hand-off height", "C3 eccentricity collapsing",
                                 "C4 the perigee-pass sawtooth of an eccentric orbit", "the theory refused the next node"};
    std::snprintf(comment, sizeof comment, "SDN-AP reentry (DESIGN 5.2): averaged until %.3f d after the set's epoch (%s; perigee %.1f km, eps1 %.4f), then osculating integration to %.0f km",
                  h.t / kMinutesPerDay, kWhy[h.criterion], h.perigee_km, h.eps1, po.reentry_altitude_km);
    std::snprintf(method, sizeof method, "linear (DESIGN 5.2.3, eq. 20): sigma_B/B %.3f, density sigma %.2f with tau %.0f d; 1 sigma %.2f %% of the %.3f d to go from the data cutoff (%.3f d after the set's epoch)",
                  sigma_b, po.window_density_sigma, po.window_correlation_days, 100.0 * frac_sigma, L_days, cutoff_min / kMinutesPerDay);
    std::snprintf(source, sizeof source, "SDN-AP set of epoch %s (B_eff %.6g m^2/kg)", rec->EPOCH() != nullptr ? rec->EPOCH()->c_str() : "?", e.bterm);
    flatbuffers::FlatBufferBuilder fbb(1024);
    const auto s_vers = fbb.CreateString("1.0");
    const auto s_orig = fbb.CreateString("SDN");
    const auto s_name = rec->OBJECT_NAME() != nullptr ? fbb.CreateString(rec->OBJECT_NAME()->c_str()) : 0;
    const auto s_id = rec->OBJECT_ID() != nullptr ? fbb.CreateString(rec->OBJECT_ID()->c_str()) : 0;
    const auto s_epoch = fbb.CreateString(t_text);
    const auto s_utc = fbb.CreateString("UTC");
    const auto s_teme = fbb.CreateString("TEME");
    const auto s_hand = fbb.CreateString(hand);
    const auto s_state = CreatereentryStateVector(fbb, s_hand, s_teme, xh[0], xh[1], xh[2], xh[3], xh[4], xh[5]);
    const auto s_comment = fbb.CreateString(comment);
    const auto s_center = fbb.CreateString("EARTH");
    const auto s_grav = fbb.CreateString("EGM96 20 x 20");
    const auto s_atm = fbb.CreateString("NRLMSISE-00 x exp(s(t)) (the $SPW, $DCL environment of this invocation)");
    const auto s_nbody = fbb.CreateString("Sun, Moon (SPEC 5 series)");
    const auto s_srp = fbb.CreateString("radial, AGOM, cylindrical shadow");
    const auto s_source = fbb.CreateString(source);
    const auto s_method = fbb.CreateString(method);
    const auto s_w0 = fbb.CreateString(w0);
    const auto s_w1 = fbb.CreateString(w1);
    RDMBuilder b(fbb);
    b.add_CCSDS_RDM_VERS(s_vers);
    b.add_ORIGINATOR(s_orig);
    if (!s_name.IsNull()) b.add_OBJECT_NAME(s_name);
    if (!s_id.IsNull()) b.add_OBJECT_ID(s_id);
    if (row.norad_cat_id != 0) b.add_NORAD_CAT_ID(row.norad_cat_id);
    b.add_DISPOSITION(reentryDisposition_UNCONTROLLED);
    b.add_REASON(reentryReason_NATURAL_DECAY);
    b.add_REENTRY_EPOCH(s_epoch);
    b.add_REENTRY_EPOCH_UNC(sigma_days * 24.0);  // hours (the schema's unit)
    b.add_REENTRY_LATITUDE(lat);
    b.add_REENTRY_LONGITUDE(lon);
    b.add_REENTRY_ALTITUDE(po.reentry_altitude_km);
    b.add_TIME_SYSTEM(s_utc);
    b.add_BALLISTIC_COEFF(1.0 / e.bterm);  // kg/m^2 = m / (C_D A) = 1 / B_eff
    b.add_INITIAL_STATE(s_state);
    b.add_COMMENT(s_comment);
    b.add_CONTROLLED_REENTRY(rdmControlledReentry_NO);
    b.add_CENTER_NAME(s_center);
    b.add_GRAVITY_MODEL(s_grav);
    b.add_ATMOSPHERIC_MODEL(s_atm);
    b.add_N_BODY_PERTURBATIONS(s_nbody);
    b.add_SOLAR_RAD_PRESSURE(s_srp);
    b.add_DRAG_PARAMETERS_SOURCE(s_source);
    b.add_DRAG_PARAMETERS_ALTITUDE(h.perigee_km);
    b.add_REENTRY_UNCERTAINTY_METHOD(s_method);
    b.add_ORBIT_LIFETIME(life_days);  // from the set's epoch; the window's sigma from the data cutoff
    b.add_ORBIT_LIFETIME_WINDOW_START(life_days - sigma_days);
    b.add_ORBIT_LIFETIME_WINDOW_END(life_days + sigma_days);
    b.add_ORBIT_LIFETIME_CONFIDENCE_LEVEL(68.27);
    b.add_REENTRY_WINDOW_START(s_w0);
    b.add_REENTRY_WINDOW_END(s_w1);
    FinishRDMBuffer(fbb, b.Finish());
    if (plugin_push_output("reentry", "RDM.fbs", "$RDM", fbb.GetBufferPointer(), fbb.GetSize()) < 0) {
      plugin_set_error("output-failed", "The $RDM could not be emitted.");
      return 3;
    }
  }
  return 0;
}

/// Diagnostic (the reentry reference, M28): osculating integration from the TEME state y0 at the UTC split JD
/// (whole, frac) with B_eff and AGOM down to 80 km, without the averaged phase; returns the seconds to reentry
/// (negative when 80 km is not reached within `max_days`) and writes latitude and longitude (deg) into ll.
SDNAP_EXPORT("sdnap_reentry_reference")
double sdnap_reentry_reference(double whole, double frac, const double* y0, double bterm, double agom, double max_days, double* ll) {
  using namespace sdnap;
  osc::Model m;
  m.jd_whole = whole;
  m.jd_frac = frac;
  m.bterm = bterm;
  m.agom = agom;
  drag::table();
  double t_r = 0.0, xr[6], lat = 0.0, lon = 0.0;
  if (!reentry::integrate_down(m, y0, max_days, t_r, xr, lat, lon)) return -1.0;
  if (ll) { ll[0] = lat; ll[1] = lon; }
  return t_r;
}
