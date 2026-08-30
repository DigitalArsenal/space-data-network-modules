/*
 * SP3-d acceptance: measures src/sp3.hpp against the IGS specification, against
 * an independent parser, and against published IGS products.
 *
 * Every check prints one line
 *
 *     RESULT <name> <value> <bound> PASS|FAIL
 *
 * and the process exits non-zero if any line says FAIL. Lines that say SKIP
 * are checks whose external authority is not installed on this box; they never
 * pass silently — the run prints what is missing and the caller decides.
 *
 * THE INDEPENDENT PARSER IS OREKIT 13.1, not a second implementation of ours.
 * "This file conforms to SP3-d" is not a claim a writer can settle by reading
 * it back with its own reader — the two would share every misreading. So the
 * writer's output is handed to org.orekit.files.sp3.SP3Parser (via
 * java-sp3/Sp3Dump, outside this repo) and the coordinates it recovers are
 * compared with the coordinates that went in. Set:
 *
 *     SP3_OREKIT_CP    classpath holding orekit + hipparchus jars and Sp3Dump
 *     SP3_OREKIT_DATA  an orekit-data checkout (UTC/GPS time scales)
 *     SP3_JAVA         java binary (default: "java")
 *     SP3_TMPDIR       scratch directory (default: "/tmp")
 *
 * HOW "RELATIVE" IS DEFINED HERE, because for a coordinate triple it is not
 * obvious and the obvious choice is wrong. SP3 stores six decimals in every
 * numeric column, an absolute resolution of 1 mm in position and 1e-4 mm/s in
 * velocity. A relative error taken PER COMPONENT is therefore unbounded: the z
 * of an inclined orbit passes through zero twice a revolution, and 0.5 mm out
 * of a component that is momentarily 40 km is 1e-8 no matter how good the
 * codec is. That number would be a statement about the format's resolution
 * wearing the costume of a defect. So position and velocity errors below are
 * normalised by the STATE MAGNITUDE (|r|, |v|), which is the quantity the
 * format's resolution is actually specified against, and the per-component
 * figure is reported separately on grid-aligned input where it is meaningful.
 *
 * The clock columns are pre-quantised onto the on-disk decimal grid for the
 * same reason and with no ambiguity: a clock bias is a scalar of ~60
 * microseconds stored to 1e-6, so a raw value could not survive the format at
 * 1e-9 and the round trip would measure SP3, not us. `roundtrip_*_on_grid`
 * closes the loop by showing the codec is exactly lossless whenever the input
 * is representable at all.
 */

#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "sp3.hpp"

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/* ------------------------------------------------------------------------ */
/* Reporting                                                                 */
/* ------------------------------------------------------------------------ */

static int g_failures = 0;
static int g_skips = 0;

static void result(const char* name, double value, double bound, bool pass) {
    std::printf("RESULT %s %.17g %.17g %s\n", name, value, bound, pass ? "PASS" : "FAIL");
    if (!pass) ++g_failures;
}

/* value must not exceed bound. A NaN never passes: it is the shape of a
 * measurement that did not happen. */
static void result_le(const char* name, double value, double bound) {
    result(name, value, bound, value == value && value <= bound);
}

static void result_eq(const char* name, double value, double bound) {
    result(name, value, bound, value == bound);
}

static void result_ge(const char* name, double value, double bound) {
    result(name, value, bound, value == value && value >= bound);
}

static void skip(const char* name, const char* why) {
    std::printf("RESULT %s nan nan SKIP\n", name);
    std::printf("NOTE %s: %s\n", name, why);
    ++g_skips;
}

static void note(const char* fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    std::printf("NOTE ");
    std::vprintf(fmt, ap);
    std::printf("\n");
    va_end(ap);
}

/* Relative difference with the larger magnitude as denominator. Two exact
 * zeros agree perfectly; one zero against a non-zero is a full-scale miss,
 * which is what it should look like. */
static double rel(double a, double b) {
    const double d = std::fabs(a - b);
    if (d == 0.0) return 0.0;
    const double m = std::fabs(a) > std::fabs(b) ? std::fabs(a) : std::fabs(b);
    return m > 0.0 ? d / m : d;
}

/* Error relative to a caller-chosen scale — the state magnitude for a
 * coordinate triple, rather than the component, for the reason in the file
 * header. */
static double rel_to(double a, double b, double scale) {
    const double d = std::fabs(a - b);
    if (d == 0.0) return 0.0;
    return scale > 0.0 ? d / scale : d;
}

static double norm3(const double* v) {
    return std::sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

static void keep_max(double* acc, double v) {
    if (!(v <= *acc)) *acc = v;
}

/* ------------------------------------------------------------------------ */
/* Files                                                                     */
/* ------------------------------------------------------------------------ */

static bool slurp(const std::string& path, std::string* out) {
    std::FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) return false;
    char buf[65536];
    size_t n;
    out->clear();
    while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) out->append(buf, n);
    std::fclose(f);
    return true;
}

static bool spit(const std::string& path, const std::string& data) {
    std::FILE* f = std::fopen(path.c_str(), "wb");
    if (!f) return false;
    const size_t n = std::fwrite(data.data(), 1, data.size(), f);
    std::fclose(f);
    return n == data.size();
}

static std::string g_tmpdir = "/tmp";
static std::string tmp(const char* name) { return g_tmpdir + "/" + name; }

/* ------------------------------------------------------------------------ */
/* Synthetic input                                                           */
/* ------------------------------------------------------------------------ */

/* Put a value on SP3's six-decimal on-disk grid by round-tripping it through
 * the same decimal form the writer will emit. Doing it with snprintf/strtod
 * rather than round(v*1e6)/1e6 matters: the latter can land one ulp away from
 * the double the reader will recover from that decimal. */
static double on_grid(double v) {
    char buf[64];
    std::snprintf(buf, sizeof buf, "%.6f", v);
    return std::strtod(buf, nullptr);
}

struct SatSpec {
    std::string id;
    double radius_km;
    double inclination_rad;
    double raan_rad;
    double phase_rad;
};

/* Ids from four constellations, so a reader that assumes GPS-only or that
 * mixes up the satellite order has somewhere to go wrong. 122 of them is past
 * SP3-c's 85-satellite ceiling on purpose: that is the c->d difference this
 * whole exercise is about, and it forces eight "+ " lines instead of five. */
static std::vector<SatSpec> make_constellation(size_t count) {
    static const char* kSystems[4] = {"G", "R", "E", "C"};
    static const size_t kPerSystem[4] = {32, 24, 36, 30};
    std::vector<SatSpec> out;
    for (size_t s = 0; s < 4 && out.size() < count; ++s) {
        for (size_t i = 1; i <= kPerSystem[s] && out.size() < count; ++i) {
            char id[8];
            std::snprintf(id, sizeof id, "%s%02u", kSystems[s], static_cast<unsigned>(i));
            SatSpec spec;
            spec.id = id;
            /* Distinct radii and planes so that swapping two satellites moves a
             * number instead of leaving the file looking identical. */
            spec.radius_km = 26559.8 + 3.5 * static_cast<double>(out.size());
            spec.inclination_rad = (55.0 + 0.31 * static_cast<double>(s)) * M_PI / 180.0;
            spec.raan_rad = static_cast<double>(out.size()) * 0.11;
            spec.phase_rad = static_cast<double>(out.size()) * 0.37;
            out.push_back(spec);
        }
    }
    return out;
}

