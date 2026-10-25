#!/usr/bin/env node
// E2E: an impulse planted at the start epoch of an arc applies, on the shipped artifact in the browser
// lane and in native WasmEdge. (FFM used to drop it silently: the variational spans skip a kick at their
// own start, because the span before applies it at its end, and the first span has none before it.)
//
// Truth is the two-body problem in 60-digit arithmetic (tests/lib/keplerReference.mjs): the exact state at
// any time of the orbit through (r0, v0 + dv), or, for a kick later in the arc, of the orbit through
// (r0, v0) until the kick and through the kicked state after it. Nothing here integrates; JS builds
// requests, reads results and subtracts.
//
//   1. an inertial impulse at t0 against the closed form (final state, with and without the STM);
//   2. an RTN impulse at t0, the same;
//   3. a sample at t0 carries the kick (the state at an impulse's epoch is the state after it);
//   4. the effect is the kick's: the arc without it ends kilometers away;
//   5. two impulses at t0 sum; the transition matrix and covariance of a t0 kick are those of the arc that
//      starts from the kicked state;
//   6. an impulse inside the arc, with a sample after it, applies once (the span split does not repeat it);
//      an impulse 84.375 s after t0 (the workaround) and one at t0 agree with the closed form alike;
//   6b. the finite-burn integrator, which runs the whole arc from the initial state, the same;
//   7. a backward sample with a t0 impulse is refused by name; 8. lane parity: identical bytes.
//
//   node propagator/ffm/tests/start-epoch-impulse.e2e.mjs
import { createHash } from 'node:crypto';
import { destroyLanes } from './lib/planetary.mjs';
import { add, ask, at, base, calibrate, check, DV, DV_RTN, exact, failures, HALF, kick, kicked, norm, R0, report, rtn, SAMPLE, scale, SPAN, state, V0 } from './lib/impulseTruth.mjs';

process.env.PATH = `${process.env.HOME}/.wasmedge/bin:${process.env.PATH}`;

