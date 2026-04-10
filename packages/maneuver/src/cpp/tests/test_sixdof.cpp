/**
 * Maneuver Plugin — 6DOF Integration Tests
 */

#include "maneuver/sixdof_core.h"
#include <iostream>
#include <cassert>
#include <cmath>

using namespace sixdof;

void testAttitudeSlew() {
    State s;
    s.pos = {7000e3, 0, 0};
    s.vel = {0, 7546, 0};
    s.quat = qidentity();
    s.omega = {0, 0, 0};
    s.mass = 500;

    InertiaTensor I = inertiaDiag(100, 120, 80);
    double dt = 0.01;

    auto forceFn = [](const State&, double) -> ForcesTorques {
        ForcesTorques ft;
        ft.torque_body = {5.0, 0, 0}; // 5 N·m roll torque
        return ft;
    };

    double t = 0;
    for (int i = 0; i < 1000; i++) {
        s = rk4Step(s, I, dt, t, forceFn);
        t += dt;
    }

    // alpha = T/I = 0.05 rad/s², omega = 0.05*10 = 0.5 rad/s
    assert(std::abs(s.omega[0] - 0.5) < 0.01);
    assert(std::abs(qnorm(s.quat) - 1.0) < 1e-6);

    std::cout << "  Attitude slew ✓ (omega_roll=" << s.omega[0] << ")\n";
}

void testCoastAngMomentum() {
    State s;
    s.quat = qidentity();
    s.omega = {0.1, 0.05, -0.03};
    s.mass = 200;

    InertiaTensor I = inertiaDiag(50, 60, 40);

    Vec3 L_body_init = inertiaTimesOmega(I, s.omega);
    Vec3 L_init = qrotate(s.quat, L_body_init);
    double L_mag_init = v3norm(L_init);

    auto forceFn = [](const State&, double) -> ForcesTorques { return {}; };
    double t = 0, dt = 0.01;
    for (int i = 0; i < 6000; i++) {
        s = rk4Step(s, I, dt, t, forceFn);
        t += dt;
    }

    Vec3 L_body_final = inertiaTimesOmega(I, s.omega);
    Vec3 L_final = qrotate(s.quat, L_body_final);
    double L_mag_final = v3norm(L_final);

    assert(std::abs(L_mag_final - L_mag_init) / L_mag_init < 1e-4);

    std::cout << "  Angular momentum ✓ (drift="
              << std::abs(L_mag_final - L_mag_init) / L_mag_init * 100 << "%)\n";
}

void testRCSPulse() {
    State s;
    s.quat = qidentity();
    s.omega = {0, 0, 0};
    s.mass = 1000;

    InertiaTensor I = inertiaDiag(200, 250, 180);
    double dt = 0.01, t = 0;

    auto pulseFn = [](const State&, double) -> ForcesTorques {
        ForcesTorques ft;
        ft.torque_body = {0, 0, 50.0};
        return ft;
    };
    auto coastFn = [](const State&, double) -> ForcesTorques { return {}; };

    for (int i = 0; i < 50; i++) { s = rk4Step(s, I, dt, t, pulseFn); t += dt; }
    assert(std::abs(s.omega[2] - (50.0/180.0*0.5)) < 0.01);

    double postRate = s.omega[2];
    for (int i = 0; i < 200; i++) { s = rk4Step(s, I, dt, t, coastFn); t += dt; }
    assert(std::abs(s.omega[2] - postRate) < 0.001);

    std::cout << "  RCS pulse ✓ (yaw_rate=" << s.omega[2] << ")\n";
}

void testGravGradTorque() {
    State s;
    s.pos = {7000e3, 0, 0};
    s.vel = {0, 7546, 0};
    s.quat = qfromAxisAngle({1,0,0}, 0);
    s.omega = {0, 0, 0};
    s.mass = 500;

    InertiaTensor I = inertiaDiag(10, 50, 50);
    double mu = 3.986004418e14;
    double dt = 0.01, t = 0;

    auto forceFn = [&](const State& st, double) -> ForcesTorques {
        ForcesTorques ft;
        double r = v3norm(st.pos);
        Vec3 n_i = v3scale(st.pos, 1.0/r);
        Vec3 n_b = qrotateInv(st.quat, n_i);
        double coeff = 3.0 * mu / (r*r*r);
        Vec3 In = inertiaTimesOmega(I, n_b); // Reuse: I*n
        ft.torque_body = v3cross(n_b, In);
        ft.torque_body = v3scale(ft.torque_body, coeff);
        ft.force_inertial = v3scale(st.pos, -mu * st.mass / (r*r*r));
        return ft;
    };

    for (int i = 0; i < 10000; i++) { s = rk4Step(s, I, dt, t, forceFn); t += dt; }

    double omegaMag = v3norm(s.omega);
    assert(omegaMag > 1e-6);
    assert(std::abs(qnorm(s.quat) - 1.0) < 1e-6);

    std::cout << "  Gravity gradient ✓ (|omega|=" << omegaMag*1e3 << " mrad/s)\n";
}

int main() {
    std::cout << "=== maneuver 6DOF tests ===\n";
    testAttitudeSlew();
    testCoastAngMomentum();
    testRCSPulse();
    testGravGradTorque();
    std::cout << "All maneuver 6DOF tests passed.\n";
    return 0;
}
