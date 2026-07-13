#ifndef OD_OEM_PARSER_H
#define OD_OEM_PARSER_H

/**
 * CCSDS OEM (Orbit Ephemeris Message) KVN text parser — CCSDS 502.0-B.
 *
 * Consumes a KVN OEM (header + one or more META/data segments) and produces the
 * common StateSeries the SGP4 fitter fits against. First fixture: NASA's public
 * ISS OEM (EME2000, 4-minute steps).
 *
 * Frames handled (fail-closed on everything else):
 *   - TEME                          -> used as-is
 *   - EME2000 / J2000 / GCRF        -> rotated to TEME (od::eci_j2000_to_teme)
 * Time systems handled: UTC only.
 * Center: EARTH only (geocentric SGP4 fit).
 *
 * Units are the CCSDS-mandated km / km/s (there is no per-file units override in
 * OEM state lines).
 */

#include <string>

#include "od/state_series.h"

namespace od {

/// Outcome of an OEM parse. On failure `error_code` is a stable, precise token
/// ("unsupported-frame", "unsupported-time-system", "unsupported-center",
/// "parse-failed", "empty-ephemeris", "inconsistent-segments") and `series` is
/// empty.
struct OEMParseResult {
    bool ok = false;
    std::string error_code;
    std::string error_message;
    StateSeries series;
};

/// Parse a CCSDS OEM KVN document. All valid segments are concatenated into one
/// TEME series; identity metadata is taken from the first segment.
OEMParseResult parse_oem(const std::string& content);

/// Cheap content sniff: does this look like a CCSDS OEM KVN document?
bool looks_like_oem(const std::string& content);

}  // namespace od

#endif  // OD_OEM_PARSER_H
