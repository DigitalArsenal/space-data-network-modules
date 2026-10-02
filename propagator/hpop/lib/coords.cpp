// plugins/coords/src/coords.cpp
// =============================================================================
// Coordinate Transform Implementation
// =============================================================================
// Implements coordinate transformations between various reference frames.
//
// References:
//   - Vallado, "Fundamentals of Astrodynamics and Applications", 4th Ed
//   - IERS Conventions (2010) for some formulations
//   - IAU 1980 nutation model (106-term series)
//
// This implementation uses the IAU 1980 nutation model for simplicity.
// For higher accuracy applications, consider upgrading to IAU 2000A/2006.
// =============================================================================

#include "coords.h"
#include <cmath>
#include <algorithm>

namespace coords {

using namespace constants;

// =============================================================================
// IAU 1980 Nutation Coefficients
// =============================================================================
// 106-term nutation series coefficients
// Each row: [l, l', F, D, Omega, A_psi, B_psi, A_eps, B_eps]
// where nutation = A + B*T (T in Julian centuries from J2000)
// Units: A_psi, B_psi, A_eps, B_eps in 0.0001 arcseconds

struct NutationCoeff {
    int l, lp, F, D, Om;    // Fundamental argument multipliers
    double Sp, Cp;          // Sin/Cos coefficients for dpsi (0.0001")
    double Se, Ce;          // Sin/Cos coefficients for deps (0.0001")
};

// Main terms of IAU 1980 nutation model (first 63 terms for MVP)
// Full 106-term series could be added for higher accuracy
static const NutationCoeff NUTATION_COEFFS[] = {
    //  l   l'  F   D   Om      Sp         Cp         Se         Ce
    {   0,  0,  0,  0,  1, -171996.0,  -174.2,   92025.0,     8.9 },
    {   0,  0,  2, -2,  2,  -13187.0,    -1.6,    5736.0,    -3.1 },
    {   0,  0,  2,  0,  2,   -2274.0,    -0.2,     977.0,    -0.5 },
    {   0,  0,  0,  0,  2,    2062.0,     0.2,    -895.0,     0.5 },
    {   0,  1,  0,  0,  0,    1426.0,    -3.4,      54.0,    -0.1 },
    {   1,  0,  0,  0,  0,     712.0,     0.1,      -7.0,     0.0 },
    {   0,  1,  2, -2,  2,    -517.0,     1.2,     224.0,    -0.6 },
    {   0,  0,  2,  0,  1,    -386.0,    -0.4,     200.0,     0.0 },
    {   1,  0,  2,  0,  2,    -301.0,     0.0,     129.0,    -0.1 },
    {   0, -1,  2, -2,  2,     217.0,    -0.5,     -95.0,     0.3 },
    {  -1,  0,  2,  0,  2,    -158.0,     0.0,       0.0,     0.0 },
    {   1,  0,  0, -2,  0,     129.0,     0.1,      -1.0,     0.0 },
    {   0,  0,  2, -2,  1,     123.0,     0.0,     -53.0,     0.0 },
    {  -1,  0,  2,  0,  1,      63.0,     0.0,     -33.0,     0.0 },
    {   1,  0,  0,  0,  1,      63.0,     0.1,     -33.0,     0.0 },
    {   0,  0,  0,  2,  0,     -59.0,     0.0,       0.0,     0.0 },
    {  -1,  0,  2,  2,  2,     -58.0,    -0.1,      26.0,     0.0 },
    {  -1,  0,  0,  0,  1,     -51.0,     0.0,      27.0,     0.0 },
    {   1,  0,  2,  0,  1,      48.0,     0.0,     -24.0,     0.0 },
    {  -2,  0,  2,  0,  1,      46.0,     0.0,     -24.0,     0.0 },
    {   0,  0,  2,  2,  2,     -38.0,     0.0,      16.0,     0.0 },
    {   2,  0,  2,  0,  2,     -31.0,     0.0,      13.0,     0.0 },
    {   2,  0,  0,  0,  0,      29.0,     0.0,       0.0,     0.0 },
    {   1,  0,  2, -2,  2,      29.0,     0.0,     -12.0,     0.0 },
    {   0,  0,  2,  0,  0,      26.0,     0.0,       0.0,     0.0 },
    {   0,  0,  2, -2,  0,     -22.0,     0.0,       0.0,     0.0 },
    {  -1,  0,  2,  0,  0,      21.0,     0.0,     -10.0,     0.0 },
    {   0,  2,  0,  0,  0,      17.0,    -0.1,       0.0,     0.0 },
    {   0,  2,  2, -2,  2,     -16.0,     0.1,       7.0,     0.0 },
    {  -1,  0,  0,  2,  1,      16.0,     0.0,      -8.0,     0.0 },
    {   0,  1,  0,  0,  1,     -15.0,     0.0,       9.0,     0.0 },
    {   1,  0,  0, -2,  1,     -13.0,     0.0,       7.0,     0.0 },
    {   0, -1,  0,  0,  1,     -12.0,     0.0,       6.0,     0.0 },
    {   2,  0, -2,  0,  0,      11.0,     0.0,       0.0,     0.0 },
    {  -1,  0,  2,  2,  1,     -10.0,     0.0,       5.0,     0.0 },
    {   1,  0,  2,  2,  2,      -8.0,     0.0,       3.0,     0.0 },
    {   0, -1,  2,  0,  2,      -7.0,     0.0,       3.0,     0.0 },
    {   0,  0,  2,  2,  1,      -7.0,     0.0,       3.0,     0.0 },
    {   1,  1,  0, -2,  0,      -7.0,     0.0,       0.0,     0.0 },
    {   0,  1,  2,  0,  2,       7.0,     0.0,      -3.0,     0.0 },
    {  -2,  0,  0,  2,  1,      -6.0,     0.0,       3.0,     0.0 },
    {   0,  0,  0,  2,  1,      -6.0,     0.0,       3.0,     0.0 },
    {   2,  0,  2, -2,  2,       6.0,     0.0,      -3.0,     0.0 },
    {   1,  0,  0,  2,  0,       6.0,     0.0,       0.0,     0.0 },
    {   1,  0,  2, -2,  1,       6.0,     0.0,      -3.0,     0.0 },
    {   0,  0,  0, -2,  1,      -5.0,     0.0,       3.0,     0.0 },
    {   0, -1,  2, -2,  1,      -5.0,     0.0,       3.0,     0.0 },
    {   2,  0,  2,  0,  1,      -5.0,     0.0,       3.0,     0.0 },
    {   1, -1,  0,  0,  0,       5.0,     0.0,       0.0,     0.0 },
    {   1,  0,  0, -1,  0,      -4.0,     0.0,       0.0,     0.0 },
    {   0,  0,  0,  1,  0,      -4.0,     0.0,       0.0,     0.0 },
    {   0,  1,  0, -2,  0,      -4.0,     0.0,       0.0,     0.0 },
    {   1,  0, -2,  0,  0,       4.0,     0.0,       0.0,     0.0 },
    {   2,  0,  0, -2,  1,       4.0,     0.0,      -2.0,     0.0 },
    {   0,  1,  2, -2,  1,       4.0,     0.0,      -2.0,     0.0 },
    {   1,  1,  0,  0,  0,      -3.0,     0.0,       0.0,     0.0 },
    {   1, -1,  0, -1,  0,      -3.0,     0.0,       0.0,     0.0 },
    {  -1, -1,  2,  2,  2,      -3.0,     0.0,       1.0,     0.0 },
    {   0, -1,  2,  2,  2,      -3.0,     0.0,       1.0,     0.0 },
    {   1, -1,  2,  0,  2,      -3.0,     0.0,       1.0,     0.0 },
    {   3,  0,  2,  0,  2,      -3.0,     0.0,       1.0,     0.0 },
    {  -2,  0,  2,  0,  2,      -3.0,     0.0,       1.0,     0.0 },
    {   1,  0,  2,  0,  0,       3.0,     0.0,       0.0,     0.0 },
};

static const size_t NUM_NUTATION_TERMS = sizeof(NUTATION_COEFFS) / sizeof(NUTATION_COEFFS[0]);

// =============================================================================
// Utility Functions
// =============================================================================

double julianCenturies(double jd) {
    return (jd - J2000_EPOCH) / JULIAN_CENTURY;
}

double normalizeAngle(double angle) {
    double result = std::fmod(angle, TWOPI);
    if (result < 0.0) {
        result += TWOPI;
    }
    return result;
}

const char* frameName(Frame frame) {
    switch (frame) {
        case Frame::TEME:  return "TEME";
        case Frame::GCRF:  return "GCRF";
        case Frame::ITRF:  return "ITRF";
        case Frame::J2000: return "J2000";
        case Frame::ECEF:  return "ECEF";
        case Frame::PEF:   return "PEF";
        case Frame::TOD:   return "TOD";
        case Frame::MOD:   return "MOD";
        default:           return "Unknown";
    }
}

// =============================================================================
// Fundamental Arguments for Nutation
// =============================================================================

// Compute fundamental arguments for nutation (Delaunay arguments)
// Returns values in radians
static void fundamentalArguments(double T, double& l, double& lp, double& F, double& D, double& Om) {
    // Mean anomaly of the Moon (l)
    l = normalizeAngle(DEG2RAD * (134.96298139
        + (1717915922.6330 * T
        + 31.310 * T * T
        + 0.064 * T * T * T) * ARCSEC2RAD / DEG2RAD));

    // Mean anomaly of the Sun (l')
    lp = normalizeAngle(DEG2RAD * (357.52772333
        + (129596581.2240 * T
        - 0.577 * T * T
        - 0.012 * T * T * T) * ARCSEC2RAD / DEG2RAD));

    // Mean argument of latitude of the Moon (F)
    F = normalizeAngle(DEG2RAD * (93.27191028
        + (1739527263.1370 * T
        - 13.257 * T * T
        + 0.011 * T * T * T) * ARCSEC2RAD / DEG2RAD));

    // Mean elongation of the Moon from the Sun (D)
    D = normalizeAngle(DEG2RAD * (297.85036306
        + (1602961601.3280 * T
        - 6.891 * T * T
        + 0.019 * T * T * T) * ARCSEC2RAD / DEG2RAD));

    // Mean longitude of ascending node of the Moon (Omega)
    Om = normalizeAngle(DEG2RAD * (125.04452222
        + (-6962890.5390 * T
        + 7.455 * T * T
        + 0.008 * T * T * T) * ARCSEC2RAD / DEG2RAD));
}

// =============================================================================
// Nutation Implementation
// =============================================================================

void nutation(double jd, double& dpsi, double& deps) {
    double T = julianCenturies(jd);

    // Get fundamental arguments
    double l, lp, F, D, Om;
    fundamentalArguments(T, l, lp, F, D, Om);

    // Sum nutation series
    dpsi = 0.0;
    deps = 0.0;

    for (size_t i = 0; i < NUM_NUTATION_TERMS; ++i) {
        const NutationCoeff& c = NUTATION_COEFFS[i];

        // Argument
        double arg = c.l * l + c.lp * lp + c.F * F + c.D * D + c.Om * Om;

        // Nutation in longitude
        dpsi += (c.Sp + c.Cp * T) * std::sin(arg);

        // Nutation in obliquity
        deps += (c.Se + c.Ce * T) * std::cos(arg);
    }

    // Convert from 0.0001 arcseconds to radians
    dpsi *= 0.0001 * ARCSEC2RAD;
    deps *= 0.0001 * ARCSEC2RAD;
}

double meanObliquity(double jd) {
    double T = julianCenturies(jd);

    // IAU 1980 mean obliquity formula
    // eps0 = 84381.448 - 46.8150*T - 0.00059*T^2 + 0.001813*T^3 arcsec
    double eps0_arcsec = 84381.448
                       - 46.8150 * T
                       - 0.00059 * T * T
                       + 0.001813 * T * T * T;

    return eps0_arcsec * ARCSEC2RAD;
}

double trueObliquity(double jd) {
    double dpsi, deps;
    nutation(jd, dpsi, deps);
    return meanObliquity(jd) + deps;
}

double equationOfEquinoxes(double jd) {
    double dpsi, deps;
    nutation(jd, dpsi, deps);
    double eps = trueObliquity(jd);
    return dpsi * std::cos(eps);
}

// =============================================================================
// Sidereal Time
// =============================================================================

double gmst(double jd) {
    // Continuous GMST (Vallado / IERS-compatible form).
    //
    // Important: avoid mixing a "GMST at 0h" polynomial with T evaluated at the
    // full jd and then adding H again; that introduces a ~1 degree phase jump at
    // each UTC midnight. This form is continuous across day boundaries.
    const double T = julianCenturies(jd);
    const double d = jd - J2000_EPOCH;

    double gmst_deg = 280.46061837
                    + 360.98564736629 * d
                    + 0.000387933 * T * T
                    - (T * T * T) / 38710000.0;

    return normalizeAngle(gmst_deg * DEG2RAD);
}

double gast(double jd) {
    return normalizeAngle(gmst(jd) + equationOfEquinoxes(jd));
}

double era(double jd) {
    // Earth Rotation Angle (IERS 2003)
    // More accurate than GMST for precise applications
    double Du = jd - J2000_EPOCH;
    double theta = TWOPI * (0.7790572732640 + 1.00273781191135448 * Du);
    return normalizeAngle(theta);
}

// =============================================================================
// Precession Matrix
// =============================================================================

Matrix3x3 precession(double jd) {
    double T = julianCenturies(jd);

    // IAU 1976 precession angles (arcsec)
    double zeta_A  = (2306.2181 + 1.39656 * T - 0.000139 * T * T) * T
                   + (0.30188 - 0.000344 * T) * T * T
                   + 0.017998 * T * T * T;

    double theta_A = (2004.3109 - 0.85330 * T - 0.000217 * T * T) * T
                   - (0.42665 + 0.000217 * T) * T * T
                   - 0.041833 * T * T * T;

    double z_A     = (2306.2181 + 1.39656 * T - 0.000139 * T * T) * T
                   + (1.09468 + 0.000066 * T) * T * T
                   + 0.018203 * T * T * T;

    // Convert to radians
    zeta_A  *= ARCSEC2RAD;
    theta_A *= ARCSEC2RAD;
    z_A     *= ARCSEC2RAD;

    // Build precession matrix: P = R3(-z) * R2(theta) * R3(-zeta)
    Matrix3x3 R3_neg_z = Matrix3x3::rotateZ(-z_A);
    Matrix3x3 R2_theta = Matrix3x3::rotateY(theta_A);
    Matrix3x3 R3_neg_zeta = Matrix3x3::rotateZ(-zeta_A);

    return R3_neg_z * R2_theta * R3_neg_zeta;
}

// =============================================================================
// Nutation Matrix
// =============================================================================

Matrix3x3 nutationMatrix(double jd) {
    double dpsi, deps;
    nutation(jd, dpsi, deps);

    double eps0 = meanObliquity(jd);
    double eps = eps0 + deps;

    // Mean of date to true of date (IAU 1980, as ERFA nutm80):
    // N = R1(-eps) * R3(-dpsi) * R1(eps0)
    Matrix3x3 R1_neg_eps = Matrix3x3::rotateX(-eps);
    Matrix3x3 R3_neg_dpsi = Matrix3x3::rotateZ(-dpsi);
    Matrix3x3 R1_eps0 = Matrix3x3::rotateX(eps0);

    return R1_neg_eps * R3_neg_dpsi * R1_eps0;
}

// =============================================================================
// Frame-Specific Transformations
// =============================================================================

Matrix3x3 modToGcrf(double jd) {
    // precession() maps GCRF (J2000) to mean of date, as ERFA pmat76.
    return precession(jd).transpose();
}

Matrix3x3 todToMod(double jd) {
    // TOD to MOD is inverse of nutation matrix
    return nutationMatrix(jd).transpose();
}

Matrix3x3 pefToItrf(double xp, double yp) {
    // Polar motion: W = R3(-sp) * R2(xp) * R1(yp)
    // For simplicity, ignore TIO locator (sp) which is very small
    double xp_rad = xp * ARCSEC2RAD;
    double yp_rad = yp * ARCSEC2RAD;

    Matrix3x3 R2_xp = Matrix3x3::rotateY(xp_rad);
    Matrix3x3 R1_yp = Matrix3x3::rotateX(yp_rad);

    return R2_xp * R1_yp;
}

// =============================================================================
// TEME <-> GCRF Transformations
// =============================================================================

Matrix3x3 temeToGcrf(double jd) {
    // TEME is close to TOD but uses mean equinox
    // TEME -> TOD -> MOD -> GCRF
    // For TEME, we need to account for the equation of equinoxes differently

    // Get precession and nutation
    Matrix3x3 P = precession(jd);
    Matrix3x3 N = nutationMatrix(jd);

    // TEME shares the true equator of date with TOD but measures from the
    // mean equinox: r_TOD = R3(-eqeq) r_TEME (GAST = GMST + eqeq).
    double eqeq = equationOfEquinoxes(jd);
    Matrix3x3 E = Matrix3x3::rotateZ(-eqeq);

    // GCRF = P^T * N^T * E * TEME (P: GCRF -> MOD, N: MOD -> TOD)
    return P.transpose() * N.transpose() * E;
}

Matrix3x3 gcrfToTeme(double jd) {
    return temeToGcrf(jd).transpose();
}

// =============================================================================
// GCRF <-> ITRF Transformations
// =============================================================================

Matrix3x3 gcrfToItrf(double jd, double xp, double yp) {
    // Full transformation chain: GCRF -> MOD -> TOD -> PEF -> ITRF
    // Or more directly: GCRF -> TIRS (via CIP) -> ITRF (via polar motion)

    // For compatibility with TEME-based workflows, use:
    // ITRF = W * R * N * P * GCRF
    // where W = polar motion, R = Earth rotation, N = nutation, P = precession

    Matrix3x3 P = precession(jd);      // GCRF to MOD
    Matrix3x3 N = nutationMatrix(jd);  // MOD to TOD

    // Earth rotation (GAST)
    double theta = gast(jd);
    Matrix3x3 R = Matrix3x3::rotateZ(theta);

    // Polar motion
    Matrix3x3 W = pefToItrf(xp, yp);

    return W * R * N * P;
}

Matrix3x3 itrfToGcrf(double jd, double xp, double yp) {
    return gcrfToItrf(jd, xp, yp).transpose();
}

// =============================================================================
// TEME <-> ITRF Transformations (Direct)
// =============================================================================

Matrix3x3 temeToItrf(double jd, double xp, double yp) {
    // Direct transformation: TEME -> PEF -> ITRF
    // TEME to PEF uses GMST (not GAST, since TEME is mean equinox)

    double theta = gmst(jd);
    Matrix3x3 R = Matrix3x3::rotateZ(theta);
    Matrix3x3 W = pefToItrf(xp, yp);

    return W * R;
}

Matrix3x3 itrfToTeme(double jd, double xp, double yp) {
    return temeToItrf(jd, xp, yp).transpose();
}

// =============================================================================
// General Transformation Functions
// =============================================================================

Matrix3x3 getTransformMatrix(Frame from, Frame to, double jd) {
    // Handle identity transformation
    if (from == to) {
        return Matrix3x3::identity();
    }

    // Handle J2000 = GCRF equivalence
    if (from == Frame::J2000) from = Frame::GCRF;
    if (to == Frame::J2000) to = Frame::GCRF;

    // Handle ECEF = ITRF equivalence
    if (from == Frame::ECEF) from = Frame::ITRF;
    if (to == Frame::ECEF) to = Frame::ITRF;

    // Direct transformations
    if (from == Frame::TEME && to == Frame::GCRF) {
        return temeToGcrf(jd);
    }
    if (from == Frame::GCRF && to == Frame::TEME) {
        return gcrfToTeme(jd);
    }
    if (from == Frame::GCRF && to == Frame::ITRF) {
        return gcrfToItrf(jd);
    }
    if (from == Frame::ITRF && to == Frame::GCRF) {
        return itrfToGcrf(jd);
    }
    if (from == Frame::TEME && to == Frame::ITRF) {
        return temeToItrf(jd);
    }
    if (from == Frame::ITRF && to == Frame::TEME) {
        return itrfToTeme(jd);
    }

    // MOD transformations
    if (from == Frame::MOD && to == Frame::GCRF) {
        return modToGcrf(jd);
    }
    if (from == Frame::GCRF && to == Frame::MOD) {
        return modToGcrf(jd).transpose();
    }

    // TOD transformations
    if (from == Frame::TOD && to == Frame::MOD) {
        return todToMod(jd);
    }
    if (from == Frame::MOD && to == Frame::TOD) {
        return nutationMatrix(jd);
    }
    if (from == Frame::TOD && to == Frame::GCRF) {
        return modToGcrf(jd) * todToMod(jd);
    }
    if (from == Frame::GCRF && to == Frame::TOD) {
        return nutationMatrix(jd) * modToGcrf(jd).transpose();
    }

    // PEF transformations
    if (from == Frame::PEF && to == Frame::ITRF) {
        return pefToItrf(0.0, 0.0);  // No polar motion data
    }
    if (from == Frame::ITRF && to == Frame::PEF) {
        return pefToItrf(0.0, 0.0).transpose();
    }

    // Chain transformations for other combinations
    // Go through GCRF as intermediate
    if (from != Frame::GCRF && to != Frame::GCRF) {
        Matrix3x3 fromToGcrf = getTransformMatrix(from, Frame::GCRF, jd);
        Matrix3x3 gcrfToTarget = getTransformMatrix(Frame::GCRF, to, jd);
        return gcrfToTarget * fromToGcrf;
    }

    // Unsupported transformation - return identity and log warning
    return Matrix3x3::identity();
}

Vec3 transformPosition(const Vec3& position, Frame from, Frame to, double jd) {
    Matrix3x3 M = getTransformMatrix(from, to, jd);
    return M.apply(position);
}

StateVec transform(const StateVec& state, Frame from, Frame to, double jd) {
    // Get rotation matrix
    Matrix3x3 M = getTransformMatrix(from, to, jd);

    // Transform position
    Vec3 newPos = M.apply(state.position);

    // Transform velocity
    // For rotating frames, need to add transport term: v_to = M * v_from + omega x r_to
    Vec3 newVel = M.apply(state.velocity);

    // Add transport term if going to/from Earth-fixed frame
    bool fromRotating = (from == Frame::ITRF || from == Frame::ECEF || from == Frame::PEF);
    bool toRotating = (to == Frame::ITRF || to == Frame::ECEF || to == Frame::PEF);

    if (fromRotating != toRotating) {
        // Earth rotation vector in GCRF (approximately Z-axis)
        Vec3 omega(0.0, 0.0, EARTH_ROTATION_RATE);

        if (toRotating) {
            // Going from inertial to rotating: v_rot = v_iner - omega x r
            // Transform omega to target frame
            Matrix3x3 M_omega = getTransformMatrix(Frame::GCRF, to, jd);
            Vec3 omega_target = M_omega.apply(omega);
            Vec3 transport = omega_target.cross(newPos);
            newVel = newVel - transport;
        } else {
            // Going from rotating to inertial: v_iner = v_rot + omega x r
            // omega is in GCRF, r is in GCRF after position transform
            Vec3 transport = omega.cross(newPos);
            newVel = newVel + transport;
        }
    }

    return StateVec(newPos, newVel);
}

}  // namespace coords
