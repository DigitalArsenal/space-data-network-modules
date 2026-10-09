// HPOP against GMAT, Tudat (native and WebAssembly), Nyx and Orekit on the
// same initial states, force sets and constants: five orbits (LEO400,
// SSO700, GPS, GEO, MOLNIYA) with point mass, J2, the 20x20 field, + Sun and
// Moon, + radiation pressure, and on LEO400 and SSO700 + drag
// (fixtures/xval/xval-cases.json), each 24 h with hourly samples. The methods, every tool's version and data files, and what
// each tool models differently are in docs/cross-validation.md.
//
// Authorities, all independent of HPOP, none regenerated here:
//   Orekit 13.1 ....... fixtures/orekit/orekit-reference.json (OrekitReference.java)
//   GMAT R2022a ....... fixtures/gmat/gmat-reference.json (make-gmat-reference.mjs)
//   Tudat, tudatpy .... fixtures/tudat/tudatpy-reference.json (tudat_reference.py)
//   Tudat WASM ........ fixtures/tudat/tudat-wasm-reference.json (tudat-wasm-reference.mjs)
//   Nyx 2.6.0 ......... fixtures/nyx/nyx-reference.json (make-nyx-reference.mjs)
// Every tool starts from the Orekit file's GCRF state and uses its constants,
// field coefficients (HPOP's EGM2008 20x20), DE440 Sun and Moon, IERS EOP rows
// and constant space weather; GMAT's drag cases are Jacchia-Roberts (its
// macOS build has no NRLMSISE-00), and HPOP is asked for the same. Nyx's
// Earth orientation is JPL's BPC, not the IERS rows (4.8-6.5 mas apart).
//
// Tolerances are per tool and force class (tests/lib/xvalCases.mjs): the
// tool's measured spread from Orekit plus HPOP's Orekit tolerance. The test
// "reference spread" checks the tools against each other, so a regenerated
// reference that drifted is caught on its own.
//
// GMAT's Jacchia-Roberts takes the Sun's hour angle and declination in its
// MJ2000Eq axes; HPOP takes them in Earth-fixed axes, on the true equator of
// the date (0.15 deg of precession from J2000 by 2026). That alone leaves
// LEO400 1.4 m from GMAT after a day of 44 km of drag (SSO700 0.17 m);
// HPOP given GMAT's axes is 2.4 cm (1.0 cm) from it (measured), so the GMAT
// drag limit is that axes difference plus HPOP's Orekit drag tolerance.
//
// Lanes: the browser harness by default; HPOP_XVAL_RUNTIMES=browser,wasmedge
// adds the SDK's native WasmEdge runner (about 15 min for the 29 runs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { residentHarness } from './lib/residentRuntime.mjs';
import { CASES, TOLERANCE_M, TOOLS, difference, forceClass, hpopInputs, hpopSamples } from './lib/xvalCases.mjs';

const LANES = (process.env.HPOP_XVAL_RUNTIMES ?? 'browser').split(',').filter(Boolean);

for (const lane of LANES) {
  for (const name of CASES) {
    // One HPOP run per distinct request: the NRLMSISE-00 cases (Orekit,
    // Tudat) and, for GMAT's drag cases, Jacchia-Roberts.
    const groups = new Map();
    for (const tool of TOOLS) {
      const c = tool.cases.get(name);
      if (!c) continue;
      const key = c.atmosphere ?? 'NRLMSISE00';
      if (!groups.has(key)) groups.set(key, { c, tools: [] });
      groups.get(key).tools.push(tool);
    }
    for (const [atmosphere, { c, tools }] of groups) {
      const label = `${name}${atmosphere === 'NRLMSISE00' ? '' : ` (${atmosphere})`}`;
      test(`HPOP (${lane}) against ${tools.map((t) => t.label).join(', ')}: ${label}`, async (t) => {
        const harness = await residentHarness(lane);
        t.after(() => harness.destroy());
        const response = await harness.invoke({ methodId: 'invoke', inputs: hpopInputs(c) });
        assert.equal(response.statusCode, 0, `${label}: ${response.errorCode}: ${response.errorMessage}`);
        const hpop = hpopSamples(c, response);
        const failures = [];
        for (const tool of tools) {
          const { worst, worstAt } = difference(hpop, tool.cases.get(name).samples);
          const limit = TOLERANCE_M[tool.id][forceClass(c)];
          t.diagnostic(`${label} vs ${tool.label}: ${worst.toExponential(3)} m at ${worstAt / 3600} h (limit ${limit} m)`);
          if (!(worst <= limit)) failures.push(`${tool.label} ${worst.toExponential(3)} m > ${limit} m`);
        }
        assert.deepEqual(failures, [], `${label}: ${failures.join('; ')}`);
      });
    }
  }
}

// The spread among the established codes themselves, pair by pair, on the
// cases they model alike (GMAT's Jacchia-Roberts drag is not compared with
// NRLMSISE-00). The bounds are the tolerances above for the less exact tool
// of the pair; the measured values are in docs/cross-validation.md.
test('Reference spread: Orekit, GMAT, Tudat and Nyx agree with each other', (t) => {
  const failures = [];
  for (const name of CASES) {
    for (let i = 0; i < TOOLS.length; ++i) for (let j = i + 1; j < TOOLS.length; ++j) {
      const a = TOOLS[i].cases.get(name), b = TOOLS[j].cases.get(name);
      if (!a || !b || (a.atmosphere ?? 'NRLMSISE00') !== (b.atmosphere ?? 'NRLMSISE00')) continue;
      const { worst } = difference(a.samples, b.samples);
      const limit = Math.max(TOLERANCE_M[TOOLS[i].id][forceClass(a)], TOLERANCE_M[TOOLS[j].id][forceClass(a)]);
      t.diagnostic(`${name}: ${TOOLS[i].label} - ${TOOLS[j].label} ${worst.toExponential(3)} m (limit ${limit} m)`);
      if (!(worst <= limit)) failures.push(`${name} ${TOOLS[i].id}/${TOOLS[j].id} ${worst.toExponential(3)} m`);
    }
  }
  assert.deepEqual(failures, []);
});
