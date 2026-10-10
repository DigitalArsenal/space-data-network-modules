// Provider-native ephemeris formats, parsed from the bytes as fetched (in
// memory; nothing is written anywhere). Each parser returns one RawSeries per
// object in the file, in the provider's own frame and time scale, untouched:
// ephemeris_input.cpp rotates them (time_frames.hpp) and the fit selects one.
//
// SpaceX MEME, CCSDS OEM KVN and the SDS $OEM FlatBuffer are read by
// analysis/od's own parsers (ephemeris_input.cpp); this directory holds the
// other providers' formats.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace odhpop::formats {

struct RawSample {
  std::string epoch;   // ISO 8601 calendar or day-of-year, on `scale`
  double offset_s = 0;  // seconds after `epoch` (compact formats)
  double r_km[3] = {0, 0, 0};
  double v_km[3] = {0, 0, 0};
  bool has_velocity = true;
  int segment = 0;  // the provider's own block / maneuver segment
};

// An operator-declared event (maneuver, attitude change) with its epoch.
struct RawEvent {
  std::string epoch;
  std::string text;
};

struct RawSeries {
  std::string frame;  // GCRF, ICRF, EME2000, J2000, TEME, ITRF*, IGS*, ECEF
  std::string scale;  // UTC, GPS, TAI
  std::string object_name;
  std::string object_id;  // COSPAR
  int norad_cat_id = 0;
  std::vector<RawSample> samples;
  std::vector<RawEvent> events;
};

struct ParseResult {
  bool ok = false;
  std::string error_code;  // "parse-failed", "unsupported-format", ...
  std::string error_message;
  std::vector<RawSeries> objects;
};

// The registry: format token -> parser. Tokens are the `inputFormat` option.
//   "css-oem-zip"   China Manned Space Agency: a zip holding a CCSDS OEM
//   "planet-states" Planet Labs planet.states
//   "iess412-i11"   Intelsat / SES IESS-412 11-parameter elements, evaluated
//                   to states over their validity span
//   "oneweb-ltef"   Eutelsat OneWeb LTEF CSV
//   "moditc"        NASA Modified ITC (Space-Track-hosted operator files)
//   "sp3"           IGS SP3-c/d precise orbits (positions, GPS time, ITRF/IGS)
//   "cpf"           ILRS CPF v2 predictions (positions, UTC, ITRF)
ParseResult parse(const std::string& format, const uint8_t* bytes, std::size_t size);

// Every token parse() accepts.
std::vector<std::string> formats();

}  // namespace odhpop::formats
