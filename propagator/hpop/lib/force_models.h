// force_models.h - Phase 11.1.2 Force Models
// =============================================================================
// Phase 11: Astrodynamics Framework (Basilisk + TudatPy Port)
// Provides 18 force models for high-fidelity orbit propagation.
// =============================================================================

#pragma once

#include "astrodynamics_types.h"
#include "gnss_srp.h"
#include <functional>
#include <memory>

namespace astro {

/// A generic spherical-harmonic field of arbitrary degree, defined in
/// environment_models.h. Force models only ever hold one by handle.
struct ExtendedGravityField;

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
///
/// Every field here is HONORED. Until gmat-07 three of them were not:
/// `includeJ2/J3/J4` were never read (asking for "J2 only" silently returned a
/// J2-J6 field with degree-2/3/4 tesserals on top), and a non-null `Cnm`
/// only suppressed the built-in defaults without ever being copied, so a
/// caller-supplied field evaluated as all zeros. A selector that silently
/// answers with a different model is the defect this build item exists to
/// abolish; it is not confined to atmospheres.
struct SphericalHarmonicsConfig {
    double mu{MU_EARTH};            ///< Gravitational parameter (km^3/s^2)
    double referenceRadius{RE_EARTH}; ///< Reference radius (km)
    uint16_t maxDegree{20};         ///< Maximum degree (2-2190)
    uint16_t maxOrder{20};          ///< Maximum order (0 = zonal only)

    /// Zonal gates, OPT-OUT. A gated-off zonal is ABSENT from the evaluated
    /// field, not merely unrequested; this mirrors EGM2008ForceConfig's gates
    /// below so the two gravity paths cannot answer a UI toggle differently.
    ///
    /// They default ON because the natural content of a spherical-harmonic
    /// field of degree N is every zonal up to N — gating is the exception, and
    /// a caller that constructs this struct and sets only `maxDegree` means
    /// "the field to that degree". (The header previously declared J3 and J4
    /// OFF by default and then ignored all three, so the declared default was
    /// never the behavior anyone observed.)
    bool includeJ2{true};
    bool includeJ3{true};
    bool includeJ4{true};

    /// Zonals above degree 4 (J5, J6). Gated off when the caller asked for a
    /// closed zonal set; on for a general field.
    bool includeHigherZonals{true};

    /// Custom coefficients. Fully normalized, ROW-MAJOR, stride
    /// `GravityFieldCoefficients::MAX_INLINE_DEGREE + 1` (21), i.e.
    /// `Cnm[n * 21 + m]`. When non-null these REPLACE the built-in set
    /// entirely and the zonal gates above do not apply — the caller's field is
    /// the field. Both pointers must be supplied together.
    const double* Cnm{nullptr};     ///< Cosine coefficients array
    const double* Snm{nullptr};     ///< Sine coefficients array
    static constexpr int CUSTOM_STRIDE = 21;
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
/// The embedded Earth fields (degree 2-70 each): EGM2008 (lib/egm2008_data.h)
/// and EGM96 (lib/egm96_data.h).
enum class EmbeddedEarthField : uint8_t { EGM2008 = 0, EGM96 = 1 };

struct EGM2008ForceConfig {
    uint16_t truncationDegree{70};  ///< Truncation degree (2-2190)
    uint16_t truncationOrder{70};   ///< Truncation order (0-degree)
    /// Which embedded coefficient set (EGM2008 unless stated).
    EmbeddedEarthField field{EmbeddedEarthField::EGM2008};
    /// Highest degree kept for the tesseral and sectorial terms (order >= 1):
    /// a VCM's "mmZ,nnT" is truncationDegree mm, truncationOrder nn and
    /// maxTesseralDegree nn. The zonals run to truncationDegree.
    uint16_t maxTesseralDegree{UINT16_MAX};
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

/// EGM2008's harmonic terms alone (degree 2 up), scaled by the field's own GM:
/// the force set's EGM2008 mode adds its central term with the set's GM.
Vec3 EGM2008Harmonics(const Vec3& position, const EGM2008ForceConfig& config = EGM2008ForceConfig());

/// The embedded field `config` selects, truncated as it states (degree,
/// order, tesseral degree), cached until the selection changes. Shared by the
/// force evaluation and its partials (force_partials.cpp).
const ExtendedGravityField& EmbeddedEarthGravityField(const EGM2008ForceConfig& config);

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
    NPlate,         ///< Multiple plates with orientations
    GnssBoxWing     ///< GNSS box-wing in nominal yaw steering (lib/gnss_srp.h)
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

