#include "maneuver/transforms.h"
#include "maneuver/math.h"
#include "maneuver/constants.h"

#include <cmath>
#include <stdexcept>
#include <array>

namespace maneuver {

// ===========================================================================
// roe-vector.ts
// ===========================================================================

ROEVector roeToVector(const QuasiNonsingularROE& roe) {
    return {roe.da, roe.dlambda, roe.dex, roe.dey, roe.dix, roe.diy};
}

QuasiNonsingularROE vectorToROE(const ROEVector& v) {
    return {v[0], v[1], v[2], v[3], v[4], v[5]};
}

STM6 computeJMatrix(double omega) {
    double cos_w = std::cos(omega);
    double sin_w = std::sin(omega);

    return {{
        {1, 0, 0, 0, 0, 0},
        {0, 1, 0, 0, 0, 0},
        {0, 0, cos_w, sin_w, 0, 0},
        {0, 0, -sin_w, cos_w, 0, 0},
        {0, 0, 0, 0, 1, 0},
        {0, 0, 0, 0, 0, 1},
    }};
}

STM6 computeInverseJMatrix(double omega) {
    double cos_w = std::cos(omega);
    double sin_w = std::sin(omega);

    return {{
        {1, 0, 0, 0, 0, 0},
        {0, 1, 0, 0, 0, 0},
        {0, 0, cos_w, -sin_w, 0, 0},
        {0, 0, sin_w, cos_w, 0, 0},
        {0, 0, 0, 0, 1, 0},
        {0, 0, 0, 0, 0, 1},
    }};
}

// ===========================================================================
// roe-ric.ts — Internal helpers
// ===========================================================================

namespace {

using Vector2 = std::array<double, 2>;
using Matrix2x2 = std::array<Vector2, 2>;
using Vector4 = std::array<double, 4>;
using Matrix4x4 = std::array<Vector4, 4>;

/// Build the 6x6 ROE -> RIC transformation matrix.
STM6 buildTransformationMatrix(const ClassicalOrbitalElements& chief) {
    double a = chief.semiMajorAxis;
    double e = chief.eccentricity;
    double omega = chief.argumentOfPerigee;
    double M = chief.meanAnomaly;
    double mu = chief.gravitationalParameter;

    double nu = trueAnomalyFromMean(M, e);
    double theta = omega + nu;
    double r = orbitalRadius(a, e, nu);
    double n = meanMotion(a, mu);
    double rDot = radialVelocity(a, e, nu, mu);
    double thetaDot = angularVelocity(a, e, nu, mu);

    double cos_theta = std::cos(theta);
    double sin_theta = std::sin(theta);
    double rThetaDot = r * thetaDot;

    return {{
        // Row 0 (R): position radial
        {r, 0, -r * cos_theta, -r * sin_theta, 0, 0},

        // Row 1 (I): position along-track
        {0, r, 2.0 * r * sin_theta, -2.0 * r * cos_theta, 0, 0},

        // Row 2 (C): position cross-track
        {0, 0, 0, 0, r * sin_theta, -r * cos_theta},

        // Row 3 (vR): velocity radial
        {rDot, 0,
         rThetaDot * sin_theta - rDot * cos_theta,
         -rThetaDot * cos_theta - rDot * sin_theta,
         0, 0},

        // Row 4 (vI): velocity along-track
        {-1.5 * r * n, rDot,
         2.0 * (rDot * sin_theta + rThetaDot * cos_theta),
         2.0 * (-rDot * cos_theta + rThetaDot * sin_theta),
         0, 0},

        // Row 5 (vC): velocity cross-track
        {0, 0, 0, 0,
         rDot * sin_theta + rThetaDot * cos_theta,
         -rDot * cos_theta + rThetaDot * sin_theta},
    }};
}

Matrix2x2 invert2x2(const Matrix2x2& M) {
    double a = M[0][0], b = M[0][1];
    double c = M[1][0], d = M[1][1];
    double det = a * d - b * c;

    if (std::abs(det) < 1e-15) {
        throw std::runtime_error(
            "ROE<->RIC: Out-of-plane matrix is singular.");
    }

    return {{{d / det, -b / det}, {-c / det, a / det}}};
}

Matrix4x4 invert4x4(const Matrix4x4& M) {
    // Augmented matrix [M | I]
    std::array<std::array<double, 8>, 4> aug;
    for (int r = 0; r < 4; ++r) {
        for (int c = 0; c < 4; ++c) aug[r][c] = M[r][c];
        for (int c = 0; c < 4; ++c) aug[r][c + 4] = (r == c) ? 1.0 : 0.0;
    }

    for (int col = 0; col < 4; ++col) {
        // Find pivot
        int maxRow = col;
        double maxVal = std::abs(aug[col][col]);
        for (int row = col + 1; row < 4; ++row) {
            double val = std::abs(aug[row][col]);
            if (val > maxVal) {
                maxRow = row;
                maxVal = val;
            }
        }
        if (maxVal < 1e-15) {
            throw std::runtime_error(
                "ROE<->RIC: In-plane matrix is singular.");
        }
        if (maxRow != col) std::swap(aug[col], aug[maxRow]);

        // Normalize pivot row
        double pivot = aug[col][col];
        for (int j = 0; j < 8; ++j) aug[col][j] /= pivot;

        // Eliminate other rows
        for (int row = 0; row < 4; ++row) {
            if (row != col) {
                double factor = aug[row][col];
                for (int j = 0; j < 8; ++j) {
                    aug[row][j] -= factor * aug[col][j];
                }
            }
        }
    }

    Matrix4x4 inv;
    for (int r = 0; r < 4; ++r) {
        for (int c = 0; c < 4; ++c) inv[r][c] = aug[r][c + 4];
    }
    return inv;
}

STM6 invertTransformationMatrix(const STM6& T) {
    // Extract 4x4 in-plane block (rows 0,1,3,4; cols 0,1,2,3)
    Matrix4x4 A = {{
        {T[0][0], T[0][1], T[0][2], T[0][3]},
        {T[1][0], T[1][1], T[1][2], T[1][3]},
        {T[3][0], T[3][1], T[3][2], T[3][3]},
        {T[4][0], T[4][1], T[4][2], T[4][3]},
    }};

    // Extract 2x2 out-of-plane block (rows 2,5; cols 4,5)
    Matrix2x2 B = {{{T[2][4], T[2][5]}, {T[5][4], T[5][5]}}};

    Matrix4x4 Ainv = invert4x4(A);
    Matrix2x2 Binv = invert2x2(B);

    // Reconstruct 6x6 inverse
    return {{
        {Ainv[0][0], Ainv[0][1], 0, Ainv[0][2], Ainv[0][3], 0},
        {Ainv[1][0], Ainv[1][1], 0, Ainv[1][2], Ainv[1][3], 0},
        {Ainv[2][0], Ainv[2][1], 0, Ainv[2][2], Ainv[2][3], 0},
        {Ainv[3][0], Ainv[3][1], 0, Ainv[3][2], Ainv[3][3], 0},
        {0, 0, Binv[0][0], 0, 0, Binv[0][1]},
        {0, 0, Binv[1][0], 0, 0, Binv[1][1]},
    }};
}

}  // anonymous namespace

// ===========================================================================
// roe-ric.ts — Public API
// ===========================================================================

STM6 getROEtoRICMatrix(const ClassicalOrbitalElements& chief) {
    return buildTransformationMatrix(chief);
}

STM6 getRICtoROEMatrix(const ClassicalOrbitalElements& chief) {
    STM6 T = buildTransformationMatrix(chief);
    return invertTransformationMatrix(T);
}

RelativeState roeToRIC(const ClassicalOrbitalElements& chief,
                       const QuasiNonsingularROE& roe) {
    STM6 T = getROEtoRICMatrix(chief);
    ROEVector ricVec = matVecMul6(T, roeToVector(roe));
    return {{ricVec[0], ricVec[1], ricVec[2]},
            {ricVec[3], ricVec[4], ricVec[5]}};
}

QuasiNonsingularROE ricToROE(const ClassicalOrbitalElements& chief,
                             const RelativeState& ric) {
    STM6 Tinv = getRICtoROEMatrix(chief);
    ROEVector ricVec = {ric.position[0], ric.position[1], ric.position[2],
                        ric.velocity[0], ric.velocity[1], ric.velocity[2]};
    return vectorToROE(matVecMul6(Tinv, ricVec));
}

}  // namespace maneuver
