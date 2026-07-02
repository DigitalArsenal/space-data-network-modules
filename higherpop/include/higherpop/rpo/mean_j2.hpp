// higherpop/rpo/mean_j2.hpp — exact nonlinear secular-J2 mean-element rates.
//
// These are the closed-form Brouwer secular rates for the mean classical
// elements under J2 (the same ones Koenig et al. differentiate to build their
// ROE plant matrix). Integrating chief + deputy mean elements with these rates
// gives a "mean truth" against which the linear ROE STM can be validated
// independently of osculating short-period effects.
//
//   Ṁ = n + (3/4) J2 n (Re/p)^2 η (3cos^2 i − 1)      [η=√(1−e²), p=aη²]
//   ω̇ = (3/4) J2 n (Re/p)^2      (5cos^2 i − 1)
//   Ω̇ = −(3/2) J2 n (Re/p)^2 cos i
//   ȧ = ė = i̇ = 0   (secular)
#pragma once
#include "roe.hpp"
#include "../constants.hpp"
#include <cmath>
#include <array>

namespace hp { namespace rpo {

struct MeanRates { double Mdot, wdot, Odot, n; };

inline MeanRates meanJ2Rates(const Elements& el, double mu,
                             double J2=hp::J2, double Re=hp::RE_EARTH){
    const double a=el.a, e=el.e, i=el.i;
    const double n = std::sqrt(mu/(a*a*a));
    const double eta = std::sqrt(1.0 - e*e);
    const double p = a*eta*eta;
    const double f = 0.75 * J2 * n * (Re/p)*(Re/p);
    const double ci = std::cos(i);
    MeanRates r;
    r.n    = n;
    r.Mdot = n + f*eta*(3.0*ci*ci - 1.0);
    r.wdot = f*(5.0*ci*ci - 1.0);
    r.Odot = -2.0*f*ci;
    return r;
}

// Numerical osculating -> mean via one-orbit averaging of the slow variables.
// Short-period J2 terms integrate to ~zero over one orbit; because dM/dt = n is
// uniform, equal-time sampling over one period ≈ equal-mean-anomaly averaging,
// so the period-average of the osculating elements is a first-order mean set (no
// Brouwer-Lyddane series to transcribe). The propagator is FORWARD-ONLY, so we
// sample [0, P] and the returned mean elements are valid at the window MIDPOINT
// epoch + P/2. The caller compares two states averaged the same way (chief and
// deputy) and evaluates the STM at the same midpoint, so the P/2 offset cancels.
//
// prop(r,v,dt) -> (r,v) with dt >= 0.
template<class PropFn>
inline Elements osculatingToMean(const Vec3& r0, const Vec3& v0, double mu,
                                 PropFn&& prop, int samples=96){
    Elements e0 = rvToElements(r0,v0,mu);
    const double P = TWO_PI*std::sqrt(std::pow(e0.a,3)/mu);
    const double n = std::sqrt(mu/(e0.a*e0.a*e0.a));
    // Average over one period. dM/dt = n is constant, so equal-time sampling is
    // equal-mean-anomaly sampling — the average the secular J2 theory uses.
    // Average a, the eccentricity vector (e cosϖ, e sinϖ) with ϖ=ω+Ω, the
    // inclination, node, and detrended mean longitude λ = M+ω+Ω cos i0.
    double sa=0, sex=0, sey=0, si=0, sO=0, sl=0; int cnt=0;
    for(int k=0;k<samples;++k){
        double t = (k+0.5)*P/samples;
        auto pr = prop(r0,v0,t); Vec3 r=pr.first, v=pr.second;
        Elements e = rvToElements(r,v,mu);
        double pomega = e.argp + e.raan;
        double lam = e.M + e.argp + e.raan*std::cos(e0.i);
        sa += e.a;
        sex+= e.e*std::cos(pomega); sey+= e.e*std::sin(pomega);
        si += e.i; sO += e.raan; sl += wrapPi(lam - n*t); ++cnt;
    }
    Elements m = e0;
    m.a = sa/cnt;
    double exm=sex/cnt, eym=sey/cnt;
    m.e = std::sqrt(exm*exm+eym*eym);
    m.i = si/cnt; m.raan = wrap2Pi(sO/cnt);
    double pomega_m = std::atan2(eym,exm);
    m.argp = wrap2Pi(pomega_m - m.raan);
    double lam_mid = wrapPi(sl/cnt) + n*(0.5*P);
    m.M = wrap2Pi(lam_mid - m.argp - m.raan*std::cos(e0.i));
    return m;
}

// advance mean elements by dt under secular J2 (a,e,i fixed; angles drift)
inline Elements meanJ2Propagate(const Elements& el, double dt, double mu){
    MeanRates r = meanJ2Rates(el, mu);
    Elements o = el;
    o.M    = wrap2Pi(el.M    + r.Mdot*dt);
    o.argp = wrap2Pi(el.argp + r.wdot*dt);
    o.raan = wrap2Pi(el.raan + r.Odot*dt);
    return o;
}

}} // namespace hp::rpo
