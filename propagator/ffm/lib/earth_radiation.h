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
#include <vector>

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

/// The albedo (with `albedo` true) or emissivity coefficients `deltaT`
/// seconds after the reference epoch: X0, X1 (annual) and X2. They depend on
/// time only, so one evaluation computes them once for all its elements.
struct Zonal { double x0, x1, x2; };
inline Zonal zonalCoefficients(bool albedo, double deltaT) {
    const double w = TWO_PI_K / JULIAN_YEAR_S * deltaT;
    const double x1 = albedo ? C0 + C1 * std::cos(w) + C2 * std::sin(w) : K0 + K1 * std::cos(w) + K2 * std::sin(w);
    return {albedo ? A0 : E0, x1, albedo ? A2 : E2};
}
/// X0 + X1 P1(s) + X2 P2(s) at s = sin(latitude).
template <class S>
S zonal(const Zonal& z, const S& sinPhi) {
    return sinPhi * z.x1 + (sinPhi * sinPhi * 3.0 - 1.0) * (0.5 * z.x2) + z.x0;
}

/// Rotation of v about the unit axis k, right-handed (Hipparchus Rotation,
/// VECTOR_OPERATOR convention), by the angle whose cosine and sine are c, s.
template <class V>
V rotate(const V& v, const V& k, double c, double s) {
    return v * c + cross(k, v) * s + k * (dot(k, v) * (1.0 - c));
}

/// The surface elements' angles for one `resolution` (rad): the crowns'
/// offsets from the sub-satellite point out to a quarter turn and the sectors'
/// offsets about it, each with its cosine and sine, accumulated exactly as
/// the element loops step them. They depend on the resolution only.
struct Angle { double offset, c, s; };
struct Elements {
    double resolution = -1, cosResolution = 0, sinHalfResolution = 0;
    std::vector<Angle> crowns, sectors;
};
inline const Elements& elements(double resolution) {
    static thread_local Elements e;
    if (e.resolution == resolution) return e;
    e.resolution = resolution;
    e.cosResolution = std::cos(resolution);
    e.sinHalfResolution = std::sin(0.5 * resolution);
    e.crowns.clear();
    e.sectors.clear();
    for (double eastOffset = 1.5 * resolution; eastOffset < 0.5 * PI_K; eastOffset += resolution)
        e.crowns.push_back({eastOffset, std::cos(eastOffset), std::sin(eastOffset)});
    for (double radialOffset = 0.5 * resolution; radialOffset < TWO_PI_K; radialOffset += resolution)
        e.sectors.push_back({radialOffset, std::cos(radialOffset), std::sin(radialOffset)});
    return e;
}

/// One element's contribution to the radiation pressure vector (N/m^2) at
/// `sat` (m): the element at `center` (m) of area `area` (m^2).
template <class V, class S>
V elementPressure(const V& sat, const S& satNorm, const V& center, const V& sun, double sunNorm,
                  double solarFlux, const Zonal& albedo, const Zonal& emissivity, double area) {
    const S centerNorm = norm(center);
    const S cosAlpha = dot(center, sat) / (centerNorm * satNorm);
    if (!(scalarValue(cosAlpha) > 0)) return V();
    const S sinPhi = center.z / centerNorm;
    const S e = zonal<S>(emissivity, sinPhi);
    const S cosSun = dot(center, sun) / (centerNorm * sunNorm);
    const S a = scalarValue(cosSun) > 0 ? zonal<S>(albedo, sinPhi) : S(0.0);
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
    const Elements& grid = elements(resolution);
    const Zonal albedo = zonalCoefficients(true, deltaT), emissivity = zonalCoefficients(false, deltaT);
    const double centerArea = TWO_PI_K * radius * radius * (1.0 - grid.cosResolution);
    V flux = elementPressure<V, S>(sat, satNorm, ground, sun, sunNorm, solarFlux, albedo, emissivity, centerArea);
    const double horizon = std::asin(radius / scalarValue(satNorm));
    for (const Angle& crown : grid.crowns) {
        if (!(crown.offset < horizon)) break;
        const V first = rotate(ground, east, crown.c, crown.s);
        const double sectorArea = radius * radius * 2.0 * resolution * grid.sinHalfResolution * crown.s;
        for (const Angle& sector : grid.sectors)
            flux = flux + elementPressure<V, S>(sat, satNorm, rotate(first, groundAxis, sector.c, sector.s), sun, sunNorm, solarFlux, albedo, emissivity, sectorArea);
    }
    return flux;
}

}  // namespace knocke
}  // namespace ForceModel
}  // namespace astro
