// -----------------------------------------------------------------------------
// The `maneuver` method (DESIGN 5.1.1 - 5.1.3): an Earth SGP4XP or SDN-AP set
// across the burns of its $MNV records, in time order. Each record gives the
// burn's EVENT_START_TIME, its duration (EVENT_END_TIME, or TOTAL_BURN_TIME in
// seconds; none: an impulse) and DELTA_VEL_U/V/W (km/s, UVW of the
// pre-maneuver state). Outputs: the post-maneuver $OMM of every burn on
// 'elements' (epoch the burn's centroid), the $MNV of every burn on
// 'maneuvers' with PRE_EVENT and POST_EVENT states (TEME), and, with a 'grid',
// the TEME states across the burns on 'ephemeris'.
// -----------------------------------------------------------------------------

namespace sdnap {
namespace evm {

struct Burn {
  double start_w = 0, start_f = 0;   ///< EVENT_START_TIME, UTC split JD
  double duration_s = 0;
  double dv[3] = {0, 0, 0};          ///< km/s UVW
  const MNV* source = nullptr;
};

/// Minutes from the set's epoch to the split JD (w, f).
inline double minutes_from(const Elements& e, double w, double f) { return ((w - e.epoch_jd_whole) + (f - e.epoch_jd_frac)) * kMinutesPerDay; }

/// The $OMM of an Earth set (identity from the input record `tmpl`); SDN-AP parameters as USER_DEFINED_x.
inline int push_set(const Elements& e, const OMM* tmpl, const char* comment) {
  flatbuffers::FlatBufferBuilder fbb(1024);
  char epoch_text[48];
  oem::iso_text(e.epoch_jd_whole, e.epoch_jd_frac, 0.0, epoch_text, sizeof epoch_text);
  const bool sdnap_set = e.theory == kTheorySdnAp;
  std::vector<flatbuffers::Offset<OMMUserDefinedParameter>> ps;
  char v[64];
  auto put = [&](const char* name, double value) {
    std::snprintf(v, sizeof v, "%.17g", value);
    ps.push_back(CreateOMMUserDefinedParameterDirect(fbb, name, v));
  };
  if (sdnap_set) {
    put("SDNAP_B_EFF", e.bterm);
    put("SDNAP_KAPPA", e.kappa);
    put("SDNAP_TAU0", e.tau0);
    put("SDNAP_TAUC", e.tauc);
    put("SDNAP_TAUS", e.taus);
    put("SDNAP_ARC_END_MIN", e.arc_end_min);
    if (e.flags & kFlagLowering) put("SDNAP_LOWERING", 1.0);
    if (e.flags & kFlagTauHeld) put("SDNAP_TAU_HELD", 1.0);
  }
  const auto s_user = sdnap_set ? fbb.CreateVector(ps) : 0;
  const auto s_epoch = fbb.CreateString(epoch_text);
  const auto s_comment = fbb.CreateString(comment);
  const auto s_center = fbb.CreateString("EARTH");
  const auto s_orig = tmpl->ORIGINATOR() != nullptr ? fbb.CreateString(tmpl->ORIGINATOR()->c_str()) : fbb.CreateString("SDN");
  const auto s_frame = CreateRFMDirect(fbb, RFMUnion_NONE, 0, 0, "TEME");
  const auto s_id = tmpl->OBJECT_ID() != nullptr ? fbb.CreateString(tmpl->OBJECT_ID()->c_str()) : 0;
  const auto s_name = tmpl->OBJECT_NAME() != nullptr ? fbb.CreateString(tmpl->OBJECT_NAME()->c_str()) : 0;
  const double unix_seconds = ((e.epoch_jd_whole - 2440587.5) + e.epoch_jd_frac) * 86400.0, whole_seconds = std::floor(unix_seconds);
  OMMBuilder b(fbb);
  b.add_ORIGINATOR(s_orig);
  b.add_CENTER_NAME(s_center);
  b.add_REFERENCE_FRAME(s_frame);
  b.add_TIME_SYSTEM(timingStandard_UTC);
  b.add_MEAN_ELEMENT_THEORY(sdnap_set ? meanElementSource_SDNAP : meanElementSource_SGP4XP);
  if (e.norad != 0) b.add_NORAD_CAT_ID(e.norad);
  if (!s_id.IsNull()) b.add_OBJECT_ID(s_id);
  if (!s_name.IsNull()) b.add_OBJECT_NAME(s_name);
  b.add_COMMENT(s_comment);
  b.add_EPOCH(s_epoch);
  b.add_MEAN_MOTION(e.xno * kMinutesPerDay / kTwoPi);
  b.add_ECCENTRICITY(e.eo);
  b.add_INCLINATION(e.xincl / kDeg);
  b.add_RA_OF_ASC_NODE(e.xnodeo / kDeg);
  b.add_ARG_OF_PERICENTER(e.omegao / kDeg);
  b.add_MEAN_ANOMALY(e.xmo / kDeg);
  b.add_BSTAR(e.bterm);
  b.add_MEAN_MOTION_DDOT(e.agom);
  b.add_USER_DEFINED_EPOCH_TIMESTAMP(whole_seconds);
  b.add_USER_DEFINED_MICROSECONDS(std::round((unix_seconds - whole_seconds) * 1e6));
  if (sdnap_set) b.add_USER_DEFINED_PARAMETERS(s_user);
  FinishOMMBuffer(fbb, b.Finish());
  if (plugin_push_output("elements", "OMM.fbs", "$OMM", fbb.GetBufferPointer(), fbb.GetSize()) < 0) {
    plugin_set_error("output-failed", "The $OMM could not be emitted.");
    return 3;
  }
  return 0;
}

/// An mnvOrbitalState of a TEME state (osculating elements about mu_xp; APOGEE and PERIGEE heights above R_E).
inline flatbuffers::Offset<mnvOrbitalState> orbital_state(flatbuffers::FlatBufferBuilder& fbb, const double* r, const double* v, double bterm,
                                                          const char* id_elset) {
  double el[6] = {0, 0, 0, 0, 0, 0};
  segment::elements_of(events::mu_xp(), r, v, el);
  const double a = el[0], e = el[1];
  const auto s_id = fbb.CreateString(id_elset);
  mnvOrbitalStateBuilder s(fbb);
  s.add_ID_ELSET(s_id);
  s.add_POS_X(r[0]); s.add_POS_Y(r[1]); s.add_POS_Z(r[2]);
  s.add_VEL_X(v[0]); s.add_VEL_Y(v[1]); s.add_VEL_Z(v[2]);
  if (bterm > 0.0) s.add_BALLISTIC_COEFF(1.0 / bterm);  // kg/m^2 = m / (C_D A) = 1 / B_eff
  if (e < 1.0) {
    s.add_APOGEE(a * (1.0 + e) - xpt::kRe);
    s.add_PERIGEE(a * (1.0 - e) - xpt::kRe);
    s.add_PERIOD(kTwoPi * std::sqrt(a * a * a / events::mu_xp()) / 60.0);
  }
  s.add_INCLINATION(el[2] / kDeg);
  s.add_ECCENTRICITY(e);
  s.add_RAAN(el[3] / kDeg);
  s.add_SMA(a);
  return s.Finish();
}

inline maneuverCharacterization characterize(const double* dv) {
  const double m = std::sqrt(dv[0] * dv[0] + dv[1] * dv[1] + dv[2] * dv[2]);
  if (!(m > 0.0)) return maneuverCharacterization_UNKNOWN;
  if (std::fabs(dv[2]) > 0.9 * m) return maneuverCharacterization_OUT_OF_PLANE;
  if (std::fabs(dv[2]) > 0.1 * m) return maneuverCharacterization_COMBINED;
  if (std::fabs(dv[1]) > 0.9 * m) return dv[1] > 0.0 ? maneuverCharacterization_ORBIT_RAISING : maneuverCharacterization_ORBIT_LOWERING;
  return maneuverCharacterization_IN_PLANE;
}

inline int push_mnv(const Burn& burn, const Elements& pre, const Elements& post, const events::Boundary& bd, const char* model,
                    const char* algorithm_override = nullptr) {
  flatbuffers::FlatBufferBuilder fbb(1024);
  char start[48], end[48], id_pre[96], id_post[96], epre[48], epost[48], algorithm[200];
  oem::iso_text(burn.start_w, burn.start_f, 0.0, start, sizeof start);
  oem::iso_text(burn.start_w, burn.start_f, burn.duration_s / 60.0, end, sizeof end);
  oem::iso_text(pre.epoch_jd_whole, pre.epoch_jd_frac, 0.0, epre, sizeof epre);
  oem::iso_text(post.epoch_jd_whole, post.epoch_jd_frac, 0.0, epost, sizeof epost);
  std::snprintf(id_pre, sizeof id_pre, "%u %s", static_cast<unsigned>(pre.norad), epre);
  std::snprintf(id_post, sizeof id_post, "%u %s", static_cast<unsigned>(post.norad), epost);
  if (burn.duration_s > 0.0)
    std::snprintf(algorithm, sizeof algorithm, "SDN-AP finite burn (DESIGN 5.1.2, eq. 15): the impulse map at the centroid, eccentricity-vector and plane changes x sinc(dL/2) = %.9f; %d inverse-map steps", bd.sinc, bd.iterations);
  else
    std::snprintf(algorithm, sizeof algorithm, "SDN-AP impulse map (DESIGN 5.1.1, eq. 14): post set = h^-1(x(t_b) + (0, dv), t_b); %d inverse-map steps", bd.iterations);
  const MNV* in = burn.source;
  const auto s_id = in->ID() != nullptr ? fbb.CreateString(in->ID()->c_str()) : 0;
  const auto s_obj = in->ORIG_OBJECT_ID() != nullptr ? fbb.CreateString(in->ORIG_OBJECT_ID()->c_str()) : 0;
  const auto s_start = fbb.CreateString(start);
  const auto s_end = fbb.CreateString(end);
  const auto s_model = fbb.CreateString(model);
  const auto s_alg = fbb.CreateString(algorithm_override != nullptr ? algorithm_override : algorithm);
  const auto s_pre = orbital_state(fbb, bd.r_pre, bd.v_pre, pre.bterm, id_pre);
  const auto s_post = orbital_state(fbb, bd.r_post, bd.v_post, post.bterm, id_post);
  MNVBuilder b(fbb);
  if (!s_id.IsNull()) b.add_ID(s_id);
  b.add_SAT_NO(in->SAT_NO() != 0 ? in->SAT_NO() : pre.norad);
  if (!s_obj.IsNull()) b.add_ORIG_OBJECT_ID(s_obj);
  b.add_STATUS(in->STATUS());
  b.add_CHARACTERIZATION(characterize(burn.dv));  // from the Delta v direction (DESIGN 5.1.3)
  b.add_EVENT_START_TIME(s_start);
  if (burn.duration_s > 0.0) b.add_EVENT_END_TIME(s_end);
  if (burn.duration_s > 0.0) b.add_TOTAL_BURN_TIME(burn.duration_s);
  b.add_DELTA_VEL(std::sqrt(burn.dv[0] * burn.dv[0] + burn.dv[1] * burn.dv[1] + burn.dv[2] * burn.dv[2]));
  b.add_DELTA_VEL_U(burn.dv[0]);
  b.add_DELTA_VEL_V(burn.dv[1]);
  b.add_DELTA_VEL_W(burn.dv[2]);
  b.add_PRE_EVENT(s_pre);
  b.add_POST_EVENT(s_post);
  b.add_STATE_MODEL(s_model);
  b.add_STATE_MODEL_VERSION(1.0);
  b.add_ALGORITHM(s_alg);
  FinishMNVBuffer(fbb, b.Finish());
  if (plugin_push_output("maneuvers", "MNV.fbs", "$MNV", fbb.GetBufferPointer(), fbb.GetSize()) < 0) {
    plugin_set_error("output-failed", "The $MNV could not be emitted.");
    return 3;
  }
  return 0;
}

}  // namespace evm
}  // namespace sdnap

