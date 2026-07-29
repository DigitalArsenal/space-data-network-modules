#ifndef STAR_SEARCH_FILTER_HPP
#define STAR_SEARCH_FILTER_HPP

#include "flyby.hpp"

namespace star_search {

Status filter_encounter_stages_from_active_legs(
    EncounterDB* encounters,
    LegDB* leg_dbs[kMaxStages],
    std::uint32_t leg_count,
    const bool stages_to_filter[kMaxStages],
    MemoryBudget* budget,
    std::size_t* removed_rows);

// Reproduce the upstream backward/forward active-row pruning. IDs remain
// immutable; buffers are compacted in their original row order.
Status run_leg_filter_fixpoint(
    EncounterDB* encounters,
    LegDB* leg_dbs[kMaxStages],
    FlybyDB* flyby_dbs[kMaxStages],
    std::uint32_t leg_count,
    MemoryBudget* budget,
    std::size_t* passes,
    std::size_t* removed_rows);

}  // namespace star_search

#endif
