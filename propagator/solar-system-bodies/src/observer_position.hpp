/*
 * Where the observer is, in the coordinates that fit its scale (owner
 * 2026-10-16: "when the lat / lon / altitude disappears because we're too high
 * above earth, it should switch to position in the solar system / galaxy
 * whatever the appropriate position is for that, and keep that sort of
 * measurement all the way as we zoom out of the milky way, but also change to
 * the appropriate grid system and altitude for each of the other bodies").
 *
 * One call, ssb_observer_position(et, focused, cam, out): the camera at `cam`
 * (ICRF, m, relative to the focused body) answers in exactly one regime.
 *
 *  BODY. Inside the focused body's Hill sphere, or, beyond it, inside the
 *    sphere of the body it orbits (Phobos, then Mars), the camera is on that
 *    body's own grid: the body-fixed frame is IAU_<body> (WGCCRE 2015, text
 *    PCK) or MOON_ME, the radii are the PCK's. Three coordinate sets:
 *      planetographic (SPICE recpgr): the reference spheroid with equatorial
 *        radius RADII[0] and polar radius RADII[2]; geodetic latitude; the
 *        longitude positive against the sense of rotation (west for prograde
 *        rotators, east for retrograde ones), the Sun, the Earth and the Moon
 *        east by IAU convention; [0, 2 pi).
 *      planetocentric (SPICE reclat): east longitude (-pi, pi], latitude from
 *        the centre, distance from the centre.
 *      planetodetic on the triaxial ellipsoid (SPICE nearpt + surfnm; the
 *        engine's Cartographic on a body's ellipsoid): the normal at the
 *        nearest surface point gives east longitude and latitude, the signed
 *        distance to that point is the height (negative inside).
 *    The Sun's own grid holds out to the Alfven critical surface, where the
 *    corona stops turning with the Sun: 18.8 solar radii, measured by Parker
 *    Solar Probe (Kasper et al. 2021, PRL 127, 255101). Beyond it a Sun-centred
 *    turning grid describes nothing.
 *  HELIOCENTRIC. Out to the heliopause: ecliptic J2000 (SPICE ECLIPJ2000, the
 *    IAU 1976 obliquity 84381.448") longitude [0, 2 pi), latitude and
 *    distance from the Sun in au, with the ecliptic x, y, z in au. The
 *    heliopause is 120.3 au, the mean of the two crossings measured in situ:
 *    Voyager 1 at 121.6 au (Stone et al. 2013, Science 341, 150) and Voyager 2
 *    at 119.0 au (Stone et al. 2019, Nature Astronomy 3, 1013).
 *  GALACTIC. Beyond: Galactic longitude [0, 2 pi) and latitude seen from the
 *    Sun (the Hipparcos definition, foundation/frames galactic.hpp), the
 *    distance from the Sun in light-years and parsecs, and the distance from
 *    the Galactic centre (R0 = 8.178 kpc, z0 = 20.8 pc) in light-years and
 *    parsecs. Any distance: past the Milky Way and beyond.
 *
 * `out` is kObserverPositionLength doubles (layout below); the call writes all
 * of them, zeros where a regime has no value. An internal layout between this
 * module and the engine, like the scene table, not a standard.
 */
#ifndef SSB_OBSERVER_POSITION_HPP
#define SSB_OBSERVER_POSITION_HPP

