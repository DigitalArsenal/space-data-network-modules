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

// Normalize an angle into the range [-pi, +pi) (SOFA/ERFA eraAnpm).
double anpm(double a) {
    double w = std::fmod(a, 2.0 * M_PI);
    if (std::abs(w) >= M_PI) w -= std::copysign(2.0 * M_PI, a);
    return w;
}

// FULL 106-term IAU-1980 (Wahr 1980) nutation series, transcribed VERBATIM from
// SOFA/ERFA `eraNut80` (erfa/nut80.c, "Derived, with permission, from the SOFA
// library"); ultimate reference: Explanatory Supplement to the Astronomical
// Almanac, P. K. Seidelmann (ed), §3.222 (p111). Columns: multipliers of the
// five Delaunay arguments l l' F D Omega, then the longitude sine coefficient
// (sp + spt*T) and the obliquity cosine coefficient (ce + cet*T). Coefficient
// units are 0.1 milliarcsecond (1e-4 arcsec) and the same per Julian century.
// This REPLACES the former 10-term truncation (A2.4b): the omitted 96 terms are
// what cost ~13 m on the ISS EME2000->TEME conversion.
struct NutTerm {
    int nl, nlp, nf, nd, nom;
    double sp, spt;  // Dpsi = (sp + spt*T) * 1e-4 arcsec * sin(arg)
    double ce, cet;  // Deps = (ce + cet*T) * 1e-4 arcsec * cos(arg)
};

