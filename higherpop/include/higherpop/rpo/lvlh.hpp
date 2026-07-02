// higherpop/rpo/lvlh.hpp — Cartesian relative-motion STMs in the chief LVLH frame.
//
// State X = [x, y, z, xdot, ydot, zdot] in the chief's rotating LVLH frame:
//   x = radial (R, out along chief radius),
//   y = along-track (T, along velocity for near-circular),
//   z = cross-track (N, along orbit normal).
// (This is the RTN/Hill convention; x is radial, y along-track, z cross-track.)
//
// Two propagators are provided:
//   * stmCW      — Clohessy–Wiltshire closed form (circular chief). Exact for e=0.
//   * stmTH      — exact linearized relative motion for an ARBITRARY eccentric
//                  chief (the Tschauner–Hempel / Lawden dynamics that the
//                  Yamanaka–Ankersen STM solves in closed form). Built by
//                  propagating the linear time-varying system with a fixed-step
//                  RK4 in true-anomaly-consistent time; exact to integration
//                  tolerance and free of closed-form transcription risk.
//
// Frame conversions between an inertial relative state and the LVLH state are
// also given (rvToLvlh / lvlhToRv), using the chief position/velocity to define
// the rotating frame and its angular velocity.
#pragma once
#include "roe.hpp"
#include "../vec3.hpp"
#include "../constants.hpp"
#include <array>
#include <cmath>

