// higherpop/kepler.hpp — two-body propagation via universal variables.
// Used as the Encke reference conic. Vallado Algorithm 8 (Kepler-U).
#pragma once
#include "vec3.hpp"
#include <cmath>
#include <utility>

namespace hp {

inline void stumpff(double psi, double& c2, double& c3) noexcept {
    if (psi > 1e-6) {
        const double s = std::sqrt(psi);
        c2 = (1.0 - std::cos(s)) / psi;
        c3 = (s - std::sin(s)) / (s*s*s);
    } else if (psi < -1e-6) {
        const double s = std::sqrt(-psi);
        c2 = (1.0 - std::cosh(s)) / psi;
        c3 = (std::sinh(s) - s) / (s*s*s);
    } else {
        c2 = 0.5 - psi/24.0 + psi*psi/720.0;
        c3 = 1.0/6.0 - psi/120.0 + psi*psi/5040.0;
    }
}

// Propagate (r0,v0) by dt seconds under pure two-body. Returns (r, v).
inline std::pair<Vec3,Vec3> keplerUniversal(const Vec3& r0, const Vec3& v0,
                                            double dt, double mu) noexcept {
    const double r0n = norm(r0);
    const double v0n2 = dot(v0, v0);
    const double alpha = 2.0/r0n - v0n2/mu;      // 1/a
    const double sqmu = std::sqrt(mu);
    const double rdotv = dot(r0, v0);

    double chi;
    if (alpha > 1e-12) {                          // ellipse
        chi = sqmu * dt * alpha;
    } else if (alpha < -1e-12) {                  // hyperbola
        const double a = 1.0/alpha;
        chi = (dt>=0?1:-1)*std::sqrt(-a)*std::log(
                (-2.0*mu*alpha*dt) /
                (rdotv + (dt>=0?1:-1)*std::sqrt(-mu*a)*(1.0 - r0n*alpha)));
    } else {                                      // parabola
        chi = sqmu*dt/r0n;
    }

    double c2=0, c3=0, r=r0n;
    for (int i = 0; i < 200; ++i) {
        const double psi = chi*chi*alpha;
        stumpff(psi, c2, c3);
        r = chi*chi*c2 + rdotv/sqmu*chi*(1.0 - psi*c3) + r0n*(1.0 - psi*c2);
        const double dchi = (sqmu*dt - chi*chi*chi*c3
                             - rdotv/sqmu*chi*chi*c2 - r0n*chi*(1.0 - psi*c3)) / r;
        chi += dchi;
        if (std::fabs(dchi) < 1e-11) break;
    }
    const double psi = chi*chi*alpha;
    stumpff(psi, c2, c3);
    const double fdt = 1.0 - chi*chi/r0n*c2;
    const double gdt = dt - chi*chi*chi/sqmu*c3;
    const Vec3 rv = fdt*r0 + gdt*v0;
    const double rn = norm(rv);
    const double fdot = sqmu/(rn*r0n)*chi*(psi*c3 - 1.0);
    const double gdot = 1.0 - chi*chi/rn*c2;
    const Vec3 vv = fdot*r0 + gdot*v0;
    return {rv, vv};
}

} // namespace hp
