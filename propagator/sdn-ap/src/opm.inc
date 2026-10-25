// -----------------------------------------------------------------------------
// Osculating input (SPEC 13): the `opm_set` method takes SDS $OPM records (an osculating Keplerian block or a
// Cartesian state about the Earth, REF_FRAME TEME, GCRF / ICRF or EME2000 / J2000, UTC, the record's GM) and gives
// one SDN-AP set per record through the module's own initialization: the state in TEME, then y0 = h^-1(x, t) by the
// inverse map, as launch_set does for an insertion orbit. MASS with DRAG_AREA and SOLAR_RAD_AREA give B = C_D A / m
// and AGOM = C_R A / m (C_D 2.2 and C_R 1.0 where the record states none); without them the regime's defaults, the
// $PCF LAUNCH priors (B_eff 0.01 m^2/kg with the perigee below 2,500 km, else 0; AGOM 0.01 m^2/kg), stated in the
// set. `propagate` takes 'opm' frames through the same conversion. A COVARIANCE
// (with COV_REF_FRAME, else REF_FRAME) is rotated to TEME and carried with the regime's process noise (SPEC 12.5);
// none is made where the record has none.
// -----------------------------------------------------------------------------

namespace sdnap {
namespace opm {

constexpr double kDefaultCd = 2.2;
constexpr double kDefaultCr = 1.0;

/// One record read: the TEME state at the epoch and what it was read from.
struct Source {
  double whole = 0, frac = 0;
  double r[3] = {}, v[3] = {};    ///< TEME km, km/s
  double gm = 0;                  ///< km^3/s^2, the record's
  const char* frame = "";         ///< as the record names it
  bool keplerian = false;         ///< the Keplerian block (else the state)
  bool forces_from_record = false;
  double beff = 0, agom = 0;
  bool has_cov = false;
  double cov[36] = {};            ///< TEME, 6 x 6 row-major
  const OPM* rec = nullptr;
};

inline bool has(const OPM* o, flatbuffers::voffset_t vt) { return reinterpret_cast<const flatbuffers::Table*>(o)->CheckField(vt); }

/// 0 TEME, 1 GCRF / ICRF, 2 EME2000 / J2000, -1 another or none.
inline int frame_of(const flatbuffers::String* s) {
  if (s == nullptr || s->size() == 0) return -1;
  const char* t = s->c_str();
  return oem::same_text(t, "TEME") ? 0 : (oem::same_text(t, "GCRF") || oem::same_text(t, "ICRF")) ? 1
       : (oem::same_text(t, "EME2000") || oem::same_text(t, "J2000")) ? 2 : -1;
}

/// The 3 x 3 rotation from `frame` axes to TEME at the split JD; false outside ERFA's calendar.
inline bool to_teme(int frame, double whole, double frac, double m[3][3]) {
  if (frame == 0) {
    for (int i = 0; i < 3; ++i)
      for (int j = 0; j < 3; ++j) m[i][j] = i == j ? 1.0 : 0.0;
    return true;
  }
  double g[3][3];
  if (frames::gcrf_to_teme(whole, frac, g) != 0) return false;
  if (frame == 1) {
    std::memcpy(m, g, sizeof g);
    return true;
  }
  double b[3][3];
  frames::frame_bias(b);  // r_EME2000 = B r_GCRF: TEME = G B^T
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) {
      double s = 0.0;
      for (int k = 0; k < 3; ++k) s += g[i][k] * b[j][k];
      m[i][j] = s;
    }
  return true;
}

inline int refuse(const char* code, const char* why) {
  plugin_set_error(code, why);
  return 3;
}

/// Reads one $OPM payload (plain or size-prefixed). 0, or 3 with a named error.
inline int read(const uint8_t* p, uint32_t n, Source& s) {
  if (!plain_view(p, n, "$OPM")) return refuse("invalid-opm", "An 'opm' payload is not an SDS $OPM.");
  flatbuffers::Verifier::Options vopt;
  vopt.check_alignment = false;  // a record cut from a size-prefixed stream is aligned to its prefix
  flatbuffers::Verifier ver(p, n, vopt);
  if (!VerifyOPMBuffer(ver)) return refuse("invalid-opm", "An 'opm' payload does not verify as an SDS $OPM.");
  const OPM* o = GetOPM(p);
  s = Source{};
  s.rec = o;
  if (o->CENTER_NAME() != nullptr && o->CENTER_NAME()->size() > 0 && !oem::same_text(o->CENTER_NAME()->c_str(), "EARTH"))
    return refuse("unsupported-center", "The $OPM CENTER_NAME is not EARTH; the theory is geocentric.");
  if (o->TIME_SYSTEM() != nullptr && o->TIME_SYSTEM()->size() > 0 && !oem::same_text(o->TIME_SYSTEM()->c_str(), "UTC"))
    return refuse("unsupported-time-system", "The $OPM TIME_SYSTEM is not UTC.");
  if (o->EPOCH() == nullptr || !omm::epoch(o->EPOCH()->c_str(), o->EPOCH()->size(), s.whole, s.frac))
    return refuse("invalid-opm", "The $OPM EPOCH is not an ISO 8601 UTC time.");
  const int frame = frame_of(o->REF_FRAME());
  if (frame < 0) return refuse("unknown-frame", "The $OPM REF_FRAME is none of TEME, GCRF, ICRF, EME2000 or J2000.");
  s.frame = o->REF_FRAME()->c_str();
  if (!has(o, OPM::VT_GM) || !(o->GM() > 3.98e5 && o->GM() < 3.99e5))
    return refuse("missing-gm", "The $OPM states no GM about the Earth (km^3/s^2).");
  s.gm = o->GM();
  // a FlatBuffer leaves a scalar at its default (0) off the wire: the Keplerian block is there when SEMI_MAJOR_AXIS is
  // (the other elements then read as written or 0; TRUE_ANOMALY when written, else MEAN_ANOMALY), the state when a
  // position and a velocity component are
  const bool kep = has(o, OPM::VT_SEMI_MAJOR_AXIS);
  const bool cart = (has(o, OPM::VT_X) || has(o, OPM::VT_Y) || has(o, OPM::VT_Z)) &&
                    (has(o, OPM::VT_X_DOT) || has(o, OPM::VT_Y_DOT) || has(o, OPM::VT_Z_DOT));
  if (!kep && !cart) return refuse("no-elements", "The $OPM carries neither a complete Keplerian block nor a state vector.");
  double r0[3], v0[3];
  if (kep) {
    const double a = o->SEMI_MAJOR_AXIS(), e = o->ECCENTRICITY();
    if (!(a > 0.0) || !(e >= 0.0 && e < 1.0)) return refuse("element-set-refused", "The $OPM Keplerian block is not a closed orbit.");
    double M = o->MEAN_ANOMALY() * kDeg;
    if (has(o, OPM::VT_TRUE_ANOMALY)) {
      const double nu = o->TRUE_ANOMALY() * kDeg;
      const double E = std::atan2(std::sqrt(1.0 - e * e) * std::sin(nu), e + std::cos(nu));
      M = E - e * std::sin(E);
    }
    const double el[6] = {a, e, o->INCLINATION() * kDeg, o->RA_OF_ASC_NODE() * kDeg, o->ARG_OF_PERICENTER() * kDeg, M};
    if (!segment::state_of(s.gm, el, r0, v0)) return refuse("element-set-refused", "The $OPM Keplerian block gives no state.");
    s.keplerian = true;
  } else {
    const double rr[3] = {o->X(), o->Y(), o->Z()}, vv[3] = {o->X_DOT(), o->Y_DOT(), o->Z_DOT()};
    std::memcpy(r0, rr, sizeof rr);
    std::memcpy(v0, vv, sizeof vv);
  }
  double m[3][3];
  if (!to_teme(frame, s.whole, s.frac, m)) return refuse("frame-failed", "No TEME axes at the $OPM EPOCH (outside ERFA's calendar).");
  frames::apply(m, r0, s.r);
  frames::apply(m, v0, s.v);
  const double rn = std::sqrt(s.r[0] * s.r[0] + s.r[1] * s.r[1] + s.r[2] * s.r[2]);
  if (!(rn > 6378.0 && rn < 1.0e6)) return refuse("element-set-refused", "The $OPM state is not an Earth orbit's (radius).");
  // forces: the record's areas and mass, else the regime's defaults
  const double mass = o->MASS();
  const bool drag = mass > 0.0 && o->DRAG_AREA() > 0.0, srp = mass > 0.0 && o->SOLAR_RAD_AREA() > 0.0;
  double el[6];
  const bool ok = segment::elements_of(events::mu_xp(), s.r, s.v, el);
  const bool drag_regime = ok && el[1] < 1.0 && (el[0] * (1.0 - el[1]) - xpt::kRe) < cov::kDragRegimeKm;
  s.forces_from_record = drag || srp;
  const pcf::Options& po = pcf::options();
  s.beff = drag ? (o->DRAG_COEFF() > 0.0 ? o->DRAG_COEFF() : kDefaultCd) * o->DRAG_AREA() / mass : drag_regime ? po.launch_drag_prior : 0.0;
  s.agom = srp ? (o->SOLAR_RAD_COEFF() > 0.0 ? o->SOLAR_RAD_COEFF() : kDefaultCr) * o->SOLAR_RAD_AREA() / mass : po.launch_srp_prior;
  // covariance, rotated to TEME
  if (o->COVARIANCE() != nullptr && o->COVARIANCE()->size() > 0) {
    if (o->COVARIANCE()->size() != 21) return refuse("invalid-covariance", "The $OPM COVARIANCE is not 21 values (the 6 x 6 lower triangle).");
    const int cf = o->COV_REF_FRAME() != nullptr && o->COV_REF_FRAME()->size() > 0 ? frame_of(o->COV_REF_FRAME()) : frame;
    if (cf < 0) return refuse("unknown-frame", "The $OPM COV_REF_FRAME is none of TEME, GCRF, ICRF, EME2000 or J2000.");
    double mc[3][3];
    if (!to_teme(cf, s.whole, s.frac, mc)) return refuse("frame-failed", "No TEME axes at the $OPM EPOCH (outside ERFA's calendar).");
    double P[36];
    int k = 0;
    for (int i = 0; i < 6; ++i)
      for (int j = 0; j <= i; ++j) P[i * 6 + j] = P[j * 6 + i] = o->COVARIANCE()->Get(k++);
    double B[36] = {};
    for (int i = 0; i < 3; ++i)
      for (int j = 0; j < 3; ++j) B[i * 6 + j] = B[(3 + i) * 6 + 3 + j] = mc[i][j];
    double BP[36];
    for (int i = 0; i < 6; ++i)
      for (int j = 0; j < 6; ++j) {
        double a = 0.0;
        for (int q = 0; q < 6; ++q) a += B[i * 6 + q] * P[q * 6 + j];
        BP[i * 6 + j] = a;
      }
    for (int i = 0; i < 6; ++i)
      for (int j = 0; j < 6; ++j) {
        double a = 0.0;
        for (int q = 0; q < 6; ++q) a += BP[i * 6 + q] * B[j * 6 + q];
        s.cov[i * 6 + j] = a;
      }
    for (int i = 0; i < 6; ++i)
      for (int j = 0; j < i; ++j) s.cov[i * 6 + j] = s.cov[j * 6 + i] = 0.5 * (s.cov[i * 6 + j] + s.cov[j * 6 + i]);
    s.has_cov = true;
  }
  return 0;
}

/// The SDN-AP set of a record (y0 = h^-1(x, t)) as an $OMM in `fbb`. 0, or 3 with a named error.
inline int set_of(const Source& s, flatbuffers::FlatBufferBuilder& fbb) {
  Elements e{};
  e.epoch_jd_whole = s.whole;
  e.epoch_jd_frac = s.frac;
  e.theory = kTheorySdnAp;
  e.bterm = s.beff;
  e.agom = s.agom;
  int steps = 0;
  if (!events::inverse_at_epoch(e, s.r, s.v, &steps)) return refuse("inverse-failed", "The inverse map did not converge at the $OPM state.");
  // the covariance's process noise: the regime's (SPEC 12.5), from the epoch
  double noise[5] = {};
  if (s.has_cov) {
    ElementRow row{};
    row.epoch_jd_whole = e.epoch_jd_whole;
    row.epoch_jd_frac = e.epoch_jd_frac;
    row.mean_motion_rev_day = e.xno * kMinutesPerDay / kTwoPi;
    row.eccentricity = e.eo;
    row.inclination_deg = e.xincl / kDeg;
    row.raan_deg = e.xnodeo / kDeg;
    row.arg_pericenter_deg = e.omegao / kDeg;
    row.mean_anomaly_deg = e.xmo / kDeg;
    row.bterm = e.bterm;
    row.agom = e.agom;
    row.theory = kTheorySdnAp;
    double ng = 0.0;
    int regime = 0;
    if (!cov::noise_of(row, 0.0, ng, regime, noise)) return refuse("element-set-refused", "The theory refuses the set made of the $OPM state.");
  }
  const OPM* o = s.rec;
  char epoch_text[48], comment[400], v[64];
  oem::iso_text(e.epoch_jd_whole, e.epoch_jd_frac, 0.0, epoch_text, sizeof epoch_text);
  std::snprintf(comment, sizeof comment,
                "SDN-AP set from osculating elements ($OPM %s, REF_FRAME %s, GM %.10g km^3/s^2): the state in TEME, y0 = h^-1(x, t) by the inverse map (%d steps); B_eff %.4g and AGOM %.4g m^2/kg %s%s",
                s.keplerian ? "Keplerian block" : "state vector", s.frame, s.gm, steps, s.beff, s.agom,
                s.forces_from_record ? "from the record's MASS, DRAG_AREA and SOLAR_RAD_AREA" : "(the regime's defaults; the record states no areas)",
                s.has_cov ? "; COVARIANCE rotated to TEME with the regime's process noise" : "");
  std::vector<flatbuffers::Offset<OMMUserDefinedParameter>> ps;
  auto put = [&](const char* name, double value) {
    std::snprintf(v, sizeof v, "%.17g", value);
    ps.push_back(CreateOMMUserDefinedParameterDirect(fbb, name, v));
  };
  auto put_text = [&](const char* name, const char* value) { ps.push_back(CreateOMMUserDefinedParameterDirect(fbb, name, value)); };
  put("SDNAP_B_EFF", e.bterm);
  put("SDNAP_KAPPA", 0.0);
  put("SDNAP_TAU0", 0.0);
  put("SDNAP_TAUC", 0.0);
  put("SDNAP_TAUS", 0.0);
  put("SDNAP_ARC_END_MIN", 0.0);
  put_text("SDNAP_SOURCE", "OSCULATING_OPM");
  put_text("SDNAP_SOURCE_ELEMENTS", s.keplerian ? "KEPLERIAN" : "STATE");
  put_text("SDNAP_SOURCE_FRAME", s.frame);
  put("SDNAP_SOURCE_GM", s.gm);
  put_text("SDNAP_CONVERSION", "INVERSE_MAP");
  put("SDNAP_CONVERSION_STEPS", steps);
  put_text("SDNAP_FORCES", s.forces_from_record ? "RECORD" : "REGIME_DEFAULT");
  if (s.has_cov) {
    std::string text;
    char one[32];
    for (int k = 0; k < 5; ++k) {
      std::snprintf(one, sizeof one, k == 0 ? "%.17g" : " %.17g", noise[k]);
      text += one;
    }
    put_text("SDNAP_COV_NOISE", text.c_str());
  }
  const auto s_user = fbb.CreateVector(ps);
  const auto s_epoch = fbb.CreateString(epoch_text);
  const auto s_comment = fbb.CreateString(comment);
  const auto s_center = fbb.CreateString("EARTH");
  const auto s_orig = o->ORIGINATOR() != nullptr ? fbb.CreateString(o->ORIGINATOR()->c_str()) : fbb.CreateString("SDN");
  const auto s_frame = CreateRFMDirect(fbb, RFMUnion_NONE, 0, 0, "TEME");
  const auto s_id = o->OBJECT_ID() != nullptr ? fbb.CreateString(o->OBJECT_ID()->c_str()) : 0;
  const auto s_name = o->OBJECT_NAME() != nullptr ? fbb.CreateString(o->OBJECT_NAME()->c_str()) : 0;
  flatbuffers::Offset<flatbuffers::Vector<double>> s_cov = 0;
  flatbuffers::Offset<RFM> s_cov_frame = 0;
  if (s.has_cov) {
    double c21[21];
    int k = 0;
    for (int i = 0; i < 6; ++i)
      for (int j = 0; j <= i; ++j) c21[k++] = s.cov[i * 6 + j];
    s_cov = fbb.CreateVector(c21, 21);
    s_cov_frame = CreateRFMDirect(fbb, RFMUnion_NONE, 0, 0, "TEME");
  }
  const double unix_seconds = ((e.epoch_jd_whole - 2440587.5) + e.epoch_jd_frac) * 86400.0, whole_seconds = std::floor(unix_seconds);
  OMMBuilder b(fbb);
  b.add_ORIGINATOR(s_orig);
  b.add_CENTER_NAME(s_center);
  b.add_REFERENCE_FRAME(s_frame);
  b.add_TIME_SYSTEM(timingStandard_UTC);
  b.add_MEAN_ELEMENT_THEORY(meanElementSource_SDNAP);
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
  b.add_USER_DEFINED_PARAMETERS(s_user);
  if (s.has_cov) {
    b.add_COV_REFERENCE_FRAME(s_cov_frame);
    b.add_COVARIANCE(s_cov);
  }
  FinishOMMBuffer(fbb, b.Finish());
  return 0;
}

/// One 'opm' payload as the bytes of its SDN-AP $OMM in `fbb` (propagate's 'opm' frames). 0, or 3 with a named error.
int set_bytes(const uint8_t* p, uint32_t n, flatbuffers::FlatBufferBuilder& fbb) {
  Source s;
  if (const int rc = read(p, n, s)) return rc;
  return set_of(s, fbb);
}

}  // namespace opm
}  // namespace sdnap

