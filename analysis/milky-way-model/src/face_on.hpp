#pragma once
#include "literature_model.hpp"
#include "volume.hpp"
#include <complex>
#include <thread>
#include <vector>

// The Galaxy seen face-on from 48 kpc above its center: G, BP and RP radiance
// of every pixel of the plane through the baked volumes, emission and
// absorption as the renderer integrates them, with BP and RP taking the
// extinction ratios. Three measurements of that image:
//  - the arm/interarm contrast along the Sun's arc, as Elmegreen et al. (2011,
//    ApJ 737, 32, section 4.2) measure it on azimuthal scans:
//    2 I_arm / (I_interarm1 + I_interarm2) at each arm crossing;
//  - the bar: the m=2 Fourier amplitude A2 = |sum I e^(2i phi)| / sum I over
//    the 1.5-4.5 kpc annulus, and its phase against the bar's 27 degrees;
//  - the dust lanes' color: integrated BP-RP of the most opaque tenth of the
//    3-12 kpc disc against the integrated BP-RP of that whole disc.
namespace milky_way {

struct FaceOnReport {
  bool valid=false;
  static constexpr uint32_t size=256;
  static constexpr double half_extent_kpc=16,camera_kpc=48;
  std::vector<float> rgb;              // size^2 x (G, BP, RP), row-major, +y rows up
  std::vector<double> crossings_deg,crossing_contrasts,arc_profile;
  double arm_contrast=0,arc_max_over_min=0;
  double bar_a2=0,bar_phase_deg=0,bar_expected_deg=0;
  double lane_color=0,disc_color=0,lane_tau_threshold=0;
  uint64_t lane_pixels=0,disc_pixels=0;
};

namespace face_on_detail {

inline void integrate(const NestedVolumes& volumes,Vec3 target,float* rgb,float* tau_out) {
  const Vec3 camera{0,0,FaceOnReport::camera_kpc};
  const Vec3 d=normalized(target-camera);
  const double top=volumes.global.maximum.z,bottom=volumes.global.minimum.z;
  double z=top;
  double light[3]={0,0,0},transmit[3]={1,1,1},tau_total=0;
  const double ratios[3]={1,model_choices::bp_to_g_extinction,model_choices::rp_to_g_extinction};
  while(z>bottom) {
    // Steps in z: 5 pc through the dust and young layers, 50 pc beyond.
    const double dz=std::min(z-bottom,std::abs(z)<0.6?0.005:0.05);
    const double zm=z-dz/2;
    const Vec3 p=camera+d*((zm-camera.z)/d.z);
    const double ds=dz/std::abs(d.z);
    const Field f=volumes.sample(p);
    const double emission[3]={std::max(0.0,f.r),std::max(0.0,f.g),std::max(0.0,f.b)};
    const double kappa=std::max(0.0,f.kappa);
    tau_total+=kappa*ds;
    for(int band=0;band<3;++band) {
      const double k=kappa*ratios[band],tau=k*ds;
      const double integral=tau>1e-10?-std::expm1(-tau)/k:ds;
      light[band]+=transmit[band]*emission[band]*integral;
      transmit[band]*=std::exp(-tau);
    }
    z-=dz;
  }
  for(int band=0;band<3;++band) rgb[band]=static_cast<float>(light[band]);
  *tau_out=static_cast<float>(tau_total);
}

inline double bilinear(const std::vector<float>& rgb,unsigned band,double x,double y) {
  constexpr uint32_t n=FaceOnReport::size;
  const double scale=n/(2*FaceOnReport::half_extent_kpc);
  const double u=std::clamp((x+FaceOnReport::half_extent_kpc)*scale-0.5,0.0,double(n-1));
  const double v=std::clamp((y+FaceOnReport::half_extent_kpc)*scale-0.5,0.0,double(n-1));
  const uint32_t i=std::min(uint32_t(u),n-2),j=std::min(uint32_t(v),n-2);
  const double fx=u-i,fy=v-j;
  auto at=[&](uint32_t a,uint32_t b){return double(rgb[(size_t(b)*n+a)*3+band]);};
  return (at(i,j)*(1-fx)+at(i+1,j)*fx)*(1-fy)+(at(i,j+1)*(1-fx)+at(i+1,j+1)*fx)*fy;
}

// Azimuths (Reid beta, degrees in [0,360)) where a drifted major-arm ridge
// crosses the circle r: the same four families and drift as major_arm_wave.
inline std::vector<double> wave_crossings(double r) {
  std::vector<double> result;
  const double drift=populations::circular_speed_km_s*populations::drift_age_k_myr
    *populations::km_s_myr_to_kpc*galactic_constants::solar_radius_kpc/8*(1/r-1/populations::corotation_kpc);
  for(const auto& a:reid_segments) {
    if(a.family==0||a.family==4) continue;
    const auto domain=arm_beta_domain(a);
    const double step=0.05*galactic_constants::radians_per_degree;
    double previous=arm_radius_kpc(a,domain[0])-r;
    for(double beta=domain[0]+step;beta<=domain[1];beta+=step) {
      const double now=arm_radius_kpc(a,beta)-r;
      if((previous<0)!=(now<0)) {
        const double crossing=beta-step*now/(now-previous)+drift;
        double degrees=std::fmod(crossing/galactic_constants::radians_per_degree,360.0);
        if(degrees<0) degrees+=360;
        result.push_back(degrees);
      }
      previous=now;
    }
  }
  std::sort(result.begin(),result.end());
  return result;
}

} // namespace face_on_detail

inline FaceOnReport face_on(const NestedVolumes& volumes) {
  using namespace face_on_detail;
  FaceOnReport report;
  constexpr uint32_t n=FaceOnReport::size;
  constexpr double pixel=2*FaceOnReport::half_extent_kpc/n;
  report.rgb.assign(size_t(n)*n*3,0);
  std::vector<float> tau(size_t(n)*n,0);
  auto rows=[&](uint32_t begin,uint32_t end) {
    for(uint32_t j=begin;j<end;++j) for(uint32_t i=0;i<n;++i) {
      const size_t index=size_t(j)*n+i;
      const Vec3 target{-FaceOnReport::half_extent_kpc+(i+0.5)*pixel,-FaceOnReport::half_extent_kpc+(j+0.5)*pixel,0};
      integrate(volumes,target,&report.rgb[index*3],&tau[index]);
    }
  };
  std::thread a(rows,0,n/4),b(rows,n/4,n/2),c(rows,n/2,3*n/4);
  rows(3*n/4,n);a.join();b.join();c.join();

  // The Sun's arc: 0.25-degree azimuthal scan of G at r = R0.
  const double r0=galactic_constants::solar_radius_kpc;
  constexpr uint32_t samples=1440;
  report.arc_profile.resize(samples);
  for(uint32_t k=0;k<samples;++k) {
    const double beta=k*0.25*galactic_constants::radians_per_degree;
    report.arc_profile[k]=bilinear(report.rgb,0,-r0*std::cos(beta),r0*std::sin(beta));
  }
  const auto [lowest,highest]=std::minmax_element(report.arc_profile.begin(),report.arc_profile.end());
  report.arc_max_over_min=*lowest>0?*highest / *lowest:0;
  report.crossings_deg=wave_crossings(r0);
  const size_t m=report.crossings_deg.size();
  auto index_of=[&](double degrees){return uint32_t(std::lround(degrees/0.25))%samples;};
  double sum=0;
  for(size_t i=0;i<m&&m>=2;++i) {
    const double here=report.crossings_deg[i];
    const double before=report.crossings_deg[(i+m-1)%m],after=report.crossings_deg[(i+1)%m];
    // Arm: the scan maximum within 3 degrees (0.43 kpc) of the crossing.
    // Interarm: the scan minimum between this crossing and each neighbour.
    double arm=0;
    for(int d=-12;d<=12;++d) arm=std::max(arm,report.arc_profile[(index_of(here)+samples+d)%samples]);
    auto minimum_between=[&](double from,double to) {
      double span=std::fmod(to-from+360.0,360.0);
      if(span==0) span=360;
      double low=std::numeric_limits<double>::infinity();
      for(double t=0.25;t<span;t+=0.25) low=std::min(low,report.arc_profile[index_of(std::fmod(from+t,360.0))]);
      return low;
    };
    const double left=minimum_between(before,here),right=minimum_between(here,after);
    const double contrast=left+right>0?2*arm/(left+right):0;
    report.crossing_contrasts.push_back(contrast);sum+=contrast;
  }
  report.arm_contrast=m?sum/m:0;

  // The bar: m=2 over the 1.5-4.5 kpc annulus of the G image.
  std::complex<double> moment{0,0};double total=0;
  for(double r=1.5;r<=4.5;r+=0.025) for(int k=0;k<720;++k) {
    const double phi=k*0.5*galactic_constants::radians_per_degree;
    const double value=bilinear(report.rgb,0,r*std::cos(phi),r*std::sin(phi))*r;
    moment+=value*std::polar(1.0,2*phi);total+=value;
  }
  report.bar_a2=total>0?std::abs(moment)/total:0;
  double phase=std::arg(moment)/2/galactic_constants::radians_per_degree;
  if(phase<0) phase+=180;
  report.bar_phase_deg=phase;
  // Bar major axis u = (-cos 27, sin 27) in (x, y): 153 degrees, mod 180.
  report.bar_expected_deg=180-model_choices::bar_angle_rad/galactic_constants::radians_per_degree;

  // Dust lanes: the most opaque tenth of the 3-12 kpc disc.
  std::vector<float> disc_tau;
  for(uint32_t j=0;j<n;++j) for(uint32_t i=0;i<n;++i) {
    const double x=-FaceOnReport::half_extent_kpc+(i+0.5)*pixel,y=-FaceOnReport::half_extent_kpc+(j+0.5)*pixel;
    const double r=std::hypot(x,y);
    if(r>=3&&r<=12) disc_tau.push_back(tau[size_t(j)*n+i]);
  }
  if(disc_tau.size()<100) return report;
  std::vector<float> sorted=disc_tau;
  std::nth_element(sorted.begin(),sorted.begin()+sorted.size()*9/10,sorted.end());
  report.lane_tau_threshold=sorted[sorted.size()*9/10];
  double lane_bp=0,lane_rp=0,disc_bp=0,disc_rp=0;
  for(uint32_t j=0;j<n;++j) for(uint32_t i=0;i<n;++i) {
    const double x=-FaceOnReport::half_extent_kpc+(i+0.5)*pixel,y=-FaceOnReport::half_extent_kpc+(j+0.5)*pixel;
    const double r=std::hypot(x,y);
    if(r<3||r>12) continue;
    const size_t index=size_t(j)*n+i;
    const double bp=report.rgb[index*3+1],rp=report.rgb[index*3+2];
    disc_bp+=bp;disc_rp+=rp;++report.disc_pixels;
    if(tau[index]>=report.lane_tau_threshold) {lane_bp+=bp;lane_rp+=rp;++report.lane_pixels;}
  }
  if(!(lane_bp>0&&lane_rp>0&&disc_bp>0&&disc_rp>0)) return report;
  report.lane_color=-2.5*std::log10(lane_bp/lane_rp);
  report.disc_color=-2.5*std::log10(disc_bp/disc_rp);
  report.valid=m>=2&&std::isfinite(report.arm_contrast)&&total>0;
  return report;
}

} // namespace milky_way
