#pragma once
#include "reid_arms.hpp"

// Published constants for the stellar light: its vertical structure, the
// spiral-arm light and the absolute radiance of one model unit. Every value
// below is quoted from the cited table or section; the derived values are
// arithmetic on those numbers only. None is fitted to the Gaia oracle maps.
namespace milky_way::populations {

// Flynn, Holmberg, Portinari, Fuchs & Jahreiss (2006), MNRAS 372, 1149,
// doi:10.1111/j.1365-2966.2006.10911.x. Table 4 (Tuorla, V band): mid-plane
// luminosity density and column of the thin and thick discs; section 3.1:
// stars brighter than M_V=-1 (bright main sequence and giants) give 20% of the
// volume luminosity and 2.3 Lsun pc^-2 of the column. The Juric et al. (2008)
// shapes describe star COUNTS, which faint dwarfs dominate; the light is
// thinner (Sigma/rho = 435 pc against 729 pc for the count-weighted discs).
inline constexpr double rho_v_thin=0.054,rho_v_thick=0.002,rho_v_total=0.056; // Lsun,V pc^-3
inline constexpr double sigma_v_thin=19.92,sigma_v_thick=4.43;                 // Lsun,V pc^-2
inline constexpr double bright_volume_fraction=0.20,bright_column=2.3;         // M_V < -1
inline constexpr double rho_bright=bright_volume_fraction*rho_v_total;
inline constexpr double rho_old_thin=rho_v_thin-rho_bright;
// Exponential scale heights that conserve each component's column, h=Sigma/(2 rho).
inline constexpr double h_old_thin_kpc=(sigma_v_thin-bright_column)/(2*rho_old_thin)/1000;
inline constexpr double h_bright_kpc=bright_column/(2*rho_bright)/1000;
inline constexpr double h_thick_kpc=sigma_v_thick/(2*rho_v_thick)/1000;
// The model's emissivity unit is the local total mid-plane luminosity density.
inline constexpr double old_thin_midplane=rho_old_thin/rho_v_total;
inline constexpr double thick_midplane=rho_v_thick/rho_v_total;
inline constexpr double bright_at_sun=rho_bright/rho_v_total;
// Juric et al. (2008), ApJ 673, 864: radial scale lengths L1=2.6, L2=3.6 kpc.
inline constexpr double thin_length_kpc=2.6,thick_length_kpc=3.6;

// Drimmel & Spergel (2001), ApJ 556, 181, Table 3 (stellar parameters) and
// section 3.2.1: stellar arms of amplitude B_b on the disc, a sheared copy of
// the dust spirals drifted by phi = V_o tau (1/r - 1/R_C) in the direction of
// rotation, with g(R_a) the dust arms' cut-off (Table 2: r_m=6.71, r_a=2.07
// kpc, their R_sun=8 kpc frame). Section 6 takes Omega_o=25 km/s/kpc at
// R_sun=8 kpc, so V_o=200 km/s. B_K is the K amplitude, the band that traces
// the stellar mass; Elmegreen et al. (2011), ApJ 737, 32, section 4.2, find
// arm-interarm contrasts the same in B, I and 3.6 um (0.93+-0.32,
// 0.81+-0.49, 0.99+-0.46 mag), "intrinsically strong mass perturbations", so
// B_K applies to the G, BP and RP light alike. DS2001 fixed the arms' scale
// height to the dust's 80 pc and note (section 6) that their weaker arms "may
// be due to their scale height being underestimated relative to that of the
// disk"; here the arm light keeps the disc light's vertical profile, so the
// fitted in-plane amplitude is also the face-on one.
inline constexpr double arm_amplitude_k=1.28;
inline constexpr double drift_age_k_myr=17.6,drift_age_j_myr=5.5;
inline constexpr double corotation_kpc=6.66*galactic_constants::solar_radius_kpc/8;
inline constexpr double circular_speed_km_s=200;
inline constexpr double km_s_myr_to_kpc=1.0227121650537077e-3;
inline constexpr double arm_cutoff_kpc=6.71*galactic_constants::solar_radius_kpc/8;
inline constexpr double arm_cutoff_scale_kpc=2.07*galactic_constants::solar_radius_kpc/8;

// The bright young population (Flynn's M_V<-1 stars) is born in the arms.
// Querejeta et al. (2024), A&A 687, A293, arXiv:2405.05364: across 28 PHANGS
// spirals the star-formation-rate arm/interarm contrast "typically reaches a
// factor of ~2-3"; its interarm floor is 1/2.5 of the arm crest. The young
// arms take Reid et al. (2019) Table 2 widths and the J-band drift (tau_J),
// the bluest band DS2001 fitted.
inline constexpr double young_interarm_floor=1/2.5;

// Robin, Reyle, Derriere & Picaud (2003), A&A 409, 523, Table 1 and section
// 3.4: the thin disc has "a noticeable hole ... very common in barred
// galaxies": rho ~ exp(-(0.5^2+a^2/h+^2)^1/2) - exp(-(0.5^2+a^2/h-^2)^1/2),
// h+=2.53, h-=1.32 kpc (ages > 0.15 Gyr); the young disc (<= 0.15 Gyr)
// exp(-(a/h+)^2) - exp(-(a/h-)^2), h+=5.0, h-=3.0 kpc. Only the hole factor
// (the bracket over its first term) is applied, normalized at R0, so the
// Juric/Flynn local values are unchanged.
inline constexpr double hole_old_plus_kpc=2.53,hole_old_minus_kpc=1.32;
inline constexpr double hole_young_plus_kpc=5.0,hole_young_minus_kpc=3.0;
inline double old_hole(double r) {
  const double plus=std::sqrt(0.25+r*r/(hole_old_plus_kpc*hole_old_plus_kpc));
  const double minus=std::sqrt(0.25+r*r/(hole_old_minus_kpc*hole_old_minus_kpc));
  return -std::expm1(plus-minus);
}
inline double young_hole(double r) {
  return -std::expm1(r*r*(1/(hole_young_plus_kpc*hole_young_plus_kpc)-1/(hole_young_minus_kpc*hole_young_minus_kpc)));
}

// Portail, Gerhard, Wegg & Ness (2017), MNRAS 465, 1621, abstract: stellar
// mass of the long bar and bulge 1.88e10 Msun, "larger than the mass of disk in
// the bar region, M_inner disk = 1.29e10 Msun". With one mass-to-light ratio
// for these old populations, the bar and bulge light is 1.88/1.29 of the disc
// light inside the bar's 5.0 kpc half-length (Wegg et al. 2015). The bulge
// and bar shapes keep their illustrative profiles; only their sum is scaled.
inline constexpr double bar_bulge_mass=1.88,inner_disc_mass=1.29,bar_region_kpc=5.0;

// Wang & Chen (2019), ApJ 877, 116, Table 3 (red-clump stars): A_G/A_V=0.789,
// A_BP/A_V=1.002, A_RP/A_V=0.589, so A_BP/A_G and A_RP/A_G below.
inline constexpr double a_g_per_a_v=0.789,a_bp_per_a_v=1.002,a_rp_per_a_v=0.589;
inline constexpr double bp_per_g_extinction=a_bp_per_a_v/a_g_per_a_v;
inline constexpr double rp_per_g_extinction=a_rp_per_a_v/a_g_per_a_v;

// Absolute radiance of one model unit (emissivity per kpc times kpc). One
// unit is the local total mid-plane luminosity density through 1 kpc:
// 0.056 Lsun,V pc^-3 x 1000 pc = 56 Lsun,V pc^-2 (Flynn 2006 Table 4). The
// surface brightness of I Lsun pc^-2 is mu = M_sun + 21.572 - 2.5 log10 I.
// Willmer (2018), ApJS 236, 47, Table 3: M_V,sun = 4.81 (Vega). G - V of the
// local light from Flynn's (V-I)_rho = 0.82 with the Gaia EDR3
// Johnson-Cousins relation (EDR3 documentation section 5.5.1, Table 5.7;
// Riello et al. 2021, A&A 649, A3): G-V = -0.01597 - 0.02809x - 0.2483x^2
// + 0.03656x^3 - 0.002939x^4 for x=V-I_C, valid for -0.4 < x < 5.
inline constexpr double v_minus_i_local=0.82;
inline constexpr double sun_absolute_v=4.81;
inline constexpr double unit_column_lsun_v_pc2=rho_v_total*1000;
inline double g_minus_v_local() {
  const double x=v_minus_i_local;
  return -0.01597-0.02809*x-0.2483*x*x+0.03656*x*x*x-0.002939*x*x*x*x;
}
inline double unit_surface_brightness_v() {return sun_absolute_v+21.572-2.5*std::log10(unit_column_lsun_v_pc2);}
inline double unit_surface_brightness_g() {return unit_surface_brightness_v()+g_minus_v_local();}

} // namespace milky_way::populations

