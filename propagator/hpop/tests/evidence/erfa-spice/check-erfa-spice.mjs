#!/usr/bin/env node
// Offline evidence E2E: authenticate pins, rebuild the production force/frame
// APIs, and rescore every numerical row against the pinned independent oracle.
// All physics and reductions are C++; JS handles files/processes and assertions.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {build,here,root} from './frame-diagnostics.mjs';
import {buildHpopFrames,eopStream} from './hpop-frames-native.mjs';
const errors=[],check=(ok,message)=>{if(!ok)errors.push(message);};
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const ids=['leap','tt','tdb','tdbSpice','forceClock','c2tSameInstant','c2tTrue','c2tClock','c2tSpice','c2tSpiceErfa','gmstSame','gmstTrue','c2tBuiltIn','coordsPrecession','coordsNutation','coordsTeme','c2tBuiltInClassical','teme','temeFk5','sunSame','sunTrue','moonSame','moonTrue','coordsEcefCio','coordsEcefSpice','coordsVelocityRates'];
async function main(){
 const s=read(process.argv[2]??path.join(here,'summary-erfa-spice.json')),h=read(path.join(here,'hpop-frames.json')),r=read(path.join(here,'reference.json'));
 for(const f of s.fileHashes??[]){const p=path.resolve(here,f.path);check(fs.existsSync(p)&&hash(p)===f.sha256,`SHA-256 mismatch: ${f.path}`);}
 check(s.module.sha256===hash(path.join(root,'propagator/hpop/dist/isomorphic/module.wasm')),'shipped module hash differs');
 check(s.module.version===read(path.join(root,'propagator/hpop/package.json')).version,'module version differs');
 check(JSON.stringify(s.module)===JSON.stringify(h.module),'HPOP evidence module identity differs');
 check(JSON.stringify(s.provenance.sourceHashes)===JSON.stringify(h.sources),'source identity differs');
 for(const[p,sha]of Object.entries(h.sources))check(hash(path.join(root,p))===sha,`source differs: ${p}`);
 check(s.rows.length===ids.length&&new Set(s.rows.map(x=>x.id)).size===ids.length&&ids.every(id=>s.rows.some(x=>x.id===id)),'row coverage differs');
 check(s.epochs===50&&h.epochs.length===50&&r.epochs.length===50,'epoch coverage differs');
 check(s.skipped?.length===0,'unexpected skipped rows');
 check(s.verdict.defects?.length===0,'HPOP defects remain');
 check(s.rows.filter(x=>x.met===false).every(x=>x.id==='c2tSpice'&&x.cause?.classification==='reference spread'),'unexpected missed limit');
 check(s.verdict.met===s.rows.filter(x=>x.met===true).length&&s.verdict.missed===s.rows.filter(x=>x.met===false).length&&s.verdict.untoleranced===s.rows.filter(x=>x.met===null).length,'verdict count mismatch');
 console.log(`Hashes: ${s.fileHashes.length} pinned files verified; module ${s.module.version}.`);
 console.log(`Coverage: ${s.rows.length} rows, 50 epochs; ${s.verdict.missed} reference-spread miss; ${s.verdict.defects.length} HPOP defects.`);
 const work=fs.mkdtempSync(path.join(here,'.check-erfa-spice-'));
 try{
  const score=await build(work),stored=score();
  for(const row of s.rows){const a=stored.scores[row.id];check(a?.max===row.max&&a?.met===row.met,`${row.id}: stored score mismatch`);}
  const cases=read(path.join(here,'../cases/hpop-reference-cases.json')),frames=await buildHpopFrames(work),epochs=[];
  const sets=new Map();for(const c of cases.cases)if(!sets.has(c.earthOrientation))sets.set(c.earthOrientation,c.sampleEpochsUtc);
  for(const[id,utcs]of sets)for(const e of frames.at(eopStream(work,cases,id),utcs,path.join(root,cases.models.ephemeris.path)))epochs.push({earthOrientation:id,...e});
  const file=path.join(work,'fresh.json');fs.writeFileSync(file,JSON.stringify({epochs}));const fresh=score(file);
  for(const row of s.rows){const a=fresh.scores[row.id];check(a?.max===row.max&&a?.met===row.met,`${row.id}: fresh HPOP score mismatch`);}
  for(const id of ['teme','coordsPrecession','coordsNutation','coordsTeme','c2tBuiltInClassical','c2tTrue']){const a=fresh.scores[id];check(a.met===true,`${id}: physical limit missed`);console.log(`Fresh ${id}: ${a.max} mas <= ${a.tolerance} mas; ${a.met?'PASS':'FAIL'}.`);}
  console.log(`Re-score: all ${s.rows.length} stored and fresh-source rows match pinned ERFA/SPICE references.`);
 }finally{fs.rmSync(work,{recursive:true,force:true});}
 for(const e of errors)console.error(`FAIL: ${e}`);
 console.log(`${errors.length?'FAIL':'PASS'} ERFA/SPICE evidence E2E: ${errors.length} failure(s).`);process.exitCode=errors.length?1:0;
}
await main().catch(e=>{console.error(`FAIL ERFA/SPICE evidence E2E: ${e.stack??e.message}`);process.exitCode=1;});
