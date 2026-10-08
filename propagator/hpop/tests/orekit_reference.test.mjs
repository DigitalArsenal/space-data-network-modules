// HPOP against Orekit 13.1 on identical initial states, force sets and
// constants: five orbits (LEO400, SSO700, GPS, GEO, MOLNIYA) by ten force
// sets, plus the PRW SDS 1.240.0 additions on LEO400, SSO700 and GPS, each
// propagated for 24 h and compared hourly.
//
// Authority: Orekit (CS GROUP, Apache-2.0), the parity authority this repo
// already uses for foundation/time. tests/fixtures/orekit/OrekitReference.java
// generated tests/fixtures/orekit/orekit-reference.json; nothing here
// regenerates it. The two sides share, by construction:
//   - constants: EGM2008's TT-compatible GM 3.986004415e14 m^3/s^2 and radius
//     6378136.3 m, the coefficients HPOP embeds (make-gfc.mjs), JPL DE440
//     (de440-2026.bsp here, lnxp1990.440 there), and IAU 2015 Resolution B3's
//     nominal solar irradiance (1361 W/m^2, over c at 1 au) and solar radius
//     (695 700 km) for radiation pressure past a spherical Earth of 6378137 m;
//   - time: UTC epochs, integrated on TT by both (Orekit on TAI);
//   - Earth orientation: the IERS finals2000A rows Orekit read, passed to
//     HPOP's earth_orientation input (eop-2026-08.json, make-eop.mjs), so the
//     field and the atmosphere use the same ITRF on both sides;
//   - NRLMSISE-00 (F10.7 150, F10.7a 150, daily Ap 15) on mean local solar
//     time, the model's own convention (see OrekitReference.java).
// Orekit integrates DormandPrince853 at 1e-14 with steps of at most 10 s.
//
// Tolerances, on the largest 3D position difference over the arc, and the
// agreement measured with the native build when they were set (2026-10-08).
// HPOP's RK78 tolerance is per case (tests/lib/orekitCases.mjs):
//   point mass, at 1e-15 ................... 1 mm    measured <= 0.6 mm (MOLNIYA)
//   field, zonal or 20x20, with or without
//   Sun and Moon, at 1e-13 ................. 5 cm    measured <= 1.3 cm (LEO400)
//   + radiation pressure, at 1e-14 ......... 10 cm   measured <= 3.0 cm (MOLNIYA)
//   + drag, at 1e-14 ....................... 10 cm   measured <= 2.2 cm (LEO400)
// The PRW SDS 1.240.0 cases, on top of F4 (field 20x20, Sun, Moon) or F6
// (+ radiation pressure, drag), with the effect each has over the day:
//   R1 Schwarzschild ....................... LEO 1.3 cm, GPS 0.42 mm  (effect 2.6 m, 0.34 m)
//   R2 IERS 2010 relativity ................ LEO 1.2 cm, GPS 0.42 mm  (2.6 m, 0.33 m)
//   T1 IERS 2010 solid tides ............... LEO 1.3 cm, GPS 0.41 mm  (15 m, 0.6 m)
//   I1 in-track 5e-8 m/s^2 ................. LEO 1.3 cm               (560 m)
//   B1 Cd*A/m rate 5e-8 m^2/kg/s ........... LEO 1.1 cm               (1.4 km)
//   W1 daily CSSI space weather ............ LEO 2.2 cm, SSO 2.9 mm   (4.4 km, 50 m)
//   E1 EME2000 state in and out ............ LEO 1.4 cm, GPS 0.42 mm  (17 cm, 4 mm)
//   G1 EGM96 36x36 / 70x70 ................. LEO 1.1 cm, GPS 0.43 mm
//   G2 EGM2008 36Z,24T ..................... LEO 1.2 cm
//   J1 JB2008 on SET's SOLFSMY/DTCFILE rows
//      from 2026-06-10 ..................... LEO 6 mm, SSO 6 mm (a one-day
//      error in the Y10 lag alone moves LEO by 59 m)
//   C1 with the STM and parameter Jacobians (B, BDOT, AGOM, T; analytic,
//      density gradient included): largest relative column difference, over
//      the samples, of the STM .............. LEO 1.1e-5, GPS 3.9e-11 (limit 1e-4)
//   and of the parameter columns ........... LEO B 5.0e-6, BDOT 3.6e-6,
//      T 5.0e-6; GPS AGOM 5.2e-10, T 1.7e-11 (limit 1e-3)
//   LEO AGOM ............................... 3.4e-4 native, 3.9e-3 wasm (limit 1e-2)
//   The radiation-pressure column integrates the lit fraction through each
//   penumbra, whose edges HPOP's steps cross without locating; it moves with
//   rounding (native and wasm step differently) as the LEO SRP states do.
// Every case with samples runs HPOP's variational integrator (state and STM
// under one error control). A request for the final epoch alone runs the
// plain RK78 path instead; it is checked too ("final epoch only"), at 24 h,
// with steps of at most 10 s where radiation pressure or drag is on (the
// penumbra kinks: at 60 s or more LEO400 F6 is 21 cm off, at 30 s 2.2 cm, at
// 10 s 9.6 mm) and 300 s otherwise; measured <= 2.5 cm (LEO400), each case in
// about a second.
// Orekit 13.1's DeSitterRelativity is replaced in the oracle by the same
// eq. 10.12 with consistent frames (see OrekitReference.java); the Cd*A/m
// rate is a third drag parameter driver there, so Orekit differentiates it.
// What remains is integration error on both sides, at about 1e-11 of the
// distance flown. Radiation pressure has a kink at each penumbra boundary
// that HPOP's steps cross without locating (Orekit needs steps of at most
// 10 s for the same reason); at 1e-13 that leaves up to ~8 cm a day in LEO
// which moves with any change of rounding, hence 1e-14 for those cases. A
// defect in a modelled force shows as metres or more.
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
  test(`HPOP matches Orekit: ${label}`, async (t) => {
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
      for (const [name, value] of Object.entries(parameters)) {
        const limit = name === 'SRP_AREA_OVER_MASS' ? 1e-2 : 1e-3;
        assert.ok(value <= limit, `${label}: ${name} column differs by ${value.toExponential(2)} (relative, limit ${limit})`);
      }
    }
  });
}

for (const c of REFERENCE.cases) {
  if (c.parameters) continue;
  const label = `${c.orbit} ${c.forces}`;
  test(`HPOP matches Orekit, final epoch only: ${label}`, async (t) => {
    const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(WASM), manifest: JSON.parse(fs.readFileSync(MANIFEST, 'utf8')), surface: 'direct' });
    t.after(() => harness.destroy());
    const inputs = requestInputs(c, { maxStep: c.srp || c.drag ? 10 : 300, edit: (exec) => { exec.SAMPLE_EPOCHS = []; } });
    const response = await harness.invoke({ methodId: 'invoke', inputs });
    assert.equal(response.statusCode, 0, `${label}: ${response.errorCode}: ${response.errorMessage}`);
    const result = decodeResult(response), [, x, y, z] = c.samples.at(-1);
    const gap = Math.hypot(result.position[0] * 1000 - x, result.position[1] * 1000 - y, result.position[2] * 1000 - z);
    const limit = toleranceFor(c);
    t.diagnostic(`${label}: ${gap.toExponential(3)} m at 24 h (limit ${limit} m)`);
    assert.ok(gap <= limit, `${label}: ${gap.toExponential(3)} m exceeds ${limit} m`);
  });
}

