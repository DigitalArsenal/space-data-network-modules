#include "maneuver/rendezvous.h"
#include "maneuver/constants.h"
#include "maneuver/math.h"

#include <cassert>
#include <cmath>
#include <iostream>
#include <string>

namespace {

void assertNear(double actual, double expected, double tol,
                const std::string& label) {
    if (std::abs(actual - expected) > tol) {
        std::cerr << "FAIL [" << label << "]: expected " << expected
                  << ", got " << actual
                  << " (diff=" << std::abs(actual - expected) << ")\n";
        assert(false);
    }
}

void assertLess(double actual, double bound, const std::string& label) {
    if (!(actual < bound)) {
        std::cerr << "FAIL [" << label << "]: expected < " << bound
                  << ", got " << actual << "\n";
        assert(false);
    }
}

maneuver::ClassicalOrbitalElements circularChief() {
    maneuver::ClassicalOrbitalElements c;
    c.semiMajorAxis = 6778e3;
    c.eccentricity = 0.0;
    c.inclination = 51.6 * maneuver::DEG_TO_RAD;
    c.raan = 0.0;
    c.argumentOfPerigee = 0.0;
    c.meanAnomaly = 0.0;
    c.gravitationalParameter = maneuver::MU_EARTH;
    c.angularMomentum = std::sqrt(maneuver::MU_EARTH * c.semiMajorAxis);
    return c;
}

double meanMotion(const maneuver::ClassicalOrbitalElements& c) {
    return std::sqrt(c.gravitationalParameter /
                     (c.semiMajorAxis * c.semiMajorAxis * c.semiMajorAxis));
}

// Fehse combined-case boundary conditions from the reference scenario:
// start 338.8 m behind with a 100 m radial offset, brake gate 80 m behind,
// hold 30 m behind on V-bar.
maneuver::RendezvousConfig baseConfig() {
    maneuver::RendezvousConfig config;
    config.initialPosition = {100.0, -338.8, 0.0};
    config.brakePoint = {0.0, -80.0, 0.0};
    config.holdPoint = {0.0, -30.0, 0.0};
    config.driftDuration = 2000.0;
    config.brakeDuration = 400.0;
    config.holdDuration = 300.0;
    config.timeStep = 0.5;
    config.outputEvery = 20;
    return config;
}

// ===== CW two-point boundary value problem =====

void testCWBoundaryValueProblem() {
    const auto chief = circularChief();
    const double n = meanMotion(chief);
    const auto config = baseConfig();

    maneuver::Vector3 v0{};
    const bool ok = maneuver::solveCWInitialVelocity(
        config.initialPosition, config.brakePoint, n,
        config.driftDuration, v0);
    assert(ok);

    maneuver::RelativeState state;
    state.position = config.initialPosition;
    state.velocity = v0;
    const auto arrival =
        maneuver::propagateCW(state, n, config.driftDuration);

    for (int axis = 0; axis < 3; ++axis) {
        assertNear(arrival.position[axis], config.brakePoint[axis], 1e-6,
                   "BVP arrival axis " + std::to_string(axis));
    }
    std::cout << "  CW BVP: v0=[" << v0[0] << ", " << v0[1] << ", " << v0[2]
              << "] m/s arrives at brake gate\n";

    // Near one full period the transfer matrix is singular
    maneuver::Vector3 ignored{};
    const double period = maneuver::TWO_PI / n;
    assert(!maneuver::solveCWInitialVelocity(
        config.initialPosition, config.brakePoint, n, period, ignored));
}

// ===== Quintic braking boundary conditions =====

void testQuinticBoundaryConditions() {
    const auto chief = circularChief();
    const double n = meanMotion(chief);
    const auto config = baseConfig();

    maneuver::RelativeState initial;
    initial.position = config.initialPosition;
    maneuver::Vector3 v0{};
    maneuver::solveCWInitialVelocity(
        config.initialPosition, config.brakePoint, n,
        config.driftDuration, v0);
    initial.velocity = v0;

    const auto handoff =
        maneuver::propagateCW(initial, n, config.driftDuration);
    const auto handoffAccel = maneuver::hcwAcceleration(handoff, n);
    const auto brake = maneuver::buildQuinticBrake(
        handoff, handoffAccel, config.holdPoint, config.brakeDuration);

    const auto start = maneuver::evaluateQuintic(brake, 0.0);
    const auto end = maneuver::evaluateQuintic(brake, config.brakeDuration);
    for (int axis = 0; axis < 3; ++axis) {
        const auto tag = std::to_string(axis);
        assertNear(start.position[axis], handoff.position[axis], 1e-9,
                   "quintic start pos " + tag);
        assertNear(start.velocity[axis], handoff.velocity[axis], 1e-9,
                   "quintic start vel " + tag);
        assertNear(start.acceleration[axis], handoffAccel[axis], 1e-9,
                   "quintic start accel " + tag);
        assertNear(end.position[axis], config.holdPoint[axis], 1e-6,
                   "quintic end pos " + tag);
        assertNear(end.velocity[axis], 0.0, 1e-9, "quintic end vel " + tag);
        assertNear(end.acceleration[axis], 0.0, 1e-9,
                   "quintic end accel " + tag);
    }
    std::cout << "  Quintic brake: continuous handoff, zero-vel/accel hold\n";
}

// ===== Full closed-loop simulation =====

void testClosedLoopTracking() {
    const auto chief = circularChief();
    const auto config = baseConfig();

    const auto result = maneuver::simulateRendezvous(config, chief);
    assert(result.valid);

    std::cout << "  Closed loop: dv=" << result.metrics.totalDeltaV
              << " m/s, maxErr=" << result.metrics.maxPositionError
              << " m, finalErr=" << result.metrics.finalPositionError
              << " m, finalVel=" << result.metrics.finalVelocityError
              << " m/s\n";

    // Tracking of the HCW reference against the nonlinear truth: the only
    // disturbance is HCW model error at ~340 m range, so sub-meter bounds
    // are conservative.
    assertLess(result.metrics.maxPositionError, 1.0, "max tracking error");
    assertLess(result.metrics.finalPositionError, 0.05, "final position");
    assertLess(result.metrics.finalVelocityError, 1e-3, "final velocity");
    assertLess(result.metrics.maxPositionErrorHold, 0.05, "hold error");
    assert(result.metrics.totalDeltaV > 0.0);
    assert(result.metrics.saturatedSteps == 0);
    assert(!result.trajectory.empty());
    assert(result.trajectory.front().phase == maneuver::RendezvousPhase::DRIFT);
    assert(result.trajectory.back().phase == maneuver::RendezvousPhase::HOLD);

    // A V-bar hold is force-free under HCW: control there should be tiny
    // (only nonlinear residuals), far below the braking accelerations.
    double maxHoldControl = 0.0;
    for (const auto& sample : result.trajectory) {
        if (sample.phase == maneuver::RendezvousPhase::HOLD) {
            maxHoldControl =
                std::max(maxHoldControl, maneuver::norm3(sample.controlAccel));
        }
    }
    assertLess(maxHoldControl, 1e-5, "hold-phase control accel");
}

// ===== Compensation levers =====

void testCompensationImprovesTracking() {
    const auto chief = circularChief();
    auto config = baseConfig();
    config.holdDuration = 0.0;

    const auto with = maneuver::simulateRendezvous(config, chief);
    config.compensateCoriolis = false;
    config.compensateGravityGradient = false;
    config.useFeedforward = false;
    const auto without = maneuver::simulateRendezvous(config, chief);
    assert(with.valid && without.valid);

    std::cout << "  Compensation: rmsErr with=" << with.metrics.rmsPositionError
              << " m, without=" << without.metrics.rmsPositionError << " m\n";
    assertLess(with.metrics.rmsPositionError,
               without.metrics.rmsPositionError,
               "feedback linearization reduces tracking error");
}

// ===== Validation errors =====

void testValidation() {
    const auto chief = circularChief();
    auto config = baseConfig();
    config.driftDuration = 0.0;
    assert(!maneuver::simulateRendezvous(config, chief).valid);

    config = baseConfig();
    config.timeStep = config.brakeDuration * 2.0;
    assert(!maneuver::simulateRendezvous(config, chief).valid);

    // Singular drift duration (one full period) must surface as an error
    config = baseConfig();
    config.driftDuration = maneuver::TWO_PI / meanMotion(chief);
    assert(!maneuver::simulateRendezvous(config, chief).valid);
    std::cout << "  Validation: bad configs rejected\n";
}

}  // namespace

int main() {
    std::cout << "test_rendezvous\n";
    testCWBoundaryValueProblem();
    testQuinticBoundaryConditions();
    testClosedLoopTracking();
    testCompensationImprovesTracking();
    testValidation();
    std::cout << "PASS\n";
    return 0;
}
