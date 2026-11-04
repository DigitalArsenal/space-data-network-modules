import {createHash} from 'node:crypto';
// dist/build-provenance.json: what built dist/isomorphic/module.wasm, the fields propagator/ffm writes.
export function buildProvenance({sdk,spacedatastandards,compiler,threadModel,language,bytes}){
 return JSON.stringify({sdk,spacedatastandards,threadModel,language,compiler,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length},null,2)+'\n';
}
