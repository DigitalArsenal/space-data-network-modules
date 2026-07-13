/**
 * IAU-76/FK5 EME2000(J2000) -> TEME rotation.
 *
 * Chain (Montenbruck & Gill, "Satellite Orbits", 5.3):
 *   J2000 --Precession(IAU-76)--> MOD --Nutation(IAU-1980)--> TOD
 *         --Equation of the equinoxes--> TEME
 *
 *   r_TEME = R3(Eqe) * N(mod->tod) * P(j2000->mod) * r_J2000
 */

#include "od/frame_transform.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <string>

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
    if (u == "EME2000" || u == "J2000" || u == "GCRF" || u == "ICRF")
        return FrameKind::EciJ2000;
    // Earth-fixed: generic tokens + any ITRF/IGS realization (ITRF2020, IGS20, …).
    if (u == "ECEF" || u == "ECF" || u == "ITRF" || u == "TRF" || u == "EARTHFIXED")
        return FrameKind::Ecef;
    if (u.rfind("ITRF", 0) == 0 || u.rfind("IGS", 0) == 0 || u.rfind("IGB", 0) == 0)
        return FrameKind::Ecef;
    return FrameKind::Unsupported;
}

namespace {

constexpr double kArcsecToRad = M_PI / (180.0 * 3600.0);
constexpr double kDegToRad = M_PI / 180.0;

// Passive (coordinate-axis) rotation matrices, Montenbruck & Gill convention:
//   r' = Ri(phi) * r   rotates the coordinate frame by +phi about axis i.

Mat3 rot_x(double phi) {
    const double c = std::cos(phi);
    const double s = std::sin(phi);
    return {{{1.0, 0.0, 0.0},
             {0.0, c, s},
             {0.0, -s, c}}};
}

Mat3 rot_y(double phi) {
    const double c = std::cos(phi);
    const double s = std::sin(phi);
    return {{{c, 0.0, -s},
             {0.0, 1.0, 0.0},
             {s, 0.0, c}}};
}

Mat3 rot_z(double phi) {
    const double c = std::cos(phi);
    const double s = std::sin(phi);
    return {{{c, s, 0.0},
             {-s, c, 0.0},
             {0.0, 0.0, 1.0}}};
}

Mat3 mat_mul(const Mat3& a, const Mat3& b) {
    Mat3 out{};
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            double sum = 0.0;
            for (int k = 0; k < 3; ++k) {
                sum += a[i][k] * b[k][j];
            }
            out[i][j] = sum;
        }
    }
    return out;
}

double norm_rad(double angle) {
    double two_pi = 2.0 * M_PI;
    double r = std::fmod(angle, two_pi);
    if (r < 0.0) r += two_pi;
    return r;
}

// IAU-1980 nutation fundamental arguments (radians) from T (Julian centuries).
struct DelaunayArgs {
    double l;      // Moon mean anomaly
    double lp;     // Sun mean anomaly
    double f;      // Moon mean argument of latitude
    double d;      // Mean elongation Moon from Sun
    double omega;  // Moon ascending-node longitude
};

DelaunayArgs delaunay(double t) {
    const double t2 = t * t;
    const double t3 = t2 * t;
    DelaunayArgs a{};
    a.l = norm_rad((134.96298139 + 477198.867398 * t + 0.0086972 * t2 +
                    t3 / 56250.0) * kDegToRad);
    a.lp = norm_rad((357.52772333 + 35999.050340 * t - 0.0001603 * t2 -
                     t3 / 300000.0) * kDegToRad);
    a.f = norm_rad((93.27191028 + 483202.017538 * t - 0.0036825 * t2 +
                    t3 / 327270.0) * kDegToRad);
    a.d = norm_rad((297.85036306 + 445267.111480 * t - 0.0019142 * t2 +
                    t3 / 189474.0) * kDegToRad);
    a.omega = norm_rad((125.04452222 - 1934.136261 * t + 0.0020708 * t2 +
                        t3 / 450000.0) * kDegToRad);
    return a;
}

