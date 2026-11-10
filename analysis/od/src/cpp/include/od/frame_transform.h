#ifndef OD_FRAME_TRANSFORM_H
#define OD_FRAME_TRANSFORM_H

/**
 * Inertial frame transforms for OD ephemeris ingest.
 *
 * The SGP4 fitter propagates in TEME (True Equator, Mean Equinox of date),
 * so every ephemeris sample handed to the fitter must be expressed in TEME.
 *
 * TEME is AIAA 2006-6753's (sec. II.D eq. 1: r_PEF = R3(GMST82) r_TEME). The
 * inertial legs are foundation/frames' axis engine: GCRF/ICRF -> TEME by
 * gcrfToTeme, R3(GAST06 - GMST82) NPB06, and EME2000/J2000 through the IAU 2006
 * frame bias first; TT from UTC by ERFA's leap-second table, UT1 = UTC. CCSDS
 * OEM feeds commonly publish EME2000 (NASA's public ISS OEM) or GCRF; both
 * differ from TEME by about 0.4 deg in 2026. Until 0.4.0 every inertial frame
 * went through IAU-76/FK5 with no frame bias (0.94 m off on the paper's
 * example, 9.6 m at 42,164 km in 2026).
 */

#include <array>
#include <string>

namespace od {

// Row-major 3x3 rotation matrix.
using Mat3 = std::array<std::array<double, 3>, 3>;

// Category of an OEM/ephemeris REFERENCE_FRAME token, so both the KVN parser and
// the JSON-record converter classify frames identically.
enum class FrameKind {
    Teme,          // used as-is
    EciJ2000,      // EME2000/J2000 -> rotate via eci_j2000_to_teme
    Gcrf,          // GCRF/ICRF -> rotate via gcrf_to_teme
    Ecef,          // ITRF/IGS20/ECEF/ECF -> rotate via ecef_to_teme
    Unsupported,   // fail-closed
};

/// Classify a REFERENCE_FRAME token (any case). Recognizes the ITRF realizations
/// (ITRF2020/2014/2008/2000/93/…), IGS realizations (IGS20/IGS14/IGb14), and the
/// generic Earth-fixed tokens ECEF/ECF/ITRF/TRF as FrameKind::Ecef.
FrameKind classify_frame(const std::string& token);

/// Rotation matrix R such that r_TEME = R * r_GCRF at the UTC Julian date
/// (foundation/frames gcrfToTeme). All NaN for a date ERFA refuses (before -4799)
/// or a non-finite one.
Mat3 gcrf_to_teme_matrix(double jd_utc);

/// Rotation matrix R such that r_TEME = R * r_EME2000: gcrf_to_teme_matrix times
/// the transpose of the IAU 2006 frame bias.
Mat3 eci_j2000_to_teme_matrix(double jd_utc);

/// Rotate a GCRF/ICRF (gcrf_to_teme) or J2000/EME2000 (eci_j2000_to_teme)
/// position (km) and velocity (km/s) pair into TEME. The inertial-to-TEME
/// rotation rate is < 1e-11 rad/s, so the same rotation is applied to position
/// and velocity (the transport term is < 1e-7 km/s and irrelevant to the fit's
/// initial guess).
void gcrf_to_teme(double jd_utc,
                  const double r_in[3], const double v_in[3],
                  double r_out[3], double v_out[3]);
void eci_j2000_to_teme(double jd_utc,
                       const double r_in[3], const double v_in[3],
                       double r_out[3], double v_out[3]);

// ── ECEF (Earth-fixed) -> TEME ───────────────────────────────────────────────
//
// Some operator/precise-ephemeris feeds publish state in an Earth-fixed frame
// rather than an inertial one: IAC GLONASS precise SP3 (IGS20), ILRS CPF (ITRF),
// Intelsat "ECF". SGP4 propagates in TEME, so those samples must be de-rotated
// out of the Earth's spin before fitting. This module treats every ITRF
// realization (ITRF2020/2014/…, IGS20/IGS14) and generic "ECEF"/"ITRF"/"ECF"
// tokens as one Earth-fixed frame — the inter-realization differences (< 0.1 m
// station coordinates, < 0.03 arcsec orientation) are far below the SGP4 fit
// floor and, being a quasi-constant orientation offset over a multi-hour arc,
// are largely absorbed into the fitted node/orientation rather than the RMS.
//
// EARTH-ROTATION CHOICE: the ECEF<->TEME rotation uses GMST (Greenwich Mean
// Sidereal Time, IAU-1982), NOT GAST. That is TEME's definition (AIAA 2006-6753
// eq. 1: r_PEF = R3(GMST82)·r_TEME), and the inertial legs above are built on
// it: r_TEME = R3(GAST06 - GMST82)·NPB06·r_GCRF, so r_PEF = R3(GAST06)·NPB06·r_GCRF.
//
// POLAR-MOTION POLICY (explicit — never silently pretended): polar motion
// (ITRF->PEF, the sub-arcsecond wobble of the Earth's figure axis) is NEGLECTED
// because there is NO EOP data feed available in-guest. |x_p|,|y_p| ≲ 0.3 arcsec
// bounds the neglected rotation, i.e. ≲ r·1.5e-6 position error: ≲ 0.04 km at
// GLONASS MEO (r≈25510 km), ≲ 0.06 km at GEO (r≈42164 km). Because x_p,y_p drift
// only ~milliarcsec/day, over a multi-hour fit arc this is a quasi-constant
// rotation that is largely absorbed into the fitted orbit orientation, leaving a
// sub-tolerance residual in the fit RMS. Likewise DUT1 (UT1-UTC, |·|<0.9 s) is
// neglected (UT1≈UTC in gmst_1982): it is a constant z-rotation over the arc and
// shifts only the absolute RAAN (≲ 13.5 arcsec ≈ 0.0038°), never the fit RMS or
// the rotation-invariant inclination/eccentricity/semi-major axis. Callers that
// need arcsecond absolute node accuracy must supply EOP; for SGP4 supplemental-GP
// fitting these bounds are documented and below the per-provider tolerance.

/// Greenwich Mean Sidereal Time (IAU-1982), radians in [0, 2pi). UT1 is
/// approximated by UTC (DUT1 neglected, see policy above).
double gmst_1982(double jd_ut1);

/// Rotation matrix R such that r_TEME = R * r_ECEF for the given UTC epoch,
/// i.e. R = R3(-GMST). Polar motion neglected (see policy above); det(R)=1.
Mat3 ecef_to_teme_matrix(double jd_utc);

/// Rotate an Earth-fixed (ECEF/ITRF/IGS20/ECF) position (km) and velocity (km/s)
/// pair into TEME. The velocity carries the Earth-rotation transport term
/// (omega_earth x r_TEME) so a full-state ECEF input transforms correctly; for
/// position-only sources v_in is zero and the returned v_out is the pure
/// transport term (unused by the position-residual fit, which reseeds velocity).
void ecef_to_teme(double jd_utc,
                  const double r_in[3], const double v_in[3],
                  double r_out[3], double v_out[3]);

/// Position-only convenience: r_TEME = R3(-GMST) * r_ECEF.
void ecef_to_teme_pos(double jd_utc, const double r_in[3], double r_out[3]);

}  // namespace od

#endif  // OD_FRAME_TRANSFORM_H
