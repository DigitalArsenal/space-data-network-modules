// Test plumbing for the OD HPOP module: loading the module and propagator/hpop
// (an independent artifact that generates the truth ephemerides), the
// environment records, and the OEM KVN text the fit reads. Framing only:
// every state comes from a WASM module.
import fs from 'node:fs';
import * as flatbuffers from 'flatbuffers';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { sds, makeTable, encodePrw, decodePrw, nativeInput, execution } from '../../../../../propagator/hpop/tests/lib/prwCodec.mjs';

const here = new URL('../../', import.meta.url);
const repo = new URL('../../../', here);
export const MU = 3.986004415e14;
export const RE = 6378137.0;

export async function loadFit() {
  return createBrowserModuleHarness({
    wasmSource: fs.readFileSync(new URL('dist/isomorphic/module.wasm', here)),
    manifest: JSON.parse(fs.readFileSync(new URL('plugin-manifest.json', here), 'utf8')),
    surface: 'direct',
  });
}

export async function loadHpop() {
  const dir = new URL('propagator/hpop/', repo);
  return createBrowserModuleHarness({
    wasmSource: fs.readFileSync(new URL('dist/isomorphic/module.wasm', dir)),
    manifest: JSON.parse(fs.readFileSync(new URL('plugin-manifest.json', dir), 'utf8')),
    surface: 'direct',
  });
}

const PRW_TYPE = Object.freeze({ schemaName: 'PRW.fbs', fileIdentifier: '$PRW', rootTypeName: 'PRW', wireFormat: 'flatbuffer' });
const fixture = (name) => fs.readFileSync(new URL(`tests/fixtures/environment-2026-07/${name}`, here));
const kernelBytes = () => fs.readFileSync(new URL('files/orbit-products/tests/fixtures/de440/de440-2026.bsp', repo));

// The environment inputs (2026-06-28 .. 2026-07-20), for either module.
export function environment({ drag = true, jb2008 = false } = {}) {
  const inputs = [
    { portId: 'earth_orientation', typeRef: PRW_TYPE, payload: fixture('earth_orientation.prw') },
    { portId: 'kernel', typeRef: PRW_TYPE, payload: nativeInput(kernelBytes()) },
  ];
  if (drag && !jb2008) inputs.push({ portId: 'space_weather', typeRef: PRW_TYPE, payload: fixture('space_weather.prw') });
  if (drag && jb2008) inputs.push({ portId: 'jb2008_indices', typeRef: PRW_TYPE, payload: fixture('jb2008_indices.prw') });
  return inputs;
}

// ISO UTC with millisecond-exact arithmetic (steps are whole milliseconds).
export const isoAt = (startMs, seconds) => new Date(startMs + Math.round(seconds * 1000)).toISOString().replace('Z', '');

// Kepler elements (m, rad) to a GCRF state (m, m/s).
export function stateOf({ a, e, i, raan, argp, nu }) {
  const p = a * (1 - e * e), r = p / (1 + e * Math.cos(nu)), h = Math.sqrt(MU / p);
  const rp = [r * Math.cos(nu), r * Math.sin(nu), 0], vp = [-h * Math.sin(nu), h * (e + Math.cos(nu)), 0];
  const cO = Math.cos(raan), sO = Math.sin(raan), cw = Math.cos(argp), sw = Math.sin(argp), ci = Math.cos(i), si = Math.sin(i);
  const R = [[cO * cw - sO * sw * ci, -cO * sw - sO * cw * ci], [sO * cw + cO * sw * ci, -sO * sw + cO * cw * ci], [sw * si, cw * si]];
  return [0, 1, 2].map((k) => R[k][0] * rp[0] + R[k][1] * rp[1]).concat([0, 1, 2].map((k) => R[k][0] * vp[0] + R[k][1] * vp[1]));
}

