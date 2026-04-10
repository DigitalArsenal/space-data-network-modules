// force_models.h - Phase 11.1.2 Force Models
// =============================================================================
// Phase 11: Astrodynamics Framework (Basilisk + TudatPy Port)
// Provides 18 force models for high-fidelity orbit propagation.
// =============================================================================

#pragma once

#include "astrodynamics_types.h"
#include <functional>

namespace astro {

// =============================================================================
// Force Model Namespace - Clean API for All 18 Force Models
// =============================================================================

namespace ForceModel {

// -----------------------------------------------------------------------------
// 1. Point Mass - Central Body Gravity
// -----------------------------------------------------------------------------

/// Point mass gravity acceleration (Keplerian two-body)
/// @param position Satellite position in body-centered frame (km)
/// @param mu Gravitational parameter (km^3/s^2)
/// @return Acceleration vector (km/s^2)
Vec3 PointMass(const Vec3& position, double mu = MU_EARTH);

// -----------------------------------------------------------------------------
// 2. Spherical Harmonics - J2-Jn Zonal/Tesseral
// -----------------------------------------------------------------------------

/// Spherical harmonics gravity configuration
struct SphericalHarmonicsConfig {
    double mu{MU_EARTH};            ///< Gravitational parameter (km^3/s^2)
    double referenceRadius{RE_EARTH}; ///< Reference radius (km)
    uint16_t maxDegree{20};         ///< Maximum degree (2-2190)
    uint16_t maxOrder{20};          ///< Maximum order (0 = zonal only)
    bool includeJ2{true};
    bool includeJ3{false};
    bool includeJ4{false};

    // Custom coefficients (if not using built-in)
    const double* Cnm{nullptr};     ///< Cosine coefficients array
    const double* Snm{nullptr};     ///< Sine coefficients array
};

/// Spherical harmonics gravity acceleration (J2-Jn zonal/tesseral)
/// @param position Satellite position (km)
/// @param config Spherical harmonics configuration
/// @return Acceleration vector (km/s^2)
Vec3 SphericalHarmonics(const Vec3& position, const SphericalHarmonicsConfig& config);

/// Convenience function for J2-only perturbation
Vec3 J2Only(const Vec3& position, double mu = MU_EARTH, double J2 = J2_EARTH, double Re = RE_EARTH);

/// J2-J4 zonal harmonics
Vec3 J2J4(const Vec3& position, double mu = MU_EARTH);

// -----------------------------------------------------------------------------
// 3. EGM2008 - Earth Gravitational Model 2008 (degree 2190)
// -----------------------------------------------------------------------------

/// EGM2008 gravity model configuration for ForceModel API
struct EGM2008ForceConfig {
    uint16_t truncationDegree{70};  ///< Truncation degree (2-2190)
    uint16_t truncationOrder{70};   ///< Truncation order (0-degree)
    bool normalized{true};          ///< Use normalized coefficients
    // Gate low-degree zonal terms from the EGM coefficient set so UI J2/J3/J4
    // toggles can still take effect in EGM mode.
    bool includeJ2{true};
    bool includeJ3{true};
    bool includeJ4{true};
};

/// EGM2008 Earth gravitational model (up to degree 2190)
/// @param position Satellite position in ECEF (km)
/// @param config EGM2008 configuration
/// @return Acceleration vector in ECEF (km/s^2)
Vec3 EGM2008(const Vec3& position, const EGM2008ForceConfig& config = EGM2008ForceConfig());

// -----------------------------------------------------------------------------
// 4. GRGM1200A - Lunar Gravity Model (degree 1200)
// -----------------------------------------------------------------------------

/// GRGM1200A configuration for ForceModel API
struct GRGM1200AForceConfig {
    uint16_t truncationDegree{100}; ///< Truncation degree (2-1200)
    uint16_t truncationOrder{100};  ///< Truncation order
    bool normalized{true};
};

/// GRGM1200A lunar gravity model (GRAIL-derived, degree 1200)
/// @param position Satellite position in Moon-centered frame (km)
/// @param config GRGM1200A configuration
/// @return Acceleration vector (km/s^2)
Vec3 GRGM1200A(const Vec3& position, const GRGM1200AForceConfig& config = GRGM1200AForceConfig());

// -----------------------------------------------------------------------------
// 5. Third Body - Sun/Moon/Planet Perturbations
// -----------------------------------------------------------------------------

/// Third body perturbation configuration
struct ThirdBodyPerturbConfig {
    bool includeSun{true};
    bool includeMoon{true};
    bool includeMercury{false};
    bool includeVenus{false};
    bool includeMars{false};
    bool includeJupiter{false};
    bool includeSaturn{false};
    bool includeUranus{false};
    bool includeNeptune{false};

