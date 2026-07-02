// crosscheck_hpop.cpp — trajectory-level agreement between higherpop and the
// (corrected) hpop force model. hpop is the reference oracle: we integrate the
// SAME physics with an independent tight RKF-style loop calling hpop's
// SphericalHarmonics, then compare higherpop's Cowell / MEE / Encke / KS.
//
// Requirement: all formulations agree with the hpop reference to < 0.01 m.
#include "higherpop/higherpop.hpp"
#include "force_models.h"
#include <cstdio>
#include <cmath>
#include <array>

using namespace hp;

static void kep2rv(double a,double e,double i,double O,double w,double nu,Vec3&r,Vec3&v){
  double mu=MU_EARTH,p=a*(1-e*e),rr=p/(1+e*std::cos(nu));
  Vec3 rp{rr*std::cos(nu),rr*std::sin(nu),0}, vp{-std::sqrt(mu/p)*std::sin(nu),std::sqrt(mu/p)*(e+std::cos(nu)),0};
  auto R3=[&](double t,Vec3 u){double c=std::cos(t),s=std::sin(t);return Vec3{c*u.x+s*u.y,-s*u.x+c*u.y,u.z};};
  auto R1=[&](double t,Vec3 u){double c=std::cos(t),s=std::sin(t);return Vec3{u.x,c*u.y+s*u.z,-s*u.y+c*u.z};};
  auto rot=[&](Vec3 u){return R3(-O,R1(-i,R3(-w,u)));}; r=rot(rp); v=rot(vp);
}

// hpop reference acceleration (SphericalHarmonics zonal-only, degree=zmax).
static Vec3 hpopAccel(const Vec3& r, int zmax){
  ::astro::Vec3 rp(r.x,r.y,r.z);
  ::astro::ForceModel::SphericalHarmonicsConfig cf;
  cf.mu=MU_EARTH; cf.referenceRadius=RE_EARTH; cf.maxDegree=zmax; cf.maxOrder=0;
  ::astro::Vec3 g=::astro::ForceModel::SphericalHarmonics(rp,cf);   // incl. point mass
  return {g.x,g.y,g.z};
}

// Independent DP54 reference integrator on hpop's accel (Cartesian).
static void hpopReference(const Vec3& r0,const Vec3& v0,double tf,int zmax,
                          double rtol,double atol, Vec3& rf, Vec3& vf){
  auto f=[&](double,const State<6>& s)->State<6>{
    Vec3 r{s[0],s[1],s[2]}; Vec3 a=hpopAccel(r,zmax);
    return {s[3],s[4],s[5],a.x,a.y,a.z};
  };
  State<6> y{r0.x,r0.y,r0.z,v0.x,v0.y,v0.z};
  StepStats st; y=integrate<6>(f,y,0.0,tf,rtol,atol,st);
  rf={y[0],y[1],y[2]}; vf={y[3],y[4],y[5]};
}

int main(){
  struct Case{const char*name;double a,e,i,rev;int zmax;};
  Case cases[]={
    {"LEO_J2",   7078,0.01,51.6*PI/180, 15, 2},
    {"LEO_J4",   7078,0.01,51.6*PI/180, 15, 4},
    {"GTO_J2",  24396,0.73, 7.0*PI/180,  5, 2},
    {"Molniya_J2",26560,0.74,63.4*PI/180,5, 2},
  };
  printf("%-11s %-8s %12s %8s\n","case","form","err_m","nfev");
  double worst=0;
  for(auto&c:cases){
    Vec3 r0,v0; kep2rv(c.a,c.e,c.i,40*PI/180,30*PI/180,0,r0,v0);
    double P=TWO_PI*std::sqrt(c.a*c.a*c.a/MU_EARTH), tf=c.rev*P;
    ForceConfig fc; fc.zonalMax=c.zmax;
    Vec3 rref,vref; hpopReference(r0,v0,tf,c.zmax,1e-13,1e-13,rref,vref);
    auto rep=[&](const char*nm,PropResult R){
      double e=norm(R.r-rref)*1000; worst=std::max(worst,e);
      printf("%-11s %-8s %12.4e %8u\n",c.name,nm,e,R.stats.nfev);
    };
    // MEE integrates orbital elements; near perigee a given element tolerance
    // maps to a larger position error, so eccentric orbits need a tighter
    // rtol. We select it from eccentricity (still ~half Cowell's nfev).
    const double meeRtol = (c.e > 0.3) ? 1e-13 : 1e-12;
    rep("Cowell",propagateCowell(r0,v0,tf,fc,1e-12,1e-13));
    rep("MEE",   propagateMee   (r0,v0,tf,fc,meeRtol,1e-15));
    rep("Encke", propagateEncke (r0,v0,tf,fc,1e-12,1e-13,0.01));
    rep("KS",    propagateKS    (r0,v0,tf,fc,1e-12,1e-13));
    rep("DROMO", propagateDromo (r0,v0,tf,fc,1e-12,1e-13));
  }
  printf("\nWORST error vs hpop reference = %.4e m  -> %s (target 0.01 m)\n",
         worst, worst<0.01?"PASS":"FAIL");
  return worst<0.01?0:1;
}
