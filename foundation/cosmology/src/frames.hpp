#pragma once
#include <cmath>

namespace cosmology {
constexpr double pi = 3.141592653589793238462643383279502884;
constexpr double radians_per_degree = pi / 180;
struct Position {
  double longitude_rad, latitude_rad, x_mpc, y_mpc, z_mpc;
};
inline Position to_supergalactic(double longitude, double latitude, double comoving_mpc) {
  // Lahav et al. 2000: north SG pole (l,b)=(47.37,6.32) deg;
  // SG zero longitude lies at Galactic l=137.37 deg, b=0.
  const double l = 47.37 * radians_per_degree, b = 6.32 * radians_per_degree;
  const double x = std::cos(latitude) * std::cos(longitude);
  const double y = std::cos(latitude) * std::sin(longitude), z = std::sin(latitude);
  const double sx = -std::sin(l) * x + std::cos(l) * y;
  const double sy = -std::sin(b) * (std::cos(l) * x + std::sin(l) * y) + std::cos(b) * z;
  const double sz = std::cos(b) * (std::cos(l) * x + std::sin(l) * y) + std::sin(b) * z;
  double lon = std::atan2(sy, sx);
  if (lon < 0) lon += 2 * pi;
  return {lon, std::atan2(sz, std::hypot(sx, sy)),
          comoving_mpc * sx, comoving_mpc * sy, comoving_mpc * sz};
}
inline double cmb_redshift(double heliocentric, double longitude, double latitude) {
  // Planck 2018 I solar dipole. Planck 2013 XXVII eq. 1 supplies the exact
  // Doppler factor for an observed heliocentric sightline, including transverse
  // motion: 1/[gamma*(1-beta dot n_observed)].
  const double apex_l = 264.021 * radians_per_degree, apex_b = 48.253 * radians_per_degree;
  const double projection = std::sin(latitude) * std::sin(apex_b) +
      std::cos(latitude) * std::cos(apex_b) * std::cos(longitude - apex_l);
  const double beta = 369.82 / speed_of_light_km_s;
  return (1 + heliocentric) * std::sqrt(1 - beta * beta) / (1 - beta * projection) - 1;
}
} // namespace cosmology
