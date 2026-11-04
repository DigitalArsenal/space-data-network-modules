#!/usr/bin/env node
// E2E (modules-estimation-ffm-loop-node-20261104): the laser orbit-determination node on two days of Starlette normal
// points, through the shipped artifacts of data-source/ilrs-crd-source, data-source/ilrs-station-coordinates,
// data-source/eop-parser, analysis/estimation (fit_batch) and propagator/ffm (invoke), in the SDK's in-process harness.
//
// Inputs (tests/fixtures/PROVENANCE.md): the normal points of 2026-07-13T15:00 to 2026-07-15T15:00 cut from EDC's
// starlette_202607.np2; the ILRS weekly station solution of 2026-07-18 (data-source/ilrs-station-coordinates' fixture);
// IERS EOP 20 C04 rows of 2026-07-10 to 2026-07-20; the DE440 2026 excerpt (files/orbit-products).
// The first guess: NSGF's state of 2026-07-13T15:00 (nsgf.orb.starlette.260715.v000, archive reference-states, the GCRF
// conversion of the product of EDC's rapid orbits), rounded to 100 m and 0.1 m/s.
// The truth: NSGF's state of 2026-07-15T15:00 from the next product, nsgf.orb.starlette.260716.v000
// (/opt/data/sdn-archive/reference-states/reference/nsgf.orb.starlette.260716.v000/7646.oem, SHA-256
// 8f50e071ddb14a1f3c799d5905f36632713454700f052ffdefe64014c97a88c9), the line as recorded there.
// The dynamics: EGM2008 70x70 with the EOP, the Sun and the Moon from DE440, cannonball radiation pressure with
// Cr*A/m 0.00115 m^2/kg (Cr 1.2, 0.0452 m^2, 47.3 kg; stated, not fitted), IERS 2010 solid tides and relativity, FES2004
// ocean tides to 30x30, no drag; the in-track acceleration is solved for.
//
//   1. the node converges and emits one $OCM: FIT_STATISTICS FIT_RMS_KM below 5 m, OD_OBSERVATIONS_USED (and FIT_STATES)
//      equal to the fixture's normal points (every LASER_RANGE row of the $TDM records the source reads from it);
//   2. its state at 2026-07-15T15:00 is within 20 m of NSGF's; FIT_RMS, OD_OBSERVATIONS_USED and the end state's distance
//      from NSGF equal (within 0.5 mm) the answers recorded from the dists before the low-sphere convergence change
//      (tests/fixtures/laser-od-recorded.json);
//   3. PROVENANCE SOURCE_KIND Observation, ORIGINATOR ILRS; no USER_DEFINED_PARAMETERS;
//   4. refusals by name: no-stations, arc-too-short:<hours>, no-convergence:<iterations>;
//   5. a window 0.2.0 did not fit (no-convergence:20 at the registered cutoff 2026-07-20 of
//      experiments-ap-observations-laser-20261104): Starlette's normal points of 2026-07-18T00:00 to 2026-07-20T00:00, the
//      same station solution, C04 rows of 2026-07-16 to 2026-07-25, NSGF's 2026-07-18T00:00 state of
//      nsgf.orb.starlette.260720.v000 (SHA-256 6b7f833ab31f4466ce068f12d14c9b79bd72942675a5c0e85d91ce84c4385e2e) rounded
//      to 100 m and 0.1 m/s, Cr*A/m 0.00108 m^2/kg (the run's); the node converges, WEIGHTED_RMS below WRMS_BOUND and its
//      2026-07-20T00:00 state within END_BOUND_M of NSGF's (nsgf.orb.starlette.260724.v000, SHA-256
//      d019852e6bc9e6f380824cc14bb61be1112c58eceedf00fa3c1bd6a2ad7c25e4), ITERATIONS reported.
// JS reads files, routes records between the modules by port and compares numbers: no orbit, frame or measurement is
// computed here.
//   cd flows/observation-od && node tests/laser-od.e2e.mjs
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as flatbuffers from 'flatbuffers';
import * as P from 'spacedatastandards.org/lib/js/PRW/main.js';
import { EOP } from 'spacedatastandards.org/lib/js/EOP/main.js';
import { TDM } from 'spacedatastandards.org/lib/js/TDM/main.js';
import { OCM } from 'spacedatastandards.org/lib/js/OCM/main.js';
import { pvnSourceKind } from 'spacedatastandards.org/lib/js/PVN/main.js';
import { createStandaloneHarness } from 'space-data-module-sdk/testing/isomorphic';
import { encodeHttpResponse, encodeModuleConfig } from 'space-data-module-sdk/runtime-contracts';

