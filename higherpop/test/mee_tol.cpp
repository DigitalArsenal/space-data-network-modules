#include "higherpop/higherpop.hpp"
#include "force_models.h"
#include <cstdio>
#include <cmath>
using namespace hp;
static void kep2rv(double a,double e,double i,double O,double w,double nu,Vec3&r,Vec3&v){
  double mu=MU_EARTH,p=a*(1-e*e),rr=p/(1+e*std::cos(nu));
  Vec3 rp{rr*std::cos(nu),rr*std::sin(nu),0}, vp{-std::sqrt(mu/p)*std::sin(nu),std::sqrt(mu/p)*(e+std::cos(nu)),0};
  auto R3=[&](double t,Vec3 u){double c=std::cos(t),s=std::sin(t);return Vec3{c*u.x+s*u.y,-s*u.x+c*u.y,u.z};};
  auto R1=[&](double t,Vec3 u){double c=std::cos(t),s=std::sin(t);return Vec3{u.x,c*u.y+s*u.z,-s*u.y+c*u.z};};
  auto rot=[&](Vec3 u){return R3(-O,R1(-i,R3(-w,u)));}; r=rot(rp); v=rot(vp);
}
static Vec3 hpopAccel(const Vec3&r,int z){::astro::Vec3 rp(r.x,r.y,r.z);
  ::astro::ForceModel::SphericalHarmonicsConfig cf;cf.mu=MU_EARTH;cf.referenceRadius=RE_EARTH;cf.maxDegree=z;cf.maxOrder=0;
  auto g=::astro::ForceModel::SphericalHarmonics(rp,cf);return {g.x,g.y,g.z};}
static void ref(const Vec3&r0,const Vec3&v0,double tf,int z,Vec3&rf,Vec3&vf){
  auto f=[&](double,const State<6>&s)->State<6>{Vec3 r{s[0],s[1],s[2]};Vec3 a=hpopAccel(r,z);return {s[3],s[4],s[5],a.x,a.y,a.z};};
  State<6> y{r0.x,r0.y,r0.z,v0.x,v0.y,v0.z};StepStats st;y=integrate<6>(f,y,0,tf,1e-13,1e-13,st);
  rf={y[0],y[1],y[2]};vf={y[3],y[4],y[5]};}
int main(){
  struct C{const char*n;double a,e,i,rev;};
  C cs[]={{"GTO",24396,0.73,7*PI/180,5},{"Molniya",26560,0.74,63.4*PI/180,5}};
  double tols[]={1e-12,1e-13,1e-14};
  for(auto&c:cs){Vec3 r0,v0;kep2rv(c.a,c.e,c.i,40*PI/180,30*PI/180,0,r0,v0);
    double P=TWO_PI*std::sqrt(c.a*c.a*c.a/MU_EARTH),tf=c.rev*P;
    ForceConfig fc;fc.zonalMax=2; Vec3 rr,vv;ref(r0,v0,tf,2,rr,vv);
    for(double rt:tols){
      auto R=propagateMee(r0,v0,tf,fc,rt,1e-15);
      printf("%-8s MEE rtol=%.0e  err=%.4e m  nfev=%u\n",c.n,rt,norm(R.r-rr)*1000,R.stats.nfev);
    }
  }
  return 0;
}
