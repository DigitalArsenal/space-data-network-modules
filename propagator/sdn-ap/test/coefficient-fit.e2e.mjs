// Synthetic TEME positions, UTC JD 2461206.5, km. This tests selection
// identity, not orbit accuracy: every trial uses the seed form, exactly.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {buildDiagnostic} from './lib/ap-diagnostic.mjs';
const change=(s,a,b)=>{assert(s.includes(a),a);return s.replace(a,b);};
const extra=String.raw`
SDNAP_EXPORT("sdnap_test_fit_form") int sdnap_test_fit_form(int c,double* out){
 using namespace sdnap;using namespace sdnap::xpt;
 const auto saved=tess::active();tess::active()=tess::Terms{31,20,false,false};
 double hp=500,ecc=.01;bool vary_e=false;
 switch(c){case 0:ecc=.02;vary_e=true;break;case 1:hp=350;ecc=.1;break;
 case 2:hp=600;break;case 3:hp=1000;break;case 4:hp=30000;break;
 case 5:ecc=.2;vary_e=true;break;}
 ElementRow seed{};seed.theory=kTheorySgp4Xp;seed.epoch_jd_whole=2461206.5;
 seed.eccentricity=ecc;seed.inclination_deg=55;seed.raan_deg=40;seed.arg_pericenter_deg=70;seed.mean_anomaly_deg=20;
 seed.bterm=c==6?0:.001;
 const auto motion=[&](double h,double e){return kKe/std::pow((1+h/kRe)/(1-e),1.5)*kMinutesPerDay/kTwoPi;};
 seed.mean_motion_rev_day=motion(hp,ecc);
 const Elements se=elements_of(seed);
 const uint8_t form=tess::continuity_form(se.xno,se.eo,se.bterm,true);
 ElementRow target=seed;target.eccentricity+=vary_e?1e-6:0;
 target.mean_motion_rev_day=motion(hp+(vary_e||c==6?0:.01),target.eccentricity);
 if(c==6)target.bterm=.00001;
 if(c!=6){
  const Elements te=elements_of(target);
  if(tess::continuity_form(te.xno,te.eo,te.bterm,true)==form){
   target.eccentricity=ecc-(vary_e?1e-6:0);
   target.mean_motion_rev_day=motion(hp-(vary_e?0:.01),target.eccentricity);
  }
 }
 auto* sat=new XpSat{};
 {ContinuityScope pin(form);if(xp_init(elements_of(target),*sat)!=0){delete sat;return 1;}}
 constexpr int N=13;double times[N],positions[N*3];
 for(int k=0;k<N;k++){times[k]=k*20.0;double v[3];if(xp_propagate(*sat,times[k],positions+3*k,v)!=0){xp_release(*sat);delete sat;return 2;}}
 xp_release(*sat);delete sat;
 fit::Options options{};options.max_iterations=100;options.fit_drag=c==6;
 test_form_mask=0;test_free_mask=0;test_form_count=0;test_fit_trace=true;
 const fit::Result result=fit::run(seed,times,positions,N,options);
 test_fit_trace=false;
 out[0]=result.status;out[1]=form;out[2]=test_form_mask;out[3]=test_free_mask;out[4]=test_form_count;
 out[5]=result.rms_km;out[6]=g_continuity_pin;
 sat=new XpSat{};out[7]=xp_init(elements_of(seed),*sat);out[8]=sat->ctx.continuity_form;
 const Elements final=elements_of(seed);out[9]=tess::continuity_form(final.xno,final.eo,final.bterm,true);
 xp_release(*sat);delete sat;tess::active()=saved;return 0;
}
`;
const transforms={};
if(process.env.SDNAP_FIT_UNPINNED)transforms['fit.inc']=s=>change(s,'  const xpt::ContinuityScope form_pin(xpt::tess::continuity_form(seed.xno, seed.eo, seed.bterm, ap_selected()));','  (void)seed;');
const file=process.env.SDNAP_FIT_WASM??buildDiagnostic('coefficient-fit',extra,s=>{
 s=change(s,'namespace xpt {','namespace xpt {\ninline bool test_fit_trace=false;\ninline uint32_t test_form_mask=0,test_free_mask=0,test_form_count=0;');
 return change(s,'  if (!pool::thread_ready',`  if(test_fit_trace){test_form_mask|=1u<<s.ctx.continuity_form;test_free_mask|=1u<<tess::continuity_form(n0,e.eo,e.bterm,true);++test_form_count;}
  if (!pool::thread_ready`);
},transforms);
const results=[];
for(let c=0;c<7;c++){
 const h=await createStandaloneHarness('browser',file,{surface:'direct'}),x=h.instance.exports,p=x.sdnap_alloc(80);
 assert.equal(x.sdnap_test_fit_form(c,p),0);
 const row=Array.from(new Float64Array(h.memory.buffer,p,10));results.push({threshold:c,row});console.log(JSON.stringify(results.at(-1)));await h.destroy?.();
}
if(process.env.SDNAP_FIT_JSON)fs.writeFileSync(process.env.SDNAP_FIT_JSON,JSON.stringify({file,results},null,2)+'\n');
for(const {threshold,row:r} of results){
 assert(r[0]>=0,`fit ${threshold} refused`);assert(r[4]>1);
 assert.equal(r[2],1<<r[1],`fit ${threshold} changed coefficient form`);
 assert.equal(r[6],-1,'fit scope leaked');assert.equal(r[7],0);assert.equal(r[8],r[9],'final record must select its own form');
}
assert(results.every(({row:r})=>r[3]!==r[2]),'every threshold must be crossed by the unpinned trial selector');
process.exit(0);
