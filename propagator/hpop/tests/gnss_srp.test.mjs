// Host orchestration only: the GNSS box-wing and ECOM2 radiation pressure of
// lib/gnss_srp.h against Orekit 13.1 (tests/fixtures/orekit/
// orekit-gnss-srp-reference.json, OrekitGnssSrpReference.java). Sources,
// units, frames, time scales and tolerances are in tests/gnss_srp_native.cpp,
// which does every comparison.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
test('GNSS box-wing and ECOM2 radiation pressure match Orekit 13.1', (t) => {
  if (spawnSync('c++', ['--version'], { stdio: 'ignore' }).status !== 0) return t.skip('host C++ compiler unavailable');
  const work = mkdtempSync(join(tmpdir(), 'hpop-gnss-srp-'));
  const lib = join(here, '../lib'), nrl = join(repo, 'third_party/nrlmsise00');
  try {
    const reference = JSON.parse(readFileSync(join(here, 'fixtures/orekit/orekit-gnss-srp-reference.json'), 'utf8'));
    const lines = [`kernel ${join(repo, 'files/orbit-products/tests/fixtures/de440/de440-2026.bsp')}`, `ecom2 ${reference.ecom2.join(' ')}`];
    for (const c of reference.cases) {
      lines.push(`case ${c.name} ${c.block} ${c.model} ${c.massKg} ${c.samples.length}`);
      c.samples.forEach((s, i) => lines.push(['s', ...s, ...c.acceleration[i], ...c.stm[i], ...(c.parameterJacobian ? c.parameterJacobian[i] : [])].join(' ')));
    }
    const input = join(work, 'input.txt');
    writeFileSync(input, `${lines.join('\n')}\n`);
    const objects = ['nrlmsise-00.c', 'nrlmsise-00_data.c'].map((name) => {
      const object = join(work, `${name}.o`);
      execFileSync('cc', ['-std=c11', '-O2', '-c', join(nrl, name), '-o', object], { stdio: 'pipe' });
      return object;
    });
    const binary = join(work, 'gnss-srp');
    const sources = ['astrodynamics', 'coords', 'ephemeris', 'environment_models', 'force_models', 'atmosphere_winds',
      'force_partials', 'integrators', 'variational', 'finite_burn', 'nrlmsise00', 'time_convert', 'us76', 'atmosphere_plugin'].map((name) => join(lib, `${name}.cpp`));
    execFileSync('c++', ['-std=c++17', '-O2', '-I', lib, '-I', nrl, '-I', join(repo, 'third_party/hwm14'), join(repo, 'third_party/hwm14/hwm14.cpp'),
      join(repo, 'third_party/hwm14/hwm14_data.cpp'), join(here, 'gnss_srp_native.cpp'), ...sources, ...objects, '-o', binary], { stdio: 'pipe' });
    const run = spawnSync(binary, [input], { encoding: 'utf8' });
    process.stdout.write(run.stdout ?? '');
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /PASS gnss srp cases=4 failures=0/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
