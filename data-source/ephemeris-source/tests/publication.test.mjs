// The scheduled adapter end to end under node:wasi, every hostcall a typed $PIV call (sdm_piv): plugin.getConfig (one
// ModuleConfig), http.request, ipfs.add / ipfs.cat, storage.write ($IRM), storage.flatsql_query_stream and
// storage.ingest_with_source (typed Provenance + attributes). Raw bytes are archived exactly, NCD records attributed, the
// durable position and the archive ledger ($SRG STATUS in the IRM decode context) survive recreated instances.
import assert from 'node:assert/strict';import test from 'node:test';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import path from 'node:path';
import {nativeFixture,srgPort,statusOf,readSrg,STATE,tick,outputs} from './harness.mjs';
const require=createRequire(import.meta.url),sds=path.dirname(require.resolve('spacedatastandards.org/package.json'));const {ByteBuffer,Builder}=require('flatbuffers');
const classes={};for(const code of ['NCD','IRM'])classes[code]=(await import(pathToFileURL(path.join(sds,'lib/js',code,'main.js'))))[code];
const record=(code,bytes)=>classes[code]['getSizePrefixedRootAs'+code](new ByteBuffer(Uint8Array.from(bytes))).unpack();
const hash=(x)=>createHash('sha256').update(x).digest('hex');
const text=(x)=>new TextDecoder().decode(x);
const repack=(code,row)=>{const b=new Builder(1024);b.finishSizePrefixed(row.pack(b),'$'+code);return Buffer.from(b.asUint8Array());};
const ledger=(row)=>readSrg(row.DECODE_CONTEXT.DECODER_STATE).STATUS;
const reserved=(f)=>Number(ledger(f.stored.get('IRM').at(-1).row).ARCHIVE_RESERVED_BYTES);
const pull=(h)=>h.invoke({methodId:'pull',inputs:[tick()]});
function fixture(count=5) {
 const files=new Map(),stored=new Map(),calls=[],requests=[];let failAt='',httpStatus=200,configuration={ephemeris_enabled:true,ephemeris_source_id:'spacex-starlink',ephemeris_max_resources:2};
 const manifest=Array.from({length:count},(_,i)=>`STARLINK-${i}.txt`).join('\n');
 const handler=(op,call)=>{calls.push(op);const p=call.params??{},raw=call.raw??{};
  if(op===failAt)throw Error('injected durable capability failure');
  if(op==='plugin.getConfig')return configuration;
  if(op==='http.request'){const url=text(raw.url);requests.push(url);assert.ok(Number(p.MAX_BYTES)<=16777216);assert.equal(p.METHOD,'GET');
   return {result:{STATUS:httpStatus,RETRIEVED_MS:0n},raw:{url:raw.url,headers:new TextEncoder().encode('etag: fixture-etag\r\n'),body:new TextEncoder().encode(url.endsWith('MANIFEST.txt')?manifest:'MEME fixture ephemeris body '+url)}};}
  if(op==='ipfs.add'){const cid='bafy'+hash(raw.data);files.set(cid,Buffer.from(raw.data));return {result:{CID:cid}};}
  if(op==='ipfs.cat')return {raw:{data:files.get(p.CID)}};
  if(op==='storage.ingest_with_source'){assert.equal(p.PROVIDER_ID,'ephemeris-provider:spacex-starlink');assert.equal(p.SOURCE_NAME,'spacex-starlink');assert.equal(p.RECONCILE,0);
   const [provenance]=call.lists.provenance;const attributes=Object.fromEntries(call.lists.provenance_attributes.map((a)=>[a.NAME,a.VALUE]));
   if(p.SCHEMA==='NCD.fbs'){const row=record('NCD',raw.records);assert.equal(p.BATCH_ID,row.SOURCE_SHA256);assert.equal(provenance.SOURCE_SHA256,row.SOURCE_SHA256);assert.equal(attributes.source_cid,row.SOURCE_CID);assert.equal(provenance.SOURCE_URL,p.SOURCE_URL);
    stored.set('NCD',[...(stored.get('NCD')??[]),{bytes:Buffer.from(raw.records),row,attributes}]);}
   return {result:{SCHEMA:p.SCHEMA,BATCH_ID:p.BATCH_ID,INSERTED:1n}};}
  if(op==='storage.write'){const code=p.SCHEMA.replace('.fbs','');const row=record(code,raw.data);stored.set(code,[...(stored.get(code)??[]),{bytes:Buffer.from(raw.data),row}]);return {result:{CID:'fixture'+hash(raw.data)}};}
  if(op==='storage.flatsql_query_stream'){assert.match(text(raw.sql),/FROM IRM WHERE JOB_ID = \?/);const latest=stored.get('IRM')?.at(-1);return latest?{result:{ROWS:1n,COLUMNS:1},raw:{stream:latest.bytes}}:{result:{ROWS:0n}};}
  throw Error('Unexpected capability '+op);
 };
 return {handler,files,stored,calls,requests,setFailure:(op)=>failAt=op,setHTTP:(status)=>httpStatus=status,setConfig:(value)=>configuration=value};
}
test('archives exact raw bytes, attributes NCD records, and resumes all resources across recreated WASI instances',async()=>{
 const f=fixture();
 for(const [completed,remaining] of [[2,3],[4,1],[5,0]]){const h=await nativeFixture(f.handler);const s=statusOf(pull(h));assert.equal(s.COMPLETED_COUNT,completed);assert.equal(s.REMAINING_COUNT,remaining);assert.equal(s.NORMALIZED_RECORDS,0n);assert.equal(s.STATE,remaining?STATE.InProgress:STATE.Complete);}
 assert.equal(f.requests.filter((x)=>x.endsWith('MANIFEST.txt')).length,1);assert.equal(f.stored.get('NCD').length,5);
 for(const {row} of f.stored.get('NCD')){const raw=f.files.get(row.SOURCE_CID);assert.equal(row.SOURCE_SHA256,hash(raw));assert.equal(row.SOURCE_BYTE_LENGTH,BigInt(raw.length));}
 const mark=f.stored.get('IRM').at(-1).row;assert.equal(mark.NEXT_CHUNK_INDEX,5);assert.equal(mark.CHUNKS_COMMITTED,5);assert.ok(!/[{}]/.test(mark.NOTES),'no JSON in IRM NOTES');
 assert.equal(mark.DECODE_CONTEXT.DECODER_STATE_FORMAT,'$SRG');assert.equal(ledger(mark).QUEUE_CID,mark.SOURCE.SOURCE_CID);
 // The pinned discovery queue is an $SRG with RESOURCES, never a JSON envelope.
 assert.deepEqual(readSrg(f.files.get(mark.SOURCE.SOURCE_CID)).RESOURCES.map((r)=>r.RESOURCE_ID),Array.from({length:5},(_,i)=>`STARLINK-${i}.txt`));
 const h=await nativeFixture(f.handler);assert.equal(statusOf(pull(h)).STATE,STATE.WaitingRefresh);
});
test('failed source ingestion never advances the durable source position',async()=>{
 const f=fixture(3),first=await nativeFixture(f.handler);pull(first);const position=f.stored.get('IRM').at(-1).row.NEXT_CHUNK_INDEX;
 f.setFailure('storage.ingest_with_source');const broken=await nativeFixture(f.handler);assert.notEqual(pull(broken).statusCode,0);assert.equal(f.stored.get('IRM').at(-1).row.NEXT_CHUNK_INDEX,position);
 f.setFailure('');const retry=await nativeFixture(f.handler);assert.equal(statusOf(pull(retry)).REMAINING_COUNT,0);assert.equal(f.stored.get('IRM').at(-1).row.NEXT_CHUNK_INDEX,3);
});
test('persists a zero-position queue before the first ingest, and retries it unchanged',async()=>{
 const f=fixture(3);f.setFailure('storage.ingest_with_source');const broken=await nativeFixture(f.handler);assert.notEqual(pull(broken).statusCode,0);const mark=f.stored.get('IRM').at(-1).row;assert.equal(mark.NEXT_CHUNK_INDEX,0);assert.equal(f.stored.has('NCD'),false);
 f.setFailure('');const retry=await nativeFixture(f.handler);assert.equal(statusOf(pull(retry)).COMPLETED_COUNT,2);assert.equal(f.requests.filter((x)=>x.endsWith('MANIFEST.txt')).length,1);assert.equal(f.stored.get('IRM').at(-1).row.SOURCE.SOURCE_CID,mark.SOURCE.SOURCE_CID);
});
test('HTTP 503 returns a structured error and the same instance can continue',async()=>{
 const f=fixture(3),h=await nativeFixture(f.handler);f.setHTTP(503);const failed=pull(h);assert.notEqual(failed.statusCode,0);assert.match(failed.errorMessage,/Discovery requires/);assert.equal(f.stored.has('NCD'),false);f.setHTTP(200);assert.equal(statusOf(pull(h)).COMPLETED_COUNT,2);
});
test('configure restores safe runtime settings without fetching, then standalone cron uses them',async()=>{
 const f=fixture(3);f.setConfig(null);const h=await nativeFixture(f.handler),settings={ENABLED:true,SOURCE_ID:'spacex-starlink',MAX_RESOURCES:2};
 assert.equal(statusOf(pull(h)).STATE,STATE.Disabled);
 const configured=h.invoke({methodId:'configure',inputs:[srgPort('settings',{settings})]});assert.deepEqual([statusOf(configured).STATE,statusOf(configured).SOURCE_ID,statusOf(configured).ENABLED],[STATE.Configured,'spacex-starlink',true]);assert.equal(f.requests.length,0);
 assert.equal(statusOf(pull(h)).COMPLETED_COUNT,2);
 const reloaded=await nativeFixture(f.handler);assert.equal(reloaded.invoke({methodId:'configure',inputs:[srgPort('settings',{settings})]}).statusCode,0);assert.equal(statusOf(pull(reloaded)).REMAINING_COUNT,0);
 const rejected=reloaded.invoke({methodId:'configure',inputs:[srgPort('settings',{settings:{...settings,CREDENTIAL_REFERENCE:'never persist this'}})]});assert.notEqual(rejected.statusCode,0);assert.ok(!rejected.errorMessage.includes('never persist'));
 assert.equal(statusOf(pull(reloaded)).STATE,STATE.WaitingRefresh);
});
test('archive reservations survive a crash before queue pin and conservatively charge retries',async()=>{
 const f=fixture(2);f.setFailure('ipfs.add');let h=await nativeFixture(f.handler);assert.notEqual(pull(h).statusCode,0);assert.equal(f.files.size,0);const initial=reserved(f);assert.ok(initial>0);assert.equal(f.stored.get('IRM').at(-1).row.NEXT_CHUNK_INDEX,0);assert.equal(f.stored.get('IRM').at(-1).row.SOURCE.SOURCE_CID,null);
 f.setFailure('');h=await nativeFixture(f.handler);assert.equal(pull(h).statusCode,0);assert.ok(reserved(f)>2*initial);assert.equal(f.stored.get('IRM').at(-1).row.NEXT_CHUNK_INDEX,2);
});
test('raw budget stops before pin and never advances an uncommitted resource across restart',async()=>{
 const f=fixture(2);f.setConfig({ephemeris_enabled:true,ephemeris_source_id:'spacex-starlink',ephemeris_max_resources:2,ephemeris_archive_max_bytes:1024});
 const handler=(op,call)=>op==='http.request'&&!text(call.raw.url).endsWith('MANIFEST.txt')?{result:{STATUS:200},raw:{body:new TextEncoder().encode('MEME '+'x'.repeat(1024))}}:f.handler(op,call);
 let h=await nativeFixture(handler),s=statusOf(pull(h));assert.equal(s.STATE,STATE.ArchiveBudgetReached);assert.equal(s.ARCHIVE_MAX_BYTES,1024n);const budget=reserved(f);assert.equal(f.files.size,1);assert.equal(f.stored.has('NCD'),false);assert.equal(f.stored.get('IRM').at(-1).row.NEXT_CHUNK_INDEX,0);
 h=await nativeFixture(handler);s=statusOf(pull(h));assert.equal(s.REMAINING_COUNT,2);assert.equal(reserved(f),budget);assert.equal(f.files.size,1);
});
test('archive reservation is cumulative across refreshes and pins that precede failed ingestion',async()=>{
 const f=fixture(1);let h=await nativeFixture(f.handler);f.setFailure('storage.ingest_with_source');assert.notEqual(pull(h).statusCode,0);const failedCharge=reserved(f);assert.equal(f.files.size,2);
 f.setFailure('');h=await nativeFixture(f.handler);assert.equal(pull(h).statusCode,0);assert.ok(reserved(f)>failedCharge);const prior=reserved(f),latest=f.stored.get('IRM').at(-1);latest.row.UPDATED_AT='2000-01-01T00:00:00.000Z';latest.bytes=repack('IRM',latest.row);
 h=await nativeFixture(f.handler);assert.equal(pull(h).statusCode,0);assert.ok(reserved(f)>prior);assert.equal(f.requests.filter((x)=>x.endsWith('MANIFEST.txt')).length,2);
});
test('unledgered or JSON-ledger legacy checkpoints fail closed without requesting or pinning new files',async()=>{
 const f=fixture(1);let h=await nativeFixture(f.handler);assert.equal(pull(h).statusCode,0);const latest=f.stored.get('IRM').at(-1);
 latest.row.DECODE_CONTEXT=null;latest.row.NOTES=JSON.stringify({archive_ledger_version:1,archive_reserved_bytes:10});latest.bytes=repack('IRM',latest.row);const requests=f.requests.length,pins=f.files.size;
 h=await nativeFixture(f.handler);const result=pull(h);assert.notEqual(result.statusCode,0);assert.match(result.errorMessage,/archive ledger/);assert.equal(f.requests.length,requests);assert.equal(f.files.size,pins);
});
test('large HTML directory responses stay within the adapter memory',async()=>{
 // ESA CPF directory observed 2026-09-09: 11,069,991 bytes and 63,165 links. Exercise the full 16 MiB response budget.
 const prefix='<a href="lageos1_cpf_260908_1.esa">old</a>\n',suffix='<a href="lageos1_cpf_260909_2.esa">new</a>\n';
 const html=new TextEncoder().encode(prefix+' '.repeat(16*1024*1024-prefix.length-suffix.length)+suffix);
 let requests=0,ingested=0;
 const h=await nativeFixture((op,call)=>{
  if(op==='plugin.getConfig')return {ephemeris_enabled:true,ephemeris_source_id:'cpf',ephemeris_max_resources:1};
  if(op==='storage.flatsql_query_stream')return {result:{ROWS:0n}};
  if(op==='http.request'){requests++;return {result:{STATUS:200},raw:{body:text(call.raw.url).endsWith('/')?html:new TextEncoder().encode('H1 CPF 2 ESA fixture')}};}
  if(op==='ipfs.add')return {result:{CID:'bafy'+hash(call.raw.data)}};
  if(op==='storage.write')return {result:{CID:'bafy'+hash(call.raw.data)}};
  if(op==='storage.ingest_with_source'){assert.equal(call.params.SOURCE_NAME,'cpf');assert.ok(call.params.SOURCE_URL.endsWith('lageos1_cpf_260909_2.esa'));ingested++;return {result:{INSERTED:1n}};}
  throw Error(op);
 });
 const s=statusOf(pull(h));assert.equal(s.STATE,STATE.Complete);assert.equal(requests,2);assert.equal(ingested,1);
});
