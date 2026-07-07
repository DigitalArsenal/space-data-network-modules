// target_validate.cpp — validate the hp::target differential corrector.
//
// Three problems of increasing realism:
//  1. Analytic 2x2 root-find — checks the Newton/LM core.
//  2. Single tangential burn to raise apogee radius to a target — checks that
//     the solver drives a real orbit to a geometric goal (exact 2-body check).
//  3. Lambert cross-check: solve for the departure Delta-V that puts the s/c at
//     a target position after a fixed TOF, and confirm it matches the
//     closed-form Lambert solution (independent oracle).
//
// Build:
//   clang++ -std=c++17 -O3 -march=native -Iinclude \
//       test/target/target_validate.cpp -o target_validate
//
#include <cstdio>
#include <cmath>
#include "higherpop/target.hpp"
#include "higherpop/formulations.hpp"
#include "higherpop/kepler.hpp"
#include "higherpop/rpo/lambert.hpp"

using namespace hp;
using target::Vecd;

int main() {
  int fails=0;

  // ---------------------------------------------------------------- problem 1
  // Solve:  x0^2 + x1 = 3 ;  x0 - x1^2 = -1
  {
    target::ResidualFn f=[](const Vecd& x)->Vecd{
      return { x[0]*x[0]+x[1], x[0]-x[1]*x[1] };
    };
    target::Options o; o.tol=1e-12;
    auto res=target::solve(f,{2.0,0.5},{3.0,-1.0},o);
    printf("[1] analytic 2x2: converged=%d iters=%d nfev=%d resid=%.3e  x=(%.10f,%.10f)\n",
           res.converged,res.iters,res.nfev,res.residual_norm,res.controls[0],res.controls[1]);
    if(!res.converged) ++fails;
  }

  // ---------------------------------------------------------------- problem 2
  // Circular LEO at a0; single tangential burn dv at perigee; VARY dv so the
  // resulting apogee radius = target. Exact 2-body geometry cross-check.
  {
    const double mu=MU_EARTH, a0=7000.0;
    const double r0=a0, v0=std::sqrt(mu/a0);
    const double r_apo_target=8000.0;
    Vec3 R0{r0,0,0}, V0{0,v0,0};
    target::ResidualFn f=[&](const Vecd& x)->Vecd{
      double dv=x[0];
      double vn=norm(V0); Vec3 V=V0*((vn+dv)/vn);
      double v=norm(V), rr=norm(R0);
      double energy=0.5*v*v - mu/rr;
      double a=-mu/(2*energy);
      double h=norm(cross(R0,V));
      double e=std::sqrt(1.0 + 2.0*energy*h*h/(mu*mu));
      return { a*(1.0+e) };
    };
    target::Options o; o.tol=1e-8;
    auto res=target::solve(f,{0.1},{r_apo_target},o);
    double a_t=0.5*(r0+r_apo_target);
    double vp=std::sqrt(mu*(2.0/r0-1.0/a_t));
    double dv_exact=vp-v0;
    printf("[2] apogee-raise burn: converged=%d iters=%d dv=%.8f km/s (exact %.8f) err=%.2e mm/s\n",
           res.converged,res.iters,res.controls[0],dv_exact,std::fabs(res.controls[0]-dv_exact)*1e6);
    if(!res.converged || std::fabs(res.controls[0]-dv_exact)>1e-6) ++fails;
  }

  // ---------------------------------------------------------------- problem 3
  // Lambert cross-check: vary v1 (3 comps) so keplerUniversal(r1,v1,tof)->r2,
  // compare to closed-form Lambert v1.
  {
    const double mu=MU_EARTH;
    Vec3 r1{7000.0, 0.0, 0.0};
    Vec3 r2{ 2000.0, 6500.0, 1500.0 };
    double tof = 1800.0;
    auto lam = rpo::lambert(r1,r2,tof,mu,true,false);
    target::ResidualFn f=[&](const Vecd& x)->Vecd{
      Vec3 v1{x[0],x[1],x[2]};
      auto rv=keplerUniversal(r1,v1,tof,mu);
      return { rv.first.x, rv.first.y, rv.first.z };
    };
    target::Options o; o.tol=1e-9; o.fd_rel=1e-7;
    Vec3 guess=(r2-r1)/tof;
    auto res=target::solve(f,{guess.x,guess.y,guess.z},{r2.x,r2.y,r2.z},o);
    Vec3 v1_solved{res.controls[0],res.controls[1],res.controls[2]};
    double dv_match = norm(v1_solved - lam.v1)*1000.0;
    auto arr=keplerUniversal(r1,v1_solved,tof,mu);
    double miss=norm(arr.first-r2)*1000.0;
    printf("[3] Lambert cross-check: lambert_ok=%d converged=%d iters=%d\n",
           lam.ok,res.converged,res.iters);
    printf("    solved v1=(%.6f,%.6f,%.6f)  lambert v1=(%.6f,%.6f,%.6f)\n",
           v1_solved.x,v1_solved.y,v1_solved.z, lam.v1.x,lam.v1.y,lam.v1.z);
    printf("    |v1_targeter - v1_lambert| = %.3e m/s   arrival miss = %.3e m\n", dv_match, miss);
    if(!res.converged || dv_match>1e-3) ++fails;
  }

  printf("\n%s\n", fails==0 ? "TARGET VALIDATE: PASS" : "TARGET VALIDATE: FAIL");
  return fails==0?0:1;
}