    /// Use high-precision JPL DE ephemeris (else analytical approximations)
    bool useJPLEphemeris{false};
    JPLDEVersion ephemerisVersion{JPLDEVersion::Analytical};
};

/// Third body gravitational perturbations
/// @param satPosition Satellite position in geocentric frame (km)
/// @param jd Julian date (TDB)
/// @param config Third body configuration
/// @return Total third body acceleration (km/s^2)
Vec3 ThirdBody(const Vec3& satPosition, double jd, const ThirdBodyPerturbConfig& config = ThirdBodyPerturbConfig());

/// Third body acceleration from a single body
/// @param satPosition Satellite position (km)
/// @param bodyPosition Third body position (km, same frame)
/// @param muBody Third body GM (km^3/s^2)
/// @return Acceleration (km/s^2)
Vec3 ThirdBodySingle(const Vec3& satPosition, const Vec3& bodyPosition, double muBody);

// -----------------------------------------------------------------------------
// 6. Solar Radiation Pressure - Cannonball/Box-Wing
// -----------------------------------------------------------------------------

/// SRP model type
enum class SRPModelType {
    Cannonball,     ///< Simple spherical model
    FlatPlate,      ///< Single flat plate
    BoxWing,        ///< Box body + solar panels
    NPlate          ///< Multiple plates with orientations
};

/// Solar radiation pressure configuration
struct SRPForceConfig {
    SRPModelType model{SRPModelType::Cannonball};
    ShadowModelType shadowModel{ShadowModelType::Conical};

    double mass{1000.0};            ///< Spacecraft mass (kg)
    double area{10.0};              ///< Cross-sectional area (m^2)
    double Cr{1.5};                 ///< Reflectivity coefficient (1.0-2.0)

    // Box-wing parameters
    double busArea{5.0};            ///< Bus area (m^2)
    double solarPanelArea{20.0};    ///< Total solar panel area (m^2)
    double specularReflection{0.3}; ///< Specular reflection fraction
    double diffuseReflection{0.1};  ///< Diffuse reflection fraction
    double absorption{0.6};         ///< Absorption fraction
    bool sunTrackingPanels{true};   ///< Panels track Sun

    // Satellite attitude (for non-cannonball models)
    Vec3 sunPointingAxis{0, 0, 1};  ///< Body axis pointing toward Sun
};

/// Solar radiation pressure acceleration
/// @param satPosition Satellite position (km)
/// @param sunPosition Sun position (km, same frame)
/// @param config SRP configuration
/// @return SRP acceleration (km/s^2)
Vec3 SolarRadiation(const Vec3& satPosition, const Vec3& sunPosition,
                    const SRPForceConfig& config);

/// Cannonball SRP with shadow factor output
Vec3 SolarRadiationCannonball(const Vec3& satPosition, const Vec3& sunPosition,
                              double mass, double area, double Cr, double& shadowFactor);

// -----------------------------------------------------------------------------
// 7. Atmospheric Drag - Exponential/NRLMSISE-00
// -----------------------------------------------------------------------------

/// Drag model type
enum class DragModelType {
    Exponential,    ///< Simple exponential atmosphere
    USSA1976,       ///< US Standard Atmosphere 1976
    HarrisPriester, ///< Harris-Priester with diurnal bulge
    NRLMSISE00,     ///< NRLMSISE-00 empirical model
    JB2008,         ///< Jacchia-Bowman 2008
    DTM2020         ///< Drag Temperature Model 2020
};

/// Atmospheric drag configuration
struct DragForceConfig {
    DragModelType model{DragModelType::NRLMSISE00};

