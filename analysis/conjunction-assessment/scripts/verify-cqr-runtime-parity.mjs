#!/usr/bin/env node
// Canonical SDK three-runtime parity gate, on one primary artifact. All
// screening fixtures use CelesTrak's committed 2026-03-10 snapshot and the
// unchanged proposal §8 tolerances. No live catalog fetch or physics in JS.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { normalizeParityFixture, runParityHarness, formatParityReport } from 'space-data-module-sdk/testing';
import { decodePluginInvokeResponse } from 'space-data-module-sdk/invoke';
import { initCqrFlatc, encodeCqr, decodeCqr, catalogRequest, gpRecord, publishedSchema, catalogInReferenceUnits, screeningControls, earthFrame } from '../tests/lib/cqr.mjs';
import { compareToReference, isoToJd } from '../tests/lib/screenCatalogParityHarness.mjs';
import { CA_PARITY_TOLERANCES as T } from '../tests/lib/caParityTolerances.mjs';
import { runThreadedBrowserLane } from './cqr-browser-parity-lane.mjs';
import { wasmedgeParityLane } from './cqr-wasmedge-parity-lane.mjs';
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
// Reentering objects in a real CelesTrak GP catalog (tests/fixtures/decaying,
// see tests/coarseExclusion.test.mjs): EXPLORER 7 against eleven secondaries
// over 7 days from 2026-07-06. Three objects cannot be propagated over the
// window; every lane and worker count must exclude and list the same three
// with byte-identical responses.
const decaying=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/decaying/gp_2026-07-06.json')));
const decayingExcluded=[8301,60875,69729];
const decayingStartJd=Date.parse('2026-07-06T00:00:00Z')/86400000+2440587.5;
const decayingInputs=decaying.map(g=>({portId:'catalog',payload:flatc.generateBinary(publishedSchema('OMM'),JSON.stringify(gpRecord(g)),{sizePrefix:false})}));
cases.push(...[1,2,4,8].map(n=>({id:`decaying-workers-${n}`,threadCounts:[n],request:{methodId:'screen_catalog',inputs:[{portId:'request',payload:encodeCqr(flatc,{CATALOG_REQUEST:{CONTROLS:screeningControls({startJd:decayingStartJd,durationDays:7,numThreads:n}),EVALUATION_FRAME:earthFrame('TEME'),START_ORDER_INDEX:0,HAS_START_ORDER_INDEX:true,END_ORDER_INDEX:1,HAS_END_ORDER_INDEX:true,SECONDARY_START_ORDER_INDEX:1,HAS_SECONDARY_START_ORDER_INDEX:true,SECONDARY_END_ORDER_INDEX:decaying.length,HAS_SECONDARY_END_ORDER_INDEX:true}})},...decayingInputs]}})));
cases.push({id:'centered-isotropic-pc',threadCounts:[1,2,4,8],request:{methodId:'compute_pc',inputs:[{portId:'request',payload:encodeCqr(flatc,{PROBABILITY_REQUEST:{GEOMETRY:{VARIANCE_XI_M2:10000,VARIANCE_ZETA_M2:10000,COMBINED_RADIUS_M:10},ALGORITHM:'LAAS_2015'}})}]}});
cases.push({id:'singular-covariance',threadCounts:[1,2,4,8],request:{methodId:'compute_pc',inputs:[{portId:'request',payload:encodeCqr(flatc,{PROBABILITY_REQUEST:{GEOMETRY:{VARIANCE_XI_M2:1,VARIANCE_ZETA_M2:1,COVARIANCE_XI_ZETA_M2:1,COMBINED_RADIUS_M:10}}})}]}});
cases.push({id:'empty-piv',threadCounts:[1,2,4,8],stdinHex:''});
cases.push({id:'truncated-piv',threadCounts:[1,2,4,8],stdinHex:'0800000024504956'});
// Wire outcomes are grounded in the published CQR root and SDK PIV verifier.
// The retired JSON method is rejected by the SDK method registry.
const invalidCqr = new Set(['singular-covariance','empty-cqr','ambiguous-cqr','wrong-cqr-arm','truncated-cqr','invalid-source-date']);
const cqrCase=(id,record)=>({id,threadCounts:[1,2,4,8],request:{methodId:'compute_pc',inputs:[{portId:'request',payload:encodeCqr(flatc,record)}]}});
cases.push(cqrCase('empty-cqr',{}),cqrCase('ambiguous-cqr',{VERSION_QUERY:true,PROBABILITY_REQUEST:{GEOMETRY:{VARIANCE_XI_M2:1,VARIANCE_ZETA_M2:1}}}),cqrCase('wrong-cqr-arm',{VERSION_QUERY:true}));
const truncated=cqrCase('truncated-cqr',{VERSION_QUERY:true});
truncated.request.inputs[0].payload=truncated.request.inputs[0].payload.slice(0,13);
cases.push(truncated);
const badDate=catalogRequest({startJd,durationDays,numThreads:1,primaryGps:[{...objects[0],EPOCH:'2026-02-30T12:00:00Z'}],secondaryGps:[objects[1]]});
cases.push({id:'invalid-source-date',threadCounts:[1,2,4,8],request:{methodId:'screen_catalog',inputs:[{portId:'request',payload:encodeCqr(flatc,badDate)}]}});
for (const c of cases) if(c.request) for (const input of c.request.inputs) { const id=String.fromCharCode(...input.payload.subarray(4,8)); input.typeRef={schemaName:`${id.slice(1)}.fbs`,fileIdentifier:id,rootTypeName:id.slice(1),wireFormat:'flatbuffer'}; }
cases.push({id:'legacy-json-method',threadCounts:[1,2,4,8],request:{methodId:'invoke',inputs:[{portId:'request',payload:new TextEncoder().encode('{"operation":"version"}')} ]}});
for(const c of cases)c.expect=['empty-piv','truncated-piv','legacy-json-method'].includes(c.id)?'guest-error':'ok';
const plan=await normalizeParityFixture({name:'CQR-SDS-1.220.0',cases});
// The SDK report intentionally summarizes bytes, so observe actual lane runs
// before reporting to validate independent physical outcomes as well as parity.
const observed=[]; const laneRunners={};
for(const [name,runner] of Object.entries({browser:runThreadedBrowserLane,wasmedge:wasmedgeParityLane('wasmedge'),'docker-wasmedge':wasmedgeParityLane('docker-wasmedge')})) laneRunners[name]=async c=>{const runs=await runner(c); observed.push(...runs.map(r=>({...r,lane:name})));return runs;};
const report=await runParityHarness({wasmPath:path.join(root,'dist/isomorphic/module.wasm'),plan,laneRunners,timeoutMs:120000,log:console.log});
const evidence=process.env.CQR_PARITY_EVIDENCE_DIR?path.resolve(process.env.CQR_PARITY_EVIDENCE_DIR):path.resolve(root,'../../docs/evidence/tmpl-lane-14');
fs.mkdirSync(evidence,{recursive:true});
report.classifications=[];
report.threadEvidence=[];
report.provenance={
  sds:'spacedatastandards.org@1.220.0',sdk:'space-data-module-sdk@0.8.18',
  snapshot:'CelesTrak SOCRATES Plus, 2026-03-10; https://celestrak.org/SOCRATES/',
  snapshotSha256:createHash('sha256').update(fs.readFileSync(path.join(root,'tests/fixtures/socrates/reference.top3.json'))).digest('hex'),
  frame:'TEME',timeScale:'UTC',
  tolerances:{tcaSeconds:T.tca.NLRV.hardFailSec,missMetres:T.missDistance.socratesHardFailM,speedMetresPerSecond:T.relSpeed.hardFailMS},
  toleranceRationale:'Proposal section 8; NLRV TCA bound, CSV range quantization, retained speed regression bound; tests/lib/caParityTolerances.mjs.',
  probability:{source:'NIST Rayleigh CDF https://www.itl.nist.gov/div898/software/dataplot/refman2/auxillar/raycdf.htm',formula:'1-exp(-R^2/(2*sigma^2))',radiusM:10,sigmaM:100,expected:.00498752080731768,absoluteTolerance:1e-12,frame:'Arbitrary orthonormal encounter axes',epoch:'Not applicable',toleranceRationale:'Smooth centered Gaussian disk integral and deterministic converged quadrature; actual Pc rather than maximum-probability bound.'},
  invalidInput:'Published SDS 1.220.0 CQR root and SDK 0.8.18 PIV verifier: exactly one arm, correct method/arm mapping, valid calendar epochs, positive-definite encounter covariance.',
};
const numerical=[];
const exclusion=[];
const acceptance=[];
const check=(label,fn)=>{try{fn();}catch(error){acceptance.push({kind:'acceptance',message:`${label}: ${error.message}`});}};
for(const run of observed){
  const classification={lane:run.lane,caseId:run.caseId,workers:run.threadCount,exitClass:run.exitClass,exitDetail:run.exitDetail,stderr:new TextDecoder().decode(run.stderr??[]).slice(-2000)};
  report.classifications.push(classification);
  // SDK parity checks the explicit expected exit class for every case, including
  // malformed PIV input whose nonzero command exit has no browser stdout.
  if(run.exitClass!=='ok')continue;
  check(`${run.lane}/${run.caseId}/${run.threadCount}`,()=>{
  const response=decodePluginInvokeResponse(run.stdout);
  classification.statusCode=response.statusCode;classification.errorCode=response.errorCode;
  if(invalidCqr.has(run.caseId)){assert.notEqual(response.statusCode,0);assert.equal(response.outputs.length,0);return;}
  assert.equal(response.statusCode,0,response.errorMessage);
  const result=decodeCqr(flatc,response.outputs[0].payload);
  if(run.caseId.startsWith('decaying-')){
    const excludedFrames=response.outputs.filter(f=>f.portId==='excluded');
    const norads=excludedFrames.map(f=>JSON.parse(flatc.generateJSON(publishedSchema('OMM'),{path:'/omm.bin',data:f.payload},{defaultsJson:true})).NORAD_CAT_ID);
    assert.deepEqual(norads,decayingExcluded);
    const r=result.CATALOG_RESULT;
    assert.equal(r.STATISTICS.FAILED_PAIRS,0);assert.equal(r.OBJECTS_PARSED-r.STATISTICS.TOTAL_OBJECTS,decayingExcluded.length);assert.ok((r.EVENTS??[]).length>0);
    exclusion.push({lane:run.lane,workers:run.threadCount,sha256:createHash('sha256').update(run.stdout).digest('hex'),excluded:norads,events:r.EVENTS.length,spawnCount:run.spawnCount});
    if(run.threadCount>1)assert.ok(run.spawnCount>=run.threadCount,'Required real guest worker spawns were not observed');
    return;
  }
  if(run.caseId==='centered-isotropic-pc'){const p=result.PROBABILITY_RESULT;assert.equal(p.ALGORITHM,'LAAS_2015');assert.equal(p.CONVERGED,true);assert.ok(Math.abs(p.PROBABILITY-.00498752080731768)<=1e-12);return;}
  const cmp=compareToReference(catalogInReferenceUnits(result.CATALOG_RESULT),referenceEvents);
  assert.equal(cmp.counts.missingCount,0);assert.equal(cmp.counts.otherPairCount,0);assert.equal(result.CATALOG_RESULT.STATISTICS.FAILED_PAIRS,0);
  // Other close approaches of the reported pairs (SOCRATES's top three is not its full listing) must be within the threshold.
  for(const e of cmp.otherTcas)assert.ok(e.minRangeKm<=T.screening.socrates.thresholdKm);
  for(const m of cmp.matched){assert.ok(m.deltas.tcaDeltaSec<=T.tca.NLRV.hardFailSec);assert.ok(m.deltas.missDeltaM<=T.missDistance.socratesHardFailM);assert.ok(m.deltas.relSpeedDeltaMS<=T.relSpeed.hardFailMS);}
  numerical.push({lane:run.lane,workers:run.threadCount,sha256:createHash('sha256').update(run.stdout).digest('hex'),deltas:cmp.matched.map(m=>({pair:m.key,...m.deltas}))});
  report.threadEvidence.push({lane:run.lane,workers:run.threadCount,spawnCount:run.spawnCount,hardwareConcurrency:run.hardwareConcurrency});
  if(run.threadCount>1)assert.ok(run.spawnCount>=run.threadCount,'Required real guest worker spawns were not observed');
  });
}
check('required scientific runs',()=>assert.equal(numerical.length,12,'Every required worker/runtime scientific run must complete'));
check('scientific worker/runtime bytes',()=>assert.equal(new Set(numerical.map(n=>n.sha256)).size,1));
check('required exclusion runs',()=>assert.equal(exclusion.length,12,'Every decaying-catalog worker/runtime run must complete'));
check('exclusion worker/runtime bytes',()=>assert.equal(new Set(exclusion.map(n=>n.sha256)).size,1));
report.numerical=numerical;
report.exclusion=exclusion;
report.failures.push(...acceptance);report.ok&&=acceptance.length===0;
fs.writeFileSync(path.join(evidence,'cqr-runtime-parity.json'),JSON.stringify(report,null,2)+'\n');
console.log(formatParityReport(report));
console.log(JSON.stringify({numerical,exclusion,threadEvidence:report.threadEvidence},null,2));
if(!report.ok)process.exitCode=1;
