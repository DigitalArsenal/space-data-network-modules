// FFM against Orekit 13.1 on identical initial states, force sets and
// constants: five orbits (LEO400, SSO700, GPS, GEO, MOLNIYA) by ten force
// sets, plus the PRW SDS 1.240.0 additions on LEO400, SSO700 and GPS, each
// propagated for 24 h and compared hourly.
//
// Authority: Orekit (CS GROUP, Apache-2.0), the parity authority this repo
// already uses for foundation/time. tests/fixtures/orekit/OrekitReference.java
// generated tests/fixtures/orekit/orekit-reference.json; nothing here
// regenerates it. The two sides share, by construction:
//   - constants: EGM2008's TT-compatible GM 3.986004415e14 m^3/s^2 and radius
//     6378136.3 m, the coefficients FFM embeds (make-gfc.mjs), JPL DE440
//     (de440-2026.bsp here, lnxp1990.440 there), and IAU 2015 Resolution B3's
//     nominal solar irradiance (1361 W/m^2, over c at 1 au) and solar radius
//     (695 700 km) for radiation pressure past a spherical Earth of 6378137 m;
//   - time: UTC epochs, integrated on TT by both (Orekit on TAI);
//   - Earth orientation: the IERS finals2000A rows Orekit read, passed to
//     FFM's earth_orientation input (eop-2026-08.json, make-eop.mjs), so the
//     field and the atmosphere use the same daily rows on both sides (Orekit's
//     ITRF adds IERS 2010's sub-daily corrections to them; see below);
//   - NRLMSISE-00 (F10.7 150, F10.7a 150, daily Ap 15) on mean local solar
//     time, the model's own convention (see OrekitReference.java).
// Orekit integrates DormandPrince853 at 1e-14 with steps of at most 10 s.
//
// Tolerances, on the largest 3D position difference over the arc, and the
// agreement measured with the shipped build (propagator/ffm 1.3.0, module
// SHA-256 9c24bf0e, 2026-10-11). FFM's RK78 tolerance is per case
// (tests/lib/orekitCases.mjs), steps of at most 300 s:
//   point mass, at 1e-15 ................... 1 mm    measured <= 0.6 mm (MOLNIYA)
//   field, zonal or 20x20, with or without
//   Sun and Moon, at 1e-13 ................. 5 cm    measured <= 18.2 mm (LEO400)
//   + radiation pressure, at 1e-13 ......... 10 cm   measured <= 18.8 mm (LEO400)
//   + drag, at 1e-13 ....................... 10 cm   measured <= 21.7 mm (LEO400)
// At these settings most of the difference is FFM's own integration error:
// the sampled path controls its steps on the six-state error, which at 1e-13
// leaves 17.8 mm over the day in LEO400 and 16.0 mm in SSO700 (26.2 mm for
// JB2008 drag, 1.3 mm MOLNIYA, 0.03 mm GPS). `npm run orekit:summary`
// (tests/orekit-summary.mjs) prints the whole table, the same cases with steps
// of at most 30 s, and at tolerance 1e-15 with steps of at most 10 s, and writes
// tests/evidence/orekit/summary.json. With steps of 30 s the largest difference
// over the 72 cases is 9.87 mm (MOLNIYA); the rest are within 4.2 mm, and the
// finest setting moves no row by more than 0.2 mm. What remains is Earth
// orientation: the
// reference frame is ITRF with IERS 2010's tidal and libration corrections to
// polar motion and UT1 (getITRF(IERS_2010, false)), and FFM reads the daily
// rows. Orekit generated without the corrections (-Dorekit.simpleEOP=true,
// tests/fixtures/orekit/SOURCES.md; tests/evidence/orekit/summary-simple-eop.json)
// is within 1.1 mm of FFM at 30 s without drag and 3.9 mm with it.
// The PRW SDS 1.240.0 cases, on top of F4 (field 20x20, Sun, Moon) or F6
// (+ radiation pressure, drag), with the effect each has over the day:
//   R1 Schwarzschild ....................... LEO 18.1 mm, GPS 0.15 mm (effect 2.6 m, 0.34 m)
//   R2 IERS 2010 relativity ................ LEO 18.3 mm, GPS 0.16 mm (2.6 m, 0.33 m)
//   T1 IERS 2010 solid tides ............... LEO 18.1 mm, GPS 0.15 mm (15 m, 0.6 m)
//   I1 in-track 5e-8 m/s^2 ................. LEO 18.2 mm              (560 m)
//   B1 Cd*A/m rate 5e-8 m^2/kg/s ........... LEO 21.1 mm              (1.4 km)
//   W1 daily CSSI space weather (synthetic series, make-synthetic-weather.mjs)
//      ..................................... LEO 21.5 mm, SSO 14.4 mm
//   E1 EME2000 state in and out ............ LEO 18.1 mm, GPS 0.15 mm (17 cm, 4 mm)
//   G1 EGM96 36x36 / 70x70 ................. LEO 17.2 mm, GPS 0.15 mm
//   G2 EGM2008 36Z,24T ..................... LEO 18.2 mm
//   J1 JB2008 on synthetic SOLFSMY/DTCFILE rows (make-synthetic-weather.mjs)
//      from 2026-06-10 ..................... LEO 25.0 mm, SSO 16.9 mm
//   C1 with the STM and parameter Jacobians (B, BDOT, AGOM, T; analytic,
//      density gradient included): largest relative column difference, over
//      the samples, of the STM .............. LEO 1.2e-5, GPS 1.8e-11 (limit 1e-4)
//   and of the parameter columns ........... LEO B 5.0e-6, BDOT 3.7e-6,
//      AGOM 1.4e-4, T 5.1e-6; GPS AGOM 5.5e-10, T 6.1e-12
//      (limit 1e-3)
// The PRW SDS 1.243.0 cases, against Orekit's KnockeRediffusedForceModel (15
// degree elements, the radiation-pressure spacecraft's own Cr) and OceanTides
// (FES2004, no ocean pole tide, no interpolation cache), with the effect each
// has over the day and the differential agreement, (FFM with - without) -
// (Orekit with - without), at the suite's settings and, after the semicolon,
// with steps of 30 s:
//   A1 + Earth radiation, on F5 ........... LEO 18.9 mm, SSO 14.8 mm, GPS 0.15 mm
//                                           (effect 104 m, 32 m, 0.22 m;
//                                           differential 0.22 mm LEO, 0.003 mm GPS;
//                                           0.04 mm, 0.002 mm)
//   O1 + FES2004 ocean tides 30x30, on F4 .. LEO 18.1 mm, SSO 14.6 mm, GPS 0.15 mm
//                                           (effect 1.9 m, 0.86 m, 0.18 m;
//                                           differential 0.08 mm LEO, 0.001 mm GPS;
//                                           0.004 mm, 0.002 mm)
//   O2 FES2004 50x50 ....................... LEO 18.2 mm (29 mm more than 30x30)
//   C2 with both, the solid tides and the STM: STM LEO 1.8e-5, GPS 1.6e-11;
//      SRP_AREA_OVER_MASS, which scales the Earth radiation too, LEO 2.7e-5,
//      GPS 8.9e-9; LEO B 7.5e-6, BDOT 5.5e-6
// Every case with samples runs FFM's variational integrator (state and STM
// under one error control), visiting the epochs in order, one integration
// per span. A request for the final epoch alone runs the plain RK78 path
// instead; it is checked too ("final epoch only"), at 24 h, with the same
// tolerances and 300 s steps: measured <= 31.2 mm (LEO400 J1), GPS <= 0.17 mm.
// Orekit 13.1's DeSitterRelativity is replaced in the oracle by the same
// eq. 10.12 with consistent frames (see OrekitReference.java); the Cd*A/m
// rate is a third drag parameter driver there, so Orekit differentiates it.
// A defect in a modeled force shows as meters or more.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { REFERENCE, requestInputs, score, scoreJacobians, toleranceFor } from './lib/orekitCases.mjs';
import { decodeResult } from './lib/prwCodec.mjs';

