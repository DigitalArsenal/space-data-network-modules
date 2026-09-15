// Canonical wasi-threads is hosted directly by WasmEdge. Legacy runner-building
// call sites keep this preparation helper while using the SDK native loader.
import { buildNativeWasiThreadsRunner } from './wasmedgeWasiThreadsRunner.mjs';
export async function buildThreadedWasmEdgeRunner() {
  return buildNativeWasiThreadsRunner();
}
