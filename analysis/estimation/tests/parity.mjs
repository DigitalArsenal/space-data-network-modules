import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {normalizeParityFixture,runParityHarness,formatParityReport} from 'space-data-module-sdk/testing';
import {cases} from './fixtures.mjs';
import {staticDepthCases,nonlinearCases} from './depth-fixtures.mjs';
import {batchFitCases} from './batch-fit-fixtures.mjs';
import {teagCases} from './teag-fixtures.mjs';
import {espfCases} from './espf-fixtures.mjs';
import {module} from './hpop-port.mjs';
const [estimatorHarness,hpopHarness]=[await module('../'),await module('../../../propagator/hpop/')];
const extensionV3=[...teagCases(),...await espfCases(estimatorHarness,hpopHarness)];
for(const h of [estimatorHarness,hpopHarness]){h.destroy?.();h.dispose?.();}
const allCases=[...cases,...staticDepthCases,...await nonlinearCases(),...await batchFitCases(),...extensionV3];
const plan=await normalizeParityFixture({name:'TMPL lane05 estimation + TEAG/ESPF extension v3',threadEnvVar:'SDM_WORKER_COUNT',threadCounts:[1,2,4,8],cases:allCases.map(c=>({...c,request:{...c.request,inputs:c.request.inputs.map(({payload,...p})=>({...p,payloadHex:Buffer.from(payload).toString('hex')}))}}))});
const report=await runParityHarness({wasmPath:fileURLToPath(new URL('../dist/isomorphic/module.wasm',import.meta.url)),plan,timeoutMs:300000,log:console.log});
console.log(formatParityReport(report));
fs.writeFileSync(new URL('../conformance/lane05-parity.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
assert.equal(report.ok,true,JSON.stringify(report.failures));
