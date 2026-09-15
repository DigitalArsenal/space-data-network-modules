// Optional replay of the exact full public downloads identified by fixture provenance.
// No network or numerical reference generation: this verifies complete-file acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createBrowserModuleHarness} from 'space-data-module-sdk/testing';
import {parseRequest,meta} from './harness.mjs';
const directory=process.argv[2];if(!directory)throw new Error('Usage: node tests/full-source-smoke.mjs <download-directory>');
const sources=JSON.parse(fs.readFileSync(new URL('fixtures/provenance.json',import.meta.url)));
const h=await createBrowserModuleHarness({wasmSource:fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url)),surface:'direct'});
try {
 for(const [index,source]of ['finals2000a','c04','paris'].entries()){
  const filename=sources[index].file.replace('.excerpt.txt','');const bytes=fs.readFileSync(path.join(directory,filename));
  const hash=createHash('sha256').update(bytes).digest('hex');assert.equal(hash,sources[index].full_source_sha256,'Download differs from fixture issue');
  const response=await h.invoke(parseRequest(source,bytes));assert.equal(response.statusCode,0,response.errorMessage);
  const result=meta(response);assert.equal(result.sha256,hash);console.log(`PASS full source ${source}: ${result.record_count} records; ${result.empty_future_rows} blank future rows`);
 }
} finally {await h.destroy();}
