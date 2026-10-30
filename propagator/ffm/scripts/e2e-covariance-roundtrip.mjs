#!/usr/bin/env node
// E2E: a covariance with dynamic parameters relays across two consecutive FFM execution calls. Call 2 takes
// call 1's FINAL_SAMPLE state and COVARIANCE, unmodified, as its INITIAL and INITIAL_COVARIANCE, with and
// without PROCESS_NOISE, for the ISS, laser and Starlink-like seeds of tests/fixtures/covariance-roundtrip.json
// (GCRF; the ISS relay once more in EME2000 axes), on this artifact and on FFM 2.0.3's (by git show).
//
// On this artifact: every relay is accepted; 2.0.3's unsymmetrized output, handed over unmodified, is accepted
// as well, as any input within the check's tolerance is (a consequence of the tolerance, not a compatibility
// path); every emitted COVARIANCE is exactly symmetric, bit for bit, and passes the positive-semidefinite test
// at 1e-16 (a replica of the module's test, as an independent verifier); the state, the STM and the step counts
// are byte-identical to 2.0.3's (call 2 compared from the same initial state; the state does not depend on the
// covariance values); a clearly invalid covariance (one correlation set to 1.05) is still refused by name; an
// input with a negative pivot inside the tolerance is accepted and kept as is.
// Negative control: 2.0.3 emits asymmetric covariances and refuses at least one of its own relays.
// Encoding, decoding and comparison only: every propagation runs in the module.
//
//   node propagator/ffm/scripts/e2e-covariance-roundtrip.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { makeTable, encodePrw, decodePrw, sds, TYPE, coordinateSystem } from '../tests/lib/prwCodec.mjs';
import { environmentInputs, isoAfter } from '../tests/lib/fullForce.mjs';
import * as catalog from '../catalog.mjs';

const script = fileURLToPath(import.meta.url), root = path.resolve(path.dirname(script), '..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/covariance-roundtrip.json'), 'utf8'));
const relays = [
  ...fixture.seeds.flatMap((seed) => [false, true].map((noise) => ({ seed: seed.label, noise, axes: 'GCRF' }))),
  { seed: 'ISS', noise: false, axes: 'EME2000' },
];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

const candidate = () => fs.readFileSync(path.join(root, 'dist/isomorphic/module.wasm'));
const seedCovariance = (seed) => seed.covariance.map((x) => x * seed.covarianceScale.value);

// The execution request of one call: k arcs after the fixture epoch, from the seed (k = 1) or from `initial`.
function executionRequest(seed, { covariance, initial = null, k = 1, noise = false, axes = 'GCRF' }) {
  const n = 6 + seed.parameters.length;
  const value = (kind) => seed.parameters.find((p) => p.kind === kind)?.value ?? seed.fixed?.[kind];
  const e = catalog.fullForceRequest({ epoch: fixture.epochUtc, state: seed.state, target: isoAfter(fixture.epochUtc, k * fixture.arcSeconds).slice(0, 26),
    cdAm: value('DRAG_AREA_OVER_MASS'), crAm: value('SRP_AREA_OVER_MASS') });
  if (initial) e.INITIAL = makeTable('PRWResidentState', { STATE: initial.STATE, COORDINATE_SYSTEM: initial.COORDINATE_SYSTEM });
  else if (axes !== 'GCRF') { e.INITIAL.COORDINATE_SYSTEM = coordinateSystem(axes); e.INITIAL.STATE.COORDINATE_SYSTEM_NAME = axes; }
  e.INCLUDE_STM = true;
  e.DYNAMIC_PARAMETERS = seed.parameters.map((p) => sds.prwDynamicParameter[p.kind]);
  e.INITIAL_COVARIANCE = makeTable('PRWStateMatrix', { DIMENSION: n, VALUES: covariance });
  if (noise) e.PROCESS_NOISE = makeTable('PRWProcessNoise', { MODEL: sds.prwProcessNoiseModel.WHITE_ACCELERATION,
    AXES: sds.prwProcessNoiseAxes[seed.processNoise.axes], SPECTRAL_DENSITY_M2_S3: seed.processNoise.spectralDensityM2S3,
    DISCRETIZATION_SECONDS: fixture.processNoiseDiscretizationSeconds });
  return { methodId: 'invoke', inputs: [{ portId: 'request', typeRef: TYPE, payload: encodePrw('EXECUTION_REQUEST', e) }, ...environmentInputs()] };
}

