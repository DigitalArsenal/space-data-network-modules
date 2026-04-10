#ifndef OD_ORBIT_DETERMINATION_H
#define OD_ORBIT_DETERMINATION_H

/**
 * Orbit Determination SDN Plugin
 *
 * Architecture:
 *   Propagator interface is abstract — any propagator plugin can be injected.
 *   Default: SGP4 (via sgp4-propagator-sdn-plugin)
 *   Future:  Numerical (Tudat), high-fidelity force models
 *
 * Methods:
 *   IOD (Initial Orbit Determination):
 *     - Gauss (angles-only, 3 observations)
 *     - Laplace (angles-only, 3 observations)
 *     - Double-r (range + angles, 2 observations)
 *     - Gibbs (3 position vectors)
 *     - Herrick-Gibbs (3 position vectors, close spacing)
 *
 *   Differential Correction:
 *     - Batch Least Squares (weighted)
 *     - Sequential: Extended Kalman Filter (EKF)
 *     - Sequential: Unscented Kalman Filter (UKF)
 *
 *   Covariance:
 *     - State covariance (6×6 position/velocity)
 *     - Consider parameters (drag, SRP, etc.)
 *     - Covariance propagation (STM-based)
 */

#include <cstdint>
#include <string>
#include <vector>
#include <array>
#include <functional>

namespace od {

// ─── State Vector (ECI/TEME) ───

struct StateVector {
    double epoch_jd;
    double x, y, z;       // km
    double vx, vy, vz;    // km/s
};

// ─── Observation Types ───

enum class ObservationType {
    RIGHT_ASCENSION,    // rad
    DECLINATION,        // rad
    AZIMUTH,           // rad
    ELEVATION,         // rad
    RANGE,             // km
    RANGE_RATE,        // km/s
    POSITION_X,        // km (e.g., GPS)
    POSITION_Y,        // km
    POSITION_Z         // km
};

struct Observation {
    double epoch_jd;
    ObservationType type;
    double value;
    double sigma;          // 1-sigma measurement uncertainty
    int station_id = 0;    // Ground station identifier
};

// ─── Ground Station ───

struct GroundStation {
    int id;
    std::string name;
    double lat_deg;
    double lon_deg;
    double alt_km;
};

// ─── Covariance (6×6 symmetric) ───

using Covariance6x6 = std::array<std::array<double, 6>, 6>;

// ─── Propagator Interface ───

/**
 * Abstract propagator — any propagation method can implement this.
 * SGP4, numerical, semi-analytical, etc.
 */
class Propagator {
public:
    virtual ~Propagator() = default;

    /// Propagate state from current epoch to target epoch
    virtual StateVector propagate(const StateVector& state, double target_jd) = 0;

    /// Propagate with state transition matrix (for covariance)
    /// Returns {propagated_state, STM_6x6}
    virtual std::pair<StateVector, Covariance6x6> propagate_with_stm(
        const StateVector& state, double target_jd) {
        // Default: numerical differencing for STM
        return {propagate(state, target_jd), compute_stm_numerical(state, target_jd)};
    }

    /// Get propagator name
    virtual std::string name() const = 0;

protected:
    /// Compute STM via central differencing (default fallback)
    Covariance6x6 compute_stm_numerical(const StateVector& state, double target_jd);
};

// ─── SGP4 Propagator (default) ───

class SGP4Propagator : public Propagator {
public:
    /// Initialize from GP/OMM elements (JSON string)
    explicit SGP4Propagator(const std::string& gp_json);

    StateVector propagate(const StateVector& state, double target_jd) override;
    std::string name() const override { return "SGP4"; }

private:
    // Internal GP state — delegates to sgp4-propagator-plugin
    std::string gp_json_;
};

// ─── IOD Methods ───

namespace iod {

/// Gauss method — angles-only IOD (3 observations)
/// Returns initial state estimate at middle observation epoch
StateVector gauss(
    const std::vector<Observation>& obs,
    const GroundStation& station);

/// Laplace method — angles-only IOD
StateVector laplace(
    const std::vector<Observation>& obs,
    const GroundStation& station);

/// Gibbs method — 3 position vectors → orbital elements
StateVector gibbs(
    const StateVector& r1, const StateVector& r2, const StateVector& r3);

/// Herrick-Gibbs — 3 closely-spaced position vectors
StateVector herrick_gibbs(
    const StateVector& r1, const StateVector& r2, const StateVector& r3);

}  // namespace iod

// ─── Estimation Config ───

enum class EstimationMethod {
    BATCH_LSQ,    // Batch weighted least squares
    EKF,          // Extended Kalman Filter
    UKF           // Unscented Kalman Filter
};

struct EstimationConfig {
    EstimationMethod method = EstimationMethod::BATCH_LSQ;
    int max_iterations = 20;           // For batch LSQ
    double convergence_tol = 1e-8;     // RMS residual convergence
    bool estimate_drag = false;        // Solve-for drag coefficient
    bool estimate_srp = false;         // Solve-for solar radiation pressure
    double drag_sigma = 0.1;           // A priori drag uncertainty
    double srp_sigma = 0.1;            // A priori SRP uncertainty
};

// ─── OD Result ───

struct ODResult {
    StateVector fitted_state;          // Best-fit state at epoch
    Covariance6x6 covariance;         // State covariance
    std::vector<double> residuals;     // O-C residuals (per observation)
    double rms_residual;              // RMS of weighted residuals
    int iterations;                    // Iterations to convergence
    bool converged;
    std::string propagator_name;
};

// ─── Main OD Function ───

/**
 * Run orbit determination.
 *
 * @param observations  Vector of observations (sorted by time)
 * @param stations      Ground station database
 * @param propagator    Propagator to use (SGP4, numerical, etc.)
 * @param config        Estimation configuration
 * @param initial_state Initial state estimate (optional — IOD used if zero)
 * @return OD result with fitted state, covariance, residuals
 */
ODResult determine_orbit(
    const std::vector<Observation>& observations,
    const std::vector<GroundStation>& stations,
    Propagator& propagator,
    const EstimationConfig& config,
    const StateVector& initial_state = {});

// ─── FlatBuffers Output ───

/**
 * Serialize OD result to OEM FlatBuffers binary.
 * Returns bytes written (>=0 success, <0 error).
 */
int32_t result_to_oem(const ODResult& result,
                       uint8_t* output, uint32_t output_capacity);

}  // namespace od

#endif  // OD_ORBIT_DETERMINATION_H
