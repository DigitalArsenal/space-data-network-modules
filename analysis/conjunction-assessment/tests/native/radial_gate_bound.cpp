// The radial gate (src/cpp/src/screening_internal.cpp) on the trajectories the
// screen propagates. Its half window (radial_gate_half_window_sec) holds every
// time of the window that is nearest a step, for windows shorter than half a
// step up to 7 days, sampled every 0.25 s. Its bound (radial_sample) holds: at
// every coarse step t_k of a 7-day window (60 s steps, so a half window
// h = 30 s, and the window's last step taking the span to the window end),
// every SGP4 radius |r(t)| with |t - t_k| <= h lies within the reach of
// |r(t_k)|, sampled every 0.25 s; and for each pair,
// | |r_i(t)| - |r_j(t)| | stays within the gate's bound,
// | |r_i(t_k)| - |r_j(t_k)| | +/- (reach_i + reach_j).
//
// Objects (invented element sets, SGP4 via GPEphemerisSource): circular orbits
// at 400 km decaying fast (BSTAR 0.03, 0.05 and 0.1 per Earth radius), a
// circular orbit at 250 km (BSTAR 1e-4), so each decaying object's epoch
// altitude band starts 150 km above it, and a decaying eccentric orbit (200 km
// by 2,000 km, BSTAR 0.05) for a large radial rate. The test also requires
// each 400 km orbit's radius to come within 5 km of the 250 km orbit's inside
// the window, so the 150 km gap closes there. Prints the largest ratio of
// radial excursion to reach; any excursion beyond reach fails.
#include "conjunction/ephemeris_source.h"
#include "conjunction/gp_json.h"
#include "conjunction/screening_internal.h"
#include "conjunction/error_status.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

using namespace conjunction;

namespace {

GPElement element(const char* name, int norad, double perigee_altitude_km, double eccentricity,
                  double inclination_deg, double bstar) {
    // Mean motion from the semi-major axis, two-body (mu of WGS 72, km^3/s^2).
    constexpr double MU = 398600.8, EARTH_RADIUS_KM = 6378.137, PI = 3.14159265358979323846;
    const double a = (EARTH_RADIUS_KM + perigee_altitude_km) / (1.0 - eccentricity);
    GPElement gp;
    gp.object_name = name;
    gp.object_id = name;
    gp.norad_cat_id = norad;
    gp.epoch_iso = "2026-10-28T17:00:00.000000";
    gp.epoch_jd = iso_to_jd(gp.epoch_iso);
    gp.mean_motion = std::sqrt(MU / (a * a * a)) * 86400.0 / (2.0 * PI);
    gp.eccentricity = eccentricity;
    gp.inclination = inclination_deg;
    gp.ra_of_asc_node = 40.0;
    gp.arg_of_pericenter = 0.0;
    gp.mean_anomaly = 0.0;
    gp.bstar = bstar;
    gp.element_set_no = 999;
    gp.rev_at_epoch = 1;
    compute_derived(gp);
    return gp;
}

double radius(const StateVector& s) { return std::sqrt(s.x * s.x + s.y * s.y + s.z * s.z); }

// Every time of a window of window_sec, sampled every 0.25 s, is within the
// gate's half window of the step nearest it (steps 0..floor(window / step)).
bool half_window_covers(double window_sec, double step_sec) {
    const int last_step = static_cast<int>(window_sec / step_sec);
    for (int64_t q = 0; q * 0.25 <= window_sec; ++q) {
        const double t = q * 0.25;
        const int nearest = std::min(last_step, static_cast<int>(std::floor(t / step_sec + 0.5)));
        const double half = radial_gate_half_window_sec(nearest, last_step, step_sec, window_sec);
        if (std::abs(t - nearest * step_sec) > half) {
            std::printf("FAIL window %.2f s, step %.0f s: t %.2f s is %.2f s from step %d, half window %.2f s\n",
                        window_sec, step_sec, t, std::abs(t - nearest * step_sec), nearest, half);
            return false;
        }
    }
    return true;
}

} // namespace

