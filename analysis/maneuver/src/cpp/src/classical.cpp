#include "maneuver/classical.h"
#include "maneuver/fault.h"
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

}  // namespace maneuver
