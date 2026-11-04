#!/usr/bin/env node
// E2E (modules-observation-ap-flow-20261104): flows/observation-ap on the flows/observation-od fixture, through the
// shipped artifacts of data-source/ilrs-crd-source, data-source/ilrs-station-coordinates, data-source/eop-parser,
// flows/observation-od, analysis/estimation, propagator/ffm and propagator/sdn-ap in the SDK's in-process harness.
//
// Inputs (flows/observation-od/tests/fixtures/PROVENANCE.md, read in place): Starlette's normal points of 2026-07-13T15:00
// to 2026-07-15T15:00, the ILRS weekly station solution of 2026-07-18, IERS EOP 20 C04 rows of 2026-07-10 to 07-20, the
// DE440 2026 excerpt. The first guess and the dynamics are those of flows/observation-od's E2E (EGM2008 70x70, the Sun
// and the Moon, cannonball radiation pressure Cr*A/m 0.00115 m^2/kg, IERS 2010 solid tides and relativity, FES2004
// ocean tides to 30x30, no drag; the in-track acceleration solved for).
// sdn-ap fit's $PCF: THEORY AP; FORCES Jacchia 1970 on the theory's flux model (no $SPW rows) with AP's gravity terms,
// tesseral to degree 31 and zonal to 20 (README, "Weather").
//
//   1. exactly one AP $OCM on ap_ocm: MEAN_ELEMENT_THEORY AP, PVN SOURCE_KIND Observation and ORIGINATOR ILRS, no
//      USER_DEFINED_PARAMETERS;
//   2. the normal-point count: the estimate's OD_OBSERVATIONS_USED equals the fixture's (sdn-ap 0.5.1 writes its own
//      fitted-state count on the AP $OCM: neither the $OEM nor the $PVN has an observation count to carry);
//   3. the node fix: the estimate's OD_DYNAMIC_PARAMETERS carries IN_TRACK_ACCELERATION's fitted value, and the carry
//      starts from the estimate;
//   4. the carry: one $OEM, 1441 states at 60 s over the 24 h before the estimate's epoch, UTC, GCRF;
//   5. flight self-consistency: sdn-ap propagate given the AP $OCM alone (and a $PCF OUTPUT on the carry's grid, GCRF)
//      returns states within the $OCM's FIT_STATISTICS RMS of the carried $OEM at its epochs (to 1 um: fit measures in
//      TEME, the flight is compared in GCRF, and the frames' round trip moves the RMS by nanometers);
//   6. a refusal passes through by name: no-stations.
// JS reads files, routes records by port and compares numbers: no orbit, frame or measurement is computed here.
//   cd flows/observation-ap && node tests/laser-ap.e2e.mjs
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as flatbuffers from 'flatbuffers';
import * as P from 'spacedatastandards.org/lib/js/PRW/main.js';
import * as PCF from 'spacedatastandards.org/lib/js/PCF/main.js';
import { EOP } from 'spacedatastandards.org/lib/js/EOP/main.js';
import { TDM } from 'spacedatastandards.org/lib/js/TDM/main.js';
import { OCM } from 'spacedatastandards.org/lib/js/OCM/main.js';
import { OEM } from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import { meanElementSource } from 'spacedatastandards.org/lib/js/OCM/meanElementSource.js';
import { pvnSourceKind } from 'spacedatastandards.org/lib/js/PVN/main.js';
import { createStandaloneHarness } from 'space-data-module-sdk/testing/isomorphic';
import { encodeHttpResponse } from 'space-data-module-sdk/runtime-contracts';
import { observationAp, CARRY } from '../flow.mjs';

const odFixture = (p) => new URL(`../../observation-od/tests/fixtures/${p}`, import.meta.url);
const modules = (p) => new URL(`../../../${p}`, import.meta.url);
const failures = [];
const check = (ok, label) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failures.push(label); };
const HRSP = { schemaName: 'HttpResponse.fbs', fileIdentifier: 'HRSP', rootTypeName: 'HttpResponse', wireFormat: 'flatbuffer' };
const PCF_T = { schemaName: 'PCF.fbs', fileIdentifier: '$PCF', rootTypeName: 'PCF', wireFormat: 'flatbuffer' };
const OCM_T = { schemaName: 'OCM.fbs', fileIdentifier: '$OCM', rootTypeName: 'OCM', wireFormat: 'flatbuffer' };

