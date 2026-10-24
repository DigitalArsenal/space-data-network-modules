import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {normalizeParityFixture,runParityHarness,formatParityReport} from 'space-data-module-sdk/testing';
import {cases} from './fixtures.mjs';
import {staticDepthCases,nonlinearCases} from './depth-fixtures.mjs';
import {batchFitCases} from './batch-fit-fixtures.mjs';
import {batchFitV2Cases} from './batch-fit-v2-fixtures.mjs';
import {teagCases} from './teag-fixtures.mjs';
import {espfCases} from './espf-fixtures.mjs';
import {module} from './ffm-port.mjs';
const [estimatorHarness,ffmHarness]=[await module('../'),await module('../../../propagator/ffm/')];
const extensionV3=[...teagCases(),...await espfCases(estimatorHarness,ffmHarness)];
for(const h of [estimatorHarness,ffmHarness]){h.destroy?.();h.dispose?.();}
const allCases=[...cases,...staticDepthCases,...await nonlinearCases(),...await batchFitCases(),...extensionV3,...await batchFitV2Cases()];
const plan=await normalizeParityFixture({name:'TMPL lane05 estimation + TEAG/ESPF extension v3 + fit_batch v2 extension v4',threadEnvVar:'SDM_WORKER_COUNT',threadCounts:[1,2,4,8],cases:allCases.map(c=>({...c,request:{...c.request,inputs:c.request.inputs.map(({payload,...p})=>({...p,payloadHex:Buffer.from(payload).toString('hex')}))}}))});
// Two lanes: Chrome/V8 and native WasmEdge. The owner waived the Docker leg on 2026-10-22; it is never started,
// and the receipt says so. A failed run leaves the committed receipt untouched: assert, then write.
const report=await runParityHarness({wasmPath:fileURLToPath(new URL('../dist/isomorphic/module.wasm',import.meta.url)),plan,lanes:['browser','wasmedge'],timeoutMs:300000,log:console.log});
console.log(formatParityReport(report));
assert.equal(report.ok,true,JSON.stringify(report.failures));
fs.writeFileSync(new URL('../conformance/lane05-parity.json',import.meta.url),JSON.stringify({...report,wasmPath:'analysis/estimation/dist/isomorphic/module.wasm',dockerLane:'waived by the owner 2026-10-22 (no Docker)'},null,2)+'\n');
