// -----------------------------------------------------------------------------
// Exports: the OrbPro propagator ABI (Earth-fixed meters) and the module's
// structure-of-arrays batch entries (sdnap_*).
// -----------------------------------------------------------------------------

#define SDNAP_EXPORT(name) __attribute__((export_name(name))) extern "C"

namespace sdnap {

/// Theory an OrbProOMMRecord is read under: the struct path (plugin_init_omm, plugin_init) flies stock SGP4-XP only
/// (Jacchia 1970 on the theory's flux model, no gravity terms); the record carries no theory and no forces, so an SGP4
/// or AP set never enters here (OrbPro's host refuses to pack one). BTERM is in `bstar` and AGOM in
/// `mean_motion_ddot` (m^2/kg), the convention of modules propagator/sgp4-xp.
constexpr int32_t omm_theory() { return kTheorySgp4Xp; }

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
/// One object of the batch: its state and status into the output planes.
inline void run_row(const Job& j, uint32_t i) {
  const uint32_t n = j.count;
  double* x = j.out;
  double* y = x + n;
  double* z = y + n;
  double* vx = z + n;
  double* vy = vx + n;
  double* vz = vy + n;
  const xpt::Bodies* shared = j.kind == kJobJd ? &j.bodies : nullptr;
  const uint32_t row = j.first + i;
  const double t = j.kind == kJobMinutes ? j.minutes[i] : minutes_since_epoch(row, j.jd_whole, j.jd_frac);
  double r[3] = {0, 0, 0}, v[3] = {0, 0, 0};
  const int32_t e = row_propagate(row, t, r, v, shared);
  if (j.status != nullptr) j.status[i] = e;
  // SPEC 16.25 (stack #564): an AP row past its decay crossing has status 4 and no state: its planes are not numbers
  if (e == kPropDecayed) {
    const Store& st = store();
    if (row < st.count && st.kind[row] == 1 && xpt::is_ap_ctx(st.xps[st.slot[row]].ctx))
      for (int q = 0; q < 3; ++q) r[q] = v[q] = __builtin_nan("");
  }
  if (e == kPropOk && j.kind == kJobJd && j.frame == ORBPRO_FRAME_ECEF) {
    double ro[3], vo[3];
    teme_to_ecef_m(j.theta, r, v, ro, vo);
    x[i] = ro[0]; y[i] = ro[1]; z[i] = ro[2];
    vx[i] = vo[0]; vy[i] = vo[1]; vz[i] = vo[2];
  } else {
    x[i] = r[0]; y[i] = r[1]; z[i] = r[2];
    vx[i] = v[0]; vy[i] = v[1]; vz[i] = v[2];
  }
}

void run_chunk(const Job& j, int32_t chunk) {
  const uint32_t size = chunk_size(j);
  const uint32_t begin = static_cast<uint32_t>(chunk) * size;
  const uint32_t end = begin + size < j.count ? begin + size : j.count;
  for (uint32_t i = begin; i < end; ++i) {
    xpt::g_alloc_refused = 0;
    if (j.kind == kJobEpochs) {
      if (j.serial_series[j.slice + i]) continue;
      run_epoch_row(j, i);
    } else {
      run_row(j, i);
    }
    if (g_row_hook != nullptr) g_row_hook(i, g_pool_thread);
    pool::beat();  // the heartbeat the waiting calling thread reads (stack #487)
    // a row during which the memory's growth was refused may have been stopped short of a block it needed: the calling
    // thread computes it again after the batch (the same state: a function of the set and the time alone, SPEC 9)
    if (xpt::g_alloc_refused != 0 && j.deferred != nullptr) {
      const int32_t k = __atomic_fetch_add(&job().deferred_n, 1, __ATOMIC_SEQ_CST);
      j.deferred[k] = i;
    }
  }
  xpt::g_alloc_refused = 0;
}
}  // namespace pool

