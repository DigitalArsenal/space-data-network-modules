// astrodynamics.h - Astrodynamics Plugin API
// =============================================================================
// Phase 8: Space Domain Enhancement
// Provides numerical integration, orbit mechanics, conjunction assessment,
// maneuver planning, and proximity operations algorithms.
// =============================================================================

#pragma once

#include "astrodynamics_types.h"
#include "attitude_types.h"
#include <vector>

namespace astro {

// =============================================================================
// Numerical Integration
// =============================================================================

/// Initialize integrator with configuration
/// @param config Integrator configuration
/// @param state Initial state [rx, ry, rz, vx, vy, vz] (km, km/s)
/// @param t0 Initial time (seconds from epoch)
/// @return Initialized integrator state
IntegratorState integratorInit(const IntegratorConfig& config,
                                const double* state,
                                double t0);

/// Perform single integration step
/// @param state Current integrator state (modified in place)
/// @param config Integrator configuration
/// @param deriv Derivative function
/// @param params User parameters passed to derivative function
/// @return true if step succeeded
bool integratorStep(IntegratorState& state,
                    const IntegratorConfig& config,
                    DerivativeFunc deriv,
                    void* params);

/// Integrate to target time
/// @param state Current integrator state (modified in place)
/// @param config Integrator configuration
/// @param deriv Derivative function
/// @param params User parameters
/// @param targetTime Target time to integrate to
/// @return true if integration succeeded
bool integratorPropagate(IntegratorState& state,
                          const IntegratorConfig& config,
                          DerivativeFunc deriv,
                          void* params,
                          double targetTime);

/// RK7(8) Dormand-Prince single step
/// @param t Current time
/// @param h Step size
/// @param y Current state (6 elements)
/// @param yout Output state (6 elements)
/// @param yerr Error estimate (6 elements)
/// @param deriv Derivative function
/// @param params User parameters
void rk78Step(double t, double h, const double* y,
              double* yout, double* yerr,
              DerivativeFunc deriv, void* params);

/// Gauss-Jackson 8th order predictor-corrector step
/// @param state Integrator state with history
/// @param h Step size
/// @param deriv Derivative function
/// @param params User parameters
void gaussJackson8Step(IntegratorState& state, double h,
                       DerivativeFunc deriv, void* params);

// =============================================================================
// Phase 11.1 - Extended Numerical Integrators
// =============================================================================

/// Classic 4th order Runge-Kutta (fixed step)
/// @param t Current time
/// @param h Step size
/// @param y Current state (6 elements)
/// @param yout Output state (6 elements)
/// @param deriv Derivative function
/// @param params User parameters
void rk4Step(double t, double h, const double* y,
             double* yout,
             DerivativeFunc deriv, void* params);

/// Runge-Kutta-Fehlberg 4(5) adaptive step
/// @param t Current time
/// @param h Step size
/// @param y Current state (6 elements)
/// @param yout Output state (5th order, 6 elements)
/// @param yerr Error estimate (6 elements)
/// @param deriv Derivative function
/// @param params User parameters
void rkf45Step(double t, double h, const double* y,
               double* yout, double* yerr,
               DerivativeFunc deriv, void* params);

/// Runge-Kutta-Fehlberg 7(8) adaptive step
/// @param t Current time
/// @param h Step size
/// @param y Current state (6 elements)
/// @param yout Output state (8th order, 6 elements)
/// @param yerr Error estimate (6 elements)
/// @param deriv Derivative function
/// @param params User parameters
void rkf78Step(double t, double h, const double* y,
               double* yout, double* yerr,
               DerivativeFunc deriv, void* params);

/// Bulirsch-Stoer extrapolation step
/// @param t Current time
/// @param h Step size
/// @param y Current state (6 elements)
/// @param yout Output state (6 elements)
/// @param yerr Error estimate (6 elements)
/// @param deriv Derivative function
/// @param params User parameters
/// @param maxSubdiv Maximum subdivisions for extrapolation
void bulirschStoerStep(double t, double h, const double* y,
                       double* yout, double* yerr,
                       DerivativeFunc deriv, void* params,
                       int maxSubdiv = 12);

/// Cowell's method integration (rectangular coordinates)
/// Direct integration of equations of motion in Cartesian coordinates.
/// @param state Initial state vector
/// @param dt Propagation duration (seconds)
/// @param config Integrator configuration
/// @param forceConfig Force model configuration
/// @return Final state vector
StateVector cowellIntegrate(const StateVector& state, double dt,
                            const IntegratorConfig& config,
                            const ForceModelConfig& forceConfig);

/// Encke's method integration (perturbed deviation from reference)
/// Integrates deviation from a reference Keplerian orbit for better accuracy.
/// @param enckeState Encke state (reference + deviation)
/// @param dt Propagation duration (seconds)
/// @param config Integrator configuration
/// @param forceConfig Force model configuration
/// @return Updated Encke state
EnckeState enckeIntegrate(const EnckeState& enckeState, double dt,
                          const IntegratorConfig& config,
                          const ForceModelConfig& forceConfig);

/// Initialize Encke state from osculating state
/// @param state Osculating state vector
/// @param mu Gravitational parameter
/// @return Initialized Encke state with zero deviation
EnckeState enckeInit(const StateVector& state, double mu = MU_EARTH);

/// Rectify Encke state (update reference orbit)
/// @param enckeState Encke state to rectify
/// @return Rectified Encke state with new reference and zero deviation
EnckeState enckeRectify(const EnckeState& enckeState);

/// Gauss variational equations integration
/// Propagates orbital elements using Gauss planetary equations.
/// @param varState Variational state with elements
/// @param dt Propagation duration (seconds)
/// @param config Integrator configuration
/// @param forceConfig Force model configuration
/// @return Updated variational state
VariationalState gaussVOPIntegrate(const VariationalState& varState, double dt,
                                   const IntegratorConfig& config,
                                   const ForceModelConfig& forceConfig);

/// Equinoctial variational equations integration
/// Propagates equinoctial elements (singularity-free for circular/equatorial).
/// @param varState Variational state with equinoctial elements
/// @param dt Propagation duration (seconds)
/// @param config Integrator configuration
/// @param forceConfig Force model configuration
/// @return Updated variational state
VariationalState equinoctialVOPIntegrate(const VariationalState& varState, double dt,
                                         const IntegratorConfig& config,
                                         const ForceModelConfig& forceConfig);

/// Compute Gauss variational equation rates
/// @param elements Current Keplerian elements
/// @param perturbAcc Perturbing acceleration in RTN frame (km/s^2)
/// @param rates Output element rates [da, de, di, dRAAN, dargp, dM]
void gaussVariationalRates(const KeplerianElements& elements,
                           const Vec3& perturbAccRTN,
                           double* rates);

/// Compute equinoctial variational equation rates
/// @param equinoctial Current equinoctial elements
/// @param perturbAcc Perturbing acceleration in RTN frame (km/s^2)
/// @param rates Output element rates [da, dh, dk, dp, dq, dL]
void equinoctialVariationalRates(const EquinoctialElements& equinoctial,
                                 const Vec3& perturbAccRTN,
                                 double* rates);

/// Keplerian state transition matrix propagation
/// @param stmState Initial STM state
/// @param dt Propagation duration (seconds)
/// @param config Integrator configuration
/// @param forceConfig Force model configuration
/// @return Updated STM state
KeplerianSTMState keplerianSTMIntegrate(const KeplerianSTMState& stmState, double dt,
                                        const IntegratorConfig& config,
                                        const ForceModelConfig& forceConfig);

// -----------------------------------------------------------------------------
// Phase 11.1.1 - Additional Numerical Integrators
// -----------------------------------------------------------------------------

/// Dormand-Prince 8(7) adaptive step (RKDP87)
/// Higher-order variant with 8th order solution and 7th order error estimate
/// @param t Current time
/// @param h Step size
/// @param y Current state (6 elements)
/// @param yout Output state (8th order, 6 elements)
/// @param yerr Error estimate (6 elements)
/// @param deriv Derivative function
/// @param params User parameters
void rkdp87Step(double t, double h, const double* y,
                double* yout, double* yerr,
                DerivativeFunc deriv, void* params);

/// Adams-Bashforth-Moulton predictor-corrector step
/// Multi-step method requiring initialization with RK for startup
/// @param abmState ABM integrator state (modified in place)
/// @param deriv Derivative function
/// @param params User parameters
/// @return true if step succeeded
bool abmStep(ABMState& abmState, DerivativeFunc deriv, void* params);

/// Initialize ABM integrator with startup phase
/// Uses RK4 steps to build initial history
/// @param state Initial Cartesian state
/// @param h Step size (fixed for multi-step methods)
/// @param order ABM order (4-8)
/// @param deriv Derivative function
/// @param params User parameters
/// @return Initialized ABM state
ABMState abmInit(const StateVector& state, double h, int order,
                 DerivativeFunc deriv, void* params);

/// Propagate using ABM method to target time
/// @param abmState ABM integrator state (modified in place)
/// @param targetTime Target time to integrate to
/// @param deriv Derivative function
/// @param params User parameters
/// @return true if integration succeeded
bool abmPropagate(ABMState& abmState, double targetTime,
                  DerivativeFunc deriv, void* params);

/// DROMO regularized formulation step
/// Propagates DROMO elements with fictitious time as independent variable
/// @param dromoState DROMO state (modified in place)
/// @param ds Fictitious time step
/// @param deriv Perturbing acceleration function (returns acceleration in inertial frame)
/// @param params User parameters
/// @return Physical time elapsed
double dromoStep(DromoState& dromoState, double ds,
                 DerivativeFunc deriv, void* params);

/// Initialize DROMO state from Cartesian
/// @param state Cartesian state
/// @param mu Gravitational parameter
/// @return Initialized DROMO state
DromoState dromoInit(const StateVector& state, double mu = MU_EARTH);

/// Propagate using DROMO formulation to target physical time
/// @param dromoState DROMO state (modified in place)
/// @param targetTime Target physical time (seconds)
/// @param config Integrator configuration (for tolerance)
/// @param forceConfig Force model configuration
/// @return true if integration succeeded
bool dromoPropagate(DromoState& dromoState, double targetTime,
                    const IntegratorConfig& config,
                    const ForceModelConfig& forceConfig);

/// Convert DROMO state to Cartesian
/// @param dromoState DROMO state
/// @return Cartesian state
StateVector dromoToCartesian(const DromoState& dromoState);

/// Stiefel-Scheifele (KS transformation) step
/// Propagates regularized state with fictitious time
/// @param stiefelState Stiefel state (modified in place)
/// @param ds Fictitious time step
/// @param deriv Perturbing acceleration function
/// @param params User parameters
/// @return Physical time elapsed
double stiefelStep(StiefelState& stiefelState, double ds,
                   DerivativeFunc deriv, void* params);

/// Initialize Stiefel state from Cartesian
/// @param state Cartesian state
/// @param mu Gravitational parameter
/// @return Initialized Stiefel state
StiefelState stiefelInit(const StateVector& state, double mu = MU_EARTH);

/// Propagate using Stiefel-Scheifele formulation to target physical time
/// @param stiefelState Stiefel state (modified in place)
/// @param targetTime Target physical time (seconds)
/// @param config Integrator configuration (for tolerance)
/// @param forceConfig Force model configuration
/// @return true if integration succeeded
bool stiefelPropagate(StiefelState& stiefelState, double targetTime,
                      const IntegratorConfig& config,
                      const ForceModelConfig& forceConfig);

/// Convert Stiefel state to Cartesian
/// @param stiefelState Stiefel state
/// @return Cartesian state
StateVector stiefelToCartesian(const StiefelState& stiefelState);

// =============================================================================
// Force Models
// =============================================================================

/// Compute acceleration from all configured forces
/// @param t Time (seconds from epoch)
/// @param position Position vector (km)
/// @param velocity Velocity vector (km/s)
/// @param config Force model configuration
/// @return Total acceleration (km/s^2)
Vec3 computeAcceleration(double t, const Vec3& position, const Vec3& velocity,
                          const ForceModelConfig& config);

/// Point mass gravity acceleration
/// @param position Position vector (km)
/// @param mu Gravitational parameter (km^3/s^2)
/// @return Acceleration (km/s^2)
Vec3 pointMassGravity(const Vec3& position, double mu);

/// J2 gravity perturbation
/// @param position Position vector (km)
/// @param mu Gravitational parameter
/// @param J2 J2 coefficient
/// @param Re Reference radius (km)
/// @return J2 acceleration (km/s^2)
Vec3 j2Gravity(const Vec3& position, double mu, double J2, double Re);

/// J2-J4 zonal harmonics gravity
/// @param position Position vector (km)
/// @param mu Gravitational parameter
/// @param J2 J2 coefficient
/// @param J3 J3 coefficient
/// @param J4 J4 coefficient
/// @param Re Reference radius (km)
/// @return Zonal acceleration (km/s^2)
Vec3 zonalGravity(const Vec3& position, double mu,
                   double J2, double J3, double J4, double Re);

/// Third body gravity perturbation
/// @param satPosition Satellite position (km, body-centered)
/// @param bodyPosition Third body position (km, body-centered)
/// @param muBody Third body gravitational parameter (km^3/s^2)
/// @return Third body acceleration (km/s^2)
Vec3 thirdBodyGravity(const Vec3& satPosition, const Vec3& bodyPosition, double muBody);

/// Atmospheric drag acceleration
/// @param position Position (km)
/// @param velocity Velocity relative to atmosphere (km/s)
/// @param config Force model config with drag parameters
/// @param density Atmospheric density (kg/m^3)
/// @return Drag acceleration (km/s^2)
Vec3 dragAcceleration(const Vec3& position, const Vec3& velocity,
                       const ForceModelConfig& config, double density);

/// Solar radiation pressure acceleration
/// @param satPosition Satellite position (km, body-centered)
/// @param sunPosition Sun position (km, body-centered)
/// @param config Force model config with SRP parameters
/// @param inShadow Output: fraction in shadow (0=full sun, 1=umbra)
/// @return SRP acceleration (km/s^2)
Vec3 srpAcceleration(const Vec3& satPosition, const Vec3& sunPosition,
                      const ForceModelConfig& config, double& inShadow);

// =============================================================================
// Two-Body Propagation
// =============================================================================

/// Propagate state using Kepler's equation (two-body)
/// @param state Initial state
/// @param dt Time interval (seconds)
/// @param mu Gravitational parameter
/// @return Propagated state
StateVector propagateKepler(const StateVector& state, double dt, double mu = MU_EARTH);

/// Propagate Keplerian elements
/// @param kep Initial elements
/// @param dt Time interval (seconds)
/// @return Propagated elements (mean anomaly updated)
KeplerianElements propagateKeplerian(const KeplerianElements& kep, double dt);

/// Universal variable formulation for propagation
/// @param state Initial state
/// @param dt Time interval (seconds)
/// @param mu Gravitational parameter
/// @return Propagated state
StateVector propagateUniversal(const StateVector& state, double dt, double mu = MU_EARTH);

// =============================================================================
// Lambert Problem
// =============================================================================

/// Solve Lambert's problem using Universal Variable method
/// @param input Lambert problem input
/// @return Solution(s)
LambertSolution solveLambertUV(const LambertInput& input);

/// Solve Lambert's problem using Izzo's algorithm (multi-revolution capable)
/// @param input Lambert problem input
/// @param maxRevs Maximum revolutions to consider
/// @param solutions Output vector of solutions
/// @return Number of solutions found
int solveLambertIzzo(const LambertInput& input, int maxRevs,
                      std::array<LambertSolution, 5>& solutions);

/// Solve Lambert's problem using Battin's method
/// @param input Lambert problem input
/// @return Solution
LambertSolution solveLambertBattin(const LambertInput& input);

// =============================================================================
// Phase 11.7.2: Extended Lambert & Transfer Mechanics
// =============================================================================

/// Solve Lambert's problem using Gooding's method (robust for all geometries)
/// @param input Lambert problem input
/// @return Solution
LambertSolution solveLambertGooding(const LambertInput& input);

/// Solve Lambert's problem for multiple revolutions
/// @param input Lambert problem input
/// @param maxRevs Maximum number of revolutions to compute
/// @return Multi-revolution solution set
LambertMultiRevSolutions solveLambertMultiRev(const LambertInput& input, int maxRevs);

/// Generate porkchop plot for interplanetary trajectory analysis
/// @param params Porkchop plot parameters
/// @return Porkchop plot result with launch window analysis
PorkchopResult generatePorkchopPlot(const PorkchopParameters& params);

/// Find optimal launch window from porkchop plot
/// @param porkchop Computed porkchop plot
/// @param metric Optimization metric: "c3", "deltav", or "tof"
/// @return Optimal point
PorkchopPoint findOptimalLaunchWindow(const PorkchopResult& porkchop,
                                       const std::string& metric = "c3");

/// Compute single porkchop point (internal)
/// @param departurePos Departure position (km)
/// @param arrivalPos Arrival position (km)
/// @param departureVel Departure body velocity (km/s)
/// @param arrivalVel Arrival body velocity (km/s)
/// @param tof Time of flight (seconds)
/// @param mu Gravitational parameter
/// @param revolutions Number of revolutions
/// @return Porkchop point
PorkchopPoint computePorkchopPoint(const Vec3& departurePos,
                                    const Vec3& arrivalPos,
                                    const Vec3& departureVel,
                                    const Vec3& arrivalVel,
                                    double tof,
                                    double mu,
                                    int revolutions = 0);

/// Get gravity assist parameters for a body
/// @param body Gravity assist body
/// @return Body parameters
GravityAssistParameters getGravityAssistParams(GravityAssistBody body);

/// Design gravity assist trajectory for target turn angle
/// @param vInfIn Incoming V-infinity vector (km/s)
/// @param targetTurnAngle Desired turn angle (rad)
/// @param params Gravity assist body parameters
/// @return Gravity assist geometry
GravityAssistGeometry designGravityAssist(const Vec3& vInfIn,
                                           double targetTurnAngle,
                                           const GravityAssistParameters& params);

/// Compute gravity assist for specified periapsis
/// @param vInfIn Incoming V-infinity vector (km/s)
/// @param periapsisRadius Periapsis radius (km)
/// @param params Gravity assist body parameters
/// @return Gravity assist result
GravityAssistResult computeGravityAssist(const Vec3& vInfIn,
                                          double periapsisRadius,
                                          const GravityAssistParameters& params);

/// Compute powered gravity assist with periapsis burn
/// @param vInfIn Incoming V-infinity vector (km/s)
/// @param periapsisRadius Periapsis radius (km)
/// @param burnDeltaV Periapsis burn magnitude (km/s)
/// @param params Gravity assist body parameters
/// @return Powered gravity assist result
PoweredGravityAssist computePoweredGravityAssist(const Vec3& vInfIn,
                                                  double periapsisRadius,
                                                  double burnDeltaV,
                                                  const GravityAssistParameters& params);

/// Find periapsis radius to achieve desired outgoing V-infinity
/// @param vInfIn Incoming V-infinity vector (km/s)
/// @param vInfOutDesired Desired outgoing V-infinity vector (km/s)
/// @param params Gravity assist body parameters
/// @return Required periapsis radius (km), or -1 if impossible
double findGravityAssistPeriapsis(const Vec3& vInfIn,
                                   const Vec3& vInfOutDesired,
                                   const GravityAssistParameters& params);

/// Calculate maximum turn angle for given V-infinity
/// @param vInfMag V-infinity magnitude (km/s)
/// @param params Gravity assist body parameters
/// @return Maximum turn angle (rad)
double maxGravityAssistTurnAngle(double vInfMag, const GravityAssistParameters& params);

// =============================================================================
// Orbit Determination
// =============================================================================

/// Gauss IOD (Initial Orbit Determination) from 3 observations
/// @param r1, r2, r3 Position observations (km)
/// @param t1, t2, t3 Observation times (Julian dates)
/// @param mu Gravitational parameter
/// @return Orbital elements at t2
KeplerianElements gaussIOD(const Vec3& r1, const Vec3& r2, const Vec3& r3,
                            double t1, double t2, double t3,
                            double mu = MU_EARTH);

/// Gibbs method for IOD from 3 position vectors
/// @param r1, r2, r3 Position vectors (km)
/// @param mu Gravitational parameter
/// @return Velocity at r2 (km/s)
Vec3 gibbsMethod(const Vec3& r1, const Vec3& r2, const Vec3& r3,
                  double mu = MU_EARTH);

/// Herrick-Gibbs for close observations
/// @param r1, r2, r3 Position vectors (km)
/// @param t1, t2, t3 Times (seconds)
/// @param mu Gravitational parameter
/// @return Velocity at r2 (km/s)
Vec3 herrickGibbs(const Vec3& r1, const Vec3& r2, const Vec3& r3,
                   double t1, double t2, double t3,
                   double mu = MU_EARTH);

// =============================================================================
// Conjunction Assessment
// =============================================================================

/// Calculate time of closest approach
/// @param state1 Primary object state
/// @param state2 Secondary object state
/// @param searchWindow Search window in seconds (+/- from epoch)
/// @return TCA result
TCAResult calculateTCA(const StateVector& state1, const StateVector& state2,
                        double searchWindow = 86400.0);

/// Calculate collision probability using Chan's 2D Pc
/// @param tca TCA result
/// @param cov1 Primary covariance
/// @param cov2 Secondary covariance
/// @param hardBodyRadius Combined collision radius (km)
/// @return Collision probability
CollisionProbability calculateCollisionProbability(
    const TCAResult& tca,
    const Covariance6& cov1,
    const Covariance6& cov2,
    double hardBodyRadius);

/// Alfano's maximum probability method
/// @param tca TCA result
/// @param cov1 Primary covariance
/// @param cov2 Secondary covariance
/// @param hardBodyRadius Combined collision radius (km)
/// @return Maximum collision probability
double calculateMaxProbability(const TCAResult& tca,
                                const Covariance6& cov1,
                                const Covariance6& cov2,
                                double hardBodyRadius);

// =============================================================================
// Maneuver Planning
// =============================================================================

/// Calculate Hohmann transfer between circular orbits
/// @param r1 Initial orbit radius (km)
/// @param r2 Final orbit radius (km)
/// @param mu Gravitational parameter
/// @return Hohmann transfer parameters
HohmannTransfer calculateHohmann(double r1, double r2, double mu = MU_EARTH);

/// Calculate bi-elliptic transfer
/// @param r1 Initial orbit radius (km)
/// @param r2 Final orbit radius (km)
/// @param rb Intermediate apoapsis radius (km)
/// @param mu Gravitational parameter
/// @return Bi-elliptic transfer parameters
BiEllipticTransfer calculateBiElliptic(double r1, double r2, double rb,
                                        double mu = MU_EARTH);

/// Calculate optimal plane change maneuver
/// @param v Orbital velocity at maneuver point (km/s)
/// @param deltaInc Desired inclination change (rad)
/// @param deltaRaan Desired RAAN change (rad, optional)
/// @return Plane change maneuver
PlaneChangeManeuver calculatePlaneChange(double v, double deltaInc,
                                          double deltaRaan = 0.0);

/// Calculate combined altitude and plane change
/// @param state Current state
/// @param targetA Target semi-major axis (km)
/// @param targetInc Target inclination (rad)
/// @param mu Gravitational parameter
/// @return Sequence of maneuvers
std::array<ImpulsiveManeuver, 3> calculateCombinedManeuver(
    const StateVector& state,
    double targetA, double targetInc,
    double mu = MU_EARTH);

// =============================================================================
// Rendezvous & Proximity Operations (RPO)
// =============================================================================

/// Clohessy-Wiltshire state transition matrix
/// @param n Mean motion of reference orbit (rad/s)
/// @param dt Time interval (seconds)
/// @return 6x6 state transition matrix
Mat6 cwStateTransition(double n, double dt);

/// Propagate relative state using CW equations
/// @param state Initial CW state
/// @param n Mean motion (rad/s)
/// @param dt Time interval (seconds)
/// @return Propagated CW state
CWState propagateCW(const CWState& state, double n, double dt);

/// Convert Keplerian ROE to Cartesian CW state
/// @param roe Relative orbital elements
/// @param chiefElements Chief orbit Keplerian elements
/// @return CW state in LVLH frame
CWState roeToCartesian(const RelativeOrbitalElements& roe,
                        const KeplerianElements& chiefElements);

/// Convert Cartesian CW state to Keplerian ROE
/// @param cwState CW state in LVLH frame
/// @param chiefElements Chief orbit Keplerian elements
/// @return Relative orbital elements
RelativeOrbitalElements cartesianToROE(const CWState& cwState,
                                        const KeplerianElements& chiefElements);

/// J2-perturbed ROE state transition matrix (Koenig-Guffanti-D'Amico)
/// @param chiefElements Chief orbit elements
/// @param dt Time interval (seconds)
/// @return 6x6 ROE state transition matrix
Mat6 roeStateTransitionJ2(const KeplerianElements& chiefElements, double dt);

/// Calculate impulsive maneuver for CW state change
/// @param currentState Current CW state
/// @param targetState Desired CW state
/// @param n Mean motion (rad/s)
/// @param maxDeltaV Maximum delta-V (km/s)
/// @return Required delta-V in LVLH frame
Vec3 cwImpulsiveManeuver(const CWState& currentState,
                          const CWState& targetState,
                          double n, double maxDeltaV);

/// Calculate hold point station-keeping delta-V
/// @param holdPoint Desired hold point
/// @param n Mean motion (rad/s)
/// @param period Station-keeping period (seconds)
/// @return Delta-V per period (km/s)
double holdPointDeltaV(const HoldPoint& holdPoint, double n, double period);

/// Design passively safe natural motion trajectory
/// @param chiefElements Chief orbit elements
/// @param safetyDistance Minimum separation distance (km)
/// @return ROE for passively safe trajectory
RelativeOrbitalElements designPassivelySafeTrajectory(
    const KeplerianElements& chiefElements,
    double safetyDistance);

/// Calculate collision avoidance maneuver
/// @param currentState Current CW state
/// @param threatVector Direction of threat (LVLH)
/// @param safeDistance Safe separation distance (km)
/// @return CAM delta-V in LVLH frame
Vec3 collisionAvoidanceManeuver(const CWState& currentState,
                                 const Vec3& threatVector,
                                 double safeDistance);

// =============================================================================
// GEO Station Keeping
// =============================================================================

/// GEO station keeping analysis result
struct GEOStationKeepingResult {
    double ewDeltaV{0};       ///< East-West delta-V per year (km/s)
    double nsDeltaV{0};       ///< North-South delta-V per year (km/s)
    double totalDeltaV{0};    ///< Total delta-V per year (km/s)
    double ewPeriod{0};       ///< E-W maneuver period (days)
    double nsPeriod{0};       ///< N-S maneuver period (days)
    bool valid{false};
};

/// Calculate GEO station keeping requirements
/// @param longitude Nominal longitude (rad)
/// @param deadbandEW E-W deadband (rad)
/// @param deadbandNS N-S deadband (rad)
/// @param solarActivity Solar activity factor (0-1)
/// @return Station keeping analysis result
GEOStationKeepingResult calculateGEOStationKeeping(
    double longitude,
    double deadbandEW,
    double deadbandNS,
    double solarActivity = 0.5);

// =============================================================================
// NASA Standard Breakup Model
// =============================================================================

/// Fragment from breakup event
struct BreakupFragment {
    double mass;            ///< Fragment mass (kg)
    double area;            ///< Cross-sectional area (m^2)
    double areaToMass;      ///< Area-to-mass ratio (m^2/kg)
    Vec3 deltaV;            ///< Delta-V relative to parent (km/s)
};

/// Breakup event result
struct BreakupResult {
    std::vector<BreakupFragment> fragments;
    double totalMass;       ///< Total fragment mass (kg)
    int fragmentCount;      ///< Number of fragments
    bool isExplosion;       ///< true = explosion, false = collision
};

/// Generate debris fragments from breakup event (NASA Standard Breakup Model)
/// @param parentMass Parent object mass (kg)
/// @param impactorMass Impactor mass (kg, 0 for explosion)
/// @param collisionVelocity Collision velocity (km/s, 0 for explosion)
/// @param maxFragments Maximum fragments to generate
/// @return Breakup result with fragment properties
BreakupResult generateBreakupFragments(
    double parentMass,
    double impactorMass,
    double collisionVelocity,
    int maxFragments = 1000);

// =============================================================================
// Relative Navigation
// =============================================================================

/// Angles-only measurement in LVLH frame
struct AnglesOnlyMeasurement {
    double azimuth;     ///< Azimuth angle (rad)
    double elevation;   ///< Elevation angle (rad)
    double epoch;       ///< Measurement time (Julian date)
};

/// Range + angles measurement in LVLH frame
struct RangeAnglesMeasurement {
    double range;       ///< Range to target (km)
    double azimuth;     ///< Azimuth angle (rad)
    double elevation;   ///< Elevation angle (rad)
    double epoch;       ///< Measurement time (Julian date)
};

/// Relative navigation state estimate
struct RelativeNavState {
    CWState state;      ///< Estimated relative state
    Mat6 covariance;    ///< State covariance
    bool valid{false};
};

/// Angles-only relative navigation (requires maneuver for observability)
/// @param measurements Vector of angle measurements
/// @param chiefOrbit Chief spacecraft orbital elements
/// @param initialRange Initial range estimate (km)
/// @return Estimated relative state
RelativeNavState anglesOnlyNavigation(
    const std::vector<AnglesOnlyMeasurement>& measurements,
    const KeplerianElements& chiefOrbit,
    double initialRange = 10.0);

/// Range + angles relative navigation
/// @param measurements Vector of range/angle measurements
/// @param chiefOrbit Chief spacecraft orbital elements
/// @return Estimated relative state
RelativeNavState rangeAnglesNavigation(
    const std::vector<RangeAnglesMeasurement>& measurements,
    const KeplerianElements& chiefOrbit);

// =============================================================================
// Utility Functions
// =============================================================================

/// Calculate orbital period
/// @param a Semi-major axis (km)
/// @param mu Gravitational parameter
/// @return Period (seconds)
inline double orbitalPeriod(double a, double mu = MU_EARTH) {
    return TWO_PI * std::sqrt(a * a * a / mu);
}

/// Calculate mean motion
/// @param a Semi-major axis (km)
/// @param mu Gravitational parameter
/// @return Mean motion (rad/s)
inline double meanMotion(double a, double mu = MU_EARTH) {
    return std::sqrt(mu / (a * a * a));
}

/// Calculate circular velocity
/// @param r Orbital radius (km)
/// @param mu Gravitational parameter
/// @return Circular velocity (km/s)
inline double circularVelocity(double r, double mu = MU_EARTH) {
    return std::sqrt(mu / r);
}

/// Calculate escape velocity
/// @param r Distance from central body (km)
/// @param mu Gravitational parameter
/// @return Escape velocity (km/s)
inline double escapeVelocity(double r, double mu = MU_EARTH) {
    return std::sqrt(2.0 * mu / r);
}

/// Calculate vis-viva velocity
/// @param r Current radius (km)
/// @param a Semi-major axis (km)
/// @param mu Gravitational parameter
/// @return Velocity (km/s)
inline double visVivaVelocity(double r, double a, double mu = MU_EARTH) {
    return std::sqrt(mu * (2.0/r - 1.0/a));
}

/// Calculate flight path angle
/// @param state Cartesian state
/// @return Flight path angle (rad)
double flightPathAngle(const StateVector& state);

/// Transform vector to RTN (radial-transverse-normal) frame
/// @param vec Vector in inertial frame
/// @param state Reference state
/// @return Vector in RTN frame
Vec3 inertialToRTN(const Vec3& vec, const StateVector& state);

/// Transform vector from RTN to inertial frame
/// @param vec Vector in RTN frame
/// @param state Reference state
/// @return Vector in inertial frame
Vec3 rtnToInertial(const Vec3& vec, const StateVector& state);

// =============================================================================
// Semi-Analytical Mean Element Theory
// =============================================================================

/// Mean element type classification
enum class MeanElementTheory {
    Brouwer,        ///< Brouwer-Lyddane (J2 secular/periodic)
    Kozai,          ///< Kozai (J2 secular only)
    SGP4            ///< SGP4/SDP4 mean elements
};

/// Brouwer-Lyddane conversion result
struct BrouwerResult {
    KeplerianElements meanElements;    ///< Mean elements
    KeplerianElements oscElements;     ///< Osculating elements
    double shortPeriodCorrection[6];   ///< Short-period corrections
    double longPeriodCorrection[6];    ///< Long-period corrections
    bool valid{false};
};

/// Convert osculating elements to Brouwer-Lyddane mean elements
/// @param osc Osculating Keplerian elements
/// @return Brouwer-Lyddane mean elements with corrections
BrouwerResult osculatingToBrouwerMean(const KeplerianElements& osc);

/// Convert Brouwer-Lyddane mean elements to osculating
/// @param mean Mean Keplerian elements (Brouwer)
/// @return Osculating elements
KeplerianElements brouwerMeanToOsculating(const KeplerianElements& mean);

/// Propagate using Brouwer-Lyddane analytical theory
/// @param meanElements Mean elements at epoch
/// @param dt Time from epoch (seconds)
/// @return Osculating elements at dt
KeplerianElements propagateBrouwer(const KeplerianElements& meanElements, double dt);

/// Convert osculating elements to Kozai mean elements
/// @param osc Osculating Keplerian elements
/// @return Kozai mean elements (J2 secular only)
KeplerianElements osculatingToKozaiMean(const KeplerianElements& osc);

/// Propagate using Kozai mean element theory (J2 secular)
/// @param kozaiMean Kozai mean elements at epoch
/// @param dt Time from epoch (seconds)
/// @return Mean elements at dt
KeplerianElements propagateKozai(const KeplerianElements& kozaiMean, double dt);

/// Calculate J2 secular drift rates
/// @param kep Orbital elements
/// @return [dM/dt, dω/dt, dΩ/dt] in rad/s (excluding mean motion)
Vec3 j2SecularRates(const KeplerianElements& kep);

// =============================================================================
// Batch Least Squares Orbit Determination
// =============================================================================

/// Observation type
enum class ObservationType {
    RangeOnly,          ///< Range measurement (radar)
    RangeRate,          ///< Range-rate (Doppler)
    RangeRangeRate,     ///< Range + Doppler
    AnglesOnly,         ///< Azimuth + Elevation
    RangeAngles,        ///< Range + Az + El
    GPS                 ///< Position + Velocity
};

/// Single observation for orbit determination
struct Observation {
    double epoch;               ///< Julian date
    ObservationType type;       ///< Measurement type
    Vec3 stationPosition;       ///< Ground station ECEF position (km)
    double range{0};            ///< Range measurement (km)
    double rangeRate{0};        ///< Range-rate (km/s)
    double azimuth{0};          ///< Azimuth (rad)
    double elevation{0};        ///< Elevation (rad)
    Vec3 gpsPosition;           ///< GPS position if available
    Vec3 gpsVelocity;           ///< GPS velocity if available
    double sigma{0.1};          ///< 1-sigma measurement uncertainty
};

/// Batch least squares result
struct BatchLSQResult {
    StateVector estimatedState;         ///< Best-fit state at epoch
    Covariance6 covariance;             ///< State covariance matrix
    double rmsResidual;                 ///< RMS of post-fit residuals
    int iterations;                     ///< Convergence iterations
    std::vector<double> residuals;      ///< Post-fit residuals
    bool converged{false};
};

/// Perform batch least squares orbit determination
/// @param observations Vector of observations
/// @param initialGuess Initial state estimate
/// @param maxIterations Maximum iterations
/// @param convergenceTol Convergence tolerance (km)
/// @return OD solution
BatchLSQResult batchLeastSquaresOD(
    const std::vector<Observation>& observations,
    const StateVector& initialGuess,
    int maxIterations = 10,
    double convergenceTol = 1e-6);

/// Calculate observation residual
/// @param obs Observation
/// @param predicted Predicted state at observation time
/// @return Observed - Computed residual
double calculateResidual(const Observation& obs, const StateVector& predicted);

/// Compute state transition matrix via finite differences
/// @param state State at t0
/// @param dt Time interval (seconds)
/// @param mu Gravitational parameter
/// @return 6x6 STM
Mat6 computeSTM(const StateVector& state, double dt, double mu = MU_EARTH);

// =============================================================================
// Space Object Catalog & Track Correlation
// =============================================================================

/// Catalog entry for a space object
struct CatalogEntry {
    int catalogId;                      ///< NORAD catalog number
    std::string objectName;             ///< Object designation
    KeplerianElements elements;         ///< Current elements
    Covariance6 covariance;             ///< State uncertainty
    double epoch;                       ///< Epoch (JD)
    double bstar{0};                    ///< B* drag term (SGP4)
    char objectType{'U'};               ///< U=unknown, D=debris, P=payload, R=rocket body
    double rcs{-1};                     ///< Radar cross section (m^2, -1=unknown)
};

/// Track (uncorrelated observation set)
struct Track {
    int trackId;                        ///< Track identifier
    std::vector<Observation> obs;       ///< Observations in track
    StateVector initialOrbit;           ///< IOD solution
    double quality{0};                  ///< Track quality metric [0-1]
    bool correlated{false};             ///< True if correlated to catalog
    int correlatedCatalogId{-1};        ///< Catalog ID if correlated
};

/// Track correlation result
struct CorrelationResult {
    int trackId;                        ///< Track being correlated
    int catalogId;                      ///< Best matching catalog entry
    double mahalanobisDistance;         ///< Statistical distance
    double positionDifference;          ///< Position difference (km)
    double velocityDifference;          ///< Velocity difference (km/s)
    double probability;                 ///< Association probability
    bool isNewObject{false};            ///< True if no good correlation found
};

/// Correlate track to catalog
/// @param track Uncorrelated track with IOD solution
/// @param catalog Vector of catalog entries
/// @param gatingThreshold Maximum Mahalanobis distance for correlation
/// @return Correlation result
CorrelationResult correlateTrackToCatalog(
    const Track& track,
    const std::vector<CatalogEntry>& catalog,
    double gatingThreshold = 5.0);

/// Update catalog entry with new observation
/// @param entry Catalog entry to update (modified in place)
/// @param obs New observation
/// @return True if update successful
bool updateCatalogEntry(CatalogEntry& entry, const Observation& obs);

/// Predict catalog entry to new epoch
/// @param entry Catalog entry
/// @param targetEpoch Target epoch (JD)
/// @return Predicted state
StateVector predictCatalogEntry(const CatalogEntry& entry, double targetEpoch);

/// Calculate Mahalanobis distance between two states
/// @param state1 First state
/// @param cov1 First covariance
/// @param state2 Second state
/// @param cov2 Second covariance
/// @return Mahalanobis distance
double mahalanobisDistance(
    const StateVector& state1, const Covariance6& cov1,
    const StateVector& state2, const Covariance6& cov2);

// =============================================================================
// Phase 8.6 Environment Models
// =============================================================================

// -----------------------------------------------------------------------------
// 8.6.1 High-Fidelity Gravity Models
// -----------------------------------------------------------------------------

/// Initialize EGM2008 gravity field coefficients (up to specified degree/order)
/// @param maxDegree Maximum degree (2-2190, recommended: 70 for LEO, 20 for GEO)
/// @param maxOrder Maximum order (0 = zonal only, maxDegree = full field)
/// @return Gravity field coefficient structure
GravityFieldCoefficients initEGM2008(uint16_t maxDegree = 70, uint16_t maxOrder = 70);

/// Initialize GRGM1200A lunar gravity field coefficients
/// @param maxDegree Maximum degree (2-1200, recommended: 100)
/// @param maxOrder Maximum order (0 = zonal only)
/// @return Gravity field coefficient structure for Moon
GravityFieldCoefficients initGRGM1200A(uint16_t maxDegree = 100, uint16_t maxOrder = 100);

/// Compute high-fidelity gravity acceleration using spherical harmonics
/// @param position Position in body-fixed frame (km)
/// @param coeffs Gravity field coefficients
/// @return Gravity acceleration with component breakdown
GravityAcceleration computeSphericalHarmonicGravity(
    const Vec3& position,
    const GravityFieldCoefficients& coeffs);

/// Compute gravity acceleration at specific degree/order (efficient for truncation)
/// @param position Position in body-fixed frame (km)
/// @param coeffs Gravity field coefficients
/// @param degree Degree to compute (overrides coeffs.maxDegree)
/// @param order Order to compute (overrides coeffs.maxOrder)
/// @return Gravity acceleration (km/s^2)
Vec3 computeGravityAtDegree(
    const Vec3& position,
    const GravityFieldCoefficients& coeffs,
    uint16_t degree,
    uint16_t order);

/// Compute normalized associated Legendre functions
/// @param latitude Geocentric latitude (rad)
/// @param maxDegree Maximum degree to compute
/// @param Pnm Output: P[n][m] normalized values
/// @param dPnm Output: dP[n][m]/d(latitude) derivatives
void computeLegendrePolynomials(
    double latitude,
    uint16_t maxDegree,
    double Pnm[][21],
    double dPnm[][21]);

// -----------------------------------------------------------------------------
// 8.6.2 Third Body Perturbations - JPL DE Ephemeris
// -----------------------------------------------------------------------------

/// Get celestial body position using analytical approximations
/// @param body Body identifier
/// @param jd Julian date (TDB)
/// @return Ephemeris state (heliocentric or geocentric depending on body)
EphemerisState getAnalyticalEphemeris(CelestialBody body, double jd);

/// Get Sun position (geocentric J2000)
/// @param jd Julian date (TDB)
/// @return Sun position and velocity
EphemerisState getSunPosition(double jd);

/// Get Moon position (geocentric J2000)
/// @param jd Julian date (TDB)
/// @return Moon position and velocity
EphemerisState getMoonPosition(double jd);

/// Get planet position (heliocentric J2000)
/// @param body Planet identifier
/// @param jd Julian date (TDB)
/// @return Planet position and velocity
EphemerisState getPlanetPosition(CelestialBody body, double jd);

/// Compute third-body perturbation acceleration
/// @param satPosition Satellite position (km, geocentric)
/// @param config Third body configuration
/// @param jd Julian date (TDB)
/// @return Third-body acceleration breakdown
ThirdBodyAcceleration computeThirdBodyAcceleration(
    const Vec3& satPosition,
    const ThirdBodyConfig& config,
    double jd);

/// Compute point mass third body gravity (internal use)
/// @param satPos Satellite position relative to central body (km)
/// @param bodyPos Third body position relative to central body (km)
/// @param muBody Third body gravitational parameter (km^3/s^2)
/// @return Perturbation acceleration (km/s^2)
Vec3 pointMassThirdBody(const Vec3& satPos, const Vec3& bodyPos, double muBody);

// -----------------------------------------------------------------------------
// 8.6.3 Solar Radiation Pressure
// -----------------------------------------------------------------------------

/// Compute shadow geometry (conical model)
/// @param satPosition Satellite position (km, geocentric)
/// @param sunPosition Sun position (km, geocentric)
/// @param occultingBodyRadius Radius of occulting body (km)
/// @param model Shadow model type
/// @return Shadow geometry details
ShadowGeometry computeShadowGeometry(
    const Vec3& satPosition,
    const Vec3& sunPosition,
    double occultingBodyRadius = RE_EARTH,
    ShadowModelType model = ShadowModelType::Conical);

/// Compute dual-cone shadow (Earth + Moon)
/// @param satPosition Satellite position (km, geocentric)
/// @param sunPosition Sun position (km, geocentric)
/// @param moonPosition Moon position (km, geocentric)
/// @return Combined shadow geometry
ShadowGeometry computeDualConeShadow(
    const Vec3& satPosition,
    const Vec3& sunPosition,
    const Vec3& moonPosition);

/// Compute SRP acceleration using cannonball model
/// @param satPosition Satellite position (km, geocentric)
/// @param sunPosition Sun position (km, geocentric)
/// @param config SRP configuration
/// @return SRP acceleration with details
SRPAcceleration computeSRPCannonball(
    const Vec3& satPosition,
    const Vec3& sunPosition,
    const SRPConfig& config);

/// Compute SRP acceleration using box-wing model
/// @param satPosition Satellite position (km, geocentric)
/// @param sunPosition Sun position (km, geocentric)
/// @param satAttitude Satellite attitude quaternion (optional)
/// @param config SRP configuration
/// @return SRP acceleration
SRPAcceleration computeSRPBoxWing(
    const Vec3& satPosition,
    const Vec3& sunPosition,
    const Vec3& satAttitude,
    const SRPConfig& config);

/// Compute solar flux at distance from Sun
/// @param sunDistance Distance from Sun (km)
/// @return Solar flux (W/m^2)
double computeSolarFlux(double sunDistance);

// -----------------------------------------------------------------------------
// 8.6.4 Advanced Atmospheric Models
// -----------------------------------------------------------------------------

/// Compute exponential atmosphere density (simple model)
/// @param altitude Geodetic altitude (km)
/// @return Density (kg/m^3)
double exponentialAtmosphereDensity(double altitude);

/// Compute US Standard Atmosphere 1976 density
/// @param altitude Geodetic altitude (km)
/// @return Atmospheric density structure
AtmosphericDensity computeUSSA1976(double altitude);

/// Compute NRLMSISE-00 atmospheric density
/// @param position Position (km, geocentric ITRF)
/// @param jd Julian date (UT1)
/// @param weather Space weather data
/// @param config Atmosphere configuration
/// @return Atmospheric density with species breakdown
AtmosphericDensity computeNRLMSISE00(
    const Vec3& position,
    double jd,
    const SpaceWeatherData& weather,
    const AtmosphereConfig& config = AtmosphereConfig());

/// Compute Jacchia-Bowman 2008 atmospheric density
/// @param position Position (km, geocentric ITRF)
/// @param jd Julian date (UT1)
/// @param weather Space weather data (uses S107, M107, Y107)
/// @return Atmospheric density structure
AtmosphericDensity computeJB2008(
    const Vec3& position,
    double jd,
    const SpaceWeatherData& weather);

/// Compute DTM2020 atmospheric density
/// @param position Position (km, geocentric ITRF)
/// @param jd Julian date (UT1)
/// @param weather Space weather data
/// @return Atmospheric density structure
AtmosphericDensity computeDTM2020(
    const Vec3& position,
    double jd,
    const SpaceWeatherData& weather);

/// Compute atmospheric drag acceleration
/// @param position Satellite position (km, ITRF)
/// @param velocity Satellite velocity (km/s, ITRF)
/// @param jd Julian date (UT1)
/// @param config Drag configuration
/// @param weather Space weather data
/// @return Drag acceleration with details
DragAccelerationResult computeDragAcceleration(
    const Vec3& position,
    const Vec3& velocity,
    double jd,
    const DragConfig& config,
    const SpaceWeatherData& weather);

/// Convert geodetic to ECEF position
/// @param latitude Geodetic latitude (rad)
/// @param longitude Longitude (rad)
/// @param altitude Altitude above ellipsoid (km)
/// @return ECEF position (km)
Vec3 geodeticToECEF(double latitude, double longitude, double altitude);

/// Convert ECEF to geodetic coordinates
/// @param ecef ECEF position (km)
/// @param latitude Output geodetic latitude (rad)
/// @param longitude Output longitude (rad)
/// @param altitude Output altitude (km)
void ecefToGeodetic(const Vec3& ecef, double& latitude, double& longitude, double& altitude);

/// Compute local solar time
/// @param longitude Geographic longitude (rad)
/// @param jd Julian date (UT)
/// @return Local solar time (hours, 0-24)
double computeLocalSolarTime(double longitude, double jd);

// -----------------------------------------------------------------------------
// 8.6.5 Space Weather
// -----------------------------------------------------------------------------

/// Get space weather data for a given date
/// @param jd Julian date (UT)
/// @param config Space weather configuration
/// @return Space weather data structure
SpaceWeatherData getSpaceWeatherData(double jd, const SpaceWeatherConfig& config);

/// Interpolate space weather indices
/// @param jd Julian date
/// @param data1 Data at earlier epoch
/// @param data2 Data at later epoch
/// @return Interpolated space weather data
SpaceWeatherData interpolateSpaceWeather(
    double jd,
    const SpaceWeatherData& data1,
    const SpaceWeatherData& data2);

/// Convert Kp to Ap index
/// @param Kp Kp index (0-9)
/// @return Ap index
double kpToAp(double Kp);

/// Convert Ap to Kp index
/// @param Ap Ap index
/// @return Kp index
double apToKp(double Ap);

/// Check if geomagnetic storm conditions
/// @param weather Space weather data
/// @return true if storm conditions detected
bool isGeomagneticStorm(const SpaceWeatherData& weather);

/// Compute 81-day centered average F10.7
/// @param jd Julian date
/// @param f107Daily Daily F10.7 values for 81-day window
/// @return 81-day centered average
double computeF107Average(double jd, const double* f107Daily);

// -----------------------------------------------------------------------------
// Combined Environment Acceleration
// -----------------------------------------------------------------------------

/// Compute total environmental acceleration with all Phase 8.6 models
/// @param position Position (km, inertial J2000)
/// @param velocity Velocity (km/s, inertial J2000)
/// @param jd Julian date (TDB)
/// @param config Extended force model configuration
/// @return Total non-gravitational acceleration (km/s^2)
Vec3 computeEnvironmentAcceleration(
    const Vec3& position,
    const Vec3& velocity,
    double jd,
    const ForceModelConfigExtended& config);

/// Compute all accelerations with detailed breakdown
/// @param position Position (km, inertial J2000)
/// @param velocity Velocity (km/s, inertial J2000)
/// @param jd Julian date (TDB)
/// @param config Extended force model configuration
/// @param gravity Output: Gravity acceleration details
/// @param thirdBody Output: Third body acceleration details
/// @param srp Output: SRP acceleration details
/// @param drag Output: Drag acceleration details
/// @return Total acceleration (km/s^2)
Vec3 computeAllAccelerations(
    const Vec3& position,
    const Vec3& velocity,
    double jd,
    const ForceModelConfigExtended& config,
    GravityAcceleration& gravity,
    ThirdBodyAcceleration& thirdBody,
    SRPAcceleration& srp,
    DragAccelerationResult& drag);

// =============================================================================
// Phase 8.7 Data Source Integration
// =============================================================================

// -----------------------------------------------------------------------------
// 8.7.1 Space-Track.org API
// -----------------------------------------------------------------------------

/// Build Space-Track.org API URL for query
/// @param query Query parameters
/// @return API URL string
std::string buildSpaceTrackUrl(const SpaceTrackQuery& query);

/// Build Space-Track.org authentication request
/// @param credentials Credentials (username, password required)
/// @return HTTP request for login
HttpRequest buildSpaceTrackLoginRequest(const SpaceTrackCredentials& credentials);

/// Parse Space-Track.org login response
/// @param response HTTP response from login
/// @param credentials Credentials to update with session cookie
/// @return true if login successful
bool parseSpaceTrackLoginResponse(const HttpResponse& response, SpaceTrackCredentials& credentials);

/// Build Space-Track.org TLE query request
/// @param query Query parameters
/// @param credentials Authenticated credentials
/// @return HTTP request for TLE query
HttpRequest buildSpaceTrackTLERequest(const SpaceTrackQuery& query,
                                       const SpaceTrackCredentials& credentials);

/// Parse Space-Track.org TLE response (3LE format)
/// @param response HTTP response
/// @return TLE collection
TLECollection parseSpaceTrackTLEResponse(const HttpResponse& response);

/// Build Space-Track.org SATCAT query request
/// @param query Query parameters
/// @param credentials Authenticated credentials
/// @return HTTP request for SATCAT query
HttpRequest buildSpaceTrackSatcatRequest(const SpaceTrackQuery& query,
                                          const SpaceTrackCredentials& credentials);

/// Parse Space-Track.org SATCAT response (JSON)
/// @param response HTTP response
/// @return Vector of satellite catalog entries
std::vector<SatcatEntry> parseSpaceTrackSatcatResponse(const HttpResponse& response);

// -----------------------------------------------------------------------------
// 8.7.2 CelesTrak Integration
// -----------------------------------------------------------------------------

/// Get CelesTrak URL for a category
/// @param category CelesTrak category
/// @param format Format: "tle" for 3LE, "gp" for GP JSON, "xml" for OMM XML
/// @return URL string
std::string getCelesTrakUrl(CelesTrakCategory category, const std::string& format = "tle");

/// Build CelesTrak TLE request
/// @param category CelesTrak category
/// @return HTTP request for TLE data
HttpRequest buildCelesTrakTLERequest(CelesTrakCategory category);

/// Build CelesTrak GP data request (JSON format)
/// @param category CelesTrak category
/// @return HTTP request for GP data
HttpRequest buildCelesTrakGPRequest(CelesTrakCategory category);

/// Build CelesTrak request for specific NORAD ID
/// @param catalogNumber NORAD catalog number
/// @param format "tle" or "gp"
/// @return HTTP request
HttpRequest buildCelesTrakQueryRequest(int catalogNumber, const std::string& format = "tle");

/// Parse CelesTrak TLE response (3LE text format)
/// @param response HTTP response
/// @return TLE collection
TLECollection parseCelesTrakTLEResponse(const HttpResponse& response);

/// Parse CelesTrak GP response (JSON format)
/// @param response HTTP response
/// @return Vector of GP data
std::vector<GPData> parseCelesTrakGPResponse(const HttpResponse& response);

/// Convert GP data to TLE
/// @param gp GP data
/// @return TLE structure
TLE gpDataToTLE(const GPData& gp);

// -----------------------------------------------------------------------------
// 8.7.3 JPL Horizons Integration
// -----------------------------------------------------------------------------

/// Build JPL Horizons API URL for query
/// @param query Horizons query parameters
/// @return API URL string
std::string buildHorizonsUrl(const HorizonsQuery& query);

/// Build JPL Horizons HTTP request
/// @param query Horizons query parameters
/// @return HTTP request
HttpRequest buildHorizonsRequest(const HorizonsQuery& query);

/// Parse JPL Horizons vector ephemeris response
/// @param response HTTP response
/// @return Ephemeris result
HorizonsEphemeris parseHorizonsVectorResponse(const HttpResponse& response);

/// Parse JPL Horizons elements response
/// @param response HTTP response
/// @return Keplerian elements at each epoch
std::vector<KeplerianElements> parseHorizonsElementsResponse(const HttpResponse& response);

/// Get ephemeris for a major body using analytical approximations (offline)
/// @param body Celestial body ID (use NAIFIds constants)
/// @param jdTDB Julian Date TDB
/// @param center Center body (default: Earth center)
/// @return Ephemeris state
EphemerisState getAnalyticalEphemeris(int body, double jdTDB, int center = NAIFIds::GEOCENTER);

/// Compute Sun position using simplified analytical model
/// @param jdTDB Julian Date TDB
/// @return Sun position relative to Earth (km, J2000 ecliptic)
Vec3 computeSunPosition(double jdTDB);

/// Compute Moon position using simplified analytical model
/// @param jdTDB Julian Date TDB
/// @return Moon position relative to Earth (km, J2000 ecliptic)
Vec3 computeMoonPosition(double jdTDB);

/// Convert J2000 ecliptic to J2000 equatorial coordinates
/// @param ecliptic Position in ecliptic coordinates (km)
/// @return Position in equatorial coordinates (km)
Vec3 eclipticToEquatorial(const Vec3& ecliptic);

/// Convert J2000 equatorial to J2000 ecliptic coordinates
/// @param equatorial Position in equatorial coordinates (km)
/// @return Position in ecliptic coordinates (km)
Vec3 equatorialToEcliptic(const Vec3& equatorial);

// -----------------------------------------------------------------------------
// 8.7.4 IERS Data Integration
// -----------------------------------------------------------------------------

/// Build IERS data request URL
/// @param bulletin Bulletin type
/// @return URL string
std::string getIERSUrl(IERSBulletinType bulletin);

/// Build IERS EOP data request
/// @param bulletin Bulletin type (BulletinA, FinalsAll, etc.)
/// @return HTTP request
HttpRequest buildIERSRequest(IERSBulletinType bulletin);

/// Parse IERS Bulletin A response
/// @param response HTTP response
/// @return IERS data set
IERSDataSet parseIERSBulletinA(const HttpResponse& response);

/// Parse IERS Finals2000A response
/// @param response HTTP response
/// @return IERS data set
IERSDataSet parseIERSFinals2000A(const HttpResponse& response);

/// Build leap second file request (IERS Bulletin C)
/// @return HTTP request
HttpRequest buildLeapSecondRequest();

/// Parse leap second file response
/// @param response HTTP response
/// @return Vector of leap seconds
std::vector<LeapSecondEntry> parseLeapSecondResponse(const HttpResponse& response);

/// Interpolate EOP data at given MJD
/// @param data IERS data set
/// @param mjd Modified Julian Date
/// @return Interpolated EOP
EOPData interpolateEOPData(const IERSDataSet& data, double mjd);

/// Get TAI-UTC offset at given Julian Date
/// @param data IERS data set
/// @param jd Julian Date
/// @return TAI-UTC in seconds
double getTAI_UTC(const IERSDataSet& data, double jd);

/// Convert UTC to UT1 using EOP data
/// @param utcJD UTC Julian Date
/// @param data IERS data set
/// @return UT1 Julian Date
double utcToUT1(double utcJD, const IERSDataSet& data);

/// Convert UTC to TDB (Barycentric Dynamical Time)
/// @param utcJD UTC Julian Date
/// @param data IERS data set (for leap seconds)
/// @return TDB Julian Date
double utcToTDB(double utcJD, const IERSDataSet& data);

/// Compute polar motion rotation matrix
/// @param eop EOP data
/// @return Rotation matrix for polar motion
Mat3 computePolarMotionMatrix(const EOPData& eop);

/// Compute precession-nutation matrix (IAU 2006/2000A)
/// @param jdTT Julian Date TT
/// @param eop EOP data (for dX, dY corrections)
/// @return Precession-nutation matrix
Mat3 computePrecessionNutationMatrix(double jdTT, const EOPData& eop);

// -----------------------------------------------------------------------------
// 8.7.5 Real-time TLE Update Pipeline
// -----------------------------------------------------------------------------

/// Initialize TLE catalog with configuration
/// @param config Update configuration
/// @return Initialized catalog
TLECatalog initTLECatalog(const TLEUpdateConfig& config);

/// Trigger TLE update from configured sources
/// @param catalog Catalog to update
/// @param callback Callback for update completion (async)
/// @return true if update started successfully
bool triggerTLEUpdate(TLECatalog& catalog, TLEUpdateCallback callback = nullptr);

/// Perform synchronous TLE update (blocking)
/// @param catalog Catalog to update
/// @return Update result
TLEUpdateResult updateTLEsSync(TLECatalog& catalog);

/// Check if TLE update is needed based on configuration
/// @param catalog Catalog to check
/// @param currentJD Current Julian Date
/// @return true if update should be triggered
bool shouldUpdateTLEs(const TLECatalog& catalog, double currentJD);

/// Get list of stale TLEs that need update
/// @param catalog TLE catalog
/// @param currentJD Current Julian Date
/// @return Vector of NORAD IDs needing update
std::vector<int> getStaleTLEIds(const TLECatalog& catalog, double currentJD);

/// Merge new TLEs into existing catalog
/// @param catalog Existing catalog (modified in place)
/// @param newTLEs New TLEs to merge
/// @param replaceOlder If true, replace older TLEs with newer ones
/// @return Number of TLEs added/updated
int mergeTLEs(TLECatalog& catalog, const TLECollection& newTLEs, bool replaceOlder = true);

/// Validate TLE data (checksum, element ranges)
/// @param tle TLE to validate
/// @param config Update config with validation settings
/// @return true if TLE is valid
bool validateTLE(const TLE& tle, const TLEUpdateConfig& config);

/// Calculate TLE checksum for a line
/// @param line TLE line (69 characters)
/// @return Checksum digit (0-9)
int calculateTLEChecksum(const std::string& line);

/// Parse TLE from two-line or three-line format
/// @param lines Vector of lines (2 or 3 elements)
/// @return Parsed TLE
TLE parseTLE(const std::vector<std::string>& lines);

/// Format TLE to standard 3LE format
/// @param tle TLE to format
/// @return Vector of 3 lines (name, line1, line2)
std::vector<std::string> formatTLE(const TLE& tle);

// -----------------------------------------------------------------------------
// TLE Utility Functions
// -----------------------------------------------------------------------------

/// Get epoch as Julian Date from TLE
/// @param tle TLE structure
/// @return Julian Date of epoch
double getTLEEpochJD(const TLE& tle);

/// Convert TLE to Keplerian elements
/// @param tle TLE structure
/// @return Keplerian elements (angles in radians)
KeplerianElements tleToKeplerian(const TLE& tle);

/// Convert TLE to state vector using SGP4-compatible conversion
/// @param tle TLE structure
/// @return State vector at TLE epoch
StateVector tleToState(const TLE& tle);

/// Compute TLE age in days
/// @param tle TLE structure
/// @param currentJD Current Julian Date
/// @return Age in days (positive = old, negative = future)
double getTLEAge(const TLE& tle, double currentJD);

// -----------------------------------------------------------------------------
// Data Source Status and Health
// -----------------------------------------------------------------------------

/// Check availability of all data sources
/// @param timeout Timeout in milliseconds
/// @return Data source status
DataSourceStatus checkDataSources(int timeout = 5000);

/// Ping Space-Track.org API
/// @param timeout Timeout in milliseconds
/// @return true if available
bool pingSpaceTrack(int timeout = 5000);

/// Ping CelesTrak
/// @param timeout Timeout in milliseconds
/// @return true if available
bool pingCelesTrak(int timeout = 5000);

/// Ping JPL Horizons
/// @param timeout Timeout in milliseconds
/// @return true if available
bool pingHorizons(int timeout = 5000);

/// Ping IERS data services
/// @param timeout Timeout in milliseconds
/// @return true if available
bool pingIERS(int timeout = 5000);

// -----------------------------------------------------------------------------
// WASM HTTP Fetch Interface
// -----------------------------------------------------------------------------

#ifdef __EMSCRIPTEN__
/// Execute HTTP request (WASM browser fetch API)
/// @param request HTTP request
/// @param callback Callback for response (async)
void fetchAsync(const HttpRequest& request, HttpCallback callback);

/// Execute HTTP request synchronously (blocking, if supported)
/// @param request HTTP request
/// @return HTTP response
HttpResponse fetchSync(const HttpRequest& request);
#else
/// Execute HTTP request (native implementation placeholder)
/// @param request HTTP request
/// @return HTTP response
HttpResponse executeHttpRequest(const HttpRequest& request);
#endif

// =============================================================================
// Phase 11.2: Attitude Guidance & Control (Basilisk Port)
// =============================================================================

// -----------------------------------------------------------------------------
// 11.2.1 Attitude Representation Conversions
// -----------------------------------------------------------------------------

/// Convert quaternion to Modified Rodrigues Parameters
/// @param q Quaternion (unit quaternion expected)
/// @return MRP representation
MRP quaternionToMRP(const Quaternion& q);

/// Convert Modified Rodrigues Parameters to quaternion
/// @param sigma MRP
/// @return Unit quaternion
Quaternion mrpToQuaternion(const MRP& sigma);

/// Convert quaternion to Euler angles (3-2-1 / ZYX sequence)
/// @param q Quaternion
/// @return Euler angles (yaw, pitch, roll)
EulerAngles quaternionToEuler321(const Quaternion& q);

/// Convert Euler angles (3-2-1) to quaternion
/// @param euler Euler angles (must be ZYX_321 sequence)
/// @return Quaternion
Quaternion euler321ToQuaternion(const EulerAngles& euler);

/// Convert quaternion to Direction Cosine Matrix
/// @param q Quaternion
/// @return DCM (transforms from inertial to body frame)
DCM quaternionToDCM(const Quaternion& q);

/// Convert DCM to quaternion (Shepperd's method)
/// @param dcm Direction Cosine Matrix
/// @return Quaternion
Quaternion dcmToQuaternion(const DCM& dcm);

/// Convert MRP to DCM
/// @param sigma MRP
/// @return DCM
DCM mrpToDCM(const MRP& sigma);

/// Convert DCM to MRP
/// @param dcm Direction Cosine Matrix
/// @return MRP
MRP dcmToMRP(const DCM& dcm);

/// Convert MRP to Euler angles (via quaternion)
/// @param sigma MRP
/// @param sequence Euler sequence (default ZYX_321)
/// @return Euler angles
EulerAngles mrpToEuler(const MRP& sigma, EulerSequence sequence = EulerSequence::ZYX_321);

/// Convert Euler angles to MRP
/// @param euler Euler angles
/// @return MRP
MRP eulerToMRP(const EulerAngles& euler);

// -----------------------------------------------------------------------------
// 11.2.2 MRP Kinematics
// -----------------------------------------------------------------------------

/// Compute MRP time derivative from angular velocity
/// @param sigma Current MRP attitude
/// @param omega Angular velocity (rad/s, body frame)
/// @return MRP time derivative (sigma_dot)
MRP mrpKinematics(const MRP& sigma, const Vec3& omega);

/// Compute quaternion time derivative from angular velocity
/// @param q Current quaternion
/// @param omega Angular velocity (rad/s, body frame)
/// @return Quaternion time derivative
Quaternion quaternionKinematics(const Quaternion& q, const Vec3& omega);

/// Compute MRP rate matrix [B(sigma)] such that sigma_dot = 0.25 * [B] * omega
/// @param sigma MRP
/// @return 3x3 B matrix
Mat3 mrpRateMatrix(const MRP& sigma);

/// Integrate attitude using MRP kinematics
/// @param sigma Current MRP
/// @param omega Angular velocity (rad/s)
/// @param dt Time step (seconds)
/// @return Updated MRP (with shadow set switching if needed)
MRP integrateMRPAttitude(const MRP& sigma, const Vec3& omega, double dt);

/// Integrate attitude using quaternion kinematics
/// @param q Current quaternion
/// @param omega Angular velocity (rad/s)
/// @param dt Time step (seconds)
/// @return Updated quaternion (normalized)
Quaternion integrateQuaternionAttitude(const Quaternion& q, const Vec3& omega, double dt);

// -----------------------------------------------------------------------------
// 11.2.3 Attitude Guidance Modes
// -----------------------------------------------------------------------------

/// Compute inertial (fixed) pointing attitude
/// @param config Inertial pointing configuration
/// @return Attitude command
AttitudeCommand computeInertialPointing(const InertialPointingConfig& config);

/// Compute nadir (Hill frame / LVLH) pointing attitude
/// @param state Spacecraft orbital state (ECI)
/// @param config Hill pointing configuration
/// @return Attitude command with Hill frame orientation
AttitudeCommand computeNadirPointing(const StateVector& state,
                                      const HillPointConfig& config = HillPointConfig());

/// Compute sun-pointing attitude
/// @param spacecraftPos Spacecraft position (km, ECI)
/// @param sunPos Sun position (km, ECI)
/// @param config Sun pointing configuration
/// @return Attitude command
AttitudeCommand computeSunPointing(const Vec3& spacecraftPos,
                                    const Vec3& sunPos,
                                    const SunPointConfig& config = SunPointConfig());

/// Compute velocity-aligned attitude
/// @param state Spacecraft orbital state (ECI)
/// @param config Velocity pointing configuration
/// @return Attitude command
AttitudeCommand computeVelocityPointing(const StateVector& state,
                                         const VelocityPointConfig& config = VelocityPointConfig());

/// Compute ground target pointing attitude
/// @param spacecraftState Spacecraft state (ECI)
/// @param config Target pointing configuration
/// @param jd Julian date (for Earth rotation)
/// @return Attitude command
AttitudeCommand computeTargetPointing(const StateVector& spacecraftState,
                                       const TargetPointConfig& config,
                                       double jd);

/// Compute sun-safe pointing attitude (safe mode)
/// @param sunDirection Sun direction in body frame (from CSS)
/// @param currentAttitude Current attitude state
/// @param config Sun safe configuration
/// @return Attitude command for sun-safe orientation
AttitudeCommand computeSunSafePointing(const Vec3& sunDirection,
                                        const AttitudeState& currentAttitude,
                                        const SunPointConfig& config);

/// Compute attitude tracking error between current and reference
/// @param current Current attitude state
/// @param reference Reference attitude command
/// @return Tracking error (sigma_BR, omega_BR)
AttitudeTrackingError computeTrackingError(const AttitudeState& current,
                                            const AttitudeCommand& reference);

// -----------------------------------------------------------------------------
// 11.2.4 Attitude Control Laws
// -----------------------------------------------------------------------------

/// MRP Feedback control law (Basilisk default)
/// Computes control torque: u = -K*sigma - P*omega + omega x [I]*omega
/// @param error Attitude tracking error
/// @param gains Controller gains
/// @param inertia Spacecraft inertia
/// @param omega_BN Body angular velocity relative to inertial (rad/s)
/// @return Control torque command
ControlTorque mrpFeedback(const AttitudeTrackingError& error,
                          const MrpFeedbackGains& gains,
                          const SpacecraftInertia& inertia,
                          const Vec3& omega_BN);

/// MRP PD control law
/// Computes control torque: u = -Kp*sigma - Kd*omega_error
/// @param error Attitude tracking error
/// @param gains PD gains
/// @return Control torque command
ControlTorque mrpPD(const AttitudeTrackingError& error,
                    const MrpPDGains& gains);

/// MRP Steering law (rate-limited slew)
/// Computes desired angular rate that converges MRP to zero with rate limiting
/// @param sigma_BR MRP error (reference to body)
/// @param omega_BR_B Current angular velocity error (rad/s)
/// @param config Steering configuration
/// @return Commanded angular velocity (rad/s, body frame)
Vec3 mrpSteering(const MRP& sigma_BR,
                 const Vec3& omega_BR_B,
                 const MrpSteeringConfig& config);

/// Full MRP steering control with servo loop
/// @param error Attitude tracking error
/// @param config Steering configuration
/// @param gains Feedback gains (for servo)
/// @param inertia Spacecraft inertia
/// @return Control torque command
ControlTorque mrpSteeringControl(const AttitudeTrackingError& error,
                                  const MrpSteeringConfig& steeringConfig,
                                  const MrpFeedbackGains& gains,
                                  const SpacecraftInertia& inertia);

/// Nonlinear MRP control with feedforward
/// @param error Attitude tracking error
/// @param reference Reference command (for feedforward)
/// @param gains Controller gains
/// @param inertia Spacecraft inertia
/// @return Control torque command
ControlTorque mrpNonlinearControl(const AttitudeTrackingError& error,
                                   const AttitudeCommand& reference,
                                   const MrpFeedbackGains& gains,
                                   const SpacecraftInertia& inertia);

/// Rate servo control law
/// Controls angular velocity to track reference rate
/// @param omega_BN Current body angular velocity (rad/s)
/// @param omega_ref Reference angular velocity (rad/s)
/// @param gains Feedback gains
/// @param inertia Spacecraft inertia
/// @return Control torque command
ControlTorque rateServoControl(const Vec3& omega_BN,
                                const Vec3& omega_ref,
                                const MrpFeedbackGains& gains,
                                const SpacecraftInertia& inertia);

// -----------------------------------------------------------------------------
// 11.2.5 Momentum Management
// -----------------------------------------------------------------------------

/// Compute momentum dumping torque command
/// @param wheelArray Current wheel states
/// @param targetMomentum Target total wheel momentum (default 0)
/// @param dumpRate Momentum dump rate (Nm, positive)
/// @return External torque needed for dumping
ControlTorque computeMomentumDumpingTorque(const ReactionWheelArray& wheelArray,
                                            const Vec3& targetMomentum = Vec3(),
                                            double dumpRate = 0.01);

/// Distribute control torque to reaction wheels
/// @param torque Commanded control torque
/// @param wheelArray Wheel configuration
/// @return Individual wheel torque commands (up to 4)
std::array<double, 4> distributeWheelTorque(const ControlTorque& torque,
                                             const ReactionWheelArray& wheelArray);

/// Update reaction wheel states after torque application
/// @param wheelArray Wheel array to update (modified in place)
/// @param torques Applied torques per wheel
/// @param dt Time step (seconds)
void updateWheelStates(ReactionWheelArray& wheelArray,
                       const std::array<double, 4>& torques,
                       double dt);

/// Compute wheel saturation status
/// @param wheelArray Current wheel states
/// @return Saturation fraction (0 = empty, 1 = fully saturated)
double computeWheelSaturation(const ReactionWheelArray& wheelArray);

// -----------------------------------------------------------------------------
// 11.2.6 Reference Frame Transformations
// -----------------------------------------------------------------------------

/// Compute LVLH (Hill) frame DCM from orbital state
/// @param state Orbital state (ECI)
/// @return DCM from inertial to LVLH (R-T-N frame)
DCM computeLVLH_DCM(const StateVector& state);

/// Compute RSW frame DCM (radial-along track-cross track)
/// @param state Orbital state (ECI)
/// @return DCM from inertial to RSW
DCM computeRSW_DCM(const StateVector& state);

/// Transform angular velocity from inertial to body frame
/// @param omega_N Angular velocity in inertial frame (rad/s)
/// @param attitude Attitude (quaternion)
/// @return Angular velocity in body frame (rad/s)
Vec3 omegaInertialToBody(const Vec3& omega_N, const Quaternion& attitude);

/// Compute orbital angular velocity (LVLH frame rotation rate)
/// @param state Orbital state
/// @return Orbital angular velocity (rad/s)
Vec3 computeOrbitalOmega(const StateVector& state);

// -----------------------------------------------------------------------------
// 11.2.7 Attitude Dynamics
// -----------------------------------------------------------------------------

/// Euler's equation: I * omega_dot = -omega x (I*omega) + L
/// @param omega Angular velocity (rad/s)
/// @param inertia Spacecraft inertia
/// @param torque Applied torque (Nm)
/// @return Angular acceleration (rad/s^2)
Vec3 eulerEquation(const Vec3& omega,
                   const SpacecraftInertia& inertia,
                   const Vec3& torque);

/// Compute gravity gradient torque
/// @param nadir Nadir direction in body frame (unit vector)
/// @param orbitalRate Orbital angular rate (rad/s)
/// @param inertia Spacecraft inertia
/// @return Gravity gradient torque (Nm)
Vec3 gravityGradientTorque(const Vec3& nadir,
                            double orbitalRate,
                            const SpacecraftInertia& inertia);

/// Propagate attitude dynamics (one time step)
/// @param state Current attitude dynamics state (modified in place)
/// @param inertia Spacecraft inertia
/// @param controlTorque Applied control torque
/// @param dt Time step (seconds)
void propagateAttitudeDynamics(AttitudeDynamicsState& state,
                                const SpacecraftInertia& inertia,
                                const ControlTorque& controlTorque,
                                double dt);

// -----------------------------------------------------------------------------
// 11.2.8 Utility Functions
// -----------------------------------------------------------------------------

/// Compute rotation angle between two quaternions
/// @param q1 First quaternion
/// @param q2 Second quaternion
/// @return Rotation angle (radians, 0 to pi)
double quaternionAngle(const Quaternion& q1, const Quaternion& q2);

/// Spherical linear interpolation (SLERP) between quaternions
/// @param q1 Start quaternion
/// @param q2 End quaternion
/// @param t Interpolation parameter (0 to 1)
/// @return Interpolated quaternion
Quaternion slerp(const Quaternion& q1, const Quaternion& q2, double t);

/// Check attitude pointing accuracy
/// @param bodyAxis Body frame axis (unit vector)
/// @param targetDir Target direction in body frame (unit vector)
/// @return Pointing error angle (radians)
double pointingError(const Vec3& bodyAxis, const Vec3& targetDir);

/// Create triad DCM from two vectors
/// @param primary Primary direction (will be exact)
/// @param secondary Secondary direction (orthogonalized)
/// @return DCM with primary along Z, secondary projected to XZ plane
DCM triadMethod(const Vec3& primary, const Vec3& secondary);

/// Skew-symmetric matrix from vector [omega x]
/// @param v Vector
/// @return Skew-symmetric matrix such that [v x] * u = v.cross(u)
Mat3 skewSymmetric(const Vec3& v);

// =============================================================================
// Phase 11.3: Navigation & State Estimation
// =============================================================================

// -----------------------------------------------------------------------------
// 11.3.1 Extended Kalman Filter (EKF)
// -----------------------------------------------------------------------------

/// Initialize EKF state from initial estimate
/// @param initialState Initial state vector estimate
/// @param initialCov Initial state covariance (diagonal values)
/// @param config EKF configuration
/// @return Initialized Kalman state
KalmanState initEKF(const StateVector& initialState,
                    const double* initialCov,
                    const EKFConfig& config);

/// EKF predict step: propagate state and covariance forward
/// @param state Current Kalman state (modified in place)
/// @param config EKF configuration
/// @param dt Time step (seconds)
/// @return true if prediction successful
bool predictEKF(KalmanState& state, const EKFConfig& config, double dt);

/// EKF update step: incorporate measurement
/// @param state Current Kalman state (modified in place)
/// @param measurement Filter measurement with observation and H matrix
/// @param config EKF configuration
/// @return Filter result with innovation, Kalman gain, and NIS
FilterResult updateEKF(KalmanState& state,
                       const FilterMeasurement& measurement,
                       const EKFConfig& config);

/// Compute numerical Jacobian for state transition (F matrix)
/// @param state Current state
/// @param config EKF configuration
/// @param dt Time step (seconds)
/// @param F Output 6x6 Jacobian matrix F[i][j]
void computeJacobian(const KalmanState& state,
                     const EKFConfig& config,
                     double dt,
                     double F[KalmanState::MAX_STATE_DIM][KalmanState::MAX_STATE_DIM]);

/// Compute measurement Jacobian (H matrix) for range measurement
/// @param state Predicted state
/// @param stationPos Station position (km)
/// @param H Output measurement Jacobian (1x6 for range)
void computeRangeJacobian(const KalmanState& state,
                          const Vec3& stationPos,
                          double H[1][KalmanState::MAX_STATE_DIM]);

// -----------------------------------------------------------------------------
// 11.3.1 Unscented Kalman Filter (UKF)
// -----------------------------------------------------------------------------

/// Initialize UKF state
/// @param initialState Initial state vector estimate
/// @param initialCov Initial state covariance (diagonal values)
/// @param config UKF configuration
/// @return Initialized Kalman state
KalmanState initUKF(const StateVector& initialState,
                    const double* initialCov,
                    const UKFConfig& config);

/// UKF predict step: propagate state through sigma points
/// @param state Current Kalman state (modified in place)
/// @param config UKF configuration
/// @param dt Time step (seconds)
/// @return true if prediction successful
bool predictUKF(KalmanState& state, const UKFConfig& config, double dt);

/// UKF update step: incorporate measurement
/// @param state Current Kalman state (modified in place)
/// @param measurement Filter measurement with observation
/// @param config UKF configuration
/// @return Filter result with innovation and NIS
FilterResult updateUKF(KalmanState& state,
                       const FilterMeasurement& measurement,
                       const UKFConfig& config);

/// Compute sigma points for UKF
/// @param state Current Kalman state
/// @param config UKF configuration
/// @param sigmaPoints Output sigma points container
void computeSigmaPoints(const KalmanState& state,
                        const UKFConfig& config,
                        UKFSigmaPoints& sigmaPoints);

/// Propagate sigma points through nonlinear dynamics
/// @param sigmaPoints Sigma points (modified in place)
/// @param config UKF configuration
/// @param dt Time step (seconds)
void propagateSigmaPoints(UKFSigmaPoints& sigmaPoints,
                          const UKFConfig& config,
                          double dt);

// -----------------------------------------------------------------------------
// 11.3.1 Square Root Filters (Numerically Stable)
// -----------------------------------------------------------------------------

/// Initialize Square Root EKF (Cholesky factored covariance)
/// @param initialState Initial state vector estimate
/// @param initialCov Initial state covariance (diagonal values)
/// @param config EKF configuration (with useSquareRoot = true)
/// @return Initialized Kalman state with S factor
KalmanState initSREKF(const StateVector& initialState,
                      const double* initialCov,
                      const EKFConfig& config);

/// Square Root EKF predict step
/// @param state Current Kalman state with S factor (modified in place)
/// @param config EKF configuration
/// @param dt Time step (seconds)
/// @return true if prediction successful
bool predictSREKF(KalmanState& state, const EKFConfig& config, double dt);

/// Square Root EKF update step (Potter's algorithm)
/// @param state Current Kalman state with S factor (modified in place)
/// @param measurement Filter measurement
/// @param config EKF configuration
/// @return Filter result
FilterResult updateSREKF(KalmanState& state,
                         const FilterMeasurement& measurement,
                         const EKFConfig& config);

/// Initialize Square Root UKF
/// @param initialState Initial state vector estimate
/// @param initialCov Initial state covariance (diagonal values)
/// @param config UKF configuration (with useSquareRoot = true)
/// @return Initialized Kalman state with S factor
KalmanState initSRUKF(const StateVector& initialState,
                      const double* initialCov,
                      const UKFConfig& config);

/// Square Root UKF predict step
/// @param state Current Kalman state with S factor (modified in place)
/// @param config UKF configuration
/// @param dt Time step (seconds)
/// @return true if prediction successful
bool predictSRUKF(KalmanState& state, const UKFConfig& config, double dt);

/// Square Root UKF update step
/// @param state Current Kalman state with S factor (modified in place)
/// @param measurement Filter measurement
/// @param config UKF configuration
/// @return Filter result
FilterResult updateSRUKF(KalmanState& state,
                         const FilterMeasurement& measurement,
                         const UKFConfig& config);

// -----------------------------------------------------------------------------
// 11.3.1 Square Root Information Filter (SRIF)
// -----------------------------------------------------------------------------

/// SRIF state structure (information form)
struct SRIFState {
    int stateDim{6};
    double Rinv[KalmanState::MAX_STATE_DIM][KalmanState::MAX_STATE_DIM] = {};  ///< Upper triangular sqrt info
    double z[KalmanState::MAX_STATE_DIM] = {};  ///< Information state (Rinv * x)
    double epoch{0};
    bool valid{false};
};

/// Initialize SRIF from state estimate
/// @param initialState Initial state vector estimate
/// @param initialCov Initial state covariance (diagonal values)
/// @param config SRIF configuration
/// @return Initialized SRIF state
SRIFState initSRIF(const StateVector& initialState,
                   const double* initialCov,
                   const SRIFConfig& config);

/// SRIF update with measurement (Householder triangularization)
/// @param state SRIF state (modified in place)
/// @param measurement Filter measurement
/// @param config SRIF configuration
/// @return Filter result
FilterResult updateSRIF(SRIFState& state,
                        const FilterMeasurement& measurement,
                        const SRIFConfig& config);

/// SRIF time update (process noise injection)
/// @param state SRIF state (modified in place)
/// @param config SRIF configuration
/// @param dt Time step (seconds)
/// @return true if update successful
bool timeUpdateSRIF(SRIFState& state,
                    const SRIFConfig& config,
                    double dt);

/// Convert SRIF state to KalmanState (covariance form)
/// @param srifState SRIF state
/// @return Kalman state with covariance matrix
KalmanState srifToKalman(const SRIFState& srifState);

/// Convert KalmanState to SRIF form
/// @param kalmanState Kalman state with covariance
/// @return SRIF state
SRIFState kalmanToSrif(const KalmanState& kalmanState);

// -----------------------------------------------------------------------------
// 11.3.1 Specialized Navigation Filters
// -----------------------------------------------------------------------------

/// Initialize Sun Line EKF for sun sensor navigation
/// @param initialSunDir Initial sun direction estimate (body frame)
/// @param sigmaAngle Initial uncertainty (radians)
/// @return Initialized sun line filter state
SunLineEKFState initSunLineEKF(const Vec3& initialSunDir, double sigmaAngle);

/// Update Sun Line EKF with CSS measurement
/// @param state Sun line filter state (modified in place)
/// @param measuredSunDir Measured sun direction (body frame, unit vector)
/// @param measSigma Measurement sigma (radians)
/// @return true if update successful
bool updateSunLineEKF(SunLineEKFState& state,
                      const Vec3& measuredSunDir,
                      double measSigma);

/// Initialize Heading UKF for attitude estimation
/// @param initialHeading Initial heading (rad)
/// @param initialPitch Initial pitch (rad)
/// @param initialRoll Initial roll (rad)
/// @param sigmaAttitude Initial uncertainty (radians)
/// @return Initialized heading filter state
HeadingUKFState initHeadingUKF(double initialHeading,
                               double initialPitch,
                               double initialRoll,
                               double sigmaAttitude);

/// Update Heading UKF with sensor measurements
/// @param state Heading filter state (modified in place)
/// @param measHeading Measured heading (rad)
/// @param measPitch Measured pitch (rad)
/// @param measRoll Measured roll (rad)
/// @param measSigma Measurement sigma (radians)
/// @return true if update successful
bool updateHeadingUKF(HeadingUKFState& state,
                      double measHeading,
                      double measPitch,
                      double measRoll,
                      double measSigma);

/// Initialize Inertial UKF for IMU-based attitude
/// @param initialQuat Initial quaternion (w, x, y, z)
/// @param sigmaAttitude Initial attitude uncertainty (rad)
/// @param sigmaGyroBias Initial gyro bias uncertainty (rad/s)
/// @return Initialized inertial filter state
InertialUKFState initInertialUKF(const double* initialQuat,
                                  double sigmaAttitude,
                                  double sigmaGyroBias);

/// Propagate Inertial UKF with gyro measurement
/// @param state Inertial filter state (modified in place)
/// @param gyroMeas Gyro measurement (rad/s, body frame)
/// @param dt Time step (seconds)
/// @return true if propagation successful
bool propagateInertialUKF(InertialUKFState& state,
                          const Vec3& gyroMeas,
                          double dt);

/// Update Inertial UKF with star tracker quaternion
/// @param state Inertial filter state (modified in place)
/// @param measQuat Measured quaternion (w, x, y, z)
/// @param measSigma Quaternion measurement sigma (radians equivalent)
/// @return true if update successful
bool updateInertialUKF(InertialUKFState& state,
                       const double* measQuat,
                       double measSigma);

// -----------------------------------------------------------------------------
// 11.3.2 Utility Functions
// -----------------------------------------------------------------------------

/// Cholesky decomposition (lower triangular L such that A = L*L^T)
/// @param A Input symmetric positive definite matrix
/// @param L Output lower triangular factor
/// @param n Matrix dimension
/// @return true if decomposition successful (A is positive definite)
bool choleskyDecomposition(const double A[][KalmanState::MAX_STATE_DIM],
                           double L[][KalmanState::MAX_STATE_DIM],
                           int n);

/// Cholesky update (rank-1 update of factor)
/// @param L Cholesky factor (modified in place)
/// @param v Update vector
/// @param sign +1 for update, -1 for downdate
/// @param n Dimension
/// @return true if successful
bool choleskyUpdate(double L[][KalmanState::MAX_STATE_DIM],
                    const double* v,
                    int sign,
                    int n);

/// Solve L*x = b for lower triangular L (forward substitution)
/// @param L Lower triangular matrix
/// @param b Right-hand side
/// @param x Output solution
/// @param n Dimension
void forwardSubstitution(const double L[][KalmanState::MAX_STATE_DIM],
                         const double* b,
                         double* x,
                         int n);

/// Solve L^T*x = b for lower triangular L (back substitution)
/// @param L Lower triangular matrix
/// @param b Right-hand side
/// @param x Output solution
/// @param n Dimension
void backSubstitution(const double L[][KalmanState::MAX_STATE_DIM],
                      const double* b,
                      double* x,
                      int n);

/// Force matrix symmetry (average of A and A^T)
/// @param A Matrix (modified in place)
/// @param n Dimension
void forceSymmetric(double A[][KalmanState::MAX_STATE_DIM], int n);

/// Compute matrix trace
/// @param A Matrix
/// @param n Dimension
/// @return trace(A)
double matrixTrace(const double A[][KalmanState::MAX_STATE_DIM], int n);

/// Compute chi-squared threshold for measurement gating
/// @param dof Degrees of freedom (measurement dimension)
/// @param probability Gate probability (e.g., 0.99)
/// @return Chi-squared threshold
double chi2Threshold(int dof, double probability);

/// Compute NIS (Normalized Innovation Squared) for filter consistency
/// @param innovation Innovation vector
/// @param S Innovation covariance matrix
/// @param dim Measurement dimension
/// @return NIS value
double computeNIS(const double* innovation,
                  const double S[][KalmanState::MAX_MEAS_DIM],
                  int dim);

// =============================================================================
// Phase 11.7: CR3BP & Cislunar Mechanics
// =============================================================================

// -----------------------------------------------------------------------------
// 11.7.1 Lagrange Point Computation
// -----------------------------------------------------------------------------

/// Compute all five Lagrange points for a CR3BP system
/// @param system CR3BP system parameters
/// @return Set of all 5 Lagrange points with positions and stability
LagrangePointSet computeLagrangePoints(const CR3BPSystem& system);

/// Compute a single Lagrange point
/// @param system CR3BP system parameters
/// @param pointId Which Lagrange point (L1-L5)
/// @return Lagrange point data
LagrangePoint computeLagrangePoint(const CR3BPSystem& system, LagrangePointID pointId);

/// Solve for collinear Lagrange point using Newton iteration
/// @param system CR3BP system
/// @param pointId L1, L2, or L3
/// @param tol Convergence tolerance
/// @param maxIter Maximum iterations
/// @return x-coordinate of Lagrange point (normalized)
double solveCollinearLagrangePoint(const CR3BPSystem& system,
                                    LagrangePointID pointId,
                                    double tol = 1e-12,
                                    int maxIter = 100);

// -----------------------------------------------------------------------------
// 11.7.2 Jacobi Constant and CR3BP Potential
// -----------------------------------------------------------------------------

/// Compute Jacobi constant (energy integral) for a CR3BP state
/// @param state CR3BP state in rotating frame
/// @param mu Mass ratio
/// @return Jacobi constant C
double computeJacobiConstant(const CR3BPState& state, double mu);

/// Compute pseudo-potential U (effective potential in rotating frame)
/// @param x X-coordinate (normalized)
/// @param y Y-coordinate (normalized)
/// @param z Z-coordinate (normalized)
/// @param mu Mass ratio
/// @return Pseudo-potential value
double computePseudoPotential(double x, double y, double z, double mu);

/// Compute gradient of pseudo-potential (for equations of motion)
/// @param x X-coordinate (normalized)
/// @param y Y-coordinate (normalized)
/// @param z Z-coordinate (normalized)
/// @param mu Mass ratio
/// @param Ux Output: dU/dx
/// @param Uy Output: dU/dy
/// @param Uz Output: dU/dz
void computePseudoPotentialGradient(double x, double y, double z, double mu,
                                     double& Ux, double& Uy, double& Uz);

/// Compute zero-velocity curve x-coordinate for given Jacobi constant and y
/// @param C Jacobi constant
/// @param y Y-coordinate (normalized)
/// @param mu Mass ratio
/// @param x1 Output: first intersection (smaller x)
/// @param x2 Output: second intersection (larger x)
/// @return Number of intersections found (0, 1, or 2)
int computeZeroVelocityCurve(double C, double y, double mu, double& x1, double& x2);

// -----------------------------------------------------------------------------
// 11.7.3 CR3BP Propagation
// -----------------------------------------------------------------------------

/// Propagate CR3BP state using RK4 integrator
/// @param initialState Initial CR3BP state
/// @param mu Mass ratio
/// @param duration Integration duration (normalized time)
/// @param dt Time step (normalized)
/// @return Propagation result with trajectory
CR3BPPropagationResult propagateCR3BP(const CR3BPState& initialState,
                                       double mu,
                                       double duration,
                                       double dt = 0.001);

/// CR3BP equations of motion derivative function
/// @param t Time (unused, autonomous system)
/// @param y State array [x, y, z, xdot, ydot, zdot]
/// @param dydt Output derivatives
/// @param params Pointer to mass ratio (double*)
void cr3bpDerivative(double t, const double* y, double* dydt, void* params);

/// Propagate CR3BP state and STM together
/// @param initialState Initial state
/// @param mu Mass ratio
/// @param duration Integration duration
/// @param dt Time step
/// @return STM result including final state and state transition matrix
CR3BPSTM propagateCR3BPWithSTM(const CR3BPState& initialState,
                                double mu,
                                double duration,
                                double dt = 0.001);

/// CR3BP + STM equations of motion (42-state system)
/// @param t Time
/// @param y State array [6 state + 36 STM elements]
/// @param dydt Output derivatives
/// @param params Pointer to mass ratio
void cr3bpSTMDerivative(double t, const double* y, double* dydt, void* params);

// -----------------------------------------------------------------------------
// 11.7.4 CR3BP State Transition Matrix
// -----------------------------------------------------------------------------

/// Compute CR3BP Jacobian matrix A = df/dx at a state
/// @param state CR3BP state
/// @param mu Mass ratio
/// @return 6x6 Jacobian matrix
Mat6 computeCR3BPJacobian(const CR3BPState& state, double mu);

/// Compute second partial derivatives of pseudo-potential (Uxx, Uxy, etc.)
/// @param x X-coordinate
/// @param y Y-coordinate
/// @param z Z-coordinate
/// @param mu Mass ratio
/// @param Uxx, Uxy, Uxz, Uyy, Uyz, Uzz Output: second partials
void computePseudoPotentialHessian(double x, double y, double z, double mu,
                                    double& Uxx, double& Uxy, double& Uxz,
                                    double& Uyy, double& Uyz, double& Uzz);

/// Extract monodromy matrix eigenvalues for stability analysis
/// @param monodromy 6x6 monodromy matrix
/// @param eigenReal Output: real parts of 6 eigenvalues
/// @param eigenImag Output: imaginary parts of 6 eigenvalues
void computeMonodromyEigenvalues(const Mat6& monodromy,
                                  double eigenReal[6],
                                  double eigenImag[6]);

/// Compute stability index from monodromy matrix
/// @param monodromy 6x6 monodromy matrix
/// @return Stability index (|lambda| for largest eigenvalue)
double computeStabilityIndex(const Mat6& monodromy);

/// Compute monodromy matrix for a periodic orbit
/// @param orbit Periodic orbit
/// @param mu Mass ratio
/// @return Monodromy matrix (STM after one period)
Mat6 computeMonodromyMatrix(const PeriodicOrbit& orbit, double mu);

// -----------------------------------------------------------------------------
// 11.7.5 Halo Orbit Computation
// -----------------------------------------------------------------------------

/// Compute halo orbit initial conditions using differential correction
/// @param system CR3BP system
/// @param params Halo orbit parameters (L-point, amplitude, orientation)
/// @return Periodic orbit with initial conditions and properties
PeriodicOrbit computeHaloOrbit(const CR3BPSystem& system,
                                const HaloOrbitParameters& params);

/// Richardson third-order halo orbit initial guess
/// @param system CR3BP system
/// @param librationPoint L1 or L2
/// @param Az Z-amplitude (normalized)
/// @param northern True for northern halo
/// @return Initial guess for differential correction
CR3BPState richardsonHaloGuess(const CR3BPSystem& system,
                                LagrangePointID librationPoint,
                                double Az,
                                bool northern);

/// Differential correction for periodic orbit
/// @param initialGuess Initial state guess
/// @param mu Mass ratio
/// @param halfPeriodGuess Initial half-period guess
/// @param tolerance Convergence tolerance
/// @param maxIterations Maximum iterations
/// @return Correction result with converged IC and period
DifferentialCorrectionResult differentialCorrection(
    const CR3BPState& initialGuess,
    double mu,
    double halfPeriodGuess,
    double tolerance = 1e-10,
    int maxIterations = 50);

// -----------------------------------------------------------------------------
// 11.7.6 Lyapunov Orbit Computation
// -----------------------------------------------------------------------------

/// Compute Lyapunov orbit initial conditions
/// @param system CR3BP system
/// @param params Lyapunov parameters (L-point, amplitude)
/// @return Periodic orbit with initial conditions
PeriodicOrbit computeLyapunovOrbit(const CR3BPSystem& system,
                                    const LyapunovOrbitParameters& params);

/// Linear approximation for Lyapunov orbit initial conditions
/// @param system CR3BP system
/// @param librationPoint L1, L2, or L3
/// @param Ax X-amplitude from L-point (normalized)
/// @return Initial guess for differential correction
CR3BPState linearLyapunovGuess(const CR3BPSystem& system,
                                LagrangePointID librationPoint,
                                double Ax);

// -----------------------------------------------------------------------------
// 11.7.7 Invariant Manifold Computation
// -----------------------------------------------------------------------------

/// Compute stable/unstable manifolds of a periodic orbit
/// @param orbit Source periodic orbit
/// @param system CR3BP system
/// @param params Manifold computation parameters
/// @return Manifold result with multiple arcs
ManifoldResult computeManifolds(const PeriodicOrbit& orbit,
                                 const CR3BPSystem& system,
                                 const ManifoldParameters& params);

/// Compute single manifold arc from a point on the periodic orbit
/// @param orbitState State on the periodic orbit
/// @param stm STM at that point
/// @param mu Mass ratio
/// @param type Stable/unstable, positive/negative
/// @param epsilon Perturbation magnitude
/// @param integrationTime Integration time (normalized)
/// @param numStates Number of states to record
/// @return Single manifold arc
ManifoldArc computeManifoldArc(const CR3BPState& orbitState,
                                const Mat6& stm,
                                double mu,
                                ManifoldType type,
                                double epsilon,
                                double integrationTime,
                                int numStates = 100);

/// Extract stable/unstable eigenvector from monodromy matrix
/// @param monodromy 6x6 monodromy matrix
/// @param stable True for stable (|lambda| < 1), false for unstable
/// @param eigenvector Output: 6-element eigenvector
/// @param eigenvalue Output: associated eigenvalue
void extractManifoldEigenvector(const Mat6& monodromy,
                                 bool stable,
                                 double eigenvector[6],
                                 double& eigenvalue);

// -----------------------------------------------------------------------------
// 11.7.8 Low-Energy Transfer Design
// -----------------------------------------------------------------------------

/// Design low-energy transfer using manifold connections
/// @param departureOrbit Departure periodic orbit
/// @param arrivalOrbit Arrival periodic orbit
/// @param system CR3BP system
/// @param maxDeltaV Maximum delta-V budget (normalized)
/// @return Low-energy transfer trajectory
LowEnergyTransfer designManifoldTransfer(const PeriodicOrbit& departureOrbit,
                                          const PeriodicOrbit& arrivalOrbit,
                                          const CR3BPSystem& system,
                                          double maxDeltaV = 0.1);

/// Design weak stability boundary transfer
/// @param params WSB transfer parameters
/// @param system CR3BP system
/// @return Low-energy transfer trajectory
LowEnergyTransfer designWSBTransfer(const WSBTransferParameters& params,
                                     const CR3BPSystem& system);

/// Compute ballistic capture region for given Jacobi constant
/// @param system CR3BP system
/// @param jacobi Target Jacobi constant
/// @param numPoints Number of boundary points to compute
/// @return Vector of boundary states defining capture region
std::vector<CR3BPState> computeBallisticCaptureRegion(const CR3BPSystem& system,
                                                       double jacobi,
                                                       int numPoints = 360);

// -----------------------------------------------------------------------------
// 11.7.9 CR3BP Utility Functions
// -----------------------------------------------------------------------------

/// Convert inertial state to CR3BP rotating frame
/// @param inertial Inertial state (km, km/s)
/// @param system CR3BP system
/// @param t Time since reference epoch (seconds)
/// @return CR3BP state in normalized rotating frame
CR3BPState inertialToRotating(const StateVector& inertial,
                               const CR3BPSystem& system,
                               double t);

/// Convert CR3BP rotating frame to inertial
/// @param rotating CR3BP state in rotating frame
/// @param system CR3BP system
/// @param t Time since reference epoch (seconds)
/// @return Inertial state (km, km/s)
StateVector rotatingToInertial(const CR3BPState& rotating,
                                const CR3BPSystem& system,
                                double t);

/// Check if point is inside Hill sphere of secondary body
/// @param state CR3BP state
/// @param mu Mass ratio
/// @return True if inside secondary's Hill sphere
bool insideSecondaryHillSphere(const CR3BPState& state, double mu);

/// Compute Hill sphere radius for secondary body
/// @param mu Mass ratio
/// @return Hill sphere radius (normalized)
double hillSphereRadius(double mu);

/// Compute distance from primary body
/// @param state CR3BP state
/// @param mu Mass ratio
/// @return Distance from primary (normalized)
double distanceFromPrimary(const CR3BPState& state, double mu);

/// Compute distance from secondary body
/// @param state CR3BP state
/// @param mu Mass ratio
/// @return Distance from secondary (normalized)
double distanceFromSecondary(const CR3BPState& state, double mu);

// =============================================================================
// Phase 11.6: Power & Thermal Systems (Basilisk Port)
// =============================================================================

// -----------------------------------------------------------------------------
// 11.6.1 Power System Components
// -----------------------------------------------------------------------------

/// Simulate solar panel power output
/// @param config Solar panel configuration
/// @param sunAngle Angle between panel normal and sun vector (rad)
/// @param solarFlux Solar flux at current distance (W/m^2)
/// @param inEclipse True if spacecraft is in eclipse
/// @return Solar panel output with power and efficiency
SolarPanelOutput simulateSolarPanel(
    const SolarPanelConfig& config,
    double sunAngle,
    double solarFlux,
    bool inEclipse);

/// Simulate simple solar panel (cosine law model)
/// P = eta * A * S * cos(theta) * (1 - degradation)
/// @param config Simple solar panel configuration
/// @param sunAngle Angle between panel normal and sun vector (rad)
/// @param solarFlux Solar flux (W/m^2)
/// @param inEclipse True if in eclipse
/// @return Solar panel output
SolarPanelOutput simulateSimpleSolarPanel(
    const SimpleSolarPanelConfig& config,
    double sunAngle,
    double solarFlux,
    bool inEclipse);

/// Simulate battery state over time step
/// @param config Battery configuration
/// @param currentSOC Current state of charge (0-1)
/// @param powerInOut Net power to battery (W, positive=charging)
/// @param dt Time step (seconds)
/// @return Updated battery state
BatteryState simulateBattery(
    const BatteryConfig& config,
    double currentSOC,
    double powerInOut,
    double dt);

/// Simulate simple battery (linear model)
/// dSOC/dt = (P_in - P_out) / capacity
/// @param config Simple battery configuration
/// @param currentSOC Current state of charge (0-1)
/// @param powerInOut Net power (W)
/// @param dt Time step (seconds)
/// @return Updated battery state
BatteryState simulateSimpleBattery(
    const SimpleBatteryConfig& config,
    double currentSOC,
    double powerInOut,
    double dt);

/// Simulate power sink (load)
/// @param config Power sink configuration
/// @return Power consumption (W)
double simulatePowerSink(const PowerSinkConfig& config);

/// Simulate simple power sink (constant power)
/// @param config Simple power sink configuration
/// @return Power consumption (W)
double simulateSimplePowerSink(const SimplePowerSinkConfig& config);

/// Simulate complete power budget
/// @param panels Vector of solar panel configurations
/// @param sinks Vector of power sink configurations
/// @param battery Battery configuration
/// @param batterySOC Current battery state of charge
/// @param sunAngle Sun angle to panels (rad)
/// @param solarFlux Solar flux (W/m^2)
/// @param inEclipse True if in eclipse
/// @param dt Time step (seconds)
/// @return Power budget result
PowerBudgetResult simulatePowerBudget(
    const std::vector<SolarPanelConfig>& panels,
    const std::vector<PowerSinkConfig>& sinks,
    const BatteryConfig& battery,
    double batterySOC,
    double sunAngle,
    double solarFlux,
    bool inEclipse,
    double dt);

/// Compute eclipse power requirements and survival analysis
/// @param sinks Power sink configurations
/// @param battery Battery configuration
/// @param currentSOC Current state of charge
/// @param eclipseDuration Eclipse duration (seconds)
/// @param sunlitDuration Sunlit duration after eclipse (seconds)
/// @return Eclipse power analysis result
EclipsePowerResult computeEclipsePower(
    const std::vector<PowerSinkConfig>& sinks,
    const BatteryConfig& battery,
    double currentSOC,
    double eclipseDuration,
    double sunlitDuration);

// -----------------------------------------------------------------------------
// 11.6.2 Thermal System Components
// -----------------------------------------------------------------------------

/// Simulate thermal node temperature evolution
/// m * Cp * dT/dt = Q_in - Q_out
/// @param config Thermal node configuration
/// @param currentTemp Current temperature (K)
/// @param heatIn Heat input (W)
/// @param heatOut Heat output (W)
/// @param dt Time step (seconds)
/// @return Updated thermal node state
ThermalNodeState simulateThermalNode(
    const ThermalNodeConfig& config,
    double currentTemp,
    double heatIn,
    double heatOut,
    double dt);

/// Simulate simple thermal node
/// @param node Simple thermal node
/// @param heatIn Heat input (W)
/// @param heatOut Heat output (W)
/// @param dt Time step (seconds)
/// @return Updated thermal node state
ThermalNodeState simulateSimpleThermalNode(
    const SimpleThermalNode& node,
    double heatIn,
    double heatOut,
    double dt);

/// Simulate radiator heat rejection
/// Q = epsilon * sigma * A * (T^4 - T_sink^4)
/// @param config Radiator configuration
/// @param nodeTemperature Temperature of attached node (K)
/// @return Radiator output with heat rejected
RadiatorOutput simulateRadiator(
    const RadiatorConfig& config,
    double nodeTemperature);

/// Compute radiator heat rejection (standalone function)
/// @param area Radiating area (m^2)
/// @param emissivity Emissivity (0-1)
/// @param temperature Surface temperature (K)
/// @param viewFactor View factor to space (0-1)
/// @param sinkTemperature Sink temperature (K), typically 4K for space
/// @return Heat rejected (W)
double computeRadiatorHeatRejection(
    double area,
    double emissivity,
    double temperature,
    double viewFactor = 1.0,
    double sinkTemperature = 4.0);

/// Simulate heater with thermostat control
/// @param config Heater configuration
/// @param currentTemp Current temperature (K)
/// @param dt Time step (seconds)
/// @return Heater power output (W)
double simulateHeater(
    const HeaterConfig& config,
    double currentTemp,
    double dt);

/// Compute heat loss through MLI (Multi-Layer Insulation)
/// @param config MLI configuration
/// @param innerTemp Inner temperature (K)
/// @param outerTemp Outer temperature (K)
/// @return Heat loss through MLI (W)
double computeMLIHeatLoss(
    const MLIConfig& config,
    double innerTemp,
    double outerTemp);

/// Compute solar heat absorption
/// @param config Solar absorption configuration
/// @return Solar heat input (W)
double computeSolarAbsorption(
    const SolarAbsorptionConfig& config);

/// Simulate complete thermal system
/// @param nodeConfig Thermal node configuration
/// @param radiatorConfig Radiator configuration
/// @param heaterConfig Heater configuration
/// @param currentTemp Current temperature (K)
/// @param internalDissipation Internal power dissipation (W)
/// @param solarFlux Solar flux (W/m^2)
/// @param sunAngle Sun angle (rad)
/// @param inEclipse True if in eclipse
/// @param dt Time step (seconds)
/// @return Thermal state result
ThermalState simulateThermalSystem(
    const ThermalNodeConfig& nodeConfig,
    const RadiatorConfig& radiatorConfig,
    const HeaterConfig& heaterConfig,
    double currentTemp,
    double internalDissipation,
    double solarFlux,
    double sunAngle,
    bool inEclipse,
    double dt);

/// Compute thermal budget for multi-node system
/// @param nodes Thermal node configurations
/// @param nodeTemperatures Current temperatures (K)
/// @param radiators Radiator configurations
/// @param heaters Heater configurations
/// @param internalDissipation Total internal dissipation (W)
/// @param solarFlux Solar flux (W/m^2)
/// @param sunAngle Sun angle (rad)
/// @param inEclipse True if in eclipse
/// @return Thermal budget result
ThermalBudgetResult computeThermalBudget(
    const std::vector<ThermalNodeConfig>& nodes,
    const std::vector<double>& nodeTemperatures,
    const std::vector<RadiatorConfig>& radiators,
    const std::vector<HeaterConfig>& heaters,
    double internalDissipation,
    double solarFlux,
    double sunAngle,
    bool inEclipse);

/// Simulate combined power-thermal system step
/// @param panels Solar panel configurations
/// @param powerSinks Power sink configurations
/// @param battery Battery configuration
/// @param thermalNode Thermal node configuration
/// @param radiator Radiator configuration
/// @param heater Heater configuration
/// @param currentState Current power-thermal state
/// @param sunAngle Sun angle (rad)
/// @param solarFlux Solar flux (W/m^2)
/// @param inEclipse True if in eclipse
/// @param dt Time step (seconds)
/// @return Updated power-thermal state
PowerThermalState simulatePowerThermalStep(
    const std::vector<SolarPanelConfig>& panels,
    const std::vector<PowerSinkConfig>& powerSinks,
    const BatteryConfig& battery,
    const ThermalNodeConfig& thermalNode,
    const RadiatorConfig& radiator,
    const HeaterConfig& heater,
    PowerThermalState& currentState,
    double sunAngle,
    double solarFlux,
    bool inEclipse,
    double dt);

// =============================================================================
// Phase 11.7.3: Entry, Descent & Landing (EDL)
// =============================================================================

// -----------------------------------------------------------------------------
// EDL Utility Functions
// -----------------------------------------------------------------------------

/// Compute atmospheric density using exponential model
/// @param altitude Altitude above reference (km)
/// @param body Planetary body parameters
/// @return Atmospheric density (kg/m^3)
double edlAtmosphericDensity(double altitude, const PlanetaryBody& body);

/// Compute speed of sound
/// @param altitude Altitude (km)
/// @param body Planetary body parameters
/// @return Speed of sound (km/s)
double edlSpeedOfSound(double altitude, const PlanetaryBody& body);

/// Compute convective heat rate using Sutton-Graves correlation
/// @param velocity Velocity magnitude (km/s)
/// @param density Atmospheric density (kg/m^3)
/// @param noseRadius Nose radius (m)
/// @param k Sutton-Graves constant (planet dependent)
/// @return Convective heat rate (W/cm^2)
double edlConvectiveHeatRate(double velocity, double density, double noseRadius, double k = 1.7415e-4);

/// Initialize EDL state from entry conditions
/// @param body Target planetary body
/// @param vehicle Vehicle configuration
/// @param entryAltitude Entry interface altitude (km)
/// @param entryVelocity Entry velocity (km/s)
/// @param entryFPA Entry flight path angle (deg, negative = descending)
/// @param entryHeading Entry heading angle (rad)
/// @return Initialized EDL state
EDLState edlInitState(
    const PlanetaryBody& body,
    const EDLVehicleConfig& vehicle,
    double entryAltitude,
    double entryVelocity,
    double entryFPA,
    double entryHeading = 0);

/// Update EDL state quantities from position/velocity
/// @param state EDL state to update
/// @param body Planetary body
/// @param vehicle Vehicle configuration
void edlUpdateDerivedQuantities(EDLState& state, const PlanetaryBody& body, const EDLVehicleConfig& vehicle);

// -----------------------------------------------------------------------------
// EDL::AeroBraking() - Aerobraking Corridor
// -----------------------------------------------------------------------------

/// Simulate multi-pass aerobraking campaign
/// @param initialOrbit Initial capture orbit
/// @param body Target planetary body
/// @param vehicle Vehicle configuration
/// @param config Aerobraking configuration
/// @return Aerobraking campaign result
AerobrakingResult simulateAerobraking(
    const KeplerianElements& initialOrbit,
    const PlanetaryBody& body,
    const EDLVehicleConfig& vehicle,
    const AerobrakingConfig& config);

/// Simulate single aerobraking pass
/// @param orbit Current orbit
/// @param passNumber Pass number
/// @param body Planetary body
/// @param vehicle Vehicle configuration
/// @param corridorAltitude Target periapsis altitude (km)
/// @return Single pass result
AerobrakingPass simulateAerobrakingPass(
    const KeplerianElements& orbit,
    int passNumber,
    const PlanetaryBody& body,
    const EDLVehicleConfig& vehicle,
    double corridorAltitude);

/// Compute aerobraking corridor bounds
/// @param body Planetary body
/// @param vehicle Vehicle configuration
/// @param config Aerobraking configuration
/// @return Corridor altitude range [min, max] (km)
std::pair<double, double> computeAerobrakingCorridor(
    const PlanetaryBody& body,
    const EDLVehicleConfig& vehicle,
    const AerobrakingConfig& config);

// -----------------------------------------------------------------------------
// EDL::Aerocapture() - Single-Pass Capture
// -----------------------------------------------------------------------------

/// Simulate aerocapture maneuver
/// @param entryState Entry state
/// @param body Target planetary body
/// @param vehicle Vehicle configuration
/// @param config Aerocapture configuration
/// @return Aerocapture result
AerocaptureResult simulateAerocapture(
    const StateVector& entryState,
    const PlanetaryBody& body,
    const EDLVehicleConfig& vehicle,
    const AerocaptureConfig& config);

/// Compute aerocapture corridor
/// @param body Planetary body
/// @param vehicle Vehicle configuration
/// @param entryVelocity Entry velocity (km/s)
/// @param targetOrbit Target orbit parameters
/// @return EDL corridor result
EDLCorridorResult computeAerocaptureCorridor(
    const PlanetaryBody& body,
    const EDLVehicleConfig& vehicle,
    double entryVelocity,
    const KeplerianElements& targetOrbit);

/// Compute bank angle command for aerocapture guidance
/// @param currentState Current EDL state
/// @param predictedExitState Predicted atmospheric exit state
/// @param targetApoapsis Target apoapsis altitude (km)
/// @param body Planetary body
/// @param liftToDrag Vehicle L/D
/// @return Commanded bank angle (rad)
double computeAerocaptureBankAngle(
    const EDLState& currentState,
    const EDLState& predictedExitState,
    double targetApoapsis,
    const PlanetaryBody& body,
    double liftToDrag);

// -----------------------------------------------------------------------------
// EDL::AtmosphericEntry() - Reentry Trajectory
// -----------------------------------------------------------------------------

/// Simulate atmospheric entry trajectory
/// @param body Target planetary body
/// @param vehicle Vehicle configuration
/// @param heatShield Heat shield configuration
/// @param config Entry configuration
/// @return Entry result with trajectory
AtmosphericEntryResult simulateAtmosphericEntry(
    const PlanetaryBody& body,
    const EDLVehicleConfig& vehicle,
    const HeatShieldConfig& heatShield,
    const AtmosphericEntryConfig& config);

/// Propagate entry state by one time step
/// @param state Current EDL state (modified in place)
/// @param body Planetary body
/// @param vehicle Vehicle configuration
/// @param bankAngle Bank angle (rad)
/// @param dt Time step (seconds)
void edlPropagateStep(
    EDLState& state,
    const PlanetaryBody& body,
    const EDLVehicleConfig& vehicle,
    double bankAngle,
    double dt);

/// Compute ballistic entry trajectory (zero lift)
/// @param body Planetary body
/// @param vehicle Vehicle configuration
/// @param config Entry configuration
/// @return Entry result
AtmosphericEntryResult simulateBallisticEntry(
    const PlanetaryBody& body,
    const EDLVehicleConfig& vehicle,
    const AtmosphericEntryConfig& config);

// -----------------------------------------------------------------------------
// EDL::ParachuteDescent() - Chute Deploy Dynamics
// -----------------------------------------------------------------------------

/// Simulate parachute descent phase
/// @param initialState State at parachute deployment
/// @param body Planetary body
/// @param vehicle Vehicle configuration
/// @param config Parachute descent configuration
/// @return Parachute descent result
ParachuteDescentResult simulateParachuteDescent(
    const EDLState& initialState,
    const PlanetaryBody& body,
    const EDLVehicleConfig& vehicle,
    const ParachuteDescentConfig& config);

/// Compute parachute opening shock load
/// @param deployMach Deployment Mach number
/// @param dynamicPressure Dynamic pressure at deployment (Pa)
/// @param parachute Parachute configuration
/// @param mass Vehicle mass (kg)
/// @return Opening shock (g-load)
double computeParachuteOpeningShock(
    double deployMach,
    double dynamicPressure,
    const ParachuteConfig& parachute,
    double mass);

/// Compute terminal descent velocity under parachute
/// @param mass Vehicle mass (kg)
/// @param parachute Parachute configuration
/// @param density Atmospheric density (kg/m^3)
/// @param body Planetary body
/// @return Terminal velocity (km/s)
double computeParachuteTerminalVelocity(
    double mass,
    const ParachuteConfig& parachute,
    double density,
    const PlanetaryBody& body);

/// Check if parachute deployment conditions are met
/// @param state Current EDL state
/// @param config Parachute configuration
/// @return True if deployment is safe
bool checkParachuteDeploymentConditions(
    const EDLState& state,
    const ParachuteConfig& config);

// -----------------------------------------------------------------------------
// EDL::PoweredDescent() - Terminal Guidance
// -----------------------------------------------------------------------------

/// Simulate powered descent phase
/// @param initialState State at powered descent initiation
/// @param body Planetary body
/// @param vehicle Vehicle configuration
/// @param propulsion Propulsion configuration
/// @param config Powered descent configuration
/// @return Powered descent result
PoweredDescentResult simulatePoweredDescent(
    const EDLState& initialState,
    const PlanetaryBody& body,
    const EDLVehicleConfig& vehicle,
    const PoweredDescentPropulsion& propulsion,
    const PoweredDescentConfig& config);

/// Compute gravity turn guidance command
/// @param state Current EDL state
/// @param body Planetary body
/// @param propulsion Propulsion configuration
/// @param targetAltitude Target altitude (km)
/// @param targetVelocity Target velocity (km/s)
/// @return Thrust vector in body frame (normalized)
Vec3 computeGravityTurnGuidance(
    const EDLState& state,
    const PlanetaryBody& body,
    const PoweredDescentPropulsion& propulsion,
    double targetAltitude,
    double targetVelocity);

/// Compute polynomial guidance trajectory
/// @param currentState Current state
/// @param targetState Target state at touchdown
/// @param tgo Time to go (seconds)
/// @return Commanded acceleration (km/s^2)
Vec3 computePolynomialGuidance(
    const EDLState& currentState,
    const EDLState& targetState,
    double tgo);

/// Compute required delta-V for powered descent
/// @param initialAltitude Starting altitude (km)
/// @param initialVelocity Starting velocity (km/s)
/// @param targetVelocity Target touchdown velocity (km/s)
/// @param body Planetary body
/// @return Required delta-V (km/s)
double computePoweredDescentDeltaV(
    double initialAltitude,
    double initialVelocity,
    double targetVelocity,
    const PlanetaryBody& body);

// -----------------------------------------------------------------------------
// EDL::SkipEntry() - Skip Reentry Glide
// -----------------------------------------------------------------------------

/// Simulate skip entry trajectory
/// @param body Planetary body
/// @param vehicle Vehicle configuration
/// @param config Skip entry configuration
/// @param entryState Entry state
/// @return Skip entry result
SkipEntryResult simulateSkipEntry(
    const PlanetaryBody& body,
    const EDLVehicleConfig& vehicle,
    const SkipEntryConfig& config,
    const EDLState& entryState);

/// Compute equilibrium glide trajectory
/// @param body Planetary body
/// @param vehicle Vehicle configuration
/// @param entryState Initial state
/// @param targetDownrange Target downrange distance (km)
/// @return Trajectory to equilibrium glide endpoint
EDLTrajectory computeEquilibriumGlide(
    const PlanetaryBody& body,
    const EDLVehicleConfig& vehicle,
    const EDLState& entryState,
    double targetDownrange);

/// Compute skip-out altitude for given conditions
/// @param velocity Current velocity (km/s)
/// @param flightPathAngle Current FPA (rad)
/// @param liftToDrag Vehicle L/D
/// @param bankAngle Bank angle (rad)
/// @param body Planetary body
/// @return Skip-out (maximum) altitude (km)
double computeSkipOutAltitude(
    double velocity,
    double flightPathAngle,
    double liftToDrag,
    double bankAngle,
    const PlanetaryBody& body);

// -----------------------------------------------------------------------------
// EDL::HeatShield() - TPS Heating Model
// -----------------------------------------------------------------------------

/// Simulate heat shield response during entry
/// @param trajectory Entry trajectory
/// @param heatShield Heat shield configuration
/// @param dt Analysis time step (seconds)
/// @return Heat shield analysis result
HeatShieldResult simulateHeatShield(
    const EDLTrajectory& trajectory,
    const HeatShieldConfig& heatShield,
    double dt = 0.1);

/// Update heat shield state for one time step
/// @param state Current heat shield state (modified)
/// @param heatRate Current heat rate (W/cm^2)
/// @param config Heat shield configuration
/// @param dt Time step (seconds)
void updateHeatShieldState(
    HeatShieldState& state,
    double heatRate,
    const HeatShieldConfig& config,
    double dt);

/// Compute radiative equilibrium temperature
/// @param heatRate Convective heat rate (W/cm^2)
/// @param emissivity Surface emissivity
/// @return Equilibrium temperature (K)
double computeRadiativeEquilibriumTemp(double heatRate, double emissivity);

/// Compute ablation rate
/// @param surfaceTemp Surface temperature (K)
/// @param heatRate Heat rate (W/cm^2)
/// @param config Heat shield configuration
/// @return Ablation rate (kg/m^2/s)
double computeAblationRate(
    double surfaceTemp,
    double heatRate,
    const HeatShieldConfig& config);

/// Compute heat shield sizing for given entry conditions
/// @param peakHeatRate Expected peak heat rate (W/cm^2)
/// @param totalHeatLoad Expected total heat load (J/cm^2)
/// @param material Heat shield material
/// @param safetyFactor Safety factor (default 1.5)
/// @return Required heat shield configuration
HeatShieldConfig sizeHeatShield(
    double peakHeatRate,
    double totalHeatLoad,
    HeatShieldMaterial material,
    double safetyFactor = 1.5);

// -----------------------------------------------------------------------------
// EDL Corridor Analysis
// -----------------------------------------------------------------------------

/// Analyze entry corridor for given mission
/// @param body Planetary body
/// @param vehicle Vehicle configuration
/// @param entryVelocity Entry velocity (km/s)
/// @param maxGLoad Maximum allowable g-load
/// @param maxHeatRate Maximum allowable heat rate (W/cm^2)
/// @return Corridor analysis result
EDLCorridorResult analyzeEDLCorridor(
    const PlanetaryBody& body,
    const EDLVehicleConfig& vehicle,
    double entryVelocity,
    double maxGLoad,
    double maxHeatRate);

/// Compute steep limit of entry corridor
/// @param body Planetary body
/// @param vehicle Vehicle configuration
/// @param entryVelocity Entry velocity (km/s)
/// @param maxGLoad Maximum g-load constraint
/// @return Steep limit FPA (deg)
double computeCorridorSteepLimit(
    const PlanetaryBody& body,
    const EDLVehicleConfig& vehicle,
    double entryVelocity,
    double maxGLoad);

/// Compute shallow limit of entry corridor
/// @param body Planetary body
/// @param vehicle Vehicle configuration
/// @param entryVelocity Entry velocity (km/s)
/// @param skipAltitude Maximum skip altitude (km)
/// @return Shallow limit FPA (deg)
double computeCorridorShallowLimit(
    const PlanetaryBody& body,
    const EDLVehicleConfig& vehicle,
    double entryVelocity,
    double skipAltitude);

}  // namespace astro
