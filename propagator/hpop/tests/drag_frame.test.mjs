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
test('drag density and HWM14 winds use Earth-fixed axes', () => {
  const work = mkdtempSync(join(tmpdir(), 'hpop-drag-frame-'));
  const lib = join(here, '../lib');
  const nrl = join(repo, 'third_party/nrlmsise00');
  try {
    const objects = ['nrlmsise-00.c', 'nrlmsise-00_data.c'].map(name => {
      const object = join(work, `${name}.o`);
      execFileSync('cc', ['-std=c11', '-O2', '-c', join(nrl, name), '-o', object], { stdio: 'pipe' });
      return object;
    });
    const binary = join(work, 'drag-frame');
    const sources = ['astrodynamics', 'coords', 'ephemeris', 'environment_models',
      'force_models','atmosphere_winds', 'force_partials', 'integrators', 'nrlmsise00', 'time_convert',
      'us76', 'atmosphere_plugin'].map(name => join(lib, `${name}.cpp`));
    execFileSync('c++', ['-std=c++17', '-O2', '-I', lib, '-I',nrl,'-I',join(repo,'third_party/hwm14'),join(repo,'third_party/hwm14/hwm14.cpp'),join(repo,'third_party/hwm14/hwm14_data.cpp'),
      join(here, 'drag_frame_native.cpp'), ...sources, ...objects, '-o', binary], { stdio: 'pipe' });
    const run = spawnSync(binary, [], { encoding: 'utf8' });
    process.stdout.write(run.stdout ?? '');
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /PASS drag frame cases=\d+ failures=0/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
