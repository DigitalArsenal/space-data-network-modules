// The plugin entity view of the resident record store. All calls share one owning thread.
namespace sdnap {

bool plugin_can_release() {
  return epochs::resident().pool_dead == 0 || pool::load(&pool::job().active) == 0;
}

void plugin_epochs_cleared() { frames::release_state(frames::state()); }
void plugin_records_selected() { store_free(); plugin_records = true; }
void plugin_rows_selected() {
  epochs::resident_build().drop();
  epochs::clear(epochs::resident());
  epochs::resident().pool_dead = 0;
  plugin_records = false;
}
void plugin_release() {
  if (!plugin_can_release()) return;
  plugin_rows_selected();
  store_free();
}
uint32_t plugin_record_count() { return static_cast<uint32_t>(epochs::resident().plugin_order.size()); }

inline void plugin_invalid(double jd, OrbProStateVector* out) {
  orbpro_state_init(out);
  out->epoch = jd;
  orbpro_state_set_reference_frame(out, ORBPRO_FRAME_ECEF);
  for (int a = 0; a < 3; ++a) out->position[a] = out->velocity[a] = __builtin_nan("");
}

inline int32_t plugin_direct_state(uint32_t raw, double whole, double frac, OrbProStateVector* out) {
  auto& st = epochs::resident();
  if (st.pool_dead != 0) return ORBPRO_PROP_UNPHYSICAL;
  double r[3], v[3], jd[2] = {whole, frac};
  bool have_cov = false;
  const int32_t code = epochs::at(st, st.series[raw], epochs::minutes_of(whole, frac), r, v, nullptr, have_cov, jd);
  if (code != kPropOk) return abi_status(code);
  teme_to_ecef_m(gmst(whole, frac), r, v, out->position, out->velocity);
  out->flags = ORBPRO_STATE_VALID;
  return 0;
}

struct PluginTime {
  double whole, frac, c, s;
  explicit PluginTime(double jd) {
    split_jd(jd, whole, frac);
    const double theta = gmst(whole, frac);
    c = std::cos(theta); s = std::sin(theta);
  }
};

inline int32_t plugin_record_read(const PluginTime& time, double jd, uint32_t index, OrbProStateVector* out, bool positions_only = false) {
  plugin_invalid(jd, out);
  auto& st = epochs::resident();
  if (st.pool_dead != 0) return ORBPRO_PROP_UNPHYSICAL;
  const uint32_t raw = st.plugin_order[index];
  if (st.series[raw].met != meanElementSource_AP) return plugin_direct_state(raw, time.whole, time.frac, out);
  const auto& fs = frames::state();
  if (!fs.open || raw >= fs.objects || (!positions_only && (fs.flags & frames::kFlagPositionOnly) != 0)) return -8;
  double r[3], v[3];
  const int32_t status = frames::read_cell(fs, raw, time.whole, time.frac, fs.generation != st.generation, r, v);
  if (status != frames::kServed)
    return status == frames::kApRefuses || status == frames::kBuilderFails ? ORBPRO_PROP_UNPHYSICAL : -8;
  frames::rotate_cell(time.c, time.s, positions_only, r, v);
  for (int a = 0; a < 3; ++a) { out->position[a] = r[a]; if (!positions_only) out->velocity[a] = v[a]; }
  out->flags = ORBPRO_STATE_VALID;
  return 0;
}

int32_t plugin_record_state(double jd, uint32_t index, OrbProStateVector* out) {
  if (out == nullptr) return ORBPRO_PROP_NULL_OUTPUT;
  if (plugin_record_count() == 0) return ORBPRO_PROP_NOT_INITIALIZED;
  if (index >= plugin_record_count()) return ORBPRO_PROP_BAD_ENTITY_INDEX;
  if (!std::isfinite(jd)) return ORBPRO_PROP_BAD_INPUT;
  return plugin_record_read(PluginTime(jd), jd, index, out);
}

int32_t plugin_record_batch(double jd, OrbProStateVector* out, uint32_t count) {
  if (out == nullptr) return ORBPRO_PROP_NULL_OUTPUT;
  if (plugin_record_count() == 0) return ORBPRO_PROP_NOT_INITIALIZED;
  if (count > plugin_record_count()) return ORBPRO_PROP_BAD_ENTITY_INDEX;
  if (!std::isfinite(jd)) return ORBPRO_PROP_BAD_INPUT;
  const PluginTime time(jd);
  for (uint32_t i = 0; i < count; ++i) plugin_record_read(time, jd, i, out + i);
  return 0;
}
}  // namespace sdnap