extern "C" int maneuver(void) {
  using namespace sdnap;
  plugin_reset_output_state();
  if (const int rc = pcf::read(pcf::kManeuver)) return rc;
  {
    bool have_spw = false, have_dcl = false;
    if (const int st = envload::apply_frames(have_spw, have_dcl)) return st;
  }
  std::vector<oem::Grid> grids;
  bool want_grid = false;
  {
    const uint32_t frames = plugin_get_input_count();
    for (uint32_t i = 0; i < frames; ++i) {
      const plugin_input_frame_t* f = plugin_get_input_frame(i);
      if (f != nullptr && f->port_id != nullptr && std::strcmp(f->port_id, "grid") == 0) want_grid = true;
    }
  }
  if (want_grid) {
    if (const int rc = oem::read_grids(grids)) return rc;
  }
  const OMM* tmpl = nullptr;
  ElementRow row{};
  std::vector<evm::Burn> burns;
  const uint32_t frames = plugin_get_input_count();
  for (uint32_t i = 0; i < frames; ++i) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (f == nullptr || f->port_id == nullptr) continue;
    if (std::strcmp(f->port_id, "omm") == 0) {
      if (tmpl != nullptr) {
        plugin_set_error("too-many-sets", "The 'maneuver' method takes one $OMM.");
        return 3;
      }
      if (!omm::decode(f->payload, f->payload_length, row)) {
        plugin_set_error(omm::center_refused() ? "unsupported-center" : "invalid-omm",
                         omm::center_refused() ? "Maneuvers are applied to Earth sets (CENTER_NAME EARTH)." : "The 'omm' payload is not a decodable SGP4XP or SDN-AP $OMM.");
        return 3;
      }
      const uint8_t* p = f->payload;
      uint32_t n = f->payload_length;
      if (n >= 8 && std::memcmp(p + 4, "$OMM", 4) != 0 && std::memcmp(p + 8, "$OMM", 4) == 0) { p += 4; n -= 4; }
      tmpl = GetOMM(p);
    } else if (std::strcmp(f->port_id, "maneuvers") == 0) {
      const uint8_t* p = f->payload;
      uint32_t n = f->payload_length;
      if (n >= 12 && std::memcmp(p + 4, "$MNV", 4) != 0 && std::memcmp(p + 8, "$MNV", 4) == 0) { p += 4; n -= 4; }
      flatbuffers::Verifier verifier(p, n);
      if (!VerifyMNVBuffer(verifier)) {
        plugin_set_error("invalid-mnv", "A 'maneuvers' payload is not a verifiable SDS $MNV.");
        return 3;
      }
      const MNV* m = GetMNV(p);
      evm::Burn b;
      b.source = m;
      if (m->EVENT_START_TIME() == nullptr || !omm::epoch(m->EVENT_START_TIME()->c_str(), m->EVENT_START_TIME()->size(), b.start_w, b.start_f)) {
        plugin_set_error("invalid-mnv", "A $MNV has no readable EVENT_START_TIME.");
        return 3;
      }
      double ew = 0, ef = 0;
      if (m->EVENT_END_TIME() != nullptr && omm::epoch(m->EVENT_END_TIME()->c_str(), m->EVENT_END_TIME()->size(), ew, ef))
        b.duration_s = ((ew - b.start_w) + (ef - b.start_f)) * 86400.0;
      else if (m->TOTAL_BURN_TIME() > 0.0)
        b.duration_s = m->TOTAL_BURN_TIME();
      if (b.duration_s < 0.0) {
        plugin_set_error("invalid-mnv", "A $MNV ends before it starts.");
        return 3;
      }
      b.dv[0] = m->DELTA_VEL_U();
      b.dv[1] = m->DELTA_VEL_V();
      b.dv[2] = m->DELTA_VEL_W();
      burns.push_back(b);
    }
  }
  if (tmpl == nullptr || burns.empty()) {
    plugin_set_error("missing-input", "The 'maneuver' method takes one 'omm' and at least one 'maneuvers' $MNV.");
    return 3;
  }
  Elements cur = elements_of(row);
  if (cur.theory != kTheorySgp4Xp && cur.theory != kTheorySdnAp) {
    plugin_set_error("unsupported-theory", "Maneuvers are applied to SGP4XP and SDN-AP sets (MEAN_ELEMENT_THEORY SGP4XP or SDNAP).");
    return 3;
  }
  if (const int tc = pcf::check_set_theory(cur.theory)) return tc;
  std::stable_sort(burns.begin(), burns.end(), [](const evm::Burn& a, const evm::Burn& b) {
    return (a.start_w - b.start_w) + (a.start_f - b.start_f) < 0.0;
  });
  const char* model = cur.theory == kTheorySdnAp ? "SDN-AP" : "SGP4XP";
  std::vector<Elements> chain{cur};
  std::vector<double> starts;  // the segments' start, minutes from the first set's epoch
  starts.push_back(-1e300);
  const Elements first = cur;
  for (const evm::Burn& b : burns) {
    const double t_c = evm::minutes_from(cur, b.start_w, b.start_f) + 0.5 * b.duration_s / 60.0;
    if (t_c < 0.0) {
      plugin_set_error("maneuver-before-epoch", "A $MNV's burn lies before the set's epoch (or before the previous burn).");
      return 3;
    }
    Elements post{};
    events::Boundary bd;
    if (!events::maneuver_map(cur, t_c, b.dv, b.duration_s, post, bd)) {
      plugin_set_error("maneuver-failed", "The inverse map did not converge at a burn (or the set does not reach it).");
      return 3;
    }
    char comment[200];
    std::snprintf(comment, sizeof comment, "%s set after a %s of %.6f m/s (U %.6f, V %.6f, W %.6f) at its epoch; DESIGN 5.1", model,
                  b.duration_s > 0.0 ? "finite burn" : "impulse", 1000.0 * std::sqrt(b.dv[0] * b.dv[0] + b.dv[1] * b.dv[1] + b.dv[2] * b.dv[2]),
                  1000.0 * b.dv[0], 1000.0 * b.dv[1], 1000.0 * b.dv[2]);
    if (const int rc = evm::push_set(post, tmpl, comment)) return rc;
    if (const int rc = evm::push_mnv(b, cur, post, bd, model)) return rc;
    starts.push_back(evm::minutes_from(first, post.epoch_jd_whole, post.epoch_jd_frac));
    chain.push_back(post);
    cur = post;
  }
  if (!want_grid) return 0;
  // the states across the burns: each grid epoch from the set in force (TEME)
  size_t budget = pcf::options().maximum_states;
  std::vector<xpt::XpSat*> sats;
  drag::table();
  for (const Elements& e : chain) {
    xpt::XpSat* s = static_cast<xpt::XpSat*>(std::malloc(sizeof(xpt::XpSat)));
    if (s == nullptr || xpt::xp_init(e, *s) != kPropOk) {
      for (xpt::XpSat* q : sats) { xpt::xp_release(*q); std::free(q); }
      if (s != nullptr) xpt::xp_release(*s);
      std::free(s);
      plugin_set_error("element-set-refused", "A set of the chain is refused.");
      return 3;
    }
    sats.push_back(s);
  }
  flatbuffers::FlatBufferBuilder fbb(1 << 16);
  std::vector<flatbuffers::Offset<ephemerisDataBlock>> blocks;
  int rc = 0;
  for (const oem::Grid& g : grids) {
    if (g.axes != oem::Axes::Teme && g.axes != oem::Axes::Undeclared) { rc = oem::refuse("invalid-grid", "The 'maneuver' method writes TEME states."); break; }
    std::vector<double> tw, tf;
    if ((rc = oem::grid_epochs(g, first.epoch_jd_whole, first.epoch_jd_frac, budget, tw, tf))) break;
    std::vector<flatbuffers::Offset<ephemerisDataLine>> lines;
    char text[48];
    for (size_t k = 0; k < tw.size() && rc == 0; ++k) {
      const double t = evm::minutes_from(first, tw[k], tf[k]);
      size_t seg = 0;
      while (seg + 1 < starts.size() && starts[seg + 1] <= t) ++seg;
      const double ts = seg == 0 ? t : evm::minutes_from(chain[seg], tw[k], tf[k]);
      double r[3], v[3];
      if (xpt::xp_propagate(*sats[seg], ts, r, v) != kPropOk) { rc = oem::refuse("propagation-failed", "A set of the chain does not propagate to a grid epoch."); break; }
      oem::iso_text(tw[k], tf[k], 0.0, text, sizeof text);
      lines.push_back(CreateephemerisDataLineDirect(fbb, text, r[0], r[1], r[2], v[0], v[1], v[2]));
    }
    if (rc) break;
    char start[48], stop[48];
    oem::iso_text(tw.front(), tf.front(), 0.0, start, sizeof start);
    oem::iso_text(tw.back(), tf.back(), 0.0, stop, sizeof stop);
    const auto frame = CreateRFMDirect(fbb, RFMUnion_NONE, 0, 0, "TEME");
    blocks.push_back(CreateephemerisDataBlockDirect(fbb, nullptr, 0, "EARTH", frame, nullptr, 0, timingStandard_UTC, start, nullptr, nullptr, stop,
                                                    nullptr, 0, g.explicit_times ? 0.0 : g.step, 6, nullptr, &lines));
  }
  for (xpt::XpSat* q : sats) { xpt::xp_release(*q); std::free(q); }
  if (rc) return rc;
  return oem::push_oem(fbb, blocks);
}

