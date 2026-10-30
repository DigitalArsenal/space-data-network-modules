#!/usr/bin/env node
// Memory/accounting orchestration only: all dynamics, frames and polynomial
// evaluation execute in the exact same FFM artifact in both runtimes.
// Gate (default): measure and compare with tests/evidence/memory-sizing.json. --measure: measure only (the evidence
// is the run's .sdk-build/memory-sizing/<artifact sha256>/result.json). --full: the gate plus e2e-ffm and e2e-catalog-coverage.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { analyzeWasmThreadFeatures } from 'space-data-module-sdk/compiler';
import { headlessShell } from '../tests/lib/headlessShell.mjs';
import { environmentInputs } from '../tests/lib/fullForce.mjs';
import { makeTable, encodePrw, decodePrw, sds, TYPE } from '../tests/lib/prwCodec.mjs';
import { encodePluginInvokeRequest, decodePluginInvokeResponse } from 'space-data-module-sdk/invoke';
import * as catalog from '../catalog.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const read = p => JSON.parse(fs.readFileSync(path.join(root, p)));
const sha = b => createHash('sha256').update(b).digest('hex');
const wasmPath = path.join(root, 'dist/isomorphic/module.wasm'), wasm = fs.readFileSync(wasmPath);
const cache = path.join(root, '.sdk-build/memory-sizing', sha(wasm)); fs.mkdirSync(cache, { recursive: true });
const seeds = read('tests/fixtures/seeds.json'), standard = read('tests/fixtures/standard.json');
const epoch = Date.parse(standard.fixtureEpochUtc + 'Z') / 86400000 + 2440587.5;
const manifest = read('plugin-manifest.json'), environment = environmentInputs();
const configuration = encodePrw('EXECUTION_REQUEST', catalog.fullForceRequest({ epoch: standard.fixtureEpochUtc,
  state: [...seeds[0].position, ...seeds[0].velocity].map(x => x * 1000) }));
const frames = [configuration, ...environment.map(x => x.payload)];
const instance = makeTable('PRWInstance', { MODULE_ID: manifest.pluginId, INSTANCE_ID: 'memory-focus', GENERATION: 1n });
const port = (portId, arm, value) => ({ portId, typeRef: TYPE, payload: encodePrw(arm, value) });
const focusRequests = [encodePluginInvokeRequest({ methodId: 'ingest_state', inputs: [
  port('state', 'RESIDENT_STATE', catalog.residentState({ instanceId: instance.INSTANCE_ID, handle: seeds[0].handle,
    epoch: standard.fixtureEpochUtc, state: [...seeds[0].position, ...seeds[0].velocity].map(x => x * 1000), cdAm: seeds[0].cdAm, crAm: .02 })),
  { portId: 'configuration', typeRef: TYPE, payload: configuration }, ...environment] }),
  ...[1800, 3600].map(seconds => encodePluginInvokeRequest({ methodId: 'propagate_state', inputs: [port('request', 'RESIDENT_REQUEST',
    makeTable('PRWResidentRequest', { INSTANCE: instance, ENTITY_HANDLES: [seeds[0].handle], TARGET_COORDINATE_SYSTEM: catalog.gcrf(),
      TARGET_EPOCH: makeTable('TIMInstant', { TIME_SYSTEM: sds.timingStandard.UTC, EPOCH_FORMAT: sds.timEpochRepresentation.JULIAN_DATE, JULIAN_DATE: epoch + seconds / 86400 }) }))] }))];
