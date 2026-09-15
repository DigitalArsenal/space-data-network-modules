#pragma once
#include "integrators.h"
#include "force_partials.h"

namespace astro { namespace Integrator {
enum class STMMethod { Analytic, FiniteDifference };
struct VariationalResult {
    StateVector finalState;
    Mat6 stm = Mat6::identity();
    uint32_t steps = 0, rejections = 0;
    bool success = true;
    std::string errorMessage;
};
// GCRF Cartesian [km,km/s], duration seconds, epoch JD TDB. Phi is row-major,
// maps perturbations at the initial epoch to the final epoch.
VariationalResult PropagateVariational(const StateVector&, double dt,
    const IntegratorConfig&, ForceModel::ForceModelSet&,
    ForceModel::DensityGradient = ForceModel::DensityGradient::Neglected);
// Scheduled impulses split the integration exactly at their epochs. The result
// at an impulse epoch is post-burn. Start-epoch impulses are excluded.
VariationalResult PropagateWithSTM(const StateVector&, double dt,
    const IntegratorConfig&, ForceModel::ForceModelSet&,
    STMMethod = STMMethod::Analytic,
    ForceModel::DensityGradient = ForceModel::DensityGradient::Neglected,
    const std::vector<ForceModel::ImpulsiveManeuverDef>& maneuvers = {});
Mat6 TransportCovariance(const Mat6& phi, const Mat6& covariance);
}}