constexpr NutTerm kNut[] = {
    /* 1-10 */
    {  0,  0,  0,  0,  1, -171996.0, -174.2,  92025.0,    8.9 },
    {  0,  0,  0,  0,  2,    2062.0,    0.2,   -895.0,    0.5 },
    { -2,  0,  2,  0,  1,      46.0,    0.0,    -24.0,    0.0 },
    {  2,  0, -2,  0,  0,      11.0,    0.0,      0.0,    0.0 },
    { -2,  0,  2,  0,  2,      -3.0,    0.0,      1.0,    0.0 },
    {  1, -1,  0, -1,  0,      -3.0,    0.0,      0.0,    0.0 },
    {  0, -2,  2, -2,  1,      -2.0,    0.0,      1.0,    0.0 },
    {  2,  0, -2,  0,  1,       1.0,    0.0,      0.0,    0.0 },
    {  0,  0,  2, -2,  2,  -13187.0,   -1.6,   5736.0,   -3.1 },
    {  0,  1,  0,  0,  0,    1426.0,   -3.4,     54.0,   -0.1 },
    /* 11-20 */
    {  0,  1,  2, -2,  2,    -517.0,    1.2,    224.0,   -0.6 },
    {  0, -1,  2, -2,  2,     217.0,   -0.5,    -95.0,    0.3 },
    {  0,  0,  2, -2,  1,     129.0,    0.1,    -70.0,    0.0 },
    {  2,  0,  0, -2,  0,      48.0,    0.0,      1.0,    0.0 },
    {  0,  0,  2, -2,  0,     -22.0,    0.0,      0.0,    0.0 },
    {  0,  2,  0,  0,  0,      17.0,   -0.1,      0.0,    0.0 },
    {  0,  1,  0,  0,  1,     -15.0,    0.0,      9.0,    0.0 },
    {  0,  2,  2, -2,  2,     -16.0,    0.1,      7.0,    0.0 },
    {  0, -1,  0,  0,  1,     -12.0,    0.0,      6.0,    0.0 },
    { -2,  0,  0,  2,  1,      -6.0,    0.0,      3.0,    0.0 },
    /* 21-30 */
    {  0, -1,  2, -2,  1,      -5.0,    0.0,      3.0,    0.0 },
    {  2,  0,  0, -2,  1,       4.0,    0.0,     -2.0,    0.0 },
    {  0,  1,  2, -2,  1,       4.0,    0.0,     -2.0,    0.0 },
    {  1,  0,  0, -1,  0,      -4.0,    0.0,      0.0,    0.0 },
    {  2,  1,  0, -2,  0,       1.0,    0.0,      0.0,    0.0 },
    {  0,  0, -2,  2,  1,       1.0,    0.0,      0.0,    0.0 },
    {  0,  1, -2,  2,  0,      -1.0,    0.0,      0.0,    0.0 },
    {  0,  1,  0,  0,  2,       1.0,    0.0,      0.0,    0.0 },
    { -1,  0,  0,  1,  1,       1.0,    0.0,      0.0,    0.0 },
    {  0,  1,  2, -2,  0,      -1.0,    0.0,      0.0,    0.0 },
    /* 31-40 */
    {  0,  0,  2,  0,  2,   -2274.0,   -0.2,    977.0,   -0.5 },
    {  1,  0,  0,  0,  0,     712.0,    0.1,     -7.0,    0.0 },
    {  0,  0,  2,  0,  1,    -386.0,   -0.4,    200.0,    0.0 },
    {  1,  0,  2,  0,  2,    -301.0,    0.0,    129.0,   -0.1 },
    {  1,  0,  0, -2,  0,    -158.0,    0.0,     -1.0,    0.0 },
    { -1,  0,  2,  0,  2,     123.0,    0.0,    -53.0,    0.0 },
    {  0,  0,  0,  2,  0,      63.0,    0.0,     -2.0,    0.0 },
    {  1,  0,  0,  0,  1,      63.0,    0.1,    -33.0,    0.0 },
    { -1,  0,  0,  0,  1,     -58.0,   -0.1,     32.0,    0.0 },
    { -1,  0,  2,  2,  2,     -59.0,    0.0,     26.0,    0.0 },
    /* 41-50 */
    {  1,  0,  2,  0,  1,     -51.0,    0.0,     27.0,    0.0 },
    {  0,  0,  2,  2,  2,     -38.0,    0.0,     16.0,    0.0 },
    {  2,  0,  0,  0,  0,      29.0,    0.0,     -1.0,    0.0 },
    {  1,  0,  2, -2,  2,      29.0,    0.0,    -12.0,    0.0 },
    {  2,  0,  2,  0,  2,     -31.0,    0.0,     13.0,    0.0 },
    {  0,  0,  2,  0,  0,      26.0,    0.0,     -1.0,    0.0 },
    { -1,  0,  2,  0,  1,      21.0,    0.0,    -10.0,    0.0 },
    { -1,  0,  0,  2,  1,      16.0,    0.0,     -8.0,    0.0 },
    {  1,  0,  0, -2,  1,     -13.0,    0.0,      7.0,    0.0 },
    { -1,  0,  2,  2,  1,     -10.0,    0.0,      5.0,    0.0 },
    /* 51-60 */
    {  1,  1,  0, -2,  0,      -7.0,    0.0,      0.0,    0.0 },
    {  0,  1,  2,  0,  2,       7.0,    0.0,     -3.0,    0.0 },
    {  0, -1,  2,  0,  2,      -7.0,    0.0,      3.0,    0.0 },
    {  1,  0,  2,  2,  2,      -8.0,    0.0,      3.0,    0.0 },
    {  1,  0,  0,  2,  0,       6.0,    0.0,      0.0,    0.0 },
    {  2,  0,  2, -2,  2,       6.0,    0.0,     -3.0,    0.0 },
    {  0,  0,  0,  2,  1,      -6.0,    0.0,      3.0,    0.0 },
    {  0,  0,  2,  2,  1,      -7.0,    0.0,      3.0,    0.0 },
    {  1,  0,  2, -2,  1,       6.0,    0.0,     -3.0,    0.0 },
    {  0,  0,  0, -2,  1,      -5.0,    0.0,      3.0,    0.0 },
    /* 61-70 */
    {  1, -1,  0,  0,  0,       5.0,    0.0,      0.0,    0.0 },
    {  2,  0,  2,  0,  1,      -5.0,    0.0,      3.0,    0.0 },
    {  0,  1,  0, -2,  0,      -4.0,    0.0,      0.0,    0.0 },
    {  1,  0, -2,  0,  0,       4.0,    0.0,      0.0,    0.0 },
    {  0,  0,  0,  1,  0,      -4.0,    0.0,      0.0,    0.0 },
    {  1,  1,  0,  0,  0,      -3.0,    0.0,      0.0,    0.0 },
    {  1,  0,  2,  0,  0,       3.0,    0.0,      0.0,    0.0 },
    {  1, -1,  2,  0,  2,      -3.0,    0.0,      1.0,    0.0 },
    { -1, -1,  2,  2,  2,      -3.0,    0.0,      1.0,    0.0 },
    { -2,  0,  0,  0,  1,      -2.0,    0.0,      1.0,    0.0 },
    /* 71-80 */
    {  3,  0,  2,  0,  2,      -3.0,    0.0,      1.0,    0.0 },
    {  0, -1,  2,  2,  2,      -3.0,    0.0,      1.0,    0.0 },
    {  1,  1,  2,  0,  2,       2.0,    0.0,     -1.0,    0.0 },
    { -1,  0,  2, -2,  1,      -2.0,    0.0,      1.0,    0.0 },
    {  2,  0,  0,  0,  1,       2.0,    0.0,     -1.0,    0.0 },
    {  1,  0,  0,  0,  2,      -2.0,    0.0,      1.0,    0.0 },
    {  3,  0,  0,  0,  0,       2.0,    0.0,      0.0,    0.0 },
    {  0,  0,  2,  1,  2,       2.0,    0.0,     -1.0,    0.0 },
    { -1,  0,  0,  0,  2,       1.0,    0.0,     -1.0,    0.0 },
    {  1,  0,  0, -4,  0,      -1.0,    0.0,      0.0,    0.0 },
    /* 81-90 */
    { -2,  0,  2,  2,  2,       1.0,    0.0,     -1.0,    0.0 },
    { -1,  0,  2,  4,  2,      -2.0,    0.0,      1.0,    0.0 },
    {  2,  0,  0, -4,  0,      -1.0,    0.0,      0.0,    0.0 },
    {  1,  1,  2, -2,  2,       1.0,    0.0,     -1.0,    0.0 },
    {  1,  0,  2,  2,  1,      -1.0,    0.0,      1.0,    0.0 },
    { -2,  0,  2,  4,  2,      -1.0,    0.0,      1.0,    0.0 },
    { -1,  0,  4,  0,  2,       1.0,    0.0,      0.0,    0.0 },
    {  1, -1,  0, -2,  0,       1.0,    0.0,      0.0,    0.0 },
    {  2,  0,  2, -2,  1,       1.0,    0.0,     -1.0,    0.0 },
    {  2,  0,  2,  2,  2,      -1.0,    0.0,      0.0,    0.0 },
    /* 91-100 */
    {  1,  0,  0,  2,  1,      -1.0,    0.0,      0.0,    0.0 },
    {  0,  0,  4, -2,  2,       1.0,    0.0,      0.0,    0.0 },
    {  3,  0,  2, -2,  2,       1.0,    0.0,      0.0,    0.0 },
    {  1,  0,  2, -2,  0,      -1.0,    0.0,      0.0,    0.0 },
    {  0,  1,  2,  0,  1,       1.0,    0.0,      0.0,    0.0 },
    { -1, -1,  0,  2,  1,       1.0,    0.0,      0.0,    0.0 },
    {  0,  0, -2,  0,  1,      -1.0,    0.0,      0.0,    0.0 },
    {  0,  0,  2, -1,  2,      -1.0,    0.0,      0.0,    0.0 },
    {  0,  1,  0,  2,  0,      -1.0,    0.0,      0.0,    0.0 },
    {  1,  0, -2, -2,  0,      -1.0,    0.0,      0.0,    0.0 },
    /* 101-106 */
    {  0, -1,  2,  0,  1,      -1.0,    0.0,      0.0,    0.0 },
    {  1,  1,  0, -2,  1,      -1.0,    0.0,      0.0,    0.0 },
    {  1,  0, -2,  2,  0,      -1.0,    0.0,      0.0,    0.0 },
    {  2,  0,  0,  2,  0,       1.0,    0.0,      0.0,    0.0 },
    {  0,  0,  2,  4,  2,      -1.0,    0.0,      0.0,    0.0 },
    {  0,  1,  0,  1,  0,       1.0,    0.0,      0.0,    0.0 },
};

}  // namespace

