// Persistent-instance parity complements the SDK's fresh-command parity lanes.
// Identical public PIV requests enter the same resident instance sequentially.
// C++ supplies all physics; this driver compares binary responses and checks
// the published PRW protocol. Numerical oracle checks live in prw_resident.test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {encodePluginInvokeRequest,decodePluginInvokeResponse} from 'space-data-module-sdk/invoke';
import {loadWasmEdgePin,assertWasmEdgeVersionMatchesPin} from 'space-data-module-sdk/testing';
import {residentHarness,packageDir,wasmPath,dockerRunner} from './lib/residentRuntime.mjs';
import {TYPE,makeTable,residentState,instant,coordinateSystem,encodePrw,decodePrw} from './lib/prwCodec.mjs';
const execFile=promisify(execFileCallback);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const wasm=fs.readFileSync(wasmPath),wasmSha=sha(wasm),pin=loadWasmEdgePin();
const inst=(generation=1n)=>makeTable('PRWInstance',{MODULE_ID:'com.orbpro.hpop',INSTANCE_ID:'stateful-parity',GENERATION:generation});
const seed=(id,generation=1n,extra={})=>Object.assign(residentState({epochJD:2451545,position:[7000,0,0],velocity:[0,7.5,1]}),{
  INSTANCE:inst(generation),ENTITY_HANDLE:id,CATALOG_NUMBER:25544,OBJECT_ID:`source-${id}`,...extra,
});
const frame=(port,arm,record)=>({portId:port,typeRef:TYPE,payload:encodePrw(arm,record)});
const req=(method,arm,record)=>({methodId:method,outputStreamCap:1,inputs:[frame(method==='ingest_state'?'state':'request',arm,record)]});
const batch=(generation=1n,ids=[])=>makeTable('PRWResidentRequest',{INSTANCE:inst(generation),TARGET_EPOCH:instant(2451545),ENTITY_HANDLES:ids,TARGET_COORDINATE_SYSTEM:coordinateSystem()});
const prep=()=>makeTable('PRWPrepareRequest',{INSTANCE:inst(),START_EPOCH:instant(2451545),DURATION_SECONDS:600});
const desc=(generation=1n)=>makeTable('PRWDescribeRequest',{INSTANCE:inst(generation),SEGMENT_SET_HANDLE:1});
const step=(label,request,error=null)=>({label,requestBytes:encodePluginInvokeRequest(request),error});
const groups=[{id:'resident-continuation-and-generation',steps:[
  step('ingest-two',{methodId:'ingest_state',inputs:[frame('state','RESIDENT_STATE',seed(31)),frame('state','RESIDENT_STATE',seed(47))]}),
  step('state-chunk-0',req('propagate_state','RESIDENT_REQUEST',batch())),
  step('state-chunk-1',req('propagate_state','RESIDENT_REQUEST',batch())),
  step('prepare',req('prepare_trajectory_segments','PREPARE_REQUEST',prep())),
  step('ppe-chunk-0',req('describe_trajectory_segments','DESCRIBE_REQUEST',desc())),
  step('ppe-chunk-1',req('describe_trajectory_segments','DESCRIBE_REQUEST',desc())),
  step('duplicate',req('propagate_state','RESIDENT_REQUEST',batch(1n,[31,31])),'invalid-request'),
  step('unknown',req('propagate_state','RESIDENT_REQUEST',batch(1n,[999])),'unknown-entity'),
  step('wrong-arm',req('propagate_state','VERSION_QUERY',true),'method-arm-mismatch'),
  step('new-generation',req('ingest_state','RESIDENT_STATE',seed(31,2n))),
  step('stale-generation',req('propagate_state','RESIDENT_REQUEST',batch()),'stale-instance'),
  step('stale-segment',req('describe_trajectory_segments','DESCRIBE_REQUEST',desc(2n)),'stale-handle'),
  step('new-state',req('propagate_state','RESIDENT_REQUEST',batch(2n))),
]},{id:'resident-atomic-rejection',steps:[
  step('ingest',req('ingest_state','RESIDENT_STATE',seed(31))),
  step('unsupported-covariance',req('ingest_state','RESIDENT_STATE',seed(31,2n,{COVARIANCE:makeTable('PRWStateMatrix',{DIMENSION:6,VALUES:Array(36).fill(0)})})),'unsupported-configuration'),
  step('old-generation-survives',req('propagate_state','RESIDENT_REQUEST',batch())),
  step('unsupported-mass',req('ingest_state','RESIDENT_STATE',seed(31,2n,{HAS_MASS_KG:true,MASS_KG:1000})),'unsupported-configuration'),
  step('repeated-generation',req('ingest_state','RESIDENT_STATE',seed(31)),'stale-instance'),
  step('invalid-flag',req('ingest_state','RESIDENT_STATE',seed(31,2n,{VALID:false}))),
  step('invalid-selection',req('propagate_state','RESIDENT_REQUEST',batch(2n)),'invalid-state'),
]}];
async function runProcess(runtime) {
  const results=[];
  for(const group of groups) {
    const h=await residentHarness(runtime);
    try {for(const item of group.steps)results.push(await h.invokeRaw(item.requestBytes));}
    finally {await h.destroy();}
  }
  return results;
}
async function runChrome() {
  const chrome=process.env.SDM_CHROME_BINARY??[
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium',
  ].find(p=>fs.existsSync(p));
  if(!chrome)throw new Error('Real Chrome required; set SDM_CHROME_BINARY.');
  const esbuild=await import('esbuild');
  const source=`import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
const b64=x=>Uint8Array.from(atob(x),c=>c.charCodeAt(0));
const b64out=x=>{let s='';for(const n of x)s+=String.fromCharCode(n);return btoa(s);};
(async()=>{if(!crossOriginIsolated)throw new Error('COOP/COEP isolation missing');
const plan=await(await fetch('/plan')).json(),wasm=new Uint8Array(await(await fetch('/module.wasm')).arrayBuffer());
const results=[];for(const group of plan){const h=await createBrowserModuleHarness({wasmSource:wasm,surface:'direct'});
try{for(const bytes of group)results.push(b64out(await h.invokeRaw(b64(bytes))));}finally{h.destroy();}}
await fetch('/done',{method:'POST',body:JSON.stringify({results})});})().catch(async e=>fetch('/done',{method:'POST',body:JSON.stringify({error:String(e.stack??e)})}));`;
  const {outputFiles}=await esbuild.build({stdin:{contents:source,resolveDir:packageDir,sourcefile:'resident-chrome.mjs'},bundle:true,write:false,format:'esm',platform:'browser',target:['chrome110'],external:['node:*','hd-wallet-wasm'],logLevel:'silent'});
  const plan=JSON.stringify(groups.map(g=>g.steps.map(s=>Buffer.from(s.requestBytes).toString('base64'))));
  let resolveResult,rejectResult;
  const done=new Promise((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
  const server=http.createServer((req,res)=>{
    res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
    if(req.url==='/module.wasm'){res.setHeader('Content-Type','application/wasm');res.end(wasm);}
    else if(req.url==='/runner.js'){res.setHeader('Content-Type','text/javascript');res.end(outputFiles[0].text);}
    else if(req.url==='/plan'){res.setHeader('Content-Type','application/json');res.end(plan);}
    else if(req.url==='/done'){const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{res.end('ok');try{const result=JSON.parse(Buffer.concat(chunks));result.error?rejectResult(new Error(result.error)):resolveResult(result.results.map(b=>Buffer.from(b,'base64')));}catch(e){rejectResult(e);}});}
    else {res.setHeader('Content-Type','text/html');res.end('<!doctype html><script type="module" src="/runner.js"></script>');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'hpop-resident-chrome-'));
  const child=spawn(chrome,['--headless=new','--no-sandbox','--disable-gpu',`--user-data-dir=${profile}`,`http://127.0.0.1:${server.address().port}`],{stdio:['ignore','ignore','pipe']});
  const errors=[];child.stderr.on('data',x=>errors.push(x));child.on('error',rejectResult);
  const timeout=setTimeout(()=>rejectResult(new Error(`Resident Chrome timed out: ${Buffer.concat(errors).toString().slice(-1000)}`)),60000);
  try {return await done;} finally {clearTimeout(timeout);const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(profile,{recursive:true,force:true});}
}
assertWasmEdgeVersionMatchesPin((await execFile(process.env.SDM_WASMEDGE_BINARY??'wasmedge',['--version'])).stdout,pin,'resident native');
const {image}=await dockerRunner();
assertWasmEdgeVersionMatchesPin((await execFile('docker',['run','--rm',image,'--version'])).stdout,pin,'resident container');
const runtimes={};
for(const runtime of ['browser','wasmedge','docker-wasmedge']) {
  runtimes[runtime]=await (runtime==='browser'?runChrome():runProcess(runtime));
  console.log(`resident stateful ${runtime}: ${runtimes[runtime].length} responses`);
}
const steps=groups.flatMap(g=>g.steps.map(s=>({...s,group:g.id})));
const evidence={wasmSha256:wasmSha,wasmBytes:wasm.length,wasmedgeVersion:pin.wasmedgeVersion,dockerImage:image,
  runtimeInstances:'One persistent direct instance per group',groups:groups.length,requests:steps.length,
  runtimes:['real Chrome/V8','native WasmEdge','container WasmEdge'],steps:[],ok:true};
for(let i=0;i<steps.length;i++) {
  const item=steps[i],reference=runtimes.browser[i];
  for(const runtime of ['wasmedge','docker-wasmedge'])assert.deepEqual(Buffer.from(runtimes[runtime][i]),Buffer.from(reference),`${runtime} ${item.group}/${item.label}`);
  const response=decodePluginInvokeResponse(reference);
  if(item.error){assert.notEqual(response.statusCode,0,item.label);assert.equal(response.errorCode,item.error,item.label);assert.equal(response.outputs.length,0);}
  else assert.equal(response.statusCode,0,`${item.label}: ${response.errorMessage}`);
  if(item.label==='state-chunk-0'||item.label==='new-state'||item.label==='old-generation-survives') {
    const state=decodePrw(response.outputs[0].payload).RESIDENT_STATE;
    assert.equal(state.STATE.POSITION.X,7000000);assert.equal(state.STATE.VELOCITY.Y,7500);
  }
  evidence.steps.push({group:item.group,label:item.label,responseSha256:sha(reference),bytes:reference.length,errorCode:response.errorCode,yielded:response.yielded,backlogRemaining:String(response.backlogRemaining)});
}
assert.equal(sha(fs.readFileSync(wasmPath)),wasmSha,'Artifact changed during resident parity run');
fs.mkdirSync(new URL('./evidence/lane13/',import.meta.url),{recursive:true});
fs.writeFileSync(new URL('./evidence/lane13/resident-stateful-parity.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');
console.log(`PASS persistent resident parity: ${steps.length} requests x 3 runtimes, exact bytes/classifications; SHA256=${wasmSha}`);
