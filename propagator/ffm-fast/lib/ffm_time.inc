// FFM Fast C3a: exact time-only inputs, owned by one acceleration evaluation.
// This include precedes the local ephemeris aliases so exact sources stay exact.
namespace ffm_time {
using Forces = astro::ForceModel::ForceModelSet;
struct TimeMemo {
    const Forces& forces;
    timesys::Instant jd;
    bool rotationValid = false, ut1Valid = false;
    double rotation[3][3]{};
    timesys::Instant::Date ut1{NAN, NAN};
    std::array<bool, 5> bodyValid{};
    std::array<astro::EphemerisState, 5> bodies;
};
inline thread_local TimeMemo* current = nullptr;
struct ForceScope {
    TimeMemo memo;
    TimeMemo* previous;
    ForceScope(const Forces& f, const timesys::Instant& jd) : memo{f, jd}, previous(current) { current = &memo; }
    ~ForceScope() { current = previous; }
    ForceScope(const ForceScope&) = delete;
    ForceScope& operator=(const ForceScope&) = delete;
};
inline TimeMemo* at(const timesys::Instant& jd, const Forces& f) {
    return !ffm_interp::bypassDepth && current && &current->forces == &f && ffm_interp::same(current->jd, jd) ? current : nullptr;
}
inline astro::EphemerisState body(const timesys::Instant& jd, int slot) {
    static constexpr astro::CelestialBody planets[] = {
        astro::CelestialBody::Venus, astro::CelestialBody::Mars, astro::CelestialBody::Jupiter};
    const auto source = [&](const timesys::Instant& t) {
        if (slot == 0) return astro::getSunPosition(t);
        if (slot == 1) return astro::getMoonPosition(t);
        return astro::getPlanetPosition(planets[slot - 2], t);
    };
    if (ffm_interp::bypassDepth || !current || !ffm_interp::same(jd, current->jd)) return source(jd);
    if (!current->bodyValid[slot]) {
        current->bodies[slot] = ffm_interp::active(current->forces)
            ? ffm_interp::body(jd, current->forces, slot, source) : source(jd);
        current->bodyValid[slot] = true;
    }
    return current->bodies[slot];
}
inline astro::EphemerisState sun(const timesys::Instant& jd) { return body(jd, 0); }
inline astro::EphemerisState moon(const timesys::Instant& jd) { return body(jd, 1); }
inline astro::EphemerisState planet(astro::CelestialBody b, const timesys::Instant& jd) {
    switch (b) {
        case astro::CelestialBody::Venus: return body(jd, 2);
        case astro::CelestialBody::Mars: return body(jd, 3);
        case astro::CelestialBody::Jupiter: return body(jd, 4);
        default: return astro::getPlanetPosition(b, jd);
    }
}
} // namespace ffm_time
