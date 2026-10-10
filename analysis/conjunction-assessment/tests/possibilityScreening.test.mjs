// possibility_of_collision end to end through the WASM artifact, against
// independent references (ASO catalog whitepaper section 12; TEAG Remark 3.7):
// - finite supports: a geometry built so that exactly one pair collides,
//   where Pi(C), N(C), N(no C) and the alpha-cut ranges follow from the
//   definitions by hand;
// - Gaussian-shaped kernels in the encounter plane: the isotropic closed
//   form Pi(C) = exp(-((d - R) / (2 s))^2 / 2) for two equal isotropic sets
//   (their Minkowski sum is the ball of radius 2 s, which the minimum-trace
//   outer bound reproduces exactly), N(C) = 1 - exp(-((R - d) / (2 s))^2 / 2)
//   inside the disk; an anisotropic plane shape against a brute-force search
//   of the disk; monotonicity in R.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';

const control = (payload) => ({ portId: 'request', payload, typeRef: { wireFormat: 'flatbuffer', mediaType: 'application/vnd.sdn.ca-possibility-request' } });

function frame({ radius, window = 600, mode, a, b, alpha = [] }) {
  const doubles = mode === 0 ? [...a.flat(), ...b.flat()] : [...a.center, ...a.shape, ...b.center, ...b.shape];
  const bytes = new ArrayBuffer(4 + 16 + 16 + 8 * alpha.length + 8 * doubles.length);
  const v = new DataView(bytes);
  new Uint8Array(bytes, 0, 4).set([0x43, 0x50, 0x51, 0x31]);  // CPQ1
  let at = 4;
  const f64 = (x) => { v.setFloat64(at, x, true); at += 8; };
  const u32 = (x) => { v.setUint32(at, x, true); at += 4; };
  f64(radius); f64(window); u32(mode); u32(mode === 0 ? a.length : 1); u32(mode === 0 ? b.length : 1); u32(alpha.length);
  alpha.forEach(f64); doubles.forEach(f64);
  return new Uint8Array(bytes);
}
function decode(payload, alphaCount) {
  const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  assert.equal(String.fromCharCode(...payload.subarray(0, 4)), 'CPR1');
  let at = 4;
  const f64 = () => { const x = v.getFloat64(at, true); at += 8; return x; };
  const u64 = () => { const x = Number(v.getBigUint64(at, true)); at += 8; return x; };
  const r = { possibility: f64(), necessity: f64(), necessityNoCollision: f64(), minMiss: f64(), maxMiss: f64(), tcaMin: f64(), tcaMax: f64(), pairs: u64(), colliding: u64(), alpha: [] };
  for (let k = 0; k < alphaCount; ++k) r.alpha.push({ minMiss: f64(), maxMiss: f64(), tcaMin: f64(), tcaMax: f64() });
  return r;
}

const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
test.after(() => harness.destroy?.());
async function evaluate(request) {
  const response = await harness.invoke({ methodId: 'possibility_of_collision', inputs: [control(frame(request))] });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  return decode(response.outputs.find((o) => o.portId === 'result').payload, request.alpha?.length ?? 0);
}

test('finite supports: possibility, necessity and alpha-cut miss ranges by definition', async () => {
  // B moves along +z at 7 km/s past A (at rest); closest approach at t = 0
  // for every pair, so the miss is the x-y distance.
  const v = 7000;
  const a = [[1000, 0, 0, 0, 0, 0, 1.0], [300, 5, 0, 0, 0, 0, 0.4]];
  const b = [[0, 0, 0, 0, 0, v, 1.0], [300, 0, 0, 0, 0, v, 0.7]];
  // Misses: (a0,b0) 1000, (a0,b1) 700, (a1,b0) hypot(300,5), (a1,b1) 5.
  const r = await evaluate({ radius: 20, mode: 0, a, b, alpha: [0.5, 0.35] });
  assert.equal(r.pairs, 4);
  assert.equal(r.colliding, 1);
  assert.equal(r.possibility, 0.4);           // min(0.4, 0.7) of the colliding pair
  assert.equal(r.necessity, 0);               // the most possible pair (1, 1) misses
  assert.equal(r.necessityNoCollision, 1 - 0.4);
  assert.equal(r.minMiss, 5);
  assert.equal(r.maxMiss, 1000);
  assert.equal(r.tcaMin, 0);
  assert.equal(r.tcaMax, 0);
  // alpha 0.5: pairs with joint possibility >= 0.5 are (a0,b0) 1 and (a0,b1) 0.7.
  assert.deepEqual([r.alpha[0].minMiss, r.alpha[0].maxMiss], [700, 1000]);
  // alpha 0.35: all four pairs (joints 1, 0.7, 0.4, 0.4).
  assert.deepEqual([r.alpha[1].minMiss, r.alpha[1].maxMiss], [5, 1000]);
  // A single colliding pair of possibility 1 makes collision necessary only
  // if every non-colliding pair is impossible: necessity 1 - 0.4 here.
  const sure = await evaluate({ radius: 20, mode: 0, a: [[0, 0, 0, 0, 0, 0, 1], [900, 0, 0, 0, 0, 0, 0.4]], b: [[3, 4, 0, 0, 0, v, 1]] });
  assert.equal(sure.possibility, 1);
  assert.equal(sure.necessity, 1 - 0.4);
});

