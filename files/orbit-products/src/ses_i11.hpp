/*
 * The Intelsat eleven-parameter ephemeris (IESS-412), as SES and Intelsat
 * publish it for antenna pointing at geostationary satellites ("I11" files).
 *
 * The parameters describe the satellite's east longitude and geocentric
 * latitude as functions of the days since the element epoch; the radius
 * follows from the longitude drift. The evaluation is the one Orekit 13.1
 * implements (`IntelsatElevenElementsPropagator.propagateInEcef`):
 *
 *   W   = LM1 + 360.98564          deg/day
 *   lon = LM0 + LM1 t + LM2 t^2
 *         + (LONC + LONC1 t) cos(W t) + (LONS + LONS1 t) sin(W t)
 *         + K [ (LATC^2 - LATS^2)/2 sin(2 W t) - LATC LATS cos(2 W t) ]
 *   lat = (LATC + LATC1 t) cos(W t) + (LATS + LATS1 t) sin(W t)
 *   r   = 42164.57 km (1 - 2 LM1 / (3 (W - LM1)))
 *         (1 + K LONC sin(W t) - K LONS cos(W t))
 *
 * with t in days and K = pi/360. Angles are degrees. The position is
 * Earth-fixed: r (cos lat cos lon, cos lat sin lon, sin lat). Velocity is the
 * analytic derivative of that expression, not a difference of positions.
 *
 * The format names no terrestrial frame realization; the projection labels
 * the states FIXED_EARTH. The epoch is read as UTC.
 */
