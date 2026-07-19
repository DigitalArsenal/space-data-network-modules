#pragma once

// =============================================================================
// spatial_region_core.h — vendored geometry-region leaf predicates
// -----------------------------------------------------------------------------
// PROVENANCE (single source of truth stays in OrbPro; this is a vendored copy):
//   Source : OrbPro/packages/wasm-engine/Source/Analysis/SpatialRegion.{h,cpp}
//   Source commit (SpatialRegion.cpp last touch):
//            2c07554fc4fa896e0b2b9f886b0663aebb4ae2d2  (2026-03-09)
//   OrbPro checkout at vendor time:
//            a56f555b06ef6f448d953a88ec31044e6b2ca09f
//
// WHY VENDORED: the sensor-coverage module compiles as a single translation
//   unit (build-sdk-compiled-module.mjs concatenates all sharedCppSources +
//   module.cpp). The wasm-engine SpatialRegion plugin cannot be called from the
//   wasi-threads hot loop, and the sharedCppSources resolver rejects paths that
//   escape the modules repository, so the region math must live here.
//
// GUARDIAN-MANDATED SHAPE (area-targets Phase 0):
//   * Dedicated namespace `sdn_spatial_region` — declares NO TU-scope name that
//     module.cpp uses (PI / EPSILON / clamp / dot / Vec3 / normalize / ...).
//   * Registry parameter REMOVED from every leaf predicate and config setter.
//     Verified against SpatialRegion.cpp: the registry is only dereferenced for
//     UNION / INTERSECTION / DIFFERENCE composites, never for the four leaf
//     types (BOUNDING_SPHERE / CARTESIAN_BOX / CARTOGRAPHIC_RECTANGLE /
//     CARTOGRAPHIC_POLYGON).
//   * Composites (UNION / INTERSECTION / DIFFERENCE) are EXCLUDED in v1.
//   * Regions are constructed fully before any fan-out and are read-only during
//     accumulation; each target is owned by exactly one worker.
//
// Parity with the upstream SpatialRegion is a CI merge gate — see
// analysis/sensor-coverage/tests/spatial_region_parity.test.mjs, which fails if
// the upstream leaf math drifts from the pinned provenance hash above.
// =============================================================================

#include <cstdint>
#include <vector>

namespace sdn_spatial_region {

// Only the four leaf region types are supported in v1. Composite region types
// (UNION / INTERSECTION / DIFFERENCE) are intentionally omitted; they require the
// process-global registry and are deferred to v2.
enum class SpatialRegionType : uint8_t {
  BOUNDING_SPHERE = 0,
  CARTESIAN_BOX = 1,
  CARTOGRAPHIC_RECTANGLE = 2,
  CARTOGRAPHIC_POLYGON = 3
};

struct BoundingSphereRegionConfig {
  double centerX;
  double centerY;
  double centerZ;
  double radius;
};

struct CartesianBoxRegionConfig {
  double minimumX;
  double minimumY;
  double minimumZ;
  double maximumX;
  double maximumY;
  double maximumZ;
};

struct CartographicRectangleRegionConfig {
  double west;
  double south;
  double east;
  double north;
  double minHeight;
  double maxHeight;
};

struct CartographicPolygonRegionConfig {
  std::vector<double> positions;  // interleaved [lon, lat] radians
  double west;
  double south;
  double east;
  double north;
  double minHeight;
  double maxHeight;
  bool hasBoundingRectangle;
};

// A single geometry region. Constructed fully before fan-out and treated as
// read-only during coverage accumulation.
class SpatialRegion {
 public:
  explicit SpatialRegion(SpatialRegionType type);
  ~SpatialRegion() = default;

  SpatialRegionType getType() const { return type_; }
  int getTypeAsInt() const { return static_cast<int>(type_); }

  const BoundingSphereRegionConfig& getBoundingSphereConfig() const {
    return boundingSphereConfig_;
  }
  const CartesianBoxRegionConfig& getCartesianBoxConfig() const {
    return cartesianBoxConfig_;
  }
  const CartographicRectangleRegionConfig& getCartographicRectangleConfig()
      const {
    return cartographicRectangleConfig_;
  }
  const CartographicPolygonRegionConfig& getCartographicPolygonConfig() const {
    return cartographicPolygonConfig_;
  }

  void setBoundingSphereConfig(const BoundingSphereRegionConfig& config);
  void setCartesianBoxConfig(const CartesianBoxRegionConfig& config);
  void setCartographicRectangleConfig(
      const CartographicRectangleRegionConfig& config);
  void setCartographicPolygonConfig(const double* positions,
                                    uint32_t vertexCount, double minHeight,
                                    double maxHeight);

  // Leaf containment predicates. Unlike the upstream SpatialRegion these take
  // no SpatialRegionRegistry — the registry is a composite-only concern.
  bool containsWorldPoint(double x, double y, double z) const;
  bool containsCartographicPoint(double longitude, double latitude,
                                 double height) const;

 private:
  bool usesCartographicSpace() const;

  static bool cartesianToCartographic(double x, double y, double z,
                                      double& longitude, double& latitude,
                                      double& height);
  static double normalizeLongitudeRadians(double longitude);
  static bool longitudeInInterval(double longitude, double west, double east);
  static bool pointInsideCartographicRing(double longitude, double latitude,
                                          const std::vector<double>& positions);

  SpatialRegionType type_;
  BoundingSphereRegionConfig boundingSphereConfig_;
  CartesianBoxRegionConfig cartesianBoxConfig_;
  CartographicRectangleRegionConfig cartographicRectangleConfig_;
  CartographicPolygonRegionConfig cartographicPolygonConfig_;
};

}  // namespace sdn_spatial_region