const harness = (p, threads = false) => createStandaloneHarness('browser', modules(p), { surface: 'direct', ...(threads ? { enableThreads: true } : {}) });
const [crd, sinex, eopParser, estimation, ffm, laserOd, sdnAp] = await Promise.all([
  harness('data-source/ilrs-crd-source/dist/isomorphic/module.wasm'), harness('data-source/ilrs-station-coordinates/dist/isomorphic/module.wasm'),
  harness('data-source/eop-parser/dist/isomorphic/module.wasm'), harness('analysis/estimation/dist/isomorphic/module.wasm'),
  harness('propagator/ffm/dist/isomorphic/module.wasm', true), harness('flows/observation-od/dist/isomorphic/module.wasm'),
  harness('propagator/sdn-ap/dist/isomorphic/module.wasm')]);
const hosts = { laserOd, estimation, ffm, sdnAp };
const source = async (h, methodId, portId, url, file, retrieved) => {
  const r = await h.invoke({ methodId, inputs: [{ portId, typeRef: HRSP, payload: encodeHttpResponse({ url, status: 200, error: '',
    headers: { 'content-type': 'text/plain' }, body: new Uint8Array(fs.readFileSync(file)), retrievedMs: Date.parse(retrieved) }) }] });
  if (r.statusCode !== 0) { console.error(`${methodId}: ${r.errorCode}: ${r.errorMessage}`); process.exit(1); }
  return (port) => r.outputs.filter((o) => o.portId === port).map((o) => new Uint8Array(o.payload));
};

// The sources.
const tdms = (await source(crd, 'read_crd', 'source', 'https://edc.dgfi.tum.de/pub/slr/data/npt_crd_v2/starlette/2026/starlette_202607.np2',
  odFixture('starlette-20260713T15-20260715T15.np2'), '2026-10-09T22:48:51.721Z'))('observations');
const gsts = (await source(sinex, 'read_sinex', 'source', 'https://edc.dgfi.tum.de/pub/slr/products/pos+eop/weekly/2026/260718/ilrsa.pos+eop.260718.v90.snx.gz',
  modules('data-source/ilrs-station-coordinates/tests/fixtures/ilrsa.pos+eop.260718.v90.no-matrix.snx'), '2026-10-09T22:37:17.611Z'))('stations');
const [eopRecords] = (await source(eopParser, 'parse_c04', 'response', 'https://hpiers.obspm.fr/iers/eop/eopc04/eopc04.1962-now',
  odFixture('eopc04-20260710-20260720.txt'), '2026-10-01T22:15:20.000Z'))('records');
const normalPoints = tdms.reduce((n, b) => n + TDM.getRootAsTDM(new flatbuffers.ByteBuffer(b)).unpack().SEGMENTS
  .reduce((m, s) => m + s.OBSERVATIONS.filter((o) => o.KEYWORD === 'LASER_RANGE').length, 0), 0);
console.log(`fixture: ${tdms.length} passes, ${normalPoints} normal points; ${gsts.length} stations`);

