#pragma once
#include "reid_arms.hpp"
#include "drimmel_dust.hpp"
#include "stellar_populations.hpp"
#include "dust_map.hpp"

namespace milky_way {

// Values not directly constrained by cited work below are declared here as
// ILLUSTRATIVE MODEL choices. They must not
// be described as measured luminosities, extinction coefficients, or a fit.
namespace model_choices {
inline constexpr double inner_arm_radius_kpc=1.5,outer_radius_kpc=16.0;
inline constexpr double outer_taper_start_kpc=14.0,minimum_arm_width_kpc=0.08;
inline constexpr double young_scale_height_kpc=0.09,arm_emissivity=0.45;
inline constexpr double bulge_x_kpc=1.0,bulge_y_kpc=0.4,bulge_z_kpc=0.3;
inline constexpr double bulge_emissivity=8.0,boxiness=4.0,peanut_strength=0.25,peanut_extent_kpc=2.0;
inline constexpr double bar_minor_kpc=0.45,bar_height_kpc=0.18,bar_emissivity=1.8;
inline constexpr double bar_taper_start_kpc=4.5;
// Literature-constrained values, unlike the illustrative profile choices:
// Wegg & Gerhard 2013 orientation and Wegg et al. 2015 bar extent.
inline constexpr double bar_angle_rad=27.0*galactic_constants::radians_per_degree;
inline constexpr double bar_half_length_kpc=5.0;
inline constexpr double bp_old=0.65,rp_old=1.20,bp_young=1.15,rp_young=0.85;
// BP and RP extinction ratios to G: Wang & Chen (2019) Table 3 red-clump
// values (stellar_populations.hpp). Real passband extinction also depends on
// the source spectrum and the column; one constant ratio per band is used.
inline constexpr double bp_to_g_extinction=populations::bp_per_g_extinction;
inline constexpr double rp_to_g_extinction=populations::rp_per_g_extinction;
} // namespace model_choices

struct StellarComponents { double thin,thick,arms,bulge,bar; };
// wave: the old disc's spiral density wave (DS2001 stellar arms, K amplitude);
// young: the bright young population's arm pattern, including its floor.
struct ArmPatterns { double wave=0,young=0; };

inline double planar_arm_density(Vec3 p) {
  const double radius=std::hypot(p.x,p.y),beta0=std::atan2(p.y,-p.x);
  double sum=0;
  for(const auto& a:reid_segments) {
    const double beta=model_beta(a,beta0),r=arm_radius_kpc(a,beta);
    if(r<model_choices::inner_arm_radius_kpc||r>model_choices::outer_radius_kpc) continue;
    const double pitch_cos=beta<=a.beta_kink?a.cos_before:a.cos_after;
    double separation=std::abs(radius-r)*pitch_cos;
    if(a.family==0||a.family==4)
      separation=std::hypot(p.x+r*std::cos(beta),p.y-r*std::sin(beta));
    // Reid 2019 section 3: dw/dR=42 pc/kpc, adopted from Reid et al. 2014.
    const double width=std::max(model_choices::minimum_arm_width_kpc,a.width_kpc+0.042*(r-a.radius_kpc));
    sum+=std::exp(-0.5*(separation/width)*(separation/width));
  }
  return sum;
}

// DS2001 Eq.(shear): a population of mean age tau drifts by phi = V_o tau
// (1/r - 1/R_C) in the direction of rotation; the drifted arm at azimuth beta
// is the dust (Reid) arm at beta - phi. Lengths scale with R0/8 as in DS.
inline Vec3 undrifted(Vec3 p,double age_myr) {
  const double r=std::hypot(p.x,p.y);
  if(!(r>0)) return p;
  const double drift=populations::circular_speed_km_s*age_myr*populations::km_s_myr_to_kpc
    *galactic_constants::solar_radius_kpc/8;
  const double beta=std::atan2(p.y,-p.x)-drift*(1/r-1/populations::corotation_kpc);
  return {-r*std::cos(beta),r*std::sin(beta),p.z};
}

// DS2001: the arm of largest exp(-(d/w)^2) contributes, with the dust arms'
// cut-off g(R_a). Four major families (Norma-Outer, Scutum-Centaurus,
// Sagittarius-Carina, Perseus), as DS2001's four arms; Reid Table 2 widths.
inline double major_arm_wave(Vec3 p) {
  const double radius=std::hypot(p.x,p.y),beta0=std::atan2(p.y,-p.x);
  double best=0;
  for(const auto& a:reid_segments) {
    if(a.family==0||a.family==4) continue;
    const double beta=model_beta(a,beta0),r=arm_radius_kpc(a,beta);
    if(r<model_choices::inner_arm_radius_kpc||r>model_choices::outer_radius_kpc) continue;
    const double pitch_cos=beta<=a.beta_kink?a.cos_before:a.cos_after;
    const double separation=std::abs(radius-r)*pitch_cos;
    const double width=std::max(model_choices::minimum_arm_width_kpc,a.width_kpc+0.042*(r-a.radius_kpc));
    const double cutoff=r>populations::arm_cutoff_kpc
      ?std::exp(-std::pow((r-populations::arm_cutoff_kpc)/populations::arm_cutoff_scale_kpc,2)):1.0;
    best=std::max(best,cutoff*std::exp(-0.5*(separation/width)*(separation/width)));
  }
  return best;
}

inline double young_pattern(Vec3 p) {
  const double f=populations::young_interarm_floor;
  return f+(1-f)*std::min(1.0,planar_arm_density(undrifted(p,populations::drift_age_j_myr)));
}

inline ArmPatterns arm_patterns(Vec3 p) {
  return {populations::arm_amplitude_k*major_arm_wave(undrifted(p,populations::drift_age_k_myr)),young_pattern(p)};
}

// Flynn 2006: the bright (M_V<-1) stars are 20% of the local mid-plane
// light; relative to the Juric thin disc's local mid-plane density (1) they
// are bright/old-thin = 0.262 there. The Sun's own young pattern value fixes
// the amplitude, so the Sun's neighbourhood keeps the measured fraction.
inline double young_amplitude() {
  static const double amplitude=populations::rho_bright/populations::rho_old_thin
    /young_pattern({-galactic_constants::solar_radius_kpc,0,0});
  return amplitude;
}

// Juric thin disc with the Robin et al. (2003) central hole, unchanged at R0.
inline std::array<double,2> disc_densities(Vec3 p) {
  const double radius=std::hypot(p.x,p.y),height=std::abs(p.z);
  static const double hole_sun=populations::old_hole(galactic_constants::solar_radius_kpc);
  return {std::exp((galactic_constants::solar_radius_kpc-radius)/2.6-height/populations::h_old_thin_kpc)*populations::old_hole(radius)/hole_sun,
          populations::rho_v_thick/populations::rho_old_thin*std::exp((galactic_constants::solar_radius_kpc-radius)/3.6-height/populations::h_thick_kpc)};
}

// The unscaled bulge and bar shapes (Wegg & Gerhard 2013 orientation, Wegg
// et al. 2015 half-length); bar_bulge_scale() sets their sum from Portail 2017.
inline std::array<double,2> bulge_bar_shapes(Vec3 p) {
  using namespace model_choices;
  const double height=std::abs(p.z);
  constexpr double angle=bar_angle_rad;
  const double u=-p.x*std::cos(angle)+p.y*std::sin(angle);
  const double v=p.x*std::sin(angle)+p.y*std::cos(angle);
  const double effective_z=bulge_z_kpc*(1+peanut_strength*std::min(std::abs(u),peanut_extent_kpc));
  const double ellipsoid=std::pow(std::pow(std::abs(u)/bulge_x_kpc,boxiness)
      +std::pow(std::abs(v)/bulge_y_kpc,boxiness)+std::pow(height/effective_z,boxiness),1/boxiness);
  return {bulge_emissivity*std::exp(-ellipsoid),
          bar_emissivity*std::exp(-std::abs(v)/bar_minor_kpc-height/bar_height_kpc)
            *(1-smoothstep(bar_taper_start_kpc,bar_half_length_kpc,std::abs(u)))};
}

inline StellarComponents stellar_components(Vec3 p,ArmPatterns pattern,double bar_bulge);
// Midpoint integrals over the cylinder R <= 5 kpc, |z| <= 3 kpc (20 pc in x
// and y, z on a signed-square axis dense at the plane), computed once.
inline double bar_bulge_scale() {
  static const double scale=[] {
    double disc=0,central=0;
    constexpr int n=200,nz=100;
    const double h=2*populations::bar_region_kpc/n;
    for(int k=0;k<nz;++k) {
      const double u0=2.0*k/nz-1,u1=2.0*(k+1)/nz-1;
      const double z0=3*std::copysign(u0*u0,u0),z1=3*std::copysign(u1*u1,u1),z=(z0+z1)/2,dz=z1-z0;
      for(int j=0;j<n;++j) for(int i=0;i<n;++i) {
        const Vec3 p{-populations::bar_region_kpc+(i+0.5)*h,-populations::bar_region_kpc+(j+0.5)*h,z};
        if(std::hypot(p.x,p.y)>populations::bar_region_kpc) continue;
        const auto c=stellar_components(p,arm_patterns(p),0.0);
        const auto shapes=bulge_bar_shapes(p);
        disc+=(c.thin+c.thick+c.arms)*h*h*dz;central+=(shapes[0]+shapes[1])*h*h*dz;
      }
    }
    return populations::bar_bulge_mass/populations::inner_disc_mass*disc/central;
  }();
  return scale;
}

inline StellarComponents stellar_components(Vec3 p,ArmPatterns pattern) {
  return stellar_components(p,pattern,bar_bulge_scale());
}

inline StellarComponents stellar_components(Vec3 p,ArmPatterns pattern,double bar_bulge) {
  using namespace model_choices;
  const double radius=std::hypot(p.x,p.y),height=std::abs(p.z);
  // Juric et al. (2008), ApJ 673,864, doi:10.1086/523619, bias-corrected
  // double exponential: H1=.300, H2=.900, L1=2.6,L2=3.6 kpc, f=.12.
  // Context/review: Bland-Hawthorn & Gerhard (2016), ARA&A 54,529,
  // doi:10.1146/annurev-astro-081915-023441; retain the explicit Juric choice.
  // These are number-density shape parameters, not measured Gaia luminosities.
  const auto discs=disc_densities(p);
  const double thin=discs[0],thick=discs[1];
  // Spiral light: the thin disc's density wave plus the young population.
  static const double young_hole_sun=populations::young_hole(galactic_constants::solar_radius_kpc);
  const double young=young_amplitude()*pattern.young*populations::young_hole(radius)/young_hole_sun
    *std::exp((galactic_constants::solar_radius_kpc-radius)/populations::thin_length_kpc
              -height/populations::h_bright_kpc);
  const double arms=thin*pattern.wave+young;
  // Wegg & Gerhard (2013), MNRAS 435,1874, doi:10.1093/mnras/stt1376:
  // boxy/peanut morphology and orientation ~27 degrees. The analytic boxy
  // proxy and its scales/amplitudes below are our choices, not their 3D map.
  constexpr double angle=bar_angle_rad;
  const double u=-p.x*std::cos(angle)+p.y*std::sin(angle);
  const double v=p.x*std::sin(angle)+p.y*std::cos(angle);
  const double effective_z=bulge_z_kpc*(1+peanut_strength*std::min(std::abs(u),peanut_extent_kpc));
  const double ellipsoid=std::pow(std::pow(std::abs(u)/bulge_x_kpc,boxiness)
      +std::pow(std::abs(v)/bulge_y_kpc,boxiness)+std::pow(height/effective_z,boxiness),1/boxiness);
  const double scale=bar_bulge;
  const double bulge=scale*bulge_emissivity*std::exp(-ellipsoid);
  // Wegg, Gerhard & Portail (2015), MNRAS 450,4050,
  // doi:10.1093/mnras/stv745: long-bar half-length 5.0 kpc; the transverse
  // profile/normalization and smooth terminal taper are illustrative choices.
  const double bar=scale*bar_emissivity*std::exp(-std::abs(v)/bar_minor_kpc-height/bar_height_kpc)
      *(1-smoothstep(bar_taper_start_kpc,bar_half_length_kpc,std::abs(u)));
  const double taper=1-smoothstep(outer_taper_start_kpc,outer_radius_kpc,radius);
  return {thin*taper,thick*taper,arms*taper,bulge*taper,bar*taper};
}

inline StellarComponents stellar_components(Vec3 p,double) {
  return stellar_components(p,ArmPatterns{});
}

inline StellarComponents stellar_components(Vec3 p) {
  return stellar_components(p,arm_patterns(p));
}

inline Field literature(Vec3 p) {
  using namespace model_choices;
  const auto pattern=arm_patterns(p);
  const auto c=stellar_components(p,pattern);
  const double young=c.arms-c.thin*pattern.wave;
  const double old=c.thin+c.thick+c.bulge+c.bar+c.thin*pattern.wave;
  // Run-four dust: published disk, separate arm dust and local segment
  // (run-three hypothesis e), with no Gaia-fitted normalization; inside a
  // delivered 3D dust map's coverage the map replaces it (dust_map.hpp).
  const double dust=dust_map::blend(p,drimmel2001::dust(p));
  return {old+young,bp_old*old+bp_young*young,rp_old*old+rp_young*young,dust};
}

} // namespace milky_way