// The predecessor is the last accepted artifact (5746b0f5 built 343c4145, FFM 2.0.1); a change is checked against it.
const predecessor = execFileSync('git', ['show', '5746b0f53504d4d8a83c4ec7921f4a34b85901a6:propagator/ffm/dist/isomorphic/module.wasm'], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
fs.writeFileSync(path.join(cache, '../previous.wasm'), predecessor);
// The browser pool's own coverage window: the defaults of OrbPro
// packages/orbpro-integration/propagator.ffm at main 7ad42e4e1c
// (createFfmFrameWorkerPool: retentionDays 0.02, lookaheadSec 120, ensureChunk 64;
// ffmFrameWorker.js: grid stagger on, plugin_set_ephemeris_retention before the
// seed, ensure chunks of simStart + lookahead, then of clock + lookahead every loop).
// Each role seeds like a pool shard, then the clock advances one 300 s segment
// at a time until the retained window (retention + lookahead) has filled and
// been pruned, so the high-water is the pool's steady state, not its seeded one.
const pool = { retentionDays: 0.02, lookaheadSeconds: 120, ensureChunk: 64, gridStagger: true, segmentSeconds: 300 };
pool.retentionSeconds = pool.retentionDays * 86400;
pool.steps = Array.from({ length: Math.ceil((pool.retentionSeconds + pool.lookaheadSeconds) / pool.segmentSeconds) + 2 }, (_, i) => i * pool.segmentSeconds);
// What the pool's own E2E read from a seeded shard (orbpro-ffm-pool-ffm1-fast-20261022,
// OrbPro 5c14cb5d7b): the full catalog's heap, 323.4-325.4 MB.
const poolLane = { task: 'orbpro-ffm-pool-ffm1-fast-20261022', orbproCommit: '5c14cb5d7b', entities: 31814, heapBytes: [323.4e6, 325.4e6], tolerance: .05 };
const report = { artifactSha256: sha(wasm), previousArtifactSha256: sha(fs.readFileSync(path.join(cache, '../previous.wasm'))),
  memory: read('dist/build-provenance.json').memory, profile: 'FFM-1', retentionSeconds: pool.retentionSeconds, lookaheadSeconds: pool.lookaheadSeconds,
  pool: { source: 'OrbPro packages/orbpro-integration/propagator.ffm @ 7ad42e4e1c: ffmFrameWorkerPool.js defaults, ffmFrameWorker.js init and loop', retentionDays: pool.retentionDays,
    lookaheadSeconds: pool.lookaheadSeconds, ensureChunk: pool.ensureChunk, gridStagger: pool.gridStagger, segmentSeconds: pool.segmentSeconds },
  sampleEpochsSeconds: pool.steps, fixture: 'public study SGP4 seeds, repeated cyclically across all eight orbit regimes',
  metric: 'WebAssembly linear-memory page high-water; 65536 bytes/page; includes static data, stack and allocator; excludes host RSS and reserved maximum',
  rows: [], loadStart: os.loadavg(), logicalCpus: os.cpus().length,
  docker: 'WAIVED by owner 2026-10-22: do not start Docker' };
const predecessorExports = WebAssembly.Module.exports(await WebAssembly.compile(predecessor));
const currentExports = WebAssembly.Module.exports(await WebAssembly.compile(wasm));
assert.deepEqual(currentExports, predecessorExports, 'existing exports changed');
assert(currentExports.some(e => e.name === 'plugin_catalog_drag_acceleration' && e.kind === 'function'), 'missing configured-drag diagnostic');
const memorySection = analyzeWasmThreadFeatures(wasm).sharedMemory;
assert(memorySection?.growable);
assert.equal(memorySection.min*65536, report.memory.initialBytes);
assert.equal(memorySection.max*65536, report.memory.maximumBytes);
report.memory.wasmSection = memorySection;
const save = () => fs.writeFileSync(path.join(cache, 'result.json'), JSON.stringify(report, null, 2) + '\n');
// Compile through the actual node's production flow prewarmer into a private
// cache. The node keys each compiled flow by the exact artifact hash.
const nodeBinary = process.env.SDN_NODE_BINARY || 'spacedatanetwork';
const aotDir = path.join(root, '.sdk-build/memory-sizing/aot');
// The prewarm runs beside the setup and the browser roles; only the native roles wait for it.
const aotReady = execFileAsync(nodeBinary, ['prewarm-aot', '--cache-dir', aotDir, '--flow', wasmPath], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).then(({ stdout: aotLog }) => {
  fs.writeFileSync(path.join(cache, 'prewarm-aot.log'), aotLog);
  assert(!/FAILED|Not implemented instructions/.test(aotLog));
  report.aot = { status: 'PASS', command: 'spacedatanetwork prewarm-aot --cache-dir <private> --flow dist/isomorphic/module.wasm', artifactSha256: report.artifactSha256,
    nodeBinarySha256: sha(fs.readFileSync(path.isAbsolute(nodeBinary) ? nodeBinary : execFileSync('/usr/bin/which', [nodeBinary], { encoding: 'utf8' }).trim())), log: aotLog.trim() }; save();
  const aotPath = aotLog.split('\n').find(line => line.startsWith(`  flow ${wasmPath}: `))?.slice(`  flow ${wasmPath}: `.length).replace(/ \((?:compiled|already present)\)$/, '');
  assert(aotPath && fs.existsSync(aotPath), 'prewarm produced no flow AOT artifact');
  return aotPath;
});
// Start the largest role first. Two independent instances per runtime keep
// the entire E2E within the graph command budget without changing any role.
async function runRoles(run) {
  const queue=[31814,1,1000,4000,10000];
  const worker=async()=>{while(queue.length)await run(queue.shift());};
  await Promise.all([worker(),worker()]);
}
// e2e-ffm and e2e-catalog-coverage are E2Es of their own; they run here only under --full.
const regressionWork=process.argv.includes('--full')&&!process.argv.includes('--measure')?Promise.all(
  ['e2e-ffm.mjs','e2e-catalog-coverage.mjs'].map(async script=>{
    try {
      const {stdout,stderr}=await execFileAsync(process.execPath,[path.join(root,'scripts',script)],{cwd:root,maxBuffer:32*1024*1024});
      fs.writeFileSync(path.join(cache,script+'.log'),stdout+stderr);
      return script;
    } catch(error) {
      fs.writeFileSync(path.join(cache,script+'.log'),(error.stdout||'')+(error.stderr||''));
      throw error;
    }
  })).then(scripts=>({scripts}),error=>({error})):null;
const nativeSource = String.raw`
#include <wasmedge/wasmedge.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static WasmEdge_VMContext *vm;
static WasmEdge_MemoryInstanceContext *mem;
static void ok(WasmEdge_Result r) { if (!WasmEdge_ResultOK(r)) { fprintf(stderr,"%s\n",WasmEdge_ResultGetMessage(r)); exit(1); } }
static int32_t call(const char *name,WasmEdge_Value *args,int argc,int result) {
 WasmEdge_String n=WasmEdge_StringCreateByCString(name); WasmEdge_Value value;
 ok(WasmEdge_VMExecute(vm,n,args,argc,result?&value:NULL,result)); WasmEdge_StringDelete(n);
 return result?WasmEdge_ValueGetI32(value):0;
}
#define I(x) WasmEdge_ValueGenI32((int32_t)(x))
#define D(x) WasmEdge_ValueGenF64(x)
static uint32_t alloc(uint32_t n) { WasmEdge_Value a[]={I(n)}; uint32_t p=call("plugin_alloc",a,1,1); if(!p)exit(2); return p; }
static void release(uint32_t p) { WasmEdge_Value a[]={I(p),I(0)}; call("plugin_free",a,2,0); }
static uint32_t input(const char *name,uint32_t *n) {
 FILE *f=fopen(name,"rb"); if(!f){perror(name);exit(2);} fseek(f,0,SEEK_END);*n=ftell(f);rewind(f);
 unsigned char *b=malloc(*n);if(fread(b,1,*n,f)!=*n)exit(2);fclose(f);
 uint32_t p=alloc(*n);ok(WasmEdge_MemoryInstanceSetData(mem,b,p,*n));free(b);return p;
}
static void output(const char *name,uint32_t p,uint32_t n) {
 unsigned char *b=malloc(n);ok(WasmEdge_MemoryInstanceGetData(mem,b,p,n));FILE*f=fopen(name,"wb");if(!f)exit(2);if(fwrite(b,1,n,f)!=n)exit(2);fclose(f);free(b);
}
static void expected(int actual,int wanted) { if(actual!=wanted){fprintf(stderr,"export returned %d expected %d\n",actual,wanted);exit(3);} }
int main(int argc,char **argv) {
 if(argc!=11)return 2;const int count=atoi(argv[2]);const double epoch=atof(argv[3]);
 const double retentionDays=atof(argv[5]),lookahead=atof(argv[6]),stepSeconds=atof(argv[8]);const int chunk=atoi(argv[7]),steps=atoi(argv[9]),gridStagger=atoi(argv[10]);
 unsigned samples[256],configured=0;if(steps>256||chunk<1)return 2;
 if(strcmp(WasmEdge_VersionGet(),"0.16.4")){fprintf(stderr,"Wrong WasmEdge: %s\n",WasmEdge_VersionGet());return 2;}
 WasmEdge_ConfigureContext *conf=WasmEdge_ConfigureCreate();
 WasmEdge_ConfigureAddProposal(conf,WasmEdge_Proposal_Threads);WasmEdge_ConfigureAddHostRegistration(conf,WasmEdge_HostRegistration_Wasi);
 vm=WasmEdge_VMCreate(conf,NULL);ok(WasmEdge_VMLoadWasmFromFile(vm,argv[1]));ok(WasmEdge_VMValidate(vm));ok(WasmEdge_VMInstantiate(vm));
 WasmEdge_String n=WasmEdge_StringCreateByCString("memory");mem=WasmEdge_ModuleInstanceFindMemory(WasmEdge_VMGetActiveModule(vm),n);WasmEdge_StringDelete(n);if(!mem)return 2;
 call("__wasm_call_ctors",NULL,0,0);const unsigned base=WasmEdge_MemoryInstanceGetPageSize(mem)*65536;
 char file[4096];
 if(count==1) {
  for(int i=0;i<3;i++){
   snprintf(file,sizeof file,"%s/focus-%d.piv",argv[4],i);uint32_t size,p=input(file,&size),sz=alloc(4);
   uint32_t zero=0;ok(WasmEdge_MemoryInstanceSetData(mem,(uint8_t*)&zero,sz,4));WasmEdge_Value a[]={I(p),I(size),I(sz)};
   uint32_t out=call("plugin_invoke_stream",a,3,1),len;ok(WasmEdge_MemoryInstanceGetData(mem,(uint8_t*)&len,sz,4));if(!out||!len)return 3;
   snprintf(file,sizeof file,"%s/native-1-%d.bin",argv[4],i);output(file,out,len);release(out);release(sz);release(p);
  }
 } else {
  expected(call("plugin_init",NULL,0,1),0);
  uint32_t framesN,bstarN,statesN;
  snprintf(file,sizeof file,"%s/frames.bin",argv[4]);uint32_t frames=input(file,&framesN);
  snprintf(file,sizeof file,"%s/bstar-%d.bin",argv[4],count);uint32_t bstar=input(file,&bstarN);
  WasmEdge_Value config[]={I(frames),I(framesN),I(bstar),I(count)};expected(call("plugin_configure_catalog",config,4,1),0);
  snprintf(file,sizeof file,"%s/states-%d.bin",argv[4],count);uint32_t states=input(file,&statesN);
  for(int i=0;i<count;i++){uint32_t p=states+i*56+8;WasmEdge_Value a[]={D(epoch),I(p),I(p),I(0)};expected(call("plugin_catalog_transform_state",a,4,1),0);}
  WasmEdge_Value seed[]={I(states),I(count)};expected(call("plugin_init_states_ecef",seed,2,1),count);
  release(frames);release(bstar);release(states);uint32_t out=alloc(count*48);
  configured=WasmEdge_MemoryInstanceGetPageSize(mem)*65536;
  /* The pool shard's own order: grid stagger, retention, then coverage in ensure chunks. */
  if(gridStagger){WasmEdge_Value g[]={I(1)};call("plugin_set_grid_stagger",g,1,0);}
  {WasmEdge_Value r[]={D(retentionDays)};call("plugin_set_ephemeris_retention",r,1,0);}
  for(int i=0;i<steps;i++){
   const double now=i*stepSeconds;
   for(int at=0;at<count;at+=chunk){const int n=count-at<chunk?count-at:chunk;WasmEdge_Value a[]={D(epoch+(now+lookahead)/86400),I(at),I(n)};expected(call("plugin_ensure_coverage",a,3,1),n);}
   WasmEdge_Value b[]={D(epoch+now/86400),I(out),I(count)};expected(call("plugin_eval_catalog_states_gcrf",b,3,1),count);
   snprintf(file,sizeof file,"%s/native-%d-%d.bin",argv[4],count,i);output(file,out,count*48);
   samples[i]=WasmEdge_MemoryInstanceGetPageSize(mem)*65536;
  }
  release(out);call("plugin_destroy",NULL,0,0);
 }
 printf("{\"runtime\":\"wasmedge\",\"version\":\"%s\",\"entities\":%d,\"baseBytes\":%u,\"highWaterBytes\":%u",WasmEdge_VersionGet(),count,base,WasmEdge_MemoryInstanceGetPageSize(mem)*65536);
 if(count>1){printf(",\"configuredBytes\":%u,\"samples\":[",configured);for(int i=0;i<steps;i++)printf("%s%u",i?",":"",samples[i]);printf("]");}
 printf("}\n");
 WasmEdge_VMDelete(vm);WasmEdge_ConfigureDelete(conf);return 0;
}`;
fs.writeFileSync(path.join(cache, 'measure.c'), nativeSource);
const wasmedge = process.env.WASMEDGE_ROOT || path.join(os.homedir(), `.local/share/spacedatanetwork/wasmedge-sdk/0.16.4-${process.platform}-${process.arch}`);
const native = path.join(cache, 'measure-native');
execFileSync('cc', [path.join(cache, 'measure.c'), '-std=c11', '-O2', `-I${wasmedge}/include`, `-L${wasmedge}/lib`, '-lwasmedge', `-Wl,-rpath,${wasmedge}/lib`, '-o', native], { stdio: 'inherit' });
if (process.platform === 'darwin') execFileSync('install_name_tool', ['-change', '@rpath/libwasmedge.0.dylib', `${wasmedge}/lib/libwasmedge.0.dylib`, native]);
fs.writeFileSync(path.join(cache, 'frames.bin'), Buffer.concat(frames));
focusRequests.forEach((bytes,i) => fs.writeFileSync(path.join(cache, `focus-${i}.piv`), bytes));
// Two isolated instances, one CPU each; no timing claim is made. Native AOT
// and Chromium can measure their own linear memory concurrently.
const nativeController = new AbortController();
let nativeFailure;
const nativeWork = (async () => {
const aotPath = await aotReady;
const measured = [];
await runRoles(async count => {
  if (count > 1) {
    const objects = Array.from({length:count},(_,i)=>seeds[i%seeds.length]);
    fs.writeFileSync(path.join(cache, `bstar-${count}.bin`), Buffer.from(new Float64Array(objects.map(s=>s.bstar)).buffer));
    // Unit conversion and marshaling; the guest performs frame conversion.
    fs.writeFileSync(path.join(cache, `states-${count}.bin`), Buffer.from(new Float64Array(objects.flatMap(s=>[epoch,...s.position.map(x=>x*1000),...s.velocity.map(x=>x*1000)])).buffer));
  }
  const {stdout} = await execFileAsync(native, [aotPath, String(count), String(epoch), cache, String(pool.retentionDays), String(pool.lookaheadSeconds),
    String(pool.ensureChunk), String(pool.segmentSeconds), String(pool.steps.length), pool.gridStagger ? '1' : '0'], {encoding:'utf8',maxBuffer:1024*1024,signal:nativeController.signal});
  const row = JSON.parse(stdout);
  row.role = count === 1 ? 'resident-focus' : 'catalog';
  row.outputs = Array.from({length:count===1?3:pool.steps.length}, (_,i)=>sha(fs.readFileSync(path.join(cache, `native-${count}-${i}.bin`))));
  measured.push(row); console.log(JSON.stringify(row));
});
return measured;
})().then(rows => ({rows}), error => { nativeFailure=error; return {error}; });

const bundle = await build({ stdin: { resolveDir: root, contents: `
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { catalogClient } from './scripts/catalog-coverage-client.mjs';
window.measure = async ({ count, seeds, epoch, manifest, focus, previous, pool }) => {
  if (!crossOriginIsolated) throw new Error('COI required');
  const h = await createBrowserModuleHarness({ wasmSource: await (await fetch(previous ? '/previous.wasm' : '/module.wasm')).arrayBuffer(), manifest, surface: 'direct' });
  let client;
  try {
    const outputs = [], samples = [];
    let configuredBytes;
    const memory = () => (h.instance.exports.memory ?? h.memory).buffer.byteLength;
    const baseBytes = memory();
    if (focus) {
      for (let i = 0; i < 3; ++i) {
        outputs.push([...await h.invokeRaw(new Uint8Array(await (await fetch('/focus/' + i)).arrayBuffer()))]);
        samples.push(memory());
      }
    } else {
      const frames = await Promise.all(Array.from({ length: 4 }, async (_, i) => new Uint8Array(await (await fetch('/frame/' + i)).arrayBuffer())));
      client = catalogClient(h, frames, Array.from({ length: count }, (_, i) => seeds[i % seeds.length]), epoch);
      if (client.profile() !== 'FFM-1') throw new Error('wrong profile');
      configuredBytes = memory();
      // The pool shard's own order: grid stagger, retention, then coverage in ensure chunks.
      const x = h.instance.exports;
      if (pool.gridStagger) x.plugin_set_grid_stagger(1);
      x.plugin_set_ephemeris_retention(pool.retentionDays);
      const ensure = jd => {
        for (let at = 0; at < count; at += pool.ensureChunk) {
          const n = Math.min(pool.ensureChunk, count - at);
          if (x.plugin_ensure_coverage(jd, at, n) !== n) throw new Error('coverage refused');
        }
      };
      for (const now of pool.steps) {
        ensure(epoch + (now + pool.lookaheadSeconds) / 86400);
        const states = client.states(epoch + now / 86400);
        if (!states.every(Number.isFinite)) throw new Error('nonfinite state');
        const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(states.buffer));
        outputs.push(Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join(''));
        samples.push(memory());
      }
    }
    return { role: focus ? 'resident-focus' : 'catalog', entities: count, baseBytes, ...(focus ? {} : { configuredBytes }), highWaterBytes: Math.max(...samples), samples, outputs, crossOriginIsolated, browser: navigator.userAgent };
  } finally { client?.dispose(); await h.destroy(); }
};` }, bundle: true, platform: 'browser', format: 'iife', write: false, logLevel: 'silent' });
const server = http.createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><script src="/bundle.js"></script>'); }
  if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(bundle.outputFiles[0].contents); }
  if (req.url === '/module.wasm') return res.end(wasm);
  if (req.url === '/previous.wasm') return res.end(fs.readFileSync(path.join(cache, '../previous.wasm')));
  const match = /^\/(frame|focus)\/(\d+)$/.exec(req.url);
  if (match) return res.end((match[1] === 'frame' ? frames : focusRequests)[+match[2]]);
  res.statusCode = 404; res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser, browserFinished=false;
