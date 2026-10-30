// Dense brute force for tests/spanScreening.e2e.mjs: the conjunctions of one
// primary with each other object of a GP set over a window, from the
// library's own SGP4 sources (GPEphemerisSource, the states the screen
// evaluates), with none of the screen's logic.
//
// Each object's span: its state every second from the window start; the first
// second SGP4 refuses it ends the span, bisected against the second before to
// 0.1 ms (refused at the start: no span). Each pair's range every second up to
// the earlier span end (and that end itself): a sample below both neighbours
// and under the threshold plus 16 km (a second of relative motion) brackets a
// minimum, refined by golden section on its neighbours to 0.1 ms; a minimum
// within the threshold, strictly inside the window and the span, is a
// conjunction.
//
// usage: span_brute_force <gp.json> <start ISO> <duration s> <threshold km> <primary NORAD>
// Prints one JSON object: {"objects":[{"norad","last_valid_jd"|null}],
// "events":[{"a","b","tca_jd","miss_km"}]}.
#include "conjunction/ephemeris_source.h"
#include "conjunction/gp_json.h"
#include "conjunction/error_status.h"

#include <cmath>
#include <cstdio>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

using namespace conjunction;

namespace {

constexpr double SECOND_DAYS = 1.0 / 86400.0;
constexpr double TOLERANCE_DAYS = 1e-4 / 86400.0;

bool propagates(const EphemerisSource& source, double jd) {
    clear_error();
    source.state_at(jd);
    const bool ok = !has_error();
    clear_error();
    return ok;
}

double range_km(const EphemerisSource& a, const EphemerisSource& b, double jd) {
    clear_error();
    const StateVector p = a.state_at(jd), q = b.state_at(jd);
    if (has_error()) { clear_error(); return NAN; }
    return std::sqrt((p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y) + (p.z - q.z) * (p.z - q.z));
}

// The last instant of [start, end] the source propagates at: 0 when it is
// refused at the start, end when it is never refused on the one-second grid.
double span_end(const EphemerisSource& source, double start_jd, double end_jd) {
    if (!propagates(source, start_jd)) return 0.0;
    double valid = start_jd;
    for (double jd = start_jd + SECOND_DAYS; jd <= end_jd + 0.5 * SECOND_DAYS; jd += SECOND_DAYS) {
        const double t = std::min(jd, end_jd);
        if (!propagates(source, t)) {
            double lo = valid, hi = t;
            while (hi - lo > TOLERANCE_DAYS) {
                const double mid = 0.5 * (lo + hi);
                (propagates(source, mid) ? lo : hi) = mid;
            }
            return lo;
        }
        valid = t;
    }
    return end_jd;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc != 6) {
        std::fprintf(stderr, "usage: %s <gp.json> <start ISO> <duration s> <threshold km> <primary NORAD>\n", argv[0]);
        return 2;
    }
    std::ifstream file(argv[1]);
    std::stringstream text;
    text << file.rdbuf();
    const auto elements = parse_gp_json(text.str());
    if (has_error() || elements.empty()) {
        std::fprintf(stderr, "cannot read %s: %s\n", argv[1], error_message());
        return 1;
    }
    const double start_jd = iso_to_jd(argv[2]);
    const double end_jd = start_jd + std::stod(argv[3]) / 86400.0;
    const double threshold_km = std::stod(argv[4]);
    const int primary_norad = std::stoi(argv[5]);

    std::vector<std::unique_ptr<GPEphemerisSource>> sources;
    std::vector<double> ends;
    size_t primary = elements.size();
    std::printf("{\"objects\":[");
    for (size_t i = 0; i < elements.size(); ++i) {
        sources.push_back(std::make_unique<GPEphemerisSource>(elements[i]));
        ends.push_back(span_end(*sources.back(), start_jd, end_jd));
        if (elements[i].norad_cat_id == primary_norad) primary = i;
        std::printf("%s{\"norad\":%d,\"last_valid_jd\":", i ? "," : "", elements[i].norad_cat_id);
        if (ends.back() == 0.0) std::printf("null}");
        else std::printf("%.17g}", ends.back());
    }
    std::printf("],\"events\":[");
    if (primary == elements.size() || ends[primary] == 0.0) {
        std::printf("]}\n");
        return 0;
    }
    bool first = true;
    for (size_t j = 0; j < elements.size(); ++j) {
        if (j == primary || ends[j] == 0.0) continue;
        const auto& a = *sources[primary];
        const auto& b = *sources[j];
        const double last = std::min(ends[primary], ends[j]);
        std::vector<double> jds, ranges;
        for (double jd = start_jd; jd < last; jd += SECOND_DAYS) {
            jds.push_back(jd);
            ranges.push_back(range_km(a, b, jd));
        }
        jds.push_back(last);
        ranges.push_back(range_km(a, b, last));
        for (size_t k = 1; k + 1 < jds.size(); ++k) {
            if (!(ranges[k] < ranges[k - 1] && ranges[k] <= ranges[k + 1] &&
                  ranges[k] < threshold_km + 16.0)) {
                continue;
            }
            const double phi = (std::sqrt(5.0) - 1.0) / 2.0;
            double lo = jds[k - 1], hi = jds[k + 1];
            while (hi - lo > TOLERANCE_DAYS) {
                const double c = hi - phi * (hi - lo), d = lo + phi * (hi - lo);
                if (range_km(a, b, c) < range_km(a, b, d)) hi = d; else lo = c;
            }
            const double tca = 0.5 * (lo + hi);
            const double miss = range_km(a, b, tca);
            if (!(miss <= threshold_km) || !(tca > start_jd && tca < last)) continue;
            std::printf("%s{\"a\":%d,\"b\":%d,\"tca_jd\":%.17g,\"miss_km\":%.17g}", first ? "" : ",",
                        elements[primary].norad_cat_id, elements[j].norad_cat_id, tca, miss);
            first = false;
        }
    }
    std::printf("]}\n");
    return 0;
}
