#pragma once
// One resident-run interface keeps orbit policy separate from dense output.
#include "ffm_sundman_run.h"

namespace ffm_fast {
// Classify the initial osculating Cartesian state, never a catalog name.
// Nonelliptic states and explicit fixed-step diagnostics retain standard RK78.
inline unsigned sundmanGrid(const astro::StateVector& initial, double mu) {
    const auto r = initial.position, v = initial.velocity;
    const double radius = r.magnitude();
    if (!(radius > 0 && mu > 0)) return 0;
    const double a = 1 / (2 / radius - v.dot(v) / mu);
    const double e = (v.cross(r.cross(v)) * (1 / mu) - r * (1 / radius)).magnitude();
    if (!(a > 0 && e >= 0.25 && e < 1)) return 0;
    const double perigee = a * (1 - e) - astro::RE_EARTH;
    const double apogee = a * (1 + e) - astro::RE_EARTH;
    return perigee < 1000 && apogee > 30000 && apogee < 45000 ? 300 : 200;
}
class Run {
    std::unique_ptr<astro::Integrator::ForceRun> rk_;
    std::unique_ptr<SundmanRun> sundman_;
public:
    Run(const astro::StateVector& initial, const astro::StateVector& reference,
        const timesys::Instant& epoch, int direction, const astro::IntegratorConfig& config,
        astro::ForceModel::ForceModelSet& forces) {
        const bool fixed = config.initialStep == config.minStep && config.minStep == config.maxStep;
        const auto grid = !fixed && direction > 0 ? sundmanGrid(reference, forces.mu) : 0;
        if (grid) sundman_ = std::make_unique<SundmanRun>(initial, epoch, config, forces, grid, reference);
        else rk_ = std::make_unique<astro::Integrator::ForceRun>(initial, direction, config, forces, true);
    }
    double time() const { return sundman_ ? sundman_->time() : rk_->run().time(); }
    const std::array<double, 6>& state() const { return sundman_ ? sundman_->state() : rk_->run().state(); }
    const std::array<double, 6>& derivative() { return sundman_ ? sundman_->derivative() : rk_->run().derivative(); }
    bool running(double target) const { return sundman_ ? sundman_->running(target) : rk_->run().running(target); }
    bool attempt(double target) { return sundman_ ? sundman_->attempt(target) : rk_->run().attempt(target); }
    bool endedOnBoundary() const { return sundman_ ? sundman_->endedOnBoundary() : rk_->run().endedOnBoundary(); }
};
} // namespace ffm_fast
