#pragma once

#include "astrodynamics_types.h"

namespace astro {

/// HWM14 horizontal neutral wind (Drob et al. 2015, NRL release HWM14.123114,
/// vendored as a bit-exact C++ port in third_party/hwm14) at an Earth-fixed
/// position, as an Earth-fixed velocity in km/s.
///
/// @param earthFixed Earth-fixed position (km), the axes the density models use
/// @param jdUtc      Julian date (UTC); sets day of year and UT
/// @param weather    Space weather; `kp3h` is the 3-hour Kp of the epoch
/// @param disturbance Add the DWM07 storm-time winds. They need `kp3h`: a
///                    request without it is refused rather than defaulted.
///                    With false, only the quiet-time winds are returned.
/// @throws std::invalid_argument when a disturbance wind has no Kp
Vec3 HorizontalWindEarthFixed(const Vec3& earthFixed, double jdUtc,
                              const SpaceWeatherData& weather, bool disturbance);

/// The same wind as north/east components in m/s at geodetic latitude and
/// longitude (degrees) and altitude (km).
void HorizontalWindNorthEast(double latDeg, double lonDeg, double altKm, double jdUtc,
                             const SpaceWeatherData& weather, bool disturbance,
                             double* northMs, double* eastMs);

/// HWM14 as released: total wind with the 3-hour ap of the epoch, or the
/// quiet-time wind alone when ap3h < 0. Latitude/longitude in degrees,
/// altitude km, day of year and UT seconds; winds in m/s.
void HorizontalWindFromAp(double latDeg, double lonDeg, double altKm, int year, int doy,
                          double sec, double ap3h, double* northMs, double* eastMs);

/// The DWM07 ap-to-Kp conversion (HWM14 AP2KP), for inputs that carry a
/// 3-hour ap rather than Kp.
double KpFromAp(double ap3h);

}  // namespace astro
