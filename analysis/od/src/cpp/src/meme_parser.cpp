/**
 * SpaceX MEME Ephemeris Parser
 *
 * Parses Modified Extended Mission Ephemeris format from SpaceX/Starlink.
 * Source: https://api.starlink.com/public-files/ephemerides/
 */

#include "od/meme_parser.h"
#include "od/frame_transform.h"
#include "od/state_series.h"
#include <sstream>
#include <fstream>
#include <cmath>
#include <cstring>
#include <algorithm>
#include <stdexcept>

namespace od {

// ── Constants ──

static constexpr double JD_UNIX_EPOCH = 2440587.5;  // JD at 1970-01-01 00:00:00 UTC

// ── Timestamp parsing ──

// Parse YYYYDDDHHMMSS.sss → Julian Date
double meme_timestamp_to_jd(const std::string& ts) {
    // Format: 2026069201642.000
    if (ts.size() < 13) return 0.0;

    int year = std::stoi(ts.substr(0, 4));
    int doy  = std::stoi(ts.substr(4, 3));
    int hour = std::stoi(ts.substr(7, 2));
    int min  = std::stoi(ts.substr(9, 2));
    int sec  = std::stoi(ts.substr(11, 2));
    double frac = 0.0;
    auto dot = ts.find('.');
    if (dot != std::string::npos) {
        frac = std::stod(ts.substr(dot));
    }

    // Convert year + DOY to month + day
    bool leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
    int days_in_month[] = {31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};

    int month = 1, day = doy;
    for (int i = 0; i < 12; i++) {
        if (day <= days_in_month[i]) { month = i + 1; break; }
        day -= days_in_month[i];
    }

    // JD calculation
    int a = (14 - month) / 12;
    int y = year + 4800 - a;
    int m = month + 12 * a - 3;
    int jdn = day + (153 * m + 2) / 5 + 365 * y + y / 4 - y / 100 + y / 400 - 32045;

    double jd = jdn + (hour - 12) / 24.0 + min / 1440.0 + (sec + frac) / 86400.0;
    return jd;
}

// Parse "2026-03-10 20:32:53 UTC" or "2026-03-10T20:32:53Z" → JD
double iso_to_jd(const std::string& iso) {
    if (iso.size() < 19) return 0.0;

    int year = std::stoi(iso.substr(0, 4));
    int month = std::stoi(iso.substr(5, 2));
    int day = std::stoi(iso.substr(8, 2));
    int hour = std::stoi(iso.substr(11, 2));
    int min = std::stoi(iso.substr(14, 2));
    int sec = std::stoi(iso.substr(17, 2));
    double frac = 0.0;
    // Check for fractional seconds
    size_t pos = 20;
    if (pos < iso.size() && iso[19] == '.') {
        size_t end = iso.find_first_of("Z ", pos);
        if (end == std::string::npos) end = iso.size();
        frac = std::stod(iso.substr(19, end - 19));
    }

    int a = (14 - month) / 12;
    int y = year + 4800 - a;
    int m = month + 12 * a - 3;
    int jdn = day + (153 * m + 2) / 5 + 365 * y + y / 4 - y / 100 + y / 400 - 32045;

    return jdn + (hour - 12) / 24.0 + min / 1440.0 + (sec + frac) / 86400.0;
}

std::string jd_to_iso_supgp(double jd) {
    double jd_plus = jd + 0.5;
    int z = static_cast<int>(jd_plus);
    double f = jd_plus - z;

    int a;
    if (z < 2299161) a = z;
    else {
        int alpha = static_cast<int>((z - 1867216.25) / 36524.25);
        a = z + 1 + alpha - alpha / 4;
    }

    int b = a + 1524;
    int c = static_cast<int>((b - 122.1) / 365.25);
    int d = static_cast<int>(365.25 * c);
    int e = static_cast<int>((b - d) / 30.6001);

    int day = b - d - static_cast<int>(30.6001 * e);
    int month = (e < 14) ? e - 1 : e - 13;
    int year = (month > 2) ? c - 4716 : c - 4715;

    double day_frac = f;
    int hours = static_cast<int>(day_frac * 24.0);
    double rem = day_frac * 24.0 - hours;
    int minutes = static_cast<int>(rem * 60.0);
    rem = rem * 60.0 - minutes;
    double seconds = rem * 60.0;

    char buf[64];
    snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%09.6fZ",
             year, month, day, hours, minutes, seconds);
    return buf;
}

// ── Filename parsing ──

MEMEHeader parse_meme_filename(const std::string& filename) {
    MEMEHeader h;
    // MEME_{NORAD}_{NAME}_{COSPAR}_{Status}_{UnixTS}_UNCLASSIFIED.txt
    // e.g., MEME_51878_STARLINK-3575_0692016_Operational_1457468220_UNCLASSIFIED.txt

    auto parts = std::vector<std::string>();
    std::stringstream ss(filename);
    std::string token;
    while (std::getline(ss, token, '_')) {
        parts.push_back(token);
    }

    if (parts.size() >= 6 && parts[0] == "MEME") {
        h.norad_cat_id = std::stoi(parts[1]);
        h.object_name = parts[2];
        h.cospar_id = parts[3];
        h.status = parts[4];
        h.unix_timestamp = std::stoll(parts[5]);
    }

    return h;
}

// ── MEME file parsing ──

static std::string trim(const std::string& s) {
    auto start = s.find_first_not_of(" \t\r\n");
    auto end = s.find_last_not_of(" \t\r\n");
    return (start == std::string::npos) ? "" : s.substr(start, end - start + 1);
}

