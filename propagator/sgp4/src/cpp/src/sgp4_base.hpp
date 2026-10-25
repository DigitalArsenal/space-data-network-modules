// The plugin's SGP4/SDP4 and the time and element helpers it needs.
//
// SGP4/SDP4 is the clean-room base foundation/sgp4-str3 (Spacetrack Report No. 3 with the corrections AIAA 2006-6753
// documents), WGS-72, improved mode. A set keeps, beside the base's state, the epoch as the plugin splits it (day and
// fraction), the status of its last evaluation and the readouts the plugin reports.
//
// The helpers are their textbook definitions: the Julian date of a Gregorian calendar date (the 367-day rule, valid
// 1901-2099), Greenwich mean sidereal time (IAU 1982, the base's own), osculating elements from a state, and mean from
// true anomaly through the eccentric anomaly.
#pragma once

#include <cmath>
#include <cstdint>

#include "sgp4_str3.h"

namespace sgp4base {

constexpr double kMuWgs72 = 398600.8;  // km^3/s^2

struct Sgp4Set {
    sdnap::Sat sat{};
    double jdsatepoch = 0.0;   // the epoch's day (integer + 0.5)
    double jdsatepochF = 0.0;  // the epoch's fraction of a day
    int32_t error = 0;         // the base's status of the last call: sdnap::kPropOk (0), or why it refused
    double no_unkozai = 0.0;   // the recovered (Brouwer) mean motion, rad/min
    double mus = kMuWgs72;     // the gravity parameter of the set's constants
    double ecco = 0.0;         // the epoch eccentricity
    double bstar = 0.0;        // B*, 1/earth radii
};

// A set from mean elements (radians; the Kozai mean motion in rad/min, as element sets carry it), the epoch in days
// from 1949 December 31 0h UT taken as one Julian date. Initialization also evaluates the set at its epoch and fails
// where SGP4 refuses it there. The first and second mean-motion derivatives play no part in SGP4.
inline bool sgp4Init(double ds50, double bstar, double ndot, double nddot, double ecco, double argpo, double inclo,
                     double mo, double no_kozai, double nodeo, Sgp4Set& s) {
    (void)ndot;
    (void)nddot;
    s = Sgp4Set{};
    sdnap::Elements el{};
    el.epoch_jd_whole = ds50 + sdnap::kJd1950;
    el.epoch_jd_frac = 0.0;
    el.xno = no_kozai;
    el.eo = ecco;
    el.xincl = inclo;
    el.xnodeo = nodeo;
    el.omegao = argpo;
    el.xmo = mo;
    el.bstar = bstar;
    s.ecco = ecco;
    s.bstar = bstar;
    s.error = sdnap::sat_init(el, sdnap::gravity_wgs72(), s.sat, sdnap::Sgp4Mode::kImproved);
    if (s.error != sdnap::kPropOk) return false;
    s.no_unkozai = s.sat.xnodp;
    double r[3], v[3];
    s.error = sdnap::sat_propagate(s.sat, nullptr, 0.0, r, v);
    return s.error == sdnap::kPropOk;
}

// The TEME state (km, km/s) `tsince` minutes from the set's epoch; false (and the reason in error) where SGP4 refuses.
inline bool sgp4At(Sgp4Set& s, double tsince, double r[3], double v[3]) {
    s.error = sdnap::sat_propagate(s.sat, nullptr, tsince, r, v);
    return s.error == sdnap::kPropOk;
}

// The Julian date of a Gregorian calendar date and UTC time, as the day (integer + 0.5) and the fraction of a day.
inline void julianDay(int year, int month, int day, int hour, int minute, double second, double& jd, double& jdFrac) {
    jd = 367.0 * year - std::floor((7 * (year + std::floor((month + 9) / 12.0))) * 0.25) +
         std::floor(275 * month / 9.0) + day + 1721013.5;
    jdFrac = (second + minute * 60.0 + hour * 3600.0) / 86400.0;
    if (std::fabs(jdFrac) > 1.0) {
        const double days = std::floor(jdFrac);
        jd += days;
        jdFrac -= days;
    }
}

// A Julian date split into its day (integer + 0.5) and the fraction of a day, exactly.
inline void splitJulianDate(double julianDate, double& jd, double& jdFrac) {
    jd = std::floor(julianDate - 0.5) + 0.5;
    jdFrac = julianDate - jd;
}

// Greenwich mean sidereal time, radians in [0, 2 pi), of a UT1 Julian date (IAU 1982).
inline double gmst(double jdut1) { return sdnap::str3::gmst_iau82(jdut1, 0.0); }

// Without an orbit (no position or no angular momentum) the elements are p = a = 0 and e = 2, which every caller
// refuses (the module is built with -ffast-math, so NaN cannot mark them). Where e >= 1 the mean anomaly is 0.
struct Osculating {
    double p = 0.0, a = 0.0, ecc = 2.0, incl = 0.0, node = 0.0, argp = 0.0, nu = 0.0, m = 0.0;
};

// Mean anomaly (radians) from true anomaly `nu` on an ellipse of eccentricity `ecc` (< 1), through the eccentric
// anomaly E: tan(E/2) = sqrt((1 - e)/(1 + e)) tan(nu/2), M = E - e sin E. Both in (-pi, pi].
inline void trueToMean(double ecc, double nu, double& eccentricAnomaly, double& m) {
    const double denom = 1.0 + ecc * std::cos(nu);
    const double sinE = std::sqrt(1.0 - ecc * ecc) * std::sin(nu) / denom;
    const double cosE = (ecc + std::cos(nu)) / denom;
    eccentricAnomaly = std::atan2(sinE, cosE);
    m = eccentricAnomaly - ecc * sinE;
}

// Osculating Keplerian elements from a state (km, km/s) under `mu`. Angles in radians: the node from the x axis,
// argument of perigee from the node, true and mean anomaly from perigee, each in [0, 2 pi). Where the orbit is
// equatorial the node is 0 (the ascending direction is the x axis), and where it is circular the argument of perigee
// is 0 (perigee is the node), so true anomaly then counts from the node.
inline Osculating osculatingElements(const double r[3], const double v[3], double mu) {
    constexpr double kTwoPi = 6.28318530717958647692;
    constexpr double kSmall = 1.0e-8;
    const auto dot = [](const double* x, const double* y) { return x[0] * y[0] + x[1] * y[1] + x[2] * y[2]; };
    const auto wrap = [&](double angle) { angle = std::fmod(angle, kTwoPi); return angle < 0.0 ? angle + kTwoPi : angle; };
    Osculating out;
    const double rmag = std::sqrt(dot(r, r)), vmag2 = dot(v, v);
    const double h[3] = { r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0] };
    const double hmag = std::sqrt(dot(h, h));
    if (!(rmag > 0.0) || !(hmag > 0.0)) return out;
    const double nvec[3] = { -h[1], h[0], 0.0 };
    const double nmag = std::sqrt(dot(nvec, nvec));
    const double rdotv = dot(r, v);
    double e[3];
    for (int k = 0; k < 3; ++k) e[k] = ((vmag2 - mu / rmag) * r[k] - rdotv * v[k]) / mu;
    out.ecc = std::sqrt(dot(e, e));
    const double energy = 0.5 * vmag2 - mu / rmag;
    out.a = std::fabs(energy) > kSmall ? -mu / (2.0 * energy) : 0.0;
    out.p = hmag * hmag / mu;
    out.incl = std::acos(std::fmax(-1.0, std::fmin(1.0, h[2] / hmag)));
    const bool equatorial = nmag <= kSmall * hmag, circular = out.ecc <= kSmall;
    // The reference directions: the node (or the x axis), and perigee (or the node).
    const double node[3] = { equatorial ? 1.0 : nvec[0] / nmag, equatorial ? 0.0 : nvec[1] / nmag, 0.0 };
    out.node = equatorial ? 0.0 : wrap(std::atan2(nvec[1], nvec[0]));
    // In-plane angle from direction `from` to vector `to`, counted in the sense of motion.
    const auto inPlane = [&](const double* from, const double* to) {
        const double c[3] = { from[1] * to[2] - from[2] * to[1], from[2] * to[0] - from[0] * to[2], from[0] * to[1] - from[1] * to[0] };
        return wrap(std::atan2(dot(c, h) / hmag, dot(from, to)));
    };
    if (circular) {
        out.argp = 0.0;
        out.nu = inPlane(node, r);
    } else {
        out.argp = inPlane(node, e);
        out.nu = inPlane(e, r);
    }
    if (out.ecc < 1.0) {
        double eccentricAnomaly, m;
        trueToMean(out.ecc, out.nu, eccentricAnomaly, m);
        out.m = wrap(m);
    }
    return out;
}

}  // namespace sgp4base
