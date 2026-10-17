#pragma once
#include "../../../foundation/frames/src/galactic.hpp"

// Unit adapters only. The foundation frame owns the adopted Galactic constants.
namespace milky_way::galactic_constants {
inline constexpr double pi = 3.141592653589793238462643383279502884;
inline constexpr double radians_per_degree = pi / 180.0;
inline constexpr double solar_radius_kpc = sdn::frames::galactic::kSunToCentreParsecs / 1000.0;
inline constexpr double solar_height_kpc = sdn::frames::galactic::kSunHeightParsecs / 1000.0;
// Static Galactocentric axes: +x parallel to l=0, +y to l=90, +z to NGP.
// Sun=(-R0,0,z_sun); Reid beta=atan2(y,-x), toward Galactic rotation.
} // namespace milky_way::galactic_constants
