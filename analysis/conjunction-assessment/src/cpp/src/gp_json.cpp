/**
 * GP JSON/CSV Parser — Parse CelesTrak GP data without external JSON library
 *
 * Minimal parser that handles the specific CelesTrak GP JSON format.
 * No external dependencies (nlohmann/json is forbidden in SDN plugins).
 *
 * CelesTrak JSON endpoint:
 *   https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=json
 *   https://celestrak.org/SOCRATES/data.php?CATNR=61721,67298&FORMAT=json
 */

#include "conjunction/gp_json.h"
#include <cmath>
#include <sstream>
#include <cstdlib>
#include <cerrno>
#include <limits>
#include "conjunction/error_status.h"
#include <algorithm>
#include <cstring>

namespace conjunction {

// Earth radius (km) and gravitational parameter
static constexpr double RE_KM = 6378.137;
static constexpr double MU_KM3S2 = 398600.4418;
static constexpr double TWOPI = 6.283185307179586;
static constexpr double SEC_PER_DAY = 86400.0;

// ============================================================================
// Minimal JSON helpers (no external library)
// ============================================================================

static std::string trim(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n");
    if (a == std::string::npos) return "";
    size_t b = s.find_last_not_of(" \t\r\n");
    return s.substr(a, b - a + 1);
}

/// Extract a string value for a given key from a JSON object substring
static std::string json_string(const std::string& obj, const std::string& key) {
    std::string search = "\"" + key + "\"";
    auto pos = obj.find(search);
    if (pos == std::string::npos) return "";

    // Find the colon after the key
    pos = obj.find(':', pos + search.size());
    if (pos == std::string::npos) return "";

    // Find the opening quote of the value
    pos = obj.find('"', pos + 1);
    if (pos == std::string::npos) return "";

    // Find the closing quote
    auto end = obj.find('"', pos + 1);
    if (end == std::string::npos) return "";

    return obj.substr(pos + 1, end - pos - 1);
}

/// Extract a numeric value for a given key from a JSON object substring
static double json_number(const std::string& obj, const std::string& key, double def = 0.0) {
    std::string search = "\"" + key + "\"";
    auto pos = obj.find(search);
    if (pos == std::string::npos) return def;

    pos = obj.find(':', pos + search.size());
    if (pos == std::string::npos) return def;

    // Skip whitespace
    pos++;
    while (pos < obj.size() && (obj[pos] == ' ' || obj[pos] == '\t')) pos++;

    // Check for null
    if (pos + 3 < obj.size() && obj.substr(pos, 4) == "null") return def;

    // Read number
    std::string numstr;
    while (pos < obj.size() && (std::isdigit(obj[pos]) || obj[pos] == '.' ||
           obj[pos] == '-' || obj[pos] == '+' || obj[pos] == 'e' || obj[pos] == 'E')) {
        numstr += obj[pos++];
    }

    if (numstr.empty()) return def;

    char* end = nullptr;
    errno = 0;
    const double value = std::strtod(numstr.c_str(), &end);
    if (end == numstr.c_str() || *end != '\0' || errno == ERANGE || !std::isfinite(value)) {
        set_error("Invalid GP numeric field: " + key);
        return def;
    }
    return value;
}

/// Extract an integer value
static int json_int(const std::string& obj, const std::string& key, int def = 0) {
    return static_cast<int>(json_number(obj, key, def));
}

/// Split JSON array into individual object strings
static std::vector<std::string> json_split_array(const std::string& json) {
    std::vector<std::string> objects;

    int depth = 0;
    size_t obj_start = 0;
    bool in_obj = false;

    for (size_t i = 0; i < json.size(); i++) {
        char c = json[i];
        if (c == '{') {
            if (depth == 0) { obj_start = i; in_obj = true; }
            depth++;
        } else if (c == '}') {
            depth--;
            if (depth == 0 && in_obj) {
                objects.push_back(json.substr(obj_start, i - obj_start + 1));
                in_obj = false;
            }
        }
    }

    return objects;
}

// ============================================================================
// ISO 8601 Epoch to Julian Date
// ============================================================================

static double iso_epoch_to_jd(const std::string& iso) {
    if (iso.empty()) return 0.0;

    int year = 0, month = 0, day = 0, hour = 0, minute = 0;
    double second = 0.0;

    // Parse "2026-03-10T03:48:27.801504"
    if (sscanf(iso.c_str(), "%d-%d-%dT%d:%d:%lf",
               &year, &month, &day, &hour, &minute, &second) < 3) {
        return 0.0;
    }

    // JD from calendar date
    int a = (14 - month) / 12;
    int y = year + 4800 - a;
    int m = month + 12 * a - 3;
    double jd = day + (153 * m + 2) / 5 + 365 * y + y / 4 - y / 100 + y / 400 - 32045;
    return jd - 0.5 + (hour + minute / 60.0 + second / 3600.0) / 24.0;
}

// ============================================================================
// GP Element Parsing
// ============================================================================

static GPElement parse_gp_object(const std::string& obj) {
    GPElement gp;

    gp.object_name = json_string(obj, "OBJECT_NAME");
    gp.object_id = json_string(obj, "OBJECT_ID");
    gp.epoch_iso = json_string(obj, "EPOCH");
    gp.mean_motion = json_number(obj, "MEAN_MOTION");
    gp.eccentricity = json_number(obj, "ECCENTRICITY");
    gp.inclination = json_number(obj, "INCLINATION");
    gp.ra_of_asc_node = json_number(obj, "RA_OF_ASC_NODE");
    gp.arg_of_pericenter = json_number(obj, "ARG_OF_PERICENTER");
    gp.mean_anomaly = json_number(obj, "MEAN_ANOMALY");
    gp.ephemeris_type = json_int(obj, "EPHEMERIS_TYPE");
    gp.norad_cat_id = json_int(obj, "NORAD_CAT_ID");
    gp.element_set_no = json_int(obj, "ELEMENT_SET_NO");
    gp.rev_at_epoch = json_int(obj, "REV_AT_EPOCH");
    gp.bstar = json_number(obj, "BSTAR");
    gp.mean_motion_dot = json_number(obj, "MEAN_MOTION_DOT");
    gp.mean_motion_ddot = json_number(obj, "MEAN_MOTION_DDOT");

    // Classification
    auto cls = json_string(obj, "CLASSIFICATION_TYPE");
    gp.classification_type = cls.empty() ? 'U' : cls[0];

    // Epoch JD
    gp.epoch_jd = iso_epoch_to_jd(gp.epoch_iso);

    // Derived orbital parameters
    compute_derived(gp);

    return gp;
}

std::vector<GPElement> parse_gp_json(const std::string& json) {
    std::vector<GPElement> elements;

    auto objects = json_split_array(json);
    elements.reserve(objects.size());

    for (const auto& obj : objects) {
        elements.push_back(parse_gp_object(obj));
        if (has_error()) return {};
    }

    return elements;
}

// ============================================================================
// CSV Parsing
// ============================================================================

static std::vector<std::string> split_csv_line(const std::string& line) {
    std::vector<std::string> fields;
    std::string current;
    bool in_quotes = false;

    for (char c : line) {
        if (c == '"') { in_quotes = !in_quotes; continue; }
        if (c == ',' && !in_quotes) {
            fields.push_back(trim(current));
            current.clear();
            continue;
        }
        current += c;
    }
    fields.push_back(trim(current));
    return fields;
}

std::vector<GPElement> parse_gp_csv(const std::string& csv) {
    std::vector<GPElement> elements;
    std::istringstream stream(csv);
    std::string line;

    // Read header
    if (!std::getline(stream, line)) return elements;
    auto header = split_csv_line(line);

    // Map header names to indices
    auto col = [&header](const std::string& name) -> int {
        for (int i = 0; i < (int)header.size(); i++) {
            if (header[i] == name) return i;
        }
        return -1;
    };

    int i_name = col("OBJECT_NAME");
    int i_id = col("OBJECT_ID");
    int i_epoch = col("EPOCH");
    int i_mm = col("MEAN_MOTION");
    int i_ecc = col("ECCENTRICITY");
    int i_inc = col("INCLINATION");
    int i_raan = col("RA_OF_ASC_NODE");
    int i_aop = col("ARG_OF_PERICENTER");
    int i_ma = col("MEAN_ANOMALY");
    int i_etype = col("EPHEMERIS_TYPE");
    int i_class = col("CLASSIFICATION_TYPE");
    int i_norad = col("NORAD_CAT_ID");
    int i_elset = col("ELEMENT_SET_NO");
    int i_rev = col("REV_AT_EPOCH");
    int i_bstar = col("BSTAR");
    int i_mmdot = col("MEAN_MOTION_DOT");
    int i_mmddot = col("MEAN_MOTION_DDOT");

    while (std::getline(stream, line)) {
        // Trim CR
        while (!line.empty() && (line.back() == '\r' || line.back() == '\n'))
            line.pop_back();
        if (line.empty()) continue;

        auto fields = split_csv_line(line);

        {
            GPElement gp;
            auto safe_get = [&fields](int idx) -> std::string {
                return (idx >= 0 && idx < (int)fields.size()) ? fields[idx] : "";
            };
            auto safe_dbl = [&fields](int idx, double def = 0.0) -> double {
                if (idx < 0 || idx >= (int)fields.size() || fields[idx].empty()) return def;
                char* end = nullptr;
                errno = 0;
                const double value = std::strtod(fields[idx].c_str(), &end);
                if (end == fields[idx].c_str() || *end != '\0' || errno == ERANGE || !std::isfinite(value)) {
                    set_error("Invalid GP CSV numeric field");
                    return def;
                }
                return value;
            };
            auto safe_int = [&fields](int idx, int def = 0) -> int {
                if (idx < 0 || idx >= (int)fields.size() || fields[idx].empty()) return def;
                char* end = nullptr;
                errno = 0;
                const long value = std::strtol(fields[idx].c_str(), &end, 10);
                if (end == fields[idx].c_str() || *end != '\0' || errno == ERANGE || value < std::numeric_limits<int>::min() || value > std::numeric_limits<int>::max()) {
                    set_error("Invalid GP CSV integer field");
                    return def;
                }
                return static_cast<int>(value);
            };

            gp.object_name = safe_get(i_name);
            gp.object_id = safe_get(i_id);
            gp.epoch_iso = safe_get(i_epoch);
            gp.mean_motion = safe_dbl(i_mm);
            gp.eccentricity = safe_dbl(i_ecc);
            gp.inclination = safe_dbl(i_inc);
            gp.ra_of_asc_node = safe_dbl(i_raan);
            gp.arg_of_pericenter = safe_dbl(i_aop);
            gp.mean_anomaly = safe_dbl(i_ma);
            gp.ephemeris_type = safe_int(i_etype);
            gp.norad_cat_id = safe_int(i_norad);
            gp.element_set_no = safe_int(i_elset);
            gp.rev_at_epoch = safe_int(i_rev);
            gp.bstar = safe_dbl(i_bstar);
            gp.mean_motion_dot = safe_dbl(i_mmdot);
            gp.mean_motion_ddot = safe_dbl(i_mmddot);

            auto cls = safe_get(i_class);
            gp.classification_type = cls.empty() ? 'U' : cls[0];

            gp.epoch_jd = iso_epoch_to_jd(gp.epoch_iso);
            compute_derived(gp);

            if (has_error()) return {};
            elements.push_back(gp);
        }
    }

    return elements;
}

// ============================================================================
// Derived Parameters
// ============================================================================

void compute_derived(GPElement& gp) {
    if (gp.mean_motion <= 0) return;

    // Semi-major axis from mean motion
    // n (rad/s) = mean_motion (rev/day) * 2π / 86400
    double n_rad_s = gp.mean_motion * TWOPI / SEC_PER_DAY;
    // a = (μ / n²)^(1/3)
    gp.semi_major_axis_km = std::cbrt(MU_KM3S2 / (n_rad_s * n_rad_s));

    // Perigee and apogee altitudes
    gp.perigee_km = gp.semi_major_axis_km * (1.0 - gp.eccentricity) - RE_KM;
    gp.apogee_km = gp.semi_major_axis_km * (1.0 + gp.eccentricity) - RE_KM;
}

// ============================================================================
// GP record to SGP4 element set
// ============================================================================

TLE gp_to_tle(const GPElement& gp) {
    TLE tle;
    tle.name = gp.object_name;
    tle.object_id = gp.object_id;
    tle.epoch_iso = gp.epoch_iso;
    tle.norad_cat_id = gp.norad_cat_id;
    tle.epoch_jd = gp.epoch_jd;
    tle.bstar = gp.bstar;
    tle.inclination = gp.inclination;
    tle.raan = gp.ra_of_asc_node;
    tle.eccentricity = gp.eccentricity;
    tle.arg_perigee = gp.arg_of_pericenter;
    tle.mean_anomaly = gp.mean_anomaly;
    tle.mean_motion = gp.mean_motion;
    tle.mean_motion_dot = gp.mean_motion_dot;
    tle.mean_motion_ddot = gp.mean_motion_ddot;
    tle.ephemeris_type = gp.ephemeris_type;
    tle.classification_type = gp.classification_type;
    tle.element_set_no = gp.element_set_no;
    tle.rev_at_epoch = gp.rev_at_epoch;
    // The values as published, with no TLE text in between (TLE columns would
    // round B* to five digits and e to seven decimals), and the epoch split
    // exactly from its text.
    split_utc_epoch(gp.epoch_iso, tle.epoch_jd_whole, tle.epoch_jd_frac);
    return tle;
}

} // namespace conjunction
