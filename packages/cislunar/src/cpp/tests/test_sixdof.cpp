/**
 * Cislunar Plugin — 6DOF Integration Tests
 */

#include "cislunar/sixdof_core.h"
#include <iostream>
#include <cassert>
#include <cmath>

using namespace sixdof;

void testSRPTorqueAtL2() {
    State s;
    s.pos = {4.4e8, 0, 0};
    s.vel = {0, 1000, 0};
    s.quat = qidentity();
    s.omega = {0, 0, 0};
    s.mass = 1000;

    InertiaTensor I = inertiaDiag(300, 400, 350);
    double dt = 0.1, t = 0;

    auto forceFn = [](const State&, double) -> ForcesTorques {
        ForcesTorques ft;
        ft.torque_body = {1e-4, 0, 5e-5};
        return ft;
    };

    for (int i = 0; i < 10000; i++) { s = rk4Step(s, I, dt, t, forceFn); t += dt; }

    assert(std::abs(s.omega[0] - 1e-4/300.0*1000.0) < 1e-5);
    assert(std::abs(qnorm(s.quat) - 1.0) < 1e-6);

    std::cout << "  SRP torque at L2 ✓ (omega=" << s.omega[0] << ")\n";
}

void testSpinStabilized() {
    State s;
    s.quat = qidentity();
    s.omega = {0.5, 0, 0}; // ~5 RPM spin
    s.mass = 2000;

    InertiaTensor I = inertiaDiag(500, 200, 200); // Major-axis spin
    double dt = 0.01, t = 0;
    auto coastFn = [](const State&, double) -> ForcesTorques { return {}; };

    for (int i = 0; i < 6000; i++) { s = rk4Step(s, I, dt, t, coastFn); t += dt; }

    assert(std::abs(s.omega[0] - 0.5) < 0.001);
    assert(std::abs(s.omega[1]) < 0.001);
    assert(std::abs(s.omega[2]) < 0.001);

    std::cout << "  Spin-stabilized ✓ (spin=" << s.omega[0]
              << " wobble=" << std::sqrt(s.omega[1]*s.omega[1]+s.omega[2]*s.omega[2]) << ")\n";
}

void testNutationDynamics() {
    State s;
    s.quat = qidentity();
    s.omega = {1.0, 0.01, 0};
    s.mass = 100;

    InertiaTensor I = inertiaDiag(50, 80, 100);
    double dt = 0.005, t = 0;
    auto coastFn = [](const State&, double) -> ForcesTorques { return {}; };

    double maxQ = 0, maxR = 0;
    for (int i = 0; i < 20000; i++) {
        s = rk4Step(s, I, dt, t, coastFn); t += dt;
        maxQ = std::max(maxQ, std::abs(s.omega[1]));
        maxR = std::max(maxR, std::abs(s.omega[2]));
    }

    assert(maxQ > 0.005);
    assert(maxR > 0.005);
    double T0 = 0.5*(50*1.0*1.0 + 80*0.01*0.01);
    double T1 = 0.5*(I[0]*s.omega[0]*s.omega[0]+I[1]*s.omega[1]*s.omega[1]+I[2]*s.omega[2]*s.omega[2]);
    assert(std::abs(T1 - T0) / T0 < 1e-3);

    std::cout << "  Nutation ✓ (maxQ=" << maxQ << " maxR=" << maxR
              << " KE_drift=" << std::abs(T1-T0)/T0*100 << "%)\n";
}

int main() {
    std::cout << "=== cislunar 6DOF tests ===\n";
    testSRPTorqueAtL2();
    testSpinStabilized();
    testNutationDynamics();
    std::cout << "All cislunar 6DOF tests passed.\n";
    return 0;
}
