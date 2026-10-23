#pragma once
#include "reid_arms.hpp"

// Drimmel & Spergel 2001 dust, adapted to Reid arm centers. This model is
// independent of the Gaia display-map oracle; see tests/ORACLES.md.
namespace milky_way::drimmel2001 {
// The arm dust's density, x DS2001's rho_a (a bake may override it,
// `appearance_arm_dust`, model_api.hpp). 0.5: x12, the least that puts the
// arms' face-on A_I (their mean transmission over 3-14 kpc, as background
// counts measure it) inside the 0.5-4 mag Holwerda et al. (2005, AJ 129,
// 1396) measure through other spirals' arms: x3 0.25, x7 0.38, x12 0.52 mag.
// The Gaia sky check improves with it (density log r 0.908 at x3, 0.930 at
// x7, 0.924 at x12; OrbPro milky-way-sdss-look E2E, 2026-10-22). It departs
// from DS2001's own amplitude, fitted to DIRBE's far-infrared emission at
// 1.5 deg, which this model does not re-check: a tension, stated.
inline double arm_dust_scale=12.0;
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

// The dust's parts at p (G optical depth per kpc): DS2001's disc, its arms
// and its local component, so the structure can modulate each.
struct DustParts {double disc,arms,local;};
// 0.5: the arm dust's width across the arm is the arm's own Reid et al.
// (2019) Table 2 Gaussian width (the gas and masers' arms, where the dust
// lanes sit), not DS2001's broader w = 0.0641 R_a (fitted at the DIRBE
// maps' 1.5 deg resolution), the column across the arm conserved (the
// amplitude x DS2001's width over Reid's): a lane, not a broad band.
inline DustParts dust_parts(Vec3 p) {
  // DS2001 Eq.13-18 and Tables 1/2, NOT the FIR emissivity amplitudes.
  // Density units absorb FIR emissivity; kappa_V=.018 (MJy/sr)^-1 is the
  // fitted optical-depth coefficient. Wang & Chen 2019 Table 3: A_G/A_V=.789
  // for red-clump spectra (an approximation for the full mixed population).
  const double scale=galactic_constants::solar_radius_kpc/8;
  const double r=std::hypot(p.x,p.y)/scale,z=p.z/scale;
  const double h=.1344+.0148*std::max(0.0,r-4.40);
  const double radial=r<4?std::exp(-4/2.26-std::pow((r-4)/2,2)):std::exp(-r/2.26);
  const double disk=1098*radial/std::pow(std::cosh(z/h),2)/scale;
  double arms=0;
  // The arm dust follows the arms the light follows (reid_arms.hpp,
  // arm_light): Reid's curves over their coverage, continued beyond it.
  for(const auto& a:reid_segments) {
    if(arm_light::finite_segment(a))continue;
    arm_light::for_each_hit(a,p,[&](const arm_light::Hit& hit) {
      const double ra=hit.radius/scale;
      if(ra<1.5)return;
      const double separation=hit.separation/scale;
      const double reduction=a.family==3?.407:1;
      const double w_ds=.0641*ra*reduction,w=std::sqrt(2.0)*a.width_kpc/scale;
      const double ha=(.080+.0146*std::pow(std::max(0.0,ra-5.48),2))*reduction;
      const double taper=std::exp(-std::pow(std::max(0.0,ra-6.71)/2.07,2));
      // DS uses the largest contribution, not an additive overlap of arms.
      arms=std::max(arms,arm_dust_scale*w_ds/w*hit.weight*61/scale*taper*std::exp(-std::pow(separation/w,2)-std::pow(z/ha,2)));
    });
  }
  return {.789*.018*disk,.789*.018*arms,.789*.018*local_dust(p)};
}
inline double dust(Vec3 p,unsigned variant=3,double stellar_arms=0) {
  if(variant==1) {
    const double scale=galactic_constants::solar_radius_kpc/8;
    const double r=std::hypot(p.x,p.y)/scale,z=p.z/scale;
    const double h=.1344+.0148*std::max(0.0,r-4.40);
    const double radial=r<4?std::exp(-4/2.26-std::pow((r-4)/2,2)):std::exp(-r/2.26);
    return .789*.018*1098*radial/std::pow(std::cosh(z/h),2)/scale*(1+8*stellar_arms);
  }
  const auto d=dust_parts(p);
  return d.disc+d.arms+(variant==3?d.local:0);
}

} // namespace milky_way::drimmel2001
