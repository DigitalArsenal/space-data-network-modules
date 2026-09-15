// Same byte payload through browser/V8, native WasmEdge, container WasmEdge.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hexRequestFor } from './lib/prwCodec.mjs';
import { normalizeParityFixture, runParityHarness, formatParityReport } from 'space-data-module-sdk/testing';
const kernel=fs.readFileSync(new URL('../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp',import.meta.url));
const request=(operation,params,useKernel=true)=>hexRequestFor(operation,params,useKernel?kernel:undefined);
const propagation={epochJD:2461041.5,targetJD:2461041.5+60/86400,position:[7000,0,0],velocity:[0,7.5,1],forces:{j2:false,thirdBody:true,srp:true}};
const cases=[
  ...[10,301,5].map(target=>({id:`de440-target-${target}`,request:request('ephemeris',{target,center:399,epochTDBJD:2461041.5})})),
  {id:'de440-out-of-coverage',request:request('ephemeris',{target:10,center:399,epochTDBJD:2451545})},
  {id:'de440-propagation',request:request('propagate',propagation)},
  {id:'analytical-propagation',request:request('propagate',propagation,false)},
];
const plan=await normalizeParityFixture({name:'TMPL lane13 canonical PRW DE440 artifact',threadCounts:[1,2,4,8],cases});
const report=await runParityHarness({wasmPath:fileURLToPath(new URL('../dist/isomorphic/module.wasm',import.meta.url)),plan,timeoutMs:60000,log:console.log});
console.log(formatParityReport(report));
fs.mkdirSync(new URL('./evidence/lane13/',import.meta.url),{recursive:true});
fs.writeFileSync(new URL('./evidence/lane13/kernel-parity.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
assert.equal(report.ok,true,JSON.stringify(report.failures));