// APPEARANCE: the free parameters of the model's look, the ones no cited
// measurement of the Galaxy fixes. FITTED TO SDSS MW ANALOGS (Licquia 2015):
// see the table's provenance below. A bake may override them (the fit's own
// trials, model_api.hpp bake); the values here are the fit's.
namespace milky_way::appearance {
// FITTED TO SDSS MW ANALOGS (Licquia 2015) -- pending (0.3.0 values).
inline double young_length_kpc=2.6;  // the young (M_V < -1) light's radial scale length
inline double central_light=1.0;     // the bar, bulge and nuclear disc's light, x Portail 2017's
inline double bulge_size=1.0;        // the b/p bulge's in-plane extent, x (1.0, 0.5) kpc
inline double bulge_height=1.0;      // its scale height, x Bland-Hawthorn & Gerhard 2016's 180 pc
} // namespace milky_way::appearance

// SDSS g, r, i (0.4.0). The light is drawn in the SDSS bands, as SDSS gri
// composites of galaxies are made (Lupton et al. 2004, PASP 116, 133), each
// population's per unit G light from its Gaia color through the Gaia EDR3 -
// SDSS12 relations of Riello et al. (2021), A&A 649, A3, Table C.2 (one
// family, all in g-i):
//   BP-RP = 0.3971 + 0.777 y - 0.04164 y^2 + 0.008237 y^3   (y = g-i,
//           -0.5 < y < 3.5),
//   G-g   = -0.1064 - 0.4964 y - 0.09339 y^2 + 0.004444 y^3 (-1 < y < 9),
//   G-r   = -0.01664 + 0.2662 z - 0.649 z^2 + 0.08227 z^3   (z = r-i,
//           -0.5 < z < 2),
// solved for y from BP-RP, then z from G-i = (G-g) + y = (G-r) + z. G is
// Vega, g, r and i are SDSS (AB); one unit of a band's emissivity is the
// light of one G unit of zero G-band color term, so each band's surface
// brightness is the G unit's mu_G - 2.5 log10(I_band).
// The populations' colors, BP-RP:
//  - the disc's old light: the local light is redder than the Sun, (V-I) =
//    0.82 (Flynn et al. 2006) against 0.70 (Ramirez et al. 2012, ApJ 752, 5),
//    and redder again without its M_V < -1 stars: BP-RP = 1.0 (a MODEL
//    CHOICE at that color); g-r = 0.58;
//  - the bulge and bar, red-giant light: the red clump's intrinsic
//    BP-RP = 1.23 (Ruiz-Dern et al. 2018, A&A 609, A116); g-r = 0.78;
//  - the young arm light, B stars: BP-RP = -0.15, a B5V on the dwarf
//    sequence (Pecaut & Mamajek 2013 table; a MODEL CHOICE of type). Its
//    g-i = -0.68 lies 0.18 mag below the fit's -0.5 bound; the g-r it gives,
//    -0.36, is within 0.06 of the table's own B5V g-r = -0.413 (Mamajek,
//    version 2022.04.16, from Covey et al. 2007);
//  - HII regions: their young stars' light plus the nebular lines. A giant
//    HII region's H-alpha equivalent width of ~1000 A falls in r (FWHM
//    1400 A), [OIII] 4959/5007 with H-beta, ~500 A together, in g; none of
//    note in i; all of them in G (FWHM ~4400 A). The equivalent widths are a
//    MODEL CHOICE of that scale: g, r, i are the young light's times
//    (1 + 500/1400, 1 + 1000/1400, 1) per (1 + 1500/4400) of G.
// No white balance and no saturation stretch: the bands are AB fluxes and
// the display maps them as Lupton et al. (2004) do (display_asinh).
namespace milky_way::sdss {
struct Bands {double g,r,i;};
// The root of f on [lo, hi] (f(lo) and f(hi) of opposite signs), bisected.
template<class F> double root(F f,double lo,double hi) {
  const bool rising=f(hi)>f(lo);
  for(int k=0;k<80;++k) {const double m=0.5*(lo+hi);((f(m)<0)==rising?lo:hi)=m;}
  return 0.5*(lo+hi);
}
inline double bp_rp_of_g_i(double y) {return 0.3971+0.777*y-0.04164*y*y+0.008237*y*y*y;}
inline double g_minus_g_of_g_i(double y) {return -0.1064-0.4964*y-0.09339*y*y+0.004444*y*y*y;}
inline double g_minus_r_of_r_i(double z) {return -0.01664+0.2662*z-0.649*z*z+0.08227*z*z*z;}
// Light in g, r and i per unit G light of Gaia color BP-RP.
inline Bands per_g(double bp_rp) {
  const double y=root([&](double v){return bp_rp_of_g_i(v)-bp_rp;},-1.5,3.5);
  const double big_g_minus_g=g_minus_g_of_g_i(y),big_g_minus_i=big_g_minus_g+y;
  const double z=root([&](double v){return big_g_minus_i-v-g_minus_r_of_r_i(v);},-1.0,2.0);
  const double big_g_minus_r=big_g_minus_i-z;
  return {std::pow(10.0,0.4*big_g_minus_g),std::pow(10.0,0.4*big_g_minus_r),std::pow(10.0,0.4*big_g_minus_i)};
}
// The Gaia G light of g and i light (the G-g relation above): what the Gaia
// all-sky maps are compared with (oracle_metrics.hpp).
inline double gaia_g(double g,double i) {
  if(!(g>0)||!(i>0)) return std::max(0.0,g);
  const double y=std::clamp(-2.5*std::log10(g/i),-1.0,3.5);
  return g*std::pow(10.0,-0.4*g_minus_g_of_g_i(y));
}
// Wang & Chen (2019), ApJ 877, 116, Table 3: A_g/A_V=1.205, A_r/A_V=0.848,
// A_i/A_V=0.630 (and A_G/A_V=0.789); the model's dust carries A_G.
inline constexpr double a_g_per_a_v=1.205,a_r_per_a_v=0.848,a_i_per_a_v=0.630;
inline constexpr double g_per_big_g_extinction=a_g_per_a_v/populations::a_g_per_a_v;
inline constexpr double r_per_big_g_extinction=a_r_per_a_v/populations::a_g_per_a_v;
inline constexpr double i_per_big_g_extinction=a_i_per_a_v/populations::a_g_per_a_v;
} // namespace milky_way::sdss

