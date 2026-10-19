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
// Validation domain of the Reid curves (ridge_metrics), unchanged from 0.2.0.
inline constexpr double inner_arm_radius_kpc=1.5,outer_radius_kpc=16.0;
inline constexpr double minimum_arm_width_kpc=0.08;
inline constexpr double young_scale_height_kpc=0.09,arm_emissivity=0.45;
inline constexpr double bulge_x_kpc=1.0,bulge_y_kpc=0.4,bulge_z_kpc=0.3;
inline constexpr double bulge_emissivity=8.0,boxiness=4.0,peanut_strength=0.25,peanut_extent_kpc=2.0;
inline constexpr double bar_minor_kpc=0.45,bar_height_kpc=0.18,bar_emissivity=1.8;
inline constexpr double bar_taper_start_kpc=4.5;
// Literature-constrained values, unlike the illustrative profile choices:
// Wegg & Gerhard 2013 orientation and Wegg et al. 2015 bar extent.
inline constexpr double bar_angle_rad=27.0*galactic_constants::radians_per_degree;
inline constexpr double bar_half_length_kpc=5.0;
// THE DISC'S EDGE. Minniti et al. (2011), A&A 527, A81: the stellar disc ends
// at R = 13.9 +- 0.5 kpc (red-clump counts). Beyond it every component breaks
// to a steeper exponential, as most spiral discs do (type II breaks, Pohlen &
// Trujillo 2006, A&A 454, 759); its outer scale length, half the thin disc's
// 2.6 kpc, is a MODEL CHOICE. The light thins into the dark with no rim and
// is gone well inside the 20 kpc volume.
inline constexpr double disc_edge_kpc=13.9,outer_scale_kpc=1.3;
inline double disc_edge(double radius) {
  return std::exp(-std::max(0.0,radius-disc_edge_kpc)*(1/outer_scale_kpc-1/2.6));
}
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

inline double arm_width_kpc(const ArmSegment& a,double radius) {
  // Reid 2019 section 3: dw/dR=42 pc/kpc, adopted from Reid et al. 2014.
  return std::max(model_choices::minimum_arm_width_kpc,a.width_kpc+0.042*(radius-a.radius_kpc));
}

