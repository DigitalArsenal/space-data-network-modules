#ifndef MANEUVER_TARGETING_H
#define MANEUVER_TARGETING_H

#include "types.h"

#include <vector>

namespace maneuver {

// ---------------------------------------------------------------------------
// control-matrix.ts — Control influence matrix B (Gauss VE)
// ---------------------------------------------------------------------------

/// Compute the 6x3 control influence matrix B at the given chief state.
/// Maps impulsive delta-v [dvR, dvI, dvC] to instantaneous ROE change.
ControlMatrix6x3 computeControlMatrix(const ClassicalOrbitalElements& chief);

/// Apply an impulsive delta-v to an ROE state: ROE_new = ROE_old + B * dv.
ROEVector applyDeltaV(const ROEVector& roe, const Vector3& deltaV,
                      const ClassicalOrbitalElements& chief);

/// Compute an approximate minimum-norm delta-v for a desired ROE change.
Vector3 computeApproximateDeltaV(const ROEVector& desiredDROE,
                                 const ClassicalOrbitalElements& chief);

// ---------------------------------------------------------------------------
// rendezvous.ts — Two-burn rendezvous solver
// ---------------------------------------------------------------------------

/// Solve the two-burn rendezvous problem using Newton-Raphson iteration.
ManeuverLeg solveRendezvous(const RelativeState& initialState,
                            const Vector3& targetPosition,
                            const ClassicalOrbitalElements& chief,
                            double tof,
                            const TargetingOptions& options = {});

// ---------------------------------------------------------------------------
// planner.ts — Multi-waypoint mission planner
// ---------------------------------------------------------------------------

/// Plan a complete multi-waypoint mission.
MissionPlan planMission(const RelativeState& initialState,
                        const std::vector<Waypoint>& waypoints,
                        const ClassicalOrbitalElements& chief,
                        const TargetingOptions& options = {});

// ---------------------------------------------------------------------------
// tof-optimizer.ts — Golden-section TOF optimization
// ---------------------------------------------------------------------------

/// Optimize time-of-flight to minimise total delta-v.
ManeuverLeg optimizeTOF(const RelativeState& initialState,
                        const Vector3& targetPosition,
                        const ClassicalOrbitalElements& chief,
                        const TargetingOptions& options = {});

// ---------------------------------------------------------------------------
// trajectory.ts — Dense trajectory generation
// ---------------------------------------------------------------------------

/// Generate dense trajectory points for a single maneuver leg.
std::vector<TrajectoryPoint> generateLegTrajectory(
    const ManeuverLeg& leg,
    const ClassicalOrbitalElements& chief,
    const Vector3& initialPosition,
    const Vector3& initialVelocity,
    const TargetingOptions& options = {},
    int numPoints = 100);

/// Generate dense trajectory for an entire mission plan.
std::vector<TrajectoryPoint> generateMissionTrajectory(
    const MissionPlan& plan,
    const ClassicalOrbitalElements& initialChief,
    const Vector3& initialPosition,
    const Vector3& initialVelocity,
    const TargetingOptions& options = {},
    int pointsPerLeg = 100);

// ---------------------------------------------------------------------------
// validation.ts — Configuration validation
// ---------------------------------------------------------------------------

/// Validate targeting configuration before mission planning.
TargetingValidationResult validateTargetingConfig(
    const ClassicalOrbitalElements& chief,
    const TargetingOptions& options = {});

}  // namespace maneuver

#endif  // MANEUVER_TARGETING_H
