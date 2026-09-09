import assert from 'node:assert/strict';import test from 'node:test';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import path from 'node:path';
import {nativeFixture,output,input} from './harness.mjs';
const require=createRequire(import.meta.url),sds=path.dirname(require.resolve('spacedatastandards.org/package.json'));const {ByteBuffer}=require('flatbuffers');
const classes={};for(const code of ['NCD','IRM'])classes[code]=(await import(pathToFileURL(path.join(sds,'lib/js',code,'main.js'))))[code];
const record=(code,bytes)=>classes[code]['getSizePrefixedRootAs'+code](new ByteBuffer(bytes)).unpack();
const hash=x=>createHash('sha256').update(x).digest('hex');
function fixture(count=5) {
 const files=new Map(),stored=new Map(),calls=[],requests=[];let failAt='',httpStatus=200,configuration={ephemeris_enabled:true,ephemeris_source_id:'spacex-starlink',ephemeris_max_resources:2};
 const manifest=Array.from({length:count},(_,i)=>`STARLINK-${i}.txt`).join('\n');
 const dispatch=(op,p)=>{calls.push(op);
  if(op===failAt)throw Error('injected durable capability failure');
  if(op==='plugin.getConfig')return configuration;
  if(op==='http.request'){requests.push(p.url);assert.ok(p.max_bytes<=16777216);return {status:httpStatus,body:p.url.endsWith('MANIFEST.txt')?manifest:'MEME fixture ephemeris body '+p.url,headers:{etag:'fixture-etag'}};}
  if(op==='ipfs.add'){assert.ok(p.content instanceof Uint8Array);const cid='bafy'+hash(p.content);files.set(cid,Buffer.from(p.content));return {Hash:cid};}
  if(op==='ipfs.cat')return {data:files.get(p.cid)};
  if(op==='storage.ingest_with_source'){assert.equal(p.provider_id,'ephemeris-provider:spacex-starlink');assert.equal(p.source_name,'spacex-starlink');assert.equal(p.reconcile,'duplicates');const row=record('NCD',p.records);assert.equal(p.batch_id,row.SOURCE_SHA256);stored.set('NCD',[...(stored.get('NCD')??[]),{bytes:Buffer.from(p.records),row}]);return {inserted:1,batch_id:p.batch_id};}
  if(op==='storage.write'){const code=p.schema.replace('.fbs','');const row=record(code,p.data);stored.set(code,[...(stored.get(code)??[]),{bytes:Buffer.from(p.data),row}]);return {cid:'fixture'+hash(p.data)};}
  if(op==='storage.flatsql_query_stream'){const latest=stored.get('IRM')?.at(-1);return latest?{rows:1,stream:latest.bytes}:{rows:0};}
  throw Error('Unexpected capability '+op);
 };
 return {dispatch,files,stored,calls,requests,setFailure:op=>failAt=op,setHTTP:status=>httpStatus=status,setConfig:value=>configuration=value};
}
test('archives exact raw bytes, attributes NCD records, and resumes all resources across recreated WASI instances',async()=>{
 const f=fixture();
 for(const [completed,remaining] of [[2,3],[4,1],[5,0]]){const h=await nativeFixture(f.dispatch);const result=h.invoke({methodId:'pull',inputs:[]});assert.equal(result.statusCode,0,result.errorMessage);assert.equal(output(result,'status').completed,completed);assert.equal(output(result,'status').remaining,remaining);assert.equal(output(result,'status').normalized_records,0);}
 assert.equal(f.requests.filter(x=>x.endsWith('MANIFEST.txt')).length,1);assert.equal(f.stored.get('NCD').length,5);
 for(const {row} of f.stored.get('NCD')){const raw=f.files.get(row.SOURCE_CID);assert.equal(row.SOURCE_SHA256,hash(raw));assert.equal(row.SOURCE_BYTE_LENGTH,BigInt(raw.length));}
 assert.equal(f.stored.get('IRM').at(-1).row.NEXT_CHUNK_INDEX,5);assert.equal(f.stored.get('IRM').at(-1).row.CHUNKS_COMMITTED,5);
 const h=await nativeFixture(f.dispatch);assert.equal(output(h.invoke({methodId:'pull',inputs:[]}),'status').status,'waiting-refresh');
});
test('failed source ingestion never advances the durable source position',async()=>{
 const f=fixture(3),first=await nativeFixture(f.dispatch);first.invoke({methodId:'pull',inputs:[]});const position=f.stored.get('IRM').at(-1).row.NEXT_CHUNK_INDEX;
 f.setFailure('storage.ingest_with_source');const broken=await nativeFixture(f.dispatch);assert.notEqual(broken.invoke({methodId:'pull',inputs:[]}).statusCode,0);assert.equal(f.stored.get('IRM').at(-1).row.NEXT_CHUNK_INDEX,position);
 f.setFailure('');const retry=await nativeFixture(f.dispatch);assert.equal(output(retry.invoke({methodId:'pull',inputs:[]}),'status').remaining,0);assert.equal(f.stored.get('IRM').at(-1).row.NEXT_CHUNK_INDEX,3);
});

