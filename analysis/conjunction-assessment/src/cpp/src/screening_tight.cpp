#include "conjunction/screening_tight.h"

#include <algorithm>
#include <cmath>
#include <limits>
#ifndef CONJUNCTION_SINGLE_THREAD
#include <thread>
#endif

#include "conjunction/error_status.h"

namespace conjunction {

namespace {
constexpr double kMuKm3S2 = 398600.8;          // SGP4 (WGS 72) gravitational parameter
constexpr double kAccelerationMargin = 1.05;   // J2 and drag over two-body
constexpr double kRadiusFloorKm = 6000.0;
constexpr float kBandMarginKm = 50.0f;         // as screen_catalog's altitude gate

double norm3(double x, double y, double z) { return std::sqrt(x * x + y * y + z * z); }

// Runs body(worker, first, last) over [0, count) split into num_threads blocks.
template <typename Body>
void for_blocks(int64_t count, int num_threads, Body body) {
    const int workers = static_cast<int>(std::max<int64_t>(1, std::min<int64_t>(num_threads, count)));
#ifndef CONJUNCTION_SINGLE_THREAD
    if (workers > 1) {
        std::vector<std::thread> threads;
        for (int w = 0; w < workers; ++w) {
            threads.emplace_back([&, w] { body(w, count * w / workers, count * (w + 1) / workers); });
        }
        for (auto& t : threads) t.join();
        return;
    }
#endif
    body(0, 0, count);
}
} // namespace

double tight_acceleration_bound_km_s2(const StateVector& s, double half_step_sec) {
    const double r = norm3(s.x, s.y, s.z), v = norm3(s.vx, s.vy, s.vz);
    const double r_min = std::max(r - v * half_step_sec, kRadiusFloorKm);
    return kAccelerationMargin * kMuKm3S2 / (r_min * r_min);
}

bool tight_pair_may_close(const StateVector& a, double accel_a, const StateVector& b, double accel_b,
                          double threshold_km, double h, double* closest_km) {
    const double dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const double ux = b.vx - a.vx, uy = b.vy - a.vy, uz = b.vz - a.vz;
    const double vv = ux * ux + uy * uy + uz * uz;
    const double tau = std::clamp(-(dx * ux + dy * uy + dz * uz) / std::max(vv, 1e-20), -h, h);
    const double d = norm3(dx + ux * tau, dy + uy * tau, dz + uz * tau);
    if (closest_km) *closest_km = d;
    return d <= threshold_km + 0.5 * (accel_a + accel_b) * h * h;
}

int32_t tight_last_coarse_step(const ScreeningConfig& config) {
    // Same count as the coarse pass: duration / step, steps 0..count inclusive.
    const double step_days = config.coarse_step_sec / 86400.0;
    return static_cast<int32_t>(config.duration_days / step_days);
}

CoarseGridBlock tight_coarse_grid_block(const std::vector<TLE>& tles, const ScreeningConfig& config,
                                        int32_t first_step, int32_t step_count,
                                        const std::vector<uint8_t>& already_excluded) {
    CoarseGridBlock block;
    const size_t n = tles.size();
    block.first_step = first_step;
    block.step_count = step_count;
    block.objects = static_cast<uint32_t>(n);
    block.states.assign(static_cast<size_t>(step_count) * n * 8, std::numeric_limits<float>::quiet_NaN());
    block.bands.assign(n * 2, std::numeric_limits<float>::quiet_NaN());
    const double step_days = config.coarse_step_sec / 86400.0;
    const double h = 0.5 * config.coarse_step_sec;
    std::vector<std::map<uint32_t, ExcludedObject>> excluded(std::max(1, config.num_threads));
    for_blocks(static_cast<int64_t>(n), config.num_threads, [&](int worker, int64_t lo, int64_t hi) {
        clear_error();
        for (int64_t i = lo; i < hi; ++i) {
            if (!already_excluded.empty() && already_excluded[i]) continue;
            float r_lo = std::numeric_limits<float>::infinity(), r_hi = -r_lo;
            bool failed = false;
            for (int32_t s = 0; s < step_count && !failed; ++s) {
                const double jd = config.start_jd + (first_step + s) * step_days;
                const StateVector st = propagate_sgp4(tles[i], jd);
                if (has_error()) {
                    auto& x = excluded[worker][static_cast<uint32_t>(i)];
                    x.index = static_cast<uint32_t>(i);
                    x.first_failure_jd = jd;
                    x.reason = error_message();
                    clear_error();
                    failed = true;
                    break;
                }
                float* o = &block.states[(static_cast<size_t>(s) * n + i) * 8];
                o[0] = static_cast<float>(st.x); o[1] = static_cast<float>(st.y); o[2] = static_cast<float>(st.z);
                o[3] = static_cast<float>(tight_acceleration_bound_km_s2(st, h));
                o[4] = static_cast<float>(st.vx); o[5] = static_cast<float>(st.vy); o[6] = static_cast<float>(st.vz);
                o[7] = 0.0f;
                const float r = static_cast<float>(norm3(st.x, st.y, st.z));
                r_lo = std::min(r_lo, r); r_hi = std::max(r_hi, r);
            }
            if (failed) {
                for (int32_t s = 0; s < step_count; ++s)
                    std::fill_n(&block.states[(static_cast<size_t>(s) * n + i) * 8], 8, std::numeric_limits<float>::quiet_NaN());
                continue;
            }
            block.bands[i * 2] = r_lo - kBandMarginKm;
            block.bands[i * 2 + 1] = r_hi + kBandMarginKm;
        }
    });
    for (auto& part : excluded) block.excluded.insert(part.begin(), part.end());
    return block;
}

} // namespace conjunction
