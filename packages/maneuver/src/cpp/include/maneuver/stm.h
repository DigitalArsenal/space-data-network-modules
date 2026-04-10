#ifndef MANEUVER_STM_H
#define MANEUVER_STM_H

#include "types.h"

namespace maneuver {

// ---------------------------------------------------------------------------
// keplerian.ts
// ---------------------------------------------------------------------------

/// Compute the Keplerian (unperturbed) state transition matrix.
STM6 computeKeplerianSTM(const ClassicalOrbitalElements& chief, double tau);

// ---------------------------------------------------------------------------
// j2.ts
// ---------------------------------------------------------------------------

/// Build the J2 secular perturbation matrix.
STM6 buildJ2Matrix(const ClassicalOrbitalElements& chief, double tau);

/// Compute the combined Keplerian + J2 state transition matrix.
STM6 computeJ2STM(const ClassicalOrbitalElements& chief, double tau);

// ---------------------------------------------------------------------------
// drag-eccentric.ts
// ---------------------------------------------------------------------------

/// Result of the J2 + eccentric-drag STM computation.
struct J2DragEccentricResult {
    STM7      stm;
    ROEVector dragColumn;
};

/// Compute the J2 + eccentric-drag augmented STM.
J2DragEccentricResult computeJ2DragSTMEccentric(
    const ClassicalOrbitalElements& chief, double tau);

/// Propagate ROE using the J2 + eccentric-drag model.
ROEVector propagateJ2DragEccentric(const J2DragEccentricResult& result,
                                   const ROEVector& roe, double daDotDrag);

// ---------------------------------------------------------------------------
// drag-arbitrary.ts
// ---------------------------------------------------------------------------

/// Result of the J2 + arbitrary-drag STM computation.
struct J2DragArbitraryResult {
    STM9           stm;
    DragColumns6x3 dragColumns;
};

/// Compute the J2 + arbitrary-drag augmented STM.
J2DragArbitraryResult computeJ2DragSTMArbitrary(
    const ClassicalOrbitalElements& chief, double tau);

/// Propagate ROE using the J2 + arbitrary-drag model.
ROEVector propagateJ2DragArbitrary(const J2DragArbitraryResult& result,
                                   const ROEVector& roe, double daDotDrag,
                                   double dexDotDrag, double deyDotDrag);

/// Convert eccentric drag rate to a full arbitrary drag configuration.
DragConfig eccentricToArbitraryConfig(double daDotDrag,
                                      const ClassicalOrbitalElements& chief);

// ---------------------------------------------------------------------------
// drag-estimation.ts
// ---------------------------------------------------------------------------

/// Estimate differential drag derivatives with J2 correction from two ROE
/// snapshots separated by dt seconds.
DragConfig estimateDragDerivativesWithJ2Correction(
    const ROEVector& roe1, const ROEVector& roe2,
    const ClassicalOrbitalElements& chief, double dt);

/// Estimate the da-dot drag rate from two semi-major axis differences.
double estimateDaDot(double da1, double da2, double dt);

}  // namespace maneuver

#endif  // MANEUVER_STM_H
