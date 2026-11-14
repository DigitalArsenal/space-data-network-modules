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
export async function verifyFifoRegression(mode){
 const repo=fileURLToPath(new URL('../../../',import.meta.url));
 const dir=process.env.CATALOG_CONTROLLER_DIR||fileURLToPath(new URL('../dist/flow/control',import.meta.url));
 const pack=(x,c,pref=true)=>{const b=new fb.Builder(1024);pref?b.finishSizePrefixed(x.pack(b),'$'+c):b.finish(x.pack(b),'$'+c);return Buffer.from(b.asUint8Array());};
 const frame=(portId,c,payload)=>({portId,payload,typeRef:{schemaName:c+'.fbs',fileIdentifier:{TimerTick:'TICK',IngestResult:'INGR'}[c]??'$'+c,rootTypeName:c,wireFormat:'flatbuffer'}});
 const split=b=>{const rows=[];for(let i=0;i<b.length;){const n=b.readUInt32LE(i)+4;rows.push(b.subarray(i,i+n));i+=n;}return rows;};
 const seed=O.OMM.getRootAsOMM(new fb.ByteBuffer(ommBytes)).unpack();
 const now=Date.parse(seed.EPOCH+'Z')+86400000;
 const cfg={'catalog.provider':'synthetic-node','catalog.identity_provider':'synthetic','catalog.identity_source':'identities','catalog.weather_provider':'synthetic','catalog.weather_source':'weather','catalog.seed_sources':['primary'],'catalog.seed_providers':['synthetic'],'catalog.page_size':512,'catalog.batch_size':2};
 const seeds=[],identities=[];
 for(let i=0;i<(mode==='spare'?10000:mode==='spare-built'?3:mode==='fair'?5000:mode==='writes'?128:1);i++){const id=3000000+i;seeds.push(pack(Object.assign(new O.OMMT(),seed,{NORAD_CAT_ID:id}),'OMM'));identities.push(pack(Object.assign(new C.CATT(),{NORAD_CAT_ID:id,OBJECT_NAME:'SYNTHETIC'}),'CAT'));}
 const chain=await createStandaloneHarness('browser',repo+'/flows/catalog-builder/dist/isomorphic/module.wasm',{surface:'direct',enableBrowserWasiThreads:false});
 let fallback;
 try{const r=await chain.invoke({methodId:'ingest_seed',inputs:[frame('omm','OMM',ommBytes)]});assert.equal(r.statusCode,0,r.errorMessage);fallback=OCM.getRootAsOCM(new fb.ByteBuffer(r.outputs.find(f=>f.portId==='fallback').payload)).unpack();}finally{chain.destroy();}
 const create=()=>createBrowserModuleHarness({wasmSource:fs.readFileSync(dir+'/dist/isomorphic/module.wasm'),manifest:JSON.parse(fs.readFileSync(new URL('../control/plugin-manifest.json',import.meta.url))),surface:'direct',hostOptions:{config:cfg}});
 let control=await create();let state=[],history=[];let badIndex;const index=new Map(),journal=new Set(),fitCounts=new Map();let failing=['fair','spare'].includes(mode);const newcomer=2999999;
 const composer=await createBrowserModuleHarness({wasmSource:fs.readFileSync(repo+'/analysis/catalog-composer/dist/isomorphic/module.wasm'),manifest:JSON.parse(fs.readFileSync(repo+'/analysis/catalog-composer/plugin-manifest.json')),surface:'direct'});
 const cid=b=>{const data=Buffer.concat([Buffer.from([1,0x55,0x12,0x20]),createHash('sha256').update(b).digest()]);let bits=0,value=0,out='b';for(const byte of data){value=(value<<8)|byte;bits+=8;while(bits>=5){bits-=5;out+='abcdefghijklmnopqrstuvwxyz234567'[(value>>>bits)&31];}}if(bits)out+='abcdefghijklmnopqrstuvwxyz234567'[(value<<(5-bits))&31];return out;};
 const sha=b=>createHash('sha256').update(b).digest('hex');
 const latest=rows=>{const events=new Map();for(const row of rows)for(const e of N.NEV.getSizePrefixedRootAsNEV(new fb.ByteBuffer(row)).unpack().EVENTS){const old=events.get(e.SUBJECT);if(!old||Number(e.DETAIL.match(/sequence=(\d+);/)[1])>Number(old.DETAIL.match(/sequence=(\d+);/)[1]))events.set(e.SUBJECT,e);}return [...events.values()].sort((a,b)=>a.SUBJECT.localeCompare(b.SUBJECT));};
 async function tick(time,kill=false){
  const counts={indexes:0,fits:0,writes:0,bytes:0,snapshots:0,maxRows:state.length,healthy:0};
  let r=await control.invoke({methodId:'advance',inputs:[frame('tick','TimerTick',encodeTimerTick({triggerId:'refresh',firedMs:time}))]});
  for(let step=0;step<50000;step++){
   assert.equal(r.statusCode,0,r.errorMessage);const out=Object.fromEntries(r.outputs.map(f=>[f.portId,f]));let inputs;
   if(out.notice){counts.notice=decodeFlowNotice(out.notice.payload);return counts;}
   if(out.query){const q=Q.QRP.getRootAsQRP(new fb.ByteBuffer(out.query.payload)).unpack();const rows=q.SCHEMA_NAME==='NEV.fbs'?state:q.SCHEMA_NAME==='OMM.fbs'?seeds:q.SOURCE_NAME==='identities'?identities:q.SOURCE_NAME==='catalog-index'?[...index.values(),...(badIndex?[badIndex]:[])]:[];
    const offset=Number(q.CURSOR||0),page=rows.slice(offset,offset+q.LIMIT),end=offset+page.length;
    const header=Object.assign(new Q.QRPT(),{KIND:Q.qrpKind.Page,STATUS:Q.qrpStatus.Ok,SCHEMA_NAME:q.SCHEMA_NAME,PROVIDER_ID:q.PROVIDER_ID,SOURCE_NAME:q.SOURCE_NAME,BATCH_ID:q.BATCH_ID,RECORD_COUNT:page.length,TOTAL_COUNT:BigInt(rows.length),NEXT_CURSOR:end<rows.length?String(end):null});
    inputs=[frame('page','QRP',Buffer.concat([pack(header,'QRP'),...page]))];
   }else if(out.seed){if(kill==='dispatch')return counts;++counts.fits;const id=O.OMM.getRootAsOMM(new fb.ByteBuffer(out.seed.payload)).NORAD_CAT_ID();fallback.METADATA.NORAD_CAT_ID=id;fitCounts.set(id,(fitCounts.get(id)||0)+1);if(id>=4000000)++counts.healthy;else if(mode==='fair')await new Promise(resolve=>setTimeout(resolve,5));
    inputs=[frame('fallback','OCM',pack(fallback,'OCM',false)),frame('chain_status','QRP',pack(Object.assign(new Q.QRPT(),{KIND:Q.qrpKind.Error,STATUS:Q.qrpStatus.Error,ERROR_CODE:'outside-ap-class'}),'QRP',false))];
   }else if(out.annotate_orbit){if(!failing||OCM.getSizePrefixedRootAsOCM(new fb.ByteBuffer(out.annotate_orbit.payload)).METADATA().NORAD_CAT_ID()>=4000000){inputs=[frame('annotated','OCM',out.annotate_orbit.payload)];}else inputs=[frame('annotation_status','QRP',pack(Object.assign(new Q.QRPT(),{KIND:Q.qrpKind.Error,STATUS:Q.qrpStatus.Error,ERROR_CODE:'invalid-models'}),'QRP',false))];
   }else if(out.recipe){const result=await composer.invoke({methodId:'replace_products',inputs:[out.recipe,out.catalog,{...out.selection,portId:'decision'},...(out.selected?[{...out.selected,portId:'ocm_products'}]:[])]});assert.equal(result.statusCode,0,result.errorMessage);inputs=result.outputs.map(f=>({...f,portId:f.portId==='decision'?'compose_status':'replacement'}));
   }else if(out.product_records||out.index_records){const m=decodeIngestRequest(out.meta.payload),rows=split(Buffer.from((out.product_records??out.index_records).payload));
    if(out.product_records){for(const row of rows)journal.add(cid(row));if(kill===true){journal.clear();return counts;}}
    if(out.index_records){for(const row of rows){const cat=C.CAT.getSizePrefixedRootAsCAT(new fb.ByteBuffer(row)).unpack();for(const product of cat.PRODUCTS)assert.ok(journal.has(product.RECORD_CID),'terminal generation references a re-sent product');index.set(cat.NORAD_CAT_ID,row);}counts.indexes+=rows.length;}
    inputs=[frame('stored','IngestResult',encodeIngestResult({schema:m.schema,...m.tags,inserted:rows.length,reconciledDuplicates:0}))];   }else if(out.state_records){const m=decodeIngestRequest(out.meta.payload),rows=split(Buffer.from(out.state_records.payload));assert.equal(m.schema,'NEV.fbs');++counts.writes;counts.bytes+=out.state_records.payload.length;
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
  const add=(id)=>{seeds.push(pack(Object.assign(new O.OMMT(),seed,{NORAD_CAT_ID:id}),'OMM'));identities.push(pack(Object.assign(new C.CATT(),{NORAD_CAT_ID:id,OBJECT_NAME:'SYNTHETIC'}),'CAT'));};
  if(mode==='writes'){
   cfg['catalog.batch_size']=128;snapshot(poisonEntries(4096));control.destroy();control=await create();
   const run=await tick(now);console.log('FIFO_WRITES '+JSON.stringify(run));
   assert.equal(run.indexes,128);assert.ok(run.snapshots<=1,'at most one full compaction snapshot per run');assert.ok(run.bytes<3*1024*1024,'full-capacity state writes stay below 3 MiB for 128 admissions');
  }else if(mode==='protected'){
   const all=poisonEntries(4096);all.forEach((e,i)=>{e.SUBJECT='catalog-object/'+(4000000+i);e.DETAIL='ready input=absent; sequence='+(i+1)+'; product-batch=catalog-old; prepared-generation;';identities.push(pack(Object.assign(new C.CATT(),{NORAD_CAT_ID:4000000+i,OBJECT_NAME:'SYNTHETIC'}),'CAT'));});snapshot(all);
   let run;try{run=await tick(now);}catch(e){console.log('FIFO_PROTECTED '+JSON.stringify({trapped:true,message:e.message}));throw e;}
   console.log('FIFO_PROTECTED '+JSON.stringify(run));assert.equal(run.indexes,1,'expired preparation pins never trap admission');
   // Oversized legacy protected histories have a defined warning and victim.
   all[0].DETAIL=all[0].DETAIL.replace(/^ready /,'retry ')+' instance-interrupted;';
   snapshot([...all,Object.assign(new N.NEVEventT(),all[0],{SUBJECT:'catalog-object/5000000',DETAIL:'ready input=absent; sequence=5000; product-batch=catalog-old; prepared-generation;'})]);
   control.destroy();control=await create();const oversized=await tick(now+1000);assert.match(oversized.notice.reason,/protected.*evict|evict.*protected/);assert.ok(events().length<=4096);assert.ok(events().some(e=>e.SUBJECT===all[0].SUBJECT&&e.DETAIL.includes('instance-interrupted;')),'protected overflow preserves the interruption suspect');
  }else if(mode==='poison'){
   badIndex=pack(new C.CATT(),'CAT');const source='CAT/synthetic-node/catalog-index';
   const present=Object.assign(new N.NEVEventT(),{TIME_MS:BigInt(now),KIND:N.nevEventKind.Warning,SUBJECT:'catalog-invalid/'+sha(badIndex)+'/'+sha(Buffer.from(source)),COUNT:3n,DETAIL:source+'; sequence=1;'});
   snapshot([present,...poisonEntries(4095)]);const first=await tick(now);assert.equal(first.indexes,1);const observed=events().find(e=>e.SUBJECT===present.SUBJECT);assert.ok(observed,'an observed poison stays in the FIFO');assert.ok(Number(observed.DETAIL.match(/sequence=(\d+);/)[1])>1,'quarantined poison observations refresh their sequence');
   add(newcomer);control.destroy();control=await create();const second=await tick(now+1000);console.log('FIFO_POISON '+JSON.stringify({first,second}));assert.equal(second.indexes,1,'observed poison eviction cannot defer a new object');
   // Even a forgotten poison cannot reopen the build gate for valid inputs.
   snapshot(poisonEntries(4096));add(newcomer-1);control.destroy();control=await create();const forgotten=await tick(now+2000);assert.equal(forgotten.indexes,1,'forgotten index poison never defers valid object construction');
  }else if(mode==='replay'){
   const all=Array.from({length:4096},(_,i)=>Object.assign(new N.NEVEventT(),{TIME_MS:BigInt(now),KIND:N.nevEventKind.Failure,SUBJECT:'catalog-object/'+(4000000+i),COUNT:1n,DETAIL:'final input=absent; sequence='+(i+1)+';'}));
   for(let i=0;i<4095;i++)identities.push(pack(Object.assign(new C.CATT(),{NORAD_CAT_ID:4000000+i,OBJECT_NAME:'SYNTHETIC'}),'CAT'));
   snapshot(all);await tick(now,'dispatch');
   control.destroy();control=await create();await tick(now+1000);
   const restored=events();assert.equal(restored.filter(e=>e.DETAIL.startsWith('final ')).length,4095,'replay preserves every final failure kept after pruning');
   assert.ok(restored.some(e=>e.SUBJECT===all[0].SUBJECT),'the oldest kept failure survives the replay');
   assert.equal(restored.length,4096,'replay equals the writer cache after prune and dispatch');
  }else if(mode==='success-removal'){
   snapshot(poisonEntries(4096));const empty=new N.NEVT();empty.NODE_ID='synthetic-node';for(let i=0;i<8193;i++)state.push(pack(empty,'NEV'));
   const run=await tick(now);assert.equal(run.indexes,1);assert.equal(run.snapshots,1,'oversized history compacts once before dispatch');
   const removed=events().filter(e=>e.DETAIL.startsWith('removed;'));
   assert.ok(removed.some(e=>e.SUBJECT.startsWith('catalog-object/')),'success after early compaction appends its removal');
   control.destroy();control=await create();await tick(now+1000);
   assert.equal(events().filter(e=>e.SUBJECT.startsWith('catalog-object/')).length,0,'replay does not resurrect the committed attempt');
  }else if(mode==='spare'||mode==='spare-built'){
   cfg['catalog.batch_size']=256;
   for(let i=0;i<(mode==='spare'?3:1000);i++){const id=4000000+i;add(id);fallback.METADATA.NORAD_CAT_ID=id;const product=pack(fallback,'OCM');journal.add(cid(product));index.set(id,pack(Object.assign(new C.CATT(),{NORAD_CAT_ID:id,OBJECT_NAME:'SYNTHETIC',PRODUCTS_AS_OF:new Date(now-1000).toISOString(),PRODUCTS:[Object.assign(new C.CATProductT(),{KIND:C.catalogProductKind.Sgp4Elements,RECORD_CID:cid(product),SELECTION_REASON:'prior input'})]}),'CAT'));}
   control.destroy();control=await create();const run=await tick(now);
   assert.equal(run.fits,256,'unused slots from either group fill the dispatch batch');
   assert.equal(run.healthy,mode==='spare'?3:253);
   console.log('FIFO_SPARE '+JSON.stringify({mode,dispatches:run.fits,indexed:run.healthy,unbuilt:run.fits-run.healthy}));
  }else if(mode==='fair'){
   cfg['catalog.batch_size']=128;cfg['catalog.invocation_budget_ms']=3000;
   for(let i=0;i<1000;i++){const id=4000000+i;add(id);fallback.METADATA.NORAD_CAT_ID=id;const product=pack(fallback,'OCM');journal.add(cid(product));index.set(id,pack(Object.assign(new C.CATT(),{NORAD_CAT_ID:id,OBJECT_NAME:'SYNTHETIC',PRODUCTS_AS_OF:new Date(now-1000).toISOString(),PRODUCTS:[Object.assign(new C.CATProductT(),{KIND:C.catalogProductKind.Sgp4Elements,RECORD_CID:cid(product),SELECTION_REASON:'prior input'})]}),'CAT'));}
   snapshot(poisonEntries(4096));const runs=[];
   for(let i=0;i<3;i++){control.destroy();control=await create();runs.push(await tick(now+i*1000));}
   console.log('FIFO_FAIR '+JSON.stringify(runs));for(const run of runs){assert.ok(run.healthy>0,'built objects refresh on every run despite 5000 persistent failures');assert.ok(run.fits<=128,'failures count against dispatch batch');assert.ok(run.fits-run.healthy<=64,'unbuilt objects take at most half while built objects are due');}assert.equal([...fitCounts].filter(([id])=>id>=4000000).length,192,'staleness order refreshes different due built objects across three runs');
  }
 }finally{control.destroy();composer.destroy();}
}
