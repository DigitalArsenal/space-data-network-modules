import test from 'node:test';import {fileURLToPath} from 'node:url';
import fs from 'node:fs';import * as fb from 'flatbuffers';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import * as C from 'spacedatastandards.org/lib/js/CAT/main.js';import * as O from 'spacedatastandards.org/lib/js/OCM/main.js';import * as Q from 'spacedatastandards.org/lib/js/QRP/main.js';import {OMM} from 'spacedatastandards.org/lib/js/OMM/OMM.js';import {SPW} from 'spacedatastandards.org/lib/js/SPW/SPW.js';
import {encodeTimerTick,decodeIngestRequest,encodeIngestResult,decodeFlowNotice} from 'space-data-module-sdk/runtime-contracts';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {ommBytes,weather,checkPcf} from './fixtures.mjs';
test('controller reconciles changed inputs, refusal, expiry, removal, and interruption through compiled modules',async()=>{
const repo=fileURLToPath(new URL('../../../',import.meta.url)),controlDir=process.env.CATALOG_CONTROLLER_DIR||fileURLToPath(new URL('../dist/flow/control',import.meta.url));
const pack=(r,c,pref=true)=>{const b=new fb.Builder(8192);pref?b.finishSizePrefixed(r.pack(b),'$'+c):b.finish(r.pack(b),'$'+c);return Buffer.from(b.asUint8Array());};
const type=c=>({schemaName:c+'.fbs',fileIdentifier:{TimerTick:'TICK',IngestResult:'INGR'}[c]??'$'+c,rootTypeName:c,wireFormat:'flatbuffer'});
const frame=(portId,c,payload)=>({portId,typeRef:type(c),payload});const hash=b=>createHash('sha256').update(b).digest('hex');
const split=b=>{let a=[];for(let i=0;i<b.length;){const n=b.readUInt32LE(i)+4;a.push(b.subarray(i,i+n));i+=n;}return a;};
const obj=OMM.getRootAsOMM(new fb.ByteBuffer(ommBytes)).unpack();
const seed=(id,change=0)=>{const x=OMM.getRootAsOMM(new fb.ByteBuffer(ommBytes)).unpack();x.NORAD_CAT_ID=id;x.MEAN_ANOMALY+=change;return pack(x,'OMM');};
const ids=[999999,999998];let now=Date.parse(obj.EPOCH+'Z')+86400000;
const cfg={'catalog.provider':'synthetic-node','catalog.identity_provider':'synthetic','catalog.identity_source':'identities','catalog.weather_provider':'synthetic','catalog.weather_source':'weather','catalog.seed_sources':['primary','secondary'],'catalog.seed_providers':['synthetic','synthetic'],'catalog.page_size':1,'catalog.batch_size':2,'catalog.max_removal_fraction':0.5};
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
const evidence={synthetic:true,stages:[]};const fitOriginals=new Map(),verified=new Set(),sizes=[];
const ap=await createStandaloneHarness('browser',process.env.SDNAP_WASM||repo+'/propagator/sdn-ap/dist/isomorphic/module.wasm',{surface:'direct',enableBrowserWasiThreads:false});
const fly=async payload=>{const r=await ap.invoke({methodId:'propagate',inputs:[frame('ocm','OCM',payload),frame('configuration','PCF',checkPcf)]});assert.equal(r.statusCode,0,r.errorMessage);return Buffer.from(r.outputs.find(f=>f.portId==='ephemeris').payload);};
let refusalCode,trapObject;
const trap=new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,7,8,1,4,116,114,97,112,0,0,10,5,1,3,0,0,11]))).exports.trap;
async function tick(time,kill=false){
 let response=await control.invoke({methodId:'advance',inputs:[frame('tick','TimerTick',encodeTimerTick({triggerId:'refresh',firedMs:time}))]});
 const counters={fits:0,fallbacks:0,products:0,indexes:0,pages:0,duplicateProducts:0};
 for(let count=0;count<10000;count++){
  assert.equal(response.statusCode,0,response.errorMessage);const out=Object.fromEntries(response.outputs.map(f=>[f.portId,f]));let input=[];
  if(out.notice){counters.notice=decodeFlowNotice(out.notice.payload);evidence.stages.push(counters);return counters;}
  if(out.query){
   ++counters.pages;const q=Q.QRP.getRootAsQRP(new fb.ByteBuffer(out.query.payload)).unpack();if(q.SCHEMA_NAME==='OCM.fbs')assert.match(q.BATCH_ID,/^catalog-[0-9a-f]{64}$/,'only deterministic product lookup reads OCM');const data=records(q.SCHEMA_NAME,q.PROVIDER_ID,q.SOURCE_NAME).filter(b=>!q.BATCH_ID||q.BATCH_ID==='catalog-'+hash(b));const [offset,head]=q.CURSOR?q.CURSOR.split(':').map(Number):[0,data.length];const page=data.slice(offset,Math.min(head,offset+q.LIMIT));const end=offset+page.length;
   const header=Object.assign(new Q.QRPT(),{KIND:Q.qrpKind.Page,STATUS:Q.qrpStatus.Ok,SCHEMA_NAME:q.SCHEMA_NAME,PROVIDER_ID:q.PROVIDER_ID,SOURCE_NAME:q.SOURCE_NAME,BATCH_ID:q.BATCH_ID,RECORD_COUNT:page.length,TOTAL_COUNT:BigInt(head),NEXT_CURSOR:end<head?end+':'+head:null});
   input=[frame('page','QRP',Buffer.concat([pack(header,'QRP'),...page])),frame('query_status','QRP',out.query.payload)];
  }else if(out.seed||out.fallback_seed){
   const fit=!!out.seed;fit?counters.fits++:counters.fallbacks++;if(OMM.getRootAsOMM(new fb.ByteBuffer((out.seed??out.fallback_seed).payload)).NORAD_CAT_ID()===trapObject)trap();
   const inputs=fit?[frame('omm','OMM',out.seed.payload),...['flight_config','fit_config','weather'].filter(p=>out[p]).map(p=>out[p])]:[frame('omm','OMM',out.fallback_seed.payload)];
   const r=await chain.invoke({methodId:fit?'run_chain':'ingest_seed',inputs});assert.equal(r.statusCode,0,r.errorMessage);
   const fitted=r.outputs.find(f=>f.portId==='elements');if(fitted)fitOriginals.set(O.OCM.getRootAsOCM(new fb.ByteBuffer(fitted.payload)).unpack().METADATA.NORAD_CAT_ID,Buffer.from(fitted.payload));
   input=r.outputs.map(f=>({...f,portId:{fallback:'fallback',elements:'candidate',decision:'chain_status'}[f.portId]}));
   if(fit&&refusalCode){input=input.filter(f=>!['candidate','chain_status'].includes(f.portId));input.push(frame('chain_status','QRP',pack(Object.assign(new Q.QRPT(),{KIND:Q.qrpKind.Error,STATUS:Q.qrpStatus.Invalid,ERROR_CODE:refusalCode}),'QRP',false)));}
  }else if(out.annotate_orbit){
   const r=await gp.invoke({methodId:'annotate_population_flow',inputs:[frame('ocm','OCM',out.annotate_orbit.payload),frame('elements','OMM',out.annotate_seed.payload)]});assert.equal(r.statusCode,0,r.errorMessage);input=r.outputs.map(f=>({...f,portId:f.portId==='decision'?'annotation_status':'annotated'}));
  }else if(out.meta){
   const m=decodeIngestRequest(out.meta.payload);assert.match(m.tags.batchId,out.state_records?/^catalog-attempt-[0-9a-f]{64}$/:out.index_records?/^catalog-[0-9a-f]{64}:complete$/:/^catalog-[0-9a-f]{64}$/);const b=Buffer.from((out.product_records??out.index_records??out.state_records).payload);const destination=records(m.schema,m.tags.providerId,m.tags.sourceName);const exists=destination.some(x=>hash(x)===hash(b));if(!exists)destination.push(b);
   if(out.product_records){
    const product=O.OCM.getSizePrefixedRootAsOCM(new fb.ByteBuffer(b)).unpack();const id=product.METADATA.NORAD_CAT_ID;
    if(product.MEAN_ELEMENTS.MEAN_ELEMENT_THEORY===O.meanElementSource.AP&&!verified.has(id)){
      const original=fitOriginals.get(id);assert.ok(original);assert.ok(b.indexOf(original)>=0,'stored product embeds the entire fit output unchanged');
      const originalFields=O.OCM.getRootAsOCM(new fb.ByteBuffer(original)).unpack(),storedFields=product;
      for(const key of ['COV_REALISM','COVARIANCE_BLOCKS']){assert.deepEqual(storedFields[key].slice(0,originalFields[key].length),originalFields[key]);delete storedFields[key];delete originalFields[key];}
      assert.deepEqual(storedFields,originalFields,'every original fit field survives storage');
      assert.deepEqual(await fly(b.subarray(4)),await fly(original),'stored product states and formal covariance match the fit output bit for bit');
      verified.add(id);sizes.push({fit:original.length,stored:b.length});
    }
    ++counters.products;if(exists)++counters.duplicateProducts;if(kill){control.destroy();control=await createControl();evidence.stages.push({...counters,killedAfterProduct:true});return counters;}}
   else if(out.index_records){++counters.indexes;const cat=C.CAT.getSizePrefixedRootAsCAT(new fb.ByteBuffer(b)).unpack();if(cat.PRODUCTS.length){assert.ok(records('OCM.fbs','synthetic-node','catalog-products').length>0,'product exists before index');}}
   input=[frame('stored','IngestResult',encodeIngestResult({schema:m.schema,...m.tags,inserted:exists?0:1,reconciledDuplicates:0}))];
  }else if(out.recipe){
   const r=await composer.invoke({methodId:'replace_products',inputs:[out.recipe,out.catalog,{...out.selection,portId:'decision'},...(out.selected?[{...out.selected,portId:'ocm_products'}]:[])]});assert.equal(r.statusCode,0,r.errorMessage);input=r.outputs.map(f=>({...f,portId:f.portId==='decision'?'compose_status':'replacement'}));
  }else throw Error('No progress: '+Object.keys(out));
  response=await control.invoke({methodId:'advance',inputs:input});
 }
 throw Error('Bounded controller did not complete');
}
const current=()=>{const map=new Map();for(const b of records('CAT.fbs','synthetic-node','catalog-index')){const c=C.CAT.getSizePrefixedRootAsCAT(new fb.ByteBuffer(b)).unpack();if(!map.has(c.NORAD_CAT_ID)||map.get(c.NORAD_CAT_ID).PRODUCTS_AS_OF<=c.PRODUCTS_AS_OF)map.set(c.NORAD_CAT_ID,c);}return map;};
try{
 const first=await tick(now);assert.equal(first.fits,2);assert.equal(first.indexes,2);assert.ok([...current().values()].every(c=>c.PRODUCTS[0].KIND===C.catalogProductKind.ApElements));
 const unchanged=await tick(now+1000);assert.equal(unchanged.fits+unchanged.products+unchanged.indexes,0);
 const metadata=OMM.getSizePrefixedRootAsOMM(new fb.ByteBuffer(seed(ids[0]))).unpack();metadata.OBJECT_NAME='SYNTHETIC METADATA';records('OMM.fbs','synthetic','primary').push(pack(metadata,'OMM'));
 assert.equal((await tick(now+1100)).fits,0,'metadata-only seed reissue does not refit');
 const weatherRows=records('SPW.fbs','synthetic','weather');const usedDay=weatherRows.find(b=>SPW.getSizePrefixedRootAsSPW(new fb.ByteBuffer(b)).DATE()===obj.EPOCH.slice(0,10));
 const unused=SPW.getSizePrefixedRootAsSPW(new fb.ByteBuffer(usedDay)).unpack();unused.F107_ADJ=(Number.isFinite(unused.F107_ADJ)?unused.F107_ADJ:100)+1;weatherRows.push(pack(unused,'SPW'));assert.equal((await tick(now+1110)).fits,0,'unused weather fields do not refit');
 unused.F107_OBS+=1;weatherRows.push(pack(unused,'SPW'));assert.equal((await tick(now+1120)).fits,2,'overlapping weather driver revisions refit');
 weatherRows.splice(-2);await tick(now+1130);

 const renamed=C.CAT.getSizePrefixedRootAsCAT(new fb.ByteBuffer(records('CAT.fbs','synthetic','identities')[0])).unpack();renamed.OBJECT_NAME='SYNTHETIC RENAMED';renamed.OBJECT_ID='SYNTHETIC-DESIGNATOR';records('CAT.fbs','synthetic','identities').push(pack(renamed,'CAT'));
 await tick(now+1200);assert.equal(current().get(ids[0]).OBJECT_NAME,renamed.OBJECT_NAME);assert.equal(current().get(ids[0]).OBJECT_ID,renamed.OBJECT_ID);
 records('CAT.fbs','synthetic','identities').pop();await tick(now+1300);

 records('OMM.fbs','synthetic','primary').push(seed(ids[0],.1));const corrected=await tick(now+2000);assert.equal(corrected.fits,1);assert.equal(corrected.indexes,1);
 records('OMM.fbs','synthetic','primary').push(seed(ids[0],.2));await tick(now+3000,true);const deferred=await tick(now+4000);assert.equal(deferred.products+deferred.indexes,0);now+=1200000;const resumed=await tick(now+4000);assert.equal(resumed.fits,1);assert.equal(resumed.products,0);assert.equal(resumed.duplicateProducts,0);assert.equal(resumed.indexes,1);
 cfg['catalog.weather_source']='missing-weather';control.destroy();control=await createControl();const refused=await tick(now+5000);assert.equal(refused.fits,2);assert.ok([...current().values()].every(c=>c.PRODUCTS[0].KIND===C.catalogProductKind.Sgp4Elements&&/weather/.test(c.PRODUCTS[0].SELECTION_REASON)));
 const noRetry=await tick(now+6000);assert.equal(noRetry.fits+noRetry.products,0);
 cfg['catalog.weather_source']='weather';control.destroy();control=await createControl();const restored=await tick(now+7000);assert.equal(restored.fits,2);
 for(const [i,code] of ['fit-failed','too-few-states','decayed-in-arc:2026-01-01'].entries()){
  refusalCode=code;records('OMM.fbs','synthetic','primary').push(seed(ids[0],.21+i*.01));
  assert.equal((await tick(now+10000+i*1000000)).indexes,1);
  control.destroy();control=await createControl();const retry=await tick(now+610000+i*1000000);
  assert.equal(retry.fits+retry.products+retry.indexes,0,'deterministic refusal survives instance replacement: '+code);
 }refusalCode=undefined;records('OMM.fbs','synthetic','primary').push(seed(ids[0],.29));await tick(now+3000000);
 const stale=await tick(now+6*86400000);assert.equal(stale.fits,0);assert.equal(stale.fallbacks,2);assert.ok([...current().values()].every(c=>c.PRODUCTS[0].KIND===C.catalogProductKind.Sgp4Elements));
 records('CAT.fbs','synthetic','identities').splice(0,1);const removed=await tick(now+6*86400000+1000);assert.equal(removed.indexes,1);assert.equal(current().get(ids[0]).PRODUCTS.length,0);
 const consumer=new Map();for(const b of records('CAT.fbs','synthetic-node','catalog-index')){const c=C.CAT.getSizePrefixedRootAsCAT(new fb.ByteBuffer(b)).unpack();const old=consumer.get(c.NORAD_CAT_ID);if(!old||old.PRODUCTS_AS_OF<=c.PRODUCTS_AS_OF)consumer.set(c.NORAD_CAT_ID,c);}assert.deepEqual(consumer,current());evidence.consumerMapEqual=true;
 // Both services read shared sources and own disjoint updates, including fallback.
 cfg['catalog.partition_count']=2;
 records('CAT.fbs','synthetic','identities').splice(0,Infinity,...ids.map(id=>pack(Object.assign(new C.CATT(),{NORAD_CAT_ID:id,OBJECT_NAME:'SYNTHETIC'}),'CAT')));
 records('OMM.fbs','synthetic','primary').push(...ids.map(id=>seed(id,.3)));
 for(let partition=0;partition<2;partition++){
  cfg['catalog.partition_index']=partition;control.destroy();control=await createControl();
  const part=await tick(now+6*86400000+2000);assert.equal(part.products,1);assert.equal(part.indexes,1);assert.equal(part.fits,0);
 }
 assert.equal([...current().values()].filter(c=>c.PRODUCTS.length===1).length,2);
 // Poison one record in every source without losing healthy objects.
 cfg['catalog.partition_count']=1;cfg['catalog.partition_index']=0;
 control.destroy();control=await createControl();
 const badSeed=OMM.getRootAsOMM(new fb.ByteBuffer(ommBytes)).unpack();badSeed.NORAD_CAT_ID=0;
 records('OMM.fbs','synthetic','primary').push(pack(badSeed,'OMM'));
 records('CAT.fbs','synthetic','identities').push(pack(new C.CATT(),'CAT'));
 records('CAT.fbs','synthetic-node','catalog-index').push(pack(new C.CATT(),'CAT'));
 const badWeather=SPW.getSizePrefixedRootAsSPW(new fb.ByteBuffer(split(Buffer.from(weather))[0])).unpack();badWeather.DATE='bad';
 records('SPW.fbs','synthetic','weather').push(pack(badWeather,'SPW'));
 records('OCM.fbs','synthetic-node','catalog-products').push(pack(new C.CATT(),'CAT'));
 records('OMM.fbs','synthetic','primary').push(...ids.map(id=>seed(id,.4)));
 const poisoned=await tick(now+6*86400000+3000);assert.equal(poisoned.indexes,2);assert.match(poisoned.notice.reason,/invalid=4/);assert.equal(poisoned.notice.kind,'skipped');
 // An ingestion failure between two healthy identifiers cannot starve the last.
 const three=[999996,999997,999998];
 store.set(key('CAT.fbs','synthetic','identities'),three.map(id=>pack(Object.assign(new C.CATT(),{NORAD_CAT_ID:id,OBJECT_NAME:'SYNTHETIC'}),'CAT')));
 const failing=OMM.getRootAsOMM(new fb.ByteBuffer(ommBytes)).unpack();failing.NORAD_CAT_ID=three[1];failing.MEAN_MOTION=-1;
 store.set(key('OMM.fbs','synthetic','primary'),[seed(three[0],.5),pack(failing,'OMM'),seed(three[2],.5)]);
 cfg['catalog.batch_size']=4;control.destroy();control=await createControl();
 const isolated=await tick(now+6*86400000+4000);assert.ok(isolated.indexes>=2);assert.match(isolated.notice.reason,/failed=1/);assert.match(isolated.notice.reason,/durable failure/);assert.ok(current().get(three[2]).PRODUCTS.length);
 control.destroy();control=await createControl();const backoff=await tick(now+6*86400000+5000);assert.equal(backoff.fallbacks,0);assert.match(backoff.notice.reason,/deferred=[1-9]/);
 // A backward clock causes a typed composer refusal, then a healthy update.
 store.set(key('CAT.fbs','synthetic','identities'),ids.map(id=>pack(Object.assign(new C.CATT(),{NORAD_CAT_ID:id,OBJECT_NAME:'SYNTHETIC'}),'CAT')));
 store.set(key('OMM.fbs','synthetic','primary'),ids.map(id=>seed(id,.6)));
 const ahead=current().get(ids[1]);ahead.PRODUCTS_AS_OF=new Date(now+8*86400000).toISOString();records('CAT.fbs','synthetic-node','catalog-index').push(pack(ahead,'CAT'));
 control.destroy();control=await createControl();const backwards=await tick(now+6*86400000+6000);
 assert.match(backwards.notice.reason,/compose: invalid-replacement/);assert.ok(backwards.indexes>=1);
 // Future seeds become eligible without a content change.
 store.clear();records('CAT.fbs','synthetic','identities').push(...ids.map(id=>pack(Object.assign(new C.CATT(),{NORAD_CAT_ID:id,OBJECT_NAME:'SYNTHETIC'}),'CAT')));
 records('OMM.fbs','synthetic','primary').push(...ids.map(id=>seed(id)));
 records('SPW.fbs','synthetic','weather').push(...split(Buffer.from(weather)));
 control.destroy();control=await createControl();const future=await tick(now-86400000-1000);assert.equal(future.fits,0);assert.equal(future.fallbacks,2);
 const eligible=await tick(now);assert.equal(eligible.fits,2);
 cfg['catalog.batch_size']=1;control.destroy();control=await createControl();records('OMM.fbs','synthetic','primary').push(...ids.map(id=>seed(id,.7)));
 await tick(now+100);const served=[...current()].find(([,c])=>Date.parse(c.PRODUCTS_AS_OF)===now+100)[0];const waiting=ids.find(id=>id!==served);
 records('OMM.fbs','synthetic','primary').push(seed(served,.8));await tick(now+200);assert.equal(Date.parse(current().get(waiting).PRODUCTS_AS_OF),now+200,'oldest unserved selection precedes another change to the recently served object');
 cfg['catalog.batch_size']=4;

 cfg['catalog.max_records']=3;control.destroy();control=await createControl();const bounded=await tick(now+300);assert.match(bounded.notice.reason,/catalog.max_records=3/);assert.ok(bounded.indexes<=1,'bounded resident subset still makes progress without removals');delete cfg['catalog.max_records'];
 cfg['catalog.max_bytes']=512*1024*1024;control.destroy();control=await createControl();await assert.rejects(()=>tick(now+400));delete cfg['catalog.max_bytes'];
 cfg['catalog.max_removal_fraction']=.25;store.set(key('OMM.fbs','synthetic','primary'),[]);control.destroy();control=await createControl();
 const guarded=await tick(now+1000);assert.equal(guarded.indexes,0);assert.match(guarded.notice.reason,/mass-removal guard/);
 cfg['catalog.invocation_budget_ms']=1000;control.destroy();control=await createControl();const budget=await tick(now+2000);assert.equal(budget.fits+budget.fallbacks,0);assert.equal(budget.notice.kind,'skipped');
 delete cfg['catalog.invocation_budget_ms'];cfg['catalog.partition_count']=2;
 cfg['catalog.partition_index']=2;control.destroy();control=await createControl();
 await assert.rejects(()=>tick(now+6*86400000+3000));
 console.log(JSON.stringify({storedFitComparisons:sizes.length,meanFitBytes:sizes.reduce((a,s)=>a+s.fit,0)/sizes.length,meanStoredBytes:sizes.reduce((a,s)=>a+s.stored,0)/sizes.length}));evidence.passed=true;
}catch(e){evidence.failure=e.stack;throw e;}finally{control.destroy();chain.destroy();gp.destroy();composer.destroy();ap.destroy();}

});
