import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {invoke} from './measurements.mjs';
import {encodeRequest} from '../codec.js';

const bytes=fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url));
// Synthetic static sphere, radius and observer distance in meters; Sun distance
// in au. Solar magnitude is an explicitly chosen test zero point, not a measured
// solar magnitude. No epoch or body-fixed longitude enters a homogeneous sphere.
const geometry={radius_m:1000,observer_distance_m:1e8,sun_distance_au:2,solar_magnitude:0};

test('numerical disk integral reproduces the closed-form Lambert sphere and inverse-square flux',async t=>{
  const h=await createBrowserModuleHarness({wasmSource:bytes,surface:'direct'});t.after(()=>h.destroy());
  const angles=[0,.01,.3,Math.PI/2,2.6,3.1];
  const q={...geometry,model:'sphere:lambert',surface_albedo:.7,phase_rad:angles};
  const r=await invoke(h,'disk_photometry',q);
  for(let i=0;i<angles.length;i++) {
    const a=angles[i],expected=2*.7/(3*Math.PI)*(Math.sin(a)+(Math.PI-a)*Math.cos(a));
    // 1e-9 relative allows quadrature roundoff and near-crescent cancellation.
    assert.ok(Math.abs(r.disk_albedo[i]/expected-1)<1e-9);
    const ratio=expected*(geometry.radius_m/geometry.observer_distance_m/geometry.sun_distance_au)**2;
    assert.ok(Math.abs(r.solar_flux_ratio[i]/ratio-1)<1e-9);
    assert.ok(Math.abs(r.apparent_magnitude[i]+2.5*Math.log10(ratio))<1e-9);
  }
  const farther=await invoke(h,'disk_photometry',{...q,observer_distance_m:2e8,sun_distance_au:4});
  assert.ok(Math.abs(farther.solar_flux_ratio[0]/r.solar_flux_ratio[0]-1/16)<1e-15);
});

test('independent analytic zero-phase integrals validate published Jupiter and Saturn parameters',async t=>{
  const h=await createBrowserModuleHarness({wasmSource:bytes,surface:'direct'});t.after(()=>h.destroy());
  // Heng & Li (2021) doi:10.3847/2041-8213/abe872 Table 1, 550 nm.
  // Heng et al. doi:10.1038/s41550-021-01444-7 Eq.(8), analytic Ag.
  // Independently transcribed parameters; dimensionless albedo, phase 0 rad.
  const w=.989,e=(1-Math.sqrt(1-w))/(1+Math.sqrt(1-w));
  const particle=g=>(1-g)/(1+g)**2;
  const p0=.927*particle(.337)+(1-.927)*particle(-.685);
  const expected=w/8*(p0-1)+e/2+e*e/6+e**3/24;
  const j=await invoke(h,'disk_photometry',{...geometry,model:'jupiter:heng2021:550nm',phase_rad:[0]});
  assert.ok(Math.abs(j.disk_albedo[0]-expected)<1e-12,'quadrature vs analytic Ag, roundoff budget');
  // Dyudina et al. doi:10.3847/0004-637X/822/2/76 Eq.(4), Table 3.
  // At opposition mu0=mu; 2*integral_0^1 A*(mu/2)^B dmu gives this
  // closed form. 1e-8 relative budgets the fractional-power limb quadrature.
  for(const [band,A,B] of [['640nm',1.69,1.48],['440nm',.63,1.11]]) {
    const r=await invoke(h,'disk_photometry',{...geometry,model:'saturn:dyudina2016:'+band,phase_rad:[0]});
    assert.ok(Math.abs(r.disk_albedo[0]/(2*A/(2**B*(B+1)))-1)<1e-8);
  }
});

test('disk photometry rejects absent models, mismatched inputs and unsupported geometry',async t=>{
  const h=await createBrowserModuleHarness({wasmSource:bytes,surface:'direct'});t.after(()=>h.destroy());
  const q={...geometry,model:'jupiter:heng2021:550nm',phase_rad:[0]};
  for(const change of [{model:'Venus'},{phase_rad:[2.5]},{surface_albedo:.5},{solar_magnitude:NaN},
    {observer_distance_m:500},{sun_distance_au:0},{phase_rad:[]},{phase_rad:[-.1]}])
    assert.notEqual((await h.invoke(encodeRequest('disk_photometry',{...q,...change}))).statusCode,0);
});

test('Jupiter disk integration matches the independent analytic phase solution',async t=>{
  const h=await createBrowserModuleHarness({wasmSource:bytes,surface:'direct'});t.after(()=>h.destroy());
  // Heng et al. (2021) doi:10.1038/s41550-021-01444-7, Eqs.(8)-(11),
  // evaluated directly rather than by the runtime's two-dimensional integral.
  // Dimensionless disk albedo, static spherical frame, phase angles radians.
  const w=.989,e=(1-Math.sqrt(1-w))/(1+Math.sqrt(1-w));
  const P=a=>.927*(1-.337**2)/(1+.337**2+2*.337*Math.cos(a))**1.5+
    .073*(1-.685**2)/(1+.685**2-2*.685*Math.cos(a))**1.5;
  const rhoS=a=>P(a)-1+(1+e)**2*(2-e)**2/4;
  const rhoL=e/2*(1+e)**2*(2-e),rhoC=e*e*(1+e)**2;
  const geometric=w/8*(P(0)-1)+e/2+e*e/6+e**3/24;
  const angles=[.02,.3,.8,Math.PI/2,2,2.4];
  const r=await invoke(h,'disk_photometry',{...geometry,model:'jupiter:heng2021:550nm',phase_rad:angles});
  for(let i=0;i<angles.length;i++) {
    const a=angles[i],c=Math.cos(a/2),s=Math.sin(a/2),logCot=Math.log(1/Math.tan(a/4));
    const single=1-s*s/c*logCot,lambert=(Math.sin(a)+(Math.PI-a)*Math.cos(a))/Math.PI;
    const correction=-1+5/3*c*c+Math.tan(a/2)*s**3*logCot;
    const expected=geometric*(12*rhoS(a)*single+16*rhoL*lambert+9*rhoC*correction)/(12*rhoS(0)+16*rhoL+6*rhoC);
    // 2e-7 relative allows quadrature of limb/terminator gradients, not
    // measurement uncertainty. Much smaller than 0.1 mag science acceptance.
    assert.ok(Math.abs(r.disk_albedo[i]/expected-1)<2e-7,`${a}: ${r.disk_albedo[i]} vs ${expected}`);
  }
});
