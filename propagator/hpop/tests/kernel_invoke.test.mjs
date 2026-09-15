// Physics runs only in WASM; JS supplies kernel bytes and independent JPL
// reference vectors. Authorities, kernel hashes, frames and time scales:
// ../../../docs/de440-validation.md.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import * as flatbuffers from 'flatbuffers';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { NCD } from 'spacedatastandards.org/lib/js/NCD/NCD.js';
import { ncdContainerFormat } from 'spacedatastandards.org/lib/js/NCD/ncdContainerFormat.js';

const fixtureRoot = new URL('../../../files/orbit-products/tests/fixtures/de440/', import.meta.url);
const kernel = fs.readFileSync(new URL('de440-2026.bsp', fixtureRoot));
const refs = fs.readFileSync(new URL('cspice-de440.csv', fixtureRoot), 'utf8').trim().split(/\r?\n/).slice(1)
  .map(line => line.split(',').map(Number)).filter(row => row[2] === 2461041.5 && row[1] === 399 && row[0] !== 399);
const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url)));
const ncdType = {schemaName:'NCD.fbs', fileIdentifier:'$NCD', rootTypeName:'NCD'};
function kernelFrame() {
  const b = new flatbuffers.Builder(128);
  NCD.startNCD(b);
  NCD.addFormat(b, ncdContainerFormat.SPK_DAF);
  NCD.addSourceByteLength(b, BigInt(kernel.length));
  NCD.finishSizePrefixedNCDBuffer(b, NCD.endNCD(b));
  return Buffer.concat([b.asUint8Array(), kernel]);
}
const payload = kernelFrame();
const query = (params, withKernel = true) => ({methodId:'invoke',inputs:[
  {portId:'request',typeRef:{schemaName:'orbpro.hpop.InvokeRequest',rootTypeName:'InvokeRequest'},payload:Buffer.from(JSON.stringify({operation:'ephemeris',params}))},
  ...(withKernel ? [{portId:'kernel',typeRef:ncdType,payload}] : [])
]});
const decode = response => JSON.parse(new TextDecoder().decode(response.outputs.find(out => out.portId === 'response').payload));

test('HPOP WASM kernel invoke matches independent CSPICE DE440 vectors, with source and fail-closed coverage', async t => {
  const h = await createBrowserModuleHarness({wasmSource:fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url)),manifest,surface:'command'});
  t.after(() => h.destroy());
  let maxPosition=0,maxVelocity=0;
  for (const [target,center,epochTDBJD,...state] of refs) {
    const response = await h.invoke(query({target,center,epochTDBJD}));
    assert.equal(response.statusCode,0,response.errorMessage);
    const actual = decode(response);
    assert.equal(actual.ephemerisSource,'JPL_SPK');
    assert.equal(actual.frame,'ICRF/J2000');
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
    {portId:'request',typeRef:{schemaName:'orbpro.hpop.InvokeRequest',rootTypeName:'InvokeRequest'},payload:Buffer.from(JSON.stringify({operation:'propagate',params:{...params,...(source?{ephemerisSource:source}:{})}}))},
    ...(withKernel?[{portId:'kernel',typeRef:ncdType,payload}]:[])
  ]});
  const de=await invoke('',true),fallback=await invoke('',false),explicit=await invoke('Analytical',true);
  for(const response of [de,fallback,explicit]) assert.equal(response.statusCode,0,response.errorMessage);
  assert.equal(decode(de).ephemerisSource,'JPL_SPK');
  assert.equal(decode(fallback).ephemerisSource,'Analytical');
  assert.deepEqual(decode(explicit),decode(fallback));
  assert.notDeepEqual(decode(de).position,decode(fallback).position,'kernel must change force propagation');
  const uncovered=await h.invoke({methodId:'invoke',inputs:[
    {portId:'request',typeRef:{schemaName:'orbpro.hpop.InvokeRequest',rootTypeName:'InvokeRequest'},payload:Buffer.from(JSON.stringify({operation:'propagate',params:{...params,targetJD:2451545}}))},
    {portId:'kernel',typeRef:ncdType,payload}
  ]});
  assert.notEqual(uncovered.statusCode,0);
  assert.equal(uncovered.errorCode,'ephemeris-failed');
});
