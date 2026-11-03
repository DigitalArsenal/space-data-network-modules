// AP6 TESS replay, registered before this task reads rows or truth. Exploratory:
// all seven original 72-hour windows, 2026-07-27 through 2026-09-07 every 7 days.
// Same NASA definitive kernels, module-only TDB/UTC and EME2000/GCRF conversion,
// 300-second grid/thinning, 90% fit coverage, 260 samples per lead-day bin.
// Leads 1/3/7 start at fit end. No new windows or hold-outs. Every window printed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import * as fb from 'flatbuffers';
import {PCF} from 'spacedatastandards.org/lib/js/PCF/PCF.js';
import {experiments} from './experiments.mjs';
const modules=fileURLToPath(new URL('../../../../',import.meta.url));
const scratch='/Users/tj/software/terrain-work/body-look/codex-apfix-d9/heo-frame';
const DAY=86400000,ms=l=>Date.parse(/Z$/.test(l.epoch)?l.epoch:l.epoch+'Z');
const hash=b=>createHash('sha256').update(b).digest('hex');
export const median=a=>{const v=a.toSorted((a,b)=>a-b),i=v.length>>1;return v.length%2?v[i]:(v[i-1]+v[i])/2;};
export async function tessWindows(modulePath){
 process.env.SDN_MODULES_ROOT=modules;fs.mkdirSync(scratch,{recursive:true});
 const {XM}=await import(experiments+'/experiments/xp2-fit-design/common.mjs');
 const S=await import(experiments+'/experiments/xp-atmosphere-merit/lib/sds.mjs');
 const {openAp,apForces}=await import(experiments+'/experiments/operator-theory/lib/ap.mjs');
 const {TESS}=await import(experiments+'/experiments/operator-theory/lib/regimes.mjs');
 const {spkObjectSeries}=await import(experiments+'/experiments/sdn-gp-starlink-ffm-match/lib/spk-sources.mjs');
 const {openAxes}=await import(experiments+'/experiments/operator-theory/lib/host.mjs');
 const files=fs.readdirSync(TESS.dir).filter(f=>/^TESS_EPH_DEF_.*\.bsp$/.test(f)).sort().map(f=>path.join(TESS.dir,f));
 const inputs=files.map(file=>({file,sha256:hash(fs.readFileSync(file))}));
 const key=hash(JSON.stringify({inputs,from:TESS.from,to:TESS.to,grid:300})),cache=path.join(scratch,key+'.json');let lines;
 if(fs.existsSync(cache))lines=JSON.parse(fs.readFileSync(cache));else{
  const s=await spkObjectSeries(modules,{files,source:'ap6-heo',id:'TESS (-95)',name:TESS.name,norad:TESS.norad,fromUtc:TESS.from,toUtc:TESS.to,stride:1});
  const normalized=s.lines.map(l=>({...l,epoch:new Date(ms(l)).toISOString()})),first=Math.round(ms(normalized[0])/1000)*1000;
  const thin=normalized.filter(l=>(Math.round(ms(l)/1000)*1000-first)%300000===0).map(l=>({...l,epoch:new Date(Math.round(ms(l)/1000)*1000).toISOString()}));
  const axes=await openAxes();lines=await axes.convert(thin,'EME2000','GCRF');await axes.close();fs.writeFileSync(cache,JSON.stringify(lines));
 }
 const store='/opt/data/sdn-archive/operator-theory/ap/b040/regimes',old=new Map();
 for(const f of fs.readdirSync(store).filter(f=>/^rows-.*\.jsonl$/.test(f)))for(const line of fs.readFileSync(path.join(store,f),'utf8').split('\n').filter(Boolean)){const r=JSON.parse(line);if(r.group==='HE'&&r.norad===43435)old.set(r.cutoff.slice(0,10),r);}
 const a=await openAp(modulePath),outputAxes=await openAxes(),cfg={};for(const theory of ['AP','XP']){
  const obj=PCF.getRootAsPCF(new fb.ByteBuffer(S.pcfBytes({forces:theory==='AP'?apForces({}, {tesseral:31,zonal:20,atmosphere:false}):{},fit:null}))).unpack();
  // AP6 scores TEME output after its pinned foundation/frames conversion.
  const b=new fb.Builder(1024);PCF.finishPCFBuffer(b,obj.pack(b));cfg[theory]=b.asUint8Array().slice();
 }
 const rows=[];
 for(let index=0;index<7;index++){
  const cutoff=Date.parse('2026-07-27T00:00:00Z')+index*7*DAY,date=new Date(cutoff).toISOString().slice(0,10),prior=old.get(date);assert.ok(prior,'registered AP6 window exists');
  const row={cutoff:date,archivedAP:prior.arms.AP72.days,archivedXP:prior.arms.XP72.days};
  const fit=lines.filter(l=>ms(l)>=cutoff-3*DAY&&ms(l)<=cutoff);assert.ok(fit.length>=.9*864,'fit coverage');
  const bins=[1,3,7].map(d=>lines.filter(l=>ms(l)>cutoff+(d-1)*DAY&&ms(l)<=cutoff+d*DAY));assert.ok(bins.every(b=>b.length>=260),'lead coverage');
  const truth=bins.flat(),grid=S.gridBytes(truth.map(l=>l.epoch)),oem=S.oemBytes({frame:'GCRF',object:{name:'TESS',norad:43435,id:'2018-038A'},lines:fit,useableStart:fit[0].epoch,useableStop:new Date(cutoff).toISOString()});
  for(const theory of ['AP','XP']){const f=await a.fit(oem,cfg[theory]);assert.ok(f.ok,f.error);const native=await a.propagate(f.omm,grid,cfg[theory],undefined,truth.length);const states=await outputAxes.convert(native.map((v,k)=>({...v,epoch:truth[k].epoch})),'TEME','GCRF');let at=0;row[theory]={};for(let k=0;k<3;k++){let sum=0;for(const t of bins[k]){const p=states[at++];sum+=p.r.reduce((v,x,j)=>v+(x-t.r[j])**2,0);}row[theory][[1,3,7][k]]=1000*Math.sqrt(sum/bins[k].length);}}
  for(const day of [1,3,7])assert.ok(Math.abs(row.XP[day]-1000*row.archivedXP[day].e)<.001,'XP reproduces archived AP6 scoring within 1 mm');
  row.day3DifferenceMeters=row.AP[3]-row.XP[3];rows.push(row);console.log(JSON.stringify({exploratoryTess:row}));
 }
 await outputAxes.close();return{exploratory:true,units:'forward daily-bin 3D RMS meters; archived errors in km',inputs,moduleSha256:hash(fs.readFileSync(modulePath)),rows,pairedDay3DifferenceMeters:median(rows.map(r=>r.day3DifferenceMeters)),historicalPairedDay3DifferenceMeters:median(rows.map(r=>1000*(r.archivedAP[3].e-r.archivedXP[3].e)))};
}
