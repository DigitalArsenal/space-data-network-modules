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

// ---------------------------------------------------------------------------
// Cartesian state -> classical elements, and the phase geometry of a pair
// ---------------------------------------------------------------------------

/// Recover classical elements from an inertial (ECI) Cartesian state.
///
/// SI THROUGHOUT: `position` in metres, `velocity` in m/s, `mu` in m^3/s^2.
/// (`maneuver_plugin.cpp` carries a private km-native converter for the OEM
/// path; this is the metre-native one the JSON surface uses, and the two are
/// deliberately separate because the OEM one is not reachable from `invoke`.)
///
/// THE ONE DESIGN DECISION THAT MATTERS HERE is that the true anomaly is
/// computed as `u - argumentOfPerigee`, where `u` is the argument of latitude
/// read straight off the POSITION vector in the node basis — never from the
/// eccentricity vector's own dot product with `r`.
///
/// Why: for a near-circular orbit the eccentricity vector is a difference of
/// O(1) quantities with magnitude O(e), so its DIRECTION carries a relative
/// error of order eps/e — at e = 1e-9 that is ~1e-7 radians of noise in
/// `argumentOfPerigee`. Taking `nu = u - argumentOfPerigee` makes that error
/// cancel exactly in the sum `argumentOfPerigee + meanAnomaly`, which is the
/// mean argument of latitude and the ONLY angle a phasing computation actually
/// consumes. Recovering `nu` independently from the eccentricity vector leaves
/// the two errors uncorrelated and the sum wrong by the same 1e-7 — on a
/// 6,778 km orbit that is 0.7 m of phantom along-track separation per 1e-9 of
/// eccentricity, which is exactly the regime the console's near-circular
/// rendezvous cards live in.
///
/// Refuses (fault latch, never a trap): a zero position, a rectilinear state
/// (r x v = 0, which has no orbital plane and therefore no argument of
/// latitude), a non-positive `mu`, and any state whose specific orbital energy
/// is not negative — a mean anomaly exists only on a closed orbit.
ClassicalOrbitalElements stateToClassicalElements(const Vector3& position,
                                                  const Vector3& velocity,
                                                  double mu = MU_EARTH);

/// The along-track geometry of a chaser/target pair.
///
/// Every angle is in radians. `relativePhaseAngle` is the quantity
/// `computePhasingManeuver` consumes as its `phaseAngle`.
struct PhaseGeometry {
    /// Signed, wrapped to (-pi, pi]. POSITIVE means the TARGET LEADS the
    /// chaser and the chaser must gain phase to close the gap.
    double relativePhaseAngle = 0.0;
    /// The same rendezvous taken the SHORT way forward: (0, 2pi]. The chaser
    /// gains phase (drops to a lower, faster orbit).
    double catchUpAngle = 0.0;
    /// The same rendezvous taken the other way: [-2pi, 0). The chaser loses
    /// phase (rises to a higher, slower orbit).
    double fallBehindAngle = 0.0;
    /// Mean argument of latitude, `argumentOfPerigee + meanAnomaly`, [0, 2pi).
    /// This — NOT the mean anomaly — is the angle that advances uniformly at
    /// the mean motion regardless of where the apsides sit.
    double chaserMeanArgumentOfLatitude = 0.0;
    double targetMeanArgumentOfLatitude = 0.0;
    /// Published because the filed spec named them, and because seeing both
    /// beside the mean arguments of latitude is what shows a reader that a
    /// mean-anomaly difference is NOT the answer whenever the apsides differ.
    double chaserMeanAnomaly = 0.0;
    double targetMeanAnomaly = 0.0;
    /// target - chaser, wrapped to (-pi, pi].
    double raanDifference = 0.0;
    /// target - chaser, signed, radians.
    double inclinationDifference = 0.0;
    /// The angle between the two orbit normals, [0, pi]. The honest single
    /// scalar for "are these the same plane": two orbits can share an
    /// inclination and be 180 degrees apart in RAAN.
    double planeAngle = 0.0;
    double semiMajorAxisDifference = 0.0;  // target - chaser [m]
    double chaserSemiMajorAxis = 0.0;      // [m]
    double targetSemiMajorAxis = 0.0;      // [m]
    double chaserEccentricity = 0.0;
    double targetEccentricity = 0.0;
};

/// Derive the along-track phase geometry of a chaser/target pair.
///
/// `relativePhaseAngle` is the relative mean longitude of the pair, in the
/// quasi-nonsingular ROE sense this module already uses for `dlambda`
/// (Koenig-Guffanti-D'Amico):
///
///     delta-lambda = (u_deputy - u_chief) + (raan_deputy - raan_chief) * cos(i_chief)
///
/// evaluated with the TARGET as the leading craft, so a positive answer means
/// the target is ahead. The `cos(i)` projection is what makes the RAAN
/// difference enter as the in-plane rotation it actually is; for the coplanar
/// pair the phasing card contracts on it vanishes and the answer is simply the
/// difference of the two mean arguments of latitude. The chaser's inclination
/// is the reference because the chaser's orbit is the one the phasing plan is
/// flown on.
///
/// Both element sets must be at the SAME epoch. Nothing here propagates.
PhaseGeometry computePhaseGeometry(const ClassicalOrbitalElements& chaser,
                                   const ClassicalOrbitalElements& target);

}  // namespace maneuver

#endif  // MANEUVER_CLASSICAL_H
