// -----------------------------------------------------------------------------
// Exports: the OrbPro propagator ABI (Earth-fixed meters) and the module's
// structure-of-arrays batch entries (sdnap_*).
// -----------------------------------------------------------------------------

#define SDNAP_EXPORT(name) __attribute__((export_name(name))) extern "C"

namespace sdnap {

/// Theory an OrbProOMMRecord is read under (the record carries none). For
/// SGP4XP, BTERM is in `bstar` and AGOM in `mean_motion_ddot` (m^2/kg), the
/// convention of modules propagator/sgp4-xp.
inline int32_t& omm_theory() {
  static int32_t theory = kTheorySgp4Xp;
  return theory;
}

inline ElementRow row_of_omm(const OrbProOMMRecord& r, int32_t theory) {
  ElementRow row{};
  split_jd(r.epoch_jd, row.epoch_jd_whole, row.epoch_jd_frac);
  row.mean_motion_rev_day = r.mean_motion;
  row.eccentricity = r.eccentricity;
  row.inclination_deg = r.inclination;
  row.raan_deg = r.ra_of_asc_node;
  row.arg_pericenter_deg = r.arg_of_pericenter;
  row.mean_anomaly_deg = r.mean_anomaly;
  row.norad_cat_id = r.norad_cat_id;
  row.theory = theory;
  if (theory == kTheorySgp4Xp) {
    row.bterm = r.bstar;
    row.agom = r.mean_motion_ddot;
  } else {
    row.bstar = r.bstar;
    row.mean_motion_dot = r.mean_motion_dot;
    row.mean_motion_ddot = r.mean_motion_ddot;
  }
  return row;
}

inline int32_t abi_status(int32_t e) {
  switch (e) {
    case kPropOk: return ORBPRO_PROP_OK;
    default: return ORBPRO_PROP_UNPHYSICAL;
  }
}

inline int32_t write_state(uint32_t i, double jd_whole, double jd_frac, OrbProStateVector* out,
                           const xpt::Bodies* shared = nullptr, const double* theta = nullptr) {
  double r[3], v[3];
  const double t = minutes_since_epoch(i, jd_whole, jd_frac);
  const int32_t e = row_propagate(i, t, r, v, shared);
  orbpro_state_init(out);
  out->epoch = jd_whole + jd_frac;
  if (e != kPropOk) {
    out->flags = e == kPropDecayed ? ORBPRO_STATE_DECAYED : ORBPRO_STATE_NONE;
    return abi_status(e);
  }
  teme_to_ecef_m(theta != nullptr ? *theta : gmst(jd_whole, jd_frac), r, v, out->position, out->velocity);
  orbpro_state_set_reference_frame(out, ORBPRO_FRAME_ECEF);
  out->flags = ORBPRO_STATE_VALID;
  return ORBPRO_PROP_OK;
}

namespace pool {
void run_chunk(const Job& j, int32_t chunk) {
  const uint32_t begin = static_cast<uint32_t>(chunk) * kChunk;
  const uint32_t end = begin + kChunk < j.count ? begin + kChunk : j.count;
  const uint32_t n = j.count;
  double* x = j.out;
  double* y = x + n;
  double* z = y + n;
  double* vx = z + n;
  double* vy = vx + n;
  double* vz = vy + n;
  const double theta = j.theta;
  const xpt::Bodies* shared = j.kind == kJobJd ? &j.bodies : nullptr;
  for (uint32_t i = begin; i < end; ++i) {
    const uint32_t row = j.first + i;
    const double t = j.kind == kJobMinutes ? j.minutes[i] : minutes_since_epoch(row, j.jd_whole, j.jd_frac);
    double r[3] = {0, 0, 0}, v[3] = {0, 0, 0};
    const int32_t e = row_propagate(row, t, r, v, shared);
    if (j.status != nullptr) j.status[i] = e;
    if (e == kPropOk && j.kind == kJobJd && j.frame == ORBPRO_FRAME_ECEF) {
      double ro[3], vo[3];
      teme_to_ecef_m(theta, r, v, ro, vo);
      x[i] = ro[0]; y[i] = ro[1]; z[i] = ro[2];
      vx[i] = vo[0]; vy[i] = vo[1]; vz[i] = vo[2];
    } else {
      x[i] = r[0]; y[i] = r[1]; z[i] = r[2];
      vx[i] = v[0]; vy[i] = v[1]; vz[i] = v[2];
    }
  }
}
}  // namespace pool

inline int32_t batch(int32_t kind, double jd_whole, double jd_frac, const double* minutes, uint32_t first,
                     uint32_t count, uint32_t frame, double* out, int32_t* status) {
  const Store& st = store();
  if (st.count == 0) return ORBPRO_PROP_NOT_INITIALIZED;
  if (out == nullptr) return ORBPRO_PROP_NULL_OUTPUT;
  if (first > st.count || count > st.count - first) return ORBPRO_PROP_BAD_ENTITY_INDEX;
  if (kind == pool::kJobMinutes && minutes == nullptr) return ORBPRO_PROP_BAD_INPUT;
  if (frame != ORBPRO_FRAME_TEME && frame != ORBPRO_FRAME_ECEF) return ORBPRO_PROP_BAD_INPUT;
  pool::Job& j = pool::job();
  j.kind = kind;
  j.jd_whole = jd_whole;
  j.jd_frac = jd_frac;
  j.minutes = minutes;
  j.first = first;
  j.count = count;
  j.frame = frame;
  j.out = out;
  j.status = status;
  // Terms that depend on the time only, once per batch time: the Sun and Moon, GMST.
  if (kind == pool::kJobJd) {
    j.bodies = xpt::bodies_at((jd_whole - kJd1950) + jd_frac);
    j.theta = frame == ORBPRO_FRAME_ECEF ? gmst(jd_whole, jd_frac) : 0.0;
  }
  pool::run(count);
  return ORBPRO_PROP_OK;
}

}  // namespace sdnap

