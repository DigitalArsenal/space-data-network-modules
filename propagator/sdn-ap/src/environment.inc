// -----------------------------------------------------------------------------
// The invoke surface: `load_environment` replaces the SDN-AP environment with
// SDS records as FFM reads them (SDS 1.261.0): space weather as $SPW rows or
// a $PRW whose SPACE_WEATHER holds them (DATE, F107_OBS, F107_OBS_CENTER81,
// AP_AVG), and the open-DCA common mode as a $DCL (Solved, on NRLMSISE-00,
// LogDensityNodes: NODE_TIMES_MS and NODE_LOG_DENSITY_SCALE_DIMENSIONLESS).
// The density kernel's kernel times are rebuilt from the new records.
// -----------------------------------------------------------------------------

namespace sdnap {
namespace envload {

inline bool spw_row(const SPW* row, sdn::SpwDay& d) {
  double whole, frac;
  if (row == nullptr || row->DATE() == nullptr || !omm::epoch(row->DATE()->c_str(), row->DATE()->size(), whole, frac) ||
      !(row->F107_OBS() > 0.0f) || !(row->F107_OBS_CENTER81() > 0.0f) || row->AP_AVG() < 0)
    return false;
  d.mjd = static_cast<int32_t>(std::floor((whole - 2400000.5) + frac));
  d.f107_obs = row->F107_OBS();
  d.f107_center81 = row->F107_OBS_CENTER81();
  d.ap_avg = row->AP_AVG();
  d.pad = 0;
  return true;
}

inline bool size_prefixed(const uint8_t* p, uint32_t n, const char* ident) {
  return n >= 12 && flatbuffers::ReadScalar<uint32_t>(p) == n - 4 && std::memcmp(p + 8, ident, 4) == 0;
}

inline const char*& last_error() {
  static const char* text = "";
  return text;
}

/// Kernel times were built under the previous environment: drop the unpinned ones.
inline void invalidate_kernel() {
  kernel::Cache& kc = kernel::cache();
  if (kc.ready)
    for (int j = 0; j < kernel::kSlots; ++j)
      if (kc.slot[j].pins == 0) kc.slot[j].key = -1;
}

}  // namespace envload
}  // namespace sdnap

namespace sdnap {
namespace envload {

/// The open-DCA $DCL (SDS 1.261.0, plain or size-prefixed), validated as FFM
/// validates it: Solved, NRLMSISE-00 baseline, LogDensityNodes with one
/// dimensionless value per strictly increasing UTC node. Returns the reason it
/// was refused, or nullptr when s(t) now follows it.
inline const char* load_dcl(const uint8_t* p, uint32_t n) {
  if (p == nullptr) return "no record";
  const bool prefixed = size_prefixed(p, n, "$DCL");
  flatbuffers::Verifier verifier(p, n);
  if (!(prefixed ? VerifySizePrefixedDCLBuffer(verifier) : (n >= 8 && DCLBufferHasIdentifier(p) && VerifyDCLBuffer(verifier))))
    return "not an SDS $DCL";
  const DCL* rec = prefixed ? GetSizePrefixedDCL(p) : GetDCL(p);
  const auto* c = rec->CORRECTION();
  if (rec->STATUS() != dclStatus_Solved) return "the published calibration must be Solved";
  if (rec->ATMOSPHERE() == nullptr || rec->ATMOSPHERE()->MODEL() != AtmosphericModelFamily_NRLMSIS00E)
    return "the baseline atmosphere must be NRLMSISE-00";
  if (c == nullptr || c->FORM() != dclCorrectionForm_LogDensityNodes) return "expected LogDensityNodes";
  if ((c->NODE_ALTITUDES_KM() && c->NODE_ALTITUDES_KM()->size()) || (c->NODE_VALUES_K() && c->NODE_VALUES_K()->size()) ||
      (c->NODE_SIGMAS_K() && c->NODE_SIGMAS_K()->size()) || (c->SEGMENTS() && c->SEGMENTS()->size()))
    return "log-density nodes cannot carry temperature, altitude or harmonic values";
  const auto* times = c->NODE_TIMES_MS();
  const auto* values = c->NODE_LOG_DENSITY_SCALE_DIMENSIONLESS();
  if (times == nullptr || values == nullptr || times->size() == 0 || times->size() != values->size())
    return "expected one dimensionless value per UTC node";
  const uint32_t m = times->size();
  double* t = static_cast<double*>(std::malloc(sizeof(double) * m));
  double* sv = static_cast<double*>(std::malloc(sizeof(double) * m));
  if (t == nullptr || sv == nullptr) {
    std::free(t);
    std::free(sv);
    return "no memory";
  }
  int64_t previous = 0;
  for (uint32_t k = 0; k < m; ++k) {
    const int64_t ms = times->Get(k);
    const double v = values->Get(k);
    if (ms < 63072000000LL || ms > 253402300799999LL || (k > 0 && ms <= previous) || !std::isfinite(v) || !std::isfinite(std::exp(v))) {
      std::free(t);
      std::free(sv);
      return "UTC nodes must increase strictly within 1972..9999 with finite values";
    }
    previous = ms;
    t[k] = static_cast<double>(ms) / 86400000.0 + 7306.0;  // days from 1950 January 0.0 UTC (JD 2440587.5 - 2433281.5)
    sv[k] = v;
  }
  sdn::DensityCorrection& dc = sdn::density_correction();
  std::free(dc.d50);
  std::free(dc.s);
  dc.d50 = t;
  dc.s = sv;
  dc.count = m;
  invalidate_kernel();
  return nullptr;
}

}  // namespace envload
}  // namespace sdnap

