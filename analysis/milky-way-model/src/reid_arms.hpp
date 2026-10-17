#pragma once

#include "galactic_constants.hpp"
#include "model_types.hpp"
#include <array>
#include <limits>

namespace milky_way {

inline constexpr unsigned arm_count = 6;

struct ArmSegment {
  const char* name;
  unsigned family;
  double beta_min_deg, beta_max_deg, beta_kink_deg, radius_kpc;
  double pitch_before_deg, pitch_after_deg, width_kpc;
  double beta_kink, tan_before, tan_after, cos_before, cos_after;
  ArmSegment(const char* n,unsigned f,double lo,double hi,double kink,double r,
             double before,double after,double width)
      : name(n),family(f),beta_min_deg(lo),beta_max_deg(hi),beta_kink_deg(kink),
        radius_kpc(r),pitch_before_deg(before),pitch_after_deg(after),width_kpc(width),
        beta_kink(kink*galactic_constants::radians_per_degree),
        tan_before(std::tan(before*galactic_constants::radians_per_degree)),
        tan_after(std::tan(after*galactic_constants::radians_per_degree)),
        cos_before(std::cos(before*galactic_constants::radians_per_degree)),
        cos_after(std::cos(after*galactic_constants::radians_per_degree)) {}
};

// Reid et al. (2019), ApJ 885, 131, doi:10.3847/1538-4357/ab4a11,
// Table 2 central values, transcribed from the locally saved author TeX.
// The table has SEVEN fitted segments for SIX physical arm families: Norma and
// Outer share a family. beta is measured toward Galactic rotation from the Sun
// ray; degrees, kpc, Gaussian one-sigma width. beta_min/max delimit the measured
// parallax coverage, NOT measured boundaries of the arms. Reid used R0=8.15 kpc;
// we keep its fitted radii unchanged while adopting the task's R0=8.178 kpc.
inline const std::array<ArmSegment,7> reid_segments = {{
  {"3-kpc(N)",0, 15,18,15,3.52,-4.2,-4.2,0.18},
  {"Norma",1, 5,54,18,4.46,-1.0,19.5,0.14},
  {"Scutum-Centaurus",2, 0,104,23,4.91,14.1,12.1,0.23},
  {"Sagittarius-Carina",3, 2,97,24,6.04,17.1,1.0,0.27},
  {"Local",4, -8,34,9,8.26,11.4,11.4,0.31},
  {"Perseus",5, -23,115,40,8.87,10.3,8.7,0.35},
  {"Outer",1, -16,71,18,12.24,3.0,9.4,0.65}
}};

inline double arm_radius_kpc(const ArmSegment& a,double beta) {
  const double pitch=beta<=a.beta_kink?a.tan_before:a.tan_after;
  return a.radius_kpc*std::exp(-(beta-a.beta_kink)*pitch);
}

// Shared physical domain for baking and both independent ridge estimators.
// Reid 2019 section 3.2.2 extends Scutum counterclockwise past the far side
// into OSC (G007.47+00.05). A principal-angle wrap at kink +/- pi cuts that
// continuation off. Its outward endpoint is the model's 16-kpc radial edge;
// its inner endpoint is the tabulated 104-degree coverage. Other major arms
// retain explicitly illustrative one-revolution extensions; Local/3-kpc stay
// within their measured coverage. No maser is used to tune a curve here.
inline std::array<double,2> arm_beta_domain(const ArmSegment& a) {
  if(a.family==0||a.family==4)
    return {a.beta_min_deg*galactic_constants::radians_per_degree,
            a.beta_max_deg*galactic_constants::radians_per_degree};
  if(a.family==2)
    return {a.beta_kink-std::log(16.0/a.radius_kpc)/a.tan_before,
            a.beta_max_deg*galactic_constants::radians_per_degree};
  return {a.beta_kink-galactic_constants::pi,a.beta_kink+galactic_constants::pi};
}

inline double model_beta(const ArmSegment& a,double beta) {
  const auto domain=arm_beta_domain(a);
  constexpr double turn=2*galactic_constants::pi;
  // Unwrap around this segment's domain, not around its kink: the observed
  // far-side OSC continuation is at negative unwrapped Galactic azimuth.
  const double middle=(domain[0]+domain[1])/2;
  beta+=turn*std::round((middle-beta)/turn);
  return std::clamp(beta,domain[0],domain[1]);
}

// Euclidean closest-point distance to a kinked logarithmic curve. The two
// smooth sides are minimized separately so Newton iteration never crosses a
// discontinuity in pitch. Used for validation, not the volume's hot loop.
inline double arm_segment_distance_kpc(const ArmSegment& a,Vec3 p) {
  const double beta0=std::atan2(p.y,-p.x);
  double best=std::numeric_limits<double>::infinity();
  const auto domain=arm_beta_domain(a);
  const double domain_lo=domain[0],domain_hi=domain[1];
  for(int side=0;side<2;++side) {
    const double lo=side?std::max(domain_lo,a.beta_kink):domain_lo;
    const double hi=side?domain_hi:std::min(domain_hi,a.beta_kink);
    if(hi<lo) continue;
    const double tangent=side?a.tan_after:a.tan_before;
    for(int wrap=-1;wrap<=1;++wrap) {
      double beta=std::clamp(beta0+wrap*2*galactic_constants::pi,lo,hi);
      for(int iteration=0;iteration<8;++iteration) {
        const double r=arm_radius_kpc(a,beta),c=std::cos(beta),s=std::sin(beta);
        const double x=-r*c,y=r*s,dx=r*(tangent*c+s),dy=r*(-tangent*s+c);
        const double ddx=r*((1-tangent*tangent)*c-2*tangent*s);
        const double ddy=r*((tangent*tangent-1)*s-2*tangent*c);
        const double gradient=(x-p.x)*dx+(y-p.y)*dy;
        const double curvature=dx*dx+dy*dy+(x-p.x)*ddx+(y-p.y)*ddy;
        if(curvature<=0) break;
        beta=std::clamp(beta-std::clamp(gradient/curvature,-0.25,0.25),lo,hi);
      }
      for(double candidate:{lo,beta,hi}) {
        const double r=arm_radius_kpc(a,candidate);
        best=std::min(best,std::hypot(p.x+r*std::cos(candidate),p.y-r*std::sin(candidate)));
      }
    }
  }
  return best;
}

inline double arm_distance_kpc(unsigned family,Vec3 p) {
  double best=std::numeric_limits<double>::infinity();
  for(const auto& a:reid_segments) if(a.family==family)
    best=std::min(best,arm_segment_distance_kpc(a,p));
  return best;
}

} // namespace milky_way
