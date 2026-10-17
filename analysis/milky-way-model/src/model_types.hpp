#pragma once

#include <algorithm>
#include <cmath>

namespace milky_way {

// Positions and lengths use kpc in a right-handed Galactocentric frame:
// +x is toward the center from the Sun, +y toward Galactic longitude 90 deg,
// and +z toward the north Galactic pole. The center is the origin.
struct Vec3 { double x = 0, y = 0, z = 0; };
inline Vec3 operator+(Vec3 a, Vec3 b) { return {a.x+b.x,a.y+b.y,a.z+b.z}; }
inline Vec3 operator-(Vec3 a, Vec3 b) { return {a.x-b.x,a.y-b.y,a.z-b.z}; }
inline Vec3 operator*(Vec3 a, double s) { return {a.x*s,a.y*s,a.z*s}; }
inline Vec3 operator*(double s, Vec3 a) { return a*s; }
inline double dot(Vec3 a, Vec3 b) { return a.x*b.x+a.y*b.y+a.z*b.z; }
inline double length(Vec3 a) { return std::sqrt(dot(a,a)); }
inline Vec3 normalized(Vec3 a) { const double n=length(a); return n>0?a*(1/n):Vec3{}; }

// Three linear emissivity channels per kpc and extinction optical depth/kpc.
// Legacy RGB is a display model; literature channels are G, BP and RP.
struct Field { double r = 0, g = 0, b = 0, kappa = 0; };
inline Field operator+(Field a, Field b) { return {a.r+b.r,a.g+b.g,a.b+b.b,a.kappa+b.kappa}; }
inline Field operator*(Field a, double s) { return {a.r*s,a.g*s,a.b*s,a.kappa*s}; }
inline Field mix(Field a, Field b, double t) { return a*(1-t)+b*t; }
inline double clamp01(double a) { return std::clamp(a,0.0,1.0); }
inline double smoothstep(double a, double b, double x) {
  const double t=clamp01((x-a)/(b-a)); return t*t*(3-2*t);
}

} // namespace milky_way