/// The bytes a threaded batch of rows [first, first + count) makes free before it starts (stack #487): for each AP row
/// whose set holds no caches, 128 KiB, its first flight's largest take (its SetCaches, 11.2 KB; its tesseral copy,
/// 61 KB at 500 km with degree 31; its first node runs, 2.5 KB a direction; measured with sdnap_debug_pool on the
/// 500 km set, the largest of the catalog mix's low orbits), at most what the pool may still take (its admission caps
/// every set's caches at the budget), plus 8 MiB for the rest.
inline size_t batch_reserve(uint32_t first, uint32_t count) {
  const Store& st = store();
  size_t cold = 0;
  for (uint32_t i = first; i < first + count; ++i) {
    if (st.kind[i] != 1) continue;
    const xpt::XpSat& s = st.xps[st.slot[i]];
    if (s.pooled && s.caches == nullptr && s.init_error == 0) ++cold;
  }
  const uint64_t room = xpt::pool_room(cold);
  if (pool::g_reserve_off) return 0;
  const uint64_t sets = static_cast<uint64_t>(cold) * (128u << 10);
  return static_cast<size_t>(std::min<uint64_t>(sets, room + (1u << 20)) + (8u << 20));
}

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
  // a threaded batch (stack #487): room made before it on this thread, for its sets' caches and for the rows deferred
  const bool threaded = j.threads > 0 && count > pool::kChunk && pool::load(&j.dead) == 0;
  static std::vector<uint32_t> deferred;
  size_t reserve = 0;
  if (threaded) {
    if (deferred.size() < count) deferred.resize(count);
    reserve = batch_reserve(first, count);
  }
  j.deferred = threaded ? deferred.data() : nullptr;
  const int32_t rc = pool::run(count, reserve);
  if (rc != 0) {
    if (status != nullptr)
      for (uint32_t i = 0; i < count; ++i) status[i] = pool::kRowPoolDead;
    return rc;
  }
  // the rows a refused growth stopped, on this thread, the memory free to grow again: in row order, the same states
  const int32_t n_deferred = pool::load(&j.deferred_n);
  if (n_deferred > 0) {
    std::sort(deferred.begin(), deferred.begin() + n_deferred);
    for (int32_t k = 0; k < n_deferred; ++k) pool::run_row(j, deferred[static_cast<size_t>(k)]);
    xpt::batch_stats().deferred += static_cast<uint64_t>(n_deferred);
  }
  return ORBPRO_PROP_OK;
}

}  // namespace sdnap

// --- OrbPro propagator ABI ----------------------------------------------------

