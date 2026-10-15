import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { validateArtifactWithStandards } from 'space-data-module-sdk/compliance';
import { decodeFlowNotice, decodeHttpRequest, decodeIngestRequest } from 'space-data-module-sdk/runtime-contracts';
import { CORE, forecast, harness, httpResponse, nodeConfig, producerPeerId, readWxf, response, retrievedMs, standardsRoot, tick, writeWxf, wxf } from './fixture.mjs';

const manifest=JSON.parse(fs.readFileSync(CORE.manifest,'utf8'));
const core=(t,config=nodeConfig())=>harness(t,{...CORE,config});
const plan=(h)=>h.invoke({methodId:'plan_forecast',inputs:[tick()]});
function planned(result) {
  assert.equal(result.statusCode,0,result.errorMessage);
  assert.deepEqual(result.outputs.map(f=>[f.portId,f.typeRef?.fileIdentifier]),[['request','HREQ']]);
  return decodeHttpRequest(result.outputs[0].payload);
}
const parse=(h,context,...args)=>h.invoke({methodId:'parse_forecast',inputs:[httpResponse(context,...args)]});
function records(result) {
  const bytes=result.outputs.find(f=>f.portId==='records').payload, rows=[];
  for(let offset=0;offset<bytes.length;) {
    const size=new DataView(bytes.buffer,bytes.byteOffset+offset,4).getUint32(0,true)+4;
    assert.ok(size>=12 && offset+size<=bytes.length);
    const frame=bytes.slice(offset,offset+size);
    assert.equal(Buffer.from(frame.slice(8,12)).toString(),'$WXF');
    rows.push(readWxf(frame)); offset+=size;
  }
  return rows;
}

test('the actual artifact satisfies the SDK contract with typed ports only',async()=> {
  const report=await validateArtifactWithStandards({wasmPath:CORE.wasm,manifest,standardsRoot});
  assert.equal(report.ok,true,JSON.stringify(report.issues));
  const ids=manifest.methods.map(m=>[m.methodId,[...m.inputPorts,...m.outputPorts].map(p=>{
    assert.equal(p.acceptedTypeSets.length,1,p.portId); assert.equal(p.acceptedTypeSets[0].allowedTypes.length,1,p.portId);
    const [type]=p.acceptedTypeSets[0].allowedTypes; assert.equal(type.acceptsAnyFlatbuffer,undefined); assert.equal(type.wireFormat,'flatbuffer');
    return `${p.portId}:${type.fileIdentifier}`;
  })]);
  assert.deepEqual(ids,[['plan_forecast',['tick:TICK','request:HREQ']],['parse_forecast',['response:HRSP','records:$WXF','meta:INGQ','report:FNTC']]]);
});

test('plans one GET with explicit units and UTC; the plan rides CONTEXT as a $WXF header; no credentials in it',async t=> {
  const h=await core(t), request=planned(await plan(h)), url=new URL(request.url);
  assert.deepEqual(h.stub.wire.map(c=>c.op),['plugin.getConfig']);
  assert.equal(request.method,'GET'); assert.equal(request.timeoutMs,20000); assert.equal(request.maxBytes,4*1024*1024);
  assert.equal(url.hostname,'api.open-meteo.com');
  assert.equal(url.searchParams.get('timeformat'),'unixtime'); assert.equal(url.searchParams.get('timezone'),'GMT');
  assert.equal(url.searchParams.get('wind_speed_unit'),'ms'); assert.equal(url.searchParams.get('temperature_unit'),'celsius');
  assert.equal(url.searchParams.get('hourly'),forecast.variables.join(','));
  const job=readWxf(request.context);
  assert.equal(job.SOURCE_URL,request.url); assert.equal(job.FIELD_ID,'forecast/52.52,13.41'); assert.equal(job.DATASET_ID,'forecast/52.52,13.41');
  assert.equal(job.GRID.LAT0,52.52); assert.equal(job.GRID.LON0,13.41); assert.equal(job.GRID.NLAT,1);
  assert.equal(job.PRODUCER_PEER_ID,producerPeerId);
  assert.equal(job.TIME_BASIS,wxf.wxfTimeBasis.ValidTimeOnly); assert.equal(job.LICENSE_CLASS,wxf.wxfLicenseClass.OpenAttribution); assert.equal(job.VALUES.length,0);
  h.stub.config=nodeConfig({open_meteo_forecast:{...forecast,access:'customer'}});
  const paid=planned(await plan(h));
  assert.equal(new URL(paid.url).hostname,'customer-api.open-meteo.com');
  assert.ok(!JSON.stringify(paid.headers).includes('apikey') && !paid.url.includes('apikey') && !Buffer.from(paid.context).includes('apikey'));
  h.stub.config=nodeConfig({open_meteo_forecast:{latitude:1,longitude:2,access:'noncommercial'}});
  const defaults=new URL(planned(await plan(h)).url);
  assert.equal(defaults.searchParams.get('hourly'),'temperature_2m,relative_humidity_2m,cloud_cover,wind_speed_10m,pressure_msl,precipitation');
  assert.equal(defaults.searchParams.get('forecast_days'),'3');
});

