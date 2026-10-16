// ── THE BODY A TILESET IS CUT ON ────────────────────────────────────────────
//
// Inlined into terrain_source_module.cpp by source.mjs (one translation unit).
//
// A terrain tile's header geometry (ECEF centre, bounding sphere, horizon
// occlusion point) and its vertex normals are positions on a body, so the
// body's reference surface is an input, not a constant. Earth keeps the WGS84
// numbers verbatim and every expression below keeps the order it had when they
// were constants, so an Earth tile's doubles - and therefore its bytes - are
// unchanged. Another body is accepted only as a REFERENCE SPHERE (one radius):
// on a spheroid, planetocentric latitude (how planetary DEMs are posted) and
// the engine's geodetic latitude differ, and that conversion is not modelled
// here, so a two- or three-radius body is refused by the caller.
struct BodyShape {
    double a;  // equatorial radius, metres
    double b;  // polar radius, metres
};

constexpr BodyShape kEarthShape{6378137.0, 6356752.3142451793};

constexpr double kPi = 3.14159265358979323846;

struct Vec3 {
    double x = 0, y = 0, z = 0;
};

Vec3 geodetic_to_ecef(const BodyShape& shape, double lat_deg, double lon_deg, double height_m) {
    const double lat = lat_deg * kPi / 180.0;
    const double lon = lon_deg * kPi / 180.0;
    const double e2 = 1.0 - (shape.b * shape.b) / (shape.a * shape.a);
    const double sin_lat = std::sin(lat);
    const double n = shape.a / std::sqrt(1.0 - e2 * sin_lat * sin_lat);
    Vec3 v;
    v.x = (n + height_m) * std::cos(lat) * std::cos(lon);
    v.y = (n + height_m) * std::cos(lat) * std::sin(lon);
    v.z = (n * (1.0 - e2) + height_m) * sin_lat;
    return v;
}

// Horizon occlusion point per the quantized-mesh spec (Cesium's
// EllipsoidalOccluder.computeHorizonCullingPoint): work in ellipsoid-scaled
// space, take the max occlusion magnitude along the scaled direction to the
// tile centre over every vertex, and RETURN THE SCALED-SPACE POINT. On a body
// the scaling is that body's radii, so the point lies on the body's own unit
// sphere and the engine's occluder for that body reads it unchanged.
//
// IT IS NOT UNSCALED. The wire field is read verbatim by
// CesiumTerrainProvider into QuantizedMeshTerrainData._horizonOcclusionPoint
// and handed to EllipsoidalOccluder.isScaledSpacePointVisible as the
// literally-named `occludeePointInScaledSpace`; Cesium's own
// magnitudeToPoint() returns direction * magnitude and never multiplies the
// radii back in. Multiplying them back in (which this function did until
// 2026-08-26) makes |point| ~6.37e6 instead of ~1, and the visibility test
// then degenerates into a camera-only expression that is INVARIANT under
// scaling of the occludee: horizon culling silently stops working and the
// client over-fetches back-side terrain. Every stored tile's payload DIGEST
// and ETAG are taken over these bytes, so changing it re-encodes the pyramid.
Vec3 horizon_occlusion_point(const BodyShape& shape, const std::vector<Vec3>& positions,
                             const Vec3& center) {
    Vec3 scaled_center{center.x / shape.a, center.y / shape.a, center.z / shape.b};
    const double c_mag =
        std::sqrt(scaled_center.x * scaled_center.x + scaled_center.y * scaled_center.y +
                  scaled_center.z * scaled_center.z);
    Vec3 dir{0, 0, 1};
    if (c_mag > 0) dir = {scaled_center.x / c_mag, scaled_center.y / c_mag, scaled_center.z / c_mag};
    double max_magnitude = 0.0;
    for (const Vec3& p : positions) {
        Vec3 sp{p.x / shape.a, p.y / shape.a, p.z / shape.b};
        double mag_sq = sp.x * sp.x + sp.y * sp.y + sp.z * sp.z;
        double mag = std::sqrt(mag_sq);
        Vec3 unit = mag > 0 ? Vec3{sp.x / mag, sp.y / mag, sp.z / mag} : Vec3{0, 0, 0};
        mag_sq = std::max(1.0, mag_sq);
        mag = std::max(1.0, mag);
        const double cos_alpha = unit.x * dir.x + unit.y * dir.y + unit.z * dir.z;
        const Vec3 cross{unit.y * dir.z - unit.z * dir.y, unit.z * dir.x - unit.x * dir.z,
                         unit.x * dir.y - unit.y * dir.x};
        const double sin_alpha =
            std::sqrt(cross.x * cross.x + cross.y * cross.y + cross.z * cross.z);
        const double cos_beta = 1.0 / mag;
        const double sin_beta = std::sqrt(mag_sq - 1.0) * cos_beta;
        const double denom = cos_alpha * cos_beta - sin_alpha * sin_beta;
        if (denom <= 0) continue;  // point occludes the whole horizon direction
        max_magnitude = std::max(max_magnitude, 1.0 / denom);
    }
    // Degenerate input (every vertex occluding the whole direction) leaves the
    // magnitude unset; the scaled centre itself is the honest fallback rather
    // than a zero vector, which reads on the wire as "always visible".
    if (!(max_magnitude > 0.0)) max_magnitude = c_mag > 0 ? c_mag : 1.0;
    return {dir.x * max_magnitude, dir.y * max_magnitude, dir.z * max_magnitude};
}
