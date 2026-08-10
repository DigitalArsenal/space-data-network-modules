#include "maneuver/rendezvous.h"

#include "maneuver/constants.h"
#include "maneuver/math.h"

#include <cmath>

namespace maneuver {

namespace {

// `dot3` and `cross3` used to live here as file-local copies of the same four
// lines that classical.cpp needed too. They are in maneuver/math.h now, beside
// `norm3`/`add3`/`sub3` where a reader looks for them, and the amalgamated
// translation unit the shipped artifact is built from carries ONE definition
// instead of two identical ones in the same anonymous namespace.

Vector3 scale3(const Vector3& v, double s) {
    return {v[0] * s, v[1] * s, v[2] * s};
}

Vector3 unit3(const Vector3& v) {
    const double m = norm3(v);
    return {v[0] / m, v[1] / m, v[2] / m};
}

/// Solve A x = b for a 3x3 system by Cramer's rule; false when |det| is
/// below tol relative to the matrix scale.
bool solve3(const Matrix3x3& A, const Vector3& b, Vector3& x) {
    const double det =
        A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) -
        A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) +
        A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
    // A healthy system has |det| commensurate with its largest entry cubed;
    // a near-singular CW transfer (t near a full period) collapses orders of
    // magnitude below that.
    double scale = 0.0;
    for (const auto& row : A) {
        for (double v : row) {
            scale = std::max(scale, std::abs(v));
        }
    }
    if (std::abs(det) < 1e-12 * scale * scale * scale + 1e-300) {
        return false;
    }
    Matrix3x3 M = A;
    for (int col = 0; col < 3; ++col) {
        for (int row = 0; row < 3; ++row) {
            M[row][col] = b[row];
        }
        x[col] =
            (M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) -
             M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) +
             M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0])) / det;
        for (int row = 0; row < 3; ++row) {
            M[row][col] = A[row][col];
        }
    }
    return true;
}

// ---- LVLH frame (RTN) from target inertial state ----
// x = radial (unit r), z = orbit normal direction is N; axes ordered so the
// LVLH state matches the module's RIC convention: [radial, along-track,
// cross-track].
struct LvlhBasis {
    Vector3 R{}, T{}, N{};
    double omega = 0.0;  // instantaneous orbital rate |r x v| / r^2
};

LvlhBasis lvlhBasis(const Vector3& rc, const Vector3& vc) {
    LvlhBasis basis;
    basis.R = unit3(rc);
    const Vector3 h = cross3(rc, vc);
    basis.N = unit3(h);
    basis.T = cross3(basis.N, basis.R);
    basis.omega = norm3(h) / dot3(rc, rc);
    return basis;
}

/// Inertial target/chaser states -> chaser LVLH relative state.
/// The rotating-frame velocity removes the omega x r transport term.
RelativeState rvToLvlh(
    const Vector3& rTarget, const Vector3& vTarget,
    const Vector3& rChaser, const Vector3& vChaser) {
    const LvlhBasis basis = lvlhBasis(rTarget, vTarget);
    const Vector3 dr = sub3(rChaser, rTarget);
    const Vector3 dv = sub3(vChaser, vTarget);
    const Vector3 w = scale3(basis.N, basis.omega);
    const Vector3 dvRot = sub3(dv, cross3(w, dr));
    RelativeState state;
    state.position = {dot3(dr, basis.R), dot3(dr, basis.T), dot3(dr, basis.N)};
    state.velocity = {dot3(dvRot, basis.R), dot3(dvRot, basis.T),
                      dot3(dvRot, basis.N)};
    return state;
}

/// LVLH relative state -> inertial relative position/velocity offsets
void lvlhToRv(
    const Vector3& rTarget, const Vector3& vTarget,
    const RelativeState& state, Vector3& dr, Vector3& dv) {
    const LvlhBasis basis = lvlhBasis(rTarget, vTarget);
    dr = add3(add3(scale3(basis.R, state.position[0]),
                   scale3(basis.T, state.position[1])),
              scale3(basis.N, state.position[2]));
    const Vector3 dvRot = add3(add3(scale3(basis.R, state.velocity[0]),
                                    scale3(basis.T, state.velocity[1])),
                               scale3(basis.N, state.velocity[2]));
    const Vector3 w = scale3(basis.N, basis.omega);
    dv = add3(dvRot, cross3(w, dr));
}

