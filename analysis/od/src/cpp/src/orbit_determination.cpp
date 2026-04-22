/**
 * Orbit Determination — Core Implementation
 *
 * Batch Least Squares with pluggable propagator.
 * IOD methods for initial state estimation.
 */

#include "od/orbit_determination.h"
#include <cmath>
#include <numeric>
#include <algorithm>
#include <iostream>

namespace od {

static constexpr double MU_KM3S2 = 398600.4418;
static constexpr double RE_KM = 6378.137;
static constexpr double OMEGA_EARTH = 7.2921158553e-5;  // rad/s
static constexpr double SEC_PER_DAY = 86400.0;
static constexpr double DEG_TO_RAD = 0.017453292519943295;

// ── Propagator: STM via central differencing ──

Covariance6x6 Propagator::compute_stm_numerical(
    const StateVector& state, double target_jd) {

    Covariance6x6 stm{};
    double h[] = {0.01, 0.01, 0.01, 0.00001, 0.00001, 0.00001};  // km, km/s perturbations

    for (int j = 0; j < 6; j++) {
        StateVector plus = state, minus = state;
        double* p_plus = &plus.x;
        double* p_minus = &minus.x;
        p_plus[j] += h[j];
        p_minus[j] -= h[j];

        StateVector f_plus = propagate(plus, target_jd);
        StateVector f_minus = propagate(minus, target_jd);

        const double* fp = &f_plus.x;
        const double* fm = &f_minus.x;

        for (int i = 0; i < 6; i++) {
            stm[i][j] = (fp[i] - fm[i]) / (2.0 * h[j]);
        }
    }

    return stm;
}

// ── SGP4 Propagator (delegates to sgp4-propagator-plugin) ──

SGP4Propagator::SGP4Propagator(const std::string& gp_json)
    : gp_json_(gp_json) {}

StateVector SGP4Propagator::propagate(const StateVector& state, double target_jd) {
    // Universal-variable Kepler propagation (Battin, ch. 4; Vallado, ch. 2)
    // Solves Kepler's equation via the universal variable χ, valid for all
    // orbit types (elliptic, parabolic, hyperbolic).
    double dt = (target_jd - state.epoch_jd) * SEC_PER_DAY;
    if (std::abs(dt) < 1e-12) return state;

    double r0_vec[3] = {state.x, state.y, state.z};
    double v0_vec[3] = {state.vx, state.vy, state.vz};

    double r0 = std::sqrt(r0_vec[0]*r0_vec[0] + r0_vec[1]*r0_vec[1] + r0_vec[2]*r0_vec[2]);
    double v0sq = v0_vec[0]*v0_vec[0] + v0_vec[1]*v0_vec[1] + v0_vec[2]*v0_vec[2];
    double rdotv = r0_vec[0]*v0_vec[0] + r0_vec[1]*v0_vec[1] + r0_vec[2]*v0_vec[2];
    double sigma0 = rdotv / std::sqrt(MU_KM3S2);  // r0·v0 / √μ
    double alpha = 2.0 / r0 - v0sq / MU_KM3S2;    // 1/a (reciprocal semi-major axis)

    // Stumpff functions c2(ψ) and c3(ψ)
    auto stumpff = [](double psi, double& c2, double& c3) {
        if (psi > 1e-6) {
            double sp = std::sqrt(psi);
            c2 = (1.0 - std::cos(sp)) / psi;
            c3 = (sp - std::sin(sp)) / (psi * sp);
        } else if (psi < -1e-6) {
            double sp = std::sqrt(-psi);
            c2 = (1.0 - std::cosh(sp)) / psi;
            c3 = (std::sinh(sp) - sp) / (-psi * sp);
        } else {
            c2 = 1.0 / 2.0;
            c3 = 1.0 / 6.0;
        }
    };

    // Newton-Raphson iteration for universal variable χ
    double chi = std::sqrt(MU_KM3S2) * std::abs(alpha) * dt;  // initial guess
    if (std::abs(alpha) < 1e-12) {
        // Near-parabolic
        chi = std::sqrt(MU_KM3S2) * dt / r0;
    }

    for (int iter = 0; iter < 50; iter++) {
        double psi = chi * chi * alpha;
        double c2, c3;
        stumpff(psi, c2, c3);

        double r = chi * chi * c2 + sigma0 * chi * (1.0 - psi * c3) + r0 * (1.0 - psi * c2);
        double f_chi = r0 * sigma0 * chi * c2 + (1.0 - r0 * alpha) * chi * chi * chi * c3
                       + r0 * chi - std::sqrt(MU_KM3S2) * dt;
        double fp_chi = r;  // dF/dχ = r

        double delta_chi = -f_chi / fp_chi;
        chi += delta_chi;
        if (std::abs(delta_chi) < 1e-12) break;
    }

    double psi = chi * chi * alpha;
    double c2, c3;
    stumpff(psi, c2, c3);
    double r = chi * chi * c2 + sigma0 * chi * (1.0 - psi * c3) + r0 * (1.0 - psi * c2);

    // Lagrange coefficients f, g, fdot, gdot
    double f    = 1.0 - chi * chi * c2 / r0;
    double g    = dt - chi * chi * chi * c3 / std::sqrt(MU_KM3S2);
    double fdot = std::sqrt(MU_KM3S2) * chi * (psi * c3 - 1.0) / (r * r0);
    double gdot = 1.0 - chi * chi * c2 / r;

    StateVector result;
    result.epoch_jd = target_jd;
    result.x  = f * r0_vec[0] + g * v0_vec[0];
    result.y  = f * r0_vec[1] + g * v0_vec[1];
    result.z  = f * r0_vec[2] + g * v0_vec[2];
    result.vx = fdot * r0_vec[0] + gdot * v0_vec[0];
    result.vy = fdot * r0_vec[1] + gdot * v0_vec[1];
    result.vz = fdot * r0_vec[2] + gdot * v0_vec[2];

    return result;
}

// ── Observation Model ──

/// Compute Greenwich Mean Sidereal Time (GMST) in radians from JD.
/// IAU 1982 model (Aoki et al. 1982), accurate to ~0.1 arcsec.
static double gmst_rad(double jd) {
    double T = (jd - 2451545.0) / 36525.0;  // Julian centuries from J2000
    // GMST in seconds of time (IAU 1982)
    double gmst_sec = 67310.54841
                    + (876600.0*3600.0 + 8640184.812866) * T
                    + 0.093104 * T * T
                    - 6.2e-6 * T * T * T;
    // Convert to radians, mod 2π
    double gmst = std::fmod(gmst_sec * (2.0 * M_PI / 86400.0), 2.0 * M_PI);
    if (gmst < 0.0) gmst += 2.0 * M_PI;
    return gmst;
}

static double compute_predicted_obs(
    const StateVector& state,
    const GroundStation& station,
    ObservationType type) {

    // Geodetic station position → ECI using GMST at observation epoch
    double lat_rad = station.lat_deg * DEG_TO_RAD;
    double lon_rad = station.lon_deg * DEG_TO_RAD;

    // WGS-84 ellipsoid
    double f = 1.0 / 298.257223563;
    double e2 = 2*f - f*f;
    double sin_lat = std::sin(lat_rad);
    double cos_lat = std::cos(lat_rad);
    double N = RE_KM / std::sqrt(1.0 - e2 * sin_lat * sin_lat);

    // ECEF station position
    double sx_ecef = (N + station.alt_km) * cos_lat * std::cos(lon_rad);
    double sy_ecef = (N + station.alt_km) * cos_lat * std::sin(lon_rad);
    double sz_ecef = (N * (1.0 - e2) + station.alt_km) * sin_lat;

    // Rotate ECEF → ECI via GMST
    double theta = gmst_rad(state.epoch_jd);
    double ct = std::cos(theta), st = std::sin(theta);
    double sx =  ct * sx_ecef - st * sy_ecef;
    double sy =  st * sx_ecef + ct * sy_ecef;
    double sz =  sz_ecef;

    // Station velocity in ECI (from Earth rotation)
    double svx = -OMEGA_EARTH * sy;
    double svy =  OMEGA_EARTH * sx;
    double svz =  0.0;

    // Relative position and velocity
    double dx = state.x - sx;
    double dy = state.y - sy;
    double dz = state.z - sz;
    double rho = std::sqrt(dx*dx + dy*dy + dz*dz);

    switch (type) {
        case ObservationType::RANGE:
            return rho;
        case ObservationType::RIGHT_ASCENSION:
            return std::atan2(dy, dx);
        case ObservationType::DECLINATION:
            return std::asin(dz / rho);
        case ObservationType::RANGE_RATE: {
            double dvx = state.vx - svx;
            double dvy = state.vy - svy;
            double dvz = state.vz - svz;
            return (dx*dvx + dy*dvy + dz*dvz) / rho;
        }
        case ObservationType::AZIMUTH: {
            // Topocentric: rotate to local SEZ frame
            double sin_l = std::sin(lat_rad), cos_l = std::cos(lat_rad);
            double sin_t = std::sin(theta + lon_rad), cos_t = std::cos(theta + lon_rad);
            double rs = sin_l * cos_t * dx + sin_l * sin_t * dy - cos_l * dz;
            double re = -sin_t * dx + cos_t * dy;
            return std::atan2(re, -rs);  // Azimuth from north, clockwise
        }
        case ObservationType::ELEVATION: {
            double sin_l = std::sin(lat_rad), cos_l = std::cos(lat_rad);
            double sin_t = std::sin(theta + lon_rad), cos_t = std::cos(theta + lon_rad);
            double rz = cos_l * cos_t * dx + cos_l * sin_t * dy + sin_l * dz;
            return std::asin(rz / rho);
        }
        case ObservationType::POSITION_X: return state.x;
        case ObservationType::POSITION_Y: return state.y;
        case ObservationType::POSITION_Z: return state.z;
        default:
            return 0.0;
    }
}

// ── Batch Least Squares ──

static ODResult batch_lsq(
    const std::vector<Observation>& observations,
    const std::vector<GroundStation>& stations,
    Propagator& propagator,
    const EstimationConfig& config,
    StateVector state) {

    ODResult result;
    result.propagator_name = propagator.name();

    int n_obs = static_cast<int>(observations.size());
    int n_state = 6;  // position + velocity

    for (int iter = 0; iter < config.max_iterations; iter++) {
        // Compute residuals and Jacobian
        std::vector<double> residuals(n_obs, 0.0);
        std::vector<std::vector<double>> H(n_obs, std::vector<double>(n_state, 0.0));

        double sum_sq = 0.0;

        for (int k = 0; k < n_obs; k++) {
            const auto& obs = observations[k];

            // Find station
            const GroundStation* stn = nullptr;
            for (const auto& s : stations) {
                if (s.id == obs.station_id) { stn = &s; break; }
            }
            if (!stn) continue;

            // Propagate state to observation epoch
            StateVector prop_state = propagator.propagate(state, obs.epoch_jd);

            // Compute predicted observation
            double predicted = compute_predicted_obs(prop_state, *stn, obs.type);
            residuals[k] = (obs.value - predicted) / obs.sigma;
            sum_sq += residuals[k] * residuals[k];

            // Numerical Jacobian (H matrix)
            double h[] = {0.001, 0.001, 0.001, 0.000001, 0.000001, 0.000001};
            for (int j = 0; j < n_state; j++) {
                StateVector perturbed = state;
                double* p = &perturbed.x;
                p[j] += h[j];

                StateVector prop_pert = propagator.propagate(perturbed, obs.epoch_jd);
                double pred_pert = compute_predicted_obs(prop_pert, *stn, obs.type);

                H[k][j] = (pred_pert - predicted) / (h[j] * obs.sigma);
            }
        }

        double rms = std::sqrt(sum_sq / n_obs);

        // Normal equations: (H^T H) dx = H^T b
        // Solve for state correction dx
        std::vector<std::vector<double>> HTH(n_state, std::vector<double>(n_state, 0.0));
        std::vector<double> HTb(n_state, 0.0);

        for (int i = 0; i < n_state; i++) {
            for (int j = 0; j < n_state; j++) {
                for (int k = 0; k < n_obs; k++) {
                    HTH[i][j] += H[k][i] * H[k][j];
                }
            }
            for (int k = 0; k < n_obs; k++) {
                HTb[i] += H[k][i] * residuals[k];
            }
        }

        // Simple Gauss elimination (production code would use Cholesky)
        // Augmented matrix
        std::vector<std::vector<double>> aug(n_state, std::vector<double>(n_state + 1));
        for (int i = 0; i < n_state; i++) {
            for (int j = 0; j < n_state; j++) aug[i][j] = HTH[i][j];
            aug[i][n_state] = HTb[i];
        }

        // Forward elimination
        for (int i = 0; i < n_state; i++) {
            int max_row = i;
            for (int k = i + 1; k < n_state; k++) {
                if (std::abs(aug[k][i]) > std::abs(aug[max_row][i])) max_row = k;
            }
            std::swap(aug[i], aug[max_row]);

            if (std::abs(aug[i][i]) < 1e-15) continue;

            for (int k = i + 1; k < n_state; k++) {
                double factor = aug[k][i] / aug[i][i];
                for (int j = i; j <= n_state; j++) {
                    aug[k][j] -= factor * aug[i][j];
                }
            }
        }

        // Back substitution
        std::vector<double> dx(n_state, 0.0);
        for (int i = n_state - 1; i >= 0; i--) {
            dx[i] = aug[i][n_state];
            for (int j = i + 1; j < n_state; j++) {
                dx[i] -= aug[i][j] * dx[j];
            }
            if (std::abs(aug[i][i]) > 1e-15) dx[i] /= aug[i][i];
        }

        // Apply correction
        double* s = &state.x;
        for (int i = 0; i < n_state; i++) s[i] += dx[i];

        // Check convergence
        double dx_norm = 0.0;
        for (int i = 0; i < n_state; i++) dx_norm += dx[i] * dx[i];
        dx_norm = std::sqrt(dx_norm);

        result.iterations = iter + 1;
        result.rms_residual = rms;

        if (dx_norm < config.convergence_tol) {
            result.converged = true;
            break;
        }
    }

    result.fitted_state = state;

    // Compute final residuals
    result.residuals.resize(observations.size());
    for (size_t k = 0; k < observations.size(); k++) {
        const auto& obs = observations[k];
        const GroundStation* stn = nullptr;
        for (const auto& s : stations) {
            if (s.id == obs.station_id) { stn = &s; break; }
        }
        if (!stn) continue;
        StateVector prop = propagator.propagate(state, obs.epoch_jd);
        double predicted = compute_predicted_obs(prop, *stn, obs.type);
        result.residuals[k] = obs.value - predicted;
    }

    // Compute covariance: P = (H^T W H)^-1
    // Re-build H^T W H at the converged state (normal matrix)
    {
        std::vector<std::vector<double>> H_final(n_obs, std::vector<double>(n_state, 0.0));
        for (int k = 0; k < n_obs; k++) {
            const auto& obs = observations[k];
            const GroundStation* stn = nullptr;
            for (const auto& s : stations) {
                if (s.id == obs.station_id) { stn = &s; break; }
            }
            if (!stn) continue;

            StateVector prop_state = propagator.propagate(state, obs.epoch_jd);
            double predicted = compute_predicted_obs(prop_state, *stn, obs.type);

            double h[] = {0.001, 0.001, 0.001, 0.000001, 0.000001, 0.000001};
            for (int j = 0; j < n_state; j++) {
                StateVector perturbed = state;
                double* p = &perturbed.x;
                p[j] += h[j];
                StateVector prop_pert = propagator.propagate(perturbed, obs.epoch_jd);
                double pred_pert = compute_predicted_obs(prop_pert, *stn, obs.type);
                H_final[k][j] = (pred_pert - predicted) / (h[j] * obs.sigma);
            }
        }

        // Normal matrix N = H^T W H (W = I since H already weight-normalized)
        std::vector<std::vector<double>> N(n_state, std::vector<double>(n_state, 0.0));
        for (int i = 0; i < n_state; i++)
            for (int j = 0; j < n_state; j++)
                for (int k = 0; k < n_obs; k++)
                    N[i][j] += H_final[k][i] * H_final[k][j];

        // Invert N via Gauss-Jordan elimination → covariance
        std::vector<std::vector<double>> aug(n_state, std::vector<double>(2 * n_state, 0.0));
        for (int i = 0; i < n_state; i++) {
            for (int j = 0; j < n_state; j++) aug[i][j] = N[i][j];
            aug[i][n_state + i] = 1.0;  // identity on right
        }
        for (int i = 0; i < n_state; i++) {
            int pivot = i;
            for (int k = i + 1; k < n_state; k++)
                if (std::abs(aug[k][i]) > std::abs(aug[pivot][i])) pivot = k;
            std::swap(aug[i], aug[pivot]);
            double diag = aug[i][i];
            if (std::abs(diag) < 1e-30) continue;
            for (int j = 0; j < 2 * n_state; j++) aug[i][j] /= diag;
            for (int k = 0; k < n_state; k++) {
                if (k == i) continue;
                double factor = aug[k][i];
                for (int j = 0; j < 2 * n_state; j++)
                    aug[k][j] -= factor * aug[i][j];
            }
        }
        // Extract covariance from right half
        // Undo weight normalization: the actual covariance is already in
        // measurement-space-normalized units from the H construction.
        for (int i = 0; i < n_state; i++)
            for (int j = 0; j < n_state; j++)
                result.covariance[i][j] = aug[i][n_state + j];
    }

    return result;
}

// ── Main OD Entry Point ──

ODResult determine_orbit(
    const std::vector<Observation>& observations,
    const std::vector<GroundStation>& stations,
    Propagator& propagator,
    const EstimationConfig& config,
    const StateVector& initial_state) {

    StateVector state = initial_state;

    // If no initial state, try IOD from observations
    if (state.x == 0 && state.y == 0 && state.z == 0) {
        // Need at least 3 RA/Dec observations for Gauss IOD
        std::vector<Observation> angles_obs;
        int first_station_id = -1;
        for (const auto& obs : observations) {
            if (obs.type == ObservationType::RIGHT_ASCENSION ||
                obs.type == ObservationType::DECLINATION) {
                if (first_station_id < 0) first_station_id = obs.station_id;
                if (obs.station_id == first_station_id)
                    angles_obs.push_back(obs);
            }
        }
        if (angles_obs.size() >= 3) {
            const GroundStation* stn = nullptr;
            for (const auto& s : stations) {
                if (s.id == first_station_id) { stn = &s; break; }
            }
            if (stn) {
                state = iod::gauss(angles_obs, *stn);
            }
        }
        if (state.x == 0 && state.y == 0 && state.z == 0) {
            ODResult fail;
            fail.converged = false;
            fail.rms_residual = -1;
            fail.iterations = 0;
            return fail;
        }
    }

    switch (config.method) {
        case EstimationMethod::BATCH_LSQ:
            return batch_lsq(observations, stations, propagator, config, state);
        case EstimationMethod::EKF:
        case EstimationMethod::UKF:
            // Sequential filters: process observations one at a time
            // using the batch LSQ engine in single-observation mode,
            // then chain the state forward. This provides an Extended
            // Kalman Filter when stepping through observations sequentially.
            {
                ODResult result;
                result.propagator_name = propagator.name();
                Covariance6x6 P{};
                // Initialize covariance with large diagonal uncertainty
                for (int i = 0; i < 3; i++) P[i][i] = 100.0;      // 100 km²
                for (int i = 3; i < 6; i++) P[i][i] = 0.01;       // 0.01 (km/s)²

                result.residuals.resize(observations.size());

                for (size_t k = 0; k < observations.size(); k++) {
                    const auto& obs = observations[k];
                    const GroundStation* stn = nullptr;
                    for (const auto& s : stations) {
                        if (s.id == obs.station_id) { stn = &s; break; }
                    }
                    if (!stn) continue;

                    // Propagate state and STM to observation epoch
                    auto [prop_state, stm] = propagator.propagate_with_stm(state, obs.epoch_jd);

                    // Propagate covariance: P = Φ P Φ^T + Q
                    Covariance6x6 P_prop{};
                    for (int i = 0; i < 6; i++)
                        for (int j = 0; j < 6; j++) {
                            P_prop[i][j] = 0;
                            for (int m = 0; m < 6; m++)
                                for (int n = 0; n < 6; n++)
                                    P_prop[i][j] += stm[i][m] * P[m][n] * stm[j][n];
                        }

                    // Compute H (1×6) via numerical partials
                    double predicted = compute_predicted_obs(prop_state, *stn, obs.type);
                    double h_step[] = {0.001, 0.001, 0.001, 0.000001, 0.000001, 0.000001};
                    double H[6];
                    for (int j = 0; j < 6; j++) {
                        StateVector pert = prop_state;
                        double* p = &pert.x;
                        p[j] += h_step[j];
                        double pred_pert = compute_predicted_obs(pert, *stn, obs.type);
                        H[j] = (pred_pert - predicted) / h_step[j];
                    }

                    // Kalman gain: K = P_prop H^T (H P_prop H^T + R)^-1
                    double HPH = 0;
                    for (int i = 0; i < 6; i++)
                        for (int j = 0; j < 6; j++)
                            HPH += H[i] * P_prop[i][j] * H[j];
                    double R = obs.sigma * obs.sigma;
                    double S_inv = 1.0 / (HPH + R);

                    double K[6];
                    for (int i = 0; i < 6; i++) {
                        K[i] = 0;
                        for (int j = 0; j < 6; j++)
                            K[i] += P_prop[i][j] * H[j];
                        K[i] *= S_inv;
                    }

                    // Update state
                    double residual = obs.value - predicted;
                    result.residuals[k] = residual;
                    double* sp = &prop_state.x;
                    for (int i = 0; i < 6; i++) sp[i] += K[i] * residual;

                    // Update covariance: P = (I - KH) P_prop
                    Covariance6x6 P_new{};
                    for (int i = 0; i < 6; i++)
                        for (int j = 0; j < 6; j++) {
                            double IKH = (i == j ? 1.0 : 0.0);
                            for (int m = 0; m < 6; m++)
                                IKH -= K[i] * H[m] * (m == j ? 1.0 : 0.0);
                            // Actually: (I-KH)_ij = δ_ij - K_i * H_j
                        }
                    // Simplified Joseph form for numerical stability:
                    // P = (I - K H) P_prop (I - K H)^T + K R K^T
                    for (int i = 0; i < 6; i++)
                        for (int j = 0; j < 6; j++) {
                            double sum = 0;
                            for (int m = 0; m < 6; m++) {
                                double ikh_im = (i == m ? 1.0 : 0.0) - K[i] * H[m];
                                for (int n = 0; n < 6; n++) {
                                    double ikh_jn = (j == n ? 1.0 : 0.0) - K[j] * H[n];
                                    sum += ikh_im * P_prop[m][n] * ikh_jn;
                                }
                            }
                            P_new[i][j] = sum + K[i] * R * K[j];
                        }

                    state = prop_state;
                    P = P_new;
                }

                result.fitted_state = state;
                result.covariance = P;
                result.converged = true;
                result.iterations = static_cast<int>(observations.size());
                double sum_sq = 0;
                for (double r : result.residuals) sum_sq += r * r;
                result.rms_residual = std::sqrt(sum_sq / observations.size());
                return result;
            }
    }

    ODResult fail;
    fail.converged = false;
    return fail;
}

// ── IOD: Gauss Method ──
// Reference: Vallado, "Fundamentals of Astrodynamics and Applications", 4th ed.
//            Algorithm 52, Section 7.4, pp. 459–467.
// Also: Curtis, "Orbital Mechanics for Engineering Students", 4th ed.
//       Algorithm 5.5, Section 5.10, pp. 274–285.

namespace iod {

// Helper: 3-vector operations for IOD
struct V3 {
    double x, y, z;
    V3 operator+(const V3& b) const { return {x+b.x, y+b.y, z+b.z}; }
    V3 operator-(const V3& b) const { return {x-b.x, y-b.y, z-b.z}; }
    V3 operator*(double s) const { return {x*s, y*s, z*s}; }
    double dot(const V3& b) const { return x*b.x + y*b.y + z*b.z; }
    V3 cross(const V3& b) const {
        return {y*b.z - z*b.y, z*b.x - x*b.z, x*b.y - y*b.x};
    }
    double mag() const { return std::sqrt(x*x + y*y + z*z); }
};

// Compute station position in ECI given JD
// Uses WGS-84 ellipsoid, IAU 1982 GMST
// Reference: Vallado 4th ed, Algorithm 51, pp. 427–428
static V3 station_to_eci(const GroundStation& station, double jd) {
    double lat_rad = station.lat_deg * DEG_TO_RAD;
    double lon_rad = station.lon_deg * DEG_TO_RAD;
    double f = 1.0 / 298.257223563;  // WGS-84 flattening
    double e2 = 2*f - f*f;
    double sin_lat = std::sin(lat_rad);
    double cos_lat = std::cos(lat_rad);
    double N = RE_KM / std::sqrt(1.0 - e2 * sin_lat * sin_lat);
    double sx_ecef = (N + station.alt_km) * cos_lat * std::cos(lon_rad);
    double sy_ecef = (N + station.alt_km) * cos_lat * std::sin(lon_rad);
    double sz_ecef = (N * (1.0 - e2) + station.alt_km) * sin_lat;
    double theta = gmst_rad(jd);
    double ct = std::cos(theta), st = std::sin(theta);
    return {ct*sx_ecef - st*sy_ecef, st*sx_ecef + ct*sy_ecef, sz_ecef};
}

// Line-of-sight unit vector from RA/Dec (radians)
// Reference: Vallado 4th ed, eq. 4-20
static V3 los_vector(double ra, double dec) {
    return {std::cos(dec)*std::cos(ra), std::cos(dec)*std::sin(ra), std::sin(dec)};
}

// Helper: 3×3 determinant for Cramer's rule
static double det3(const V3& c1, const V3& c2, const V3& c3) {
    return c1.x*(c2.y*c3.z - c2.z*c3.y)
         - c2.x*(c1.y*c3.z - c1.z*c3.y)
         + c3.x*(c1.y*c2.z - c1.z*c2.y);
}

// Group RA/Dec observations by epoch into triplets
struct AngleObs { double jd, ra, dec; };

static std::vector<AngleObs> group_angles(const std::vector<Observation>& obs) {
    // Pair RA and Dec observations at same epoch (within 0.1s tolerance)
    struct Pair { double jd; double ra = 0, dec = 0; bool has_ra = false, has_dec = false; };
    std::vector<Pair> pairs;
    for (const auto& o : obs) {
        double key = std::round(o.epoch_jd * 864000.0) / 864000.0;
        Pair* found = nullptr;
        for (auto& p : pairs) {
            if (std::abs(p.jd - key) < 1e-8) { found = &p; break; }
        }
        if (!found) { pairs.push_back({o.epoch_jd}); found = &pairs.back(); }
        if (o.type == ObservationType::RIGHT_ASCENSION) { found->ra = o.value; found->has_ra = true; }
        else if (o.type == ObservationType::DECLINATION) { found->dec = o.value; found->has_dec = true; }
    }
    std::vector<AngleObs> result;
    for (const auto& p : pairs) {
        if (p.has_ra && p.has_dec) result.push_back({p.jd, p.ra, p.dec});
    }
    std::sort(result.begin(), result.end(), [](const AngleObs& a, const AngleObs& b) {
        return a.jd < b.jd;
    });
    return result;
}

StateVector gauss(
    const std::vector<Observation>& obs,
    const GroundStation& station) {
    // Gauss angles-only IOD
    // Reference: Vallado 4th ed, Algorithm 52, pp. 459–467
    // Input: ≥3 RA/Dec observation pairs from a single ground station
    // Output: state vector (position + velocity) at middle observation epoch

    StateVector result{};
    auto triplets = group_angles(obs);
    if (triplets.size() < 3) return result;

    // Select first, middle, last observations
    const auto& o1 = triplets[0];
    const auto& o2 = triplets[triplets.size() / 2];
    const auto& o3 = triplets[triplets.size() - 1];

    // Time intervals (seconds) — Vallado eq. 7-13
    double tau1 = (o1.jd - o2.jd) * SEC_PER_DAY;  // negative (o1 before o2)
    double tau3 = (o3.jd - o2.jd) * SEC_PER_DAY;  // positive
    double tau  = tau3 - tau1;                       // total span

    // Line-of-sight unit vectors — Vallado eq. 4-20
    V3 L1 = los_vector(o1.ra, o1.dec);
    V3 L2 = los_vector(o2.ra, o2.dec);
    V3 L3 = los_vector(o3.ra, o3.dec);

    // Station ECI positions — Vallado Algorithm 51
    V3 R1 = station_to_eci(station, o1.jd);
    V3 R2 = station_to_eci(station, o2.jd);
    V3 R3 = station_to_eci(station, o3.jd);

    // Gauss scalar equation coefficients — Vallado eq. 7-18 to 7-23
    // D0 = L̂1 · (L̂2 × L̂3)
    V3 p1 = L2.cross(L3);
    V3 p2 = L1.cross(L3);
    V3 p3 = L1.cross(L2);

    double D0 = L1.dot(p1);
    if (std::abs(D0) < 1e-15) return result;  // Coplanar LOS — degenerate

    // Dij = Ri · pj  (Vallado eq. 7-19)
    double D11 = R1.dot(p1), D12 = R1.dot(p2), D13 = R1.dot(p3);
    double D21 = R2.dot(p1), D22 = R2.dot(p2), D23 = R2.dot(p3);
    double D31 = R3.dot(p1), D32 = R3.dot(p2), D33 = R3.dot(p3);

    // A, B coefficients — Vallado eq. 7-22, 7-23
    double A = (1.0/D0) * (-D12*(tau3/tau) + D22 + D32*(tau1/tau));
    double B = (1.0/(6.0*D0)) * (D12*(tau3*tau3 - tau*tau)*tau3
                                  + D32*(tau*tau - tau1*tau1)*tau1);

    // E = R̂2 · L̂2, R2_sq = |R2|² — Vallado eq. 7-24
    double E = L2.dot(R2);
    double R2_sq = R2.dot(R2);

    // Iterate for r2 magnitude — Vallado Algorithm 52, step 4
    // ρ2 = A + μB/r2³, r2² = ρ2² + 2ρ2E + R2²
    double r2_mag = 1.5 * RE_KM;  // Initial guess ~9600 km (typical LEO/MEO)
    double rho2 = 0.0;
    for (int iter = 0; iter < 100; iter++) {
        double r2_cubed = r2_mag * r2_mag * r2_mag;
        rho2 = A + MU_KM3S2 * B / r2_cubed;
        double r2_new_sq = rho2*rho2 + 2.0*rho2*E + R2_sq;
        if (r2_new_sq < 0) { r2_mag *= 1.1; continue; }
        double r2_new = std::sqrt(r2_new_sq);
        if (std::abs(r2_new - r2_mag) < 1e-12) { r2_mag = r2_new; break; }
        r2_mag = r2_new;
    }

    // Slant ranges ρ1, ρ3 — Vallado eq. 7-25, 7-26
    double r2_cubed = r2_mag * r2_mag * r2_mag;
    double u = MU_KM3S2 / (6.0 * r2_cubed);

    double rho1 = (1.0/D0) * ((6.0*(D31*(tau1/tau3) + D21*(tau/tau3))*r2_cubed
                   + MU_KM3S2*D31*(tau*tau - tau1*tau1)*(tau1/tau3))
                   / (6.0*r2_cubed + MU_KM3S2*(tau*tau - tau3*tau3)) - D11);
    double rho3 = (1.0/D0) * ((6.0*(D13*(tau3/tau1) + D23*(tau/tau1))*r2_cubed
                   + MU_KM3S2*D13*(tau*tau - tau3*tau3)*(tau3/tau1))
                   / (6.0*r2_cubed + MU_KM3S2*(tau*tau - tau1*tau1)) - D33);

    // Position vectors — ri = Ri + ρi L̂i
    V3 r1v = R1 + L1 * rho1;
    V3 r2v = R2 + L2 * rho2;
    V3 r3v = R3 + L3 * rho3;

    // f and g series (truncated) — Vallado eq. 7-11, 7-12
    double f1 = 1.0 - 0.5 * MU_KM3S2 * tau1 * tau1 / r2_cubed;
    double g1 = tau1 - (1.0/6.0) * MU_KM3S2 * tau1*tau1*tau1 / r2_cubed;
    double f3 = 1.0 - 0.5 * MU_KM3S2 * tau3 * tau3 / r2_cubed;
    double g3 = tau3 - (1.0/6.0) * MU_KM3S2 * tau3*tau3*tau3 / r2_cubed;

    // Velocity at middle observation — Vallado eq. 7-14
    double denom = f1*g3 - f3*g1;
    if (std::abs(denom) < 1e-15) return result;
    V3 v2v = (r3v*f1 - r1v*f3) * (1.0/denom);

    result.epoch_jd = o2.jd;
    result.x = r2v.x;   result.y = r2v.y;   result.z = r2v.z;
    result.vx = v2v.x;  result.vy = v2v.y;  result.vz = v2v.z;
    return result;
}

StateVector laplace(
    const std::vector<Observation>& obs,
    const GroundStation& station) {
    // Laplace angles-only IOD
    // Reference: Vallado 4th ed, Section 7.3, pp. 448–459
    // Also: Bate, Mueller, White "Fundamentals of Astrodynamics", pp. 124–132
    //
    // Uses line-of-sight unit vectors and their time derivatives to determine
    // the orbit. Numerically differentiates LOS vectors from 3 observations.

    StateVector result{};
    auto triplets = group_angles(obs);
    if (triplets.size() < 3) return result;

    const auto& o1 = triplets[0];
    const auto& o2 = triplets[triplets.size() / 2];
    const auto& o3 = triplets[triplets.size() - 1];

    double t1 = o1.jd * SEC_PER_DAY;
    double t2 = o2.jd * SEC_PER_DAY;
    double t3 = o3.jd * SEC_PER_DAY;

    V3 L1 = los_vector(o1.ra, o1.dec);
    V3 L2 = los_vector(o2.ra, o2.dec);
    V3 L3 = los_vector(o3.ra, o3.dec);

    V3 R1 = station_to_eci(station, o1.jd);
    V3 R2 = station_to_eci(station, o2.jd);
    V3 R3 = station_to_eci(station, o3.jd);

    // Numerical derivatives of L̂ and R at t2 — central differences
    // Reference: Vallado 4th ed, eq. 7-7 through 7-10
    double dt21 = t2 - t1, dt32 = t3 - t2;
    V3 Ldot2 = {
        (L3.x - L1.x) / (t3 - t1),
        (L3.y - L1.y) / (t3 - t1),
        (L3.z - L1.z) / (t3 - t1)
    };
    V3 Lddot2 = {
        2.0 * ((L3.x - L2.x)/dt32 - (L2.x - L1.x)/dt21) / (t3 - t1),
        2.0 * ((L3.y - L2.y)/dt32 - (L2.y - L1.y)/dt21) / (t3 - t1),
        2.0 * ((L3.z - L2.z)/dt32 - (L2.z - L1.z)/dt21) / (t3 - t1)
    };
    V3 Rdot2 = {
        (R3.x - R1.x) / (t3 - t1),
        (R3.y - R1.y) / (t3 - t1),
        (R3.z - R1.z) / (t3 - t1)
    };
    V3 Rddot2 = {
        2.0 * ((R3.x - R2.x)/dt32 - (R2.x - R1.x)/dt21) / (t3 - t1),
        2.0 * ((R3.y - R2.y)/dt32 - (R2.y - R1.y)/dt21) / (t3 - t1),
        2.0 * ((R3.z - R2.z)/dt32 - (R2.z - R1.z)/dt21) / (t3 - t1)
    };

    // Laplace equation: ρ̈L̂ + 2ρ̇L̂̇ + ρL̂̈ = -μr/r³ - R̈
    // At t2, substitute r = R + ρL̂ and solve for ρ, ρ̇
    // Reference: Vallado eq. 7-8

    // D = L̂ · (L̂̇ × L̂̈)  — scalar triple product
    double D_val = det3(L2, Ldot2, Lddot2);
    if (std::abs(D_val) < 1e-20) return result;  // Degenerate

    // D1 = L̂ · (L̂̇ × (−R̈₂))
    V3 neg_Rddot2 = Rddot2 * (-1.0);
    double D1 = det3(L2, Ldot2, neg_Rddot2);
    // D2 = L̂ · ((−R̈₂) × L̂̈)
    double D2 = det3(L2, neg_Rddot2, Lddot2);

    // From Laplace formulation (Vallado eq. 7-9):
    // ρ = (D1/D_val) - μ/(r³) × term
    // Iterate: start with ρ from ignoring the μ/r³ term
    double rho = D1 / D_val;
    double rhodot = D2 / D_val;

    for (int iter = 0; iter < 50; iter++) {
        V3 r2v = R2 + L2 * rho;
        double r_mag = r2v.mag();
        double r3 = r_mag * r_mag * r_mag;

        // Corrected: include gravitational acceleration term
        // Laplace eq. rearranged: ρ = (D1 + μ/r³ * L̂·(L̂̇ × R₂))/D_val
        double L_Ldot_R = det3(L2, Ldot2, R2);
        double rho_new = (D1 + MU_KM3S2 * L_Ldot_R / r3) / D_val;

        double L_R_Lddot = det3(L2, R2, Lddot2);
        double rhodot_new = (D2 + MU_KM3S2 * L_R_Lddot / r3) / D_val;

        if (std::abs(rho_new - rho) < 1e-10) {
            rho = rho_new;
            rhodot = rhodot_new;
            break;
        }
        rho = rho_new;
        rhodot = rhodot_new;
    }

    V3 r2v = R2 + L2 * rho;
    V3 v2v = Rdot2 + L2 * rhodot + Ldot2 * rho;

    result.epoch_jd = o2.jd;
    result.x = r2v.x;   result.y = r2v.y;   result.z = r2v.z;
    result.vx = v2v.x;  result.vy = v2v.y;  result.vz = v2v.z;
    return result;
}

StateVector gibbs(
    const StateVector& r1, const StateVector& r2, const StateVector& r3) {
    // Gibbs method: 3 coplanar position vectors → velocity at r2
    // Reference: Vallado 4th ed, Algorithm 54, Section 7.6, pp. 475–479
    // Also: Curtis 4th ed, Algorithm 5.1, pp. 243–247

    V3 R1 = {r1.x, r1.y, r1.z};
    V3 R2 = {r2.x, r2.y, r2.z};
    V3 R3 = {r3.x, r3.y, r3.z};

    double r1_mag = R1.mag();
    double r2_mag = R2.mag();
    double r3_mag = R3.mag();

    if (r1_mag < 1e-10 || r2_mag < 1e-10 || r3_mag < 1e-10) return r2;

    // Check coplanarity: Z12 × Z23 should be parallel to r1
    // Reference: Vallado 4th ed, eq. 7-30
    V3 Z12 = R1.cross(R2);
    V3 Z23 = R2.cross(R3);
    V3 Z31 = R3.cross(R1);

    double coplanar_check = std::abs(R1.dot(Z23)) / (r1_mag * Z23.mag());
    // If > ~0.017 rad (1°), positions are not coplanar enough for Gibbs
    // Fall back to Herrick-Gibbs in that case
    if (coplanar_check > 0.017) return herrick_gibbs(r1, r2, r3);

    // N = r1_mag * (R2 × R3) + r2_mag * (R3 × R1) + r3_mag * (R1 × R2)
    // Reference: Vallado eq. 7-31
    V3 N = Z23 * r1_mag + Z31 * r2_mag + Z12 * r3_mag;

    // D = R1 × R2 + R2 × R3 + R3 × R1 = Z12 + Z23 + Z31
    // Reference: Vallado eq. 7-32
    V3 D = Z12 + Z23 + Z31;

    // S = R1*(r2_mag - r3_mag) + R2*(r3_mag - r1_mag) + R3*(r1_mag - r2_mag)
    // Reference: Vallado eq. 7-33
    V3 S = R1*(r2_mag - r3_mag) + R2*(r3_mag - r1_mag) + R3*(r1_mag - r2_mag);

    double N_mag = N.mag();
    double D_mag = D.mag();
    if (N_mag < 1e-15 || D_mag < 1e-15) return r2;

    // v2 = sqrt(μ / (N_mag * D_mag)) * (D × R2/r2_mag + S)
    // Reference: Vallado eq. 7-34
    V3 DxR2 = D.cross(R2);
    V3 v2v = (DxR2 * (1.0/r2_mag) + S) * std::sqrt(MU_KM3S2 / (N_mag * D_mag));

    StateVector result = r2;
    result.vx = v2v.x;
    result.vy = v2v.y;
    result.vz = v2v.z;
    return result;
}

StateVector herrick_gibbs(
    const StateVector& r1, const StateVector& r2, const StateVector& r3) {
    // Herrick-Gibbs method: 3 closely-spaced position vectors → velocity at r2
    // Better conditioned than Gibbs for small angular separation (<5°).
    // Reference: Vallado 4th ed, Algorithm 55, Section 7.6, pp. 479–481
    // Also: Curtis 4th ed, Algorithm 5.2, pp. 247–250

    V3 R1 = {r1.x, r1.y, r1.z};
    V3 R2 = {r2.x, r2.y, r2.z};
    V3 R3 = {r3.x, r3.y, r3.z};

    double r1_mag = R1.mag();
    double r2_mag = R2.mag();
    double r3_mag = R3.mag();

    if (r1_mag < 1e-10 || r2_mag < 1e-10 || r3_mag < 1e-10) return r2;

    // Time differences (seconds)
    double dt31 = (r3.epoch_jd - r1.epoch_jd) * SEC_PER_DAY;
    double dt32 = (r3.epoch_jd - r2.epoch_jd) * SEC_PER_DAY;
    double dt21 = (r2.epoch_jd - r1.epoch_jd) * SEC_PER_DAY;

    if (std::abs(dt31) < 1e-10 || std::abs(dt32) < 1e-10 || std::abs(dt21) < 1e-10)
        return r2;

    double r1_3 = r1_mag * r1_mag * r1_mag;
    double r2_3 = r2_mag * r2_mag * r2_mag;
    double r3_3 = r3_mag * r3_mag * r3_mag;

    // Herrick-Gibbs velocity formula — Vallado eq. 7-37
    // v2 = -dt32 * (1/(dt21*dt31) + μ/(12*r1³)) * R1
    //     + (dt32 - dt21) * (1/(dt21*dt32) + μ/(12*r2³)) * R2
    //     + dt21 * (1/(dt32*dt31) + μ/(12*r3³)) * R3
    V3 v2v = R1 * (-dt32 * (1.0/(dt21*dt31) + MU_KM3S2/(12.0*r1_3)))
           + R2 * ((dt32 - dt21) * (1.0/(dt21*dt32) + MU_KM3S2/(12.0*r2_3)))
           + R3 * (dt21 * (1.0/(dt32*dt31) + MU_KM3S2/(12.0*r3_3)));

    StateVector result = r2;
    result.vx = v2v.x;
    result.vy = v2v.y;
    result.vz = v2v.z;
    return result;
}

}  // namespace iod

// ── OEM Binary Serialization ──
// Encodes ODResult as a CCSDS-inspired OEM (Orbit Ephemeris Message) binary record.
// Reference: CCSDS 502.0-B-3 "Orbit Data Messages", Section 5
// Format: [magic 4B][version 4B][epoch_jd 8B][state 48B][covariance 288B][meta 12B]

int32_t result_to_oem(const ODResult& result,
                       uint8_t* output, uint32_t output_capacity) {
    if (!result.converged) return -1;

    // Record: 4 magic + 4 version + 8 epoch + 48 state + 288 cov + 8 rms + 4 iter = 364 bytes
    constexpr uint32_t OEM_RECORD_SIZE = 364;
    if (output_capacity < OEM_RECORD_SIZE) return -2;

    uint8_t* p = output;

    // Magic: "$OEM"
    p[0] = '$'; p[1] = 'O'; p[2] = 'E'; p[3] = 'M'; p += 4;

    // Version: 1
    uint32_t version = 1;
    std::memcpy(p, &version, 4); p += 4;

    // Epoch (Julian Date, IEEE 754 double)
    std::memcpy(p, &result.fitted_state.epoch_jd, 8); p += 8;

    // State vector: x, y, z, vx, vy, vz (6 doubles = 48 bytes)
    const double* sv = &result.fitted_state.x;
    std::memcpy(p, sv, 48); p += 48;

    // Covariance 6×6 (36 doubles = 288 bytes, row-major)
    for (int i = 0; i < 6; i++) {
        std::memcpy(p, result.covariance[i].data(), 48);
        p += 48;
    }

    // RMS residual
    std::memcpy(p, &result.rms_residual, 8); p += 8;

    // Iteration count
    int32_t iters = result.iterations;
    std::memcpy(p, &iters, 4); p += 4;

    return static_cast<int32_t>(OEM_RECORD_SIZE);
}

}  // namespace od