    double mass{1000.0};            ///< Spacecraft mass (kg)
    double area{10.0};              ///< Drag cross-section (m^2)
    double Cd{2.2};                 ///< Drag coefficient
    bool variableCd{false};         ///< Use altitude-dependent Cd

    double minAltitude{100.0};      ///< Minimum altitude for drag (km)
    double maxAltitude{2500.0};     ///< Maximum altitude for drag (km)

    bool includeWinds{false};       ///< Include horizontal winds
    bool coRotatingAtmosphere{true}; ///< Atmosphere co-rotates with Earth
};

/// Atmospheric drag acceleration
/// @param position Satellite position in ECEF or ECI (km)
/// @param velocity Satellite velocity in same frame (km/s)
/// @param jd Julian date (TDB)
/// @param weather Space weather data
/// @param config Drag configuration
/// @return Drag acceleration (km/s^2)
Vec3 AtmosphericDrag(const Vec3& position, const Vec3& velocity, double jd,
                     const SpaceWeatherData& weather, const DragForceConfig& config);

/// Simple exponential drag (convenience function)
Vec3 AtmosphericDragExponential(const Vec3& position, const Vec3& velocity,
                                double mass, double area, double Cd);

// -----------------------------------------------------------------------------
// 8. NRLMSISE-00 - Full Atmospheric Model
// -----------------------------------------------------------------------------

/// NRLMSISE-00 configuration
struct NRLMSISE00Config {
    bool includeO{true};            ///< Include atomic oxygen
    bool includeN2{true};           ///< Include molecular nitrogen
    bool includeO2{true};           ///< Include molecular oxygen
    bool includeHe{true};           ///< Include helium
    bool includeH{true};            ///< Include atomic hydrogen
    bool includeAr{true};           ///< Include argon
    bool includeAnomalousO{false};  ///< Include anomalous oxygen

