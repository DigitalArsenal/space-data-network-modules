import fs from 'node:fs';
// One artifact and identical invoke inputs in real Chrome/V8, native WasmEdge,
// and container WasmEdge. Numerical acceptance runs separately against the
// independent Kepler fixture in variational_invoke.test.mjs.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { normalizeParityFixture,runParityHarness,formatParityReport } from 'space-data-module-sdk/testing';
import { cases } from './variational-fixture.mjs';
const plan=await normalizeParityFixture({name:'TMPL lane13 canonical PRW variational artifact',threadCounts:[1,2,4,8],cases});
const report=await runParityHarness({wasmPath:fileURLToPath(new URL('../dist/isomorphic/module.wasm',import.meta.url)),plan,timeoutMs:60000,log:console.log});
console.log(formatParityReport(report));
fs.mkdirSync(new URL('./evidence/lane13/',import.meta.url),{recursive:true});
fs.writeFileSync(new URL('./evidence/lane13/variational-parity.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
assert.equal(report.ok,true,JSON.stringify(report.failures));