/// `opm_set`: one SDN-AP $OMM ('elements') per 'opm' $OPM (SPEC 13).
extern "C" int opm_set(void) {
  using namespace sdnap;
  plugin_reset_output_state();
  // THEORY (UNSPECIFIED or SDNAP), LAUNCH (the B_eff and AGOM priors a record without areas takes) and MEAN_ELEMENT
  if (const int rc = pcf::read(pcf::kLaunchSet)) return rc;
  const uint32_t frames_n = plugin_get_input_count();
  int done = 0;
  for (uint32_t i = 0; i < frames_n; ++i) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (f == nullptr || f->port_id == nullptr || std::strcmp(f->port_id, "opm") != 0) continue;
    opm::Source s;
    if (const int rc = opm::read(f->payload, f->payload_length, s)) return rc;
    flatbuffers::FlatBufferBuilder fbb(1024);
    if (const int rc = opm::set_of(s, fbb)) return rc;
    if (plugin_push_output("elements", "OMM.fbs", "$OMM", fbb.GetBufferPointer(), fbb.GetSize()) < 0)
      return opm::refuse("output-failed", "The $OMM could not be emitted.");
    ++done;
  }
  if (done == 0) return opm::refuse("missing-opm", "opm_set takes one or more 'opm' $OPM records.");
  return 0;
}