for (const kind of ['browser', 'wasmedge']) {
  console.log(`\n== ${kind} ==`);
  await calibrate(kind);
  console.log('1. an inertial impulse at t0 against the closed form');
  for (const includeSTM of [false, true]) {
    const o = await ask(kind, { ...base, targetJD: at(SPAN), includeSTM, maneuvers: [kick(DV, 0)] });
    check(!o.error, `inertial t0 impulse (includeSTM=${includeSTM}): ${o.error}`);
    if (!o.error) report(`inertial dv at t0, includeSTM=${includeSTM}`, state(o), kicked(DV, 0, SPAN));
  }

  console.log('2. an RTN impulse at t0');
  {
    const o = await ask(kind, { ...base, targetJD: at(SPAN), maneuvers: [kick(DV_RTN, 0, 'RTN')] });
    check(!o.error, `RTN t0 impulse: ${o.error}`);
    if (!o.error) report('RTN dv at t0', state(o), kicked(rtn(DV_RTN, R0, V0), 0, SPAN));
  }

  console.log('3. a sample at t0 carries the kick; the samples after follow the closed form');
  {
    const o = await ask(kind, { ...base, targetJD: at(SPAN), sampleEpochsJD: [at(0), at(HALF), at(SPAN)], maneuvers: [kick(DV, 0)] });
    check(!o.error, `samples with a t0 impulse: ${o.error}`);
    if (!o.error) {
      report('sample at t0', state(o.samples[0]), [...R0, ...add(V0, DV)]);
      report('sample at 2700 s', state(o.samples[1]), kicked(DV, 0, HALF));
      report('sample at 5400 s', state(o.samples[2]), kicked(DV, 0, SPAN));
    }
  }

  console.log('4. the effect is the kick\'s');
  {
    const without = await ask(kind, { ...base, targetJD: at(SPAN), includeSTM: true });
    const o = await ask(kind, { ...base, targetJD: at(SPAN), includeSTM: true, maneuvers: [kick(DV, 0)] });
    const km = norm(state(without).slice(0, 3).map((x, i) => x - state(o)[i]));
    const expected = norm(kicked(DV, 0, SPAN).slice(0, 3).map((x, i) => x - exact(R0, V0, SPAN)[i]));
    console.log(`  the arc without the kick ends ${km.toFixed(3)} km away (closed form ${expected.toFixed(3)} km)`);
    check(km > 1 && Math.abs(km - expected) < 1e-6, `kick effect ${km} km against ${expected} km`);
  }

  console.log('5. two impulses at t0 sum; the STM and covariance are those of the arc from the kicked state');
  {
    const half = scale(DV, 0.5);
    const two = await ask(kind, { ...base, targetJD: at(SPAN), maneuvers: [kick(half, 0), kick(half, 0)] });
    check(!two.error, `two t0 impulses: ${two.error}`);
    if (!two.error) report('two half kicks at t0', state(two), kicked(DV, 0, SPAN));
    const covariance = Array(36).fill(0); covariance[0] = 1e-6; covariance[7] = 4e-6; covariance[21] = 1e-12;
    const a = await ask(kind, { ...base, targetJD: at(SPAN), includeSTM: true, covariance, maneuvers: [kick(DV, 0)] });
    const b = await ask(kind, { ...base, velocity: add(V0, DV), targetJD: at(SPAN), includeSTM: true, covariance });
    check(!a.error && !b.error, `STM and covariance: ${a.error ?? b.error}`);
    if (!a.error && !b.error) {
      const relative = (x, y) => Math.sqrt(x.reduce((s, v, i) => s + (v - y[i]) ** 2, 0) / y.reduce((s, v) => s + v * v, 0));
      const stm = relative(a.stm, b.stm), cov = relative(a.covariance, b.covariance);
      console.log(`  STM ${stm.toExponential(2)}, covariance ${cov.toExponential(2)} (relative, against the arc from the kicked state)`);
      check(stm < 1e-9 && cov < 1e-9, `STM ${stm}, covariance ${cov}`);
    }
  }

  console.log('6. a kick inside the arc with a sample after it applies once; a kick 84.375 s after t0 (the workaround) agrees with the closed form too');
  {
    const o = await ask(kind, { ...base, targetJD: at(SPAN), sampleEpochsJD: [at(SAMPLE)], maneuvers: [kick(DV, HALF)] });
    check(!o.error, `kick at a sample epoch: ${o.error}`);
    if (!o.error) {
      report('sample at 4050 s', state(o.samples[0]), kicked(DV, HALF, SAMPLE));
      report('final after a kick at 2700 s', state(o), kicked(DV, HALF, SPAN));
    }
    const late = await ask(kind, { ...base, targetJD: at(SPAN), maneuvers: [kick(DV, 84.375)] });
    check(!late.error, `kick at 84.375 s: ${late.error}`);
    if (!late.error) report('final after a kick at 84.375 s', state(late), kicked(DV, 84.375, SPAN));
  }

  console.log('6b. the finite-burn integrator (mass dynamics) runs the whole arc from the initial state: the t0 impulse applies there too');
  {
    // A burn that has not started by the target: the arc is the coast, so the closed form holds.
    const later = { startSeconds: 3000, stopSeconds: 3100, thrustNewtons: 5, ispSeconds: 300, frame: 'INERTIAL', direction: [1, 0, 0] };
    const o = await ask(kind, { ...base, massKg: 1000, targetJD: at(HALF), includeSTM: true, finiteBurns: [later], maneuvers: [kick(DV, 0)] });
    check(!o.error, `finite-burn arc with a t0 impulse: ${o.error}`);
    if (!o.error) report('finite-burn arc, inertial dv at t0', state(o), kicked(DV, 0, HALF));
  }

  console.log('7. a backward sample with a t0 impulse is refused by name');
  {
    const o = await ask(kind, { ...base, targetJD: at(SPAN), sampleEpochsJD: [at(-HALF)], maneuvers: [kick(DV, 0)] });
    check(!!o.error && /scheduled impulses is unsupported/.test(o.error), `backward sample with a t0 impulse: ${o.error ?? 'accepted'}`);
    console.log(`  ${o.error ?? 'ACCEPTED'}`);
  }
}

console.log('\n8. lane parity: the browser and WasmEdge answers are identical bytes');
for (const [label, params] of [
  ['inertial t0 impulse with samples and STM', { ...base, targetJD: at(SPAN), includeSTM: true, sampleEpochsJD: [at(0), at(HALF)], maneuvers: [kick(DV, 0)] }],
  ['RTN t0 impulse', { ...base, targetJD: at(SPAN), maneuvers: [kick(DV_RTN, 0, 'RTN')] }]]) {
  const digests = [];
  for (const kind of ['browser', 'wasmedge']) {
    const o = await ask(kind, params);
    check(!o.error, `${label} on ${kind}: ${o.error}`);
    digests.push(o.error ? '' : createHash('sha256').update(o.response.outputs.find((x) => x.portId === 'response').payload).digest('hex'));
  }
  console.log(`  ${label}: ${digests[0].slice(0, 16)} ${digests[1].slice(0, 16)}`);
  check(digests[0] !== '' && digests[0] === digests[1], `${label}: lanes differ`);
}

await destroyLanes();
if (failures.length) { console.log(`\nFAIL ${failures.length}`); process.exit(1); }
console.log('\nPASS start-epoch impulse');
