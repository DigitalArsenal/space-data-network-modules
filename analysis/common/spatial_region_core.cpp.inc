// =============================================================================
// spatial_region_core.cpp.inc — implementation of the vendored leaf predicates.
// Concatenated (not #included) into the single sensor-coverage translation unit
// by build-sdk-compiled-module.mjs. See spatial_region_core.h for provenance,
// the guardian-mandated shape, and the parity-oracle contract.
//
// Faithful port of the four leaf branches of
// OrbPro/.../Analysis/SpatialRegion.cpp (commit 2c07554f). The registry
// parameter and every UNION/INTERSECTION/DIFFERENCE branch were dropped; all
// remaining math is byte-for-byte equivalent to the upstream leaf paths.
// =============================================================================

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>

namespace sdn_spatial_region {
namespace {

// TU-local, scoped inside sdn_spatial_region so nothing collides with the
// module.cpp anonymous namespace (which defines its own PI/EPSILON/Vec3/etc.).
constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kTwoPi = 2.0 * kPi;
constexpr double kEpsilon = 1e-12;

constexpr double kWgs84SemiMajor = 6378137.0;
constexpr double kWgs84SemiMinor = 6356752.3142451793;
constexpr double kWgs84FirstEccentricitySquared = 6.6943799901413165e-3;
constexpr double kWgs84SecondEccentricitySquared = 6.739496742276434e-3;

bool pointOnSegment2D(double ax, double ay, double bx, double by, double px,
                      double py) {
  const double cross = (px - ax) * (by - ay) - (py - ay) * (bx - ax);
  if (std::abs(cross) > kEpsilon) {
    return false;
  }

  const double dot = (px - ax) * (bx - ax) + (py - ay) * (by - ay);
  if (dot < -kEpsilon) {
    return false;
  }

  const double squaredLength = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
  if (dot - squaredLength > kEpsilon) {
    return false;
  }

  return true;
}

}  // namespace

SpatialRegion::SpatialRegion(SpatialRegionType type) : type_(type) {
  boundingSphereConfig_ = {0.0, 0.0, 0.0, 0.0};
  cartesianBoxConfig_ = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
  cartographicRectangleConfig_ = {0.0,
                                  0.0,
                                  0.0,
                                  0.0,
                                  std::numeric_limits<double>::lowest(),
                                  std::numeric_limits<double>::max()};
  cartographicPolygonConfig_ = {{},
                                0.0,
                                0.0,
                                0.0,
                                0.0,
                                std::numeric_limits<double>::lowest(),
                                std::numeric_limits<double>::max(),
                                false};
}

void SpatialRegion::setBoundingSphereConfig(
    const BoundingSphereRegionConfig& config) {
  boundingSphereConfig_ = config;
}

void SpatialRegion::setCartesianBoxConfig(
    const CartesianBoxRegionConfig& config) {
  cartesianBoxConfig_ = config;
}

void SpatialRegion::setCartographicRectangleConfig(
    const CartographicRectangleRegionConfig& config) {
  cartographicRectangleConfig_ = config;
  cartographicRectangleConfig_.west = normalizeLongitudeRadians(config.west);
  cartographicRectangleConfig_.east = normalizeLongitudeRadians(config.east);
}

void SpatialRegion::setCartographicPolygonConfig(const double* positions,
                                                 uint32_t vertexCount,
                                                 double minHeight,
                                                 double maxHeight) {
  cartographicPolygonConfig_.positions.clear();
  cartographicPolygonConfig_.positions.reserve(vertexCount * 2);
  cartographicPolygonConfig_.minHeight = minHeight;
  cartographicPolygonConfig_.maxHeight = maxHeight;
  cartographicPolygonConfig_.hasBoundingRectangle = false;

  if (positions == nullptr || vertexCount == 0) {
    return;
  }

  double west = 0.0;
  double east = 0.0;
  double south = 0.0;
  double north = 0.0;

  for (uint32_t i = 0; i < vertexCount; ++i) {
    const double longitude = normalizeLongitudeRadians(positions[i * 2]);
    const double latitude = positions[i * 2 + 1];

    cartographicPolygonConfig_.positions.push_back(longitude);
    cartographicPolygonConfig_.positions.push_back(latitude);

    if (i == 0) {
      west = east = longitude;
      south = north = latitude;
      continue;
    }

    west = std::min(west, longitude);
    east = std::max(east, longitude);
    south = std::min(south, latitude);
    north = std::max(north, latitude);
  }

  cartographicPolygonConfig_.west = west;
  cartographicPolygonConfig_.east = east;
  cartographicPolygonConfig_.south = south;
  cartographicPolygonConfig_.north = north;
  cartographicPolygonConfig_.hasBoundingRectangle = vertexCount >= 3;
}

double SpatialRegion::normalizeLongitudeRadians(double longitude) {
  double normalized = std::fmod(longitude + kPi, kTwoPi);
  if (normalized < 0.0) {
    normalized += kTwoPi;
  }
  return normalized - kPi;
}

bool SpatialRegion::longitudeInInterval(double longitude, double west,
                                        double east) {
  const double normalizedLongitude = normalizeLongitudeRadians(longitude);
  const double normalizedWest = normalizeLongitudeRadians(west);
  const double normalizedEast = normalizeLongitudeRadians(east);

  if (normalizedWest <= normalizedEast) {
    return normalizedLongitude >= normalizedWest - kEpsilon &&
           normalizedLongitude <= normalizedEast + kEpsilon;
  }

  return normalizedLongitude >= normalizedWest - kEpsilon ||
         normalizedLongitude <= normalizedEast + kEpsilon;
}

bool SpatialRegion::pointInsideCartographicRing(
    double longitude, double latitude, const std::vector<double>& positions) {
  const std::size_t vertexCount = positions.size() / 2;
  if (vertexCount < 3) {
    return false;
  }

  bool inside = false;
  for (std::size_t i = 0, j = vertexCount - 1; i < vertexCount; j = i++) {
    const double xi = positions[i * 2];
    const double yi = positions[i * 2 + 1];
    const double xj = positions[j * 2];
    const double yj = positions[j * 2 + 1];

    if (pointOnSegment2D(xi, yi, xj, yj, longitude, latitude)) {
      return true;
    }

    const bool intersects =
        ((yi > latitude) != (yj > latitude)) &&
        (longitude < ((xj - xi) * (latitude - yi)) /
                             ((yj - yi) +
                              ((std::abs(yj - yi) <= kEpsilon) ? kEpsilon : 0.0)) +
                         xi);
    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

bool SpatialRegion::cartesianToCartographic(double x, double y, double z,
                                            double& longitude, double& latitude,
                                            double& height) {
  const double p = std::sqrt(x * x + y * y);
  if (p <= kEpsilon && std::abs(z) <= kEpsilon) {
    return false;
  }

  longitude = std::atan2(y, x);

  const double theta = std::atan2(z * kWgs84SemiMajor, p * kWgs84SemiMinor);
  const double sinTheta = std::sin(theta);
  const double cosTheta = std::cos(theta);

  latitude = std::atan2(
      z + kWgs84SecondEccentricitySquared * kWgs84SemiMinor * sinTheta *
              sinTheta * sinTheta,
      p - kWgs84FirstEccentricitySquared * kWgs84SemiMajor * cosTheta *
              cosTheta * cosTheta);

  const double sinLatitude = std::sin(latitude);
  const double cosLatitude = std::cos(latitude);
  const double primeVerticalRadius =
      kWgs84SemiMajor /
      std::sqrt(1.0 - kWgs84FirstEccentricitySquared * sinLatitude *
                          sinLatitude);

  if (std::abs(cosLatitude) > kEpsilon) {
    height = p / cosLatitude - primeVerticalRadius;
  } else {
    height = z / std::max(std::abs(sinLatitude), kEpsilon) -
             primeVerticalRadius * (1.0 - kWgs84FirstEccentricitySquared);
  }

  longitude = normalizeLongitudeRadians(longitude);
  return true;
}

bool SpatialRegion::usesCartographicSpace() const {
  switch (type_) {
    case SpatialRegionType::CARTOGRAPHIC_RECTANGLE:
    case SpatialRegionType::CARTOGRAPHIC_POLYGON:
      return true;
    case SpatialRegionType::BOUNDING_SPHERE:
    case SpatialRegionType::CARTESIAN_BOX:
      return false;
  }
  return false;
}

bool SpatialRegion::containsCartographicPoint(double longitude, double latitude,
                                              double height) const {
  const double normalizedLongitude = normalizeLongitudeRadians(longitude);

  switch (type_) {
    case SpatialRegionType::CARTOGRAPHIC_RECTANGLE: {
      if (height < cartographicRectangleConfig_.minHeight - kEpsilon ||
          height > cartographicRectangleConfig_.maxHeight + kEpsilon) {
        return false;
      }

      return latitude >= cartographicRectangleConfig_.south - kEpsilon &&
             latitude <= cartographicRectangleConfig_.north + kEpsilon &&
             longitudeInInterval(normalizedLongitude,
                                 cartographicRectangleConfig_.west,
                                 cartographicRectangleConfig_.east);
    }
    case SpatialRegionType::CARTOGRAPHIC_POLYGON: {
      if (height < cartographicPolygonConfig_.minHeight - kEpsilon ||
          height > cartographicPolygonConfig_.maxHeight + kEpsilon) {
        return false;
      }

      if (cartographicPolygonConfig_.hasBoundingRectangle) {
        const bool insideBounds =
            latitude >= cartographicPolygonConfig_.south - kEpsilon &&
            latitude <= cartographicPolygonConfig_.north + kEpsilon &&
            longitudeInInterval(normalizedLongitude,
                                cartographicPolygonConfig_.west,
                                cartographicPolygonConfig_.east);

        if (!insideBounds) {
          return false;
        }
      }

      return pointInsideCartographicRing(normalizedLongitude, latitude,
                                         cartographicPolygonConfig_.positions);
    }
    case SpatialRegionType::BOUNDING_SPHERE:
    case SpatialRegionType::CARTESIAN_BOX:
      return false;
  }
  return false;
}

bool SpatialRegion::containsWorldPoint(double x, double y, double z) const {
  if (usesCartographicSpace()) {
    double longitude = 0.0;
    double latitude = 0.0;
    double height = 0.0;
    if (!cartesianToCartographic(x, y, z, longitude, latitude, height)) {
      return false;
    }
    return containsCartographicPoint(longitude, latitude, height);
  }

  switch (type_) {
    case SpatialRegionType::BOUNDING_SPHERE: {
      const double dx = x - boundingSphereConfig_.centerX;
      const double dy = y - boundingSphereConfig_.centerY;
      const double dz = z - boundingSphereConfig_.centerZ;
      return dx * dx + dy * dy + dz * dz <=
             boundingSphereConfig_.radius * boundingSphereConfig_.radius;
    }
    case SpatialRegionType::CARTESIAN_BOX:
      return x >= cartesianBoxConfig_.minimumX - kEpsilon &&
             x <= cartesianBoxConfig_.maximumX + kEpsilon &&
             y >= cartesianBoxConfig_.minimumY - kEpsilon &&
             y <= cartesianBoxConfig_.maximumY + kEpsilon &&
             z >= cartesianBoxConfig_.minimumZ - kEpsilon &&
             z <= cartesianBoxConfig_.maximumZ + kEpsilon;
    case SpatialRegionType::CARTOGRAPHIC_RECTANGLE:
    case SpatialRegionType::CARTOGRAPHIC_POLYGON:
      return false;  // handled by the usesCartographicSpace() path above
  }
  return false;
}

}  // namespace sdn_spatial_region
