// A frame's ground footprint (four corners, degrees) from an ST 0601 packet:
// the stated corners (tags 82-89), else the frame centre plus the corner
// offsets (23/24 + 26-33), else the sensor's four corner rays intersected
// with the WGS84 ellipsoid raised to the frame-centre elevation (tag 25).
//
// Pose: platform heading, pitch, roll (NED, applied yaw-pitch-roll), then the
// sensor's relative azimuth, elevation and roll, the same way; a corner ray
// is the boresight tilted by half the horizontal and vertical fields of view.
// The platform height is the ellipsoid height (tag 75) when stated, else the
// MSL altitude (tag 15), which can differ by tens of metres (the geoid).
// A frame whose corner rays do not all reach the ground has no footprint.
#pragma once
#include <cmath>
#include <optional>

#include "klv.hpp"

namespace ground {

constexpr double kA = 6378137.0;
constexpr double kF = 1.0 / 298.257223563;
constexpr double kPi = 3.14159265358979323846;
constexpr double kRad = kPi / 180.0;

struct V3 {
  double x, y, z;
};
inline V3 add(V3 a, V3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
inline V3 scale(V3 a, double s) { return {a.x * s, a.y * s, a.z * s}; }
inline double dot(V3 a, V3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

struct M3 {
  double m[3][3];
  V3 apply(V3 v) const {
    return {m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z, m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z,
            m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z};
  }
  M3 times(const M3& o) const {
    M3 r{};
    for (int i = 0; i < 3; ++i)
      for (int j = 0; j < 3; ++j)
        r.m[i][j] = m[i][0] * o.m[0][j] + m[i][1] * o.m[1][j] + m[i][2] * o.m[2][j];
    return r;
  }
};

// Body -> NED for yaw (about down), pitch (about right), roll (about forward), degrees.
inline M3 yawPitchRoll(double yaw, double pitch, double roll) {
  const double cy = std::cos(yaw * kRad), sy = std::sin(yaw * kRad);
  const double cp = std::cos(pitch * kRad), sp = std::sin(pitch * kRad);
  const double cr = std::cos(roll * kRad), sr = std::sin(roll * kRad);
  const M3 z{{{cy, -sy, 0}, {sy, cy, 0}, {0, 0, 1}}};
  const M3 y{{{cp, 0, sp}, {0, 1, 0}, {-sp, 0, cp}}};
  const M3 x{{{1, 0, 0}, {0, cr, -sr}, {0, sr, cr}}};
  return z.times(y).times(x);
}

inline V3 geodeticToEcef(double lat, double lon, double h) {
  const double e2 = kF * (2.0 - kF);
  const double sl = std::sin(lat * kRad), cl = std::cos(lat * kRad);
  const double n = kA / std::sqrt(1.0 - e2 * sl * sl);
  return {(n + h) * cl * std::cos(lon * kRad), (n + h) * cl * std::sin(lon * kRad), (n * (1.0 - e2) + h) * sl};
}

// Geodetic latitude and longitude (degrees) of an ECEF point (Bowring's iteration).
inline void ecefToGeodetic(V3 p, double* lat, double* lon) {
  const double e2 = kF * (2.0 - kF);
  const double b = kA * (1.0 - kF);
  const double ep2 = (kA * kA - b * b) / (b * b);
  const double r = std::sqrt(p.x * p.x + p.y * p.y);
  double beta = std::atan2(p.z, (1.0 - kF) * r);
  double phi = 0.0;
  for (int i = 0; i < 5; ++i) {
    const double sb = std::sin(beta), cb = std::cos(beta);
    phi = std::atan2(p.z + ep2 * b * sb * sb * sb, r - e2 * kA * cb * cb * cb);
    beta = std::atan2((1.0 - kF) * std::sin(phi), std::cos(phi));
  }
  *lat = phi / kRad;
  *lon = std::atan2(p.y, p.x) / kRad;
}

// First positive intersection of origin + t*dir with the ellipsoid raised by h.
inline std::optional<V3> hitEllipsoid(V3 origin, V3 dir, double h) {
  const double a = kA + h;
  const double b = kA * (1.0 - kF) + h;
  const V3 o{origin.x / a, origin.y / a, origin.z / b};
  const V3 d{dir.x / a, dir.y / a, dir.z / b};
  const double qa = dot(d, d);
  const double qb = 2.0 * dot(o, d);
  const double qc = dot(o, o) - 1.0;
  const double disc = qb * qb - 4.0 * qa * qc;
  if (disc < 0.0 || qa <= 0.0) return std::nullopt;
  const double root = std::sqrt(disc);
  double t = (-qb - root) / (2.0 * qa);
  if (t <= 0.0) t = (-qb + root) / (2.0 * qa);
  if (t <= 0.0) return std::nullopt;
  return add(origin, scale(dir, t));
}

enum class Source { None, Corners, Offsets, Rays };

struct Footprint {
  Source source = Source::None;
  double quad[8] = {0};  // LL, LR, UR, UL (lon, lat)
};

inline bool inRange(double lat, double lon) { return lat > -90.0 && lat < 90.0 && lon >= -180.0 && lon <= 180.0; }

// ST 0601 point k (1 upper left, 2 upper right, 3 lower right, 4 lower left) -> quad slot.
constexpr int kSlot[4] = {3, 2, 1, 0};

inline Footprint footprint(const klv::Packet& p) {
  Footprint f;
  bool full = true;
  for (int k = 0; k < 4; ++k) full = full && p.cornerLat[k] && p.cornerLon[k];
  if (full) {
    for (int k = 0; k < 4; ++k) {
      f.quad[2 * kSlot[k]] = *p.cornerLon[k];
      f.quad[2 * kSlot[k] + 1] = *p.cornerLat[k];
    }
    f.source = Source::Corners;
    return f;
  }
  bool offsets = p.centerLat && p.centerLon;
  for (int k = 0; k < 4; ++k) offsets = offsets && p.offsetLat[k] && p.offsetLon[k];
  if (offsets) {
    for (int k = 0; k < 4; ++k) {
      f.quad[2 * kSlot[k]] = *p.centerLon + *p.offsetLon[k];
      f.quad[2 * kSlot[k] + 1] = *p.centerLat + *p.offsetLat[k];
    }
    f.source = Source::Offsets;
    return f;
  }
  const auto height = p.sensorAltHae ? p.sensorAltHae : p.sensorAltMsl;
  if (!(p.sensorLat && p.sensorLon && height && p.hfov && p.vfov && p.heading && p.sensorAz && p.sensorEl)) return f;
  const double lat = *p.sensorLat, lon = *p.sensorLon;
  const V3 origin = geodeticToEcef(lat, lon, *height);
  const double sl = std::sin(lat * kRad), cl = std::cos(lat * kRad);
  const double so = std::sin(lon * kRad), co = std::cos(lon * kRad);
  const V3 north{-sl * co, -sl * so, cl};
  const V3 east{-so, co, 0.0};
  const V3 down{-cl * co, -cl * so, -sl};
  const M3 platform = yawPitchRoll(*p.heading, p.pitch.value_or(0.0), p.roll.value_or(0.0));
  const M3 sensor = yawPitchRoll(*p.sensorAz, *p.sensorEl, p.sensorRoll.value_or(0.0));
  const M3 toNed = platform.times(sensor);
  const double th = std::tan(0.5 * *p.hfov * kRad);
  const double tv = std::tan(0.5 * *p.vfov * kRad);
  // Sensor frame: x along the boresight, y right, z down (image up is -z).
  const double corner[4][2] = {{-th, -tv}, {th, -tv}, {th, tv}, {-th, tv}};  // points 1-4
  const double elevation = p.centerElev.value_or(0.0);
  for (int k = 0; k < 4; ++k) {
    const V3 ned = toNed.apply({1.0, corner[k][0], corner[k][1]});
    const V3 dir = add(add(scale(north, ned.x), scale(east, ned.y)), scale(down, ned.z));
    const auto hit = hitEllipsoid(origin, dir, elevation);
    if (!hit) return Footprint{};
    double hl = 0, ho = 0;
    ecefToGeodetic(*hit, &hl, &ho);
    if (!inRange(hl, ho)) return Footprint{};
    f.quad[2 * kSlot[k]] = ho;
    f.quad[2 * kSlot[k] + 1] = hl;
  }
  f.source = Source::Rays;
  return f;
}

}  // namespace ground
