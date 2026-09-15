// astrodynamics_types.h - Type definitions for astrodynamics plugin
// =============================================================================
// Phase 8: Space Domain Enhancement
// Numerical integration, orbit mechanics, conjunction assessment, maneuver planning
// =============================================================================

#pragma once

#include <cstdint>
#include <cmath>
#include <array>
#include <functional>
#include <string>
#include <vector>

namespace astro {

// =============================================================================
// Constants
// =============================================================================

constexpr double PI = 3.14159265358979323846;
constexpr double TWO_PI = 2.0 * PI;
constexpr double DEG_TO_RAD = PI / 180.0;
constexpr double RAD_TO_DEG = 180.0 / PI;

// Earth constants (WGS84)
constexpr double MU_EARTH = 398600.4418;        // km^3/s^2
constexpr double RE_EARTH = 6378.137;           // km (equatorial)
constexpr double J2_EARTH = 1.08262668e-3;      // J2 coefficient
constexpr double J3_EARTH = -2.53265648e-6;     // J3 coefficient
constexpr double J4_EARTH = -1.61962159e-6;     // J4 coefficient
constexpr double OMEGA_EARTH = 7.2921150e-5;    // rad/s (Earth rotation)

// Other bodies
constexpr double MU_SUN = 1.32712440018e11;     // km^3/s^2
constexpr double MU_MOON = 4902.800066;         // km^3/s^2
constexpr double MU_MERCURY = 22031.868551;     // km^3/s^2
constexpr double MU_VENUS = 324858.592000;      // km^3/s^2
constexpr double MU_MARS = 42828.375816;        // km^3/s^2
constexpr double MU_JUPITER = 126712764.100000; // km^3/s^2
constexpr double MU_SATURN = 37940584.841800;   // km^3/s^2
constexpr double MU_URANUS = 5794556.400000;    // km^3/s^2
constexpr double MU_NEPTUNE = 6836527.100580;   // km^3/s^2

// Moon constants (GRGM1200A reference)
constexpr double RE_MOON = 1737.4;              // km (mean radius)
constexpr double J2_MOON = 2.0323e-4;           // J2 coefficient

// Solar constants
constexpr double AU_KM = 149597870.7;           // km per AU
constexpr double SOLAR_FLUX_1AU = 1361.0;       // W/m^2 (solar constant)
constexpr double SOLAR_PRESSURE_1AU = 4.56e-6;  // N/m^2 (radiation pressure)
constexpr double SPEED_OF_LIGHT = 299792.458;   // km/s

// Time constants
constexpr double YEAR_SEC = 365.25 * 24.0 * 3600.0;  // seconds per Julian year
constexpr double DAY_SEC = 86400.0;                  // seconds per day

// CR3BP system constants - Earth-Moon
constexpr double MU_EARTH_MOON = 0.012150585609624;  // Earth-Moon mass ratio (mu = m_moon/(m_earth+m_moon))
constexpr double L_EARTH_MOON = 384400.0;            // Earth-Moon distance (km)
constexpr double T_EARTH_MOON = 2360591.504;         // Synodic period (s) ~27.32 days

// CR3BP system constants - Sun-Earth
constexpr double MU_SUN_EARTH = 3.003e-6;            // Sun-Earth mass ratio (mu = m_earth/(m_sun+m_earth))

// =============================================================================
// Basic Vector Types
// =============================================================================

struct Vec3 {
    double x{0}, y{0}, z{0};

    Vec3() = default;
    Vec3(double x_, double y_, double z_) : x(x_), y(y_), z(z_) {}

    double magnitude() const { return std::sqrt(x*x + y*y + z*z); }
    double magnitudeSq() const { return x*x + y*y + z*z; }

    Vec3 normalized() const {
        double m = magnitude();
        return m > 0 ? Vec3(x/m, y/m, z/m) : Vec3();
    }

    Vec3 operator+(const Vec3& o) const { return Vec3(x+o.x, y+o.y, z+o.z); }
    Vec3 operator-(const Vec3& o) const { return Vec3(x-o.x, y-o.y, z-o.z); }
    Vec3 operator*(double s) const { return Vec3(x*s, y*s, z*s); }
    Vec3 operator/(double s) const { return Vec3(x/s, y/s, z/s); }
    Vec3& operator+=(const Vec3& o) { x+=o.x; y+=o.y; z+=o.z; return *this; }
    Vec3& operator-=(const Vec3& o) { x-=o.x; y-=o.y; z-=o.z; return *this; }
    Vec3& operator*=(double s) { x*=s; y*=s; z*=s; return *this; }
    Vec3 operator-() const { return Vec3(-x, -y, -z); }  // Unary minus

    double dot(const Vec3& o) const { return x*o.x + y*o.y + z*o.z; }
    Vec3 cross(const Vec3& o) const {
        return Vec3(y*o.z - z*o.y, z*o.x - x*o.z, x*o.y - y*o.x);
    }
};

inline Vec3 operator*(double s, const Vec3& v) { return v * s; }

// 3x3 Matrix
struct Mat3 {
    double m[3][3] = {{1,0,0},{0,1,0},{0,0,1}};

    static Mat3 identity() { return Mat3(); }
    static Mat3 zero() { Mat3 r; for(int i=0;i<3;i++) for(int j=0;j<3;j++) r.m[i][j]=0; return r; }

    Vec3 operator*(const Vec3& v) const {
        return Vec3(
            m[0][0]*v.x + m[0][1]*v.y + m[0][2]*v.z,
            m[1][0]*v.x + m[1][1]*v.y + m[1][2]*v.z,
            m[2][0]*v.x + m[2][1]*v.y + m[2][2]*v.z
        );
    }

    Mat3 operator*(const Mat3& o) const {
        Mat3 r = Mat3::zero();
        for(int i=0;i<3;i++) for(int j=0;j<3;j++) for(int k=0;k<3;k++)
            r.m[i][j] += m[i][k] * o.m[k][j];
        return r;
    }

    Mat3 transpose() const {
        Mat3 r;
        for(int i=0;i<3;i++) for(int j=0;j<3;j++) r.m[i][j] = m[j][i];
        return r;
    }
};

// 6x6 Matrix for state transition
struct Mat6 {
    double m[6][6] = {};

    static Mat6 identity() {
        Mat6 r;
        for(int i=0;i<6;i++) r.m[i][i] = 1.0;
        return r;
    }

    static Mat6 zero() { return Mat6(); }
};

// =============================================================================
// State Vector Types
// =============================================================================

// Cartesian state (position + velocity)
struct StateVector {
    Vec3 position;      // km
    Vec3 velocity;      // km/s
    double epoch{0};    // Julian date (TDB)

    StateVector() = default;
    StateVector(const Vec3& r, const Vec3& v, double t = 0)
        : position(r), velocity(v), epoch(t) {}
};

// Classical orbital elements
struct KeplerianElements {
    double a{0};        // Semi-major axis (km)
    double e{0};        // Eccentricity
    double i{0};        // Inclination (rad)
    double raan{0};     // Right ascension of ascending node (rad)
    double argp{0};     // Argument of periapsis (rad)
    double nu{0};       // True anomaly (rad)
    double epoch{0};    // Epoch (Julian date TDB)
    double mu{MU_EARTH}; // Gravitational parameter

    // Derived quantities
    double meanAnomaly() const;
    double eccentricAnomaly() const;
    double period() const { return TWO_PI * std::sqrt(a*a*a / mu); }
    double meanMotion() const { return std::sqrt(mu / (a*a*a)); }
    double periapsis() const { return a * (1.0 - e); }
    double apoapsis() const { return a * (1.0 + e); }
};

// Equinoctial elements (singularity-free for circular/equatorial)
struct EquinoctialElements {
    double a{0};        // Semi-major axis (km)
    double h{0};        // e * sin(argp + raan)
    double k{0};        // e * cos(argp + raan)
    double p{0};        // tan(i/2) * sin(raan)
    double q{0};        // tan(i/2) * cos(raan)
    double L{0};        // True longitude (rad)
    double epoch{0};
    double mu{MU_EARTH};
};

// Relative orbital elements (ROE) for proximity operations
// Koenig-Guffanti-D'Amico formulation
struct RelativeOrbitalElements {
    double da{0};       // Relative semi-major axis (delta a / a_chief)
    double dlambda{0};  // Relative mean longitude (rad)
    double dex{0};      // Relative eccentricity vector x
    double dey{0};      // Relative eccentricity vector y
    double dix{0};      // Relative inclination vector x
    double diy{0};      // Relative inclination vector y
    double epoch{0};
};

// =============================================================================
// Numerical Integration Types
// =============================================================================

// Integration method enumeration (Phase 11.1 Extended)
enum class IntegrationMethod {
    RK4,                // 4th order Runge-Kutta (fixed step)
    RKF45,              // Runge-Kutta-Fehlberg 4(5) adaptive
    RKF78,              // Runge-Kutta-Fehlberg 7(8) adaptive
    RK78,               // 7(8) Dormand-Prince (alias for RKDP78)
    RKDP87,             // Dormand-Prince 8(7)
    RK89,               // 8(9) Prince-Dormand
    ABM,                // Adams-Bashforth-Moulton multi-step
    BS,                 // Bulirsch-Stoer extrapolation
    GaussJackson8,      // 8th order Gauss-Jackson
    GaussJackson12,     // 12th order Gauss-Jackson
    Cowell,             // Cowell's method (rectangular coords)
    Encke,              // Encke's method (perturbed deviation)
    GaussVOP,           // Gauss variational equations
    EquinoctialVOP,     // Equinoctial elements VOP
    Dromo,              // DROMO regularized formulation
    Stiefel,            // Stiefel-Scheifele regularization
    KeplerianSTM        // State transition matrix propagation
};

// Integrator configuration
struct IntegratorConfig {
    IntegrationMethod method{IntegrationMethod::RK78};
    double initialStep{60.0};       // Initial step size (seconds)
    double minStep{1.0};            // Minimum step size (seconds)
    double maxStep{3600.0};         // Maximum step size (seconds)
    double absTolerance{1e-12};     // Absolute tolerance
    double relTolerance{1e-12};     // Relative tolerance
    uint32_t maxSteps{100000};      // Maximum integration steps
};

// Derivative function type
using DerivativeFunc = std::function<void(double t, const double* y, double* dydt, void* params)>;

// Integrator state
struct IntegratorState {
    std::array<double, 6> y;        // Current state [rx, ry, rz, vx, vy, vz]
    double t{0};                    // Current time
    double h{60.0};                 // Current step size
    uint32_t steps{0};              // Steps taken
    uint32_t rejections{0};         // Rejected steps
    bool initialized{false};

    // Extended state for multi-step methods (ABM, Gauss-Jackson)
    std::array<std::array<double, 6>, 8> history;  // Previous states
    std::array<std::array<double, 6>, 8> fHistory; // Previous derivatives
    uint8_t historyCount{0};                       // Valid history entries
};

// -----------------------------------------------------------------------------
// Phase 11.1 - Encke State (for Encke's method)
// -----------------------------------------------------------------------------

/// State for Encke's method: integrates deviation from a reference Keplerian orbit
struct EnckeState {
    StateVector reference;          ///< Reference Keplerian orbit state at epoch
    KeplerianElements refElements;  ///< Reference orbit elements
    Vec3 deltaR;                    ///< Position deviation from reference (km)
    Vec3 deltaV;                    ///< Velocity deviation from reference (km/s)
    double t{0};                    ///< Current time (seconds from epoch)
    double rectificationThreshold{0.01}; ///< Rectify when |deltaR|/|r_ref| > this
    bool needsRectification{false}; ///< True when deviation too large
    double mu{MU_EARTH};            ///< Gravitational parameter

    /// Get total (osculating) state
    StateVector getOsculatingState() const {
        return StateVector(
            reference.position + deltaR,
            reference.velocity + deltaV,
            reference.epoch + t / 86400.0
        );
    }
};

// -----------------------------------------------------------------------------
// Phase 11.1 - Variational State (for VOP methods)
// -----------------------------------------------------------------------------

/// State for variational equation methods (Gauss VOP, Equinoctial VOP)
struct VariationalState {
    KeplerianElements elements;     ///< Current osculating elements
    EquinoctialElements equinoctial;///< Equinoctial elements (for EquinoctialVOP)
    double t{0};                    ///< Time from epoch (seconds)
    bool useEquinoctial{false};     ///< True to use equinoctial elements
    double mu{MU_EARTH};            ///< Gravitational parameter

    // Element rates (from Gauss variational equations)
    double dadt{0};                 ///< da/dt (km/s)
    double dedt{0};                 ///< de/dt (1/s)
    double didt{0};                 ///< di/dt (rad/s)
    double draandt{0};              ///< dRAAN/dt (rad/s)
    double dargpdt{0};              ///< dargp/dt (rad/s)
    double dMdt{0};                 ///< dM/dt - n (rad/s, perturbation only)

    // Equinoctial element rates
    double dhdt{0};                 ///< dh/dt
    double dkdt{0};                 ///< dk/dt
    double dpdt{0};                 ///< dp/dt
    double dqdt{0};                 ///< dq/dt
    double dLdt{0};                 ///< dL/dt
};

// -----------------------------------------------------------------------------
// Phase 11.1 - State Transition Matrix Types
// -----------------------------------------------------------------------------

/// Keplerian STM state (elements + STM)
struct KeplerianSTMState {
    KeplerianElements elements;     ///< Current elements
    double stm[6][6] = {};          ///< Partials of final w.r.t. initial elements
    double t{0};                    ///< Time from epoch (seconds)

    /// Initialize STM to identity
    void initSTM() {
        for (int i = 0; i < 6; i++) {
            for (int j = 0; j < 6; j++) {
                stm[i][j] = (i == j) ? 1.0 : 0.0;
            }
        }
    }
};

// -----------------------------------------------------------------------------
// Phase 11.1 - Bulirsch-Stoer Extrapolation State
// -----------------------------------------------------------------------------

/// Bulirsch-Stoer extrapolation tableau entry
struct BSTableauEntry {
    double h;                       ///< Step size used
    std::array<double, 6> y;        ///< State at this subdivision
    bool valid{false};
};

/// Bulirsch-Stoer integrator state
struct BulirschStoerState {
    std::array<double, 6> y;        ///< Current state
    double t{0};                    ///< Current time
    double h{60.0};                 ///< Current step size
    uint16_t maxSubdivisions{12};   ///< Maximum number of subdivisions
    std::array<BSTableauEntry, 13> tableau; ///< Extrapolation tableau
};

// -----------------------------------------------------------------------------
// Phase 11.1.1 - Adams-Bashforth-Moulton Multi-Step State
// -----------------------------------------------------------------------------

/// Adams-Bashforth-Moulton predictor-corrector state
struct ABMState {
    std::array<double, 6> y;        ///< Current state
    double t{0};                    ///< Current time
    double h{60.0};                 ///< Fixed step size (required for multi-step)

    /// History of previous function evaluations (for predictor)
    /// Index 0 = most recent, index k-1 = oldest
    std::array<std::array<double, 6>, 8> fHistory;
    uint8_t historyCount{0};        ///< Number of valid history entries (0-8)
    bool initialized{false};        ///< True after startup phase complete

    /// Order of method (4-8 supported)
    uint8_t order{4};
};

// -----------------------------------------------------------------------------
// Phase 11.1.1 - DROMO Regularized Formulation State
// -----------------------------------------------------------------------------

/// DROMO regularized orbit formulation state
/// Uses 8 generalized orbital elements with time regularization
/// Reference: Pelaez, Hedo, Rodriguez (2007)
struct DromoState {
    /// DROMO elements: [sigma1, sigma2, sigma3, sigma4, zeta1, zeta2, zeta3, tau]
    /// sigma1-4: unit quaternion components for orbital plane orientation
    /// zeta1-3: eccentricity-like elements
    /// tau: regularized time variable
    std::array<double, 8> elements;

    double physicalTime{0};         ///< Physical time (seconds)
    double independentVar{0};       ///< Independent variable (fictitious time s)
    double mu{MU_EARTH};            ///< Gravitational parameter
    double energy{0};               ///< Orbital energy
    double angMomentum{0};          ///< Angular momentum magnitude

    /// Reference radius for non-dimensionalization (km)
    double refRadius{RE_EARTH};

    /// Convert to Cartesian state
    StateVector toCartesian() const;

