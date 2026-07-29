#ifndef STAR_SEARCH_LEG_HPP
#define STAR_SEARCH_LEG_HPP

#include "lambert.hpp"

namespace star_search {

Status build_leg_database(
    const Problem& problem,
    const EncounterDB& encounters,
    std::uint32_t leg_stage,
    const ThreadOptions& thread_options,
    MemoryBudget* budget,
    LegDB* output);

}  // namespace star_search

#endif
