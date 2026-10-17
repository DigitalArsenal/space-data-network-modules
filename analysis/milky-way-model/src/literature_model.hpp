#pragma once

#include "galactic_constants.hpp"
#include "model_types.hpp"
#include <array>
#include <limits>

namespace milky_way {

inline constexpr unsigned arm_count = 6;

struct ArmSegment {
  const char* name;
  unsigned family;
  double beta_min_deg, beta_max_deg, beta_kink_deg, radius_kpc;
  double pitch_before_deg, pitch_after_deg, width_kpc;
  double beta_kink, tan_before, tan_after, cos_before, cos_after;
  ArmSegment(const char* n,unsigned f,double lo,double hi,double kink,double r,
             double before,double after,double width)
      : name(n),family(f),beta_min_deg(lo),beta_max_deg(hi),beta_kink_deg(kink),
        radius_kpc(r),pitch_before_deg(before),pitch_after_deg(after),width_kpc(width),
        beta_kink(kink*galactic_constants::radians_per_degree),
        tan_before(std::tan(before*galactic_constants::radians_per_degree)),
        tan_after(std::tan(after*galactic_constants::radians_per_degree)),
        cos_before(std::cos(before*galactic_constants::radians_per_degree)),
        cos_after(std::cos(after*galactic_constants::radians_per_degree)) {}
};

// Reid et al. (2019), ApJ 885, 131, doi:10.3847/1538-4357/ab4a11,
// Table 2 central values, transcribed from the locally saved author TeX.
// The table has SEVEN fitted segments for SIX physical arm families: Norma and
// Outer share a family. beta is measured toward Galactic rotation from the Sun
// ray; degrees, kpc, Gaussian one-sigma width. beta_min/max delimit the measured
// parallax coverage, NOT measured boundaries of the arms. Reid used R0=8.15 kpc;
// we keep its fitted radii unchanged while adopting the task's R0=8.178 kpc.
inline const std::array<ArmSegment,7> reid_segments = {{
  {"3-kpc(N)",0, 15,18,15,3.52,-4.2,-4.2,0.18},
  {"Norma",1, 5,54,18,4.46,-1.0,19.5,0.14},
  {"Scutum-Centaurus",2, 0,104,23,4.91,14.1,12.1,0.23},
  {"Sagittarius-Carina",3, 2,97,24,6.04,17.1,1.0,0.27},
  {"Local",4, -8,34,9,8.26,11.4,11.4,0.31},
  {"Perseus",5, -23,115,40,8.87,10.3,8.7,0.35},
  {"Outer",1, -16,71,18,12.24,3.0,9.4,0.65}
}};

inline double arm_radius_kpc(const ArmSegment& a,double beta) {
  const double pitch=beta<=a.beta_kink?a.tan_before:a.tan_after;
  return a.radius_kpc*std::exp(-(beta-a.beta_kink)*pitch);
}

// Shared physical domain for baking and both independent ridge estimators.
// Reid 2019 section 3.2.2 extends Scutum counterclockwise past the far side
// into OSC (G007.47+00.05). A principal-angle wrap at kink +/- pi cuts that
// continuation off. Its outward endpoint is the model's 16-kpc radial edge;
// its inner endpoint is the tabulated 104-degree coverage. Other major arms
// retain explicitly illustrative one-revolution extensions; Local/3-kpc stay
// within their measured coverage. No maser is used to tune a curve here.
inline std::array<double,2> arm_beta_domain(const ArmSegment& a) {
  if(a.family==0||a.family==4)
    return {a.beta_min_deg*galactic_constants::radians_per_degree,
            a.beta_max_deg*galactic_constants::radians_per_degree};
  if(a.family==2)
    return {a.beta_kink-std::log(16.0/a.radius_kpc)/a.tan_before,
            a.beta_max_deg*galactic_constants::radians_per_degree};
  return {a.beta_kink-galactic_constants::pi,a.beta_kink+galactic_constants::pi};
}

inline double model_beta(const ArmSegment& a,double beta) {
  const auto domain=arm_beta_domain(a);
  constexpr double turn=2*galactic_constants::pi;
  // Unwrap around this segment's domain, not around its kink: the observed
  // far-side OSC continuation is at negative unwrapped Galactic azimuth.
  const double middle=(domain[0]+domain[1])/2;
  beta+=turn*std::round((middle-beta)/turn);
  return std::clamp(beta,domain[0],domain[1]);
}

// Euclidean closest-point distance to a kinked logarithmic curve. The two
// smooth sides are minimized separately so Newton iteration never crosses a
// discontinuity in pitch. Used for validation, not the volume's hot loop.
inline double arm_segment_distance_kpc(const ArmSegment& a,Vec3 p) {
  const double beta0=std::atan2(p.y,-p.x);
  double best=std::numeric_limits<double>::infinity();
  const auto domain=arm_beta_domain(a);
  const double domain_lo=domain[0],domain_hi=domain[1];
  for(int side=0;side<2;++side) {
    const double lo=side?std::max(domain_lo,a.beta_kink):domain_lo;
    const double hi=side?domain_hi:std::min(domain_hi,a.beta_kink);
    if(hi<lo) continue;
    const double tangent=side?a.tan_after:a.tan_before;
    for(int wrap=-1;wrap<=1;++wrap) {
      double beta=std::clamp(beta0+wrap*2*galactic_constants::pi,lo,hi);
      for(int iteration=0;iteration<8;++iteration) {
        const double r=arm_radius_kpc(a,beta),c=std::cos(beta),s=std::sin(beta);
        const double x=-r*c,y=r*s,dx=r*(tangent*c+s),dy=r*(-tangent*s+c);
        const double ddx=r*((1-tangent*tangent)*c-2*tangent*s);
        const double ddy=r*((tangent*tangent-1)*s-2*tangent*c);
        const double gradient=(x-p.x)*dx+(y-p.y)*dy;
        const double curvature=dx*dx+dy*dy+(x-p.x)*ddx+(y-p.y)*ddy;
        if(curvature<=0) break;
        beta=std::clamp(beta-std::clamp(gradient/curvature,-0.25,0.25),lo,hi);
      }
      for(double candidate:{lo,beta,hi}) {
        const double r=arm_radius_kpc(a,candidate);
        best=std::min(best,std::hypot(p.x+r*std::cos(candidate),p.y-r*std::sin(candidate)));
      }
    }
  }
  return best;
}

inline double arm_distance_kpc(unsigned family,Vec3 p) {
  double best=std::numeric_limits<double>::infinity();
  for(const auto& a:reid_segments) if(a.family==family)
    best=std::min(best,arm_segment_distance_kpc(a,p));
  return best;
}

// Values not directly constrained by cited work below are declared here as
// ILLUSTRATIVE MODEL choices, pending the Gaia oracle calibration. They must not
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
inline constexpr double dust_radial_kpc=3.0,dust_height_kpc=0.134;
// Uncalibrated model normalization. Offline WASM calibration records its
// multiplier and full residuals in the ignored dist/calibration-fit.json.
// A runtime bake uses this coefficient, not the test-only oracle fit.
inline constexpr double dust_solar_per_kpc=0.15,arm_dust_multiplier=8.0;
inline constexpr double bp_old=0.65,rp_old=1.20,bp_young=1.15,rp_young=0.85;
// BP and RP extinction ratios are a constant illustrative approximation; real
// Gaia passband extinction depends on stellar color and extinction itself.
inline constexpr double bp_to_g_extinction=1.30,rp_to_g_extinction=0.80;
} // namespace model_choices

