// E2E for modules-space-weather-forecast-horizon-20261023: the lane built from today's real sources reaches
// past the observed data (NOAA's 45-day forecast typed PRD, then NOAA's predicted solar cycle typed PRM, to
// today + 400 days), and FFM flies arcs on exactly those rows.
//
//   node data-source/space-weather/tests/forecast-horizon.e2e.mjs      (from the modules root; needs the network)
//
// It runs the built module (browser harness) over the five live sources, holds every published record to an
// independent reading of the sources (tests/source-oracle.mjs), refuses corrupt or too-short predicted cycles,
// then hands the published rows to the built FFM module: a 7-day and a 30-day arc in low orbit and a
// 365-day arc higher up all fly, and the same rows cut at today + 2 (the horizon before this change) are
// refused with space-weather-out-of-range, so the check can fail. Needs `npm ci` (tools/deps-bundle attach)
// in data-source/space-weather and propagator/ffm.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {ByteBuffer} from 'flatbuffers';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {encodeTimerTick,decodeHttpRequest,encodeHttpResponse,decodeIngestRequest,decodeFlowNotice} from 'space-data-module-sdk/runtime-contracts';
import {verifySources,SOURCE_URLS,AHEAD,PRODUCER} from './source-oracle.mjs';
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('../',import.meta.url)),modules=path.resolve(root,'../..');
const sds=path.dirname(require.resolve('spacedatastandards.org/package.json'));
const {SPW}=await import(pathToFileURL(path.join(sds,'lib/js/SPW/SPW.js')));
const ffmRoot=path.join(modules,'propagator/ffm');
const codec=await import(pathToFileURL(path.join(ffmRoot,'tests/lib/prwCodec.mjs')));
const hash=b=>createHash('sha256').update(b).digest('hex');
const DAY_MS=86400000,dayOf=iso=>Math.floor(Date.parse(iso+'T00:00:00Z')/DAY_MS),isoOf=n=>new Date(n*DAY_MS).toISOString().slice(0,10);
const input=(portId,payload,schemaName,fileIdentifier,rootTypeName)=>({portId,payload,typeRef:{schemaName,fileIdentifier,rootTypeName,wireFormat:'flatbuffer',byteLength:payload.length}});
function decodeRecords(bytes){const rows=[];for(let at=0;at<bytes.length;){const n=bytes.readUInt32LE(at);assert(n>8&&at+4+n<=bytes.length);rows.push(SPW.getSizePrefixedRootAsSPW(new ByteBuffer(bytes.subarray(at,at+4+n))).unpack());at+=4+n;}return rows;}

