#pragma once
#include "disk_photometry.hpp"

namespace appearance {
// Separate spectral response integration from the surface scattering model.
// Bessell (1990) Table 2 is an ENERGY response. The wavelength factor used
// with photon-throughput tables must not be applied a second time.
struct JohnsonVWeights {
  static constexpr int n=24;
  std::array<double,n> weight{};
  JohnsonVWeights() {
    const std::string solar="solar:calspec2015";
    const int count=int(parameter(solar,"sample_count"));
    for(int j=0;j<count-1;++j) {
      const double x0=parameter(solar,"wavelength_"+std::to_string(j));
      const double x1=parameter(solar,"wavelength_"+std::to_string(j+1));
      const double f0=parameter(solar,"irradiance_"+std::to_string(j));
      const double f1=parameter(solar,"irradiance_"+std::to_string(j+1));
      for(int k=0;k<n-1;++k) {
        const double knot=470+10*k,lo=std::max(x0,knot),hi=std::min(x1,knot+10);
        if(hi<=lo)continue;
        const double t0=parameter("band:bessell1990:V","response_"+std::to_string(470+10*k));
        const double t1=parameter("band:bessell1990:V","response_"+std::to_string(480+10*k));
        // Split at all spectrum and filter knots. On each interval F_lambda,
        // response and each albedo basis are linear: two-point Gauss-Legendre
        // integrates their cubic product exactly (apart from roundoff).
        for(double sign:{-1.0,1.0}) {
          const double x=(lo+hi)/2+sign*(hi-lo)/(2*std::sqrt(3.0));
          const double t=(x-knot)/10;
          const double irradiance=f0+(f1-f0)*(x-x0)/(x1-x0);
          const double response=t0+(t1-t0)*t;
          const double value=irradiance*response*(hi-lo)/2;
          weight[k]+=value*(1-t);weight[k+1]+=value*t;
        }
      }
    }
    double normalization=0;for(double w:weight)normalization+=w;
    for(double& w:weight)w/=normalization;
  }
};

inline double jupiter_v_disk_albedo(double phase) {
  static const JohnsonVWeights band;
  // Linearity lets us sum the spectral scattering contributions before the
  // sphere integral. No phase normalization or absolute-albedo adjustment.
  double single=0,linear=0,quadratic=0;
  for(int k=0;k<JohnsonVWeights::n;++k) {
    const std::string model="jupiter:heng2021:"+std::to_string(470+10*k)+"nm";
    const double w=parameter(model,"w"),gamma=std::sqrt(1-w),e=(1-gamma)/(1+gamma);
    const double f=parameter(model,"f");
    const double p=f*hg_particle(parameter(model,"g1"),phase)+(1-f)*hg_particle(parameter(model,"g2"),phase);
    const double a=(1+e)*(1-e/2),b=(1+e)*e,scale=band.weight[k]*w/4;
    single+=scale*(p-1+a*a);linear+=scale*a*b;quadratic+=scale*b*b;
  }
  return integrate_disk(phase,[&](double mu,double mu0) {
    return mu*mu0/(mu+mu0)*(single+linear*(mu+mu0)+quadratic*mu*mu0);
  });
}
}
