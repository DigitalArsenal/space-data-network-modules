// Public wrapper acceptance using the same authoritative SOCRATES snapshot as
// verify-cqr-runtime-parity.mjs: TEME/UTC, .010s / 5m / 5m/s, no JS physics.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { normalizeParityFixture } from 'space-data-module-sdk/testing';
import { decodePluginInvokeResponse } from 'space-data-module-sdk/invoke';
import { runThreadedBrowserLane } from './cqr-browser-parity-lane.mjs';
import { initCqrFlatc, encodeCqr, decodeCqr, catalogRequest, gpRecord, publishedSchema, catalogInReferenceUnits } from '../tests/lib/cqr.mjs';
import { compareToReference, isoToJd } from '../tests/lib/screenCatalogParityHarness.mjs';
import { CA_PARITY_TOLERANCES as T } from '../tests/lib/caParityTolerances.mjs';
const flatc=await initCqrFlatc();
const refs=JSON.parse(fs.readFileSync(new URL('../tests/fixtures/socrates/reference.top3.json',import.meta.url))).conjunctions;
const objects=[];
for(const r of refs)objects.push(...JSON.parse(fs.readFileSync(new URL('../tests/fixtures/socrates/'+r.gp_file.replace(/\.txt$/,'.json'),import.meta.url))));
const events=refs.map(r=>({obj1Norad:r.obj1_norad,obj2Norad:r.obj2_norad,tcaJd:isoToJd(r.tca),missKm:r.min_range_km,relSpeedKms:r.rel_speed_kms,pc:r.max_prob}));
const startJd=Math.min(...objects.map(g=>isoToJd(g.EPOCH)))-.05;
const durationDays=Math.max(7,Math.max(...events.map(r=>r.tcaJd))-startJd+.25);
const input=(portId,code,payload)=>({portId,payload,typeRef:{schemaName:code+'.fbs',fileIdentifier:'$'+code,rootTypeName:code,wireFormat:'flatbuffer'}});
const payload=encodeCqr(flatc,catalogRequest({...T.screening.socrates,startJd,durationDays,numThreads:2}));
const plan=await normalizeParityFixture({name:'public-wrapper-SOCRATES',cases:[{id:'socrates-workers-2',threadCounts:[2],request:{methodId:'screen_catalog',inputs:[input('request','CQR',payload),...objects.map(g=>input('catalog','OMM',flatc.generateBinary(publishedSchema('OMM'),JSON.stringify(gpRecord(g)),{sizePrefix:false})))]}}]});
const wasmBytes=fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url));
const report={moduleSha256:createHash('sha256').update(wasmBytes).digest('hex'),oracle:'CelesTrak SOCRATES Plus, 2026-03-10 committed snapshot; https://celestrak.org/SOCRATES/',frame:'TEME',timeScale:'UTC',tolerances:{tcaSeconds:.010,missMetres:5,speedMetresPerSecond:5},toleranceRationale:'Proposal section8, tests/lib/caParityTolerances.mjs: NLRV timing, range quantization, speed regression.'};
try {
  const [run]=await runThreadedBrowserLane({plan,loadableBytes:wasmBytes,publicWrapper:true,timeoutMs:60000,log:console.log});
  Object.assign(report,{exitClass:run.exitClass,exitDetail:run.exitDetail,spawnCount:run.spawnCount});
  assert.equal(run.exitClass,'ok',run.exitDetail);
  assert.ok(run.spawnCount>=2);
  const response=decodePluginInvokeResponse(run.stdout);assert.equal(response.statusCode,0,response.errorMessage);
  const result=decodeCqr(flatc,response.outputs[0].payload).CATALOG_RESULT;
  const cmp=compareToReference(catalogInReferenceUnits(result),events);
  assert.equal(cmp.counts.missingCount,0);assert.equal(cmp.counts.otherPairCount,0);assert.equal(result.STATISTICS.FAILED_PAIRS,0);
  for(const e of cmp.otherTcas)assert.ok(e.minRangeKm<=T.screening.socrates.thresholdKm);
  for(const m of cmp.matched){assert.ok(m.deltas.tcaDeltaSec<=T.tca.NLRV.hardFailSec);assert.ok(m.deltas.missDeltaM<=T.missDistance.socratesHardFailM);assert.ok(m.deltas.relSpeedDeltaMS<=T.relSpeed.hardFailMS);}
  report.deltas=cmp.matched.map(m=>({pair:m.key,...m.deltas}));report.ok=true;
}catch(error){report.ok=false;report.error=error.message;process.exitCode=1;}
fs.writeFileSync(new URL('../../../docs/evidence/tmpl-lane-14/browser-wrapper.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
