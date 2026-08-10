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

/// WHICH of a multi-revolution problem's TWO arcs to return.
///
/// A Lambert problem with `nRevs >= 1` has two solutions per revolution count,
/// because `F(z)` on `((2*pi*N)^2, (2*pi*(N+1))^2)` dips to a minimum and rises
/// again — a given time of flight is met twice. 0.2.0 scanned that interval and
/// stopped at the FIRST sign change, so the second arc was unreachable and the
/// JSON surface had no way to name it (graph:
/// modules-maneuver-lambert-multi-rev-exposes-one-branch-of-two). The two arcs
/// are genuinely different maneuvers: on Der's Molniya case the departure
/// speeds differ by 1.03 km/s.
///
/// LOW is the first crossing (smaller `z`) and is the default, so every 0.2.0
/// caller gets the identical arc it got before. It corresponds to hapsira's
/// `lowpath=True`; HIGH is its `lowpath=False`.
///
/// At `nRevs == 0` the branch is meaningless — `F` is monotone there and the
/// root is unique — and the JSON surface reports no branch for such an answer
/// rather than inventing a distinction the mathematics does not have.
enum class LambertBranch { LOW, HIGH };

/// The kind of conic the transfer arc turned out to be. Reported ALWAYS, so
/// that a consumer reading a response with no `apogeeRadius` can tell "this arc
/// has no apoapsis" from "this field was dropped".
enum class ConicType { ELLIPTIC, PARABOLIC, HYPERBOLIC };

/// One entry of `solveLambertMinDV`'s candidate set: a (revolution count,
/// branch) pair that converged, and what it costs.
///
/// The set is published so that "the operation ranked over the whole domain"
/// is CHECKABLE from the response instead of taken on trust. 0.2.0 ranked over
/// half of it and said nothing about that.
struct LambertCandidate {
    int           revolutions = 0;
    LambertBranch branch      = LambertBranch::LOW;
    double        dv1         = 0.0;
    double        dv2         = 0.0;
    double        totalDeltaV = 0.0;
};

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

    /// Which multi-revolution arc this is. Only meaningful when
    /// `revolutions >= 1`; at zero revolutions the root is unique.
    LambertBranch branch = LambertBranch::LOW;

    // -----------------------------------------------------------------------
    // THE TRANSFER ARC'S OWN CONIC — how low, and how high, this arc goes.
    //
    // A Lambert solver answers "what velocity flies from r1 to r2 in tof", and
    // 0.2.0 answered exactly that and nothing else. But an arc that satisfies
    // the boundary conditions may still pass THROUGH the planet: six of the
    // published conformance geometries in this repo's own vector set do,
    // including Vallado example 7-5 (perigee 3,186 km from the centre) and
    // Der's Molniya case (909 km), and both are correct answers that hapsira
    // and Orekit assert in their own suites.
    //
    // So the module may not REFUSE them — a solver that did would fail its
    // conformance suite against three libraries at once, and Lambert is also an
    // orbit-determination tool where an arc between two observations owes
    // nothing to any floor. The screening decision belongs to the consumer.
    //
    // What the module owes the consumer is the EVIDENCE to screen with, and
    // that evidence was missing: an operator met a through-Earth transfer live
    // on 2026-08-10, and the only place left to compute a perigee was
    // JavaScript, which the no-JS-physics law forbids. Every quantity below is
    // three lines of conic algebra over (r1, v1, mu), all of which this
    // function already holds (graph:
    // modules-maneuver-lambert-publishes-no-transfer-perigee).
    // -----------------------------------------------------------------------
    /// True once the conic block below has been filled. Set on every converged
    /// solve; a non-converged result carries no arc to describe.
    bool      hasTransferConic = false;
    ConicType transferConicType = ConicType::ELLIPTIC;
    /// Perigee radius of the transfer arc, from the centre of the body [m].
    /// Always finite: `p / (1 + e)` is well conditioned for every conic.
    double    perigeeRadius = 0.0;
    double    transferEccentricity = 0.0;
    /// `-mu / (2 * energy)` [m]: positive on an ellipse, NEGATIVE on a
    /// hyperbola, and unrepresentable on a parabola — hence the flag. A
    /// non-finite number is not JSON, and emitting one would turn a converged
    /// solve into an error, which is not an additive change.
    bool      hasTransferSemiMajorAxis = false;
    double    transferSemiMajorAxis = 0.0;
    /// Apoapsis radius [m]. Exists only on a bounded (elliptic) arc; a
    /// hyperbolic or parabolic transfer has none, and `transferConicType` is
    /// what tells a consumer which case it is looking at.
    bool      hasApogeeRadius = false;
    double    apogeeRadius = 0.0;

    /// `solveLambertMinDV` only: every (revolution count, branch) pair that
    /// converged, in canonical order — revolutions ascending, LOW before HIGH.
    /// Canonical rather than ranked, so a diff of two runs is a diff of costs
    /// and not of an ordering.
    std::vector<LambertCandidate> ranked;
};

/// Solve Lambert's problem: find the orbit connecting two position vectors
/// in a given time of flight, by the Bate-Mueller-White / Curtis universal
/// variable with a bracketed, safeguarded root find.
/// @param r1   initial position vector [m] (ECI)
/// @param r2   final position vector [m] (ECI)
/// @param tof  time of flight [s]
/// @param mu   gravitational parameter [m^3/s^2]
/// @param prograde  true for prograde transfer, false for retrograde
/// @param nRevs  number of complete revolutions (0 = direct)
/// @param branch which of the two multi-revolution arcs to return; ignored at
///               nRevs == 0, where the root is unique. LOW is 0.2.0's
///               behaviour and stays the default.
LambertResult solveLambert(
    const Vector3& r1,
    const Vector3& r2,
    double tof,
    double mu = MU_EARTH,
    bool prograde = true,
    int nRevs = 0,
    LambertBranch branch = LambertBranch::LOW);

/// Solve Lambert for multiple revolution counts and return the minimum-delta-v
/// solution, ranked on REAL delta-v against the stated endpoint orbits.
///
/// Ranks over BOTH branches of every revolution count from 1 up, which is the
/// point of the operation: 0.2.0 saw one arc per revolution count and so
/// minimised over half its own domain while presenting the answer as global.
/// @param haveEndpoints  false => there is nothing to minimise; the call is
///                       refused with status "endpoint-velocities-required"
///                       rather than ranking on a meaningless quantity.
/// @param vDepart  inertial velocity of the departure orbit at r1 [m/s]
/// @param vArrive  inertial velocity of the arrival orbit at r2 [m/s]
/// @param restrictBranch  when non-null, rank only that branch — an explicit
///                        caller choice, not the default.
LambertResult solveLambertMinDV(
    const Vector3& r1,
    const Vector3& r2,
    double tof,
    double mu = MU_EARTH,
    bool prograde = true,
    int maxRevs = 5,
    bool haveEndpoints = false,
    const Vector3& vDepart = {},
    const Vector3& vArrive = {},
    const LambertBranch* restrictBranch = nullptr);

}  // namespace maneuver

#endif  // MANEUVER_APPROACH_H
