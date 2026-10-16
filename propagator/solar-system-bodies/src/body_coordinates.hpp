/*
 * Body coordinate systems, direct allocation-free ABI (0.5.0).
 *
 * Input points are body-fixed meters in exactly the frame rotation(id, et)
 * maps ICRF into: IAU_<body>, or MOON_ME for the Moon. For a body with radii
 * but no loaded rotation model, systems 0 and 1 use ICRF axes.
 *
 * int32 system       longitude/latitude (radians)                 third (m)
 * 0 PLANETODETIC     nearpt + surfnm on the PCK triaxial ellipsoid signed height
 * 1 PLANETOCENTRIC   SPICE reclat, east longitude                  radius
 * 2 PLANETOGRAPHIC   SPICE recpgr, (a,a,c), IAU longitude sense    altitude
 * 3 STONYHURST       Sun only; east from Earth's geometric center radius
 * 4 CARRINGTON       Sun only; apparent, Earth nearest-point time radius
 * 5 MOON_PA          Moon only; reclat in MOON_PA_DE440            radius
 *
 * Longitude is (-pi, pi] for 0, 1, 3, 5, and [0, 2pi) for 2, 4. Systems 0
 * and 1 apply to any body with radii; 2 requires a loaded rotation model.
 * The origin returns (0,0,0) in every applicable system.
 *
 * ssb_body_coordinates: xyz[n*3] -> (lon,lat,third)[n*3].
 * ssb_body_surface_points: system (lon,lat)[n*2] -> PLANETODETIC
 *   (lon,lat)[n*2]. For 0 this is the identity. For 1,3,4,5 intersect the
 *   system's unit direction (transformed to the body frame) with the PCK
 *   triaxial ellipsoid. For 2 intersect pgrrec(lon,lat,h) on the reference
 *   spheroid (a,a,c) with the PCK triaxial ellipsoid, taking the real h
 *   closest to zero. A normal line with no real intersection returns
 *   ErrBadArgument. For deep negative h, pgrrec is not a global inverse of
 *   recpgr: the spheroid's nearest point can lie on another normal branch.
 * ssb_body_coordinate_info: out[0] = IAU planetographic longitude sense
 *   (+1 east, -1 west), out[1] = 1 for epoch-dependent systems 3,4 else 0,
 *   out[2] = 1 for a rotation model in the loaded kernels, else 0 (ICRF).
 * All calls return existing ssb::Code values; an inapplicable pair returns
 * ErrBadArgument. Solar conversions propagate missing SPK/rotation errors.
 *
 * Sources: NAIF reclat, nearpt, surfnm, recpgr, pgrrec and Frames Required
 * Reading; Thompson (2006), A&A 449, 791; sunpy 6.0 sun.L0 with
 * nearest_point=True; IAU 2015 Resolution B3 (Prsa et al. 2016), nominal
 * solar radius 695700 km. The lunar transform is TKFRAME_31009 from
 * moon_de440_250416.tf: rotation(301) = tk^T * (ICRF -> PA), so ME -> PA = tk.
 */
#ifndef SSB_BODY_COORDINATES_HPP
#define SSB_BODY_COORDINATES_HPP

