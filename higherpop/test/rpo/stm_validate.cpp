// Validate the Koenig–Guffanti–D'Amico J2 ROE STM (stmJ2Roe, exact closed form
// Eq. A6) two independent ways.
//
// TEST 1 (primary): STM vs the exact nonlinear secular-mean truth. Both are
// mean-element models, so this isolates the STM's LINEARIZATION error alone with
// no osculating/mean-conversion ambiguity. Chief & deputy mean elements are
// advanced with the closed-form Brouwer secular J2 rates (meanJ2Propagate), the
// mean ROE is formed at t, and compared to Φ(τ)·δα0.
//
// TEST 2 (end-to-end): STM vs a full nonlinear numerical propagation
// (propagateCowell under J2), with both endpoints converted osculating->mean by
// one-orbit averaging. This exercises the whole pipeline. NOTE: the simple
// period-average is a first-order mean map and carries a small along-track (δλ)
// bias at high eccentricity; the primary test above is the definitive check of
// STM correctness. A production osculating<->mean step would use the full
// Brouwer–Lyddane series.
#include "higherpop/higherpop.hpp"
#include "higherpop/rpo/roe.hpp"
#include "higherpop/rpo/stm.hpp"
#include "higherpop/rpo/mean_j2.hpp"
#include <cstdio>
#include <cmath>
#include <utility>
using namespace hp;
using namespace hp::rpo;

// TEST 1: STM vs closed-form nonlinear secular-mean truth.
static double stm_vs_meantruth(const Elements& chief, const ROE& roe,
                               double revs, int which, const char* label){
    const double mu = MU_EARTH;
    const double P = TWO_PI*std::sqrt(std::pow(chief.a,3)/mu);
    const double tf = revs*P;
    Elements dep0 = deputyFromRoe(chief, roe);
    ROE truth = (which==0)
        ? roeFromElements( Elements{chief.a,chief.e,chief.i,chief.raan,chief.argp,
              wrap2Pi(chief.M+std::sqrt(mu/std::pow(chief.a,3))*tf)},
            Elements{dep0.a,dep0.e,dep0.i,dep0.raan,dep0.argp,
              wrap2Pi(dep0.M+std::sqrt(mu/std::pow(dep0.a,3))*tf)} )
        : roeFromElements( meanJ2Propagate(chief,tf,mu), meanJ2Propagate(dep0,tf,mu) );
    Mat6 Phi = (which==0) ? stmKeplerian(chief,tf,mu) : stmJ2Roe(chief,tf,mu);
    ROE stm = propagateRoe(roe, Phi);
    auto a=truth.vec(); auto b=stm.vec();
    double d=0; for(int k=0;k<6;++k) d += (a[k]-b[k])*(a[k]-b[k]);
    d = std::sqrt(d)*chief.a*1000.0;
    printf("%-10s %-8s revs=%5.0f   ROE_err = %9.4f m\n",
           label, (which==0?"Kepler":"J2-STM"), revs, d);
    return d;
}

// TEST 2: STM vs full numerical propagation with osculating->mean averaging.
static double stm_vs_numeric(const Elements& chief, const ROE& roe0_osc,
                             double revs, const char* label){
    ForceConfig fc; fc.zonalMax = 2;
    const double mu = MU_EARTH;
    const double P = TWO_PI*std::sqrt(std::pow(chief.a,3)/mu);
    const double tf = revs*P;
    auto prop=[&](const Vec3& r,const Vec3& v,double dt)->std::pair<Vec3,Vec3>{
        if(dt<1e-9) return {r,v};
        auto R=propagateCowell(r,v,dt,fc,1e-12,1e-13); return {R.r,R.v};
    };
    Vec3 rc0,vc0, rd0,vd0;
    elementsToRv(chief, mu, rc0,vc0);
    elementsToRv(deputyFromRoe(chief,roe0_osc), mu, rd0,vd0);
    Elements cm0 = osculatingToMean(rc0,vc0,mu,prop);
    Elements dm0 = osculatingToMean(rd0,vd0,mu,prop);
    ROE roe0_mean = roeFromElements(cm0,dm0);
    auto Rc = propagateCowell(rc0,vc0,tf,fc,1e-12,1e-13);
    auto Rd = propagateCowell(rd0,vd0,tf,fc,1e-12,1e-13);
    ROE roeT_num = roeFromElements(osculatingToMean(Rc.r,Rc.v,mu,prop),
                                   osculatingToMean(Rd.r,Rd.v,mu,prop));
    ROE roeT_stm = propagateRoe(roe0_mean, stmJ2Roe(cm0,tf,mu));
    auto a=roeT_num.vec(); auto b=roeT_stm.vec();
    double d=0; for(int k=0;k<6;++k) d += (a[k]-b[k])*(a[k]-b[k]);
    d = std::sqrt(d)*chief.a*1000.0;
    printf("%-10s J2-STM   revs=%5.0f   ROE_err = %9.4f m  (numeric/avg)\n",
           label, revs, d);
    return d;
}

int main(){
    Elements leo{ 7078.0, 0.001, 51.6*PI/180, 40*PI/180, 0.0, 0.0 };
    ROE r1{ 0.0, 300.0/(leo.a*1000), 50e-6, 30e-6, 40e-6, 20e-6 };
    Elements gto{ 24396.0, 0.73, 20*PI/180, 40*PI/180, 30*PI/180, 0.0 };
    ROE r2{ 0.0, 500.0/(gto.a*1000), 80e-6, 40e-6, 30e-6, 20e-6 };
    Elements mol{ 26560.0, 0.74, 63.4*PI/180, 40*PI/180, 270*PI/180, 0.0 };
    ROE r3{ 0.0, 400.0/(mol.a*1000), 60e-6, 50e-6, 40e-6, 30e-6 };

    printf("=== TEST 1: STM vs nonlinear secular-mean truth ===\n");
    printf("-- LEO (e=0.001) --\n");
    for(double rv:{5.,15.,50.}) stm_vs_meantruth(leo,r1,rv,0,"LEO");
    for(double rv:{5.,15.,50.,100.}) stm_vs_meantruth(leo,r1,rv,1,"LEO");
    printf("-- GTO (e=0.73) --\n");
    for(double rv:{5.,15.,50.}) stm_vs_meantruth(gto,r2,rv,1,"GTO");
    printf("-- Molniya (e=0.74) --\n");
    for(double rv:{5.,15.,50.}) stm_vs_meantruth(mol,r3,rv,1,"Molniya");

    printf("\n=== TEST 2: STM vs full numerical J2 propagation (osc->mean avg) ===\n");
    for(double rv:{5.,15.,50.}) stm_vs_numeric(leo,r1,rv,"LEO");
    for(double rv:{5.,15.}) stm_vs_numeric(mol,r3,rv,"Molniya");
    return 0;
}
