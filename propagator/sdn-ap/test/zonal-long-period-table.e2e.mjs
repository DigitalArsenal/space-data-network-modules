#!/usr/bin/env node
// SPEC 16.3, stack #595. Dimensionless Hansen G and dG/de, degrees 6..70, |w| 2..6.
// Independent finite binomial sum (mean-anomaly average transformed to true anomaly); no epoch or frame.
// Value and slope at the anchor agree within float rounding, 3e-6 relative. At anchor +/-0.001 the
// measured Taylor truncation envelopes are 0.5% in G and 9% in dG (degree 70, e 0.3); degree <=20: 0.03% and 1.6%.
// The 0.3 switch is isolated against a control with the full zonal harmonics on both sides, with every other
// switch held as production selects it. Comparing the two eccentricities directly includes their physical separation.
import assert from 'node:assert/strict';
import * as fb from 'flatbuffers';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {OEM} from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import {pcfOutputFrame} from 'spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js';
import {buildDiagnostic} from './lib/ap-diagnostic.mjs';
import {wasmPath} from './lib/module.mjs';
import {seedOcm,flight} from './lib/ocm.mjs';

const extra=String.raw`
SDNAP_EXPORT("sdnap_test_zonal_table")
int sdnap_test_zonal_table(double e0, double e, double* out) {
  using namespace sdnap::xpt;
  float table[4 * 455]; tess::zonal_visit_terms(70, false, 55 * sdnap::kDeg, e0, table);
  int idx = 0, count = 0;
  for (int l = 6; l <= 70; ++l) {
    idx += (l & 1) ? 2 : 1;
    for (int k = (l & 1) ? 3 : 2; k <= tess::kTailW; k += 2) {
      const float* f = table + 4 * idx; idx += 2;
      double G, dG; tess::zonal_G(l, k, e, G, dG);
      double* r = out + 8 * count++;
      r[0] = l; r[1] = k; r[2] = f[2]; r[3] = f[3]; r[4] = G; r[5] = dG;
      r[6] = f[6]; r[7] = f[7];
    }
  }
  return count;
}
SDNAP_EXPORT("sdnap_test_zonal_reanchor")
void sdnap_test_zonal_reanchor(double e0, double e, double* out) {
  using namespace sdnap::xpt;
  float table[4 * 455]; tess::zonal_visit_terms(70, false, 55 * sdnap::kDeg, e0, table);
  const double er = e0 > 0.01 ? e0 : 0.01;
  const double at = tess::tail_w_anchor(e, er);
  const Kepler k{1.5, e, 55 * sdnap::kDeg, 0.4, 1.7, 0.8};
  const double n = std::sqrt(kMu / (k.a * k.a * k.a)), eta = std::sqrt(1 - e * e);
  for (int j = 0; j < 12; ++j) out[j] = 0;
  tess::zonal_six(table, 70, false, k, n, eta, std::sin(k.i), std::cos(k.i), out, nullptr, nullptr, 1, er);
  if (at != er) {
    int idx = 0;
    for (int l = 6; l <= 70; ++l) {
      idx += (l & 1) ? 2 : 1;
      for (int w = (l & 1) ? 3 : 2; w <= tess::kTailW; w += 2) {
        float* f = table + 4 * idx; idx += 2;
        tess::tail_w_coefficients(l, w, at, f[2], f[3]); f[6] = f[2]; f[7] = f[3];
      }
    }
  }
  tess::zonal_six(table, 70, false, k, n, eta, std::sin(k.i), std::cos(k.i), out + 6, nullptr, nullptr, 0, at);
  out[12] = at;
}
`;
const control=buildDiagnostic('zonal-long-period-control',extra,text=>{
 const from='const bool wide = br.wide_e != 0;';assert.equal(text.split(from).length,2);
 return text.replace(from,'const bool wide = true;');
});
const h=await createStandaloneHarness('browser',control,{surface:'direct'}),x=h.instance.exports;
const p=x.sdnap_alloc(8*8*400),mem=()=>new Float64Array(h.memory.buffer,p,8*400);
const choose=(n,k)=>{let v=1;for(let j=1;j<=k;j++)v*= (n+1-j)/j;return v;};
function closed(l,k,e){
 let s=0,d=0;
 for(let j=0;2*j+k<=l-1;j++){const m=2*j+k,c=choose(l-1,m)*choose(m,j)/2**m;s+=c*e**m;if(m)d+=c*m*e**(m-1);}
 const f=(1-e*e)**-(l-0.5);return [f*s,f*(d+(2*l-1)*e*s/(1-e*e))];
}
function quadrature(l,k,e){let s=0;const N=1024,eta=Math.sqrt(1-e*e);for(let j=0;j<N;j++){const E=2*Math.PI*j/N,ar=1/(1-e*Math.cos(E)),f=Math.atan2(eta*Math.sin(E),Math.cos(E)-e);s+=ar**l*Math.cos(k*f);}return s/N;}
let formError=0,quadError=0,zero=0;
const report=[];
for(const e0 of [0,0.0005,0.01,0.05,0.3]){
 const er=Math.max(e0,0.01);let worstG=0,worstDG=0,lowG=0,lowDG=0;
 for(const e of [Math.max(0,e0-0.001),e0,e0+0.001,er]){
  const count=x.sdnap_test_zonal_table(e0,e,p),v=mem().slice(0,count*8);
  for(let q=0;q<count;q++){
   const [l,k,a,b,G,dG,an,bn]=v.slice(q*8,q*8+8),[want,wantD]=closed(l,k,e);
   assert.equal(a,an);assert.equal(b,bn);
   if(l-1<k){assert.deepEqual([a,b,G,dG],[0,0,0,0]);zero++;continue;}
   for(const [got,ref] of [[G,want],[dG,wantD]]){const err=ref===0?Math.abs(got):Math.abs(got/ref-1);formError=Math.max(formError,err);assert.ok(err<2e-13,`${l},${k},${e}: closed form ${err}`);}
   const gf=e**k*(a+b*e*e),dgf=e**(k-1)*(k*a+(k+2)*b*e*e);
   const rg=want===0?Math.abs(gf):Math.abs(gf/want-1),rd=wantD===0?Math.abs(dgf):Math.abs(dgf/wantD-1);
   worstG=Math.max(worstG,rg);worstDG=Math.max(worstDG,rd);if(l<=20){lowG=Math.max(lowG,rg);lowDG=Math.max(lowDG,rd);}
   if(e===er){assert.ok(rg<3e-6&&rd<3e-6,`${l},${k}: value and slope at anchor`);}
  }
 }
 assert.ok(worstG<0.005&&worstDG<0.09,`e0 ${e0}: G ${worstG}, dG ${worstDG}`);
 assert.ok(lowG<0.0003&&lowDG<0.016,`e0 ${e0}, degree <=20: G ${lowG}, dG ${lowDG}`);
 report.push({e0,worstG,worstDG,lowG,lowDG});
}
for(const e of [0.05,0.3])for(const [l,k] of [[6,2],[20,4],[21,3],[40,6],[70,2]]){
 const err=Math.abs(closed(l,k,e)[0]/quadrature(l,k,e)-1);quadError=Math.max(quadError,err);assert.ok(err<=2e-13,`${l},${k},${e}: quadrature ${err}`);
}
for(const e of [0.299,0.29,0.31,0.3019,0.29,0.3]){
 x.sdnap_test_zonal_reanchor(0.3,e,p);const v=mem().slice(0,13);assert.deepEqual(v.slice(0,6),v.slice(6,12),'cached re-anchor equals independently rebuilt coefficients');
 assert.equal(v[12],Math.abs(e-0.3)>0.002?e:0.3);
}
x.sdnap_test_zonal_reanchor(0.0005,0.0001,p);assert.equal(mem()[12],0.01,'small eccentricity keeps the floor');
console.log(JSON.stringify({closedFormRelative:formError,closedVsQuadrature:quadError,exactZeroChecks:zero,table:report,reanchor:'PASS'}));
x.sdnap_free(p);await h.close?.();

