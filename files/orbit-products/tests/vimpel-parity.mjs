import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { normalizeParityFixture,runParityHarness,formatParityReport } from 'space-data-module-sdk/testing';
import { request,row } from './vimpel-fixture.mjs';
const plan=await normalizeParityFixture({name:'vimpel-osculating-conversion',threadCounts:[1],cases:[
 {id:'circular-u-not-mean-anomaly',request:request()},
 {id:'unknown-uncertainty',request:request(row.replace(',0.5,10',',0.5,-'))},
 {id:'bad-hash',request:request(row,{hash:false})}
]});
const r=await runParityHarness({wasmPath:fileURLToPath(new URL('../dist/isomorphic/module.wasm',import.meta.url)),plan,autoBuildDockerImage:false,timeoutMs:30000,log:console.log});console.log(formatParityReport(r));assert.equal(r.ok,true);assert.equal(r.lanes.length,3);