// The module's positive-semidefinite test, replicated as an independent verifier of its output: complete
// diagonal pivoting (LAPACK DPSTRF) on the correlation matrix at `tolerance`.
function semidefinite(values, n, tolerance) {
  const s = Array.from({ length: n }, (_, i) => Math.sqrt(values[i * n + i]));
  const c = Array.from({ length: n * n }, (_, k) => { const i = Math.floor(k / n), j = k % n; return s[i] && s[j] ? values[k] / s[i] / s[j] : 0; });
  const swap = (a, b) => { const t = c[a]; c[a] = c[b]; c[b] = t; };
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let j = i; j < n; j++) {
      if (c[j * n + j] < -tolerance) return false;
      if (c[j * n + j] > c[pivot * n + pivot]) pivot = j;
    }
    const p = c[pivot * n + pivot];
    if (p <= tolerance) return c.every((v, k) => Math.floor(k / n) < i || k % n < i || Math.abs(v) <= tolerance);
    if (pivot !== i) for (let k = 0; k < n; k++) { swap(i * n + k, pivot * n + k); }
    if (pivot !== i) for (let k = 0; k < n; k++) { swap(k * n + i, k * n + pivot); }
    for (let j = i + 1; j < n; j++) for (let k = j; k < n; k++) c[j * n + k] = c[k * n + j] = c[j * n + k] - c[j * n + i] * c[k * n + i] / p;
  }
  return true;
}

// One relay, both artifacts, in a child process (the relays run in parallel).
async function relay({ seed: label, noise, axes }) {
  const seed = fixture.seeds.find((s) => s.label === label), n = 6 + seed.parameters.length;
  const predecessor = execFileSync('git', ['show', `${fixture.predecessor.commit}:propagator/ffm/dist/isomorphic/module.wasm`], { cwd: root, maxBuffer: 16 << 20 });
  assert.equal(sha(predecessor), fixture.predecessor.artifactSha256, 'FFM 2.0.3 artifact');
  const hosts = { old: await createBrowserModuleHarness({ wasmSource: predecessor, surface: 'direct' }),
    now: await createBrowserModuleHarness({ wasmSource: candidate(), surface: 'direct' }) };
  // The state part of a sample (state, STM, step counts) as bytes, and its covariance.
  const call = async (host, covariance, initial, k) => {
    const r = await hosts[host].invoke(executionRequest(seed, { covariance, initial, k, noise, axes }));
    if (r.statusCode !== 0) return { error: `${r.errorCode}: ${r.errorMessage}` };
    const sample = decodePrw(r.outputs.find((o) => o.portId === 'response').payload).EXECUTION_RESULT.FINAL_SAMPLE, s = sample.STATE.STATE;
    assert.equal(sample.COVARIANCE.DIMENSION, n);
    const doubles = Float64Array.from([s.POSITION.X, s.POSITION.Y, s.POSITION.Z, s.VELOCITY.X, s.VELOCITY.Y, s.VELOCITY.Z, ...sample.STM.VALUES]);
    const c = Float64Array.from(sample.COVARIANCE.VALUES), bits = new BigUint64Array(c.buffer);
    let asymmetry = 0, symmetric = true;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      symmetric &&= bits[i * n + j] === bits[j * n + i];
      asymmetry = Math.max(asymmetry, Math.abs(c[i * n + j] - c[j * n + i]) / Math.sqrt(c[i * n + i] * c[j * n + j]));
    }
    return { sample, covariance: Array.from(c), symmetric, asymmetry, semidefinite: semidefinite(c, n, 1e-16),
      statePart: `${Buffer.from(doubles.buffer).toString('hex')}|${s.EPOCH}|${s.EPOCH_TIME_SYSTEM}|${sample.ACCEPTED_STEPS}|${sample.REJECTED_STEPS}` };
  };
  try {
    const p0 = seedCovariance(seed);
    const first = { old: await call('old', p0, null, 1), now: await call('now', p0, null, 1) };
    assert(!first.old.error && !first.now.error, `call 1: ${first.old.error ?? first.now.error}`);
    const handOff = (c) => [c.covariance, c.sample.STATE];
    const second = { now: await call('now', ...handOff(first.now), 2), cross: await call('now', ...handOff(first.old), 2), old: await call('old', ...handOff(first.old), 2) };
    // 2.0.3's own relay is refused: its call 2 from this artifact's (identical) state and symmetric covariance.
    if (second.old.error) second.oldOnNow = await call('old', ...handOff(first.now), 2);
    const strip = (c) => (c ? (c.error ? { error: c.error } : { symmetric: c.symmetric, asymmetry: c.asymmetry, semidefinite: c.semidefinite, statePart: c.statePart }) : undefined);
    return { seed: label, noise, axes, n, first: { old: strip(first.old), now: strip(first.now) },
      second: Object.fromEntries(Object.entries(second).map(([k, v]) => [k, strip(v)])) };
  } finally { await hosts.old.destroy(); await hosts.now.destroy(); }
}

