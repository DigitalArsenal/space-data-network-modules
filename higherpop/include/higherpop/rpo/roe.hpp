// higherpop/rpo/roe.hpp — Relative Orbital Elements and classical-element
// conversions for spacecraft relative motion (RPO).
//
// State definitions follow D'Amico's quasi-nonsingular ROE, as used in the
// Koenig–Guffanti–D'Amico STM family (JGCD 2017). Given a chief and deputy on
// nearby orbits, the ROE compactly parameterize the relative geometry and
// evolve slowly, so linear STMs propagate them accurately over many orbits.
//
// Quasi-nonsingular ROE (dimensionless; δa etc. are fractional):
//   δa   = (a_d - a_c) / a_c
//   δλ   = (M_d + ω_d) - (M_c + ω_c) + (Ω_d - Ω_c) cos i_c        (mean arg. lat.)
//   δe_x = e_d cos ω_d - e_c cos ω_c                              (rel. ecc. vector)
//   δe_y = e_d sin ω_d - e_c sin ω_c
//   δi_x = i_d - i_c                                              (rel. inc. vector)
//   δi_y = (Ω_d - Ω_c) sin i_c
#pragma once
#include "../vec3.hpp"
#include "../constants.hpp"
#include <array>
#include <cmath>

namespace hp { namespace rpo {

// Classical Keplerian elements (angles in radians, a in km).
struct Elements {
    double a;     // semimajor axis [km]
    double e;     // eccentricity
    double i;     // inclination [rad]
    double raan;  // right ascension of ascending node Ω [rad]
    double argp;  // argument of perigee ω [rad]
    double M;     // mean anomaly [rad]
};

// Quasi-nonsingular relative orbital elements.
struct ROE {
    double da, dl, dex, dey, dix, diy;
    std::array<double,6> vec() const { return {da,dl,dex,dey,dix,diy}; }
};

inline double wrapPi(double x){ while(x> PI)x-=TWO_PI; while(x<-PI)x+=TWO_PI; return x; }
inline double wrap2Pi(double x){ x=std::fmod(x,TWO_PI); return x<0?x+TWO_PI:x; }

// --- Kepler equation: mean -> eccentric -> true anomaly ---
inline double keplerEfromM(double M, double e){
    M = wrapPi(M);
    double E = (e<0.8)? M : PI;
    for(int k=0;k<50;++k){
        double f = E - e*std::sin(E) - M, fp = 1 - e*std::cos(E);
        double d = f/fp; E -= d; if(std::abs(d)<1e-14) break;
    }
    return E;
}
inline double trueFromE(double E,double e){
    return std::atan2(std::sqrt(1-e*e)*std::sin(E), std::cos(E)-e);
}
inline double EfromTrue(double nu,double e){
    return std::atan2(std::sqrt(1-e*e)*std::sin(nu), e+std::cos(nu));
}
inline double MfromE(double E,double e){ return E - e*std::sin(E); }

// --- state vector <-> classical elements ---
inline Elements rvToElements(const Vec3& r, const Vec3& v, double mu){
    const double R = norm(r), V2 = dot(v,v);
    Vec3 h = cross(r,v); const double H = norm(h);
    Vec3 nvec{-h.y, h.x, 0.0}; const double N = norm(nvec);
    Vec3 evec = ( (V2 - mu/R)*r - dot(r,v)*v ) * (1.0/mu);
    const double e = norm(evec);
    const double energy = V2/2 - mu/R;
    const double a = -mu/(2*energy);
    const double i = std::acos(std::max(-1.0,std::min(1.0, h.z/H)));
    double raan = (N>1e-12)? std::acos(std::max(-1.0,std::min(1.0, nvec.x/N))) : 0.0;
    if(nvec.y<0) raan = TWO_PI - raan;
    double argp = (N>1e-12 && e>1e-12)?
        std::acos(std::max(-1.0,std::min(1.0, dot(nvec,evec)/(N*e)))) : 0.0;
    if(evec.z<0) argp = TWO_PI - argp;
    double nu = (e>1e-12)?
        std::acos(std::max(-1.0,std::min(1.0, dot(evec,r)/(e*R)))) : 0.0;
    if(dot(r,v)<0) nu = TWO_PI - nu;
    // near-circular fallback: use argument of latitude for (argp+nu)
    if(e<1e-9){
        double u = std::acos(std::max(-1.0,std::min(1.0, dot(nvec,r)/(N*R))));
        if(r.z<0) u = TWO_PI-u; argp=0; nu=u;
    }
    double E = EfromTrue(nu,e);
    return { a, e, i, wrap2Pi(raan), wrap2Pi(argp), wrap2Pi(MfromE(E,e)) };
}

inline void elementsToRv(const Elements& el, double mu, Vec3& r, Vec3& v){
    const double E = keplerEfromM(el.M, el.e);
    const double nu = trueFromE(E, el.e);
    const double p = el.a*(1-el.e*el.e), R = p/(1+el.e*std::cos(nu));
    Vec3 rp{ R*std::cos(nu), R*std::sin(nu), 0 };
    Vec3 vp{ -std::sqrt(mu/p)*std::sin(nu), std::sqrt(mu/p)*(el.e+std::cos(nu)), 0 };
    const double co=std::cos(el.raan), so=std::sin(el.raan);
    const double cw=std::cos(el.argp), sw=std::sin(el.argp);
    const double ci=std::cos(el.i),   si=std::sin(el.i);
    // R = Rz(Ω) Rx(i) Rz(ω)
    auto rot=[&](const Vec3& u){
        double x1=cw*u.x - sw*u.y, y1=sw*u.x + cw*u.y, z1=u.z;       // Rz(ω)
        double x2=x1,          y2=ci*y1 - si*z1,  z2=si*y1 + ci*z1;  // Rx(i)
        return Vec3{ co*x2 - so*y2, so*x2 + co*y2, z2 };             // Rz(Ω)
    };
    r = rot(rp); v = rot(vp);
}

// --- ROE from two orbits (chief c, deputy d), quasi-nonsingular ---
inline ROE roeFromElements(const Elements& c, const Elements& d){
    ROE r;
    r.da  = (d.a - c.a)/c.a;
    r.dl  = wrapPi( (d.M + d.argp) - (c.M + c.argp) + (d.raan - c.raan)*std::cos(c.i) );
    r.dex = d.e*std::cos(d.argp) - c.e*std::cos(c.argp);
    r.dey = d.e*std::sin(d.argp) - c.e*std::sin(c.argp);
    r.dix = d.i - c.i;
    r.diy = wrapPi(d.raan - c.raan)*std::sin(c.i);
    return r;
}

// --- reconstruct deputy elements from chief + ROE ---
inline Elements deputyFromRoe(const Elements& c, const ROE& r){
    Elements d;
    d.a = c.a*(1 + r.da);
    d.i = c.i + r.dix;
    d.raan = c.raan + (std::abs(std::sin(c.i))>1e-9 ? r.diy/std::sin(c.i) : 0.0);
    double exd = r.dex + c.e*std::cos(c.argp);
    double eyd = r.dey + c.e*std::sin(c.argp);
    d.e = std::sqrt(exd*exd + eyd*eyd);
    d.argp = std::atan2(eyd, exd);
    // δλ = (M_d+ω_d) - (M_c+ω_c) + (Ω_d-Ω_c)cos i_c
    double Md_wd = r.dl + (c.M + c.argp) - (d.raan - c.raan)*std::cos(c.i);
    d.M = wrap2Pi(Md_wd - d.argp);
    d.raan = wrap2Pi(d.raan); d.argp = wrap2Pi(d.argp);
    return d;
}

}} // namespace hp::rpo
