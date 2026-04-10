/**
 * GP JSON/CSV Parser — Standalone for SGP4 Propagator Plugin
 *
 * Minimal parser for CelesTrak GP JSON/CSV format.
 * No external JSON dependencies (nlohmann/json forbidden in SDN plugins).
 *
 * Ported from conjunction-assessment-sdn-plugin with cleanup.
 */

#include "sgp4_prop/propagator.h"
#include <cmath>
#include <sstream>
#include <algorithm>
#include <cstring>

namespace sgp4_prop {

static constexpr double RE_KM = 6378.137;
static constexpr double MU_KM3S2 = 398600.4418;
static constexpr double TWOPI = 6.283185307179586;
static constexpr double SEC_PER_DAY = 86400.0;

// ── Minimal JSON helpers ──

static std::string trim(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n");
    if (a == std::string::npos) return "";
    size_t b = s.find_last_not_of(" \t\r\n");
    return s.substr(a, b - a + 1);
}

static std::string json_string(const std::string& obj, const std::string& key) {
    std::string search = "\"" + key + "\"";
    auto pos = obj.find(search);
    if (pos == std::string::npos) return "";
    pos = obj.find(':', pos + search.size());
    if (pos == std::string::npos) return "";
    pos = obj.find('"', pos + 1);
    if (pos == std::string::npos) return "";
    auto end = obj.find('"', pos + 1);
    if (end == std::string::npos) return "";
    return obj.substr(pos + 1, end - pos - 1);
}

static double json_number(const std::string& obj, const std::string& key, double def = 0.0) {
    std::string search = "\"" + key + "\"";
    auto pos = obj.find(search);
    if (pos == std::string::npos) return def;
    pos = obj.find(':', pos + search.size());
    if (pos == std::string::npos) return def;
    pos++;
    while (pos < obj.size() && (obj[pos] == ' ' || obj[pos] == '\t')) pos++;
    if (pos + 3 < obj.size() && obj.substr(pos, 4) == "null") return def;
    std::string numstr;
    while (pos < obj.size() && (std::isdigit(obj[pos]) || obj[pos] == '.' ||
           obj[pos] == '-' || obj[pos] == '+' || obj[pos] == 'e' || obj[pos] == 'E')) {
        numstr += obj[pos++];
    }
    if (numstr.empty()) return def;
    try { return std::stod(numstr); } catch (...) { return def; }
}

static int json_int(const std::string& obj, const std::string& key, int def = 0) {
    return static_cast<int>(json_number(obj, key, def));
}

static std::vector<std::string> json_split_array(const std::string& json) {
    std::vector<std::string> objects;
    int depth = 0;
    size_t obj_start = 0;
    bool in_obj = false;
    for (size_t i = 0; i < json.size(); i++) {
        if (json[i] == '{') {
            if (depth == 0) { obj_start = i; in_obj = true; }
            depth++;
        } else if (json[i] == '}') {
            depth--;
            if (depth == 0 && in_obj) {
                objects.push_back(json.substr(obj_start, i - obj_start + 1));
                in_obj = false;
            }
        }
    }
    return objects;
}

// ── Epoch conversion ──

double epoch_to_jd(const std::string& iso) {
    if (iso.empty()) return 0.0;
    int year = 0, month = 0, day = 0, hour = 0, minute = 0;
    double second = 0.0;
    if (sscanf(iso.c_str(), "%d-%d-%dT%d:%d:%lf",
               &year, &month, &day, &hour, &minute, &second) < 3) {
        return 0.0;
    }
    int a = (14 - month) / 12;
    int y = year + 4800 - a;
    int m = month + 12 * a - 3;
    double jd = day + (153 * m + 2) / 5 + 365 * y + y / 4 - y / 100 + y / 400 - 32045;
    return jd - 0.5 + (hour + minute / 60.0 + second / 3600.0) / 24.0;
}

// ── Derived parameters ──

static void compute_derived(GPElement& gp) {
    if (gp.mean_motion <= 0) return;
    double n_rad_s = gp.mean_motion * TWOPI / SEC_PER_DAY;
    // Semi-major axis not stored in GPElement to keep it lightweight
    // but we compute epoch JD
}

// ── Parse GP JSON ──

static GPElement parse_gp_object(const std::string& obj) {
    GPElement gp;
    gp.object_name = json_string(obj, "OBJECT_NAME");
    gp.object_id = json_string(obj, "OBJECT_ID");
    gp.epoch = json_string(obj, "EPOCH");
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

    auto cls = json_string(obj, "CLASSIFICATION_TYPE");
    gp.classification = cls.empty() ? "U" : cls;

    gp.epoch_jd = epoch_to_jd(gp.epoch);
    return gp;
}

std::vector<GPElement> parse_gp_json(const std::string& json) {
    std::vector<GPElement> elements;
    auto objects = json_split_array(json);
    elements.reserve(objects.size());
    for (const auto& obj : objects) {
        try {
            elements.push_back(parse_gp_object(obj));
        } catch (...) {}
    }
    return elements;
}

}  // namespace sgp4_prop
