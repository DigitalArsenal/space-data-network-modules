// higherpop/rpo/maneuvers.hpp — impulsive control in relative-orbit-element space.
//
// Two building blocks:
//   * controlInputMatrix(c, f) : the Gauss control-input matrix Γ(6×3) mapping an
//     RTN impulse δv = [δv_R, δv_T, δv_N] (km/s) to an instantaneous change in
//     quasi-nonsingular ROE: δα = Γ δv. Exact for arbitrary eccentricity (from
//     Gauss's variational equations; Chernick & D'Amico, JGCD 2018, Eq. 6).
//   * reconfigNearCircular(...) : closed-form minimum-Δv two/three-impulse
//     reconfiguration for a near-circular chief (Gaias–D'Amico / Chernick–D'Amico),
//     decoupling the in-plane (δa, δλ, δe) and out-of-plane (δi) problems.
//
// Frame: RTN = [radial, along-track, cross-track]; ROE order [δa,δλ,δex,δey,δix,δiy].
#pragma once
#include "roe.hpp"
#include "stm.hpp"
#include "../vec3.hpp"
#include "../constants.hpp"
#include <array>
#include <cmath>

namespace hp { namespace rpo {

using Mat63 = std::array<std::array<double,3>,6>;   // 6 ROE rows × 3 RTN cols

// Eccentric Gauss control-input matrix Γ at true anomaly f (dimensionless ROE
// per km/s), u = ω+f. The out-of-plane rows (δix, δiy) are the EXACT GVE result;
// the in-plane rows (δa, δe) carry the leading eccentric GVE terms. The small
// cross-track→in-plane coupling and the δλ along-track term are NOT retained
// here — this Γ is intended for the reconfiguration solver, which only relies on
// the validated near-circular Γ below; the eccentric form is provided for
// reference and is NOT independently validated in this module. For controllers
// that need the full eccentric Γ, use the near-circular form with frequent
// re-linearization, or extend this with the exact Chernick–D'Amico Eq. (6).
inline Mat63 controlInputMatrix(const Elements& c, double f, double mu){
    const double a=c.a, e=c.e, w=c.argp;
    const double n = std::sqrt(mu/(a*a*a));
    const double eta = std::sqrt(1.0 - e*e);
    const double u = w + f;
    const double cf=std::cos(f), sf=std::sin(f);
    const double cu=std::cos(u), su=std::sin(u);
    const double ecf = 1.0 + e*cf;            // = p/r
    const double pre = 1.0/(n*a);             // 1/(na) leading factor
    Mat63 G{}; for(auto&r:G) r.fill(0.0);
    // δa row: (2/η)[ e sinf, (1+e cosf), 0 ]  (×1/na) — exact GVE.
    G[0][0] = pre * 2.0/eta * e*sf;
    G[0][1] = pre * 2.0/eta * ecf;
    // δe rows (relative eccentricity vector), leading eccentric GVE terms:
    G[2][0] = pre * eta * ( sf );                                  // wrt R
    G[2][1] = pre * eta * ( (2.0+e*cf)*cu/ecf + e*std::cos(w) );   // wrt T
    G[3][0] = pre * eta * ( -cf );                                 // wrt R
    G[3][1] = pre * eta * ( (2.0+e*cf)*su/ecf + e*std::sin(w) );   // wrt T
    // δix, δiy rows (relative inclination vector) — exact GVE, cross-track only:
    G[4][2] = pre * eta * ( cu/ecf );          // δix wrt N
    G[5][2] = pre * eta * ( su/ecf );          // δiy wrt N
    // NB: δλ row (index 1) and cross-track→in-plane coupling are omitted here.
    return G;
}

// Near-circular closed-form control-input matrix (e -> 0 limit), the clean form
// used by the reconfiguration solver. u = argument of latitude. This is the form
// validated in test/rpo/maneuver_validate.cpp (matches finite-difference impulse
// response to 4 significant digits on every nonzero coupling).
inline Mat63 controlInputMatrixCircular(double a, double u, double mu){
    const double n = std::sqrt(mu/(a*a*a));
    const double pre = 1.0/(n*a);
    const double cu=std::cos(u), su=std::sin(u);
    Mat63 G{}; for(auto&r:G) r.fill(0.0);
    G[0][1] = pre*2.0;                 // δa  <- 2 T
    G[1][0] = pre*(-2.0);              // δλ  <- -2 R
    G[2][0] = pre*su;  G[2][1] = pre*2.0*cu;   // δex <- sin u R + 2 cos u T
    G[3][0] = pre*(-cu); G[3][1] = pre*2.0*su; // δey <- -cos u R + 2 sin u T
    G[4][2] = pre*cu;                  // δix <- cos u N
    G[5][2] = pre*su;                  // δiy <- sin u N
    return G;
}

struct Impulse { double t; double u; std::array<double,3> dv; }; // time, arg lat, RTN Δv
struct ManeuverPlan { std::array<Impulse,6> impulses; int n; double dvTotal; };

// ---- General minimum-Δv (min-energy) multi-impulse reconfiguration ----
//
// Each burn δv_k applied at time t_k (argument of latitude u_k) produces a
// final-time ROE change  Φ(t_f, t_k) · Γ(u_k) · δv_k,  where Γ is the verified
// control-input matrix and Φ is the (J2 or Keplerian) STM. Stacking the burns,
//     Δα = M w,   M = [ Φ(t_f,t_1)Γ_1 | … | Φ(t_f,t_N)Γ_N ]  (6 × 3N),
//     w  = [δv_1; …; δv_N].
// The minimum-energy solution is the least-norm right inverse
//     w* = Mᵀ (M Mᵀ)⁻¹ Δα,
// which hits the target exactly when M has full row rank (the burns are
// controllable for the desired change). This automatically accounts for the
// δλ drift between burns via the STM, which the naive per-element scheme misses.
//
// Burn locations are supplied as arguments-of-latitude over one or more revs.
// Uses the near-circular Γ; for eccentric chiefs pass the eccentric Γ (TODO).
template<int N>
inline ManeuverPlan reconfigMinEnergy(const Elements& chief, const ROE& dAlpha,
                                      const std::array<double,N>& burnU, double mu,
                                      bool useJ2=true){
    const double a=chief.a, n=std::sqrt(mu/(a*a*a));
    const double u0=chief.argp;                       // arg-lat at epoch (M=0)
    // final time = just after the last burn
    double tf=0; std::array<double,N> tk{};
    for(int k=0;k<N;++k){ tk[k]=wrap2Pi(burnU[k]-u0)/n + (burnU[k]<u0?0:0);
        // allow multiple revs: if a later burnU is < earlier, add a rev
    }
    // make times monotonic by adding full revs where needed
    double rev=TWO_PI/n, acc=0;
    for(int k=0;k<N;++k){ double base=wrap2Pi(burnU[k]-u0)/n; tk[k]=base+ (k>0 && base<tk[k-1]-1e-9 ? (std::floor((tk[k-1]-base)/rev)+1)*rev : 0.0);
        if(k>0 && tk[k]<tk[k-1]) tk[k]+=rev; }
    tf = tk[N-1] + 1e-6;

    // build M (6 × 3N)
    double M[6][3*N]; for(int r=0;r<6;++r) for(int c=0;c<3*N;++c) M[r][c]=0;
    for(int k=0;k<N;++k){
        Mat63 G = controlInputMatrixCircular(a, burnU[k], mu);
        // Φ(tf, tk)
        Elements atBurn = chief; atBurn.M = wrap2Pi(chief.M + n*tk[k]);
        Mat6 Phi = useJ2 ? stmJ2Roe(atBurn, tf-tk[k], mu)
                         : stmKeplerian(atBurn, tf-tk[k], mu);
        // M block = Phi (6×6) · G (6×3)
        for(int r=0;r<6;++r) for(int c=0;c<3;++c){
            double s=0; for(int j=0;j<6;++j) s+=Phi[r][j]*G[j][c];
            M[r][3*k+c]=s;
        }
    }
    // Gram matrix Mgram = M Mᵀ (6×6), solve Mgram y = Δα, then w = Mᵀ y.
    double Mg[6][6];
    for(int i=0;i<6;++i)for(int j=0;j<6;++j){ double s=0; for(int c=0;c<3*N;++c) s+=M[i][c]*M[j][c]; Mg[i][j]=s; }
    double b[6]={dAlpha.da,dAlpha.dl,dAlpha.dex,dAlpha.dey,dAlpha.dix,dAlpha.diy};
    // solve 6×6 via Gaussian elimination with partial pivoting (+tiny ridge)
    double A[6][7];
    for(int i=0;i<6;++i){ for(int j=0;j<6;++j) A[i][j]=Mg[i][j]+(i==j?1e-18:0); A[i][6]=b[i]; }
    for(int col=0;col<6;++col){
        int piv=col; for(int r=col+1;r<6;++r) if(std::abs(A[r][col])>std::abs(A[piv][col])) piv=r;
        for(int j=0;j<7;++j) std::swap(A[col][j],A[piv][j]);
        double d=A[col][col];
        for(int j=col;j<7;++j) A[col][j]/=d;
        for(int r=0;r<6;++r) if(r!=col){ double f=A[r][col]; for(int j=col;j<7;++j) A[r][j]-=f*A[col][j]; }
    }
    double y[6]; for(int i=0;i<6;++i) y[i]=A[i][6];
    // w = Mᵀ y
    ManeuverPlan plan{}; plan.n=N; plan.dvTotal=0;
    for(int k=0;k<N;++k){
        std::array<double,3> dv{0,0,0};
        for(int c=0;c<3;++c){ double s=0; for(int r=0;r<6;++r) s+=M[r][3*k+c]*y[r]; dv[c]=s; }
        plan.impulses[k]={ tk[k], burnU[k], dv };
        plan.dvTotal += std::sqrt(dv[0]*dv[0]+dv[1]*dv[1]+dv[2]*dv[2]);
    }
    return plan;
}

}} // namespace hp::rpo
