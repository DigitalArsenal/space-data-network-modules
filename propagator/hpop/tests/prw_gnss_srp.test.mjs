// GNSS radiation pressure on the PRW request path (SDS 1.241.0): FORCES
// RADIATION_PRESSURE_MODEL GNSS_BOX_WING with GNSS_BLOCK, and NONE with
// ECOM2 and the ECOM2_* DYNAMIC_PARAMETERS, against Orekit 13.1
// (fixtures/orekit/orekit-gnss-srp-reference.json, OrekitGnssSrpReference.java:
// BoxAndSolarArraySpacecraft under GPSBlockIIF/GPSBlockIIR attitude, and
// ECOM2(2,2) alone; point mass, Sun from DE440; GCRF, UTC epochs, SI).
// Tolerances are gnss_srp_native.cpp's for the same cases, there checked on
// the C++ configuration and here on the request: 24 h trajectory 2 mm (both
// integrators' error, measured 0.6 mm a day on the point-mass cases); STM
// and ECOM2 sensitivity columns 1e-6 relative (measured 1e-9 to 5e-9).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { score, scoreJacobians } from './lib/orekitCases.mjs';
import { sds } from './lib/prwCodec.mjs';
import { ECOM2_PARAMETERS, REFERENCE, inputs } from './lib/gnssSrpCases.mjs';

const WASM = new URL('../dist/isomorphic/module.wasm', import.meta.url);
const MANIFEST = new URL('../plugin-manifest.json', import.meta.url);
const harness = () => createBrowserModuleHarness({ wasmSource: fs.readFileSync(WASM), manifest: JSON.parse(fs.readFileSync(MANIFEST, 'utf8')), surface: 'direct' });

for (const c of REFERENCE.cases) {
  test(`PRW ${c.model === 'boxwing' ? `GNSS_BOX_WING GPS ${c.block}` : 'ECOM2 alone, with its eleven parameters'} matches Orekit 13.1: ${c.name}`, async (t) => {
    const h = await harness(); t.after(() => h.destroy());
    const response = await h.invoke({ methodId: 'invoke', inputs: inputs(c) });
    assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
    const { worst, worstAt } = score(c, response);
    t.diagnostic(`${c.name}: ${worst.toExponential(3)} m at ${worstAt / 3600} h (limit 2e-3 m)`);
    assert.ok(worst <= 2e-3, `${c.name}: ${worst} m`);
    if (c.model === 'ecom2') {
      const { stm, parameters } = scoreJacobians({ ...c, parameters: ECOM2_PARAMETERS }, response);
      const worstColumn = Math.max(...Object.values(parameters));
      t.diagnostic(`${c.name}: STM ${stm.toExponential(2)}, ECOM2 columns ${worstColumn.toExponential(2)} (limit 1e-6)`);
      assert.ok(stm <= 1e-6, `STM ${stm}`);
      assert.ok(worstColumn <= 1e-6, `ECOM2 columns ${JSON.stringify(parameters)}`);
    }
  });
}

test('PRW refuses radiation pressure selections that do not describe one model', async (t) => {
  const h = await harness(); t.after(() => h.destroy());
  const [boxWing, ecom] = [REFERENCE.cases.find((c) => c.model === 'boxwing'), REFERENCE.cases.find((c) => c.model === 'ecom2')];
  const refused = async (c, edit) => (await h.invoke({ methodId: 'invoke', inputs: inputs(c, edit) })).errorMessage ?? '';
  assert.match(await refused(boxWing, (e) => { e.FORCES.GNSS_BLOCK = sds.prwGnssSpacecraftBlock.UNSPECIFIED; }), /GNSS_BOX_WING needs GNSS_BLOCK/);
  assert.match(await refused(ecom, (e) => { e.FORCES.GNSS_BLOCK = sds.prwGnssSpacecraftBlock.GPS_IIF; }), /GNSS_BLOCK applies to/);
  assert.match(await refused(boxWing, (e) => { e.FORCES.ENABLE_SRP = false; }), /set ENABLE_SRP/);
  assert.match(await refused(boxWing, (e) => { Object.assign(e, { INCLUDE_STM: true, DYNAMIC_PARAMETERS: [sds.prwDynamicParameter.SRP_AREA_OVER_MASS] }); }), /RADIATION_PRESSURE_MODEL must be CANNONBALL/);
  assert.match(await refused(boxWing, (e) => { Object.assign(e, { INCLUDE_STM: true, DYNAMIC_PARAMETERS: [sds.prwDynamicParameter.ECOM2_D0] }); }), /ECOM2 enabled/);
});