    /// Initialize from Cartesian state
    static DromoState fromCartesian(const StateVector& state, double mu = MU_EARTH);
};

// -----------------------------------------------------------------------------
// Phase 11.1.1 - Stiefel-Scheifele Regularization State
// -----------------------------------------------------------------------------

/// Stiefel-Scheifele regularized state using KS transformation
/// Uses spinor (quaternion-like) parameterization for regularization
/// Reference: Stiefel & Scheifele (1971)
struct StiefelState {
    /// KS (Kustaanheimo-Stiefel) parameters: u = [u1, u2, u3, u4]
    /// r = u^T * u = u1^2 + u2^2 + u3^2 + u4^2
    std::array<double, 4> u;

    /// Time derivatives of KS parameters: u' = du/ds
    std::array<double, 4> uPrime;

    /// Physical time
    double physicalTime{0};

    /// Fictitious time (independent variable)
    double s{0};

    /// Gravitational parameter
    double mu{MU_EARTH};

    /// Orbital energy (conserved for Kepler problem)
    double energy{0};

    /// Time element (for handling time regularization)
    double timeElement{0};

    /// Convert to Cartesian state
    StateVector toCartesian() const;

    /// Initialize from Cartesian state
    static StiefelState fromCartesian(const StateVector& state, double mu = MU_EARTH);

    /// Get current radius (r = |u|^2)
    double radius() const {
        return u[0]*u[0] + u[1]*u[1] + u[2]*u[2] + u[3]*u[3];
    }
};

// =============================================================================
// Force Model Types
// =============================================================================

// Force model configuration
struct ForceModelConfig {
    // Central body gravity
    double mu{MU_EARTH};
    bool useJ2{true};
    bool useJ3{false};
    bool useJ4{false};
    uint16_t gravityDegree{0};      // 0 = point mass, 2+ = harmonics
    uint16_t gravityOrder{0};

    // Third body perturbations
    bool useSunGravity{false};
    bool useMoonGravity{false};

    // Non-gravitational forces
    bool useDrag{false};
    bool useSRP{false};             // Solar radiation pressure

    // Spacecraft parameters (for drag/SRP)
    double mass{1000.0};            // kg
    double dragArea{10.0};          // m^2
    double srpArea{10.0};           // m^2
    double Cd{2.2};                 // Drag coefficient
    double Cr{1.5};                 // Reflectivity coefficient
};

// =============================================================================
// Lambert Problem Types
// =============================================================================

// Lambert problem input
struct LambertInput {
    Vec3 r1;                // Initial position (km)
    Vec3 r2;                // Final position (km)
    double tof;             // Time of flight (seconds)
    double mu{MU_EARTH};    // Gravitational parameter
    bool shortWay{true};    // Short way (prograde) transfer
    int multiRev{0};        // Number of complete revolutions (0 = minimum energy)
};

// Lambert problem solution
struct LambertSolution {
    Vec3 v1;                // Initial velocity (km/s)
    Vec3 v2;                // Final velocity (km/s)
    double a;               // Semi-major axis (km)
    double e;               // Eccentricity
    double p;               // Semi-latus rectum (km)
    int revolutions{0};     // Number of complete revolutions
    bool valid{false};
    int iterations{0};
};

// =============================================================================
// Conjunction Assessment Types
// =============================================================================

// Time of closest approach result
struct TCAResult {
    double tca;             // Time of closest approach (Julian date)
    double missDistance;    // Miss distance at TCA (km)
    Vec3 relativePosition;  // Relative position at TCA (km)
    Vec3 relativeVelocity;  // Relative velocity at TCA (km/s)
    bool valid{false};
};

// Covariance matrix (6x6 for position/velocity)
struct Covariance6 {
    double c[6][6] = {};

    // Extract position-only 3x3 covariance
    Mat3 positionCovariance() const {
        Mat3 r;
        for(int i=0;i<3;i++) for(int j=0;j<3;j++) r.m[i][j] = c[i][j];
        return r;
    }
};

// Collision probability result
struct CollisionProbability {
    double Pc{0};           // Probability of collision
    double hardBodyRadius{0}; // Combined hard body radius (km)
    double mahalanobis{0};  // Mahalanobis distance
    bool valid{false};
};

// Conjunction event
struct ConjunctionEvent {
    uint32_t primaryId{0};
    uint32_t secondaryId{0};
    TCAResult tca;
    Covariance6 primaryCovariance;
    Covariance6 secondaryCovariance;
    CollisionProbability probability;
};

// =============================================================================
// Maneuver Types
// =============================================================================

// Impulsive maneuver
struct ImpulsiveManeuver {
    double epoch{0};        // Maneuver epoch (Julian date)
    Vec3 deltaV;            // Delta-V in RTN frame (km/s)
    double magnitude{0};    // |delta-V| (km/s)
};

// Hohmann transfer result
struct HohmannTransfer {
    double deltaV1{0};      // First burn (km/s)
    double deltaV2{0};      // Second burn (km/s)
    double totalDeltaV{0};  // Total delta-V (km/s)
    double transferTime{0}; // Transfer time (seconds)
    double aTransfer{0};    // Transfer orbit semi-major axis (km)
    bool valid{false};
};

// Bi-elliptic transfer result
struct BiEllipticTransfer {
    double deltaV1{0};      // First burn (km/s)
    double deltaV2{0};      // Second burn at apoapsis (km/s)
    double deltaV3{0};      // Third burn (km/s)
    double totalDeltaV{0};  // Total delta-V (km/s)
    double transferTime{0}; // Total transfer time (seconds)
    double rb{0};           // Intermediate apoapsis radius (km)
    bool valid{false};
};

// Plane change maneuver
struct PlaneChangeManeuver {
    double deltaV{0};       // Required delta-V (km/s)
    double theta{0};        // Optimal burn location (rad from ascending node)
    double deltaInc{0};     // Change in inclination (rad)
    double deltaRaan{0};    // Change in RAAN (rad)
    bool combined{false};   // Combined with altitude change
};

// =============================================================================
// RPO (Rendezvous & Proximity Operations) Types
// =============================================================================

// Clohessy-Wiltshire state (LVLH frame)
struct CWState {
    double x{0}, y{0}, z{0};       // Position in LVLH (km)
    double xdot{0}, ydot{0}, zdot{0}; // Velocity in LVLH (km/s)
    double epoch{0};

    Vec3 position() const { return Vec3(x, y, z); }
    Vec3 velocity() const { return Vec3(xdot, ydot, zdot); }
};

// Hold point type
enum class HoldPointType {
    VBar,       // Along velocity vector (in front/behind)
    RBar,       // Along radial (above/below)
    HBar        // Along angular momentum (out of plane)
};

// Hold point definition
struct HoldPoint {
    HoldPointType type{HoldPointType::VBar};
    double distance{0};     // Distance from target (km)
    bool stationKeeping{true};
};

// =============================================================================
// Phase 8.6 Environment Models - Types
// =============================================================================

// -----------------------------------------------------------------------------
// 8.6.1 High-Fidelity Gravity Models
// -----------------------------------------------------------------------------

/// Gravity model type enumeration
enum class GravityModelType {
    PointMass,      ///< Simple point mass (mu/r^2)
    J2Only,         ///< J2 zonal harmonic only
    J2J4,           ///< J2-J4 zonal harmonics
    EGM96,          ///< EGM96 (degree 360)
    EGM2008,        ///< EGM2008 (degree 2190 max)
    GRGM1200A,      ///< GRGM1200A lunar model (degree 1200 max)
    Custom          ///< Custom coefficients
};

/// Spherical harmonic gravity field coefficients
struct GravityFieldCoefficients {
    GravityModelType model{GravityModelType::J2Only};
    uint16_t maxDegree{2};              ///< Maximum degree to use
    uint16_t maxOrder{0};               ///< Maximum order to use (0 = zonal only)
    double mu{MU_EARTH};                ///< Central body GM (km^3/s^2)
    double referenceRadius{RE_EARTH};   ///< Reference radius (km)

    // Pre-computed normalized coefficients (for degrees 2-20)
    // For higher degrees, would use external coefficient file
    static constexpr int MAX_INLINE_DEGREE = 20;
    double Cnm[MAX_INLINE_DEGREE + 1][MAX_INLINE_DEGREE + 1] = {};  ///< Cosine coefficients
    double Snm[MAX_INLINE_DEGREE + 1][MAX_INLINE_DEGREE + 1] = {};  ///< Sine coefficients
};

/// High-fidelity gravity acceleration result
struct GravityAcceleration {
    Vec3 total;             ///< Total gravity acceleration (km/s^2)
    Vec3 pointMass;         ///< Point mass contribution
    Vec3 zonalHarmonics;    ///< Zonal (J2, J3, ...) contribution
    Vec3 tesseral;          ///< Tesseral/sectoral contribution
    uint16_t degreeUsed{0}; ///< Actual degree computed
    uint16_t orderUsed{0};  ///< Actual order computed
    bool valid{false};      ///< True if computation succeeded
};

// -----------------------------------------------------------------------------
// 8.6.2 Third Body Perturbations - JPL Development Ephemeris
// -----------------------------------------------------------------------------

/// Celestial body identifiers (JPL DE numbering)
enum class CelestialBody : uint8_t {
    Sun = 0,
    Mercury = 1,
    Venus = 2,
    EarthMoonBarycenter = 3,
    Mars = 4,
    Jupiter = 5,
    Saturn = 6,
    Uranus = 7,
    Neptune = 8,
    Pluto = 9,
    Moon = 10,
    Earth = 11
};

/// JPL DE ephemeris version
enum class JPLDEVersion : uint8_t {
    DE405,      ///< DE405 (1997-2017 validity)
    DE421,      ///< DE421 (lunar laser ranging)
    DE430,      ///< DE430 (planetary, 1550-2650)
    DE432,      ///< DE432 (extended validity)
    DE438,      ///< DE438 (2020 update)
    DE440,      ///< DE440 (2021 update, ICRF3)
    Analytical  ///< Simplified analytical approximations
};

// Actual state provenance. JPL_SPK is the honest default for an arbitrary
// caller-provided kernel: the DAF header does not identify its DE release.
namespace Ephemeris {
enum class EphemerisSource {
    Analytical, JPL_DE440, JPL_DE441, INPOP21a, EPM2021, MarsHighFidelity,
    JPL_DE430, JPL_SPK
};
}

/// Ephemeris state for a celestial body
struct EphemerisState {
    CelestialBody body;
    Ephemeris::EphemerisSource source{Ephemeris::EphemerisSource::Analytical};
    Vec3 position;          ///< Position (km, J2000 ecliptic or ICRF)
    Vec3 velocity;          ///< Velocity (km/s)
    double epoch{0};        ///< Julian date (TDB)
    bool valid{false};
};

/// Third body perturbation configuration
struct ThirdBodyConfig {
    bool includeSun{true};
    bool includeMoon{true};
    bool includeMercury{false};
    bool includeVenus{false};
    bool includeMars{false};
    bool includeJupiter{false};
    bool includeSaturn{false};
    bool includeUranusNeptune{false};
    JPLDEVersion ephemerisVersion{JPLDEVersion::Analytical};
};

/// Third body acceleration result
struct ThirdBodyAcceleration {
    Vec3 total;             ///< Total third-body acceleration (km/s^2)
    Vec3 sun;               ///< Sun contribution
    Vec3 moon;              ///< Moon contribution
    Vec3 planets;           ///< Combined planetary contribution
};

// -----------------------------------------------------------------------------
// 8.6.3 Solar Radiation Pressure Models
// -----------------------------------------------------------------------------

/// Shadow model type
enum class ShadowModelType {
    None,           ///< No shadow (always in sunlight)
    Cylindrical,    ///< Simplified cylindrical shadow
    Conical,        ///< Conical umbra + penumbra
    DualCone        ///< Dual-cone (Earth + Moon shadows)
};

/// Shadow geometry result
struct ShadowGeometry {
    ShadowModelType model{ShadowModelType::Cylindrical};
    double shadowFraction{0};   ///< 0 = full sunlight, 1 = full umbra
    double penumbraFraction{0}; ///< Fraction in penumbra
    bool inUmbra{false};        ///< True if in umbra
    bool inPenumbra{false};     ///< True if in penumbra
    double apparentSunAngle{0}; ///< Apparent Sun radius angle (rad)
    double apparentBodyAngle{0};///< Apparent occulting body angle (rad)
};

/// Spacecraft surface model for SRP
enum class SpacecraftSurfaceModel {
    Cannonball,     ///< Simple sphere (Cr * A/m)
    FlatPlate,      ///< Flat plate (oriented)
    BoxWing,        ///< Box-wing model (bus + panels)
    MultiSurface    ///< Multiple surfaces with orientations
};

/// Solar radiation pressure configuration
struct SRPConfig {
    SpacecraftSurfaceModel surfaceModel{SpacecraftSurfaceModel::Cannonball};
    ShadowModelType shadowModel{ShadowModelType::Conical};
    double mass{1000.0};            ///< Spacecraft mass (kg)
    double crossSectionArea{10.0};  ///< Effective cross-section (m^2)
    double reflectivityCr{1.5};     ///< Reflectivity coefficient (1.0-2.0)
    double specularReflection{0.3}; ///< Fraction specularly reflected
    double diffuseReflection{0.1};  ///< Fraction diffusely reflected
    double absorption{0.6};         ///< Fraction absorbed

    // For BoxWing model
    double busArea{5.0};            ///< Bus cross-section (m^2)
    double solarPanelArea{20.0};    ///< Solar panel area (m^2)
    bool sunPointingPanels{true};   ///< True if panels track Sun
};

/// SRP acceleration result
struct SRPAcceleration {
    Vec3 total;             ///< Total SRP acceleration (km/s^2)
    double shadowFactor;    ///< Shadow factor applied (0-1)
    double solarFlux;       ///< Solar flux at satellite (W/m^2)
    double areaMassRatio;   ///< Effective A/m used (m^2/kg)
};

// -----------------------------------------------------------------------------
// 8.6.4 Advanced Atmospheric Models
// -----------------------------------------------------------------------------

/// Atmospheric model type
enum class AtmosphereModelType {
    Exponential,        ///< Simple exponential model
    USSA1976,           ///< US Standard Atmosphere 1976
    NRLMSISE00,         ///< NRLMSISE-00 (empirical)
    JB2008,             ///< Jacchia-Bowman 2008
    DTM2020,            ///< Drag Temperature Model 2020
    GOST2004,           ///< Russian GOST-2004
    HarrisPriester      ///< Harris-Priester modified
};

/// Atmospheric model configuration
struct AtmosphereConfig {
    AtmosphereModelType model{AtmosphereModelType::NRLMSISE00};
    bool includeWinds{false};           ///< Include horizontal wind effects
    bool coRotatingAtmosphere{true};    ///< Atmosphere rotates with Earth if true
    bool diurnalVariation{true};        ///< Include day/night variation
    bool geomagneticEffects{true};      ///< Include geomagnetic storm effects
    double minAltitude{100.0};          ///< Minimum altitude for drag (km)
    double maxAltitude{2500.0};         ///< Maximum altitude for drag (km)
};

/// Atmospheric density result
struct AtmosphericDensity {
    double density{0};          ///< Total mass density (kg/m^3)
    double temperature{0};      ///< Temperature (K)
    double molecularMass{0};    ///< Mean molecular mass (g/mol)
    double scaleHeight{0};      ///< Local scale height (km)
    double altitude{0};         ///< Geodetic altitude (km)
    double latitude{0};         ///< Geographic latitude (rad)
    double longitude{0};        ///< Geographic longitude (rad)
    double localSolarTime{0};   ///< Local solar time (hours)

    // Species densities (for NRLMSISE-00, JB2008)
    double nN2{0};              ///< N2 number density (#/m^3)
    double nO2{0};              ///< O2 number density (#/m^3)
    double nO{0};               ///< O number density (#/m^3)
    double nHe{0};              ///< He number density (#/m^3)
    double nH{0};               ///< H number density (#/m^3)
    double nAr{0};              ///< Ar number density (#/m^3)
};

/// Drag configuration
struct DragConfig {
    AtmosphereConfig atmosphere;
    double mass{1000.0};            ///< Spacecraft mass (kg)
    double dragArea{10.0};          ///< Drag cross-section area (m^2)
    double Cd{2.2};                 ///< Drag coefficient
    bool variableCd{false};         ///< Use variable Cd with altitude/speed
    double macNumber{0};            ///< Mach number (for variable Cd)
};

/// Drag acceleration result
struct DragAccelerationResult {
    Vec3 total;             ///< Total drag acceleration (km/s^2)
    double density;         ///< Atmospheric density used (kg/m^3)
    double dynamicPressure; ///< Dynamic pressure (N/m^2)
    double altitude;        ///< Altitude (km)
    double relativeSpeed;   ///< Speed relative to atmosphere (km/s)
    double ballisticCoeff;  ///< Ballistic coefficient B = Cd*A/m (m^2/kg)
};

// -----------------------------------------------------------------------------
// 8.6.5 Space Weather Indices
// -----------------------------------------------------------------------------

/// Space weather data record
struct SpaceWeatherData {
    double epoch{0};            ///< Julian date (UT)

