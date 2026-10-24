// Spike/pit filter for a body's simple cylindrical source grid (SLDEM2015_512).
//
// SLDEM2015 inherits isolated bad LOLA shots: posts tens to hundreds of metres
// off the surface, one or two posts wide and a few long along the ground track
// (Hadley, 26.137N 3.585E: -150 m against the 5 m NAC DTM, which is flat). No
// real relief that narrow is that deep, so a post more than T from the median
// of its 5x5 is an artifact (a "core"). Two rings of same-sign neighbours that
// stand more than T/4 off the median of their 5x5 without the flagged posts are
// the core's shoulders. Every flagged post takes the median of the unflagged
// posts of its 7x7 (its 5x5 median when fewer than 9 remain).
//
// The result at a post is a pure function of the posts within kBodyDespikeRadius
// of it, so every invoke whose window holds that neighbourhood computes the same
// height; a post whose neighbourhood leaves the window or holds no-data is kept.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

constexpr long kBodyDespikeRadius = 9;

struct BodyDespikeStats {
    uint64_t cores = 0, changed = 0;
    double max_change_m = 0;
};

namespace body_despike_detail {

inline double median_of(std::vector<double>& v) {
    const size_t n = v.size(), m = n / 2;
    std::nth_element(v.begin(), v.begin() + m, v.end());
    const double hi = v[m];
    if (n % 2) return hi;
    return 0.5 * (hi + *std::max_element(v.begin(), v.begin() + m));
}

}  // namespace body_despike_detail

// z: row-major w x h posts; only columns [c0, c1) (clamped) are computed.
inline BodyDespikeStats body_despike(std::vector<float>* zp, uint32_t w, uint32_t h, long c0, long c1,
                                     double threshold_m, float nodata) {
    using body_despike_detail::median_of;
    BodyDespikeStats stats;
    std::vector<float>& z = *zp;
    const long R = kBodyDespikeRadius;
    const long W = static_cast<long>(w), H = static_cast<long>(h);
    // Work region: the requested columns plus the stencil radius.
    const long x0 = std::max(0L, c0 - R), x1 = std::min(W, c1 + R);
    if (x1 - x0 < 2 * R + 1 || H < 2 * R + 1) return stats;
    const long rw = x1 - x0;
    const auto at = [&](long y, long x) { return z[static_cast<size_t>(y) * w + x]; };
    const auto idx = [&](long y, long x) { return static_cast<size_t>(y) * rw + (x - x0); };
    // Residual from the 5x5 median; NaN where the 5x5 leaves the region or holds no-data.
    std::vector<double> m5(static_cast<size_t>(rw) * H, NAN);
    std::vector<int8_t> flag(m5.size(), 0);  // sign of a flagged post's residual (+1 / -1), 0 = unflagged
    std::vector<uint8_t> core(m5.size(), 0);
    std::vector<double> win;
    win.reserve(49);
    for (long y = 2; y < H - 2; y++) {
        for (long x = x0 + 2; x < x1 - 2; x++) {
            win.clear();
            bool ok = true;
            for (long dy = -2; dy <= 2 && ok; dy++)
                for (long dx = -2; dx <= 2; dx++) {
                    const float v = at(y + dy, x + dx);
                    if (v == nodata) { ok = false; break; }
                    win.push_back(v);
                }
            if (!ok) continue;
            const double med = median_of(win);
            m5[idx(y, x)] = med;
            const double r = at(y, x) - med;
            if (std::fabs(r) > threshold_m) {
                core[idx(y, x)] = 1;
                flag[idx(y, x)] = r > 0 ? 1 : -1;
            }
        }
    }
    // Two rings, each judged against the posts flagged before it.
    std::vector<uint8_t> front = core;
    for (int ring = 0; ring < 2; ring++) {
        std::vector<std::pair<size_t, int8_t>> add;
        for (long y = 2; y < H - 2; y++) {
            for (long x = x0 + 2; x < x1 - 2; x++) {
                const size_t q = idx(y, x);
                if (flag[q] || std::isnan(m5[q])) continue;
                bool near_pos = false, near_neg = false;
                for (long dy = -1; dy <= 1; dy++)
                    for (long dx = -1; dx <= 1; dx++) {
                        const long a = y + dy, b = x + dx;
                        if (a < 0 || a >= H || b < x0 || b >= x1) continue;
                        const size_t p = idx(a, b);
                        if (!front[p]) continue;
                        if (flag[p] > 0) near_pos = true; else near_neg = true;
                    }
                if (!near_pos && !near_neg) continue;
                win.clear();
                for (long dy = -2; dy <= 2; dy++)
                    for (long dx = -2; dx <= 2; dx++)
                        if (!flag[idx(y + dy, x + dx)]) win.push_back(at(y + dy, x + dx));
                if (win.empty()) continue;
                const double r = at(y, x) - median_of(win);
                if (std::fabs(r) > threshold_m / 4 && ((r > 0 && near_pos) || (r < 0 && near_neg)))
                    add.push_back({q, static_cast<int8_t>(r > 0 ? 1 : -1)});
            }
        }
        std::fill(front.begin(), front.end(), 0);
        for (const auto& [q, s] : add) { flag[q] = s; front[q] = 1; }
    }
    // Fill, writing only posts whose whole radius-R neighbourhood is in the region and measured.
    std::vector<std::pair<size_t, float>> out;
    for (long y = R; y < H - R; y++) {
        for (long x = std::max(x0 + R, c0); x < std::min(x1 - R, c1); x++) {
            const size_t q = idx(y, x);
            if (!flag[q]) continue;
            bool ok = true;
            for (long dy = -R; dy <= R && ok; dy++)
                for (long dx = -R; dx <= R; dx++)
                    if (at(y + dy, x + dx) == nodata) { ok = false; break; }
            if (!ok) continue;
            win.clear();
            for (long dy = -3; dy <= 3; dy++)
                for (long dx = -3; dx <= 3; dx++)
                    if (!flag[idx(y + dy, x + dx)]) win.push_back(at(y + dy, x + dx));
            const double v = win.size() >= 9 ? median_of(win) : m5[q];
            out.push_back({static_cast<size_t>(y) * w + x, static_cast<float>(v)});
            if (core[q]) stats.cores++;
            stats.changed++;
            stats.max_change_m = std::max(stats.max_change_m, std::fabs(v - at(y, x)));
        }
    }
    for (const auto& [p, v] : out) z[p] = v;
    return stats;
}
