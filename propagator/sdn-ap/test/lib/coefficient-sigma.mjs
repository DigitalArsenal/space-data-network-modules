// Synthetic covariance-bank probes: no release exports or runtime overrides.
import {buildDiagnostic} from './ap-diagnostic.mjs';
export const sigmaProbe = String.raw`
namespace sdnap::pool {
inline int test_case = 0, test_order = 0, test_warm = 0;
inline void coefficient_sigma_case(double* out) {
 using namespace sdnap::xpt;
 const auto saved = tess::active(); tess::active() = tess::Terms{31,20,false,false};
 auto* sats = new XpSat[2]{};
 Elements e{}; e.epoch_jd_whole=2461206.5; e.xincl=0.9; e.xnodeo=0.7; e.omegao=1.2; e.xmo=0.3;
 e.bterm=0.001; double hp=500, ecc=0.01, dh=1e-7, de=0;
 switch(test_case%6) {
  case 0: ecc=0.02-1e-10; de=2e-10; dh=0; break;
  case 1: hp=350-1e-7; ecc=0.1; break;
  case 2: hp=600-1e-7; break;
  case 3: hp=1000-1e-7; break;
  case 4: hp=30000-1e-7; break;
  case 5: e.bterm=0; dh=0; break;
 }
 e.eo=ecc; e.xno=kKe/std::pow((1+hp/kRe)/(1-ecc),1.5);
 const int ns=xp_init(e,sats[0]);
 e.eo+=de; e.xno=kKe/std::pow((1+(hp+2*dh)/kRe)/(1-e.eo),1.5);
 if(test_case%6==5)e.bterm=1e-12;
 int ss; { CovBankScope bank(&sats[0]); ss=xp_init(e,sats[1]); }
 out[0]=ns; out[1]=ss; out[2]=sats[0].ctx.continuity_form; out[3]=sats[1].ctx.continuity_form;
 out[4]=sats[1].ctx.shared_mask; out[5]=sizeof(RateContext);
 // The production propagation entry clears the anchor at epoch. Output at the
 // same mean elements also exercises cell keys independently of grid brackets.
 const double times[3]={0.0,0.000001,-0.000001};
 const int orders[3][3]={{2,0,1},{1,0,2},{0,2,1}};
 auto fly=[&](XpSat& sat,double t,double* v){
  if(test_case<6)return xp_propagate(sat,t,v,v+3,nullptr);
  tess::g_sp_anchor.valid=false;
  return output(sat.ctx,t,sat.epoch.y,v,v+3,nullptr);
 };
 for(int q=0;q<3;++q){
  const int k=orders[test_order][q]; double dummy[6]{}; double* v=out+8+8*k;
  if(test_warm) fly(sats[0],times[k],dummy);
  v[0]=fly(sats[1],times[k],v+1);
  v[7]=tess::g_sp_anchor.valid;
 }
 xp_release(sats[1]);xp_release(sats[0]);delete[] sats;tess::active()=saved;
}
}
`;
export function buildSigma(){
 return buildDiagnostic('coefficient-sigma',String.raw`
SDNAP_EXPORT("sdnap_test_time_tables_ready") int sdnap_test_time_tables_ready() {
 return ::NDAT > 0 && ::changes != nullptr;
}
SDNAP_EXPORT("sdnap_test_sigma") int sdnap_test_sigma(int c,int order,int warm,int threaded,double* out) {
 using namespace sdnap::pool;
 test_case=c;test_order=order;test_warm=warm;
 if(!threaded){coefficient_sigma_case(out);return 0;}
 auto& j=job();j.kind=99;j.out=out;j.count=4*kChunk;
 return run(j.count,128*1024*1024);
}
`,s=>s,{'abi.inc':s=>s.replace('void run_chunk(const Job& j, int32_t chunk) {',
 'void run_chunk(const Job& j, int32_t chunk) {\n  if(j.kind==99){coefficient_sigma_case(j.out+32*chunk);return;}').replace('namespace pool {','namespace pool {\nvoid coefficient_sigma_case(double*);'),
 'sdn_ap_module.cpp':s=>s.replace('#include "abi.inc"',sigmaProbe+'\n#include "abi.inc"')});
}
