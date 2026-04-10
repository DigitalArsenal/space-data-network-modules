// environment_models.h - Phase 8.6 Environment Models
// =============================================================================
// High-fidelity environment models for precision orbit determination and
// propagation. Implements EGM2008, GRGM1200A, JPL ephemerides, SRP,
// advanced atmosphere models, and space weather integration.
// =============================================================================

#ifndef ORBPRO2_ENVIRONMENT_MODELS_H
#define ORBPRO2_ENVIRONMENT_MODELS_H

#include "astrodynamics_types.h"
#include <vector>
#include <array>
#include <cmath>
#include <memory>

namespace astro {

// =============================================================================
// 8.6.1 High-Fidelity Gravity Field Models
// =============================================================================

/// Maximum degree for high-fidelity gravity models
/// EGM2008 supports up to degree 2190, but we limit for performance
constexpr int MAX_GRAVITY_DEGREE = 360;

/// Extended gravity field coefficients for high-degree models
struct ExtendedGravityField {
    GravityModelType model{GravityModelType::EGM2008};
    double mu{MU_EARTH};           ///< Gravitational parameter (km^3/s^2)
    double referenceRadius{RE_EARTH}; ///< Reference radius (km)
    uint16_t maxDegree{0};         ///< Maximum degree loaded
    uint16_t maxOrder{0};          ///< Maximum order loaded
    bool normalized{true};         ///< Coefficients are fully normalized

    /// Dynamic coefficient storage for high degrees
    std::vector<std::vector<double>> Cnm;  ///< Cosine coefficients C_nm
    std::vector<std::vector<double>> Snm;  ///< Sine coefficients S_nm

    /// Initialize storage for specified degree/order
    void allocate(uint16_t degree, uint16_t order) {
        maxDegree = degree;
        maxOrder = order;
        Cnm.resize(degree + 1);
        Snm.resize(degree + 1);
        for (uint16_t n = 0; n <= degree; n++) {
            Cnm[n].resize(std::min(static_cast<uint16_t>(n + 1), static_cast<uint16_t>(order + 1)), 0.0);
            Snm[n].resize(std::min(static_cast<uint16_t>(n + 1), static_cast<uint16_t>(order + 1)), 0.0);
        }
    }

    /// Get coefficient with bounds checking
    double getC(int n, int m) const {
        if (n < 0 || n > maxDegree || m < 0 || m > n || m > maxOrder) return 0.0;
        return Cnm[n][m];
    }

    double getS(int n, int m) const {
        if (n < 0 || n > maxDegree || m < 0 || m > n || m > maxOrder) return 0.0;
        return Snm[n][m];
    }
};

/// EGM2008 gravity model configuration
struct EGM2008Config {
    uint16_t maxDegree{70};        ///< Maximum degree (up to 2190)
    uint16_t maxOrder{70};         ///< Maximum order (up to 2190)
    bool useSecularDrift{false};   ///< Include time-varying C20, C21, S21
    double referenceEpoch{0.0};    ///< Reference epoch for drift (JD)

    /// C20 drift rate (per year)
    double C20DotRate{1.16275534e-11};
    /// C21 drift rate (per year)
    double C21DotRate{-0.337e-11};
    /// S21 drift rate (per year)
    double S21DotRate{1.606e-11};
};

/// GRGM1200A lunar gravity model configuration
struct GRGM1200AConfig {
    uint16_t maxDegree{100};       ///< Maximum degree (up to 1200)
    uint16_t maxOrder{100};        ///< Maximum order (up to 1200)
    bool includeGRACE{true};       ///< Include GRAIL refinements
};

/// Initialize EGM2008 extended gravity field
/// @param config Configuration for degree/order and drift
/// @return Extended gravity field with coefficients
ExtendedGravityField initEGM2008Extended(const EGM2008Config& config);

/// Initialize GRGM1200A lunar gravity field
/// @param config Configuration for degree/order
/// @return Extended gravity field with lunar coefficients
ExtendedGravityField initGRGM1200AExtended(const GRGM1200AConfig& config);

/// Compute gravity acceleration using extended field
/// Uses Pines recursion for numerical stability at high degrees
/// @param position ECEF position (km)
/// @param field Extended gravity field
/// @param jd Julian date for time-varying terms
/// @return Gravity acceleration breakdown
GravityAcceleration computeExtendedGravity(
    const Vec3& position,
    const ExtendedGravityField& field,
    double jd = 0.0);

/// Legendre function computation using Pines recursion
/// @param position ECEF position (km)
/// @param maxDegree Maximum degree to compute
/// @param maxOrder Maximum order to compute
/// @param V Output: Pines V functions
/// @param W Output: Pines W functions
void computePinesLegendre(
    const Vec3& position,
    double referenceRadius,
    int maxDegree,
    int maxOrder,
    std::vector<std::vector<double>>& V,
    std::vector<std::vector<double>>& W);

/// Gravity gradient tensor computation
/// Returns 3x3 symmetric tensor of gravity gradients
/// @param position ECEF position (km)
/// @param field Extended gravity field
/// @return Gravity gradient tensor (3x3)
Mat3 computeGravityGradient(
    const Vec3& position,
    const ExtendedGravityField& field);

// =============================================================================
// 8.6.2 JPL Development Ephemeris (DE) Interface
// =============================================================================

/// JPL DE file header information
struct JPLDEHeader {
    JPLDEVersion version{JPLDEVersion::DE440};
    double startJD{0.0};           ///< Start Julian Date
    double endJD{0.0};             ///< End Julian Date
    double blockInterval{32.0};    ///< Days per block
    int numCoefficients{0};        ///< Coefficients per block
    double au{149597870.7};        ///< AU in km
    double emrat{81.30056};        ///< Earth/Moon mass ratio