// ---- Osculating elements and two-body motion about a stated GM (the derived sets' re-expression and the scores' floor)

/// The osculating elements of a state (km, km/s, any inertial axes) about `gm` (km^3/s^2): out = a (km), e, i, RAAN,
/// argument of pericenter, true anomaly, mean anomaly (deg, [0, 360)) and the period (s). 0, or -1 for an open or
/// degenerate orbit.
SDNAP_EXPORT("sdnap_osculating_elements_about")
int32_t sdnap_osculating_elements_about(const double* r, const double* v, double gm, double* out) {
  if (r == nullptr || v == nullptr || out == nullptr || !(gm > 0.0)) return -1;
  double el[6];
  if (!sdnap::segment::elements_of(gm, r, v, el) || !(el[1] < 1.0) || !(el[0] > 0.0)) return -1;
  const double e = el[1], M = el[5];
  double E = M;
  for (int k = 0; k < 50; ++k) {
    const double d = (E - e * std::sin(E) - M) / (1.0 - e * std::cos(E));
    E -= d;
    if (std::fabs(d) < 1e-15) break;
  }
  const double nu = std::atan2(std::sqrt(1.0 - e * e) * std::sin(E), std::cos(E) - e);
  const double deg = 180.0 / sdnap::kPi;
  out[0] = el[0];
  out[1] = e;
  out[2] = el[2] * deg;
  out[3] = sdnap::xpt::wrap(el[3]) * deg;
  out[4] = sdnap::xpt::wrap(el[4]) * deg;
  out[5] = sdnap::xpt::wrap(nu) * deg;
  out[6] = sdnap::xpt::wrap(M) * deg;
  out[7] = sdnap::kTwoPi * std::sqrt(el[0] * el[0] * el[0] / gm);
  return 0;
}

/// Two-body motion about `gm` (km^3/s^2): the state (km, km/s) `seconds` after the given one, in its axes. 0, or -1 for
/// an open or degenerate orbit.
SDNAP_EXPORT("sdnap_kepler_at")
int32_t sdnap_kepler_at(const double* r, const double* v, double gm, double seconds, double* out) {
  if (r == nullptr || v == nullptr || out == nullptr || !(gm > 0.0)) return -1;
  double el[6];
  if (!sdnap::segment::elements_of(gm, r, v, el) || !(el[1] < 1.0) || !(el[0] > 0.0)) return -1;
  el[5] += std::sqrt(gm / (el[0] * el[0] * el[0])) * seconds;
  return sdnap::segment::state_of(gm, el, out, out + 3) ? 0 : -1;
}
