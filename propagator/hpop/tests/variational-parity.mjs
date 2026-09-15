// One artifact and identical invoke inputs in real Chrome/V8, native WasmEdge,
// and container WasmEdge. Numerical acceptance runs separately against the
// independent Kepler fixture in variational_invoke.test.mjs.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { normalizeParityFixture,runParityHarness,formatParityReport } from 'space-data-module-sdk/testing';
import { cases } from './variational-fixture.mjs';
const plan=await normalizeParityFixture({name:'TMPL lane03 HPOP variational diagnostic artifact',cases});
const report=await runParityHarness({wasmPath:fileURLToPath(new URL('../dist/isomorphic/module.wasm',import.meta.url)),plan,timeoutMs:60000,log:console.log});
console.log(formatParityReport(report));
assert.equal(report.ok,true,JSON.stringify(report.failures));