inline double planar_arm_density(Vec3 p) {
  double sum=0;
  for(const auto& a:reid_segments) arm_light::for_each_hit(a,p,[&](const arm_light::Hit& h) {
    const double width=arm_width_kpc(a,h.radius);
    sum+=h.weight*std::exp(-0.5*(h.separation/width)*(h.separation/width));
  });
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
  double best=0;
  for(const auto& a:reid_segments) {
    if(arm_light::finite_segment(a)) continue;
    arm_light::for_each_hit(a,p,[&](const arm_light::Hit& h) {
      const double width=arm_width_kpc(a,h.radius);
      const double cutoff=h.radius>populations::arm_cutoff_kpc
        ?std::exp(-std::pow((h.radius-populations::arm_cutoff_kpc)/populations::arm_cutoff_scale_kpc,2)):1.0;
      best=std::max(best,h.weight*cutoff*std::exp(-0.5*(h.separation/width)*(h.separation/width)));
    });
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
// the amplitude, so the Sun's neighborhood keeps the measured fraction.
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
  const double taper=disc_edge(radius);
  return {thin*taper,thick*taper,arms*taper,bulge*taper,bar*taper};
}

inline StellarComponents stellar_components(Vec3 p,double) {
  return stellar_components(p,ArmPatterns{});
}

inline StellarComponents stellar_components(Vec3 p) {
  return stellar_components(p,arm_patterns(p));
}

// HII REGIONS: the pink knots along the arms. Reid et al. (2019) fit the arms
// to masers in high-mass star-forming regions, so the regions sit on the
// fitted arms (planar_arm_density, undrifted), over the young disc's radial
// profile (Robin 2003 young hole, Juric 2008 scale length) and a thin layer.
// A STATISTICAL POPULATION, not a catalogue: positions from a fixed seed
// (SplitMix64, 20261019); the count, sizes, layer and brightness are MODEL
// CHOICES of the scale of the giant complexes the WISE catalogue of Galactic
// HII regions lists (Anderson et al. 2014, ApJS 212, 1), not their places.
namespace hii {
inline constexpr unsigned count=700;
inline constexpr double min_kpc=3.0,max_kpc=14.5,layer_kpc=0.06;
inline constexpr double sigma_lo_kpc=0.05,sigma_hi_kpc=0.12,peak=1.2,spread_ln=0.8;
inline constexpr double cell_kpc=0.5,half_kpc=16.0;
struct Region {Vec3 c;double sigma,amplitude;};
struct Population {std::vector<Region> regions;std::vector<std::vector<uint32_t>> cells;int n=0;};
inline double next_uniform(uint64_t& s) {
  uint64_t z=(s+=0x9E3779B97F4A7C15ull);
  z=(z^(z>>30))*0xBF58476D1CE4E5B9ull;z=(z^(z>>27))*0x94D049BB133111EBull;z^=z>>31;
  return double(z>>11)*0x1.0p-53;
}
inline const Population& population() {
  static const Population pop=[] {
    Population p;uint64_t seed=20261019;
    const double peak_density=2.0;
    while(p.regions.size()<count) {
      const double r=min_kpc+(max_kpc-min_kpc)*std::sqrt(next_uniform(seed));
      const double phi=2*galactic_constants::pi*next_uniform(seed);
      const Vec3 c{r*std::cos(phi),r*std::sin(phi),0};
      const double profile=std::exp(-(r-min_kpc)/populations::thin_length_kpc)*populations::young_hole(r)
        /populations::young_hole(galactic_constants::solar_radius_kpc);
      const double accept=std::min(1.0,planar_arm_density(c)/peak_density)*std::min(1.0,profile)
        *model_choices::disc_edge(r);
      if(next_uniform(seed)>accept) continue;
      // Box-Muller for the layer and the log-normal brightness.
      const double u1=std::max(1e-12,next_uniform(seed)),u2=next_uniform(seed);
      const double g1=std::sqrt(-2*std::log(u1))*std::cos(2*galactic_constants::pi*u2);
      const double g2=std::sqrt(-2*std::log(u1))*std::sin(2*galactic_constants::pi*u2);
      const double sigma=sigma_lo_kpc+(sigma_hi_kpc-sigma_lo_kpc)*next_uniform(seed);
      p.regions.push_back({{c.x,c.y,layer_kpc*g1},sigma,peak*std::exp(spread_ln*g2-0.5*spread_ln*spread_ln)
        *std::exp((galactic_constants::solar_radius_kpc-r)/populations::thin_length_kpc)});
    }
    p.n=int(2*half_kpc/cell_kpc);
    p.cells.resize(size_t(p.n)*p.n);
    for(uint32_t i=0;i<p.regions.size();++i) {
      const auto& g=p.regions[i];const double reach=3*g.sigma;
      const int x0=std::max(0,int((g.c.x-reach+half_kpc)/cell_kpc)),x1=std::min(p.n-1,int((g.c.x+reach+half_kpc)/cell_kpc));
      const int y0=std::max(0,int((g.c.y-reach+half_kpc)/cell_kpc)),y1=std::min(p.n-1,int((g.c.y+reach+half_kpc)/cell_kpc));
      for(int y=y0;y<=y1;++y) for(int x=x0;x<=x1;++x) p.cells[size_t(y)*p.n+x].push_back(i);
    }
    return p;
  }();
  return pop;
}
// The regions' G emissivity at p (model units).
inline double light(Vec3 p) {
  if(std::abs(p.z)>0.6||std::abs(p.x)>=half_kpc||std::abs(p.y)>=half_kpc) return 0;
  const auto& pop=population();
  const int x=int((p.x+half_kpc)/cell_kpc),y=int((p.y+half_kpc)/cell_kpc);
  double sum=0;
  for(const uint32_t i:pop.cells[size_t(y)*pop.n+x]) {
    const auto& g=pop.regions[i];const Vec3 d=p-g.c;
    const double q=dot(d,d)/(g.sigma*g.sigma);
    if(q<9) sum+=g.amplitude*std::exp(-0.5*q);
  }
  return sum;
}
} // namespace hii

// The light in G, BP and RP, each population in its own color
// (stellar_populations.hpp, colors), and the dust: inside a delivered 3D dust
// map's coverage the map replaces DS2001 (dust_map.hpp) when `local_dust`.
inline Field literature(Vec3 p,bool local_dust) {
  const auto pattern=arm_patterns(p);
  const auto c=stellar_components(p,pattern);
  const double young=c.arms-c.thin*pattern.wave;
  const double disc=c.thin+c.thick+c.thin*pattern.wave;
  const double central=c.bulge+c.bar;
  const double nebulae=hii::light(p);
  using namespace colors;
  const double dust=local_dust?dust_map::blend(p,drimmel2001::dust(p)):drimmel2001::dust(p);
  return {disc+central+young+nebulae,
          disc_bp*disc+central_bp*central+young_bp*young+hii_bp*nebulae,
          disc_rp*disc+central_rp*central+young_rp*young+hii_rp*nebulae,dust};
}
inline Field literature(Vec3 p) {return literature(p,true);}

// The display's white: the disc's light at the Sun's radius seen face-on, a
// vertical column through its stars and large-scale dust (no HII region, no
// local dust map), per unit G, as an image of a galaxy is balanced on the
// average light of its disc. The column is integrated as the renderer
// integrates a ray (oracle_metrics.hpp): per step, light gained T j (1 -
// e^-tau) / tau and transmittance falling by e^-tau, each band with its
// extinction ratio to G.
inline std::array<double,3> display_white() {
  const double x=-galactic_constants::solar_radius_kpc;
  const double ratio[3]={1.0,model_choices::bp_to_g_extinction,model_choices::rp_to_g_extinction};
  double light[3]={0,0,0},transmittance[3]={1,1,1};
  constexpr double top=3.0,step=0.002;
  for(double z=top-step/2;z>-top;z-=step) {
    const Vec3 p{x,0,z};
    const auto pattern=arm_patterns(p);
    const auto c=stellar_components(p,pattern);
    const double young=c.arms-c.thin*pattern.wave,disc=c.thin+c.thick+c.thin*pattern.wave,central=c.bulge+c.bar;
    using namespace colors;
    const double j[3]={disc+central+young,disc_bp*disc+central_bp*central+young_bp*young,disc_rp*disc+central_rp*central+young_rp*young};
    const double kappa=drimmel2001::dust(p);
    for(int b=0;b<3;++b) {
      const double tau=kappa*ratio[b]*step;
      light[b]+=transmittance[b]*j[b]*step*(tau>1e-6?(1-std::exp(-tau))/tau:1-0.5*tau);
      transmittance[b]*=std::exp(-tau);
    }
  }
  return {1.0,light[1]/light[0],light[2]/light[0]};
}

} // namespace milky_way
