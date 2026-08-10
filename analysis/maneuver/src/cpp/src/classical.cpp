#include "maneuver/classical.h"
#include "maneuver/fault.h"
#include "maneuver/json_lite.h"
#include "maneuver/math.h"

#include <cmath>
#include <stdexcept>
#include <string>
#include <numeric>

namespace maneuver {

// ===========================================================================
// Hohmann transfer
// ===========================================================================

HohmannResult computeHohmannTransfer(double r1, double r2, double mu) {
    if (r1 <= 0.0 || r2 <= 0.0) {
        return fault::fail<HohmannResult>(fault_code::INVALID_PARAMETER,
            "[classical]: Orbit radii must be positive (r1=" +
            std::to_string(r1) + ", r2=" + std::to_string(r2) + ")");
    }
    if (mu <= 0.0) {
        return fault::fail<HohmannResult>(fault_code::INVALID_PARAMETER,
            "[classical]: Gravitational parameter must be positive");
    }

    // Transfer orbit semi-major axis
    double aTransfer = (r1 + r2) / 2.0;

    // Circular velocities
    double v1_circ = std::sqrt(mu / r1);
    double v2_circ = std::sqrt(mu / r2);

    // Transfer orbit velocities at periapsis and apoapsis
    double v1_transfer = std::sqrt(mu * (2.0 / r1 - 1.0 / aTransfer));
    double v2_transfer = std::sqrt(mu * (2.0 / r2 - 1.0 / aTransfer));

    // Delta-v magnitudes
    double dv1 = v1_transfer - v1_circ;
    double dv2 = v2_circ - v2_transfer;

    // Transfer time (half the transfer orbit period)
    double tof = M_PI * std::sqrt(aTransfer * aTransfer * aTransfer / mu);

    // Delta-v in RIC frame: both burns are prograde (in-track)
    Vector3 dv1_ric = {0.0, dv1, 0.0};
    Vector3 dv2_ric = {0.0, dv2, 0.0};

    return {std::abs(dv1), std::abs(dv2), std::abs(dv1) + std::abs(dv2),
            tof, aTransfer, dv1_ric, dv2_ric};
}

// ===========================================================================
// Bi-elliptic transfer
// ===========================================================================

BiEllipticResult computeBiEllipticTransfer(double r1, double r2, double rInt,
                                            double mu) {
    if (r1 <= 0.0 || r2 <= 0.0 || rInt <= 0.0) {
        return fault::fail<BiEllipticResult>(fault_code::INVALID_PARAMETER,
            "[classical]: All radii must be positive");
    }
    if (rInt <= r1 && rInt <= r2) {
        return fault::fail<BiEllipticResult>(fault_code::INVALID_PARAMETER,
            "[classical]: Intermediate radius must be >= max(r1, r2)");
    }

    // First transfer ellipse: r1 -> rInt
    double aTransfer1 = (r1 + rInt) / 2.0;
    double v1_circ = std::sqrt(mu / r1);
    double v1_transfer1 = std::sqrt(mu * (2.0 / r1 - 1.0 / aTransfer1));
    double dv1 = v1_transfer1 - v1_circ;

    // At intermediate radius on first transfer ellipse
    double vInt_transfer1 = std::sqrt(mu * (2.0 / rInt - 1.0 / aTransfer1));

    // Second transfer ellipse: rInt -> r2
    double aTransfer2 = (rInt + r2) / 2.0;
    double vInt_transfer2 = std::sqrt(mu * (2.0 / rInt - 1.0 / aTransfer2));
    double dv2 = vInt_transfer2 - vInt_transfer1;

    // Circularisation at r2
    double v2_circ = std::sqrt(mu / r2);
    double v2_transfer2 = std::sqrt(mu * (2.0 / r2 - 1.0 / aTransfer2));
    double dv3 = v2_circ - v2_transfer2;

    // Transfer time: half-period of each transfer ellipse
    double tof1 = M_PI * std::sqrt(aTransfer1 * aTransfer1 * aTransfer1 / mu);
    double tof2 = M_PI * std::sqrt(aTransfer2 * aTransfer2 * aTransfer2 / mu);
    double tof = tof1 + tof2;

    Vector3 dv1_ric = {0.0, dv1, 0.0};
    Vector3 dv2_ric = {0.0, dv2, 0.0};
    Vector3 dv3_ric = {0.0, dv3, 0.0};

    return {std::abs(dv1), std::abs(dv2), std::abs(dv3),
            std::abs(dv1) + std::abs(dv2) + std::abs(dv3),
            tof, aTransfer1, aTransfer2, dv1_ric, dv2_ric, dv3_ric};
}

// ===========================================================================
// General (one-impulse) transfer
// ===========================================================================

GeneralTransferResult computeGeneralTransfer(
    const ClassicalOrbitalElements& oe1, const ClassicalOrbitalElements& oe2,
    double nu) {
    double mu = oe1.gravitationalParameter;

    // Compute velocity on initial orbit at true anomaly nu
    double r1 = orbitalRadius(oe1.semiMajorAxis, oe1.eccentricity, nu);
    double a1 = oe1.semiMajorAxis;
    double v1_total = std::sqrt(mu * (2.0 / r1 - 1.0 / a1));

    // Compute velocity on final orbit at the same radius
    double a2 = oe2.semiMajorAxis;
    double v2_total = std::sqrt(mu * (2.0 / r1 - 1.0 / a2));

    // Flight path angles
    double e1 = oe1.eccentricity;
    double e2 = oe2.eccentricity;
    double h1 = std::sqrt(mu * a1 * (1.0 - e1 * e1));
    double h2 = std::sqrt(mu * a2 * (1.0 - e2 * e2));

    double gamma1 = std::atan2(mu * e1 * std::sin(nu) / h1,
                               mu * (1.0 + e1 * std::cos(nu)) / h1);
    double gamma2 = std::atan2(mu * e2 * std::sin(nu) / h2,
                               mu * (1.0 + e2 * std::cos(nu)) / h2);

    // Velocity components in local-horizon frame
    double vr1 = v1_total * std::sin(gamma1);
    double vt1 = v1_total * std::cos(gamma1);
    double vr2 = v2_total * std::sin(gamma2);
    double vt2 = v2_total * std::cos(gamma2);

    // Delta-v in RIC
    double dvR = vr2 - vr1;
    double dvI = vt2 - vt1;
    // Plane change contribution
    double di = oe2.inclination - oe1.inclination;
    double dvC = vt1 * di;  // Small angle approximation for plane change

    double dv = std::sqrt(dvR * dvR + dvI * dvI + dvC * dvC);

    return {dv, {dvR, dvI, dvC}};
}

// ===========================================================================
// Patched conic (interplanetary Hohmann)
// ===========================================================================

PatchedConicResult computePatchedConicTransfer(const Planet& departurePlanet,
                                               const Planet& arrivalPlanet,
                                               double parkingAltDepart,
                                               double parkingAltArrive,
                                               double muSun) {
    double r1_helio = departurePlanet.semiMajorAxis;
    double r2_helio = arrivalPlanet.semiMajorAxis;

    // Heliocentric Hohmann transfer
    double aTransfer = (r1_helio + r2_helio) / 2.0;

    // Heliocentric circular velocities
    double vPlanet1 = std::sqrt(muSun / r1_helio);
    double vPlanet2 = std::sqrt(muSun / r2_helio);

    // Transfer orbit velocities
    double vTransfer_depart = std::sqrt(muSun * (2.0 / r1_helio - 1.0 / aTransfer));
    double vTransfer_arrive = std::sqrt(muSun * (2.0 / r2_helio - 1.0 / aTransfer));

    // Hyperbolic excess velocities
    double vInfDepart = std::abs(vTransfer_depart - vPlanet1);
    double vInfArrive = std::abs(vPlanet2 - vTransfer_arrive);

    // Departure: escape from circular parking orbit
    // v_escape = sqrt(v_inf^2 + 2*mu_planet/r_park)
    double rParkDepart = parkingAltDepart;  // altitude above surface
    // For simplicity, assume planet radius is encoded in the parking radius
    // In practice: rPark = R_planet + altitude
    // Using the mu to derive approximate planet radius: R ≈ (mu / g)^(1/2) is
    // not standard; instead take parking altitude as radius of parking orbit
    double rPark1 = rParkDepart;
    if (rPark1 <= 0.0) rPark1 = 200e3;  // default 200 km
    // For Earth: parking orbit radius = R_EARTH + altitude
    double rOrbit1 = R_EARTH + rPark1;  // assumes departure from Earth

    double vPark1 = std::sqrt(departurePlanet.mu / rOrbit1);
    double vEscape1 =
        std::sqrt(vInfDepart * vInfDepart + 2.0 * departurePlanet.mu / rOrbit1);
    double dvDepart = vEscape1 - vPark1;

    // Arrival: capture to circular parking orbit
    double rPark2 = parkingAltArrive;
    if (rPark2 <= 0.0) rPark2 = 200e3;
    // For Mars: approximate radius from mu (Mars radius ~ 3389.5 km)
    double rMars = 3.3895e6;  // meters
    double rOrbit2 = rMars + rPark2;

    double vPark2 = std::sqrt(arrivalPlanet.mu / rOrbit2);
    double vCapture2 =
        std::sqrt(vInfArrive * vInfArrive + 2.0 * arrivalPlanet.mu / rOrbit2);
    double dvArrive = vCapture2 - vPark2;

    // Transfer time
    double tof = M_PI * std::sqrt(aTransfer * aTransfer * aTransfer / muSun);

    return {vInfDepart,   vInfArrive,   std::abs(dvDepart),
            std::abs(dvArrive),
            std::abs(dvDepart) + std::abs(dvArrive),
            tof,          aTransfer};
}

// ===========================================================================
// Delta-V budget
// ===========================================================================

DeltaVBudget computeDeltaVBudget(const std::vector<double>& phases) {
    double total = 0.0;
    for (double dv : phases) total += std::abs(dv);
    return {phases, total};
}

// ===========================================================================
// Cartesian state -> classical elements, and the phase geometry of a pair
// ===========================================================================

namespace {

/// The orbit normal implied by an inclination/RAAN pair. Unit length by
/// construction.
Vector3 orbitNormal(double inclination, double raan) {
    const double si = std::sin(inclination);
    return {si * std::sin(raan), -si * std::cos(raan), std::cos(inclination)};
}

/// sin(i) below this fraction of unity leaves the node line unresolvable, so
/// RAAN is fixed at zero and the argument of latitude is measured from +x.
/// The SUM raan + argumentOfPerigee + meanAnomaly is continuous across the
/// switch, which is why the geometry below only ever consumes sums.
constexpr double kNodeFloor = 1.0e-11;

/// Below this eccentricity the eccentricity vector's DIRECTION is noise, so
/// the perigee is placed at the node and the whole angle is carried by the
/// mean anomaly. See the header note on why this loses nothing.
constexpr double kCircularFloor = 1.0e-11;

}  // namespace

ClassicalOrbitalElements stateToClassicalElements(const Vector3& position,
                                                  const Vector3& velocity,
                                                  double mu) {
    if (!(mu > 0.0)) {
        return fault::fail<ClassicalOrbitalElements>(
            fault_code::INVALID_PARAMETER,
            "[state-to-elements]: mu must be positive");
    }
    const double r = norm3(position);
    const double v = norm3(velocity);
    if (!(r > 0.0)) {
        return fault::fail<ClassicalOrbitalElements>(
            fault_code::INVALID_PARAMETER,
            "[state-to-elements]: position must be a non-zero vector");
    }

    const Vector3 h = cross3(position, velocity);
    const double hMag = norm3(h);
    if (!(hMag > 0.0)) {
        return fault::fail<ClassicalOrbitalElements>(
            fault_code::SINGULAR,
            "[state-to-elements]: the state is rectilinear (r x v = 0). It has "
            "no orbital plane, so it has no inclination, no node and no "
            "argument of latitude to phase against.");
    }
    const Vector3 hHat = {h[0] / hMag, h[1] / hMag, h[2] / hMag};

    // Inclination from atan2 rather than acos(hz/|h|): near 0 and pi the acos
    // form loses half its significant digits to the flat cosine.
    const double inclination = std::atan2(
        std::sqrt(hHat[0] * hHat[0] + hHat[1] * hHat[1]), hHat[2]);

    // Node line n = zhat x h = (-hy, hx, 0).
    const double nx = -h[1];
    const double ny = h[0];
    const double nMag = std::sqrt(nx * nx + ny * ny);
    double raan = 0.0;
    Vector3 nHat = {1.0, 0.0, 0.0};
    if (nMag > kNodeFloor * hMag) {
        raan = normalizeAngle(std::atan2(ny, nx));
        nHat = {nx / nMag, ny / nMag, 0.0};
    }
    // In-plane quadrature axis, pointing where the argument of latitude
    // increases: at the ascending node the motion is along hHat x nHat.
    const Vector3 mHat = cross3(hHat, nHat);

    // Argument of latitude, straight off the position vector. Exact for any
    // eccentricity including zero.
    const double u = std::atan2(dot3(position, mHat), dot3(position, nHat));

    const double energy = 0.5 * v * v - mu / r;
    if (!(energy < 0.0)) {
        return fault::fail<ClassicalOrbitalElements>(
            fault_code::NO_SOLUTION,
            "[state-to-elements]: specific orbital energy is " +
                json_lite::numberToString(energy) +
                " m^2/s^2, which is not negative: the state is on an escape "
                "trajectory and has no closed orbit, no period and no mean "
                "anomaly. Phasing is defined only between two closed orbits.");
    }
    const double a = -mu / (2.0 * energy);

    // Eccentricity vector, e = ((v^2 - mu/r) r - (r.v) v) / mu.
    const double rdotv = dot3(position, velocity);
    const double vv = v * v;
    Vector3 eVec{};
    for (int k = 0; k < 3; ++k) {
        eVec[k] = ((vv - mu / r) * position[k] - rdotv * velocity[k]) / mu;
    }
    const double ecc = norm3(eVec);
    if (ecc >= 1.0) {
        return fault::fail<ClassicalOrbitalElements>(
            fault_code::NO_SOLUTION,
            "[state-to-elements]: eccentricity is " +
                json_lite::numberToString(ecc) +
                ", which is not a closed orbit.");
    }

    double argumentOfPerigee = 0.0;
    if (ecc > kCircularFloor) {
        argumentOfPerigee = std::atan2(dot3(eVec, mHat), dot3(eVec, nHat));
    }
    // THE cancellation: nu is a DIFFERENCE, so the noise in argumentOfPerigee
    // leaves argumentOfPerigee + meanAnomaly untouched.
    const double nu = u - argumentOfPerigee;
    const double eccentricAnomaly =
        std::atan2(std::sqrt(1.0 - ecc * ecc) * std::sin(nu), ecc + std::cos(nu));
    const double meanAnomaly =
        eccentricAnomaly - ecc * std::sin(eccentricAnomaly);

    ClassicalOrbitalElements oe;
    oe.semiMajorAxis = a;
    oe.eccentricity = ecc;
    oe.inclination = inclination;
    oe.raan = raan;
    oe.argumentOfPerigee = normalizeAngle(argumentOfPerigee);
    oe.meanAnomaly = normalizeAngle(meanAnomaly);
    oe.gravitationalParameter = mu;
    oe.angularMomentum = hMag;
    return oe;
}

PhaseGeometry computePhaseGeometry(const ClassicalOrbitalElements& chaser,
                                   const ClassicalOrbitalElements& target) {
    PhaseGeometry g;

    const double lambdaChaser =
        normalizeAngle(chaser.argumentOfPerigee + chaser.meanAnomaly);
    const double lambdaTarget =
        normalizeAngle(target.argumentOfPerigee + target.meanAnomaly);
    g.chaserMeanArgumentOfLatitude = lambdaChaser;
    g.targetMeanArgumentOfLatitude = lambdaTarget;
    g.chaserMeanAnomaly = normalizeAngle(chaser.meanAnomaly);
    g.targetMeanAnomaly = normalizeAngle(target.meanAnomaly);

    g.raanDifference = wrapToPi(target.raan - chaser.raan);
    g.inclinationDifference = target.inclination - chaser.inclination;

    const Vector3 hChaser = orbitNormal(chaser.inclination, chaser.raan);
    const Vector3 hTarget = orbitNormal(target.inclination, target.raan);
    double alignment = dot3(hChaser, hTarget);
    if (alignment > 1.0) alignment = 1.0;
    if (alignment < -1.0) alignment = -1.0;
    g.planeAngle = std::acos(alignment);

    // The quasi-nonsingular relative mean longitude, target-leading.
    g.relativePhaseAngle = wrapToPi(
        (lambdaTarget - lambdaChaser) +
        g.raanDifference * std::cos(chaser.inclination));

    // The two ways to fly the same rendezvous. At an exactly-zero separation
    // the short way is "do nothing" and the two named directions are both a
    // full lap; that is the truthful answer, not a degenerate one.
    g.catchUpAngle = g.relativePhaseAngle > 0.0
                         ? g.relativePhaseAngle
                         : g.relativePhaseAngle + TWO_PI;
    g.fallBehindAngle = g.relativePhaseAngle < 0.0
                            ? g.relativePhaseAngle
                            : g.relativePhaseAngle - TWO_PI;

    g.chaserSemiMajorAxis = chaser.semiMajorAxis;
    g.targetSemiMajorAxis = target.semiMajorAxis;
    g.semiMajorAxisDifference = target.semiMajorAxis - chaser.semiMajorAxis;
    g.chaserEccentricity = chaser.eccentricity;
    g.targetEccentricity = target.eccentricity;
    return g;
}

}  // namespace maneuver
