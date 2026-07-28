/*
 * CCSDS 124.0-B-1 POCKET+ codec — Space Data Network isomorphic WASM module.
 *
 * The compression/decompression logic is the UNMODIFIED tanagraspace/ccsds124
 * reference C library (MIT), vendored verbatim under vendor/ccsds124/ and
 * amalgamated into this translation unit by ccsds124_amalgam.c. This file
 * contributes ONLY the module-SDK invoke glue: it moves bytes between the SDK
 * frame ABI and the reference API. It contains no codec logic, no host logic,
 * and no runtime detection.
 *
 * HOOKS: none. The module declares zero capabilities and performs zero host
 * calls — no http, no tcp, no fs, no clock, no wallet. A codec is a pure
 * transform, so REJECT-HOST-LOGIC is satisfied trivially and no new host
 * capability is invented.
 *
 * THREADING: POCKET+ is inherently sequential. Decoding packet k requires the
 * mask M and previous output I from packet k-1 (see SYNCHRONIZATION.md), so
 * there is NO intra-stream parallelism to exploit and none is faked. The
 * artifact is built for the wasm32-wasip1-threads target so a caller may drive
 * INDEPENDENT streams concurrently; each ccsds124_* context is self-contained
 * and the library has no mutable globals, so that is safe.
 *
 * INTERIM WIRE FORMAT: the SDS `$CPS` record that will carry these fields is
 * not yet ratified (graph task sds-ccsds124-compressed-packet-stream). Until it
 * is, both methods use a fixed 16-byte little-endian parameter header followed
 * by the payload, and the manifest ports are declared `acceptsAnyFlatbuffer`
 * (the SDK's opaque-byte port idiom, cf. examples/invoke-echo). When $CPS
 * ratifies, the typed $CPS <-> $SPP port pair replaces this header; the codec
 * path below does not change.
 *
 *   offset 0  : magic        4 bytes  "P+C1" (compress in) / "P+D1" (decompress in)
 *   offset 4  : f_bits       u32 LE   packet length in BITS (F). Required.
 *   offset 8  : robustness   u8       R_t, 0..7
 *   offset 9  : reserved     u8       must be 0
 *   offset 10 : pt_limit     u16 LE   new-mask period   (0 = manual)
 *   offset 12 : ft_limit     u16 LE   send-mask period  (0 = manual)
 *   offset 14 : rt_limit     u16 LE   uncompressed period (0 = manual)
 *   offset 16 : packet_count u32 LE   decompress: REQUIRED, non-zero.
 *                                     compress: MUST be 0 (derived from input).
 *   offset 20 : reserved     u32 LE   must be 0
 *   offset 24 : payload
 *
 * packet_count is REQUIRED on decode and is not a convenience field. A POCKET+
 * stream does not encode its own packet count, and the only bound derivable
 * from the bitstream alone is "packets <= compressed_bits", which over-allocates
 * by ~180x on the reference `housekeeping` vector (160 MB for a 900 KB answer).
 * A ratio-based guess is unsound in the other direction: `simple` compresses
 * 14x. So the count must be carried out-of-band. This is the evidence behind
 * making $CPS.PACKET_COUNT normative -- see SYNCHRONIZATION.md (d).
 */

#include <stdint.h>
#include <string.h>

#include "space_data_module_invoke.h"
#include "ccsds124.h"

#define P124_HEADER_BYTES 24u
#define P124_MAGIC_COMPRESS   "P+C1"
#define P124_MAGIC_DECOMPRESS "P+D1"

/*
 * Codec contexts live in module static storage, NOT on the stack. The
 * reference compressor is ~217 KB and the decompressor ~32 KB at
 * CCSDS124_MAX_PACKET_LENGTH; putting them in a stack frame would compound the
 * reference library's own large internal frames (measured worst-case decode
 * chain is ~631 KB on wasm32) and overflow the guest stack. Static placement
 * makes the memory cost a fixed, identical linear-memory constant in every
 * runtime, which is what keeps trap classes identical across browser and
 * WasmEdge.
 */
static ccsds124_compressor_t g_compressor;
static ccsds124_decompressor_t g_decompressor;
static bitvector_t g_initial_mask;

typedef struct {
  uint32_t f_bits;
  uint8_t robustness;
  int pt_limit;
  int ft_limit;
  int rt_limit;
  uint32_t packet_count;
} p124_params_t;

static uint32_t p124_read_u32le(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
         ((uint32_t)p[3] << 24);
}

static uint16_t p124_read_u16le(const uint8_t *p) {
  return (uint16_t)((uint32_t)p[0] | ((uint32_t)p[1] << 8));
}

/*
 * Parse and FULLY validate the interim header. Every rejection below is a
 * deterministic, data-dependent error return -- never a trap -- so that an
 * identical malformed input produces an identical error in every runtime
 * rather than a runtime-specific abort.
 */
