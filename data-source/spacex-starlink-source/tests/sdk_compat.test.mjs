import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {validateArtifactWithStandards} from 'space-data-module-sdk/compliance';
const root=fileURLToPath(new URL('..',import.meta.url));
test('built Starlink artifact conforms to its pinned SDK and typed SDS contracts',async()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'plugin-manifest.json')));
  const standardsRoot=path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
  const r=await validateArtifactWithStandards({wasmPath:path.join(root,'dist/isomorphic/module.wasm'),manifest,standardsRoot});
  assert.equal(r.ok,true,JSON.stringify(r.issues));
  for(const m of manifest.methods)for(const p of [...m.inputPorts,...m.outputPorts])assert.ok(p.acceptedTypeSets.every(s=>s.allowedTypes.every(t=>t.fileIdentifier&&t.rootTypeName)));
});
