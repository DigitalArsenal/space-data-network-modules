// Tri-runtime parity: the same artifact and the same invoke bytes in Chrome,
// native WasmEdge and Docker WasmEdge must give byte-identical outputs.
//   PATH="$HOME/.wasmedge/bin:$PATH" node tests/parity.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeParityFixture, runParityHarness, formatParityReport } from 'space-data-module-sdk/testing';
import { FIXED, OFFSET, T0, access, model, mul, norm, request, sensor, station, straight, target, wasmPath } from './lib.mjs';

const los = mul(OFFSET, 1 / norm(OFFSET));
const site = [station('site', 30, 0, 100)];
const invoke = (bytes) => ({ methodId: 'simulate_observations', inputs: [{ portId: 'request', typeRef: { schemaName: 'ACW.fbs', fileIdentifier: '$ACW', rootTypeName: 'ACW', wireFormat: 'flatbuffer' }, payloadHex: Buffer.from(bytes).toString('hex') }] });
const cases = [
  { id: 'radar-range-noise', request: invoke(request({ GROUND_STATIONS: site, TARGETS: [target('fixed', straight(T0, FIXED, [0, 0, 0], 3600, 600))],
    SENSORS: [sensor('radar', 'site', 'RADAR', [model('RANGE', 10, { BIAS: 5, CORRELATION_TIME_SECONDS: 60 }), model('AZIMUTH_ELEVATION', 1e-4)])],
    ACCESS: [access('radar', 'fixed', [[T0, T0 + 1800 / 86400]])] })) },
  { id: 'passive-rf-doppler-noise', request: invoke(request({ GROUND_STATIONS: site,
    TARGETS: [target('emitter', straight(T0, FIXED, mul(los, 1000), 3600, 600), { EMITTER_FREQUENCY_HZ: 2.2e9, EMITTER_EIRP_DBW: 30 })],
    SENSORS: [sensor('rf', 'site', 'PASSIVE_RF', [model('DOPPLER', 50, { BIAS: 20 })], { RECEIVER_G_OVER_T_DB_PER_K: 20, RECEIVER_BANDWIDTH_HZ: 1e6, DETECTION_THRESHOLD_DB: -100, FALSE_ALARM_RATE_PER_HOUR: 2 })],
    ACCESS: [access('rf', 'emitter', [[T0, T0 + 1800 / 86400]])] })) },
];
const plan = await normalizeParityFixture({ name: 'analysis/observation-simulator', threadEnvVar: 'SDM_WORKER_COUNT', threadCounts: [1, 2, 4, 8], cases });
const report = await runParityHarness({ wasmPath, plan, timeoutMs: 120000, log: console.log });
console.log(formatParityReport(report));
fs.mkdirSync(new URL('../conformance/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../conformance/parity.json', import.meta.url), `${JSON.stringify({ ...report, wasmPath: 'dist/isomorphic/module.wasm' }, null, 2)}\n`);
assert.equal(report.ok, true, JSON.stringify(report.failures));
