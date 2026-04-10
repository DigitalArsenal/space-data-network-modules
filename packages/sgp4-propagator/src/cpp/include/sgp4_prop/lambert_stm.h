#ifndef SGP4_LAMBERT_STM_H
#define SGP4_LAMBERT_STM_H

/**
 * Fast Covariance Propagation for TLEs via Lambert STM
 *
 * Based on: Thompson, B.F. et al. (2019). "Fast covariance propagation
 * for two-line element sets." AMOS Conference.
 *
 * Instead of numerically integrating 42 differential equations (6 state
 * + 36 STM), this method uses Lambert targeting to compute the State
 * Transition Matrix. The Lambert algorithm is invoked 6 times (vs.
 * thousands of integration steps), making it orders of magnitude faster
 * while maintaining accuracy commensurate with TLE/SGP4 precision.
 *
 * The method also enables estimation of TLE covariance from historical
 * TLE data by propagating a set of TLEs to a common epoch and computing
 * the scatter in RIC coordinates.
 *
 * Key equations (Thompson 2019):
 *   P₂ = Φ(t₂,t₁) · P₁ · Φᵀ(t₂,t₁)          -- covariance propagation
 *   Φ₂ = δr·[δv₁]⁻¹                             -- STM partition from Lambert
 *   Φ₄ = [δv₂]·[δv₁]⁻¹                          -- STM partition from Lambert
 *   Φ₃ = ([δv₂] - Φ₄·[δv₁]) / δr               -- derived partition
 *   Φ₁ = (Φ₄⁻¹·(I + Φ₃·Φ₂ᵀ))ᵀ                 -- interdependent partition
 */

#include "propagator.h"
#include <array>
#include <vector>

