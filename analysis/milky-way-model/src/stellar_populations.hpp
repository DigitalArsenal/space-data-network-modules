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

// COLORS (0.3.0): each population's light in BP and RP per unit G, Vega
// fluxes (a color of 0 is a ratio of 1): BP/G = 10^(-0.4 (BP-G)), RP/G =
// 10^(0.4 (G-RP)), BP-G = (BP-RP) - (G-RP).
//  - the disc's old light: the local light is redder than the Sun, (V-I) =
//    0.82 (Flynn et al. 2006) against 0.70 (Ramirez et al. 2012, ApJ 752, 5),
//    and redder again without its M_V < -1 stars: BP-RP = 1.0, G-RP = 0.56
//    (a MODEL CHOICE at that color);
//  - the bulge and bar, red-giant light: the red clump's intrinsic
//    BP-RP = 1.23 (Ruiz-Dern et al. 2018, A&A 609, A116), G-RP = 0.64 on the
//    giant sequence (a MODEL CHOICE at that color);
//  - the young arm light, B stars: BP-RP = -0.15, G-RP = -0.08, a B5V on the
//    dwarf sequence (Pecaut & Mamajek 2013 table; a MODEL CHOICE of type);
//  - HII regions, emission lines: H-alpha (in RP and G) at 2.86 H-beta (case
//    B, Osterbrock & Ferland 2006) and [OIII] 4959/5007 with H-beta (in BP and
//    G). Each line adds to the narrow BP and RP bands more, per Vega unit,
//    than to the wide G band, which is why such regions are pink in color
//    images. The ratios below are a MODEL CHOICE of that kind.
// The display balances white on the disc's light at the Sun's radius seen
// face-on (display_white, literature_model.hpp), as an image of a galaxy is
// balanced on its average starlight. In the G band the young
// light is a tenth of the disc's face-on column (Flynn 2006: 2.3 of 24.4
// Lsun pc^-2), so the arms differ from the disc by a small shift of hue; the
// display stretches saturation by display_saturation about each pixel's
// luminance, as color composites of galaxies are stretched. A DISPLAY
// CHOICE, not a measurement: it changes no band's light.
namespace milky_way::colors {
inline double bp_per_g(double bp_rp,double g_rp) {return std::pow(10.0,-0.4*(bp_rp-g_rp));}
inline double rp_per_g(double g_rp) {return std::pow(10.0,0.4*g_rp);}
inline const double disc_bp=bp_per_g(1.0,0.56),disc_rp=rp_per_g(0.56);
inline const double central_bp=bp_per_g(1.23,0.64),central_rp=rp_per_g(0.64);
inline const double young_bp=bp_per_g(-0.15,-0.08),young_rp=rp_per_g(-0.08);
inline constexpr double hii_bp=1.3,hii_rp=2.6;
inline constexpr double display_saturation=1.8;
} // namespace milky_way::colors