const here = (p) => new URL(p, import.meta.url);
const modules = (p) => new URL(`../../../${p}`, import.meta.url);
const failures = [];
const check = (ok, label) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failures.push(label); };
const RECORDED = JSON.parse(fs.readFileSync(here('fixtures/laser-od-recorded.json'), 'utf8'));
// Case 5 measured WEIGHTED_RMS 3.078 and its end state 1.414 m from NSGF (0.3.0); the bounds add 0.4 and double the 1.4 m.
const WRMS_BOUND = 3.5, END_BOUND_M = 3;

const T = (schemaName, fileIdentifier, rootTypeName) => ({ schemaName, fileIdentifier, rootTypeName, wireFormat: 'flatbuffer' });
const HRSP = T('HttpResponse.fbs', 'HRSP', 'HttpResponse'), MCFG = T('ModuleConfig.fbs', 'MCFG', 'ModuleConfig');
const PRW = T('PRW.fbs', '$PRW', 'PRW'), EST = T('Estimation.fbs', '$EST', 'EstimationEnvelope');
const TDM_T = T('TDM.fbs', '$TDM', 'TDM'), GST_T = T('GST.fbs', '$GST', 'GST');

const harness = (p, threads = false) => createStandaloneHarness('browser', modules(p), { surface: 'direct', ...(threads ? { enableThreads: true } : {}) });
const [crd, sinex, eopParser, estimation, ffm, node] = await Promise.all([
  harness('data-source/ilrs-crd-source/dist/isomorphic/module.wasm'), harness('data-source/ilrs-station-coordinates/dist/isomorphic/module.wasm'),
  harness('data-source/eop-parser/dist/isomorphic/module.wasm'), harness('analysis/estimation/dist/isomorphic/module.wasm'),
  harness('propagator/ffm/dist/isomorphic/module.wasm', true), harness('flows/observation-od/dist/isomorphic/module.wasm')]);
const invoke = async (h, methodId, inputs) => {
  const r = await h.invoke({ methodId, inputs });
  if (r.statusCode !== 0) return { error: `${r.errorCode ?? ''}: ${r.errorMessage ?? ''}` };
  return r;
};
const out = (r, port) => r.outputs.filter((o) => o.portId === port).map((o) => new Uint8Array(o.payload));
const http = (url, file, retrieved) => ({ portId: 'source', typeRef: HRSP,
  payload: encodeHttpResponse({ url, status: 200, error: '', headers: { 'content-type': 'text/plain' }, body: new Uint8Array(fs.readFileSync(file)), retrievedMs: Date.parse(retrieved) }) });

// The sources.
const passes = await invoke(crd, 'read_crd', [http('https://edc.dgfi.tum.de/pub/slr/data/npt_crd_v2/starlette/2026/starlette_202607.np2',
  here('fixtures/starlette-20260713T15-20260715T15.np2'), '2026-10-09T22:48:51.721Z')]);
const sites = await invoke(sinex, 'read_sinex', [http('https://edc.dgfi.tum.de/pub/slr/products/pos+eop/weekly/2026/260718/ilrsa.pos+eop.260718.v90.snx.gz',
  modules('data-source/ilrs-station-coordinates/tests/fixtures/ilrsa.pos+eop.260718.v90.no-matrix.snx'), '2026-10-09T22:37:17.611Z')]);
