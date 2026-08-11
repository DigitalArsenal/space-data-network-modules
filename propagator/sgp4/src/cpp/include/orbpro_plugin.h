/**
 * OrbPro Plugin SDK - C/C++ Header
 *
 * Provides macros and utilities for building OrbPro WASM plugins.
 *
 * @file orbpro_plugin.h
 */

#ifndef ORBPRO_PLUGIN_H
#define ORBPRO_PLUGIN_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define ORBPRO_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define ORBPRO_EXPORT __attribute__((visibility("default")))
#endif

/**
 * Plugin ABI version - must match SDK version
 */
#define ORBPRO_ABI_VERSION 1

/**
 * Mark a string for encryption by LLVM obfuscation pass
 */
#define ORBPRO_ENCRYPT_STRING __attribute__((annotate("encrypt")))

/**
 * Mark a function to skip control flow flattening
 */
#define ORBPRO_NO_CFF __attribute__((annotate("no-cff")))

/**
 * Plugin initialization result
 */
typedef enum {
    ORBPRO_OK = 0,
    ORBPRO_ERROR_INVALID_KEY = 1,
    ORBPRO_ERROR_EXPIRED = 2,
    ORBPRO_ERROR_DOMAIN = 3,
    ORBPRO_ERROR_ABI_MISMATCH = 4,
    ORBPRO_ERROR_INIT_FAILED = 5,
} OrbProResult;

/**
 * Plugin metadata structure
 */
typedef struct {
    const char* plugin_id;
    const char* name;
    const char* version;
    uint32_t abi_version;
} OrbProPluginInfo;

/**
 * Memory allocation functions (provided by host)
 * Use these instead of malloc/free for cross-boundary allocations
 */
#ifdef __EMSCRIPTEN__
// Emscripten provides malloc/free
#include <stdlib.h>
#define orbpro_malloc malloc
#define orbpro_free free
#else
// The standalone WASI guest owns its allocator. It must not import a host
// allocator: that would add a non-WASI import and make the one artifact fail
// under either the browser shim or WasmEdge.
#include <stdlib.h>
#define orbpro_malloc malloc
#define orbpro_free free
#endif

/**
 * Helper macro for defining plugin entry point
 */
#define ORBPRO_PLUGIN_ENTRY(name, init_fn, info_fn) \
    ORBPRO_EXPORT OrbProResult name##_init(const uint8_t* key, size_t key_len) { \
        return init_fn(key, key_len); \
    } \
    ORBPRO_EXPORT const OrbProPluginInfo* name##_info(void) { \
        return info_fn(); \
    }

/**
 * FlatBuffers aligned binary utilities
 *
 * These helpers ensure proper alignment for zero-copy access
 */

/**
 * Check if a buffer is properly aligned for FlatBuffers
 */
static inline bool orbpro_is_aligned(const void* ptr, size_t alignment) {
    return ((uintptr_t)ptr % alignment) == 0;
}

/**
 * Get aligned pointer (rounds up)
 */
static inline void* orbpro_align_ptr(void* ptr, size_t alignment) {
    uintptr_t addr = (uintptr_t)ptr;
    uintptr_t aligned = (addr + alignment - 1) & ~(alignment - 1);
    return (void*)aligned;
}

/**
 * Allocate aligned memory for FlatBuffers
 */
static inline void* orbpro_alloc_aligned(size_t size, size_t alignment) {
    // Allocate extra space for alignment
    void* raw = orbpro_malloc(size + alignment);
    if (!raw) return NULL;

    // Store original pointer before aligned data
    void* aligned = orbpro_align_ptr((char*)raw + sizeof(void*), alignment);
    ((void**)aligned)[-1] = raw;

    return aligned;
}

/**
 * Free aligned memory
 */
static inline void orbpro_free_aligned(void* aligned) {
    if (aligned) {
        void* raw = ((void**)aligned)[-1];
        orbpro_free(raw);
    }
}

/**
 * Buffer descriptor for FlatBuffers data
 */
typedef struct {
    uint8_t* data;      // Aligned buffer data
    size_t size;        // Size in bytes
    size_t capacity;    // Allocated capacity
    bool owns_memory;   // True if we should free on destroy
} OrbProBuffer;

/**
 * Initialize a buffer
 */
static inline void orbpro_buffer_init(OrbProBuffer* buf) {
    buf->data = NULL;
    buf->size = 0;
    buf->capacity = 0;
    buf->owns_memory = false;
}

/**
 * Allocate buffer with capacity
 */
static inline bool orbpro_buffer_alloc(OrbProBuffer* buf, size_t capacity) {
    buf->data = (uint8_t*)orbpro_alloc_aligned(capacity, 8);
    if (!buf->data) return false;
    buf->capacity = capacity;
    buf->size = 0;
    buf->owns_memory = true;
    return true;
}

/**
 * Wrap existing data (does not copy)
 */
static inline void orbpro_buffer_wrap(OrbProBuffer* buf, uint8_t* data, size_t size) {
    buf->data = data;
    buf->size = size;
    buf->capacity = size;
    buf->owns_memory = false;
}

/**
 * Destroy buffer (frees if owned)
 */
static inline void orbpro_buffer_destroy(OrbProBuffer* buf) {
    if (buf->owns_memory && buf->data) {
        orbpro_free_aligned(buf->data);
    }
    orbpro_buffer_init(buf);
}

#endif // ORBPRO_PLUGIN_H