/// Classical elements -> inertial position/velocity (two-body geometry)
void coeToRv(const ClassicalOrbitalElements& coe, Vector3& r, Vector3& v) {
    const double a = coe.semiMajorAxis;
    const double e = coe.eccentricity;
    const double mu = coe.gravitationalParameter;
    double E = coe.meanAnomaly;
    for (int k = 0; k < 80; ++k) {
        const double d = (E - e * std::sin(E) - coe.meanAnomaly) /
                         (1.0 - e * std::cos(E));
        E -= d;
        if (std::abs(d) < 1e-14) {
            break;
        }
    }
    const double cosE = std::cos(E);
    const double sinE = std::sin(E);
    const double radius = a * (1.0 - e * cosE);
    const double sqrtOme2 = std::sqrt(1.0 - e * e);
    const Vector3 rPqw = {a * (cosE - e), a * sqrtOme2 * sinE, 0.0};
    const double vScale = std::sqrt(mu * a) / radius;
    const Vector3 vPqw = {-vScale * sinE, vScale * sqrtOme2 * cosE, 0.0};

    const double cO = std::cos(coe.raan), sO = std::sin(coe.raan);
    const double ci = std::cos(coe.inclination), si = std::sin(coe.inclination);
    const double cw = std::cos(coe.argumentOfPerigee);
    const double sw = std::sin(coe.argumentOfPerigee);
    const Matrix3x3 rot = {{
        {cO * cw - sO * sw * ci, -cO * sw - sO * cw * ci, sO * si},
        {sO * cw + cO * sw * ci, -sO * sw + cO * cw * ci, -cO * si},
        {sw * si, cw * si, ci},
    }};
    r = matMul3x3_3x1(rot, rPqw);
    v = matMul3x3_3x1(rot, vPqw);
}

/// Inertial gravity: two-body plus optional J2 zonal term
Vector3 gravityAccel(const Vector3& r, double mu, bool includeJ2) {
    const double rMag = norm3(r);
    const double r3 = rMag * rMag * rMag;
    Vector3 accel = scale3(r, -mu / r3);
    if (includeJ2) {
        const double coeff =
            1.5 * J2 * mu * R_EARTH * R_EARTH / (r3 * rMag * rMag);
        const double zr2 = (r[2] * r[2]) / (rMag * rMag);
        accel[0] += coeff * r[0] * (5.0 * zr2 - 1.0);
        accel[1] += coeff * r[1] * (5.0 * zr2 - 1.0);
        accel[2] += coeff * r[2] * (5.0 * zr2 - 3.0);
    }
    return accel;
}

/// Truth state layout: [rTarget, vTarget, rChaser, vChaser]
using TruthState = std::array<double, 12>;

TruthState truthDerivative(
    const TruthState& y, const Vector3& controlInertial,
    double mu, bool includeJ2) {
    const Vector3 rt = {y[0], y[1], y[2]};
    const Vector3 rc = {y[6], y[7], y[8]};
    const Vector3 at = gravityAccel(rt, mu, includeJ2);
    Vector3 ac = gravityAccel(rc, mu, includeJ2);
    ac = add3(ac, controlInertial);
    return {y[3], y[4], y[5], at[0], at[1], at[2],
            y[9], y[10], y[11], ac[0], ac[1], ac[2]};
}

/// One RK4 step with the control acceleration held constant (ZOH)
TruthState rk4Step(
    const TruthState& y, double dt, const Vector3& controlInertial,
    double mu, bool includeJ2) {
    const auto k1 = truthDerivative(y, controlInertial, mu, includeJ2);
    TruthState tmp;
    for (int i = 0; i < 12; ++i) tmp[i] = y[i] + 0.5 * dt * k1[i];
    const auto k2 = truthDerivative(tmp, controlInertial, mu, includeJ2);
    for (int i = 0; i < 12; ++i) tmp[i] = y[i] + 0.5 * dt * k2[i];
    const auto k3 = truthDerivative(tmp, controlInertial, mu, includeJ2);
    for (int i = 0; i < 12; ++i) tmp[i] = y[i] + dt * k3[i];
    const auto k4 = truthDerivative(tmp, controlInertial, mu, includeJ2);
    TruthState out;
    for (int i = 0; i < 12; ++i) {
        out[i] = y[i] + dt / 6.0 * (k1[i] + 2.0 * k2[i] + 2.0 * k3[i] + k4[i]);
    }
    return out;
}

RendezvousResult errorResult(const std::string& message) {
    RendezvousResult result;
    result.valid = false;
    result.message = message;
    return result;
}

}  // namespace

