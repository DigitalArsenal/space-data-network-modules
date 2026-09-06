#include "maneuver/orbit_geometry.h"
#include "maneuver/constants.h"
#include "maneuver/fault.h"
#include "state_representations.hpp"

#include <algorithm>
#include <cmath>

namespace maneuver {
namespace orbit_geometry {
namespace orb = sdn::orbits;
using json_lite::ObjectWriter;
using json_lite::Value;

bool refuse(const std::string& message) {
    fault::raise(fault_code::INVALID_PARAMETER, message);
    return false;
}

bool closed(const orb::Keplerian& e) {
    return std::isfinite(e.semiMajorAxis) && e.semiMajorAxis > 0.0 &&
        std::isfinite(e.eccentricity) && e.eccentricity >= 0.0 && e.eccentricity < 1.0;
}

double meanAnomaly(const orb::Keplerian& e) {
    return orb::wrapTwoPi(orb::eccentricToMeanAnomaly(
        orb::trueToEccentricAnomaly(e.trueAnomaly, e.eccentricity), e.eccentricity));
}

bool trueFromMean(double mean, double eccentricity, double* out) {
    double eccentric = 0.0;
    if (!orb::meanToEccentricAnomaly(mean, eccentricity, &eccentric)) {
        return refuse("Orbit anomaly did not converge for a finite closed orbit.");
    }
    *out = orb::wrapTwoPi(orb::eccentricToTrueAnomaly(eccentric, eccentricity));
    return std::isfinite(*out);
}

double motion(const orb::Keplerian& e, double mu) {
    return std::sqrt(mu / e.semiMajorAxis) / e.semiMajorAxis;
}

bool vector(const Value& p, const char* key, const char* op, orb::Vec3* out) {
    double v[3];
    if (!json_lite::requireVec3(p, key, op, v)) return false;
    *out = {v[0], v[1], v[2]};
    return true;
}

void writeVector(ObjectWriter& out, const char* key, const orb::Vec3& v) {
    const double values[] = {v.x, v.y, v.z};
    out.vec3(key, values);
}

bool readOrbit(const Value& p, const char* op, orb::Keplerian* e, double* mu) {
    *mu = MU_EARTH;
    if (!json_lite::optionalPositive(p, "mu", op, mu)) return false;
    const Value* state = p.find("state");
    const Value* elements = p.find("elements");
    if ((state != nullptr) == (elements != nullptr)) {
        return refuse("Orbit geometry requires exactly one of state or elements.");
    }
    if (state != nullptr) {
        orb::Cartesian cartesian;
        if (!vector(*state, "position", op, &cartesian.position) ||
            !vector(*state, "velocity", op, &cartesian.velocity)) return false;
        if (!orb::keplerianFromCartesian(cartesian, *mu, e) || !closed(*e)) {
            return refuse("State does not define a finite closed orbit (escape or singular state).");
        }
    } else {
        if (!json_lite::requirePositive(*elements, "semiMajorAxis", op, &e->semiMajorAxis) ||
            !json_lite::requireNumber(*elements, "eccentricity", op, &e->eccentricity) ||
            !json_lite::requireNumber(*elements, "inclination", op, &e->inclination) ||
            !json_lite::requireNumber(*elements, "raan", op, &e->raan) ||
            !json_lite::requireNumber(*elements, "argumentOfPeriapsis", op, &e->argumentOfPeriapsis)) return false;
        if (!closed(*e) || e->inclination < 0.0 || e->inclination > orb::kPi) {
            return refuse("Orbit elements require a > 0, 0 <= e < 1 and 0 <= inclination <= pi.");
        }
        const bool hasTrue = elements->has("trueAnomaly");
        const bool hasMean = elements->has("meanAnomaly");
        if (hasTrue == hasMean) return refuse("Elements require exactly one trueAnomaly or meanAnomaly.");
        if (hasTrue) {
            if (!json_lite::requireNumber(*elements, "trueAnomaly", op, &e->trueAnomaly)) return false;
            e->trueAnomaly = orb::wrapTwoPi(e->trueAnomaly);
        } else {
            double mean = 0.0;
            if (!json_lite::requireNumber(*elements, "meanAnomaly", op, &mean) ||
                !trueFromMean(mean, e->eccentricity, &e->trueAnomaly)) return false;
        }
    }
    if (!(motion(*e, *mu) > 0.0) || !std::isfinite(orb::kTwoPi / motion(*e, *mu))) {
        return refuse("Orbit mean motion or period is not finite.");
    }
    return true;
}

bool advance(const Value& p, const char* op, double mu, orb::Keplerian* e) {
    if (p.has("atTrueAnomaly") && p.has("elapsedSeconds")) {
        return refuse("Specify atTrueAnomaly or elapsedSeconds, never both.");
    }
    if (p.has("atTrueAnomaly")) {
        if (!json_lite::requireNumber(p, "atTrueAnomaly", op, &e->trueAnomaly)) return false;
        e->trueAnomaly = orb::wrapTwoPi(e->trueAnomaly);
    } else if (p.has("elapsedSeconds")) {
        double dt = 0.0;
        if (!json_lite::requireNumber(p, "elapsedSeconds", op, &dt)) return false;
        const double mean = meanAnomaly(*e) + motion(*e, mu) * dt;
        if (!std::isfinite(mean)) return refuse("Elapsed orbit phase is not finite.");
        if (!trueFromMean(mean, e->eccentricity, &e->trueAnomaly)) return false;
    }
    return true;
}

std::string writeElements(const orb::Keplerian& e, double mu) {
    ObjectWriter out;
    out.number("semiMajorAxis", e.semiMajorAxis).number("eccentricity", e.eccentricity)
        .number("inclination", e.inclination).number("raan", e.raan)
        .number("argumentOfPeriapsis", e.argumentOfPeriapsis)
        .number("trueAnomaly", e.trueAnomaly).number("meanAnomaly", meanAnomaly(e))
        .number("ascendingNodeTrueAnomaly", orb::wrapTwoPi(-e.argumentOfPeriapsis))
        .number("meanMotion", motion(e, mu)).number("period", orb::kTwoPi / motion(e, mu))
        .number("periapsisRadius", e.semiMajorAxis * (1.0 - e.eccentricity))
        .number("apoapsisRadius", e.semiMajorAxis * (1.0 + e.eccentricity));
    return out.finish();
}

std::string evaluate(const Value& p) {
    const char* op = "evaluateOrbitGeometry";
    orb::Keplerian e;
    double mu = MU_EARTH;
    if (!readOrbit(p, op, &e, &mu) || !advance(p, op, mu, &e)) return {};
    orb::Cartesian state;
    if (!orb::cartesianFromKeplerian(e, mu, &state)) {
        refuse("Orbit elements do not produce a finite state."); return {};
    }
    const auto radial = orb::unit(state.position);
    const auto normal = orb::unit(orb::cross(state.position, state.velocity));
    const auto inTrack = orb::cross(normal, radial);
    const auto prograde = orb::unit(state.velocity);
    const auto conormal = orb::cross(prograde, normal);
    if (p.has("deltaV")) {
        orb::Vec3 delta;
        if (!vector(p, "deltaV", op, &delta)) return {};
        std::string frame;
        if (!json_lite::optionalString(p, "deltaVFrame", op, &frame)) return {};
        if (frame == "RIC") {
            delta = orb::add(orb::add(orb::scale(radial, delta.x), orb::scale(inTrack, delta.y)), orb::scale(normal, delta.z));
        } else if (frame == "VNC") {
            delta = orb::add(orb::add(orb::scale(prograde, delta.x), orb::scale(normal, delta.y)), orb::scale(conormal, delta.z));
        } else if (frame != "ECI") {
            refuse("deltaVFrame must explicitly name ECI, RIC or VNC."); return {};
        }
        state.velocity = orb::add(state.velocity, delta);
        orb::Keplerian after;
        if (!orb::finite(state.velocity) || !orb::keplerianFromCartesian(state, mu, &after) ||
            !closed(after) || !std::isfinite(orb::kTwoPi / motion(after, mu))) {
            refuse("Requested burn does not produce a finite closed orbit (escape or singular state).");
            return {};
        }
        e = after;
    }
    ObjectWriter out, stateOut, ric, vnc;
    writeVector(stateOut, "position", state.position);
    writeVector(stateOut, "velocity", state.velocity);
    writeVector(ric, "radial", radial); writeVector(ric, "inTrack", inTrack); writeVector(ric, "crossTrack", normal);
    writeVector(vnc, "velocity", prograde); writeVector(vnc, "normal", normal); writeVector(vnc, "conormal", conormal);
    out.raw("elements", writeElements(e, mu)).raw("state", stateOut.finish())
        .raw("departureRicBasis", ric.finish()).raw("departureVncBasis", vnc.finish())
        .number("radius", orb::norm(state.position))
        .string("positionFrame", "INERTIAL").string("units", "SI");
    return out.finish();
}

std::string anomaly(const Value& p) {
    const char* op = "convertOrbitAnomaly";
    double e = 0.0, value = 0.0;
    std::string from;
    if (!json_lite::requireNumber(p, "eccentricity", op, &e) ||
        !json_lite::requireNumber(p, "anomaly", op, &value) ||
        !json_lite::optionalString(p, "from", op, &from)) return {};
    if (e < 0.0 || e >= 1.0) { refuse("Anomaly conversion requires 0 <= e < 1."); return {}; }
    double eccentric = 0.0;
    if (from == "true") eccentric = orb::trueToEccentricAnomaly(value, e);
    else if (from == "eccentric") eccentric = value;
    else if (from == "mean") {
        if (!orb::meanToEccentricAnomaly(value, e, &eccentric)) { refuse("Mean anomaly did not converge."); return {}; }
    } else { refuse("from must explicitly name true, mean or eccentric."); return {}; }
    ObjectWriter out;
    out.number("trueAnomaly", orb::wrapTwoPi(orb::eccentricToTrueAnomaly(eccentric, e)))
        .number("meanAnomaly", orb::wrapTwoPi(orb::eccentricToMeanAnomaly(eccentric, e)))
        .number("eccentricAnomaly", orb::wrapTwoPi(eccentric));
    return out.finish();
}

std::string timeOfFlight(const Value& p) {
    const char* op = "orbitTimeOfFlight";
    orb::Keplerian e;
    double mu, from = 0.0, to = 0.0;
    int revolutions = 0;
    if (!readOrbit(p, op, &e, &mu) ||
        !json_lite::requireNumber(p, "fromTrueAnomaly", op, &from) ||
        !json_lite::requireNumber(p, "toTrueAnomaly", op, &to) ||
        !json_lite::optionalInt(p, "revolutions", op, &revolutions)) return {};
    if (revolutions < 0 || revolutions > 100000) { refuse("revolutions must be in [0, 100000]."); return {}; }
    e.trueAnomaly = from;
    const double first = meanAnomaly(e);
    e.trueAnomaly = to;
    double sweep = orb::wrapTwoPi(meanAnomaly(e) - first);
    // Identical burn points recovered through different conversions must not
    // move to the next revolution. Match the existing scheduling resolution.
    if (sweep < 1e-5 || sweep > orb::kTwoPi - 1e-5) sweep = 0.0;
    ObjectWriter out;
    out.number("seconds", (sweep + revolutions * orb::kTwoPi) / motion(e, mu));
    return out.finish();
}

std::string sample(const Value& p) {
    const char* op = "sampleOrbitGeometry";
    orb::Keplerian e;
    double mu, from = 0.0, sweep = orb::kTwoPi;
    int count = 0;
    if (!readOrbit(p, op, &e, &mu) ||
        !json_lite::requireInt(p, "count", op, &count) ||
        !json_lite::optionalNumber(p, "fromTrueAnomaly", op, &from) ||
        !json_lite::optionalNumber(p, "sweep", op, &sweep)) return {};
    if (count < 2 || count > 4096 || std::abs(sweep) > orb::kTwoPi) {
        refuse("Orbit sampling requires 2..4096 points and at most one revolution."); return {};
    }
    std::vector<double> positions, offsets;
    offsets.reserve(count);
    e.trueAnomaly = from;
    const double firstMean = meanAnomaly(e);
    const double n = motion(e, mu);
    positions.reserve(static_cast<std::size_t>(count) * 3);
    for (int i = 0; i < count; ++i) {
        e.trueAnomaly = from + sweep * i / (count - 1);
        orb::Cartesian state;
        if (!orb::cartesianFromKeplerian(e, mu, &state)) { refuse("Orbit sample is not finite."); return {}; }
        positions.insert(positions.end(), {state.position.x, state.position.y, state.position.z});
        double deltaMean = sweep < 0.0
            ? -orb::wrapTwoPi(firstMean - meanAnomaly(e))
            : orb::wrapTwoPi(meanAnomaly(e) - firstMean);
        if (i == 0 || sweep == 0.0) deltaMean = 0.0;
        else if (i == count - 1 && std::abs(sweep) >= orb::kTwoPi - 1e-12)
            deltaMean = std::copysign(orb::kTwoPi, sweep);
        offsets.push_back(deltaMean / n);
    }
    ObjectWriter out;
    out.numbers("positions", positions.data(), positions.size())
        .numbers("offsets", offsets.data(), offsets.size()).integer("count", count);
    return out.finish();
}
}  // namespace orbit_geometry

std::string orbitGeometryOperation(const std::string& operation, const json_lite::Value& params) {
    if (operation == "evaluateOrbitGeometry") return orbit_geometry::evaluate(params);
    if (operation == "convertOrbitAnomaly") return orbit_geometry::anomaly(params);
    if (operation == "orbitTimeOfFlight") return orbit_geometry::timeOfFlight(params);
    return orbit_geometry::sample(params);
}
}  // namespace maneuver
