// The visible fraction of the solar disk from a point past a spherical
// occulting body: the conical model with the apparent-disk overlap area
// (umbra, penumbra and the annular antumbra), Montenbruck & Gill, Satellite
// Orbits (2000), Sec. 3.4.2, eqs. (3.85)-(3.87). It is the geometry of
// Orekit's SolarRadiationPressure lighting ratio.
//
// The overlap is evaluated as two circular segments, R^2 (t - sin t)/2 with
// t twice the half-angle subtended by the common chord, rather than as the
// textbook difference a^2 acos(x/a) + b^2 acos((c-x)/b) - c y. Here the
// body's disk (tens of degrees) dwarfs the Sun's (0.27 deg), and the textbook
// form loses about seven digits to cancellation between its last two terms,
// which shows as noise in finite differences of the force.
//
// Generic over the scalar so that force_models.cpp (double) and the analytic
// partials in force_partials.cpp (forward-mode dual numbers) evaluate one
// function. A scalar type needs + - * /, sqrt, sin and atan2 found by
// argument-dependent lookup, and scalarValue() returning its double value.
#pragma once

#include <cmath>

namespace astro {
namespace shadow {

// The nominal solar radius of IAU 2015 Resolution B3, as Orekit uses; the
// radiation pressure's 1361 W/m^2 is the same resolution's nominal irradiance.
constexpr double SUN_RADIUS_KM = 695700.0;

inline double scalarValue(double x) { return x; }

// t - sin(t), without cancellation for small t.
template <class S>
S tMinusSin(const S& t) {
    using std::sin;
    if (std::abs(scalarValue(t)) > 0.25) return t - sin(t);
    const S t2 = t * t;
    // t^3/6 (1 - t^2/20 (1 - t^2/42 (1 - t^2/72 (1 - t^2/110))))
    return t * t2 / S(6.0) *
           (S(1.0) - t2 / S(20.0) * (S(1.0) - t2 / S(42.0) * (S(1.0) - t2 / S(72.0) * (S(1.0) - t2 / S(110.0)))));
}

// satDistance: |r|, the point from the occulting body's centre (km).
// sunDistance: |s - r|, the point to the Sun's centre (km).
// sinSeparation, cosSeparation: any common positive multiple of the sine and
//   cosine of the angle at the point between the directions to the body's
//   centre and to the Sun's centre, e.g. |r x (s-r)| and -r.(s-r).
// Returns 1 in full sunlight, 0 in umbra.
template <class S>
S visibleSunFraction(const S& satDistance, const S& sunDistance, const S& sinSeparation,
                     const S& cosSeparation, double bodyRadius,
                     double sunRadius = SUN_RADIUS_KM) {
    using std::atan2;
    using std::sqrt;
    const S one(1.0), zero(0.0);
    auto asinS = [&](const S& x) { const S q = one - x * x; return atan2(x, scalarValue(q) > 0.0 ? sqrt(q) : zero); };

    const S a = asinS(S(sunRadius) / sunDistance);    // apparent Sun radius
    const S b = asinS(S(bodyRadius) / satDistance);   // apparent body radius
    const S c = atan2(sinSeparation, cosSeparation);  // separation of the centres
    const double av = scalarValue(a), bv = scalarValue(b), cv = scalarValue(c);
    if (cv >= av + bv) return one;                    // disks apart
    if (cv <= bv - av) return zero;                   // Sun behind the body: umbra
    if (cv <= av - bv) return one - (b * b) / (a * a);  // body inside the Sun's disk
    // Partial overlap. The common chord lies x from the Sun's centre and
    // c - x from the body's, with half-length y.
    const S cb = (c - b) * (c + b);
    const S x = (cb + a * a) / (S(2.0) * c);
    const S xb = (c * c - a * a + b * b) / (S(2.0) * c);  // c - x
    const S y2 = (a - x) * (a + x);
    const S y = scalarValue(y2) > 0.0 ? sqrt(y2) : zero;
    const S area = a * a * tMinusSin(S(2.0) * atan2(y, x)) / S(2.0) +
                   b * b * tMinusSin(S(2.0) * atan2(y, xb)) / S(2.0);
    return one - area / (S(3.14159265358979323846) * a * a);
}

}  // namespace shadow
}  // namespace astro
