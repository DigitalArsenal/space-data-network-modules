// Track stripe filter for the LOLA LDEM simple cylindrical grids outside SLDEM2015 (stack #658).
//
// Poleward of SLDEM2015's 60 deg the Moon's relief is LOLA alone (LDEM_128/256/512): the products interpolate between
// ground tracks, and each track stands a few metres off its neighbours, so thin lines run along the tracks. Draped over
// a lit crater wall they read as fine parallel stripes. LRO's near-polar orbit puts the tracks close to the meridians,
// tilted by the track azimuth az = asin(cos i / cos lat): measured at 62 S, 69 S, 78 S and 70 N on LDEM_512, the
// stripe energy peaks at a shear of 0 (inclination 90) and at the shear of inclination 88 (0.25 columns a line at
// 68.9 S). The filter is body_destripe.hpp's rule taken along the tracks, in three passes (shear 0, then +s and -s,
// s = tan(az) / cos lat columns a line for i = 88 deg): the high-pass is the post minus a Gaussian of its row whose
// sigma is the same ground width at every latitude (59 m, one SLDEM2015_512 post at the equator: (ppd / 512) / cos lat
// posts, at least one), 3 sigma either side; the stripe at a post is the median of that high-pass over the
// kBodyTrackRows lines north and south of it, read along the shear (linear between columns), which the post gives up.
// A crater wall is curved and keeps its high-pass; a line of posts coherent along a track over 11 lines does not.
//
// The result at a post is a pure function of the posts within 3 * kBodyTrackRows lines and 3 * reach columns of it:
// a pass at line gy reads its own and its neighbours' high-pass within kBodyTrackRows lines and
// reach = ceil(3 sigma) + ceil(|s| kBodyTrackRows) + 1 columns (sigma and s of each line's own latitude, so a pure
// function of the global line). `reach` is the product's declared bound (terrain-ingest asks for the lines and
// columns); a line whose own reach exceeds it is kept, as is a post whose neighbourhood leaves the settled region or
// holds no-data, so every invoke whose window holds that neighbourhood computes the same height.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

constexpr long kBodyTrackRows = 5;
constexpr double kBodyTrackCosInclination = 0.03489949670250097;  // cos(88 deg)
constexpr double kBodyTrackWidthPpd = 512.0;                        // sigma: one post of a 512 ppd grid at the equator

inline double body_track_sigma(double lat_deg, double ppd) {
    return std::max(1.0, ppd / kBodyTrackWidthPpd / std::cos(lat_deg * 3.14159265358979323846 / 180.0));
}
inline double body_track_shear(double lat_deg) {
    const double c = std::cos(lat_deg * 3.14159265358979323846 / 180.0);
    const double s = std::min(0.99, kBodyTrackCosInclination / c);
    return std::tan(std::asin(s)) / c;
}
inline long body_track_reach(double lat_deg, double ppd) {
    return static_cast<long>(std::ceil(3.0 * body_track_sigma(lat_deg, ppd))) +
           static_cast<long>(std::ceil(body_track_shear(lat_deg) * kBodyTrackRows)) + 1;
}

