// AP6 TESS replay, registered before this task reads rows or truth. Exploratory:
// all seven original 72-hour windows, 2026-07-27 through 2026-09-07 every 7 days.
// Same NASA definitive kernels, module-only TDB/UTC and EME2000/GCRF conversion,
// 300-second grid/thinning, 90% fit coverage, 260 samples per lead-day bin.
// Leads 1/3/7 start at fit end. No new windows or hold-outs. Every window printed.
// Amended 2026-11-11 (stack #479, comment 6808033865): the kernels' 60 s records are solution states only at minutes 0 mod 10;
// the records between are straight-line chords, up to about 1 km inside the orbit. The 300 s grid kept every second state from
// the chords. The reader `nodes` (the default) keeps the 10-minute states alone (lib/spk-nodes.mjs, the experiments' own rule
// since c8e5bedf), on their 600 s grid, with the coverage rule scaled to it: 90% fit coverage, 130 samples per lead-day bin.
// The reader `archive` is the 300 s reading the AP6 archive was scored on, kept for the comparison with that archive alone.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import * as fb from 'flatbuffers';
import {PCF} from 'spacedatastandards.org/lib/js/PCF/PCF.js';
import {experiments} from './experiments.mjs';
import {scratchRoot} from './scratch.mjs';
import {nodeLines} from './spk-nodes.mjs';
const modules=fileURLToPath(new URL('../../../../',import.meta.url));
const scratch=path.join(scratchRoot,'heo-frame');
const DAY=86400000,ms=l=>Date.parse(/Z$/.test(l.epoch)?l.epoch:l.epoch+'Z');
const hash=b=>createHash('sha256').update(b).digest('hex');
export const median=a=>{const v=a.toSorted((a,b)=>a-b),i=v.length>>1;return v.length%2?v[i]:(v[i-1]+v[i])/2;};
export async function tessWindows(modulePath,{reader='nodes'}={}){
 assert.ok(['nodes','archive'].includes(reader),`reader ${reader}`);
 const step=reader==='nodes'?600000:300000;
 process.env.SDN_MODULES_ROOT=modules;fs.mkdirSync(scratch,{recursive:true});
 const {XM}=await import(experiments+'/experiments/xp2-fit-design/common.mjs');
 const S=await import(experiments+'/experiments/xp-atmosphere-merit/lib/sds.mjs');
 const {openAp:openAp04,apForces}=await import(experiments+'/experiments/operator-theory/lib/ap.mjs');
 // this build on $OCM (ocm.mjs openApOcm), a 0.4 baseline as the vendored openAp drives it
 const O=await import(new URL('./ocm.mjs',import.meta.url).href),openAp=(p)=>O.legacyBuild(p)?openAp04(p):O.openApOcm(p);
 const {TESS}=await import(experiments+'/experiments/operator-theory/lib/regimes.mjs');
 const {spkObjectSeries}=await import(experiments+'/experiments/sdn-gp-starlink-ffm-match/lib/spk-sources.mjs');
 const {openAxes}=await import(experiments+'/experiments/operator-theory/lib/host.mjs');
 const files=fs.readdirSync(TESS.dir).filter(f=>/^TESS_EPH_DEF_.*\.bsp$/.test(f)).sort().map(f=>path.join(TESS.dir,f));
 const inputs=files.map(file=>({file,sha256:hash(fs.readFileSync(file))}));
 const key=hash(JSON.stringify({inputs,from:TESS.from,to:TESS.to,grid:reader==='nodes'?'nodes-600':300})),cache=path.join(scratch,key+'.json');let lines;
 if(fs.existsSync(cache))lines=JSON.parse(fs.readFileSync(cache));else{
  const s=await spkObjectSeries(modules,{files,source:'ap6-heo',id:'TESS (-95)',name:TESS.name,norad:TESS.norad,fromUtc:TESS.from,toUtc:TESS.to,stride:1});
  const kept=reader==='nodes'?nodeLines(s.lines):s.lines;
  const normalized=kept.map(l=>({...l,epoch:new Date(ms(l)).toISOString()})),first=Math.round(ms(normalized[0])/1000)*1000;
  const thin=normalized.filter(l=>(Math.round(ms(l)/1000)*1000-first)%step===0).map(l=>({...l,epoch:new Date(Math.round(ms(l)/1000)*1000).toISOString()}));
  // the 10-minute states, one per 600 s, none missing from the first to the last
  if(reader==='nodes')assert.ok(thin.every((l,k)=>!k||ms(l)-ms(thin[k-1])===step)&&thin.length===kept.length,'the kernels\' 10-minute states on one 600 s grid');
  const axes=await openAxes();lines=await axes.convert(thin,'EME2000','GCRF');await axes.close();fs.writeFileSync(cache,JSON.stringify(lines));
 }
 const store='/opt/data/sdn-archive/operator-theory/ap/b040/regimes',old=new Map();
 for(const f of fs.readdirSync(store).filter(f=>/^rows-.*\.jsonl$/.test(f)))for(const line of fs.readFileSync(path.join(store,f),'utf8').split('\n').filter(Boolean)){const r=JSON.parse(line);if(r.group==='HE'&&r.norad===43435)old.set(r.cutoff.slice(0,10),r);}
 const X=await import(new URL('./frames-cross.mjs',import.meta.url).href),frames030=await X.openCheckoutFrames();
 const a=await openAp(modulePath),outputAxes=await openAxes(),cfg={};for(const theory of ['AP','XP']){
  const obj=PCF.getRootAsPCF(new fb.ByteBuffer(S.pcfBytes({forces:theory==='AP'?apForces({}, {tesseral:31,zonal:20,atmosphere:false}):{},fit:null}))).unpack();
  // AP6 scored TEME output after its pinned foundation/frames conversion (the old path, kept beside the new score).
  const b=new fb.Builder(1024);PCF.finishPCFBuffer(b,obj.pack(b));cfg[theory]=b.asUint8Array().slice();
 }
 const rows=[];
 for(let index=0;index<7;index++){
  const cutoff=Date.parse('2026-07-27T00:00:00Z')+index*7*DAY,date=new Date(cutoff).toISOString().slice(0,10),prior=old.get(date);assert.ok(prior,'registered AP6 window exists');
  const row={reader,cutoff:date,archivedAP:prior.arms.AP72.days,archivedXP:prior.arms.XP72.days};
  // 90% of the arc's states and 260 of a day's 288 at 300 s; the same shares at 600 s (389 of 432, 130 of 144)
  const fit=lines.filter(l=>ms(l)>=cutoff-3*DAY&&ms(l)<=cutoff);assert.ok(fit.length>=.9*3*DAY/step,'fit coverage');
  const bins=[1,3,7].map(d=>lines.filter(l=>ms(l)>cutoff+(d-1)*DAY&&ms(l)<=cutoff+d*DAY));assert.ok(bins.every(b=>b.length>=260*300000/step),'lead coverage');
  const truth=bins.flat(),grid=S.gridBytes(truth.map(l=>l.epoch)),oem=S.oemBytes({frame:'GCRF',object:{name:'TESS',norad:43435,id:'2018-038A'},lines:fit,useableStart:fit[0].epoch,useableStop:new Date(cutoff).toISOString()});
  // #386: scored on the module's own GCRF output; <theory>Old: its TEME output through the pinned foundation/frames 0.2.0
  // (#389), the path AP6 was registered on; frames030Meters: that TEME output through this checkout's foundation/frames
  // 0.3.0 against the GCRF output
  const gridG=S.oemBytes({frame:'GCRF',lines:truth.map(l=>({epoch:l.epoch,r:[0,0,0]}))});
  const days=(states)=>{let at=0;const out={};for(let k=0;k<3;k++){let sum=0;for(const t of bins[k]){const p=states[at++];sum+=p.r.reduce((v,x,j)=>v+(x-t.r[j])**2,0);}out[[1,3,7][k]]=1000*Math.sqrt(sum/bins[k].length);}return out;};
  for(const theory of ['AP','XP']){const f=await a.fit(oem,cfg[theory]);assert.ok(f.ok,f.error);const own=await a.propagate(f.omm,gridG,cfg[theory],undefined,truth.length);const native=(await a.propagate(f.omm,grid,cfg[theory],undefined,truth.length)).map((v,k)=>({...v,epoch:truth[k].epoch}));
   row[theory]=days(own);row[theory+'Old']=days(await outputAxes.convert(native,'TEME','GCRF'));row[theory+'Frames030Meters']=X.largestMeters(await frames030.convert(native,'TEME','GCRF'),own);
   // the fitted set: its drag and radiation terms, the fit's RMS and states, and the weighting the record names (SPEC 12.1)
   if(!O.legacyBuild(modulePath)){const q=O.fittedOf(f.omm);row[theory+'Fit']={bterm:q.bterm,agom:q.agom,wrmsKm:q.wrms,states:q.accepted,weights:/(EQUAL|UNIT) WEIGHTS[^;]*/.exec(q.comment)?.[0]??null};}}
  // Through 0.6.12 XP reproduced the archived AP6 scoring within 1 mm (harness fidelity). From 0.6.13 a set above the drag
  // is fitted at the data's own sigma (SPEC 12.1), so XP's TESS fits move; each theory's error against the truth is kept
  // beside the archived one on the archive's path (<theory>Old), and heo-frame.e2e.mjs bounds them.
  row.XPMinusArchived={};row.APMinusArchived={};for(const day of [1,3,7]){row.XPMinusArchived[day]=row.XPOld[day]-1000*row.archivedXP[day].e;row.APMinusArchived[day]=row.APOld[day]-1000*row.archivedAP[day].e;}
  row.day3DifferenceMeters=row.AP[3]-row.XP[3];rows.push(row);console.log(JSON.stringify({exploratoryTess:row}));
 }
 await outputAxes.close();await frames030.close();return{exploratory:true,reader,stepSeconds:step/1000,units:'forward daily-bin 3D RMS meters; archived errors in km',inputs,moduleSha256:hash(fs.readFileSync(modulePath)),rows,pairedDay3DifferenceMeters:median(rows.map(r=>r.day3DifferenceMeters)),pairedDay3DifferenceMetersOld:median(rows.map(r=>r.APOld[3]-r.XPOld[3])),frames030Meters:Math.max(...rows.flatMap(r=>[r.APFrames030Meters,r.XPFrames030Meters])),historicalPairedDay3DifferenceMeters:median(rows.map(r=>1000*(r.archivedAP[3].e-r.archivedXP[3].e)))};
}
