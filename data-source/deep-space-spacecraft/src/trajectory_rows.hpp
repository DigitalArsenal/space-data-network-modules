#pragma once
// A regular ICRF/TDB row grid, independent of transport and SDS encoding.
#include <cstdint>
#include <string>
#include <vector>

namespace trajectory {
struct Block {
  int64_t start = 0, stop = 0, step = 0;
  std::string label;
  std::vector<double> data;
  int center = 10;
};
inline Block slice(const Block& block, size_t first, size_t last) {
  return {block.start + int64_t(first) * block.step, block.start + int64_t(last) * block.step,
          block.step, block.label, {block.data.begin() + first * 6, block.data.begin() + (last + 1) * 6}, block.center};
}
inline const char* centerName(int id) {
  switch (id) {
    case 10: return "SUN";
    case 199: return "MERCURY";
    case 299: return "VENUS";
    case 301: return "MOON";
    case 399: return "EARTH";
    case 499: return "MARS";
    case 599: return "JUPITER";
    case 699: return "SATURN";
    default: return "";
  }
}
} // namespace trajectory
