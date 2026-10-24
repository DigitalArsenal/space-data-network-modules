#include "integrator_events.h"

#include "astrodynamics.h"
#include "reentry.h"
#include "rk_augmented.h"
#include "rk_engine.h"
#include "shadow_events.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <memory>

namespace astro {
namespace Integrator {
namespace {

using Vec6 = std::array<double, 6>;
using sdn::events::Direction;

// A one-step integrator as the loop sees it.
class Stepper {
public:
    virtual ~Stepper() = default;
    /// The order handed to ComputeOptimalStep (the step shrinks as err^-1/(order+1)).
    virtual int controlOrder() const = 0;
    virtual bool fixedStep() const { return false; }
    /// One step of length h from (t, y); f0 = f(t, y). error is per component.
    virtual void step(double t, double h, const double* y, const double* f0, double* yOut,
                      double* error) = 0;
    /// f(t + h, y1) of the step just taken, valid until the next step().
    virtual const double* endDerivative() = 0;
    /// Make dense() valid for the step just taken (the stages only the extension needs).
    virtual void prepareDense() {}
    virtual void dense(double theta, double* out) = 0;
    /// The solution after a step of length tau from the start of the step just taken.
    virtual void restep(double tau, double* out) = 0;
};

class PairStepper : public Stepper {
public:
    PairStepper(const rk::Pair& pair, const DerivativeFunc& f, void* context)
        : pair_(pair), f_(f), context_(context) {}
    int controlOrder() const override { return pair_.lowerOrder; }
    void step(double t, double h, const double* y, const double* f0, double* yOut,
              double* error) override {
        t_ = t; h_ = h;
        std::copy(y, y + 6, y0_.begin());
        std::copy(f0, f0 + 6, stages_.k[0]);
        denseReady_ = false;
        rk::solve(pair_, f_, context_, t, h, y, stages_, yOut, error);
    }
    const double* endDerivative() override { return stages_.k[pair_.core - 1]; }
    void prepareDense() override {
        if (denseReady_) return;
        if (pair_.degree > 0 && pair_.total > pair_.core)
            rk::completeDense(pair_, f_, context_, t_, h_, y0_.data(), stages_);
        denseReady_ = true;
    }
    void dense(double theta, double* out) override {
        rk::dense(pair_, y0_.data(), h_, stages_, theta, out);
    }
    void restep(double tau, double* out) override {
        rk::Stages local;
        std::copy(stages_.k[0], stages_.k[0] + 6, local.k[0]);
        double error[6];
        rk::solve(pair_, f_, context_, t_, tau, y0_.data(), local, out, error);
    }

private:
    const rk::Pair& pair_;
    const DerivativeFunc& f_;
    void* context_;
    rk::Stages stages_{};
    double t_ = 0, h_ = 0;
    Vec6 y0_{};
    bool denseReady_ = false;
};

// A step kernel with no stages kept: the continuous extension is the quintic Hermite polynomial.
class HermiteStepper : public Stepper {
public:
    using Kernel = std::function<void(double t, double h, const double* y, const double* f0,
                                      double* yOut, double* error)>;
    HermiteStepper(Kernel kernel, int order, bool fixed, const DerivativeFunc& f, void* context)
        : kernel_(std::move(kernel)), order_(order), fixed_(fixed), f_(f), context_(context) {}
    int controlOrder() const override { return order_; }
    bool fixedStep() const override { return fixed_; }
    void step(double t, double h, const double* y, const double* f0, double* yOut,
              double* error) override {
        t_ = t; h_ = h;
        std::copy(y, y + 6, y0_.begin());
        std::copy(f0, f0 + 6, f0_.begin());
        kernel_(t, h, y, f0, yOut, error);
        std::copy(yOut, yOut + 6, y1_.begin());
        haveEnd_ = false;
    }
    const double* endDerivative() override {
        if (!haveEnd_) { f_(t_ + h_, y1_.data(), f1_.data(), context_); haveEnd_ = true; }
        return f1_.data();
    }
    void dense(double theta, double* out) override {
        rk::hermite(y0_.data(), f0_.data(), y1_.data(), endDerivative(), h_, theta, out);
    }
    void restep(double tau, double* out) override {
        double error[6];
        kernel_(t_, tau, y0_.data(), f0_.data(), out, error);
    }

private:
    Kernel kernel_;
    int order_;
    bool fixed_;
    const DerivativeFunc& f_;
    void* context_;
    double t_ = 0, h_ = 0;
    Vec6 y0_{}, f0_{}, y1_{}, f1_{};
    bool haveEnd_ = false;
};

class NystromStepper : public HermiteStepper {
public:
    NystromStepper(const DerivativeFunc& f, void* context)
        : HermiteStepper(
              [&f, context](double t, double h, const double* y, const double*, double* yOut,
                            double* error) {
                  rk::NystromStages stages;
                  rk::nystromSolve(f, context, t, h, y, stages, yOut, error);
              },
              10, false, f, context) {}
};

std::unique_ptr<Stepper> makeStepper(IntegrationMethod method, const DerivativeFunc& f,
                                     void* context) {
    if (const rk::Pair* pair = rk::pairFor(method)) return std::make_unique<PairStepper>(*pair, f, context);
    switch (method) {
        case IntegrationMethod::RK4:
            return std::make_unique<HermiteStepper>(
                [&f, context](double t, double h, const double* y, const double*, double* yOut,
                              double* error) {
                    rk_detail::rk4Step<6>(t, h, y, yOut, error, f, context);
                },
                4, true, f, context);
        case IntegrationMethod::RKF45:
        case IntegrationMethod::Cowell:
            return std::make_unique<HermiteStepper>(
                [&f, context](double t, double h, const double* y, const double*, double* yOut,
                              double* error) {
                    rk_detail::cashKarpStep<6>(t, h, y, yOut, error, f, context);
                },
                4, false, f, context);
        case IntegrationMethod::RKF78:
        case IntegrationMethod::RK78:
            return std::make_unique<HermiteStepper>(
                [&f, context](double t, double h, const double* y, const double* f0, double* yOut,
                              double* error) {
                    rk_detail::rkf78StepFrom<6>(t, h, y, f0, yOut, error, f, context);
                },
                8, false, f, context);
        case IntegrationMethod::BS:
            return std::make_unique<HermiteStepper>(
                [&f, context](double t, double h, const double* y, const double*, double* yOut,
                              double* error) {
                    bulirschStoerStep(t, h, y, yOut, error, f, context, 12);
                },
                12, false, f, context);
        case IntegrationMethod::RKN1210:
            return std::make_unique<NystromStepper>(f, context);
        default:
            return nullptr;
    }
}

// The events of one run: g at the end of the last accepted step, and the crossings of the next.
class EventTracker {
public:
    EventTracker(const std::vector<EventSpec>& specs, EventOutcome& outcome)
        : specs_(specs), outcome_(outcome), previous_(specs.size(), 0.0), valid_(specs.size(), 0) {
        if (outcome_.occurrences.size() != specs.size()) outcome_.occurrences.assign(specs.size(), 0);
    }
    void begin(double t, const double* y) {
        for (size_t s = 0; s < specs_.size(); ++s)
            valid_[s] = specs_[s].g(t, y, &previous_[s]) ? 1 : 0;
    }
    /// After an accepted step [t0, t0 + h] ending at y1. True when a Stop event ended the run;
    /// stopTime and stopState are then the event.
    bool afterStep(Stepper& stepper, double t0, double h, const double* y1, double* stopTime,
                   double* stopState) {
        struct Found { double t; Vec6 y; uint32_t spec; Direction direction; double residual; uint32_t iterations; };
        std::vector<Found> found;
        const double t1 = t0 + h;
        std::vector<double> next(specs_.size(), 0.0);
        std::vector<char> nextValid(specs_.size(), 0);
        for (size_t s = 0; s < specs_.size(); ++s) {
            const EventSpec& spec = specs_[s];
            nextValid[s] = spec.g(t1, y1, &next[s]) ? 1 : 0;
            if (!valid_[s] || !nextValid[s]) continue;
            Direction raw;
            if (!sdn::events::crossing(previous_[s], next[s], spec.jumpLimit, &raw)) continue;
            // The direction of g in forward time: a backward step reverses the raw sense.
            Direction direction = raw;
            if (h < 0)
                direction = raw == Direction::INCREASING ? Direction::DECREASING : Direction::INCREASING;
            if (spec.direction != Direction::ANY && spec.direction != direction) continue;
            Found hit{};
            hit.spec = static_cast<uint32_t>(s);
            hit.direction = direction;
            if (!locate(stepper, spec, t0, h, previous_[s], next[s], &hit.t, hit.y.data(),
                        &hit.residual, &hit.iterations))
                continue;
            found.push_back(hit);
        }
        previous_ = next;
        valid_ = nextValid;
        const double sign = h < 0 ? -1.0 : 1.0;
        std::stable_sort(found.begin(), found.end(),
                         [sign](const Found& a, const Found& b) { return sign * a.t < sign * b.t; });
        for (const Found& hit : found) {
            const EventSpec& spec = specs_[hit.spec];
            const uint32_t count = ++outcome_.occurrences[hit.spec];
            if (spec.action == EventAction::Continue) continue;
            EventHit record;
            record.spec = hit.spec;
            record.t = hit.t + outcome_.offset;
            std::copy(hit.y.begin(), hit.y.end(), record.state);
            record.direction = hit.direction;
            record.residual = hit.residual;
            record.iterations = hit.iterations;
            if (spec.action == EventAction::Record) { outcome_.hits.push_back(record); continue; }
            if (count == spec.occurrence) {
                outcome_.hits.push_back(record);
                outcome_.stoppedBy = static_cast<int>(hit.spec);
                *stopTime = hit.t;
                std::copy(hit.y.begin(), hit.y.end(), stopState);
                return true;
            }
        }
        return false;
    }

private:
    // The root of g in the step: Brent on the continuous extension, then Newton on the
    // integrator's own re-stepped states.
    static bool locate(Stepper& stepper, const EventSpec& spec, double t0, double h, double gStart,
                       double gEnd, double* time, double* state, double* residual,
                       uint32_t* iterations) {
        stepper.prepareDense();
        const auto onDense = [&](double theta, double* g) {
            Vec6 y;
            stepper.dense(theta, y.data());
            return spec.g(t0 + theta * h, y.data(), g);
        };
        const double tolerance = spec.toleranceSeconds > 0 ? spec.toleranceSeconds : 1e-9;
        double theta = 0, ignored = 0;
        int32_t brentIterations = 0;
        if (!sdn::events::brentRoot(onDense, 0.0, 1.0, gStart, gEnd, tolerance / std::fabs(h), 200,
                                    &theta, &ignored, &brentIterations))
            return false;
        // Slope of g per second at the dense root, for the Newton corrections.
        const double delta = 1e-4;
        double gLow = 0, gHigh = 0;
        const double lo = std::max(0.0, theta - delta), hi = std::min(1.0, theta + delta);
        if (!onDense(lo, &gLow) || !onDense(hi, &gHigh) || hi <= lo) return false;
        const double slope = (gHigh - gLow) / ((hi - lo) * h);
        double tau = theta * h;
        Vec6 y;
        double g = 0;
        uint32_t polished = 0;
        for (int k = 0; k < 8; ++k) {
            stepper.restep(tau, y.data());
            if (!spec.g(t0 + tau, y.data(), &g)) return false;
            ++polished;
            if (g == 0.0 || !(std::fabs(slope) > 0.0) || !std::isfinite(slope)) break;
            double next = tau - g / slope;
            // stay inside the step
            if (h > 0) next = std::min(std::max(next, 0.0), h);
            else next = std::max(std::min(next, 0.0), h);
            if (std::fabs(next - tau) <= tolerance) {
                if (next != tau) {
                    tau = next;
                    stepper.restep(tau, y.data());
                    if (!spec.g(t0 + tau, y.data(), &g)) return false;
                }
                break;
            }
            tau = next;
        }
        *time = t0 + tau;
        std::copy(y.begin(), y.end(), state);
        *residual = g;
        *iterations = static_cast<uint32_t>(brentIterations) + polished;
        return true;
    }

