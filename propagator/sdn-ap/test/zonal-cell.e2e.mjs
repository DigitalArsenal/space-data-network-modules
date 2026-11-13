#!/usr/bin/env node
// SPEC 16.3, stack #595. Synthetic AP, epoch JD 2461101.5 UTC, TEME km and km/s.
// The probe runs the production integrator and reports mean eccentricity and its cell.
// A one-second position second difference at a cell crossing is compared with the neighboring
// second differences, ten seconds away. A 1 cm excess bound separates a grid step from orbital curvature.
// Reversing or shuffling queries must preserve all six state components bit for bit.
// Covariance-table sharing is checked only for |w| >= 2: zeroing the legacy entries isolates this
// contribution without subtracting two rounded sums. Returning the owner's anchor breaks this assertion.
import assert from 'node:assert/strict';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {buildDiagnostic} from './lib/ap-diagnostic.mjs';
const extra=String.raw`static sdnap::xpt::XpSat probe_sats[20];
static bool probe_live = false;
SDNAP_EXPORT("probe_init")
int probe_init(double ea, double eb, int mode, double n, double drag) {
  using namespace sdnap; using namespace sdnap::xpt;
  if (probe_live) { xp_release(probe_sats[19]); xp_release(probe_sats[0]); }
  probe_live = false;
  tess::active() = tess::Terms{0,70};
  Elements e{}; e.epoch_jd_whole=2461101.5; e.xno=n*kTwoPi/1440;
  e.xincl=55*kDeg; e.xnodeo=68.2*kDeg; e.omegao=322*kDeg; e.xmo=284*kDeg; e.theory=kTheorySgp4Xp;
  e.bterm=drag; e.eo=ea; if(xp_init(e,probe_sats[0])) return 1;
  e.eo=eb;
  if(mode) { CovBankScope share(&probe_sats[0]); if(xp_init(e,probe_sats[19])) return 2; }
  else if(xp_init(e,probe_sats[19])) return 3;
  probe_live=true;
  return probe_sats[19].ctx.shared_mask;
}
SDNAP_EXPORT("probe_at")
int probe_at(int s,double t,double* out) {
 using namespace sdnap::xpt;
 double y[6]; if(!mean_at(probe_sats[s ? 19 : 0],t,y)) return 9;
 out[6]=kepler_of(y).e;out[7]=tess::tail_w_anchor(out[6]);out[8]=probe_sats[s ? 19 : 0].ctx.zt_er;
 return xp_propagate(probe_sats[s ? 19 : 0],t,out,out+3);
}

SDNAP_EXPORT("probe_tail")
void probe_tail(int slot, double e, double* out) {
 using namespace sdnap::xpt;
 const auto& ctx=probe_sats[slot ? 19 : 0].ctx;
 float table[4*423]; std::memcpy(table,ctx.zt,sizeof table);
 int idx=0;
 for(int l=6;l<=70;++l) {
   const int legacy=(l&1)?2:1;
   std::memset(table+4*idx,0,4*legacy*sizeof(float));
   idx+=legacy+2*tess::tail_w_pairs(l);
 }
 const Kepler k{1.12,e,55*sdnap::kDeg,0.4,1.7,0.8};
 std::memset(out,0,6*sizeof(double));
 tess::zonal_six(table,70,false,k,std::sqrt(kMu/(k.a*k.a*k.a)),
   std::sqrt(1-e*e),std::sin(k.i),std::cos(k.i),out,nullptr,nullptr,0,ctx.zt_er);
 out[6]=ctx.zt_er; out[7]=tess::tail_w_anchor(e);
}
SDNAP_EXPORT("probe_memory")
int probe_memory(int which) { return which ? sizeof(sdnap::xpt::tess::TailWCoefficients) : sdnap::xpt::tess::zonal_count(70,false); }
`;
const file=buildDiagnostic('zonal-cell',extra);
const h=await createStandaloneHarness('browser',file,{surface:'direct'}),x=h.instance.exports,p=x.sdnap_alloc(72);
const read=()=>Array.from(new Float64Array(h.memory.buffer,p,9));
const init=(ea,eb,shared,n=14.4053115722,drag=0)=>x.probe_init(ea,eb,shared,n,drag);
const at=t=>{assert.equal(x.probe_at(0,t,p),0);return read();};
for(const stateE of [0.0499,0.0501,0.0521]) {
 const rows=[];
 for(const [ea,eb] of [[0.0499,0.0501],[0.0501,0.0499]]) {
  assert.ok(init(ea,eb,1)&16,'ap_init shares the zonal table');
  for(const slot of [0,1]) {x.probe_tail(slot,stateE,p);const v=read();rows.push(v.slice(0,6));}
 }
 for(const row of rows.slice(1))assert.deepEqual(row,rows[0],'added contribution independent of table owner');
 assert.ok(rows[0].some(v=>v!==0),'nonzero contribution');
}
console.log(JSON.stringify({sharing:'PASS',count70:x.probe_memory(0),tableBytes:16*x.probe_memory(0),coefficientCacheBytes:x.probe_memory(1)}));
const e0=0.05000001,n=Math.sqrt(398600.4418/((6378.137+300)/(1-e0))**3)*86400/(2*Math.PI),drag=0.0064;
const reset=()=>assert.equal(init(e0,e0,0,n,drag),0);
reset();
const times=Array.from({length:1441},(_,i)=>i*5),forward=times.map(at);
const crossing=forward.findIndex((v,i)=>i>0&&v[7]!==forward[i-1][7]);
assert.ok(crossing>0,'the flight crosses an eccentricity cell boundary');
let lo=times[crossing-1],hi=times[crossing],cell=forward[crossing-1][7];
for(let j=0;j<35;j++){const mid=(lo+hi)/2;if(at(mid)[7]===cell)lo=mid;else hi=mid;}
const t=(lo+hi)/2,dt=1/60;
const second=t=>{const a=at(t-dt),b=at(t),c=at(t+dt);return a.slice(0,3).map((v,j)=>1000*(v-2*b[j]+c[j]));};
const center=second(t),left=second(t-10*dt),right=second(t+10*dt);
const excess=Math.hypot(...center.map((v,j)=>v-(left[j]+right[j])/2));
console.log(JSON.stringify({crossingMinute:t,e0,n,drag,epochAnchor:forward[0][8],lastE:forward.at(-1)[6],lastAnchor:forward.at(-1)[7],secondDifferenceM:Math.hypot(...center),awayM:[Math.hypot(...left),Math.hypot(...right)],excessM:excess}));
assert.ok(excess<0.01,'cell crossing contributes less than 1 cm to the second difference');
const shuffled=times.map((_,i)=>i);let seed=595;
for(let i=shuffled.length-1;i>0;i--){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const j=seed%(i+1);[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];}
for(const order of [times.map((_,i)=>i).reverse(),shuffled]) {reset();for(const i of order)assert.deepEqual(at(times[i]).slice(0,6),forward[i].slice(0,6),'state bits independent of query order');}
x.sdnap_free(p);await h.close?.();
console.log('Zonal cell crossing, query order and shared contribution E2E: PASS');
process.exit(0);
