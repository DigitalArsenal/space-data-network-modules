// HPOP against Orekit 13.1 on identical initial states, force sets and
// constants: five orbits (LEO400, SSO700, GPS, GEO, MOLNIYA) by up to ten
// force sets, each propagated for 24 h and compared hourly.
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
import { REFERENCE, requestInputs, score, toleranceFor } from './lib/orekitCases.mjs';

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
  });
}
