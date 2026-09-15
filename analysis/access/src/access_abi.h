#pragma once
#include <cstddef>
#include <cstdint>
#include <cstdlib>

// Keep the existing C entry points available to the orchestration adapter.
#define ORBPRO_EXPORT __attribute__((visibility("default")))
inline void* orbpro_malloc(size_t size) { return std::malloc(size); }
