// Radiation pressure on GNSS satellites: the a priori box-wing model of the
// GPS blocks and CODE's extended empirical orbit model (ECOM2), both under
// the conical Earth shadow of lib/shadow.h.
//
// Box-wing (Rodriguez-Solano, Hugentobler, Steigenberger 2012, "Adjustable
// box-wing model for solar radiation pressure impacting GPS satellites",
// Adv. Space Res. 49(7):1113-1128, doi:10.1016/j.asr.2012.01.016, reprinted
// as P-II of Rodriguez-Solano 2014, "Impact of non-conservative force
// modeling on GNSS satellite orbits and global solutions", dissertation, TU
// Munich, urn:nbn:de:bvb:91-diss-20140630-1188612-0-4):
//   flat surface, eq. (6):  f = -(A P / M) cos(t) [(1 - rho) eD + 2 (delta/3 + rho cos(t)) eN]
//   bus surface with the absorbed energy re-emitted at once as Lambertian
//   heat, eq. (9):          f = -(A P / M) cos(t) [(alpha + delta)(eD + 2/3 eN) + 2 rho cos(t) eN]
// with alpha absorbed, rho specularly reflected, delta diffusely reflected
// (alpha + rho + delta = 1), eD the unit vector to the Sun, eN the outward
// surface normal, cos(t) = eD . eN >= 0, and P the radiation pressure at the
// satellite's distance from the Sun. The panels use eq. (6), the bus eq. (9).
//
// Attitude: nominal yaw steering (Rodriguez-Solano 2014, Sec. 5.1.1; Arnold
// et al. 2015, Sec. 4.1): +Z toward the Earth's centre, +Y along the solar
// panel axis, perpendicular to the Earth-satellite-Sun plane, Y = unit(s x r)
// with s the geocentric Sun, X = Y x Z on the Sun's side. The panels turn
// about Y to face the Sun as nearly as they can (exactly, in nominal yaw).
// Noon and midnight turns (the eclipse-season yaw manoeuvres) are not
// modelled: the yaw is nominal everywhere.
//
// ECOM2 (Arnold, Meindl, Beutler, Dach, Schaer, Lutz, Prange, Sosnica,
// Mervart, Jaggi 2015, "CODE's new solar radiation pressure model for GNSS
// orbit determination", J. Geod. 89:775-791, doi:10.1007/s00190-015-0814-4):
//   eD = unit(rs - r), eY = -unit(er x eD), eB = eD x eY        eq. (1)
//   a  = D(du) eD + Y0 eY + B(du) eB                            eq. (2)
//   D  = D0 + sum_i D2i,c cos(2i du) + D2i,s sin(2i du)
//   B  = B0 + sum_i B2i-1,c cos((2i-1) du) + B2i-1,s sin((2i-1) du)  eq. (5)
// du = u - us, the satellite's argument of latitude from the Sun's in the
// orbital plane. The paper leaves eclipses to the implementation; here the
// empirical acceleration, like the physical one, is scaled by the visible
// fraction of the Sun (zero in umbra). Coefficients are m/s^2, constant
// (no 1/r^2 scaling with the Sun's distance), as Orekit's ECOM2 holds them.
//
// Generic over the scalar like lib/shadow.h, so force_models.cpp (double)
// and the analytic partials in force_partials.cpp (forward dual numbers)
// evaluate one function. A scalar needs + - * /, sqrt, sin, cos, atan2 by
// argument-dependent lookup and scalarValue() returning its double value.
#pragma once

#include <cstdint>

#include "shadow.h"

