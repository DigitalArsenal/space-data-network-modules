#pragma once
#include "literature_model.hpp"
#include "oracle_metrics.hpp"

namespace milky_way {
struct ComponentDiagnostics {std::vector<double> peaks,widths;};

// Offline ablation evidence, not a second model or acceptance oracle. Integrate
// the production analytic components separately under identical attenuation.
// The final acceptance still samples the actual RGBA16F volume product.
inline ComponentDiagnostics component_diagnostics(double display_slope) {
  ComponentDiagnostics result;
  const Vec3 sun{-galactic_constants::solar_radius_kpc,0,galactic_constants::solar_height_kpc};
  for(double lon:{0.,90.,180.,270.}) {
    std::vector<float> skies[7];for(auto& sky:skies)sky.resize(720*360);
    double peaks[7]={};
    for(unsigned y=0;y<360;++y) {
      const double b=(90-(y+.5)*.5)*galactic_constants::radians_per_degree;
      const double l=lon*galactic_constants::radians_per_degree;
      const Vec3 dir{std::cos(b)*std::cos(l),std::cos(b)*std::sin(l),std::sin(b)};
      double light[7]={},transmittance=1;
      for(double t=.01;t<32;t+=.02) {
        const Vec3 p=sun+dir*t;
        if(std::abs(p.x)>16||std::abs(p.y)>16||std::abs(p.z)>3)break;
        const auto c=stellar_components(p);
        const double tau=literature(p).kappa*.02;
        const double ds=tau>1e-10?-std::expm1(-tau)/tau*.02:.02;
        const double components[]={c.thin,c.thick,c.arms,c.bulge,c.bar};
        for(unsigned k=0;k<5;++k) {
          light[k]+=transmittance*components[k]*ds;
          light[6]+=components[k]*.02; // total with dust removed
        }
        transmittance*=std::exp(-tau);
      }
      for(unsigned k=0;k<5;++k)light[5]+=light[k];
      for(unsigned k=0;k<7;++k) {
        peaks[k]=std::max(peaks[k],light[k]);
        // fwhm() reads four adjacent longitude samples; identical copies
        // here isolate a single analytic longitude cut.
        for(unsigned x:{718u,719u,0u,1u})
          skies[k][y*720+x]=static_cast<float>(std::pow(light[k],display_slope));
      }
    }
    for(unsigned k=0;k<7;++k) {
      result.peaks.push_back(peaks[k]);result.widths.push_back(oracle_detail::fwhm(skies[k],0));
    }
  }
  return result;
}
} // namespace milky_way
