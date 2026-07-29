#ifndef STAR_SEARCH_PIPELINE_HPP
#define STAR_SEARCH_PIPELINE_HPP

#include "combo.hpp"
#include "ephemeris.hpp"

namespace star_search {

Status run_star_search(
    const Problem& problem,
    const Ephemeris& ephemeris,
    const ThreadOptions& thread_options,
    MemoryBudget* budget,
    OutputDB* output,
    StageCounts* counts);

}  // namespace star_search

#endif
