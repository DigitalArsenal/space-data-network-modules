// integrators.h - Phase 11.1.1 Numerical Integrators API
// =============================================================================
// Phase 11: Astrodynamics Framework (Basilisk + TudatPy Port)
// Provides clean Integrator:: namespace API for all numerical integration methods.
// Extended with TudatPy-style integrators for comprehensive orbit propagation.
// =============================================================================

#pragma once

#include "astrodynamics_types.h"
#include "force_models.h"
#include <functional>
#include <array>
#include <vector>

namespace astro {

// =============================================================================
// Integrator Namespace - Clean API for All Integration Methods
// =============================================================================

namespace Integrator {

// -----------------------------------------------------------------------------
// Result Structure for Integrator Steps
// -----------------------------------------------------------------------------

/// Result of a single integration step
struct StepResult {
    std::array<double, 6> state;    ///< State after step [rx, ry, rz, vx, vy, vz]
    std::array<double, 6> error;    ///< Error estimate (for adaptive methods)
    double time{0};                 ///< Time after step
    double stepUsed{0};             ///< Actual step size used
    bool accepted{true};            ///< True if step was accepted
    int evaluations{0};             ///< Number of derivative evaluations
};

/// Result of a propagation to target time
struct PropagateResult {
    StateVector finalState;         ///< Final state at target time
    double totalTime{0};            ///< Total integration time (seconds)
    uint32_t steps{0};              ///< Number of steps taken
    uint32_t rejections{0};         ///< Number of rejected steps
    double maxError{0};             ///< Maximum error estimate encountered
    bool success{true};             ///< True if propagation succeeded
    std::string errorMessage;       ///< Error message if failed
};

// -----------------------------------------------------------------------------
// Dense Output Structure (for continuous interpolation between steps)
// -----------------------------------------------------------------------------

/// Dense output coefficients for continuous solution interpolation
struct DenseOutput {
    std::array<double, 6> y0;       ///< State at start of step
    std::array<double, 6> y1;       ///< State at end of step
    double t0{0};                   ///< Time at start of step
    double t1{0};                   ///< Time at end of step

    /// Interpolation coefficients (method-dependent)
    /// For RKF45/RKF78: Hermite cubic interpolation coefficients
    std::array<std::array<double, 6>, 4> coeffs;
    bool valid{false};