/* A circular Keplerian arc. It is not a physics claim — it just produces
 * coordinates and velocities with realistic magnitudes and no symmetry that
 * could hide a transposed axis. */
static void kepler_state(const SatSpec& s, double t_sec, double* pos, double* vel) {
    const double mu = 398600.4418; /* km^3/s^2 */
    const double n = std::sqrt(mu / (s.radius_km * s.radius_km * s.radius_km));
    const double u = s.phase_rad + n * t_sec;
    const double cu = std::cos(u), su = std::sin(u);
    const double ci = std::cos(s.inclination_rad), si = std::sin(s.inclination_rad);
    const double co = std::cos(s.raan_rad), so = std::sin(s.raan_rad);
    const double px = cu * co - su * ci * so;
    const double py = cu * so + su * ci * co;
    const double pz = su * si;
    const double vx = -su * co - cu * ci * so;
    const double vy = -su * so + cu * ci * co;
    const double vz = cu * si;
    const double v = s.radius_km * n;
    pos[0] = s.radius_km * px;
    pos[1] = s.radius_km * py;
    pos[2] = s.radius_km * pz;
    vel[0] = v * vx;
    vel[1] = v * vy;
    vel[2] = v * vz;
}

struct BuildOptions {
    char version = 'd';
    char pos_vel_flag = 'V';
    size_t sats = 122;
    size_t epochs = 4;
    double interval = 900.0;
    bool with_flags = true;
    bool with_absent_clock = true;
    /* Snap coordinates and velocities onto SP3's six-decimal on-disk grid, so
     * that a round trip that loses anything at all shows up as a non-zero
     * per-component error instead of hiding under the format's resolution. */
    bool grid_align = false;
};

static sp3::File build_file(const BuildOptions& o) {
    sp3::File f;
    f.version = o.version;
    f.pos_vel_flag = o.pos_vel_flag;
    f.data_used = "ORBIT";
    f.coordinate_sys = "IGS20";
    f.orbit_type = "FIT";
    f.agency = "SDN";
    f.file_type = "M ";
    f.time_system = "GPS";
    f.gps_week = 2350;
    f.seconds_of_week = 0.0;
    f.epoch_interval = o.interval;
    f.mjd = 60694;
    f.fractional_day = 0.0;
    f.base_pos_vel_sigma = 1.25;
    f.base_clk_rate_sigma = 1.025;
    f.start_epoch_iso = "2025-01-19T00:00:00.00000000";
    f.comments.push_back("Space Data Network orbit-products SP3-d writer acceptance fixture");
    f.comments.push_back("Synthetic circular arcs; not a navigation product");
    f.comments.push_back("Frame and time system are declared, never converted");
    f.comments.push_back("Clock columns lie on the six-decimal on-disk grid");

    const std::vector<SatSpec> specs = make_constellation(o.sats);
    for (size_t i = 0; i < specs.size(); ++i) {
        sp3::SatelliteBlock blk;
        blk.sat_id = specs[i].id;
        blk.accuracy_exponent = static_cast<int>(5 + (i % 7));
        blk.series.object_id = specs[i].id;
        blk.series.frame_name = f.coordinate_sys;
        blk.series.time_system = f.time_system;
        blk.series.center_name = "EARTH";
        blk.series.epoch_zero_iso = f.start_epoch_iso;
        for (size_t e = 0; e < o.epochs; ++e) {
            const double t = static_cast<double>(e) * o.interval;
            ephem::StateRow row;
            row.epoch = t;
            kepler_state(specs[i], t, row.pos, row.vel);
            row.has_vel = o.pos_vel_flag == 'V';
            if (o.grid_align) {
                for (int c = 0; c < 3; ++c) {
                    row.pos[c] = on_grid(row.pos[c]);
                    /* The velocity grid is 1e-6 DECIMETRES per second, so the
                     * snapping happens in the column's own unit. */
                    row.vel[c] = on_grid(row.vel[c] * 1.0e4) * 1.0e-4;
                }
            }

            sp3::RecordFlags fl;
            /* One satellite at one epoch carries the absent-clock sentinel, so
             * the sentinel translation is exercised on a file we control as
             * well as on the published ones. */
            const bool absent = o.with_absent_clock && i == 3 && e == 1;
            if (!absent) {
                row.clock_bias = on_grid(-412.0 + 3.75 * static_cast<double>(i) +
                                         0.000131 * static_cast<double>(e));
                row.has_clock = true;
                if (o.pos_vel_flag == 'V') {
                    row.clock_rate = on_grid(-4.534317 + 0.0011 * static_cast<double>(i));
                    fl.has_clock_rate = true;
                }
            }
            if (o.with_flags) {
                fl.x_sdev = 18;
                fl.y_sdev = 18;
                fl.z_sdev = 18;
                fl.c_sdev = 219;
                if (o.pos_vel_flag == 'V') {
                    fl.xv_sdev = 14;
                    fl.yv_sdev = 14;
                    fl.zv_sdev = 14;
                    fl.cr_sdev = 191;
                }
                fl.clock_event = (i == 1 && e == 2);
                fl.clock_predicted = (i == 1 && e == 3);
                fl.maneuver = (i == 2 && e == 2);
                fl.orbit_predicted = (e + 1 == o.epochs);
            }
            blk.series.rows.push_back(row);
            blk.flags.push_back(fl);
        }
        f.satellites.push_back(blk);
    }
    return f;
}

/* ------------------------------------------------------------------------ */
/* Specification conformance                                                 */
/* ------------------------------------------------------------------------ */

struct RuleLog {
    int checked = 0;
    std::vector<std::string> violations;

    void rule(bool ok, const std::string& what) {
        ++checked;
        if (!ok) violations.push_back(what);
    }
};

static std::vector<std::string> split_lines(const std::string& text) {
    std::vector<std::string> out;
    size_t pos = 0;
    while (pos < text.size()) {
        size_t nl = text.find('\n', pos);
        if (nl == std::string::npos) nl = text.size();
        std::string line = text.substr(pos, nl - pos);
        if (!line.empty() && line.back() == '\r') line.pop_back();
        out.push_back(line);
        pos = nl + 1;
    }
    return out;
}

/* Column access, 1-indexed. Past the end is a blank, exactly as the spec's
 * "missing columns should be interpreted as blanks" requires. */
static char at(const std::string& s, size_t c) { return c >= 1 && c <= s.size() ? s[c - 1] : ' '; }

static std::string slice(const std::string& s, size_t a, size_t b) {
    std::string out;
    for (size_t c = a; c <= b; ++c) out.push_back(at(s, c));
    return out;
}

static bool blanks(const std::string& s, const size_t* cols, size_t n) {
    for (size_t i = 0; i < n; ++i) {
        if (at(s, cols[i]) != ' ') return false;
    }
    return true;
}

/* "  -18133.044484" style: right-justified, exactly `decimals` places, no
 * exponent, no stray characters. This is the check that catches a field
 * emitted one column off. */
