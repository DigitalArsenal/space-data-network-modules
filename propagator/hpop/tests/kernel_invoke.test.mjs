// Physics runs only in WASM; JS supplies kernel bytes and independent JPL
// reference vectors. Authorities, kernel hashes, frames and time scales:
// ../../../docs/de440-validation.md.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { TYPE, requestFor, decodeResult, nativeInput, operationPayload } from './lib/prwCodec.mjs';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';

const fixtureRoot = new URL('../../../files/orbit-products/tests/fixtures/de440/', import.meta.url);
const kernel = fs.readFileSync(new URL('de440-2026.bsp', fixtureRoot));
const refs = fs.readFileSync(new URL('cspice-de440.csv', fixtureRoot), 'utf8').trim().split(/\r?\n/).slice(1)
  .map(line => line.split(',').map(Number)).filter(row => row[2] === 2461041.5 && row[1] === 399 && row[0] !== 399);
const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url)));
const payload=nativeInput(kernel);
const ncdType=TYPE;
const query=(params,withKernel=true)=>requestFor('ephemeris',params,withKernel?kernel:undefined);
const decode=decodeResult;

test('HPOP WASM kernel invoke matches independent CSPICE DE440 vectors, with source and fail-closed coverage', async t => {
  const h = await createBrowserModuleHarness({wasmSource:fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url)),manifest,surface:'command'});
  t.after(() => h.destroy());
  let maxPosition=0,maxVelocity=0;
  for (const [target,center,epochTDBJD,...state] of refs) {
    const response = await h.invoke(query({target,center,epochTDBJD}));
    assert.equal(response.statusCode,0,response.errorMessage);
    const actual = decode(response);
    assert.equal(actual.ephemerisSource,'JPL_SPK');
    assert.equal(actual.frame,`ICRF/NAIF-${center}`);
    // km and km/s in J2000 at JD TDB; 1 millimetre and 1 micrometre/s
    // bounds protect same-kernel interpolation from numerical regressions.
    const dp=Math.hypot(...actual.position.map((x,i)=>x-state[i]));
    const dv=Math.hypot(...actual.velocity.map((x,i)=>x-state[i+3]));
    maxPosition=Math.max(maxPosition,dp); maxVelocity=Math.max(maxVelocity,dv);
    assert.ok(dp<=1e-6,`position ${target}: ${dp} km`);
    assert.ok(dv<=1e-9,`velocity ${target}: ${dv} km/s`);
  }
  console.log(`PASS HPOP WASM CSPICE states=${refs.length} position_error_km=${maxPosition} velocity_error_km_s=${maxVelocity}`);
  const missing = await h.invoke(query({target:10,center:399,epochTDBJD:2461041.5},false));
  assert.notEqual(missing.statusCode,0);
  assert.equal(missing.errorCode,'missing-kernel');
  for (const params of [{target:999999,epochTDBJD:2461041.5},{target:10,epochTDBJD:2451545}]) {
    const response=await h.invoke(query(params));
    assert.notEqual(response.statusCode,0);
    assert.equal(response.errorCode,'ephemeris-failed');
  }
});

test('HPOP propagation reports explicit Analytical fallback after a kernel invocation', async t => {
  const h=await createBrowserModuleHarness({wasmSource:fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url)),manifest,surface:'command'});
  t.after(()=>h.destroy());
  const params={epochJD:2461041.5,targetJD:2461041.5+60/86400,position:[7000,0,0],velocity:[0,7.5,1],forces:{j2:false,thirdBody:true,srp:true}};
  const invoke=async(source,withKernel)=>h.invoke({methodId:'invoke',inputs:[
    {portId:'request',typeRef:TYPE,payload:operationPayload('propagate',{...params,...(source?{ephemerisSource:source}:{})},withKernel)},
    ...(withKernel?[{portId:'kernel',typeRef:ncdType,payload}]:[])
  ]});
  const de=await invoke('',true),fallback=await invoke('',false),explicit=await invoke('Analytical',true);
  for(const response of [de,fallback,explicit]) assert.equal(response.statusCode,0,response.errorMessage);
  assert.equal(decode(de).ephemerisSource,'JPL_SPK');
  assert.equal(decode(fallback).ephemerisSource,'Analytical');
  assert.deepEqual(decode(explicit),decode(fallback));
  assert.notDeepEqual(decode(de).position,decode(fallback).position,'kernel must change force propagation');
  const uncovered=await h.invoke({methodId:'invoke',inputs:[
    {portId:'request',typeRef:TYPE,payload:operationPayload('propagate',{...params,targetJD:2451545},true)},
    {portId:'kernel',typeRef:ncdType,payload}
  ]});
  assert.notEqual(uncovered.statusCode,0);
  assert.equal(uncovered.errorCode,'ephemeris-failed');
});
