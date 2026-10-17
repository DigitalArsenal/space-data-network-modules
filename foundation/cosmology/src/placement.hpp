#pragma once
#include "cosmology.hpp"

namespace cosmology {
enum class DistanceSource { REDSHIFT = 0, TEMPEL2017 = 1, CF4 = 2 };
struct Placement {
  double redshift;
  Distances distance;
  DistanceSource source;
};
inline Placement place(double redshift_cmb, double cf4_luminosity_mpc,
                       bool grouped, double group_redshift_cmb) {
  // Catalog joins happen upstream by published IDs, never by smoothing or
  // proximity here. A measured luminosity distance wins even for blueshifts.
  if (cf4_luminosity_mpc > 0) {
    const double z = redshift_from_luminosity(cf4_luminosity_mpc);
    return {z, distances(z), DistanceSource::CF4};
  }
  const double z = grouped ? group_redshift_cmb : redshift_cmb;
  return {z, distances(z), grouped ? DistanceSource::TEMPEL2017 : DistanceSource::REDSHIFT};
}
} // namespace cosmology
