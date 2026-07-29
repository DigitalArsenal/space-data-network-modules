#ifndef STAR_SEARCH_EPHEMERIS_HPP
#define STAR_SEARCH_EPHEMERIS_HPP

#include "types.hpp"

#include <cstddef>
#include <cstdint>

namespace star_search {

Status decode_ephemeris(
    const std::uint8_t* bytes,
    std::size_t byte_count,
    std::size_t sample_cap,
    MemoryBudget* budget,
    Ephemeris* output);

Status query_ephemeris(
    const Ephemeris& ephemeris,
    std::int32_t body_id,
    double epoch_et_s,
    State6* output);

Status ephemeris_body_constants(
    const Ephemeris& ephemeris,
    std::int32_t body_id,
    double* gm_km3_s2,
    double* mean_radius_km);

}  // namespace star_search

#endif
