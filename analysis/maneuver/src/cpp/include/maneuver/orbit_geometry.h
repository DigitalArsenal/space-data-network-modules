#ifndef MANEUVER_ORBIT_GEOMETRY_H
#define MANEUVER_ORBIT_GEOMETRY_H

#include "json_lite.h"
#include <string>

namespace maneuver {
// SI inertial states, radians, and elapsed SI seconds. These operations compose
// the shared foundation/orbits conversions; hosts must not repeat the physics.
std::string orbitGeometryOperation(const std::string& operation,
                                   const json_lite::Value& params);
}
#endif
