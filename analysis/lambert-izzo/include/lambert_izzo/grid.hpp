#ifndef LAMBERT_IZZO_GRID_HPP
#define LAMBERT_IZZO_GRID_HPP
#ifndef LAMBERT_IZZO_SOLVER_HPP
#include "solver.hpp"
#endif
#include <limits>

namespace lambert_grid {
using namespace lambert_izzo;
constexpr size_t kMaxAxis = 400;
struct State { double epoch; Vector3 r, v; }; // seconds, km, km/s internally
struct Options {
  double departure_start, departure_end, arrival_start, arrival_end, step, mu;
  uint16_t max_revolutions;
  bool prograde, retrograde;
};
// Status: 0 solved, 1 nonpositive TOF, 2 undefined plane, 3 nonconvergence.
// Branch values match LMO: 0 single, 1 multi left, 2 multi right.
struct Cell {
  double departure_epoch = 0, arrival_epoch = 0, tof = 0;
  double departure_dv = std::numeric_limits<double>::infinity();
  double arrival_dv = std::numeric_limits<double>::infinity();
  double total_dv = std::numeric_limits<double>::infinity();
  Vector3 v1, v2;
  int status = 3, revolutions = -1, branch = -1, direction = 0;
};
inline bool axis(const std::vector<State>& states, double start, double end,
                 double step, std::vector<size_t>& indices) {
  if (states.empty() || states.size() > kMaxAxis || !std::isfinite(start) ||
      !std::isfinite(end) || !std::isfinite(step) || step <= 0 || end < start)
    return false;
  for (size_t i = 0; i < states.size(); ++i) {
    const auto& s = states[i];
    if (!std::isfinite(s.epoch) || !finite(s.r) || !finite(s.v) ||
        !std::isfinite(norm(s.r)) || norm(s.r) <= 0 ||
        (i && s.epoch <= states[i-1].epoch)) return false;
  }
  const double intervals = (end - start) / step;
  if (!std::isfinite(intervals) || intervals >= kMaxAxis) return false;
  const size_t count = static_cast<size_t>(std::floor(intervals + 1e-10)) + 1;
  if (count > kMaxAxis || (count > 1 && start + step <= start)) return false;
  indices.clear();
  for (size_t i = 0; i < count; ++i) {
    const double epoch = start + i * step;
    // Only roundoff in epoch arithmetic is tolerated; never interpolate.
    const double tolerance = std::min(step * 1e-6,
        8 * std::numeric_limits<double>::epsilon() * std::max(1.0, std::abs(epoch)));
    const auto it = std::lower_bound(states.begin(), states.end(), epoch - tolerance,
        [](const State& s, double t) { return s.epoch < t; });
    if (it == states.end() || std::abs(it->epoch - epoch) > tolerance) return false;
    const size_t index = static_cast<size_t>(it - states.begin());
    if (!indices.empty() && index <= indices.back()) return false;
    indices.push_back(index);
  }
  return true;
}
inline Cell solve_cell(const State& d, const State& a, const Options& o) {
  Cell best;
  best.departure_epoch = d.epoch; best.arrival_epoch = a.epoch;
  best.tof = a.epoch - d.epoch;
  if (!(best.tof > 0) || !std::isfinite(best.tof)) { best.status = 1; return best; }
  Vector3 plane = cross(normalize(d.r), normalize(a.r));
  Vector3 antipodal_normal;
  if (norm(plane) == 0) {
    if (d.r.x*a.r.x + d.r.y*a.r.y + d.r.z*a.r.z >= 0) {
      best.status = 2; return best;
    }
    plane = cross(d.r, d.v);
    if (norm(plane) == 0) plane = cross(a.r, a.v);
    antipodal_normal = plane;
  }
  // Prograde/retrograde is defined by h_z, so a polar plane is ambiguous.
  if (!finite(plane) || norm(plane) == 0 || std::abs(plane.z) <= 1e-14*norm(plane)) {
    best.status = 2; return best;
  }
  for (int direction : {1, -1}) {
    if ((direction == 1 && !o.prograde) || (direction == -1 && !o.retrograde)) continue;
    const bool long_way = (plane.z > 0) != (direction == 1);
    Request request{d.r, a.r, best.tof, o.mu, long_way, o.max_revolutions, antipodal_normal};
    const auto result = solve(request);
    if (result.status != Status::Ok) {
      // A missing requested direction cannot establish a global minimum.
      Cell failed; failed.departure_epoch = d.epoch; failed.arrival_epoch = a.epoch;
      failed.tof = best.tof; return failed;
    }
    auto consider = [&](const Solution& s, int rev, int branch) {
      const double dv1 = norm(subtract(s.v1, d.v)), dv2 = norm(subtract(a.v, s.v2));
      const double total = dv1 + dv2;
      if (!std::isfinite(total) || total >= best.total_dv) return;
      best.status = 0; best.departure_dv = dv1; best.arrival_dv = dv2;
      best.total_dv = total; best.revolutions = rev; best.branch = branch;
      best.direction = direction; best.v1 = s.v1; best.v2 = s.v2;
    };
    consider(result.single, 0, 0);
    for (const auto& pair : result.multi) {
      consider(pair.long_period, pair.revolutions, 1);
      consider(pair.short_period, pair.revolutions, 2);
    }
  }
  return best;
}
// O(Ndeparture + Narrival + maxRevs) kernel scratch; the sink owns transport.
template<class Sink>
inline bool search(const std::vector<State>& departure, const std::vector<State>& arrival,
                   const Options& options, Sink&& sink, Cell& best,
                   int& best_row, int& best_column) {
  std::vector<size_t> di, ai;
  best = Cell{}; best_row = best_column = -1;
  if (!std::isfinite(options.mu) || options.mu <= 0 || options.max_revolutions > 32 ||
      (!options.prograde && !options.retrograde) ||
      !axis(departure, options.departure_start, options.departure_end, options.step, di) ||
      !axis(arrival, options.arrival_start, options.arrival_end, options.step, ai)) return false;
  std::vector<Cell> row(ai.size());
  for (size_t i = 0; i < di.size(); ++i) {
    for (size_t j = 0; j < ai.size(); ++j) {
      row[j] = solve_cell(departure[di[i]], arrival[ai[j]], options);
      if (row[j].total_dv < best.total_dv) {
        best = row[j]; best_row = static_cast<int>(i); best_column = static_cast<int>(j);
      }
    }
    if (!sink(i, row)) return false;
  }
  return true;
}
} // namespace lambert_grid
#endif
