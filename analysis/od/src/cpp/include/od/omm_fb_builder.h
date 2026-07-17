#ifndef OD_OMM_FB_BUILDER_H
#define OD_OMM_FB_BUILDER_H

/**
 * SDS $OMM (Orbit Mean-Elements Message) FlatBuffer builder — the aligned-binary
 * flow-node output path (SDN OD-Flow Phase 1a).
 *
 * Ports the Go buildOMM (kubo sdn/sdnruns/runner.go:439) into OD C++: it maps a
 * finished SGP4 fit (SGP4Elements) into a published SDS `$OMM` FlatBuffer
 * (schema OMM/main.fbs, root `OMM`, file_identifier "$OMM"), tagged
 * ORIGINATOR="SDN-OD" to mark the record as OUR OD supplemental-GP fit. NO JSON.
 *
 * Output byte-shape: a size-prefixed FlatBuffer ([u32le len][OMM]) as produced by
 * FinishSizePrefixedOMMBuffer — the exact aligned-binary payload the $PIV ABI
 * emits via plugin_push_output_ex(..., ALIGNED_BINARY, ...). The store's
 * content-addressed (non-size-prefixed) form is a later concern; a consumer that
 * wants it strips the 4-byte prefix (mirrors runner.go's sized[4:]).
 *
 * Extensibility (deferred $OCM/$OBD): the fit entry emits $OMM on the `omm`
 * output port today. Adding $OCM (COVARIANCE + OD_RESIDUALS) and $OBD (odMethod /
 * WRMS) is a NEW builder TU + a NEW output port off the SAME fit result — this
 * builder's signature (fit result in, bytes out) is the template.
 */

#include <cstdint>
#include <string>
#include <vector>

#include "od/sgp4_fitter.h"  // SGP4Elements

namespace od {

/// Build a size-prefixed SDS `$OMM` FlatBuffer from a fit's mean elements.
/// `originator` marks provenance (default "SDN-OD"). `creation_date` is the
/// ISO-8601 UTC creation stamp; pass a fixed value for deterministic tests, or
/// empty to omit. Returns the FlatBuffer payload bytes (size-prefixed).
std::vector<uint8_t> build_omm_flatbuffer(const SGP4Elements& el,
                                          const std::string& originator = "SDN-OD",
                                          const std::string& creation_date = std::string());

}  // namespace od

#endif  // OD_OMM_FB_BUILDER_H
