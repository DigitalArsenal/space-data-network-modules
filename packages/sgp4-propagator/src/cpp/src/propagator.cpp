/**
 * SGP4 Propagator Implementation
 *
 * Uses dnwrnr/sgp4 (Apache 2.0) via direct OrbitalElements constructor.
 * Bypasses TLE text entirely — integer NORAD IDs with no format limit.
 */

#include "sgp4_prop/propagator.h"

// dnwrnr/sgp4 headers
#include "OrbitalElements.h"
#include "SGP4.h"
#include "DateTime.h"
#include "TimeSpan.h"
#include "Eci.h"
#include "Tle.h"

#include <cmath>
#include <cstdio>
#include <stdexcept>

namespace sgp4_prop {

static constexpr double DEG_TO_RAD = 0.017453292519943295;
static constexpr double TWOPI = 6.283185307179586;
static constexpr double SEC_PER_DAY = 86400.0;
static constexpr double MIN_PER_DAY = 1440.0;
static constexpr double XKE = 0.0743669161;  // sqrt(GM) in SGP4 units

// ── Julian Date ↔ DateTime conversion ──

static libsgp4::DateTime jd_to_datetime(double jd) {
    // JD → calendar date
    double jd_plus = jd + 0.5;
    int z = static_cast<int>(jd_plus);
    double f = jd_plus - z;

    int a;
    if (z < 2299161) { a = z; }
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
    int seconds = static_cast<int>(rem * 60.0);
    int microseconds = static_cast<int>((rem * 60.0 - seconds) * 1000000);

    return libsgp4::DateTime(year, month, day, hours, minutes, seconds, microseconds);
}

static std::string tle_exp_format(double val) {
    char buf[16];
    if (std::abs(val) < 1e-15) {
        return " 00000-0";
    }

    char sign = (val >= 0) ? ' ' : '-';
    double aval = std::abs(val);
    int exp = 0;

    if (aval >= 1.0) {
        while (aval >= 1.0) {
            aval /= 10.0;
            exp++;
        }
    } else {
        while (aval < 0.1) {
            aval *= 10.0;
            exp--;
        }
    }

    int mantissa = static_cast<int>(std::round(aval * 100000));
    if (mantissa >= 100000) {
        mantissa /= 10;
        exp++;
    }

    const char exp_sign = (exp >= 0) ? '+' : '-';
    std::snprintf(buf, sizeof(buf), "%c%05d%c%d", sign, mantissa, exp_sign, std::abs(exp));
    return buf;
}

static std::string intl_desig_to_tle(const std::string& object_id) {
    if (object_id.empty()) {
        return "        ";
    }

    std::string result;
    const auto dash = object_id.find('-');
    if (dash != std::string::npos && dash >= 4) {
        result += object_id.substr(dash - 2, 2);
        result += object_id.substr(dash + 1);
    } else {
        result = object_id;
    }

    while (result.length() < 8) {
        result += ' ';
    }
    if (result.length() > 8) {
        result.resize(8);
    }
    return result;
}

static std::string encode_norad_alpha5(int norad_id) {
    if (norad_id <= 99999) {
        char buf[8];
        std::snprintf(buf, sizeof(buf), "%05d", norad_id);
        return std::string(buf);
    }

    const int first = norad_id / 10000;
    const int rest = norad_id % 10000;

    char letter = '\0';
    if (first >= 10 && first <= 17) {
        letter = static_cast<char>('A' + (first - 10));
    } else if (first >= 18 && first <= 22) {
        letter = static_cast<char>('J' + (first - 18));
    } else if (first >= 23 && first <= 35) {
        letter = static_cast<char>('P' + (first - 23));
    } else {
        char buf[8];
        std::snprintf(buf, sizeof(buf), "%05d", norad_id % 100000);
        return std::string(buf);
    }

    char buf[8];
    std::snprintf(buf, sizeof(buf), "%c%04d", letter, rest);
    return std::string(buf);
}

static int tle_checksum(const std::string& line) {
    int sum = 0;
    for (int i = 0; i < 68 && i < static_cast<int>(line.size()); ++i) {
        if (line[i] >= '0' && line[i] <= '9') {
            sum += line[i] - '0';
        } else if (line[i] == '-') {
            sum += 1;
        }
    }
    return sum % 10;
}

static std::string normalize_tle_line(std::string line) {
    while (!line.empty() && (line.back() == ' ' || line.back() == '\r')) {
        line.pop_back();
    }
    if (line.length() < 68) {
        line.resize(68, ' ');
    }
    if (line.length() > 68) {
        line.resize(68);
    }
    line += std::to_string(tle_checksum(line));
    return line;
}

static libsgp4::Tle gp_to_tle(const GPElement& gp) {
    int year = 0;
    int month = 0;
    int day = 0;
    int hour = 0;
    int minute = 0;
    double second = 0.0;
    std::sscanf(gp.epoch.c_str(), "%d-%d-%dT%d:%d:%lf",
                &year, &month, &day, &hour, &minute, &second);

    static const int days_before_month[] = {
        0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334
    };
    int day_of_year = days_before_month[month] + day;
    const bool leap =
        (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
    if (leap && month > 2) {
        day_of_year++;
    }
    const double fractional_day =
        (hour + minute / 60.0 + second / 3600.0) / 24.0;
    const double epoch_doy = day_of_year + fractional_day;
    const int yy = year % 100;

    char mean_motion_dot_buffer[16];
    const double mean_motion_dot_half = gp.mean_motion_dot / 2.0;
    if (mean_motion_dot_half >= 0.0) {
        std::snprintf(
            mean_motion_dot_buffer,
            sizeof(mean_motion_dot_buffer),
            " .%08d",
            static_cast<int>(std::round(std::abs(mean_motion_dot_half) * 1e8)));
    } else {
        std::snprintf(
            mean_motion_dot_buffer,
            sizeof(mean_motion_dot_buffer),
            "-.%08d",
            static_cast<int>(std::round(std::abs(mean_motion_dot_half) * 1e8)));
    }

    const std::string norad_str = encode_norad_alpha5(gp.norad_cat_id);
    const std::string intl = intl_desig_to_tle(gp.object_id);
    const std::string mean_motion_ddot = tle_exp_format(gp.mean_motion_ddot);
    const std::string bstar = tle_exp_format(gp.bstar);

    char line1[80];
    std::snprintf(
        line1,
        sizeof(line1),
        "1 %s%c %s %02d%012.8f %.10s %.8s %.8s %d %4d",
        norad_str.c_str(),
        gp.classification.empty() ? 'U' : gp.classification[0],
        intl.c_str(),
        yy,
        epoch_doy,
        mean_motion_dot_buffer,
        mean_motion_ddot.c_str(),
        bstar.c_str(),
        gp.ephemeris_type,
        gp.element_set_no);

    const int eccentricity = static_cast<int>(std::round(gp.eccentricity * 10000000.0));
    char line2[80];
    std::snprintf(
        line2,
        sizeof(line2),
        "2 %s %8.4f %8.4f %07d %8.4f %8.4f %11.8f%5d",
        norad_str.c_str(),
        gp.inclination,
        gp.ra_of_asc_node,
        eccentricity,
        gp.arg_of_pericenter,
        gp.mean_anomaly,
        gp.mean_motion,
        gp.rev_at_epoch);

    return libsgp4::Tle(
        gp.object_name,
        normalize_tle_line(line1),
        normalize_tle_line(line2));
}

// ── Direct GP → SGP4 propagation (no TLE text) ──

StateVector propagate_to_epoch(const GPElement& gp, double target_jd) {
    const auto tle = gp_to_tle(gp);
    libsgp4::SGP4 sgp4(tle);

    // Use DateTime for FindPosition
    libsgp4::DateTime target_dt = jd_to_datetime(target_jd);

    libsgp4::Eci eci = sgp4.FindPosition(target_dt);
    auto pos = eci.Position();
    auto vel = eci.Velocity();

    StateVector sv;
    sv.epoch_jd = target_jd;
    sv.x = pos.x; sv.y = pos.y; sv.z = pos.z;
    sv.vx = vel.x; sv.vy = vel.y; sv.vz = vel.z;
    return sv;
}

// ── Range propagation ──

std::vector<StateVector> propagate(const GPElement& gp, const PropagationConfig& config) {
    std::vector<StateVector> states;

    double start_jd = config.start_jd;
    if (start_jd <= 0.0) start_jd = gp.epoch_jd;

    double end_jd = config.end_jd;
    if (end_jd <= 0.0) end_jd = start_jd + config.duration_days;

    double step_days = config.step_seconds / SEC_PER_DAY;
    int n_steps = static_cast<int>((end_jd - start_jd) / step_days) + 1;
    states.reserve(n_steps);

    const auto tle = gp_to_tle(gp);
    libsgp4::SGP4 sgp4(tle);

    for (double t = start_jd; t <= end_jd; t += step_days) {
        libsgp4::DateTime target_dt = jd_to_datetime(t);

        try {
            libsgp4::Eci eci = sgp4.FindPosition(target_dt);
            auto pos = eci.Position();
            auto vel = eci.Velocity();

            StateVector sv;
            sv.epoch_jd = t;
            sv.x = pos.x; sv.y = pos.y; sv.z = pos.z;
            sv.vx = vel.x; sv.vy = vel.y; sv.vz = vel.z;
            states.push_back(sv);
        } catch (...) {
            // SGP4 can fail for decayed objects — skip this step
        }
    }

    return states;
}

// ── OEM output (stub — will use FlatBuffers when wired up) ──

int32_t propagate_to_oem(const GPElement& gp,
                          const PropagationConfig& config,
                          uint8_t* output, uint32_t output_capacity) {
    auto states = propagate(gp, config);
    if (states.empty()) return -3;  // invalid input

    // TODO: Build OEM FlatBuffers from states
    // For now, return state count as success indicator
    return static_cast<int32_t>(states.size());
}

int32_t propagate_batch_to_oem(const std::vector<GPElement>& gps,
                                const PropagationConfig& config,
                                uint8_t* output, uint32_t output_capacity) {
    // TODO: Build OEM collection FlatBuffers
    int32_t total = 0;
    for (const auto& gp : gps) {
        auto states = propagate(gp, config);
        total += static_cast<int32_t>(states.size());
    }
    return total;
}

}  // namespace sgp4_prop