// Ten leading IAU-1980 nutation terms. Coefficients in 1e-4 arcsec.
// Columns: l l' F D Omega | Dpsi(sin) A A'T | Deps(cos) B B'T
struct NutTerm {
    int nl, nlp, nf, nd, nom;
    double ps, pst;  // Dpsi = (ps + pst*T) * 1e-4 arcsec * sin(arg)
    double ec, ect;  // Deps = (ec + ect*T) * 1e-4 arcsec * cos(arg)
};

constexpr NutTerm kNut[] = {
    {0, 0, 0, 0, 1, -171996.0, -174.2, 92025.0, 8.9},
    {0, 0, 2, -2, 2, -13187.0, -1.6, 5736.0, -3.1},
    {0, 0, 2, 0, 2, -2274.0, -0.2, 977.0, -0.5},
    {0, 0, 0, 0, 2, 2062.0, 0.2, -895.0, 0.5},
    {0, 1, 0, 0, 0, 1426.0, -3.4, 54.0, -0.1},
    {1, 0, 0, 0, 0, 712.0, 0.1, -7.0, 0.0},
    {0, 1, 2, -2, 2, -517.0, 1.2, 224.0, -0.6},
    {0, 0, 2, 0, 1, -386.0, -0.4, 200.0, 0.0},
    {1, 0, 2, 0, 2, -301.0, 0.0, 129.0, -0.1},
    {0, -1, 2, -2, 2, 217.0, -0.5, -95.0, 0.3},
};

}  // namespace

Mat3 eci_j2000_to_teme_matrix(double jd_utc) {
    const double t = (jd_utc - 2451545.0) / 36525.0;
    const double t2 = t * t;
    const double t3 = t2 * t;

    // IAU-76 precession angles (arcsec -> rad).
    const double zeta = (2306.2181 * t + 0.30188 * t2 + 0.017998 * t3) * kArcsecToRad;
    const double theta = (2004.3109 * t - 0.42665 * t2 - 0.041833 * t3) * kArcsecToRad;
    const double z = (2306.2181 * t + 1.09468 * t2 + 0.018203 * t3) * kArcsecToRad;

    // P: J2000 -> MOD  (Montenbruck & Gill 5.47)
    const Mat3 precession = mat_mul(rot_z(-z), mat_mul(rot_y(theta), rot_z(-zeta)));

    // Mean obliquity of date (IAU-1980), arcsec -> rad.
    const double eps_mean = (84381.448 - 46.8150 * t - 0.00059 * t2 +
                             0.001813 * t3) * kArcsecToRad;

    // Nutation in longitude / obliquity (truncated IAU-1980 series).
    const DelaunayArgs arg = delaunay(t);
    double dpsi = 0.0;
    double deps = 0.0;
    for (const auto& term : kNut) {
        const double a = term.nl * arg.l + term.nlp * arg.lp + term.nf * arg.f +
                         term.nd * arg.d + term.nom * arg.omega;
        dpsi += (term.ps + term.pst * t) * std::sin(a);
        deps += (term.ec + term.ect * t) * std::cos(a);
    }
    dpsi *= 1.0e-4 * kArcsecToRad;
    deps *= 1.0e-4 * kArcsecToRad;
    const double eps_true = eps_mean + deps;

    // N: MOD -> TOD  (Montenbruck & Gill 5.63)
    const Mat3 nutation = mat_mul(rot_x(-eps_true), mat_mul(rot_z(-dpsi), rot_x(eps_mean)));

    // Equation of the equinoxes (1982): rotate TOD -> TEME about the pole.
    const double eqe = dpsi * std::cos(eps_mean);
    const Mat3 eqe_rot = rot_z(eqe);

    return mat_mul(eqe_rot, mat_mul(nutation, precession));
}

void eci_j2000_to_teme(double jd_utc,
                       const double r_in[3], const double v_in[3],
                       double r_out[3], double v_out[3]) {
    const Mat3 r = eci_j2000_to_teme_matrix(jd_utc);
    for (int i = 0; i < 3; ++i) {
        r_out[i] = r[i][0] * r_in[0] + r[i][1] * r_in[1] + r[i][2] * r_in[2];
        v_out[i] = r[i][0] * v_in[0] + r[i][1] * v_in[1] + r[i][2] * v_in[2];
    }
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
