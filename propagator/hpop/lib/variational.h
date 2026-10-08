#pragma once
#include "integrators.h"
#include "force_partials.h"

namespace astro { namespace Integrator {
enum class STMMethod { Analytic, FiniteDifference };
using ForceModel::DynamicParameter;
struct VariationalResult {
    StateVector finalState;
    Mat6 stm = Mat6::identity();
    /// d(final state)/d(parameter) for the requested dynamic parameters:
    /// 6 x parameters row-major, km and km/s per SI unit of each parameter.
    std::vector<double> sensitivity;
    uint32_t steps = 0, rejections = 0;
    bool success = true;
    std::string errorMessage;
};
// GCRF Cartesian [km,km/s], duration seconds, epoch JD TDB. Phi is row-major,
// maps perturbations at the initial epoch to the final epoch.
// With `parameters`, the sensitivity S = dx/dp is integrated with the state
// and STM (dS/dt = A S + df/dp, S(0) = 0) on the same steps; S does not take
// part in step-size control.
VariationalResult PropagateVariational(const StateVector&, double dt,
    const IntegratorConfig&, ForceModel::ForceModelSet&,
    ForceModel::DensityGradient = ForceModel::DensityGradient::Neglected,
    const std::vector<DynamicParameter>& parameters = {});
// Scheduled impulses split the integration exactly at their epochs. The result
// at an impulse epoch is post-burn. Start-epoch impulses are excluded.
VariationalResult PropagateWithSTM(const StateVector&, double dt,
    const IntegratorConfig&, ForceModel::ForceModelSet&,
    STMMethod = STMMethod::Analytic,
    ForceModel::DensityGradient = ForceModel::DensityGradient::Neglected,
    const std::vector<ForceModel::ImpulsiveManeuverDef>& maneuvers = {},
    const std::vector<DynamicParameter>& parameters = {});
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
// The state augmented with dynamic parameters, n = 6 + parameters: the STM
// [[Phi, S], [0, I]] (n x n row-major, km, km/s and SI parameter units) and,
// when p0 (n x n) is given, P(t) = Phi P0 Phi^T, plus Q on the state block per
// noise interval as PropagateCovariance.
struct ParameterCovarianceResult : VariationalResult {
    unsigned dimension = 6;
    std::vector<double> phi, covariance;
};
ParameterCovarianceResult PropagateParameterCovariance(const StateVector&, double dt,
    const IntegratorConfig&, ForceModel::ForceModelSet&, STMMethod,
    ForceModel::DensityGradient, const std::vector<ForceModel::ImpulsiveManeuverDef>&,
    const std::vector<DynamicParameter>& parameters, const std::vector<double>& p0,
    const ProcessNoise&);
}}