    bool diurnalVariation{true};    ///< Include day/night variation
    bool geomagneticActivity{true}; ///< Include geomagnetic effects
};

/// NRLMSISE-00 atmospheric drag acceleration
/// @param position Satellite position (km)
/// @param velocity Satellite velocity (km/s)
/// @param jd Julian date
/// @param weather Space weather indices
/// @param dragConfig Drag configuration (mass, area, Cd)
/// @param nrlmsiseConfig NRLMSISE-00 specific settings
/// @return Drag acceleration (km/s^2)
Vec3 NRLMSISE00(const Vec3& position, const Vec3& velocity, double jd,
                const SpaceWeatherData& weather, const DragForceConfig& dragConfig,
                const NRLMSISE00Config& nrlmsiseConfig = NRLMSISE00Config());

/// Get NRLMSISE-00 density components
AtmosphericDensity NRLMSISE00Density(const Vec3& position, double jd,
                                     const SpaceWeatherData& weather,
                                     const NRLMSISE00Config& config = NRLMSISE00Config());

// -----------------------------------------------------------------------------
// 9. JB2008 - Jacchia-Bowman 2008
// -----------------------------------------------------------------------------

/// JB2008 configuration
struct JB2008Config {
    bool useDst{true};              ///< Use Dst geomagnetic index
    bool useS107{true};             ///< Use S10.7 solar index
    bool useM107{true};             ///< Use M10.7 MgII index
    bool useY107{true};             ///< Use Y10.7 Lyman-alpha index
};

/// Jacchia-Bowman 2008 atmospheric drag
/// @param position Satellite position (km)
/// @param velocity Satellite velocity (km/s)
/// @param jd Julian date
/// @param weather Space weather data with S10.7, M10.7, Y10.7
/// @param dragConfig Drag configuration
/// @param jb2008Config JB2008 specific settings
/// @return Drag acceleration (km/s^2)
Vec3 JB2008(const Vec3& position, const Vec3& velocity, double jd,
            const SpaceWeatherData& weather, const DragForceConfig& dragConfig,
            const JB2008Config& jb2008Config = JB2008Config());

/// Get JB2008 density
AtmosphericDensity JB2008Density(const Vec3& position, double jd,
                                 const SpaceWeatherData& weather,
                                 const JB2008Config& config = JB2008Config());

// -----------------------------------------------------------------------------
// 10. DTM2020 - Drag Temperature Model 2020
// -----------------------------------------------------------------------------

/// DTM2020 configuration
struct DTM2020Config {
    bool useF30{true};              ///< Use F30 (30 cm) solar index
    bool useKp{true};               ///< Use Kp geomagnetic index
    bool includeSemiAnnual{true};   ///< Include semi-annual variation
};

/// DTM2020 Drag Temperature Model
/// @param position Satellite position (km)
/// @param velocity Satellite velocity (km/s)
/// @param jd Julian date
/// @param weather Space weather data
/// @param dragConfig Drag configuration
/// @param dtmConfig DTM2020 specific settings
/// @return Drag acceleration (km/s^2)
Vec3 DTM2020(const Vec3& position, const Vec3& velocity, double jd,
             const SpaceWeatherData& weather, const DragForceConfig& dragConfig,
             const DTM2020Config& dtmConfig = DTM2020Config());

/// Get DTM2020 density
AtmosphericDensity DTM2020Density(const Vec3& position, double jd,
                                  const SpaceWeatherData& weather,
                                  const DTM2020Config& config = DTM2020Config());

// -----------------------------------------------------------------------------
// 11. Relativistic Correction - General Relativity Effects
// -----------------------------------------------------------------------------

/// Relativistic correction configuration
struct RelativisticConfig {
    bool schwarzschild{true};       ///< Schwarzschild (mass monopole)
    bool lenseThirring{false};      ///< Lense-Thirring (frame dragging)
    bool deSitter{false};           ///< de Sitter (geodetic precession)
    double c{SPEED_OF_LIGHT};       ///< Speed of light (km/s)
};

/// General relativistic corrections to orbit
/// @param position Satellite position (km)
/// @param velocity Satellite velocity (km/s)
/// @param jd Julian date (TDB) - needed for de Sitter (Sun position)
/// @param mu Central body GM (km^3/s^2)
/// @param config Relativistic configuration
/// @return Relativistic acceleration correction (km/s^2)
Vec3 RelativisticCorrection(const Vec3& position, const Vec3& velocity, double jd,
                            double mu = MU_EARTH, const RelativisticConfig& config = RelativisticConfig());

/// Schwarzschild relativistic correction only
Vec3 SchwarzschildCorrection(const Vec3& position, const Vec3& velocity, double mu = MU_EARTH);

// -----------------------------------------------------------------------------
// 12. Earth Albedo - Earth Radiation Pressure
// -----------------------------------------------------------------------------

/// Earth albedo configuration (Knocke model)
/// Reference: Knocke, Ries, Tapley (1988), "Earth radiation pressure
///   effects on satellites", AIAA/AAS Astrodynamics Conference
struct EarthAlbedoConfig {
    double solarFlux{1361.0};       ///< Solar constant at 1 AU (W/m^2)
    uint16_t gridResolution{18};    ///< Lat/lon grid cells per hemisphere (4-72)

    double mass{1000.0};            ///< Spacecraft mass (kg)
    double area{10.0};              ///< Cross-sectional area (m^2)
    double Cr{1.5};                 ///< Reflectivity coefficient

