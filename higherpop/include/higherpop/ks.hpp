// higherpop/ks.hpp — Kustaanheimo-Stiefel regularized propagation.
//
// The KS transformation maps 3D Cartesian motion to a 4D harmonic oscillator
// using the fictitious time s with the Sundman relation dt = r ds. The
// perturbed equations of motion are
//     u'' = (h/2) u + (r/2) L(u)^T P        (note: h = -2E > 0 for ellipse)
//     t'  = r
//     E'  = L?  -> we integrate energy from power:  dE/ds = r (v . P)
// where ' = d/ds, P is the perturbing acceleration, and L(u) is the KS matrix.
//
// Unlike hpop's `stiefelStep` (a fixed-step Verlet that recomputes energy each
// step), higherpop integrates the *regularized state* directly with the shared
// adaptive DP54 stepper. State layout (N=10):
//     [ u0..u3, up0..up3, t, E ]
// The oscillator form makes the step size nearly uniform in true anomaly, so
// eccentric orbits cost roughly the same per revolution as circular ones —
// this is the regularization payoff.
#pragma once
#include "vec3.hpp"
#include "forces.hpp"
#include "integrator.hpp"
#include <array>
#include <cmath>

namespace hp {

// KS matrix L(u) applied to a 3-vector's 4-lift, and its transpose L^T·w (3→4).
inline std::array<double,4> ksLtranspose(const std::array<double,4>& u, const Vec3& w) noexcept {
    // L(u)^T maps a physical 3-vector (treated as 4-vector [w,0]) to KS space.
    const double u0=u[0],u1=u[1],u2=u[2],u3=u[3];
    return {  u0*w.x + u1*w.y + u2*w.z,
             -u1*w.x + u0*w.y + u3*w.z,
             -u2*w.x - u3*w.y + u0*w.z,
              u3*w.x - u2*w.y + u1*w.z };
}

inline Vec3 ksPosition(const std::array<double,4>& u) noexcept {
    const double u0=u[0],u1=u[1],u2=u[2],u3=u[3];
    return { u0*u0 - u1*u1 - u2*u2 + u3*u3,
             2.0*(u0*u1 - u2*u3),
             2.0*(u0*u2 + u1*u3) };
}

inline double ksRadius(const std::array<double,4>& u) noexcept {
    return u[0]*u[0]+u[1]*u[1]+u[2]*u[2]+u[3]*u[3];
}

inline Vec3 ksVelocity(const std::array<double,4>& u, const std::array<double,4>& up) noexcept {
    const double r = ksRadius(u);
    const double u0=u[0],u1=u[1],u2=u[2],u3=u[3];
    const double p0=up[0],p1=up[1],p2=up[2],p3=up[3];
    return { 2.0*(u0*p0 - u1*p1 - u2*p2 + u3*p3)/r,
             2.0*(u0*p1 + u1*p0 - u2*p3 - u3*p2)/r,
             2.0*(u0*p2 + u1*p3 + u2*p0 + u3*p1)/r };
}

struct KSState {
    std::array<double,4> u, up;
    double t{0}, E{0}, mu{MU_EARTH};
};

inline KSState ksFromCartesian(const Vec3& r, const Vec3& v, double mu) {
    KSState ks; ks.mu = mu;
    const double rMag = norm(r);
    ks.E = 0.5*dot(v,v) - mu/rMag;
    // Canonical KS lift (choose branch by sign of x to avoid singularity).
    std::array<double,4> u{};
    if (r.x >= 0.0) {
        const double w = std::sqrt(0.5*(rMag + r.x));
        u = { w, 0.5*r.y/w, 0.5*r.z/w, 0.0 };
    } else {
        const double w = std::sqrt(0.5*(rMag - r.x));
        u = { 0.5*r.y/w, w, 0.0, 0.5*r.z/w };
    }
    ks.u = u;
    // v = (2/r) L(u) u'  and  L(u)^T L(u) = r I  ⇒  u' = (1/2) L(u)^T v.
    auto Ltv = ksLtranspose(u, v);
    for (int i=0;i<4;++i) ks.up[i] = 0.5*Ltv[i];
    return ks;
}

inline void ksToCartesian(const KSState& ks, Vec3& r, Vec3& v) {
    r = ksPosition(ks.u);
    v = ksVelocity(ks.u, ks.up);
}

// The KS RHS in fictitious time s, over the 10-state [u0..3, up0..3, t, E].
//   u'  = up
//   up' = (E/... ) : oscillator + perturbation  (see below)
//   t'  = r
//   E'  = r (v . P)     (power delivered by the perturbation, per ds)
// For the pure Kepler problem P=0, E=const, and up' = (E/2)... wait: the
// regularized linear oscillator is  u'' + (|E|/2) u = 0 with |E| = -2E>0 for
// a bound orbit; including perturbation P and the energy coupling:
//   u'' = (E/2) u + (r/2) L(u)^T P
// (E<0 bound ⇒ +E/2 u is a restoring term.)
inline State<10> ksRhs(double /*s*/, const State<10>& y, const ForceConfig& c) {
    std::array<double,4> u{y[0],y[1],y[2],y[3]}, up{y[4],y[5],y[6],y[7]};
    const double E = y[9];
    const double r = ksRadius(u);
    const Vec3 pos = ksPosition(u);
    const Vec3 vel = ksVelocity(u, up);
    const Vec3 P = perturbation(pos, vel, c);        // perturbing accel only
    auto LtP = ksLtranspose(u, P);
    State<10> dy{};
    for (int i=0;i<4;++i) dy[i] = up[i];
    for (int i=0;i<4;++i) dy[4+i] = 0.5*E*u[i] + 0.5*r*LtP[i];
    dy[8] = r;                    // dt/ds = r
    dy[9] = r * dot(vel, P);      // dE/ds = r (v·P)
    return dy;
}

} // namespace hp