    /// Evaluate dense output at time t in [t0, t1]
    std::array<double, 6> evaluate(double t) const;
};

// -----------------------------------------------------------------------------
// Bulirsch-Stoer Configuration
// -----------------------------------------------------------------------------

/// Configuration for Bulirsch-Stoer extrapolation method
struct BSConfig {
    int maxSubdivisions{12};        ///< Maximum extrapolation subdivisions
    double safetyFactor{0.9};       ///< Safety factor for step size control
    double minStepFactor{0.2};      ///< Minimum step size reduction factor
    double maxStepFactor{5.0};      ///< Maximum step size growth factor
    bool useRationalExtrapolation{true}; ///< Use rational (vs polynomial) extrapolation
};

// -----------------------------------------------------------------------------
// 1. RK4 - Classic 4th Order Runge-Kutta (Fixed Step)
// -----------------------------------------------------------------------------

/// Classic 4th order Runge-Kutta single step (fixed step size)
/// @param state Current state [rx, ry, rz, vx, vy, vz] (km, km/s)
/// @param t Current time (seconds from epoch)
/// @param h Step size (seconds)
/// @param deriv Derivative function
/// @param params User parameters for derivative function
/// @return Step result with new state
StepResult RK4(const std::array<double, 6>& state, double t, double h,
               DerivativeFunc deriv, void* params);

/// RK4 single step with dense output
/// @param state Current state
/// @param t Current time
/// @param h Step size
/// @param deriv Derivative function
/// @param params User parameters
/// @param dense Output dense output coefficients
/// @return Step result
StepResult RK4WithDense(const std::array<double, 6>& state, double t, double h,
                        DerivativeFunc deriv, void* params, DenseOutput& dense);

/// RK4 propagation to target time
/// @param initialState Initial Cartesian state
/// @param targetTime Target time (seconds from epoch)
/// @param h Fixed step size (seconds)
/// @param deriv Derivative function
/// @param params User parameters
/// @return Propagation result
PropagateResult RK4Propagate(const StateVector& initialState, double targetTime,
                             double h, DerivativeFunc deriv, void* params);

/// RK4 propagation with ForceModel configuration
/// @param initialState Initial Cartesian state
/// @param dt Propagation duration (seconds)
/// @param h Step size (seconds)
/// @param forceSet Force model configuration
/// @return Final state
StateVector RK4(const StateVector& initialState, double dt, double h,
                ForceModel::ForceModelSet& forceSet);

// -----------------------------------------------------------------------------
// 2. RKF45 - Runge-Kutta-Fehlberg 4(5) Adaptive
// -----------------------------------------------------------------------------

/// RKF45 single step with error estimate
/// @param state Current state
/// @param t Current time (seconds)
/// @param h Proposed step size (seconds)
/// @param deriv Derivative function
/// @param params User parameters
/// @return Step result with 5th order solution and error estimate
StepResult RKF45(const std::array<double, 6>& state, double t, double h,
                 DerivativeFunc deriv, void* params);

/// RKF45 single step with dense output capability
/// @param state Current state
/// @param t Current time
/// @param h Proposed step size
/// @param deriv Derivative function
/// @param params User parameters
/// @param dense Output dense output coefficients for interpolation
/// @return Step result
StepResult RKF45WithDense(const std::array<double, 6>& state, double t, double h,
                          DerivativeFunc deriv, void* params, DenseOutput& dense);

/// RKF45 adaptive propagation to target time
/// @param initialState Initial Cartesian state
/// @param targetTime Target time (seconds from epoch)
/// @param config Integrator configuration (tolerances, step limits)
/// @param deriv Derivative function
/// @param params User parameters
/// @return Propagation result
PropagateResult RKF45Propagate(const StateVector& initialState, double targetTime,
                               const IntegratorConfig& config,
                               DerivativeFunc deriv, void* params);

/// RKF45 propagation with ForceModel
/// @param initialState Initial Cartesian state
/// @param dt Propagation duration (seconds)
/// @param config Integrator configuration
/// @param forceSet Force model configuration
/// @return Final state
StateVector RKF45(const StateVector& initialState, double dt,
                  const IntegratorConfig& config,
                  ForceModel::ForceModelSet& forceSet);

// -----------------------------------------------------------------------------
// 3. ABM - Adams-Bashforth-Moulton Multi-Step Predictor-Corrector
// -----------------------------------------------------------------------------

/// ABM integrator state (maintains history for multi-step method)
struct ABMIntegratorState {
    std::array<double, 6> y;            ///< Current state
    double t{0};                        ///< Current time
    double h{60.0};                     ///< Fixed step size

