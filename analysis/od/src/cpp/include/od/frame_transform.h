#ifndef OD_FRAME_TRANSFORM_H
#define OD_FRAME_TRANSFORM_H

/**
 * Inertial frame transforms for OD ephemeris ingest.
 *
 * The SGP4 fitter propagates in TEME (True Equator, Mean Equinox of date),
 * so every ephemeris sample handed to the fitter must be expressed in TEME.
 * The SpaceX MEME path is already effectively TEME (its <1 m fit RMS on the
 * checked-in Starlink suite confirms it), so it needs no rotation.
 *
 * CCSDS OEM feeds commonly publish EME2000 / J2000 (e.g. NASA's public ISS
 * OEM), which differs from TEME by precession + nutation + the equation of the
 * equinoxes — of order 0.4 deg for 2026 epochs, i.e. tens of km of position if
 * ignored. This module implements the standard IAU-76/FK5 J2000 -> TEME
 * rotation (Montenbruck & Gill "Satellite Orbits" 5.3; Vallado teme2eci) so
 * OEM elements are produced in the same TEME frame CelesTrak SupGP uses.
 *
 * Accuracy: IAU-76 precession (full), IAU-1980 nutation truncated to the ten
 * leading terms (Dpsi/Deps good to < 0.1 arcsec ~= a few metres at LEO), and
 * the 1982 equation of the equinoxes (Dpsi*cos(eps)). This is far tighter than
 * the fit needs to converge and to land inclination/mean-motion correctly; the
 * residual nutation truncation and eqe-of-equinoxes sign are called out for the
 * A2.4 element-space parity gate.
 */

#include <array>

namespace od {

// Row-major 3x3 rotation matrix.
using Mat3 = std::array<std::array<double, 3>, 3>;

/// Rotation matrix R such that r_TEME = R * r_J2000 for the given UTC epoch.
/// jd_utc: UTC Julian Date. (TT-UTC is neglected: it shifts precession by
/// < 1e-4 arcsec, well below the truncation floor.)
Mat3 eci_j2000_to_teme_matrix(double jd_utc);

/// Rotate a J2000/EME2000 position (km) and velocity (km/s) pair into TEME.
/// The J2000<->TEME relative rotation rate is < 1e-11 rad/s, so the same frame
/// rotation is applied to position and velocity (the transport term is < 1e-7
/// km/s and irrelevant to the fit's initial guess).
void eci_j2000_to_teme(double jd_utc,
                       const double r_in[3], const double v_in[3],
                       double r_out[3], double v_out[3]);

}  // namespace od

#endif  // OD_FRAME_TRANSFORM_H
