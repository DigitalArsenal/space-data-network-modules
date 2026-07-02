#include "higherpop/higherpop.hpp"
#include "force_models.h"
#include <cstdio>
#include <cmath>
using namespace hp;
// simple fixed-step RK4 one orbit, gravity = provided accel functor
template<class A> void rk4prop(Vec3&r,Vec3&v,double tf,double h,A accel){
  int n=(int)(tf/h);
  for(int i=0;i<n;++i){
    auto f=[&](Vec3 rr,Vec3 vv){return std::pair<Vec3,Vec3>{vv, accel(rr)};};
    auto [k1r,k1v]=f(r,v);
    auto [k2r,k2v]=f(r+k1r*(h/2), v+k1v*(h/2));
    auto [k3r,k3v]=f(r+k2r*(h/2), v+k2v*(h/2));
    auto [k4r,k4v]=f(r+k3r*h, v+k3v*h);
    r=r+(k1r+2*k2r+2*k3r+k4r)*(h/6);
    v=v+(k1v+2*k2v+2*k3v+k4v)*(h/6);
  }
}
double raan(Vec3 r, Vec3 v){ Vec3 h=cross(r,v); Vec3 nhat{-h.y,h.x,0}; 
  double O=std::atan2(nhat.y,nhat.x); return O; }
int main(){
  double a=7078,e=0.001,inc=51.6*PI/180;
  double p=a*(1-e*e), rr=p; 
  Vec3 r0=Vec3{rr,0,0}, v0; // start at ascending node-ish
  // build proper state
  double vc=std::sqrt(MU_EARTH/p);
  v0=Vec3{0, vc*std::cos(inc), vc*std::sin(inc)};
  double P=TWO_PI*std::sqrt(a*a*a/MU_EARTH);
  // analytic nodal regression per orbit
  double n=TWO_PI/P;
  double dOmega_analytic = -1.5*n*1.08262668e-3*std::pow(RE_EARTH/p,2)*std::cos(inc)*P;

  // (a) higherpop J2
  {Vec3 r=r0,v=v0; ForceConfig c;c.zonalMax=2;
   rk4prop(r,v,P,1.0,[&](Vec3 x){return totalAccel(x,Vec3{0,0,0},c);});
   printf("higherpop  dRAAN/orbit = %+.6e rad\n", raan(r,v)-raan(r0,v0));}
  // (b) hpop J2Only
  {Vec3 r=r0,v=v0;
   rk4prop(r,v,P,1.0,[&](Vec3 x){::astro::Vec3 xp(x.x,x.y,x.z);
     auto pm=::astro::ForceModel::PointMass(xp,MU_EARTH);
     auto j2=::astro::ForceModel::J2Only(xp,MU_EARTH,1.08262668e-3,RE_EARTH);
     return Vec3{pm.x+j2.x,pm.y+j2.y,pm.z+j2.z};});
   printf("hpop J2Only dRAAN/orbit = %+.6e rad\n", raan(r,v)-raan(r0,v0));}
  // (c) hpop SphericalHarmonics maxOrder=0
  {Vec3 r=r0,v=v0;
   rk4prop(r,v,P,1.0,[&](Vec3 x){::astro::Vec3 xp(x.x,x.y,x.z);
     ::astro::ForceModel::SphericalHarmonicsConfig cf; cf.mu=MU_EARTH;
     cf.referenceRadius=RE_EARTH; cf.maxDegree=2; cf.maxOrder=0;
     auto g=::astro::ForceModel::SphericalHarmonics(xp,cf);
     return Vec3{g.x,g.y,g.z};});
   printf("hpop SphHarm dRAAN/orbit = %+.6e rad\n", raan(r,v)-raan(r0,v0));}
  printf("analytic     dRAAN/orbit = %+.6e rad\n", dOmega_analytic);
  return 0;
}
