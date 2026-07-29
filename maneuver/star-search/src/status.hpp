#ifndef STAR_SEARCH_STATUS_HPP
#define STAR_SEARCH_STATUS_HPP

#include <cstdint>

namespace star_search {

enum class Status : std::uint32_t {
    Ok = 0,
    InvalidInput,
    InvalidFormat,
    UnsupportedDsm,
    UnsupportedResonant,
    UnsupportedNullLeg,
    RowLimitExceeded,
    MemoryLimitExceeded,
    AllocationFailed,
    EphemerisBodyNotFound,
    EphemerisOutOfRange,
    LambertNoSolution,
    ThreadJoinFailed,
    IoError,
    ParseError,
    InternalError,
};

const char* status_message(Status status);

}  // namespace star_search

#endif
