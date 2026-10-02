// Propagated covariance with declared process noise, P(t) = Phi P0 Phi^T + Q,
// on the resident and execution paths (SDS 1.232.0 PRWProcessNoise).
//
// Expected values: (1) the resident catalog's covariance equals P0 carried by
// a finite-difference STM of the resident trajectories themselves; (2) white
// acceleration noise of spectral density q over a short arc t matches the
// kinematic closed form q [[t^3/3, t^2/2], [t^2/2, t]] per axis to the
// gravity-gradient term, (n t)^2 ~ 5e-4 at t = 20 s in LEO; (3) radial-only
// noise stays radial to the rotation of the radial axis over the arc.
// Units: SI on the wire; km here (codec), so Q is in km^2 and km^2/s^2.
import assert from 'node:assert/strict';
import test from 'node:test';
import { residentHarness } from './lib/residentRuntime.mjs';
import { TYPE, encodePrw, decodePrw, makeTable, instant, coordinateSystem, residentState, execution,
  requestFor, decodeResult, processNoise, matrix, unpackMatrix, sds } from './lib/prwCodec.mjs';

const epoch = 2451545;
const r0 = [7000, 0, 0], v0 = [0, 7.5, 1];
// km^2, km^2/s, km^2/s^2: 100 m and 0.1 m/s, with a position-velocity term.
const P0 = Array.from({ length: 36 }, (_, i) => {
  const r = Math.floor(i / 6), c = i % 6;
  if (r === c) return r < 3 ? 0.01 : 1e-8;
  return (r === 0 && c === 4) || (r === 4 && c === 0) ? 5e-6 : 0;
});
const integrator = { method: 'RK78', initialStep: 60, minStep: 0.01, maxStep: 600, tolerance: 1e-12 };
// Execution profile: point mass + J2 (zonal); integrator as the resident defaults.
const forces = { pointMass: true, j2: true, mu: 398600.4418 };
const run = async (h, request) => {
  const response = await h.invoke(request);
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  return response;
};
const executionResult = async (h, params) => decodeResult(await run(h, requestFor('propagate', {
  epochJD: epoch, position: r0, velocity: v0, integrator, forces, ...params })));

const instance = (generation) => makeTable('PRWInstance', { MODULE_ID: 'com.orbpro.hpop', INSTANCE_ID: 'covariance-fixture', GENERATION: generation });
let generation = 0n;
async function residentCovariance(h, target, noise) {
  const g = ++generation;
  const state = Object.assign(residentState({ epochJD: epoch, position: r0, velocity: v0 }), {
    INSTANCE: instance(g), ENTITY_HANDLE: 7, CATALOG_NUMBER: 1, OBJECT_ID: 'covariance', COVARIANCE: matrix(P0, 6),
    PROCESS_NOISE: processNoise(noise) });
  await run(h, { methodId: 'ingest_state', inputs: [{ portId: 'state', typeRef: TYPE, payload: encodePrw('RESIDENT_STATE', state) }] });
  const request = makeTable('PRWResidentRequest', { INSTANCE: instance(g), TARGET_EPOCH: instant(target), ENTITY_HANDLES: [],
    TARGET_COORDINATE_SYSTEM: coordinateSystem() });
  const response = await run(h, { methodId: 'propagate_state', outputStreamCap: 1,
    inputs: [{ portId: 'request', typeRef: TYPE, payload: encodePrw('RESIDENT_REQUEST', request) }] });
  const out = decodePrw(response.outputs[0].payload).RESIDENT_STATE;
  return { covariance: unpackMatrix(out.COVARIANCE), noise: out.PROCESS_NOISE };
}
const relativeGap = (a, b) => Math.max(...a.map((x, i) => Math.abs(x - b[i]))) / Math.max(...b.map(Math.abs));

