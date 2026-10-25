// -----------------------------------------------------------------------------
// The `launch_set` method (DESIGN 5.3.1): the first Earth set of a launch from
// the SDS $LAM insertion orbit (osculating a, e, i, Omega, omega and the
// argument of latitude u at EPOCH in REF_FRAME: TEME, GCRF / ICRF or EME2000 /
// J2000), y0 = h^-1(x_ins, t_ins) by the inverse map; B_eff and AGOM from the
// priors (0.01 m^2/kg each unless USER_DEFINED in a 'prior' $OMM are given:
// SDNAP_B_EFF, SDNAP_AGOM). The $LAM sigmas give the first set's (21): sigma_a
// = sqrt(sigma_hp^2 + sigma_ha^2) / 2, sigma_e = that / (2 a)... carried as
// USER_DEFINED_SDNAP_SIGMA_A_KM, _SIGMA_E, _SIGMA_LAMBDA_DEG, _SIGMA_RAAN_DEG.
// -----------------------------------------------------------------------------

namespace sdnap {
namespace launch {

/// The TEME state of osculating elements (km, rad; u the argument of latitude) at the split JD in `frame`
/// (0 TEME, 1 GCRF / ICRF, 2 EME2000 / J2000). False on an open or degenerate orbit or an unknown frame.
inline bool teme_state(double a, double e, double inc, double node, double argp, double u, int frame, double whole, double frac, double* r, double* v) {
  if (!(a > 0.0) || !(e >= 0.0 && e < 1.0)) return false;
  const double nu = u - argp;
  const double E = std::atan2(std::sqrt(1.0 - e * e) * std::sin(nu), e + std::cos(nu));
  const double el[6] = {a, e, inc, node, argp, E - e * std::sin(E)};
  double rr[3], vv[3];
  if (!segment::state_of(events::mu_xp(), el, rr, vv)) return false;
  if (frame == 0) {
    for (int c = 0; c < 3; ++c) { r[c] = rr[c]; v[c] = vv[c]; }
    return true;
  }
  double m[3][3], g[3], gv[3];
  if (frame == 2) {
    double rb[3][3];
    frames::frame_bias(rb);
    frames::apply_transpose(rb, rr, g);  // EME2000 -> GCRF
    frames::apply_transpose(rb, vv, gv);
  } else {
    for (int c = 0; c < 3; ++c) { g[c] = rr[c]; gv[c] = vv[c]; }
  }
  if (frames::gcrf_to_teme(whole, frac, m) != 0) return false;
  frames::apply(m, g, r);
  frames::apply(m, gv, v);
  return true;
}

/// The state of one launch frame: a 'launch' $LAM INSERTION or a 'burnout' $BOV (EFG km and km/s at EPOCH, rotated to
/// TEME by GMST). TEME km, km/s; the epoch; the mission name ($LAM) or "" ($BOV); `ins` the $LAM insertion (nullptr
/// for a $BOV). 0, 1 for another port, or 3 with the error set.
inline int frame_state(const plugin_input_frame_t* f, double& w, double& fr, double* r, double* v, std::string& name,
                       const lamInsertionOrbit** ins_out = nullptr) {
  if (ins_out != nullptr) *ins_out = nullptr;
  {
    if (f == nullptr || f->port_id == nullptr) return 1;
    const bool is_lam = std::strcmp(f->port_id, "launch") == 0, is_bov = std::strcmp(f->port_id, "burnout") == 0;
    if (!is_lam && !is_bov) return 1;
    const uint8_t* p = f->payload;
    uint32_t n = f->payload_length;
    const char* ident = is_lam ? "$LAM" : "$BOV";
    if (n >= 12 && std::memcmp(p + 4, ident, 4) != 0 && std::memcmp(p + 8, ident, 4) == 0) { p += 4; n -= 4; }
    flatbuffers::Verifier ver(p, n);
    if (is_bov) {
      if (!VerifyBOVBuffer(ver)) { plugin_set_error("invalid-bov", "A 'burnout' payload is not a verifiable SDS $BOV."); return 3; }
      const BOV* bov = GetBOV(p);
      if (bov->EPOCH() == nullptr || !omm::epoch(bov->EPOCH()->c_str(), bov->EPOCH()->size(), w, fr)) {
        plugin_set_error("invalid-bov", "The $BOV EPOCH is not readable.");
        return 3;
      }
      const double re[3] = {bov->E_COORDINATE(), bov->F_COORDINATE(), bov->G_COORDINATE()};
      const double ve[3] = {bov->E_DOT(), bov->F_DOT(), bov->G_DOT()};
      const double rr = std::sqrt(re[0] * re[0] + re[1] * re[1] + re[2] * re[2]);
      // the schema states no unit: the burnout vector is read in km and km/s and refused outside an Earth orbit's radii
      if (!(rr > 6000.0 && rr < 100000.0)) {
        plugin_set_error("bov-units", "The $BOV EFG position is read in km (the schema states no unit); its radius is not an Earth orbit's.");
        return 3;
      }
      earth_fixed_to_teme(gmst(w, fr), re, ve, r, v);
      name.clear();
      return 0;
    }
    if (!VerifyLAMBuffer(ver)) { plugin_set_error("invalid-lam", "A 'launch' payload is not a verifiable SDS $LAM."); return 3; }
    const LAM* lam = GetLAM(p);
    const lamInsertionOrbit* ins = lam->INSERTION();
    if (ins == nullptr || ins->EPOCH() == nullptr) { plugin_set_error("no-insertion", "The $LAM carries no INSERTION orbit with an EPOCH."); return 3; }
    if (!omm::epoch(ins->EPOCH()->c_str(), ins->EPOCH()->size(), w, fr)) { plugin_set_error("invalid-lam", "The insertion EPOCH is not readable."); return 3; }
    const char* frame_name = ins->REF_FRAME() != nullptr ? ins->REF_FRAME()->c_str() : (lam->REF_FRAME() != nullptr ? lam->REF_FRAME()->c_str() : "");
    const int frame = oem::same_text(frame_name, "TEME") ? 0 : (oem::same_text(frame_name, "GCRF") || oem::same_text(frame_name, "ICRF")) ? 1
                    : (oem::same_text(frame_name, "EME2000") || oem::same_text(frame_name, "J2000")) ? 2 : -1;
    if (frame < 0) { plugin_set_error("unsupported-frame", "The insertion REF_FRAME is none of TEME, GCRF, ICRF, EME2000 or J2000."); return 3; }
    if (!teme_state(ins->SEMI_MAJOR_AXIS_M() / 1000.0, ins->ECCENTRICITY(), ins->INCLINATION_DEG() * kDeg, ins->RAAN_DEG() * kDeg,
                    ins->ARGUMENT_OF_PERIAPSIS_DEG() * kDeg, ins->ARGUMENT_OF_LATITUDE_DEG() * kDeg, frame, w, fr, r, v)) {
      plugin_set_error("element-set-refused", "The insertion orbit gives no state (open or degenerate).");
      return 3;
    }
    name = lam->MISSION_NAME() != nullptr ? lam->MISSION_NAME()->c_str() : "";
    if (ins_out != nullptr) *ins_out = ins;
    return 0;
  }
}

/// The parent state of a batch: the first 'launch' or 'burnout' frame (frame_state); 1 when there is none.
inline int parent_state(double& w, double& fr, double* r, double* v, std::string& name) {
  const uint32_t frames_n = plugin_get_input_count();
  for (uint32_t fi = 0; fi < frames_n; ++fi) {
    const int st = frame_state(plugin_get_input_frame(fi), w, fr, r, v, name);
    if (st != 1) return st;
  }
  return 1;
}

/// The B_eff and AGOM of a 'prior' $OMM (USER_DEFINED SDNAP_B_EFF, SDNAP_AGOM); unchanged without one. 0 or 3.
/// The B_eff and AGOM priors: $PCF LAUNCH (defaults 0.01 m^2/kg each), or a 'prior' $OMM's USER_DEFINED_SDNAP_B_EFF
/// and _AGOM (the object's own; with the $PCF value also set, refused by name).
inline int priors(double& beff, double& agom) {
  const pcf::Options& o = pcf::options();
  beff = o.launch_drag_prior;
  agom = o.launch_srp_prior;
  const uint32_t frames_n = plugin_get_input_count();
  for (uint32_t fi = 0; fi < frames_n; ++fi) {
    const plugin_input_frame_t* f = plugin_get_input_frame(fi);
    if (f == nullptr || f->port_id == nullptr || std::strcmp(f->port_id, "prior") != 0) continue;
    const uint8_t* p = f->payload;
    uint32_t n = f->payload_length;
    if (n >= 12 && std::memcmp(p + 4, "$OMM", 4) != 0 && std::memcmp(p + 8, "$OMM", 4) == 0) { p += 4; n -= 4; }
    flatbuffers::Verifier ver(p, n);
    if (!VerifyOMMBuffer(ver)) { plugin_set_error("invalid-prior", "A 'prior' payload is not a verifiable SDS $OMM."); return 3; }
    if (const auto* ud = GetOMM(p)->USER_DEFINED_PARAMETERS())
      for (const OMMUserDefinedParameter* q : *ud) {
        if (q == nullptr || q->PARAM_NAME() == nullptr || q->PARAM_VALUE() == nullptr) continue;
        if (std::strcmp(q->PARAM_NAME()->c_str(), "SDNAP_B_EFF") == 0) {
          if (o.launch_drag_set) return pcf::refuse("LAUNCH.DRAG_AREA_OVER_MASS_PRIOR_M2_KG", "a 'prior' $OMM gives this object's B_eff");
          beff = std::strtod(q->PARAM_VALUE()->c_str(), nullptr);
        }
        if (std::strcmp(q->PARAM_NAME()->c_str(), "SDNAP_AGOM") == 0) {
          if (o.launch_srp_set) return pcf::refuse("LAUNCH.SRP_AREA_OVER_MASS_PRIOR_M2_KG", "a 'prior' $OMM gives this object's AGOM");
          agom = std::strtod(q->PARAM_VALUE()->c_str(), nullptr);
        }
      }
  }
  return 0;
}

}  // namespace launch
}  // namespace sdnap

