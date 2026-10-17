#pragma once
#include "reid_arms.hpp"
#include <vector>

namespace milky_way {
// Independent Table 2 inputs are supplied by the offline oracle through $PCE.
// Rows: beta_min, beta_max, beta_kink [deg], R_kink [kpc], psi_before,
// psi_after [deg], intrinsic width [kpc]. No model values serve as goldens.
struct ReidAcceptance {
  std::vector<double> curve_errors,counts,rms,limits,residuals;
  unsigned excluded=0;
};

inline ReidAcceptance reid_acceptance(const std::vector<double>& masers,
    const std::vector<double>& segments,const std::vector<double>& exclusions,
    const std::vector<double>& published) {
  ReidAcceptance r;
  constexpr unsigned n=7;
  r.curve_errors.resize(n);r.counts.resize(n);r.rms.resize(n);r.limits.resize(n);
  for(unsigned j=0;j<n;++j) {
    const auto& arm=reid_segments[j];const auto domain=arm_beta_domain(arm);
    const double* p=published.data()+7*j;
    // Cover the full implemented arm, both kink sides and the kink itself.
    for(unsigned i=0;i<=4097;++i) {
      const double beta=i==4097?p[2]*galactic_constants::radians_per_degree:
        domain[0]+(domain[1]-domain[0])*i/4096;
      const double kink=p[2]*galactic_constants::radians_per_degree;
      const double pitch=(beta<=kink?p[4]:p[5])*galactic_constants::radians_per_degree;
      const double expected=p[3]*std::exp(-(beta-kink)*std::tan(pitch));
      r.curve_errors[j]=std::max(r.curve_errors[j],std::abs(arm_radius_kpc(arm,beta)-expected));
    }
    r.limits[j]=1.5*p[6];
  }
  for(size_t i=0;i<segments.size();++i) {
    const double* m=masers.data()+4*i;const unsigned j=unsigned(segments[i]);
    const double l=m[0]*galactic_constants::radians_per_degree,b=m[1]*galactic_constants::radians_per_degree;
    // Reid's Table 2 fit explicitly assumes R0=8.15 kpc. This offline data
    // comparison uses that origin, not the production observer's 8.178 kpc.
    const Vec3 p{-8.15+std::cos(b)*std::cos(l)/m[2],std::cos(b)*std::sin(l)/m[2],0};
    const double residual=arm_segment_distance_kpc(reid_segments[j],p);
    r.residuals.push_back(residual);
    if(exclusions[i]) {++r.excluded;continue;}
    r.rms[j]+=residual*residual;++r.counts[j];
  }
  for(unsigned j=0;j<n;++j)
    r.rms[j]=r.counts[j]?std::sqrt(r.rms[j]/r.counts[j]):std::numeric_limits<double>::infinity();
  return r;
}
} // namespace milky_way
