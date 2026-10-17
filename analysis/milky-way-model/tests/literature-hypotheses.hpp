#pragma once
#include "../src/literature_model.hpp"
#include "../src/drimmel_dust.hpp"

// Historical run-three experiments; shared published dust equations now ship.
// No parameter search and no Gaia-derived replacement coefficients. Unchanged
// baseline quantities retain their original limitations; see HYPOTHESES.md.
namespace milky_way::hypotheses {
struct Case {
  const char* name;
  bool bhg=false,untaper=false,flare=false,warp=false;
  unsigned dust=0; // 0 baseline, 1 DS disk+existing arms, 2 DS disk/arms, 3 +local
  bool global_only=false;
  unsigned luminosity=0; // Flynn 2006 Table 5 moments: 1 V, 2 I
  bool optical_radial=false;
};
inline constexpr Case cases[]={
  {"baseline"},
  {"b-global-only",false,false,false,false,0,true},
  {"c-BHG2016",true},
  {"c-no-14kpc-taper",false,true},
  {"c-BHG-no-taper",true,true},
  {"d-LC2002-flare",false,true,true},
  {"d-Chen2019-warp",false,false,false,true},
  {"d-flare-warp",true,true,true,true},
  {"e-DS2001-disk",false,false,false,false,1},
  {"e-DS2001-arms",false,false,false,false,2},
  {"e-DS2001-local",false,false,false,false,3},
  {"cde-literature-combined",true,true,true,true,3},
  {"b-Flynn2006-V",false,false,false,false,0,false,1},
  {"be-Flynn-V-DS-local",false,false,false,false,3,false,1},
  {"be-Flynn-I-DS-local",false,false,false,false,3,false,2},
  {"ce-DS-local-no-taper",false,true,false,false,3},
  {"bce-Flynn-V-optical-radial",false,true,false,false,3,false,1,true}
};

inline double warp(Vec3 p) {
  // Chen et al. 2019, Nature Astronomy 3,320, Table 1 all-Cepheid power law.
  // https://arxiv.org/abs/1902.00998 ; kpc, angle from solar ray toward l=90.
  return .060*std::pow(std::max(0.0,std::hypot(p.x,p.y)-7.72),1.33)
    *std::sin(std::atan2(p.y,-p.x)-17.5*galactic_constants::radians_per_degree);
}

inline double local_dust(Vec3 p) { return drimmel2001::local_dust(p); }
inline double dust(Vec3 p,unsigned variant) {
  return drimmel2001::dust(p,variant,variant==1?planar_arm_density(p):0);
}

// Preserve the rejected run-three baseline ONLY in these native diagnostics.
// This Gaia-fitted coefficient is never included in the production WASM build.
inline double run_three_dust(Vec3 p) {
  const double radius=std::hypot(p.x,p.y);
  return 0.06788225099390856*std::exp((galactic_constants::solar_radius_kpc-radius)/3.0
    -std::abs(p.z)/0.134)*(1+8.0*planar_arm_density(p))
    *(1-smoothstep(14.0,16.0,radius));
}

inline Field sample(Vec3 p,const Case& h) {
  const double r=std::hypot(p.x,p.y);
  Vec3 shifted=p;
  if(h.warp)shifted.z-=warp(p);
  const auto central=stellar_components(p);
  const double taper=1-smoothstep(14,16,r);
  const double selected_taper=h.untaper?1:taper;
  double thin=std::exp((galactic_constants::solar_radius_kpc-r)/2.6-std::abs(shifted.z)/.300);
  double thick=(h.bhg?.04:.12)*std::exp((galactic_constants::solar_radius_kpc-r)/(h.bhg?2.0:3.6)-std::abs(shifted.z)/.900);
  if(h.luminosity) {
    // Flynn et al. 2006 Table 5 local V/I volume and column luminosities.
    // Moment-matched exponential PROXY: h=Sigma_L/(2*rho_L). This is not
    // their full dynamical vertical profile and not a Gaia-G population SED.
    // Preserve baseline total smooth emission at R0,z=0; only the measured
    // thin/thick split and vertical luminosity distribution change.
    const double thin_rho=h.luminosity==1?.054:.060,thick_rho=h.luminosity==1?.002:.003;
    const double thin_h=(h.luminosity==1?19.92:22.90)/(2*thin_rho)/1000;
    const double thick_h=(h.luminosity==1?4.43:6.64)/(2*thick_rho)/1000;
    // Natale et al. 2021 Table 2: old-disk V radial length 3.10 kpc.
    const double radial=h.optical_radial?3.10:2.6;
    thin=1.12*thin_rho/(thin_rho+thick_rho)*std::exp((galactic_constants::solar_radius_kpc-r)/radial-std::abs(shifted.z)/thin_h);
    thick=1.12*thick_rho/(thin_rho+thick_rho)*std::exp((galactic_constants::solar_radius_kpc-r)/3.6-std::abs(shifted.z)/thick_h);
  }
  if(h.flare) {
    // Lopez-Corredoira et al. 2002, A&A 394,883, Eqs.3,25,26:
    // h_R=3.3, h_z(R0)=.285, flare length=5.0 kpc. Eq.3 conserves
    // surface density using 1/flare. Apply their measured outer-disk law
    // beyond R0; preserve the baseline inner-disk shape, continuous at R0.
    const double dr=std::max(0.0,r-galactic_constants::solar_radius_kpc);
    const double flare=std::exp(dr/5.0);
    thin=std::exp((galactic_constants::solar_radius_kpc-r)/(dr>0?3.3:2.6)
                 -std::abs(shifted.z)/(.285*flare))/flare;
  }
  thin*=selected_taper;thick*=selected_taper;
  const double arms=model_choices::arm_emissivity*planar_arm_density(p)
    *std::exp(-std::abs(shifted.z)/model_choices::young_scale_height_kpc)*selected_taper;
  const double old=thin+thick+central.bulge+central.bar;
  const double kappa=h.dust?dust(shifted,h.dust):run_three_dust(shifted);
  return {old+arms,model_choices::bp_old*old+model_choices::bp_young*arms,
    model_choices::rp_old*old+model_choices::rp_young*arms,kappa};
}
} // namespace milky_way::hypotheses
