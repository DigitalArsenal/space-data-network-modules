#pragma once
// RKF78 in the seven-state Sundman system, dt/ds = c*r^1.5.
// Adapted from the integration study; the physical force API uses two-part TT.
// All units inside this adapter are km, km/s, seconds and two-part TT.
// The internal orbit policy owns N; it is not a PRW mode or user flag.
#include "force_models.h"
#include "integrators.h"
#include "reentry.h"
#include "rk_augmented.h"
#include "shadow_events.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <stdexcept>

namespace ffm_fast {
class SundmanRun {
    using Forces = astro::ForceModel::ForceModelSet;
    using State = std::array<double, 6>;
    Forces& forces_;
    timesys::Instant epoch_;
    astro::IntegratorConfig config_;
    State y_{}, k_{}, previousY_{};
    std::array<double, 3> previousA_{};
    double t_ = 0, previousT_ = 0, c_ = 0, ds_ = 0, landing_ = 0;
    bool haveK_ = false, havePrevious_ = false, boundary_ = false;
    uint32_t steps_ = 0, attempts_ = 0;
    uint64_t evaluations_ = 0;
    std::unique_ptr<astro::shadow::BoundaryEvents> events_;
    static constexpr double pi = 3.141592653589793238462643383279502884;

    double rate(const double* y) const {
        const double r2 = y[0] * y[0] + y[1] * y[1] + y[2] * y[2];
        return c_ * std::pow(r2, 0.75); // alpha=1.5
    }
    static void physicalDerivative(double t, const double* y, double* f, void* opaque) {
        auto& self = *static_cast<SundmanRun*>(opaque);
        const auto at = self.epoch_.plusSeconds(t);
        if (astro::stopAt(y, at)) { std::fill(f, f + 6, 0); return; }
        const astro::Vec3 r(y[0], y[1], y[2]), v(y[3], y[4], y[5]);
        const auto a = astro::ForceModel::ComputeTotalAcceleration(r, v, at, self.forces_);
        ++self.evaluations_;
        f[0] = v.x; f[1] = v.y; f[2] = v.z;
        f[3] = a.x; f[4] = a.y; f[5] = a.z;
    }
    static void transformedDerivative(double, const double* y, double* f, void* opaque) {
        auto& self = *static_cast<SundmanRun*>(opaque);
        physicalDerivative(y[6], y, f, opaque);
        const double g = self.rate(y);
        for (int i = 0; i < 6; ++i) f[i] *= g;
        f[6] = g;
    }
    void values(double t, const double* y, double out[2]) const {
        const astro::Vec3 r(y[0], y[1], y[2]);
        const auto sun = forces_.sunPositionProvided ? forces_.sunPosition :
            astro::getSunPosition(epoch_.plusSeconds(t)).position;
        const auto d = sun - r;
        const double a = std::asin(std::min(1.0, astro::shadow::SUN_RADIUS_KM / d.magnitude()));
        const double b = std::asin(std::min(1.0, astro::RE_EARTH / r.magnitude()));
        const double angle = std::atan2(r.cross(d).magnitude(), -r.dot(d));
        out[0] = angle - (a + b); out[1] = angle - (b - a);
    }
    // Extrapolate the physical-time quintic through the two accepted nodes.
    void predictState(double dt, double out[6]) const {
        const double h = t_ - previousT_, u = 1 + dt / h;
        for (int j = 0; j < 3; ++j) {
            const double r0 = previousY_[j], v0 = h * previousY_[j + 3];
            const double a0 = h * h * previousA_[j];
            const double dr = y_[j] - r0 - v0 - a0 / 2;
            const double dv = h * y_[j + 3] - v0 - a0;
            const double da = h * h * k_[j + 3] - a0;
            const double c3 = 10 * dr - 4 * dv + da / 2;
            const double c4 = -15 * dr + 7 * dv - da;
            const double c5 = 6 * dr - 3 * dv + da / 2;
            out[j] = r0 + u * (v0 + u * (a0 / 2 + u * (c3 + u * (c4 + u * c5))));
            out[j + 3] = (v0 + u * (a0 + u * (3 * c3 + u * (4 * c4 + 5 * u * c5)))) / h;
        }
    }
    double predictedLanding(double proposed) const {
        if (!events_->active() || !havePrevious_ || !(t_ > previousT_) || proposed <= events_->tolerance) return 0;
        double g0[2], g1[2], endpoint[6];
        values(t_, y_.data(), g0);
        predictState(proposed, endpoint); values(t_ + proposed, endpoint, g1);
        double first = proposed;
        for (int boundary = 0; boundary < 2; ++boundary) {
            if ((g0[boundary] < 0) == (g1[boundary] < 0) || g0[boundary] == 0) continue;
            double lo = 0, hi = proposed, flo = g0[boundary], fhi = g1[boundary];
            int side = 0;
            for (int k = 0; k < 60 && hi - lo > 1e-6; ++k) {
                const double x = (lo * fhi - hi * flo) / (fhi - flo);
                double state[6], g[2]; predictState(x, state); values(t_ + x, state, g);
                if (g[boundary] == 0) { lo = hi = x; break; }
                if ((g[boundary] < 0) == (fhi < 0)) {
                    hi = x; fhi = g[boundary]; if (side == -1) flo /= 2; side = -1;
                } else {
                    lo = x; flo = g[boundary]; if (side == 1) fhi /= 2; side = 1;
                }
            }
            first = std::min(first, (lo + hi) / 2 + events_->tolerance / 2);
        }
        return first < proposed ? first : 0;
    }
    void resetEvents() {
        events_ = std::make_unique<astro::shadow::BoundaryEvents>(forces_, epoch_, t_, y_.data());
    }
public:
    // Forward-only prototype. The enclosing resident runner must use the
    // standard RK implementation for backward requests until qualified.
    SundmanRun(const astro::StateVector& initial, const timesys::Instant& epoch,
               const astro::IntegratorConfig& config, Forces& forces, unsigned stepsPerOrbit,
               const astro::StateVector& reference)
        : forces_(forces), epoch_(epoch), config_(config) {
        if (stepsPerOrbit < 16) { astro::flagIntegrationFailure("invalid internal Sundman grid"); return; }
        y_ = {initial.position.x, initial.position.y, initial.position.z,
              initial.velocity.x, initial.velocity.y, initial.velocity.z};
        const auto r = reference.position, v = reference.velocity;
        const double radius = r.magnitude(), mu = forces_.mu;
        const double a = 1 / (2 / radius - v.dot(v) / mu);
        const double e = (v.cross(r.cross(v)) * (1 / mu) - r * (1 / radius)).magnitude();
        if (!(a > 0 && e >= 0 && e < 1)) { astro::flagIntegrationFailure("Sundman requires a finite elliptic initial orbit"); return; }
        const double meanMotion = std::sqrt(mu / (a * a * a));
        constexpr int count = 4096;
        double sum = 0;
        for (int i = 0; i < count; ++i) {
            const double radiusAtE = a * (1 - e * std::cos(2 * pi * (i + .5) / count));
            sum += std::pow(radiusAtE, -1.5) * radiusAtE / (meanMotion * a);
        }
        c_ = sum / count;
        ds_ = 2 * pi / stepsPerOrbit;
        resetEvents();
    }
    double time() const { return t_; }
    const State& state() const { return y_; }
    const State& derivative() {
        if (!haveK_) { physicalDerivative(t_, y_.data(), k_.data(), this); haveK_ = true; }
        return k_;
    }
    bool endedOnBoundary() const { return boundary_; }
    uint32_t steps() const { return steps_; }
    uint64_t evaluations() const { return evaluations_; }
    bool running(double target) const {
        return target > t_ && steps_ < config_.maxSteps &&
            uint64_t(attempts_) < uint64_t(config_.maxSteps) * 100 + 100 && !astro::propagationStop().active;
    }
    bool attempt(double target) {
        if (!running(target)) return false;
        ++attempts_;
        derivative();
        if (astro::propagationStop().active) return false;
        const double g = rate(y_.data()), estimate = 1.2 * g * ds_;
        double land = landing_;
        if (std::isfinite(target) && target - t_ <= estimate) land = land > 0 ? std::min(land, target - t_) : target - t_;
        if (const double predicted = predictedLanding(estimate)) land = land > 0 ? std::min(land, predicted) : predicted;
        State next{};
        double dt = 0;
        auto timeStep = [&](double h) {
            double error[6];
            astro::rk_detail::rkf78StepFrom<6>(t_, h, y_.data(), k_.data(), next.data(), error, physicalDerivative, this);
            dt = h;
        };
        if (land > 0) timeStep(land);
        else {
            double y[7], k[7], out[7], error[7];
            for (int i = 0; i < 6; ++i) { y[i] = y_[i]; k[i] = g * k_[i]; }
            y[6] = t_; k[6] = g;
            astro::rk_detail::rkf78StepFrom<7>(0, ds_, y, k, out, error, transformedDerivative, this);
            std::copy(out, out + 6, next.begin()); dt = out[6] - t_;
            if (t_ + dt > target) timeStep(target - t_);
        }
        if (astro::propagationStop().active) return false;
        if (!(dt > 0) || !std::isfinite(dt)) { astro::flagIntegrationFailure("non-monotone Sundman physical clock"); return false; }
        if (const double shorter = events_->cut(t_, dt, next.data())) { landing_ = shorter; return false; }
        if (astro::stopAt(next.data(), epoch_.plusSeconds(t_ + dt))) return false;
        previousY_ = y_; previousT_ = t_;
        for (int i = 0; i < 3; ++i) previousA_[i] = k_[i + 3];
        havePrevious_ = true; y_ = next; t_ += dt; haveK_ = false; landing_ = 0;
        boundary_ = events_->active() && events_->crossedBoundary();
        events_->taken(t_, y_.data()); events_->next(dt);
        ++steps_;
        return true;
    }
    // Call after changing the driver span. Preserve the Sundman normalization
    // and grid; reset predictor at the physical discontinuity, not its state.
    void continueSpan(const timesys::Instant& epoch) {
        epoch_ = epoch; t_ = 0; landing_ = 0; haveK_ = false; havePrevious_ = false; boundary_ = false;
        resetEvents();
    }
};
} // namespace ffm_fast
