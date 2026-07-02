// higherpop/constants.hpp — physical constants (km, s, kg).
// Values chosen to match propagator/hpop so cross-checks are apples-to-apples.
#pragma once
namespace hp {

inline constexpr double MU_EARTH = 398600.4418;      // km^3/s^2 (EGM2008)
inline constexpr double RE_EARTH = 6378.137;         // km  (WGS84 equatorial)
inline constexpr double OMEGA_EARTH = 7.2921159e-5;  // rad/s (Earth rotation)
inline constexpr double PI  = 3.14159265358979323846;
inline constexpr double TWO_PI = 2.0 * PI;

// Unnormalized zonal harmonics J2..J6 (dimensionless).
//
// IMPORTANT: these values are chosen to MATCH propagator/hpop exactly
// (astrodynamics_types.h: J2_EARTH, J3_EARTH, J4_EARTH), so higherpop and hpop
// compute bit-comparable zonal accelerations. J5/J6 are hpop's normalized-path
// values (used only when zonalMax>=5); the guaranteed-cross-checkable configs
// are J2-only and J2-J4, which hpop also has as closed forms.
inline constexpr double J2 = 1.08262668e-3;     // == hpop J2_EARTH
inline constexpr double J3 = -2.53265648e-6;    // == hpop J3_EARTH
inline constexpr double J4 = -1.61962159e-6;    // == hpop J4_EARTH
inline constexpr double J5 = -2.27296082869e-7;
inline constexpr double J6 =  5.40681239107e-7;

} // namespace hp
