// "oneweb-ltef": Eutelsat OneWeb https://ephemeris.oneweb.net/ltef/ltef.csv
//
// There is no public spec; the format was read from the live file in memory on
// 2026-10-10 (580 rows) and agrees with the finding recorded in
// data-source/oneweb-source/src/oneweb_source.cpp. The file is not an
// ephemeris. It has no header; each row is 17 comma-separated integers:
//   c0 slot id, c1 element epoch (GPS-epoch seconds, 1980-01-06), c2 file
//   reference epoch (GPS seconds, constant), c3 c4 c5 small per-plane
//   integers, c6 = 4096 on every row (a 2^12 fixed-point scale), c7 a per-plane
//   angle on a 2^18 = 360 degree scale (12 distinct values, the 12 planes), c8
//   a per-satellite phase in [0, 2^18), c9..c11 small integers, c12..c15
//   zero, c16 = 16.
// That is a compact fixed-point encoding of orbital elements (per-plane and
// per-satellite angles plus rates); it holds no Cartesian position or
// velocity, no semi-major axis, eccentricity or frame the file defines, and
// no column specification is public. Producing states would mean inventing the
// mapping, so this parser validates the structure and refuses with
// "not-an-ephemeris".
#include "formats_support.hpp"

namespace odhpop::formats::detail {

ParseResult parse_oneweb_ltef(const uint8_t* bytes, std::size_t size) {
  std::size_t rows = 0;
  const std::vector<std::string_view> lines = lines_of(bytes, size);
  for (std::size_t n = 0; n < lines.size(); ++n) {
    const std::string_view line = trim(lines[n]);
    if (line.empty()) continue;
    std::size_t cols = 0, start = 0;
    for (std::size_t i = 0; i <= line.size(); ++i) {
      if (i != line.size() && line[i] != ',') continue;
      long long v;
      if (!to_int(trim(line.substr(start, i - start)), &v))
        return failure("parse-failed", "LTEF row " + std::to_string(n + 1) + " column " + std::to_string(cols) + " is not an integer");
      ++cols;
      start = i + 1;
    }
    if (cols != 17) return failure("parse-failed", "LTEF row " + std::to_string(n + 1) + " has " + std::to_string(cols) + " columns, expected 17");
    ++rows;
  }
  if (rows == 0) return failure("parse-failed", "LTEF file holds no rows");
  return failure("not-an-ephemeris",
                 "OneWeb LTEF: " + std::to_string(rows) +
                     " rows of 17 integers hold a fixed-point encoding of orbital elements (per-plane and "
                     "per-satellite angles, GPS-second epochs), not Cartesian states; the column "
                     "specification is not public, so no states are produced");
}

}  // namespace odhpop::formats::detail
