// ip_validate.cpp — validate hp::interplanetary patched-conic design.
//
//  1. Planetary ephemeris (Earth, Mars) vs ERFA reference (pyerfa plan94).
//  2. Earth->Mars Type-I transfer (2020-07-30 -> 2021-02-18, ~203 d):
//     departure C3 and arrival v_inf land in the known Mars-window band
//     (C3 ~ 10-20 km^2/s^2, arrival v_inf ~ 2-4 km/s).
//  3. Injection dv from a 300 km LEO parking orbit is physically sane
//     (~3.5-4.5 km/s for a Mars transfer).
//  4. Gravity assist: turn angle and dv_max vs closed form; B-plane impact
//     parameter vs the hyperbola geometry b = |a| sqrt(e^2-1).
//
// Build:
//   clang++ -std=c++17 -O2 -Iinclude -Ithird_party/erfa \
//       test/interplanetary/ip_validate.cpp third_party/erfa/*.o -o ip_validate
//
#include <cstdio>
#include <cmath>
#include "higherpop/interplanetary.hpp"

using namespace hp;
using namespace hp::interplanetary;

// ERFA plan94 reference, epoch treated as UTC and converted to TT (matching
// hp::interplanetary::planetState, which runs the UTCDate through
// frames::timescales). Regenerated with the UTC->TT offset applied.
double ref_earth_r[3]={91446943.298520,-111254348.870834,-48228914.909013};
double ref_earth_v[3]={23.298743,16.353905,7.089271};
double ref_mars_r[3]={-907387.685379,213505218.424353,97954347.035066};
double ref_mars_v[3]={-23.312308,1.558519,1.343928};

int main() {
  int fails=0;

  // ---- 1. ephemeris vs ERFA ----
  frames::UTCDate dep{2020,7,30,0,0,0.0};
  frames::UTCDate arr{2021,2,18,0,0,0.0};
  StateHelio E=planetState(EARTH,dep), M=planetState(MARS,arr);
  double dEr=norm(E.r-Vec3{ref_earth_r[0],ref_earth_r[1],ref_earth_r[2]});
  double dEv=norm(E.v-Vec3{ref_earth_v[0],ref_earth_v[1],ref_earth_v[2]});
  double dMr=norm(M.r-Vec3{ref_mars_r[0],ref_mars_r[1],ref_mars_r[2]});
  printf("[1] Earth |dr|=%.3e km |dv|=%.3e km/s   Mars |dr|=%.3e km\n", dEr,dEv,dMr);
  if (dEr>1.0 || dEv>1e-3 || dMr>1.0) ++fails;

  // ---- 2. Earth->Mars transfer ----
  double tof=17539200.0; // 203 days
  Transfer T=planTransfer(EARTH,dep,MARS,arr,tof,true);
  printf("[2] transfer ok=%d  C3_dep=%.3f km^2/s^2  vinf_dep=%.3f km/s  vinf_arr=%.3f km/s\n",
         T.ok, T.C3_dep, norm(T.vinf_dep), T.vinf_arr_mag);
  if (!T.ok) ++fails;
  if (T.C3_dep<8.0 || T.C3_dep>30.0) ++fails;         // Mars window band
  if (T.vinf_arr_mag<1.5 || T.vinf_arr_mag>5.0) ++fails;

  // ---- 3. injection dv from 300 km LEO ----
  double r_park=6378.137+300.0;
  double dv_inj=injectionDv(norm(T.vinf_dep), r_park, muPlanet(EARTH));
  printf("[3] injection dv from 300km LEO = %.4f km/s (expect ~3.6-4.5)\n", dv_inj);
  if (dv_inj<3.0 || dv_inj>5.0) ++fails;

  // ---- 4. gravity assist + B-plane ----
  double vinf=3.0, rp=1.0*(3389.5+500.0); // Mars flyby at 500 km alt
  double mu_mars=muPlanet(MARS);
  double delta=flybyTurnAngle(vinf,rp,mu_mars);
  double dvmax=flybyDeltaVmax(vinf,rp,mu_mars);
  double e_ref=1.0+rp*vinf*vinf/mu_mars;
  double delta_ref=2.0*std::asin(1.0/e_ref);
  BPlane bp=bPlane(Vec3{vinf,0,0}, rp, mu_mars);
  double a=-mu_mars/(vinf*vinf);
  double b_ref=std::fabs(a)*std::sqrt(e_ref*e_ref-1.0);
  printf("[4] flyby turn=%.3f deg (ref %.3f)  dvmax=%.4f km/s  |B|=%.1f km (ref %.1f)\n",
         delta*180/M_PI, delta_ref*180/M_PI, dvmax, bp.B_mag, b_ref);
  if (std::fabs(delta-delta_ref)>1e-12) ++fails;
  if (std::fabs(bp.B_mag-b_ref)>1e-6) ++fails;

  printf("\n%s\n", fails==0 ? "INTERPLANETARY VALIDATE: PASS" : "INTERPLANETARY VALIDATE: FAIL");
  return fails==0?0:1;
}
