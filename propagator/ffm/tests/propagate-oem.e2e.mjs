#!/usr/bin/env node
// E2E (modules-ffm-prw-to-oem-20261104): propagate_oem writes the execution's states at the $PCF OUTPUT epochs as one $OEM,
// on the shipped artifact in the browser lane and in native WasmEdge, and sdn-ap fit accepts that $OEM.
//
// The state: Starlette (NORAD 7646, 1975-010A) at 2026-07-15T00:00:00Z, GCRF, from the archive's NSGF orbit of 2026-07-16,
// /opt/data/sdn-archive/reference-states/reference/nsgf.orb.starlette.260716.v000/7646.oem (SHA-256
// 8f50e071ddb14a1f3c799d5905f36632713454700f052ffdefe64014c97a88c9), the ITRF-to-GCRF conversion (IAU 2006/2000A, IERS EOP C04)
// of nsgf.orb.starlette.260716.v000.sp3.gz (SHA-256 04c455896907663d0603d975216b5f3428752529c5f8be3f664f4a59c28914e9,
// https://edc.dgfi.tum.de/pub/slr/products/orbits/rapid/starlette/2026/260716/), its line at that epoch as recorded there.
// The forces: zonal EGM2008 to degree 20, the Sun and the Moon from the DE440 2026 excerpt, cannonball radiation pressure with
// Cr*A/m 0.00115 m^2/kg (Cr 1.2, 0.0452 m^2, 47.3 kg; stated, not fitted). Nothing here integrates or rotates: JS builds
// records, reads results and subtracts.
//
//   1. the $OEM over 24 h at 60 s: 1441 states, UTC, GCRF, EARTH, the object, epochs on the grid;
//   2. its states equal invoke's $PRW samples at the same epochs to 1 mm and 1 mm/s;
//   3. refusals by name: output-unspecified (a $PCF without OUTPUT; OUTPUT without times), frame-unsupported:TEME,
//      time-system-not-utc;
//   4. lane parity: identical $OEM bytes;
//   5. sdn-ap fit accepts the $OEM under an explicit $PCF (ATMOSPHERE_MODEL JACCHIA70) and returns an $OCM.
//
//   cd propagator/ffm && node tests/propagate-oem.e2e.mjs
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as flatbuffers from 'flatbuffers';
import { createStandaloneHarness } from 'space-data-module-sdk/testing/isomorphic';
import * as PCF from 'spacedatastandards.org/lib/js/PCF/main.js';
import { OEM } from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import { OCM } from 'spacedatastandards.org/lib/js/OCM/OCM.js';
import { meanElementSource } from 'spacedatastandards.org/lib/js/OCM/meanElementSource.js';
import { fullForceRequest, kernelRecord, TYPE } from '../catalog.mjs';
import { decodePrw, encodePrw, makeTable, sds } from './lib/prwCodec.mjs';
import { destroyLanes, lane } from './lib/planetary.mjs';

process.env.PATH = `${process.env.HOME}/.wasmedge/bin:${process.env.PATH}`;
const failures = [];
const check = (ok, message) => { if (!ok) { failures.push(message); console.log(`FAIL ${message}`); } };

const EPOCH = '2026-07-15T00:00:00.000000Z';
const STARLETTE = [7179.932303371676, 822.6281719168568, 1768.5430149203548, -1.9393011990907008, 4.636687490476775, 5.250833808350666];
const KERNEL = fs.readFileSync(new URL('../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp', import.meta.url));
const SDN_AP = new URL('../../sdn-ap/dist/isomorphic/module.wasm', import.meta.url);

