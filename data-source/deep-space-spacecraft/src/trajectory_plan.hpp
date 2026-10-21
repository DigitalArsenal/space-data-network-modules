#pragma once
// Pure planning over the Horizons TDB grid; HTTP and SDS remain at the boundary.
#include "notables.hpp"
#include "../../../common/horizons_vectors.hpp"
#include <algorithm>
#include <cstdint>
#include <limits>
#include <string>
#include <vector>

namespace trajectory {
struct Window { int64_t start, stop; std::vector<std::string> labels; };
struct Page { int64_t start, stop, step; size_t rows, group, offset; };
struct Plan {
  int64_t start = 0, stop = 0;
  bool terminal = false;
  std::vector<Window> windows;
  std::vector<Page> pages;
};

// Half-open daily row-index runs, derived from the window plan rather than
// serialized per row. Strict window interiors are omitted; both edges remain.
struct RowRun { size_t first, count; };
inline bool dailyRuns(int64_t start, int64_t stop, const std::vector<Window>& windows,
                      std::vector<RowRun>& runs) {
  runs.clear();
  const int64_t day = horizons::kDay;
  if (stop < start || (stop - start) % day) return false;
  size_t cursor = 0;
  const auto add = [&](size_t first, size_t last) {
    if (!runs.empty() && runs.back().first + runs.back().count == first)
      runs.back().count += last - first + 1;
    else runs.push_back({first, last - first + 1});
  };
  for (const auto& w : windows) {
    if (w.start < start || w.stop <= w.start || w.stop > stop ||
        (w.start - start) % day || (w.stop - start) % day) return false;
    const size_t first = size_t((w.start - start) / day), last = size_t((w.stop - start) / day);
    if (first < cursor) return false;
    add(cursor, first);
    cursor = last;
  }
  add(cursor, size_t((stop - start) / day));
  return true;
}

inline size_t retainedRows(const std::vector<RowRun>& runs, size_t received) {
  size_t count = 0;
  for (const auto& run : runs) {
    if (run.first >= received) break;
    count += std::min(run.count, received - run.first);
  }
  return count;
}

inline int64_t floorDiv(int64_t value, int64_t divisor) {
  const int64_t q = value / divisor, r = value % divisor;
  return q - (r < 0 ? 1 : 0);
}
inline int64_t ceilDiv(int64_t value, int64_t divisor) {
  return -floorDiv(-value, divisor);
}

constexpr int64_t kHalfDay = horizons::kDay / 2;
// Midnight is offset by half a day on the J2000-noon axis.
inline int64_t floorDay(int64_t time) { return floorDiv(time + kHalfDay, horizons::kDay) * horizons::kDay - kHalfDay; }
inline int64_t ceilDay(int64_t time) { return -floorDay(-time); }

inline bool window(const notables::Phase& phase, int64_t now, double lower, double upper,
                   bool hasStart, int64_t limitStart, bool hasStop, int64_t limitStop,
                   size_t pageRows, Plan& plan, std::string& error) {
  plan = Plan{}; error.clear();
  if (!std::isfinite(lower) || !std::isfinite(upper) || lower >= upper ||
      std::abs(lower) > 2.5e11 || std::abs(upper) > 2.5e11) {
    error = "invalid-coverage-range"; return false;
  }
  const int64_t day = horizons::kDay;
  const int64_t lo = ceilDay(int64_t(std::ceil(lower)) + day);
  const int64_t hi = floorDay(int64_t(std::floor(upper)) - day);
  const int64_t span = int64_t(phase.pre_days + phase.post_days) * day;
  plan.start = floorDay(now) - phase.pre_days * day;
  plan.stop = floorDay(now) + phase.post_days * day;
  if (plan.start > hi) { plan.stop = hi; plan.start = hi - span; }
  else if (plan.stop < lo) { plan.start = lo; plan.stop = lo + span; }
  plan.start = std::max(plan.start, lo);
  plan.stop = std::min(plan.stop, hi);
  if (hasStart) plan.start = std::max(plan.start, ceilDay(limitStart));
  if (hasStop) plan.stop = std::min(plan.stop, floorDay(limitStop));
  if (plan.stop <= plan.start) { error = "empty-trajectory-range"; return false; }
  std::vector<horizons::Page> pages;
  if (!horizons::pages(plan.start, plan.stop, phase.step, pageRows, pages, error)) return false;
  for (const auto& p : pages) plan.pages.push_back({p.start, p.stop, p.step, p.rows, 0, p.offset});
  return true;
}

inline bool build(const notables::Notable& craft, double lower, double upper,
                  bool hasStart, int64_t limitStart, bool hasStop, int64_t limitStop,
                  size_t pageRows, Plan& plan, std::string& error) {
  plan = Plan{}; error.clear();
  if (!pageRows || pageRows > horizons::kMaxPageRows) { error = "invalid-page-rows"; return false; }
  if (!std::isfinite(lower) || !std::isfinite(upper) ||
      std::abs(lower) > 2.5e11 || std::abs(upper) > 2.5e11 || lower >= upper) {
    error = "invalid-coverage-range"; return false;
  }
  const int64_t day = horizons::kDay;
  plan.start = int64_t(std::floor(lower)) + 2;
  if (hasStart) plan.start = std::max(plan.start, limitStart);
  int64_t end = int64_t(std::floor(upper)) - 1;
  if (hasStop) end = std::min(end, limitStop);
  if (end < plan.start) { error = "empty-trajectory-range"; return false; }
  plan.stop = plan.start + (end - plan.start) / day * day;

  struct TimedEvent { const notables::Event* event; int64_t time, half; };
  std::vector<TimedEvent> events;
  for (size_t i = 0; i < craft.event_count; ++i) {
    const auto& event = craft.events[i];
    double time;
    if (!horizons::parseCalendar(event.tca_tdb, time) || time != std::floor(time) || event.half_width_h <= 0) {
      error = "invalid-encounter-table"; return false;
    }
    events.push_back({&event, int64_t(time), int64_t(event.half_width_h) * 3600});
  }
  std::stable_sort(events.begin(), events.end(), [](const TimedEvent& a, const TimedEvent& b) { return a.time < b.time; });
  int64_t lastEventTime = std::numeric_limits<int64_t>::max();
  for (const auto& event : events) {
    if (event.event->terminal && event.time - event.half <= plan.stop && event.time + event.half >= plan.start) {
      plan.stop = std::min(plan.stop, plan.start + ceilDiv(event.time + event.half - plan.start, day) * day);
      plan.terminal = true;
      lastEventTime = event.time;
      break;
    }
  }

  std::vector<Window> windows;
  const int64_t departureStop = std::min(plan.start + 2 * day, plan.stop);
  if (departureStop > plan.start) windows.push_back({plan.start, departureStop, {"departure"}});
  for (const auto& event : events) {
    if (event.time > lastEventTime) break;
    if (event.time + event.half < plan.start || event.time - event.half > plan.stop) continue;
    const int64_t start = std::max(plan.start, plan.start + floorDiv(event.time - event.half - plan.start, day) * day);
    const int64_t stop = std::min(plan.stop, plan.start + ceilDiv(event.time + event.half - plan.start, day) * day);
    if (stop > start) windows.push_back({start, stop, {event.event->label}});
  }
  std::stable_sort(windows.begin(), windows.end(), [](const Window& a, const Window& b) { return a.start < b.start; });
  for (const auto& window : windows) {
    if (plan.windows.empty() || window.start > plan.windows.back().stop) plan.windows.push_back(window);
    else {
      auto& merged = plan.windows.back();
      merged.stop = std::max(merged.stop, window.stop);
      merged.labels.insert(merged.labels.end(), window.labels.begin(), window.labels.end());
    }
  }

  const auto addPages = [&](int64_t start, int64_t stop, int64_t step, size_t group) {
    std::vector<horizons::Page> pages;
    if (!horizons::pages(start, stop, step, pageRows, pages, error)) return false;
    for (const auto& page : pages) plan.pages.push_back({page.start, page.stop, page.step, page.rows, group, page.offset});
    return true;
  };
  if (!addPages(plan.start, plan.stop, day, 0)) return false;
  for (size_t i = 0; i < plan.windows.size(); ++i) {
    const auto& window = plan.windows[i];
    if (!addPages(window.start, window.stop, horizons::kWindowStep, i + 1)) return false;
  }
  return true;
}
}  // namespace trajectory