extern "C" int launch_set(void) {
  using namespace sdnap;
  plugin_reset_output_state();
  if (const int rc = pcf::read(pcf::kLaunchSet)) return rc;
  double beff = 0.01, agom = 0.01;
  if (const int st = launch::priors(beff, agom)) return st;
  int done = 0;
  const uint32_t frames_n = plugin_get_input_count();
  for (uint32_t fi = 0; fi < frames_n; ++fi) {
    double w, fr, r[3], v[3];
    std::string mission;
    const lamInsertionOrbit* ins = nullptr;
    const int st = launch::frame_state(plugin_get_input_frame(fi), w, fr, r, v, mission, &ins);
    if (st == 1) continue;
    if (st != 0) return st;
    Elements el{};
    el.epoch_jd_whole = w;
    el.epoch_jd_frac = fr;
    el.theory = kTheorySdnAp;
    el.bterm = beff;
    el.agom = agom;
    int iters = 0;
    if (!events::inverse_at_epoch(el, r, v, &iters)) { plugin_set_error("inverse-failed", "The inverse map did not converge at the insertion state."); return 3; }
    char comment[240];
    if (ins != nullptr) {
      // (21) the first set's sigmas from the $LAM's
      const double a = ins->SEMI_MAJOR_AXIS_M() / 1000.0;
      const double shp = ins->PERIAPSIS_ALTITUDE_UNCERTAINTY_M() / 1000.0, sha = ins->APOAPSIS_ALTITUDE_UNCERTAINTY_M() / 1000.0;
      const double sa = 0.5 * std::sqrt(shp * shp + sha * sha);
      std::snprintf(comment, sizeof comment, "SDN-AP first set from the $LAM insertion (DESIGN 5.3.1: y0 = h^-1(x_ins, t_ins), %d inverse-map steps; B_eff %.4g and AGOM %.4g m^2/kg priors); sigma_a %.3f km, sigma_e %.3g, sigma_lambda %.4f deg, sigma_RAAN %.4f deg (21)",
                    iters, beff, agom, sa, sa / (2.0 * a), ins->ARGUMENT_OF_LATITUDE_UNCERTAINTY_DEG(), ins->RAAN_UNCERTAINTY_DEG());
    } else {
      std::snprintf(comment, sizeof comment, "SDN-AP first set from the $BOV burnout vector (DESIGN 5.3.1: y0 = h^-1(x_bov, t_bov), EFG rotated to TEME by GMST, %d inverse-map steps; B_eff %.4g and AGOM %.4g m^2/kg priors)",
                    iters, beff, agom);
    }
    flatbuffers::FlatBufferBuilder tb(256);
    const auto s_name = !mission.empty() ? tb.CreateString(mission.c_str()) : flatbuffers::Offset<flatbuffers::String>(0);
    const auto s_c = tb.CreateString("EARTH");
    OMMBuilder ob(tb);
    ob.add_CENTER_NAME(s_c);
    if (!s_name.IsNull()) ob.add_OBJECT_NAME(s_name);
    tb.Finish(ob.Finish());
    if (const int rc = evm::push_set(el, GetOMM(tb.GetBufferPointer()), comment)) return rc;
    ++done;
  }
  if (done == 0) { plugin_set_error("missing-input", "launch_set takes a 'launch' $LAM with its INSERTION orbit or a 'burnout' $BOV."); return 3; }
  return 0;
}

