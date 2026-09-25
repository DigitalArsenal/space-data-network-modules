// HWM14 horizontal winds for the atmosphere module.
#include "atmosphere/models.h"

#include "hwm14.hpp"

#include <algorithm>
#include <cmath>

namespace atmosphere {

namespace {

// Immutable after construction; every method is const and stateless.
const hwm14::Model& model() {
    static const hwm14::Model instance;
    return instance;
}

constexpr double kRadiansToDegrees = 180.0 / 3.14159265358979323846;

}  // namespace

WindVec getWind(const GeoPos& pos, const Epoch& epoch, double ap3h) {
    // HWM14 reads only the day of year from IYD (yyddd).
    const int iyd = (((epoch.year % 100) + 100) % 100) * 1000 + epoch.dayOfYear;
    const float ap[2] = {0.0f, static_cast<float>(ap3h)};
    float w[2];
    model().hwm14(iyd, static_cast<float>(epoch.secondOfDay), static_cast<float>(std::max(pos.alt_m, 0.0) / 1000.0),
                  static_cast<float>(pos.lat_rad * kRadiansToDegrees),
                  static_cast<float>(pos.lon_rad * kRadiansToDegrees), 0.0f, 0.0f, 0.0f, ap, w);
    WindVec out;
    out.north = w[0];
    out.east = w[1];
    out.down = 0.0;
    return out;
}

const char* windModelRelease() { return "HWM14.123114"; }

}  // namespace atmosphere
