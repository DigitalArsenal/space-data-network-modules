#include "maneuver/math.h"
#include "maneuver/fault.h"

#include <cmath>
#include <stdexcept>
#include <string>

namespace maneuver {

// ===========================================================================
// Constants
// ===========================================================================

const Vector3 ZERO_VECTOR3 = {0.0, 0.0, 0.0};
const ROEVector ZERO_ROE = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0};

// ===========================================================================
// kepler.ts
// ===========================================================================

double trueAnomalyFromMean(double meanAnomaly, double eccentricity,
                           double tolerance) {
    if (eccentricity < 0.0 || eccentricity >= 1.0) {
        return fault::fail<double>(fault_code::INVALID_PARAMETER,
            "[kepler]: Eccentricity must be in [0, 1) for elliptical orbits (e=" +
            std::to_string(eccentricity) + ")");
    }

    // Solve Kepler's equation: E - e*sin(E) = M
    double E = meanAnomaly;

    for (int i = 0; i < 100; ++i) {
        double f = E - eccentricity * std::sin(E) - meanAnomaly;
        double fPrime = 1.0 - eccentricity * std::cos(E);
        double deltaE = f / fPrime;
        E -= deltaE;

        if (std::abs(deltaE) < tolerance) break;
    }

    // Convert eccentric anomaly to true anomaly
    double theta =
        2.0 * std::atan2(std::sqrt(1.0 + eccentricity) * std::sin(E / 2.0),
                         std::sqrt(1.0 - eccentricity) * std::cos(E / 2.0));

    return theta;
}

double meanMotion(double semiMajorAxis, double gravitationalParameter) {
    if (semiMajorAxis <= 0.0) {
        return fault::fail<double>(fault_code::INVALID_PARAMETER,
            "[kepler]: Semi-major axis must be positive (a=" +
            std::to_string(semiMajorAxis) + ")");
    }
    if (gravitationalParameter <= 0.0) {
        return fault::fail<double>(fault_code::INVALID_PARAMETER,
            "[kepler]: Gravitational parameter must be positive (mu=" +
            std::to_string(gravitationalParameter) + ")");
    }
    return std::sqrt(gravitationalParameter /
                     (semiMajorAxis * semiMajorAxis * semiMajorAxis));
}

double orbitalRadius(double semiMajorAxis, double eccentricity,
                     double trueAnomaly) {
    if (eccentricity < 0.0 || eccentricity >= 1.0) {
        return fault::fail<double>(fault_code::INVALID_PARAMETER,
            "[kepler]: Eccentricity must be in [0, 1) (e=" +
            std::to_string(eccentricity) + ")");
    }
    double eta2 = 1.0 - eccentricity * eccentricity;
    return (semiMajorAxis * eta2) /
           (1.0 + eccentricity * std::cos(trueAnomaly));
}

double radialVelocity(double semiMajorAxis, double eccentricity,
                      double trueAnomaly, double gravitationalParameter) {
    if (eccentricity < 0.0 || eccentricity >= 1.0) {
        return fault::fail<double>(fault_code::INVALID_PARAMETER,
            "[kepler]: Eccentricity must be in [0, 1) (e=" +
            std::to_string(eccentricity) + ")");
    }
    double n = meanMotion(semiMajorAxis, gravitationalParameter);
    double eta = std::sqrt(1.0 - eccentricity * eccentricity);
    return (semiMajorAxis * n * eccentricity * std::sin(trueAnomaly)) / eta;
}

double angularVelocity(double semiMajorAxis, double eccentricity,
                       double trueAnomaly, double gravitationalParameter) {
    if (eccentricity < 0.0 || eccentricity >= 1.0) {
        return fault::fail<double>(fault_code::INVALID_PARAMETER,
            "[kepler]: Eccentricity must be in [0, 1) (e=" +
            std::to_string(eccentricity) + ")");
    }
    double n = meanMotion(semiMajorAxis, gravitationalParameter);
    double eta = std::sqrt(1.0 - eccentricity * eccentricity);
    double factor = 1.0 + eccentricity * std::cos(trueAnomaly);
    return (n * factor * factor) / (eta * eta * eta);
}

// ===========================================================================
// orbital-factors.ts
// ===========================================================================

double computeKappa(double a, double e, double mu, double j2, double re) {
    if (a <= 0.0) {
        return fault::fail<double>(fault_code::INVALID_PARAMETER,
            "[orbital-factors]: Semi-major axis must be positive (a=" +
            std::to_string(a) + ")");
    }
    if (e < 0.0 || e >= 1.0) {
        return fault::fail<double>(fault_code::INVALID_PARAMETER,
            "[orbital-factors]: Eccentricity must be in [0, 1) (e=" +
            std::to_string(e) + ")");
    }
    if (mu <= 0.0) {
        return fault::fail<double>(fault_code::INVALID_PARAMETER,
            "[orbital-factors]: Gravitational parameter must be positive (mu=" +
            std::to_string(mu) + ")");
    }
    double eta = std::sqrt(1.0 - e * e);
    return (0.75 * j2 * re * re * std::sqrt(mu)) /
           (std::pow(a, 3.5) * std::pow(eta, 4.0));
}

