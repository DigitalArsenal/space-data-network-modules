// Native measurement helper for e2e-gravity-scratch-alloc.mjs, not a separate test.
// Source: the production initEGM2008Extended loader and computeExtendedGravity;
// the 70 -> 30 -> 4 call sequence is the full-force gravity/tide sequence.
// Inputs: ECEF positions in km on a 400 km circular track, acceleration in km/s^2.
// The coefficients are static, so epoch/time scale does not enter this probe.
// Allocation acceptance is exact (zero tolerance): storage already warmed for
// degree 70 must accommodate every subsequent degree-30 and degree-4 recursion.
// Numerical equivalence is checked by the E2E's complete WASM response comparison.

#include "environment_models.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <new>

namespace {
thread_local bool countAllocations = false;
thread_local std::uint64_t allocationCalls = 0;

void* allocate(std::size_t bytes) {
    void* memory = std::malloc(bytes == 0 ? 1 : bytes);
    if (!memory) throw std::bad_alloc();
    if (countAllocations) ++allocationCalls;
    return memory;
}

void* allocateAligned(std::size_t bytes, std::size_t alignment) {
    void* memory = nullptr;
    if (posix_memalign(&memory, alignment, bytes == 0 ? 1 : bytes) != 0) {
        throw std::bad_alloc();
    }
    if (countAllocations) ++allocationCalls;
    return memory;
}
}  // namespace

// Each replacement counts exactly once; delete and reporting never count.
void* operator new(std::size_t bytes) { return allocate(bytes); }
void* operator new[](std::size_t bytes) { return allocate(bytes); }
void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

void* operator new(std::size_t bytes, const std::nothrow_t&) noexcept {
    try { return allocate(bytes); } catch (...) { return nullptr; }
}
void* operator new[](std::size_t bytes, const std::nothrow_t&) noexcept {
    try { return allocate(bytes); } catch (...) { return nullptr; }
}
void operator delete(void* memory, const std::nothrow_t&) noexcept { std::free(memory); }
void operator delete[](void* memory, const std::nothrow_t&) noexcept { std::free(memory); }

void* operator new(std::size_t bytes, std::align_val_t alignment) {
    return allocateAligned(bytes, static_cast<std::size_t>(alignment));
}
void* operator new[](std::size_t bytes, std::align_val_t alignment) {
    return allocateAligned(bytes, static_cast<std::size_t>(alignment));
}
void operator delete(void* memory, std::align_val_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::align_val_t) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t, std::align_val_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t, std::align_val_t) noexcept { std::free(memory); }
void* operator new(std::size_t bytes, std::align_val_t alignment, const std::nothrow_t&) noexcept {
    try { return allocateAligned(bytes, static_cast<std::size_t>(alignment)); }
    catch (...) { return nullptr; }
}
void* operator new[](std::size_t bytes, std::align_val_t alignment, const std::nothrow_t&) noexcept {
    try { return allocateAligned(bytes, static_cast<std::size_t>(alignment)); }
    catch (...) { return nullptr; }
}
void operator delete(void* memory, std::align_val_t, const std::nothrow_t&) noexcept { std::free(memory); }
void operator delete[](void* memory, std::align_val_t, const std::nothrow_t&) noexcept { std::free(memory); }