test('normalizes the documented weather units, UTC epochs, licence and missing values; IngestRequest + FlowNotice report',async t=> {
  const h=await core(t), request=planned(await plan(h)), result=await parse(h,request.context);
  assert.equal(result.statusCode,0,result.errorMessage);
  const rows=records(result); assert.equal(rows.length,192);
  // SI conversions are exact definitions; 5e-5 accommodates float32 storage
  // near 286 K. Pressure values are exactly representable at this magnitude.
  const expected={temperature_2m:[286.15,'K'],dew_point_2m:[273.15,'K'],relative_humidity_2m:[.5,'1'],cloud_cover:[.75,'1'],wind_speed_10m:[10,'m/s'],pressure_msl:[101325,'Pa'],surface_pressure:[90000,'Pa'],precipitation:[.0025,'m']};
  for(const [variable,[value,units]] of Object.entries(expected)) {
    const record=rows.find(r=>r.VARIABLE_NAME===variable);
    assert.ok(Math.abs(record.VALUES[0]-value)<5e-5,variable); assert.equal(record.UNITS,units);
    assert.equal(record.TIME_BASIS,wxf.wxfTimeBasis.ValidTimeOnly); assert.equal(record.INIT_TIME_MS,0n);
    assert.equal(record.MEMBER_KIND,wxf.wxfMemberKind.Unspecified); assert.equal(record.LEAD_HOURS,0);
    assert.equal(record.VALID_TIME_MS,1656633600000n); assert.equal(record.RETRIEVED_AT,BigInt(retrievedMs));
    assert.equal(record.LICENSE_CLASS,wxf.wxfLicenseClass.OpenAttribution); assert.equal(record.PRODUCER_PEER_ID,producerPeerId);
    assert.equal(record.SOURCE_URL,request.url); assert.match(record.CITATION,/Open-Meteo/);
    assert.equal(record.GRID.NLAT,1); assert.equal(record.GRID.NLON,1); assert.equal(record.GRID.LON0,13.419);
  }
  const missing=rows.find(r=>r.VARIABLE_NAME==='temperature_2m' && r.VALID_TIME_MS===1656640800000n);
  assert.ok(Number.isNaN(missing.VALUES[0])); assert.ok(Number.isNaN(missing.VALUE_MIN)); assert.equal(missing.MISSING_COUNT,1);
  const rain=rows.find(r=>r.VARIABLE_NAME==='precipitation'); assert.equal(rain.TEMPORAL_KIND,wxf.wxfTemporalKind.Accumulated); assert.equal(rain.ACCUMULATION_HOURS,1);
  const batch=crypto.createHash('sha256').update(JSON.stringify(response())).digest('hex');
  const meta=decodeIngestRequest(result.outputs.find(f=>f.portId==='meta').payload);
  assert.deepEqual(meta,{schema:'WXF.fbs',reconcile:'current',archive:null,provenance:null,tags:{providerId:'open-meteo',sourceName:'forecast/52.52,13.41',batchId:batch,sourceUrl:request.url,
    contentKeyId:'',sourcePeer:producerPeerId,license:'CC-BY-4.0',licenseUrl:'https://creativecommons.org/licenses/by/4.0/',citation:'Weather data by Open-Meteo (https://open-meteo.com/), CC BY 4.0; units converted to SDS WXF units.',shareAlike:false}});
  const report=result.outputs.filter(f=>f.portId==='report').map(f=>decodeFlowNotice(f.payload));
  assert.deepEqual(report.map(n=>[n.kind,n.count,n.atMs,n.sourceName,n.batchId]),[['info',192,retrievedMs,'forecast/52.52,13.41',batch],['missing',1,retrievedMs,'forecast/52.52,13.41',batch]]);
});