static bool is_fixed_real(const std::string& field, size_t decimals) {
    size_t i = 0;
    while (i < field.size() && field[i] == ' ') ++i;
    if (i == field.size()) return false;
    if (field[i] == '-' || field[i] == '+') ++i;
    size_t digits = 0;
    while (i < field.size() && field[i] >= '0' && field[i] <= '9') {
        ++i;
        ++digits;
    }
    if (digits == 0) return false;
    if (i >= field.size() || field[i] != '.') return false;
    ++i;
    size_t frac = 0;
    while (i < field.size() && field[i] >= '0' && field[i] <= '9') {
        ++i;
        ++frac;
    }
    return i == field.size() && frac == decimals;
}

static bool is_fixed_int(const std::string& field, bool allow_blank) {
    size_t i = 0;
    while (i < field.size() && field[i] == ' ') ++i;
    if (i == field.size()) return allow_blank;
    if (field[i] == '-') ++i;
    size_t digits = 0;
    while (i < field.size() && field[i] >= '0' && field[i] <= '9') {
        ++i;
        ++digits;
    }
    return i == field.size() && digits > 0;
}

static long field_int(const std::string& s, size_t a, size_t b) {
    return std::strtol(slice(s, a, b).c_str(), nullptr, 10);
}

/*
 * Every rule below cites the SP3-d specification's own column table. The
 * writer is graded by this function and not by sp3::read, deliberately: a
 * codec that only agrees with itself has proved nothing about the format.
 */
