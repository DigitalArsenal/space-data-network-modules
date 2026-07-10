#include <algorithm>
#include <cmath>
#include <limits>

namespace sdn::coverage {
namespace {

double clampCoverageValue(double value, double minimum, double maximum) {
  return std::max(minimum, std::min(maximum, value));
}

double toCoverageRadians(double degrees) {
  return degrees * 0.017453292519943295769;
}

double toCoverageDegrees(double radians) {
  return radians * 57.295779513082320877;
}

double unwrapLongitude(double longitudeDeg, double referenceDeg) {
  double longitude = longitudeDeg;
  while (longitude - referenceDeg > 180.0) {
    longitude -= 360.0;
  }
  while (longitude - referenceDeg < -180.0) {
    longitude += 360.0;
  }
  return longitude;
}

bool validGrid(const GridDefinition& grid) {
  return grid.rows > 0 &&
    grid.columns > 0 &&
    grid.latitudeStepDeg > 0.0 &&
    grid.longitudeStepDeg > 0.0 &&
    grid.maxLatitudeDeg > grid.minLatitudeDeg &&
    grid.maxLongitudeDeg > grid.minLongitudeDeg;
}

void appendCandidate(
    uint32_t cellIndex,
    std::vector<uint32_t>& marks,
    uint32_t generation,
    std::vector<uint32_t>& candidates) {
  if (cellIndex >= marks.size() || marks[cellIndex] == generation) {
    return;
  }
  marks[cellIndex] = generation;
  candidates.push_back(cellIndex);
}

}  // namespace

double conservativeGroundCapRadiusDeg(
    double observerDistanceM,
    double bodyMinimumRadiusM,
    double maximumLookAngleDeg) {
  if (
    !std::isfinite(observerDistanceM) ||
    !std::isfinite(bodyMinimumRadiusM) ||
    !std::isfinite(maximumLookAngleDeg) ||
    !(bodyMinimumRadiusM > 0.0) ||
    !(observerDistanceM > bodyMinimumRadiusM)
  ) {
    return 180.0;
  }

  const double radiusRatio = clampCoverageValue(
    bodyMinimumRadiusM / observerDistanceM,
    0.0,
    1.0);
  const double horizonLookAngleRad = std::asin(radiusRatio);
  const double horizonGroundAngleRad = std::acos(radiusRatio);
  const double lookAngleRad = std::max(
    0.0,
    toCoverageRadians(maximumLookAngleDeg));
  if (lookAngleRad >= horizonLookAngleRad) {
    return toCoverageDegrees(horizonGroundAngleRad);
  }

  const double sinLook = std::sin(lookAngleRad);
  const double cosLook = std::cos(lookAngleRad);
  const double discriminant = std::max(
    0.0,
    bodyMinimumRadiusM * bodyMinimumRadiusM -
      observerDistanceM * observerDistanceM * sinLook * sinLook);
  const double distanceAlongRay =
    observerDistanceM * cosLook - std::sqrt(discriminant);
  const double groundAngleRad = std::atan2(
    distanceAlongRay * sinLook,
    observerDistanceM - distanceAlongRay * cosLook);
  return toCoverageDegrees(clampCoverageValue(
    groundAngleRad,
    0.0,
    horizonGroundAngleRad));
}

void appendAllGridCells(
    const GridDefinition& grid,
    std::vector<uint32_t>& marks,
    uint32_t generation,
    std::vector<uint32_t>& candidates) {
  if (!validGrid(grid)) {
    return;
  }
  const size_t cellCount =
    static_cast<size_t>(grid.rows) * static_cast<size_t>(grid.columns);
  const size_t boundedCount = std::min(cellCount, marks.size());
  for (size_t cellIndex = 0; cellIndex < boundedCount; ++cellIndex) {
    appendCandidate(
      static_cast<uint32_t>(cellIndex),
      marks,
      generation,
      candidates);
  }
}

void appendFootprintCandidates(
    const GridDefinition& grid,
    const LonLat& center,
    const LonLat* vertices,
    size_t vertexCount,
    std::vector<uint32_t>& marks,
    uint32_t generation,
    std::vector<uint32_t>& candidates) {
  if (!validGrid(grid)) {
    return;
  }
  const size_t cellCount =
    static_cast<size_t>(grid.rows) * static_cast<size_t>(grid.columns);
  if (marks.size() < cellCount || vertices == nullptr || vertexCount == 0) {
    appendAllGridCells(grid, marks, generation, candidates);
    return;
  }

  double minLatitude = center.latitudeDeg;
  double maxLatitude = center.latitudeDeg;
  double minLongitude = center.longitudeDeg;
  double maxLongitude = center.longitudeDeg;
  for (size_t index = 0; index < vertexCount; ++index) {
    const LonLat& vertex = vertices[index];
    if (
      !std::isfinite(vertex.latitudeDeg) ||
      !std::isfinite(vertex.longitudeDeg)
    ) {
      appendAllGridCells(grid, marks, generation, candidates);
      return;
    }
    minLatitude = std::min(minLatitude, vertex.latitudeDeg);
    maxLatitude = std::max(maxLatitude, vertex.latitudeDeg);
    const double longitude =
      unwrapLongitude(vertex.longitudeDeg, center.longitudeDeg);
    minLongitude = std::min(minLongitude, longitude);
    maxLongitude = std::max(maxLongitude, longitude);
  }

  minLatitude -= grid.latitudeStepDeg;
  maxLatitude += grid.latitudeStepDeg;
  minLongitude -= grid.longitudeStepDeg;
  maxLongitude += grid.longitudeStepDeg;

  const int firstRow = std::max(
    0,
    static_cast<int>(std::floor(
      (minLatitude - grid.minLatitudeDeg) / grid.latitudeStepDeg)));
  const int lastRow = std::min(
    grid.rows - 1,
    static_cast<int>(std::floor(
      (maxLatitude - grid.minLatitudeDeg) / grid.latitudeStepDeg)));
  if (lastRow < firstRow) {
    return;
  }

  const bool coversPole =
    minLatitude <= -90.0 || maxLatitude >= 90.0;
  const bool coversAllLongitudes =
    coversPole || maxLongitude - minLongitude >= 360.0;
  const double halfLongitudeStep = 0.5 * grid.longitudeStepDeg;

  for (int row = firstRow; row <= lastRow; ++row) {
    for (int column = 0; column < grid.columns; ++column) {
      if (!coversAllLongitudes) {
        const double cellCenterLongitude =
          grid.minLongitudeDeg +
          (static_cast<double>(column) + 0.5) * grid.longitudeStepDeg;
        const double unwrappedCellLongitude =
          unwrapLongitude(cellCenterLongitude, center.longitudeDeg);
        if (
          unwrappedCellLongitude + halfLongitudeStep < minLongitude ||
          unwrappedCellLongitude - halfLongitudeStep > maxLongitude
        ) {
          continue;
        }
      }
      appendCandidate(
        static_cast<uint32_t>(row * grid.columns + column),
        marks,
        generation,
        candidates);
    }
  }
}

void appendSphericalCapCandidates(
    const GridDefinition& grid,
    const LonLat& center,
    double angularRadiusDeg,
    std::vector<uint32_t>& marks,
    uint32_t generation,
    std::vector<uint32_t>& candidates) {
  if (
    !validGrid(grid) ||
    !std::isfinite(center.latitudeDeg) ||
    !std::isfinite(center.longitudeDeg) ||
    !std::isfinite(angularRadiusDeg) ||
    angularRadiusDeg < 0.0
  ) {
    appendAllGridCells(grid, marks, generation, candidates);
    return;
  }
  const size_t cellCount =
    static_cast<size_t>(grid.rows) * static_cast<size_t>(grid.columns);
  if (marks.size() < cellCount) {
    return;
  }

  const double cellSampleRadiusDeg =
    0.5 * std::hypot(grid.latitudeStepDeg, grid.longitudeStepDeg);
  const double radiusDeg = std::min(
    180.0,
    angularRadiusDeg + cellSampleRadiusDeg + 1.0e-9);
  if (radiusDeg >= 180.0) {
    appendAllGridCells(grid, marks, generation, candidates);
    return;
  }

  const double minLatitude = center.latitudeDeg - radiusDeg;
  const double maxLatitude = center.latitudeDeg + radiusDeg;
  const int firstRow = std::max(
    0,
    static_cast<int>(std::floor(
      (minLatitude - grid.minLatitudeDeg) / grid.latitudeStepDeg)));
  const int lastRow = std::min(
    grid.rows - 1,
    static_cast<int>(std::floor(
      (maxLatitude - grid.minLatitudeDeg) / grid.latitudeStepDeg)));
  if (lastRow < firstRow) {
    return;
  }

  const double centerLatitudeRad = toCoverageRadians(center.latitudeDeg);
  const double radiusRad = toCoverageRadians(radiusDeg);
  const double sinCenterLatitude = std::sin(centerLatitudeRad);
  const double cosCenterLatitude = std::cos(centerLatitudeRad);
  const double cosRadius = std::cos(radiusRad);
  const double halfLongitudeStep = 0.5 * grid.longitudeStepDeg;

  for (int row = firstRow; row <= lastRow; ++row) {
    const double rowLatitudeDeg =
      grid.minLatitudeDeg +
      (static_cast<double>(row) + 0.5) * grid.latitudeStepDeg;
    const double rowLatitudeRad = toCoverageRadians(rowLatitudeDeg);
    const double denominator =
      cosCenterLatitude * std::cos(rowLatitudeRad);
    bool allLongitudes = std::fabs(denominator) < 1.0e-15;
    double longitudeRadiusDeg = 180.0;
    if (!allLongitudes) {
      const double threshold =
        (cosRadius - sinCenterLatitude * std::sin(rowLatitudeRad)) /
        denominator;
      if (threshold > 1.0) {
        continue;
      }
      if (threshold <= -1.0) {
        allLongitudes = true;
      } else {
        longitudeRadiusDeg = toCoverageDegrees(
          std::acos(clampCoverageValue(threshold, -1.0, 1.0)));
      }
    }

    for (int column = 0; column < grid.columns; ++column) {
      if (!allLongitudes) {
        const double cellCenterLongitude =
          grid.minLongitudeDeg +
          (static_cast<double>(column) + 0.5) * grid.longitudeStepDeg;
        const double unwrappedCellLongitude =
          unwrapLongitude(cellCenterLongitude, center.longitudeDeg);
        if (
          std::fabs(unwrappedCellLongitude - center.longitudeDeg) >
          longitudeRadiusDeg + halfLongitudeStep
        ) {
          continue;
        }
      }
      appendCandidate(
        static_cast<uint32_t>(row * grid.columns + column),
        marks,
        generation,
        candidates);
    }
  }
}

}  // namespace sdn::coverage
