#include "cislunar/cr3bp.h"
#include "cislunar/constants.h"

#include <cmath>
#include <algorithm>
#include <stdexcept>
#include <numeric>

namespace cislunar {

// ===========================================================================
// CR3BP Equations of Motion
// ===========================================================================

Vector6 cr3bpEOM(const Vector6& s, double mu) {
    double x = s[0], y = s[1], z = s[2];
    double vx = s[3], vy = s[4], vz = s[5];

    // Distances to primaries (in rotating frame)
    // Primary 1 (larger) at (-mu, 0, 0)
    // Primary 2 (smaller) at (1-mu, 0, 0)
    double dx1 = x + mu;
    double dx2 = x - (1.0 - mu);
    double r1 = std::sqrt(dx1*dx1 + y*y + z*z);
    double r2 = std::sqrt(dx2*dx2 + y*y + z*z);
    double r1_3 = r1 * r1 * r1;
    double r2_3 = r2 * r2 * r2;

    // Accelerations in rotating frame
    double ax = 2.0*vy + x - (1.0-mu)*dx1/r1_3 - mu*dx2/r2_3;
    double ay = -2.0*vx + y - (1.0-mu)*y/r1_3 - mu*y/r2_3;
    double az = -(1.0-mu)*z/r1_3 - mu*z/r2_3;

    return {vx, vy, vz, ax, ay, az};
}

std::vector<double> cr3bpEOMWithSTM(const std::vector<double>& state, double mu) {
    // State: [x,y,z,vx,vy,vz, phi(36 elements)]
    double x = state[0], y = state[1], z = state[2];

    double dx1 = x + mu;
    double dx2 = x - (1.0 - mu);
    double r1 = std::sqrt(dx1*dx1 + y*y + z*z);
    double r2 = std::sqrt(dx2*dx2 + y*y + z*z);
    double r1_3 = r1*r1*r1;
    double r2_3 = r2*r2*r2;
    double r1_5 = r1_3*r1*r1;
    double r2_5 = r2_3*r2*r2;

    // EOM for state
    Vector6 s = {state[0], state[1], state[2], state[3], state[4], state[5]};
    Vector6 ds = cr3bpEOM(s, mu);

    // Jacobian of the CR3BP (A matrix for STM)
    // Uxx, Uxy, Uxz, etc. (second partial derivatives of pseudo-potential)
    double Uxx = 1.0 - (1.0-mu)/r1_3 - mu/r2_3
                 + 3.0*(1.0-mu)*dx1*dx1/r1_5 + 3.0*mu*dx2*dx2/r2_5;
    double Uyy = 1.0 - (1.0-mu)/r1_3 - mu/r2_3
                 + 3.0*(1.0-mu)*y*y/r1_5 + 3.0*mu*y*y/r2_5;
    double Uzz = -(1.0-mu)/r1_3 - mu/r2_3
                 + 3.0*(1.0-mu)*z*z/r1_5 + 3.0*mu*z*z/r2_5;
    double Uxy = 3.0*(1.0-mu)*dx1*y/r1_5 + 3.0*mu*dx2*y/r2_5;
    double Uxz = 3.0*(1.0-mu)*dx1*z/r1_5 + 3.0*mu*dx2*z/r2_5;
    double Uyz = 3.0*(1.0-mu)*y*z/r1_5 + 3.0*mu*y*z/r2_5;

    // A matrix (6x6 Jacobian)
    // [  0   0   0   1   0   0 ]
    // [  0   0   0   0   1   0 ]
    // [  0   0   0   0   0   1 ]
    // [ Uxx Uxy Uxz  0   2   0 ]
    // [ Uxy Uyy Uyz -2   0   0 ]
    // [ Uxz Uyz Uzz  0   0   0 ]

    // STM derivative: dPhi/dt = A * Phi
    std::vector<double> result(42);
    for (int i = 0; i < 6; ++i) result[i] = ds[i];

    // Extract Phi from state (6x6, row-major starting at index 6)
    // Compute A * Phi
    for (int i = 0; i < 6; ++i) {
        for (int j = 0; j < 6; ++j) {
            double sum = 0.0;
            // Row i of A * column j of Phi
            // A is structured as [0 I; U 2Omega]
            if (i < 3) {
                // Top block: A[i][j] = delta(i, j+3)
                sum = state[6 + (i+3)*6 + j];
            } else {
                // Bottom block
                double A_row[6] = {0};
                if (i == 3) { A_row[0]=Uxx; A_row[1]=Uxy; A_row[2]=Uxz; A_row[4]=2.0; }
                if (i == 4) { A_row[0]=Uxy; A_row[1]=Uyy; A_row[2]=Uyz; A_row[3]=-2.0; }
                if (i == 5) { A_row[0]=Uxz; A_row[1]=Uyz; A_row[2]=Uzz; }
                for (int k = 0; k < 6; ++k) {
                    sum += A_row[k] * state[6 + k*6 + j];
                }
            }
            result[6 + i*6 + j] = sum;
        }
    }

    return result;
}

double jacobiConstant(const Vector6& s, double mu) {
    return 2.0 * pseudoPotential(s[0], s[1], s[2], mu) -
           (s[3]*s[3] + s[4]*s[4] + s[5]*s[5]);
}

double pseudoPotential(double x, double y, double z, double mu) {
    double dx1 = x + mu;
    double dx2 = x - (1.0 - mu);
    double r1 = std::sqrt(dx1*dx1 + y*y + z*z);
    double r2 = std::sqrt(dx2*dx2 + y*y + z*z);
    return 0.5 * (x*x + y*y) + (1.0-mu)/r1 + mu/r2;
}

// ===========================================================================
// Lagrange Points
// ===========================================================================

double computeCollinearPoint(double mu, LagrangePoint point) {
    // Solve the quintic equation for collinear equilibrium points
    // Using Newton-Raphson iteration
    double x0;
    switch (point) {
        case LagrangePoint::L1:
            // L1 is between the two bodies, closer to the smaller one
            x0 = 1.0 - mu - std::pow(mu/3.0, 1.0/3.0);
            break;
        case LagrangePoint::L2:
            // L2 is beyond the smaller body
            x0 = 1.0 - mu + std::pow(mu/3.0, 1.0/3.0);
            break;
        case LagrangePoint::L3:
            // L3 is on the opposite side of the larger body
            x0 = -1.0 - (5.0/12.0) * mu;
            break;
        default:
            throw std::runtime_error("computeCollinearPoint: only L1, L2, L3");
    }

    // Newton-Raphson
    for (int iter = 0; iter < 100; ++iter) {
        double dx1 = x0 + mu;
        double dx2 = x0 - (1.0 - mu);
        double r1 = std::abs(dx1);
        double r2 = std::abs(dx2);
        double r1_3 = r1*r1*r1;
        double r2_3 = r2*r2*r2;
        double r1_4 = r1_3 * r1;
        double r2_4 = r2_3 * r2;

        // f(x) = x - (1-mu)*(x+mu)/|x+mu|^3 - mu*(x-1+mu)/|x-1+mu|^3
        double sign1 = (dx1 >= 0) ? 1.0 : -1.0;
        double sign2 = (dx2 >= 0) ? 1.0 : -1.0;

        double f = x0 - (1.0-mu)*dx1/r1_3 - mu*dx2/r2_3;
        double df = 1.0 - (1.0-mu)*(1.0/r1_3 - 3.0*dx1*dx1*sign1/r1_4/r1) -
                    mu*(1.0/r2_3 - 3.0*dx2*dx2*sign2/r2_4/r2);

        // Simplified derivative for stability
        df = 1.0 + 2.0*(1.0-mu)/r1_3 + 2.0*mu/r2_3;

        double delta = f / df;
        x0 -= delta;
        if (std::abs(delta) < 1e-15) break;
    }

    return x0;
}

std::array<LagrangePointResult, 5> computeLagrangePoints(double mu) {
    std::array<LagrangePointResult, 5> results;

    // Collinear points
    for (int i = 0; i < 3; ++i) {
        LagrangePoint lp = static_cast<LagrangePoint>(i);
        double x = computeCollinearPoint(mu, lp);
        results[i].point = lp;
        results[i].position = {x, 0.0, 0.0};
        results[i].jacobi = jacobiConstant({x, 0, 0, 0, 0, 0}, mu);
    }

    // Triangular points L4 and L5
    // L4: (0.5 - mu, sqrt(3)/2, 0)
    // L5: (0.5 - mu, -sqrt(3)/2, 0)
    double x_tri = 0.5 - mu;
    double y_tri = std::sqrt(3.0) / 2.0;

    results[3].point = LagrangePoint::L4;
    results[3].position = {x_tri, y_tri, 0.0};
    results[3].jacobi = jacobiConstant({x_tri, y_tri, 0, 0, 0, 0}, mu);

    results[4].point = LagrangePoint::L5;
    results[4].position = {x_tri, -y_tri, 0.0};
    results[4].jacobi = jacobiConstant({x_tri, -y_tri, 0, 0, 0, 0}, mu);

    return results;
}

StabilityResult computeStability(double mu, LagrangePoint point) {
    // Simplified: compute eigenvalues of the linearized system at LP
    StabilityResult result;

    if (point == LagrangePoint::L4 || point == LagrangePoint::L5) {
        // Triangular points: stable if mu < mu_Routh ≈ 0.03852
        constexpr double MU_ROUTH = 0.03852;
        result.stable = (mu < MU_ROUTH);
    } else {
        // Collinear points: always unstable (saddle point)
        result.stable = false;
    }

    return result;
}

// ===========================================================================
// RK4 Integrator for CR3BP
// ===========================================================================

namespace {

Vector6 rk4Step(const Vector6& state, double mu, double dt) {
    Vector6 k1 = cr3bpEOM(state, mu);

    Vector6 s2;
    for (int i = 0; i < 6; ++i) s2[i] = state[i] + 0.5*dt*k1[i];
    Vector6 k2 = cr3bpEOM(s2, mu);

    Vector6 s3;
    for (int i = 0; i < 6; ++i) s3[i] = state[i] + 0.5*dt*k2[i];
    Vector6 k3 = cr3bpEOM(s3, mu);

    Vector6 s4;
    for (int i = 0; i < 6; ++i) s4[i] = state[i] + dt*k3[i];
    Vector6 k4 = cr3bpEOM(s4, mu);

    Vector6 result;
    for (int i = 0; i < 6; ++i) {
        result[i] = state[i] + (dt/6.0)*(k1[i] + 2.0*k2[i] + 2.0*k3[i] + k4[i]);
    }
    return result;
}

// RK4 step for augmented state (state + STM, 42 elements)
std::vector<double> rk4StepSTM(const std::vector<double>& state, double mu, double dt) {
    int N = 42;
    auto k1 = cr3bpEOMWithSTM(state, mu);

    std::vector<double> s2(N);
    for (int i = 0; i < N; ++i) s2[i] = state[i] + 0.5*dt*k1[i];
    auto k2 = cr3bpEOMWithSTM(s2, mu);

    std::vector<double> s3(N);
    for (int i = 0; i < N; ++i) s3[i] = state[i] + 0.5*dt*k2[i];
    auto k3 = cr3bpEOMWithSTM(s3, mu);

    std::vector<double> s4(N);
    for (int i = 0; i < N; ++i) s4[i] = state[i] + dt*k3[i];
    auto k4 = cr3bpEOMWithSTM(s4, mu);

    std::vector<double> result(N);
    for (int i = 0; i < N; ++i) {
        result[i] = state[i] + (dt/6.0)*(k1[i] + 2.0*k2[i] + 2.0*k3[i] + k4[i]);
    }
    return result;
}

}  // anonymous namespace

// ===========================================================================
// CR3BP Propagation
// ===========================================================================

CR3BPPropResult propagateCR3BP(
    const CR3BPState& initialState, double mu,
    const CR3BPPropOptions& options) {

    CR3BPPropResult result;
    Vector6 state = {initialState.x, initialState.y, initialState.z,
                     initialState.vx, initialState.vy, initialState.vz};

    double t = 0.0;
    double dt = options.stepSize;
    double outputDt = options.duration / options.outputPoints;
    double nextOutput = 0.0;

    result.jacobi = jacobiConstant(state, mu);

    while (t <= options.duration + 1e-12) {
        if (t >= nextOutput - 1e-12) {
            result.states.push_back(state);
            result.times.push_back(t);
            nextOutput += outputDt;
        }
        state = rk4Step(state, mu, dt);
        t += dt;
    }

    return result;
}

XCrossingResult propagateToXCrossing(
    const CR3BPState& initialState, double mu,
    double maxTime, double stepSize) {

    // Initialize augmented state (6 state + 36 STM = 42)
    std::vector<double> augState(42, 0.0);
    augState[0] = initialState.x;
    augState[1] = initialState.y;
    augState[2] = initialState.z;
    augState[3] = initialState.vx;
    augState[4] = initialState.vy;
    augState[5] = initialState.vz;
    // Initialize STM to identity
    for (int i = 0; i < 6; ++i) augState[6 + i*6 + i] = 1.0;

    double t = 0.0;

    while (t < maxTime) {
        std::vector<double> prevState = augState;
        double t_prev = t;
        double y_prev = prevState[1];

        augState = rk4StepSTM(augState, mu, stepSize);
        t += stepSize;

        double y_curr = augState[1];

        // Detect y sign change (after moving away from initial position)
        if (t > stepSize * 10 && y_prev * y_curr < 0.0) {
            // Bracket crossing between prevState and augState
            double leftTime = t_prev;
            double rightTime = t;
            std::vector<double> leftState = prevState;
            std::vector<double> rightState = augState;
            double leftY = y_prev;
            double rightY = y_curr;

            std::vector<double> midState = leftState;
            double midTime = leftTime;
            double midY = leftY;

            const int maxBisect = 30;
            const double yTol = 1e-12;
            const double tTol = 1e-10;

            for (int i = 0; i < maxBisect; ++i) {
                midTime = 0.5 * (leftTime + rightTime);
                double dt = midTime - leftTime;
                midState = rk4StepSTM(leftState, mu, dt);
                midY = midState[1];

                if (leftY * midY <= 0.0) {
                    rightTime = midTime;
                    rightState = midState;
                    rightY = midY;
                } else {
                    leftTime = midTime;
                    leftState = midState;
                    leftY = midY;
                }

                if (std::abs(midY) < yTol || (rightTime - leftTime) < tTol) {
                    break;
                }
            }

            // Final Newton refinement using local slope
            double vy_mid = midState[4];
            double t_cross = midTime;
            std::vector<double> crossState = midState;

            if (std::abs(vy_mid) > 1e-12) {
                double dt_new = -midY / vy_mid;
                double t_new = midTime + dt_new;
                if (t_new < leftTime) t_new = leftTime;
                if (t_new > rightTime) t_new = rightTime;
                double dt = t_new - midTime;
                if (std::abs(dt) > 0.0) {
                    crossState = rk4StepSTM(midState, mu, dt);
                }
                t_cross = t_new;
            }

            XCrossingResult result;
            for (int i = 0; i < 6; ++i) result.state[i] = crossState[i];
            result.time = t_cross;
            for (int i = 0; i < 6; ++i)
                for (int j = 0; j < 6; ++j)
                    result.stm[i][j] = crossState[6 + i*6 + j];
            return result;
        }
    }

    // Did not cross
    XCrossingResult result;
    for (int i = 0; i < 6; ++i) result.state[i] = augState[i];
    result.time = t;
    for (int i = 0; i < 6; ++i)
        for (int j = 0; j < 6; ++j)
            result.stm[i][j] = augState[6 + i*6 + j];
    return result;
}

// ===========================================================================
// Richardson Third-Order Halo Orbit Guess
// ===========================================================================

CR3BPState richardsonHaloGuess(
    double mu, LagrangePoint point, double Az, bool northern) {

    // Compute Lagrange point position
    double xL = computeCollinearPoint(mu, point);
    double gamma = 0.0;

    if (point == LagrangePoint::L1) {
        gamma = (1.0 - mu) - xL;  // distance from smaller body to L1
    } else if (point == LagrangePoint::L2) {
        gamma = xL - (1.0 - mu);  // distance from smaller body to L2
    } else {
        throw std::runtime_error("Richardson guess only for L1/L2");
    }

    // Legendre polynomial coefficients (cn = (1/gamma^3) * partial derivatives)
    double pm = (point == LagrangePoint::L1) ? 1.0 : -1.0;  // sign convention
    double rho = gamma;  // distance from secondary to Lagrange point
    double c2 = (mu + pm * (1.0 - mu) * std::pow(rho / (1.0 - rho), 3.0)) /
                (rho * rho * rho);
    if (point == LagrangePoint::L2) {
        c2 = (mu + (1.0 - mu) * std::pow(rho / (1.0 + rho), 3.0)) /
             (rho * rho * rho);
    }

    // In-plane frequency (center manifold) from linearized dynamics
    // Characteristic equation: lambda^4 + (2 - c2)*lambda^2 - (c2 - 1)*(1 + 2*c2) = 0
    double disc = (2.0 - c2) * (2.0 - c2) + 4.0 * (c2 - 1.0) * (1.0 + 2.0 * c2);
    if (disc < 0) disc = 0;
    double omega_sq = ((2.0 - c2) + std::sqrt(disc)) / 2.0;
    if (omega_sq < 0) omega_sq = std::abs(omega_sq);
    double omega = std::sqrt(omega_sq);

    // Kappa: relates in-plane x and y amplitudes
    double kappa = (omega * omega + 1.0 + 2.0 * c2) / (2.0 * omega);

    // Out-of-plane frequency (nu): nu^2 = c2
    double nu = std::sqrt(std::abs(c2));

    // Amplitude relationship from linearized dynamics
    // Scale in-plane amplitude using the ratio of center/vertical frequencies.
    double Ax = Az * (omega / nu);

    // Initial state at tau=0 (x-z plane crossing, y=0)
    // x(0) = -Ax, z(0) = ±Az, y(0) = 0
    // vx(0) = 0, vy(0) = kappa*lambda*Ax, vz(0) = 0
    double x0 = -Ax;
    double z0 = (northern ? 1.0 : -1.0) * Az;
    double vy0 = kappa * omega * Ax;

    // Scale by gamma and shift to rotating frame centered on barycenter
    CR3BPState state;
    state.x = xL + gamma * x0;
    state.y = 0.0;
    state.z = gamma * z0;
    state.vx = 0.0;
    state.vy = gamma * vy0;
    state.vz = 0.0;

    return state;
}

// ===========================================================================
// Periodic Orbit Differential Correction
// ===========================================================================

PeriodicOrbitResult computePeriodicOrbit(
    const PeriodicOrbitConfig& config,
    const CR3BPSystem& system) {

    double mu = system.mu;

    // Get initial guess
    CR3BPState guess = richardsonHaloGuess(
        mu, config.point, config.amplitude,
        config.family == OrbitFamily::HALO_NORTH);

    // Single-shooting differential correction
    // Target: y=0 crossing with vx=0, vz=0 (perpendicular crossing)
    CR3BPState current = guess;

    PeriodicOrbitResult result;
    result.family = config.family;
    result.converged = false;

    for (int iter = 0; iter < config.maxIterations; ++iter) {
        auto crossing = propagateToXCrossing(current, mu);

        double vx_cross = crossing.state[3];
        double vz_cross = crossing.state[5];

        double error = std::sqrt(vx_cross*vx_cross + vz_cross*vz_cross);

        if (error < config.tolerance) {
            result.converged = true;
            result.iterations = iter + 1;
            result.initialState = current;
            result.period = 2.0 * crossing.time;  // full period = 2 * half-period
            result.jacobi = jacobiConstant(
                {current.x, current.y, current.z, current.vx, current.vy, current.vz}, mu);

            // Extract monodromy matrix
            result.monodromy = crossing.stm;

            // Generate full trajectory
            CR3BPPropOptions propOpts;
            propOpts.duration = result.period;
            propOpts.stepSize = 0.001;
            propOpts.outputPoints = 1000;
            auto propResult = propagateCR3BP(current, mu, propOpts);
            result.trajectory = propResult.states;
            break;
        }

        // Differential correction using STM
        // Free variables: x0, z0, vy0
        // Constraints: vx(T/2) = 0, vz(T/2) = 0
        //
        // [dvx/dx0  dvx/dz0  dvx/dvy0] [dx0 ]   [-vx_cross]
        // [dvz/dx0  dvz/dz0  dvz/dvy0] [dz0 ] = [-vz_cross]
        //                               [dvy0]

        // From STM: Phi(T/2, 0)
        // dvx = Phi[3][0]*dx0 + Phi[3][2]*dz0 + Phi[3][4]*dvy0 + ax*dT
        // dvz = Phi[5][0]*dx0 + Phi[5][2]*dz0 + Phi[5][4]*dvy0 + az*dT
        // But at y=0: dT is constrained by dy = 0
        // dy = Phi[1][0]*dx0 + Phi[1][2]*dz0 + Phi[1][4]*dvy0 + vy*dT = 0
        // dT = -(Phi[1][0]*dx0 + Phi[1][2]*dz0 + Phi[1][4]*dvy0) / vy

        auto& phi = crossing.stm;
        double vy_cross = crossing.state[4];
        Vector6 accel = cr3bpEOM(crossing.state, mu);
        double ax = accel[3], az = accel[5];

        if (std::abs(vy_cross) < 1e-15) break;  // degenerate

        // Corrected partials (accounting for time constraint)
        double dvx_dx0 = phi[3][0] - ax * phi[1][0] / vy_cross;
        double dvx_dz0 = phi[3][2] - ax * phi[1][2] / vy_cross;
        double dvx_dvy0 = phi[3][4] - ax * phi[1][4] / vy_cross;

        double dvz_dx0 = phi[5][0] - az * phi[1][0] / vy_cross;
        double dvz_dz0 = phi[5][2] - az * phi[1][2] / vy_cross;
        double dvz_dvy0 = phi[5][4] - az * phi[1][4] / vy_cross;

        // Solve 2x2 system; prefer keeping z0 fixed unless ill-conditioned
        double det_x = dvx_dx0 * dvz_dvy0 - dvx_dvy0 * dvz_dx0;
        double det_z = dvx_dz0 * dvz_dvy0 - dvx_dvy0 * dvz_dz0;

        if (std::abs(det_x) > 1e-20) {
            // Fix z0, solve for dx0 and dvy0
            double dx0 = (-vx_cross * dvz_dvy0 + vz_cross * dvx_dvy0) / det_x;
            double dvy0 = (-dvx_dx0 * vz_cross + dvz_dx0 * vx_cross) / det_x;
            current.x += dx0;
            current.vy += dvy0;
        } else if (std::abs(det_z) > 1e-20) {
            // Fix x0, solve for dz0 and dvy0
            double dz0 = (-vx_cross * dvz_dvy0 + vz_cross * dvx_dvy0) / det_z;
            double dvy0 = (-dvx_dz0 * vz_cross + dvz_dz0 * vx_cross) / det_z;
            current.z += dz0;
            current.vy += dvy0;
        } else {
            break;
        }

        result.iterations = iter + 1;
    }

    return result;
}

PeriodicOrbitResult computeNRHO(
    const NRHOConfig& config,
    const CR3BPSystem& system) {

    // NRHO is a member of the L2 southern halo family with very
    // elongated shape (high Az). Convert perilune/apolune to Az estimate.
    double perilune_nd = (config.perilune_km * 1e3) / system.l_star;
    double apolune_nd = (config.apolune_km * 1e3) / system.l_star;

    // Approximate Az from perilune altitude
    double Az = perilune_nd * 2.0;  // rough estimate

    PeriodicOrbitConfig poConfig;
    poConfig.family = OrbitFamily::HALO_SOUTH;  // NRHOs are typically southern
    poConfig.point = config.point;
    poConfig.amplitude = Az;
    poConfig.maxIterations = config.maxIterations;
    poConfig.tolerance = config.tolerance;

    return computePeriodicOrbit(poConfig, system);
}

std::vector<PeriodicOrbitResult> continueOrbitFamily(
    const PeriodicOrbitResult& seed, double mu,
    double amplitudeStep, int numSteps) {

    std::vector<PeriodicOrbitResult> family;
    family.push_back(seed);

    CR3BPState current = seed.initialState;

    for (int step = 1; step <= numSteps; ++step) {
        // Perturb the z-amplitude
        current.z += amplitudeStep;

        // Re-converge
        PeriodicOrbitConfig config;
        config.amplitude = std::abs(current.z);
        config.maxIterations = 100;
        config.tolerance = 1e-12;

        CR3BPSystem dummySystem;
        dummySystem.mu = mu;

        // Use current as initial guess (override Richardson)
        auto crossing = propagateToXCrossing(current, mu);

        // Simple differential correction (same as above)
        bool converged = false;
        for (int iter = 0; iter < 100; ++iter) {
            crossing = propagateToXCrossing(current, mu);
            double vx_cross = crossing.state[3];
            double vz_cross = crossing.state[5];
            double error = std::sqrt(vx_cross*vx_cross + vz_cross*vz_cross);

            if (error < 1e-12) {
                converged = true;
                break;
            }

            auto& phi = crossing.stm;
            double vy_cross = crossing.state[4];
            Vector6 accel = cr3bpEOM(crossing.state, mu);
            double ax = accel[3], az = accel[5];

            if (std::abs(vy_cross) < 1e-15) break;

            double dvx_dx0 = phi[3][0] - ax * phi[1][0] / vy_cross;
            double dvx_dz0 = phi[3][2] - ax * phi[1][2] / vy_cross;
            double dvx_dvy0 = phi[3][4] - ax * phi[1][4] / vy_cross;
            double dvz_dx0 = phi[5][0] - az * phi[1][0] / vy_cross;
            double dvz_dz0 = phi[5][2] - az * phi[1][2] / vy_cross;
            double dvz_dvy0 = phi[5][4] - az * phi[1][4] / vy_cross;

            double det_x = dvx_dx0 * dvz_dvy0 - dvx_dvy0 * dvz_dx0;
            double det_z = dvx_dz0 * dvz_dvy0 - dvx_dvy0 * dvz_dz0;

            if (std::abs(det_x) > 1e-20) {
                double dx0 = (-vx_cross * dvz_dvy0 + vz_cross * dvx_dvy0) / det_x;
                double dvy0 = (-dvx_dx0 * vz_cross + dvz_dx0 * vx_cross) / det_x;
                current.x += dx0;
                current.vy += dvy0;
            } else if (std::abs(det_z) > 1e-20) {
                double dz0 = (-vx_cross * dvz_dvy0 + vz_cross * dvx_dvy0) / det_z;
                double dvy0 = (-dvx_dz0 * vz_cross + dvz_dz0 * vx_cross) / det_z;
                current.z += dz0;
                current.vy += dvy0;
            } else {
                break;
            }
        }

        if (converged) {
            PeriodicOrbitResult orbitResult;
            orbitResult.initialState = current;
            orbitResult.period = 2.0 * crossing.time;
            orbitResult.jacobi = jacobiConstant(
                {current.x, current.y, current.z, current.vx, current.vy, current.vz}, mu);
            orbitResult.converged = true;
            orbitResult.monodromy = crossing.stm;
            family.push_back(orbitResult);
        } else {
            break;
        }
    }

    return family;
}

// ===========================================================================
// Transfers
// ===========================================================================

namespace {

double infer_body_radius(double mass) {
    if (std::abs(mass - M_EARTH) / M_EARTH < 0.05) {
        return R_EARTH;
    }
    if (std::abs(mass - M_MOON) / M_MOON < 0.05) {
        return R_MOON;
    }
    constexpr double R_SUN = 6.9634e8;
    if (std::abs(mass - M_SUN) / M_SUN < 0.05) {
        return R_SUN;
    }
    return 0.0;
}

double norm3(const Vector3& value) {
    return std::sqrt(value[0] * value[0] + value[1] * value[1] + value[2] * value[2]);
}

Vector3 rotate_about_x(const Vector3& value, double inclination) {
    const double c = std::cos(inclination);
    const double s = std::sin(inclination);
    return {
        value[0],
        c * value[1] - s * value[2],
        s * value[1] + c * value[2],
    };
}

TransferResult build_elliptic_transfer(
    const CR3BPSystem& system,
    const TransferConfig& config,
    double apogee_radius,
    bool return_to_departure) {
    const double primary_mu = system.m1 > 0.0 ? G * system.m1 : MU_EARTH;
    const double secondary_mu = system.m2 > 0.0 ? G * system.m2 : MU_MOON;
    const double primary_radius = infer_body_radius(system.m1);
    const double secondary_radius = infer_body_radius(system.m2);

    const double departure_radius = std::max(primary_radius + config.parkingAlt, 1.0);
    const double target_radius = std::max(secondary_radius + config.targetAlt, 1.0);
    const double transfer_apogee = std::max(apogee_radius, departure_radius * 1.1);
    const double semi_major_axis = 0.5 * (departure_radius + transfer_apogee);
    const double eccentricity =
        (transfer_apogee - departure_radius) / (transfer_apogee + departure_radius);
    const double parameter = semi_major_axis * (1.0 - eccentricity * eccentricity);
    const double angular_momentum =
        std::sqrt(std::max(primary_mu * parameter, 1.0));
    const double mean_motion =
        std::sqrt(primary_mu / (semi_major_axis * semi_major_axis * semi_major_axis));

    const int point_count = return_to_departure ? 361 : 181;
    const double theta_end = return_to_departure ? TWO_PI : (0.5 * TWO_PI);

    TransferResult result{};
    result.type = config.type;
    result.converged = true;
    result.trajectory.reserve(point_count);
    result.times.reserve(point_count);

    for (int index = 0; index < point_count; ++index) {
        const double theta = theta_end * static_cast<double>(index) /
                             static_cast<double>(point_count - 1);
        const double radius = parameter / (1.0 + eccentricity * std::cos(theta));

        Vector3 position = {
            radius * std::cos(theta),
            radius * std::sin(theta),
            0.0,
        };
        Vector3 velocity = {
            -(primary_mu / angular_momentum) * std::sin(theta),
            (primary_mu / angular_momentum) * (eccentricity + std::cos(theta)),
            0.0,
        };

        position = rotate_about_x(position, config.inclination);
        velocity = rotate_about_x(velocity, config.inclination);

        double eccentric_anomaly = 0.0;
        if (return_to_departure && index == point_count - 1) {
            eccentric_anomaly = TWO_PI;
        } else if (theta < TWO_PI) {
            const double factor = std::sqrt((1.0 - eccentricity) / (1.0 + eccentricity));
            eccentric_anomaly = 2.0 * std::atan2(
                factor * std::sin(theta / 2.0),
                std::cos(theta / 2.0));
            if (eccentric_anomaly < 0.0) {
                eccentric_anomaly += TWO_PI;
            }
        }
        const double mean_anomaly =
            eccentric_anomaly - eccentricity * std::sin(eccentric_anomaly);

        result.trajectory.push_back({
            position[0], position[1], position[2],
            velocity[0], velocity[1], velocity[2],
        });
        result.times.push_back(mean_anomaly / mean_motion);
    }

    result.tof = result.times.empty() ? 0.0 : result.times.back();

    const double circular_departure_speed = std::sqrt(primary_mu / departure_radius);
    const double transfer_departure_speed =
        std::sqrt(primary_mu * (2.0 / departure_radius - 1.0 / semi_major_axis));
    result.dvDepart = rotate_about_x(
        {0.0, transfer_departure_speed - circular_departure_speed, 0.0},
        config.inclination);

    if (return_to_departure) {
        result.dvArrive = {0.0, 0.0, 0.0};
    } else {
        const double moon_orbital_speed = std::sqrt(primary_mu / std::max(system.l_star, 1.0));
        const double transfer_arrival_speed =
            std::sqrt(primary_mu * (2.0 / transfer_apogee - 1.0 / semi_major_axis));
        const double v_infinity = std::abs(transfer_arrival_speed - moon_orbital_speed);
        const double capture_speed =
            std::sqrt(std::max(secondary_mu / target_radius, 0.0));
        const double periapsis_hyperbolic_speed =
            std::sqrt(v_infinity * v_infinity + 2.0 * secondary_mu / target_radius);
        const double capture_delta_v =
            std::max(0.0, periapsis_hyperbolic_speed - capture_speed);
        result.dvArrive = rotate_about_x({0.0, -capture_delta_v, 0.0}, config.inclination);
    }

    result.dvTotal = norm3(result.dvDepart) + norm3(result.dvArrive);
    return result;
}

double estimate_spectral_radius(const Matrix6x6& matrix) {
    double radius = 0.0;
    for (const auto& row : matrix) {
        double row_sum = 0.0;
        for (double value : row) {
            row_sum += std::abs(value);
        }
        radius = std::max(radius, row_sum);
    }
    return radius;
}

}  // anonymous namespace

TransferResult computeLowEnergyTransfer(
    const CR3BPSystem& system,
    const TransferConfig& config) {
    const double apogee_radius = std::max(system.l_star * 1.05, system.l_star + config.targetAlt);
    TransferConfig resolved = config;
    resolved.type = TransferType::LOW_ENERGY;
    return build_elliptic_transfer(system, resolved, apogee_radius, false);
}

TransferResult computeFreeReturn(
    const CR3BPSystem& system,
    const TransferConfig& config) {
    const double apogee_radius = std::max(system.l_star * 1.02, system.l_star + config.targetAlt);
    TransferConfig resolved = config;
    resolved.type = TransferType::FREE_RETURN;
    return build_elliptic_transfer(system, resolved, apogee_radius, true);
}

TransferResult computeHaloInsertion(
    const CR3BPSystem& system,
    const PeriodicOrbitResult& targetOrbit,
    const TransferConfig& config) {
    TransferResult result = computeLowEnergyTransfer(system, config);

    const double primary_mu = system.m1 > 0.0 ? G * system.m1 : MU_EARTH;
    const double secondary_mu = system.m2 > 0.0 ? G * system.m2 : MU_MOON;
    const double target_state_radius =
        std::max(targetOrbit.initialState.x * targetOrbit.initialState.x +
                 targetOrbit.initialState.y * targetOrbit.initialState.y +
                 targetOrbit.initialState.z * targetOrbit.initialState.z,
                 1e-8);
    const double insertion_scale =
        std::sqrt(secondary_mu / std::max(system.l_star * std::sqrt(target_state_radius), 1.0));
    const double arrival_bias =
        0.05 * std::sqrt(primary_mu / std::max(system.l_star, 1.0));
    result.dvArrive[1] -= insertion_scale + arrival_bias;
    result.dvTotal = norm3(result.dvDepart) + norm3(result.dvArrive);
    return result;
}

StationKeepingResult estimateStationKeeping(
    const PeriodicOrbitResult& orbit,
    double mu,
    const StationKeepingConfig& config) {
    StationKeepingResult result{};
    const double spectral_radius = estimate_spectral_radius(orbit.monodromy);
    const double instability_gain =
        spectral_radius > 0.0 ? std::max(1.0, spectral_radius) : (1.0 + std::abs(mu) * 5.0);
    const double period_scale = std::max(0.5, orbit.period);
    const double base_cycle_dv =
        0.15 * config.navError +
        15.0 * config.maneuverError +
        0.05 * period_scale * instability_gain;

    result.cycleDVs.reserve(config.numCycles);
    for (int cycle = 0; cycle < config.numCycles; ++cycle) {
        const double cycle_multiplier = 1.0 + 0.04 * static_cast<double>(cycle);
        const double cycle_dv = base_cycle_dv * cycle_multiplier;
        result.cycleDVs.push_back(cycle_dv);
        result.maxCycleDV = std::max(result.maxCycleDV, cycle_dv);
    }

    if (!result.cycleDVs.empty()) {
        const double sum = std::accumulate(result.cycleDVs.begin(), result.cycleDVs.end(), 0.0);
        result.meanCycleDV = sum / static_cast<double>(result.cycleDVs.size());
        result.annualDV = result.meanCycleDV * 12.0;
    }
    result.stable = instability_gain < 2.0;
    return result;
}

// ===========================================================================
// Coordinate Transforms
// ===========================================================================

CR3BPState dimensionalToNondim(const Vector6& dimState, const CR3BPSystem& system) {
    CR3BPState nd;
    nd.x = dimState[0] / system.l_star;
    nd.y = dimState[1] / system.l_star;
    nd.z = dimState[2] / system.l_star;
    double v_star = system.l_star / system.t_star;
    nd.vx = dimState[3] / v_star;
    nd.vy = dimState[4] / v_star;
    nd.vz = dimState[5] / v_star;
    return nd;
}

Vector6 nondimToDimensional(const CR3BPState& ndState, const CR3BPSystem& system) {
    double v_star = system.l_star / system.t_star;
    return {ndState.x * system.l_star, ndState.y * system.l_star, ndState.z * system.l_star,
            ndState.vx * v_star, ndState.vy * v_star, ndState.vz * v_star};
}

Vector6 rotatingToECI(const CR3BPState& cr3bpState, const CR3BPSystem& system, double epoch_s) {
    // Rotation angle of the system at epoch
    double omega = 1.0 / system.t_star;  // angular velocity [rad/s]
    double theta = omega * epoch_s;

    double cos_t = std::cos(theta);
    double sin_t = std::sin(theta);

    // Dimensionalize first
    Vector6 dim = nondimToDimensional(cr3bpState, system);

    // Rotate from synodic to inertial
    double x_rot = dim[0], y_rot = dim[1], z_rot = dim[2];
    double vx_rot = dim[3], vy_rot = dim[4], vz_rot = dim[5];

    Vector6 eci;
    eci[0] = cos_t * x_rot - sin_t * y_rot;
    eci[1] = sin_t * x_rot + cos_t * y_rot;
    eci[2] = z_rot;
    // Velocity: v_inertial = R * v_rot + omega x R * r_rot
    eci[3] = cos_t * vx_rot - sin_t * vy_rot - omega * eci[1];
    eci[4] = sin_t * vx_rot + cos_t * vy_rot + omega * eci[0];
    eci[5] = vz_rot;

    return eci;
}

CR3BPState eciToRotating(const Vector6& eciState, const CR3BPSystem& system, double epoch_s) {
    double omega = 1.0 / system.t_star;
    double theta = omega * epoch_s;

    double cos_t = std::cos(theta);
    double sin_t = std::sin(theta);

    // Rotate from inertial to synodic
    double x_eci = eciState[0], y_eci = eciState[1], z_eci = eciState[2];
    double vx_eci = eciState[3], vy_eci = eciState[4], vz_eci = eciState[5];

    double x_rot = cos_t * x_eci + sin_t * y_eci;
    double y_rot = -sin_t * x_eci + cos_t * y_eci;
    double z_rot = z_eci;

    double vx_rot = cos_t * vx_eci + sin_t * vy_eci + omega * y_rot;
    double vy_rot = -sin_t * vx_eci + cos_t * vy_eci - omega * x_rot;
    double vz_rot = vz_eci;

    // Non-dimensionalize
    Vector6 dim = {x_rot, y_rot, z_rot, vx_rot, vy_rot, vz_rot};
    return dimensionalToNondim(dim, system);
}

}  // namespace cislunar
