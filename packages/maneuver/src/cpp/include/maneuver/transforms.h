#ifndef MANEUVER_TRANSFORMS_H
#define MANEUVER_TRANSFORMS_H

#include "types.h"

namespace maneuver {

// ---------------------------------------------------------------------------
// roe-ric.ts — Conversions between ROE and RIC (relative) frames
// ---------------------------------------------------------------------------

/// Convert quasi-nonsingular ROE to relative position/velocity in the RIC frame.
RelativeState roeToRIC(const ClassicalOrbitalElements& chief,
                       const QuasiNonsingularROE& roe);

/// Convert relative position/velocity in the RIC frame back to ROE.
QuasiNonsingularROE ricToROE(const ClassicalOrbitalElements& chief,
                             const RelativeState& ric);

/// Build the 6x6 matrix that maps ROE -> RIC state.
STM6 getROEtoRICMatrix(const ClassicalOrbitalElements& chief);

/// Build the 6x6 matrix that maps RIC state -> ROE.
STM6 getRICtoROEMatrix(const ClassicalOrbitalElements& chief);

// ---------------------------------------------------------------------------
// roe-vector.ts — Conversions between named ROE struct and flat vector
// ---------------------------------------------------------------------------

/// Pack a QuasiNonsingularROE into a 6-element vector.
ROEVector roeToVector(const QuasiNonsingularROE& roe);

/// Unpack a 6-element vector into a QuasiNonsingularROE.
QuasiNonsingularROE vectorToROE(const ROEVector& v);

/// Compute the J matrix used in ROE <-> vector rotations, given argument
/// of perigee omega [radians].
STM6 computeJMatrix(double omega);

/// Compute the inverse of the J matrix.
STM6 computeInverseJMatrix(double omega);

}  // namespace maneuver

#endif  // MANEUVER_TRANSFORMS_H
