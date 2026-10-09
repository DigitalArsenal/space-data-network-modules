// jacchia_roberts.h - Jacchia-Roberts thermospheric density
// =============================================================================
// Jacchia's static diffusion model (SAO Special Reports 313, 1970, and 332,
// 1971): the exospheric temperature from F10.7 (Tc = 379 + 3.24 F10.7bar +
// 1.3 (F10.7 - F10.7bar)), its diurnal variation and the geomagnetic term in
// Kp, and the diffusion profile above 90 km; with the semiannual and
// seasonal-latitudinal corrections. Roberts, "An Analytic Model for Upper
// Atmosphere Densities Based upon Jacchia's 1970 Models", Celestial Mechanics
// 4 (1971) 368-377, integrates the profile in closed form, replacing
// Jacchia's arctangent temperature profile above 125 km by an exponential
// one fitted to it. This is the evaluation NASA GTDS and GMAT use
// ("Jacchia-Roberts"), and its constants are Jacchia 1971's: the inflection
// temperature Tx = 371.6678 + 0.0518806 Tinf - 294.3505 exp(-0.00216222 Tinf)
// and 27.64 for the mean molecular mass at 100 km (SR 313 has Tx = 444.3807
// + 0.02385 Tinf - 392.8292 exp(-0.0021357 Tinf) and 28.15).
//
// Checked independently (tests/atmosphere_ports_native.cpp, "integrate"):
// the diffusion equations integrated numerically from 90 km with the same
// constants reproduce this file to 0.02 % with Roberts' temperature profile,
// and to 4.3 % (2 % from 300 km) with Jacchia's arctangent profile
// (Tinf 700-1500 K, 200-500 km), so the closed forms and the fit are what
// the model claims.
//
// A C++ port of the density functions of NASA GMAT's
// src/base/solarsys/JacchiaRobertsAtmosphere.cpp (Copyright (c) 2002-2026
// United States Government as represented by the Administrator of NASA,
// Apache License, Version 2.0; derived from the Swingby code): JacchiaRoberts,
// exotherm, rho_100, rho_125, rho_cor, rho_high, roots and
// deflate_polynomial, unchanged in arithmetic. Changes: the flux-file
// handling is left to the caller (Inputs); the Sun and the point are given
// in Earth-fixed axes (the hour angle and declination GMAT takes from true
// of date vectors are the same there to polar motion); the Earth's polar
// radius is a parameter; below 90 km the 90 km density is returned, and
// GMAT's refusal below 100 km is the caller's choice; with the Sun exactly on
// the equator the helium term takes the sign of the declination as 0 where
// GMAT computes 0/0.
#pragma once
#include <cmath>