namespace ssb {
namespace coordinates {

enum System : int32_t {
    PLANETODETIC = 0,
    PLANETOCENTRIC = 1,
    PLANETOGRAPHIC = 2,
    STONYHURST = 3,
    CARRINGTON = 4,
    MOON_PA = 5,
};

struct Context {
    double radii[3];
    double longitude_sense;
    bool has_rotation;
    double longitude_offset = 0.0;
    double me_to_pa[9];
};

inline double wrap_signed(double lon) {
    double result = std::fmod(lon, 2.0 * kPi);
    if (result <= -kPi) result += 2.0 * kPi;
    if (result > kPi) result -= 2.0 * kPi;
    return result;
}

inline double wrap_unsigned(double lon) {
    double result = std::fmod(lon, 2.0 * kPi);
    if (result < 0.0) result += 2.0 * kPi;
    return result >= 2.0 * kPi ? 0.0 : result;
}

inline void transform(const double m[9], const double p[3], double out[3]) {
    for (int i = 0; i < 3; ++i)
        out[i] = m[3 * i] * p[0] + m[3 * i + 1] * p[1] + m[3 * i + 2] * p[2];
}

/* Availability is independent of BPC epoch coverage. A missing lunar TK
 * frame still means the engine's ME rotation model is unavailable. */
inline bool has_rotation_model(int32_t id, double et) {
    double matrix[9], spin;
    if (id == 301 && !tk_angles(31009, matrix)) return false;
    const int32_t code = rotation(id, et, matrix, &spin);
    return code == Ok || code == ErrOutOfRange;
}

inline int32_t describe(int32_t id, int32_t system, double et, Context* c) {
    if (!std::isfinite(et) || system < PLANETODETIC || system > MOON_PA || !radii_m(id, c->radii))
        return ErrBadArgument;
    for (double r : c->radii)
        if (!(r > 0.0) || !std::isfinite(r)) return ErrBadArgument;
    c->longitude_sense = observer::longitude_sense(id);
    c->has_rotation = has_rotation_model(id, et);
    if (system == PLANETOGRAPHIC && !c->has_rotation) return ErrBadArgument;
    if ((system == STONYHURST || system == CARRINGTON) && id != 10) return ErrBadArgument;
    if (system == MOON_PA && id != 301) return ErrBadArgument;
    return Ok;
}

/* Resolve epoch-dependent offsets once per batch; every lookup and SPK
 * evaluation below uses the module's existing allocation-free paths. */
inline int32_t prepare(int32_t id, int32_t system, double et, Context* c) {
    const int32_t code = describe(id, system, et, c);
    if (code != Ok) return code;
    if (system == MOON_PA)
        return tk_angles(31009, c->me_to_pa) ? Ok : ErrNoRotation;
    if (system != STONYHURST && system != CARRINGTON) return Ok;
    if (!c->has_rotation) return ErrNoRotation;
    double earth[6];
    const int32_t state_code = state_m(399, 10, et, earth);
    if (state_code != Ok) return state_code;
    if (system == STONYHURST) {
        double matrix[9], spin, fixed[3], radius, lon, lat;
        const int32_t rotation_code = rotation(10, et, matrix, &spin);
        if (rotation_code != Ok) return rotation_code;
        transform(matrix, earth, fixed);
        observer::reclat(fixed, &radius, &lon, &lat);
        c->longitude_offset = -lon;
    } else {
        const auto* pm = state().pool.get("BODY10_PM");
        if (!pm || pm->size() < 2) return ErrNoRotation;
        constexpr double nominal_solar_radius = 695700000.0;  /* m, IAU 2015 B3 */
        const double tau = (norm3(earth) - nominal_solar_radius) / kSpeedOfLight;
        c->longitude_offset = (*pm)[1] * kDeg / 86400.0 * tau;
    }
    return Ok;
}

inline void convert(int32_t id, int32_t system, const Context& c, const double p[3], double out[3]) {
    if (p[0] == 0.0 && p[1] == 0.0 && p[2] == 0.0) {
        out[0] = out[1] = out[2] = 0.0;
        return;
    }
    if (system == PLANETODETIC) {
        double normal[3], unused;
        observer::nearest_on_ellipsoid(c.radii, p, normal, out + 2);
        observer::reclat(normal, &unused, out, out + 1);
        out[0] = wrap_signed(out[0]);
        return;
    }
    if (system == PLANETOGRAPHIC) {
        observer::recpgr(id, c.radii, p, out);
        return;
    }
    double pa[3];
    const double* point = p;
    if (system == MOON_PA) {
        transform(c.me_to_pa, p, pa);
        point = pa;
    }
    /* Stage all three values so an exact in-place xyz/out batch is safe. */
    double radius, lon, lat;
    observer::reclat(point, &radius, &lon, &lat);
    lon += c.longitude_offset;
    out[0] = system == CARRINGTON ? wrap_unsigned(lon) : wrap_signed(lon);
    out[1] = lat;
    out[2] = radius;
}

/* Convert an ellipsoid surface point to its outward-normal angles. A
 * positive multiple of the point gives the same angles, so ray mappings
 * may supply only their direction. */
inline void surface_normal_angles(const double radii[3], const double point[3], double out[2]) {
    double normal[3], unused;
    for (int i = 0; i < 3; ++i) normal[i] = point[i] / (radii[i] * radii[i]);
    observer::reclat(normal, &unused, out, out + 1);
    out[0] = wrap_signed(out[0]);
}

/* Intersect P(h) = pgrrec(lon,lat,0) + h*n with the actual triaxial
 * ellipsoid. Scaling h by the spheroid's equatorial radius keeps the
 * quadratic coefficients near unity. Choose the real root closest to
 * zero; the other root comes from C/q to avoid subtracting similar terms.
 *
 * A normal line can miss a strongly triaxial ellipsoid. Even when it hits,
 * recpgr(P(h)) need not recover the chosen latitude for deep negative h:
 * pgrrec is not globally one-to-one beyond the spheroid's nearest-point
 * branch. No alternative ray or nearest-point substitution is made here. */
inline int32_t planetographic_surface_intersection(const Context& c, const double lonlat[2], double out[3]) {
    const double lon = c.longitude_sense * lonlat[0], cl = std::cos(lonlat[1]);
    const double normal[3] = {cl * std::cos(lon), cl * std::sin(lon), std::sin(lonlat[1])};
    const double a = c.radii[0], polar = c.radii[2];
    const double gamma = std::hypot(a * std::hypot(normal[0], normal[1]), polar * normal[2]);
    const double base[3] = {a * (a * normal[0] / gamma), a * (a * normal[1] / gamma),
                            polar * (polar * normal[2] / gamma)};
    double quadratic = 0.0, half_linear = 0.0, constant = -1.0;
    for (int i = 0; i < 3; ++i) {
        const double p = base[i] / c.radii[i], n = a * normal[i] / c.radii[i];
        quadratic = std::fma(n, n, quadratic);
        half_linear = std::fma(p, n, half_linear);
        constant = std::fma(p, p, constant);
    }
    if (!(quadratic > 0.0) || !std::isfinite(quadratic) || !std::isfinite(half_linear) ||
        !std::isfinite(constant)) return ErrBadArgument;
    const double bb = half_linear * half_linear;
    const double discriminant = std::fma(-quadratic, constant, bb) + std::fma(half_linear, half_linear, -bb);
    if (discriminant < 0.0 || !std::isfinite(discriminant)) return ErrBadArgument;
    double scaled_height = 0.0;
    if (constant != 0.0) {
        const double q = -half_linear - std::copysign(std::sqrt(discriminant), half_linear);
        const double first = q / quadratic, second = constant / q;
        scaled_height = std::fabs(first) < std::fabs(second) ? first : second;
    }
    const double height = a * scaled_height;
    for (int i = 0; i < 3; ++i) {
        out[i] = std::fma(height, normal[i], base[i]);
        if (!std::isfinite(out[i])) return ErrBadArgument;
    }
    return Ok;
}

inline int32_t surface_point(int32_t system, const Context& c, const double lonlat[2], double out[2]) {
    if (system == PLANETODETIC) {
        out[0] = lonlat[0];
        out[1] = lonlat[1];
        return Ok;
    }
    if (system == PLANETOGRAPHIC) {
        double point[3];
        const int32_t code = planetographic_surface_intersection(c, lonlat, point);
        if (code != Ok) return code;
        surface_normal_angles(c.radii, point, out);
        return Ok;
    }
    const double lon = lonlat[0] - c.longitude_offset;
    const double cl = std::cos(lonlat[1]);
    double direction[3] = {cl * std::cos(lon), cl * std::sin(lon), std::sin(lonlat[1])};
    if (system == MOON_PA) {
        double inverse[9], me[3];
        transpose(c.me_to_pa, inverse);
        transform(inverse, direction, me);
        std::memcpy(direction, me, sizeof me);
    }
    /* The ray meets the triaxial surface at P = s*direction, s > 0. Its
     * outward normal is parallel to (direction.x/a^2, y/b^2, z/c^2), so
     * neither the intersection distance nor normalization is needed here. */
    surface_normal_angles(c.radii, direction, out);
    return Ok;
}

}  // namespace coordinates
}  // namespace ssb