    // Solar indices
    double F107{150.0};         ///< 10.7 cm solar radio flux (SFU)
    double F107a{150.0};        ///< 81-day centered average F10.7
    double F107adj{150.0};      ///< Adjusted F10.7 (for certain models)
    double S107{150.0};         ///< 26-34 nm EUV index (for JB2008)
    double M107{150.0};         ///< MgII core-to-wing ratio index
    double Y107{150.0};         ///< Lyman-alpha composite index

    // Geomagnetic indices
    double Ap{15.0};            ///< Daily Ap index (0-400)
    double Kp{3.0};             ///< 3-hour Kp index (0-9)
    double ap3h[8] = {};        ///< 3-hourly ap values for day
    double Dst{0};              ///< Disturbance storm time (nT)

    // Derived quantities
    double dTc{0};              ///< Temperature correction (for JB2008)
    bool isStorm{false};        ///< True during geomagnetic storm
    int stormPhase{0};          ///< Storm phase (0=quiet, 1=main, 2=recovery)
};

/// Space weather forecast level
enum class SpaceWeatherForecast {
    Observed,       ///< Observed/historical data
    Predicted24h,   ///< 24-hour prediction
    Predicted72h,   ///< 72-hour prediction
    Predicted27d,   ///< 27-day (solar rotation) prediction
    MonteCarlo      ///< Monte Carlo ensemble
};

/// Space weather configuration
struct SpaceWeatherConfig {
    bool useObserved{true};             ///< Use observed indices when available
    SpaceWeatherForecast forecastLevel{SpaceWeatherForecast::Observed};
    double defaultF107{150.0};          ///< Default F10.7 if no data
    double defaultAp{15.0};             ///< Default Ap if no data

    // For Monte Carlo analysis
    double f107Sigma{30.0};             ///< F10.7 1-sigma uncertainty (SFU)
    double apSigma{10.0};               ///< Ap 1-sigma uncertainty
};

// -----------------------------------------------------------------------------
// Enhanced Force Model Configuration (Phase 8.6)
// -----------------------------------------------------------------------------

/// Extended force model configuration with Phase 8.6 features
struct ForceModelConfigExtended {
    // Central body gravity (8.6.1)
    GravityFieldCoefficients earthGravity;
    GravityFieldCoefficients moonGravity;   ///< For cislunar missions
    bool useTidalEffects{false};            ///< Solid Earth tides
    bool useOceanTides{false};              ///< Ocean tide effects
    bool useRelativisticEffects{false};     ///< General relativity corrections

    // Third body (8.6.2)
    ThirdBodyConfig thirdBody;

    // Solar radiation pressure (8.6.3)
    SRPConfig srp;
    bool useSRP{false};

    // Atmospheric drag (8.6.4)
    DragConfig drag;
    bool useDrag{false};

    // Space weather (8.6.5)
    SpaceWeatherConfig spaceWeather;
    SpaceWeatherData currentWeather;

    // Spacecraft properties
    double mass{1000.0};                    ///< Mass (kg)
    Vec3 centerOfMass;                      ///< CoM offset from geometric center (m)

    // Time parameters
    double epoch{0};                        ///< Reference epoch (JD TDB)
    double ut1_utc{0};                      ///< UT1-UTC (seconds)
    double xpolar{0};                       ///< X polar motion (arcsec)
    double ypolar{0};                       ///< Y polar motion (arcsec)
};

// =============================================================================
// Phase 8.7: Data Source Integration Types
// =============================================================================

// HTTP request/response types for WASM browser environment
struct HttpRequest {
    std::string url;
    std::string method{"GET"};
    std::string body;
    std::array<std::pair<std::string, std::string>, 8> headers;
    int headerCount{0};
    int timeoutMs{30000};

    void addHeader(const std::string& key, const std::string& value) {
        if (headerCount < 8) {
            headers[headerCount++] = {key, value};
        }
    }
};

struct HttpResponse {
    int statusCode{0};
    std::string body;
    std::string errorMessage;
    bool success{false};
};

// Callback type for async HTTP requests (WASM)
using HttpCallback = std::function<void(const HttpResponse&)>;

// -----------------------------------------------------------------------------
// TLE (Two-Line Element Set) Types
// -----------------------------------------------------------------------------

/// Two-Line Element Set for SGP4/SDP4 propagation
struct TLE {
    int catalogNumber{0};           ///< NORAD catalog number
    char classification{'U'};       ///< Classification (U=unclassified)
    std::string intlDesignator;     ///< International designator (e.g., "98067A")
    std::string objectName;         ///< Satellite name

    // Line 1 elements
    double epochYear{0};            ///< Epoch year (2-digit or 4-digit)
    double epochDay{0};             ///< Epoch day of year with fractional part
    double meanMotionDot{0};        ///< First derivative of mean motion (rev/day^2)
    double meanMotionDDot{0};       ///< Second derivative of mean motion (rev/day^3)
    double bstar{0};                ///< B* drag term (1/Earth radii)
    int ephemerisType{0};           ///< Ephemeris type (0=SGP4)
    int elementSetNumber{0};        ///< Element set number

    // Line 2 elements
    double inclination{0};          ///< Inclination (degrees)
    double raanDeg{0};              ///< Right ascension of ascending node (degrees)
    double eccentricity{0};         ///< Eccentricity (decimal, leading 0. assumed)
    double argPerigeeDeg{0};        ///< Argument of perigee (degrees)
    double meanAnomalyDeg{0};       ///< Mean anomaly (degrees)
    double meanMotionRevPerDay{0};  ///< Mean motion (revolutions/day)
    int revolutionNumber{0};        ///< Revolution number at epoch

    // Raw TLE lines
    std::string line0;              ///< Name line (optional)
    std::string line1;              ///< Line 1
    std::string line2;              ///< Line 2

    // Validity flag
    bool valid{false};

    /// Get epoch as Julian Date
    double epochJD() const;

    /// Convert to Keplerian elements
    KeplerianElements toKeplerian() const;
};

/// TLE source provider
enum class TLESource {
    SpaceTrack,         ///< Space-Track.org (official 18th SDS)
    CelesTrak,          ///< CelesTrak (Dr. T.S. Kelso)
    CelesTrakGP,        ///< CelesTrak GP (General Perturbations) data
    Custom              ///< User-provided TLE
};

/// TLE collection with metadata
struct TLECollection {
    std::vector<TLE> tles;
    TLESource source{TLESource::CelesTrak};
    double fetchTime{0};            ///< Time of fetch (JD)
    double dataAge{0};              ///< Age of oldest TLE (days)
    std::string sourceUrl;
    bool valid{false};
};

// -----------------------------------------------------------------------------
// 8.7.1 Space-Track.org API Types
// -----------------------------------------------------------------------------

/// Space-Track.org authentication credentials
struct SpaceTrackCredentials {
    std::string username;
    std::string password;
    std::string sessionCookie;      ///< Session cookie after login
    double sessionExpiry{0};        ///< Session expiry time (JD)
    bool authenticated{false};
};

/// Space-Track.org query parameters
struct SpaceTrackQuery {
    // Query type
    enum class QueryType {
        TLE,                        ///< Current TLE
        TLELatest,                  ///< Latest TLE per object
        TLEHistory,                 ///< Historical TLEs
        Satcat,                     ///< Satellite catalog
        BoxScore,                   ///< Object counts by type
        Decay,                      ///< Decay predictions
        Tip,                        ///< Tracking and Impact Prediction
        Conjunction                 ///< CDM (Conjunction Data Messages)
    } type{QueryType::TLELatest};

    // Filters
    int catalogNumber{0};           ///< Specific NORAD ID (0=all)
    std::string intlDesignator;     ///< International designator filter
    std::string objectName;         ///< Object name filter (partial match)
    double epochStart{0};           ///< Epoch range start (JD)
    double epochEnd{0};             ///< Epoch range end (JD)
    int limit{100};                 ///< Max results
    std::string orderBy;            ///< Order by field

    // Object class filters
    bool includeDebris{true};
    bool includePayloads{true};
    bool includeRocketBodies{true};

    // Orbit filters
    double minPeriod{0};            ///< Min period (minutes)
    double maxPeriod{0};            ///< Max period (minutes)
    double minInclination{0};       ///< Min inclination (degrees)
    double maxInclination{180.0};   ///< Max inclination (degrees)
    double minApogee{0};            ///< Min apogee altitude (km)
    double maxApogee{0};            ///< Max apogee altitude (km, 0=no limit)
    double minPerigee{0};           ///< Min perigee altitude (km)
    double maxPerigee{0};           ///< Max perigee altitude (km, 0=no limit)
};

/// Space-Track satellite catalog entry
struct SatcatEntry {
    int catalogNumber{0};
    std::string intlDesignator;
    std::string objectName;
    std::string objectType;         ///< PAYLOAD, ROCKET BODY, DEBRIS, UNKNOWN
    std::string country;            ///< Launching country/organization
    double launchDate{0};           ///< Launch date (JD)
    std::string launchSite;
    double decayDate{0};            ///< Decay date if decayed (JD, 0=on orbit)
    double period{0};               ///< Orbital period (minutes)
    double inclination{0};          ///< Inclination (degrees)
    double apogee{0};               ///< Apogee altitude (km)
    double perigee{0};              ///< Perigee altitude (km)
    double rcs{0};                  ///< Radar cross section (m^2)
    char rcsSize{'U'};              ///< RCS size class (L=Large, M=Medium, S=Small, U=Unknown)
    bool onOrbit{true};
};

// -----------------------------------------------------------------------------
// 8.7.2 CelesTrak Integration Types
// -----------------------------------------------------------------------------

/// CelesTrak data category
enum class CelesTrakCategory {
    // Special interest
    LastThirtyDays,                 ///< Objects launched in last 30 days
    StationsAll,                    ///< All space stations
    VisualMag,                      ///< Visual magnitude < 7

    // Weather & Earth resources
    WeatherAll,                     ///< All weather satellites
    NOAA,                           ///< NOAA satellites
    GOES,                           ///< GOES satellites
    ResourceAll,                    ///< Earth resources satellites

    // Communications
    GeoSynchronous,                 ///< Active geosynchronous satellites
    Intelsat,                       ///< Intelsat satellites
    Iridium,                        ///< Iridium constellation
    IridiumNext,                    ///< Iridium NEXT
    Starlink,                       ///< SpaceX Starlink
    OneWeb,                         ///< OneWeb constellation
    Orbcomm,                        ///< Orbcomm
    GlobalStar,                     ///< GlobalStar
    SESAll,                         ///< SES satellites
    Amateur,                        ///< Amateur radio satellites

    // Navigation
    GPSOperational,                 ///< GPS operational
    Glonass,                        ///< GLONASS operational
    Galileo,                        ///< Galileo
    Beidou,                         ///< BeiDou (Compass)
    SBAS,                           ///< Satellite-based augmentation

    // Scientific
    SpaceEarthScience,              ///< Earth science satellites
    Engineering,                    ///< Engineering/research
    Education,                      ///< Educational satellites

    // Misc
    Radar,                          ///< Radar calibration objects
    CubeSats,                       ///< CubeSats
    Other,                          ///< Other

    // Full catalog
    ActiveSatellites,               ///< All active satellites
    Analyst,                        ///< Analyst objects (supplemental)

    // Special
    GPElement,                      ///< GP element data (JSON/XML)
    Custom                          ///< Custom URL
};

/// CelesTrak GP (General Perturbations) data format
struct GPData {
    int catalogNumber{0};
    std::string objectName;
    std::string objectId;           ///< COSPAR ID
    double epoch{0};                ///< Epoch (JD)
    double meanMotionRevDay{0};     ///< Mean motion (rev/day)
    double eccentricity{0};
    double inclinationDeg{0};       ///< degrees
    double raOfAscNodeDeg{0};       ///< degrees
    double argOfPericenterDeg{0};   ///< degrees
    double meanAnomalyDeg{0};       ///< degrees
    double bstar{0};
    double meanMotionDot{0};
    double meanMotionDDot{0};
    int revAtEpoch{0};
    char classification{'U'};
    std::string elementSetType;     ///< SGP, SGP4, SDP4, SGP8, SDP8
    double semimajorAxis{0};        ///< km (derived)
    double period{0};               ///< minutes (derived)
    double apoapsis{0};             ///< km altitude (derived)
    double periapsis{0};            ///< km altitude (derived)
    bool valid{false};
};

// -----------------------------------------------------------------------------
// 8.7.3 JPL Horizons Types
// -----------------------------------------------------------------------------

/// JPL Horizons target type
enum class HorizonsTargetType {
    MajorBody,              ///< Planets, moons, Sun (ID < 1000)
    SmallBody,              ///< Asteroids, comets
    Spacecraft,             ///< Space probes
    Custom                  ///< Custom target specification
};

/// JPL Horizons ephemeris type
enum class HorizonsEphemerisType {
    Observer,               ///< Observer table (from Earth surface/spacecraft)
    Vectors,                ///< State vectors
    Elements,               ///< Orbital elements
    SPK                     ///< Binary SPK file
};

/// JPL Horizons query parameters
struct HorizonsQuery {
    // Target specification
    HorizonsTargetType targetType{HorizonsTargetType::MajorBody};
    int targetId{0};                ///< NAIF ID for major bodies, or search query
    std::string targetName;         ///< Name/designation for search

    // Center (reference frame origin)
    int centerId{500};              ///< Default: geocenter (500 = Earth center)
    std::string centerName;

    // Time specification
    double startTime{0};            ///< Start time (JD TDB)
    double stopTime{0};             ///< Stop time (JD TDB)
    double stepSize{1.0};           ///< Step size (days)
    std::string stepUnit{"d"};      ///< Unit: m=minutes, h=hours, d=days

    // Output specification
    HorizonsEphemerisType ephemType{HorizonsEphemerisType::Vectors};
    std::string referenceFrame{"J2000"};  ///< Reference frame
    std::string refPlane{"ECLIPTIC"};     ///< Reference plane
    bool aberrations{true};         ///< Apply aberration corrections
};

/// Planetary/body ephemeris data point
struct EphemPoint {
    double jdTDB{0};                ///< Julian Date TDB
    Vec3 position;                  ///< Position (km)
    Vec3 velocity;                  ///< Velocity (km/s)
    double lightTime{0};            ///< One-way light time (seconds)
    double range{0};                ///< Range from center (km)
    double rangeRate{0};            ///< Range rate (km/s)
    bool valid{false};
};

/// JPL Horizons ephemeris result
struct HorizonsEphemeris {
    std::string targetName;
    int targetId{0};
    std::string centerName;
    int centerId{0};
    std::string referenceFrame;
    std::vector<EphemPoint> points;
    double startJD{0};
    double endJD{0};
    bool valid{false};
    std::string errorMessage;
};

/// Standard NAIF body IDs for major solar system bodies
namespace NAIFIds {
    constexpr int SUN = 10;
    constexpr int MERCURY_BARYCENTER = 1;
    constexpr int VENUS_BARYCENTER = 2;
    constexpr int EARTH_BARYCENTER = 3;
    constexpr int MARS_BARYCENTER = 4;
    constexpr int JUPITER_BARYCENTER = 5;
    constexpr int SATURN_BARYCENTER = 6;
    constexpr int URANUS_BARYCENTER = 7;
    constexpr int NEPTUNE_BARYCENTER = 8;
    constexpr int PLUTO_BARYCENTER = 9;

    constexpr int MERCURY = 199;
    constexpr int VENUS = 299;
    constexpr int EARTH = 399;
    constexpr int MOON = 301;
    constexpr int MARS = 499;
    constexpr int JUPITER = 599;
    constexpr int SATURN = 699;
    constexpr int URANUS = 799;
    constexpr int NEPTUNE = 899;
    constexpr int PLUTO = 999;

    // Common moons
    constexpr int PHOBOS = 401;
    constexpr int DEIMOS = 402;
    constexpr int IO = 501;
    constexpr int EUROPA = 502;
    constexpr int GANYMEDE = 503;
    constexpr int CALLISTO = 504;
    constexpr int TITAN = 606;

