// bench.cpp — efficiency survey: accuracy vs cost across formulations,
// orbit regimes, and tolerances. Emits CSV to stdout.
//
// For each (regime, formulation, tol): propagate for a fixed arc, measure
//   * position error vs a high-accuracy Cowell reference (rtol=1e-13),
//   * force evaluations (nfev),
//   * wall-clock time (median of repeats).
#include "higherpop/formulations.hpp"
#include "higherpop/atmosphere.hpp"
#include <cstdio>
#include <cmath>
#include <chrono>
#include <vector>
#include <string>
#include <algorithm>

using namespace hp;

static void kep2rv(double a,double e,double i,double raan,double argp,double nu,
                   Vec3& r, Vec3& v){
    const double mu=MU_EARTH, p=a*(1-e*e), rr=p/(1+e*std::cos(nu));
    Vec3 rp{rr*std::cos(nu), rr*std::sin(nu), 0};
    Vec3 vp{-std::sqrt(mu/p)*std::sin(nu), std::sqrt(mu/p)*(e+std::cos(nu)), 0};
    auto R3=[&](double t,Vec3 u){double c=std::cos(t),s=std::sin(t);
        return Vec3{c*u.x+s*u.y,-s*u.x+c*u.y,u.z};};
    auto R1=[&](double t,Vec3 u){double c=std::cos(t),s=std::sin(t);
        return Vec3{u.x,c*u.y+s*u.z,-s*u.y+c*u.z};};
    auto rot=[&](Vec3 u){return R3(-raan,R1(-i,R3(-argp,u)));};
    r=rot(rp); v=rot(vp);
}

struct Regime { std::string name; double a,e,i,arcRev; ForceConfig cfg; };

template<class Fn>
static double timeit(Fn&& fn, int reps, Vec3& r, Vec3& v){
    std::vector<double> ts;
    for(int k=0;k<reps;++k){
        auto t0=std::chrono::high_resolution_clock::now();
        auto R=fn();
        auto t1=std::chrono::high_resolution_clock::now();
        ts.push_back(std::chrono::duration<double,std::micro>(t1-t0).count());
        r=R.r; v=R.v;
    }
    std::sort(ts.begin(),ts.end());
    return ts[ts.size()/2];   // median microseconds
}

int main(){
    std::vector<Regime> regimes;
    { ForceConfig c; c.zonalMax=6;
      regimes.push_back({"LEO_J6", 7078, 0.01, 51.6*PI/180, 20, c}); }
    { ForceConfig c; c.zonalMax=4;
      regimes.push_back({"GTO_J4", 24396, 0.73, 7*PI/180, 8, c}); }
    { ForceConfig c; c.zonalMax=4;
      regimes.push_back({"Molniya_J4", 26560, 0.74, 63.4*PI/180, 8, c}); }
    { ForceConfig c; c.zonalMax=2; c.useDrag=true; c.BC=0.02;
      c.density=makePiecewiseExp();
      regimes.push_back({"LEO_drag", 6778, 0.005, 51.6*PI/180, 20, c}); }

    const std::vector<double> tols={1e-6,1e-8,1e-10,1e-12};

    std::printf("regime,formulation,rtol,arc_rev,pos_err_m,nfev,time_us\n");
    for(auto& rg: regimes){
        Vec3 r0,v0; kep2rv(rg.a,rg.e,rg.i,40*PI/180,30*PI/180,0.0,r0,v0);
        const double P=TWO_PI*std::sqrt(rg.a*rg.a*rg.a/MU_EARTH);
        const double tf=rg.arcRev*P;
        // reference: tight Cowell
        auto ref=propagateCowell(r0,v0,tf,rg.cfg,1e-13,1e-13);
        for(double tol: tols){
            const double at=tol*1e-3;
            Vec3 r,v;
            // Cowell
            { double us=timeit([&]{return propagateCowell(r0,v0,tf,rg.cfg,tol,at);},5,r,v);
              auto R=propagateCowell(r0,v0,tf,rg.cfg,tol,at);
              std::printf("%s,Cowell,%.0e,%.0f,%.6e,%u,%.1f\n",rg.name.c_str(),tol,
                          rg.arcRev,norm(R.r-ref.r)*1000,R.stats.nfev,us);}
            // Encke
            { double us=timeit([&]{return propagateEncke(r0,v0,tf,rg.cfg,tol,at,0.01);},5,r,v);
              auto R=propagateEncke(r0,v0,tf,rg.cfg,tol,at,0.01);
              std::printf("%s,Encke,%.0e,%.0f,%.6e,%u,%.1f\n",rg.name.c_str(),tol,
                          rg.arcRev,norm(R.r-ref.r)*1000,R.stats.nfev,us);}
            // MEE
            { double us=timeit([&]{return propagateMee(r0,v0,tf,rg.cfg,tol,at);},5,r,v);
              auto R=propagateMee(r0,v0,tf,rg.cfg,tol,at);
              std::printf("%s,MEE,%.0e,%.0f,%.6e,%u,%.1f\n",rg.name.c_str(),tol,
                          rg.arcRev,norm(R.r-ref.r)*1000,R.stats.nfev,us);}
            // KS
            { double us=timeit([&]{return propagateKS(r0,v0,tf,rg.cfg,tol,at);},5,r,v);
              auto R=propagateKS(r0,v0,tf,rg.cfg,tol,at);
              std::printf("%s,KS,%.0e,%.0f,%.6e,%u,%.1f\n",rg.name.c_str(),tol,
                          rg.arcRev,norm(R.r-ref.r)*1000,R.stats.nfev,us);}
            // DROMO
            { double us=timeit([&]{return propagateDromo(r0,v0,tf,rg.cfg,tol,at);},5,r,v);
              auto R=propagateDromo(r0,v0,tf,rg.cfg,tol,at);
              std::printf("%s,DROMO,%.0e,%.0f,%.6e,%u,%.1f\n",rg.name.c_str(),tol,
                          rg.arcRev,norm(R.r-ref.r)*1000,R.stats.nfev,us);}
        }
    }
    return 0;
}