static void check_spec(const std::string& text, const sp3::File& src, RuleLog* rc) {
    const std::vector<std::string> lines = split_lines(text);
    rc->rule(lines.size() > 24, "file has a header and a body");
    if (lines.size() < 25) return;

    /* ---- line 1 ---- */
    const std::string& l1 = lines[0];
    rc->rule(at(l1, 1) == '#' && at(l1, 2) == src.version, "line1 cols 1-2 version symbol");
    rc->rule(at(l1, 3) == src.pos_vel_flag, "line1 col 3 pos/vel flag");
    rc->rule(is_fixed_int(slice(l1, 4, 7), false), "line1 cols 4-7 year I4");
    {
        static const size_t b[] = {8, 11, 14, 17, 20, 32, 40, 46, 52, 56};
        rc->rule(blanks(l1, b, sizeof b / sizeof b[0]), "line1 unused columns are blank");
    }
    rc->rule(is_fixed_int(slice(l1, 9, 10), false) && is_fixed_int(slice(l1, 12, 13), false) &&
                 is_fixed_int(slice(l1, 15, 16), false) && is_fixed_int(slice(l1, 18, 19), false),
             "line1 month/day/hour/minute I2 fields");
    rc->rule(is_fixed_real(slice(l1, 21, 31), 8), "line1 cols 21-31 seconds F11.8");
    rc->rule(is_fixed_int(slice(l1, 33, 39), false), "line1 cols 33-39 number of epochs I7");
    rc->rule(slice(l1, 41, 45) == "ORBIT" || slice(l1, 41, 45).substr(0, src.data_used.size()) ==
                                                 src.data_used,
             "line1 cols 41-45 data used A5");
    rc->rule(slice(l1, 47, 51).substr(0, src.coordinate_sys.size()) == src.coordinate_sys,
             "line1 cols 47-51 coordinate system A5");
    rc->rule(slice(l1, 53, 55).substr(0, src.orbit_type.size()) == src.orbit_type,
             "line1 cols 53-55 orbit type A3");
    rc->rule(slice(l1, 57, 60).substr(0, src.agency.size()) == src.agency,
             "line1 cols 57-60 agency A4");

    /* ---- line 2 ---- */
    const std::string& l2 = lines[1];
    rc->rule(slice(l2, 1, 2) == "##" && at(l2, 3) == ' ', "line2 cols 1-2 symbols");
    rc->rule(is_fixed_int(slice(l2, 4, 7), false) && field_int(l2, 4, 7) == src.gps_week,
             "line2 cols 4-7 GPS week I4");
    rc->rule(is_fixed_real(slice(l2, 9, 23), 8) && at(l2, 8) == ' ' && at(l2, 24) == ' ',
             "line2 cols 9-23 seconds of week F15.8");
    rc->rule(is_fixed_real(slice(l2, 25, 38), 8) && at(l2, 39) == ' ',
             "line2 cols 25-38 epoch interval F14.8");
    rc->rule(is_fixed_int(slice(l2, 40, 44), false) && field_int(l2, 40, 44) == src.mjd &&
                 at(l2, 45) == ' ',
             "line2 cols 40-44 modified Julian day I5");
    rc->rule(is_fixed_real(slice(l2, 46, 60), 13), "line2 cols 46-60 fractional day F15.13");

    /* ---- "+ " and "++" lines ---- */
    size_t plus = 0, plusplus = 0, comments = 0;
    size_t first_plus = 0, first_plusplus = 0, first_pct = 0, first_comment = 0;
    for (size_t i = 0; i < lines.size(); ++i) {
        const std::string& l = lines[i];
        if (at(l, 1) == '*') break;
        if (at(l, 1) == '+' && at(l, 2) == ' ') {
            if (plus == 0) first_plus = i;
            ++plus;
        } else if (at(l, 1) == '+' && at(l, 2) == '+') {
            if (plusplus == 0) first_plusplus = i;
            ++plusplus;
        } else if (at(l, 1) == '%') {
            if (first_pct == 0) first_pct = i;
        } else if (at(l, 1) == '/' && at(l, 2) == '*') {
            if (comments == 0) first_comment = i;
            ++comments;
        }
    }
    const size_t nsat = src.satellites.size();
    size_t want_lines = (nsat + sp3::kSatsPerLine - 1) / sp3::kSatsPerLine;
    if (want_lines < sp3::kMinIdLines) want_lines = sp3::kMinIdLines;
    rc->rule(plus == want_lines, "satellite-id line count = max(5, ceil(nsat/17))");
    rc->rule(plusplus == plus, "accuracy line count equals satellite-id line count");
    rc->rule(is_fixed_int(slice(lines[first_plus], 4, 6), false) &&
                 static_cast<size_t>(field_int(lines[first_plus], 4, 6)) == nsat,
             "first '+ ' line cols 4-6 number of satellites I3");
    {
        bool ok = at(lines[first_plus], 3) == ' ';
        for (size_t k = 1; k < plus && ok; ++k) {
            for (size_t c = 3; c <= 9; ++c) {
                if (at(lines[first_plus + k], c) != ' ') ok = false;
            }
        }
        rc->rule(ok, "'+ ' continuation lines have blank cols 3-9");
    }
    {
        bool ids_ok = true, acc_ok = true;
        for (size_t k = 0; k < plus; ++k) {
            for (size_t j = 0; j < sp3::kSatsPerLine; ++j) {
                const size_t s = k * sp3::kSatsPerLine + j;
                const size_t c = 10 + 3 * j;
                const std::string got_id = slice(lines[first_plus + k], c, c + 2);
                const std::string got_acc = slice(lines[first_plusplus + k], c, c + 2);
                if (s < nsat) {
                    if (got_id != src.satellites[s].sat_id) ids_ok = false;
                    if (field_int(lines[first_plusplus + k], c, c + 2) !=
                        src.satellites[s].accuracy_exponent) {
                        acc_ok = false;
                    }
                } else {
                    if (got_id != "  0") ids_ok = false;
                    if (got_acc != "  0") acc_ok = false;
                }
            }
        }
        rc->rule(ids_ok, "satellite ids occupy cols 10-12, 13-15 ... 58-60 in header order");
        rc->rule(acc_ok, "accuracy exponents occupy the same 17 slots, I3");
    }
    {
        bool ok = true;
        for (size_t k = 0; k < plusplus; ++k) {
            for (size_t c = 3; c <= 9; ++c) {
                if (at(lines[first_plusplus + k], c) != ' ') ok = false;
            }
        }
        rc->rule(ok, "'++' lines have blank cols 3-9");
    }

    /* ---- %c / %f / %i ---- */
    rc->rule(first_pct == first_plusplus + plusplus, "the %-block follows the '++' lines");
    const std::string& c1 = lines[first_pct];
    const std::string& c2 = lines[first_pct + 1];
    const std::string& f1 = lines[first_pct + 2];
    const std::string& f2 = lines[first_pct + 3];
    const std::string& i1 = lines[first_pct + 4];
    const std::string& i2 = lines[first_pct + 5];
    rc->rule(slice(c1, 1, 2) == "%c" && slice(c2, 1, 2) == "%c" && slice(f1, 1, 2) == "%f" &&
                 slice(f2, 1, 2) == "%f" && slice(i1, 1, 2) == "%i" && slice(i2, 1, 2) == "%i",
             "exactly two %c, two %f and two %i lines in that order");
    rc->rule(c1.size() == 60 && c2.size() == 60 && f1.size() == 60 && f2.size() == 60 &&
                 i1.size() == 60 && i2.size() == 60,
             "%-block lines are 60 columns wide");
    rc->rule(slice(c1, 4, 5) == src.file_type, "%c cols 4-5 file type A2");
    rc->rule(slice(c1, 10, 12) == src.time_system, "%c cols 10-12 time system A3");
    {
        static const size_t b[] = {3, 6, 9, 13, 17, 22, 27, 32, 37, 43, 49, 55};
        rc->rule(blanks(c1, b, sizeof b / sizeof b[0]) && blanks(c2, b, sizeof b / sizeof b[0]),
                 "%c unused columns are blank");
    }
    rc->rule(is_fixed_real(slice(f1, 4, 13), 7) && is_fixed_real(slice(f1, 15, 26), 9) &&
                 is_fixed_real(slice(f1, 28, 41), 11) && is_fixed_real(slice(f1, 43, 60), 15),
             "%f fields are F10.7 / F12.9 / F14.11 / F18.15 at cols 4-13/15-26/28-41/43-60");
    {
        static const size_t b[] = {3, 14, 27, 42};
        rc->rule(blanks(f1, b, sizeof b / sizeof b[0]) && blanks(f2, b, sizeof b / sizeof b[0]),
                 "%f unused columns are blank");
    }
    rc->rule(is_fixed_int(slice(i1, 4, 7), false) && is_fixed_int(slice(i1, 9, 12), false) &&
                 is_fixed_int(slice(i1, 14, 17), false) && is_fixed_int(slice(i1, 19, 22), false) &&
                 is_fixed_int(slice(i1, 24, 29), false) && is_fixed_int(slice(i1, 31, 36), false) &&
                 is_fixed_int(slice(i1, 38, 43), false) && is_fixed_int(slice(i1, 45, 50), false) &&
                 is_fixed_int(slice(i1, 52, 60), false),
             "%i fields are I4 x4 then I6 x4 then I9 at their stated columns");
    {
        static const size_t b[] = {3, 8, 13, 18, 23, 30, 37, 44, 51};
        rc->rule(blanks(i1, b, sizeof b / sizeof b[0]) && blanks(i2, b, sizeof b / sizeof b[0]),
                 "%i unused columns are blank");
    }

    /* ---- comments ---- */
    const size_t comment_width = src.version == 'd' ? 80u : 60u;
    {
        bool ok = comments >= sp3::kMinComments;
        for (size_t k = 0; k < comments; ++k) {
            const std::string& l = lines[first_comment + k];
            if (slice(l, 1, 2) != "/*" || at(l, 3) != ' ' || l.size() > comment_width) ok = false;
        }
        rc->rule(ok, "at least 4 comment lines, '/* ' prefixed, within the version's width");
    }

    /* ---- body ---- */
    size_t epochs = 0, p_records = 0, v_records = 0;
    bool epoch_fmt_ok = true, p_fmt_ok = true, v_fmt_ok = true, order_ok = true;
    bool width_ok = true, per_epoch_ok = true;
    size_t in_epoch = 0;
    size_t sat_cursor = 0;
    for (size_t i = 0; i < lines.size(); ++i) {
        const std::string& l = lines[i];
        if (l.size() > 80) width_ok = false;
        if (at(l, 1) == '*') {
            if (epochs > 0 && in_epoch != nsat) per_epoch_ok = false;
            in_epoch = 0;
            sat_cursor = 0;
            ++epochs;
            static const size_t b[] = {8, 11, 14, 17, 20};
            if (slice(l, 1, 2) != "* " || at(l, 3) != ' ' || l.size() != 31 ||
                !is_fixed_int(slice(l, 4, 7), false) || !blanks(l, b, sizeof b / sizeof b[0]) ||
                !is_fixed_int(slice(l, 9, 10), false) || !is_fixed_int(slice(l, 12, 13), false) ||
                !is_fixed_int(slice(l, 15, 16), false) || !is_fixed_int(slice(l, 18, 19), false) ||
                !is_fixed_real(slice(l, 21, 31), 8)) {
                epoch_fmt_ok = false;
            }
            continue;
        }
        if (at(l, 1) != 'P' && at(l, 1) != 'V') continue;
        const bool is_v = at(l, 1) == 'V';
        const bool fields_ok = is_fixed_real(slice(l, 5, 18), 6) &&
                               is_fixed_real(slice(l, 19, 32), 6) &&
                               is_fixed_real(slice(l, 33, 46), 6) &&
                               is_fixed_real(slice(l, 47, 60), 6);
        if (is_v) {
            ++v_records;
            /* Cols 74-80 of a velocity record are unused, so a conforming
             * writer never reaches col 74. */
            if (!fields_ok || l.size() > 73) v_fmt_ok = false;
        } else {
            ++p_records;
            ++in_epoch;
            if (!fields_ok || (l.size() > 60 && at(l, 61) != ' ')) p_fmt_ok = false;
            if (sat_cursor < nsat && slice(l, 2, 4) != src.satellites[sat_cursor].sat_id) {
                order_ok = false;
            }
            ++sat_cursor;
        }
    }
    if (epochs > 0 && in_epoch != nsat) per_epoch_ok = false;

    rc->rule(epoch_fmt_ok, "epoch headers are '*  YYYY MM DD HH MM SS.SSSSSSSS', 31 columns");
    rc->rule(p_fmt_ok, "P records carry four F14.6 fields at cols 5-18/19-32/33-46/47-60");
    rc->rule(src.pos_vel_flag != 'V' || v_fmt_ok,
             "V records use the same four F14.6 fields and stop by col 73");
    rc->rule(per_epoch_ok, "every epoch carries a record for every satellite");
    rc->rule(order_ok, "record order at each epoch matches the header satellite order");
    rc->rule(p_records == epochs * nsat, "P record count = epochs x satellites");
    rc->rule(src.pos_vel_flag != 'V' || v_records == epochs * nsat,
             "V record count = epochs x satellites when the file declares 'V'");
    rc->rule(static_cast<size_t>(field_int(l1, 33, 39)) == epochs,
             "line1 declared epoch count equals the epochs actually written");
    rc->rule(width_ok, "no record exceeds 80 columns");
    rc->rule(!lines.empty() && lines.back() == "EOF", "the last line is the EOF marker");
}

