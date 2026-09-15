// Test-only ABI codec: generate binary/JSON with the exact pinned SDK schema.
// No hand-maintained offsets, generated bindings, or physics in JavaScript.
import fs from 'node:fs';
import createFlatc from 'flatc-wasm/module';
const flatc=await createFlatc();
flatc.FS.mkdir('/schema');flatc.FS.mkdir('/out');
for(const name of fs.readdirSync(new URL('../node_modules/space-data-module-sdk/schemas/orbpro/',import.meta.url))) {
  if(name.endsWith('.fbs'))flatc.FS.writeFile(`/schema/${name}`,fs.readFileSync(new URL(`../node_modules/space-data-module-sdk/schemas/orbpro/${name}`,import.meta.url)));
}
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
