#pragma once
#include "../src/literature_model.hpp"

// Independent run-three experiments, deliberately absent from the WASM build.
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

inline double local_dust(Vec3 p) {
  // Drimmel & Spergel 2001 Eq.18, Tables 1/2. Preserve the dimensionless
  // geometry in their R_sun=8 kpc frame, rescaled to the production R_sun.
  const double scale=galactic_constants::solar_radius_kpc/8;
  const double beta=std::atan2(p.y,-p.x),r=std::hypot(p.x,p.y);
  const double lo=-.643*1.5*galactic_constants::radians_per_degree;
  const double hi=1.5*galactic_constants::radians_per_degree;
  const double pitch=std::tan(7.33*galactic_constants::radians_per_degree);
  double planar2;
  if(beta>lo&&beta<hi) {
    const double rlo=8.001*scale*std::exp(-lo*pitch);
    const double rhi=8.001*scale*std::exp(-hi*pitch);
    const double dlo=std::hypot(p.x+rlo*std::cos(lo),p.y-rlo*std::sin(lo));
    const double dhi=std::hypot(p.x+rhi*std::cos(hi),p.y-rhi*std::sin(hi));
    planar2=std::min(dlo*dlo,dhi*dhi);
  } else {
    const double delta=r-8.001*scale*std::exp(-beta*pitch);
    planar2=delta*delta;
  }
  const double z=p.z-.01785*scale,w=.02442*scale;
  return 121/scale*std::exp(-(planar2+z*z)/(w*w));
}

inline double dust(Vec3 p,unsigned variant) {
  // DS2001 Eq.13-18 and Tables 1/2, NOT the FIR emissivity amplitudes.
  // Density units absorb FIR emissivity; kappa_V=.018 (MJy/sr)^-1 is the
  // fitted optical-depth coefficient. Wang & Chen 2019 Table 3: A_G/A_V=.789
  // for red-clump spectra (an approximation for the full mixed population).
  const double scale=galactic_constants::solar_radius_kpc/8;
  const double r=std::hypot(p.x,p.y)/scale,z=p.z/scale;
  const double h=.1344+.0148*std::max(0.0,r-4.40);
  const double radial=r<4?std::exp(-4/2.26-std::pow((r-4)/2,2)):std::exp(-r/2.26);
  const double disk=1098*radial/std::pow(std::cosh(z/h),2)/scale;
  if(variant==1) return .789*.018*disk*(1+8*planar_arm_density(p));
  double arms=0;
  for(const auto& a:reid_segments) {
    if(a.family==0||a.family==4)continue;
    const double beta=model_beta(a,std::atan2(p.y,-p.x));
    const double ra=arm_radius_kpc(a,beta)/scale;
    if(ra<1.5||ra>16/scale)continue;
    const double pitch_cos=beta<=a.beta_kink?a.cos_before:a.cos_after;
    const double separation=std::abs(r-ra)*pitch_cos;
    const double reduction=a.family==3?.407:1;
    const double w=.0641*ra*reduction;
    const double ha=(.080+.0146*std::pow(std::max(0.0,ra-5.48),2))*reduction;
    const double taper=std::exp(-std::pow(std::max(0.0,ra-6.71)/2.07,2));
    // DS uses the largest contribution, not an additive overlap of arms.
    arms=std::max(arms,61/scale*taper*std::exp(-std::pow(separation/w,2)-std::pow(z/ha,2)));
  }
  return .789*.018*(disk+arms+(variant==3?local_dust(p):0));
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
  const double kappa=h.dust?dust(shifted,h.dust):literature(shifted).kappa;
  return {old+arms,model_choices::bp_old*old+model_choices::bp_young*arms,
    model_choices::rp_old*old+model_choices::rp_young*arms,kappa};
}
} // namespace milky_way::hypotheses
