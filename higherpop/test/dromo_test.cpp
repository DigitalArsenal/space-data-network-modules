#include "higherpop/higherpop.hpp"
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
int main(){
  Vec3 r0,v0; kep2rv(7078,0.01,51.6*PI/180,40*PI/180,30*PI/180,0,r0,v0);
  double P=TWO_PI*std::sqrt(std::pow(7078,3)/MU_EARTH);
  ForceConfig kep; kep.zonalMax=0;
  auto D=propagateDromo(r0,v0,P,kep,1e-12,1e-13);
  printf("[DROMO two-body 1 period] dr=%.3e m dv=%.3e mm/s nfev=%u\n",
    norm(D.r-r0)*1000, norm(D.v-v0)*1e6, D.stats.nfev);
  ForceConfig c; c.zonalMax=2;
  auto C=propagateCowell(r0,v0,10*P,c,1e-13,1e-13);
  auto D2=propagateDromo(r0,v0,10*P,c,1e-12,1e-13);
  printf("[DROMO vs Cowell J2 LEO 10orb] dr=%.4e m (D nfev=%u, C nfev=%u)\n",
    norm(D2.r-C.r)*1000, D2.stats.nfev, C.stats.nfev);
  // GTO
  Vec3 rg,vg; kep2rv(24396,0.73,7*PI/180,40*PI/180,30*PI/180,0,rg,vg);
  double Pg=TWO_PI*std::sqrt(std::pow(24396,3)/MU_EARTH);
  auto Cg=propagateCowell(rg,vg,5*Pg,c,1e-13,1e-13);
  auto Dg=propagateDromo(rg,vg,5*Pg,c,1e-12,1e-13);
  printf("[DROMO vs Cowell J2 GTO 5orb] dr=%.4e m (D nfev=%u, C nfev=%u)\n",
    norm(Dg.r-Cg.r)*1000, Dg.stats.nfev, Cg.stats.nfev);
  return 0;
}
