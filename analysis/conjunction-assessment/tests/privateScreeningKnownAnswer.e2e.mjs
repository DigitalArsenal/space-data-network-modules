#!/usr/bin/env node
// Private screening protocol: known answers against plaintext screening
// (private-screening/PROTOCOL-19.md, section 3, acceptance lines 1-13).
//
// Builds private-screening/ (SEAL 4.1.1 and the FlatBuffers fork's batching
// API at the pinned commit), runs the driver for one day at 1 s on the
// registered pairs, checks every acceptance line exactly and writes the
// known-answer table to private-screening/results/known-answer.json and the
// whole run to private-screening/results/protocol-run.json.
//
//   node tests/privateScreeningKnownAnswer.e2e.mjs
// PRIVATE_SCREENING_BUILD_DIR sets the build directory (default: a per-checkout
// directory under the system temp directory); FLATBUFFERS_HE_SOURCE_DIR names a
// local checkout of the fork commit instead of fetching it; PRIVATE_SCREENING_RUN
// names an existing driver output to check instead of running the driver.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../private-screening');
const results = join(source, 'results');
const buildDir = process.env.PRIVATE_SCREENING_BUILD_DIR ||
  join(tmpdir(), `private-screening-protocol-${createHash('sha256').update(source).digest('hex').slice(0, 12)}`);

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.status !== 0) {
    process.stderr.write(`${cmd} ${args.join(' ')} failed (${r.status})\n${(r.stdout || '').slice(-4000)}${(r.stderr || '').slice(-4000)}\n`);
    process.exit(1);
  }
  return r.stdout;
}

