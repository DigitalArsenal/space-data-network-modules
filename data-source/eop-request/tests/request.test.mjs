// eop-request on the typed contracts (1.0): a TimerTick in, one HttpRequest out whose CONTEXT is the parser job (a
// size-prefixed $ICN). End to end: the request's CONTEXT, echoed in an HttpResponse carrying the real published
// excerpt, is parsed by the built eop-parser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {createBrowserModuleHarness} from 'space-data-module-sdk/testing';
import {decodeHttpRequest,encodeTimerTick} from 'space-data-module-sdk/runtime-contracts';
import {TYPE,bodies,decodeRecords,meta,readJob,response,ICN_LIB} from '../../eop-parser/tests/harness.mjs';
const tick=()=>({portId:'tick',typeRef:TYPE.TICK,payload:encodeTimerTick({triggerId:'timer-eop',firedMs:Date.UTC(2026,9,13)})});
const SOURCES={finals2000a:['https://datacenter.iers.org/data/9/finals2000A.all','IERS finals2000A Bulletin A columns'],
 c04:['https://hpiers.obspm.fr/iers/eop/eopc04/eopc04.1962-now','IERS EOP 20 C04'],
 paris:['https://hpiers.obspm.fr/iers/eop/eopc04/eopc04_IAU2000.62-now','Paris Observatory EOP 20 C04 legacy IAU2000 format']};
test('three source methods turn a TimerTick into an HTTP GET carrying its $ICN job, which the parser reads back',async t=>{
 const h=await createBrowserModuleHarness({wasmSource:fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url)),surface:'direct'});t.after(()=>h.destroy());
 const p=await createBrowserModuleHarness({wasmSource:fs.readFileSync(new URL('../../eop-parser/dist/isomorphic/module.wasm',import.meta.url)),surface:'direct'});t.after(()=>p.destroy());
 for(const methodId of ['finals2000a','c04','paris']){
  const r=await h.invoke({methodId,inputs:[tick()]});assert.equal(r.statusCode,0,r.errorMessage);
  assert.deepEqual(r.outputs.map(x=>x.portId),['request']);
  const http=decodeHttpRequest(r.outputs[0].payload);
  assert.equal(http.method,'GET');assert.equal(http.maxBytes,16777216);assert.equal(http.timeoutMs,90000);assert.deepEqual(http.headers,{});
  assert.equal(http.url,SOURCES[methodId][0]);
  const job=readJob(http.context);
  assert.equal(job.CONNECTOR_ID,methodId);assert.equal(job.DATASET_ID,methodId);assert.equal(job.ENDPOINT_URL,http.url);assert.equal(job.SOURCE_NAME,SOURCES[methodId][1]);
  assert.equal(job.KIND,ICN_LIB.icnConnectorKind.HttpsPull);assert.equal(job.HTTP_METHOD,'GET');assert.equal(job.TARGET_SCHEMA,'EOP.fbs');assert.deepEqual(job.EMITS_SCHEMAS,['EOP']);
  assert.equal(job.POST_INGEST_ACTION,ICN_LIB.icnPostIngestAction.LeaveInPlace);
  // the connector echoes CONTEXT: the parser takes the job with the published excerpt
  const parsed=await p.invoke({methodId:`parse_${methodId}`,inputs:[response({url:http.url,status:200,body:bodies[methodId],context:http.context})]});
  assert.equal(parsed.statusCode,0,parsed.errorMessage);assert.ok(decodeRecords(parsed).length>0);
  const m=meta(parsed);assert.equal(m.tags.sourceUrl,http.url);assert.equal(m.tags.sourceName,SOURCES[methodId][1]);assert.equal(m.provenance.httpStatus,200);
  // a job for another method is refused, not reinterpreted
  const other=methodId==='c04'?'paris':'c04';
  const wrong=await p.invoke({methodId:`parse_${other}`,inputs:[response({status:200,body:bodies[other],context:http.context})]});
  assert.notEqual(wrong.statusCode,0);assert.equal(wrong.outputs.length,0);
 }
 // a CONTEXT that is not an $ICN is refused
 const bad=await p.invoke({methodId:'parse_c04',inputs:[response({status:200,body:bodies.c04,context:encodeTimerTick({})})]});assert.notEqual(bad.statusCode,0);
 // two ticks, a tick that is no TimerTick
 const r=await h.invoke({methodId:'c04',inputs:[tick(),tick()]});assert.notEqual(r.statusCode,0);assert.equal(r.outputs.length,0);
 const notTick=await h.invoke({methodId:'c04',inputs:[{...tick(),payload:Buffer.from('{}')}]});assert.notEqual(notTick.statusCode,0);
});
