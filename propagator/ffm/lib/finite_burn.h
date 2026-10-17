#pragma once
#include "variational.h"
#include <array>

namespace astro { namespace Integrator {
constexpr int MaxFiniteBurns = 16;
enum class BurnFrame { Inertial, RTN, VNC, Velocity, AntiVelocity };
enum class BurnEventKind { None, Radius, Speed, RadialVelocity, Node, Mass };
// State-dependent crossing, in km, km/s or kg. Node is inertial z=goal.
// direction: -1 decreasing, 0 either, +1 increasing. Initial roots excluded.
struct BurnEvent {
    BurnEventKind kind = BurnEventKind::None;
    double goal = 0;
    int direction = 0;
    // Positive for a PRW/PCE SI goal tolerance converted to these km/kg units.
    // Zero retains the established diagnostic time-refinement contract.
    double goalTolerance = 0;
};
struct ThrottlePoint { double seconds = 0, throttle = 1; };
struct FiniteBurn {
    // All times below are seconds from the ORIGINAL propagated state epoch.
    // Epochs bound the search window when the corresponding event is present.
    double startSeconds = 0, stopSeconds = 0;
    BurnEvent startEvent, stopEvent;
    double thrustNewtons = 0, accelerationKmS2 = 0, ispSeconds = 300;
    BurnFrame frame = BurnFrame::Inertial;
    Vec3 direction{1,0,0}, steeringRate{0,0,0};
    // Zero-order hold; default 1 before the first point. Range [0,1].
    std::vector<ThrottlePoint> throttle;
    // PRW requires piecewise-linear throttle; legacy diagnostics use hold.
    bool linearThrottle = false;
};
struct FiniteBurnSummary {
    double deltaVKmS = 0, propellantKg = 0;
    double startSeconds = -1, stopSeconds = -1;
    bool started = false, stopped = false;
    bool startByEvent = false, stopByEvent = false;
};
using Matrix7 = std::array<double,49>;
struct FiniteBurnResult {
    StateVector finalState;
    double massKg = 0;
    Matrix7 stm{};
    std::vector<FiniteBurnSummary> burns;
    uint32_t steps = 0, rejections = 0;
    bool success = true;
    std::string errorMessage;
};
// Coupled [r,v,m,Phi(7x7), per-burn integral(|a|), per-burn propellant].
// Uses lane03 RK tableaus and force Jacobians, and events' Brent refiner and
// stopping-function contract. Forward propagation only; event edges include
// analytical saltation matrices. Does not mutate the supplied force set.
FiniteBurnResult PropagateFiniteBurns(const StateVector&, double massKg, double dt,
    const IntegratorConfig&, const ForceModel::ForceModelSet&,
    const std::vector<FiniteBurn>&,
    ForceModel::DensityGradient = ForceModel::DensityGradient::Neglected,
    const std::vector<ForceModel::ImpulsiveManeuverDef>& impulses = {});
Matrix7 TransportFiniteCovariance(const Matrix7&, const Matrix7&);
}}
