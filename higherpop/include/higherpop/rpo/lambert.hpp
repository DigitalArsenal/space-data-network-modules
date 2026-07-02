// higherpop/rpo/lambert.hpp — Lambert two-point boundary-value solver.
//
// Given two position vectors r1, r2 and a time of flight tof, find the transfer
// orbit connecting them, returning the departure/arrival velocities v1, v2. This
// is the core targeting primitive for impulsive rendezvous and intercept.
//
// Implementation: universal-variables / Stumpff formulation (Bate–Mueller–White
// / Vallado Algorithm 58) with a bisection–Newton hybrid on the universal
// variable z. Handles both transfer directions (prograde / retrograde) and
// multiple revolutions are NOT included (single-rev, the common rendezvous case).
#pragma once
#include "../vec3.hpp"
#include "../constants.hpp"
#include "../kepler.hpp"     // stumpff C(z), S(z)
#include <cmath>

namespace hp { namespace rpo {

struct LambertSolution { Vec3 v1, v2; bool ok; int iters; };

// Stumpff functions (local, robust for z<0,=0,>0).
inline double stumpffC(double z){
    if(z>1e-6)  return (1.0-std::cos(std::sqrt(z)))/z;
    if(z<-1e-6){ double s=std::sqrt(-z); return (std::cosh(s)-1.0)/(-z); }
    return 0.5 - z/24.0 + z*z/720.0;
}
inline double stumpffS(double z){
    if(z>1e-6){ double s=std::sqrt(z);  return (s-std::sin(s))/(s*s*s); }
    if(z<-1e-6){ double s=std::sqrt(-z); return (std::sinh(s)-s)/(s*s*s); }
    return 1.0/6.0 - z/120.0 + z*z/5040.0;
}

// prograde=true selects the short-way/long-way by the sign of the orbit normal's
// z-component (assumes an equatorial-ish reference; for general use the caller can
// force the transfer angle via the 'longway' flag).
inline LambertSolution lambert(const Vec3& r1, const Vec3& r2, double tof,
                               double mu, bool prograde=true, bool longway=false){
    LambertSolution out; out.ok=false; out.iters=0;
    const double R1=norm(r1), R2=norm(r2);
    double cosdnu = dot(r1,r2)/(R1*R2);
    cosdnu = std::max(-1.0,std::min(1.0,cosdnu));
    // transfer angle and its sine sign from the cross product z-component
    Vec3 cr = cross(r1,r2);
    double dnu;
    if(!longway){
        dnu = std::acos(cosdnu);
        if(prograde ? (cr.z<0) : (cr.z>0)) dnu = TWO_PI - dnu;
    } else {
        dnu = TWO_PI - std::acos(cosdnu);
        if(prograde ? (cr.z<0) : (cr.z>0)) dnu = TWO_PI - dnu;
    }
    double sindnu = std::sin(dnu);
    // A parameter (Vallado): A = sin(dnu) sqrt(r1 r2 / (1 - cos dnu))
    double A = sindnu*std::sqrt(R1*R2/(1.0-cosdnu));
    if(std::abs(A)<1e-12){ return out; }   // degenerate (0 or π transfer)

    auto yOf=[&](double z){
        double C=stumpffC(z), S=stumpffS(z);
        return R1+R2 + A*(z*S-1.0)/std::sqrt(C);
    };
    auto tofOf=[&](double z)->double{
        double C=stumpffC(z), S=stumpffS(z);
        double y=yOf(z); if(y<0) return -1.0;
        double x=std::sqrt(y/C);
        return (x*x*x*S + A*std::sqrt(y))/std::sqrt(mu);
    };
    // bracket z: t increases with z. Start wide.
    double zlo=-4.0*PI*PI, zhi=4.0*PI*PI, z=0.0;
    // ensure y>0 at zlo by raising it
    for(int k=0;k<100 && yOf(zlo)<0.0;++k) zlo+=0.1;
    // bisection to get near, then Newton
    double tlo=tofOf(zlo), thi=tofOf(zhi);
    // expand zhi if needed
    for(int k=0;k<60 && thi<tof;++k){ zhi*=1.5; thi=tofOf(zhi); }
    // Safeguarded Newton on t(z): fast where the derivative is well-behaved,
    // bisection fallback whenever a Newton step leaves the bracket or hits y<0.
    z=0.5*(zlo+zhi);
    for(int it=0; it<60; ++it){
        double t=tofOf(z);
        out.iters=it+1;
        if(t<0){ zlo=z; z=0.5*(zlo+zhi); continue; }   // y<0 region, push up
        if(t < tof) zlo=z; else zhi=z;
        if(std::abs(t-tof) < 1e-11*tof + 1e-13) break;
        // dt/dz by analytic derivative (Vallado): use finite difference — robust.
        double dz=std::max(1e-6,1e-6*std::abs(z));
        double tp=tofOf(z+dz);
        double deriv=(tp>=0)? (tp-t)/dz : 0.0;
        double znew = (deriv!=0.0)? z-(t-tof)/deriv : 0.5*(zlo+zhi);
        z = (znew>zlo && znew<zhi && std::isfinite(znew)) ? znew : 0.5*(zlo+zhi);
    }
    // build velocities via Lagrange f,g
    double y=yOf(z);
    double f = 1.0 - y/R1;
    double g = A*std::sqrt(y/mu);
    double gdot = 1.0 - y/R2;
    out.v1 = (r2 - r1*f)*(1.0/g);
    out.v2 = (r2*gdot - r1)*(1.0/g);
    out.ok = std::isfinite(out.v1.x) && std::isfinite(out.v2.x) && g!=0.0;
    return out;
}

}} // namespace hp::rpo
