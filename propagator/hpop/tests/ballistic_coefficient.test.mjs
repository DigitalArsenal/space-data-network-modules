// An SGP4 element set's drag term as the numerical model's Cd*A/m, computed
// by the built module (plugin_drag_area_over_mass_from_bstar).
//
// Authority: Hoots and Roehrich, "Models for Propagation of NORAD Element
// Sets", Spacetrack Report No. 3 (1980), section 8 (p. 31) and section 9
// (p. 47): "B = 2B*/rho0, where rho0 = (2.461 x 10^-5) XKMPER kg/m^2/Earth
// radii is a reference value of atmospheric density", B = Cd A/m, XKMPER =
// 6378.135 km; the report's Fortran sets RHO = .15696615. B* in 1/earth
// radii, B in m^2/kg. The module returns 2B*/RHO to the last bit (tolerance
// 1e-15 relative), which is the printed product 2.461e-5 x 6378.135 within
// 2e-6 relative (RHO's own rounding). The report's test element set (88888,
// B* = 0.66816e-4) gives 8.5134e-4 m^2/kg. A B* of zero or below, or not
// finite, carries no drag information and returns the caller's value.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';

const wasm = fs.readFileSync(new URL('../dist/isomorphic/module.wasm', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url), 'utf8'));

test('Cd*A/m = 2 B* / rho0 (Spacetrack Report No. 3); no drag information returns the caller default', async (t) => {
  const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
  t.after(() => h.destroy());
  const convert = h.instance.exports.plugin_drag_area_over_mass_from_bstar;
  for (const bstar of [1e-5, 0.66816e-4, 3e-4, 1e-2]) {
    const b = convert(bstar, 0.01);
    assert.ok(Math.abs(b - 2 * bstar / 0.15696615) <= 1e-15 * b, `${bstar}`);
    assert.ok(Math.abs(b - 2 * bstar / (2.461e-5 * 6378.135)) <= 2e-6 * b, `${bstar}`);
  }
  assert.ok(Math.abs(convert(0.66816e-4, 0.01) - 8.5134e-4) < 5e-8);
  for (const bstar of [0, -1e-4, NaN, Infinity]) assert.equal(convert(bstar, 0.01), 0.01, `${bstar}`);
});
