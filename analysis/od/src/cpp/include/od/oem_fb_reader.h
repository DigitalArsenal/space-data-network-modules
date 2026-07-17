#ifndef OD_OEM_FB_READER_H
#define OD_OEM_FB_READER_H

/**
 * SDS $OEM (Orbit Ephemeris Message) FlatBuffer reader — the aligned-binary
 * flow-node input path (SDN OD-Flow Phase 1a).
 *
 * This is the FlatBuffer sibling of the KVN text parser (oem_parser.{h,cpp}). It
 * reads a published SDS `$OEM` FlatBuffer (schema OEM/main.fbs, root `OEM`,
 * file_identifier "$OEM") and produces the SAME common StateSeries the SGP4
 * fitter consumes, so the fit is byte-for-byte identical to the KVN path for the
 * same state vectors (the sacred parity gate — see tests/test_oem_fb_parity.cpp).
 *
 * Design invariant (parity): every per-sample step MUST match parse_oem exactly —
 * the same REF_FRAME classification (classify_frame), the same TIME_SYSTEM->UTC
 * map (time_system_to_utc), the same iso_to_jd, and the same TEME rotation
 * (eci_j2000_to_teme / ecef_to_teme). The reader adds NO numerical step the text
 * path does not have; it only sources the numbers from FlatBuffer accessors
 * instead of tokenising text. REF_FRAME is honoured honestly (EME2000 stays
 * EME2000; it is NOT defaulted to TEME) — the Go oemBlockToKVN TEME-default bug
 * is not reproduced here.
 *
 * The reader returns the shared OEMParseResult (ok + precise error_code) so the
 * runtime error surface is identical to the KVN path.
 *
 * Extensibility (kept trivial for the deferred $OCM/$OBD output ports): this
 * reader only fills the fit INPUT (StateSeries). Adding $OCM/$OBD OUTPUT builders
 * later touches omm_fb_builder-style TUs, never this reader.
 */

#include <cstddef>
#include <cstdint>

#include "od/oem_parser.h"  // OEMParseResult

namespace od {

/// Parse an SDS `$OEM` FlatBuffer (NOT size-prefixed: the raw table root as
/// returned by GetOEM) into the common TEME StateSeries. `buf`/`len` are the
/// FlatBuffer payload bytes (e.g. plugin_input_frame_t::payload). Fails closed
/// with a precise error_code on an unverifiable buffer, an unsupported
/// frame/time-system/center, or an empty ephemeris — mirroring parse_oem.
OEMParseResult read_oem_flatbuffer(const uint8_t* buf, std::size_t len);

/// True when `buf`/`len` carries the "$OEM" file identifier (cheap 8-byte check;
/// used by the plugin entry to select the FlatBuffer path over the text path).
bool is_oem_flatbuffer(const uint8_t* buf, std::size_t len);

}  // namespace od

#endif  // OD_OEM_FB_READER_H
