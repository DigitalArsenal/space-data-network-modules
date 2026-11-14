import test from 'node:test';import {fileURLToPath} from 'node:url';
import fs from 'node:fs';import * as fb from 'flatbuffers';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import * as N from 'spacedatastandards.org/lib/js/NEV/main.js';
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
const evidence={synthetic:true,stages:[]};const fitOriginals=new Map(),fallbackOriginals=new Map(),verified=new Set(),fallbackVerified=new Set(),sizes=[];
const ap=await createStandaloneHarness('browser',process.env.SDNAP_WASM||repo+'/propagator/sdn-ap/dist/isomorphic/module.wasm',{surface:'direct',enableBrowserWasiThreads:false});
const fly=async payload=>{const r=await ap.invoke({methodId:'propagate',inputs:[frame('ocm','OCM',payload),frame('configuration','PCF',checkPcf)]});assert.equal(r.statusCode,0,r.errorMessage);return Buffer.from(r.outputs.find(f=>f.portId==='ephemeris').payload);};
let annotationRefusal,composerRefusal,refusalCode,trapObject,trapComposeObject,lookupFailure=false,storageFailure=false,pageDelay=0;
const trap=new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,7,8,1,4,116,114,97,112,0,0,10,5,1,3,0,0,11]))).exports.trap;
async function tick(time,kill=false){
 let response=await control.invoke({methodId:'advance',inputs:[frame('tick','TimerTick',encodeTimerTick({triggerId:'refresh',firedMs:time}))]});
 const counters={fits:0,fallbacks:0,products:0,indexes:0,pages:0,duplicateProducts:0};
 for(let count=0;count<10000;count++){
  assert.equal(response.statusCode,0,response.errorMessage);const out=Object.fromEntries(response.outputs.map(f=>[f.portId,f]));let input=[];
  if(out.notice){counters.notice=decodeFlowNotice(out.notice.payload);evidence.stages.push(counters);return counters;}
  if(out.query){
   if(pageDelay)await new Promise(resolve=>setTimeout(resolve,pageDelay));
   ++counters.pages;const q=Q.QRP.getRootAsQRP(new fb.ByteBuffer(out.query.payload)).unpack();if(q.SCHEMA_NAME==='OCM.fbs')assert.match(q.BATCH_ID,/^catalog-[0-9a-f]{64}$/,'only deterministic product lookup reads OCM');const data=records(q.SCHEMA_NAME,q.PROVIDER_ID,q.SOURCE_NAME).filter(b=>!q.BATCH_ID||q.BATCH_ID==='catalog-'+hash(b));const [offset,head]=q.CURSOR?q.CURSOR.split(':').map(Number):[0,data.length];const page=data.slice(offset,Math.min(head,offset+q.LIMIT));const end=offset+page.length;
   const header=Object.assign(new Q.QRPT(),{KIND:Q.qrpKind.Page,STATUS:Q.qrpStatus.Ok,SCHEMA_NAME:q.SCHEMA_NAME,PROVIDER_ID:q.PROVIDER_ID,SOURCE_NAME:q.SOURCE_NAME,BATCH_ID:q.BATCH_ID,RECORD_COUNT:page.length,TOTAL_COUNT:BigInt(head),NEXT_CURSOR:end<head?end+':'+head:null});
   input=lookupFailure&&q.SCHEMA_NAME==='OCM.fbs'?[frame('query_status','QRP',pack(Object.assign(new Q.QRPT(),{KIND:Q.qrpKind.Error,STATUS:Q.qrpStatus.Error,ERROR_CODE:'host-failed'}),'QRP',false))]:[frame('page','QRP',Buffer.concat([pack(header,'QRP'),...page])),frame('query_status','QRP',out.query.payload)];
  }else if(out.seed||out.fallback_seed){
   const fit=!!out.seed;fit?counters.fits++:counters.fallbacks++;if(OMM.getRootAsOMM(new fb.ByteBuffer((out.seed??out.fallback_seed).payload)).NORAD_CAT_ID()===trapObject)trap();
   const inputs=fit?[frame('omm','OMM',out.seed.payload),...['flight_config','fit_config','weather'].filter(p=>out[p]).map(p=>out[p])]:[frame('omm','OMM',out.fallback_seed.payload)];
   const r=await chain.invoke({methodId:fit?'run_chain':'ingest_seed',inputs});assert.equal(r.statusCode,0,r.errorMessage);
   const fallback=r.outputs.find(f=>f.portId==='fallback');if(fallback)fallbackOriginals.set(O.OCM.getRootAsOCM(new fb.ByteBuffer(fallback.payload)).unpack().METADATA.NORAD_CAT_ID,Buffer.from(fallback.payload));
   const fitted=r.outputs.find(f=>f.portId==='elements');if(fitted)fitOriginals.set(O.OCM.getRootAsOCM(new fb.ByteBuffer(fitted.payload)).unpack().METADATA.NORAD_CAT_ID,Buffer.from(fitted.payload));
   input=r.outputs.map(f=>({...f,portId:{fallback:'fallback',elements:'candidate',decision:'chain_status'}[f.portId]}));
   if(fit&&refusalCode){input=input.filter(f=>!['candidate','chain_status'].includes(f.portId));input.push(frame('chain_status','QRP',pack(Object.assign(new Q.QRPT(),{KIND:Q.qrpKind.Error,STATUS:Q.qrpStatus.Error,ERROR_CODE:refusalCode}),'QRP',false)));}
  }else if(out.annotate_orbit){
   const r=await gp.invoke({methodId:'annotate_population_flow',inputs:[frame('ocm','OCM',out.annotate_orbit.payload),frame('elements','OMM',out.annotate_seed.payload)]});assert.equal(r.statusCode,0,r.errorMessage);input=r.outputs.map(f=>({...f,portId:f.portId==='decision'?'annotation_status':'annotated'}));if(annotationRefusal)input=[frame('annotation_status','QRP',pack(Object.assign(new Q.QRPT(),{KIND:Q.qrpKind.Error,STATUS:Q.qrpStatus.Error,ERROR_CODE:annotationRefusal}),'QRP',false))];
  }else if(out.meta){
   const m=decodeIngestRequest(out.meta.payload);assert.match(m.tags.batchId,out.state_records?/^catalog-attempt-[0-9a-f]{64}$/:out.index_records?/^catalog-[0-9a-f]{64}:complete$/:/^catalog-[0-9a-f]{64}$/);const b=Buffer.from((out.product_records??out.index_records??out.state_records).payload);const destination=records(m.schema,m.tags.providerId,m.tags.sourceName);const exists=destination.some(x=>hash(x)===hash(b));if(out.state_records){assert.equal(m.reconcile,"current");destination.splice(0,destination.length,...split(b));}else if(!exists&&!(storageFailure&&out.product_records))destination.push(...split(b));
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
    if(product.MEAN_ELEMENTS.MEAN_ELEMENT_THEORY===O.meanElementSource.SGP4&&!fallbackVerified.has(id)){
     const original=fallbackOriginals.get(id);assert.ok(original);const raw=O.OCM.getRootAsOCM(new fb.ByteBuffer(original)).unpack();
     const stored=O.OCM.getSizePrefixedRootAsOCM(new fb.ByteBuffer(b)).unpack();
     for(const k of ['COV_REALISM','COVARIANCE_BLOCKS']){assert.deepEqual(stored[k].slice(0,raw[k].length),raw[k]);delete stored[k];delete raw[k];}
     assert.deepEqual(stored.HEADER.COMMENT.slice(0,raw.HEADER.COMMENT.length),raw.HEADER.COMMENT);assert.equal(stored.HEADER.COMMENT.length,raw.HEADER.COMMENT.length+1);stored.HEADER.COMMENT=raw.HEADER.COMMENT;
     assert.deepEqual(stored,raw,'fallback repack preserves every original field');assert.deepEqual(await fly(b.subarray(4)),await fly(original),'stored fallback preserves SGP4 states and formal covariance');fallbackVerified.add(id);
    }
    ++counters.products;if(exists)++counters.duplicateProducts;if(kill){control.destroy();control=await createControl();evidence.stages.push({...counters,killedAfterProduct:true});return counters;}}
   else if(out.index_records){++counters.indexes;const cat=C.CAT.getSizePrefixedRootAsCAT(new fb.ByteBuffer(b)).unpack();if(cat.PRODUCTS.length){assert.ok(records('OCM.fbs','synthetic-node','catalog-products').length>0,'product exists before index');}}
   input=[frame('stored','IngestResult',encodeIngestResult({schema:m.schema,...m.tags,inserted:exists?0:1,reconciledDuplicates:0,refused:storageFailure&&out.product_records?'synthetic disk refusal':undefined}))];
  }else if(out.recipe){
   if(C.CAT.getSizePrefixedRootAsCAT(new fb.ByteBuffer(out.catalog.payload)).NORAD_CAT_ID()===trapComposeObject)trap();
   const r=await composer.invoke({methodId:'replace_products',inputs:[out.recipe,out.catalog,{...out.selection,portId:'decision'},...(out.selected?[{...out.selected,portId:'ocm_products'}]:[])]});assert.equal(r.statusCode,0,r.errorMessage);input=r.outputs.map(f=>({...f,portId:f.portId==='decision'?'compose_status':'replacement'}));if(composerRefusal)input=[frame('compose_status','QRP',pack(Object.assign(new Q.QRPT(),{KIND:Q.qrpKind.Error,STATUS:Q.qrpStatus.Error,ERROR_CODE:composerRefusal}),'QRP',false))];
  }else throw Error('No progress: '+Object.keys(out));
  try{response=await control.invoke({methodId:'advance',inputs:input});}catch(e){console.error('controller trap after',Object.keys(out), 'inputs',input.map(x=>x.portId), 'counters',counters);throw e;}
 }
 throw Error('Bounded controller did not complete');
}
const current=()=>{const map=new Map();for(const b of records('CAT.fbs','synthetic-node','catalog-index')){const c=C.CAT.getSizePrefixedRootAsCAT(new fb.ByteBuffer(b)).unpack();if(!map.has(c.NORAD_CAT_ID)||map.get(c.NORAD_CAT_ID).PRODUCTS_AS_OF<=c.PRODUCTS_AS_OF)map.set(c.NORAD_CAT_ID,c);}return map;};
try{
 const first=await tick(now);assert.equal(first.fits,2);assert.equal(first.indexes,2);assert.ok([...current().values()].every(c=>c.PRODUCTS[0].KIND===C.catalogProductKind.ApElements));
 assert.equal(records('NEV.fbs','synthetic-node','catalog-attempts').length,1);assert.equal(N.NEV.getSizePrefixedRootAsNEV(new fb.ByteBuffer(records('NEV.fbs','synthetic-node','catalog-attempts')[0])).eventsLength(),0,'successful selections leave no attempt events');
 const unchanged=await tick(now+1000);assert.equal(unchanged.fits+unchanged.products+unchanged.indexes,0);
 const metadata=OMM.getSizePrefixedRootAsOMM(new fb.ByteBuffer(seed(ids[0]))).unpack();metadata.OBJECT_NAME='SYNTHETIC METADATA';records('OMM.fbs','synthetic','primary').push(pack(metadata,'OMM'));
 assert.equal((await tick(now+1100)).fits,0,'metadata-only seed reissue does not refit');
 const weatherRows=records('SPW.fbs','synthetic','weather');const usedDay=weatherRows.find(b=>SPW.getSizePrefixedRootAsSPW(new fb.ByteBuffer(b)).DATE()===obj.EPOCH.slice(0,10));
 const unused=SPW.getSizePrefixedRootAsSPW(new fb.ByteBuffer(usedDay)).unpack();unused.F107_ADJ=(Number.isFinite(unused.F107_ADJ)?unused.F107_ADJ:100)+1;weatherRows.push(pack(unused,'SPW'));assert.equal((await tick(now+1110)).fits,0,'unused weather fields do not refit');
 unused.F107_OBS+=1;weatherRows.push(pack(unused,'SPW'));assert.equal((await tick(now+1120)).fits,2,'overlapping weather driver revisions refit');
 weatherRows.splice(-2);await tick(now+1130);

 const renamed=C.CAT.getSizePrefixedRootAsCAT(new fb.ByteBuffer(records('CAT.fbs','synthetic','identities')[0])).unpack();renamed.OBJECT_NAME='SYNTHETIC RENAMED';renamed.OBJECT_ID='SYNTHETIC-DESIGNATOR';records('CAT.fbs','synthetic','identities').push(pack(renamed,'CAT'));
 const identityRefresh=await tick(now+1200);assert.equal(identityRefresh.fits+identityRefresh.products,0,'identity metadata recomposes only the index');assert.equal(identityRefresh.indexes,1);assert.equal(current().get(ids[0]).OBJECT_NAME,renamed.OBJECT_NAME);assert.equal(current().get(ids[0]).OBJECT_ID,renamed.OBJECT_ID);
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
 const poisoned=await tick(now+6*86400000+3000);assert.equal(poisoned.indexes,2);assert.match(poisoned.notice.reason,/invalid=4/);assert.equal(poisoned.notice.kind,'info');
 // An ingestion failure between two healthy identifiers cannot starve the last.
 const three=[999996,999997,999998];store.set(key('CAT.fbs','synthetic-node','catalog-index'),records('CAT.fbs','synthetic-node','catalog-index').filter(b=>C.CAT.getSizePrefixedRootAsCAT(new fb.ByteBuffer(b)).NORAD_CAT_ID()));
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
 assert.match(backwards.notice.reason,/clock precedes/);assert.equal(backwards.products,1,'clock rollback does not create an orphan');assert.ok(backwards.indexes>=1);
 // Future seeds become eligible without a content change.
 store.clear();records('CAT.fbs','synthetic','identities').push(...ids.map(id=>pack(Object.assign(new C.CATT(),{NORAD_CAT_ID:id,OBJECT_NAME:'SYNTHETIC'}),'CAT')));
 records('OMM.fbs','synthetic','primary').push(...ids.map(id=>seed(id)));
 records('SPW.fbs','synthetic','weather').push(...split(Buffer.from(weather)));
 control.destroy();control=await createControl();const future=await tick(Date.parse(obj.EPOCH+'Z')-1000);assert.equal(future.fits,0);assert.equal(future.fallbacks,2);
 const eligible=await tick(now);assert.equal(eligible.fits,2);
 cfg['catalog.batch_size']=1;control.destroy();control=await createControl();records('OMM.fbs','synthetic','primary').push(...ids.map(id=>seed(id,.7)));
 await tick(now+100);const served=[...current()].find(([,c])=>Date.parse(c.PRODUCTS_AS_OF)===now+100)[0];const waiting=ids.find(id=>id!==served);
 records('OMM.fbs','synthetic','primary').push(seed(served,.8));await tick(now+200);assert.equal(Date.parse(current().get(waiting).PRODUCTS_AS_OF),now+200,'oldest unserved selection precedes another change to the recently served object');
 cfg['catalog.batch_size']=4;

 cfg['catalog.max_records']=3;control.destroy();control=await createControl();const bounded=await tick(now+300);assert.match(bounded.notice.reason,/catalog.max_records=3/);assert.ok(bounded.indexes<=1,'bounded resident subset still makes progress without removals');delete cfg['catalog.max_records'];
 cfg['catalog.max_bytes']=512*1024*1024;control.destroy();control=await createControl();await assert.rejects(()=>tick(now+400));delete cfg['catalog.max_bytes'];
 cfg['catalog.max_removal_fraction']=.25;store.set(key('OMM.fbs','synthetic','primary'),[]);control.destroy();control=await createControl();
 const guarded=await tick(now+1000);assert.equal(guarded.indexes,0);assert.match(guarded.notice.reason,/mass-removal guard/);
 cfg['catalog.invocation_budget_ms']=1000;control.destroy();control=await createControl();const budget=await tick(now+2000);assert.equal(budget.fits+budget.fallbacks,0);assert.equal(budget.notice.kind,'missing');
 delete cfg['catalog.invocation_budget_ms'];
 const reset=async (objectIds=ids)=>{store.clear();cfg['catalog.max_removal_fraction']=1;cfg['catalog.batch_size']=4;cfg['catalog.partition_count']=1;cfg['catalog.partition_index']=0;
  records('CAT.fbs','synthetic','identities').push(...objectIds.map(id=>pack(Object.assign(new C.CATT(),{NORAD_CAT_ID:id,OBJECT_NAME:'SYNTHETIC'}),'CAT')));
  records('OMM.fbs','synthetic','primary').push(...objectIds.map(id=>seed(id)));records('SPW.fbs','synthetic','weather').push(...split(Buffer.from(weather)));control.destroy();control=await createControl();};
 await reset();await tick(now);records('OMM.fbs','synthetic','primary').push(...ids.map(id=>seed(id,.2)));
 cfg['catalog.max_records']=12;control.destroy();control=await createControl();const cutWeather=await tick(now+1000);
 assert.equal(cutWeather.fits+cutWeather.fallbacks+cutWeather.products+cutWeather.indexes,0,'partial weather never downgrades existing AP selections');assert.match(cutWeather.notice.reason,/weather scan incomplete/);
 delete cfg['catalog.max_records'];control.destroy();control=await createControl();assert.equal((await tick(now+2000)).fits,2,'complete weather resumes fitting');
 console.log('PASS incomplete weather defers fitting without replacing AP');
 await reset();await tick(now);trapComposeObject=Math.min(...ids);store.set(key('CAT.fbs','synthetic','identities'),records('CAT.fbs','synthetic','identities').filter(b=>C.CAT.getSizePrefixedRootAsCAT(new fb.ByteBuffer(b)).NORAD_CAT_ID()!==trapComposeObject));
 const newerSelection=current().get(Math.max(...ids));newerSelection.PRODUCTS_AS_OF=new Date(now+1).toISOString();records('CAT.fbs','synthetic-node','catalog-index').push(pack(newerSelection,'CAT'));
 records('OMM.fbs','synthetic','primary').push(seed(Math.max(...ids),.31));await assert.rejects(()=>tick(now+1000),WebAssembly.RuntimeError);trapComposeObject=undefined;control.destroy();control=await createControl();
 const removalTrap=await tick(now+600000);assert.equal(removalTrap.indexes,1,'a trapped removal does not block a later changed object');assert.match(removalTrap.notice.reason,/in-progress attempt deferred/);
 assert.equal((await tick(now+1201001)).indexes,1,'removal resumes after durable backoff');
 console.log('PASS durable removal attempt protects composition traps');
 await reset();trapObject=Math.min(...ids);await assert.rejects(()=>tick(now),WebAssembly.RuntimeError);control.destroy();control=await createControl();trapObject=undefined;
 const afterTrap=await tick(now+600000);assert.equal(afterTrap.fits,1,'fresh guest sets aside the trapped first object and reaches the later object');assert.match(afterTrap.notice.reason,/in-progress attempt deferred/);
 control.destroy();control=await createControl();assert.equal((await tick(now+1200001)).fits,1,'durable attempt becomes retryable after backoff');
 console.log('PASS durable attempt acknowledgment, Wasm trap, fresh-instance progress and backoff');
 // A weather defect does not prevent a known decay removal or make a source absence unknown.
 records('SPW.fbs','synthetic','weather').push(pack(badWeather,'SPW'));
 const decay=C.CAT.getSizePrefixedRootAsCAT(new fb.ByteBuffer(records('CAT.fbs','synthetic','identities')[0])).unpack();decay.DECAY_DATE=new Date(now).toISOString().slice(0,10);records('CAT.fbs','synthetic','identities').push(pack(decay,'CAT'));
 records('OMM.fbs','synthetic','primary').push(pack(badSeed,'OMM'));
 assert.equal((await tick(now+1201000)).indexes,1,'known decay survives malformed weather and seed rows');
 for(let i=0;i<3;i++){control.destroy();control=await createControl();const observed=await tick(now+1202000+i*1000);assert.match(observed.notice.reason,/invalid=2/);assert.doesNotMatch(observed.notice.reason,/invalid record-sha256/,'unchanged poison reported once, then counted');}
 records('OMM.fbs','synthetic','primary').splice(0,2);const quarantined=await tick(now+1210000);assert.equal(quarantined.indexes,1,'three observations quarantine poison without permanently disabling absence removal');
 console.log('PASS per-source poison quarantine and independent decay removal');
 await reset([999994,999995,999996,999997]);lookupFailure=true;await assert.rejects(()=>tick(now),/Storage circuit breaker/);lookupFailure=false;
 assert.equal(records('OCM.fbs','synthetic-node','catalog-products').length,0);
 const failureLog=records('NEV.fbs','synthetic-node','catalog-attempts').map(b=>N.NEV.getSizePrefixedRootAsNEV(new fb.ByteBuffer(b)).unpack().EVENTS).flat();assert.equal(failureLog.length,3,'host-wide lookup failure attempts only three objects');
 await reset([999994,999995,999996,999997]);storageFailure=true;await assert.rejects(()=>tick(now),/Storage circuit breaker/);storageFailure=false;
 assert.equal(records('OCM.fbs','synthetic-node','catalog-products').length,0);
 console.log('PASS lookup isolation and three-refusal storage circuit breaker');
 await reset();cfg['catalog.invocation_budget_ms']=3000;pageDelay=1150;control.destroy();control=await createControl();const scanBudget=await tick(now);assert.equal(scanBudget.pages,1,'elapsed scan time consumes budget; a frozen clock fails this assertion');assert.equal(scanBudget.fits+scanBudget.fallbacks,0);assert.equal(scanBudget.notice.kind,'missing');assert.match(scanBudget.notice.reason,/scan elapsed budget exhausted/);pageDelay=0;delete cfg['catalog.invocation_budget_ms'];
 console.log('PASS elapsed monotonic scan budget');
 await reset();const subms=OMM.getRootAsOMM(new fb.ByteBuffer(ommBytes)).unpack();subms.EPOCH=subms.EPOCH.replace('.000','.000499');
 store.set(key('OMM.fbs','synthetic','primary'),ids.map(id=>pack(Object.assign(OMM.getRootAsOMM(new fb.ByteBuffer(ommBytes)).unpack(),subms,{NORAD_CAT_ID:id}),'OMM')));
 assert.equal((await tick(now)).fits,2);assert.ok([...current().values()].every(c=>c.PRODUCTS[0].KIND===C.catalogProductKind.ApElements),'submillisecond seed epochs share the one-millisecond acceptance tolerance');
 await reset();cfg['catalog.nonresonant_max_e']=0;control.destroy();control=await createControl();assert.equal((await tick(now)).fallbacks,2);
 const revised=SPW.getSizePrefixedRootAsSPW(new fb.ByteBuffer(records('SPW.fbs','synthetic','weather')[45])).unpack();revised.F107_OBS+=10;records('SPW.fbs','synthetic','weather').push(pack(revised,'SPW'));
 const unusedWeather=await tick(now+1000);assert.equal(unusedWeather.fits+unusedWeather.products+unusedWeather.indexes,0,'excluded fallback never hashes unused weather');
 const agedFallback=await tick(now+6*86400000);assert.equal(agedFallback.indexes,2);assert.ok([...current().values()].every(c=>c.PRODUCTS[0].SELECTION_REASON.startsWith('old-span fallback')));delete cfg['catalog.nonresonant_max_e'];
 console.log('PASS submillisecond epoch, unused fallback weather and fallback aging');
 await reset();refusalCode='pool-dead';const temporary=await tick(now);assert.equal(temporary.indexes,2);assert.ok([...current().values()].every(c=>c.PRODUCTS[0].KIND===C.catalogProductKind.Sgp4Elements));
 control.destroy();control=await createControl();assert.equal((await tick(now+1000)).fits,0,'transient fallback retains backoff across replacement');
 refusalCode=undefined;assert.equal((await tick(now+1200001)).fits,2,'transient fallback eventually upgrades to AP');
 for(const kind of ['annotation','composer']){await reset();if(kind==='annotation')annotationRefusal='invalid-models';else composerRefusal='invalid-replacement';const failed=await tick(now);assert.equal(failed.indexes,0);control.destroy();control=await createControl();assert.equal((await tick(now+86400001)).fits,0,'deterministic '+kind+' refusal is final');annotationRefusal=composerRefusal=undefined;}
 console.log('PASS deterministic downstream refusals and transient fallback recovery');
 await reset();records('CAT.fbs','synthetic-node','catalog-index').push(pack(new C.CATT(),'CAT'));
 for(let i=0;i<3;i++){control.destroy();control=await createControl();const observation=await tick(now+i*1000);assert.equal(observation.indexes,i===2?2:0);}
 control.destroy();control=await createControl();const indexQuarantined=await tick(now+4000);assert.equal(indexQuarantined.fits+indexQuarantined.indexes,0);assert.doesNotMatch(indexQuarantined.notice.reason,/invalid record-sha256/);
 records('NEV.fbs','synthetic-node','catalog-attempts').unshift(pack(new C.CATT(),'CAT'));control.destroy();control=await createControl();await tick(now+5000);
 assert.equal(records('NEV.fbs','synthetic-node','catalog-attempts').length,1,'state compaction removes its malformed historical row');
 console.log('PASS index and operational-source quarantine');


 cfg['catalog.partition_count']=2;
 cfg['catalog.partition_index']=2;control.destroy();control=await createControl();
 await assert.rejects(()=>tick(now+6*86400000+3000));
 console.log(JSON.stringify({storedFitComparisons:sizes.length,storedFallbackComparisons:fallbackVerified.size,meanFitBytes:sizes.reduce((a,s)=>a+s.fit,0)/sizes.length,meanStoredBytes:sizes.reduce((a,s)=>a+s.stored,0)/sizes.length}));evidence.passed=true;
}catch(e){evidence.failure=e.stack;throw e;}finally{control.destroy();chain.destroy();gp.destroy();composer.destroy();ap.destroy();}

});