// z: row-major w x h posts of a linear lon/lat grid; line y is global line row0 + y, centred on
// origin_lat - (row0 + y) * scale_lat. The settled region is [sr0, sr1) x [sc0, sc1); the posts written are columns
// [c0, c1) of the lines 3 * kBodyTrackRows inside the settled lines. Returns the posts written.
inline uint64_t body_track_destripe(std::vector<float>* zp, uint32_t w, uint32_t h, long c0, long c1, long sr0, long sr1,
                                    long sc0, long sc1, float nodata, double origin_lat, double scale_lat, long row0,
                                    double ppd, long reach) {
    std::vector<float>& z = *zp;
    const long RY = kBodyTrackRows;
    sr0 = std::max(0L, sr0), sr1 = std::min(static_cast<long>(h), sr1);
    sc0 = std::max(0L, sc0), sc1 = std::min(static_cast<long>(w), sc1);
    if (sr1 - sr0 < 6 * RY + 1) return 0;
    const auto lat_of = [&](long y) { return origin_lat - static_cast<double>(row0 + y) * scale_lat; };
    // Per line: sigma, its Gaussian, the shear and whether the line's reach is within the declared bound.
    std::vector<std::vector<double>> kern(h);
    std::vector<double> shear(h, 0.0);
    std::vector<char> line_ok(h, 0);
    for (long y = sr0; y < sr1; y++) {
        const double lat = lat_of(y), sig = body_track_sigma(lat, ppd);
        const long rx = static_cast<long>(std::ceil(3.0 * sig));
        if (body_track_reach(lat, ppd) > reach) continue;
        std::vector<double>& k = kern[y];
        k.resize(2 * rx + 1);
        double ks = 0;
        for (long i = -rx; i <= rx; i++) ks += k[i + rx] = std::exp(-0.5 * (i / sig) * (i / sig));
        for (double& v : k) v /= ks;
        shear[y] = body_track_shear(lat);
        line_ok[y] = 1;
    }
    const double sign[3] = {0.0, 1.0, -1.0};
    long r0 = sr0, r1 = sr1;   // lines whose values the pass reads (settled by the previous stage)
    uint64_t written = 0;
    for (int pass = 0; pass < 3; pass++) {
        // Columns this pass writes: the final columns widened by the reach of the passes still to come.
        const long grow = static_cast<long>(2 - pass) * reach;
        const long x0 = std::max(sc0 + reach, c0 - grow), x1 = std::min(sc1 - reach, c1 + grow);
        if (x1 <= x0) return written;
        // The high-pass of every read line over the columns the sheared medians reach.
        const long hx0 = x0 - (reach - 1), hx1 = x1 + (reach - 1);
        const long hw = hx1 - hx0;
        std::vector<double> hp(static_cast<size_t>(hw) * (r1 - r0), NAN);
        for (long y = r0; y < r1; y++) {
            if (!line_ok[y]) continue;
            const std::vector<double>& k = kern[y];
            const long rx = static_cast<long>(k.size() / 2);
            for (long x = hx0; x < hx1; x++) {
                if (x - rx < sc0 || x + rx >= sc1) continue;
                double lp = 0;
                bool ok = true;
                for (long i = -rx; i <= rx; i++) {
                    const float v = z[static_cast<size_t>(y) * w + (x + i)];
                    if (v == nodata) { ok = false; break; }
                    lp += k[i + rx] * v;
                }
                if (ok) hp[static_cast<size_t>(y - r0) * hw + (x - hx0)] = z[static_cast<size_t>(y) * w + x] - lp;
            }
        }
        std::vector<std::pair<size_t, float>> out;
        double win[2 * kBodyTrackRows + 1];
        for (long y = r0 + RY; y < r1 - RY; y++) {
            if (!line_ok[y]) continue;
            const double s = sign[pass] * shear[y];
            for (long x = x0; x < x1; x++) {
                bool ok = true;
                for (long dy = -RY; dy <= RY && ok; dy++) {
                    const double xf = static_cast<double>(x - hx0) + s * static_cast<double>(dy);
                    const long xi = static_cast<long>(std::floor(xf));
                    const double f = xf - static_cast<double>(xi);
                    if (xi < 0 || xi + 1 >= hw) { ok = false; break; }
                    const double* row = &hp[static_cast<size_t>(y + dy - r0) * hw];
                    const double v = f == 0.0 ? row[xi] : row[xi] * (1.0 - f) + row[xi + 1] * f;
                    if (std::isnan(v)) ok = false;
                    win[dy + RY] = v;
                }
                if (!ok) continue;
                std::nth_element(win, win + RY, win + 2 * RY + 1);
                out.push_back({static_cast<size_t>(y) * w + x, static_cast<float>(z[static_cast<size_t>(y) * w + x] - win[RY])});
            }
        }
        for (const auto& [p, v] : out) z[p] = v;
        written = out.size();
        r0 += RY, r1 -= RY;
        sc0 = x0, sc1 = x1;   // the next pass reads only what this one settled
    }
    return written;
}