    /// GnssBoxWing: the surfaces (gnss_srp::GpsBoxWing for a GPS block).
    gnss_srp::BoxWing gnssBoxWing;
    /// CODE's extended empirical model, added to the model above under the
    /// same shadow when enabled (Cannonball with Cr 0 leaves it alone).
    gnss_srp::Ecom2 ecom2;
};

/// Solar radiation pressure acceleration
/// @param satPosition Satellite position (km)
/// @param satVelocity Satellite velocity (km/s; ECOM2's orbital plane)
/// @param sunPosition Sun position (km, same frame)
/// @param config SRP configuration
/// @return SRP acceleration (km/s^2)
Vec3 SolarRadiation(const Vec3& satPosition, const Vec3& satVelocity, const Vec3& sunPosition,
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
    DTM2020,        ///< Drag Temperature Model 2020
    JacchiaRoberts  ///< Jacchia-Roberts (Roberts 1971, J71 constants; lib/jacchia_roberts.h)
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

    bool includeWinds{false};       ///< Include HWM14 horizontal winds
    bool windDisturbance{true};     ///< Add DWM07 storm-time winds (needs weather.kp3h)
    bool coRotatingAtmosphere{true}; ///< Atmosphere co-rotates with Earth
};

/// The atmosphere model a drag setting names.
/// `DragModelType` and `AtmosphereModelType` do NOT share an ordering; casting
/// between them silently selected a different model for every value from 2 up.
AtmosphereModelType AtmosphereModelForDrag(DragModelType model);

/// Harris-Priester drag acceleration.
/// @param position Satellite position, GCRF (km)
/// @param velocity Satellite velocity, GCRF (km/s)
/// @param jd Julian date (TDB), for the Sun direction that sets the bulge
/// @param dragConfig Ballistic properties and atmosphere-relative velocity flags
/// @param bulgeExponent Cosine exponent (2 low inclination, 6 polar)
/// @param weather Space weather for HWM14 winds (needed only when includeWinds)
/// @param windJdUtc UTC Julian date for the winds; 0 uses jd
/// @return Drag acceleration (km/s^2)
struct EarthAxes;
Vec3 HarrisPriester(const Vec3& position, const Vec3& velocity, double jd,
                    const DragForceConfig& dragConfig, double bulgeExponent = 4.0,
                    const SpaceWeatherData* weather = nullptr, double windJdUtc = 0.0,
                    const EarthAxes* axes = nullptr);

/// GCRF -> Earth-fixed axes at one instant: the rotation the density models,
/// the co-rotating atmosphere and the gravity field share within one force
/// evaluation (EarthAxesAt). The drag functions below take it as `axes`; with
/// none they fall back to GmstAxes at their UTC `jd`.
struct EarthAxes {
    double m[3][3]{{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};  ///< GCRF -> Earth-fixed
    Vec3 fixed(const Vec3& gcrf) const;               ///< GCRF -> Earth-fixed
    Vec3 inertial(const Vec3& earthFixed) const;      ///< Earth-fixed -> GCRF
    Vec3 spin() const;                                ///< Earth-fixed z axis, in GCRF
};

/// GMST about the GCRF z axis: no precession, nutation or polar motion.
EarthAxes GmstAxes(double jdUt);

/// GCRF position (km) re-expressed by GmstAxes(jdUt).
Vec3 EarthFixedForDensity(const Vec3& gcrf, double jdUt);

/// Atmospheric drag acceleration
/// @param position Satellite position, GCRF (km)
/// @param velocity Satellite velocity, GCRF (km/s)
/// @param jd Julian date (TDB)
/// @param weather Space weather data
/// @param config Drag configuration
/// @return Drag acceleration (km/s^2)
Vec3 AtmosphericDrag(const Vec3& position, const Vec3& velocity, double jd,
                     const SpaceWeatherData& weather, const DragForceConfig& config,
                     const EarthAxes* axes = nullptr);

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
/// @param position Satellite position, GCRF (km)
/// @param velocity Satellite velocity, GCRF (km/s)
/// @param jd Julian date
/// @param weather Space weather indices
/// @param dragConfig Drag configuration (mass, area, Cd)
/// @param nrlmsiseConfig NRLMSISE-00 specific settings
/// @return Drag acceleration (km/s^2)
Vec3 NRLMSISE00(const Vec3& position, const Vec3& velocity, double jd,
                const SpaceWeatherData& weather, const DragForceConfig& dragConfig,
                const NRLMSISE00Config& nrlmsiseConfig = NRLMSISE00Config(),
                const EarthAxes* axes = nullptr);

/// Get NRLMSISE-00 density components at a GCRF position (km)
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
            const JB2008Config& jb2008Config = JB2008Config(),
            const EarthAxes* axes = nullptr);

/// JB2008 (Bowman et al. 2008; lib/jb2008.h, ported from Orekit 13.1) mass
/// density (kg/m^3) at a GCRF position (km): geodetic WGS84 position and
/// the true Sun in the given Earth-fixed axes, the Sun at TDB jdTdb, the
/// model's UTC from jdUtc, drivers from `weather` (F107/F107a, S107/S107a,
/// M107/M107a, Y107/Y107a, lagged as JB2008 prescribes, and dTc = DSTDTC).
double JB2008DensityAt(const Vec3& position, double jdTdb, double jdUtc,
                       const EarthAxes& axes, const SpaceWeatherData& weather);

/// Jacchia-Roberts (lib/jacchia_roberts.h, ported from NASA
/// GMAT) mass density (kg/m^3) at a GCRF position (km): WGS84 geodetic
/// height and latitude, the point and the true Sun in the given Earth-fixed
/// axes, UTC from jdUtc; drivers from `weather`: F10.7 of the previous day
/// (F107), the 81-day centred average of the previous day (f107aPreviousDay,
/// else F107a) and Kp 6.7 h earlier (kpLag67h, else Kp).
double JacchiaRobertsDensityAt(const Vec3& position, double jdTdb, double jdUtc,
                          const EarthAxes& axes, const SpaceWeatherData& weather);

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
             const DTM2020Config& dtmConfig = DTM2020Config(),
             const EarthAxes* axes = nullptr);

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
/// @param axes Earth-fixed axes whose z is the Lense-Thirring spin axis
///        (GCRF z when null)
/// @return Relativistic acceleration correction (km/s^2)
Vec3 RelativisticCorrection(const Vec3& position, const Vec3& velocity, double jd,
                            double mu = MU_EARTH, const RelativisticConfig& config = RelativisticConfig(),
                            const EarthAxes* axes = nullptr);

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

/// Solid Earth tides, IERS Conventions (2010) section 6.2: the changes to
/// the fully normalized geopotential of degrees 2-4 raised by the Sun and the
/// Moon (step 1, eqs. 6.6 and 6.7, with Table 6.3's anelastic Love numbers
/// including their imaginary parts and k+), and the frequency dependence of
/// k20, k21 and k22 (step 2, eq. 6.8, Tables 6.5a-c; lib/iers2010_tides.h).
/// The Sun and Moon are placed in the force set's Earth-fixed axes
/// (EarthAxesAt) and step 2 reads GMST from the force set's UT1 (jdUt1At).
/// Pole tide is separate (PoleTide).
struct SolidTideConfig {
    bool includeSunTide{true};      ///< Include solar tide
    bool includeMoonTide{true};     ///< Include lunar tide
    bool frequencyDependent{true};  ///< Include frequency-dependent corrections (Step 2)
    /// The central field is zero-tide (its C20 already holds the permanent
    /// tide): remove 4.4228e-8 * -0.31460 * k20 from dC20 (IERS 2010 eq.
    /// 6.13 and section 6.2.2). EGM2008, HPOP's field, is tide-free: false.
    bool zeroTideField{false};
};

struct ForceModelSet;

/// The IERS 2010 solid tide field at a TDB Julian date: dC/dS of degrees 2-4
/// (order <= degree) with the set's GM and EGM2008's reference radius, the
/// Sun and Moon in `axes`. Evaluate it in those axes without its central term.
ExtendedGravityField SolidTideField(double jd, const ForceModelSet& forceSet,
                                    const EarthAxes& axes);

/// Solid Earth tides acceleration (km/s^2) at a GCRF position (km), TDB
/// Julian date, in the force set's Earth orientation.
Vec3 SolidTideAcceleration(const Vec3& satPosition, double jd,
                           const ForceModelSet& forceSet);

/// Solid Earth tides with the built-in Earth orientation (no EOP, UT1 = UTC)
/// and MU_EARTH; `config` selects bodies and step 2.
/// @param satPosition Satellite position, GCRF (km)
/// @param jd Julian date (TDB)
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

// -----------------------------------------------------------------------------
// Force-model contribution port
// -----------------------------------------------------------------------------
//
// A caller registers additional accelerations into the same integration and
// the same breakdown the built-in models use. Contributions are PARAMETERIZED,
// not code: the caller names a kind and supplies its parameters. Hosting
// foreign code inside the propagator would be a new host capability and is not
// this build item's to grant; a parameter table needs no new capability and
// covers what a force list is actually asked for.
//
// The port is exact. A zonal registered here is evaluated by an independent
// Legendre-gradient recursion, so "registered J2 reproduces built-in J2" is a
// cross-validation of two derivations, not a function calling itself.

enum class ContributionKind : uint8_t {
    None = 0,
    /// A fixed vector in the working (body-fixed) frame, km/s^2.
    ConstantInertial = 1,
    /// A fixed vector in the RTN triad of the current state, km/s^2.
    ConstantRTN = 2,
    /// Zonal harmonic of degree n: params are mu, Re, n, Jn.
    ZonalHarmonic = 3,
    /// A point mass at a fixed position: params are mu, x, y, z.
    PointMassAt = 4,
};

struct ForceContribution {
    ContributionKind kind{ContributionKind::None};
    bool enabled{true};
    /// Kind-specific parameters; see ContributionKind.
    double p[6]{};
};

/// Slot table. Bounded and inline so registration allocates nothing and the
/// derivative stays allocation-free in the integrator's inner loop.
struct ContributionSet {
    static constexpr int MAX_SLOTS = 8;
    ForceContribution slots[MAX_SLOTS];
    int count{0};
};

/// Zonal harmonic acceleration of a single degree, from the gradient of
///     U_n = -(mu/r) (Re/r)^n J_n P_n(z/r)
/// with P_n and P_n' from the standard recursions. Deliberately shares no
/// algebra with J2Only()/J2J4() so agreement between them is evidence.
/// @param position Body-fixed position (km)
/// @param mu Gravitational parameter (km^3/s^2)
/// @param Re Reference radius (km)
/// @param n Degree (>= 2)
/// @param Jn Unnormalized zonal coefficient
/// @return Perturbing acceleration, central term excluded (km/s^2)
Vec3 ZonalHarmonic(const Vec3& position, double mu, double Re, int n, double Jn);

/// Evaluate one registered contribution.
Vec3 EvaluateContribution(const ForceContribution& c,
                          const Vec3& position, const Vec3& velocity);

/// Sum of every enabled registered contribution.
Vec3 EvaluateContributions(const ContributionSet& set,
                           const Vec3& position, const Vec3& velocity);

// =============================================================================
// Combined Force Model Evaluation
// =============================================================================

/// Complete force model configuration (all 18 models)
/// Which central-body gravity model answers, stated rather than inferred.
///
/// Inference from a degree/order plus three booleans is how "J2 only" came to
/// mean "a J2-J6 tesseral field": there was no way for a caller to say what it
/// wanted, so every setting reached the same code. A selector says it.
enum class GravityMode : uint8_t {
    /// Legacy: infer from `usePointMass` / `useSphericalHarmonics` /
    /// `useEGM2008` / `useLoadedField`. Retained so existing callers are
    /// unchanged.
    Infer = 0,
    PointMass = 1,          ///< mu/r^2 only
    J2Only = 2,             ///< point mass + the J2 closed form
    J2J4 = 3,               ///< point mass + the J2/J3/J4 closed forms
    SphericalHarmonics = 4, ///< the built-in low-degree field
    EGM2008 = 5,            ///< the vendored EGM2008 coefficient set
    LoadedField = 6,        ///< a field read from a potential file
};

struct ForceModelSet {
    /// Authoritative GCRF -> Earth-fixed rotation (row-major) at a TDB Julian
    /// date, supplied by a caller that holds Earth orientation data (the PRW
    /// execution request's earth_orientation input: IERS 2010, IAU 2006/2000A,
    /// CIO based, with polar motion and UT1). Empty: the built-in IAU-1976/1980
    /// + GAST approximation, without polar motion and with UT1 = UTC.
    std::function<void(double jdTdb, double m[3][3])> earthFixedRotation;