/// Interleaved Earth-fixed meters in entity order. Missing objects keep their three NaN slots.
SDNAP_EXPORT("plugin_propagate_all_positions")
int32_t plugin_propagate_all_positions(double jd, double* out, uint32_t max) {
  using namespace sdnap;
  const uint32_t n = std::min(max, plugin_records ? plugin_record_count() : store().count);
  if (n == 0) return 0;
  if (out == nullptr) return ORBPRO_PROP_NULL_OUTPUT;
  if (!std::isfinite(jd)) return ORBPRO_PROP_BAD_INPUT;
  const PluginTime time(jd);
  const xpt::Bodies shared = plugin_records ? xpt::Bodies{} : xpt::bodies_at((time.whole - kJd1950) + time.frac);
  const double theta = gmst(time.whole, time.frac);
  for (uint32_t i = 0; i < n; ++i) {
    OrbProStateVector state;
    const int32_t rc = plugin_records ? plugin_record_read(time, jd, i, &state, true) :
        write_state(i, time.whole, time.frac, &state, &shared, &theta);
    for (int a = 0; a < 3; ++a) out[3 * i + a] = rc == 0 ? state.position[a] : __builtin_nan("");
  }
  return static_cast<int32_t>(n);
}

/// Direct epoch states on the requested grid; zero and negative steps are accepted.
SDNAP_EXPORT("plugin_propagate_path")
int32_t plugin_propagate_path(uint32_t index, double start_jd, double step_days, uint32_t count, double* out) {
  using namespace sdnap;
  if (count == 0) return 0;
  if (out == nullptr) return ORBPRO_PROP_NULL_OUTPUT;
  const uint32_t n = plugin_records ? plugin_record_count() : store().count;
  if (n == 0) return ORBPRO_PROP_NOT_INITIALIZED;
  if (index >= n) return ORBPRO_PROP_BAD_ENTITY_INDEX;
  if (count > INT32_MAX || !std::isfinite(start_jd) || !std::isfinite(step_days) ||
      !std::isfinite(start_jd + (count - 1) * step_days)) return ORBPRO_PROP_BAD_INPUT;
  auto& st = epochs::resident();
  if (plugin_records && st.pool_dead != 0) return ORBPRO_PROP_UNPHYSICAL;
  const uint32_t raw = plugin_records ? st.plugin_order[index] : 0;
  for (uint32_t i = 0; i < count; ++i) {
    const double jd = start_jd + i * step_days;
    double whole, frac;
    split_jd(jd, whole, frac);
    OrbProStateVector state;
    plugin_invalid(jd, &state);
    const int32_t rc = plugin_records ? plugin_direct_state(raw, whole, frac, &state) : write_state(index, whole, frac, &state);
    for (int a = 0; a < 3; ++a) out[3 * i + a] = rc == 0 ? state.position[a] : __builtin_nan("");
  }
  // A focused path releases only its entity's direct caches, leaving all frame cells intact.
  if (plugin_records) {
    auto& series = st.series[raw];
    for (auto& slot : series.slots) epochs::release(slot);
    series.next = 0;
  }
  return static_cast<int32_t>(count);
}

namespace sdnap {
inline bool plugin_metadata(uint32_t index, double& period, double& eccentricity) {
  if (plugin_records) {
    auto& st = epochs::resident();
    if (index >= st.plugin_order.size() || st.pool_dead != 0) return false;
    const auto& s = st.series[st.plugin_order[index]];
    const auto& row = st.entries[s.first + s.count - 1].row;
    period = row.mean_motion_rev_day > 0 ? 1440.0 / row.mean_motion_rev_day : 0;
    eccentricity = row.eccentricity;
  } else {
    const auto& st = store();
    if (index >= st.count) return false;
    const uint32_t slot = st.slot[index];
    if (st.kind[index] == 0) {
      const auto& sat = st.sats[slot];
      if (sat.init_error != 0) return false;
      period = sat.xnodp > 0 ? kTwoPi / sat.xnodp : 0;
      eccentricity = sat.eo;
    } else {
      const auto& sat = st.xps[slot];
      if (sat.init_error != 0) return false;
      period = sat.ctx.n0 > 0 ? kTwoPi / sat.ctx.n0 : 0;
      eccentricity = sat.ctx.e0;
    }
  }
  return true;
}
}  // namespace sdnap
SDNAP_EXPORT("get_orbital_period")
double get_orbital_period(uint32_t index) {
  double period = 0, eccentricity;
  sdnap::plugin_metadata(index, period, eccentricity);
  return period;
}
SDNAP_EXPORT("get_eccentricity")
double get_eccentricity(uint32_t index) {
  double period, eccentricity = __builtin_nan("");
  sdnap::plugin_metadata(index, period, eccentricity);
  return eccentricity;
}
