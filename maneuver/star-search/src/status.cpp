#include "status.hpp"

namespace star_search {

const char* status_message(Status status) {
    switch (status) {
        case Status::Ok:
            return "ok";
        case Status::InvalidInput:
            return "invalid input";
        case Status::InvalidFormat:
            return "invalid format";
        case Status::UnsupportedDsm:
            return "unsupported DSM";
        case Status::UnsupportedResonant:
            return "unsupported resonant leg";
        case Status::UnsupportedNullLeg:
            return "unsupported null leg";
        case Status::RowLimitExceeded:
            return "row limit exceeded";
        case Status::MemoryLimitExceeded:
            return "memory limit exceeded";
        case Status::AllocationFailed:
            return "allocation failed";
        case Status::EphemerisBodyNotFound:
            return "ephemeris body not found";
        case Status::EphemerisOutOfRange:
            return "ephemeris epoch out of range";
        case Status::LambertNoSolution:
            return "Lambert solution not found";
        case Status::ThreadJoinFailed:
            return "thread join failed";
        case Status::IoError:
            return "I/O error";
        case Status::ParseError:
            return "parse error";
        case Status::InternalError:
            return "internal error";
    }
    return "unknown status";
}

}  // namespace star_search
