// Earth radiation pressure: the sunlight the Earth reflects (albedo) and the
// infrared it emits, on an isotropic (cannonball) spacecraft. Knocke, Ries
// and Tapley (1988), "Earth radiation pressure effects on satellites", AIAA
// paper 88-4292: albedo and emissivity zonal to the second Legendre degree,
// with the annual term of the first, summed over elements of the Earth's
// surface the spacecraft sees.
//
// A port of Orekit 13.1 KnockeRediffusedForceModel (CS GROUP, Apache-2.0):
// the same constants, the same surface elements (a central cap of half-angle
// `resolution` around the sub-satellite point, then crowns of width
// `resolution` cut into sectors of angular width `resolution`, out to the
// horizon), the same flux per element, and the radiation pressure turned into
// an acceleration as Orekit's IsotropicRadiationSingleCoefficient does
// (Cr*A/m times the pressure vector). One template for every scalar type, so
// the integrator's double evaluation and the STM's dual-number evaluation are
// one implementation.
#pragma once

#include <cmath>

#include "astrodynamics_types.h"

namespace astro {
namespace ForceModel {
namespace knocke {

constexpr double ES_COEFF = 4.5606e-6;             // solar radiation pressure at 1 AU, N/m^2
constexpr double A0 = 0.34, C0 = 0.0, C1 = 0.10, C2 = 0.0, A2 = 0.29;   // albedo
constexpr double E0 = 0.68, K0 = 0.0, K1 = -0.07, K2 = 0.0, E2 = -0.18; // emissivity
constexpr double JULIAN_YEAR_S = 365.25 * 86400.0;
constexpr double ASTRONOMICAL_UNIT_M = 149597870700.0;   // IAU 2012 (Orekit JPL_SSD_ASTRONOMICAL_UNIT)
constexpr double SPEED_OF_LIGHT_M_S = 299792458.0;
constexpr double TWO_PI_K = 6.283185307179586476925286766559;
constexpr double PI_K = 3.1415926535897932384626433832795;
/// The coefficients' reference epoch, 1981-12-22T00:00:00 UTC, as a TT
/// Julian date (TAI - UTC was 20 s; TT = TAI + 32.184 s).
constexpr double REFERENCE_EPOCH_JD_TT = 2444960.5 + 52.184 / 86400.0;

using std::sqrt;
inline double scalarValue(double a) { return a; }
// The vector operations the template uses, for the double evaluation; the
// STM's dual-number vector supplies its own (lib/force_partials.cpp).
inline double dot(const Vec3& a, const Vec3& b) { return a.dot(b); }
inline Vec3 cross(const Vec3& a, const Vec3& b) { return a.cross(b); }
inline double norm(const Vec3& a) { return a.magnitude(); }

/// Albedo (with `albedo` true) or emissivity at sin(latitude), `deltaT`
/// seconds after the reference epoch: X0 + X1 P1(s) + X2 P2(s), X1 annual.
template <class S>
S zonal(bool albedo, double deltaT, const S& sinPhi) {
    const double w = TWO_PI_K / JULIAN_YEAR_S * deltaT;
    const double x1 = albedo ? C0 + C1 * std::cos(w) + C2 * std::sin(w) : K0 + K1 * std::cos(w) + K2 * std::sin(w);
    const double x0 = albedo ? A0 : E0, x2 = albedo ? A2 : E2;
    return sinPhi * x1 + (sinPhi * sinPhi * 3.0 - 1.0) * (0.5 * x2) + x0;
}

/// Rotation of v by `angle` (rad) about the unit axis k, right-handed
/// (Hipparchus Rotation, VECTOR_OPERATOR convention).
template <class V>
V rotate(const V& v, const V& k, double angle) {
    const double c = std::cos(angle), s = std::sin(angle);
    return v * c + cross(k, v) * s + k * (dot(k, v) * (1.0 - c));
}

/// One element's contribution to the radiation pressure vector (N/m^2) at
/// `sat` (m): the element at `center` (m) of area `area` (m^2).
template <class V, class S>
V elementPressure(const V& sat, const S& satNorm, const V& center, const V& sun, double sunNorm,
                  double solarFlux, double deltaT, double area) {
    const S centerNorm = norm(center);
    const S cosAlpha = dot(center, sat) / (centerNorm * satNorm);
    if (!(scalarValue(cosAlpha) > 0)) return V();
    const S sinPhi = center.z / centerNorm;
    const S e = zonal<S>(false, deltaT, sinPhi);
    const S cosSun = dot(center, sun) / (centerNorm * sunNorm);
    const S a = scalarValue(cosSun) > 0 ? zonal<S>(true, deltaT, sinPhi) : S(0.0);
    const S albedoAndIr = a * solarFlux * cosSun + e * (solarFlux * 0.25);
    const V r = sat - center;
    const S rNorm = norm(r);
    return r * (area * cosAlpha / (rNorm * rNorm * rNorm * PI_K) * albedoAndIr / SPEED_OF_LIGHT_M_S);
}

/// The Earth radiation pressure vector (N/m^2) at `sat` (m, Earth-centred
/// inertial axes) with the Sun at `sun` (m, same axes), `deltaT` seconds after
/// the reference epoch, elements of angular size `resolution` (rad) on a
/// sphere of radius `radius` (m). Multiply by Cr*A/m for the acceleration.
template <class V, class S>
V pressure(const V& sat, const V& sun, double deltaT, double resolution, double radius) {
    const S satNorm = norm(sat);
    const double sunNorm = scalarValue(norm(sun));
    const double distanceAu = sunNorm / ASTRONOMICAL_UNIT_M;
    const double solarFlux = ES_COEFF * SPEED_OF_LIGHT_M_S / (distanceAu * distanceAu);
    const V ground = sat * (radius / satNorm);
    const V groundAxis = sat * (S(1.0) / satNorm);
    const S q = S(1.0) / sqrt(sat.x * sat.x + sat.y * sat.y);
    const V east(-(q * sat.y), q * sat.x, S(0.0));
    const double centerArea = TWO_PI_K * radius * radius * (1.0 - std::cos(resolution));
    V flux = elementPressure<V, S>(sat, satNorm, ground, sun, sunNorm, solarFlux, deltaT, centerArea);
    const double horizon = std::asin(radius / scalarValue(satNorm));
    for (double eastOffset = 1.5 * resolution; eastOffset < horizon; eastOffset += resolution) {
        const V first = rotate(ground, east, eastOffset);
        const double sectorArea = radius * radius * 2.0 * resolution * std::sin(0.5 * resolution) * std::sin(eastOffset);
        for (double radialOffset = 0.5 * resolution; radialOffset < TWO_PI_K; radialOffset += resolution)
            flux = flux + elementPressure<V, S>(sat, satNorm, rotate(first, groundAxis, radialOffset), sun, sunNorm, solarFlux, deltaT, sectorArea);
    }
    return flux;
}

}  // namespace knocke
}  // namespace ForceModel
}  // namespace astro
