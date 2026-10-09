// The cross-validation reference sets (tests/fixtures/{orekit,gmat,tudat})
// as HPOP requests, and how trajectories are compared. Representation only:
// the requests reuse the Orekit cases' encoding (orekitCases.mjs) and the
// comparison is a difference of positions.
import fs from 'node:fs';
import { requestInputs } from './orekitCases.mjs';
import { decodeResult, sds } from './prwCodec.mjs';

const read = (path) => JSON.parse(fs.readFileSync(new URL(`../fixtures/${path}`, import.meta.url), 'utf8'));
export const CASES = read('xval/xval-cases.json').cases;

// Each tool's trajectories, by case name ("LEO400 F5-field-sun-moon-srp").
const byName = (set) => new Map(set.cases.filter((c) => CASES.includes(`${c.orbit} ${c.forces}`)).map((c) => [`${c.orbit} ${c.forces}`, c]));
export const TOOLS = [
  { id: 'orekit', label: 'Orekit 13.1', set: read('orekit/orekit-reference.json') },
  { id: 'gmat', label: 'GMAT R2022a', set: read('gmat/gmat-reference.json') },
  { id: 'tudatpy', label: 'Tudat (tudatpy 1.0.0)', set: read('tudat/tudatpy-reference.json') },
  { id: 'tudat-wasm', label: 'Tudat WASM', set: read('tudat/tudat-wasm-reference.json') },
  { id: 'nyx', label: 'Nyx 2.6.0', set: read('nyx/nyx-reference.json') },
].map((tool) => ({ ...tool, cases: byName(tool.set) }));

export const forceClass = (c) => (c.drag ? 'drag' : c.srp ? 'srp' : c.degree > 0 || c.thirdBodies ? 'gravity' : 'pointMass');

// HPOP against each tool: the largest 3D position difference over the 24 h
// (25 hourly samples), in metres. Each limit is the tool's documented model
// difference from Orekit for that class (docs/cross-validation.md) plus
// HPOP's own Orekit tolerance (orekit_reference.test.mjs), rounded up: a
// limit says how far apart two correct codes can be given that tool's
// stated differences, not how close HPOP happened to land. Measured
// 2026-10-09 (HPOP against the tool; the tool against Orekit):
//   Orekit ....... HPOP's Orekit tolerances (1 mm; 5 cm; 10 cm; 10 cm)
//   GMAT ......... epochs carried as a double MJD (samples within ~0.15 us
//                  of the hour: 1 mm LEO, 4.5 mm MOLNIYA perigee), its FK5
//                  Earth orientation and the 0.13 mas/day drift of its ICRF
//                  tie: point mass <= 4.2 mm (4.5 mm); field, Sun, Moon and
//                  radiation pressure <= 2.7 cm (2.2 cm); drag is
//                  Jacchia-Roberts on both sides, whose Sun hour angle
//                  and declination GMAT takes in MJ2000Eq axes and HPOP
//                  on the true equator of date: LEO400 <= 1.4 m (with
//                  GMAT's axes 2.4 cm)
//   Tudat ........ a TT clock given to a TDB-based code (ephemerides and
//                  Earth rotation read 0.75 ms off), fixed steps, and with
//                  drag an ellipsoidal Earth whose mean radius (6371.0 km)
//                  is then also its shadow: point mass <= 0.05 mm (0.6 mm);
//                  field, Sun, Moon <= 1.1 cm (1.7 mm); radiation pressure
//                  <= 1.1 cm (1.0 mm); drag <= 6.0 cm (5.4 cm)
//   Tudat WASM ... the same setup as Tudat, so the same limits
//   Nyx .......... Earth orientation from JPL's earth_latest_high_prec.bpc,
//                  whose pole is 4.8-6.5 mas from the IERS 2010 pole with
//                  the Orekit file's EOP rows (measured), and pck08's Sun
//                  radius for the shadow: point mass <= 0.6 mm (0.6 mm);
//                  field (J2 alone as much as 20x20), Sun, Moon, radiation
//                  pressure <= 10.4 cm (10.4 cm); its NRLMSISE-00 drag leaves
//                  LEO400 12.1 m from Orekit after a day (2.8e-4 of the 44 km
//                  drag effect; SSO700 2 cm), a difference not isolated here
export const TOLERANCE_M = {
  orekit: { pointMass: 1e-3, gravity: 0.05, srp: 0.1, drag: 0.1 },
  gmat: { pointMass: 0.01, gravity: 0.05, srp: 0.1, drag: 1.5 },
  tudatpy: { pointMass: 2e-3, gravity: 0.05, srp: 0.1, drag: 0.1 },
  'tudat-wasm': { pointMass: 2e-3, gravity: 0.05, srp: 0.1, drag: 0.1 },
  nyx: { pointMass: 2e-3, gravity: 0.2, srp: 0.2, drag: 20 },
};

// The request for one tool's case. GMAT's drag cases are Jacchia-Roberts
// (gmat-reference.json says why); every other case is the Orekit request.
export function hpopInputs(c) {
  return requestInputs(c, { edit: (exec) => { if (c.atmosphere === 'JACCHIA_ROBERTS') exec.FORCES.ATMOSPHERE_MODEL = sds.prwAtmosphereFamily.JACCHIA_ROBERTS; } });
}

// {worst, worstAt} between two sample lists ([t, x, y, z, ...], metres).
export function difference(a, b) {
  let worst = 0, worstAt = 0;
  a.forEach((s, i) => {
    const d = Math.hypot(s[1] - b[i][1], s[2] - b[i][2], s[3] - b[i][3]);
    if (d > worst) { worst = d; worstAt = s[0]; }
  });
  return { worst, worstAt };
}

// HPOP's decoded response as the same sample rows (epoch first).
export function hpopSamples(c, response) {
  const result = decodeResult(response);
  return [c.samples[0], ...result.samples.map((s, i) => [c.samples[i + 1][0], ...s.position.map((x) => x * 1000)])];
}
