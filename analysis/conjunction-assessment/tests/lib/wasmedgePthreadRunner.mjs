// Canonical wasi-threads is hosted directly by WasmEdge. Legacy runner-building
// call sites keep this preparation helper while using the SDK native loader.
import { execFileSync } from 'node:child_process';
export async function buildThreadedWasmEdgeRunner() {
  execFileSync('wasmedge', ['--version'], { stdio: 'pipe' });
  return true;
}
