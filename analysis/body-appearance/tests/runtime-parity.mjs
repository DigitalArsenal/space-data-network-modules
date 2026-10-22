import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import {firefox} from 'playwright';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {loadModule} from 'space-data-module-sdk/host/isomorphic';
import {encodeRequest} from '../codec.js';
import {rockRequest,craterRequest} from './measurements.mjs';
import {lunarRequest} from './lunar-measurements.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function firefoxBinary() {
  if(process.env.FIREFOX_BINARY)return process.env.FIREFOX_BINARY;
  const expected=firefox.executablePath();
  try {await fs.access(expected);return expected;}catch{}
  // Reuse an existing Playwright Firefox cache; never download or open a
  // windowed browser. Report its actual version so the evidence is explicit.
  const match=expected.match(/^(.*[\\/])(firefox-\d+)([\\/].*)$/);
  if(match) {
    const entries=await fs.readdir(match[1]).catch(()=>[]);
    for(const entry of entries.filter(n=>/^firefox-\d+$/.test(n)).sort((a,b)=>Number(b.slice(8))-Number(a.slice(8)))) {
      const candidate=path.join(match[1],entry)+match[3];
      try {await fs.access(candidate);return candidate;}catch{}
    }
  }
  throw new Error('No cached headless Firefox; set FIREFOX_BINARY to an installed Playwright Firefox.');
}
async function digests(harness,requests) {
  const outputs=[];
  for(const {name,method,values} of requests) {
    const response=await harness.invoke(encodeRequest(method,values));
    assert.equal(response.statusCode,0,`${name}: ${response.errorCode}: ${response.errorMessage}`);
    assert.equal(response.outputs.length,1);
    outputs.push({name,sha256:hash(response.outputs[0].payload),bytes:response.outputs[0].payload.length});
  }
  return outputs;
}
export async function runtimeParity() {
  // Sequential runtimes, one headless Firefox. Never launches Docker/Chrome.
  const requests=[
    {name:'100005 rocks',method:'place',values:rockRequest()},
    {name:'100005 craters',method:'place',values:craterRequest()},
    {name:'repeated rock seed',method:'place',values:rockRequest()},
    {name:'different rock seed',method:'place',values:{...rockRequest(),seed:20261023}},
    {name:'offset northern tile',method:'place',values:{...rockRequest(),level:2,x:2,y:0}},
    {name:'solar rotation',method:'rotate',values:{profile:'magnetic',latitude_rad:.7,longitude_rad:2,epoch_tai_s:0,scene_tai_s:86400}},
    {name:'lunar phase',method:'phase_curve',values:{model:'moon:muinonen2010',phase_rad:[0,.1,.5,1,1.5]}},
    {name:'absolute lunar irradiance',method:'lunar_irradiance',values:lunarRequest()},
    ...['jupiter:heng2021:550nm','saturn:dyudina2016:640nm','saturn:dyudina2016:440nm'].map(model=>({
      name:model+' absolute disk',method:'disk_photometry',values:{model,phase_rad:[0,.1,.5,1,2],
        radius_m:1000,sun_distance_au:2,observer_distance_m:1e8,solar_magnitude:0}})),
    {name:'cited asteroid table',method:'parameters',values:{model:'asteroid:S'}},
  ];
  const wasmPath=path.join(root,'dist/isomorphic/module.wasm'),bytes=await fs.readFile(wasmPath),artifactSha256=hash(bytes);
  const node=await createBrowserModuleHarness({wasmSource:bytes,surface:'direct'});
  let expected;
  try {expected=await digests(node,requests);} finally {await node.destroy();}
  assert.equal(expected[0].sha256,expected[2].sha256,'same seed must reproduce all bytes');
  assert.notEqual(expected[0].sha256,expected[3].sha256,'different seed must change instances');
  const wasmEdgeBinary=process.env.WASMEDGE_BINARY || path.join(os.homedir(),'.wasmedge/bin/wasmedge');
  const native=await loadModule({wasmSource:wasmPath,runtimeKind:'wasmedge',wasmEdgeBinary});
  let nativeOutputs;
  try {nativeOutputs=await digests(native,requests);} finally {await native.destroy();}
  assert.deepEqual(nativeOutputs,expected,'native WasmEdge payload bytes');
  const scratch=path.join(root,'.build');await fs.mkdir(scratch,{recursive:true});
  const bundle=path.join(scratch,'browser-parity.js');
  await build({entryPoints:[path.join(root,'tests/browser-parity.mjs')],outfile:bundle,bundle:true,platform:'browser',format:'esm',logLevel:'silent'});
  const bundleBytes=await fs.readFile(bundle),errors=[];
  const server=http.createServer((req,res)=>{
    if(req.url==='/module.wasm'){res.setHeader('Content-Type','application/wasm');res.end(bytes);}
    else if(req.url==='/test.js'){res.setHeader('Content-Type','application/javascript');res.end(bundleBytes);}
    else if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Body appearance parity</title><script type="module" src="/test.js"></script>');}
    else {res.statusCode=404;res.end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  let browser,browserReport,browserVersion;
  try {
    // Redirect Playwright profiles to ignored worktree scratch, not /tmp.
    const previousTemp=process.env.TMPDIR;process.env.TMPDIR=scratch;
    try {browser=await firefox.launch({headless:true,executablePath:await firefoxBinary()});}
    finally {if(previousTemp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previousTemp;}
    browserVersion=browser.version();
    const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(()=>typeof window.runAppearanceParity==='function');
    browserReport=await page.evaluate(requests=>window.runAppearanceParity(requests),requests);
    assert.deepEqual(errors,[],'headless browser exceptions');
  } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
  assert.equal(browserReport.artifactSha256,artifactSha256,'unchanged browser artifact');
  assert.deepEqual(browserReport.outputs,expected,'headless Firefox payload bytes');
  return {status:'pass',artifactSha256,node:process.version,firefox:browserVersion,
    wasmedge:execFileSync(wasmEdgeBinary,['--version'],{encoding:'utf8'}).split('\n')[0],
    comparison:'exact SHA-256 equality of complete typed result payloads',outputs:expected,
    docker:{status:'waived',authority:'Owner 2026-10-22: never start Docker or Docker Desktop'}};
}