    // Knocke latitude-dependent model coefficients
    // α(ϕ) = a0 + a1·sin²(ϕ)   (albedo: poles brighter)
    // ε(ϕ) = e0 + e1·sin²(ϕ)   (emissivity: equator hotter)
    double a0{0.34};               ///< Mean albedo
    double a1{0.10};               ///< Albedo latitude variation
    double e0{0.68};               ///< Mean IR emissivity
    double e1{-0.07};              ///< Emissivity latitude variation
};

/// Earth albedo (reflected sunlight) and thermal radiation pressure
/// @param satPosition Satellite position in geocentric frame (km)
/// @param sunPosition Sun position (km)
/// @param config Earth albedo configuration
/// @return Albedo acceleration (km/s^2)
Vec3 EarthAlbedo(const Vec3& satPosition, const Vec3& sunPosition,
                 const EarthAlbedoConfig& config);

// -----------------------------------------------------------------------------
// 13. Thermal Reradiation - Yarkovsky-like Effect
// -----------------------------------------------------------------------------

/// Thermal reradiation configuration
struct ThermalReradiationConfig {
    double mass{1000.0};            ///< Spacecraft mass (kg)
    double thermalInertia{100.0};   ///< Thermal inertia (J/m^2/K/s^0.5)
    double surfaceArea{10.0};       ///< Total surface area (m^2)
    double emissivity{0.8};         ///< Surface emissivity
    double spinPeriod{0.0};         ///< Spin period (s, 0 = non-spinning)
    Vec3 spinAxis{0, 0, 1};         ///< Spin axis unit vector
};

/// Thermal reradiation acceleration (Yarkovsky-like effect)
/// @param satPosition Satellite position (km)
/// @param sunPosition Sun position (km)
/// @param config Thermal configuration
/// @return Thermal reradiation acceleration (km/s^2)
Vec3 ThermalReradiation(const Vec3& satPosition, const Vec3& sunPosition,
                        const ThermalReradiationConfig& config);

// -----------------------------------------------------------------------------
// 14. Solid Tides - Solid Earth Tides
// -----------------------------------------------------------------------------

/// Solid tide configuration - IERS 2010 Conventions
struct SolidTideConfig {
    double k20{0.30190};            ///< Love number k₂₀ (IERS 2010 Table 6.3)
    double k21{0.29830};            ///< Love number k₂₁
    double k22{0.30102};            ///< Love number k₂₂
    double k30{0.093};              ///< Love number k₃₀
    bool includeSunTide{true};      ///< Include solar tide
    bool includeMoonTide{true};     ///< Include lunar tide
    bool permanentTide{false};      ///< Include permanent tide deformation
    bool frequencyDependent{true};  ///< Include frequency-dependent corrections (Step 2)
};

/// Solid Earth tides acceleration perturbation
/// @param satPosition Satellite position (km)
/// @param jd Julian date
/// @param config Solid tide configuration
/// @return Solid tide acceleration (km/s^2)
Vec3 SolidTides(const Vec3& satPosition, double jd, const SolidTideConfig& config = SolidTideConfig());

// -----------------------------------------------------------------------------
// 15. Ocean Tides - Ocean Loading
// -----------------------------------------------------------------------------

/// Ocean tide configuration (FES2004 model)
struct OceanTideConfig {
    uint16_t maxDegree{20};         ///< Maximum spherical harmonic degree (FES2004: up to 100)
    bool includeM2{true};           ///< Principal lunar semidiurnal (Doodson 255.555)
    bool includeS2{true};           ///< Principal solar semidiurnal (Doodson 273.555)
    bool includeN2{true};           ///< Larger lunar elliptic (Doodson 245.655)
    bool includeK2{true};           ///< Lunisolar semidiurnal (Doodson 275.555)
    bool includeK1{true};           ///< Lunar-solar diurnal (Doodson 165.555)
    bool includeO1{true};           ///< Principal lunar diurnal (Doodson 145.555)
    bool includeP1{true};           ///< Principal solar diurnal (Doodson 163.555)
    bool includeQ1{true};           ///< Larger lunar elliptic diurnal (Doodson 135.655)
};

/// Ocean tides acceleration perturbation
/// @param satPosition Satellite position (km)
/// @param jd Julian date
/// @param config Ocean tide configuration
/// @return Ocean tide acceleration (km/s^2)
Vec3 OceanTides(const Vec3& satPosition, double jd, const OceanTideConfig& config = OceanTideConfig());

// -----------------------------------------------------------------------------
// 16. Pole Tide - Polar Motion Correction
// -----------------------------------------------------------------------------

/// Pole tide configuration
struct PoleTideConfig {
    double xp{0.0};                 ///< X polar motion (arcsec)
    double yp{0.0};                 ///< Y polar motion (arcsec)
    double xp_mean{0.054};          ///< Mean X polar motion (arcsec)
    double yp_mean{0.357};          ///< Mean Y polar motion (arcsec)
};

/// Pole tide (polar motion) acceleration correction
/// @param satPosition Satellite position (km)
/// @param config Pole tide configuration with current polar motion
/// @return Pole tide acceleration (km/s^2)
Vec3 PoleTide(const Vec3& satPosition, const PoleTideConfig& config);

// -----------------------------------------------------------------------------
// 17. Finite Maneuver - Continuous Thrust
// -----------------------------------------------------------------------------

/// Finite maneuver configuration
struct FiniteManeuverConfig {
    Vec3 thrustDirection{1, 0, 0};  ///< Thrust direction (body or inertial)
    double thrustMagnitude{0.0};    ///< Thrust force (N)
    double mass{1000.0};            ///< Current spacecraft mass (kg)
    double Isp{300.0};              ///< Specific impulse (s)
    double massFlowRate{0.0};       ///< Mass flow rate (kg/s), computed if 0

