// code500_stk_native.cpp — measured acceptance for the Code-500 and STK
// ephemeris/attitude containers.
//
// Every line printed here is a NUMBER with a named authority:
//
//   * the Code-500 checks are self-authoritative round trips — the container
//     is binary and lossless by construction, so the only honest question is
//     whether this reader and this writer are inverses, down to the byte;
//   * the STK .e checks are cross-authoritative: the values this reader
//     produces are compared with the digits PRINTED in a published STK file
//     (Orekit 13.1's own test resource, written by STK v12.2.0) and,
//     independently, with what Orekit 13.1's STKEphemerisFileParser makes of
//     the same bytes. Two parsers written from the same spec by people who
//     never spoke agreeing to the last ULP is the strongest statement
//     available about a text format;
//   * the STK .a check is a round trip, because no published attitude file
//     with tabulated reference values was found — see PROVENANCE.md, which
//     records that the .a fixture was authored here from the format
//     description and is NOT an independent authority.
//
// Build:
//   clang++ -std=c++17 -O2 -I src tests/code500_stk_native.cpp -o /tmp/c500_stk
//   /tmp/c500_stk <fixtures-dir>

#include "code500.hpp"
#include "stk_ephemeris.hpp"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

namespace {

int failures = 0;
int checks = 0;

/// One acceptance line. `value` is the measured quantity and `bound` the limit
/// it must not exceed; both are printed so a regression moves a number rather
/// than flipping a word.
void report(const char* name, double value, double bound) {
    ++checks;
    const bool ok = std::isfinite(value) && value <= bound;
    if (!ok) ++failures;
    std::printf("RESULT %-46s %14.6e %10.1e %s\n", name, value, bound, ok ? "PASS" : "FAIL");
}

/// A count-shaped assertion: mismatches must be zero.
void report_count(const char* name, long value, long bound) {
    ++checks;
    const bool ok = value <= bound;
    if (!ok) ++failures;
    std::printf("RESULT %-46s %14ld %10ld %s\n", name, value, bound, ok ? "PASS" : "FAIL");
}

double rel(double a, double b) {
    const double d = std::fabs(a - b);
    const double m = std::fabs(b) > std::fabs(a) ? std::fabs(b) : std::fabs(a);
    return m > 0.0 ? d / m : d;
}

bool read_file(const std::string& path, std::string* out) {
    std::ifstream in(path.c_str(), std::ios::binary);
    if (!in) return false;
    std::ostringstream ss;
    ss << in.rdbuf();
    *out = ss.str();
    return true;
}

/* ---------------------------------------------------------------------- */
/* A deterministic state history                                          */
/* ---------------------------------------------------------------------- */

/// A circular orbit sampled on a fixed grid. Analytic and reproducible, so the
/// round-trip error below is the container's, not a random draw's.
constexpr double kPi = 3.14159265358979323846;

ephem::Series make_series(size_t n, double step_sec, double base_epoch_sec) {
    ephem::Series s;
    s.object_name = "EPHEM";
    s.object_id = "2674";
    s.center_name = "Earth";
    s.frame_name = "J2000";
    s.time_system = "UTC";
    const double r = 7000.0;                 /* km  */
    const double v = 7.546049108166282;      /* km/s, circular at r for GM 398600.4418 */
    const double period = 2.0 * kPi * r / v;
    for (size_t i = 0; i < n; ++i) {
        const double t = static_cast<double>(i) * step_sec;
        const double a = 2.0 * kPi * t / period;
        ephem::StateRow row;
        row.epoch = base_epoch_sec + t;
        row.pos[0] = r * std::cos(a);
        row.pos[1] = r * std::sin(a) * 0.6;
        row.pos[2] = r * std::sin(a) * 0.8;
        row.vel[0] = -v * std::sin(a);
        row.vel[1] = v * std::cos(a) * 0.6;
        row.vel[2] = v * std::cos(a) * 0.8;
        row.has_vel = true;
        s.rows.push_back(row);
    }
    return s;
}

/// Seconds from the Code-500 DUT origin (1957-09-18) to a civil midnight, on
/// whatever scale the file declares. Calendar arithmetic only.
double dut_epoch_seconds(int y, int m, int d) {
    return static_cast<double>(code500::days_from_civil(y, m, d) -
                               code500::days_from_civil(1957, 9, 18)) *
           86400.0;
}

code500::Header make_header(bool big_endian) {
    code500::Header h;
    h.big_endian = big_endian;
    h.year_format = 1;
    h.product_id = "EPHEM   ";
    h.sat_id = 2674.0;
    h.time_system_indicator = 2.0; /* UTC */
    h.tape_id = "STANDARD";
    h.source_id = "GMAT    ";
    h.header_title = "orbit-products code-500 acceptance";
    h.central_body_indicator = 1.0;    /* Earth, integration scale */
    h.coordinate_center_indicator = 0.0; /* Earth, output scale     */
    h.ref_time_for_dut_yymmdd = code500::kDefaultRefTimeForDutYymmdd;
    h.coord_system_indicator_1 = "2000";
    h.coord_system_indicator_2 = 4;
    h.orbit_theory = "COWELL  ";
    h.atmospheric_density_model = "JR      ";
    h.drag_coefficient = 2.2;
    h.sc_reflectivity_constant = 1.8;
    h.area_of_spacecraft = 15.5;
    h.mass_of_spacecraft = 850.0;
    h.zonal_tesseral_harmonics_indicator = 1.0;
    h.lunar_grav_perturb_indicator = 1.0;
    h.solar_radiation_perturb_indicator = 1.0;
    h.solar_grav_perturb_indicator = 1.0;
    h.atmospheric_drag_perturb_indicator = 1.0;
    h.precession_nutation_indicator = 1.0;
    h.leap_second_indicator = 1;
    h.tracking_validation_indicator = 3;
    for (int i = 0; i < 6; ++i) h.brouwer_lyddane[i] = 0.5 + i;
    for (int i = 0; i < 6; ++i) h.keplerian_elements_at_epoch_rad[i] = 0.125 * (i + 1);
    for (int i = 0; i < 14; ++i) h.t_sub_q[i] = 1.0 / (i + 3);
    for (int i = 0; i < 14; ++i) h.brouwer_1st_order_drag_terms[i] = -0.25 * (i + 1);
    for (int i = 0; i < 14; ++i) h.brouwer_2nd_order_drag_terms[i] = 0.0625 * (i + 1);
    for (int i = 0; i < 3; ++i) h.geocentric_coord_of_sun_at_epoch[i] = 1.0e8 * (i + 1);
    for (int i = 0; i < 4; ++i) h.dc_observation_time_span[i] = 12.5 * (i + 1);
    h.total_number_of_brouwer_drag_terms = 14.0;
    h.rho_sub_1 = 1e-13;
    h.rho_sub_2 = 2e-13;
    h.rho_sub_3 = 3e-13;
    h.rho_sub_4 = 4e-13;
    h.true_anomaly_at_epoch = 0.3;
    h.arg_of_latitude_at_epoch = 0.4;
    h.flight_path_angle_at_epoch = 0.0;
    h.ecc_anomaly_at_epoch = 0.29;
    h.anomalistic_period_dut = 6.75;
    h.perigee_height_at_epoch = 621.0;
    h.apogee_height_at_epoch = 623.0;
    h.mean_motion = 0.0010781;
    h.rate_of_change_of_arg_of_perigee = 1.1e-6;
    h.rate_of_change_of_ra_of_ascending_node = -9.9e-7;
    h.gha_at_epoch = 1.75;
    h.gha_at_ephem_start_rad = 1.75;
    h.gha_at_ephemeris_end_rad = 2.05;
    h.date_of_initiation_of_ephem_comp_yyymmdd = 1070112.0;
    h.time_of_initiation_of_ephem_comp_hhmmss = 200000.0;
    h.year_of_epoch_yyy = 107.0;
    h.month_of_epoch_mm = 1.0;
    h.day_of_epoch_dd = 12.0;
    h.hour_of_epoch_hh = 0.0;
    h.minute_of_epoch_mm = 0.0;
    h.seconds_of_epoch_milsec = 0.0;
    /* Spares carry producer annotations in real files. Filling them here is
     * what makes "byte-exact rewrite" a claim about the whole record rather
     * than about the fields we happened to model. */
    h.spares_1 = "SP1-ANNOTATION  ";
    h.spares_2 = "SP2-ANNO";
    h.spares_3 = std::string(48, '3');
    h.spares_4 = std::string(40, '4');
    h.spares_5 = std::string(480, '5');
    h.spares_6 = std::string(660, '6');
    h.harmonics_with_titles_1 = std::string(456, 'H');
    h.harmonics_with_titles_2 = std::string(code500::kRecordSize, 'K');
    return h;
}

/* ---------------------------------------------------------------------- */
/* Header comparison                                                      */
/* ---------------------------------------------------------------------- */

struct HeaderDiff {
    long compared = 0;
    long mismatched = 0;
    std::string first_mismatch;
};

void cmp_d(HeaderDiff* r, const char* name, double a, double b) {
    ++r->compared;
    if (!(a == b)) {
        ++r->mismatched;
        if (r->first_mismatch.empty()) r->first_mismatch = name;
    }
}
void cmp_i(HeaderDiff* r, const char* name, int32_t a, int32_t b) {
    ++r->compared;
    if (a != b) {
        ++r->mismatched;
        if (r->first_mismatch.empty()) r->first_mismatch = name;
    }
}
void cmp_s(HeaderDiff* r, const char* name, const std::string& a, const std::string& b) {
    ++r->compared;
    if (a != b) {
        ++r->mismatched;
        if (r->first_mismatch.empty()) r->first_mismatch = name;
    }
}
void cmp_da(HeaderDiff* r, const char* name, const double* a, const double* b, size_t n) {
    ++r->compared;
    for (size_t i = 0; i < n; ++i) {
        if (!(a[i] == b[i])) {
            ++r->mismatched;
            if (r->first_mismatch.empty()) r->first_mismatch = name;
            return;
        }
    }
}

/// Every field of the header, one comparison each. Character fields are
/// compared as the writer stores them: blank-padded to the field width, so a
/// caller's un-padded string is normalised before the diff and the count
/// measures FORMAT fidelity, not std::string equality.
HeaderDiff diff_headers(const code500::Header& a, const code500::Header& b) {
    HeaderDiff r;
    auto pad = [](const std::string& s, size_t n) {
        std::string t = s.substr(0, s.size() < n ? s.size() : n);
        t.append(n - t.size(), ' ');
        return t;
    };
    cmp_i(&r, "big_endian", a.big_endian ? 1 : 0, b.big_endian ? 1 : 0);
    cmp_i(&r, "year_format", a.year_format, b.year_format);
    cmp_s(&r, "product_id", pad(a.product_id, 8), pad(b.product_id, 8));
    cmp_d(&r, "sat_id", a.sat_id, b.sat_id);
    cmp_d(&r, "time_system_indicator", a.time_system_indicator, b.time_system_indicator);
    cmp_d(&r, "start_date_of_ephem_yyymmdd", a.start_date_of_ephem_yyymmdd,
          b.start_date_of_ephem_yyymmdd);
    cmp_d(&r, "start_day_count_of_year", a.start_day_count_of_year, b.start_day_count_of_year);
    cmp_d(&r, "start_seconds_of_day", a.start_seconds_of_day, b.start_seconds_of_day);
    cmp_d(&r, "end_date_of_ephem_yyymmdd", a.end_date_of_ephem_yyymmdd,
          b.end_date_of_ephem_yyymmdd);
    cmp_d(&r, "end_day_count_of_year", a.end_day_count_of_year, b.end_day_count_of_year);
    cmp_d(&r, "end_seconds_of_day", a.end_seconds_of_day, b.end_seconds_of_day);
    cmp_d(&r, "step_size_sec", a.step_size_sec, b.step_size_sec);
    cmp_s(&r, "tape_id", pad(a.tape_id, 8), pad(b.tape_id, 8));
    cmp_s(&r, "source_id", pad(a.source_id, 8), pad(b.source_id, 8));
    cmp_s(&r, "header_title", pad(a.header_title, 56), pad(b.header_title, 56));
    cmp_d(&r, "central_body_indicator", a.central_body_indicator, b.central_body_indicator);
    cmp_da(&r, "brouwer_lyddane", a.brouwer_lyddane, b.brouwer_lyddane, 6);
    cmp_d(&r, "ref_time_for_dut_yymmdd", a.ref_time_for_dut_yymmdd, b.ref_time_for_dut_yymmdd);
    cmp_s(&r, "coord_system_indicator_1", pad(a.coord_system_indicator_1, 4),
          pad(b.coord_system_indicator_1, 4));
    cmp_i(&r, "coord_system_indicator_2", a.coord_system_indicator_2, b.coord_system_indicator_2);
    cmp_s(&r, "orbit_theory", pad(a.orbit_theory, 8), pad(b.orbit_theory, 8));
    cmp_s(&r, "spares_1", pad(a.spares_1, 16), pad(b.spares_1, 16));
    cmp_d(&r, "drag_coefficient", a.drag_coefficient, b.drag_coefficient);
    cmp_d(&r, "sc_reflectivity_constant", a.sc_reflectivity_constant, b.sc_reflectivity_constant);
    cmp_s(&r, "atmospheric_density_model", pad(a.atmospheric_density_model, 8),
          pad(b.atmospheric_density_model, 8));
    cmp_d(&r, "area_of_spacecraft", a.area_of_spacecraft, b.area_of_spacecraft);
    cmp_d(&r, "mass_of_spacecraft", a.mass_of_spacecraft, b.mass_of_spacecraft);
    cmp_d(&r, "zonal_tesseral_harmonics_indicator", a.zonal_tesseral_harmonics_indicator,
          b.zonal_tesseral_harmonics_indicator);
    cmp_s(&r, "spares_2", pad(a.spares_2, 8), pad(b.spares_2, 8));
    cmp_d(&r, "lunar_grav_perturb_indicator", a.lunar_grav_perturb_indicator,
          b.lunar_grav_perturb_indicator);
    cmp_d(&r, "solar_radiation_perturb_indicator", a.solar_radiation_perturb_indicator,
          b.solar_radiation_perturb_indicator);
    cmp_d(&r, "solar_grav_perturb_indicator", a.solar_grav_perturb_indicator,
          b.solar_grav_perturb_indicator);
    cmp_d(&r, "atmospheric_drag_perturb_indicator", a.atmospheric_drag_perturb_indicator,
          b.atmospheric_drag_perturb_indicator);
    cmp_d(&r, "epoch_time_of_elements_dut", a.epoch_time_of_elements_dut,
          b.epoch_time_of_elements_dut);
    cmp_d(&r, "year_of_epoch_yyy", a.year_of_epoch_yyy, b.year_of_epoch_yyy);
    cmp_d(&r, "month_of_epoch_mm", a.month_of_epoch_mm, b.month_of_epoch_mm);
    cmp_d(&r, "day_of_epoch_dd", a.day_of_epoch_dd, b.day_of_epoch_dd);
    cmp_d(&r, "hour_of_epoch_hh", a.hour_of_epoch_hh, b.hour_of_epoch_hh);
    cmp_d(&r, "minute_of_epoch_mm", a.minute_of_epoch_mm, b.minute_of_epoch_mm);
    cmp_d(&r, "seconds_of_epoch_milsec", a.seconds_of_epoch_milsec, b.seconds_of_epoch_milsec);
    cmp_da(&r, "keplerian_elements_at_epoch_rad", a.keplerian_elements_at_epoch_rad,
           b.keplerian_elements_at_epoch_rad, 6);
    cmp_d(&r, "true_anomaly_at_epoch", a.true_anomaly_at_epoch, b.true_anomaly_at_epoch);
    cmp_d(&r, "arg_of_latitude_at_epoch", a.arg_of_latitude_at_epoch, b.arg_of_latitude_at_epoch);
    cmp_d(&r, "flight_path_angle_at_epoch", a.flight_path_angle_at_epoch,
          b.flight_path_angle_at_epoch);
    cmp_d(&r, "ecc_anomaly_at_epoch", a.ecc_anomaly_at_epoch, b.ecc_anomaly_at_epoch);
    cmp_d(&r, "anomalistic_period_dut", a.anomalistic_period_dut, b.anomalistic_period_dut);
    cmp_d(&r, "perigee_height_at_epoch", a.perigee_height_at_epoch, b.perigee_height_at_epoch);
    cmp_d(&r, "apogee_height_at_epoch", a.apogee_height_at_epoch, b.apogee_height_at_epoch);
    cmp_d(&r, "mean_motion", a.mean_motion, b.mean_motion);
    cmp_d(&r, "rate_of_change_of_arg_of_perigee", a.rate_of_change_of_arg_of_perigee,
          b.rate_of_change_of_arg_of_perigee);
    cmp_d(&r, "rate_of_change_of_ra_of_ascending_node", a.rate_of_change_of_ra_of_ascending_node,
          b.rate_of_change_of_ra_of_ascending_node);
    cmp_da(&r, "cartesian_elements_at_epoch_dult", a.cartesian_elements_at_epoch_dult,
           b.cartesian_elements_at_epoch_dult, 6);
    cmp_da(&r, "t_sub_q", a.t_sub_q, b.t_sub_q, 14);
    cmp_s(&r, "spares_3", pad(a.spares_3, 48), pad(b.spares_3, 48));
    cmp_d(&r, "rho_sub_1", a.rho_sub_1, b.rho_sub_1);
    cmp_d(&r, "rho_sub_2", a.rho_sub_2, b.rho_sub_2);
    cmp_d(&r, "rho_sub_3", a.rho_sub_3, b.rho_sub_3);
    cmp_d(&r, "rho_sub_4", a.rho_sub_4, b.rho_sub_4);
    cmp_da(&r, "brouwer_1st_order_drag_terms", a.brouwer_1st_order_drag_terms,
           b.brouwer_1st_order_drag_terms, 14);
    cmp_da(&r, "brouwer_2nd_order_drag_terms", a.brouwer_2nd_order_drag_terms,
           b.brouwer_2nd_order_drag_terms, 14);
    cmp_s(&r, "spares_4", pad(a.spares_4, 40), pad(b.spares_4, 40));
    cmp_da(&r, "geocentric_coord_of_sun_at_epoch", a.geocentric_coord_of_sun_at_epoch,
           b.geocentric_coord_of_sun_at_epoch, 3);
    cmp_d(&r, "total_number_of_brouwer_drag_terms", a.total_number_of_brouwer_drag_terms,
          b.total_number_of_brouwer_drag_terms);
    cmp_s(&r, "spares_5", pad(a.spares_5, 480), pad(b.spares_5, 480));
    cmp_d(&r, "start_time_of_ephemeris_dut", a.start_time_of_ephemeris_dut,
          b.start_time_of_ephemeris_dut);
    cmp_d(&r, "end_time_of_ephemeris_dut", a.end_time_of_ephemeris_dut,
          b.end_time_of_ephemeris_dut);
    cmp_d(&r, "time_interval_between_points_dut", a.time_interval_between_points_dut,
          b.time_interval_between_points_dut);
    cmp_d(&r, "precession_nutation_indicator", a.precession_nutation_indicator,
          b.precession_nutation_indicator);
    cmp_d(&r, "gha_at_epoch", a.gha_at_epoch, b.gha_at_epoch);
    cmp_d(&r, "coordinate_center_indicator", a.coordinate_center_indicator,
          b.coordinate_center_indicator);
    cmp_d(&r, "date_of_initiation_of_ephem_comp_yyymmdd",
          a.date_of_initiation_of_ephem_comp_yyymmdd, b.date_of_initiation_of_ephem_comp_yyymmdd);
    cmp_d(&r, "time_of_initiation_of_ephem_comp_hhmmss",
          a.time_of_initiation_of_ephem_comp_hhmmss, b.time_of_initiation_of_ephem_comp_hhmmss);
    cmp_d(&r, "gha_at_ephem_start_rad", a.gha_at_ephem_start_rad, b.gha_at_ephem_start_rad);
    cmp_d(&r, "gha_at_ephemeris_end_rad", a.gha_at_ephemeris_end_rad, b.gha_at_ephemeris_end_rad);
    cmp_i(&r, "output_interval_indicator", a.output_interval_indicator,
          b.output_interval_indicator);
    cmp_i(&r, "leap_second_indicator", a.leap_second_indicator, b.leap_second_indicator);
    cmp_d(&r, "date_of_leap_seconds_yyymmdd", a.date_of_leap_seconds_yyymmdd,
          b.date_of_leap_seconds_yyymmdd);
    cmp_d(&r, "time_of_leap_seconds_hhmmss", a.time_of_leap_seconds_hhmmss,
          b.time_of_leap_seconds_hhmmss);
    cmp_d(&r, "utc_time_adjustment_sec", a.utc_time_adjustment_sec, b.utc_time_adjustment_sec);
    cmp_da(&r, "dc_observation_time_span", a.dc_observation_time_span,
           b.dc_observation_time_span, 4);
    cmp_i(&r, "tracking_validation_indicator", a.tracking_validation_indicator,
          b.tracking_validation_indicator);
    cmp_s(&r, "spares_6", pad(a.spares_6, 660), pad(b.spares_6, 660));
    cmp_s(&r, "harmonics_with_titles_1", pad(a.harmonics_with_titles_1, 456),
          pad(b.harmonics_with_titles_1, 456));
    cmp_s(&r, "harmonics_with_titles_2", pad(a.harmonics_with_titles_2, code500::kRecordSize),
          pad(b.harmonics_with_titles_2, code500::kRecordSize));
    return r;
}

/* ---------------------------------------------------------------------- */
/* Section 1 — Code-500                                                    */
/* ---------------------------------------------------------------------- */

/// Writes, reads back, and returns the worst relative error over every
/// position and velocity component. `label` names the case in the output.
double code500_round_trip(size_t n, bool big_endian, const char* label,
                          long* header_mismatches, long* header_fields,
                          long* byte_mismatches, double* state_maxrel = nullptr,
                          double* epoch_maxabs = nullptr) {
    /* 12 Jan 2007, the same date the published STK fixture uses, so the two
     * halves of this harness sit at one epoch. */
    const ephem::Series s = make_series(n, 60.0, dut_epoch_seconds(2007, 1, 12));
    code500::Header h = make_header(big_endian);
    if (code500::derive_header(s, &h) != ephem::Status::Ok) {
        std::printf("RESULT %-46s %14s %10s FAIL\n", label, "derive", "-");
        ++failures;
        ++checks;
        return 1.0;
    }

    std::vector<uint8_t> bytes;
    if (code500::write(s, h, &bytes) != ephem::Status::Ok) {
        std::printf("RESULT %-46s %14s %10s FAIL\n", label, "write", "-");
        ++failures;
        ++checks;
        return 1.0;
    }

    ephem::Series back;
    code500::Header h2;
    const ephem::Status st = code500::read(bytes.data(), bytes.size(), &back, &h2);
    if (st != ephem::Status::Ok || back.rows.size() != s.rows.size()) {
        std::printf("RESULT %-46s %14s %10s FAIL (%s, %zu rows)\n", label, "read", "-",
                    ephem::status_name(st), back.rows.size());
        ++failures;
        ++checks;
        return 1.0;
    }

    double worst = 0.0;
    for (size_t i = 0; i < s.rows.size(); ++i) {
        for (int c = 0; c < 3; ++c) {
            const double p = rel(back.rows[i].pos[c], s.rows[i].pos[c]);
            const double v = rel(back.rows[i].vel[c], s.rows[i].vel[c]);
            if (p > worst) worst = p;
            if (v > worst) worst = v;
        }
    }

    if (header_mismatches) {
        const HeaderDiff d = diff_headers(h, h2);
        *header_mismatches = d.mismatched;
        if (header_fields) *header_fields = d.compared;
        if (d.mismatched && !d.first_mismatch.empty()) {
            std::printf("  first header mismatch: %s\n", d.first_mismatch.c_str());
        }
    }

    if (byte_mismatches) {
        /* Rewriting from what was READ must reproduce the two HEADER RECORDS
         * exactly. That is the part of the file where byte identity is both
         * achievable and worth proving: it covers the spares and the
         * harmonic-title blocks, the fields nothing models and every naive
         * writer silently blanks.
         *
         * The DATA records cannot be byte-identical, and nothing is wrong when
         * they are not. A state leaves the file in DUL, is multiplied by 10000
         * into the spine's kilometres and divided back on the way out; 10000 is
         * not a power of two, so that pair is a rounding rather than an
         * identity. What IS asserted is that the rounding is at the ULP, which
         * the two measurements below state in the units they belong in —
         * relative for the states, absolute seconds for the epochs, because an
         * epoch 1.5e9 seconds from its origin has a 2.4e-7 s ULP and expressing
         * that as a relative error against a 3000-second time of day would
         * report a fictitious 1e-10. */
        std::vector<uint8_t> again;
        *byte_mismatches = 1;
        if (code500::write(back, h2, &again) == ephem::Status::Ok &&
            again.size() == bytes.size()) {
            long diff = 0;
            for (size_t i = 0; i < 2 * code500::kRecordSize; ++i) {
                if (bytes[i] != again[i]) ++diff;
            }
            *byte_mismatches = diff;

            ephem::Series twice;
            if (code500::read(again.data(), again.size(), &twice) == ephem::Status::Ok &&
                twice.rows.size() == back.rows.size()) {
                double worst_state = 0.0, worst_epoch = 0.0;
                for (size_t i = 0; i < back.rows.size(); ++i) {
                    worst_epoch = std::fmax(worst_epoch,
                                            std::fabs(twice.rows[i].epoch - back.rows[i].epoch));
                    for (int c = 0; c < 3; ++c) {
                        worst_state =
                            std::fmax(worst_state, rel(twice.rows[i].pos[c], back.rows[i].pos[c]));
                        worst_state =
                            std::fmax(worst_state, rel(twice.rows[i].vel[c], back.rows[i].vel[c]));
                    }
                }
                if (state_maxrel) *state_maxrel = worst_state;
                if (epoch_maxabs) *epoch_maxabs = worst_epoch;
            }
        }
    }
    return worst;
}

void section_code500() {
    std::printf("\n# Code-500 (GMAT R2026a Code500EphemerisFile layout)\n");

    long header_mismatch = -1, header_fields = 0, byte_mismatch = -1;
    double state_maxrel = 1.0, epoch_maxabs = 1.0;
    /* 137 states: three data records with a short last one, which is the path
     * that terminates on sentinel fill rather than on a sentinel record. */
    const double le = code500_round_trip(137, false, "code500.roundtrip.le.137", &header_mismatch,
                                         &header_fields, &byte_mismatch, &state_maxrel,
                                         &epoch_maxabs);
    report("code500.roundtrip.rel.littleendian", le, 1e-9);
    report_count("code500.header.fields.compared", header_fields, header_fields);
    report_count("code500.header.mismatches", header_mismatch, 0);
    report_count("code500.rewrite.headerbytes.mismatches", byte_mismatch, 0);
    report("code500.rewrite.state.maxrel", state_maxrel, 1e-15);
    report("code500.rewrite.epoch.maxabs.sec", epoch_maxabs, 1e-6);

    long be_header = -1, be_bytes = -1;
    const double be = code500_round_trip(137, true, "code500.roundtrip.be.137", &be_header,
                                         nullptr, &be_bytes);
    report("code500.roundtrip.rel.bigendian", be, 1e-9);
    report_count("code500.header.mismatches.bigendian", be_header, 0);
    report_count("code500.rewrite.headerbytes.mismatches.bigendian", be_bytes, 0);

    /* Exactly 100 states fills two records, which is the case that needs a
     * trailing all-sentinel record because no slot is left to mark the end. */
    const double full = code500_round_trip(100, false, "code500.roundtrip.le.100", nullptr,
                                           nullptr, nullptr, nullptr, nullptr);
    report("code500.roundtrip.rel.fullrecords", full, 1e-9);

    /* A single state, the degenerate record. */
    const double one = code500_round_trip(1, false, "code500.roundtrip.le.1", nullptr, nullptr,
                                          nullptr, nullptr, nullptr);
    report("code500.roundtrip.rel.singlestate", one, 1e-9);

    /* The unit constants, against the format's own definition: one DUL is
     * 10000 km and one DUT is 864 s, so a DUL/DUT is 10000/864 km/s and a DUT
     * is exactly one hundredth of a day. Getting either wrong is the bug that
     * produces a beautifully-shaped wrong orbit. */
    report("code500.units.dul_km", std::fabs(code500::kDulToKm - 10000.0), 0.0);
    report("code500.units.dut_sec", std::fabs(code500::kDutToSec - 864.0), 0.0);
    report("code500.units.dut_per_day", std::fabs(86400.0 / code500::kDutToSec - 100.0), 0.0);
    report("code500.units.dul_dut_kms",
           rel(code500::kDulDutToKmSec, 10000.0 / 864.0), 0.0);

    /* Refusals, which are as much a part of the contract as the values. */
    ephem::Series junk;
    std::vector<uint8_t> tiny(code500::kRecordSize * 2, 0);
    report_count("code500.refuses.truncated",
                 code500::read(tiny.data(), tiny.size(), &junk) == ephem::Status::Truncated ? 0 : 1,
                 0);
    std::vector<uint8_t> nonsense(code500::kRecordSize * 3, 0x5A);
    report_count("code500.refuses.badmagic",
                 code500::read(nonsense.data(), nonsense.size(), &junk) == ephem::Status::BadMagic
                     ? 0
                     : 1,
                 0);
    ephem::Series novel = make_series(4, 60.0, 0.0);
    for (size_t i = 0; i < novel.rows.size(); ++i) novel.rows[i].has_vel = false;
    std::vector<uint8_t> out;
    report_count("code500.refuses.velocityless",
                 code500::write(novel, make_header(false), &out) == ephem::Status::Unsupported ? 0
                                                                                               : 1,
                 0);
}

/* ---------------------------------------------------------------------- */
/* Section 2 — STK .e                                                      */
/* ---------------------------------------------------------------------- */

/// Every whitespace-separated numeric token of every data line in an .e file,
/// parsed by strtod. This is the file's PRINTED value: the exact double its
/// digits denote, with no reader of ours between the digits and the number.
std::vector<double> tabulated_values(const std::string& text, size_t per_row) {
    std::vector<double> out;
    std::istringstream in(text);
    std::string line;
    bool in_block = false;
    while (std::getline(in, line)) {
        if (line.find("Ephemeris", 0) != std::string::npos && line.find("BEGIN") == std::string::npos &&
            line.find("END") == std::string::npos && line.find('#') == std::string::npos &&
            line.find("NumberOf") == std::string::npos) {
            in_block = true;
            continue;
        }
        if (!in_block) continue;
        if (line.find("END Ephemeris") != std::string::npos) break;
        std::istringstream ls(line);
        std::vector<double> row;
        double v;
        while (ls >> v) row.push_back(v);
        if (row.size() == per_row) {
            for (size_t i = 0; i < row.size(); ++i) out.push_back(row[i]);
        }
    }
    return out;
}

/// The flat Orekit dump: t, p(3), v(3), a(3) per row, in metres.
std::vector<double> orekit_reference(const std::string& text) {
    std::vector<double> out;
    std::istringstream in(text);
    std::string line;
    while (std::getline(in, line)) {
        if (line.empty() || line[0] == '#') continue;
        std::istringstream ls(line);
        double v;
        while (ls >> v) out.push_back(v);
    }
    return out;
}

void section_stk_ephemeris(const std::string& fixtures) {
    std::printf("\n# STK ephemeris (.e)\n");

    std::string pv, pva, orekit_pv, orekit_pva;
    if (!read_file(fixtures + "/stk_02674_pv.e", &pv) ||
        !read_file(fixtures + "/stk_02674_pva.e", &pva) ||
        !read_file(fixtures + "/stk_02674_pv.orekit-13.1.txt", &orekit_pv) ||
        !read_file(fixtures + "/stk_02674_pva.orekit-13.1.txt", &orekit_pva)) {
        std::printf("RESULT %-46s %14s %10s FAIL (fixtures missing under %s)\n",
                    "stk.fixtures.present", "-", "-", fixtures.c_str());
        ++failures;
        ++checks;
        return;
    }

    ephem::Series s;
    const ephem::Status st = stk_ephem::read(pv.data(), pv.size(), &s);
    report_count("stk.read.status", st == ephem::Status::Ok ? 0 : 1, 0);
    if (st != ephem::Status::Ok) return;

    report_count("stk.read.rowcount", static_cast<long>(s.rows.size()) - 11, 0);
    report_count("stk.read.scenarioepoch",
                 s.epoch_zero_iso == "2007-01-12T00:00:00.000883" ? 0 : 1, 0);
    report_count("stk.read.frame", s.frame_name == "J2000" ? 0 : 1, 0);
    report_count("stk.read.centralbody", s.center_name == "Earth" ? 0 : 1, 0);
    report_count("stk.read.interp", s.interp == ephem::Interp::Lagrange ? 0 : 1, 0);
    report_count("stk.read.interpdegree", s.interp_degree - 5, 0);

    /* The published file has no DistanceUnit line, so it is in METRES. A reader
     * that assumed kilometres would put this orbit at 4.2e9 km. */
    const double radius = std::sqrt(s.rows[0].pos[0] * s.rows[0].pos[0] +
                                    s.rows[0].pos[1] * s.rows[0].pos[1] +
                                    s.rows[0].pos[2] * s.rows[0].pos[2]);
    report_count("stk.read.metres_default_applied", (radius > 6000.0 && radius < 8000.0) ? 0 : 1, 0);

    /* Against the digits printed in the file. */
    const std::vector<double> printed = tabulated_values(pv, 7);
    report_count("stk.published.tokens", static_cast<long>(printed.size()) - 77, 0);
    double worst_printed = 0.0;
    for (size_t i = 0; i < s.rows.size(); ++i) {
        const double* row = &printed[i * 7];
        worst_printed = std::fmax(worst_printed, rel(s.rows[i].epoch, row[0]));
        for (int c = 0; c < 3; ++c) {
            worst_printed = std::fmax(worst_printed, rel(s.rows[i].pos[c] * 1000.0, row[1 + c]));
            worst_printed = std::fmax(worst_printed, rel(s.rows[i].vel[c] * 1000.0, row[4 + c]));
        }
    }
    /* The bound is a few ULP, not zero: the spine is kilometres, so a metre
     * value makes one round trip through a division and a multiplication by
     * 1000, neither of which is exact in binary. */
    report("stk.published.printed.maxrel", worst_printed, 1e-15);

    /* Against Orekit's parse of the same bytes. */
    const std::vector<double> ref = orekit_reference(orekit_pv);
    report_count("stk.orekit.rows", static_cast<long>(ref.size()) - 110, 0);
    double worst_orekit = 0.0;
    for (size_t i = 0; i < s.rows.size(); ++i) {
        const double* row = &ref[i * 10];
        worst_orekit = std::fmax(worst_orekit, rel(s.rows[i].epoch, row[0]));
        for (int c = 0; c < 3; ++c) {
            worst_orekit = std::fmax(worst_orekit, rel(s.rows[i].pos[c] * 1000.0, row[1 + c]));
            worst_orekit = std::fmax(worst_orekit, rel(s.rows[i].vel[c] * 1000.0, row[4 + c]));
        }
    }
    report("stk.orekit.maxrel", worst_orekit, 1e-15);

    /* The acceleration variant, likewise. */
    ephem::Series sa;
    report_count("stk.read.pva.status",
                 stk_ephem::read(pva.data(), pva.size(), &sa) == ephem::Status::Ok ? 0 : 1, 0);
    const std::vector<double> ref_a = orekit_reference(orekit_pva);
    double worst_acc = 0.0;
    if (sa.rows.size() * 10 == ref_a.size()) {
        for (size_t i = 0; i < sa.rows.size(); ++i) {
            const double* row = &ref_a[i * 10];
            for (int c = 0; c < 3; ++c) {
                worst_acc = std::fmax(worst_acc, rel(sa.rows[i].acc[c] * 1000.0, row[7 + c]));
            }
        }
    } else {
        worst_acc = 1.0;
    }
    report("stk.orekit.acceleration.maxrel", worst_acc, 1e-15);

    /* Round trips, in both distance units the format offers. */
    for (int pass = 0; pass < 2; ++pass) {
        stk_ephem::WriteOptions opt;
        opt.meters = pass == 1;
        opt.precision = 17;
        opt.version = "stk.v.12.0";
        std::string text;
        const ephem::Status ws = stk_ephem::write(s, opt, &text);
        ephem::Series back;
        const ephem::Status rs = ws == ephem::Status::Ok
                                     ? stk_ephem::read(text.data(), text.size(), &back)
                                     : ws;
        const char* unit = opt.meters ? "meters" : "kilometers";
        char name[96];
        if (rs != ephem::Status::Ok || back.rows.size() != s.rows.size()) {
            std::snprintf(name, sizeof(name), "stk.roundtrip.%s.status", unit);
            report_count(name, 1, 0);
            continue;
        }
        double worst = 0.0;
        for (size_t i = 0; i < s.rows.size(); ++i) {
            worst = std::fmax(worst, rel(back.rows[i].epoch, s.rows[i].epoch));
            for (int c = 0; c < 3; ++c) {
                worst = std::fmax(worst, rel(back.rows[i].pos[c], s.rows[i].pos[c]));
                worst = std::fmax(worst, rel(back.rows[i].vel[c], s.rows[i].vel[c]));
            }
        }
        std::snprintf(name, sizeof(name), "stk.roundtrip.%s.maxrel", unit);
        report(name, worst, 1e-9);

        long keyword_mismatch = 0;
        keyword_mismatch += back.epoch_zero_iso == s.epoch_zero_iso ? 0 : 1;
        keyword_mismatch += back.frame_name == s.frame_name ? 0 : 1;
        keyword_mismatch += back.center_name == s.center_name ? 0 : 1;
        keyword_mismatch += back.time_system == s.time_system ? 0 : 1;
        keyword_mismatch += back.interp == s.interp ? 0 : 1;
        keyword_mismatch += back.interp_degree == s.interp_degree ? 0 : 1;
        keyword_mismatch += back.epoch_zero_offset_sec == s.epoch_zero_offset_sec ? 0 : 1;
        std::snprintf(name, sizeof(name), "stk.roundtrip.%s.keywords", unit);
        report_count(name, keyword_mismatch, 0);
    }

    /* Refusals. */
    ephem::Series junk;
    const std::string not_stk = "BEGIN Ephemeris\nEND Ephemeris\n";
    report_count("stk.refuses.nobanner",
                 stk_ephem::read(not_stk.data(), not_stk.size(), &junk) == ephem::Status::BadMagic
                     ? 0
                     : 1,
                 0);
    const std::string lla =
        "stk.v.11.0\nBEGIN Ephemeris\nNumberOfEphemerisPoints 1\nEphemerisLLATimePos\n"
        "0.0 1.0 2.0 3.0\nEND Ephemeris\n";
    report_count("stk.refuses.lla",
                 stk_ephem::read(lla.data(), lla.size(), &junk) ==
                         ephem::Status::UnsupportedVariant
                     ? 0
                     : 1,
                 0);
    const std::string feet =
        "stk.v.11.0\nBEGIN Ephemeris\nDistanceUnit Feet\nEphemerisTimePos\n0.0 1.0 2.0 3.0\n"
        "END Ephemeris\n";
    report_count("stk.refuses.unknownunit",
                 stk_ephem::read(feet.data(), feet.size(), &junk) ==
                         ephem::Status::UnsupportedVariant
                     ? 0
                     : 1,
                 0);
    std::string short_count = pv;
    {
        /* Drop one data line: the declared NumberOfEphemerisPoints no longer
         * matches, which is exactly the truncation a reader must not absorb. */
        const size_t last = short_count.rfind("\n 6.0000000000000000e+02");
        if (last != std::string::npos) {
            const size_t end = short_count.find('\n', last + 1);
            short_count.erase(last, end - last);
        }
        report_count("stk.refuses.pointcount_mismatch",
                     stk_ephem::read(short_count.data(), short_count.size(), &junk) ==
                             ephem::Status::Truncated
                         ? 0
                         : 1,
                     0);
    }
}

/* ---------------------------------------------------------------------- */
/* Section 3 — STK .a                                                      */
/* ---------------------------------------------------------------------- */

void section_stk_attitude(const std::string& fixtures) {
    std::printf("\n# STK attitude (.a)\n");

    std::string text;
    if (!read_file(fixtures + "/stk_attitude_quaternions.a", &text)) {
        std::printf("RESULT %-46s %14s %10s FAIL\n", "stka.fixture.present", "-", "-");
        ++failures;
        ++checks;
        return;
    }

    stk_ephem::Attitude a;
    const ephem::Status st = stk_ephem::read_attitude(text.data(), text.size(), &a);
    report_count("stka.read.status", st == ephem::Status::Ok ? 0 : 1, 0);
    if (st != ephem::Status::Ok) return;

    report_count("stka.read.rowcount", static_cast<long>(a.rows.size()) - 5, 0);
    report_count("stka.read.type", a.type == "AttitudeTimeQuaternions" ? 0 : 1, 0);
    report_count("stka.read.components", a.rows[0].n - 4, 0);

    /* Every quaternion in the fixture is a unit quaternion; a reader that
     * mis-columns the components would break that identity while every value
     * still looked like a plausible number. */
    double worst_norm = 0.0;
    for (size_t i = 0; i < a.rows.size(); ++i) {
        double n = 0.0;
        for (int k = 0; k < 4; ++k) n += a.rows[i].c[k] * a.rows[i].c[k];
        worst_norm = std::fmax(worst_norm, std::fabs(std::sqrt(n) - 1.0));
    }
    report("stka.read.quaternion.unitnorm", worst_norm, 1e-15);

    std::string written;
    const ephem::Status ws = stk_ephem::write_attitude(a, &written);
    report_count("stka.write.status", ws == ephem::Status::Ok ? 0 : 1, 0);
    stk_ephem::Attitude b;
    const ephem::Status rs = stk_ephem::read_attitude(written.data(), written.size(), &b);
    report_count("stka.reread.status", rs == ephem::Status::Ok ? 0 : 1, 0);
    if (rs != ephem::Status::Ok) return;

    long keyword_mismatch = 0;
    keyword_mismatch += b.version == a.version ? 0 : 1;
    keyword_mismatch += b.epoch_zero_iso == a.epoch_zero_iso ? 0 : 1;
    keyword_mismatch += b.coordinate_axes == a.coordinate_axes ? 0 : 1;
    keyword_mismatch += b.type == a.type ? 0 : 1;
    keyword_mismatch += b.sequence == a.sequence ? 0 : 1;
    keyword_mismatch += b.central_body == a.central_body ? 0 : 1;
    keyword_mismatch += b.interpolation_method == a.interpolation_method ? 0 : 1;
    keyword_mismatch += b.interpolation_order == a.interpolation_order ? 0 : 1;
    keyword_mismatch += b.blocking_factor == a.blocking_factor ? 0 : 1;
    keyword_mismatch += b.rows.size() == a.rows.size() ? 0 : 1;
    report_count("stka.roundtrip.keywords", keyword_mismatch, 0);

    double worst = 0.0;
    if (b.rows.size() == a.rows.size()) {
        for (size_t i = 0; i < a.rows.size(); ++i) {
            worst = std::fmax(worst, std::fabs(b.rows[i].epoch - a.rows[i].epoch));
            for (int k = 0; k < a.rows[i].n; ++k) {
                worst = std::fmax(worst, std::fabs(b.rows[i].c[k] - a.rows[i].c[k]));
            }
        }
    } else {
        worst = 1.0;
    }
    report("stka.roundtrip.components.maxabs", worst, 1e-12);

    /* The direction-cosine blocks carry nine and twelve components, which do
     * not fit an eight-component row. They are refused by name rather than
     * silently truncated into a matrix that is no longer a rotation. */
    const std::string dcm =
        "stk.v.11.0\nBEGIN Attitude\nAttitudeTimeDCM\n"
        "0.0 1 0 0 0 1 0 0 0 1\nEND Attitude\n";
    stk_ephem::Attitude junk;
    report_count("stka.refuses.dcm",
                 stk_ephem::read_attitude(dcm.data(), dcm.size(), &junk) ==
                         ephem::Status::UnsupportedVariant
                     ? 0
                     : 1,
                 0);
}

}  // namespace

int main(int argc, char** argv) {
    const std::string fixtures = argc > 1 ? argv[1] : "fixtures";
    std::printf("# code500_stk_native — fixtures: %s\n", fixtures.c_str());

    section_code500();
    section_stk_ephemeris(fixtures);
    section_stk_attitude(fixtures);

    std::printf("\n%d checks, %d failures\n", checks, failures);
    std::printf("%s\n", failures == 0 ? "PASS" : "FAIL");
    return failures == 0 ? 0 : 1;
}