const isotropic = (s, vs = 1e-6) => [s * s, 0, 0, 0, 0, 0, 0, s * s, 0, 0, 0, 0, 0, 0, s * s, 0, 0, 0, 0, 0, 0, vs * vs, 0, 0, 0, 0, 0, 0, vs * vs, 0, 0, 0, 0, 0, 0, vs * vs];

test('Gaussian-shaped kernels: the encounter-plane closed forms', async () => {
  const s = 10, R = 20;
  for (const d of [100, 45, 25]) {
    const r = await evaluate({ radius: R, mode: 1, a: { center: [d, 0, 0, 0, 0, 7000], shape: isotropic(s) }, b: { center: [0, 0, 0, 0, 0, 0], shape: isotropic(s) } });
    const expected = Math.exp(-0.5 * ((d - R) / (2 * s)) ** 2);
    assert.ok(Math.abs(r.possibility - expected) <= 1e-12 * Math.max(1, expected) + 1e-15, `d=${d}: ${r.possibility} vs ${expected}`);
    assert.equal(r.necessity, 0);
    assert.ok(Math.abs(r.minMiss - d) < 1e-9);
  }
  for (const d of [5, 0.5]) {
    const r = await evaluate({ radius: R, mode: 1, a: { center: [d, 0, 0, 0, 0, 7000], shape: isotropic(s) }, b: { center: [0, 0, 0, 0, 0, 0], shape: isotropic(s) } });
    assert.equal(r.possibility, 1);
    const expected = 1 - Math.exp(-0.5 * ((R - d) / (2 * s)) ** 2);
    assert.ok(Math.abs(r.necessity - expected) <= 1e-12, `inside d=${d}: ${r.necessity} vs ${expected}`);
  }
});

test('Gaussian-shaped kernels: an anisotropic plane shape against a brute-force disk search; monotone in R', async () => {
  // Relative shape diag(4 a^2, 4 b^2, ...) in the plane (equal shapes for A
  // and B double each axis: trace-optimal p = 1). Miss vector off-axis.
  const sa = [30, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 40, 0, 0, 0, 0, 0, 0, 1e-6, 0, 0, 0, 0, 0, 0, 1e-6, 0, 0, 0, 0, 0, 0, 1e-6].map((x, i) => (i % 7 === 0 ? x * x : x));
  const center = [60, -35, 0, 0, 0, 7000];
  const R = 25;
  const r = await evaluate({ radius: R, mode: 1, a: { center, shape: sa }, b: { center: [0, 0, 0, 0, 0, 0], shape: sa } });
  // Plane axes are x and y (relative velocity along z, t = 0); C2 = 4 diag(30^2, 5^2).
  const cx = 4 * 900, cy = 4 * 25;
  let best = Infinity;
  for (let i = 0; i <= 200000; ++i) {
    const th = (2 * Math.PI * i) / 200000;
    const x = R * Math.cos(th), y = R * Math.sin(th);
    best = Math.min(best, (x - 60) ** 2 / cx + (y + 35) ** 2 / cy);
  }
  const expected = Math.exp(-0.5 * best);
  assert.ok(Math.abs(r.possibility - expected) <= 1e-8 * expected, `${r.possibility} vs ${expected}`);
  let previous = 0;
  for (const radius of [5, 10, 20, 40, 60]) {
    const p = (await evaluate({ radius, mode: 1, a: { center, shape: sa }, b: { center: [0, 0, 0, 0, 0, 0], shape: sa } })).possibility;
    assert.ok(p >= previous, `${radius}: ${p} < ${previous}`);
    previous = p;
  }
});

test('requests are validated', async () => {
  const bad = await harness.invoke({ methodId: 'possibility_of_collision', inputs: [control(new Uint8Array([1, 2, 3, 4]))] });
  assert.notEqual(bad.statusCode, 0);
  const zero = frame({ radius: 0, mode: 0, a: [[0, 0, 0, 0, 0, 0, 1]], b: [[1, 0, 0, 0, 0, 1, 1]] });
  assert.notEqual((await harness.invoke({ methodId: 'possibility_of_collision', inputs: [control(zero)] })).statusCode, 0);
});
