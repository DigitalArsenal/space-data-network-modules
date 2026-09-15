import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {createBrowserModuleHarness} from 'space-data-module-sdk/testing';
import {wire} from '../../eop-parser/tests/harness.mjs';
test('three source methods turn timer ticks into HTTP GET and attributed parser jobs',async t=>{
 const h=await createBrowserModuleHarness({wasmSource:fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url)),surface:'direct'});t.after(()=>h.destroy());
 for(const methodId of ['finals2000a','c04','paris']){
  const r=await h.invoke({methodId,inputs:[wire('tick',{})]});assert.equal(r.statusCode,0,r.errorMessage);
  const output=p=>JSON.parse(Buffer.from(r.outputs.find(x=>x.portId===p).payload));const http=output('request'),job=output('job');
  assert.equal(http.method,'GET');assert.equal(http.maxBytes,16777216);assert.equal(http.timeoutMs,90000);assert.equal(job.format,methodId);assert.equal(job.source_url,http.url);assert.match(job.series_name,/IERS|Paris/);assert.match(http.url,/^https:\/\/(datacenter.iers.org|hpiers.obspm.fr)\//);
 }
 const r=await h.invoke({methodId:'c04',inputs:[wire('tick',{}),wire('tick',{})]});assert.notEqual(r.statusCode,0);assert.equal(r.outputs.length,0);
});
