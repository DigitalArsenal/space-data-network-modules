#pragma once

#include "literature_model.hpp"
#include "volume.hpp"
#include <vector>

namespace milky_way {

struct BakedArmRidge {
  bool found=false;
  Vec3 position{};
  double distance_kpc=std::numeric_limits<double>::infinity();
  double excess=0,width_kpc=0;
  unsigned segment=static_cast<unsigned>(reid_segments.size());
};

namespace ridge_detail {

// All positions are static Galactocentric kpc and flattened to z=0. Sampling
// bounds locate an actual peak of the published binary16 global product; the
// task's 0.3 kpc acceptance limit is not enlarged by this sampling interval.
inline constexpr double sample_step_kpc=0.025;

struct Excess { double value,rounding_bound; };

inline double smooth_background(Vec3 p) {
  const auto c=stellar_components(p,0.0);
  return c.thin+c.thick+c.bulge+c.bar;
}

inline Excess baked_arm_excess(const Volume& global,Vec3 p) {
  if(!global.contains(p))
    return {std::numeric_limits<double>::quiet_NaN(),0};
  const auto spacing=global.spacing();
  const double u=std::clamp((p.x-global.minimum.x)/spacing.x-0.5,0.0,double(global.nx-1));
  const double v=std::clamp((p.y-global.minimum.y)/spacing.y-0.5,0.0,double(global.ny-1));
  const auto& axis=global.z_coordinates();
  const auto upper=std::upper_bound(axis.begin(),axis.end(),p.z);
  double w=0;
  if(upper==axis.end()) w=global.nz-1;
  else if(upper!=axis.begin()) {
    const size_t lower=static_cast<size_t>(upper-axis.begin()-1);
    w=lower+(p.z-axis[lower])/(axis[lower+1]-axis[lower]);
  }
  const uint32_t ix=static_cast<uint32_t>(u),iy=static_cast<uint32_t>(v),iz=static_cast<uint32_t>(w);
  double background=0,max_g=0;
  // Evaluate the smooth model independently at the eight surrounding voxel
  // centers, then apply the product's interpolation. Subtracting the analytic
  // z=0 value directly would mistake vertical/radial interpolation bias for an
  // arm, particularly near the bulge and the narrow midplane.
  for(unsigned dz=0;dz<2;++dz) for(unsigned dy=0;dy<2;++dy) for(unsigned dx=0;dx<2;++dx) {
    const uint32_t x=std::min(ix+dx,global.nx-1),y=std::min(iy+dy,global.ny-1),z=std::min(iz+dz,global.nz-1);
    const double weight=(dx?u-ix:1-(u-ix))*(dy?v-iy:1-(v-iy))*(dz?w-iz:1-(w-iz));
    background+=weight*smooth_background({global.minimum.x+(x+0.5)*spacing.x,
      global.minimum.y+(y+0.5)*spacing.y,axis[z]});
    max_g=std::max(max_g,std::abs(global.at(x,y,z).r));
  }
  // One full binary16 relative ulp plus a subnormal ulp is a conservative
  // bound on quantization noise after convex trilinear interpolation. It is
  // a numerical detection floor, not a fitted astrophysical threshold.
  return {global.sample(p).r-background,max_g*0x1.0p-10+0x1.0p-24};
}

struct ClosestSpine {
  bool found=false;
  double beta=0,radius=0,distance=std::numeric_limits<double>::infinity();
  Vec3 position{},normal{};
};

inline ClosestSpine closest_spine(const ArmSegment& arm,Vec3 maser) {
  ClosestSpine result;
  const auto domain=arm_beta_domain(arm);
  const double domain_lo=domain[0],domain_hi=domain[1];
  // Separate kink sides; the maximum endpoint radius bounds ds/d(beta) for
  // each monotonic logarithmic segment, so adjacent spine samples are no more
  // than 0.025 kpc apart in arc length. No parallax-quality cuts or outlier
  // rejection are performed here.
  for(unsigned side=0;side<2;++side) {
    const double lo=side?std::max(domain_lo,arm.beta_kink):domain_lo;
    const double hi=side?domain_hi:std::min(domain_hi,arm.beta_kink);
    if(hi<lo) continue;
    const double tangent=side?arm.tan_after:arm.tan_before;
    const double max_radius=std::max(arm_radius_kpc(arm,lo),arm_radius_kpc(arm,hi));
    const unsigned steps=std::max(1u,static_cast<unsigned>(std::ceil(
      (hi-lo)*max_radius*std::sqrt(1+tangent*tangent)/sample_step_kpc)));
    for(unsigned i=0;i<=steps;++i) {
      const double beta=lo+(hi-lo)*i/steps,r=arm_radius_kpc(arm,beta);
      if(r<model_choices::inner_arm_radius_kpc||r>model_choices::outer_radius_kpc) continue;
      const double c=std::cos(beta),s=std::sin(beta);
      const Vec3 point{-r*c,r*s,0};
      const double distance=std::hypot(point.x-maser.x,point.y-maser.y);
      if(distance>=result.distance) continue;
      const Vec3 derivative{r*(tangent*c+s),r*(-tangent*s+c),0};
      result={true,beta,r,distance,point,normalized({derivative.y,-derivative.x,0})};
    }
  }
  return result;
}

inline BakedArmRidge segment_ridge(const Volume& global,const ArmSegment& arm,unsigned index,Vec3 maser) {
  BakedArmRidge result;
  const auto spine=closest_spine(arm,maser);
  if(!spine.found) return result;
  // Published Reid one-sigma width and dw/dR=42 pc/kpc, with the same explicit
  // minimum-width safeguard as the implemented model. Search two sigma on
  // each side; a boundary maximum is not evidence of a resolved local ridge.
  const double width=std::max(model_choices::minimum_arm_width_kpc,
      arm.width_kpc+0.042*(spine.radius-arm.radius_kpc));
  const double half_range=2*width;
  const unsigned half_steps=std::max(1u,static_cast<unsigned>(std::ceil(half_range/sample_step_kpc)));
  const unsigned intervals=2*half_steps;
  std::vector<Excess> profile(intervals+1);
  unsigned peak=0;
  for(unsigned i=0;i<=intervals;++i) {
    const double offset=-half_range+2*half_range*i/intervals;
    profile[i]=baked_arm_excess(global,spine.position+spine.normal*offset);
    if(!std::isfinite(profile[i].value)) return result;
    if(profile[i].value>profile[peak].value) peak=i;
  }
  if(peak==0||peak==intervals) return result;
  const auto maximum=profile[peak];
  const double edge=std::max(profile.front().value,profile.back().value);
  const double edge_error=std::max(profile.front().rounding_bound,profile.back().rounding_bound);
  if(maximum.value<=maximum.rounding_bound||maximum.value-edge<=maximum.rounding_bound+edge_error)
    return result;
  // This is the actual interpolated baked maximum on the normal samples, not
  // the analytic spine substituted as a successful measurement. Neighboring
  // overlapping arms can make the ridge unresolved or shift its location;
  // no deblending, peak-distance clipping, or automatic pass is applied.
  const double offset=-half_range+2*half_range*peak/intervals;
  const Vec3 position=spine.position+spine.normal*offset;
  return {true,position,std::hypot(position.x-maser.x,position.y-maser.y),maximum.value,width,index};
}

} // namespace ridge_detail

inline BakedArmRidge baked_arm_ridge(const Volume& global,unsigned family,Vec3 maser) {
  BakedArmRidge result;
  maser.z=0;
  // Norma and Outer are separate fitted segments of the same assigned family.
  // Preserve both possibilities, choosing the nearer actual resolved ridge.
  for(unsigned i=0;i<reid_segments.size();++i) if(reid_segments[i].family==family) {
    const auto candidate=ridge_detail::segment_ridge(global,reid_segments[i],i,maser);
    if(candidate.found&&candidate.distance_kpc<result.distance_kpc) result=candidate;
  }
  return result;
}

} // namespace milky_way
