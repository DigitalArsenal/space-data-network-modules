#!/usr/bin/env node
// Seeded synthetic catalog, UTC epochs, TEME km and km/s. Expected identities and
// epoch ordering come from the input construction and SPEC 14, independent of load.
// States and covariance are checked by the branch's exact-build comparisons.
// The memory bound is 5,000 B per input record above a 2 MiB initial memory:
// it includes payload staging, retained arrays and one decoded weather series.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import * as fb from 'flatbuffers';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {OMM} from 'spacedatastandards.org/lib/js/OMM/OMM.js';
import {T, seedOcm, rowsThrough, repackOcm, ocmOf} from './lib/ocm.mjs';
import {packageRoot, wasmPath} from './lib/module.mjs';
import {buildDiagnostic} from './lib/ap-diagnostic.mjs';
import {scratchDir} from './lib/scratch.mjs';
const N = 4096, DAY = 86400000;
const fixture = new Uint8Array(fs.readFileSync(new URL('fixtures/ap-fit-0.6.43.ocm', import.meta.url)));
const epoch = ocmOf(fixture).MEAN_ELEMENTS.EPOCH;
const ms = Date.parse(epoch.endsWith('Z') ? epoch : epoch + 'Z');
const iso = t => new Date(t).toISOString().replace('Z', '');
const weather = value => rowsThrough(Array.from({length:46}, (_, k) => ({DATE:iso(ms + (k - 5) * DAY).slice(0,10), F107_OBS:value, F107_OBS_CENTER81:value + 2, AP_AVG:4})));
const rows = [weather(70), weather(75)];
const open = wasm => createStandaloneHarness('browser', wasm, {surface:'direct', maxThreads:1, enableBrowserWasiThreads:false, initialMemoryBytes:2 * 1048576});
const prefix = bytes => { const b = Buffer.alloc(bytes.length + 4); b.writeUInt32LE(bytes.length); b.set(bytes, 4); return b; };
const payloadOf = records => Buffer.concat(records.map(prefix));
const invoke = (h, records) => h.invoke({methodId:'load_epochs', inputs:[{portId:'ocm',typeRef:T('OCM'),payload:payloadOf(records)}]});
const h = await open(wasmPath);
const records = [];
for (let k = 0; k < N; ++k) {
  const norad = 100000 + k;
  if (k % 4 === 0) {
    const b = new fb.Builder(256), ep = b.createString(epoch);
    OMM.startOMM(b); OMM.addEpoch(b, ep); OMM.addNoradCatId(b, norad);
    OMM.addMeanMotion(b, 15); OMM.addEccentricity(b, 0.001); OMM.addInclination(b, 55);
    OMM.addMeanAnomaly(b, k % 360); OMM.finishOMMBuffer(b, OMM.endOMM(b));
    const r = await h.invoke({methodId:'ingest_omm',inputs:[{portId:'omm',typeRef:T('OMM'),payload:b.asUint8Array().slice()}]});
    assert.equal(r.statusCode, 0, r.errorMessage);
    records.push(new Uint8Array(r.outputs[0].payload));
  } else if (k % 4 === 2) {
    records.push(repackOcm(fixture, t => {
      t.METADATA.NORAD_CAT_ID = norad; t.METADATA.OBJECT_NAME = `P${k}`;
      t.MEAN_ELEMENTS.RA_OF_ASC_NODE = k % 360;
      t.PERTURBATIONS.SPACE_WEATHER = rows[0];
    }));
  } else records.push(seedOcm({epoch, n:15, e:0.001, i:55, raan:k % 360, argp:90, ma:10,
    norad, name:`P${k}`, msis:true, records:true, rows:rows[k % 4 === 3 ? 1 : 0], tesseral:31, zonal:20}));
}
// Reverse input order with a seeded shuffle; duplicate later records replace earlier
// records, and a second epoch for one identity remains beside its first.
let seed = 20261113;
const shuffled = records.slice();
for (let k = shuffled.length - 1; k > 0; --k) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const j = seed % (k + 1); [shuffled[k], shuffled[j]] = [shuffled[j], shuffled[k]];
}
shuffled.push(...records.slice(0,32));
const later = repackOcm(records[1], t => {t.MEAN_ELEMENTS.EPOCH = iso(ms + DAY); t.TRAJ_FRAME_EPOCH = iso(ms + DAY);});
const aged = repackOcm(records[3], t => {t.MEAN_ELEMENTS.EPOCH = iso(ms - 8 * DAY); t.TRAJ_FRAME_EPOCH = iso(ms - 8 * DAY);});
const other = repackOcm(records[5], t => {t.CENTER_NAME = 'MARS';});
shuffled.push(later, aged, other);
const r = await invoke(h, shuffled);
assert.equal(r.statusCode, 0, `${r.errorCode}: ${r.errorMessage}`);
const afterLoad = h.memory.buffer.byteLength;
const x = h.instance.exports, p = x.sdnap_alloc(64), ep = x.sdnap_alloc(32);
x.sdnap_epochs_stats(p);
const stats = Array.from(new Float64Array(h.memory.buffer,p,8));
assert.deepEqual(stats.slice(0,7), [N+35,N+1,1,0,0,1,32]);
assert.equal(x.sdnap_epochs_count(), N);
for (let k = 0; k < N; ++k) {
  assert.equal(x.sdnap_epochs_series(k,p,ep,2),0);
  const info = Array.from(new Float64Array(h.memory.buffer,p,3));
  assert.deepEqual(info,[100000+k,k%4===0?0:4,k===1?2:1]);
  const dates = new Float64Array(h.memory.buffer,ep,4);
  assert.ok(Math.abs((dates[0]+dates[1]-2440587.5)*DAY-ms)<0.1);
  if(k===1) assert.ok(Math.abs((dates[2]+dates[3]-2440587.5)*DAY-ms-DAY)<0.1);
}
assert.ok(afterLoad - 2*1048576 < shuffled.length * 5000, `${afterLoad} bytes exceeds 5,000 B per record`);
// Control: the committed old load must exceed this same bound on identical bytes.
const oldPath=path.join(scratchDir('load-memory-control'),'baseline.wasm');
fs.writeFileSync(oldPath,execFileSync('git',['-C',packageRoot,'show','796bacbe:propagator/sdn-ap/dist/isomorphic/module.wasm'],{maxBuffer:1<<24}));
const old=await open(oldPath);
assert.equal((await invoke(old,shuffled)).statusCode,0);
const oldBytes=old.memory.buffer.byteLength;
assert.ok(oldBytes-2*1048576 >= shuffled.length*5000, `old load ${oldBytes} does not break bound`);
// Refusals inserted inside a catalog preserve both the name and full message.
const badRecords = [new Uint8Array([1,2,3,4]), repackOcm(records[1],t=>{t.PERTURBATIONS.SPACE_WEATHER=[];}),
  repackOcm(records[1],t=>{t.PERTURBATIONS.MAXIMUM_ZONAL_DEGREE=19;})];
