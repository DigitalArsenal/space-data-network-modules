// The deviation bound all-vs-all screening relies on (screening_tight.h):
// for every sample of a PPE trajectory and every |tau| <= h,
//   |r(jd + tau) - r(jd) - v(jd) tau| <= path_deviation_bound_km(jd, h).
//
// The trajectory is a 7000 km circular two-body orbit, interpolated as a PPE
// is (13 Chebyshev coefficients per 600 s interval, at Chebyshev nodes), with
// a 5 m/s impulsive maneuver at an interval boundary: from there on the path
// gains dv (t - t_b). The bound is checked against the trajectory's own states
// every 0.1 s around samples every 7 s across the boundary, for h = 30 s and
// h = 90 s, and must not be loose by more than a factor 50 where the motion
// is smooth (it is a worst-case series bound, not an estimate).
#include "conjunction/ephemeris_source.h"

#include <cmath>
#include <cstdio>
#include <vector>

using namespace conjunction;

namespace {
constexpr double MU = 398600.4418, R = 7000.0, SEGMENT_S = 600.0, MANEUVER_DV = 0.005;
constexpr int SEGMENTS = 6, MANEUVER_SEGMENT = 3, N = 13;
const double OMEGA = std::sqrt(MU / (R * R * R));
constexpr double START_JD = 2461314.5;

// True path: position and velocity at t seconds from START_JD.
void truth(double t, double r[3], double v[3]) {
    const double a = OMEGA * t, s = R * OMEGA;
    r[0] = R * std::cos(a); r[1] = R * std::sin(a); r[2] = 0;
    v[0] = -s * std::sin(a); v[1] = s * std::cos(a); v[2] = 0;
    const double tb = MANEUVER_SEGMENT * SEGMENT_S;
    if (t >= tb) {   // dv along z from the maneuver on
        r[2] += MANEUVER_DV * (t - tb);
        v[2] += MANEUVER_DV;
    }
}

PolynomialRecord interpolate(int segment) {
    PolynomialRecord rec;
    rec.half = SEGMENT_S / 2;
    const double mid_s = (segment + 0.5) * SEGMENT_S;
    rec.mid = START_JD + mid_s / 86400.0;
    std::vector<double> f[6];
    std::vector<double> x(N);
    for (int j = 0; j < N; ++j) {
        x[j] = std::cos(M_PI * (j + 0.5) / N);
        double r[3], v[3];
        // Nodes stay inside the interval, so the maneuver side is unambiguous.
        truth(mid_s + x[j] * rec.half, r, v);
        for (int k = 0; k < 3; ++k) { f[k].push_back(r[k]); f[k + 3].push_back(v[k]); }
    }
    for (int axis = 0; axis < 6; ++axis) {
        rec.c[axis].assign(N, 0.0);
        for (int k = 0; k < N; ++k) {
            double sum = 0;
            for (int j = 0; j < N; ++j) sum += f[axis][j] * std::cos(k * std::acos(x[j]));
            rec.c[axis][k] = (k == 0 ? 1.0 : 2.0) * sum / N;
        }
    }
    return rec;
}

int failures = 0;
void check(bool ok, const char* what, double a, double b) {
    if (!ok) { ++failures; std::printf("FAIL %s: %.6g vs %.6g\n", what, a, b); }
}
}  // namespace

int main() {
    std::vector<PolynomialRecord> records;
    for (int s = 0; s < SEGMENTS; ++s) records.push_back(interpolate(s));
    const PolynomialEphemerisSource source(std::move(records));
    check(source.bounds_path_deviation(), "bounds_path_deviation", 1, 0);

    for (double h : {30.0, 90.0}) {
        double worst_ratio = 0, loosest_smooth = 0;
        for (double t = h; t <= SEGMENTS * SEGMENT_S - h; t += 7.0) {
            const double jd = START_JD + t / 86400.0;
            const StateVector s = source.state_at(jd);
            double bound = 0;
            check(source.path_deviation_bound_km(jd, s, h, bound), "bound available", 1, 0);
            double actual = 0;
            for (double tau = -h; tau <= h + 1e-9; tau += 0.1) {
                const StateVector q = source.state_at(jd + tau / 86400.0);
                actual = std::max(actual, std::hypot(q.x - s.x - s.vx * tau,
                                                     std::hypot(q.y - s.y - s.vy * tau, q.z - s.z - s.vz * tau)));
            }
            check(actual <= bound + 1e-9, "deviation within bound", actual, bound);
            worst_ratio = std::max(worst_ratio, actual / bound);
            const double tb = MANEUVER_SEGMENT * SEGMENT_S;
            if (std::abs(t - tb) > h + SEGMENT_S) loosest_smooth = std::max(loosest_smooth, bound / actual);
        }
        check(loosest_smooth < 50, "bound tightness away from the maneuver", loosest_smooth, 50);
        std::printf("h=%g s: max actual/bound %.3f, loosest smooth bound/actual %.2f\n", h, worst_ratio, loosest_smooth);
    }
    std::printf("%s\n", failures ? "FAILED" : "OK");
    return failures ? 1 : 0;
}