// --- OrbPro propagator ABI ----------------------------------------------------

SDNAP_EXPORT("plugin_init_omm")
int32_t plugin_init_omm(const OrbProOMMRecord* records, uint32_t count) {
  if (records == nullptr && count > 0) return ORBPRO_PROP_BAD_INPUT;
  sdnap::ElementRow* rows = static_cast<sdnap::ElementRow*>(std::malloc(sizeof(sdnap::ElementRow) * (count ? count : 1)));
  if (rows == nullptr) return ORBPRO_PROP_BAD_INPUT;
  for (uint32_t i = 0; i < count; ++i) rows[i] = sdnap::row_of_omm(records[i], sdnap::omm_theory());
  const int32_t held = sdnap::store_init(rows, count);
  std::free(rows);
  return held < 0 ? ORBPRO_PROP_BAD_INPUT : held;
}

SDNAP_EXPORT("plugin_init")
int32_t plugin_init(const uint8_t* data, size_t len) {
  if (data == nullptr || len == 0 || len % sizeof(OrbProOMMRecord) != 0) return ORBPRO_PROP_BAD_INPUT;
  return plugin_init_omm(reinterpret_cast<const OrbProOMMRecord*>(data),
                         static_cast<uint32_t>(len / sizeof(OrbProOMMRecord)));
}

SDNAP_EXPORT("plugin_propagate")
int32_t plugin_propagate(double julian_date, uint32_t entity_index, OrbProStateVector* out) {
  if (out == nullptr) return ORBPRO_PROP_NULL_OUTPUT;
  const sdnap::Store& st = sdnap::store();
  if (st.count == 0) return ORBPRO_PROP_NOT_INITIALIZED;
  if (entity_index >= st.count) return ORBPRO_PROP_BAD_ENTITY_INDEX;
  double whole, frac;
  sdnap::split_jd(julian_date, whole, frac);
  return sdnap::write_state(entity_index, whole, frac, out);
}

SDNAP_EXPORT("plugin_propagate_batch")
int32_t plugin_propagate_batch(double julian_date, OrbProStateVector* out, uint32_t count) {
  if (out == nullptr) return ORBPRO_PROP_NULL_OUTPUT;
  const sdnap::Store& st = sdnap::store();
  if (st.count == 0) return ORBPRO_PROP_NOT_INITIALIZED;
  if (count > st.count) return ORBPRO_PROP_BAD_ENTITY_INDEX;
  double whole, frac;
  sdnap::split_jd(julian_date, whole, frac);
  const sdnap::xpt::Bodies shared = sdnap::xpt::bodies_at((whole - sdnap::kJd1950) + frac);
  const double theta = sdnap::gmst(whole, frac);
  int32_t first_error = ORBPRO_PROP_OK;
  for (uint32_t i = 0; i < count; ++i) {
    const int32_t status = sdnap::write_state(i, whole, frac, &out[i], &shared, &theta);
    if (status != ORBPRO_PROP_OK && first_error == ORBPRO_PROP_OK) first_error = status;
  }
  return first_error;
}