    /// Space weather at a UTC Julian date (an execution request's
    /// space_weather input). When set, drag reads it at every evaluation,
    /// starting from `weather`, which it then overrides.
    std::function<void(double jdUtc, SpaceWeatherData& weather)> weatherAt;

    /// UT1 Julian date at a TDB Julian date, from the same Earth orientation
    /// data as earthFixedRotation (the solid tides' GMST). Empty: UT1 = UTC.
    std::function<double(double jdTdb)> jdUt1At;

    /// Rate of change of the drag ballistic coefficient Cd*A/m (m^2/kg/s)
    /// from dragRateEpochTdb (TDB Julian date): drag uses
    /// Cd*A/m + rate * (t - epoch) (DragAt).
    double dragAreaOverMassRate{0.0};
    double dragRateEpochTdb{0.0};

    // Gravity
    bool usePointMass{true};
    double mu{MU_EARTH};

    /// When not `Infer`, this alone decides the central-body gravity model and
    /// the `use*` booleans below are ignored for gravity.
    GravityMode gravityMode{GravityMode::Infer};

    bool useSphericalHarmonics{false};
    SphericalHarmonicsConfig sphericalHarmonics;

    bool useEGM2008{false};
    EGM2008ForceConfig egm2008;

    /// A field loaded from a potential file (ICGEM / .cof), of any degree the
    /// file supplies. Evaluated by the same Pines recursion the vendored
    /// EGM2008 path uses.
    bool useLoadedField{false};
    std::shared_ptr<const ExtendedGravityField> loadedField;

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
    /// Harris-Priester diurnal-bulge cosine exponent (2 low inclination,
    /// 6 polar; 4 is the usual mid-inclination choice).
    double harrisPriesterExponent{4.0};
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