namespace sdnap {
namespace envload {

/// The environment inputs of the current invocation ('space_weather' $SPW rows,
/// 'space_weather_table' $PRW, 'density_correction' $DCL), applied as FFM reads
/// them; other ports are ignored. Returns 0, or 3 with the error set.
inline int apply_frames(bool& have_spw, bool& have_dcl) {
  const uint32_t frames = plugin_get_input_count();
  std::vector<sdn::SpwDay> days;
  have_spw = false;
  have_dcl = false;
  for (uint32_t i = 0; i < frames; ++i) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (f == nullptr || f->port_id == nullptr || f->payload == nullptr) continue;
    const uint8_t* p = f->payload;
    const uint32_t n = f->payload_length;
    if (std::strcmp(f->port_id, "density_correction") == 0) {
      const char* why = load_dcl(p, n);
      if (why != nullptr) {
        plugin_set_error("invalid-density-correction", why);
        return 3;
      }
      have_dcl = true;
      continue;
    }
    if (std::strcmp(f->port_id, "space_weather") == 0 || std::strcmp(f->port_id, "space_weather_table") == 0) {
      have_spw = true;
      flatbuffers::Verifier verifier(p, n);
      if (n >= 8 && SPWBufferHasIdentifier(p) && VerifySPWBuffer(verifier)) {
        sdn::SpwDay d{};
        if (!spw_row(GetSPW(p), d)) {
          plugin_set_error("invalid-space-weather", "An $SPW row needs an ISO DATE, positive F10.7 and nonnegative Ap.");
          return 3;
        }
        days.push_back(d);
        continue;
      }
      const PRW* prw = nullptr;
      flatbuffers::Verifier v2(p, n);
      if (size_prefixed(p, n, "$PRW") && VerifySizePrefixedPRWBuffer(v2)) prw = GetSizePrefixedPRW(p);
      else if (n >= 8 && PRWBufferHasIdentifier(p) && VerifyPRWBuffer(v2)) prw = GetPRW(p);
      if (prw == nullptr || prw->SPACE_WEATHER() == nullptr || prw->SPACE_WEATHER()->ROWS() == nullptr) {
        plugin_set_error("invalid-space-weather", "A 'space_weather' payload is neither an $SPW row nor a $PRW holding SPACE_WEATHER rows.");
        return 3;
      }
      for (const SPW* row : *prw->SPACE_WEATHER()->ROWS()) {
        sdn::SpwDay d{};
        if (!spw_row(row, d)) {
          plugin_set_error("invalid-space-weather", "An $SPW row needs an ISO DATE, positive F10.7 and nonnegative Ap.");
          return 3;
        }
        days.push_back(d);
      }
    }
  }
  if (have_spw) {
    std::sort(days.begin(), days.end(), [](const sdn::SpwDay& a, const sdn::SpwDay& b) { return a.mjd < b.mjd; });
    std::vector<sdn::SpwDay> unique;
    for (const sdn::SpwDay& d : days) {
      if (!unique.empty() && unique.back().mjd == d.mjd) unique.back() = d;
      else unique.push_back(d);
    }
    sdn::SpwDay* table = static_cast<sdn::SpwDay*>(std::malloc(sizeof(sdn::SpwDay) * (unique.size() ? unique.size() : 1)));
    if (table == nullptr) { plugin_set_error("out-of-memory", "No memory for the space weather."); return 3; }
    std::memcpy(table, unique.data(), sizeof(sdn::SpwDay) * unique.size());
    sdn::SpaceWeather& sw = sdn::space_weather();
    std::free(sw.days);
    sw.days = table;
    sw.count = static_cast<uint32_t>(unique.size());
  }
  invalidate_kernel();
  return 0;
}

}  // namespace envload
}  // namespace sdnap

extern "C" int load_environment(void) {
  using namespace sdnap;
  plugin_reset_output_state();
  bool have_spw = false, have_dcl = false;
  const int st = envload::apply_frames(have_spw, have_dcl);
  if (st != 0) return st;
  if (!have_spw && !have_dcl) {
    plugin_set_error("missing-environment", "A 'space_weather', 'space_weather_table' or 'density_correction' input is required.");
    return 3;
  }
  return 0;
}

/// The open-DCA $DCL as a direct export (the loader of load_environment's
/// 'density_correction' port). Returns 0, or a negative code with the reason in
/// `sdnap_last_error`.
SDNAP_EXPORT("sdnap_load_density_correction")
int32_t sdnap_load_density_correction(const uint8_t* p, uint32_t n) {
  const char* why = sdnap::envload::load_dcl(p, n);
  if (why != nullptr) {
    sdnap::envload::last_error() = why;
    return ORBPRO_PROP_BAD_INPUT;
  }
  return ORBPRO_PROP_OK;
}