STM6 computeCWSTM(double n, double t) {
    const double nt = n * t;
    const double s = std::sin(nt);
    const double c = std::cos(nt);
    STM6 stm{};
    stm[0][0] = 4.0 - 3.0 * c;
    stm[0][3] = s / n;
    stm[0][4] = 2.0 * (1.0 - c) / n;
    stm[1][0] = 6.0 * (s - nt);
    stm[1][1] = 1.0;
    stm[1][3] = -2.0 * (1.0 - c) / n;
    stm[1][4] = (4.0 * s - 3.0 * nt) / n;
    stm[2][2] = c;
    stm[2][5] = s / n;
    stm[3][0] = 3.0 * n * s;
    stm[3][3] = c;
    stm[3][4] = 2.0 * s;
    stm[4][0] = -6.0 * n * (1.0 - c);
    stm[4][3] = -2.0 * s;
    stm[4][4] = 4.0 * c - 3.0;
    stm[5][2] = -n * s;
    stm[5][5] = c;
    return stm;
}

RelativeState propagateCW(const RelativeState& state, double n, double t) {
    const STM6 stm = computeCWSTM(n, t);
    const std::array<double, 6> x = {
        state.position[0], state.position[1], state.position[2],
        state.velocity[0], state.velocity[1], state.velocity[2],
    };
    std::array<double, 6> out{};
    for (int row = 0; row < 6; ++row) {
        double sum = 0.0;
        for (int col = 0; col < 6; ++col) {
            sum += stm[row][col] * x[col];
        }
        out[row] = sum;
    }
    RelativeState result;
    result.position = {out[0], out[1], out[2]};
    result.velocity = {out[3], out[4], out[5]};
    return result;
}

Vector3 hcwAcceleration(const RelativeState& state, double n) {
    return {
        3.0 * n * n * state.position[0] + 2.0 * n * state.velocity[1],
        -2.0 * n * state.velocity[0],
        -n * n * state.position[2],
    };
}

bool solveCWInitialVelocity(
    const Vector3& r0, const Vector3& rf, double n, double t, Vector3& v0) {
    const STM6 stm = computeCWSTM(n, t);
    Matrix3x3 phiRv{};
    Matrix3x3 phiRr{};
    for (int row = 0; row < 3; ++row) {
        for (int col = 0; col < 3; ++col) {
            phiRr[row][col] = stm[row][col];
            phiRv[row][col] = stm[row][col + 3];
        }
    }
    const Vector3 drift = matMul3x3_3x1(phiRr, r0);
    const Vector3 rhs = sub3(rf, drift);
    return solve3(phiRv, rhs, v0);
}

QuinticSegment buildQuinticBrake(
    const RelativeState& handoff,
    const Vector3& handoffAccel,
    const Vector3& holdPoint,
    double duration) {
    QuinticSegment segment;
    segment.duration = duration;
    const double T = duration;
    // Solve in normalized time s = t/T so the terminal-condition system is
    // the constant matrix [[1,1,1],[3,4,5],[6,12,20]] (det = 2) regardless of
    // duration; its inverse is (1/2)[[20,-8,1],[-30,14,-2],[12,-6,1]].
    const Matrix3x3 inv = {{
        {10.0, -4.0, 0.5},
        {-15.0, 7.0, -1.0},
        {6.0, -3.0, 0.5},
    }};
    const double T2 = T * T, T3 = T2 * T, T4 = T3 * T, T5 = T4 * T;
    for (int axis = 0; axis < 3; ++axis) {
        const double p0 = handoff.position[axis];
        const double v0 = handoff.velocity[axis];
        const double a0 = handoffAccel[axis];
        const double q1 = v0 * T;
        const double q2 = 0.5 * a0 * T2;
        const Vector3 rhs = {
            holdPoint[axis] - (p0 + q1 + q2),
            -(q1 + 2.0 * q2),
            -2.0 * q2,
        };
        const Vector3 b = matMul3x3_3x1(inv, rhs);
        segment.coeffs[axis] = {p0, v0, 0.5 * a0,
                                b[0] / T3, b[1] / T4, b[2] / T5};
    }
    return segment;
}

ReferenceState evaluateQuintic(const QuinticSegment& segment, double tau) {
    const double t = std::min(std::max(tau, 0.0), segment.duration);
    ReferenceState ref;
    ref.phase = RendezvousPhase::BRAKE;
    for (int axis = 0; axis < 3; ++axis) {
        const auto& c = segment.coeffs[axis];
        ref.position[axis] =
            c[0] + t * (c[1] + t * (c[2] + t * (c[3] + t * (c[4] + t * c[5]))));
        ref.velocity[axis] =
            c[1] + t * (2.0 * c[2] +
                        t * (3.0 * c[3] + t * (4.0 * c[4] + t * 5.0 * c[5])));
        ref.acceleration[axis] =
            2.0 * c[2] + t * (6.0 * c[3] + t * (12.0 * c[4] + t * 20.0 * c[5]));
    }
    return ref;
}