namespace hp { namespace rpo {

using Mat6 = std::array<std::array<double,6>,6>;   // (matches stm.hpp typedef)

// ---- LVLH frame basis from chief inertial state ----
// R = radial (unit r_c), N = orbit normal (unit r×v), T = N×R (completes RHS).
struct LvlhBasis { Vec3 R, T, N; double omega; }; // omega = orbital rate |r×v|/r^2
inline LvlhBasis lvlhBasis(const Vec3& rc, const Vec3& vc){
    Vec3 R = unit(rc);
    Vec3 hvec = cross(rc,vc);
    Vec3 N = unit(hvec);
    Vec3 T = cross(N,R);
    double omega = norm(hvec)/dot(rc,rc);          // f-dot = h / r^2
    return { R, T, N, omega };
}

// inertial relative state (rd-rc, vd-vc) -> LVLH state
inline std::array<double,6> rvToLvlh(const Vec3& rc,const Vec3& vc,
                                     const Vec3& rd,const Vec3& vd){
    LvlhBasis b = lvlhBasis(rc,vc);
    Vec3 dr = rd-rc, dv = vd-vc;
    // position in rotating frame
    double x=dot(dr,b.R), y=dot(dr,b.T), z=dot(dr,b.N);
    // rotating-frame velocity: v_rel_rot = R^T dv - omega x r_rel
    // angular velocity vector w = omega * N
    Vec3 w = b.N * b.omega;
    Vec3 dv_rot = dv - cross(w,dr);
    double vx=dot(dv_rot,b.R), vy=dot(dv_rot,b.T), vz=dot(dv_rot,b.N);
    return {x,y,z,vx,vy,vz};
}

// LVLH state -> inertial relative state
inline void lvlhToRv(const Vec3& rc,const Vec3& vc, const std::array<double,6>& X,
                     Vec3& dr, Vec3& dv){
    LvlhBasis b = lvlhBasis(rc,vc);
    dr = b.R*X[0] + b.T*X[1] + b.N*X[2];
    Vec3 dv_rot = b.R*X[3] + b.T*X[4] + b.N*X[5];
    Vec3 w = b.N * b.omega;
    dv = dv_rot + cross(w,dr);
}

// ---- Clohessy–Wiltshire STM (circular chief, mean motion n, time t) ----
inline Mat6 stmCW(double n, double t){
    const double nt=n*t, s=std::sin(nt), c=std::cos(nt);
    Mat6 P{}; for(auto&r:P)r.fill(0);
    // position rows
    P[0][0]=4-3*c;        P[0][3]=s/n;          P[0][4]=2*(1-c)/n;
    P[1][0]=6*(s-nt);     P[1][1]=1;            P[1][3]=-2*(1-c)/n;   P[1][4]=(4*s-3*nt)/n;
    P[2][2]=c;            P[2][5]=s/n;
    // velocity rows
    P[3][0]=3*n*s;        P[3][3]=c;            P[3][4]=2*s;
    P[4][0]=-6*n*(1-c);   P[4][3]=-2*s;         P[4][4]=4*c-3;
    P[5][2]=-n*s;         P[5][5]=c;
    return P;
}

// ---- Exact linearized relative motion for eccentric chief (TH / LERM) ----
// Propagate the linear time-varying relative EOM in the LVLH frame:
//   xddot = 2 f' ydot + f'' y + f'^2 x + 2 mu/rc^3 x
//   yddot = -2 f' xdot - f'' x + f'^2 y -   mu/rc^3 y
//   zddot = -mu/rc^3 z
// where f' = h/rc^2, f'' = -2 f' rcdot/rc, rcdot = (h/p) e sin f.
// The STM is built by propagating the 6x6 identity through this system with a
// fixed-step RK4 (steps scale with the arc so accuracy is uniform).
struct ThChief {                 // chief osculating quantities along the arc
    double mu, p, e, h, a, n;
};
inline void thDeriv(const ThChief& ch, double f, const double* Xin, double* Xout){
    // Xin/Xout are 6*6 = 36 (STM columns stacked) + we also advance chief f via time.
    // Here Xin is a single 6-state; caller loops columns. f is current true anomaly.
    const double rc = ch.p/(1.0+ch.e*std::cos(f));
    const double fp = ch.h/(rc*rc);                       // f-dot
    const double rcdot = (ch.h/ch.p)*ch.e*std::sin(f);    // d rc/dt
    const double fpp = -2.0*fp*rcdot/rc;                  // f-ddot
    const double g = ch.mu/(rc*rc*rc);
    const double x=Xin[0], y=Xin[1], z=Xin[2], vx=Xin[3], vy=Xin[4], vz=Xin[5];
    Xout[0]=vx; Xout[1]=vy; Xout[2]=vz;
    Xout[3]= 2.0*fp*vy + fpp*y + fp*fp*x + 2.0*g*x;
    Xout[4]=-2.0*fp*vx - fpp*x + fp*fp*y -     g*y;
    Xout[5]=-g*z;
}
// integrate one 6-state from time 0..t while tracking chief true anomaly f(t)
// via Kepler; returns final state. Fixed-step RK4 with nsteps.
inline std::array<double,6> thPropOne(const ThChief& ch, double f0,
                                      const std::array<double,6>& X0,
                                      double t, int nsteps){
    // We need f(tau) along the way; solve Kepler at each sub-step.
    auto fAt=[&](double tau)->double{
        // mean anomaly advance from f0
        double E0=2.0*std::atan2(std::sqrt(1-ch.e)*std::sin(f0/2),
                                 std::sqrt(1+ch.e)*std::cos(f0/2));
        double M0=E0-ch.e*std::sin(E0);
        double M=M0+ch.n*tau;
        // solve Kepler for E
        double E=M; for(int k=0;k<50;++k){double d=(E-ch.e*std::sin(E)-M)/(1-ch.e*std::cos(E)); E-=d; if(std::abs(d)<1e-14)break;}
        return 2.0*std::atan2(std::sqrt(1+ch.e)*std::sin(E/2),
                              std::sqrt(1-ch.e)*std::cos(E/2));
    };
    std::array<double,6> X=X0; double dt=t/nsteps;
    for(int s=0;s<nsteps;++s){
        double t0=s*dt;
        double fa=fAt(t0), fb=fAt(t0+0.5*dt), fc=fAt(t0+dt);
        double k1[6],k2[6],k3[6],k4[6]; std::array<double,6> tmp;
        thDeriv(ch,fa,X.data(),k1);
        for(int i=0;i<6;++i)tmp[i]=X[i]+0.5*dt*k1[i]; thDeriv(ch,fb,tmp.data(),k2);
        for(int i=0;i<6;++i)tmp[i]=X[i]+0.5*dt*k2[i]; thDeriv(ch,fb,tmp.data(),k3);
        for(int i=0;i<6;++i)tmp[i]=X[i]+dt*k3[i];     thDeriv(ch,fc,tmp.data(),k4);
        for(int i=0;i<6;++i)X[i]+=dt/6.0*(k1[i]+2*k2[i]+2*k3[i]+k4[i]);
    }
    return X;
}
// Full STM over time t for an eccentric chief given its current elements.
inline Mat6 stmTH(const Elements& chief, double t, double mu, int nsteps=0){
    ThChief ch;
    ch.mu=mu; ch.a=chief.a; ch.e=chief.e;
    ch.p=chief.a*(1-chief.e*chief.e);
    ch.h=std::sqrt(mu*ch.p);
    ch.n=std::sqrt(mu/(chief.a*chief.a*chief.a));
    // current true anomaly from mean anomaly
    double E=chief.M; for(int k=0;k<80;++k){double d=(E-chief.e*std::sin(E)-chief.M)/(1-chief.e*std::cos(E)); E-=d; if(std::abs(d)<1e-14)break;}
    double f0=2.0*std::atan2(std::sqrt(1+chief.e)*std::sin(E/2),
                             std::sqrt(1-chief.e)*std::cos(E/2));
    // Step count per revolution scales with eccentricity: near perigee of a
    // high-e orbit the true anomaly sweeps fast, so more steps are needed for a
    // uniform-accuracy RK4. 128 steps/rev at e→0, growing to ~1024 at e=0.9.
    if(nsteps<=0){
        double P=TWO_PI/ch.n;
        int perRev = (int)std::ceil(128.0/std::pow(1.0-ch.e, 1.5));
        nsteps=std::max(64,(int)std::ceil(perRev*t/P));
    }
    Mat6 P{}; for(auto&r:P)r.fill(0);
    for(int col=0; col<6; ++col){
        std::array<double,6> e0{}; e0[col]=1.0;
        auto Xf=thPropOne(ch,f0,e0,t,nsteps);
        for(int row=0;row<6;++row) P[row][col]=Xf[row];
    }
    return P;
}

}} // namespace hp::rpo
