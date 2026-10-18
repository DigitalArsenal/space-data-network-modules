#!/usr/bin/env node
// Authenticate a saved T3/reference run and compare a newly executed FFM run.
// Historical source is read from its immutable commit; no product legacy mode.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { modulesRoot, loadCatalog, selectCatalog, sha256 } from './benchmark-catalog.mjs';
import { compareEvents } from './ca-comparison.mjs';
import { REFERENCE_INTEGRATOR } from './reference-farm.mjs';
const { values: o } = parseArgs({ options: Object.fromEntries(
  ['baseline','candidate','reference','provenance','pipeline','catalog','out'].map(k=>[k,{type:'string'}])) });
for (const key of ['baseline','candidate','reference','provenance','pipeline','catalog','out']) assert(o[key], `Missing --${key}`);
const read=p=>JSON.parse(fs.readFileSync(p));
const baseline=read(o.baseline),standard=Array.isArray(baseline.screen)?baseline.screen[0]:baseline;
const candidate=read(o.candidate),reference=read(o.reference),provenance=read(o.provenance),pipeline=read(o.pipeline);
const catalog=loadCatalog(o.catalog),selected=selectCatalog(catalog.records,2000);
assert.equal(reference.objects,2000);assert.equal(reference.days,1);
assert.equal(reference.catalogSha256,catalog.sha256);
assert.equal(reference.selectedIdsSha256,sha256(JSON.stringify(selected.records.map(r=>r.NORAD_CAT_ID))));
assert.deepEqual(provenance.referenceIntegrator,REFERENCE_INTEGRATOR);
assert.equal(provenance.truthSettings.integrator,'RKF78');
assert.equal(provenance.truthSettings.relativeTolerance,REFERENCE_INTEGRATOR.tolerance);
assert.equal(provenance.truthSettings.maximumStepSeconds,REFERENCE_INTEGRATOR.maxStep);
assert(/^[0-9a-f]{40}$/.test(provenance.candidate));
const authenticated={historicalSources:{},adapters:{},pipeline:{}};
for(const [file,hash] of Object.entries(provenance.sourceHashes)) {
  const bytes=execFileSync('git',['show',`${provenance.candidate}:${file}`],{cwd:modulesRoot,maxBuffer:64*1024*1024});
  assert.equal(sha256(bytes),hash,`Recorded reference source changed: ${file}`);authenticated.historicalSources[file]=hash;
}
for(const [file,hash] of Object.entries(provenance.adapterHashes)) {
  assert.equal(sha256(fs.readFileSync(path.join(path.dirname(o.provenance),file))),hash,`Reference adapter changed: ${file}`);authenticated.adapters[file]=hash;
}
for(const [file,hash] of Object.entries(pipeline.runtimeArtifactSha256)) {
  assert.equal(sha256(fs.readFileSync(path.join(modulesRoot,file))),hash,`Epoch-state/CA pipeline changed: ${file}`);authenticated.pipeline[file]=hash;
}
const referenceHash=sha256(fs.readFileSync(path.join(modulesRoot,'propagator/ffm/tests/reference/dist/isomorphic/module.wasm')));
for(const run of [standard,reference])assert.equal(run.wasmSha256,referenceHash);
assert.equal(referenceHash,provenance.standardWasmSha256);
const candidateHash=sha256(fs.readFileSync(path.join(modulesRoot,'propagator/ffm/dist/isomorphic/module.wasm')));
assert.equal(candidate.wasmSha256,candidateHash);
const result={...compareEvents(standard,candidate,reference,catalog.records,modulesRoot,sha256),authenticated,
  referenceIntegrator:REFERENCE_INTEGRATOR,referenceWasmSha256:referenceHash,candidateWasmSha256:candidateHash,
  evidenceSha256:Object.fromEntries(['baseline','candidate','reference','provenance','pipeline'].map(k=>[k,sha256(fs.readFileSync(o[k]))])),
  limitations:['Synthetic weather and a stratified 2,000-object population; no full-catalog accuracy claim.','GP sigma is diagnostic only.']};
fs.writeFileSync(o.out,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({pass:result.pass,eventSets:result.eventSets,inDomain:result.inDomain,outOfDomain:result.outOfDomain,output:o.out}));
if(!result.pass)process.exitCode=1;
