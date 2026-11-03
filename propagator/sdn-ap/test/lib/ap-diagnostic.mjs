// Build a test-only module from the checkout's sources, adding read-only probes.
// The production module still supplies every fitted and propagated test state.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const moduleRoot=fileURLToPath(new URL('../../',import.meta.url));
const modulesRoot=path.resolve(moduleRoot,'../..');
export function buildDiagnostic(name,extra,transform=s=>s){
 const root=path.join('/Users/tj/software/terrain-work/body-look/codex-apfix-d9',name);
 const dir=path.join(root,'propagator/sdn-ap');fs.mkdirSync(dir,{recursive:true});
 const foundation=path.join(root,'foundation');if(!fs.existsSync(foundation))fs.symlinkSync(path.join(modulesRoot,'foundation'),foundation,'dir');
 for(const f of ['build.mjs','package.json','plugin-manifest.json','LICENSE','NOTICE'])fs.copyFileSync(path.join(moduleRoot,f),path.join(dir,f));
 for(const d of ['src','LICENSES'])fs.cpSync(path.join(moduleRoot,d),path.join(dir,d),{recursive:true});
 const nm=path.join(dir,'node_modules');if(!fs.existsSync(nm))fs.symlinkSync(path.join(moduleRoot,'node_modules'),nm,'dir');
 const p=path.join(dir,'src/xp_theory.inc');fs.writeFileSync(p,transform(fs.readFileSync(p,'utf8')));
 fs.appendFileSync(path.join(dir,'src/sdn_ap_module.cpp'),'\n'+extra+'\n');
 const log=fs.openSync(path.join(root,'build.log'),'w');
 try{execFileSync(process.execPath,['build.mjs'],{cwd:dir,env:{...process.env,SPACE_DATA_NETWORK_MODULES_ROOT:modulesRoot},stdio:['ignore',log,log]});}finally{fs.closeSync(log);}
 return path.join(dir,'dist/isomorphic/module.wasm');
}
export const CLASS_PROBE=String.raw`
SDNAP_EXPORT("sdnap_test_class_probe")
int sdnap_test_class_probe(double minutes,double* out) {
 using namespace sdnap; using namespace sdnap::xpt;
 auto& st=epochs::resident();if(st.series.size()!=1||out==nullptr)return -1;
 auto& slot=epochs::slot_of(st,st.series[0],0,false);if(slot.xp==nullptr||slot.error)return -2;
 auto& s=*slot.xp;double y[6];if(!mean_at(s,minutes,y))return -3;
 out[0]=y[kN]*1440/kTwoPi;out[1]=s.ctx.resonance;out[2]=ap_resonance_class(s.ctx,y[kN]);
 XpSat rebuilt{};const bool changed=ap_resonance_class(s.ctx,y[kN])!=s.ctx.resonance;if(changed&&!reclass_make(s.ctx,y,rebuilt))return -4;const auto& table=changed?rebuilt.ctx:s.ctx;
 const auto ts=res::class_terms(static_cast<int>(out[2]));out[3]=out[4]=0;
 for(int p=0;p<2;++p){
  for(int j=0;j<ts.count;++j)if(ts.t[j].l==2&&ts.t[j].m==2&&ts.t[j].p==p&&ts.t[j].q==2*p-1)out[3]+=1;
  for(int j=0;j<table.sp_count;++j){const auto& c=table.sp[j];if(c.l==2&&c.m==2&&c.w==2-2*p&&c.j==1)out[4]+=1;}
  auto k=kepler_of(s.epoch.y);const double n=s.epoch.y[kN],eta=std::sqrt(1-k.e*k.e),si=std::sin(k.i),ci=std::cos(k.i);
  double f,df,g,dg;res::kaula_F(2,2,p,si,ci,f,df);res::exact_G(2,p,2*p-1,k.e,g,dg);
  const double norm=tess::norm_factor(2,2);
  const tess::SpCoef c{2,2,static_cast<int8_t>(2-2*p),1,static_cast<float>(f*norm),static_cast<float>(df*norm),static_cast<float>(g-dg*k.e),static_cast<float>(dg)};
  double peak=0,track=0;
  for(int q=0;q<256;++q){
   k.node=kTwoPi*q/256;double six[6]={};tess::sp_six(&c,1,0,k,n,eta,si,ci,s.ctx.theta_g0,six);
   peak=std::max(peak,std::fabs(six[5])*k.a*kRe*1000);
   double yy[6],r0[3],v0[3],r1[3],v1[3],dr[3],rtn[3];equinoctial_of(n,k.e,k.i,k.node,k.argp,k.m,yy);
   RateContext off=s.ctx;off.sp=nullptr;off.sp_count=0;RateContext on=off;on.sp=&c;on.sp_count=1;
   if(output(off,0,yy,r0,v0,nullptr)!=0||output(on,0,yy,r1,v1,nullptr)!=0)return -5;
   for(int j=0;j<3;++j)dr[j]=r1[j]-r0[j];sdnap_frame_to_uvw(r0,v0,dr,rtn);track=std::max(track,std::fabs(rtn[1])*1000);
  }
  out[5+p]=peak;out[7+p]=track;
 }
 if(changed)xp_release(rebuilt);return 0;
}`;
