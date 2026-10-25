// What a force set needs to fly about the Moon or Mars rather than the Earth (lib/planetary_fields.h): the bodies'
// positions relative to the central body, the third-body point masses about it, and its embedded harmonic field.
// force_models.cpp reads these only for a set whose centralBodyNaifId is not 399.
#include "force_models.h"
#include "ffm_gravity.h"
#include "ephemeris.h"
#include "planetary_fields.h"
#include "reentry.h"
#include <algorithm>
#include <cmath>
#include <cstdint>

namespace astro {
namespace ForceModel {

EphemerisState BodyAboutCentral(const ForceModelSet& forces, int naifId, const timesys::Instant& at) {
    const auto row = Ephemeris::getKernelState(naifId, planetary::kernelCenterId(forces.centralBodyNaifId), at);
    EphemerisState state;
    state.epoch = at.jdTdb();
    state.position = row.position;
    state.velocity = row.velocity;
    state.source = row.source;
    state.valid = row.valid;
    return state;
}

EphemerisState SunAboutCentralBody(const ForceModelSet& forces, const timesys::Instant& at) {
    if (forces.centralBodyNaifId == 399) return getSunPosition(at);
    return BodyAboutCentral(forces, 10, at);
}

namespace {
// Direct minus indirect term of one body (ThirdBodySingle for the Earth's set).
Vec3 pointMass(const Vec3& sat, const Vec3& body, double gm) {
    const Vec3 toBody = body - sat;
    const double d = toBody.magnitude(), r = body.magnitude();
    if (d < 1.0 || r < 1.0) return Vec3();
    return toBody * (gm / (d * d * d)) - body * (gm / (r * r * r));
}
}

Vec3 ThirdBodyAboutCentral(const ForceModelSet& forces, const Vec3& sat, const timesys::Instant& at) {
    const auto& config = forces.thirdBody;
    const int center = forces.centralBodyNaifId;
    const struct { bool on; int id; } bodies[] = {
        {config.includeSun, 10}, {config.includeEarth, 399}, {config.includeMoon && center != 301, 301},
        {config.includeMercury, 1}, {config.includeVenus, 2}, {config.includeMars && center != 499, 4},
        {config.includeJupiter, 5}, {config.includeSaturn, 6}, {config.includeUranus, 7}, {config.includeNeptune, 8},
    };
    Vec3 total;
    for (const auto& body : bodies) {
        if (!body.on) continue;
        const EphemerisState state = BodyAboutCentral(forces, body.id, at);
        if (!state.valid) { flagForceFailure(); return Vec3(NAN, NAN, NAN); }
        total += pointMass(sat, state.position, planetary::thirdBodyGmKm3S2(body.id));
    }
    return total;
}

Vec3 PlanetaryDrag(const ForceModelSet& forces, const Vec3& position, const Vec3& velocity,
                   const timesys::Instant& jd, const DragForceConfig& drag) {
    // The Mars profile about Mars: an Earth model about another body, or Mars's about another, is a force failure.
    if (forces.dragModel != DragModelType::MarsExponential || forces.centralBodyNaifId != planetary::MARS) { flagForceFailure(); return Vec3(NAN, NAN, NAN); }
    // GCRF -> Mars-fixed through the set's rotation hook; the atmosphere turns with the planet about its pole.
    double m[3][3];
    GcrfToEarthFixed(jd, forces, m);
    const Vec3 fixed(m[0][0] * position.x + m[0][1] * position.y + m[0][2] * position.z,
                     m[1][0] * position.x + m[1][1] * position.y + m[1][2] * position.z,
                     m[2][0] * position.x + m[2][1] * position.y + m[2][2] * position.z);
    const double rho = planetary::marsDensityKgM3(planetary::marsAltitudeKm(fixed.x, fixed.y, fixed.z));
    if (!(rho > 0)) return Vec3();
    const Vec3 pole(m[2][0], m[2][1], m[2][2]);
    const Vec3 vRel = velocity - pole.cross(position) * planetary::spinRateRadPerSec(forces.centralBodyNaifId);
    const double speed = vRel.magnitude();   // km/s
    if (speed < 1e-9) return Vec3();
    const double ballistic = drag.Cd * drag.area / drag.mass;   // m^2/kg
    const double magnitude = 0.5 * rho * (speed * 1000.0) * (speed * 1000.0) * ballistic * 1e-3;   // km/s^2
    return vRel * (-magnitude / speed);
}

namespace {
// Row-major rotation times a vector, and its transpose.
Vec3 turn(const double m[3][3], const Vec3& v) {
    return Vec3(m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z, m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z, m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z);
}
Vec3 turnBack(const double m[3][3], const Vec3& v) {
    return Vec3(m[0][0] * v.x + m[1][0] * v.y + m[2][0] * v.z, m[0][1] * v.x + m[1][1] * v.y + m[2][1] * v.z, m[0][2] * v.x + m[1][2] * v.y + m[2][2] * v.z);
}
}

Vec3 ThirdBodyHarmonics(int centralBodyNaifId, const ThirdBodyFieldConfig& config, const Vec3& satPosition, const timesys::Instant& at) {
    if (config.degree < 2) return Vec3();
    const bool aboutEarth = centralBodyNaifId == 399;
    if (!aboutEarth && centralBodyNaifId != planetary::MOON) { flagForceFailure(); return Vec3(NAN, NAN, NAN); }
    // The other body: its center relative to the central body, its field and its fixed axes.
    const int other = aboutEarth ? planetary::MOON : 399;
    const auto row = Ephemeris::getKernelState(other, centralBodyNaifId, at);
    if (!row.valid) { flagForceFailure(); return Vec3(NAN, NAN, NAN); }
    double m[3][3];
    const ExtendedGravityField* field;
    if (aboutEarth) {
        if (!planetary::bodyFixedRotation(planetary::MOON, at, m)) { flagForceFailure(); return Vec3(NAN, NAN, NAN); }
        field = &planetary::embeddedField(planetary::MOON, config.degree, std::min(config.order, config.degree), UINT16_MAX);
    } else {
        GcrfToEarthFixed(at, m);
        EGM2008ForceConfig earth;
        earth.truncationDegree = config.degree;
        earth.truncationOrder = std::min(config.order, config.degree);
        field = &EmbeddedEarthGravityField(earth);
    }
    // Harmonic acceleration of the other body's field at a point (inertial coordinates relative to its center).
    const auto harmonics = [&](const Vec3& relative) {
        return turnBack(m, ffm::computeGravity(turn(m, relative), *field).zonalHarmonics);
    };
    return harmonics(satPosition - row.position) - harmonics(row.position * -1.0);
}

Vec3 PlanetaryHarmonics(const Vec3& position, const PlanetaryFieldConfig& config) {
    const ExtendedGravityField& field = planetary::embeddedField(config.body, config.degree, config.order, config.tesseralDegree);
    return ffm::computeGravity(position, field).zonalHarmonics;
}

} // namespace ForceModel
} // namespace astro
