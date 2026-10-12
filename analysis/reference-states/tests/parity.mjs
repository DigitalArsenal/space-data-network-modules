// Tri-runtime parity (browser, native WasmEdge, Docker WasmEdge) of analysis/reference-states compare_to_reference:
// the same request bytes must give byte-identical reports in every lane.
//   PATH=$HOME/.wasmedge/bin:$PATH node tests/parity.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { formatParityReport, normalizeParityFixture, runParityHarness } from 'space-data-module-sdk/testing';

const sds = path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const flatbuffers = createRequire(path.join(sds, 'package.json'))('flatbuffers');
const OEM = await import(pathToFileURL(path.join(sds, 'lib/js/OEM/main.js')));
const root = fileURLToPath(new URL('..', import.meta.url));
const wasmPath = path.join(root, 'dist/isomorphic/module.wasm');

function oem({ frame, start, step, states, covariance, lines }) {
  const block = new OEM.ephemerisDataBlockT();
  block.REFERENCE_FRAME = Object.assign(new OEM.RFMT(), { NAME: frame });
  block.TIME_SYSTEM = OEM.timingStandard.UTC;
  if (states) Object.assign(block, { START_TIME: start, STEP_SIZE: step, STATE_VECTOR_SIZE: 6, INTERPOLATION_DEGREE: 5, EPHEMERIS_DATA: states.flatMap((r) => [...r, 0, 0, 0]) });
  if (lines) block.EPHEMERIS_DATA_LINES = lines.map(([epoch, r]) => Object.assign(new OEM.ephemerisDataLineT(), { EPOCH: epoch, X: r[0], Y: r[1], Z: r[2] }));
  if (covariance) block.COVARIANCE_MATRIX_LINES = covariance.map(([epoch, c]) => Object.assign(new OEM.covarianceMatrixLineT(), { EPOCH: epoch, CX_X: c[0], CY_X: c[1], CY_Y: c[2], CZ_X: c[3], CZ_Y: c[4], CZ_Z: c[5] }));
  const doc = new OEM.OEMT();
  doc.CCSDS_OEM_VERS = 3.0;
  doc.EPHEMERIS_DATA_BLOCK = [block];
  const b = new flatbuffers.Builder(1024);
  OEM.OEM.finishSizePrefixedOEMBuffer(b, doc.pack(b));
  return b.asUint8Array();
}
const typeRef = { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer' };
const request = (eph, ref) => ({ methodId: 'compare_to_reference', inputs: [
  { portId: 'ephemeris', payloadHex: Buffer.from(eph).toString('hex'), typeRef },
  { portId: 'reference', payloadHex: Buffer.from(ref).toString('hex'), typeRef }] });

// A TEME arc with a full, rotating covariance against GCRF and EME2000 references inside and outside its span.
const minutes = Array.from({ length: 31 }, (_, k) => k);
const iso = (m) => new Date(Date.UTC(2026, 9, 12, 0, m, 0)).toISOString().replace('Z', '');
const arc = minutes.map((m) => { const a = (2 * Math.PI * m * 60) / 5600; return [7000 * Math.cos(a), 7000 * Math.sin(a) * 0.6, 7000 * Math.sin(a) * 0.8]; });
const cov = minutes.map((m) => [iso(m), [0.04 + m * 1e-3, 0.01, 0.25 + m * 2e-3, -0.005, 0.02, 0.01 + m * 1e-4]]);
const refs = [3.5, 10.25, 29.9, 31.5].map((m) => [new Date(Date.UTC(2026, 9, 12, 0, 0, m * 60)).toISOString().replace('Z', ''), arc[Math.min(30, Math.round(m))]]);
const cases = [
  { id: 'teme-covariance-vs-gcrf', request: request(oem({ frame: 'TEMEOFDATE', start: iso(0), step: 60, states: arc, covariance: cov }), oem({ frame: 'GCRF', lines: refs })) },
  { id: 'teme-covariance-vs-eme2000', request: request(oem({ frame: 'TEMEOFDATE', start: iso(0), step: 60, states: arc, covariance: cov }), oem({ frame: 'EME2000', lines: refs })) },
  { id: 'gcrf-no-covariance', request: request(oem({ frame: 'GCRF', start: iso(0), step: 60, states: arc }), oem({ frame: 'GCRF', lines: refs })) },
  { id: 'refused-itrf-ephemeris', expect: null, request: request(oem({ frame: 'ITRF2000', start: iso(0), step: 60, states: arc }), oem({ frame: 'GCRF', lines: refs })) },
];
const plan = await normalizeParityFixture({ name: 'analysis/reference-states compare_to_reference', cases: cases.map((c) => ({ ...c, expect: c.expect === null ? undefined : 'ok' })) });
const report = await runParityHarness({ wasmPath, plan, timeoutMs: 600000, log: console.log });
console.log(formatParityReport(report));
fs.mkdirSync(path.join(root, 'conformance'), { recursive: true });
fs.writeFileSync(path.join(root, 'conformance/parity.json'), `${JSON.stringify({ ...report, wasmPath: 'dist/isomorphic/module.wasm' }, null, 2)}\n`);
assert.equal(report.ok, true, JSON.stringify(report.failures));
