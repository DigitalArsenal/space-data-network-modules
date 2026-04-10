#include "maneuver/math.h"
#include "maneuver/constants.h"

#include <cassert>
#include <cmath>
#include <iostream>
#include <string>

namespace {

constexpr double TOL = 1e-8;

void assertNear(double actual, double expected, double tol,
                const std::string& label) {
    if (std::abs(actual - expected) > tol) {
        std::cerr << "FAIL [" << label << "]: expected " << expected
                  << ", got " << actual
                  << " (diff=" << std::abs(actual - expected) << ")\n";
        assert(false);
    }
}

// ===== Kepler equation =====

void testTrueAnomalyCircular() {
    // Circular orbit: M = nu
    double nu = maneuver::trueAnomalyFromMean(1.0, 0.0);
    assertNear(nu, 1.0, TOL, "trueAnomaly_circular");
}

void testTrueAnomalyEccentric() {
    // Known case: e=0.1, M=pi -> nu=pi (symmetry)
    double nu = maneuver::trueAnomalyFromMean(M_PI, 0.1);
    assertNear(nu, M_PI, 1e-6, "trueAnomaly_eccentric_pi");
}

void testTrueAnomalyZero() {
    double nu = maneuver::trueAnomalyFromMean(0.0, 0.3);
    assertNear(nu, 0.0, TOL, "trueAnomaly_zero");
}

// ===== Mean motion =====

void testMeanMotion() {
    // ISS orbit: a ≈ 6778 km, mu = 3.986e14 m^3/s^2
    double a = 6778e3;
    double n = maneuver::meanMotion(a, maneuver::MU_EARTH);
    double expected = std::sqrt(maneuver::MU_EARTH / (a * a * a));
    assertNear(n, expected, TOL, "meanMotion_ISS");

    // Period should be ~92 minutes
    double period = maneuver::TWO_PI / n;
    assertNear(period, 5520.0, 100.0, "meanMotion_ISS_period");
}

// ===== Orbital radius =====

void testOrbitalRadius() {
    double a = 7000e3;
    double e = 0.01;
    // At periapsis (nu=0): r = a*(1-e^2)/(1+e) ≈ a*(1-e)
    double rP = maneuver::orbitalRadius(a, e, 0.0);
    assertNear(rP, a * (1.0 - e * e) / (1.0 + e), TOL, "orbitalRadius_peri");

    // At apoapsis (nu=pi): r = a*(1-e^2)/(1-e) ≈ a*(1+e)
    double rA = maneuver::orbitalRadius(a, e, M_PI);
    assertNear(rA, a * (1.0 - e * e) / (1.0 - e), TOL, "orbitalRadius_apo");
}

// ===== Vector operations =====

void testNorm3() {
    maneuver::Vector3 v = {3.0, 4.0, 0.0};
    assertNear(maneuver::norm3(v), 5.0, TOL, "norm3");
}

void testAdd3Sub3() {
    maneuver::Vector3 a = {1.0, 2.0, 3.0};
    maneuver::Vector3 b = {4.0, 5.0, 6.0};
    auto s = maneuver::add3(a, b);
    assertNear(s[0], 5.0, TOL, "add3_x");
    assertNear(s[1], 7.0, TOL, "add3_y");
    assertNear(s[2], 9.0, TOL, "add3_z");

    auto d = maneuver::sub3(a, b);
    assertNear(d[0], -3.0, TOL, "sub3_x");
}

// ===== 3x3 inversion =====

void testInvert3x3() {
    // Identity should invert to identity
    maneuver::Matrix3x3 I = {{{1, 0, 0}, {0, 1, 0}, {0, 0, 1}}};
    auto Iinv = maneuver::invert3x3(I);
    assertNear(Iinv[0][0], 1.0, TOL, "invert3x3_I_00");
    assertNear(Iinv[1][1], 1.0, TOL, "invert3x3_I_11");
    assertNear(Iinv[0][1], 0.0, TOL, "invert3x3_I_01");

    // Diagonal matrix
    maneuver::Matrix3x3 D = {{{2, 0, 0}, {0, 3, 0}, {0, 0, 4}}};
    auto Dinv = maneuver::invert3x3(D);
    assertNear(Dinv[0][0], 0.5, TOL, "invert3x3_D_00");
    assertNear(Dinv[1][1], 1.0 / 3.0, TOL, "invert3x3_D_11");
    assertNear(Dinv[2][2], 0.25, TOL, "invert3x3_D_22");
}

// ===== MatVecMul6 =====

void testMatVecMul6Identity() {
    maneuver::STM6 I = {{
        {1, 0, 0, 0, 0, 0}, {0, 1, 0, 0, 0, 0}, {0, 0, 1, 0, 0, 0},
        {0, 0, 0, 1, 0, 0}, {0, 0, 0, 0, 1, 0}, {0, 0, 0, 0, 0, 1},
    }};
    maneuver::ROEVector v = {1, 2, 3, 4, 5, 6};
    auto r = maneuver::matVecMul6(I, v);
    for (int i = 0; i < 6; ++i) {
        assertNear(r[i], v[i], TOL, "matVecMul6_I_" + std::to_string(i));
    }
}

// ===== Orbital factors =====

void testOrbitalFactors() {
    double e = 0.01;
    double inc = 51.6 * maneuver::DEG_TO_RAD;  // ISS inclination
    auto f = maneuver::computeOrbitalFactors(e, inc);

    // eta = sqrt(1-e^2) ~ 1.0
    assertNear(f.eta, std::sqrt(1.0 - e * e), TOL, "factors_eta");
    // E = 1 + eta
    assertNear(f.E, 1.0 + f.eta, TOL, "factors_E");
    // F = 4 + 3*eta
    assertNear(f.F, 4.0 + 3.0 * f.eta, TOL, "factors_F");
}

// ===== Kappa =====

void testKappa() {
    double a = 6778e3;
    double e = 0.001;
    double k = maneuver::computeKappa(a, e, maneuver::MU_EARTH);
    // Should be a small positive number for LEO
    assert(k > 0.0);
    assert(k < 1.0);
    std::cout << "  kappa = " << k << " (sanity ok)\n";
}

// ===== Normalize angle =====

void testNormalizeAngle() {
    assertNear(maneuver::normalizeAngle(0.0), 0.0, TOL, "normalize_0");
    assertNear(maneuver::normalizeAngle(maneuver::TWO_PI), 0.0, TOL,
               "normalize_2pi");
    assertNear(maneuver::normalizeAngle(-M_PI), M_PI, TOL, "normalize_neg_pi");
}

}  // namespace

int main() {
    std::cout << "=== test_math ===\n";
    testTrueAnomalyCircular();
    testTrueAnomalyEccentric();
    testTrueAnomalyZero();
    testMeanMotion();
    testOrbitalRadius();
    testNorm3();
    testAdd3Sub3();
    testInvert3x3();
    testMatVecMul6Identity();
    testOrbitalFactors();
    testKappa();
    testNormalizeAngle();
    std::cout << "All math tests passed.\n";
    return 0;
}