namespace astro {
namespace gnss_srp {

/// One surface's area (m^2) and the fractions of incoming photons it absorbs
/// and reflects specularly and diffusely (they sum to one).
struct Surface {
    double area{0};
    double absorbed{0};
    double specular{0};
    double diffuse{0};
};

/// A box-wing spacecraft in the body frame above: the six bus faces and the
/// solar panels (the total area of both wings, Sun side).
struct BoxWing {
    Surface plusX, minusX, plusY, minusY, plusZ, minusZ, panels;
};

/// GPS blocks with a published a priori box-wing model. IIR-M flies the
/// IIR bus and arrays and takes the IIR model.
enum class GpsBlock : uint8_t { IIR = 1, IIR_M = 2, IIF = 3 };

/// The a priori box-wing models of Rodriguez-Solano (2014), Appendix,
/// Table 5.4 (GPS-IIR, after Fliegel and Gallini 1996) and Table 5.5
/// (GPS-IIF), surface by surface: area, alpha (absorbed), rho (specular),
/// delta (diffuse). The tables print delta as "reflection" and rho as
/// "diffusion" in their legend's order; Sec. 5.1.2 defines delta reflected
/// and rho diffused there, so the columns read alpha, specular, diffuse.
inline BoxWing GpsBoxWing(GpsBlock block) {
    BoxWing b;
    if (block == GpsBlock::IIF) {
        const Surface white{0, 0.440, 0.448, 0.112};
        b.plusZ = white;  b.plusZ.area = 5.400;
        b.minusZ = {5.400, 1.000, 0.000, 0.000};
        b.plusY = white;  b.plusY.area = 7.010;
        b.minusY = b.plusY;
        b.plusX = white;  b.plusX.area = 5.720;
        b.minusX = b.plusX;
        b.panels = {22.250, 0.770, 0.035, 0.195};
    } else {
        const Surface bus{0, 0.940, 0.060, 0.000};
        b.plusZ = bus;  b.plusZ.area = 4.250;
        b.minusZ = b.plusZ;
        b.plusY = bus;  b.plusY.area = 4.460;
        b.minusY = b.plusY;
        b.plusX = bus;  b.plusX.area = 4.110;
        b.minusX = b.plusX;
        b.panels = {13.920, 0.707, 0.044, 0.249};
    }
    return b;
}

/// ECOM2 coefficients, m/s^2: D0, Y0, B0 and the cosine and sine terms of
/// orders 2 and 4 in D and 1 and 3 in B (Arnold et al. 2015, eq. 5 with
/// nD = nB = 2).
struct Ecom2 {
    bool enabled{false};
    double D0{0}, Y0{0}, B0{0};
    double Dc[2]{}, Ds[2]{};  // orders 2, 4
    double Bc[2]{}, Bs[2]{};  // orders 1, 3
};

/// One ECOM2 coefficient (the order the dynamic parameters name them).
enum class Ecom2Term : uint8_t { D0, Y0, B0, D2c, D2s, D4c, D4s, B1c, B1s, B3c, B3s };

inline double& Ecom2Coefficient(Ecom2& e, Ecom2Term t) {
    switch (t) {
        case Ecom2Term::D0: return e.D0;
        case Ecom2Term::Y0: return e.Y0;
        case Ecom2Term::B0: return e.B0;
        case Ecom2Term::D2c: return e.Dc[0];
        case Ecom2Term::D2s: return e.Ds[0];
        case Ecom2Term::D4c: return e.Dc[1];
        case Ecom2Term::D4s: return e.Ds[1];
        case Ecom2Term::B1c: return e.Bc[0];
        case Ecom2Term::B1s: return e.Bs[0];
        case Ecom2Term::B3c: return e.Bc[1];
        case Ecom2Term::B3s: return e.Bs[1];
    }
    return e.D0;
}

using shadow::scalarValue;

// A three-vector of the scalar S.
template <class S>
struct V3 {
    S x, y, z;
    V3() : x(0.0), y(0.0), z(0.0) {}
    V3(const S& a, const S& b, const S& c) : x(a), y(b), z(c) {}
};
template <class S> V3<S> operator+(const V3<S>& a, const V3<S>& b) { return V3<S>(a.x + b.x, a.y + b.y, a.z + b.z); }
template <class S> V3<S> operator-(const V3<S>& a, const V3<S>& b) { return V3<S>(a.x - b.x, a.y - b.y, a.z - b.z); }
template <class S> V3<S> operator*(const V3<S>& a, const S& k) { return V3<S>(a.x * k, a.y * k, a.z * k); }
template <class S> S dot(const V3<S>& a, const V3<S>& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
template <class S> V3<S> cross(const V3<S>& a, const V3<S>& b) {
    return V3<S>(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}
template <class S> S norm(const V3<S>& a) { using std::sqrt; return sqrt(dot(a, a)); }
template <class S> V3<S> unit(const V3<S>& a) {
    const S n = norm(a);
    return scalarValue(n) > 0.0 ? a * (S(1.0) / n) : V3<S>();
}
/// The visible fraction of the Sun at r (km) past a spherical Earth of
/// radius `earthRadius` (km), the Sun at `sun` (km), both geocentric.
template <class S>
S Lit(const V3<S>& r, const V3<S>& sun, double earthRadius) {
    const V3<S> d = sun - r;
    return shadow::visibleSunFraction(norm(r), norm(d), norm(cross(r, d)), S(0.0) - dot(r, d), earthRadius);
}

/// The box-wing acceleration at full sunlight, km/s^2: r, sun geocentric
/// (km), `pressure` the radiation pressure at the satellite (N/m^2), mass kg.
template <class S>
V3<S> BoxWingAcceleration(const V3<S>& r, const V3<S>& sun, double pressure, double mass, const BoxWing& b) {
    const V3<S> eD = unit(sun - r);
    // Nominal yaw steering.
    const V3<S> ez = unit(r) * S(-1.0);
    const V3<S> ey = unit(cross(sun, r));
    const V3<S> ex = cross(ey, ez);
    const S k(-pressure / mass * 1e-3);  // N/m^2 * m^2 / kg = m/s^2 -> km/s^2
    V3<S> f;
    // Bus, eq. (9): absorbed energy re-emitted as Lambertian heat.
    auto bus = [&](const Surface& s, const V3<S>& n) {
        const S c = dot(eD, n);
        if (s.area <= 0 || !(scalarValue(c) > 0.0)) return;
        const S w = k * s.area * c;
        f = f + (eD + n * S(2.0 / 3.0)) * (w * (s.absorbed + s.diffuse)) + n * (w * S(2.0 * s.specular) * c);
    };
    bus(b.plusX, ex); bus(b.minusX, ex * S(-1.0));
    bus(b.plusY, ey); bus(b.minusY, ey * S(-1.0));
    bus(b.plusZ, ez); bus(b.minusZ, ez * S(-1.0));
    // Panels, eq. (6), turned about Y toward the Sun.
    if (b.panels.area > 0) {
        const V3<S> n = unit(eD - ey * dot(eD, ey));
        const S c = dot(eD, n);
        if (scalarValue(c) > 0.0) {
            const Surface& s = b.panels;
            const S w = k * s.area * c;
            f = f + eD * (w * (1.0 - s.specular)) + n * (w * S(2.0) * (S(s.diffuse / 3.0) + c * s.specular));
        }
    }
    return f;
}

/// du = u - us: the satellite's angle in its orbital plane from the
/// projection of the Sun (Arnold et al. 2015, Fig. 1), from r, v and the
/// geocentric Sun.
template <class S>
S ArgumentFromSun(const V3<S>& r, const V3<S>& v, const V3<S>& sun) {
    using std::atan2;
    const V3<S> h = cross(r, v);
    const V3<S> y = unit(cross(h, sun));
    const V3<S> x = unit(cross(y, h));
    return atan2(dot(r, y), dot(r, x));
}

/// The ECOM2 basis function of one term at (r, v, sun): its unit direction
/// times its periodic factor, so that acceleration = sum(coefficient * basis).
template <class S>
V3<S> Ecom2Basis(Ecom2Term t, const V3<S>& r, const V3<S>& v, const V3<S>& sun) {
    using std::cos;
    using std::sin;
    const V3<S> eD = unit(sun - r);
    const V3<S> eY = unit(cross(eD, r));  // -(er x eD) / |er x eD|
    const V3<S> eB = cross(eD, eY);
    const S du = ArgumentFromSun(r, v, sun);
    switch (t) {
        case Ecom2Term::D0: return eD;
        case Ecom2Term::Y0: return eY;
        case Ecom2Term::B0: return eB;
        case Ecom2Term::D2c: return eD * cos(du * S(2.0));
        case Ecom2Term::D2s: return eD * sin(du * S(2.0));
        case Ecom2Term::D4c: return eD * cos(du * S(4.0));
        case Ecom2Term::D4s: return eD * sin(du * S(4.0));
        case Ecom2Term::B1c: return eB * cos(du);
        case Ecom2Term::B1s: return eB * sin(du);
        case Ecom2Term::B3c: return eB * cos(du * S(3.0));
        case Ecom2Term::B3s: return eB * sin(du * S(3.0));
    }
    return V3<S>();
}

/// The ECOM2 acceleration at full sunlight, km/s^2.
template <class S>
V3<S> Ecom2Acceleration(const V3<S>& r, const V3<S>& v, const V3<S>& sun, const Ecom2& e) {
    using std::cos;
    using std::sin;
    const V3<S> eD = unit(sun - r);
    const V3<S> eY = unit(cross(eD, r));
    const V3<S> eB = cross(eD, eY);
    const S du = ArgumentFromSun(r, v, sun);
    S d(e.D0), b(e.B0);
    for (int i = 0; i < 2; ++i) {
        const S kd = du * S(2.0 * (i + 1)), kb = du * S(2.0 * i + 1.0);
        d = d + cos(kd) * e.Dc[i] + sin(kd) * e.Ds[i];
        b = b + cos(kb) * e.Bc[i] + sin(kb) * e.Bs[i];
    }
    return (eD * d + eY * S(e.Y0) + eB * b) * S(1e-3);
}

}  // namespace gnss_srp
}  // namespace astro
