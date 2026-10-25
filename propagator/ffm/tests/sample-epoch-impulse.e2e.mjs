#!/usr/bin/env node
// E2E: every impulse is applied once, wherever the request's other epochs fall, on the shipped artifact in the browser
// lane and in native WasmEdge. (FFM used to drop an impulse whose epoch was a sample epoch or a span break: the epochs are
// TDB labels, the arc runs on the TT clock, so the span ended about a microsecond before the label, the kick fell "after" it,
// and the next span skipped it as a kick at its own start. A kick now belongs to the span that ends at or after it and starts
// before it, the times all being seconds on the one integration clock: no date, no tolerance.)
//
// Truth is the two-body problem in 60-digit arithmetic (tests/lib/keplerReference.mjs): the orbit through the state, kick by
// kick (tests/lib/impulseTruth.mjs). Nothing here integrates.
//
//   1. a kick at a sample epoch, with a sample before it and a sample after it: before is the unkicked orbit, the sample at the
//      kick is the state after it, after and the final state follow the kicked orbit;
//   2. a kick at each of several sample epochs, one after the other;
//   3. a kick at a space-weather span break (drag on NRLMSISE-00 breaks the arc at every 3 h UTC boundary), the kick and a
//      sample given in UTC at the boundary;
//   4. a kick at the final target epoch, and a kick after it (which no sample sees);
//   5. an impulse before the initial epoch is refused by name;
//   6. lane parity: the browser and WasmEdge answers are identical bytes.
//
//   node propagator/ffm/tests/sample-epoch-impulse.e2e.mjs
import { createHash } from 'node:crypto';
import { destroyLanes } from './lib/planetary.mjs';
import { ask, at, base, calibrate, chain, check, DV, failures, HALF, QUARTER, report, SAMPLE, setTtPerLabel, SPAN, state, T0 } from './lib/impulseTruth.mjs';

process.env.PATH = `${process.env.HOME}/.wasmedge/bin:${process.env.PATH}`;
const kick = (dv, seconds) => ({ epochJD: at(seconds), deltaV: dv });
const DV2 = [-0.0015, 0.0022, 0.0009], DV3 = [0.0007, -0.0011, 0.0018];
const unkicked = (seconds) => chain([], seconds);

// A weather break at 03:00 UTC on 2023-02-25 (JD 2460000.625 UTC), the arc starting at T0 (a TDB label) and lasting 1/4 d. The
// closed form needs the break's time on the integration clock to a millisecond (7.6 km/s): the module reports the duration of an
// arc to any target epoch, in any time scale, so a probe request to that epoch gives it. Nothing else is taken from the module.
const ARC = 21600;                                                  // 1/4 d
const UTC_03 = { jd: T0 + 0.125, scale: 'UTC' };
const dragForces = { gravityMode: 'POINT_MASS', j2: false, mu: 398600.4418, drag: true, dragModel: 'NRLMSISE00', areaM2: 1e-9, cd: 2.2, massKg: 1000 };   // a cross-section so small the drag is below the bars