test('rejects invalid configuration and recovers on the same instance',async t=> {
  const h=await core(t);
  for(const value of [null,{}, {...forecast,access:''},{...forecast,latitude:91},{...forecast,longitude:'13'},
    {...forecast,forecast_days:1.5},{...forecast,forecast_days:100000000000},
    {...forecast,variables:['temperature_2m','temperature_2m']},{...forecast,variables:['invented']},{...forecast,variables:[3]}]) {
    h.stub.config=value===null?null:nodeConfig({open_meteo_forecast:value});
    const result=await plan(h);assert.notEqual(result.statusCode,0,JSON.stringify(value));assert.equal(result.outputs.length,0);
  }
  h.stub.config=nodeConfig();
  assert.equal((await plan(h)).statusCode,0);
});

test('rejects partial or wrong-unit responses atomically and preserves legitimate zero values',async t=> {
  const h=await core(t), {context}=planned(await plan(h));
  const bad=[body=>body.hourly.time.pop(),body=>body.hourly.precipitation.pop(),body=>body.hourly.time[1]++,
    body=>body.hourly_units.temperature_2m='°F',body=>body.utc_offset_seconds=3600,
    body=>body.hourly.cloud_cover[23]=101,body=>body.hourly.temperature_2m[23]='missing',
    body=>delete body.hourly_units,body=>delete body.latitude];
  for(const mutate of bad) { const body=response();mutate(body);const result=await parse(h,context,body);assert.notEqual(result.statusCode,0);assert.equal(result.outputs.length,0); }
  for(const status of [304,429,500,503]) assert.notEqual((await parse(h,context,response(),status)).statusCode,0);
  assert.notEqual((await parse(h,context,'{broken')).statusCode,0);
  assert.notEqual((await parse(h,context,response(),200,0)).statusCode,0);
  assert.notEqual((await parse(h,context,response(),200,retrievedMs+86400000)).statusCode,0);
  // a plan that is not the canonical plan of its own URL, or no plan at all
  const other=readWxf(context); other.SOURCE_URL='https://other.example/';
  assert.notEqual((await parse(h,writeWxf(other))).statusCode,0);
  const moved=readWxf(context); moved.FIELD_ID='forecast/0,0';
  assert.notEqual((await parse(h,writeWxf(moved))).statusCode,0);
  assert.notEqual((await parse(h,new Uint8Array(0))).statusCode,0);
  // exactly one response per invocation
  const two=await h.invoke({methodId:'parse_forecast',inputs:[httpResponse(context),httpResponse(context)]});
  assert.notEqual(two.statusCode,0); assert.equal(two.outputs.length,0);
  // the producer peer id rides the plan (stamped from node config): none, no records
  const anonymous=readWxf(context); anonymous.PRODUCER_PEER_ID=null;
  assert.notEqual((await parse(h,writeWxf(anonymous))).statusCode,0);
  const wire=h.stub.wire.length; await parse(h,context);
  assert.equal(h.stub.wire.length,wire,'parse_forecast makes no host call');
  const body=response();body.hourly.precipitation[0]=0;const result=await parse(h,context,body);
  assert.equal(result.statusCode,0,result.errorMessage);const row=records(result).find(r=>r.VARIABLE_NAME==='precipitation');
  assert.equal(row.VALUES[0],0);assert.equal(row.MISSING_COUNT,0);
});
