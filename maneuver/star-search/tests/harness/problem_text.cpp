#include "problem_text.hpp"

#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>

namespace star_search::harness {
namespace {

constexpr std::size_t kMaxProblemBytes = 64U * 1024U;
constexpr std::size_t kMaxLineBytes = 4096U;

char* trim(char* text) {
    while (*text == ' ' || *text == '\t' || *text == '\r' || *text == '\n') {
        ++text;
    }
    std::size_t length = std::strlen(text);
    while (length > 0U &&
           (text[length - 1U] == ' ' || text[length - 1U] == '\t' ||
            text[length - 1U] == '\r' || text[length - 1U] == '\n')) {
        text[--length] = '\0';
    }
    return text;
}

bool parse_double(const char* text, double* output) {
    if (text == nullptr || output == nullptr) {
        return false;
    }
    errno = 0;
    char* end = nullptr;
    const double value = std::strtod(text, &end);
    if (end == text || errno == ERANGE) {
        return false;
    }
    while (*end == ' ' || *end == '\t') {
        ++end;
    }
    if (*end != '\0') {
        return false;
    }
    *output = value;
    return true;
}

bool parse_u64(const char* text, std::size_t* output) {
    if (text == nullptr || output == nullptr || *text == '-') {
        return false;
    }
    errno = 0;
    char* end = nullptr;
    const unsigned long long value = std::strtoull(text, &end, 10);
    if (end == text || errno == ERANGE) {
        return false;
    }
    while (*end == ' ' || *end == '\t') {
        ++end;
    }
    if (*end != '\0' || value > static_cast<unsigned long long>(static_cast<std::size_t>(-1))) {
        return false;
    }
    *output = static_cast<std::size_t>(value);
    return true;
}

bool parse_int(const char* text, int* output) {
    if (text == nullptr || output == nullptr) {
        return false;
    }
    errno = 0;
    char* end = nullptr;
    const long value = std::strtol(text, &end, 10);
    if (end == text || errno == ERANGE ||
        value < static_cast<long>(std::numeric_limits<int>::min()) ||
        value > static_cast<long>(std::numeric_limits<int>::max())) {
        return false;
    }
    while (*end == ' ' || *end == '\t') {
        ++end;
    }
    if (*end != '\0') {
        return false;
    }
    *output = static_cast<int>(value);
    return true;
}

std::size_t split_values(char* text, char* values[], std::size_t cap) {
    std::size_t count = 0U;
    char* cursor = text;
    while (*cursor != '\0') {
        if (count >= cap) {
            return cap + 1U;
        }
        values[count++] = trim(cursor);
        char* comma = std::strchr(cursor, ',');
        if (comma == nullptr) {
            break;
        }
        *comma = '\0';
        cursor = comma + 1;
    }
    return count;
}

bool parse_double_list(char* text, double* output, std::size_t expected) {
    char* values[kMaxStages]{};
    const std::size_t count = split_values(text, values, kMaxStages);
    if (count != expected) {
        return false;
    }
    for (std::size_t index = 0U; index < count; ++index) {
        if (!parse_double(values[index], &output[index])) {
            return false;
        }
    }
    return true;
}

bool parse_int_list(char* text, int* output, std::size_t expected) {
    char* values[kMaxBodiesPerStage]{};
    const std::size_t count = split_values(text, values, kMaxBodiesPerStage);
    if (count != expected) {
        return false;
    }
    for (std::size_t index = 0U; index < count; ++index) {
        if (!parse_int(values[index], &output[index])) {
            return false;
        }
    }
    return true;
}

bool parse_variable_int_list(
    char* text,
    std::int32_t* output,
    std::uint32_t* count,
    std::size_t cap) {
    char* values[kMaxBodiesPerStage]{};
    const std::size_t observed = split_values(text, values, cap);
    if (observed == 0U || observed > cap) {
        return false;
    }
    for (std::size_t index = 0U; index < observed; ++index) {
        int value = 0;
        if (!parse_int(values[index], &value)) {
            return false;
        }
        output[index] = static_cast<std::int32_t>(value);
    }
    *count = static_cast<std::uint32_t>(observed);
    return true;
}

bool assign_scalar(Problem* problem, const char* key, char* value) {
    int integer = 0;
    if (std::strcmp(key, "stage_count") == 0) {
        return parse_int(value, &integer) && integer >= 2 &&
               integer <= static_cast<int>(kMaxStages) &&
               ((problem->stage_count = static_cast<std::uint32_t>(integer)), true);
    }
    if (std::strcmp(key, "leg_count") == 0) {
        return parse_int(value, &integer) && integer >= 1 &&
               integer < static_cast<int>(kMaxStages) &&
               ((problem->leg_count = static_cast<std::uint32_t>(integer)), true);
    }
    if (std::strcmp(key, "central_mu_km3_s2") == 0) {
        return parse_double(value, &problem->central_mu_km3_s2);
    }
    if (std::strcmp(key, "dv_total_max_km_s") == 0) {
        return parse_double(value, &problem->dv_total_max_km_s);
    }
    if (std::strcmp(key, "tfilter_enabled") == 0) {
        return parse_int(value, &integer) && (integer == 0 || integer == 1) &&
               ((problem->tfilter_enabled = integer != 0), true);
    }
    if (std::strcmp(key, "tfilter_preemptive") == 0) {
        return parse_int(value, &integer) && (integer == 0 || integer == 1) &&
               ((problem->tfilter_preemptive = integer != 0), true);
    }
    if (std::strcmp(key, "escape_altitude_km") == 0) {
        return parse_double(value, &problem->escape_altitude_km);
    }
    if (std::strcmp(key, "insertion_altitude_km") == 0) {
        return parse_double(value, &problem->insertion_altitude_km);
    }
    if (std::strcmp(key, "row_cap") == 0) {
        return parse_u64(value, &problem->row_cap);
    }
    if (std::strcmp(key, "memory_cap_bytes") == 0) {
        return parse_u64(value, &problem->memory_cap_bytes);
    }
    if (std::strcmp(key, "work_chunk_rows") == 0) {
        return parse_u64(value, &problem->work_chunk_rows);
    }
    return false;
}

bool assign_list(Problem* problem, const char* key, char* value) {
    if (problem->stage_count == 0U || problem->leg_count == 0U) {
        return false;
    }
    if (std::strcmp(key, "tfilter_dt_s") == 0) {
        return parse_double_list(value, problem->tfilter_dt_s, problem->stage_count);
    }
    double doubles[kMaxStages]{};
    int integers[kMaxStages]{};
    if (std::strcmp(key, "null_legs") == 0 ||
        std::strcmp(key, "resonant_legs") == 0 ||
        std::strcmp(key, "lambert_nrev_max") == 0 ||
        std::strcmp(key, "lambert_hz") == 0) {
        if (!parse_int_list(value, integers, problem->leg_count)) {
            return false;
        }
        for (std::uint32_t index = 0U; index < problem->leg_count; ++index) {
            if (std::strcmp(key, "null_legs") == 0) {
                problem->null_legs[index] = integers[index] != 0;
            } else if (std::strcmp(key, "resonant_legs") == 0) {
                problem->resonant_legs[index] = integers[index] != 0;
            } else if (std::strcmp(key, "lambert_nrev_max") == 0) {
                problem->lambert_nrev_max[index] = integers[index];
            } else {
                problem->lambert_hz[index] = integers[index];
            }
        }
        return true;
    }
    if (std::strcmp(key, "dv_lev_max_km_s") == 0 ||
        std::strcmp(key, "delta_dv_lev_km_s") == 0 ||
        std::strcmp(key, "vinf_margin_pre_filter_km_s") == 0) {
        if (!parse_double_list(value, doubles, problem->leg_count)) {
            return false;
        }
        for (std::uint32_t index = 0U; index < problem->leg_count; ++index) {
            if (std::strcmp(key, "dv_lev_max_km_s") == 0) {
                problem->dv_lev_max_km_s[index] = doubles[index];
            } else if (std::strcmp(key, "delta_dv_lev_km_s") == 0) {
                problem->delta_dv_lev_km_s[index] = doubles[index];
            } else {
                problem->vinf_margin_pre_filter_km_s[index] = doubles[index];
            }
        }
        return true;
    }
    return false;
}

bool assign_indexed(Problem* problem, const char* key, char* value) {
    unsigned first = 0U;
    unsigned second = 0U;
    char field[80]{};
    if (std::sscanf(key, "stage.%u.%79s", &first, field) == 2) {
        if (first >= problem->stage_count) {
            return false;
        }
        StageConfig& stage = problem->stages[first];
        if (std::strcmp(field, "bodies") == 0) {
            return parse_variable_int_list(
                value, stage.bodies, &stage.body_count, kMaxBodiesPerStage);
        }
        if (std::strcmp(field, "t_min_et_s") == 0) {
            return parse_double(value, &stage.t_min_et_s);
        }
        if (std::strcmp(field, "t_max_et_s") == 0) {
            return parse_double(value, &stage.t_max_et_s);
        }
        if (std::strcmp(field, "dt_et_s") == 0) {
            return parse_double(value, &stage.dt_et_s);
        }
        if (std::strcmp(field, "vinf_min_km_s") == 0) {
            return parse_double(value, &stage.vinf_min_km_s);
        }
        if (std::strcmp(field, "vinf_max_km_s") == 0) {
            return parse_double(value, &stage.vinf_max_km_s);
        }
        if (std::strcmp(field, "altitude_km") == 0 && stage.body_count > 0U) {
            return parse_double_list(value, stage.altitude_km, stage.body_count);
        }
        return false;
    }
    if (std::sscanf(key, "tof.%u.%u.%79s", &first, &second, field) == 3) {
        if (first >= problem->stage_count || second >= problem->stage_count) {
            return false;
        }
        if (std::strcmp(field, "min_s") == 0) {
            return parse_double(value, &problem->tof_min_s[first][second]);
        }
        if (std::strcmp(field, "max_s") == 0) {
            return parse_double(value, &problem->tof_max_s[first][second]);
        }
        return false;
    }
    if (std::sscanf(key, "flyby.%u.%79s", &first, field) == 2) {
        if (first >= problem->stage_count) {
            return false;
        }
        if (std::strcmp(field, "trip_tof_min_s") == 0) {
            return parse_double(value, &problem->flybys[first].trip_tof_min_s);
        }
        if (std::strcmp(field, "trip_tof_max_s") == 0) {
            return parse_double(value, &problem->flybys[first].trip_tof_max_s);
        }
        if (std::strcmp(field, "dv_patch_max_km_s") == 0) {
            return parse_double(value, &problem->flybys[first].dv_patch_max_km_s);
        }
        return false;
    }
    return false;
}

}  // namespace

Status parse_problem_file(const char* path, Problem* output) {
    if (path == nullptr || output == nullptr) {
        return Status::InvalidInput;
    }
    std::FILE* stream = std::fopen(path, "rb");
    if (stream == nullptr) {
        return Status::IoError;
    }
    if (std::fseek(stream, 0, SEEK_END) != 0) {
        std::fclose(stream);
        return Status::IoError;
    }
    const long length = std::ftell(stream);
    if (length <= 0 || static_cast<unsigned long>(length) > kMaxProblemBytes ||
        std::fseek(stream, 0, SEEK_SET) != 0) {
        std::fclose(stream);
        return Status::InvalidFormat;
    }

    *output = Problem{};
    output->central_mu_km3_s2 = NAN;
    output->dv_total_max_km_s = NAN;
    for (std::size_t stage = 0U; stage < kMaxStages; ++stage) {
        output->stages[stage].t_min_et_s = NAN;
        output->stages[stage].t_max_et_s = NAN;
        output->stages[stage].dt_et_s = NAN;
        output->stages[stage].vinf_min_km_s = NAN;
        output->stages[stage].vinf_max_km_s = NAN;
        output->lambert_nrev_max[stage] = -1;
        output->lambert_hz[stage] = 2;
        output->dv_lev_max_km_s[stage] = NAN;
        output->delta_dv_lev_km_s[stage] = NAN;
        output->vinf_margin_pre_filter_km_s[stage] = NAN;
        output->tfilter_dt_s[stage] = NAN;
        output->flybys[stage].trip_tof_min_s = NAN;
        output->flybys[stage].trip_tof_max_s = NAN;
        output->flybys[stage].dv_patch_max_km_s = NAN;
        for (std::size_t other = 0U; other < kMaxStages; ++other) {
            output->tof_min_s[stage][other] = NAN;
            output->tof_max_s[stage][other] = NAN;
        }
        for (std::size_t body = 0U; body < kMaxBodiesPerStage; ++body) {
            output->stages[stage].altitude_km[body] = NAN;
        }
    }
    char line[kMaxLineBytes]{};
    if (std::fgets(line, sizeof(line), stream) == nullptr ||
        std::strcmp(trim(line), "STAR_PROBLEM 1") != 0) {
        std::fclose(stream);
        return Status::InvalidFormat;
    }
    while (std::fgets(line, sizeof(line), stream) != nullptr) {
        char* text = trim(line);
        if (*text == '\0' || *text == '#') {
            continue;
        }
        char* equals = std::strchr(text, '=');
        if (equals == nullptr) {
            std::fclose(stream);
            return Status::ParseError;
        }
        *equals = '\0';
        char* key = trim(text);
        char* value = trim(equals + 1);
        if (!assign_scalar(output, key, value) && !assign_list(output, key, value) &&
            !assign_indexed(output, key, value)) {
            std::fclose(stream);
            return Status::ParseError;
        }
    }
    const bool read_error = std::ferror(stream) != 0;
    std::fclose(stream);
    if (read_error || output->stage_count < 2U ||
        output->leg_count + 1U != output->stage_count || output->row_cap == 0U ||
        output->memory_cap_bytes == 0U || output->work_chunk_rows == 0U ||
        output->memory_cap_bytes > kWasmMaximumMemoryBytes ||
        !(output->central_mu_km3_s2 > 0.0) ||
        std::isnan(output->dv_total_max_km_s) ||
        output->dv_total_max_km_s < 0.0 ||
        (output->tfilter_preemptive && !output->tfilter_enabled)) {
        return Status::InvalidFormat;
    }
    for (std::uint32_t stage = 0U; stage < output->stage_count; ++stage) {
        if (output->stages[stage].body_count == 0U ||
            !std::isfinite(output->stages[stage].t_min_et_s) ||
            !std::isfinite(output->stages[stage].t_max_et_s) ||
            output->stages[stage].t_max_et_s < output->stages[stage].t_min_et_s ||
            !(output->stages[stage].dt_et_s > 0.0) ||
            std::isnan(output->stages[stage].vinf_min_km_s) ||
            std::isnan(output->stages[stage].vinf_max_km_s) ||
            output->stages[stage].vinf_min_km_s < 0.0 ||
            output->stages[stage].vinf_max_km_s < output->stages[stage].vinf_min_km_s) {
            return Status::InvalidFormat;
        }
        for (std::uint32_t body = 0U; body < output->stages[stage].body_count; ++body) {
            if (!std::isfinite(output->stages[stage].altitude_km[body])) {
                return Status::InvalidFormat;
            }
        }
        if (output->tfilter_enabled &&
            (!(output->tfilter_dt_s[stage] > 0.0) ||
             !std::isfinite(output->tfilter_dt_s[stage]))) {
            return Status::InvalidFormat;
        }
    }
    for (std::uint32_t leg = 0U; leg < output->leg_count; ++leg) {
        const double tof_min = output->tof_min_s[leg][leg + 1U];
        const double tof_max = output->tof_max_s[leg][leg + 1U];
        if (std::isnan(tof_min) || std::isnan(tof_max) ||
            (std::isfinite(tof_min) && std::isfinite(tof_max) && tof_max < tof_min) ||
            output->lambert_nrev_max[leg] < 0 ||
            output->lambert_hz[leg] < -1 || output->lambert_hz[leg] > 1 ||
            std::isnan(output->dv_lev_max_km_s[leg]) ||
            output->dv_lev_max_km_s[leg] < 0.0 ||
            std::isnan(output->delta_dv_lev_km_s[leg]) ||
            output->delta_dv_lev_km_s[leg] < 0.0 ||
            std::isnan(output->vinf_margin_pre_filter_km_s[leg])) {
            return Status::InvalidFormat;
        }
    }
    for (std::uint32_t stage = 1U; stage < output->leg_count; ++stage) {
        const FlybyStageConfig& flyby = output->flybys[stage];
        if (std::isnan(flyby.trip_tof_min_s) || std::isnan(flyby.trip_tof_max_s) ||
            (std::isfinite(flyby.trip_tof_min_s) &&
             std::isfinite(flyby.trip_tof_max_s) &&
             flyby.trip_tof_max_s < flyby.trip_tof_min_s) ||
            std::isnan(flyby.dv_patch_max_km_s) || flyby.dv_patch_max_km_s < 0.0) {
            return Status::InvalidFormat;
        }
    }
    return Status::Ok;
}

}  // namespace star_search::harness