test('resident covariance is the linear propagation of P0 through the resident trajectories', async (t) => {
  // Phi by central differences of 12 perturbed resident objects (100 m,
  // 0.1 m/s) propagated with the nominal one; P_fd = Phi P0 Phi^T.
  const h = await residentHarness('browser');
  t.after(() => h.destroy());
  const target = epoch + 0.25, g = ++generation;
  const steps = [0.1, 0.1, 0.1, 1e-4, 1e-4, 1e-4];
  const seeds = [{ r: r0, v: v0 }];
  for (let j = 0; j < 6; ++j) for (const sign of [1, -1]) {
    const x = [...r0, ...v0];
    x[j] += sign * steps[j];
    seeds.push({ r: x.slice(0, 3), v: x.slice(3) });
  }
  const states = seeds.map((s, k) => Object.assign(residentState({ epochJD: epoch, position: s.r, velocity: s.v }), {
    INSTANCE: instance(g), ENTITY_HANDLE: k + 1, CATALOG_NUMBER: k + 1, OBJECT_ID: `fd-${k}`, ...(k === 0 ? { COVARIANCE: matrix(P0, 6) } : {}) }));
  await run(h, { methodId: 'ingest_state', inputs: states.map((x) => ({ portId: 'state', typeRef: TYPE, payload: encodePrw('RESIDENT_STATE', x) })) });
  const request = makeTable('PRWResidentRequest', { INSTANCE: instance(g), TARGET_EPOCH: instant(target), ENTITY_HANDLES: [],
    TARGET_COORDINATE_SYSTEM: coordinateSystem() });
  const out = new Map();
  for (let more = true; more;) {
    const response = await run(h, { methodId: 'propagate_state', outputStreamCap: 16,
      inputs: [{ portId: 'request', typeRef: TYPE, payload: encodePrw('RESIDENT_REQUEST', request) }] });
    for (const o of response.outputs) { const r = decodePrw(o.payload).RESIDENT_STATE; out.set(r.ENTITY_HANDLE, r); }
    more = out.size < seeds.length;
  }
  const x = (k) => { const s = out.get(k).STATE; return [s.POSITION.X, s.POSITION.Y, s.POSITION.Z, s.VELOCITY.X, s.VELOCITY.Y, s.VELOCITY.Z].map((v) => v / 1000); };
  const phi = Array.from({ length: 6 }, () => Array(6).fill(0));
  for (let j = 0; j < 6; ++j) {
    const plus = x(2 + 2 * j), minus = x(3 + 2 * j);
    for (let i = 0; i < 6; ++i) phi[i][j] = (plus[i] - minus[i]) / (2 * steps[j]);
  }
  const p0 = (i, j) => P0[i * 6 + j];
  const fd = [];
  for (let i = 0; i < 6; ++i) for (let j = 0; j < 6; ++j) {
    let v = 0;
    for (let a = 0; a < 6; ++a) for (let b = 0; b < 6; ++b) v += phi[i][a] * p0(a, b) * phi[j][b];
    fd.push(v);
  }
  const resident = unpackMatrix(out.get(1).COVARIANCE);
  assert.ok(relativeGap(resident, fd) < 1e-4, `gap ${relativeGap(resident, fd)}`);
  assert.equal(out.get(2).COVARIANCE, null, 'objects without P0 report none');
});

test('process noise adds the same Q on the resident and execution paths', async (t) => {
  // The resident field is degree and order 20; the execution profile here is
  // zonal (point mass + J2). Over 0.25 d their STMs differ by ~2e-4, so the
  // added Q agrees to 1e-3; the computation is the same PropagateCovariance.
  const h = await residentHarness('browser');
  t.after(() => h.destroy());
  const target = epoch + 0.25;
  const noise = { axes: 'RTN', q: [1e-8, 1e-7, 1e-8], intervalSeconds: 600 };
  const resident = await residentCovariance(h, target), residentNoisy = await residentCovariance(h, target, noise);
  const exec = await executionResult(h, { targetJD: target, covariance: P0 });
  const execNoisy = await executionResult(h, { targetJD: target, covariance: P0, processNoise: noise });
  const qResident = residentNoisy.covariance.map((v, i) => v - resident.covariance[i]);
  const qExec = execNoisy.covariance.map((v, i) => v - exec.covariance[i]);
  assert.ok(relativeGap(qResident, qExec) < 1e-3, `Q gap ${relativeGap(qResident, qExec)}`);
  for (const k of [0, 7, 14, 21, 28, 35]) assert.ok(qExec[k] > 0, `Q diagonal ${k}`);
  assert.equal(resident.noise, null);
  for (const n of [residentNoisy.noise, execNoisy.processNoise]) {
    assert.equal(n.MODEL, sds.prwProcessNoiseModel.WHITE_ACCELERATION);
    assert.equal(n.AXES, sds.prwProcessNoiseAxes.RADIAL_TRANSVERSE_NORMAL);
    assert.deepEqual(n.SPECTRAL_DENSITY_M2_S3, noise.q);
    assert.equal(n.DISCRETIZATION_SECONDS, 600);
  }
});