test('persists a zero-position queue before the first ingest, and retries it unchanged',async()=>{
 const f=fixture(3);f.setFailure('storage.ingest_with_source');const broken=await nativeFixture(f.dispatch);assert.notEqual(broken.invoke({methodId:'pull',inputs:[]}).statusCode,0);const mark=f.stored.get('IRM').at(-1).row;assert.equal(mark.NEXT_CHUNK_INDEX,0);assert.equal(f.stored.has('NCD'),false);
 f.setFailure('');const retry=await nativeFixture(f.dispatch);assert.equal(output(retry.invoke({methodId:'pull',inputs:[]}),'status').completed,2);assert.equal(f.requests.filter(x=>x.endsWith('MANIFEST.txt')).length,1);assert.equal(f.stored.get('IRM').at(-1).row.SOURCE.SOURCE_CID,mark.SOURCE.SOURCE_CID);
});

test('HTTP503 returns a structured error and the same instance can continue',async()=>{
 const f=fixture(3),h=await nativeFixture(f.dispatch);f.setHTTP(503);const failed=h.invoke({methodId:'pull',inputs:[]});assert.notEqual(failed.statusCode,0);assert.match(failed.errorMessage,/Discovery requires/);assert.equal(f.stored.has('NCD'),false);f.setHTTP(200);assert.equal(output(h.invoke({methodId:'pull',inputs:[]}),'status').completed,2);
});
test('configure restores safe runtime inputs without fetching, then standalone cron uses them',async()=>{
 const f=fixture(3);f.setConfig(null);const h=await nativeFixture(f.dispatch),options={ephemeris_enabled:true,ephemeris_source_id:'spacex-starlink',ephemeris_max_resources:2};
 assert.equal(output(h.invoke({methodId:'pull',inputs:[]}),'status').status,'disabled');
 const configured=h.invoke({methodId:'configure',inputs:[input('request',options)]});assert.equal(configured.statusCode,0,configured.errorMessage);assert.equal(f.requests.length,0);
 assert.equal(output(h.invoke({methodId:'pull',inputs:[]}),'status').completed,2);
 const reloaded=await nativeFixture(f.dispatch);assert.equal(reloaded.invoke({methodId:'configure',inputs:[input('request',options)]}).statusCode,0);assert.equal(output(reloaded.invoke({methodId:'pull',inputs:[]}),'status').remaining,0);
 const rejected=reloaded.invoke({methodId:'configure',inputs:[input('request',{...options,password:'never-persist-this-fixture'})]});assert.notEqual(rejected.statusCode,0);assert.ok(!rejected.errorMessage.includes('never-persist'));assert.equal(output(reloaded.invoke({methodId:'pull',inputs:[]}),'status').status,'waiting-refresh');
});
