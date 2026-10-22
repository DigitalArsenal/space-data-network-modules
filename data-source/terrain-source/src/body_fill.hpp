// Pure height-field math: no frames, projections, meshing, or runtime state.
// Distances are to invalid source posts on the GLOBAL pixel lattice. The exact
// separable squared Euclidean transform supplies a cheap exclusion bound; near
// holes a row search gives the exact distance even at fractional pixel positions
// (interpolating an EDT would not be exact there).
struct BodyFillStats {
    uint64_t filled_posts = 0, feathered_posts = 0;
    double max_feather_dev_m = 0;
};

double body_smoothstep(double t) { return t * t * (3.0 - 2.0 * t); }

bool body_blend(double p, bool valid_p, double f, bool valid_f, double distance_m,
                double band_m, double* height, BodyFillStats* stats = nullptr) {
    if (valid_p && distance_m >= band_m) { *height = p; return true; }
    if (!valid_f) return false;
    if (!valid_p) {
        *height = f;
        if (stats) stats->filled_posts++;
    } else {
        // At the seam return f itself, including its exact double representation.
        *height = distance_m <= 0 ? f : f + body_smoothstep(distance_m / band_m) * (p - f);
        if (stats) {
            stats->feathered_posts++;
            stats->max_feather_dev_m = std::max(stats->max_feather_dev_m, std::fabs(*height - p));
        }
    }
    return true;
}

struct BodyInvalidDistance {
    uint32_t width = 0, height = 0;
    long off_x = 0, off_y = 0;
    std::vector<double> squared;
    std::vector<std::vector<uint32_t>> invalid_rows;

    // Felzenszwalb/Huttenlocher lower envelope of parabolas, squared pixels.
    // A finite sentinel exceeds the greatest possible distance on these grids.
    void build(const std::vector<float>& samples, uint32_t w, uint32_t h,
               long x, long y, float nodata) {
        width = w; height = h; off_x = x; off_y = y;
        if (std::find(samples.begin(), samples.end(), nodata) == samples.end()) return;
        constexpr double inf = 1e15;
        invalid_rows.resize(h);
        squared.assign(static_cast<size_t>(w) * h, inf);
        for (uint32_t j = 0; j < h; j++) {
            auto& holes = invalid_rows[j];
            for (uint32_t i = 0; i < w; i++)
                if (samples[static_cast<size_t>(j) * w + i] == nodata) holes.push_back(i);
            if (holes.empty()) continue;
            size_t k = 0;
            for (uint32_t i = 0; i < w; i++) {
                while (k + 1 < holes.size() && 2 * i > holes[k] + holes[k + 1]) k++;
                const int64_t d = static_cast<int64_t>(i) - holes[k];
                squared[static_cast<size_t>(j) * w + i] = static_cast<double>(d * d);
            }
        }
        std::vector<double> f(h), z(h + 1);
        std::vector<uint32_t> v(h);
        for (uint32_t i = 0; i < w; i++) {
            for (uint32_t j = 0; j < h; j++) f[j] = squared[static_cast<size_t>(j) * w + i];
            int k = 0;
            v[0] = 0; z[0] = -1e300; z[1] = 1e300;
            for (uint32_t q = 1; q < h; q++) {
                double s;
                do {
                    const double r = v[k];
                    s = ((f[q] + static_cast<double>(q) * q) - (f[v[k]] + r * r)) / (2.0 * (q - r));
                    if (s > z[k]) break;
                    k--;
                } while (k >= 0);
                k++; v[k] = q; z[k] = s; z[k + 1] = 1e300;
            }
            k = 0;
            for (uint32_t q = 0; q < h; q++) {
                while (z[k + 1] < q) k++;
                const double d = static_cast<double>(q) - v[k];
                squared[static_cast<size_t>(q) * w + i] = d * d + f[v[k]];
            }
        }
    }

    double distance(double global_x, double global_y, double limit_pixels) const {
        if (squared.empty()) return limit_pixels;
        const long ix = static_cast<long>(std::floor(global_x + 0.5)) - off_x;
        const long iy = static_cast<long>(std::floor(global_y + 0.5)) - off_y;
        if (ix < 0 || iy < 0 || ix >= width || iy >= height) return 0;
        // Triangle inequality: the nearest integer grid point is <= sqrt(.5) away.
        if (std::sqrt(squared[static_cast<size_t>(iy) * width + ix]) - 0.7071067811865476 >= limit_pixels)
            return limit_pixels;
        double best = limit_pixels * limit_pixels;
        const long first = std::max<long>(0, static_cast<long>(std::ceil(global_y - limit_pixels)) - off_y);
        const long last = std::min<long>(height - 1, static_cast<long>(std::floor(global_y + limit_pixels)) - off_y);
        for (long j = first; j <= last; j++) {
            const auto& holes = invalid_rows[j];
            const auto next = std::lower_bound(holes.begin(), holes.end(), global_x - off_x);
            const double dy = static_cast<double>(j + off_y) - global_y;
            const auto probe = [&](uint32_t i) {
                const double dx = (static_cast<double>(i) + off_x) - global_x;
                best = std::min(best, dx * dx + dy * dy);
            };
            if (next != holes.end()) probe(*next);
            if (next != holes.begin()) probe(*(next - 1));
        }
        return std::sqrt(best);
    }
};