test('white acceleration noise over a short arc is the kinematic closed form', async (t) => {
  const h = await residentHarness('browser');
  t.after(() => h.destroy());
  const seconds = 20, q = 1e-6;                       // m^2/s^3
  const zero = Array(36).fill(0);
  const inertial = await executionResult(h, { targetJD: epoch + seconds / 86400, covariance: zero,
    processNoise: { axes: 'INERTIAL', q: [q, q, q], intervalSeconds: 2 } });
  const qk = q * 1e-6;                                // km^2/s^3
  const pos = qk * seconds ** 3 / 3, cross = qk * seconds ** 2 / 2, vel = qk * seconds;
  const Q = inertial.covariance;
  for (let a = 0; a < 3; ++a) {
    assert.ok(Math.abs(Q[a * 6 + a] / pos - 1) < 2e-3, `position ${a}: ${Q[a * 6 + a]} vs ${pos}`);
    assert.ok(Math.abs(Q[a * 6 + a + 3] / cross - 1) < 2e-3, `cross ${a}`);
    assert.ok(Math.abs(Q[(a + 3) * 6 + a + 3] / vel - 1) < 2e-3, `velocity ${a}`);
    for (let b = 0; b < 3; ++b) if (a !== b) assert.ok(Math.abs(Q[a * 6 + b]) < 2e-3 * pos, `position ${a}${b}`);
  }

  const radial = await executionResult(h, { targetJD: epoch + seconds / 86400, covariance: zero,
    processNoise: { axes: 'RTN', q: [q, 0, 0], intervalSeconds: 2 } });
  // r0 is along x: the radial axis turns n t ~ 0.02 rad over the arc.
  assert.ok(Math.abs(radial.covariance[0] / pos - 1) < 2e-3, `radial ${radial.covariance[0]}`);
  assert.ok(Math.abs(radial.covariance[7]) < 5e-3 * pos && Math.abs(radial.covariance[14]) < 5e-3 * pos);
});

test('process noise needs a covariance and a complete declaration', async (t) => {
  const h = await residentHarness('browser');
  t.after(() => h.destroy());
  const refused = async (request, code) => {
    const r = await h.invoke(request);
    assert.notEqual(r.statusCode, 0);
    assert.equal(r.errorCode, code, r.errorMessage);
  };
  await refused(requestFor('propagate', { epochJD: epoch, targetJD: epoch + 0.01, position: r0, velocity: v0, integrator, forces,
    processNoise: { axes: 'INERTIAL', q: [1e-6, 1e-6, 1e-6], intervalSeconds: 60 } }), 'unsupported-configuration');
  await refused(requestFor('propagate', { epochJD: epoch, targetJD: epoch + 0.01, position: r0, velocity: v0, integrator, forces,
    covariance: P0, processNoise: { axes: 'INERTIAL', q: [1e-6, 1e-6], intervalSeconds: 60 } }), 'invalid-process-noise');
  const state = Object.assign(residentState({ epochJD: epoch, position: r0, velocity: v0 }), {
    INSTANCE: instance(++generation), ENTITY_HANDLE: 7, PROCESS_NOISE: processNoise({ axes: 'INERTIAL', q: [1e-6, 1e-6, 1e-6], intervalSeconds: 60 }) });
  await refused({ methodId: 'ingest_state', inputs: [{ portId: 'state', typeRef: TYPE, payload: encodePrw('RESIDENT_STATE', state) }] },
    'invalid-process-noise');
});
