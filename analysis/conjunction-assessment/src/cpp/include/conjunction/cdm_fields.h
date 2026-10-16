#pragma once
#include <array>
#include <cstddef>

namespace conjunction {
// CCSDS 508.0-B-1 table 3-4, in lower-triangle order. The SDS values
// use km-based units for the first 21 cells; optional drag/SRP/thrust
// entries retain the CCSDS message units (pinned SDS CDM record contract).
struct CovarianceField {
    const char* key;
    size_t index;
    const char* unit;
    double text_scale;
};
inline constexpr std::array<CovarianceField, 45> kCovarianceFields = {{
    {"CR_R", 0, "m**2", 1e6},
    {"CT_R", 1, "m**2", 1e6},
    {"CT_T", 2, "m**2", 1e6},
    {"CN_R", 3, "m**2", 1e6},
    {"CN_T", 4, "m**2", 1e6},
    {"CN_N", 5, "m**2", 1e6},
    {"CRDOT_R", 6, "m**2/s", 1e6},
    {"CRDOT_T", 7, "m**2/s", 1e6},
    {"CRDOT_N", 8, "m**2/s", 1e6},
    {"CRDOT_RDOT", 9, "m**2/s**2", 1e6},
    {"CTDOT_R", 10, "m**2/s", 1e6},
    {"CTDOT_T", 11, "m**2/s", 1e6},
    {"CTDOT_N", 12, "m**2/s", 1e6},
    {"CTDOT_RDOT", 13, "m**2/s**2", 1e6},
    {"CTDOT_TDOT", 14, "m**2/s**2", 1e6},
    {"CNDOT_R", 15, "m**2/s", 1e6},
    {"CNDOT_T", 16, "m**2/s", 1e6},
    {"CNDOT_N", 17, "m**2/s", 1e6},
    {"CNDOT_RDOT", 18, "m**2/s**2", 1e6},
    {"CNDOT_TDOT", 19, "m**2/s**2", 1e6},
    {"CNDOT_NDOT", 20, "m**2/s**2", 1e6},
    {"CDRG_R", 21, "m**3/kg", 1.0},
    {"CDRG_T", 22, "m**3/kg", 1.0},
    {"CDRG_N", 23, "m**3/kg", 1.0},
    {"CDRG_RDOT", 24, "m**3/(kg*s)", 1.0},
    {"CDRG_TDOT", 25, "m**3/(kg*s)", 1.0},
    {"CDRG_NDOT", 26, "m**3/(kg*s)", 1.0},
    {"CDRG_DRG", 27, "m**4/kg**2", 1.0},
    {"CSRP_R", 28, "m**3/kg", 1.0},
    {"CSRP_T", 29, "m**3/kg", 1.0},
    {"CSRP_N", 30, "m**3/kg", 1.0},
    {"CSRP_RDOT", 31, "m**3/(kg*s)", 1.0},
    {"CSRP_TDOT", 32, "m**3/(kg*s)", 1.0},
    {"CSRP_NDOT", 33, "m**3/(kg*s)", 1.0},
    {"CSRP_DRG", 34, "m**4/kg**2", 1.0},
    {"CSRP_SRP", 35, "m**4/kg**2", 1.0},
    {"CTHR_R", 36, "m**2/s**2", 1.0},
    {"CTHR_T", 37, "m**2/s**2", 1.0},
    {"CTHR_N", 38, "m**2/s**2", 1.0},
    {"CTHR_RDOT", 39, "m**2/s**3", 1.0},
    {"CTHR_TDOT", 40, "m**2/s**3", 1.0},
    {"CTHR_NDOT", 41, "m**2/s**3", 1.0},
    {"CTHR_DRG", 42, "m**3/(kg*s**2)", 1.0},
    {"CTHR_SRP", 43, "m**3/(kg*s**2)", 1.0},
    {"CTHR_THR", 44, "m**2/s**4", 1.0},
}};
inline bool cdm_complete_covariance_rows(size_t size) {
    return size == 21 || size == 28 || size == 36 || size == 45;
}
} // namespace conjunction
