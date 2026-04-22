#include "maneuver/stm.h"
#include "maneuver/math.h"
#include "maneuver/transforms.h"
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

/// Create ISS-like chief orbital elements (SI units).
maneuver::ClassicalOrbitalElements issChief() {
    maneuver::ClassicalOrbitalElements c;
    c.semiMajorAxis = 6778e3;      // ~400 km altitude
    c.eccentricity = 0.001;
    c.inclination = 51.6 * maneuver::DEG_TO_RAD;
    c.raan = 0.0;
    c.argumentOfPerigee = 0.0;
    c.meanAnomaly = 0.0;
    c.gravitationalParameter = maneuver::MU_EARTH;
    c.angularMomentum = std::sqrt(maneuver::MU_EARTH * c.semiMajorAxis *
                                   (1.0 - c.eccentricity * c.eccentricity));
    return c;
}

// ===== Keplerian STM =====

void testKeplerianSTMIdentityAtZero() {
    auto chief = issChief();
    auto stm = maneuver::computeKeplerianSTM(chief, 0.0);

    // Should be identity
    for (int i = 0; i < 6; ++i) {
        for (int j = 0; j < 6; ++j) {
            double expected = (i == j) ? 1.0 : 0.0;
            assertNear(stm[i][j], expected, TOL,
                       "kepSTM_0_" + std::to_string(i) + std::to_string(j));
        }
    }
}

void testKeplerianSTMDrift() {
    auto chief = issChief();
    double period = maneuver::TWO_PI /
                    maneuver::meanMotion(chief.semiMajorAxis,
                                         chief.gravitationalParameter);
    auto stm = maneuver::computeKeplerianSTM(chief, period);

    // da -> dlambda: a21 = -1.5 * n * T (one full period)
    double n = maneuver::meanMotion(chief.semiMajorAxis,
                                     chief.gravitationalParameter);
    double expected_a21 = -1.5 * n * period;
    assertNear(stm[1][0], expected_a21, TOL, "kepSTM_drift");
}

void testKeplerianPreservesROE() {
    auto chief = issChief();
    maneuver::ROEVector roe = {0.0, 1e-4, 0.0, 0.0, 0.0, 0.0};

    auto stm = maneuver::computeKeplerianSTM(chief, 100.0);
    auto result = maneuver::matVecMul6(stm, roe);

    // da should be preserved
    assertNear(result[0], roe[0], TOL, "kep_da_preserved");
    // dlambda should stay same (da=0)
    assertNear(result[1], roe[1], TOL, "kep_dlambda_no_da");
    // dex, dey preserved
    assertNear(result[2], roe[2], TOL, "kep_dex_preserved");
}

// ===== J2 STM =====

void testJ2STMIdentityAtZero() {
    auto chief = issChief();
    auto stm = maneuver::buildJ2Matrix(chief, 0.0);

    for (int i = 0; i < 6; ++i) {
        for (int j = 0; j < 6; ++j) {
            double expected = (i == j) ? 1.0 : 0.0;
            assertNear(stm[i][j], expected, TOL,
                       "j2STM_0_" + std::to_string(i) + std::to_string(j));
        }
    }
}

void testJ2STMHasApsidalPrecession() {
    auto chief = issChief();
    chief.eccentricity = 0.05;  // Need some eccentricity
    chief.argumentOfPerigee = 0.5;

    double period = maneuver::TWO_PI /
                    maneuver::meanMotion(chief.semiMajorAxis,
                                         chief.gravitationalParameter);
    auto stm = maneuver::buildJ2Matrix(chief, period);

    // dex row should have non-trivial coupling to dey (rotation)
    // stm[2][3] = -sin_wt - ... should be non-zero
    assert(std::abs(stm[2][3]) > 1e-10);
    std::cout << "  J2 apsidal coupling stm[2][3] = " << stm[2][3] << "\n";
}

void testJ2STMNodalRegression() {
    auto chief = issChief();
    double period = maneuver::TWO_PI /
                    maneuver::meanMotion(chief.semiMajorAxis,
                                         chief.gravitationalParameter);
    auto stm = maneuver::buildJ2Matrix(chief, period);

    // Row 5 (diy) should have non-zero coupling to da (row 5, col 0)
    assert(std::abs(stm[5][0]) > 1e-10);
    std::cout << "  J2 nodal regression stm[5][0] = " << stm[5][0] << "\n";
}

// ===== Drag STM (eccentric) =====

void testDragEccentricSTM() {
    auto chief = issChief();
    chief.eccentricity = 0.1;
    chief.argumentOfPerigee = 1.0;

    double period = maneuver::TWO_PI /
                    maneuver::meanMotion(chief.semiMajorAxis,
                                         chief.gravitationalParameter);
    auto result = maneuver::computeJ2DragSTMEccentric(chief, period);

    // Drag column should have non-zero da term (tau)
    assertNear(result.dragColumn[0], period, TOL, "drag_ecc_da_col");

    // Propagate with small drag
    maneuver::ROEVector roe = {1e-5, 0, 0, 0, 0, 0};
    auto propagated = maneuver::propagateJ2DragEccentric(result, roe, -1e-10);

    // da should change due to drag
    assert(std::abs(propagated[0] - roe[0]) > 1e-15);
    std::cout << "  drag ecc: da changed by "
              << (propagated[0] - roe[0]) << "\n";
}

// ===== Drag STM (arbitrary) =====

void testDragArbitrarySTM() {
    auto chief = issChief();
    chief.eccentricity = 0.01;

    double period = maneuver::TWO_PI /
                    maneuver::meanMotion(chief.semiMajorAxis,
                                         chief.gravitationalParameter);
    auto result = maneuver::computeJ2DragSTMArbitrary(chief, period);

    // 9x9 STM should have identity block for drag params
    assertNear(result.stm[6][6], 1.0, TOL, "drag_arb_66");
    assertNear(result.stm[7][7], 1.0, TOL, "drag_arb_77");
    assertNear(result.stm[8][8], 1.0, TOL, "drag_arb_88");
}

// ===== Drag estimation =====

void testDragEstimation() {
    auto chief = issChief();
    maneuver::ROEVector roe1 = {1e-5, 0, 0, 0, 0, 0};
    maneuver::ROEVector roe2 = {1.1e-5, 0, 0, 0, 0, 0};  // slight da growth

    auto cfg = maneuver::estimateDragDerivativesWithJ2Correction(
        roe1, roe2, chief, 86400.0);

    // daDotDrag should be approximately (1.1e-5 - propagated_da) / 86400
    std::cout << "  estimated daDotDrag = " << cfg.daDotDrag << "\n";
    assert(std::isfinite(cfg.daDotDrag));
}

}  // namespace

int main() {
    std::cout << "=== test_stm ===\n";
    testKeplerianSTMIdentityAtZero();
    testKeplerianSTMDrift();
    testKeplerianPreservesROE();
    testJ2STMIdentityAtZero();
    testJ2STMHasApsidalPrecession();
    testJ2STMNodalRegression();
    testDragEccentricSTM();
    testDragArbitrarySTM();
    testDragEstimation();
    std::cout << "All STM tests passed.\n";
    return 0;
}
