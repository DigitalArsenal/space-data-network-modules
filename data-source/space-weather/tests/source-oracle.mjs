// Test-only independent reader of the five sources. It rebuilds the published series from the sources alone, by the
// rules in README.md, and holds every published record to it (the record set, not a sample of it).
// Units: F10.7 sfu, Kp*10 integers, Ap dimensionless; days are UTC dates.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const BEFORE=40, AHEAD=400, HALF=40, TRAILING=80, CLIMATOLOGY_DAYS=365, PRODUCER='space-weather/0.3.0';
// The standard Kp-ap table, Kp 0o..9o in thirds. verifySources holds it to every (Kp, ap) pair of GFZ's file.
export const AP_OF_KP_THIRD=[0,2,3,4,5,6,7,9,12,15,18,22,27,32,39,48,56,67,80,94,111,132,154,179,207,236,300,400];
// The five sources, in the canonical order the module requests and hashes them in.
export const SOURCE_URLS=[
 'https://kp.gfz.de/fileadmin/files_for_gfz_cms/Kp_ap_Ap_SN_F107_since_1932.txt',
 'https://kp.gfz.de/fileadmin/files_for_gfz_cms/Kp_ap_Ap_SN_F107_nowcast.txt',
 'https://services.swpc.noaa.gov/text/45-day-forecast.txt',
 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json',
 'https://services.swpc.noaa.gov/json/solar-cycle/predicted-solar-cycle.json'];
const DAY_MS=86400000, MONTHS='JanFebMarAprMayJunJulAugSepOctNovDec';
const dayNumber=(y,m,d)=>Math.floor(Date.UTC(y,m-1,d)/DAY_MS);
const isoOf=n=>new Date(n*DAY_MS).toISOString().slice(0,10);

// GFZ lines: y m d, 2 day counts, Bartels number and day, Kp1..8, ap1..8, Ap, SN, F10.7 obs, F10.7 adj, D. Later bodies win.
function readGfz(bodies) {
 const days=new Map(), pairs=[];
 for(const body of bodies)for(const line of body.toString().split('\n')) {
  if(!line||line.startsWith('#'))continue;
  const v=line.trim().split(/\s+/).map(Number);assert.equal(v.length,28,'GFZ columns');
  const kp=v.slice(7,15),aps=v.slice(15,23);
  for(let i=0;i<8;i++)if(kp[i]>=0&&aps[i]>=0)pairs.push([Math.round(kp[i]*3),aps[i]]);
  days.set(dayNumber(v[0],v[1],v[2]),{kp:kp.map(k=>k<0?-1:Math.round(k*10)),aps,ap:v[23],flux:v[25],adj:v[26]});
 }
 return {days,pairs};
}
function readForecast45(body) {
 const [apPart,fluxPart,...rest]=body.toString().split(/45-DAY F10\.7 CM FLUX FORECAST/);assert.equal(rest.length,0);
 const read=text=>new Map([...text.matchAll(/(\d{2})([A-Z][a-z]{2})(\d{2})\s+(\d+)/g)].map(m=>[dayNumber(2000+Number(m[3]),MONTHS.indexOf(m[2])/3+1,Number(m[1])),Number(m[4])]));
 const ap=read(apPart),flux=read(fluxPart);assert.equal(ap.size,45,'45 Ap days');assert.equal(flux.size,45,'45 flux days');
 return {ap,flux,last:Math.max(...flux.keys())};
}
function readKpFeed(body) {
 const feed=new Map();
 for(const e of JSON.parse(body)) {
  const day=dayNumber(Number(e.time_tag.slice(0,4)),Number(e.time_tag.slice(5,7)),Number(e.time_tag.slice(8,10))),slot=Number(e.time_tag.slice(11,13))/3;
  const kp=feed.get(day)??Array(8).fill(-1);if(kp[slot]<0)kp[slot]=Math.round(e.kp*10);feed.set(day,kp);
 }
 return feed;
}
// Monthly F10.7 at each month's midpoint; the value at noon of day d is linear between the two midpoints around it.
function readCycle(body) {
 const anchors=JSON.parse(body).map(e=>{const [y,m]=e['time-tag'].split('-').map(Number);return [(Date.UTC(y,m-1,1)+Date.UTC(y,m,1))/2/DAY_MS,e['predicted_f10.7']];});
 return d=>{
  const t=d+0.5;if(t<anchors[0][0]||t>anchors.at(-1)[0])return null;
  const i=anchors.findIndex((a,k)=>k>0&&a[0]>=t);const [t0,v0]=anchors[i-1],[t1,v1]=anchors[i];
  return v0+(v1-v0)*(t-t0)/(t1-t0);
 };
}
// The Kp (times ten) whose table ap is nearest to ap; a tie goes to the lower Kp.
export function kpOfAp(ap) {
 let best=0;for(let t=1;t<AP_OF_KP_THIRD.length;t++)if(Math.abs(AP_OF_KP_THIRD[t]-ap)<Math.abs(AP_OF_KP_THIRD[best]-ap))best=t;
 return Math.round(best*10/3);
}
export const batchHash=(urls,bodies)=>{const h=createHash('sha256');urls.forEach((u,i)=>{h.update(u+'\0');h.update(bodies[i]);});return h.digest('hex');};

