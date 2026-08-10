#include "maneuver/stm.h"
#include "maneuver/fault.h"
#include "maneuver/math.h"
#include "maneuver/constants.h"

#include <cmath>
#include <stdexcept>
#include <string>

namespace maneuver {

// ===========================================================================
// keplerian.ts — Keplerian (unperturbed) STM
// ===========================================================================

STM6 computeKeplerianSTM(const ClassicalOrbitalElements& chief, double tau) {
    double n = meanMotion(chief.semiMajorAxis, chief.gravitationalParameter);
    double a21 = -1.5 * n * tau;

    return {{
        {1, 0, 0, 0, 0, 0},
        {a21, 1, 0, 0, 0, 0},
        {0, 0, 1, 0, 0, 0},
        {0, 0, 0, 1, 0, 0},
        {0, 0, 0, 0, 1, 0},
        {0, 0, 0, 0, 0, 1},
    }};
}

// ===========================================================================
// j2.ts — J2-perturbed STM
// ===========================================================================

STM6 buildJ2Matrix(const ClassicalOrbitalElements& chief, double tau) {
    double a = chief.semiMajorAxis;
    double e = chief.eccentricity;
    double i = chief.inclination;
    double omega = chief.argumentOfPerigee;
    double mu = chief.gravitationalParameter;

    double n = meanMotion(a, mu);
    double kappa = computeKappa(a, e, mu);
    OrbitalFactors factors = computeOrbitalFactors(e, i);
    ApsidalState apsidal = computeApsidalState(e, omega, kappa, factors.Q, tau);

    double P = factors.P, Q = factors.Q, S = factors.S, T = factors.T;
    double E = factors.E, F = factors.F, G = factors.G;
    double ex_i = apsidal.ex_i, ey_i = apsidal.ey_i;
    double ex_f = apsidal.ex_f, ey_f = apsidal.ey_f;
    double cos_wt = apsidal.cos_wt, sin_wt = apsidal.sin_wt;

    return {{
        // Row 0: delta-a is constant
        {1, 0, 0, 0, 0, 0},

        // Row 1: delta-lambda evolution (Keplerian + J2)
        {-(1.5 * n + 3.5 * kappa * E * P) * tau,
         1,
         kappa * ex_i * F * G * P * tau,
         kappa * ey_i * F * G * P * tau,
         -kappa * F * S * tau,
         0},

        // Row 2: delta-ex (apsidal precession)
        {3.5 * kappa * ey_f * Q * tau,
         0,
         cos_wt - 4.0 * kappa * ex_i * ey_f * G * Q * tau,
         -sin_wt - 4.0 * kappa * ey_i * ey_f * G * Q * tau,
         5.0 * kappa * ey_f * S * tau,
         0},

        // Row 3: delta-ey (apsidal precession)
        {-3.5 * kappa * ex_f * Q * tau,
         0,
         sin_wt + 4.0 * kappa * ex_i * ex_f * G * Q * tau,
         cos_wt + 4.0 * kappa * ey_i * ex_f * G * Q * tau,
         -5.0 * kappa * ex_f * S * tau,
         0},

        // Row 4: delta-ix constant
        {0, 0, 0, 0, 1, 0},

        // Row 5: delta-iy (nodal regression)
        {3.5 * kappa * S * tau,
         0,
         -4.0 * kappa * ex_i * G * S * tau,
         -4.0 * kappa * ey_i * G * S * tau,
         2.0 * kappa * T * tau,
         1},
    }};
}

STM6 computeJ2STM(const ClassicalOrbitalElements& chief, double tau) {
    return buildJ2Matrix(chief, tau);
}

// ===========================================================================
// drag-eccentric.ts — J2 + eccentric drag STM (7x7)
// ===========================================================================

J2DragEccentricResult computeJ2DragSTMEccentric(
    const ClassicalOrbitalElements& chief, double tau) {
    double a = chief.semiMajorAxis;
    double e = chief.eccentricity;
    double i = chief.inclination;
    double omega = chief.argumentOfPerigee;
    double mu = chief.gravitationalParameter;

    double n = meanMotion(a, mu);
    double kappa = computeKappa(a, e, mu, J2, R_EARTH);
    OrbitalFactors factors = computeOrbitalFactors(e, i);
    ApsidalState apsidal = computeApsidalState(e, omega, kappa, factors.Q, tau);

    double eta = factors.eta, P = factors.P, Q = factors.Q, S = factors.S;
    double G = factors.G;
    double omega_f = apsidal.omega_f;
    double ex_f = apsidal.ex_f, ey_f = apsidal.ey_f;
    double tau2 = tau * tau;

    // 6x6 J2 STM
    STM6 phi_j2 = buildJ2Matrix(chief, tau);

    // Drag column from Appendix C, Eq. C2
    ROEVector dragColumn;
    dragColumn[0] = tau;
    dragColumn[1] = (-0.75 * n - 1.75 * kappa * eta * P +
                     1.5 * kappa * e * (1.0 - e) * eta * G * P) * tau2;
    dragColumn[2] = (1.0 - e) * std::cos(omega_f) * tau -
                    kappa * ey_f * Q * (-1.75 + 2.0 * e * (1.0 - e) * G) * tau2;
    dragColumn[3] = (1.0 - e) * std::sin(omega_f) * tau +
                    kappa * ex_f * Q * (-1.75 + 2.0 * e * (1.0 - e) * G) * tau2;
    dragColumn[4] = 0.0;
    dragColumn[5] = kappa * S * (1.75 - 2.0 * e * (1.0 - e) * G) * tau2;

    // Assemble 7x7 STM
    STM7 stm;
    for (int r = 0; r < 6; ++r) {
        for (int c = 0; c < 6; ++c) {
            stm[r][c] = phi_j2[r][c];
        }
        stm[r][6] = dragColumn[r];
    }
    stm[6] = {0, 0, 0, 0, 0, 0, 1};

    return {stm, dragColumn};
}

ROEVector propagateJ2DragEccentric(const J2DragEccentricResult& result,
                                   const ROEVector& roe, double daDotDrag) {
    ROEVector7 state7;
    for (int i = 0; i < 6; ++i) state7[i] = roe[i];
    state7[6] = daDotDrag;

    ROEVector7 out = matVecMul7(result.stm, state7);

    ROEVector r;
    for (int i = 0; i < 6; ++i) r[i] = out[i];
    return r;
}

// ===========================================================================
// drag-arbitrary.ts — J2 + arbitrary drag STM (9x9)
// ===========================================================================

J2DragArbitraryResult computeJ2DragSTMArbitrary(
    const ClassicalOrbitalElements& chief, double tau) {
    double a = chief.semiMajorAxis;
    double e = chief.eccentricity;
    double i = chief.inclination;
    double omega = chief.argumentOfPerigee;
    double mu = chief.gravitationalParameter;

    double n = meanMotion(a, mu);
    double kappa = computeKappa(a, e, mu, J2, R_EARTH);
    OrbitalFactors factors = computeOrbitalFactors(e, i);
    ApsidalState apsidal = computeApsidalState(e, omega, kappa, factors.Q, tau);

    double E_f = factors.E, F_f = factors.F, P = factors.P, Q = factors.Q;
    double S = factors.S, G = factors.G;
    double omega_f = apsidal.omega_f;
    double ex_f = apsidal.ex_f, ey_f = apsidal.ey_f;
    double cos_wf = std::cos(omega_f);
    double sin_wf = std::sin(omega_f);
    double tau2 = tau * tau;

    STM6 phi_j2 = buildJ2Matrix(chief, tau);

    // Column 1: delta-a-dot contributions
    ROEVector dragCol1;
    dragCol1[0] = tau;
    dragCol1[1] = -(0.75 * n + 1.75 * kappa * E_f * P) * tau2;
    dragCol1[2] = 1.75 * kappa * ey_f * Q * tau2;
    dragCol1[3] = -1.75 * kappa * ex_f * Q * tau2;
    dragCol1[4] = 0.0;
    dragCol1[5] = 1.75 * kappa * S * tau2;

    // Column 2: delta-ex-dot contributions
    ROEVector dragCol2;
    dragCol2[0] = 0.0;
    dragCol2[1] = 0.5 * kappa * e * F_f * G * P * tau2;
    dragCol2[2] = cos_wf * tau - 2.0 * kappa * e * ey_f * G * Q * tau2;
    dragCol2[3] = sin_wf * tau + 2.0 * kappa * e * ex_f * G * Q * tau2;
    dragCol2[4] = 0.0;
    dragCol2[5] = -2.0 * kappa * e * G * S * tau2;

    // Column 3: delta-ey-dot contributions
    ROEVector dragCol3;
    dragCol3[0] = 0.0;
    dragCol3[1] = 0.0;
    dragCol3[2] = -sin_wf * tau;
    dragCol3[3] = cos_wf * tau;
    dragCol3[4] = 0.0;
    dragCol3[5] = 0.0;

    // Transpose to drag columns 6x3
    DragColumns6x3 dragColumns;
    for (int r = 0; r < 6; ++r) {
        dragColumns[r] = {dragCol1[r], dragCol2[r], dragCol3[r]};
    }

    // Assemble 9x9 STM
    STM9 stm;
    for (int r = 0; r < 6; ++r) {
        for (int c = 0; c < 6; ++c) stm[r][c] = phi_j2[r][c];
        stm[r][6] = dragColumns[r][0];
        stm[r][7] = dragColumns[r][1];
        stm[r][8] = dragColumns[r][2];
    }
    stm[6] = {0, 0, 0, 0, 0, 0, 1, 0, 0};
    stm[7] = {0, 0, 0, 0, 0, 0, 0, 1, 0};
    stm[8] = {0, 0, 0, 0, 0, 0, 0, 0, 1};

    return {stm, dragColumns};
}

ROEVector propagateJ2DragArbitrary(const J2DragArbitraryResult& result,
                                   const ROEVector& roe, double daDotDrag,
                                   double dexDotDrag, double deyDotDrag) {
    ROEVector9 state9;
    for (int i = 0; i < 6; ++i) state9[i] = roe[i];
    state9[6] = daDotDrag;
    state9[7] = dexDotDrag;
    state9[8] = deyDotDrag;

    ROEVector9 out = matVecMul9(result.stm, state9);

    ROEVector r;
    for (int i = 0; i < 6; ++i) r[i] = out[i];
    return r;
}

// ===========================================================================
// drag config conversion
// ===========================================================================

DragConfig eccentricToArbitraryConfig(double daDotDrag,
                                      const ClassicalOrbitalElements& chief) {
    double e = chief.eccentricity;
    double omega = chief.argumentOfPerigee;
    double deDotDrag = (1.0 - e) * daDotDrag;

    DragConfig cfg;
    cfg.type = DragType::ARBITRARY;
    cfg.daDotDrag = daDotDrag;
    cfg.dexDotDrag = deDotDrag * std::cos(omega);
    cfg.deyDotDrag = deDotDrag * std::sin(omega);
    return cfg;
}

// ===========================================================================
// drag-estimation.ts
// ===========================================================================

DragConfig estimateDragDerivativesWithJ2Correction(
    const ROEVector& roe1, const ROEVector& roe2,
    const ClassicalOrbitalElements& chief, double dt) {
    if (dt <= 0.0) {
        return fault::fail<DragConfig>(fault_code::INVALID_PARAMETER,
            "[estimateDragDerivatives]: dt must be positive (dt=" +
            std::to_string(dt) + ")");
    }

    STM6 stmJ2 = computeJ2STM(chief, dt);
    ROEVector expectedJ2 = matVecMul6(stmJ2, roe1);

    ROEVector residuals;
    for (int i = 0; i < 6; ++i) residuals[i] = roe2[i] - expectedJ2[i];

    DragConfig cfg;
    cfg.type = DragType::ARBITRARY;
    cfg.daDotDrag = residuals[0] / dt;
    cfg.dexDotDrag = residuals[2] / dt;
    cfg.deyDotDrag = residuals[3] / dt;
    return cfg;
}

double estimateDaDot(double da1, double da2, double dt) {
    if (dt <= 0.0) {
        return fault::fail<double>(fault_code::INVALID_PARAMETER,
                                 "[estimateDaDot]: dt must be positive (dt=" +
                                 std::to_string(dt) + ")");
    }
    return (da2 - da1) / dt;
}

}  // namespace maneuver