MEMEFile parse_meme(const std::string& content) {
    MEMEFile result;
    std::istringstream stream(content);
    std::string line;

    // Parse header
    // Line 1: created:2026-03-10 20:32:53 UTC
    if (std::getline(stream, line)) {
        auto pos = line.find("created:");
        if (pos != std::string::npos) {
            result.header.created = trim(line.substr(pos + 8));
        }
    }

    // Line 2: ephemeris_start:... ephemeris_stop:... step_size:60
    if (std::getline(stream, line)) {
        auto start_pos = line.find("ephemeris_start:");
        auto stop_pos = line.find("ephemeris_stop:");
        auto step_pos = line.find("step_size:");

        if (start_pos != std::string::npos && stop_pos != std::string::npos) {
            result.header.ephemeris_start = trim(
                line.substr(start_pos + 16, stop_pos - start_pos - 16));
            // Remove trailing " UTC" for consistent parsing
            auto& es = result.header.ephemeris_start;
            if (es.size() > 4 && es.substr(es.size() - 4) == " UTC") {
                es.replace(es.size() - 4, 1, "T");
                es = es.substr(0, es.size() - 3) + "Z";
            }
        }
        if (stop_pos != std::string::npos && step_pos != std::string::npos) {
            result.header.ephemeris_stop = trim(
                line.substr(stop_pos + 15, step_pos - stop_pos - 15));
            auto& es = result.header.ephemeris_stop;
            if (es.size() > 4 && es.substr(es.size() - 4) == " UTC") {
                es.replace(es.size() - 4, 1, "T");
                es = es.substr(0, es.size() - 3) + "Z";
            }
        }
        if (step_pos != std::string::npos) {
            result.header.step_size_sec = std::stoi(
                trim(line.substr(step_pos + 10)));
        }
    }

    // Line 3: ephemeris_source:blend
    if (std::getline(stream, line)) {
        auto pos = line.find("ephemeris_source:");
        if (pos != std::string::npos) {
            result.header.ephemeris_source = trim(line.substr(pos + 17));
        }
    }

    // Line 4: UVW (reference frame)
    if (std::getline(stream, line)) {
        result.header.reference_frame = trim(line);
    }

    // Data lines: groups of 4 lines
    // Line 1: timestamp X Y Z VX VY VZ
    // Lines 2-4: 7 covariance elements each (21 total)
    while (std::getline(stream, line)) {
        line = trim(line);
        if (line.empty()) continue;

        EphemerisPoint pt;

        // Parse state line
        std::istringstream state_ss(line);
        std::string ts;
        state_ss >> ts >> pt.x >> pt.y >> pt.z >> pt.vx >> pt.vy >> pt.vz;
        pt.timestamp_str = ts;
        pt.epoch_jd = meme_timestamp_to_jd(ts);

        if (pt.epoch_jd == 0.0) continue;  // Invalid timestamp

        // Parse 3 covariance lines (7 values each = 21 total)
        int cov_idx = 0;
        pt.has_covariance = true;
        for (int cl = 0; cl < 3; cl++) {
            if (!std::getline(stream, line)) {
                pt.has_covariance = false;
                break;
            }
            std::istringstream cov_ss(line);
            for (int j = 0; j < 7 && cov_idx < 21; j++, cov_idx++) {
                cov_ss >> pt.covariance[cov_idx];
            }
        }

        result.points.push_back(pt);
    }

    return result;
}

MEMEFile parse_meme_file(const std::string& path) {
    std::ifstream f(path);
    if (!f.is_open()) {
        return {};
    }
    std::string content((std::istreambuf_iterator<char>(f)),
                         std::istreambuf_iterator<char>());
    auto result = parse_meme(content);

    // Try to extract metadata from filename
    auto slash = path.find_last_of("/\\");
    std::string filename = (slash != std::string::npos) ? path.substr(slash + 1) : path;
    auto fn_header = parse_meme_filename(filename);
    if (fn_header.norad_cat_id > 0) {
        result.header.norad_cat_id = fn_header.norad_cat_id;
        result.header.object_name = fn_header.object_name;
        result.header.cospar_id = fn_header.cospar_id;
        result.header.status = fn_header.status;
        result.header.unix_timestamp = fn_header.unix_timestamp;
    }

    return result;
}

StateSeries meme_state_series(const MEMEFile& meme) {
    StateSeries series;
    series.samples = meme.points;
    for (EphemerisPoint& p : series.samples) {
        const double r_in[3] = {p.x, p.y, p.z};
        const double v_in[3] = {p.vx, p.vy, p.vz};
        double r_out[3], v_out[3];
        eci_j2000_to_teme(p.epoch_jd, r_in, v_in, r_out, v_out);
        p.x = r_out[0]; p.y = r_out[1]; p.z = r_out[2];
        p.vx = v_out[0]; p.vy = v_out[1]; p.vz = v_out[2];
    }
    series.meta.norad_cat_id = meme.header.norad_cat_id;
    series.meta.object_name = meme.header.object_name;
    series.meta.ref_frame = "TEME";
    series.meta.source_frame = "EME2000";
    series.meta.time_system = "UTC";
    series.meta.segment_count = 1;
    // MEME's filename COSPAR field is a SpaceX-internal id, not an international
    // designator, so OBJECT_ID is intentionally not derived from it.
    return series;
}

std::vector<std::string> parse_manifest(const std::string& content) {
    std::vector<std::string> files;
    std::istringstream stream(content);
    std::string line;
    while (std::getline(stream, line)) {
        line = trim(line);
        if (!line.empty() && line.find("MEME_") != std::string::npos) {
            files.push_back(line);
        }
    }
    return files;
}

}  // namespace od