int main() {
    for (const double window_sec : {0.0, 1.0, 17.0, 29.75, 30.0, 30.25, 59.75, 60.0, 61.0, 89.0, 91.0, 600.0, 7.0 * 86400.0 + 17.0}) {
        if (!half_window_covers(window_sec, 60.0)) return 1;
    }
    // Shorter than half a step, the window's single step needs no more than it.
    if (radial_gate_half_window_sec(0, 0, 600.0, 1.0) != 1.0) {
        std::printf("FAIL a 1 s window at a 600 s step: half window %.2f s\n", radial_gate_half_window_sec(0, 0, 600.0, 1.0));
        return 1;
    }
    std::printf("half window covers windows of 0 s to 7 days at 60 s steps\n");
    const std::vector<GPElement> objects = {
        element("DECAY-003", 900101, 400.0, 0.0001, 53.0, 0.03),
        element("DECAY-005", 900102, 400.0, 0.0001, 53.0, 0.05),
        element("DECAY-010", 900103, 400.0, 0.0001, 53.0, 0.1),
        element("LOW-250", 900104, 250.0, 0.0001, 97.6, 0.0001),
        element("ECC-DECAY", 900105, 200.0, 0.1265, 63.4, 0.05),
    };
    const size_t low = 3;
    std::vector<GPEphemerisSource> sources;
    for (const auto& gp : objects) sources.emplace_back(gp);
    if (has_error()) { std::printf("FAIL element sets: %s\n", error_message()); return 1; }

    const double start_jd = objects[0].epoch_jd;
    const double window_sec = 7.0 * 86400.0 + 17.0;   // not a whole number of steps
    const double step_sec = 60.0, dense_sec = 0.25;
    const int last_step = static_cast<int>(window_sec / step_sec);

    struct Sample { bool ok; double radius, reach; };
    double worst_object = 0.0, worst_pair = 0.0;
    size_t checks = 0;
    bool closes[3] = {false, false, false};
    std::vector<bool> at_first_failure(objects.size(), true);
    for (int k = 0; k <= last_step; ++k) {
        const double tk = k * step_sec;
        const double half = radial_gate_half_window_sec(k, last_step, step_sec, window_sec);
        std::vector<Sample> at(objects.size());
        for (size_t i = 0; i < objects.size(); ++i) {
            clear_error();
            const auto s = sources[i].state_at(start_jd + tk / 86400.0);
            if (has_error()) {   // decayed
                if (at_first_failure[i]) {
                    std::printf("%s stops propagating at %.3f d: %s\n", objects[i].object_name.c_str(), tk / 86400.0, error_message());
                    at_first_failure[i] = false;
                }
                at[i] = {false, 0, 0};
                clear_error();
                continue;
            }
            const auto g = radial_sample(s.x, s.y, s.z, s.vx, s.vy, s.vz, half);
            at[i] = {true, g.radius_km, g.reach_km};
        }
        for (int d = -static_cast<int>(half / dense_sec); d <= static_cast<int>(half / dense_sec); ++d) {
            const double t = tk + d * dense_sec;
            if (t < 0.0 || t > window_sec) continue;
            std::vector<double> r(objects.size(), NAN);
            for (size_t i = 0; i < objects.size(); ++i) {
                if (!at[i].ok) continue;
                clear_error();
                const auto s = sources[i].state_at(start_jd + t / 86400.0);
                if (has_error()) { clear_error(); continue; }
                r[i] = radius(s);
                const double excursion = std::abs(r[i] - at[i].radius);
                if (excursion > at[i].reach) {
                    std::printf("FAIL %s step %d t %+.2f s: |r| moved %.6f km, reach %.6f km\n",
                                objects[i].object_name.c_str(), k, t - tk, excursion, at[i].reach);
                    return 1;
                }
                worst_object = std::max(worst_object, excursion / at[i].reach);
                ++checks;
            }
            for (size_t i = 0; i < objects.size(); ++i) {
                for (size_t j = i + 1; j < objects.size(); ++j) {
                    if (std::isnan(r[i]) || std::isnan(r[j])) continue;
                    const double now = std::abs(r[i] - r[j]);
                    const double then = std::abs(at[i].radius - at[j].radius);
                    const double bound = at[i].reach + at[j].reach;
                    if (std::abs(now - then) > bound) {
                        std::printf("FAIL pair %s/%s step %d: radial gap %.6f km vs %.6f km at the step, bound %.6f km\n",
                                    objects[i].object_name.c_str(), objects[j].object_name.c_str(), k, now, then, bound);
                        return 1;
                    }
                    worst_pair = std::max(worst_pair, std::abs(now - then) / bound);
                    if (j == low && i < 3 && now <= 5.0) closes[i] = true;
                }
            }
        }
    }
    const double band_gap_km = objects[low].perigee_km < objects[0].perigee_km
        ? objects[0].perigee_km - objects[low].apogee_km : 0.0;
    std::printf("epoch band gap %.1f km; %zu radius checks, largest excursion/reach %.4f, pair %.4f\n",
                band_gap_km, checks, worst_object, worst_pair);
    if (!(band_gap_km >= 145.0)) { std::printf("FAIL the epoch bands are not 150 km apart\n"); return 1; }
    for (int i = 0; i < 3; ++i) {
        if (!closes[i]) {
            std::printf("FAIL %s never comes within 5 km of LOW-250's radius in the window\n",
                        objects[i].object_name.c_str());
            return 1;
        }
    }
    std::printf("RADIAL GATE BOUND PASS\n");
    return 0;
}