/// Diagnostic (the launch E2E's reference): the TEME state (6 doubles) of osculating elements (a km, e, i, Omega,
/// omega, u deg) at the UTC split JD in frame 0 TEME, 1 GCRF, 2 EME2000; returns 0 or -1.
SDNAP_EXPORT("sdnap_insertion_state")
int32_t sdnap_insertion_state(double whole, double frac, const double* el, int32_t frame, double* out) {
  using namespace sdnap;
  return launch::teme_state(el[0], el[1], el[2] * kDeg, el[3] * kDeg, el[4] * kDeg, el[5] * kDeg, frame, whole, frac, out, out + 3) ? 0 : -1;
}

/// Test helpers (the events E2E's FFM reference): a UVW vector of the state (r, v) in that state's axes, and the
/// geodetic height (km, EGM-96 ellipsoid) of an Earth-centred inertial position (km).
SDNAP_EXPORT("sdnap_uvw_to_frame")
void sdnap_uvw_to_frame(const double* r, const double* v, const double* uvw, double* out) { sdnap::events::uvw_to_teme(r, v, uvw, out); }
SDNAP_EXPORT("sdnap_geodetic_height_km")
double sdnap_geodetic_height_km(const double* r) {
  double phi, h;
  sdnap::drag::geodetic(r[0] / sdnap::xpt::kRe, r[1] / sdnap::xpt::kRe, r[2] / sdnap::xpt::kRe, phi, h);
  return h;
}
