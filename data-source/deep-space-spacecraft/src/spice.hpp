#pragma once
// SPICE mission kernels as trajectory rows. The DAF reader and the segment
// evaluator are files/orbit-products' daf.hpp and spk_read.hpp (types 2, 3, 8,
// 9, 13; others are refused by name and counted here). Kept: spacecraft
// targets (negative NAIF ids) relative to the Earth (399) or the Moon (301) in
// J2000 (= ICRF here, as Horizons' ICRF rows). Each run of one center is
// evaluated on the window grid of that center (Moon 300 s, Earth 900 s,
// multiples of the step from J2000 TDB); a coverage gap ends a run. Where
// segments overlap, the later segment in the file wins, as in SPICE.
#include "discovery.hpp"
#include <algorithm>
#include <cmath>
#include <map>
#include <string>
#include <vector>

namespace spice {
constexpr int64_t kRecentSpan = 30 * horizons::kDay; // the newest 30 days of a target's kernel coverage
struct Stats { size_t segments = 0, unsupported = 0, ignored = 0; };
struct Run { int center; int64_t start, stop, step; std::vector<std::array<double, 6>> rows; };

inline int64_t stepFor(int center) { return center == 301 ? discovery::kMoonStep : discovery::kEarthStep; }
inline int64_t ceilTo(double t, int64_t step) { return int64_t(std::ceil(t / double(step))) * step; }
inline int64_t floorTo(double t, int64_t step) { return int64_t(std::floor(t / double(step))) * step; }

// Rows for every kept target, keyed by the reconciled NAIF id.
inline bool read(const uint8_t* bytes, size_t size, const std::string& mission,
                 std::map<int, std::vector<Run>>& out, Stats& stats, std::string& error) {
  daf::File file;
  if (daf::read(bytes, size, &file, false) != ephem::Status::Ok || file.id_word != "DAF/SPK" ||
      file.nd != 2 || file.ni != 6) { error = "invalid-spk"; return false; }
  std::map<int, std::vector<size_t>> byTarget;
  for (size_t i = 0; i < file.summaries.size(); ++i) {
    const auto& s = file.summaries[i];
    const int target = spk::segment_target(s), center = spk::segment_center(s);
    if (target >= 0 || (center != 301 && center != 399) || spk::segment_frame(s) != 1) { ++stats.ignored; continue; }
    if (!spk::is_supported_type(spk::segment_type(s))) { ++stats.unsupported; continue; }
    ++stats.segments;
    byTarget[horizons::reconcileId(mission, target)].push_back(i);
  }
  for (const auto& [id, indices] : byTarget) {
    // Grid points per center, each evaluated by the last file segment covering it.
    std::vector<int64_t> times;
    double hi = -1e300;
    for (size_t i : indices) hi = std::max(hi, file.summaries[i].dc[1]);
    const double from = hi - double(kRecentSpan);
    std::map<int64_t, std::pair<int, size_t>> owner; // grid time -> (center, segment)
    for (size_t i : indices) {
      const auto& s = file.summaries[i];
      const int center = spk::segment_center(s);
      const int64_t step = stepFor(center);
      for (int64_t t = ceilTo(std::max(s.dc[0], from), step); double(t) <= s.dc[1]; t += step) owner[t] = {center, i};
    }
    auto& runs = out[id];
    for (const auto& [t, who] : owner) {
      ephem::StateRow row;
      if (spk::evaluate(file, file.summaries[who.second], double(t), &row) != ephem::Status::Ok) {
        error = "spk-evaluation-failed"; return false;
      }
      const std::array<double, 6> state{row.pos[0], row.pos[1], row.pos[2], row.vel[0], row.vel[1], row.vel[2]};
      for (double v : state) if (!std::isfinite(v)) { error = "nonfinite-state"; return false; }
      const int64_t step = stepFor(who.first);
      if (runs.empty() || runs.back().center != who.first || runs.back().stop + step != t)
        runs.push_back({who.first, t, t, step, {}});
      runs.back().stop = t;
      runs.back().rows.push_back(state);
    }
    runs.erase(std::remove_if(runs.begin(), runs.end(), [](const Run& r) { return r.rows.size() < 2; }), runs.end());
  }
  return true;
}
} // namespace spice
