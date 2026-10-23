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
// The b/p bulge's axis ratio from above, 0.5, and its vertical scale height
// at x ~ 0, 180 pc: Bland-Hawthorn & Gerhard (2016), ARA&A 54, 529, section
// 4.2 (0.4 and 0.3 kpc in 0.3.0, which drew it a thick, round puff).
inline constexpr double bulge_x_kpc=1.0,bulge_y_kpc=0.5,bulge_z_kpc=0.18;
// THE NUCLEAR STELLAR DISC: Bland-Hawthorn & Gerhard (2016) section 4.1
// (Launhardt et al. 2002, A&A 384, 112): stellar mass (1.4 +- 0.6) x 10^9
// Msun, break radius ~90 pc, vertical scale height 45 pc; the density falls
// as R^-0.1 inside the break and R^-3.5 outside it (Launhardt et al. 2002).
// With the bar and bulge's mass-to-light ratio, its light is 1.4/18.8 of
// theirs (Portail et al. 2017: 1.88 x 10^10 Msun). It is the galaxy's bright,
// compact core. R is floored at 5 pc (the inner power law's divergence).
inline constexpr double nucleus_mass=0.14,nucleus_break_kpc=0.09,nucleus_height_kpc=0.045,nucleus_floor_kpc=0.005;
inline double nucleus_shape(Vec3 p) {
  const double r=std::max(nucleus_floor_kpc,std::hypot(p.x,p.y))/nucleus_break_kpc;
  return std::pow(r,r<1?-0.1:-3.5)*std::exp(-std::abs(p.z)/nucleus_height_kpc);
}
// Its integral over all space (unfloored): 2 pi R_b^2 (1/1.9 + 1/1.5) 2 h.
inline constexpr double nucleus_shape_integral=2*galactic_constants::pi*nucleus_break_kpc*nucleus_break_kpc
  *(1/1.9+1/1.5)*2*nucleus_height_kpc;
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
// The young light's share drawn as star complexes (complexes, below).
inline constexpr double young_clumped=0.5;
inline double disc_edge(double radius) {
  return std::exp(-std::max(0.0,radius-disc_edge_kpc)*(1/outer_scale_kpc-1/2.6));
}
// BP and RP (the statistical stars) and SDSS r, g and i (the light)
// extinction ratios to G: Wang & Chen (2019) Table 3 red-clump values
// (stellar_populations.hpp). Real passband extinction also depends on the
// source spectrum and the column; one constant ratio per band is used.
inline constexpr double bp_to_g_extinction=populations::bp_per_g_extinction;
inline constexpr double rp_to_g_extinction=populations::rp_per_g_extinction;
inline constexpr double channel_extinction[3]={sdss::r_per_big_g_extinction,
  sdss::g_per_big_g_extinction,sdss::i_per_big_g_extinction};
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
// Sagittarius-Carina, Perseus), as DS2001's four arms. The stellar arms'
// half width is DS2001's own, w*_K = c*_K R_a with c*_K = 143 pc/kpc (Table
// 3), the width B_K was fitted with: broad waves in the old light (1.1 kpc
// at R0), not the masers' narrow Reid widths (0.3.0, which drew the old light
// as thin concentric rings).
inline constexpr double stellar_arm_width_per_kpc=0.143;
inline double major_arm_wave(Vec3 p) {
  double best=0;
  for(const auto& a:reid_segments) {
    if(arm_light::finite_segment(a)) continue;
    arm_light::for_each_hit(a,p,[&](const arm_light::Hit& h) {
      const double width=stellar_arm_width_per_kpc*h.radius;
      const double cutoff=h.radius>populations::arm_cutoff_kpc
        ?std::exp(-std::pow((h.radius-populations::arm_cutoff_kpc)/populations::arm_cutoff_scale_kpc,2)):1.0;
      best=std::max(best,h.weight*cutoff*std::exp(-(h.separation/width)*(h.separation/width)));
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
  const double effective_z=bulge_z_kpc*appearance::bulge_height*(1+peanut_strength*std::min(std::abs(u),peanut_extent_kpc));
  const double ellipsoid=std::pow(std::pow(std::abs(u)/(bulge_x_kpc*appearance::bulge_size),boxiness)
      +std::pow(std::abs(v)/(bulge_y_kpc*appearance::bulge_size),boxiness)+std::pow(height/effective_z,boxiness),1/boxiness);
  return {bulge_emissivity*std::exp(-ellipsoid),
          bar_emissivity*std::exp(-std::abs(v)/bar_minor_kpc-height/bar_height_kpc)
            *(1-smoothstep(bar_taper_start_kpc,bar_half_length_kpc,std::abs(u)))};
}

inline StellarComponents stellar_components(Vec3 p,ArmPatterns pattern,double bar_bulge);
// Midpoint integrals over the cylinder R <= 5 kpc, |z| <= 3 kpc (20 pc in x
// and y, z on a signed-square axis dense at the plane), computed once. The
// bar and bulge light there is 1.88/1.29 of the disc's (Portail 2017); the
// nuclear disc's is model_choices::nucleus_mass of the bar and bulge's.
struct CentralScales {double bar_bulge,nucleus;};
inline const CentralScales& central_scales() {
  static const CentralScales scales=[] {
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
    const double bar_bulge=appearance::central_light*populations::bar_bulge_mass/populations::inner_disc_mass*disc/central;
    const double central_light=bar_bulge*central;
    return CentralScales{bar_bulge,model_choices::nucleus_mass/populations::bar_bulge_mass
      *central_light/model_choices::nucleus_shape_integral};
  }();
  return scales;
}
inline double bar_bulge_scale() {return central_scales().bar_bulge;}

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
  const double young=(1-young_clumped)*young_amplitude()*pattern.young*populations::young_hole(radius)/young_hole_sun
    *std::exp((galactic_constants::solar_radius_kpc-radius)/appearance::young_length_kpc
              -height/populations::h_bright_kpc);
  const double arms=thin*pattern.wave+young;
  // Wegg & Gerhard (2013), MNRAS 435,1874, doi:10.1093/mnras/stt1376:
  // boxy/peanut morphology and orientation ~27 degrees; Wegg, Gerhard &
  // Portail (2015), MNRAS 450,4050, doi:10.1093/mnras/stv745: long-bar
  // half-length 5.0 kpc (bulge_bar_shapes); the nuclear stellar disc
  // (nucleus_shape) is part of the bulge's light. With bar_bulge = 0 (the
  // scale's own integral) there is no central light at all.
  const auto shapes=bulge_bar_shapes(p);
  const double nucleus=bar_bulge>0?central_scales().nucleus*nucleus_shape(p):0.0;
  const double bulge=bar_bulge*shapes[0]+nucleus,bar=bar_bulge*shapes[1];
  // The global volume ends 24 kpc out and 6 kpc above and below the plane:
  // the light goes to zero inside it in every direction, by 23.5 kpc in R
  // and by 5.6 kpc in z, before its outermost texels (planes at 5.75 kpc,
  // beyond which sampling clamps), rather than stopping at its faces, which
  // the display drew as a box edge (a MODEL CHOICE of window; the face-on
  // light at 22 kpc is 2.7e-4 of its 8 kpc value, at 23 kpc 5e-5, measured
  // by OrbPro's milky-way-sdss-look E2E).
  const double taper=disc_edge(radius)*(1-smoothstep(22.0,23.5,radius))*(1-smoothstep(4.0,5.6,height));
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
// KNOTS: a statistical population of Gaussian light knots on the arms, from
// a fixed seed (SplitMix64): positions over [min, max] kpc accepted with the
// arms' planar density (at `drift_myr`'s shear) times a radial profile and the
// disc's edge, a Gaussian layer in z, sizes uniform in [sigma_lo, sigma_hi];
// a 0.5 kpc cell grid finds the knots near a point.
namespace knots {
struct Knot {Vec3 c;double sigma,amplitude;};
struct Population {std::vector<Knot> knots;std::vector<std::vector<uint32_t>> cells;int n=0;};
inline constexpr double cell_kpc=0.5,half_kpc=16.0;
inline double next_uniform(uint64_t& s) {
  uint64_t z=(s+=0x9E3779B97F4A7C15ull);
  z=(z^(z>>30))*0xBF58476D1CE4E5B9ull;z=(z^(z>>27))*0x94D049BB133111EBull;z^=z>>31;
  return double(z>>11)*0x1.0p-53;
}
// min_density: the arms' planar density a knot needs: 0.15, within 1.95 of
// the arm's Reid (2019) Gaussian width of its ridge (0.4.0: none, which
// scattered knots between the arms). Tighter cuts concentrate the knots'
// light on the arm tangents seen from the Sun beyond what Gaia's all-sky
// map shows: the oracle's density log r was 0.894 at 0.5 (1.2 widths) and
// 0.911 at 0.25, against 0.922 at 0.15 (0.3.0: 0.909; measured 2026-10-22).
// cluster_sigma (0.5): candidates also accepted with the young multi-scale
// structure's modulation at that sigma (structure.hpp) over exp(1.5 sigma)
// (capped at 1), so the knots cluster where the flocculent field is bright:
// star formation is hierarchical, the complexes the largest level of the same
// turbulent structure (Elmegreen & Efremov 1996, ApJ 466, 802; Elmegreen et
// al. 2003 section 6). sized_by_light: a knot's sigma is sigma_lo sqrt(L/L_min)
// (constant mean surface brightness, a MODEL CHOICE), capped at sigma_hi.
struct Spec {unsigned count;uint64_t seed;double min_kpc,max_kpc,layer_kpc,sigma_lo_kpc,sigma_hi_kpc,drift_myr,min_density;
  double cluster_sigma=0;bool sized_by_light=false;};
// `brightness(r, seed)`: a knot's amplitude at radius r, drawing from `seed`.
template<class Brightness> Population build(const Spec& spec,Brightness brightness) {
  Population p;uint64_t seed=spec.seed;
  const double peak_density=2.0;
  while(p.knots.size()<spec.count) {
    const double r=spec.min_kpc+(spec.max_kpc-spec.min_kpc)*std::sqrt(next_uniform(seed));
    const double phi=2*galactic_constants::pi*next_uniform(seed);
    const Vec3 c{r*std::cos(phi),r*std::sin(phi),0};
    const double profile=std::exp(-(r-spec.min_kpc)/appearance::young_length_kpc)*populations::young_hole(r)
      /populations::young_hole(galactic_constants::solar_radius_kpc);
    const Vec3 arm=spec.drift_myr>0?undrifted(c,spec.drift_myr):c;
    const double density=planar_arm_density(arm);
    const double accept=(density<spec.min_density?0.0:std::min(1.0,density/peak_density))*std::min(1.0,profile)
      *model_choices::disc_edge(r);
    const double clustered=accept>0&&spec.cluster_sigma>0
      ?std::min(1.0,structure::modulation(c.x,c.y,spec.cluster_sigma)/std::exp(1.5*spec.cluster_sigma)):1.0;
    if(next_uniform(seed)>accept*clustered) continue;
    // Box-Muller for the layer (and a normal deviate for the brightness).
    const double u1=std::max(1e-12,next_uniform(seed)),u2=next_uniform(seed);
    const double g1=std::sqrt(-2*std::log(u1))*std::cos(2*galactic_constants::pi*u2);
    const double g2=std::sqrt(-2*std::log(u1))*std::sin(2*galactic_constants::pi*u2);
    double sigma=spec.sigma_lo_kpc+(spec.sigma_hi_kpc-spec.sigma_lo_kpc)*next_uniform(seed);
    const double amplitude=brightness(r,g2,seed);
    if(spec.sized_by_light) sigma=std::min(spec.sigma_hi_kpc,spec.sigma_lo_kpc*std::sqrt(amplitude));
    p.knots.push_back({{c.x,c.y,spec.layer_kpc*g1},sigma,amplitude});
  }
  p.n=int(2*half_kpc/cell_kpc);
  p.cells.resize(size_t(p.n)*p.n);
  for(uint32_t i=0;i<p.knots.size();++i) {
    const auto& g=p.knots[i];const double reach=3*g.sigma;
    const int x0=std::max(0,int((g.c.x-reach+half_kpc)/cell_kpc)),x1=std::min(p.n-1,int((g.c.x+reach+half_kpc)/cell_kpc));
    const int y0=std::max(0,int((g.c.y-reach+half_kpc)/cell_kpc)),y1=std::min(p.n-1,int((g.c.y+reach+half_kpc)/cell_kpc));
    for(int y=y0;y<=y1;++y) for(int x=x0;x<=x1;++x) p.cells[size_t(y)*p.n+x].push_back(i);
  }
  return p;
}
// The knots' summed emissivity at p (each A exp(-|p-c|^2 / 2 sigma^2), to 3 sigma).
inline double light(const Population& pop,Vec3 p) {
  if(std::abs(p.z)>0.8||std::abs(p.x)>=half_kpc||std::abs(p.y)>=half_kpc) return 0;
  const int x=int((p.x+half_kpc)/cell_kpc),y=int((p.y+half_kpc)/cell_kpc);
  double sum=0;
  for(const uint32_t i:pop.cells[size_t(y)*pop.n+x]) {
    const auto& g=pop.knots[i];const Vec3 d=p-g.c;
    const double q=dot(d,d)/(g.sigma*g.sigma);
    if(q<9) sum+=g.amplitude*std::exp(-0.5*q);
  }
  return sum;
}
} // namespace knots

// HII REGIONS: the knots of nebular light along the arms. Reid et al. (2019)
// fit the arms to masers in high-mass star-forming regions, so the regions
// sit on the fitted arms (unsheared), over the young disc's radial profile
// (Robin 2003 young hole, Juric 2008 scale length) and a thin layer. The
// count, sizes, layer and brightness are MODEL CHOICES of the scale of the
// giant complexes the WISE catalogue of Galactic HII regions lists (Anderson
// et al. 2014, ApJS 212, 1), not their places; seed 20261019.
namespace hii {
inline constexpr double peak=1.2,spread_ln=0.8;
inline const knots::Population& population() {
  static const knots::Population pop=knots::build({700,20261019,3.0,14.5,0.06,0.05,0.12,0,0.15},
    [](double r,double g,uint64_t&) {
      return peak*std::exp(spread_ln*g-0.5*spread_ln*spread_ln)
        *std::exp((galactic_constants::solar_radius_kpc-r)/appearance::young_length_kpc);
    });
  return pop;
}
// The regions' G emissivity at p (model units).
inline double light(Vec3 p) {return knots::light(population(),p);}
} // namespace hii

// STAR COMPLEXES: the young population's clumps. Most young massive stars
// are born and stay, while young, in clusters and OB associations (Gies
// 1987, ApJS 64, 545: about 70 % of O stars), and these are grouped in star
// complexes along the arms (Efremov 1995, ARA&A 33, 19: ~600 pc across). A
// share `clumped` of the young (M_V < -1) light is drawn as complexes on
// the young arms (the J-band drift, as the smooth young light), the rest
// smooth; the total is the smooth model's. Their luminosities follow the HII
// regions' luminosity function in spirals, dN/dL ~ L^-2 (Kennicutt, Edgar &
// Hodge 1989, ApJ 337, 761), over two decades. The share (0.5, below the O
// stars' 0.7 as the population includes dispersing B stars), count, sizes
// and layer are MODEL CHOICES; seed 20261022.
namespace complexes {
inline constexpr double clumped=model_choices::young_clumped,luminosity_range=100;
inline constexpr unsigned count=1500;
// OB associations "range from tens to several hundreds of parsecs" (Wright
// et al. 2023, Protostars and Planets VII, arXiv:2203.10007, section 2): 0.5
// sizes them by their light (knots::Spec sized_by_light), sigma 30 pc for the
// faintest to 300 pc for the brightest over the luminosity function's two
// decades, and clusters them with the young structure (cluster_sigma, the
// young light's sigma). 0.4.1: sigma 30-80 pc uniform, placed by the arms'
// density alone, which read as scattered dots of one size.
inline constexpr double sigma_lo_kpc=0.03,sigma_hi_kpc=0.30,layer_kpc=0.06;
inline const knots::Population& population();
inline double light(Vec3 p) {return knots::light(population(),p);}
} // namespace complexes

// The star complexes (namespace complexes): their total light is the
// clumped share of the smooth model's young light, integrated over the disc
// (columns 2 h_bright of the exponential layer, 0.1 kpc cells).
inline const knots::Population& complexes::population() {
  static const knots::Population pop=[] {
    static const double hole_sun=populations::young_hole(galactic_constants::solar_radius_kpc);
    double young_total=0;
    constexpr double cell=0.1;
    for(double y=-knots::half_kpc+cell/2;y<knots::half_kpc;y+=cell) for(double x=-knots::half_kpc+cell/2;x<knots::half_kpc;x+=cell) {
      const double r=std::hypot(x,y);
      young_total+=young_amplitude()*young_pattern({x,y,0})*populations::young_hole(r)/hole_sun
        *std::exp((galactic_constants::solar_radius_kpc-r)/appearance::young_length_kpc)*model_choices::disc_edge(r)
        *2*populations::h_bright_kpc*cell*cell;
    }
    // dN/dL ~ L^-2 on [1, luminosity_range]: L = 1 / (1 - u (1 - 1/range)).
    double luminosity_sum=0;
    auto pop=knots::build({count,20261022,2.0,15.0,layer_kpc,sigma_lo_kpc,sigma_hi_kpc,populations::drift_age_j_myr,0.15,
        structure::young_sigma,true},
      [&](double,double,uint64_t& seed) {
        const double l=1/(1-knots::next_uniform(seed)*(1-1/luminosity_range));
        luminosity_sum+=l;
        return l;
      });
    const double scale=clumped*young_total/luminosity_sum;
    for(auto& k:pop.knots) k.amplitude*=scale/(std::pow(2*galactic_constants::pi,1.5)*k.sigma*k.sigma*k.sigma);
    return pop;
  }();
  return pop;
}

// The light in SDSS r, g and i (channels in that order: the central band
// first, as the renderer's luminance and the arm ridges use it, then the
// blue and the red), each population in its own color
// (stellar_populations.hpp, colors), and the dust's G optical depth: inside a
// delivered 3D dust map's coverage the map replaces DS2001 (dust_map.hpp)
// when `local_dust`.
inline Field literature(Vec3 p,bool local_dust) {
  const auto pattern=arm_patterns(p);
  const auto c=stellar_components(p,pattern);
  // The young light: its smooth share, modulated by the multi-scale structure
  // (structure.hpp), and its star complexes.
  const double young=(c.arms-c.thin*pattern.wave)*structure::modulation(p.x,p.y,structure::young_sigma)+complexes::light(p);
  const double disc=c.thin+c.thick+c.thin*pattern.wave;
  const double central=c.bulge+c.bar;
  const double nebulae=hii::light(p);
  using namespace colors;
  // DS2001's dust, modulated by the same structure (gas and star formation
  // share their clouds); a delivered 3D dust map is data and stays as it is.
  const double modelled=drimmel2001::dust(p)*structure::modulation(p.x,p.y,structure::dust_sigma*structure::away_from_sun(p),true);
  const double dust=local_dust?dust_map::blend(p,modelled):modelled;
  return {disc_bands.r*disc+central_bands.r*central+young_bands.r*young+hii_bands.r*nebulae,
          disc_bands.g*disc+central_bands.g*central+young_bands.g*young+hii_bands.g*nebulae,
          disc_bands.i*disc+central_bands.i*central+young_bands.i*young+hii_bands.i*nebulae,dust};
}
inline Field literature(Vec3 p) {return literature(p,true);}

// The G emissivity of the populations at p (the light before its colors).
inline double literature_g(Vec3 p) {
  const auto pattern=arm_patterns(p);
  const auto c=stellar_components(p,pattern);
  const double young=c.arms-c.thin*pattern.wave;
  return c.thin+c.thick+c.thin*pattern.wave+young*structure::modulation(p.x,p.y,structure::young_sigma)
    +c.bulge+c.bar+hii::light(p)+complexes::light(p);
}

// The Gaia G light of a field's r, g, i channels (oracle_metrics.hpp).
inline double gaia_g(const Field& f) {return sdss::gaia_g(std::max(0.0,f.g),std::max(0.0,f.b));}

} // namespace milky_way
