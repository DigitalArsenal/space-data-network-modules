#pragma once
#include "reid_arms.hpp"
#include <vector>

namespace milky_way {
// Independent Table 2 inputs are supplied by the offline oracle through $PCE.
// Rows: beta_min, beta_max, beta_kink [deg], R_kink [kpc], psi_before,
// psi_after [deg], intrinsic width [kpc]. No model values serve as goldens.
struct ReidAcceptance {
  std::vector<double> curve_errors,counts,rms,finite_rms,chi2_nu,measurement_sigma,residuals;
  unsigned excluded=0;
};

inline ReidAcceptance reid_acceptance(const std::vector<double>& masers,
    const std::vector<double>& segments,const std::vector<double>& exclusions,
    const std::vector<double>& published,const std::vector<double>& parallax_errors) {
  ReidAcceptance r;
  constexpr unsigned n=7;
  r.curve_errors.resize(n);r.counts.resize(n);r.rms.resize(n);r.chi2_nu.resize(n);r.finite_rms.resize(n);
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
  }
  for(size_t i=0;i<segments.size();++i) {
    const double* m=masers.data()+4*i;const unsigned j=unsigned(segments[i]);
    const double l=m[0]*galactic_constants::radians_per_degree,b=m[1]*galactic_constants::radians_per_degree;
    // Reid's Table 2 fit explicitly assumes R0=8.15 kpc. This offline data
    // comparison uses that origin, not the production observer's 8.178 kpc.
    const Vec3 p{-8.15+std::cos(b)*std::cos(l)/m[2],std::cos(b)*std::sin(l)/m[2],0};
    const auto closest=published_arm_closest_point(reid_segments[j],p);
    const double residual=closest.distance;
    const Vec3 sightline{std::cos(b)*std::cos(l),std::cos(b)*std::sin(l),0};
    // Delta-method propagation: dD/d(parallax)=-1/parallax^2, and the
    // closest-distance gradient is the unit residual (envelope theorem).
    // At zero residual use the local arm normal instead. Input mas -> kpc.
    const auto& arm=reid_segments[j];
    const double pitch=closest.beta<=arm.beta_kink?arm.tan_before:arm.tan_after;
    const Vec3 normal=residual>1e-12?(p-closest.point)*(1/residual):
      normalized(Vec3{pitch*std::sin(closest.beta)-std::cos(closest.beta),
                      pitch*std::cos(closest.beta)+std::sin(closest.beta),0});
    const double sigma=std::abs(dot(normal,sightline))*parallax_errors[i]/(m[2]*m[2]);
    r.measurement_sigma.push_back(sigma);
    r.residuals.push_back(residual);
    if(exclusions[i]) {++r.excluded;continue;}
    r.rms[j]+=residual*residual;++r.counts[j];
    const double finite=arm_segment_distance_kpc(reid_segments[j],p);
    r.finite_rms[j]+=finite*finite;
    const double width=published[7*j+6];
    r.chi2_nu[j]+=residual*residual/(width*width+sigma*sigma);
  }
  for(unsigned j=0;j<n;++j) {
    r.rms[j]=r.counts[j]?std::sqrt(r.rms[j]/r.counts[j]):std::numeric_limits<double>::infinity();
    r.finite_rms[j]=r.counts[j]?std::sqrt(r.finite_rms[j]/r.counts[j]):std::numeric_limits<double>::infinity();
    // Run-three decision defines chi2_nu as the mean, not N-minus-fitted-p.
    r.chi2_nu[j]=r.counts[j]?r.chi2_nu[j]/r.counts[j]:std::numeric_limits<double>::infinity();
  }
  return r;
}
} // namespace milky_way
