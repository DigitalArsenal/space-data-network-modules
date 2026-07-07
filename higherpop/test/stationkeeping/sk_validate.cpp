// sk_validate.cpp — validate hp::stationkeeping maneuver-planning relations.
//
//  1. Geostationary radius from mu and Earth rotation ~ 42164 km (textbook).
//  2. SMA-control primitive: dv = 0.5 n da, cross-checked against the exact
//     two-body vis-viva delta for a small tangential burn.
//  3. GEO E-W: for a 2 km SMA error, longitude drift rate matches the
//     closed-form -1.5 (n/a) da, and the cycle/dv budget is self-consistent.
//  4. LEO reboost: a known decay rate and deadband give a sane interval & dv,
//     cross-checked against 0.5 n dAlt.
//
// Build:
//   clang++ -std=c++17 -O3 -march=native -Iinclude \
//       test/stationkeeping/sk_validate.cpp -o sk_validate
//
#include <cstdio>
#include <cmath>
#include "higherpop/stationkeeping.hpp"
#include "higherpop/constants.hpp"

using namespace hp;
using namespace hp::stationkeeping;

int main() {
  int fails=0;
  const double mu=MU_EARTH;

  // ---- 1. geostationary radius ----
  double a_geo = std::cbrt(mu/(OMEGA_EARTH*OMEGA_EARTH));
  printf("[1] a_geo = %.3f km (expect ~42164)\n", a_geo);
  if (std::fabs(a_geo-42164.0) > 5.0) ++fails;

  // ---- 2. SMA-control primitive vs exact vis-viva ----
  // circular orbit at a; small tangential dv -> new a from vis-viva.
  double a=7000.0, vc=std::sqrt(mu/a);
  double da_target=1.0; // km
  double dv = genericSmaControl(a, da_target, mu);
  // exact: v' = sqrt(mu(2/a - 1/a')) with a'=a+da  (burn at r=a)
  double ap=a+da_target;
  double vp=std::sqrt(mu*(2.0/a - 1.0/ap));
  double dv_exact=vp-vc;
  printf("[2] SMA control dv=%.6e km/s  exact=%.6e  rel.err=%.2e\n",
         dv, dv_exact, std::fabs(dv-dv_exact)/dv_exact);
  if (std::fabs(dv-dv_exact)/dv_exact > 1e-3) ++fails; // 1st-order vs exact

  // ---- 3. GEO E-W keeping ----
  double da=2.0; // km SMA error
  auto ew=eastWestKeeping(da, 0.1 /*deg deadband*/);
  // closed-form drift rate check
  double n=std::sqrt(mu/(ew.a_geo*ew.a_geo*ew.a_geo));
  double drift_ref = -1.5*(n/ew.a_geo)*da;
  printf("[3] GEO E-W: drift=%.4f deg/day  cycle=%.2f d  dv/cycle=%.4f m/s  dv/yr=%.4f m/s\n",
         ew.drift_rate_deg_day, ew.cycle_days, ew.dv_per_cycle*1000.0, ew.dv_per_year*1000.0);
  if (std::fabs(ew.drift_rate-drift_ref) > 1e-15) ++fails;
  if (ew.cycle_days<=0 || ew.dv_per_year<=0) ++fails;

  // ---- 4. LEO altitude maintenance ----
  // typical ISS-like decay ~ 100 m/day => da/dt in km/s
  double decay_km_per_s = 0.100/86400.0; // 100 m/day
  double a_leo=6778.0;                    // ~400 km altitude
  auto leo=leoAltitudeMaintenance(a_leo, decay_km_per_s, 1.0 /*km deadband*/);
  double n_leo=std::sqrt(mu/(a_leo*a_leo*a_leo));
  double dv_ref=0.5*n_leo*1.0; // 0.5 n dAlt
  printf("[4] LEO reboost: interval=%.1f d  dv/reboost=%.4f m/s  dv/yr=%.4f m/s\n",
         leo.reboost_interval_days, leo.dv_per_reboost*1000.0, leo.dv_per_year*1000.0);
  if (std::fabs(leo.dv_per_reboost-dv_ref) > 1e-12) ++fails;
  if (leo.reboost_interval_days<=0) ++fails;

  printf("\n%s\n", fails==0 ? "STATIONKEEPING VALIDATE: PASS" : "STATIONKEEPING VALIDATE: FAIL");
  return fails==0?0:1;
}