ReferenceState rendezvousReference(
    const RendezvousConfig& config,
    const RelativeState& initialState,
    const QuinticSegment& brake,
    double n,
    double t) {
    ReferenceState ref;
    if (t < config.driftDuration) {
        const RelativeState state = propagateCW(initialState, n, t);
        ref.position = state.position;
        ref.velocity = state.velocity;
        ref.acceleration = hcwAcceleration(state, n);
        ref.phase = RendezvousPhase::DRIFT;
        return ref;
    }
    if (t <= config.driftDuration + config.brakeDuration) {
        return evaluateQuintic(brake, t - config.driftDuration);
    }
    ref.position = config.holdPoint;
    ref.velocity = {};
    ref.acceleration = {};
    ref.phase = RendezvousPhase::HOLD;
    return ref;
}

Vector3 rendezvousControl(
    const RendezvousConfig& config,
    const ReferenceState& reference,
    const RelativeState& actual,
    const Vector3& gainKp,
    const Vector3& gainKd,
    double n) {
    Vector3 u = config.useFeedforward ? reference.acceleration : Vector3{};
    if (config.compensateCoriolis) {
        u[0] -= 2.0 * n * actual.velocity[1];
        u[1] -= -2.0 * n * actual.velocity[0];
    }
    if (config.compensateGravityGradient) {
        u[0] -= 3.0 * n * n * actual.position[0];
        u[2] -= -n * n * actual.position[2];
    }
    for (int axis = 0; axis < 3; ++axis) {
        u[axis] += gainKp[axis] *
                       (reference.position[axis] - actual.position[axis]) +
                   gainKd[axis] *
                       (reference.velocity[axis] - actual.velocity[axis]);
    }
    return u;
}

