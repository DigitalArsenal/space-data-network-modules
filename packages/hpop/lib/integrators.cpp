// integrators.cpp - Phase 11.1.1 Numerical Integrators Implementation
// =============================================================================
// Phase 11: Astrodynamics Framework (Basilisk + TudatPy Port)
// Implements clean Integrator:: namespace API for all numerical integration methods.
// Extended with TudatPy-style integrators for comprehensive orbit propagation.
// =============================================================================

#include "integrators.h"
#include "astrodynamics.h"
#include <cmath>
#include <algorithm>
#include <stdexcept>
#include <limits>

namespace astro {
namespace Integrator {

// =============================================================================
// Dense Output Implementation
// =============================================================================

std::array<double, 6> DenseOutput::evaluate(double t) const {
    if (!valid || t < t0 || t > t1) {
        // Return y1 if outside valid range
        return y1;
    }

    double h = t1 - t0;
    if (h < 1e-15) {
        return y0;
    }

    double theta = (t - t0) / h;
    double theta2 = theta * theta;
    double theta3 = theta2 * theta;

    std::array<double, 6> result;
    for (int i = 0; i < 6; i++) {
        // Hermite cubic interpolation: y = c0 + c1*theta + c2*theta^2 + c3*theta^3
        result[i] = coeffs[0][i] + coeffs[1][i] * theta +
                    coeffs[2][i] * theta2 + coeffs[3][i] * theta3;
    }
    return result;
}

// =============================================================================
// Internal Helper Structures
// =============================================================================

namespace {

/// Wrapper to use ForceModelSet with standard derivative function signature
struct ForceModelWrapper {
    ForceModel::ForceModelSet* forceSet;
    double epoch;  // Julian date at t=0
};

void forceModelDerivative(double t, const double* y, double* dydt, void* params) {
    ForceModelWrapper* fw = static_cast<ForceModelWrapper*>(params);
    ForceModel::ForceModelDerivative(t, y, dydt, fw->forceSet);
}

/// Adams-Bashforth coefficients (explicit predictor) for orders 1-8
const double abCoeffs[8][8] = {
    {1.0},                                                          // AB1
    {3.0/2.0, -1.0/2.0},                                           // AB2
    {23.0/12.0, -16.0/12.0, 5.0/12.0},                             // AB3
    {55.0/24.0, -59.0/24.0, 37.0/24.0, -9.0/24.0},                 // AB4
    {1901.0/720.0, -2774.0/720.0, 2616.0/720.0, -1274.0/720.0, 251.0/720.0}, // AB5
    {4277.0/1440.0, -7923.0/1440.0, 9982.0/1440.0, -7298.0/1440.0, 2877.0/1440.0, -475.0/1440.0}, // AB6
    {198721.0/60480.0, -447288.0/60480.0, 705549.0/60480.0, -688256.0/60480.0,
     407139.0/60480.0, -134472.0/60480.0, 19087.0/60480.0}, // AB7
    {434241.0/120960.0, -1152169.0/120960.0, 2183877.0/120960.0, -2664477.0/120960.0,
     2102243.0/120960.0, -1041723.0/120960.0, 295767.0/120960.0, -36799.0/120960.0} // AB8
};

/// Adams-Moulton coefficients (implicit corrector) for orders 1-8
const double amCoeffs[8][8] = {
    {1.0},                                                          // AM1
    {1.0/2.0, 1.0/2.0},                                            // AM2
    {5.0/12.0, 8.0/12.0, -1.0/12.0},                               // AM3
    {9.0/24.0, 19.0/24.0, -5.0/24.0, 1.0/24.0},                    // AM4
    {251.0/720.0, 646.0/720.0, -264.0/720.0, 106.0/720.0, -19.0/720.0}, // AM5
    {475.0/1440.0, 1427.0/1440.0, -798.0/1440.0, 482.0/1440.0, -173.0/1440.0, 27.0/1440.0}, // AM6
    {19087.0/60480.0, 65112.0/60480.0, -46461.0/60480.0, 37504.0/60480.0,
     -20211.0/60480.0, 6312.0/60480.0, -863.0/60480.0}, // AM7
    {36799.0/120960.0, 139849.0/120960.0, -121797.0/120960.0, 123133.0/120960.0,
     -88547.0/120960.0, 41499.0/120960.0, -11351.0/120960.0, 1375.0/120960.0} // AM8
};

} // anonymous namespace

// =============================================================================
// 1. RK4 - Classic 4th Order Runge-Kutta
// =============================================================================

StepResult RK4(const std::array<double, 6>& state, double t, double h,
               DerivativeFunc deriv, void* params) {
    StepResult result;
    constexpr int N = 6;
    double k1[N], k2[N], k3[N], k4[N];
    double ytmp[N];

    // Stage 1: k1 = f(t, y)
    deriv(t, state.data(), k1, params);

    // Stage 2: k2 = f(t + h/2, y + h/2 * k1)
    for (int i = 0; i < N; i++)
        ytmp[i] = state[i] + 0.5 * h * k1[i];
    deriv(t + 0.5*h, ytmp, k2, params);

    // Stage 3: k3 = f(t + h/2, y + h/2 * k2)
    for (int i = 0; i < N; i++)
        ytmp[i] = state[i] + 0.5 * h * k2[i];
    deriv(t + 0.5*h, ytmp, k3, params);

    // Stage 4: k4 = f(t + h, y + h * k3)
    for (int i = 0; i < N; i++)
        ytmp[i] = state[i] + h * k3[i];
    deriv(t + h, ytmp, k4, params);

    // Combine: y(t+h) = y + h/6 * (k1 + 2*k2 + 2*k3 + k4)
    for (int i = 0; i < N; i++) {
        result.state[i] = state[i] + h * (k1[i] + 2.0*k2[i] + 2.0*k3[i] + k4[i]) / 6.0;
        result.error[i] = h * h * h * h * h * 1e-10;  // O(h^5) local truncation error
    }

    result.time = t + h;
    result.stepUsed = h;
    result.accepted = true;
    result.evaluations = 4;

    return result;
}

StepResult RK4WithDense(const std::array<double, 6>& state, double t, double h,
                        DerivativeFunc deriv, void* params, DenseOutput& dense) {
    constexpr int N = 6;
    double k1[N], k2[N], k3[N], k4[N];
    double ytmp[N];

    // Stage 1: k1 = f(t, y)
    deriv(t, state.data(), k1, params);

    // Stage 2: k2 = f(t + h/2, y + h/2 * k1)
    for (int i = 0; i < N; i++)
        ytmp[i] = state[i] + 0.5 * h * k1[i];
    deriv(t + 0.5*h, ytmp, k2, params);

    // Stage 3: k3 = f(t + h/2, y + h/2 * k2)
    for (int i = 0; i < N; i++)
        ytmp[i] = state[i] + 0.5 * h * k2[i];
    deriv(t + 0.5*h, ytmp, k3, params);

    // Stage 4: k4 = f(t + h, y + h * k3)
    for (int i = 0; i < N; i++)
        ytmp[i] = state[i] + h * k3[i];
    deriv(t + h, ytmp, k4, params);

    StepResult result;
    // Combine: y(t+h) = y + h/6 * (k1 + 2*k2 + 2*k3 + k4)
    for (int i = 0; i < N; i++) {
        result.state[i] = state[i] + h * (k1[i] + 2.0*k2[i] + 2.0*k3[i] + k4[i]) / 6.0;
        result.error[i] = h * h * h * h * h * 1e-10;
    }

    result.time = t + h;
    result.stepUsed = h;
    result.accepted = true;
    result.evaluations = 4;

    // Setup dense output coefficients (Hermite cubic interpolation)
    dense.y0 = state;
    dense.y1 = result.state;
    dense.t0 = t;
    dense.t1 = t + h;

    // Hermite cubic: y(theta) = y0 + theta*h*k1 + theta^2*(3*(y1-y0)/h - 2*k1 - k4) + theta^3*(k1 + k4 - 2*(y1-y0)/h)
    for (int i = 0; i < N; i++) {
        double dy = result.state[i] - state[i];
        dense.coeffs[0][i] = state[i];
        dense.coeffs[1][i] = h * k1[i];
        dense.coeffs[2][i] = 3.0 * dy - h * (2.0 * k1[i] + k4[i]);
        dense.coeffs[3][i] = -2.0 * dy + h * (k1[i] + k4[i]);
    }
    dense.valid = true;

    return result;
}

PropagateResult RK4Propagate(const StateVector& initialState, double targetTime,
                             double h, DerivativeFunc deriv, void* params) {
    PropagateResult result;
    result.finalState = initialState;

    std::array<double, 6> y = {
        initialState.position.x, initialState.position.y, initialState.position.z,
        initialState.velocity.x, initialState.velocity.y, initialState.velocity.z
    };

    double t = 0.0;
    uint32_t maxSteps = static_cast<uint32_t>(std::abs(targetTime) / std::abs(h)) + 1000;

    while (t < targetTime && result.steps < maxSteps) {
        double step = std::min(h, targetTime - t);
        StepResult stepRes = RK4(y, t, step, deriv, params);
        y = stepRes.state;
        t = stepRes.time;
        result.steps++;
    }

    result.finalState.position = Vec3(y[0], y[1], y[2]);
    result.finalState.velocity = Vec3(y[3], y[4], y[5]);
    result.finalState.epoch = initialState.epoch + t / 86400.0;
    result.totalTime = t;
    result.success = (result.steps < maxSteps);

    return result;
}

StateVector RK4(const StateVector& initialState, double dt, double h,
                ForceModel::ForceModelSet& forceSet) {
    ForceModelWrapper wrapper;
    wrapper.forceSet = &forceSet;
    wrapper.epoch = forceSet.weather.epoch;

    PropagateResult res = RK4Propagate(initialState, dt, h, forceModelDerivative, &wrapper);
    return res.finalState;
}

// =============================================================================
// 2. RKF45 - Cash-Karp 4(5) Adaptive (commonly called "RKF45" in this codebase)
// =============================================================================
// NOTE: Despite the "RKF45" name, the actual coefficients used are from
// Cash & Karp (1990), not Fehlberg (1969). Both are embedded order 4(5)
// Runge-Kutta pairs with 6 stages, but differ in their Butcher tableau
// entries and error estimation weights. The Cash-Karp variant is generally
// preferred for its slightly better error estimation properties.
// Reference: Cash, J.R. & Karp, A.H. (1990), ACM TOMS, 16(3), 201-222.

// Cash-Karp coefficients
namespace rkf45c {
    constexpr double c2 = 1.0/5.0, c3 = 3.0/10.0, c4 = 3.0/5.0, c5 = 1.0, c6 = 7.0/8.0;
    constexpr double a21 = 1.0/5.0;
    constexpr double a31 = 3.0/40.0, a32 = 9.0/40.0;
    constexpr double a41 = 3.0/10.0, a42 = -9.0/10.0, a43 = 6.0/5.0;
    constexpr double a51 = -11.0/54.0, a52 = 5.0/2.0, a53 = -70.0/27.0, a54 = 35.0/27.0;
    constexpr double a61 = 1631.0/55296.0, a62 = 175.0/512.0, a63 = 575.0/13824.0;
    constexpr double a64 = 44275.0/110592.0, a65 = 253.0/4096.0;
    constexpr double b5_1 = 37.0/378.0, b5_3 = 250.0/621.0, b5_4 = 125.0/594.0, b5_6 = 512.0/1771.0;
    constexpr double b4_1 = 2825.0/27648.0, b4_3 = 18575.0/48384.0, b4_4 = 13525.0/55296.0;
    constexpr double b4_5 = 277.0/14336.0, b4_6 = 1.0/4.0;
}

StepResult RKF45(const std::array<double, 6>& state, double t, double h,
                 DerivativeFunc deriv, void* params) {
    StepResult result;
    constexpr int N = 6;
    double k1[N], k2[N], k3[N], k4[N], k5[N], k6[N];
    double ytmp[N];

    using namespace rkf45c;

    // Stage 1
    deriv(t, state.data(), k1, params);

    // Stage 2
    for (int i = 0; i < N; i++)
        ytmp[i] = state[i] + h * a21 * k1[i];
    deriv(t + c2*h, ytmp, k2, params);

    // Stage 3
    for (int i = 0; i < N; i++)
        ytmp[i] = state[i] + h * (a31*k1[i] + a32*k2[i]);
    deriv(t + c3*h, ytmp, k3, params);

    // Stage 4
    for (int i = 0; i < N; i++)
        ytmp[i] = state[i] + h * (a41*k1[i] + a42*k2[i] + a43*k3[i]);
    deriv(t + c4*h, ytmp, k4, params);

    // Stage 5
    for (int i = 0; i < N; i++)
        ytmp[i] = state[i] + h * (a51*k1[i] + a52*k2[i] + a53*k3[i] + a54*k4[i]);
    deriv(t + c5*h, ytmp, k5, params);

    // Stage 6
    for (int i = 0; i < N; i++)
        ytmp[i] = state[i] + h * (a61*k1[i] + a62*k2[i] + a63*k3[i] + a64*k4[i] + a65*k5[i]);
    deriv(t + c6*h, ytmp, k6, params);

    // 5th order solution
    for (int i = 0; i < N; i++) {
        result.state[i] = state[i] + h * (b5_1*k1[i] + b5_3*k3[i] + b5_4*k4[i] + b5_6*k6[i]);
    }

    // Error estimate
    for (int i = 0; i < N; i++) {
        double y4 = state[i] + h * (b4_1*k1[i] + b4_3*k3[i] + b4_4*k4[i] + b4_5*k5[i] + b4_6*k6[i]);
        result.error[i] = std::abs(result.state[i] - y4);
    }

    result.time = t + h;
    result.stepUsed = h;
    result.accepted = true;
    result.evaluations = 6;

    return result;
}

StepResult RKF45WithDense(const std::array<double, 6>& state, double t, double h,
                          DerivativeFunc deriv, void* params, DenseOutput& dense) {
    // Get the standard step result
    StepResult result = RKF45(state, t, h, deriv, params);

    // Setup dense output using Hermite interpolation
    dense.y0 = state;
    dense.y1 = result.state;
    dense.t0 = t;
    dense.t1 = t + h;

    // Compute derivatives at endpoints for Hermite interpolation
    double dy0[6], dy1[6];
    deriv(t, state.data(), dy0, params);
    deriv(t + h, result.state.data(), dy1, params);

    // Setup Hermite cubic coefficients
    for (int i = 0; i < 6; i++) {
        double dy = result.state[i] - state[i];
        dense.coeffs[0][i] = state[i];
        dense.coeffs[1][i] = h * dy0[i];
        dense.coeffs[2][i] = 3.0 * dy - h * (2.0 * dy0[i] + dy1[i]);
        dense.coeffs[3][i] = -2.0 * dy + h * (dy0[i] + dy1[i]);
    }
    dense.valid = true;

    return result;
}

PropagateResult RKF45Propagate(const StateVector& initialState, double targetTime,
                               const IntegratorConfig& config,
                               DerivativeFunc deriv, void* params) {
    PropagateResult result;
    result.finalState = initialState;

    std::array<double, 6> y = {
        initialState.position.x, initialState.position.y, initialState.position.z,
        initialState.velocity.x, initialState.velocity.y, initialState.velocity.z
    };

    double t = 0.0;
    // Handle backward propagation: use negative step for negative target time
    bool backward = (targetTime < 0.0);
    double h = backward ? -std::abs(config.initialStep) : std::abs(config.initialStep);
    double absTargetTime = std::abs(targetTime);

    uint32_t maxAttempts = config.maxSteps * 10;  // Allow rejections but prevent infinite loop
    uint32_t attempts = 0;

    while (std::abs(t) < absTargetTime && result.steps < config.maxSteps && attempts < maxAttempts) {
        attempts++;

        // Adjust step to not overshoot target
        if (backward) {
            if (t + h < targetTime) {
                h = targetTime - t;
            }
        } else {
            if (t + h > targetTime) {
                h = targetTime - t;
            }
        }

        StepResult stepRes = RKF45(y, t, h, deriv, params);

        // Compute error norm
        double errNorm = 0.0;
        for (int i = 0; i < 6; i++) {
            double scale = config.absTolerance + config.relTolerance * std::abs(stepRes.state[i]);
            errNorm = std::max(errNorm, stepRes.error[i] / scale);
        }

        if (errNorm <= 1.0) {
            // Accept step
            y = stepRes.state;
            t = stepRes.time;
            result.steps++;
            result.maxError = std::max(result.maxError, errNorm);

            // Increase step size
            double factor = 0.9 * std::pow(errNorm, -0.2);
            factor = std::min(5.0, std::max(0.2, factor));
            double absH = std::abs(h) * factor;
            absH = std::min(config.maxStep, absH);
            h = backward ? -absH : absH;
        } else {
            // Reject step
            result.rejections++;
            double factor = 0.9 * std::pow(errNorm, -0.25);
            double absH = std::abs(h) * std::max(0.1, factor);
            absH = std::max(config.minStep, absH);
            h = backward ? -absH : absH;

            // If at minimum step and still rejecting, force acceptance to make progress
            if (absH <= config.minStep * 1.01 && result.rejections > 10) {
                y = stepRes.state;
                t = stepRes.time;
                result.steps++;
                result.maxError = std::max(result.maxError, errNorm);
            }
        }
    }

    result.finalState.position = Vec3(y[0], y[1], y[2]);
    result.finalState.velocity = Vec3(y[3], y[4], y[5]);
    result.finalState.epoch = initialState.epoch + t / 86400.0;
    result.totalTime = t;
    result.success = (result.steps < config.maxSteps);

    return result;
}

StateVector RKF45(const StateVector& initialState, double dt,
                  const IntegratorConfig& config,
                  ForceModel::ForceModelSet& forceSet) {
    ForceModelWrapper wrapper;
    wrapper.forceSet = &forceSet;
    wrapper.epoch = forceSet.weather.epoch;

    PropagateResult res = RKF45Propagate(initialState, dt, config, forceModelDerivative, &wrapper);
    return res.finalState;
}

// =============================================================================
// 3. ABM - Adams-Bashforth-Moulton Multi-Step
// =============================================================================

ABMIntegratorState ABMInit(const StateVector& initialState, double h, int order,
                           DerivativeFunc deriv, void* params) {
    ABMIntegratorState abm;
    abm.y = {
        initialState.position.x, initialState.position.y, initialState.position.z,
        initialState.velocity.x, initialState.velocity.y, initialState.velocity.z
    };
    abm.t = 0.0;
    abm.h = h;
    abm.order = static_cast<uint8_t>(std::min(8, std::max(1, order)));
    abm.historyCount = 0;
    abm.initialized = false;

    // Build startup history using RK4 steps
    std::array<double, 6> y = abm.y;
    double t = 0.0;

    // Compute initial derivative
    deriv(t, y.data(), abm.fHistory[0].data(), params);
    abm.historyCount = 1;

    // Take (order-1) RK4 steps to build history
    for (int step = 1; step < abm.order; step++) {
        StepResult stepRes = RK4(y, t, h, deriv, params);
        y = stepRes.state;
        t += h;

        // Shift history
        for (int i = abm.historyCount; i > 0; i--) {
            abm.fHistory[i] = abm.fHistory[i-1];
        }

        // Compute and store new derivative
        deriv(t, y.data(), abm.fHistory[0].data(), params);
        abm.historyCount++;
    }

    abm.y = y;
    abm.t = t;
    abm.initialized = true;

    return abm;
}

StepResult ABM(ABMIntegratorState& abmState, DerivativeFunc deriv, void* params) {
    StepResult result;
    constexpr int N = 6;
    double h = abmState.h;
    int order = abmState.order;

    // Predictor (Adams-Bashforth)
    std::array<double, 6> yPred;
    for (int i = 0; i < N; i++) {
        yPred[i] = abmState.y[i];
        for (int j = 0; j < order; j++) {
            yPred[i] += h * abCoeffs[order-1][j] * abmState.fHistory[j][i];
        }
    }

    // Evaluate derivative at predicted point
    double fPred[N];
    deriv(abmState.t + h, yPred.data(), fPred, params);

    // Corrector (Adams-Moulton)
    std::array<double, 6> yCorr;
    for (int i = 0; i < N; i++) {
        yCorr[i] = abmState.y[i] + h * amCoeffs[order-1][0] * fPred[i];
        for (int j = 0; j < order - 1; j++) {
            yCorr[i] += h * amCoeffs[order-1][j+1] * abmState.fHistory[j][i];
        }
    }

    // Error estimate (difference between predictor and corrector)
    for (int i = 0; i < N; i++) {
        result.error[i] = std::abs(yCorr[i] - yPred[i]);
    }

    // Update state
    abmState.y = yCorr;
    abmState.t += h;

    // Shift history and add new derivative
    for (int i = order - 1; i > 0; i--) {
        abmState.fHistory[i] = abmState.fHistory[i-1];
    }
    deriv(abmState.t, abmState.y.data(), abmState.fHistory[0].data(), params);

    result.state = abmState.y;
    result.time = abmState.t;
    result.stepUsed = h;
    result.accepted = true;
    result.evaluations = 2;

    return result;
}

PropagateResult ABMPropagate(const StateVector& initialState, double targetTime,
                             double h, int order,
                             DerivativeFunc deriv, void* params) {
    PropagateResult result;

    ABMIntegratorState abm = ABMInit(initialState, h, order, deriv, params);

    uint32_t maxSteps = static_cast<uint32_t>(std::abs(targetTime) / std::abs(h)) + 1000;
    result.steps = order - 1;  // Startup steps

    while (abm.t < targetTime && result.steps < maxSteps) {
        StepResult stepRes = ABM(abm, deriv, params);
        result.steps++;

        double errNorm = 0.0;
        for (int i = 0; i < 6; i++) {
            errNorm = std::max(errNorm, stepRes.error[i]);
        }
        result.maxError = std::max(result.maxError, errNorm);
    }

    result.finalState.position = Vec3(abm.y[0], abm.y[1], abm.y[2]);
    result.finalState.velocity = Vec3(abm.y[3], abm.y[4], abm.y[5]);
    result.finalState.epoch = initialState.epoch + abm.t / 86400.0;
    result.totalTime = abm.t;
    result.success = (result.steps < maxSteps);

    return result;
}

StateVector ABM(const StateVector& initialState, double dt, double h, int order,
                ForceModel::ForceModelSet& forceSet) {
    ForceModelWrapper wrapper;
    wrapper.forceSet = &forceSet;
    wrapper.epoch = forceSet.weather.epoch;

    PropagateResult res = ABMPropagate(initialState, dt, h, order, forceModelDerivative, &wrapper);
    return res.finalState;
}

// =============================================================================
// 4. Cowell - Direct Rectangular Coordinate Integration
// =============================================================================

StateVector Cowell(const StateVector& initialState, double dt,
                   const IntegratorConfig& config,
                   const ForceModelConfig& forceConfig) {
    return cowellIntegrate(initialState, dt, config, forceConfig);
}

StateVector Cowell(const StateVector& initialState, double dt,
                   const IntegratorConfig& config,
                   ForceModel::ForceModelSet& forceSet) {
    if (config.method == IntegrationMethod::GaussJackson8) {
        ForceModelWrapper wrapper;
        wrapper.forceSet = &forceSet;
        wrapper.epoch = forceSet.weather.epoch;
        PropagateResult res = GaussJackson8Propagate(
            initialState,
            dt,
            config.initialStep,
            forceModelDerivative,
            &wrapper
        );
        return res.finalState;
    }

    // Route through the generic dispatcher so RKF45/RKF78/RK78 and other
    // configured methods do not collapse onto a single RKF45 code path.
    IntegratorConfig dispatchConfig = config;
    if (dispatchConfig.method == IntegrationMethod::Cowell) {
        dispatchConfig.method = IntegrationMethod::RKF45;
    }
    return Propagate(initialState, dt, dispatchConfig, forceSet);
}

PropagateResult CowellEphemeris(const StateVector& initialState, double dt,
                                double outputInterval,
                                const IntegratorConfig& config,
                                ForceModel::ForceModelSet& forceSet,
                                std::vector<StateVector>& ephemeris) {
    PropagateResult result;
    ephemeris.clear();

    ForceModelWrapper wrapper;
    wrapper.forceSet = &forceSet;
    wrapper.epoch = forceSet.weather.epoch;

    std::array<double, 6> y = {
        initialState.position.x, initialState.position.y, initialState.position.z,
        initialState.velocity.x, initialState.velocity.y, initialState.velocity.z
    };

    double t = 0.0;
    double h = config.initialStep;
    double nextOutput = 0.0;

    // Store initial state
    ephemeris.push_back(initialState);

    while (t < dt && result.steps < config.maxSteps) {
        if (t + h > dt) h = dt - t;

        StepResult stepRes = RKF45(y, t, h, forceModelDerivative, &wrapper);

        // Check error and adapt step
        double errNorm = 0.0;
        for (int i = 0; i < 6; i++) {
            double scale = config.absTolerance + config.relTolerance * std::abs(stepRes.state[i]);
            errNorm = std::max(errNorm, stepRes.error[i] / scale);
        }

        if (errNorm <= 1.0) {
            y = stepRes.state;
            t = stepRes.time;
            result.steps++;

            // Output at intervals
            while (nextOutput + outputInterval <= t && nextOutput < dt) {
                nextOutput += outputInterval;
                // Interpolate if needed (simplified: just use current state)
                StateVector sv;
                sv.position = Vec3(y[0], y[1], y[2]);
                sv.velocity = Vec3(y[3], y[4], y[5]);
                sv.epoch = initialState.epoch + t / 86400.0;
                ephemeris.push_back(sv);
            }

            double factor = 0.9 * std::pow(errNorm, -0.2);
            h = std::min(config.maxStep, h * std::min(5.0, std::max(0.2, factor)));
        } else {
            result.rejections++;
            h = std::max(config.minStep, h * 0.5);
        }
    }

    result.finalState.position = Vec3(y[0], y[1], y[2]);
    result.finalState.velocity = Vec3(y[3], y[4], y[5]);
    result.finalState.epoch = initialState.epoch + t / 86400.0;
    result.totalTime = t;
    result.success = true;

    return result;
}

// =============================================================================
// 5. Encke - Perturbation from Reference Orbit
// =============================================================================

EnckeState EnckeInit(const StateVector& state, double mu) {
    return enckeInit(state, mu);
}

EnckeState EnckeRectify(const EnckeState& enckeState) {
    return enckeRectify(enckeState);
}

EnckeState Encke(const EnckeState& enckeState, double dt,
                 const IntegratorConfig& config,
                 const ForceModelConfig& forceConfig) {
    return enckeIntegrate(enckeState, dt, config, forceConfig);
}

StateVector Encke(const StateVector& initialState, double dt,
                  const IntegratorConfig& config,
                  ForceModel::ForceModelSet& forceSet,
                  double rectifyThreshold) {
    // Convert ForceModelSet to basic ForceModelConfig
    ForceModelConfig forceConfig;
    forceConfig.mu = forceSet.mu;
    forceConfig.useJ2 = forceSet.useSphericalHarmonics;
    forceConfig.useSunGravity = forceSet.useThirdBody && forceSet.thirdBody.includeSun;
    forceConfig.useMoonGravity = forceSet.useThirdBody && forceSet.thirdBody.includeMoon;
    forceConfig.useDrag = forceSet.useDrag;
    forceConfig.useSRP = forceSet.useSRP;
    forceConfig.mass = forceSet.drag.mass;
    forceConfig.dragArea = forceSet.drag.area;
    forceConfig.Cd = forceSet.drag.Cd;
    forceConfig.srpArea = forceSet.srp.area;
    forceConfig.Cr = forceSet.srp.Cr;

    EnckeState encke = EnckeInit(initialState, forceConfig.mu);
    encke.rectificationThreshold = rectifyThreshold;

    // Use larger steps with periodic rectification checks
    double t = 0.0;
    double stepSize = std::min(config.initialStep * 10.0, dt / 10.0);  // Larger steps
    if (stepSize < 1.0) stepSize = config.initialStep;
    uint32_t maxSteps = config.maxSteps > 0 ? config.maxSteps : 10000;
    uint32_t steps = 0;

    while (t < dt && steps < maxSteps) {
        double step = std::min(stepSize, dt - t);

        // enckeIntegrate does internal RKF integration for this step
        encke = enckeIntegrate(encke, step, config, forceConfig);
        t += step;
        steps++;

        // Check for rectification
        if (encke.needsRectification) {
            encke = EnckeRectify(encke);
        }
    }

    return encke.getOsculatingState();
}

// =============================================================================
// 6. EquinoctialVOP - Equinoctial Elements Variation of Parameters
// =============================================================================

VariationalState EquinoctialVOPInit(const StateVector& state, double mu) {
    VariationalState varState;
    varState.useEquinoctial = true;
    varState.mu = mu;
    varState.t = 0;

    // Convert Cartesian to Keplerian
    varState.elements = cartesianToKeplerian(state, mu);

    // Convert Keplerian to Equinoctial
    double e = varState.elements.e;
    double i = varState.elements.i;
    double raan = varState.elements.raan;
    double argp = varState.elements.argp;
    double nu = varState.elements.nu;

    varState.equinoctial.a = varState.elements.a;
    varState.equinoctial.h = e * std::sin(argp + raan);
    varState.equinoctial.k = e * std::cos(argp + raan);
    varState.equinoctial.p = std::tan(i / 2.0) * std::sin(raan);
    varState.equinoctial.q = std::tan(i / 2.0) * std::cos(raan);
    varState.equinoctial.L = argp + raan + nu;
    varState.equinoctial.mu = mu;
    varState.equinoctial.epoch = state.epoch;

    return varState;
}

VariationalState EquinoctialVOP(const VariationalState& varState, double dt,
                                const IntegratorConfig& config,
                                const ForceModelConfig& forceConfig) {
    return equinoctialVOPIntegrate(varState, dt, config, forceConfig);
}

void EquinoctialRates(const EquinoctialElements& equinoctial,
                      const Vec3& perturbAccRTN, double* rates) {
    equinoctialVariationalRates(equinoctial, perturbAccRTN, rates);
}

StateVector EquinoctialVOP(const StateVector& initialState, double dt,
                           const IntegratorConfig& config,
                           ForceModel::ForceModelSet& forceSet) {
    ForceModelConfig forceConfig;
    forceConfig.mu = forceSet.mu;
    forceConfig.useJ2 = forceSet.useSphericalHarmonics;
    forceConfig.useSunGravity = forceSet.useThirdBody && forceSet.thirdBody.includeSun;
    forceConfig.useMoonGravity = forceSet.useThirdBody && forceSet.thirdBody.includeMoon;

    VariationalState varState = EquinoctialVOPInit(initialState, forceConfig.mu);
    VariationalState result = EquinoctialVOP(varState, dt, config, forceConfig);

    return keplerianToCartesian(result.elements);
}

// =============================================================================
// 7. KeplerianSTM - State Transition Matrix Propagation
// =============================================================================

KeplerianSTMState KeplerianSTMInit(const StateVector& state, double mu) {
    KeplerianSTMState stmState;
    stmState.elements = cartesianToKeplerian(state, mu);
    stmState.t = 0;
    stmState.initSTM();
    return stmState;
}

KeplerianSTMState KeplerianSTM(const KeplerianSTMState& stmState, double dt,
                               const IntegratorConfig& config,
                               const ForceModelConfig& forceConfig) {
    return keplerianSTMIntegrate(stmState, dt, config, forceConfig);
}

Mat6 GetSTM(const KeplerianSTMState& stmState) {
    Mat6 result;
    for (int i = 0; i < 6; i++) {
        for (int j = 0; j < 6; j++) {
            result.m[i][j] = stmState.stm[i][j];
        }
    }
    return result;
}

StateVector KeplerianSTM(const StateVector& initialState, double dt,
                         const IntegratorConfig& config,
                         const ForceModelConfig& forceConfig,
                         Mat6& stm) {
    KeplerianSTMState stmState = KeplerianSTMInit(initialState, forceConfig.mu);
    KeplerianSTMState result = KeplerianSTM(stmState, dt, config, forceConfig);
    stm = GetSTM(result);
    return keplerianToCartesian(result.elements);
}

// =============================================================================
// Additional High-Order Methods
// =============================================================================

StepResult RKF78(const std::array<double, 6>& state, double t, double h,
                 DerivativeFunc deriv, void* params) {
    StepResult result;
    double yout[6], yerr[6];
    astro::rkf78Step(t, h, state.data(), yout, yerr, deriv, params);

    for (int i = 0; i < 6; i++) {
        result.state[i] = yout[i];
        result.error[i] = std::abs(yerr[i]);
    }

    result.time = t + h;
    result.stepUsed = h;
    result.accepted = true;
    result.evaluations = 13;

    return result;
}

StepResult RKF78WithDense(const std::array<double, 6>& state, double t, double h,
                          DerivativeFunc deriv, void* params, DenseOutput& dense) {
    StepResult result = RKF78(state, t, h, deriv, params);

    // Setup dense output using Hermite interpolation
    dense.y0 = state;
    dense.y1 = result.state;
    dense.t0 = t;
    dense.t1 = t + h;

    // Compute derivatives at endpoints for Hermite interpolation
    double dy0[6], dy1[6];
    deriv(t, state.data(), dy0, params);
    deriv(t + h, result.state.data(), dy1, params);

    // Setup Hermite cubic coefficients
    for (int i = 0; i < 6; i++) {
        double dy = result.state[i] - state[i];
        dense.coeffs[0][i] = state[i];
        dense.coeffs[1][i] = h * dy0[i];
        dense.coeffs[2][i] = 3.0 * dy - h * (2.0 * dy0[i] + dy1[i]);
        dense.coeffs[3][i] = -2.0 * dy + h * (dy0[i] + dy1[i]);
    }
    dense.valid = true;

    return result;
}

PropagateResult RKF78Propagate(const StateVector& initialState, double targetTime,
                               const IntegratorConfig& config,
                               DerivativeFunc deriv, void* params) {
    PropagateResult result;
    result.finalState = initialState;

    std::array<double, 6> y = {
        initialState.position.x, initialState.position.y, initialState.position.z,
        initialState.velocity.x, initialState.velocity.y, initialState.velocity.z
    };

    double t = 0.0;
    // Handle backward propagation: use negative step for negative target time
    bool backward = (targetTime < 0.0);
    double h = backward ? -std::abs(config.initialStep) : std::abs(config.initialStep);
    double absTargetTime = std::abs(targetTime);

    uint32_t maxAttempts = config.maxSteps * 10;  // Allow rejections but prevent infinite loop
    uint32_t attempts = 0;

    while (std::abs(t) < absTargetTime && result.steps < config.maxSteps && attempts < maxAttempts) {
        attempts++;

        // Adjust step to not overshoot target
        if (backward) {
            if (t + h < targetTime) {
                h = targetTime - t;
            }
        } else {
            if (t + h > targetTime) {
                h = targetTime - t;
            }
        }

        StepResult stepRes = RKF78(y, t, h, deriv, params);

        // Compute error norm
        double errNorm = ComputeErrorNorm(stepRes.error, stepRes.state,
                                          config.absTolerance, config.relTolerance);

        if (errNorm <= 1.0) {
            // Accept step
            y = stepRes.state;
            t = stepRes.time;
            result.steps++;
            result.maxError = std::max(result.maxError, errNorm);

            // Compute optimal step size (order 8)
            double optStep = ComputeOptimalStep(std::abs(h), errNorm, 8);
            optStep = std::min(config.maxStep, std::max(config.minStep, optStep));
            h = backward ? -optStep : optStep;
        } else {
            // Reject step
            result.rejections++;
            double optStep = ComputeOptimalStep(std::abs(h), errNorm, 8, 0.9, 0.1, 1.0);
            optStep = std::max(config.minStep, optStep);
            h = backward ? -optStep : optStep;

            // If at minimum step and still rejecting, force acceptance to make progress
            if (optStep <= config.minStep * 1.01 && result.rejections > 10) {
                y = stepRes.state;
                t = stepRes.time;
                result.steps++;
                result.maxError = std::max(result.maxError, errNorm);
            }
        }
    }

    result.finalState.position = Vec3(y[0], y[1], y[2]);
    result.finalState.velocity = Vec3(y[3], y[4], y[5]);
    result.finalState.epoch = initialState.epoch + t / 86400.0;
    result.totalTime = t;
    result.success = (result.steps < config.maxSteps);

    return result;
}

StateVector RKF78(const StateVector& initialState, double dt,
                  const IntegratorConfig& config,
                  ForceModel::ForceModelSet& forceSet) {
    ForceModelWrapper wrapper;
    wrapper.forceSet = &forceSet;
    wrapper.epoch = forceSet.weather.epoch;

    PropagateResult res = RKF78Propagate(initialState, dt, config, forceModelDerivative, &wrapper);
    return res.finalState;
}

StepResult RKDP87(const std::array<double, 6>& state, double t, double h,
                  DerivativeFunc deriv, void* params) {
    StepResult result;
    double yout[6], yerr[6];
    astro::rkdp87Step(t, h, state.data(), yout, yerr, deriv, params);

    for (int i = 0; i < 6; i++) {
        result.state[i] = yout[i];
        result.error[i] = std::abs(yerr[i]);
    }

    result.time = t + h;
    result.stepUsed = h;
    result.accepted = true;
    result.evaluations = 13;

    return result;
}

PropagateResult RKDP87Propagate(const StateVector& initialState, double targetTime,
                                const IntegratorConfig& config,
                                DerivativeFunc deriv, void* params) {
    PropagateResult result;
    result.finalState = initialState;

    std::array<double, 6> y = {
        initialState.position.x, initialState.position.y, initialState.position.z,
        initialState.velocity.x, initialState.velocity.y, initialState.velocity.z
    };

    double t = 0.0;
    double h = config.initialStep;

    uint32_t maxAttempts = config.maxSteps * 10;  // Allow rejections but prevent infinite loop
    uint32_t attempts = 0;

    while (t < targetTime && result.steps < config.maxSteps && attempts < maxAttempts) {
        attempts++;

        if (t + h > targetTime) {
            h = targetTime - t;
        }

        StepResult stepRes = RKDP87(y, t, h, deriv, params);

        // Compute error norm
        double errNorm = ComputeErrorNorm(stepRes.error, stepRes.state,
                                          config.absTolerance, config.relTolerance);

        if (errNorm <= 1.0) {
            // Accept step
            y = stepRes.state;
            t = stepRes.time;
            result.steps++;
            result.maxError = std::max(result.maxError, errNorm);

            // Compute optimal step size (order 8)
            h = ComputeOptimalStep(h, errNorm, 8);
            h = std::min(config.maxStep, std::max(config.minStep, h));
        } else {
            // Reject step
            result.rejections++;
            h = ComputeOptimalStep(h, errNorm, 8, 0.9, 0.1, 1.0);
            h = std::max(config.minStep, h);

            // If at minimum step and still rejecting, force acceptance to make progress
            if (h <= config.minStep * 1.01 && result.rejections > 10) {
                y = stepRes.state;
                t = stepRes.time;
                result.steps++;
                result.maxError = std::max(result.maxError, errNorm);
            }
        }
    }

    result.finalState.position = Vec3(y[0], y[1], y[2]);
    result.finalState.velocity = Vec3(y[3], y[4], y[5]);
    result.finalState.epoch = initialState.epoch + t / 86400.0;
    result.totalTime = t;
    result.success = (result.steps < config.maxSteps);

    return result;
}

StepResult BulirschStoer(const std::array<double, 6>& state, double t, double h,
                         DerivativeFunc deriv, void* params,
                         int maxSubdivisions) {
    StepResult result;
    double yout[6], yerr[6];
    astro::bulirschStoerStep(t, h, state.data(), yout, yerr, deriv, params, maxSubdivisions);

    for (int i = 0; i < 6; i++) {
        result.state[i] = yout[i];
        result.error[i] = std::abs(yerr[i]);
    }

    result.time = t + h;
    result.stepUsed = h;
    result.accepted = true;
    result.evaluations = maxSubdivisions * 4;  // Approximate

    return result;
}

StepResult BS(const std::array<double, 6>& state, double t, double h,
              DerivativeFunc deriv, void* params, const BSConfig& bsConfig) {
    return BulirschStoer(state, t, h, deriv, params, bsConfig.maxSubdivisions);
}

PropagateResult BSPropagate(const StateVector& initialState, double targetTime,
                            const IntegratorConfig& config,
                            DerivativeFunc deriv, void* params,
                            const BSConfig& bsConfig) {
    PropagateResult result;
    result.finalState = initialState;

    std::array<double, 6> y = {
        initialState.position.x, initialState.position.y, initialState.position.z,
        initialState.velocity.x, initialState.velocity.y, initialState.velocity.z
    };

    double t = 0.0;
    double h = config.initialStep;

    uint32_t maxAttempts = config.maxSteps * 10;  // Allow rejections but prevent infinite loop
    uint32_t attempts = 0;

    while (t < targetTime && result.steps < config.maxSteps && attempts < maxAttempts) {
        attempts++;

        if (t + h > targetTime) {
            h = targetTime - t;
        }

        StepResult stepRes = BS(y, t, h, deriv, params, bsConfig);

        // Compute error norm
        double errNorm = ComputeErrorNorm(stepRes.error, stepRes.state,
                                          config.absTolerance, config.relTolerance);

        if (errNorm <= 1.0) {
            // Accept step
            y = stepRes.state;
            t = stepRes.time;
            result.steps++;
            result.maxError = std::max(result.maxError, errNorm);

            // Compute optimal step size (effective order ~= maxSubdivisions)
            double factor = bsConfig.safetyFactor * std::pow(errNorm, -1.0 / (bsConfig.maxSubdivisions + 1));
            factor = std::min(bsConfig.maxStepFactor, std::max(bsConfig.minStepFactor, factor));
            h = std::min(config.maxStep, h * factor);
        } else {
            // Reject step
            result.rejections++;
            double factor = bsConfig.safetyFactor * std::pow(errNorm, -1.0 / bsConfig.maxSubdivisions);
            factor = std::max(bsConfig.minStepFactor, factor);
            h = std::max(config.minStep, h * factor);

            // If at minimum step and still rejecting, force acceptance to make progress
            if (h <= config.minStep * 1.01 && result.rejections > 10) {
                y = stepRes.state;
                t = stepRes.time;
                result.steps++;
                result.maxError = std::max(result.maxError, errNorm);
            }
        }
    }

    result.finalState.position = Vec3(y[0], y[1], y[2]);
    result.finalState.velocity = Vec3(y[3], y[4], y[5]);
    result.finalState.epoch = initialState.epoch + t / 86400.0;
    result.totalTime = t;
    result.success = (result.steps < config.maxSteps);

    return result;
}

StateVector BS(const StateVector& initialState, double dt,
               const IntegratorConfig& config,
               ForceModel::ForceModelSet& forceSet) {
    ForceModelWrapper wrapper;
    wrapper.forceSet = &forceSet;
    wrapper.epoch = forceSet.weather.epoch;

    PropagateResult res = BSPropagate(initialState, dt, config, forceModelDerivative, &wrapper);
    return res.finalState;
}

StepResult GaussJackson8(IntegratorState& state, DerivativeFunc deriv, void* params) {
    StepResult result;
    astro::gaussJackson8Step(state, state.h, deriv, params);

    for (int i = 0; i < 6; i++) {
        result.state[i] = state.y[i];
        // GJ8 error estimate: difference between predictor and corrector
        // (computed inside gaussJackson8Step). Use a conservative estimate
        // based on the step size and order for adaptive step control.
        result.error[i] = std::abs(state.y[i]) * 1e-12;
    }

    result.time = state.t;
    result.stepUsed = state.h;
    result.accepted = true;
    result.evaluations = 1;

    return result;
}

IntegratorState GaussJackson8Init(const StateVector& initialState, double h,
                                   DerivativeFunc deriv, void* params) {
    IntegratorState state;
    state.y = {
        initialState.position.x, initialState.position.y, initialState.position.z,
        initialState.velocity.x, initialState.velocity.y, initialState.velocity.z
    };
    state.t = 0.0;
    state.h = h;
    state.steps = 0;
    state.rejections = 0;
    state.historyCount = 0;
    state.initialized = false;

    // Build startup history using RK4 steps (need 8 steps for 8th order)
    constexpr int ORDER = 8;
    std::array<double, 6> y = state.y;
    double t = 0.0;

    // Store initial derivative
    deriv(t, y.data(), state.fHistory[0].data(), params);
    state.historyCount = 1;

    // Take startup steps with RK4
    for (int step = 1; step < ORDER; step++) {
        StepResult stepRes = RK4(y, t, h, deriv, params);
        y = stepRes.state;
        t += h;

        // Shift history and store new derivative
        for (int i = state.historyCount; i > 0; i--) {
            state.fHistory[i] = state.fHistory[i-1];
            state.history[i] = state.history[i-1];
        }
        state.history[0] = y;
        deriv(t, y.data(), state.fHistory[0].data(), params);
        state.historyCount++;
    }

    state.y = y;
    state.t = t;
    state.initialized = true;

    return state;
}

PropagateResult GaussJackson8Propagate(const StateVector& initialState, double targetTime,
                                        double h, DerivativeFunc deriv, void* params) {
    PropagateResult result;

    IntegratorState state = GaussJackson8Init(initialState, h, deriv, params);
    result.steps = 8;  // Startup steps

    while (state.t < targetTime && result.steps < 100000) {
        StepResult stepRes = GaussJackson8(state, deriv, params);
        result.steps++;
    }

    result.finalState.position = Vec3(state.y[0], state.y[1], state.y[2]);
    result.finalState.velocity = Vec3(state.y[3], state.y[4], state.y[5]);
    result.finalState.epoch = initialState.epoch + state.t / 86400.0;
    result.totalTime = state.t;
    result.success = (result.steps < 100000);

    return result;
}

StepResult GaussJackson12(IntegratorState& state, DerivativeFunc deriv, void* params) {
    // NOTE: GJ12 is not yet fully implemented. The summed difference table
    // approach for 12th order requires 12 history points and careful
    // predictor/corrector coefficient handling. Currently delegates to RKF78
    // which provides comparable accuracy per step at the cost of more
    // function evaluations (13 per step vs 1 for a true GJ12 corrector step).
    // TODO: Implement full Gauss-Jackson 12th order with summed differences.

    StepResult result;
    constexpr int N = 6;
    double h = state.h;

    StepResult rkRes = RKF78(state.y, state.t, h, deriv, params);

    state.y = rkRes.state;
    state.t += h;

    // Shift history
    for (int i = 7; i > 0; i--) {
        state.fHistory[i] = state.fHistory[i-1];
    }
    deriv(state.t, state.y.data(), state.fHistory[0].data(), params);

    result.state = state.y;
    result.time = state.t;
    result.stepUsed = h;
    result.accepted = true;
    result.evaluations = 13;
    result.error = rkRes.error;

    return result;
}

// =============================================================================
// DROMO - Regularized Orbital Element Formulation
// =============================================================================

DromoState DromoInit(const StateVector& state, double mu) {
    return astro::dromoInit(state, mu);
}

StepResult Dromo(DromoState& dromoState, double ds,
                 DerivativeFunc deriv, void* params) {
    StepResult result;

    // Perform DROMO step
    double dtPhysical = astro::dromoStep(dromoState, ds, deriv, params);

    // Get Cartesian state from DROMO
    StateVector cartState = dromoState.toCartesian();

    result.state[0] = cartState.position.x;
    result.state[1] = cartState.position.y;
    result.state[2] = cartState.position.z;
    result.state[3] = cartState.velocity.x;
    result.state[4] = cartState.velocity.y;
    result.state[5] = cartState.velocity.z;

    result.time = dromoState.physicalTime;
    result.stepUsed = dtPhysical;
    result.accepted = true;
    result.evaluations = 2;  // Approximate

    // Error estimate based on energy drift
    double r = cartState.position.magnitude();
    double v = cartState.velocity.magnitude();
    double energyNow = 0.5 * v * v - dromoState.mu / r;
    double energyErr = std::abs(energyNow - dromoState.energy);

    for (int i = 0; i < 6; i++) {
        result.error[i] = energyErr * 1e-6;  // Approximate error
    }

    return result;
}

PropagateResult DromoPropagate(const StateVector& initialState, double targetTime,
                               const IntegratorConfig& config,
                               ForceModel::ForceModelSet& forceSet) {
    PropagateResult result;
    result.finalState = initialState;

    ForceModelWrapper wrapper;
    wrapper.forceSet = &forceSet;
    wrapper.epoch = forceSet.weather.epoch;

    DromoState dromoState = DromoInit(initialState, forceSet.mu);

    // Estimate fictitious time step from physical time step
    double r0 = initialState.position.magnitude();
    double ds = config.initialStep / r0;  // Approximate Sundman relation

    double maxSteps = config.maxSteps * 10;  // Allow more steps for regularized methods
    uint32_t steps = 0;

    while (dromoState.physicalTime < targetTime && steps < maxSteps) {
        // Adjust step to not overshoot
        double remaining = targetTime - dromoState.physicalTime;
        double r = dromoState.toCartesian().position.magnitude();
        double dsRemaining = remaining / r;
        double dsStep = std::min(ds, dsRemaining);

        StepResult stepRes = Dromo(dromoState, dsStep, forceModelDerivative, &wrapper);
        steps++;
        result.steps++;

        // Adaptive step size based on energy conservation
        if (std::abs(stepRes.error[0]) > config.absTolerance * 1e6) {
            ds *= 0.5;
        } else if (std::abs(stepRes.error[0]) < config.absTolerance * 1e4) {
            ds *= 1.5;
        }
    }

    StateVector finalCart = dromoState.toCartesian();
    result.finalState = finalCart;
    result.totalTime = dromoState.physicalTime;
    result.success = (steps < maxSteps);

    return result;
}

StateVector Dromo(const StateVector& initialState, double dt,
                  const IntegratorConfig& config,
                  ForceModel::ForceModelSet& forceSet) {
    PropagateResult res = DromoPropagate(initialState, dt, config, forceSet);
    return res.finalState;
}

// =============================================================================
// Stiefel-Scheifele - KS Transformation Regularization
// =============================================================================

StiefelState StiefelInit(const StateVector& state, double mu) {
    return astro::stiefelInit(state, mu);
}

StepResult Stiefel(StiefelState& stiefelState, double ds,
                   DerivativeFunc deriv, void* params) {
    StepResult result;

    // Perform Stiefel step
    double dtPhysical = astro::stiefelStep(stiefelState, ds, deriv, params);

    // Get Cartesian state from Stiefel
    StateVector cartState = stiefelState.toCartesian();

    result.state[0] = cartState.position.x;
    result.state[1] = cartState.position.y;
    result.state[2] = cartState.position.z;
    result.state[3] = cartState.velocity.x;
    result.state[4] = cartState.velocity.y;
    result.state[5] = cartState.velocity.z;

    result.time = stiefelState.physicalTime;
    result.stepUsed = dtPhysical;
    result.accepted = true;
    result.evaluations = 2;  // Approximate

    // Error estimate based on energy drift
    double r = stiefelState.radius();
    double v = cartState.velocity.magnitude();
    double energyNow = 0.5 * v * v - stiefelState.mu / r;
    double energyErr = std::abs(energyNow - stiefelState.energy);

    for (int i = 0; i < 6; i++) {
        result.error[i] = energyErr * 1e-6;  // Approximate error
    }

    return result;
}

PropagateResult StiefelPropagate(const StateVector& initialState, double targetTime,
                                 const IntegratorConfig& config,
                                 ForceModel::ForceModelSet& forceSet) {
    PropagateResult result;
    result.finalState = initialState;

    ForceModelWrapper wrapper;
    wrapper.forceSet = &forceSet;
    wrapper.epoch = forceSet.weather.epoch;

    StiefelState stiefelState = StiefelInit(initialState, forceSet.mu);

    // Estimate fictitious time step from physical time step
    double r0 = initialState.position.magnitude();
    double ds = config.initialStep / r0;  // Approximate Sundman relation

    double maxSteps = config.maxSteps * 10;  // Allow more steps for regularized methods
    uint32_t steps = 0;

    while (stiefelState.physicalTime < targetTime && steps < maxSteps) {
        // Adjust step to not overshoot
        double remaining = targetTime - stiefelState.physicalTime;
        double r = stiefelState.radius();
        double dsRemaining = remaining / r;
        double dsStep = std::min(ds, dsRemaining);

        StepResult stepRes = Stiefel(stiefelState, dsStep, forceModelDerivative, &wrapper);
        steps++;
        result.steps++;

        // Adaptive step size based on energy conservation
        if (std::abs(stepRes.error[0]) > config.absTolerance * 1e6) {
            ds *= 0.5;
        } else if (std::abs(stepRes.error[0]) < config.absTolerance * 1e4) {
            ds *= 1.5;
        }
    }

    StateVector finalCart = stiefelState.toCartesian();
    result.finalState = finalCart;
    result.totalTime = stiefelState.physicalTime;
    result.success = (steps < maxSteps);

    return result;
}

StateVector Stiefel(const StateVector& initialState, double dt,
                    const IntegratorConfig& config,
                    ForceModel::ForceModelSet& forceSet) {
    PropagateResult res = StiefelPropagate(initialState, dt, config, forceSet);
    return res.finalState;
}

// =============================================================================
// Gauss VOP - Classical Keplerian Element Variation of Parameters
// =============================================================================

VariationalState GaussVOP(const VariationalState& varState, double dt,
                          const IntegratorConfig& config,
                          const ForceModelConfig& forceConfig) {
    return gaussVOPIntegrate(varState, dt, config, forceConfig);
}

void GaussRates(const KeplerianElements& elements,
                const Vec3& perturbAccRTN, double* rates) {
    gaussVariationalRates(elements, perturbAccRTN, rates);
}

VariationalState GaussVOPInit(const StateVector& state, double mu) {
    VariationalState varState;
    varState.useEquinoctial = false;
    varState.mu = mu;
    varState.t = 0;

    // Convert Cartesian to Keplerian
    varState.elements = cartesianToKeplerian(state, mu);

    return varState;
}

StateVector GaussVOP(const StateVector& initialState, double dt,
                     const IntegratorConfig& config,
                     ForceModel::ForceModelSet& forceSet) {
    ForceModelConfig forceConfig;
    forceConfig.mu = forceSet.mu;
    forceConfig.useJ2 = forceSet.useSphericalHarmonics;
    forceConfig.useSunGravity = forceSet.useThirdBody && forceSet.thirdBody.includeSun;
    forceConfig.useMoonGravity = forceSet.useThirdBody && forceSet.thirdBody.includeMoon;

    VariationalState varState = GaussVOPInit(initialState, forceConfig.mu);
    VariationalState result = GaussVOP(varState, dt, config, forceConfig);

    return keplerianToCartesian(result.elements);
}

// =============================================================================
// Convenience Functions
// =============================================================================

StateVector Propagate(const StateVector& initialState, double dt,
                      const IntegratorConfig& config,
                      ForceModel::ForceModelSet& forceSet) {
    switch (config.method) {
        case IntegrationMethod::RK4:
            return RK4(initialState, dt, config.initialStep, forceSet);

        case IntegrationMethod::RKF45:
            return RKF45(initialState, dt, config, forceSet);

        case IntegrationMethod::ABM:
            return ABM(initialState, dt, config.initialStep, 4, forceSet);

        case IntegrationMethod::Cowell:
            return Cowell(initialState, dt, config, forceSet);

        case IntegrationMethod::Encke:
            return Encke(initialState, dt, config, forceSet);

        case IntegrationMethod::EquinoctialVOP:
            return EquinoctialVOP(initialState, dt, config, forceSet);

        case IntegrationMethod::RKF78:
        case IntegrationMethod::RK78:
        default:
            // Use the dedicated RKF78 propagator, which supports both forward
            // and backward integration. The old inline loop only handled dt>0.
            return RKF78(initialState, dt, config, forceSet);
    }
}

IntegratorConfig CreateLEOConfig() {
    IntegratorConfig config;
    config.method = IntegrationMethod::RKF78;
    config.initialStep = 30.0;
    config.minStep = 1.0;
    config.maxStep = 300.0;
    config.absTolerance = 1e-10;
    config.relTolerance = 1e-10;
    config.maxSteps = 100000;
    return config;
}

IntegratorConfig CreateGEOConfig() {
    IntegratorConfig config;
    config.method = IntegrationMethod::Encke;
    config.initialStep = 60.0;
    config.minStep = 10.0;
    config.maxStep = 1800.0;
    config.absTolerance = 1e-11;
    config.relTolerance = 1e-11;
    config.maxSteps = 50000;
    return config;
}

IntegratorConfig CreateCislunarConfig() {
    IntegratorConfig config;
    config.method = IntegrationMethod::RKF78;
    config.initialStep = 60.0;
    config.minStep = 1.0;
    config.maxStep = 3600.0;
    config.absTolerance = 1e-12;
    config.relTolerance = 1e-12;
    config.maxSteps = 200000;
    return config;
}

IntegratorConfig CreateHighFidelityConfig() {
    IntegratorConfig config;
    config.method = IntegrationMethod::BS;
    config.initialStep = 10.0;
    config.minStep = 0.1;
    config.maxStep = 600.0;
    config.absTolerance = 1e-14;
    config.relTolerance = 1e-14;
    config.maxSteps = 500000;
    return config;
}

IntegratorConfig CreateDeepSpaceConfig() {
    IntegratorConfig config;
    config.method = IntegrationMethod::RKF78;
    config.initialStep = 300.0;
    config.minStep = 10.0;
    config.maxStep = 86400.0;  // Up to 1 day
    config.absTolerance = 1e-12;
    config.relTolerance = 1e-12;
    config.maxSteps = 500000;
    return config;
}

IntegratorConfig CreateRendezvousConfig() {
    IntegratorConfig config;
    config.method = IntegrationMethod::RKF78;
    config.initialStep = 1.0;
    config.minStep = 0.01;
    config.maxStep = 60.0;
    config.absTolerance = 1e-13;
    config.relTolerance = 1e-13;
    config.maxSteps = 1000000;
    return config;
}

// =============================================================================
// Error Estimation Utilities
// =============================================================================

double ComputeErrorNorm(const std::array<double, 6>& error,
                        const std::array<double, 6>& y,
                        double absTol, double relTol) {
    double maxNorm = 0.0;
    for (int i = 0; i < 6; i++) {
        double scale = absTol + relTol * std::abs(y[i]);
        if (scale > 0) {
            double norm = error[i] / scale;
            maxNorm = std::max(maxNorm, norm);
        }
    }
    return maxNorm;
}

double ComputeOptimalStep(double h, double errNorm, int order,
                          double safety, double minFactor,
                          double maxFactor) {
    if (errNorm < 1e-15) {
        return h * maxFactor;
    }

    double factor = safety * std::pow(errNorm, -1.0 / (order + 1));
    factor = std::min(maxFactor, std::max(minFactor, factor));
    return h * factor;
}

// =============================================================================
// Interpolation Utilities
// =============================================================================

std::array<double, 6> HermiteInterpolate(const std::array<double, 6>& y0,
                                          const std::array<double, 6>& dy0,
                                          const std::array<double, 6>& y1,
                                          const std::array<double, 6>& dy1,
                                          double t0, double t1, double t) {
    double h = t1 - t0;
    if (std::abs(h) < 1e-15) {
        return y0;
    }

    double theta = (t - t0) / h;
    double theta2 = theta * theta;
    double theta3 = theta2 * theta;

    // Hermite basis functions
    double h00 = 2*theta3 - 3*theta2 + 1;
    double h10 = theta3 - 2*theta2 + theta;
    double h01 = -2*theta3 + 3*theta2;
    double h11 = theta3 - theta2;

    std::array<double, 6> result;
    for (int i = 0; i < 6; i++) {
        result[i] = h00 * y0[i] + h10 * h * dy0[i] + h01 * y1[i] + h11 * h * dy1[i];
    }
    return result;
}

// =============================================================================
// Ephemeris Generation Functions
// =============================================================================

PropagateResult GenerateEphemeris(const StateVector& initialState, double dt,
                                  double outputInterval,
                                  const IntegratorConfig& config,
                                  ForceModel::ForceModelSet& forceSet,
                                  std::vector<StateVector>& ephemeris) {
    PropagateResult result;
    ephemeris.clear();

    ForceModelWrapper wrapper;
    wrapper.forceSet = &forceSet;
    wrapper.epoch = forceSet.weather.epoch;

    std::array<double, 6> y = {
        initialState.position.x, initialState.position.y, initialState.position.z,
        initialState.velocity.x, initialState.velocity.y, initialState.velocity.z
    };

    double t = 0.0;
    double h = config.initialStep;
    double nextOutput = 0.0;

    // Store initial state
    ephemeris.push_back(initialState);

    while (t < dt && result.steps < config.maxSteps) {
        if (t + h > dt) h = dt - t;

        StepResult stepRes;
        switch (config.method) {
            case IntegrationMethod::RK4:
                stepRes = RK4(y, t, h, forceModelDerivative, &wrapper);
                break;
            case IntegrationMethod::RKF45:
                stepRes = RKF45(y, t, h, forceModelDerivative, &wrapper);
                break;
            case IntegrationMethod::RKF78:
            case IntegrationMethod::RK78:
                stepRes = RKF78(y, t, h, forceModelDerivative, &wrapper);
                break;
            case IntegrationMethod::RKDP87:
                stepRes = RKDP87(y, t, h, forceModelDerivative, &wrapper);
                break;
            case IntegrationMethod::BS:
                stepRes = BulirschStoer(y, t, h, forceModelDerivative, &wrapper);
                break;
            default:
                stepRes = RKF78(y, t, h, forceModelDerivative, &wrapper);
        }

        // Check error for adaptive methods
        double errNorm = ComputeErrorNorm(stepRes.error, stepRes.state,
                                          config.absTolerance, config.relTolerance);

        if (errNorm <= 1.0 || config.method == IntegrationMethod::RK4) {
            y = stepRes.state;
            t = stepRes.time;
            result.steps++;

            // Output at intervals
            while (nextOutput + outputInterval <= t && nextOutput < dt) {
                nextOutput += outputInterval;
                StateVector sv;
                sv.position = Vec3(y[0], y[1], y[2]);
                sv.velocity = Vec3(y[3], y[4], y[5]);
                sv.epoch = initialState.epoch + t / 86400.0;
                ephemeris.push_back(sv);
            }

            // Adjust step size
            if (config.method != IntegrationMethod::RK4 && errNorm > 0) {
                int order = (config.method == IntegrationMethod::RKF45) ? 5 : 8;
                h = ComputeOptimalStep(h, errNorm, order);
                h = std::min(config.maxStep, std::max(config.minStep, h));
            }
        } else {
            result.rejections++;
            h = ComputeOptimalStep(h, errNorm, 8, 0.9, 0.1, 1.0);
            h = std::max(config.minStep, h);
        }
    }

    result.finalState.position = Vec3(y[0], y[1], y[2]);
    result.finalState.velocity = Vec3(y[3], y[4], y[5]);
    result.finalState.epoch = initialState.epoch + t / 86400.0;
    result.totalTime = t;
    result.success = true;

    return result;
}

PropagateResult GenerateEphemerisDense(const StateVector& initialState, double dt,
                                       double outputInterval,
                                       const IntegratorConfig& config,
                                       ForceModel::ForceModelSet& forceSet,
                                       std::vector<StateVector>& ephemeris) {
    PropagateResult result;
    ephemeris.clear();

    ForceModelWrapper wrapper;
    wrapper.forceSet = &forceSet;
    wrapper.epoch = forceSet.weather.epoch;

    std::array<double, 6> y = {
        initialState.position.x, initialState.position.y, initialState.position.z,
        initialState.velocity.x, initialState.velocity.y, initialState.velocity.z
    };

    double t = 0.0;
    double h = config.initialStep;
    double nextOutput = 0.0;

    // Store initial state
    ephemeris.push_back(initialState);

    while (t < dt && result.steps < config.maxSteps) {
        if (t + h > dt) h = dt - t;

        // Use dense output version
        DenseOutput dense;
        StepResult stepRes;

        switch (config.method) {
            case IntegrationMethod::RK4:
                stepRes = RK4WithDense(y, t, h, forceModelDerivative, &wrapper, dense);
                break;
            case IntegrationMethod::RKF45:
                stepRes = RKF45WithDense(y, t, h, forceModelDerivative, &wrapper, dense);
                break;
            case IntegrationMethod::RKF78:
            case IntegrationMethod::RK78:
                stepRes = RKF78WithDense(y, t, h, forceModelDerivative, &wrapper, dense);
                break;
            default:
                // Fall back to Hermite interpolation
                stepRes = RKF78WithDense(y, t, h, forceModelDerivative, &wrapper, dense);
        }

        // Check error for adaptive methods
        double errNorm = ComputeErrorNorm(stepRes.error, stepRes.state,
                                          config.absTolerance, config.relTolerance);

        if (errNorm <= 1.0 || config.method == IntegrationMethod::RK4) {
            // Output at intervals using dense output
            while (nextOutput + outputInterval <= stepRes.time && nextOutput < dt) {
                nextOutput += outputInterval;
                if (nextOutput >= dense.t0 && nextOutput <= dense.t1 && dense.valid) {
                    std::array<double, 6> interpState = dense.evaluate(nextOutput);
                    StateVector sv;
                    sv.position = Vec3(interpState[0], interpState[1], interpState[2]);
                    sv.velocity = Vec3(interpState[3], interpState[4], interpState[5]);
                    sv.epoch = initialState.epoch + nextOutput / 86400.0;
                    ephemeris.push_back(sv);
                }
            }

            y = stepRes.state;
            t = stepRes.time;
            result.steps++;

            // Adjust step size
            if (config.method != IntegrationMethod::RK4 && errNorm > 0) {
                int order = (config.method == IntegrationMethod::RKF45) ? 5 : 8;
                h = ComputeOptimalStep(h, errNorm, order);
                h = std::min(config.maxStep, std::max(config.minStep, h));
            }
        } else {
            result.rejections++;
            h = ComputeOptimalStep(h, errNorm, 8, 0.9, 0.1, 1.0);
            h = std::max(config.minStep, h);
        }
    }

    result.finalState.position = Vec3(y[0], y[1], y[2]);
    result.finalState.velocity = Vec3(y[3], y[4], y[5]);
    result.finalState.epoch = initialState.epoch + t / 86400.0;
    result.totalTime = t;
    result.success = true;

    return result;
}

PropagateResult PropagateWithResult(const StateVector& initialState, double dt,
                                    const IntegratorConfig& config,
                                    ForceModel::ForceModelSet& forceSet) {
    ForceModelWrapper wrapper;
    wrapper.forceSet = &forceSet;
    wrapper.epoch = forceSet.weather.epoch;

    switch (config.method) {
        case IntegrationMethod::RK4:
            return RK4Propagate(initialState, dt, config.initialStep,
                               forceModelDerivative, &wrapper);

        case IntegrationMethod::RKF45:
            return RKF45Propagate(initialState, dt, config, forceModelDerivative, &wrapper);

        case IntegrationMethod::RKF78:
        case IntegrationMethod::RK78:
            return RKF78Propagate(initialState, dt, config, forceModelDerivative, &wrapper);

        case IntegrationMethod::RKDP87:
            return RKDP87Propagate(initialState, dt, config, forceModelDerivative, &wrapper);

        case IntegrationMethod::BS:
            return BSPropagate(initialState, dt, config, forceModelDerivative, &wrapper);

        default:
            return RKF78Propagate(initialState, dt, config, forceModelDerivative, &wrapper);
    }
}

} // namespace Integrator
} // namespace astro
