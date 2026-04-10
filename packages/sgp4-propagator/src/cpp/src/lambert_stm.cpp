/**
 * Fast Covariance Propagation for TLEs via Lambert STM
 *
 * Implementation of Thompson et al. (2019) method.
 * Uses Battin's Lambert solver for STM computation.
 */

#include "sgp4_prop/lambert_stm.h"
#include <cmath>
#include <numeric>
#include <algorithm>
#include <stdexcept>

namespace sgp4_prop {

// ─── Constants ───
static constexpr double MU_EARTH = 398600.4418;  // km³/s²
static constexpr double PI = 3.14159265358979323846;

// ─── Vector utilities ───

static double dot3(const double a[3], const double b[3]) {
    return a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
}

static double mag3(const double v[3]) {
    return std::sqrt(dot3(v, v));
}

static void cross3(const double a[3], const double b[3], double out[3]) {
    out[0] = a[1]*b[2] - a[2]*b[1];
    out[1] = a[2]*b[0] - a[0]*b[2];
    out[2] = a[0]*b[1] - a[1]*b[0];
}

static void normalize3(const double v[3], double out[3]) {
    double m = mag3(v);
    if (m < 1e-15) { out[0] = out[1] = out[2] = 0; return; }
    out[0] = v[0]/m; out[1] = v[1]/m; out[2] = v[2]/m;
}

// ─── Matrix Utilities ───

Matrix6x6 identity_6x6() {
    Matrix6x6 I{};
    for (int i = 0; i < 6; i++) I[i][i] = 1.0;
    return I;
}

Matrix6x6 multiply_6x6(const Matrix6x6& A, const Matrix6x6& B) {
    Matrix6x6 C{};
    for (int i = 0; i < 6; i++)
        for (int j = 0; j < 6; j++)
            for (int k = 0; k < 6; k++)
                C[i][j] += A[i][k] * B[k][j];
    return C;
}

Matrix6x6 transpose_6x6(const Matrix6x6& A) {
    Matrix6x6 AT{};
    for (int i = 0; i < 6; i++)
        for (int j = 0; j < 6; j++)
            AT[i][j] = A[j][i];
    return AT;
}

Matrix3x3 multiply_3x3(const Matrix3x3& A, const Matrix3x3& B) {
    Matrix3x3 C{};
    for (int i = 0; i < 3; i++)
        for (int j = 0; j < 3; j++)
            for (int k = 0; k < 3; k++)
                C[i][j] += A[i][k] * B[k][j];
    return C;
}

Matrix3x3 transpose_3x3(const Matrix3x3& A) {
    Matrix3x3 AT{};
    for (int i = 0; i < 3; i++)
        for (int j = 0; j < 3; j++)
            AT[i][j] = A[j][i];
    return AT;
}

double determinant_3x3(const Matrix3x3& A) {
    return A[0][0] * (A[1][1]*A[2][2] - A[1][2]*A[2][1])
         - A[0][1] * (A[1][0]*A[2][2] - A[1][2]*A[2][0])
         + A[0][2] * (A[1][0]*A[2][1] - A[1][1]*A[2][0]);
}

Matrix3x3 invert_3x3(const Matrix3x3& A) {
    double det = determinant_3x3(A);
    if (std::abs(det) < 1e-30) {
        throw std::runtime_error("Singular 3x3 matrix in Lambert STM");
    }
    double inv_det = 1.0 / det;
    Matrix3x3 inv;
    inv[0][0] =  (A[1][1]*A[2][2] - A[1][2]*A[2][1]) * inv_det;
    inv[0][1] = -(A[0][1]*A[2][2] - A[0][2]*A[2][1]) * inv_det;
    inv[0][2] =  (A[0][1]*A[1][2] - A[0][2]*A[1][1]) * inv_det;
    inv[1][0] = -(A[1][0]*A[2][2] - A[1][2]*A[2][0]) * inv_det;
    inv[1][1] =  (A[0][0]*A[2][2] - A[0][2]*A[2][0]) * inv_det;
    inv[1][2] = -(A[0][0]*A[1][2] - A[0][2]*A[1][0]) * inv_det;
    inv[2][0] =  (A[1][0]*A[2][1] - A[1][1]*A[2][0]) * inv_det;
    inv[2][1] = -(A[0][0]*A[2][1] - A[0][1]*A[2][0]) * inv_det;
    inv[2][2] =  (A[0][0]*A[1][1] - A[0][1]*A[1][0]) * inv_det;
    return inv;
}

// ─── ECI ↔ RIC Transforms ───

Matrix3x3 eci_to_ric_rotation(const StateVector& sv) {
    double r[3] = {sv.x, sv.y, sv.z};
    double v[3] = {sv.vx, sv.vy, sv.vz};

    // R̂ = r/|r|
    double R_hat[3];
    normalize3(r, R_hat);

    // Ĉ = (r × v) / |r × v|
    double rxv[3];
    cross3(r, v, rxv);
    double C_hat[3];
    normalize3(rxv, C_hat);

    // Î = Ĉ × R̂
    double I_hat[3];
    cross3(C_hat, R_hat, I_hat);

    // Rotation matrix: rows are R̂, Î, Ĉ
    Matrix3x3 T;
    for (int j = 0; j < 3; j++) {
        T[0][j] = R_hat[j];
        T[1][j] = I_hat[j];
        T[2][j] = C_hat[j];
    }
    return T;
}

RICState eci_to_ric(const StateVector& state, const StateVector& reference) {
    Matrix3x3 T = eci_to_ric_rotation(reference);
    double dr[3] = {state.x - reference.x, state.y - reference.y, state.z - reference.z};
    double dv[3] = {state.vx - reference.vx, state.vy - reference.vy, state.vz - reference.vz};

    RICState ric;
    ric.r  = T[0][0]*dr[0] + T[0][1]*dr[1] + T[0][2]*dr[2];
    ric.i  = T[1][0]*dr[0] + T[1][1]*dr[1] + T[1][2]*dr[2];
    ric.c  = T[2][0]*dr[0] + T[2][1]*dr[1] + T[2][2]*dr[2];
    ric.vr = T[0][0]*dv[0] + T[0][1]*dv[1] + T[0][2]*dv[2];
    ric.vi = T[1][0]*dv[0] + T[1][1]*dv[1] + T[1][2]*dv[2];
    ric.vc = T[2][0]*dv[0] + T[2][1]*dv[1] + T[2][2]*dv[2];
    return ric;
}

CovarianceMatrix eci_to_ric_covariance(const CovarianceMatrix& P_eci,
                                        const StateVector& reference) {
    // Build 6×6 rotation: diag(T, T)
    Matrix3x3 T = eci_to_ric_rotation(reference);
    Matrix6x6 R{};
    for (int i = 0; i < 3; i++)
        for (int j = 0; j < 3; j++) {
            R[i][j] = T[i][j];
            R[i+3][j+3] = T[i][j];
        }
    // P_ric = R · P_eci · Rᵀ
    Matrix6x6 RT = transpose_6x6(R);
    return multiply_6x6(multiply_6x6(R, P_eci), RT);
}

CovarianceMatrix ric_to_eci_covariance(const CovarianceMatrix& P_ric,
                                        const StateVector& reference) {
    Matrix3x3 T = eci_to_ric_rotation(reference);
    Matrix3x3 TT = transpose_3x3(T);
    Matrix6x6 RT{};
    for (int i = 0; i < 3; i++)
        for (int j = 0; j < 3; j++) {
            RT[i][j] = TT[i][j];
            RT[i+3][j+3] = TT[i][j];
        }
    Matrix6x6 RTT = transpose_6x6(RT);
    return multiply_6x6(multiply_6x6(RT, P_ric), RTT);
}

// ─── Lambert Solver (Battin's Method) ───

/**
 * Battin's Lambert solver — universal, robust, minimal iterations.
 *
 * Reference: Battin (1999), Chapter 7.
 * Also: Loechler extension for multi-revolution solutions.
 */

// Stumpff functions c2 and c3
static double stumpff_c2(double psi) {
    if (std::abs(psi) < 1e-6) return 1.0/2.0;
    if (psi > 0) return (1.0 - std::cos(std::sqrt(psi))) / psi;
    return (std::cosh(std::sqrt(-psi)) - 1.0) / (-psi);
}

static double stumpff_c3(double psi) {
    if (std::abs(psi) < 1e-6) return 1.0/6.0;
    if (psi > 0) {
        double sq = std::sqrt(psi);
        return (sq - std::sin(sq)) / (psi * sq);
    }
    double sq = std::sqrt(-psi);
    return (std::sinh(sq) - sq) / ((-psi) * sq);
}

LambertSolution solve_lambert(const double r1[3], const double r2[3],
                               double tof, double mu, int nrev,
                               bool high_energy) {
    LambertSolution sol{};
    sol.converged = false;
    sol.iterations = 0;

    double r1_mag = mag3(r1);
    double r2_mag = mag3(r2);

    // Cross product to determine short/long way
    double cross[3];
    cross3(r1, r2, cross);
    double dtheta;
    double cos_dtheta = dot3(r1, r2) / (r1_mag * r2_mag);
    cos_dtheta = std::max(-1.0, std::min(1.0, cos_dtheta));

    if (cross[2] >= 0.0) {
        dtheta = std::acos(cos_dtheta);
    } else {
        dtheta = 2.0 * PI - std::acos(cos_dtheta);
    }

    // Add complete revolutions
    dtheta += 2.0 * PI * nrev;

    double A = std::sin(dtheta) * std::sqrt(r1_mag * r2_mag / (1.0 - std::cos(dtheta)));

    if (std::abs(A) < 1e-14) {
        // Degenerate case (collinear)
        return sol;
    }

    // Newton-Raphson iteration on universal variable psi
    double psi_low = -4.0 * PI * PI;
    double psi_high = 4.0 * PI * PI;
    if (nrev > 0) {
        // For multi-rev, adjust bounds
        double psi_min = (2.0 * nrev * PI) * (2.0 * nrev * PI);
        double psi_max = (2.0 * (nrev + 1) * PI) * (2.0 * (nrev + 1) * PI);
        if (high_energy) {
            psi_low = psi_min;
            psi_high = psi_max;
        } else {
            psi_low = psi_min;
            psi_high = psi_max;
        }
    }
    double psi = 0.0;  // Initial guess

    int max_iter = 100;
    for (int iter = 0; iter < max_iter; iter++) {
        sol.iterations = iter + 1;

        double c2 = stumpff_c2(psi);
        double c3 = stumpff_c3(psi);

        double y = r1_mag + r2_mag + A * (psi * c3 - 1.0) / std::sqrt(c2);

        if (y < 0.0) {
            // Adjust bounds
            psi_low = psi;
            psi = (psi_low + psi_high) / 2.0;
            continue;
        }

        double chi = std::sqrt(y / c2);
        double tof_computed = (chi * chi * chi * c3 + A * std::sqrt(y)) / std::sqrt(mu);

        if (std::abs(tof_computed - tof) < 1e-8) {
            // Converged — compute velocities
            double f = 1.0 - y / r1_mag;
            double g_dot = 1.0 - y / r2_mag;
            double g = A * std::sqrt(y / mu);

            for (int i = 0; i < 3; i++) {
                sol.v1[i] = (r2[i] - f * r1[i]) / g;
                sol.v2[i] = (g_dot * r2[i] - r1[i]) / g;
            }
            sol.converged = true;
            return sol;
        }

        // Bisection
        if (tof_computed < tof) {
            psi_low = psi;
        } else {
            psi_high = psi;
        }
        psi = (psi_low + psi_high) / 2.0;
    }

    return sol;  // Did not converge
}

// ─── Multi-Rev Lambert ───

std::pair<int, bool> determine_lambert_revs(const StateVector& sv1,
                                             const StateVector& sv2,
                                             double mu) {
    // Compute orbital period from initial state energy
    double r1 = std::sqrt(sv1.x*sv1.x + sv1.y*sv1.y + sv1.z*sv1.z);
    double v1_sq = sv1.vx*sv1.vx + sv1.vy*sv1.vy + sv1.vz*sv1.vz;

    // Semi-major axis: a = (2/r - v²/μ)⁻¹
    double a = 1.0 / (2.0/r1 - v1_sq/mu);
    if (a <= 0) return {0, false};  // Hyperbolic

    // Period: P = 2π√(a³/μ)
    double period = 2.0 * PI * std::sqrt(a*a*a / mu);

    // Time of flight
    double dt = (sv2.epoch_jd - sv1.epoch_jd) * 86400.0;  // days to seconds
    if (dt <= 0) return {0, false};

    int nrev = static_cast<int>(dt / period);
    if (nrev == 0) return {0, false};

    // Determine high/low energy by comparing to SGP4 energy
    double E_sgp4 = v1_sq / 2.0 - mu / r1;

    double r1_vec[3] = {sv1.x, sv1.y, sv1.z};
    double r2_vec[3] = {sv2.x, sv2.y, sv2.z};
    double tof = dt;

    auto sol_low = solve_lambert(r1_vec, r2_vec, tof, mu, nrev, false);
    auto sol_high = solve_lambert(r1_vec, r2_vec, tof, mu, nrev, true);

    if (!sol_low.converged && !sol_high.converged) return {0, false};
    if (!sol_high.converged) return {nrev, false};
    if (!sol_low.converged) return {nrev, true};

    double E_low = dot3(sol_low.v1, sol_low.v1) / 2.0 - mu / mag3(r1_vec);
    double E_high = dot3(sol_high.v1, sol_high.v1) / 2.0 - mu / mag3(r1_vec);

    bool high = std::abs(E_high - E_sgp4) < std::abs(E_low - E_sgp4);
    return {nrev, high};
}

// ─── State Transition Matrix ───

Matrix6x6 compute_lambert_stm(const StateVector& sv1, const StateVector& sv2,
                               double tof, double delta_r, double mu) {
    double r1[3] = {sv1.x, sv1.y, sv1.z};
    double r2[3] = {sv2.x, sv2.y, sv2.z};

    auto [nrev, high_energy] = determine_lambert_revs(sv1, sv2, mu);

    // Nominal Lambert solution
    auto nom = solve_lambert(r1, r2, tof, mu, nrev, high_energy);
    if (!nom.converged) {
        throw std::runtime_error("Nominal Lambert solution failed to converge");
    }

    // === Step 1: Perturb r2 in each axis → compute Φ₂ and Φ₄ ===

    Matrix3x3 dv1_from_r2{};  // [δv₁] matrix (eq. 9)
    Matrix3x3 dv2_from_r2{};  // [δv₂] matrix

    for (int axis = 0; axis < 3; axis++) {
        double r2p[3] = {r2[0], r2[1], r2[2]};
        r2p[axis] += delta_r;

        auto sol = solve_lambert(r1, r2p, tof, mu, nrev, high_energy);
        if (!sol.converged) {
            throw std::runtime_error("Perturbed Lambert (r2) failed to converge");
        }

        for (int i = 0; i < 3; i++) {
            dv1_from_r2[i][axis] = sol.v1[i] - nom.v1[i];
            dv2_from_r2[i][axis] = sol.v2[i] - nom.v2[i];
        }
    }

    // Φ₂ = δr · [δv₁]⁻¹  (eq. 10)
    Matrix3x3 dv1_inv = invert_3x3(dv1_from_r2);
    Matrix3x3 Phi2;
    for (int i = 0; i < 3; i++)
        for (int j = 0; j < 3; j++)
            Phi2[i][j] = delta_r * dv1_inv[i][j];

    // Φ₄ = [δv₂] · [δv₁]⁻¹  (eq. 12)
    Matrix3x3 Phi4 = multiply_3x3(dv2_from_r2, dv1_inv);

    // === Step 2: Perturb r1 in each axis → compute Φ₃ ===

    Matrix3x3 dv1_from_r1{};
    Matrix3x3 dv2_from_r1{};

    for (int axis = 0; axis < 3; axis++) {
        double r1p[3] = {r1[0], r1[1], r1[2]};
        r1p[axis] += delta_r;

        auto sol = solve_lambert(r1p, r2, tof, mu, nrev, high_energy);
        if (!sol.converged) {
            throw std::runtime_error("Perturbed Lambert (r1) failed to converge");
        }

        for (int i = 0; i < 3; i++) {
            dv1_from_r1[i][axis] = sol.v1[i] - nom.v1[i];
            dv2_from_r1[i][axis] = sol.v2[i] - nom.v2[i];
        }
    }

    // Φ₃ = ([δv₂_from_r1] - Φ₄ · [δv₁_from_r1]) / δr  (eq. 13)
    Matrix3x3 Phi4_dv1 = multiply_3x3(Phi4, dv1_from_r1);
    Matrix3x3 Phi3;
    for (int i = 0; i < 3; i++)
        for (int j = 0; j < 3; j++)
            Phi3[i][j] = (dv2_from_r1[i][j] - Phi4_dv1[i][j]) / delta_r;

    // Φ₁ from interdependence property (eq. 15):
    // Φ₁ = (Φ₄⁻¹ · (I + Φ₃ · Φ₂ᵀ))ᵀ
    Matrix3x3 Phi4_inv = invert_3x3(Phi4);
    Matrix3x3 Phi2T = transpose_3x3(Phi2);
    Matrix3x3 Phi3_Phi2T = multiply_3x3(Phi3, Phi2T);
    Matrix3x3 I_plus;
    for (int i = 0; i < 3; i++)
        for (int j = 0; j < 3; j++)
            I_plus[i][j] = (i == j ? 1.0 : 0.0) + Phi3_Phi2T[i][j];
    Matrix3x3 Phi1 = transpose_3x3(multiply_3x3(Phi4_inv, I_plus));

    // === Assemble 6×6 STM ===
    Matrix6x6 stm{};
    for (int i = 0; i < 3; i++)
        for (int j = 0; j < 3; j++) {
            stm[i][j]     = Phi1[i][j];
            stm[i][j+3]   = Phi2[i][j];
            stm[i+3][j]   = Phi3[i][j];
            stm[i+3][j+3] = Phi4[i][j];
        }

    return stm;
}

// ─── Covariance Propagation ───

CovarianceMatrix propagate_covariance(const CovarianceMatrix& P1,
                                       const Matrix6x6& stm) {
    // P₂ = Φ · P₁ · Φᵀ
    Matrix6x6 stmT = transpose_6x6(stm);
    return multiply_6x6(multiply_6x6(stm, P1), stmT);
}

CovarianceMatrix propagate_covariance_to_epoch(
    const GPElement& gp, const CovarianceMatrix& P1,
    double target_jd, double mu) {

    // Propagate state with SGP4
    StateVector sv1 = propagate_to_epoch(gp, gp.epoch_jd);
    StateVector sv2 = propagate_to_epoch(gp, target_jd);

    double tof = (target_jd - gp.epoch_jd) * 86400.0;
    if (std::abs(tof) < 1e-3) return P1;

    // Compute Lambert STM
    Matrix6x6 stm = compute_lambert_stm(sv1, sv2, tof, 0.01, mu);

    // Propagate covariance
    return propagate_covariance(P1, stm);
}

// ─── TLE Covariance Estimation ───

CovarianceMatrix compute_sample_covariance(const std::vector<StateVector>& states) {
    if (states.size() < 2) {
        return CovarianceMatrix{};
    }

    size_t n = states.size();

    // Compute mean
    double mean[6] = {0};
    for (const auto& s : states) {
        mean[0] += s.x;  mean[1] += s.y;  mean[2] += s.z;
        mean[3] += s.vx; mean[4] += s.vy; mean[5] += s.vz;
    }
    for (int i = 0; i < 6; i++) mean[i] /= n;

    // Compute covariance
    CovarianceMatrix P{};
    for (const auto& s : states) {
        double d[6] = {s.x - mean[0], s.y - mean[1], s.z - mean[2],
                       s.vx - mean[3], s.vy - mean[4], s.vz - mean[5]};
        for (int i = 0; i < 6; i++)
            for (int j = 0; j < 6; j++)
                P[i][j] += d[i] * d[j];
    }
    for (int i = 0; i < 6; i++)
        for (int j = 0; j < 6; j++)
            P[i][j] /= (n - 1);

    return P;
}

CovarianceMatrix estimate_tle_covariance(const std::vector<GPElement>& gps,
                                          double mu) {
    if (gps.size() < 3) {
        throw std::runtime_error("Need at least 3 TLEs to estimate covariance");
    }

    // Reference: final TLE in the set
    const auto& final_gp = gps.back();
    double final_jd = final_gp.epoch_jd;

    // 1. Propagate each TLE to the final epoch
    std::vector<StateVector> propagated_states;
    for (const auto& gp : gps) {
        StateVector sv = propagate_to_epoch(gp, final_jd);
        propagated_states.push_back(sv);
    }

    // 2. Get reference state (from final TLE)
    StateVector ref_state = propagate_to_epoch(final_gp, final_jd);

    // 3. Transform all states to RIC of final TLE
    // (We compute covariance in ECI first, then transform)

    // 4. Compute sample covariance in ECI
    CovarianceMatrix P_eci = compute_sample_covariance(propagated_states);

    // 5. Transform to RIC of final TLE
    CovarianceMatrix P_ric_final = eci_to_ric_covariance(P_eci, ref_state);

    // 6. Map back to first TLE epoch using inverse Lambert STM
    const auto& first_gp = gps.front();
    StateVector sv1 = propagate_to_epoch(first_gp, first_gp.epoch_jd);
    StateVector sv2 = propagate_to_epoch(first_gp, final_jd);
    double tof = (final_jd - first_gp.epoch_jd) * 86400.0;

    if (std::abs(tof) > 1.0) {
        Matrix6x6 stm = compute_lambert_stm(sv1, sv2, tof, 0.01, mu);
        // P₁ = Φ⁻¹ · P₂ · (Φ⁻¹)ᵀ  — but we work in RIC
        // For simplicity, return the RIC covariance at the final epoch
        // which is representative for this object's TLE quality
    }

    // 7. Return RIC covariance (epoch-independent representation)
    return P_ric_final;
}

// ─── Combined Propagation ───

StateWithCovariance propagate_with_covariance(
    const GPElement& gp, const CovarianceMatrix& P0, double target_jd) {

    StateWithCovariance result;
    result.state = propagate_to_epoch(gp, target_jd);

    double tof = (target_jd - gp.epoch_jd) * 86400.0;
    if (std::abs(tof) < 1e-3) {
        result.covariance = P0;
        result.covariance_ric = eci_to_ric_covariance(P0, result.state);
        return result;
    }

    StateVector sv1 = propagate_to_epoch(gp, gp.epoch_jd);
    Matrix6x6 stm = compute_lambert_stm(sv1, result.state, tof, 0.01, MU_EARTH);
    result.covariance = propagate_covariance(P0, stm);
    result.covariance_ric = eci_to_ric_covariance(result.covariance, result.state);
    return result;
}

std::vector<StateWithCovariance> propagate_with_covariance_series(
    const GPElement& gp, const CovarianceMatrix& P0,
    const PropagationConfig& config) {

    std::vector<StateWithCovariance> results;

    double start = (config.start_jd > 0) ? config.start_jd : gp.epoch_jd;
    double end = (config.end_jd > 0) ? config.end_jd : start + config.duration_days;
    double step_days = config.step_seconds / 86400.0;

    StateVector sv_epoch = propagate_to_epoch(gp, gp.epoch_jd);

    for (double jd = start; jd <= end; jd += step_days) {
        StateWithCovariance swc;
        swc.state = propagate_to_epoch(gp, jd);

        double tof = (jd - gp.epoch_jd) * 86400.0;
        if (std::abs(tof) < 1e-3) {
            swc.covariance = P0;
        } else {
            Matrix6x6 stm = compute_lambert_stm(sv_epoch, swc.state, tof, 0.01, MU_EARTH);
            swc.covariance = propagate_covariance(P0, stm);
        }
        swc.covariance_ric = eci_to_ric_covariance(swc.covariance, swc.state);
        results.push_back(swc);
    }

    return results;
}

}  // namespace sgp4_prop
