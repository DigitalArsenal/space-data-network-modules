// higherpop/rpo/stm.hpp — State transition matrices for relative motion in
// quasi-nonsingular ROE.
//
// Three models, increasing fidelity, all mapping δα(t0) -> δα(t):
//   stmKeplerian  : unperturbed (only δλ drifts, from δa). Exact in Kepler.
//   stmJ2Roe      : Koenig–Guffanti–D'Amico J2 STM (JGCD 2017, quasi-nonsingular)
//                   — closed-form secular J2 effect, valid for arbitrary e.
//   (drag is handled additively in maneuvers.hpp via a δa/δλ decay term.)
//
// Koenig, Guffanti, D'Amico, "New State Transition Matrices for Spacecraft
// Relative Motion in Perturbed Orbits", JGCD 40(7), 2017. stmJ2Roe implements
// their EXACT closed-form quasi-nonsingular STM, Appendix A Eq. (A6) — the
// argument-of-perigee rotation is applied analytically term-by-term rather than
// via an explicit J-similarity product, so no matrix inverse is formed.
// Validated against the nonlinear secular-mean truth (see test/rpo/stm_validate.cpp):
// sub-metre through ~15 revs in all regimes; through 50 revs for LEO (0.02 m) and
// Molniya (0.23 m); GTO (e=0.73) reaches ~1.9 m at 50 revs. The residual is the
// gap between first-order secular-mean theory and true averaged J2 dynamics at
// high eccentricity, not an STM transcription error (the STM reproduces KGD
// secular theory to ~0.2 m at 5 revs / 0.6 m at 15 revs).
#pragma once
#include "roe.hpp"
#include <array>
#include <cmath>

