#ifndef OD_COVARIANCE_VALIDATION_H
#define OD_COVARIANCE_VALIDATION_H
#include <cmath>
#include <cstdint>
#include <cstring>

namespace od {
// Bit inspection remains valid under the fitter's -ffast-math build flags.
inline bool finite_covariance_value(double value) {
    static_assert(sizeof(double) == sizeof(uint64_t), "requires IEEE binary64");
    uint64_t bits;
    std::memcpy(&bits, &value, sizeof(bits));
    // Keep the integer observation visible even with finite-math assumptions.
    volatile uint64_t observed = bits;
    return (observed & UINT64_C(0x7ff0000000000000)) != UINT64_C(0x7ff0000000000000);
}

// A truncated inverse assigns zero uncertainty to unconstrained parameters.
// Keep the solver's existing relative cutoff, but withhold formal covariance
// when any fitted parameter is numerically unobservable at that cutoff.
inline bool full_rank_normal_spectrum(const double* values, int count) {
    if (count <= 0 || !finite_covariance_value(values[0]) || values[0] <= 0) return false;
    const double cutoff = 1e-12 * values[0] * count;
    for (int i = 0; i < count; ++i)
        if (!finite_covariance_value(values[i]) || values[i] <= cutoff) return false;
    return true;
}

// Validate the complete 6x6 covariance, including cross terms. Normalize to
// correlation units before Cholesky so km and km/s do not set the pivot scale.
// Singular and ill-conditioned matrices are unavailable for this contract.
inline bool publishable_covariance(const double* lower21) {
    double a[6][6]{}, scale[6]{}, l[6][6]{};
    int k = 0;
    for (int r = 0; r < 6; ++r) for (int c = 0; c <= r; ++c) {
        const double value = lower21[k++];
        if (!finite_covariance_value(value)) return false;
        a[r][c] = a[c][r] = value;
    }
    for (int r = 0; r < 6; ++r) {
        if (a[r][r] <= 0) return false;
        scale[r] = std::sqrt(a[r][r]);
    }
    for (int r = 0; r < 6; ++r) for (int c = 0; c <= r; ++c) {
        double pivot = (a[r][c] / scale[r]) / scale[c];
        if (!finite_covariance_value(pivot)) return false;
        for (int j = 0; j < c; ++j) pivot -= l[r][j] * l[c][j];
        if (r == c) {
            if (!finite_covariance_value(pivot) || pivot <= 1e-12) return false;
            l[r][c] = std::sqrt(pivot);
        } else l[r][c] = pivot / l[c][c];
    }
    return true;
}
}  // namespace od
#endif
