// Host orchestration only; all reference physics and comparisons run in C++.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
test('analytical force Jacobians match closed forms and independent force differences', () => {
  const work = mkdtempSync(join(tmpdir(), 'hpop-force-partials-'));
  const lib = join(here, '../lib');
  const nrl = join(repo, 'third_party/nrlmsise00');
  try {
    const objects = ['nrlmsise-00.c', 'nrlmsise-00_data.c'].map(name => {
      const object = join(work, `${name}.o`);
      execFileSync('cc', ['-std=c11', '-O2', '-c', join(nrl, name), '-o', object], { stdio: 'pipe' });
      return object;
    });
    const binary = join(work, 'force-partials');
    const sources = ['astrodynamics', 'coords', 'ephemeris', 'environment_models',
      'force_models', 'force_partials', 'integrators', 'nrlmsise00', 'time_convert',
      'us76', 'atmosphere_plugin'].map(name => join(lib, `${name}.cpp`));
    execFileSync('c++', ['-std=c++17', '-O2', '-I', lib, '-I', nrl,
      join(here, 'force_partials_native.cpp'), ...sources, ...objects, '-o', binary], { stdio: 'pipe' });
    const run = spawnSync(binary, [], { encoding: 'utf8' });
    process.stdout.write(run.stdout ?? '');
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /PASS force partials cases=\d+ failures=0/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
