#ifndef MANEUVER_CLASSICAL_H
#define MANEUVER_CLASSICAL_H

#include "types.h"
#include "constants.h"

#include <vector>

namespace maneuver {

// ---------------------------------------------------------------------------
// Classical orbital maneuver computations
// ---------------------------------------------------------------------------

/// Result of a Hohmann transfer computation.
struct HohmannResult {
    double dv1;          // first burn magnitude [m/s]
    double dv2;          // second burn magnitude [m/s]
    double totalDeltaV;  // total delta-v [m/s]
    double tof;          // transfer time [seconds]
    double aTransfer;    // transfer orbit semi-major axis [m]
    Vector3 dv1_ric;     // first burn in RIC frame [m/s]
    Vector3 dv2_ric;     // second burn in RIC frame [m/s]
};

/// Compute a Hohmann transfer between two circular orbits.
/// @param r1  initial circular orbit radius [m]
/// @param r2  final circular orbit radius [m]
/// @param mu  gravitational parameter [m^3/s^2]
HohmannResult computeHohmannTransfer(double r1, double r2,
                                     double mu = MU_EARTH);

/// Result of a bi-elliptic transfer.
struct BiEllipticResult {
    double dv1;          // first burn magnitude [m/s]
    double dv2;          // second burn at intermediate radius [m/s]
    double dv3;          // third burn to circularise [m/s]
    double totalDeltaV;  // total delta-v [m/s]
    double tof;          // total transfer time [seconds]
    double aTransfer1;   // first transfer orbit SMA [m]
    double aTransfer2;   // second transfer orbit SMA [m]
    Vector3 dv1_ric;
    Vector3 dv2_ric;
    Vector3 dv3_ric;
};

/// Compute a bi-elliptic transfer between two circular orbits via an
/// intermediate apoapsis radius.
/// @param r1   initial radius [m]
/// @param r2   final radius [m]
/// @param rInt intermediate apoapsis radius [m]
/// @param mu   gravitational parameter [m^3/s^2]
BiEllipticResult computeBiEllipticTransfer(double r1, double r2, double rInt,
                                           double mu = MU_EARTH);

/// Result of a general (one-impulse) orbit change.
struct GeneralTransferResult {
    double dv;           // delta-v magnitude [m/s]
    Vector3 dv_ric;      // delta-v vector in RIC [m/s]
};

/// Compute a single-impulse transfer: general velocity change to move
/// from one orbit to another at a given true anomaly.
/// @param oe1  initial orbit elements
/// @param oe2  final orbit elements
/// @param nu   true anomaly at which the burn occurs [rad]
GeneralTransferResult computeGeneralTransfer(
    const ClassicalOrbitalElements& oe1,
    const ClassicalOrbitalElements& oe2,
    double nu);

// ---------------------------------------------------------------------------
// Interplanetary patched conics
// ---------------------------------------------------------------------------

/// Result of an interplanetary patched-conic transfer.
struct PatchedConicResult {
    double vInfDepart;     // departure hyperbolic excess speed [m/s]
    double vInfArrive;     // arrival hyperbolic excess speed [m/s]
    double dvDepart;       // departure delta-v from circular parking orbit [m/s]
    double dvArrive;       // arrival delta-v to circular orbit [m/s]
    double totalDeltaV;    // total mission delta-v [m/s]
    double tof;            // heliocentric transfer time [seconds]
    double aTransfer;      // heliocentric transfer SMA [m]
};

/// Compute an interplanetary Hohmann-type patched-conic transfer.
/// @param departurePlanet  departure planet data
/// @param arrivalPlanet    arrival planet data
/// @param parkingAltDepart departure parking orbit altitude [m]
/// @param parkingAltArrive arrival parking orbit altitude [m]
/// @param muSun            Sun gravitational parameter [m^3/s^2]
PatchedConicResult computePatchedConicTransfer(
    const Planet& departurePlanet,
    const Planet& arrivalPlanet,
    double parkingAltDepart,
    double parkingAltArrive,
    double muSun = MU_SUN);

/// Compute delta-v budget summary for a multi-phase mission.
struct DeltaVBudget {
    std::vector<double> phaseDeltas;   // per-phase delta-v [m/s]
    double totalDeltaV;                // sum [m/s]
};

/// Build a delta-v budget from a vector of phase delta-v magnitudes.
DeltaVBudget computeDeltaVBudget(const std::vector<double>& phases);

}  // namespace maneuver

#endif  // MANEUVER_CLASSICAL_H
