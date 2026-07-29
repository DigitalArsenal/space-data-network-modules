#ifndef STAR_SEARCH_CONSTANTS_HPP
#define STAR_SEARCH_CONSTANTS_HPP

#include "status.hpp"

#include <cstdint>

namespace star_search {

constexpr double kSecondsPerDay = 86400.0;
constexpr double kJ2000JdTdb = 2451545.0;
constexpr double kSunMuKm3S2 = 1.3271244004127942E+11;

Status body_gm(std::int32_t body_id, double* gm_km3_s2);
Status body_gm_de431(std::int32_t body_id, double* gm_km3_s2);
Status body_mean_radius(std::int32_t body_id, double* mean_radius_km);
Status body_constants(std::int32_t body_id, double* gm_km3_s2, double* mean_radius_km);
Status body_semi_major_axis(std::int32_t body_id, double* semi_major_axis_km);

}  // namespace star_search

#endif
