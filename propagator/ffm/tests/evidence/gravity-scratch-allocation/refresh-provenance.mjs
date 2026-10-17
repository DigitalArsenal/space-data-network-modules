#!/usr/bin/env node
// Authoring command for the allocation-only 1.4.1 release. Authenticate the
// previous documents and the full response equivalence proof before changing
// release identities. Every numerical field and every unrelated pin survives.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {assertRecordedNumbers} from '../recorded-numbers.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const evidence=path.resolve(here,'..'), ffm=path.resolve(evidence,'../..'), repo=path.resolve(ffm,'../..');
const hash=b=>createHash('sha256').update(b).digest('hex');
const read=p=>JSON.parse(fs.readFileSync(p));
const base=read(path.join(ffm,'tests/gravity-scratch-alloc/base.json'));
const git=(file)=>execFileSync('git',['show',`${base.commit}:${file}`],{cwd:repo,maxBuffer:128<<20,env:{...process.env,GIT_NO_LAZY_FETCH:'1'}});
const proofBytes=fs.readFileSync(path.join(here,'equivalence.json')), proof=JSON.parse(proofBytes);
const manifestPath='propagator/ffm/plugin-manifest.json', beforeManifest=git(manifestPath), afterManifest=fs.readFileSync(path.join(repo,manifestPath));
const manifest=JSON.parse(afterManifest), previousManifest=JSON.parse(beforeManifest);
const packagePath='propagator/ffm/package.json', beforePackage=git(packagePath), afterPackage=fs.readFileSync(path.join(repo,packagePath));
assert.deepEqual({...JSON.parse(afterPackage),version:JSON.parse(beforePackage).version},JSON.parse(beforePackage),'Package changes exceed the release version');
assert.equal(proof.ok,true);assert.equal(proof.caseCount,72);assert.equal(proof.rows.length,216);assert.equal(proof.toleranceBytes,0);
assert.equal(proof.baseCommit,base.commit);assert.equal(proof.originalModuleSha256,base.sha256);
assert.equal(proof.generatorSha256,hash(fs.readFileSync(path.join(here,'verify.mjs'))));
assert.equal(proof.beforeSha256,base.sameVersionReference.sha256);
assert.equal(proof.afterSha256,hash(fs.readFileSync(path.join(repo,base.wasm))));
assert.equal(proof.moduleVersion,manifest.version);assert.equal(manifest.version,'1.4.1');assert.equal(previousManifest.version,'1.4.0');
assert.deepEqual({...manifest,version:previousManifest.version},previousManifest,'Manifest changes exceed the release version');
assert.equal(hash(git(base.wasm)),base.sha256);
assert.equal(hash(git(base.sources)),proof.sourceSha256);
const cases=read(path.join(evidence,'cases/ffm-reference-cases.json')).cases;
const expected=new Set(cases.flatMap(c=>['suite','steps30','finest'].map(s=>`${c.id}|${s}`)));
for(const row of proof.rows){assert.ok(expected.delete(`${row.id}|${row.setting}`),'Duplicate or unknown equivalence case');assert.ok(row.bytes>0);assert.match(row.sha256,/^[a-f0-9]{64}$/);}
assert.equal(expected.size,0);
const changedSources=execFileSync('git',['diff','--name-only',base.commit,'--','propagator/ffm/lib','propagator/ffm/src','propagator/ffm/third_party','foundation/frames','foundation/astronomical-time'],{cwd:repo,encoding:'utf8'}).trim().split('\n');
assert.deepEqual(changedSources,[base.sources],'Production changes exceed the allocation fix');
const source=git(base.sources).toString();
const expectedSource=source.replace('// Initialize arrays — need up to degree maxDegree+1 for acceleration formulas','// Retain scratch rows across the degree-70, 30 and 4 recursions in one\n    // force evaluation. Shrinking freed 66 rows per array, allocating 132\n    // rows again on the next evaluation. Rows above N are never read.').replace('    V.resize(N + 1);','    if (V.size() < static_cast<size_t>(N + 1)) V.resize(N + 1);').replace('    W.resize(N + 1);','    if (W.size() < static_cast<size_t>(N + 1)) W.resize(N + 1);');
assert.equal(fs.readFileSync(path.join(repo,base.sources),'utf8'),expectedSource,'Allocation source differs from the proven storage-only change');
const names=['orekit/summary.json','gmat/summary-gmat-R2026a.json','gmat/summary-gmat-R2022a.json','gmat/anomalous-oxygen.json','gmat/variants.json','nyx/summary-nyx-2.6.0.json','nyx/drag-settings-diagnostic.json','tudat/ffm-tudatpy-1.0.0.json','tudat/ffm-tudat-wasm.json','tudat/summary-tudatpy-1.0.0.json','tudat/summary-tudat-wasm.json','basilisk/ffm-basilisk-2.12.0.json','basilisk/summary-basilisk-2.12.0.json','basilisk/diagnoses.json','erfa-spice/ffm-frames.json','erfa-spice/summary-erfa-spice.json','horizons/summary-horizons.json'];
const originals=new Map(names.map(name=>[name,git(`propagator/ffm/tests/evidence/${name}`)]));
let pins=new Map([[base.sha256,proof.afterSha256],[hash(beforeManifest),hash(afterManifest)],[hash(beforePackage),hash(afterPackage)]]), completed;
function migrate(value){
 if(typeof value==='string') return pins.get(value)??value;
 if(Array.isArray(value)) return value.map(migrate);
 if(!value||typeof value!=='object') return value;
 const result=Object.fromEntries(Object.entries(value).map(([key,item])=>[key,key==='previousSha256'?item:migrate(item)]));
 if(value.sha256===base.sha256 && value.version===previousManifest.version)result.version=manifest.version;
 return result;
}
for(let round=0;round<names.length+2;++round){
 const next=new Map(pins);completed=new Map();
 for(const name of names){
  const original=originals.get(name), old=JSON.parse(original), updated=migrate(old);
  updated.allocationEquivalence={file:path.relative(path.dirname(path.join(evidence,name)),path.join(here,'equivalence.json')),sha256:hash(proofBytes),previousCommit:base.commit,previousSha256:hash(original),statement:'Release identity refreshed after all 72 reference cases at three settings returned byte-identical responses through the authenticated same-version pre-fix and released WASM. Numerical fields and unrelated pins are unchanged.'};
  assertRecordedNumbers(updated,old,name);
  const bytes=Buffer.from(JSON.stringify(updated,null,1)+'\n');completed.set(name,bytes);next.set(hash(original),hash(bytes));
 }
 const stable=[...next].every(([key,value])=>pins.get(key)===value);pins=next;
 if(stable)break;
 if(round===names.length+1)throw new Error('Reference pin graph did not converge');
}
for(const[name,bytes]of completed){const actual=fs.readFileSync(path.join(evidence,name));assert.ok(actual.equals(originals.get(name))||actual.equals(bytes),`${name}: candidate contains changes outside this authenticated refresh`);}
for(const[name,bytes]of completed)fs.writeFileSync(path.join(evidence,name),bytes);
console.log(`Refreshed ${completed.size} evidence documents; every recorded number preserved; 216 raw responses identical.`);
