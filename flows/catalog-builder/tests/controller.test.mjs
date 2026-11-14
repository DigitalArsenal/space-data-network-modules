import test from 'node:test';import {fileURLToPath} from 'node:url';
import fs from 'node:fs';import * as fb from 'flatbuffers';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import * as C from 'spacedatastandards.org/lib/js/CAT/main.js';import * as O from 'spacedatastandards.org/lib/js/OCM/main.js';import * as Q from 'spacedatastandards.org/lib/js/QRP/main.js';import {OMM} from 'spacedatastandards.org/lib/js/OMM/OMM.js';import {SPW} from 'spacedatastandards.org/lib/js/SPW/SPW.js';
import {encodeTimerTick,decodeIngestRequest,encodeIngestResult} from 'space-data-module-sdk/runtime-contracts';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {ommBytes,weather} from './fixtures.mjs';
test('controller reconciles changed inputs, refusal, expiry, removal, and interruption through compiled modules',async()=>{
const repo=fileURLToPath(new URL('../../../',import.meta.url)),controlDir=process.env.CATALOG_CONTROLLER_DIR||fileURLToPath(new URL('../dist/flow/control',import.meta.url));
const pack=(r,c,pref=true)=>{const b=new fb.Builder(8192);pref?b.finishSizePrefixed(r.pack(b),'$'+c):b.finish(r.pack(b),'$'+c);return Buffer.from(b.asUint8Array());};
const type=c=>({schemaName:c+'.fbs',fileIdentifier:{TimerTick:'TICK',IngestResult:'INGR'}[c]??'$'+c,rootTypeName:c,wireFormat:'flatbuffer'});
const frame=(portId,c,payload)=>({portId,typeRef:type(c),payload});const hash=b=>createHash('sha256').update(b).digest('hex');
const split=b=>{let a=[];for(let i=0;i<b.length;){const n=b.readUInt32LE(i)+4;a.push(b.subarray(i,i+n));i+=n;}return a;};
const obj=OMM.getRootAsOMM(new fb.ByteBuffer(ommBytes)).unpack();
const seed=(id,change=0)=>{const x=OMM.getRootAsOMM(new fb.ByteBuffer(ommBytes)).unpack();x.NORAD_CAT_ID=id;x.MEAN_ANOMALY+=change;return pack(x,'OMM');};
const ids=[999999,999998],now=Date.parse(obj.EPOCH+'Z')+86400000;
const cfg={'catalog.provider':'synthetic-node','catalog.identity_provider':'synthetic','catalog.identity_source':'identities','catalog.weather_provider':'synthetic','catalog.weather_source':'weather','catalog.seed_sources':['primary','secondary'],'catalog.seed_providers':['synthetic','synthetic'],'catalog.page_size':1,'catalog.batch_size':2};
const store=new Map();const key=(schema,provider,source)=>[schema,provider,source].join('/');const records=(schema,provider,source)=>{const k=key(schema,provider,source);if(!store.has(k))store.set(k,[]);return store.get(k);};
records('OMM.fbs','synthetic','primary').push(...ids.map(id=>seed(id)));
records('OMM.fbs','synthetic','secondary').push(seed(ids[0],1));
records('CAT.fbs','synthetic','identities').push(...ids.map(id=>pack(Object.assign(new C.CATT(),{NORAD_CAT_ID:id,OBJECT_NAME:'SYNTHETIC'}),'CAT')));
records('SPW.fbs','synthetic','weather').push(...split(Buffer.from(weather)).map(b=>pack(SPW.getSizePrefixedRootAsSPW(new fb.ByteBuffer(b)).unpack(),'SPW')));
const manifest=path=>JSON.parse(fs.readFileSync(path+'/plugin-manifest.json'));
const createControl=()=>createBrowserModuleHarness({wasmSource:fs.readFileSync(controlDir+'/dist/isomorphic/module.wasm'),manifest:manifest(controlDir),surface:'direct',hostOptions:{config:cfg}});
let control=await createControl();const chain=await createStandaloneHarness('browser',repo+'/flows/catalog-builder/dist/isomorphic/module.wasm',{surface:'direct',enableBrowserWasiThreads:false});
const gp=await createBrowserModuleHarness({wasmSource:fs.readFileSync(repo+'/analysis/gp-error-model/dist/isomorphic/module.wasm'),manifest:manifest(repo+'/analysis/gp-error-model'),surface:'direct'});
const composer=await createBrowserModuleHarness({wasmSource:fs.readFileSync(repo+'/analysis/catalog-composer/dist/isomorphic/module.wasm'),manifest:manifest(repo+'/analysis/catalog-composer'),surface:'direct'});
const evidence={synthetic:true,stages:[]};
async function tick(time,kill=false){
 let response=await control.invoke({methodId:'advance',inputs:[frame('tick','TimerTick',encodeTimerTick({triggerId:'refresh',firedMs:time}))]});
 const counters={fits:0,fallbacks:0,products:0,indexes:0,pages:0,duplicateProducts:0};
 for(let count=0;count<10000;count++){
  assert.equal(response.statusCode,0,response.errorMessage);const out=Object.fromEntries(response.outputs.map(f=>[f.portId,f]));let input=[];
  if(out.notice){evidence.stages.push(counters);return counters;}
  if(out.query){
   ++counters.pages;const q=Q.QRP.getRootAsQRP(new fb.ByteBuffer(out.query.payload)).unpack();const data=records(q.SCHEMA_NAME,q.PROVIDER_ID,q.SOURCE_NAME);const [offset,head]=q.CURSOR?q.CURSOR.split(':').map(Number):[0,data.length];const page=data.slice(offset,Math.min(head,offset+q.LIMIT));const end=offset+page.length;
   const header=Object.assign(new Q.QRPT(),{KIND:Q.qrpKind.Page,STATUS:Q.qrpStatus.Ok,SCHEMA_NAME:q.SCHEMA_NAME,PROVIDER_ID:q.PROVIDER_ID,SOURCE_NAME:q.SOURCE_NAME,RECORD_COUNT:page.length,TOTAL_COUNT:BigInt(head),NEXT_CURSOR:end<head?end+':'+head:null});
   input=[frame('page','QRP',Buffer.concat([pack(header,'QRP'),...page])),frame('query_status','QRP',out.query.payload)];
  }else if(out.seed||out.fallback_seed){
   const fit=!!out.seed;fit?counters.fits++:counters.fallbacks++;
   const inputs=fit?[frame('omm','OMM',out.seed.payload),...['flight_config','fit_config','weather'].filter(p=>out[p]).map(p=>out[p])]:[frame('omm','OMM',out.fallback_seed.payload)];
   const r=await chain.invoke({methodId:fit?'run_chain':'ingest_seed',inputs});assert.equal(r.statusCode,0,r.errorMessage);
   input=r.outputs.map(f=>({...f,portId:{fallback:'fallback',elements:'candidate',decision:'chain_status'}[f.portId]}));
  }else if(out.annotate_orbit){
   const r=await gp.invoke({methodId:'annotate_population',inputs:[frame('ocm','OCM',out.annotate_orbit.payload),frame('elements','OMM',out.annotate_seed.payload)]});assert.equal(r.statusCode,0,r.errorMessage);input=r.outputs.map(f=>({...f,portId:'annotated'}));
  }else if(out.meta){
   const m=decodeIngestRequest(out.meta.payload);const b=Buffer.from((out.product_records??out.index_records).payload);const destination=records(m.schema,m.tags.providerId,m.tags.sourceName);const exists=destination.some(x=>hash(x)===hash(b));if(!exists)destination.push(b);
   if(out.product_records){++counters.products;if(exists)++counters.duplicateProducts;if(kill){control.destroy();control=await createControl();evidence.stages.push({...counters,killedAfterProduct:true});return counters;}}
   else {++counters.indexes;const cat=C.CAT.getSizePrefixedRootAsCAT(new fb.ByteBuffer(b)).unpack();if(cat.PRODUCTS.length){assert.ok(records('OCM.fbs','synthetic-node','catalog-products').length>0,'product exists before index');}}
   input=[frame('stored','IngestResult',encodeIngestResult({schema:m.schema,...m.tags,inserted:exists?0:1,reconciledDuplicates:exists?1:0}))];
  }else if(out.recipe){
   const r=await composer.invoke({methodId:'replace_products',inputs:[out.recipe,out.catalog,{...out.selection,portId:'decision'},...(out.selected?[{...out.selected,portId:'ocm_products'}]:[])]});assert.equal(r.statusCode,0,r.errorMessage);input=r.outputs.map(f=>({...f,portId:'replacement'}));
  }else throw Error('No progress: '+Object.keys(out));
  response=await control.invoke({methodId:'advance',inputs:input});
 }
 throw Error('Bounded controller did not complete');
}
const current=()=>{const map=new Map();for(const b of records('CAT.fbs','synthetic-node','catalog-index')){const c=C.CAT.getSizePrefixedRootAsCAT(new fb.ByteBuffer(b)).unpack();if(!map.has(c.NORAD_CAT_ID)||map.get(c.NORAD_CAT_ID).PRODUCTS_AS_OF<=c.PRODUCTS_AS_OF)map.set(c.NORAD_CAT_ID,c);}return map;};
try{
 const first=await tick(now);assert.equal(first.fits,2);assert.equal(first.indexes,2);assert.ok([...current().values()].every(c=>c.PRODUCTS[0].KIND===C.catalogProductKind.ApElements));
 const unchanged=await tick(now+1000);assert.equal(unchanged.fits+unchanged.products+unchanged.indexes,0);
 records('OMM.fbs','synthetic','primary').push(seed(ids[0],.1));const corrected=await tick(now+2000);assert.equal(corrected.fits,1);assert.equal(corrected.indexes,1);
 records('OMM.fbs','synthetic','primary').push(seed(ids[0],.2));await tick(now+3000,true);const resumed=await tick(now+4000);assert.equal(resumed.fits,1);assert.equal(resumed.duplicateProducts,1);assert.equal(resumed.indexes,1);
 cfg['catalog.weather_source']='missing-weather';control.destroy();control=await createControl();const refused=await tick(now+5000);assert.equal(refused.fits,2);assert.ok([...current().values()].every(c=>c.PRODUCTS[0].KIND===C.catalogProductKind.Sgp4Elements&&/weather/.test(c.PRODUCTS[0].SELECTION_REASON)));
 const noRetry=await tick(now+6000);assert.equal(noRetry.fits+noRetry.products,0);
 cfg['catalog.weather_source']='weather';control.destroy();control=await createControl();const restored=await tick(now+7000);assert.equal(restored.fits,2);
 const stale=await tick(now+6*86400000);assert.equal(stale.fits,0);assert.equal(stale.fallbacks,2);assert.ok([...current().values()].every(c=>c.PRODUCTS[0].KIND===C.catalogProductKind.Sgp4Elements));
 records('CAT.fbs','synthetic','identities').splice(0,1);const removed=await tick(now+6*86400000+1000);assert.equal(removed.indexes,1);assert.equal(current().get(ids[0]).PRODUCTS.length,0);
 const consumer=new Map();for(const b of records('CAT.fbs','synthetic-node','catalog-index')){const c=C.CAT.getSizePrefixedRootAsCAT(new fb.ByteBuffer(b)).unpack();const old=consumer.get(c.NORAD_CAT_ID);if(!old||old.PRODUCTS_AS_OF<=c.PRODUCTS_AS_OF)consumer.set(c.NORAD_CAT_ID,c);}assert.deepEqual(consumer,current());evidence.consumerMapEqual=true;
 evidence.passed=true;
}catch(e){evidence.failure=e.stack;throw e;}finally{control.destroy();chain.destroy();gp.destroy();composer.destroy();}

});