    const std::vector<EventSpec>& specs_;
    EventOutcome& outcome_;
    std::vector<double> previous_;
    std::vector<char> valid_;
};

}  // namespace

bool engineSupports(IntegrationMethod method) {
    switch (method) {
        case IntegrationMethod::RK4:
        case IntegrationMethod::RKF45:
        case IntegrationMethod::Cowell:
        case IntegrationMethod::RKF78:
        case IntegrationMethod::RK78:
        case IntegrationMethod::RKDP87:
        case IntegrationMethod::DOPRI5:
        case IntegrationMethod::RK65:
        case IntegrationMethod::RKV98:
        case IntegrationMethod::RKN1210:
        case IntegrationMethod::BS:
            return true;
        default:
            return false;
    }
}

PropagateResult PropagateEngine(const StateVector& initial, double dt, const IntegratorConfig& config,
                                const DerivativeFunc& f, void* context,
                                shadow::BoundaryEvents* boundaries,
                                const std::vector<EventSpec>* events, EventOutcome* outcome) {
    PropagateResult result;
    result.finalState = initial;
    std::unique_ptr<Stepper> stepper = makeStepper(config.method, f, context);
    if (!stepper) {
        result.success = false;
        result.errorMessage = "The integrator has no one-step map.";
        return result;
    }
    const bool fixed = stepper->fixedStep();
    const double sign = dt < 0 ? -1.0 : 1.0;
    Vec6 y = {initial.position.x, initial.position.y, initial.position.z,
              initial.velocity.x, initial.velocity.y, initial.velocity.z};
    Vec6 f0{}, yNext{}, error{};
    f(0.0, y.data(), f0.data(), context);
    std::unique_ptr<EventTracker> tracker;
    if (events && outcome && !events->empty()) {
        tracker = std::make_unique<EventTracker>(*events, *outcome);
        tracker->begin(0.0, y.data());
    }
    double t = 0, h = sign * std::fabs(config.initialStep);
    uint32_t attempts = 0;
    const uint32_t maxAttempts = config.maxSteps * 10;
    bool stopped = false;
    double stopTime = 0;
    Vec6 stopState{};
    while (std::fabs(t) < std::fabs(dt) && result.steps < config.maxSteps && attempts < maxAttempts) {
        if (propagationStop().active) break;  // reentry.h: no step past a stop
        ++attempts;
        double hTry = h;
        const bool lastStep = sign * (t + hTry) >= sign * dt;
        if (lastStep) hTry = dt - t;
        stepper->step(t, hTry, y.data(), f0.data(), yNext.data(), error.data());
        if (propagationStop().active) break;  // a stage reached the stop: no step
        double errNorm = 0;
        if (!fixed) {
            std::array<double, 6> e, yy;
            for (int i = 0; i < 6; ++i) { e[i] = std::fabs(error[i]); yy[i] = yNext[i]; }
            errNorm = ComputeErrorNorm(e, yy, config.absTolerance, config.relTolerance);
        }
        // A step across a shadow boundary is shortened to end on it.
        if (!fixed && errNorm <= 1.0 && boundaries) {
            if (const double shorter = boundaries->cut(t, hTry, yNext.data())) { h = shorter; continue; }
        }
        bool accept = fixed || errNorm <= 1.0;
        double nextStep = std::fabs(h);
        if (accept) {
            if (fixed) {
                nextStep = std::fabs(config.initialStep);
            } else {
                nextStep = ComputeOptimalStep(std::fabs(hTry), errNorm, stepper->controlOrder());
                nextStep = std::min(config.maxStep, std::max(config.minStep, nextStep));
            }
        } else {
            ++result.rejections;
            nextStep = ComputeOptimalStep(std::fabs(hTry), errNorm, stepper->controlOrder(), 0.9, 0.1, 1.0);
            nextStep = std::max(config.minStep, nextStep);
            // At the minimum step and still rejecting: take the step to make progress.
            if (nextStep <= config.minStep * 1.01 && result.rejections > 10) accept = true;
        }
        if (!accept) { h = sign * nextStep; continue; }
        if (tracker) {
            if (tracker->afterStep(*stepper, t, hTry, yNext.data(), &stopTime, stopState.data())) {
                stopped = true;
                break;
            }
        }
        y = yNext;
        t = lastStep ? dt : t + hTry;
        const double* endDerivative = stepper->endDerivative();
        std::copy(endDerivative, endDerivative + 6, f0.begin());
        if (boundaries) boundaries->taken(t, y.data());
        ++result.steps;
        result.maxError = std::max(result.maxError, errNorm);
        h = sign * nextStep;
        if (boundaries) h = boundaries->next(h);
    }
    if (stopped) { y = stopState; t = stopTime; ++result.steps; }
    result.finalState.position = Vec3(y[0], y[1], y[2]);
    result.finalState.velocity = Vec3(y[3], y[4], y[5]);
    result.finalState.epoch = initial.epoch + t / 86400.0;
    result.totalTime = t;
    result.success = result.steps < config.maxSteps;
    return result;
}

}  // namespace Integrator
}  // namespace astro
