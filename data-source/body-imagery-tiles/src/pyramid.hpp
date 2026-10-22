// THE TILE GEOMETRY AND THE DEEPEST LEVEL'S RESAMPLING.
//
// The engine's GeographicTilingScheme on the body's sphere (GEOGRAPHIC_TWO_ROOT_BODY): level L is 2^(L+1) x 2^L tiles
// of 256 px, x from 180 W, planetocentric latitude (the console draws Mars on the MOLA reference sphere, where geodetic
// and planetocentric latitude are one). Rows are counted from the SOUTH in the files, from the north in the pixels.
// Level 9 is 262144 x 131072 px (81.4 m at the equator, 1.23 x the 100 m source).
//
// The deepest level's rows are area averages of the source (resample_row): each output pixel is the mean of the source
// pixels it overlaps, weighted by the overlap, over the measured ones (0 is no data). A coarser level is the 2 x 2 mean
// of the measured pixels of the level below (halve).
#pragma once
#include <cmath>
#include <cstdint>
#include <functional>
#include <vector>

#include "source.hpp"

namespace bit {

constexpr int kTile = 256;

inline uint64_t level_width(int level) { return uint64_t(2 * kTile) << level; }  // pixels around
inline uint64_t level_rows(int level) { return uint64_t(kTile) << level; }       // pixels pole to pole

// The source columns one output column overlaps (at most two: an output pixel is 0.81 of a source pixel), with
// their overlap in source pixels.
struct ColumnTap {
    uint32_t i0, i1;
    float w0, w1;
};

// Output columns of the deepest level -> source columns, once per cycle. Longitude -180 + (c + f) * 360 / W, as east
// longitude in [0, 360); the source wraps (its 213390 columns span 360.0007 degrees).
inline std::vector<ColumnTap> column_taps(const Source& s, int level) {
    const uint64_t W = level_width(level);
    std::vector<ColumnTap> taps(W);
    const double step = 360.0 / double(W);
    const double width_px = step * m_per_deg(s) / s.pixel_m;
    for (uint64_t c = 0; c < W; c++) {
        double lon = -180.0 + double(c) * step;
        if (lon < 0) lon += 360.0;
        const double a = source_col(s, lon), b = a + width_px;
        const double fa = std::floor(a);
        ColumnTap t;
        const auto wrap = [&](double i) {
            long long k = static_cast<long long>(i) % static_cast<long long>(s.width);
            if (k < 0) k += static_cast<long long>(s.width);
            return uint32_t(k);
        };
        t.i0 = wrap(fa);
        if (b <= fa + 1.0) {
            t.w0 = float(b - a);
            t.i1 = t.i0;
            t.w1 = 0.0f;
        } else {
            t.w0 = float(fa + 1.0 - a);
            t.i1 = wrap(fa + 1.0);
            t.w1 = float(b - (fa + 1.0));
        }
        taps[c] = t;
    }
    return taps;
}

// The source rows a level-`level` tile row needs: [first, last], clamped to the image.
inline void source_rows_for(const Source& s, int level, uint64_t y, uint64_t* first, uint64_t* last) {
    const double e = 180.0 / double(level_rows(level));
    const double north = 90.0 - double(y * kTile) * e, south = north - double(kTile) * e;
    const double a = std::floor(source_row(s, north)), b = std::ceil(source_row(s, south)) - 1.0;
    *first = a < 0 ? 0 : uint64_t(a);
    *last = b > double(s.height - 1) ? s.height - 1 : uint64_t(b);
}

// One tile row of the deepest level from the source rows [first, first + rows) in `px` (row-major, s.width each):
// 256 x W bytes into `out`.
inline void resample_row(const Source& s, int level, uint64_t y, const uint8_t* px, uint64_t first, uint64_t rows,
                         const std::vector<ColumnTap>& taps, std::vector<uint8_t>* out) {
    const uint64_t W = level_width(level);
    out->assign(W * kTile, 0);
    const double e = 180.0 / double(level_rows(level));
    std::vector<float> sum(W), weight(W);
    for (int r = 0; r < kTile; r++) {
        const double north = 90.0 - double(y * kTile + r) * e;
        const double va = source_row(s, north), vb = source_row(s, north - e);
        std::fill(sum.begin(), sum.end(), 0.0f);
        std::fill(weight.begin(), weight.end(), 0.0f);
        for (double j = std::floor(va); j < vb; j += 1.0) {
            if (j < double(first) || j >= double(first + rows)) continue;
            const float wr = float(std::min(vb, j + 1.0) - std::max(va, j));
            if (wr <= 0) continue;
            const uint8_t* line = px + uint64_t(j - double(first)) * s.width;
            for (uint64_t c = 0; c < W; c++) {
                const ColumnTap& t = taps[c];
                const uint8_t a = line[t.i0], b = line[t.i1];
                if (a) { sum[c] += wr * t.w0 * a; weight[c] += wr * t.w0; }
                if (t.w1 > 0 && b) { sum[c] += wr * t.w1 * b; weight[c] += wr * t.w1; }
            }
        }
        uint8_t* dst = out->data() + uint64_t(r) * W;
        for (uint64_t c = 0; c < W; c++) {
            if (weight[c] <= 0) continue;
            const float v = std::round(sum[c] / weight[c]);
            dst[c] = uint8_t(v < 1 ? 1 : (v > 255 ? 255 : v));
        }
    }
}

// An image of `w` x `h` bytes halved to w/2 x h/2: each pixel the mean of the measured (non-zero) pixels of its 2 x 2
// block, 0 where none was measured.
inline std::vector<uint8_t> halve(const std::vector<uint8_t>& img, size_t w, size_t h) {
    const size_t nw = w / 2, nh = h / 2;
    std::vector<uint8_t> out(nw * nh);
    for (size_t r = 0; r < nh; r++) {
        const uint8_t* a = &img[2 * r * w];
        const uint8_t* b = a + w;
        uint8_t* dst = &out[r * nw];
        for (size_t c = 0; c < nw; c++) {
            const uint8_t v[4] = {a[2 * c], a[2 * c + 1], b[2 * c], b[2 * c + 1]};
            unsigned sum = 0, n = 0;
            for (const uint8_t x : v)
                if (x) { sum += x; n++; }
            dst[c] = n ? uint8_t((sum + n / 2) / n) : 0;
        }
    }
    return out;
}

}  // namespace bit
