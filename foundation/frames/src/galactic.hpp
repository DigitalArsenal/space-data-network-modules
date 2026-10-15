// The Galactic frame and the Sun's place in the Milky Way, evaluated in C++ in
// every runtime.
//
// AXES. The ICRS -> Galactic rotation is the one the Hipparcos catalogue
// defined (ESA SP-1200, 1997, Vol. 1, Sect. 1.5.3, eqs. 1.5.9-1.5.11): the
// north Galactic pole at ICRS RA 192.85948 deg, Dec +27.12825 deg and the
// Galactic longitude of the ascending node of the Galactic plane on the ICRS
// equator l_Omega = 32.93192 deg. Rows are the Galactic x (towards l = 0,
// b = 0), y (l = 90 deg) and z (the north Galactic pole) axes in ICRS; the
// matrix reproduces ESA's A_G' to 1e-16.
//
// THE SUN'S PLACE. Distance to the Galactic centre R0 = 8.178 kpc (GRAVITY
// Collaboration 2019, A&A 625, L10, from the S2 orbit about Sgr A*); height
// above the mid-plane z0 = 20.8 pc (Bennett & Bovy 2019, MNRAS 482, 1417).
// One parsec is 648000/pi au (IAU 2015 Resolution B2) and one au
// 149597870700 m (IAU 2012 Resolution B2).
//
// These are the frame and distances only; a renderer that draws the Milky Way
// as simple geometry takes its shape parameters from its own literature.

#ifndef SDN_FOUNDATION_FRAMES_GALACTIC_HPP
#define SDN_FOUNDATION_FRAMES_GALACTIC_HPP

#include <cmath>

namespace sdn {
namespace frames {
namespace galactic {

constexpr double kAuMeters = 149597870700.0;
constexpr double kParsecMeters = kAuMeters * 648000.0 / 3.14159265358979323846;
constexpr double kNgpRaDeg = 192.85948;
constexpr double kNgpDecDeg = 27.12825;
constexpr double kNodeLongitudeDeg = 32.93192;
constexpr double kSunToCentreParsecs = 8178.0;
constexpr double kSunHeightParsecs = 20.8;

/// ICRS -> Galactic, row-major: rows are the Galactic x, y, z axes in ICRS.
inline void icrs_to_galactic(double out[9]) {
    constexpr double deg = 3.14159265358979323846 / 180.0;
    const double a = kNgpRaDeg * deg, d = kNgpDecDeg * deg, l = kNodeLongitudeDeg * deg;
    const double z[3] = {std::cos(d) * std::cos(a), std::cos(d) * std::sin(a), std::sin(d)};
    const double n[3] = {-std::sin(a), std::cos(a), 0.0};
    const double zn[3] = {z[1] * n[2] - z[2] * n[1], z[2] * n[0] - z[0] * n[2], z[0] * n[1] - z[1] * n[0]};
    double x[3];
    for (int i = 0; i < 3; ++i) x[i] = std::cos(l) * n[i] - std::sin(l) * zn[i];
    const double y[3] = {z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]};
    for (int i = 0; i < 3; ++i) {
        out[i] = x[i];
        out[3 + i] = y[i];
        out[6 + i] = z[i];
    }
}

/// The Galactic centre (the mid-plane point below Sgr A*) relative to the Sun,
/// ICRS axes, metres: R0 along l = 0 in the plane, and z0 down the pole.
inline void centre_from_sun(double out[3]) {
    double m[9];
    icrs_to_galactic(m);
    const double r0 = kSunToCentreParsecs * kParsecMeters;
    const double z0 = kSunHeightParsecs * kParsecMeters;
    const double planar = std::sqrt(r0 * r0 - z0 * z0);
    for (int i = 0; i < 3; ++i) out[i] = planar * m[i] - z0 * m[6 + i];
}

}  // namespace galactic
}  // namespace frames
}  // namespace sdn

#endif  // SDN_FOUNDATION_FRAMES_GALACTIC_HPP
