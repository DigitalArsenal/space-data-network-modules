// E2E, stack issue 234: a NOAA 45-day forecast up to 7 days old is accepted and its age is stated in the report; an older
// one, or one that starts after today, is refused by name. Live GFZ and NOAA bodies, the committed signed dist; the forecast's
// dates are shifted (its values kept) to make each age. Every accepted batch equals the independent reading of its sources.
//   node data-source/space-weather/tests/forecast-age.e2e.mjs          (npm ci in data-source/space-weather; PATH holds wasmedge)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {ByteBuffer} from 'flatbuffers';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {encodeTimerTick,decodeHttpRequest,encodeHttpResponse,decodeFlowNotice} from 'space-data-module-sdk/runtime-contracts';
import {verifySources} from './source-oracle.mjs';
import {runtimeParity} from './runtime-parity.mjs';

const DAY=86400000,MONTHS='JanFebMarAprMayJunJulAugSepOctNovDec';
const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url);
const {SPW}=await import(pathToFileURL(path.join(path.dirname(require.resolve('spacedatastandards.org/package.json')),'lib/js/SPW/SPW.js')));
const manifest=JSON.parse(await fs.readFile(path.join(root,'plugin-manifest.json'))),wasmPath=path.join(root,'dist/isomorphic/module.wasm');
const input=(portId,payload,schemaName,fileIdentifier,rootTypeName)=>({portId,payload,typeRef:{schemaName,fileIdentifier,rootTypeName,wireFormat:'flatbuffer',byteLength:payload.length}});
const dayOf=token=>Date.UTC(2000+Number(token.slice(5)),MONTHS.indexOf(token.slice(2,5))/3,Number(token.slice(0,2)));
const tokenOf=ms=>{const d=new Date(ms);return String(d.getUTCDate()).padStart(2,'0')+MONTHS.slice(d.getUTCMonth()*3,d.getUTCMonth()*3+3)+String(d.getUTCFullYear()).slice(2);};
const DATE=/\b\d{2}[A-Z][a-z]{2}\d{2}\b/g;
function rows(bytes){const out=[];for(let at=0;at<bytes.length;){const n=bytes.readUInt32LE(at);assert(n>8&&at+4+n<=bytes.length);out.push(SPW.getSizePrefixedRootAsSPW(new ByteBuffer(bytes.subarray(at,at+4+n))).unpack());at+=4+n;}return out;}

const harness=await createBrowserModuleHarness({wasmSource:await fs.readFile(wasmPath),manifest,surface:'direct'});
const evidence=await fs.mkdtemp(path.join(os.tmpdir(),'space-weather-forecast-age-'));
try{
  assert.equal(manifest.version,'0.3.1');
  const tick=input('tick',encodeTimerTick({triggerId:'forecast-age',firedMs:Date.now()}),'TimerTick.fbs','TICK','TimerTick');
  const planned=await harness.invoke({methodId:'plan_weather',inputs:[tick]});assert.equal(planned.statusCode,0,planned.errorMessage);
  const requests=planned.outputs.filter(o=>o.portId==='request').map(o=>decodeHttpRequest(o.payload)),bodies=[];
  for(const r of requests){const response=await fetch(r.url,{headers:r.headers,signal:AbortSignal.timeout(90000)});assert.equal(response.status,200,r.url);bodies.push(Buffer.from(await response.arrayBuffer()));}
  const FORECAST=requests.findIndex(r=>r.url.endsWith('45-day-forecast.txt')),text=bodies[FORECAST].toString();
  const issuedFirst=dayOf(text.split('\n').find(l=>/^\d{2}[A-Z]/.test(l)).slice(0,7)),retrievedMs=Date.now(),today=Math.floor(retrievedMs/DAY)*DAY;
  // The live forecast with its dates moved so its first day is `age` days before today.
  const aged=age=>Buffer.from(text.replace(DATE,token=>tokenOf(dayOf(token)+(today-age*DAY-issuedFirst))));
  const framesFor=body=>requests.map((r,i)=>input('response',encodeHttpResponse({url:r.url,status:200,body:i===FORECAST?body:bodies[i],retrievedMs}),'HttpResponse.fbs','HRSP','HttpResponse'));
  const parse=body=>harness.invoke({methodId:'parse_weather',inputs:framesFor(body)});
  const todayIso=new Date(today).toISOString().slice(0,10);
  for(const age of [0,1,3,7]){
    const body=aged(age),result=await parse(body);
    assert.equal(result.statusCode,0,`age ${age}: ${result.errorMessage}`);
    const records=Buffer.from(result.outputs.find(o=>o.portId==='records').payload),published=rows(records);
    verifySources(published,bodies.map((b,i)=>i===FORECAST?body:b),todayIso);
    assert.equal(published[0].PROVENANCE.PRODUCER,'space-weather/0.3.1');
    const notice=decodeFlowNotice(result.outputs.find(o=>o.portId==='report').payload);
    assert.ok(notice.items.includes(`noaa-45-day-forecast first-day=${new Date(today-age*DAY).toISOString().slice(0,10)} age-days=${age}`),`age ${age}: the report states it: ${JSON.stringify(notice.items)}`);
    console.log(`PASS forecast ${age} days old accepted: ${published.length} days, its age in the report`);
  }
  for(const [age,why] of [[8,'8 days old'],[-1,'starting tomorrow']]){
    const refused=await parse(aged(age));
    assert.notEqual(refused.statusCode,0,why);assert.match(refused.errorMessage,/Invalid or stale NOAA 45-day forecast/,why);
    assert.ok(!refused.outputs.some(o=>o.portId==='records'),why);
    console.log(`PASS forecast ${why} refused by name, nothing published`);
  }
  await runtimeParity({wasmPath,manifest,evidence,cases:[{methodId:'parse_weather',inputs:framesFor(aged(7))},{methodId:'parse_weather',inputs:framesFor(aged(8))}]});
  console.log('PASS headless browser and native WasmEdge give identical bytes on the 7-day and the refused 8-day forecast');
  console.log('FORECAST-AGE PASS');
}finally{await harness.destroy();await fs.rm(evidence,{recursive:true,force:true});}
process.exit(process.exitCode||0);