const c04 = (file) => invoke(eopParser, 'parse_c04', [{ ...http('https://hpiers.obspm.fr/iers/eop/eopc04/eopc04.1962-now', here(file), '2026-10-01T22:15:20.000Z'), portId: 'response' }]);
const eop = await c04('fixtures/eopc04-20260710-20260720.txt');
// Case 5's window.
const passes5 = await invoke(crd, 'read_crd', [http('https://edc.dgfi.tum.de/pub/slr/data/npt_crd_v2/starlette/2026/starlette_202607.np2',
  here('fixtures/starlette-20260718T00-20260720T00.np2'), '2026-10-09T22:48:51.721Z')]);
const eop5 = await c04('fixtures/eopc04-20260716-20260725.txt');
for (const [name, r] of [['read_crd', passes], ['read_sinex', sites], ['parse_c04', eop], ['read_crd (case 5)', passes5], ['parse_c04 (case 5)', eop5]])
  if (r.error) { console.error(`${name}: ${r.error}`); process.exit(1); }
const tdms = out(passes, 'observations'), gsts = out(sites, 'stations');
const laserRanges = (records) => records.reduce((n, b) => n + TDM.getRootAsTDM(new flatbuffers.ByteBuffer(b)).unpack().SEGMENTS
  .reduce((m, s) => m + s.OBSERVATIONS.filter((o) => o.KEYWORD === 'LASER_RANGE').length, 0), 0);
const normalPoints = laserRanges(tdms);
console.log(`fixture: ${tdms.length} passes, ${normalPoints} normal points; ${gsts.length} stations`);

const table = (name, fields = {}) => Object.assign(new P[`${name}T`](), fields);
const prw = (arm, value) => {
  const b = new flatbuffers.Builder(1 << 16);
  P.PRW.finishSizePrefixedPRWBuffer(b, table('PRW', { [arm]: value }).pack(b));
  return b.asUint8Array().slice();
};
// parse_c04's size-prefixed $EOP rows as propagator/ffm's EARTH_ORIENTATION record.
const orientationOf = (parsed) => {
  const rows = [];
  for (const buf = Buffer.from(out(parsed, 'records')[0]), at = { i: 0 }; at.i < buf.length;) {
    const n = buf.readUInt32LE(at.i);
    rows.push(EOP.getRootAsEOP(new flatbuffers.ByteBuffer(Uint8Array.from(buf.subarray(at.i + 4, at.i + 4 + n)))).unpack());
    at.i += 4 + n;
  }
  return prw('EARTH_ORIENTATION', table('PRWEarthOrientation', { ROWS: rows }));
};
const earthOrientation = orientationOf(eop);
const kernelBytes = fs.readFileSync(modules('files/orbit-products/tests/fixtures/de440/de440-2026.bsp'));
const kernel = prw('NATIVE_INPUT', table('PRWNativeInput', {
  DESCRIPTOR: table('NCD', { FORMAT: P.ncdContainerFormat.SPK_DAF, SOURCE_BYTE_LENGTH: BigInt(kernelBytes.length), SOURCE_SHA256: createHash('sha256').update(kernelBytes).digest('hex') }),
  CONTENT: kernelBytes }));

