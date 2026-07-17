#ifndef MANEUVER_RENDEZVOUS_H
#define MANEUVER_RENDEZVOUS_H

#include "maneuver/types.h"

#include <vector>

namespace maneuver {

// ---------------------------------------------------------------------------
// Closed-loop rendezvous simulation in the target LVLH frame.
//
// LVLH/RIC convention (matches the rest of this module and hp::rpo):
//   x = radial (out along target radius), y = along-track, z = cross-track.
// A chaser "behind" the target on V-bar has y < 0.
//
// Guidance profile (Fehse, "Automated Rendezvous and Docking of Spacecraft"):
//   1. Combined-case drift leg — free-drift HCW motion whose initial velocity
//      is solved (CW two-point boundary value problem) so the chaser arrives
//      at the V-bar brake point after driftDuration.
//   2. Fifth-order (quintic) braking segment — per-axis quintic polynomial
//      matching position/velocity/acceleration at the brake handoff and
//      reaching the hold point with zero velocity and zero acceleration.
//   3. Station-keeping hold at the hold point.
//
// Control: feedback-linearized PD. The commanded LVLH acceleration is
//   u = a_ref (feedforward)
//     - [Coriolis terms]         (2 n vy, -2 n vx, 0)
//     - [gravity-gradient terms] (3 n^2 x, 0, -n^2 z)
//     + Kp (x_ref - x) + Kd (v_ref - v)
// so the compensated closed loop is a per-axis double integrator.
//
// Truth model: target and chaser are propagated in the inertial frame with
// nonlinear two-body gravity (optional J2), RK4 fixed step; the control
// acceleration is mapped LVLH -> inertial and held over each step. The
// controller reads both inertial states and converts to LVLH each step, so
// HCW model error appears as a real disturbance the PD loop must absorb.
// ---------------------------------------------------------------------------

/// Guidance phase along the approach profile
enum class RendezvousPhase { DRIFT = 0, BRAKE = 1, HOLD = 2 };

/// Reference state (desired trajectory) at one instant, LVLH frame
struct ReferenceState {
    Vector3 position     = {};
    Vector3 velocity     = {};
    Vector3 acceleration = {};
    RendezvousPhase phase = RendezvousPhase::DRIFT;
};

/// Per-axis quintic polynomial coefficients p(t) = sum c[k] t^k
struct QuinticSegment {
    std::array<std::array<double, 6>, 3> coeffs = {};
    double duration = 0.0;
};

/// Configuration for simulateRendezvous. All tunable levers live here.
struct RendezvousConfig {
    // --- Boundary conditions (LVLH, meters / m/s) ---
    Vector3 initialPosition = {100.0, -338.8, 0.0};
    Vector3 initialVelocity = {};      ///< used only when solveInitialVelocity=false
    bool solveInitialVelocity = true;  ///< CW BVP: pick v0 to hit brakePoint at driftDuration
    Vector3 brakePoint = {0.0, -80.0, 0.0};
    Vector3 holdPoint  = {0.0, -30.0, 0.0};

    // --- Segment durations (seconds) ---
    double driftDuration = 0.0;   ///< required > 0
    double brakeDuration = 0.0;   ///< required > 0
    double holdDuration  = 0.0;   ///< optional station-keeping tail

    // --- Controller levers ---
    /// Closed-loop natural frequency [rad/s]. When <= 0, defaults to 10 n.
    double controlBandwidth = 0.0;
    /// Closed-loop damping ratio (1 = critically damped).
    double dampingRatio = 1.0;
    /// Explicit gains override the bandwidth/damping derivation when > 0:
    /// kp = controlBandwidth^2, kd = 2 * dampingRatio * controlBandwidth.
    double kp = 0.0;
    double kd = 0.0;
    bool useFeedforward = true;             ///< apply reference acceleration
    bool compensateCoriolis = true;         ///< cancel 2 n x v coupling
    bool compensateGravityGradient = true;  ///< cancel 3n^2 x / -n^2 z terms
    /// Per-command acceleration saturation [m/s^2]; <= 0 disables the limit.
    double maxAccel = 0.0;

