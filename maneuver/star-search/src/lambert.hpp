#ifndef STAR_SEARCH_LAMBERT_HPP
#define STAR_SEARCH_LAMBERT_HPP

#include "threading.hpp"
#include "types.hpp"

#include <cstddef>

namespace star_search {

struct LambertInput {
    Vec3 r1_km;
    Vec3 r2_km;
    double tof_s;
    int hz;
};

struct LambertSolution {
    Vec3 v1_km_s;
    Vec3 v2_km_s;
    double semi_major_axis_km;
    int nrev_signed;
    std::size_t input_index;
};

void w_and_derivatives(
    double k,
    int revolutions,
    double series_eps,
    double delta_m,
    double* W,
    double* dW,
    double* ddW);

Status lambert_batch(
    const LambertInput* inputs,
    std::size_t input_count,
    double mu_km3_s2,
    int nrev_max,
    bool sweep_revolutions,
    double hz_tolerance,
    double series_eps,
    double tolerance,
    const ThreadOptions& thread_options,
    std::size_t row_cap,
    MemoryBudget* budget,
    Buffer<LambertSolution>* output);

}  // namespace star_search

#endif