    // Registered third-party contributions
    bool useContributions{false};
    ContributionSet contributions;

    // Maneuvers
    bool hasFiniteManeuver{false};
    FiniteManeuverConfig finiteManeuver;

    // Current space weather
    SpaceWeatherData weather;
    // Typed PRW separates the TDB dynamics clock from UTC weather metadata.
    // Defaults retain the diagnostic API's established epoch convention.
    bool explicitEpochContract{false};
    double integrationEpochTDB{0};

    // Current Sun position (computed internally if not provided)
    Vec3 sunPosition;
    bool sunPositionProvided{false};
};

/// Central-body gravity for a force set — exactly one model, chosen by
/// `forceSet.gravityMode`, or by the legacy precedence when that is `Infer`.
/// Callers that need only the gravity term (an acceleration breakdown, a
/// parity harness) go through this rather than re-deriving the precedence.
/// The Earth's fields (SphericalHarmonics, EGM2008, a loaded field) are
/// defined in Earth-fixed axes: each is evaluated at the GCRF position
/// rotated by GcrfToEarthFixed(jd) and its acceleration rotated back. The
/// point mass needs no rotation; the J2 and J2-J4 closed forms are
/// verification models with a fixed inertial symmetry axis z.
/// @param position Satellite position, GCRF (km)
/// @param jd Integration clock, TDB Julian date
/// @param forceSet Force model configuration
/// @return Gravity acceleration including the central term, GCRF (km/s^2)
Vec3 CentralBodyGravity(const Vec3& position, double jd, const ForceModelSet& forceSet);

/// The same model evaluated at an Earth-fixed position, in Earth-fixed axes.
Vec3 EarthFixedGravity(const Vec3& earthFixed, const ForceModelSet& forceSet);

/// True when the force set's central body field is Earth-fixed (see above).
bool EarthFixedField(const ForceModelSet& forceSet);

/// The built-in spherical-harmonic field's coefficients for a configuration:
/// the caller's field when supplied, else EGM2008 to the requested degree and
/// order (at most 20) with J2-J4 from the closed forms' constants, gates honored.
GravityFieldCoefficients InlineFieldCoefficients(const SphericalHarmonicsConfig& config);

/// GCRF to Earth-fixed rotation (row-major), jd TDB: IAU 1976 precession and
/// IAU 1980 nutation (coords.h), held for up to an hour of TT, then Earth
/// rotation by GAST with UTC standing in for UT1 (|UT1-UTC| < 0.9 s). Polar
/// motion (under 0.5 arcsec) is not applied: the force set carries no EOP.
void GcrfToEarthFixed(double jd, double m[3][3]);

/// The force set's GCRF -> Earth-fixed rotation: its earthFixedRotation when
/// supplied, else GcrfToEarthFixed(jd).
void GcrfToEarthFixed(double jd, const ForceModelSet& forceSet, double m[3][3]);

/// The force set's Earth-fixed axes at a TDB Julian date (GcrfToEarthFixed).
EarthAxes EarthAxesAt(double jdTdb, const ForceModelSet& forceSet);

/// The space weather drag reads at a UTC Julian date: weatherAt when set,
/// else the set's `weather`.
SpaceWeatherData WeatherAt(double jdUtc, const ForceModelSet& forceSet);

/// The drag configuration at a TDB Julian date, with dragAreaOverMassRate
/// applied to Cd (area and mass unchanged).
DragForceConfig DragAt(double jdTdb, const ForceModelSet& forceSet);

/// The force set's drag acceleration (km/s^2) with a given drag
/// configuration (ComputeTotalAcceleration passes DragAt(jd)).
Vec3 DragAccelerationWith(const Vec3& position, const Vec3& velocity, double jd,
                          const ForceModelSet& forceSet, const DragForceConfig& drag);

/// The force set's radiation pressure acceleration (km/s^2) with a given SRP
/// configuration, the Sun from forceSet.sunPosition when provided.
Vec3 SrpAcceleration(const Vec3& position, const Vec3& velocity, double jd, const ForceModelSet& forceSet,
                     const SRPForceConfig& srp);

/// Evaluate a field loaded from a potential file. Declared here and defined in
/// environment_models.cpp, which owns ExtendedGravityField.
/// @param position Body-fixed position (km)
/// @param field Loaded spherical-harmonic field
/// @return Acceleration including the central term (km/s^2)
Vec3 LoadedFieldGravity(const Vec3& position, const ExtendedGravityField& field);

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