for (const kind of ['browser', 'wasmedge']) {
  console.log(`\n== ${kind} ==`);
  await calibrate(kind);

  console.log('1. a kick at a sample epoch, with a sample before it and one after');
  {
    const o = await ask(kind, { ...base, targetJD: at(SPAN), sampleEpochsJD: [at(QUARTER), at(HALF), at(SAMPLE)], maneuvers: [kick(DV, HALF)] });
    check(!o.error, `kick at a sample epoch: ${o.error}`);
    if (!o.error) {
      report('sample before the kick (1350 s)', state(o.samples[0]), unkicked(QUARTER));
      report('sample at the kick (2700 s), after it', state(o.samples[1]), chain([{ at: HALF, dv: DV }], HALF));
      report('sample after the kick (4050 s)', state(o.samples[2]), chain([{ at: HALF, dv: DV }], SAMPLE));
      report('final (5400 s)', state(o), chain([{ at: HALF, dv: DV }], SPAN));
    }
    const stm = await ask(kind, { ...base, targetJD: at(SPAN), includeSTM: true, sampleEpochsJD: [at(HALF)], maneuvers: [kick(DV, HALF)] });
    check(!stm.error, `kick at a sample epoch with the STM: ${stm.error}`);
    if (!stm.error) report('final with the STM', state(stm), chain([{ at: HALF, dv: DV }], SPAN));
  }

  console.log('2. a kick at each of several sample epochs');
  {
    const kicks = [{ at: QUARTER, dv: DV }, { at: HALF, dv: DV2 }, { at: SAMPLE, dv: DV3 }];
    const o = await ask(kind, { ...base, targetJD: at(SPAN), sampleEpochsJD: kicks.map((k) => at(k.at)), maneuvers: kicks.map((k) => kick(k.dv, k.at)) });
    check(!o.error, `kicks at sample epochs: ${o.error}`);
    if (!o.error) {
      kicks.forEach((k, i) => report(`sample ${i + 1} (${k.at} s), after kick ${i + 1}`, state(o.samples[i]), chain(kicks.slice(0, i + 1), k.at)));
      report('final after all three', state(o), chain(kicks, SPAN));
    }
  }

  console.log('3. a kick at a space-weather span break');
  {
    const arcBase = { ...base, forces: dragForces, weather: { epochUTCJD: T0 }, targetJD: at(ARC) };
    const elapsed = async (jd, scale) => (await ask(kind, { ...arcBase, targetJD: jd, targetTimeScale: scale })).propagatedDeltaSeconds;
    const BREAK = await elapsed(UTC_03.jd, 'UTC'), LATE = await elapsed(at(ARC - 1350)), END = await elapsed(at(ARC));
    setTtPerLabel(1);                                               // the times below are on the integration clock already
    console.log(`  the break is ${BREAK.toFixed(6)} s into the arc, the arc ${END.toFixed(6)} s`);
    const kicked = { epochJD: UTC_03.jd, epochTimeScale: 'UTC', deltaV: DV };
    const o = await ask(kind, { ...arcBase, sampleEpochsJD: [UTC_03, at(ARC - 1350)], maneuvers: [kicked] });
    check(!o.error, `kick at a break: ${o.error}`);
    if (!o.error) {
      report('sample at the break, after the kick', state(o.samples[0]), chain([{ at: BREAK, dv: DV }], BREAK));
      report('sample after the break', state(o.samples[1]), chain([{ at: BREAK, dv: DV }], LATE));
      report('final after the break', state(o), chain([{ at: BREAK, dv: DV }], END));
    }
    const plain = await ask(kind, { ...arcBase, maneuvers: [kicked] });
    check(!plain.error, `kick at a break, no samples: ${plain.error}`);
    if (!plain.error) report('final, no samples', state(plain), chain([{ at: BREAK, dv: DV }], END));
  }

  console.log('4. a kick at the final target epoch, and one after it');
  await calibrate(kind);
  {
    const o = await ask(kind, { ...base, targetJD: at(SPAN), maneuvers: [kick(DV, SPAN)] });
    check(!o.error, `kick at the target: ${o.error}`);
    if (!o.error) report('final with a kick at the target epoch', state(o), chain([{ at: SPAN, dv: DV }], SPAN));
    const after = await ask(kind, { ...base, targetJD: at(SPAN), maneuvers: [kick(DV, SPAN + 1350)] });
    check(!after.error, `kick after the target: ${after.error}`);
    if (!after.error) report('final with a kick after the target epoch', state(after), unkicked(SPAN));
  }

  console.log('5. an impulse before the initial epoch is refused by name');
  {
    const o = await ask(kind, { ...base, targetJD: at(SPAN), maneuvers: [kick(DV, -QUARTER)] });
    check(!!o.error && /invalid-impulse/.test(o.error), `impulse before the initial epoch: ${o.error ?? 'accepted'}`);
    console.log(`  ${o.error ?? 'ACCEPTED'}`);
  }
}

console.log('\n6. lane parity: the browser and WasmEdge answers are identical bytes');
for (const [label, params] of [
  ['kick at a sample epoch', { ...base, targetJD: at(SPAN), includeSTM: true, sampleEpochsJD: [at(QUARTER), at(HALF), at(SAMPLE)], maneuvers: [kick(DV, HALF)] }],
  ['kick at a weather break', { ...base, forces: dragForces, weather: { epochUTCJD: T0 }, targetJD: at(ARC), sampleEpochsJD: [UTC_03], maneuvers: [{ epochJD: UTC_03.jd, epochTimeScale: 'UTC', deltaV: DV }] }]]) {
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
console.log('\nPASS sample-epoch impulse');
