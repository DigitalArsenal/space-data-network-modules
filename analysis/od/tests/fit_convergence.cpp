// Copyright 2026 Edgesource Corporation
// SPDX-License-Identifier: Apache-2.0
//
// Fit convergence and stability of the SGP4 fitter (src/cpp/src/sgp4_fitter.cpp) on the GLONASS, ISS and Starlink
// ephemerides the OD tests carry, at the supplemental-omm OD node's iteration cap (maxIterations 40). For every
// object: the fit's iterations, whether it converged, its RMS, then the same fit with every input coordinate moved by
// one unit in the last place (std::nextafter toward +inf); the spread is the largest distance between the two sets'
// positions from a day before to a day after the epoch, every 10 minutes. A fit is a property of the data: the spread
// must stay at meters.
//
//   tests/fit_convergence [--json out.json]     (built by tests/fit_convergence.sh from analysis/od)
#include "od/frame_transform.h"
#include "od/meme_parser.h"
#include "od/oem_parser.h"
#include "od/sgp4_fitter.h"
#include "od/state_series.h"
#include "od/time_systems.h"
#include "sgp4_str3.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

using namespace od;

namespace {

constexpr int kNodeMaxIterations = 40;  // flows/supplemental-omm/nodes/od: {"maxIterations":40}

std::string read_text(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

// The GLONASS SP3 arc: every satellite's (GPS time, Earth-fixed) positions to a TEME/UTC position-only series, as the
// OD converter builds it.
std::map<std::string, StateSeries> glonass_series(const std::string& path) {
    std::map<std::string, StateSeries> out;
    std::istringstream in(read_text(path));
    std::string line;
    double jd_gps = 0.0;
    while (std::getline(in, line)) {
        if (line.size() > 2 && line[0] == '*' && line[1] == ' ') {
            std::istringstream ss(line.substr(1));
            int y, mo, d, h, mi;
            double s;
            if (ss >> y >> mo >> d >> h >> mi >> s) jd_gps = jd_from_ymd(y, mo, d) + (h * 3600.0 + mi * 60.0 + s) / 86400.0;
        } else if (line.size() > 4 && line[0] == 'P' && line[1] == 'R' && jd_gps != 0.0) {
            const std::string id = line.substr(1, 3);
            std::istringstream ss(line.substr(4));
            double r_ecef[3];
            if (!(ss >> r_ecef[0] >> r_ecef[1] >> r_ecef[2])) continue;
            StateSeries& series = out[id];
            series.meta.object_name = "GLONASS " + id;
            series.meta.data_source = "GLONASS";
            series.meta.position_only = true;
            const TimeConv utc = gps_jd_to_utc(jd_gps);
            EphemerisPoint p{};
            p.epoch_jd = utc.jd_utc;
            double r_teme[3];
            ecef_to_teme_pos(utc.jd_utc, r_ecef, r_teme);
            p.x = r_teme[0];
            p.y = r_teme[1];
            p.z = r_teme[2];
            series.samples.push_back(p);
        }
    }
    return out;
}

bool position(const SGP4Elements& el, double jd, double r[3]) {
    sdnap::Elements e{};
    sdnap::split_jd(el.epoch_jd, e.epoch_jd_whole, e.epoch_jd_frac);
    e.xno = el.mean_motion * 2.0 * M_PI / 1440.0;
    e.eo = el.eccentricity;
    e.xincl = el.inclination * M_PI / 180.0;
    e.xnodeo = el.ra_of_asc_node * M_PI / 180.0;
    e.omegao = el.arg_of_pericenter * M_PI / 180.0;
    e.xmo = el.mean_anomaly * M_PI / 180.0;
    e.bstar = el.bstar;
    e.ndot_rev_day2 = el.mean_motion_dot;
    e.nddot_rev_day3 = el.mean_motion_ddot;
    sdnap::Sat sat;
    if (sdnap::sat_init(e, sdnap::gravity_wgs72(), sat, sdnap::Sgp4Mode::kImproved) != sdnap::kPropOk) return false;
    double v[3];
    return sdnap::sat_propagate(sat, nullptr, (jd - el.epoch_jd) * 1440.0, r, v) == sdnap::kPropOk;
}

// The largest distance between two sets' positions over the epoch -1 day to +1 day, every 10 minutes (km).
double spread_km(const SGP4Elements& a, const SGP4Elements& b) {
    double worst = 0.0;
    for (int k = -144; k <= 144; k++) {
        const double jd = a.epoch_jd + k / 144.0;
        double ra[3], rb[3];
        if (!position(a, jd, ra) || !position(b, jd, rb)) return INFINITY;
        worst = std::max(worst, std::hypot(ra[0] - rb[0], ra[1] - rb[1], ra[2] - rb[2]));
    }
    return worst;
}

StateSeries last_bit(const StateSeries& series) {
    StateSeries out = series;
    for (EphemerisPoint& p : out.samples) {
        p.x = std::nextafter(p.x, INFINITY);
        p.y = std::nextafter(p.y, INFINITY);
        p.z = std::nextafter(p.z, INFINITY);
        if (!series.meta.position_only) {
            p.vx = std::nextafter(p.vx, INFINITY);
            p.vy = std::nextafter(p.vy, INFINITY);
            p.vz = std::nextafter(p.vz, INFINITY);
        }
    }
    return out;
}

struct Row {
    std::string group, name;
    size_t states = 0;
    int iterations = 0;
    bool converged = false;
    double rms_km = 0.0, rms_perturbed_km = 0.0, spread_km = 0.0;
};

}  // namespace

int main(int argc, char** argv) {
    std::string json_path;
    for (int i = 1; i + 1 < argc; i++)
        if (std::string(argv[i]) == "--json") json_path = argv[i + 1];

    std::vector<std::pair<std::string, StateSeries>> objects;
    for (auto& [id, series] : glonass_series("tests/data/glonass/synthetic_glonass.sp3.glo")) objects.push_back({"GLONASS", series});
    for (const char* oem : {"../../files/ccsds-messages/fixtures/real/nasa-iss.oem",
                            "../../flows/supplemental-omm/tests/fixtures/iss-sgp4xp-3day.oem"}) {
        OEMParseResult parsed = parse_oem(read_text(oem));
        if (!parsed.ok) { std::fprintf(stderr, "%s: %s\n", oem, parsed.error_message.c_str()); return 2; }
        parsed.series.meta.object_name = std::string("ISS ") + (std::string(oem).find("3day") != std::string::npos ? "3-day" : "12-hour");
        objects.push_back({"ISS", parsed.series});
    }
    const char* starlink[] = {
        "MEME_67850_STARLINK-36840_1340142_Operational_1463017380_UNCLASSIFIED.txt",
        "MEME_67851_STARLINK-36348_1340149_Operational_1463017800_UNCLASSIFIED.txt",
        "MEME_67852_STARLINK-36276_1340141_Operational_1463017320_UNCLASSIFIED.txt",
        "MEME_67853_STARLINK-36785_1340147_Operational_1463017680_UNCLASSIFIED.txt",
        "MEME_67854_STARLINK-36608_1340145_Operational_1463017560_UNCLASSIFIED.txt",
        "MEME_67855_STARLINK-36838_1340149_Operational_1463017800_UNCLASSIFIED.txt",
        "MEME_67856_STARLINK-36843_1340142_Operational_1463017380_UNCLASSIFIED.txt",
        "MEME_67857_STARLINK-36828_1340150_Operational_1463017860_UNCLASSIFIED.txt",
        "MEME_67858_STARLINK-36837_1340140_Operational_1463017260_UNCLASSIFIED.txt",
        "MEME_67859_STARLINK-36393_1340146_Operational_1463017620_UNCLASSIFIED.txt",
    };
    for (const char* file : starlink) {
        StateSeries series = meme_state_series(parse_meme_file(std::string("tests/data/supgp-reference/starlink/meme/") + file));
        { const std::string f(file); const size_t a = f.find('_', 5) + 1; series.meta.object_name = f.substr(a, f.find('_', a) - a); }
        objects.push_back({"Starlink", series});
    }

    FitterConfig config;
    config.max_iterations = kNodeMaxIterations;
    std::vector<Row> rows;
    const char* only = std::getenv("FIT_ONLY");
    for (const auto& [group, series] : objects) {
        if (only && series.meta.object_name.find(only) == std::string::npos) continue;
        const FitResult fit = fit_sgp4_series(series, config);
        const FitResult moved = fit_sgp4_series(last_bit(series), config);
        Row row;
        row.group = group;
        row.name = series.meta.object_name;
        row.states = series.samples.size();
        row.iterations = fit.iterations;
        row.converged = fit.converged;
        row.rms_km = fit.rms_km;
        row.rms_perturbed_km = moved.rms_km;
        row.spread_km = spread_km(fit.elements, moved.elements);
        rows.push_back(row);
        std::printf("%-9s %-16s %5zu states  iterations %3d%s  converged %-3s  RMS %.9f km  last-bit spread +/-1 day %.6f km\n",
                    group.c_str(), row.name.c_str(), row.states, row.iterations, row.iterations >= kNodeMaxIterations ? " (cap)" : "",
                    row.converged ? "yes" : "no", row.rms_km, row.spread_km);
    }
    for (const char* group : {"GLONASS", "ISS", "Starlink"}) {
        int n = 0, capped = 0, unconverged = 0;
        double rms_sum = 0.0, worst_spread = 0.0, worst_rms_change = 0.0;
        for (const Row& r : rows) {
            if (r.group != group) continue;
            n++;
            capped += r.iterations >= kNodeMaxIterations;
            unconverged += !r.converged;
            rms_sum += r.rms_km;
            worst_spread = std::max(worst_spread, r.spread_km);
            worst_rms_change = std::max(worst_rms_change, std::abs(r.rms_perturbed_km - r.rms_km) / std::max(r.rms_km, 1e-12));
        }
        std::printf("SUMMARY %-9s %2d fits  at the cap %2d  unconverged %2d  mean RMS %.9f km  worst last-bit spread %.6f km  worst RMS change %.3f%%\n",
                    group, n, capped, unconverged, rms_sum / n, worst_spread, 100.0 * worst_rms_change);
    }
    if (!json_path.empty()) {
        std::ofstream out(json_path);
        out << "[\n";
        for (size_t i = 0; i < rows.size(); i++) {
            const Row& r = rows[i];
            char buf[512];
            std::snprintf(buf, sizeof buf,
                          "  {\"group\":\"%s\",\"name\":\"%s\",\"states\":%zu,\"iterations\":%d,\"converged\":%s,\"rmsKm\":%.12g,\"rmsPerturbedKm\":%.12g,\"spreadKm\":%.12g}%s\n",
                          r.group.c_str(), r.name.c_str(), r.states, r.iterations, r.converged ? "true" : "false", r.rms_km,
                          r.rms_perturbed_km, r.spread_km, i + 1 < rows.size() ? "," : "");
            out << buf;
        }
        out << "]\n";
    }
    return 0;
}