SDNAP_EXPORT("plugin_entity_count")
int32_t plugin_entity_count(void) { return static_cast<int32_t>(sdnap::store().count); }

SDNAP_EXPORT("plugin_destroy")
void plugin_destroy(void) { sdnap::store_free(); }

// --- Structure-of-arrays batch entries ------------------------------------------

/// Module heap for host buffers.
SDNAP_EXPORT("sdnap_alloc")
void* sdnap_alloc(uint32_t bytes) { return std::malloc(bytes ? bytes : 1); }

SDNAP_EXPORT("sdnap_free")
void sdnap_free(void* pointer) { std::free(pointer); }

/// Theory OrbProOMMRecords are read under by plugin_init_omm (default SGP4XP).
SDNAP_EXPORT("sdnap_set_omm_theory")
int32_t sdnap_set_omm_theory(int32_t theory) {
  if (theory != sdnap::kTheorySgp4 && theory != sdnap::kTheorySgp4Xp) return ORBPRO_PROP_BAD_INPUT;
  sdnap::omm_theory() = theory;
  return ORBPRO_PROP_OK;
}

/// Replaces the element set with `count` ElementRow records (112 bytes each).
/// Returns the count held (refused sets are held and report an error).
SDNAP_EXPORT("sdnap_init_elements")
int32_t sdnap_init_elements(const sdnap::ElementRow* rows, uint32_t count) {
  if (rows == nullptr && count > 0) return ORBPRO_PROP_BAD_INPUT;
  const int32_t held = sdnap::store_init(rows, count);
  return held < 0 ? ORBPRO_PROP_BAD_INPUT : held;
}

/// Objects [first, first + count) at one split Julian date (UTC). `out` holds
/// six planes of `count` doubles: x, y, z, vx, vy, vz; frame 0 (TEME: km,
/// km/s) or 3 (Earth-fixed: m, m/s). `status` (optional) gets one code per
/// object (0 ok).
SDNAP_EXPORT("sdnap_propagate_soa")
int32_t sdnap_propagate_soa(double jd_whole, double jd_frac, uint32_t first, uint32_t count, uint32_t frame,
                            double* out, int32_t* status) {
  return sdnap::batch(sdnap::pool::kJobJd, jd_whole, jd_frac, nullptr, first, count, frame, out, status);
}

/// Objects [first, first + count), each at its own minutes from its epoch;
/// TEME km and km/s, six planes as sdnap_propagate_soa.
SDNAP_EXPORT("sdnap_propagate_minutes_soa")
int32_t sdnap_propagate_minutes_soa(const double* minutes, uint32_t first, uint32_t count, double* out,
                                    int32_t* status) {
  return sdnap::batch(sdnap::pool::kJobMinutes, 0.0, 0.0, minutes, first, count, ORBPRO_FRAME_TEME, out, status);
}

/// Starts up to `threads` pool threads (once; more calls add up to the
/// limit). Returns the number running.
SDNAP_EXPORT("sdnap_threads")
int32_t sdnap_threads(int32_t threads) { return sdnap::pool::start(threads); }

/// Bytes the element store holds (records and checkpoints).
SDNAP_EXPORT("sdnap_store_bytes")
double sdnap_store_bytes(void) { return static_cast<double>(sdnap::store_bytes()); }

/// Bytes of one propagation record: theory 0 SGP4, 4 SGP4XP.
SDNAP_EXPORT("sdnap_record_bytes")
uint32_t sdnap_record_bytes(int32_t theory) {
  return static_cast<uint32_t>(theory == sdnap::kTheorySgp4Xp ? sizeof(sdnap::xpt::XpSat) : sizeof(sdnap::Sat));
}

