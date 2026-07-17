#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace sdn::coverage {

struct GridDefinition {
  double minLatitudeDeg = -90.0;
  double maxLatitudeDeg = 90.0;
  double minLongitudeDeg = -180.0;
  double maxLongitudeDeg = 180.0;
  double latitudeStepDeg = 1.0;
  double longitudeStepDeg = 1.0;
  int rows = 0;
  int columns = 0;
};

struct LonLat {
  double latitudeDeg = 0.0;
  double longitudeDeg = 0.0;
};

double conservativeGroundCapRadiusDeg(
    double observerDistanceM,
    double bodyMinimumRadiusM,
    double maximumLookAngleDeg);

// Returns the exact minimum central angle on a sphere from `center` to any
// point in the closed latitude/longitude rectangle. Longitudes are unwrapped
// around the center, so edge cells adjacent to +/-180 degrees are handled
// without a discontinuity. Callers working on WGS84 radial directions should
// pass geocentric (not geodetic) latitude bounds.
double minimumAngularDistanceToRectangleDeg(
    const LonLat& center,
    double minLatitudeDeg,
    double maxLatitudeDeg,
    double minLongitudeDeg,
    double maxLongitudeDeg);

bool sphericalCapIntersectsRectangle(
    const LonLat& center,
    double angularRadiusDeg,
    double minLatitudeDeg,
    double maxLatitudeDeg,
    double minLongitudeDeg,
    double maxLongitudeDeg);

void appendAllGridCells(
    const GridDefinition& grid,
    std::vector<uint32_t>& marks,
    uint32_t generation,
    std::vector<uint32_t>& candidates);

void appendFootprintCandidates(
    const GridDefinition& grid,
    const LonLat& center,
    const LonLat* vertices,
    size_t vertexCount,
    std::vector<uint32_t>& marks,
    uint32_t generation,
    std::vector<uint32_t>& candidates);

void appendSphericalCapCandidates(
    const GridDefinition& grid,
    const LonLat& center,
    double angularRadiusDeg,
    std::vector<uint32_t>& marks,
    uint32_t generation,
    std::vector<uint32_t>& candidates);

}  // namespace sdn::coverage
