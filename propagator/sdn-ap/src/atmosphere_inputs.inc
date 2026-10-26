// -----------------------------------------------------------------------------
// SPEC 15: the drag atmosphere of a `fit` or `propagate` call, from its $PCF
// FORCES (pcf.inc) and its frames:
//   'space_weather'       $SPW daily rows (SDS 1.271.0): plain records, or
//                         size-prefixed records end to end; DATE, F107_OBS,
//                         F107_OBS_CENTER81, AP_AVG; a later frame's row
//                         replaces an earlier one of the same day;
//   'density_correction'  one $DCL (plain or size-prefixed), read as FFM reads
//                         the open-DCA product: Solved, on NRLMSISE-00,
//                         LogDensityNodes, one finite dimensionless value per
//                         strictly increasing UTC node.
// With no FORCES selection and no frames the call keeps the theory's own drag
// (no atmosphere). The atmosphere lives for the call (Scope).
// -----------------------------------------------------------------------------

namespace sdnap {
namespace atm {

inline Atmosphere& call_atmosphere() {
  static Atmosphere a;
  return a;
}

inline int fail(const char* code, const char* why) {
  plugin_set_error(code, why);
  return 3;
}

/// One $SPW row (a verified plain view) as a day; false when it lacks an ISO DATE, a positive F10.7 and its 81-day mean,
/// or a non-negative Ap.
inline bool spw_day(const SPW* row, SpwDay& d) {
  double whole, frac;
  if (row == nullptr || row->DATE() == nullptr || !omm::epoch(row->DATE()->c_str(), row->DATE()->size(), whole, frac) ||
      !(row->F107_OBS() > 0.0f) || !(row->F107_OBS_CENTER81() > 0.0f) || row->AP_AVG() < 0)
    return false;
  d.mjd = static_cast<int32_t>(std::floor((whole - 2400000.5) + frac));
  d.f107_obs = row->F107_OBS();
  d.f107_center81 = row->F107_OBS_CENTER81();
  d.ap_avg = row->AP_AVG();
  return true;
}

/// The rows of one 'space_weather' frame appended to `days`: 0, or 3 refused by name.
inline int read_spw_frame(const uint8_t* p, uint32_t n, std::vector<SpwDay>& days) {
  auto one = [&](const uint8_t* q, uint32_t m) {
    flatbuffers::Verifier::Options vopt;
    vopt.check_alignment = false;  // a record cut from a size-prefixed stream is aligned to its prefix, not to its own start
    flatbuffers::Verifier v(q, m, vopt);
    if (m < 8 || std::memcmp(q + 4, "$SPW", 4) != 0 || !VerifySPWBuffer(v)) return false;
    SpwDay d{};
    if (!spw_day(GetSPW(q), d)) return false;
    days.push_back(d);
    return true;
  };
  if (n >= 8 && std::memcmp(p + 4, "$SPW", 4) == 0) {
    if (!one(p, n)) return fail("invalid-space-weather", "An $SPW row needs an ISO DATE, positive F107_OBS and F107_OBS_CENTER81, and AP_AVG >= 0.");
    return 0;
  }
  for (uint32_t off = 0; off < n;) {
    uint32_t len = 0;
    if (n - off >= 12) std::memcpy(&len, p + off, 4);
    if (n - off < 12 || len > n - off - 4 || !one(p + off + 4, len))
      return fail("invalid-space-weather", "A 'space_weather' frame is an $SPW row or size-prefixed $SPW rows end to end, each with an ISO DATE, positive F107_OBS and F107_OBS_CENTER81, and AP_AVG >= 0.");
    off += 4 + len;
  }
  return 0;
}

/// The open-DCA $DCL into a's nodes: nullptr, or the reason it is refused.
inline const char* read_dcl(const uint8_t* p, uint32_t n, Atmosphere& a) {
  if (!plain_view(p, n, "$DCL")) return "not an SDS $DCL";
  flatbuffers::Verifier verifier(p, n);
  if (!VerifyDCLBuffer(verifier)) return "the $DCL does not verify";
  const DCL* rec = GetDCL(p);
  const auto* c = rec->CORRECTION();
  if (rec->STATUS() != dclStatus_Solved) return "the calibration must be Solved";
  if (rec->ATMOSPHERE() == nullptr || rec->ATMOSPHERE()->MODEL() != AtmosphericModelFamily_NRLMSIS00E) return "the baseline atmosphere must be NRLMSISE-00";
  if (c == nullptr || c->FORM() != dclCorrectionForm_LogDensityNodes) return "expected LogDensityNodes";
  if ((c->NODE_ALTITUDES_KM() && c->NODE_ALTITUDES_KM()->size()) || (c->NODE_VALUES_K() && c->NODE_VALUES_K()->size()) ||
      (c->NODE_SIGMAS_K() && c->NODE_SIGMAS_K()->size()) || (c->SEGMENTS() && c->SEGMENTS()->size()))
    return "log-density nodes carry no temperature, altitude or harmonic values";
  const auto* times = c->NODE_TIMES_MS();
  const auto* values = c->NODE_LOG_DENSITY_SCALE_DIMENSIONLESS();
  if (times == nullptr || values == nullptr || times->size() == 0 || times->size() != values->size()) return "expected one dimensionless value per UTC node";
  int64_t previous = 0;
  for (uint32_t k = 0; k < times->size(); ++k) {
    const int64_t ms = times->Get(k);
    const double v = values->Get(k);
    if (ms < 63072000000LL || ms > 253402300799999LL || (k > 0 && ms <= previous) || !std::isfinite(v) || !std::isfinite(std::exp(v)))
      return "UTC nodes must increase strictly within 1972..9999, with finite values";
    previous = ms;
    a.dca_d50.push_back(static_cast<double>(ms) / 86400000.0 + 7306.0);  // days from 1950 January 0.0 UTC (JD 2440587.5 - 2433281.5)
    a.dca_s.push_back(v);
  }
  return nullptr;
}

/// The rows of the frames, in day order, a later frame's row replacing an earlier one of the same day.
inline void set_rows(Atmosphere& a, std::vector<SpwDay>& days) {
  std::stable_sort(days.begin(), days.end(), [](const SpwDay& x, const SpwDay& y) { return x.mjd < y.mjd; });
  a.days.clear();
  for (const SpwDay& d : days) {
    if (!a.days.empty() && a.days.back().mjd == d.mjd) a.days.back() = d;
    else a.days.push_back(d);
  }
}

/// The call's atmosphere from pcf::options() and the frames: 0 with active() set (nullptr when the call keeps the
/// theory's own drag), or 3 refused by name.
inline int prepare() {
  const pcf::Options& o = pcf::options();
  Atmosphere& a = call_atmosphere();
  a = Atmosphere{};
  active() = nullptr;
  std::vector<SpwDay> days;
  bool have_rows = false, have_dcl = false;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (f == nullptr || f->port_id == nullptr || f->payload == nullptr) continue;
    if (std::strcmp(f->port_id, "space_weather") == 0) {
      if (const int rc = read_spw_frame(f->payload, f->payload_length, days)) return rc;
      have_rows = true;
    } else if (std::strcmp(f->port_id, "density_correction") == 0) {
      if (have_dcl) return fail("invalid-density-correction", "One 'density_correction' $DCL per call.");
      if (const char* why = read_dcl(f->payload, f->payload_length, a)) return fail("invalid-density-correction", why);
      have_dcl = true;
    }
  }
  if (have_dcl && !o.dca) return fail("density-correction-unselected", "A 'density_correction' $DCL is given, but FORCES.DENSITY_CORRECTION is NONE.");
  if (o.dca && !have_dcl) return fail("density-correction-missing", "FORCES.DENSITY_CORRECTION DCA_COMMON_MODE needs a 'density_correction' $DCL.");
  if (o.weather_source == pcfWeatherSource_RECORDS && !have_rows)
    return fail("space-weather-missing", "FORCES.WEATHER_SOURCE RECORDS needs 'space_weather' $SPW rows.");
  if (o.msis && !have_rows) return fail("space-weather-missing", "NRLMSISE-00 (FORCES.ENABLE_DRAG) needs 'space_weather' $SPW rows.");
  if (have_rows && days.empty()) return fail("space-weather-missing", "The 'space_weather' frames hold no rows.");
  if (!have_rows && !o.msis) return 0;  // the theory's own drag
  set_rows(a, days);
  a.model = o.msis ? kNrlmsise00 : kJacchia70;
  a.measured = true;
  active() = &a;
  return 0;
}

/// 0, or 3 when an evaluation of the call asked for a day before the rows (atmosphere.inc row_at).
inline int coverage() {
  const Atmosphere* a = active();
  if (a == nullptr || !a->before_rows) return 0;
  return fail("space-weather-out-of-range",
              "The 'space_weather' rows start after a day the call evaluates: they must begin by the day before its earliest state's day.");
}

/// The call's atmosphere ends with the call.
struct Scope {
  ~Scope() { active() = nullptr; }
};

}  // namespace atm
}  // namespace sdnap

