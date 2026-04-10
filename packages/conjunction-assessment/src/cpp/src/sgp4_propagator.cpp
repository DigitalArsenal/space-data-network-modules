/**
 * SGP4 Propagator — Implementation
 *
 * Wraps the libsgp4 library (in deps/sgp4/) to provide TLE parsing
 * and SGP4/SDP4 orbit propagation.
 *
 * The SGP4 model is the standard NORAD/USSPACECOM analytical theory
 * for Earth-orbiting objects. It models secular and periodic perturbations
 * from Earth's oblateness (J2, J3, J4), atmospheric drag (via B*),
 * and lunar/solar gravity.
 *
 * SGP4 is used for objects with periods < 225 minutes (LEO/MEO).
 * SDP4 is used for objects with periods ≥ 225 minutes (HEO/GEO),
 * adding deep-space resonance and lunar/solar terms.
 *
 * The output is in the TEME (True Equator Mean Equinox) reference frame,
 * which is the native frame of the SGP4 theory. For conjunction screening,
 * TEME positions are sufficient since both objects use the same frame.
 *
 * References:
 *   - Vallado, Crawford, Hujsak, Kelso (2006), "Revisiting Spacetrack Report #3"
 *     AIAA 2006-6753, the authoritative modern SGP4 reference
 *   - Hoots & Roehrich (1980), "Spacetrack Report No. 3" (original SGP4 derivation)
 *   - Kelso, T.S., CelesTrak: celestrak.org (TLE/GP data source)
 *   - libsgp4: github.com/dnwrnr/sgp4 (C++ implementation)
 */

#include "conjunction/sgp4_propagator.h"
#include "conjunction/gp_json.h"

/* libsgp4 headers from deps/sgp4/ */
#include "libsgp4/Tle.h"
#include "libsgp4/SGP4.h"
#include "libsgp4/Eci.h"
#include "libsgp4/DateTime.h"
#include "libsgp4/TimeSpan.h"
#include "libsgp4/Globals.h"
#include "libsgp4/OrbitalElements.h"

#include <cmath>
#include <cctype>
#include <cstring>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <algorithm>
#include <iomanip>