if (process.argv[2] === '--relay') {
  const out = JSON.stringify(await relay(JSON.parse(process.argv[3])));
  await new Promise((resolve) => process.stdout.write(out, resolve));
  process.exit(0);
}

const started = Date.now();
const results = await Promise.all(relays.map(async (r) => {
  const { stdout } = await promisify(execFile)(process.execPath, [script, '--relay', JSON.stringify(r)], { cwd: root, maxBuffer: 64 << 20 });
  return JSON.parse(stdout);
}));
const name = (r) => `${r.seed} ${r.axes}${r.noise ? ' PROCESS_NOISE' : ''}`;
const rows = [];
for (const r of results) {
  const { first, second } = r;
  for (const [k, c] of [['call 1', first.now], ['call 2', second.now], ['call 2 from 2.0.3', second.cross]]) {
    assert(!c.error, `${name(r)} ${k}: ${c.error}`);
    assert(c.symmetric, `${name(r)} ${k}: covariance not exactly symmetric (${c.asymmetry})`);
    assert(c.semidefinite, `${name(r)} ${k}: covariance not positive semidefinite at 1e-16`);
  }
  assert.equal(first.now.statePart, first.old.statePart, `${name(r)} call 1: state part differs from 2.0.3`);
  assert.equal(second.cross.statePart, second.now.statePart, `${name(r)} call 2: the state depends on the handed-over covariance`);
  const oldSecond = second.oldOnNow ?? second.old;
  assert(!oldSecond.error, `${name(r)} 2.0.3 call 2: ${oldSecond.error}`);
  assert.equal(second.now.statePart, oldSecond.statePart, `${name(r)} call 2: state part differs from 2.0.3`);
  rows.push({ relay: name(r), dimension: r.n,
    ffm203: { call1Asymmetry: first.old.asymmetry, relay: second.old.error ?? 'accepted', call2Asymmetry: second.old.asymmetry ?? null },
    candidate: { call1Asymmetry: first.now.asymmetry, call2Asymmetry: second.now.asymmetry, call2From203Asymmetry: second.cross.asymmetry, relay: 'accepted', relayOf203: 'accepted' } });
}
// A clearly invalid covariance is still refused by name: the ISS seed with one correlation (x, y) set to 1.05,
// symmetric, so only the positive-semidefinite test can refuse it.
let invalid;
{
  const seed = fixture.seeds.find((s) => s.label === 'ISS'), n = 6 + seed.parameters.length, p = seedCovariance(seed);
  p[1] = p[n] = 1.05 * Math.sqrt(p[0] * p[n + 1]);
  const host = await createBrowserModuleHarness({ wasmSource: candidate(), surface: 'direct' });
  try {
    const r = await host.invoke(executionRequest(seed, { covariance: p }));
    assert.notEqual(r.statusCode, 0, 'a correlation of 1.05 was accepted');
    assert.equal(r.errorCode, 'invalid-covariance');
    assert.match(r.errorMessage, /Covariance must be positive semidefinite\./);
    invalid = { covariance: 'ISS seed, correlation (x, y) = 1.05', refused: `${r.errorCode}: ${r.errorMessage}` };
  } finally { await host.destroy(); }
}
// An input with a negative pivot inside the tolerance is accepted and kept as is, not clipped: the ISS seed's
// variances with the (x, y) correlation 1 + 5e-9 (pivot 1 - (1 + 5e-9)^2 = -1e-8). Its echo at the initial
// epoch is the input to the unit conversion's roundoff, and its 24 h output is accepted by the next call. (A
// congruence keeps the inertia: that output keeps the negative pivot.)
let kept;
{
  const seed = fixture.seeds.find((s) => s.label === 'ISS'), n = 6 + seed.parameters.length, q = seedCovariance(seed);
  const p = q.map((v, k) => (Math.floor(k / n) === k % n ? v : 0));
  p[1] = p[n] = (1 + 5e-9) * Math.sqrt(p[0] * p[n + 1]);
  const host = await createBrowserModuleHarness({ wasmSource: candidate(), surface: 'direct' });
  const sample = (r) => decodePrw(r.outputs.find((o) => o.portId === 'response').payload).EXECUTION_RESULT.FINAL_SAMPLE;
  try {
    const echo = await host.invoke(executionRequest(seed, { covariance: p, k: 0 }));
    assert.equal(echo.statusCode, 0, `negative pivot inside the tolerance: ${echo.errorCode}: ${echo.errorMessage}`);
    const back = sample(echo).COVARIANCE.VALUES, change = Math.max(...p.map((v, k) => (v === 0 ? Math.abs(back[k]) : Math.abs(back[k] - v) / Math.abs(v))));
    assert(change <= 1e-14, `the accepted input changed by ${change}: clipped`);
    const first = await host.invoke(executionRequest(seed, { covariance: p }));
    assert.equal(first.statusCode, 0, `${first.errorCode}: ${first.errorMessage}`);
    const out = sample(first), relay = await host.invoke(executionRequest(seed, { covariance: Array.from(out.COVARIANCE.VALUES), initial: out.STATE, k: 2 }));
    assert.equal(relay.statusCode, 0, `its 24 h output refused: ${relay.errorCode}: ${relay.errorMessage}`);
    kept = { covariance: 'ISS seed variances, correlation (x, y) = 1 + 5e-9', echoChange: change, relay: 'accepted',
      outputSemidefiniteAt1e16: semidefinite(Float64Array.from(out.COVARIANCE.VALUES), n, 1e-16) };
  } finally { await host.destroy(); }
}
// The negative control: the predecessor shows the defect this change removes.
assert(rows.some((r) => r.ffm203.call1Asymmetry > 0), 'FFM 2.0.3 emitted no asymmetric covariance');
assert(rows.some((r) => /invalid-covariance/.test(r.ffm203.relay)), 'FFM 2.0.3 refused none of its own relays');
console.log(JSON.stringify({ status: 'PASS', artifactSha256: sha(candidate()), predecessor: fixture.predecessor, relays: rows, invalid, kept,
  seconds: (Date.now() - started) / 1000 }, null, 1));
