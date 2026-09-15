#!/usr/bin/env node
// Canonical SDK three-runtime parity gate, on one primary artifact. All
// screening fixtures use CelesTrak's committed 2026-03-10 snapshot and the
// unchanged proposal §8 tolerances. No live catalog fetch or physics in JS.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { normalizeParityFixture, runParityHarness } from 'space-data-module-sdk/testing';
import { decodePluginInvokeResponse } from 'space-data-module-sdk/invoke';
import { initCqrFlatc, encodeCqr, decodeCqr, catalogRequest, gpRecord, publishedSchema, catalogInReferenceUnits } from '../tests/lib/cqr.mjs';
import { compareToReference, isoToJd } from '../tests/lib/screenCatalogParityHarness.mjs';
import { CA_PARITY_TOLERANCES as T } from '../tests/lib/caParityTolerances.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flatc = await initCqrFlatc();
const refs = JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/socrates/reference.top3.json'))).conjunctions;
const catalog = new Map();
for (const r of refs) for (const g of JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/socrates',r.gp_file.replace(/\.txt$/,'.json'))))) catalog.set(g.NORAD_CAT_ID,g);
const objects = [...catalog.values()];
const referenceEvents = refs.map(r=>({obj1Norad:r.obj1_norad,obj2Norad:r.obj2_norad,tcaJd:isoToJd(r.tca),missKm:r.min_range_km,relSpeedKms:r.rel_speed_kms,pc:r.max_prob}));
const startJd=Math.min(...objects.map(g=>isoToJd(g.EPOCH)))-.05;
const durationDays=Math.max(7,Math.max(...referenceEvents.map(r=>r.tcaJd))-startJd+.25);
const ommInputs=objects.map(g=>({portId:'catalog',payload:flatc.generateBinary(publishedSchema('OMM'),JSON.stringify(gpRecord(g)),{sizePrefix:false})}));
const cases=[1,2,4,8].map(n=>({id:`socrates-workers-${n}`,threadCounts:[n],request:{methodId:'screen_catalog',inputs:[{portId:'request',payload:encodeCqr(flatc,catalogRequest({startJd,durationDays,numThreads:n,thresholdKm:T.screening.socrates.thresholdKm,combinedRadiusM:T.screening.socrates.combinedRadiusM,coarseStepSec:T.screening.socrates.coarseStepSec,fineTolSec:T.screening.socrates.fineTolSec}))},...ommInputs]}}));
cases.push({id:'centered-isotropic-pc',threadCounts:[1,2,4,8],request:{methodId:'compute_pc',inputs:[{portId:'request',payload:encodeCqr(flatc,{PROBABILITY_REQUEST:{GEOMETRY:{VARIANCE_XI_M2:10000,VARIANCE_ZETA_M2:10000,COMBINED_RADIUS_M:10},ALGORITHM:'LAAS_2015'}})}]}});
cases.push({id:'singular-covariance',threadCounts:[1,2,4,8],request:{methodId:'compute_pc',inputs:[{portId:'request',payload:encodeCqr(flatc,{PROBABILITY_REQUEST:{GEOMETRY:{VARIANCE_XI_M2:1,VARIANCE_ZETA_M2:1,COVARIANCE_XI_ZETA_M2:1,COMBINED_RADIUS_M:10}}})}]}});
cases.push({id:'empty-piv',threadCounts:[1,2,4,8],stdinHex:''});
cases.push({id:'truncated-piv',threadCounts:[1,2,4,8],stdinHex:'0800000024504956'});
for (const c of cases) if(c.request) for (const input of c.request.inputs) { const id=String.fromCharCode(...input.payload.subarray(4,8)); input.typeRef={schemaName:`${id.slice(1)}.fbs`,fileIdentifier:id,rootTypeName:id.slice(1),wireFormat:'flatbuffer'}; }
const plan=await normalizeParityFixture({name:'CQR-SDS-1.220.0',cases});
// The SDK report intentionally summarizes bytes, so observe actual lane runs
// before reporting to validate independent physical outcomes as well as parity.
const sdkRoot=path.dirname(fileURLToPath(import.meta.resolve('space-data-module-sdk/testing')));
const {defaultParityLaneRunners}=await import(path.join(sdkRoot,'parityLanes.js'));
const observed=[]; const laneRunners={};
for(const [name,runner] of Object.entries(defaultParityLaneRunners)) laneRunners[name]=async c=>{const runs=await runner(c); observed.push(...runs.map(r=>({...r,lane:name})));return runs;};
const report=await runParityHarness({wasmPath:path.join(root,'dist/isomorphic/module.wasm'),plan,laneRunners,timeoutMs:120000,log:console.log});
fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});
fs.writeFileSync(path.join(root,'artifacts/cqr-runtime-parity.json'),JSON.stringify(report,null,2)+'\n');
const numerical=[];
for(const run of observed){
  if(run.exitClass!=='ok')continue;
  const response=decodePluginInvokeResponse(run.stdout);
  if(['singular-covariance','empty-piv','truncated-piv'].includes(run.caseId)){assert.notEqual(response.statusCode,0);continue;}
  assert.equal(response.statusCode,0,response.errorMessage);
  const result=decodeCqr(flatc,response.outputs[0].payload);
  if(run.caseId==='centered-isotropic-pc'){const p=result.PROBABILITY_RESULT;assert.equal(p.ALGORITHM,'LAAS_2015');assert.equal(p.CONVERGED,true);assert.ok(Math.abs(p.PROBABILITY-.00498752080731768)<=1e-12);continue;}
  const cmp=compareToReference(catalogInReferenceUnits(result.CATALOG_RESULT),referenceEvents);
  assert.equal(cmp.counts.missingCount,0);assert.equal(cmp.counts.extraCount,0);assert.equal(result.CATALOG_RESULT.STATISTICS.FAILED_PAIRS,0);
  for(const m of cmp.matched){assert.ok(m.deltas.tcaDeltaSec<=.010);assert.ok(m.deltas.missDeltaM<=5);assert.ok(m.deltas.relSpeedDeltaMS<=5);}
  numerical.push({lane:run.lane,workers:run.threadCount,sha256:createHash('sha256').update(run.stdout).digest('hex'),deltas:cmp.matched.map(m=>({pair:m.key,...m.deltas}))});
}
assert.equal(numerical.length,12,'Every required worker/runtime scientific run must complete');
assert.equal(new Set(numerical.map(n=>n.sha256)).size,1,'screen_catalog bytes differ across worker counts or lanes');
report.numerical=numerical;
fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});
fs.writeFileSync(path.join(root,'artifacts/cqr-runtime-parity.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
if(!report.ok)process.exitCode=1;
