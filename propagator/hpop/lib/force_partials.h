#pragma once

#include "force_models.h"

namespace astro {
namespace ForceModel {

/// Only the atmosphere density is differenced; velocity and co-rotation use
/// analytical derivatives. Density finite differences use a 1 m displacement.
enum class DensityGradient { Neglected, FiniteDifference };

struct AccelerationPartials {
    Vec3 acceleration;       ///< km/s^2; exactly the existing force evaluator
    double dr[3][3]{};       ///< partial acceleration / position, s^-2
    double dv[3][3]{};       ///< partial acceleration / velocity, s^-1
};

/// Returns nullptr when the configured force derivatives are supported at this
/// position, otherwise a static error message. Integrators use this status path
/// so expected unsupported-input failures do not require exception unwinding.
const char* ValidateAccelerationPartials(const Vec3& position, const ForceModelSet& forceSet);

/// Cartesian force Jacobian at fixed epoch (jd TDB), same frame and units as
/// ComputeTotalAcceleration. First-order forward chain rule, no perturbed
/// force-model evaluations except optional scalar atmospheric density calls.
/// Throws for force models whose derivatives are not implemented. Piecewise
/// force derivatives are one-sided on the selected branch at shadow/table
/// boundaries; a discontinuous force does not have a classical derivative there.
AccelerationPartials ComputeAccelerationPartials(
    const Vec3& position, const Vec3& velocity, double jd,
    ForceModelSet& forceSet,
    DensityGradient densityGradient = DensityGradient::Neglected);

/// Fixed-epoch jump Jacobian d(r+,v+)/d(r-,v-). Inertial delta-v has an identity
/// Jacobian; RTN delta-v includes derivatives of all three moving basis axes.
Mat6 ImpulsiveManeuverJacobian(const Vec3& position, const Vec3& velocity,
                               const ImpulsiveManeuverDef& maneuver);

} // namespace ForceModel
} // namespace astro
