/*
 * spacex-starlink-source OD-flow guest-link EMIT entry (SDN OD-Flow).
 *
 * Turns the spacex-starlink-source data-source into a flow guest-link node: the 'emit' method
 * runs the provider's EXISTING fetch+parse (run_pull, included verbatim below --
 * ps::http_get over the sdm_host_call boundary, native-format parse, in-memory
 * $OEM build) and pushes each $OEM on the "oem" output port via
 * plugin_push_output_ex. Nothing is stored/signed/published ($OEM in-memory
 * only). Built as a wasm32-wasip1-threads relocatable object so it composes into
 * the wasi-threads flow bake alongside the threaded analysis/od node.
 */
#include "oem_emit_entry.hpp"
#include "spacex_starlink_source.cpp"  // provides run_pull() (anonymous namespace, same TU)

extern "C" __attribute__((visibility("default"))) int emit(void) {
  plugin_reset_output_state();
  const od_flow::ConfigInput config = od_flow::read_config_input();
  FlowPullBatch batch = run_flow_batch(config.data, config.size);
  return od_flow::emit_oem_batch(batch.records, batch.backlog_remaining, true);
}
