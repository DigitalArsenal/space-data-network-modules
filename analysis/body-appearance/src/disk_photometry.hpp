#pragma once
#include "models.hpp"

namespace appearance {
// Gauss-Legendre quadrature of the illuminated, visible part of a sphere.
// Observer-centric latitude is 0..pi/2 (north/south symmetry), longitude is
// phase-pi/2..pi/2. Integrand is (I/F)*mu*dOmega / pi. This computes absolute
// disk albedo, not a phase polynomial normalized to an external oracle.
struct DiskQuadrature {
  static constexpr int n=64;
  std::array<double,n> x{},weight{};
  DiskQuadrature() {
    for(int i=0;i<n/2;i++) {
      double z=std::cos(pi*(i+.75)/(n+.5)),derivative=0;
      for(int iteration=0;iteration<20;iteration++) {
        double p=1,previous=0;
        for(int j=1;j<=n;j++){double old=previous;previous=p;p=((2*j-1)*z*previous-(j-1)*old)/j;}
        derivative=n*(z*p-previous)/(z*z-1);
        const double next=z-p/derivative;
        if(std::abs(next-z)<1e-15){z=next;break;}
        z=next;
      }
      x[i]=-z;x[n-1-i]=z;
      weight[i]=weight[n-1-i]=2/((1-z*z)*derivative*derivative);
    }
  }
};
inline double hg_particle(double g,double phase) {
  return (1-g*g)/std::pow(1+g*g+2*g*std::cos(phase),1.5);
}
inline double tabulated_phase_parameter(const std::string& model,const char* name,double phase) {
  const double index=phase*180/pi/30;
  const int lower=std::min(5,int(index));
  const double fraction=index-lower;
  return (1-fraction)*parameter(model,std::string(name)+std::to_string(lower))+
    fraction*parameter(model,std::string(name)+std::to_string(lower+1));
}
template<class ProjectedRadiance>
inline double integrate_disk(double phase,const ProjectedRadiance& project) {
  static const DiskQuadrature quadrature;
  double total=0;
  for(int i=0;i<DiskQuadrature::n;i++) {
    const double latitude=(quadrature.x[i]+1)*pi/4,c=std::cos(latitude);
    for(int j=0;j<DiskQuadrature::n;j++) {
      const double longitude=phase-pi/2+(quadrature.x[j]+1)*(pi-phase)/2;
      const double mu=c*std::cos(longitude),mu0=c*std::cos(longitude-phase);
      const double projected=project(mu,mu0);
      total+=projected*c*quadrature.weight[i]*quadrature.weight[j];
    }
  }
  return total*(pi-phase)/4;
}
inline double disk_albedo(const std::string& model,double phase,double lambert_albedo=1) {
  const bool jupiter=model=="jupiter:heng2021:550nm",lambert=model=="sphere:lambert";
  double w=0,epsilon=0,particle=0,A=0,B=0;
  if(jupiter) {
    w=parameter(model,"w");const double gamma=std::sqrt(1-w);epsilon=(1-gamma)/(1+gamma);
    const double f=parameter(model,"f");
    particle=f*hg_particle(parameter(model,"g1"),phase)+(1-f)*hg_particle(parameter(model,"g2"),phase);
  } else if(!lambert) {
    A=tabulated_phase_parameter(model,"A",phase);B=tabulated_phase_parameter(model,"B",phase);
  }
  return integrate_disk(phase,[&](double mu,double mu0) {
      double projected;
      if(lambert)projected=lambert_albedo*mu*mu0;
      else if(jupiter) {
        // Heng et al. 2021 Eq.(6),(23); Heng & Li 2021 Eq.(5), Table 1.
        const auto H=[epsilon](double t){return (1+epsilon)*(1-epsilon/2+epsilon*t);};
        projected=w/4*mu*mu0/(mu+mu0)*(particle-1+H(mu)*H(mu0));
      } else {
        // Dyudina et al. 2016 Eq.(4), Table 3. Multiply by mu before
        // evaluation to avoid a spurious limb singularity in I/F.
        projected=A*std::pow(mu*mu0/(mu+mu0),B);
      }
      return projected;
  });
}
}
