// Validate the Lambert solver by round-trip: pick a known transfer orbit, take
// r1 and r2 = its endpoints at times separated by tof, solve Lambert, and check
// (a) the recovered v1 matches the true departure velocity, and
// (b) propagating (r1,v1) for tof lands on r2.
#include "higherpop/higherpop.hpp"
#include "higherpop/rpo/roe.hpp"
#include "higherpop/rpo/lambert.hpp"
#include "higherpop/kepler.hpp"
#include <cstdio>
#include <cmath>
using namespace hp;
using namespace hp::rpo;

static void test(const char* lbl, const Elements& orb, double tofFrac, bool prograde){
    const double mu=MU_EARTH;
    const double n=std::sqrt(mu/std::pow(orb.a,3)), P=TWO_PI/n, tof=tofFrac*P;
    Vec3 r1,v1true; elementsToRv(orb,mu,r1,v1true);
    auto P2=keplerUniversal(r1,v1true,tof,mu);
    Vec3 r2=P2.first, v2true=P2.second;

    LambertSolution sol = lambert(r1,r2,tof,mu,prograde);
    if(!sol.ok){ printf("%-22s  FAILED (no solution)\n",lbl); return; }
    // arrival check: propagate recovered v1
    auto Pa=keplerUniversal(r1,sol.v1,tof,mu);
    double arr_err=norm(Pa.first - r2)*1000.0;                 // m
    double dv1_err=norm(sol.v1 - v1true)*1000.0;               // m/s
    double dv2_err=norm(sol.v2 - v2true)*1000.0;
    printf("%-22s tof=%.2f P  iters=%3d  arrival=%.3e m  |v1-v1t|=%.3e m/s  |v2-v2t|=%.3e m/s\n",
           lbl,tofFrac,sol.iters,arr_err,dv1_err,dv2_err);
}

int main(){
    printf("== Lambert round-trip validation ==\n");
    Elements leo{7000.0,0.01,51.6*PI/180,40*PI/180,30*PI/180,0.0};
    test("LEO  0.15 rev", leo,0.15,true);
    test("LEO  0.35 rev", leo,0.35,true);
    test("LEO  0.75 rev", leo,0.75,true);
    Elements gto{24396.0,0.73,20*PI/180,40*PI/180,30*PI/180,20*PI/180};
    test("GTO  0.20 rev", gto,0.20,true);
    test("GTO  0.60 rev", gto,0.60,true);
    Elements meo{12000.0,0.2,45*PI/180,10*PI/180,60*PI/180,90*PI/180};
    test("MEO  0.40 rev", meo,0.40,true);

    // A rendezvous-style application: chief + deputy, deputy must reach chief in T.
    printf("\n== rendezvous intercept (deputy -> chief position in tof) ==\n");
    Elements chief{7100.0,0.005,51.6*PI/180,40*PI/180,30*PI/180,0.0};
    Vec3 rc,vc; elementsToRv(chief,MU_EARTH,rc,vc);
    // deputy 10 km behind along-track (approx): offset chief M slightly
    Elements dep=chief; dep.M=chief.M-0.0014;   // ~10 km behind
    Vec3 rd,vd; elementsToRv(dep,MU_EARTH,rd,vd);
    double tof=0.25*TWO_PI/std::sqrt(MU_EARTH/std::pow(chief.a,3));
    // where is the chief after tof? intercept that point.
    auto Pc=keplerUniversal(rc,vc,tof,MU_EARTH);
    LambertSolution sol=lambert(rd,Pc.first,tof,MU_EARTH,true);
    auto Pa=keplerUniversal(rd,sol.v1,tof,MU_EARTH);
    double miss=norm(Pa.first-Pc.first)*1000.0;
    double dv_depart=norm(sol.v1-vd)*1000.0;
    printf("intercept miss distance = %.3e m,   departure Δv = %.4f m/s\n",miss,dv_depart);
    return 0;
}