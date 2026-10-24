// What a force set needs to fly about the Moon or Mars rather than the Earth (lib/planetary_fields.h): the bodies'
// positions relative to the central body, the third-body point masses about it, and its embedded harmonic field.
// force_models.cpp reads these only for a set whose centralBodyNaifId is not 399.
#include "force_models.h"
#include "ffm_gravity.h"
#include "ephemeris.h"
#include "planetary_fields.h"
#include "reentry.h"
#include <cmath>

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

Vec3 PlanetaryHarmonics(const Vec3& position, const PlanetaryFieldConfig& config) {
    const ExtendedGravityField& field = planetary::embeddedField(config.body, config.degree, config.order, config.tesseralDegree);
    return ffm::computeGravity(position, field).zonalHarmonics;
}

} // namespace ForceModel
} // namespace astro
