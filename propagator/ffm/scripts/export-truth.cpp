// Read the study's HXSTAT01 T3 truth and sample the same TT coordinate that
// the native harness compares with resident PPE. Physics interpolation stays
// in C++; hx::quintic is the study's two-sided Hermite reader, unchanged.
#include "hxio.h"
#include <algorithm>
#include <stdexcept>

static double elapsed(const hx::Header& h, const hx::StateRecord& r) {
    return (r.whole - h.epochWhole) + (r.fraction - h.epochFraction);
}

int main(int argc, char** argv) {
    try {
        if (argc != 5) throw std::runtime_error("usage: export-truth INPUT.st OUTPUT.f64 INTERVAL_SECONDS DURATION_SECONDS");
        const int interval = std::stoi(argv[3]), duration = std::stoi(argv[4]);
        if (interval <= 0 || duration <= 0 || duration % interval)
            throw std::runtime_error("sampling interval must divide the positive duration");
        hx::Header header{};
        std::vector<hx::StateRecord> states;
        if (!hx::readStates(argv[1], header, states) || states.size() < 2)
            throw std::runtime_error("invalid HXSTAT01 input");
        static_assert(sizeof(hx::StateRecord) == 120, "unexpected HXSTAT01 record layout");
        if (elapsed(header, states.front()) > 1e-9 || elapsed(header, states.back()) < duration - 1e-9)
            throw std::runtime_error("truth does not cover three complete days");
        std::vector<double> rows;
        rows.reserve((duration / interval + 1) * 7);
        std::vector<double> samples;
        for (int second = 0; second <= duration; second += interval) samples.push_back(second);
        // Preserve the native reference's one-second perigee refinement and
        // exact weather stops in addition to the uniform ten-second grid.
        for (const auto& state : states) {
            const double second = elapsed(header, state);
            if (second >= 0 && second <= duration) samples.push_back(second);
        }
        std::sort(samples.begin(), samples.end());
        samples.erase(std::unique(samples.begin(), samples.end(), [](double a, double b) {
            return std::abs(a-b) < 1e-9;
        }), samples.end());
        size_t lo = 0;
        for (const double s : samples) {
            while (lo + 1 < states.size() - 1 && elapsed(header, states[lo + 1]) < s) ++lo;
            const auto& left = states[lo]; const auto& right = states[lo + 1];
            const double t0 = elapsed(header, left), t1 = elapsed(header, right);
            double r[3], v[3];
            if (std::abs(s - t0) < 1e-9 || std::abs(s - t1) < 1e-9) {
                const auto& exact = std::abs(s - t0) < 1e-9 ? left : right;
                std::copy(exact.r, exact.r + 3, r); std::copy(exact.v, exact.v + 3, v);
            } else {
                if (!(t0 <= s && s <= t1) || !std::isfinite(left.aR[0]) || !std::isfinite(right.aL[0]))
                    throw std::runtime_error("truth interpolation bracket or acceleration missing");
                hx::quintic(left.r, left.v, left.aR, right.r, right.v, right.aL, t1 - t0, s - t0, r, v);
            }
            rows.push_back(s);
            for (double value : r) rows.push_back(value / 1000.0);
            for (double value : v) rows.push_back(value / 1000.0);
        }
        const unsigned short endian = 1;
        if (*reinterpret_cast<const unsigned char*>(&endian) != 1) throw std::runtime_error("export requires a little-endian host");
        hx::spit(argv[2], rows.data(), rows.size() * sizeof(double));
        std::printf("{\"label\":\"%s\",\"inputRecords\":%u,\"rows\":%zu,\"epochWholeTt\":%.17g,\"epochFractionTt\":%.17g,\"sourceSettings\":%s}\n",
                    header.label, header.count, rows.size() / 7, header.epochWhole, header.epochFraction, header.meta);
    } catch (const std::exception& error) {
        std::fprintf(stderr, "export-truth: %s\n", error.what()); return 1;
    }
}