// The OD module's step rule, halved: the truth integrates finer than the fit.
export function truthStep(state, degree = 70) {
  const r = Math.hypot(...state.slice(0, 3)), v2 = state[3] ** 2 + state[4] ** 2 + state[5] ** 2;
  const a = 1 / (2 / r - v2 / MU);
  const h = Math.hypot(state[1] * state[5] - state[2] * state[4], state[2] * state[3] - state[0] * state[5], state[0] * state[4] - state[1] * state[3]);
  const e = Math.sqrt(Math.max(0, 1 - (h * h) / (MU * a)));
  const rp = a * (1 - e);
  return Math.min(300, Math.max(1, (2 * Math.PI * (rp / (h / rp))) / (3 * degree))) / 2;
}

const ECOM2 = ['D0_M_S2', 'Y0_M_S2', 'B0_M_S2', 'D2_COS_M_S2', 'D2_SIN_M_S2', 'D4_COS_M_S2', 'D4_SIN_M_S2', 'B1_COS_M_S2', 'B1_SIN_M_S2', 'B3_COS_M_S2', 'B3_SIN_M_S2'];

// Truth states (m, m/s, GCRF) at every epoch, every force on, from
// propagator/hpop. `p`: {B, AGOM, inTrack, ecom2: [11]}; drag-regime orbits
// take B and the in-track term, the others ECOM2. Requests restart at every
// 3-hour UTC boundary when drag is on (the space-weather breakpoints).
export async function hpopTruth(hpop, { epochIso, state, p, drag, jb2008 = false, epochs }) {
  const startMs = Date.parse(`${epochIso}Z`);
  const offsets = epochs.map((iso) => (Date.parse(`${iso}Z`) - startMs) / 1000);
  const stops = [];
  if (drag) {
    const since = (startMs % 86400000) / 1000;
    for (let t = Math.ceil(since / 10800) * 10800 - since; t < offsets.at(-1); t += 10800) if (t > 0) stops.push(t);
  }
  const all = [...new Set([...offsets, ...stops])].sort((x, y) => x - y);
  const step = truthStep(state);
  const out = new Map();
  for (let at = 0; at < all.length; at += 9000) {
    const chunk = all.slice(at, at + 9000);
    const exec = execution({
      epochJD: 2451545, targetJD: 2451545, position: state.slice(0, 3).map((x) => x / 1000), velocity: state.slice(3).map((x) => x / 1000),
      massKg: 1, integrator: { method: 'RK78', tolerance: 1e-14, initialStep: 10, minStep: 1e-3, maxStep: step, maxSteps: 50000000 },
      forces: { mu: MU / 1e9, pointMass: true, j2: false, gravityMode: 'EGM2008', maxDegree: 70, maxOrder: 70, thirdBody: true,
        sun: true, moon: true, venus: true, mars: true, jupiter: true, srp: true, drag, massKg: 1, areaM2: 1,
        cr: p.AGOM ?? 0, cd: p.B ?? 0, dragModel: jb2008 ? 'JB2008' : 'NRLMSISE00' },
      ephemerisSource: 'JPL_SPK', frame: 'GCRF',
    }, true);
    exec.INITIAL.STATE.EPOCH = epochIso;
    exec.INITIAL.STATE.EPOCH_TIME_SYSTEM = 'UTC';
    exec.INITIAL.STATE.POSITION = makeTable('FRMVector3', { X: state[0], Y: state[1], Z: state[2] });
    exec.INITIAL.STATE.VELOCITY = makeTable('FRMVector3', { X: state[3], Y: state[4], Z: state[5] });
    const iso = (t) => makeTable('TIMInstant', { TIME_SYSTEM: sds.timingStandard.UTC, EPOCH_FORMAT: sds.timEpochRepresentation.ISO8601, ISO8601: isoAt(startMs, t) });
    exec.SAMPLE_EPOCHS = chunk.map(iso);
    exec.TARGET_EPOCH = iso(chunk.at(-1));
    Object.assign(exec.FORCES, {
      RELATIVITY: sds.prwRelativityTerms.IERS_2010, SOLID_TIDES: sds.prwSolidTideModel.IERS_2010,
      OCEAN_TIDES: sds.prwOceanTideModel.FES2004, OCEAN_TIDE_MAXIMUM_DEGREE: 30, OCEAN_TIDE_MAXIMUM_ORDER: 30,
      EARTH_RADIATION: sds.prwEarthRadiationModel.KNOCKE, EARTH_RADIATION_RESOLUTION_DEG: 15, WEATHER: null,
    });
    if (p.inTrack !== undefined) Object.assign(exec.FORCES, { IN_TRACK_ACCELERATION_M_S2: p.inTrack, HAS_IN_TRACK_ACCELERATION_M_S2: true });
    if (p.ecom2) exec.FORCES.ECOM2 = makeTable('PRWEcom2', Object.fromEntries(ECOM2.map((k, j) => [k, p.ecom2[j] ?? 0])));
    exec.DENSITY_TREATMENT = sds.prwDensityTreatment.NEGLECTED;
    const response = await hpop.invoke({ methodId: 'invoke', inputs: [{ portId: 'request', typeRef: PRW_TYPE, payload: encodePrw('EXECUTION_REQUEST', exec) }, ...environment({ drag, jb2008 })] });
    if (response.statusCode !== 0) throw new Error(`${response.errorCode}: ${response.errorMessage}`);
    const samples = decodePrw(response.outputs.find((o) => o.portId === 'response').payload).EXECUTION_RESULT.SAMPLES;
    chunk.forEach((t, k) => {
      const s = samples[k].STATE.STATE;
      out.set(t, [s.POSITION.X, s.POSITION.Y, s.POSITION.Z, s.VELOCITY.X, s.VELOCITY.Y, s.VELOCITY.Z]);
    });
  }
  return offsets.map((t) => out.get(t));
}

