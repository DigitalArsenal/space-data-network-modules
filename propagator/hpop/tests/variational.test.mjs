// JavaScript orchestrates compilation/execution only. All numerical reference
// calculations, sampling, and actual propagation are C++ in the native harness.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');

test('HPOP variational equations: independent Kepler STM, J2, covariance and timing', (t) => {
  if (spawnSync('c++', ['--version'], { stdio: 'ignore' }).status !== 0) {
    return t.skip('host C++ compiler unavailable; numerical evidence not produced');
  }
  const work = mkdtempSync(join(tmpdir(), 'sdn-hpop-variational-'));
  const lib = join(here, '../lib');
  const nrl = join(repo, 'third_party/nrlmsise00');
  try {
    const objects = [];
    for (const name of ['nrlmsise-00.c', 'nrlmsise-00_data.c']) {
      const object = join(work, `${name}.o`);
      objects.push(object);
      execFileSync('cc', ['-std=c11', '-O2', '-c', join(nrl, name), '-o', object], { stdio: 'pipe' });
    }
    const binary = join(work, 'variational');
    execFileSync('c++', ['-std=c++17', '-O2', '-I', lib, '-I', nrl,
      join(here, 'variational_native.cpp'),
      ...['astrodynamics', 'coords', 'ephemeris', 'environment_models', 'force_models',
        'force_partials', 'variational', 'integrators', 'nrlmsise00', 'time_convert',
        'us76', 'atmosphere_plugin'].map(name => join(lib, `${name}.cpp`)),
      ...objects, '-o', binary], { stdio: 'pipe' });
    // Explicit maintainer mode: regenerate solely from the independent closed-
    // form reference. Normal test runs never modify the committed fixture.
    if (process.env.HPOP_EMIT_KEPLER_REFERENCE === '1') {
      writeFileSync(join(here, 'variational-kepler-reference.json'),
        execFileSync(binary, ['--emit-reference'], { encoding: 'utf8' }));
    }
    const skipTiming = process.env.HPOP_SKIP_VARIATIONAL_TIMING === '1';
    const run = spawnSync(binary, skipTiming ? ['--skip-timing'] : [], { encoding: 'utf8', timeout: 180_000 });
    process.stdout.write(run.stdout ?? '');
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}\n${run.error ?? ''}`);
    assert.match(run.stdout, /PASS HPOP variational .* failures=0/);
    assert.match(run.stdout, /RESULT kepler_eccentric_1_orbit .* PASS/);
    assert.match(run.stdout, /RESULT J2_STM_Richardson .* PASS/);
    assert.match(run.stdout, /RESULT J2_determinant .* PASS/);
    assert.match(run.stdout, /RESULT covariance_1000_Wishart_z .* PASS/);
    assert.match(run.stdout, /RESULT impulse_chain_sample_2 .* PASS/);
    if (!skipTiming) assert.match(run.stdout, /TIMING 24h_LEO_J2 .*speedup=/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