    /// Function evaluation history (most recent first)
    std::array<std::array<double, 6>, 8> fHistory;
    uint8_t historyCount{0};            ///< Valid history entries
    bool initialized{false};            ///< Startup phase complete
    uint8_t order{4};                   ///< ABM order (4-8)
};

/// Initialize ABM integrator with startup phase
/// Uses RK4 steps to build initial history for the predictor
/// @param initialState Initial Cartesian state
/// @param h Fixed step size (seconds, required for multi-step)
/// @param order ABM order (4-8 supported)
/// @param deriv Derivative function
/// @param params User parameters
/// @return Initialized ABM state
ABMIntegratorState ABMInit(const StateVector& initialState, double h, int order,
                           DerivativeFunc deriv, void* params);

/// ABM single predictor-corrector step
/// @param abmState ABM state (modified in place)
/// @param deriv Derivative function
/// @param params User parameters
/// @return Step result
StepResult ABM(ABMIntegratorState& abmState, DerivativeFunc deriv, void* params);

/// ABM propagation to target time
/// @param initialState Initial Cartesian state
/// @param targetTime Target time (seconds from epoch)
/// @param h Fixed step size (seconds)
/// @param order ABM order (4-8)
/// @param deriv Derivative function
/// @param params User parameters
/// @return Propagation result
PropagateResult ABMPropagate(const StateVector& initialState, double targetTime,
                             double h, int order,
                             DerivativeFunc deriv, void* params);

/// ABM propagation with ForceModel
/// @param initialState Initial Cartesian state
/// @param dt Propagation duration (seconds)
/// @param h Step size (seconds)
/// @param order ABM order (4-8)
/// @param forceSet Force model configuration
/// @return Final state
StateVector ABM(const StateVector& initialState, double dt, double h, int order,
                ForceModel::ForceModelSet& forceSet);

// -----------------------------------------------------------------------------
// 4. Cowell - Direct Rectangular Coordinate Integration
// -----------------------------------------------------------------------------

/// Cowell's method: Direct integration in Cartesian coordinates
/// @param initialState Initial Cartesian state
/// @param dt Propagation duration (seconds)
/// @param config Integrator configuration
/// @param forceConfig Force model configuration (basic)
/// @return Final state
StateVector Cowell(const StateVector& initialState, double dt,
                   const IntegratorConfig& config,
                   const ForceModelConfig& forceConfig);

/// Cowell's method with full ForceModelSet
/// @param initialState Initial Cartesian state
/// @param dt Propagation duration (seconds)
/// @param config Integrator configuration
/// @param forceSet Full force model configuration
/// @return Final state
StateVector Cowell(const StateVector& initialState, double dt,
                   const IntegratorConfig& config,
                   ForceModel::ForceModelSet& forceSet);

/// Cowell propagation with epoch output at intervals
/// @param initialState Initial Cartesian state
/// @param dt Total propagation duration (seconds)
/// @param outputInterval Output interval (seconds)
/// @param config Integrator configuration
/// @param forceSet Force model configuration
/// @param ephemeris Output vector of states at each interval
/// @return Propagation result
PropagateResult CowellEphemeris(const StateVector& initialState, double dt,
                                double outputInterval,
                                const IntegratorConfig& config,
                                ForceModel::ForceModelSet& forceSet,
                                std::vector<StateVector>& ephemeris);

// -----------------------------------------------------------------------------
// 5. Encke - Perturbation from Reference Keplerian Orbit
// -----------------------------------------------------------------------------

/// Encke's method: Integrates deviation from a reference Keplerian orbit
/// More accurate than Cowell when perturbations are small relative to two-body.
/// @param enckeState Encke state (reference + deviation)
/// @param dt Propagation duration (seconds)
/// @param config Integrator configuration
/// @param forceConfig Force model configuration
/// @return Updated Encke state
EnckeState Encke(const EnckeState& enckeState, double dt,
                 const IntegratorConfig& config,
                 const ForceModelConfig& forceConfig);

/// Initialize Encke state from Cartesian
/// @param state Cartesian state
/// @param mu Gravitational parameter (km^3/s^2)
/// @return Initialized Encke state with zero deviation
EnckeState EnckeInit(const StateVector& state, double mu = MU_EARTH);

/// Rectify Encke state when deviation becomes large
/// Updates reference orbit to current osculating state and resets deviation.
/// @param enckeState Current Encke state
/// @return Rectified Encke state
EnckeState EnckeRectify(const EnckeState& enckeState);

/// Encke propagation with automatic rectification
/// @param initialState Initial Cartesian state
/// @param dt Propagation duration (seconds)
/// @param config Integrator configuration
/// @param forceSet Force model configuration
/// @param rectifyThreshold Rectification threshold (|delta_r|/|r_ref|)
/// @return Final Cartesian state
StateVector Encke(const StateVector& initialState, double dt,
                  const IntegratorConfig& config,
                  ForceModel::ForceModelSet& forceSet,
                  double rectifyThreshold = 0.01);

// -----------------------------------------------------------------------------
// 6. EquinoctialVOP - Equinoctial Elements Variation of Parameters
// -----------------------------------------------------------------------------

/// Equinoctial VOP: Propagates equinoctial elements using variational equations
/// Singularity-free for circular and equatorial orbits (unlike classical elements).
/// @param varState Variational state with equinoctial elements
/// @param dt Propagation duration (seconds)
/// @param config Integrator configuration
/// @param forceConfig Force model configuration
/// @return Updated variational state
VariationalState EquinoctialVOP(const VariationalState& varState, double dt,
                                const IntegratorConfig& config,
                                const ForceModelConfig& forceConfig);

/// Initialize equinoctial variational state from Cartesian
/// @param state Cartesian state
/// @param mu Gravitational parameter
/// @return Initialized variational state with equinoctial elements
VariationalState EquinoctialVOPInit(const StateVector& state, double mu = MU_EARTH);

/// Equinoctial VOP propagation returning Cartesian state
/// @param initialState Initial Cartesian state
/// @param dt Propagation duration (seconds)
/// @param config Integrator configuration
/// @param forceSet Force model configuration
/// @return Final Cartesian state
StateVector EquinoctialVOP(const StateVector& initialState, double dt,
                           const IntegratorConfig& config,
                           ForceModel::ForceModelSet& forceSet);

/// Compute equinoctial element rates from perturbing acceleration
/// @param equinoctial Current equinoctial elements
/// @param perturbAccRTN Perturbing acceleration in RTN frame (km/s^2)
/// @param rates Output element rates [da, dh, dk, dp, dq, dL]
void EquinoctialRates(const EquinoctialElements& equinoctial,
                      const Vec3& perturbAccRTN, double* rates);

// -----------------------------------------------------------------------------
// 7. KeplerianSTM - State Transition Matrix Propagation
// -----------------------------------------------------------------------------

/// Keplerian STM: Propagates state with state transition matrix
/// Computes partials of final state with respect to initial state.
/// @param stmState Initial STM state (elements + identity STM)
/// @param dt Propagation duration (seconds)
/// @param config Integrator configuration
/// @param forceConfig Force model configuration
/// @return Updated STM state
KeplerianSTMState KeplerianSTM(const KeplerianSTMState& stmState, double dt,
                               const IntegratorConfig& config,
                               const ForceModelConfig& forceConfig);

/// Initialize STM state from Cartesian
/// @param state Cartesian state
/// @param mu Gravitational parameter
/// @return Initialized STM state with identity STM
KeplerianSTMState KeplerianSTMInit(const StateVector& state, double mu = MU_EARTH);

/// Extract 6x6 state transition matrix
/// @param stmState STM state
/// @return 6x6 STM (partials of final w.r.t. initial Keplerian elements)
Mat6 GetSTM(const KeplerianSTMState& stmState);

/// STM propagation returning final state and STM
/// @param initialState Initial Cartesian state
/// @param dt Propagation duration (seconds)
/// @param config Integrator configuration
/// @param forceConfig Force model configuration
/// @param stm Output state transition matrix
/// @return Final Cartesian state
StateVector KeplerianSTM(const StateVector& initialState, double dt,
                         const IntegratorConfig& config,
                         const ForceModelConfig& forceConfig,
                         Mat6& stm);

// -----------------------------------------------------------------------------
// Additional High-Order Methods (from Phase 11.1.1)
// -----------------------------------------------------------------------------

/// RKF78 - Runge-Kutta-Fehlberg 7(8) adaptive step
/// @param state Current state
/// @param t Current time
/// @param h Step size
/// @param deriv Derivative function
/// @param params User parameters
/// @return Step result with 8th order solution
StepResult RKF78(const std::array<double, 6>& state, double t, double h,
                 DerivativeFunc deriv, void* params);

/// RKF78 single step with dense output
/// @param state Current state
/// @param t Current time
/// @param h Step size
/// @param deriv Derivative function
/// @param params User parameters
/// @param dense Output dense output coefficients
/// @return Step result
StepResult RKF78WithDense(const std::array<double, 6>& state, double t, double h,
                          DerivativeFunc deriv, void* params, DenseOutput& dense);

/// RKF78 adaptive propagation to target time
/// @param initialState Initial Cartesian state
/// @param targetTime Target time (seconds from epoch)
/// @param config Integrator configuration
/// @param deriv Derivative function
/// @param params User parameters
/// @return Propagation result
PropagateResult RKF78Propagate(const StateVector& initialState, double targetTime,
                               const IntegratorConfig& config,
                               DerivativeFunc deriv, void* params);

/// RKF78 propagation with ForceModel
/// @param initialState Initial Cartesian state
/// @param dt Propagation duration (seconds)
/// @param config Integrator configuration
/// @param forceSet Force model configuration
/// @return Final state
StateVector RKF78(const StateVector& initialState, double dt,
                  const IntegratorConfig& config,
                  ForceModel::ForceModelSet& forceSet);

/// RKDP87 - Dormand-Prince 8(7) adaptive step
/// Higher-order variant with excellent stability
/// @param state Current state
/// @param t Current time
/// @param h Step size
/// @param deriv Derivative function
/// @param params User parameters
/// @return Step result
StepResult RKDP87(const std::array<double, 6>& state, double t, double h,
                  DerivativeFunc deriv, void* params);

/// RKDP87 adaptive propagation to target time
/// @param initialState Initial Cartesian state
/// @param targetTime Target time (seconds from epoch)
/// @param config Integrator configuration
/// @param deriv Derivative function
/// @param params User parameters
/// @return Propagation result
PropagateResult RKDP87Propagate(const StateVector& initialState, double targetTime,
                                const IntegratorConfig& config,
                                DerivativeFunc deriv, void* params);

/// Bulirsch-Stoer extrapolation method - single step
/// Very high accuracy through polynomial/rational extrapolation
/// @param state Current state
/// @param t Current time
/// @param h Step size
/// @param deriv Derivative function
/// @param params User parameters
/// @param maxSubdivisions Maximum extrapolation subdivisions
/// @return Step result
StepResult BulirschStoer(const std::array<double, 6>& state, double t, double h,
                         DerivativeFunc deriv, void* params,
                         int maxSubdivisions = 12);

/// Bulirsch-Stoer with configuration
/// @param state Current state
/// @param t Current time
/// @param h Step size
/// @param deriv Derivative function
/// @param params User parameters
/// @param bsConfig BS configuration
/// @return Step result
StepResult BS(const std::array<double, 6>& state, double t, double h,
              DerivativeFunc deriv, void* params, const BSConfig& bsConfig);

/// Bulirsch-Stoer adaptive propagation to target time
/// @param initialState Initial Cartesian state
/// @param targetTime Target time (seconds from epoch)
/// @param config Integrator configuration
/// @param deriv Derivative function
/// @param params User parameters
/// @param bsConfig BS-specific configuration
/// @return Propagation result
PropagateResult BSPropagate(const StateVector& initialState, double targetTime,
                            const IntegratorConfig& config,
                            DerivativeFunc deriv, void* params,
                            const BSConfig& bsConfig = BSConfig());

/// BS propagation with ForceModel
/// @param initialState Initial Cartesian state
/// @param dt Propagation duration (seconds)
/// @param config Integrator configuration
/// @param forceSet Force model configuration
/// @return Final state
StateVector BS(const StateVector& initialState, double dt,
               const IntegratorConfig& config,
               ForceModel::ForceModelSet& forceSet);

/// Gauss-Jackson 8th order predictor-corrector
/// Optimized for orbit propagation with summed second differences
/// @param state Integrator state with history
/// @param deriv Derivative function
/// @param params User parameters
/// @return Step result
StepResult GaussJackson8(IntegratorState& state, DerivativeFunc deriv, void* params);

/// Initialize Gauss-Jackson 8th order integrator
/// @param initialState Initial Cartesian state
/// @param h Fixed step size (required for multi-step)
/// @param deriv Derivative function
/// @param params User parameters
/// @return Initialized integrator state
IntegratorState GaussJackson8Init(const StateVector& initialState, double h,
                                   DerivativeFunc deriv, void* params);

/// Gauss-Jackson 8th order propagation to target time
/// @param initialState Initial Cartesian state
/// @param targetTime Target time (seconds from epoch)
/// @param h Fixed step size
/// @param deriv Derivative function
/// @param params User parameters
/// @return Propagation result
PropagateResult GaussJackson8Propagate(const StateVector& initialState, double targetTime,
                                        double h, DerivativeFunc deriv, void* params);

/// Gauss-Jackson 12th order predictor-corrector
/// Higher-order variant for increased accuracy
/// @param state Integrator state with history
/// @param deriv Derivative function
/// @param params User parameters
/// @return Step result
StepResult GaussJackson12(IntegratorState& state, DerivativeFunc deriv, void* params);

// -----------------------------------------------------------------------------
// Gauss VOP - Classical Keplerian Element Variation of Parameters
// -----------------------------------------------------------------------------

/// Gauss VOP: Propagates classical Keplerian elements using variational equations
/// @param varState Variational state with Keplerian elements
/// @param dt Propagation duration (seconds)
/// @param config Integrator configuration
/// @param forceConfig Force model configuration
/// @return Updated variational state
VariationalState GaussVOP(const VariationalState& varState, double dt,
                          const IntegratorConfig& config,
                          const ForceModelConfig& forceConfig);

/// Initialize Gauss VOP state from Cartesian
/// @param state Cartesian state
/// @param mu Gravitational parameter
/// @return Initialized variational state with Keplerian elements
VariationalState GaussVOPInit(const StateVector& state, double mu = MU_EARTH);

/// Gauss VOP propagation returning Cartesian state
/// @param initialState Initial Cartesian state
/// @param dt Propagation duration (seconds)
/// @param config Integrator configuration
/// @param forceSet Force model configuration
/// @return Final Cartesian state
StateVector GaussVOP(const StateVector& initialState, double dt,
                     const IntegratorConfig& config,
                     ForceModel::ForceModelSet& forceSet);

/// Compute Gauss variational equation rates from perturbing acceleration
/// @param elements Current Keplerian elements
/// @param perturbAccRTN Perturbing acceleration in RTN frame (km/s^2)
/// @param rates Output element rates [da, de, di, dRAAN, dargp, dM]
void GaussRates(const KeplerianElements& elements,
                const Vec3& perturbAccRTN, double* rates);

// -----------------------------------------------------------------------------
// 8. DROMO - Regularized Orbital Element Formulation
// -----------------------------------------------------------------------------

/// DROMO state initialization from Cartesian state
/// @param state Cartesian state
/// @param mu Gravitational parameter
/// @return Initialized DROMO state
DromoState DromoInit(const StateVector& state, double mu = MU_EARTH);

/// DROMO single step in fictitious time
/// @param dromoState DROMO state (modified in place)
/// @param ds Fictitious time step
/// @param deriv Perturbing acceleration function
/// @param params User parameters
/// @return Step result with physical time elapsed
StepResult Dromo(DromoState& dromoState, double ds,
                 DerivativeFunc deriv, void* params);

/// DROMO propagation to target physical time
/// @param initialState Initial Cartesian state
/// @param targetTime Target time (seconds from epoch)
/// @param config Integrator configuration
/// @param forceSet Force model configuration
/// @return Propagation result
PropagateResult DromoPropagate(const StateVector& initialState, double targetTime,
                               const IntegratorConfig& config,
                               ForceModel::ForceModelSet& forceSet);

/// DROMO propagation returning Cartesian state
/// @param initialState Initial Cartesian state
/// @param dt Propagation duration (seconds)
/// @param config Integrator configuration
/// @param forceSet Force model configuration
/// @return Final Cartesian state
StateVector Dromo(const StateVector& initialState, double dt,
                  const IntegratorConfig& config,
                  ForceModel::ForceModelSet& forceSet);

// -----------------------------------------------------------------------------
// 9. Stiefel-Scheifele - KS Transformation Regularization
// -----------------------------------------------------------------------------

/// Stiefel state initialization from Cartesian state
/// @param state Cartesian state
/// @param mu Gravitational parameter
/// @return Initialized Stiefel state
StiefelState StiefelInit(const StateVector& state, double mu = MU_EARTH);

/// Stiefel-Scheifele single step in fictitious time
/// @param stiefelState Stiefel state (modified in place)
/// @param ds Fictitious time step
/// @param deriv Perturbing acceleration function
/// @param params User parameters
/// @return Step result with physical time elapsed
StepResult Stiefel(StiefelState& stiefelState, double ds,
                   DerivativeFunc deriv, void* params);

/// Stiefel-Scheifele propagation to target physical time
/// @param initialState Initial Cartesian state
/// @param targetTime Target time (seconds from epoch)
/// @param config Integrator configuration
/// @param forceSet Force model configuration
/// @return Propagation result
PropagateResult StiefelPropagate(const StateVector& initialState, double targetTime,
                                 const IntegratorConfig& config,
                                 ForceModel::ForceModelSet& forceSet);

/// Stiefel-Scheifele propagation returning Cartesian state
/// @param initialState Initial Cartesian state
/// @param dt Propagation duration (seconds)
/// @param config Integrator configuration
/// @param forceSet Force model configuration
/// @return Final Cartesian state
StateVector Stiefel(const StateVector& initialState, double dt,
                    const IntegratorConfig& config,
                    ForceModel::ForceModelSet& forceSet);

// -----------------------------------------------------------------------------
// Ephemeris Generation Functions (dense output trajectories)
// -----------------------------------------------------------------------------

/// Generate ephemeris using any integrator method
/// @param initialState Initial Cartesian state
/// @param dt Total propagation duration (seconds)
/// @param outputInterval Output interval (seconds)
/// @param config Integrator configuration
/// @param forceSet Force model configuration
/// @param ephemeris Output vector of states at each interval
/// @return Propagation result
PropagateResult GenerateEphemeris(const StateVector& initialState, double dt,
                                  double outputInterval,
                                  const IntegratorConfig& config,
                                  ForceModel::ForceModelSet& forceSet,
                                  std::vector<StateVector>& ephemeris);

/// Generate ephemeris with dense output interpolation
/// Uses dense output capability for accurate intermediate states
/// @param initialState Initial Cartesian state
/// @param dt Total propagation duration (seconds)
/// @param outputInterval Output interval (seconds)
/// @param config Integrator configuration
/// @param forceSet Force model configuration
/// @param ephemeris Output vector of states
/// @return Propagation result
PropagateResult GenerateEphemerisDense(const StateVector& initialState, double dt,
                                       double outputInterval,
                                       const IntegratorConfig& config,
                                       ForceModel::ForceModelSet& forceSet,
                                       std::vector<StateVector>& ephemeris);

// =============================================================================
// Convenience Functions
// =============================================================================

/// Select and use appropriate integrator based on IntegratorConfig method
/// @param initialState Initial state
/// @param dt Propagation duration (seconds)
/// @param config Integrator configuration with method selection
/// @param forceSet Force model configuration
/// @return Final state
StateVector Propagate(const StateVector& initialState, double dt,
                      const IntegratorConfig& config,
                      ForceModel::ForceModelSet& forceSet);

/// Propagate with detailed result
/// @param initialState Initial state
/// @param dt Propagation duration (seconds)
/// @param config Integrator configuration
/// @param forceSet Force model configuration
/// @return Propagation result with statistics
PropagateResult PropagateWithResult(const StateVector& initialState, double dt,
                                    const IntegratorConfig& config,
                                    ForceModel::ForceModelSet& forceSet);

/// Create default configuration for different orbit regimes
IntegratorConfig CreateLEOConfig();   ///< LEO: moderate step, adaptive RKF78
IntegratorConfig CreateGEOConfig();   ///< GEO: larger step, Encke method
IntegratorConfig CreateCislunarConfig(); ///< Cislunar: small step, high order
IntegratorConfig CreateHighFidelityConfig(); ///< Maximum accuracy configuration
IntegratorConfig CreateDeepSpaceConfig(); ///< Deep space: large step, Bulirsch-Stoer
IntegratorConfig CreateRendezvousConfig(); ///< Proximity ops: small step, high accuracy

// =============================================================================
// Error Estimation Utilities
// =============================================================================

/// Compute weighted error norm for step size control
/// @param error Error vector
/// @param y State vector
/// @param absTol Absolute tolerance
/// @param relTol Relative tolerance
/// @return Weighted error norm
double ComputeErrorNorm(const std::array<double, 6>& error,
                        const std::array<double, 6>& y,
                        double absTol, double relTol);

/// Compute optimal step size from error estimate
/// @param h Current step size
/// @param errNorm Error norm
/// @param order Method order
/// @param safety Safety factor (default 0.9)
/// @param minFactor Minimum step reduction factor (default 0.2)
/// @param maxFactor Maximum step growth factor (default 5.0)
/// @return Optimal new step size
double ComputeOptimalStep(double h, double errNorm, int order,
                          double safety = 0.9, double minFactor = 0.2,
                          double maxFactor = 5.0);

// =============================================================================
// Interpolation Utilities
// =============================================================================

/// Hermite cubic interpolation between two states
/// @param y0 State at t0
/// @param dy0 Derivative at t0
/// @param y1 State at t1
/// @param dy1 Derivative at t1
/// @param t0 Start time
/// @param t1 End time
/// @param t Interpolation time
/// @return Interpolated state
std::array<double, 6> HermiteInterpolate(const std::array<double, 6>& y0,
                                          const std::array<double, 6>& dy0,
                                          const std::array<double, 6>& y1,
                                          const std::array<double, 6>& dy1,
                                          double t0, double t1, double t);

} // namespace Integrator

} // namespace astro
