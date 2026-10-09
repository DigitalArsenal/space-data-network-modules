// The ported thermosphere models against the code they were ported from, at
// random arguments covering their altitude range and driver domain:
//   lib/jb2008.h ........... Orekit 13.1 JB2008 (fixtures/atmosphere/jb2008-orekit.json)
//   lib/jacchia_roberts.h .. NASA GMAT JacchiaRobertsAtmosphere (fixtures/atmosphere/jacchia-roberts-gmat.json)
// Both agree to rounding (measured: JB2008 1.8e-14 over 400 points,
// Jacchia-Roberts bit for bit over 2000). Propagation with them:
// orekit_reference (JB2008 J1 cases) and prw_atmospheres.
//
// Jacchia-Roberts is also checked against its own physics, independently of
// GMAT: the diffusion equations integrated numerically from 90 km
// (atmosphere_ports_native.cpp, "integrate") at exospheric temperatures of
// 700-1500 K and 125-500 km. With Roberts' exponential temperature profile
// they reproduce the closed forms (measured 1.6e-4); with Jacchia's
// arctangent profile (SR 313 eq. 13) Roberts' fit is within 4.3 % (measured;
// largest at 200 km) and 2.0 % from 300 km up.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures/atmosphere', name), 'utf8'));

function native(input) {
  const work = mkdtempSync(join(tmpdir(), 'sdn-hpop-atmosphere-ports-'));
  try {
    const binary = join(work, 'ports');
    execFileSync('c++', ['-std=c++17', '-O2', '-I', join(here, '../lib'), join(here, 'atmosphere_ports_native.cpp'), '-o', binary], { stdio: 'pipe' });
    const run = spawnSync(binary, [], { input, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim().split('\n');
  } finally { rmSync(work, { recursive: true, force: true }); }
}

test('JB2008 and Jacchia-Roberts ports reproduce their sources', () => {
  const jb = fixture('jb2008-orekit.json').rows, jr = fixture('jacchia-roberts-gmat.json').rows;
  const out = native([...jb.map((r) => `jb2008 ${r.slice(0, 15).join(' ')}`), ...jr.map((r) => `jacchia-roberts ${r.slice(0, 13).join(' ')}`)].join('\n')).map(Number);
  const worst = (rows, values) => Math.max(...rows.map((r, i) => Math.abs(values[i] - r.at(-1)) / r.at(-1)));
  const wJb = worst(jb, out.slice(0, jb.length)), wJr = worst(jr, out.slice(jb.length));
  assert.ok(wJb < 1e-12, `JB2008 differs from Orekit by ${wJb} (relative)`);
  assert.ok(wJr < 1e-12, `Jacchia-Roberts differs from GMAT by ${wJr} (relative)`);
});

test('Jacchia-Roberts agrees with the diffusion equations integrated numerically', (t) => {
  const grid = [700, 810, 1000, 1200, 1500].flatMap((tinf) => [125, 150, 200, 300, 400, 500].map((z) => [tinf, z]));
  const out = native(grid.map(([tinf, z]) => `integrate ${tinf} ${z}`).join('\n')).map((line) => line.split(' ').map(Number));
  let closed = 0, fit = 0, fitAbove300 = 0;
  out.forEach(([port, roberts, jacchia], i) => {
    const [, z] = grid[i];
    closed = Math.max(closed, Math.abs(roberts / port - 1));
    fit = Math.max(fit, Math.abs(jacchia / port - 1));
    if (z >= 300) fitAbove300 = Math.max(fitAbove300, Math.abs(jacchia / port - 1));
  });
  t.diagnostic(`closed forms against quadrature ${closed.toExponential(2)}; Roberts' profile against Jacchia's ${(100 * fit).toFixed(2)} % (${(100 * fitAbove300).toFixed(2)} % from 300 km)`);
  assert.ok(closed < 5e-4, `closed forms ${closed}`);
  assert.ok(fit < 0.05, `fit ${fit}`);
  assert.ok(fitAbove300 < 0.02, `fit above 300 km ${fitAbove300}`);
});
