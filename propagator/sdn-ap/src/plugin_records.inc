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

int32_t plugin_record_state(double jd, uint32_t index, OrbProStateVector* out) {
  if (out == nullptr) return ORBPRO_PROP_NULL_OUTPUT;
  if (plugin_record_count() == 0) return ORBPRO_PROP_NOT_INITIALIZED;
  if (index >= plugin_record_count()) return ORBPRO_PROP_BAD_ENTITY_INDEX;
  if (!std::isfinite(jd)) return ORBPRO_PROP_BAD_INPUT;
  plugin_invalid(jd, out);
  auto& st = epochs::resident();
  if (st.pool_dead != 0) return ORBPRO_PROP_UNPHYSICAL;
  const uint32_t raw = st.plugin_order[index];
  double whole, frac;
  split_jd(jd, whole, frac);
  // Stock records use their own theory, including epoch selection and blending, with no AP cells.
  if (st.series[raw].met != meanElementSource_AP) return plugin_direct_state(raw, whole, frac, out);
  auto& fs = frames::state();
  if (!fs.open || (fs.flags & frames::kFlagPositionOnly) != 0) return -8;
  double state[6];
  int32_t status = frames::kNoSegment;
  const int32_t rc = sdnap_frames_at(whole, frac, raw, 1, ORBPRO_FRAME_ECEF, state, &status);
  if (rc != 0 || status != frames::kServed)
    return status == frames::kApRefuses || status == frames::kBuilderFails ? ORBPRO_PROP_UNPHYSICAL : -8;
  for (int a = 0; a < 3; ++a) { out->position[a] = state[a]; out->velocity[a] = state[a + 3]; }
  out->flags = ORBPRO_STATE_VALID;
  return 0;
}

int32_t plugin_record_batch(double jd, OrbProStateVector* out, uint32_t count) {
  if (out == nullptr) return ORBPRO_PROP_NULL_OUTPUT;
  if (plugin_record_count() == 0) return ORBPRO_PROP_NOT_INITIALIZED;
  if (count > plugin_record_count()) return ORBPRO_PROP_BAD_ENTITY_INDEX;
  if (!std::isfinite(jd)) return ORBPRO_PROP_BAD_INPUT;
  for (uint32_t i = 0; i < count; ++i) plugin_record_state(jd, i, out + i);
  return 0;
}
}  // namespace sdnap
