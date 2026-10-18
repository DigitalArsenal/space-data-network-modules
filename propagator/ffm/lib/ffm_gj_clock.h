#pragma once
#include "time_convert.h"
#include <cmath>

namespace ffm_fast {
// Canonical two-part TT construction matters for shared exact-time caches:
// adding many days to different object-local Instant fractions can produce
// unequal low bits at an otherwise common node. Split seconds first instead.
class GjClock {
    double whole_;
public:
    explicit GjClock(const timesys::Instant& epoch) {
        const double midnight=std::floor(epoch.utc().jd()+.5)-.5;
        whole_=(midnight-timesys::J2000_JD)*86400+timesys::getLeapSeconds(midnight)+32;
    }
    timesys::Instant at(double seconds) const {
        const double whole=std::floor(seconds);
        return timesys::Instant::fromTTSeconds(whole_+whole,.184+(seconds-whole));
    }
};
} // namespace ffm_fast