    // Centers
    constexpr int SOLAR_SYSTEM_BARYCENTER = 0;
    constexpr int GEOCENTER = 500;
}

// -----------------------------------------------------------------------------
// 8.7.4 IERS Data Types
// -----------------------------------------------------------------------------

/// Earth Orientation Parameters (EOP)
struct EOPData {
    double mjd{0};                  ///< Modified Julian Date
    double xPole{0};                ///< X pole position (arcsec)
    double yPole{0};                ///< Y pole position (arcsec)
    double xPoleError{0};           ///< X pole error (arcsec)
    double yPoleError{0};           ///< Y pole error (arcsec)
    double ut1_utc{0};              ///< UT1-UTC (seconds)
    double ut1_utcError{0};         ///< UT1-UTC error (seconds)
    double lod{0};                  ///< Length of day offset (ms)
    double lodError{0};             ///< LOD error (ms)
    double dX{0};                   ///< dX celestial pole offset (arcsec)
    double dY{0};                   ///< dY celestial pole offset (arcsec)
    double dXError{0};
    double dYError{0};
    bool predicted{false};          ///< True if predicted (not observed)
    bool valid{false};
};

/// Leap second entry
struct LeapSecondEntry {
    double jd{0};                   ///< Julian Date of leap second
    double mjd{0};                  ///< Modified Julian Date
    int year{0};
    int month{0};
    int day{0};
    double tai_utc{0};              ///< TAI-UTC after this leap second (seconds)
    int leapSecondNumber{0};        ///< Running count of leap seconds
};

/// IERS data collection
struct IERSDataSet {
    // Earth Orientation Parameters
    std::vector<EOPData> eopData;
    double eopStartMJD{0};          ///< Start of EOP data coverage
    double eopEndMJD{0};            ///< End of EOP data coverage (observed)
    double eopPredictedEndMJD{0};   ///< End of predicted EOP data

    // Leap seconds
    std::vector<LeapSecondEntry> leapSeconds;
    double currentTAI_UTC{0};       ///< Current TAI-UTC offset
    LeapSecondEntry nextLeapSecond; ///< Announced future leap second (if any)
    bool leapSecondAnnounced{false};

    // Data freshness
    double lastUpdateMJD{0};        ///< Last update time
    std::string dataSource;
    bool valid{false};

    /// Interpolate EOP at given MJD
    EOPData interpolateEOP(double mjd) const;

    /// Get TAI-UTC at given JD
    double getTAI_UTC(double jd) const;

    /// Get UT1-UTC at given MJD
    double getUT1_UTC(double mjd) const;
};

/// IERS bulletin type
enum class IERSBulletinType {
    BulletinA,              ///< Rapid service, weekly
    BulletinB,              ///< Monthly
    BulletinC,              ///< Leap second announcements
    BulletinD,              ///< DUT1 announcements
    FinalsAll,              ///< Finals (all data)
    Finals2000A             ///< Finals2000A (IAU 2000A)
};

// -----------------------------------------------------------------------------
// 8.7.5 Real-time TLE Update Pipeline Types
// -----------------------------------------------------------------------------

/// TLE update status
enum class TLEUpdateStatus {
    Idle,                   ///< No update in progress
    Fetching,               ///< Currently fetching
    Parsing,                ///< Parsing response
    Validating,             ///< Validating TLEs
    Merging,                ///< Merging with existing catalog
    Complete,               ///< Update complete
    Failed                  ///< Update failed
};

/// TLE update configuration
struct TLEUpdateConfig {
    // Update scheduling
    double updateIntervalHours{6.0};    ///< Update interval in hours
    double staleThresholdDays{2.0};     ///< Age at which TLE is considered stale
    bool autoUpdate{false};              ///< Enable automatic updates

    // Sources (priority order)
    bool useSpaceTrack{true};
    bool useCelesTrak{true};
    bool useCelesTrakGP{true};

    // Space-Track credentials
    SpaceTrackCredentials spaceTrackAuth;

    // Filtering
    std::vector<int> priorityObjects;    ///< NORAD IDs to always update
    std::vector<CelesTrakCategory> categories;  ///< CelesTrak categories to fetch
    bool includeDebris{false};           ///< Include debris in updates
    int maxObjectsPerUpdate{1000};       ///< Max objects per update cycle

    // Quality control
    bool validateChecksums{true};        ///< Validate TLE checksums
    bool rejectAnomalous{true};          ///< Reject TLEs with anomalous elements
    double maxEccentricity{0.9};         ///< Max acceptable eccentricity
};

/// TLE update result
struct TLEUpdateResult {
    TLEUpdateStatus status{TLEUpdateStatus::Idle};
    int tlesRetrieved{0};               ///< Number of TLEs retrieved
    int tlesUpdated{0};                 ///< Number of TLEs updated (newer)
    int tlesAdded{0};                   ///< Number of new TLEs added
    int tlesRejected{0};                ///< Number of TLEs rejected (validation)
    int tlesUnchanged{0};               ///< Number unchanged
    double updateDuration{0};           ///< Update duration (seconds)
    double dataAgeOldest{0};            ///< Age of oldest TLE (days)
    double dataAgeNewest{0};            ///< Age of newest TLE (days)
    std::string errorMessage;
    std::vector<int> failedObjects;     ///< NORAD IDs that failed to update
};

/// TLE update callback
using TLEUpdateCallback = std::function<void(const TLEUpdateResult&)>;

/// TLE catalog with real-time update support
struct TLECatalog {
    std::vector<TLE> entries;
    double lastUpdateJD{0};
    TLEUpdateStatus updateStatus{TLEUpdateStatus::Idle};
    TLEUpdateConfig config;

    /// Find TLE by NORAD catalog number
    const TLE* findByCatalogNumber(int catNum) const;

    /// Find TLE by international designator
    const TLE* findByIntlDesignator(const std::string& intlDes) const;

    /// Get all TLEs matching a name pattern
    std::vector<const TLE*> findByName(const std::string& pattern) const;

    /// Get stale TLEs (older than threshold)
    std::vector<int> getStaleTLEs(double thresholdDays) const;
};

// -----------------------------------------------------------------------------
// Data Source Manager Types
// -----------------------------------------------------------------------------

/// Data source status
struct DataSourceStatus {
    bool spaceTrackAvailable{false};
    bool spaceTrackAuthenticated{false};
    bool celestrakAvailable{false};
    bool horizonsAvailable{false};
    bool iersAvailable{false};

    double lastSpaceTrackPing{0};
    double lastCelestrakPing{0};
    double lastHorizonsPing{0};
    double lastIersPing{0};

    std::string lastError;
};

// =============================================================================
// Phase 11.6: Power & Thermal Systems (Basilisk Port)
// =============================================================================

// -----------------------------------------------------------------------------
// 11.6.1 Power System Components
// -----------------------------------------------------------------------------

/// Stefan-Boltzmann constant (W/m^2/K^4)
constexpr double STEFAN_BOLTZMANN = 5.67e-8;

/// Solar constant at 1 AU (W/m^2)
constexpr double SOLAR_CONSTANT_1AU = 1361.0;

/// Solar panel configuration
struct SolarPanelConfig {
    double area{10.0};              ///< Panel area (m^2)
    double efficiency{0.28};        ///< Cell efficiency (0-1), typical 0.28-0.32 for multi-junction
    double degradationRate{0.02};   ///< Annual degradation rate (per year)
    double degradation{0.0};        ///< Current degradation factor (0=new, 1=dead)
    double minSunAngle{0.0};        ///< Minimum sun angle for power (rad)
    double maxSunAngle{PI/2};       ///< Maximum sun angle (rad, typically 90 deg)
    double temperature{300.0};      ///< Panel temperature (K)
    double tempCoeff{-0.003};       ///< Temperature coefficient (efficiency loss per K above 298K)
    double referenceTemp{298.0};    ///< Reference temperature for efficiency (K)
    bool sunTracking{true};         ///< True if panel tracks sun
};

/// Simple solar panel configuration (cosine law model)
struct SimpleSolarPanelConfig {
    double area{10.0};              ///< Panel area (m^2)
    double efficiency{0.28};        ///< Cell efficiency (0-1)
    double degradation{0.0};        ///< Degradation factor (0=new)
};

/// Battery configuration
struct BatteryConfig {
    double capacity{1000.0};        ///< Energy capacity (Wh)
    double maxDOD{0.8};             ///< Maximum depth of discharge (0-1)
    double minDOD{0.0};             ///< Minimum DOD (for reserve)
    double chargeEfficiency{0.95};  ///< Charge efficiency (0-1)
    double dischargeEfficiency{0.95}; ///< Discharge efficiency (0-1)
    double maxChargeRate{500.0};    ///< Maximum charge rate (W)
    double maxDischargeRate{800.0}; ///< Maximum discharge rate (W)
    double selfDischargeRate{0.001};///< Self-discharge rate per day (fraction)
    double temperature{293.0};      ///< Battery temperature (K)
    double tempCoeff{0.005};        ///< Capacity loss per K below 293K
};

/// Simple battery configuration (linear model)
struct SimpleBatteryConfig {
    double capacity{1000.0};        ///< Energy capacity (Wh)
    double maxDOD{0.8};             ///< Maximum depth of discharge
    double efficiency{0.90};        ///< Round-trip efficiency
};

/// Power state (current electrical state)
struct PowerState {
    double generation{0};           ///< Power generation (W)
    double consumption{0};          ///< Power consumption (W)
    double netPower{0};             ///< Net power: generation - consumption (W)
    double batterySOC{1.0};         ///< Battery state of charge (0-1)
    double batteryEnergy{0};        ///< Current battery energy (Wh)
    double solarPanelPower{0};      ///< Solar panel power output (W)
    double sunAngle{0};             ///< Sun angle to panel normal (rad)
    double solarFlux{SOLAR_CONSTANT_1AU}; ///< Solar flux at current distance (W/m^2)
    bool inEclipse{false};          ///< True if in eclipse
    double eclipseFraction{0};      ///< Eclipse fraction (0=full sun, 1=umbra)
    double epoch{0};                ///< Current time (Julian date)
};

/// Power sink (load model)
struct PowerSinkConfig {
    double nominalPower{100.0};     ///< Nominal power draw (W)
    double standbyPower{10.0};      ///< Standby power (W)
    double peakPower{200.0};        ///< Peak power (W)
    bool enabled{true};             ///< True if sink is active
    double dutyCycle{1.0};          ///< Duty cycle (0-1)
};

/// Simple power sink (constant power)
struct SimplePowerSinkConfig {
    double power{100.0};            ///< Constant power draw (W)
    bool enabled{true};
};

/// Power bus node configuration
struct PowerNodeConfig {
    double voltage{28.0};           ///< Bus voltage (V)
    double maxCurrent{50.0};        ///< Maximum current (A)
    double efficiency{0.95};        ///< Power conversion efficiency
};

/// Eclipse recharge configuration
struct EclipseRechargeConfig {
    double minSOCForSafety{0.3};    ///< Minimum SOC before entering safe mode
    double targetSOC{0.9};          ///< Target SOC after eclipse exit
    double rechargeBuffer{0.1};     ///< Buffer time factor for recharge planning
    bool prioritizeRecharge{true};  ///< Prioritize recharge over ops after eclipse
};

/// Solar panel output result
struct SolarPanelOutput {
    double power{0};                ///< Power output (W)
    double efficiency{0};           ///< Effective efficiency
    double sunAngle{0};             ///< Angle to sun (rad)
    double cosineAngle{0};          ///< cos(sunAngle)
    double temperatureLoss{0};      ///< Power loss due to temperature (W)
    double degradationLoss{0};      ///< Power loss due to degradation (W)
    double theoreticalMax{0};       ///< Maximum theoretical power (W)
    bool valid{true};
};

/// Battery state result
struct BatteryState {
    double stateOfCharge{1.0};      ///< SOC (0-1)
    double energy{0};               ///< Stored energy (Wh)
    double availableEnergy{0};      ///< Available energy considering DOD (Wh)
    double chargeRate{0};           ///< Current charge rate (W, negative=discharge)
    double timeToEmpty{0};          ///< Time to empty at current rate (hours)
    double timeToFull{0};           ///< Time to full at current rate (hours)
    double cycleCount{0};           ///< Estimated cycle count
    bool charging{false};
    bool valid{true};
};

/// Power budget result
struct PowerBudgetResult {
    double totalGeneration{0};      ///< Total power generation (W)
    double totalConsumption{0};     ///< Total power consumption (W)
    double netPower{0};             ///< Net power (W)
    double margin{0};               ///< Power margin (W)
    double marginPercent{0};        ///< Power margin (%)
    double batteryContribution{0};  ///< Battery contribution (W, positive=discharging)
    double batterySOC{0};           ///< Battery SOC
    double eclipseTimeRemaining{0}; ///< Time remaining in eclipse (s)
    double sunlitTimeRemaining{0};  ///< Time until next eclipse (s)
    bool powerPositive{true};       ///< True if generation >= consumption
    bool batteryHealthy{true};      ///< True if battery within limits
    bool valid{true};
};

/// Eclipse power result
struct EclipsePowerResult {
    double eclipseDuration{0};      ///< Eclipse duration (seconds)
    double energyRequired{0};       ///< Energy required during eclipse (Wh)
    double socAtEclipseEnd{0};      ///< Predicted SOC at eclipse end
    double rechargeTime{0};         ///< Time to recharge after eclipse (s)
    bool canSurvive{true};          ///< True if sufficient battery capacity
    bool valid{true};
};

// -----------------------------------------------------------------------------
// 11.6.2 Thermal System Components
// -----------------------------------------------------------------------------

/// Thermal node configuration (lumped mass model)
struct ThermalNodeConfig {
    double mass{10.0};              ///< Node mass (kg)
    double specificHeat{900.0};     ///< Specific heat capacity (J/kg/K), aluminum ~900
    double initialTemp{293.0};      ///< Initial temperature (K)
    double minTemp{233.0};          ///< Minimum allowable temperature (K), -40C
    double maxTemp{333.0};          ///< Maximum allowable temperature (K), 60C
    double area{1.0};               ///< External surface area (m^2)
    double absorptivity{0.3};       ///< Solar absorptivity (0-1)
    double emissivity{0.8};         ///< IR emissivity (0-1)
};

/// Simple thermal node (single capacitance)
struct SimpleThermalNode {
    double temperature{293.0};      ///< Current temperature (K)
    double thermalCapacity{9000.0}; ///< Thermal capacity m*Cp (J/K)
};

/// Radiator configuration
struct RadiatorConfig {
    double area{2.0};               ///< Radiating area (m^2)
    double emissivity{0.85};        ///< Emissivity (0-1), white paint ~0.85
    double viewFactor{0.9};         ///< View factor to space (0-1)
    double solarAbsorptivity{0.2};  ///< Solar absorptivity
    double temperature{293.0};      ///< Current radiator temperature (K)
    double sinkTemperature{4.0};    ///< Effective sink temperature (K), deep space ~4K
    bool deployable{false};         ///< True if deployable radiator
    bool deployed{true};            ///< Current deployment state
};

/// Heater configuration
struct HeaterConfig {
    double power{50.0};             ///< Heater power (W)
    double efficiency{0.95};        ///< Heater efficiency
    double setpointLow{273.0};      ///< Turn on below this temp (K)
    double setpointHigh{283.0};     ///< Turn off above this temp (K)
    double maxDutyCycle{1.0};       ///< Maximum duty cycle
    bool enabled{true};             ///< Heater enabled
    bool active{false};             ///< Currently heating
};

/// MLI (Multi-Layer Insulation) configuration
struct MLIConfig {
    double area{5.0};               ///< Covered area (m^2)
    int layers{20};                 ///< Number of layers
    double effectiveEmissivity{0.01}; ///< Effective emissivity (typically 0.005-0.03)
    double solarAbsorptivity{0.1};  ///< Outer layer solar absorptivity
    double conductance{0.005};      ///< Effective conductance (W/m^2/K)
};

/// Solar absorption configuration
struct SolarAbsorptionConfig {
    double area{10.0};              ///< Exposed area (m^2)
    double absorptivity{0.3};       ///< Solar absorptivity
    double solarFlux{SOLAR_CONSTANT_1AU}; ///< Solar flux (W/m^2)
    double sunAngle{0};             ///< Angle from sun (rad)
};

/// Thermal state (current thermal condition)
struct ThermalState {
    double temperature{293.0};      ///< Current temperature (K)
    double heatInput{0};            ///< Total heat input (W)
    double heatOutput{0};           ///< Total heat output (W)
    double netHeatRate{0};          ///< Net heat rate dQ/dt (W)
    double temperatureRate{0};      ///< Temperature rate dT/dt (K/s)
    double solarHeat{0};            ///< Solar heating (W)
    double internalHeat{0};         ///< Internal dissipation (W)
    double radiatedHeat{0};         ///< Radiated heat (W)
    double conductedHeat{0};        ///< Conducted heat (W)
    bool withinLimits{true};        ///< True if temperature within limits
    double epoch{0};                ///< Current time (Julian date)
};

/// Thermal node state
struct ThermalNodeState {
    double temperature{293.0};      ///< Temperature (K)
    double energy{0};               ///< Thermal energy (J)
    double heatRate{0};             ///< Heat rate (W)
    bool withinLimits{true};
};

/// Radiator output
struct RadiatorOutput {
    double heatRejected{0};         ///< Heat rejected to space (W)
    double effectiveArea{0};        ///< Effective radiating area (m^2)
    double temperature{0};          ///< Radiator temperature (K)
    double efficiency{0};           ///< Radiator efficiency
};

/// Thermal budget result
struct ThermalBudgetResult {
    double totalHeatIn{0};          ///< Total heat input (W)
    double totalHeatOut{0};         ///< Total heat output (W)
    double netHeat{0};              ///< Net heat (W)
    double averageTemp{0};          ///< Average temperature (K)
    double minTemp{0};              ///< Minimum node temperature (K)
    double maxTemp{0};              ///< Maximum node temperature (K)
    double heaterPower{0};          ///< Total heater power (W)
    double radiatorCapacity{0};     ///< Total radiator capacity (W)
    bool allNodesWithinLimits{true};
    bool valid{true};
};

/// Combined power-thermal state
struct PowerThermalState {
    PowerState power;
    ThermalState thermal;
    double epoch{0};
};

// =============================================================================
// Phase 11.7: CR3BP & Cislunar Types
// =============================================================================

// -----------------------------------------------------------------------------
// CR3BP System Definition
// -----------------------------------------------------------------------------

/// Standard CR3BP system configurations
enum class CR3BPSystemType {
    EarthMoon,      ///< Earth-Moon system
    SunEarth,       ///< Sun-Earth system
    SunMars,        ///< Sun-Mars system
    SunJupiter,     ///< Sun-Jupiter system
    Custom          ///< User-defined system
};

/// CR3BP system parameters in normalized units
struct CR3BPSystem {
    double mu{0};                       ///< Mass ratio: m2/(m1+m2), smaller body
    double L{0};                        ///< Characteristic length (km): distance between primaries
    double T{0};                        ///< Characteristic time (s): sqrt(L^3/(G*(m1+m2)))
    double V{0};                        ///< Characteristic velocity (km/s): L/T

