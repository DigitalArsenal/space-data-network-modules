// validate.cpp — cross-formulation agreement + conservation checks.
#include "higherpop/formulations.hpp"
#include "higherpop/atmosphere.hpp"
#include <cstdio>
#include <cmath>

using namespace hp;

static void kep2rv(double a,double e,double i,double raan,double argp,double nu,
                   Vec3& r, Vec3& v) {
    const double mu=MU_EARTH, p=a*(1-e*e);
    const double rr=p/(1+e*std::cos(nu));
    Vec3 rp{rr*std::cos(nu), rr*std::sin(nu), 0};
    Vec3 vp{-std::sqrt(mu/p)*std::sin(nu), std::sqrt(mu/p)*(e+std::cos(nu)), 0};
    auto R3=[&](double t,Vec3 u){double c=std::cos(t),s=std::sin(t);
        return Vec3{c*u.x+s*u.y, -s*u.x+c*u.y, u.z};};
    auto R1=[&](double t,Vec3 u){double c=std::cos(t),s=std::sin(t);
        return Vec3{u.x, c*u.y+s*u.z, -s*u.y+c*u.z};};
    // perifocal -> ECI : R3(-raan) R1(-inc) R3(-argp)
    auto rot=[&](Vec3 u){ return R3(-raan, R1(-i, R3(-argp, u))); };
    r=rot(rp); v=rot(vp);
}

int main() {
    // ISS-like LEO
    Vec3 r0, v0;
    const double a=7078.0, e=0.01, inc=51.6*PI/180, raan=40*PI/180, argp=30*PI/180, nu=0;
    kep2rv(a,e,inc,raan,argp,nu, r0,v0);
    const double period = TWO_PI*std::sqrt(a*a*a/MU_EARTH);
    std::printf("period = %.4f min,  |r0|=%.3f km  |v0|=%.5f km/s\n",
                period/60, norm(r0), norm(v0));

    ForceConfig c;              // J2 only, no drag
    c.zonalMax = 2;

    const double tf = 10*period;
    const double rtol=1e-12, atol=1e-12;

    auto C = propagateCowell(r0,v0,tf,c,rtol,atol);
    auto M = propagateMee   (r0,v0,tf,c,rtol,atol);
    auto E = propagateEncke (r0,v0,tf,c,rtol,atol,0.01);

    auto dr=[&](const PropResult&A,const PropResult&B){return norm(A.r-B.r)*1000;};
    std::printf("\n[J2, 10 orbits]  final |r| Cowell=%.6f km\n", norm(C.r));
    std::printf("  Cowell vs MEE   : dr = %.6e m   (nfev C=%u M=%u)\n",
                dr(C,M), C.stats.nfev, M.stats.nfev);
    std::printf("  Cowell vs Encke : dr = %.6e m   (nfev E=%u)\n",
                dr(C,E), E.stats.nfev);

    // Two-body sanity: with no perturbation all must return to start after 1 period.
    ForceConfig kep; kep.zonalMax = 0;
    auto C0 = propagateCowell(r0,v0,period,kep,1e-13,1e-13);
    std::printf("\n[two-body, 1 period] Cowell return error dr=%.3e m  dv=%.3e mm/s\n",
                norm(C0.r-r0)*1000, norm(C0.v-v0)*1e6);

    // Energy check under J2 (Jacobi-like: specific energy not conserved under J2,
    // but the osculating SMA should stay bounded). Report SMA drift.
    auto sma=[&](const Vec3& r,const Vec3& v){double rn=norm(r);
        return 1.0/(2.0/rn - dot(v,v)/MU_EARTH);};
    std::printf("[J2] SMA start=%.6f  Cowell end=%.6f  MEE end=%.6f km\n",
                sma(r0,v0), sma(C.r,C.v), sma(M.r,M.v));

    // Drag smoke test with pluggable atmosphere.
    ForceConfig cd; cd.zonalMax=2; cd.useDrag=true; cd.BC=0.02;
    cd.density = makePiecewiseExp();
    auto D = propagateCowell(r0,v0,period,cd,1e-11,1e-11);
    std::printf("\n[J2+drag, 1 orbit, PiecewiseExp] SMA %.4f -> %.4f km (decay %.3f m)\n",
                sma(r0,v0), sma(D.r,D.v), (sma(r0,v0)-sma(D.r,D.v))*1000);
    return 0;
}
