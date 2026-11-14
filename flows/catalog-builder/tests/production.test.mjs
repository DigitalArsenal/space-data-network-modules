import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as fb from 'flatbuffers';
import * as C from 'spacedatastandards.org/lib/js/CAT/main.js';
import * as Q from 'spacedatastandards.org/lib/js/QRP/main.js';
import {OMM} from 'spacedatastandards.org/lib/js/OMM/OMM.js';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {encodeTimerTick,decodeIngestRequest,encodeIngestResult} from 'space-data-module-sdk/runtime-contracts';
import {ommBytes} from './fixtures.mjs';

const readme=fs.readFileSync(new URL('../README.md',import.meta.url),'utf8');
const settings=JSON.parse(/```json\n([\s\S]*?)\n```/.exec(readme)[1]);
const pack=(r,c)=>{const b=new fb.Builder(4096);b.finishSizePrefixed(r.pack(b),'$'+c);return Buffer.from(b.asUint8Array());};
const frame=(portId,c,payload)=>({portId,payload,typeRef:{schemaName:c+'.fbs',fileIdentifier:{TimerTick:'TICK',IngestResult:'INGR'}[c]??'$'+c,rootTypeName:c,wireFormat:'flatbuffer'}});

test('operator example configures four disjoint 256-object services and paired snapshots',()=>{
 assert.equal(settings.flows.services.length,4);assert.equal(settings.flows.max_flows,4);
 const programs=new Set();
 for(const [i,s] of settings.flows.services.entries()){
  programs.add(s.flow);assert.equal(s.flow,'com.digitalarsenal.flows.catalog-builder.partition-'+i);
  assert.equal(s.config['catalog.partition_count'],4);assert.equal(s.config['catalog.partition_index'],i);
  assert.equal(s.config['catalog.batch_size'],256);assert.equal(s.config['catalog.nonresonant_max_e'],.05);assert.equal(s.config['catalog.resonant_max_e'],.3);
  assert.equal(s.intervals.refresh,'10m');assert.equal(s.retrieval_interval,'1m');assert.equal(s.execution_timeout,'10m');
  assert.equal(s.config['catalog.invocation_budget_ms'],540000);assert.equal(s.memory_pages,4096);
  assert.equal(s.exclusive_group,'');assert.equal(s.release_after_run,true);
 }
 assert.equal(programs.size,4);assert.equal(settings.publishing.retention.keep_series,0);
 const rules=settings.publishing.auto_publish;
 assert.equal(rules.length,3);
 assert.ok(rules.slice(0,2).every(r=>r.retain_for_publication&&r.min_interval==='5m'&&r.provider_id==='catalog-producer'));
 assert.equal(rules[0].source_name,'catalog-products');assert.equal(rules[0].schema,'OCM.fbs');
 assert.equal(rules[1].source_name,'catalog-index');assert.equal(rules[1].schema,'CAT.fbs');
 assert.deepEqual(rules[2],{schema:'CAT.fbs',provider_id:'catalog-producer',source_name:'catalog-index',publish_scope:'source',paired_publication:true,catalog_product_source:'catalog-products',min_interval:'24h'});
});

test('configured AP class follows eccentricity limits and every resonance-band boundary',async()=>{
 // Independent class expectations from sdn-ap SPEC 6 / src/resonance.inc::band_of.
 // Mean motion is radians/minute, eccentricity dimensionless, and the synthetic
 // OMM epoch is UTC. No trajectory tolerance is involved in a dispatch decision.
 const cases=[
  [.02,.05,true],[.02,.050001,false],[.02,.3,false],
  [.004,.3,true],[.004,.300001,false],
  [.008,.3,true],[.008,.300001,false],
  [.012,.3,true],[.012,.300001,false],
  [.006,.3,true],[.006,.300001,false],
  [.0035003818-1e-12,.1,false],[.0035003818+1e-12,.1,true],
  [.0052505727-1e-12,.1,true],[.0052505727+1e-12,.1,true],
  [.0070007636-1e-12,.1,true],[.0070007636+1e-12,.1,true],
  [.007875859-1e-12,.1,true],[.007875859+1e-12,.1,true],
  [.0105011454-1e-12,.1,true],[.0105011454+1e-12,.1,true],
  [.015751718-1e-12,.1,true],[.015751718+1e-12,.1,false]
 ];
 const service=settings.flows.services[0],dir=new URL('../dist/flow/control/',import.meta.url);
 for(const [n,e,fit] of cases){
  const cfg=service.config,seed=OMM.getRootAsOMM(new fb.ByteBuffer(ommBytes)).unpack();seed.NORAD_CAT_ID=1000000;seed.ECCENTRICITY=e;seed.MEAN_MOTION=n*1440/(2*Math.PI);
  const identity=Object.assign(new C.CATT(),{NORAD_CAT_ID:seed.NORAD_CAT_ID,OBJECT_NAME:'SYNTHETIC'});
  const h=await createBrowserModuleHarness({wasmSource:fs.readFileSync(new URL('dist/isomorphic/module.wasm',dir)),manifest:JSON.parse(fs.readFileSync(new URL('../control/plugin-manifest.json',import.meta.url))),surface:'direct',hostOptions:{config:cfg}});
  try{
   let response=await h.invoke({methodId:'advance',inputs:[frame('tick','TimerTick',encodeTimerTick({triggerId:'refresh',firedMs:Date.parse(seed.EPOCH+'Z')+86400000}))]}),dispatched=false;
   for(let i=0;i<12;i++){
    assert.equal(response.statusCode,0,response.errorMessage);const out=Object.fromEntries(response.outputs.map(x=>[x.portId,x]));let input;
    if(out.seed||out.fallback_seed){assert.equal(!!out.seed,fit,`n=${n}, e=${e}`);dispatched=true;break;}
    if(out.query){
     const q=Q.QRP.getRootAsQRP(new fb.ByteBuffer(out.query.payload)).unpack();
     const rows=q.SOURCE_NAME===cfg['catalog.seed_sources'][0]?[pack(seed,'OMM')]:q.SOURCE_NAME===cfg['catalog.identity_source']?[pack(identity,'CAT')]:[];
     const header=Object.assign(new Q.QRPT(),{KIND:Q.qrpKind.Page,STATUS:Q.qrpStatus.Ok,SCHEMA_NAME:q.SCHEMA_NAME,PROVIDER_ID:q.PROVIDER_ID,SOURCE_NAME:q.SOURCE_NAME,RECORD_COUNT:rows.length,TOTAL_COUNT:BigInt(rows.length)});
     input=[frame('page','QRP',Buffer.concat([pack(header,'QRP'),...rows]))];
    }else if(out.meta){const m=decodeIngestRequest(out.meta.payload);assert.ok(out.state_records);input=[frame('stored','IngestResult',encodeIngestResult({schema:m.schema,...m.tags,inserted:1,reconciledDuplicates:0}))];}
    else assert.fail('expected query, acknowledged attempt or numerical dispatch');
    response=await h.invoke({methodId:'advance',inputs:input});
   }
   assert.ok(dispatched);
  }finally{h.destroy();}
 }
});

import {verifyPageConfig} from './page-config.mjs';
test('durable page bounds accept typed configuration and reject invalid settings',verifyPageConfig);