namespace hp { namespace rpo {

using Mat6 = std::array<std::array<double,6>,6>;

inline Mat6 zeros6(){ Mat6 M{}; for(auto&r:M) r.fill(0.0); return M; }
inline Mat6 eye6(){ Mat6 M=zeros6(); for(int k=0;k<6;++k)M[k][k]=1.0; return M; }
inline std::array<double,6> matvec6(const Mat6& A, const std::array<double,6>& x){
    std::array<double,6> y{}; for(int i=0;i<6;++i){ double s=0; for(int j=0;j<6;++j)s+=A[i][j]*x[j]; y[i]=s; } return y;
}
inline Mat6 matmul6(const Mat6& A, const Mat6& B){
    Mat6 C=zeros6();
    for(int i=0;i<6;++i)for(int k=0;k<6;++k){ double a=A[i][k]; if(a==0)continue;
        for(int j=0;j<6;++j)C[i][j]+=a*B[k][j]; }
    return C;
}

// -------------------------------------------------------------------------
// Keplerian ROE STM: only the mean argument of latitude drifts, driven by δa.
//   δλ(t) = δλ0 - (3/2) n δa (t-t0);  all other ROE constant.
// -------------------------------------------------------------------------
inline Mat6 stmKeplerian(const Elements& c, double tau, double mu){
    const double n = std::sqrt(mu/(c.a*c.a*c.a));
    Mat6 P = eye6();
    P[1][0] = -1.5 * n * tau;   // ∂δλ/∂δa
    return P;
}

// -------------------------------------------------------------------------
// Koenig–Guffanti–D'Amico J2 STM (quasi-nonsingular, arbitrary eccentricity).
//
// Ordering here: δα = [δa, δλ, δe_x, δe_y, δi_x, δi_y].
//
// "Modified" ROE rotate the relative eccentricity vector by ω(t):
//   δe_x^mod = δe_x cos ω + δe_y sin ω
//   δe_y^mod = δe_y cos ω − δe_x sin ω
// so J(ω) is identity except the 2x2 block on (δe_x,δe_y):
//   [ cos ω  sin ω ; −sin ω  cos ω ].
// In modified coordinates the J2 secular plant matrix A' is CONSTANT (Eq. 24).
// The full STM is  Φ = J(ω0+ω̇τ)^{-1} [ I + (A_kep' + A_J2') τ ] J(ω0).
// -------------------------------------------------------------------------
inline Mat6 rotEccBlock(double ang){
    Mat6 J = eye6();
    const double c=std::cos(ang), s=std::sin(ang);
    J[2][2]= c; J[2][3]= s;
    J[3][2]=-s; J[3][3]= c;
    return J;
}

inline Mat6 stmJ2Roe(const Elements& c, double tau, double mu,
                     double J2=hp::J2, double Re=hp::RE_EARTH){
    // Exact closed-form quasi-nonsingular J2 STM, Koenig–Guffanti–D'Amico
    // JGCD 2017, Appendix A, Eq. (A6). State order [δa, δλ, δe_x, δe_y, δi_x, δi_y].
    const double a=c.a, e=c.e, i=c.i;
    const double n = std::sqrt(mu/(a*a*a));
    const double eta = std::sqrt(1.0 - e*e);
    const double ci = std::cos(i);
    // κ = (3/4) J2 Re^2 √μ / (a^{7/2} η^4) = (3/4) J2 (Re/a)^2 n / η^4  (Eq. 14).
    const double kappa = 0.75 * J2 * (Re/a)*(Re/a) * n / (eta*eta*eta*eta);
    // Scalar substitutions (from the singular STM Eq. A5 / Eq. 14).
    const double P = 3.0*ci*ci - 1.0;    // 3cos^2 i - 1
    const double Q = 5.0*ci*ci - 1.0;    // 5cos^2 i - 1
    const double S = std::sin(2.0*i);    // sin 2i
    const double T = std::sin(i)*std::sin(i); // sin^2 i
    const double E = 1.0 + eta;
    const double F = 4.0 + 3.0*eta;
    const double G = 1.0/(eta*eta);
    // ω̇ = κ Q; advance the chief argument of perigee across the propagation.
    const double wdot = kappa * Q;
    const double wi = c.argp;
    const double wf = wi + wdot*tau;
    const double exi = e*std::cos(wi), eyi = e*std::sin(wi);   // initial ecc-vec
    const double exf = e*std::cos(wf), eyf = e*std::sin(wf);   // final ecc-vec
    const double cwt = std::cos(wdot*tau), swt = std::sin(wdot*tau);
    Mat6 P6 = eye6();
    // Row δa (0): identity — δa is secularly constant.
    // Row δλ (1):
    P6[1][0] = -(1.5*n + 3.5*kappa*E*P)*tau;
    P6[1][1] = 1.0;
    P6[1][2] =  kappa*exi*F*G*P*tau;
    P6[1][3] =  kappa*eyi*F*G*P*tau;
    P6[1][4] = -kappa*F*S*tau;
    // Row δe_x (2):
    P6[2][0] =  3.5*kappa*eyf*Q*tau;
    P6[2][2] =  cwt - 4.0*kappa*exi*eyf*G*Q*tau;
    P6[2][3] = -swt - 4.0*kappa*eyi*eyf*G*Q*tau;
    P6[2][4] =  5.0*kappa*eyf*S*tau;
    // Row δe_y (3):
    P6[3][0] = -3.5*kappa*exf*Q*tau;
    P6[3][2] =  swt + 4.0*kappa*exi*exf*G*Q*tau;
    P6[3][3] =  cwt + 4.0*kappa*eyi*exf*G*Q*tau;
    P6[3][4] = -5.0*kappa*exf*S*tau;
    // Row δi_x (4): identity — δi_x is secularly constant.
    // Row δi_y (5):
    P6[5][0] =  3.5*kappa*S*tau;
    P6[5][2] = -4.0*kappa*exi*G*S*tau;
    P6[5][3] = -4.0*kappa*eyi*G*S*tau;
    P6[5][4] =  2.0*kappa*T*tau;
    P6[5][5] =  1.0;
    return P6;
}

// Convenience: propagate a ROE state by a chosen STM over τ seconds.
inline ROE propagateRoe(const ROE& r0, const Mat6& Phi){
    auto y = matvec6(Phi, r0.vec());
    return { y[0],y[1],y[2],y[3],y[4],y[5] };
}

}} // namespace hp::rpo