// -----------------------------------------------------------------------------
// The `detect_maneuvers` method (DESIGN 5.1.4): the six-element generalized
// likelihood ratio (Willsky & Jones 1976) on the innovations of the theory's
// own inverse, e_k = h^-1(x_k, t_k) - y(t_k), against the signature of a burn
// at t_b, M_k Delta v = Phi(t_k, t_b) G(t_b) Delta v (G = dy/dv at t_b, Phi the
// theory's own transition, so the lambda ramp of the n step and the secular
// drifts the burn changes): F = sum M^T W M, g = sum M^T W e, Delta v = F^-1 g,
// Lambda = g^T F^-1 g (16), W the robust (MAD) inverse variances of e. A burn
// is declared when the largest Lambda exceeds the threshold; the two-segment
// estimate (the pre-burn arc's own fit, its innovations searched again within
// two hours) starts the joint segment fit: y_0, Delta v and t_b over the whole
// arc, the post-burn set the impulse map of y_0 at t_b.
// -----------------------------------------------------------------------------

namespace sdnap {
namespace evd {

/// Osculating equinoctial elements in the theory's state order (a_f, a_g, chi, psi, lambda, n rad/min).
inline bool eq_internal(const double* r, const double* v, double* y) {
  double q[6];
  if (!events::eq_of_state(r, v, q)) return false;
  y[0] = q[1]; y[1] = q[2]; y[2] = q[3]; y[3] = q[4]; y[4] = q[5]; y[5] = q[0];
  return true;
}

/// The inverse of the output map at time t: the mean state whose output at t is (r, v), from y (in and out).
inline bool inverse_at(const xpt::XpSat& s, double t, const double* r, const double* v, double* y) {
  double target[6];
  if (!eq_internal(r, v, target)) return false;
  for (int it = 0; it < 12; ++it) {
    double ro[3], vo[3], q[6];
    if (xpt::output(s.ctx, t, y, ro, vo, nullptr) != kPropOk || !eq_internal(ro, vo, q)) return false;
    double worst = 0.0;
    for (int j = 0; j < 6; ++j) {
      double d = target[j] - q[j];
      if (j == 4) d = std::remainder(d, kTwoPi);
      y[j] += d;
      worst = std::fmax(worst, std::fabs(d) / (j == 5 ? std::fabs(y[5]) : 1.0));
    }
    if (worst < 1e-14) return true;
  }
  return true;
}

inline ElementRow row_of(const Elements& e) {
  ElementRow r{};
  r.epoch_jd_whole = e.epoch_jd_whole;
  r.epoch_jd_frac = e.epoch_jd_frac;
  r.mean_motion_rev_day = e.xno * kMinutesPerDay / kTwoPi;
  r.eccentricity = e.eo;
  r.inclination_deg = e.xincl / kDeg;
  r.raan_deg = e.xnodeo / kDeg;
  r.arg_pericenter_deg = e.omegao / kDeg;
  r.mean_anomaly_deg = e.xmo / kDeg;
  r.bterm = e.bterm;
  r.agom = e.agom;
  r.norad_cat_id = e.norad;
  r.theory = e.theory;
  r.kappa = e.kappa;
  r.tau0 = e.tau0;
  r.tauc = e.tauc;
  r.taus = e.taus;
  r.arc_end_min = e.arc_end_min;
  r.flags = e.flags;
  return r;
}

struct Scan {
  int index = -1;           ///< the state after which the burn lies
  double lambda = 0.0, t_b = 0.0, dv[3] = {0, 0, 0}, cov[9] = {};
  double t_lo = 0.0, t_hi = 0.0;  ///< the epochs (min) whose Lambda is within 3.84 of the best (the 95 % profile interval)
  double fdiag[3] = {0, 0, 0};    ///< the profiled information's diagonal (U, V, W; (km/s)^-2): the floor sqrt(threshold / F_cc)
  /// the detection statistic: the largest over the candidates of Lambda against the burn-free fit itself (the form whose
  /// false-alarm rate is calibrated: THRESHOLD 20 for 1 per object-year, MANEUVER_DETECTION); the epoch and Delta v
  /// are the profile's (`lambda`, `t_b`, `dv`)
  double detect = 0.0;
};

/// The GLR scan of states (t minutes from the set's epoch, r, v TEME) against the set `row`: innovations, robust
/// weights, then Lambda at every candidate epoch between states with at least `margin` states on either side.
inline bool glr(const ElementRow& row, const std::vector<double>& t, const std::vector<double>& r, const std::vector<double>& v, int margin,
                Scan& best, double* lambdas = nullptr, int lo = 0, int hi = 1 << 30, int noise_until = 1 << 30) {
  const int n = static_cast<int>(t.size());
  xpt::XpSat* s = static_cast<xpt::XpSat*>(std::calloc(1, sizeof(xpt::XpSat)));
  if (s == nullptr) return false;
  drag::table();
  if (xpt::xp_init(elements_of(row), *s) != kPropOk) { xpt::xp_release(*s); std::free(s); return false; }
  std::vector<double> e(6 * n), ym(6 * n);
  bool ok = true;
  for (int k = 0; k < n && ok; ++k) {
    double* y = ym.data() + 6 * k;
    if (!xpt::mean_at(*s, t[k], y)) { ok = false; break; }
    double yi[6];
    for (int j = 0; j < 6; ++j) yi[j] = y[j];
    ok = inverse_at(*s, t[k], r.data() + 3 * k, v.data() + 3 * k, yi);
    for (int j = 0; j < 6; ++j) {
      double d = yi[j] - y[j];
      if (j == 4) d = std::remainder(d, kTwoPi);
      e[6 * k + j] = d;
    }
  }
  // robust weights: 1.4826 MAD per element
  double w[6];
  const int nn = std::max(12, std::min(n, noise_until));  // the noise from the burn-free states (before the burn)
  for (int j = 0; j < 6 && ok; ++j) {
    std::vector<double> sorted(nn);
    for (int k = 0; k < nn; ++k) sorted[k] = e[6 * k + j];
    std::nth_element(sorted.begin(), sorted.begin() + nn / 2, sorted.end());
    const double med = sorted[nn / 2];
    for (double& x : sorted) x = std::fabs(x - med);
    std::nth_element(sorted.begin(), sorted.begin() + nn / 2, sorted.end());
    // the floor: about 1 m of position (1.5e-7 of the radius in the angles and the eccentricity vector, of n in n)
    const double floor = j == 5 ? 1.5e-7 * std::fabs(ym[5]) : 1.5e-7;
    const double sig = std::fmax(1.4826 * sorted[nn / 2], floor);
    w[j] = 1.0 / (sig * sig);
  }
  // the innovations are correlated over a revolution (the theory's own model error): weights per revolution, not per
  // state (DESIGN 5.1.4 (17): the per-period noise), so W is divided by the states per period
  {
    const double period = kTwoPi / row.mean_motion_rev_day * kMinutesPerDay / kTwoPi;  // minutes
    const double dt = (t[n - 1] - t[0]) / (n - 1);
    // ($PCF MANEUVER_DETECTION.CORRELATION_MODEL WHITE: per state)
    const double per = pcf::options().white_innovations ? 1.0 : std::fmax(1.0, period / dt);
    for (double& x : w) x /= per;
  }
  // the theory's own transition (DESIGN 5.1.4: M_k = Phi(t_k, t_b) G(t_b)): S(t) = dy(t)/dx_0 by one-sided differences
  // of six sets perturbed in the epoch elements x_0, Phi(t_k, t_b) = S(t_k) S(t_b)^-1. It carries the lambda ramp of
  // the n step with the secular rates' own dependence on n, e and i (the node's and the perigee's drift after an
  // in-plane burn, the e vector's turning).
  xpt::XpSat* ps = static_cast<xpt::XpSat*>(std::calloc(6, sizeof(xpt::XpSat)));
  if (ps == nullptr) { xpt::xp_release(*s); std::free(s); return false; }
  double hstep[6];
  {
    fit::Options o6{};
    double x0[fit::kMaxParams];
    fit::params_of(row, o6, x0);
    for (int j = 0; j < 6 && ok; ++j) {
      hstep[j] = j == 5 ? 1e-6 * std::fabs(x0[5]) : 1e-6;
      double xj[fit::kMaxParams];
      for (int q = 0; q < 6; ++q) xj[q] = x0[q];
      xj[j] += hstep[j];
      ElementRow rj = row;
      fit::row_of(xj, o6, rj);
      ok = xpt::xp_init(elements_of(rj), ps[j]) == kPropOk;
    }
  }
  auto sens = [&](double tt, const double* y, double* S36) -> bool {
    for (int j = 0; j < 6; ++j) {
      double yj[6];
      if (!xpt::mean_at(ps[j], tt, yj)) return false;
      for (int i = 0; i < 6; ++i) {
        double d = yj[i] - y[i];
        if (i == 4) d = std::remainder(d, kTwoPi);
        S36[6 * i + j] = d / hstep[j];
      }
    }
    return true;
  };
  std::vector<double> Sk(36 * n);
  for (int k = 0; k < n && ok; ++k) ok = sens(t[k], ym.data() + 6 * k, Sk.data() + 36 * k);
  // DESIGN 5.1.4 (16) with the likelihood profiled over the nuisance: the epoch elements and B_eff re-estimated with
  // and without the burn. Linearized, e_k = J_k x + 1(k >= k_b) S_k N dv with J_k = [S_k | s_k^B] (s^B = dy/dB_eff)
  // and N = S(t_b)^-1 G; with A, b the sums of J' W J and J' W e over the arc and A+, b+ those from k_b on,
  // Lambda(t_b) = u' Nt (Nt' P Nt)^-1 Nt' u, P = A+ - A+ A^-1 A+, u = b+ - A+ A^-1 b, Nt = [N; 0]. Held at the
  // burn-free fit instead (the previous form), a burn early in the arc stood in for the epoch-element correction the
  // position fit leaves in the element metric and won on long pre-burn arcs (ISS reboosts, 72 h windows: 5 of 98 at
  // TIG, the rest about 4 h into the window with 7 times the planned Delta v).
  constexpr int kJ = 7;
  std::vector<double> sB(6 * n, 0.0);
  if (ok) {
    xpt::XpSat* pb = static_cast<xpt::XpSat*>(std::calloc(1, sizeof(xpt::XpSat)));
    const double hb = std::fmax(1e-3 * std::fabs(row.bterm), 1e-5);
    ElementRow rb = row;
    rb.bterm += hb;
    if (pb != nullptr && xpt::xp_init(elements_of(rb), *pb) == kPropOk) {
      for (int k = 0; k < n; ++k) {
        double yb[6];
        if (!xpt::mean_at(*pb, t[k], yb)) break;
        for (int i = 0; i < 6; ++i) {
          double d = yb[i] - ym[6 * k + i];
          if (i == 4) d = std::remainder(d, kTwoPi);
          sB[6 * k + i] = d / hb;
        }
      }
    }
    if (pb != nullptr) { xpt::xp_release(*pb); std::free(pb); }
  }
  // prefix sums over k < K of J' W J (kJ x kJ) and J' W e (kJ)
  std::vector<double> preA(static_cast<size_t>(n + 1) * kJ * kJ, 0.0), preB(static_cast<size_t>(n + 1) * kJ, 0.0);
  for (int k = 0; k < n && ok; ++k) {
    double J[6][kJ];
    for (int i = 0; i < 6; ++i) {
      for (int j = 0; j < 6; ++j) J[i][j] = Sk[36 * k + 6 * i + j];
      J[i][6] = sB[6 * k + i];
    }
    const double* pa = preA.data() + static_cast<size_t>(k) * kJ * kJ;
    double* na = preA.data() + static_cast<size_t>(k + 1) * kJ * kJ;
    const double* pq = preB.data() + static_cast<size_t>(k) * kJ;
    double* nq = preB.data() + static_cast<size_t>(k + 1) * kJ;
    for (int a = 0; a < kJ; ++a) {
      double q = 0.0;
      for (int i = 0; i < 6; ++i) q += J[i][a] * w[i] * e[6 * k + i];
      nq[a] = pq[a] + q;
      for (int c = 0; c < kJ; ++c) {
        double h = 0.0;
        for (int i = 0; i < 6; ++i) h += J[i][a] * w[i] * J[i][c];
        na[kJ * a + c] = pa[kJ * a + c] + h;
      }
    }
  }
  // A^-1 by Cholesky (B_eff's diagonal kept positive above the drag regime, where its column vanishes)
  double Ainv[kJ * kJ], zb[kJ];
  if (ok) {
    double L[kJ * kJ] = {};
    const double* At = preA.data() + static_cast<size_t>(n) * kJ * kJ;
    double scale = 0.0;
    for (int a = 0; a < 6; ++a) scale = std::fmax(scale, At[kJ * a + a]);
    for (int a = 0; a < kJ && ok; ++a)
      for (int c = 0; c <= a; ++c) {
        double sum = At[kJ * a + c] + (a == c && a == 6 ? 1e-12 * scale + 1e-300 : 0.0);
        for (int q = 0; q < c; ++q) sum -= L[kJ * a + q] * L[kJ * c + q];
        if (a == c) {
          if (!(sum > 0.0)) { ok = false; break; }
          L[kJ * a + a] = std::sqrt(sum);
        } else {
          L[kJ * a + c] = sum / L[kJ * c + c];
        }
      }
    for (int col = 0; col < kJ && ok; ++col) {
      double y[kJ];
      for (int a = 0; a < kJ; ++a) {
        double sum = a == col ? 1.0 : 0.0;
        for (int q = 0; q < a; ++q) sum -= L[kJ * a + q] * y[q];
        y[a] = sum / L[kJ * a + a];
      }
      for (int a = kJ - 1; a >= 0; --a) {
        double sum = y[a];
        for (int q = a + 1; q < kJ; ++q) sum -= L[kJ * q + a] * Ainv[kJ * q + col];
        Ainv[kJ * a + col] = sum / L[kJ * a + a];
      }
    }
    if (ok) {
      const double* bt = preB.data() + static_cast<size_t>(n) * kJ;
      for (int a = 0; a < kJ; ++a) {
        zb[a] = 0.0;
        for (int c = 0; c < kJ; ++c) zb[a] += Ainv[kJ * a + c] * bt[c];
      }
    }
  }
  best = Scan{};
  // one candidate burn epoch tb (minutes): G = dy/dv there from the set's own state, the burn's signature on the states
  // from `kfirst` on (t_k >= tb, the state at a burn epoch being the post-burn one): M_k = S(t_k) S(t_b)^-1 G
  auto candidate = [&](double tb, int kfirst, Scan& out) -> bool {
    double yb[6], rb[3], vb[3];
    if (!xpt::mean_at(*s, tb, yb) || xpt::output(s->ctx, tb, yb, rb, vb, nullptr) != kPropOk) return false;
    double G[6][3];
    for (int c = 0; c < 3; ++c) {
      const double du[3] = {c == 0 ? 1e-6 : 0.0, c == 1 ? 1e-6 : 0.0, c == 2 ? 1e-6 : 0.0};
      double dvt[3], v2[3], y2[6];
      events::uvw_to_teme(rb, vb, du, dvt);
      for (int q = 0; q < 3; ++q) v2[q] = vb[q] + dvt[q];
      for (int jj = 0; jj < 6; ++jj) y2[jj] = yb[jj];
      if (!inverse_at(*s, tb, rb, v2, y2)) return false;
      for (int jj = 0; jj < 6; ++jj) {
        double d = y2[jj] - yb[jj];
        if (jj == 4) d = std::remainder(d, kTwoPi);
        G[jj][c] = d / 1e-6;
      }
    }
    // P = S(t_b)^-1 G, by Gaussian elimination with partial pivoting
    double A[6][9];
    {
      double Sb[36];
      if (!sens(tb, yb, Sb)) return false;
      for (int i = 0; i < 6; ++i) {
        for (int j = 0; j < 6; ++j) A[i][j] = Sb[6 * i + j];
        for (int c = 0; c < 3; ++c) A[i][6 + c] = G[i][c];
      }
      for (int col = 0; col < 6; ++col) {
        int piv = col;
        for (int i = col + 1; i < 6; ++i)
          if (std::fabs(A[i][col]) > std::fabs(A[piv][col])) piv = i;
        if (!(std::fabs(A[piv][col]) > 0.0)) return false;
        if (piv != col)
          for (int j = 0; j < 9; ++j) std::swap(A[piv][j], A[col][j]);
        for (int i = 0; i < 6; ++i) {
          if (i == col) continue;
          const double f = A[i][col] / A[col][col];
          for (int j = col; j < 9; ++j) A[i][j] -= f * A[col][j];
        }
      }
      for (int i = 0; i < 6; ++i)
        for (int c = 0; c < 3; ++c) A[i][6 + c] /= A[i][i];
    }
    // the profile: A+ and b+ from the prefix sums, P = A+ - A+ A^-1 A+, u = b+ - A+ A^-1 b, then F = Nt' P Nt and
    // g = Nt' u (Nt = [N; 0], N = A[.][6..8])
    double Ap[kJ * kJ], bp[kJ];
    {
      const double* At = preA.data() + static_cast<size_t>(n) * kJ * kJ;
      const double* Ak = preA.data() + static_cast<size_t>(kfirst) * kJ * kJ;
      const double* bt = preB.data() + static_cast<size_t>(n) * kJ;
      const double* bk = preB.data() + static_cast<size_t>(kfirst) * kJ;
      for (int a = 0; a < kJ * kJ; ++a) Ap[a] = At[a] - Ak[a];
      for (int a = 0; a < kJ; ++a) bp[a] = bt[a] - bk[a];
    }
    double X[kJ * kJ];  // A^-1 A+
    for (int a = 0; a < kJ; ++a)
      for (int c = 0; c < kJ; ++c) {
        double sum = 0.0;
        for (int q = 0; q < kJ; ++q) sum += Ainv[kJ * a + q] * Ap[kJ * q + c];
        X[kJ * a + c] = sum;
      }
    double PN[kJ][3], u[kJ];
    for (int a = 0; a < kJ; ++a) {
      double ua = bp[a];
      for (int q = 0; q < kJ; ++q) ua -= Ap[kJ * a + q] * zb[q];
      u[a] = ua;
      for (int c = 0; c < 3; ++c) {
        double sum = 0.0;
        for (int q = 0; q < 6; ++q) {
          double pq = Ap[kJ * a + q];
          for (int r2 = 0; r2 < kJ; ++r2) pq -= Ap[kJ * a + r2] * X[kJ * r2 + q];
          sum += pq * A[q][6 + c];
        }
        PN[a][c] = sum;
      }
    }
    double F[9] = {}, g[3] = {};
    for (int c = 0; c < 3; ++c) {
      for (int q = 0; q < 6; ++q) g[c] += A[q][6 + c] * u[q];
      for (int d = 0; d < 3; ++d)
        for (int q = 0; q < 6; ++q) F[3 * c + d] += A[q][6 + c] * PN[q][d];
    }
    {  // symmetric
      const double f01 = 0.5 * (F[1] + F[3]), f02 = 0.5 * (F[2] + F[6]), f12 = 0.5 * (F[5] + F[7]);
      F[1] = F[3] = f01;
      F[2] = F[6] = f02;
      F[5] = F[7] = f12;
    }
    const double det = F[0] * (F[4] * F[8] - F[5] * F[7]) - F[1] * (F[3] * F[8] - F[5] * F[6]) + F[2] * (F[3] * F[7] - F[4] * F[6]);
    if (!(std::fabs(det) > 0.0)) return false;
    double Fi[9];
    Fi[0] = (F[4] * F[8] - F[5] * F[7]) / det; Fi[1] = (F[2] * F[7] - F[1] * F[8]) / det; Fi[2] = (F[1] * F[5] - F[2] * F[4]) / det;
    Fi[3] = (F[5] * F[6] - F[3] * F[8]) / det; Fi[4] = (F[0] * F[8] - F[2] * F[6]) / det; Fi[5] = (F[2] * F[3] - F[0] * F[5]) / det;
    Fi[6] = (F[3] * F[7] - F[4] * F[6]) / det; Fi[7] = (F[1] * F[6] - F[0] * F[7]) / det; Fi[8] = (F[0] * F[4] - F[1] * F[3]) / det;
    for (int c = 0; c < 3; ++c) out.dv[c] = Fi[3 * c] * g[0] + Fi[3 * c + 1] * g[1] + Fi[3 * c + 2] * g[2];
    out.lambda = g[0] * out.dv[0] + g[1] * out.dv[1] + g[2] * out.dv[2];
    out.t_b = tb;
    out.index = kfirst;
    for (int c = 0; c < 9; ++c) out.cov[c] = Fi[c];
    for (int c = 0; c < 3; ++c) out.fdiag[c] = F[4 * c];
    // the detection statistic at this epoch: the burn on top of the burn-free fit (F0 = N' A+ N, g0 = N' b+ over the
    // six elements)
    {
      double F0[9] = {}, g0[3] = {};
      for (int c = 0; c < 3; ++c) {
        for (int q = 0; q < 6; ++q) g0[c] += A[q][6 + c] * bp[q];
        for (int d = 0; d < 3; ++d) {
          double sum = 0.0;
          for (int q = 0; q < 6; ++q) {
            double aq = 0.0;
            for (int r2 = 0; r2 < 6; ++r2) aq += Ap[kJ * q + r2] * A[r2][6 + d];
            sum += A[q][6 + c] * aq;
          }
          F0[3 * c + d] = sum;
        }
      }
      const double d0 = F0[0] * (F0[4] * F0[8] - F0[5] * F0[7]) - F0[1] * (F0[3] * F0[8] - F0[5] * F0[6]) + F0[2] * (F0[3] * F0[7] - F0[4] * F0[6]);
      if (std::fabs(d0) > 0.0) {
        const double I0[9] = {(F0[4] * F0[8] - F0[5] * F0[7]) / d0, (F0[2] * F0[7] - F0[1] * F0[8]) / d0, (F0[1] * F0[5] - F0[2] * F0[4]) / d0,
                              (F0[5] * F0[6] - F0[3] * F0[8]) / d0, (F0[0] * F0[8] - F0[2] * F0[6]) / d0, (F0[2] * F0[3] - F0[0] * F0[5]) / d0,
                              (F0[3] * F0[7] - F0[4] * F0[6]) / d0, (F0[1] * F0[6] - F0[0] * F0[7]) / d0, (F0[0] * F0[4] - F0[1] * F0[3]) / d0};
        double lam0 = 0.0;
        for (int c = 0; c < 3; ++c) lam0 += g0[c] * (I0[3 * c] * g0[0] + I0[3 * c + 1] * g0[1] + I0[3 * c + 2] * g0[2]);
        out.detect = lam0;
      }
    }
    return true;
  };
  std::vector<double> scanned(n, -1.0);
  double detect = 0.0;
  for (int b = std::max(margin, std::max(lo, 1)); ok && b + margin < n && b < hi; ++b) {
    Scan c;
    if (!candidate(t[b], b, c)) continue;
    if (lambdas) lambdas[b] = c.lambda;
    scanned[b] = c.lambda;
    detect = std::fmax(detect, c.detect);
    if (c.lambda > best.lambda) best = c;
  }
  best.detect = detect;
  // the evidence for the epoch: the run of candidates around the best within 3.84 of its Lambda (chi^2_1, 95 %)
  if (best.index > 0) {
    int a = best.index, z = best.index;
    while (a - 1 >= 0 && scanned[a - 1] >= best.lambda - 3.84) --a;
    while (z + 1 < n && scanned[z + 1] >= best.lambda - 3.84) ++z;
    best.t_lo = t[a > 0 ? a - 1 : 0];
    best.t_hi = t[z];
  }
  // the epoch refined between the states either side of the best (eighths of the spacing)
  if (ok && best.index > 0) {
    const int b = best.index;
    for (int side = 0; side < 2; ++side) {
      const int k1 = side == 0 ? b : b + 1;
      if (k1 < 1 || k1 >= n) continue;
      for (int q = 1; q < 8; ++q) {
        Scan c;
        const double tb = t[k1 - 1] + (t[k1] - t[k1 - 1]) * q / 8.0;
        if (candidate(tb, k1, c) && c.lambda > best.lambda) {
          c.t_lo = best.t_lo;
          c.t_hi = best.t_hi;
          c.detect = best.detect;
          best = c;
        }
      }
    }
  }
  for (int j = 0; j < 6; ++j) xpt::xp_release(ps[j]);
  std::free(ps);
  xpt::xp_release(*s);
  std::free(s);
  return ok;
}

/// The two-segment model's residuals (model minus observed, km): the pre-burn set `pre` before t_b, after it the
/// impulse map of dv (UVW, km/s) at t_b, so the position is continuous there.
inline bool joint_residuals(const ElementRow& pre, const double* dv, double tb, const double* t, const double* r, int m,
                            double* res) {
  const Elements pe = elements_of(pre);
  Elements post{};
  events::Boundary bd;
  if (!events::maneuver_map(pe, tb, dv, 0.0, post, bd)) return false;
  xpt::XpSat* s = static_cast<xpt::XpSat*>(std::calloc(2, sizeof(xpt::XpSat)));
  if (s == nullptr) return false;
  const bool a = xpt::xp_init(pe, s[0]) == kPropOk;
  const bool b = xpt::xp_init(post, s[1]) == kPropOk;
  bool ok = a && b;
  for (int k = 0; ok && k < m; ++k) {
    double rm[3], vm[3];
    const bool after = t[k] >= tb;
    if (xpt::xp_propagate(s[after ? 1 : 0], after ? t[k] - tb : t[k], rm, vm) != kPropOk) { ok = false; break; }
    for (int j = 0; j < 3; ++j) res[3 * k + j] = rm[j] - r[3 * k + j];
  }
  xpt::xp_release(s[0]);
  xpt::xp_release(s[1]);
  std::free(s);
  return ok;
}

/// The joint segment fit (DESIGN 5.1.4): y_0 (the six elements, B_eff and AGOM with the burn-free fit's priors), the
/// Delta v and its epoch t_b over the whole arc, position continuous at t_b. Levenberg-Marquardt on the positions,
/// columns by one-sided differences of the theory. `pre`, `dv`, `tb` hold the start and receive the fit.
inline fit::Result joint_fit(ElementRow& pre, double* dv, double& tb, const double* t, const double* r, int m,
                             const fit::Options& o) {
  constexpr int kN = 16;
  fit::Result out{};
  double x[fit::kMaxParams + 4];
  const int ne = fit::params_of(pre, o, x);
  const int np = ne + 4;
  for (int c = 0; c < 3; ++c) x[ne + c] = dv[c];
  x[ne + 3] = tb;
  const int nres = 3 * m;
  std::vector<double> res(nres), trial(nres), jac(static_cast<size_t>(nres) * np);
  auto eval = [&](const double* xx, double* rr) {
    ElementRow w = pre;
    fit::row_of(xx, o, w);
    return joint_residuals(w, xx + ne, xx[ne + 3], t, r, m, rr);
  };
  const int ia = o.fit_drag ? 7 : 6;
  auto cost_of = [&](const double* rr, const double* xx) {
    double c = 0.0;
    for (int i = 0; i < nres; ++i) c += rr[i] * rr[i];
    if (o.fit_drag && o.drag_sigma > 0.0) { const double d = (xx[6] - o.drag_prior) / o.drag_sigma; c += d * d; }
    if (o.fit_agom && o.agom_sigma > 0.0) { const double d = (xx[ia] - o.agom_prior) / o.agom_sigma; c += d * d; }
    return c;
  };
  if (np > kN || !eval(x, res.data())) { out.status = -2; return out; }
  double cost = cost_of(res.data(), x), mu = 1e-3;
  bool converged = false;
  int it = 0;
  for (; it < 25 && !converged; ++it) {
    for (int a = 0; a < np; ++a) {
      double h;
      if (a < 4) h = 1e-7;
      else if (a == 4) h = 1e-7;
      else if (a == 5) h = 1e-7 * std::fabs(x[5]);
      else if (a < ne) h = std::fmax(1e-2 * std::fabs(x[a]), a == ia && o.fit_agom ? 1e-4 : (a > ia ? 1e-9 : 1e-5));
      else if (a < ne + 3) h = 1e-6;
      else h = 0.05;
      double xh[fit::kMaxParams + 4];
      for (int q = 0; q < np; ++q) xh[q] = x[q];
      xh[a] += h;
      if (!eval(xh, trial.data())) { out.status = -3; return out; }
      for (int i = 0; i < nres; ++i) jac[static_cast<size_t>(i) * np + a] = (trial[i] - res[i]) / h;
    }
    double A[kN * kN] = {}, g[kN] = {};
    for (int i = 0; i < nres; ++i)
      for (int a = 0; a < np; ++a) {
        const double ja = jac[static_cast<size_t>(i) * np + a];
        g[a] -= ja * res[i];
        for (int b = 0; b <= a; ++b) A[a * np + b] += ja * jac[static_cast<size_t>(i) * np + b];
      }
    if (o.fit_drag && o.drag_sigma > 0.0) {
      A[6 * np + 6] += 1.0 / (o.drag_sigma * o.drag_sigma);
      g[6] -= (x[6] - o.drag_prior) / (o.drag_sigma * o.drag_sigma);
    }
    if (o.fit_agom && o.agom_sigma > 0.0) {
      A[ia * np + ia] += 1.0 / (o.agom_sigma * o.agom_sigma);
      g[ia] -= (x[ia] - o.agom_prior) / (o.agom_sigma * o.agom_sigma);
    }
    for (int a = 0; a < np; ++a)
      for (int b = 0; b < a; ++b) A[b * np + a] = A[a * np + b];
    bool improved = false;
    for (int tries = 0; tries < 12 && !improved; ++tries) {
      double M[kN * kN], d[kN];
      for (int q = 0; q < np * np; ++q) M[q] = A[q];
      for (int a = 0; a < np; ++a) { M[a * np + a] *= (1.0 + mu); d[a] = g[a]; }
      if (fit::solve(M, d, np)) {
        double xt[fit::kMaxParams + 4];
        for (int a = 0; a < np; ++a) xt[a] = x[a] + d[a];
        if (eval(xt, trial.data())) {
          const double c = cost_of(trial.data(), xt);
          if (c < cost) {
            const double rel = (cost - c) / cost;
            for (int a = 0; a < np; ++a) x[a] = xt[a];
            res.swap(trial);
            cost = c;
            mu = std::fmax(mu * 0.3, 1e-12);
            improved = true;
            if (rel < 1e-10) converged = true;
            continue;
          }
        }
      }
      mu *= 10.0;
    }
    if (!improved) converged = true;
  }
  fit::row_of(x, o, pre);
  for (int c = 0; c < 3; ++c) dv[c] = x[ne + c];
  tb = x[ne + 3];
  double ss = 0.0, mx = 0.0;
  for (int k = 0; k < m; ++k) {
    const double dd = res[3 * k] * res[3 * k] + res[3 * k + 1] * res[3 * k + 1] + res[3 * k + 2] * res[3 * k + 2];
    ss += dd;
    mx = std::fmax(mx, std::sqrt(dd));
  }
  out.rms_km = std::sqrt(ss / (m > 0 ? m : 1));
  out.max_km = mx;
  out.iterations = it;
  out.status = converged ? 0 : 1;
  return out;
}

}  // namespace evd
}  // namespace sdnap