try {
  browser = await chromium.launch({ executablePath: headlessShell(), headless: true });
  await runRoles(async count => {
    const page = await browser.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const options = { count, seeds, epoch, manifest, focus: count === 1, pool };
    const row = await page.evaluate(o => window.measure(o), options);
    const focusOutputs = row.role === 'resident-focus' ? row.outputs.map(b => new Uint8Array(b)) : null;
    if (row.role === 'resident-focus') {
      for (const bytes of row.outputs) assert.equal(decodePluginInvokeResponse(new Uint8Array(bytes)).statusCode, 0);
      row.outputs = row.outputs.map(b => sha(new Uint8Array(b)));
    }
    // The catalog's raw doubles remain byte-identical. SDS 1.259 adds RFM
    // NaN-default galactic fields: its generated serializer emits them even
    // for GCRF, growing the focus reply by 64 bytes without changing values.
    // Compare every decoded PIV/PRW field (including exact state doubles), not
    // the old/new FlatBuffer layout. Same-artifact runtime parity stays bytewise.
    if (count === 1 || count === 1000) {
      const old = await page.evaluate(o => window.measure(o), { ...options, previous: true });
      if (count === 1) {
        const decoded = bytes => {
          const { payloadArena, arenaLease, outputFrames, outputs, ...status } = decodePluginInvokeResponse(bytes);
          // Arena leases and serialized size/offset describe the wire layout.
          return { ...status, outputs: outputs.map(out => {
            const { payload, arenaLease, size, offset, ...metadata } = out;
            return { ...metadata, payload: decodePrw(payload) };
          }) };
        };
        assert.deepEqual(focusOutputs.map(decoded), old.outputs.map(b => decoded(new Uint8Array(b))), 'previous focus fields changed');
        row.previousArtifactParity = 'field-identical';
      } else {
        assert.deepEqual(row.outputs, old.outputs, 'previous catalog bytes changed');
        row.previousArtifactParity = 'bit-identical';
      }
    }
    if (nativeFailure) throw nativeFailure;
    assert.deepEqual(errors, []); report.rows.push({ runtime: 'browser', ...row }); save();
    console.log(JSON.stringify({ runtime: 'browser', entities: count, highWaterBytes: row.highWaterBytes })); await page.close();
  });
  browserFinished=true;
} finally { if (!browserFinished) nativeController.abort(); await browser?.close(); await new Promise(resolve => server.close(resolve)); }
// Native role execution and fitted-model verification are below. Outputs are
// written outside tracked paths so the exact candidate remains immutable.
save();
const nativeResult = await nativeWork;
if (nativeResult.error) throw nativeResult.error;
for (const row of nativeResult.rows) {
  const browserRow = report.rows.find(r=>r.runtime==='browser'&&r.entities===row.entities);
  assert.deepEqual(row.outputs,browserRow.outputs,`native/browser byte parity at ${row.entities}`);
  if (row.samples) assert.deepEqual(row.samples,browserRow.samples,`native/browser linear-memory parity at ${row.entities}`);
  report.rows.push(row); save();
}
report.rows.sort((a,b)=>a.entities-b.entities||a.runtime.localeCompare(b.runtime));
const rows = report.rows.filter(r=>r.role==='catalog');
const leastSquares=value=>{
  const meanX=rows.reduce((sum,r)=>sum+r.entities,0)/rows.length,meanY=rows.reduce((sum,r)=>sum+value(r),0)/rows.length;
  const perEntityBytes=rows.reduce((sum,r)=>sum+(r.entities-meanX)*(value(r)-meanY),0)/rows.reduce((sum,r)=>sum+(r.entities-meanX)**2,0);
  const baseBytes=meanY-perEntityBytes*meanX;
  assert(baseBytes>=0&&perEntityBytes>0,'invalid fitted allocation model');
  return {baseBytes,perEntityBytes};
};
const {baseBytes,perEntityBytes}=leastSquares(r=>r.highWaterBytes);
report.model={calibratedEntityRange:[1000,31814],units:'bytes',method:'least squares over catalog roles; max(initialBytes, baseBytes + entities * perEntityBytes)',baseBytes,perEntityBytes,
  focusHighWaterBytes:report.rows.find(r=>r.role==='resident-focus').highWaterBytes};