    // --- Truth / integration levers ---
    double timeStep = 1.0;        ///< RK4 step and control update period [s]
    int outputEvery = 10;         ///< sample decimation for the trajectory log
    bool includeJ2 = false;       ///< add J2 to the inertial truth gravity
};

/// One logged sample of the closed-loop simulation, LVLH frame
struct RendezvousSample {
    double time = 0.0;
    RendezvousPhase phase = RendezvousPhase::DRIFT;
    Vector3 position = {};
    Vector3 velocity = {};
    Vector3 referencePosition = {};
    Vector3 referenceVelocity = {};
    Vector3 referenceAcceleration = {};
    Vector3 controlAccel = {};
    double positionError = 0.0;
    double velocityError = 0.0;
};

/// Aggregate tracking / effort metrics
struct RendezvousMetrics {
    double totalDeltaV = 0.0;          ///< integral of |u| dt [m/s]
    double maxControlAccel = 0.0;      ///< max |u| [m/s^2]
    int saturatedSteps = 0;            ///< steps clipped by maxAccel
    double maxPositionError = 0.0;     ///< over the whole profile [m]
    double rmsPositionError = 0.0;     ///< over the whole profile [m]
    double maxPositionErrorDrift = 0.0;
    double maxPositionErrorBrake = 0.0;
    double maxPositionErrorHold = 0.0;
    double finalPositionError = 0.0;   ///< |x - holdPoint| at end [m]
    double finalVelocityError = 0.0;   ///< |v| at end [m/s]
};

/// Full simulation result
struct RendezvousResult {
    bool valid = false;
    std::string message = {};
    double meanMotion = 0.0;             ///< n [rad/s] of the target orbit
    Vector3 solvedInitialVelocity = {};  ///< LVLH v0 actually used
    Vector3 gainKp = {};
    Vector3 gainKd = {};
    double driftEnd = 0.0;
    double brakeEnd = 0.0;
    double totalTime = 0.0;
    RendezvousMetrics metrics = {};
    std::vector<RendezvousSample> trajectory = {};
};

// --- Guidance building blocks (exposed for tests and reuse) ---

/// Closed-form Clohessy-Wiltshire STM for mean motion n over time t
STM6 computeCWSTM(double n, double t);

/// Propagate an LVLH state [x y z vx vy vz] through the CW STM
RelativeState propagateCW(const RelativeState& state, double n, double t);

/// HCW natural relative acceleration at an LVLH state:
/// (3n^2 x + 2n vy, -2n vx, -n^2 z)
Vector3 hcwAcceleration(const RelativeState& state, double n);

/// Solve the CW two-point BVP: initial velocity that drifts from r0 to rf
/// in time t. Returns false when the transfer matrix is near-singular
/// (t near an integer number of orbital periods).
bool solveCWInitialVelocity(
    const Vector3& r0,
    const Vector3& rf,
    double n,
    double t,
    Vector3& v0);

/// Quintic segment matching (p0, v0, a0) at tau=0 and (pf, 0, 0) at
/// tau=duration on each axis.
QuinticSegment buildQuinticBrake(
    const RelativeState& handoff,
    const Vector3& handoffAccel,
    const Vector3& holdPoint,
    double duration);

/// Evaluate a quintic segment at local time tau (clamped to [0, duration])
ReferenceState evaluateQuintic(const QuinticSegment& segment, double tau);

/// Reference (desired) state at mission time t for the configured profile.
/// initialState must carry the resolved initial velocity.
ReferenceState rendezvousReference(
    const RendezvousConfig& config,
    const RelativeState& initialState,
    const QuinticSegment& brake,
    double n,
    double t);

/// Feedback-linearized PD command for one control step, LVLH frame
Vector3 rendezvousControl(
    const RendezvousConfig& config,
    const ReferenceState& reference,
    const RelativeState& actual,
    const Vector3& gainKp,
    const Vector3& gainKd,
    double n);

/// Run the full closed-loop simulation against a nonlinear inertial truth
RendezvousResult simulateRendezvous(
    const RendezvousConfig& config,
    const ClassicalOrbitalElements& chief);

}  // namespace maneuver

#endif  // MANEUVER_RENDEZVOUS_H
