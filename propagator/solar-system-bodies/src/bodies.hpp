/*
 * propagator/solar-system-bodies — the Phase-1 body list and photometry.
 *
 * Geometry (RADII), gravity (GM) and rotation come from the loaded NAIF
 * kernels, never from this file. What lives here is identity (NAIF code, name,
 * the body it orbits, the kernel shard that carries it) and the photometric
 * constants the kernels do not carry:
 *
 *  - Planets: Mallama & Hilton (2018), "Computing apparent planetary
 *    magnitudes for The Astronomical Almanac", Astronomy and Computing 25:10-24,
 *    https://doi.org/10.1016/j.ascom.2018.08.002 (equations 1-11, alpha in deg).
 *  - Moon: Allen's Astrophysical Quantities (4th ed., 2000) 12.4,
 *    V = 0.21 + 5 log(r d) + 0.0217 alpha + 5.5e-9 alpha^4 (phase law).
 *  - Planetary satellites: V(1,0) from JPL SSD "Planetary Satellite Physical
 *    Parameters" (https://ssd.jpl.nasa.gov/sats/phys_par/), with a linear
 *    phase coefficient of 0.02 mag/deg (Allen 12.4) — display brightness only.
 *  - Sun: V = -26.74 at 1 au (Allen 14.7).
 *  - Ceres, Vesta: H and G from the JPL Small-Body Database (H-G system,
 *    Bowell et al. 1989, Asteroids II p. 524).
 */

#ifndef SSB_BODIES_HPP
#define SSB_BODIES_HPP

#include <cstdint>

namespace ssb {

enum BodyKind : int32_t {
    KindStar = 0,
    KindPlanet = 1,
    KindMoon = 2,
    KindDwarfPlanet = 3,
    KindAsteroid = 4,
};

enum Photometry : int32_t {
    PhotSun = 0,
    PhotMercury,
    PhotVenus,
    PhotEarth,
    PhotMars,
    PhotJupiter,
    PhotSaturn,
    PhotUranus,
    PhotNeptune,
    PhotMoon,
    PhotLinear,  // V(1,0) + 0.02 mag/deg
    PhotHG,      // H, G
};

struct BodyInfo {
    int32_t id;
    const char* name;
    int32_t parent;     // the body it orbits (10 for planets), 0 for the Sun
    const char* shard;  // kernel shard carrying its SPK segment
    int32_t kind;
    int32_t photometry;
    double v10;         // V(1,0) or H
    double g;           // slope parameter for PhotHG
};

/* The order is the catalog order: Sun, then planets outward, each followed by
 * its moons, then dwarf planets and asteroids. */
static const BodyInfo kBodies[] = {
    {10, "Sun", 0, "core", KindStar, PhotSun, -26.74, 0.0},
    {199, "Mercury", 10, "core", KindPlanet, PhotMercury, 0.0, 0.0},
    {299, "Venus", 10, "core", KindPlanet, PhotVenus, 0.0, 0.0},
    {399, "Earth", 10, "core", KindPlanet, PhotEarth, 0.0, 0.0},
    {301, "Moon", 399, "core", KindMoon, PhotMoon, 0.21, 0.0},
    {499, "Mars", 10, "core", KindPlanet, PhotMars, 0.0, 0.0},
    {401, "Phobos", 499, "mars", KindMoon, PhotLinear, 11.8, 0.0},
    {402, "Deimos", 499, "mars", KindMoon, PhotLinear, 12.89, 0.0},
    {599, "Jupiter", 10, "core", KindPlanet, PhotJupiter, 0.0, 0.0},
    {501, "Io", 599, "jupiter", KindMoon, PhotLinear, -1.68, 0.0},
    {502, "Europa", 599, "jupiter", KindMoon, PhotLinear, -1.41, 0.0},
    {503, "Ganymede", 599, "jupiter", KindMoon, PhotLinear, -2.09, 0.0},
    {504, "Callisto", 599, "jupiter", KindMoon, PhotLinear, -1.05, 0.0},
    {699, "Saturn", 10, "core", KindPlanet, PhotSaturn, 0.0, 0.0},
    {601, "Mimas", 699, "saturn", KindMoon, PhotLinear, 3.3, 0.0},
    {602, "Enceladus", 699, "saturn", KindMoon, PhotLinear, 2.1, 0.0},
    {603, "Tethys", 699, "saturn", KindMoon, PhotLinear, 0.6, 0.0},
    {604, "Dione", 699, "saturn", KindMoon, PhotLinear, 0.8, 0.0},
    {605, "Rhea", 699, "saturn", KindMoon, PhotLinear, 0.1, 0.0},
    {606, "Titan", 699, "saturn", KindMoon, PhotLinear, -1.28, 0.0},
    {608, "Iapetus", 699, "saturn", KindMoon, PhotLinear, 1.5, 0.0},
    {799, "Uranus", 10, "core", KindPlanet, PhotUranus, 0.0, 0.0},
    {705, "Miranda", 799, "uranus", KindMoon, PhotLinear, 3.6, 0.0},
    {701, "Ariel", 799, "uranus", KindMoon, PhotLinear, 1.45, 0.0},
    {702, "Umbriel", 799, "uranus", KindMoon, PhotLinear, 2.1, 0.0},
    {703, "Titania", 799, "uranus", KindMoon, PhotLinear, 1.02, 0.0},
    {704, "Oberon", 799, "uranus", KindMoon, PhotLinear, 1.23, 0.0},
    {899, "Neptune", 10, "core", KindPlanet, PhotNeptune, 0.0, 0.0},
    {801, "Triton", 899, "neptune", KindMoon, PhotLinear, -1.24, 0.0},
    {999, "Pluto", 10, "core", KindDwarfPlanet, PhotLinear, -1.01, 0.0},
    {901, "Charon", 999, "pluto", KindMoon, PhotLinear, 1.0, 0.0},
    {2000001, "Ceres", 10, "core", KindDwarfPlanet, PhotHG, 3.34, 0.12},
    {2000004, "Vesta", 10, "core", KindAsteroid, PhotHG, 3.20, 0.32},
};
static constexpr int kBodyCount = static_cast<int>(sizeof(kBodies) / sizeof(kBodies[0]));

inline const BodyInfo* find_body(int32_t id) {
    for (const auto& b : kBodies) {
        if (b.id == id) return &b;
    }
    return nullptr;
}

/* The barycentre whose NUT_PREC_ANGLES a body's rotation model reads: the
 * planet system for planets and their satellites, the body itself otherwise
 * (pck00011 keys the Sun, Earth-Moon and asteroid models that way). */
inline int32_t phase_system(int32_t id) {
    if (id >= 100 && id < 1000) return id / 100;
    return id;
}

}  // namespace ssb

#endif  // SSB_BODIES_HPP