    /// GM values for planets (km^3/s^2)
    std::array<double, 11> gm;
};

/// JPL DE Chebyshev coefficient block
struct JPLDEBlock {
    double startJD{0.0};           ///< Block start epoch
    double endJD{0.0};             ///< Block end epoch

    /// Chebyshev coefficients for each body
    /// Index: [body][component][coefficient]
    std::vector<std::vector<std::vector<double>>> coefficients;

    /// Number of coefficients per component for each body
    std::array<int, 15> numCoeffs;

    /// Number of subintervals for each body
    std::array<int, 15> numSubintervals;
};

/// JPL DE ephemeris reader/cache
class JPLDEReader {
public:
    /// Load DE file
    /// @param filename Path to DE binary file
    /// @param version Expected DE version
    /// @return true if loaded successfully
    bool load(const std::string& filename, JPLDEVersion version);

    /// Check if epoch is within file validity
    bool isValidEpoch(double jd) const;

    /// Get body state (position and velocity)
    /// @param body Target body
    /// @param jd Julian date (TDB)
    /// @param center Center body (default: Earth)
    /// @return Ephemeris state
    EphemerisState getState(CelestialBody body, double jd,
                            CelestialBody center = CelestialBody::Earth) const;

    /// Get header information
    const JPLDEHeader& getHeader() const { return header_; }

    /// Check if loaded
    bool isLoaded() const { return loaded_; }

private:
    JPLDEHeader header_;
    std::vector<JPLDEBlock> blocks_;
    bool loaded_{false};

    /// Evaluate Chebyshev polynomial
    Vec3 evaluateChebyshev(const std::vector<double>& coeffsX,
                           const std::vector<double>& coeffsY,
                           const std::vector<double>& coeffsZ,
                           double normalizedTime) const;
};

/// Third body perturbation with DE ephemeris
/// @param satPosition Satellite GCRS position (km)
/// @param config Third body configuration
/// @param jd Julian date (TDB)
/// @param deReader JPL DE reader (optional, uses analytical if null)
/// @return Third body acceleration breakdown
ThirdBodyAcceleration computeThirdBodyDE(
    const Vec3& satPosition,
    const ThirdBodyConfig& config,
    double jd,
    const JPLDEReader* deReader = nullptr);

// =============================================================================
// 8.6.3 Solar Radiation Pressure - Extended Models
// =============================================================================

/// N-plate SRP model for complex spacecraft
struct NPlateSRPConfig {
    /// Individual plate definition
    struct Plate {
        Vec3 normal;               ///< Outward normal in body frame
        double area{0.0};          ///< Plate area (m^2)
        double specularCoeff{0.0}; ///< Specular reflection coefficient
        double diffuseCoeff{0.0};  ///< Diffuse reflection coefficient
        double absorptionCoeff{1.0}; ///< Absorption coefficient
        bool isSolarPanel{false};  ///< True if this is a sun-tracking panel
    };

