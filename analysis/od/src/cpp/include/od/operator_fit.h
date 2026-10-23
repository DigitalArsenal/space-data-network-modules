#pragma once
#include "od/state_series.h"
#include <array>
#include <string>
#include <vector>
namespace od {
struct OperatorBuffer { const uint8_t* data=nullptr; size_t size=0; };
struct OperatorEnvironment {
    OperatorBuffer configuration, kernel, earth_orientation, space_weather, density_correction;
};
struct OperatorFitOptions {
    double end_seconds=172800, sample_seconds=600, ballistic_seed=.003, srp_area_mass=.02;
    double ballistic_prior=0, maneuver_velocity_km_s=.001, maneuver_position_km=.1;
    int max_iterations=12;
    bool warm_start=false;
    std::array<double,6> warm_state{}; // GCRF km, km/s at this segment's epoch
};
struct OperatorSegment {
    StateSeries source;
    std::array<double,6> state{};
    std::array<double,21> operator_covariance{}, formal_covariance{};
    bool has_operator_covariance=false, has_formal_covariance=false, converged=false;
    double ballistic=0, rms_km=0, maximum_km=0;
    int iterations=0;
    std::vector<double> residuals_km;
};
struct OperatorManeuver { double before_jd=0, after_jd=0, position_km=0, velocity_km_s=0; };
struct OperatorFitResult {
    std::vector<OperatorSegment> segments;
    std::vector<OperatorManeuver> maneuvers;
    std::string error;
};
// Input series retains the existing parser's TEME contract. Physics and fitting
// run here; callers only supply records and marshal results. No ephemeris IO.
OperatorFitResult fit_operator(const StateSeries&, const OperatorEnvironment&, const OperatorFitOptions&);
std::vector<uint8_t> operator_ocm(const OperatorSegment&, const OperatorFitOptions&, bool dca);
std::vector<uint8_t> operator_mnv(const OperatorManeuver&, const StateSeriesMeta&);
}