/// SGP4XP diagnostics: the mean equinoctial state of row `index` at `minutes`
/// from epoch and its rates (SPEC 1.5 units: af, ag, chi, psi per minute; lambda
/// degrees and degrees/day; n rev/day and rev/day^2), 12 doubles.
SDNAP_EXPORT("sdnap_xp_native")
int32_t sdnap_xp_native(uint32_t index, double minutes, double* out) {
  sdnap::Store& st = sdnap::store();
  if (index >= st.count || st.kind[index] != 1 || out == nullptr) return ORBPRO_PROP_BAD_INPUT;
  sdnap::xpt::XpSat& s = st.xps[st.slot[index]];
  if (s.init_error != 0) return ORBPRO_PROP_UNPHYSICAL;
  double y[6], f[6];
  if (!sdnap::xpt::mean_at(s, minutes, y)) return ORBPRO_PROP_UNPHYSICAL;
  if (!sdnap::xpt::report_rates(s, minutes, y, f)) return ORBPRO_PROP_UNPHYSICAL;
  const double deg = 180.0 / sdnap::kPi, revday = 1440.0 / sdnap::kTwoPi;
  for (int k = 0; k < 4; ++k) { out[k] = y[k]; out[6 + k] = f[k]; }
  out[4] = std::fmod(y[4] * deg, 360.0); if (out[4] < 0) out[4] += 360.0;
  out[10] = f[4] * deg * 1440.0;
  out[5] = y[5] * revday;
  out[11] = f[5] * revday * 1440.0;
  return ORBPRO_PROP_OK;
}

/// SGP4XP diagnostics: the rates of row `index`'s rate function at `minutes` evaluated at given native equinoctial
/// elements (SPEC 1.5 units, 6 doubles: af, ag, chi, psi, lambda deg, n rev/day; a side-A vector's own elements, so
/// a decision such as the shadow's is compared apart from the integration); 6 rates in the units of sdnap_xp_native.
SDNAP_EXPORT("sdnap_xp_rates_at")
int32_t sdnap_xp_rates_at(uint32_t index, double minutes, const double* native, double* out) {
  sdnap::Store& st = sdnap::store();
  if (index >= st.count || st.kind[index] != 1 || out == nullptr || native == nullptr) return ORBPRO_PROP_BAD_INPUT;
  sdnap::xpt::XpSat& s = st.xps[st.slot[index]];
  if (s.init_error != 0) return ORBPRO_PROP_UNPHYSICAL;
  const double deg = 180.0 / sdnap::kPi, revday = 1440.0 / sdnap::kTwoPi;
  const double y[6] = {native[0], native[1], native[2], native[3], native[4] / deg, native[5] / revday};
  double f[6];
  if (!sdnap::xpt::report_rates(s, minutes, y, f)) return ORBPRO_PROP_UNPHYSICAL;
  for (int k = 0; k < 4; ++k) out[k] = f[k];
  out[4] = f[4] * deg * 1440.0;
  out[5] = f[5] * revday * 1440.0;
  return ORBPRO_PROP_OK;
}

/// SPEC 4 diagnostics at given native elements (as sdnap_xp_rates_at): the shadow test's smallest |S| over the
/// candidates with n < 0, negative when the sunlit arc was found; nu_out[0] the true anomaly of that candidate,
/// nu_out[1] the second smallest |S|.
SDNAP_EXPORT("sdnap_xp_shadow_at")
double sdnap_xp_shadow_at(uint32_t index, double minutes, const double* native, double* nu_out) {
  sdnap::Store& st = sdnap::store();
  if (index >= st.count || st.kind[index] != 1 || native == nullptr) return __builtin_nan("");
  sdnap::xpt::XpSat& s = st.xps[st.slot[index]];
  const double deg = 180.0 / sdnap::kPi, revday = 1440.0 / sdnap::kTwoPi;
  const double y[6] = {native[0], native[1], native[2], native[3], native[4] / deg, native[5] / revday};
  using namespace sdnap::xpt;
  const Frame fr = frame_of(y);
  const Kepler k = kepler_of(y, fr.a);
  const Bodies b = bodies_at(s.ctx.d50_epoch + minutes / sdnap::kMinutesPerDay);
  double E1, E2;
  const bool arc = xp_shadow(k, b.sun_u, E1, E2);
  if (nu_out) { nu_out[0] = shadow_margin_nu(); nu_out[1] = shadow_margin2(); }
  const double m = shadow_margin_slot();
  return arc ? -m : m;
}

/// CPU diagnostic: `reps` evaluations of the rate function of object `index` at
/// its mean state at `minutes` (the caller times the call); returns the sum of
/// the n-dot rates (keeps the work observable), NaN on a bad index.
SDNAP_EXPORT("sdnap_rates_repeat")
double sdnap_rates_repeat(uint32_t index, double minutes, int32_t reps) {
  sdnap::Store& st = sdnap::store();
  if (index >= st.count || st.kind[index] != 1) return __builtin_nan("");
  sdnap::xpt::XpSat& s = st.xps[st.slot[index]];
  double y[6], f[6], sum = 0.0;
  if (s.init_error != 0 || !sdnap::xpt::mean_at(s, minutes, y)) return __builtin_nan("");
  for (int32_t r = 0; r < reps; ++r) {
    y[0] += 1e-18;  // a distinct input each time
    if (!sdnap::xpt::rates(s.ctx, minutes, y, f)) return __builtin_nan("");
    sum += f[0];
  }
  return sum;
}