/* ------------------------------------------------------------------------ */
/* Orekit bridge                                                             */
/* ------------------------------------------------------------------------ */

struct OrekitRow {
    std::string sat;
    double dt = 0.0;
    double x = 0.0, y = 0.0, z = 0.0;    /* metres   */
    double vx = 0.0, vy = 0.0, vz = 0.0; /* metres/s */
    double clk = 0.0;                    /* seconds  */
    double clk_rate = 0.0;
    bool clk_absent = false;
    bool rate_absent = false;
    std::string flags;
};

struct OrekitDump {
    std::string version;
    std::string sp3_version;
    std::string time_system;
    std::string coordinate_system;
    std::vector<OrekitRow> rows;
};

static const char* g_java = "java";
static const char* g_cp = nullptr;
static const char* g_data = nullptr;

static bool orekit_available() { return g_cp != nullptr && g_data != nullptr; }

/* Splits a TSV field, returning false for the "null" that the dumper writes
 * where Orekit produced a NaN — that is how an absent clock arrives, and it
 * must be read as absence rather than silently becoming 0. */
static bool tsv_number(const std::string& field, double* out) {
    if (field == "null") return false;
    *out = std::strtod(field.c_str(), nullptr);
    return true;
}

static bool run_orekit(const std::string& sp3_path, const char* tag, OrekitDump* dump) {
    if (!orekit_available()) return false;
    const std::string json = tmp((std::string(tag) + ".orekit.json").c_str());
    const std::string tsv = tmp((std::string(tag) + ".orekit.tsv").c_str());
    std::string cmd = std::string(g_java) + " -cp '" + g_cp + "' Sp3Dump '" + g_data + "' '" +
                      sp3_path + "' '" + json + "' '" + tsv + "' >/dev/null 2>&1";
    if (std::system(cmd.c_str()) != 0) return false;

    std::string text;
    if (!slurp(tsv, &text)) return false;
    const std::vector<std::string> lines = split_lines(text);
    for (size_t i = 0; i < lines.size(); ++i) {
        const std::string& l = lines[i];
        if (l.empty()) continue;
        if (l[0] == '#') {
            const size_t tab = l.find('\t');
            if (tab == std::string::npos) continue;
            const std::string key = l.substr(1, tab - 1);
            const std::string val = l.substr(tab + 1);
            if (key == "orekit") dump->version = val;
            if (key == "version") dump->sp3_version = val;
            if (key == "timeSystem") dump->time_system = val;
            if (key == "coordinateSystem") dump->coordinate_system = val;
            continue;
        }
        std::vector<std::string> f;
        size_t pos = 0;
        while (pos <= l.size()) {
            size_t tab = l.find('\t', pos);
            if (tab == std::string::npos) tab = l.size();
            f.push_back(l.substr(pos, tab - pos));
            pos = tab + 1;
        }
        if (f.size() < 11) continue;
        OrekitRow r;
        r.sat = f[0];
        tsv_number(f[1], &r.dt);
        tsv_number(f[2], &r.x);
        tsv_number(f[3], &r.y);
        tsv_number(f[4], &r.z);
        tsv_number(f[5], &r.vx);
        tsv_number(f[6], &r.vy);
        tsv_number(f[7], &r.vz);
        r.clk_absent = !tsv_number(f[8], &r.clk);
        r.rate_absent = !tsv_number(f[9], &r.clk_rate);
        r.flags = f[10];
        dump->rows.push_back(r);
    }
    return !dump->rows.empty();
}

/* ------------------------------------------------------------------------ */
/* Comparisons                                                               */
/* ------------------------------------------------------------------------ */

struct Agreement {
    double pos_rel = 0.0;
    double vel_rel = 0.0;
    double clk_rel = 0.0;
    double epoch_abs = 0.0;
    long matched = 0;
    long unmatched = 0;
    long clock_flag_mismatch = 0;
};

/* Compares a parsed sp3::File against an Orekit dump of the same bytes. The
 * unit conversions are the whole point of the comparison: km -> m, km/s -> m/s
 * and microseconds -> seconds. If the writer or reader had the SP3 units
 * wrong, this is where it shows as a factor of 1000 or 10000. */
static Agreement compare_with_orekit(const sp3::File& f, const OrekitDump& dump) {
    Agreement a;
    for (size_t i = 0; i < f.satellites.size(); ++i) {
        const sp3::SatelliteBlock& blk = f.satellites[i];
        for (size_t r = 0; r < blk.series.rows.size(); ++r) {
            const ephem::StateRow& row = blk.series.rows[r];
            const OrekitRow* best = nullptr;
            double best_dt = 1e300;
            for (size_t k = 0; k < dump.rows.size(); ++k) {
                if (dump.rows[k].sat != blk.sat_id) continue;
                const double d = std::fabs(dump.rows[k].dt - row.epoch);
                if (d < best_dt) {
                    best_dt = d;
                    best = &dump.rows[k];
                }
            }
            if (!best || best_dt > 1e-3) {
                ++a.unmatched;
                continue;
            }
            ++a.matched;
            keep_max(&a.epoch_abs, best_dt);
            const double rmag = norm3(row.pos) * 1000.0;
            const double vmag = norm3(row.vel) * 1000.0;
            keep_max(&a.pos_rel, rel_to(row.pos[0] * 1000.0, best->x, rmag));
            keep_max(&a.pos_rel, rel_to(row.pos[1] * 1000.0, best->y, rmag));
            keep_max(&a.pos_rel, rel_to(row.pos[2] * 1000.0, best->z, rmag));
            if (row.has_vel) {
                keep_max(&a.vel_rel, rel_to(row.vel[0] * 1000.0, best->vx, vmag));
                keep_max(&a.vel_rel, rel_to(row.vel[1] * 1000.0, best->vy, vmag));
                keep_max(&a.vel_rel, rel_to(row.vel[2] * 1000.0, best->vz, vmag));
            }
            if (row.has_clock != !best->clk_absent) {
                ++a.clock_flag_mismatch;
            } else if (row.has_clock) {
                keep_max(&a.clk_rel, rel(row.clock_bias * 1e-6, best->clk));
            }
        }
    }
    return a;
}

/* ------------------------------------------------------------------------ */
/* Checks                                                                    */
/* ------------------------------------------------------------------------ */

