import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createBrowserModuleHarness} from 'space-data-module-sdk/testing';
import {loadModule} from 'space-data-module-sdk/host/isomorphic';
import {encodePluginInvokeRequest,decodePluginInvokeResponse} from 'space-data-module-sdk/invoke';
import {assertSequentialArtifact} from 'space-data-module-sdk/compiler';
import {filFrame} from './fit_harness.mjs';
const artifact=process.env.OD_ARTIFACT??fileURLToPath(new URL('../dist/isomorphic/module.wasm',import.meta.url));
async function createOemInput(wireFormat = "flatbuffer") {
  const {Builder} = await import("flatbuffers");
  const names = ["OEM", "ephemerisDataBlock", "ephemerisDataLine", "CAT", "RFM", "CelestialFrameWrapper"];
  const [OEM, Block, Line, CAT, RFM, Frame] = await Promise.all(names.map(async name =>
    (await import(`spacedatastandards.org/lib/js/OEM/${name}.js`))[`${name}T`]));
  const {CelestialFrame} = await import("spacedatastandards.org/lib/js/OEM/CelestialFrame.js");
  const {RFMUnion} = await import("spacedatastandards.org/lib/js/OEM/RFMUnion.js");
  const {timingStandard} = await import("spacedatastandards.org/lib/js/OEM/timingStandard.js");
  const text = fs.readFileSync(new URL("./data/supgp-reference/iss/ISS.OEM_J2K_EPH.trimmed.txt", import.meta.url), "utf8");
  const lines = text.split(/\r?\n/).filter(line => /^\d{4}-\d{2}-\d{2}T/.test(line.trim())).map(line => {
    const [epoch, ...numbers] = line.trim().split(/\s+/);
    return new Line(epoch, ...numbers.map(Number));
  });
  assert.ok(lines.length > 10);
  const cat = Object.assign(new CAT(), {OBJECT_NAME: "ISS", OBJECT_ID: "1998-067-A", NORAD_CAT_ID: 25544});
  const frame = new RFM(RFMUnion.CelestialFrameWrapper, new Frame(CelestialFrame.EME2000));
  const block = Object.assign(new Block(), {OBJECT: cat, CENTER_NAME: "EARTH", REFERENCE_FRAME: frame,
    TIME_SYSTEM: timingStandard.UTC, EPHEMERIS_DATA_LINES: lines});
  const oem = Object.assign(new OEM(), {EPHEMERIS_DATA_BLOCK: [block]});
  const builder = new Builder(65536); builder.finish(oem.pack(builder), "$OEM");
  return {portId: "oem", typeRef: {schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM", wireFormat, requiredAlignment: 8, byteLength: builder.asUint8Array().length},
    wireFormat, requiredAlignment: 8, payload: builder.asUint8Array()};
}

// Public NASA ISS OEM, EME2000 / UTC / km and km/s. Existing reference tests
// validate orbital values; this gate requires zero-tolerance payload identity
// across runtimes for the same WASM and request (including covariance absence).
// The artifact imports the typed hostcall bridge (space_data_module_host), which
// the plain WasmEdge CLI (and a Docker image of it) cannot instantiate ("unknown
// import"). Both WasmEdge legs are therefore the SDK loader's, as in
// tests/sdk_compat.test.mjs: loadModule runs the artifact on the SDK WasmEdge
// runner, which serves the bridge (plugin.getConfig answers the config, every
// other operation a typed "unsupported"). SDM_WASMEDGE_RUNNER_BINARY names a
// prebuilt runner. The command leg replays the loader's own launch plan so that
// a failing request still yields its response frame on stdout (exit status 1),
// which the loader's invoke() reports only as the exit.
test('canonical OD artifact has identical PIV outputs on three runtimes',async t=>{
 const wasm=fs.readFileSync(artifact);assertSequentialArtifact(wasm);
 const js=await createBrowserModuleHarness({wasmSource:wasm,surface:'direct'});
 const direct=await loadModule({wasmSource:artifact,runtimeKind:'wasmedge',enableThreads:true,surface:'direct'});
 const command=await loadModule({wasmSource:artifact,runtimeKind:'wasmedge',enableThreads:true});
 t.after(()=>Promise.all([js,direct,command].map(h=>h.destroy())));
 assert.equal(direct.runtime.surface,'direct');
 assert.equal(command.runtime.surface,'command');
 const normalize=r=>({status:r.statusCode,error:r.errorCode??'',outputs:r.outputs.map(o=>({port:o.portId,bytes:Buffer.from(o.payload).toString('hex')}))});
 const runCommand=request=>{
  const {command:binary,args,env,cwd}=command.launchPlan;
  const r=spawnSync(binary,args,{input:encodePluginInvokeRequest(request),env,cwd,timeout:60000,maxBuffer:4*1024*1024});
  assert.equal(r.error,undefined,r.error?.message);
  return r;
 };
 const requests=[
  {methodId:'fit',inputs:[filFrame(fs.readFileSync(new URL('./fixtures/request.fit.meme',import.meta.url)))]},
  {methodId:'fit',inputs:[await createOemInput()]},
  {methodId:'fit',inputs:[]},
  {methodId:'fit',inputs:[filFrame(new TextEncoder().encode('invalid ephemeris'))]}
 ];
 for(const request of requests){
  const expected=normalize(await js.invoke(request));
  assert.deepEqual(normalize(await direct.invoke(request)),expected,'wasmedge direct output differs');
  const r=runCommand(request);
  assert.ok(r.status===0 || (r.status===1 && expected.status!==0),'wasmedge command: '+r.stderr?.toString());
  assert.deepEqual(normalize(decodePluginInvokeResponse(r.stdout)),expected,'wasmedge command output differs');
 }
});
