#ifndef CISLUNAR_CR3BP_H
#define CISLUNAR_CR3BP_H

#include "types.h"

namespace cislunar {

// ---------------------------------------------------------------------------
// CR3BP Dynamics
// ---------------------------------------------------------------------------

/// Compute CR3BP equations of motion (state derivative).
/// @param state  6-element state [x, y, z, vx, vy, vz] in rotating frame
/// @param mu     mass ratio of the CR3BP system
/// @returns 6-element state derivative [vx, vy, vz, ax, ay, az]
Vector6 cr3bpEOM(const Vector6& state, double mu);

/// Compute CR3BP equations of motion with STM propagation.
/// @param state  42-element state [6 state + 36 STM elements]
/// @param mu     mass ratio
/// @returns 42-element derivative
std::vector<double> cr3bpEOMWithSTM(const std::vector<double>& state, double mu);

/// Compute the Jacobi constant (integral of motion).
/// @param state  6-element CR3BP state in rotating frame
/// @param mu     mass ratio
/// @returns Jacobi constant C_J
double jacobiConstant(const Vector6& state, double mu);

/// Compute the pseudo-potential U (for zero-velocity curves).
double pseudoPotential(double x, double y, double z, double mu);

// ---------------------------------------------------------------------------
// Lagrange Points
// ---------------------------------------------------------------------------

/// Compute all five Lagrange points for a given mass ratio.
/// @param mu  mass ratio
/// @returns array of 5 LagrangePointResult (L1 through L5)
std::array<LagrangePointResult, 5> computeLagrangePoints(double mu);

/// Compute a single collinear Lagrange point (L1, L2, or L3).
/// Uses Newton-Raphson on the quintic equation.
double computeCollinearPoint(double mu, LagrangePoint point);

/// Compute linear stability at a Lagrange point.
StabilityResult computeStability(double mu, LagrangePoint point);

// ---------------------------------------------------------------------------
// CR3BP Propagation
// ---------------------------------------------------------------------------

/// Propagate a CR3BP state using RK4 integration.
/// @param initialState  initial state in rotating frame (non-dimensional)
/// @param mu            mass ratio
/// @param options       propagation options
CR3BPPropResult propagateCR3BP(
    const CR3BPState& initialState,
    double mu,
    const CR3BPPropOptions& options);

/// Propagate to the next x-axis crossing (y = 0, vy determines direction).
/// Used for differential correction of periodic orbits.
/// @returns state at crossing, time of crossing, and STM at crossing
struct XCrossingResult {
    Vector6   state;
    double    time;
    Matrix6x6 stm;
};

XCrossingResult propagateToXCrossing(
    const CR3BPState& initialState,
    double mu,
    double maxTime = 10.0,
    double stepSize = 0.0001);

// ---------------------------------------------------------------------------
// Periodic Orbits
// ---------------------------------------------------------------------------

/// Compute a periodic orbit using single-shooting differential correction.
/// The method targets a perpendicular crossing of the x-z plane.
/// @param config   orbit family, Lagrange point, amplitude
/// @param system   CR3BP system parameters
PeriodicOrbitResult computePeriodicOrbit(
    const PeriodicOrbitConfig& config,
    const CR3BPSystem& system);

/// Generate a Richardson third-order analytic initial guess for halo orbits.
/// Reference: Richardson (1980), "Analytic Construction of Periodic Orbits
/// about the Collinear Points"
CR3BPState richardsonHaloGuess(
    double mu,
    LagrangePoint point,
    double Az,
    bool northern = true);

/// Compute an NRHO (Near-Rectilinear Halo Orbit) for the Gateway mission.
/// @param config  NRHO parameters (perilune/apolune altitudes)
/// @param system  CR3BP system (Earth-Moon)
PeriodicOrbitResult computeNRHO(
    const NRHOConfig& config,
    const CR3BPSystem& system);

/// Continue an orbit family by parameter continuation.
/// Starting from a converged orbit, vary the amplitude and re-converge.
std::vector<PeriodicOrbitResult> continueOrbitFamily(
    const PeriodicOrbitResult& seed,
    double mu,
    double amplitudeStep,
    int numSteps);

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

/// Compute a low-energy transfer from Earth parking orbit to lunar orbit.
/// Uses the CR3BP to find ballistic capture trajectories.
TransferResult computeLowEnergyTransfer(
    const CR3BPSystem& system,
    const TransferConfig& config);

/// Compute a lunar free-return trajectory (Apollo-style).
TransferResult computeFreeReturn(
    const CR3BPSystem& system,
    const TransferConfig& config);

/// Compute a direct transfer to a halo/NRHO orbit.
/// Combines an Earth departure maneuver with an orbit insertion maneuver.
TransferResult computeHaloInsertion(
    const CR3BPSystem& system,
    const PeriodicOrbitResult& targetOrbit,
    const TransferConfig& config);

// ---------------------------------------------------------------------------
// Station-Keeping
// ---------------------------------------------------------------------------

/// Estimate station-keeping delta-v budget for a periodic orbit.
/// Uses a linearized targeting approach based on the monodromy matrix.
StationKeepingResult estimateStationKeeping(
    const PeriodicOrbitResult& orbit,
    double mu,
    const StationKeepingConfig& config = {});

// ---------------------------------------------------------------------------
// Coordinate Transforms
// ---------------------------------------------------------------------------

/// Convert CR3BP rotating frame state to ECI (J2000).
/// @param cr3bpState  state in rotating frame (non-dimensional)
/// @param system      CR3BP system parameters
/// @param epoch_s     epoch in seconds since J2000
/// @returns state in ECI [m, m/s]
Vector6 rotatingToECI(const CR3BPState& cr3bpState,
                      const CR3BPSystem& system,
                      double epoch_s);

/// Convert ECI state to CR3BP rotating frame.
CR3BPState eciToRotating(const Vector6& eciState,
                         const CR3BPSystem& system,
                         double epoch_s);

/// Convert dimensional state [m, m/s] to non-dimensional CR3BP state.
CR3BPState dimensionalToNondim(const Vector6& dimState,
                               const CR3BPSystem& system);

/// Convert non-dimensional CR3BP state to dimensional [m, m/s].
Vector6 nondimToDimensional(const CR3BPState& ndState,
                            const CR3BPSystem& system);

}  // namespace cislunar

#endif  // CISLUNAR_CR3BP_H
