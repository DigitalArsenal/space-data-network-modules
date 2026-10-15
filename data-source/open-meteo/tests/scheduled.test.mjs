import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { validateArtifactWithStandards } from 'space-data-module-sdk/compliance';
import { decodeFlowNotice, decodeHttpRequest, decodeIngestRequest } from 'space-data-module-sdk/runtime-contracts';
import { ADAPTER, CORE, forecast, harness, httpResponse, nodeConfig, producerPeerId, standardsRoot, tick } from './fixture.mjs';

const prepare=h=>h.invoke({methodId:'prepare_scheduled',inputs:[tick()]});
const notice=(result)=>{ assert.deepEqual(result.outputs.map(f=>[f.portId,f.typeRef?.fileIdentifier]),[['status','FNTC']]); return decodeFlowNotice(result.outputs[0].payload); };

test('the adapter artifact satisfies the SDK contract with typed ports only',async()=> {
  const manifest=JSON.parse(fs.readFileSync(ADAPTER.manifest,'utf8'));
  const report=await validateArtifactWithStandards({wasmPath:ADAPTER.wasm,manifest,standardsRoot});
  assert.equal(report.ok,true,JSON.stringify(report.issues));
  for(const p of manifest.methods.flatMap(m=>[...m.inputPorts,...m.outputPorts])) {
    assert.equal(p.acceptedTypeSets[0].allowedTypes.length,1); assert.equal(p.acceptedTypeSets[0].allowedTypes[0].wireFormat,'flatbuffer');
    assert.equal(p.acceptedTypeSets[0].allowedTypes[0].acceptsAnyFlatbuffer,undefined);
  }
});

test('scheduled fetch is disabled until explicitly configured; the enabled tick is forwarded verbatim',async t=> {
  const h=await harness(t,{...ADAPTER,config:{}});
  const disabled=await prepare(h);
  assert.equal(disabled.statusCode,0,disabled.errorMessage);
  assert.deepEqual(notice(disabled),{kind:'skipped',schema:'WXF.fbs',providerId:'open-meteo',sourceName:'',batchId:'',count:0,reason:'disabled',items:[],atMs:0});
  h.stub.config=nodeConfig();
  const sent=tick(), enabled=await h.invoke({methodId:'prepare_scheduled',inputs:[sent]});
  assert.equal(enabled.statusCode,0,enabled.errorMessage);
  assert.deepEqual(enabled.outputs.map(f=>[f.portId,f.typeRef?.fileIdentifier]),[['tick','TICK']]);
  assert.deepEqual(Buffer.from(enabled.outputs[0].payload),Buffer.from(sent.payload));
  for(const broken of [null,nodeConfig({open_meteo_producer_peer_id:''}),nodeConfig({open_meteo_forecast:{...forecast,access:'customer'}}),{open_meteo_enabled:true,open_meteo_producer_peer_id:producerPeerId}]) {
    h.stub.config=broken;
    const rejected=await prepare(h);assert.notEqual(rejected.statusCode,0);assert.equal(rejected.outputs.length,0);
  }
});

test('timer -> adapter -> plan -> http -> receipt -> parse: one IngestRequest and the records; a 304 replaces nothing',async t=> {
  const adapter=await harness(t,{...ADAPTER,config:nodeConfig()}), core=await harness(t,{...CORE,config:nodeConfig()});
  const forwarded=(await prepare(adapter)).outputs[0];
  const planned=await core.invoke({methodId:'plan_forecast',inputs:[{portId:'tick',typeRef:forwarded.typeRef,payload:forwarded.payload}]});
  const request=decodeHttpRequest(planned.outputs[0].payload);
  // 304: the publisher has nothing new; the current batch stays
  const unchanged=await adapter.invoke({methodId:'receipt_scheduled',inputs:[httpResponse(request.context,'',304)]});
  assert.equal(unchanged.statusCode,0,unchanged.errorMessage);
  assert.deepEqual(notice(unchanged),{kind:'unchanged',schema:'WXF.fbs',providerId:'open-meteo',sourceName:'forecast/52.52,13.41',batchId:'',count:0,reason:'not-modified',items:[],atMs:0});
  // 200: forwarded verbatim to the parser
  const answered=httpResponse(request.context);
  const receipt=await adapter.invoke({methodId:'receipt_scheduled',inputs:[answered]});
  assert.equal(receipt.statusCode,0,receipt.errorMessage);
  assert.deepEqual(receipt.outputs.map(f=>[f.portId,f.typeRef?.fileIdentifier]),[['response','HRSP']]);
  assert.deepEqual(Buffer.from(receipt.outputs[0].payload),Buffer.from(answered.payload));
  const parsed=await core.invoke({methodId:'parse_forecast',inputs:[{portId:'response',typeRef:receipt.outputs[0].typeRef,payload:receipt.outputs[0].payload}]});
  assert.equal(parsed.statusCode,0,parsed.errorMessage);
  assert.equal(decodeIngestRequest(parsed.outputs.find(f=>f.portId==='meta').payload).tags.sourceName,'forecast/52.52,13.41');
  // disabled between fetch and receipt: refused, nothing forwarded
  adapter.stub.config=nodeConfig({open_meteo_enabled:false});
  const off=await adapter.invoke({methodId:'receipt_scheduled',inputs:[answered]});
  assert.notEqual(off.statusCode,0); assert.equal(off.outputs.length,0);
});