const table = (name, fields = {}) => Object.assign(new P[`${name}T`](), fields);
const prw = (arm, value) => {
  const b = new flatbuffers.Builder(1 << 16);
  P.PRW.finishSizePrefixedPRWBuffer(b, table('PRW', { [arm]: value }).pack(b));
  return b.asUint8Array().slice();
};
const eopRows = [];
for (const buf = Buffer.from(eopRecords), at = { i: 0 }; at.i < buf.length;) {
  const n = buf.readUInt32LE(at.i);
  eopRows.push(EOP.getRootAsEOP(new flatbuffers.ByteBuffer(Uint8Array.from(buf.subarray(at.i + 4, at.i + 4 + n)))).unpack());
  at.i += 4 + n;
}
const kernelBytes = fs.readFileSync(modules('files/orbit-products/tests/fixtures/de440/de440-2026.bsp'));
const GUESS = { epoch: '2026-07-13T15:00:00.000000Z', state: [7307.9, 922.3, 1088.3, -1.4950, 4.5836, 5.4323] };
const ARC_END = '2026-07-15T15:00:00.000000Z';
const vector = (v) => table('FRMVector3', { X: v[0], Y: v[1], Z: v[2] });
const execution = prw('EXECUTION_REQUEST', table('PRWExecutionRequest', {
  INITIAL: table('PRWResidentState', {
    STATE: table('FRMStateVector', { REPRESENTATION: P.frmStateRepresentation.CARTESIAN, POSITION: vector(GUESS.state.slice(0, 3).map((x) => x * 1000)),
      VELOCITY: vector(GUESS.state.slice(3).map((x) => x * 1000)), COORDINATE_SYSTEM_NAME: 'GCRF', EPOCH: GUESS.epoch, EPOCH_TIME_SYSTEM: 'UTC' }),
    COORDINATE_SYSTEM: table('RFMCoordinateSystem', { NAME: 'GCRF', AXIS_TYPE: P.rfmAxisType.ICRF, AXIS_REFERENCE_BODY_ID: 399,
      ORIGIN: table('RFMOrigin', { KIND: P.rfmOriginKind.CELESTIAL_BODY, CELESTIAL_BODY_ID: 399 }) }),
    CATALOG_NUMBER: 7646, OBJECT_ID: '1975-010A', VALID: true }),
  TARGET_EPOCH: table('TIMInstant', { TIME_SYSTEM: P.timingStandard.UTC, EPOCH_FORMAT: P.timEpochRepresentation.ISO8601, ISO8601: ARC_END }),
  INTEGRATOR: table('PCFIntegratorSettings', { ALGORITHM: P.pcfIntegratorAlgorithm.RK78, INITIAL_STEP_SECONDS: 30, MINIMUM_STEP_SECONDS: 0.001,
    MAXIMUM_STEP_SECONDS: 120, ABSOLUTE_TOLERANCES: Array(6).fill(1e-10), RELATIVE_TOLERANCE: 1e-13, MAXIMUM_STEPS: 1000000 }),
  FORCES: table('PCFForceModel', {
    GRAVITY_CHOICE: P.pcfGravitySelection.EGM2008, ENABLE_POINT_MASS: true, GRAVITATIONAL_PARAMETER: 3.986004415e14,
    MAXIMUM_DEGREE: 70, HAS_MAXIMUM_DEGREE: true, MAXIMUM_ORDER: 70, HAS_MAXIMUM_ORDER: true,
    ENABLE_THIRD_BODY: true, THIRD_BODY_IDS: [10, 301], EPHEMERIS_SOURCE: 'JPL_SPK',
    ENABLE_SRP: true, RADIATION_PRESSURE_MODEL: P.pcfRadiationPressureFamily.CANNONBALL, REFLECTIVITY_COEFFICIENT: 0.00115,
    ENABLE_DRAG: false, INITIAL_MASS_KG: 1, AREA_M2: 1, HAS_IN_TRACK_ACCELERATION_M_S2: true, IN_TRACK_ACCELERATION_M_S2: 0,
    SOLID_TIDES: P.pcfSolidTideModel.IERS_2010, RELATIVITY: P.pcfRelativityTerms.IERS_2010,
    OCEAN_TIDES: P.pcfOceanTideModel.FES2004, OCEAN_TIDE_MAXIMUM_DEGREE: 30, OCEAN_TIDE_MAXIMUM_ORDER: 30 }),
  STM_TECHNIQUE: P.prwDerivativeTechnique.ANALYTIC,
  DYNAMIC_PARAMETERS: [P.prwDynamicParameter.IN_TRACK_ACCELERATION],
}));
const pcf = (fields) => {
  const b = new flatbuffers.Builder(512);
  b.finish(Object.assign(new PCF.PCFT(), fields).pack(b), '$PCF');
  return b.asUint8Array().slice();
};
// FORCES.ATMOSPHERE_MODEL JACCHIA70 is off the schema's default (NRLMSISE00), so the builder writes it.
const configuration = pcf({ THEORY: PCF.pcfTheory.AP, FORCES: Object.assign(new PCF.PCFForceModelT(), { EPHEMERIS_SOURCE: '',
  ATMOSPHERE_MODEL: PCF.pcfAtmosphereFamily.JACCHIA70, HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 31, HAS_MAXIMUM_DEGREE: true, MAXIMUM_DEGREE: 20 }) });
const ingress = { observations: tdms, stations: gsts, earthOrientation: prw('EARTH_ORIENTATION', table('PRWEarthOrientation', { ROWS: eopRows })),
  kernel: prw('NATIVE_INPUT', table('PRWNativeInput', { DESCRIPTOR: table('NCD', { FORMAT: P.ncdContainerFormat.SPK_DAF,
    SOURCE_BYTE_LENGTH: BigInt(kernelBytes.length), SOURCE_SHA256: createHash('sha256').update(kernelBytes).digest('hex') }), CONTENT: kernelBytes })),
  execution, configuration };

