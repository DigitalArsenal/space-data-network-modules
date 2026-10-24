#pragma once
#include "stellar_populations.hpp"
#include <array>
#include <cmath>

// TRUE EYE COLOR (0.5): the displayed color is each population's spectrum
// seen through the CIE 1931 2-degree color-matching functions, as XYZ, which
// the renderer turns into sRGB (IEC 61966-2-1, D65) with the asinh stretch on
// the luminance Y and the chromaticity kept. The SDSS g, r, i bands stay the
// light of every measured check (g-r, M_r, Licquia 2015, the analogs and the
// SDSS transfer); `display_basis` = 1 bakes X, Y, Z instead, for the eye.
// The SDSS gri composite is a false-color convention: H-alpha falls in r,
// which it draws green.
//
// The spectra:
//  - each stellar population (colors: disc, central, young) a Planck
//    spectrum at the temperature that gives its SDSS g-r (AB, at the bands'
//    effective wavelengths 468.6 and 616.5 nm, Fukugita et al. 1996, AJ 111,
//    1748), scaled to its r light: the populations' integrated spectra stood
//    for by their color temperatures (a MODEL CHOICE; the module carries no
//    population synthesis SEDs);
//  - HII regions (hii::light, the nebulae; their stars are the complexes):
//    the nebular emission lines alone (the nebular continuum left out), per
//    unit G light carrying the young continuum's energy per unit G over
//    330-1050 nm (G's passband taken as flat there, an approximation);
//    Case B recombination at 10^4 K for the Balmer lines, H-alpha : H-beta :
//    H-gamma : H-delta = 2.86 : 1 : 0.468 : 0.259 (Osterbrock & Ferland 2006,
//    Astrophysics of Gaseous Nebulae and AGN, 2nd ed., Table 4.4);
//    [OIII] 5007 / H-beta = 1 and [NII] 6584 / H-alpha = 0.35 (a MODEL CHOICE
//    on the star-forming side of Kauffmann et al. 2003, MNRAS 346, 1055,
//    eq. 1), the doublets' weaker lines at a third (Storey & Zeippen 2000,
//    MNRAS 312, 813); reddened by the regions' own dust (0.5.1, below).
// The color-matching functions: Wyman, Sloan & Shirley (2013), JCGT 2(2), 1,
// the multi-lobe piecewise-Gaussian fit to CIE 1931 2-degree.
namespace milky_way::eye {
// The bake's display basis: 0 SDSS r, g, i (the default, every check's), 1
// CIE X, Y, Z for the eye (`display_basis`).
inline double basis=0;
inline bool on() {return basis>=0.5;}
struct XYZ {double x,y,z;};
inline double lobe(double l,double mu,double s1,double s2) {
  const double t=(l-mu)/(l<mu?s1:s2);
  return std::exp(-0.5*t*t);
}
inline XYZ cmf(double l) {
  return {1.056*lobe(l,599.8,37.9,31.0)+0.362*lobe(l,442.0,16.0,26.7)-0.065*lobe(l,501.1,20.4,26.2),
          0.821*lobe(l,568.8,46.9,40.5)+0.286*lobe(l,530.9,16.3,31.1),
          1.217*lobe(l,437.0,11.8,36.0)+0.681*lobe(l,459.0,26.0,13.8)};
}
inline constexpr double hc_over_k_nm=1.438777e7; // nm K
inline constexpr double lambda_g=468.6,lambda_r=616.5;
// Planck's F_nu shape at lambda (nm) and T (K).
inline double planck_nu(double l,double t) {return std::pow(l,-3.0)/std::expm1(hc_over_k_nm/(l*t));}
// The temperature whose Planck spectrum has the AB g-r given.
inline double color_temperature(double g_minus_r) {
  return sdss::root([&](double t){return -2.5*std::log10(planck_nu(lambda_g,t)/planck_nu(lambda_r,t))-g_minus_r;},1500.0,1.0e6);
}
// F_lambda (band units per nm, the common c dropped) of a population of
// SDSS light `b` per unit G.
inline double continuum(const sdss::Bands& b,double t,double l) {
  return b.r*planck_nu(l,t)/planck_nu(lambda_r,t)/(l*l)*lambda_r*lambda_r;
}
struct Line {double nm,relative;}; // relative to H-alpha's flux
inline constexpr Line nebular_lines[]={{656.28,1.0},{486.13,1/2.86},{434.05,0.468/2.86},{410.17,0.259/2.86},
  {500.68,1.0/2.86},{495.89,1.0/2.86/3},{658.35,0.35},{654.80,0.35/3}};
// XYZ per unit G light of a stellar continuum.
inline XYZ integrate(const sdss::Bands& b) {
  const double t=color_temperature(-2.5*std::log10(b.g/b.r));
  XYZ out{0,0,0};
  for(double l=360.5;l<830;l+=1.0) {
    const double s=continuum(b,t,l);const XYZ c=cmf(l);
    out.x+=s*c.x;out.y+=s*c.y;out.z+=s*c.z;
  }
  return out;
}
// Cardelli, Clayton & Mathis (1989), ApJ 345, 245, eq. 3 (optical, 1.1 <=
// x <= 3.3 per micron), R_V = 3.1: A_lambda / A_V.
inline double ccm89(double l_nm) {
  const double x=1000.0/l_nm,y=x-1.82;
  const double a=1+0.17699*y-0.50447*y*y-0.02427*y*y*y+0.72085*std::pow(y,4)+0.01979*std::pow(y,5)
    -0.77530*std::pow(y,6)+0.32999*std::pow(y,7);
  const double b=1.41338*y+2.28305*y*y+1.07233*y*y*y-5.38434*std::pow(y,4)-0.62251*std::pow(y,5)
    +5.30260*std::pow(y,6)-2.09002*std::pow(y,7);
  return a+b/3.1;
}
// THE REGIONS' OWN DUST (0.5.1): the lines leave a region through the dust
// mixed into it, A(H-alpha) = 1.1 mag, the mean Kennicutt (1983, ApJ 272,
// 54) adopts for disc HII regions (H-alpha : H-beta 4.4 for Case B's 2.86),
// each line dimmed by CCM89 at R_V 3.1. Without it the Case B lines read
// lavender-violet to the eye (the Balmer lines' blue in z-bar outweighs
// H-alpha's red in x-bar), bluer than disc HII regions are seen.
inline constexpr double hii_a_halpha=1.1;
// XYZ per unit G light of the nebular lines: their total flux (after the
// regions' own dust, the dimming folded into the regions' light) the young
// continuum's over 330-1050 nm.
inline XYZ nebular() {
  const auto& b=colors::young_bands;
  const double t=color_temperature(-2.5*std::log10(b.g/b.r));
  double energy=0,lines=0;
  for(double l=330.5;l<1050;l+=1.0) energy+=continuum(b,t,l);
  const double a_v=hii_a_halpha/ccm89(656.28);
  auto seen=[&](const Line& line){return line.relative*std::pow(10.0,-0.4*a_v*ccm89(line.nm));};
  for(const auto& line:nebular_lines) lines+=seen(line);
  XYZ out{0,0,0};
  for(const auto& line:nebular_lines) {
    const XYZ c=cmf(line.nm);const double f=energy*seen(line)/lines;
    out.x+=f*c.x;out.y+=f*c.y;out.z+=f*c.z;
  }
  return out;
}
// The four populations' XYZ, as bands in the renderer's channel slots:
// .r = Y (the central channel, luminance), .g = Z (the blue), .i = X.
inline sdss::Bands slots(const XYZ& c) {return {c.z,c.y,c.x};}
struct Set {sdss::Bands disc,central,young,hii,intermediate;};
inline const Set& bands() {
  // One scale for all four (the old disc's Y its r light), so the volumes'
  // half floats hold them as they hold r, g, i.
  static const Set set=[] {
    const XYZ disc=integrate(colors::disc_bands);const double k=colors::disc_bands.r/disc.y;
    auto scaled=[&](XYZ c){return slots({c.x*k,c.y*k,c.z*k});};
    return Set{scaled(disc),scaled(integrate(colors::central_bands)),scaled(integrate(colors::young_bands)),scaled(nebular()),
               scaled(integrate(colors::intermediate_bands))};
  }();
  return set;
}
// Each channel's extinction to G (slots Y, Z, X): CCM89 averaged over the
// old disc's spectrum times the channel's matching function, over A_G/A_V
// (Wang & Chen 2019, the model's dust carries A_G).
inline const std::array<double,3>& extinction_ratios() {
  static const std::array<double,3> ratios=[] {
    const double t=color_temperature(-2.5*std::log10(colors::disc_bands.g/colors::disc_bands.r));
    double num[3]={0,0,0},den[3]={0,0,0};
    for(double l=360.5;l<830;l+=1.0) {
      const double s=continuum(colors::disc_bands,t,l),a=ccm89(std::clamp(l,303.0,909.0));const XYZ c=cmf(l);
      const double w[3]={s*c.y,s*c.z,s*std::max(0.0,c.x)};
      for(int k=0;k<3;++k) {num[k]+=w[k]*a;den[k]+=w[k];}
    }
    return std::array<double,3>{num[0]/den[0]/populations::a_g_per_a_v,num[1]/den[1]/populations::a_g_per_a_v,
                                num[2]/den[2]/populations::a_g_per_a_v};
  }();
  return ratios;
}
// Display counts per unit of X, Y and Z (one value for all three, so the
// chromaticity stands): the old disc's luminance in the SDSS transfer's
// intensity (the mean of its weighted r, g, i counts), so the eye display
// keeps the fitted transfer's exposure.
inline double counts_per_unit(const std::array<double,3>& sdss_counts) {
  const auto& d=colors::disc_bands;
  const double intensity=(sdss_counts[0]*d.r+sdss_counts[1]*d.g+sdss_counts[2]*d.i)/3;
  return intensity/bands().disc.r;
}
} // namespace milky_way::eye
