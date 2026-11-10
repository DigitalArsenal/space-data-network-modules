/**
 * Inertial and Earth-fixed ingest frames -> TEME.
 *
 * TEME is the frame SGP4 writes, as AIAA 2006-6753 defines it (Vallado,
 * Crawford, Hujsak, Kelso, sec. II.D eq. 1): r_PEF = R3(GMST82) r_TEME. The
 * inertial legs are foundation/frames' axis engine, the one definition in the
 * repository:
 *   GCRF/ICRF       r_TEME = R3(GAST06 - GMST82) NPB06 r_GCRF   (gcrfToTeme)
 *   EME2000/J2000   r_GCRF = B' r_EME2000, the IAU 2006 frame bias (gcrfToMj2000Eq)
 * at TT from UTC by ERFA's leap-second table, UT1 = UTC (no EOP in-guest).
 * Until 0.4.0 this file took every inertial frame through IAU-76/FK5
 * (R3(dpsi cos eps) N80 P76, no frame bias): 0.94 m off on the paper's example,
 * 9.6 m at 42,164 km in 2026.
 */

#include "od/frame_transform.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <limits>
#include <string>

extern "C" {
#include "erfa.h"
#include "erfam.h"
}
#include "axis_engine.hpp"

namespace od {

FrameKind classify_frame(const std::string& token) {
    std::string u;
    u.reserve(token.size());
    for (char c : token) {
        if (c == ' ' || c == '_' || c == '-' || c == '(' || c == ')') continue;
        u.push_back(static_cast<char>(std::toupper(static_cast<unsigned char>(c))));
    }
    if (u.empty()) return FrameKind::Unsupported;
    if (u == "TEME" || u == "TRUEEQUATORMEANEQUINOX") return FrameKind::Teme;
    if (u == "GCRF" || u == "ICRF") return FrameKind::Gcrf;
    if (u == "EME2000" || u == "J2000") return FrameKind::EciJ2000;
    // Earth-fixed: generic tokens + any ITRF/IGS realization (ITRF2020, IGS20, …).
    if (u == "ECEF" || u == "ECF" || u == "ITRF" || u == "TRF" || u == "EARTHFIXED")
        return FrameKind::Ecef;
    if (u.rfind("ITRF", 0) == 0 || u.rfind("IGS", 0) == 0 || u.rfind("IGB", 0) == 0)
        return FrameKind::Ecef;
    return FrameKind::Unsupported;
}

namespace {

// Passive (coordinate-axis) rotation about z, Montenbruck & Gill convention:
//   r' = R3(phi) * r   rotates the coordinate frame by +phi about z.
Mat3 rot_z(double phi) {
    const double c = std::cos(phi);
    const double s = std::sin(phi);
    return {{{c, s, 0.0},
             {-s, c, 0.0},
             {0.0, 0.0, 1.0}}};
}

double norm_rad(double angle) {
    double two_pi = 2.0 * M_PI;
    double r = std::fmod(angle, two_pi);
    if (r < 0.0) r += two_pi;
    return r;
}

// The axis-engine epoch of a UTC Julian date: TT through ERFA's leap-second
// table (its "dubious" years included), UT1 = UTC in the same two-part split.
// False only for a date ERFA refuses outright (before -4799) or a non-finite one.
bool epoch_of(double jd_utc, sdn::frames::Epoch* e) {
    if (!std::isfinite(jd_utc)) return false;
    const double day = std::floor(jd_utc - 0.5) + 0.5;
    const double fraction = jd_utc - day;
    double tai1 = 0.0, tai2 = 0.0;
    if (eraUtctai(day, fraction, &tai1, &tai2) < 0) return false;
    if (eraTaitt(tai1, tai2, &e->tt1, &e->tt2) != 0) return false;
    e->ut11 = day;
    e->ut12 = fraction;
    return true;
}

Mat3 to_mat3(const sdn::frames::Mat3& m) {
    Mat3 out{};
    for (int i = 0; i < 3; ++i)
        for (int j = 0; j < 3; ++j) out[i][j] = m.m[i][j];
    return out;
}

Mat3 nan_matrix() {
    Mat3 out{};
    for (auto& row : out) row.fill(std::numeric_limits<double>::quiet_NaN());
    return out;
}

void apply(const Mat3& r, const double r_in[3], const double v_in[3], double r_out[3], double v_out[3]) {
    for (int i = 0; i < 3; ++i) {
        r_out[i] = r[i][0] * r_in[0] + r[i][1] * r_in[1] + r[i][2] * r_in[2];
        v_out[i] = r[i][0] * v_in[0] + r[i][1] * v_in[1] + r[i][2] * v_in[2];
    }
}

}  // namespace

Mat3 gcrf_to_teme_matrix(double jd_utc) {
    sdn::frames::Epoch e;
    if (!epoch_of(jd_utc, &e)) return nan_matrix();
    return to_mat3(sdn::frames::gcrfToTeme(e));
}

Mat3 eci_j2000_to_teme_matrix(double jd_utc) {
    sdn::frames::Epoch e;
    if (!epoch_of(jd_utc, &e)) return nan_matrix();
    // r_TEME = T B' r_EME2000.
    return to_mat3(sdn::frames::multiply(sdn::frames::gcrfToTeme(e),
                                         sdn::frames::transpose(sdn::frames::gcrfToMj2000Eq(e))));
}

void gcrf_to_teme(double jd_utc,
                  const double r_in[3], const double v_in[3],
                  double r_out[3], double v_out[3]) {
    apply(gcrf_to_teme_matrix(jd_utc), r_in, v_in, r_out, v_out);
}

void eci_j2000_to_teme(double jd_utc,
                       const double r_in[3], const double v_in[3],
                       double r_out[3], double v_out[3]) {
    apply(eci_j2000_to_teme_matrix(jd_utc), r_in, v_in, r_out, v_out);
}

// ── ECEF (Earth-fixed) -> TEME ───────────────────────────────────────────────
// See frame_transform.h for the GMST-not-GAST rationale and the explicit
// polar-motion/DUT1 neglect policy with error bounds.

// omega_earth (rad/s): the WGS-72 Earth rotation rate the Vallado SGP4 propagator
// uses (SGP4.cpp: 7.29211514668855e-5), reused verbatim so the transport term is
// consistent with the propagation frame.
constexpr double kOmegaEarth = 7.29211514668855e-5;

double gmst_1982(double jd_ut1) {
    const double t = (jd_ut1 - 2451545.0) / 36525.0;
    // GMST in seconds of time (IAU-1982; Vallado "Fundamentals" Eq. 3-47).
    // 876600 h = 876600*3600 s is folded into the T coefficient.
    double gmst_sec = 67310.54841 +
                      (876600.0 * 3600.0 + 8640184.812866) * t +
                      0.093104 * t * t -
                      6.2e-6 * t * t * t;
    // Reduce seconds of time modulo one sidereal-day worth of seconds, then
    // convert seconds-of-time -> degrees (/240) -> radians.
    double sec = std::fmod(gmst_sec, 86400.0);
    if (sec < 0.0) sec += 86400.0;
    double rad = sec * (M_PI / 180.0) / 240.0;
    return norm_rad(rad);
}

Mat3 ecef_to_teme_matrix(double jd_utc) {
    // r_PEF = R3(GMST)·r_TEME  =>  r_TEME = R3(-GMST)·r_PEF; polar motion (PEF vs
    // ITRF) neglected, so r_ECEF ≈ r_PEF. rot_z is the passive rotation, so the
    // passive rotation by -GMST maps ECEF components into TEME.
    return rot_z(-gmst_1982(jd_utc));
}

void ecef_to_teme(double jd_utc,
                  const double r_in[3], const double v_in[3],
                  double r_out[3], double v_out[3]) {
    const Mat3 r = ecef_to_teme_matrix(jd_utc);
    for (int i = 0; i < 3; ++i) {
        r_out[i] = r[i][0] * r_in[0] + r[i][1] * r_in[1] + r[i][2] * r_in[2];
    }
    // Rotate the Earth-fixed velocity into TEME, then add the transport term
    // omega x r_TEME (omega = +z*omega_earth in TEME): v_TEME = R·v_ECEF + w x r.
    double v_rot[3];
    for (int i = 0; i < 3; ++i) {
        v_rot[i] = r[i][0] * v_in[0] + r[i][1] * v_in[1] + r[i][2] * v_in[2];
    }
    v_out[0] = v_rot[0] - kOmegaEarth * r_out[1];
    v_out[1] = v_rot[1] + kOmegaEarth * r_out[0];
    v_out[2] = v_rot[2];
}

void ecef_to_teme_pos(double jd_utc, const double r_in[3], double r_out[3]) {
    const Mat3 r = ecef_to_teme_matrix(jd_utc);
    for (int i = 0; i < 3; ++i) {
        r_out[i] = r[i][0] * r_in[0] + r[i][1] * r_in[1] + r[i][2] * r_in[2];
    }
}

}  // namespace od