    // Dimensional parameters for reference
    double m1{0};                       ///< Primary mass (kg)
    double m2{0};                       ///< Secondary mass (kg)
    double mu1{0};                      ///< Primary GM (km^3/s^2)
    double mu2{0};                      ///< Secondary GM (km^3/s^2)

    CR3BPSystemType type{CR3BPSystemType::Custom};
    std::string name;

    /// Position of primary body (m1) in normalized coordinates: (-mu, 0, 0)
    Vec3 primaryPosition() const { return Vec3(-mu, 0, 0); }

    /// Position of secondary body (m2) in normalized coordinates: (1-mu, 0, 0)
    Vec3 secondaryPosition() const { return Vec3(1.0 - mu, 0, 0); }

    /// Convert dimensional position to normalized
    Vec3 normalizePosition(const Vec3& r_dim) const { return r_dim / L; }

    /// Convert normalized position to dimensional
    Vec3 dimensionalPosition(const Vec3& r_norm) const { return r_norm * L; }

    /// Convert dimensional velocity to normalized
    Vec3 normalizeVelocity(const Vec3& v_dim) const { return v_dim / V; }

    /// Convert normalized velocity to dimensional
    Vec3 dimensionalVelocity(const Vec3& v_norm) const { return v_norm * V; }

    /// Convert dimensional time to normalized
    double normalizeTime(double t_dim) const { return t_dim / T; }

    /// Convert normalized time to dimensional
    double dimensionalTime(double t_norm) const { return t_norm * T; }
};

/// Factory function to create standard CR3BP systems
inline CR3BPSystem createCR3BPSystem(CR3BPSystemType type) {
    CR3BPSystem sys;
    sys.type = type;

    switch (type) {
        case CR3BPSystemType::EarthMoon:
            sys.name = "Earth-Moon";
            sys.mu1 = MU_EARTH;                     // Earth GM (km^3/s^2)
            sys.mu2 = MU_MOON;                      // Moon GM (km^3/s^2)
            sys.L = 384400.0;                       // Earth-Moon distance (km)
            sys.mu = sys.mu2 / (sys.mu1 + sys.mu2); // ~0.01215
            sys.T = std::sqrt(sys.L * sys.L * sys.L / (sys.mu1 + sys.mu2));
            sys.V = sys.L / sys.T;
            break;

        case CR3BPSystemType::SunEarth:
            sys.name = "Sun-Earth";
            sys.mu1 = MU_SUN;                       // Sun GM (km^3/s^2)
            sys.mu2 = MU_EARTH + MU_MOON;           // Earth-Moon barycenter GM
            sys.L = AU_KM;                          // 1 AU in km
            sys.mu = sys.mu2 / (sys.mu1 + sys.mu2); // ~3.04e-6
            sys.T = std::sqrt(sys.L * sys.L * sys.L / (sys.mu1 + sys.mu2));
            sys.V = sys.L / sys.T;
            break;

        case CR3BPSystemType::SunMars:
            sys.name = "Sun-Mars";
            sys.mu1 = MU_SUN;
            sys.mu2 = MU_MARS;
            sys.L = 227936640.0;                    // Mars semi-major axis (km)
            sys.mu = sys.mu2 / (sys.mu1 + sys.mu2);
            sys.T = std::sqrt(sys.L * sys.L * sys.L / (sys.mu1 + sys.mu2));
            sys.V = sys.L / sys.T;
            break;

        case CR3BPSystemType::SunJupiter:
            sys.name = "Sun-Jupiter";
            sys.mu1 = MU_SUN;
            sys.mu2 = MU_JUPITER;
            sys.L = 778570000.0;                    // Jupiter semi-major axis (km)
            sys.mu = sys.mu2 / (sys.mu1 + sys.mu2); // ~9.54e-4
            sys.T = std::sqrt(sys.L * sys.L * sys.L / (sys.mu1 + sys.mu2));
            sys.V = sys.L / sys.T;
            break;

        default:
            // Custom system - user must set parameters
            break;
    }

    return sys;
}

// -----------------------------------------------------------------------------
// Lagrange Points
// -----------------------------------------------------------------------------

/// Lagrange point identifier
enum class LagrangePointID {
    L1,     ///< Between primaries
    L2,     ///< Beyond secondary
    L3,     ///< Beyond primary
    L4,     ///< Leading equilateral
    L5      ///< Trailing equilateral
};

/// Lagrange point stability type
enum class LagrangeStability {
    Unstable,       ///< Saddle point (L1, L2, L3)
    Stable,         ///< Linearly stable (L4, L5 for mu < 0.0385)
    MarginalStable  ///< Marginally stable (L4, L5 for mu near 0.0385)
};

/// Lagrange point data
struct LagrangePoint {
    LagrangePointID id;
    Vec3 position;                      ///< Position in normalized rotating frame
    Vec3 positionDimensional;           ///< Position in dimensional units (km)
    double jacobi{0};                   ///< Jacobi constant at this point
    LagrangeStability stability{LagrangeStability::Unstable};

    // Eigenvalues for stability analysis (collinear points)
    double eigenReal{0};                ///< Real eigenvalue (saddle)
    double eigenImag{0};                ///< Imaginary eigenvalue (center)

    bool valid{false};
};

/// Collection of all 5 Lagrange points for a system
struct LagrangePointSet {
    CR3BPSystem system;
    LagrangePoint L1;
    LagrangePoint L2;
    LagrangePoint L3;
    LagrangePoint L4;
    LagrangePoint L5;
    bool valid{false};

    /// Get Lagrange point by ID
    const LagrangePoint& get(LagrangePointID id) const {
        switch (id) {
            case LagrangePointID::L1: return L1;
            case LagrangePointID::L2: return L2;
            case LagrangePointID::L3: return L3;
            case LagrangePointID::L4: return L4;
            case LagrangePointID::L5: return L5;
            default: return L1;
        }
    }
};

// -----------------------------------------------------------------------------
// CR3BP State and Jacobi Constant
// -----------------------------------------------------------------------------

/// CR3BP state in the rotating frame (normalized units)
struct CR3BPState {
    double x{0}, y{0}, z{0};            ///< Position (normalized)
    double xdot{0}, ydot{0}, zdot{0};   ///< Velocity (rotating frame, normalized)
    double t{0};                        ///< Time (normalized)

    Vec3 position() const { return Vec3(x, y, z); }
    Vec3 velocity() const { return Vec3(xdot, ydot, zdot); }

    /// Convert to 6-element array [x, y, z, xdot, ydot, zdot]
    std::array<double, 6> toArray() const {
        return {x, y, z, xdot, ydot, zdot};
    }

    /// Create from 6-element array
    static CR3BPState fromArray(const double* arr, double t_ = 0) {
        CR3BPState s;
        s.x = arr[0]; s.y = arr[1]; s.z = arr[2];
        s.xdot = arr[3]; s.ydot = arr[4]; s.zdot = arr[5];
        s.t = t_;
        return s;
    }
};

/// CR3BP propagation result
struct CR3BPPropagationResult {
    std::vector<CR3BPState> trajectory;     ///< State history
    std::vector<double> times;              ///< Time history (normalized)
    CR3BPState finalState;
    double jacobi{0};                       ///< Jacobi constant (should be conserved)
    double jacobiError{0};                  ///< Maximum Jacobi constant deviation
    int steps{0};
    bool valid{false};
};

// -----------------------------------------------------------------------------
// Periodic Orbits
// -----------------------------------------------------------------------------

/// Periodic orbit family type
enum class PeriodicOrbitFamily {
    Lyapunov,           ///< Planar Lyapunov orbit (around L1, L2, L3)
    HaloNorthern,       ///< Northern halo orbit (L1, L2)
    HaloSouthern,       ///< Southern halo orbit (L1, L2)
    VerticalLyapunov,   ///< Vertical Lyapunov orbit
    AxialNorthern,      ///< Northern axial orbit
    AxialSouthern,      ///< Southern axial orbit
    DRO,                ///< Distant Retrograde Orbit
    NRHO                ///< Near-Rectilinear Halo Orbit
};

/// Periodic orbit initial conditions and properties
struct PeriodicOrbit {
    PeriodicOrbitFamily family;
    LagrangePointID librationPoint;         ///< Associated Lagrange point
    CR3BPState initialCondition;            ///< Initial state (x-axis crossing)

    // Orbital properties
    double period{0};                       ///< Orbital period (normalized)
    double periodDimensional{0};            ///< Orbital period (seconds)
    double jacobi{0};                       ///< Jacobi constant
    double amplitude{0};                    ///< Characteristic amplitude (normalized)

    // Stability
    double stabilityIndex{0};               ///< Stability index (eigenvalue magnitude)
    bool stable{false};                     ///< True if |stability index| <= 1
    std::array<double, 6> eigenvaluesReal;  ///< Real parts of eigenvalues
    std::array<double, 6> eigenvaluesImag;  ///< Imaginary parts of eigenvalues

    // Monodromy matrix (state transition matrix for one period)
    Mat6 monodromyMatrix;

    bool valid{false};
};

/// Halo orbit specific parameters
struct HaloOrbitParameters {
    LagrangePointID librationPoint{LagrangePointID::L1};
    bool northern{true};                    ///< true = northern, false = southern
    double Az{0};                           ///< Z-amplitude (normalized), or
    double amplitude{0};                    ///< Alternative: specify by amplitude
    int maxIterations{50};                  ///< Differential correction iterations
    double tolerance{1e-10};                ///< Convergence tolerance
};

/// Lyapunov orbit specific parameters
struct LyapunovOrbitParameters {
    LagrangePointID librationPoint{LagrangePointID::L1};
    double Ax{0};                           ///< X-amplitude from L-point (normalized)
    int maxIterations{50};
    double tolerance{1e-10};
};

/// Lissajous orbit parameters (quasi-periodic orbits)
struct LissajousOrbitParameters {
    LagrangePointID librationPoint{LagrangePointID::L1};
    double Ax{0};                           ///< In-plane amplitude (normalized)
    double Az{0};                           ///< Out-of-plane amplitude (normalized)
    double phaseDifference{0};              ///< Phase difference between in-plane and out-of-plane (radians)
    int maxIterations{50};
    double tolerance{1e-10};
};

/// Ballistic capture parameters
struct BallisticCaptureParameters {
    double targetOrbitRadius{0};            ///< Target orbit radius at secondary (normalized)
    double maxCaptureTime{10.0};            ///< Maximum capture time to search (normalized periods)
    double minJacobi{0};                    ///< Minimum Jacobi constant (for filtering)
    int numSearchPhases{36};                ///< Number of phases to search
};

/// Ballistic capture result
struct BallisticCaptureResult {
    CR3BPState captureState;                ///< State at capture (around secondary)
    std::vector<CR3BPState> trajectory;     ///< Capture trajectory
    double captureJacobi{0};                ///< Jacobi constant at capture
    double jacobi_L1{0};                    ///< L1 Jacobi constant (upper bound)
    double jacobi_L2{0};                    ///< L2 Jacobi constant (lower bound for permanent capture)
    double captureTime{0};                  ///< Time from departure to capture (normalized)
    double captureTimeDimensional{0};       ///< Time from departure to capture (seconds)
    bool isTemporary{false};                ///< True if temporary (can escape), false if permanent
    bool valid{false};
};

/// Differential correction result
struct DifferentialCorrectionResult {
    CR3BPState correctedIC;                 ///< Corrected initial conditions
    double period{0};                       ///< Computed period (normalized)
    double residual{0};                     ///< Final residual magnitude
    int iterations{0};                      ///< Iterations used
    bool converged{false};
};

// -----------------------------------------------------------------------------
// Invariant Manifolds
// -----------------------------------------------------------------------------

/// Manifold type
enum class ManifoldType {
    StablePositive,     ///< Stable manifold, +eigenvector direction
    StableNegative,     ///< Stable manifold, -eigenvector direction
    UnstablePositive,   ///< Unstable manifold, +eigenvector direction
    UnstableNegative    ///< Unstable manifold, -eigenvector direction
};

/// Single manifold arc (one trajectory on the manifold)
struct ManifoldArc {
    ManifoldType type;
    CR3BPState departure;                   ///< Departure state on periodic orbit
    double departurePhase{0};               ///< Phase on periodic orbit (0 to 2*pi)
    std::vector<CR3BPState> states;         ///< States along the arc
    std::vector<double> times;              ///< Times along the arc (normalized)
    double jacobi{0};                       ///< Jacobi constant
    bool valid{false};
};

/// Manifold computation parameters
struct ManifoldParameters {
    ManifoldType type{ManifoldType::UnstablePositive};
    double epsilon{1e-6};                   ///< Perturbation magnitude (normalized)
    double integrationTime{3.0};            ///< Integration time in orbital periods
    int numArcs{50};                        ///< Number of arcs to compute
    int statesPerArc{100};                  ///< States to record per arc
};

/// Complete manifold computation result
struct ManifoldResult {
    ManifoldType type;
    PeriodicOrbit sourceOrbit;              ///< Source periodic orbit
    std::vector<ManifoldArc> arcs;          ///< Individual manifold arcs
    Vec3 eigenvector;                       ///< Eigenvector used for perturbation
    double eigenvalue{0};                   ///< Associated eigenvalue
    bool valid{false};
};

// -----------------------------------------------------------------------------
// Low-Energy Transfers
// -----------------------------------------------------------------------------

/// Transfer type for CR3BP missions
enum class CR3BPTransferType {
    DirectHohmann,          ///< Direct Hohmann-like transfer
    ManifoldHeteroclinic,   ///< Heteroclinic connection via manifolds
    ManifoldHomoclinic,     ///< Homoclinic connection
    WeakStabilityBoundary,  ///< WSB / ballistic capture
    LowThrust,              ///< Low-thrust spiral
    Custom                  ///< User-defined
};

/// Low-energy transfer trajectory
struct LowEnergyTransfer {
    CR3BPTransferType type;
    CR3BPState departure;                   ///< Initial state
    CR3BPState arrival;                     ///< Target state

