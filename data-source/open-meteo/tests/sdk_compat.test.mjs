import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL,fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { validateArtifactWithStandards } from 'space-data-module-sdk/compliance';
import { config,receipt,response,http,input } from './fixture.mjs';

const root=process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const require=createRequire(path.join(root,'package.json'));
const {ByteBuffer}=require('flatbuffers');
const {WXF,wxfTimeBasis,wxfLicenseClass,wxfMemberKind,wxfTemporalKind}=await import(pathToFileURL(path.join(root,'lib/js/WXF/main.js')));
const wasmPath=fileURLToPath(new URL('../dist/isomorphic/module.wasm',import.meta.url));
const manifest=JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json',import.meta.url)));
const wasm=fs.readFileSync(wasmPath);
const jsonOutput=(result,port)=>JSON.parse(Buffer.from(result.outputs.find(f=>f.portId===port).payload).toString());
async function harness(t) { const h=await createBrowserModuleHarness({wasmSource:wasm,manifest,surface:'direct'}); t.after(()=>h.destroy()); return h; }
async function plan(h,value=config) {
  return h.invoke({methodId:'plan_forecast',inputs:[input('config',value)]});
}
async function parse(h,job,body=response(),receiptValue=receipt,status=200,extra=[]) {
  return h.invoke({methodId:'parse_forecast',inputs:[input('job',job),input('response',http(body,status)),input('receipt',receiptValue),...extra]});
}
function records(result) {
  const bytes=result.outputs.find(f=>f.portId==='records').payload, rows=[];
  for(let offset=0;offset<bytes.length;) {
    const size=new DataView(bytes.buffer,bytes.byteOffset+offset,4).getUint32(0,true)+4;
    assert.ok(size>=12 && offset+size<=bytes.length);
    const frame=bytes.slice(offset,offset+size);
    assert.equal(Buffer.from(frame.slice(8,12)).toString(),'$WXF');
    rows.push(WXF.getSizePrefixedRootAsWXF(new ByteBuffer(frame)).unpack()); offset+=size;
  }
  return rows;
}
test('the actual artifact satisfies the SDK contract',async()=> {
  const report=await validateArtifactWithStandards({wasmPath,manifest,standardsRoot:root});
  assert.equal(report.ok,true,JSON.stringify(report.issues));
});
test('requests explicit units and UTC without credentials in attribution',async t=> {
  const h=await harness(t), result=await plan(h);
  assert.equal(result.statusCode,0,result.errorMessage);
  const request=jsonOutput(result,'request'),job=jsonOutput(result,'job'),url=new URL(request.url);
  assert.equal(url.hostname,'api.open-meteo.com');
  assert.equal(url.searchParams.get('timeformat'),'unixtime'); assert.equal(url.searchParams.get('timezone'),'GMT');
  assert.equal(url.searchParams.get('wind_speed_unit'),'ms'); assert.equal(url.searchParams.get('temperature_unit'),'celsius');
  assert.equal(job.source_url,request.url); assert.equal(request.responseWire,'raw-body-v1');
  const paid=await plan(h,{...config,access:'customer'});
  assert.equal(new URL(jsonOutput(paid,'request').url).hostname,'customer-api.open-meteo.com');
  assert.ok(!JSON.stringify([jsonOutput(paid,'request'),jsonOutput(paid,'job')]).includes('apikey'));
});
test('normalizes the documented weather units, UTC epochs, licence and missing values',async t=> {
  const h=await harness(t), job=jsonOutput(await plan(h),'job'),result=await parse(h,job);
  assert.equal(result.statusCode,0,result.errorMessage);
  const rows=records(result); assert.equal(rows.length,192);
  // SI conversions are exact definitions; 5e-5 accommodates float32 storage
  // near 286 K. Pressure values are exactly representable at this magnitude.
  const expected={temperature_2m:[286.15,'K'],dew_point_2m:[273.15,'K'],relative_humidity_2m:[.5,'1'],cloud_cover:[.75,'1'],wind_speed_10m:[10,'m/s'],pressure_msl:[101325,'Pa'],surface_pressure:[90000,'Pa'],precipitation:[.0025,'m']};
  for(const [variable,[value,units]] of Object.entries(expected)) {
    const record=rows.find(r=>r.VARIABLE_NAME===variable);
    assert.ok(Math.abs(record.VALUES[0]-value)<5e-5,variable); assert.equal(record.UNITS,units);
    assert.equal(record.TIME_BASIS,wxfTimeBasis.ValidTimeOnly); assert.equal(record.INIT_TIME_MS,0n);
    assert.equal(record.MEMBER_KIND,wxfMemberKind.Unspecified); assert.equal(record.LEAD_HOURS,0);
    assert.equal(record.VALID_TIME_MS,1656633600000n); assert.equal(record.RETRIEVED_AT,BigInt(receipt.retrieved_at_ms));
    assert.equal(record.LICENSE_CLASS,wxfLicenseClass.OpenAttribution); assert.equal(record.PRODUCER_PEER_ID,receipt.producer_peer_id);
    assert.equal(record.SOURCE_URL,job.source_url); assert.match(record.CITATION,/Open-Meteo/);
    assert.equal(record.GRID.NLAT,1); assert.equal(record.GRID.NLON,1); assert.equal(record.GRID.LON0,13.419);
  }
  const missing=rows.find(r=>r.VARIABLE_NAME==='temperature_2m' && r.VALID_TIME_MS===1656640800000n);
  assert.ok(Number.isNaN(missing.VALUES[0])); assert.ok(Number.isNaN(missing.VALUE_MIN)); assert.equal(missing.MISSING_COUNT,1);
  const rain=rows.find(r=>r.VARIABLE_NAME==='precipitation'); assert.equal(rain.TEMPORAL_KIND,wxfTemporalKind.Accumulated); assert.equal(rain.ACCUMULATION_HOURS,1);
  assert.deepEqual(jsonOutput(result,'report'),{records:192,missing:1,retrieved_at_ms:receipt.retrieved_at_ms});
  assert.equal(jsonOutput(result,'meta').reconcile,'current');
});
test('rejects invalid configuration and recovers on the same instance',async t=> {
  const h=await harness(t);
  for(const value of [null,{}, {...config,access:''},{...config,latitude:91},{...config,longitude:'13'},
    {...config,forecast_days:1.5},{...config,forecast_days:100000000000},
    {...config,variables:['temperature_2m','temperature_2m']},{...config,variables:['invented']},{...config,variables:[3]}]) {
    const result=await plan(h,value);assert.notEqual(result.statusCode,0);assert.equal(result.outputs.length,0);
  }
  assert.equal((await plan(h)).statusCode,0);
});
test('rejects partial or wrong-unit responses atomically and preserves legitimate zero values',async t=> {
  const h=await harness(t),job=jsonOutput(await plan(h),'job');
  const bad=[body=>body.hourly.time.pop(),body=>body.hourly.precipitation.pop(),body=>body.hourly.time[1]++,
    body=>body.hourly_units.temperature_2m='°F',body=>body.utc_offset_seconds=3600,
    body=>body.hourly.cloud_cover[23]=101,body=>body.hourly.temperature_2m[23]='missing',
    body=>delete body.hourly_units,body=>delete body.latitude];
  for(const mutate of bad) { const body=response();mutate(body);const result=await parse(h,job,body);assert.notEqual(result.statusCode,0);assert.equal(result.outputs.length,0); }
  for(const status of [429,500,503]) assert.notEqual((await parse(h,job,response(),receipt,status)).statusCode,0);
  assert.notEqual((await parse(h,job,'{broken')).statusCode,0);
  assert.notEqual((await parse(h,job,response(),{...receipt,retrieved_at_ms:0})).statusCode,0);
  assert.notEqual((await parse(h,job,response(),{...receipt,retrieved_at_ms:receipt.retrieved_at_ms+86400000})).statusCode,0);
  assert.notEqual((await parse(h,{...job,source_url:'https://other.example/'})).statusCode,0);
  assert.notEqual((await parse(h,job,response(),receipt,200,[input('job',job)])).statusCode,0);
  const body=response();body.hourly.precipitation[0]=0;const result=await parse(h,job,body);
  assert.equal(result.statusCode,0,result.errorMessage);const row=records(result).find(r=>r.VARIABLE_NAME==='precipitation');
  assert.equal(row.VALUES[0],0);assert.equal(row.MISSING_COUNT,0);
});