static int p124_parse_header(
  const plugin_input_frame_t *frame,
  const char *expect_magic,
  p124_params_t *out,
  const uint8_t **payload,
  uint32_t *payload_length
) {
  if (frame == NULL || frame->payload == NULL) {
    plugin_set_error("missing-frame", "No input frame was provided.");
    return 1;
  }
  if (frame->payload_length < P124_HEADER_BYTES) {
    plugin_set_error(
      "short-header",
      "Input is shorter than the 16-byte POCKET+ parameter header."
    );
    return 1;
  }
  if (memcmp(frame->payload, expect_magic, 4) != 0) {
    plugin_set_error("bad-magic", "Input does not carry the expected POCKET+ header magic.");
    return 1;
  }

  out->f_bits = p124_read_u32le(&frame->payload[4]);
  out->robustness = frame->payload[8];
  out->pt_limit = (int)p124_read_u16le(&frame->payload[10]);
  out->ft_limit = (int)p124_read_u16le(&frame->payload[12]);
  out->rt_limit = (int)p124_read_u16le(&frame->payload[14]);
  out->packet_count = p124_read_u32le(&frame->payload[16]);

  if (frame->payload[9] != 0u || p124_read_u32le(&frame->payload[20]) != 0u) {
    plugin_set_error("reserved-nonzero", "Reserved header fields must be zero.");
    return 1;
  }
  if (out->f_bits == 0u || out->f_bits > (uint32_t)CCSDS124_MAX_PACKET_LENGTH) {
    plugin_set_error("bad-packet-length", "Packet length F is zero or exceeds CCSDS124_MAX_PACKET_LENGTH.");
    return 1;
  }
  if ((out->f_bits % 8u) != 0u) {
    plugin_set_error(
      "unaligned-packet-length",
      "This module accepts only octet-aligned packet lengths (F must be a multiple of 8)."
    );
    return 1;
  }
  if (out->robustness > (uint8_t)CCSDS124_MAX_ROBUSTNESS) {
    plugin_set_error("bad-robustness", "Robustness must be 0..7.");
    return 1;
  }

  *payload = &frame->payload[P124_HEADER_BYTES];
  *payload_length = frame->payload_length - P124_HEADER_BYTES;
  return 0;
}

/*
 * Compress a run of fixed-length packets into one POCKET+ stream.
 *
 * Input : header + (packet_count * F/8) uncompressed bytes.
 * Output: the octet-aligned compressed bitstream (no header; the caller
 *         already knows F/R because it supplied them).
 */
int compress_stream(void) {
  p124_params_t params;
  const uint8_t *input = NULL;
  uint32_t input_length = 0u;
  const plugin_input_frame_t *frame = plugin_get_input_frame(0);

  if (p124_parse_header(frame, P124_MAGIC_COMPRESS, &params, &input, &input_length) != 0) {
    return 3;
  }

  {
    const uint32_t packet_bytes = params.f_bits / 8u;
    if (input_length == 0u || (input_length % packet_bytes) != 0u) {
      plugin_set_error(
        "ragged-input",
        "Uncompressed input length must be a non-zero multiple of the packet length."
      );
      return 3;
    }
    if (params.packet_count != 0u) {
      plugin_set_error(
        "packet-count-not-derived",
        "packet_count must be 0 on compress; it is derived from the input length."
      );
      return 3;
    }
  }

  bitvector_init(&g_initial_mask, (size_t)params.f_bits);
  bitvector_zero(&g_initial_mask);

  if (ccsds124_compressor_init(
        &g_compressor,
        (size_t)params.f_bits,
        &g_initial_mask,
        params.robustness,
        params.pt_limit,
        params.ft_limit,
        params.rt_limit) != CCSDS124_OK) {
    plugin_set_error("compressor-init-failed", "ccsds124_compressor_init rejected the parameters.");
    return 3;
  }

  {
    /*
     * Worst case for POCKET+ is expansion, not compression: an uncompressed
     * (r_t=1) packet costs F bits plus a COUNT(F) prefix, and the reference
     * library sizes its own scratch at 12x the packet length. Allocating the
     * same 12x bound through the SDK allocator means a pathological input
     * returns a clean overflow error instead of diverging by runtime.
     */
    const uint32_t out_capacity = input_length * 12u + 1024u;
    const uint32_t out_ptr = plugin_alloc(out_capacity);
    uint8_t *out = (uint8_t *)(uintptr_t)out_ptr;
    size_t written = 0u;
    int rc;

    if (out_ptr == 0u) {
      plugin_set_error("alloc-failed", "Could not allocate the compressed output buffer.");
      return 3;
    }

    rc = ccsds124_compress(
      &g_compressor, input, (size_t)input_length, out, (size_t)out_capacity, &written);
    if (rc != CCSDS124_OK) {
      plugin_free(out_ptr, out_capacity);
      plugin_set_error("compress-failed", ccsds124_error_string(rc));
      return 3;
    }

    plugin_push_output("compressed", frame->schema_name, frame->file_identifier, out, (uint32_t)written);
    plugin_free(out_ptr, out_capacity);
  }
  return 0;
}

