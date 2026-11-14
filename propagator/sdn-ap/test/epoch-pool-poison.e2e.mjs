#!/usr/bin/env node
// Synthetic AP, SGP4 and SGP4XP records from epoch-pool.e2e.mjs, TEME, UTC offsets 6/18/30 h.
// Reference: the unmodified module, with every series evaluated serially. Exact equality is
// required: poisoning invalidated temporary values changes neither the theory nor its inputs.
// A serial group detects retained table padding; repeated 4/8/15-thread cases cover scheduling.
// node test/epoch-pool-poison.e2e.mjs [--diagnostic file] [--repetitions 50] [--seed 314159]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { wasmPath, ensureBuilt } from './lib/module.mjs';
import { scratchRoot } from './lib/scratch.mjs';
const arg = (key, fallback) => { const i = process.argv.indexOf(key); return i < 0 ? fallback : process.argv[i + 1]; };
const count = Number(arg('--count', 256)), seed = Number(arg('--seed', 314159));
const repetitions = Number(arg('--repetitions', 50));
assert.ok(Number.isInteger(repetitions) && repetitions > 0);
assert.ok(Number.isInteger(count) && count >= 96);
const test = fileURLToPath(new URL('./epoch-pool.e2e.mjs', import.meta.url));
const root = path.join(scratchRoot, 'epoch-pool-results');
ensureBuilt();
const diagnostic = arg('--diagnostic', null) ?? execFileSync(process.execPath, [test, '--build-only'], { encoding: 'utf8' }).trim().split('\n').at(-1);
function run(label, wasm, threads, extra = []) {
  const text = execFileSync(process.execPath, [test, '--case', '--label', label, '--wasm', wasm,
    '--threads', String(threads), '--count', String(count), '--seed', String(seed), ...extra], { encoding: 'utf8' });
  const result = JSON.parse(text.trim());
  console.log(JSON.stringify(result));
  return { result, bytes: fs.readFileSync(path.join(root, label + '.bin')) };
}
const groupRef = run('poison-group-reference', wasmPath, 0, ['--serial-chunk']);
const group = run('poison-group', diagnostic, 0, ['--serial-chunk']);
assert.equal(groupRef.result.refused, 0);
assert.ok(group.bytes.equals(groupRef.bytes), 'serial group: poisoned evaluation cache must rebuild every value and padded element');
const reference = run('poison-reference', wasmPath, 0, ['--single']);
assert.equal(reference.result.refused, 0);
const covRef = fs.readFileSync(path.join(root, 'poison-reference-cov.bin'));
for (const threads of [4, 8, 15]) for (let repetition = 0; repetition < repetitions; ++repetition) {
  const label = `poison-repeat-${threads}-${repetition}`;
  const got = run(label, diagnostic, threads);
  assert.ok(got.bytes.equals(reference.bytes), `${label}: states and statuses equal serial reference`);
  assert.ok(fs.readFileSync(path.join(root, label + '-cov.bin')).equals(covRef), `${label}: covariances equal serial reference`);
  assert.equal(got.result.refused, 0, `${label}: every state answered`);
}
console.log(`PASS: serial group and ${repetitions} repetitions at each of 4, 8 and 15 threads; seed ${seed}`);