    // Transfer details
    double totalDeltaV{0};                  ///< Total delta-V (normalized)
    double totalDeltaVDimensional{0};       ///< Total delta-V (km/s)
    double transferTime{0};                 ///< Transfer time (normalized)
    double transferTimeDimensional{0};      ///< Transfer time (seconds)

    // Intermediate points/maneuvers
    std::vector<CR3BPState> waypoints;
    std::vector<Vec3> maneuvers;            ///< Delta-V vectors at each waypoint

    // Trajectory
    std::vector<CR3BPState> trajectory;

    bool valid{false};
};

/// WSB (Weak Stability Boundary) transfer parameters
struct WSBTransferParameters {
    CR3BPState departureState;              ///< Departure from Earth vicinity
    LagrangePointID targetRegion;           ///< L1 or L2 region
    double targetJacobi{0};                 ///< Target Jacobi constant
    bool useLunarGravityAssist{false};      ///< Use Moon gravity assist
    double maxTransferTime{0};              ///< Maximum transfer time (normalized)
    int maxIterations{100};
    double tolerance{1e-8};
};

// -----------------------------------------------------------------------------
// CR3BP State Transition Matrix
// -----------------------------------------------------------------------------

/// CR3BP State Transition Matrix (STM) computation result
struct CR3BPSTM {
    Mat6 stm;                               ///< 6x6 state transition matrix
    CR3BPState initialState;
    CR3BPState finalState;
    double t0{0};                           ///< Initial time
    double tf{0};                           ///< Final time
    bool valid{false};
};

// =============================================================================
// Phase 11.7.2: Lambert & Transfer Mechanics Types
// =============================================================================

// -----------------------------------------------------------------------------
// Extended Lambert Problem Types
// -----------------------------------------------------------------------------

/// Lambert multi-revolution solution set
struct LambertMultiRevSolutions {
    std::vector<LambertSolution> shortWay;  ///< Short-way (prograde) solutions
    std::vector<LambertSolution> longWay;   ///< Long-way (retrograde) solutions
    int maxRevolutions{0};                  ///< Maximum revolutions computed
    bool valid{false};
};

// -----------------------------------------------------------------------------
// Porkchop Plot Types
// -----------------------------------------------------------------------------

/// Single point on a porkchop plot
struct PorkchopPoint {
    double launchDate{0};                   ///< Launch date (JD)
    double arrivalDate{0};                  ///< Arrival date (JD)
    double tof{0};                          ///< Time of flight (days)

    Vec3 vDepature;                         ///< Departure velocity (km/s)
    Vec3 vArrival;                          ///< Arrival velocity (km/s)

    double vInfLaunch{0};                   ///< V-infinity at launch (km/s)
    double vInfArrival{0};                  ///< V-infinity at arrival (km/s)
    double c3Launch{0};                     ///< C3 at launch (km^2/s^2)
    double c3Arrival{0};                    ///< C3 at arrival (km^2/s^2)
    double totalDeltaV{0};                  ///< Total delta-V (km/s)

    int revolutions{0};                     ///< Number of revolutions
    bool valid{false};
};

/// Porkchop plot generation parameters
struct PorkchopParameters {
    Vec3 departureBody;                     ///< Departure body position (km)
    Vec3 arrivalBody;                       ///< Arrival body position (km)

    double launchDateStart{0};              ///< Launch window start (JD)
    double launchDateEnd{0};                ///< Launch window end (JD)
    double launchDateStep{1.0};             ///< Launch date step (days)

    double arrivalDateStart{0};             ///< Arrival window start (JD)
    double arrivalDateEnd{0};               ///< Arrival window end (JD)
    double arrivalDateStep{1.0};            ///< Arrival date step (days)

    double minTOF{30.0};                    ///< Minimum TOF (days)
    double maxTOF{500.0};                   ///< Maximum TOF (days)
    double maxC3{50.0};                     ///< Maximum C3 constraint (km^2/s^2)

    double mu{MU_SUN};                      ///< Gravitational parameter
    int maxRevolutions{0};                  ///< Maximum Lambert revolutions
};

/// Porkchop plot result
struct PorkchopResult {
    std::vector<double> launchDates;        ///< Launch date grid points
    std::vector<double> arrivalDates;       ///< Arrival date grid points
    std::vector<std::vector<PorkchopPoint>> grid;  ///< 2D grid of results

    size_t numLaunchDates{0};               ///< Number of launch dates
    size_t numArrivalDates{0};              ///< Number of arrival dates
    int numValidPoints{0};                  ///< Number of valid points computed

    PorkchopPoint optimalC3;                ///< Minimum C3 point
    PorkchopPoint optimalDeltaV;            ///< Minimum delta-V point
    PorkchopPoint optimalTOF;               ///< Minimum TOF point

    bool valid{false};
};

// -----------------------------------------------------------------------------
// Gravity Assist Types
// -----------------------------------------------------------------------------

/// Gravity assist body enumeration
enum class GravityAssistBody {
    Earth,
    Moon,
    Venus,
    Mars,
    Jupiter,
    Saturn,
    Uranus,
    Neptune,
    Custom
};

/// Gravity assist body parameters
struct GravityAssistParameters {
    GravityAssistBody body{GravityAssistBody::Earth};
    double bodyMu{MU_EARTH};                ///< Body gravitational parameter (km^3/s^2)
    double bodyRadius{RE_EARTH};            ///< Body radius (km)
    double minAltitude{200.0};              ///< Minimum flyby altitude (km)
    double maxAltitude{100000.0};           ///< Maximum flyby altitude (km)
    double atmosphereHeight{100.0};         ///< Atmospheric height limit (km)
    Vec3 bodyPosition;                      ///< Body position in heliocentric frame (km)
    Vec3 bodyVelocity;                      ///< Body velocity in heliocentric frame (km/s)
};

/// Gravity assist geometry
struct GravityAssistGeometry {
    Vec3 vInfIn;                            ///< Incoming V-infinity vector (km/s)
    Vec3 vInfOut;                           ///< Outgoing V-infinity vector (km/s)
    double vInfMag{0};                      ///< V-infinity magnitude (km/s)
    double turnAngle{0};                    ///< Turn angle (rad)
    double periapsisRadius{0};              ///< Periapsis radius (km)
    double periapsisAltitude{0};            ///< Periapsis altitude (km)
    double eccentricity{0};                 ///< Hyperbolic eccentricity
    double semiMajorAxis{0};                ///< Semi-major axis (km, negative for hyperbola)
    double bParameter{0};                   ///< Impact parameter (km)
    bool valid{false};
};

/// Gravity assist computation result
struct GravityAssistResult {
    GravityAssistGeometry geometry;

    // Delta-V breakdown
    double deltaVmagnitude{0};              ///< Change in velocity magnitude (km/s)
    double deltaVdirection{0};              ///< Change in velocity direction (rad)

    // Flyby parameters
    double periapsisVelocity{0};            ///< Velocity at periapsis (km/s)
    double flybyTime{0};                    ///< Time in sphere of influence (s)
    double soiRadius{0};                    ///< Sphere of influence radius (km)
    double timeOfFlight{0};                 ///< Time in sphere of influence (s)

    // Energy analysis
    double energyGain{0};                   ///< Orbital energy gain (km^2/s^2)
    double c3Change{0};                     ///< Change in C3 (km^2/s^2)

    // Heliocentric velocities
    Vec3 vHelioIn;                          ///< Incoming heliocentric velocity (km/s)
    Vec3 vHelioOut;                         ///< Outgoing heliocentric velocity (km/s)
    double deltaVEquivalent{0};             ///< Equivalent delta-V from flyby (km/s)
    Vec3 periapsisPosition;                 ///< Position at periapsis (km)

    bool feasible{true};                    ///< True if flyby is feasible
    bool valid{false};
};

/// Powered gravity assist (with periapsis burn)
struct PoweredGravityAssist {
    GravityAssistResult unpowered;          ///< Unpowered flyby result

    double burnDeltaV{0};                   ///< Periapsis burn magnitude (km/s)
    Vec3 burnDirection;                     ///< Burn direction (unit vector)

    Vec3 vInfOutPowered;                    ///< Outgoing V-infinity with burn (km/s)
    double turnAnglePowered{0};             ///< Effective turn angle with burn (rad)

    double totalDeltaV{0};                  ///< Total delta-V cost (km/s)
    double oberth_efficiency{0};            ///< Oberth effect efficiency factor

    // Extended parameters
    double vInfOutMag{0};                   ///< Outgoing V-infinity magnitude (km/s)
    double periapsisDeltaV{0};              ///< Delta-V at periapsis (km/s)
    Vec3 periapsisBurnDirection;            ///< Periapsis burn direction (unit vector)

    bool valid{false};
};

// =============================================================================
// Conversion Functions (inline for header-only convenience)
// =============================================================================

// Convert Keplerian to Cartesian
inline StateVector keplerianToCartesian(const KeplerianElements& kep) {
    double p = kep.a * (1.0 - kep.e * kep.e);
    double r = p / (1.0 + kep.e * std::cos(kep.nu));

    // Position in perifocal frame
    double cosNu = std::cos(kep.nu);
    double sinNu = std::sin(kep.nu);
    Vec3 r_pqw(r * cosNu, r * sinNu, 0.0);

    // Velocity in perifocal frame
    double sqrtMuP = std::sqrt(kep.mu / p);
    Vec3 v_pqw(-sqrtMuP * sinNu, sqrtMuP * (kep.e + cosNu), 0.0);

    // Rotation angles
    double cosRaan = std::cos(kep.raan);
    double sinRaan = std::sin(kep.raan);
    double cosArgp = std::cos(kep.argp);
    double sinArgp = std::sin(kep.argp);
    double cosInc = std::cos(kep.i);
    double sinInc = std::sin(kep.i);

    // Rotation matrix PQW -> IJK
    Mat3 R;
    R.m[0][0] = cosRaan * cosArgp - sinRaan * sinArgp * cosInc;
    R.m[0][1] = -cosRaan * sinArgp - sinRaan * cosArgp * cosInc;
    R.m[0][2] = sinRaan * sinInc;
    R.m[1][0] = sinRaan * cosArgp + cosRaan * sinArgp * cosInc;
    R.m[1][1] = -sinRaan * sinArgp + cosRaan * cosArgp * cosInc;
    R.m[1][2] = -cosRaan * sinInc;
    R.m[2][0] = sinArgp * sinInc;
    R.m[2][1] = cosArgp * sinInc;
    R.m[2][2] = cosInc;

    return StateVector(R * r_pqw, R * v_pqw, kep.epoch);
}

// Convert Cartesian to Keplerian
inline KeplerianElements cartesianToKeplerian(const StateVector& state, double mu = MU_EARTH) {
    KeplerianElements kep;
    kep.mu = mu;
    kep.epoch = state.epoch;

    Vec3 r = state.position;
    Vec3 v = state.velocity;
    double rmag = r.magnitude();
    double vmag = v.magnitude();

    // Angular momentum
    Vec3 h = r.cross(v);
    double hmag = h.magnitude();

    // Node vector
    Vec3 n(-h.y, h.x, 0.0);
    double nmag = n.magnitude();

    // Eccentricity vector
    Vec3 e_vec = ((vmag*vmag - mu/rmag) * r - r.dot(v) * v) / mu;
    kep.e = e_vec.magnitude();

    // Semi-major axis
    double energy = vmag*vmag/2.0 - mu/rmag;
    if (std::abs(kep.e - 1.0) > 1e-10) {
        kep.a = -mu / (2.0 * energy);
    } else {
        kep.a = std::numeric_limits<double>::infinity(); // Parabolic
    }

    // Inclination
    kep.i = std::acos(h.z / hmag);

    // RAAN
    if (nmag > 1e-10) {
        kep.raan = std::acos(n.x / nmag);
        if (n.y < 0) kep.raan = TWO_PI - kep.raan;
    } else {
        kep.raan = 0.0;
    }

    // Argument of periapsis
    if (kep.e > 1e-10) {
        if (nmag > 1e-10) {
            // Standard case: use node vector
            kep.argp = std::acos(n.dot(e_vec) / (nmag * kep.e));
            if (e_vec.z < 0) kep.argp = TWO_PI - kep.argp;
        } else {
            // Equatorial orbit: measure argp from x-axis (vernal equinox)
            kep.argp = std::atan2(e_vec.y, e_vec.x);
            if (kep.argp < 0) kep.argp += TWO_PI;
        }
    } else {
        kep.argp = 0.0;
    }

    // True anomaly
    if (kep.e > 1e-10) {
        // Eccentric orbit: measure from periapsis
        double cosNu = e_vec.dot(r) / (kep.e * rmag);
        // Clamp to avoid numerical issues with acos
        cosNu = std::max(-1.0, std::min(1.0, cosNu));
        kep.nu = std::acos(cosNu);
        if (r.dot(v) < 0) kep.nu = TWO_PI - kep.nu;
    } else {
        // Circular orbit
        if (nmag > 1e-10) {
            // Inclined circular: measure from ascending node
            kep.nu = std::acos(n.dot(r) / (nmag * rmag));
            if (r.z < 0) kep.nu = TWO_PI - kep.nu;
        } else {
            // Equatorial circular: measure from x-axis (true longitude)
            kep.nu = std::atan2(r.y, r.x);
            if (kep.nu < 0) kep.nu += TWO_PI;
        }
    }

    return kep;
}

// Solve Kepler's equation (mean anomaly to eccentric anomaly)
inline double solveKeplerEquation(double M, double e, double tol = 1e-12, int maxIter = 50) {
    // Normalize mean anomaly
    M = std::fmod(M, TWO_PI);
    if (M < 0) M += TWO_PI;

    // Initial guess
    double E = (e < 0.8) ? M : PI;

    // Newton-Raphson iteration
    for (int i = 0; i < maxIter; i++) {
        double f = E - e * std::sin(E) - M;
        double fp = 1.0 - e * std::cos(E);
        double dE = -f / fp;
        E += dE;
        if (std::abs(dE) < tol) break;
    }

    return E;
}

// Mean anomaly from Keplerian elements
inline double KeplerianElements::meanAnomaly() const {
    double E = eccentricAnomaly();
    return E - e * std::sin(E);
}

// Eccentric anomaly from Keplerian elements
inline double KeplerianElements::eccentricAnomaly() const {
    double cosNu = std::cos(nu);
    double sinNu = std::sin(nu);
    double E = std::atan2(std::sqrt(1.0 - e*e) * sinNu, e + cosNu);
    if (E < 0) E += TWO_PI;
    return E;
}

// =============================================================================
// Phase 11.3: Navigation & State Estimation Types
// =============================================================================

// -----------------------------------------------------------------------------
// 11.3.1 Navigation Filters
// -----------------------------------------------------------------------------

/// Navigation filter type enumeration
enum class NavFilterType {
    SimpleNav,              ///< Truth + noise navigation (testing)
    EKF,                    ///< Extended Kalman Filter
    UKF,                    ///< Unscented Kalman Filter
    SquareRootEKF,          ///< Numerically stable EKF (Cholesky)
    SquareRootUKF,          ///< Numerically stable UKF (Cholesky)
    SRIF,                   ///< Square Root Information Filter
    SunLineEKF,             ///< Sun vector estimation EKF
    HeadingSuKF,            ///< Heading estimation (scaled UKF)
    OkeefeEKF,              ///< O'Keefe CSS-based filter
    InertialUKF,            ///< Inertial attitude estimation UKF
    RelativeODuKF,          ///< Relative orbit determination UKF
    OrbitDetermination      ///< Full orbit determination filter
};

/// Dynamic state vector with variable dimension (max 12 states)
struct KalmanState {
    static constexpr int MAX_STATE_DIM = 12;
    static constexpr int MAX_MEAS_DIM = 6;

    int stateDim{6};                                    ///< State dimension (3-12)
    double x[MAX_STATE_DIM] = {};                       ///< State vector
    double P[MAX_STATE_DIM][MAX_STATE_DIM] = {};        ///< Covariance matrix

    // Square root factors (for SREKF/SRUKF)
    double S[MAX_STATE_DIM][MAX_STATE_DIM] = {};        ///< Cholesky factor of P (P = S*S^T)
    bool useSqrt{false};                                ///< True if using square root form

    double epoch{0};                                    ///< State epoch (JD)
    bool valid{false};

    /// Get state as Vec3 (position)
    Vec3 position() const { return Vec3(x[0], x[1], x[2]); }

    /// Get state as Vec3 (velocity)
    Vec3 velocity() const { return stateDim >= 6 ? Vec3(x[3], x[4], x[5]) : Vec3(); }