static void check_round_trip() {
    BuildOptions o;
    const sp3::File src = build_file(o);

    std::string text;
    const ephem::Status ws = sp3::write(src, &text);
    result_eq("write_status_ok", static_cast<double>(static_cast<int>(ws)), 0.0);
    if (ws != ephem::Status::Ok) return;
    spit(tmp("sp3_written_d.sp3"), text);

    sp3::File back;
    const ephem::Status rs = sp3::read(text.data(), text.size(), &back);
    result_eq("read_status_ok", static_cast<double>(static_cast<int>(rs)), 0.0);
    if (rs != ephem::Status::Ok) return;

    result_eq("roundtrip_satellite_count", static_cast<double>(back.satellites.size()),
              static_cast<double>(src.satellites.size()));
    result_eq("roundtrip_version", static_cast<double>(back.version),
              static_cast<double>(src.version));
    result_eq("roundtrip_pos_vel_flag", static_cast<double>(back.pos_vel_flag),
              static_cast<double>(src.pos_vel_flag));

    double pos = 0.0, vel = 0.0, clk = 0.0, rate = 0.0, epoch = 0.0;
    double pos_component = 0.0, vel_component = 0.0;
    long flag_mismatch = 0, clock_flag_mismatch = 0, row_mismatch = 0;
    for (size_t i = 0; i < src.satellites.size(); ++i) {
        const sp3::SatelliteBlock& a = src.satellites[i];
        const sp3::SatelliteBlock& b = back.satellites[i];
        if (a.sat_id != b.sat_id || a.series.rows.size() != b.series.rows.size() ||
            a.accuracy_exponent != b.accuracy_exponent) {
            ++row_mismatch;
            continue;
        }
        for (size_t r = 0; r < a.series.rows.size(); ++r) {
            const ephem::StateRow& x = a.series.rows[r];
            const ephem::StateRow& y = b.series.rows[r];
            keep_max(&epoch, std::fabs(x.epoch - y.epoch));
            const double rmag = norm3(x.pos);
            const double vmag = norm3(x.vel);
            for (int c = 0; c < 3; ++c) {
                keep_max(&pos, rel_to(x.pos[c], y.pos[c], rmag));
                keep_max(&vel, rel_to(x.vel[c], y.vel[c], vmag));
                keep_max(&pos_component, rel(x.pos[c], y.pos[c]));
                keep_max(&vel_component, rel(x.vel[c], y.vel[c]));
            }
            if (x.has_clock != y.has_clock) {
                ++clock_flag_mismatch;
            } else if (x.has_clock) {
                keep_max(&clk, rel(x.clock_bias, y.clock_bias));
            }
            const sp3::RecordFlags& fa = a.flags[r];
            const sp3::RecordFlags& fb = b.flags[r];
            if (fa.has_clock_rate != fb.has_clock_rate) {
                ++clock_flag_mismatch;
            } else if (fa.has_clock_rate) {
                keep_max(&rate, rel(x.clock_rate, y.clock_rate));
            }
            if (fa.x_sdev != fb.x_sdev || fa.y_sdev != fb.y_sdev || fa.z_sdev != fb.z_sdev ||
                fa.c_sdev != fb.c_sdev || fa.xv_sdev != fb.xv_sdev || fa.yv_sdev != fb.yv_sdev ||
                fa.zv_sdev != fb.zv_sdev || fa.cr_sdev != fb.cr_sdev ||
                fa.clock_event != fb.clock_event || fa.clock_predicted != fb.clock_predicted ||
                fa.maneuver != fb.maneuver || fa.orbit_predicted != fb.orbit_predicted) {
                ++flag_mismatch;
            }
        }
    }
    result_eq("roundtrip_satellite_mismatches", static_cast<double>(row_mismatch), 0.0);
    result_le("roundtrip_position_rel", pos, 1e-9);
    result_le("roundtrip_velocity_rel", vel, 1e-9);
    note("per-component round-trip error on raw input (bounded below by SP3's own "
         "1 mm / 1e-4 mm/s columns, not by this codec): position %.3g, velocity %.3g",
         pos_component, vel_component);
    result_le("roundtrip_clock_rel", clk, 1e-9);
    result_le("roundtrip_clock_rate_rel", rate, 1e-9);
    result_le("roundtrip_epoch_abs_s", epoch, 1e-8);
    result_eq("roundtrip_clock_presence_mismatches", static_cast<double>(clock_flag_mismatch), 0.0);
    result_eq("roundtrip_record_flag_mismatches", static_cast<double>(flag_mismatch), 0.0);

    /* Specification conformance of the very bytes that just round-tripped. */
    RuleLog rc;
    check_spec(text, src, &rc);
    for (size_t i = 0; i < rc.violations.size(); ++i) {
        note("sp3d_spec violation: %s", rc.violations[i].c_str());
    }
    result_ge("sp3d_spec_rules_checked", static_cast<double>(rc.checked), 30.0);
    result_eq("sp3d_spec_rule_violations", static_cast<double>(rc.violations.size()), 0.0);

    /* The c->d header difference, measured rather than asserted in prose. */
    const std::vector<std::string> lines = split_lines(text);
    size_t plus = 0;
    for (size_t i = 0; i < lines.size(); ++i) {
        if (at(lines[i], 1) == '*') break;
        if (at(lines[i], 1) == '+' && at(lines[i], 2) == ' ') ++plus;
    }
    result_eq("sp3d_id_lines_for_122_satellites", static_cast<double>(plus), 8.0);

    /* Three satellites still get five "+ " lines: SP3-d keeps SP3-c's floor. */
    BuildOptions few;
    few.sats = 3;
    few.epochs = 2;
    few.pos_vel_flag = 'P';
    const sp3::File small = build_file(few);
    std::string small_text;
    if (sp3::write(small, &small_text) == ephem::Status::Ok) {
        spit(tmp("sp3_written_d_small.sp3"), small_text);
        const std::vector<std::string> sl = split_lines(small_text);
        size_t p = 0;
        for (size_t i = 0; i < sl.size(); ++i) {
            if (at(sl[i], 1) == '*') break;
            if (at(sl[i], 1) == '+' && at(sl[i], 2) == ' ') ++p;
        }
        result_eq("sp3d_id_lines_for_3_satellites", static_cast<double>(p), 5.0);
        RuleLog rc2;
        check_spec(small_text, small, &rc2);
        result_eq("sp3d_spec_rule_violations_position_only",
                  static_cast<double>(rc2.violations.size()), 0.0);
        for (size_t i = 0; i < rc2.violations.size(); ++i) {
            note("sp3d_spec (position-only) violation: %s", rc2.violations[i].c_str());
        }
    } else {
        result_eq("sp3d_id_lines_for_3_satellites", -1.0, 5.0);
    }

    /* SP3-c cannot hold 122 satellites; the writer must refuse rather than
     * emit a file whose header contradicts its own version. */
    /* On input the format can represent exactly, the codec must lose NOTHING —
     * this is the number that would move if a column were misplaced by a digit
     * or a unit factor were slightly off. */
    {
        BuildOptions g = o;
        g.grid_align = true;
        const sp3::File exact = build_file(g);
        std::string gt;
        double gp = 0.0, gv = 0.0;
        if (sp3::write(exact, &gt) == ephem::Status::Ok) {
            sp3::File gb;
            if (sp3::read(gt.data(), gt.size(), &gb) == ephem::Status::Ok) {
                for (size_t i = 0; i < exact.satellites.size(); ++i) {
                    for (size_t r = 0; r < exact.satellites[i].series.rows.size(); ++r) {
                        const ephem::StateRow& x = exact.satellites[i].series.rows[r];
                        const ephem::StateRow& y = gb.satellites[i].series.rows[r];
                        for (int c = 0; c < 3; ++c) {
                            keep_max(&gp, rel(x.pos[c], y.pos[c]));
                            keep_max(&gv, rel(x.vel[c], y.vel[c]));
                        }
                    }
                }
            } else {
                gp = gv = 1.0;
            }
        } else {
            gp = gv = 1.0;
        }
        result_le("roundtrip_position_component_rel_on_grid", gp, 0.0);
        result_le("roundtrip_velocity_component_rel_on_grid", gv, 0.0);
    }

    sp3::File as_c = src;
    as_c.version = 'c';
    std::string junk;
    const ephem::Status cs = sp3::write(as_c, &junk);
    result_eq("sp3c_refuses_more_than_85_satellites",
              static_cast<double>(static_cast<int>(cs)),
              static_cast<double>(static_cast<int>(ephem::Status::OutOfRange)));
}

