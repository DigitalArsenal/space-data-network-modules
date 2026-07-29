#ifndef STAR_SEARCH_COMBO_HPP
#define STAR_SEARCH_COMBO_HPP

#include "filter.hpp"

namespace star_search {

Status run_combo(
    const Problem& problem,
    const EncounterDB& encounters,
    LegDB* const leg_dbs[kMaxStages],
    FlybyDB* const flyby_dbs[kMaxStages],
    MemoryBudget* budget,
    OutputDB* output,
    StageCounts* counts);

Status tfilter_output_db(
    const Problem& problem,
    MemoryBudget* budget,
    OutputDB* output,
    std::size_t* num_bins);

}  // namespace star_search

#endif
