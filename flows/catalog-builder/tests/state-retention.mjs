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
 for(let i=0;i<(mode==='final'?4096:1);i++){const id=3000000+i;seeds.push(pack(Object.assign(new O.OMMT(),seed,{NORAD_CAT_ID:id}),'OMM'));identities.push(pack(Object.assign(new C.CATT(),{NORAD_CAT_ID:id,OBJECT_NAME:'SYNTHETIC'}),'CAT'));}
 const chain=await createStandaloneHarness('browser',repo+'/flows/catalog-builder/dist/isomorphic/module.wasm',{surface:'direct',enableBrowserWasiThreads:false});
 let fallback;
 try{const r=await chain.invoke({methodId:'ingest_seed',inputs:[frame('omm','OMM',ommBytes)]});assert.equal(r.statusCode,0,r.errorMessage);fallback=OCM.getRootAsOCM(new fb.ByteBuffer(r.outputs.find(f=>f.portId==='fallback').payload)).unpack();}finally{chain.destroy();}
 const create=()=>createBrowserModuleHarness({wasmSource:fs.readFileSync(dir+'/dist/isomorphic/module.wasm'),manifest:JSON.parse(fs.readFileSync(dir+'/plugin-manifest.json')),surface:'direct',hostOptions:{config:cfg}});
 let control=await create();let state=[],history=[];let failing=mode==='final';
 const composer=await createBrowserModuleHarness({wasmSource:fs.readFileSync(repo+'/analysis/catalog-composer/dist/isomorphic/module.wasm'),manifest:JSON.parse(fs.readFileSync(repo+'/analysis/catalog-composer/plugin-manifest.json')),surface:'direct'});
 const sha=b=>createHash('sha256').update(b).digest('hex');
 const latest=rows=>{const events=new Map();for(const row of rows)for(const e of N.NEV.getSizePrefixedRootAsNEV(new fb.ByteBuffer(row)).unpack().EVENTS){const old=events.get(e.SUBJECT);if(!old||Number(e.DETAIL.match(/sequence=(\d+);/)[1])>Number(old.DETAIL.match(/sequence=(\d+);/)[1]))events.set(e.SUBJECT,e);}return [...events.values()].sort((a,b)=>a.SUBJECT.localeCompare(b.SUBJECT));};
 async function tick(time){
  const counts={indexes:0,fits:0,writes:0,snapshots:0,maxRows:state.length};
  let r=await control.invoke({methodId:'advance',inputs:[frame('tick','TimerTick',encodeTimerTick({triggerId:'refresh',firedMs:time}))]});
  for(let step=0;step<50000;step++){
   assert.equal(r.statusCode,0,r.errorMessage);const out=Object.fromEntries(r.outputs.map(f=>[f.portId,f]));let inputs;
   if(out.notice){counts.notice=decodeFlowNotice(out.notice.payload);return counts;}
   if(out.query){const q=Q.QRP.getRootAsQRP(new fb.ByteBuffer(out.query.payload)).unpack();const rows=q.SCHEMA_NAME==='NEV.fbs'?state:q.SCHEMA_NAME==='OMM.fbs'?seeds:q.SOURCE_NAME==='identities'?identities:[];
    const offset=Number(q.CURSOR||0),page=rows.slice(offset,offset+q.LIMIT),end=offset+page.length;
    const header=Object.assign(new Q.QRPT(),{KIND:Q.qrpKind.Page,STATUS:Q.qrpStatus.Ok,SCHEMA_NAME:q.SCHEMA_NAME,PROVIDER_ID:q.PROVIDER_ID,SOURCE_NAME:q.SOURCE_NAME,RECORD_COUNT:page.length,TOTAL_COUNT:BigInt(rows.length),NEXT_CURSOR:end<rows.length?String(end):null});
    inputs=[frame('page','QRP',Buffer.concat([pack(header,'QRP'),...page]))];
   }else if(out.seed){++counts.fits;const id=O.OMM.getRootAsOMM(new fb.ByteBuffer(out.seed.payload)).NORAD_CAT_ID();fallback.METADATA.NORAD_CAT_ID=id;
    inputs=[frame('fallback','OCM',pack(fallback,'OCM',false)),frame('chain_status','QRP',pack(Object.assign(new Q.QRPT(),{KIND:Q.qrpKind.Error,STATUS:Q.qrpStatus.Error,ERROR_CODE:'outside-ap-class'}),'QRP',false))];
   }else if(out.annotate_orbit){if(!failing){inputs=[frame('annotated','OCM',out.annotate_orbit.payload)];}else inputs=[frame('annotation_status','QRP',pack(Object.assign(new Q.QRPT(),{KIND:Q.qrpKind.Error,STATUS:Q.qrpStatus.Error,ERROR_CODE:'invalid-models'}),'QRP',false))];
   }else if(out.recipe){const result=await composer.invoke({methodId:'replace_products',inputs:[out.recipe,out.catalog,{...out.selection,portId:'decision'},...(out.selected?[{...out.selected,portId:'ocm_products'}]:[])]});assert.equal(result.statusCode,0,result.errorMessage);inputs=result.outputs.map(f=>({...f,portId:f.portId==='decision'?'compose_status':'replacement'}));
   }else if(out.product_records||out.index_records){const m=decodeIngestRequest(out.meta.payload),rows=split(Buffer.from((out.product_records??out.index_records).payload));if(out.index_records)counts.indexes+=rows.length;inputs=[frame('stored','IngestResult',encodeIngestResult({schema:m.schema,...m.tags,inserted:rows.length,reconciledDuplicates:0}))];
   }else if(out.state_records){const m=decodeIngestRequest(out.meta.payload),rows=split(Buffer.from(out.state_records.payload));assert.equal(m.schema,'NEV.fbs');++counts.writes;history.push(...rows);
    if(m.reconcile==='current'){++counts.snapshots;state=rows;}else{assert.equal(m.reconcile,'none');state.push(...rows);}counts.maxRows=Math.max(counts.maxRows,state.length);
    inputs=[frame('stored','IngestResult',encodeIngestResult({schema:m.schema,...m.tags,inserted:rows.length,reconciledDuplicates:0}))];
   }else assert.fail('Unexpected controller output: '+Object.keys(out));
   r=await control.invoke({methodId:'advance',inputs});
  }
  assert.fail('State bound test exceeded its operation cap');
 }
 try{
  if(mode==='final'){
   const first=await tick(now);assert.equal(first.fits,4096);assert.equal(latest(state).length,4096);
   assert.ok(latest(state).every(e=>e.DETAIL.startsWith('final ')));
   const id=2999999;seeds.unshift(pack(Object.assign(new O.OMMT(),seed,{NORAD_CAT_ID:id}),'OMM'));identities.unshift(pack(Object.assign(new C.CATT(),{NORAD_CAT_ID:id,OBJECT_NAME:'SYNTHETIC'}),'CAT'));failing=false;
  }else{
   const log=new N.NEVT();log.NODE_ID='synthetic-node';log.GENERATED_AT_MS=BigInt(now);
   for(let i=0;i<4096;i++){
    const source='OMM/synthetic/primary';const subject=mode==='poison'?'catalog-invalid/'+sha(Buffer.from('removed defect '+i))+'/'+sha(Buffer.from(source)):'catalog-object/'+(4000000+i);
    log.EVENTS.push(Object.assign(new N.NEVEventT(),{TIME_MS:BigInt(now),KIND:N.nevEventKind.Warning,SUBJECT:subject,COUNT:3n,DETAIL:mode==='poison'?source:'retry input=absent; sequence=1;'}));
   }
   state=[pack(log,'NEV')];
  }
  const runs=[];
  for(let i=0;i<3;i++){control.destroy();control=await create();runs.push(await tick(now+1000+i));}
  console.log('RETENTION_CONTROL '+JSON.stringify({mode,runs:runs.map(r=>({fits:r.fits,indexes:r.indexes,kind:r.notice.kind,reason:r.notice.reason}))}));
  assert.ok(runs.some(r=>r.indexes>0),mode+' retention admits a new object over three runs');
  const events=state.flatMap(b=>N.NEV.getSizePrefixedRootAsNEV(new fb.ByteBuffer(b)).unpack().EVENTS);
  if(mode==='final')assert.equal(events.filter(e=>e.DETAIL.startsWith('final ')).length,4096,'unchanged final failures remain deferred');
  else assert.equal(events.length,0,'compaction frees every absent entry');
 }finally{control.destroy();composer.destroy();}
}