namespace sgp4_prop {

// ─── Matrix Types ───

/// 3×3 matrix stored row-major
using Matrix3x3 = std::array<std::array<double, 3>, 3>;

/// 6×6 matrix stored row-major
using Matrix6x6 = std::array<std::array<double, 6>, 6>;

/// 6×6 covariance matrix (symmetric, but stored as full matrix)
using CovarianceMatrix = Matrix6x6;

// ─── RIC (Radial, In-track, Cross-track) ───

struct RICState {
    double r, i, c;       // position (km) in RIC
    double vr, vi, vc;    // velocity (km/s) in RIC
};

/// ECI-to-RIC rotation matrix for a given state
Matrix3x3 eci_to_ric_rotation(const StateVector& sv);

/// Transform ECI state to RIC relative to a reference state
RICState eci_to_ric(const StateVector& state, const StateVector& reference);

/// Transform 6×6 ECI covariance to RIC
CovarianceMatrix eci_to_ric_covariance(const CovarianceMatrix& P_eci,
                                        const StateVector& reference);

/// Transform 6×6 RIC covariance to ECI
CovarianceMatrix ric_to_eci_covariance(const CovarianceMatrix& P_ric,
                                        const StateVector& reference);

// ─── Lambert Solver ───

/**
 * Lambert problem result: velocity vectors at departure and arrival
 * that produce a trajectory connecting r1 and r2 in the given time.
 */
struct LambertSolution {
    double v1[3];    // departure velocity (km/s)
    double v2[3];    // arrival velocity (km/s)
    bool converged;
    int iterations;
};

/**
 * Solve Lambert's problem using Battin's method.
 *
 * Given two position vectors and a time of flight, find the velocity
 * vectors at each endpoint. Battin's method is universal (works for
 * all orbit types), robust, and designed for minimum iterations.
 *
 * @param r1       Initial position [x,y,z] km (ECI)
 * @param r2       Final position [x,y,z] km (ECI)
 * @param tof      Time of flight (seconds)
 * @param mu       Gravitational parameter (km³/s²), default Earth
 * @param nrev     Number of complete revolutions (0 for short way)
 * @param high_energy  If nrev>0, select high-energy solution
 * @return         LambertSolution with v1, v2
 *
 * Reference: Battin, R.H. (1999). An Introduction to the Mathematics
 *            and Methods of Astrodynamics. AIAA, Chapter 7.
 */
LambertSolution solve_lambert(const double r1[3], const double r2[3],
                               double tof, double mu = 398600.4418,
                               int nrev = 0, bool high_energy = false);

/**
 * Determine number of complete revolutions between two states.
 * Uses the orbital period from the initial state's energy.
 * Selects high/low energy solution by comparing to SGP4 energy.
 *
 * @param sv1  Initial state from SGP4
 * @param sv2  Final state from SGP4
 * @param mu   Gravitational parameter
 * @return     {nrev, is_high_energy}
 */
std::pair<int, bool> determine_lambert_revs(const StateVector& sv1,
                                             const StateVector& sv2,
                                             double mu = 398600.4418);

// ─── State Transition Matrix (Lambert-based) ───

/**
 * Compute the 6×6 State Transition Matrix using Lambert targeting.
 *
 * The STM maps small deviations in state at t1 to deviations at t2:
 *   [δr₂; δv₂] = Φ(t₂,t₁) · [δr₁; δv₁]
 *
 * Instead of integrating 36 coupled ODEs, this method:
 *   1. Perturbs r2 in each axis, solves Lambert → Φ₂, Φ₄
 *   2. Perturbs r1 in each axis, solves Lambert → Φ₃
 *   3. Derives Φ₁ from interdependence property
 *
 * Total: 6 Lambert solutions (vs. thousands of integration steps).
 *
 * @param sv1        Initial state vector (from SGP4)
 * @param sv2        Final state vector (from SGP4)
 * @param tof        Time of flight (seconds)
 * @param delta_r    Perturbation size (km), default 0.01 km = 10 m
 * @param mu         Gravitational parameter
 * @return           6×6 State Transition Matrix
 *
 * Reference: Thompson et al. (2019), Section 3.
 */
Matrix6x6 compute_lambert_stm(const StateVector& sv1, const StateVector& sv2,
                               double tof, double delta_r = 0.01,
                               double mu = 398600.4418);

// ─── Covariance Propagation ───

/**
 * Propagate covariance using the Lambert STM.
 *
 *   P₂ = Φ · P₁ · Φᵀ
 *
 * @param P1   6×6 covariance at epoch t1 (ECI, km and km/s)
 * @param stm  6×6 State Transition Matrix from compute_lambert_stm()
 * @return     6×6 covariance at epoch t2
 */
CovarianceMatrix propagate_covariance(const CovarianceMatrix& P1,
                                       const Matrix6x6& stm);

/**
 * High-level: propagate covariance from t1 to t2 using SGP4 + Lambert STM.
 *
 * @param gp       GP element (TLE)
 * @param P1       Initial covariance at GP epoch (ECI)
 * @param target_jd  Target Julian date
 * @param mu       Gravitational parameter
 * @return         Covariance at target epoch
 */
CovarianceMatrix propagate_covariance_to_epoch(
    const GPElement& gp, const CovarianceMatrix& P1,
    double target_jd, double mu = 398600.4418);

// ─── TLE Covariance Estimation ───

/**
 * Estimate covariance from a set of historical TLEs.
 *
 * Method (Thompson 2019, Section 4):
 *   1. Propagate each TLE to the epoch of the final TLE
 *   2. Transform all states to RIC of the final TLE
 *   3. Compute sample covariance from the scatter
 *   4. Map back to first TLE epoch using inverse Lambert STM
 *   5. Transform to RIC of first TLE (epoch-independent)
 *
 * @param gps      Set of historical GP elements (chronological order)
 * @param mu       Gravitational parameter
 * @return         Estimated 6×6 RIC covariance (km, km/s)
 */
CovarianceMatrix estimate_tle_covariance(const std::vector<GPElement>& gps,
                                          double mu = 398600.4418);

/**
 * Compute sample covariance from a set of state vectors.
 *
 * @param states   Set of state vectors at a common epoch
 * @return         6×6 sample covariance in ECI
 */
CovarianceMatrix compute_sample_covariance(const std::vector<StateVector>& states);

// ─── Combined: Propagate with Covariance ───

struct StateWithCovariance {
    StateVector state;
    CovarianceMatrix covariance;    // 6×6 ECI (km, km/s)
    CovarianceMatrix covariance_ric; // 6×6 RIC (km, km/s)
};

/**
 * Propagate GP element with covariance to a target epoch.
 *
 * @param gp        GP element
 * @param P0        Initial covariance (ECI). If zero, estimates from history.
 * @param target_jd Target Julian date
 * @return          State + covariance at target epoch (both ECI and RIC)
 */
StateWithCovariance propagate_with_covariance(
    const GPElement& gp, const CovarianceMatrix& P0, double target_jd);

/**
 * Propagate GP element over time range, outputting state + covariance.
 *
 * @param gp      GP element
 * @param P0      Initial covariance
 * @param config  Propagation time range and step
 * @return        Vector of (state, covariance) at each step
 */
std::vector<StateWithCovariance> propagate_with_covariance_series(
    const GPElement& gp, const CovarianceMatrix& P0,
    const PropagationConfig& config);

// ─── Matrix Utilities ───

Matrix6x6 identity_6x6();
Matrix6x6 multiply_6x6(const Matrix6x6& A, const Matrix6x6& B);
Matrix6x6 transpose_6x6(const Matrix6x6& A);
Matrix3x3 multiply_3x3(const Matrix3x3& A, const Matrix3x3& B);
Matrix3x3 transpose_3x3(const Matrix3x3& A);
Matrix3x3 invert_3x3(const Matrix3x3& A);
double determinant_3x3(const Matrix3x3& A);

}  // namespace sgp4_prop

#endif  // SGP4_LAMBERT_STM_H
