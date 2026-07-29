#ifndef STAR_SEARCH_FLYBY_HPP
#define STAR_SEARCH_FLYBY_HPP

#include "leg.hpp"

namespace star_search {

double compute_parabolic_escape_dv(
    double vinf_km_s,
    double mu_km3_s2,
    double rmin_km);

Status build_flyby_database(
    const Problem& problem,
    const EncounterDB& encounters,
    const LegDB& incoming,
    const LegDB& outgoing,
    std::uint32_t flyby_stage,
    std::int64_t if_start,
    const ThreadOptions& thread_options,
    MemoryBudget* budget,
    FlybyDB* output);

}  // namespace star_search

#endif
