/**
 * SGP4 Differential Correction — Equinoctial Element Fitting
 *
 * Fits SGP4 mean elements to operator-supplied ephemeris data.
 * Produces SupGP/OMM records matching CelesTrak format.
 *
 * Reference: "SGP4 Orbit Determination" (AIAA 2008-6770)
 *            Vallado, Crawford, Hujsak, Kelso
 *
 * State vector: equinoctial elements [af, ag, a_er, L, pe, qe, B*]
 *   af = e·cos(ω + Ω)
 *   ag = e·sin(ω + Ω)
 *   a  = semi-major axis in Earth radii
 *   L  = M + ω + Ω (mean longitude)
 *   pe = tan(i/2)·sin(Ω)
 *   qe = tan(i/2)·cos(Ω)
 *   B* = drag coefficient
 *
 * ndot and nddot are always set to 0.
 */

#include "od/sgp4_fitter.h"
#include "SGP4.h"

#include <Eigen/Dense>
#include <Eigen/SVD>

#include <cmath>
#include <algorithm>
#include <sstream>
#include <iomanip>
#include <cstring>
#include <random>
#include <numeric>

namespace od {

// ── Constants (WGS72, matching Vallado SGP4) ──

static constexpr double MU_EARTH = 398600.8;            // km³/s² (WGS72)
static constexpr double RE_KM = 6378.135;               // Earth radius (km, WGS72)
static constexpr double DEG2RAD = M_PI / 180.0;
static constexpr double RAD2DEG = 180.0 / M_PI;
static constexpr double TWO_PI = 2.0 * M_PI;
static constexpr double SEC_PER_DAY = 86400.0;
static constexpr double MIN_PER_DAY = 1440.0;
static const double XKE = 60.0 / std::sqrt(RE_KM * RE_KM * RE_KM / MU_EARTH);
static constexpr double CK2 = 0.5 * 1.082616e-3;       // 0.5 * J2
static constexpr double RE_ER = 1.0;                    // Earth radii

// ── Equinoctial element indices ──

static constexpr int NPARAMS = 8;
static constexpr int IDX_AF = 0;
static constexpr int IDX_AG = 1;
static constexpr int IDX_A  = 2;  // semi-major axis in Earth radii
static constexpr int IDX_L  = 3;  // mean longitude (rad)
static constexpr int IDX_PE = 4;
static constexpr int IDX_QE = 5;
static constexpr int IDX_BSTAR = 6;
static constexpr int IDX_NDOT = 7;  // mean motion derivative (rev/day²)

static int bounded_iteration_count(int default_count, const FitterConfig& config) {
    if (config.max_iterations <= 0) {
        return default_count;
    }
    return std::max(1, std::min(default_count, config.max_iterations));
}

// ── Angle normalization ──

static double normalize_angle(double a) {
    a = std::fmod(a, TWO_PI);
    if (a < 0) a += TWO_PI;
    return a;
}

// ── JD ↔ Calendar conversion ──

// JD epoch for SGP4: Jan 0, 1950 00:00 UTC = JD 2433281.5
static constexpr double JD_EPOCH_1950 = 2433281.5;

static void jd_to_calendar(double jd, int& year, int& month, int& day,
                           int& hour, int& minute, double& sec) {
    SGP4Funcs::invjday_SGP4(std::floor(jd), jd - std::floor(jd),
                            year, month, day, hour, minute, sec);
}

// Convert JD to SGP4 epoch (days since Jan 0, 1950)
static double jd_to_sgp4_epoch(double jd) {
    return jd - JD_EPOCH_1950;
}

// Convert JD to day-of-year (fractional)
static double jd_to_day_of_year(double jd) {
    int year, month, day, hour, minute;
    double sec;
    jd_to_calendar(jd, year, month, day, hour, minute, sec);
    double jd_jan1, jd_jan1_frac;
    SGP4Funcs::jday_SGP4(year, 1, 1, 0, 0, 0.0, jd_jan1, jd_jan1_frac);
    return (jd - (jd_jan1 + jd_jan1_frac)) + 1.0;
}

// ── Generate TLE strings from mean elements ──
// Used for output formatting only (not for propagation).

static std::string format_exp(double val) {
    // TLE exponential format: " NNNNN-N" or "-NNNNN-N" (8 chars)
    // e.g., " 12345-4" means 0.12345e-4
    char buf[16];
    if (val == 0.0) {
        return " 00000-0";
    }
    char sign = (val >= 0) ? ' ' : '-';
    double absval = std::fabs(val);
    int exponent = static_cast<int>(std::floor(std::log10(absval)));
    double mantissa = absval / std::pow(10.0, exponent);
    // mantissa is now in [1, 10), we want it as 5-digit integer of 0.XXXXX
    int mant_int = static_cast<int>(std::round(mantissa * 10000.0));
    if (mant_int >= 100000) { mant_int /= 10; exponent++; }
    // exponent in TLE is the power: value = 0.XXXXX * 10^exp
    // so actual exponent = exponent + 1 (since mantissa was in [1,10))
    int tle_exp = exponent + 1;
    char exp_sign = (tle_exp >= 0) ? '+' : '-';
    std::snprintf(buf, sizeof(buf), "%c%05d%c%d", sign, mant_int, exp_sign, std::abs(tle_exp));
    return std::string(buf);
}

static void make_tle_lines(
    const SGP4Elements& el,
    std::string& line1, std::string& line2) {

    // Epoch: convert JD to YYDDD.DDDDDDDD
    int year, month, day_cal, hour, minute;
    double sec;
    jd_to_calendar(el.epoch_jd, year, month, day_cal, hour, minute, sec);
    double day_of_year = jd_to_day_of_year(el.epoch_jd);
    int yy = year % 100;

    char l1[80], l2[80];

    // nddot/6 and bstar in exponential format
    std::string nddot_str = " 00000-0";
    std::string bstar_str = format_exp(el.bstar);

    // ndot/2: TLE format " .NNNNNNNN" or "-.NNNNNNNN" (10 chars, col 33-42)
    double ndot_half = el.mean_motion_dot / 2.0;
    char ndot_buf[16];
    if (ndot_half >= 0.0) {
        std::snprintf(ndot_buf, sizeof(ndot_buf), " .%08d",
            static_cast<int>(std::round(std::abs(ndot_half) * 1e8)));
    } else {
        std::snprintf(ndot_buf, sizeof(ndot_buf), "-.%08d",
            static_cast<int>(std::round(std::abs(ndot_half) * 1e8)));
    }
    std::string ndot_str(ndot_buf, 10);

    std::snprintf(l1, sizeof(l1),
        "1 %05dU %-8s %02d%012.8f %s %s %s 0    0",
        el.norad_cat_id % 100000,
        el.object_id.empty() ? "00000A  " : el.object_id.c_str(),
        yy, day_of_year,
        ndot_str.c_str(),
        nddot_str.c_str(),
        bstar_str.c_str());

    // Eccentricity: 7 digits, no leading "0."
    int ecc_int = static_cast<int>(std::round(el.eccentricity * 1e7));
    if (ecc_int < 0) ecc_int = 0;
    if (ecc_int > 9999999) ecc_int = 9999999;

    std::snprintf(l2, sizeof(l2),
        "2 %05d %8.4f %8.4f %07d %8.4f %8.4f %11.8f    0",
        el.norad_cat_id % 100000,
        el.inclination,
        el.ra_of_asc_node,
        ecc_int,
        el.arg_of_pericenter,
        el.mean_anomaly,
        el.mean_motion);

    // Ensure exact 69 chars
    line1 = std::string(l1);
    line2 = std::string(l2);
    // Pad or trim to 69 chars
    line1.resize(69, ' ');
    line2.resize(69, ' ');
    // Set line numbers
    line1[0] = '1';
    line2[0] = '2';
}

// ── Cartesian → Keplerian ──

std::array<double, 6> cartesian_to_keplerian(
    double x, double y, double z,
    double vx, double vy, double vz) {

    double r = std::sqrt(x*x + y*y + z*z);
    double v = std::sqrt(vx*vx + vy*vy + vz*vz);

    double h[3] = {y*vz - z*vy, z*vx - x*vz, x*vy - y*vx};
    double h_mag = std::sqrt(h[0]*h[0] + h[1]*h[1] + h[2]*h[2]);

    double n[3] = {-h[1], h[0], 0.0};
    double n_mag = std::sqrt(n[0]*n[0] + n[1]*n[1]);

    double rdotv = x*vx + y*vy + z*vz;
    double r_vec[3] = {x, y, z};
    double v_vec[3] = {vx, vy, vz};
    double e_vec[3];
    for (int i = 0; i < 3; i++) {
        e_vec[i] = ((v*v - MU_EARTH/r) * r_vec[i] - rdotv * v_vec[i]) / MU_EARTH;
    }
    double ecc = std::sqrt(e_vec[0]*e_vec[0] + e_vec[1]*e_vec[1] + e_vec[2]*e_vec[2]);

    double energy = v*v / 2.0 - MU_EARTH / r;
    double a = -MU_EARTH / (2.0 * energy);

    double inc = std::acos(std::max(-1.0, std::min(1.0, h[2] / h_mag)));

    double raan = 0.0;
    if (n_mag > 1e-12) {
        raan = std::acos(std::max(-1.0, std::min(1.0, n[0] / n_mag)));
        if (n[1] < 0) raan = TWO_PI - raan;
    }

    double argp = 0.0;
    if (n_mag > 1e-12 && ecc > 1e-12) {
        double ndote = (n[0]*e_vec[0] + n[1]*e_vec[1] + n[2]*e_vec[2]) / (n_mag * ecc);
        argp = std::acos(std::max(-1.0, std::min(1.0, ndote)));
        if (e_vec[2] < 0) argp = TWO_PI - argp;
    }

    double nu = 0.0;
    if (ecc > 1e-12) {
        double edotr = (e_vec[0]*x + e_vec[1]*y + e_vec[2]*z) / (ecc * r);
        nu = std::acos(std::max(-1.0, std::min(1.0, edotr)));
        if (rdotv < 0) nu = TWO_PI - nu;
    }

    double E_anom = std::atan2(std::sqrt(1 - ecc*ecc) * std::sin(nu),
                               ecc + std::cos(nu));
    double M = E_anom - ecc * std::sin(E_anom);
    if (M < 0) M += TWO_PI;

    return {a, ecc, inc, raan, argp, M};
}

// ── Kozai-Brouwer conversion (osculating → mean) ──
// Standard formula from Vallado / Spacetrack Report #3

static double osc_n_to_kozai(double n_osc_rad_min, double ecc, double inc) {
    double a1 = std::pow(XKE / n_osc_rad_min, 2.0/3.0);
    double cosio = std::cos(inc);
    double theta2 = cosio * cosio;
    double x3thm1 = 3.0 * theta2 - 1.0;
    double eosq = ecc * ecc;
    double betao2 = 1.0 - eosq;
    double betao = std::sqrt(betao2);
    double K = (1.5 * CK2) * x3thm1 / (betao * betao2);
    double del1 = K / (a1 * a1);
    double a0 = a1 * (1.0 - del1 / 3.0 - del1 * del1 - 134.0 / 81.0 * del1 * del1 * del1);
    double del0 = K / (a0 * a0);
    return n_osc_rad_min * (1.0 + del0);
}

// Inverse: given Brouwer mean n, recover unkozai'd (osculating) n
// Newton-Raphson iteration
static double kozai_to_osc_n(double n_mean_rad_min, double ecc, double inc) {
    double n_osc = n_mean_rad_min;
    for (int i = 0; i < 5; i++) {
        double n_kozai = osc_n_to_kozai(n_osc, ecc, inc);
        double f = n_kozai - n_mean_rad_min;
        // Numerical derivative
        double dn = n_osc * 1e-8;
        double n_kozai2 = osc_n_to_kozai(n_osc + dn, ecc, inc);
        double fp = (n_kozai2 - n_kozai) / dn;
        if (std::abs(fp) < 1e-30) break;
        n_osc -= f / fp;
    }
    return n_osc;
}

// ── Iterative Brouwer osculating → mean element conversion ──

static bool iterative_osc_to_mean(
    const std::array<double, 6>& osc_kepler,
    double epoch_jd,
    double bstar_guess,
    SGP4Elements& mean_out) {

    double a_osc = osc_kepler[0];
    double e_osc = osc_kepler[1];
    double i_osc = osc_kepler[2];
    double raan_osc = osc_kepler[3];
    double argp_osc = osc_kepler[4];
    double M_osc = osc_kepler[5];

    double n_osc_rad_min = std::sqrt(MU_EARTH / (a_osc * a_osc * a_osc)) * 60.0;

    // Kozai-Brouwer: convert osculating n → mean n
    double n_mean_rad_min = osc_n_to_kozai(n_osc_rad_min, e_osc, i_osc);
    double n_rev_day = n_mean_rad_min * MIN_PER_DAY / TWO_PI;

    // Start with osculating as initial mean guess
    double mean_e = e_osc;
    double mean_i = i_osc;
    double mean_raan = raan_osc;
    double mean_argp = argp_osc;
    double mean_M = M_osc;

    // Build SGP4Elements for TLE generation
    SGP4Elements trial;
    trial.epoch_jd = epoch_jd;
    trial.epoch_iso = jd_to_iso_supgp(epoch_jd);
    trial.mean_motion = n_rev_day;
    trial.eccentricity = mean_e;
    trial.inclination = mean_i * RAD2DEG;
    trial.ra_of_asc_node = mean_raan * RAD2DEG;
    trial.arg_of_pericenter = mean_argp * RAD2DEG;
    trial.mean_anomaly = mean_M * RAD2DEG;
    trial.bstar = bstar_guess;
    trial.mean_motion_dot = 0.0;
    trial.mean_motion_ddot = 0.0;
    trial.norad_cat_id = 99999;
    trial.object_id = "99999A  ";

    auto angle_diff = [](double a, double b) -> double {
        double d = a - b;
        while (d > M_PI) d -= TWO_PI;
        while (d < -M_PI) d += TWO_PI;
        return d;
    };

    for (int iter = 0; iter < 15; iter++) {
        {
            // Initialize SGP4 directly with element values (no TLE string round-trip)
            double sgp4_epoch = jd_to_sgp4_epoch(epoch_jd);
            double n_kozai_rad_min = trial.mean_motion * TWO_PI / MIN_PER_DAY;
            elsetrec satrec;
            bool init_ok = SGP4Funcs::sgp4init(
                wgs72, 'i', "99999", sgp4_epoch,
                trial.bstar, trial.mean_motion_dot / (MIN_PER_DAY * MIN_PER_DAY / TWO_PI),
                trial.mean_motion_ddot, trial.eccentricity,
                trial.arg_of_pericenter * DEG2RAD,
                trial.inclination * DEG2RAD,
                trial.mean_anomaly * DEG2RAD,
                n_kozai_rad_min,
                trial.ra_of_asc_node * DEG2RAD,
                satrec);
            if (!init_ok || satrec.error != 0) break;

            double r[3], v[3];
            bool prop_ok = SGP4Funcs::sgp4(satrec, 0.0, r, v);
            if (!prop_ok || satrec.error != 0) break;

            auto sgp4_osc = cartesian_to_keplerian(r[0], r[1], r[2], v[0], v[1], v[2]);

            double n_sgp4 = std::sqrt(MU_EARTH / (sgp4_osc[0]*sgp4_osc[0]*sgp4_osc[0])) * 60.0;
            double n_sgp4_kozai = osc_n_to_kozai(n_sgp4, sgp4_osc[1], sgp4_osc[2]);
            double n_sgp4_rev = n_sgp4_kozai * MIN_PER_DAY / TWO_PI;

            double dn_rev = (n_osc_rad_min * MIN_PER_DAY / TWO_PI) -
                            (n_sgp4 * MIN_PER_DAY / TWO_PI);
            // Use Kozai-corrected for mean motion update
            double dn_mean = osc_n_to_kozai(n_osc_rad_min, e_osc, i_osc) * MIN_PER_DAY / TWO_PI - n_sgp4_rev;

            double de = e_osc - sgp4_osc[1];
            double di = i_osc - sgp4_osc[2];
            double draan = angle_diff(raan_osc, sgp4_osc[3]);
            double dargp = angle_diff(argp_osc, sgp4_osc[4]);
            double dM = angle_diff(M_osc, sgp4_osc[5]);

            double alpha = 0.8;
            trial.mean_motion += alpha * dn_mean;
            mean_e += alpha * de;
            mean_i += alpha * di;
            mean_raan += alpha * draan;
            mean_argp += alpha * dargp;
            mean_M += alpha * dM;

            while (mean_raan < 0) mean_raan += TWO_PI;
            while (mean_raan >= TWO_PI) mean_raan -= TWO_PI;
            while (mean_argp < 0) mean_argp += TWO_PI;
            while (mean_argp >= TWO_PI) mean_argp -= TWO_PI;
            while (mean_M < 0) mean_M += TWO_PI;
            while (mean_M >= TWO_PI) mean_M -= TWO_PI;
            mean_e = std::max(1e-5, std::min(0.99, mean_e));

            trial.eccentricity = mean_e;
            trial.inclination = mean_i * RAD2DEG;
            trial.ra_of_asc_node = mean_raan * RAD2DEG;
            trial.arg_of_pericenter = mean_argp * RAD2DEG;
            trial.mean_anomaly = mean_M * RAD2DEG;

            double pos_err = std::sqrt(de*de + di*di + draan*draan + dargp*dargp + dM*dM);
            if (pos_err < 1e-12) break;
        }
    }

    mean_out = trial;
    return true;
}

// ── Keplerian → SGP4 mean elements (with iterative Brouwer) ──

SGP4Elements keplerian_to_mean(
    const std::array<double, 6>& kepler,
    double epoch_jd) {

    double a_osc = kepler[0];
    double alt_km = a_osc - RE_KM;
    double bstar_guess = 0.0;
    if (alt_km < 1000) {
        // CelesTrak SupGP uses B* ≈ 0.03-0.05 for 550km Starlink
        // B* absorbs all drag and force model deficiencies
        bstar_guess = std::exp(-(alt_km - 200.0) / 120.0) * 0.05;
        if (bstar_guess > 0.1) bstar_guess = 0.1;
        if (bstar_guess < 1e-5) bstar_guess = 1e-5;
    }

    SGP4Elements el;
    el.norad_cat_id = 99999;
    el.object_id = "99999A  ";
    if (!iterative_osc_to_mean(kepler, epoch_jd, bstar_guess, el)) {
        double n_rad_min = std::sqrt(MU_EARTH / (a_osc * a_osc * a_osc)) * 60.0;
        el.epoch_jd = epoch_jd;
        el.epoch_iso = jd_to_iso_supgp(epoch_jd);
        el.mean_motion = n_rad_min * MIN_PER_DAY / TWO_PI;
        el.eccentricity = kepler[1];
        el.inclination = kepler[2] * RAD2DEG;
        el.ra_of_asc_node = kepler[3] * RAD2DEG;
        el.arg_of_pericenter = kepler[4] * RAD2DEG;
        el.mean_anomaly = kepler[5] * RAD2DEG;
        el.bstar = bstar_guess;
        el.mean_motion_dot = bstar_guess * 0.2;  // initial ndot estimate
        el.mean_motion_ddot = 0.0;
    }

    return el;
}

// ── Classical ↔ Equinoctial conversion ──

struct EquinoctialState {
    double af;     // e·cos(ω + Ω)
    double ag;     // e·sin(ω + Ω)
    double a_er;   // semi-major axis in Earth radii
    double L;      // mean longitude = M + ω + Ω (rad)
    double pe;     // tan(i/2)·sin(Ω)
    double qe;     // tan(i/2)·cos(Ω)
    double bstar;
};

static EquinoctialState classical_to_equinoctial(const SGP4Elements& el) {
    double e = el.eccentricity;
    double i = el.inclination * DEG2RAD;
    double raan = el.ra_of_asc_node * DEG2RAD;
    double argp = el.arg_of_pericenter * DEG2RAD;
    double M = el.mean_anomaly * DEG2RAD;

    double omega_bar = argp + raan;  // ω + Ω

    EquinoctialState eq;
    eq.af = e * std::cos(omega_bar);
    eq.ag = e * std::sin(omega_bar);

    // mean motion (rev/day) → semi-major axis (Earth radii)
    double n_rad_min = el.mean_motion * TWO_PI / MIN_PER_DAY;
    // Use Kozai-Brouwer inverse to get osculating-equivalent a
    // a = (XKE / n_recovered)^(2/3) but for mean elements we use directly
    double a_km = std::pow(MU_EARTH / ((n_rad_min/60.0) * (n_rad_min/60.0)), 1.0/3.0);
    eq.a_er = a_km / RE_KM;

    eq.L = normalize_angle(M + omega_bar);

    double half_i_tan = std::tan(i / 2.0);
    eq.pe = half_i_tan * std::sin(raan);
    eq.qe = half_i_tan * std::cos(raan);
    eq.bstar = el.bstar;

    return eq;
}

static SGP4Elements equinoctial_to_classical(const EquinoctialState& eq, const SGP4Elements& base) {
    SGP4Elements el = base;

    double e = std::sqrt(eq.af * eq.af + eq.ag * eq.ag);
    e = std::max(1e-5, std::min(0.99, e));

    double pq_mag = std::sqrt(eq.pe * eq.pe + eq.qe * eq.qe);
    double inc = 2.0 * std::atan(pq_mag);  // rad

    double raan = std::atan2(eq.pe, eq.qe);  // rad
    if (raan < 0) raan += TWO_PI;

    double omega_bar = std::atan2(eq.ag, eq.af);  // ω + Ω
    double argp = omega_bar - raan;
    while (argp < 0) argp += TWO_PI;
    while (argp >= TWO_PI) argp -= TWO_PI;

    double M = eq.L - omega_bar;
    while (M < 0) M += TWO_PI;
    while (M >= TWO_PI) M -= TWO_PI;

    // a (Earth radii) → mean motion (rev/day)
    double a_km = std::max(eq.a_er, 1.01) * RE_KM;  // clamp to avoid crash
    double n_rad_sec = std::sqrt(MU_EARTH / (a_km * a_km * a_km));
    double n_rad_min = n_rad_sec * 60.0;
    double n_rev_day = n_rad_min * MIN_PER_DAY / TWO_PI;

    el.eccentricity = e;
    el.inclination = inc * RAD2DEG;
    el.ra_of_asc_node = std::fmod(raan * RAD2DEG + 360.0, 360.0);
    el.arg_of_pericenter = std::fmod(argp * RAD2DEG + 360.0, 360.0);
    el.mean_anomaly = std::fmod(M * RAD2DEG + 360.0, 360.0);
    el.mean_motion = n_rev_day;
    el.bstar = std::max(-1.0, std::min(1.0, eq.bstar));
    // ndot preserved from base, set by set_equinoctial caller
    el.mean_motion_ddot = 0.0;

    return el;
}

static void get_equinoctial(const SGP4Elements& el, double p[NPARAMS]) {
    EquinoctialState eq = classical_to_equinoctial(el);
    p[IDX_AF] = eq.af;
    p[IDX_AG] = eq.ag;
    p[IDX_A]  = eq.a_er;
    p[IDX_L]  = eq.L;
    p[IDX_PE] = eq.pe;
    p[IDX_QE] = eq.qe;
    p[IDX_BSTAR] = eq.bstar;
    p[IDX_NDOT] = el.mean_motion_dot;
}

static SGP4Elements set_equinoctial(const SGP4Elements& base, const double p[NPARAMS]) {
    EquinoctialState eq;
    eq.af = p[IDX_AF];
    eq.ag = p[IDX_AG];
    eq.a_er = p[IDX_A];
    eq.L = p[IDX_L];
    eq.pe = p[IDX_PE];
    eq.qe = p[IDX_QE];
    eq.bstar = p[IDX_BSTAR];
    SGP4Elements el = equinoctial_to_classical(eq, base);
    el.mean_motion_dot = p[IDX_NDOT];
    return el;
}

// ── SGP4 propagation via Vallado API ──

struct PropState {
    double x, y, z, vx, vy, vz;
};

// Initialize elsetrec from our SGP4Elements (no TLE string formatting)
static bool init_satrec(const SGP4Elements& el, elsetrec& satrec) {
    double sgp4_epoch = jd_to_sgp4_epoch(el.epoch_jd);
    double n_kozai_rad_min = el.mean_motion * TWO_PI / MIN_PER_DAY;
    // ndot: our units are rev/day², Vallado wants rad/min² / 2
    // ndot_vallado = (ndot_rev_day * 2π / (1440²)) — but sgp4init
    // internally divides by xnodp convention. Pass as-is in TLE-compatible units.
    double ndot_tle = el.mean_motion_dot / (MIN_PER_DAY * MIN_PER_DAY / TWO_PI);

    bool ok = SGP4Funcs::sgp4init(
        wgs72, 'i', "99999", sgp4_epoch,
        el.bstar, ndot_tle, el.mean_motion_ddot,
        el.eccentricity,
        el.arg_of_pericenter * DEG2RAD,
        el.inclination * DEG2RAD,
        el.mean_anomaly * DEG2RAD,
        n_kozai_rad_min,
        el.ra_of_asc_node * DEG2RAD,
        satrec);
    return ok && satrec.error == 0;
}

static bool propagate_elements(
    const SGP4Elements& el, double target_jd, PropState& out) {
    elsetrec satrec;
    if (!init_satrec(el, satrec)) return false;

    double dt_min = (target_jd - el.epoch_jd) * MIN_PER_DAY;
    double r[3], v[3];
    bool ok = SGP4Funcs::sgp4(satrec, dt_min, r, v);
    if (!ok || satrec.error != 0) return false;

    out.x = r[0]; out.y = r[1]; out.z = r[2];
    out.vx = v[0]; out.vy = v[1]; out.vz = v[2];
    return true;
}

// Batch propagation: init once, propagate to all times
static bool propagate_batch(
    const SGP4Elements& el,
    const std::vector<EphemerisPoint>& points,
    std::vector<PropState>& out) {

    elsetrec satrec;
    if (!init_satrec(el, satrec)) return false;

    out.resize(points.size());
    for (size_t i = 0; i < points.size(); i++) {
        double dt_min = (points[i].epoch_jd - el.epoch_jd) * MIN_PER_DAY;
        double r[3], v[3];
        bool ok = SGP4Funcs::sgp4(satrec, dt_min, r, v);
        if (!ok || satrec.error != 0) return false;
        out[i].x = r[0]; out[i].y = r[1]; out[i].z = r[2];
        out[i].vx = v[0]; out[i].vy = v[1]; out[i].vz = v[2];
    }
    return true;
}

// ── 3D vector residuals ──

static double compute_residuals_3d(
    const SGP4Elements& el,
    const std::vector<EphemerisPoint>& points,
    Eigen::VectorXd& residuals) {

    size_t N = points.size();
    residuals.resize(3 * N);
    double sum_sq = 0.0;
    int count = 0;

    std::vector<PropState> props;
    if (!propagate_batch(el, points, props)) {
        residuals.setConstant(1e3);
        return 1e6;
    }

    for (size_t i = 0; i < N; i++) {
        double dx = props[i].x - points[i].x;
        double dy = props[i].y - points[i].y;
        double dz = props[i].z - points[i].z;
        residuals[3*i + 0] = dx;
        residuals[3*i + 1] = dy;
        residuals[3*i + 2] = dz;
        sum_sq += dx*dx + dy*dy + dz*dz;
        count++;
    }

    return (count > 0) ? std::sqrt(sum_sq / count) : 1e6;
}

// ── Scalar position RMS ──

static double compute_rms_position(
    const SGP4Elements& el,
    const std::vector<EphemerisPoint>& points) {

    std::vector<PropState> props;
    if (!propagate_batch(el, points, props)) return 1e6;

    double sum_sq = 0.0;
    for (size_t i = 0; i < points.size(); i++) {
        double dx = props[i].x - points[i].x;
        double dy = props[i].y - points[i].y;
        double dz = props[i].z - points[i].z;
        sum_sq += dx*dx + dy*dy + dz*dz;
    }

    return (points.size() > 0) ? std::sqrt(sum_sq / points.size()) : 1e6;
}

// ── Levenberg-Marquardt with equinoctial elements ──
// Vallado's approach: uniform percentchg perturbation, SVD solve

static FitResult lm_fit_equinoctial(
    const SGP4Elements& initial_el,
    const std::vector<EphemerisPoint>& fit_points,
    const FitterConfig& config) {

    SGP4Elements el = initial_el;
    el.mean_motion_ddot = 0.0;
    // ndot is now fit as the 8th parameter — keep initial value

    double params[NPARAMS];
    get_equinoctial(el, params);

    size_t N = fit_points.size();
    size_t M = N * 3;

    Eigen::VectorXd residuals;
    double rms = compute_residuals_3d(el, fit_points, residuals);

    static constexpr double PERCENTCHG = 0.001;
    static constexpr double DELTAAMTCHG = 1e-7;

    double lambda = 1e-3;
    double prev_sigma = rms;
    int iter;
    bool converged = false;

    const int max_iterations = config.max_iterations > 0 ? config.max_iterations : 50;
    for (iter = 0; iter < max_iterations; iter++) {
        // Build Jacobian (M × NPARAMS) via CENTRAL finite differences
        // (Tudat insight: O(h²) accuracy vs O(h) for forward differences)
        Eigen::MatrixXd J(M, NPARAMS);

        for (int j = 0; j < NPARAMS; j++) {
            double saved = params[j];

            // Vallado: delta = param * percentchg
            double delta = std::abs(saved) * PERCENTCHG;
            for (int bump = 0; bump < 5 && delta < DELTAAMTCHG; bump++) {
                delta = (delta == 0.0) ? DELTAAMTCHG : delta * 10.0;
            }

            // Central difference: (f(x+h) - f(x-h)) / (2h)
            params[j] = saved + delta;
            SGP4Elements el_plus = set_equinoctial(el, params);
            Eigen::VectorXd res_plus;
            compute_residuals_3d(el_plus, fit_points, res_plus);

            params[j] = saved - delta;
            SGP4Elements el_minus = set_equinoctial(el, params);
            Eigen::VectorXd res_minus;
            compute_residuals_3d(el_minus, fit_points, res_minus);

            params[j] = saved;

            for (size_t i = 0; i < M; i++) {
                J(i, j) = (res_plus(i) - res_minus(i)) / (2.0 * delta);
            }
        }

        // SVD solve of augmented system: [J; sqrt(λ)·D] δ = [-r; 0]
        Eigen::MatrixXd J_aug(M + NPARAMS, NPARAMS);
        Eigen::VectorXd r_aug(M + NPARAMS);

        J_aug.topRows(M) = J;
        r_aug.head(M) = -residuals;

        for (int j = 0; j < NPARAMS; j++) {
            double diag_val = J.col(j).norm();
            diag_val = std::max(1e-30, diag_val);

            J_aug.row(M + j).setZero();
            J_aug(M + j, j) = std::sqrt(lambda) * diag_val;
            r_aug(M + j) = 0;
        }

        Eigen::VectorXd delta_p = J_aug.bdcSvd<Eigen::ComputeThinU | Eigen::ComputeThinV>().solve(r_aug);

        // Step limiting (Vallado: 90% for orbital, 40% for B*/ndot)
        for (int i = 0; i < NPARAMS; i++) {
            double ref = std::abs(params[i]) + 1e-12;
            double rel = std::abs(delta_p(i)) / ref;
            double max_step = (i == IDX_BSTAR || i == IDX_NDOT) ? 0.4 : 0.9;
            if (rel > max_step) {
                delta_p(i) *= max_step / rel;
            }
        }

        // Trial step
        double trial_params[NPARAMS];
        for (int i = 0; i < NPARAMS; i++) {
            trial_params[i] = params[i] + delta_p(i);
        }

        SGP4Elements trial_el = set_equinoctial(el, trial_params);
        Eigen::VectorXd trial_residuals;
        double trial_rms = compute_residuals_3d(trial_el, fit_points, trial_residuals);

        if (trial_rms < rms) {
            std::memcpy(params, trial_params, sizeof(params));
            el = trial_el;
            residuals = trial_residuals;
            rms = trial_rms;
            lambda *= 0.1;
            if (lambda < 1e-10) lambda = 1e-10;

            // Convergence: relative sigma change < 0.0002 (Vallado)
            double sigma_change = std::abs(prev_sigma - rms) / (rms + 1e-30);
            if (sigma_change < config.convergence_tol && iter > 2) {
                converged = true;
                iter++;
                break;
            }
            prev_sigma = rms;
        } else {
            lambda *= 10.0;
            if (lambda > 1e10) lambda = 1e10;
        }
    }

    rms = compute_rms_position(el, fit_points);

    FitResult result;
    result.elements = el;
    result.elements.rms_km = rms;
    result.elements.iterations = iter;
    result.elements.converged = converged;
    result.rms_km = rms;
    result.iterations = iter;
    result.converged = converged;
    return result;
}

// ── Nelder-Mead simplex optimizer ──

static FitResult nelder_mead_polish(
    const SGP4Elements& initial_el,
    const std::vector<EphemerisPoint>& fit_points,
    int max_iter = 300) {

    auto cost = [&](const double p[NPARAMS]) -> double {
        SGP4Elements el = set_equinoctial(initial_el, p);
        return compute_rms_position(el, fit_points);
    };

    double params[NPARAMS];
    get_equinoctial(initial_el, params);

    constexpr int NV = NPARAMS + 1;
    double simplex[NV][NPARAMS];
    double fvals[NV];

    std::memcpy(simplex[0], params, sizeof(params));
    fvals[0] = cost(simplex[0]);

    for (int j = 0; j < NPARAMS; j++) {
        std::memcpy(simplex[j + 1], params, sizeof(params));
        double scale = std::abs(params[j]) * 0.001;
        if (scale < 1e-8) scale = 1e-6;
        if (j == IDX_BSTAR) scale = std::max(1e-5, std::abs(params[j]) * 0.01);
        simplex[j + 1][j] += scale;
        fvals[j + 1] = cost(simplex[j + 1]);
    }

    constexpr double ALPHA = 1.0, GAMMA = 2.0, RHO = 0.5, SIGMA = 0.5;

    for (int it = 0; it < max_iter; it++) {
        int order[NV];
        std::iota(order, order + NV, 0);
        std::sort(order, order + NV, [&](int a, int b) { return fvals[a] < fvals[b]; });

        int best = order[0], worst = order[NV - 1], second_worst = order[NV - 2];

        double diam = 0;
        for (int j = 0; j < NPARAMS; j++) {
            double mn = simplex[best][j], mx = simplex[best][j];
            for (int v = 1; v < NV; v++) {
                mn = std::min(mn, simplex[order[v]][j]);
                mx = std::max(mx, simplex[order[v]][j]);
            }
            diam = std::max(diam, mx - mn);
        }
        if (diam < 1e-12) break;

        double centroid[NPARAMS] = {};
        for (int v = 0; v < NV - 1; v++)
            for (int j = 0; j < NPARAMS; j++) centroid[j] += simplex[order[v]][j];
        for (int j = 0; j < NPARAMS; j++) centroid[j] /= (NV - 1);

        double xr[NPARAMS];
        for (int j = 0; j < NPARAMS; j++)
            xr[j] = centroid[j] + ALPHA * (centroid[j] - simplex[worst][j]);
        double fr = cost(xr);

        if (fr < fvals[second_worst] && fr >= fvals[best]) {
            std::memcpy(simplex[worst], xr, sizeof(xr));
            fvals[worst] = fr;
        } else if (fr < fvals[best]) {
            double xe[NPARAMS];
            for (int j = 0; j < NPARAMS; j++)
                xe[j] = centroid[j] + GAMMA * (xr[j] - centroid[j]);
            double fe = cost(xe);
            if (fe < fr) {
                std::memcpy(simplex[worst], xe, sizeof(xe));
                fvals[worst] = fe;
            } else {
                std::memcpy(simplex[worst], xr, sizeof(xr));
                fvals[worst] = fr;
            }
        } else {
            double xc[NPARAMS];
            if (fr < fvals[worst]) {
                for (int j = 0; j < NPARAMS; j++)
                    xc[j] = centroid[j] + RHO * (xr[j] - centroid[j]);
            } else {
                for (int j = 0; j < NPARAMS; j++)
                    xc[j] = centroid[j] + RHO * (simplex[worst][j] - centroid[j]);
            }
            double fc = cost(xc);
            if (fc < std::min(fr, fvals[worst])) {
                std::memcpy(simplex[worst], xc, sizeof(xc));
                fvals[worst] = fc;
            } else {
                for (int v = 0; v < NV; v++) {
                    if (order[v] == best) continue;
                    for (int j = 0; j < NPARAMS; j++)
                        simplex[order[v]][j] = simplex[best][j] + SIGMA * (simplex[order[v]][j] - simplex[best][j]);
                    fvals[order[v]] = cost(simplex[order[v]]);
                }
            }
        }
    }

    int best_idx = 0;
    for (int v = 1; v < NV; v++)
        if (fvals[v] < fvals[best_idx]) best_idx = v;

    SGP4Elements best_el = set_equinoctial(initial_el, simplex[best_idx]);
    double best_rms = fvals[best_idx];

    FitResult result;
    result.elements = best_el;
    result.elements.rms_km = best_rms;
    result.rms_km = best_rms;
    result.converged = true;
    result.iterations = max_iter;
    return result;
}

// ── Differential Evolution ──

static FitResult differential_evolution(
    const SGP4Elements& initial_el,
    const std::vector<EphemerisPoint>& fit_points,
    int pop_size = 30,
    int max_gen = 40) {

    std::mt19937 rng(42);
    std::uniform_real_distribution<double> unif(0.0, 1.0);

    double base_params[NPARAMS];
    get_equinoctial(initial_el, base_params);

    // Perturbation ranges in equinoctial space
    double range[NPARAMS] = {
        5e-4,    // af
        5e-4,    // ag
        0.005,   // a_er (~30 km)
        0.1,     // L (rad) — ~6 degrees
        0.01,    // pe
        0.01,    // qe
        0.002,   // B*
        0.002    // ndot
    };

    std::vector<std::array<double, NPARAMS>> pop(pop_size);
    std::vector<double> pop_cost(pop_size);

    pop[0] = {};
    for (int j = 0; j < NPARAMS; j++) pop[0][j] = base_params[j];
    pop_cost[0] = compute_rms_position(set_equinoctial(initial_el, pop[0].data()), fit_points);

    for (int i = 1; i < pop_size; i++) {
        for (int j = 0; j < NPARAMS; j++)
            pop[i][j] = base_params[j] + range[j] * (2.0 * unif(rng) - 1.0);
        pop_cost[i] = compute_rms_position(set_equinoctial(initial_el, pop[i].data()), fit_points);
    }

    double F = 0.8, CR = 0.9;

    for (int gen = 0; gen < max_gen; gen++) {
        for (int i = 0; i < pop_size; i++) {
            int r1, r2, r3;
            do { r1 = rng() % pop_size; } while (r1 == i);
            do { r2 = rng() % pop_size; } while (r2 == i || r2 == r1);
            do { r3 = rng() % pop_size; } while (r3 == i || r3 == r1 || r3 == r2);

            std::array<double, NPARAMS> trial;
            int j_rand = rng() % NPARAMS;
            for (int j = 0; j < NPARAMS; j++) {
                if (unif(rng) < CR || j == j_rand)
                    trial[j] = pop[r1][j] + F * (pop[r2][j] - pop[r3][j]);
                else
                    trial[j] = pop[i][j];
            }

            double trial_cost = compute_rms_position(set_equinoctial(initial_el, trial.data()), fit_points);
            if (trial_cost < pop_cost[i]) {
                pop[i] = trial;
                pop_cost[i] = trial_cost;
            }
        }
    }

    int best_idx = 0;
    for (int i = 1; i < pop_size; i++)
        if (pop_cost[i] < pop_cost[best_idx]) best_idx = i;

    SGP4Elements best_el = set_equinoctial(initial_el, pop[best_idx].data());

    FitResult result;
    result.elements = best_el;
    result.elements.rms_km = pop_cost[best_idx];
    result.rms_km = pop_cost[best_idx];
    result.converged = true;
    result.iterations = max_gen;
    return result;
}

// ── Single-epoch fit pipeline ──

static FitResult fit_single_epoch(
    const std::vector<EphemerisPoint>& all_points,
    size_t epoch_idx,
    const FitterConfig& config) {

    // Build fit points: 2 orbital periods (~192 min), ~144 points
    std::vector<EphemerisPoint> fit_points;
    double epoch_jd = all_points[epoch_idx].epoch_jd;
    double max_jd = epoch_jd + config.fit_window_sec / SEC_PER_DAY;

    // Determine subsample rate to get ~144 points
    size_t total_in_window = 0;
    for (size_t i = epoch_idx; i < all_points.size(); i++) {
        if (all_points[i].epoch_jd > max_jd) break;
        total_in_window++;
    }
    int subsample = config.subsample;
    if (subsample <= 1 && total_in_window > 160) {
        subsample = static_cast<int>(total_in_window / 144);
        if (subsample < 1) subsample = 1;
    }

    for (size_t i = epoch_idx; i < all_points.size(); i += subsample) {
        if (all_points[i].epoch_jd > max_jd) break;
        fit_points.push_back(all_points[i]);
    }

    if (fit_points.size() < 3) {
        return {{}, {}, 1e6, 0, false};
    }

    // Phase 1: Initial guess via iterative Brouwer conversion
    const auto& ep = all_points[epoch_idx];
    auto kepler = cartesian_to_keplerian(ep.x, ep.y, ep.z, ep.vx, ep.vy, ep.vz);
    SGP4Elements el = keplerian_to_mean(kepler, epoch_jd);

    // Assign temporary catalog identifiers (overwritten when real NORAD ID is known)
    el.norad_cat_id = 99999;
    el.object_id = "99999A  ";

    // Phase 2: Initial B* and ndot from altitude
    // CelesTrak SupGP B* for 550km Starlink is typically 0.03-0.05
    // CelesTrak ndot for 550km Starlink is typically 0.005-0.01 rev/day²
    double alt_km2 = kepler[0] - RE_KM;
    if (alt_km2 < 1000 && alt_km2 > 150) {
        double expected_bstar = std::exp(-(alt_km2 - 200.0) / 120.0) * 0.05;
        expected_bstar = std::max(1e-5, std::min(0.1, expected_bstar));
        el.bstar = expected_bstar;
        // ndot correlates with B* and altitude
        double expected_ndot = expected_bstar * 0.2;  // rough correlation from CelesTrak data
        el.mean_motion_dot = expected_ndot;
    }

    // Phase 3: LM with equinoctial elements (B* in Jacobian from the start)
    FitterConfig lm_config = config;
    lm_config.max_iterations = bounded_iteration_count(50, config);
    auto result = lm_fit_equinoctial(el, fit_points, lm_config);

    // Phase 4: Second LM pass with tighter convergence from best result
    FitterConfig lm2_config = config;
    lm2_config.max_iterations = bounded_iteration_count(30, config);
    lm2_config.convergence_tol = 1e-4;
    auto result2 = lm_fit_equinoctial(result.elements, fit_points, lm2_config);
    if (result2.rms_km < result.rms_km) result = result2;

    // Phase 5: NM polish if RMS > 0.3 km
    if (result.rms_km > 0.3) {
        auto nm_result = nelder_mead_polish(
            result.elements,
            fit_points,
            bounded_iteration_count(300, config));
        if (nm_result.rms_km < result.rms_km) {
            result.elements = nm_result.elements;
            result.rms_km = nm_result.rms_km;
            result.iterations = nm_result.iterations;
        }
    }

    // Phase 6: DE + LM if RMS > 0.5 km
    if (result.rms_km > 0.5) {
        auto de_result = differential_evolution(
            result.elements,
            fit_points,
            40,
            bounded_iteration_count(60, config));
        if (de_result.rms_km < result.rms_km) {
            auto de_lm = lm_fit_equinoctial(de_result.elements, fit_points, lm_config);
            if (de_lm.rms_km < result.rms_km) {
                result = de_lm;
            } else if (de_result.rms_km < result.rms_km) {
                result.elements = de_result.elements;
                result.rms_km = de_result.rms_km;
                result.iterations = de_result.iterations;
            }
        }
    }

    // Final RMS
    result.rms_km = compute_rms_position(result.elements, fit_points);
    result.elements.rms_km = result.rms_km;
    result.elements.converged = result.converged;
    result.elements.iterations = result.iterations;
    result.elements.max_iterations = config.max_iterations;

    return result;
}

// ── Main fit function with multi-start ──

FitResult fit_sgp4(
    const std::vector<EphemerisPoint>& points,
    const FitterConfig& config) {

    if (points.size() < 3) {
        return {{}, {}, 1e6, 0, false};
    }

    // Primary fit: epoch at first point
    auto best_result = fit_single_epoch(points, 0, config);

    // Multi-start: try many epoch offsets if mediocre
    if (best_result.rms_km > 0.28 && points.size() > 100) {
        size_t points_per_hour = 3600 / 60;  // MEME = 60s cadence

        // Try 1h through 12h offsets. A positive interactive iteration cap
        // also limits multi-start attempts so a bad edit cannot multiply work.
        const int max_offset_hours =
            config.max_iterations > 0
                ? std::max(0, std::min(12, config.max_iterations - 1))
                : 12;
        for (int h = 1; h <= max_offset_hours; h++) {
            size_t offset = points_per_hour * h;
            if (offset >= points.size()) break;
            auto trial = fit_single_epoch(points, offset, config);
            if (trial.rms_km < best_result.rms_km) {
                best_result = trial;
            }
            if (best_result.rms_km < 0.22) break;
        }
    }

    return best_result;
}

FitResult fit_sgp4_series(
    const StateSeries& series,
    const FitterConfig& config) {

    auto result = fit_sgp4(series.samples, config);

    // Labeling flows from the parsed ephemeris + caller/manifest — never
    // hardcoded to an operator. Empty/zero metadata leaves the fit placeholder
    // in place (e.g. the "99999A" object id assigned during the fit).
    if (series.meta.norad_cat_id > 0) {
        result.elements.norad_cat_id = series.meta.norad_cat_id;
    }
    if (!series.meta.object_name.empty()) {
        result.elements.object_name = series.meta.object_name;
    }
    if (!series.meta.object_id.empty()) {
        result.elements.object_id = series.meta.object_id;
    }
    result.elements.data_source = series.meta.data_source;

    return result;
}

FitResult fit_sgp4_meme(
    const MEMEFile& meme,
    const FitterConfig& config,
    const std::string& data_source) {

    StateSeries series;
    series.samples = meme.points;
    series.meta.norad_cat_id = meme.header.norad_cat_id;
    series.meta.object_name = meme.header.object_name;
    // MEME state vectors are already effectively TEME (confirmed by the <1 m
    // fit RMS on the checked-in Starlink suite); no rotation is applied.
    series.meta.ref_frame = "TEME";
    series.meta.source_frame =
        meme.header.reference_frame.empty() ? "TEME" : meme.header.reference_frame;
    series.meta.time_system = "UTC";
    series.meta.data_source = data_source;
    series.meta.segment_count = 1;
    // MEME's filename COSPAR field is a SpaceX-internal id, not an international
    // designator, so OBJECT_ID is intentionally not derived from it.

    return fit_sgp4_series(series, config);
}

// ── Output Formatters ──

std::string elements_to_csv(const SGP4Elements& el) {
    std::ostringstream ss;
    ss << el.object_name << ","
       << el.object_id << ","
       << el.epoch_iso << ","
       << std::fixed << std::setprecision(8) << el.mean_motion << ","
       << std::setprecision(7) << el.eccentricity << ","
       << std::setprecision(4) << el.inclination << ","
       << el.ra_of_asc_node << ","
       << el.arg_of_pericenter << ","
       << el.mean_anomaly << ","
       << el.ephemeris_type << ","
       << el.classification << ","
       << el.norad_cat_id << ","
       << el.element_set_no << ","
       << el.rev_at_epoch << ","
       << std::scientific << std::setprecision(5) << el.bstar << ","
       << el.mean_motion_dot << ","
       << el.mean_motion_ddot << ","
       << std::fixed << std::setprecision(3) << el.rms_km << ","
       << el.data_source;
    return ss.str();
}

std::string elements_to_json(const SGP4Elements& el) {
    std::ostringstream ss;
    ss << "{"
       << "\"OBJECT_NAME\":\"" << el.object_name << "\","
       << "\"OBJECT_ID\":\"" << el.object_id << "\","
       << "\"EPOCH\":\"" << el.epoch_iso << "\","
       << "\"MEAN_MOTION\":" << std::fixed << std::setprecision(8) << el.mean_motion << ","
       << "\"ECCENTRICITY\":" << std::setprecision(7) << el.eccentricity << ","
       << "\"INCLINATION\":" << std::setprecision(4) << el.inclination << ","
       << "\"RA_OF_ASC_NODE\":" << el.ra_of_asc_node << ","
       << "\"ARG_OF_PERICENTER\":" << el.arg_of_pericenter << ","
       << "\"MEAN_ANOMALY\":" << el.mean_anomaly << ","
       << "\"EPHEMERIS_TYPE\":" << el.ephemeris_type << ","
       << "\"CLASSIFICATION_TYPE\":\"" << el.classification << "\","
       << "\"NORAD_CAT_ID\":" << el.norad_cat_id << ","
       << "\"ELEMENT_SET_NO\":" << el.element_set_no << ","
       << "\"REV_AT_EPOCH\":" << el.rev_at_epoch << ","
       << "\"BSTAR\":" << std::scientific << std::setprecision(5) << el.bstar << ","
       << "\"MEAN_MOTION_DOT\":" << el.mean_motion_dot << ","
       << "\"MEAN_MOTION_DDOT\":" << el.mean_motion_ddot << ","
       << "\"RMS\":\"" << std::fixed << std::setprecision(3) << el.rms_km << "\","
       << "\"ITERATIONS\":" << el.iterations << ","
       << "\"MAX_ITERATIONS\":" << el.max_iterations << ","
       << "\"CONVERGED\":" << (el.converged ? "true" : "false") << ","
       << "\"DATA_SOURCE\":\"" << el.data_source << "\""
       << "}";
    return ss.str();
}

std::string elements_to_tle(const SGP4Elements& el) {
    std::string l1, l2;
    make_tle_lines(el, l1, l2);
    return l1 + "\n" + l2;
}

}  // namespace od