const request = () => {
  const r = fullForceRequest({ epoch: EPOCH, state: STARLETTE.map((x) => x * 1000), forces: {
    MAXIMUM_DEGREE: 20, MAXIMUM_ORDER: 0, THIRD_BODY_IDS: [10, 301], ENABLE_DRAG: false, REFLECTIVITY_COEFFICIENT: 0.00115,
    SOLID_TIDES: sds.pcfSolidTideModel.NONE, RELATIVITY: sds.pcfRelativityTerms.NONE,
    EARTH_RADIATION: sds.pcfEarthRadiationModel.NONE, OCEAN_TIDES: sds.pcfOceanTideModel.NONE } });
  r.STM_TECHNIQUE = sds.prwDerivativeTechnique.ANALYTIC; r.DENSITY_TREATMENT = sds.prwDensityTreatment.NEGLECTED;
  r.INITIAL.CATALOG_NUMBER = 7646; r.INITIAL.OBJECT_ID = '1975-010A'; r.INITIAL.VALID = true;
  return r;
};
const PCF_TYPE = { schemaName: 'PCF.fbs', fileIdentifier: '$PCF', rootTypeName: 'PCF', wireFormat: 'flatbuffer' };
const pcf = (output, extra = {}) => {
  const c = Object.assign(new PCF.PCFT(), extra);
  if (output) c.OUTPUT = Object.assign(new PCF.PCFOutputT(), output);
  const b = new flatbuffers.Builder(512);
  b.finish(c.pack(b), '$PCF');
  return { portId: 'configuration', typeRef: PCF_TYPE, payload: b.asUint8Array().slice() };
};
const GRID = { FRAME: PCF.pcfOutputFrame.GCRF, START_TIME: EPOCH, STOP_TIME: '2026-07-16T00:00:00Z', STEP_SECONDS: 60 };
const inputs = (exec, configuration) => [{ portId: 'request', typeRef: TYPE, payload: encodePrw('EXECUTION_REQUEST', exec) },
  { portId: 'kernel', typeRef: TYPE, payload: kernelRecord(KERNEL) }, ...(configuration ? [configuration] : [])];
const propagateOem = async (kind, configuration, exec = request()) => {
  const r = await (await lane(kind)).invoke({ methodId: 'propagate_oem', inputs: inputs(exec, configuration) }).catch((e) => e);
  if (r.statusCode !== 0) return { error: `${r.errorCode ?? ''}: ${r.errorMessage ?? ''}` };
  const bytes = new Uint8Array(r.outputs.find((o) => o.portId === 'ephemeris').payload);
  return { bytes, oem: OEM.getRootAsOEM(new flatbuffers.ByteBuffer(bytes)).unpack() };
};
const refused = async (kind, label, code, configuration, exec) => {
  const o = await propagateOem(kind, configuration, exec);
  console.log(`  ${label}: ${o.error ?? 'ACCEPTED'}`);
  check(o.error?.startsWith(`${code}: `), `${label}: ${o.error ?? 'accepted'}`);
};

const digests = [];
let carried = null;
for (const kind of ['browser', 'wasmedge']) {
  console.log(`\n== ${kind} ==`);
  console.log('1. the $OEM over 24 h at 60 s');
  const o = await propagateOem(kind, pcf(GRID));
  check(!o.error, `propagate_oem: ${o.error}`);
  if (o.error) continue;
  digests.push(createHash('sha256').update(o.bytes).digest('hex'));
  carried ??= o.bytes;
  const block = o.oem.EPHEMERIS_DATA_BLOCK[0], lines = block.EPHEMERIS_DATA_LINES;
  const seconds = (iso) => Date.parse(iso.replace(/(\.\d{3})\d*/, '$1').replace(/Z?$/, 'Z')) / 1000;
  const onGrid = lines.every((l, k) => seconds(l.EPOCH) === seconds(EPOCH) + 60 * k);
  console.log(`  ${lines.length} states, ${block.START_TIME} to ${block.STOP_TIME}, ${sds.timingStandard[block.TIME_SYSTEM]}, ${block.REFERENCE_FRAME.NAME}, ${block.CENTER_NAME}, NORAD ${block.OBJECT?.NORAD_CAT_ID} ${block.OBJECT?.OBJECT_ID}`);
  check(o.oem.EPHEMERIS_DATA_BLOCK.length === 1 && lines.length === 1441 && onGrid, `${lines.length} states, on the grid ${onGrid}`);
  check(block.TIME_SYSTEM === sds.timingStandard.UTC && block.REFERENCE_FRAME.NAME === 'GCRF' && block.CENTER_NAME === 'EARTH' &&
    block.OBJECT?.NORAD_CAT_ID === 7646 && block.OBJECT?.OBJECT_ID === '1975-010A', 'block metadata');
  const first = [lines[0].X, lines[0].Y, lines[0].Z, lines[0].X_DOT, lines[0].Y_DOT, lines[0].Z_DOT];
  check(first.every((x, i) => Math.abs(x - STARLETTE[i]) < 1e-9), `first state ${first} against the fixture`);

  console.log('2. the $OEM states against invoke\'s $PRW samples at the same epochs');
  const exec = request();
  exec.SAMPLE_EPOCHS = lines.map((l) => makeTable('TIMInstant', { TIME_SYSTEM: sds.timingStandard.UTC, EPOCH_FORMAT: sds.timEpochRepresentation.ISO8601, ISO8601: l.EPOCH }));
  exec.TARGET_EPOCH = exec.SAMPLE_EPOCHS.at(-1);
  const r = await (await lane(kind)).invoke({ methodId: 'invoke', inputs: inputs(exec) });
  check(r.statusCode === 0, `invoke: ${r.errorCode} ${r.errorMessage}`);
  if (r.statusCode === 0) {
    const samples = decodePrw(r.outputs.find((x) => x.portId === 'response').payload).EXECUTION_RESULT.SAMPLES;
    let dr = 0, dv = 0;
    samples.forEach((s, k) => {
      const p = s.STATE.STATE.POSITION, v = s.STATE.STATE.VELOCITY, l = lines[k];
      dr = Math.max(dr, 1000 * Math.hypot(p.X / 1000 - l.X, p.Y / 1000 - l.Y, p.Z / 1000 - l.Z));
      dv = Math.max(dv, 1000 * Math.hypot(v.X / 1000 - l.X_DOT, v.Y / 1000 - l.Y_DOT, v.Z / 1000 - l.Z_DOT));
    });
    const moved = 1000 * Math.hypot(lines.at(-1).X - STARLETTE[0], lines.at(-1).Y - STARLETTE[1], lines.at(-1).Z - STARLETTE[2]);
    console.log(`  ${samples.length} samples: largest |dr| ${dr.toExponential(2)} m, |dv| ${dv.toExponential(2)} m/s (the carried state moved ${(moved / 1000).toFixed(1)} km)`);
    check(samples.length === lines.length && dr <= 1e-3 && dv <= 1e-3, `OEM against PRW: ${samples.length} samples, ${dr} m, ${dv} m/s`);
  }

  console.log('3. refusals by name');
  await refused(kind, 'a $PCF without OUTPUT', 'output-unspecified', pcf(null));
  await refused(kind, 'OUTPUT without times', 'output-unspecified', pcf({ FRAME: PCF.pcfOutputFrame.GCRF }));
  await refused(kind, 'FRAME TEME', 'frame-unsupported:TEME', pcf({ ...GRID, FRAME: PCF.pcfOutputFrame.TEME }));
  await refused(kind, 'START_TIME on TDB', 'time-system-not-utc', pcf({ ...GRID, START_TIME: '2026-07-15T00:00:00 TDB' }));
}