RendezvousResult simulateRendezvous(
    const RendezvousConfig& config,
    const ClassicalOrbitalElements& chief) {
    if (chief.semiMajorAxis <= 0.0 || chief.gravitationalParameter <= 0.0) {
        return errorResult("Chief semi-major axis and mu must be positive.");
    }
    if (config.driftDuration <= 0.0 || config.brakeDuration <= 0.0) {
        return errorResult("driftDuration and brakeDuration must be positive.");
    }
    if (config.holdDuration < 0.0) {
        return errorResult("holdDuration must be non-negative.");
    }
    if (config.timeStep <= 0.0 ||
        config.timeStep > config.driftDuration ||
        config.timeStep > config.brakeDuration) {
        return errorResult(
            "timeStep must be positive and no larger than each segment.");
    }
    if (config.outputEvery < 1) {
        return errorResult("outputEvery must be >= 1.");
    }

    RendezvousResult result;
    const double mu = chief.gravitationalParameter;
    const double a = chief.semiMajorAxis;
    const double n = std::sqrt(mu / (a * a * a));
    result.meanMotion = n;

    // Resolve controller gains: explicit kp/kd win, otherwise derive from
    // bandwidth (default 10 n) and damping ratio.
    const double wn =
        config.controlBandwidth > 0.0 ? config.controlBandwidth : 10.0 * n;
    const double zeta = config.dampingRatio > 0.0 ? config.dampingRatio : 1.0;
    const double kp = config.kp > 0.0 ? config.kp : wn * wn;
    const double kd =
        config.kd > 0.0 ? config.kd : 2.0 * zeta * std::sqrt(kp);
    result.gainKp = {kp, kp, kp};
    result.gainKd = {kd, kd, kd};

    // Boundary conditions: combined-case drift leg initial velocity
    RelativeState initialState;
    initialState.position = config.initialPosition;
    initialState.velocity = config.initialVelocity;
    if (config.solveInitialVelocity) {
        Vector3 v0{};
        if (!solveCWInitialVelocity(
                config.initialPosition, config.brakePoint, n,
                config.driftDuration, v0)) {
            return errorResult(
                "CW transfer matrix is singular for this driftDuration "
                "(near an integer number of orbital periods); adjust it.");
        }
        initialState.velocity = v0;
    }
    result.solvedInitialVelocity = initialState.velocity;

    // Quintic braking segment from the drift handoff to the hold point
    const RelativeState handoff =
        propagateCW(initialState, n, config.driftDuration);
    const QuinticSegment brake = buildQuinticBrake(
        handoff, hcwAcceleration(handoff, n), config.holdPoint,
        config.brakeDuration);

    result.driftEnd = config.driftDuration;
    result.brakeEnd = config.driftDuration + config.brakeDuration;
    result.totalTime = result.brakeEnd + config.holdDuration;

    // Truth initial conditions in the inertial frame
    Vector3 rTarget{}, vTarget{};
    coeToRv(chief, rTarget, vTarget);
    Vector3 dr{}, dv{};
    lvlhToRv(rTarget, vTarget, initialState, dr, dv);
    TruthState y = {
        rTarget[0], rTarget[1], rTarget[2],
        vTarget[0], vTarget[1], vTarget[2],
        rTarget[0] + dr[0], rTarget[1] + dr[1], rTarget[2] + dr[2],
        vTarget[0] + dv[0], vTarget[1] + dv[1], vTarget[2] + dv[2],
    };

    const int steps =
        static_cast<int>(std::ceil(result.totalTime / config.timeStep));
    double sumSquaredError = 0.0;
    RendezvousMetrics& metrics = result.metrics;
    result.trajectory.reserve(
        static_cast<size_t>(steps / config.outputEvery) + 2);

    for (int step = 0; step <= steps; ++step) {
        const double t = std::min(step * config.timeStep, result.totalTime);
        const double dt =
            std::min(config.timeStep, result.totalTime - t);

        const Vector3 rt = {y[0], y[1], y[2]};
        const Vector3 vt = {y[3], y[4], y[5]};
        const Vector3 rc = {y[6], y[7], y[8]};
        const Vector3 vc = {y[9], y[10], y[11]};
        const RelativeState actual = rvToLvlh(rt, vt, rc, vc);
        const ReferenceState ref =
            rendezvousReference(config, initialState, brake, n, t);

        Vector3 u = rendezvousControl(
            config, ref, actual, result.gainKp, result.gainKd, n);
        double uMag = norm3(u);
        if (config.maxAccel > 0.0 && uMag > config.maxAccel) {
            u = scale3(u, config.maxAccel / uMag);
            uMag = config.maxAccel;
            ++metrics.saturatedSteps;
        }

        const double posError = norm3(sub3(ref.position, actual.position));
        const double velError = norm3(sub3(ref.velocity, actual.velocity));
        sumSquaredError += posError * posError;
        metrics.maxPositionError = std::max(metrics.maxPositionError, posError);
        metrics.maxControlAccel = std::max(metrics.maxControlAccel, uMag);
        switch (ref.phase) {
            case RendezvousPhase::DRIFT:
                metrics.maxPositionErrorDrift =
                    std::max(metrics.maxPositionErrorDrift, posError);
                break;
            case RendezvousPhase::BRAKE:
                metrics.maxPositionErrorBrake =
                    std::max(metrics.maxPositionErrorBrake, posError);
                break;
            case RendezvousPhase::HOLD:
                metrics.maxPositionErrorHold =
                    std::max(metrics.maxPositionErrorHold, posError);
                break;
        }

        if (step % config.outputEvery == 0 || step == steps) {
            RendezvousSample sample;
            sample.time = t;
            sample.phase = ref.phase;
            sample.position = actual.position;
            sample.velocity = actual.velocity;
            sample.referencePosition = ref.position;
            sample.referenceVelocity = ref.velocity;
            sample.referenceAcceleration = ref.acceleration;
            sample.controlAccel = u;
            sample.positionError = posError;
            sample.velocityError = velError;
            result.trajectory.push_back(sample);
        }

        if (step == steps) {
            metrics.finalPositionError =
                norm3(sub3(actual.position, config.holdPoint));
            metrics.finalVelocityError = norm3(actual.velocity);
            break;
        }

        // Physical thrust acceleration: LVLH components mapped through the
        // instantaneous basis (frame rotation does not add terms to a
        // free-vector mapping).
        const LvlhBasis basis = lvlhBasis(rt, vt);
        const Vector3 uInertial = add3(
            add3(scale3(basis.R, u[0]), scale3(basis.T, u[1])),
            scale3(basis.N, u[2]));
        y = rk4Step(y, dt, uInertial, mu, config.includeJ2);
        metrics.totalDeltaV += uMag * dt;
    }

    metrics.rmsPositionError = std::sqrt(sumSquaredError / (steps + 1));
    result.valid = true;
    result.message = "ok";
    return result;
}

}  // namespace maneuver
