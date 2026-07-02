// higherpop/forces.hpp — analytic perturbing accelerations (ECI, km/s^2).
//
// Design:
//  * A single `ForceConfig` selects which terms are on and carries the
//    pluggable atmosphere (a DensityFn — see atmosphere.hpp).
//  * `pointMass()` / `zonalPert()` / `dragAccel()` are separable so each
//    formulation takes exactly the piece it needs:
//      - Cowell integrates `totalAccel` (central + perturbations).
//      - Encke / VOP / regularized methods integrate `perturbation` (NO
//        central term) about their own reference.
//  * Zonal gravity uses a stable Legendre recursion (P_n and P_n' both by
//    recurrence), so adding J3..J6 is exact with no per-term hand algebra
//    and no pole singularity.
#pragma once
#include "constants.hpp"
#include "vec3.hpp"
#include "atmosphere.hpp"
#include <cmath>
#include <array>

namespace hp {

struct ForceConfig {
    int      zonalMax {2};        // highest zonal Jn retained (0=point mass, up to 6)
    bool     useDrag  {false};
    double   BC       {0.0};      // ballistic coefficient Cd*A/m  [m^2/kg]
    DensityFn density;            // pluggable atmosphere; empty => single-exp default
    double   omegaEarth {OMEGA_EARTH};
    double   mu       {MU_EARTH};
    double   Re       {RE_EARTH};
};

// Central two-body acceleration.
inline Vec3 pointMass(const Vec3& r, double mu) noexcept {
    const double r2 = dot(r, r);
    return (-mu / (std::sqrt(r2) * r2)) * r;
}

// Zonal-harmonic PERTURBING acceleration (J2..Jn), central term excluded.
// Derivation: U_n = -mu*Jn*(Re^n/r^{n+1})*P_n(u), u = z/r = sin(lat).
//   a = grad U ; with P_n, P_n' by recurrence:
//     P_0=1, P_1=u, n P_n = (2n-1) u P_{n-1} - (n-1) P_{n-2}
//     P_0'=0, P_1'=1, P_n' = u P_{n-1}' + n P_{n-1}
inline Vec3 zonalPert(const Vec3& r, const ForceConfig& c) noexcept {
    if (c.zonalMax < 2) return {0,0,0};
    const double mu = c.mu, Re = c.Re;
    const double rn = norm(r);
    const double u = r.z / rn;              // sin(latitude)
    const double rho = std::sqrt(r.x*r.x + r.y*r.y); // for x,y unit split
    static constexpr std::array<double,7> Jn = {0,0,J2,J3,J4,J5,J6};

    double Pnm2 = 1.0, Pnm1 = u;            // P_0, P_1
    double dPnm2 = 0.0, dPnm1 = 1.0;        // P_0', P_1'
    Vec3 a{0,0,0};
    for (int n = 2; n <= c.zonalMax; ++n) {
        const double Pn  = ((2.0*n - 1.0)*u*Pnm1 - (n - 1.0)*Pnm2) / n;
        const double dPn = u*dPnm1 + n*Pnm1;
        // radial/latitudinal split → Cartesian
        const double ReN = std::pow(Re / rn, n);
        const double common = mu * Jn[n] * ReN / (rn*rn);   // mu*Jn*(Re/r)^n / r^2
        // a_x = common * (x/r) * [ (n+1) P_n + u P_n' ]
        // a_y = common * (y/r) * [ (n+1) P_n + u P_n' ]
        // a_z = common       * [ (n+1) u P_n - (1-u^2) P_n' ]
        const double horiz = (n + 1.0)*Pn + u*dPn;
        a.x += common * (r.x/rn) * horiz;
        a.y += common * (r.y/rn) * horiz;
        a.z += common * ((n + 1.0)*u*Pn - (1.0 - u*u)*dPn);
        Pnm2 = Pnm1; Pnm1 = Pn;
        dPnm2 = dPnm1; dPnm1 = dPn;
    }
    (void)rho;
    return a;
}

// Cannonball drag with pluggable density. Returns km/s^2.
inline Vec3 dragAccel(const Vec3& r, const Vec3& v, const ForceConfig& c) noexcept {
    if (!c.useDrag || c.BC <= 0.0) return {0,0,0};
    const double rn = norm(r);
    DragQuery q;
    q.r_eci = r;
    q.alt_km = rn - c.Re;
    q.lat_rad = std::asin(std::max(-1.0, std::min(1.0, r.z / rn)));
    q.lon_rad = std::atan2(r.y, r.x);
    const double rho_si = c.density ? c.density(q)
                                    : 3.614e-13 * std::exp(-(q.alt_km - 700.0)/88.667);
    // Earth-relative velocity (rigid rotation about +z).
    const Vec3 vrel = v - Vec3{-c.omegaEarth * r.y, c.omegaEarth * r.x, 0.0};
    // Work in SI then convert to km/s^2:
    //   a[m/s^2] = -0.5 * rho[kg/m^3] * BC[m^2/kg] * |vrel| * vrel   (vrel in m/s)
    const Vec3 vrel_ms = vrel * 1000.0;
    const double vn_ms = norm(vrel_ms);
    const Vec3 a_ms = (-0.5 * rho_si * c.BC * vn_ms) * vrel_ms;
    return a_ms / 1000.0;
}

// Perturbing acceleration only (central term excluded) — for Encke/VOP/reg.
inline Vec3 perturbation(const Vec3& r, const Vec3& v, const ForceConfig& c) noexcept {
    return zonalPert(r, c) + dragAccel(r, v, c);
}

// Total acceleration including the central term — for Cowell.
inline Vec3 totalAccel(const Vec3& r, const Vec3& v, const ForceConfig& c) noexcept {
    return pointMass(r, c.mu) + zonalPert(r, c) + dragAccel(r, v, c);
}

} // namespace hp