    std::vector<Plate> plates;     ///< All plates
    double mass{1000.0};           ///< Spacecraft mass (kg)
    ShadowModelType shadowModel{ShadowModelType::Conical};
};

/// SRP acceleration using N-plate model
/// @param satPosition Satellite GCRS position (km)
/// @param sunPosition Sun GCRS position (km)
/// @param bodyToDcm DCM from body to inertial frame
/// @param config N-plate configuration
/// @return SRP acceleration with detailed breakdown
SRPAcceleration computeSRPNPlate(
    const Vec3& satPosition,
    const Vec3& sunPosition,
    const Mat3& bodyToDcm,
    const NPlateSRPConfig& config);

/// Radiation pressure coefficient estimation
/// @param area Cross-sectional area (m^2)
/// @param mass Spacecraft mass (kg)
/// @param surfaceType Surface type for default optical properties
/// @return Estimated Cr coefficient
double estimateCr(double area, double mass, const std::string& surfaceType);

/// Eclipse transitions with accurate timing
struct EclipseEvent {
    double epochEntry{0.0};        ///< Entry epoch (JD)
    double epochExit{0.0};         ///< Exit epoch (JD)
    double duration{0.0};          ///< Eclipse duration (seconds)
    bool isUmbra{false};           ///< True if umbra, false if penumbra only
    CelestialBody occultingBody{CelestialBody::Earth};
};

/// Find eclipse events over time span
/// @param initialState Initial satellite state
/// @param startJD Start epoch
/// @param endJD End epoch
/// @param dtSearch Search time step (seconds)
/// @return Vector of eclipse events
std::vector<EclipseEvent> findEclipseEvents(
    const StateVector& initialState,
    double startJD,
    double endJD,
    double dtSearch = 60.0);

// =============================================================================
// 8.6.4 Advanced Atmosphere Models
// =============================================================================

/// NRLMSISE-00 complete configuration
struct NRLMSISE00Config {
    /// Input flags following NRLMSISE-00 convention
    struct Flags {
        bool useF107{true};        ///< Use F10.7 input
        bool useAp{true};          ///< Use Ap input
        bool useDailyAp{false};    ///< Use daily Ap history
        bool utEffects{true};      ///< UT/longitudinal effects
        bool timeIndep{false};     ///< Time independent (average)
        bool symmetrical{false};   ///< Symmetrical annual
        bool anomOxygen{true};     ///< Anomalous oxygen
    };

    Flags flags;
    double minAltitude{0.0};       ///< Minimum altitude (km)
    double maxAltitude{2500.0};    ///< Maximum altitude (km)
};

/// DTM2020 operational mode
enum class DTM2020Mode {
    Operational,    ///< Default operational mode
    Research,       ///< Research mode with full model
    Storm           ///< Storm-time correction mode
};

/// JB2008 extended configuration
struct JB2008ExtendedConfig {
    bool useDSTEffect{true};       ///< Use Dst storm effects
    bool useSolarIndices{true};    ///< Use S10.7, M10.7, Y10.7
    double minAltitude{90.0};      ///< Minimum altitude (km)
    double maxAltitude{2500.0};    ///< Maximum altitude (km)
};

/// Compute NRLMSISE-00 with full output
/// @param position ECEF position (km)
/// @param jd Julian date
/// @param weather Space weather data
/// @param config Model configuration
/// @return Detailed atmospheric density output
AtmosphericDensity computeNRLMSISE00Full(
    const Vec3& position,
    double jd,
    const SpaceWeatherData& weather,
    const NRLMSISE00Config& config);

/// Compute DTM2020 atmosphere
/// @param position ECEF position (km)
/// @param jd Julian date
/// @param weather Space weather data
/// @param mode Operational mode
/// @return Atmospheric density output
AtmosphericDensity computeDTM2020Full(
    const Vec3& position,
    double jd,
    const SpaceWeatherData& weather,
    DTM2020Mode mode = DTM2020Mode::Operational);

/// Compute Jacchia-Bowman 2008 with extended indices
/// @param position ECEF position (km)
/// @param jd Julian date
/// @param weather Space weather data (must include S10.7, M10.7, Y10.7)
/// @param config Extended configuration
/// @return Atmospheric density output
AtmosphericDensity computeJB2008Extended(
    const Vec3& position,
    double jd,
    const SpaceWeatherData& weather,
    const JB2008ExtendedConfig& config);

/// Atmosphere model selector
/// Automatically selects best model for given altitude and requirements
/// @param position ECEF position (km)
/// @param jd Julian date
/// @param weather Space weather data
/// @param preferredModel Preferred model (may be overridden)
/// @return Atmospheric density from best available model
AtmosphericDensity computeBestAtmosphere(
    const Vec3& position,
    double jd,
    const SpaceWeatherData& weather,
    AtmosphereModelType preferredModel = AtmosphereModelType::NRLMSISE00);

// =============================================================================
// 8.6.5 Space Weather Integration
// =============================================================================

/// Space weather data source
enum class SpaceWeatherSource {
    NOAA_SWPC,      ///< NOAA Space Weather Prediction Center
    CACTUS,         ///< CACTus CME catalog
    OMNI,           ///< NASA OMNI database
    Manual          ///< Manual/user-provided
};

/// Extended space weather data with historical and forecast
struct SpaceWeatherTimeSeries {
    std::vector<SpaceWeatherData> observed;    ///< Historical observations
    std::vector<SpaceWeatherData> forecast;    ///< Forecast data
    SpaceWeatherSource source{SpaceWeatherSource::NOAA_SWPC};
    double lastUpdateJD{0.0};