const GUESS = { epoch: '2026-07-13T15:00:00.000000Z', state: [7307.9, 922.3, 1088.3, -1.4950, 4.5836, 5.4323] };
const TRUTH = { epoch: '2026-07-15T15:00:00.000000Z', state: [-2564.467504998497, -4266.722374653467, -5414.627287901913, 6.790643111584254, -2.3068038476204733, -1.60360144034126] };
const instant = (iso) => table('TIMInstant', { TIME_SYSTEM: P.timingStandard.UTC, EPOCH_FORMAT: P.timEpochRepresentation.ISO8601, ISO8601: iso });
const vector = (v) => table('FRMVector3', { X: v[0], Y: v[1], Z: v[2] });
const execution = (target = TRUTH.epoch, guess = GUESS, crAm = 0.00115) => prw('EXECUTION_REQUEST', table('PRWExecutionRequest', {
  INITIAL: table('PRWResidentState', {
    STATE: table('FRMStateVector', { REPRESENTATION: P.frmStateRepresentation.CARTESIAN, POSITION: vector(guess.state.slice(0, 3).map((x) => x * 1000)),
      VELOCITY: vector(guess.state.slice(3).map((x) => x * 1000)), COORDINATE_SYSTEM_NAME: 'GCRF', EPOCH: guess.epoch, EPOCH_TIME_SYSTEM: 'UTC' }),
    COORDINATE_SYSTEM: table('RFMCoordinateSystem', { NAME: 'GCRF', AXIS_TYPE: P.rfmAxisType.ICRF, AXIS_REFERENCE_BODY_ID: 399,
      ORIGIN: table('RFMOrigin', { KIND: P.rfmOriginKind.CELESTIAL_BODY, CELESTIAL_BODY_ID: 399 }) }),
    CATALOG_NUMBER: 7646, OBJECT_ID: '1975-010A', VALID: true }),
  TARGET_EPOCH: instant(target),
  INTEGRATOR: table('PCFIntegratorSettings', { ALGORITHM: P.pcfIntegratorAlgorithm.RK78, INITIAL_STEP_SECONDS: 30, MINIMUM_STEP_SECONDS: 0.001,
    MAXIMUM_STEP_SECONDS: 120, ABSOLUTE_TOLERANCES: Array(6).fill(1e-10), RELATIVE_TOLERANCE: 1e-13, MAXIMUM_STEPS: 1000000 }),
  FORCES: table('PCFForceModel', {
    GRAVITY_CHOICE: P.pcfGravitySelection.EGM2008, ENABLE_POINT_MASS: true, GRAVITATIONAL_PARAMETER: 3.986004415e14,
    MAXIMUM_DEGREE: 70, HAS_MAXIMUM_DEGREE: true, MAXIMUM_ORDER: 70, HAS_MAXIMUM_ORDER: true,
    ENABLE_THIRD_BODY: true, THIRD_BODY_IDS: [10, 301], EPHEMERIS_SOURCE: 'JPL_SPK',
    ENABLE_SRP: true, RADIATION_PRESSURE_MODEL: P.pcfRadiationPressureFamily.CANNONBALL, REFLECTIVITY_COEFFICIENT: crAm,
    ENABLE_DRAG: false, INITIAL_MASS_KG: 1, AREA_M2: 1, HAS_IN_TRACK_ACCELERATION_M_S2: true, IN_TRACK_ACCELERATION_M_S2: 0,
    SOLID_TIDES: P.pcfSolidTideModel.IERS_2010, RELATIVITY: P.pcfRelativityTerms.IERS_2010,
    OCEAN_TIDES: P.pcfOceanTideModel.FES2004, OCEAN_TIDE_MAXIMUM_DEGREE: 30, OCEAN_TIDE_MAXIMUM_ORDER: 30 }),
  STM_TECHNIQUE: P.prwDerivativeTechnique.ANALYTIC,
  DYNAMIC_PARAMETERS: [P.prwDynamicParameter.IN_TRACK_ACCELERATION],
}));

// The host loop: route the node's one output to the module its port names, and the answer back.
async function run({ observations = tdms, stations = gsts, config = null, target, guess, crAm, earth = earthOrientation } = {}) {
  const fixed = [...observations.map((p) => ({ portId: 'observations', typeRef: TDM_T, payload: p })),
    ...stations.map((p) => ({ portId: 'stations', typeRef: GST_T, payload: p })),
    { portId: 'earth_orientation', typeRef: PRW, payload: earth }, { portId: 'execution', typeRef: PRW, payload: execution(target, guess, crAm) },
    ...(config ? [{ portId: 'config', typeRef: MCFG, payload: encodeModuleConfig(config) }] : [])];
  let sent = null, result = null, samples = null, rounds = 0;
  for (let calls = 0; calls < 200; ++calls) {
    const r = await invoke(node, 'step', [...fixed, ...(sent ? [{ portId: 'estimation', typeRef: EST, payload: sent }] : []),
      ...(result ? [{ portId: 'result', typeRef: EST, payload: result }] : []), ...(samples ? [{ portId: 'samples', typeRef: PRW, payload: samples }] : [])]);
    if (r.error) return { error: r.error, rounds };
    const [ocm] = out(r, 'ocm'), [propagation] = out(r, 'propagation'), [next] = out(r, 'estimation');
    if (ocm) return { ocm, rounds };
    if (propagation) {
      const p = await invoke(ffm, 'invoke', [{ portId: 'request', typeRef: PRW, payload: propagation }, { portId: 'kernel', typeRef: PRW, payload: kernel },
        { portId: 'earth_orientation', typeRef: PRW, payload: earth }]);
      if (p.error) return { error: `propagator/ffm ${p.error}`, rounds };
      samples = out(p, 'response')[0];
      continue;
    }
    sent = next; samples = null;
    const e = await invoke(estimation, 'fit_batch', [{ portId: 'request', typeRef: EST, payload: sent }]);
    if (e.error) return { error: `analysis/estimation ${e.error}`, rounds };
    result = out(e, 'result')[0];
    ++rounds;
  }
  return { error: 'the loop did not end', rounds };
}

