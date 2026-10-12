// Tri-runtime parity (browser, WasmEdge, Docker WasmEdge) of every method:
// identical request bytes must give byte-identical outputs, and identical
// error classes, in every lane.
//   PATH=$HOME/.wasmedge/bin:$PATH node tests/parity.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeParityFixture, runParityHarness, formatParityReport } from 'space-data-module-sdk/testing';
import { EPOCHS, LEO, T0, add, block, burns, flatbuffers, gpHistory, history, iso, kepler, manifest, mul, oem, planned, rtn, toFixed, unit, version, MNV } from './fixtures.mjs';
import { ommStream, sgp4Provider, keplerianProvider, TYPES, json } from '../study/lib/host.mjs';

const typed = (portId, payload, typeRef) => ({ portId, payload: Buffer.from(payload), typeRef });
const OEM_T = TYPES.OEM, MNV_T = TYPES.MNV, OMM_T = TYPES.OMM;

const pre = LEO();
const tb = EPOCHS[15] + 3600;
const burned = oem(history(pre, tb, (r, v) => mul(unit(v), 0.001)).blocks);
const pair = oem(burns(pre, [{ tb: EPOCHS[14] + 1800, dv: 0.0005 }, { tb: EPOCHS[14] + 1800 + 9 * 3600, dv: 0.0007 }]));
const fixed = oem(history(pre, tb, (r, v) => mul(unit(v), 0.001)).blocks.map(toFixed));

// The sets name their source, which the events carry in PROVENANCE.
const source = Object.assign(new MNV.PVNT(), { SOURCE_ID: 'parity-gp', SOURCE_KIND: MNV.pvnSourceKind.ElementSet, ORIGINATOR: 'Parity catalog', PROVIDER_ID: 'parity-node',
  PRODUCER: 'parity-parser 1.0', LICENSE_CLASS: MNV.pvnLicenseClass.CiteOnly, LICENSE_ID: 'parity-terms', LINEAGE: 'parity-catalog' });

// The query port: the element sets, and their answers from two providers.
const { rows } = gpHistory(1);
const elements = typed('element_sets', ommStream(rows.map((row) => ({ ...row, PROVENANCE: source }))), OMM_T);
const options = { propagator_port_id: 'parity', detectors: ['D1', 'D2', 'D3'], report_levels: true };
const queries = JSON.parse((await (async () => {
  const { loadModule, jsonOf } = await import('../study/lib/host.mjs');
  const m = await loadModule('analysis/maneuver-detection');
  try { return JSON.stringify(jsonOf(await m.invoke('detect_maneuvers', [elements, json('options', options)]), 'propagation_requests')); } finally { await m.destroy(); }
})()));
const sgp4Answers = await (await sgp4Provider()).answer(queries, rows);
const keplerAnswers = await (await keplerianProvider()).answer(queries, rows);

// compare_ephemerides and score_detections inputs.
const tig = T0 + 86400;
const [r0, v0] = pre(tig);
const post = kepler(r0, add(v0, mul(unit(v0), 0.001)), tig);
const versions = [version((s) => (s < tig ? pre : post)(s), T0, T0 + 3 * 86400, tig - 7200), version(post, tig + 6 * 3600, T0 + 3 * 86400, tig + 8 * 3600)];
// A 2 m/s burn along the orbit normal, flown as modelled, against a plan with a cross-track component.
const crossPost = kepler(r0, add(v0, mul(rtn(r0, v0).N, 0.002)), tig);
const crossVersions = [version((s) => (s < tig ? pre : crossPost)(s), T0, T0 + 3 * 86400, tig - 7200), version(crossPost, tig + 6 * 3600, T0 + 3 * 86400, tig + 8 * 3600)];
const mnv = (fields) => {
  const m = Object.assign(new MNV.MNVT(), { SAT_NO: 99001, ...fields });
  const b = new flatbuffers.Builder(512);
  MNV.MNV.finishSizePrefixedMNVBuffer(b, m.pack(b));
  return Buffer.from(b.asUint8Array());
};

const cases = [
  { id: 'detect-ephemerides-burn', request: { methodId: 'detect_maneuvers', inputs: [typed('ephemerides', burned, OEM_T), json('options', options)] } },
  { id: 'detect-burn-pair', request: { methodId: 'detect_maneuvers', inputs: [typed('ephemerides', pair, OEM_T), json('options', { detectors: ['D1', 'D2'] })] } },
  { id: 'detect-earth-fixed', request: { methodId: 'detect_maneuvers', inputs: [typed('ephemerides', fixed, OEM_T)] } },
  { id: 'detect-query-requests', request: { methodId: 'detect_maneuvers', inputs: [elements, json('options', options)] } },
  { id: 'detect-query-sgp4', request: { methodId: 'detect_maneuvers', inputs: [elements, json('options', options), ...sgp4Answers.map((a) => typed('propagation', a, OEM_T))] } },
  { id: 'detect-query-keplerian', request: { methodId: 'detect_maneuvers', inputs: [elements, json('options', options), ...keplerAnswers.map((a) => typed('propagation', a, OEM_T))] } },
  { id: 'compare-planned', request: { methodId: 'compare_ephemerides', inputs: [...versions.map((v) => typed('versions', v, OEM_T)), typed('planned', planned(tig, 0.001), MNV_T)] } },
  { id: 'compare-planned-cross-track', request: { methodId: 'compare_ephemerides', inputs: [...crossVersions.map((v) => typed('versions', v, OEM_T)),
    typed('planned', planned(tig, 0.002, { DELTA_VEL_W: 0.002, PROVENANCE: source }), MNV_T)] } },
  { id: 'compare-planned-in-track', request: { methodId: 'compare_ephemerides', inputs: [...crossVersions.map((v) => typed('versions', v, OEM_T)),
    typed('planned', planned(tig, 0.002, { DELTA_VEL_V: 0.002, PROVENANCE: source }), MNV_T)] } },
  { id: 'score', request: { methodId: 'score_detections', inputs: [
    typed('truth', Buffer.concat([mnv({ ID: 'a', EVENT_START_TIME: iso(T0), DELTA_VEL: 0.001 }), mnv({ ID: 'b', EVENT_START_TIME: iso(T0 + 864000), DELTA_VEL: 0.002 })]), MNV_T),
    typed('detected', Buffer.concat([mnv({ ID: 'x', EVENT_START_TIME: iso(T0 + 1800), DELTA_VEL: 0.0009 }), mnv({ ID: 'z', EVENT_START_TIME: iso(T0 + 432000), DELTA_VEL: 0.0001 })]), MNV_T),
    json('options', { spans: [{ object: 'NORAD:99001', from: iso(T0), to: iso(T0 + 15778800) }] })] } },
  { id: 'refused-option', request: { methodId: 'detect_maneuvers', inputs: [typed('ephemerides', burned, OEM_T), json('options', { no_such_option: 1 })] } },
];
const plan = await normalizeParityFixture({ name: `maneuver-detection ${manifest.version} methods`, cases: cases.map((c) => ({ ...c, request: { ...c.request,
  inputs: c.request.inputs.map(({ payload, ...p }) => ({ ...p, payloadHex: Buffer.from(payload).toString('hex') })) } })) });
const report = await runParityHarness({ wasmPath: fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url)), plan, timeoutMs: 300000, log: console.log });
console.log(formatParityReport(report));
fs.mkdirSync(new URL('../conformance/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../conformance/parity.json', import.meta.url), `${JSON.stringify({ ...report, wasmPath: 'dist/isomorphic/module.wasm' }, null, 2)}\n`);
assert.equal(report.ok, true, JSON.stringify(report.failures));
