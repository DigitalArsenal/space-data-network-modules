// FFM Fast C3a: exact time-only inputs, owned by one acceleration evaluation.
// This include precedes the local ephemeris aliases so exact sources stay exact.
namespace ffm_time {
using Forces = astro::ForceModel::ForceModelSet;
struct TimeMemo {
    const Forces& forces;
    double jd;
    bool rotationValid = false, ut1Valid = false;
    double rotation[3][3]{}, ut1 = NAN;
    std::array<bool, 5> bodyValid{};
    std::array<astro::EphemerisState, 5> bodies;
};
inline thread_local TimeMemo* current = nullptr;
struct ForceScope {
    TimeMemo memo;
    TimeMemo* previous;
    ForceScope(const Forces& f, double jd) : memo{f, jd}, previous(current) { current = &memo; }
    ~ForceScope() { current = previous; }
    ForceScope(const ForceScope&) = delete;
    ForceScope& operator=(const ForceScope&) = delete;
};
inline TimeMemo* at(double jd, const Forces& f) {
    return !ffm_interp::bypassDepth && current && &current->forces == &f && current->jd == jd ? current : nullptr;
}
inline astro::EphemerisState body(double jd, int slot) {
    static constexpr astro::CelestialBody planets[] = {
        astro::CelestialBody::Venus, astro::CelestialBody::Mars, astro::CelestialBody::Jupiter};
    const auto source = [&](double t) {
        if (slot == 0) return astro::getSunPosition(t);
        if (slot == 1) return astro::getMoonPosition(t);
        return astro::getPlanetPosition(planets[slot - 2], t);
    };
    if (ffm_interp::bypassDepth || !current || jd != current->jd) return source(jd);
    if (!current->bodyValid[slot]) {
        current->bodies[slot] = ffm_interp::active(current->forces)
            ? ffm_interp::body(jd, current->forces, slot, source) : source(jd);
        current->bodyValid[slot] = true;
    }
    return current->bodies[slot];
}
inline astro::EphemerisState sun(double jd) { return body(jd, 0); }
inline astro::EphemerisState moon(double jd) { return body(jd, 1); }
inline astro::EphemerisState planet(astro::CelestialBody b, double jd) {
    switch (b) {
        case astro::CelestialBody::Venus: return body(jd, 2);
        case astro::CelestialBody::Mars: return body(jd, 3);
        case astro::CelestialBody::Jupiter: return body(jd, 4);
        default: return astro::getPlanetPosition(b, jd);
    }
}
} // namespace ffm_time