/// Detection threshold of the GLR (diagnostic: sdnap_glr_threshold): chi^2_3 at 1 - 1.8e-4 is about 20; the
/// innovations are not white (the theory's own model error), so the threshold is recalibrated on burn-free arcs.
inline double& glr_threshold() {
  static double t = 20.0;
  return t;
}
SDNAP_EXPORT("sdnap_glr_threshold")
double sdnap_glr_threshold(double t) {
  const double previous = glr_threshold();
  if (t > 0.0) glr_threshold() = t;
  return previous;
}

extern "C" int detect_maneuvers(void) {
  using namespace sdnap;
  plugin_reset_output_state();
  if (const int rc = pcf::read(pcf::kDetect)) return rc;
  {
    bool have_spw = false, have_dcl = false;
    if (const int st = envload::apply_frames(have_spw, have_dcl)) return st;
  }
  const uint32_t frames = plugin_get_input_count();
  for (uint32_t fi = 0; fi < frames; ++fi) {
    const plugin_input_frame_t* f = plugin_get_input_frame(fi);
    if (f == nullptr || f->port_id == nullptr || std::strcmp(f->port_id, "ephemeris") != 0) continue;
    const uint8_t* p = f->payload;
    uint32_t n = f->payload_length;
    if (n >= 12 && std::memcmp(p + 4, "$OEM", 4) != 0 && std::memcmp(p + 8, "$OEM", 4) == 0) { p += 4; n -= 4; }
    flatbuffers::Verifier verifier(p, n);
    if (!VerifyOEMBuffer(verifier)) { plugin_set_error("invalid-oem", "An 'ephemeris' $OEM does not verify."); return 3; }
    const OEM* oem = GetOEM(p);
    if (oem->EPHEMERIS_DATA_BLOCK() == nullptr) continue;
    for (const ephemerisDataBlock* blk : *oem->EPHEMERIS_DATA_BLOCK()) {
      if (blk->CENTER_NAME() != nullptr && blk->CENTER_NAME()->size() > 0 && !oem::same_text(blk->CENTER_NAME()->c_str(), "EARTH")) {
        plugin_set_error("unsupported-center", "Maneuvers are detected on Earth ephemerides (CENTER_NAME EARTH).");
        return 3;
      }
      const oem::Axes axes = oem::axes_of(blk->REFERENCE_FRAME());
      if (axes != oem::Axes::Teme) { plugin_set_error("unsupported-frame", "detect_maneuvers reads TEME ephemerides."); return 3; }
      if (blk->TIME_SYSTEM() != timingStandard_UTC) { plugin_set_error("unsupported-time-system", "Only UTC ephemerides are read."); return 3; }
      const auto* lines = blk->EPHEMERIS_DATA_LINES();
      const uint32_t m = lines == nullptr ? 0 : lines->size();
      if (m < pcf::options().minimum_states) {
        char why[96];
        std::snprintf(why, sizeof why, "Detection needs at least %u states (MANEUVER_DETECTION.MINIMUM_STATES).", pcf::options().minimum_states);
        plugin_set_error("too-few-states", why);
        return 3;
      }
      double w0 = 0, f0 = 0;
      std::vector<double> t, r, v;
      for (uint32_t k = 0; k < m; ++k) {
        const ephemerisDataLine* L = lines->Get(k);
        double w, fr;
        if (!fitoem::text_epoch(L->EPOCH(), w, fr)) { plugin_set_error("invalid-oem", "A state has no readable EPOCH."); return 3; }
        if (k == 0) { w0 = w; f0 = fr; }
        t.push_back(fitoem::minutes_between(w0, f0, w, fr));
        r.insert(r.end(), {L->X(), L->Y(), L->Z()});
        v.insert(v.end(), {L->X_DOT(), L->Y_DOT(), L->Z_DOT()});
      }
      // the burn-free fit of the whole arc, from the inverse map at the first state
      Elements e{};
      e.epoch_jd_whole = w0;
      e.epoch_jd_frac = f0;
      e.theory = kTheorySdnAp;
      e.bterm = 0.01;
      e.norad = blk->OBJECT() != nullptr ? blk->OBJECT()->NORAD_CAT_ID() : 0;
      if (!events::inverse_at_epoch(e, r.data(), v.data())) { plugin_set_error("element-set-refused", "The first state gives no Earth set."); return 3; }
      // as fit_sdnap fits: B_eff with a loose prior, then AGOM added with its prior (fitoem::kBtermPriorSigma); not
      // the once-per-revolution empirical terms (DESIGN 2c), which take up a burn's signature (FFM-1 arcs: the 20 cm/s
      // V and U burns no longer detected, the burn-free RMS 0.0645 km against 0.0652)
      fit::Options o{};
      o.fit_drag = 1;
      o.drag_sigma = 1.0;
      ElementRow all = evd::row_of(e);
      fit::Result fr_all = fit::run(all, t.data(), r.data(), static_cast<int>(m), o);
      o.fit_agom = 1;
      o.agom_sigma = fitoem::kBtermPriorSigma;
      if (fr_all.status >= 0) fr_all = fit::run(all, t.data(), r.data(), static_cast<int>(m), o);
      if (fr_all.status < 0) { plugin_set_error("fit-failed", "The burn-free fit did not converge."); return 3; }
      evd::Scan scan;
      const int margin = static_cast<int>(pcf::options().margin_states);
      if (!evd::glr(all, t, r, v, margin, scan)) { plugin_set_error("detection-failed", "The innovations could not be formed."); return 3; }
      char comment[400];
      if (!(scan.detect > glr_threshold())) {
        // no burn: the burn-free set, with the floor at the best epoch: the Delta v along each axis whose expected
        // Lambda reaches the threshold, sqrt(threshold / F_cc) of the profiled information
        double floor_mm[3];
        for (int c = 0; c < 3; ++c) floor_mm[c] = scan.fdiag[c] > 0.0 ? 1e6 * std::sqrt(glr_threshold() / scan.fdiag[c]) : 0.0;
        std::snprintf(comment, sizeof comment,
                      "SDN-AP set, no maneuver detected (six-element GLR, DESIGN 5.1.4: largest Lambda %.2f against %.1f; the profile over the epoch elements and B_eff peaks at %.2f at %.1f min, its floor there U %.1f, V %.1f, W %.1f mm/s; fit RMS %.6f km)",
                      scan.detect, glr_threshold(), scan.lambda, scan.t_b, floor_mm[0], floor_mm[1], floor_mm[2], fr_all.rms_km);
        flatbuffers::FlatBufferBuilder tb(256);
        const auto c = tb.CreateString("EARTH");
        OMMBuilder ob(tb);
        ob.add_CENTER_NAME(c);
        tb.Finish(ob.Finish());
        if (const int rc = evm::push_set(elements_of(all), GetOMM(tb.GetBufferPointer()), comment)) return rc;
        continue;
      }
      // the two-segment fit: the arc before the burn fitted on its own, its innovations over the whole arc giving the
      // Delta v at the detected epoch, the post-burn set carried by the impulse map
      const int b = scan.index;
      ElementRow pre = all;
      {
        fit::Options op = o;
        op.fit_agom = 0;
        if (fit::run(pre, t.data(), r.data(), b, op).status < 0 || fit::run(pre, t.data(), r.data(), b, o).status < 0) pre = all;
      }
      double dv[3] = {scan.dv[0], scan.dv[1], scan.dv[2]};
      double tb_min = scan.t_b, lambda = scan.lambda;
      // the pre-burn set's innovations (their noise from the states before the detection), the epoch searched again
      // within two hours of it: the two-segment estimate of the epoch and Delta v
      {
        evd::Scan at;
        const int window = std::max(3, static_cast<int>(pcf::options().refine_window_h * 60.0 / ((t[m - 1] - t[0]) / (m - 1))));
        if (evd::glr(pre, t, r, v, margin, at, nullptr, b - window, b + window + 1, b) && at.index >= 0) {
          for (int q = 0; q < 3; ++q) dv[q] = at.dv[q];
          tb_min = at.t_b;
          lambda = at.lambda;
        }
      }
      // the joint segment fit from the two-segment estimate: y_0, Delta v and t_b over the whole arc
      const fit::Result jf = evd::joint_fit(pre, dv, tb_min, t.data(), r.data(), static_cast<int>(m), o);
      if (jf.status < 0) { plugin_set_error("maneuver-failed", "The joint segment fit did not converge."); return 3; }
      flatbuffers::FlatBufferBuilder tb(256);
      const auto cname = tb.CreateString("EARTH");
      OMMBuilder ob(tb);
      ob.add_CENTER_NAME(cname);
      tb.Finish(ob.Finish());
      const OMM* tmpl = GetOMM(tb.GetBufferPointer());
      const Elements pre_e = elements_of(pre);
      Elements post{};
      events::Boundary bd;
      if (!events::maneuver_map(pre_e, tb_min, dv, 0.0, post, bd)) { plugin_set_error("maneuver-failed", "The impulse map did not converge at the detected epoch."); return 3; }
      evm::Burn burn;
      burn.start_w = pre_e.epoch_jd_whole;
      burn.start_f = pre_e.epoch_jd_frac + tb_min / kMinutesPerDay;
      for (int q = 0; q < 3; ++q) burn.dv[q] = dv[q];
      std::snprintf(comment, sizeof comment, "SDN-AP pre-maneuver segment (the joint segment fit over the %u states: RMS %.6f km, %d iterations; burn detected at Lambda %.1f; the burn-free fit's RMS %.6f km)", m, jf.rms_km, jf.iterations, lambda, fr_all.rms_km);
      if (const int rc = evm::push_set(pre_e, tmpl, comment)) return rc;
      std::snprintf(comment, sizeof comment, "SDN-AP post-maneuver segment: the impulse map of the detected Delta v (U %.3f, V %.3f, W %.3f mm/s)", 1e6 * dv[0], 1e6 * dv[1], 1e6 * dv[2]);
      if (const int rc = evm::push_set(post, tmpl, comment)) return rc;
      flatbuffers::FlatBufferBuilder mb(256);
      MNVBuilder mm(mb);
      mm.add_STATUS(maneuverStatus_DETECTED);
      mb.Finish(mm.Finish());
      burn.source = GetMNV(mb.GetBufferPointer());
      char alg[300];
      std::snprintf(alg, sizeof alg, "six-element GLR (DESIGN 5.1.4, eq. 16): Lambda %.2f against %.1f; the epoch from the profile over the epoch elements and B_eff (Lambda %.2f, within %.1f .. %.1f min of the arc start at 3.84 below its peak); joint segment fit (y0, Delta v, t_b; RMS %.6f km)",
                    scan.detect, glr_threshold(), lambda, scan.t_lo, scan.t_hi, jf.rms_km);
      if (const int rc = evm::push_mnv(burn, pre_e, post, bd, "SDN-AP", alg)) return rc;
    }
  }
  return 0;
}
