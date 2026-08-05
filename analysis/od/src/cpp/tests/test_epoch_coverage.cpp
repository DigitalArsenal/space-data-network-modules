#include "od/sgp4_fitter.h"

#include <cstdio>
#include <vector>

namespace {

int fail(const char* message) {
    std::fprintf(stderr, "EPOCH COVERAGE FAIL: %s\n", message);
    return 1;
}

std::vector<od::EphemerisPoint> make_points(double span_seconds, double cadence_seconds) {
    std::vector<od::EphemerisPoint> points;
    const double epoch = 2460000.5;
    for (double t = 0.0; t <= span_seconds; t += cadence_seconds) {
        od::EphemerisPoint point{};
        point.epoch_jd = epoch + t / 86400.0;
        points.push_back(point);
    }
    return points;
}

}  // namespace

int main() {
    constexpr double window_seconds = 11520.0;

    const auto long_arc = make_points(3.0 * 86400.0, 60.0);
    const auto epochs = od::select_fit_epoch_indices(long_arc, window_seconds);
    if (epochs.size() < 2) return fail("a three-day arc must produce multiple epochs");
    if (epochs.front() != 0) return fail("coverage must begin at the first ephemeris state");

    for (std::size_t i = 1; i < epochs.size(); ++i) {
        if (epochs[i] <= epochs[i - 1]) return fail("epoch indices must be strictly increasing");
        const double gap =
            (long_arc[epochs[i]].epoch_jd - long_arc[epochs[i - 1]].epoch_jd) * 86400.0;
        if (gap > window_seconds + 61.0) return fail("adjacent local-fit windows leave an uncovered gap");
    }
    const double terminal_coverage =
        (long_arc.back().epoch_jd - long_arc[epochs.back()].epoch_jd) * 86400.0;
    if (terminal_coverage > window_seconds + 61.0)
        return fail("the final local-fit window does not cover the end of the ephemeris");

    const auto short_arc = make_points(3600.0, 60.0);
    const auto short_epochs = od::select_fit_epoch_indices(short_arc, window_seconds);
    if (short_epochs.size() != 1 || short_epochs.front() != 0)
        return fail("an arc shorter than one fit window must remain a single epoch");

    const auto barely_long = make_points(window_seconds + 180.0, 60.0);
    const auto terminal_epochs = od::select_fit_epoch_indices(barely_long, window_seconds);
    if (terminal_epochs.size() < 2)
        return fail("an arc longer than one fit window needs a terminal coverage epoch");
    const std::size_t terminal_start = terminal_epochs.back();
    if (barely_long.size() - terminal_start < 3)
        return fail("the terminal epoch must retain at least three fit samples");

    std::printf("EPOCH COVERAGE PASS: %zu local windows cover a three-day arc\n", epochs.size());
    return 0;
}
