#ifndef MANEUVER_APPROACH_H
#define MANEUVER_APPROACH_H

#include "types.h"
#include "constants.h"
#include "classical.h"

#include <vector>

namespace maneuver {

// ---------------------------------------------------------------------------
// RPO Approach Strategies
// ---------------------------------------------------------------------------

/// Approach corridor constraint axis
enum class ApproachAxis {
    V_BAR,   // Along velocity vector (in-track, I-axis) — safest, ISS standard
    R_BAR,   // Along radial (nadir, R-axis) — gravity gradient station-keeping
    H_BAR    // Along angular momentum (cross-track, C-axis) — plane change approach
};

/// Configuration for constrained approach maneuver
struct ApproachConfig {
    ApproachAxis axis           = ApproachAxis::V_BAR;
    Vector3      targetPosition = {};         // RIC target [m]
    double       approachSpeed  = 0.1;        // m/s approach velocity at target
    double       safetyCorridorWidth = 10.0;  // m, lateral tolerance
    bool         includeJ2      = true;
    int          maxIterations   = 50;
    double       positionTolerance = 1.0;     // m
};

/// Result of an approach maneuver computation
struct ApproachResult {
    ManeuverLeg  leg;
    ApproachAxis axis;
    double       corridorDeviation = 0.0;  // max lateral deviation [m]
    bool         withinCorridor    = false;
};

/// Compute a constrained-axis approach maneuver.
/// The deputy approaches the target along the specified axis while
/// minimizing lateral deviation from the approach corridor.
ApproachResult computeApproach(
    const RelativeState& initialState,
    const ClassicalOrbitalElements& chief,
    const ApproachConfig& config);

// ---------------------------------------------------------------------------
// Natural Motion Circumnavigation (NMC) / Football Orbit
// ---------------------------------------------------------------------------

/// Parameters defining a bounded relative orbit (football orbit / NMC)
struct NMCConfig {
    double alongTrackAmplitude = 0.0;  // [m] in-track oscillation amplitude
    double crossTrackAmplitude = 0.0;  // [m] cross-track oscillation amplitude
    double radialAmplitude     = 0.0;  // [m] radial oscillation amplitude
    double phaseAngle          = 0.0;  // [rad] initial phase of in-plane motion
};

/// Compute the ROE state that produces a desired NMC / football orbit.
/// The resulting bounded relative motion is passively safe (no drift).
QuasiNonsingularROE computeNMCROE(
    const ClassicalOrbitalElements& chief,
    const NMCConfig& config);

/// Compute the delta-v required to enter an NMC from the current state.
ManeuverLeg computeNMCEntry(
    const RelativeState& initialState,
    const ClassicalOrbitalElements& chief,
    const NMCConfig& config,
    const TargetingOptions& options = {});

/// Generate NMC trajectory points for visualization.
std::vector<TrajectoryPoint> generateNMCTrajectory(
    const ClassicalOrbitalElements& chief,
    const NMCConfig& config,
    int numOrbits = 1,
    int pointsPerOrbit = 360);

// ---------------------------------------------------------------------------
// Collision Avoidance Maneuver (CAM)
// ---------------------------------------------------------------------------

/// CAM configuration
struct CAMConfig {
    double minMissDistance  = 1000.0;  // [m] required miss distance
    double timeToTCA       = 0.0;     // [s] time until closest approach
    double maxDeltaV       = 10.0;    // [m/s] max available delta-v
    bool   preferRadial    = false;   // prefer radial burns (preserve orbit period)
};

/// CAM result
struct CAMResult {
    Vector3 deltaV         = {};        // optimal burn [m/s] in RIC
    double  magnitude      = 0.0;       // |dv| [m/s]
    double  achievedMiss   = 0.0;       // achieved miss distance [m]
    bool    feasible       = false;     // can achieve required miss with available dv
    double  optimalBurnTime = 0.0;      // optimal time before TCA to burn [s]
};

/// Compute minimum delta-v collision avoidance maneuver.
/// Finds the optimal burn direction and timing to achieve the required
/// miss distance at TCA with minimum fuel expenditure.
CAMResult computeCAM(
    const RelativeState& initialState,
    const ClassicalOrbitalElements& chief,
    const CAMConfig& config);

// ---------------------------------------------------------------------------
// Phasing Orbit
// ---------------------------------------------------------------------------

/// Phasing maneuver result
struct PhasingResult {
    double dv1          = 0.0;    // first burn [m/s] (enter phasing orbit)
    double dv2          = 0.0;    // second burn [m/s] (return to original orbit)
    double totalDeltaV  = 0.0;    // [m/s]
    double phasingPeriod = 0.0;   // period of phasing orbit [s]
    double phasingSMA   = 0.0;    // SMA of phasing orbit [m]
    int    numRevs      = 1;      // number of revolutions in phasing orbit
    double totalTime    = 0.0;    // total phasing time [s]
    double phaseAngle   = 0.0;    // phase angle corrected [rad]
    Vector3 dv1_ric     = {};
    Vector3 dv2_ric     = {};
    /// True when the requested phase shift would have driven the phasing
    /// orbit's far apse below the Earth-collision floor and the semi-major
    /// axis was raised to the floor instead. The maneuver that comes back is
    /// then NOT the one that was asked for.
    bool   clampedToEarthFloor = false;
    double farApse              = 0.0;  // 2a - r, the apse opposite the burn [m]
    double earthFloorRadius     = 0.0;  // the floor applied [m]
    double requestedPhasingSMA  = 0.0;  // unclamped SMA [m]
    double requestedPhasingPeriod = 0.0;  // unclamped period [s]
    double achievedPhaseAngle   = 0.0;  // phase shift actually delivered [rad]
};

/// Compute a phasing maneuver to adjust along-track position.
/// @param currentRadius  current circular orbit radius [m]
/// @param phaseAngle     desired phase angle change [rad] (positive = ahead)
/// @param numRevs        number of phasing revolutions (more revs = less dv)
/// @param mu             gravitational parameter [m^3/s^2]
PhasingResult computePhasingManeuver(
    double currentRadius,
    double phaseAngle,
    int numRevs = 1,
    double mu = MU_EARTH);

// ---------------------------------------------------------------------------
// Plane Change
// ---------------------------------------------------------------------------

/// Plane change result
struct PlaneChangeResult {
    double dv           = 0.0;    // delta-v magnitude [m/s]
    double optimalTrueAnomaly = 0.0;  // optimal burn location [rad]
    Vector3 dv_ric      = {};     // delta-v in RIC [m/s]
};

/// Compute pure inclination change delta-v at optimal location.
/// @param orbitalRadius  orbit radius at burn point [m]
/// @param velocity       orbital velocity at burn point [m/s]
/// @param deltaInclination  desired inclination change [rad]
PlaneChangeResult computePlaneChange(
    double orbitalRadius,
    double velocity,
    double deltaInclination);

/// Compute combined plane change + altitude change (optimal single burn).
/// @param r1   initial radius [m]
/// @param r2   final radius [m]
/// @param di   inclination change [rad]
/// @param mu   gravitational parameter [m^3/s^2]
HohmannResult computeCombinedManeuver(
    double r1, double r2, double di, double mu = MU_EARTH);

// ---------------------------------------------------------------------------
// Lambert Solver (full, not CW approximation)
// ---------------------------------------------------------------------------

/// Lambert solution.
///
/// NOTE ON THE RENAMED FIELDS. 0.1.0 called `norm3(v1)` and `norm3(v2)`
/// "dv1"/"dv2" and their sum "totalDV". They are TRANSFER SPEEDS, not delta-v
/// — the code comment said as much — so `totalDV` was not a cost and
/// `solveLambertMinDV` was minimising a quantity with no meaning. They are now
/// named for what they are. Real delta-v appears only when the caller states
/// the velocities of the orbits being left and joined, and is flagged as
/// present rather than silently zero.
struct LambertResult {
    Vector3 v1      = {};     // departure velocity on the transfer arc [m/s]
    Vector3 v2      = {};     // arrival velocity on the transfer arc [m/s]
    double  v1Magnitude = 0.0;  // |v1| [m/s]
    double  v2Magnitude = 0.0;  // |v2| [m/s]
    double  tof     = 0.0;    // time of flight [s]
    /// TRUE ONLY WHEN THE RESIDUAL WAS MEASURED AND MET. Never a literal.
    bool    converged = false;
    int     revolutions = 0;  // number of complete revolutions
    /// Why the solve ended: "converged", "no-solution", "residual-not-met",
    /// "degenerate-geometry", "empty-domain", "non-finite-solution",
    /// "invalid-input", "endpoint-velocities-required".
    const char* status = "no-solution";
    double  residual = 0.0;        // |F(z)| at the returned z
    double  residualBudget = 0.0;  // the gate `residual` had to meet
    double  z = 0.0;               // the universal variable at the solution
    int     iterations = 0;