const started = Date.now();
const run = await observationAp(hosts, ingress);
console.log(`flow: ${run.refused ?? 'egress ' + Object.entries(run.egress ?? {}).map(([k, v]) => `${k} ${v.length}`).join(', ')} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
let line = '';
if (!run.refused) {
  const ocmOf = (b) => OCM.getRootAsOCM(new flatbuffers.ByteBuffer(b));
  console.log('1. the AP $OCM');
  check(run.egress.ap_ocm.length === 1, `ap_ocm carries ${run.egress.ap_ocm.length} $OCM`);
  const apRecord = ocmOf(run.egress.ap_ocm[0]), ap = apRecord.unpack(), stats = ap.ORBIT_DETERMINATION.FIT_STATISTICS;
  console.log(`  ${meanElementSource[ap.MEAN_ELEMENTS?.MEAN_ELEMENT_THEORY]} epoch ${ap.MEAN_ELEMENTS?.EPOCH}, BTERM ${ap.MEAN_ELEMENTS?.BTERM}, AGOM ${ap.MEAN_ELEMENTS?.AGOM}; ` +
    `FIT_RMS ${(stats.FIT_RMS_KM * 1000).toFixed(3)} m over ${stats.FIT_STATES} states, ${stats.FIT_START} to ${stats.FIT_STOP}, CONVERGED ${stats.CONVERGED}`);
  check(meanElementSource[ap.MEAN_ELEMENTS?.MEAN_ELEMENT_THEORY] === 'AP', `MEAN_ELEMENT_THEORY ${meanElementSource[ap.MEAN_ELEMENTS?.MEAN_ELEMENT_THEORY]}`);
  check(ap.PROVENANCE?.SOURCE_KIND === pvnSourceKind.Observation && ap.PROVENANCE?.ORIGINATOR === 'ILRS',
    `PVN ${pvnSourceKind[ap.PROVENANCE?.SOURCE_KIND]} ${ap.PROVENANCE?.ORIGINATOR} (${ap.PROVENANCE?.SOURCE_ID}, ${ap.PROVENANCE?.PRODUCER})`);
  check(apRecord.userDefinedParametersLength() === 0, 'AP $OCM: no USER_DEFINED_PARAMETERS');

  console.log('2. the normal-point count');
  const estRecord = ocmOf(run.egress.estimate[0]), est = estRecord.unpack(), od = est.ORBIT_DETERMINATION;
  check(od.OD_OBSERVATIONS_USED === normalPoints, `estimate OD_OBSERVATIONS_USED ${od.OD_OBSERVATIONS_USED} equals the fixture's ${normalPoints} ` +
    `(AP $OCM: ${ap.ORBIT_DETERMINATION.OD_OBSERVATIONS_USED}, its FIT_STATES ${stats.FIT_STATES})`);
  check(estRecord.userDefinedParametersLength() === 0, 'estimate: no USER_DEFINED_PARAMETERS');

  console.log('3. the node fix: the fitted in-track acceleration');
  const accel = od.OD_DYNAMIC_PARAMETERS.find((p) => p.PARAMETER === P.prwDynamicParameter.IN_TRACK_ACCELERATION);
  console.log(`  OD_DYNAMIC_PARAMETERS ${od.OD_DYNAMIC_PARAMETERS.map((p) => `${p.NAME} ${p.VALUE} ${p.UNITS} SOLVED_FOR ${p.SOLVED_FOR}`).join('; ')}`);
  check(od.OD_DYNAMIC_PARAMETERS.length === 1 && accel?.SOLVED_FOR === true && accel.UNITS === 'm/s**2' && Number.isFinite(accel.VALUE) && accel.VALUE !== 0,
    `IN_TRACK_ACCELERATION ${accel?.VALUE} m/s^2, solved for`);

  console.log('4. the carry');
  const oem = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(run.egress.ephemeris[0])).unpack();
  const block = oem.EPHEMERIS_DATA_BLOCK[0], lines = block.EPHEMERIS_DATA_LINES;
  console.log(`  ${lines.length} states, ${lines[0].EPOCH} to ${lines.at(-1).EPOCH}, ${block.REFERENCE_FRAME.NAME}, ${P.timingStandard[block.TIME_SYSTEM]}`);
  const seconds = (iso) => Date.parse(iso.replace(/(\.\d{3})\d*/, '$1').replace(/Z?$/, 'Z')) / 1000;
  const onGrid = lines.every((l, k) => seconds(l.EPOCH) === seconds(est.STATE_EPOCHS[0]) - CARRY.hours * 3600 + CARRY.stepSeconds * k);
  check(oem.EPHEMERIS_DATA_BLOCK.length === 1 && lines.length === 1441 && onGrid && block.REFERENCE_FRAME.NAME === 'GCRF' && block.TIME_SYSTEM === P.timingStandard.UTC,
    `${lines.length} states on the 60 s grid of the 24 h before ${est.STATE_EPOCHS[0]}: ${onGrid}`);
  const end = lines.at(-1), endGap = 1000 * Math.hypot(end.X - est.STATE_DATA[0], end.Y - est.STATE_DATA[1], end.Z - est.STATE_DATA[2]);
  check(endGap < 1e-3, `the carry ends on the estimate: ${endGap.toExponential(2)} m`);

  console.log('5. flight self-consistency');
  const flown = await sdnAp.invoke({ methodId: 'propagate', inputs: [{ portId: 'ocm', typeRef: OCM_T, payload: run.egress.ap_ocm[0] },
    { portId: 'configuration', typeRef: PCF_T, payload: pcf({ OUTPUT: Object.assign(new PCF.PCFOutputT(), { FRAME: PCF.pcfOutputFrame.GCRF,
      START_TIME: lines[0].EPOCH, STOP_TIME: end.EPOCH, STEP_SECONDS: CARRY.stepSeconds }) }) }] });
  check(flown.statusCode === 0, `propagate: ${flown.errorCode ?? ''} ${flown.errorMessage ?? ''}`);
  if (flown.statusCode === 0) {
    const fb = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(flown.outputs.find((o) => o.portId === 'ephemeris').payload))).unpack().EPHEMERIS_DATA_BLOCK[0];
    const states = fb.EPHEMERIS_DATA_LINES, aligned = states.length === lines.length && states.every((s, k) => seconds(s.EPOCH) === seconds(lines[k].EPOCH));
    const dr = lines.map((l, k) => Math.hypot(states[k].X - l.X, states[k].Y - l.Y, states[k].Z - l.Z));
    const rms = Math.sqrt(dr.reduce((a, d) => a + d * d, 0) / dr.length), largest = Math.max(...dr);
    console.log(`  ${states.length} states, ${fb.REFERENCE_FRAME?.NAME}: RMS ${(rms * 1000).toFixed(3)} m, largest ${(largest * 1000).toFixed(3)} m against FIT_RMS ${(stats.FIT_RMS_KM * 1000).toFixed(3)} m (difference ${((rms - stats.FIT_RMS_KM) * 1e6).toExponential(2)} mm)`);
    check(aligned && fb.REFERENCE_FRAME?.NAME === 'GCRF' && rms <= stats.FIT_RMS_KM + 1e-9, `day 1: RMS ${(rms * 1000).toFixed(3)} m within FIT_RMS ${(stats.FIT_RMS_KM * 1000).toFixed(3)} m (to 1 um)`);
    line = `AP $OCM FIT_RMS ${(stats.FIT_RMS_KM * 1000).toFixed(3)} m over ${stats.FIT_STATES} states; flown alone, day-1 RMS ${(rms * 1000).toFixed(3)} m against the carry; ` +
      `estimate OD_OBSERVATIONS_USED ${od.OD_OBSERVATIONS_USED}, IN_TRACK_ACCELERATION ${accel?.VALUE?.toExponential(3)} m/s^2`;
  }
}
check(!run.refused, `the flow: ${run.refused ?? 'emitted'}`);

console.log('6. a refusal passes through by name');
const noStations = await observationAp(hosts, { ...ingress, stations: [] });
console.log(`  no station coordinates: ${noStations.refused ?? 'ACCEPTED'}`);
check(noStations.refused?.startsWith('no-stations: '), 'no station coordinates: no-stations');

await Promise.all([crd, sinex, eopParser, estimation, ffm, laserOd, sdnAp].map((h) => h.destroy?.()));
if (failures.length) { console.log(`\nFAIL ${failures.length}: ${failures.join('; ')}`); process.exit(1); }
console.log(`\nPASS laser-ap: ${line}; refusal no-stations passes through`);