console.log('1. the fit');
const started = Date.now();
const fit = await run();
console.log(`  ${fit.error ?? 'converged'} after ${fit.rounds} fit_batch calls, ${((Date.now() - started) / 1000).toFixed(1)} s`);
check(!!fit.ocm, `one $OCM (${fit.error ?? 'emitted'})`);
if (fit.ocm) {
  const record = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(fit.ocm));
  const ocm = record.unpack(), od = ocm.ORBIT_DETERMINATION, stats = od.FIT_STATISTICS;
  const rms = stats.FIT_RMS_KM * 1000;
  console.log(`  FIT_RMS ${rms.toFixed(3)} m over ${stats.FIT_STATES} normal points, ${stats.ITERATIONS} rounds, CONVERGED ${stats.CONVERGED}, ${stats.FIT_START} to ${stats.FIT_STOP}; in-track acceleration and stations: ${od.OD_EST_PARAMETERS.slice(6)} ${od.SENSORS}`);
  check(rms < 5, `FIT_STATISTICS RMS ${rms.toFixed(3)} m below 5 m`);
  check(od.OD_OBSERVATIONS_USED === normalPoints && stats.FIT_STATES === normalPoints, `OD_OBSERVATIONS_USED ${od.OD_OBSERVATIONS_USED} equals the fixture's ${normalPoints}`);
  console.log('2. the state at the arc end against NSGF');
  const dr = Math.hypot(...[0, 1, 2].map((i) => (ocm.STATE_DATA[i] - TRUTH.state[i]) * 1000));
  const dv = Math.hypot(...[3, 4, 5].map((i) => (ocm.STATE_DATA[i] - TRUTH.state[i]) * 1000));
  console.log(`  epoch ${ocm.STATE_EPOCHS[0]}: |dr| ${dr.toFixed(3)} m, |dv| ${(dv * 1000).toFixed(3)} mm/s`);
  check(ocm.STATE_EPOCHS[0].startsWith('2026-07-15T15:00:00') && dr < 20, `end state ${dr.toFixed(3)} m from NSGF (below 20 m)`);
  const answers = { fitRmsM: rms, weightedRms: od.WEIGHTED_RMS, iterations: stats.ITERATIONS, used: od.OD_OBSERVATIONS_USED, endStateM: dr, endSpeedMmS: dv * 1000 };
  console.log(`  answers ${JSON.stringify(answers)}`);
  const before = RECORDED.starlette20260715;
  const same = (a, b) => Math.abs(a - b) < 5e-4;
  check(same(rms, before.fitRmsM) && answers.used === before.used && same(dr, before.endStateM),
    `unchanged against the record of the dists before the convergence change: RMS ${rms.toFixed(3)} m (${before.fitRmsM.toFixed(3)}), ${answers.used} normal points (${before.used}), end state ${dr.toFixed(3)} m (${before.endStateM.toFixed(3)})`);
  console.log('3. provenance');
  check(ocm.PROVENANCE?.SOURCE_KIND === pvnSourceKind.Observation && ocm.PROVENANCE?.ORIGINATOR === 'ILRS', `PVN ${pvnSourceKind[ocm.PROVENANCE?.SOURCE_KIND]} ${ocm.PROVENANCE?.ORIGINATOR}`);
  check(record.userDefinedParametersLength() === 0, 'no USER_DEFINED_PARAMETERS');
  var line = `RMS ${rms.toFixed(3)} m, OD_OBSERVATIONS_USED ${od.OD_OBSERVATIONS_USED} of ${normalPoints}, end state ${dr.toFixed(3)} m from NSGF`;
}

