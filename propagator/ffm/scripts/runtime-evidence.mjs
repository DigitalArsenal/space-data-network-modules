// Independent numerical parity and browser memory evidence for the one module.
// JavaScript only encodes SDS records, transports bytes and compares outputs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { encodePluginInvokeRequest, decodePluginInvokeResponse } from 'space-data-module-sdk/invoke';
import { packageRoot } from './paths.mjs';
import * as catalog from '../catalog.mjs';
import { environmentInputs, isoAfter } from '../tests/lib/fullForce.mjs';
import { makeTable, encodePrw, decodePrw, coordinateSystem, TYPE } from '../tests/lib/prwCodec.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file));
const seeds = read(path.join(packageRoot, 'tests/fixtures/seeds.json'));
const pin = read(path.join(packageRoot, 'tests/fixtures/standard.json'));
const port = (portId, arm, value) => ({ portId, typeRef: TYPE, payload: encodePrw(arm, value) });
const instance = makeTable('PRWInstance', { MODULE_ID: catalog.MODULE_ID, INSTANCE_ID: 'ffm-runtime-evidence', GENERATION: 1n });
function ingest(count) {
  const inputs = Array.from({ length: count }, (_, i) => {
    const seed = seeds[i % seeds.length];
    return port('state', 'RESIDENT_STATE', catalog.residentState({ instanceId: instance.INSTANCE_ID,
      handle: i + 1, catalogNumber: i + 1, objectId: `evidence-${i + 1}`, epoch: pin.fixtureEpochUtc,
      state: [...seed.position, ...seed.velocity].map(v => v * 1000), cdAm: seed.cdAm, crAm: seed.crAm }));
  });
  const seed = seeds[0];
  inputs.push(port('configuration', 'EXECUTION_REQUEST', catalog.fullForceRequest({ epoch: pin.fixtureEpochUtc,
    state: [...seed.position, ...seed.velocity].map(v => v * 1000) })), ...environmentInputs());
  return encodePluginInvokeRequest({ methodId: 'ingest_state', inputs });
}
function prepare(count, durationSeconds = 86400) {
  return encodePluginInvokeRequest({ methodId: 'prepare_trajectory_segments', outputStreamCap: 100,
    inputs: [port('request', 'PREPARE_REQUEST', makeTable('PRWPrepareRequest', { INSTANCE: instance,
      SOURCE_HANDLES: Array.from({length:count}, (_, i) => i + 1), START_EPOCH: catalog.instant(pin.fixtureEpochTt, 'TT'),
      DURATION_SECONDS: durationSeconds, PROFILE: 'conjunction-screening' }))] });
}
function state(seconds, handle) {
  return encodePluginInvokeRequest({ methodId: 'propagate_state', outputStreamCap: 100,
    inputs: [port('request', 'RESIDENT_REQUEST', makeTable('PRWResidentRequest', { INSTANCE: instance,
      TARGET_EPOCH: catalog.instant(isoAfter(pin.fixtureEpochTt, seconds), 'TT'),
      ENTITY_HANDLES: [handle], TARGET_COORDINATE_SYSTEM: coordinateSystem() }))] });
}
function frame(bytes) { const length = Buffer.alloc(4); length.writeUInt32LE(bytes.length); return Buffer.concat([length,bytes]); }
function responses(bytes) {
  const output=[];
  for(let at=0;at<bytes.length;) { const n=bytes.readUInt32LE(at); assert(n>0&&at+4+n<=bytes.length); output.push(bytes.subarray(at+4,at+4+n));at+=4+n; }
  return output;
}
async function processBytes(command,args,input,cwd) {
  return new Promise((resolve,reject) => {
    const child=spawn(command,args,{cwd,stdio:['pipe','pipe','pipe']}); const out=[],err=[];
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(`${command} timed out`));},600000);
    child.stdout.on('data',b=>out.push(b));child.stderr.on('data',b=>err.push(b));
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{clearTimeout(timer);code===0?resolve(Buffer.concat(out)):reject(new Error(`${command}: ${code}: ${Buffer.concat(err)}`));});
    child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}