    /// Delta-v against STATED endpoint orbits. Present only when the caller
    /// supplied departure and arrival velocities.
    bool    hasDeltaV = false;
    double  dv1 = 0.0;
    double  dv2 = 0.0;
    double  totalDeltaV = 0.0;
    Vector3 dv1_vec = {};
    Vector3 dv2_vec = {};
};

/// Solve Lambert's problem: find the orbit connecting two position vectors
/// in a given time of flight.
/// Uses Izzo's method (fast, robust for multi-revolution).
/// @param r1   initial position vector [m] (ECI)
/// @param r2   final position vector [m] (ECI)
/// @param tof  time of flight [s]
/// @param mu   gravitational parameter [m^3/s^2]
/// @param prograde  true for prograde transfer, false for retrograde
/// @param nRevs  number of complete revolutions (0 = direct)
LambertResult solveLambert(
    const Vector3& r1,
    const Vector3& r2,
    double tof,
    double mu = MU_EARTH,
    bool prograde = true,
    int nRevs = 0);

/// Solve Lambert for multiple revolution counts and return the minimum-delta-v
/// solution, ranked on REAL delta-v against the stated endpoint orbits.
/// @param haveEndpoints  false => there is nothing to minimise; the call is
///                       refused with status "endpoint-velocities-required"
///                       rather than ranking on a meaningless quantity.
/// @param vDepart  inertial velocity of the departure orbit at r1 [m/s]
/// @param vArrive  inertial velocity of the arrival orbit at r2 [m/s]
LambertResult solveLambertMinDV(
    const Vector3& r1,
    const Vector3& r2,
    double tof,
    double mu = MU_EARTH,
    bool prograde = true,
    int maxRevs = 5,
    bool haveEndpoints = false,
    const Vector3& vDepart = {},
    const Vector3& vArrive = {});

}  // namespace maneuver

#endif  // MANEUVER_APPROACH_H