export function runDriver() {
  if (process.env.PRIVATE_SCREENING_RUN) return JSON.parse(readFileSync(process.env.PRIVATE_SCREENING_RUN, 'utf8'));
  mkdirSync(buildDir, { recursive: true });
  const generator = spawnSync('ninja', ['--version']).status === 0 ? ['-G', 'Ninja'] : [];
  const fork = process.env.FLATBUFFERS_HE_SOURCE_DIR ? [`-DFLATBUFFERS_HE_SOURCE_DIR=${process.env.FLATBUFFERS_HE_SOURCE_DIR}`] : [];
  if (!existsSync(join(buildDir, 'CMakeCache.txt'))) {
    run('cmake', ['-S', source, '-B', buildDir, ...generator, '-DCMAKE_BUILD_TYPE=Release', ...fork]);
  }
  run('cmake', ['--build', buildDir, '-j', '12']);
  // The physics check of the twelve tracks runs on 12 workers (each with its
  // own per-window keys); the cost table of record is the serial run
  // (results/cost.json, --threads 1).
  const threads = process.env.PRIVATE_SCREENING_THREADS || '12';
  const r = spawnSync(join(buildDir, 'private_screening_protocol'), ['--days', '1', '--pairs', '8', '--seed', '1', '--threads', threads], { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.stdout.length === 0) { process.stderr.write(`driver produced no output (${r.status})\n${r.stderr}\n`); process.exit(1); }
  return JSON.parse(r.stdout);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const report = runDriver();
  const failures = [];
  const check = (ok, what) => { if (!ok) failures.push(what); };

  check(report.steps === 86400 && report.stepSeconds === 1 && report.days === 1, `one day at 1 s (${report.steps} steps)`);
  check(report.pairs.length === 8, `8 pairs (${report.pairs.length})`);
  // R'^2 = R^2 + (v_max dt / 2)^2 = 25e6 + 7750^2 = 85,062,500 m^2 exactly (the registration's
  // 85,061,864 was an arithmetic slip; the formula is the registered quantity).
  check(Math.abs(report.testedThresholdM - 9222.9) < 0.1 && report.testedThresholdM2 === 85062500, `R' ${report.testedThresholdM} m, R'^2 ${report.testedThresholdM2}`);
  check(report.parameters.screening.n === 8192 && report.parameters.screening.depth === 1, 'screening at n 8192, depth 1');
  check(report.parameters.physics.n === 16384 && report.parameters.physics.depth === 3 && report.parameters.physics.strideSeconds === 60, 'physics check at n 16384, depth 3, stride 60 s');

  // 1. Alert steps identical; signMismatches 0.
  for (const p of report.pairs) {
    check(p.protocolAlertSteps === p.plaintextAlertSteps && JSON.stringify(p.protocolAlerts) === JSON.stringify(p.plaintextAlerts),
      `${p.pair}: alert steps protocol ${p.protocolAlertSteps} vs plaintext ${p.plaintextAlertSteps}`);
    check(p.signMismatches === 0, `${p.pair}: signMismatches ${p.signMismatches}`);
  }
  check(report.signMismatches === 0, `signMismatches ${report.signMismatches}`);
  // 2. The true conjunction is not missed; the control raises none.
  for (const p of report.pairs) {
    if (p.designedMissKm < report.thresholdKm) check(p.protocolAlertSteps >= 1, `${p.pair}: designed ${p.designedMissKm} km, ${p.protocolAlertSteps} alert steps`);
    else check(p.protocolAlertSteps === 0, `${p.pair}: control ${p.designedMissKm} km, ${p.protocolAlertSteps} alert steps`);
  }
  // 3. Encrypted on both sides: no public track read in screening.
  check(report.publicTracksRead.screening === 0, `publicTracksRead.screening ${report.publicTracksRead.screening}`);
  // 4. B squares itself: exact values, 3 ct x ct per block, 3 vectors submitted.
  check(report.valueMismatches === 0, `valueMismatches ${report.valueMismatches}`);
  check(report.ctxCtMultipliesPerBlock.screening === 3 && report.submittedVectorsPerBlock === 3,
    `ctxCtMultipliesPerBlock.screening ${report.ctxCtMultipliesPerBlock.screening}, submittedVectorsPerBlock ${report.submittedVectorsPerBlock}`);
  // 5 and 12. Anchor-free physics check: exact, real-motion tracks pass, probes fail.
  const probes = ['constant-velocity', 'mean motion', 'teleport', 'scaled'];
  for (const t of report.physics) {
    check(t.mismatches === 0, `physics ${t.track}: ${t.mismatches} mismatches against the plaintext big integers`);
    check(t.stepsChecked === 86400 - 120, `physics ${t.track}: ${t.stepsChecked} steps checked`);
    const probe = probes.some((p) => t.track.includes(p));
    if (probe) check(t.failSteps >= 1, `physics probe ${t.track}: ${t.failSteps} fail steps`);
    else check(t.failSteps === 0 && t.passSteps === t.stepsChecked, `physics ${t.track}: ${t.failSteps} fail steps of ${t.stepsChecked}`);
  }
  const tracked = report.physics.filter((t) => !probes.some((p) => t.track.includes(p)));
  // A and the eight B tracks (the seven encounters and the 60 km control are all two-body orbits).
  check(tracked.length === 9, `${tracked.length} two-body tracks checked (A and the eight B)`);
  check(report.physics.filter((t) => probes.some((p) => t.track.includes(p))).length === 4, 'four fabricated probes');
  check(report.ctxCtMultipliesPerBlock.physics === 21, `ctxCtMultipliesPerBlock.physics ${report.ctxCtMultipliesPerBlock.physics}`);
  // 6. Tube check.
  check(report.tube.A.outsideSteps === 0 && report.tube.A.valueMismatches === 0, `tube A: ${report.tube.A.outsideSteps} outside steps`);
  check(report.tube.line.outsideSteps >= 1 && report.tube.line.firstOutsideStep >= 3600 && report.tube.line.firstOutsideStep < 4200,
    `tube line: ${report.tube.line.outsideSteps} outside, first ${report.tube.line.firstOutsideStep}`);
  // 7. Requester-held keys.
  check(report.responderHasSecretKey === false, 'responder holds no secret key');
  check(report.ctxCtMultipliesPerBlock.tube === 3, `ctxCtMultipliesPerBlock.tube ${report.ctxCtMultipliesPerBlock.tube}`);
  // 8. Laplace noise never hides a real alert. Extra alerts: eta is truncated at
  // -S, so d^2 + eta < (R' + s)^2 reaches d < sqrt((R' + s)^2 + S) = 11,589 m,
  // not R' + s as the registration wrote (a derivation slip found at the first
  // run; the mechanism is unchanged and both counts are reported).
  const extraBoundM = Math.sqrt(report.noise.raisedThresholdM2 + report.noise.truncationM2);
  for (const p of report.pairs) {
    check(p.noise.missedAlerts === 0, `${p.pair}: noise missed ${p.noise.missedAlerts}`);
    check(p.noise.extraAlerts === 0 || p.noise.maxExtraDistanceM <= extraBoundM,
      `${p.pair}: extra alert at ${p.noise.maxExtraDistanceM} m beyond the derived bound ${extraBoundM.toFixed(1)} m`);
  }
  // 9. No decoys.
  check(report.decoys === 0, `decoys ${report.decoys}`);
  // 10. maskLeakage reported, not private.
  check(typeof report.maskLeakage.withinFactor2InDistance === 'number' && report.maskLeakage.private === false, 'maskLeakage reported');
  // 11. What B returns; the reconstruction attempt fails.
  check(report.returnedCiphertextsPerBlock.tube === 1 && report.returnedCiphertextsPerBlock.screening === 1 && report.returnedCiphertextsPerBlock.physics === 2, 'returnedCiphertextsPerBlock 1/1/2');
  check(report.reconstruction.steps === 8192 && report.reconstruction.distanceWithinFactor2Share <= 0.001,
    `reconstruction: distance within a factor of 2 at ${report.reconstruction.distanceWithinFactor2Share} of steps`);
  // 13. Breadth.
  const b = report.breadth;
  // The margin R' guarantees an alert for a pair within R, not within R': a
  // designed miss in (R, R') can fall between two 1 s samples with its sampled
  // minimum above R'. The registration's miss rule named R' (a slip found at
  // the first run); the miss count below R is the guarantee, and both counts
  // are reported.
  check(b.geometries === 200 && b.missesBelowR === 0 && b.signMismatches === 0 && b.valueMismatches === 0,
    `breadth: ${b.geometries} geometries, misses below R ${b.missesBelowR}, signMismatches ${b.signMismatches}, valueMismatches ${b.valueMismatches}`);
  check(b.geometriesWithExtraBeyondBound === 0, `breadth: ${b.geometriesWithExtraBeyondBound} geometries with an extra alert beyond the derived bound ${b.extraAlertBoundM} m`);
  const wilson = (k, n) => {
    const z = 1.959964, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return [(c - h) / d, (c + h) / d];
  };
  const [lo, hi] = wilson(b.falseAlertStepsAtNoiseThreshold, b.stepsBeyondRprime);

  const table = {
    verdict: failures.length ? 'FAIL' : 'PASS',
    registered: 'private-screening/PROTOCOL-19.md',
    forkCommit: report.forkCommit,
    steps: report.steps,
    testedThresholdM: report.testedThresholdM,
    pairs: report.pairs.map((p) => ({ pair: p.pair, designedMissKm: p.designedMissKm, plaintextAlertSteps: p.plaintextAlertSteps, protocolAlertSteps: p.protocolAlertSteps,
      alertSteps: p.plaintextAlerts, signMismatches: p.signMismatches, valueMismatches: p.valueMismatches, noise: p.noise })),
    signMismatches: report.signMismatches,
    valueMismatches: report.valueMismatches,
    minNoiseBudgetBits: report.minNoiseBudgetBits,
    responderHasSecretKey: report.responderHasSecretKey,
    ctxCtMultipliesPerBlock: report.ctxCtMultipliesPerBlock,
    returnedCiphertextsPerBlock: report.returnedCiphertextsPerBlock,
    submittedVectorsPerBlock: report.submittedVectorsPerBlock,
    decoys: report.decoys,
    tube: report.tube,
    physics: report.physics.map((t) => ({ track: t.track, stepsChecked: t.stepsChecked, passSteps: t.passSteps, failSteps: t.failSteps, mismatches: t.mismatches, firstFailStep: t.firstFailStep })),
    realTracks: { swarm: 'not measured', sentinel1: 'not measured', gps: 'not measured', gate: 'real tracks passing the physics check is a gate beside S4 before the feature is offered on any host or the console' },
    reconstruction: report.reconstruction,
    breadth: { ...b, registeredFormMissesBelowRprime: b.misses, registeredFormExtraBeyondRprimePlusS: b.geometriesWithExtraBeyondRprimePlusS,
      falseAlertRateAtNoiseThreshold: b.falseAlertStepsAtNoiseThreshold / b.stepsBeyondRprime, wilson95: [lo, hi] },
    registrationSlips: [
      "R'^2 is 85,062,500 m^2 from the registered formula; the registration wrote 85,061,864",
      "the noise pass's extra alerts reach sqrt((R' + s)^2 + S), not R' + s; the mechanism is as registered",
      "the margin R' guarantees alerts for misses below R, not below R'; misses below R' are reported as registered and misses below R are the guarantee",
    ],
    maskLeakage: report.maskLeakage,
    comparisonS4: 'not built; decisions through the oracle; the feature is offered on no host and no console',
    failures: failures.slice(0, 40),
  };
  mkdirSync(results, { recursive: true });
  writeFileSync(join(results, 'protocol-run.json'), `${JSON.stringify(report, null, 1)}\n`);
  writeFileSync(join(results, 'known-answer.json'), `${JSON.stringify(table, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(table, null, 2)}\n`);
  process.exit(failures.length ? 1 : 0);
}