function memoryLimits(bytes) {
  let at=8;
  const uleb=()=>{let value=0,shift=0,byte;do{byte=bytes[at++];value+=(byte&127)*2**shift;shift+=7;}while(byte&128);return value;};
  while(at<bytes.length){const section=bytes[at++],size=uleb(),end=at+size;
    if(section===5){assert.equal(uleb(),1);const flags=uleb(),initial=uleb(),maximum=flags&1?uleb():null;
      return {initialBytes:initial*65536,maximumBytes:maximum===null?null:maximum*65536,shared:Boolean(flags&2)};}at=end;}
  throw new Error('Expected one defined WASM memory');
}
export async function runtimeEvidence({ output } = {}) {
  const work=path.join(packageRoot,'.sdk-build/runtime-evidence');fs.mkdirSync(work,{recursive:true});
  const wasmPath=path.join(packageRoot,'dist/isomorphic/module.wasm'),wasm=fs.readFileSync(wasmPath);
  const nativeRoot=process.env.WASMEDGE_ROOT ?? path.join(os.homedir(),'.wasmedge');
  const source=path.join(packageRoot,'tests/runtime/resident-runner.c'),native=path.join(work,'native-runner');
  execFileSync('cc',['-O2',source,`-I${nativeRoot}/include`,`-L${nativeRoot}/lib`,'-lwasmedge',`-Wl,-rpath,${nativeRoot}/lib`,'-o',native]);
  const image=process.env.FFM_DOCKER_IMAGE ?? 'space-data-module-sdk/parity-wasmedge:0.16.4';
  const dockerImage=execFileSync('docker',['image','inspect',image,'--format','{{.Id}}'],{encoding:'utf8'}).trim();
  fs.copyFileSync(source,path.join(work,'resident-runner.c'));fs.copyFileSync(wasmPath,path.join(work,'module.wasm'));
  execFileSync('docker',['run','--rm','--entrypoint','cc','-v',`${work}:/work`,image,'-O2','/work/resident-runner.c',
    '-I/opt/wasmedge/include','-L/opt/wasmedge/lib64','-lwasmedge','-Wl,-rpath,/opt/wasmedge/lib64','-o','/work/docker-runner']);
  const requests=[ingest(8),... [0,60,3600,7200,-60].flatMap(seconds=>seeds.map((_,i)=>state(seconds,i+1))),prepare(8,7200)];
  const input=Buffer.concat(requests.map(frame));fs.writeFileSync(path.join(work,'inputs.piv'),input);
  const nativeOutput=await processBytes(native,[wasmPath],input,work);
  const dockerOutput=await processBytes('docker',['run','--rm','-i','--entrypoint','/work/docker-runner','-v',`${work}:/work:ro`,image,'/work/module.wasm'],input,work);
  const browserEntry=path.join(work,'browser-entry.mjs');
  const sdkRequire=createRequire(path.join(packageRoot,'package.json'));
  const sdkBrowser=sdkRequire.resolve('space-data-module-sdk/host/browser-module');
  fs.writeFileSync(browserEntry,`import { createBrowserModuleHarness } from ${JSON.stringify(sdkBrowser)};
window.runEvidence=async function() {
  if(!crossOriginIsolated || typeof SharedArrayBuffer==='undefined')throw new Error('Browser is not isolated');
  const wasm=new Uint8Array(await (await fetch('/module.wasm')).arrayBuffer());
  const unpack=b=>{const out=[];for(let i=0;i<b.length;){const n=new DataView(b.buffer,b.byteOffset+i,4).getUint32(0,true);out.push(b.slice(i+4,i+4+n));i+=4+n;}return out;};
  const result={isolated:crossOriginIsolated,states:[],phone:{}};
  for(const kind of ['parity','phone']) {
    const requests=unpack(new Uint8Array(await (await fetch('/'+kind+'.piv')).arrayBuffer()));
    const h=await createBrowserModuleHarness({wasmSource:wasm,surface:'direct'});let peak=h.instance.exports.memory.buffer.byteLength;
    try {const chunks=[];for(const request of requests){const response=await h.invokeRaw(request);chunks.push(Array.from(response));peak=Math.max(peak,h.instance.exports.memory.buffer.byteLength);}
      if(kind==='parity')result.states=chunks;else result.phone={objects:100,days:1,peakLinearMemoryBytes:peak,responses:chunks};
    } finally {await h.destroy();}
  } return result;
};`);
  await build({entryPoints:[browserEntry],outfile:path.join(work,'browser.js'),bundle:true,platform:'browser',format:'esm',logLevel:'silent'});
  const phoneInput=Buffer.concat([ingest(100),prepare(100)].map(frame));
  const files={'/module.wasm':wasm,'/parity.piv':input,'/phone.piv':phoneInput,'/browser.js':fs.readFileSync(path.join(work,'browser.js')),
    '/':Buffer.from('<!doctype html><script type="module" src="/browser.js"></script>')};
  const server=http.createServer((req,res)=>{res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
    res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':req.url==='/'?'text/html':'application/octet-stream');res.statusCode=files[req.url]?200:404;res.end(files[req.url]??'missing');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser,browserResult;
  try {
    const playwrightRequire=process.env.FFM_PLAYWRIGHT_ROOT?createRequire(path.join(process.env.FFM_PLAYWRIGHT_ROOT,'package.json')):sdkRequire;
    const {chromium}=playwrightRequire('playwright');
    const executablePath=process.env.SDM_CHROME_BINARY;
    assert(executablePath?.includes('/chromium_headless_shell-'),'Set SDM_CHROME_BINARY to the Playwright chromium headless shell');
    browser=await chromium.launch({executablePath,headless:true});const page=await browser.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>typeof window.runEvidence==='function');
    browserResult=await page.evaluate(()=>window.runEvidence());assert.deepEqual(errors,[]);
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
  const browserOutput=Buffer.concat(browserResult.states.map(b=>frame(Buffer.from(b))));
  const outputs={browser:browserOutput,native:nativeOutput,docker:dockerOutput};
  fs.writeFileSync(path.join(work,'browser-evidence.json'),JSON.stringify(browserResult));
  for(const [lane,bytes] of Object.entries(outputs))fs.writeFileSync(path.join(work,`${lane}.piv`),bytes);
  let stateCount=0;
  for(const [lane,bytes] of Object.entries(outputs)) {
    const decoded=responses(bytes);assert.equal(decoded.length,requests.length,`${lane} response count`);
    for(const bytes of decoded){const r=decodePluginInvokeResponse(Uint8Array.from(bytes));assert.equal(r.statusCode,0,`${lane}: ${r.errorMessage}`);assert(!r.yielded);
      for(const o of r.outputs){const s=decodePrw(o.payload).RESIDENT_STATE?.STATE;if(s){for(const v of [s.POSITION,s.VELOCITY])for(const axis of ['X','Y','Z'])assert(Number.isFinite(v[axis]));if(lane==='browser')++stateCount;}}}
    fs.writeFileSync(path.join(work,`${lane}.piv`),bytes);
  }
  for(const bytes of browserResult.phone.responses){const r=decodePluginInvokeResponse(Uint8Array.from(bytes));assert.equal(r.statusCode,0,r.errorMessage);assert(!r.yielded);}
  const prepared=decodePluginInvokeResponse(Uint8Array.from(browserResult.phone.responses.at(-1)));
  assert.equal(decodePrw(prepared.outputs[0].payload).PREPARE_RESULT.COVERAGE_COMPLETE,true);
  delete browserResult.phone.responses;
  const result={ok:browserOutput.equals(nativeOutput)&&browserOutput.equals(dockerOutput),wasmSha256:sha(wasm),inputSha256:sha(input),
    parityObjects:8, parityDurationSeconds:7200, outputSha256:Object.fromEntries(Object.entries(outputs).map(([k,v])=>[k,sha(v)])),stateCount,comparison:'entire PIV response stream, bitwise; zero ULP',
    runtime:'WasmEdge 0.16.4 (checked by each native host)',dockerImage,browserIsolated:browserResult.isolated,phone:{...browserResult.phone,...memoryLimits(wasm)}};
  if(output)fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
  assert(result.ok,`FFM numerical runtime divergence: ${JSON.stringify(result)}`);return result;
}
if(process.argv[1]===fileURLToPath(import.meta.url))runtimeEvidence({output:process.argv[2]}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e);process.exitCode=1;});
