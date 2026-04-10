#ifndef MANEUVER_PROPAGATION_H
#define MANEUVER_PROPAGATION_H

#include "types.h"

#include <vector>

namespace maneuver {

// ---------------------------------------------------------------------------
// propagate.ts — ROE propagation (J2-perturbed, optionally with drag)
// ---------------------------------------------------------------------------

/// Propagate quasi-nonsingular ROE forward by deltaTime [seconds].
/// The chief elements are held fixed (mean elements) while J2 secular
/// effects evolve the relative elements.
QuasiNonsingularROE propagateROE(
    const QuasiNonsingularROE& initialROE,
    const ClassicalOrbitalElements& chief,
    double deltaTime,
    const ROEPropagationOptions& options = {});

/// Result of propagation that also returns the updated chief elements.
struct PropagateWithChiefResult {
    QuasiNonsingularROE      roe;
    ClassicalOrbitalElements chief;
};

/// Propagate both the ROE and the chief's mean elements forward by
/// deltaTime [seconds].
PropagateWithChiefResult propagateROEWithChief(
    const QuasiNonsingularROE& initialROE,
    const ClassicalOrbitalElements& chief,
    double deltaTime,
    const ROEPropagationOptions& options = {});

/// A single time-stamped point along a propagated ROE trajectory.
struct ROETrajectoryPoint {
    double                   time;   // seconds from epoch
    QuasiNonsingularROE      roe;
    ClassicalOrbitalElements chief;
};

/// Generate a discrete ROE trajectory over totalTime [seconds] with
/// numSteps evenly-spaced samples.
std::vector<ROETrajectoryPoint> generateROETrajectory(
    const QuasiNonsingularROE& initialROE,
    const ClassicalOrbitalElements& chief,
    double totalTime,
    int numSteps,
    const ROEPropagationOptions& options = {});

// ---------------------------------------------------------------------------
// drag-dispatch.ts — ROE propagation with differential drag
// ---------------------------------------------------------------------------

/// Propagate an ROE vector forward by tau [seconds] including
/// differential drag effects described by dragConfig.
ROEVector propagateWithDrag(
    const ROEVector& roe,
    const ClassicalOrbitalElements& chief,
    double tau,
    const DragConfig& dragConfig);

}  // namespace maneuver

#endif  // MANEUVER_PROPAGATION_H
