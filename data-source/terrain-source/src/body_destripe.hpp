// North-south stripe filter for a body's simple cylindrical source grid (SLDEM2015_512).
//
// SLDEM2015 carries thin north-south lines along the ground tracks: a column or a few columns stand a few meters
// off their east-west neighbors, the offset drifting slowly along the track (Bessel, 21.7N 18.0E: per-column
// east-west kink p90 4.4 m against 1.1 m in a typical column; north-south kink 1.7 m). Draped over relief and seen
// obliquely they read as curved lines. The stripe is the part of the east-west high-pass that is coherent north-south:
// the high-pass is the post minus a Gaussian (sigma one post, kBodyDestripeCols either side) of its row, and the
// stripe at a post is the median of that high-pass over the kBodyDestripeRows posts north and south of it, which the
// post gives up. A crater or a scarp shorter than the median keeps its high-pass; a long north-south scarp is a step,
// whose high-pass is small away from its edge (Rupes Recta keeps its 380 m relief).
//
// The result at a post is a pure function of the posts within kBodyDestripeRows lines and kBodyDestripeCols columns
// of it, read only from the settled region [sr0, sr1) x [sc0, sc1) (posts an earlier stage computed the same in every
// window), so every invoke whose window holds that neighborhood computes the same height; a post whose neighborhood
// leaves the settled region or holds no-data is kept.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

constexpr long kBodyDestripeRows = 5;
constexpr long kBodyDestripeCols = 3;

// z: row-major w x h posts; only columns [c0, c1) are written.
inline uint64_t body_destripe(std::vector<float>* zp, uint32_t w, uint32_t h, long c0, long c1, long sr0, long sr1,
                              long sc0, long sc1, float nodata) {
    std::vector<float>& z = *zp;
    const long RY = kBodyDestripeRows, RX = kBodyDestripeCols;
    sr0 = std::max(0L, sr0), sr1 = std::min(static_cast<long>(h), sr1);
    sc0 = std::max(0L, sc0), sc1 = std::min(static_cast<long>(w), sc1);
    // The written columns, and the columns whose high-pass they read.
    const long x0 = std::max(sc0 + RX, c0), x1 = std::min(sc1 - RX, c1);
    if (x1 <= x0 || sr1 - sr0 < 2 * RY + 1) return 0;
    // Gaussian weights, sigma one post, normalized over the 2 * RX + 1 posts.
    double k[2 * kBodyDestripeCols + 1], ksum = 0;
    for (long i = -RX; i <= RX; i++) ksum += k[i + RX] = std::exp(-0.5 * static_cast<double>(i * i));
    for (double& v : k) v /= ksum;
    const long rw = x1 - x0, rh = sr1 - sr0;
    const auto at = [&](long y, long x) { return z[static_cast<size_t>(y) * w + x]; };
    std::vector<double> hp(static_cast<size_t>(rw) * rh, NAN);  // NaN: the row window holds no-data
    for (long y = sr0; y < sr1; y++) {
        for (long x = x0; x < x1; x++) {
            double lp = 0;
            bool ok = true;
            for (long i = -RX; i <= RX; i++) {
                const float v = at(y, x + i);
                if (v == nodata) { ok = false; break; }
                lp += k[i + RX] * v;
            }
            if (ok) hp[static_cast<size_t>(y - sr0) * rw + (x - x0)] = at(y, x) - lp;
        }
    }
    std::vector<std::pair<size_t, float>> out;
    double win[2 * kBodyDestripeRows + 1];
    for (long y = sr0 + RY; y < sr1 - RY; y++) {
        for (long x = x0; x < x1; x++) {
            bool ok = true;
            for (long dy = -RY; dy <= RY; dy++) {
                const double v = hp[static_cast<size_t>(y + dy - sr0) * rw + (x - x0)];
                if (std::isnan(v)) { ok = false; break; }
                win[dy + RY] = v;
            }
            if (!ok) continue;
            std::nth_element(win, win + RY, win + 2 * RY + 1);
            out.push_back({static_cast<size_t>(y) * w + x, static_cast<float>(at(y, x) - win[RY])});
        }
    }
    for (const auto& [p, v] : out) z[p] = v;
    return out.size();
}