    bool inertialDirection{false};  ///< True if direction is inertial (else body)
    bool velocityAligned{false};    ///< Align thrust with velocity
    bool antiVelocity{false};       ///< Thrust opposite to velocity
    bool sunPointing{false};        ///< Thrust toward/away from Sun

    double startTime{0.0};          ///< Maneuver start (JD)
    double duration{0.0};           ///< Maneuver duration (s)
};

/// Finite (continuous) thrust maneuver acceleration
/// @param position Satellite position (km)
/// @param velocity Satellite velocity (km/s)
/// @param currentTime Current time (JD)
/// @param config Finite maneuver configuration
/// @return Thrust acceleration (km/s^2)
Vec3 FiniteManeuver(const Vec3& position, const Vec3& velocity, double currentTime,
                    const FiniteManeuverConfig& config);

/// Get mass change rate for finite maneuver
double FiniteManeuverMassRate(const FiniteManeuverConfig& config);

// -----------------------------------------------------------------------------
// 18. Impulsive Maneuver - Delta-V Events
// -----------------------------------------------------------------------------

/// Impulsive maneuver definition
struct ImpulsiveManeuverDef {
    double epoch{0.0};              ///< Maneuver epoch (JD)
    Vec3 deltaV{0, 0, 0};           ///< Delta-V vector (km/s)

    bool inRTN{true};               ///< Delta-V in RTN frame (else inertial)
    bool executed{false};           ///< Flag: has been executed

    double magnitude() const { return deltaV.magnitude(); }
};

/// Check if impulsive maneuver should be applied
/// @param currentTime Current time (JD)
/// @param previousTime Previous time (JD)
/// @param maneuver Maneuver definition
/// @return True if maneuver epoch is between previousTime and currentTime
bool ImpulsiveManeuverDue(double currentTime, double previousTime,
                          const ImpulsiveManeuverDef& maneuver);

/// Apply impulsive maneuver to velocity
/// @param velocity Current velocity (km/s)
/// @param position Current position (km) - needed for RTN conversion
/// @param maneuver Maneuver definition
/// @return Updated velocity after delta-V (km/s)
Vec3 ImpulsiveManeuver(const Vec3& velocity, const Vec3& position,
                       const ImpulsiveManeuverDef& maneuver);

/// Convert RTN delta-V to inertial
Vec3 RTNToInertial(const Vec3& deltaV_RTN, const Vec3& position, const Vec3& velocity);

// -----------------------------------------------------------------------------
// 19. Empirical Accelerations (RTN, constant/harmonic)
// -----------------------------------------------------------------------------

/// Empirical acceleration direction
enum class EmpiricalDirection : uint8_t {
    Radial,       ///< R: radial (along r̂)
    AlongTrack,   ///< T: along-track (along v̂, or tangential)
    CrossTrack,   ///< N: cross-track (r̂ × v̂)
    Inertial      ///< Fixed inertial direction
};

/// Empirical acceleration model type
enum class EmpiricalModel : uint8_t {
    Constant,     ///< a = C · d̂
    OncePerRev,   ///< a = (Cc·cos(u) + Cs·sin(u)) · d̂
    TwicePerRev   ///< a = (Cc·cos(2u) + Cs·sin(2u)) · d̂
};

/// Single empirical acceleration term
struct EmpiricalAccelTerm {
    EmpiricalDirection direction{EmpiricalDirection::AlongTrack};
    EmpiricalModel model{EmpiricalModel::Constant};
    double magnitude{0.0};      ///< Constant or bias (km/s²)
    double cosMagnitude{0.0};   ///< Cosine amplitude (km/s²) for harmonic models
    double sinMagnitude{0.0};   ///< Sine amplitude (km/s²) for harmonic models
    Vec3 inertialDir{1, 0, 0};  ///< Direction for Inertial mode
};

/// Empirical accelerations configuration (up to 8 terms)
struct EmpiricalAccelConfig {
    static constexpr int MAX_TERMS = 8;
    EmpiricalAccelTerm terms[MAX_TERMS];
    int numTerms{0};
};

/// Compute empirical acceleration
/// @param position Satellite position (km)
/// @param velocity Satellite velocity (km/s)
/// @param config Empirical acceleration configuration
/// @return Empirical acceleration (km/s²)
Vec3 EmpiricalAcceleration(const Vec3& position, const Vec3& velocity,
                            const EmpiricalAccelConfig& config);

// =============================================================================
// Combined Force Model Evaluation
// =============================================================================

/// Complete force model configuration (all 18 models)
struct ForceModelSet {
    // Gravity
    bool usePointMass{true};
    double mu{MU_EARTH};