for(const bad of badRecords){
  const mixed=[...records.slice(0,128),bad,...records.slice(128,256)];
  const a=await invoke(old,mixed),b=await invoke(h,mixed);
  assert.notEqual(a.statusCode,0);
  assert.deepEqual([b.statusCode,b.errorCode,b.errorMessage],[a.statusCode,a.errorCode,a.errorMessage]);
  console.log(`refusal ${b.errorCode}: ${b.errorMessage}`);
}
// A load replaces the old store, including on refusal.
assert.equal((await invoke(h,[records[0]])).statusCode,0);
assert.equal(x.sdnap_epochs_count(),1);
await h.destroy?.(); await old.destroy?.();
// Force the first counted catalog-array request to fail; host staging still works.
const layoutProbe = `
SDNAP_EXPORT("sdnap_test_load_layout") void sdnap_test_load_layout(double* out) {
  using namespace sdnap::epochs;
  const size_t values[] = {sizeof(Entry), sizeof(Series), sizeof(Slot), sizeof(sdnap::cov::Set),
    offsetof(Entry,row), offsetof(Entry,epoch), offsetof(Entry,cov), offsetof(Entry,forces),
    offsetof(Entry,atmosphere), offsetof(Entry,branch), offsetof(Entry,track), offsetof(Entry,handover),
    offsetof(Series,norad), offsetof(Series,object_id), offsetof(Series,originator), offsetof(Series,name),
    offsetof(Series,theory), offsetof(Series,met), offsetof(Series,first), offsetof(Series,count),
    offsetof(Series,carried), offsetof(Series,slots), offsetof(Series,next)};
  for(size_t k=0;k<sizeof(values)/sizeof(values[0]);++k) out[k]=values[k];
}`;
const failWasm=buildDiagnostic('load-memory-refusal',layoutProbe,s=>s,{'epoch_store.inc':s=>s.replace(
  'T* p = static_cast<T*>(mem::malloc(n * sizeof(T)));',
  'mem::note_failure(n * sizeof(T)); return false;\n    T* p = static_cast<T*>(nullptr);')});
const refused=await open(failWasm);
const failure=await invoke(refused,records.slice(0,4));
assert.notEqual(failure.statusCode,0);
assert.equal(failure.errorCode,'out-of-memory');
assert.match(failure.errorMessage,/An allocation failed/);
assert.equal(refused.instance.exports.sdnap_epochs_count(),0);
const layoutPtr=refused.instance.exports.sdnap_alloc(23*8);
refused.instance.exports.sdnap_test_load_layout(layoutPtr);
console.log('layout '+JSON.stringify(Array.from(new Float64Array(refused.memory.buffer,layoutPtr,23))));
await refused.destroy?.();
console.log(JSON.stringify({records:shuffled.length,afterLoad,oldBytes,storeBytes:stats[7],refusal:failure.errorCode}));
console.log('LOAD-MEMORY PASS');
