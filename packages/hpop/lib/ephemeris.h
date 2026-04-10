// ephemeris.h - Planetary Ephemerides and Reference Frame Data
// =============================================================================
// Phase 12.7-12.8: Planetary Ephemerides and Reference Frame Transformations
// Provides high-precision planetary positions, reference frame transformations,
// and time system conversions for astrodynamics applications.
// =============================================================================

#pragma once

#include "astrodynamics_types.h"
#include <vector>
#include <string>
#include <cmath>
#include <array>

namespace astro {

// =============================================================================
// 12.8 Planetary Ephemerides Namespace
// =============================================================================

namespace Ephemeris {

// ---------------------------------------------------------------------------
// Body Enumeration
// ---------------------------------------------------------------------------

/// Celestial body identifiers for ephemeris queries
enum class Body {
    Sun = 0,                    ///< Sun (solar system center for heliocentric)
    Mercury = 1,                ///< Mercury
    Venus = 2,                  ///< Venus
    Earth = 3,                  ///< Earth
    Moon = 4,                   ///< Moon (Earth's natural satellite)
    Mars = 5,                   ///< Mars
    Jupiter = 6,                ///< Jupiter
    Saturn = 7,                 ///< Saturn
    Uranus = 8,                 ///< Uranus
    Neptune = 9,                ///< Neptune
    Pluto = 10,                 ///< Pluto (dwarf planet)
    EarthMoonBarycenter = 11,   ///< Earth-Moon system barycenter
    SolarSystemBarycenter = 12  ///< Solar system barycenter
};

// ---------------------------------------------------------------------------
// Body State Structure
// ---------------------------------------------------------------------------

/// State of a celestial body at a specific epoch
struct BodyState {
    Vec3 position;              ///< Position in specified frame (km)
    Vec3 velocity;              ///< Velocity in specified frame (km/s)
    double epoch;               ///< Julian date (TDB)
    Body body{Body::Earth};     ///< Body identifier
    bool valid{false};          ///< True if state is valid

    BodyState() = default;
    BodyState(const Vec3& r, const Vec3& v, double jd, Body b = Body::Earth)
        : position(r), velocity(v), epoch(jd), body(b), valid(true) {}
};

// ---------------------------------------------------------------------------
// Body Physical Constants
// ---------------------------------------------------------------------------

/// Physical constants for a celestial body
struct BodyConstants {
    double mu;                  ///< Gravitational parameter (km^3/s^2)
    double radius;              ///< Mean equatorial radius (km)
    double J2;                  ///< Second zonal harmonic (J2 coefficient)
    double rotationRate;        ///< Rotation rate (rad/s)
    double mass;                ///< Mass (kg)
    double polarRadius;         ///< Polar radius (km)
    double flattening;          ///< Flattening factor (1 - Rpolar/Requator)
    std::string name;           ///< Body name

    BodyConstants() = default;
};

// ---------------------------------------------------------------------------
// Planetary Orbital Elements (J2000.0)
// ---------------------------------------------------------------------------

/// Keplerian orbital elements for a planet at J2000.0 with rates
struct PlanetaryElements {
    double a;                   ///< Semi-major axis (AU)
    double e;                   ///< Eccentricity
    double i;                   ///< Inclination (deg)
    double L;                   ///< Mean longitude (deg)
    double lonPeri;             ///< Longitude of perihelion (deg)
    double raan;                ///< Longitude of ascending node (deg)

