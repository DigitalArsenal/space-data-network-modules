import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import * as fb from 'flatbuffers';
import * as C from 'spacedatastandards.org/lib/js/CAT/main.js';import * as N from 'spacedatastandards.org/lib/js/NEV/main.js';import * as Q from 'spacedatastandards.org/lib/js/QRP/main.js';import {OMM} from 'spacedatastandards.org/lib/js/OMM/OMM.js';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';import {encodeTimerTick,decodeFlowNotice} from 'space-data-module-sdk/runtime-contracts';import {ommBytes} from './fixtures.mjs';
const pack=(r,c)=>{const b=new fb.Builder(4096);b.finishSizePrefixed(r.pack(b),'$'+c);return Buffer.from(b.asUint8Array());};
const frame=(portId,c,payload)=>({portId,payload,typeRef:{schemaName:c+'.fbs',fileIdentifier:c==='TimerTick'?'TICK':'$'+c,rootTypeName:c,wireFormat:'flatbuffer'}});
const now=Date.parse('2026-10-02T00:00:00Z');
function record(source,id){
 if(source==='primary'){const o=OMM.getRootAsOMM(new fb.ByteBuffer(ommBytes)).unpack();o.NORAD_CAT_ID=id;return pack(o,'OMM');}
 if(source==='catalog-attempts'){const log=Object.assign(new N.NEVT(),{NODE_ID:'synthetic-node',GENERATED_AT_MS:BigInt(now-10000)});log.EVENTS=[Object.assign(new N.NEVEventT(),{TIME_MS:BigInt(now-10000),SUBJECT:'catalog-object/'+id,COUNT:1n,DETAIL:'in progress input='+ 'a'.repeat(280)+'; '})];return pack(log,'NEV');}
 const c=Object.assign(new C.CATT(),{NORAD_CAT_ID:id,OBJECT_NAME:'SYNTHETIC',OBJECT_ID:'2099-999A'});
 if(source==='catalog-index'){c.PRODUCTS_AS_OF='2026-10-03T00:00:00.000Z';c.PRODUCTS=[Object.assign(new C.CATProductT(),{KIND:C.catalogProductKind.ApElements,RECORD_CID:'b'+'a'.repeat(58),SELECTION_REASON:'accepted exact-W fit; catalog-input='+'a'.repeat(280)+';'})];}
 return pack(c,'CAT');
}
test('default resident cap retains complete partition inputs and refuses partial rewrites',async()=>{
 const sources=['catalog-index','primary','identities'],cost=sources.reduce((n,x)=>n+record(x,1000000).length+256,0),limit=Math.floor(64*1024*1024/cost),results=[];
 for(const [total,partitions] of [[limit,1],[limit+1,1],[33000,1],[33000,2],[100000,8]]){
  const cfg={'catalog.provider':'synthetic-node','catalog.identity_provider':'synthetic','catalog.identity_source':'identities','catalog.weather_provider':'synthetic','catalog.weather_source':'weather','catalog.seed_sources':['primary'],'catalog.seed_providers':['synthetic'],'catalog.page_size':1000,'catalog.partition_count':partitions,'catalog.partition_index':0};
  const dir=new URL('../dist/flow/control/',import.meta.url);const h=await createBrowserModuleHarness({wasmSource:fs.readFileSync(new URL('dist/isomorphic/module.wasm',dir)),manifest:JSON.parse(fs.readFileSync(new URL('plugin-manifest.json',dir))),surface:'direct',hostOptions:{config:cfg}});
  try{let response=await h.invoke({methodId:'advance',inputs:[frame('tick','TimerTick',encodeTimerTick({triggerId:'refresh',firedMs:now}))]});let notice;
   for(let i=0;i<10000;i++){
    assert.equal(response.statusCode,0,response.errorMessage);const out=Object.fromEntries(response.outputs.map(x=>[x.portId,x]));
    if(out.notice){notice=decodeFlowNotice(out.notice.payload);break;}assert.ok(out.query,'capacity or clock guard prevents every object dispatch/write');
    const q=Q.QRP.getRootAsQRP(new fb.ByteBuffer(out.query.payload)).unpack();const count=q.SOURCE_NAME==='weather'||q.SOURCE_NAME.startsWith('catalog-attempts')?0:total,offset=Number(q.CURSOR||0),end=Math.min(count,offset+q.LIMIT);
    const rows=Array.from({length:end-offset},(_,k)=>record(q.SOURCE_NAME,1000000+offset+k));const header=Object.assign(new Q.QRPT(),{KIND:Q.qrpKind.Page,STATUS:Q.qrpStatus.Ok,SCHEMA_NAME:q.SCHEMA_NAME,PROVIDER_ID:q.PROVIDER_ID,SOURCE_NAME:q.SOURCE_NAME,RECORD_COUNT:rows.length,TOTAL_COUNT:BigInt(count),NEXT_CURSOR:end<count?String(end):null});
    response=await h.invoke({methodId:'advance',inputs:[frame('page','QRP',Buffer.concat([pack(header,'QRP'),...rows])),frame('query_status','QRP',out.query.payload)]});
   }
   assert.ok(notice);const bytes=Number(/resident-bytes=(\d+)/.exec(notice.reason)[1]),triples=Number(/retained-triples=(\d+)/.exec(notice.reason)[1]);assert.ok(bytes<=64*1024*1024);
   if(Math.ceil(total/partitions)<=limit)assert.equal(triples,Math.ceil(total/partitions));else assert.match(notice.reason,/raise the binding setting/);
   results.push({total,partitions,bytes,triples,limited:/scan partial/.test(notice.reason)});
  }finally{h.destroy();}
 }
 console.log(JSON.stringify({synthetic:true,perObjectAccountedBytes:cost,defaultCapObjects:limit,cases:results}));
});