/// SGP4XP drag diagnostics: log10 rho (g/cm^3) of the regenerated J70 table at
/// (tinf K, h km), bilinear as SPEC 3.3.
SDNAP_EXPORT("sdnap_j70_log_density")
double sdnap_j70_log_density(double tinf, double h) { return sdnap::drag::log_density(tinf, h); }

/// The ingest error of an object (0: accepted).
SDNAP_EXPORT("sdnap_init_error")
int32_t sdnap_init_error(uint32_t index) {
  const sdnap::Store& st = sdnap::store();
  return index < st.count ? sdnap::row_init_error(index) : -1;
}

/// fit (DESIGN 2e): `count` TEME positions (km, 3 per sample) at `minutes`
/// from the epoch of `row` (an ElementRow: epoch, theory, starting elements and
/// fixed terms), fitted in place. `options` (fit::Options, 56 bytes): int32
/// fit_drag, int32 max iterations (0: 30), double drag prior mean and sigma,
/// int32 fit_agom (4 bytes of padding follow), double AGOM prior mean and
/// sigma, int32 drag_log, int32 agom_log (1: the term is estimated as its
/// natural log, its prior mean and sigma those of the log; the row's term must
/// then start > 0). `stats` (4 doubles): status, iterations, rms km, max km.
/// Returns 0 or a negative code.
SDNAP_EXPORT("sdnap_fit")
int32_t sdnap_fit(sdnap::ElementRow* row, const double* minutes, const double* positions, uint32_t count,
                  const sdnap::fit::Options* options, double* stats) {
  if (row == nullptr || minutes == nullptr || positions == nullptr || options == nullptr || count < 3)
    return ORBPRO_PROP_BAD_INPUT;
  if (row->theory != sdnap::kTheorySgp4Xp) return ORBPRO_PROP_BAD_INPUT;
  sdnap::drag::table();
  const sdnap::fit::Result r = sdnap::fit::run(*row, minutes, positions, static_cast<int>(count), *options);
  if (stats != nullptr) {
    stats[0] = r.status;
    stats[1] = r.iterations;
    stats[2] = r.rms_km;
    stats[3] = r.max_km;
  }
  return r.status < 0 ? ORBPRO_PROP_UNPHYSICAL : ORBPRO_PROP_OK;
}

/// Cost probe: `count` rate evaluations of row `index` at its epoch state and
/// time `minutes` (the experiment of DESIGN 2.0's per-evaluation figures).
SDNAP_EXPORT("sdnap_rate_probe")
double sdnap_rate_probe(uint32_t index, uint32_t count, double minutes) {
  sdnap::Store& st = sdnap::store();
  if (index >= st.count || st.kind[index] != 1) return -1.0;
  sdnap::xpt::XpSat& s = st.xps[st.slot[index]];
  double f[6], sum = 0.0;
  for (uint32_t k = 0; k < count; ++k) {
    sdnap::xpt::rates(s.ctx, minutes, s.epoch.y, f);
    sum += f[5];
  }
  return sum;
}

/// SPEC 6 diagnostics: Kaula's G_lpq(e). mode 0 the Hansen coefficient itself
/// (numerical integral), 1 the Maclaurin polynomial of SPEC 6.4, 2 its
/// derivative dG/de; NaN when no class uses the polynomial.
SDNAP_EXPORT("sdnap_hansen_g")
double sdnap_hansen_g(int32_t l, int32_t p, int32_t q, double e, int32_t mode) {
  using namespace sdnap::xpt::res;
  if (mode == 0) return hansen_G(l, p, q, e);
  const HansenSeries* h = hansen_series(l, p, q);
  if (h == nullptr) return __builtin_nan("");
  double G, dG;
  series_G(*h, e, G, dG);
  return mode == 1 ? G : dG;
}

