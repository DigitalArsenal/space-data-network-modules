import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import * as fb from 'flatbuffers';
import * as N from 'spacedatastandards.org/lib/js/NEV/main.js';
import * as C from 'spacedatastandards.org/lib/js/CAT/main.js';
import * as O from 'spacedatastandards.org/lib/js/OMM/main.js';
import * as Q from 'spacedatastandards.org/lib/js/QRP/main.js';
import {OCM} from 'spacedatastandards.org/lib/js/OCM/OCM.js';
import {encodeTimerTick,decodeIngestRequest,encodeIngestResult,decodeFlowNotice} from 'space-data-module-sdk/runtime-contracts';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {ommBytes} from './fixtures.mjs';

// Host failures exercise persistence without running thousands of numerical fits.
// One real ingestion supplies the valid fallback shape; all object inputs are synthetic.
export async function verifyStateRetention(mode){
 const repo=fileURLToPath(new URL('../../../',import.meta.url));
 const dir=process.env.CATALOG_CONTROLLER_DIR||fileURLToPath(new URL('../dist/flow/control',import.meta.url));
 const pack=(x,c,pref=true)=>{const b=new fb.Builder(1024);pref?b.finishSizePrefixed(x.pack(b),'$'+c):b.finish(x.pack(b),'$'+c);return Buffer.from(b.asUint8Array());};
 const frame=(portId,c,payload)=>({portId,payload,typeRef:{schemaName:c+'.fbs',fileIdentifier:{TimerTick:'TICK',IngestResult:'INGR'}[c]??'$'+c,rootTypeName:c,wireFormat:'flatbuffer'}});
 const split=b=>{const rows=[];for(let i=0;i<b.length;){const n=b.readUInt32LE(i)+4;rows.push(b.subarray(i,i+n));i+=n;}return rows;};
 const seed=O.OMM.getRootAsOMM(new fb.ByteBuffer(ommBytes)).unpack();
 const now=Date.parse(seed.EPOCH+'Z')+86400000;
 const cfg={'catalog.provider':'synthetic-node','catalog.identity_provider':'synthetic','catalog.identity_source':'identities','catalog.weather_provider':'synthetic','catalog.weather_source':'weather','catalog.seed_sources':['primary'],'catalog.seed_providers':['synthetic'],'catalog.page_size':512,'catalog.batch_size':2};
 const seeds=[],identities=[];
 for(let i=0;i<(mode==='final'?4096:mode==='prepared'?2:1);i++){const id=3000000+i;seeds.push(pack(Object.assign(new O.OMMT(),seed,{NORAD_CAT_ID:id}),'OMM'));identities.push(pack(Object.assign(new C.CATT(),{NORAD_CAT_ID:id,OBJECT_NAME:'SYNTHETIC'}),'CAT'));}
 const chain=await createStandaloneHarness('browser',repo+'/flows/catalog-builder/dist/isomorphic/module.wasm',{surface:'direct',enableBrowserWasiThreads:false});
 let fallback;
 try{const r=await chain.invoke({methodId:'ingest_seed',inputs:[frame('omm','OMM',ommBytes)]});assert.equal(r.statusCode,0,r.errorMessage);fallback=OCM.getRootAsOCM(new fb.ByteBuffer(r.outputs.find(f=>f.portId==='fallback').payload)).unpack();}finally{chain.destroy();}
 const create=()=>createBrowserModuleHarness({wasmSource:fs.readFileSync(dir+'/dist/isomorphic/module.wasm'),manifest:JSON.parse(fs.readFileSync(dir+'/plugin-manifest.json')),surface:'direct',hostOptions:{config:cfg}});
 let control=await create();let state=[],history=[];const index=new Map(),journal=new Set(),fitCounts=new Map();let failing=mode==='final';const newcomer=2999999;
 const composer=await createBrowserModuleHarness({wasmSource:fs.readFileSync(repo+'/analysis/catalog-composer/dist/isomorphic/module.wasm'),manifest:JSON.parse(fs.readFileSync(repo+'/analysis/catalog-composer/plugin-manifest.json')),surface:'direct'});
 const cid=b=>{const data=Buffer.concat([Buffer.from([1,0x55,0x12,0x20]),createHash('sha256').update(b).digest()]);let bits=0,value=0,out='b';for(const byte of data){value=(value<<8)|byte;bits+=8;while(bits>=5){bits-=5;out+='abcdefghijklmnopqrstuvwxyz234567'[(value>>>bits)&31];}}if(bits)out+='abcdefghijklmnopqrstuvwxyz234567'[(value<<(5-bits))&31];return out;};
 const sha=b=>createHash('sha256').update(b).digest('hex');
 const latest=rows=>{const events=new Map();for(const row of rows)for(const e of N.NEV.getSizePrefixedRootAsNEV(new fb.ByteBuffer(row)).unpack().EVENTS){const old=events.get(e.SUBJECT);if(!old||Number(e.DETAIL.match(/sequence=(\d+);/)[1])>Number(old.DETAIL.match(/sequence=(\d+);/)[1]))events.set(e.SUBJECT,e);}return [...events.values()].sort((a,b)=>a.SUBJECT.localeCompare(b.SUBJECT));};
 async function tick(time,kill=false){
  const counts={indexes:0,fits:0,writes:0,snapshots:0,maxRows:state.length};
  let r=await control.invoke({methodId:'advance',inputs:[frame('tick','TimerTick',encodeTimerTick({triggerId:'refresh',firedMs:time}))]});
  for(let step=0;step<50000;step++){
   assert.equal(r.statusCode,0,r.errorMessage);const out=Object.fromEntries(r.outputs.map(f=>[f.portId,f]));let inputs;
   if(out.notice){counts.notice=decodeFlowNotice(out.notice.payload);return counts;}
   if(out.query){const q=Q.QRP.getRootAsQRP(new fb.ByteBuffer(out.query.payload)).unpack();const rows=q.SCHEMA_NAME==='NEV.fbs'?state:q.SCHEMA_NAME==='OMM.fbs'?seeds:q.SOURCE_NAME==='identities'?identities:q.SOURCE_NAME==='catalog-index'?[...index.values()]:[];
    const offset=Number(q.CURSOR||0),page=rows.slice(offset,offset+q.LIMIT),end=offset+page.length;
    const header=Object.assign(new Q.QRPT(),{KIND:Q.qrpKind.Page,STATUS:Q.qrpStatus.Ok,SCHEMA_NAME:q.SCHEMA_NAME,PROVIDER_ID:q.PROVIDER_ID,SOURCE_NAME:q.SOURCE_NAME,BATCH_ID:q.BATCH_ID,RECORD_COUNT:page.length,TOTAL_COUNT:BigInt(rows.length),NEXT_CURSOR:end<rows.length?String(end):null});
    inputs=[frame('page','QRP',Buffer.concat([pack(header,'QRP'),...page]))];
   }else if(out.seed){++counts.fits;const id=O.OMM.getRootAsOMM(new fb.ByteBuffer(out.seed.payload)).NORAD_CAT_ID();fallback.METADATA.NORAD_CAT_ID=id;fitCounts.set(id,(fitCounts.get(id)||0)+1);
    inputs=[frame('fallback','OCM',pack(fallback,'OCM',false)),frame('chain_status','QRP',pack(Object.assign(new Q.QRPT(),{KIND:Q.qrpKind.Error,STATUS:Q.qrpStatus.Error,ERROR_CODE:'outside-ap-class'}),'QRP',false))];
   }else if(out.annotate_orbit){if(!failing||OCM.getSizePrefixedRootAsOCM(new fb.ByteBuffer(out.annotate_orbit.payload)).METADATA().NORAD_CAT_ID()===newcomer){inputs=[frame('annotated','OCM',out.annotate_orbit.payload)];}else inputs=[frame('annotation_status','QRP',pack(Object.assign(new Q.QRPT(),{KIND:Q.qrpKind.Error,STATUS:Q.qrpStatus.Error,ERROR_CODE:'invalid-models'}),'QRP',false))];
   }else if(out.recipe){const result=await composer.invoke({methodId:'replace_products',inputs:[out.recipe,out.catalog,{...out.selection,portId:'decision'},...(out.selected?[{...out.selected,portId:'ocm_products'}]:[])]});assert.equal(result.statusCode,0,result.errorMessage);inputs=result.outputs.map(f=>({...f,portId:f.portId==='decision'?'compose_status':'replacement'}));
   }else if(out.product_records||out.index_records){const m=decodeIngestRequest(out.meta.payload),rows=split(Buffer.from((out.product_records??out.index_records).payload));
    if(out.product_records){for(const row of rows)journal.add(cid(row));if(kill){journal.clear();return counts;}}
    if(out.index_records){for(const row of rows){const cat=C.CAT.getSizePrefixedRootAsCAT(new fb.ByteBuffer(row)).unpack();for(const product of cat.PRODUCTS)assert.ok(journal.has(product.RECORD_CID),'terminal generation references a re-sent product');index.set(cat.NORAD_CAT_ID,row);}counts.indexes+=rows.length;}
    inputs=[frame('stored','IngestResult',encodeIngestResult({schema:m.schema,...m.tags,inserted:rows.length,reconciledDuplicates:0}))];   }else if(out.state_records){const m=decodeIngestRequest(out.meta.payload),rows=split(Buffer.from(out.state_records.payload));assert.equal(m.schema,'NEV.fbs');++counts.writes;history.push(...rows);
    if(m.reconcile==='current'){++counts.snapshots;state=rows;}else{assert.equal(m.reconcile,'none');state.push(...rows);}counts.maxRows=Math.max(counts.maxRows,state.length);
    inputs=[frame('stored','IngestResult',encodeIngestResult({schema:m.schema,...m.tags,inserted:rows.length,reconciledDuplicates:0}))];
   }else assert.fail('Unexpected controller output: '+Object.keys(out));
   r=await control.invoke({methodId:'advance',inputs});
  }
  assert.fail('State bound test exceeded its operation cap');
 }
 const events=()=>state.flatMap(b=>N.NEV.getSizePrefixedRootAsNEV(new fb.ByteBuffer(b)).unpack().EVENTS);
 const snapshot=entries=>{const log=new N.NEVT();log.NODE_ID='synthetic-node';log.GENERATED_AT_MS=BigInt(now);log.EVENTS=entries;state=[pack(log,'NEV')];};
 const poisonEntries=count=>Array.from({length:count},(_,i)=>Object.assign(new N.NEVEventT(),{TIME_MS:BigInt(now),KIND:N.nevEventKind.Warning,SUBJECT:'catalog-invalid/'+sha(Buffer.from('removed defect '+i))+'/'+sha(Buffer.from('OMM/synthetic/primary')),COUNT:3n,DETAIL:'OMM/synthetic/primary; sequence='+(10000+i)+';'}));
 try{
  let oldest,prepared;
  if(mode==='final'){
   cfg['catalog.batch_size']=1024;control.destroy();control=await create();let total=0;for(let i=0;i<4;i++)total+=(await tick(now)).fits;assert.equal(total,4096);cfg['catalog.batch_size']=2;assert.equal(latest(state).length,4096);
   const all=latest(state);assert.ok(all.every(e=>e.DETAIL.startsWith('final ')));
   // Put the oldest final failure last in work order, so its single retry is observable.
   all.forEach((e,i)=>e.DETAIL=e.DETAIL.replace(/sequence=\d+;/,'sequence='+(4096-i)+';'));snapshot(all);
   seeds.unshift(pack(Object.assign(new O.OMMT(),seed,{NORAD_CAT_ID:newcomer}),'OMM'));identities.unshift(pack(Object.assign(new C.CATT(),{NORAD_CAT_ID:newcomer,OBJECT_NAME:'SYNTHETIC'}),'CAT'));
  }else if(mode==='prepared'){
   cfg['catalog.batch_size']=3;control.destroy();control=await create();snapshot(poisonEntries(4096));
   await tick(now,true);const interrupted=latest(state);while(interrupted.length>4096){const candidates=interrupted.filter(e=>e.SUBJECT.startsWith('catalog-invalid/')).sort((a,b)=>Number(a.DETAIL.match(/sequence=(\d+);/)[1])-Number(b.DETAIL.match(/sequence=(\d+);/)[1]));interrupted.splice(interrupted.indexOf(candidates[0]),1);}assert.equal(interrupted.length,4096,'replayed interruption state is at cache capacity');
   prepared=interrupted.filter(e=>e.SUBJECT.startsWith('catalog-object/'));assert.equal(prepared.length,2);
   for(const e of prepared){assert.match(e.DETAIL,/product-batch=catalog-[a-f0-9]{64}; prepared-generation;/);e.DETAIL=e.DETAIL.replace(/^in progress /,'ready ');}
   const entries=interrupted.filter(e=>e.SUBJECT.startsWith('catalog-invalid/'));oldest=entries.reduce((a,b)=>Number(a.DETAIL.match(/sequence=(\d+);/)[1])<Number(b.DETAIL.match(/sequence=(\d+);/)[1])?a:b).SUBJECT;
   // Make the recovery references older than other entries to exercise their protection.
   prepared.forEach((e,i)=>e.DETAIL=e.DETAIL.replace(/sequence=\d+;/,'sequence='+(i+1)+';'));
   snapshot([...prepared,...entries]);
   seeds.unshift(pack(Object.assign(new O.OMMT(),seed,{NORAD_CAT_ID:newcomer}),'OMM'));identities.unshift(pack(Object.assign(new C.CATT(),{NORAD_CAT_ID:newcomer,OBJECT_NAME:'SYNTHETIC'}),'CAT'));
  }else{
   const all=poisonEntries(4096);oldest=all[0].SUBJECT;
   if(mode==='absent')all.forEach((e,i)=>{e.SUBJECT='catalog-object/'+(4000000+i);e.DETAIL='retry input=absent; sequence='+(i+1)+';';});
   snapshot(all);
  }
  if(mode==='suspect'){
   const interrupted=Object.assign(new N.NEVEventT(),{TIME_MS:BigInt(now),KIND:N.nevEventKind.Warning,SUBJECT:'catalog-object/4000000',COUNT:1n,DETAIL:'retry input=absent; sequence=1; instance-interrupted;'});
   snapshot([interrupted,...poisonEntries(4095)]);
   seeds.push(pack(new C.CATT(),'CAT'));
  }
  if(mode==='poison'){
   // Overlapping histories can deliver old events after the newest snapshot.
   const stale=poisonEntries(2);stale.forEach((e,i)=>{e.SUBJECT+='-stale';e.DETAIL=e.DETAIL.replace(/sequence=\d+;/,'sequence='+(i+1)+';');});
   const current=state.slice();snapshot(stale);state=[...current,...state];
  }
  const runs=[];history=[];
  for(let i=0;i<3;i++){control.destroy();control=await create();runs.push(await tick(now+1000+i));}
  console.log('RETENTION_FIFO '+JSON.stringify({mode,runs:runs.map(r=>({fits:r.fits,indexes:r.indexes,kind:r.notice.kind,reason:r.notice.reason}))}));
  assert.ok(runs[0].indexes>0,'new object builds on the first run at capacity');
  if(mode==='suspect'){
   assert.ok(events().some(e=>e.SUBJECT==='catalog-object/4000000'&&e.DETAIL.includes('instance-interrupted;')),'source-scan eviction preserves the interruption suspect');
   assert.match(runs[0].notice.reason,/evicted=2/);return;
  }
  if(mode==='absent')assert.equal(events().length,0,'complete compaction frees absent entries');
  else {
   assert.equal(runs[0].notice.kind,'info');assert.match(runs[0].notice.reason,/evicted=[1-9]/);
   assert.ok(events().length<=4096);
   if(mode==='final'){
    assert.equal(runs[0].fits,2,'new object and the evicted final failure are fitted');assert.equal(fitCounts.get(3004095),2,'evicted final failure is fitted exactly once more');
    assert.ok(events().some(e=>e.SUBJECT==='catalog-object/3004095'&&e.DETAIL.startsWith('final ')),'evicted final failure is recorded again');
   }else {
    assert.ok(!events().some(e=>e.SUBJECT===oldest),'oldest unprotected event is evicted');
    if(mode==='prepared'){
     assert.equal(runs[0].indexes,3,'recovery generation completes with both recovered objects and the new object');
     const recoveryEvents=history.flatMap(row=>N.NEV.getSizePrefixedRootAsNEV(new fb.ByteBuffer(row)).unpack().EVENTS);
     for(const entry of prepared)assert.ok(recoveryEvents.some(e=>e.SUBJECT===entry.SUBJECT&&e.DETAIL.includes(entry.DETAIL.match(/product-batch=[^;]+;/)[0])),'recovery dispatch preserves the prior product lookup reference');
     assert.equal(events().filter(e=>e.SUBJECT.startsWith('catalog-invalid/')).length,4093,'restart evicts only one additional older poison');
    }else {
     assert.equal(events().length,4095,'one old poison is evicted for one new object');
     assert.ok(events().some(e=>e.SUBJECT===poisonEntries(2)[1].SUBJECT),'late stale events cannot displace newer entries');
     assert.ok(!events().some(e=>e.SUBJECT.endsWith('-stale')));assert.match(runs[0].notice.reason,/evicted=3/);
    }
   }
  }
 }finally{control.destroy();composer.destroy();}
}
