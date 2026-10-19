// THE TILE PYRAMID, BUILT IN ONE PASS FROM NORTH TO SOUTH.
//
// The engine's GeographicTilingScheme on the body's sphere: level L is 2^(L+1)
// x 2^L tiles of 256 px, x from 180 W, y from the north pole, planetocentric
// latitude (the console draws Mars on the MOLA reference sphere, where geodetic
// and planetocentric latitude are one). Level 9 is 262144 x 131072 px (81.4 m
// at the equator, 1.23 x the 100 m source).
//
// The deepest level's rows are area averages of the source (resample_row):
// each output pixel is the mean of the source pixels it overlaps, weighted by
// the overlap, over the measured ones (0 is no data). Every coarser level is
// the 2 x 2 mean of the measured pixels of the level below (reduce_into), so
// the whole pyramid is the area average of the source at every level, from
// one read of it.
//
// A tile row is complete when its 256 pixel rows are. The level-9 row is made,
// cut into tiles and reduced into the top or bottom half of its parent's row;
// a parent whose two halves are filled is complete in turn, and so on to level
// 0, so at most one row per level is ever held (level 8 is 33.5 MB, each level
// above half the one below).
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

// One completed tile row of `level` (256 x level_width bytes) halved into the top or bottom half of its parent row.
inline void reduce_into(const std::vector<uint8_t>& child, int level, bool bottom, std::vector<uint8_t>* parent) {
    const uint64_t W = level_width(level), PW = W / 2;
    if (parent->size() != PW * kTile) parent->assign(PW * kTile, 0);
    const int r0 = bottom ? kTile / 2 : 0;
    for (int r = 0; r < kTile / 2; r++) {
        const uint8_t* a = child.data() + uint64_t(2 * r) * W;
        const uint8_t* b = a + W;
        uint8_t* dst = parent->data() + uint64_t(r0 + r) * PW;
        for (uint64_t c = 0; c < PW; c++) {
            const uint8_t v[4] = {a[2 * c], a[2 * c + 1], b[2 * c], b[2 * c + 1]};
            unsigned sum = 0, n = 0;
            for (const uint8_t x : v)
                if (x) { sum += x; n++; }
            dst[c] = n ? uint8_t((sum + n / 2) / n) : 0;
        }
    }
}

// The rows held above the deepest level: per level its current tile row (y), which halves are filled, its pixels.
struct Pending {
    long long y = -1;
    unsigned halves = 0;  // 1 top, 2 bottom
    std::vector<uint8_t> px;
};

// A completed tile row goes to `emit`; its reduction climbs into the parents. A parent row whose top half was not
// made in this cycle (a cycle over some bands only) is never emitted.
struct Pyramid {
    int max_level = 9;
    std::vector<Pending> pending;  // index = level
    std::function<bool(int level, uint64_t y, const std::vector<uint8_t>& row)> emit;

    explicit Pyramid(int deepest) : max_level(deepest), pending(size_t(deepest) + 1) {}

    bool complete(int level, uint64_t y, const std::vector<uint8_t>& row) {
        if (!emit(level, y, row)) return false;
        if (level == 0) return true;
        Pending& p = pending[size_t(level - 1)];
        const long long py = static_cast<long long>(y / 2);
        if (p.y != py) {
            p.y = py;
            p.halves = 0;
        }
        reduce_into(row, level, (y & 1) != 0, &p.px);
        p.halves |= (y & 1) ? 2u : 1u;
        if (p.halves != 3u) return true;
        p.halves = 0;
        p.y = -1;
        std::vector<uint8_t> parent;
        parent.swap(p.px);
        return complete(level - 1, uint64_t(py), parent);
    }
};

}  // namespace bit