namespace astro {
namespace jacchia_roberts {

/// Model drivers at one instant: F10.7 of the previous day and its 81-day
/// centred average (SFU) and the three-hour Kp 6.7 hours earlier.
struct Inputs {
    double f107, f107a, kp;
};

namespace detail {
constexpr double PI = 3.14159265358979323846;
constexpr double RHO_ZERO = 3.46e-9;      // g/cm^3 at 90 km
constexpr double TZERO = 183.0;           // K at 90 km
constexpr double G_ZERO = 9.80665;        // m/s^2
constexpr double GAS_CON = 8.31432;       // J/(K mol)
constexpr double AVOGADRO = 6.022045e23;
constexpr double CON_C[5] = {-89284375.0, 3542400.0, -52687.5, 340.5, -0.8};
constexpr double CON_L[5] = {0.1031445e5, 0.2341230e1, 0.1579202e-2, -0.1252487e-5, 0.2462708e-9};
constexpr double MZERO = 28.82678;
constexpr double M_CON[7] = {-435093.363387, 28275.5646391, -765.33466108, 11.043387545,
                             -0.08958790995, 0.00038737586, -0.000000697444};
constexpr double S_CON[6] = {3144902516.672729, -123774885.4832917, 1816141.096520398,
                             -11403.31079489267, 24.36498612105595, 0.008957502869707995};
constexpr double S_BETA[6] = {-52864482.17910969, -16632.50847336828, -1.308252378125, 0.0, 0.0, 0.0};
constexpr double OMEGA = -0.94585589;
constexpr double ZETA_CON[7] = {0.1985549e-10, -0.1833490e-14, 0.1711735e-17, -0.1021474e-20,
                                0.3727894e-24, -0.7734110e-28, 0.7026942e-32};
constexpr double MOL_MASS[6] = {28.0134, 39.948, 4.0026, 31.9988, 15.9994, 1.00797};
constexpr double NUM_DENS[5] = {0.78110, 0.93432e-2, 0.61471e-5, 0.161778, 0.95544e-1};
constexpr double CON_DEN[5][7] = {
    {0.1093155e2, 0.1186783e-2, -0.1677341e-5, 0.1420228e-8, -0.7139785e-12, 0.1969715e-15, -0.2296182e-19},
    {0.8049405e1, 0.2382822e-2, -0.3391366e-5, 0.2909714e-8, -0.1481702e-11, 0.4127600e-15, -0.4837461e-19},
    {0.7646886e1, -0.4383486e-3, 0.4694319e-6, -0.2894886e-9, 0.9451989e-13, -0.1270838e-16, 0.0},
    {0.9924237e1, 0.1600311e-2, -0.2274761e-5, 0.1938454e-8, -0.9782183e-12, 0.2698450e-15, -0.3131808e-19},
    {0.1097083e2, 0.6118742e-4, -0.1165003e-6, 0.9239354e-10, -0.3490739e-13, 0.5116298e-17, 0.0}};
constexpr double REAL_TOL = 1.0e-15;      // GmatRealConstants::REAL_TOL

// GMAT's per-evaluation state (members of JacchiaRobertsAtmosphere).
struct State {
    double root1 = 0, root2 = 0, x_root = 0, y_root = 0, t_infinity = 0, tx = 0, sum = 0;
    double cbPolarRadius = 0, cbPolarSquared = 0;
    double xtemp = 0, tkp = 0;  // GEOPARMS
};

inline void roots(const double a[], int na, double croots[][2], int irl) {
    int i, ir, n1, n2, j;
    double z[2], zs[2], cb[2], cc[2], dif, denom, temp;
    ir = 0; n1 = na - 1; n2 = n1 - 1; dif = 0.0;
    while (ir < irl) {
        z[0] = croots[ir][0]; z[1] = croots[ir][1];
        do {
            cb[0] = a[n1]; cb[1] = 0; cc[0] = a[n1]; cc[1] = 0;
            for (i = 0; i <= n2; ++i) {
                j = n2 - i;
                temp = (z[0] * cb[0] - z[1] * cb[1]) + a[j];
                cb[1] = z[0] * cb[1] + z[1] * cb[0];
                cb[0] = temp;
                if (j != 0) {
                    temp = (z[0] * cc[0] - z[1] * cc[1]) + cb[0];
                    cc[1] = (z[0] * cc[1] + z[1] * cc[0]) + cb[1];
                    cc[0] = temp;
                }
            }
            zs[0] = z[0]; zs[1] = z[1];
            denom = cc[0] * cc[0] + cc[1] * cc[1];
            z[0] -= ((cb[0] * cc[0] + cb[1] * cc[1]) / denom);
            z[1] += ((cb[0] * cc[1] - cb[1] * cc[0]) / denom);
            dif = std::fabs((zs[0] - z[0]) / zs[0]);
            if (zs[1] != 0.0) dif += std::fabs((zs[1] - z[1]) / zs[1]);
        } while (dif > 1.0E-14);
        croots[ir][0] = z[0]; croots[ir][1] = z[1];
        ++ir;
    }
}

inline void deflate_polynomial(const double c[], int n, double root, double c_new[]) {
    double sum = c[n - 1], save;
    for (int i = n - 2; i >= 0; i--) {
        save = c[i];
        c_new[i] = sum;
        sum = save + sum * root;
    }
}

// Returns false where GMAT throws (the point on the Sun's meridian plane
// through the pole axis, or on the axis).
inline bool exotherm(State& s, const double space_craft[3], const double sun[3], double height,
                     double sun_dec, double geo_lat, double& exotemp) {
    double hour_angle, cross_denom, theta, eta, tau, th22, t1, sun_denom, cos_denom, expkp;
    double c_star[5], aux[4][2];
    const int na = 5;
    sun_denom = std::sqrt(sun[0] * sun[0] + sun[1] * sun[1]);
    cross_denom = std::fabs(sun[0] * space_craft[1] - sun[1] * space_craft[0]);
    cos_denom = std::sqrt(space_craft[0] * space_craft[0] + space_craft[1] * space_craft[1]);
    if ((cross_denom < REAL_TOL) || (cos_denom < REAL_TOL)) return false;
    const double errorTolerance = 1.0e-14;
    const double cosAlpha = (sun[0] * space_craft[0] + sun[1] * space_craft[1]) / (sun_denom * cos_denom);
    if (cosAlpha >= 1.0 - errorTolerance) hour_angle = 0.0;
    else if (cosAlpha <= -1.0 + errorTolerance)
        hour_angle = ((sun[0] * space_craft[1] - sun[1] * space_craft[0]) / cross_denom) * PI;
    else
        hour_angle = ((sun[0] * space_craft[1] - sun[1] * space_craft[0]) / cross_denom) *
                     std::acos((sun[0] * space_craft[0] + sun[1] * space_craft[1]) / (sun_denom * cos_denom));
    theta = 0.5 * std::fabs(geo_lat + sun_dec);
    eta = 0.5 * std::fabs(geo_lat - sun_dec);
    tau = hour_angle - 0.64577182325 + 0.10471975512 * std::sin(hour_angle + 0.75049157836);
    if (tau < -PI) tau += 2 * PI;
    else if (tau > PI) tau -= 2 * PI;
    th22 = std::pow(std::sin(theta), 2.2);
    t1 = s.xtemp * (1.0 + 0.3 * (th22 + std::pow(std::cos(0.5 * tau), 3.0) * (std::pow(std::cos(eta), 2.2) - th22)));
    expkp = std::exp(s.tkp);
    if (height < 200.0) s.t_infinity = t1 + 14.0 * s.tkp + 0.02 * expkp;
    else s.t_infinity = t1 + 28.0 * s.tkp + 0.03 * expkp;
    s.tx = 371.6678 + 0.0518806 * s.t_infinity - 294.3505 * std::exp(-0.00216222 * s.t_infinity);
    int i;
    if (height < 125.0) {
        for (s.sum = CON_C[4], i = 3; i >= 0; i--) s.sum = CON_C[i] + s.sum * height;
        exotemp = s.tx + (s.tx - TZERO) * s.sum / 1.500625e6;
    } else if (height > 125.0) {
        for (s.sum = CON_L[4], i = 3; i >= 0; i--) s.sum = CON_L[i] + s.sum * s.t_infinity;
        exotemp = s.t_infinity - (s.t_infinity - s.tx) *
                  std::exp(-(s.tx - TZERO) / (s.t_infinity - s.tx) * (height - 125.0) / 35.0 * s.sum / (s.cbPolarRadius + height));
    } else {
        exotemp = s.tx;
    }
    if (height <= 125.0) {
        for (c_star[0] = CON_C[0] + 1500625.0 * s.tx / (s.tx - TZERO), i = 1; i <= 4; i++) c_star[i] = CON_C[i];
        aux[0][0] = 125.0; aux[0][1] = 0.0;
        roots(c_star, na, aux, 1);
        s.root1 = aux[0][0];
        deflate_polynomial(c_star, na, s.root1, c_star);
        aux[0][0] = 200.0; aux[0][1] = 0.0;
        roots(c_star, na - 1, aux, 1);
        s.root2 = aux[0][0];
        deflate_polynomial(c_star, na - 1, s.root2, c_star);
        aux[0][0] = 10.0; aux[0][1] = 125.0;
        roots(c_star, na - 2, aux, 1);
        s.x_root = aux[0][0];
        s.y_root = std::fabs(aux[0][1]);
    }
    return true;
}

inline double rho_100(const State& s, double height, double temperature) {
    const double R = s.cbPolarRadius, R2 = s.cbPolarSquared;
    const double root1 = s.root1, root2 = s.root2, x_root = s.x_root, y_root = s.y_root, tx = s.tx;
    double m_poly, s_poly, f2, p1, p2, p3, p4, p5, p6, b[6];
    double x_star, u[2], w[2], v, factor_k, roots_2, log_f1;
    int i;
    for (m_poly = M_CON[6], i = 5; i >= 0; i--) m_poly = m_poly * height + M_CON[i];
    for (i = 0; i <= 5; i++) b[i] = S_CON[i] + S_BETA[i] * tx / (tx - TZERO);
    roots_2 = x_root * x_root + y_root * y_root;
    x_star = -2.0 * root1 * root2 * R * (R2 + 2.0 * R * x_root + roots_2);
    v = (R + root1) * (R + root2) * (R2 + 2.0 * R * x_root + roots_2);
    u[0] = (root1 - root2) * (root1 + R) * (root1 + R) * (root1 * root1 - 2.0 * root1 * x_root + roots_2);
    u[1] = (root1 - root2) * (root2 + R) * (root2 + R) * (root2 * root2 - 2.0 * root2 * x_root + roots_2);
    w[0] = root1 * root2 * R * (R + root1) * (R + roots_2 / root1);
    w[1] = root1 * root2 * R * (R + root2) * (R + roots_2 / root2);
    for (s_poly = b[5], i = 4; i >= 0; i--) s_poly = s_poly * root1 + b[i];
    p2 = s_poly / u[0];
    for (s_poly = b[5], i = 4; i >= 0; i--) s_poly = s_poly * root2 + b[i];
    p3 = -s_poly / u[1];
    for (s_poly = b[5], i = 4; i >= 0; i--) s_poly = -s_poly * R + b[i];
    p5 = s_poly / v;
    p4 = (b[0] - root1 * root2 * R2 * (b[4] + b[5] * (2.0 * x_root + root1 + root2 - R)) + w[0] * p2 + w[1] * p3
          - root1 * root2 * b[5] * R * roots_2 + root1 * root2 * (R2 - roots_2) * p5) / x_star;
    p1 = b[5] - 2 * p4 - p3 - p2;
    p6 = b[4] + b[5] * (2.0 * x_root + root1 + root2 - R) - p5 - 2.0 * (x_root + R) * p4 - (root2 + R) * p3 - (root1 + R) * p2;
    log_f1 = p1 * std::log((height + R) / (90.0 + R)) + p2 * std::log((height - root1) / (90.0 - root1)) +
             p3 * std::log((height - root2) / (90.0 - root2)) +
             p4 * std::log((height * height - 2.0 * x_root * height + roots_2) / (8100.0 - 180.0 * x_root + roots_2));
    f2 = (height - 90.0) * (M_CON[6] + p5 / ((height + R) * (90.0 + R))) +
         p6 * std::atan(y_root * (height - 90.0) / (y_root * y_root + (height - x_root) * (90.0 - x_root))) / y_root;
    factor_k = -G_ZERO / (GAS_CON * (tx - TZERO));
    return RHO_ZERO * TZERO * m_poly * std::exp(factor_k * (log_f1 + f2)) / (MZERO * temperature);
}

inline double rho_125(const State& s, double height, double temperature) {
    const double R = s.cbPolarRadius, R2 = s.cbPolarSquared;
    const double root1 = s.root1, root2 = s.root2, x_root = s.x_root, y_root = s.y_root, tx = s.tx;
    double f4, q1, q2, q3, q4, q5, q6, rho_prime, x_star, u[2], w[2], v, factor_k, t_100, rho_sum, rhoi, roots_2, log_f3;
    int i;
    for (rho_prime = ZETA_CON[6], i = 5; i >= 0; i--) rho_prime = rho_prime * s.t_infinity + ZETA_CON[i];
    t_100 = tx + OMEGA * (tx - TZERO);
    roots_2 = x_root * x_root + y_root * y_root;
    x_star = -2.0 * root1 * root2 * R * (R2 + 2.0 * R * x_root + roots_2);
    v = (R + root1) * (R + root2) * (R2 + 2.0 * R * x_root + roots_2);
    u[0] = (root1 - root2) * (root1 + R) * (root1 + R) * (root1 * root1 - 2.0 * root1 * x_root + roots_2);
    u[1] = (root1 - root2) * (root2 + R) * (root2 + R) * (root2 * root2 - 2.0 * root2 * x_root + roots_2);
    w[0] = root1 * root2 * R * (R + root1) * (R + roots_2 / root1);
    w[1] = root1 * root2 * R * (R + root2) * (R + roots_2 / root2);
    q2 = 1.0 / u[0];
    q3 = -1.0 / u[1];
    q5 = 1.0 / v;
    q4 = (1.0 + w[0] * q2 + w[1] * q3 + root1 * root2 * (R2 - roots_2) * q5) / x_star;
    q1 = -2 * q4 - q3 - q2;
    q6 = -q5 - 2.0 * (x_root + R) * q4 - (root2 + R) * q3 - (root1 + R) * q2;
    log_f3 = q1 * std::log((height + R) / (100.0 + R)) + q2 * std::log((height - root1) / (100.0 - root1)) +
             q3 * std::log((height - root2) / (100.0 - root2)) +
             q4 * std::log((height * height - 2.0 * x_root * height + roots_2) / (1.0e4 - 200.0 * x_root + roots_2));
    f4 = (height - 100.0) * q5 / ((height + R) * (100.0 + R)) +
         q6 * std::atan(y_root * (height - 100.0) / (y_root * y_root + (height - x_root) * (100.0 - x_root))) / y_root;
    factor_k = -1500625.0 * G_ZERO * R2 / (GAS_CON * CON_C[4] * (tx - TZERO));
    for (rho_sum = 0.0, i = 0; i <= 4; i++) {
        rhoi = MOL_MASS[i] * NUM_DENS[i] * std::exp(MOL_MASS[i] * factor_k * (f4 + log_f3));
        if (i == 2) rhoi *= std::pow(t_100 / temperature, -0.38);
        rho_sum += rhoi;
    }
    return rho_sum * rho_prime * t_100 / temperature;
}

// a1_time is GMAT's modified Julian date (JD - 2430000) on UTC.
inline double rho_cor(const State& s, double height, double a1_time, double geo_lat) {
    double geo_cor, semian_cor, slat_cor, f, g, day_58, tausa, alpha, sin_lat, eta_lat;
    if (height < 200.0) geo_cor = 0.012 * s.tkp + 0.000012 * std::exp(s.tkp);
    else geo_cor = 0.0;
    f = (5.876e-7 * std::pow(height, 2.331) + 0.06328) * std::exp(-0.002868 * height);
    day_58 = (a1_time - 6204.5) / 365.2422;
    tausa = day_58 + 0.09544 * (std::pow(0.5 * (1.0 + std::sin(2 * PI * day_58 + 6.035)), 1.65) - 0.5);
    alpha = std::sin(4.0 * PI * tausa + 4.259);
    g = 0.02835 + (0.3817 + 0.17829 * std::sin(2 * PI * tausa + 4.137)) * alpha;
    semian_cor = f * g;
    sin_lat = std::sin(geo_lat);
    eta_lat = std::sin(2.0 * PI * day_58 + 1.72) * sin_lat * std::fabs(sin_lat);
    slat_cor = 0.014 * (height - 90.0) * eta_lat * std::exp(-0.0013 * (height - 90.0) * (height - 90.0));
    return std::pow(10.0, geo_cor + semian_cor + slat_cor);
}

inline double rho_high(const State& s, double height, double temperature, double t_500, double sun_dec, double geo_lat) {
    const double R2 = s.cbPolarSquared;
    double f, log_di, gamma, exp1, rho_out, r, di = 0;
    int i, j;
    for (rho_out = 0.0, i = 0; i <= 5; i++) {
        if (i <= 4) {
            for (log_di = CON_DEN[i][6], j = 5; j >= 0; j--) log_di = log_di * s.t_infinity + CON_DEN[i][j];
            di = std::pow(10.0, log_di) / AVOGADRO;
        }
        const double polar125 = s.cbPolarRadius + 125.0;
        gamma = 35.0 * MOL_MASS[i] * G_ZERO * R2 * (s.t_infinity - s.tx) /
                (GAS_CON * s.sum * s.t_infinity * (s.tx - TZERO) * polar125);
        exp1 = 1.0 + gamma;
        f = 1.0;
        if (i == 2) {
            exp1 -= 0.38;
            // GMAT divides sun_dec by |sun_dec| (NaN when the Sun is on the
            // equator); its sign, 0 there, is the same value elsewhere.
            const double sign = sun_dec > 0 ? 1.0 : sun_dec < 0 ? -1.0 : 0.0;
            f = 4.9914 * std::fabs(sun_dec) *
                (std::pow(std::sin(0.25 * PI - 0.5 * geo_lat * sign), 3) - 0.35355) / PI;
            f = std::pow(10.0, f);
        }
        if (height > 500.0 && i == 5) {
            r = MOL_MASS[5] * std::pow(10.0, 73.13 - (39.4 - 5.5 * std::log10(t_500)) * std::log10(t_500)) *
                std::pow(t_500 / temperature, exp1) *
                std::pow((s.t_infinity - temperature) / (s.t_infinity - t_500), gamma) / AVOGADRO;
            rho_out += r;
        } else if (i <= 4) {
            r = f * MOL_MASS[i] * di * std::pow(s.tx / temperature, exp1) *
                std::pow((s.t_infinity - temperature) / (s.t_infinity - s.tx), gamma);
            rho_out += r;
        }
    }
    return rho_out;
}
}  // namespace detail

/// Mass density (kg/m^3; GMAT's JacchiaRoberts() times 1e3) at geodetic
/// height (km) and latitude (rad), the point and the Sun in Earth-fixed axes
/// (only their equatorial components and the Sun's declination enter), UTC
/// modified Julian date (JD - 2400000.5), and the Earth's polar radius (km).
/// Heights at or below 90 km return the 90 km density; above 2500 km, 0.
/// Returns -1 where GMAT throws (point on the polar axis or in the Sun's
/// meridian plane to 1e-15).
inline double density(double height, double geodeticLatitude, const double point[3], const double sun[3],
                      double mjdUtc, double polarRadiusKm, const Inputs& in) {
    using namespace detail;
    State s;
    s.cbPolarRadius = polarRadiusKm;
    s.cbPolarSquared = polarRadiusKm * polarRadiusKm;
    s.xtemp = 379.0 + 3.24 * in.f107a + 1.3 * (in.f107 - in.f107a);
    s.tkp = in.kp;
    const double a1_time = mjdUtc + 29999.5;  // GMAT MJD = JD - 2430000
    const double sun_dec = std::atan2(sun[2], std::sqrt(sun[0] * sun[0] + sun[1] * sun[1]));
    const double geo_lat = geodeticLatitude;
    double rho, temperature, t_500;
    if (height <= 90.0) return 1.0e3 * RHO_ZERO;
    if (height < 100.0) {
        if (!exotherm(s, point, sun, height, sun_dec, geo_lat, temperature)) return -1;
        rho = rho_100(s, height, temperature);
    } else if (height <= 125.0) {
        if (!exotherm(s, point, sun, height, sun_dec, geo_lat, temperature)) return -1;
        rho = rho_125(s, height, temperature);
    } else if (height <= 2500.0) {
        if (!exotherm(s, point, sun, 500.0, sun_dec, geo_lat, t_500)) return -1;
        if (!exotherm(s, point, sun, height, sun_dec, geo_lat, temperature)) return -1;
        rho = rho_high(s, height, temperature, t_500, sun_dec, geo_lat);
    } else {
        rho = 0.0;
    }
    return 1.0e3 * rho * rho_cor(s, height, a1_time, geo_lat);
}

}  // namespace jacchia_roberts
}  // namespace astro
