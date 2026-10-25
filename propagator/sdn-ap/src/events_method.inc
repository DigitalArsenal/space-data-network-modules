// -----------------------------------------------------------------------------
// The `maneuver` method (DESIGN 5.1.1 - 5.1.3): an Earth SGP4XP set
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

/// The $OMM of an Earth set (identity from the input record `tmpl`).
inline int push_set(const Elements& e, const OMM* tmpl, const char* comment) {
  flatbuffers::FlatBufferBuilder fbb(1024);
  char epoch_text[48];
  oem::iso_text(e.epoch_jd_whole, e.epoch_jd_frac, 0.0, epoch_text, sizeof epoch_text);
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
  b.add_MEAN_ELEMENT_THEORY(meanElementSource_SGP4XP);
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
  twobody::elements_of(events::mu_xp(), r, v, el);
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
                         omm::center_refused() ? "Maneuvers are applied to Earth sets (CENTER_NAME EARTH)." : "The 'omm' payload is not a decodable SGP4XP $OMM.");
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
  if (cur.theory != kTheorySgp4Xp) {
    plugin_set_error("unsupported-theory", "Maneuvers are applied to SGP4XP sets (MEAN_ELEMENT_THEORY SGP4XP).");
    return 3;
  }
  if (const int tc = pcf::check_set_theory(cur.theory)) return tc;
  std::stable_sort(burns.begin(), burns.end(), [](const evm::Burn& a, const evm::Burn& b) {
    return (a.start_w - b.start_w) + (a.start_f - b.start_f) < 0.0;
  });
  const char* model = "SGP4XP";
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