    /// Set state from StateVector
    void fromStateVector(const StateVector& sv) {
        stateDim = 6;
        x[0] = sv.position.x; x[1] = sv.position.y; x[2] = sv.position.z;
        x[3] = sv.velocity.x; x[4] = sv.velocity.y; x[5] = sv.velocity.z;
        epoch = sv.epoch;
        valid = true;
    }

    /// Convert to StateVector
    StateVector toStateVector() const {
        return StateVector(position(), velocity(), epoch);
    }
};

/// EKF configuration
struct EKFConfig {
    int stateDim{6};                                    ///< State dimension
    int measDim{3};                                     ///< Measurement dimension

    // Process noise (Q matrix diagonal elements)
    double Q[KalmanState::MAX_STATE_DIM] = {};          ///< Process noise variances
    double processNoisePSD{1e-10};                      ///< Process noise PSD (km^2/s^3)

    // Measurement noise (R matrix diagonal elements)
    double R[KalmanState::MAX_MEAS_DIM] = {};           ///< Measurement noise variances

    // Numerical settings
    double minCovariance{1e-16};                        ///< Minimum covariance eigenvalue
    double maxCovariance{1e10};                         ///< Maximum covariance eigenvalue
    int maxIterations{10};                              ///< Max iterations for iterated EKF

    // Square root form settings
    bool useSquareRoot{false};                          ///< Use Cholesky factorization
    bool forceSymmetric{true};                          ///< Force P symmetric each update

    // State propagation
    double gravityMu{MU_EARTH};                         ///< Gravitational parameter
    bool useJ2{true};                                   ///< Include J2 perturbation
};

/// UKF configuration (sigma point parameters)
struct UKFConfig {
    int stateDim{6};                                    ///< State dimension (n)
    int measDim{3};                                     ///< Measurement dimension (m)

    // Van der Merwe scaling parameters
    double alpha{1e-3};                                 ///< Spread of sigma points (1e-4 to 1)
    double beta{2.0};                                   ///< Prior distribution (2 for Gaussian)
    double kappa{0.0};                                  ///< Secondary scaling (often 3-n or 0)

    // Derived parameters (computed from alpha, beta, kappa)
    double lambda{0};                                   ///< lambda = alpha^2*(n+kappa) - n
    double gamma{0};                                    ///< gamma = sqrt(n+lambda)
    double Wm0{0};                                      ///< Mean weight for sigma point 0
    double Wc0{0};                                      ///< Covariance weight for sigma point 0
    double Wmi{0};                                      ///< Mean weight for sigma points 1..2n
    double Wci{0};                                      ///< Covariance weight for sigma points 1..2n

    // Process and measurement noise
    double Q[KalmanState::MAX_STATE_DIM] = {};          ///< Process noise variances
    double R[KalmanState::MAX_MEAS_DIM] = {};           ///< Measurement noise variances

    // Square root form
    bool useSquareRoot{false};                          ///< Use SR-UKF

    // State propagation
    double gravityMu{MU_EARTH};
    bool useJ2{true};

    /// Compute derived parameters from alpha, beta, kappa
    void computeWeights() {
        double n = static_cast<double>(stateDim);
        lambda = alpha * alpha * (n + kappa) - n;
        gamma = std::sqrt(n + lambda);
        Wm0 = lambda / (n + lambda);
        Wc0 = Wm0 + (1.0 - alpha * alpha + beta);
        Wmi = 1.0 / (2.0 * (n + lambda));
        Wci = Wmi;
    }
};

/// SRIF configuration (Square Root Information Filter)
struct SRIFConfig {
    int stateDim{6};
    int measDim{3};

    // Information matrix factors
    double processNoiseInfoInv{1e10};                   ///< 1/sigma^2 for process noise

    // Measurement information
    double measurementInfoSqrt{100.0};                  ///< sqrt(1/sigma^2) for measurements

    // Householder vs Givens rotations
    bool useHouseholder{true};                          ///< Use Householder QR (faster)
};

/// Filter measurement structure
struct FilterMeasurement {
    static constexpr int MAX_MEAS_DIM = 6;

    int dim{1};                                         ///< Measurement dimension
    double z[MAX_MEAS_DIM] = {};                        ///< Observation vector
    double R[MAX_MEAS_DIM] = {};                        ///< Measurement noise variance (diagonal)
    double H[MAX_MEAS_DIM][KalmanState::MAX_STATE_DIM] = {};  ///< Observation matrix

    double epoch{0};                                    ///< Measurement time (JD)
    bool valid{false};

    // Measurement type for specialized processing
    enum class Type {
        Position,           ///< Position measurement (GPS-like)
        Velocity,           ///< Velocity measurement
        Range,              ///< Range to station
        RangeRate,          ///< Range rate (Doppler)
        Angles,             ///< Azimuth + Elevation
        RangeAngles,        ///< Range + Az + El
        SunVector,          ///< Sun sensor measurement
        StarTracker,        ///< Attitude quaternion
        Custom              ///< Custom measurement model
    } type{Type::Position};

    /// Create position measurement
    static FilterMeasurement fromPosition(const Vec3& pos, double sigma) {
        FilterMeasurement m;
        m.dim = 3;
        m.z[0] = pos.x; m.z[1] = pos.y; m.z[2] = pos.z;
        m.R[0] = m.R[1] = m.R[2] = sigma * sigma;
        // H is identity for direct position measurement
        m.H[0][0] = m.H[1][1] = m.H[2][2] = 1.0;
        m.type = Type::Position;
        m.valid = true;
        return m;
    }

    /// Create range measurement
    static FilterMeasurement fromRange(double range, const Vec3& /* stationPos */, double sigma) {
        FilterMeasurement m;
        m.dim = 1;
        m.z[0] = range;
        m.R[0] = sigma * sigma;
        m.type = Type::Range;
        m.valid = true;
        return m;
    }
};

/// Filter update result
struct FilterResult {
    KalmanState state;                                  ///< Updated state and covariance
    double innovation[KalmanState::MAX_MEAS_DIM] = {};  ///< Innovation (y = z - h(x))
    double innovationCov[KalmanState::MAX_MEAS_DIM][KalmanState::MAX_MEAS_DIM] = {};  ///< S = HPH' + R
    double NIS{0};                                      ///< Normalized Innovation Squared
    double chi2Threshold{0};                            ///< Chi-squared threshold for gating
    double K[KalmanState::MAX_STATE_DIM][KalmanState::MAX_MEAS_DIM] = {};  ///< Kalman gain
    int iterations{0};                                  ///< Iterations (for iterated EKF)
    bool accepted{false};                               ///< True if measurement passed gating
    bool valid{false};
};

/// UKF sigma points container
struct UKFSigmaPoints {
    static constexpr int MAX_STATE_DIM = KalmanState::MAX_STATE_DIM;
    static constexpr int MAX_SIGMA = 2 * MAX_STATE_DIM + 1;  ///< Max 2n+1 sigma points

    int n{6};                                           ///< State dimension
    int numPoints{0};                                   ///< Number of sigma points (2n+1)
    double chi[MAX_SIGMA][MAX_STATE_DIM] = {};          ///< Sigma points
    double gammaY[MAX_SIGMA][KalmanState::MAX_MEAS_DIM] = {};  ///< Propagated meas sigma points
    double Wm[MAX_SIGMA] = {};                          ///< Mean weights
    double Wc[MAX_SIGMA] = {};                          ///< Covariance weights
};

/// Specialized filter: Sun Line EKF
struct SunLineEKFState {
    Vec3 sunUnitVector;                                 ///< Estimated sun direction (body frame)
    Mat3 covariance;                                    ///< 3x3 covariance
    double sunDistance{AU_KM};                          ///< Distance to Sun (km)
    double epoch{0};
    bool valid{false};
};

/// Specialized filter: Heading/Attitude UKF state
struct HeadingUKFState {
    double heading{0};                                  ///< Heading angle (rad)
    double pitch{0};                                    ///< Pitch angle (rad)
    double roll{0};                                     ///< Roll angle (rad)
    double headingRate{0};                              ///< Heading rate (rad/s)
    double covariance[4][4] = {};                       ///< 4x4 covariance
    double epoch{0};
    bool valid{false};
};

/// Inertial UKF state (attitude estimation)
struct InertialUKFState {
    double q[4] = {1, 0, 0, 0};                         ///< Quaternion (w, x, y, z)
    Vec3 omega;                                         ///< Angular velocity (rad/s)
    Vec3 gyroBias;                                      ///< Gyro bias estimate (rad/s)
    double covariance[9][9] = {};                       ///< 9-state covariance
    double epoch{0};
    bool valid{false};
};

/// Relative orbit determination UKF state
struct RelativeODState {
    CWState relativeState;                              ///< Relative position/velocity (LVLH)
    double targetMass{1000.0};                          ///< Estimated target mass (kg)
    double covariance[7][7] = {};                       ///< 7-state covariance
    double epoch{0};
    bool valid{false};
};

// -----------------------------------------------------------------------------
// 11.3.2 Estimation Methods (from TudatPy)
// -----------------------------------------------------------------------------

/// Batch estimation configuration
struct BatchEstimationConfig {
    int maxIterations{10};                              ///< Maximum iterations
    double convergenceTol{1e-8};                        ///< Position convergence (km)
    double dampingLambda{0};                            ///< Levenberg-Marquardt damping
    bool useLevenbergMarquardt{false};                  ///< Use L-M damping
    bool estimateCovariance{true};                      ///< Compute formal covariance
    bool computeResiduals{true};                        ///< Compute observation residuals

    // Consider parameters
    bool useConsiderParameters{false};
    int numConsiderParams{0};
    double considerSigma[6] = {};                       ///< Consider parameter uncertainties
};

/// Sequential estimation configuration
struct SequentialEstimationConfig {
    double processNoisePSD{1e-12};                      ///< Process noise PSD (km^2/s^3)
    double measurementSigma{0.01};                      ///< Default measurement sigma (km)
    bool adaptiveProcessNoise{false};                   ///< Adaptive Q estimation
    bool residualMonitoring{true};                      ///< Monitor residual statistics
    double faultDetectionThreshold{5.0};                ///< Chi-squared fault threshold
};

/// Residual analysis result
struct ResidualAnalysis {
    int numObservations{0};
    double rmsPreFit{0};                                ///< RMS pre-fit residual
    double rmsPostFit{0};                               ///< RMS post-fit residual
    double meanResidual{0};                             ///< Mean residual
    double stdResidual{0};                              ///< Standard deviation
    double maxResidual{0};                              ///< Maximum absolute residual
    double wrss{0};                                     ///< Weighted residual sum of squares
    double chiSquared{0};                               ///< Chi-squared statistic
    int degreesOfFreedom{0};
    bool passedChiSquared{false};                       ///< True if chi^2 test passed
};

/// Maneuver estimation result
struct ManeuverEstimation {
    double epoch{0};                                    ///< Maneuver epoch (JD)
    Vec3 deltaV;                                        ///< Estimated delta-V (km/s)
    Vec3 deltaVSigma;                                   ///< Delta-V 1-sigma uncertainty
    double magnitude{0};                                ///< |deltaV| magnitude
    double magnitudeSigma{0};                           ///< Magnitude uncertainty
    bool detected{false};                               ///< True if maneuver detected
    double confidence{0};                               ///< Detection confidence (0-1)
};

/// Covariance realism analysis
struct CovarianceRealism {
    double scaleFactor{1.0};                            ///< Covariance scale factor
    double positionScale{1.0};                          ///< Position covariance scale
    double velocityScale{1.0};                          ///< Velocity covariance scale
    double consistencyMetric{0};                        ///< Consistency metric (~1 ideal)
    bool isRealistic{false};                            ///< True if covariance is realistic
};

// =============================================================================
// Phase 11.7.3: Entry, Descent & Landing (EDL) Types
// =============================================================================

// -----------------------------------------------------------------------------
// Planetary Body & Atmosphere Parameters
// -----------------------------------------------------------------------------

/// Planetary body parameters for EDL
struct PlanetaryBody {
    double mu{MU_EARTH};                                ///< Gravitational parameter (km^3/s^2)
    double radius{RE_EARTH};                            ///< Equatorial radius (km)
    double rotationRate{OMEGA_EARTH};                   ///< Rotation rate (rad/s)
    double scaleHeight{8.5};                            ///< Atmospheric scale height (km)
    double surfaceDensity{1.225};                       ///< Surface density (kg/m^3)
    double surfacePressure{101325.0};                   ///< Surface pressure (Pa)
    double surfaceTemp{288.15};                         ///< Surface temperature (K)
    double gamma{1.4};                                  ///< Specific heat ratio
    double gasConstant{287.0};                          ///< Gas constant (J/kg/K)
    std::string name{"Earth"};

    /// Pre-defined Earth
    static PlanetaryBody Earth() {
        PlanetaryBody p;
        p.name = "Earth";
        p.mu = MU_EARTH;
        p.radius = RE_EARTH;
        p.rotationRate = OMEGA_EARTH;
        p.scaleHeight = 8.5;
        p.surfaceDensity = 1.225;
        p.surfacePressure = 101325.0;
        p.surfaceTemp = 288.15;
        return p;
    }

    /// Pre-defined Mars
    static PlanetaryBody Mars() {
        PlanetaryBody p;
        p.name = "Mars";
        p.mu = MU_MARS;
        p.radius = 3389.5;
        p.rotationRate = 7.088e-5;
        p.scaleHeight = 11.1;
        p.surfaceDensity = 0.020;
        p.surfacePressure = 636.0;
        p.surfaceTemp = 210.0;
        p.gamma = 1.29;  // CO2 dominant
        p.gasConstant = 188.92;
        return p;
    }

    /// Pre-defined Venus
    static PlanetaryBody Venus() {
        PlanetaryBody p;
        p.name = "Venus";
        p.mu = MU_VENUS;
        p.radius = 6051.8;
        p.rotationRate = -2.99e-7;  // Retrograde
        p.scaleHeight = 15.9;
        p.surfaceDensity = 65.0;
        p.surfacePressure = 9.2e6;
        p.surfaceTemp = 737.0;
        p.gamma = 1.29;  // CO2 dominant
        p.gasConstant = 188.92;
        return p;
    }

    /// Pre-defined Titan
    static PlanetaryBody Titan() {
        PlanetaryBody p;
        p.name = "Titan";
        p.mu = 8978.14;
        p.radius = 2575.0;
        p.rotationRate = 4.56e-6;
        p.scaleHeight = 40.0;
        p.surfaceDensity = 5.3;
        p.surfacePressure = 146700.0;
        p.surfaceTemp = 94.0;
        p.gamma = 1.4;  // N2 dominant
        p.gasConstant = 296.8;
        return p;
    }
};

// -----------------------------------------------------------------------------
// Vehicle Configuration
// -----------------------------------------------------------------------------

/// EDL vehicle aerodynamic configuration
struct EDLVehicleConfig {
    double mass{2000.0};                                ///< Entry mass (kg)
    double dryMass{1000.0};                             ///< Dry mass without propellant (kg)
    double Cd{1.5};                                     ///< Drag coefficient
    double Cl{0.0};                                     ///< Lift coefficient
    double referenceArea{15.0};                         ///< Reference area (m^2)
    double noseRadius{2.0};                             ///< Nose radius for heating (m)

    double ballisticCoeff() const { return mass / (Cd * referenceArea); }
    double liftToDrag() const { return (Cd > 0) ? Cl / Cd : 0; }
};

/// Heat shield material types
enum class HeatShieldMaterial {
    PICA,               ///< Phenolic Impregnated Carbon Ablator
    SLA561V,            ///< Super Lightweight Ablator
    AVCOAT,             ///< Apollo-era ablator
    SIRCA,              ///< Silicone Impregnated Ceramic
    CarbonPhenolic,     ///< Carbon-phenolic
    Ceramic,            ///< Ceramic tiles
    Custom              ///< Custom material
};

/// Heat shield / TPS configuration
struct HeatShieldConfig {
    HeatShieldMaterial material{HeatShieldMaterial::PICA};
    double thickness{0.05};                             ///< Initial thickness (m)
    double surfaceArea{15.0};                           ///< Heat shield area (m^2)
    double density{265.0};                              ///< Material density (kg/m^3)
    double specificHeat{1260.0};                        ///< Specific heat (J/kg/K)
    double thermalConductivity{0.21};                   ///< Thermal conductivity (W/m/K)
    double emissivity{0.9};                             ///< Surface emissivity
    double ablationTemp{2500.0};                        ///< Ablation temperature (K)
    double heatOfAblation{1.8e7};                       ///< Heat of ablation (J/kg)
    double maxHeatRate{200.0};                          ///< Design max heat rate (W/cm^2)
    double maxHeatLoad{8000.0};                         ///< Design max heat load (J/cm^2)

