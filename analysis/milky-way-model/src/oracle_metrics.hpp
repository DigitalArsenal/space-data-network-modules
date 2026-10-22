#pragma once

#include "galactic_constants.hpp"
#include "volume.hpp"
#include "sky_morphology.hpp"
#include <array>
#include <limits>
#include <thread>
#include <vector>

namespace milky_way {

// Decoded, uncropped ESA full-sky Hammer image. The host only decodes bytes;
// projection, linear-light conversion, radiative transfer and fitting stay here.
struct Image { const uint8_t* rgba=nullptr; uint32_t width=0,height=0; };

struct OracleReport {
  bool valid=false;
  uint64_t samples=0;
  double flux_r=0,density_r=0,rift_ratio=0,flux_rift_ratio=0;
  double fit_scale=0,fit_intercept=0,fit_log_rmse=0;
  std::array<double,4> fwhm_model{},fwhm_flux{},fwhm_relative_errors{};
  // G-channel intensity before fitting, row-major 720 x 360, north at top,
  // longitude 0.25..359.75 deg increasing right. Units are model intensity.
  std::vector<float> model_sky;
  // The oracle flux map resampled onto the same grid (display luminance),
  // for the E2E's side-by-side evidence image; NaN where the Hammer map is empty.
  std::vector<float> flux_sky;
};

struct Calibration {
  bool valid=false,boundary_hit=false;
  double factor=1;
  uint64_t training_samples=0;
  std::vector<double> factors,correlations,residuals,fit_slopes,fit_intercepts;
};

namespace oracle_detail {

inline const std::array<double,256>& srgb_table() {
  static const std::array<double,256> values=[] {
    std::array<double,256> v{};
    for (uint32_t i=0;i<256;++i) {
      const double c=i/255.0;
      v[i]=c<=0.04045?c/12.92:std::pow((c+0.055)/1.055,2.4);
    }
    return v;
  }();
  return values;
}

inline double luminance(Image image,uint32_t x,uint32_t y) {
  const size_t offset=(static_cast<size_t>(y)*image.width+x)*4;
  if (image.rgba[offset+3]<128) return missing;
  const auto& lut=srgb_table();
  // IEC 61966-2-1 sRGB EOTF and Rec.709 linear-light luminance. The ESA
  // published maps have a display stretch: this is not recovered flux.
  return 0.2126*lut[image.rgba[offset]]+0.7152*lut[image.rgba[offset+1]]+0.0722*lut[image.rgba[offset+2]];
}

inline double hammer_sample(Image image,double longitude,double latitude) {
  // Hammer equal-area projection: +/-180 deg at left/right, +90 at top.
  // ESA convention places positive Galactic longitude left of the center.
  if (longitude>galactic_constants::pi) longitude-=2*galactic_constants::pi;
  const double cb=std::cos(latitude);
  const double denominator=std::sqrt(1+cb*std::cos(longitude/2));
  const double u=0.5-cb*std::sin(longitude/2)/(2*denominator);
  const double v=0.5-std::sin(latitude)/(2*denominator);
  const double px=std::clamp(u*image.width-0.5,0.0,double(image.width-1));
  const double py=std::clamp(v*image.height-0.5,0.0,double(image.height-1));
  const uint32_t x=static_cast<uint32_t>(px),y=static_cast<uint32_t>(py);
  const uint32_t xx=std::min(x+1,image.width-1),yy=std::min(y+1,image.height-1);
  const double a=luminance(image,x,y),b=luminance(image,xx,y);
  const double c=luminance(image,x,yy),d=luminance(image,xx,yy);
  const double fx=px-x,fy=py-y;
  return ((1-fx)*a+fx*b)*(1-fy)+((1-fx)*c+fx*d)*fy;
}

inline bool ray_interval(const NestedVolumes& volumes,Vec3 direction,double& begin,double& end) {
  const Vec3 sun{-galactic_constants::solar_radius_kpc,0,galactic_constants::solar_height_kpc};
  const double origins[3]={sun.x,sun.y,sun.z},directions[3]={direction.x,direction.y,direction.z};
  const double lower[3]={volumes.global.minimum.x,volumes.global.minimum.y,volumes.global.minimum.z};
  const double upper[3]={volumes.global.maximum.x,volumes.global.maximum.y,volumes.global.maximum.z};
  begin=0;end=1e9;
  for (int axis=0;axis<3;++axis) {
    if (std::abs(directions[axis])<1e-12) {
      if (origins[axis]<lower[axis]||origins[axis]>upper[axis]) return false;
    } else {
      const double a=(lower[axis]-origins[axis])/directions[axis];
      const double b=(upper[axis]-origins[axis])/directions[axis];
      begin=std::max(begin,std::min(a,b)); end=std::min(end,std::max(a,b));
    }
  }
  return end>begin;
}

inline double integrate(const NestedVolumes& volumes,Vec3 direction) {
  const Vec3 sun{-galactic_constants::solar_radius_kpc,0,galactic_constants::solar_height_kpc};
  double begin,end;
  if (!ray_interval(volumes,direction,begin,end)) return 0;
  double light=0,transmittance=1,t=begin;
  while (t<end&&transmittance>1e-6) {
    // Midpoint quadrature resolves the 0.125 kpc global cells with <=0.05
    // kpc steps, and 0.01953125 kpc local cells with <=0.015 kpc steps.
    const bool local=volumes.local.contains(sun+direction*(t+0.025));
    const double step=std::min(end-t,local?0.015:0.05);
    const Field f=volumes.sample(sun+direction*(t+step/2));
    const double tau=std::max(0.0,f.kappa)*step;
    const double integral=tau>1e-10?-std::expm1(-tau)/std::max(0.0,f.kappa):step;
    light+=transmittance*gaia_g(f)*integral;
    transmittance*=std::exp(-tau); t+=step;
  }
  return light;
}

struct Moments {
  double x=0,y=0,xx=0,yy=0,xy=0;
  uint64_t n=0;
  void add(double a,double b) {x+=a;y+=b;xx+=a*a;yy+=b*b;xy+=a*b;++n;}
  double covariance() const {return n?xy-x*y/n:0;}
  double variance_x() const {return n?xx-x*x/n:0;}
  double variance_y() const {return n?yy-y*y/n:0;}
  double correlation() const {
    const double denominator=std::sqrt(std::max(0.0,variance_x()*variance_y()));
    return denominator>0?std::clamp(covariance()/denominator,-1.0,1.0):0;
  }
};

inline double log_intensity(double value) {return std::log(std::max(1e-12,value));}

struct TransferSegment {double emission,kappa,step;};
struct CalibrationRay {std::vector<TransferSegment> segments;double log_flux=missing;};

inline std::vector<TransferSegment> cache_ray(const NestedVolumes& volumes,Vec3 direction) {
  std::vector<TransferSegment> segments;
  const Vec3 sun{-galactic_constants::solar_radius_kpc,0,galactic_constants::solar_height_kpc};
  double begin,end;
  if (!ray_interval(volumes,direction,begin,end)) return segments;
  segments.reserve(static_cast<size_t>((end-begin)/0.05)+200);
  for (double t=begin;t<end;) {
    const bool local=volumes.local.contains(sun+direction*(t+0.025));
    const double step=std::min(end-t,local?0.015:0.05);
    const Field f=volumes.sample(sun+direction*(t+step/2));
    segments.push_back({gaia_g(f),std::max(0.0,f.kappa),step});
    t+=step;
  }
  return segments;
}

inline double integrate_cached(const std::vector<TransferSegment>& segments,double factor) {
  double light=0,transmittance=1;
  for (const auto& segment:segments) {
    const double kappa=segment.kappa*factor,tau=kappa*segment.step;
    const double integral=tau>1e-10?-std::expm1(-tau)/kappa:segment.step;
    light+=transmittance*segment.emission*integral;
    transmittance*=std::exp(-tau);
    if (transmittance<=1e-6) break;
  }
  return light;
}

} // namespace oracle_detail

// Offline model calibration: one global multiplier on the authored extinction
// coefficient. This changes no disc, arm, bar, or local-dust geometry. The
// objective is positive Pearson r of log intensity (equivalently minimum
// global log-affine residual) against the actual ESA flux-display image.
// Training uses 2 deg centers, l=1..359 and b=+29..-29 deg (5400 rays).
// Final acceptance remains the separately sampled full 0.5 deg map. No
// acceptance threshold, FWHM, or Great Rift statistic enters this fit.
inline Calibration calibrate_dust(const NestedVolumes& volumes,Image flux) {
  using namespace oracle_detail;
  Calibration result;
  if (!flux.rgba||flux.width<720||flux.height<360||flux.width!=2*flux.height) return result;
  constexpr uint32_t columns=180,rows_count=30;
  std::vector<CalibrationRay> rays(columns*rows_count);
  (void)srgb_table();
  auto cache_rows=[&](uint32_t begin,uint32_t end) {
    for (uint32_t y=begin;y<end;++y) for (uint32_t x=0;x<columns;++x) {
      const double l=(2*x+1)*galactic_constants::radians_per_degree;
      const double b=(29.0-2*y)*galactic_constants::radians_per_degree;
      const Vec3 direction{std::cos(b)*std::cos(l),std::cos(b)*std::sin(l),std::sin(b)};
      auto& ray=rays[static_cast<size_t>(y)*columns+x];
      const double flux_value=hammer_sample(flux,l,b);
      if (std::isfinite(flux_value)) {
        ray.log_flux=log_intensity(flux_value);ray.segments=cache_ray(volumes,direction);
      }
    }
  };
  std::thread a(cache_rows,0,rows_count/4),b(cache_rows,rows_count/4,rows_count/2),
    c(cache_rows,rows_count/2,3*rows_count/4);
  cache_rows(3*rows_count/4,rows_count);a.join();b.join();c.join();
  size_t best=0;
  auto evaluate=[&](double factor) {
    Moments moments;
    for (const auto& ray:rays) if (std::isfinite(ray.log_flux))
      moments.add(log_intensity(integrate_cached(ray.segments,factor)),ray.log_flux);
    const double slope=moments.variance_x()>0?moments.covariance()/moments.variance_x():0;
    const double intercept=moments.n?(moments.y-slope*moments.x)/moments.n:0;
    const double residual=moments.n?std::sqrt(std::max(0.0,
      (moments.variance_y()-slope*moments.covariance())/moments.n)):missing;
    result.factors.push_back(factor);result.correlations.push_back(moments.correlation());
    result.residuals.push_back(residual);result.fit_slopes.push_back(slope);result.fit_intercepts.push_back(intercept);
    result.training_samples=moments.n;
    const size_t i=result.factors.size()-1;
    const double difference=result.correlations[i]-result.correlations[best];
    if (difference>1e-12||(std::abs(difference)<=1e-12&&std::abs(std::log(factor))<std::abs(std::log(result.factors[best])))) best=i;
  };
  for (double factor:{0.02,0.04,0.08,0.16,0.32,0.64,1.0,1.5,2.0}) evaluate(factor);
  // Two fixed refinement rounds in log multiplier, using only adjacent
  // already-evaluated candidates. Edge optima are reported, never concealed
  // by silently expanding the physical parameter range.
  for (int round=0;round<2;++round) {
    const double center=result.factors[best];
    double lower=0,upper=std::numeric_limits<double>::infinity();
    for (double factor:result.factors) {
      if (factor<center) lower=std::max(lower,factor);
      if (factor>center) upper=std::min(upper,factor);
    }
    if (lower>0) evaluate(std::sqrt(lower*center));
    if (std::isfinite(upper)) evaluate(std::sqrt(upper*center));
  }
  result.factor=result.factors[best];
  result.boundary_hit=result.factor==0.02||result.factor==2.0;
  result.valid=result.training_samples>=columns*25&&result.correlations[best]>0&&result.fit_slopes[best]>0;
  return result;
}

inline OracleReport oracle_metrics(const NestedVolumes& volumes,Image flux,Image density) {
  using namespace oracle_detail;
  OracleReport result;
  if (!flux.rgba||!density.rgba||flux.width<720||flux.height<360||density.width<720||density.height<360
      ||flux.width!=2*flux.height||density.width!=2*density.height) return result;
  result.model_sky.resize(static_cast<size_t>(width)*height);
  std::vector<float> projected_flux(result.model_sky.size()),projected_density(result.model_sky.size());
  // Prime the sRGB table before spawning, then write disjoint row ranges.
  (void)srgb_table();
  auto rows=[&](uint32_t begin,uint32_t end) {
    for (uint32_t y=begin;y<end;++y) for (uint32_t x=0;x<width;++x) {
      const double l=(x+0.5)*0.5*galactic_constants::radians_per_degree;
      const double b=(90-(y+0.5)*0.5)*galactic_constants::radians_per_degree;
      const Vec3 direction{std::cos(b)*std::cos(l),std::cos(b)*std::sin(l),std::sin(b)};
      const size_t i=static_cast<size_t>(y)*width+x;
      result.model_sky[i]=static_cast<float>(integrate(volumes,direction));
      projected_flux[i]=static_cast<float>(hammer_sample(flux,l,b));
      projected_density[i]=static_cast<float>(hammer_sample(density,l,b));
    }
  };
  std::thread a(rows,0,height/4),b(rows,height/4,height/2),c(rows,height/2,3*height/4);
  rows(3*height/4,height);a.join();b.join();c.join();
  Moments flux_moments,density_moments;
  for (uint32_t y=120;y<240;++y) for (uint32_t x=0;x<width;++x) {
    const size_t i=static_cast<size_t>(y)*width+x;
    const double model=log_intensity(result.model_sky[i]);
    if (std::isfinite(projected_flux[i])) flux_moments.add(model,log_intensity(projected_flux[i]));
    if (std::isfinite(projected_density[i])) density_moments.add(model,log_intensity(projected_density[i]));
  }
  result.samples=flux_moments.n;
  result.flux_r=flux_moments.correlation();result.density_r=density_moments.correlation();
  if (flux_moments.n<width*100||flux_moments.variance_x()<=0) return result;
  result.fit_scale=flux_moments.covariance()/flux_moments.variance_x();
  result.fit_intercept=(flux_moments.y-result.fit_scale*flux_moments.x)/flux_moments.n;
  const double residual=flux_moments.variance_y()-result.fit_scale*flux_moments.covariance();
  result.fit_log_rmse=std::sqrt(std::max(0.0,residual/flux_moments.n));
  // One global affine fit in log space compensates for the ESA display
  // stretch, not Galactic morphology. Pearson r is invariant to this fit.
  // FWHM compares this fitted display intensity against display luminance.
  std::vector<float> fitted(result.model_sky.size());
  for (size_t i=0;i<fitted.size();++i)
    fitted[i]=static_cast<float>(std::exp(result.fit_intercept+result.fit_scale*log_intensity(result.model_sky[i])));
  for (uint32_t i=0;i<4;++i) {
    result.fwhm_model[i]=fwhm(fitted,i*180);
    result.fwhm_flux[i]=fwhm(projected_flux,i*180);
    result.fwhm_relative_errors[i]=std::abs(result.fwhm_model[i]/result.fwhm_flux[i]-1);
  }
  result.rift_ratio=rift_ratio(fitted);result.flux_rift_ratio=rift_ratio(projected_flux);
  result.valid=result.fit_scale>0&&std::isfinite(result.fit_log_rmse);
  result.flux_sky=std::move(projected_flux);
  return result;
}

} // namespace milky_way
