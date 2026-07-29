#ifndef STAR_SEARCH_ENCOUNTER_HPP
#define STAR_SEARCH_ENCOUNTER_HPP

#include "ephemeris.hpp"

namespace star_search {

Status make_time_grid_count(
    double t_min_et_s,
    double t_max_et_s,
    double dt_et_s,
    std::size_t row_cap,
    std::size_t* count);

Status build_encounter_database(
    const Problem& problem,
    const Ephemeris& ephemeris,
    std::size_t row_cap,
    MemoryBudget* budget,
    EncounterDB* output);

}  // namespace star_search

#endif
