// higherpop/target.hpp — generic differential-correction / targeting solver.
//
// This is the FreeFlyer/STK-Astrogator "target sequence" primitive: vary a set
// of CONTROL variables until a set of GOAL functions hit their desired values,
// using a finite-difference Jacobian and a (damped, least-squares) Newton step.
//
// It is deliberately propagator-agnostic — you provide a residual functor
//     goals = f(controls)
// (typically "propagate with these controls, return the quantities you care
//  about"), the desired goal values, and initial controls. The solver does the
// rest. Square (n_control == n_goal), over-determined (more goals: least
// squares) and under-determined (more controls: minimum-norm) systems are all
// handled by the normal-equations solve with Levenberg-Marquardt damping.
//
// Units are yours — the solver only sees numbers. Provide per-control
// finite-difference step sizes matched to the control's scale.
//
// Header-only, dependency-free (uses only <vector>,<functional>,<cmath>,vec3).

#ifndef HIGHERPOP_TARGET_HPP
#define HIGHERPOP_TARGET_HPP

#include <vector>
#include <functional>
#include <cmath>
#include <algorithm>

namespace hp {
namespace target {

using Vecd = std::vector<double>;
using ResidualFn = std::function<Vecd(const Vecd&)>; // controls -> goals

struct Options {
  int    max_iter      = 50;
  double tol           = 1e-9;   // convergence: ||goals - desired|| (goal units)
  double fd_rel        = 1e-6;   // relative FD step (per control)
  double fd_abs        = 1e-9;   // absolute FD floor (per control)
  double lambda0       = 1e-6;   // initial Levenberg-Marquardt damping
  double lambda_up     = 10.0;   // damping growth on a rejected step
  double lambda_down   = 0.3;    // damping shrink on an accepted step
  double step_clip     = 0.0;    // max |dcontrol| per iter (0 = unclipped)
  bool   verbose       = false;
};

struct Result {
  Vecd   controls;      // solution (or best-so-far)
  Vecd   goals;         // achieved goal values
  double residual_norm; // ||goals - desired||
  int    iters;
  int    nfev;          // residual evaluations
  bool   converged;
};

// ---- small dense linear algebra (row-major, Gaussian elim w/ partial pivot) -
inline bool solveLinear(std::vector<Vecd>& A, Vecd& b) {
  const int n = (int)b.size();
  for (int col=0; col<n; ++col) {
    int piv=col; double best=std::fabs(A[col][col]);
    for (int r=col+1;r<n;++r){ double v=std::fabs(A[r][col]); if(v>best){best=v;piv=r;} }
    if (best < 1e-300) return false;
    if (piv!=col){ std::swap(A[piv],A[col]); std::swap(b[piv],b[col]); }
    double d=A[col][col];
    for (int r=col+1;r<n;++r){
      double f=A[r][col]/d; if(f==0.0) continue;
      for(int k=col;k<n;++k) A[r][k]-=f*A[col][k];
      b[r]-=f*b[col];
    }
  }
  for (int r=n-1;r>=0;--r){
    double s=b[r];
    for(int k=r+1;k<n;++k) s-=A[r][k]*b[k];
    b[r]=s/A[r][r];
  }
  return true;
}

// ---- finite-difference Jacobian J[i][j] = d goal_i / d control_j ------------
inline std::vector<Vecd> jacobian(const ResidualFn& f, const Vecd& x,
                                  const Vecd& f0, const Options& o, int& nfev) {
  const int m=(int)f0.size(), n=(int)x.size();
  std::vector<Vecd> J(m, Vecd(n,0.0));
  Vecd xp=x;
  for (int j=0;j<n;++j){
    double h = o.fd_rel*std::fabs(x[j]) + o.fd_abs;
    xp[j]=x[j]+h;
    Vecd fp=f(xp); ++nfev;
    xp[j]=x[j];
    for(int i=0;i<m;++i) J[i][j]=(fp[i]-f0[i])/h;
  }
  return J;
}

inline double norm2(const Vecd& v){ double s=0; for(double x:v) s+=x*x; return std::sqrt(s); }

// ---- the solver -------------------------------------------------------------
// Solve f(controls) == desired for `controls`, starting from x0.
// step[j] gives the FD step scale for control j if you want per-control control;
// pass empty to use Options fd_rel/fd_abs.
inline Result solve(const ResidualFn& f, const Vecd& x0, const Vecd& desired,
                    const Options& o = Options()) {
  Vecd x=x0;
  int nfev=0;
  Vecd g=f(x); ++nfev;
  const int m=(int)g.size(), n=(int)x.size();
  auto resid=[&](const Vecd& gg){ Vecd r(m); for(int i=0;i<m;++i) r[i]=gg[i]-desired[i]; return r; };
  Vecd r=resid(g);
  double rn=norm2(r);
  double lambda=o.lambda0;
  Result best{ x, g, rn, 0, nfev, rn<o.tol };
  if (best.converged) return best;

  for (int it=1; it<=o.max_iter; ++it) {
    std::vector<Vecd> J = jacobian(f,x,g,o,nfev);
    // Normal equations: (JᵀJ + λ diag(JᵀJ)) dx = -Jᵀ r  (Levenberg-Marquardt)
    std::vector<Vecd> JTJ(n, Vecd(n,0.0));
    Vecd JTr(n,0.0);
    for (int a=0;a<n;++a){
      for (int b=0;b<n;++b){ double s=0; for(int i=0;i<m;++i) s+=J[i][a]*J[i][b]; JTJ[a][b]=s; }
      double s=0; for(int i=0;i<m;++i) s+=J[i][a]*r[i]; JTr[a]=s;
    }
    // try LM steps, growing lambda until we get a decrease
    bool accepted=false;
    for (int tries=0; tries<12 && !accepted; ++tries) {
      std::vector<Vecd> Aug=JTJ; Vecd rhs(n);
      for (int a=0;a<n;++a){ Aug[a][a]+=lambda*(JTJ[a][a]>0?JTJ[a][a]:1.0); rhs[a]=-JTr[a]; }
      Vecd dx=rhs;
      if (!solveLinear(Aug,dx)) { lambda*=o.lambda_up; continue; }
      if (o.step_clip>0.0){ double dn=norm2(dx); if(dn>o.step_clip){ double s=o.step_clip/dn; for(double& v:dx) v*=s; } }
      Vecd xt(n); for(int j=0;j<n;++j) xt[j]=x[j]+dx[j];
      Vecd gt=f(xt); ++nfev;
      Vecd rt=resid(gt); double rtn=norm2(rt);
      if (rtn < rn) { x=xt; g=gt; r=rt; rn=rtn; lambda*=o.lambda_down; accepted=true; }
      else lambda*=o.lambda_up;
    }
    if (rn < best.residual_norm){ best.controls=x; best.goals=g; best.residual_norm=rn; }
    best.iters=it; best.nfev=nfev;
    if (rn < o.tol) { best.converged=true; break; }
    if (!accepted) break; // stuck — return best so far
  }
  best.converged = best.residual_norm < o.tol;
  return best;
}

} // namespace target
} // namespace hp

#endif // HIGHERPOP_TARGET_HPP
