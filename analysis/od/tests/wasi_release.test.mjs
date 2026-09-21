import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createBrowserModuleHarness} from 'space-data-module-sdk/testing';
import {encodePluginInvokeRequest,decodePluginInvokeResponse} from 'space-data-module-sdk/invoke';
import {extractPublicationRecordCollection} from 'space-data-module-sdk/transport';
import {assertSequentialArtifact} from 'space-data-module-sdk/compiler';
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
test('canonical OD artifact has identical PIV outputs on three runtimes',async()=>{
 const wasm=fs.readFileSync(artifact);assertSequentialArtifact(wasm);
 const h=await createBrowserModuleHarness({wasmSource:wasm,surface:'direct'});
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'od-parity-'));
 fs.writeFileSync(path.join(temp,'module.wasm'),extractPublicationRecordCollection(wasm)?.payloadBytes??wasm);
 const dockerImage=process.env.OD_PARITY_DOCKER_IMAGE??'space-data-module-sdk/parity-wasmedge:0.16.4';
 const normalize=r=>({status:r.statusCode,error:r.errorCode??'',outputs:r.outputs.map(o=>({port:o.portId,bytes:Buffer.from(o.payload).toString('hex')}))});
 try {
  const requests=[
   {methodId:'fit',inputs:[{portId:'meme',payload:fs.readFileSync(new URL('./fixtures/request.fit.meme',import.meta.url))}]},
   {methodId:'fit',inputs:[await createOemInput()]},
   {methodId:'fit',inputs:[]},
   {methodId:'fit',inputs:[{portId:'meme',payload:new TextEncoder().encode('invalid ephemeris')}]}
  ];
  for(const request of requests){
   const expected=normalize(await h.invoke(request)),input=encodePluginInvokeRequest(request);
   for(const [command,args] of [
    [process.env.WASMEDGE_BINARY??'wasmedge',['--enable-threads',path.join(temp,'module.wasm')]],
    ['docker',['run','--rm','-i','--network=none','-v',temp+':/input:ro',dockerImage,'--enable-threads','/input/module.wasm']]
   ]){
    const r=spawnSync(command,args,{input,timeout:60000,maxBuffer:4*1024*1024});
    assert.equal(r.error,undefined,r.error?.message);
    assert.ok(r.status===0 || (r.status===1 && expected.status!==0),command+': '+r.stderr?.toString());
    assert.deepEqual(normalize(decodePluginInvokeResponse(r.stdout)),expected,command+' output differs');
   }
  }
 } finally {await h.destroy();fs.rmSync(temp,{recursive:true,force:true});}
});
