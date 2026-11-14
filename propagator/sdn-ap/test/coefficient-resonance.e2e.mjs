#!/usr/bin/env node
// Synthetic commensurabilities in the R band. J2 angle-rate roots in rad/min;
// UTC JD 2461206.5, TEME meters. A state-exact coefficient control removes orbital
// motion from the continuity residual. Bounds: 1 m distance and residual jump,
// the coefficient approximation budget, not independent numerical orbit truth.
import assert from 'node:assert/strict';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {buildDiagnostic} from './lib/ap-diagnostic.mjs';
import {exactCoefficients} from './lib/coefficient-forms.mjs';
const extra=String.raw`
static sdnap::xpt::XpSat* test_res_sat=nullptr;
static int test_res_degree=70;
SDNAP_EXPORT("sdnap_test_res_degree") void sdnap_test_res_degree(int d){test_res_degree=d;}
SDNAP_EXPORT("sdnap_test_res_init") int sdnap_test_res_init(double n,double ecc,double bterm){
 using namespace sdnap;using namespace sdnap::xpt;
 if(test_res_sat){xp_release(*test_res_sat);delete test_res_sat;}
 tess::active()=tess::Terms{test_res_degree,20,false,false};Elements e{};e.epoch_jd_whole=2461206.5;e.xincl=.9599310885968813;e.xnodeo=.7;e.omegao=1.2;e.xmo=.3;e.bterm=bterm;e.eo=ecc;e.xno=n;
 test_res_sat=new XpSat{};return xp_init(e,*test_res_sat);
}
SDNAP_EXPORT("sdnap_test_res_state") int sdnap_test_res_state(double t,double* out){
 using namespace sdnap::xpt;const int rc=xp_propagate(*test_res_sat,t,out,out+3,nullptr);double y[6];
 out[6]=mean_at(*test_res_sat,t,y)?y[kN]:0;out[7]=test_res_sat->ctx.continuity_form;return rc;
}
`;
const candidate=process.env.COEFFICIENT_RESONANCE_WASM??buildDiagnostic('coefficient-resonance',extra),exact=process.env.COEFFICIENT_RESONANCE_EXACT??buildDiagnostic('coefficient-resonance-exact',extra,s=>s,{'tesseral.inc':s=>'#define SDNAP_CONTINUITY_RULE 0\n'+s,'coefficient_evaluation.inc':exactCoefficients});
const ke=.074366859954178854,re=6378.1363,j2=.0010826266835531513,omega=.00437526908801129966,ci=Math.cos(55*Math.PI/180);
const rate=(n,e,m,j,w)=>{const a=(ke/n)**(2/3),eta=Math.sqrt(1-e*e),p=a*eta*eta,z=1.5*j2/(p*p);return w*.5*z*n*(5*ci*ci-1)+j*(n+.5*z*n*eta*(3*ci*ci-1))+m*(-z*n*ci-omega);};
const gcd=(a,b)=>b?gcd(b,a%b):a;
const roots=[];
// All primitive m:j orders through the carried degree 70 with j <= 6 whose
// central perigee lies in the selected eccentricity band. q=0 and q=+-1, +-2
// cover the distinct nearby J2-shifted angle roots for each order.
for(let j=1;j<=6;j++)for(let m=1;m<=70;m++)if(gcd(m,j)===1){
 const n0=m*omega/j,a=(ke/n0)**(2/3),e=Math.max(.020001,1-(1+675/re)/a);if(e>=.2)continue;
 for(const q of [-2,-1,0,1,2]){
  const w=j-q;let lo=n0*.98,hi=n0*1.02;for(let k=0;k<60;k++){const mid=(lo+hi)/2;if(rate(mid,e,m,j,w)>0)hi=mid;else lo=mid;}
  const n=(lo+hi)/2,hp=((ke/n)**(2/3)*(1-e)-1)*re;if(hp>=350&&hp<1000)roots.push({m,j,w,n,e,hp});
 }
}
assert(roots.some(r=>r.m===14&&r.j===1));assert(roots.some(r=>r.m===15&&r.j===1));
async function open(file){const h=await createStandaloneHarness('browser',file,{surface:'direct',maxThreads:1,enableBrowserWasiThreads:false}),x=h.instance.exports,p=x.sdnap_alloc(64);return {x,close:()=>h.close?.(),init(n,e,b){assert.equal(x.sdnap_test_res_init(n,e,b),0);},st(t){const status=x.sdnap_test_res_state(t,p);const v=Array.from(new Float64Array(h.memory.buffer,p,8));if(status!==0)console.log(JSON.stringify({refusedBuild:file.includes('-exact')?'exact':'R',timeMinutes:t,status}));assert.equal(status,0);assert(v.every(Number.isFinite));return v;}};}
const a=await open(candidate),b=await open(exact);let states=0,maxExactM=0,maxResidualJumpM=0,crossings=0;
for(const degree of [31,70])for(const root of roots){
 a.x.sdnap_test_res_degree(degree);b.x.sdnap_test_res_degree(degree);
 console.log(JSON.stringify({degree,testingRoot:root}));
 let prior;
 for(const dn of [-1e-9,0,1e-9]){
  a.init(root.n*(1+dn),root.e,0);b.init(root.n*(1+dn),root.e,0);const va=a.st(0),vb=b.st(0);assert.equal(va[7],4);
  const residual=va.slice(0,3).map((v,k)=>1000*(v-vb[k]));maxExactM=Math.max(maxExactM,Math.hypot(...residual));if(prior)maxResidualJumpM=Math.max(maxResidualJumpM,Math.hypot(...residual.map((v,k)=>v-prior[k])));prior=residual;states++;
 }
 // The q=0 member also decays through its commensurability over five days.
 if(root.w===root.j){
  a.init(root.n*(1-1e-9),root.e,.1);b.init(root.n*(1-1e-9),root.e,.1);let before=rate(root.n*(1-1e-9),root.e,root.m,root.j,root.w);prior=null;
  let crossed=false;
  for(let t=0;t<=7200;t+=30){const va=a.st(t),vb=b.st(t),after=rate(va[6],root.e,root.m,root.j,root.w);if(after*before<=0)crossed=true;before=after;
   const residual=va.slice(0,3).map((v,k)=>1000*(v-vb[k]));maxExactM=Math.max(maxExactM,Math.hypot(...residual));if(prior)maxResidualJumpM=Math.max(maxResidualJumpM,Math.hypot(...residual.map((v,k)=>v-prior[k])));prior=residual;states++;
  }
  if(crossed)crossings++;else console.log(JSON.stringify({degree,uncrossed:[root.m,root.j]}));
 }
 console.log(JSON.stringify({degree,order:[root.m,root.j,root.w],states,maxExactM,maxResidualJumpM,crossings}));
}
await a.close();await b.close();assert(crossings>0);assert(maxExactM<1);assert(maxResidualJumpM<1);console.log(JSON.stringify({roots:roots.length,states,maxExactM,maxResidualJumpM,crossings}));process.exit(0);
