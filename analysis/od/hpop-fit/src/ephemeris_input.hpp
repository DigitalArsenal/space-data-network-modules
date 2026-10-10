// An operator ephemeris held in memory, as both fits need it: every sample
// at its exact two-part UTC epoch, in GCRF (metres, the HPOP fit) and in TEME
// (km, the SGP4 fit and every RMS that is compared with CelesTrak).
//
// Formats: SpaceX MEME text, CCSDS OEM KVN, and the SDS $OEM FlatBuffer,
// read by analysis/od's own parsers (parse_meme, parse_oem_source,
// read_oem_flatbuffer_source); this layer only re-reads their epoch tokens at
// full precision and applies one frame chain (time_frames.hpp).
#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <vector>

#include "time_frames.hpp"

namespace odhpop {

struct Sample {
  UtcEpoch t;
  std::array<double, 6> gcrf_m{};   // m, m/s
  std::array<double, 6> teme_km{};  // km, km/s
  bool has_velocity = true;
  int segment = 0;  // the source's own segment (OEM META block)
};

struct Ephemeris {
  std::string format;        // "meme", "oem", "oem-fb"
  std::string source_frame;  // as declared (EME2000, ITRF, TEME, ...)
  std::string time_system;   // as declared (UTC, GPS, TAI)
  std::string object_name;
  std::string object_id;
  int norad_cat_id = 0;
  int segment_count = 1;
  bool position_only = false;
  std::vector<Sample> samples;
};

struct ReadResult {
  bool ok = false;
  std::string error_code;
  std::string error_message;
  Ephemeris ephemeris;
};

// `format` "meme", "oem", "oem-fb" or empty (detect). ITRF sources need the
// Earth orientation; TEME and EME2000 do not.
ReadResult read_ephemeris(const uint8_t* bytes, std::size_t size, const std::string& format,
                          const EarthOrientation* eop);

// sha256 of the raw bytes, lowercase hex (the provenance kept for every input;
// the bytes themselves are never kept).
std::string sha256_hex(const uint8_t* bytes, std::size_t size);

}  // namespace odhpop