for(const row of rows){row.predictedBytes=Math.max(report.memory.initialBytes,baseBytes+perEntityBytes*row.entities);row.relativePredictionError=Math.abs(row.predictedBytes-row.highWaterBytes)/row.highWaterBytes;assert(row.relativePredictionError<=.1,'catalog model exceeds 10%');}
// The seeded state alone is what the pool's own E2E read (sample 0: the shard right
// after its first coverage sweep, the clock at the seed epoch). The retained window
// fills as the clock advances, so this is reported against the pool lane, never a sizing basis.
report.seededModel={units:'bytes',method:'least squares over the samples taken right after the pool seed sweep; not a sizing basis',...leastSquares(r=>r.samples[0])};
report.poolLane=poolLane;
for(const row of rows){
  row.seededBytes=row.samples[0];
  if(row.entities===poolLane.entities){
    row.poolLaneRelativeError=poolLane.heapBytes.map(bytes=>(row.seededBytes-bytes)/bytes);
    assert(row.poolLaneRelativeError.every(error=>Math.abs(error)<=poolLane.tolerance),'seeded heap differs from the pool lane by more than 5%');
  }
}
const largest=Math.max(...report.rows.map(r=>r.highWaterBytes));
report.requiredMaximumBytes=Math.ceil(largest*1.5/(16*1024*1024))*16*1024*1024;
report.loadEnd=os.loadavg();save();
if (!process.argv.includes('--measure')) {
  const recorded=read('tests/evidence/memory-sizing.json');
  assert.equal(recorded.artifactSha256,report.artifactSha256,'evidence names a different artifact');
  for(const row of report.rows) {
    const prior=recorded.rows.find(r=>r.runtime===row.runtime&&r.entities===row.entities);
    assert(prior,'missing recorded role');
    assert.equal(prior.highWaterBytes,row.highWaterBytes,'recorded high-water changed');
    assert.deepEqual(prior.samples,row.samples,'recorded pool-window samples changed');
  }
  assert.equal(report.memory.initialBytes,Math.max(16*1024*1024,Math.ceil(Math.max(report.memory.staticMinimumBytes,baseBytes)/65536)*65536),'rebuild with measured base');
  assert.equal(report.memory.maximumBytes,report.requiredMaximumBytes,'rebuild with measured maximum');
  for(const row of report.rows)assert(row.highWaterBytes*1.5<=report.memory.maximumBytes);
  if(regressionWork){
    const regressions=await regressionWork;
    if(regressions.error)throw regressions.error;
    for(const script of regressions.scripts)report[script]='PASS';
  }
  save();
  report.status='PASS';save();
}
console.log(JSON.stringify({model:report.model,seededModel:report.seededModel,poolLaneRelativeError:rows.find(r=>r.entities===poolLane.entities).poolLaneRelativeError,
  requiredMaximumBytes:report.requiredMaximumBytes,status:report.status||'MEASURED'}));
// The prewarm cache stays in the ignored .sdk-build tree (about 22 MB): the prewarm is idempotent and keyed
// by the exact artifact hash, so a second run in this checkout finds it ("already present") and skips the
// minutes of AOT compilation that would otherwise precede the native roles.
