#include "conjunction/error_status.h"
/**
 * Conjunction Assessment Engine Implementation
 *
 * Uses dnwrnr/sgp4 (Apache 2.0) for TLE parsing + SGP4 propagation.
 * Implements Alfano maximum probability method (AAS 03-548).
 * Validates against CelesTrak SOCRATES Plus.
 */

#include "conjunction/conjunction_assessment.h"
#include "conjunction/ephemeris_source.h"
#include "conjunction/gp_json.h"

// dnwrnr/sgp4 headers
#include "Tle.h"
#include "SGP4.h"
#include "OrbitalElements.h"
#include "DateTime.h"
#include "TimeSpan.h"
#include "Eci.h"

#include <cmath>
#include <algorithm>
#include <stdexcept>
#include <sstream>
#include <iomanip>
#include <limits>
#include <memory>
#include <mutex>

namespace conjunction {

static constexpr double EARTH_RADIUS_KM = 6378.137;

struct Sgp4PropagationCache {
    libsgp4::Tle tle;
    libsgp4::SGP4 sgp4;

    explicit Sgp4PropagationCache(const conjunction::TLE& source)
        : tle(source.name, source.line1, source.line2),
          sgp4(tle) {}
};

namespace {

#ifndef CONJUNCTION_SINGLE_THREAD
std::mutex g_sgp4_cache_mutex;
#endif

std::shared_ptr<const Sgp4PropagationCache> get_or_create_sgp4_cache(
    const conjunction::TLE& tle)
{
    auto cached = std::atomic_load(&tle.cache);
    if (cached) return cached;

#ifndef CONJUNCTION_SINGLE_THREAD
    std::lock_guard<std::mutex> lock(g_sgp4_cache_mutex);
#endif
    cached = std::atomic_load(&tle.cache);
    if (!cached) {
        std::shared_ptr<const Sgp4PropagationCache> candidate = std::make_shared<Sgp4PropagationCache>(tle);
        if (has_error()) return nullptr;
        std::atomic_store(&tle.cache, candidate);
        cached = std::move(candidate);
    }
    return cached;
}

} // namespace

// ============================================================================
// Time Utilities
// ============================================================================

double epoch_to_jd(int year, double day_of_year) {
    // Julian Date from year + day of year
    int y = year;
    if (y < 57) y += 2000; else if (y < 100) y += 1900;

    int a = (14 - 1) / 12;
    int yy = y + 4800 - a;
    int mm = 1 + 12 * a - 3;
    double jd = 1 + (153 * mm + 2) / 5 + 365 * yy + yy / 4 - yy / 100 + yy / 400 - 32045;
    return jd - 0.5 + (day_of_year - 1.0);
}

std::string jd_to_iso(double jd) {
    if (!std::isfinite(jd)) { set_error("Non-finite epoch"); return {}; }
    // JD → calendar date
    double z = std::floor(jd + 0.5);
    double f = (jd + 0.5) - z;
    double a;
    if (z < 2299161) { a = z; }
    else {
        double alpha = std::floor((z - 1867216.25) / 36524.25);
        a = z + 1 + alpha - std::floor(alpha / 4);
    }
    double b = a + 1524;
    double c = std::floor((b - 122.1) / 365.25);
    double d = std::floor(365.25 * c);
    double e = std::floor((b - d) / 30.6001);

    double day = b - d - std::floor(30.6001 * e) + f;
    int month = (e < 14) ? (int)e - 1 : (int)e - 13;
    int year = (month > 2) ? (int)c - 4716 : (int)c - 4715;

    int day_int = (int)day;
    double frac = day - day_int;
    int hour = (int)(frac * 24);
    int minute = (int)((frac * 24 - hour) * 60);
    double second = ((frac * 24 - hour) * 60 - minute) * 60;

    std::stringstream ss;
    ss << std::setfill('0')
       << std::setw(4) << year << "-"
       << std::setw(2) << month << "-"
       << std::setw(2) << day_int << "T"
       << std::setw(2) << hour << ":"
       << std::setw(2) << minute << ":"
       << std::fixed << std::setprecision(3) << std::setw(6) << std::setfill('0') << second
       << "Z";
    return ss.str();
}

double iso_to_jd(const std::string& iso) {
    // CCSDS calendar timestamps use an explicit UTC field in the enclosing
    // record, so the terminal Z may be absent. Do not accept another timezone,
    // trailing text, or scanf's permissive numeric forms as if they were UTC.
    auto invalid = []() {
        set_error("Invalid UTC epoch"); return std::numeric_limits<double>::quiet_NaN();
    };
    if (iso.size() < 19 || iso[4] != '-' || iso[7] != '-' ||
        iso[10] != 'T' || iso[13] != ':' || iso[16] != ':')
        return invalid();
    auto digits = [&](size_t start, size_t count) {
        int value = 0;
        for (size_t i = start; i < start + count; ++i) {
            if (iso[i] < '0' || iso[i] > '9') return -1;
            value = value * 10 + iso[i] - '0';
        }
        return value;
    };
    const int year = digits(0, 4), month = digits(5, 2), day = digits(8, 2);
    const int hour = digits(11, 2), minute = digits(14, 2), seconds = digits(17, 2);
    static constexpr int month_days[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    const bool leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    if (year < 1 || month < 1 || month > 12 || day < 1 ||
        day > month_days[month - 1] + (month == 2 && leap ? 1 : 0) ||
        hour < 0 || hour > 23 || minute < 0 || minute > 59 ||
        seconds < 0 || seconds >= 60)
        return invalid();
    double second = seconds;
    size_t cursor = 19;
    if (cursor < iso.size() && iso[cursor] == '.') {
        ++cursor;
        const size_t fraction_start = cursor;
        double place = 0.1;
        while (cursor < iso.size() && iso[cursor] >= '0' && iso[cursor] <= '9') {
            second += (iso[cursor++] - '0') * place;
            place *= 0.1;
        }
        if (cursor == fraction_start) return invalid();
    }
    if (cursor < iso.size() && iso[cursor] == 'Z') ++cursor;
    if (cursor != iso.size() || second >= 60) return invalid();

    int a = (14 - month) / 12;
    int y = year + 4800 - a;
    int m = month + 12 * a - 3;
    double jd = day + (153 * m + 2) / 5 + 365 * y + y / 4 - y / 100 + y / 400 - 32045;
    return jd - 0.5 + (hour + minute / 60.0 + second / 3600.0) / 24.0;
}

// ============================================================================
// TLE Parsing (wraps dnwrnr/sgp4)
// ============================================================================

/// Strip record-delimiter whitespace without altering TLE field values.
static std::string normalize_tle_line(const std::string& line) {
    std::string l = line;
    // Trim trailing whitespace/CR
    while (!l.empty() && (l.back() == ' ' || l.back() == '\r' || l.back() == '\n'))
        l.pop_back();
    // Trim leading whitespace
    size_t start = 0;
    while (start < l.size() && (l[start] == ' ' || l[start] == '\t'))
        start++;
    if (start > 0) l = l.substr(start);
    return l;
}

TLE parse_tle(const std::string& name, const std::string& line1, const std::string& line2) {
    TLE tle;
    tle.name = name;
    tle.line1 = normalize_tle_line(line1);
    tle.line2 = normalize_tle_line(line2);

    // Use dnwrnr Tle parser for the heavy lifting
    {
        libsgp4::Tle sgp4_tle(name, tle.line1, tle.line2);
        if (has_error()) return {};
        tle.norad_cat_id = sgp4_tle.NoradNumber();
        tle.inclination = sgp4_tle.Inclination(true);   // degrees
        tle.raan = sgp4_tle.RightAscendingNode(true);
        tle.eccentricity = sgp4_tle.Eccentricity();
        tle.arg_perigee = sgp4_tle.ArgumentPerigee(true);
        tle.mean_anomaly = sgp4_tle.MeanAnomaly(true);
        tle.mean_motion = sgp4_tle.MeanMotion();         // rev/day
        tle.bstar = sgp4_tle.BStar();

        // Compute epoch JD
        auto epoch = sgp4_tle.Epoch();
        tle.epoch_jd = epoch.ToJulian();
    }

    return tle;
}

std::vector<TLE> parse_tle_file(const std::string& data) {
    std::vector<TLE> tles;
    std::istringstream stream(data);
    std::string line;
    std::vector<std::string> lines;

    while (std::getline(stream, line)) {
        // Trim trailing whitespace/CR
        while (!line.empty() && (line.back() == '\r' || line.back() == ' ' || line.back() == '\n'))
            line.pop_back();
        // Trim leading whitespace (some GP data has leading spaces on line2)
        size_t start = 0;
        while (start < line.size() && (line[start] == ' ' || line[start] == '\t'))
            start++;
        if (start > 0) line = line.substr(start);
        if (!line.empty())
            lines.push_back(line);
    }

    // Parse as 3-line sets (name + line1 + line2)
    for (size_t i = 0; i + 2 < lines.size(); ) {
        if (lines[i + 1].size() > 1 && lines[i + 1][0] == '1' &&
            lines[i + 2].size() > 1 && lines[i + 2][0] == '2') {
            {
                tles.push_back(parse_tle(lines[i], lines[i + 1], lines[i + 2]));
            }
            i += 3;
        } else if (lines[i].size() > 1 && lines[i][0] == '1' &&
                   lines[i + 1].size() > 1 && lines[i + 1][0] == '2') {
            // 2-line format (no name)
            {
                tles.push_back(parse_tle("", lines[i], lines[i + 1]));
            }
            i += 2;
        } else {
            i++;
        }
    }

    return tles;
}

// ============================================================================
// SGP4 Propagation
// ============================================================================

StateVector propagate_sgp4(const TLE& tle, double target_jd) {
    StateVector sv;
    sv.epoch_jd = target_jd;
    const double nan = std::numeric_limits<double>::quiet_NaN();
    sv.x = sv.y = sv.z = nan;
    sv.vx = sv.vy = sv.vz = nan;
    if (!std::isfinite(target_jd)) { set_error("Non-finite propagation epoch"); return sv; }
    if (has_error()) return sv;

    {
        const auto cache = get_or_create_sgp4_cache(tle);
        if (has_error() || !cache) return sv;

        // Propagate using elapsed minutes from the TLE epoch. This avoids
        // reconstructing a DateTime from fractional-day pieces, which can
        // trip libsgp4 validity assertions for finely refined TCA sample times.
        const double minutes_since_epoch = (target_jd - tle.epoch_jd) * 1440.0;
        // SDP4 has mutable resonance integrator state. A per-evaluation copy
        // starts from the same initialized state regardless of worker ordering.
        const auto position = [&]() {
            if (tle.mean_motion <= 1440.0 / 225.0) {
                auto deep_space = cache->sgp4;
                return deep_space.FindPosition(minutes_since_epoch);
            }
            return cache->sgp4.FindPosition(minutes_since_epoch);
        };
        libsgp4::Eci eci = position();
        if (has_error()) return sv;

        sv.x = eci.Position().x;
        sv.y = eci.Position().y;
        sv.z = eci.Position().z;
        sv.vx = eci.Velocity().x;
        sv.vy = eci.Velocity().y;
        sv.vz = eci.Velocity().z;

        const double radius_km =
            std::sqrt(sv.x * sv.x + sv.y * sv.y + sv.z * sv.z);
        if (!std::isfinite(radius_km) || radius_km < EARTH_RADIUS_KM) {
            set_error("Non-finite or decayed SGP4 state");
            sv.x = sv.y = sv.z = nan;
            sv.vx = sv.vy = sv.vz = nan;
        }
    }
    return sv;
}

StateVector propagate_sgp4_gp(const GPElement& gp, double target_jd) {
    // Convert GP to TLE, then propagate via standard SGP4 path
    TLE tle = gp_to_tle(gp);
    return propagate_sgp4(tle, target_jd);
}

// ============================================================================
// Frame Transformations
// ============================================================================

static void cross(const double a[3], const double b[3], double c[3]) {
    c[0] = a[1] * b[2] - a[2] * b[1];
    c[1] = a[2] * b[0] - a[0] * b[2];
    c[2] = a[0] * b[1] - a[1] * b[0];
}

static double dot(const double a[3], const double b[3]) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

static double norm(const double a[3]) {
    return std::sqrt(dot(a, a));
}

static void normalize(double a[3]) {
    double n = norm(a);
    if (n > 1e-15) { a[0] /= n; a[1] /= n; a[2] /= n; }
}

void inertial_to_rtn(const StateVector& ref, const StateVector& target,
                     double& r, double& t, double& n_out,
                     double& vr, double& vt, double& vn) {
    // R = radial (along position vector)
    // T = transverse (along velocity, ⊥ R)
    // N = normal (R × T)
    double R_hat[3] = { ref.x, ref.y, ref.z };
    normalize(R_hat);

    double h[3]; // angular momentum
    double rv[3] = { ref.x, ref.y, ref.z };
    double vv[3] = { ref.vx, ref.vy, ref.vz };
    cross(rv, vv, h);

    double N_hat[3] = { h[0], h[1], h[2] };
    normalize(N_hat);

    double T_hat[3];
    cross(N_hat, R_hat, T_hat);
    normalize(T_hat);

    // Relative position
    double dr[3] = {
        target.x - ref.x,
        target.y - ref.y,
        target.z - ref.z
    };

    r = dot(dr, R_hat);
    t = dot(dr, T_hat);
    n_out = dot(dr, N_hat);

    // Relative velocity
    double dv[3] = {
        target.vx - ref.vx,
        target.vy - ref.vy,
        target.vz - ref.vz
    };

    vr = dot(dv, R_hat);
    vt = dot(dv, T_hat);
    vn = dot(dv, N_hat);
}

// ============================================================================
// TCA Finding
// ============================================================================

static double distance_at_jd(const TLE& tle1, const TLE& tle2, double jd) {
    auto s1 = propagate_sgp4(tle1, jd);
    auto s2 = propagate_sgp4(tle2, jd);
    if (has_error()) return std::numeric_limits<double>::quiet_NaN();
    double dx = s1.x - s2.x;
    double dy = s1.y - s2.y;
    double dz = s1.z - s2.z;
    return std::sqrt(dx * dx + dy * dy + dz * dz);
}

/// Find all local distance minima (potential close approaches)
static std::vector<std::pair<double, double>> find_all_minima(
    const TLE& tle1, const TLE& tle2,
    double start_jd, double end_jd, double step_sec)
{
    double step = step_sec / 86400.0;
    std::vector<std::pair<double, double>> minima; // (jd, distance)

    double prev_d = 1e18, curr_d = 1e18, prev_jd = start_jd;
    bool prev_decreasing = false;
    double start_dist = 1e18;
    double end_dist = 1e18;

    for (double jd = start_jd; jd <= end_jd; jd += step) {
        {
            double d = distance_at_jd(tle1, tle2, jd);
            if (has_error()) return {};
            if (jd == start_jd) {
                start_dist = d;
            }
            end_dist = d;
            bool decreasing = (d < curr_d);

            // Local minimum: was decreasing, now increasing
            if (prev_decreasing && !decreasing && curr_d < 50.0) {
                minima.push_back({prev_jd, curr_d});
            }

            prev_decreasing = decreasing;
            prev_d = curr_d;
            curr_d = d;
            prev_jd = jd;
        }
    }

    if (std::isfinite(start_dist)) {
        minima.push_back({start_jd, start_dist});
    }
    if (end_jd > start_jd && std::isfinite(end_dist)) {
        minima.push_back({end_jd, end_dist});
    }

    return minima;
}

/// Refine a local minimum using golden section search
static double refine_minimum(const TLE& tle1, const TLE& tle2,
                            double center_jd, double window_days,
                            double tol_sec)
{
    double a = center_jd - window_days;
    double b = center_jd + window_days;
    double tol = tol_sec / 86400.0;
    const double phi = (std::sqrt(5.0) - 1.0) / 2.0;

    while ((b - a) > tol) {
        double c = b - phi * (b - a);
        double d_val = a + phi * (b - a);

        {
            double fc = distance_at_jd(tle1, tle2, c);
            double fd = distance_at_jd(tle1, tle2, d_val);
            if (has_error()) return std::numeric_limits<double>::quiet_NaN();

            if (fc < fd) b = d_val;
            else a = c;
        }
    }

    return (a + b) / 2.0;
}

static double clamp_jd_to_range(double value, double min_jd, double max_jd) {
    return std::max(min_jd, std::min(value, max_jd));
}

static ConjunctionEvent build_conjunction_event(
    const TLE& tle1,
    const TLE& tle2,
    double tca_jd,
    double radius1_m,
    double radius2_m)
{
    ConjunctionEvent event;
    event.obj1 = tle1;
    event.obj2 = tle2;
    event.tca_jd = tca_jd;
    event.tca_iso = jd_to_iso(event.tca_jd);

    event.state1 = propagate_sgp4(tle1, event.tca_jd);
    event.state2 = propagate_sgp4(tle2, event.tca_jd);
    if (has_error()) return {};

    double dx = event.state1.x - event.state2.x;
    double dy = event.state1.y - event.state2.y;
    double dz = event.state1.z - event.state2.z;
    event.min_range_km = std::sqrt(dx * dx + dy * dy + dz * dz);

    double dvx = event.state1.vx - event.state2.vx;
    double dvy = event.state1.vy - event.state2.vy;
    double dvz = event.state1.vz - event.state2.vz;
    event.rel_speed_kms = std::sqrt(dvx * dvx + dvy * dvy + dvz * dvz);

    inertial_to_rtn(event.state1, event.state2,
                    event.rel_pos_r, event.rel_pos_t, event.rel_pos_n,
                    event.rel_vel_r, event.rel_vel_t, event.rel_vel_n);

    event.dse1 = event.tca_jd - tle1.epoch_jd;
    event.dse2 = event.tca_jd - tle2.epoch_jd;

    const SGP4EphemerisSource primary_source(tle1);
    const SGP4EphemerisSource secondary_source(tle2);
    RtnCovarianceSigmas primary_sigmas;
    RtnCovarianceSigmas secondary_sigmas;
    if (primary_source.covariance_rtn_sigma_at(event.tca_jd, primary_sigmas)) {
        event.cov_r1 = primary_sigmas.radial_km * 1000.0;
        event.cov_t1 = primary_sigmas.along_track_km * 1000.0;
        event.cov_n1 = primary_sigmas.cross_track_km * 1000.0;
    } else {
        event.cov_r1 = DEFAULT_COV_R_M;
        event.cov_t1 = DEFAULT_COV_T_M;
        event.cov_n1 = DEFAULT_COV_N_M;
    }
    if (secondary_source.covariance_rtn_sigma_at(event.tca_jd, secondary_sigmas)) {
        event.cov_r2 = secondary_sigmas.radial_km * 1000.0;
        event.cov_t2 = secondary_sigmas.along_track_km * 1000.0;
        event.cov_n2 = secondary_sigmas.cross_track_km * 1000.0;
    } else {
        event.cov_r2 = DEFAULT_COV_R_M;
        event.cov_t2 = DEFAULT_COV_T_M;
        event.cov_n2 = DEFAULT_COV_N_M;
    }

    double combined_radius_km = (radius1_m + radius2_m) / 1000.0;
    auto prob = alfano_max_probability(event.min_range_km, combined_radius_km);
    event.max_probability = prob.max_probability;
    event.dilution_threshold_km = prob.dilution_threshold_km;
    return event;
}

static ConjunctionSolution build_conjunction_solution(
    const TLE& tle1,
    const TLE& tle2,
    double tca_jd)
{
    ConjunctionSolution solution;
    solution.tca_jd = tca_jd;
    solution.min_range_km = distance_at_jd(tle1, tle2, tca_jd);
    return solution;
}

double find_tca(const TLE& tle1, const TLE& tle2,
                double start_jd, double duration_days,
                double coarse_step_sec, double fine_tol_sec) {
    double end_jd = start_jd + duration_days;

    // Step 1: Find all local minima with 5-second steps
    // 5s is critical for catching razor-thin encounters where objects
    // at 12+ km/s relative speed have sub-km TCA lasting < 0.1 seconds.
    // 10s step misses these entirely as local minima.
    auto minima = find_all_minima(tle1, tle2, start_jd, end_jd, 5.0);

    if (has_error()) return std::numeric_limits<double>::quiet_NaN();
    if (minima.empty()) {
        minima = find_all_minima(tle1, tle2, start_jd, end_jd, coarse_step_sec);
    }

    if (minima.empty()) {
        set_error("No finite states in TCA search");
        return std::numeric_limits<double>::quiet_NaN();
    }

    // Step 2: Sort by coarse distance, take top candidates for refinement
    // Critical insight: at high relative speeds (10-15 km/s), the coarse
    // 10-second sample can be 50+ km from the actual TCA even when the
    // true minimum is < 1 km. We must refine multiple candidates.
    std::sort(minima.begin(), minima.end(),
              [](const auto& a, const auto& b) { return a.second < b.second; });

    // Refine top N candidates with two-phase approach:
    // Phase 1: Sub-second rescan around each coarse candidate (±10s at 0.1s)
    //          to catch razor-thin encounters (closing speed > 10 km/s means
    //          miss distance can go from 7km to 14m in under 1 second)
    // Phase 2: Golden section refinement on the best sub-second position
    int n_refine = std::min(static_cast<int>(minima.size()), 30);

    double best_jd = minima[0].first;
    double best_dist = 1e18;

    for (int i = 0; i < n_refine; i++) {
        double center = minima[i].first;

        // Endpoints need a wider rescan window because the true TCA can occur
        // inside the first coarse interval before a turning point is sampled.
        double subscan_best_jd = center;
        double subscan_best_dist = minima[i].second;
        double subscan_step = 0.05 / 86400.0; // 0.05 second steps
        double subscan_window =
            std::max(10.0, coarse_step_sec) / 86400.0;

        double subscan_start = std::max(start_jd, center - subscan_window);
        double subscan_stop = std::min(end_jd, center + subscan_window);

        for (double jd = subscan_start;
             jd <= subscan_stop + subscan_step * 0.5;
             jd += subscan_step) {
            {
                double d = distance_at_jd(tle1, tle2, jd);
            if (has_error()) return std::numeric_limits<double>::quiet_NaN();
                if (d < subscan_best_dist) {
                    subscan_best_dist = d;
                    subscan_best_jd = jd;
                }
            }
        }

        // Phase 2: Golden section from the sub-second best position (±1s window)
        double refined_jd = refine_minimum(tle1, tle2,
                                           subscan_best_jd,
                                           1.0 / 86400.0, // ±1 second
                                           fine_tol_sec);
        {
            double d = distance_at_jd(tle1, tle2, refined_jd);
            if (has_error()) return std::numeric_limits<double>::quiet_NaN();
            if (d < best_dist) {
                best_dist = d;
                best_jd = refined_jd;
            }
        }
    }

    return best_jd;
}

// ============================================================================
// Alfano Maximum Probability (AAS 03-548)
// ============================================================================

ProbResult alfano_max_probability(double miss_distance_km, double combined_radius_km) {
    ProbResult result;

    double d = miss_distance_km * 1000.0;  // Convert to meters
    double Rc = combined_radius_km * 1000.0;

    if (d < 1e-10) {
        // Objects at same location
        result.max_probability = 1.0;
        result.dilution_threshold_km = 0.0;
        result.sigma_star_km = 0.0;
        return result;
    }

    if (Rc >= d) {
        // Hard bodies overlap
        result.max_probability = 1.0;
        result.dilution_threshold_km = 0.0;
        result.sigma_star_km = 0.0;
        return result;
    }

    // Spherical case (SOCRATES default: AR = 1, fixed covariance orientation)
    // σ* = d / √2  (sigma at which probability is maximized)
    double sigma_star = d / std::sqrt(2.0);

    // P_max = (Rc² / d²) × e⁻¹
    double Pmax = (Rc * Rc) / (d * d) * std::exp(-1.0);

    // Clamp to [0, 1]
    if (Pmax > 1.0) Pmax = 1.0;

    result.max_probability = Pmax;
    result.sigma_star_km = sigma_star / 1000.0;
    result.dilution_threshold_km = sigma_star / 1000.0;

    return result;
}

// ============================================================================
// Full Collision Probability with Covariance
// ============================================================================

double collision_probability(
    const StateVector& state1, const StateVector& state2,
    const double cov1[9], const double cov2[9],
    double combined_radius_km)
{
    // Relative position and velocity
    double dr[3] = { state1.x - state2.x, state1.y - state2.y, state1.z - state2.z };
    double dv[3] = { state1.vx - state2.vx, state1.vy - state2.vy, state1.vz - state2.vz };

    double d = norm(dr);  // miss distance
    double v = norm(dv);  // relative speed

    if (v < 1e-10) return 0.0;

    // Combined covariance (uncorrelated assumption)
    double C[9];
    for (int i = 0; i < 9; i++) C[i] = cov1[i] + cov2[i];

    // Build collision plane basis (⊥ to relative velocity)
    double zhat[3] = { dv[0] / v, dv[1] / v, dv[2] / v };

    // Find a vector not parallel to zhat
    double temp[3] = { 1, 0, 0 };
    if (std::abs(zhat[0]) > 0.9) { temp[0] = 0; temp[1] = 1; }

    // xhat = normalize(temp - (temp·zhat)zhat)
    double d_tz = dot(temp, zhat);
    double xhat[3] = { temp[0] - d_tz * zhat[0], temp[1] - d_tz * zhat[1], temp[2] - d_tz * zhat[2] };
    normalize(xhat);

    // yhat = zhat × xhat
    double yhat[3];
    cross(zhat, xhat, yhat);

    // Project covariance onto collision plane (2D)
    // C_2D = P * C * P^T where P = [xhat; yhat] (2×3)
    // C_2D[0][0] = xhat^T * C * xhat
    // C_2D[0][1] = xhat^T * C * yhat
    // C_2D[1][1] = yhat^T * C * yhat

    auto matmul_vec = [](const double M[9], const double v[3], double out[3]) {
        out[0] = M[0]*v[0] + M[1]*v[1] + M[2]*v[2];
        out[1] = M[3]*v[0] + M[4]*v[1] + M[5]*v[2];
        out[2] = M[6]*v[0] + M[7]*v[1] + M[8]*v[2];
    };

    double Cx[3], Cy[3];
    matmul_vec(C, xhat, Cx);
    matmul_vec(C, yhat, Cy);

    double sxx = dot(xhat, Cx);  // σ²_xx
    double sxy = dot(xhat, Cy);  // σ²_xy
    double syy = dot(yhat, Cy);  // σ²_yy

    // Project miss vector onto collision plane
    double xm = dot(dr, xhat);
    double ym = dot(dr, yhat);
    double miss_2d = std::sqrt(xm * xm + ym * ym);

    // Eigendecompose 2×2 covariance
    double trace = sxx + syy;
    double det = sxx * syy - sxy * sxy;
    double disc = std::sqrt(std::max(0.0, trace * trace / 4.0 - det));
    double sigma1_sq = trace / 2.0 + disc;  // Larger eigenvalue
    double sigma2_sq = trace / 2.0 - disc;  // Smaller eigenvalue

    if (sigma1_sq <= 0 || sigma2_sq <= 0) {
        // Degenerate covariance — fall back to Alfano spherical
        auto result = alfano_max_probability(d, combined_radius_km);
        return result.max_probability;
    }

    double sigma1 = std::sqrt(sigma1_sq);
    double sigma2 = std::sqrt(sigma2_sq);

    // For now, use the small hard-body approximation (Foster & Estes 1992)
    // P_c ≈ (Rc² / (2σ₁σ₂)) × exp(-0.5 × (xm²/σ₁² + ym²/σ₂²))
    double Rc = combined_radius_km;
    double Pc = (Rc * Rc) / (2.0 * sigma1 * sigma2) *
                std::exp(-0.5 * (xm * xm / sigma1_sq + ym * ym / sigma2_sq));

    return std::min(Pc, 1.0);
}

// ============================================================================
// Full Conjunction Assessment
// ============================================================================

ConjunctionEvent assess_conjunction(
    const TLE& tle1, const TLE& tle2,
    double start_jd, double duration_days,
    double radius1_m, double radius2_m)
{
    const auto solution =
        assess_conjunction_solution(tle1, tle2, start_jd, duration_days);
    return build_conjunction_event(
        tle1,
        tle2,
        solution.tca_jd,
        radius1_m,
        radius2_m);
}

ConjunctionEvent assess_conjunction_near(
    const TLE& tle1, const TLE& tle2,
    double tca_hint_jd, double window_hours,
    double radius1_m, double radius2_m)
{
    // Search a narrow window around the expected TCA
    double window_days = window_hours / 24.0;
    double search_start = tca_hint_jd - window_days;
    double search_end = tca_hint_jd + window_days;
    return assess_conjunction_in_window_near_hint(
        tle1,
        tle2,
        search_start,
        search_end,
        tca_hint_jd,
        radius1_m,
        radius2_m);
}

ConjunctionEvent assess_conjunction_in_window_near_hint(
    const TLE& tle1, const TLE& tle2,
    double search_start_jd,
    double search_end_jd,
    double tca_hint_jd,
    double radius1_m, double radius2_m)
{
    const auto solution = assess_conjunction_solution_in_window_near_hint(
        tle1,
        tle2,
        search_start_jd,
        search_end_jd,
        tca_hint_jd);
    return build_conjunction_event(
        tle1,
        tle2,
        solution.tca_jd,
        radius1_m,
        radius2_m);
}

ConjunctionSolution assess_conjunction_solution(
    const TLE& tle1, const TLE& tle2,
    double start_jd, double duration_days)
{
    const double tca_jd = find_tca(tle1, tle2, start_jd, duration_days);
    return build_conjunction_solution(tle1, tle2, tca_jd);
}

ConjunctionEvent assess_conjunction_at_tca(
    const TLE& tle1, const TLE& tle2,
    double tca_jd,
    double radius1_m, double radius2_m)
{
    return build_conjunction_event(tle1, tle2, tca_jd, radius1_m, radius2_m);
}

ConjunctionSolution assess_conjunction_solution_in_window_near_hint(
    const TLE& tle1, const TLE& tle2,
    double search_start_jd,
    double search_end_jd,
    double tca_hint_jd)
{
    if (!(search_end_jd > search_start_jd)) {
        const double clamped_tca =
            clamp_jd_to_range(tca_hint_jd, search_start_jd, search_start_jd);
        return build_conjunction_solution(tle1, tle2, clamped_tca);
    }

    constexpr double INITIAL_HALF_WINDOW_SEC = 5.0;
    constexpr double EDGE_MARGIN_SEC = 0.5;

    const double clamped_hint_jd =
        clamp_jd_to_range(tca_hint_jd, search_start_jd, search_end_jd);
    const double max_half_window_days = (search_end_jd - search_start_jd) * 0.5;
    double half_window_days =
        std::min(max_half_window_days, INITIAL_HALF_WINDOW_SEC / 86400.0);
    if (!(half_window_days > 0.0)) {
        half_window_days = max_half_window_days;
    }
    double center_jd = clamped_hint_jd;

    for (;;) {
        const double local_start_jd =
            std::max(search_start_jd, center_jd - half_window_days);
        const double local_end_jd =
            std::min(search_end_jd, center_jd + half_window_days);
        auto solution = assess_conjunction_solution(
            tle1,
            tle2,
            local_start_jd,
            std::max(0.0, local_end_jd - local_start_jd));
        center_jd =
            clamp_jd_to_range(solution.tca_jd, search_start_jd, search_end_jd);

        const double edge_margin_days = EDGE_MARGIN_SEC / 86400.0;
        const bool near_lower_edge =
            solution.tca_jd <= local_start_jd + edge_margin_days &&
            local_start_jd > search_start_jd + 1e-12;
        const bool near_upper_edge =
            solution.tca_jd >= local_end_jd - edge_margin_days &&
            local_end_jd < search_end_jd - 1e-12;
        if (!(near_lower_edge || near_upper_edge) ||
            half_window_days >= max_half_window_days - 1e-12) {
            const double polish_half_window_days =
                std::min(half_window_days, INITIAL_HALF_WINDOW_SEC / 86400.0);
            const double polish_start_jd =
                std::max(search_start_jd, center_jd - polish_half_window_days);
            const double polish_end_jd =
                std::min(search_end_jd, center_jd + polish_half_window_days);
            return assess_conjunction_solution(
                tle1,
                tle2,
                polish_start_jd,
                std::max(0.0, polish_end_jd - polish_start_jd));
        }

        half_window_days = std::min(max_half_window_days, half_window_days * 2.0);
    }
}

// ============================================================================
// Conjunction Screening
// ============================================================================

std::vector<ConjunctionEvent> screen_conjunctions(
    const std::vector<TLE>& primary_tles,
    const std::vector<TLE>& secondary_tles,
    double start_jd,
    double duration_days,
    double threshold_km)
{
    std::vector<ConjunctionEvent> events;

    for (const auto& primary : primary_tles) {
        for (const auto& secondary : secondary_tles) {
            if (primary.norad_cat_id == secondary.norad_cat_id) continue;

            {
                auto event = assess_conjunction(primary, secondary, start_jd, duration_days);
                if (has_error()) return {};
                if (event.min_range_km <= threshold_km) {
                    events.push_back(event);
                }
            }
        }
    }

    // Sort by max probability descending
    std::sort(events.begin(), events.end(),
              [](const ConjunctionEvent& a, const ConjunctionEvent& b) {
                  return a.max_probability > b.max_probability;
              });

    return events;
}

} // namespace conjunction
