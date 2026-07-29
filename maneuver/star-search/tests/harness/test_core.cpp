#include "bounded_buffer.hpp"
#include "constants.hpp"
#include "ephemeris.hpp"
#include "status.hpp"
#include "threading.hpp"

#include <cstdint>
#include <cstdlib>
#include <cstdio>
#include <cstring>

namespace {

int failures = 0;

#define CHECK(condition)                                                                            \
    do {                                                                                            \
        if (!(condition)) {                                                                         \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition);              \
            ++failures;                                                                             \
        }                                                                                           \
    } while (false)

struct FillContext {
    std::uint64_t* values;
};

void fill_range(std::size_t begin, std::size_t end, void* raw) {
    FillContext* context = static_cast<FillContext*>(raw);
    for (std::size_t index = begin; index < end; ++index) {
        context->values[index] = static_cast<std::uint64_t>(index * 17U + 3U);
    }
}

}  // namespace

int main() {
    using namespace star_search;

    std::size_t product = 0;
    CHECK(checked_multiply(12U, 13U, &product));
    CHECK(product == 156U);
    CHECK(!checked_multiply(static_cast<std::size_t>(-1), 2U, &product));

    MemoryBudget budget(64U);
    Buffer<std::uint64_t> buffer;
    CHECK(buffer.resize(8U, &budget) == Status::Ok);
    CHECK(budget.live_bytes() == 64U);
    CHECK(buffer.push_back(9U, 8U, &budget) == Status::RowLimitExceeded);
    CHECK(buffer.resize(9U, &budget) == Status::MemoryLimitExceeded);

    std::uint64_t inline_values[31] = {};
    std::uint64_t threaded_values[31] = {};
    FillContext inline_context{inline_values};
    FillContext threaded_context{threaded_values};

    ThreadOptions inline_options{};
    inline_options.requested_threads = 4U;
    inline_options.force_spawn_failure = true;
    CHECK(parallel_for_fixed(31U, inline_options, fill_range, &inline_context) == Status::Ok);

    ThreadOptions threaded_options{};
    threaded_options.requested_threads = 4U;
    CHECK(parallel_for_fixed(31U, threaded_options, fill_range, &threaded_context) == Status::Ok);
    CHECK(std::memcmp(inline_values, threaded_values, sizeof(inline_values)) == 0);

    CHECK(std::strcmp(status_message(Status::UnsupportedDsm), "unsupported DSM") == 0);

    double value = 0.0;
    CHECK(body_gm(808, &value) == Status::Ok);
    CHECK(value == 2.583422379120727E+00);
    CHECK(body_gm_de431(801, &value) == Status::Ok);
    CHECK(value == 1.427598140725034E+03);
    CHECK(body_mean_radius(618, &value) == Status::Ok);
    CHECK(value == (17.2 + 15.7 + 10.4) / 3.0);
    CHECK(body_semi_major_axis(401, &value) == Status::Ok);
    CHECK(value == 9378.0);

    const char* fixture_path = "tests/vectors/test2_EMEJ.ephem";
    std::FILE* fixture = std::fopen(fixture_path, "rb");
    CHECK(fixture != nullptr);
    if (fixture != nullptr) {
        CHECK(std::fseek(fixture, 0, SEEK_END) == 0);
        const long byte_count_long = std::ftell(fixture);
        CHECK(byte_count_long > 0);
        CHECK(std::fseek(fixture, 0, SEEK_SET) == 0);
        const std::size_t byte_count = static_cast<std::size_t>(byte_count_long);
        void* bytes = std::malloc(byte_count);
        CHECK(bytes != nullptr);
        if (bytes != nullptr) {
            CHECK(std::fread(bytes, 1U, byte_count, fixture) == byte_count);
            MemoryBudget ephemeris_budget(2U * 1024U * 1024U);
            Ephemeris ephemeris;
            CHECK(decode_ephemeris(
                      static_cast<const std::uint8_t*>(bytes),
                      byte_count,
                      10000U,
                      &ephemeris_budget,
                      &ephemeris) == Status::Ok);
            CHECK(ephemeris.body_count == 3U);
            CHECK(ephemeris.total_sample_count == 6227U);
            State6 state{};
            CHECK(query_ephemeris(ephemeris, 399, 631108869.18390727, &state) == Status::Ok);
            CHECK(state.position_km.x == -24887036.59224112);
            CHECK(state.velocity_km_s.y == -5.162793418063706);
            CHECK(query_ephemeris(
                      ephemeris,
                      399,
                      631108869.18390727 + 86400.0,
                      &state) == Status::Ok);
            CHECK(std::isfinite(state.position_km.x));
            CHECK(std::isfinite(state.velocity_km_s.y));
            CHECK(query_ephemeris(ephemeris, 399, 1.0, &state) == Status::EphemerisOutOfRange);
            std::free(bytes);
        }
        std::fclose(fixture);
    }

    if (failures != 0) {
        std::fprintf(stderr, "%d failure(s)\n", failures);
        return 1;
    }
    std::puts("test_core: PASS");
    return 0;
}