SSB_EXPORT("ssb_body_coordinates") int32_t ssb_body_coordinates(int32_t id, int32_t system, double et,
                                                               const double* xyz, uint32_t n, double* out) {
    if (n && (!xyz || !out)) return ssb::ErrBadArgument;
    ssb::coordinates::Context c;
    const int32_t code = ssb::coordinates::prepare(id, system, et, &c);
    if (code != ssb::Ok) return code;
    for (uint32_t i = 0; i < n; ++i) {
        const double* p = xyz + size_t(i) * 3;
        if (!std::isfinite(p[0]) || !std::isfinite(p[1]) || !std::isfinite(p[2])) return ssb::ErrBadArgument;
        ssb::coordinates::convert(id, system, c, p, out + size_t(i) * 3);
    }
    return ssb::Ok;
}

SSB_EXPORT("ssb_body_surface_points") int32_t ssb_body_surface_points(int32_t id, int32_t system, double et,
                                                                     const double* lonlat, uint32_t n,
                                                                     double* out) {
    if (n && (!lonlat || !out)) return ssb::ErrBadArgument;
    ssb::coordinates::Context c;
    const int32_t code = ssb::coordinates::prepare(id, system, et, &c);
    if (code != ssb::Ok) return code;
    for (uint32_t i = 0; i < n; ++i) {
        const double* p = lonlat + size_t(i) * 2;
        if (!std::isfinite(p[0]) || !std::isfinite(p[1]) || std::fabs(p[1]) > ssb::kHalfPi)
            return ssb::ErrBadArgument;
        const int32_t point_code = ssb::coordinates::surface_point(system, c, p, out + size_t(i) * 2);
        if (point_code != ssb::Ok) return point_code;
    }
    return ssb::Ok;
}

SSB_EXPORT("ssb_body_coordinate_info") int32_t ssb_body_coordinate_info(int32_t id, int32_t system, double et,
                                                                       double* out) {
    if (!out) return ssb::ErrBadArgument;
    ssb::coordinates::Context c;
    const int32_t code = ssb::coordinates::describe(id, system, et, &c);
    if (code != ssb::Ok) return code;
    out[0] = c.longitude_sense;
    out[1] = system == ssb::coordinates::STONYHURST || system == ssb::coordinates::CARRINGTON ? 1.0 : 0.0;
    out[2] = c.has_rotation ? 1.0 : 0.0;
    return ssb::Ok;
}

#endif  // SSB_BODY_COORDINATES_HPP