/*
 * The P/V unit asymmetry, checked three ways on the same file: what is in the
 * velocity COLUMNS, what the reader gets back, and what Orekit makes of it.
 * A writer that emitted km/s into a dm/s field would pass none of them.
 */
static void check_pv_units() {
    BuildOptions o;
    o.sats = 4;
    o.epochs = 2;
    o.pos_vel_flag = 'V';
    const sp3::File src = build_file(o);
    std::string text;
    if (sp3::write(src, &text) != ephem::Status::Ok) {
        result_eq("pv_write_status_ok", 1.0, 0.0);
        return;
    }
    const std::string path = tmp("sp3_written_pv.sp3");
    spit(path, text);

    const std::vector<std::string> lines = split_lines(text);
    double column_rel = 0.0;
    double pos_column_rel = 0.0;
    long v_seen = 0;
    size_t sat = 0, epoch = 0;
    for (size_t i = 0; i < lines.size(); ++i) {
        const std::string& l = lines[i];
        if (at(l, 1) == '*') {
            if (epoch != 0 || sat != 0) ++epoch;
            sat = 0;
            continue;
        }
        if (at(l, 1) == 'P') {
            const ephem::StateRow& row = src.satellites[sat].series.rows[epoch];
            const double rmag = norm3(row.pos);
            for (int c = 0; c < 3; ++c) {
                const double col = std::strtod(slice(l, 5 + 14 * c, 18 + 14 * c).c_str(), nullptr);
                /* Position columns are plain kilometres: the same number that
                 * is in the Series. */
                keep_max(&pos_column_rel, rel_to(col, row.pos[c], rmag));
            }
            continue;
        }
        if (at(l, 1) != 'V') continue;
        const ephem::StateRow& row = src.satellites[sat].series.rows[epoch];
        const double vmag = norm3(row.vel) * 1.0e4;
        for (int c = 0; c < 3; ++c) {
            const double col = std::strtod(slice(l, 5 + 14 * c, 18 + 14 * c).c_str(), nullptr);
            /* Velocity columns are DECIMETRES per second: 1e4 times the km/s
             * the Series holds. */
            keep_max(&column_rel, rel_to(col, row.vel[c] * 1.0e4, vmag));
        }
        ++v_seen;
        ++sat;
    }
    result_eq("pv_velocity_records_written", static_cast<double>(v_seen),
              static_cast<double>(o.sats * o.epochs));
    result_le("pv_position_column_is_km_rel", pos_column_rel, 1e-9);
    result_le("pv_velocity_column_is_dm_per_s_rel", column_rel, 1e-9);

    sp3::File back;
    if (sp3::read(text.data(), text.size(), &back) != ephem::Status::Ok) {
        result_eq("pv_read_status_ok", 1.0, 0.0);
        return;
    }
    double readback = 0.0;
    for (size_t i = 0; i < src.satellites.size(); ++i) {
        for (size_t r = 0; r < src.satellites[i].series.rows.size(); ++r) {
            const ephem::StateRow& x = src.satellites[i].series.rows[r];
            const ephem::StateRow& y = back.satellites[i].series.rows[r];
            const double vmag = norm3(x.vel);
            for (int c = 0; c < 3; ++c) {
                keep_max(&readback, rel_to(x.vel[c], y.vel[c], vmag));
            }
        }
    }
    result_le("pv_velocity_readback_km_per_s_rel", readback, 1e-9);

    if (!orekit_available()) {
        skip("pv_velocity_orekit_m_per_s_rel", "SP3_OREKIT_CP / SP3_OREKIT_DATA are not set");
        return;
    }
    OrekitDump dump;
    if (!run_orekit(path, "pv", &dump)) {
        result_eq("pv_velocity_orekit_m_per_s_rel", 1.0, 0.0);
        note("Orekit refused the written velocity file");
        return;
    }
    const Agreement a = compare_with_orekit(back, dump);
    result_le("pv_velocity_orekit_m_per_s_rel", a.vel_rel, 1e-9);
}

static void check_orekit_written() {
    if (!orekit_available()) {
        skip("orekit_position_rel", "SP3_OREKIT_CP / SP3_OREKIT_DATA are not set");
        return;
    }
    BuildOptions o;
    const sp3::File src = build_file(o);
    std::string text;
    if (sp3::write(src, &text) != ephem::Status::Ok) {
        result_eq("orekit_position_rel", 1.0, 0.0);
        return;
    }
    const std::string path = tmp("sp3_written_for_orekit.sp3");
    spit(path, text);

    OrekitDump dump;
    if (!run_orekit(path, "written", &dump)) {
        result_eq("orekit_parse_of_written_file", 1.0, 0.0);
        note("Orekit failed to parse the file this writer produced");
        return;
    }
    result_eq("orekit_parse_of_written_file", 0.0, 0.0);
    note("independent parser: %s, read SP3 version '%s', time system %s, frame %s",
         dump.version.c_str(), dump.sp3_version.c_str(), dump.time_system.c_str(),
         dump.coordinate_system.c_str());

    const Agreement a = compare_with_orekit(src, dump);
    result_eq("orekit_unmatched_rows", static_cast<double>(a.unmatched), 0.0);
    result_ge("orekit_matched_rows", static_cast<double>(a.matched),
              static_cast<double>(o.sats * o.epochs - 1));
    result_le("orekit_position_rel", a.pos_rel, 1e-9);
    result_le("orekit_velocity_rel", a.vel_rel, 1e-9);
    result_le("orekit_clock_rel", a.clk_rel, 1e-9);
    result_le("orekit_epoch_abs_s", a.epoch_abs, 1e-8);
    result_eq("orekit_clock_presence_mismatches", static_cast<double>(a.clock_flag_mismatch), 0.0);
    result_eq("orekit_reports_version_d", dump.sp3_version == "d" ? 0.0 : 1.0, 0.0);
}

/*
 * A published product read by us and by Orekit, from the same bytes. This is
 * the check that would catch a reader that is self-consistent but wrong about
 * what real IGS files contain.
 */
