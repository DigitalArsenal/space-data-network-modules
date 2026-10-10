// Tri-runtime parity: the same artifact and the same invoke bytes in Chrome,
// native WasmEdge and Docker WasmEdge must give byte-identical outputs.
//   PATH="$HOME/.wasmedge/bin:$PATH" node tests/parity.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { normalizeParityFixture, runParityHarness, formatParityReport } from 'space-data-module-sdk/testing';
import { block, diagonal, options, predictions, rdo, wasmPath } from './lib.mjs';
import { gpsScenario } from './gps-scenario.mjs';
import { denseProblem } from './assignment-problems.mjs';

const hex = (inputs) => inputs.map(({ payload, ...rest }) => ({ ...rest, payloadHex: Buffer.from(payload).toString('hex') }));
const still = (x) => [{ epoch: '2026-08-02T00:00:00Z', state: [x, 0, 0, 0, 0, 0] }, { epoch: '2026-08-02T00:10:00Z', state: [x, 0, 0, 0, 0, 0] }];
const covs = [{ epoch: '2026-08-02T00:00:00Z', lower: diagonal(1e-8) }, { epoch: '2026-08-02T00:10:00Z', lower: diagonal(1e-8) }];
const cost = denseProblem(100, 100);
const cases = [
  { id: 'gps-20260802', request: { methodId: 'associate_observations', inputs: hex(gpsScenario().inputs) } },
  { id: 'two-objects', request: { methodId: 'associate_observations', inputs: hex([
    predictions([block({ norad: 1, objectId: 'A', states: still(7000), covariances: covs }), block({ norad: 2, objectId: 'B', states: still(7000.003), covariances: covs })]),
    rdo({ ID: 'o1', OB_TIME: '2026-08-02T00:05:00Z', ID_SENSOR: 'g', SEN_REFERENCE_FRAME: 'GCRF', RANGE: 7000.0014, RANGE_UNC: 0.001 }),
    rdo({ ID: 'o2', OB_TIME: '2026-08-02T00:05:00Z', ID_SENSOR: 'g', SEN_REFERENCE_FRAME: 'GCRF', RANGE: 6999.9995, RANGE_UNC: 0.001 }),
    options({ light_time: false }),
  ]) } },
  { id: 'assignment-dense100', request: { methodId: 'solve_assignment', inputs: [{ portId: 'problem', typeRef: { schemaName: 'application/json' }, payloadHex: Buffer.from(JSON.stringify({ cost })).toString('hex') }] } },
];
const plan = await normalizeParityFixture({ name: 'analysis/association', threadEnvVar: 'SDM_WORKER_COUNT', threadCounts: [1, 2, 4, 8], cases });
const report = await runParityHarness({ wasmPath, plan, timeoutMs: 120000, log: console.log });
console.log(formatParityReport(report));
const summary = { ...report, wasmPath: 'dist/isomorphic/module.wasm' };
fs.mkdirSync(new URL('../conformance/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../conformance/parity.json', import.meta.url), `${JSON.stringify(summary, null, 2)}\n`);
assert.equal(report.ok, true, JSON.stringify(report.failures));
