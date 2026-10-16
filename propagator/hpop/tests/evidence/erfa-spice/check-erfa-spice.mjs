#!/usr/bin/env node
// ONE offline E2E. Authenticates evidence/source bytes, checks complete row
// coverage and explanations, then re-evaluates ONLY the cheap TEME row at its
// 50 UTC epochs with the pinned ERFA C++ and foundation/frames code. The source
// and independently produced reference.json are hashed. C++ also re-scores the
// original stored matrices, preserving the historical number. No JS physics.
// Authoritative reference: ERFA eraPnm06a + eraEe06a, SOFA 20231011,
// GCRF -> TEME, mas, 2026-06-10/11 and 2026-08-02/03 UTC; physical limit .001
// mas. Reduction tolerance 1e-21 mas accommodates libc hypot's last bit;
// fresh HPOP tolerance 1e-9 mas accommodates compiler contraction; rebuilding
// both sides permits 1e-8 mas for C++ versus historical NumPy matrix rounding.
//   node tests/evidence/erfa-spice/check-erfa-spice.mjs [summary.json]
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {build,here,root} from './frame-diagnostics.mjs';
const expectedIds=['leap','tt','tdb','tdbSpice','forceClock','c2tSameInstant','c2tTrue','c2tClock','c2tSpice','c2tSpiceErfa','gmstSame','gmstTrue','c2tBuiltIn','coordsPrecession','coordsNutation','coordsTeme','c2tBuiltInClassical','teme','temeFk5','sunSame','sunTrue','moonSame','moonTrue'];
const errors=[],gaps=new Set(),verified=new Set();
const check=(ok,message)=>{if(!ok)errors.push(message);};
const nonempty=v=>typeof v==='string'&&v.trim().length>0;
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const summaryPath=path.resolve(process.argv[2]??path.join(here,'summary-erfa-spice.json'));
function verify(file,sha,label=file){
 if(!nonempty(file)||!nonempty(sha)){gaps.add(label);return;}
 check(/^[a-f0-9]{64}$/.test(sha),`invalid SHA-256: ${label}`);
 let p=path.resolve(here,file);
 if(!fs.existsSync(p)&&fs.existsSync(path.resolve(root,file)))p=path.resolve(root,file);
 if(!fs.existsSync(p)){gaps.add(label);return;}
 check(hash(p)===sha,`SHA-256 mismatch: ${label}`);verified.add(p);
}
async function main(){
 const s=JSON.parse(fs.readFileSync(summaryPath,'utf8'));
 const h=JSON.parse(fs.readFileSync(path.join(here,'hpop-frames.json'),'utf8'));
 const r=JSON.parse(fs.readFileSync(path.join(here,'reference.json'),'utf8'));
 const d=JSON.parse(fs.readFileSync(path.join(here,'diagnosis.json'),'utf8'));
 check(Array.isArray(s.fileHashes)&&s.fileHashes.length>0,'missing fileHashes');
 for(const entry of s.fileHashes??[])verify(entry.path,entry.sha256);
 verify(path.join(root,'propagator/hpop/dist/isomorphic/module.wasm'),s.module?.sha256,'shipped HPOP WASM');
 check(s.module?.sha256===h.module.sha256,'module identity differs from recorded HPOP evidence');
 check(s.module?.version===JSON.parse(fs.readFileSync(path.join(root,'propagator/hpop/package.json'),'utf8')).version,'module version mismatch');
 for(const [file,sha] of Object.entries(s.provenance?.sourceHashes??{}))verify(path.join(root,file),sha,file);
 for(const [file,sha] of Object.entries(h.sources)){
  check(s.provenance?.sourceHashes?.[file]===sha,`HPOP source identity differs: ${file}`);
  verify(path.join(root,file),sha,file);
 }
 const visit=(value,label='summary')=>{
  if(!value||typeof value!=='object')return;
  if('file'in value&&'sha256'in value)verify(value.file,value.sha256,label);
  if('path'in value&&'sha256'in value)verify(value.path,value.sha256,label);
  for(const [key,v]of Object.entries(value))if(typeof v==='object')visit(v,`${label}.${key}`);
 };visit(s);
 for(const [name,sha]of Object.entries(s.tools?.naifKernels??{})){
  const f=(s.fileHashes??[]).find(f=>path.basename(f.path)===name);
  check(f?.sha256===sha,`kernel identity differs: ${name}`);if(f)verify(f.path,sha,name);else gaps.add(name);
 }
 check(JSON.stringify(s.tools&&Object.fromEntries(Object.entries(s.tools).filter(([k])=>!['naifKernels','de440'].includes(k))))===JSON.stringify(r.tools),'tool versions differ from reference.json');
 const rows=s.rows??[],skipped=s.skipped??[];
 const ids=rows.map(row=>row.id);
 check(ids.length===expectedIds.length&&new Set(ids).size===expectedIds.length&&expectedIds.every(id=>ids.includes(id)),'row missing, duplicated or unknown in evidence table');
 check(Array.isArray(skipped)&&skipped.length===0,'this completed table has no skipped rows');
 check(s.epochs===50&&h.epochs.length===50&&r.epochs.length===50,'expected 50 HPOP/reference epochs');
 check(new Set(h.epochs.map(e=>e.utc)).size===50&&h.epochs.every(e=>r.epochs.some(x=>x.utc===e.utc)),'epoch coverage differs between evidence files');
 let misses=0,diagnosed=0;
 for(const row of rows){
  check(Number.isFinite(row.max)&&row.max>=0,`${row.id}: invalid score`);
  check(row.met===(row.tolerance===null?null:row.max<=row.tolerance),`${row.id}: met flag does not reflect recorded tolerance`);
  if(row.met===false){misses++;const c=row.cause;const present=['HPOP defect','HPOP precision property','reference spread','model-setting mismatch'].includes(c?.classification)&&nonempty(c?.statement)&&c?.evidence&&Object.keys(c.evidence).length>0;check(present,`${row.id}: missed limit lacks measured cause`);if(present)diagnosed++;}
 }
 check(s.verdict?.rows===rows.length&&s.verdict.met===rows.filter(r=>r.met===true).length&&s.verdict.missed===misses&&s.verdict.untoleranced===rows.filter(r=>r.met===null).length,'verdict counts disagree with table');
 check(JSON.stringify(s.verdict?.misses?.map(r=>r.id))===JSON.stringify(rows.filter(r=>r.met===false).map(r=>r.id)),'verdict does not list every missed row');
 check(s.verdict?.defects?.length===2&&s.verdict.defects.every(x=>nonempty(x.source)&&x.effect),'verdict must record both measured HPOP source defects');
 for(const file of ['hpop-frames.json','reference.json','diagnosis.json','frame-diagnostics.cpp','frame-diagnostics.mjs','check-erfa-spice.mjs'])check((s.fileHashes??[]).some(e=>path.resolve(here,e.path)===path.join(here,file)),`missing required pinned file ${file}`);
 const row=id=>rows.find(r=>r.id===id);
 check(row('c2tSpice')?.referenceSpreadBoundMas===row('c2tSpiceErfa')?.max,'SPICE bound must be the measured reference spread');
 check(row('coordsNutation')?.cause?.evidence?.coefficientMismatches?.length===d.coefficientMismatches.length,'nutation coefficient evidence differs from diagnosis');
 console.log(`Hashes: ${verified.size} available pinned files verified; ${gaps.size} informational hash gaps.`);
 console.log(`Coverage: ${rows.length} rows + ${skipped.length} skipped; ${misses} misses, ${diagnosed} with measured causes; ${h.epochs.length} epochs.`);
 // The only numerical row rerun by this E2E; compiler scratch stays here.
 const work=fs.mkdtempSync(path.join(here,'.check-erfa-spice-'));
 try{
  const run=await build(work),actual=run('teme',summaryPath);
  check(actual.comparison?.storedMatches,'teme: stored-matrix re-score mismatch');
  check(actual.comparison?.freshMatches,'teme: fresh HPOP re-score mismatch');
  check(actual.comparison?.freshBothMatches,'teme: fresh-both-sides re-score mismatch');
  check(actual.comparison?.referenceMatches,'teme: fresh ERFA reference replay mismatch');
  console.log(`Re-score: teme, stored=${actual.max} mas, fresh HPOP=${actual.freshMax} mas, fresh both=${actual.freshBothMax} mas; stored tolerance=${actual.comparison.storedToleranceMas} mas, fresh tolerances=${actual.comparison.freshToleranceMas}/${actual.comparison.freshBothToleranceMas} mas; ${actual.comparison.storedMatches&&actual.comparison.freshMatches&&actual.comparison.freshBothMatches&&actual.comparison.referenceMatches?'match':'MISMATCH'}.`);
 }catch(e){errors.push(`TEME re-score failed: ${e.message}`);}finally{fs.rmSync(work,{recursive:true,force:true});}
 for(const e of errors)console.error(`FAIL: ${e}`);
 console.log(`${errors.length?'FAIL':'PASS'} ERFA/SPICE evidence E2E: ${errors.length} failure(s).`);
 process.exitCode=errors.length?1:0;
}
await main().catch(e=>{console.error(`FAIL ERFA/SPICE evidence E2E: ${e.message}`);process.exitCode=1;});