struct StellarComponents { double thin,thick,arms,bulge,bar; };

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

inline std::array<double,2> disc_densities(Vec3 p) {
  const double radius=std::hypot(p.x,p.y),height=std::abs(p.z);
  return {std::exp((galactic_constants::solar_radius_kpc-radius)/2.6-height/0.300),
          0.12*std::exp((galactic_constants::solar_radius_kpc-radius)/3.6-height/0.900)};
}

inline StellarComponents stellar_components(Vec3 p,double planar_arms) {
  using namespace model_choices;
  const double radius=std::hypot(p.x,p.y),height=std::abs(p.z);
  // Juric et al. (2008), ApJ 673,864, doi:10.1086/523619, bias-corrected
  // double exponential: H1=.300, H2=.900, L1=2.6,L2=3.6 kpc, f=.12.
  // Context/review: Bland-Hawthorn & Gerhard (2016), ARA&A 54,529,
  // doi:10.1146/annurev-astro-081915-023441; retain the explicit Juric choice.
  // These are number-density shape parameters, not measured Gaia luminosities.
  const auto discs=disc_densities(p);
  const double thin=discs[0],thick=discs[1];
  const double arms=arm_emissivity*planar_arms*std::exp(-height/young_scale_height_kpc);
  // Wegg & Gerhard (2013), MNRAS 435,1874, doi:10.1093/mnras/stt1376:
  // boxy/peanut morphology and orientation ~27 degrees. The analytic boxy
  // proxy and its scales/amplitudes below are our choices, not their 3D map.
  constexpr double angle=bar_angle_rad;
  const double u=-p.x*std::cos(angle)+p.y*std::sin(angle);
  const double v=p.x*std::sin(angle)+p.y*std::cos(angle);
  const double effective_z=bulge_z_kpc*(1+peanut_strength*std::min(std::abs(u),peanut_extent_kpc));
  const double ellipsoid=std::pow(std::pow(std::abs(u)/bulge_x_kpc,boxiness)
      +std::pow(std::abs(v)/bulge_y_kpc,boxiness)+std::pow(height/effective_z,boxiness),1/boxiness);
  const double bulge=bulge_emissivity*std::exp(-ellipsoid);
  // Wegg, Gerhard & Portail (2015), MNRAS 450,4050,
  // doi:10.1093/mnras/stv745: long-bar half-length 5.0 kpc; the transverse
  // profile/normalization and smooth terminal taper are illustrative choices.
  const double bar=bar_emissivity*std::exp(-std::abs(v)/bar_minor_kpc-height/bar_height_kpc)
      *(1-smoothstep(bar_taper_start_kpc,bar_half_length_kpc,std::abs(u)));
  const double taper=1-smoothstep(outer_taper_start_kpc,outer_radius_kpc,radius);
  return {thin*taper,thick*taper,arms*taper,bulge*taper,bar*taper};
}

inline StellarComponents stellar_components(Vec3 p) {
  return stellar_components(p,planar_arm_density(p));
}

inline Field literature(Vec3 p) {
  using namespace model_choices;
  const double planar_arms=planar_arm_density(p);
  const auto c=stellar_components(p,planar_arms);
  const double old=c.thin+c.thick+c.bulge+c.bar;
  // Drimmel & Spergel (2001), ApJ 556,181, doi:10.1086/321556 motivates a
  // dust disc + spiral arms + local segment. This implementation rides Reid's
  // arms (including Local), not Drimmel's fitted geometry. Every numerical
  // dust normalization/scale here is explicitly an uncalibrated model choice.
  const double radius=std::hypot(p.x,p.y);
  const double dust=dust_solar_per_kpc*std::exp((galactic_constants::solar_radius_kpc-radius)/dust_radial_kpc
      -std::abs(p.z)/dust_height_kpc)*(1+arm_dust_multiplier*planar_arms)
      *(1-smoothstep(outer_taper_start_kpc,outer_radius_kpc,radius));
  return {old+c.arms,bp_old*old+bp_young*c.arms,rp_old*old+rp_young*c.arms,dust};
}

} // namespace milky_way
