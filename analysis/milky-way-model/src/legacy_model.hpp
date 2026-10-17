#pragma once

#include "model_types.hpp"
#include "volume.hpp"
#include "galactic_constants.hpp"

namespace milky_way {

// Refactor baseline: literal equations from OrbPro
// packages/engine/Source/Shaders/GalaxyFS.glsl, read 2026-10-16.
// Source SHA-256: 5b6c5af3bb7eea2797f2d75a7d47215414d7120c92d15591557bab6a1438bb96
// Keep this baseline separate from the subsequent literature-model behavior.
// The original shader cites Bland-Hawthorn & Gerhard (2016), Vallee (2017),
// Churchwell et al. (2009), and Drimmel & Spergel (2001); its arbitrary RGB
// amplitudes, units, and tone curve are preserved, not recalibrated here.
inline Field legacy(Vec3 p) {
  constexpr double radius=15.0, tan_pitch=0.21255656, bar_angle=0.4712389;
  const double r=std::max(std::hypot(p.x,p.y),0.05), az=std::abs(p.z);
  const double winding=std::atan2(p.y,p.x)-std::log(r/8.0)/tan_pitch;
  double major=0.5+0.5*std::cos(2*winding);
  double minor=0.5+0.5*std::cos(2*winding+3.14159265);
  major*=major; minor*=minor;
  const double arm=major*major+0.45*minor*minor;
  const double edge=r<=radius?1.0:0.0;
  const double disc=std::exp(-r/2.6-az/0.3)*edge;
  const double rb=std::sqrt(p.x*p.x+p.y*p.y+p.z*p.z*2.56);
  const double bulge=2.2*std::exp(-rb/0.5);
  const double cb=std::cos(bar_angle),sb=std::sin(bar_angle);
  const double qx=cb*p.x+sb*p.y,qy=-sb*p.x+cb*p.y;
  const double bar=0.9*std::exp(-std::sqrt(qx*qx/6.25+qy*qy/0.64+p.z*p.z/0.09));
  const double dust=std::exp(-r/3.2-az/0.1)*(0.4+1.2*arm)*edge;
  return {
    disc*(0.45*(1-arm)+0.70*1.6*arm)+(bulge+bar),
    disc*(0.88*0.45*(1-arm)+0.80*1.6*arm)+(bulge+bar)*0.82,
    disc*(0.72*0.45*(1-arm)+1.6*arm)+(bulge+bar)*0.55,
    2.2*dust
  };
}

// GLSL hash uses float arithmetic. The analytic and baked lanes share this
// exact jitter so the comparison measures baking, not unrelated noise.
inline double legacy_jitter(double pixel_x,double pixel_y) {
  const float phase=static_cast<float>(pixel_x)*12.9898f+static_cast<float>(pixel_y)*78.233f;
  const float hash=std::sin(phase)*43758.5453f;
  return hash-std::floor(hash);
}

inline bool legacy_interval(Vec3 o,Vec3 d,double& t0,double& t1) {
  t0=0; t1=1.0e9;
  if (std::abs(d.z)>1.0e-6) {
    const double a=(-2.5-o.z)/d.z,b=(2.5-o.z)/d.z;
    t0=std::max(t0,std::min(a,b)); t1=std::min(t1,std::max(a,b));
  } else if (std::abs(o.z)>2.5) return false;
  const double qa=d.x*d.x+d.y*d.y,qb=o.x*d.x+o.y*d.y;
  const double qc=o.x*o.x+o.y*o.y-15.0*15.0;
  if (qa>1.0e-12) {
    const double disc=qb*qb-qa*qc;
    if (disc<=0) return false;
    const double s=std::sqrt(disc);
    t0=std::max(t0,(-qb-s)/qa); t1=std::min(t1,(-qb+s)/qa);
  } else if (qc>0) return false;
  return t1>t0;
}

template<class Sampler>
inline Vec3 legacy_march(Vec3 origin,Vec3 direction,double pixel_x,double pixel_y,Sampler sample) {
  const Vec3 d=normalized(direction);
  double t0,t1;
  if (!legacy_interval(origin,d,t0,t1)) return {};
  constexpr int steps=40;
  const double dt=(t1-t0)/steps;
  double t=t0+dt*legacy_jitter(pixel_x,pixel_y),transmittance=1;
  Vec3 light;
  for (int i=0;i<steps;++i,t+=dt) {
    const Field f=sample(origin+d*t);
    light=light+Vec3{f.r,f.g,f.b}*(transmittance*dt);
    transmittance*=std::exp(-f.kappa*dt);
  }
  return {1-std::exp(-0.9*light.x),1-std::exp(-0.9*light.y),1-std::exp(-0.9*light.z)};
}

struct LegacyParity {
  double max_error=0,rms_error=0;
  uint64_t samples=0;
  uint32_t max_x=0,max_y=0,max_channel=0;
  double max_longitude_deg=0,max_latitude_deg=0;
  Vec3 reference_at_max,baked_at_max;
};

// Independent reference: the analytically evaluated original shader model,
// with the same 40 steps, pixel-center jitter and 1-exp(-.9L) transfer curve.
// All-sky plate carree, pixel centers, 0.5 deg by default; static Galactic
// coordinates (no epoch/time scale), RGB normalized [0,1], alpha=1.
inline LegacyParity verify_legacy(const NestedVolumes& baked,uint32_t width=720,uint32_t height=360) {
  const Vec3 sun{-galactic_constants::solar_radius_kpc,0,galactic_constants::solar_height_kpc};
  LegacyParity result;
  double squared=0;
  for (uint32_t y=0;y<height;++y) for (uint32_t x=0;x<width;++x) {
    const double l=((x+0.5)/width)*2*galactic_constants::pi;
    const double b=((y+0.5)/height-0.5)*galactic_constants::pi;
    const Vec3 direction{std::cos(b)*std::cos(l),std::cos(b)*std::sin(l),std::sin(b)};
    const Vec3 analytic=legacy_march(sun,direction,x+0.5,y+0.5,legacy);
    const Vec3 raster=legacy_march(sun,direction,x+0.5,y+0.5,[&](Vec3 p){return baked.sample(p);});
    const Vec3 difference=analytic-raster;
    uint32_t channel=0;
    for (double error:{difference.x,difference.y,difference.z}) {
      if (std::abs(error)>result.max_error) {
        result.max_error=std::abs(error);result.max_x=x;result.max_y=y;result.max_channel=channel;
        result.max_longitude_deg=l/galactic_constants::radians_per_degree;
        result.max_latitude_deg=b/galactic_constants::radians_per_degree;
        result.reference_at_max=analytic;result.baked_at_max=raster;
      }
      squared+=error*error; ++result.samples;
      ++channel;
    }
  }
  result.rms_error=std::sqrt(squared/result.samples);
  return result;
}

} // namespace milky_way
