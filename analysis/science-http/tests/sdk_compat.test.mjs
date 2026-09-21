import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createBrowserModuleHarness} from 'space-data-module-sdk/testing';
import {encodeHttpRequest,decodeHttpResponse} from 'space-data-module-sdk/http';
import {validateArtifactWithStandards} from 'space-data-module-sdk/compliance';
const manifest=JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json',import.meta.url)));
const wasmPath=fileURLToPath(new URL('../dist/isomorphic/module.wasm',import.meta.url));
const typeRef=(code)=>code==='HTQ'?{schemaName:'HttpRequestAbi.fbs',fileIdentifier:'$HTQ',rootTypeName:'HttpRequest'}:{schemaName:'CQR.fbs',fileIdentifier:'$CQR',rootTypeName:'CQR'};
// The adapter transports bytes; the downstream CQR module owns table validation.
const payload=Uint8Array.from([8,0,0,0,36,67,81,82,0,0,0,0]);
async function invoke(t,methodId,inputs){const h=await createBrowserModuleHarness({wasmSource:fs.readFileSync(wasmPath),manifest,surface:'direct',enableThreads:true});t.after(()=>h.destroy());const r=await h.invoke({methodId,inputs});assert.equal(r.statusCode,0,r.errorMessage);return r.outputs;}
const frame=(method,body=payload)=>({portId:'http',typeRef:typeRef('HTQ'),payload:encodeHttpRequest({method,path:'/api/v1/science/screen',headers:[],body})});
test('artifact passes canonical SDK compliance',async()=>{const require=createRequire(import.meta.url);const report=await validateArtifactWithStandards({manifest,wasmPath,standardsRoot:path.dirname(require.resolve('spacedatastandards.org/package.json'))});assert.equal(report.ok,true,JSON.stringify(report.issues));});
test('POST transports CQR bytes without transformation',async t=>{const outputs=await invoke(t,'route',[frame('POST')]);assert.equal(outputs.length,1);assert.equal(outputs[0].portId,'request');assert.deepEqual(new Uint8Array(outputs[0].payload),payload);});
for(const [label,input,status] of [['wrong method',frame('GET'),405],['wrong schema',frame('POST',new Uint8Array(12)),400],['oversized',frame('POST',(()=>{const b=new Uint8Array(4*1024*1024+1);b.set(payload);return b;})()),413]])test(label,async t=>{const o=await invoke(t,'route',[input]);assert.equal(o.length,1);assert.equal(decodeHttpResponse(o[0].payload).status,status);});
test('CQR response bytes and no-store header are preserved',async t=>{const o=await invoke(t,'respond',[{portId:'result',typeRef:typeRef('CQR'),payload}]);const r=decodeHttpResponse(o[0].payload);assert.equal(r.status,200);assert.equal(new DataView(r.body.buffer,r.body.byteOffset).getUint32(0,true),payload.length);assert.deepEqual(new Uint8Array(r.body).slice(4,4+payload.length),payload);assert(r.headers.some(h=>h.name==='cache-control'&&h.value==='no-store'));});
test('invalid downstream result is a gateway failure',async t=>{const o=await invoke(t,'respond',[{portId:'result',typeRef:typeRef('CQR'),payload:new Uint8Array(12)}]);assert.equal(decodeHttpResponse(o[0].payload).status,502);});

test('multiple result chunks all survive framing',async t=>{const o=await invoke(t,'respond',[{portId:'result',typeRef:typeRef('CQR'),payload},{portId:'result',typeRef:typeRef('CQR'),payload}]);const r=decodeHttpResponse(o[0].payload);assert.equal(r.body.length,32);assert.deepEqual(new Uint8Array(r.body).slice(20,32),payload);});
