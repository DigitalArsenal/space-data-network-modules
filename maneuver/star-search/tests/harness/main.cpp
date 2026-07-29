#include "ephemeris.hpp"
#include "pipeline.hpp"
#include "problem_text.hpp"

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace {

struct Options {
    const char* problem_path = nullptr;
    const char* ephemeris_path = nullptr;
    const char* output_path = nullptr;
    std::size_t threads = 1U;
    bool force_spawn_failure = false;
};

bool parse_size(const char* text, std::size_t* output) {
    if (text == nullptr || output == nullptr || *text == '-') {
        return false;
    }
    errno = 0;
    char* end = nullptr;
    const unsigned long long value = std::strtoull(text, &end, 10);
    if (end == text || *end != '\0' || errno == ERANGE || value == 0U) {
        return false;
    }
    *output = static_cast<std::size_t>(value);
    return true;
}

bool parse_options(int argc, char* argv[], Options* options) {
    const char* env_threads = std::getenv("STAR_SEARCH_THREADS");
    if (env_threads != nullptr && !parse_size(env_threads, &options->threads)) {
        return false;
    }
    for (int index = 1; index < argc; ++index) {
        if (std::strcmp(argv[index], "--force-spawn-failure") == 0) {
            options->force_spawn_failure = true;
            continue;
        }
        if (index + 1 >= argc) {
            return false;
        }
        const char* value = argv[++index];
        if (std::strcmp(argv[index - 1], "--problem") == 0) {
            options->problem_path = value;
        } else if (std::strcmp(argv[index - 1], "--ephemeris") == 0) {
            options->ephemeris_path = value;
        } else if (std::strcmp(argv[index - 1], "--output") == 0) {
            options->output_path = value;
        } else if (std::strcmp(argv[index - 1], "--threads") == 0) {
            if (!parse_size(value, &options->threads)) {
                return false;
            }
        } else {
            return false;
        }
    }
    return options->problem_path != nullptr && options->ephemeris_path != nullptr &&
           options->output_path != nullptr;
}

bool read_file(const char* path, std::size_t maximum_bytes, void** bytes, std::size_t* size) {
    if (path == nullptr || bytes == nullptr || size == nullptr) {
        return false;
    }
    std::FILE* stream = std::fopen(path, "rb");
    if (stream == nullptr || std::fseek(stream, 0, SEEK_END) != 0) {
        if (stream != nullptr) {
            std::fclose(stream);
        }
        return false;
    }
    const long length = std::ftell(stream);
    if (length <= 0 || static_cast<unsigned long>(length) > maximum_bytes ||
        std::fseek(stream, 0, SEEK_SET) != 0) {
        std::fclose(stream);
        return false;
    }
    void* allocation = std::malloc(static_cast<std::size_t>(length));
    if (allocation == nullptr) {
        std::fclose(stream);
        return false;
    }
    const std::size_t observed =
        std::fread(allocation, 1U, static_cast<std::size_t>(length), stream);
    std::fclose(stream);
    if (observed != static_cast<std::size_t>(length)) {
        std::free(allocation);
        return false;
    }
    *bytes = allocation;
    *size = observed;
    return true;
}

void write_vec3(std::FILE* stream, star_search::Vec3 value) {
    std::fprintf(stream, "[%.17g,%.17g,%.17g]", value.x, value.y, value.z);
}

bool write_output(const char* path, const star_search::OutputDB& output) {
    std::FILE* stream = std::fopen(path, "wb");
    if (stream == nullptr) {
        return false;
    }
    for (std::size_t row_index = 0U; row_index < output.rows.size(); ++row_index) {
        const star_search::OutputRow& row = output.rows[row_index];
        std::fprintf(stream, "{\"traj_id\":%lld,\"t_et_s\":[", static_cast<long long>(row.traj_id));
        for (std::uint32_t index = 0U; index < row.encounter_count; ++index) {
            std::fprintf(stream, "%s%.17g", index == 0U ? "" : ",", row.t_et_s[index]);
        }
        std::fputs("],\"body_ids\":[", stream);
        for (std::uint32_t index = 0U; index < row.encounter_count; ++index) {
            std::fprintf(stream, "%s%d", index == 0U ? "" : ",", row.body_ids[index]);
        }
        std::fputs("],\"vinfD_km_s\":[", stream);
        for (std::uint32_t index = 0U; index < row.leg_count; ++index) {
            if (index != 0U) {
                std::fputc(',', stream);
            }
            write_vec3(stream, row.vinfD_km_s[index]);
        }
        std::fputs("],\"vinfA_km_s\":[", stream);
        for (std::uint32_t index = 0U; index < row.leg_count; ++index) {
            if (index != 0U) {
                std::fputc(',', stream);
            }
            write_vec3(stream, row.vinfA_km_s[index]);
        }
        std::fputs("],\"dv_lev_km_s\":[", stream);
        for (std::uint32_t index = 0U; index < row.leg_count; ++index) {
            std::fprintf(stream, "%s%.17g", index == 0U ? "" : ",", row.dv_lev_km_s[index]);
        }
        std::fputs("],\"eta_lev\":[", stream);
        for (std::uint32_t index = 0U; index < row.leg_count; ++index) {
            std::fprintf(stream, "%s%.17g", index == 0U ? "" : ",", row.eta_lev[index]);
        }
        std::fputs("],\"dv_patch_km_s\":[", stream);
        for (std::uint32_t index = 0U; index + 1U < row.leg_count; ++index) {
            std::fprintf(stream, "%s%.17g", index == 0U ? "" : ",", row.dv_patch_km_s[index]);
        }
        std::fputs("],\"leg_ils\":[", stream);
        for (std::uint32_t index = 0U; index < row.leg_count; ++index) {
            std::fprintf(
                stream,
                "%s%lld",
                index == 0U ? "" : ",",
                static_cast<long long>(row.leg_ils[index]));
        }
        std::fputs("],\"flyby_ifs\":[", stream);
        for (std::uint32_t index = 0U; index + 1U < row.leg_count; ++index) {
            std::fprintf(
                stream,
                "%s%lld",
                index == 0U ? "" : ",",
                static_cast<long long>(row.flyby_ifs[index]));
        }
        std::fprintf(
            stream,
            "],\"dv_total_km_s\":%.17g,\"tof_total_days\":%.17g,"
            "\"dv_escape_km_s\":%.17g,\"dv_insertion_km_s\":%.17g}\n",
            row.dv_total_km_s,
            row.tof_total_s / 86400.0,
            row.dv_escape_km_s,
            row.dv_insertion_km_s);
        if (std::ferror(stream) != 0) {
            std::fclose(stream);
            return false;
        }
    }
    return std::fclose(stream) == 0;
}

void print_counts(const star_search::StageCounts& counts) {
    std::printf("EncounterDB entries: %zu\n", counts.encounter_rows);
    std::printf("leg 0: %zu rows\n", counts.leg_rows[0]);
    std::printf("leg 1: %zu rows\n", counts.leg_rows[1]);
    std::printf("flyby 1: %zu rows\n", counts.flyby_rows[1]);
    std::printf("leg 2: %zu rows\n", counts.leg_rows[2]);
    std::printf("flyby 2: %zu rows\n", counts.flyby_rows[2]);
    std::printf(
        "fixpoint: %zu pass, removed=%zu\n",
        counts.fixpoint_passes,
        counts.fixpoint_removed);
    std::printf("combo: flyby stage 1 -> %zu candidates\n", counts.combo_rows[1]);
    std::printf("combo: flyby stage 2 -> %zu candidates\n", counts.combo_rows[2]);
    std::printf("final trajectories = %zu\n", counts.final_rows);
    std::printf(
        "tfilter: num_bins=%zu -> num_out=%zu\n",
        counts.tfilter_bins,
        counts.output_rows);
    std::printf("peak tracked bytes: %zu\n", counts.peak_memory_bytes);
}

}  // namespace

