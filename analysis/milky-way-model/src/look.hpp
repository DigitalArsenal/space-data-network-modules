#pragma once
#include "eye_color.hpp"
#include <algorithm>

// LOOK GOOD (0.5, owner 2026-10-23: the star field's TRUE PHYSICS / LOOK GOOD
// switch, for the Milky Way): display gains applied to the MODELED
// components at the bake, never structure the model does not have. The bake
// value `look_good` 1 sets them; 0 (the default, TRUE PHYSICS, every check's)
// leaves the measured light. Each gain is a display parameter, chosen by eye
// against the owner's references (the NASA/JPL-Caltech illustration and the
// HST NGC 4414 image), and named here:
//  - young_gain: the young (M_V < -1) light and its complexes x 3;
//  - hii_gain: the HII regions' light x 3, and their eye color's
//    chromaticity pushed from the D65 white point by hii_saturation 1.8 (Y
//    kept);
//  - major_arm_gain: the stellar wave on the two GLIMPSE major arms
//    (Scutum-Centaurus, Perseus: their old stars and, beyond DS2001's
//    K-band extent, their intermediate-age continuation) x 3;
//  - exposure: the eye display's solar-circle disc at display luminance 0.45
//    (TRUE PHYSICS 0.38; model_api.hpp, display), through an asinh of
//    softening Q 6 (TRUE PHYSICS: the fitted 8.295), a gentler compression
//    that keeps more of the arms' contrast.
namespace milky_way::look {
inline double on=0;
inline bool active() {return on>=0.5;}
inline constexpr double young_gain_value=3.0,hii_gain_value=3.0,hii_saturation=1.8,major_arm_gain_value=3.0;
inline constexpr double disc_display_physical=0.38,disc_display_look_good=0.45,softening_look_good=6.0;
inline double young_gain() {return active()?young_gain_value:1.0;}
inline double hii_gain() {return active()?hii_gain_value:1.0;}
inline double major_arm_gain() {return active()?major_arm_gain_value:1.0;}
inline double disc_display() {return active()?disc_display_look_good:disc_display_physical;}
inline double softening(double fitted) {return active()?softening_look_good:fitted;}
// The HII regions' eye bands (slots Y, Z, X), saturated when LOOK GOOD.
inline const sdss::Bands& hii_eye() {
  static const sdss::Bands saturated=[] {
    constexpr double wx=0.95047,wz=1.08883; // D65, Y = 1
    const auto& h=eye::bands().hii;const double y=h.r;
    const double x=std::max(0.0,y*(wx+hii_saturation*(h.i/y-wx))),z=std::max(0.0,y*(wz+hii_saturation*(h.g/y-wz)));
    return sdss::Bands{z,y,x};
  }();
  return active()?saturated:eye::bands().hii;
}
} // namespace milky_way::look
