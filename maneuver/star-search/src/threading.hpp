#ifndef STAR_SEARCH_THREADING_HPP
#define STAR_SEARCH_THREADING_HPP

#include "status.hpp"

#include <cstddef>
#include <cstdint>

namespace star_search {

constexpr std::uint32_t kMaxThreads = 64U;

struct ThreadOptions {
    std::uint32_t requested_threads = 1U;
    bool force_spawn_failure = false;
};

using RangeFunction = void (*)(std::size_t begin, std::size_t end, void* context);

Status parallel_for_fixed(
    std::size_t row_count,
    const ThreadOptions& options,
    RangeFunction function,
    void* context);

}  // namespace star_search

#endif
