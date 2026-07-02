// higherpop/dromo.hpp — DROMO regularized element propagation (Peláez).
//
// DROMO integrates 8 slowly-varying elements against the ideal anomaly sigma:
//   tau            non-dimensional time
//   z1, z2         eccentricity-vector components in the ideal frame
//   z3 = 1/h       inverse non-dimensional angular momentum
//   n1..n4         Euler parameters (quaternion) of the orbital plane
// Equations of motion (Urrutxua, Morante, Sanjurjo-Rivo, Peláez, "DROMO
// Propagator Revisited", AAS 13-488):
//
//   dtau/dsigma = 1/(z3^3 s^2)
//   dz1/dsigma  =  s sinσ apx~ + (z1 + (1+s)cosσ) apy~
//   dz2/dsigma  = -s cosσ apx~ + (z2 + (1+s)sinσ) apy~
//   dz3/dsigma  = -z3 apy~
//   dn1/dsigma  = ½ apz~ ( n4 cosσ - n3 sinσ )
//   dn2/dsigma  = ½ apz~ ( n3 cosσ + n4 sinσ )
//   dn3/dsigma  = ½ apz~ (-n2 cosσ + n1 sinσ )
//   dn4/dsigma  = ½ apz~ (-n1 cosσ - n2 sinσ )
//   s = 1 + z1 cosσ + z2 sinσ,   1/r = z3^2 s
//   apx~,apy~,apz~ = ap_{x,y,z} / (z3^4 s^3)   (orbital-frame: radial/transv/normal)
//
// Non-dimensionalization: Lc = |r0|, Vc = sqrt(mu/Lc), Tc = Lc/Vc,
// acceleration scale = mu/Lc^2, so mu_nd = 1.
#pragma once
#include "vec3.hpp"
#include "forces.hpp"
#include "integrator.hpp"
#include <array>
#include <cmath>