console.log('4. refusals by name');
const refused = async (label, prefix, options) => {
  const r = await run(options);
  console.log(`  ${label}: ${r.error ?? 'ACCEPTED'}`);
  check(r.error?.startsWith(prefix), `${label}: ${prefix}`);
};
await refused('no station coordinates', 'no-stations: ', { stations: [] });
const firstHours = tdms.filter((b) => TDM.getRootAsTDM(new flatbuffers.ByteBuffer(b)).unpack().SEGMENTS[0].OBSERVATIONS[0].EPOCH < '2026-07-13T21');
await refused('the passes of the first six hours', 'arc-too-short:', { observations: firstHours });
await refused('one propagation round', 'no-convergence:1', { config: { maximumIterations: 1 } });

console.log('5. a window 0.2.0 did not fit: Starlette 2026-07-18T00:00 to 2026-07-20T00:00');
const GUESS5 = { epoch: '2026-07-18T00:00:00.000000Z', state: [-6933.9, 436.4, -1937.9, 1.0868, -5.1028, -5.3843] };
const TRUTH5 = { epoch: '2026-07-20T00:00:00.000000Z', state: [3528.2967886536676, 3432.799684892874, 5440.318926643558, -6.073854267039571, 3.9879808472128584, 1.2162786700043338] };
const tdms5 = out(passes5, 'observations'), points5 = laserRanges(tdms5);
const fit5 = await run({ observations: tdms5, target: TRUTH5.epoch, guess: GUESS5, crAm: 0.00108, earth: orientationOf(eop5) });
console.log(`  ${tdms5.length} passes, ${points5} normal points: ${fit5.error ?? 'converged'} after ${fit5.rounds} fit_batch calls`);
check(!!fit5.ocm, `one $OCM (${fit5.error ?? 'emitted'})`);
if (fit5.ocm) {
  const ocm = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(fit5.ocm)).unpack(), od = ocm.ORBIT_DETERMINATION, stats = od.FIT_STATISTICS;
  const dr = Math.hypot(...[0, 1, 2].map((i) => (ocm.STATE_DATA[i] - TRUTH5.state[i]) * 1000));
  console.log(`  WEIGHTED_RMS ${od.WEIGHTED_RMS.toFixed(3)}, FIT_RMS ${(stats.FIT_RMS_KM * 1000).toFixed(3)} m over ${stats.FIT_STATES} of ${points5} normal points, ITERATIONS ${stats.ITERATIONS}; epoch ${ocm.STATE_EPOCHS[0]}, end state ${dr.toFixed(3)} m from NSGF`);
  check(stats.CONVERGED && ocm.STATE_EPOCHS[0].startsWith('2026-07-20T00:00:00') && od.WEIGHTED_RMS < WRMS_BOUND && dr < END_BOUND_M,
    `converged in ${stats.ITERATIONS} iterations: WEIGHTED_RMS ${od.WEIGHTED_RMS.toFixed(3)} below ${WRMS_BOUND}, end state ${dr.toFixed(3)} m below ${END_BOUND_M} m`);
  var line5 = `Starlette 2026-07-20 WEIGHTED_RMS ${od.WEIGHTED_RMS.toFixed(3)}, ${stats.ITERATIONS} iterations, end state ${dr.toFixed(3)} m from NSGF`;
}

await Promise.all([crd, sinex, eopParser, estimation, ffm, node].map((h) => h.destroy?.()));
if (failures.length) { console.log(`\nFAIL ${failures.length}: ${failures.join('; ')}`); process.exit(1); }
console.log(`\nPASS laser-od: ${line}; refusals no-stations, arc-too-short, no-convergence; ${line5}`);
