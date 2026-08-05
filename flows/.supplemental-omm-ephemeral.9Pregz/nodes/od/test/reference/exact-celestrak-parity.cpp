#include "od/frame_transform.h"
#include "od/meme_parser.h"
#include "od/sgp4_fitter.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <string>
#include <vector>

int main(int argc, char** argv) {
    if (argc != 12) {
        std::cerr
            << "usage: exact-celestrak-parity MEME EPOCH MM ECC INC RAAN ARGP "
               "MA BSTAR NDOT NDDOT\n";
        return 2;
    }

    od::MEMEFile meme = od::parse_meme_file(argv[1]);
    if (meme.points.size() < 3) {
        std::cerr << "MEME parse failed\n";
        return 3;
    }
    for (od::EphemerisPoint& point : meme.points) {
        const double source_position[3] = {point.x, point.y, point.z};
        const double source_velocity[3] = {point.vx, point.vy, point.vz};
        double teme_position[3];
        double teme_velocity[3];
        od::eci_j2000_to_teme(
            point.epoch_jd, source_position, source_velocity,
            teme_position, teme_velocity);
        point.x = teme_position[0];
        point.y = teme_position[1];
        point.z = teme_position[2];
        point.vx = teme_velocity[0];
        point.vy = teme_velocity[1];
        point.vz = teme_velocity[2];
    }
    const double epoch_jd = od::iso_to_jd(argv[2]);
    constexpr double kOneMillisecondDays = 0.001 / 86400.0;
    const auto epoch_it = std::find_if(
        meme.points.begin(), meme.points.end(),
        [epoch_jd](const od::EphemerisPoint& point) {
            return std::abs(point.epoch_jd - epoch_jd) <=
                   kOneMillisecondDays;
        });
    if (epoch_it == meme.points.end()) {
        std::cerr << "capture epoch has no exact source observation\n";
        return 4;
    }

    const double final_jd = epoch_jd + 28800.0 / 86400.0;
    std::vector<od::EphemerisPoint> window;
    for (auto it = epoch_it; it != meme.points.end(); ++it) {
        if (it->epoch_jd > final_jd + kOneMillisecondDays) break;
        window.push_back(*it);
    }
    if (window.size() != 481) {
        std::cerr << "expected 481 complete-window observations, got "
                  << window.size() << "\n";
        return 5;
    }

    od::FitterConfig config;
    config.max_iterations = 60;
    config.fit_window_sec = 28800.0;
    config.use_all_window_states = true;
    config.has_reference = true;
    config.reference_elements.epoch_iso = argv[2];
    config.reference_elements.epoch_jd = epoch_jd;
    config.reference_elements.mean_motion = std::strtod(argv[3], nullptr);
    config.reference_elements.eccentricity = std::strtod(argv[4], nullptr);
    config.reference_elements.inclination = std::strtod(argv[5], nullptr);
    config.reference_elements.ra_of_asc_node = std::strtod(argv[6], nullptr);
    config.reference_elements.arg_of_pericenter = std::strtod(argv[7], nullptr);
    config.reference_elements.mean_anomaly = std::strtod(argv[8], nullptr);
    config.reference_elements.bstar = std::strtod(argv[9], nullptr);
    config.reference_elements.mean_motion_dot =
        std::strtod(argv[10], nullptr);
    config.reference_elements.mean_motion_ddot =
        std::strtod(argv[11], nullptr);

    const od::FitResult result = od::fit_sgp4(window, config);
    if (!result.elements.has_reference_rms) {
        std::cerr << "reference RMS was not produced\n";
        return 6;
    }
    std::cout << std::setprecision(12)
              << "points=" << window.size()
              << " epoch=" << result.elements.epoch_iso
              << " sdn_rms_km=" << result.rms_km
              << " celestrak_rms_km="
              << result.elements.reference_rms_km
              << " margin_km="
              << result.elements.reference_rms_km - result.rms_km
              << " iterations=" << result.iterations
              << " converged=" << (result.converged ? 1 : 0)
              << "\n";
    return result.rms_km <=
                   result.elements.reference_rms_km + 1e-6
               ? 0
               : 1;
}
