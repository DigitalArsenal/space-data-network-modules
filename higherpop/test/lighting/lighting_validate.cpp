// lighting_validate.cpp — validate hp::lighting eclipse/ephemeris geometry.
//
//  1. Sun & Moon geocentric position vs ERFA reference (pyerfa).
//  2. Shadow model on constructed geometry:
//       - satellite on the sunward side of Earth  -> full sun (f=1)
//       - satellite directly anti-sunward, |r|<..  -> umbra   (f=0)
//       - satellite just at the umbra edge         -> penumbra (0<f<1)
//  3. A full LEO orbit: eclipse fraction of the period is physically sane
//     (a non-sun-synchronous LEO spends ~30-40% of its period in shadow).
//
// Build:
//   clang++ -std=c++17 -O2 -Iinclude -Ithird_party/erfa \
//       test/lighting/lighting_validate.cpp third_party/erfa/*.o -o lighting_validate
//
#include <cstdio>
#include <cmath>
#include "higherpop/lighting.hpp"
#include "higherpop/kepler.hpp"
#include "higherpop/constants.hpp"

using namespace hp;
using namespace hp::lighting;

double ref_sun[3]={143329872.133428,39703247.288677,17213014.900597};
double ref_moon[3]={-322415.190502,-162969.304952,-62504.673901};

int main() {
  int fails=0;
  frames::UTCDate d{2004,4,6,7,51,28.386009};

  // ---- 1. ephemeris vs ERFA ----
  Vec3 sun=sunGcrf(d), moon=moonGcrf(d);
  double dsun = norm(sun - Vec3{ref_sun[0],ref_sun[1],ref_sun[2]});
  double dmoon= norm(moon- Vec3{ref_moon[0],ref_moon[1],ref_moon[2]});
  printf("[1] Sun  |dpos|=%.3e km  (|r|=%.1f km, %.4f AU)\n", dsun, norm(sun), norm(sun)/AU_KM);
  printf("    Moon |dpos|=%.3e km  (|r|=%.1f km)\n", dmoon, norm(moon));
  if (dsun>1e-3 || dmoon>1e-3) ++fails;

  // ---- 2. shadow model on constructed geometry ----
  Vec3 sunhat = unit(sun);
  double Rleo = 7000.0;
  Vec3 r_sunward =  sunhat*Rleo;         // between Earth and Sun -> full sun
  Vec3 r_antisun = sunhat*(-Rleo);       // directly behind Earth -> umbra
  double f_sun  = sunFraction(r_sunward, d);
  double f_umbra= sunFraction(r_antisun, d);
  printf("[2] sunward f=%.4f (expect 1)   anti-sun f=%.4f (expect 0)\n", f_sun, f_umbra);
  if (f_sun < 0.999 || f_umbra > 1e-6) ++fails;

  // find the penumbra edge by sweeping the transverse offset behind Earth
  // (a point anti-sunward but offset sideways passes through penumbra).
  Vec3 side = unit(cross(sunhat, Vec3{0,0,1}));
  int penumbra_hits=0; double f_partial=-1;
  for (double off=6000; off<=9000; off+=25.0) {
    Vec3 rp = sunhat*(-Rleo) + side*off;
    double f=sunFraction(rp,d);
    if (f>1e-6 && f<0.999){ ++penumbra_hits; if(f_partial<0) f_partial=f; }
  }
  printf("    penumbra samples found=%d (first partial f=%.4f)\n", penumbra_hits, f_partial);
  if (penumbra_hits==0) ++fails;

  // ---- 3. full LEO orbit eclipse fraction ----
  // a=7000, i=51.6 deg, circular. Sample one period, count shadow time.
  double a=7000.0, mu=MU_EARTH, vc=std::sqrt(mu/a);
  double inc=51.6*M_PI/180.0;
  Vec3 r0{a,0,0}, v0{0, vc*std::cos(inc), vc*std::sin(inc)};
  double P=2*M_PI*std::sqrt(a*a*a/mu);
  int N=720, shadow=0; double beta0=0;
  for (int k=0;k<N;++k){
    double t=P*k/N;
    auto rv=keplerUniversal(r0,v0,t,mu);
    double f=sunFraction(rv.first,d);
    if (f<0.5) ++shadow;
    if (k==0) beta0=betaAngle(rv.first,rv.second,d)*180.0/M_PI;
  }
  double frac=100.0*shadow/N;
  printf("[3] LEO a=7000 i=51.6: eclipse = %.1f%% of period (beta=%.1f deg)\n", frac, beta0);
  // physically 25-45% for a low-beta LEO; flag only if clearly wrong
  if (frac<10.0 || frac>50.0) ++fails;

  printf("\n%s\n", fails==0 ? "LIGHTING VALIDATE: PASS" : "LIGHTING VALIDATE: FAIL");
  return fails==0?0:1;
}
