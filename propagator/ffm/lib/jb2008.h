// jb2008.h - Jacchia-Bowman 2008 thermospheric density
// =============================================================================
// Bowman, Tobiska, Marcos, Huang, Lin and Burke, "A New Empirical
// Thermospheric Density Model JB2008 Using New Solar and Geomagnetic Indices",
// AIAA 2008-6438. The model is Jacchia's 1970/1971 diffusion profile with
// the exospheric temperature driven by the F10, S10, M10 and Y10 solar indices
// (with their 81-day centred averages) and the Dst-derived temperature change
// DSTDTC, plus the JB2008 semiannual and local-solar-time corrections.
//
// This is a line-for-line C++ port of the double-precision path of Orekit
// 13.1's org.orekit.models.earth.atmosphere.JB2008 and
// AbstractJacchiaBowmanModel (Copyright 2002-2025 CS GROUP, Apache License,
// Version 2.0, http://www.apache.org/licenses/LICENSE-2.0), itself a port of
// the JB2008 Fortran distributed by Space Environment Technologies. Orekit is
// also the oracle the port is checked against (tests/orekit_reference).
// Changes: C++; inputs passed as values (JB2008Inputs) instead of a provider.
#pragma once
#include <algorithm>
#include <cmath>

namespace astro {
namespace jb2008 {

/// Model inputs at one instant, already lagged as JB2008 prescribes (1 day
/// for F10 and S10, 2 for M10, 5 for Y10; the 81-day centred values with the
/// same lags): solar indices in SFU, DSTDTC in K.
struct Inputs {
    double f10, f10B, s10, s10B, xm10, xm10B, y10, y10B, dstdtc;
};

namespace detail {
constexpr double ALT_MIN_M = 90000.0;
constexpr double ALPHA[5] = {0, 0, 0, 0, -0.38};
constexpr double AMW[6] = {28.0134, 31.9988, 15.9994, 39.9480, 4.0026, 1.00797};
constexpr double AVOGAD = 6.02257e26;
constexpr double FRAC[4] = {0.78110, 0.20955, 9.3400e-3, 1.2890e-5};
constexpr double RSTAR = 8.31432;
constexpr double R1 = 0.010, R2 = 0.025, R3 = 0.075;
constexpr double WT[5] = {0.311111111111111, 1.422222222222222, 0.533333333333333, 1.422222222222222, 0.311111111111111};
constexpr double EARTH_RADIUS = 6356.766;
constexpr double G0 = 9.80665;  // Constants.G0_STANDARD_GRAVITY
constexpr double BDT_SUB[19] = {-0.457512297e+01, -0.512114909e+01, -0.693003609e+02,
                                0.203716701e+03, 0.703316291e+03, -0.194349234e+04,
                                0.110651308e+04, -0.174378996e+03, 0.188594601e+04,
                                -0.709371517e+04, 0.922454523e+04, -0.384508073e+04,
                                -0.645841789e+01, 0.409703319e+02, -0.482006560e+03,
                                0.181870931e+04, -0.237389204e+04, 0.996703815e+03,
                                0.361416936e+02};
constexpr double CDT_SUB[23] = {-0.155986211e+02, -0.512114909e+01, -0.693003609e+02,
                                0.203716701e+03, 0.703316291e+03, -0.194349234e+04,
                                0.110651308e+04, -0.220835117e+03, 0.143256989e+04,
                                -0.318481844e+04, 0.328981513e+04, -0.135332119e+04,
                                0.199956489e+02, -0.127093998e+02, 0.212825156e+02,
                                -0.275555432e+01, 0.110234982e+02, 0.148881951e+03,
                                -0.751640284e+03, 0.637876542e+03, 0.127093998e+02,
                                -0.212825156e+02, 0.275555432e+01};
constexpr double CXAMB[7] = {28.15204, -8.5586e-2, +1.2840e-4, -1.0056e-5, -1.0210e-5, +1.5044e-6, +9.9826e-8};
constexpr double CHT[4] = {0.22, -0.20e-02, 0.115e-02, -0.211e-05};
constexpr double FZM[5] = {0.2689e+00, -0.1176e-01, 0.2782e-01, -0.2782e-01, 0.3470e-03};
constexpr double GTM[10] = {-0.3633e+00, 0.8506e-01, 0.2401e+00, -0.1897e+00, -0.2554e+00,
                            -0.1790e-01, 0.5650e-03, -0.6407e-03, -0.3418e-02, -0.1252e-02};
constexpr double PI = 3.14159265358979323846;

inline double solarTimeHour(double h) {
    const double hour = (h + PI) * 180.0 / PI / 15.0;
    if (hour >= 24) return hour - 24.;
    if (hour < 0) return hour + 24.;
    return hour;
}
inline double tSubL(double eta, double theta, double tau, double tsubc) {
    const double cosEta = std::pow(std::cos(eta), 2.5);
    const double sinTheta = std::pow(std::sin(theta), 2.5);
    const double cosTau = std::abs(std::cos(0.5 * tau));
    const double df = sinTheta + (cosEta - sinTheta) * cosTau * cosTau * cosTau;
    return tsubc * (1. + 0.31 * df);
}
inline double tSubX(double tInf) { return 444.3807 + 0.02385 * tInf - 392.8292 * std::exp(-0.0021357 * tInf); }
inline double gSubX(double tsubx) { return 0.054285714 * (tsubx - 183.); }
inline double localTemp(double z, const double tc[4]) {
    const double dz = z - 125;
    if (dz <= 0) return ((-9.8204695e-6 * dz - 7.3039742e-4) * dz * dz + 1.0) * dz * tc[1] + tc[0];
    return tc[0] + tc[2] * std::atan(tc[3] * dz * (1 + 4.5e-6 * std::pow(dz, 2.5)));
}
inline double mBar(double z) {
    const double dz = z - 100.;
    double amb = CXAMB[6];
    for (int i = 5; i >= 0; --i) amb = dz * amb + CXAMB[i];
    return amb;
}
inline double gravity(double z) {
    const double temp = 1.0 + z / EARTH_RADIUS;
    return G0 / (temp * temp);
}
inline double dayOfYear(double dateMJD) {
    const double d1950 = dateMJD - 33281;
    int iyday = static_cast<int>(d1950);
    const double frac = d1950 - iyday;
    iyday = iyday + 364;
    int itemp = iyday / 1461;
    iyday = iyday - itemp * 1461;
    itemp = iyday / 365;
    if (itemp >= 3) itemp = 3;
    iyday = iyday - 365 * itemp + 1;
    return iyday + frac;
}
inline double dlrsl(double altKm, double dateMJD, double satLat) {
    const double capPhi = std::fmod((dateMJD - 36204.0) / 365.2422, 1.0);  // Java %: sign of the dividend
    const int signum = (satLat >= 0) ? 1 : -1;
    const double sinLat = std::sin(satLat);
    const double hm90 = altKm - 90.;
    return 0.02 * hm90 * std::exp(-0.045 * hm90) * signum * std::sin(2 * PI * capPhi + 1.72) * sinLat * sinLat;
}
inline double densityCorrectionFactor(double altKm, double f10B) {
    if (altKm >= 1000.0 && altKm < 1500.0) {
        const double zeta = (altKm - 1000.) * 0.002;
        const double f15c = CHT[0] + CHT[1] * f10B + CHT[2] * 1500.0 + CHT[3] * f10B * 1500.0;
        const double f15cZeta = (CHT[2] + CHT[3] * f10B) * 500.0;
        const double fex2 = 3.0 * f15c - f15cZeta - 3.0;
        const double fex3 = f15cZeta - 2.0 * f15c + 2.0;
        return 1.0 + zeta * zeta * (fex2 + fex3 * zeta);
    }
    if (altKm >= 1500.0) return CHT[0] + CHT[1] * f10B + CHT[2] * altKm + CHT[3] * f10B * altKm;
    return 1.0;
}
inline double poly1CDTC(double fs, double st, double cs) {
    return CDT_SUB[0] +
           fs * (CDT_SUB[1] + st * (CDT_SUB[2] + st * (CDT_SUB[3] + st * (CDT_SUB[4] + st * (CDT_SUB[5] + st * CDT_SUB[6]))))) +
           cs * st * (CDT_SUB[7] + st * (CDT_SUB[8] + st * (CDT_SUB[9] + st * (CDT_SUB[10] + st * CDT_SUB[11])))) +
           cs * (CDT_SUB[12] + fs * (CDT_SUB[13] + st * (CDT_SUB[14] + st * CDT_SUB[15])));
}
inline double poly2CDTC(double fs, double st, double cs) {
    return CDT_SUB[16] + st * cs * (CDT_SUB[17] + st * (CDT_SUB[18] + st * CDT_SUB[19])) +
           fs * cs * (CDT_SUB[20] + st * (CDT_SUB[21] + st * CDT_SUB[22]));
}
inline double poly1BDTC(double fs, double st, double cs, double hp) {
    return BDT_SUB[0] +
           fs * (BDT_SUB[1] + st * (BDT_SUB[2] + st * (BDT_SUB[3] + st * (BDT_SUB[4] + st * (BDT_SUB[5] + st * BDT_SUB[6]))))) +
           cs * (st * (BDT_SUB[7] + st * (BDT_SUB[8] + st * (BDT_SUB[9] + st * (BDT_SUB[10] + st * BDT_SUB[11])))) + hp + BDT_SUB[18]);
}
inline double poly2BDTC(double st) {
    return BDT_SUB[12] + st * (BDT_SUB[13] + st * (BDT_SUB[14] + st * (BDT_SUB[15] + st * (BDT_SUB[16] + st * BDT_SUB[17]))));
}
inline double dTc(double f10, double solarTime, double satLat, double satAlt) {
    const double st = solarTime / 24.0;
    const double cs = std::cos(satLat);
    const double fs = (f10 - 100.0) / 100.0;
    if (satAlt >= 120 && satAlt <= 200) {
        const double dtc200 = poly2CDTC(fs, st, cs), dtc200dz = poly1CDTC(fs, st, cs);
        const double cc = 3.0 * dtc200 - dtc200dz, dd = dtc200 - cc, zp = (satAlt - 120.0) / 80.0;
        return zp * zp * (cc + dd * zp);
    } else if (satAlt > 200.0 && satAlt <= 240.0) {
        const double h = (satAlt - 200.0) / 50.0;
        return poly1CDTC(fs, st, cs) * h + poly2CDTC(fs, st, cs);
    } else if (satAlt > 240.0 && satAlt <= 300.0) {
        const double h = 0.8, bb = poly1CDTC(fs, st, cs), aa = bb * h + poly2CDTC(fs, st, cs);
        const double p2BDT = poly2BDTC(st), dtc300 = poly1BDTC(fs, st, cs, 3 * p2BDT), dtc300dz = cs * p2BDT;
        const double cc = 3.0 * dtc300 - dtc300dz - 3.0 * aa - 2.0 * bb, dd = dtc300 - aa - bb - cc, zp = (satAlt - 240.0) / 60.0;
        return aa + zp * (bb + zp * (cc + zp * dd));
    } else if (satAlt > 300.0 && satAlt <= 600.0) {
        const double h = satAlt / 100.0;
        return poly1BDTC(fs, st, cs, h * poly2BDTC(st));
    } else if (satAlt > 600.0 && satAlt <= 800.0) {
        const double poly2 = poly2BDTC(st), aa = poly1BDTC(fs, st, cs, 6 * poly2), bb = cs * poly2;
        const double cc = -(3.0 * aa + 4.0 * bb) / 4.0, dd = (aa + bb) / 4.0, zp = (satAlt - 600.0) / 100.0;
        return aa + zp * (bb + zp * (cc + zp * dd));
    }
    return 0.;
}
// JB2008's exospheric reference temperature (JB2008.computeTc).
inline double computeTc(const Inputs& in) {
    const double fn = std::min(1.0, std::pow(in.f10B / 240., 0.25));
    const double fsb = in.f10B * fn + in.s10B * (1. - fn);
    return 392.4 + 3.227 * fsb + 0.298 * (in.f10 - in.f10B) + 2.259 * (in.s10 - in.s10B) +
           0.312 * (in.xm10 - in.xm10B) + 0.178 * (in.y10 - in.y10B);
}
// JB2008.semian.
inline double semian(const Inputs& in, double day, double altKm) {
    const double htz = altKm / 1000.0;
    double fsmb = in.f10B - 0.70 * in.s10B - 0.04 * in.xm10B;
    const double fzz = FZM[0] + fsmb * (FZM[1] + htz * (FZM[2] + FZM[3] * htz + FZM[4] * fsmb));
    fsmb = in.f10B - 0.75 * in.s10B - 0.37 * in.xm10B;
    const double tau = 2 * PI * (day - 1.0) / 365;
    const double s1 = std::sin(tau), c1 = std::cos(tau), s2 = 2 * s1 * c1, c2 = c1 * c1 - s1 * s1;
    const double gtz = GTM[0] + GTM[1] * s1 + GTM[2] * c1 + GTM[3] * s2 + GTM[4] * c2 +
                       fsmb * (GTM[5] + GTM[6] * s1 + GTM[7] * c1 + GTM[8] * s2 + GTM[9] * c2);
    return std::max(1.0e-6, fzz) * gtz;
}
}  // namespace detail

/// Total mass density (kg/m^3) at a UTC modified Julian date (with the
/// day fraction), the Sun's Earth-fixed longitude and latitude (rad), and the
/// point's geodetic longitude, latitude (rad) and altitude (m). Altitudes below
/// 90 km return 0 (Orekit throws there).
inline double density(double dateMJD, double sunRA, double sunDecli, double satLon, double satLat,
                      double satAlt, const Inputs& in) {
    using namespace detail;
    if (!(satAlt >= ALT_MIN_M)) return 0.0;
    const double altKm = satAlt / 1000.0;
    const double tsubc = computeTc(in);
    const double eta = 0.5 * std::abs(satLat - sunDecli);
    const double theta = 0.5 * std::abs(satLat + sunDecli);
    const double h = satLon - sunRA;
    const double tau = h - 0.64577182 + 0.10471976 * std::sin(h + 0.75049158);
    const double solarTime = solarTimeHour(h);
    const double tsubl = tSubL(eta, theta, tau, tsubc);
    const double dtclst = dTc(in.f10, solarTime, satLat, altKm);
    const double tInf = tsubl + in.dstdtc + dtclst;
    const double tsubx = tSubX(tInf);
    const double gsubx = gSubX(tsubx);
    double tc[4];
    tc[0] = tsubx; tc[1] = gsubx; tc[2] = (tInf - tsubx) / (PI / 2); tc[3] = gsubx / tc[2];
    const double z1 = 90.;
    const double z2 = std::min(altKm, 105.0);
    double al = std::log(z2 / z1);
    int n = static_cast<int>(std::floor(al / R1)) + 1;
    double zr = std::exp(al / n);
    const double mb1 = mBar(z1);
    const double tloc1 = localTemp(z1, tc);
    double zend = z1, sub2 = 0., ain = mb1 * gravity(z1) / tloc1, mb2 = 0, tloc2 = 0, z = 0, gravl = 0;
    for (int i = 0; i < n; ++i) {
        z = zend;
        zend = zr * z;
        const double dz = 0.25 * (zend - z);
        double sum1 = WT[0] * ain;
        for (int j = 1; j < 5; ++j) {
            z += dz;
            mb2 = mBar(z);
            tloc2 = localTemp(z, tc);
            gravl = gravity(z);
            ain = mb2 * gravl / tloc2;
            sum1 += WT[j] * ain;
        }
        sub2 += dz * sum1;
    }
    double rho = 3.46e-6 * mb2 * tloc1 / std::exp(sub2 / RSTAR) / (mb1 * tloc2);
    const double anm = AVOGAD * rho;
    const double an = anm / mb2;
    double fact2 = anm / 28.960;
    double aln[6];
    aln[0] = std::log(FRAC[0] * fact2);
    aln[3] = std::log(FRAC[2] * fact2);
    aln[4] = std::log(FRAC[3] * fact2);
    aln[1] = std::log(fact2 * (1. + FRAC[1]) - an);
    aln[2] = std::log(2. * (an - fact2));
    if (altKm <= 105.0) {
        aln[5] = aln[4] - 25.0;
    } else {
        al = std::log(std::min(altKm, 500.0) / z);
        n = 1 + static_cast<int>(std::floor(al / R2));
        zr = std::exp(al / n);
        sub2 = 0.;
        ain = gravl / tloc2;
        double tloc3 = 0;
        for (int i = 0; i < n; ++i) {
            z = zend;
            zend = zr * z;
            const double dz = 0.25 * (zend - z);
            double sum1 = WT[0] * ain;
            for (int j = 1; j < 5; ++j) {
                z += dz;
                tloc3 = localTemp(z, tc);
                gravl = gravity(z);
                ain = gravl / tloc3;
                sum1 += WT[j] * ain;
            }
            sub2 += dz * sum1;
        }
        al = std::log(std::max(altKm, 500.0) / z);
        const double r = (altKm > 500.0) ? R3 : R2;
        n = 1 + static_cast<int>(std::floor(al / r));
        zr = std::exp(al / n);
        double sum3 = 0., tloc4 = 0;
        for (int i = 0; i < n; ++i) {
            z = zend;
            zend = zr * z;
            const double dz = 0.25 * (zend - z);
            double sum1 = WT[0] * ain;
            for (int j = 1; j < 5; ++j) {
                z += dz;
                tloc4 = localTemp(z, tc);
                gravl = gravity(z);
                ain = gravl / tloc4;
                sum1 = sum1 + WT[j] * ain;
            }
            sum3 = sum3 + dz * sum1;
        }
        double altr, hSign;
        if (altKm <= 500.) {
            altr = std::log(tloc3 / tloc2);
            fact2 = sub2 / RSTAR;
            hSign = 1.0;
        } else {
            altr = std::log(tloc4 / tloc2);
            fact2 = (sub2 + sum3) / RSTAR;
            hSign = -1.0;
        }
        for (int i = 0; i < 5; ++i) aln[i] = aln[i] - (1.0 + ALPHA[i]) * altr - fact2 * AMW[i];
        const double al10t5 = std::log10(tInf);
        const double alnh5 = (5.5 * al10t5 - 39.40) * al10t5 + 73.13;
        aln[5] = std::log(10.) * (alnh5 + 6.) + hSign * (std::log(tloc4 / tloc3) + sum3 * AMW[5] / RSTAR);
    }
    const double dl = dlrsl(altKm, dateMJD, satLat);
    double dlrsa = 0;
    if (z < 2000.0) dlrsa = semian(in, dayOfYear(dateMJD), altKm);
    const double dlr = std::log(10.) * (dl + dlrsa);
    for (int i = 0; i < 6; ++i) aln[i] += dlr;
    double sumnm = 0;
    for (int i = 0; i < 6; ++i) sumnm += std::exp(aln[i]) * AMW[i];
    rho = sumnm / AVOGAD;
    rho *= densityCorrectionFactor(altKm, in.f10B);
    return rho;
}

}  // namespace jb2008
}  // namespace astro