// Diagnostic (test/atmosphere.e2e.mjs): the density (kg/m^3) a drag node takes at a TEME position r (km) and UTC time
// (whole + frac Julian date), through the node formulas of SPEC 3.4 (r's geocentric latitude and radius, the Sun of
// SPEC 5, the Greenwich angle of SPEC 1.2): model 0 the theory's own (SPEC 3 on the generic flux model), 1 Jacchia 1970
// and 2 NRLMSISE-00 on the drivers of `rows` (a 'space_weather' frame: $SPW rows, read as fit and propagate read them),
// 3 NRLMSISE-00 on those drivers times exp(s(t)) of `dcl` (a 'density_correction' $DCL, read as fit and propagate read
// it; models 0 to 2 take none). out: density, geodetic latitude (rad), longitude (rad, in [-pi, pi)), geodetic height
// (km), and the drivers (F10.7, F10.7a, Ap). Returns 0, 1 when the rows do not reach the day before the time's day, or
// -1 for a bad request.
SDNAP_EXPORT("sdnap_atmosphere_probe")
int32_t sdnap_atmosphere_probe(int32_t model, double whole, double frac, const double* r_km, const uint8_t* rows, uint32_t rows_length,
                               const uint8_t* dcl, uint32_t dcl_length, double* out) {
  using namespace sdnap;
  if (model < 0 || model > 3 || r_km == nullptr || out == nullptr) return -1;
  if ((model == 3) != (dcl != nullptr && dcl_length > 0)) return -1;
  const double rn = std::sqrt(r_km[0] * r_km[0] + r_km[1] * r_km[1] + r_km[2] * r_km[2]);
  if (!(rn > 0.0)) return -1;
  const double d50 = (whole - kJd1950) + frac;
  atm::Atmosphere a;
  a.model = model >= 2 ? atm::kNrlmsise00 : atm::kJacchia70;
  a.measured = model != 0;
  if (model != 0) {
    std::vector<atm::SpwDay> days;
    if (rows == nullptr || atm::read_spw_frame(rows, rows_length, days) != 0 || days.empty()) return -1;
    atm::set_rows(a, days);
  }
  if (model == 3 && atm::read_dcl(dcl, dcl_length, a) != nullptr) return -1;
  const double sp = r_km[2] / rn, cp = std::sqrt(1.0 - sp * sp);
  const xpt::NodeHeight nh = xpt::node_height(sp, cp, rn / xpt::kRe);
  const xpt::Bodies b = xpt::bodies_at(d50);
  const double sdsun = b.sun_u.z, cdsun = std::sqrt(1.0 - b.sun_u.z * b.sun_u.z);
  const double alpha = std::atan2(r_km[1], r_km[0]);
  double H = alpha - std::atan2(b.sun_u.y, b.sun_u.x);
  H -= kTwoPi * std::floor(H / kTwoPi);
  const double theta_g = gsto_afspc(d50);
  const drag::Flux fl = model == 0 ? drag::flux_at(d50) : atm::drivers_at(a, d50);
  double D, N;
  drag::day_of_year(d50, D, N);
  const drag::DateTerms dt = drag::date_terms(fl, D, N);
  const double dca = !a.dca_d50.empty() ? atm::dca_scale(a, d50) : 1.0;  // as drag_rates takes it (model 3 only)
  out[0] = xpt::node_density(model == 0 ? nullptr : &a, dt, fl, dca, d50, sp, cp, sdsun, cdsun, H, alpha, theta_g, nh);
  out[1] = xpt::geodetic_latitude(sp, nh);
  out[2] = atm::wrap_pi(alpha - theta_g);
  out[3] = nh.h;
  out[4] = fl.f;
  out[5] = fl.fbar;
  out[6] = fl.ap;
  return a.before_rows ? 1 : 0;
}
