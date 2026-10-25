// Parity of the shipped artifact across the browser and native WasmEdge lanes, at 1, 2, 4 and 8 workers: identical request
// bytes must give byte-identical outputs and the same exit class in every lane. The owner waived the Docker leg on
// 2026-10-22; it is never started. A failed run leaves the committed receipt untouched: assert, then write.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatParityReport, normalizeParityFixture, runParityHarness } from 'space-data-module-sdk/testing';
import { useHeadlessShell } from './headlessShell.mjs';

const tests = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wasmPath = path.resolve(tests, '../dist/isomorphic/module.wasm');

// `receipt` is a path under tests/evidence/.
export async function parity({ name, cases, receipt, threadCounts = [1, 2, 4, 8], timeoutMs = 60000 }) {
  const plan = await normalizeParityFixture({ name, threadCounts, cases });
  useHeadlessShell();  // the browser lane: Chromium headless shell only
  const report = await runParityHarness({ wasmPath, plan, lanes: ['browser', 'wasmedge'], timeoutMs, log: console.log });
  console.log(formatParityReport(report));
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  const file = path.join(tests, 'evidence', receipt);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ...report, wasmPath: 'dist/isomorphic/module.wasm', dockerLane: 'waived by the owner 2026-10-22 (no Docker)' }, null, 2)}\n`);
  return report;
}