// A CCSDS OEM KVN (GCRF, UTC, km to 1e-9, km/s to 1e-12).
export function kvn(epochs, states, { frame = 'GCRF', name = 'SYNTH-1', id = '2026-999A' } = {}) {
  const lines = ['CCSDS_OEM_VERS = 2.0', 'CREATION_DATE = 2026-07-01T00:00:00', 'ORIGINATOR = SYNTHETIC TEST', '', 'META_START',
    `OBJECT_NAME = ${name}`, `OBJECT_ID = ${id}`, 'CENTER_NAME = EARTH', `REF_FRAME = ${frame}`, 'TIME_SYSTEM = UTC', 'META_STOP'];
  epochs.forEach((iso, k) => {
    const s = states[k];
    lines.push(`${iso} ${(s[0] / 1e3).toFixed(9)} ${(s[1] / 1e3).toFixed(9)} ${(s[2] / 1e3).toFixed(9)} ${(s[3] / 1e3).toFixed(12)} ${(s[4] / 1e3).toFixed(12)} ${(s[5] / 1e3).toFixed(12)}`);
  });
  return Buffer.from(`${lines.join('\n')}\n`);
}

const JSON_TYPE = { schemaName: 'application/json' };
const ANY = { schemaName: 'application/octet-stream' };

// One `fit` invocation. Returns {result, omm, ocm, obd[]} (decoded) or {error}.
export async function fit(module, ephemeris, options = {}, { drag = true, jb2008 = false, reference } = {}) {
  const inputs = [
    { portId: 'ephemeris', typeRef: ANY, payload: ephemeris },
    { portId: 'options', typeRef: JSON_TYPE, payload: Buffer.from(JSON.stringify(options)) },
    ...environment({ drag, jb2008 }),
  ];
  if (reference) inputs.push({ portId: 'reference', typeRef: { schemaName: 'OMM.fbs', fileIdentifier: '$OMM', rootTypeName: 'OMM', wireFormat: 'flatbuffer' }, payload: reference });
  const response = await module.invoke({ methodId: 'fit', inputs });
  if (response.statusCode !== 0) return { error: `${response.errorCode}: ${response.errorMessage}` };
  const port = (id) => response.outputs.filter((o) => o.portId === id).map((o) => new Uint8Array(o.payload));
  const result = JSON.parse(Buffer.from(port('result')[0]).toString());
  return { result, outputs: response.outputs, omm: port('omm')[0], ocm: port('ocm')[0], obd: port('obd') };
}

export { sds, flatbuffers };