int main(int argc, char* argv[]) {
    Options options{};
    if (!parse_options(argc, argv, &options)) {
        std::fputs(
            "usage: star_search_native --problem FILE --ephemeris FILE --output FILE "
            "[--threads N] [--force-spawn-failure]\n",
            stderr);
        return 2;
    }

    star_search::Problem problem{};
    star_search::Status status =
        star_search::harness::parse_problem_file(options.problem_path, &problem);
    if (status != star_search::Status::Ok) {
        std::fprintf(stderr, "problem input: %s\n", star_search::status_message(status));
        return 1;
    }
    if (problem.memory_cap_bytes == 0U ||
        problem.memory_cap_bytes > star_search::kWasmMaximumMemoryBytes) {
        std::fputs("problem input: memory cap exceeds the wasm32 module ceiling\n", stderr);
        return 1;
    }
    star_search::MemoryBudget budget(problem.memory_cap_bytes);
    void* raw = nullptr;
    std::size_t byte_count = 0U;
    if (!read_file(options.ephemeris_path, problem.memory_cap_bytes, &raw, &byte_count)) {
        std::fputs("ephemeris input: read failed or exceeded memory cap\n", stderr);
        return 1;
    }
    star_search::Ephemeris ephemeris;
    status = star_search::decode_ephemeris(
        static_cast<const std::uint8_t*>(raw),
        byte_count,
        problem.row_cap,
        &budget,
        &ephemeris);
    std::free(raw);
    if (status != star_search::Status::Ok) {
        std::fprintf(stderr, "ephemeris input: %s\n", star_search::status_message(status));
        return 1;
    }

    star_search::ThreadOptions threads{};
    threads.requested_threads =
        options.threads > star_search::kMaxThreads
            ? star_search::kMaxThreads
            : static_cast<std::uint32_t>(options.threads);
    threads.force_spawn_failure = options.force_spawn_failure;
    star_search::OutputDB output;
    star_search::StageCounts counts{};
    status = star_search::run_star_search(
        problem,
        ephemeris,
        threads,
        &budget,
        &output,
        &counts);
    if (status != star_search::Status::Ok) {
        std::fprintf(stderr, "search failed: %s\n", star_search::status_message(status));
        return 1;
    }
    if (!write_output(options.output_path, output)) {
        std::fputs("output write failed\n", stderr);
        return 1;
    }
    print_counts(counts);
    return 0;
}