#ifndef ORBIT_PRODUCTS_SES_I11_HPP
#define ORBIT_PRODUCTS_SES_I11_HPP

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace sdn {
namespace i11 {

constexpr double kSynchronousRadiusKm = 42164.57;   // Orekit 13.1 SYNCHRONOUS_RADIUS_KM
constexpr double kK = 0.0087266462;                  // pi/360, as Orekit states it
constexpr double kDriftShiftDegPerDay = 360.98564;   // Orekit 13.1 DRIFT_RATE_SHIFT_DEG_PER_DAY
constexpr double kPi = 3.14159265358979323846;

struct Elements {
    int year = 0, month = 0, day = 0, hour = 0, minute = 0;
    double second = 0;
    double lm0 = 0, lm1 = 0, lm2 = 0;
    double lonc = 0, lonc1 = 0, lons = 0, lons1 = 0;
    double latc = 0, latc1 = 0, lats = 0, lats1 = 0;
    std::string satellite;       // as the file names it ("Astra-2G")
    bool has_check = false;      // the file's printed prediction
    double check_hours = 0, check_lon = 0, check_lat = 0;
    bool has_valid_until = false;
    int vu_year = 0, vu_month = 0, vu_day = 0, vu_hour = 0, vu_minute = 0;
};

struct Sample {
    double lon_deg = 0, lat_deg = 0, radius_m = 0;
    double position[3] = {0, 0, 0};  // m, Earth-fixed
    double velocity[3] = {0, 0, 0};  // m/s, Earth-fixed
};

/* t: seconds since the element epoch. */
inline Sample evaluate(const Elements& e, double t_seconds) {
    const double d = t_seconds / 86400.0, dd = 1.0 / 86400.0;  // days, d(days)/ds
    const double w = e.lm1 + kDriftShiftDegPerDay;               // deg/day
    const double rad = kPi / 180.0;
    const double wt = w * d * rad, dwt = w * dd * rad;           // rad, rad/s
    const double s1 = std::sin(wt), c1 = std::cos(wt), s2 = std::sin(2 * wt), c2 = std::cos(2 * wt);

    const double latTerm = kK * (0.5 * (e.latc * e.latc - e.lats * e.lats) * s2 - e.latc * e.lats * c2);
    const double dlatTerm = kK * (0.5 * (e.latc * e.latc - e.lats * e.lats) * c2 * 2 + e.latc * e.lats * s2 * 2) * dwt;
    const double lon = e.lm0 + e.lm1 * d + e.lm2 * d * d + (e.lonc + e.lonc1 * d) * c1 + (e.lons + e.lons1 * d) * s1 + latTerm;
    const double dlon = (e.lm1 + 2 * e.lm2 * d) * dd + e.lonc1 * dd * c1 - (e.lonc + e.lonc1 * d) * s1 * dwt
                        + e.lons1 * dd * s1 + (e.lons + e.lons1 * d) * c1 * dwt + dlatTerm;  // deg/s
    const double lat = (e.latc + e.latc1 * d) * c1 + (e.lats + e.lats1 * d) * s1;
    const double dlat = e.latc1 * dd * c1 - (e.latc + e.latc1 * d) * s1 * dwt + e.lats1 * dd * s1 + (e.lats + e.lats1 * d) * c1 * dwt;

    const double coefficient = kSynchronousRadiusKm * 1000.0 * (1.0 - (2.0 * e.lm1) / (3.0 * (w - e.lm1)));
    const double r = coefficient * (1.0 + kK * e.lonc * s1 - kK * e.lons * c1);
    const double dr = coefficient * (kK * e.lonc * c1 + kK * e.lons * s1) * dwt;

    Sample out;
    out.lon_deg = lon;
    out.lat_deg = lat;
    out.radius_m = r;
    const double cl = std::cos(lon * rad), sl = std::sin(lon * rad), cp = std::cos(lat * rad), sp = std::sin(lat * rad);
    const double dl = dlon * rad, dp = dlat * rad;
    out.position[0] = r * cp * cl;
    out.position[1] = r * cp * sl;
    out.position[2] = r * sp;
    out.velocity[0] = dr * cp * cl - r * sp * dp * cl - r * cp * sl * dl;
    out.velocity[1] = dr * cp * sl - r * sp * dp * sl + r * cp * cl * dl;
    out.velocity[2] = dr * sp + r * cp * dp;
    return out;
}

/* ---- reading ---- */

inline std::vector<std::string> lines_of(const char* text, size_t length) {
    std::vector<std::string> out;
    std::string cur;
    for (size_t i = 0; i < length; ++i) {
        const char c = text[i];
        if (c == '\n') { out.push_back(cur); cur.clear(); }
        else if (c != '\r') cur.push_back(c);
    }
    if (!cur.empty()) out.push_back(cur);
    return out;
}

/* Every whitespace-separated token of a line that is a complete number. */
inline std::vector<double> numbers_of(const std::string& line, bool* all_numeric) {
    std::vector<double> out;
    bool all = true;
    size_t i = 0;
    while (i < line.size()) {
        while (i < line.size() && (line[i] == ' ' || line[i] == '\t')) ++i;
        if (i >= line.size()) break;
        size_t j = i;
        while (j < line.size() && line[j] != ' ' && line[j] != '\t') ++j;
        const std::string token = line.substr(i, j - i);
        char* end = nullptr;
        const double v = std::strtod(token.c_str(), &end);
        if (end && *end == '\0' && std::isfinite(v)) out.push_back(v);
        else all = false;
        i = j;
    }
    if (all_numeric) *all_numeric = all;
    return out;
}

inline bool starts_with_words(const std::string& line, const char* words) {
    /* Compare ignoring runs of whitespace. */
    std::string a, b(words);
    bool space = false;
    for (char c : line) {
        if (c == ' ' || c == '\t') { space = !a.empty(); continue; }
        if (space) { a.push_back(' '); space = false; }
        a.push_back(c);
    }
    return a.compare(0, b.size(), b) == 0;
}

/* The numeric line after a header line that begins with `head`, skipping the
 * units line between them; it must hold exactly `count` numbers. */
inline bool values_after(const std::vector<std::string>& lines, const char* head, size_t count, std::vector<double>* out) {
    for (size_t i = 0; i < lines.size(); ++i) {
        if (!starts_with_words(lines[i], head)) continue;
        for (size_t j = i + 1; j < lines.size() && j <= i + 3; ++j) {
            bool numeric = false;
            std::vector<double> v = numbers_of(lines[j], &numeric);
            if (numeric && v.size() == count) { *out = v; return true; }
        }
        return false;
    }
    return false;
}

inline int month_number(const char* abbrev) {
    static const char* names[] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
    for (int m = 0; m < 12; ++m) if (std::strncmp(abbrev, names[m], 3) == 0) return m + 1;
    return 0;
}

/* Returns an empty string on success, else why the file is refused. */
inline std::string read(const char* text, size_t length, Elements* out) {
    const std::vector<std::string> lines = lines_of(text, length);
    Elements e;
    std::vector<double> v;
    if (!values_after(lines, "YEAR MONTH DAY HOUR MINUTE SECOND", 6, &v)) return "no epoch line (YEAR MONTH DAY HOUR MINUTE SECOND).";
    e.year = static_cast<int>(v[0]); e.month = static_cast<int>(v[1]); e.day = static_cast<int>(v[2]);
    e.hour = static_cast<int>(v[3]); e.minute = static_cast<int>(v[4]); e.second = v[5];
    if (v[0] != e.year || v[1] != e.month || v[2] != e.day || v[3] != e.hour || v[4] != e.minute ||
        e.month < 1 || e.month > 12 || e.day < 1 || e.day > 31 || e.hour < 0 || e.hour > 23 || e.minute < 0 || e.minute > 59 || e.second < 0 || e.second >= 61)
        return "the epoch is not a calendar date and time.";
    if (!values_after(lines, "LM0 LM1 LM2", 3, &v)) return "no LM0 LM1 LM2 values.";
    e.lm0 = v[0]; e.lm1 = v[1]; e.lm2 = v[2];
    if (!values_after(lines, "LONC LONC1 LONS LONS1", 4, &v)) return "no LONC LONC1 LONS LONS1 values.";
    e.lonc = v[0]; e.lonc1 = v[1]; e.lons = v[2]; e.lons1 = v[3];
    if (!values_after(lines, "LATC LATC1 LATS LATS1", 4, &v)) return "no LATC LATC1 LATS LATS1 values.";
    e.latc = v[0]; e.latc1 = v[1]; e.lats = v[2]; e.lats1 = v[3];

    for (const std::string& l : lines) {
        const size_t f = l.find("EPHEMERIS FOR ");
        if (f != std::string::npos && e.satellite.empty()) {
            std::string name = l.substr(f + 14);
            const size_t slash = name.find(" /");
            if (slash != std::string::npos) name = name.substr(0, slash);
            while (!name.empty() && name.back() == ' ') name.pop_back();
            e.satellite = name;
        }
        const size_t u = l.find("VALID UNTIL ");
        if (u != std::string::npos) {
            int d = 0, y = 0, hh = 0, mm = 0;
            char mon[4] = {0};
            if (std::sscanf(l.c_str() + u + 12, "%d-%3c-%d %d:%d", &d, mon, &y, &hh, &mm) == 5 && month_number(mon)) {
                e.has_valid_until = true;
                e.vu_year = y; e.vu_month = month_number(mon); e.vu_day = d; e.vu_hour = hh; e.vu_minute = mm;
            }
        }
    }
    /* "... AT 170 HOURS AFTER EPOCH ARE 28.1277 DEG. E AND 0.0143 DEG. N" may
     * wrap onto a second line; read the two lines together. */
    for (size_t i = 0; i < lines.size(); ++i) {
        if (lines[i].find("PREDICTED SATELLITE LONGITUDE") == std::string::npos) continue;
        const std::string joined = lines[i] + " " + (i + 1 < lines.size() ? lines[i + 1] : std::string());
        const size_t at = joined.find(" AT ");
        double hours = 0, lon = 0, lat = 0;
        char ew = 0, ns = 0;
        if (at != std::string::npos &&
            std::sscanf(joined.c_str() + at, " AT %lf HOURS AFTER EPOCH ARE %lf DEG. %c AND %lf DEG. %c", &hours, &lon, &ew, &lat, &ns) == 5 &&
            (ew == 'E' || ew == 'W') && (ns == 'N' || ns == 'S')) {
            e.has_check = true;
            e.check_hours = hours;
            e.check_lon = ew == 'E' ? lon : -lon;
            e.check_lat = ns == 'N' ? lat : -lat;
        }
        break;
    }
    *out = e;
    return std::string();
}

/* Difference of two east longitudes, degrees, in (-180, 180]. */
inline double longitude_difference(double a, double b) {
    double d = std::fmod(a - b, 360.0);
    if (d > 180) d -= 360;
    if (d <= -180) d += 360;
    return d;
}

}  // namespace i11
}  // namespace sdn

#endif  // ORBIT_PRODUCTS_SES_I11_HPP