/*
 * Decompress a POCKET+ stream back to fixed-length packets.
 *
 * Input : header + the compressed bitstream.
 * Output: packet_count * F/8 reconstructed bytes.
 */
int decompress_stream(void) {
  p124_params_t params;
  const uint8_t *input = NULL;
  uint32_t input_length = 0u;
  const plugin_input_frame_t *frame = plugin_get_input_frame(0);

  if (p124_parse_header(frame, P124_MAGIC_DECOMPRESS, &params, &input, &input_length) != 0) {
    return 3;
  }
  if (input_length == 0u) {
    plugin_set_error("empty-input", "Compressed input is empty.");
    return 3;
  }

  bitvector_init(&g_initial_mask, (size_t)params.f_bits);
  bitvector_zero(&g_initial_mask);

  if (ccsds124_decompressor_init(
        &g_decompressor,
        (size_t)params.f_bits,
        &g_initial_mask,
        params.robustness) != CCSDS124_OK) {
    plugin_set_error("decompressor-init-failed", "ccsds124_decompressor_init rejected the parameters.");
    return 3;
  }

  if (params.packet_count == 0u) {
    plugin_set_error(
      "missing-packet-count",
      "Decompression requires a non-zero packet_count: a POCKET+ stream does not "
      "encode how many packets it contains."
    );
    return 3;
  }

  {
    /*
     * The output size is exactly packet_count * F/8 -- known because the caller
     * supplied the count, NOT because the bitstream revealed it. Sizing from the
     * count (rather than the unusable "packets <= compressed_bits" bound) keeps
     * the allocation exact and makes a wrong count a clean CCSDS124_ERROR_OVERFLOW
     * instead of a silent truncation.
     */
    const uint32_t packet_bytes = params.f_bits / 8u;
    const uint32_t out_capacity = params.packet_count * packet_bytes;
    uint32_t out_ptr;
    uint8_t *out;
    size_t written = 0u;
    int rc;

    if ((out_capacity / packet_bytes) != params.packet_count) {
      plugin_set_error("output-bound-overflow", "packet_count * packet_length overflows 32-bit size.");
      return 3;
    }

    out_ptr = plugin_alloc(out_capacity);
    out = (uint8_t *)(uintptr_t)out_ptr;
    if (out_ptr == 0u) {
      plugin_set_error("alloc-failed", "Could not allocate the decompressed output buffer.");
      return 3;
    }

    rc = ccsds124_decompress(
      &g_decompressor, input, (size_t)input_length, out, (size_t)out_capacity, &written);
    if (rc != CCSDS124_OK) {
      plugin_free(out_ptr, out_capacity);
      plugin_set_error("decompress-failed", ccsds124_error_string(rc));
      return 3;
    }

    plugin_push_output("decompressed", frame->schema_name, frame->file_identifier, out, (uint32_t)written);
    plugin_free(out_ptr, out_capacity);
  }
  return 0;
}

/*
 * Recover the packet length F from a compressed stream alone.
 *
 * POCKET+ is NOT self-describing in general: F is discoverable only from a
 * reference (r_t=1) packet. This surfaces the reference library's
 * ccsds124_discover_packet_length() so a mid-stream consumer can test whether a
 * segment is self-synchronizing before trying to decode it. See
 * SYNCHRONIZATION.md (c)/(d).
 *
 * Output: 8 bytes LE -- u32 f_bits, u32 status (0 = exact, 2 = truncated
 * reference packet / weak discovery). f_bits == 0 means "not discoverable from
 * this segment", which is a normal answer, not an error.
 */
int discover_packet_length(void) {
  const plugin_input_frame_t *frame = plugin_get_input_frame(0);
  uint32_t discovered = 0u;
  int rc;
  uint8_t result[8];

  if (frame == NULL || frame->payload == NULL || frame->payload_length == 0u) {
    plugin_set_error("missing-frame", "No compressed input frame was provided.");
    return 3;
  }

  rc = ccsds124_discover_packet_length(
    frame->payload, (size_t)frame->payload_length, &discovered);
  if ((rc != CCSDS124_OK) && (rc != CCSDS124_STATUS_TRUNCATED_LENGTH)) {
    plugin_set_error("discover-failed", ccsds124_error_string(rc));
    return 3;
  }

  result[0] = (uint8_t)(discovered & 0xffu);
  result[1] = (uint8_t)((discovered >> 8) & 0xffu);
  result[2] = (uint8_t)((discovered >> 16) & 0xffu);
  result[3] = (uint8_t)((discovered >> 24) & 0xffu);
  result[4] = (uint8_t)((uint32_t)rc & 0xffu);
  result[5] = 0u;
  result[6] = 0u;
  result[7] = 0u;

  plugin_push_output("length", frame->schema_name, frame->file_identifier, result, (uint32_t)sizeof(result));
  return 0;
}
