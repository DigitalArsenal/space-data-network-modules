#ifndef STAR_SEARCH_TYPES_HPP
#define STAR_SEARCH_TYPES_HPP

#include "bounded_buffer.hpp"

#include <cmath>
#include <cstddef>
#include <cstdint>

namespace star_search {

constexpr std::size_t kMaxStages = 16U;
constexpr std::size_t kMaxBodiesPerStage = 16U;
constexpr std::size_t kMaxEphemerisBodies = 64U;

struct Vec3 {
    double x = 0.0;
    double y = 0.0;
    double z = 0.0;
};

inline Vec3 add(Vec3 left, Vec3 right) {
    return Vec3{left.x + right.x, left.y + right.y, left.z + right.z};
}

inline Vec3 subtract(Vec3 left, Vec3 right) {
    return Vec3{left.x - right.x, left.y - right.y, left.z - right.z};
}

inline Vec3 scale(Vec3 value, double factor) {
    return Vec3{value.x * factor, value.y * factor, value.z * factor};
}

inline double dot(Vec3 left, Vec3 right) {
    return left.x * right.x + left.y * right.y + left.z * right.z;
}

inline Vec3 cross(Vec3 left, Vec3 right) {
    return Vec3{
        left.y * right.z - left.z * right.y,
        left.z * right.x - left.x * right.z,
        left.x * right.y - left.y * right.x,
    };
}

inline double norm(Vec3 value) {
    return std::sqrt(dot(value, value));
}

struct State6 {
    Vec3 position_km;
    Vec3 velocity_km_s;
};

struct StageConfig {
    std::uint32_t body_count = 0U;
    std::int32_t bodies[kMaxBodiesPerStage]{};
    double altitude_km[kMaxBodiesPerStage]{};
    double t_min_et_s = 0.0;
    double t_max_et_s = 0.0;
    double dt_et_s = 0.0;
    double vinf_min_km_s = 0.0;
    double vinf_max_km_s = 0.0;
};

struct FlybyStageConfig {
    double trip_tof_min_s = -INFINITY;
    double trip_tof_max_s = INFINITY;
    double dv_patch_max_km_s = INFINITY;
};

struct Problem {
    std::uint32_t stage_count = 0U;
    std::uint32_t leg_count = 0U;
    StageConfig stages[kMaxStages]{};
    double tof_min_s[kMaxStages][kMaxStages]{};
    double tof_max_s[kMaxStages][kMaxStages]{};
    std::int32_t lambert_nrev_max[kMaxStages]{};
    std::int32_t lambert_hz[kMaxStages]{};
    double dv_lev_max_km_s[kMaxStages]{};
    double delta_dv_lev_km_s[kMaxStages]{};
    double vinf_margin_pre_filter_km_s[kMaxStages]{};
    bool null_legs[kMaxStages]{};
    bool resonant_legs[kMaxStages]{};
    FlybyStageConfig flybys[kMaxStages]{};
    double central_mu_km3_s2 = 0.0;
    double dv_total_max_km_s = INFINITY;
    double tfilter_dt_s[kMaxStages]{};
    bool tfilter_enabled = false;
    bool tfilter_preemptive = false;
    double escape_altitude_km = 0.0;
    double insertion_altitude_km = 0.0;
    std::size_t row_cap = 0U;
    std::size_t memory_cap_bytes = 0U;
    std::size_t work_chunk_rows = 0U;
};

struct EphemerisSample {
    double epoch_et_s;
    State6 state;
};

struct EphemerisBody {
    std::int32_t body_id = 0;
    double gm_km3_s2 = 0.0;
    double mean_radius_km = 0.0;
    Buffer<EphemerisSample> samples;
};

struct Ephemeris {
    std::uint32_t body_count = 0U;
    std::uint64_t total_sample_count = 0U;
    EphemerisBody bodies[kMaxEphemerisBodies];
};

struct EncounterRow {
    std::int64_t IE = -1;
    std::int32_t stage_id = -1;
    double t_et_s = 0.0;
    std::int32_t body_id = 0;
    Vec3 r_km;
    Vec3 v_km_s;
    double mu_km3_s2 = 0.0;
    double rmin_km = 0.0;
};

struct EncounterDB {
    Buffer<EncounterRow> rows;
};

struct LegRow {
    std::int64_t IL = -1;
    std::int64_t ID = -1;
    std::int64_t IA = -1;
    Vec3 vinfD_km_s;
    Vec3 vinfA_km_s;
    std::int32_t n_rev = 0;
    double dv_lev_km_s = 0.0;
    double eta_lev = 0.5;
};

struct LegDB {
    std::int32_t stage_id = -1;
    Buffer<LegRow> rows;
};

struct FlybyRow {
    std::int64_t IF = -1;
    std::int64_t IE = -1;
    std::int64_t IL_in = -1;
    std::int64_t IL_out = -1;
    double dv_patch_km_s = 0.0;
};

struct FlybyDB {
    std::int32_t stage_id = -1;
    Buffer<FlybyRow> rows;
};

struct ComboStageRow {
    std::int64_t leg0_il = -1;
    std::int64_t dep_ie = -1;
    std::int64_t right_leg_il = -1;
    std::int64_t flyby_if = -1;
    double dv_total_km_s = 0.0;
    std::int64_t parent_row = -1;
};

struct OutputRow {
    std::int64_t traj_id = -1;
    std::uint32_t encounter_count = 0U;
    std::uint32_t leg_count = 0U;
    std::int64_t encounter_ies[kMaxStages]{};
    double t_et_s[kMaxStages]{};
    std::int32_t body_ids[kMaxStages]{};
    Vec3 vinfD_km_s[kMaxStages]{};
    Vec3 vinfA_km_s[kMaxStages]{};
    double dv_lev_km_s[kMaxStages]{};
    double eta_lev[kMaxStages]{};
    double dv_patch_km_s[kMaxStages]{};
    std::int64_t leg_ils[kMaxStages]{};
    std::int64_t flyby_ifs[kMaxStages]{};
    double dv_total_km_s = 0.0;
    double tof_total_s = 0.0;
    double dv_escape_km_s = 0.0;
    double dv_insertion_km_s = 0.0;
};

struct OutputDB {
    Buffer<OutputRow> rows;
};

struct StageCounts {
    std::size_t encounter_rows = 0U;
    std::size_t leg_rows[kMaxStages]{};
    std::size_t flyby_rows[kMaxStages]{};
    std::size_t fixpoint_passes = 0U;
    std::size_t fixpoint_removed = 0U;
    std::size_t combo_rows[kMaxStages]{};
    std::size_t final_rows = 0U;
    std::size_t tfilter_bins = 0U;
    std::size_t output_rows = 0U;
    std::size_t peak_memory_bytes = 0U;
};

}  // namespace star_search

#endif