OrbitalFactors computeOrbitalFactors(double e, double i) {
    if (e < 0.0 || e >= 1.0) {
        return fault::fail<OrbitalFactors>(fault_code::INVALID_PARAMETER,
            "[orbital-factors]: Eccentricity must be in [0, 1) (e=" +
            std::to_string(e) + ")");
    }
    double eta = std::sqrt(1.0 - e * e);
    double cos_i = std::cos(i);
    double sin_i = std::sin(i);
    double cos2_i = cos_i * cos_i;

    OrbitalFactors f;
    f.eta = eta;
    f.P = 3.0 * cos2_i - 1.0;
    f.Q = 5.0 * cos2_i - 1.0;
    f.R = cos_i;
    f.S = 2.0 * sin_i * cos_i;
    f.T = sin_i * sin_i;
    f.E = 1.0 + eta;
    f.F = 4.0 + 3.0 * eta;
    f.G = 1.0 / (eta * eta);
    return f;
}

ApsidalState computeApsidalState(double e, double omega, double kappa,
                                 double Q, double tau) {
    if (e < 0.0 || e >= 1.0) {
        return fault::fail<ApsidalState>(fault_code::INVALID_PARAMETER,
            "[orbital-factors]: Eccentricity must be in [0, 1) (e=" +
            std::to_string(e) + ")");
    }
    double omegaDot = kappa * Q;
    double omega_f = omega + omegaDot * tau;
    double wt = omegaDot * tau;

    ApsidalState s;
    s.omegaDot = omegaDot;
    s.omega_f = omega_f;
    s.ex_i = e * std::cos(omega);
    s.ey_i = e * std::sin(omega);
    s.ex_f = e * std::cos(omega_f);
    s.ey_f = e * std::sin(omega_f);
    s.cos_wt = std::cos(wt);
    s.sin_wt = std::sin(wt);
    return s;
}

// ===========================================================================
// matrices.ts
// ===========================================================================

ROEVector matVecMul6(const STM6& A, const ROEVector& v) {
    ROEVector result;
    for (int i = 0; i < 6; ++i) {
        result[i] = A[i][0] * v[0] + A[i][1] * v[1] + A[i][2] * v[2] +
                    A[i][3] * v[3] + A[i][4] * v[4] + A[i][5] * v[5];
    }
    return result;
}

ROEVector7 matVecMul7(const STM7& A, const ROEVector7& v) {
    ROEVector7 result;
    for (int i = 0; i < 7; ++i) {
        result[i] = 0.0;
        for (int j = 0; j < 7; ++j) {
            result[i] += A[i][j] * v[j];
        }
    }
    return result;
}

ROEVector9 matVecMul9(const STM9& A, const ROEVector9& v) {
    ROEVector9 result;
    for (int i = 0; i < 9; ++i) {
        result[i] = 0.0;
        for (int j = 0; j < 9; ++j) {
            result[i] += A[i][j] * v[j];
        }
    }
    return result;
}

// ===========================================================================
// vectors.ts
// ===========================================================================

double norm3(const Vector3& v) {
    return std::sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

Vector3 sub3(const Vector3& a, const Vector3& b) {
    return {a[0] - b[0], a[1] - b[1], a[2] - b[2]};
}

Vector3 add3(const Vector3& a, const Vector3& b) {
    return {a[0] + b[0], a[1] + b[1], a[2] + b[2]};
}

ROEVector matMul6x3_3x1(const ControlMatrix6x3& B, const Vector3& v) {
    ROEVector result;
    for (int i = 0; i < 6; ++i) {
        result[i] = B[i][0] * v[0] + B[i][1] * v[1] + B[i][2] * v[2];
    }
    return result;
}

Vector3 matMul3x3_3x1(const Matrix3x3& A, const Vector3& v) {
    return {A[0][0] * v[0] + A[0][1] * v[1] + A[0][2] * v[2],
            A[1][0] * v[0] + A[1][1] * v[1] + A[1][2] * v[2],
            A[2][0] * v[0] + A[2][1] * v[1] + A[2][2] * v[2]};
}

Matrix3x3 invert3x3(const Matrix3x3& A) {
    double a = A[0][0], b = A[0][1], c = A[0][2];
    double d = A[1][0], e = A[1][1], f = A[1][2];
    double g = A[2][0], h = A[2][1], ii = A[2][2];

    double det = a * (e * ii - f * h) - b * (d * ii - f * g) +
                 c * (d * h - e * g);

    if (std::abs(det) < 1e-15) {
        return fault::fail<Matrix3x3>(fault_code::SINGULAR,
            "[math]: Jacobian matrix is singular. "
            "The problem may be ill-conditioned at this configuration.");
    }

    double invDet = 1.0 / det;

    Matrix3x3 inv;
    inv[0] = {(e * ii - f * h) * invDet, (c * h - b * ii) * invDet,
              (b * f - c * e) * invDet};
    inv[1] = {(f * g - d * ii) * invDet, (a * ii - c * g) * invDet,
              (c * d - a * f) * invDet};
    inv[2] = {(d * h - e * g) * invDet, (b * g - a * h) * invDet,
              (a * e - b * d) * invDet};
    return inv;
}

ROEVector addROE(const ROEVector& a, const ROEVector& b) {
    return {a[0] + b[0], a[1] + b[1], a[2] + b[2],
            a[3] + b[3], a[4] + b[4], a[5] + b[5]};
}

double normalizeAngle(double angle) {
    double result = std::fmod(angle, TWO_PI);
    if (result < 0.0) result += TWO_PI;
    return result;
}

}  // namespace maneuver
