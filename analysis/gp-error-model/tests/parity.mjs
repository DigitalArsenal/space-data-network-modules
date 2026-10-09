// Tri-runtime parity (browser, WasmEdge, Docker WasmEdge) of the methods E2b
// added, on the inputs of tests/covariance_mapping.test.mjs, plus accumulate:
// identical request bytes must give byte-identical outputs in every lane.
//   PATH=$HOME/.wasmedge/bin:$PATH node tests/parity.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { normalizeParityFixture, runParityHarness, formatParityReport } from 'space-data-module-sdk/testing';

const root = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const require = createRequire(path.join(root, 'package.json'));
const flatbuffers = require('flatbuffers');
const load = async (code) => import(pathToFileURL(path.join(root, `lib/js/${code}/main.js`)));
const [OMM, OEM] = await Promise.all(['OMM', 'OEM'].map(load));
const ref = JSON.parse(fs.readFileSync(new URL('./stm-reference.json', import.meta.url)));
function omm(s) {
  const t = new OMM.OMMT();
  Object.assign(t, { EPOCH: s.EPOCH, NORAD_CAT_ID: s.norad, MEAN_ELEMENT_THEORY: OMM.meanElementSource.SGP4, MEAN_MOTION: s.MEAN_MOTION,
    ECCENTRICITY: s.ECCENTRICITY, INCLINATION: s.INCLINATION, RA_OF_ASC_NODE: s.RA_OF_ASC_NODE, ARG_OF_PERICENTER: s.ARG_OF_PERICENTER,
    MEAN_ANOMALY: s.MEAN_ANOMALY, BSTAR: s.BSTAR });
  const b = new flatbuffers.Builder(512);
  OMM.OMM.finishSizePrefixedOMMBuffer(b, t.pack(b));
  return Buffer.from(b.asUint8Array());
}
const elements = (...names) => ({ portId: 'elements', payload: Buffer.concat(names.map((n) => omm(ref.sets[n]))),
  typeRef: { schemaName: 'OMM.fbs', fileIdentifier: '$OMM', rootTypeName: 'OMM', wireFormat: 'flatbuffer' } });
function reference(norad, lines) {
  const block = new OEM.ephemerisDataBlockT();
  Object.assign(block, { CENTER_NAME: 'EARTH', TIME_SYSTEM: OEM.timingStandard.UTC, EPHEMERIS_DATA_LINES: lines.map(([epoch, x]) => {
    const l = new OEM.ephemerisDataLineT();
    l.EPOCH = `${epoch}Z`;
    [l.X, l.Y, l.Z, l.X_DOT, l.Y_DOT, l.Z_DOT] = x;
    return l;
  }) });
  block.OBJECT = Object.assign(new OEM.CATT(), { NORAD_CAT_ID: norad });
  block.REFERENCE_FRAME = Object.assign(new OEM.RFMT(), { NAME: 'GCRF' });
  const b = new flatbuffers.Builder(4096);
  OEM.OEM.finishSizePrefixedOEMBuffer(b, Object.assign(new OEM.OEMT(), { EPHEMERIS_DATA_BLOCK: [block] }).pack(b));
  return { portId: 'reference', payload: Buffer.from(b.asUint8Array()), typeRef: { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer' } };
}
const json = (portId, value) => ({ portId, payload: Buffer.from(JSON.stringify(value)), typeRef: { schemaName: 'application/json' } });
const ce = ref.commonEpoch, sets = ce.sets.map((n) => ref.sets[n].EPOCH);
const truth = reference(6251, [[ce.target, ce.reference], [ce.later, ce.referenceLater]]);
const P0 = ref.sgp4[0].covariance;
const mapping = (set, method, to, from) => ({ methodId: 'map_covariance', inputs: [elements(set), json('options', { requests: [{
  norad: ref.sets[set].norad, set: ref.sets[set].EPOCH, ...(from ? { from } : {}), covariance: P0, to, method, stm: true }] })] });
const cases = [
  { id: 'common-epoch', request: { methodId: 'common_epoch', inputs: [elements('leo', 'leo-b', 'leo-c'), truth, json('options', { targets: [
    { norad: 6251, epoch: ce.target, sets, origin: 'reference' }, { norad: 6251, epoch: ce.target, sets, origin: 'mean' },
    { norad: 6251, epoch: ce.target, sets, origin: 'set', originSet: ref.sets['leo-b'].EPOCH }] })] } },
  { id: 'map-sgp4', request: mapping('leo', 'sgp4', ref.sgp4[0].targets.map((x) => x.epoch)) },
  { id: 'map-sgp4-deep-space', request: mapping('gps', 'sgp4', ref.sgp4[1].targets.map((x) => x.epoch), ref.sgp4[1].fromEpoch) },
  { id: 'map-two-body', request: mapping('leo', 'two-body', ref.twoBody[0].targets.map((x) => x.epoch)) },
  { id: 'map-lambert', request: mapping('leo', 'lambert', ref.lambert[1].targets.map((x) => x.epoch)) },
  { id: 'screening-cases', request: { methodId: 'screening_cases', inputs: [json('cases', { pairs: [
    { e1: [0.004, -0.01, 0.006], c1: [4e-4, 1e-4, 9e-4, 0, 2e-4, 2.5e-4], e2: [-0.008, 0.02, 0.003], c2: [1e-4, 0, 2e-4, 0, 0, 3e-4] }] }),
    json('options', { hardBodyRadiusM: 20, missDistancesM: [0, 30, 500], directions: 4 })] } },
  { id: 'accumulate-reference', request: { methodId: 'accumulate', inputs: [elements('leo', 'leo-b', 'leo-c'), truth,
    json('options', { referenceStepSeconds: 0 })] } },
];
const plan = await normalizeParityFixture({ name: 'gp-error-model e2b methods', cases: cases.map((c) => ({ ...c, request: { ...c.request,
  inputs: c.request.inputs.map(({ payload, ...p }) => ({ ...p, payloadHex: Buffer.from(payload).toString('hex') })) } })) });
const report = await runParityHarness({ wasmPath: fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url)), plan, timeoutMs: 120000, log: console.log });
console.log(formatParityReport(report));
fs.writeFileSync(new URL('../conformance/parity.json', import.meta.url), `${JSON.stringify({ ...report, wasmPath: 'dist/isomorphic/module.wasm' }, null, 2)}\n`);
assert.equal(report.ok, true, JSON.stringify(report.failures));