    bool useSphericalHarmonics{false};
    SphericalHarmonicsConfig sphericalHarmonics;

    bool useEGM2008{false};
    EGM2008ForceConfig egm2008;

    bool useGRGM1200A{false};
    GRGM1200AForceConfig grgm1200a;

    // Third body
    bool useThirdBody{false};
    ThirdBodyPerturbConfig thirdBody;

    // Solar radiation
    bool useSRP{false};
    SRPForceConfig srp;

    // Atmospheric drag
    bool useDrag{false};
    DragForceConfig drag;
    DragModelType dragModel{DragModelType::NRLMSISE00};
    NRLMSISE00Config nrlmsise00;
    JB2008Config jb2008;
    DTM2020Config dtm2020;

    // Relativistic
    bool useRelativisticCorrection{false};
    RelativisticConfig relativistic;

    // Earth radiation
    bool useEarthAlbedo{false};
    EarthAlbedoConfig earthAlbedo;

    // Thermal
    bool useThermalReradiation{false};
    ThermalReradiationConfig thermal;

    // Tides
    bool useSolidTides{false};
    SolidTideConfig solidTides;

    bool useOceanTides{false};
    OceanTideConfig oceanTides;

    bool usePoleTide{false};
    PoleTideConfig poleTide;

    // Empirical accelerations
    bool useEmpiricalAccel{false};
    EmpiricalAccelConfig empiricalAccel;

    // Maneuvers
    bool hasFiniteManeuver{false};
    FiniteManeuverConfig finiteManeuver;

    // Current space weather
    SpaceWeatherData weather;

    // Current Sun position (computed internally if not provided)
    Vec3 sunPosition;
    bool sunPositionProvided{false};
};

/// Compute total acceleration from all enabled force models
/// @param position Satellite position (km)
/// @param velocity Satellite velocity (km/s)
/// @param jd Julian date (TDB)
/// @param forceSet Force model configuration
/// @return Total acceleration (km/s^2)
Vec3 ComputeTotalAcceleration(const Vec3& position, const Vec3& velocity, double jd,
                              ForceModelSet& forceSet);

/// Force model derivative function for numerical integration
/// @param t Time from epoch (seconds)
/// @param y State vector [rx, ry, rz, vx, vy, vz]
/// @param dydt Output derivatives [vx, vy, vz, ax, ay, az]
/// @param params Pointer to ForceModelSet
void ForceModelDerivative(double t, const double* y, double* dydt, void* params);

/// Create default LEO force model set
ForceModelSet CreateLEOForceModel(double mass = 1000.0, double area = 10.0);

/// Create default GEO force model set
ForceModelSet CreateGEOForceModel(double mass = 1000.0, double area = 10.0);

/// Create default cislunar force model set
ForceModelSet CreateCislunarForceModel(double mass = 1000.0, double area = 10.0);

/// Create high-fidelity force model set (all perturbations)
ForceModelSet CreateHighFidelityForceModel(double mass = 1000.0, double area = 10.0);

} // namespace ForceModel

} // namespace astro
