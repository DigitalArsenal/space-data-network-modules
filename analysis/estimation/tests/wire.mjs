// Test-only ABI codec generated from the module-local append-only schema.
// No hand-maintained offsets or physics in JavaScript.
import fs from 'node:fs';
import createFlatc from 'flatc-wasm/module';
const flatc=await createFlatc();
flatc.FS.mkdir('/schema');flatc.FS.mkdir('/out');
for(const name of fs.readdirSync(new URL('../node_modules/space-data-module-sdk/schemas/orbpro/',import.meta.url))) {
  if(name.endsWith('.fbs'))flatc.FS.writeFile(`/schema/${name}`,fs.readFileSync(new URL(`../node_modules/space-data-module-sdk/schemas/orbpro/${name}`,import.meta.url)));
}
flatc.FS.writeFile("/schema/Estimation.fbs", fs.readFileSync(new URL("../schemas/Estimation.fbs", import.meta.url)));
function compile(args) {
  const rc=flatc.callMain(['--no-warnings','--strict-json','--defaults-json','-I','/schema','-o','/out',...args]);
  if(rc!==0)throw new Error(`flatc exit ${rc}`);
}
export function encode(value) {
  flatc.FS.writeFile('/in.json',JSON.stringify(value));
  compile(['--binary','/schema/Estimation.fbs','/in.json']);
  return Uint8Array.from(flatc.FS.readFile('/out/in.bin'));
}
export function decode(bytes) {
  flatc.FS.writeFile('/in.bin',bytes);
  compile(['--json','/schema/Estimation.fbs','--','/in.bin']);
  return JSON.parse(flatc.FS.readFile('/out/in.json',{encoding:'utf8'}));
}
export const typeRef={schemaName:'Estimation.fbs',fileIdentifier:'$EST',rootTypeName:'EstimationEnvelope'};
export function invocation(config,observations,samples) {
  return {methodId:'run_estimation',inputs:[
    {portId:'request',typeRef,payload:encode({request:{config,observations,propagator_port_id:'reference-provider',propagator_capability:'plugin_propagate plugin_compute_stm',trace_id:'lane05'}})},
    {portId:'propagator_samples',typeRef,payload:encode({propagator_samples:samples})}
  ]};
}

// Generated object API preserves every double bit during propagator replay.
// flatc JSON is retained above only for human-readable fixture conveniences.
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Builder,ByteBuffer} from 'flatbuffers';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'estimation-codec-'));
let objectApi;
try {
 compile(['--ts','--gen-object-api','--gen-all','/schema/Estimation.fbs']);
 function copy(dir,out) {fs.mkdirSync(out,{recursive:true});for(const name of flatc.FS.readdir(dir)){if(name==='.'||name==='..')continue;const source=`${dir}/${name}`;if(flatc.FS.isDir(flatc.FS.stat(source).mode))copy(source,path.join(out,name));else if(name.endsWith('.ts'))fs.writeFileSync(path.join(out,name),flatc.FS.readFile(source));}}
 copy('/out',temp);
 // One entry re-exporting every generated table, struct and enum.
 const dir=path.join(temp,'orbpro/estimation');
 fs.writeFileSync(path.join(temp,'all.ts'),fs.readdirSync(dir).filter(n=>n.endsWith('.ts')).map(n=>`export * from './orbpro/estimation/${n.slice(0,-3)}';`).join('\n'));
 const result=await build({entryPoints:[path.join(temp,'all.ts')],bundle:true,write:false,format:'esm',platform:'node',nodePaths:[fileURLToPath(new URL('../node_modules',import.meta.url))]});
 objectApi=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
} finally {fs.rmSync(temp,{recursive:true,force:true});}
export const api=()=>objectApi;
export function unpack(bytes) {return objectApi.EstimationEnvelope.getRootAsEstimationEnvelope(new ByteBuffer(bytes)).unpack();}
export function pack(object) {const b=new Builder();b.finish(object.pack(b),'$EST');return b.asUint8Array();}
