/*
 * Runtime-parity probe for the vendored CCSDS 124.0-B-1 codec.
 *
 * WHY THIS EXISTS SEPARATELY FROM src/module.c:
 * The SDK's manifest compliance gate requires every PLG port to name a concrete
 * SDS identity with canonical + aligned-binary peers ("wildcard-port-type" is a
 * hard error). The compressed side of this codec has no ratified SDS identity
 * until `$CPS` lands, so the full module cannot be compiled through
 * compileModuleFromSource() yet. This probe compiles the IDENTICAL vendored
 * codec bytes with the IDENTICAL enforced toolchain and link flags, exposing a
 * flat linear-memory ABI, so the codec engine's cross-runtime behaviour can be
 * proven NOW and re-proven unchanged when the typed module lands.
 *
 * It is a test artifact. It is never published and never loaded by a host.
 *
 * ABI: all pointers are u32 offsets into the module's linear memory.
 *   p124_alloc(size) -> ptr            bump allocator over a static arena
 *   p124_reset()                       rewind the arena
 *   p124_compress(...)   -> rc         rc 0 = OK; written count via out param
 *   p124_decompress(...) -> rc
 *   p124_discover(ptr,len,out_f) -> rc
 *
 * No WASI calls, no host imports beyond the wasi-threads contract itself, so
 * the two lanes differ ONLY in the wasm engine.
 */

#include <stdint.h>
#include <stddef.h>

#include "ccsds124.h"

/*
 * Static arena. Deliberately NOT malloc: the vendored codec is allocation-free
 * by design and this probe keeps that property, so memory behaviour is a fixed
 * linear-memory constant identical in every runtime.
 */
#define P124_ARENA_BYTES (64u * 1024u * 1024u)
static uint8_t g_arena[P124_ARENA_BYTES];
static uint32_t g_arena_used = 0u;

static ccsds124_compressor_t g_compressor;
static ccsds124_decompressor_t g_decompressor;
static bitvector_t g_initial_mask;

__attribute__((export_name("p124_reset")))
void p124_reset(void) {
  g_arena_used = 0u;
}

__attribute__((export_name("p124_alloc")))
uint32_t p124_alloc(uint32_t size) {
  uint32_t aligned = (size + 15u) & ~15u;
  uint32_t base;
  if (aligned < size || (g_arena_used + aligned) > P124_ARENA_BYTES) {
    return 0u;
  }
  base = g_arena_used;
  g_arena_used += aligned;
  return (uint32_t)(uintptr_t)&g_arena[base];
}

__attribute__((export_name("p124_arena_capacity")))
uint32_t p124_arena_capacity(void) {
  return P124_ARENA_BYTES;
}

__attribute__((export_name("p124_compress")))
int32_t p124_compress(
  uint32_t in_ptr,
  uint32_t in_len,
  uint32_t f_bits,
  uint32_t robustness,
  int32_t pt_limit,
  int32_t ft_limit,
  int32_t rt_limit,
  uint32_t out_ptr,
  uint32_t out_cap,
  uint32_t written_ptr
) {
  size_t written = 0u;
  int rc;

  bitvector_init(&g_initial_mask, (size_t)f_bits);
  bitvector_zero(&g_initial_mask);

  rc = ccsds124_compressor_init(
    &g_compressor, (size_t)f_bits, &g_initial_mask, (uint8_t)robustness,
    pt_limit, ft_limit, rt_limit);
  if (rc != CCSDS124_OK) {
    return (int32_t)rc;
  }

  rc = ccsds124_compress(
    &g_compressor,
    (const uint8_t *)(uintptr_t)in_ptr,
    (size_t)in_len,
    (uint8_t *)(uintptr_t)out_ptr,
    (size_t)out_cap,
    &written);

  *(uint32_t *)(uintptr_t)written_ptr = (uint32_t)written;
  return (int32_t)rc;
}

__attribute__((export_name("p124_decompress")))
int32_t p124_decompress(
  uint32_t in_ptr,
  uint32_t in_len,
  uint32_t f_bits,
  uint32_t robustness,
  uint32_t out_ptr,
  uint32_t out_cap,
  uint32_t written_ptr
) {
  size_t written = 0u;
  int rc;

  bitvector_init(&g_initial_mask, (size_t)f_bits);
  bitvector_zero(&g_initial_mask);

  rc = ccsds124_decompressor_init(
    &g_decompressor, (size_t)f_bits, &g_initial_mask, (uint8_t)robustness);
  if (rc != CCSDS124_OK) {
    return (int32_t)rc;
  }

  rc = ccsds124_decompress(
    &g_decompressor,
    (const uint8_t *)(uintptr_t)in_ptr,
    (size_t)in_len,
    (uint8_t *)(uintptr_t)out_ptr,
    (size_t)out_cap,
    &written);

  *(uint32_t *)(uintptr_t)written_ptr = (uint32_t)written;
  return (int32_t)rc;
}

__attribute__((export_name("p124_discover")))
int32_t p124_discover(uint32_t in_ptr, uint32_t in_len, uint32_t out_f_ptr) {
  uint32_t discovered = 0u;
  int rc = ccsds124_discover_packet_length(
    (const uint8_t *)(uintptr_t)in_ptr, (size_t)in_len, &discovered);
  *(uint32_t *)(uintptr_t)out_f_ptr = discovered;
  return (int32_t)rc;
}