// Two test objects: a low one (A/m 0.02 m2/kg, 400 km) for the short arcs, a higher one (0.005, 700 km) that outlives a year.
const ORBITS={
 low:{position:[6778.137,0,0],velocity:[0,5.3,5.55],areaM2:20},
 high:{position:[7078.137,0,0],velocity:[0,4.6616,5.8815],areaM2:5},
};
const evidence=await fs.mkdtemp(path.join(root,'tests/evidence-'));
const receipt={status:'RUNNING',startedAt:new Date().toISOString()};
const save=()=>fs.writeFile(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
let harness,ffm;
try {
 await save();
 const wasm=await fs.readFile(path.join(root,'dist/isomorphic/module.wasm')),manifest=JSON.parse(await fs.readFile(path.join(root,'plugin-manifest.json')));
 receipt.moduleSha256=hash(wasm);
 harness=await createBrowserModuleHarness({wasmSource:wasm,manifest,surface:'direct'});
 const retrievedMs=Date.now(),todayIso=new Date(retrievedMs).toISOString().slice(0,10),today=dayOf(todayIso);
 const planned=await harness.invoke({methodId:'plan_weather',inputs:[input('tick',encodeTimerTick({triggerId:'hourly',firedMs:retrievedMs}),'TimerTick.fbs','TICK','TimerTick')]});
 assert.equal(planned.statusCode,0,planned.errorMessage);
 const requests=planned.outputs.filter(o=>o.portId==='request').map(o=>decodeHttpRequest(o.payload));
 assert.deepEqual(requests.map(r=>r.url),SOURCE_URLS,'the five sources, in canonical order');assert(requests.every(r=>r.headers['if-modified-since']));
 const bodies=[],responses=[];
 for(const [i,r] of requests.entries()) {
  const response=await fetch(r.url,{headers:r.headers,signal:AbortSignal.timeout(90000)});assert.equal(response.status,200,r.url);
  const body=Buffer.from(await response.arrayBuffer());bodies.push(body);await fs.writeFile(path.join(evidence,`source-${i}.txt`),body);
  responses.push(input('response',encodeHttpResponse({url:r.url,status:200,body,retrievedMs}),'HttpResponse.fbs','HRSP','HttpResponse'));
 }
 receipt.sources=requests.map((r,i)=>({url:r.url,bytes:bodies[i].length,sha256:hash(bodies[i])}));

 // 1. The published record set equals what the sources imply, and reaches the horizon.
 const result=await harness.invoke({methodId:'parse_weather',inputs:responses});assert.equal(result.statusCode,0,result.errorMessage);
 const rows=decodeRecords(Buffer.from(result.outputs.find(o=>o.portId==='records').payload));
 const summary=verifySources(rows,bodies,todayIso);
 const days=rows.map(r=>dayOf(r.DATE)),lastForecast=dayOf(summary.lastForecast);
 days.forEach((d,i)=>{if(i)assert.equal(d,days[i-1]+1,'consecutive daily rows at '+rows[i].DATE);});
 assert.equal(days.at(-1),today+AHEAD,'the rows end at today + '+AHEAD);assert(days.at(-1)-today>=365,'PRM rows to at least +365 days');
 assert(lastForecast-today>=43,'PRD rows to the end of NOAA\'s 45-day forecast (about +44 days)');
 rows.forEach(r=>{
  const d=dayOf(r.DATE);
  if(d>today)assert.equal(r.F107_DATA_TYPE,d<=lastForecast?2:3,`${r.DATE} is ${d<=lastForecast?'PRD':'PRM'}`);else assert([0,2].includes(r.F107_DATA_TYPE),r.DATE+' observed (or today\'s forecast)');
  // What FFM requires of every row it loads: F10.7 and its 81-day average positive, Ap not negative, eight Kp in 0..9.
  assert(r.F107_OBS>0&&r.F107_OBS_CENTER81>0&&r.AP_AVG>=0,r.DATE+' drivers');
  for(let k=1;k<=8;k++)assert(r['KP'+k]>=0&&r['KP'+k]<=90,`${r.DATE} Kp${k}`);
 });
 const meta=decodeIngestRequest(result.outputs.find(o=>o.portId==='meta').payload);
 // The node's storage.ingest operation bounds these metadata fields (sdn-server hostops StorageIngestParams) and
 // refuses a batch with a longer one: nothing lands and no error reaches the flow.
 const INGEST_MAX_BYTES={schema:64,providerId:128,sourceName:128,batchId:128,sourceUrl:255,contentKeyId:128,sourcePeer:128,license:128,licenseUrl:255,citation:255};
 for(const [field,max] of Object.entries(INGEST_MAX_BYTES)){const value=field==='schema'?meta.schema:meta.tags[field];assert(Buffer.byteLength(String(value??''))<=max,`ingest ${field} fits the node's ${max}-byte field`);}
 assert.match(meta.tags.license,/CC-BY-4.0/);assert.match(meta.tags.citation,/Matzka/);assert.match(meta.tags.citation,/DRAO/);assert.match(meta.tags.citation,/predicted solar cycle/);
 assert.equal(meta.tags.batchId,summary.hash);assert.equal(meta.provenance.parserVersion,PRODUCER);assert.equal(Number(meta.provenance.normalizedCount),rows.length);
 const notice=decodeFlowNotice(result.outputs.find(o=>o.portId==='report').payload);
 assert.deepEqual(notice.items,SOURCE_URLS.map((u,i)=>`${u} sha256=${hash(bodies[i])}`),'every source URL and hash is carried');
 receipt.published={rows:rows.length,first:summary.first,last:summary.last,types:summary.types,lastForecast:summary.lastForecast,climatologyAp:summary.climatology,batchId:summary.hash,recordBytes:result.outputs.find(o=>o.portId==='records').payload.length};await save();
 console.log(`PASS published ${rows.length} days ${summary.first}..${summary.last}: OBS ${summary.types[0]??0}, PRD ${summary.types[2]??0}, PRM ${summary.types[3]??0}; every record equals the independent reading of the sources`);

 // 2. A batch whose horizon cannot be built is refused and publishes nothing.
 const refuse=async(index,body,why)=>{
  const inputs=responses.slice();inputs[index]=input('response',encodeHttpResponse({url:requests[index].url,status:200,body:Buffer.from(body),retrievedMs}),'HttpResponse.fbs','HRSP','HttpResponse');
  const refused=await harness.invoke({methodId:'parse_weather',inputs});assert.notEqual(refused.statusCode,0,why);assert(!refused.outputs.some(o=>o.portId==='records'),why);
  return refused.errorMessage;
 };
 const cut=isoOf(today+200).slice(0,7);
 receipt.refusals={
  emptyCycle:await refuse(4,'[]','an empty predicted cycle'),
  shortCycle:await refuse(4,JSON.stringify(JSON.parse(bodies[4]).filter(e=>e['time-tag']<=cut)),'a predicted cycle that ends before the horizon'),
  corruptGfz:await refuse(0,'truncated','a corrupt GFZ body'),
 };
 assert.match(receipt.refusals.shortCycle,/does not cover/);await save();console.log('PASS predicted cycle empty or ending before the horizon refused; no records published');

 // 3. FFM flies arcs on the published rows, and refuses the rows as they were before this change.
 ffm=await createBrowserModuleHarness({wasmSource:await fs.readFile(path.join(ffmRoot,'dist/isomorphic/module.wasm')),manifest:JSON.parse(await fs.readFile(path.join(ffmRoot,'plugin-manifest.json'))),surface:'direct'});
 const table=subset=>({portId:'space_weather',typeRef:codec.TYPE,payload:codec.encodePrw('SPACE_WEATHER',codec.makeTable('PRWSpaceWeatherTable',{ROWS:subset.map(({PROVENANCE,...fields})=>codec.makeTable('SPW',fields))}))});
 const fly=(orbit,arcDays,subset)=>{
  const jd0=2440587.5+retrievedMs/DAY_MS,o=ORBITS[orbit];
  const params={epochJD:jd0,targetJD:jd0+arcDays,epochTimeScale:'UTC',targetTimeScale:'UTC',position:o.position,velocity:o.velocity,massKg:1000,
   integrator:{method:'RK78',tolerance:1e-9,initialStep:30,minStep:1e-3,maxStep:900,maxSteps:10000000},
   forces:{mu:398600.4418,pointMass:true,j2:true,drag:true,areaM2:o.areaM2,cd:2.2,cr:1.3,massKg:1000,dragModel:'NRLMSISE00'},ephemerisSource:'Analytical'};
  return ffm.invoke({methodId:'invoke',inputs:[{portId:'request',typeRef:codec.TYPE,payload:codec.operationPayload('propagate',params,false)},table(subset)]});
 };
 receipt.ffm=[];
 for(const [orbit,arcDays] of [['low',7],['low',30],['high',365]]) {
  const t0=Date.now(),flown=await fly(orbit,arcDays,rows);assert.equal(flown.statusCode,0,`${arcDays}-day arc: ${flown.errorCode}: ${flown.errorMessage}`);
  const final=codec.decodeResult(flown);assert(Math.abs(final.propagatedDeltaSeconds-arcDays*86400)<1,`${arcDays}-day arc flown to its end`);
  receipt.ffm.push({orbit,arcDays,seconds:(Date.now()-t0)/1000,finalRadiusKm:Math.hypot(...final.position)});await save();
  console.log(`PASS FFM flew a ${arcDays}-day arc (${orbit} orbit) on the published rows in ${((Date.now()-t0)/1000).toFixed(1)} s`);
 }
 const before=await fly('low',7,rows.filter(r=>dayOf(r.DATE)<=today+2));
 assert.notEqual(before.statusCode,0);assert.equal(before.errorCode,'space-weather-out-of-range','the rows cut at today + 2 refuse a 7-day arc');
 receipt.negativeControl={rowsThrough:isoOf(today+2),errorCode:before.errorCode};
 receipt.status='PASS';console.log('PASS the same rows cut at today + 2 (the horizon before this change) are refused: space-weather-out-of-range');
} catch(error){receipt.status='FAIL';receipt.error=error.stack;process.exitCode=1;console.error(error.stack);}
finally{if(harness)await harness.destroy();if(ffm)await ffm.destroy();receipt.completedAt=new Date().toISOString();await save();console.log('Evidence: '+evidence);}
process.exit(process.exitCode||0);