    static HeatShieldConfig PICA() {
        HeatShieldConfig c;
        c.material = HeatShieldMaterial::PICA;
        c.density = 265.0; c.specificHeat = 1260.0;
        c.thermalConductivity = 0.21; c.emissivity = 0.9;
        c.ablationTemp = 2500.0; c.heatOfAblation = 1.8e7;
        c.maxHeatRate = 200.0; c.maxHeatLoad = 8000.0;
        return c;
    }

    static HeatShieldConfig SLA561V() {
        HeatShieldConfig c;
        c.material = HeatShieldMaterial::SLA561V;
        c.density = 256.0; c.specificHeat = 1047.0;
        c.thermalConductivity = 0.20; c.emissivity = 0.89;
        c.ablationTemp = 2000.0; c.heatOfAblation = 1.5e7;
        c.maxHeatRate = 100.0; c.maxHeatLoad = 5000.0;
        return c;
    }

    static HeatShieldConfig AVCOAT() {
        HeatShieldConfig c;
        c.material = HeatShieldMaterial::AVCOAT;
        c.density = 545.0; c.specificHeat = 1256.0;
        c.thermalConductivity = 0.23; c.emissivity = 0.92;
        c.ablationTemp = 3000.0; c.heatOfAblation = 2.5e7;
        c.maxHeatRate = 500.0; c.maxHeatLoad = 30000.0;
        return c;
    }
};

/// Parachute type enumeration
enum class ParachuteType {
    DiskGapBand,        ///< Disk-Gap-Band (Mars missions)
    Ringsail,           ///< Ringsail (Apollo heritage)
    Ribbon,             ///< Ribbon chute (drogue)
    Hemisflo,           ///< Hemisflo (supersonic)
    Parafoil,           ///< Steerable parafoil
    Ballute             ///< Inflatable ballute
};

/// Parachute configuration
struct ParachuteConfig {
    ParachuteType type{ParachuteType::DiskGapBand};
    double nominalDiameter{21.5};                       ///< Nominal diameter (m)
    double Cd{0.6};                                     ///< Drag coefficient
    double deployMach{2.0};                             ///< Deploy Mach number
    double deployAltitude{11.0};                        ///< Deploy altitude (km)
    double deployDynamicPressure{850.0};                ///< Deploy dynamic pressure (Pa)
    double inflationTime{2.0};                          ///< Inflation time (s)
    double maxLoad{80000.0};                            ///< Maximum design load (N)

    double area() const { return PI * nominalDiameter * nominalDiameter / 4.0; }

    static ParachuteConfig MarsDGB() {
        ParachuteConfig c;
        c.type = ParachuteType::DiskGapBand;
        c.nominalDiameter = 21.5; c.Cd = 0.6;
        c.deployMach = 2.0; c.deployAltitude = 11.0;
        c.deployDynamicPressure = 850.0; c.inflationTime = 2.5;
        c.maxLoad = 289000.0;
        return c;
    }

    static ParachuteConfig ApolloMain() {
        ParachuteConfig c;
        c.type = ParachuteType::Ringsail;
        c.nominalDiameter = 25.45; c.Cd = 0.825;
        c.deployMach = 0.3; c.deployAltitude = 3.0;
        c.deployDynamicPressure = 1500.0; c.inflationTime = 10.0;
        c.maxLoad = 66700.0;
        return c;
    }
};

/// Propulsion system for powered descent
struct PoweredDescentPropulsion {
    double maxThrust{17600.0};                          ///< Maximum thrust (N)
    double minThrust{1760.0};                           ///< Minimum throttleable thrust (N)
    double Isp{225.0};                                  ///< Specific impulse (s)
    double propellantMass{390.0};                       ///< Propellant mass (kg)
    int numEngines{4};                                  ///< Number of engines
    double cantAngle{0.0};                              ///< Engine cant angle (rad)

    double exhaustVelocity() const { return Isp * 9.80665; }

    static PoweredDescentPropulsion MSLSkyCrane() {
        PoweredDescentPropulsion c;
        c.maxThrust = 3100.0 * 8; c.minThrust = 700.0 * 8;
        c.Isp = 211.0; c.propellantMass = 390.0;
        c.numEngines = 8;
        return c;
    }

    static PoweredDescentPropulsion Falcon9() {
        PoweredDescentPropulsion c;
        c.maxThrust = 845000.0 * 3; c.minThrust = 282000.0;
        c.Isp = 282.0; c.propellantMass = 20000.0;
        c.numEngines = 3;
        return c;
    }
};

// -----------------------------------------------------------------------------
// EDL State & Trajectory
// -----------------------------------------------------------------------------

/// EDL phase enumeration
enum class EDLPhase {
    Cruise, EntryInterface, Hypersonic, Supersonic, Subsonic,
    ParachuteDescent, HeatShieldSep, BackshellSep,
    PoweredDescent, SkyCrane, Touchdown, Complete, Abort
};

/// EDL state vector
struct EDLState {
    Vec3 position;                                      ///< Position (km)
    Vec3 velocity;                                      ///< Velocity (km/s)
    double altitude{0};                                 ///< Altitude above reference (km)
    double latitude{0};                                 ///< Latitude (rad)
    double longitude{0};                                ///< Longitude (rad)
    double groundSpeed{0};                              ///< Ground-relative speed (km/s)
    double flightPathAngle{0};                          ///< Flight path angle (rad)
    double headingAngle{0};                             ///< Heading angle (rad)
    double machNumber{0};                               ///< Mach number
    double dynamicPressure{0};                          ///< Dynamic pressure (Pa)
    double density{0};                                  ///< Atmospheric density (kg/m^3)
    double gLoad{0};                                    ///< g-load (Earth g's)
    double heatRate{0};                                 ///< Convective heat rate (W/cm^2)
    double totalHeatLoad{0};                            ///< Integrated heat load (J/cm^2)
    double mass{0};                                     ///< Current mass (kg)
    double propellantRemaining{0};                      ///< Propellant remaining (kg)
    EDLPhase phase{EDLPhase::Cruise};
    double time{0};                                     ///< Time from entry interface (s)
    double epoch{0};                                    ///< Absolute epoch (JD)
    bool valid{false};
};

/// Complete EDL trajectory history
struct EDLTrajectory {
    std::vector<EDLState> states;                       ///< State history
    PlanetaryBody body;                                 ///< Target body
    EDLVehicleConfig vehicle;                           ///< Vehicle configuration
    HeatShieldConfig heatShield;                        ///< Heat shield config
    double peakGLoad{0};                                ///< Peak deceleration (g)
    double peakHeatRate{0};                             ///< Peak heat rate (W/cm^2)
    double totalHeatLoad{0};                            ///< Total heat load (J/cm^2)
    double peakDynamicPressure{0};                      ///< Peak dynamic pressure (Pa)
    double touchdownVelocity{0};                        ///< Final touchdown velocity (m/s)
    double totalDeltaV{0};                              ///< Total propulsive delta-V (km/s)
    double flightTime{0};                               ///< Total EDL time (s)
    bool successful{false};
};

// -----------------------------------------------------------------------------
// Aerobraking Configuration
// -----------------------------------------------------------------------------

/// Aerobraking corridor type
enum class AerobrakingCorridorType { Conservative, Nominal, Aggressive, WalkIn };

/// Aerobraking configuration
struct AerobrakingConfig {
    AerobrakingCorridorType corridorType{AerobrakingCorridorType::Nominal};
    double targetPeriapsis{100.0};                      ///< Target periapsis altitude (km)
    double targetApoapsis{400.0};                       ///< Target apoapsis altitude (km)
    double initialPeriapsis{150.0};                     ///< Initial periapsis altitude (km)
    double maxHeatRate{0.5};                            ///< Max heat rate limit (W/cm^2)
    double maxGLoad{0.2};                               ///< Max g-load limit
    double corridorWidth{10.0};                         ///< Corridor altitude band (km)
    int maxPasses{500};                                 ///< Maximum aerobraking passes
    double minApoapsisChange{5.0};                      ///< Minimum apoapsis change per pass (km)
};

/// Single aerobraking pass result
struct AerobrakingPass {
    int passNumber{0};
    double periapsisAltitude{0};
    double preApoapsis{0};
    double postApoapsis{0};
    double apoapsisChange{0};
    double peakHeatRate{0};
    double peakGLoad{0};
    double heatLoad{0};
    double passTime{0};
    bool valid{false};
};

/// Complete aerobraking result
struct AerobrakingResult {
    std::vector<AerobrakingPass> passes;
    KeplerianElements initialOrbit;
    KeplerianElements finalOrbit;
    double totalHeatLoad{0};
    double totalTime{0};
    double deltaVSaved{0};
    int totalPasses{0};
    bool successful{false};
};

// -----------------------------------------------------------------------------
// Aerocapture Configuration
// -----------------------------------------------------------------------------

/// Aerocapture guidance mode
enum class AerocaptureGuidance { FullLift, NumericPredictor, AnalyticalControl, BankAngle };

/// Aerocapture configuration
struct AerocaptureConfig {
    AerocaptureGuidance guidance{AerocaptureGuidance::BankAngle};
    double targetApoapsis{400.0};                       ///< Target apoapsis altitude (km)
    double targetPeriapsis{250.0};                      ///< Target periapsis altitude (km)
    double entryFlightPathAngle{-5.5};                  ///< Entry FPA (deg)
    double entryVelocity{5.5};                          ///< Entry velocity (km/s)
    double maxGLoad{5.0};                               ///< Max g-load constraint
    double maxHeatRate{100.0};                          ///< Max heat rate (W/cm^2)
    double exitFPATolerance{0.5};                       ///< Exit FPA tolerance (deg)
    double liftToDrag{0.3};                             ///< Vehicle L/D ratio
};

/// Aerocapture result
struct AerocaptureResult {
    EDLTrajectory trajectory;
    KeplerianElements capturedOrbit;
    double exitVelocity{0};
    double exitFPA{0};
    double peakGLoad{0};
    double peakHeatRate{0};
    double totalHeatLoad{0};
    double atmosphericTime{0};
    double periapsisRaiseManeuver{0};
    bool captured{false};
    bool overshoot{false};
    bool undershoot{false};
};

// -----------------------------------------------------------------------------
// Atmospheric Entry Configuration
// -----------------------------------------------------------------------------

/// Entry guidance mode
enum class EntryGuidanceMode { Ballistic, GuidedLift, BankAngle, DragModulation, NumericPredictor };

/// Atmospheric entry configuration
struct AtmosphericEntryConfig {
    EntryGuidanceMode guidance{EntryGuidanceMode::Ballistic};
    double entryAltitude{125.0};                        ///< Entry interface altitude (km)
    double entryVelocity{7.5};                          ///< Entry velocity (km/s)
    double entryFlightPathAngle{-1.5};                  ///< Entry FPA (deg)
    double targetLatitude{0};                           ///< Target landing latitude (rad)
    double targetLongitude{0};                          ///< Target landing longitude (rad)
    double maxGLoad{15.0};                              ///< Max allowable g-load
    double maxHeatRate{200.0};                          ///< Max allowable heat rate (W/cm^2)
    double landingAltitude{0};                          ///< Landing site altitude (km)
};

/// Atmospheric entry result
struct AtmosphericEntryResult {
    EDLTrajectory trajectory;
    double peakGLoad{0};
    double peakHeatRate{0};
    double totalHeatLoad{0};
    double peakDynamicPressure{0};
    double rangeToTarget{0};
    double crossRangeError{0};
    double terminalAltitude{0};
    double terminalVelocity{0};
    double terminalMach{0};
    double entryTime{0};
    bool successful{false};
};

// -----------------------------------------------------------------------------
// Parachute Descent Configuration
// -----------------------------------------------------------------------------

/// Parachute descent configuration
struct ParachuteDescentConfig {
    std::vector<ParachuteConfig> parachutes;
    double deployMach{2.0};
    double deployAltitude{12.0};
    double deployDynamicPressure{850.0};
    double heatShieldSeparationAltitude{8.0};
    double terminalVelocity{0.080};
};

/// Parachute descent result
struct ParachuteDescentResult {
    EDLTrajectory trajectory;
    double deployAltitude{0};
    double deployMach{0};
    double deployDynamicPressure{0};
    double openingShock{0};
    double steadyDescentRate{0};
    double descentTime{0};
    double terminalAltitude{0};
    double terminalVelocity{0};
    bool successful{false};
};

// -----------------------------------------------------------------------------
// Powered Descent Configuration
// -----------------------------------------------------------------------------

/// Powered descent guidance mode
enum class PoweredDescentGuidance { GravityTurn, PolynomialGuidance, OptimalFuel, GFold, ConstantThrottle };

/// Powered descent configuration
struct PoweredDescentConfig {
    PoweredDescentGuidance guidance{PoweredDescentGuidance::PolynomialGuidance};
    double ignitionAltitude{1.5};                       ///< Engine ignition altitude (km)
    double targetAltitude{0.020};                       ///< Target hover altitude (km)
    double targetVerticalVelocity{-0.001};              ///< Target vertical velocity (km/s)
    double targetHorizontalVelocity{0};                 ///< Target horizontal velocity (km/s)
    double constantDescentRate{0};                      ///< Constant descent rate if used (km/s)
    double hoverTime{0};                                ///< Hover duration (s)
    double maxTiltAngle{30.0 * DEG_TO_RAD};             ///< Max tilt from vertical (rad)
    double hazardDetectionAltitude{0.1};                ///< TRN starts (km)
};

/// Powered descent result
struct PoweredDescentResult {
    EDLTrajectory trajectory;
    double ignitionAltitude{0};
    double ignitionVelocity{0};
    double propellantUsed{0};
    double totalDeltaV{0};
    double touchdownVelocity{0};
    double touchdownTime{0};
    double horizontalError{0};
    double tiltAtTouchdown{0};
    bool successful{false};
    bool propellantExhausted{false};
};

// -----------------------------------------------------------------------------
// Skip Entry Configuration
// -----------------------------------------------------------------------------

/// Skip entry type
enum class SkipEntryType { SingleSkip, MultiSkip, SkipToOrbit, Equilibrium };

/// Skip entry configuration
struct SkipEntryConfig {
    SkipEntryType type{SkipEntryType::SingleSkip};
    double targetDownrange{5000.0};
    double targetCrossrange{0};
    double skipAltitude{60.0};
    double liftToDrag{0.3};
    double maxGLoad{4.0};
    int maxSkips{3};
};

/// Skip entry result
struct SkipEntryResult {
    EDLTrajectory trajectory;
    int numSkips{0};
    double totalRange{0};
    double finalDownrange{0};
    double finalCrossrange{0};
    double peakGLoad{0};
    double peakHeatRate{0};
    double totalHeatLoad{0};
    double skipApogee{0};
    bool successful{false};
    bool reachedTarget{false};
};

// -----------------------------------------------------------------------------
// Heat Shield / TPS Analysis
// -----------------------------------------------------------------------------

/// Heat shield state during entry
struct HeatShieldState {
    double surfaceTemperature{300.0};
    double backfaceTemperature{300.0};
    double ablationMass{0};
    double remainingThickness{0};
    double bondlineTemperature{300.0};
    double heatAbsorbed{0};
    double currentHeatRate{0};
    double integratedHeatLoad{0};
    bool bondlineExceeded{false};
    bool ablatedThrough{false};
};

/// Heat shield analysis result
struct HeatShieldResult {
    std::vector<HeatShieldState> history;
    double peakSurfaceTemp{0};
    double peakBackfaceTemp{0};
    double peakBondlineTemp{0};
    double totalAblationMass{0};
    double totalRecession{0};
    double peakHeatRate{0};
    double totalHeatLoad{0};
    double marginRemaining{0};
    bool structurallyAdequate{false};
};

// -----------------------------------------------------------------------------
// EDL Corridor Analysis
// -----------------------------------------------------------------------------

/// Entry corridor bounds
struct EDLCorridor {
    double nominalFPA{-5.5};
    double steepLimit{-6.5};
    double shallowLimit{-4.5};
    double steepGLimit{0};
    double shallowSkipAltitude{0};
    double corridorWidth{0};
    void computeWidth() { corridorWidth = steepLimit - shallowLimit; }
};

/// EDL corridor analysis result
struct EDLCorridorResult {
    EDLCorridor corridor;
    double steepLimitHeatLoad{0};
    double shallowLimitRange{0};
    double safetyMargin{0};
    std::vector<std::pair<double, double>> corridorProfile;
    bool viable{false};
};

}  // namespace astro
