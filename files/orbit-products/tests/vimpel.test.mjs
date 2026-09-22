import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { ByteBuffer } from 'flatbuffers';
import { OPM } from 'spacedatastandards.org/lib/js/OPM/OPM.js';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing/browser';
import { request,row } from './vimpel-fixture.mjs';
const manifest=JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json',import.meta.url)));
async function invoke(t,r){const h=await createBrowserModuleHarness({wasmSource:fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url)),manifest,surface:'direct'});t.after(()=>h.destroy());return h.invoke(r);}
const state=out=>OPM.getSizePrefixedRootAsOPM(new ByteBuffer(out.outputs.find(o=>o.portId==='states').payload));
// Closed-form circular orbit, Earth mu 398600.4418 km^3/s^2, J2000 UTC.
// Tolerances cover floating arithmetic, not provider orbit accuracy.
test('argument of latitude produces analytic epoch PV and no invented identity',async t=>{
 const out=await invoke(t,request());assert.equal(out.statusCode,0,out.errorMessage);const s=state(out);
 assert.ok(Math.abs(s.X())<1e-9);assert.ok(Math.abs(s.Y()-7000)<1e-9);
 assert.ok(Math.abs(s.X_DOT()+Math.sqrt(398600.4418/7000))<1e-12);assert.ok(Math.abs(s.Y_DOT())<1e-12);
 assert.equal(s.EPOCH(),'2026-09-21T00:00:00Z');assert.equal(s.REF_FRAME(),'J2000');assert.equal(s.OBJECT_NAME(),'vimpel:10201');assert.ok(!s.OBJECT_ID());assert.ok(out.outputs.some(o=>o.portId==='descriptor'));
});
test('eccentric perigee agrees with independent vis-viva speed',async t=>{
 const text='1,1,01012026,21092026 000000,0,20000,0,0,0.5,0,0,0,15,1,10\n';const out=await invoke(t,request(text));assert.equal(out.statusCode,0,out.errorMessage);const s=state(out);
 assert.equal(s.X(),10000);assert.ok(Math.abs(s.Y_DOT()-Math.sqrt(398600.4418*(2/10000-1/20000)))<1e-12);
});
test('bad hash, dates, nonfinite elements, duplicate native IDs and trailing junk fail atomically',async t=>{
 for(const r of [request(row,{hash:false}),request(row.replace('21092026','31022026')),request(row.replace('7000','nan')),request(row+row.replace('010201','10201')),request(row.replace('7000','7000x')),request(row,{format:'vimpel-ephemeris-rar'})]) {
  const out=await invoke(t,r);assert.notEqual(out.statusCode,0);assert.equal(out.outputs.length,0);
 }
});

test('provider unknown metadata and signed age do not invent uncertainty',async t=>{const out=await invoke(t,request(row.replace(',0,7000',',-1,7000').replace(',0.5,10',',0.5,-')));assert.equal(out.statusCode,0,out.errorMessage);});