namespace hp {

// --- quaternion (n1,n2,n3,n4), n4 scalar; columns of R are (u1,u2,k) ---
struct Mat3 { Vec3 c0, c1, c2; };   // columns

inline Mat3 dromoQuatToFrame(double n1,double n2,double n3,double n4) noexcept {
    Mat3 M;
    M.c0 = { 1-2*(n2*n2+n3*n3), 2*(n1*n2+n3*n4),   2*(n1*n3-n2*n4)   };
    M.c1 = { 2*(n1*n2-n3*n4),   1-2*(n1*n1+n3*n3), 2*(n2*n3+n1*n4)   };
    M.c2 = { 2*(n1*n3+n2*n4),   2*(n2*n3-n1*n4),   1-2*(n1*n1+n2*n2) };
    return M;
}

// extract Euler params from frame columns (u1,u2,k) — Shepperd's method
inline std::array<double,4> dromoFrameToQuat(const Vec3& u1,const Vec3& u2,const Vec3& k) noexcept {
    // Rotation matrix R with columns u1,u2,k. R_ij:
    double R00=u1.x,R01=u2.x,R02=k.x;
    double R10=u1.y,R11=u2.y,R12=k.y;
    double R20=u1.z,R21=u2.z,R22=k.z;
    double tr=R00+R11+R22;
    double n1,n2,n3,n4;
    if (tr>0){ double S=std::sqrt(tr+1.0)*2; n4=0.25*S;
        n1=(R21-R12)/S; n2=(R02-R20)/S; n3=(R10-R01)/S; }
    else if (R00>R11 && R00>R22){ double S=std::sqrt(1.0+R00-R11-R22)*2;
        n4=(R21-R12)/S; n1=0.25*S; n2=(R01+R10)/S; n3=(R02+R20)/S; }
    else if (R11>R22){ double S=std::sqrt(1.0+R11-R00-R22)*2;
        n4=(R02-R20)/S; n1=(R01+R10)/S; n2=0.25*S; n3=(R12+R21)/S; }
    else { double S=std::sqrt(1.0+R22-R00-R11)*2;
        n4=(R10-R01)/S; n1=(R02+R20)/S; n2=(R12+R21)/S; n3=0.25*S; }
    return {n1,n2,n3,n4};
}

struct DromoSetup {
    double Lc, Vc, Tc, mu;      // non-dim scales
    double sigma0;              // initial ideal anomaly
    std::array<double,8> y0;    // [tau,z1,z2,z3,n1,n2,n3,n4]
};

inline DromoSetup dromoInit(const Vec3& r0, const Vec3& v0, double mu) {
    DromoSetup S; S.mu=mu;
    S.Lc = norm(r0);
    S.Vc = std::sqrt(mu/S.Lc);
    S.Tc = S.Lc/S.Vc;
    Vec3 x = r0/S.Lc, v = v0/S.Vc;            // non-dim, mu_nd=1
    Vec3 h = cross(x,v);
    Vec3 e = x*(-1.0/norm(x)) - cross(h,v);
    Vec3 k = h/norm(h);
    Vec3 u1 = e/norm(e);
    Vec3 u2 = cross(k,u1);
    Vec3 i0 = x/norm(x);
    Vec3 j0 = cross(k,i0);
    double cs = dot(i0,u1), sn = -dot(j0,u1);
    S.sigma0 = std::atan2(sn,cs);
    auto q = dromoFrameToQuat(u1,u2,k);
    S.y0 = { 0.0, norm(e), 0.0, 1.0/norm(h), q[0],q[1],q[2],q[3] };
    return S;
}

inline void dromoToCartesian(const DromoSetup& S, double sigma,
                             const std::array<double,8>& y, Vec3& r, Vec3& v) {
    double z1=y[1],z2=y[2],z3=y[3];
    Mat3 M = dromoQuatToFrame(y[4],y[5],y[6],y[7]);
    Vec3 u1=M.c0, u2=M.c1;
    double cs=std::cos(sigma), sn=std::sin(sigma);
    double s = 1.0 + z1*cs + z2*sn;
    double rr = 1.0/(z3*z3*s);                 // non-dim radius
    Vec3 idir = u1*cs + u2*sn;                 // radial
    Vec3 jdir = u1*(-sn) + u2*cs;              // transverse
    double drdtau = z3*(z1*sn - z2*cs);
    double hOverR = z3*s;                       // h/r = (1/z3)/rr = z3*s
    Vec3 x_nd = idir*rr;
    Vec3 v_nd = idir*drdtau + jdir*hOverR;
    r = x_nd*S.Lc;
    v = v_nd*S.Vc;
}

// RHS in sigma over the 8-state.
inline State<8> dromoRhs(double sigma, const State<8>& y,
                         const DromoSetup& S, const ForceConfig& c) {
    double z1=y[1],z2=y[2],z3=y[3];
    Mat3 M = dromoQuatToFrame(y[4],y[5],y[6],y[7]);
    Vec3 u1=M.c0, u2=M.c1, k=M.c2;
    double cs=std::cos(sigma), sn=std::sin(sigma);
    double s = 1.0 + z1*cs + z2*sn;
    double rr = 1.0/(z3*z3*s);
    Vec3 idir = u1*cs + u2*sn;
    Vec3 jdir = u1*(-sn) + u2*cs;
    double drdtau = z3*(z1*sn - z2*cs);
    double hOverR = z3*s;
    Vec3 x_nd = idir*rr;
    Vec3 v_nd = idir*drdtau + jdir*hOverR;
    // physical perturbation, then non-dimensionalize accel by Lc^2/mu
    Vec3 rp = x_nd*S.Lc, vp = v_nd*S.Vc;
    Vec3 ap_phys = perturbation(rp, vp, c);
    double accScale = S.Lc*S.Lc/S.mu;
    Vec3 ap = ap_phys*accScale;                // non-dim, orbital-frame projection next
    double apx = dot(ap,idir);                 // radial
    double apy = dot(ap,jdir);                 // transverse
    double apz = dot(ap,k);                    // normal
    double denom = z3*z3*z3*z3*s*s*s;
    double apxt=apx/denom, apyt=apy/denom, apzt=apz/denom;
    State<8> dy{};
    dy[0] = 1.0/(z3*z3*z3*s*s);                            // dtau/dsigma
    dy[1] =  s*sn*apxt + (z1 + (1.0+s)*cs)*apyt;
    dy[2] = -s*cs*apxt + (z2 + (1.0+s)*sn)*apyt;
    dy[3] = -z3*apyt;
    dy[4] = 0.5*apzt*( y[7]*cs - y[6]*sn );
    dy[5] = 0.5*apzt*( y[6]*cs + y[7]*sn );
    dy[6] = 0.5*apzt*(-y[5]*cs + y[4]*sn );
    dy[7] = 0.5*apzt*(-y[4]*cs - y[5]*sn );
    return dy;
}

} // namespace hp