    // Secular rates (per Julian century)
    double aDot;                ///< d(a)/dt (AU/century)
    double eDot;                ///< d(e)/dt (1/century)
    double iDot;                ///< d(i)/dt (deg/century)
    double LDot;                ///< d(L)/dt (deg/century)
    double lonPeriDot;          ///< d(lonPeri)/dt (deg/century)
    double raanDot;             ///< d(raan)/dt (deg/century)
};

// ---------------------------------------------------------------------------
// Ephemeris Functions
// ---------------------------------------------------------------------------

/// Get body state at a specific epoch (analytical approximation)
/// @param body Celestial body identifier
/// @param jdTDB Julian date in TDB time scale
/// @param centerBody Center body for position reference (default: SSB)
/// @return Body state with position and velocity
/// @note Uses analytical approximations (VSOP87 simplified for planets, ELP2000 for Moon)
BodyState getBodyState(Body body, double jdTDB,
                       Body centerBody = Body::SolarSystemBarycenter);

/// Get high-precision Sun position (VSOP87 simplified)
/// @param jdTDB Julian date in TDB time scale
/// @return Sun position relative to Earth (geocentric) in ICRF (km)
/// @note Accuracy: ~1 arcsecond over +-4000 years from J2000
Vec3 getSunPosition(double jdTDB);

/// Get high-precision Moon position (ELP2000 simplified)
/// @param jdTDB Julian date in TDB time scale
/// @return Moon position relative to Earth (geocentric) in ICRF (km)
/// @note Accuracy: ~10 arcseconds for positions
Vec3 getMoonPosition(double jdTDB);

/// Get planet heliocentric position
/// @param body Planet identifier (Mercury through Neptune)
/// @param jdTDB Julian date in TDB time scale
/// @return Planet position relative to Sun in ecliptic J2000 frame (km)
Vec3 getPlanetPosition(Body body, double jdTDB);

/// Get body physical constants
/// @param body Celestial body identifier
/// @return Body constants (mu, radius, J2, rotation rate)
BodyConstants getBodyConstants(Body body);

/// Compute Sun-Earth distance at epoch
/// @param jdTDB Julian date in TDB time scale
/// @return Distance from Earth to Sun (km)
double sunEarthDistance(double jdTDB);

/// Compute Moon-Earth distance at epoch
/// @param jdTDB Julian date in TDB time scale
/// @return Distance from Earth to Moon (km)
double moonEarthDistance(double jdTDB);

/// Get orbital elements for a planet at specified epoch
/// @param body Planet identifier
/// @param jdTDB Julian date in TDB time scale
/// @return Orbital elements referenced to ecliptic J2000
PlanetaryElements planetOrbitalElements(Body body, double jdTDB);

/// Apply light-time correction to apparent position
/// @param position Geometric position of target (km)
/// @param velocity Velocity of target (km/s)
/// @param distance Distance to target (km)
/// @return Corrected position accounting for light travel time
/// @note Uses iterative Newtonian correction
Vec3 lightTimeCorrection(const Vec3& position, const Vec3& velocity, double distance);

/// Apply stellar aberration correction
/// @param position Apparent position of object (km)
/// @param observerVelocity Observer velocity (km/s)
/// @return Position corrected for stellar aberration
/// @note Annual aberration constant: ~20.5 arcseconds
Vec3 aberrationCorrection(const Vec3& position, const Vec3& observerVelocity);

/// Compute relativistic light deflection by the Sun
/// @param position Position of observed object relative to observer (km)
/// @param sunPosition Position of Sun relative to observer (km)
/// @param elongation Sun-object elongation angle (rad)
/// @return Deflection angle (rad)
/// @note Maximum deflection at Sun limb: ~1.75 arcseconds
double relativisticDeflection(const Vec3& position, const Vec3& sunPosition,
                              double elongation);

/// Compute Earth-to-Sun unit vector
/// @param jdTDB Julian date in TDB time scale
/// @return Unit vector from Earth to Sun in ICRF
Vec3 earthToSunVector(double jdTDB);

/// Get gravitational parameter for body
/// @param body Celestial body identifier
/// @return Gravitational parameter (km^3/s^2)
double getBodyMu(Body body);

/// Convert body enum to string name
/// @param body Celestial body identifier
/// @return Human-readable body name
std::string bodyName(Body body);

/// Compute planet's mean anomaly at epoch
/// @param body Planet identifier
/// @param jdTDB Julian date in TDB
/// @return Mean anomaly (rad)
double planetMeanAnomaly(Body body, double jdTDB);

/// Solve Kepler's equation for eccentric anomaly
/// @param M Mean anomaly (rad)
/// @param e Eccentricity
/// @param tolerance Convergence tolerance (default 1e-12)
/// @param maxIter Maximum iterations (default 50)
/// @return Eccentric anomaly (rad)
double solveKepler(double M, double e, double tolerance = 1e-12, int maxIter = 50);

// ---------------------------------------------------------------------------
// Additional Ephemeris Sources (Phase 12.8)
// ---------------------------------------------------------------------------

/// Ephemeris source type
enum class EphemerisSource {
    Analytical,         ///< Analytical approximation (default)
    JPL_DE440,          ///< JPL DE440 (default high-fidelity)
    JPL_DE441,          ///< JPL DE441 (long-term, -13200 to +17191)
    INPOP21a,           ///< IMCCE INPOP21a planetary ephemeris
    EPM2021,            ///< IAA RAS EPM2021 ephemeris
    MarsHighFidelity    ///< Mars-specific high-fidelity model
};

/// JPL DE441 ephemeris (long-term, -13200 to +17191)
BodyState getBodyStateDE441(Body body, double jdTDB,
                            Body centerBody = Body::SolarSystemBarycenter);

/// INPOP21a planetary ephemeris (IMCCE)
BodyState getBodyStateINPOP21a(Body body, double jdTDB,
                               Body centerBody = Body::SolarSystemBarycenter);

/// EPM2021 planetary ephemeris (IAA RAS)
BodyState getBodyStateEPM2021(Body body, double jdTDB,
                              Body centerBody = Body::SolarSystemBarycenter);

/// Mars high-fidelity ephemeris (includes Phobos/Deimos perturbations)
BodyState getMarsHighFidelity(double jdTDB);

/// Load binary ephemeris data file (SPK/BSP format)
bool loadEphemerisFile(const std::string& filename, EphemerisSource source);

/// Check if a specific ephemeris is loaded
bool isEphemerisLoaded(EphemerisSource source);

/// Get time coverage of loaded ephemeris
bool getEphemerisRange(EphemerisSource source, double& jdStart, double& jdEnd);

} // namespace Ephemeris

// =============================================================================
// 12.7 Reference Frame Data Namespace
// =============================================================================

namespace RefFrame {

// ---------------------------------------------------------------------------
// Earth Orientation Parameters (EOP)
// ---------------------------------------------------------------------------

/// Earth Orientation Parameters for a specific date
struct EOP {
    double mjd;                 ///< Modified Julian Date (UTC)
    double xp;                  ///< Polar motion x-component (arcsec)
    double yp;                  ///< Polar motion y-component (arcsec)
    double dUT1;                ///< UT1-UTC (seconds)
    double dPsi;                ///< Nutation correction in longitude (arcsec)
    double dEps;                ///< Nutation correction in obliquity (arcsec)
    double LOD;                 ///< Length of Day excess (ms)
    double dX;                  ///< X pole offset for IAU 2000 (arcsec)
    double dY;                  ///< Y pole offset for IAU 2000 (arcsec)
    bool valid{false};          ///< True if data is valid

