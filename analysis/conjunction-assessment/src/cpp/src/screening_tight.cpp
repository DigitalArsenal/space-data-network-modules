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

void tight_box_pairs(const std::vector<StateVector>& states, const std::vector<double>& deviation_km,
                     const std::vector<uint8_t>& ok, double threshold_km, double h,
                     TightGridScratch& scratch, std::vector<std::pair<uint32_t, uint32_t>>& pairs) {
    pairs.clear();
    const size_t n = states.size();
    auto& box = scratch.boxes;
    box.assign(n * 6, 0.0);
    std::vector<double> edges;
    edges.reserve(n);
    for (size_t i = 0; i < n; ++i) {
        if (!ok[i]) continue;
        const double pad = 0.5 * threshold_km + deviation_km[i];
        const double p[3] = {states[i].x, states[i].y, states[i].z};
        const double d[3] = {states[i].vx * h, states[i].vy * h, states[i].vz * h};
        double edge = 0;
        for (int a = 0; a < 3; ++a) {
            box[i * 6 + a] = std::min(p[a] - d[a], p[a] + d[a]) - pad;
            box[i * 6 + 3 + a] = std::max(p[a] - d[a], p[a] + d[a]) + pad;
            edge = std::max(edge, box[i * 6 + 3 + a] - box[i * 6 + a]);
        }
        edges.push_back(edge);
    }
    if (edges.size() < 2) return;
    // Cell size: the 99th-percentile box edge, so nearly every box covers at
    // most 2 cells per axis. Larger boxes are paired with every object.
    const size_t q = std::min(edges.size() - 1, edges.size() * 99 / 100);
    std::nth_element(edges.begin(), edges.begin() + q, edges.end());
    const double cell = std::max(edges[q], 1e-3);
    const auto index = [cell](double x) { return static_cast<int64_t>(std::floor(x / cell)); };
    const auto key = [](int64_t x, int64_t y, int64_t z) {
        constexpr int64_t bias = int64_t{1} << 20;
        return (static_cast<uint64_t>(x + bias) << 42) | (static_cast<uint64_t>(y + bias) << 21) |
               static_cast<uint64_t>(z + bias);
    };
    const auto overlap = [&](size_t i, size_t j) {
        for (int a = 0; a < 3; ++a)
            if (box[i * 6 + a] > box[j * 6 + 3 + a] || box[j * 6 + a] > box[i * 6 + 3 + a]) return false;
        return true;
    };
    auto& cells = scratch.cells;
    auto& big = scratch.big;
    cells.clear();
    big.clear();
    std::vector<uint8_t> is_big(n, 0);
    for (size_t i = 0; i < n; ++i) {
        if (!ok[i]) continue;
        int64_t lo[3], hi[3];
        for (int a = 0; a < 3; ++a) { lo[a] = index(box[i * 6 + a]); hi[a] = index(box[i * 6 + 3 + a]); }
        if (hi[0] - lo[0] > 3 || hi[1] - lo[1] > 3 || hi[2] - lo[2] > 3) {
            is_big[i] = 1;
            big.push_back(static_cast<uint32_t>(i));
            continue;
        }
        for (int64_t x = lo[0]; x <= hi[0]; ++x)
            for (int64_t y = lo[1]; y <= hi[1]; ++y)
                for (int64_t z = lo[2]; z <= hi[2]; ++z) cells.push_back({key(x, y, z), static_cast<uint32_t>(i)});
    }
    std::sort(cells.begin(), cells.end());
    for (size_t a = 0; a < cells.size();) {
        size_t b = a;
        while (b < cells.size() && cells[b].first == cells[a].first) ++b;
        for (size_t u = a; u < b; ++u) {
            for (size_t v = u + 1; v < b; ++v) {
                const uint32_t i = cells[u].second, j = cells[v].second;
                if (!overlap(i, j)) continue;
                // Count the pair only in the cell holding its overlap's low corner.
                const uint64_t home = key(index(std::max(box[i * 6], box[j * 6])),
                                          index(std::max(box[i * 6 + 1], box[j * 6 + 1])),
                                          index(std::max(box[i * 6 + 2], box[j * 6 + 2])));
                if (home == cells[a].first) pairs.push_back({std::min(i, j), std::max(i, j)});
            }
        }
        a = b;
    }
    for (const uint32_t i : big) {
        for (size_t j = 0; j < n; ++j) {
            if (!ok[j] || j == i || (is_big[j] && j < i) || !overlap(i, j)) continue;
            pairs.push_back({std::min<uint32_t>(i, static_cast<uint32_t>(j)), std::max<uint32_t>(i, static_cast<uint32_t>(j))});
        }
    }
}

TightSearch tight_search_block(const SourceRefs& sources, const ScreeningConfig& config,
                               int32_t first_step, int32_t step_count) {
    const size_t n = sources.size();
    const double step_days = config.coarse_step_sec / 86400.0;
    const double h = 0.5 * config.coarse_step_sec;
    const int workers = std::max(1, config.num_threads);
    std::vector<std::vector<TightCandidate>> found(workers);
    std::vector<std::map<uint32_t, ExcludedObject>> excluded(workers);
    std::vector<uint64_t> samples(workers, 0);
    for_blocks(step_count, workers, [&](int w, int64_t lo, int64_t hi) {
        clear_error();
        std::vector<StateVector> states(n);
        std::vector<double> deviation(n);
        std::vector<uint8_t> ok(n), dead(n, 0);
        std::string failure;
        TightGridScratch scratch;
        std::vector<std::pair<uint32_t, uint32_t>> pairs;
        for (int64_t s = lo; s < hi; ++s) {
            const int32_t step = first_step + static_cast<int32_t>(s);
            const double jd = config.start_jd + step * step_days;
            for (size_t i = 0; i < n; ++i) {
                ok[i] = 0;
                if (dead[i]) continue;
                ++samples[w];
                if (!tight_sample(*sources[i], jd, h, states[i], deviation[i], failure)) {
                    auto& x = excluded[w][static_cast<uint32_t>(i)];
                    if (x.first_failure_jd == 0.0 || jd < x.first_failure_jd) {
                        x.index = static_cast<uint32_t>(i);
                        x.first_failure_jd = jd;
                        x.reason = failure;
                    }
                    dead[i] = 1;
                    continue;
                }
                ok[i] = 1;
            }
            tight_box_pairs(states, deviation, ok, config.threshold_km, h, scratch, pairs);
            for (const auto& [i, j] : pairs) {
                if (tight_pair_may_close(states[i], deviation[i], states[j], deviation[j], config.threshold_km, h))
                    found[w].push_back({i, j, step});
            }
        }
    });
    TightSearch out;
    for (int w = 0; w < workers; ++w) {
        out.candidates.insert(out.candidates.end(), found[w].begin(), found[w].end());
        out.samples += samples[w];
        for (const auto& [i, x] : excluded[w]) {
            auto it = out.excluded.find(i);
            if (it == out.excluded.end() || x.first_failure_jd < it->second.first_failure_jd) out.excluded[i] = x;
        }
    }
    return out;
}

} // namespace conjunction