namespace ssb {
namespace observer {

enum Regime : int32_t { RegimeBody = 0, RegimeHeliocentric = 1, RegimeGalactic = 2 };

/* out[] layout. Common: */
constexpr int kRegime = 0;     /* Regime                                              */
constexpr int kReference = 1;  /* NAIF id the coordinates refer to (Sun 10; 0 galactic) */
constexpr int kDistance = 2;   /* m from that reference (Galactic: from the Sun)      */
constexpr int kBoundary = 3;   /* m: the outer edge of this regime about the reference; 0 for Galactic */
/* RegimeBody: */
constexpr int kPgrLon = 4, kPgrLat = 5, kPgrAlt = 6;          /* rad, rad, m */
constexpr int kPcLon = 7, kPcLat = 8, kPcRadius = 9;          /* rad, rad, m */
constexpr int kPdLon = 10, kPdLat = 11, kPdHeight = 12;       /* rad, rad, m */
constexpr int kLonSense = 13;                                  /* +1 planetographic longitude east, -1 west */
/* RegimeHeliocentric: */
constexpr int kEclLon = 4, kEclLat = 5, kEclAu = 6;           /* rad, rad, au */
constexpr int kEclX = 7, kEclY = 8, kEclZ = 9;                /* au, ECLIPJ2000 */
/* RegimeGalactic: */
constexpr int kGalL = 4, kGalB = 5, kGalLy = 6, kGalPc = 7;   /* rad, rad, ly, pc (from the Sun) */
constexpr int kGcLy = 8, kGcPc = 9;                            /* ly, pc (from the Galactic centre) */
constexpr int kObserverPositionLength = 14;

constexpr double kAu = 149597870700.0;                  /* m, IAU 2012 B2 */
constexpr double kLightYear = 9460730472580800.0;       /* m, IAU: 365.25 d of c */
constexpr double kParsec = kAu * 648000.0 / 3.14159265358979323846; /* m, IAU 2015 B2 */
constexpr double kHeliopause = 120.3 * kAu;
constexpr double kAlfvenSolarRadii = 18.8;
constexpr double kEclipticObliquity = 84381.448 / 3600.0 * 3.14159265358979323846 / 180.0;

/* ICRF -> ECLIPJ2000, row-major (SPICE: a rotation about x by the obliquity). */
inline void icrf_to_ecliptic(double out[9]) {
    const double c = std::cos(kEclipticObliquity), s = std::sin(kEclipticObliquity);
    const double m[9] = {1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c};
    std::memcpy(out, m, sizeof m);
}

inline double wrap_two_pi(double a) {
    constexpr double kTwoPi = 2.0 * 3.14159265358979323846;
    if (a < 0.0) a += kTwoPi;
    return a >= kTwoPi ? a - kTwoPi : a;
}

/* SPICE reclat: (radius, east longitude, latitude); both angles 0 at the origin. */
inline void reclat(const double p[3], double* radius, double* lon, double* lat) {
    const double h = std::hypot(p[0], p[1]);
    *radius = std::sqrt(h * h + p[2] * p[2]);
    *lon = (p[0] == 0.0 && p[1] == 0.0) ? 0.0 : std::atan2(p[1], p[0]);
    *lat = (h == 0.0 && p[2] == 0.0) ? 0.0 : std::atan2(p[2], h);
}

/* The nearest point of an ellipse (e0 >= e1 > 0) to (y0, y1) >= 0, and the
 * root that places it: D. Eberly, "Distance from a Point to an Ellipse, an
 * Ellipsoid, or a Hyperellipsoid" (Geometric Tools, 2020), bisection to the
 * last representable value, valid inside and outside. The root is carried as
 * u = s + 1 (Eberly's s shifted by one) with r - 1 formed as
 * (e0 - e1)(e0 + e1) / e1^2: next to the medial axis inside a body the root
 * lies within a few ulp of s = -1, where s itself has no digits left. */
inline double ellipse_root(double q0, double n0, double z1, double g) {
    double u0 = z1, u1 = g < 0.0 ? 1.0 : std::hypot(n0, z1), u = 0.0;
    for (int i = 0; i < 1100; ++i) {
        u = 0.5 * (u0 + u1);
        if (u == u0 || u == u1) break;
        const double a = n0 / (u + q0), b = z1 / u;
        g = a * a + b * b - 1.0;
        if (g > 0.0) u0 = u;
        else if (g < 0.0) u1 = u;
        else break;
    }
    return u;
}

inline void nearest_on_ellipse(double e0, double e1, double y0, double y1, double* x0, double* x1) {
    if (y1 > 0.0) {
        if (y0 > 0.0) {
            const double z0 = y0 / e0, z1 = y1 / e1, g = z0 * z0 + z1 * z1 - 1.0;
            if (g != 0.0) {
                const double r0 = (e0 / e1) * (e0 / e1), q0 = (e0 - e1) * (e0 + e1) / (e1 * e1);
                const double u = ellipse_root(q0, r0 * z0, z1, g);
                *x0 = r0 * y0 / (u + q0);
                *x1 = y1 / u;
            } else {
                *x0 = y0;
                *x1 = y1;
            }
        } else {
            *x0 = 0.0;
            *x1 = e1;
        }
        return;
    }
    const double numer0 = e0 * y0, denom0 = e0 * e0 - e1 * e1;
    if (numer0 < denom0) {
        const double xde0 = numer0 / denom0;
        *x0 = e0 * xde0;
        *x1 = e1 * std::sqrt(1.0 - xde0 * xde0);
    } else {
        *x0 = e0;
        *x1 = 0.0;
    }
}

inline double ellipsoid_root(double q0, double q1, double n0, double n1, double z2, double g) {
    double u0 = z2, u1 = g < 0.0 ? 1.0 : std::sqrt(n0 * n0 + n1 * n1 + z2 * z2), u = 0.0;
    for (int i = 0; i < 1100; ++i) {
        u = 0.5 * (u0 + u1);
        if (u == u0 || u == u1) break;
        const double a = n0 / (u + q0), b = n1 / (u + q1), c = z2 / u;
        g = a * a + b * b + c * c - 1.0;
        if (g > 0.0) u0 = u;
        else if (g < 0.0) u1 = u;
        else break;
    }
    return u;
}

/* Sorted semi-axes e0 >= e1 >= e2 > 0, a point in the first octant. */
inline void nearest_on_sorted_ellipsoid(const double e[3], const double y[3], double x[3]) {
    if (y[2] > 0.0) {
        if (y[1] > 0.0) {
            if (y[0] > 0.0) {
                const double z0 = y[0] / e[0], z1 = y[1] / e[1], z2 = y[2] / e[2];
                const double g = z0 * z0 + z1 * z1 + z2 * z2 - 1.0;
                if (g != 0.0) {
                    const double e22 = e[2] * e[2];
                    const double r0 = (e[0] / e[2]) * (e[0] / e[2]), r1 = (e[1] / e[2]) * (e[1] / e[2]);
                    const double q0 = (e[0] - e[2]) * (e[0] + e[2]) / e22, q1 = (e[1] - e[2]) * (e[1] + e[2]) / e22;
                    const double u = ellipsoid_root(q0, q1, r0 * z0, r1 * z1, z2, g);
                    x[0] = r0 * y[0] / (u + q0);
                    x[1] = r1 * y[1] / (u + q1);
                    x[2] = y[2] / u;
                } else {
                    x[0] = y[0];
                    x[1] = y[1];
                    x[2] = y[2];
                }
            } else {
                x[0] = 0.0;
                nearest_on_ellipse(e[1], e[2], y[1], y[2], &x[1], &x[2]);
            }
        } else if (y[0] > 0.0) {
            x[1] = 0.0;
            nearest_on_ellipse(e[0], e[2], y[0], y[2], &x[0], &x[2]);
        } else {
            x[0] = 0.0;
            x[1] = 0.0;
            x[2] = e[2];
        }
        return;
    }
    const double denom0 = e[0] * e[0] - e[2] * e[2], denom1 = e[1] * e[1] - e[2] * e[2];
    const double numer0 = e[0] * y[0], numer1 = e[1] * y[1];
    if (numer0 < denom0 && numer1 < denom1) {
        const double xde0 = numer0 / denom0, xde1 = numer1 / denom1;
        const double discr = 1.0 - xde0 * xde0 - xde1 * xde1;
        if (discr > 0.0) {
            x[0] = e[0] * xde0;
            x[1] = e[1] * xde1;
            x[2] = e[2] * std::sqrt(discr);
            return;
        }
    }
    x[2] = 0.0;
    nearest_on_ellipse(e[0], e[1], y[0], y[1], &x[0], &x[1]);
}

/* The nearest point of the ellipsoid with semi-axes `radii` (any order) to
 * `p`, the outward unit normal there, and the signed distance (negative
 * inside): SPICE nearpt and surfnm. */
inline void nearest_on_ellipsoid(const double radii[3], const double p[3], double normal[3], double* height) {
    int order[3] = {0, 1, 2};
    for (int i = 0; i < 2; ++i)
        for (int j = 0; j < 2 - i; ++j)
            if (radii[order[j]] < radii[order[j + 1]]) std::swap(order[j], order[j + 1]);
    double e[3], y[3], xs[3], x[3];
    for (int i = 0; i < 3; ++i) {
        e[i] = radii[order[i]];
        y[i] = std::fabs(p[order[i]]);
    }
    nearest_on_sorted_ellipsoid(e, y, xs);
    for (int i = 0; i < 3; ++i) x[order[i]] = std::copysign(xs[i], p[order[i]]);
    double inside = 0.0;
    for (int i = 0; i < 3; ++i) {
        normal[i] = x[i] / (radii[i] * radii[i]);
        inside += (p[i] / radii[i]) * (p[i] / radii[i]);
    }
    const double nn = norm3(normal);
    for (int i = 0; i < 3; ++i) normal[i] /= nn;
    const double d[3] = {p[0] - x[0], p[1] - x[1], p[2] - x[2]};
    *height = (inside < 1.0 ? -1.0 : 1.0) * norm3(d);
}

/* +1 when planetographic longitude is positive east, -1 west (SPICE plnsns):
 * east for the Sun, the Earth and the Moon; otherwise against the rotation,
 * i.e. west when the prime meridian's rate is positive. */
inline double longitude_sense(int32_t id) {
    if (id == 10 || id == 399 || id == 301) return 1.0;
    const auto* pm = state().pool.get(var("BODY", id, "_PM"));
    return (pm && pm->size() > 1 && (*pm)[1] < 0.0) ? 1.0 : -1.0;
}

/* The body regime's outer edge about `id`: the Hill radius, or for the Sun the
 * Alfven surface. */
inline int32_t body_boundary(int32_t id, double et, double* out) {
    if (id == 10) {
        double r[3];
        if (!radii_m(10, r)) return ErrNoRotation;
        *out = kAlfvenSolarRadii * r[0];
        return Ok;
    }
    return hill_radius(id, et, out);
}

inline int32_t body_coordinates(int32_t id, double et, const double rel[3], double boundary, double out[]) {
    double rot[9], spin = 0.0, radii[3];
    int32_t code = rotation(id, et, rot, &spin);
    if (code != Ok) return code;
    if (!radii_m(id, radii)) return ErrNoRotation;
    double p[3];
    for (int i = 0; i < 3; ++i) p[i] = rot[3 * i] * rel[0] + rot[3 * i + 1] * rel[1] + rot[3 * i + 2] * rel[2];
    out[kRegime] = RegimeBody;
    out[kReference] = id;
    out[kDistance] = norm3(rel);
    out[kBoundary] = boundary;
    /* Planetographic: the spheroid (re, re, rp), longitude in the IAU sense. */
    const double spheroid[3] = {radii[0], radii[0], radii[2]};
    double n[3], alt = 0.0, unused = 0.0;
    nearest_on_ellipsoid(spheroid, p, n, &alt);
    const double sense = longitude_sense(id);
    double lon = 0.0;
    reclat(p, &unused, &lon, &unused);
    out[kPgrLon] = wrap_two_pi(sense * lon);
    out[kPgrLat] = std::atan2(n[2], std::hypot(n[0], n[1]));
    out[kPgrAlt] = alt;
    reclat(p, &out[kPcRadius], &out[kPcLon], &out[kPcLat]);
    /* Planetodetic on the triaxial ellipsoid. */
    nearest_on_ellipsoid(radii, p, n, &out[kPdHeight]);
    out[kPdLon] = std::atan2(n[1], n[0]);
    out[kPdLat] = std::atan2(n[2], std::hypot(n[0], n[1]));
    out[kLonSense] = sense;
    return Ok;
}

inline int32_t observer_position(double et, int32_t focused, const double cam[3], double out[]) {
    for (int i = 0; i < kObserverPositionLength; ++i) out[i] = 0.0;
    const BodyInfo* b = find_body(focused);
    if (!b) return ErrUnknownBody;
    /* Walk out from the focused body through the bodies it orbits; the first
     * whose sphere holds the camera gives the grid. The Sun's grid counts only
     * when the Sun is focused: from a planet, the Sun's sphere is the solar
     * system, which is the heliocentric regime. */
    double rel[3] = {cam[0], cam[1], cam[2]};
    int32_t id = focused;
    while (b) {
        if (id != 10 || focused == 10) {
            double edge = 0.0;
            int32_t code = body_boundary(id, et, &edge);
            if (code != Ok) return code;
            if (norm3(rel) < edge) return body_coordinates(id, et, rel, edge, out);
        }
        if (b->parent == 0) break;
        double s[6];
        const int32_t code = state_m(id, b->parent, et, s);
        if (code != Ok) return code;
        for (int i = 0; i < 3; ++i) rel[i] += s[i];
        id = b->parent;
        b = find_body(id);
    }
    /* Heliocentric: rel is now relative to the Sun when the walk reached it. */
    if (id != 10) {
        double s[6];
        const int32_t code = state_m(id, 10, et, s);
        if (code != Ok) return code;
        for (int i = 0; i < 3; ++i) rel[i] += s[i];
    }
    const double d = norm3(rel);
    if (d < kHeliopause) {
        double m[9];
        icrf_to_ecliptic(m);
        double e[3];
        for (int i = 0; i < 3; ++i) e[i] = m[3 * i] * rel[0] + m[3 * i + 1] * rel[1] + m[3 * i + 2] * rel[2];
        double r = 0.0, lon = 0.0, lat = 0.0;
        reclat(e, &r, &lon, &lat);
        out[kRegime] = RegimeHeliocentric;
        out[kReference] = 10;
        out[kDistance] = d;
        out[kBoundary] = kHeliopause;
        out[kEclLon] = wrap_two_pi(lon);
        out[kEclLat] = lat;
        out[kEclAu] = d / kAu;
        out[kEclX] = e[0] / kAu;
        out[kEclY] = e[1] / kAu;
        out[kEclZ] = e[2] / kAu;
        return Ok;
    }
    double m[9], centre[3];
    sdn::frames::galactic::icrs_to_galactic(m);
    sdn::frames::galactic::centre_from_sun(centre);
    double g[3];
    for (int i = 0; i < 3; ++i) g[i] = m[3 * i] * rel[0] + m[3 * i + 1] * rel[1] + m[3 * i + 2] * rel[2];
    double r = 0.0, l = 0.0, bb = 0.0;
    reclat(g, &r, &l, &bb);
    const double fromCentre[3] = {rel[0] - centre[0], rel[1] - centre[1], rel[2] - centre[2]};
    const double gc = norm3(fromCentre);
    out[kRegime] = RegimeGalactic;
    out[kReference] = 0;
    out[kDistance] = d;
    out[kGalL] = wrap_two_pi(l);
    out[kGalB] = bb;
    out[kGalLy] = d / kLightYear;
    out[kGalPc] = d / kParsec;
    out[kGcLy] = gc / kLightYear;
    out[kGcPc] = gc / kParsec;
    return Ok;
}

}  // namespace observer
}  // namespace ssb

/* The observer's position at its scale (see the header comment): `cam` is 3
 * doubles (ICRF, m, relative to `focused`), `out` kObserverPositionLength (14)
 * doubles. Returns 0 or a status code (out-of-range, no-ephemeris,
 * no-rotation, unknown-body). */
SSB_EXPORT("ssb_observer_position") int32_t ssb_observer_position(double et, int32_t focused, const double* cam,
                                                                   double* out) {
    if (!cam || !out) return ssb::ErrBadArgument;
    return ssb::observer::observer_position(et, focused, cam, out);
}

/* ICRF -> ECLIPJ2000 (9 doubles, row-major): the plane of the solar system as
 * the heliocentric regime measures it. */
SSB_EXPORT("ssb_ecliptic") int32_t ssb_ecliptic(double* out) {
    if (!out) return ssb::ErrBadArgument;
    ssb::observer::icrf_to_ecliptic(out);
    return ssb::Ok;
}

#endif  // SSB_OBSERVER_POSITION_HPP