// What the sources say the published records are, in order.
export function expectedSeries(bodies,todayIso) {
 const today=Math.floor(Date.parse(todayIso+'T00:00:00Z')/DAY_MS);
 const {days:gfz,pairs}=readGfz(bodies.slice(0,2)),forecast=readForecast45(bodies[2]),feed=readKpFeed(bodies[3]),cycleAt=readCycle(bodies[4]);
 for(const [third,ap] of pairs)if(AP_OF_KP_THIRD[third]!==ap)assert.fail(`Kp-ap table disagrees with GFZ at Kp third ${third}: ${ap}`);
 // Ap past the 45-day forecast: the mean of GFZ's daily Ap over the 365 days before today.
 let apSum=0;for(let d=today-CLIMATOLOGY_DAYS;d<today;d++){const g=gfz.get(d);assert(g&&g.ap>=0,'GFZ Ap for '+isoOf(d));apSum+=g.ap;}
 const climatology=Math.round(apSum/CLIMATOLOGY_DAYS);
 const flux=d=>{
  const g=gfz.get(d);if(g&&g.flux>0)return {v:g.flux,type:0,adj:g.adj};
  if(forecast.flux.has(d))return {v:forecast.flux.get(d),type:2,adj:-1};
  const v=d>forecast.last?cycleAt(d):null;return v===null?null:{v,type:3,adj:-1};
 };
 const mean=(from,to,pick)=>{let sum=0;for(let d=from;d<=to;d++){const x=flux(d);const v=x&&pick(x);if(!(v>0))return -1;sum+=v;}return sum/(to-from+1);};
 const rows=[];
 for(let d=today-BEFORE;d<=today+AHEAD;d++) {
  const g=gfz.get(d),f=flux(d);
  let ap=g&&g.ap>=0?g.ap:forecast.ap.has(d)?forecast.ap.get(d):-1,climate=false;
  if(ap<0&&d>today){ap=climatology;climate=true;}
  const slots=Array.from({length:8},(_,i)=>g&&g.kp[i]>=0?g.kp[i]:feed.get(d)?.[i]??-1);
  let aps=g?g.aps.slice():Array(8).fill(-1),kp=slots,derived=false;
  if(d>today&&slots.some(k=>k<0)&&ap>=0){kp=Array(8).fill(kpOfAp(ap));aps=Array(8).fill(ap);derived=true;}
  if(!f||ap<0||kp.some(k=>k<0))continue;
  const center=mean(d-HALF,d+HALF,x=>x.v),trailing=mean(d-TRAILING,d,x=>x.v);
  if(center<0||trailing<0)continue;
  rows.push({date:isoOf(d),flux:f.v,type:f.type,ap,kp,aps,center,trailing,
   adjCenter:mean(d-HALF,d+HALF,x=>x.adj),adjTrailing:mean(d-TRAILING,d,x=>x.adj),
   lineage:'gfz-kp-ap;drao-f107;noaa-swpc'+(d+HALF>forecast.last?';noaa-swpc-predicted-cycle':'')+(climate?';ap-climatology-gfz-365d':'')+(derived?';kp-derived-from-ap':'')});
 }
 return {rows,today:isoOf(today),lastForecast:isoOf(forecast.last),climatology};
}

// Every record, field by field, against the series the sources imply (`bodies` in SOURCE_URLS order).
export function verifySources(records,bodies,todayIso,urls=SOURCE_URLS) {
 const {rows,lastForecast,climatology}=expectedSeries(bodies,todayIso);
 assert.equal(records.length,rows.length,'published day count');
 const hash=batchHash(urls,bodies);
 records.forEach((r,i)=>{
  const e=rows[i],at=r.DATE;assert.equal(at,e.date,'date order');
  assert.equal(r.F107_OBS,Math.fround(e.flux),at+' flux');assert.equal(r.F107_DATA_TYPE,e.type,at+' flux type');
  assert.equal(r.AP_AVG,e.ap,at+' daily Ap');assert.equal(r.ISN,0,'SN must be absent/default');
  for(let k=0;k<8;k++){assert.equal(r['KP'+(k+1)],e.kp[k],at+' Kp'+(k+1));assert.equal(r['AP'+(k+1)],e.aps[k],at+' ap'+(k+1));}
  assert.equal(r.KP_SUM,e.kp.reduce((a,b)=>a+b,0),at+' Kp sum');
  assert.equal(r.F107_OBS_CENTER81,Math.fround(e.center),at+' CENTER81');assert.equal(r.F107_OBS_LAST81,Math.fround(e.trailing),at+' LAST81');
  assert.equal(r.F107_ADJ_CENTER81,Math.fround(e.adjCenter),at+' adjusted CENTER81');assert.equal(r.F107_ADJ_LAST81,Math.fround(e.adjTrailing),at+' adjusted LAST81');
  const p=r.PROVENANCE;assert(p,at+' provenance');
  assert.equal(p.SOURCE_ID,'gfz-noaa');assert.equal(p.PROVIDER_ID,'space-weather');assert.equal(p.PRODUCER,PRODUCER);
  assert.equal(p.LINEAGE,`${e.lineage};canonical-source-batch-sha256=${hash}`,at+' lineage');
 });
 const dates=records.map(r=>r.DATE);
 assert(dates.includes(todayIso),'Today must be published');assert(records.length>=BEFORE);
 return {rows:records.length,first:dates[0],last:dates.at(-1),lastForecast,climatology,hash,
  types:records.reduce((o,r)=>{o[r.F107_DATA_TYPE]=(o[r.F107_DATA_TYPE]??0)+1;return o;},{})};
}
