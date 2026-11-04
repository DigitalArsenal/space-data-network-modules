// Registered before reading AP6 metadata or truth for this test. Use every GE/IG
// object in AP6's calibration store, new 72-hour fit cutoffs 2025-10-05/09/13 UTC.
// These cutoffs are absent from AP6 (04/06/08/10/12), but truth spans overlap;
// this is new-window confirmation, not independent-object or independent-truth
// validation. No hold-outs or other classes are opened. Same 300-s thinning,
// 90% fit coverage, 260 samples/day minimum, forward bins 1/3/7, as-issued weather.
// Print every window, preserve failures, report paired medians without selecting
// a step on these errors. Compare independently refitted 95-min and selected arms.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as fb from 'flatbuffers';
import {PCF} from 'spacedatastandards.org/lib/js/PCF/PCF.js';
import {PCFOutputT} from 'spacedatastandards.org/lib/js/PCF/PCFOutput.js';
import {pcfOutputFrame} from 'spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js';
import {experiments as root} from './experiments.mjs';
const scratch='/Users/tj/software/terrain-work/body-look/codex-apfix-d9';
const DAY=86400000,cutoffs=['2025-10-05','2025-10-09','2025-10-13'];
const median=a=>{const b=a.toSorted((a,b)=>a-b),n=b.length;return n%2?b[(n-1)/2]:(b[n/2-1]+b[n/2])/2;};
export async function confirmWindows(baseline,candidate){
 const jobs=Array.from({length:12},(_,shard)=>new Promise((resolve,reject)=>{const log=fs.openSync(path.join(scratch,`geo-windows-${shard}.log`),'w');const p=spawn(process.execPath,[fileURLToPath(import.meta.url),'--worker',String(shard),baseline,candidate],{env:{...process.env,SDN_MODULES_ROOT:path.resolve(fileURLToPath(new URL('../../../../',import.meta.url)))},stdio:['ignore',log,log]});p.on('error',reject);p.on('exit',code=>{fs.closeSync(log);code===0?resolve():reject(new Error(`GE/IG shard ${shard} failed; see geo-windows-${shard}.log`));});}));
 await Promise.all(jobs);const rows=Array.from({length:12},(_,i)=>JSON.parse(fs.readFileSync(path.join(scratch,`geo-windows-${i}.json`)))).flat();
 for(const row of rows)console.log(JSON.stringify({confirmation:row}));
 const summary=[];for(const group of ['GE','IG'])for(const day of [1,3,7]){const paired=rows.filter(r=>r.group===group&&r.baseline?.[day]!==undefined&&r.candidate?.[day]!==undefined);assert.ok(paired.length>0,`${group} day ${day} confirmation present`);summary.push({group,day,windows:paired.length,baselineMedianMeters:median(paired.map(r=>r.baseline[day])),candidateMedianMeters:median(paired.map(r=>r.candidate[day])),medianPairedChangeMeters:median(paired.map(r=>r.candidate[day]-r.baseline[day]))});}
 const result={cutoffs,fitHours:72,sharedTruthSpan:true,rows,summary,baselineSha256:createHash('sha256').update(fs.readFileSync(baseline)).digest('hex'),candidateSha256:createHash('sha256').update(fs.readFileSync(candidate)).digest('hex')};console.log(JSON.stringify({confirmationSummary:summary}));return result;
}
if(process.argv[2]==='--worker'){
 const shard=Number(process.argv[3]),[baseline,candidate]=process.argv.slice(4);
 const {XM}=await import(root+'/experiments/xp2-fit-design/common.mjs');
 const S=await import(root+'/experiments/xp-atmosphere-merit/lib/sds.mjs');
 const W=await import(root+'/experiments/xp-atmosphere-merit/lib/weather.mjs');
 const {chain}=await import(root+'/experiments/sdn-gp-starlink-ffm-match/lib/sources.mjs');
 const {openAp:openAp04,apForces}=await import(root+'/experiments/operator-theory/lib/ap.mjs');
 // this build on $OCM (ocm.mjs openApOcm), a 0.4 baseline as the vendored openAp drives it
 const O=await import(new URL('./ocm.mjs',import.meta.url).href),openAp=(p)=>O.legacyBuild(p)?openAp04(p):O.openApOcm(p);
 const store='/opt/data/sdn-archive/operator-theory/ap/b040/regimes',objects=new Map(),spent=new Set();
 for(const f of fs.readdirSync(store).filter(f=>/^rows-.*\.jsonl$/.test(f)))for(const line of fs.readFileSync(path.join(store,f),'utf8').trim().split('\n').filter(Boolean)){const r=JSON.parse(line);if(!['GE','IG'].includes(r.group))continue;objects.set(r.norad,{norad:r.norad,name:r.name,group:r.group});spent.add(`${r.norad}|${r.cutoff.slice(0,10)}`);}
 const arms={baseline:await openAp(baseline),candidate:await openAp(candidate)},rows=[];
 const obj=PCF.getRootAsPCF(new fb.ByteBuffer(S.pcfBytes({forces:apForces(XM.config.arms.X2.forces,{tesseral:31,zonal:20}),fit:null}))).unpack();obj.OUTPUT=Object.assign(new PCFOutputT(),{OUTPUT_FRAME:pcfOutputFrame.GCRF});const builder=new fb.Builder(1024);PCF.finishPCFBuffer(builder,obj.pack(builder));const cfg=builder.asUint8Array().slice();
 const ref='/opt/data/sdn-archive/e14-covariance-realism/reference';
 for(const [index,o] of [...objects.values()].sort((a,b)=>a.norad-b.norad).entries()){
  if(index%12!==shard)continue;
  const files=Array.from({length:20},(_,k)=>path.join(ref,`GFZ0MGXRAP_2025${274+k}0000_01D_05M_ORB`,`${o.norad}.oem`)).filter(fs.existsSync);
  const lines=chain(files).lines,ms=l=>Date.parse(l.epoch.endsWith('Z')?l.epoch:l.epoch+'Z');
  for(const date of cutoffs){assert.ok(!spent.has(`${o.norad}|${date}`),'new cutoff absent from AP6');const cutoff=Date.parse(date+'T00:00:00Z'),row={...o,cutoff:date};
   try{const fit=lines.filter(l=>ms(l)>=cutoff-3*DAY&&ms(l)<=cutoff);assert.ok(fit.length>=.9*864,'fit coverage');const step=(ms(fit[1])-ms(fit[0]))/1000,thin=fit.filter((_,i)=>i%Math.max(1,Math.round(300/step))===0);const bins=[1,3,7].map(d=>lines.filter(l=>ms(l)>cutoff+(d-1)*DAY&&ms(l)<=cutoff+d*DAY));assert.ok(bins.every(b=>b.length>=260),'lead coverage');const truth=bins.flat(),epochs=truth.map(l=>l.epoch);const weather=W.rowsO(cutoff-3*DAY-XM.config.conditions.rowsMarginDays*DAY,cutoff);assert.ok(!weather.excluded,String(weather.excluded));const extra={rows:S.spwBytes(weather.rows)};const oem=S.oemBytes({frame:'GCRF',object:{name:o.name,norad:o.norad,id:''},lines:thin,useableStart:thin[0].epoch,useableStop:new Date(cutoff).toISOString()});
    for(const [arm,module] of Object.entries(arms)){const fitted=await module.fit(oem,cfg,extra);assert.ok(fitted.ok,fitted.error);const states=await module.propagate(fitted.omm,S.oemBytes({frame:'GCRF',lines:epochs.map(epoch=>({epoch,r:[0,0,0]}))}),cfg,extra,epochs.length);let at=0;row[arm]={};for(let k=0;k<3;k++){let sum=0;for(const l of bins[k]){const p=states[at++];sum+=p.r.reduce((s,v,j)=>s+(v-l.r[j])**2,0);}row[arm][[1,3,7][k]]=Math.sqrt(sum/bins[k].length)*1000;}}
   }catch(e){row.error=String(e.message);}rows.push(row);
  }
 }
 fs.writeFileSync(path.join(scratch,`geo-windows-${shard}.json`),JSON.stringify(rows));process.exit(0);
}