const WASM = new URL('../dist/isomorphic/module.wasm', import.meta.url);
const MANIFEST = new URL('../plugin-manifest.json', import.meta.url);

for (const c of REFERENCE.cases) {
  const label = `${c.orbit} ${c.forces}`;
  test(`FFM matches Orekit: ${label}`, async (t) => {
    const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(WASM), manifest: JSON.parse(fs.readFileSync(MANIFEST, 'utf8')), surface: 'direct' });
    t.after(() => harness.destroy());
    const response = await harness.invoke({ methodId: 'invoke', inputs: requestInputs(c) });
    assert.equal(response.statusCode, 0, `${label}: ${response.errorCode}: ${response.errorMessage}`);
    const { worst, worstAt } = score(c, response);
    const limit = toleranceFor(c);
    t.diagnostic(`${label}: largest difference ${worst.toExponential(3)} m at ${worstAt / 3600} h (limit ${limit} m)`);
    assert.ok(worst <= limit, `${label}: ${worst.toExponential(3)} m at ${worstAt / 3600} h exceeds ${limit} m`);
    if (c.parameters) {
      const { stm, parameters } = scoreJacobians(c, response);
      t.diagnostic(`${label}: STM ${stm.toExponential(2)}; ${Object.entries(parameters).map(([k, v]) => `${k} ${v.toExponential(2)}`).join(', ')}`);
      assert.ok(stm <= 1e-4, `${label}: STM columns differ by ${stm.toExponential(2)} (relative)`);
      for (const [name, value] of Object.entries(parameters))
        assert.ok(value <= 1e-3, `${label}: ${name} column differs by ${value.toExponential(2)} (relative, limit 1e-3)`);
    }
  });
}

for (const c of REFERENCE.cases) {
  if (c.parameters) continue;
  const label = `${c.orbit} ${c.forces}`;
  test(`FFM matches Orekit, final epoch only: ${label}`, async (t) => {
    const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(WASM), manifest: JSON.parse(fs.readFileSync(MANIFEST, 'utf8')), surface: 'direct' });
    t.after(() => harness.destroy());
    const inputs = requestInputs(c, { edit: (exec) => { exec.SAMPLE_EPOCHS = []; } });
    const response = await harness.invoke({ methodId: 'invoke', inputs });
    assert.equal(response.statusCode, 0, `${label}: ${response.errorCode}: ${response.errorMessage}`);
    const result = decodeResult(response), [, x, y, z] = c.samples.at(-1);
    const gap = Math.hypot(result.position[0] * 1000 - x, result.position[1] * 1000 - y, result.position[2] * 1000 - z);
    const limit = toleranceFor(c);
    t.diagnostic(`${label}: ${gap.toExponential(3)} m at 24 h (limit ${limit} m)`);
    assert.ok(gap <= limit, `${label}: ${gap.toExponential(3)} m exceeds ${limit} m`);
  });
}

