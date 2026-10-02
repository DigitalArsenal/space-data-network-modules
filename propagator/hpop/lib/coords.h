// plugins/coords/include/coords.h
// =============================================================================
// Coordinate Transform Plugin API
// =============================================================================
// Provides transformations between various reference frames used in
// astrodynamics and satellite tracking.
//
// Supported transformations:
//   - TEME <-> GCRF: True Equator Mean Equinox to/from Geocentric Celestial Reference
//   - GCRF <-> ITRF: Inertial to/from Earth-fixed (via polar motion & Earth rotation)
//   - TEME <-> ITRF: Direct transformation for SGP4 outputs to Earth-fixed
//   - J2000 = GCRF: Treated as equivalent for most purposes
//
// Reference: Vallado, "Fundamentals of Astrodynamics and Applications"
// Nutation model: IAU 1980 (simpler than IAU 2000A, sufficient for MVP)
// =============================================================================

#pragma once
#include "coords_types.h"

namespace coords {

// =============================================================================
// Main Transformation Functions
// =============================================================================

/// Get transformation matrix between coordinate frames at given Julian date
/// @param from Source frame
/// @param to Target frame
/// @param jd Julian date (TT or TDB)
/// @return 3x3 rotation matrix from source to target frame
Matrix3x3 getTransformMatrix(Frame from, Frame to, double jd);

/// Transform state vector between frames
/// Handles both position and velocity transformation (including transport term
/// for rotating frames)
/// @param state Input state vector
/// @param from Source frame
/// @param to Target frame
/// @param jd Julian date (TT or TDB)
/// @return Transformed state vector
StateVec transform(const StateVec& state, Frame from, Frame to, double jd);

/// Transform position only (ignores velocity)
/// @param position Input position vector
/// @param from Source frame
/// @param to Target frame
/// @param jd Julian date (TT or TDB)
/// @return Transformed position vector
Vec3 transformPosition(const Vec3& position, Frame from, Frame to, double jd);

// =============================================================================
// Specific Transformation Matrices
// =============================================================================
// These provide direct access to commonly used transformations for efficiency

/// TEME to GCRF transformation matrix
/// GCRF = P^T * N^T * R3(-eqeq) * TEME (P: GCRF -> MOD, N: MOD -> TOD)
/// @param jd Julian date
Matrix3x3 temeToGcrf(double jd);

/// GCRF to TEME transformation matrix (inverse of above)
/// @param jd Julian date
Matrix3x3 gcrfToTeme(double jd);

/// GCRF to ITRF transformation matrix
/// Applies polar motion, Earth rotation, and frame bias
/// @param jd Julian date
/// @param xp X pole coordinate (arcsec), optional (0 if unknown)
/// @param yp Y pole coordinate (arcsec), optional (0 if unknown)
Matrix3x3 gcrfToItrf(double jd, double xp = 0.0, double yp = 0.0);

/// ITRF to GCRF transformation matrix (inverse of above)
/// @param jd Julian date
/// @param xp X pole coordinate (arcsec), optional
/// @param yp Y pole coordinate (arcsec), optional
Matrix3x3 itrfToGcrf(double jd, double xp = 0.0, double yp = 0.0);

/// TEME to ITRF transformation matrix (direct, more efficient than chaining)
/// @param jd Julian date
/// @param xp X pole coordinate (arcsec), optional
/// @param yp Y pole coordinate (arcsec), optional
Matrix3x3 temeToItrf(double jd, double xp = 0.0, double yp = 0.0);

/// ITRF to TEME transformation matrix
/// @param jd Julian date
/// @param xp X pole coordinate (arcsec), optional
/// @param yp Y pole coordinate (arcsec), optional
Matrix3x3 itrfToTeme(double jd, double xp = 0.0, double yp = 0.0);

/// MOD to GCRF (precession only)
/// @param jd Julian date
Matrix3x3 modToGcrf(double jd);

/// TOD to MOD (nutation only)
/// @param jd Julian date
Matrix3x3 todToMod(double jd);

/// PEF to ITRF (polar motion only)
/// @param xp X pole coordinate (arcsec)
/// @param yp Y pole coordinate (arcsec)
Matrix3x3 pefToItrf(double xp, double yp);

// =============================================================================
// Time and Angle Computations
// =============================================================================

/// Compute Greenwich Mean Sidereal Time (GMST)
/// @param jd Julian date (UT1)
/// @return GMST in radians
double gmst(double jd);

/// Compute Greenwich Apparent Sidereal Time (GAST)
/// GAST = GMST + equation of equinoxes
/// @param jd Julian date (UT1)
/// @return GAST in radians
double gast(double jd);

/// Compute Earth Rotation Angle (ERA)
/// More accurate than GMST for modern applications
/// @param jd Julian date (UT1)
/// @return ERA in radians
double era(double jd);

/// Compute equation of equinoxes
/// @param jd Julian date
/// @return Equation of equinoxes in radians
double equationOfEquinoxes(double jd);

// =============================================================================
// Nutation and Precession
// =============================================================================

/// Compute nutation angles using IAU 1980 model
/// @param jd Julian date (TT)
/// @param dpsi [out] Nutation in longitude (radians)
/// @param deps [out] Nutation in obliquity (radians)
void nutation(double jd, double& dpsi, double& deps);

/// Compute mean obliquity of the ecliptic
/// @param jd Julian date (TT)
/// @return Mean obliquity in radians
double meanObliquity(double jd);

/// Compute true obliquity (mean + nutation)
/// @param jd Julian date (TT)
/// @return True obliquity in radians
double trueObliquity(double jd);

/// Compute precession matrix from J2000 to date (MOD): r_MOD = P r_GCRF
/// Uses IAU 1976 precession angles (as ERFA pmat76; frame bias neglected)
/// @param jd Julian date (TT)
/// @return Precession rotation matrix
Matrix3x3 precession(double jd);

/// Compute nutation matrix (from MOD to TOD)
/// @param jd Julian date (TT)
/// @return Nutation rotation matrix
Matrix3x3 nutationMatrix(double jd);

// =============================================================================
// Utility Functions
// =============================================================================

/// Convert Julian date to Julian centuries from J2000
/// @param jd Julian date
/// @return Julian centuries from J2000.0
double julianCenturies(double jd);

/// Normalize angle to [0, 2*pi)
/// @param angle Angle in radians
/// @return Normalized angle
double normalizeAngle(double angle);

/// Get frame name as string
/// @param frame Coordinate frame enum
/// @return Frame name string
const char* frameName(Frame frame);

}  // namespace coords
