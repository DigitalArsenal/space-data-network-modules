import {createHash} from 'node:crypto';
// dist/build-provenance.json: what built dist/isomorphic/module.wasm, the fields propagator/ffm writes.
// Written line by line (the module's tooling emits no JSON through a serializer); every value is a version, an identifier or a hex digest.
export function buildProvenance({sdk,spacedatastandards,compiler,threadModel,language,bytes}){
 return `{\n  "sdk": "${sdk}",\n  "spacedatastandards": "${spacedatastandards}",\n  "threadModel": "${threadModel}",\n  "language": "${language}",\n  "compiler": "${compiler}",\n  "sha256": "${createHash('sha256').update(bytes).digest('hex')}",\n  "bytes": ${bytes.length}\n}\n`;
}