namespace conjunction {

/* ── Constants ── */

static constexpr double JD_UNIX_EPOCH = 2440587.5;     /* JD at 1970-01-01T00:00:00Z */
static constexpr double JD_J2000      = 2451545.0;     /* JD at 2000-01-01T12:00:00 TDB */
static constexpr double MJD_OFFSET    = 2400000.5;     /* JD = MJD + 2400000.5 */
static constexpr double SEC_PER_DAY   = 86400.0;
static constexpr double MIN_PER_DAY   = 1440.0;
static constexpr double TWO_PI        = 2.0 * M_PI;
static constexpr double DEG2RAD       = M_PI / 180.0;
static constexpr double EARTH_RADIUS_KM = 6378.137;

static void set_invalid_state(StateVector& state) {
    const double nan = std::numeric_limits<double>::quiet_NaN();
    state.x = state.y = state.z = nan;
    state.vx = state.vy = state.vz = nan;
}

static std::string encode_norad_alpha5(int cat_id) {
    if (cat_id <= 99999) {
        char buf[8];
        snprintf(buf, sizeof(buf), "%05d", cat_id);
        return std::string(buf);
    }

    const int first = cat_id / 10000;
    const int rest = cat_id % 10000;
    char alpha = '\0';
    if (first >= 10 && first <= 17) {
        alpha = static_cast<char>('A' + (first - 10));
    } else if (first >= 18 && first <= 22) {
        alpha = static_cast<char>('J' + (first - 18));
    } else if (first >= 23 && first <= 35) {
        alpha = static_cast<char>('P' + (first - 23));
    } else {
        char buf[8];
        snprintf(buf, sizeof(buf), "%05d", cat_id % 100000);
        return std::string(buf);
    }

    char buf[8];
    snprintf(buf, sizeof(buf), "%c%04d", alpha, rest);
    return std::string(buf);
}

static int decode_norad_alpha5(const std::string& cat_id) {
    if (cat_id.empty()) {
        return 0;
    }

    const unsigned char first = static_cast<unsigned char>(cat_id[0]);
    if (std::isdigit(first)) {
        return std::stoi(cat_id);
    }

    const char alpha = static_cast<char>(std::toupper(first));
    int prefix = 0;
    if (alpha >= 'A' && alpha <= 'H') {
        prefix = 10 + (alpha - 'A');
    } else if (alpha >= 'J' && alpha <= 'N') {
        prefix = 18 + (alpha - 'J');
    } else if (alpha >= 'P' && alpha <= 'Z') {
        prefix = 23 + (alpha - 'P');
    } else {
        throw std::invalid_argument("Invalid Alpha-5 NORAD prefix");
    }

    for (size_t index = 1; index < cat_id.size(); ++index) {
        if (!std::isdigit(static_cast<unsigned char>(cat_id[index]))) {
            throw std::invalid_argument("Invalid Alpha-5 NORAD suffix");
        }
    }

    return prefix * 10000 + std::stoi(cat_id.substr(1));
}

/* ── TLE Parsing ──────────────────────────────────────────────────────── */

/**
 * Parse a TLE from the standard 3-line format.
 *
 * Line 1 format (Vallado 2006, Table 1):
 *   Col 01:    Line number (1)
 *   Col 03-07: NORAD catalog number
 *   Col 08:    Classification (U/C/S)
 *   Col 10-17: International designator
 *   Col 19-32: Epoch (yyddd.dddddddd)
 *   Col 34-43: First derivative of mean motion (rev/day²/2)
 *   Col 45-52: Second derivative of mean motion (rev/day³/6)
 *   Col 54-61: B* drag term (1/Earth radii)
 *   Col 63:    Ephemeris type
 *   Col 65-68: Element set number
 *   Col 69:    Checksum
 *
 * Line 2 format:
 *   Col 01:    Line number (2)
 *   Col 03-07: NORAD catalog number
 *   Col 09-16: Inclination (degrees)
 *   Col 18-25: RAAN (degrees)
 *   Col 27-33: Eccentricity (leading decimal assumed)
 *   Col 35-42: Argument of perigee (degrees)
 *   Col 44-51: Mean anomaly (degrees)
 *   Col 53-63: Mean motion (rev/day)
 *   Col 64-68: Revolution number at epoch
 */
TLE parse_tle(const std::string& name, const std::string& line1, const std::string& line2) {
    TLE tle;
    tle.name = name;
    tle.line1 = line1;
    tle.line2 = line2;

    /* Trim whitespace from name */
    size_t start = tle.name.find_first_not_of(" \t\r\n");
    size_t end = tle.name.find_last_not_of(" \t\r\n");
    if (start != std::string::npos && end != std::string::npos)
        tle.name = tle.name.substr(start, end - start + 1);

    /* Parse Line 1 */
    if (line1.size() >= 68) {
        tle.norad_cat_id = decode_norad_alpha5(line1.substr(2, 5));

        /* Epoch: yyddd.dddddddd */
        std::string epoch_str = line1.substr(18, 14);
        int epoch_year = std::stoi(epoch_str.substr(0, 2));
        double epoch_day = std::stod(epoch_str.substr(2));

        /* Two-digit year: 57-99 → 1957-1999, 00-56 → 2000-2056 */
        int full_year = (epoch_year >= 57) ? (1900 + epoch_year) : (2000 + epoch_year);
        tle.epoch_jd = epoch_to_jd(full_year, epoch_day);

        /* B* drag term */
        std::string bstar_str = line1.substr(53, 8);
        /* Format: ±NNNNN±N where mantissa has implied decimal point */
        double mantissa = 0, exponent = 0;
        if (bstar_str.size() >= 8) {
            /* Remove spaces, parse mantissa and exponent */
            std::string m_str = bstar_str.substr(0, 6);
            /* Insert decimal point: +NNNNN → +0.NNNNN */
            char sign = (m_str[0] == '-') ? '-' : '+';
            std::string digits;
            for (char c : m_str) {
                if (c >= '0' && c <= '9') digits += c;
            }
            if (!digits.empty()) {
                mantissa = std::stod(std::string("0.") + digits);
                if (sign == '-') mantissa = -mantissa;
            }
            /* Exponent */
            char exp_char = bstar_str[6];
            int exp_sign = (exp_char == '-') ? -1 : 1;
            int exp_val = bstar_str[7] - '0';
            exponent = exp_sign * exp_val;
            tle.bstar = mantissa * std::pow(10.0, exponent);
        }
    }

    /* Parse Line 2 */
    if (line2.size() >= 68) {
        tle.inclination   = std::stod(line2.substr(8, 8));
        tle.raan          = std::stod(line2.substr(17, 8));

        /* Eccentricity: leading "0." assumed */
        std::string ecc_str = "0." + line2.substr(26, 7);
        tle.eccentricity = std::stod(ecc_str);

        tle.arg_perigee   = std::stod(line2.substr(34, 8));
        tle.mean_anomaly  = std::stod(line2.substr(43, 8));
        tle.mean_motion   = std::stod(line2.substr(52, 11));
    }

    return tle;
}

/**
 * Parse all TLEs from a multi-line string (3-line format).
 */
std::vector<TLE> parse_tle_file(const std::string& data) {
    std::vector<TLE> tles;
    std::istringstream iss(data);
    std::string line;
    std::vector<std::string> lines;

    while (std::getline(iss, line)) {
        /* Strip trailing \r */
        if (!line.empty() && line.back() == '\r')
            line.pop_back();
        if (!line.empty())
            lines.push_back(line);
    }

    /* Process in groups of 3 (name + line1 + line2) */
    for (size_t i = 0; i + 2 < lines.size(); ) {
        if (lines[i + 1].size() >= 2 && lines[i + 1][0] == '1' &&
            lines[i + 2].size() >= 2 && lines[i + 2][0] == '2') {
            tles.push_back(parse_tle(lines[i], lines[i + 1], lines[i + 2]));
            i += 3;
        } else if (lines[i].size() >= 2 && lines[i][0] == '1' &&
                   lines[i + 1].size() >= 2 && lines[i + 1][0] == '2') {
            /* 2-line format (no name) */
            tles.push_back(parse_tle("", lines[i], lines[i + 1]));
            i += 2;
        } else {
            i++;  /* Skip unrecognized line */
        }
    }

    return tles;
}

/* ── SGP4 Propagation ─────────────────────────────────────────────── */

/**
 * Propagate a TLE to a target Julian Date using the SGP4/SDP4 model.
 *
 * Uses the libsgp4 library which implements the Vallado et al. (2006)
 * corrected SGP4 model. The library automatically selects between
 * SGP4 (near-Earth, period < 225 min) and SDP4 (deep-space) based
 * on the orbital period.
 *
 * Output is in the TEME reference frame, which is the native frame
 * of the SGP4 theory. TEME is a pseudo-inertial frame based on the
 * true equator and mean equinox of date.
 *
 * @param tle       Parsed TLE
 * @param target_jd Target epoch (Julian Date, UTC)
 * @return State vector in TEME (km, km/s)
 */
StateVector propagate_sgp4(const TLE& tle, double target_jd) {
    StateVector sv;
    sv.epoch_jd = target_jd;
    set_invalid_state(sv);

    try {
        /* Construct libsgp4 TLE object */
        libsgp4::Tle sgp4_tle(tle.name, tle.line1, tle.line2);
        libsgp4::SGP4 sgp4(sgp4_tle);

        /* Compute elapsed time in minutes from TLE epoch */
        /* libsgp4 DateTime uses ticks (100ns units since 0001-01-01) */
        /* Convert target JD to DateTime */
        double days_since_epoch = target_jd - tle.epoch_jd;
        double minutes = days_since_epoch * MIN_PER_DAY;

        /* Propagate using libsgp4 */
        libsgp4::Eci eci = sgp4.FindPosition(minutes);

        /* Extract position (km) and velocity (km/s) in TEME */
        sv.x  = eci.Position().x;
        sv.y  = eci.Position().y;
        sv.z  = eci.Position().z;
        sv.vx = eci.Velocity().x;
        sv.vy = eci.Velocity().y;
        sv.vz = eci.Velocity().z;

        const double radius_km =
            std::sqrt(sv.x * sv.x + sv.y * sv.y + sv.z * sv.z);
        if (!std::isfinite(radius_km) || radius_km < EARTH_RADIUS_KM) {
            set_invalid_state(sv);
        }

    } catch (const std::exception& e) {
        /* Propagation failure (e.g., decayed orbit, bad TLE).
         * Mark the state invalid so higher-level screening can skip it. */
        set_invalid_state(sv);
    }

    return sv;
}

/**
 * Propagate from GP/OMM elements (no TLE text intermediary).
 *
 * Constructs a synthetic TLE from GP elements and propagates.
 * This supports NORAD catalog IDs beyond the 5-digit TLE limit
 * (important for the growing catalog post-2024).
 *
 * @param gp        GP element set
 * @param target_jd Target epoch (Julian Date, UTC)
 * @return State vector in TEME (km, km/s)
 */
StateVector propagate_sgp4_gp(const GPElement& gp, double target_jd) {
    /* Construct TLE from GP elements.
     * Format Line 1 and Line 2 per Vallado standard format.
     * For catalog IDs > 99999, we use a 5-digit alpha encoding
     * (CelesTrak convention: A0000-H9999 for 100000-179999). */

    const std::string cat_str = encode_norad_alpha5(gp.norad_cat_id);

    /* Compute epoch in TLE format (yyddd.dddddddd) */
    /* Convert epoch_jd to year + fractional day */
    double jd = gp.epoch_jd;
    if (jd < 1.0 && !gp.epoch_iso.empty()) {
        jd = iso_to_jd(gp.epoch_iso);
    }

    /* JD → calendar date */
    double Z = std::floor(jd + 0.5);
    double F = (jd + 0.5) - Z;
    double A;
    if (Z < 2299161) {
        A = Z;
    } else {
        double alpha = std::floor((Z - 1867216.25) / 36524.25);
        A = Z + 1 + alpha - std::floor(alpha / 4.0);
    }
    double B = A + 1524;
    double C = std::floor((B - 122.1) / 365.25);
    double D = std::floor(365.25 * C);
    double E = std::floor((B - D) / 30.6001);

    int day = (int)(B - D - std::floor(30.6001 * E));
    int month = (E < 14) ? (int)(E - 1) : (int)(E - 13);
    int year = (month > 2) ? (int)(C - 4716) : (int)(C - 4715);

    /* Day of year */
    int doy_base;
    bool leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
    int month_days[] = {0, 31, 28 + leap, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    doy_base = day;
    for (int m = 1; m < month; m++) doy_base += month_days[m];
    double doy = doy_base + F;

    int yy = year % 100;

    /* Format B* with implied decimal */
    double bstar = gp.bstar;
    int bstar_exp = 0;
    double bstar_mantissa = bstar;
    if (std::abs(bstar_mantissa) > 1e-20) {
        while (std::abs(bstar_mantissa) < 0.1) {
            bstar_mantissa *= 10.0;
            bstar_exp--;
        }
        while (std::abs(bstar_mantissa) >= 1.0) {
            bstar_mantissa /= 10.0;
            bstar_exp++;
        }
    }

    /* Build TLE lines */
    char line1[80], line2[80];
    snprintf(line1, sizeof(line1),
        "1 %5s%c %8s %02d%012.8f  .00000000  00000-0 %+06.0f%+1d 0 %4dX",
        cat_str.c_str(), gp.classification_type,
        gp.object_id.empty() ? "00000A  " : gp.object_id.substr(0, 8).c_str(),
        yy, doy,
        bstar_mantissa * 100000, bstar_exp,
        gp.element_set_no);

    snprintf(line2, sizeof(line2),
        "2 %5s %8.4f %8.4f %07.0f %8.4f %8.4f %11.8f%5dX",
        cat_str.c_str(),
        gp.inclination,
        gp.ra_of_asc_node,
        gp.eccentricity * 1e7,
        gp.arg_of_pericenter,
        gp.mean_anomaly,
        gp.mean_motion,
        gp.rev_at_epoch);

    /* Compute checksums (mod 10 sum of digits, '-' counts as 1) */
    auto checksum = [](const char* line) -> int {
        int sum = 0;
        for (int i = 0; i < 68 && line[i]; i++) {
            char c = line[i];
            if (c >= '0' && c <= '9') sum += (c - '0');
            else if (c == '-') sum += 1;
        }
        return sum % 10;
    };

    line1[68] = '0' + checksum(line1);
    line1[69] = '\0';
    line2[68] = '0' + checksum(line2);
    line2[69] = '\0';

    TLE tle;
    tle.name = gp.object_name;
    tle.line1 = line1;
    tle.line2 = line2;
    tle.norad_cat_id = gp.norad_cat_id;
    tle.epoch_jd = jd;
    tle.bstar = gp.bstar;
    tle.inclination = gp.inclination;
    tle.raan = gp.ra_of_asc_node;
    tle.eccentricity = gp.eccentricity;
    tle.arg_perigee = gp.arg_of_pericenter;
    tle.mean_anomaly = gp.mean_anomaly;
    tle.mean_motion = gp.mean_motion;

    return propagate_sgp4(tle, target_jd);
}

/* ── Time Conversions ─────────────────────────────────────────────── */

/**
 * Convert Julian Date to ISO 8601 string.
 *
 * Uses the standard JD→calendar algorithm from Meeus, "Astronomical Algorithms"
 * (1998), Chapter 7.
 */
std::string jd_to_iso(double jd) {
    double Z = std::floor(jd + 0.5);
    double F = (jd + 0.5) - Z;

    double A;
    if (Z < 2299161) {
        A = Z;
    } else {
        double alpha = std::floor((Z - 1867216.25) / 36524.25);
        A = Z + 1 + alpha - std::floor(alpha / 4.0);
    }

    double B = A + 1524;
    double C = std::floor((B - 122.1) / 365.25);
    double D = std::floor(365.25 * C);
    double E = std::floor((B - D) / 30.6001);

    int day = (int)(B - D - std::floor(30.6001 * E));
    int month = (E < 14) ? (int)(E - 1) : (int)(E - 13);
    int year = (month > 2) ? (int)(C - 4716) : (int)(C - 4715);

    double day_frac = F;
    int hours = (int)(day_frac * 24);
    int minutes = (int)((day_frac * 24 - hours) * 60);
    double seconds = ((day_frac * 24 - hours) * 60 - minutes) * 60;

    char buf[32];
    snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%06.3fZ",
             year, month, day, hours, minutes, seconds);
    return std::string(buf);
}

/**
 * Convert ISO 8601 string to Julian Date.
 *
 * Supports format: YYYY-MM-DDTHH:MM:SS.sssZ
 */
double iso_to_jd(const std::string& iso) {
    int year = 0, month = 0, day = 0, hour = 0, minute = 0;
    double second = 0.0;

    if (iso.size() >= 19) {
        year   = std::stoi(iso.substr(0, 4));
        month  = std::stoi(iso.substr(5, 2));
        day    = std::stoi(iso.substr(8, 2));
        hour   = std::stoi(iso.substr(11, 2));
        minute = std::stoi(iso.substr(14, 2));
        second = std::stod(iso.substr(17));
    }

    /* JD formula from Meeus, "Astronomical Algorithms" (1998), Eq. 7.1 */
    int y = year, m = month;
    if (m <= 2) {
        y--;
        m += 12;
    }

    int A = y / 100;
    int B_val = 2 - A + A / 4;

    double JD = std::floor(365.25 * (y + 4716))
              + std::floor(30.6001 * (m + 1))
              + day + B_val - 1524.5;

    JD += (hour + minute / 60.0 + second / 3600.0) / 24.0;

    return JD;
}

/**
 * Get Julian Date from year and fractional day of year.
 *
 * @param year         Full year (e.g., 2024)
 * @param day_of_year  Fractional day of year (1.0 = Jan 1, 00:00:00)
 * @return Julian Date
 */
double epoch_to_jd(int year, double day_of_year) {
    /* JD of January 0.0 of the given year */
    int y = year - 1;
    double jd_jan0 = std::floor(365.25 * (y + 4716))
                   + std::floor(30.6001 * 14)  /* month = 1 → m = 13, floor(30.6001*14) */
                   + 1 + (2 - y/100 + y/400) - 1524.5;

    /* Actually compute JD of Jan 1.0 properly */
    /* Simpler: use the standard formula for Jan 1 */
    int A = year / 100;
    int B_val = 2 - A + A / 4;
    double jd_jan1 = std::floor(365.25 * (year + 4715))
                   + std::floor(30.6001 * (1 + 13))
                   + 1 + B_val - 1524.5;

    /* Adjust: day_of_year = 1.0 means Jan 1, 00:00:00 */
    return jd_jan1 + (day_of_year - 1.0);
}

} // namespace conjunction