/// Frame diagnostics on a state (km, km/s; 6 doubles in, 6 out) at the UTC
/// Julian date whole + frac. mode 0 GCRF -> TEME, 1 TEME -> GCRF (the fit's
/// GCRF rotation, gcrf.inc), 2 TEME -> Earth-fixed, 3 Earth-fixed -> TEME
/// (GMST82, UT1 = UTC, the fit's Earth-fixed rotation). Returns ERFA's status
/// for modes 0 and 1 (0 ok, 1 dubious date, -1 refused), else 0.
SDNAP_EXPORT("sdnap_frame_probe")
int32_t sdnap_frame_probe(double whole, double frac, const double* in, double* out, int32_t mode) {
  using namespace sdnap;
  if (mode == 0 || mode == 1) {
    double m[3][3];
    const int st = frames::gcrf_to_teme(whole, frac, m);
    if (st < 0) return st;
    if (mode == 0) {
      frames::apply(m, in, out);
      frames::apply(m, in + 3, out + 3);
    } else {
      frames::apply_transpose(m, in, out);
      frames::apply_transpose(m, in + 3, out + 3);
    }
    return st;
  }
  const double th = gmst(whole, frac);
  const double c = std::cos(th), sn = std::sin(th);
  if (mode == 2) {
    out[0] = c * in[0] + sn * in[1];
    out[1] = -sn * in[0] + c * in[1];
    out[2] = in[2];
    const double vx = c * in[3] + sn * in[4], vy = -sn * in[3] + c * in[4];
    out[3] = vx + kEarthRotationRate * out[1];
    out[4] = vy - kEarthRotationRate * out[0];
    out[5] = in[5];
    return 0;
  }
  earth_fixed_to_teme(th, in, in + 3, out, out + 3);
  return 0;
}

/// SPEC 4 diagnostics: at the mean elements of row `index` at `minutes`, the
/// shadow test's margin: the smallest |S(nu)| over the boundary candidates with
/// n(nu) < 0 (the test is |S| < 1e-12), negative when the sunlit arc was found;
/// 1e300 when no candidate exists.
SDNAP_EXPORT("sdnap_shadow_margin")
double sdnap_shadow_margin(uint32_t index, double minutes) {
  using namespace sdnap;
  using namespace sdnap::xpt;
  Store& st = store();
  if (index >= st.count || st.kind[index] != 1) return __builtin_nan("");
  XpSat& s = st.xps[st.slot[index]];
  double y[6];
  if (s.init_error != 0 || !mean_at(s, minutes, y)) return __builtin_nan("");
  const Frame fr = frame_of(y);
  const Kepler k = kepler_of(y, fr.a);
  const Perifocal pf = perifocal_of(angle_trig(k));
  const Bodies b = bodies_at(s.ctx.d50_epoch + minutes / kMinutesPerDay);
  (void)pf;
  double E1, E2;
  const bool arc = xp_shadow(k, b.sun_u, E1, E2);
  const double m = shadow_margin_slot();
  return arc ? -m : m;
}

/// Conformance diagnostics (test/conformance.e2e.mjs; defaults change nothing):
/// policy 0 SPEC 4's |S| < 1e-12, 1 every near-limit candidate (|S| < 1e-10) a
/// boundary, 2 none (|S| < 1e-14), 3 no boundary at all (wholly sunlit).
SDNAP_EXPORT("sdnap_shadow_policy")
void sdnap_shadow_policy(int32_t policy) {
  // 1 / 2: every rounding-limited decision a sunlit arc / wholly sunlit (SPEC 4, amendment 6); 3: no boundary at all
  sdnap::xpt::shadow_envelope() = policy == 1 || policy == 2 ? policy : 0;
  sdnap::xpt::shadow_threshold() = policy == 3 ? 0.0 : 1e-12;
}

/// Flip the seasonal term's hemisphere at the equator node (|phi| < 1e-14): 1 on, 0 off.
SDNAP_EXPORT("sdnap_hemisphere_flip")
void sdnap_hemisphere_flip(int32_t on) { sdnap::drag::diagnostics().hemisphere_flip = on ? 1 : 0; }

/// Density-table cells the lookups use: mode 1 start recording (cleared), 0 stop;
/// out (29 x 111 bytes, [temperature column][height node]) receives the marks.
SDNAP_EXPORT("sdnap_table_cells")
void sdnap_table_cells(int32_t mode, uint8_t* out) {
  sdnap::drag::Diagnostics& d = sdnap::drag::diagnostics();
  if (mode == 1) std::memset(d.cells, 0, sizeof d.cells);
  d.record_cells = mode == 1 ? 1 : 0;
  if (out != nullptr) std::memcpy(out, d.cells, sizeof d.cells);
}
