// higherpop/vec3.hpp — minimal, header-only, inlineable 3-vector.
// Everything is constexpr/noexcept so the optimizer can vectorize RHS calls.
#pragma once
#include <cmath>

namespace hp {

struct Vec3 {
    double x{0}, y{0}, z{0};

    constexpr Vec3() = default;
    constexpr Vec3(double a, double b, double c) noexcept : x(a), y(b), z(c) {}

    constexpr Vec3 operator+(const Vec3& o) const noexcept { return {x+o.x, y+o.y, z+o.z}; }
    constexpr Vec3 operator-(const Vec3& o) const noexcept { return {x-o.x, y-o.y, z-o.z}; }
    constexpr Vec3 operator*(double s) const noexcept { return {x*s, y*s, z*s}; }
    constexpr Vec3 operator/(double s) const noexcept { return {x/s, y/s, z/s}; }
    constexpr Vec3& operator+=(const Vec3& o) noexcept { x+=o.x; y+=o.y; z+=o.z; return *this; }
    constexpr Vec3& operator-=(const Vec3& o) noexcept { x-=o.x; y-=o.y; z-=o.z; return *this; }
    constexpr Vec3& operator*=(double s) noexcept { x*=s; y*=s; z*=s; return *this; }
};

constexpr Vec3 operator*(double s, const Vec3& v) noexcept { return {s*v.x, s*v.y, s*v.z}; }
constexpr double dot(const Vec3& a, const Vec3& b) noexcept { return a.x*b.x + a.y*b.y + a.z*b.z; }
constexpr Vec3 cross(const Vec3& a, const Vec3& b) noexcept {
    return {a.y*b.z - a.z*b.y, a.z*b.x - a.x*b.z, a.x*b.y - a.y*b.x};
}
inline double norm(const Vec3& v) noexcept { return std::sqrt(dot(v, v)); }
inline Vec3 unit(const Vec3& v) noexcept { return v / norm(v); }

} // namespace hp
