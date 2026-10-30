// Dense brute force for tests/sampledCoverage.e2e.mjs: the conjunctions of
// every pair of sampled tracks in each window, on the module's own cubic
// Hermite interpolant (OEMEphemerisSource, built from the same sample epochs
// the bridge computes for a compact OEM grid: START_TIME + k * STEP_SIZE),
// with none of the screen's logic.
//
// Each pair's joint coverage (the later first sample to the earlier last
// one), widened past the window by a minute where it has samples: the range
// every second (and at the coverage end), a sample below both neighbours and
// under the threshold plus 16 km (a second of relative motion) brackets a
// minimum, refined by golden section on its neighbours to 0.1 ms. A minimum
// within the threshold, strictly inside the joint coverage, whose TCA lies in
// the window [start, end), is the window's conjunction.
//
// usage: sampled_brute_force <tracks.txt> <threshold km> <window start ISO> <window seconds> [...]
// tracks.txt: a count, then per track "<OBJECT_ID> <NORAD> <START_TIME> <STEP s> <states>"
// followed by that many lines "x y z vx vy vz" (km, km/s).
// Prints one JSON object: {"windows":[{"start_jd","events":[{"a","b","tca_jd","miss_km"}]}]}.
#include "conjunction/ephemeris_source.h"
#include "conjunction/error_status.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <memory>
#include <string>
#include <vector>

using namespace conjunction;

namespace {

constexpr double SECOND_DAYS = 1.0 / 86400.0;
constexpr double TOLERANCE_DAYS = 1e-4 / 86400.0;

struct Track {
    std::string id;
    int norad = 0;
    std::unique_ptr<OEMEphemerisSource> source;
    double first = 0, last = 0;
};

double range_km(const Track& a, const Track& b, double jd) {
    clear_error();
    const StateVector p = a.source->state_at(jd), q = b.source->state_at(jd);
    if (has_error()) { clear_error(); return NAN; }
    return std::sqrt((p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y) + (p.z - q.z) * (p.z - q.z));
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 5 || (argc - 3) % 2 != 0) {
        std::fprintf(stderr, "usage: %s <tracks.txt> <threshold km> <window start ISO> <window seconds> [...]\n", argv[0]);
        return 2;
    }
    std::ifstream in(argv[1]);
    size_t count = 0;
    in >> count;
    std::vector<Track> tracks(count);
    for (auto& t : tracks) {
        std::string start_iso;
        double step = 0;
        size_t states = 0;
        in >> t.id >> t.norad >> start_iso >> step >> states;
        const double start = iso_to_jd(start_iso);
        std::vector<EphemerisPoint> points(states);
        for (size_t k = 0; k < states; ++k) {
            auto& p = points[k];
            p.jd = start + k * step / 86400.;
            in >> p.x >> p.y >> p.z >> p.vx >> p.vy >> p.vz;
        }
        if (!in || states < 2) { std::fprintf(stderr, "cannot read track %s\n", t.id.c_str()); return 1; }
        t.first = points.front().jd;
        t.last = points.back().jd;
        t.source = std::make_unique<OEMEphemerisSource>(std::move(points), t.id, t.id, t.norad);
    }
    const double threshold_km = std::stod(argv[2]);
    std::printf("{\"windows\":[");
    for (int w = 3; w + 1 < argc; w += 2) {
        const double ws = iso_to_jd(argv[w]), we = ws + std::stod(argv[w + 1]) / 86400.0;
        std::printf("%s{\"start_jd\":%.17g,\"events\":[", w == 3 ? "" : ",", ws);
        bool first = true;
        for (size_t i = 0; i < tracks.size(); ++i) {
            for (size_t j = i + 1; j < tracks.size(); ++j) {
                const auto& a = tracks[i];
                const auto& b = tracks[j];
                const double cov_lo = std::max(a.first, b.first), cov_hi = std::min(a.last, b.last);
                const double lo = std::max(cov_lo, ws - 60 * SECOND_DAYS), hi = std::min(cov_hi, we + 60 * SECOND_DAYS);
                if (!(hi > lo)) continue;
                std::vector<double> jds, ranges;
                for (double jd = lo; jd < hi; jd += SECOND_DAYS) {
                    jds.push_back(jd);
                    ranges.push_back(range_km(a, b, jd));
                }
                jds.push_back(hi);
                ranges.push_back(range_km(a, b, hi));
                for (size_t k = 1; k + 1 < jds.size(); ++k) {
                    if (!(ranges[k] < ranges[k - 1] && ranges[k] <= ranges[k + 1] &&
                          ranges[k] < threshold_km + 16.0)) {
                        continue;
                    }
                    const double phi = (std::sqrt(5.0) - 1.0) / 2.0;
                    double l = jds[k - 1], h = jds[k + 1];
                    while (h - l > TOLERANCE_DAYS) {
                        const double c = h - phi * (h - l), d = l + phi * (h - l);
                        if (range_km(a, b, c) < range_km(a, b, d)) h = d; else l = c;
                    }
                    const double tca = 0.5 * (l + h);
                    const double miss = range_km(a, b, tca);
                    if (!(miss <= threshold_km) || !(tca > cov_lo && tca < cov_hi) || !(tca >= ws && tca < we)) continue;
                    std::printf("%s{\"a\":%d,\"b\":%d,\"tca_jd\":%.17g,\"miss_km\":%.17g}", first ? "" : ",",
                                a.norad, b.norad, tca, miss);
                    first = false;
                }
            }
        }
        std::printf("]}");
    }
    std::printf("]}\n");
    return 0;
}