SDNAP_EXPORT("plugin_init_omm")
int32_t plugin_init_omm(const OrbProOMMRecord* records, uint32_t count) {
  if (records == nullptr && count > 0) return ORBPRO_PROP_BAD_INPUT;
  sdnap::ElementRow* rows = static_cast<sdnap::ElementRow*>(sdnap::mem::malloc(sizeof(sdnap::ElementRow) * (count ? count : 1)));
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
void* sdnap_alloc(uint32_t bytes) { return sdnap::mem::malloc(bytes ? bytes : 1); }

SDNAP_EXPORT("sdnap_free")
void sdnap_free(void* pointer) { std::free(pointer); }

/// Replaces the element set with `count` ElementRow records (112 bytes each).
/// Returns the count held (refused sets are held and report an error).
SDNAP_EXPORT("sdnap_init_elements")
int32_t sdnap_init_elements(const sdnap::ElementRow* rows, uint32_t count) {
  if (rows == nullptr && count > 0) return ORBPRO_PROP_BAD_INPUT;
  // SPEC 16.13: an SGP4XP row stating SGP4's first derivative of the mean motion is held refused (elements-other-theory):
  // inside the module that slot carries an AP set's radiation term, which enters only from a record
  uint8_t* refused = nullptr;
  for (uint32_t i = 0; i < count; ++i) {
    if (!sdnap::row_states_sgp4_ndot(rows[i])) continue;
    if (refused == nullptr) {
      refused = static_cast<uint8_t*>(sdnap::mem::calloc(count, 1));
      if (refused == nullptr) return ORBPRO_PROP_BAD_INPUT;
      plugin_set_error("elements-other-theory",
                       "An SGP4XP row carries MEAN_MOTION_DOT (SGP4's term, ElementRow.mean_motion_dot not 0): the row is held refused.");
    }
    refused[i] = 1;
  }
  const int32_t held = sdnap::store_init(rows, count, refused);
  std::free(refused);
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

/// The pool and the memory, read only (SPEC 9 and 1.6): the first min(count, 16) of 16 doubles, written to `out`, which
/// has room for `count` (nothing past it is written):
///  [0] the threads running;  [1] the threaded batches run;  [2] the growths of the memory refused inside them (every
///  thread);  [3] the rows deferred to the calling thread after them;  [4] the batches after which the calling thread saw
///  a larger memory (the invariant: 0);  [5] whether the pool was taken for dead (1; its later batches run on the calling
///  thread);  [6] the polls without a completed row a waiting caller allows a batch;  [7] the last batch's reserve
///  (bytes);  [8] the waits for a thread's view of the memory that had to yield;  [9] the most yields one took;
///  [10] the memory's growths since the instance started (sbrk's memory.grow calls, each of at least a step but at the
///  memory's maximum);  [11] the 64 KiB pages they added;  [12] the epoch store's slices halved for want of their
///  reserve;  [13] its slices run on the calling thread because even the smallest slice's reserve could not be had;
///  [14] the batches' rows completed on pool threads since the instance started;  [15] the pool threads that completed
///  at least one of them.
SDNAP_EXPORT("sdnap_pool_stats")
void sdnap_pool_stats(double* out, int32_t count) {
  if (out == nullptr || count <= 0) return;
  const sdnap::xpt::BatchStats& s = sdnap::xpt::batch_stats();
  uint64_t pool_rows = 0;
  int32_t pool_threads_with_rows = 0;
  for (int32_t t = 1; t <= sdnap::pool::kMaxThreads; ++t) {
    const uint64_t rows = __atomic_load_n(&sdnap::pool::g_row_beats[t].rows, __ATOMIC_RELAXED);
    pool_rows += rows;
    if (rows != 0) ++pool_threads_with_rows;
  }
  const double v[16] = {static_cast<double>(sdnap::pool::job().threads), static_cast<double>(s.batches), static_cast<double>(s.refused),
                        static_cast<double>(s.deferred), static_cast<double>(s.grew), static_cast<double>(s.dead),
                        static_cast<double>(sdnap::pool::dead_polls()), static_cast<double>(s.reserve),
                        static_cast<double>(s.views), static_cast<double>(s.view_yields_max),
                        static_cast<double>(__atomic_load_n(&sdnap::pool::g_memory_growths, __ATOMIC_RELAXED)),
                        static_cast<double>(__atomic_load_n(&sdnap::pool::g_memory_grown_pages, __ATOMIC_RELAXED)),
                        static_cast<double>(__atomic_load_n(&s.reserves_halved, __ATOMIC_RELAXED)),
                        static_cast<double>(__atomic_load_n(&s.slices_serial, __ATOMIC_RELAXED)),
                        static_cast<double>(pool_rows), static_cast<double>(pool_threads_with_rows)};
  const int32_t n = count < 16 ? count : 16;
  for (int32_t k = 0; k < n; ++k) out[k] = v[k];
}

/// The sets' caches (SPEC 9), read only (the budget is the module's default, 256 MB; xpt::cache_budget_mb sets it in
/// test builds, no typed configuration carries it yet), 8 doubles: the budget and the bytes held, the sets holding caches and of them those
/// holding tesseral caches, the caches reclaimed (least recently flown first), the caches and tesseral caches refused
/// (no room after reclaiming), and the tesseral caches made.
SDNAP_EXPORT("sdnap_cache_stats")
void sdnap_cache_stats(double* out) {
  if (out == nullptr) return;
  sdnap::xpt::CachePool& p = sdnap::xpt::cache_pool();
  sdnap::xpt::lock(&p.lock);
  const double v[8] = {static_cast<double>(p.budget), static_cast<double>(p.held), static_cast<double>(p.holders.size()),
                       static_cast<double>(p.sp_holders), static_cast<double>(p.reclaimed), static_cast<double>(p.refused),
                       static_cast<double>(p.sp_refused), static_cast<double>(p.sp_made)};
  sdnap::xpt::unlock(&p.lock);
  for (int k = 0; k < 8; ++k) out[k] = v[k];
}

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

/// SPEC 16.15 diagnostics: AP's radiation-pressure rates on given mean elements with a given Sun. in: 11 doubles, the
/// native elements (as sdnap_xp_rates_at: af, ag, chi, psi, lambda deg, n rev/day), the Sun's direction cosines on the
/// perigee frame P, Q, W (normalized here), the Sun's distance (AU) and AGOM (m^2/kg). mode 0: the theory's averaged
/// rates (srp_rates on AP's shadow); mode 1: the same sphere in the same cylinder averaged numerically over one
/// revolution of the mean orbit, the Sun held fixed (srp_average_numeric, nq steps); mode 2: the same with a conical
/// shadow (umbra and penumbra). out: the six rates in the state order, per minute (lambda's without n). Returns 1 when
/// AP's shadow takes a sunlit arc, 0 wholly sunlit, -1 bad input.
SDNAP_EXPORT("sdnap_ap_srp_rates")
int32_t sdnap_ap_srp_rates(const double* in, int32_t mode, int32_t nq, double* out) {
  using namespace sdnap::xpt;
  if (in == nullptr || out == nullptr || mode < 0 || mode > 2) return -1;
  const double deg = 180.0 / sdnap::kPi, revday = 1440.0 / sdnap::kTwoPi;
  const double y[6] = {in[0], in[1], in[2], in[3], in[4] / deg, in[5] / revday};
  const Frame fr = frame_of(y);
  const Kepler k = kepler_of(y, fr.a);
  if (!(k.e < 1.0) || !(in[9] > 0.0)) return -1;
  const AngleTrig ag = angle_trig(k);
  const Perifocal pf = perifocal_of(ag);
  Vec3 s = (in[6] * pf.P + in[7] * pf.Q) + in[8] * pf.W;
  const double sn = norm(s);
  if (!(sn > 0.0)) return -1;
  s = (1.0 / sn) * s;
  Bodies b{};
  b.sun_u = s;
  b.sun_r = in[9] * kAu / kRe;
  b.moon_u = s;
  b.moon_r = b.sun_r;
  const double agom = in[10];
  double A, B, C, E1 = 0.0, E2 = 0.0, sE1, cE1, sE2, cE2;
  direction_cosines(pf, s, A, B, C);
  const bool arc = ap_sunlit_arc(A, B, k.e, fr.eta, (1.0 - fr.e2) * k.a, E1, E2, sE1, cE1, sE2, cE2);
  for (int m = 0; m < 6; ++m) out[m] = 0.0;
  if (mode == 0) {
    srp_rates(y, fr, k, pf, agom, b, out, &ag, true, nullptr, true);
    return arc ? 1 : 0;
  }
  srp_average_numeric(y, fr, k, s, b.sun_r, agom, mode, nq, A, B, out);
  return arc ? 1 : 0;
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
/// int32 fit_agom, int8 fit_bdot, int8 fit_thrust, int8 fit_outgassing (refused
/// parameter-not-modeled:<NAME>, SPEC 17.2; 1 byte of padding follows), double AGOM prior mean and
/// sigma, int32 drag_log, int32 agom_log (1: the term is estimated as its
/// natural log, its prior mean and sigma those of the log; the row's term must
/// then start > 0). `stats` (4 doubles): status (-5: the least-squares set lies on a limit in n, SPEC 16.7; at an
/// eccentricity switch the set is held there, status 0 or 1; 2: a pass stopped because a column of its Jacobian could not be
/// differenced in either direction, both sets decaying inside the arc, SPEC 16.25; -1: one of the module's allocations failed
/// during the call, the error out-of-memory and `row` left as it came, SPEC 1.6), iterations, rms km, max km.
/// Returns 0 or a negative code.
SDNAP_EXPORT("sdnap_fit")
int32_t sdnap_fit(sdnap::ElementRow* row, const double* minutes, const double* positions, uint32_t count,
                  const sdnap::fit::Options* options, double* stats) {
  if (row == nullptr || minutes == nullptr || positions == nullptr || options == nullptr || count < 3)
    return ORBPRO_PROP_BAD_INPUT;
  if (row->theory != sdnap::kTheorySgp4Xp) return ORBPRO_PROP_BAD_INPUT;
  if (sdnap::row_states_sgp4_ndot(*row)) {  // SPEC 16.13, as sdnap_init_elements
    plugin_set_error("elements-other-theory", "An SGP4XP row carries MEAN_MOTION_DOT (SGP4's term, ElementRow.mean_motion_dot not 0).");
    return ORBPRO_PROP_BAD_INPUT;
  }
  if (options->fit_y0 != 0) {  // SPEC 16.13: Y0 is fitted by the fit method under FORCES.ECOM2 and lives in the record
    plugin_set_error("parameter-record-only:ECOM2_Y0",
                     "ECOM2_Y0 is fitted by the fit method under $PCF FORCES.ECOM2 and carried in its $OCM; an ElementRow does not carry it.");
    return ORBPRO_PROP_BAD_INPUT;
  }
  // SPEC 1.6 (stack #497): an allocation that failed during the fit is named, never a status 0, 1 or 2 and never a fitted row
  const sdnap::mem::CallMark call_mark;
  const sdnap::ElementRow given = *row;
  sdnap::drag::table();
  sdnap::fit::Result r = sdnap::fit::run(*row, minutes, positions, static_cast<int>(count), *options);
  if (sdnap::mem::refuse_if_out_of_memory()) {
    *row = given;
    r.status = -1;
  }
  if (stats != nullptr) {
    stats[0] = r.status;
    stats[1] = r.iterations;
    stats[2] = r.rms_km;
    stats[3] = r.max_km;
  }
  return r.status < 0 ? ORBPRO_PROP_UNPHYSICAL : ORBPRO_PROP_OK;
}

/// SPEC 16.21 (stack #550): the osculating Kepler solves since the last reset (every caller's: output states, covariance sigma
/// points, fit evaluations, the long-period regime's output Jacobian) whose Newton ended its 30 steps without meeting its
/// tolerance. `which` 0: AP's (output_impl) whose last step was 1e-12 or more, solved by the bisection; 1: section 8's
/// (output_j2_osc) whose last step was 1e-12 or more, solved by the bisection; 2: AP's whose last step was under 1e-12 (within rounding of
/// the root), solved. `reset` non-zero reads the count and sets it to 0 in one step. A diagnostic.
SDNAP_EXPORT("sdnap_kepler_unconverged")
uint32_t sdnap_kepler_unconverged(int32_t reset, int32_t which) {
  uint32_t* c = &sdnap::xpt::g_kepler_unconverged[which == 1 ? 1 : which == 2 ? 2 : 0];
  return reset != 0 ? __atomic_exchange_n(c, 0u, __ATOMIC_RELAXED) : __atomic_load_n(c, __ATOMIC_RELAXED);
}

/// SPEC 12.1: the fit passes since the last reset that ended at their iteration ceiling with the cost still falling.
/// `which` 0: under fit::kPassCeiling (a fit that solves no drag term); 1: under any other ceiling (fit::kDragPassCeiling,
/// or an sdnap_fit caller's own). `reset` non-zero reads the count and sets it to 0 in one step. A diagnostic.
SDNAP_EXPORT("sdnap_fit_ceiling_met")
uint32_t sdnap_fit_ceiling_met(int32_t reset, int32_t which) {
  uint32_t* c = &sdnap::fit::g_ceiling_met[which == 1 ? 1 : 0];
  return reset != 0 ? __atomic_exchange_n(c, 0u, __ATOMIC_RELAXED) : __atomic_load_n(c, __ATOMIC_RELAXED);
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

/// Where a set carries each slow tesseral term (SPEC 16.18; stack #467): in = mean motion (rev/day), e, i (deg), the
/// tesseral cap; rows of 8 doubles (l, m, p, q, psi-dot / n, carrier: 1 the rates, 2 the grid, 3 the output table, 0 nowhere:
/// under the floor or the slow cut, 4 nowhere: above the carrier's degree, 5 nowhere: under the size cut, 6 nowhere: a q
/// outside the rule's q range at or above the size cut, 7 nowhere: a term the low table's rules select that its list's
/// capacity could not hold; then the rates' weight w and the term's size in m), at most
/// max_rows. Returns the count of all rows, or -1 for a set it does not cover. It covers the sets above their switch outside
/// low orbit (codes 1, 2, 0 and 4) and the low table (class 0, a period under 1,100 min, at or below its eccentricity switch:
/// codes 1, 3, 0, 4, 5 and 6; 0 nowhere under the table's 1e-3 n floor, 4 also a family whose leading degree is 69 or 70).
/// A diagnostic: no flight reads it.
SDNAP_EXPORT("sdnap_slow_terms")
int32_t sdnap_slow_terms(const double* in, double* rows, int32_t max_rows) {
  using namespace sdnap::xpt;
  const double n = in[0] * sdnap::kTwoPi / sdnap::kMinutesPerDay, e = in[1], inc = in[2] * sdnap::kPi / 180.0;
  const int cap = static_cast<int>(in[3]);
  if (!(n > 0.0) || !(e >= 0.0 && e < 1.0) || cap < 2 || cap > 70) return -1;
  const int cls = res::band_of(n);
  if (cls == 0 && sdnap::kTwoPi / n < kLongPeriodMinutes && !tess::wide_set(cls, e)) return tess::slow_listing_low(cap, n, e, inc, rows, max_rows);
  return tess::slow_terms(cap, cls, n, e, inc, rows, max_rows);
}

/// The field's census (SPEC 16.20; stack #503): in = mean motion (rev/day), e, i (deg), the record's tesseral degree, the size
/// cut (m); every tesseral term of the embedded field at or above the cut, and radiation pressure's one row (l -1, m 0; SPEC
/// 16.22), with the carriers a set of these elements builds
/// (xpt::census_rows: rows of 10 doubles, l, m, p, q, psi-dot / n, the code, the rates' weight, all carriers' weight, the size
/// in m, the term's period in days), at most max_rows. Returns the count of all rows, or -1 for elements it refuses. A diagnostic: no flight reads it.
SDNAP_EXPORT("sdnap_field_census")
int32_t sdnap_field_census(const double* in, double* rows, int32_t max_rows) {
  using namespace sdnap::xpt;
  const double n = in[0] * sdnap::kTwoPi / sdnap::kMinutesPerDay, e = in[1], inc = in[2] * sdnap::kPi / 180.0;
  return field_census(static_cast<int>(in[3]), n, e, inc, in[4], rows, max_rows);
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

/// Sun and Moon diagnostics at the UTC Julian date whole + frac: mode 0 SGP4XP's (SPEC 5, bodies_at: mean equator and
/// equinox of date), 1 AP's series at that time (SPEC 16.17, ap_bodies_at: TEME of date), 2 what AP's flights read
/// (bodies_at_ap: the quintic through six nodes). out (8 doubles): the Sun's unit vector and distance (km), the Moon's
/// unit vector and distance (km). Returns 0, or -1 for a bad mode or a null output.
SDNAP_EXPORT("sdnap_bodies_probe")
int32_t sdnap_bodies_probe(double whole, double frac, int32_t mode, double* out) {
  using namespace sdnap::xpt;
  if (out == nullptr || mode < 0 || mode > 2) return -1;
  const double d50 = (whole - sdnap::kJd1950) + frac;
  const Bodies b = mode == 0 ? bodies_at(d50) : (mode == 1 ? ap_bodies_at(d50) : bodies_at_ap(d50));
  const double v[8] = {b.sun_u.x, b.sun_u.y, b.sun_u.z, b.sun_r * kRe, b.moon_u.x, b.moon_u.y, b.moon_u.z, b.moon_r * kRe};
  for (int k = 0; k < 8; ++k) out[k] = v[k];
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

/// SPEC 16.18, the low table (stack #477), tests only: the slow set's degree (2 to 70; anything else restores 70), so a model
/// truth cut lower is compared like with like. No $PCF field; the default changes nothing.
SDNAP_EXPORT("sdnap_slow_degree_cap")
void sdnap_slow_degree_cap(int32_t cap) { sdnap::xpt::tess::slow_degree_cap() = cap >= 2 && cap <= 70 ? cap : sdnap::xpt::tess::kSlowDegree; }

/// SPEC 16.18, the low table, tests only: the slow set's |q| range (0 as it lands; up to 4), while the q != 0 terms are open
/// (stack #477).
SDNAP_EXPORT("sdnap_slow_q_max")
void sdnap_slow_q_max(int32_t q) { sdnap::xpt::tess::slow_q_max() = q >= 0 && q <= sdnap::xpt::tess::kSlowQMax ? q : 0; }


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