    EOP() = default;
};

/// Leap second entry
struct LeapSecond {
    double mjd;                 ///< MJD when leap second takes effect
    int tai_utc;                ///< TAI-UTC after this date (seconds)
};

// ---------------------------------------------------------------------------
// Reference Frame Transformation Functions
// ---------------------------------------------------------------------------

/// Compute ICRF to ITRF transformation matrix
/// @param jdUTC Julian date in UTC
/// @param xp Polar motion x (arcsec, optional - uses embedded if zero)
/// @param yp Polar motion y (arcsec, optional - uses embedded if zero)
/// @param dUT1 UT1-UTC offset (seconds, optional - uses embedded if zero)
/// @return 3x3 rotation matrix from ICRF to ITRF
/// @note Includes precession, nutation, Earth rotation, and polar motion
Mat3 ICRF_to_ITRF(double jdUTC, double xp = 0, double yp = 0, double dUT1 = 0);

/// Compute precession matrix (IAU 2006 model)
/// @param jdTT Julian date in TT time scale
/// @return 3x3 precession rotation matrix
/// @note Transforms from J2000 mean equator to date mean equator
Mat3 precessionMatrix(double jdTT);

/// Compute nutation matrix (IAU 2000A simplified)
/// @param jdTT Julian date in TT time scale
/// @return 3x3 nutation rotation matrix
/// @note Uses 106-term series approximation
Mat3 nutationMatrix(double jdTT);

/// Compute Earth Rotation Angle (ERA)
/// @param jdUT1 Julian date in UT1 time scale
/// @return Earth rotation angle (rad)
/// @note ERA = 2*pi * (0.7790572732640 + 1.00273781191135448 * Du)
double earthRotationAngle(double jdUT1);

/// Compute polar motion transformation matrix
/// @param xp Polar motion x-component (arcsec)
/// @param yp Polar motion y-component (arcsec)
/// @return 3x3 polar motion rotation matrix
Mat3 polarMotionMatrix(double xp, double yp);

/// Get Earth Orientation Parameters for a specific date
/// @param mjd Modified Julian Date (UTC)
/// @return Interpolated EOP data
/// @note Uses embedded EOP table with linear interpolation
EOP getEOP(double mjd);

/// Get UT1-UTC offset for a specific date
/// @param mjd Modified Julian Date (UTC)
/// @return UT1-UTC offset (seconds)
/// @note Range typically [-0.9, +0.9] seconds
double UT1_UTC(double mjd);

/// Get TAI-UTC (leap seconds) for a specific date
/// @param mjd Modified Julian Date (UTC)
/// @return TAI-UTC offset (integer seconds)
int TAI_UTC(double mjd);

/// Get TT-TAI offset
/// @return TT-TAI = 32.184 seconds (constant)
inline constexpr double TT_TAI() { return 32.184; }

/// Compute TDB-TT offset (approximation)
/// @param jdTT Julian date in TT
/// @return TDB-TT offset (seconds)
/// @note Maximum amplitude ~1.7 ms, dominated by Earth orbital eccentricity
double TDB_TT(double jdTT);

/// Greenwich Mean Sidereal Time (GMST)
/// @param jdUT1 Julian date in UT1
/// @return GMST in radians [0, 2*pi)
double greenwichMeanSiderealTime(double jdUT1);

/// Greenwich Apparent Sidereal Time (GAST)
/// @param jdUT1 Julian date in UT1
/// @param jdTT Julian date in TT (for nutation)
/// @return GAST in radians [0, 2*pi)
double greenwichApparentSiderealTime(double jdUT1, double jdTT);

/// Equation of the Equinoxes
/// @param jdTT Julian date in TT
/// @return Equation of equinoxes (rad)
double equationOfEquinoxes(double jdTT);

/// Mean obliquity of the ecliptic (IAU 2006)
/// @param jdTT Julian date in TT
/// @return Mean obliquity (rad)
double meanObliquity(double jdTT);

/// True obliquity of the ecliptic
/// @param jdTT Julian date in TT
/// @return True obliquity including nutation (rad)
double trueObliquity(double jdTT);

/// Get nutation angles (IAU 2000A simplified)
/// @param jdTT Julian date in TT
/// @param dPsi Output: nutation in longitude (rad)
/// @param dEps Output: nutation in obliquity (rad)
void nutationAngles(double jdTT, double& dPsi, double& dEps);

/// Convert Julian Date to Modified Julian Date
/// @param jd Julian date
/// @return Modified Julian Date (JD - 2400000.5)
inline double jdToMJD(double jd) { return jd - 2400000.5; }

/// Convert Modified Julian Date to Julian Date
/// @param mjd Modified Julian Date
/// @return Julian date (MJD + 2400000.5)
inline double mjdToJD(double mjd) { return mjd + 2400000.5; }

/// Convert Julian Date to Julian centuries from J2000.0
/// @param jd Julian date
/// @return Julian centuries from J2000.0 (TDB)
inline double julianCenturiesFromJ2000(double jd) {
    return (jd - 2451545.0) / 36525.0;
}

/// Get the leap second table
/// @return Vector of leap second entries
const std::vector<LeapSecond>& getLeapSecondTable();

/// Compute frame bias matrix (ICRS to mean J2000)
/// @return 3x3 frame bias rotation matrix
/// @note Small rotation (~17 mas in RA, 7 mas in Dec)
Mat3 frameBiasMatrix();

/// Compute equation of origins (CEO-based paradigm)
/// @param jdTT Julian date in TT
/// @return Equation of origins (rad)
double equationOfOrigins(double jdTT);

// ---------------------------------------------------------------------------
// Coordinate Transformations
// ---------------------------------------------------------------------------

/// Transform position from ICRF to ITRF
/// @param posICRF Position in ICRF (km)
/// @param jdUTC Julian date in UTC
/// @param eop Earth orientation parameters (optional)
/// @return Position in ITRF (km)
Vec3 icrf2itrf(const Vec3& posICRF, double jdUTC, const EOP& eop = EOP());

/// Transform position from ITRF to ICRF
/// @param posITRF Position in ITRF (km)
/// @param jdUTC Julian date in UTC
/// @param eop Earth orientation parameters (optional)
/// @return Position in ICRF (km)
Vec3 itrf2icrf(const Vec3& posITRF, double jdUTC, const EOP& eop = EOP());

/// Transform from ecliptic J2000 to equatorial J2000 (ICRF)
/// @param posEcliptic Position in ecliptic J2000 frame (km)
/// @return Position in equatorial J2000 frame (km)
Vec3 eclipticToEquatorial(const Vec3& posEcliptic);

/// Transform from equatorial J2000 (ICRF) to ecliptic J2000
/// @param posEquatorial Position in equatorial J2000 frame (km)
/// @return Position in ecliptic J2000 frame (km)
Vec3 equatorialToEcliptic(const Vec3& posEquatorial);

/// Obliquity of the ecliptic at J2000.0
/// @return J2000.0 obliquity (rad) = 23.4392911 degrees
inline constexpr double OBLIQUITY_J2000 = 0.4090928042223415;

} // namespace RefFrame

// =============================================================================
// Embedded Data Constants
// =============================================================================

namespace EphemerisData {

/// J2000.0 epoch as Julian Date (TDB)
constexpr double JD_J2000 = 2451545.0;

/// Julian days per century
constexpr double DAYS_PER_CENTURY = 36525.0;

/// Astronomical Unit in km
constexpr double AU_KM = 149597870.7;

/// Speed of light in km/s
constexpr double C_KMS = 299792.458;

/// Seconds per day
constexpr double SEC_PER_DAY = 86400.0;

/// Arcseconds per radian
constexpr double ARCSEC_PER_RAD = 206264.806247096;

/// Radians per arcsecond
constexpr double RAD_PER_ARCSEC = 4.848136811095360e-6;

/// Milliarcseconds per radian
constexpr double MAS_PER_RAD = 206264806.247096;

/// Solar mass parameter (km^3/s^2)
constexpr double GM_SUN = 1.32712440041279419e11;

/// Earth mass parameter (km^3/s^2)
constexpr double GM_EARTH = 398600.435507;

/// Moon mass parameter (km^3/s^2)
constexpr double GM_MOON = 4902.800118;

/// Earth equatorial radius (km)
constexpr double R_EARTH = 6378.1366;

/// Earth flattening (WGS84)
constexpr double F_EARTH = 1.0 / 298.257223563;

/// Earth rotation rate (rad/s)
constexpr double OMEGA_EARTH = 7.292115e-5;

} // namespace EphemerisData

} // namespace astro
