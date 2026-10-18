#pragma once

#include "literature_model.hpp"
#include <cstdint>
#include <vector>

namespace milky_way {

struct Extinction { double a_g=0,e_bp_rp=0,optical_depth=0; };

template<class Sampler>
inline Extinction extinction_to(Vec3 target,Sampler sample,double step_kpc=0.02) {
  const Vec3 sun{-galactic_constants::solar_radius_kpc,0,galactic_constants::solar_height_kpc};
  const Vec3 delta=target-sun;
  const double distance=length(delta);
  if(!(distance>0)) return {};
  // Composite midpoint quadrature in kpc; a maximum step, not a fixed count,
  // preserves local-dust resolution for both nearby and distant catalog nodes.
  const unsigned steps=static_cast<unsigned>(std::clamp(std::ceil(distance/step_kpc),1.0,8192.0));
  const double ds=distance/steps;
  double tau=0;
  for(unsigned i=0;i<steps;++i) tau+=std::max(0.0,sample(sun+delta*((i+0.5)/steps)).kappa)*ds;
  // Pogson magnitudes: -2.5 log10(exp(-tau)) = 2.5 / ln(10) * tau.
  const double ag=(2.5/std::log(10.0))*tau;
  return {ag,(model_choices::bp_to_g_extinction-model_choices::rp_to_g_extinction)*ag,tau};
}

struct StarRequest {
  Vec3 minimum,maximum;
  uint64_t seed=1;
  uint32_t candidates=4096;
  double catalog_completeness=0,delivered_g_limit=20.7,display_g_limit=30;
};
struct ModelStar { Vec3 position; double absolute_g,apparent_g,a_g,weight; };

// SplitMix64 is a fully specified integer generator: Vigna (2015),
// https://prng.di.unimi.it/splitmix64.c. The high 53 bits map exactly into [0,1).
// Used for reproducible model draws only, never for security or catalog IDs.
inline uint64_t next_random(uint64_t& state) {
  uint64_t z=(state+=UINT64_C(0x9e3779b97f4a7c15));
  z=(z^(z>>30))*UINT64_C(0xbf58476d1ce4e5b9);
  z=(z^(z>>27))*UINT64_C(0x94d049bb133111eb);
  return z^(z>>31);
}
inline double random_uniform(uint64_t& state) {
  return (next_random(state)>>11)*0x1.0p-53;
}

// The luminosity function is an illustrative discrete MODEL, not a fitted Gaia
// LF: six absolute-G bins and probabilities below. There is no bundled stellar
// catalog. This declared assumption remains pending oracle/data calibration.
inline double model_absolute_g(double uniform) {
  constexpr double magnitude[]={-4.0,0.0,3.0,6.0,9.0,12.0};
  constexpr double cumulative[]={0.0001,0.001,0.03,0.18,0.53,1.0};
  for(unsigned i=0;i<5;++i) if(uniform<cumulative[i]) return magnitude[i];
  return magnitude[5];
}

inline double interval_min_abs(double low,double high) {
  return low<=0&&high>=0?0:std::min(std::abs(low),std::abs(high));
}

// A conservative analytic upper bound over the entire cell, not a sampled
// maximum. Rejection sampling therefore follows the model density without
// missing a narrow arm or clamping a missed maximum (both would bias samples).
inline double cell_density_bound(const StarRequest& request) {
  using namespace model_choices;
  const auto lo=request.minimum,hi=request.maximum;
  const double x=interval_min_abs(lo.x,hi.x),y=interval_min_abs(lo.y,hi.y);
  const double z=interval_min_abs(lo.z,hi.z),radius=std::hypot(x,y);
  // The Robin hole factor is at most 1/hole(R0) (it rises with radius).
  const double hole_bound=1/populations::old_hole(galactic_constants::solar_radius_kpc);
  const double thin_bound=std::exp((galactic_constants::solar_radius_kpc-radius)/2.6-z/0.300)*hole_bound;
  const double thick_bound=0.12*std::exp((galactic_constants::solar_radius_kpc-radius)/3.6-z/0.900);
  constexpr double angle=bar_angle_rad;
  const double c=std::cos(angle),s=std::sin(angle);
  const double u=interval_min_abs(-hi.x*c+lo.y*s,-lo.x*c+hi.y*s);
  const double v=interval_min_abs(lo.x*s+lo.y*c,hi.x*s+hi.y*c);
  const double ellipsoid=std::pow(std::pow(u/bulge_x_kpc,boxiness)+std::pow(v/bulge_y_kpc,boxiness)
      +std::pow(z/(bulge_z_kpc*(1+peanut_extent_kpc*peanut_strength)),boxiness),1/boxiness);
  // The spiral wave is at most B_K on the thin disc (g<=1, Gaussian<=1); the
  // young pattern is at most 1, on its own radial and vertical profile.
  const double young=young_amplitude()/populations::young_hole(galactic_constants::solar_radius_kpc)
      *std::exp((galactic_constants::solar_radius_kpc-radius)/populations::thin_length_kpc-z/populations::h_bright_kpc);
  return thin_bound*(1+populations::arm_amplitude_k)+thick_bound+young
      +bar_bulge_scale()*(bulge_emissivity*std::exp(-ellipsoid)+bar_emissivity*std::exp(-v/bar_minor_kpc-z/bar_height_kpc));
}

// Spatial completeness comes from the host's delivered octree selection; the
// magnitude selection itself is evaluated here AFTER extinction. Fainter than
// the delivered tier, catalog completeness is zero, even if the cell's bright
// catalog is complete. Model stars are not pickable; the boundary labels MODEL.
inline double missing_catalog_fraction(const StarRequest& request,double apparent_g) {
  return apparent_g<=request.delivered_g_limit?1-clamp01(request.catalog_completeness):1;
}

template<class Sampler>
inline std::vector<ModelStar> sample_stars(const StarRequest& request,Sampler sample) {
  const Vec3 extent=request.maximum-request.minimum;
  const double density_bound=cell_density_bound(request);
  std::vector<ModelStar> stars;
  stars.reserve(request.candidates);
  if(!(density_bound>0)||request.candidates==0) return stars;
  const Vec3 sun{-galactic_constants::solar_radius_kpc,0,galactic_constants::solar_height_kpc};
  // Units of weight: relative model density * kpc^3 per accepted particle.
  // This Monte Carlo quadrature weight preserves total modeled density when
  // cells have different bounds/budgets. It is not a measured physical count.
  const double weight=density_bound*extent.x*extent.y*extent.z/request.candidates;
  uint64_t state=request.seed;
  for(uint32_t i=0;i<request.candidates;++i) {
    const Vec3 p{request.minimum.x+extent.x*random_uniform(state),
                 request.minimum.y+extent.y*random_uniform(state),
                 request.minimum.z+extent.z*random_uniform(state)};
    // Consume the same RNG sequence regardless of completeness/visibility so
    // increasing completeness removes a deterministic subset of model stars.
    const double density_draw=random_uniform(state),lf_draw=random_uniform(state);
    const double completeness_draw=random_uniform(state);
    const auto c=stellar_components(p);
    const double density=c.thin+c.thick+c.arms+c.bulge+c.bar;
    if(density_draw*density_bound>=density) continue;
    const double absolute=model_absolute_g(lf_draw);
    const auto extinction=extinction_to(p,sample);
    // Distance modulus in kpc: m-M=5 log10(d_pc)-5=5 log10(d_kpc)+10.
    const double apparent=absolute+5*std::log10(std::max(length(p-sun),1e-9))+10+extinction.a_g;
    if(apparent>request.display_g_limit||completeness_draw>=missing_catalog_fraction(request,apparent)) continue;
    stars.push_back({p,absolute,apparent,extinction.a_g,weight});
  }
  return stars;
}

} // namespace milky_way
