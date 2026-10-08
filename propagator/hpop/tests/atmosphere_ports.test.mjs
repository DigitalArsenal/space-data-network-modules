// The ported thermosphere models against the code they were ported from, at
// random arguments covering their altitude range and driver domain:
//   lib/jb2008.h ........... Orekit 13.1 JB2008 (fixtures/atmosphere/jb2008-orekit.json)
//   lib/jacchia_roberts.h .. NASA GMAT JacchiaRobertsAtmosphere (fixtures/atmosphere/jacchia70-gmat.json)
// Both agree to rounding (measured: JB2008 1.8e-14 over 400 points, Jacchia
// 1970 bit for bit over 2000). Propagation with them: orekit_reference
// (JB2008 J1 cases) and prw_contract.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures/atmosphere', name), 'utf8'));

test('JB2008 and Jacchia 1970 ports reproduce their sources', () => {
  const work = mkdtempSync(join(tmpdir(), 'sdn-hpop-atmosphere-ports-'));
  try {
    const binary = join(work, 'ports');
    execFileSync('c++', ['-std=c++17', '-O2', '-I', join(here, '../lib'), join(here, 'atmosphere_ports_native.cpp'), '-o', binary], { stdio: 'pipe' });
    const jb = fixture('jb2008-orekit.json').rows, j70 = fixture('jacchia70-gmat.json').rows;
    const input = [...jb.map((r) => `jb2008 ${r.slice(0, 15).join(' ')}`), ...j70.map((r) => `jacchia70 ${r.slice(0, 13).join(' ')}`)].join('\n');
    const run = spawnSync(binary, [], { input, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const out = run.stdout.trim().split('\n').map(Number);
    const worst = (rows, values) => Math.max(...rows.map((r, i) => Math.abs(values[i] - r.at(-1)) / r.at(-1)));
    const wJb = worst(jb, out.slice(0, jb.length)), wJ70 = worst(j70, out.slice(jb.length));
    assert.ok(wJb < 1e-12, `JB2008 differs from Orekit by ${wJb} (relative)`);
    assert.ok(wJ70 < 1e-12, `Jacchia 1970 differs from GMAT by ${wJ70} (relative)`);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
