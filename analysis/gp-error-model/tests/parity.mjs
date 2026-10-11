// Tri-runtime parity (browser, WasmEdge, Docker WasmEdge) of the methods E2b
// added, on the inputs of tests/covariance_mapping.test.mjs, plus accumulate and
// E14's pair_statistics, fit_calibration, calibrate_covariance and dcp_covariance,
// the catalog pipeline's attach_covariance (rules 1 to 4) and attribute_maneuvers,
// and fit_elements and element_residuals on inputs of tests/fit_elements.test.mjs:
// identical request bytes must give byte-identical outputs in every lane.
//   PATH=$HOME/.wasmedge/bin:$PATH node tests/parity.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { normalizeParityFixture, runParityHarness, formatParityReport } from 'space-data-module-sdk/testing';
import {
  alignedOem, beyond, deriveStates, encodeMnv, encodeOmm, fitOcm, json as jsonFrame, leoH, mnvFrame, ocmFrame, ommFrame, oemFrame, operatorOem, recipeFor,
  valladoOmm, vallado,
} from './products-fixtures.mjs';

const root = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const require = createRequire(path.join(root, 'package.json'));
const flatbuffers = require('flatbuffers');
const load = async (code) => import(pathToFileURL(path.join(root, `lib/js/${code}/main.js`)));
const [OMM, OEM] = await Promise.all(['OMM', 'OEM'].map(load));
const ref = JSON.parse(fs.readFileSync(new URL('./stm-reference.json', import.meta.url)));
const fitRef = JSON.parse(fs.readFileSync(new URL('./fit-reference.json', import.meta.url)));
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
// Ephemeris frames for fit_elements / element_residuals (compact form or lines).
function ephemeris(norad, frame, opts) {
  const b = new OEM.ephemerisDataBlockT();
  Object.assign(b, { CENTER_NAME: 'EARTH', TIME_SYSTEM: OEM.timingStandard.UTC });
  b.OBJECT = Object.assign(new OEM.CATT(), { NORAD_CAT_ID: norad });
  b.REFERENCE_FRAME = Object.assign(new OEM.RFMT(), { NAME: frame });
  if (opts.lines) {
    b.EPHEMERIS_DATA_LINES = opts.lines.map(([epoch, ...x]) => {
      const l = new OEM.ephemerisDataLineT();
      l.EPOCH = `${epoch}Z`;
      [l.X, l.Y, l.Z, l.X_DOT, l.Y_DOT, l.Z_DOT] = x;
      return l;
    });
  } else {
    Object.assign(b, { START_TIME: `${opts.start}Z`, STEP_SIZE: opts.step, STATE_VECTOR_SIZE: opts.size, EPHEMERIS_DATA: opts.data });
  }
  const fb = new flatbuffers.Builder(1 << 20);
  OEM.OEM.finishSizePrefixedOEMBuffer(fb, Object.assign(new OEM.OEMT(), { EPHEMERIS_DATA_BLOCK: [b] }).pack(fb));
  return { portId: 'ephemeris', payload: Buffer.from(fb.asUint8Array()), typeRef: { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer' } };
}
const compact = (norad, c) => ephemeris(norad, c.frame, { start: c.start, step: c.stepSeconds, size: c.stateVectorSize, data: c.data });
const geo = fitRef.synthetic.find((c) => c.name === 'geo');
const issEph = ephemeris(25544, fitRef.iss.frame, { lines: fitRef.iss.states });
// An element set of the ISS to score on its ephemeris: the fit of the NASA ISS OEM (a U.S. Government work) that scipy makes in
// tests/fit-reference.py. Parity needs inputs every checkout has, so no CelesTrak set (no reuse licence) is read.
function issSet() {
  const e = fitRef.iss.scipy, t = new OMM.OMMT();
  Object.assign(t, { EPOCH: fitRef.iss.epoch, NORAD_CAT_ID: 25544, MEAN_ELEMENT_THEORY: OMM.meanElementSource.SGP4, MEAN_MOTION: e[0], ECCENTRICITY: e[1],
    INCLINATION: e[2], RA_OF_ASC_NODE: e[3], ARG_OF_PERICENTER: e[4], MEAN_ANOMALY: e[5], BSTAR: e[6] });
  const b = new flatbuffers.Builder(512);
  OMM.OMM.finishSizePrefixedOMMBuffer(b, t.pack(b));
  return { portId: 'elements', payload: Buffer.from(b.asUint8Array()), typeRef: { schemaName: 'OMM.fbs', fileIdentifier: '$OMM', rootTypeName: 'OMM', wireFormat: 'flatbuffer' } };
}
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
  // E14's methods (tests/covariance_realism.test.mjs inputs).
  { id: 'pair-statistics', request: { methodId: 'pair_statistics', inputs: [json('pairs', { pairs: [
    { id: 'a', predicted: { position: [7000e3, 0, 0], velocity: [0, 7500, 0], covariance: [100, 0, 10000, 0, 0, 25], covarianceAxes: 'RTN' },
      truth: { position: [7000e3 - 10, 200, -5], velocity: [0, 7500, 0], covariance: [1, 0, 1, 0, 0, 1], covarianceAxes: 'RTN' } }] })] } },
  { id: 'pair-statistics-samples', request: { methodId: 'pair_statistics', inputs: [json('pairs', { pairs: [{ id: 's',
    predicted: { epoch: '2026-10-10T12:04:30.000', interpolationDegree: 5, covarianceAxes: 'RTN', samples: Array.from({ length: 8 }, (_, i) => ({
      epoch: new Date(Date.UTC(2026, 9, 10, 12, i)).toISOString().replace('Z', ''), position: [7e6 - 50 * i * i, 7.5e3 * 60 * i, 1e3 * i], velocity: [-100 * i / 60, 7.5e3, 1e3 / 60],
      covariance: [100 + i, 0, 400 + 2 * i, 0, 0, 25] })) },
    truth: { position: [7e6 - 50 * 4.5 * 4.5, 7.5e3 * 270, 4.5e3], velocity: [-7.5, 7.5e3, 1e3 / 60] } }] })] } },
  { id: 'noise-responses', request: { methodId: 'noise_responses', inputs: [json('request', { start: '2026-01-01T00:00:00.000', discretizationSeconds: 600,
    samples: [600, 1200, 1800].map((s) => ({ epoch: new Date(Date.UTC(2026, 0, 1) + s * 1000).toISOString().replace('Z', ''), state: [7000e3, 10, 0, 1, 7500, 2],
      stm: Array.from({ length: 36 }, (_, k) => (Math.floor(k / 6) === k % 6 ? 1 : k % 6 === Math.floor(k / 6) + 3 ? s : 0) + 1e-7 * k) })),
    targets: ['2026-01-01T00:30:00.000'] })] } },
  { id: 'fit-calibration', request: { methodId: 'fit_calibration', inputs: [json('samples', { samples: [[1, 1, 1], [2, 1, 1], [3, 0, 0], [0, 0, 0], [2, 2, 2]]
    .map((e, i) => ({ stratum: 's', object: i % 3, error: e, covariance: [1, 0, 1, 0, 0, 1] })) }), json('options', { method: 'axes-mle' })] } },
  { id: 'calibrate-covariance-sets', request: { methodId: 'calibrate_covariance', inputs: [
    json('model', { kind: 'e14-element-set-model', version: 'parity', regimes: [{ id: 'LEO', altitudeKm: [0, 2000], eccentricity: [0, 0.25] }], ageBinsDays: [[0, 1], [1, 3]],
      strata: [{ regimeIndex: 0, ageIndex: 0, n: 40, covariance: [1, 0, 4, 0, 0, 9, ...Array(15).fill(0)] }, { regimeIndex: 0, ageIndex: 1, n: 40, covariance: [3, 0, 8, 0, 0, 11, ...Array(15).fill(0)] }],
      factors: [{ regimeIndex: 0, ageIndex: 0, factor: 2 }, { regimeIndex: 0, ageIndex: 1, factor: 4 }] }),
    json('objects', { objects: [{ id: 'leo', set: { norad: ref.sets.leo.norad, epoch: ref.sets.leo.EPOCH }, ageDays: 1.25,
      state: { position: [6978137, 1000, -2000], velocity: [10, 7546, 120] } }] }), elements('leo')] } },
  { id: 'dcp-covariance', request: { methodId: 'dcp_covariance', inputs: [json('request', { leadCovariance: [[0.04, 0.01, 0], [0.01, 0.09, 0.02], [0, 0.02, 0.16]],
    start: '2026-01-10T00:00:00.000', segments: [1, 2, 3].map((k) => ({ from: `2026-01-${String(9 + k).padStart(2, '0')}T00:00:00.000`, to: `2026-01-${String(10 + k).padStart(2, '0')}T00:00:00.000`, lead: k })),
    epochs: [{ epoch: '2026-01-13T00:00:00.000', sensitivity: [1, -2000, 3, 0.1, 0.2, -0.3] }, { epoch: '2026-01-11T12:00:00.000', sensitivity: [1, -2000, 3, 0.1, 0.2, -0.3] }] })] } },
  // fit_elements and element_residuals (tests/fit_elements.test.mjs inputs).
  { id: 'fit-elements-leo-noise', request: { methodId: 'fit_elements', inputs: [compact(40001, fitRef.noisy),
    json('options', { epoch: `${fitRef.noisy.epoch}Z`, fitBstar: true, creationDate: '2026-10-10T00:00:00Z', originator: 'parity' })] } },
  { id: 'fit-elements-geo-multistart', request: { methodId: 'fit_elements', inputs: [compact(40002, geo), json('options', { epoch: `${geo.epoch}Z`, fitBstar: false })] } },
  { id: 'fit-elements-iss', request: { methodId: 'fit_elements', inputs: [issEph, json('options', { epoch: `${fitRef.iss.epoch}Z`, fitBstar: true })] } },
  { id: 'element-residuals-iss', request: { methodId: 'element_residuals', inputs: [issSet(), issEph, json('options', { requests: [{ norad: 25544,
    set: fitRef.iss.epoch, windows: [{ from: `${fitRef.iss.supgp.window6h.from}Z`, to: `${fitRef.iss.supgp.window6h.to}Z`, label: 'segment' }] }], samples: true })] } },
];

// The catalog pipeline: element sets of every regime, an operator ephemeris with covariance, a fit with a realism factor.
const productSets = Buffer.concat([valladoOmm(6251), valladoOmm(28057), valladoOmm(5), valladoOmm(14128), valladoOmm(9880), leoH, beyond].map((x) => encodeOmm(x)));
const productStates = await deriveStates(productSets, [0, 0.5, 1]);
const c28057 = vallado.find((x) => x.satnum === 28057);
const at = (seconds) => new Date(Date.parse('2006-06-27T06:52:04.079712Z') + seconds * 1000).toISOString();
const lower21 = (k) => Array.from({ length: 21 }, (_, i) => (i === 0 || i === 2 || i === 5 ? (k + 1) * 1e-4 : (i + 1) * 1e-9 * (k + 1)));
const operator = operatorOem({ objectId: valladoOmm(28057).objectId, name: valladoOmm(28057).name, covFrame: 'UVW',
  rows: [0, 1, 2].map((k) => ({ epoch: at(60 * k), x: [...c28057.gcrfR.map((v, i) => v + 0.1 * k + i), ...c28057.gcrfV] })), cov: [0, 2].map((k) => ({ epoch: at(60 * k), lower: lower21(k) })) });
const productCases = [
  { id: 'attach-rules-3-and-4-every-regime', request: { methodId: 'attach_covariance', inputs: [ommFrame('elements', productSets), alignedOem('states', productStates), jsonFrame('recipe', recipeFor())] } },
  { id: 'attach-rule-4-pooled', request: { methodId: 'attach_covariance', inputs: [ommFrame('elements', productSets), alignedOem('states', productStates),
    jsonFrame('recipe', recipeFor({ id: 'spacemapper-aoe', lineage: 'spacemapper-aoe', own: false }))] } },
  { id: 'attach-rule-1-operator', request: { methodId: 'attach_covariance', inputs: [ommFrame('elements', encodeOmm(valladoOmm(28057))), alignedOem('states', await deriveStates(encodeOmm(valladoOmm(28057)))),
    oemFrame('operator', operator), jsonFrame('recipe', recipeFor({ id: 'spacex-starlink', kind: 'ephemeris', lineage: 'spacex-meme', own: false, extra: { maxOperatorRows: 2 } }))] } },
  { id: 'attach-rule-2-fit', request: { methodId: 'attach_covariance', inputs: [ommFrame('elements', encodeOmm(leoH)), alignedOem('states', await deriveStates(encodeOmm(leoH))),
    ocmFrame('fit', fitOcm({ norad: 90101, name: leoH.name, epoch: '2026-10-01T12:00:00.000000', x: [4000.5, 5000.25, 3000.125, -3.5, 4.25, 4.75], lower: lower21(1) })),
    jsonFrame('recipe', recipeFor({ id: 'ilrs-crd', kind: 'observation', lineage: 'ilrs-slr', own: false, fitClass: 'slr-hpop-fit',
      extra: { realism: [{ sources: ['ilrs-crd'], class: 'slr-hpop-fit', factor: 17.04, meanD2Over3: 17.04, coverage95: 0.17, samples: 1000, objects: 5, evidence: 'orbit-accuracy-experiments E6 test', window: '2026-05-01..2026-09-30' }] } }))] } },
  { id: 'attribute-maneuvers', request: { methodId: 'attribute_maneuvers', inputs: [mnvFrame('maneuvers', Buffer.concat([encodeMnv(), encodeMnv({ ID: 'M2', TAGS: [] })])), jsonFrame('recipe', recipeFor())] } },
];
cases.push(...productCases);
const plan = await normalizeParityFixture({ name: 'gp-error-model e2b and e14 methods, the catalog pipeline and the element fit', cases: cases.map((c) => ({ ...c, request: { ...c.request,
  inputs: c.request.inputs.map(({ payload, ...p }) => ({ ...p, payloadHex: Buffer.from(payload).toString('hex') })) } })) });
const report = await runParityHarness({ wasmPath: fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url)), plan, timeoutMs: 120000, log: console.log });
console.log(formatParityReport(report));
fs.writeFileSync(new URL('../conformance/parity.json', import.meta.url), `${JSON.stringify({ ...report, wasmPath: 'dist/isomorphic/module.wasm' }, null, 2)}\n`);
assert.equal(report.ok, true, JSON.stringify(report.failures));
