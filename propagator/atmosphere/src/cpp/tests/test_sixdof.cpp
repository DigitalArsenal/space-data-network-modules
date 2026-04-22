/**
 * Atmosphere Plugin — 6DOF Integration Tests
 */

#include "atmosphere/sixdof_core.h"
#include <iostream>
#include <cassert>
#include <cmath>

using namespace sixdof;

void testReentryAeroTorque() {
    State s;
    s.pos = {6500e3, 0, 0};
    s.vel = {0, 7800, -100};
    s.quat = qidentity();
    s.omega = {0, 0, 0};
    s.mass = 3000;

    InertiaTensor I = inertiaDiag(500, 800, 800);
    double dt = 0.01, t = 0;

    auto aeroFn = [](const State&, double time) -> ForcesTorques {
        ForcesTorques ft;
        ft.torque_body = {0, -50.0 * std::sin(0.01 * time/0.01), 0};
        return ft;
    };

    for (int i = 0; i < 5000; i++) { s = rk4Step(s, I, dt, t, aeroFn); t += dt; }

    assert(std::abs(qnorm(s.quat) - 1.0) < 1e-6);
    assert(std::abs(s.omega[1]) > 1e-6);

    std::cout << "  Reentry aero torque ✓ (pitch_rate=" << s.omega[1] << ")\n";
}

void testSpinStabilizedReentry() {
    State s;
    s.quat = qidentity();
    s.omega = {3.0, 0, 0}; // Fast spin
    s.mass = 200;

    InertiaTensor I = inertiaDiag(30, 60, 60);
    auto coastFn = [](const State&, double) -> ForcesTorques { return {}; };
    double dt = 0.01, t = 0;

    for (int i = 0; i < 10000; i++) { s = rk4Step(s, I, dt, t, coastFn); t += dt; }

    assert(std::abs(qnorm(s.quat) - 1.0) < 1e-6);

    std::cout << "  Spin-stabilized reentry ✓ (spin=" << s.omega[0]
              << " wobble=" << std::sqrt(s.omega[1]*s.omega[1]+s.omega[2]*s.omega[2]) << ")\n";
}

void testAeroAnglesFromState() {
    Vec3 vel = {7000, 0, -500};
    double angle = 5.0 * M_PI / 180.0;
    Quat q = qfromAxisAngle({0,1,0}, angle); // Pitch up

    auto [alpha, beta] = aeroAngles(q, vel);

    assert(!std::isnan(alpha));
    assert(!std::isnan(beta));

    std::cout << "  Aero angles ✓ (alpha=" << alpha*180/M_PI
              << "° beta=" << beta*180/M_PI << "°)\n";
}

int main() {
    std::cout << "=== atmosphere 6DOF tests ===\n";
    testReentryAeroTorque();
    testSpinStabilizedReentry();
    testAeroAnglesFromState();
    std::cout << "All atmosphere 6DOF tests passed.\n";
    return 0;
}
