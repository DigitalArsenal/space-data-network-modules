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

bool tight_sample(const EphemerisSource& source, double jd, double half_step_sec,
                  StateVector& state, double& deviation_km, std::string& failure) {
    state = source.state_at(jd);
    if (has_error()) {
        failure = error_message();
        clear_error();
        return false;
    }
    if (!std::isfinite(state.x) || !std::isfinite(state.y) || !std::isfinite(state.z) ||
        !std::isfinite(state.vx) || !std::isfinite(state.vy) || !std::isfinite(state.vz)) {
        failure = "The trajectory has no finite state at this epoch.";
        return false;
    }
    if (!source.path_deviation_bound_km(jd, state, half_step_sec, deviation_km)) {
        failure = "The trajectory cannot bound its motion between coarse steps.";
        return false;
    }
    return true;
}

bool tight_pair_may_close(const StateVector& a, double deviation_a_km, const StateVector& b,
                          double deviation_b_km, double threshold_km, double h, double* closest_km) {
    const double dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const double ux = b.vx - a.vx, uy = b.vy - a.vy, uz = b.vz - a.vz;
    const double vv = ux * ux + uy * uy + uz * uz;
    const double tau = std::clamp(-(dx * ux + dy * uy + dz * uz) / std::max(vv, 1e-20), -h, h);
    const double d = norm3(dx + ux * tau, dy + uy * tau, dz + uz * tau);
    if (closest_km) *closest_km = d;
    return d <= threshold_km + deviation_a_km + deviation_b_km;
}

int32_t tight_last_coarse_step(const ScreeningConfig& config) {
    // Same count as the coarse pass: duration / step, steps 0..count inclusive.
    const double step_days = config.coarse_step_sec / 86400.0;
    return static_cast<int32_t>(config.duration_days / step_days);
}

CoarseGridBlock tight_coarse_grid_block(const SourceRefs& sources, const ScreeningConfig& config,
                                        int32_t first_step, int32_t step_count,
                                        const std::vector<uint8_t>& already_excluded) {
    CoarseGridBlock block;
    const size_t n = sources.size();
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
            double r_lo = std::numeric_limits<double>::infinity(), r_hi = -r_lo;
            bool failed = false;
            for (int32_t s = 0; s < step_count && !failed; ++s) {
                const double jd = config.start_jd + (first_step + s) * step_days;
                StateVector st;
                double deviation = 0;
                std::string failure;
                if (!tight_sample(*sources[i], jd, h, st, deviation, failure)) {
                    auto& x = excluded[worker][static_cast<uint32_t>(i)];
                    x.index = static_cast<uint32_t>(i);
                    x.first_failure_jd = jd;
                    x.reason = failure;
                    failed = true;
                    break;
                }
                float* o = &block.states[(static_cast<size_t>(s) * n + i) * 8];
                o[0] = static_cast<float>(st.x); o[1] = static_cast<float>(st.y); o[2] = static_cast<float>(st.z);
                o[3] = static_cast<float>(deviation);
                o[4] = static_cast<float>(st.vx); o[5] = static_cast<float>(st.vy); o[6] = static_cast<float>(st.vz);
                o[7] = 0.0f;
                // Over the interval |r| stays within D of |r + v tau|, |tau| <= h.
                const double vv = st.vx * st.vx + st.vy * st.vy + st.vz * st.vz;
                const double rv = st.x * st.vx + st.y * st.vy + st.z * st.vz;
                const double rr = st.x * st.x + st.y * st.y + st.z * st.z;
                const double tau = std::clamp(-rv / std::max(vv, 1e-20), -h, h);
                const double nearest = std::sqrt(std::max(0.0, rr + 2 * rv * tau + vv * tau * tau));
                const double farthest = std::sqrt(rr + 2 * std::abs(rv) * h + vv * h * h);
                r_lo = std::min(r_lo, nearest - deviation);
                r_hi = std::max(r_hi, farthest + deviation);
            }
            if (failed) {
                for (int32_t s = 0; s < step_count; ++s)
                    std::fill_n(&block.states[(static_cast<size_t>(s) * n + i) * 8], 8, std::numeric_limits<float>::quiet_NaN());
                continue;
            }
            block.bands[i * 2] = static_cast<float>(r_lo);
            block.bands[i * 2 + 1] = static_cast<float>(r_hi);
        }
    });
    for (auto& part : excluded) block.excluded.insert(part.begin(), part.end());
    return block;
}

} // namespace conjunction