namespace {
constexpr std::size_t warmupEvaluations = 10;
constexpr std::size_t evaluationsPerRepetition = 10000;
constexpr std::size_t repetitions = 5;
constexpr double altitudeKm = 400.0;
constexpr double inclinationDegrees = 51.6;

astro::ExtendedGravityField tideField(std::uint16_t degree) {
    astro::ExtendedGravityField field;
    field.mu = astro::EGM2008_GM_KM3_S2;
    field.referenceRadius = astro::EGM2008_RADIUS_KM;
    field.allocate(degree, degree);
    // Every harmonic coefficient is nonzero, so no harmonic term is skipped.
    for (std::uint16_t n = 0; n <= degree; ++n) {
        for (std::uint16_t m = 0; m <= n; ++m) {
            field.Cnm[n][m] = 1e-9;
            field.Snm[n][m] = -1e-9;
        }
    }
    return field;
}

double evaluation(const astro::Vec3& position,
                  const astro::ExtendedGravityField& earth,
                  const astro::ExtendedGravityField& ocean,
                  const astro::ExtendedGravityField& solid) {
    const auto gravity = astro::computeExtendedGravity(position, earth);
    const auto oceanTide = astro::computeExtendedGravity(position, ocean);
    const auto solidTide = astro::computeExtendedGravity(position, solid);
    // As in the force path, tide point-mass components are not added again.
    const auto acceleration = gravity.total + oceanTide.zonalHarmonics + solidTide.zonalHarmonics;
    return acceleration.x + 2.0 * acceleration.y + 3.0 * acceleration.z;
}

int run() {
    astro::EGM2008Config configuration;
    configuration.maxDegree = 70;
    configuration.maxOrder = 70;
    // This is the same embedded loader used by EmbeddedEarthGravityField.
    const auto earth = astro::initEGM2008Extended(configuration);
    const auto ocean = tideField(30);
    const auto solid = tideField(4);
    if (earth.maxDegree != 70 || earth.maxOrder != 70 || earth.Cnm[2][0] == 0.0) {
        std::fprintf(stderr, "Native probe: the embedded EGM2008 70x70 field did not load.\n");
        return 1;
    }

    // Generate the orbit in C++ before timing/counting; no host-language physics.
    std::array<astro::Vec3, evaluationsPerRepetition> positions;
    const double pi = std::acos(-1.0);
    const double inclination = inclinationDegrees * pi / 180.0;
    const double radius = earth.referenceRadius + altitudeKm;
    for (std::size_t i = 0; i < positions.size(); ++i) {
        const double angle = 2.0 * pi * static_cast<double>(i) / positions.size();
        positions[i] = astro::Vec3(radius * std::cos(angle),
                                  radius * std::sin(angle) * std::cos(inclination),
                                  radius * std::sin(angle) * std::sin(inclination));
    }

    volatile double checksumSink = 0.0;
    for (std::size_t i = 0; i < warmupEvaluations; ++i) {
        checksumSink = checksumSink + evaluation(positions[i], earth, ocean, solid);
    }

    std::array<std::uint64_t, repetitions> counts{};
    std::array<double, repetitions> microseconds{};
    std::array<double, repetitions> checksums{};
    for (std::size_t repetition = 0; repetition < repetitions; ++repetition) {
        allocationCalls = 0;
        double checksum = 0.0;
        const auto start = std::chrono::steady_clock::now();
        countAllocations = true;
        for (const auto& position : positions) {
            checksum += evaluation(position, earth, ocean, solid);
        }
        countAllocations = false;
        const auto finish = std::chrono::steady_clock::now();
        counts[repetition] = allocationCalls;
        microseconds[repetition] =
            std::chrono::duration<double, std::micro>(finish - start).count() / evaluationsPerRepetition;
        checksums[repetition] = checksum;
        checksumSink = checksumSink + checksum;
    }
    if (!std::isfinite(checksumSink)) {
        std::fprintf(stderr, "Native probe: gravity produced a nonfinite acceleration checksum.\n");
        return 1;
    }

    std::uint64_t totalAllocations = 0;
    for (const auto count : counts) totalAllocations += count;
    const double perEvaluation = static_cast<double>(totalAllocations) /
        (evaluationsPerRepetition * repetitions);
    const double minimumMicroseconds = *std::min_element(microseconds.begin(), microseconds.end());
    std::printf("{\"warmupEvaluations\":%zu,\"evaluationsPerRepetition\":%zu,\"repetitions\":%zu,"
                "\"gravityDegrees\":[70,30,4],\"altitudeKm\":%.17g,\"inclinationDegrees\":%.17g,"
                "\"referenceRadiusKm\":%.17g,\"muKm3PerS2\":%.17g,"
                "\"totalAllocations\":%llu,\"allocationsPerEvaluation\":%.17g,"
                "\"minimumMicrosecondsPerEvaluation\":%.17g,\"samples\":[",
                warmupEvaluations, evaluationsPerRepetition, repetitions,
                altitudeKm, inclinationDegrees, earth.referenceRadius, earth.mu,
                static_cast<unsigned long long>(totalAllocations), perEvaluation, minimumMicroseconds);
    for (std::size_t i = 0; i < repetitions; ++i) {
        std::printf("%s{\"allocations\":%llu,\"allocationsPerEvaluation\":%.17g,"
                    "\"microsecondsPerEvaluation\":%.17g,\"accelerationChecksumKmPerS2\":%.17g}",
                    i == 0 ? "" : ",", static_cast<unsigned long long>(counts[i]),
                    static_cast<double>(counts[i]) / evaluationsPerRepetition,
                    microseconds[i], checksums[i]);
    }
    std::printf("]}\n");
    return 0;
}
}  // namespace

int main() {
    try {
        return run();
    } catch (const std::exception& error) {
        countAllocations = false;
        std::fprintf(stderr, "Native probe failed: %s\n", error.what());
        return 1;
    }
}
