// Diagnostic build for plugin-records.e2e.mjs; no probes are exported by production artifacts.
import {buildDiagnostic, failureProbe, failureSeam} from './ap-diagnostic.mjs';
export const pluginProbe = failureProbe + `
SDNAP_EXPORT("sdnap_test_plugin_dead") void sdnap_test_plugin_dead(int n) {
  sdnap::epochs::resident().pool_dead = n;
  __atomic_store_n(&sdnap::pool::job().active, n, __ATOMIC_SEQ_CST);
}
SDNAP_EXPORT("sdnap_test_plugin_active") void sdnap_test_plugin_active(int n) {
  __atomic_store_n(&sdnap::pool::job().active, n, __ATOMIC_SEQ_CST);
}
SDNAP_EXPORT("sdnap_test_plugin_slot_bytes") double sdnap_test_plugin_slot_bytes(uint32_t index) {
  auto& st = sdnap::epochs::resident();
  if (index >= st.series.size()) return -1;
  const auto& s = st.series[st.plugin_series_index(index)];
  double bytes = 0;
  for (const auto& q : s.slots) bytes += (q.xp ? sdnap::xpt::xp_bytes(*q.xp) : 0) +
    (q.sat ? sizeof(sdnap::Sat) : 0) + (q.nodes ? 32u * sdnap::kCheckpointNodes : 0);
  return bytes;
}
SDNAP_EXPORT("sdnap_test_plugin_init_tables") double sdnap_test_plugin_init_tables(uint32_t index) {
  auto& st = sdnap::epochs::resident();
  if (index >= st.series.size()) return -1;
  auto& s = st.series[st.plugin_series_index(index)];
  auto& slot = sdnap::epochs::slot_of(st, s, 0, false);
  return slot.xp ? sdnap::xpt::xp_bytes(*slot.xp) - sizeof(sdnap::xpt::XpSat) : 0;
}`;
export function buildPluginDiagnostic() {
  process.env.SDM_MODULE_UNSIGNED_BUILD = '1';
  delete process.env.SDM_MODULE_SIGNING_KEYPAIR_PATH;
  return buildDiagnostic('plugin-records-diagnostic', pluginProbe, s => s, failureSeam);
}