static void check_published(const std::string& fixture_dir, const char* file, const char* tag,
                            char expect_version, size_t expect_sats) {
    const std::string path = fixture_dir + "/" + file;
    std::string text;
    std::string name;

    name = std::string("published_") + tag + "_read_status_ok";
    if (!slurp(path, &text)) {
        result_eq(name.c_str(), 1.0, 0.0);
        note("missing fixture %s", path.c_str());
        return;
    }
    sp3::File f;
    const ephem::Status rs = sp3::read(text.data(), text.size(), &f);
    result_eq(name.c_str(), static_cast<double>(static_cast<int>(rs)), 0.0);
    if (rs != ephem::Status::Ok) return;

    name = std::string("published_") + tag + "_version";
    result_eq(name.c_str(), static_cast<double>(f.version),
              static_cast<double>(expect_version));
    name = std::string("published_") + tag + "_satellite_count";
    result_eq(name.c_str(), static_cast<double>(f.satellites.size()),
              static_cast<double>(expect_sats));

    /* Re-emitting a published file must reproduce it column for column. The
     * only licensed differences are line terminators and trailing blanks,
     * which the spec says are blanks either way. */
    std::string rewritten;
    name = std::string("published_") + tag + "_rewrite_status_ok";
    const ephem::Status ws = sp3::write(f, &rewritten);
    result_eq(name.c_str(), static_cast<double>(static_cast<int>(ws)), 0.0);
    if (ws == ephem::Status::Ok) {
        std::vector<std::string> a = split_lines(text);
        std::vector<std::string> b = split_lines(rewritten);
        long diff = 0;
        for (size_t i = 0; i < a.size() || i < b.size(); ++i) {
            std::string x = i < a.size() ? a[i] : std::string();
            std::string y = i < b.size() ? b[i] : std::string();
            while (!x.empty() && x.back() == ' ') x.pop_back();
            while (!y.empty() && y.back() == ' ') y.pop_back();
            if (x != y) {
                if (diff < 3) note("published_%s rewrite line %zu:\n  in  [%s]\n  out [%s]", tag,
                                   i + 1, x.c_str(), y.c_str());
                ++diff;
            }
        }
        name = std::string("published_") + tag + "_rewrite_line_differences";
        result_eq(name.c_str(), static_cast<double>(diff), 0.0);
    }

    if (!orekit_available()) {
        name = std::string("published_") + tag + "_orekit_position_rel";
        skip(name.c_str(), "SP3_OREKIT_CP / SP3_OREKIT_DATA are not set");
        return;
    }
    OrekitDump dump;
    if (!run_orekit(path, tag, &dump)) {
        name = std::string("published_") + tag + "_orekit_position_rel";
        result_eq(name.c_str(), 1.0, 0.0);
        note("Orekit refused published fixture %s", file);
        return;
    }
    const Agreement a = compare_with_orekit(f, dump);
    long rows = 0;
    for (size_t i = 0; i < f.satellites.size(); ++i) rows += f.satellites[i].series.rows.size();

    name = std::string("published_") + tag + "_row_count_delta";
    result_eq(name.c_str(), static_cast<double>(rows - static_cast<long>(dump.rows.size())), 0.0);
    name = std::string("published_") + tag + "_unmatched_rows";
    result_eq(name.c_str(), static_cast<double>(a.unmatched), 0.0);
    name = std::string("published_") + tag + "_orekit_position_rel";
    result_le(name.c_str(), a.pos_rel, 1e-9);
    name = std::string("published_") + tag + "_orekit_clock_rel";
    result_le(name.c_str(), a.clk_rel, 1e-9);
    name = std::string("published_") + tag + "_orekit_epoch_abs_s";
    result_le(name.c_str(), a.epoch_abs, 1e-8);
    /* The sentinel translation, measured against somebody else's idea of what
     * "absent" means in this file. */
    name = std::string("published_") + tag + "_clock_sentinel_mismatches";
    result_eq(name.c_str(), static_cast<double>(a.clock_flag_mismatch), 0.0);
}

/* Malformed input must produce a Status, never a trap and never a NaN. */
static void check_refusals() {
    struct Case {
        const char* name;
        std::string text;
        ephem::Status want;
    };
    std::string good;
    {
        BuildOptions o;
        o.sats = 2;
        o.epochs = 2;
        o.pos_vel_flag = 'P';
        sp3::write(build_file(o), &good);
    }
    std::vector<Case> cases;
    cases.push_back(Case{"empty", std::string(""), ephem::Status::Truncated});
    cases.push_back(Case{"bad_magic", std::string("not an sp3 file at all\n"),
                         ephem::Status::BadMagic});
    {
        std::string t = good;
        t[1] = 'z';
        cases.push_back(Case{"unknown_version", t, ephem::Status::UnsupportedVariant});
    }
    {
        std::string t = good;
        t[2] = 'X';
        cases.push_back(Case{"bad_pos_vel_flag", t, ephem::Status::Malformed});
    }
    {
        /* A position column filled with letters. strtod would happily return 0
         * for "abcdef"; the reader must refuse instead. */
        std::string t = good;
        const size_t p = t.find("\nP");
        t.replace(p + 6, 6, "abcdef");
        cases.push_back(Case{"garbage_in_position_column", t, ephem::Status::Malformed});
    }
    {
        /* Header only: an SP3 file with no epoch is not a truncated record, it
         * is a truncated file. */
        std::string t = good.substr(0, good.find("\n*  "));
        cases.push_back(Case{"header_without_epochs", t, ephem::Status::Truncated});
    }

    long wrong = 0, nan_escapes = 0;
    for (size_t i = 0; i < cases.size(); ++i) {
        sp3::File f;
        const ephem::Status got = sp3::read(cases[i].text.data(), cases[i].text.size(), &f);
        if (got != cases[i].want) {
            ++wrong;
            note("refusal case %s: got %s, wanted %s", cases[i].name, ephem::status_name(got),
                 ephem::status_name(cases[i].want));
        }
        for (size_t s = 0; s < f.satellites.size(); ++s) {
            for (size_t r = 0; r < f.satellites[s].series.rows.size(); ++r) {
                if (!ephem::row_is_finite(f.satellites[s].series.rows[r])) ++nan_escapes;
            }
        }
    }
    result_eq("malformed_inputs_checked", static_cast<double>(cases.size()),
              static_cast<double>(cases.size()));
    result_eq("malformed_status_mismatches", static_cast<double>(wrong), 0.0);
    result_eq("malformed_nan_escapes", static_cast<double>(nan_escapes), 0.0);
}

/* ------------------------------------------------------------------------ */

int main(int argc, char** argv) {
    std::string fixtures = "fixtures";
    for (int i = 1; i < argc; ++i) {
        if (std::strcmp(argv[i], "--fixtures") == 0 && i + 1 < argc) fixtures = argv[++i];
    }
    if (const char* d = std::getenv("SP3_TMPDIR")) g_tmpdir = d;
    if (const char* j = std::getenv("SP3_JAVA")) g_java = j;
    g_cp = std::getenv("SP3_OREKIT_CP");
    g_data = std::getenv("SP3_OREKIT_DATA");

    note("fixtures %s", fixtures.c_str());
    note("scratch %s", g_tmpdir.c_str());
    note("independent parser %s", orekit_available() ? "orekit (configured)" : "NOT CONFIGURED");
    note("SP3-d authority files.igs.org/pub/data/format/sp3d.pdf (Hilla, NGS, 2016-02-21)");

    check_round_trip();
    check_pv_units();
    check_orekit_written();
    check_published(fixtures, "COD0MGXFIN_20250190000_01D_05M_ORB.3ep.sp3", "cod_sp3d", 'd', 122);
    check_published(fixtures, "igs15000.3ep.sp3", "igs_sp3c", 'c', 32);
    check_refusals();

    std::printf("\n%d failures, %d skipped\n", g_failures, g_skips);
    return g_failures == 0 ? 0 : 1;
}
