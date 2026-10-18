#!/usr/bin/env node
// Orchestration and provenance only. The study's C++ reader evaluates truth.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { packageRoot } from './paths.mjs';

const opt = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!['--study', '--output', '--source-commit'].includes(key) || !process.argv[i + 1])
    throw new Error('Usage: node scripts/export-truth.mjs --study STUDY_ROOT --source-commit FULL_COMMIT [--output DIRECTORY]');
  opt[key.slice(2)] = process.argv[i + 1];
}
if (!opt.study || !/^[0-9a-f]{40}$/.test(opt['source-commit'] ?? ''))
  throw new Error('Supply --study and the full standard C++ commit that generated its T3 files with --source-commit.');
const study = path.resolve(opt.study), output = path.resolve(opt.output ?? path.join(packageRoot, 'tests/fixtures/truth'));
const source = fileURLToPath(new URL('export-truth.cpp', import.meta.url));
const reader = path.join(study, 'harness/src/hxio.h');
const samplingSeconds = 10, durationSeconds = 259200, minimumRows = durationSeconds / samplingSeconds + 1;
const seeds = JSON.parse(fs.readFileSync(path.join(packageRoot, 'tests/fixtures/seeds.json'), 'utf8')).map(row => row.label);
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = (command, argv) => {
  const result = spawnSync(command, argv, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command}: ${result.error ?? result.stderr}`);
  return result.stdout;
};
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ffm-truth-'));
try {
  const binary = path.join(work, 'export-truth');
  run('c++', ['-std=c++17', '-O2', '-ffp-contract=off', '-I', path.dirname(reader), source, '-o', binary]);
  const records = seeds.map(seed => {
    const input = path.join(study, `data/truth/${seed}-T3.st`), file = path.join(work, `${seed}.f64`);
    const record = JSON.parse(run(binary, [input, file, String(samplingSeconds), String(durationSeconds)]));
    if (record.label !== seed || record.rows < minimumRows || record.epochWholeTt !== 838857669 || record.epochFractionTt !== 0.184
        || record.sourceSettings.mode !== 'truth' || record.sourceSettings.integrator !== 2
        || record.sourceSettings.rel !== 1e-14 || record.sourceSettings.abs_km !== 1e-14 || record.sourceSettings.max_step !== 2)
      throw new Error(`${seed}: source is not the expected T3 reference at the fixture epoch.`);
    return { seed, input: `data/truth/${seed}-T3.st`, inputSha256: sha256(input), output: `${seed}.f64`,
      ...record, outputSha256: sha256(file) };
  });
  const metadata = {
    generator: 'scripts/export-truth.cpp using the unchanged study harness/src/hxio.h quintic Hermite reader',
    generatorSha256: sha256(source), readerSha256: sha256(reader), generatedBy: 'scripts/export-truth.mjs',
    standardModuleCppCommit: opt['source-commit'],
    settings: { truth: 'T3', integrator: 'RKF78', relativeTolerance: 1e-14, maximumStepSeconds: 2,
      stops: 'Every 10 s TT, 1 s through eccentric-orbit perigee, and every three-hour UTC weather boundary; accelerations on both sides' },
    epoch: '2026-08-01T12:00:00.000000', epochTimeScale: 'UTC', epochTt: '2026-08-01T12:01:09.184000000',
    sampling: { seconds: samplingSeconds, durationSeconds, includeNativeStops: true, minimumRows, coordinate: 'Elapsed TT seconds from the fixture epoch' },
    timeHandling: 'HXSTAT01 epochs and resident PPE TIME_SYSTEM are TT. Interpolation uses two-part TT differences as hx eval does; no TDB/UTC shift is applied to elapsed seconds. The equations use the standard C++ TT-to-TDB conversion internally.',
    frame: 'GCRF', units: { time: 's', position: 'km', velocity: 'km/s' },
    format: { encoding: 'little-endian IEEE 754 float64', columns: ['secondsSinceFixtureEpoch', 'x', 'y', 'z', 'vx', 'vy', 'vz'] },
    regenerate: `node propagator/ffm/scripts/export-truth.mjs --study ${quote(study)} --source-commit ${quote(opt['source-commit'])}${opt.output ? ` --output ${quote(output)}` : ''}`,
    records,
  };
  fs.mkdirSync(output, { recursive: true });
  for (const seed of seeds) fs.copyFileSync(path.join(work, `${seed}.f64`), path.join(output, `${seed}.f64`));
  fs.writeFileSync(path.join(output, 'truth.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(JSON.stringify({ exported: seeds, samplingSeconds, rowsPerSeed: Object.fromEntries(records.map(row => [row.seed, row.rows])), output }));
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
