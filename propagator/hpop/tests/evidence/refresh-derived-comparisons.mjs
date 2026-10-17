#!/usr/bin/env node
// Refresh only HPOP sides of stored diagnostic trajectories. No external
// reference engine is rerun and all numerical reductions remain C++/WASM.
// Run after the Tudat current-WASM cache and the primary GMAT/Basilisk tables.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ALL, CASES, run, buildMetrics } from './nyx/scoring.mjs';
import { buildMetrics as buildReduction } from './orekit/scoring.mjs';
import { readCache, storedResponse, scoreStored } from './tudat/scoring.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const read=f=>JSON.parse(fs.readFileSync(path.resolve(here,f),'utf8'));
const write=(f,o)=>fs.writeFileSync(path.resolve(here,f),JSON.stringify(o,null,1)+'\n');
const hash=f=>createHash('sha256').update(fs.readFileSync(path.resolve(here,f))).digest('hex');
const refresh={module:{version:read('../../package.json').version,file:'../../../dist/isomorphic/module.wasm',sha256:hash('../../dist/isomorphic/module.wasm')},
 source:{path:'../refresh-derived-comparisons.mjs',sha256:hash('refresh-derived-comparisons.mjs')},
 reductions:[{path:'../nyx/score-metrics.cpp',sha256:hash('nyx/score-metrics.cpp')},{path:'../consolidated-metrics.cpp',sha256:hash('consolidated-metrics.cpp')}]};
const work=fs.mkdtempSync(path.join(here,'.refresh-derived-'));
try {
 const metrics=buildMetrics(work),cache=readCache(path.join(here,'tudat/hpop-tudatpy-1.0.0.json'));
 const reduceWork=path.join(work,'reduction');fs.mkdirSync(reduceWork);const reduce=buildReduction(reduceWork);
 const get=async(g,s)=>{
  let c=cache.cases.find(c=>c.id===g.id);if(!c){c={id:g.id};cache.cases.push(c);}
  if(!c[s.id])c[s.id]=storedResponse(await run(g,s));return c[s.id];
 };
 if(process.argv.includes('--nyx')) {
  const d=read('nyx/drag-settings-diagnostic.json');
  for(const row of d.cases){const g=d.trajectories.find(g=>g.id===row.id);row.finest=scoreStored(await get(g,ALL[2]),g,metrics);row.finest.met=reduce({mode:'met',value:row.finest.worstM,limit:CASES.protocol.tolerancesM.default.drag});console.log(`Nyx WGS84 diagnostic ${row.id}: ${row.finest.worstM} m`);}
  d.hpopRefresh=refresh;write('nyx/drag-settings-diagnostic.json',d);
 }
 if(process.argv.includes('--gmat')) {
  const consolidated=path.join(work,'consolidated-metrics');
  execFileSync('c++',['-std=c++17','-O2','-ffp-contract=off','-I',path.resolve(here,'../../src/cpp/include'),path.join(here,'consolidated-metrics.cpp'),'-o',consolidated],{cwd:work,env:{...process.env,TMPDIR:work}});
  const native=input=>JSON.parse(execFileSync(consolidated,[],{input:JSON.stringify(input),encoding:'utf8',maxBuffer:16<<20}));
  const oxygen=read('gmat/anomalous-oxygen.json'),primary=read('gmat/summary-gmat-R2026a.json');
  for(const row of oxygen.rows) {
   const c=CASES.cases.find(c=>c.id===row.id);
   const stem=path.join('/Users/tj/software/tools/xval/gmat-work/anomalous-oxygen',row.id.replaceAll(' ','_'));
   const script=fs.readFileSync(stem+'.script','utf8'),cd=/GMAT Sat\.Cd = ([\d.eE+-]+);/.exec(script);
   const diagnostic={eps:row.eps,baseCd:c.forces.drag.cd,Cd:Number(cd[1]),gmatReport:fs.readFileSync(stem+'.txt','utf8')};
   row.hpopMinusGmatCdScaledM=native({mode:'refresh-gmat-diagnostic',diagnostic,case:c,hpop:await get(c,ALL[1])}).worstM;
   row.hpopMinusGmatM=primary.cases.find(r=>r.id===row.id).steps30.worstM;
   console.log(`GMAT Cd-scaled diagnostic ${row.id}: ${row.hpopMinusGmatCdScaledM} m`);
  }
  oxygen.hpopRefresh=refresh;write('gmat/anomalous-oxygen.json',oxygen);
  const variants=read('gmat/variants.json'),dir='/Users/tj/software/tools/xval/gmat-work/variants';
  for(const variant of variants.variants) {
   const references=fs.readdirSync(dir).filter(f=>f.startsWith(variant.id+'-')&&f.endsWith('.json')&&!f.endsWith('.summary.json')).flatMap(f=>JSON.parse(fs.readFileSync(path.join(dir,f),'utf8')).cases);
   for(const row of variant.cases){const g=references.find(g=>g.id===row.id);if(!g)throw new Error(`Missing stored variant ${variant.id} ${row.id}`);row.hpopMinusGmatM=scoreStored(await get(g,ALL[1]),g,metrics).worstM;}
   console.log(`GMAT ${variant.id}: ${variant.cases.length} HPOP scores refreshed`);
  }
  variants.hpopRefresh=refresh;write('gmat/variants.json',variants);
 }
 if(process.argv.includes('--basilisk')) {
  const d=read('basilisk/diagnoses.json'),s=read('basilisk/summary-basilisk-2.12.0.json');
  for(const row of d.cases) {
   const walk=value=>{
    if(!value||typeof value!=='object')return;
    if(value.trajectory&&value.hpopWorstM) {
     const rows=value.trajectory==='basilisk-2.12.0.json'?s.cases:Object.values(s.diagnostics).find(x=>x.file===value.trajectory)?.cases;
     const current=rows?.find(c=>c.id===row.id);if(!current)throw new Error(`Missing Basilisk diagnostic ${value.trajectory} ${row.id}`);
     value.hpopWorstM=Object.fromEntries(ALL.map(x=>[x.id,current[x.id].worstM]));
    }
    for(const child of Object.values(value))walk(child);
   };walk(row);
  }
  d.hpopRefresh=refresh;write('basilisk/diagnoses.json',d);console.log(`Basilisk: ${d.cases.length} measured-cause HPOP fields refreshed`);
 }
}finally{fs.rmSync(work,{recursive:true,force:true});}
