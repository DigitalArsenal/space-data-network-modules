/*
 * Cross-runtime vector driver for the vendored CCSDS 124.0-B-1 codec.
 *
 * ONE artifact, TWO engines. This is a WASI preview1 command, so the identical
 * wasm bytes run under:
 *   - Node's WASI implementation (the JS-engine lane)
 *   - WasmEdge (native and the pinned Docker parity image)
 * with the only difference being the wasm engine itself. Any byte-level
 * disagreement between the lanes is therefore an engine defect, not a harness
 * artefact -- which is the whole point of the exercise.
 *
 * This is a TEST artifact: it is never published and never loaded by a host.
 * The vendored codec it links is byte-identical to the codec in the shipping
 * module (same six files, same toolchain, same flags).
 *
 * usage:
 *   codec-cli compress   <in> <out> <packet_bytes> <R> <pt> <ft> <rt>
 *   codec-cli decompress <in> <out> <packet_bytes> <R> <packet_count>
 *   codec-cli discover   <in>
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include "ccsds124.h"

/* 32 MiB in + 32 MiB out: the largest reference vector (venus-express) is
 * 13.6 MB uncompressed / 5.9 MB compressed, so this clears it ~2.3x. */
#define ARENA_BYTES (64u * 1024u * 1024u)
static uint8_t g_in[ARENA_BYTES / 2u];
static uint8_t g_out[ARENA_BYTES / 2u];
static ccsds124_compressor_t g_compressor;
static ccsds124_decompressor_t g_decompressor;
static bitvector_t g_initial_mask;

static long read_all(const char *path, uint8_t *dst, size_t cap) {
  FILE *f = fopen(path, "rb");
  size_t n;
  if (f == NULL) {
    fprintf(stderr, "cannot open %s\n", path);
    return -1;
  }
  n = fread(dst, 1u, cap, f);
  fclose(f);
  return (long)n;
}

static int write_all(const char *path, const uint8_t *src, size_t len) {
  FILE *f = fopen(path, "wb");
  size_t n;
  if (f == NULL) {
    fprintf(stderr, "cannot create %s\n", path);
    return -1;
  }
  n = fwrite(src, 1u, len, f);
  fclose(f);
  return (n == len) ? 0 : -1;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: codec-cli <compress|decompress|discover> ...\n");
    return 2;
  }

  if (strcmp(argv[1], "compress") == 0) {
    long in_len;
    size_t written = 0u;
    int rc;
    size_t f_bits;

    if (argc != 9) { fprintf(stderr, "compress needs 7 args\n"); return 2; }
    f_bits = (size_t)strtoul(argv[4], NULL, 10) * 8u;
    in_len = read_all(argv[2], g_in, sizeof(g_in));
    if (in_len < 0) return 1;

    bitvector_init(&g_initial_mask, f_bits);
    bitvector_zero(&g_initial_mask);
    rc = ccsds124_compressor_init(
      &g_compressor, f_bits, &g_initial_mask,
      (uint8_t)strtoul(argv[5], NULL, 10),
      (int)strtol(argv[6], NULL, 10),
      (int)strtol(argv[7], NULL, 10),
      (int)strtol(argv[8], NULL, 10));
    if (rc != CCSDS124_OK) { fprintf(stderr, "init rc=%d\n", rc); return 1; }

    rc = ccsds124_compress(
      &g_compressor, g_in, (size_t)in_len, g_out, sizeof(g_out), &written);
    if (rc != CCSDS124_OK) { fprintf(stderr, "compress rc=%d\n", rc); return 1; }
    if (write_all(argv[3], g_out, written) != 0) return 1;
    printf("%zu\n", written);
    return 0;
  }

  if (strcmp(argv[1], "decompress") == 0) {
    long in_len;
    size_t written = 0u;
    int rc;
    size_t f_bits;
    size_t packet_count;
    size_t expect;

    if (argc != 7) { fprintf(stderr, "decompress needs 5 args\n"); return 2; }
    f_bits = (size_t)strtoul(argv[4], NULL, 10) * 8u;
    packet_count = (size_t)strtoul(argv[6], NULL, 10);
    expect = packet_count * (f_bits / 8u);
    if (expect > sizeof(g_out)) { fprintf(stderr, "output too large\n"); return 1; }

    in_len = read_all(argv[2], g_in, sizeof(g_in));
    if (in_len < 0) return 1;

    bitvector_init(&g_initial_mask, f_bits);
    bitvector_zero(&g_initial_mask);
    rc = ccsds124_decompressor_init(
      &g_decompressor, f_bits, &g_initial_mask, (uint8_t)strtoul(argv[5], NULL, 10));
    if (rc != CCSDS124_OK) { fprintf(stderr, "init rc=%d\n", rc); return 1; }

    rc = ccsds124_decompress(
      &g_decompressor, g_in, (size_t)in_len, g_out, expect, &written);
    if (rc != CCSDS124_OK) { fprintf(stderr, "decompress rc=%d\n", rc); return 1; }
    if (write_all(argv[3], g_out, written) != 0) return 1;
    printf("%zu\n", written);
    return 0;
  }

  if (strcmp(argv[1], "discover") == 0) {
    long in_len;
    uint32_t f = 0u;
    int rc;
    if (argc != 3) { fprintf(stderr, "discover needs 1 arg\n"); return 2; }
    in_len = read_all(argv[2], g_in, sizeof(g_in));
    if (in_len < 0) return 1;
    rc = ccsds124_discover_packet_length(g_in, (size_t)in_len, &f);
    printf("%u %d\n", f, rc);
    return 0;
  }

  fprintf(stderr, "unknown command %s\n", argv[1]);
  return 2;
}
