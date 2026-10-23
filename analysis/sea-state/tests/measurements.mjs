import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {createHash} from 'node:crypto';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {encodeRequest,decodeResult} from '../codec.js';

const vectors=JSON.parse(await fs.readFile(new URL('./reference-vectors.json',import.meta.url),'utf8'));
export const cases=vectors.cases;
export const engineCases=[
  {wind_speed_10m_mps:5.25,wind_from_deg:59,wave_height_m:1.38,wave_period_s:8.95,wave_from_deg:41},
  {wind_speed_10m_mps:80,wind_from_deg:-90,wave_height_m:100,wave_period_s:100,wave_from_deg:725},
  {wind_speed_10m_mps:-3,wind_from_deg:360},
  {wind_speed_10m_mps:0,wind_from_deg:-1,wave_height_m:.1,wave_period_s:.5,wave_from_deg:-360},
  {wind_speed_10m_mps:10,wind_from_deg:725,wave_height_m:2.2,wave_period_s:12},
];
export const parityRequests=[...cases.map(({expected,...r})=>r),...engineCases.map((values,i)=>({name:`engine-${i}`,method:'sea_state',values}))];
export async function measure() {
  const harness=await createBrowserModuleHarness({wasmSource:await fs.readFile(new URL('../dist/isomorphic/module.wasm',import.meta.url)),surface:'direct'});
  const results=new Map(),maxError={pm:0,developing:0};let scalarComparisons=0;
  const invoke=async values=>{
    const response=await harness.invoke(encodeRequest('sea_state',values));
    assert.equal(response.statusCode,0,`${response.errorCode}: ${response.errorMessage}`);
    assert.equal(response.outputs.length,1);return decodeResult(response.outputs[0].payload);
  };
  try {
    for(const c of cases) {
      const actual=await invoke(c.values);results.set(c.name,actual);
      for(const [name,expected] of Object.entries(c.expected)) {
        if(typeof expected==='string')assert.equal(actual[name],expected,`${c.name}.${name}`);
        else {
          const error=Math.abs(actual[name]-expected),relative=expected ? error/Math.abs(expected) : error;
          assert.ok(error<=vectors.tolerance.absolute+vectors.tolerance.relative*Math.abs(expected),`${c.name}.${name}: ${actual[name]} vs ${expected}; rel=${relative}`);
          const key=c.name.startsWith('pm-')?'pm':'developing';maxError[key]=Math.max(maxError[key],relative);scalarComparisons++;
        }
      }
      if(c.values.wind_speed_10m_mps>0)assert.ok(actual.hs_m<=results.get(`pm-${c.values.wind_speed_10m_mps}`).hs_m+1e-10,'PM height limit');
    }
    const snapshot=await fs.readFile(new URL('./legacy-oceanWeather.ts',import.meta.url),'utf8');
    const provenance=JSON.parse(await fs.readFile(new URL('./legacy-provenance.json',import.meta.url),'utf8'));
    assert.equal(createHash('sha256').update(snapshot).digest('hex'),provenance.snapshotSha256);
    const js=stripTypeScriptTypes(snapshot,{mode:'strip'}).replace(/^export /gm,'');
    const legacy=vm.runInNewContext(`${js}\n;({oceanStateFromWeather})`).oceanStateFromWeather;
    const legacyFields=['windSpeedMps','windFromDeg','swellHeightM','swellPeriodS','swellFromDeg','chop'];
    const windTable=[];let identicalWindRows=0,unchangedEngineScalars=0;
    for(const c of cases.filter(c=>c.name.startsWith('pm-'))) {
      const wind=c.values.wind_speed_10m_mps,r=results.get(c.name),old=legacy({windSpeedMps:wind,windFromDeg:270});
      for(const k of ['windSpeedMps','windFromDeg','swellFromDeg','chop']){assert.equal(r[k],old[k]);unchangedEngineScalars++;}
      if(legacyFields.every(k=>r[k]===old[k]))identicalWindRows++;
      windTable.push({wind_mps:wind,hs_m:r.hs_m,tp_s:r.tp_s,old_engine_hs_m:old.swellHeightM,new_engine_hs_m:r.swellHeightM,
        delta_engine_hs_m:r.swellHeightM-old.swellHeightM,old_engine_tp_s:old.swellPeriodS,new_engine_tp_s:r.swellPeriodS,delta_engine_tp_s:r.swellPeriodS-old.swellPeriodS});
    }
    // JS numeric equality treats +0 and -0 as the same bearing; PCE defaults canonicalize zero.
    for(const c of engineCases) {
      const r=await invoke(c),old=legacy({windSpeedMps:c.wind_speed_10m_mps,windFromDeg:c.wind_from_deg,
        waveHeightM:c.wave_height_m,wavePeriodS:c.wave_period_s,waveFromDeg:c.wave_from_deg});
      for(const k of legacyFields){assert.ok(r[k]===old[k],`engine override ${k}`);unchangedEngineScalars++;}
    }
    // Overrides do not change the wind-sea spectrum consumed by an FFT host.
    const overridden=await invoke({wind_speed_10m_mps:10,wave_height_m:20,wave_period_s:25});
    for(const k of ['hs_m','tp_s','fp_hz','m0_m2','alpha','gamma'])assert.equal(overridden[k],results.get('pm-10')[k]);
    const invalid=[{}, {wind_speed_10m_mps:NaN},{wind_speed_10m_mps:Infinity},{wind_speed_10m_mps:'10'},
      {wind_speed_10m_mps:[10]},{wind_speed_10m_mps:1e-10},{wind_speed_10m_mps:10,fetch_m:-1},
      {wind_speed_10m_mps:10,duration_s:-1},{wind_speed_10m_mps:10,wind_from_deg:Infinity},
      {wind_speed_10m_mps:10,fetch_m:1e13},{wind_speed_10m_mps:10,unexpected:1}];
    for(const c of invalid) {
      const r=await harness.invoke(encodeRequest('sea_state',c));assert.notEqual(r.statusCode,0);assert.equal(r.outputs.length,0);
    }
    const malformed=encodeRequest('sea_state',{wind_speed_10m_mps:10});malformed.inputs[0].payload=new Uint8Array([1,2,3]);
    const bad=await harness.invoke(malformed);assert.notEqual(bad.statusCode,0);assert.equal(bad.outputs.length,0);
    // Numerical extremes are operational boundary cases, not calibrated seas.
    for(const c of [{wind_speed_10m_mps:1e-6,fetch_m:1e-6,duration_s:1e-6},
      {wind_speed_10m_mps:70,fetch_m:1e-6,duration_s:1e-6},{wind_speed_10m_mps:70,fetch_m:1e12,duration_s:1e12}]) {
      const r=await invoke(c);for(const v of Object.values(r))if(typeof v==='number')assert.ok(Number.isFinite(v));
    }
    const codec=await fs.readFile(new URL('../codec.js',import.meta.url),'utf8');
    assert.doesNotMatch(codec,/\bMath\.|\b(?:9\.80665|0\.076|0\.877|piersonMoskowitzHeight|piersonMoskowitzPeriod)\b/,'production JS must only encode/decode');
    const below=results.get('transition-0.999999'),above=results.get('transition-1.000001');
    const transition={fetch_m:vectors.pm_transition_fetch_at_10mps_m,hs_below_m:below.hs_m,hs_above_m:above.hs_m,
      jump_m:above.hs_m-below.hs_m,jump_percent:100*(above.hs_m/below.hs_m-1),
      uncapped_hs_below_m:below.hs_uncapped_m,uncapped_overshoot_percent:100*(below.hs_uncapped_m/above.hs_m-1),energy_scale_below:below.energy_scale};
    return {status:'pass',reference:{source:vectors.source,units:vectors.units,frame:vectors.frame,epoch:vectors.epoch,tolerance:vectors.tolerance},
      numerical:{cases:cases.length,scalarComparisons,maxRelativeError:maxError,shapeIntegralReference:vectors.shape_integral,pmIntegralReferenceError:vectors.pm_integral_error},
      legacy:{provenance,windTable,identicalWindRows,unchangedEngineScalars,overrideCases:engineCases.length,
        explainedDifference:'Wind-only Hs/Tp use PM at U19.5=U10*(1.95)^(1/7), with coefficients derived from alpha=.0081 and beta=.74 instead of rounded .21/.877.'},
      invalidInputsRejected:invalid.length+1,transition,
      noJsPhysics:{moduleCodec:'pass',consoleRemovedPath:'pending UI lane; console worktree is read-only here'},
      consolePixelDiff:{status:'not measured',reason:'UI integration and actual console render belong to the Claude UI lane; numerical field equality is not a pixel measurement'}};
  } finally {await harness.destroy();}
}