// FULL IAU-1980 nutation (106 terms), radians. t = Julian centuries of TT from
// J2000.0. Faithful transcription of SOFA/ERFA eraNut80: identical fundamental
// arguments (integer revolutions folded via fmod for precision), identical
// coefficient table, and the same smallest-term-first summation order. Exposed
// for the reference-value pin in test_frame_time_fit.
void iau1980_nutation(double t, double& dpsi, double& deps) {
    // Fundamental (Delaunay) arguments, radians (Explanatory Supplement §3.222 /
    // SOFA eraNut80). Coefficients in arcsec; integer revolutions per century
    // (1325, 99, 1342, 1236, -5) folded separately to preserve precision.
    const double el = anpm(
        (485866.733 + (715922.633 + (31.310 + 0.064 * t) * t) * t) * kArcsecToRad +
        std::fmod(1325.0 * t, 1.0) * (2.0 * M_PI));
    const double elp = anpm(
        (1287099.804 + (1292581.224 + (-0.577 - 0.012 * t) * t) * t) * kArcsecToRad +
        std::fmod(99.0 * t, 1.0) * (2.0 * M_PI));
    const double f = anpm(
        (335778.877 + (295263.137 + (-13.257 + 0.011 * t) * t) * t) * kArcsecToRad +
        std::fmod(1342.0 * t, 1.0) * (2.0 * M_PI));
    const double d = anpm(
        (1072261.307 + (1105601.328 + (-6.891 + 0.019 * t) * t) * t) * kArcsecToRad +
        std::fmod(1236.0 * t, 1.0) * (2.0 * M_PI));
    const double om = anpm(
        (450160.280 + (-482890.539 + (7.455 + 0.008 * t) * t) * t) * kArcsecToRad +
        std::fmod(-5.0 * t, 1.0) * (2.0 * M_PI));

    double dp = 0.0;
    double de = 0.0;
    // Sum smallest terms first (ERFA order: table runs biggest-last), so the
    // dominant Omega term is accumulated last — minimizes floating-point error.
    for (int j = static_cast<int>(sizeof(kNut) / sizeof(kNut[0])) - 1; j >= 0; --j) {
        const NutTerm& x = kNut[j];
        const double arg = x.nl * el + x.nlp * elp + x.nf * f + x.nd * d + x.nom * om;
        const double s = x.sp + x.spt * t;
        const double c = x.ce + x.cet * t;
        if (s != 0.0) dp += s * std::sin(arg);
        if (c != 0.0) de += c * std::cos(arg);
    }
    // 0.1 mas (1e-4 arcsec) units -> radians.
    dpsi = dp * 1.0e-4 * kArcsecToRad;
    deps = de * 1.0e-4 * kArcsecToRad;
}

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

    // Nutation in longitude / obliquity (FULL 106-term IAU-1980 series). TT-UTC
    // is neglected (t from UTC), consistent with the precession term above: the
    // fastest nutation argument shifts < 1e-5 arcsec over the ~69 s TT-UTC gap.
    double dpsi = 0.0;
    double deps = 0.0;
    iau1980_nutation(t, dpsi, deps);
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
