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
// White acceleration process noise (state noise compensation): spectral
// density q per axis (km^2/s^3), inertial or RTN axes, entering every
// `interval` seconds.
struct ProcessNoise {
    bool enabled = false;
    bool rtn = false;
    double q[3] = {0, 0, 0};
    double interval = 0;
};
struct CovarianceResult : VariationalResult {
    Mat6 covariance{};
};
// One interval h of white acceleration noise at state s: per axis k,
// q_k [[h^3/3, h^2/2], [h^2/2, h]] on that axis's position and velocity.
Mat6 WhiteAccelerationNoise(const ProcessNoise&, double h, const StateVector& s);
// P(t) = Phi P0 Phi^T, plus Q when noise is enabled: the arc in equal steps no
// longer than noise.interval, each step's STM carrying P, noise added at its
// end. stm is the product of the steps' STMs.
CovarianceResult PropagateCovariance(const StateVector&, double dt,
    const IntegratorConfig&, ForceModel::ForceModelSet&, STMMethod,
    ForceModel::DensityGradient, const std::vector<ForceModel::ImpulsiveManeuverDef>&,
    const Mat6& p0, const ProcessNoise&);
}}