const epoch='2026-03-02T00:00:00.000',start=Date.parse(epoch+'Z');
const epochs=Array.from({length:5*24*12+1},(_,k)=>new Date(start+k*300000).toISOString());
async function fly(file,e){
 const host=await createStandaloneHarness('browser',file,{surface:'direct'});
 const set=seedOcm({epoch,n:9.1113831137,e,i:55,raan:15.7,argp:143.9,ma:276.1,tesseral:0,zonal:70,solidTides:true});
 const r=await host.invoke({methodId:'propagate',inputs:flight([set],{output:{EPOCHS:epochs,FRAME:pcfOutputFrame.GCRF}})});
 assert.equal(r.statusCode,0,r.errorMessage);
 const lines=OEM.getRootAsOEM(new fb.ByteBuffer(r.outputs.find(o=>o.portId==='ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
 await host.close?.();return lines;
}
for(const e of [0.2999,0.3001]){
 const a=await fly(wasmPath,e),b=await fly(control,e);assert.equal(a.length,epochs.length);assert.equal(b.length,a.length);
 const maximumM=Math.max(...a.map((v,j)=>1000*Math.hypot(v.X-b[j].X,v.Y-b[j].Y,v.Z-b[j].Z)));
 console.log(JSON.stringify({e,comparison:'production against full-zonal-harmonic control at identical elements',maximumM,states:a.length}));
 assert.ok(maximumM<=1,`e ${e}: switch contribution ${maximumM} m <= 1 m`);
 if(e>0.3)assert.deepEqual(a,b,'above the switch the control and production are identical');
}
console.log('Zonal long-period coefficients, re-anchor and switch E2E: PASS');
process.exit(0);
