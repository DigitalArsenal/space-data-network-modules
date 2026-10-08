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

/// Dynamical model parameters a sensitivity can carry (PRW
/// prwDynamicParameter): Cd*A/m (m^2/kg), its rate (m^2/kg/s), Cr*A/m
/// (m^2/kg) and the constant in-track acceleration (m/s^2).
enum class DynamicParameter : uint8_t {
    DragAreaOverMass = 1, DragAreaOverMassRate = 2, SrpAreaOverMass = 3, InTrackAcceleration = 4
};

/// Returns nullptr when `parameter` is active in the force set, otherwise a
/// static error message.
const char* ValidateParameter(DynamicParameter parameter, const ForceModelSet& forceSet);

/// d(acceleration)/d(parameter) at a state (jd TDB), km/s^2 per SI unit of
/// the parameter. Drag and radiation pressure are linear in their
/// coefficients: the force at a unit Cd*A/m or Cr*A/m (times t - t0 for the
/// rate); the in-track acceleration enters along T of RTN.
Vec3 AccelerationParameterPartial(DynamicParameter parameter, const Vec3& position,
                                  const Vec3& velocity, double jd, const ForceModelSet& forceSet);

/// Adds `delta` (SI) to the parameter in the force set (finite differences).
void PerturbParameter(ForceModelSet& forceSet, DynamicParameter parameter, double delta);

/// The parameter's value in the force set (SI).
double ParameterValue(const ForceModelSet& forceSet, DynamicParameter parameter);

/// Fixed-epoch jump Jacobian d(r+,v+)/d(r-,v-). Inertial delta-v has an identity
/// Jacobian; RTN delta-v includes derivatives of all three moving basis axes.
Mat6 ImpulsiveManeuverJacobian(const Vec3& position, const Vec3& velocity,
                               const ImpulsiveManeuverDef& maneuver);

} // namespace ForceModel
} // namespace astro