console.log('\n4. lane parity');
console.log(`  ${digests.map((d) => d.slice(0, 16)).join(' ')}`);
check(digests.length === 2 && digests[0] === digests[1], 'the lanes\' $OEM bytes differ');

console.log('\n5. sdn-ap fit accepts the $OEM');
if (carried) {
  const ap = await createStandaloneHarness('browser', SDN_AP, { surface: 'direct' });
  const forces = new PCF.PCFForceModelT(); forces.ATMOSPHERE_MODEL = PCF.pcfAtmosphereFamily.JACCHIA70; forces.EPHEMERIS_SOURCE = '';
  const r = await ap.invoke({ methodId: 'fit', inputs: [{ portId: 'ephemeris', typeRef: { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM' }, payload: carried },
    pcf(null, { FORCES: forces })] });
  check(r.statusCode === 0, `fit: ${r.errorCode} ${r.errorMessage}`);
  if (r.statusCode === 0) {
    const out = r.outputs.find((x) => x.portId === 'elements');
    const ocm = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(new Uint8Array(out.payload))).unpack();
    const fit = ocm.ORBIT_DETERMINATION?.FIT_STATISTICS;
    console.log(`  $OCM: ${meanElementSource[ocm.MEAN_ELEMENTS?.MEAN_ELEMENT_THEORY]}, NORAD ${ocm.METADATA?.NORAD_CAT_ID}, epoch ${ocm.MEAN_ELEMENTS?.EPOCH}, fit RMS ${fit?.FIT_RMS_KM?.toFixed(3)} km over ${fit?.FIT_START} to ${fit?.FIT_STOP}`);
    check(String.fromCharCode(...new Uint8Array(out.payload).slice(4, 8)) === '$OCM' && !!ocm.MEAN_ELEMENTS, 'fit returned no $OCM with MEAN_ELEMENTS');
  }
  await ap.destroy?.();
}

await destroyLanes();
if (failures.length) { console.log(`\nFAIL ${failures.length}`); process.exit(1); }
console.log('\nPASS propagate_oem: 1441 states over 24 h at 60 s equal invoke\'s $PRW to 1 mm; refusals by name; lanes identical; sdn-ap fit returns an $OCM');