namespace milky_way::colors {
inline const sdss::Bands disc_bands=sdss::per_g(1.0),central_bands=sdss::per_g(1.23),young_bands=sdss::per_g(-0.15);
inline constexpr double hii_g_ew_a=500,hii_r_ew_a=1000,g_fwhm_a=1400,r_fwhm_a=1400,big_g_fwhm_a=4400;
inline const sdss::Bands hii_bands=[] {
  const double big_g=1+(hii_g_ew_a+hii_r_ew_a)/big_g_fwhm_a;
  return sdss::Bands{young_bands.g*(1+hii_g_ew_a/g_fwhm_a)/big_g,young_bands.r*(1+hii_r_ew_a/r_fwhm_a)/big_g,young_bands.i/big_g};
}();
} // namespace milky_way::colors

// THE DISPLAY (not a measurement: it changes no band's light). The r, g and
// i light is drawn as the SDSS ImgCutout service draws its g-r-i JPEGs: the
// stretch of Lupton, Blanton, Fekete et al. (2004), PASP 116, 133, section
// 2, on the bands in SDSS counts per 0.396 arcsec pixel: with
// I = (i + w_r r + w_g g) / 3, each band x is drawn as x F(I) / I,
// F(I) = asinh(alpha Q I) / Q, i red, r green, g blue; a pixel whose largest
// primary passes 1 scaled back to 1 (its color kept); its saturation s about
// the mean of its primaries, each kept in [0, 1]; then raised to gamma.
// Lupton et al.'s own SDSS composite (Fig. 1) takes Q = 8, alpha = 0.02,
// w = 1, s = 1, gamma = 1; the ImgCutout service adds a transfer function
// and a gamma (SDSS DR17 "JPEG Images on SkyServer", FITS2JPEG).
// FITTED TO SDSS MW ANALOGS (Licquia 2015): the DR17 g, r, i frames of the
// six analogs (runs 1045, 3631, 3650, 3813, 5194, 8062), resampled north up,
// drawn through this stretch and fitted (least squares on the RGB of all
// pixels within 2.5 Petrosian R90, Nelder-Mead) to the service's JPEGs of the
// same fields, four analogs trained (objIDs ...975369, ...011075, ...225872,
// ...174698), two held out (...166321 face-on, ...455304 edge-on):
// w_g = 0.4854, w_r = 0.8759, alpha = 0.01626, Q = 7.297, s = 0.3822,
// gamma = 1.0503; rms of full scale 0.0275 trained, 0.0229 and 0.0209 held
// out (0.054 with Lupton et al.'s own parameters). The service's colors are
// far less saturated than the bands' ratios. One count is NMGY nanomaggies,
// the frames' calibration factor, medians 0.00371 (g), 0.00502 (r) and
// 0.00641 (i) over those frames.
namespace milky_way::display {
inline constexpr double q=7.297,alpha_per_count=0.01626,gamma=1.0503,saturation=0.3822,pixel_arcsec=0.396;
inline constexpr double weights[3]={0.8759,0.4854,1.0};                     // r, g, i
inline constexpr double nanomaggies_per_count[3]={0.00502,0.00371,0.00641}; // r, g, i
inline constexpr const char* basis="SDSS DR17 ImgCutout g-r-i JPEG transfer, fitted to SDSS MW analogs (Licquia 2015): Lupton et al. 2004 (PASP 116, 133) asinh stretch on SDSS counts per 0.396 arcsec pixel, saturation about the mean, gamma; fitted on four analogs' frames against their JPEGs, two held out: w_g 0.4854, w_r 0.8759, alpha 0.01626 per count, Q 7.297, saturation 0.3822, gamma 1.0503 (rms 0.0275 trained, 0.0229/0.0209 held out); NMGY medians r 0.00502, g 0.00371, i 0.00641";
// SDSS counts per pixel (band-weighted) in one band unit of r, g and i light.
inline std::array<double,3> counts_per_unit(double unit_mag_arcsec2) {
  const double nanomaggies=std::pow(10.0,-0.4*(unit_mag_arcsec2-22.5))*pixel_arcsec*pixel_arcsec;
  return {weights[0]*nanomaggies/nanomaggies_per_count[0],weights[1]*nanomaggies/nanomaggies_per_count[1],
          weights[2]*nanomaggies/nanomaggies_per_count[2]};
}
} // namespace milky_way::display
