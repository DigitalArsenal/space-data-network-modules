#ifndef MANEUVER_MATH_H
#define MANEUVER_MATH_H

#include "types.h"
#include "constants.h"

namespace maneuver {

// ---------------------------------------------------------------------------
// kepler.ts
// ---------------------------------------------------------------------------

/// Solve Kepler's equation to obtain true anomaly from mean anomaly.
double trueAnomalyFromMean(double meanAnomaly, double eccentricity,
                           double tolerance = 1e-10);

/// Compute mean motion from semi-major axis and gravitational parameter.
double meanMotion(double semiMajorAxis, double gravitationalParameter);

/// Compute orbital radius at a given true anomaly.
double orbitalRadius(double semiMajorAxis, double eccentricity,
                     double trueAnomaly);

/// Compute radial velocity component.
double radialVelocity(double semiMajorAxis, double eccentricity,
                      double trueAnomaly, double gravitationalParameter);

/// Compute angular velocity (transverse component).
double angularVelocity(double semiMajorAxis, double eccentricity,
                       double trueAnomaly, double gravitationalParameter);

// ---------------------------------------------------------------------------
// orbital-factors.ts
// ---------------------------------------------------------------------------

/// Compute the kappa parameter for J2-perturbed secular rates.
double computeKappa(double a, double e, double mu,
                    double j2 = J2, double re = R_EARTH);

/// Compute intermediate orbital factors for ROE propagation.
OrbitalFactors computeOrbitalFactors(double e, double i);

/// Compute apsidal rotation state for J2-perturbed propagation.
ApsidalState computeApsidalState(double e, double omega, double kappa,
                                 double Q, double tau);

// ---------------------------------------------------------------------------
// matrices.ts
// ---------------------------------------------------------------------------

/// Multiply a 6x6 STM by a 6-element ROE vector.
ROEVector matVecMul6(const STM6& A, const ROEVector& v);

/// Multiply a 7x7 STM by a 7-element augmented ROE vector.
ROEVector7 matVecMul7(const STM7& A, const ROEVector7& v);

/// Multiply a 9x9 STM by a 9-element augmented ROE vector.
ROEVector9 matVecMul9(const STM9& A, const ROEVector9& v);

// ---------------------------------------------------------------------------
// vectors.ts
// ---------------------------------------------------------------------------

/// Euclidean norm of a 3D vector.
double norm3(const Vector3& v);

/// Element-wise subtraction of two 3D vectors.
Vector3 sub3(const Vector3& a, const Vector3& b);

/// Element-wise addition of two 3D vectors.
Vector3 add3(const Vector3& a, const Vector3& b);

/// Dot product of two 3D vectors.
double dot3(const Vector3& a, const Vector3& b);

/// Cross product of two 3D vectors.
Vector3 cross3(const Vector3& a, const Vector3& b);

/// Multiply a 6x3 control matrix by a 3D vector.
ROEVector matMul6x3_3x1(const ControlMatrix6x3& B, const Vector3& v);

/// Multiply a 3x3 matrix by a 3D vector.
Vector3 matMul3x3_3x1(const Matrix3x3& A, const Vector3& v);

/// Compute the inverse of a 3x3 matrix.
Matrix3x3 invert3x3(const Matrix3x3& A);

/// Element-wise addition of two ROE vectors.
ROEVector addROE(const ROEVector& a, const ROEVector& b);

/// Zero-initialized 3D vector constant.
extern const Vector3 ZERO_VECTOR3;

/// Zero-initialized ROE vector constant.
extern const ROEVector ZERO_ROE;

/// Normalize an angle to [0, 2pi).
///
/// The doc comment here read "[-pi, pi)" from the port onwards and the code
/// never did that — it has always folded onto [0, 2pi). The comment is
/// corrected rather than the code: every caller in this module (the ROE and
/// STM propagators) wants the non-negative fold, and half of them would move
/// if the implementation were changed to match the sentence.
double normalizeAngle(double angle);

/// Normalize an angle to (-pi, pi] — the SIGNED fold, in which "exactly
/// opposite" has one spelling (+pi) rather than two.
double wrapToPi(double angle);

}  // namespace maneuver

#endif  // MANEUVER_MATH_H