    /// Get data for epoch (interpolates if needed)
    SpaceWeatherData getAtEpoch(double jd) const;

    /// Get 81-day F10.7 average
    double getF107A(double jd) const;

    /// Get Ap history for NRLMSISE-00
    std::array<double, 7> getApHistory(double jd) const;
};

/// Geomagnetic storm intensity level (NOAA G-scale)
enum class StormLevel : uint8_t {
    None = 0,       ///< No storm (Kp < 5)
    G1 = 1,         ///< Minor (Kp = 5)
    G2 = 2,         ///< Moderate (Kp = 6)
    G3 = 3,         ///< Strong (Kp = 7)
    G4 = 4,         ///< Severe (Kp = 8)
    G5 = 5          ///< Extreme (Kp = 9)
};

/// Classify geomagnetic storm level
/// @param weather Current space weather
/// @return Storm intensity level
StormLevel classifyStorm(const SpaceWeatherData& weather);

/// Solar cycle phase
enum class SolarCyclePhase {
    Minimum,        ///< Solar minimum
    Rising,         ///< Rising phase
    Maximum,        ///< Solar maximum
    Declining       ///< Declining phase
};

/// Estimate solar cycle phase from F10.7
/// @param f107 Current F10.7
/// @param f107a 81-day average F10.7
/// @return Estimated solar cycle phase
SolarCyclePhase estimateSolarPhase(double f107, double f107a);

/// Density scale factor for storm conditions
/// @param weather Space weather data
/// @param altitude Altitude (km)
/// @return Multiplicative scale factor for density
double stormDensityScaleFactor(const SpaceWeatherData& weather, double altitude);

/// Predict space weather indices
/// @param currentWeather Current space weather
/// @param hoursAhead Hours ahead to predict
/// @return Predicted space weather
SpaceWeatherData predictSpaceWeather(
    const SpaceWeatherData& currentWeather,
    double hoursAhead);

// =============================================================================
// Combined Environment Model
// =============================================================================

/// Full environment configuration
struct FullEnvironmentConfig {
    // Gravity
    bool useExtendedGravity{false};
    EGM2008Config egm2008Config;
    GRGM1200AConfig grgm1200aConfig;
    ExtendedGravityField earthField;
    ExtendedGravityField moonField;

    // Third body
    ThirdBodyConfig thirdBody;
    bool useJPLDE{false};
    std::shared_ptr<JPLDEReader> deReader;

    // SRP
    bool useSRP{true};
    SRPConfig srpConfig;
    NPlateSRPConfig nPlateConfig;
    bool useNPlate{false};

    // Atmosphere
    bool useDrag{true};
    AtmosphereModelType atmosphereModel{AtmosphereModelType::NRLMSISE00};
    DragConfig dragConfig;

    // Space weather
    SpaceWeatherTimeSeries weatherTimeSeries;
    SpaceWeatherConfig weatherConfig;
};

/// Compute total environment acceleration
/// @param state Current satellite state
/// @param jd Julian date (TDB)
/// @param config Full environment configuration
/// @return Total acceleration vector
Vec3 computeFullEnvironmentAcceleration(
    const StateVector& state,
    double jd,
    const FullEnvironmentConfig& config);

/// Detailed acceleration breakdown
struct AccelerationBreakdown {
    Vec3 total;                    ///< Total acceleration
    GravityAcceleration gravity;   ///< Gravity breakdown
    ThirdBodyAcceleration thirdBody; ///< Third body breakdown
    SRPAcceleration srp;           ///< SRP breakdown
    DragAccelerationResult drag;   ///< Drag breakdown
    Vec3 other;                    ///< Other perturbations

    double jd{0.0};                ///< Evaluation epoch
    bool valid{false};
};

/// Compute detailed acceleration breakdown
/// @param state Current satellite state
/// @param jd Julian date (TDB)
/// @param config Full environment configuration
/// @return Detailed acceleration breakdown
AccelerationBreakdown computeAccelerationBreakdown(
    const StateVector& state,
    double jd,
    const FullEnvironmentConfig& config);

} // namespace astro

#endif // ORBPRO2_ENVIRONMENT_MODELS_H
