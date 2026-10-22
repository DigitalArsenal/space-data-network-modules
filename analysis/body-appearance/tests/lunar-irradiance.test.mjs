import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {measureLunar,lunarRequest} from './lunar-measurements.mjs';
import {encodeRequest} from '../codec.js';

const bytes=fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url));
test('absolute ROLO irradiance across phase, both lunar hemispheres, libration and distances',async t=>{
  const h=await createBrowserModuleHarness({wasmSource:bytes,surface:'direct'});t.after(()=>h.destroy());
  const report=await measureLunar(h);
  assert.equal(report.status,'pass');
  // Much tighter than the 0.1 mag task gate: this is arithmetic validation of
  // the same physical model. 1e-12 mag permits only double-precision roundoff.
  assert.ok(report.max_residual_mag<1e-12);assert.ok(report.samples>9000);
  console.log(JSON.stringify({moon:report}));
});
test('ROLO refuses undefined bands, unsupported phases and malformed geometry',async t=>{
  const h=await createBrowserModuleHarness({wasmSource:bytes,surface:'direct'});t.after(()=>h.destroy());
  for(const change of [{model:'moon:rolo311g:V'},{phase_rad:[0]},{phase_rad:[97*Math.PI/180]},
    {solar_longitude_rad:[0]},{observer_latitude_rad:1},{observer_longitude_rad:1},
    {sun_distance_au:0},{observer_distance_m:1000}])
    assert.notEqual((await h.invoke(encodeRequest('lunar_irradiance',{...lunarRequest(),...change}))).statusCode,0);
});
