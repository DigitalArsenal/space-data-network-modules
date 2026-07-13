#ifndef OD_STATE_SERIES_H
#define OD_STATE_SERIES_H

/**
 * Common internal state-vector-series representation.
 *
 * This is the single interface the SGP4 fitter consumes, regardless of source
 * format. Both ephemeris parsers (SpaceX MEME text and CCSDS OEM KVN) produce a
 * StateSeries, so adding a provider/format is a parser change, never a fitter
 * change.
 *
 * Invariants a StateSeries hands to the fitter:
 *   - samples[].epoch_jd is a UTC Julian Date.
 *   - samples[] position/velocity are expressed in TEME (True Equator, Mean
 *     Equinox of date) km / km/s — the frame SGP4 propagates in. Parsers are
 *     responsible for converting into TEME (MEME is already TEME; OEM EME2000
 *     is rotated via od::eci_j2000_to_teme). meta.source_frame records the
 *     original input frame for provenance.
 *
 * The per-sample type reuses EphemerisPoint (position/velocity + optional
 * covariance); despite its historical name it is format-neutral.
 */

#include <string>
#include <vector>

#include "od/meme_parser.h"  // EphemerisPoint

namespace od {

/// Identity + provenance carried alongside a series. Empty string / 0 means
/// "not supplied by the source"; the fitter/caller fills gaps from the manifest.
struct StateSeriesMeta {
    int norad_cat_id = 0;
    std::string object_name;   // e.g. "ISS", "STARLINK-36348"
    std::string object_id;     // COSPAR / international designator, e.g. "1998-067-A"
    std::string data_source;   // provider/source token, e.g. "SpaceX-E", "ISS-E"
    std::string center_name;   // normalized center, e.g. "EARTH"
    std::string ref_frame;     // frame samples are expressed in (always "TEME" here)
    std::string source_frame;  // original input frame token (e.g. "EME2000", "UVW")
    std::string time_system;   // e.g. "UTC"
    int segment_count = 1;     // number of OEM META/data segments (MEME = 1)
};

/// A time-ordered series of state vectors in TEME + provenance metadata.
struct StateSeries {
    StateSeriesMeta meta;
    std::vector<EphemerisPoint> samples;
};

}  // namespace od

#endif  // OD_STATE_SERIES_H
